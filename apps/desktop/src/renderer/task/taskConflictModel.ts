import type { TaskIntegrationConflictAiDraft, TaskIntegrationConflictFile } from '../session/sessionTypes.js';

export type ConflictSide = 'source' | 'task';
export type ConflictSideState = 'pending' | 'accepted' | 'ignored';
export type ConflictBlockStatus = 'pending' | 'resolved' | 'manual';

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

export function resolveSimpleConflictDocument(document: ConflictDocument): { document: ConflictDocument; resolved: number; remaining: number } {
  let next = document;
  let resolved = 0;
  for (const block of [...document.blocks].sort((left, right) => right.visibleStart - left.visibleStart)) {
    if (block.status !== 'pending') continue;
    const merged = mergeSimpleBlock(block.base, block.source, block.task);
    if (merged === null) continue;
    const resolvedBlock = {
      ...block,
      visibleText: merged,
      sourceState: 'accepted' as const,
      taskState: 'accepted' as const,
      status: 'resolved' as const,
      combinationError: false,
    };
    const index = next.blocks.findIndex((candidate) => candidate.id === block.id);
    next = replaceBlock(next, index, merged, resolvedBlock);
    resolved += 1;
  }
  return { document: next, resolved, remaining: countUnresolvedConflictBlocks(next) };
}

export function applyConflictAiDraft(document: ConflictDocument, suggestions: TaskIntegrationConflictAiDraft['suggestions']): { document: ConflictDocument; applied: number } {
  const pending = document.blocks.filter((block) => block.status === 'pending');
  const unique = new Map<number, string>();
  for (const suggestion of suggestions) {
    if (!Number.isInteger(suggestion.index) || suggestion.index < 0 || suggestion.index >= pending.length) continue;
    if (/^(?:<<<<<<<|=======|>>>>>>>)/mu.test(suggestion.content)) continue;
    unique.set(suggestion.index, suggestion.content);
  }
  let next = document;
  let applied = 0;
  for (const [suggestionIndex, replacement] of [...unique.entries()].sort((left, right) => right[0] - left[0])) {
    const block = pending[suggestionIndex];
    const index = next.blocks.findIndex((candidate) => candidate.id === block.id);
    if (index < 0) continue;
    const nextBlock = { ...next.blocks[index], visibleText: replacement, status: 'manual' as const, combinationError: false };
    next = replaceBlock(next, index, replacement, nextBlock);
    applied += 1;
  }
  return { document: next, applied };
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
  if (before.length === 0) return after.map((text) => ({ type: 'insert' as const, text }));
  if (after.length === 0) return before.map((text) => ({ type: 'delete' as const, text }));
  if (before.length * after.length > 200_000) {
    return [...before.map((text) => ({ type: 'delete' as const, text })), ...after.map((text) => ({ type: 'insert' as const, text }))];
  }
  const table = Array.from({ length: before.length + 1 }, () => new Uint32Array(after.length + 1));
  for (let beforeIndex = before.length - 1; beforeIndex >= 0; beforeIndex -= 1) {
    for (let afterIndex = after.length - 1; afterIndex >= 0; afterIndex -= 1) {
      table[beforeIndex][afterIndex] = before[beforeIndex] === after[afterIndex] ? table[beforeIndex + 1][afterIndex + 1] + 1 : Math.max(table[beforeIndex + 1][afterIndex], table[beforeIndex][afterIndex + 1]);
    }
  }
  const operations: DiffOperation[] = [];
  let beforeIndex = 0;
  let afterIndex = 0;
  while (beforeIndex < before.length && afterIndex < after.length) {
    if (before[beforeIndex] === after[afterIndex]) {
      operations.push({ type: 'equal', text: before[beforeIndex] });
      beforeIndex += 1;
      afterIndex += 1;
    } else if (table[beforeIndex + 1][afterIndex] >= table[beforeIndex][afterIndex + 1]) {
      operations.push({ type: 'delete', text: before[beforeIndex] });
      beforeIndex += 1;
    } else {
      operations.push({ type: 'insert', text: after[afterIndex] });
      afterIndex += 1;
    }
  }
  while (beforeIndex < before.length) {
    operations.push({ type: 'delete', text: before[beforeIndex] });
    beforeIndex += 1;
  }
  while (afterIndex < after.length) {
    operations.push({ type: 'insert', text: after[afterIndex] });
    afterIndex += 1;
  }
  return operations;
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
