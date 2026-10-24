import type { SideQuestionState } from './SideQuestionWorkspace.js';
import { ProjectToolContext } from '../features/workspace/projectToolContext.js';
import { useCallback, useContext, useSyncExternalStore, type SetStateAction } from 'react';
import type { ConversationFileLocation, FilePreviewRequest } from '@zeus/shared';
import type { ConversationResourcePreview, NativeSessionItemBuffer } from './sessionTypes.js';
import type { SourceWorkspaceState, SourceWorkspaceViewMode } from './SourceWorkspace.js';

/** 会话右侧工作区仅在用户打开或关闭内容时改变。 */
export type SessionContextWorkspace =
  | { kind: 'none' }
  | { kind: 'question' }
  | { kind: 'browser' }
  | { kind: 'subagents' }
  | { kind: 'plan'; item: NativeSessionItemBuffer }
  | { kind: 'file'; request: FilePreviewRequest; location?: ConversationFileLocation; commentPath?: string }
  | { kind: 'source'; preview: ConversationResourcePreview; viewMode: SourceWorkspaceViewMode }
  | { kind: 'turn_diff'; turnId: string; initialFileId?: string };

/** 只保留展示状态，不保存组件、焦点或浏览器页面副本。 */
interface SessionContextState {
  /** 当前打开的工作区及其已授权资源。 */
  workspace: SessionContextWorkspace;
  /** 用户选择的全宽模式。 */
  fullWidth: boolean;
  /** 独立于右侧工作区的图片预览入口。 */
  imagePreviewRequest: FilePreviewRequest | null;
  /** 源码标签与当前阅读模式。 */
  sourceState: SourceWorkspaceState | null;
  /** 右侧会话及未发送评论跨面板关闭和会话切换保留。 */
  questionState: SideQuestionState | null;
}

/** 未打开内容的会话共用稳定空快照。 */
const emptyState: SessionContextState = { workspace: { kind: 'none' }, fullWidth: false, imagePreviewRequest: null, sourceState: null, questionState: null };
/** 与终端可见性一致，状态跨组件卸载保留到当前窗口结束。 */
const workspaces = new Map<string, SessionContextState>();
/** 只有正在展示的工作区订阅变化。 */
const listeners = new Set<() => void>();

/** 离开会话只取消订阅，不关闭已打开内容。 */
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 按项目和稳定会话身份恢复工作区，手动关闭后释放对应资源引用。 */
export function useSessionContextWorkspace(projectId: string | undefined, conversationId: string | undefined) {
  /** 用户主动打开会话内容时，让出项目工具占用的右侧区域。 */
  const { revealSessionContext } = useContext(ProjectToolContext);
  /** 临时会话接管为真实会话时沿用同一导航身份。 */
  const key = projectId && conversationId ? JSON.stringify([projectId, conversationId]) : null;
  /** 同一状态始终返回同一快照，避免订阅产生重复渲染。 */
  const getSnapshot = useCallback(() => (key === null ? emptyState : (workspaces.get(key) ?? emptyState)), [key]);
  /** 会话切换在首次渲染时就读取目标状态，避免显示前一个会话的内容。 */
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  /** 更新只作用于回调所属会话，迟到结果不会写入新会话。 */
  const setState = useCallback(
    (update: (current: SessionContextState) => SessionContextState): void => {
      if (key === null) return;
      /** 更新基于最新状态，保留同一轮中的其他界面操作。 */
      const current = workspaces.get(key) ?? emptyState;
      /** 状态不变时无需通知订阅方。 */
      const next = update(current);
      if (next === current) return;
      if (next.workspace.kind === 'none' && !next.imagePreviewRequest && !next.questionState) workspaces.delete(key);
      else workspaces.set(key, next);
      for (const listener of listeners) listener();
    },
    [key],
  );
  /** 关闭工作区同时释放源码标签；切换到浏览器等工作区仍保留文件标签。 */
  const setContextWorkspace = useCallback(
    (update: SetStateAction<SessionContextWorkspace>): void => {
      if (typeof update !== 'function' && update.kind !== 'none') revealSessionContext();
      setState((current) => {
        /** 函数更新接收本会话最新的工作区。 */
        const workspace = typeof update === 'function' ? update(current.workspace) : update;
        return { ...current, workspace, sourceState: workspace.kind === 'none' ? null : current.sourceState };
      });
    },
    [setState, revealSessionContext],
  );
  /** 全宽选择跟随会话，不被导航重置。 */
  const setContextFullWidth = useCallback((update: SetStateAction<boolean>) => setState((current) => ({ ...current, fullWidth: typeof update === 'function' ? update(current.fullWidth) : update })), [setState]);
  /** 图片关闭只改变图片预览，不改变右侧内容。 */
  const setImagePreviewRequest = useCallback((request: FilePreviewRequest | null) => setState((current) => ({ ...current, imagePreviewRequest: request })), [setState]);
  /** 源码组件卸载后保留已打开标签及选择。 */
  const setSourceWorkspaceState = useCallback(
    (update: SetStateAction<SourceWorkspaceState | null>) =>
      setState((current) => {
        /** 恢复已有标签时保持快照不变，避免无效通知。 */
        const sourceState = typeof update === 'function' ? update(current.sourceState) : update;
        return sourceState === current.sourceState ? current : { ...current, sourceState };
      }),
    [setState],
  );
  /** 评论草稿和已创建会话只更新所属主会话。 */
  const setSideQuestionState = useCallback((update: SetStateAction<SideQuestionState | null>) => setState((current) => ({ ...current, questionState: typeof update === 'function' ? update(current.questionState) : update })), [setState]);
  return {
    sideQuestionState: state.questionState,
    setSideQuestionState,
    contextWorkspace: state.workspace,
    setContextWorkspace,
    contextFullWidth: state.fullWidth,
    setContextFullWidth,
    imagePreviewRequest: state.imagePreviewRequest,
    setImagePreviewRequest,
    sourceWorkspaceState: state.sourceState,
    setSourceWorkspaceState,
  };
}
