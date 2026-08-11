import type { TaskIntegrationConflictFile } from '../session/sessionTypes.js';

export type ConflictSide = 'source' | 'task';
export type ConflictSideState = 'pending' | 'accepted' | 'ignored';
export type ConflictBlockStatus = 'pending' | 'resolved' | 'manual';
export type SimpleConflictFailureReason = 'base_unavailable' | 'same_position_insertions' | 'overlapping_changes' | 'content_too_large';

export interface SimpleConflictResolution {
  document: ConflictDocument;
  resolved: number;
  remaining: number;
  failureReasons: Partial<Record<SimpleConflictFailureReason, number>>;
}

export interface ConflictBlock {
  id: string;
  fingerprint: string;
  occurrence: number;
  sourceOccurrence: number;
  taskOccurrence: number;
  rawStart: number;
  rawEnd: number;
  startLine: number;
  endLine: number;
  source: string;
  base: string;
  baseAvailable: boolean;
  task: string;
  visibleStart: number;
  visibleEnd: number;
  visibleText: string;
  sourceStart: number;
  sourceEnd: number;
  taskStart: number;
  taskEnd: number;
  sourceState: ConflictSideState;
  taskState: ConflictSideState;
  status: ConflictBlockStatus;
  combinationError: boolean;
}

export interface ConflictDocument {
  path: string;
  fingerprint: string;
  rawContent: string;
  visibleContent: string;
  source: string;
  base: string;
  task: string;
  blocks: ConflictBlock[];
}

