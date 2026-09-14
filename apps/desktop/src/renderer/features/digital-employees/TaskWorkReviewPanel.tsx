import { useEffect, useRef, useState } from 'react';
import { Button } from '../../ui/Button.js';
import type { DigitalEmployeeApiClient } from './digitalEmployeeApiClient.js';
import type { TaskWorkDeliverableRecord, TaskWorkReviewNote } from './digitalEmployeeContracts.js';

/** 审查在正文旁保留固定位置和解决状态，不另建一套成果版本。 */
export function TaskWorkReviewPanel(props: {
  /** 当前任务和固定成果。 */
  taskId: string;
  /** 当前审查对象。 */
  deliverable: TaskWorkDeliverableRecord;
  /** 原工作服务。 */
  client: DigitalEmployeeApiClient;
  /** 已结束任务或历史成果只展示。 */
  readOnly: boolean;
  /** 父级验收按钮根据实际未解决意见更新。 */
  onReady?(canAccept: boolean): void;
}) {
  /** 当前固定成果的审查历史。 */
  const [notes, setNotes] = useState<TaskWorkReviewNote[]>([]);
  /** 本地定位文本不会修改成果正文。 */
  const [anchor, setAnchor] = useState('');
  /** 新意见失败后保留原稿。 */
  const [content, setContent] = useState('');
  /** 默认作为建议，需要时明确标记阻塞。 */
  const [blocking, setBlocking] = useState(false);
  /** 异步失败明确显示。 */
  const [error, setError] = useState<string | null>(null);
  /** 写入失败在重新读取成功后仍保留，避免把失败操作显示为成功。 */
  const [operationError, setOperationError] = useState<string | null>(null);
  /** 操作中避免重复发送。 */
  const [busy, setBusy] = useState(false);
  /** 本次读取状态。 */
  const [loaded, setLoaded] = useState(false);
  /** 重试只读取同一成果。 */
  const [revision, setRevision] = useState(0);
  /** 回调变化不触发重新读取。 */
  const readyRef = useRef(props.onReady);
  readyRef.current = props.onReady;
  /** 同步重复点击保护。 */
  const pending = useRef(false);
  useEffect(() => {
    /** 切换或关闭成果后忽略旧响应。 */
    let active = true;
    setLoaded(false);
    readyRef.current?.(false);
    void props.client
      .loadTaskWorkReviews(props.taskId, props.deliverable.id)
      .then((next) => {
        if (!active) return;
        setNotes(next);
        setError(null);
        setLoaded(true);
        readyRef.current?.(!next.some((note) => note.blocking && note.status === 'open'));
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : '审查意见读取失败。');
      });
    return () => {
      active = false;
    };
  }, [props.client, props.taskId, props.deliverable.id, revision]);
  /** 异步保存成功后重新读取权威结果。 */
  async function act(operation: () => Promise<unknown>): Promise<void> {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    setOperationError(null);
    readyRef.current?.(false);
    try {
      await operation();
      setRevision((value) => value + 1);
    } catch (cause) {
      setOperationError(cause instanceof Error ? cause.message : '审查操作失败。');
      // 写入失败也可能已被服务端接收，重新读取权威意见后再恢复验收入口。
      setRevision((value) => value + 1);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="task-work-review" aria-label="成果审查意见">
      <header>
        <h4>审查意见</h4>
        <small>{notes.filter((note) => note.status === 'open').length} 条待处理</small>
      </header>
      {props.deliverable.bundle ? (
        <details className="task-deliverable-evidence-summary" open={props.deliverable.bundle.gaps.length > 0 || undefined}>
          <summary>
            证据来源 · {props.deliverable.bundle.sources.filter((source) => source.kind === 'change_set').length} 份变更 · {props.deliverable.bundle.sources.filter((source) => source.kind === 'command').length} 条命令记录
            {props.deliverable.bundle.sources.some((source) => source.kind === 'deployment') ? ` · ${props.deliverable.bundle.sources.filter((source) => source.kind === 'deployment').length} 份部署凭证` : ''}
          </summary>
          <p>请按上方列出的证据来源核对成果正文。命令成功不代替对任务目标的审查。</p>
          {props.deliverable.bundle.gaps.map((gap) => (
            <p key={gap} className="digital-employee-feedback is-error">
              {gap}
            </p>
          ))}
        </details>
      ) : null}
      {error || operationError ? (
        <p role="alert" className="digital-employee-feedback is-error">
          {error || operationError}{' '}
          <Button variant="secondary" size="compact" onClick={() => setRevision((value) => value + 1)}>
            重新读取
          </Button>
        </p>
      ) : null}
      {!loaded && !error ? <p role="status">正在读取审查意见…</p> : null}
      {loaded && !notes.length ? <p>尚无审查意见。意见始终关联这份成果修订。</p> : null}
      <ul>
        {notes.map((note) => (
          <li key={note.id} data-state={note.status}>
            <div>
              <strong>{note.anchor || '整体成果'}</strong>
              <span>
                {note.blocking ? '阻塞' : '建议'} · {note.status === 'resolved' ? '已解决' : '待处理'}
              </span>
            </div>
            <p>{note.content}</p>
            {!props.readOnly && props.deliverable.status === 'submitted' ? (
              <Button variant="secondary" size="compact" disabled={busy} onClick={() => void act(() => props.client.resolveTaskWorkReview(props.taskId, note, note.status !== 'resolved'))}>
                {note.status === 'resolved' ? '重新打开' : '标记已解决'}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {!props.readOnly && props.deliverable.status === 'submitted' ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!content.trim()) {
              setError('请填写问题与建议后再添加审查意见。');
              return;
            }
            void act(async () => {
              await props.client.addTaskWorkReview(props.taskId, props.deliverable, { anchor, content, blocking });
              setContent('');
              setAnchor('');
              setBlocking(false);
            });
          }}
        >
          <label>
            <span>关联位置</span>
            <input value={anchor} maxLength={1000} placeholder="例如：src/task.ts 第 42 行，或方案中的边界处理" onChange={(event) => setAnchor(event.target.value)} />
          </label>
          <label>
            <span>问题与建议</span>
            <textarea value={content} maxLength={8000} rows={3} onChange={(event) => setContent(event.target.value)} />
          </label>
          <footer>
            <label className="task-work-review-blocking">
              <input type="checkbox" checked={blocking} onChange={(event) => setBlocking(event.target.checked)} />
              解决前不能验收
            </label>
            <Button type="submit" size="compact" disabled={busy || !loaded}>
              添加审查意见
            </Button>
          </footer>
        </form>
      ) : null}
    </section>
  );
}
