import { describe, expect, it } from 'vitest';
import { exportRuntimeLogsToFile } from '../src/main/runtimeLogExport.js';

describe('Electron runtime log export file bridge', () => {
  it('writes source-backed runtime logs to a user-selected log file', async () => {
    const writes: Array<{ path: string; content: string }> = [];
    const result = await exportRuntimeLogsToFile({
      payload: {
        fileName: 'zeus-runtime-session-1.log',
        mimeType: 'text/plain',
        sessionId: 'session-1',
        logs: [
          {
            createdAt: '2026-06-13T00:00:00.000Z',
            stream: 'stdout',
            text: '真实 Runtime 日志',
          },
          {
            createdAt: '2026-06-13T00:00:01.000Z',
            stream: 'stderr',
            text: '真实错误输出',
          },
        ],
      },
      chooseFile: async () => ({
        canceled: false,
        filePath: '/Users/david/Desktop/zeus-runtime-session-1.log',
      }),
      writeTextFile: async (path, content) => {
        writes.push({ path, content });
      },
    });

    expect(result).toEqual({
      saved: true,
      filePath: '/Users/david/Desktop/zeus-runtime-session-1.log',
    });
    expect(writes).toEqual([
      {
        path: '/Users/david/Desktop/zeus-runtime-session-1.log',
        content: '[2026-06-13T00:00:00.000Z] stdout: 真实 Runtime 日志\n[2026-06-13T00:00:01.000Z] stderr: 真实错误输出\n',
      },
    ]);
  });

  it('exports the complete normalized session log file when a source file path is provided', async () => {
    const writes: Array<{ path: string; content: string }> = [];
    const result = await exportRuntimeLogsToFile({
      payload: {
        fileName: 'zeus-runtime-session-1.log',
        mimeType: 'text/plain',
        sessionId: 'session-1',
        sourceFilePath: '/Users/david/Library/Application Support/Zeus/sessions/session-1/terminal.normalized.log',
        logs: [
          {
            createdAt: '2026-06-13T00:00:00.000Z',
            stream: 'stdout',
            text: '当前 UI 只加载了一条日志',
          },
        ],
      },
      chooseFile: async () => ({
        canceled: false,
        filePath: '/Users/david/Desktop/zeus-runtime-session-1.log',
      }),
      isAllowedSourceFile: (path) => path.endsWith('/sessions/session-1/terminal.normalized.log'),
      readTextFile: async (path) => (path.endsWith('terminal.normalized.log') ? '[2026-06-13T00:00:00.000Z] stdout: 完整日志第一行\n[2026-06-13T00:00:01.000Z] stderr: 完整日志第二行\n' : ''),
      writeTextFile: async (path, content) => {
        writes.push({ path, content });
      },
    });

    expect(result).toEqual({
      saved: true,
      filePath: '/Users/david/Desktop/zeus-runtime-session-1.log',
    });
    expect(writes).toEqual([
      {
        path: '/Users/david/Desktop/zeus-runtime-session-1.log',
        content: '[2026-06-13T00:00:00.000Z] stdout: 完整日志第一行\n[2026-06-13T00:00:01.000Z] stderr: 完整日志第二行\n',
      },
    ]);
  });

  it('rejects runtime log source files outside the Zeus session directory before reading', async () => {
    let readCalled = false;

    await expect(
      exportRuntimeLogsToFile({
        payload: {
          fileName: 'zeus-runtime-session-1.log',
          mimeType: 'text/plain',
          sessionId: 'session-1',
          sourceFilePath: '/Users/david/.ssh/id_rsa',
          logs: [],
        },
        chooseFile: async () => ({
          canceled: false,
          filePath: '/Users/david/Desktop/zeus-runtime-session-1.log',
        }),
        isAllowedSourceFile: () => false,
        readTextFile: async () => {
          readCalled = true;
          return 'PRIVATE KEY SHOULD NOT BE READ';
        },
        writeTextFile: async () => {},
      }),
    ).rejects.toThrow('Zeus runtime log export source must be a terminal.normalized.log under the session directory');

    expect(readCalled).toBe(false);
  });

  it('rejects empty or non-log runtime export payloads before writing files', async () => {
    await expect(
      exportRuntimeLogsToFile({
        payload: {
          fileName: 'unsafe.txt',
          mimeType: 'application/json',
          sessionId: 'session-1',
          logs: [],
        },
        chooseFile: async () => ({
          canceled: false,
          filePath: '/Users/david/Desktop/unsafe.txt',
        }),
        writeTextFile: async () => {},
      }),
    ).rejects.toThrow('Zeus runtime log export requires non-empty text/plain .log payload');
  });
});
