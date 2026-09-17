import type { NativeSessionItemBuffer, NativeSessionState } from './sessionTypes.js';
import type { TranscriptRow, TranscriptTurnRow } from './ConversationTranscript.js';

/** 结构事件重新核对语义后，保留未变化条目与工具组的对象身份。 */
export function reuseTranscriptRows(previous: readonly TranscriptRow[], incoming: TranscriptRow[]): TranscriptRow[] {
  const byKey = new Map(previous.map((row) => [row.key, row]));
  return incoming.map((row) => {
    const old = byKey.get(row.key);
    if (!old || old.kind !== row.kind) return row;
    if (row.kind === 'item' && old.kind === 'item' && old.item === row.item && old.questionAnswer === row.questionAnswer) return old;
    if (row.kind === 'answered_request' && old.kind === 'answered_request' && old.request === row.request) return old;
    if (row.kind === 'activity' && old.kind === 'activity' && old.category === row.category && old.motionActive === row.motionActive && sameReferences(old.items, row.items)) return old;
    return row;
  });
}

/** 新条目、补页或轮次终态只替换实际改变的父组，其余阶段与过程块保持引用。 */
export function reuseTranscriptTurnRows(previous: readonly TranscriptTurnRow[], incoming: TranscriptTurnRow[]): TranscriptTurnRow[] {
  const byKey = new Map(previous.map((row) => [row.key, row]));
  return incoming.map((row) => {
    const old = byKey.get(row.key);
    if (row.kind !== 'turn_work' || old?.kind !== 'turn_work') return row;
    const oldSegments = new Map(old.segments.map((segment) => [segment.key, segment]));
    const segments = row.segments.map((segment) => {
      const before = oldSegments.get(segment.key);
      return before && before.summary === segment.summary && sameReferences(before.rows, segment.rows) ? before : segment;
    });
    return old.turnId === row.turnId && old.live === row.live && old.loadMore === row.loadMore && sameReferences(old.segments, segments) ? old : { ...row, segments };
  });
}

/** 只比较结构引用，不序列化正文或递归扫描载荷。 */
function sameReferences<T>(previous: readonly T[], incoming: readonly T[]): boolean {
  return previous.length === incoming.length && incoming.every((value, index) => value === previous[index]);
}

/** 内容批次的结构前提；正文、来源修订与更新时间不参与分组。 */
export function isTranscriptContentUpdate(previous: NativeSessionItemBuffer, next: NativeSessionItemBuffer): boolean {
  const before = previous.transcript?.placement;
  const after = next.transcript?.placement;
  return (
    previous.key === next.key &&
    previous.type === next.type &&
    previous.status === next.status &&
    previous.phase === next.phase &&
    previous.turnId === next.turnId &&
    previous.stageId === next.stageId &&
    previous.optimistic === next.optimistic &&
    before?.order === after?.order &&
    before?.openingInputId === after?.openingInputId &&
    before?.displayStageId === after?.displayStageId &&
    Boolean(previous.text.trim()) === Boolean(next.text.trim()) &&
    previous.resources === next.resources &&
    Object.keys(previous.payload).length === Object.keys(next.payload).length &&
    Object.keys(previous.payload).every((key) => previous.payload[key] === next.payload[key])
  );
}

/** 已投影条目及分组；索引仅在结构变化时重建。 */
export interface TranscriptProjection {
  state: NativeSessionState;
  context: readonly unknown[];
  items: NativeSessionItemBuffer[];
  rows: TranscriptRow[];
  turnRows: TranscriptTurnRow[];
  itemIndexes: ReadonlyMap<string, number>;
  rowIndexes: ReadonlyMap<string, readonly number[]>;
  turnIndexes: ReadonlyMap<string, readonly number[]>;
  rowKeys: string[];
}