interface RawConflictBlock {
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

interface SimpleBlockMergeResult {
  content: string | null;
  reason: SimpleConflictFailureReason | null;
}

interface TokenMergeResult {
  content: string[] | null;
  reason: Extract<SimpleConflictFailureReason, 'same_position_insertions' | 'overlapping_changes'> | null;
}

export function countConflictBlocks(content: string): number {
  return parseRawConflictBlocks(content).length;
}

export function createConflictDocument(conflict: TaskIntegrationConflictFile): ConflictDocument {
  const rawContent = conflict.result;
  const rawBlocks = parseRawConflictBlocks(rawContent);
  const wholeOccurrences = new Map<string, number>();
  const sourceOccurrences = new Map<string, number>();
  const taskOccurrences = new Map<string, number>();
  const blocks: ConflictBlock[] = [];
  let visibleContent = '';
  let rawCursor = 0;

  for (const rawBlock of rawBlocks) {
    visibleContent += rawContent.slice(rawCursor, rawBlock.start);
    const sourceFingerprint = stableTextFingerprint(rawBlock.source);
    const taskFingerprint = stableTextFingerprint(rawBlock.task);
    const fingerprint = stableTextFingerprint(`${rawBlock.base ?? ''}\u0000${rawBlock.source}\u0000${rawBlock.task}`);
    const occurrence = wholeOccurrences.get(fingerprint) ?? 0;
    const sourceOccurrence = sourceOccurrences.get(sourceFingerprint) ?? 0;
    const taskOccurrence = taskOccurrences.get(taskFingerprint) ?? 0;
    wholeOccurrences.set(fingerprint, occurrence + 1);
    sourceOccurrences.set(sourceFingerprint, sourceOccurrence + 1);
    taskOccurrences.set(taskFingerprint, taskOccurrence + 1);

    const inferredBase = rawBlock.base === null ? inferConflictBase(conflict.base, rawBlock.source, rawBlock.task) : rawBlock.base;
    const baseAvailable = inferredBase !== null;
    const visibleText = inferredBase ?? '';
    const visibleStart = visibleContent.length;
    visibleContent += visibleText;
    const visibleEnd = visibleContent.length;
    const sourceRange = findStableOccurrence(conflict.source, rawBlock.source, sourceOccurrence);
    const taskRange = findStableOccurrence(conflict.task, rawBlock.task, taskOccurrence);

    blocks.push({
      id: `${fingerprint}:${occurrence}`,
      fingerprint,
      occurrence,
      sourceOccurrence,
      taskOccurrence,
      rawStart: rawBlock.start,
      rawEnd: rawBlock.end,
      startLine: rawBlock.startLine,
      endLine: rawBlock.endLine,
      source: rawBlock.source,
      base: visibleText,
      baseAvailable,
      task: rawBlock.task,
      visibleStart,
      visibleEnd,
      visibleText,
      sourceStart: sourceRange?.start ?? -1,
      sourceEnd: sourceRange?.end ?? -1,
      taskStart: taskRange?.start ?? -1,
      taskEnd: taskRange?.end ?? -1,
      sourceState: 'pending',
      taskState: 'pending',
      status: 'pending',
      combinationError: false,
    });
    rawCursor = rawBlock.end;
  }
  visibleContent += rawContent.slice(rawCursor);

  return {
    path: conflict.path,
    fingerprint: conflict.fingerprint,
    rawContent,
    visibleContent,
    source: conflict.source,
    base: conflict.base,
    task: conflict.task,
    blocks,
  };
}

export function countUnresolvedConflictBlocks(document: ConflictDocument | null): number {
  return document?.blocks.filter((block) => block.status === 'pending').length ?? 0;
}

export function serializeConflictForGit(document: ConflictDocument): string {
  return document.visibleContent;
}

export function serializeConflictForAi(document: ConflictDocument): string {
  let content = document.visibleContent;
  const pendingBlocks = document.blocks.filter((block) => block.status === 'pending');
  for (const block of [...pendingBlocks].sort((left, right) => right.visibleStart - left.visibleStart)) {
    const source = block.sourceState === 'ignored' ? block.base : block.source;
    const task = block.taskState === 'ignored' ? block.base : block.task;
    const base = block.baseAvailable ? `||||||| base\n${block.base}` : '';
    const marker = `<<<<<<< target\n${source}${base ? `\n${base}` : ''}\n=======\n${task}\n>>>>>>> task\n`;
    content = `${content.slice(0, block.visibleStart)}${marker}${content.slice(block.visibleEnd)}`;
  }
  return content;
}

export function applyConflictSideAction(document: ConflictDocument, blockId: string, side: ConflictSide, action: Exclude<ConflictSideState, 'pending'>): ConflictDocument {
  const index = document.blocks.findIndex((block) => block.id === blockId);
  if (index < 0) return document;
  const block = document.blocks[index];
  const nextBlock = {
    ...block,
    sourceState: side === 'source' ? action : block.sourceState,
    taskState: side === 'task' ? action : block.taskState,
    combinationError: false,
  };
  const resolution = resolveBlockText(nextBlock);
  nextBlock.visibleText = resolution.text;
  nextBlock.status = resolution.status;
  nextBlock.combinationError = resolution.combinationError;
  return replaceBlock(document, index, resolution.text, nextBlock);
}

export function applyConflictDocumentEdit(document: ConflictDocument, nextContent: string): ConflictDocument {
  if (nextContent === document.visibleContent) return document;
  const before = document.visibleContent;
  let prefix = 0;
  while (prefix < before.length && prefix < nextContent.length && before[prefix] === nextContent[prefix]) prefix += 1;
  let beforeEnd = before.length;
  let nextEnd = nextContent.length;
  while (beforeEnd > prefix && nextEnd > prefix && before[beforeEnd - 1] === nextContent[nextEnd - 1]) {
    beforeEnd -= 1;
    nextEnd -= 1;
  }
  const affected = document.blocks.filter((block) => block.visibleStart < beforeEnd && block.visibleEnd > prefix);
  const insertionAtBlockStart = beforeEnd === prefix && document.blocks.some((block) => block.visibleStart === prefix && block.visibleEnd > prefix);
  if (insertionAtBlockStart) {
    const block = document.blocks.find((candidate) => candidate.visibleStart === prefix && candidate.visibleEnd > prefix);
    if (block) affected.push(block);
  }

  const delta = nextEnd - beforeEnd;
  const blocks = document.blocks.map((block) => {
    if (affected.some((candidate) => candidate.id === block.id)) {
      return { ...block, status: 'manual' as const, combinationError: false };
    }
    if (block.visibleStart >= beforeEnd) {
      return { ...block, visibleStart: block.visibleStart + delta, visibleEnd: block.visibleEnd + delta };
    }
    return block;
  });

  if (affected.length > 0) {
    const first = affected.reduce((candidate, block) => (block.visibleStart < candidate.visibleStart ? block : candidate));
    const last = affected.reduce((candidate, block) => (block.visibleEnd > candidate.visibleEnd ? block : candidate));
    const firstIndex = blocks.findIndex((block) => block.id === first.id);
    const replacementStart = first.visibleStart;
    const replacementEnd = replacementStart + (nextEnd - prefix + (prefix - replacementStart));
    const nextBlocks = blocks.map((block, index) => {
      if (index === firstIndex) {
        return { ...block, visibleStart: replacementStart, visibleEnd: replacementEnd, visibleText: nextContent.slice(replacementStart, replacementEnd), status: 'manual' as const };
      }
      if (block.visibleStart >= first.visibleStart && block.visibleEnd <= last.visibleEnd && affected.some((candidate) => candidate.id === block.id)) {
        return { ...block, visibleStart: replacementEnd, visibleEnd: replacementEnd, visibleText: '', status: 'manual' as const };
      }
      return block;
    });
    return { ...document, visibleContent: nextContent, blocks: nextBlocks };
  }
  return { ...document, visibleContent: nextContent, blocks };
}

export function resolveSimpleConflictDocument(document: ConflictDocument): SimpleConflictResolution {
  let next = document;
  let resolved = 0;
  const failureReasons: Partial<Record<SimpleConflictFailureReason, number>> = {};
  for (const block of [...document.blocks].sort((left, right) => right.visibleStart - left.visibleStart)) {
    if (block.status !== 'pending') continue;
    const result = block.baseAvailable ? tryMergeSimpleBlock(block.base, block.source, block.task) : { content: null, reason: 'base_unavailable' as const };
    if (result.content === null) {
      if (result.reason) failureReasons[result.reason] = (failureReasons[result.reason] ?? 0) + 1;
      continue;
    }
    const resolvedBlock = {
      ...block,
      visibleText: result.content,
      sourceState: 'accepted' as const,
      taskState: 'accepted' as const,
      status: 'resolved' as const,
      combinationError: false,
    };
    const index = next.blocks.findIndex((candidate) => candidate.id === block.id);
    next = replaceBlock(next, index, result.content, resolvedBlock);
    resolved += 1;
  }
  return { document: next, resolved, remaining: countUnresolvedConflictBlocks(next), failureReasons };
}

export function resolveSimpleConflictDraft(content: string, fullBase: string): { content: string; resolved: number; remaining: number } {
  const blocks = parseRawConflictBlocks(content);
  let next = content;
  let resolved = 0;
  for (const block of [...blocks].reverse()) {
    const base = block.base ?? inferConflictBase(fullBase, block.source, block.task);
    if (base === null) continue;
    const merged = mergeSimpleBlock(base, block.source, block.task);
    if (merged === null) continue;
    next = `${next.slice(0, block.start)}${merged}${next.slice(block.end)}`;
    resolved += 1;
  }
  return { content: next, resolved, remaining: blocks.length - resolved };
}

function replaceBlock(document: ConflictDocument, index: number, replacement: string, replacementBlock: ConflictBlock): ConflictDocument {
  if (index < 0) return document;
  const current = document.blocks[index];
  const delta = replacement.length - (current.visibleEnd - current.visibleStart);
  const visibleContent = `${document.visibleContent.slice(0, current.visibleStart)}${replacement}${document.visibleContent.slice(current.visibleEnd)}`;
  const blocks = document.blocks.map((block, blockIndex) => {
    if (blockIndex === index) return { ...replacementBlock, visibleStart: current.visibleStart, visibleEnd: current.visibleStart + replacement.length, visibleText: replacement };
    if (block.visibleStart >= current.visibleEnd) return { ...block, visibleStart: block.visibleStart + delta, visibleEnd: block.visibleEnd + delta };
    return block;
  });
  return { ...document, visibleContent, blocks };
}

function resolveBlockText(block: ConflictBlock): { text: string; status: ConflictBlockStatus; combinationError: boolean } {
  const sourceAccepted = block.sourceState === 'accepted';
  const taskAccepted = block.taskState === 'accepted';
  const sourceDone = block.sourceState !== 'pending';
  const taskDone = block.taskState !== 'pending';
  if (sourceAccepted && taskAccepted) {
    const merged = mergeSimpleBlock(block.base, block.source, block.task);
    return merged === null ? { text: block.visibleText, status: 'pending', combinationError: true } : { text: merged, status: 'resolved', combinationError: false };
  }
  if (sourceDone && taskDone) {
    if (sourceAccepted) return { text: block.source, status: 'resolved', combinationError: false };
    if (taskAccepted) return { text: block.task, status: 'resolved', combinationError: false };
    return { text: block.base, status: 'resolved', combinationError: false };
  }
  if (sourceAccepted) return { text: block.source, status: 'pending', combinationError: false };
  if (taskAccepted) return { text: block.task, status: 'pending', combinationError: false };
  return { text: block.base, status: 'pending', combinationError: false };
}

function parseRawConflictBlocks(content: string): RawConflictBlock[] {
  const pattern = /^<<<<<<<[^\r\n]*(?:\r?\n|$)([\s\S]*?)(?:^\|\|\|\|\|\|\|[^\r\n]*(?:\r?\n|$)([\s\S]*?))?^=======[^\r\n]*(?:\r?\n|$)([\s\S]*?)^>>>>>>>[^\r\n]*(?:\r?\n|$)?/gmu;
  const blocks: RawConflictBlock[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content))) {
    const start = match.index;
    const end = pattern.lastIndex;
    const startLine = countLines(content, start);
    blocks.push({ start, end, startLine, endLine: startLine + countNewlines(match[0]), source: match[1], base: match[2] ?? null, task: match[3] });
  }
  return blocks;
}

