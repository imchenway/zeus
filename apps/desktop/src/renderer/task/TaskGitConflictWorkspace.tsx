import { MagicWand } from '@phosphor-icons/react/MagicWand';
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { TaskIntegrationConflictAiDraft, TaskIntegrationConflictFile, TaskIntegrationRecord } from '../session/sessionTypes.js';
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

interface MergeEdit {
  start: number;
  end: number;
  replacement: string[];
}

interface CodeSnippet {
  text: string;
  startOffset: number;
  endOffset: number;
  startLine: number;
  conflictStartLine: number;
  conflictEndLine: number;
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
  aiBusy: boolean;
  integration: TaskIntegrationRecord;
  taskBranch: string;
  conflictPath: string;
  conflict: TaskIntegrationConflictFile | null;
  resultContent: string;
  onSelectPath: (path: string) => void;
  onResultChange: (content: string) => void;
  onAskAi: () => Promise<TaskIntegrationConflictAiDraft>;
}) {
  const blocks = useMemo(() => parseConflictBlocks(props.resultContent), [props.resultContent]);
  const [selectedBlockIndex, setSelectedBlockIndex] = useState(0);
  const [viewMode, setViewMode] = useState<'focused' | 'full'>('focused');
  const [mergeFeedback, setMergeFeedback] = useState<string | null>(null);
  const [undoDraft, setUndoDraft] = useState<string | null>(null);
  const activeBlock = blocks[Math.min(selectedBlockIndex, Math.max(0, blocks.length - 1))] ?? null;

  useEffect(() => {
    setMergeFeedback(null);
    setSelectedBlockIndex(0);
    setViewMode('focused');
    setUndoDraft(null);
  }, [props.conflictPath]);

  useEffect(() => {
    if (selectedBlockIndex >= blocks.length && blocks.length > 0) setSelectedBlockIndex(blocks.length - 1);
  }, [blocks.length, selectedBlockIndex]);

  function chooseBlock(block: ConflictBlock, choice: ConflictChoice): void {
    setUndoDraft(props.resultContent);
    props.onResultChange(replaceConflictBlock(props.resultContent, block, choice));
    setMergeFeedback(props.zh ? `已处理第 ${blocks.indexOf(block) + 1} 个冲突块，保存前不会写入文件。` : `Conflict ${blocks.indexOf(block) + 1} resolved in the draft. The file is unchanged until you save.`);
  }

  function mergeSimpleConflicts(): void {
    const result = resolveSimpleConflictDraft(props.resultContent, props.conflict?.base ?? '');
    if (result.resolved > 0) {
      setUndoDraft(props.resultContent);
      props.onResultChange(result.content);
    }
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
    const before = props.resultContent;
    try {
      const result = await props.onAskAi();
      const next = applyConflictAiDraft(before, result.suggestions);
      if (next.applied === 0) {
        setMergeFeedback(props.zh ? 'AI 没有返回可应用的冲突块。' : 'AI did not return an applicable conflict block.');
        return;
      }
      setUndoDraft(before);
      props.onResultChange(next.content);
      const identity = `${result.agentKind === 'pi' ? 'Pi' : 'Codex'} · ${result.modelId}`;
      const explanations = result.suggestions.map((suggestion) => `${suggestion.index + 1}. ${suggestion.explanation}`).join('；');
      setMergeFeedback(
        props.zh ? `${identity} 已生成 ${next.applied} 个冲突草稿，保存前不会写入文件。${explanations ? ` ${explanations}` : ''}` : `${identity} drafted ${next.applied} conflict resolution(s). The file is unchanged until you save.`,
      );
    } catch {
      // 具体失败原因由代码交付弹窗统一展示，避免在两个状态区重复报错。
    }
  }

  function undoLastDraft(): void {
    if (undoDraft === null) return;
    props.onResultChange(undoDraft);
    setUndoDraft(null);
    setMergeFeedback(props.zh ? '已撤销上一次冲突草稿操作。' : 'The last conflict draft action was undone.');
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
            <Button variant="secondary" size="compact" onClick={undoLastDraft} disabled={props.busy || undoDraft === null}>
              {props.zh ? '撤销' : 'Undo'}
            </Button>
            <Button variant="secondary" size="compact" onClick={() => setViewMode((current) => (current === 'focused' ? 'full' : 'focused'))} disabled={!props.conflict}>
              {viewMode === 'focused' ? (props.zh ? '查看完整文件' : 'View full file') : props.zh ? '返回冲突' : 'Back to conflict'}
            </Button>
            <Button variant="secondary" size="compact" busy={props.aiBusy} onClick={() => void askAi()} disabled={!props.conflict || props.busy || blocks.length === 0}>
              {props.zh ? 'AI 处理' : 'Resolve with AI'}
            </Button>
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
              <section key={block.id} className={index === selectedBlockIndex ? 'is-active' : ''} aria-label={props.zh ? `冲突 ${index + 1}` : `Conflict ${index + 1}`}>
                <button type="button" className="task-git-conflict-block-location" onClick={() => setSelectedBlockIndex(index)}>
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

        {viewMode === 'full' ? (
          <FullFileColumns
            path={props.conflictPath}
            source={props.conflict?.source ?? ''}
            result={props.resultContent}
            task={props.conflict?.task ?? ''}
            disabled={!props.conflict || props.busy}
            targetTitle={props.zh ? '目标分支' : 'Target branch'}
            resultTitle={props.zh ? '合并结果' : 'Merge result'}
            taskTitle={props.zh ? '任务分支' : 'Task branch'}
            initialLine={activeBlock?.startLine ?? 1}
            onResultChange={props.onResultChange}
          />
        ) : activeBlock && props.conflict ? (
          <FocusedConflictColumns
            path={props.conflictPath}
            block={activeBlock}
            blockIndex={Math.min(selectedBlockIndex, blocks.length - 1)}
            blocks={blocks}
            source={props.conflict.source}
            result={props.resultContent}
            task={props.conflict.task}
            disabled={props.busy}
            targetTitle={props.zh ? '目标分支' : 'Target branch'}
            resultTitle={props.zh ? '合并结果' : 'Merge result'}
            taskTitle={props.zh ? '任务分支' : 'Task branch'}
            onResultChange={props.onResultChange}
          />
        ) : (
          <div className="task-git-conflict-review-complete">
            <strong>{props.zh ? '当前文件没有未解决冲突' : 'No unresolved conflicts remain'}</strong>
            <span>{props.zh ? '可以查看完整文件，或直接保存结果并继续。' : 'Review the full file or save the draft to continue.'}</span>
          </div>
        )}
      </main>
    </div>
  );
}

