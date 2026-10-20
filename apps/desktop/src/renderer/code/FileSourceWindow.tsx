import { useCallback, useEffect, useRef, useState } from 'react';
import type { FilePreviewSourceWorkspace } from '@zeus/shared';
import { ProjectSourceWorkspace, type ProjectSourceWorkspaceHandle } from './ProjectSourceWorkspace.js';
import { TaskTableLayoutDecisionDialog } from '../features/workspace/workspaceSupport.js';
import { ApplicationErrorDialogHost } from '../ui/ApplicationErrorDialog.js';
import '../ui/primitives.css';
import '../agentdesk-theme.css';

/** 独立源码窗口完整复用文件树、标签、保存、搜索和磁盘变更处理。 */
export function FileSourceWindow(props: { workspace: FilePreviewSourceWorkspace; language: 'zh-CN' | 'en-US'; appearance: 'light' | 'dark' | 'system' }) {
  /** 共享源码工作区负责所有文档草稿和保存校验。 */
  const workspace = useRef<ProjectSourceWorkspaceHandle | null>(null);
  /** 关闭前的三选一提示复用工作台组件。 */
  const [closing, setClosing] = useState(false);
  /** 保存未完成时禁止重复关闭或放弃。 */
  const [saving, setSaving] = useState(false);
  /** 原始关闭通知与编辑器状态同时处理，避免异步脏状态回执覆盖草稿。 */
  const zh = props.language === 'zh-CN';
  /** 稳定通知回调避免打开关闭提示时短暂清除未保存状态。 */
  const notifyDirty = useCallback((dirty: boolean) => window.zeus?.setUnsavedChangeState('source-workspace', dirty), []);
  useEffect(
    () =>
      window.zeus?.onFilePreviewSourceFileRequested((path) => {
        void workspace.current?.openFile(path, 1);
      }),
    [],
  );
  useEffect(
    () =>
      window.zeus?.onUnsavedChangesCloseRequested(() => {
        if (workspace.current?.hasDirtyFiles()) setClosing(true);
        else window.zeus?.resolveUnsavedChangesCloseRequest(true);
      }),
    [],
  );
  useEffect(() => {
    document.documentElement.dataset.zeusTheme = props.appearance;
    document.title = `${props.workspace.relativePath} · ${zh ? '源码编辑' : 'Source editor'}`;
    return () => window.zeus?.setUnsavedChangeState('source-workspace', false);
  }, [props.appearance, props.workspace.relativePath, zh]);
  /** 保存失败时继续显示工作区中的真实错误并保留草稿。 */
  async function saveAndClose() {
    if (saving) return;
    setSaving(true);
    try {
      if (await workspace.current?.saveAll()) window.zeus?.resolveUnsavedChangesCloseRequest(true);
    } finally {
      setSaving(false);
    }
  }
  /** 取消只撤销本次关闭，不丢弃编辑内容。 */
  function cancelClose() {
    setClosing(false);
    window.zeus?.resolveUnsavedChangesCloseRequest(false);
  }
  return (
    <main className={`macos-ai-app zeus-shell theme-${props.appearance}`} style={{ height: '100vh', display: 'flex', minWidth: 0, overflow: 'hidden' }}>
      <ProjectSourceWorkspace
        ref={workspace}
        project={props.workspace.project}
        language={props.language}
        preference={{ activeFile: props.workspace.relativePath, openFiles: [props.workspace.relativePath], expandedDirectories: [], treeWidth: 240 }}
        onDirtyChange={notifyDirty}
      />
      {closing ? (
        <TaskTableLayoutDecisionDialog
          open
          title={zh ? '代码修改尚未保存' : 'Changes have not been saved'}
          description={zh ? '请保存、放弃修改，或取消关闭。' : 'Save, discard changes, or cancel closing.'}
          busy={saving}
          onCancel={cancelClose}
          actions={[
            { id: 'cancel', label: zh ? '取消' : 'Cancel', onClick: cancelClose },
            {
              id: 'discard',
              label: zh ? '放弃' : 'Discard',
              variant: 'danger',
              onClick: () => {
                workspace.current?.discardAll();
                window.zeus?.resolveUnsavedChangesCloseRequest(true);
              },
            },
            { id: 'save', label: zh ? '保存全部' : 'Save all', variant: 'primary', onClick: () => void saveAndClose() },
          ]}
        />
      ) : null}
      <ApplicationErrorDialogHost language={zh ? 'zh-CN' : 'en'} />
    </main>
  );
}
