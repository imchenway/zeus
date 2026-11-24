import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { DashboardClient } from '../dashboardClient.js';
import type { TaskWorkDecisionRecord, TaskWorkDeliverableRecord } from '../features/digital-employees/digitalEmployeeContracts.js';
import { DecisionDialog, WorkItemBoard } from '../features/digital-employees/TaskDigitalEmployeePanel.js';
import { TaskDeliverableContent, TaskDeliverableReader } from '../features/digital-employees/TaskDeliverableReader.js';
import type { TaskStageDeliverableRecord } from '../features/tasks/taskContracts.js';
import type { WorkspacePageProps } from '../features/workspace/workspaceContracts.js';
import { Button } from '../ui/Button.js';
import { ModalPortal } from '../ui/ModalPortal.js';
import { ResourceLoading } from '../ui/ResourceLoading.js';
import { formatVisibleApplicationError, VisibleApplicationError } from '../ui/ApplicationErrorDialog.js';

/** 来源独立刷新。读取失败保留上次成功结果，也不接受过期请求的结果。 */
function useTaskDetailSource<T>(read: () => Promise<T>, revision: string) {
  /** 只有最后一次读取可更新当前来源。 */
  const generation = useRef(0);
  /** 空结果是一次成功读取，错误与正在重试可以同时存在。 */
  const [state, setState] = useState<{ data?: T; loading: boolean; failure?: { error: unknown } }>({ loading: true });
  /** 启动读取时保留已显示的内容与重试入口。 */
  const reload = useCallback(async () => {
    const request = ++generation.current;
    setState((current) => ({ ...current, loading: true }));
    try {
      const data = await read();
      if (request === generation.current) setState({ data, loading: false });
    } catch (error) {
      if (request === generation.current) setState((current) => ({ ...current, loading: false, failure: { error } }));
    }
  }, [read]);

  useEffect(() => {
    void reload();
    return () => {
      generation.current += 1;
    };
  }, [reload, revision]);
  return [state, reload] as const;
}

