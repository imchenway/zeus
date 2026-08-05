import { MagicWand } from '@phosphor-icons/react/MagicWand';
import { useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { TaskIntegrationConflictFile, TaskIntegrationRecord } from '../session/sessionTypes.js';
import { Button } from '../ui/Button.js';

type ConflictChoice = 'source' | 'task' | 'both';
type LineKind = 'added' | 'modified' | 'conflict';

interface ConflictBlock {
  id: string;
  start: number;
  end: number;
  startLine: number;
  endLine: number;
  source: string;
  base: string | null;
  task: string;
}

interface DiffOperation {
  type: 'equal' | 'delete' | 'insert';
  text: string;
}

const slashCommentSyntaxPattern = buildSyntaxPattern('\\/\\/.*$|\\/\\*.*?\\*\\/');
const hashCommentSyntaxPattern = buildSyntaxPattern('#.*$');

export function countConflictBlocks(content: string): number {
  return parseConflictBlocks(content).length;
}

export function resolveSimpleConflictDraft(content: string, fullBase: string): { content: string; resolved: number; remaining: number } {
  return resolveSimpleConflicts(content, fullBase);
}

export function TaskGitConflictWorkspace(props: {
  zh: boolean;
  busy: boolean;
  integration: TaskIntegrationRecord;
  taskBranch: string;
  conflictPath: string;
  conflict: TaskIntegrationConflictFile | null;
  resultContent: string;
  onSelectPath: (path: string) => void;
  onResultChange: (content: string) => void;
}) {
  const blocks = useMemo(() => parseConflictBlocks(props.resultContent), [props.resultContent]);
  const deferredBlocks = useDeferredValue(blocks);
  const [revealOffset, setRevealOffset] = useState<number | null>(null);
  const [mergeFeedback, setMergeFeedback] = useState<string | null>(null);

  useEffect(() => {
    setMergeFeedback(null);
    setRevealOffset(null);
  }, [props.conflictPath]);

  function chooseBlock(block: ConflictBlock, choice: ConflictChoice): void {
    props.onResultChange(replaceConflictBlock(props.resultContent, block, choice));
    setMergeFeedback(props.zh ? `已处理第 ${blocks.indexOf(block) + 1} 个冲突块，保存前不会写入文件。` : `Conflict ${blocks.indexOf(block) + 1} resolved in the draft. The file is unchanged until you save.`);
  }

  function mergeSimpleConflicts(): void {
    const result = resolveSimpleConflictDraft(props.resultContent, props.conflict?.base ?? '');
    if (result.resolved > 0) props.onResultChange(result.content);
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
            <small>{props.zh ? `左：${props.integration.targetBranch} · 右：${props.taskBranch}` : `Left: ${props.integration.targetBranch} · Right: ${props.taskBranch}`}</small>
          </span>
          <span>
            {mergeFeedback ? (
              <small className="task-git-conflict-feedback" role="status">
                {mergeFeedback}
              </small>
            ) : null}
            <Button
              variant="secondary"
              size="compact"
              className="task-git-conflict-magic"
              onClick={mergeSimpleConflicts}
              disabled={!props.conflict || props.busy || blocks.length === 0}
              title={props.zh ? '自动合并当前文件中能确定的简单冲突' : 'Merge safe simple conflicts in this file'}
              aria-label={props.zh ? '自动合并简单冲突' : 'Resolve simple conflicts'}
            >
              <MagicWand aria-hidden="true" weight="regular" />
              <span>{props.zh ? '合并简单冲突' : 'Resolve simple conflicts'}</span>
            </Button>
          </span>
        </div>

        {blocks.length > 0 ? (
          <nav className="task-git-conflict-block-rail" aria-label={props.zh ? '未解决冲突块' : 'Unresolved conflict blocks'}>
            {blocks.map((block, index) => (
              <section key={block.id} aria-label={props.zh ? `冲突 ${index + 1}` : `Conflict ${index + 1}`}>
                <button type="button" className="task-git-conflict-block-location" onClick={() => setRevealOffset(block.start)}>
                  {props.zh ? `冲突 ${index + 1} · 第 ${block.startLine} 行` : `Conflict ${index + 1} · line ${block.startLine}`}
                </button>
                <span>
                  <button type="button" aria-label={props.zh ? `冲突 ${index + 1}：采用目标` : `Conflict ${index + 1}: use target`} onClick={() => chooseBlock(block, 'source')} disabled={props.busy}>
                    {props.zh ? '采用目标' : 'Use target'}
                  </button>
                  <button type="button" aria-label={props.zh ? `冲突 ${index + 1}：采用任务` : `Conflict ${index + 1}: use task`} onClick={() => chooseBlock(block, 'task')} disabled={props.busy}>
                    {props.zh ? '采用任务' : 'Use task'}
                  </button>
                  <button type="button" aria-label={props.zh ? `冲突 ${index + 1}：两者都采用` : `Conflict ${index + 1}: use both`} onClick={() => chooseBlock(block, 'both')} disabled={props.busy}>
                    {props.zh ? '两者都采用' : 'Use both'}
                  </button>
                </span>
              </section>
            ))}
          </nav>
        ) : (
          <p className="task-git-conflict-resolved" role="status">
            {props.zh ? '当前文件的冲突块已全部处理，请检查中间结果后保存。' : 'All conflict blocks in this file are resolved. Review the result, then save.'}
          </p>
        )}

        <div className="task-git-conflict-columns">
          <HighlightedCodePane title={props.zh ? '目标分支' : 'Target branch'} path={props.conflictPath} content={props.conflict?.source ?? ''} base={props.conflict?.base ?? ''} conflictBlocks={deferredBlocks} side="source" />
          <HighlightedResultEditor
            title={props.zh ? '合并结果' : 'Merge result'}
            path={props.conflictPath}
            content={props.resultContent}
            base={props.conflict?.base ?? ''}
            disabled={!props.conflict || props.busy}
            revealOffset={revealOffset}
            onChange={props.onResultChange}
          />
          <HighlightedCodePane title={props.zh ? '任务分支' : 'Task branch'} path={props.conflictPath} content={props.conflict?.task ?? ''} base={props.conflict?.base ?? ''} conflictBlocks={deferredBlocks} side="task" />
        </div>
      </main>
    </div>
  );
}

function HighlightedCodePane(props: { title: string; path: string; content: string; base: string; conflictBlocks: ConflictBlock[]; side: 'source' | 'task' }) {
  const lineKinds = useMemo(() => {
    const kinds = changedLineKinds(props.base, props.content);
    markConflictSideLines(kinds, props.content, props.conflictBlocks, props.side);
    return kinds;
  }, [props.base, props.content, props.conflictBlocks, props.side]);
  return (
    <section className="task-git-conflict-code-pane">
      <strong>{props.title}</strong>
      <pre className="task-git-highlighted-code">{renderCodeLines(props.content, props.path, lineKinds)}</pre>
    </section>
  );
}

function HighlightedResultEditor(props: { title: string; path: string; content: string; base: string; disabled: boolean; revealOffset: number | null; onChange: (content: string) => void }) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLPreElement>(null);
  const deferredContent = useDeferredValue(props.content);
  const lineKinds = useMemo(() => {
    const kinds = changedLineKinds(props.base, deferredContent);
    for (const block of parseConflictBlocks(deferredContent)) {
      for (let line = block.startLine - 1; line < block.endLine; line += 1) kinds.set(line, 'conflict');
    }
    return kinds;
  }, [props.base, deferredContent]);

  useEffect(() => {
    if (props.revealOffset === null || !textareaRef.current) return;
    const line = props.content.slice(0, props.revealOffset).split('\n').length - 1;
    const nextTop = Math.max(0, line * 18.6 - textareaRef.current.clientHeight * 0.25);
    textareaRef.current.scrollTop = nextTop;
    if (highlightRef.current) highlightRef.current.scrollTop = nextTop;
  }, [props.revealOffset, props.content]);

  function syncScroll(): void {
    if (!textareaRef.current || !highlightRef.current) return;
    highlightRef.current.scrollTop = textareaRef.current.scrollTop;
    highlightRef.current.scrollLeft = textareaRef.current.scrollLeft;
  }

  return (
    <label className="task-git-conflict-result-pane">
      <strong>{props.title}</strong>
      <span className="task-git-conflict-edit-surface">
        <pre ref={highlightRef} className="task-git-highlighted-code" aria-hidden="true">
          {renderCodeLines(deferredContent, props.path, lineKinds)}
        </pre>
        <textarea ref={textareaRef} value={props.content} onChange={(event) => props.onChange(event.target.value)} onScroll={syncScroll} disabled={props.disabled} spellCheck={false} aria-label={props.title} />
      </span>
    </label>
  );
}

