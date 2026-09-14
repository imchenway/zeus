import { useEffect, useRef, useState } from 'react';
import { Button } from '../../ui/Button.js';
import type { DigitalEmployeeApiClient } from './digitalEmployeeApiClient.js';
import type { EmployeeMemoryProposal } from './digitalEmployeeContracts.js';

/** 候选经验在此审查，读取列表不会让它自动生效。 */
export function EmployeeMemoryProposals(props: { client: DigitalEmployeeApiClient; projectId: string; employeeId: string; onAccepted(): void }) {
  /** 当前员工的权威建议与读取状态。 */
  const [items, setItems] = useState<EmployeeMemoryProposal[] | null>(null);
  /** 失败保留原列表与重试入口。 */
  const [error, setError] = useState<string | null>(null);
  /** 显式刷新代次。 */
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    /** 防止切换员工后迟到响应串入当前范围。 */
    let active = true;
    setError(null);
    void props.client
      .loadEmployeeMemoryProposals(props.projectId, props.employeeId)
      .then((next) => {
        if (active) setItems(next);
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : '无法读取经验建议。');
      });
    return () => {
      active = false;
    };
  }, [props.client, props.projectId, props.employeeId, revision]);
  return (
    <section className="employee-memory-proposals">
      <header>
        <h4>员工提出的经验建议</h4>
        <Button size="compact" variant="secondary" onClick={() => setRevision((value) => value + 1)}>
          刷新建议
        </Button>
      </header>
      <p>接纳前不会用于新任务。可以先修正内容，再决定是否成为个人经验。</p>
      {error ? <p role="alert">{error}</p> : !items ? <p role="status">正在读取建议…</p> : !items.length ? <p>暂无经验建议。</p> : null}
      {items
        ?.filter((item) => item.status === 'pending')
        .map((item) => (
          <ProposalEditor
            key={item.id}
            proposal={item}
            client={props.client}
            onSaved={(accepted) => {
              setRevision((value) => value + 1);
              if (accepted) props.onAccepted();
            }}
          />
        ))}
      {items?.some((item) => item.status !== 'pending') ? (
        <details>
          <summary>已审查的建议</summary>
          {items
            .filter((item) => item.status !== 'pending')
            .map((item) => (
              <p key={item.id}>
                {item.topic} · {item.status === 'accepted' ? '已接纳' : '未接纳'}
              </p>
            ))}
        </details>
      ) : null}
    </section>
  );
}

/** 单条建议显式保存；并发变化与服务错误保留当前修改。 */
function ProposalEditor(props: { proposal: EmployeeMemoryProposal; client: DigitalEmployeeApiClient; onSaved(accepted: boolean): void }) {
  /** 可修改文本与原建议分开。 */
  const [topic, setTopic] = useState(props.proposal.topic);
  /** 候选正文在接受前允许纠正。 */
  const [content, setContent] = useState(props.proposal.content);
  /** 默认三个月复核，可按知识稳定性调整。 */
  const [reviewAfter, setReviewAfter] = useState(() => new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10));
  /** 同步锁防止重复接纳。 */
  const pending = useRef(false);
  /** 写入状态与错误保持在本条建议旁。 */
  const [busy, setBusy] = useState(false);
  /** 原建议来源始终可阅读。 */
  const [error, setError] = useState<string | null>(null);
  /** 拒绝只改变候选状态；接纳才保存确认的个人经验。 */
  async function decide(accept: boolean): Promise<void> {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      await props.client.decideEmployeeMemoryProposal(props.proposal, { accept, topic, content, reviewAfter: `${reviewAfter}T23:59:59.000Z` });
      props.onSaved(accept);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '处理建议失败。');
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <details className="employee-memory-proposal">
      <summary>{props.proposal.topic}</summary>
      <p>{props.proposal.reason}</p>
      <fieldset disabled={busy}>
        <label>
          经验主题
          <input value={topic} maxLength={160} onChange={(event) => setTopic(event.target.value)} />
        </label>
        <label>
          可复用内容
          <textarea rows={5} value={content} maxLength={8000} onChange={(event) => setContent(event.target.value)} />
        </label>
        <label>
          复核日期
          <input type="date" value={reviewAfter} onChange={(event) => setReviewAfter(event.target.value)} />
        </label>
      </fieldset>
      <details>
        <summary>原建议与来源</summary>
        <p>{props.proposal.content}</p>
        <small>
          任务 {props.proposal.taskId} · 工作运行 {props.proposal.runId} · {props.proposal.createdAt}
        </small>
      </details>
      {error ? <p role="alert">{error}</p> : null}
      <footer>
        <Button size="compact" disabled={busy || !topic.trim() || !content.trim() || !reviewAfter} onClick={() => void decide(true)}>
          接纳为个人经验
        </Button>
        <Button size="compact" variant="secondary" disabled={busy} onClick={() => void decide(false)}>
          不接纳
        </Button>
      </footer>
    </details>
  );
}
