import { MotionPresence } from '../../ui/MotionPresence.js';
import { useMemo, useState } from 'react';
import type { MemoryApiClient } from './memoryApiClient.js';
import { memoryDisplayStatus, type MemoryCandidateInput, type MemoryEffect, type MemoryKind, type MemoryRecord, type MemoryScope } from './memoryContracts.js';
import { useMemoryFeatureController } from './useMemoryFeatureController.js';
import { reportApplicationError, VisibleApplicationError } from '../../ui/ApplicationErrorDialog.js';
import { ModalPortal } from '../../ui/ModalPortal.js';
import { Button } from '../../ui/Button.js';
import { ZeusSelect } from '../../ZeusSelect.js';
import { SettingsSaveStatus } from '../../settings/useSettingsAutosave.js';
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
  /** 只有写入完成才展示保存回执，打开新草稿时清除。 */
  const [saved, setSaved] = useState(false);
  const busy = controller.snapshot.command !== 'idle';

  const openCreate = (): void => {
    setSaved(false);
    setDraft(emptyDraft());
    setEditor({ mode: 'create' });
    setFormError(null);
  };
  const openSupersede = (record: MemoryRecord): void => {
    setSaved(false);
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
      setSaved(true);
    } catch (error) {
      setFormError(reportApplicationError(error, { language: zh ? 'zh-CN' : 'en' }));
    }
  };

  const tombstone = async (): Promise<void> => {
    if (!tombstoneTarget || !tombstoneReason.trim()) return;
    try {
      await controller.tombstone(tombstoneTarget.id, tombstoneReason.trim());
      setTombstoneTarget(null);
      setTombstoneReason('');
      setFormError(null);
      setSaved(true);
    } catch (error) {
      setFormError(reportApplicationError(error, { language: zh ? 'zh-CN' : 'en' }));
    }
  };

  return (
    <section className="memory-settings-pane" aria-label={zh ? '长期记忆管理' : 'Long-term memory management'}>
      <header className="memory-settings-header">
        <span>
          <h2>{zh ? '长期记忆' : 'Long-term memory'}</h2>
          <p>{zh ? '只管理稳定偏好、安全边界和工作流。不会从会话自动抽取任务事实或运行结果。' : 'Only stable preferences, safety boundaries, and workflows are managed. Conversations are never mined automatically.'}</p>
        </span>
        <div className="settings-heading-actions">
          <SettingsSaveStatus status={busy ? 'saving' : formError ? 'failed' : saved ? 'saved' : 'idle'} language={props.language} />
          <Button onClick={openCreate} disabled={busy || (scopeKind === 'project' && !projectId)}>
            {zh ? '新增记忆' : 'Add memory'}
          </Button>
        </div>
      </header>

      <div className="memory-scope-controls" role="group" aria-label={zh ? '记忆范围' : 'Memory scope'}>
        <button type="button" aria-pressed={scopeKind === 'global'} onClick={() => setScopeKind('global')}>
          {zh ? '全局' : 'Global'}
        </button>
        <button type="button" aria-pressed={scopeKind === 'project'} disabled={props.projects.length === 0} onClick={() => setScopeKind('project')}>
          {zh ? '项目' : 'Project'}
        </button>
        {scopeKind === 'project' ? (
          <ZeusSelect
            size="regular"
            className="memory-project-select"
            ariaLabel={zh ? '选择记忆项目' : 'Choose memory project'}
            value={projectId}
            onChange={setProjectId}
            options={props.projects.map((project) => ({ value: project.id, label: project.name }))}
          />
        ) : null}
        <button type="button" onClick={() => void controller.reload()} disabled={controller.snapshot.phase === 'loading'}>
          {zh ? '刷新' : 'Refresh'}
        </button>
      </div>

      <MotionPresence>
        {editor ? (
          <ModalPortal rootClassName="zeus-shell settings-editor-portal" dismissDisabled={busy} onDismiss={() => setEditor(null)}>
            <div className="settings-reference-shell">
              <section className="settings-editor-dialog settings-content-column" role="dialog" aria-modal="true" aria-labelledby="memory-editor-title">
                <header className="settings-page-heading">
                  <span>
                    <h2 id="memory-editor-title">{editor.mode === 'create' ? (zh ? '新增记忆' : 'Add memory') : zh ? '修正记忆' : 'Correct memory'}</h2>
                    <p>{scope.kind === 'global' ? (zh ? '全局记忆' : 'Global memory') : props.projects.find((project) => project.id === scope.id)?.name}</p>
                  </span>
                </header>
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
                {formError ? (
                  <p role="alert" className="settings-field-error">
                    {formError}
                  </p>
                ) : null}
              </section>
            </div>
          </ModalPortal>
        ) : null}
      </MotionPresence>

      {tombstoneTarget ? (
        <section className="memory-tombstone-confirmation" aria-label={zh ? '停用记忆确认' : 'Confirm memory deactivation'}>
          <strong>{zh ? `停用“${tombstoneTarget.memoryKey}”` : `Deactivate “${tombstoneTarget.memoryKey}”`}</strong>
          <p>{zh ? '停用后，AI 不再使用这条记忆，修改记录仍会保留。' : 'Once disabled, this memory will no longer be used by the AI. Its change history will remain.'}</p>
          <label>
            <span>{zh ? '原因' : 'Reason'}</span>
            <input value={tombstoneReason} onChange={(event) => setTombstoneReason(event.currentTarget.value)} maxLength={2048} />
          </label>
          <span className="memory-inline-actions">
            <button type="button" onClick={() => setTombstoneTarget(null)} disabled={busy}>
              {zh ? '取消' : 'Cancel'}
            </button>
            <button type="button" className="is-danger" onClick={() => void tombstone()} disabled={busy || !tombstoneReason.trim()}>
              {zh ? '确认停用' : 'Disable memory'}
            </button>
          </span>
        </section>
      ) : null}

      {!editor && (formError ?? controller.snapshot.error) ? (
        <p className="memory-settings-error" role="alert">
          {formError ?? <VisibleApplicationError error={controller.snapshot.errorCause ?? controller.snapshot.error} language={zh ? 'zh-CN' : 'en'} />}
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
                    {zh ? '停用' : 'Disable'}
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
                  <dd>{memoryValueLabel(record.kind, zh)}</dd>
                </div>
                <div>
                  <dt>{zh ? '来源' : 'Source'}</dt>
                  <dd>
                    {memoryValueLabel(record.source.kind, zh)} · {record.source.reference}
                  </dd>
                </div>
                <div>
                  <dt>{zh ? '确认' : 'Confirmation'}</dt>
                  <dd>{memoryValueLabel(record.confirmationLevel, zh)}</dd>
                </div>
                <div>
                  <dt>{zh ? '置信度' : 'Confidence'}</dt>
                  <dd>{Math.round(record.confidence * 100)}%</dd>
                </div>
                <div>
                  <dt>{zh ? '复核日期' : 'Review after'}</dt>
                  <dd>{formatTimestamp(record.reviewAfter, zh)}</dd>
                </div>
                {record.supersedesId ? (
                  <div>
                    <dt>{zh ? '替代记录' : 'Replaced record'}</dt>
                    <dd>{record.supersedesId}</dd>
                  </div>
                ) : null}
                {record.tombstoneReason ? (
                  <div>
                    <dt>{zh ? '停用原因' : 'Reason disabled'}</dt>
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

const memoryValueLabels: Record<string, [string, string]> = {
  preference: ['偏好', 'Preference'],
  safety_boundary: ['安全边界', 'Safety boundary'],
  stable_workflow: ['固定工作流程', 'Stable workflow'],
  advisory: ['仅提供建议', 'Advice only'],
  external_state: ['指导文件或应用操作', 'Guide file or app actions'],
  user_explicit: ['用户明确输入', 'Explicit user input'],
  project_instruction: ['项目说明', 'Project instruction'],
  repeated_confirmation: ['多次确认', 'Repeated confirmation'],
  manual_import: ['手动导入', 'Manual import'],
  observed: ['根据观察', 'Observed'],
  confirmed: ['已确认', 'Confirmed'],
  explicit: ['明确确认', 'Explicitly confirmed'],
};

function memoryValueLabel(value: string, zh: boolean): string {
  return memoryValueLabels[value]?.[zh ? 0 : 1] ?? value;
}

function MemoryEditor(props: { draft: MemoryDraft; mode: 'create' | 'supersede'; lockedKey: string | null; language: MemoryLanguage; busy: boolean; onChange: (draft: MemoryDraft) => void; onCancel: () => void; onSubmit: () => void }) {
  const zh = props.language === 'zh-CN';
  const patch = (next: Partial<MemoryDraft>): void => props.onChange({ ...props.draft, ...next });
  return (
    <fieldset disabled={props.busy} className="memory-editor" aria-label={props.mode === 'create' ? (zh ? '新增长期记忆' : 'Add long-term memory') : zh ? '修正长期记忆' : 'Correct long-term memory'}>
      <label>
        <span>{zh ? '记忆标识' : 'Memory identifier'}</span>
        <input value={props.lockedKey ?? props.draft.memoryKey} disabled={props.lockedKey !== null} maxLength={160} onChange={(event) => patch({ memoryKey: event.currentTarget.value })} />
      </label>
      <label>
        <span>{zh ? '类型' : 'Kind'}</span>
        <ZeusSelect
          size="regular"
          ariaLabel={zh ? '记忆类型' : 'Memory kind'}
          value={props.draft.candidateKind}
          onChange={(candidateKind) => patch({ candidateKind: candidateKind as MemoryKind })}
          options={['preference', 'safety_boundary', 'stable_workflow'].map((value) => ({ value, label: memoryValueLabel(value, zh) }))}
        />
      </label>
      <label className="memory-editor-content">
        <span>{zh ? '内容' : 'Content'}</span>
        <textarea value={props.draft.content} maxLength={16384} onChange={(event) => patch({ content: event.currentTarget.value })} />
      </label>
      <label>
        <span>{zh ? '影响' : 'Effect'}</span>
        <ZeusSelect
          size="regular"
          ariaLabel={zh ? '记忆影响' : 'Memory effect'}
          value={props.draft.effect}
          onChange={(effect) => patch({ effect: effect as MemoryEffect, externalStateConfirmed: false })}
          options={['advisory', 'external_state'].map((value) => ({ value, label: memoryValueLabel(value, zh) }))}
        />
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
          <span>{zh ? '我确认允许 AI 使用这条记忆指导可能修改文件或其他应用的操作。' : 'I allow the AI to use this memory to guide actions that may change files or other apps.'}</span>
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
    </fieldset>
  );
}

function candidateFromDraft(draft: MemoryDraft, scope: MemoryScope, zh: boolean): MemoryCandidateInput {
  const confidence = Number(draft.confidence);
  if (!draft.memoryKey.trim() || !draft.content.trim() || !draft.sourceReference.trim() || !draft.reviewAfter)
    throw new Error(zh ? '请填写记忆标识、内容、来源和复核日期。' : 'Enter the memory identifier, content, source, and review date.');
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error(zh ? '置信度必须位于 0 到 1。' : 'Confidence must be between 0 and 1.');
  if (draft.effect === 'external_state' && !draft.externalStateConfirmed)
    throw new Error(zh ? '这条记忆可能指导 AI 修改文件或其他应用，请先勾选确认。' : 'This memory may guide the AI to change files or other apps. Select the confirmation before saving.');
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
  if (status === 'review_due') return zh ? '待复核' : 'Review due';
  if (status === 'superseded') return zh ? '已被新版本替代' : 'Replaced by a newer version';
  return zh ? '已停用' : 'Disabled';
}

function formatTimestamp(value: string, zh: boolean): string {
  const parsed = new Date(value);
  // 复核日期按用户选择的 UTC 日历日保存，展示时不能再转换为本地时区的下一天。
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString(zh ? 'zh-CN' : 'en', { timeZone: 'UTC' });
}
