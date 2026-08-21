import { useMemo, useState } from 'react';
import type { MemoryApiClient } from './memoryApiClient.js';
import { memoryDisplayStatus, type MemoryCandidateInput, type MemoryEffect, type MemoryKind, type MemoryRecord, type MemoryScope } from './memoryContracts.js';
import { useMemoryFeatureController } from './useMemoryFeatureController.js';
import './memorySettingsPane.css';

type MemoryLanguage = 'zh-CN' | 'en-US';

export interface MemorySettingsProject {
  id: string;
  name: string;
}

interface MemoryDraft {
  memoryKey: string;
  candidateKind: MemoryKind;
  content: string;
  effect: MemoryEffect;
  confidence: string;
  reviewAfter: string;
  sourceReference: string;
  externalStateConfirmed: boolean;
}

export function MemorySettingsPane(props: { client: MemoryApiClient; language: MemoryLanguage; projects: readonly MemorySettingsProject[]; initialProjectId?: string | null }) {
  const zh = props.language === 'zh-CN';
  const [scopeKind, setScopeKind] = useState<MemoryScope['kind']>('global');
  const [projectId, setProjectId] = useState(() => props.initialProjectId ?? props.projects[0]?.id ?? '');
  const scope = useMemo<MemoryScope>(() => (scopeKind === 'global' ? { kind: 'global', id: '*' } : { kind: 'project', id: projectId }), [projectId, scopeKind]);
  const controller = useMemoryFeatureController({ client: props.client, scope });
  const [editor, setEditor] = useState<{ mode: 'create' } | { mode: 'supersede'; record: MemoryRecord } | null>(null);
  const [draft, setDraft] = useState<MemoryDraft>(() => emptyDraft());
  const [tombstoneTarget, setTombstoneTarget] = useState<MemoryRecord | null>(null);
  const [tombstoneReason, setTombstoneReason] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const busy = controller.snapshot.command !== 'idle';

  const openCreate = (): void => {
    setDraft(emptyDraft());
    setEditor({ mode: 'create' });
    setFormError(null);
  };
  const openSupersede = (record: MemoryRecord): void => {
    setDraft(draftFromRecord(record));
    setEditor({ mode: 'supersede', record });
    setFormError(null);
  };

  const submit = async (): Promise<void> => {
    if (!editor) return;
    try {
      const candidate = candidateFromDraft(draft, scope, zh);
      if (editor.mode === 'create') await controller.create(candidate);
      else {
        await controller.supersede(editor.record.id, {
          candidateKind: candidate.candidateKind,
          content: candidate.content,
          effect: candidate.effect,
          source: candidate.source,
          confirmationLevel: candidate.confirmationLevel,
          confidence: candidate.confidence,
          reviewAfter: candidate.reviewAfter,
        });
      }
      setEditor(null);
      setFormError(null);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    }
  };

  const tombstone = async (): Promise<void> => {
    if (!tombstoneTarget || !tombstoneReason.trim()) return;
    try {
      await controller.tombstone(tombstoneTarget.id, tombstoneReason.trim());
      setTombstoneTarget(null);
      setTombstoneReason('');
      setFormError(null);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <section className="memory-settings-pane" aria-label={zh ? '长期记忆管理' : 'Long-term memory management'}>
      <header className="memory-settings-header">
        <span>
          <h2>{zh ? '长期记忆' : 'Long-term memory'}</h2>
          <p>{zh ? '只管理稳定偏好、安全边界和工作流。不会从会话自动抽取任务事实或运行结果。' : 'Only stable preferences, safety boundaries, and workflows are managed. Conversations are never mined automatically.'}</p>
        </span>
        <button type="button" onClick={openCreate} disabled={busy || (scopeKind === 'project' && !projectId)}>
          {zh ? '显式新增' : 'Add explicitly'}
        </button>
      </header>

      <div className="memory-scope-controls" role="group" aria-label={zh ? '记忆范围' : 'Memory scope'}>
        <button type="button" aria-pressed={scopeKind === 'global'} onClick={() => setScopeKind('global')}>
          {zh ? '全局' : 'Global'}
        </button>
        <button type="button" aria-pressed={scopeKind === 'project'} disabled={props.projects.length === 0} onClick={() => setScopeKind('project')}>
          {zh ? '项目' : 'Project'}
        </button>
        {scopeKind === 'project' ? (
          <label>
            <span>{zh ? '项目' : 'Project'}</span>
            <select value={projectId} onChange={(event) => setProjectId(event.currentTarget.value)}>
              {props.projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <button type="button" onClick={() => void controller.reload()} disabled={controller.snapshot.phase === 'loading'}>
          {zh ? '刷新' : 'Refresh'}
        </button>
      </div>

      {editor ? (
        <MemoryEditor
          draft={draft}
          mode={editor.mode}
          lockedKey={editor.mode === 'supersede' ? editor.record.memoryKey : null}
          language={props.language}
          busy={busy}
          onChange={setDraft}
          onCancel={() => setEditor(null)}
          onSubmit={() => void submit()}
        />
      ) : null}

      {tombstoneTarget ? (
        <section className="memory-tombstone-confirmation" aria-label={zh ? '停用记忆确认' : 'Confirm memory deactivation'}>
          <strong>{zh ? `停用“${tombstoneTarget.memoryKey}”` : `Deactivate “${tombstoneTarget.memoryKey}”`}</strong>
          <p>{zh ? '删除采用 tombstone，审计链仍保留且不会再注入上下文。' : 'Deletion creates a tombstone: the audit chain remains, and the memory is no longer injected.'}</p>
          <label>
            <span>{zh ? '原因' : 'Reason'}</span>
            <input value={tombstoneReason} onChange={(event) => setTombstoneReason(event.currentTarget.value)} maxLength={2048} />
          </label>
          <span className="memory-inline-actions">
            <button type="button" onClick={() => setTombstoneTarget(null)} disabled={busy}>
              {zh ? '取消' : 'Cancel'}
            </button>
            <button type="button" className="is-danger" onClick={() => void tombstone()} disabled={busy || !tombstoneReason.trim()}>
              {zh ? '确认停用/删除' : 'Confirm deactivation'}
            </button>
          </span>
        </section>
      ) : null}

      {(formError ?? controller.snapshot.error) ? (
        <p className="memory-settings-error" role="alert">
          {formError ?? controller.snapshot.error}
        </p>
      ) : null}

      {controller.snapshot.phase === 'loading' ? <p role="status">{zh ? '正在读取记忆…' : 'Loading memories…'}</p> : null}
      {controller.snapshot.phase === 'ready' && controller.snapshot.items.length === 0 ? <p>{zh ? '当前范围还没有长期记忆。' : 'There are no long-term memories in this scope.'}</p> : null}
      <div className="memory-record-list">
        {controller.snapshot.items.map((record) => {
          const status = memoryDisplayStatus(record, controller.snapshot.items);
          return (
            <article key={record.id} className="memory-record" data-status={status}>
              <header>
                <span>
                  <strong>{record.memoryKey}</strong>
                  <small>{memoryStatusLabel(status, zh)}</small>
                </span>
                <span className="memory-record-actions">
                  <button type="button" disabled={busy || record.tombstone || status === 'superseded'} onClick={() => openSupersede(record)}>
                    {zh ? '修正' : 'Correct'}
                  </button>
                  <button type="button" disabled={busy || record.tombstone || status === 'superseded'} onClick={() => setTombstoneTarget(record)}>
                    {zh ? '停用/删除' : 'Deactivate'}
                  </button>
                </span>
              </header>
              <p>{record.content}</p>
              <dl>
                <div>
                  <dt>{zh ? '范围' : 'Scope'}</dt>
                  <dd>{record.scope.kind === 'global' ? (zh ? '全局' : 'Global') : record.scope.id}</dd>
                </div>
                <div>
                  <dt>{zh ? '类型' : 'Kind'}</dt>
                  <dd>{record.kind}</dd>
                </div>
                <div>
                  <dt>{zh ? '来源' : 'Source'}</dt>
                  <dd>
                    {record.source.kind} · {record.source.reference}
                  </dd>
                </div>
                <div>
                  <dt>{zh ? '确认' : 'Confirmation'}</dt>
                  <dd>{record.confirmationLevel}</dd>
                </div>
                <div>
                  <dt>{zh ? '置信度' : 'Confidence'}</dt>
                  <dd>{Math.round(record.confidence * 100)}%</dd>
                </div>
                <div>
                  <dt>{zh ? '复核日期' : 'Review after'}</dt>
                  <dd>{formatTimestamp(record.reviewAfter)}</dd>
                </div>
                {record.supersedesId ? (
                  <div>
                    <dt>supersedes</dt>
                    <dd>{record.supersedesId}</dd>
                  </div>
                ) : null}
                {record.tombstoneReason ? (
                  <div>
                    <dt>tombstone</dt>
                    <dd>{record.tombstoneReason}</dd>
                  </div>
                ) : null}
              </dl>
            </article>
          );
        })}
      </div>
      {controller.snapshot.nextCursor ? (
        <button type="button" className="memory-load-more" disabled={controller.snapshot.loadingMore} onClick={() => void controller.loadMore()}>
          {controller.snapshot.loadingMore ? (zh ? '正在读取…' : 'Loading…') : zh ? '加载更早记录' : 'Load older records'}
        </button>
      ) : null}
    </section>
  );
}

function MemoryEditor(props: { draft: MemoryDraft; mode: 'create' | 'supersede'; lockedKey: string | null; language: MemoryLanguage; busy: boolean; onChange: (draft: MemoryDraft) => void; onCancel: () => void; onSubmit: () => void }) {
  const zh = props.language === 'zh-CN';
  const patch = (next: Partial<MemoryDraft>): void => props.onChange({ ...props.draft, ...next });
  return (
    <section className="memory-editor" aria-label={props.mode === 'create' ? (zh ? '新增长期记忆' : 'Add long-term memory') : zh ? '修正长期记忆' : 'Correct long-term memory'}>
      <label>
        <span>{zh ? '稳定 key' : 'Stable key'}</span>
        <input value={props.lockedKey ?? props.draft.memoryKey} disabled={props.lockedKey !== null} maxLength={160} onChange={(event) => patch({ memoryKey: event.currentTarget.value })} />
      </label>
      <label>
        <span>{zh ? '类型' : 'Kind'}</span>
        <select value={props.draft.candidateKind} onChange={(event) => patch({ candidateKind: event.currentTarget.value as MemoryKind })}>
          <option value="preference">preference</option>
          <option value="safety_boundary">safety_boundary</option>
          <option value="stable_workflow">stable_workflow</option>
        </select>
      </label>
      <label className="memory-editor-content">
        <span>{zh ? '内容' : 'Content'}</span>
        <textarea value={props.draft.content} maxLength={16384} onChange={(event) => patch({ content: event.currentTarget.value })} />
      </label>
      <label>
        <span>{zh ? '影响' : 'Effect'}</span>
        <select value={props.draft.effect} onChange={(event) => patch({ effect: event.currentTarget.value as MemoryEffect, externalStateConfirmed: false })}>
          <option value="advisory">advisory</option>
          <option value="external_state">external_state</option>
        </select>
      </label>
      <label>
        <span>{zh ? '置信度（0–1）' : 'Confidence (0–1)'}</span>
        <input type="number" min="0" max="1" step="0.05" value={props.draft.confidence} onChange={(event) => patch({ confidence: event.currentTarget.value })} />
      </label>
      <label>
        <span>{zh ? '复核日期' : 'Review after'}</span>
        <input type="date" value={props.draft.reviewAfter} onChange={(event) => patch({ reviewAfter: event.currentTarget.value })} />
      </label>
      <label>
        <span>{zh ? '来源引用' : 'Source reference'}</span>
        <input value={props.draft.sourceReference} maxLength={2048} onChange={(event) => patch({ sourceReference: event.currentTarget.value })} />
      </label>
      {props.draft.effect === 'external_state' ? (
        <label className="memory-explicit-confirmation">
          <input type="checkbox" checked={props.draft.externalStateConfirmed} onChange={(event) => patch({ externalStateConfirmed: event.currentTarget.checked })} />
          <span>{zh ? '我明确确认：这条记忆可影响外部状态；将以 explicit + user_explicit 来源保存。' : 'I explicitly confirm that this memory may affect external state; it will be saved as explicit + user_explicit.'}</span>
        </label>
      ) : null}
      <span className="memory-inline-actions">
        <button type="button" onClick={props.onCancel} disabled={props.busy}>
          {zh ? '取消' : 'Cancel'}
        </button>
        <button type="button" onClick={props.onSubmit} disabled={props.busy || (props.draft.effect === 'external_state' && !props.draft.externalStateConfirmed)}>
          {props.mode === 'create' ? (zh ? '新增记忆' : 'Add memory') : zh ? '保存为新版本' : 'Save as new version'}
        </button>
      </span>
    </section>
  );
}

function candidateFromDraft(draft: MemoryDraft, scope: MemoryScope, zh: boolean): MemoryCandidateInput {
  const confidence = Number(draft.confidence);
  if (!draft.memoryKey.trim() || !draft.content.trim() || !draft.sourceReference.trim() || !draft.reviewAfter)
    throw new Error(zh ? 'key、内容、来源引用和复核日期均不能为空。' : 'Key, content, source reference, and review date are required.');
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error(zh ? '置信度必须位于 0 到 1。' : 'Confidence must be between 0 and 1.');
  if (draft.effect === 'external_state' && !draft.externalStateConfirmed) throw new Error(zh ? '影响外部状态的记忆必须经过 explicit 确认。' : 'External-state memory requires explicit confirmation.');
  return {
    memoryKey: draft.memoryKey.trim(),
    scope,
    candidateKind: draft.candidateKind,
    content: draft.content.trim(),
    effect: draft.effect,
    source: { kind: 'user_explicit', reference: draft.sourceReference.trim(), observedAt: new Date().toISOString() },
    confirmationLevel: 'explicit',
    confidence,
    reviewAfter: new Date(`${draft.reviewAfter}T23:59:59.999Z`).toISOString(),
  };
}

function emptyDraft(): MemoryDraft {
  const reviewDate = new Date();
  reviewDate.setUTCDate(reviewDate.getUTCDate() + 180);
  return {
    memoryKey: '',
    candidateKind: 'preference',
    content: '',
    effect: 'advisory',
    confidence: '1',
    reviewAfter: reviewDate.toISOString().slice(0, 10),
    sourceReference: 'Zeus Memory 管理页用户明确输入',
    externalStateConfirmed: false,
  };
}

function draftFromRecord(record: MemoryRecord): MemoryDraft {
  return {
    memoryKey: record.memoryKey,
    candidateKind: record.kind,
    content: record.content,
    effect: record.effect,
    confidence: String(record.confidence),
    reviewAfter: record.reviewAfter.slice(0, 10),
    sourceReference: `修正 ${record.id}`,
    externalStateConfirmed: false,
  };
}

function memoryStatusLabel(status: ReturnType<typeof memoryDisplayStatus>, zh: boolean): string {
  if (status === 'current') return zh ? '当前有效' : 'Current';
  if (status === 'review_due') return 'review_due';
  if (status === 'superseded') return 'superseded';
  return 'tombstone';
}

function formatTimestamp(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString();
}