function FocusedConflictColumns(props: {
  path: string;
  block: ConflictBlock;
  blockIndex: number;
  blocks: ConflictBlock[];
  source: string;
  result: string;
  task: string;
  disabled: boolean;
  targetTitle: string;
  resultTitle: string;
  taskTitle: string;
  onResultChange: (content: string) => void;
}) {
  const sourceSnippet = useMemo(() => buildSideSnippet(props.source, props.blocks, props.blockIndex, 'source'), [props.source, props.blocks, props.blockIndex]);
  const taskSnippet = useMemo(() => buildSideSnippet(props.task, props.blocks, props.blockIndex, 'task'), [props.task, props.blocks, props.blockIndex]);
  const resultSnippet = useMemo(() => buildOffsetSnippet(props.result, props.block.start, props.block.end), [props.result, props.block.start, props.block.end]);
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
      <FocusedCodePane paneRef={sourceRef} title={props.targetTitle} path={props.path} snippet={sourceSnippet} onScroll={syncScroll} />
      <FocusedResultEditor
        textareaRef={resultRef}
        title={props.resultTitle}
        path={props.path}
        snippet={resultSnippet}
        disabled={props.disabled}
        onScroll={syncScroll}
        onChange={(content) => props.onResultChange(`${props.result.slice(0, resultSnippet.startOffset)}${content}${props.result.slice(resultSnippet.endOffset)}`)}
      />
      <FocusedCodePane paneRef={taskRef} title={props.taskTitle} path={props.path} snippet={taskSnippet} onScroll={syncScroll} />
    </div>
  );
}