function parseConflictBlocks(content: string): ConflictBlock[] {
  const pattern = /^<<<<<<<[^\r\n]*(?:\r?\n|$)([\s\S]*?)(?:^\|\|\|\|\|\|\|[^\r\n]*(?:\r?\n|$)([\s\S]*?))?^=======[^\r\n]*(?:\r?\n|$)([\s\S]*?)^>>>>>>>[^\r\n]*(?:\r?\n|$)?/gmu;
  const blocks: ConflictBlock[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content))) {
    const start = match.index;
    const end = pattern.lastIndex;
    const startLine = countLines(content, start);
    blocks.push({
      id: `${start}:${end}:${match[1].length}:${match[3].length}`,
      start,
      end,
      startLine,
      endLine: startLine + countNewlines(match[0]),
      source: match[1],
      base: match[2] ?? null,
      task: match[3],
    });
  }
  return blocks;
}

function replaceConflictBlock(content: string, block: ConflictBlock, choice: ConflictChoice): string {
  const replacement = choice === 'source' ? block.source : choice === 'task' ? block.task : joinConflictSides(block.source, block.task);
  return `${content.slice(0, block.start)}${replacement}${content.slice(block.end)}`;
}

function joinConflictSides(source: string, task: string): string {
  if (!source) return task;
  if (!task) return source;
  return `${source}${source.endsWith('\n') || task.startsWith('\n') ? '' : '\n'}${task}`;
}