/** 结构投影完成后建立反向位置索引，下一文本批次只触碰受影响条目及其父组。 */
export function createTranscriptProjection(state: NativeSessionState, context: readonly unknown[], items: NativeSessionItemBuffer[], rows: TranscriptRow[], turnRows: TranscriptTurnRow[]): TranscriptProjection {
  const rowIndexes = new Map<string, number[]>();
  const turnIndexes = new Map<string, number[]>();
  const register = (index: Map<string, number[]>, row: TranscriptRow, position: number): void => {
    const keys = row.kind === 'item' ? [row.item.key] : row.kind === 'activity' ? row.items.map((item) => item.key) : [];
    for (const key of keys) {
      const positions = index.get(key) ?? [];
      if (!positions.includes(position)) positions.push(position);
      index.set(key, positions);
    }
  };
  rows.forEach((row, index) => register(rowIndexes, row, index));
  turnRows.forEach((row, index) => {
    if (row.kind !== 'turn_work') register(turnIndexes, row, index);
    else
      for (const segment of row.segments) {
        if (segment.summary) register(turnIndexes, segment.summary, index);
        for (const child of segment.rows) register(turnIndexes, child, index);
      }
  });
  return { state, context, items, rows, turnRows, itemIndexes: new Map(items.map((item, index) => [item.key, index])), rowIndexes, turnIndexes, rowKeys: turnRows.map((row) => row.key) };
}

/** 使用有界变化记录更新内容；缺失记录或语义变化时回到完整结构投影。 */
export function updateTranscriptProjection(previous: TranscriptProjection | null, state: NativeSessionState, context: readonly unknown[]): TranscriptProjection | null {
  if (!previous || previous.context.length !== context.length || context.some((value, index) => value !== previous.context[index])) return null;
  if (previous.state.items === state.items) return { ...previous, state };
  const changes = state.transcriptContentChanges;
  if (!changes?.length || changes.at(-1)?.revision !== state.transcriptRevision || changes[0]!.revision > previous.state.transcriptRevision + 1) return null;
  const keys = new Set(changes.filter((change) => change.revision > previous.state.transcriptRevision).map((change) => change.key));
  if (!keys.size) return null;
  for (const key of keys) {
    const before = previous.state.items[key];
    const after = state.items[key];
    if (!before || !after || !isTranscriptContentUpdate(before, after)) return null;
  }
  const items = [...previous.items];
  const rows = [...previous.rows];
  const turnRows = [...previous.turnRows];
  /** 相同子行可能同时出现在过程与主序列，批次内只构造一次新对象。 */
  const updatedRows = new Map<TranscriptRow, TranscriptRow>();
  const updateRow = (row: TranscriptRow): TranscriptRow => {
    const cached = updatedRows.get(row);
    if (cached) return cached;
    let next = row;
    if (row.kind === 'item' && keys.has(row.item.key)) next = { ...row, item: state.items[row.item.key]! };
    else if (row.kind === 'activity' && row.items.some((item) => keys.has(item.key))) next = { ...row, items: row.items.map((item) => (keys.has(item.key) ? state.items[item.key]! : item)) };
    updatedRows.set(row, next);
    return next;
  };
  const affectedTurns = new Set<number>();
  for (const key of keys) {
    const index = previous.itemIndexes.get(key);
    if (index !== undefined) items[index] = state.items[key]!;
    for (const rowIndex of previous.rowIndexes.get(key) ?? []) rows[rowIndex] = updateRow(rows[rowIndex]!);
    for (const turnIndex of previous.turnIndexes.get(key) ?? []) affectedTurns.add(turnIndex);
  }
  for (const index of affectedTurns) {
    const row = turnRows[index]!;
    turnRows[index] =
      row.kind !== 'turn_work'
        ? updateRow(row)
        : {
            ...row,
            segments: row.segments.map((segment) => {
              const summary = segment.summary ? updateRow(segment.summary) : null;
              const children = segment.rows.map(updateRow);
              return summary === segment.summary && children.every((child, childIndex) => child === segment.rows[childIndex]) ? segment : { ...segment, summary, rows: children };
            }),
          };
  }
  return { ...previous, state, items, rows, turnRows };
}
