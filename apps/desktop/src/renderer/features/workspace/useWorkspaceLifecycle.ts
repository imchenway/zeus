import { useEffect } from 'react';
import { isDurableNativeConversationAcceptance } from '../../session/SessionWorkspace.js';
import { clearPendingConflictAiStart, listPendingConflictAiStarts } from '../../task/TaskGitMergeModal.js';
import { ZeusApiError } from '../../apiClient.js';
import { errorToLocalUiMessage, redactLocalUiErrorMessage } from './WorkspaceChrome.js';
import { completeNativeConversationChoiceTaskLoad, executionHostSupportsConversationSource, failNativeConversationChoiceTaskLoad, isDefinitiveNativeConversationStartRejection, PROJECT_WORKSPACE_ENTRIES } from './workspaceSupport.js';
import type { WorkspaceQueryState } from './useWorkspaceQueryState.js';
import type { WorkspaceDomainActions } from './useWorkspaceDomainActions.js';
import type { WorkspaceOperations } from './useWorkspaceOperations.js';

export function useWorkspaceLifecycle(state: WorkspaceQueryState, domainActions: WorkspaceDomainActions, operations: WorkspaceOperations): void {
  const {
    activeNavTarget,
    activeProjectId,
    activeProjectIdRef,
    archivedConversationLoadState,
    codexConfigImportLoading,
    codexConfigImportPreview,
    codexLegacyImportLoading,
    codexLegacyImportSnapshot,
    graphProjectId,
    latestConversationContentVisible,
    nativeConversationChoiceLoadCoordinator,
    nativeConversationStartEnvelopeManager,
    props,
    recoveringConflictAiStartsRef,
    recoveringNativeConversationStartsRef,
    selectedNativeConversation,
    selectedProject,
    setConversationDraftOpen,
    setNativeConversationChoiceTaskStates,
    setNativeConversationChoicesByTask,
    setSelectedNativeConversationId,
    setTaskConversationDrawerTarget,
    setTaskDetail,
    setZeusWindowForeground,
    settingsCategory,
    snapshot,
    sourceWorkspaceDirty,
    taskConversationDrawerReady,
    taskConversationDrawerTarget,
    taskTableLayoutDirty,
    zeusWindowForeground,
  } = state;
  const { acknowledgeNativeConversationAttention, openTaskConflictAiConversation, recordLocalError, refreshArchivedConversations, resetGraphWorkspace } = domainActions;
  const { openProjectSection, refreshCodexConfigImport, refreshCodexLegacyImports, requestWorkspaceLeave } = operations;
  useEffect(() => {
    if (activeNavTarget !== 'settings' || settingsCategory !== 'runtime' || codexLegacyImportSnapshot || codexLegacyImportLoading || !props.onLoadCodexLegacyImports) return;
    void refreshCodexLegacyImports();
  }, [activeNavTarget, codexLegacyImportLoading, codexLegacyImportSnapshot, props.onLoadCodexLegacyImports, settingsCategory]);

  useEffect(() => {
    if (activeNavTarget !== 'settings' || settingsCategory !== 'runtime' || codexConfigImportPreview || codexConfigImportLoading || !props.onInspectCodexConfigImport) return;
    void refreshCodexConfigImport();
  }, [activeNavTarget, codexConfigImportLoading, codexConfigImportPreview, props.onInspectCodexConfigImport, settingsCategory]);
  useEffect(() => {
    if (activeNavTarget !== 'settings' || settingsCategory !== 'data' || archivedConversationLoadState !== 'idle' || !props.nativeConversationClient) return;
    void refreshArchivedConversations();
  }, [activeNavTarget, archivedConversationLoadState, props.nativeConversationClient, settingsCategory]);
  useEffect(() => {
    const bridge = window.zeus;
    const subscribe = bridge?.onUnsavedChangesCloseRequested ?? bridge?.onTaskTableLayoutCloseRequested;
    const resolve = bridge?.resolveUnsavedChangesCloseRequest ?? bridge?.resolveTaskTableLayoutCloseRequest;
    if (!subscribe || !resolve) return;
    return subscribe(() => {
      if (!taskTableLayoutDirty && !sourceWorkspaceDirty) {
        resolve(true);
        return;
      }
      requestWorkspaceLeave(
        () => resolve(true),
        () => resolve(false),
      );
    });
  }, [sourceWorkspaceDirty, taskTableLayoutDirty]);
  useEffect(() => {
    const client = props.nativeConversationClient;
    if (!client || !executionHostSupportsConversationSource(props.executionHostTransition, 'code_review')) return;
    let disposed = false;
    for (const task of snapshot.tasks) {
      const request = nativeConversationStartEnvelopeManager.pending({ id: task.id, projectId: task.projectId });
      if (!request || request.mode !== 'create' || request.source !== 'code_review' || recoveringNativeConversationStartsRef.current.has(request.idempotencyKey)) continue;
      recoveringNativeConversationStartsRef.current.add(request.idempotencyKey);
      let startAccepted = false;
      void client
        .startNativeConversation(task.id, request)
        .then(async ({ acceptance, operationIdentity }) => {
          if (!isDurableNativeConversationAcceptance(request, acceptance, operationIdentity)) throw new Error('代码审查会话尚未获得持久接受结果。');
          startAccepted = true;
          nativeConversationStartEnvelopeManager.clearPending(
            {
              id: task.id,
              projectId: task.projectId,
            },
            request,
            acceptance,
            operationIdentity,
          );
          const choice = await client.loadNativeConversationChoice(task.projectId, acceptance.conversation.id);
          if (disposed) return;
          nativeConversationChoiceLoadCoordinator.preserveAccepted(choice);
          setNativeConversationChoicesByTask((current) => {
            const prior = current[task.id];
            const choices = [choice, ...(prior?.choices ?? []).filter((candidate) => candidate.id !== choice.id)];
            return { ...current, [task.id]: { taskId: task.id, projectId: task.projectId, hasHistory: true, requiresChoice: choices.length > 1, choices, items: choices } };
          });
          setNativeConversationChoiceTaskStates((current) => ({ ...current, [task.id]: completeNativeConversationChoiceTaskLoad(current[task.id]) }));
          if (activeProjectIdRef.current === task.projectId) {
            setSelectedNativeConversationId(choice.id);
            setConversationDraftOpen(false);
            setTaskDetail(task);
          }
        })
        .catch((error) => {
          if (!startAccepted && isDefinitiveNativeConversationStartRejection(error)) {
            nativeConversationStartEnvelopeManager.discardPending({ id: task.id, projectId: task.projectId }, request);
            if (disposed) return;
            setNativeConversationChoiceTaskStates((current) => ({ ...current, [task.id]: completeNativeConversationChoiceTaskLoad(current[task.id]) }));
            return;
          }
          if (disposed) return;
          const message = redactLocalUiErrorMessage(errorToLocalUiMessage(error));
          setNativeConversationChoiceTaskStates((current) => ({ ...current, [task.id]: failNativeConversationChoiceTaskLoad(current[task.id], message) }));
          recordLocalError('native-code-review-recovery', error);
        })
        .finally(() => recoveringNativeConversationStartsRef.current.delete(request.idempotencyKey));
    }
    return () => {
      disposed = true;
    };
  }, [nativeConversationChoiceLoadCoordinator, nativeConversationStartEnvelopeManager, props.executionHostTransition, props.nativeConversationClient, snapshot.tasks]);
  useEffect(() => {
    const client = props.nativeConversationClient;
    if (!client || !executionHostSupportsConversationSource(props.executionHostTransition, 'conflict_resolution')) return;
    let disposed = false;
    for (const pending of listPendingConflictAiStarts()) {
      if (recoveringConflictAiStartsRef.current.has(pending.idempotencyKey)) continue;
      const task = snapshot.tasks.find((candidate) => candidate.id === pending.taskId && candidate.projectId === pending.projectId);
      if (!task) {
        clearPendingConflictAiStart(pending.idempotencyKey);
        continue;
      }
      recoveringConflictAiStartsRef.current.add(pending.idempotencyKey);
      void client
        .startTaskIntegrationConflictAi(pending.taskId, pending.integrationId, pending.path, pending.content, pending.fingerprint, pending.permissionMode, pending.idempotencyKey)
        .then(async (operation) => {
          clearPendingConflictAiStart(pending.idempotencyKey);
          if (disposed) return;
          await openTaskConflictAiConversation(pending.taskId, operation.conversationId);
        })
        .catch((error) => {
          if (error instanceof ZeusApiError && error.status >= 400 && error.status < 500) clearPendingConflictAiStart(pending.idempotencyKey);
          if (disposed) return;
          const message = redactLocalUiErrorMessage(errorToLocalUiMessage(error));
          setNativeConversationChoiceTaskStates((current) => ({ ...current, [pending.taskId]: failNativeConversationChoiceTaskLoad(current[pending.taskId], message) }));
          recordLocalError('native-conflict-ai-recovery', error);
        })
        .finally(() => recoveringConflictAiStartsRef.current.delete(pending.idempotencyKey));
    }
    return () => {
      disposed = true;
    };
  }, [props.executionHostTransition, props.nativeConversationClient, snapshot.tasks]);
  useEffect(() => {
    if (graphProjectId === activeProjectId) return;
    // 当前项目变化时必须先清空旧图谱工作区，避免 A 项目的真实图谱继续挂在 B 项目的代码页里。
    resetGraphWorkspace(activeProjectId);
  }, [activeProjectId, graphProjectId]);
  useEffect(() => {
    if (!taskConversationDrawerTarget || taskConversationDrawerTarget.status !== 'opening' || taskConversationDrawerReady) return;
    const target = taskConversationDrawerTarget;
    const frame = window.requestAnimationFrame(() => {
      recordLocalError('task-conversation-drawer-open', new Error(`Task conversation ${target.conversationId} did not resolve to navigation identity ${target.navigationId}.`));
      setTaskConversationDrawerTarget((current) =>
        current?.taskId === target.taskId && current.navigationId === target.navigationId
          ? {
              ...current,
              status: 'error',
            }
          : current,
      );
    });
    return () => window.cancelAnimationFrame(frame);
  }, [taskConversationDrawerReady, taskConversationDrawerTarget]);
  useEffect(() => {
    function onProjectWorkspaceShortcut(event: globalThis.KeyboardEvent): void {
      if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.repeat) return;
      const entry = PROJECT_WORKSPACE_ENTRIES.find((candidate) => candidate.shortcutKey === event.key);
      if (!entry || activeNavTarget === 'settings' || !selectedProject || document.querySelector('[aria-modal="true"]')) return;
      event.preventDefault();
      openProjectSection(selectedProject, entry.section, entry.codeMode);
    }
    window.addEventListener('keydown', onProjectWorkspaceShortcut);
    return () => window.removeEventListener('keydown', onProjectWorkspaceShortcut);
  }, [activeNavTarget, selectedProject]);
  useEffect(() => {
    const bridge = window.zeus;
    if (bridge?.getRequestingWindowForeground && bridge.onRequestingWindowForegroundChanged) {
      let active = true;
      const dispose = bridge.onRequestingWindowForegroundChanged((foreground) => {
        if (active) setZeusWindowForeground(foreground);
      });
      void bridge
        .getRequestingWindowForeground()
        .then(({ foreground }) => {
          if (active) setZeusWindowForeground(foreground);
        })
        .catch((error: unknown) => recordLocalError('requesting-window-foreground', error));
      return () => {
        active = false;
        dispose();
      };
    }
    const synchronizeForeground = () => setZeusWindowForeground(document.visibilityState === 'visible' && document.hasFocus());
    window.addEventListener('focus', synchronizeForeground);
    window.addEventListener('blur', synchronizeForeground);
    document.addEventListener('visibilitychange', synchronizeForeground);
    return () => {
      window.removeEventListener('focus', synchronizeForeground);
      window.removeEventListener('blur', synchronizeForeground);
      document.removeEventListener('visibilitychange', synchronizeForeground);
    };
  }, []);

  useEffect(() => {
    if (!selectedNativeConversation?.hasUnreadAttention || selectedNativeConversation.taskPushCreating || !zeusWindowForeground || !latestConversationContentVisible) return;
    acknowledgeNativeConversationAttention(selectedNativeConversation.projectId, selectedNativeConversation.id, selectedNativeConversation.attentionRevision);
  }, [acknowledgeNativeConversationAttention, latestConversationContentVisible, selectedNativeConversation, zeusWindowForeground]);
}