function resolveSimpleConflicts(content: string, fullBase: string): { content: string; resolved: number; remaining: number } {
  const blocks = parseConflictBlocks(content);
  let next = content;
  let resolved = 0;
  for (const block of [...blocks].reverse()) {
    const merged = block.base === null ? inferSimpleMerge(fullBase, block.source, block.task) : mergeSimpleBlock(block.base, block.source, block.task);
    if (merged === null) continue;
    next = `${next.slice(0, block.start)}${merged}${next.slice(block.end)}`;
    resolved += 1;
  }
  return { content: next, resolved, remaining: blocks.length - resolved };
}

function inferSimpleMerge(fullBaseInput: string, sourceInput: string, taskInput: string): string | null {
  const baseLines = normalizeLineEndings(fullBaseInput).split('\n');
  const sourceLineCount = blockLineCount(sourceInput);
  const taskLineCount = blockLineCount(taskInput);
  if (sourceLineCount === 0 || sourceLineCount !== taskLineCount || sourceLineCount > baseLines.length) return null;
  const lineEnding = sourceInput.includes('\r\n') || taskInput.includes('\r\n') || fullBaseInput.includes('\r\n') ? '\r\n' : '\n';
  const trailingLineEnding = /\r?\n$/u.test(sourceInput) || /\r?\n$/u.test(taskInput);
  const candidates = new Set<string>();
  for (let index = 0; index <= baseLines.length - sourceLineCount; index += 1) {
    const baseBlock = `${baseLines.slice(index, index + sourceLineCount).join(lineEnding)}${trailingLineEnding ? lineEnding : ''}`;
    if (!isPlausibleSimpleBase(baseBlock, sourceInput) || !isPlausibleSimpleBase(baseBlock, taskInput)) continue;
    const merged = mergeSimpleBlock(baseBlock, sourceInput, taskInput);
    if (merged !== null) candidates.add(merged);
    if (candidates.size > 1) return null;
  }
  return candidates.size === 1 ? [...candidates][0] : null;
}

function blockLineCount(content: string): number {
  const normalized = normalizeLineEndings(content);
  const withoutTrailingLineEnding = normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized;
  return withoutTrailingLineEnding ? withoutTrailingLineEnding.split('\n').length : 0;
}

function isPlausibleSimpleBase(baseInput: string, variantInput: string): boolean {
  const base = normalizeLineEndings(baseInput);
  const variant = normalizeLineEndings(variantInput);
  if (base === variant) return true;
  const edit = contiguousEdit(base, variant);
  const unchangedLength = base.length - (edit.end - edit.start);
  return unchangedLength >= Math.min(base.length, Math.max(4, Math.ceil(base.length * 0.4)));
}

