import { parseZentaoTaskSyncLink, type TaskPriority, type ZentaoRemoteItemDetail, type ZentaoRemoteItemSummary, type ZentaoRemoteKind, type ZentaoTaskSyncLink } from '@zeus/shared';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ZentaoInstanceRecord } from '@zeus/shared';
import { isZentaoWriteUnknown } from './useZentaoInstances.js';
import type { DashboardClient } from '../dashboardClient.js';
import type { CreateTaskRequest, TaskRecord, UpdateTaskRequest } from '../apiClient.js';
import { Button } from '../ui/Button.js';
import { ModalPortal } from '../ui/ModalPortal.js';
import { VisibleApplicationError } from '../ui/ApplicationErrorDialog.js';
import type { ZentaoRemoteExecutionSummary, ZentaoRemoteProjectSummary, ZentaoTaskSyncResult } from '../features/integrations/integrationContracts.js';

const pageSize = 24;

export interface ZentaoImportModalProps {
  /** 由工作区统一分发已验证实例，失效后立即移除。 */
  instances: ZentaoInstanceRecord[];
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
  /** 与任务菜单使用同一组已验证实例。 */
  instances: ZentaoInstanceRecord[];
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
  /** 只展示宿主当前验证通过的实例。 */
  const instances = props.instances;
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
    setError(null);
    setResultMessage(null);
    setConfirming(false);
    setSelected({});
    setPage(0);
  }, [client, props.open, zh]);

  useEffect(() => {
    if (!props.open || instances.some((item) => item.id === instanceId)) return;
    setInstanceId(instances[0]?.id ?? '');
    setSelected({});
    setConfirming(false);
    setPage(0);
  }, [props.open, instances, instanceId]);

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
    <ModalPortal rootClassName="zentao-sync-modal-portal" dismissDisabled={busy} onDismiss={props.onClose} role="dialog">
      <section className="zentao-sync-modal zeus-solid-form-surface" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId}>
        <header className="zentao-sync-modal-header">
          <div>
            <strong id={titleId}>{zh ? '从禅道导入' : 'Import from ZenTao'}</strong>
            <p id={descriptionId}>
              {zh
                ? `读取当前禅道账号负责的任务和缺陷，确认后导入到${props.projectName ?? '当前项目'}。`
                : `Read tasks and bugs assigned to the current ZenTao account, then confirm before importing into ${props.projectName ?? 'the current project'}.`}
            </p>
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
                  <VisibleApplicationError error={error} language={zh ? 'zh-CN' : 'en'} />
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

/** 创建与手动同步共用的禅道目标草稿，工时单位为小时。 */
export interface ZentaoTaskDestination {
  /** 已验证的禅道实例。 */
  instanceId: string;
  /** 禅道项目编号。 */
  projectId: string;
  /** 禅道执行编号。 */
  executionId: string;
  /** 预计开始日期。 */
  estStarted: string;
  /** 预计结束日期。 */
  deadline: string;
  /** 空串表示不提交预计工时，不能隐式改成零。 */
  estimate: string;
}

/** 每次新建均使用独立目标草稿，不继承复制来源的远端身份。 */
export function createZentaoTaskDestination(instanceId = ''): ZentaoTaskDestination {
  return { instanceId, projectId: '', executionId: '', estStarted: todayDate(), deadline: tomorrowDate(), estimate: '' };
}

/** 提交前校验目标完整性，避免本地创建后才发现必填信息缺失。 */
export function isZentaoDestinationComplete(value: ZentaoTaskDestination): boolean {
  return Boolean(value.instanceId && value.projectId && value.executionId && value.estStarted && value.deadline && (value.estimate === '' || (Number.isFinite(Number(value.estimate)) && Number(value.estimate) >= 0)));
}

