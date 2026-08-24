import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowClockwiseIcon as ArrowClockwise } from '@phosphor-icons/react/dist/csr/ArrowClockwise';
import { ArrowCounterClockwiseIcon as ArrowCounterClockwise } from '@phosphor-icons/react/dist/csr/ArrowCounterClockwise';
import { ArrowsInIcon as ArrowsIn } from '@phosphor-icons/react/dist/csr/ArrowsIn';
import { ArrowsOutIcon as ArrowsOut } from '@phosphor-icons/react/dist/csr/ArrowsOut';
import { CaretDownIcon as CaretDown } from '@phosphor-icons/react/dist/csr/CaretDown';
import { FileCodeIcon as FileCode } from '@phosphor-icons/react/dist/csr/FileCode';
import { FilesIcon as Files } from '@phosphor-icons/react/dist/csr/Files';
import { GitDiffIcon as GitDiff } from '@phosphor-icons/react/dist/csr/GitDiff';
import { WarningCircleIcon as WarningCircle } from '@phosphor-icons/react/dist/csr/WarningCircle';
import { XIcon as X } from '@phosphor-icons/react/dist/csr/X';
import {
  historicalTurnChangeUnavailableReason,
  type ConversationCodeComment,
  type ConversationCodeCommentPosition,
  type ConversationCodeCommentSide,
  type TurnChangeFile,
  type TurnChangeSet,
  type TurnChangeSetOperationResult,
} from '@zeus/shared';
import type { SessionUiLanguage } from './ThreadItemView.js';
import { CodeCommentPanel } from './CodeCommentPanel.js';
import { useApplicationErrorDialog, VisibleApplicationError } from '../ui/ApplicationErrorDialog.js';
import { SyntaxHighlightedLine, useSyntaxHighlightedSegments, type HighlightedLine } from '../code/SyntaxHighlightedCode.js';

type ChangeAction = 'undo' | 'reapply';
const maximumRenderedDiffLines = 2_000;

