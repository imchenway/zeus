import { parseZentaoTaskSyncLink, type TaskPriority, type ZentaoRemoteItemDetail, type ZentaoRemoteItemSummary, type ZentaoRemoteKind, type ZentaoTaskSyncLink } from '@zeus/shared';
import { useEffect, useId, useMemo, useState } from 'react';
import type { DashboardClient } from '../dashboardClient.js';
import type { CreateTaskRequest, TaskRecord, UpdateTaskRequest } from '../apiClient.js';
import { Button } from '../ui/Button.js';
import { ModalPortal } from '../ui/ModalPortal.js';
import type { ZentaoRemoteExecutionSummary, ZentaoRemoteProductSummary, ZentaoRemoteProjectSummary, ZentaoTaskSyncResult } from '../features/integrations/integrationContracts.js';

const pageSize = 24;

export interface ZentaoImportModalProps {
  open: boolean;
  language: 'zh-CN' | 'en-US';
  client?: DashboardClient;
  projectId?: string;
  projectName?: string;
  existingTasks: TaskRecord[];
  onImported: (task: TaskRecord) => void;
  onClose: () => void;
}

export interface ZentaoPushModalProps {
  open: boolean;
  language: 'zh-CN' | 'en-US';
  client?: DashboardClient;
  task: TaskRecord;
  onUpdated: (task: TaskRecord) => void;
  onClose: () => void;
}

