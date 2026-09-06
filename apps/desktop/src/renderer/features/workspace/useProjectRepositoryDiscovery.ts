import { useCallback, useEffect, useRef } from 'react';
import { normalizeTaskModelPushCapabilities, reconcileTaskPushRepositories } from '../../task/TaskModelPushModal.js';
import { errorToLocalUiMessage, redactLocalUiErrorMessage } from './WorkspaceChrome.js';
import type { WorkspaceQueryState } from './useWorkspaceQueryState.js';

/** 项目进入触发后台发现，推送弹窗只在事件或连接恢复后补读仓库快照。 */
export function useProjectRepositoryDiscovery(state: WorkspaceQueryState) {
  /** 只依赖稳定项目身份，普通表单编辑不重新发起扫描。 */
  const { activeProjectId, selectedProject, props, taskModelPushTaskId, taskModelPushCapabilities, taskModelPushCapabilityRequestRef, snapshot, setTaskModelPushCapabilities, setTaskModelPushForm, setTaskModelPushError } = state;
  /** 项目服务和能力查询由当前受信客户端提供。 */
  const client = props.nativeConversationClient;
  /** 首次没有项目时保持空路径；实际项目路径变化才发现新目录。 */
  const projectPath = selectedProject?.id === activeProjectId ? selectedProject?.localPath : undefined;
  /** 区分重新进入项目和同项目的重复渲染。 */
  const enteredProject = useRef('');
  /** 推送可能来自非当前项目任务，以任务真实归属作为查询范围。 */
  const pushProjectId = snapshot.tasks.find((task) => task.id === taskModelPushTaskId)?.projectId;
  /** 首次能力加载完成后补读，避免旧的首屏响应覆盖后台发现结果。 */
  const capabilitiesReady = Boolean(taskModelPushCapabilities);
  /** 显式刷新完成后复用当前弹窗的合并读取入口。 */
  const reload = useRef<() => void>(() => undefined);

  useEffect(() => {
    if (!activeProjectId || !client || !projectPath) {
      enteredProject.current = '';
      return;
    }
    /** 真实项目路径就绪后才触发，避免先空路径再回填时重复扫描。 */
    const identity = `${activeProjectId}:${projectPath}`;
    if (enteredProject.current === identity) return;
    enteredProject.current = identity;
    void client.projects.refreshProjectRepositories(activeProjectId).catch((error: unknown) => {
      console.warn('项目后台仓库发现请求未完成，可在推送弹窗重试。', redactLocalUiErrorMessage(errorToLocalUiMessage(error)));
    });
  }, [activeProjectId, client, projectPath]);

  useEffect(() => {
    if (!client || !pushProjectId || !taskModelPushTaskId || !capabilitiesReady) return;
    /** 关闭或切换任务后禁止旧响应回填。 */
    let disposed = false;
    /** 同一弹窗只保持一个在途读取；期间的通知合并为后续补读。 */
    let loading = false;
    /** 在途读取期间到达的新通知需要再补读一次。 */
    let pending = false;
    /** 仓库查询按顺序完成，防止较旧响应覆盖较新选择。 */
    const read = async (): Promise<void> => {
      if (disposed) return;
      if (loading) {
        pending = true;
        return;
      }
      loading = true;
      try {
        /** 原始能力必须属于当前任务，仓库之外的表单保持原样。 */
        const capabilities = normalizeTaskModelPushCapabilities(await client.loadCodexTaskPushCapabilities(pushProjectId, taskModelPushTaskId));
        if (disposed) return;
        setTaskModelPushCapabilities((current) =>
          current?.taskId === taskModelPushTaskId
            ? {
                ...current,
                repositories: capabilities.repositories,
                repositoryRevision: capabilities.repositoryRevision,
                repositoryDiscovery: capabilities.repositoryDiscovery,
                git: capabilities.git,
                existingEnvironments: capabilities.existingEnvironments,
              }
            : current,
        );
        setTaskModelPushForm((current) => reconcileTaskPushRepositories(current, capabilities));
      } catch (error) {
        if (!disposed) setTaskModelPushError(redactLocalUiErrorMessage(errorToLocalUiMessage(error)));
      } finally {
        loading = false;
        if (pending && !disposed) {
          pending = false;
          void read();
        }
      }
    };
    reload.current = () => void read();
    void read();
    /** 共用现有连接的订阅，断线恢复也重新读取发现状态。 */
    const unsubscribe = props.onSubscribeRealtimeEvents?.(
      (event) => {
        if (event.type === 'project.repositories.changed' && event.payload.projectId === pushProjectId) void read();
      },
      (connection) => {
        if (connection === 'connected') void read();
      },
    );
    return () => {
      disposed = true;
      reload.current = () => undefined;
      unsubscribe?.();
    };
  }, [capabilitiesReady, client, props.onSubscribeRealtimeEvents, pushProjectId, taskModelPushTaskId, setTaskModelPushCapabilities, setTaskModelPushForm, setTaskModelPushError]);

  /** 用户主动刷新与自动发现共用同一后端命令，读取不承担隐式扫描。 */
  return useCallback(async (): Promise<void> => {
    if (!client || !pushProjectId) return;
    /** 关闭或切换弹窗后，不把上一任务的刷新错误写到新任务。 */
    const requestVersion = taskModelPushCapabilityRequestRef.current;
    try {
      await client.projects.refreshProjectRepositories(pushProjectId);
      if (taskModelPushCapabilityRequestRef.current === requestVersion) reload.current();
    } catch (error) {
      if (taskModelPushCapabilityRequestRef.current === requestVersion) setTaskModelPushError(redactLocalUiErrorMessage(errorToLocalUiMessage(error)));
    }
  }, [client, pushProjectId, setTaskModelPushError, taskModelPushCapabilityRequestRef]);
}
