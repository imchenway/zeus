import { MotionPresence } from '../ui/MotionPresence.js';
import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import type { DashboardClient, ProjectRecord, TaskRecord } from '../apiClient.js';
import type { NativeConversationChoice } from '../session/sessionTypes.js';
import '../styles.css';
import '../ui/primitives.css';
import { TaskGitMergeModal } from './TaskGitMergeModal.js';
import { RepositoryGitDeliveryContent } from '../git/RepositoryGitDeliveryContent.js';
import { ConversationGitDeliveryContent } from '../session/ConversationGitDeliveryContent.js';
import { useGitDeliveryWindowFrame } from '../git/gitDeliveryPerformance.js';
import { GitDeliveryCommandRunContext } from '../git/GitDeliveryProgress.js';

/** 只有从交付步骤打开执行记录时才加载命令页。 */
const ProjectCommandDialog = lazy(() => import('../CommandCenterPanel.js').then((module) => ({ default: module.ProjectCommandDialog })));

/** 当前主会话仅为已有任务窗口提供定位提示，不改变窗口固定的交付范围。 */
export interface TaskGitDeliveryCurrentContext {
  taskId: string | null;
  workspaceId: string | null;
  /** 原生窗口是否已经收到正式打开请求。 */
  opened?: boolean;
}

/** 同一窗口按真实任务、会话、项目或仓库加载交付内容，不创建替代身份。 */
export type GitDeliveryWindowScope =
  | { kind: 'task'; task: TaskRecord; project: ProjectRecord | null }
  | { kind: 'project'; project: ProjectRecord }
  | { kind: 'conversation'; project: ProjectRecord; conversation: NativeConversationChoice }
  | { kind: 'repository'; project: ProjectRecord; repositoryId: string; pathPrefix?: string };

/** 所有代码交付入口共用原生窗口的页面、主题、布局及关闭行为。 */
export function TaskGitDeliveryWindow(props: { client: DashboardClient; scope: GitDeliveryWindowScope; language: 'zh-CN' | 'en-US'; appearance: 'light' | 'dark' | 'system'; initialCurrentContext: TaskGitDeliveryCurrentContext }) {
  /** 执行记录属于窗口固定的项目，无需切换主工作台。 */
  const [commandRunId, setCommandRunId] = useState<string | null>(null);
  const project = props.scope.project;
  /** 项目目录筛选只影响文件清单，清除后展示该仓库全部文件。 */
  const [pathPrefix, setPathPrefix] = useState(props.scope.kind === 'repository' ? props.scope.pathPrefix : undefined);
  /** 任务窗口跟随主窗口会话定位，普通会话固定为自身绑定范围。 */
  const [currentContext, setCurrentContext] = useState(props.initialCurrentContext);
  useGitDeliveryWindowFrame(currentContext.opened !== false, 'surface');
  /** 主题与语言继续通过现有原生窗口广播更新。 */
  const [surfaceSettings, setSurfaceSettings] = useState<{ language: 'zh-CN' | 'en-US'; appearance: 'light' | 'dark' | 'system' }>({ language: props.language, appearance: props.appearance });
  /** 普通目录走本机项目桥接，独立会话工作树走已有会话限定接口。 */
  const scopedClient = useMemo(
    () => (props.scope.kind === 'conversation' && props.scope.conversation.workspaceMode !== 'direct' ? { ...props.client, ...props.client.forConversationGit(props.scope.conversation.id) } : props.client),
    [props.client, props.scope],
  );
  /** 系统标题使用当前固定交付对象。 */
  const scopeTitle = props.scope.kind === 'task' ? (props.scope.task.taskCode ?? props.scope.task.id) : props.scope.kind === 'conversation' ? props.scope.conversation.title : props.scope.project.name;

  useEffect(() => {
    /** 任务和会话交付都等待正式打开；订阅后补读可能错过的打开状态。 */
    let needsContext = (props.scope.kind === 'task' || props.scope.kind === 'conversation') && props.initialCurrentContext.opened === false;
    /** 同一条广播更新会话范围和正式打开状态，避免用旧范围加载文件。 */
    const unsubscribe = window.zeus?.onTaskGitDeliveryCurrentContext?.((context) => {
      needsContext = false;
      setCurrentContext(context);
    });
    if (needsContext) {
      void window.zeus
        ?.getTaskGitDeliveryCurrentContext?.()
        .then((context) => {
          if (needsContext) setCurrentContext(context);
        })
        .catch(() => undefined);
    }
    return () => {
      needsContext = false;
      unsubscribe?.();
    };
  }, [props.scope.kind, props.initialCurrentContext.opened]);
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
      <GitDeliveryCommandRunContext.Provider
        value={
          project
            ? (run) => {
                if (run.projectId === project.id) setCommandRunId(run.id);
              }
            : null
        }
      >
        <MotionPresence>
          {props.scope.kind === 'task' ? (
            <TaskGitMergeModal
              open={currentContext.opened !== false}
              language={surfaceSettings.language}
              task={props.scope.task}
              projectName={project?.name}
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
          ) : props.scope.kind === 'repository' || props.scope.kind === 'project' ? (
            <RepositoryGitDeliveryContent
              client={scopedClient}
              project={props.scope.project}
              repositoryId={props.scope.kind === 'repository' ? props.scope.repositoryId : undefined}
              pathPrefix={pathPrefix}
              onClearPathPrefix={() => setPathPrefix(undefined)}
              language={surfaceSettings.language}
              onClose={() => void window.zeus?.closeTaskGitDeliveryWindow?.()}
            />
          ) : currentContext.opened !== false ? (
            <ConversationGitDeliveryContent client={scopedClient} project={props.scope.project} conversation={props.scope.conversation} language={surfaceSettings.language} onClose={() => void window.zeus?.closeTaskGitDeliveryWindow?.()} />
          ) : null}
        </MotionPresence>
      </GitDeliveryCommandRunContext.Provider>
      <MotionPresence>
        {commandRunId && project ? (
          <Suspense fallback={null}>
            <ProjectCommandDialog key={commandRunId} project={project} client={props.client} language={surfaceSettings.language} initialRunId={commandRunId} onClose={() => setCommandRunId(null)} />
          </Suspense>
        ) : null}
      </MotionPresence>
    </main>
  );
}
