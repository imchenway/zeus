import { describe, expect, it } from 'vitest';
import { exportSettingsSnapshotToFile, importBusinessDataSnapshotFromFile, importSettingsSnapshotFromFile } from '../src/main/settingsPortability.js';

describe('Electron settings portability file bridge', () => {
  it('writes a redacted Zeus settings snapshot to a user-selected JSON file', async () => {
    const writes: Array<{ path: string; content: string }> = [];
    const result = await exportSettingsSnapshotToFile({
      snapshot: {
        app: 'Zeus',
        schemaVersion: 1,
        exportedAt: '2026-06-13T00:00:00.000Z',
        redaction: { secretsRedacted: true },
        settings: { appShell: { appearance: 'dark' } },
      },
      chooseFile: async () => ({
        canceled: false,
        filePath: '/Users/david/Desktop/zeus-settings.json',
      }),
      writeTextFile: async (path, content) => {
        writes.push({ path, content });
      },
    });

    expect(result).toEqual({
      saved: true,
      filePath: '/Users/david/Desktop/zeus-settings.json',
    });
    expect(writes).toHaveLength(1);
    expect(writes[0].content).toContain('"app": "Zeus"');
    expect(writes[0].content).toContain('"secretsRedacted": true');
    expect(writes[0].content).not.toContain('telegram-token-real');
  });

  it('writes a redacted Zeus business data snapshot to a user-selected JSON file', async () => {
    const writes: Array<{ path: string; content: string }> = [];
    const result = await exportSettingsSnapshotToFile({
      snapshot: {
        app: 'Zeus',
        schemaVersion: 1,
        exportedAt: '2026-06-14T00:00:00.000Z',
        redaction: { secretsRedacted: true },
        data: {
          projects: [{ id: 'project_real', name: 'Zeus' }],
          tasks: [],
          taskEvents: [],
          taskTemplates: [],
        },
      },
      chooseFile: async () => ({
        canceled: false,
        filePath: '/Users/david/Desktop/zeus-business-data.json',
      }),
      writeTextFile: async (path, content) => {
        writes.push({ path, content });
      },
    });

    expect(result).toEqual({
      saved: true,
      filePath: '/Users/david/Desktop/zeus-business-data.json',
    });
    expect(writes[0].content).toContain('"data"');
    expect(writes[0].content).toContain('"secretsRedacted": true');
    expect(writes[0].content).not.toContain('telegram-token-real');
  });

  it('reads and validates a Zeus settings snapshot from a user-selected JSON file', async () => {
    const result = await importSettingsSnapshotFromFile({
      chooseFile: async () => ({
        canceled: false,
        filePaths: ['/Users/david/Desktop/zeus-settings.json'],
      }),
      readTextFile: async () =>
        JSON.stringify({
          app: 'Zeus',
          schemaVersion: 1,
          exportedAt: '2026-06-15T00:00:00.000Z',
          redaction: { secretsRedacted: true },
          settings: {
            appShell: {
              appearance: 'light',
              webviewDebugEnabled: false,
              multiWindowEnabled: false,
              backgroundModeEnabled: false,
              autoUpdateChannel: 'manual',
            },
            runtime: {
              defaultAdapterId: 'gemini',
              autoConfirmationPolicy: 'never',
              terminalEnv: { ZEUS_IMPORTED: '1' },
            },
            codeMap: {
              graphCacheStrategy: 'sqlite',
              moduleFlowManualNotes: '导入后的真实备注',
            },
            telegramNotification: {
              enabled: false,
              chatIds: [987654],
              silentMode: false,
            },
            telegramSecurity: { allowedUserIds: [1001] },
          },
        }),
    });

    expect(result.imported).toBe(true);
    expect(result.filePath).toBe('/Users/david/Desktop/zeus-settings.json');
    expect(result.snapshot?.app).toBe('Zeus');
    expect(result.snapshot?.settings.appShell).toMatchObject({
      appearance: 'light',
      multiWindowEnabled: false,
    });
    expect(result.snapshot?.settings.runtime).toMatchObject({
      defaultAdapterId: 'gemini',
      terminalEnv: { ZEUS_IMPORTED: '1' },
    });
    expect(result.snapshot?.settings.codeMap).toMatchObject({
      moduleFlowManualNotes: '导入后的真实备注',
    });
    expect(result.snapshot?.settings.telegramNotification).toEqual({
      enabled: false,
      chatIds: [987654],
      silentMode: false,
    });
    expect(result.snapshot?.settings.telegramSecurity).toEqual({
      allowedUserIds: [1001],
    });
    expect(JSON.stringify(result.snapshot)).not.toContain('telegram-token-real');
  });

  it('reads and validates a Zeus business data snapshot from a user-selected JSON file', async () => {
    const result = await importBusinessDataSnapshotFromFile({
      chooseFile: async () => ({
        canceled: false,
        filePaths: ['/Users/david/Desktop/zeus-business-data.json'],
      }),
      readTextFile: async () =>
        JSON.stringify({
          app: 'Zeus',
          schemaVersion: 1,
          redaction: { secretsRedacted: true },
          data: {
            projects: [{ id: 'project_real', name: 'Zeus' }],
            tasks: [{ id: 'task_real', projectId: 'project_real', title: '迁移任务' }],
            taskEvents: [],
            taskTemplates: [],
          },
        }),
    });

    expect(result.imported).toBe(true);
    expect(result.filePath).toBe('/Users/david/Desktop/zeus-business-data.json');
    expect(result.snapshot?.data.projects[0]).toMatchObject({
      id: 'project_real',
      name: 'Zeus',
    });
    expect(JSON.stringify(result.snapshot)).not.toContain('telegram-token-real');
  });

  it('rejects settings files that do not declare secret redaction', async () => {
    await expect(
      importSettingsSnapshotFromFile({
        chooseFile: async () => ({
          canceled: false,
          filePaths: ['/Users/david/Desktop/unsafe.json'],
        }),
        readTextFile: async () =>
          JSON.stringify({
            app: 'Zeus',
            schemaVersion: 1,
            redaction: { secretsRedacted: false },
            settings: {},
          }),
      }),
    ).rejects.toThrow('Zeus settings import must be a redacted schemaVersion 1 snapshot');
  });
});
