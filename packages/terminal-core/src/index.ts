export type TerminalEventStream = 'stdout' | 'stderr' | 'system';

export interface TerminalBufferEvent {
  seq: number;
  stream: TerminalEventStream;
  content: string;
  createdAt: string;
}

export interface AppendTerminalBufferChunkInput {
  stream: TerminalEventStream;
  chunk: unknown;
  createdAt: string;
  maxEvents?: number;
}

export interface AppendTerminalBufferChunkResult {
  events: TerminalBufferEvent[];
  appended: TerminalBufferEvent[];
  droppedCount: number;
}

/**
 * 将真实终端 chunk 转成适合索引、搜索和日志展示的文本；原始 ANSI 输出应由 raw log 保留。
 */
export function normalizeTerminalChunk(chunk: unknown): string {
  const text = chunk instanceof Uint8Array ? Buffer.from(chunk).toString('utf8') : String(chunk);
  // 独立回车符表示“回到当前行行首”，是 Git 等命令原地刷新百分比的真实终端语义，不能改成新行。
  return stripAnsiControlSequences(text).replace(/\r\n/g, '\n');
}

/**
 * 将已采集的终端文本投影为用户当时在终端中看到的结果。
 * 独立回车符会覆盖当前逻辑行，因此连续百分比只保留最后一次。
 */
export function projectTerminalOutput(input: string): string {
  const completedLines: string[] = [];
  let currentLine = '';
  for (const character of input) {
    if (character === '\r') {
      currentLine = '';
      continue;
    }
    if (character === '\n') {
      completedLines.push(currentLine);
      currentLine = '';
      continue;
    }
    if (character === '\b') {
      currentLine = currentLine.slice(0, -1);
      continue;
    }
    currentLine += character;
  }
  return completedLines.length > 0 ? `${completedLines.join('\n')}\n${currentLine}` : currentLine;
}

/**
 * 追加 terminal buffer 事件，并按最大事件数裁剪；seq 基于已有事实继续递增，不重排历史。
 */
export function appendTerminalBufferChunk(existingEvents: TerminalBufferEvent[], input: AppendTerminalBufferChunkInput): AppendTerminalBufferChunkResult {
  const maxEvents = input.maxEvents && input.maxEvents > 0 ? input.maxEvents : 500;
  const startSeq = existingEvents.reduce((max, event) => Math.max(max, event.seq), 0);
  const lines = projectTerminalOutput(normalizeTerminalChunk(input.chunk))
    .split('\n')
    .filter((line) => line.length > 0);
  const appended = lines.map((content, index) => ({
    seq: startSeq + index + 1,
    stream: input.stream,
    content,
    createdAt: input.createdAt,
  }));
  const combined = [...existingEvents, ...appended];
  const droppedCount = Math.max(0, combined.length - maxEvents);
  return { events: combined.slice(-maxEvents), appended, droppedCount };
}

const ESCAPE = String.fromCharCode(0x1b);
const BELL = String.fromCharCode(0x07);
const ansiOscPattern = new RegExp(`${ESCAPE}\\][^${BELL}]*(?:${BELL}|${ESCAPE}\\\\)`, 'gu');
const ansiCsiPattern = new RegExp(`${ESCAPE}\\[[0-?]*[ -/]*[@-~]`, 'gu');
const ansiCharsetPattern = new RegExp(`${ESCAPE}[()][A-Za-z0-9]`, 'gu');

function stripAnsiControlSequences(text: string): string {
  return text.replace(ansiOscPattern, '').replace(ansiCsiPattern, '').replace(ansiCharsetPattern, '');
}
