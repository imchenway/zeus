import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { CodexJsonLineDecoder, parseExternalAgentConfigDetectResponse, parseExternalAgentConfigImportHistoriesResponse, parseExternalAgentConfigImportResponse, parseExternalAgentImportNotification } from '../src/codexAppServerProtocol.js';

const MAX_FRAME_BYTES = 4 * 1024 * 1024;

describe('Codex native app-server wire protocol', () => {
  it('parses the pinned external-agent migration responses without inventing a detect source', () => {
    expect(
      parseExternalAgentConfigDetectResponse({
        items: [
          {
            itemType: 'SESSIONS',
            description: '2 sessions',
            cwd: '/tmp/project',
            details: { sessions: [{ path: '/private/zeus/projects/-tmp-project/session.jsonl', cwd: '/tmp/project', title: 'Legacy session' }] },
          },
        ],
      }),
    ).toEqual({
      items: [
        {
          itemType: 'SESSIONS',
          description: '2 sessions',
          cwd: '/tmp/project',
          details: { sessions: [{ path: '/private/zeus/projects/-tmp-project/session.jsonl', cwd: '/tmp/project', title: 'Legacy session' }] },
        },
      ],
    });
    expect(parseExternalAgentConfigImportResponse({ importId: 'import-1' })).toEqual({ importId: 'import-1' });
    expect(() => parseExternalAgentConfigImportResponse({ importId: '   ' })).toThrow(/importId/);
  });

  it('parses import progress/completion, preserves future item types, and rejects session success without a target', () => {
    expect(
      parseExternalAgentImportNotification('externalAgentConfig/import/progress', {
        importId: 'import-1',
        itemTypeResults: [{ itemType: 'FUTURE_ITEM_TYPE', successes: [], failures: [] }],
      }),
    ).toEqual({ type: 'progress', importId: 'import-1', itemTypeResults: [{ itemType: 'FUTURE_ITEM_TYPE', successes: [], failures: [] }] });
    expect(
      parseExternalAgentImportNotification('externalAgentConfig/import/completed', {
        importId: 'import-1',
        itemTypeResults: [{ itemType: 'SESSIONS', successes: [{ itemType: 'SESSIONS', cwd: '/tmp/project', source: '/tmp/legacy.jsonl', target: 'thread-1' }], failures: [] }],
      }),
    ).toMatchObject({ type: 'completed', importId: 'import-1' });
    expect(() =>
      parseExternalAgentImportNotification('externalAgentConfig/import/completed', {
        importId: 'import-1',
        itemTypeResults: [{ itemType: 'SESSIONS', successes: [{ itemType: 'SESSIONS', cwd: '/tmp/project', source: '/tmp/legacy.jsonl', target: '' }], failures: [] }],
      }),
    ).toThrow(/target/);
  });

  it('normalizes exact import history timestamps to bigint and rejects unsafe numbers', () => {
    expect(
      parseExternalAgentConfigImportHistoriesResponse({
        data: [{ importId: 'import-1', completedAtMs: '1784000000000', successes: [], failures: [] }],
      }),
    ).toEqual({ data: [{ importId: 'import-1', completedAtMs: 1784000000000n, successes: [], failures: [] }] });
    expect(() => parseExternalAgentConfigImportHistoriesResponse({ data: [{ importId: 'import-1', completedAtMs: Number.MAX_SAFE_INTEGER + 1, successes: [], failures: [] }] })).toThrow(/completedAtMs/);
  });

  it('decodes split UTF-8 JSON lines and keeps the next valid frame after malformed input', () => {
    const decoder = new CodexJsonLineDecoder();
    const bytes = Buffer.from('{"id":1,"result":{"ok":"好"}}\r\nnot-json\n{"method":"thread/started","params":{}}\n');
    const chineseByte = bytes.indexOf(Buffer.from('好'));
    const frames = [...decoder.push(bytes.subarray(0, chineseByte + 1)), ...decoder.push(bytes.subarray(chineseByte + 1))];

    expect(frames[0]).toEqual({ type: 'message', message: { id: 1, result: { ok: '好' } } });
    expect(frames[1]).toMatchObject({ type: 'protocol_error', error: { code: 'MALFORMED_JSON' } });
    expect(frames[2]).toEqual({ type: 'message', message: { method: 'thread/started', params: {} } });
  });

  it('buffers half-lines and preserves wire message shapes without requiring jsonrpc', () => {
    const decoder = new CodexJsonLineDecoder();

    expect(decoder.push(Buffer.from('{"id":"request-1","method":"item/commandExecution/requestApproval"'))).toEqual([]);
    expect(decoder.push(Buffer.from(',"params":{"command":"pnpm test"}}\r\n'))).toEqual([
      {
        type: 'message',
        message: {
          id: 'request-1',
          method: 'item/commandExecution/requestApproval',
          params: { command: 'pnpm test' },
        },
      },
    ]);

    expect(decoder.push(Buffer.from(['{"id":2,"result":{"threadId":"thread-1"}}', '{"id":"request-2","error":{"code":-32000,"message":"denied"}}', '{"method":"future/unknownNotification","params":{"kept":true}}', ''].join('\n')))).toEqual([
      { type: 'message', message: { id: 2, result: { threadId: 'thread-1' } } },
      { type: 'message', message: { id: 'request-2', error: { code: -32000, message: 'denied' } } },
      { type: 'message', message: { method: 'future/unknownNotification', params: { kept: true } } },
    ]);
  });

  it('isolates valid JSON with invalid wire shapes and continues decoding later frames', () => {
    const decoder = new CodexJsonLineDecoder();
    const invalid = [
      null,
      42,
      'string',
      [],
      {},
      { id: null, result: {} },
      { id: 1 },
      { id: 1, result: {}, error: { code: -1, message: 'both' } },
      { id: 1, error: { code: 'bad', message: 'wrong code type' } },
      { method: 7, params: {} },
      { method: 'thread/started' },
      { id: 'server-request', method: 'item/tool/call', params: {}, result: {} },
    ];
    const frames = decoder.push(Buffer.from([...invalid.map((value) => JSON.stringify(value)), '{"method":"thread/started","params":{}}', ''].join('\n')));

    expect(frames.slice(0, invalid.length)).toEqual(
      invalid.map(() => ({
        type: 'protocol_error',
        error: { code: 'INVALID_MESSAGE', detail: 'invalid wire message' },
      })),
    );
    expect(frames.at(-1)).toEqual({ type: 'message', message: { method: 'thread/started', params: {} } });
  });

  it('isolates completed and pending frames larger than 4 MiB and resumes decoding', () => {
    const completedDecoder = new CodexJsonLineDecoder();
    const completedFrames = completedDecoder.push(Buffer.concat([Buffer.alloc(MAX_FRAME_BYTES + 1, 0x78), Buffer.from('\n{"id":3,"result":{}}\n')]));
    expect(completedFrames).toEqual([
      {
        type: 'protocol_error',
        error: { code: 'FRAME_TOO_LARGE', detail: `${MAX_FRAME_BYTES + 1} bytes` },
      },
      { type: 'message', message: { id: 3, result: {} } },
    ]);

    const pendingDecoder = new CodexJsonLineDecoder();
    expect(pendingDecoder.push(Buffer.alloc(MAX_FRAME_BYTES + 1, 0x78))).toEqual([
      {
        type: 'protocol_error',
        error: { code: 'FRAME_TOO_LARGE', detail: `${MAX_FRAME_BYTES + 1} pending bytes` },
      },
    ]);
    expect(pendingDecoder.push(Buffer.from('{"id":"smuggled-tail","result":{}}\n{"id":"after-reset","result":{}}\n'))).toEqual([{ type: 'message', message: { id: 'after-reset', result: {} } }]);
  });

  it('redacts token, Authorization, and private-key material from malformed frame details', () => {
    const decoder = new CodexJsonLineDecoder();
    const frames = decoder.push(Buffer.from(['Authorization: Bearer protocol-secret', 'token=protocol-token', 'PRIVATE KEY protocol-private-key', ''].join('\n')));
    const details = frames
      .filter((frame) => frame.type === 'protocol_error')
      .map((frame) => frame.error.detail)
      .join('\n');

    expect(details).not.toMatch(/Authorizat|Bearer|token|PRIVATE KEY|protocol-secret|protocol-token|protocol-private-key/i);
  });

  it('decodes only stdout from a fake server and observes bounded successful exit', async () => {
    const decoder = new CodexJsonLineDecoder();
    const frames = [] as ReturnType<CodexJsonLineDecoder['push']>;
    let stderr = '';
    const child = spawn(process.execPath, [new URL('./fixtures/fake-codex-app-server.mjs', import.meta.url).pathname], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk: Buffer) => frames.push(...decoder.push(chunk)));
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error('Timed out waiting for fake Codex app-server exit'));
      }, 2_000);
      child.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once('close', (code) => {
        clearTimeout(timeout);
        resolve(code);
      });
    });

    expect(exitCode).toBe(0);
    expect(frames).toEqual([
      { type: 'message', message: { id: 7, result: { ok: '好' } } },
      { type: 'message', message: { method: 'thread/started', params: { threadId: 'thread-fixture' } } },
    ]);
    expect(stderr).toContain('stderr/diagnostic');
    expect(frames).not.toContainEqual({
      type: 'message',
      message: { method: 'stderr/diagnostic', params: { mustNotDecode: true } },
    });
  });
});