/** 独立工作与正式成果共用同一任务快照，阶段成果独立读取。 */
export function TaskDetailDeliverables(props: {
  taskId: string;
  client: DashboardClient;
  language: 'zh-CN' | 'en-US';
  revision: string;
  /** 终态只保留阅读，服务端继续按当前修订判断是否接纳操作。 */
  readOnly: boolean;
  subscribe?: WorkspacePageProps['onSubscribeRealtimeEvents'];
  onOpenConversation(conversationId: string): Promise<boolean>;
}) {
  const { client, taskId, language, revision, subscribe } = props;
  /** 正式成果和独立工作待办来自同一次读取。 */
  const readWork = useCallback(() => client.loadTaskWorkManagement(taskId), [client, taskId]);
  /** 阶段成果使用自己的读取和重试状态。 */
  const readStages = useCallback(async () => (await client.loadTaskWorkflow(taskId))?.stages.flatMap((stage) => stage.deliverables) ?? [], [client, taskId]);
  const [work, reloadWork] = useTaskDetailSource(readWork, revision);
  const [stageDeliverables, reloadStages] = useTaskDetailSource(readStages, revision);
  /** 固定打开时选中的修订，后台刷新不切换正在阅读的文件。 */
  const [selected, setSelected] = useState<{ kind: 'formal'; item: TaskWorkDeliverableRecord } | { kind: 'stage'; item: TaskStageDeliverableRecord } | null>(null);
  /** 决策弹窗按待办身份保留，刷新失败时不丢弃用户意见。 */
  const [decision, setDecision] = useState<TaskWorkDecisionRecord | null>(null);
  /** 同一工作区一次提交一个操作，引用在下一次渲染前拦住重复点击。 */
  const submitting = useRef(false);
  const [busy, setBusy] = useState<string | null>(null);
  /** 写入和列表读取分别反馈失败，写入失败后只重新读取当前状态。 */
  const [operationError, setOperationError] = useState<string | null>(null);
  const zh = language === 'zh-CN';
  /** 错误组件使用应用语言的短英文标识。 */
  const errorLanguage = zh ? 'zh-CN' : 'en';

  useEffect(() => {
    /** 恢复连接后补读离线期间的结果，初次挂载由读取副作用负责。 */
    let disconnected = false;
    return subscribe?.(
      (event) => {
        if (event.payload.taskId !== taskId) return;
        if (event.type === 'task.work_management.changed' || event.type === 'task.git_delivery.changed') void reloadWork();
        if (event.type === 'task.workflow.changed') void reloadStages();
      },
      (connection) => {
        if (connection === 'connected' && disconnected) {
          void reloadWork();
          void reloadStages();
        }
        disconnected = connection !== 'connected';
      },
    );
  }, [subscribe, taskId, reloadWork, reloadStages]);

  /** 团队节点和阶段分工在各自流程处理，独立工作支持手动与自动化来源。 */
  const independent = new Map(
    work.data?.workItems.filter((item) => !item.arrangement?.stageId && !item.arrangement?.parentWorkItemId && !(item.source === 'manual' && item.sourceRef?.startsWith('digital-team:'))).map((item) => [item.id, item]),
  );
  /** 只使用当前运行的待办，旧运行和成果修订保留阅读。 */
  const pending = work.data?.managerDecisions.filter((entry) => entry.status === 'pending' && entry.runId && independent.get(entry.workItemId)?.currentRunId === entry.runId) ?? [];
  const recovery = pending.filter((entry) => entry.kind === 'outcome_unknown' || entry.kind === 'command_failure');
  const failed = [...independent.values()].filter((item) => item.status === 'failed' || item.status === 'blocked');
  const currentDecision = decision ? pending.find((entry) => entry.id === decision.id) : undefined;
  const review = selected?.kind === 'formal' ? pending.find((entry) => entry.kind === 'deliverable_acceptance' && entry.deliverableId === selected.item.id) : undefined;
  const readOnly = props.readOnly || Boolean(work.failure);
  const formal = work.data?.deliverables ?? [];
  const stages = stageDeliverables.data ?? [];
  /** 已读取的列表在后台刷新期间保持可阅读。 */
  const loading = (work.loading && !work.data && !work.failure) || (stageDeliverables.loading && !stageDeliverables.data && !stageDeliverables.failure);

  /** 切换待办时清除上一个操作的反馈。 */
  function openDecision(next: TaskWorkDecisionRecord | null): void {
    if (next && submitting.current) return;
    setOperationError(null);
    setDecision(next);
  }

  /** 导航失败或用户取消离开时保留当前核对待办。 */
  async function openOutcomeConversation(conversationId: string): Promise<void> {
    if (submitting.current) return;
    submitting.current = true;
    setBusy('decision');
    setOperationError(null);
    try {
      if (await props.onOpenConversation(conversationId)) openDecision(null);
    } catch (error) {
      setOperationError(formatVisibleApplicationError(error, errorLanguage));
    } finally {
      submitting.current = false;
      setBusy(null);
    }
  }

  /** 写操作复用带修订的命令；完成后读取真实状态，失败时保留原弹窗。 */
  async function act(key: string, operation: () => Promise<unknown>): Promise<void> {
    if (submitting.current || readOnly) return;
    submitting.current = true;
    setBusy(key);
    setOperationError(null);
    try {
      await operation();
      if (key === 'decision') setDecision(null);
    } catch (error) {
      setOperationError(formatVisibleApplicationError(error, errorLanguage));
    } finally {
      await reloadWork();
      submitting.current = false;
      setBusy(null);
    }
  }

  return (
    <>
      {failed.length ? (
        <div className="task-detail-block task-work-cockpit">
          <WorkItemBoard
            items={failed}
            recoveryDecisions={recovery}
            language={language}
            readOnly={readOnly}
            busy={busy}
            onOpenDecision={openDecision}
            onRetry={(item, createWorkspace) => act(`retry:${item.id}`, () => client.retryTaskWorkItem(taskId, item, createWorkspace))}
          />
          {operationError && !decision ? (
            <p className="task-inline-edit-feedback is-error" role="alert">
              <VisibleApplicationError error={operationError} language={errorLanguage} />
            </p>
          ) : null}
        </div>
      ) : null}
      {formal.length || stages.length || loading || work.failure || stageDeliverables.failure ? (
        <section className="task-detail-block" aria-label={zh ? '交付物' : 'Deliverables'}>
          <h2 className="task-detail-section-heading">{zh ? '交付物' : 'Deliverables'}</h2>
          {loading ? <ResourceLoading label={zh ? '正在读取交付物…' : 'Loading deliverables…'} /> : null}
          {[
            { state: work, reload: reloadWork, label: zh ? '正式成果读取失败' : 'Could not load formal deliverables' },
            { state: stageDeliverables, reload: reloadStages, label: zh ? '阶段交付物读取失败' : 'Could not load stage deliverables' },
          ].map(({ state, reload, label }) =>
            state.failure ? (
              <div className="task-inline-edit-feedback is-error" key={label}>
                <span role="alert">
                  {label} · <VisibleApplicationError error={state.failure.error} language={errorLanguage} />
                </span>
                <Button variant="secondary" size="compact" busy={state.loading} onClick={reload}>
                  {zh ? '重试' : 'Retry'}
                </Button>
              </div>
            ) : null,
          )}
          {formal.length || stages.length ? (
            <ul className="task-detail-linked-list">
              {formal.map((item) => (
                <li key={item.id}>
                  <Button unstyled type="button" className="task-detail-linked-task" onClick={() => setSelected({ kind: 'formal', item })}>
                    <span>{item.title}</span>
                    <small>
                      {zh ? '修订' : 'Revision'} {item.version}
                    </small>
                  </Button>
                </li>
              ))}
              {stages.map((item) => (
                <li key={item.id}>
                  <Button unstyled type="button" className="task-detail-linked-task" onClick={() => setSelected({ kind: 'stage', item })}>
                    <span>{item.title}</span>
                    <small>
                      {zh ? '修订' : 'Revision'} {item.version}
                    </small>
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
      {selected?.kind === 'formal' ? (
        <TaskDeliverableReader
          taskId={taskId}
          client={client}
          deliverable={selected.item}
          revisions={formal}
          language={language}
          onClose={() => setSelected(null)}
          onReview={review && !readOnly && !busy ? () => openDecision(review) : undefined}
        />
      ) : selected?.kind === 'stage' ? (
        <StageDeliverableReader key={selected.item.id} taskId={props.taskId} client={props.client} item={selected.item} language={props.language} onClose={() => setSelected(null)} />
      ) : null}
      {decision ? (
        <DecisionDialog
          key={decision.id}
          decision={currentDecision ?? decision}
          projection={work.data ?? null}
          client={client}
          taskId={taskId}
          language={language}
          busy={busy === 'decision'}
          readOnly={props.readOnly}
          actionsDisabled={!currentDecision || readOnly}
          operationError={
            operationError ??
            (work.failure ? formatVisibleApplicationError(work.failure.error, errorLanguage) : !currentDecision ? (zh ? '待办已变化，请关闭后查看当前工作。' : 'This item has changed. Close this dialog to view the current work.') : null)
          }
          onDismiss={() => openDecision(null)}
          onOpenConversation={openOutcomeConversation}
          onAccept={(deliverable) => act('decision', () => client.acceptTaskWorkDeliverable(taskId, deliverable))}
          onRequestChanges={(deliverable, reason, createWorkspace) => act('decision', () => client.requestTaskWorkDeliverableChanges(taskId, deliverable, reason, createWorkspace))}
          onRespond={(response) => act('decision', () => client.resolveTaskWorkDecision(taskId, currentDecision ?? decision, response))}
        />
      ) : null}
    </>
  );
}

/** 阶段交付物使用与正式成果相同的阅读、源码和查找组件。 */
function StageDeliverableReader(props: { taskId: string; client: DashboardClient; item: TaskStageDeliverableRecord; language: 'zh-CN' | 'en-US'; onClose(): void }) {
  /** 阅读弹窗标题绑定当前固定修订。 */
  const titleId = useId();
  const zh = props.language === 'zh-CN';
  /** 正文读取与重试在当前修订内进行。 */
  const [result, setResult] = useState<{ content?: string; error?: unknown }>({});
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setResult({});
    void props.client
      .loadTaskStageDeliverableContent(props.taskId, props.item.id)
      .then(({ deliverable, content }) => {
        if (deliverable.id !== props.item.id || deliverable.version !== props.item.version || deliverable.contentSha256 !== props.item.contentSha256) {
          throw new Error(zh ? '交付物修订已变化，请重新打开。' : 'The deliverable revision changed. Reopen it.');
        }
        if (active) setResult({ content });
      })
      .catch((error: unknown) => {
        if (active) setResult({ error });
      });
    return () => {
      active = false;
    };
  }, [props.taskId, props.client, props.item, retry, zh]);

  return (
    <ModalPortal rootClassName="task-deliverable-reader-root" backdropClassName="task-work-decision-backdrop" onDismiss={props.onClose} role="dialog" aria-labelledby={titleId}>
      <section className="task-deliverable-reader zeus-solid-form-surface" data-modal-surface="dialog">
        <header>
          <strong id={titleId}>{props.item.title}</strong>
          <Button variant="secondary" size="compact" onClick={props.onClose}>
            {zh ? '关闭' : 'Close'}
          </Button>
        </header>
        <div className="task-deliverable-reader-body">
          {result.content !== undefined ? (
            <TaskDeliverableContent id={props.item.id} title={props.item.title} content={result.content} language={props.language} />
          ) : result.error ? (
            <div role="alert">
              <VisibleApplicationError error={result.error} language={zh ? 'zh-CN' : 'en'} />
              <Button variant="secondary" size="compact" onClick={() => setRetry((value) => value + 1)}>
                {zh ? '重新读取' : 'Try again'}
              </Button>
            </div>
          ) : (
            <ResourceLoading label={zh ? '正在读取正文…' : 'Loading content…'} />
          )}
        </div>
      </section>
    </ModalPortal>
  );
}