function stableTextFingerprint(value: string): string {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return `${(hash >>> 0).toString(16)}-${value.length}`;
}

function findStableOccurrence(content: string, needle: string, occurrence: number): { start: number; end: number } | null {
  if (!needle) return { start: 0, end: 0 };
  let seen = 0;
  for (let index = 0; index <= content.length - needle.length; index += 1) {
    if (index > 0 && content[index - 1] !== '\n') continue;
    if (!content.startsWith(needle, index)) continue;
    if (seen === occurrence) return { start: index, end: index + needle.length };
    seen += 1;
  }
  seen = 0;
  for (let index = 0; index <= content.length - needle.length; index += 1) {
    if (!content.startsWith(needle, index)) continue;
    if (seen === occurrence) return { start: index, end: index + needle.length };
    seen += 1;
  }
  return null;
}

function inferConflictBase(fullBaseInput: string, sourceInput: string, taskInput: string): string | null {
  if (sourceInput === taskInput) return sourceInput;
  if (!fullBaseInput) return null;
  const baseLines = normalizeLineEndings(fullBaseInput).split('\n');
  const sourceLineCount = blockLineCount(sourceInput);
  const taskLineCount = blockLineCount(taskInput);
  if (sourceLineCount === 0 && taskLineCount === 0) return '';
  const lineEnding = sourceInput.includes('\r\n') || taskInput.includes('\r\n') || fullBaseInput.includes('\r\n') ? '\r\n' : '\n';
  const trailingLineEnding = /\r?\n$/u.test(sourceInput) || /\r?\n$/u.test(taskInput);
  const candidates = new Map<string, { score: number; lineCount: number }>();
  const targetLineCount = Math.max(sourceLineCount, taskLineCount);
  const minimumWindow = Math.max(1, Math.min(Math.max(1, sourceLineCount), Math.max(1, taskLineCount)) - 2);
  const maximumWindow = Math.min(baseLines.length, Math.max(sourceLineCount, taskLineCount) + 2);
  if (baseLines.length * Math.max(1, maximumWindow - minimumWindow + 1) > 200_000) return null;
  for (let lineCount = minimumWindow; lineCount <= maximumWindow; lineCount += 1) {
    for (let index = 0; index <= baseLines.length - lineCount; index += 1) {
      const candidate = `${baseLines.slice(index, index + lineCount).join(lineEnding)}${trailingLineEnding ? lineEnding : ''}`;
      const plausible = isPlausibleSimpleBase(candidate, sourceInput) && isPlausibleSimpleBase(candidate, taskInput);
      if (!plausible && lineCount !== targetLineCount) continue;
      if (candidate === sourceInput || candidate === taskInput) return candidate;
      candidates.set(candidate, { score: baseSimilarity(candidate, sourceInput) + baseSimilarity(candidate, taskInput), lineCount });
    }
  }
  const ranked = [...candidates.entries()].sort((left, right) => Math.abs(left[1].lineCount - targetLineCount) - Math.abs(right[1].lineCount - targetLineCount) || right[1].score - left[1].score || right[0].length - left[0].length);
  return ranked[0]?.[0] ?? null;
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

function baseSimilarity(baseInput: string, variantInput: string): number {
  const baseTokens = tokenizeMergeContent(normalizeLineEndings(baseInput)).filter((token) => !/^\s+$/u.test(token));
  const variantTokens = tokenizeMergeContent(normalizeLineEndings(variantInput)).filter((token) => !/^\s+$/u.test(token));
  if (baseTokens.length === 0 || variantTokens.length === 0) return 0;
  return diffLines(baseTokens, variantTokens).filter((operation) => operation.type === 'equal').length / Math.min(baseTokens.length, variantTokens.length);
}

function mergeSimpleBlock(baseInput: string, sourceInput: string, taskInput: string): string | null {
  return tryMergeSimpleBlock(baseInput, sourceInput, taskInput).content;
}

function tryMergeSimpleBlock(baseInput: string, sourceInput: string, taskInput: string): SimpleBlockMergeResult {
  if (sourceInput === taskInput) return { content: sourceInput, reason: null };
  if (sourceInput === baseInput) return { content: taskInput, reason: null };
  if (taskInput === baseInput) return { content: sourceInput, reason: null };
  const lineEnding = sourceInput.includes('\r\n') || taskInput.includes('\r\n') || baseInput.includes('\r\n') ? '\r\n' : '\n';
  const base = tokenizeMergeContent(normalizeLineEndings(baseInput));
  const source = tokenizeMergeContent(normalizeLineEndings(sourceInput));
  const task = tokenizeMergeContent(normalizeLineEndings(taskInput));
  if (base.length + source.length + task.length > 36_000) return { content: null, reason: 'content_too_large' };
  const sourceSemantic = withoutWhitespace(source);
  const taskSemantic = withoutWhitespace(task);
  if (sameTokens(sourceSemantic, taskSemantic)) {
    if (canPreferCosmeticVariant(baseInput, sourceInput, taskInput)) {
      const content = sourceInput.length <= taskInput.length ? sourceInput : taskInput;
      return { content, reason: null };
    }
    return { content: null, reason: 'overlapping_changes' };
  }
  const strict = mergeTokenChanges(base, source, task, false);
  if (strict.content !== null) return { content: strict.content.join('').replace(/\n/gu, lineEnding), reason: null };
  const whitespaceTolerant = mergeTokenChanges(base, source, task, true);
  if (whitespaceTolerant.content === null) return { content: null, reason: whitespaceTolerant.reason };

  // 忽略空白只用于寻找对齐点；最终语义令牌必须与严格三方合并一致，避免重复插入正文。
  const semantic = mergeTokenChanges(withoutWhitespace(base), sourceSemantic, taskSemantic, false);
  if (semantic.content === null || !sameTokens(withoutWhitespace(whitespaceTolerant.content), semantic.content)) {
    return { content: null, reason: semantic.reason ?? strict.reason ?? 'overlapping_changes' };
  }
  return { content: whitespaceTolerant.content.join('').replace(/\n/gu, lineEnding), reason: null };
}

function tokenizeMergeContent(content: string): string[] {
  return content.match(/\n|[ \t]+|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]|[\p{L}\p{N}_$]+|[^\p{L}\p{N}_$ \t\n]/gu) ?? [];
}

