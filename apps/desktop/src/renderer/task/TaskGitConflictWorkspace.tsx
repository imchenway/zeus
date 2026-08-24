import { ArrowLeftIcon as ArrowLeft } from '@phosphor-icons/react/dist/csr/ArrowLeft';
import { ArrowRightIcon as ArrowRight } from '@phosphor-icons/react/dist/csr/ArrowRight';
import { CheckCircleIcon as CheckCircle } from '@phosphor-icons/react/dist/csr/CheckCircle';
import { MagicWandIcon as MagicWand } from '@phosphor-icons/react/dist/csr/MagicWand';
import { XIcon as X } from '@phosphor-icons/react/dist/csr/X';
import { useDeferredValue, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { TaskIntegrationConflictPermissionMode, TaskIntegrationRecord } from '../session/sessionTypes.js';
import { Button } from '../ui/Button.js';
import { ModalPortal } from '../ui/ModalPortal.js';
import { SyntaxHighlightedLine, useDeferredSyntaxHighlightedLines, useSyntaxHighlightedLines } from '../code/SyntaxHighlightedCode.js';
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
  onAskAi: (content: string, fingerprint: string, permissionMode: TaskIntegrationConflictPermissionMode) => Promise<void>;
}) {
  const document = props.conflict;
  const blocks = document?.blocks ?? [];
  const unresolvedCount = countUnresolvedConflictBlocks(document);
  const [selectedBlockIndex, setSelectedBlockIndex] = useState(0);
  const [viewMode, setViewMode] = useState<'focused' | 'full'>('focused');
  const [mergeFeedback, setMergeFeedback] = useState<string | null>(null);
  const [undoDraft, setUndoDraft] = useState<ConflictDocument | null>(null);
  const [aiPermissionOpen, setAiPermissionOpen] = useState(false);
  const [aiPermissionMode, setAiPermissionMode] = useState<TaskIntegrationConflictPermissionMode>('auto');
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
    if (selectedBlockIndex >= blocks.length && blocks.length > 0) setSelectedBlockIndex(blocks.length - 1);
  }, [blocks.length, selectedBlockIndex]);

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
      await props.onAskAi(serializeConflictForAi(document), document.fingerprint, aiPermissionMode);
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

  function selectAdjacentBlock(direction: -1 | 1): void {
    if (blocks.length === 0) return;
    setSelectedBlockIndex((current) => Math.min(blocks.length - 1, Math.max(0, current + direction)));
  }

  function openAiPermissionDialog(): void {
    setAiPermissionMode('auto');
    setAiPermissionOpen(true);
  }

  const noMarkerWarning = document?.visibleContent.match(/^(?:<<<<<<<|=======|>>>>>>>)/mu)
    ? props.zh
      ? '中间结果仍包含冲突标记，请手工清理后再保存。'
      : 'The center still contains a conflict marker. Remove it manually before saving.'
    : null;

  return (
    <div className="task-git-conflict-layout">
      <aside className="task-git-conflict-files">
        <header>
          <span>
            <strong>{props.zh ? '冲突文件' : 'Conflicted files'}</strong>
            <small>{props.integration.conflictFiles.length}</small>
          </span>
          <small>{props.zh ? `当前文件 ${unresolvedCount} 个待处理` : `${unresolvedCount} unresolved in current file`}</small>
        </header>
        {props.integration.conflictFiles.map((path) => (
          <button key={path} type="button" className={path === props.conflictPath ? 'is-active' : ''} onClick={() => props.onSelectPath(path)}>
            <span>{path}</span>
            <small>{path === props.conflictPath ? (currentFileResolved ? (props.zh ? '已处理' : 'Processed') : props.zh ? `${unresolvedCount} 个冲突` : `${unresolvedCount} conflicts`) : props.zh ? '待处理' : 'Pending'}</small>
          </button>
        ))}
      </aside>
      <main className="task-git-conflict-editor">
        <div className="task-git-conflict-toolbar">
          <span>
            <strong>{props.conflictPath}</strong>
            <small>{props.zh ? `${props.taskBranch} → ${props.integration.targetBranch} · 本地合入` : `${props.taskBranch} → ${props.integration.targetBranch} · local merge`}</small>
          </span>
          <span>
            <span className="task-git-conflict-navigation" aria-label={props.zh ? '冲突导航' : 'Conflict navigation'}>
              <button type="button" onClick={() => selectAdjacentBlock(-1)} disabled={props.busy || selectedBlockIndex <= 0} aria-label={props.zh ? '上一个冲突' : 'Previous conflict'} title={props.zh ? '上一个冲突' : 'Previous conflict'}>
                <ArrowLeft aria-hidden="true" />
              </button>
              <small>{blocks.length > 0 ? `${Math.min(selectedBlockIndex + 1, blocks.length)} / ${blocks.length}` : '0 / 0'}</small>
              <button
                type="button"
                onClick={() => selectAdjacentBlock(1)}
                disabled={props.busy || selectedBlockIndex >= blocks.length - 1}
                aria-label={props.zh ? '下一个冲突' : 'Next conflict'}
                title={props.zh ? '下一个冲突' : 'Next conflict'}
              >
                <ArrowRight aria-hidden="true" />
              </button>
            </span>
            <span className="task-git-conflict-view-switch" aria-label={props.zh ? '文件视图' : 'File view'}>
              <button type="button" className={viewMode === 'focused' ? 'is-active' : ''} onClick={() => setViewMode('focused')} disabled={!document}>
                {props.zh ? '当前冲突' : 'Current conflict'}
              </button>
              <button type="button" className={viewMode === 'full' ? 'is-active' : ''} onClick={() => setViewMode('full')} disabled={!document}>
                {props.zh ? '完整文件' : 'Full file'}
              </button>
            </span>
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
            >
              <MagicWand aria-hidden="true" weight="regular" />
              <span>{props.zh ? '合并简单冲突' : 'Merge simple conflicts'}</span>
            </Button>
            <Button
              variant="primary"
              size="compact"
              busy={props.aiBusy}
              onClick={openAiPermissionDialog}
              disabled={!document || props.busy || unresolvedCount === 0}
              title={
                props.zh
                  ? `新建命名冲突分支，由 AI 处理全部冲突；随后可在会话中通过代码交付合入 ${props.integration.targetBranch}`
                  : `Create a named conflict branch for AI resolution, then deliver it into ${props.integration.targetBranch} from the conversation`
              }
            >
              {props.zh ? 'AI 处理' : 'Resolve with AI'}
            </Button>
            <Button variant="secondary" size="compact" onClick={undoLastDraft} disabled={props.busy || undoDraft === null} aria-label={props.zh ? '撤销上一次草稿操作' : 'Undo the last draft action'}>
              {props.zh ? '撤销' : 'Undo'}
            </Button>
          </span>
        </div>

        {mergeFeedback || noMarkerWarning || simpleFailureText ? (
          <p className={`task-git-conflict-feedback${noMarkerWarning ? ' is-warning' : ''}`} role="status">
            {noMarkerWarning ?? mergeFeedback ?? simpleFailureText}
          </p>
        ) : null}

        {aiPermissionOpen ? (
          <ModalPortal rootClassName="task-git-conflict-ai-permission-portal-root" backdropClassName="task-git-conflict-ai-permission-backdrop" onDismiss={() => (props.aiBusy ? undefined : setAiPermissionOpen(false))}>
            <section
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
                <small id="task-git-conflict-ai-permission-description">
                  {props.zh ? 'AI 将在新建的命名冲突分支中修改并暂存文件；分支和会话会继续保留。' : 'AI will edit and stage files on a new named conflict branch that remains available to this conversation.'}
                </small>
              </span>
              <fieldset aria-describedby="task-git-conflict-ai-permission-description">
                <legend>{props.zh ? '权限模式' : 'Permission mode'}</legend>
                <label className={aiPermissionMode === 'auto' ? 'is-selected' : ''}>
                  <input type="radio" name="task-conflict-ai-permission" value="auto" checked={aiPermissionMode === 'auto'} onChange={() => setAiPermissionMode('auto')} disabled={props.aiBusy} />
                  <span>
                    <strong>{props.zh ? '自动（推荐）' : 'Auto (recommended)'}</strong>
                    <small>{props.zh ? '只写入本次新建的冲突分支，超出范围的操作仍需确认。' : 'Writes only to the new conflict branch; out-of-scope actions still require approval.'}</small>
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
                <Button variant="primary" size="regular" busy={props.aiBusy} onClick={() => void askAi()}>
                  {props.zh ? `以${aiPermissionMode === 'auto' ? '自动' : '完全访问'}权限开始` : `Start with ${aiPermissionMode === 'auto' ? 'auto' : 'full access'}`}
                </Button>
              </footer>
            </section>
          </ModalPortal>
        ) : null}

        {currentFileResolved ? (
          <p className="task-git-conflict-resolved" role="status">
            {props.zh ? '当前文件冲突已处理，但尚未保存。请检查中间结果后保存该文件并继续。' : 'Conflicts in this file are processed but not saved. Review the result, then save this file to continue.'}
          </p>
        ) : activeBlock?.combinationError ? (
          <p className="task-git-conflict-resolved is-warning" role="status">
            {props.zh ? `冲突 ${selectedBlockIndex + 1} 的两侧修改重叠，需要检查中间结果。` : `Conflict ${selectedBlockIndex + 1} has overlapping edits; review the merge result.`}
          </p>
        ) : null}

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
        <ConflictCodeLines content={props.snippet.text} path={props.path} lineKinds={lineKinds} lineNumberOffset={props.snippet.startLine - 1} />
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
          <DeferredConflictCodeLines content={props.snippet.text} path={props.path} lineKinds={lineKinds} lineNumberOffset={props.snippet.startLine - 1} />
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
      <FullFilePane path={props.path} textareaRef={sourceRef} title={props.targetTitle} content={props.document.source} readOnly onScroll={syncScroll} />
      <FullFilePane
        path={props.path}
        textareaRef={resultRef}
        title={props.resultTitle}
        content={props.document.visibleContent}
        readOnly={props.disabled}
        onChange={props.onResultChange}
        onScroll={syncScroll}
        blocks={props.document.blocks}
        onSideAction={props.onSideAction}
      />
      <FullFilePane path={props.path} textareaRef={taskRef} title={props.taskTitle} content={props.document.task} readOnly onScroll={syncScroll} />
    </div>
  );
}