function FocusedCodePane(props: { paneRef: RefObject<HTMLPreElement | null>; title: string; path: string; snippet: CodeSnippet; onScroll: (source: HTMLElement) => void }) {
  const lineKinds = useMemo(() => conflictLineKinds(props.snippet), [props.snippet]);
  return (
    <section className="task-git-conflict-code-pane">
      <strong>{props.title}</strong>
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
  const lineKinds = useMemo(() => {
    const kinds = new Map<number, LineKind>();
    for (const block of parseConflictBlocks(props.snippet.text)) {
      for (let line = block.startLine - 1; line < block.endLine; line += 1) kinds.set(line, 'conflict');
    }
    return kinds;
  }, [props.snippet.text]);

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
  source: string;
  result: string;
  task: string;
  disabled: boolean;
  targetTitle: string;
  resultTitle: string;
  taskTitle: string;
  initialLine: number;
  onResultChange: (content: string) => void;
}) {
  const sourceRef = useRef<HTMLTextAreaElement>(null);
  const resultRef = useRef<HTMLTextAreaElement>(null);
  const taskRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const top = Math.max(0, (props.initialLine - 4) * 18.6);
    for (const pane of [sourceRef.current, resultRef.current, taskRef.current]) if (pane) pane.scrollTop = top;
  }, [props.path, props.initialLine]);

  function syncScroll(source: HTMLTextAreaElement): void {
    for (const pane of [sourceRef.current, resultRef.current, taskRef.current]) {
      if (!pane || pane === source) continue;
      if (Math.abs(pane.scrollTop - source.scrollTop) > 1) pane.scrollTop = source.scrollTop;
    }
  }

  return (
    <div className="task-git-conflict-columns is-full">
      <FullFilePane textareaRef={sourceRef} title={props.targetTitle} content={props.source} readOnly onScroll={syncScroll} />
      <FullFilePane textareaRef={resultRef} title={props.resultTitle} content={props.result} readOnly={props.disabled} onChange={props.onResultChange} onScroll={syncScroll} />
      <FullFilePane textareaRef={taskRef} title={props.taskTitle} content={props.task} readOnly onScroll={syncScroll} />
    </div>
  );
}

