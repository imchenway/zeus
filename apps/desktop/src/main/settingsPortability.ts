export interface SettingsSaveDialogResult {
  canceled: boolean;
  filePath?: string;
}

export interface SettingsOpenDialogResult {
  canceled: boolean;
  filePaths: string[];
}

export interface ExportSettingsSnapshotInput {
  snapshot: unknown;
  chooseFile: () => Promise<SettingsSaveDialogResult>;
  writeTextFile: (path: string, content: string) => Promise<void>;
}

export interface ExportSettingsSnapshotResult {
  saved: boolean;
  filePath: string | null;
}

export interface ImportSettingsSnapshotInput {
  chooseFile: () => Promise<SettingsOpenDialogResult>;
  readTextFile: (path: string) => Promise<string>;
}

export interface ImportSettingsSnapshotResult {
  imported: boolean;
  filePath: string | null;
  snapshot?: {
    app: 'Zeus';
    schemaVersion: 1;
    exportedAt: string;
    redaction: { secretsRedacted: true };
    settings: {
      appShell?: Record<string, unknown>;
      runtime?: Record<string, unknown>;
      codeMap?: Record<string, unknown>;
      telegramNotification?: Record<string, unknown>;
      telegramSecurity?: Record<string, unknown>;
    };
  };
}

export interface ImportBusinessDataSnapshotResult {
  imported: boolean;
  filePath: string | null;
  snapshot?: {
    app: 'Zeus';
    schemaVersion: 1;
    redaction: { secretsRedacted: true };
    data: {
      projects: unknown[];
      tasks: unknown[];
      taskEvents: unknown[];
      taskTemplates: unknown[];
    };
  };
}

/** 校验设置快照只来自 Zeus v1 脱敏导出，避免导入含密钥明文的未知 JSON。 */
function assertRedactedZeusSnapshot(value: unknown): asserts value is {
  app: 'Zeus';
  schemaVersion: 1;
  redaction: { secretsRedacted: true };
  settings?: unknown;
  data?: unknown;
} {
  if (!value || typeof value !== 'object') {
    throw new Error('Zeus settings import must be a redacted schemaVersion 1 snapshot');
  }
  const candidate = value as {
    app?: unknown;
    schemaVersion?: unknown;
    redaction?: { secretsRedacted?: unknown };
    settings?: unknown;
    data?: unknown;
  };
  if (candidate.app !== 'Zeus' || candidate.schemaVersion !== 1 || candidate.redaction?.secretsRedacted !== true || (!candidate.settings && !candidate.data)) {
    throw new Error('Zeus settings import must be a redacted schemaVersion 1 snapshot');
  }
}

/** 设置导入仍只接受 settings 结构，避免把业务数据快照误导入为本机偏好。 */
function assertRedactedZeusSettingsSnapshot(value: unknown): asserts value is ImportSettingsSnapshotResult['snapshot'] & {
  app?: 'Zeus';
  redaction: { secretsRedacted: true };
} {
  assertRedactedZeusSnapshot(value);
  const candidate = value as { settings?: unknown };
  if (!candidate.settings || typeof candidate.settings !== 'object') {
    throw new Error('Zeus settings import must be a redacted schemaVersion 1 snapshot');
  }
}

/** 业务数据导入只接受 data 结构，避免把设置快照误导入为项目/任务数据。 */
function assertRedactedZeusBusinessDataSnapshot(value: unknown): asserts value is NonNullable<ImportBusinessDataSnapshotResult['snapshot']> {
  assertRedactedZeusSnapshot(value);
  const candidate = value as {
    data?: {
      projects?: unknown;
      tasks?: unknown;
      taskEvents?: unknown;
      taskTemplates?: unknown;
    };
  };
  if (!candidate.data || !Array.isArray(candidate.data.projects) || !Array.isArray(candidate.data.tasks) || !Array.isArray(candidate.data.taskEvents) || !Array.isArray(candidate.data.taskTemplates)) {
    throw new Error('Zeus business data import must be a redacted schemaVersion 1 data snapshot');
  }
}

/** 将 renderer 从本地 API 取得的脱敏设置快照保存到用户选择的 JSON 文件。 */
export async function exportSettingsSnapshotToFile(input: ExportSettingsSnapshotInput): Promise<ExportSettingsSnapshotResult> {
  assertRedactedZeusSnapshot(input.snapshot);
  const target = await input.chooseFile();
  if (target.canceled || !target.filePath) return { saved: false, filePath: null };
  await input.writeTextFile(target.filePath, `${JSON.stringify(input.snapshot, null, 2)}\n`);
  return { saved: true, filePath: target.filePath };
}

/** 从用户选择的 JSON 文件读取 Zeus 脱敏设置快照；导入应用仍由本地 API 完成。 */
export async function importSettingsSnapshotFromFile(input: ImportSettingsSnapshotInput): Promise<ImportSettingsSnapshotResult> {
  const selected = await input.chooseFile();
  const filePath = selected.filePaths[0];
  if (selected.canceled || !filePath) return { imported: false, filePath: null };
  const raw = await input.readTextFile(filePath);
  const parsed = JSON.parse(raw) as unknown;
  assertRedactedZeusSettingsSnapshot(parsed);
  const settings = parsed.settings as {
    appShell?: Record<string, unknown>;
    runtime?: Record<string, unknown>;
    codeMap?: Record<string, unknown>;
    telegramNotification?: Record<string, unknown>;
    telegramSecurity?: Record<string, unknown>;
  };
  return {
    imported: true,
    filePath,
    snapshot: {
      app: 'Zeus',
      schemaVersion: 1,
      exportedAt: typeof parsed.exportedAt === 'string' ? parsed.exportedAt : new Date(0).toISOString(),
      redaction: { secretsRedacted: true },
      // 文件导入桥接只透传脱敏设置字段；字段级安全校验仍由本地 API 统一执行。
      settings: {
        appShell: settings.appShell,
        runtime: settings.runtime,
        codeMap: settings.codeMap,
        telegramNotification: settings.telegramNotification,
        telegramSecurity: settings.telegramSecurity,
      },
    },
  };
}

/** 从用户选择的 JSON 文件读取 Zeus 脱敏业务数据快照；实际写入仍由本地 API 完成。 */
export async function importBusinessDataSnapshotFromFile(input: ImportSettingsSnapshotInput): Promise<ImportBusinessDataSnapshotResult> {
  const selected = await input.chooseFile();
  const filePath = selected.filePaths[0];
  if (selected.canceled || !filePath) return { imported: false, filePath: null };
  const raw = await input.readTextFile(filePath);
  const parsed = JSON.parse(raw) as unknown;
  assertRedactedZeusBusinessDataSnapshot(parsed);
  return { imported: true, filePath, snapshot: parsed };
}