function FullFilePane(props: {
  path: string;
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
  const highlightRef = useRef<HTMLPreElement>(null);
  const lineKinds = useMemo(() => fullFileLineKinds(props.content, props.blocks), [props.content, props.blocks]);
  return (
    <section className={`task-git-conflict-code-pane task-git-conflict-full-pane${props.blocks ? ' is-result' : ''}`}>
      <strong>{props.title}</strong>
      <span className="task-git-conflict-full-editor-surface">
        <pre ref={highlightRef} className="task-git-highlighted-code" aria-hidden="true">
          {props.blocks ? <DeferredConflictCodeLines content={props.content} path={props.path} lineKinds={lineKinds} /> : <ConflictCodeLines content={props.content} path={props.path} lineKinds={lineKinds} />}
        </pre>
        <textarea
          ref={props.textareaRef}
          value={props.content}
          readOnly={props.readOnly}
          onChange={props.onChange ? (event) => props.onChange?.(event.target.value) : undefined}
          onScroll={(event) => {
            if (highlightRef.current) {
              highlightRef.current.scrollTop = event.currentTarget.scrollTop;
              highlightRef.current.scrollLeft = event.currentTarget.scrollLeft;
            }
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

function ConflictCodeLines(props: { content: string; path: string; lineKinds: Map<number, LineKind>; lineNumberOffset?: number }) {
  const lines = useSyntaxHighlightedLines(props.path, props.content);
  return lines.map((line, index) => (
    <span key={index} className="task-git-code-line" data-kind={props.lineKinds.get(index)}>
      <span className="task-git-code-line-number">{(props.lineNumberOffset ?? 0) + index + 1}</span>
      <code>
        <SyntaxHighlightedLine line={line} empty="" />
      </code>
      {index < lines.length - 1 ? '\n' : null}
    </span>
  ));
}

function DeferredConflictCodeLines(props: { content: string; path: string; lineKinds: Map<number, LineKind>; lineNumberOffset?: number }) {
  const lines = useDeferredSyntaxHighlightedLines(props.path, props.content);
  return lines.map((line, index) => (
    <span key={index} className="task-git-code-line" data-kind={props.lineKinds.get(index)}>
      <span className="task-git-code-line-number">{(props.lineNumberOffset ?? 0) + index + 1}</span>
      <code>
        <SyntaxHighlightedLine line={line} empty="" />
      </code>
      {index < lines.length - 1 ? '\n' : null}
    </span>
  ));
}

function fullFileLineKinds(content: string, blocks: ConflictBlock[] | undefined): Map<number, LineKind> {
  const kinds = new Map<number, LineKind>();
  for (const block of blocks ?? []) {
    const startLine = countNewlines(content.slice(0, block.visibleStart));
    const endLine = startLine + Math.max(1, countNewlines(content.slice(block.visibleStart, block.visibleEnd)) + 1);
    for (let line = startLine; line < endLine; line += 1) kinds.set(line, 'conflict');
  }
  return kinds;
}

function countLines(content: string, offset: number): number {
  return countNewlines(content.slice(0, offset)) + 1;
}

function countNewlines(content: string): number {
  return (content.match(/\n/gu) ?? []).length;
}

function sideStateLabel(state: ConflictSideState): string {
  if (state === 'accepted') return '已选入';
  if (state === 'ignored') return '已忽略';
  return '未处理';
}
