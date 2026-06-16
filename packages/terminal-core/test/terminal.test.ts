import { describe, expect, it } from 'vitest';
import { appendTerminalBufferChunk, normalizeTerminalChunk } from '../src/index.js';

describe('terminal-core', () => {
  it('normalizes terminal chunks by decoding buffers, stripping ANSI control codes, and normalizing line endings', () => {
    const text = normalizeTerminalChunk(Buffer.from('\u001b[31m错误\u001b[0m\r\n下一行'));

    expect(text).toBe('错误\n下一行');
  });

  it('appends bounded terminal buffer events with stable sequence numbers', () => {
    const first = appendTerminalBufferChunk([], {
      stream: 'stdout',
      chunk: '第一行\n第二行',
      createdAt: '2026-06-14T00:00:00.000Z',
      maxEvents: 3,
    });
    const second = appendTerminalBufferChunk(first.events, {
      stream: 'stderr',
      chunk: '第三行\n第四行',
      createdAt: '2026-06-14T00:00:01.000Z',
      maxEvents: 3,
    });

    expect(second.events.map((event) => `${event.seq}:${event.stream}:${event.content}`)).toEqual(['2:stdout:第二行', '3:stderr:第三行', '4:stderr:第四行']);
    expect(second.droppedCount).toBe(1);
  });
});
