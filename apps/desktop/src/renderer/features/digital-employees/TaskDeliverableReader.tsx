import { TaskWorkReviewPanel } from './TaskWorkReviewPanel.js';
import { useEffect, useId, useState } from 'react';
import { ConversationMarkdown } from '../../session/ConversationMarkdown.js';
import { TextFilePreview } from '../../code/TextFilePreview.js';
import { Button } from '../../ui/Button.js';
import { ModalPortal } from '../../ui/ModalPortal.js';
import { VisibleApplicationError } from '../../ui/ApplicationErrorDialog.js';
import type { DigitalEmployeeApiClient } from './digitalEmployeeApiClient.js';
import type { TaskWorkDeliverableRecord } from './digitalEmployeeContracts.js';

/** 已冻结成果的阅读空间；只读历史与待验收成果共用同一内容接口。 */
export function TaskDeliverableReader(props: {
  /** 成果必须位于当前任务边界。 */
  taskId: string;
  /** 固定修订身份，不以最新会话回复替代。 */
  deliverable: TaskWorkDeliverableRecord;
  /** 同一任务内的冻结成果；比较时再次限定为同一工作。 */
  revisions: TaskWorkDeliverableRecord[];
  /** 原有正式成果读取接口。 */
  client: DigitalEmployeeApiClient;
  /** 界面语言。 */
  language: 'zh-CN' | 'en-US';
  /** 关闭阅读空间并返回原列表。 */
  onClose(): void;
  /** 仅真实存在待办决定时提供验收入口。 */
  onReview?(): void;
}) {
  /** 阅读文案沿用界面语言。 */
  const zh = props.language === 'zh-CN';
  /** 标题身份避免同屏浮层冲突。 */
  const titleId = useId();
  /** 历史对照不会改变右侧正在审查的成果身份。 */
  const [comparisonId, setComparisonId] = useState('');
  /** 不允许跨工作比较看似相同的修订号。 */
  const revisions = props.revisions.filter((item) => item.workItemId === props.deliverable.workItemId && item.id !== props.deliverable.id).sort((a, b) => b.version - a.version);
  /** 失效或移除的选择立即退出对照。 */
  const comparison = revisions.find((item) => item.id === comparisonId);
  /** 正文成功读取允许空字符串，不误判为仍在载入。 */
  const [content, setContent] = useState<string | null>(null);
  /** 错误独立于正文，原修订保留重试。 */
  const [error, setError] = useState<unknown>(null);
  /** 用户主动重试的读取代次。 */
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    /** 关闭或切换成果后不再写入旧请求结果。 */
    let active = true;
    setContent(null);
    setError(null);
    void readTaskDeliverableContent(props.client, props.taskId, props.deliverable, props.language)
      .then((value) => {
        if (active) setContent(value);
      })
      .catch((cause: unknown) => {
        if (active) setError(cause);
      });
    return () => {
      active = false;
    };
  }, [props.client, props.taskId, props.deliverable.id, props.deliverable.contentSha256, props.deliverable.version, retry, zh]);
  return (
    <ModalPortal rootClassName="task-deliverable-reader-root" backdropClassName="task-work-decision-backdrop" onDismiss={props.onClose}>
      <section className="task-deliverable-reader zeus-solid-form-surface" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header>
          <span>
            <small>
              {zh ? '成果修订' : 'Deliverable revision'} {props.deliverable.version}
            </small>
            <strong id={titleId}>{props.deliverable.title}</strong>
          </span>
          <Button variant="secondary" size="compact" onClick={props.onClose}>
            {zh ? '关闭' : 'Close'}
          </Button>
        </header>
        {revisions.length ? (
          <label className="task-deliverable-comparison-control">
            <span>{zh ? '对照历史成果' : 'Compare revisions'}</span>
            <select value={comparison?.id ?? ''} onChange={(event) => setComparisonId(event.target.value)}>
              <option value="">{zh ? '只看当前成果' : 'Current deliverable only'}</option>
              {revisions.map((item) => (
                <option key={item.id} value={item.id}>
                  {zh ? '修订' : 'Revision'} {item.version} · {item.createdAt.slice(0, 10)}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <div className={`task-deliverable-reader-body${comparison ? ' is-comparing' : ''}`}>
          {comparison ? <TaskDeliverableComparison key={`${comparison.id}:${comparison.contentSha256}`} taskId={props.taskId} deliverable={comparison} client={props.client} language={props.language} /> : null}
          <section className="task-deliverable-current" aria-label={zh ? '当前审查成果' : 'Current deliverable'}>
            {comparison ? (
              <h3>
                {zh ? '当前成果 · 修订' : 'Current · Revision'} {props.deliverable.version}
              </h3>
            ) : null}
            {error ? (
              <div role="alert">
                <VisibleApplicationError error={error} language={zh ? 'zh-CN' : 'en'} />
                <Button variant="secondary" size="compact" onClick={() => setRetry((value) => value + 1)}>
                  {zh ? '重新读取' : 'Try again'}
                </Button>
              </div>
            ) : content !== null ? (
              <TaskDeliverableContent key={props.deliverable.id} id={props.deliverable.id} title={props.deliverable.title} content={content} language={props.language} />
            ) : (
              <p role="status">{zh ? '正在读取成果全文…' : 'Loading deliverable…'}</p>
            )}
            <TaskWorkReviewPanel taskId={props.taskId} deliverable={props.deliverable} client={props.client} readOnly={!props.onReview} />
          </section>
        </div>
        {props.onReview ? (
          <footer>
            <Button variant="primary" size="regular" disabled={content === null} onClick={props.onReview}>
              {zh ? '审查并验收' : 'Review deliverable'}
            </Button>
          </footer>
        ) : null}
      </section>
    </ModalPortal>
  );
}

/** 对照独立读取与校验历史正文，失败不会遮挡当前成果或混淆验收对象。 */
function TaskDeliverableComparison(props: { taskId: string; deliverable: TaskWorkDeliverableRecord; client: DigitalEmployeeApiClient; language: 'zh-CN' | 'en-US' }) {
  /** 历史内容和读取错误分别保留。 */
  const [state, setState] = useState<{ content: string | null; error: unknown }>({ content: null, error: null });
  /** 重试只重读选中的历史修订。 */
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    /** 切换修订后丢弃迟到回执。 */
    let active = true;
    setState({ content: null, error: null });
    void readTaskDeliverableContent(props.client, props.taskId, props.deliverable, props.language).then(
      (content) => {
        if (active) setState({ content, error: null });
      },
      (error: unknown) => {
        if (active) setState({ content: null, error });
      },
    );
    return () => {
      active = false;
    };
  }, [props.client, props.taskId, props.deliverable.id, props.deliverable.version, props.deliverable.contentSha256, props.language, retry]);
  return (
    <section className="task-deliverable-comparison" aria-label={props.language === 'zh-CN' ? '历史成果' : 'Previous deliverable'}>
      <h3>
        {props.language === 'zh-CN' ? '历史成果 · 修订' : 'Previous · Revision'} {props.deliverable.version}
      </h3>
      {state.error ? (
        <div role="alert">
          <VisibleApplicationError error={state.error} language={props.language === 'zh-CN' ? 'zh-CN' : 'en'} />
          <Button variant="secondary" size="compact" onClick={() => setRetry((value) => value + 1)}>
            {props.language === 'zh-CN' ? '重新读取' : 'Try again'}
          </Button>
        </div>
      ) : state.content !== null ? (
        <TaskDeliverableContent id={props.deliverable.id} title={props.deliverable.title} content={state.content} language={props.language} />
      ) : (
        <p role="status">{props.language === 'zh-CN' ? '正在读取历史成果…' : 'Loading previous deliverable…'}</p>
      )}
    </section>
  );
}

/** 成果默认按文档阅读，同时保留完整原文，避免截断或格式化掩盖内容。 */
export function TaskDeliverableContent(props: {
  /** 当前冻结成果身份。 */
  id: string;
  /** 文档标题用于无障碍阅读。 */
  title: string;
  /** 已校验的完整正文。 */
  content: string;
  /** 界面语言。 */
  language: 'zh-CN' | 'en-US';
}) {
  /** 阅读和原文切换不会修改交付物。 */
  const [raw, setRaw] = useState(false);
  return (
    <section className="task-deliverable-content" aria-label={props.title}>
      <div className="task-deliverable-view-controls">
        <Button variant="secondary" size="compact" aria-pressed={raw} onClick={() => setRaw((value) => !value)}>
          {props.language === 'zh-CN' ? (raw ? '返回阅读' : '查看原文') : raw ? 'Read document' : 'View source'}
        </Button>
      </div>
      {raw ? (
        <TextFilePreview id={props.id} title={props.title} content={props.content} />
      ) : (
        <ConversationMarkdown text={props.content} streamId={props.id} phase="final" language={props.language} renderImmediately={props.content.length <= 24_000} />
      )}
    </section>
  );
}

/** 阅读与验收必须核对同一冻结修订，不能接受另一个成果或新内容的回执。 */
export async function readTaskDeliverableContent(client: DigitalEmployeeApiClient, taskId: string, deliverable: TaskWorkDeliverableRecord, language: 'zh-CN' | 'en-US'): Promise<string> {
  /** 身份、修订及内容摘要由正式读取接口返回。 */
  const result = await client.loadTaskWorkDeliverableContent(taskId, deliverable.id);
  if (result.deliverableId !== deliverable.id || result.contentSha256 !== deliverable.contentSha256 || result.version !== deliverable.version)
    throw new Error(language === 'zh-CN' ? '成果修订不一致，请重新读取任务。' : 'The deliverable revision does not match. Reload the task.');
  return result.content;
}
