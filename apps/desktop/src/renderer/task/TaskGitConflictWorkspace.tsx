import { ArrowLeftIcon as ArrowLeft } from '@phosphor-icons/react/dist/csr/ArrowLeft';
import { ArrowRightIcon as ArrowRight } from '@phosphor-icons/react/dist/csr/ArrowRight';
import { CheckCircleIcon as CheckCircle } from '@phosphor-icons/react/dist/csr/CheckCircle';
import { MagicWandIcon as MagicWand } from '@phosphor-icons/react/dist/csr/MagicWand';
import { XIcon as X } from '@phosphor-icons/react/dist/csr/X';
import { useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { TaskIntegrationConflictPermissionMode, TaskIntegrationRecord } from '../session/sessionTypes.js';
import { Button } from '../ui/Button.js';
import { ModalPortal } from '../ui/ModalPortal.js';
import { readConversationRuntimePreferences, writeConversationRuntimePreferences } from '../session/conversationRuntimePreferences.js';
import {
  applyConflictDocumentEdit,
  applyConflictSideAction,
  countUnresolvedConflictBlocks,
  type ConflictBlock,
  type ConflictDocument,
  type ConflictSide,
  type ConflictSideState,
  type SimpleConflictFailureReason,
  resolveSimpleConflictDocument,
  serializeConflictForAi,
} from './taskConflictModel.js';

type LineKind = 'added' | 'modified' | 'conflict';

interface CodeSnippet {
  text: string;
  startOffset: number;
  endOffset: number;
  startLine: number;
  conflictStartLine: number;
  conflictEndLine: number;
}

const slashCommentSyntaxPattern = buildSyntaxPattern('//.*$|/\\*.*?\\*/');
const hashCommentSyntaxPattern = buildSyntaxPattern('#.*$');

export { countConflictBlocks, resolveSimpleConflictDraft } from './taskConflictModel.js';

export function TaskGitConflictWorkspace(props: {
  zh: boolean;
  busy: boolean;
  aiBusy: boolean;
  integration: TaskIntegrationRecord;
  taskBranch: string;
  conflictPath: string;
  conflict: ConflictDocument | null;
  onSelectPath: (path: string) => void;
  onDocumentChange: (document: ConflictDocument) => void;
  onAskAi: (content: string, permissionMode: TaskIntegrationConflictPermissionMode) => Promise<void>;
}) {
  const document = props.conflict;
  const blocks = document?.blocks ?? [];
  const unresolvedCount = countUnresolvedConflictBlocks(document);
  const [selectedBlockIndex, setSelectedBlockIndex] = useState(0);
  const [viewMode, setViewMode] = useState<'focused' | 'full'>('focused');
  const [mergeFeedback, setMergeFeedback] = useState<string | null>(null);
  const [undoDraft, setUndoDraft] = useState<ConflictDocument | null>(null);
  const [aiPermissionOpen, setAiPermissionOpen] = useState(false);
  const [aiPermissionMode, setAiPermissionMode] = useState<TaskIntegrationConflictPermissionMode>(() => {
    const remembered = readConversationRuntimePreferences(browserStorage(), props.integration.projectId, 'conflict_resolution')?.permissionMode;
    return remembered === 'full-access' ? 'full-access' : 'auto';
  });
  const aiPermissionDialogRef = useRef<HTMLElement | null>(null);
  const currentFileResolved = document !== null && unresolvedCount === 0;
  const selectedBlock = blocks[Math.min(selectedBlockIndex, Math.max(0, blocks.length - 1))] ?? null;
  const activeBlock = currentFileResolved ? null : selectedBlock;
  const deferredDocument = useDeferredValue(document);
  const simpleResolution = useMemo(() => (deferredDocument ? resolveSimpleConflictDocument(deferredDocument) : null), [deferredDocument]);
  const simpleResolutionReady = deferredDocument === document;
  const simpleFailureText = simpleResolutionReady && simpleResolution && simpleResolution.resolved === 0 && unresolvedCount > 0 ? simpleConflictFailureText(simpleResolution.failureReasons, props.zh) : null;

  useEffect(() => {
    setMergeFeedback(null);
    setSelectedBlockIndex(0);
    setViewMode('focused');
    setUndoDraft(null);
    setAiPermissionOpen(false);
  }, [props.conflictPath, document?.fingerprint]);

  useEffect(() => {
    const current = readConversationRuntimePreferences(browserStorage(), props.integration.projectId, 'conflict_resolution');
    writeConversationRuntimePreferences(browserStorage(), props.integration.projectId, 'conflict_resolution', {
      ...(current ?? {}),
      serviceTier: current?.serviceTier ?? { type: 'standard' },
      permissionMode: aiPermissionMode,
      collaborationMode: current?.collaborationMode ?? 'default',
    });
  }, [aiPermissionMode, props.integration.projectId]);

  useEffect(() => {
    if (selectedBlockIndex >= blocks.length && blocks.length > 0) setSelectedBlockIndex(blocks.length - 1);
  }, [blocks.length, selectedBlockIndex]);

  useEffect(() => {
    if (!aiPermissionOpen) return;
    aiPermissionDialogRef.current?.querySelector<HTMLInputElement>('input:checked')?.focus();
  }, [aiPermissionOpen]);

  function selectNextPending(next: ConflictDocument, currentBlockId?: string): void {
    const currentIndex = currentBlockId ? next.blocks.findIndex((block) => block.id === currentBlockId) : -1;
    const nextIndex = next.blocks.findIndex((block, index) => block.status === 'pending' && index > currentIndex);
    const fallbackIndex = next.blocks.findIndex((block) => block.status === 'pending');
    const targetIndex = nextIndex >= 0 ? nextIndex : fallbackIndex;
    if (targetIndex >= 0) setSelectedBlockIndex(targetIndex);
  }

  function updateDocument(next: ConflictDocument, feedback?: string, advanceFromBlockId?: string): void {
    if (!document || next === document) return;
    setUndoDraft(document);
    props.onDocumentChange(next);
    if (feedback) setMergeFeedback(feedback);
    if (advanceFromBlockId) selectNextPending(next, advanceFromBlockId);
  }

  function chooseSide(block: ConflictBlock, side: ConflictSide, action: Exclude<ConflictSideState, 'pending'>): void {
    if (!document) return;
    const next = applyConflictSideAction(document, block.id, side, action);
    const blockNumber = blocks.indexOf(block) + 1;
    const nextBlock = next.blocks.find((candidate) => candidate.id === block.id);
    const feedback = nextBlock?.combinationError
      ? props.zh
        ? `冲突 ${blockNumber} 的两侧修改重叠，未自动覆盖中间内容，请直接编辑中间区域。`
        : `Conflict ${blockNumber} has overlapping edits. The center was kept unchanged; edit it manually.`
      : props.zh
        ? `已${action === 'accepted' ? '选入' : '忽略'}${side === 'source' ? '来源分支' : '任务分支'}，保存前不会写入文件。`
        : `${action === 'accepted' ? 'Accepted' : 'Ignored'} the ${side === 'source' ? 'source' : 'task'} side. The file is unchanged until you save.`;
    updateDocument(next, feedback, nextBlock?.status === 'pending' ? undefined : block.id);
  }

  function mergeSimpleConflicts(): void {
    if (!document || !simpleResolutionReady || !simpleResolution || simpleResolution.resolved === 0) return;
    const result = simpleResolution;
    if (result.resolved > 0) props.onDocumentChange(result.document);
    if (result.resolved > 0) setUndoDraft(document);
    if (result.resolved > 0) selectNextPending(result.document);
    setMergeFeedback(
      props.zh
        ? result.resolved > 0
          ? `已自动合并 ${result.resolved} 个简单冲突，剩余 ${result.remaining} 个需要人工确认。`
          : `当前文件没有可确定自动合并的简单冲突，${result.remaining} 个冲突仍需人工确认。`
        : result.resolved > 0
          ? `Merged ${result.resolved} simple conflict(s); ${result.remaining} still need review.`
          : `No simple conflicts could be merged safely; ${result.remaining} still need review.`,
    );
  }

  async function askAi(): Promise<void> {
    if (!document) return;
    try {
      await props.onAskAi(serializeConflictForAi(document), aiPermissionMode);
      setAiPermissionOpen(false);
    } catch {
      // 具体失败原因由代码交付弹窗统一展示，避免在两个状态区重复报错。
    }
  }

  function editDocument(content: string): void {
    if (!document) return;
    const next = applyConflictDocumentEdit(document, content);
    if (next === document) return;
    setUndoDraft(document);
    props.onDocumentChange(next);
    if (activeBlock) selectNextPending(next, activeBlock.id);
    const manualCount = next.blocks.filter((block) => block.status === 'manual').length;
    setMergeFeedback(props.zh ? `中间编辑已记录，${manualCount} 个冲突块按手工结果处理，保存前不会写入文件。` : `The center edit is recorded. ${manualCount} conflict block(s) are now manual; the file is unchanged until you save.`);
  }

  function undoLastDraft(): void {
    if (!undoDraft) return;
    props.onDocumentChange(undoDraft);
    setUndoDraft(null);
    setMergeFeedback(props.zh ? '已撤销上一次冲突草稿操作。' : 'The last conflict draft action was undone.');
  }

  const noMarkerWarning = document?.visibleContent.match(/^(?:<<<<<<<|=======|>>>>>>>)/mu)
    ? props.zh
      ? '中间结果仍包含冲突标记，请手工清理后再保存。'
      : 'The center still contains a conflict marker. Remove it manually before saving.'
    : null;

  return (
    <div className="task-git-conflict-layout">
      <aside className="task-git-conflict-files">
        <strong>
          {props.zh ? '冲突文件' : 'Conflicted files'} <small>{props.integration.conflictFiles.length}</small>
        </strong>
        {props.integration.conflictFiles.map((path) => (
          <button key={path} type="button" className={path === props.conflictPath ? 'is-active' : ''} onClick={() => props.onSelectPath(path)}>
            {path}
          </button>
        ))}
      </aside>
      <main className="task-git-conflict-editor">
        <div className="task-git-conflict-toolbar">
          <span>
            <strong>{props.conflictPath}</strong>
            <small>{props.zh ? `左：${props.integration.targetBranch} · 中：可编辑结果 · 右：${props.taskBranch}` : `Left: ${props.integration.targetBranch} · Center: editable result · Right: ${props.taskBranch}`}</small>
          </span>
          <span>
            {mergeFeedback || noMarkerWarning || simpleFailureText ? (
              <small className={`task-git-conflict-feedback${noMarkerWarning ? ' is-warning' : ''}`} role="status">
                {noMarkerWarning ?? mergeFeedback ?? simpleFailureText}
              </small>
            ) : null}
            <Button variant="secondary" size="compact" onClick={undoLastDraft} disabled={props.busy || undoDraft === null}>
              {props.zh ? '撤销' : 'Undo'}
            </Button>
            <Button variant="secondary" size="compact" onClick={() => setViewMode((current) => (current === 'focused' ? 'full' : 'focused'))} disabled={!document}>
              {viewMode === 'focused' ? (props.zh ? '查看完整文件' : 'View full file') : props.zh ? '返回冲突' : 'Back to conflict'}
            </Button>
            <Button
              variant="secondary"
              size="compact"
              busy={props.aiBusy}
              onClick={() => setAiPermissionOpen(true)}
              disabled={!document || props.busy || unresolvedCount === 0}
              title={
                props.zh
                  ? `打开会话，由 AI 处理全部冲突、生成合入提交并完成合入来源分支 ${props.integration.targetBranch}；不会推送远端`
                  : `Open a conversation and let AI resolve every conflict, create the merge commit, and complete the local merge into source branch ${props.integration.targetBranch}; no remote push`
              }
            >
              {props.zh ? 'AI 处理' : 'Resolve with AI'}
            </Button>
            <Button
              variant="secondary"
              size="compact"
              className="task-git-conflict-magic"
              onClick={mergeSimpleConflicts}
              disabled={!document || props.busy || unresolvedCount === 0 || !simpleResolutionReady || !simpleResolution || simpleResolution.resolved === 0}
              title={
                !simpleResolutionReady
                  ? props.zh
                    ? '正在分析当前草稿中的简单冲突'
                    : 'Checking the current draft for simple conflicts'
                  : simpleResolution && simpleResolution.resolved > 0
                    ? props.zh
                      ? `可安全自动合并 ${simpleResolution.resolved} 个简单冲突`
                      : `Safely merge ${simpleResolution.resolved} simple conflict(s)`
                    : (simpleFailureText ?? (props.zh ? '当前没有可安全自动合并的冲突，请手工编辑或使用 AI 处理' : 'No conflict can be merged safely. Edit manually or use AI.'))
              }
              aria-label={props.zh ? '自动合并简单冲突' : 'Resolve simple conflicts'}
            >
              <MagicWand aria-hidden="true" weight="regular" />
              <span>
                {!simpleResolutionReady
                  ? props.zh
                    ? '正在分析…'
                    : 'Checking…'
                  : simpleResolution && simpleResolution.resolved > 0
                    ? props.zh
                      ? `合并 ${simpleResolution.resolved} 个简单冲突`
                      : `Resolve ${simpleResolution.resolved} simple conflict(s)`
                    : props.zh
                      ? '无可自动合并项'
                      : 'No safe auto-merge'}
              </span>
            </Button>
          </span>
        </div>

        {aiPermissionOpen ? (
          <ModalPortal rootClassName="task-git-conflict-ai-permission-portal-root" backdropClassName="task-git-conflict-ai-permission-backdrop" onDismiss={() => (props.aiBusy ? undefined : setAiPermissionOpen(false))}>
            <section
              ref={aiPermissionDialogRef}
              className="task-git-conflict-ai-permission"
              role="dialog"
              aria-modal="true"
              aria-labelledby="task-git-conflict-ai-permission-title"
              onKeyDown={(event) => {
                if (event.key !== 'Escape' || props.aiBusy) return;
                event.preventDefault();
                setAiPermissionOpen(false);
              }}
            >
              <span>
                <strong id="task-git-conflict-ai-permission-title">{props.zh ? '选择本次冲突处理权限' : 'Choose conflict resolution permissions'}</strong>
                <small>
                  {props.zh
                    ? 'AI 需要修改、暂存并在 Zeus 隔离合并工作区生成合入提交。来源分支由 Zeus 复验后更新；该选择只用于本次冲突处理会话。'
                    : 'AI needs to edit, stage, and create the merge commit in the isolated Zeus integration worktree. Zeus updates the source branch after verification; this choice applies only to this conflict resolution conversation.'}
                </small>
              </span>
              <fieldset>
                <legend>{props.zh ? '权限模式' : 'Permission mode'}</legend>
                <label className={aiPermissionMode === 'auto' ? 'is-selected' : ''}>
                  <input type="radio" name="task-conflict-ai-permission" value="auto" checked={aiPermissionMode === 'auto'} onChange={() => setAiPermissionMode('auto')} disabled={props.aiBusy} />
                  <span>
                    <strong>{props.zh ? '自动（推荐）' : 'Auto (recommended)'}</strong>
                    <small>{props.zh ? '只写入隔离工作区，超出范围的操作仍需确认。' : 'Writes only inside the isolated worktree; out-of-scope actions still require approval.'}</small>
                  </span>
                </label>
                <label className={aiPermissionMode === 'full-access' ? 'is-selected' : ''}>
                  <input type="radio" name="task-conflict-ai-permission" value="full-access" checked={aiPermissionMode === 'full-access'} onChange={() => setAiPermissionMode('full-access')} disabled={props.aiBusy} />
                  <span>
                    <strong>{props.zh ? '完全访问' : 'Full access'}</strong>
                    <small>{props.zh ? '命令不再逐次请求确认，只应在你信任当前仓库时使用。' : 'Commands no longer request approval individually. Use only when you trust this repository.'}</small>
                  </span>
                </label>
              </fieldset>
              <footer>
                <Button variant="secondary" size="regular" onClick={() => setAiPermissionOpen(false)} disabled={props.aiBusy}>
                  {props.zh ? '取消' : 'Cancel'}
                </Button>
                <Button variant={aiPermissionMode === 'full-access' ? 'danger' : 'primary'} size="regular" busy={props.aiBusy} onClick={() => void askAi()}>
                  {props.zh ? `以${aiPermissionMode === 'auto' ? '自动' : '完全访问'}权限开始` : `Start with ${aiPermissionMode === 'auto' ? 'auto' : 'full access'}`}
                </Button>
              </footer>
            </section>
          </ModalPortal>
        ) : null}

        {!currentFileResolved ? (
          <nav className="task-git-conflict-block-rail" aria-label={props.zh ? '冲突块' : 'Conflict blocks'}>
            {blocks.map((block, index) => (
              <section key={block.id} className={`task-git-conflict-block-status is-${block.status}${index === selectedBlockIndex ? ' is-active' : ''}`} aria-label={props.zh ? `冲突 ${index + 1}` : `Conflict ${index + 1}`}>
                <button type="button" className="task-git-conflict-block-location" onClick={() => setSelectedBlockIndex(index)}>
                  {props.zh ? `冲突 ${index + 1} · 第 ${block.startLine} 行` : `Conflict ${index + 1} · line ${block.startLine}`}
                </button>
                <span className="task-git-conflict-block-state">{conflictStatusLabel(block.status, props.zh)}</span>
                {block.combinationError ? <small>{props.zh ? '重叠修改需手工处理' : 'Overlapping edits need manual review'}</small> : null}
              </section>
            ))}
          </nav>
        ) : (
          <p className="task-git-conflict-resolved" role="status">
            {props.zh ? '当前文件冲突已处理，但尚未保存。请检查中间结果后保存该文件并继续。' : 'Conflicts in this file are processed but not saved. Review the result, then save this file to continue.'}
          </p>
        )}

        {viewMode === 'full' ? (
          <FullFileColumns
            path={props.conflictPath}
            document={document}
            disabled={!document || props.busy}
            targetTitle={props.zh ? '来源分支' : 'Source branch'}
            resultTitle={props.zh ? '合并结果（可编辑）' : 'Merge result (editable)'}
            taskTitle={props.zh ? '任务分支' : 'Task branch'}
            initialBlock={activeBlock}
            onResultChange={editDocument}
            onSideAction={chooseSide}
          />
        ) : activeBlock && document ? (
          <FocusedConflictColumns
            path={props.conflictPath}
            document={document}
            block={activeBlock}
            disabled={props.busy}
            targetTitle={props.zh ? '来源分支（只读）' : 'Source branch (read-only)'}
            resultTitle={props.zh ? '合并结果（可编辑）' : 'Merge result (editable)'}
            taskTitle={props.zh ? '任务分支（只读）' : 'Task branch (read-only)'}
            onResultChange={editDocument}
            onSideAction={chooseSide}
          />
        ) : (
          <div className="task-git-conflict-review-complete" role="status">
            <CheckCircle aria-hidden="true" weight="fill" />
            <strong>{props.zh ? '当前文件冲突已全部处理' : 'All conflicts in this file are processed'}</strong>
            <span>{props.zh ? '结果仍是未保存的草稿。可先查看完整文件，确认后点击下方“保存该文件并继续”。' : 'The result is still an unsaved draft. Review the full file, then choose “Save file and continue” below.'}</span>
            <Button variant="secondary" size="compact" onClick={() => setViewMode('full')} disabled={!document || props.busy}>
              {props.zh ? '查看完整文件' : 'View full file'}
            </Button>
          </div>
        )}
      </main>
    </div>
  );
}

function browserStorage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

function simpleConflictFailureText(reasons: Partial<Record<SimpleConflictFailureReason, number>>, zh: boolean): string {
  const labels: Array<[SimpleConflictFailureReason, string, string]> = [
    ['same_position_insertions', '同一位置新增内容的先后顺序不确定', 'different insertions at the same position have no certain order'],
    ['overlapping_changes', '两侧修改范围重叠', 'changes from both sides overlap'],
    ['base_unavailable', '共同基线不可用', 'the common base is unavailable'],
    ['content_too_large', '内容超过安全分析上限', 'the content exceeds the safe analysis limit'],
  ];
  const details = labels.filter(([reason]) => (reasons[reason] ?? 0) > 0).map(([, chinese, english]) => (zh ? chinese : english));
  if (details.length === 0) return zh ? '当前修改无法确定安全的自动合并结果，请人工确认。' : 'No deterministic safe merge was found; manual review is required.';
  return zh ? `魔法棒未处理：${details.join('；')}，需要人工确认。` : `Magic merge skipped this conflict: ${details.join('; ')}. Manual review is required.`;
}

function FocusedConflictColumns(props: {
  path: string;
  document: ConflictDocument;
  block: ConflictBlock;
  disabled: boolean;
  targetTitle: string;
  resultTitle: string;
  taskTitle: string;
  onResultChange: (content: string) => void;
  onSideAction: (block: ConflictBlock, side: ConflictSide, action: Exclude<ConflictSideState, 'pending'>) => void;
}) {
  const sourceSnippet = useMemo(() => buildSideSnippet(props.document.source, props.block, 'source'), [props.document.source, props.block]);
  const taskSnippet = useMemo(() => buildSideSnippet(props.document.task, props.block, 'task'), [props.document.task, props.block]);
  const resultSnippet = useMemo(() => buildOffsetSnippet(props.document.visibleContent, props.block.visibleStart, props.block.visibleEnd), [props.document.visibleContent, props.block.visibleStart, props.block.visibleEnd]);
  const sourceRef = useRef<HTMLPreElement>(null);
  const resultRef = useRef<HTMLTextAreaElement>(null);
  const taskRef = useRef<HTMLPreElement>(null);

  function syncScroll(source: HTMLElement): void {
    for (const pane of [sourceRef.current, resultRef.current, taskRef.current]) {
      if (!pane || pane === source) continue;
      if (Math.abs(pane.scrollTop - source.scrollTop) > 1) pane.scrollTop = source.scrollTop;
      if (Math.abs(pane.scrollLeft - source.scrollLeft) > 1) pane.scrollLeft = source.scrollLeft;
    }
  }

  return (
    <div className="task-git-conflict-columns is-focused">
      <FocusedSidePane
        paneRef={sourceRef}
        title={props.targetTitle}
        path={props.path}
        snippet={sourceSnippet}
        side="source"
        state={props.block.sourceState}
        disabled={props.disabled}
        onScroll={syncScroll}
        onAction={(action) => props.onSideAction(props.block, 'source', action)}
      />
      <FocusedResultEditor
        textareaRef={resultRef}
        title={props.resultTitle}
        path={props.path}
        snippet={resultSnippet}
        disabled={props.disabled}
        onScroll={syncScroll}
        onChange={(content) => props.onResultChange(`${props.document.visibleContent.slice(0, resultSnippet.startOffset)}${content}${props.document.visibleContent.slice(resultSnippet.endOffset)}`)}
      />
      <FocusedSidePane
        paneRef={taskRef}
        title={props.taskTitle}
        path={props.path}
        snippet={taskSnippet}
        side="task"
        state={props.block.taskState}
        disabled={props.disabled}
        onScroll={syncScroll}
        onAction={(action) => props.onSideAction(props.block, 'task', action)}
      />
    </div>
  );
}

function FocusedSidePane(props: {
  paneRef: RefObject<HTMLPreElement | null>;
  title: string;
  path: string;
  snippet: CodeSnippet;
  side: ConflictSide;
  state: ConflictSideState;
  disabled: boolean;
  onAction: (action: Exclude<ConflictSideState, 'pending'>) => void;
  onScroll: (source: HTMLElement) => void;
}) {
  const lineKinds = useMemo(() => conflictLineKinds(props.snippet), [props.snippet]);
  const pointsRight = props.side === 'source';
  return (
    <section className={`task-git-conflict-code-pane task-git-conflict-side-pane is-${props.state}`}>
      <header className="task-git-conflict-pane-header">
        <strong>{props.title}</strong>
        <span className="task-git-conflict-side-actions">
          <button type="button" className="task-git-conflict-accept" onClick={() => props.onAction('accepted')} disabled={props.disabled} aria-label={`${props.title}: 选入`} title="选入">
            {pointsRight ? <ArrowRight aria-hidden="true" /> : <ArrowLeft aria-hidden="true" />}
            <span>选入</span>
          </button>
          <button type="button" className="task-git-conflict-ignore" onClick={() => props.onAction('ignored')} disabled={props.disabled} aria-label={`${props.title}: 忽略`} title="忽略这一侧">
            <X aria-hidden="true" />
          </button>
        </span>
      </header>
      <small className="task-git-conflict-side-state">{sideStateLabel(props.state)}</small>
      <pre ref={props.paneRef} className="task-git-highlighted-code" onScroll={(event) => props.onScroll(event.currentTarget)}>
        {renderCodeLines(props.snippet.text, props.path, lineKinds, props.snippet.startLine - 1)}
      </pre>
    </section>
  );
}

function FocusedResultEditor(props: {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  title: string;
  path: string;
  snippet: CodeSnippet;
  disabled: boolean;
  onChange: (content: string) => void;
  onScroll: (source: HTMLElement) => void;
}) {
  const highlightRef = useRef<HTMLPreElement>(null);
  const lineKinds = useMemo(() => conflictLineKinds(props.snippet), [props.snippet]);

  function syncScroll(): void {
    if (!props.textareaRef.current || !highlightRef.current) return;
    highlightRef.current.scrollTop = props.textareaRef.current.scrollTop;
    highlightRef.current.scrollLeft = props.textareaRef.current.scrollLeft;
    props.onScroll(props.textareaRef.current);
  }

  return (
    <label className="task-git-conflict-result-pane">
      <strong>{props.title}</strong>
      <span className="task-git-conflict-edit-surface">
        <pre ref={highlightRef} className="task-git-highlighted-code" aria-hidden="true">
          {renderCodeLines(props.snippet.text, props.path, lineKinds, props.snippet.startLine - 1)}
        </pre>
        <textarea ref={props.textareaRef} value={props.snippet.text} onChange={(event) => props.onChange(event.target.value)} onScroll={syncScroll} disabled={props.disabled} spellCheck={false} aria-label={props.title} />
      </span>
    </label>
  );
}

function FullFileColumns(props: {
  path: string;
  document: ConflictDocument | null;
  disabled: boolean;
  targetTitle: string;
  resultTitle: string;
  taskTitle: string;
  initialBlock: ConflictBlock | null;
  onResultChange: (content: string) => void;
  onSideAction: (block: ConflictBlock, side: ConflictSide, action: Exclude<ConflictSideState, 'pending'>) => void;
}) {
  const sourceRef = useRef<HTMLTextAreaElement>(null);
  const resultRef = useRef<HTMLTextAreaElement>(null);
  const taskRef = useRef<HTMLTextAreaElement>(null);
  const documentRef = useRef(props.document);
  documentRef.current = props.document;

  useEffect(() => {
    // 只在进入文件或切换冲突块时定位；受控文本每次输入都不应重置用户滚动位置。
    const currentDocument = documentRef.current;
    const top = Math.max(0, ((props.initialBlock ? countNewlines(currentDocument?.visibleContent.slice(0, props.initialBlock.visibleStart) ?? '') : 0) - 4) * 18.6);
    for (const pane of [sourceRef.current, resultRef.current, taskRef.current]) if (pane) pane.scrollTop = top;
  }, [props.path, props.initialBlock?.id]);

  function syncScroll(source: HTMLTextAreaElement): void {
    for (const pane of [sourceRef.current, resultRef.current, taskRef.current]) {
      if (!pane || pane === source) continue;
      if (Math.abs(pane.scrollTop - source.scrollTop) > 1) pane.scrollTop = source.scrollTop;
      if (Math.abs(pane.scrollLeft - source.scrollLeft) > 1) pane.scrollLeft = source.scrollLeft;
    }
  }

  if (!props.document) return <div className="task-git-conflict-columns is-full" />;
  return (
    <div className="task-git-conflict-columns is-full">
      <FullFilePane textareaRef={sourceRef} title={props.targetTitle} content={props.document.source} readOnly onScroll={syncScroll} />
      <FullFilePane
        textareaRef={resultRef}
        title={props.resultTitle}
        content={props.document.visibleContent}
        readOnly={props.disabled}
        onChange={props.onResultChange}
        onScroll={syncScroll}
        blocks={props.document.blocks}
        onSideAction={props.onSideAction}
      />
      <FullFilePane textareaRef={taskRef} title={props.taskTitle} content={props.document.task} readOnly onScroll={syncScroll} />
    </div>
  );
}

function FullFilePane(props: {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  title: string;
  content: string;
  readOnly: boolean;
  blocks?: ConflictBlock[];
  onChange?: (content: string) => void;
  onSideAction?: (block: ConflictBlock, side: ConflictSide, action: Exclude<ConflictSideState, 'pending'>) => void;
  onScroll: (source: HTMLTextAreaElement) => void;
}) {
  const [scrollTop, setScrollTop] = useState(0);
  return (
    <section className={`task-git-conflict-code-pane task-git-conflict-full-pane${props.blocks ? ' is-result' : ''}`}>
      <strong>{props.title}</strong>
      <span className="task-git-conflict-full-editor-surface">
        <textarea
          ref={props.textareaRef}
          value={props.content}
          readOnly={props.readOnly}
          onChange={props.onChange ? (event) => props.onChange?.(event.target.value) : undefined}
          onScroll={(event) => {
            props.onScroll(event.currentTarget);
            if (props.blocks) setScrollTop(event.currentTarget.scrollTop);
          }}
          spellCheck={false}
          aria-label={props.title}
        />
        {props.blocks && props.onSideAction ? (
          <div className="task-git-conflict-full-controls" aria-label="冲突块处理控制">
            {props.blocks.map((block) => {
              const top = countNewlines(props.content.slice(0, block.visibleStart)) * 18.6 - scrollTop;
              return (
                <span key={block.id} className={`task-git-conflict-full-control is-${block.status}`} style={{ top }}>
                  <button type="button" onClick={() => props.onSideAction?.(block, 'source', 'accepted')} disabled={props.readOnly} aria-label="选入来源分支" title="选入来源分支">
                    <ArrowRight aria-hidden="true" />
                  </button>
                  <button type="button" onClick={() => props.onSideAction?.(block, 'source', 'ignored')} disabled={props.readOnly} aria-label="忽略来源分支" title="忽略来源分支">
                    <X aria-hidden="true" />
                  </button>
                  <button type="button" onClick={() => props.onSideAction?.(block, 'task', 'ignored')} disabled={props.readOnly} aria-label="忽略任务分支" title="忽略任务分支">
                    <X aria-hidden="true" />
                  </button>
                  <button type="button" onClick={() => props.onSideAction?.(block, 'task', 'accepted')} disabled={props.readOnly} aria-label="选入任务分支" title="选入任务分支">
                    <ArrowLeft aria-hidden="true" />
                  </button>
                </span>
              );
            })}
          </div>
        ) : null}
      </span>
    </section>
  );
}

function buildOffsetSnippet(content: string, conflictStart: number, conflictEnd: number, contextLines = 7): CodeSnippet {
  let startOffset = Math.max(0, Math.min(conflictStart, content.length));
  let endOffset = Math.max(startOffset, Math.min(conflictEnd, content.length));
  for (let index = 0; index < contextLines && startOffset > 0; index += 1) {
    const previousLine = content.lastIndexOf('\n', Math.max(0, startOffset - 2));
    startOffset = previousLine < 0 ? 0 : previousLine + 1;
  }
  for (let index = 0; index < contextLines && endOffset < content.length; index += 1) {
    const nextLine = content.indexOf('\n', endOffset);
    endOffset = nextLine < 0 ? content.length : nextLine + 1;
  }
  const conflictStartLine = countNewlines(content.slice(startOffset, conflictStart));
  const conflictLineCount = Math.max(1, countNewlines(content.slice(conflictStart, conflictEnd)) + 1);
  return {
    text: content.slice(startOffset, endOffset),
    startOffset,
    endOffset,
    startLine: countLines(content, startOffset),
    conflictStartLine,
    conflictEndLine: conflictStartLine + conflictLineCount,
  };
}

function buildSideSnippet(content: string, block: ConflictBlock, side: ConflictSide): CodeSnippet {
  const start = side === 'source' ? block.sourceStart : block.taskStart;
  const end = side === 'source' ? block.sourceEnd : block.taskEnd;
  if (start >= 0 && end >= start) return buildOffsetSnippet(content, start, end);
  const text = side === 'source' ? block.source : block.task;
  return { text, startOffset: 0, endOffset: text.length, startLine: block.startLine, conflictStartLine: 0, conflictEndLine: Math.max(1, countNewlines(text) + 1) };
}

function conflictLineKinds(snippet: CodeSnippet): Map<number, LineKind> {
  const kinds = new Map<number, LineKind>();
  for (let line = snippet.conflictStartLine; line < snippet.conflictEndLine; line += 1) kinds.set(line, 'conflict');
  return kinds;
}

function renderCodeLines(content: string, path: string, lineKinds: Map<number, LineKind>, lineNumberOffset = 0): ReactNode[] {
  const lines = normalizeLineEndings(content).split('\n');
  return lines.map((line, index) => (
    <span key={index} className="task-git-code-line" data-kind={lineKinds.get(index)}>
      <span className="task-git-code-line-number">{lineNumberOffset + index + 1}</span>
      <code>{highlightSyntax(line, path)}</code>
      {index < lines.length - 1 ? '\n' : null}
    </span>
  ));
}

function highlightSyntax(line: string, path: string): ReactNode[] {
  const extension = path.split('.').pop()?.toLowerCase() ?? '';
  const hashComment = ['py', 'rb', 'sh', 'bash', 'zsh', 'yaml', 'yml', 'toml'].includes(extension);
  const pattern = hashComment ? hashCommentSyntaxPattern : slashCommentSyntaxPattern;
  pattern.lastIndex = 0;
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line))) {
    if (match.index > cursor) nodes.push(line.slice(cursor, match.index));
    const className = match[1] ? 'is-comment' : match[2] ? 'is-string' : match[3] ? 'is-number' : match[4] ? 'is-keyword' : match[5] ? 'is-function' : 'is-tag';
    nodes.push(
      <span key={`${match.index}:${match[0]}`} className={`task-git-syntax-token ${className}`}>
        {match[0]}
      </span>,
    );
    cursor = pattern.lastIndex;
  }
  if (cursor < line.length) nodes.push(line.slice(cursor));
  return nodes;
}

