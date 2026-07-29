import {useEffect, useMemo, useRef, useState} from 'react';
import {ArrowClockwiseIcon as ArrowClockwise} from '@phosphor-icons/react/dist/csr/ArrowClockwise';
import {ArrowCounterClockwiseIcon as ArrowCounterClockwise} from '@phosphor-icons/react/dist/csr/ArrowCounterClockwise';
import {ArrowsInIcon as ArrowsIn} from '@phosphor-icons/react/dist/csr/ArrowsIn';
import {ArrowsOutIcon as ArrowsOut} from '@phosphor-icons/react/dist/csr/ArrowsOut';
import {CaretDownIcon as CaretDown} from '@phosphor-icons/react/dist/csr/CaretDown';
import {FileCodeIcon as FileCode} from '@phosphor-icons/react/dist/csr/FileCode';
import {FilesIcon as Files} from '@phosphor-icons/react/dist/csr/Files';
import {GitDiffIcon as GitDiff} from '@phosphor-icons/react/dist/csr/GitDiff';
import {WarningCircleIcon as WarningCircle} from '@phosphor-icons/react/dist/csr/WarningCircle';
import {XIcon as X} from '@phosphor-icons/react/dist/csr/X';
import type {TurnChangeFile, TurnChangeSet, TurnChangeSetOperationResult} from '@zeus/shared';
import type {SessionUiLanguage} from './ThreadItemView.js';

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
  const [error, setError] = useState<string | null>(null);
  const [optimisticChangeSet, setOptimisticChangeSet] = useState<TurnChangeSet | null>(null);
  const changeSet =
    optimisticChangeSet &&
    optimisticChangeSet.id === props.changeSet.id &&
    optimisticChangeSet.updatedAt >= props.changeSet.updatedAt
      ? optimisticChangeSet
      : props.changeSet;
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
      setError(operationError instanceof Error ? operationError.message : String(operationError));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="session-turn-change-card" data-state={changeSet.state}>
      <header>
        <span className="session-turn-change-summary">
          <span className="session-turn-change-icon"><Files aria-hidden="true" weight="regular"/></span>
          <span>
            <strong>{changeSetTitle(changeSet, props.language)}</strong>
            <small>
              <span className="session-turn-change-stats">
                <span className="session-change-added">+{changeSet.addedLines}</span>
                {' '}
                <span className="session-change-deleted">-{changeSet.deletedLines}</span>
              </span>
              <span className="session-turn-change-view">{zh ? '查看更改' : 'View changes'}</span>
            </small>
          </span>
        </span>
        <nav aria-label={zh ? '文件变更操作' : 'File change actions'}>
          {action ? (
            <button type="button" className="session-turn-change-undo" disabled={Boolean(busy) || !props.onOperate} onClick={() => void operate()}>
              {action === 'undo' ? <ArrowCounterClockwise aria-hidden="true"/> : <ArrowClockwise aria-hidden="true"/>}
              <span>{busy ? (zh ? '处理中…' : 'Working…') : action === 'undo' ? (zh ? '撤销' : 'Undo') : zh ? '重新应用' : 'Reapply'}</span>
            </button>
          ) : null}
          <button type="button" className="session-turn-change-review" disabled={!props.onReview || changeSet.files.length === 0} onClick={() => props.onReview?.(changeSet)}>
            {zh ? '审核' : 'Review'}
          </button>
        </nav>
      </header>
      {error && error !== changeSet.conflict?.message && error !== changeSet.unavailableReason ? (
        <p className="session-turn-change-error" role="alert"><WarningCircle aria-hidden="true"/>{error}</p>
      ) : null}
      {changeSet.conflict ? (
        <p className="session-turn-change-error" role="alert">
          <WarningCircle aria-hidden="true"/>
          <span>{changeSet.conflict.message}</span>
        </p>
      ) : null}
      {!changeSet.conflict && changeSet.state === 'unavailable' && changeSet.unavailableReason ? (
        <p className="session-turn-change-error" role="status">
          <WarningCircle aria-hidden="true"/>
          <span>{changeSet.unavailableReason}</span>
        </p>
      ) : null}
      {visibleFiles.length ? (
        <ul className="session-turn-change-files">
          {visibleFiles.map((file) => (
            <li key={file.id}>
              <button type="button" onClick={() => props.onReview?.(changeSet, file.id)} disabled={!props.onReview}>
                <span className="session-turn-change-path" title={displayPath(file)}>{displayPath(file)}</span>
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
          <CaretDown aria-hidden="true" data-expanded={expanded || undefined}/>
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
}) {
  const zh = props.language === 'zh-CN';
  const [activeFileId, setActiveFileId] = useState(props.initialFileId ?? props.changeSet.files[0]?.id ?? null);
  const titleRef = useRef<HTMLSpanElement | null>(null);
  const [busy, setBusy] = useState<ChangeAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [optimisticChangeSet, setOptimisticChangeSet] = useState<TurnChangeSet | null>(null);
  const changeSet =
    optimisticChangeSet &&
    optimisticChangeSet.id === props.changeSet.id &&
    optimisticChangeSet.updatedAt >= props.changeSet.updatedAt
      ? optimisticChangeSet
      : props.changeSet;
  const action = availableAction(changeSet);
  const activeFile = changeSet.files.find((file) => file.id === activeFileId) ?? changeSet.files[0] ?? null;
  const diff = useMemo(() => diffLines(activeFile?.unifiedDiff ?? ''), [activeFile?.unifiedDiff]);

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

  async function operate(): Promise<void> {
    if (!action || !props.onOperate || busy) return;
    setBusy(action);
    setError(null);
    try {
      const result = await props.onOperate(changeSet, action);
      setOptimisticChangeSet(result.changeSet);
    } catch (operationError) {
      setError(operationError instanceof Error ? operationError.message : String(operationError));
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
      setError(openError instanceof Error ? openError.message : String(openError));
    }
  }

  return (
    <section className="session-context-workspace session-turn-diff-workspace" aria-label={zh ? '变更审核' : 'Change review'}>
      <header className="session-context-workspace-header">
        <span className="session-context-workspace-title" ref={titleRef} tabIndex={-1}>
          <GitDiff aria-hidden="true" weight="regular"/>
          <span>
            <strong>{zh ? '审核变更' : 'Review changes'}</strong>
            <small>{zh ? `${changeSet.fileCount} 个文件` : `${changeSet.fileCount} files`}</small>
          </span>
        </span>
        <nav aria-label={zh ? '变更审核操作' : 'Change review actions'}>
          {action ? (
            <button type="button" className="session-context-text-action" disabled={Boolean(busy) || !props.onOperate} onClick={() => void operate()}>
              {action === 'undo' ? <ArrowCounterClockwise aria-hidden="true"/> : <ArrowClockwise aria-hidden="true"/>}
              <span>{busy ? (zh ? '处理中…' : 'Working…') : action === 'undo' ? (zh ? '撤销' : 'Undo') : zh ? '重新应用' : 'Reapply'}</span>
            </button>
          ) : null}
          <button
            type="button"
            aria-label={props.fullWidth ? (zh ? '恢复分栏' : 'Restore split') : zh ? '扩展为全宽' : 'Expand full width'}
            title={props.fullWidth ? (zh ? '恢复分栏' : 'Restore split') : zh ? '扩展为全宽' : 'Expand full width'}
            onClick={() => props.onFullWidthChange(!props.fullWidth)}
          >
            {props.fullWidth ? <ArrowsIn aria-hidden="true"/> : <ArrowsOut aria-hidden="true"/>}
          </button>
          <button type="button" aria-label={zh ? '关闭变更审核' : 'Close change review'} title={zh ? '关闭' : 'Close'} onClick={props.onClose}>
            <X aria-hidden="true"/>
          </button>
        </nav>
      </header>
      {error && error !== changeSet.conflict?.message && error !== changeSet.unavailableReason ? (
        <p className="session-turn-change-error session-turn-diff-error" role="alert"><WarningCircle aria-hidden="true"/>{error}</p>
      ) : null}
      {changeSet.conflict ? (
        <p className="session-turn-change-error session-turn-diff-error" role="alert">
          <WarningCircle aria-hidden="true"/>
          <span>{changeSet.conflict.message}</span>
        </p>
      ) : null}
      {!changeSet.conflict && changeSet.state === 'unavailable' && changeSet.unavailableReason ? (
        <p className="session-turn-change-error session-turn-diff-error" role="status">
          <WarningCircle aria-hidden="true"/>
          <span>{changeSet.unavailableReason}</span>
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
                    <button
                      type="button"
                      className="session-turn-diff-open-file"
                      onClick={() => void openFile(activeFile)}
                    >
                      <FileCode aria-hidden="true"/>
                      <span>{zh ? '打开文件' : 'Open file'}</span>
                    </button>
                  ) : null}
                </span>
              </header>
              {diff.truncated ? (
                <p className="session-turn-diff-truncated" role="status">
                  {zh
                    ? `差异过大，仅显示前 ${maximumRenderedDiffLines} 行（共 ${diff.totalLines} 行）。`
                    : `Diff is too large; showing the first ${maximumRenderedDiffLines} of ${diff.totalLines} lines.`}
                </p>
              ) : null}
              <pre>
                <code>
                  {diff.lines.map((line, index) => (
                    <span className="session-diff-line" data-kind={line.kind} key={`${index}:${line.text}`}>
                      <span className="session-diff-line-sign" aria-hidden="true">{line.sign}</span>
                      {lineNumberForState(line, changeSet.state) && props.onOpenFile ? (
                        <button
                          type="button"
                          className="session-diff-line-number"
                          aria-label={
                            zh
                              ? `在源码中打开第 ${lineNumberForState(line, changeSet.state)} 行`
                              : `Open source at line ${lineNumberForState(line, changeSet.state)}`
                          }
                          onClick={() => void openFile(
                            activeFile,
                            lineNumberForState(line, changeSet.state) ?? undefined,
                          )}
                        >
                          {lineNumberLabel(line)}
                        </button>
                      ) : (
                        <span className="session-diff-line-number" aria-hidden="true">{lineNumberLabel(line)}</span>
                      )}
                      <span>{line.text || '\u00a0'}</span>
                    </span>
                  ))}
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

function availableAction(changeSet: TurnChangeSet): ChangeAction | null {
  if (changeSet.state === 'applied') return 'undo';
  if (changeSet.state === 'undone') return 'reapply';
  return null;
}

function changeSetTitle(changeSet: TurnChangeSet, language: SessionUiLanguage): string {
  const zh = language === 'zh-CN';
  const subject = changeSet.fileCount === 1
    ? displayPath(changeSet.files[0]!)
    : zh
      ? `${changeSet.fileCount} 个文件`
      : `${changeSet.fileCount} files`;
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
  const labels = language === 'zh-CN'
    ? {added: '新增', deleted: '删除', modified: '修改', renamed: '重命名', binary: '二进制'}
    : {added: 'Added', deleted: 'Deleted', modified: 'Modified', renamed: 'Renamed', binary: 'Binary'};
  return labels[file.changeType];
}

interface DisplayDiffLine {
  kind: 'added' | 'deleted' | 'hunk' | 'meta' | 'context';
  sign: string;
  text: string;
  oldLine: number | null;
  newLine: number | null;
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
      return {kind: 'meta' as const, sign: '', text: line, oldLine: null, newLine: null};
    }
    if (line.startsWith('@@')) {
      const match = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/u.exec(line);
      oldLine = match ? Number(match[1]) : null;
      newLine = match ? Number(match[2]) : null;
      return {kind: 'hunk' as const, sign: '', text: line, oldLine: null, newLine: null};
    }
    if (line.startsWith('+')) {
      const currentNewLine = newLine;
      if (newLine !== null) newLine += 1;
      return {kind: 'added' as const, sign: '+', text: line.slice(1), oldLine: null, newLine: currentNewLine};
    }
    if (line.startsWith('-')) {
      const currentOldLine = oldLine;
      if (oldLine !== null) oldLine += 1;
      return {kind: 'deleted' as const, sign: '−', text: line.slice(1), oldLine: currentOldLine, newLine: null};
    }
    if (line.startsWith('\\ No newline at end of file')) {
      return {kind: 'meta' as const, sign: '', text: line, oldLine: null, newLine: null};
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
  return {lines, totalLines: rawLines.length, truncated};
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