export function TurnChangeCard(props: {
  changeSet: TurnChangeSet;
  language: SessionUiLanguage;
  onReview?: (changeSet: TurnChangeSet, fileId?: string) => void;
  onOperate?: (changeSet: TurnChangeSet, action: ChangeAction) => Promise<TurnChangeSetOperationResult>;
}) {
  const zh = props.language === 'zh-CN';
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState<ChangeAction | null>(null);
  const [error, setError] = useState<unknown>(null);
  useApplicationErrorDialog(error && error !== props.changeSet.conflict?.message && error !== props.changeSet.unavailableReason ? error : null, {
    language: zh ? 'zh-CN' : 'en',
  });
  const [optimisticChangeSet, setOptimisticChangeSet] = useState<TurnChangeSet | null>(null);
  const changeSet = optimisticChangeSet && optimisticChangeSet.id === props.changeSet.id && optimisticChangeSet.updatedAt >= props.changeSet.updatedAt ? optimisticChangeSet : props.changeSet;
  const visibleFiles = expanded ? changeSet.files : changeSet.files.slice(0, 3);
  const hiddenCount = Math.max(0, changeSet.files.length - visibleFiles.length);
  const action = availableAction(changeSet);

  async function operate(): Promise<void> {
    if (!action || !props.onOperate || busy) return;
    setBusy(action);
    setError(null);
    try {
      const result = await props.onOperate(changeSet, action);
      setOptimisticChangeSet(result.changeSet);
    } catch (operationError) {
      setError(operationError);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="session-turn-change-card" data-state={changeSet.state}>
      <header>
        <span className="session-turn-change-summary">
          <span className="session-turn-change-icon">
            <Files aria-hidden="true" weight="regular" />
          </span>
          <span>
            <span className="session-turn-change-title">{changeSetTitle(changeSet, props.language)}</span>
            <small>
              <span className="session-turn-change-stats">
                <span className="session-change-added">+{changeSet.addedLines}</span> <span className="session-change-deleted">-{changeSet.deletedLines}</span>
              </span>
              <span className="session-turn-change-view">{zh ? '查看更改' : 'View changes'}</span>
            </small>
          </span>
        </span>
        <nav aria-label={zh ? '文件变更操作' : 'File change actions'}>
          {action ? (
            <button type="button" className="session-turn-change-undo" disabled={Boolean(busy) || !props.onOperate} onClick={() => void operate()}>
              {action === 'undo' ? <ArrowCounterClockwise aria-hidden="true" /> : <ArrowClockwise aria-hidden="true" />}
              <span>{busy ? (zh ? '处理中…' : 'Working…') : action === 'undo' ? (zh ? '撤销' : 'Undo') : zh ? '重新应用' : 'Reapply'}</span>
            </button>
          ) : null}
          <button type="button" className="session-turn-change-review" disabled={!props.onReview || changeSet.files.length === 0} onClick={() => props.onReview?.(changeSet)}>
            {zh ? '审核' : 'Review'}
          </button>
        </nav>
      </header>
      {changeSet.conflict ? (
        <p className="session-turn-change-error" role="alert">
          <VisibleApplicationError error={changeSet.conflict} language={zh ? 'zh-CN' : 'en'} />
        </p>
      ) : null}
      {!changeSet.conflict && changeSet.state === 'unavailable' && changeSet.unavailableReason ? (
        <p className="session-turn-change-error" role="status">
          <WarningCircle aria-hidden="true" />
          <span>{unavailableReason(changeSet.unavailableReason, props.language)}</span>
        </p>
      ) : null}
      {visibleFiles.length ? (
        <ul className="session-turn-change-files">
          {visibleFiles.map((file) => (
            <li key={file.id}>
              <button type="button" onClick={() => props.onReview?.(changeSet, file.id)} disabled={!props.onReview}>
                <span className="session-turn-change-path" title={displayPath(file)}>
                  {displayPath(file)}
                </span>
                <span className="session-turn-change-file-counts">
                  {file.addedLines ? <span className="session-change-added">+{file.addedLines}</span> : null}
                  {file.deletedLines ? <span className="session-change-deleted">-{file.deletedLines}</span> : null}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {hiddenCount > 0 || (expanded && changeSet.files.length > 3) ? (
        <button type="button" className="session-turn-change-more" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
          <span>{expanded ? (zh ? '收起文件' : 'Show fewer files') : zh ? `再显示 ${hiddenCount} 个文件` : `Show ${hiddenCount} more files`}</span>
          <CaretDown aria-hidden="true" data-expanded={expanded || undefined} />
        </button>
      ) : null}
    </section>
  );
}

export function TurnDiffWorkspace(props: {
  changeSet: TurnChangeSet;
  initialFileId?: string;
  language: SessionUiLanguage;
  fullWidth: boolean;
  onFullWidthChange: (fullWidth: boolean) => void;
  onClose: () => void;
  onOperate?: (changeSet: TurnChangeSet, action: ChangeAction) => Promise<TurnChangeSetOperationResult>;
  onOpenFile?: (file: TurnChangeFile, line?: number) => void | Promise<void>;
  comments?: ConversationCodeComment[];
  onCommentsChange?: (comments: ConversationCodeComment[]) => void;
}) {
  const zh = props.language === 'zh-CN';
  const [activeFileId, setActiveFileId] = useState(props.initialFileId ?? props.changeSet.files[0]?.id ?? null);
  const titleRef = useRef<HTMLSpanElement | null>(null);
  const [busy, setBusy] = useState<ChangeAction | null>(null);
  const [error, setError] = useState<unknown>(null);
  useApplicationErrorDialog(error && error !== props.changeSet.conflict?.message && error !== props.changeSet.unavailableReason ? error : null, {
    language: zh ? 'zh-CN' : 'en',
  });
  const [optimisticChangeSet, setOptimisticChangeSet] = useState<TurnChangeSet | null>(null);
  const [draftPosition, setDraftPosition] = useState<ConversationCodeCommentPosition | null>(null);
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [rangeStart, setRangeStart] = useState<{ line: number; side: ConversationCodeCommentSide } | null>(null);
  const changeSet = optimisticChangeSet && optimisticChangeSet.id === props.changeSet.id && optimisticChangeSet.updatedAt >= props.changeSet.updatedAt ? optimisticChangeSet : props.changeSet;
  const action = availableAction(changeSet);
  const activeFile = changeSet.files.find((file) => file.id === activeFileId) ?? changeSet.files[0] ?? null;
  const diff = useMemo(() => diffLines(activeFile?.unifiedDiff ?? ''), [activeFile?.unifiedDiff]);
  const activePath = activeFile ? commentPath(activeFile) : null;
  const comments = (props.comments ?? []).filter((comment) => comment.position.path === activePath);
  const leftHighlightInput = useMemo(() => buildDiffHighlightInput(diff.lines, 'left'), [diff.lines]);
  const rightHighlightInput = useMemo(() => buildDiffHighlightInput(diff.lines, 'right'), [diff.lines]);
  const leftHighlights = useSyntaxHighlightedSegments(activeFile?.oldPath ?? activePath ?? '', leftHighlightInput.contents);
  const rightHighlights = useSyntaxHighlightedSegments(activeFile?.newPath ?? activePath ?? '', rightHighlightInput.contents);

  useEffect(() => {
    titleRef.current?.focus();
  }, [props.changeSet.id]);

  useEffect(() => {
    if (props.initialFileId && changeSet.files.some((file) => file.id === props.initialFileId)) {
      setActiveFileId(props.initialFileId);
      return;
    }
    if (!changeSet.files.some((file) => file.id === activeFileId)) {
      setActiveFileId(changeSet.files[0]?.id ?? null);
    }
  }, [activeFileId, changeSet.files, props.initialFileId]);

  useEffect(() => {
    setDraftPosition(null);
    setEditingCommentId(null);
    setRangeStart(null);
  }, [activeFile?.id]);

  function saveComment(position: ConversationCodeCommentPosition, body: string, existingId?: string): void {
    if (!props.onCommentsChange) return;
    const diffHunk = activeFile ? nearbyDiffHunk(activeFile.unifiedDiff, position) : undefined;
    const next = existingId
      ? (props.comments ?? []).map((comment) => (comment.id === existingId ? { ...comment, body } : comment))
      : [...(props.comments ?? []), { id: crypto.randomUUID(), body, position, ...(diffHunk ? { diffHunk } : {}) }];
    props.onCommentsChange(next);
    setDraftPosition(null);
    setEditingCommentId(null);
  }

  async function operate(): Promise<void> {
    if (!action || !props.onOperate || busy) return;
    setBusy(action);
    setError(null);
    try {
      const result = await props.onOperate(changeSet, action);
      setOptimisticChangeSet(result.changeSet);
    } catch (operationError) {
      setError(operationError);
    } finally {
      setBusy(null);
    }
  }

  async function openFile(file: TurnChangeFile, line?: number): Promise<void> {
    if (!props.onOpenFile) return;
    setError(null);
    try {
      await props.onOpenFile(file, line);
    } catch (openError) {
      setError(openError);
    }
  }

  return (
    <section className="session-context-workspace session-turn-diff-workspace" aria-label={zh ? '变更审核' : 'Change review'}>
      <header className="session-context-workspace-header">
        <span className="session-context-workspace-title" ref={titleRef} tabIndex={-1}>
          <GitDiff aria-hidden="true" weight="regular" />
          <span>
            <strong>{zh ? '审核变更' : 'Review changes'}</strong>
            <small>{zh ? `${changeSet.fileCount} 个文件` : `${changeSet.fileCount} files`}</small>
          </span>
        </span>
        <nav aria-label={zh ? '变更审核操作' : 'Change review actions'}>
          {action ? (
            <button type="button" className="session-context-text-action" disabled={Boolean(busy) || !props.onOperate} onClick={() => void operate()}>
              {action === 'undo' ? <ArrowCounterClockwise aria-hidden="true" /> : <ArrowClockwise aria-hidden="true" />}
              <span>{busy ? (zh ? '处理中…' : 'Working…') : action === 'undo' ? (zh ? '撤销' : 'Undo') : zh ? '重新应用' : 'Reapply'}</span>
            </button>
          ) : null}
          <button
            type="button"
            aria-label={props.fullWidth ? (zh ? '恢复分栏' : 'Restore split') : zh ? '扩展为全宽' : 'Expand full width'}
            title={props.fullWidth ? (zh ? '恢复分栏' : 'Restore split') : zh ? '扩展为全宽' : 'Expand full width'}
            onClick={() => props.onFullWidthChange(!props.fullWidth)}
          >
            {props.fullWidth ? <ArrowsIn aria-hidden="true" /> : <ArrowsOut aria-hidden="true" />}
          </button>
          <button type="button" aria-label={zh ? '关闭变更审核' : 'Close change review'} title={zh ? '关闭' : 'Close'} onClick={props.onClose}>
            <X aria-hidden="true" />
          </button>
        </nav>
      </header>
      {changeSet.conflict ? (
        <p className="session-turn-change-error session-turn-diff-error" role="alert">
          <VisibleApplicationError error={changeSet.conflict} language={zh ? 'zh-CN' : 'en'} />
        </p>
      ) : null}
      {!changeSet.conflict && changeSet.state === 'unavailable' && changeSet.unavailableReason ? (
        <p className="session-turn-change-error session-turn-diff-error" role="status">
          <WarningCircle aria-hidden="true" />
          <span>{unavailableReason(changeSet.unavailableReason, props.language)}</span>
        </p>
      ) : null}
      <div className="session-turn-diff-layout">
        <nav className="session-turn-diff-files" aria-label={zh ? '变更文件' : 'Changed files'}>
          <div className="session-turn-diff-totals">
            <span className="session-change-added">+{changeSet.addedLines}</span>
            <span className="session-change-deleted">-{changeSet.deletedLines}</span>
          </div>
          {changeSet.files.map((file) => (
            <button type="button" key={file.id} aria-current={file.id === activeFile?.id ? 'true' : undefined} onClick={() => setActiveFileId(file.id)}>
              <span title={displayPath(file)}>{displayPath(file)}</span>
              <small>
                {file.addedLines ? <span className="session-change-added">+{file.addedLines}</span> : null}
                {file.deletedLines ? <span className="session-change-deleted">-{file.deletedLines}</span> : null}
              </small>
            </button>
          ))}
        </nav>
        <section className="session-turn-diff-content" aria-label={activeFile ? displayPath(activeFile) : undefined}>
          {activeFile ? (
            <>
              <header>
                <strong title={displayPath(activeFile)}>{displayPath(activeFile)}</strong>
                <span>
                  <small>{localizedChangeType(activeFile, props.language)}</small>
                  {props.onOpenFile ? (
                    <button type="button" className="session-turn-diff-open-file" onClick={() => void openFile(activeFile)}>
                      <FileCode aria-hidden="true" />
                      <span>{zh ? '打开文件' : 'Open file'}</span>
                    </button>
                  ) : null}
                </span>
              </header>
              {diff.truncated ? (
                <p className="session-turn-diff-truncated" role="status">
                  {zh ? `差异过大，仅显示前 ${maximumRenderedDiffLines} 行（共 ${diff.totalLines} 行）。` : `Diff is too large; showing the first ${maximumRenderedDiffLines} of ${diff.totalLines} lines.`}
                </p>
              ) : null}
              <pre>
                <code>
                  {diff.lines.map((line, index) => {
                    const position = activePath ? commentPosition(activePath, line) : null;
                    const lineComments = position ? comments.filter((comment) => comment.position.line === position.line && comment.position.side === position.side) : [];
                    const draftHere = Boolean(position && draftPosition?.line === position.line && draftPosition.side === position.side);
                    const highlightedLine = highlightedDiffLine(line, index, leftHighlightInput, leftHighlights, rightHighlightInput, rightHighlights);
                    return (
                      <Fragment key={`${index}:${line.text}`}>
                        <span className="session-diff-line" data-kind={line.kind}>
                          {position && props.onCommentsChange ? (
                            <button
                              type="button"
                              className="session-code-comment-add"
                              aria-label={zh ? `评论${position.side === 'left' ? '旧' : '新'}文件第 ${position.line} 行` : `Comment on ${position.side === 'left' ? 'old' : 'new'} line ${position.line}`}
                              onClick={(event) => {
                                const useRange = event.shiftKey && rangeStart?.side === position.side;
                                const startLine = useRange ? Math.min(rangeStart.line, position.line) : position.line;
                                const endLine = useRange ? Math.max(rangeStart.line, position.line) : position.line;
                                setRangeStart({ line: position.line, side: position.side });
                                setEditingCommentId(null);
                                setDraftPosition({ path: position.path, line: endLine, side: position.side, ...(startLine !== endLine ? { startLine, startSide: position.side } : {}) });
                              }}
                            >
                              +
                            </button>
                          ) : (
                            <span className="session-code-comment-spacer" aria-hidden="true" />
                          )}
                          <span className="session-diff-line-sign" aria-hidden="true">
                            {line.sign}
                          </span>
                          {lineNumberForState(line, changeSet.state) && props.onOpenFile ? (
                            <button
                              type="button"
                              className="session-diff-line-number"
                              aria-label={zh ? `在源码中打开第 ${lineNumberForState(line, changeSet.state)} 行` : `Open source at line ${lineNumberForState(line, changeSet.state)}`}
                              onClick={() => void openFile(activeFile, lineNumberForState(line, changeSet.state) ?? undefined)}
                            >
                              {lineNumberLabel(line)}
                            </button>
                          ) : (
                            <span className="session-diff-line-number" aria-hidden="true">
                              {lineNumberLabel(line)}
                            </span>
                          )}
                          <span>
                            <SyntaxHighlightedLine line={highlightedLine} />
                          </span>
                        </span>
                        {lineComments.map((comment) =>
                          editingCommentId === comment.id ? (
                            <CodeCommentPanel
                              key={comment.id}
                              language={props.language}
                              position={comment.position}
                              comment={comment}
                              onCancel={() => setEditingCommentId(null)}
                              onSave={(body) => saveComment(comment.position, body, comment.id)}
                              onDelete={() => {
                                props.onCommentsChange?.((props.comments ?? []).filter((candidate) => candidate.id !== comment.id));
                                setEditingCommentId(null);
                              }}
                            />
                          ) : (
                            <span key={comment.id} className="session-saved-code-comment">
                              <strong>{zh ? '本地评论' : 'Local comment'}</strong>
                              <span>{comment.body}</span>
                              <span className="session-saved-code-comment-actions">
                                <button type="button" onClick={() => setEditingCommentId(comment.id)}>
                                  {zh ? '编辑' : 'Edit'}
                                </button>
                                <button type="button" onClick={() => props.onCommentsChange?.((props.comments ?? []).filter((candidate) => candidate.id !== comment.id))}>
                                  {zh ? '删除' : 'Delete'}
                                </button>
                              </span>
                            </span>
                          ),
                        )}
                        {draftHere && draftPosition ? <CodeCommentPanel language={props.language} position={draftPosition} onCancel={() => setDraftPosition(null)} onSave={(body) => saveComment(draftPosition, body)} /> : null}
                      </Fragment>
                    );
                  })}
                </code>
              </pre>
            </>
          ) : (
            <p className="session-turn-diff-empty">{zh ? '这一轮没有可显示的文本差异。' : 'This turn has no displayable text diff.'}</p>
          )}
        </section>
      </div>
    </section>
  );
}

function commentPath(file: TurnChangeFile): string {
  return file.newPath ?? file.oldPath ?? 'unknown';
}

function commentPosition(path: string, line: DisplayDiffLine): ConversationCodeCommentPosition | null {
  if (line.kind === 'deleted' && line.oldLine !== null) return { path, line: line.oldLine, side: 'left' };
  if (line.newLine !== null) return { path, line: line.newLine, side: 'right' };
  if (line.oldLine !== null) return { path, line: line.oldLine, side: 'left' };
  return null;
}

function nearbyDiffHunk(diff: string, position: ConversationCodeCommentPosition): string | undefined {
  const lines = diff.split('\n');
  let oldLine: number | null = null;
  let newLine: number | null = null;
  let activeHunk = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? '';
    if (raw.startsWith('@@')) {
      const match = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/u.exec(raw);
      oldLine = match ? Number(match[1]) : null;
      newLine = match ? Number(match[2]) : null;
      activeHunk = index;
      continue;
    }
    const current = position.side === 'left' ? oldLine : newLine;
    if (current === position.line && activeHunk >= 0) {
      const nextHunk = lines.findIndex((candidate, candidateIndex) => candidateIndex > activeHunk && candidate.startsWith('@@'));
      return lines
        .slice(activeHunk, nextHunk < 0 ? lines.length : nextHunk)
        .join('\n')
        .slice(0, 8_000);
    }
    if (!raw.startsWith('+') && oldLine !== null) oldLine += 1;
    if (!raw.startsWith('-') && newLine !== null) newLine += 1;
  }
  return undefined;
}

function availableAction(changeSet: TurnChangeSet): ChangeAction | null {
  if (changeSet.state === 'applied') return 'undo';
  if (changeSet.state === 'undone') return 'reapply';
  return null;
}

function unavailableReason(reason: string, language: SessionUiLanguage): string {
  if (reason !== historicalTurnChangeUnavailableReason) return reason;
  return language === 'zh-CN' ? '已保留这一轮的历史文件变更记录，但缺少可安全撤销或重新应用的文件快照。' : reason;
}

function changeSetTitle(changeSet: TurnChangeSet, language: SessionUiLanguage): string {
  const zh = language === 'zh-CN';
  const subject = changeSet.fileCount === 1 ? displayPath(changeSet.files[0]!) : zh ? `${changeSet.fileCount} 个文件` : `${changeSet.fileCount} files`;
  if (changeSet.state === 'capturing') return zh ? '正在记录文件变更' : 'Recording file changes';
  if (changeSet.state === 'undoing') return zh ? '正在撤销文件变更' : 'Undoing file changes';
  if (changeSet.state === 'reapplying') return zh ? '正在重新应用文件变更' : 'Reapplying file changes';
  if (changeSet.state === 'undone') return zh ? `已撤销 ${subject}` : `Undid ${subject}`;
  if (changeSet.state === 'conflicted') return zh ? `无法安全更新 ${subject}` : `Could not safely update ${subject}`;
  if (changeSet.state === 'unavailable') return zh ? '文件变更不可撤销' : 'File changes are not reversible';
  return zh ? `已编辑 ${subject}` : `Edited ${subject}`;
}

function displayPath(file: TurnChangeFile): string {
  if (file.oldPath && file.newPath && file.oldPath !== file.newPath) return `${file.oldPath} → ${file.newPath}`;
  return file.newPath ?? file.oldPath ?? 'unknown';
}

function localizedChangeType(file: TurnChangeFile, language: SessionUiLanguage): string {
  const labels = language === 'zh-CN' ? { added: '新增', deleted: '删除', modified: '修改', renamed: '重命名', binary: '二进制' } : { added: 'Added', deleted: 'Deleted', modified: 'Modified', renamed: 'Renamed', binary: 'Binary' };
  return labels[file.changeType];
}

interface DisplayDiffLine {
  kind: 'added' | 'deleted' | 'hunk' | 'meta' | 'context';
  sign: string;
  text: string;
  oldLine: number | null;
  newLine: number | null;
}

interface DiffHighlightInput {
  contents: string[];
  positions: Map<number, { segment: number; line: number }>;
}

function buildDiffHighlightInput(lines: DisplayDiffLine[], side: ConversationCodeCommentSide): DiffHighlightInput {
  const contents: string[] = [];
  const positions = new Map<number, { segment: number; line: number }>();
  let segment = -1;
  let segmentLine = 0;
  lines.forEach((line, index) => {
    if (line.kind === 'hunk') {
      segment = contents.length;
      segmentLine = 0;
      contents.push('');
      return;
    }
    const belongsToSide = line.kind === 'context' || (side === 'left' ? line.kind === 'deleted' : line.kind === 'added');
    if (!belongsToSide) return;
    if (segment < 0) {
      segment = contents.length;
      segmentLine = 0;
      contents.push('');
    }
    positions.set(index, { segment, line: segmentLine });
    contents[segment] = `${contents[segment]}${segmentLine > 0 ? '\n' : ''}${line.text}`;
    segmentLine += 1;
  });
  return { contents, positions };
}

function highlightedDiffLine(line: DisplayDiffLine, index: number, leftInput: DiffHighlightInput, leftHighlights: HighlightedLine[][], rightInput: DiffHighlightInput, rightHighlights: HighlightedLine[][]): HighlightedLine {
  const input = line.kind === 'deleted' ? leftInput : rightInput;
  const highlights = line.kind === 'deleted' ? leftHighlights : rightHighlights;
  const position = input.positions.get(index);
  return (position ? highlights[position.segment]?.[position.line] : null) ?? (line.text ? [{ text: line.text }] : []);
}

function diffLines(diff: string): {
  lines: DisplayDiffLine[];
  totalLines: number;
  truncated: boolean;
} {
  let oldLine: number | null = null;
  let newLine: number | null = null;
  const rawLines = diff.split('\n');
  const truncated = rawLines.length > maximumRenderedDiffLines;
  const lines = rawLines.slice(0, maximumRenderedDiffLines).map((line) => {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) {
      return { kind: 'meta' as const, sign: '', text: line, oldLine: null, newLine: null };
    }
    if (line.startsWith('@@')) {
      const match = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/u.exec(line);
      oldLine = match ? Number(match[1]) : null;
      newLine = match ? Number(match[2]) : null;
      return { kind: 'hunk' as const, sign: '', text: line, oldLine: null, newLine: null };
    }
    if (line.startsWith('+')) {
      const currentNewLine = newLine;
      if (newLine !== null) newLine += 1;
      return { kind: 'added' as const, sign: '+', text: line.slice(1), oldLine: null, newLine: currentNewLine };
    }
    if (line.startsWith('-')) {
      const currentOldLine = oldLine;
      if (oldLine !== null) oldLine += 1;
      return { kind: 'deleted' as const, sign: '−', text: line.slice(1), oldLine: currentOldLine, newLine: null };
    }
    if (line.startsWith('\\ No newline at end of file')) {
      return { kind: 'meta' as const, sign: '', text: line, oldLine: null, newLine: null };
    }
    const currentOldLine = oldLine;
    const currentNewLine = newLine;
    if (oldLine !== null) oldLine += 1;
    if (newLine !== null) newLine += 1;
    return {
      kind: 'context' as const,
      sign: ' ',
      text: line.startsWith(' ') ? line.slice(1) : line,
      oldLine: currentOldLine,
      newLine: currentNewLine,
    };
  });
  return { lines, totalLines: rawLines.length, truncated };
}

function lineNumberForState(line: DisplayDiffLine, state: TurnChangeSet['state']): number | null {
  if (state === 'undone' || state === 'reapplying') return line.oldLine;
  return line.newLine;
}

function lineNumberLabel(line: DisplayDiffLine): string {
  if (line.oldLine === null && line.newLine === null) return '';
  if (line.oldLine === line.newLine) return String(line.newLine);
  if (line.oldLine === null) return String(line.newLine);
  if (line.newLine === null) return String(line.oldLine);
  return `${line.oldLine} ${line.newLine}`;
}
