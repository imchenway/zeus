import { MotionPresence } from '../ui/MotionPresence.js';
import { useEffect, useMemo, useState } from 'react';
import type { DashboardClient, ProjectRecord, TaskRecord } from '../apiClient.js';
import type { NativeConversationChoice } from '../session/sessionTypes.js';
import '../styles.css';
import '../ui/primitives.css';
import { TaskGitMergeModal } from './TaskGitMergeModal.js';
import { ConversationGitDeliveryContent } from '../session/ConversationGitDeliveryContent.js';

/** 当前主会话仅为已有任务窗口提供定位提示，不改变窗口固定的交付范围。 */
export interface TaskGitDeliveryCurrentContext {
  taskId: string | null;
  workspaceId: string | null;
}

/** 同一窗口加载真实任务或真实会话，不创建替代任务。 */
export type GitDeliveryWindowScope = { kind: 'task'; task: TaskRecord; projectName?: string } | { kind: 'conversation'; project: ProjectRecord; conversation: NativeConversationChoice };

/** 所有代码交付入口共用原生窗口的页面、主题、布局及关闭行为。 */
export function TaskGitDeliveryWindow(props: { client: DashboardClient; scope: GitDeliveryWindowScope; language: 'zh-CN' | 'en-US'; appearance: 'light' | 'dark' | 'system'; initialCurrentContext: TaskGitDeliveryCurrentContext }) {
  /** 任务窗口跟随主窗口会话定位，普通会话固定为自身绑定范围。 */
  const [currentContext, setCurrentContext] = useState(props.initialCurrentContext);
  /** 主题与语言继续通过现有原生窗口广播更新。 */
  const [surfaceSettings, setSurfaceSettings] = useState<{ language: 'zh-CN' | 'en-US'; appearance: 'light' | 'dark' | 'system' }>({ language: props.language, appearance: props.appearance });
  /** 普通目录走本机项目桥接，独立会话工作树走已有会话限定接口。 */
  const scopedClient = useMemo(
    () => (props.scope.kind === 'conversation' && props.scope.conversation.workspaceMode !== 'direct' ? { ...props.client, ...props.client.forConversationGit(props.scope.conversation.id) } : props.client),
    [props.client, props.scope],
  );
  /** 系统标题使用当前固定交付对象。 */
  const scopeTitle = props.scope.kind === 'task' ? (props.scope.task.taskCode ?? props.scope.task.id) : props.scope.conversation.title;

  useEffect(() => window.zeus?.onTaskGitDeliveryCurrentContext?.(setCurrentContext), []);
  useEffect(() => window.zeus?.onTaskGitDeliveryAppearance?.(setSurfaceSettings), []);
  useEffect(() => {
    /** 原生系统窗口与页面使用同一外观，不另建内嵌弹窗。 */
    const root = document.documentElement;
    root.dataset.zeusTheme = surfaceSettings.appearance;
    document.title = `${surfaceSettings.language === 'zh-CN' ? '代码交付' : 'Code Delivery'} · ${scopeTitle}`;
    return () => {
      if (root.dataset.zeusTheme === surfaceSettings.appearance) delete root.dataset.zeusTheme;
    };
  }, [scopeTitle, surfaceSettings.appearance, surfaceSettings.language]);

  /** 仅向同任务交付页传递真实会话工作区。 */
  const currentConversationWorkspaceId = props.scope.kind === 'task' && currentContext.taskId === props.scope.task.id ? currentContext.workspaceId : null;
  return (
    <main className={`task-git-delivery-window-root macos-ai-app zeus-shell theme-${surfaceSettings.appearance}`}>
      <MotionPresence>
        {props.scope.kind === 'task' ? (
          <TaskGitMergeModal
            open
            language={surfaceSettings.language}
            task={props.scope.task}
            projectName={props.scope.projectName}
            currentConversationWorkspaceId={currentConversationWorkspaceId}
            client={props.client}
            onChanged={() => {
              if (props.scope.kind === 'task') window.zeus?.notifyTaskGitDeliveryChanged?.(props.scope.task.id);
            }}
            onOpenConversation={async (taskId, conversationId) => {
              await window.zeus?.openTaskGitDeliveryConversation?.({ taskId, conversationId });
            }}
            onClose={() => void window.zeus?.closeTaskGitDeliveryWindow?.()}
          />
        ) : (
          <ConversationGitDeliveryContent client={scopedClient} project={props.scope.project} conversation={props.scope.conversation} language={surfaceSettings.language} onClose={() => void window.zeus?.closeTaskGitDeliveryWindow?.()} />
        )}
      </MotionPresence>
    </main>
  );
}