/** 创建与手动同步共享目标选择、日期和预计工时控件。 */
export function ZentaoTaskDestinationFields(props: {
  /** 使用现有本地服务客户端。 */
  client?: DashboardClient;
  /** 只传入当前服务验证通过的实例。 */
  instances: ZentaoInstanceRecord[];
  /** 当前表单值。 */
  value: ZentaoTaskDestination;
  /** 原子更新目标草稿，切换上级时清除下级选择。 */
  onChange: (value: ZentaoTaskDestination) => void;
  /** 与宿主界面一致的语言。 */
  zh: boolean;
  /** 提交中禁止修改。 */
  disabled?: boolean;
  /** 已关联对象禁止更换实例、项目和执行。 */
  lockedTarget?: boolean;
  /** 已开始的任务以及历史 Bug 不允许改写最初预计工时。 */
  estimateDisabled?: boolean;
  /** 历史 Bug 更新不要求补充执行。 */
  requireExecution?: boolean;
}) {
  /** 列表只保存当前实例的数据。 */
  const [projects, setProjects] = useState<ZentaoRemoteProjectSummary[]>([]);
  /** 当前项目的可选执行。 */
  const [executions, setExecutions] = useState<ZentaoRemoteExecutionSummary[]>([]);
  /** 加载错误就地展示，只有用户主动操作才重新读取。 */
  const [error, setError] = useState<string | null>(null);
  /** 项目列表读取中的交互锁。 */
  const [loadingProjects, setLoadingProjects] = useState(false);
  /** 执行列表读取中的交互锁。 */
  const [loadingExecutions, setLoadingExecutions] = useState(false);
  /** 用户显式重新读取的操作计数。 */
  const [reload, setReload] = useState(0);
  /** 只依赖稳定目标身份，编辑工时不会重新请求列表。 */
  const { instanceId, projectId } = props.value;
  useEffect(() => {
    /** 关闭或切换目标后丢弃旧响应。 */
    let cancelled = false;
    setProjects([]);
    setError(null);
    if (!props.client || !instanceId) return;
    setLoadingProjects(true);
    void props.client
      .loadZentaoProjects(instanceId)
      .then((items) => {
        if (!cancelled) setProjects(items);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(readError(reason, '禅道项目读取失败。'));
      })
      .finally(() => {
        if (!cancelled) setLoadingProjects(false);
      });
    return () => {
      cancelled = true;
    };
  }, [props.client, instanceId, reload]);
  useEffect(() => {
    /** 关闭或切换目标后丢弃旧响应。 */
    let cancelled = false;
    setExecutions([]);
    if (!props.client || !instanceId || !projectId) return;
    setLoadingExecutions(true);
    void props.client
      .loadZentaoExecutions(instanceId, projectId)
      .then((items) => {
        if (!cancelled) setExecutions(items);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(readError(reason, '禅道执行读取失败。'));
      })
      .finally(() => {
        if (!cancelled) setLoadingExecutions(false);
      });
    return () => {
      cancelled = true;
    };
  }, [props.client, instanceId, projectId, reload]);
  return (
    <div className="zentao-sync-target-fields">
      <div className="zentao-sync-toolbar">
        <SelectField
          label={props.zh ? '禅道实例' : 'ZenTao instance'}
          value={instanceId}
          onChange={(next) => props.onChange({ ...props.value, instanceId: next, projectId: '', executionId: '' })}
          options={[{ value: '', label: props.zh ? '请选择实例' : 'Choose instance' }, ...props.instances.map((item) => ({ value: item.id, label: `${item.host}${item.basePath} · ${item.account}` }))]}
          disabled={props.disabled || props.lockedTarget}
        />
        <SelectField
          label={props.zh ? '禅道项目' : 'ZenTao project'}
          value={projectId}
          onChange={(next) => props.onChange({ ...props.value, projectId: next, executionId: '' })}
          options={[
            { value: '', label: props.zh ? '请选择项目' : 'Choose project' },
            ...projects.map((item) => ({ value: item.id, label: item.name })),
            ...(props.lockedTarget && projectId && !projects.some((item) => item.id === projectId) ? [{ value: projectId, label: `#${projectId}` }] : []),
          ]}
          disabled={props.disabled || props.lockedTarget || loadingProjects || !instanceId}
        />
        <SelectField
          label={props.zh ? '禅道执行' : 'ZenTao execution'}
          value={props.value.executionId}
          onChange={(next) => props.onChange({ ...props.value, executionId: next })}
          options={[
            { value: '', label: props.zh ? '请选择执行' : 'Choose execution' },
            ...executions.map((item) => ({ value: item.id, label: item.name })),
            ...(props.lockedTarget && props.value.executionId && !executions.some((item) => item.id === props.value.executionId) ? [{ value: props.value.executionId, label: `#${props.value.executionId}` }] : []),
          ]}
          disabled={props.disabled || props.lockedTarget || loadingExecutions || !projectId}
        />
      </div>
      <div className="zentao-sync-toolbar">
        <label className="zentao-sync-field">
          <span>{props.zh ? '预计开始' : 'Estimated start'}</span>
          <input type="date" required value={props.value.estStarted} onChange={(event) => props.onChange({ ...props.value, estStarted: event.currentTarget.value })} disabled={props.disabled} />
        </label>
        <label className="zentao-sync-field">
          <span>{props.zh ? '截止日期' : 'Deadline'}</span>
          <input type="date" required value={props.value.deadline} onChange={(event) => props.onChange({ ...props.value, deadline: event.currentTarget.value })} disabled={props.disabled} />
        </label>
        <label className="zentao-sync-field">
          <span>{props.zh ? '预计工时（小时）' : 'Estimated hours'}</span>
          <input type="number" min="0" step="any" value={props.value.estimate} onChange={(event) => props.onChange({ ...props.value, estimate: event.currentTarget.value })} disabled={props.disabled || props.estimateDisabled} />
        </label>
      </div>
      {props.estimateDisabled ? <small>{props.zh ? '已开始的任务保留最初预计工时；历史 Bug 不登记任务工时。' : 'Started tasks keep their original estimate; task hours do not apply to bugs.'}</small> : null}
      {error ? (
        <div role="alert" className="zentao-sync-error">
          {error}{' '}
          <Button onClick={() => setReload((current) => current + 1)} disabled={props.disabled}>
            {props.zh ? '重新读取' : 'Reload'}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** 当前任务推送到禅道：新对象统一为任务，已有对象只更新原关联。 */
export function ZentaoPushModal(props: ZentaoPushModalProps) {
  /** 中文和英文界面共享同一写入行为。 */
  const zh = props.language === 'zh-CN';
  /** 当前弹窗标题的无障碍关联身份。 */
  const titleId = useId();
  /** 服务端验证通过的可用实例。 */
  const instances = props.instances;
  /** 当前任务已经保存的远端关联。 */
  const linked = readTaskZentaoLink(props.task);
  /** 本次同步的目标、日期和预计工时草稿。 */
  const [destination, setDestination] = useState(() => createZentaoTaskDestination());
  /** 读取到的远端任务状态，未知时禁止更新。 */
  const [remoteStatus, setRemoteStatus] = useState<string | null>(null);
  /** 远端读取尚未完成的状态。 */
  const [loading, setLoading] = useState(false);
  /** 用户显式重新读取的操作计数。 */
  const [reload, setReload] = useState(0);
  /** 提交期间禁止编辑和关闭。 */
  const [busy, setBusy] = useState(false);
  /** 用户检查目标后进入最终确认。 */
  const [confirming, setConfirming] = useState(false);
  /** 写入结果未知时锁定再次提交。 */
  const [unknown, setUnknown] = useState(false);
  /** 当前操作的真实错误信息。 */
  const [error, setError] = useState<string | null>(null);
  /** 服务端确认接受的同步结果。 */
  const [result, setResult] = useState<ZentaoTaskSyncResult | null>(null);
  /** 同一事件循环内的重复点击不能产生两次请求。 */
  const submitting = useRef(false);
  /** 固定打开时的任务修订，其他入口变更后不自动接受新的写入目标。 */
  const submittedTask = useRef(props.task);
  useEffect(() => {
    if (!props.open) return;
    submittedTask.current = props.task;
    /** 关闭或切换目标后丢弃旧响应。 */
    let cancelled = false;
    /** 打开窗口时绑定的真实关联。 */
    const initialLink = readTaskZentaoLink(props.task);
    setDestination({ ...createZentaoTaskDestination(initialLink?.instanceId), projectId: initialLink?.projectId ?? '', executionId: initialLink?.executionId ?? '' });
    setError(null);
    setResult(null);
    setConfirming(false);
    setUnknown(false);
    setRemoteStatus(null);
    if (!initialLink || !props.client) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void props.client
      .loadZentaoItem(initialLink.instanceId, initialLink.kind, initialLink.objectId)
      .then((detail) => {
        if (cancelled) return;
        setRemoteStatus(detail.status);
        setDestination({
          instanceId: initialLink.instanceId,
          projectId: detail.projectId ?? initialLink.projectId ?? '',
          executionId: detail.executionId ?? initialLink.executionId ?? '',
          estStarted: detail.estStarted?.slice(0, 10) ?? todayDate(),
          deadline: detail.deadline?.slice(0, 10) ?? tomorrowDate(),
          estimate: detail.estimate === undefined ? '' : String(detail.estimate),
        });
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(readError(reason, '禅道详情读取失败。'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [props.open, props.task.id, props.client, reload]);
  /** 提交使用当前任务修订和原关联，不提供静默换绑。 */
  async function syncTask(): Promise<void> {
    if (!props.client || submitting.current || unknown) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      /** 本次命令确认接受的完整任务。 */
      const next = await props.client.syncTaskToZentao(destination.instanceId, {
        taskId: props.task.id,
        expectedUpdatedAt: submittedTask.current.updatedAt ?? '',
        kind: linked?.kind ?? 'task',
        projectId: destination.projectId,
        executionId: destination.executionId || undefined,
        productId: linked?.productId,
        estStarted: destination.estStarted,
        deadline: destination.deadline,
        estimate: linked && (linked.kind !== 'task' || remoteStatus !== 'wait') ? undefined : destination.estimate === '' ? undefined : Number(destination.estimate),
      });
      setResult(next);
      setConfirming(false);
      props.onUpdated(next.task);
    } catch (reason) {
      setError(readError(reason, '同步到禅道失败。'));
      setUnknown(isZentaoWriteUnknown(reason));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  if (!props.open || !props.client || !instances.length || (linked && !instances.some((item) => item.id === linked.instanceId))) return null;
  /** 只有读到现有对象后才能提交，避免用默认值覆盖远端内容。 */
  const ready = !loading && (!linked || remoteStatus !== null) && (linked?.kind === 'bug' ? Boolean(destination.projectId) : isZentaoDestinationComplete(destination)) && instances.some((item) => item.id === destination.instanceId);
  return (
    <ModalPortal rootClassName="zentao-sync-modal-portal" dismissDisabled={busy} onDismiss={props.onClose} role="dialog">
      <section className="zentao-sync-modal zeus-solid-form-surface" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="zentao-sync-modal-header">
          <strong id={titleId}>{zh ? '同步到禅道' : 'Sync to ZenTao'}</strong>
          <Button onClick={props.onClose} disabled={busy} aria-label={zh ? '关闭' : 'Close'}>
            ×
          </Button>
        </header>
        <div className="zentao-sync-modal-body">
          {result ? (
            <p role="status" className="zentao-sync-success">
              {zh ? '已同步到禅道' : 'Synced to ZenTao'} #{result.remote.objectId}
            </p>
          ) : (
            <>
              <p>{linked ? (zh ? `更新已关联对象 #${linked.objectId}` : `Update linked item #${linked.objectId}`) : zh ? '创建新的禅道任务，默认指派给当前禅道账号。' : 'Create a ZenTao task assigned to the current account.'}</p>
              <ZentaoTaskDestinationFields
                client={props.client}
                instances={instances}
                value={destination}
                onChange={(value) => {
                  setDestination(value);
                  setConfirming(false);
                }}
                zh={zh}
                disabled={busy || loading || confirming || unknown}
                lockedTarget={Boolean(linked)}
                estimateDisabled={Boolean(linked && (linked.kind !== 'task' || remoteStatus !== 'wait'))}
              />
              {confirming ? <p role="status">{zh ? `确认将“${props.task.title}”${linked ? '更新到已关联对象' : '创建到所选项目和执行'}？` : `Confirm syncing “${props.task.title}”?`}</p> : null}
            </>
          )}
          {error ? (
            <p role="alert" className="zentao-sync-error">
              {error}
            </p>
          ) : null}
          {unknown ? <p role="status">{zh ? '写入结果未确认，请先到禅道核对，勿重复提交。' : 'The write result is unknown. Check ZenTao before submitting again.'}</p> : null}
          {linked ? (
            <a className="zentao-sync-source-link" href={linked.sourceUrl} target="_blank" rel="noreferrer">
              {zh ? '在禅道查看' : 'View in ZenTao'}
              <span aria-hidden="true">↗</span>
            </a>
          ) : null}
          {linked && remoteStatus === null && !loading ? <Button onClick={() => setReload((value) => value + 1)}>{zh ? '重新读取' : 'Reload'}</Button> : null}
        </div>
        <footer className="zentao-sync-modal-footer">
          <Button onClick={props.onClose} disabled={busy}>
            {zh ? '关闭' : 'Close'}
          </Button>
          {confirming && !result && !unknown ? (
            <Button onClick={() => setConfirming(false)} disabled={busy}>
              {zh ? '返回修改' : 'Back to edit'}
            </Button>
          ) : null}
          {!result ? (
            <Button variant="primary" onClick={() => (confirming ? void syncTask() : setConfirming(true))} disabled={!ready || busy || unknown}>
              {busy ? (zh ? '正在同步…' : 'Syncing…') : confirming ? (zh ? '确认同步' : 'Confirm sync') : zh ? '检查同步内容' : 'Review sync'}
            </Button>
          ) : null}
        </footer>
      </section>
    </ModalPortal>
  );
}

/** 导入确认继续使用既有共享弹窗布局。 */
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

export function readTaskZentaoLink(task: TaskRecord): ZentaoTaskSyncLink | null {
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

/** 使用当前用户日历日期，避免 UTC 在凌晨回退到前一天。 */
export function todayDate(): string {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** 以日历加一天，跨夏令时不使用固定毫秒数。 */
function tomorrowDate(): string {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  return `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`;
}

function readError(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message.trim() ? reason.message : fallback;
}
