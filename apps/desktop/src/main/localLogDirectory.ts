export interface OpenLocalLogDirectoryInput {
  dbPath?: string;
  fallbackLogsPath: string;
  ensureDirectory: (path: string, options: { recursive: true }) => Promise<void>;
  openPath: (path: string) => Promise<string>;
}

export interface OpenLocalLogDirectoryResult {
  opened: boolean;
  path: string;
  error?: string;
}

/**
 * 打开 Zeus 本机日志目录前先确保目录存在；日志只留在本机，不上传到远端渠道。
 */
export async function openLocalLogDirectory(input: OpenLocalLogDirectoryInput): Promise<OpenLocalLogDirectoryResult> {
  const logsPath = input.dbPath ? `${input.dbPath}.logs` : input.fallbackLogsPath;
  await input.ensureDirectory(logsPath, { recursive: true });
  const error = await input.openPath(logsPath);
  return error ? { opened: false, path: logsPath, error } : { opened: true, path: logsPath };
}