/** 从禅道列表导入只修改 Zeus；最后一步仍需用户明确确认。 */
export function ZentaoImportModal(props: ZentaoImportModalProps) {
  const zh = props.language === 'zh-CN';
  const titleId = useId();
  const descriptionId = useId();
  const [instances, setInstances] = useState<Awaited<ReturnType<DashboardClient['loadZentaoInstances']>>>([]);
  const [instanceId, setInstanceId] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [items, setItems] = useState<ZentaoRemoteItemSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [selected, setSelected] = useState<Record<string, ZentaoRemoteItemSummary>>({});
  const [confirming, setConfirming] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resultMessage, setResultMessage] = useState<string | null>(null);
  const client = props.client;

  const importedKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const task of props.existingTasks) {
      if (task.projectId !== props.projectId) continue;
      const link = readTaskZentaoLink(task);
      if (link) keys.add(syncKey(link.instanceId, link.kind, link.objectId));
    }
    return keys;
  }, [props.existingTasks, props.projectId]);
  const existingTaskByKey = useMemo(() => {
    const result = new Map<string, TaskRecord>();
    for (const task of props.existingTasks) {
      if (task.projectId !== props.projectId) continue;
      const link = readTaskZentaoLink(task);
      if (link) result.set(syncKey(link.instanceId, link.kind, link.objectId), task);
    }
    return result;
  }, [props.existingTasks, props.projectId]);
  const selectedItems = useMemo(() => Object.values(selected), [selected]);
  const groupedItems = useMemo(
    () => ({
      task: items.filter((item) => item.kind === 'task'),
      bug: items.filter((item) => item.kind === 'bug'),
    }),
    [items],
  );

  useEffect(() => {
    if (!props.open || !client) return;
    let cancelled = false;
    setError(null);
    setResultMessage(null);
    setConfirming(false);
    setSelected({});
    setPage(0);
    void client
      .loadZentaoInstances()
      .then((loaded) => {
        if (cancelled) return;
        setInstances(loaded);
        setInstanceId((current) => (current && loaded.some((item) => item.id === current) ? current : (loaded[0]?.id ?? '')));
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(readError(reason, zh ? '禅道实例读取失败。' : 'Unable to load ZenTao instances.'));
      });
    return () => {
      cancelled = true;
    };
  }, [client, props.open, zh]);

  useEffect(() => {
    if (!props.open || !client || !instanceId) {
      setItems([]);
      setTotal(0);
      setHasMore(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void client
      .loadZentaoMyItems(instanceId, { query, offset: page * pageSize, limit: pageSize })
      .then((loaded) => {
        if (cancelled) return;
        setItems(loaded.items);
        setTotal(loaded.total);
        setHasMore(loaded.hasMore);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(readError(reason, zh ? '禅道列表读取失败。' : 'Unable to load ZenTao items.'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, instanceId, page, props.open, query, zh]);

  function toggleItem(item: ZentaoRemoteItemSummary): void {
    const key = syncKey(instanceId, item.kind, item.objectId);
    setSelected((current) => {
      if (current[key]) {
        const next = { ...current };
        delete next[key];
        return next;
      }
      return { ...current, [key]: item };
    });
  }

  function renderItem(item: ZentaoRemoteItemSummary) {
    const itemKey = syncKey(instanceId, item.kind, item.objectId);
    const alreadyImported = importedKeys.has(itemKey);
    return (
      <label className={`zentao-sync-item${alreadyImported ? ' is-imported' : ''}`} key={itemKey}>
        <input type="checkbox" checked={Boolean(selected[itemKey])} onChange={() => toggleItem(item)} />
        <span className="zentao-sync-item-main">
          <strong>{item.title}</strong>
          <small>
            {item.kind === 'bug' ? (zh ? '缺陷' : 'Bug') : zh ? '任务' : 'Task'} #{item.objectId} · {item.status} · {item.priority}
          </small>
        </span>
        {alreadyImported ? <span className="zentao-sync-item-state">{zh ? '已关联 · 可更新' : 'Linked · updateable'}</span> : null}
      </label>
    );
  }

  async function importSelected(): Promise<void> {
    if (!client || !props.projectId || selectedItems.length === 0) return;
    setBusy(true);
    setError(null);
    const results = await Promise.allSettled(
      selectedItems.map(async (item) => {
        const detail = await client.loadZentaoItem(instanceId, item.kind, item.objectId);
        const existingTask = existingTaskByKey.get(syncKey(instanceId, item.kind, item.objectId));
        const task = existingTask ? await client.updateTask(existingTask.id, updateTaskFromZentaoDetail(existingTask, detail, instanceId)) : await client.createTask(createTaskFromZentaoDetail(props.projectId!, instanceId, detail));
        props.onImported(task);
        return task;
      }),
    );
    const importedCount = results.filter((result): result is PromiseFulfilledResult<TaskRecord> => result.status === 'fulfilled').length;
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    setBusy(false);
    setSelected({});
    setConfirming(false);
    setResultMessage(zh ? `已处理 ${importedCount} 条${failures.length ? `，${failures.length} 条失败` : ''}。` : `Processed ${importedCount}${failures.length ? `, ${failures.length} failed` : ''}.`);
    if (failures.length > 0) setError(readError(failures[0].reason, zh ? '部分禅道对象导入失败。' : 'Some ZenTao items could not be imported.'));
  }

  if (!props.open) return null;
  return (
    <ModalPortal rootClassName="zentao-sync-modal-portal" dismissDisabled={busy} onDismiss={props.onClose}>
      <section className="zentao-sync-modal zeus-solid-form-surface" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId}>
        <header className="zentao-sync-modal-header">
          <div>
            <strong id={titleId}>{zh ? '从禅道导入' : 'Import from ZenTao'}</strong>
            <p id={descriptionId}>{zh ? `读取当前禅道账号负责的任务和缺陷，确认后导入到${props.projectName ?? '当前项目'}。` : `Read tasks and bugs assigned to the current ZenTao account, then confirm before importing into ${props.projectName ?? 'the current project'}.`}</p>
          </div>
          <Button className="zentao-sync-modal-close" aria-label={zh ? '关闭' : 'Close'} onClick={props.onClose} disabled={busy}>
            ×
          </Button>
        </header>
        {confirming ? (
          <ConfirmImportView zh={zh} items={selectedItems} projectName={props.projectName} busy={busy} onBack={() => setConfirming(false)} onConfirm={() => void importSelected()} />
        ) : (
          <>
            <div className="zentao-sync-modal-body">
              <div className="zentao-sync-toolbar zentao-sync-import-toolbar">
                <SelectField
                  label={zh ? '禅道实例' : 'Instance'}
                  value={instanceId}
                  onChange={(value) => {
                    setInstanceId(value);
                    setPage(0);
                    setSelected({});
                  }}
                  options={instances.map((item) => ({ value: item.id, label: `${item.host}${item.basePath}` }))}
                  disabled={loading || instances.length === 0}
                />
              </div>
              <div className="zentao-sync-toolbar zentao-sync-import-toolbar">
                <label className="zentao-sync-field">
                  <span>{zh ? '搜索我的任务/缺陷' : 'Search my tasks/bugs'}</span>
                  <input
                    type="search"
                    value={query}
                    onChange={(event) => {
                      setQuery(event.currentTarget.value);
                      setPage(0);
                    }}
                    placeholder={zh ? '编号或标题' : 'ID or title'}
                  />
                </label>
              </div>
              {resultMessage ? (
                <p className="zentao-sync-success" role="status">
                  {resultMessage}
                </p>
              ) : null}
              {error ? (
                <p className="zentao-sync-error" role="alert">
                  {error}
                </p>
              ) : null}
              {!instances.length && !loading ? <p className="zentao-sync-empty">{zh ? '请先在设置 → 禅道中配置实例。' : 'Configure a ZenTao instance in Settings → ZenTao first.'}</p> : null}
              {loading ? (
                <p className="zentao-sync-loading" role="status">
                  {zh ? '正在读取禅道…' : 'Loading ZenTao…'}
                </p>
              ) : null}
              {!loading && instanceId ? (
                <div className="zentao-sync-groups" aria-label={zh ? '禅道任务和缺陷列表' : 'ZenTao tasks and bugs'}>
                  {(['task', 'bug'] as const).map((groupKind) => {
                    const groupItems = groupedItems[groupKind];
                    return (
                      <section className="zentao-sync-group" key={groupKind} aria-labelledby={`${titleId}-${groupKind}`}>
                        <h3 id={`${titleId}-${groupKind}`}>{groupKind === 'task' ? (zh ? '任务' : 'Tasks') : zh ? '缺陷' : 'Bugs'}</h3>
                        {groupItems.length > 0 ? (
                          <div className="zentao-sync-list" role="list">
                            {groupItems.map(renderItem)}
                          </div>
                        ) : (
                          <p className="zentao-sync-group-empty">{groupKind === 'task' ? (zh ? '暂无我的任务。' : 'No tasks assigned to this account.') : zh ? '暂无我的缺陷。' : 'No bugs assigned to this account.'}</p>
                        )}
                      </section>
                    );
                  })}
                </div>
              ) : null}
              <div className="zentao-sync-pagination">
                <span>{zh ? `共 ${total} 条` : `${total} total`}</span>
                <span>
                  <Button size="compact" disabled={page === 0 || loading} onClick={() => setPage((current) => Math.max(0, current - 1))}>
                    {zh ? '上一页' : 'Previous'}
                  </Button>
                  <Button size="compact" disabled={!hasMore || loading} onClick={() => setPage((current) => current + 1)}>
                    {zh ? '下一页' : 'Next'}
                  </Button>
                </span>
              </div>
            </div>
            <footer className="zentao-sync-modal-footer">
              <span>
                {zh ? `已选择 ${selectedItems.length} 条` : `${selectedItems.length} selected`}
                {props.projectName ? ` · ${props.projectName}` : ''}
              </span>
              <span>
                <Button onClick={props.onClose} disabled={busy}>
                  {zh ? '取消' : 'Cancel'}
                </Button>
                <Button variant="primary" disabled={selectedItems.length === 0 || !props.projectId || busy} onClick={() => setConfirming(true)}>
                  {zh ? '确认导入' : 'Review import'}
                </Button>
              </span>
            </footer>
          </>
        )}
      </section>
    </ModalPortal>
  );
}

/** 当前任务推送到禅道：创建与更新都先展示目标和远端写入计划。 */
export function ZentaoPushModal(props: ZentaoPushModalProps) {
  const zh = props.language === 'zh-CN';
  const titleId = useId();
  const descriptionId = useId();
  const linked = useMemo(() => readTaskZentaoLink(props.task), [props.task]);
  const [instances, setInstances] = useState<Awaited<ReturnType<DashboardClient['loadZentaoInstances']>>>([]);
  const [instanceId, setInstanceId] = useState(linked?.instanceId ?? '');
  const [projects, setProjects] = useState<ZentaoRemoteProjectSummary[]>([]);
  const [projectId, setProjectId] = useState(linked?.projectId ?? '');
  const [executions, setExecutions] = useState<ZentaoRemoteExecutionSummary[]>([]);
  const [executionId, setExecutionId] = useState(linked?.executionId ?? '');
  const [products, setProducts] = useState<ZentaoRemoteProductSummary[]>([]);
  const [productId, setProductId] = useState(linked?.productId ?? '');
  const [kind, setKind] = useState<ZentaoRemoteKind>(linked?.kind ?? (props.task.taskType === 'defect' ? 'bug' : 'task'));
  const [estStarted, setEstStarted] = useState(todayDate());
  const [deadline, setDeadline] = useState(tomorrowDate());
  const [confirming, setConfirming] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ZentaoTaskSyncResult | null>(null);
  const client = props.client;
  const linkedForInstance = linked && linked.instanceId === instanceId ? linked : null;
  const isUpdate = Boolean(linked && linked.instanceId === instanceId && linked.kind === kind);

  useEffect(() => {
    if (!props.open || !client) return;
    const initialLink = readTaskZentaoLink(props.task);
    setConfirming(false);
    setResult(null);
    setError(null);
    setKind(initialLink?.kind ?? (props.task.taskType === 'defect' ? 'bug' : 'task'));
    setInstanceId(initialLink?.instanceId ?? '');
    setProjectId(initialLink?.projectId ?? '');
    setExecutionId(initialLink?.executionId ?? '');
    setProductId(initialLink?.productId ?? '');
    setEstStarted(todayDate());
    setDeadline(tomorrowDate());
    void client
      .loadZentaoInstances()
      .then((loaded) => {
        setInstances(loaded);
        setInstanceId((current) => (current && loaded.some((item) => item.id === current) ? current : (loaded[0]?.id ?? '')));
      })
      .catch((reason: unknown) => setError(readError(reason, zh ? '禅道实例读取失败。' : 'Unable to load ZenTao instances.')));
  }, [client, props.open, props.task.taskType, props.task.id, zh]);

  useEffect(() => {
    if (!props.open || !client || !instanceId) {
      setProjects([]);
      setProducts([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void Promise.all([client.loadZentaoProjects(instanceId), client.loadZentaoProducts(instanceId)])
      .then(([loadedProjects, loadedProducts]) => {
        if (cancelled) return;
        setProjects(loadedProjects);
        setProducts(loadedProducts);
        setProjectId((current) => current || linkedForInstance?.projectId || loadedProjects[0]?.id || '');
        setProductId((current) => current || linkedForInstance?.productId || loadedProducts[0]?.id || '');
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(readError(reason, zh ? '禅道目标空间读取失败。' : 'Unable to load ZenTao destinations.'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, instanceId, linkedForInstance?.productId, linkedForInstance?.projectId, props.open, zh]);

  useEffect(() => {
    if (!props.open || !client || !instanceId || !projectId) {
      setExecutions([]);
      return;
    }
    let cancelled = false;
    void client
      .loadZentaoExecutions(instanceId, projectId)
      .then((loaded) => {
        if (cancelled) return;
        setExecutions(loaded);
        setExecutionId((current) => current || linkedForInstance?.executionId || loaded[0]?.id || '');
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(readError(reason, zh ? '禅道执行读取失败。' : 'Unable to load ZenTao executions.'));
      });
    return () => {
      cancelled = true;
    };
  }, [client, instanceId, linkedForInstance?.executionId, projectId, props.open, zh]);

  async function syncTask(): Promise<void> {
    if (!client || !instanceId || !projectId || !props.task.updatedAt) return;
    setBusy(true);
    setError(null);
    try {
      const next = await client.syncTaskToZentao(instanceId, {
        taskId: props.task.id,
        expectedUpdatedAt: props.task.updatedAt,
        kind,
        projectId,
        executionId: kind === 'task' ? executionId : executionId || undefined,
        productId: kind === 'bug' ? productId : undefined,
        estStarted: kind === 'task' ? estStarted : undefined,
        deadline: kind === 'task' ? deadline : undefined,
        remoteType: kind === 'task' ? 'devel' : 'codeerror',
      });
      setResult(next);
      setConfirming(false);
      props.onUpdated(next.task);
    } catch (reason) {
      setError(readError(reason, zh ? '同步到禅道失败。' : 'Unable to sync to ZenTao.'));
    } finally {
      setBusy(false);
    }
  }

  if (!props.open) return null;
  const targetProject = projects.find((item) => item.id === projectId);
  const targetExecution = executions.find((item) => item.id === executionId);
  const targetProduct = products.find((item) => item.id === productId);
  const ready = Boolean(instanceId && projectId && (kind === 'task' ? executionId : productId));
  return (
    <ModalPortal rootClassName="zentao-sync-modal-portal" dismissDisabled={busy} onDismiss={props.onClose}>
      <section className="zentao-sync-modal zeus-solid-form-surface" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId}>
        <header className="zentao-sync-modal-header">
          <div>
            <strong id={titleId}>{zh ? '同步到禅道' : 'Sync to ZenTao'}</strong>
            <p id={descriptionId}>
              {zh
                ? `为“${props.task.title}”选择远端目标。${isUpdate ? '当前操作将更新已有禅道对象。' : '当前操作将创建新的禅道对象。'}`
                : `Choose a ZenTao destination for “${props.task.title}”. ${isUpdate ? 'This will update the linked object.' : 'This will create a new object.'}`}
            </p>
          </div>
          <Button className="zentao-sync-modal-close" aria-label={zh ? '关闭' : 'Close'} onClick={props.onClose} disabled={busy}>
            ×
          </Button>
        </header>
        {confirming ? (
          <section className="zentao-sync-confirm zentao-sync-modal-body">
            <h3>{zh ? '确认远端写入' : 'Confirm remote write'}</h3>
            <p>{zh ? `将${isUpdate ? '更新' : '创建'}禅道${kind === 'bug' ? '缺陷' : '任务'}：${props.task.title}` : `${isUpdate ? 'Update' : 'Create'} a ZenTao ${kind === 'bug' ? 'bug' : 'task'}: ${props.task.title}`}</p>
            <dl className="zentao-sync-plan">
              <div>
                <dt>{zh ? '实例' : 'Instance'}</dt>
                <dd>{instances.find((item) => item.id === instanceId)?.host ?? instanceId}</dd>
              </div>
              <div>
                <dt>{zh ? '项目' : 'Project'}</dt>
                <dd>{targetProject?.name ?? projectId}</dd>
              </div>
              {kind === 'task' ? (
                <div>
                  <dt>{zh ? '执行' : 'Execution'}</dt>
                  <dd>{targetExecution?.name ?? executionId}</dd>
                </div>
              ) : (
                <div>
                  <dt>{zh ? '产品' : 'Product'}</dt>
                  <dd>{targetProduct?.name ?? productId}</dd>
                </div>
              )}
            </dl>
            <p className="zentao-sync-warning">{zh ? '这一步会真实修改禅道数据，只在你确认后执行。' : 'This action changes data in ZenTao and runs only after confirmation.'}</p>
            {error ? (
              <p className="zentao-sync-error" role="alert">
                {error}
              </p>
            ) : null}
            {result ? (
              <p className="zentao-sync-success" role="status">
                {zh ? `已${result.mode === 'created' ? '创建' : '更新'}禅道对象 #${result.remote.objectId}。` : `${result.mode === 'created' ? 'Created' : 'Updated'} ZenTao object #${result.remote.objectId}.`}
              </p>
            ) : null}
            <footer className="zentao-sync-modal-footer">
              <Button onClick={() => setConfirming(false)} disabled={busy}>
                {zh ? '返回修改' : 'Back'}
              </Button>
              <Button variant="primary" busy={busy} onClick={() => void syncTask()}>
                {zh ? '确认并写入禅道' : 'Confirm and write'}
              </Button>
            </footer>
          </section>
        ) : (
          <>
            <div className="zentao-sync-modal-body">
              <div className="zentao-sync-task-preview">
                <strong>{props.task.title}</strong>
                <span>
                  {props.task.taskCode ?? props.task.id} · {props.task.taskType === 'defect' ? (zh ? '缺陷' : 'Defect') : zh ? '需求' : 'Requirement'}
                </span>
              </div>
              <div className="zentao-sync-toolbar">
                <SelectField
                  label={zh ? '禅道实例' : 'Instance'}
                  value={instanceId}
                  onChange={(value) => {
                    setInstanceId(value);
                    setProjectId('');
                    setExecutionId('');
                    setProductId('');
                  }}
                  options={instances.map((item) => ({ value: item.id, label: `${item.host}${item.basePath}` }))}
                  disabled={loading || instances.length === 0}
                />
                <SelectField
                  label={zh ? '远端类型' : 'Remote type'}
                  value={kind}
                  onChange={(value) => setKind(value as ZentaoRemoteKind)}
                  options={[
                    { value: 'task', label: zh ? '任务' : 'Task' },
                    { value: 'bug', label: zh ? '缺陷' : 'Bug' },
                  ]}
                  disabled={!instanceId || loading}
                />
              </div>
              <div className="zentao-sync-toolbar">
                <SelectField
                  label={zh ? '项目' : 'Project'}
                  value={projectId}
                  onChange={(value) => {
                    setProjectId(value);
                    setExecutionId('');
                  }}
                  options={projects.map((item) => ({ value: item.id, label: item.name }))}
                  disabled={!instanceId || loading}
                />
                {kind === 'task' ? (
                  <SelectField label={zh ? '执行' : 'Execution'} value={executionId} onChange={setExecutionId} options={executions.map((item) => ({ value: item.id, label: item.name }))} disabled={!projectId || loading} />
                ) : (
                  <SelectField label={zh ? '产品' : 'Product'} value={productId} onChange={setProductId} options={products.map((item) => ({ value: item.id, label: item.name }))} disabled={!instanceId || loading} />
                )}
              </div>
              {kind === 'task' && !isUpdate ? (
                <div className="zentao-sync-toolbar">
                  <label className="zentao-sync-field">
                    <span>{zh ? '预计开始' : 'Start date'}</span>
                    <input type="date" value={estStarted} onChange={(event) => setEstStarted(event.currentTarget.value)} />
                  </label>
                  <label className="zentao-sync-field">
                    <span>{zh ? '截止日期' : 'Deadline'}</span>
                    <input type="date" value={deadline} onChange={(event) => setDeadline(event.currentTarget.value)} />
                  </label>
                </div>
              ) : null}
              {error ? (
                <p className="zentao-sync-error" role="alert">
                  {error}
                </p>
              ) : null}
              {result ? (
                <p className="zentao-sync-success" role="status">
                  {zh ? `最近一次已${result.mode === 'created' ? '创建' : '更新'}禅道对象 #${result.remote.objectId}。` : `Last action ${result.mode === 'created' ? 'created' : 'updated'} object #${result.remote.objectId}.`}
                </p>
              ) : null}
              {!instances.length && !loading ? <p className="zentao-sync-empty">{zh ? '请先在设置 → 禅道中配置实例。' : 'Configure a ZenTao instance in Settings → ZenTao first.'}</p> : null}
              <p className="zentao-sync-help">
                {isUpdate
                  ? zh
                    ? '此任务已保存禅道关联，确认后会更新同一个远端对象。'
                    : 'This task is linked to ZenTao and will update the same object after confirmation.'
                  : zh
                    ? '未发现同类型关联，确认后会在所选目标中创建新对象。'
                    : 'No matching link was found; confirmation will create a new object in the selected destination.'}
              </p>
            </div>
            <footer className="zentao-sync-modal-footer">
              <Button onClick={props.onClose} disabled={busy}>
                {zh ? '取消' : 'Cancel'}
              </Button>
              <Button variant="primary" disabled={!ready || busy || !props.task.updatedAt} onClick={() => setConfirming(true)}>
                {zh ? `审核并${isUpdate ? '更新' : '创建'}` : `Review and ${isUpdate ? 'update' : 'create'}`}
              </Button>
            </footer>
          </>
        )}
      </section>
    </ModalPortal>
  );
}

function ConfirmImportView(props: { zh: boolean; items: ZentaoRemoteItemSummary[]; projectName?: string; busy: boolean; onBack: () => void; onConfirm: () => void }) {
  return (
    <section className="zentao-sync-confirm zentao-sync-modal-body">
      <h3>{props.zh ? '确认导入清单' : 'Review import'}</h3>
      <p>
        {props.zh
          ? `以下 ${props.items.length} 条会写入 Zeus 项目“${props.projectName ?? '当前项目'}”；已关联对象会更新，本次不会修改禅道。`
          : `${props.items.length} items will be written to Zeus project “${props.projectName ?? 'current project'}”; linked items will update, and ZenTao will not be changed.`}
      </p>
      <div className="zentao-sync-selected-list">
        {props.items.map((item) => (
          <span key={item.objectId}>
            {item.kind === 'bug' ? 'Bug' : 'Task'} #{item.objectId} · {item.title}
          </span>
        ))}
      </div>
      <footer className="zentao-sync-modal-footer">
        <Button onClick={props.onBack} disabled={props.busy}>
          {props.zh ? '返回选择' : 'Back'}
        </Button>
        <Button variant="primary" busy={props.busy} onClick={props.onConfirm}>
          {props.zh ? `确认处理 ${props.items.length} 条` : `Confirm ${props.items.length}`}
        </Button>
      </footer>
    </section>
  );
}

function SelectField(props: { label: string; value: string; onChange: (value: string) => void; options: Array<{ value: string; label: string }>; disabled?: boolean }) {
  return (
    <label className="zentao-sync-field">
      <span>{props.label}</span>
      <select value={props.value} disabled={props.disabled} onChange={(event) => props.onChange(event.currentTarget.value)}>
        <option value="">—</option>
        {props.options.map((option) => (
          <option value={option.value} key={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function createTaskFromZentaoDetail(projectId: string, instanceId: string, detail: ZentaoRemoteItemDetail): CreateTaskRequest {
  const link: ZentaoTaskSyncLink = {
    instanceId,
    kind: detail.kind,
    objectId: detail.objectId,
    sourceUrl: detail.sourceUrl,
    projectId: detail.projectId,
    executionId: detail.executionId,
    productId: detail.productId,
    remoteTitle: detail.title,
    remoteUpdatedAt: detail.updatedAt,
    lastSyncedAt: new Date().toISOString(),
  };
  return {
    idempotencyKey: `zentao-import-${instanceId}-${detail.kind}-${detail.objectId}`,
    projectId,
    title: detail.title,
    taskType: detail.kind === 'bug' ? 'defect' : 'requirement',
    description: detail.description,
    defectCurrentState: detail.kind === 'bug' ? detail.currentState : undefined,
    defectReproductionSteps: detail.kind === 'bug' ? detail.reproductionSteps : undefined,
    defectExpectedOutcome: detail.kind === 'bug' ? detail.expectedOutcome : undefined,
    sourceContext: { type: 'zentao', sourceUrl: detail.sourceUrl, zentao: link },
    tags: ['zentao'],
    priority: toLocalPriority(detail.priority),
  };
}

function updateTaskFromZentaoDetail(task: TaskRecord, detail: ZentaoRemoteItemDetail, instanceId: string): UpdateTaskRequest {
  const link: ZentaoTaskSyncLink = {
    instanceId,
    kind: detail.kind,
    objectId: detail.objectId,
    sourceUrl: detail.sourceUrl,
    projectId: detail.projectId,
    executionId: detail.executionId,
    productId: detail.productId,
    remoteTitle: detail.title,
    remoteUpdatedAt: detail.updatedAt,
    lastSyncedAt: new Date().toISOString(),
  };
  return {
    expectedUpdatedAt: task.updatedAt ?? '',
    title: detail.title,
    taskType: detail.kind === 'bug' ? 'defect' : 'requirement',
    description: detail.description,
    defectCurrentState: detail.kind === 'bug' ? detail.currentState : '',
    defectReproductionSteps: detail.kind === 'bug' ? detail.reproductionSteps : '',
    defectExpectedOutcome: detail.kind === 'bug' ? detail.expectedOutcome : '',
    sourceContext: { ...readSourceContext(task.sourceContextJson), type: 'zentao', sourceUrl: detail.sourceUrl, zentao: link },
    priority: toLocalPriority(detail.priority),
  };
}

function readTaskZentaoLink(task: TaskRecord): ZentaoTaskSyncLink | null {
  try {
    return parseZentaoTaskSyncLink(readSourceContext(task.sourceContextJson).zentao);
  } catch {
    return null;
  }
}

function readSourceContext(value?: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value ?? '{}') as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function syncKey(instanceId: string, kind: ZentaoRemoteKind, objectId: string): string {
  return `${instanceId}:${kind}:${objectId}`;
}

function toLocalPriority(value: string): TaskPriority {
  const normalized = value.trim().toLowerCase();
  if (/^p[0-4]$/u.test(normalized)) return normalized as TaskPriority;
  const numeric = Number(normalized);
  if (Number.isInteger(numeric) && numeric >= 1 && numeric <= 5) return `p${numeric - 1}` as TaskPriority;
  return 'p2';
}

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function tomorrowDate(): string {
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  return tomorrow.toISOString().slice(0, 10);
}

function readError(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message.trim() ? reason.message : fallback;
}
