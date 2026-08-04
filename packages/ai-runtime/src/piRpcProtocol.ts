import { StringDecoder } from 'node:string_decoder';

export type PiRpcRequestId = string;

export interface PiRpcRequest {
  id: PiRpcRequestId;
  type: string;

  [key: string]: unknown;
}

export interface PiRpcResponse {
  id?: PiRpcRequestId;
  type: 'response';
  command?: string;
  success: boolean;
  error?: string;
  data?: unknown;
}

export interface PiRpcEvent {
  type: string;

  [key: string]: unknown;
}

export type PiRpcMessage = PiRpcResponse | PiRpcEvent;

export type PiRpcFrame =
  | { type: 'message'; message: PiRpcMessage }
  | {
      type: 'protocol_error';
      error: { code: string; message: string; recordLength: number };
    };

/**
 * Pi RPC 以 LF 分隔 JSON。这里只提供协议解码骨架，不创建进程，也不发送任何模型请求。
 */
export class PiRpcJsonLineDecoder {
  private readonly utf8 = new StringDecoder('utf8');
  private pending = '';

  push(chunk: Uint8Array | string): PiRpcFrame[] {
    this.pending += typeof chunk === 'string' ? chunk : this.utf8.write(Buffer.from(chunk));
    const frames: PiRpcFrame[] = [];
    while (true) {
      const boundary = this.pending.indexOf('\n');
      if (boundary < 0) return frames;
      const line = this.pending.slice(0, boundary);
      this.pending = this.pending.slice(boundary + 1);
      if (!line.trim()) continue;
      frames.push(decodePiRpcLine(line));
    }
  }

  finish(): PiRpcFrame[] {
    this.pending += this.utf8.end();
    if (!this.pending.trim()) {
      this.pending = '';
      return [];
    }
    const line = this.pending;
    this.pending = '';
    return [
      {
        type: 'protocol_error',
        error: {
          code: 'ZEUS_PI_RPC_INCOMPLETE_FRAME',
          message: 'Pi RPC stream ended before the final LF record boundary.',
          recordLength: line.length,
        },
      },
    ];
  }
}

function decodePiRpcLine(line: string): PiRpcFrame {
  try {
    const value: unknown = JSON.parse(line);
    if (!isRecord(value) || typeof value.type !== 'string' || !value.type) {
      throw new Error('Pi RPC record must be an object with a non-empty type.');
    }
    return { type: 'message', message: value as PiRpcMessage };
  } catch (error) {
    return {
      type: 'protocol_error',
      error: {
        code: 'ZEUS_PI_RPC_INVALID_JSON',
        message: error instanceof Error ? error.message : 'Pi RPC record is invalid.',
        recordLength: line.length,
      },
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
