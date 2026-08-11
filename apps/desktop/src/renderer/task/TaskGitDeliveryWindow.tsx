import { useEffect, useState } from 'react';
import type { DashboardClient, TaskRecord } from '../apiClient.js';
import '../styles.css';
import { TaskGitMergeModal } from './TaskGitMergeModal.js';

export interface TaskGitDeliveryCurrentContext {
  taskId: string | null;
  workspaceId: string | null;
}

export function TaskGitDeliveryWindow(props: { client: DashboardClient; task: TaskRecord; projectName?: string; language: 'zh-CN' | 'en-US'; appearance: 'light' | 'dark' | 'system'; initialCurrentContext: TaskGitDeliveryCurrentContext }) {
  const [currentContext, setCurrentContext] = useState(props.initialCurrentContext);
  const [surfaceSettings, setSurfaceSettings] = useState<{ language: 'zh-CN' | 'en-US'; appearance: 'light' | 'dark' | 'system' }>({ language: props.language, appearance: props.appearance });

  useEffect(() => window.zeus?.onTaskGitDeliveryCurrentContext?.(setCurrentContext), []);
  useEffect(() => window.zeus?.onTaskGitDeliveryAppearance?.(setSurfaceSettings), []);
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.zeusTheme = surfaceSettings.appearance;
    document.title = `${surfaceSettings.language === 'zh-CN' ? '代码交付' : 'Code Delivery'} · ${props.task.taskCode ?? props.task.id}`;
    return () => {
      if (root.dataset.zeusTheme === surfaceSettings.appearance) delete root.dataset.zeusTheme;
    };
  }, [props.task.id, props.task.taskCode, surfaceSettings.appearance, surfaceSettings.language]);

  const currentConversationWorkspaceId = currentContext.taskId === props.task.id ? currentContext.workspaceId : null;
  return (
    <main className={`task-git-delivery-window-root macos-ai-app zeus-shell theme-${surfaceSettings.appearance}`}>
      <TaskGitMergeModal
        open
        language={surfaceSettings.language}
        task={props.task}
        projectName={props.projectName}
        currentConversationWorkspaceId={currentConversationWorkspaceId}
        client={props.client}
        onChanged={() => window.zeus?.notifyTaskGitDeliveryChanged?.(props.task.id)}
        onOpenConversation={async (taskId, conversationId) => {
          await window.zeus?.openTaskGitDeliveryConversation?.({ taskId, conversationId });
        }}
        onClose={() => void window.zeus?.closeTaskGitDeliveryWindow?.()}
      />
    </main>
  );
}