function FullFilePane(props: { textareaRef: RefObject<HTMLTextAreaElement | null>; title: string; content: string; readOnly: boolean; onChange?: (content: string) => void; onScroll: (source: HTMLTextAreaElement) => void }) {
  return (
    <label className="task-git-conflict-code-pane task-git-conflict-full-pane">
      <strong>{props.title}</strong>
      <textarea
        ref={props.textareaRef}
        value={props.content}
        readOnly={props.readOnly}
        onChange={props.onChange ? (event) => props.onChange?.(event.target.value) : undefined}
        onScroll={(event) => props.onScroll(event.currentTarget)}
        spellCheck={false}
        aria-label={props.title}
      />
    </label>
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
  const conflictLineCount = Math.max(1, blockLineCount(content.slice(conflictStart, conflictEnd)));
  return {
    text: content.slice(startOffset, endOffset),
    startOffset,
    endOffset,
    startLine: countLines(content, startOffset),
    conflictStartLine,
    conflictEndLine: conflictStartLine + conflictLineCount,
  };
}

function buildSideSnippet(content: string, blocks: ConflictBlock[], blockIndex: number, side: 'source' | 'task'): CodeSnippet {
  let cursor = 0;
  let found = -1;
  for (let index = 0; index <= blockIndex; index += 1) {
    const needle = blocks[index]?.[side] ?? '';
    if (!needle) continue;
    found = content.indexOf(needle, cursor);
    if (found < 0) break;
    cursor = found + needle.length;
  }
  const selected = blocks[blockIndex]?.[side] ?? '';
  if (found < 0 && selected) found = content.indexOf(selected);
  if (found < 0) {
    const approximateOffset = Math.min(content.length, Math.max(0, lineStartOffset(content, blocks[blockIndex]?.startLine ?? 1)));
    return buildOffsetSnippet(content, approximateOffset, approximateOffset);
  }
  return buildOffsetSnippet(content, found, found + selected.length);
}

function conflictLineKinds(snippet: CodeSnippet): Map<number, LineKind> {
  const kinds = new Map<number, LineKind>();
  for (let line = snippet.conflictStartLine; line < snippet.conflictEndLine; line += 1) kinds.set(line, 'conflict');
  return kinds;
}

function lineStartOffset(content: string, lineNumber: number): number {
  if (lineNumber <= 1) return 0;
  let offset = 0;
  for (let line = 1; line < lineNumber; line += 1) {
    const next = content.indexOf('\n', offset);
    if (next < 0) return content.length;
    offset = next + 1;
  }
  return offset;
}

function applyConflictAiDraft(content: string, suggestions: TaskIntegrationConflictAiDraft['suggestions']): { content: string; applied: number } {
  const blocks = parseConflictBlocks(content);
  const unique = new Map<number, string>();
  for (const suggestion of suggestions) {
    if (!Number.isInteger(suggestion.index) || suggestion.index < 0 || suggestion.index >= blocks.length) continue;
    if (/^(?:<<<<<<<|=======|>>>>>>>)/mu.test(suggestion.content)) continue;
    unique.set(suggestion.index, suggestion.content);
  }
  let next = content;
  let applied = 0;
  for (const [index, replacement] of [...unique.entries()].sort((left, right) => right[0] - left[0])) {
    const block = blocks[index];
    next = `${next.slice(0, block.start)}${replacement}${next.slice(block.end)}`;
    applied += 1;
  }
  return { content: next, applied };
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
  if (sourceLineCount === 0 || taskLineCount === 0) return null;
  const lineEnding = sourceInput.includes('\r\n') || taskInput.includes('\r\n') || fullBaseInput.includes('\r\n') ? '\r\n' : '\n';
  const trailingLineEnding = /\r?\n$/u.test(sourceInput) || /\r?\n$/u.test(taskInput);
  const candidates = new Set<string>();
  const minimumWindow = Math.max(1, Math.min(sourceLineCount, taskLineCount) - 2);
  const maximumWindow = Math.min(baseLines.length, Math.max(sourceLineCount, taskLineCount) + 2);
  if (baseLines.length * Math.max(1, maximumWindow - minimumWindow + 1) > 200_000) return null;
  for (let lineCount = minimumWindow; lineCount <= maximumWindow; lineCount += 1) {
    for (let index = 0; index <= baseLines.length - lineCount; index += 1) {
      const baseBlock = `${baseLines.slice(index, index + lineCount).join(lineEnding)}${trailingLineEnding ? lineEnding : ''}`;
      if (!isPlausibleSimpleBase(baseBlock, sourceInput) || !isPlausibleSimpleBase(baseBlock, taskInput)) continue;
      const merged = mergeSimpleBlock(baseBlock, sourceInput, taskInput);
      if (merged !== null) candidates.add(merged);
      if (candidates.size > 1) return null;
    }
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
  const baseTokens = tokenizeMergeContent(base).filter((token) => !/^\s+$/u.test(token));
  const variantTokens = tokenizeMergeContent(variant).filter((token) => !/^\s+$/u.test(token));
  if (baseTokens.length === 0 || variantTokens.length === 0) return false;
  const unchanged = diffLines(baseTokens, variantTokens).filter((operation) => operation.type === 'equal').length;
  return unchanged >= Math.min(baseTokens.length, variantTokens.length) * 0.4;
}

function mergeSimpleBlock(baseInput: string, sourceInput: string, taskInput: string): string | null {
  if (sourceInput === taskInput) return sourceInput;
  if (sourceInput === baseInput) return taskInput;
  if (taskInput === baseInput) return sourceInput;
  const lineEnding = sourceInput.includes('\r\n') || taskInput.includes('\r\n') || baseInput.includes('\r\n') ? '\r\n' : '\n';
  const base = tokenizeMergeContent(normalizeLineEndings(baseInput));
  const source = tokenizeMergeContent(normalizeLineEndings(sourceInput));
  const task = tokenizeMergeContent(normalizeLineEndings(taskInput));
  if (base.length + source.length + task.length > 36_000) return null;
  const strict = mergeTokenChanges(base, source, task, false);
  if (strict !== null) return strict.join('').replace(/\n/gu, lineEnding);
  const whitespaceTolerant = mergeTokenChanges(base, source, task, true);
  return whitespaceTolerant === null ? null : whitespaceTolerant.join('').replace(/\n/gu, lineEnding);
}

function tokenizeMergeContent(content: string): string[] {
  return content.match(/\n|[ \t]+|[\p{L}\p{N}_$]+|[^\p{L}\p{N}_$ \t\n]/gu) ?? [];
}

function mergeTokenChanges(base: string[], source: string[], task: string[], ignoreWhitespace: boolean): string[] | null {
  const sourceEdits = buildMergeEdits(base, source, ignoreWhitespace);
  const taskEdits = buildMergeEdits(base, task, ignoreWhitespace);
  const edits: MergeEdit[] = [];
  for (const edit of [...sourceEdits, ...taskEdits]) {
    if (edits.some((existing) => sameMergeEdit(existing, edit))) continue;
    if (edits.some((existing) => mergeEditsConflict(existing, edit))) return null;
    edits.push(edit);
  }
  const result = [...base];
  edits.sort((left, right) => right.start - left.start || right.end - left.end).forEach((edit) => result.splice(edit.start, edit.end - edit.start, ...edit.replacement));
  return result;
}

function buildMergeEdits(base: string[], variant: string[], ignoreWhitespace: boolean): MergeEdit[] {
  const comparable = (token: string): string => (ignoreWhitespace && /^\s+$/u.test(token) ? ' ' : token);
  const operations = diffLines(base.map(comparable), variant.map(comparable));
  const edits: MergeEdit[] = [];
  let baseIndex = 0;
  let variantIndex = 0;
  let current: MergeEdit | null = null;
  const flush = (): void => {
    if (current) edits.push(current);
    current = null;
  };
  for (const operation of operations) {
    if (operation.type === 'equal') {
      flush();
      baseIndex += 1;
      variantIndex += 1;
    } else {
      current ??= { start: baseIndex, end: baseIndex, replacement: [] };
      if (operation.type === 'delete') {
        baseIndex += 1;
        current.end = baseIndex;
      } else {
        current.replacement.push(variant[variantIndex]);
        variantIndex += 1;
      }
    }
  }
  flush();
  return edits;
}

function sameMergeEdit(left: MergeEdit, right: MergeEdit): boolean {
  return left.start === right.start && left.end === right.end && left.replacement.length === right.replacement.length && left.replacement.every((token, index) => token === right.replacement[index]);
}

function mergeEditsConflict(left: MergeEdit, right: MergeEdit): boolean {
  const leftInsertion = left.start === left.end;
  const rightInsertion = right.start === right.end;
  if (leftInsertion && rightInsertion) return left.start === right.start;
  if (leftInsertion) return left.start >= right.start && left.start <= right.end;
  if (rightInsertion) return right.start >= left.start && right.start <= left.end;
  return left.start < right.end && right.start < left.end;
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