function mergeSimpleBlock(baseInput: string, sourceInput: string, taskInput: string): string | null {
  if (sourceInput === taskInput) return sourceInput;
  if (sourceInput === baseInput) return taskInput;
  if (taskInput === baseInput) return sourceInput;
  const lineEnding = sourceInput.includes('\r\n') || taskInput.includes('\r\n') || baseInput.includes('\r\n') ? '\r\n' : '\n';
  const base = normalizeLineEndings(baseInput).split('\n');
  const source = normalizeLineEndings(sourceInput).split('\n');
  const task = normalizeLineEndings(taskInput).split('\n');
  if (base.length !== source.length || base.length !== task.length) return null;
  const merged: string[] = [];
  for (let index = 0; index < base.length; index += 1) {
    const line = mergeSimpleLine(base[index], source[index], task[index]);
    if (line === null) return null;
    merged.push(line);
  }
  return merged.join(lineEnding);
}

function mergeSimpleLine(base: string, source: string, task: string): string | null {
  if (source === task) return source;
  if (source === base) return task;
  if (task === base) return source;
  const sourceEdit = contiguousEdit(base, source);
  const taskEdit = contiguousEdit(base, task);
  if (sourceEdit.start === taskEdit.start && sourceEdit.end === taskEdit.end && sourceEdit.replacement === taskEdit.replacement) return source;
  const separate = sourceEdit.end <= taskEdit.start || taskEdit.end <= sourceEdit.start;
  const sameInsertionPoint = sourceEdit.start === sourceEdit.end && taskEdit.start === taskEdit.end && sourceEdit.start === taskEdit.start;
  if (!separate || sameInsertionPoint) return null;
  let result = base;
  const edits = [sourceEdit, taskEdit].sort((left, right) => right.start - left.start);
  for (const edit of edits) result = `${result.slice(0, edit.start)}${edit.replacement}${result.slice(edit.end)}`;
  return result;
}

function contiguousEdit(base: string, variant: string): { start: number; end: number; replacement: string } {
  let start = 0;
  while (start < base.length && start < variant.length && base[start] === variant[start]) start += 1;
  let baseEnd = base.length;
  let variantEnd = variant.length;
  while (baseEnd > start && variantEnd > start && base[baseEnd - 1] === variant[variantEnd - 1]) {
    baseEnd -= 1;
    variantEnd -= 1;
  }
  return { start, end: baseEnd, replacement: variant.slice(start, variantEnd) };
}

function changedLineKinds(baseContent: string, sideContent: string): Map<number, LineKind> {
  const baseLines = normalizeLineEndings(baseContent).split('\n');
  const sideLines = normalizeLineEndings(sideContent).split('\n');
  if (baseLines.length * sideLines.length > 4_000_000) return changedLineKindsForLargeFile(baseLines, sideLines);
  const operations = diffLines(baseLines, sideLines);
  const kinds = new Map<number, LineKind>();
  let sideLine = 0;
  let index = 0;
  while (index < operations.length) {
    if (operations[index].type === 'equal') {
      sideLine += 1;
      index += 1;
      continue;
    }
    let deleted = 0;
    const inserted: number[] = [];
    while (index < operations.length && operations[index].type !== 'equal') {
      if (operations[index].type === 'delete') deleted += 1;
      if (operations[index].type === 'insert') {
        inserted.push(sideLine);
        sideLine += 1;
      }
      index += 1;
    }
    for (const line of inserted) kinds.set(line, deleted > 0 ? 'modified' : 'added');
  }
  return kinds;
}

function changedLineKindsForLargeFile(baseLines: string[], sideLines: string[]): Map<number, LineKind> {
  const kinds = new Map<number, LineKind>();
  let prefix = 0;
  while (prefix < baseLines.length && prefix < sideLines.length && baseLines[prefix] === sideLines[prefix]) prefix += 1;
  let baseSuffix = baseLines.length - 1;
  let sideSuffix = sideLines.length - 1;
  while (baseSuffix >= prefix && sideSuffix >= prefix && baseLines[baseSuffix] === sideLines[sideSuffix]) {
    baseSuffix -= 1;
    sideSuffix -= 1;
  }
  const kind: LineKind = baseSuffix < prefix ? 'added' : 'modified';
  for (let line = prefix; line <= sideSuffix; line += 1) kinds.set(line, kind);
  return kinds;
}