function mergeTokenChanges(base: string[], source: string[], task: string[], ignoreWhitespace: boolean): TokenMergeResult {
  const sourceEdits = buildMergeEdits(base, source, ignoreWhitespace);
  const taskEdits = buildMergeEdits(base, task, ignoreWhitespace);
  const edits: MergeEdit[] = [];
  for (const edit of [...sourceEdits, ...taskEdits]) {
    if (edits.some((existing) => sameMergeEdit(existing, edit))) continue;
    const conflicting = edits.find((existing) => mergeEditsConflict(existing, edit));
    if (conflicting) {
      const samePositionInsertions = conflicting.start === conflicting.end && edit.start === edit.end && conflicting.start === edit.start;
      return { content: null, reason: samePositionInsertions ? 'same_position_insertions' : 'overlapping_changes' };
    }
    edits.push(edit);
  }
  const result = [...base];
  edits.sort((left, right) => right.start - left.start || right.end - left.end).forEach((edit) => result.splice(edit.start, edit.end - edit.start, ...edit.replacement));
  return { content: result, reason: null };
}

function withoutWhitespace(tokens: string[]): string[] {
  return tokens.filter((token) => !/^\s+$/u.test(token));
}

function sameTokens(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((token, index) => token === right[index]);
}

function canPreferCosmeticVariant(base: string, source: string, task: string): boolean {
  const normalizedSource = normalizeLineEndings(source);
  const normalizedTask = normalizeLineEndings(task);
  if (/['"`]/u.test(`${normalizedSource}${normalizedTask}`)) return false;
  const sourceLines = normalizedSource.split('\n');
  const taskLines = normalizedTask.split('\n');
  if (sourceLines.length === taskLines.length) {
    return sourceLines.every((line, index) => line.match(/^[ \t]*/u)?.[0] === taskLines[index].match(/^[ \t]*/u)?.[0]);
  }
  const normalizedBase = normalizeLineEndings(base);
  return normalizedBase.endsWith('\n') && normalizedSource === normalizedBase.slice(0, -1) && normalizedTask === `\n${normalizedSource}`;
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
  // Myers 最短编辑路径避免中等冲突块落入旧的二维矩阵上限。
  const maximum = before.length + after.length;
  let frontier = new Map<number, number>([[1, 0]]);
  const trace: Array<Map<number, number>> = [];
  for (let distance = 0; distance <= maximum; distance += 1) {
    const next = new Map<number, number>();
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      const down = diagonal === -distance || (diagonal !== distance && (frontier.get(diagonal - 1) ?? -1) < (frontier.get(diagonal + 1) ?? -1));
      let beforeIndex = down ? (frontier.get(diagonal + 1) ?? 0) : (frontier.get(diagonal - 1) ?? 0) + 1;
      let afterIndex = beforeIndex - diagonal;
      while (beforeIndex < before.length && afterIndex < after.length && before[beforeIndex] === after[afterIndex]) {
        beforeIndex += 1;
        afterIndex += 1;
      }
      next.set(diagonal, beforeIndex);
      if (beforeIndex >= before.length && afterIndex >= after.length) {
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
  let beforeIndex = before.length;
  let afterIndex = after.length;
  for (let distance = trace.length - 1; distance > 0; distance -= 1) {
    const previous = trace[distance - 1];
    const diagonal = beforeIndex - afterIndex;
    const down = diagonal === -distance || (diagonal !== distance && (previous.get(diagonal - 1) ?? -1) < (previous.get(diagonal + 1) ?? -1));
    const previousDiagonal = down ? diagonal + 1 : diagonal - 1;
    const previousBeforeIndex = previous.get(previousDiagonal) ?? 0;
    const previousAfterIndex = previousBeforeIndex - previousDiagonal;
    while (beforeIndex > previousBeforeIndex && afterIndex > previousAfterIndex) {
      operations.push({ type: 'equal', text: before[beforeIndex - 1] });
      beforeIndex -= 1;
      afterIndex -= 1;
    }
    if (down) {
      operations.push({ type: 'insert', text: after[afterIndex - 1] });
      afterIndex -= 1;
    } else {
      operations.push({ type: 'delete', text: before[beforeIndex - 1] });
      beforeIndex -= 1;
    }
  }
  while (beforeIndex > 0 && afterIndex > 0) {
    operations.push({ type: 'equal', text: before[beforeIndex - 1] });
    beforeIndex -= 1;
    afterIndex -= 1;
  }
  while (beforeIndex > 0) {
    operations.push({ type: 'delete', text: before[beforeIndex - 1] });
    beforeIndex -= 1;
  }
  while (afterIndex > 0) {
    operations.push({ type: 'insert', text: after[afterIndex - 1] });
    afterIndex -= 1;
  }
  return operations.reverse();
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
