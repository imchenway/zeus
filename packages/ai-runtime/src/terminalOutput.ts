export { projectTerminalOutput } from '@zeus/shared';

export function normalizeTerminalChunk(chunk: unknown): string {
  const text = chunk instanceof Uint8Array ? Buffer.from(chunk).toString('utf8') : String(chunk);
  return stripAnsiControlSequences(text).replace(/\r\n/g, '\n');
}

const escape = String.fromCharCode(0x1b);
const bell = String.fromCharCode(0x07);
const ansiOscPattern = new RegExp(`${escape}\\][^${bell}]*(?:${bell}|${escape}\\\\)`, 'gu');
const ansiCsiPattern = new RegExp(`${escape}\\[[0-?]*[ -/]*[@-~]`, 'gu');
const ansiCharsetPattern = new RegExp(`${escape}[()][A-Za-z0-9]`, 'gu');

function stripAnsiControlSequences(text: string): string {
  return text.replace(ansiOscPattern, '').replace(ansiCsiPattern, '').replace(ansiCharsetPattern, '');
}