function diffLines(before: string[], after: string[]): DiffOperation[] {
  const maximum = before.length + after.length;
  let frontier = new Map<number, number>([[1, 0]]);
  const trace: Array<Map<number, number>> = [];
  for (let distance = 0; distance <= maximum; distance += 1) {
    const next = new Map<number, number>();
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      const down = diagonal === -distance || (diagonal !== distance && (frontier.get(diagonal - 1) ?? -1) < (frontier.get(diagonal + 1) ?? -1));
      let x = down ? (frontier.get(diagonal + 1) ?? 0) : (frontier.get(diagonal - 1) ?? 0) + 1;
      let y = x - diagonal;
      while (x < before.length && y < after.length && before[x] === after[y]) {
        x += 1;
        y += 1;
      }
      next.set(diagonal, x);
      if (x >= before.length && y >= after.length) {
        trace.push(next);
        return backtrackDiff(trace, before, after);
      }
    }
    trace.push(next);
    frontier = next;
  }
  return [];
}

function backtrackDiff(trace: Array<Map<number, number>>, before: string[], after: string[]): DiffOperation[] {
  const operations: DiffOperation[] = [];
  let x = before.length;
  let y = after.length;
  for (let distance = trace.length - 1; distance > 0; distance -= 1) {
    const previous = trace[distance - 1];
    const diagonal = x - y;
    const down = diagonal === -distance || (diagonal !== distance && (previous.get(diagonal - 1) ?? -1) < (previous.get(diagonal + 1) ?? -1));
    const previousDiagonal = down ? diagonal + 1 : diagonal - 1;
    const previousX = previous.get(previousDiagonal) ?? 0;
    const previousY = previousX - previousDiagonal;
    while (x > previousX && y > previousY) {
      operations.push({ type: 'equal', text: before[x - 1] });
      x -= 1;
      y -= 1;
    }
    if (down) {
      operations.push({ type: 'insert', text: after[y - 1] });
      y -= 1;
    } else {
      operations.push({ type: 'delete', text: before[x - 1] });
      x -= 1;
    }
  }
  while (x > 0 && y > 0) {
    operations.push({ type: 'equal', text: before[x - 1] });
    x -= 1;
    y -= 1;
  }
  while (x > 0) {
    operations.push({ type: 'delete', text: before[x - 1] });
    x -= 1;
  }
  while (y > 0) {
    operations.push({ type: 'insert', text: after[y - 1] });
    y -= 1;
  }
  return operations.reverse();
}

function markConflictSideLines(kinds: Map<number, LineKind>, content: string, blocks: ConflictBlock[], side: 'source' | 'task'): void {
  const lines = normalizeLineEndings(content).split('\n');
  let cursor = 0;
  for (const block of blocks) {
    const needle = normalizeLineEndings(block[side])
      .split('\n')
      .filter((line, index, all) => !(index === all.length - 1 && line === ''));
    if (needle.length === 0) continue;
    const found = findLineSequence(lines, needle, cursor);
    if (found < 0) continue;
    for (let index = 0; index < needle.length; index += 1) kinds.set(found + index, 'conflict');
    cursor = found + needle.length;
  }
}

function findLineSequence(lines: string[], needle: string[], start: number): number {
  for (let index = start; index <= lines.length - needle.length; index += 1) {
    if (needle.every((line, offset) => lines[index + offset] === line)) return index;
  }
  return -1;
}

function renderCodeLines(content: string, path: string, lineKinds: Map<number, LineKind>): ReactNode[] {
  const lines = normalizeLineEndings(content).split('\n');
  return lines.map((line, index) => (
    <span key={index} className="task-git-code-line" data-kind={lineKinds.get(index)}>
      <span className="task-git-code-line-number">{index + 1}</span>
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
    `(${comment}|<!--.*?-->)|("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|\`(?:\\\\.|[^\`\\\\])*\`)|(\\b(?:0x[\\da-f]+|\\d+(?:\\.\\d+)?)\\b)|(\\b(?:abstract|async|await|boolean|break|case|catch|class|const|continue|def|default|delete|do|else|enum|export|extends|false|finally|for|from|function|if|implements|import|in|instanceof|interface|let|namespace|new|null|package|private|protected|public|return|static|string|super|switch|this|throw|true|try|type|typeof|undefined|var|void|while|with|yield)\\b)|(\\b[A-Za-z_$][\\w$]*(?=\\s*\\())|(<\\/?[A-Za-z][^>]*>)`,
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
