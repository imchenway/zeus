import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowClockwiseIcon as ArrowClockwise } from '@phosphor-icons/react/dist/csr/ArrowClockwise';
import type { ZentaoTaskEffortsResult } from '@zeus/shared';
import type { DashboardClient } from '../dashboardClient.js';
import type { TaskRecord } from '../apiClient.js';
import { Button } from '../ui/Button.js';
import { FormDialog } from '../ui/FormDialog.js';
import { readTaskZentaoLink, todayDate } from './ZentaoSyncModal.js';
import { isZentaoWriteUnknown } from './useZentaoInstances.js';

/** 登记到已关联任务；汇总和历史记录始终以禅道响应为准。 */
export function ZentaoEffortModal(props: {
  /** 当前任务关联在服务端重新核对。 */
  task: TaskRecord;
  /** 复用现有集成客户端与命令回执。 */
  client: DashboardClient;
  /** 界面语言。 */
  language: 'zh-CN' | 'en-US';
  /** 关闭不触发任何补交或重试。 */
  onClose: () => void;
}) {
  /** 所有文案与宿主语言一致。 */
  const zh = props.language === 'zh-CN';
  /** 固定打开时确认的任务及关联，其他入口编辑后须重新打开再提交。 */
  const initialTask = useRef(props.task).current;
  const link = readTaskZentaoLink(initialTask);
  /** 当前远端快照，不持久化到本地任务内容。 */
  const [snapshot, setSnapshot] = useState<ZentaoTaskEffortsResult | null>(null);
  /** 远端读取尚未完成的状态。 */
  const [loading, setLoading] = useState(true);
  /** 用户显式重新读取的操作计数。 */
  const [reload, setReload] = useState(0);
  /** 用户选择的本地工作日期。 */
  const [date, setDate] = useState(todayDate);
  /** 本次消耗小时数草稿，空值不代表零。 */
  const [consumed, setConsumed] = useState('');
  /** 用户重新评估的剩余小时数草稿。 */
  const [left, setLeft] = useState('');
  /** 本次工作说明草稿。 */
  const [work, setWork] = useState('');
  /** 提交期间禁止编辑和关闭。 */
  const [busy, setBusy] = useState(false);
  /** 写入结果未知时锁定再次提交。 */
  const [unknown, setUnknown] = useState(false);
  /** 当前操作的真实错误信息。 */
  const [error, setError] = useState<string | null>(null);
  /** 最近一次登记已确认成功的事实。 */
  const [saved, setSaved] = useState(false);
  /** 同步占用提交身份，拦截同一事件循环内的重复点击。 */
  const submitting = useRef(false);
  useEffect(() => {
    if (!link || link.kind !== 'task') return;
    /** 关闭或切换目标后丢弃旧响应。 */
    let cancelled = false;
    setLoading(true);
    setError(null);
    void props.client
      .loadZentaoTaskEfforts(link.instanceId, initialTask.id)
      .then((result) => {
        if (!cancelled) setSnapshot(result);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : '禅道工时读取失败。');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [props.client, initialTask.id, link?.instanceId, link?.objectId, reload]);

  /** 一次提交只增加一条日志，剩余工时由用户明确填写。 */
  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!link || !snapshot || submitting.current || unknown) return;
    if (!consumed.trim() || !Number.isFinite(Number(consumed)) || Number(consumed) <= 0 || !left.trim() || !Number.isFinite(Number(left)) || Number(left) < 0 || !work.trim() || !date) {
      setError(zh ? '请填写有效日期、工作说明、本次耗时和剩余工时。' : 'Enter a valid date, work description, consumed hours and remaining hours.');
      return;
    }
    submitting.current = true;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      /** 成功回执已确认写入；后续日志刷新失败不能改变这项事实。 */
      const result = await props.client.recordZentaoTaskEffort(link.instanceId, { taskId: initialTask.id, expectedUpdatedAt: initialTask.updatedAt ?? '', date, consumed: Number(consumed), left: Number(left), work: work.trim() });
      setSnapshot((current) => (current ? { ...current, task: result.task } : current));
      setSaved(true);
      setConsumed('');
      setLeft('');
      setWork('');
      try {
        setSnapshot(await props.client.loadZentaoTaskEfforts(link.instanceId, initialTask.id));
      } catch {
        setError(zh ? '工时已登记，日志刷新失败，请点击重新读取。' : 'Hours were recorded, but refreshing the log failed. Reload the log.');
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : zh ? '工时登记失败。' : 'Unable to record hours.');
      setUnknown(isZentaoWriteUnknown(reason));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  if (!link || link.kind !== 'task') return null;
  return (
    <FormDialog
      className="zentao-effort-dialog"
      title={zh ? '登记工时' : 'Record hours'}
      zh={zh}
      busy={busy}
      submitLabel={zh ? '登记工时' : 'Record hours'}
      submitDisabled={loading || !snapshot || unknown}
      onClose={props.onClose}
      onSubmit={(event) => void submit(event)}
    >
      <div className="zentao-effort-task">
        <div>
          <span>
            {zh ? '禅道任务' : 'ZenTao task'} #{link.objectId}
          </span>
          <p>{snapshot?.task.title ?? initialTask.title}</p>
        </div>
        <a className="zentao-sync-source-link" href={link.sourceUrl} target="_blank" rel="noreferrer">
          {zh ? '在禅道查看' : 'View in ZenTao'}
          <span aria-hidden="true">↗</span>
        </a>
      </div>
      {loading ? (
        <p className="zeus-form-description" role="status">
          {zh ? '正在读取工时…' : 'Loading hours…'}
        </p>
      ) : null}
      {snapshot ? (
        <>
          <dl className="zentao-effort-summary">
            <div>
              <dt>{zh ? '预计工时' : 'Estimated'}</dt>
              <dd>
                {snapshot.task.estimate ?? '—'} <small>{zh ? '小时' : 'h'}</small>
              </dd>
            </div>
            <div>
              <dt>{zh ? '累计消耗' : 'Consumed'}</dt>
              <dd>
                {snapshot.task.consumed ?? '—'} <small>{zh ? '小时' : 'h'}</small>
              </dd>
            </div>
            <div>
              <dt>{zh ? '剩余工时' : 'Remaining'}</dt>
              <dd>
                {snapshot.task.left ?? '—'} <small>{zh ? '小时' : 'h'}</small>
              </dd>
            </div>
          </dl>
          <section className="zentao-effort-entry" aria-label={zh ? '本次工时' : 'Hours for this entry'}>
            <div className="zentao-effort-fields">
              <label>
                <span>{zh ? '工作日期' : 'Work date'}</span>
                <input type="date" required value={date} onChange={(event) => setDate(event.currentTarget.value)} disabled={busy || unknown} />
              </label>
              <label>
                <span>{zh ? '本次耗时（小时）' : 'Consumed hours'}</span>
                <input type="number" min="0" step="any" required value={consumed} onChange={(event) => setConsumed(event.currentTarget.value)} disabled={busy || unknown} />
              </label>
              <label>
                <span>{zh ? '剩余工时（小时）' : 'Remaining hours'}</span>
                <input type="number" min="0" step="any" required value={left} onChange={(event) => setLeft(event.currentTarget.value)} disabled={busy || unknown} />
                {left.trim() !== '' && Number(left) === 0 ? <small role="status">{zh ? '填 0 可能改变禅道任务状态。' : 'Zero may change the task status in ZenTao.'}</small> : null}
              </label>
            </div>
            <label>
              <span>{zh ? '工作说明' : 'Work description'}</span>
              <textarea required rows={3} value={work} onChange={(event) => setWork(event.currentTarget.value)} disabled={busy || unknown} />
            </label>
          </section>
          <section className="zentao-effort-history" aria-label={zh ? '工时日志' : 'Work log'}>
            <div className="zentao-effort-history-heading">
              <h3>
                {zh ? '工时日志' : 'Work log'}
                <span className="zentao-effort-history-count">{zh ? `${snapshot.items.length} 条` : `${snapshot.items.length} entries`}</span>
              </h3>
              <Button size="compact" onClick={() => setReload((value) => value + 1)} disabled={busy || loading}>
                <ArrowClockwise aria-hidden="true" />
                {zh ? '刷新' : 'Reload'}
              </Button>
            </div>
            <div className="zentao-effort-log">
              <table aria-label={zh ? '禅道工时日志（小时）' : 'ZenTao work log (hours)'}>
                <thead>
                  <tr>
                    <th scope="col">{zh ? '日期' : 'Date'}</th>
                    <th scope="col">{zh ? '账号' : 'Account'}</th>
                    <th scope="col">{zh ? '耗时' : 'Hours'}</th>
                    <th scope="col">{zh ? '剩余' : 'Left'}</th>
                    <th scope="col">{zh ? '说明' : 'Work'}</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshot.items.map((item) => (
                    <tr key={item.id}>
                      <td>{item.date}</td>
                      <td>{item.account}</td>
                      <td>{item.consumed}</td>
                      <td>{item.left}</td>
                      <td>{item.work}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!snapshot.items.length ? <p className="zeus-form-description">{zh ? '暂无工时日志。' : 'No work log entries.'}</p> : null}
            </div>
          </section>
        </>
      ) : null}
      {saved ? (
        <p role="status" className="zentao-sync-success">
          {zh ? '工时已登记。' : 'Hours recorded.'}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="zentao-sync-error">
          {error}
        </p>
      ) : null}
      {unknown ? (
        <p className="zeus-form-description" role="status">
          {zh ? '写入结果未确认，请先到禅道核对，勿重复提交。' : 'The write result is unknown. Check ZenTao before submitting again.'}
        </p>
      ) : null}
    </FormDialog>
  );
}