function buildSyntaxPattern(comment: string): RegExp {
  return new RegExp(
    `(${comment}|<!--.*?-->)|("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|\`(?:\\\\.|[^\`\\\\])*\`)|(\\b(?:0x[\\da-f]+|\\d+(?:\\.\\d+)?)\\b)|(\\b(?:abstract|async|await|boolean|break|case|catch|class|const|def|default|delete|do|else|enum|export|extends|false|finally|for|from|function|if|implements|import|in|instanceof|interface|let|namespace|new|null|package|private|protected|public|return|static|string|super|switch|this|throw|true|try|type|typeof|undefined|var|void|while|with|yield)\\b)|(\\b[A-Za-z_$][\\w$]*(?=\\s*\\())|(<\\/?[A-Za-z][^>]*>)`,
    'giu',
  );
}

function normalizeLineEndings(content: string): string {
  return content.replace(/\r\n/gu, '\n');
}

function countLines(content: string, offset: number): number {
  return countNewlines(content.slice(0, offset)) + 1;
}

function countNewlines(content: string): number {
  return (content.match(/\n/gu) ?? []).length;
}

function conflictStatusLabel(status: ConflictBlock['status'], zh: boolean): string {
  if (status === 'manual') return zh ? '手工处理' : 'Manual';
  if (status === 'resolved') return zh ? '已处理' : 'Resolved';
  return zh ? '未处理' : 'Pending';
}

function sideStateLabel(state: ConflictSideState): string {
  if (state === 'accepted') return '已选入';
  if (state === 'ignored') return '已忽略';
  return '未处理';
}
