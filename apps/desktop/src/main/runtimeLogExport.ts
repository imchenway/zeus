export interface RuntimeLogSaveDialogResult {
  canceled: boolean;
  filePath?: string;
}

export interface RuntimeLogExportEntry {
  createdAt: string;
  stream: string;
  text: string;
}

export interface RuntimeLogExportPayload {
  fileName: string;
  mimeType: string;
  sessionId: string;
  sourceFilePath?: string;
  logs: RuntimeLogExportEntry[];
}

export interface ExportRuntimeLogsToFileInput {
  payload: RuntimeLogExportPayload;
  chooseFile: () => Promise<RuntimeLogSaveDialogResult>;
  isAllowedSourceFile?: (path: string) => boolean;
  readTextFile?: (path: string) => Promise<string>;
  writeTextFile: (path: string, content: string) => Promise<void>;
}

export interface ExportRuntimeLogsToFileResult {
  saved: boolean;
  filePath: string | null;
}

/** 将已采集的真实 Runtime 日志保存为纯文本文件；不生成假终端输出。 */
export async function exportRuntimeLogsToFile(input: ExportRuntimeLogsToFileInput): Promise<ExportRuntimeLogsToFileResult> {
  const hasSourceFile = Boolean(input.payload.sourceFilePath);
  if (input.payload.mimeType !== 'text/plain' || !input.payload.fileName.endsWith('.log') || (!hasSourceFile && input.payload.logs.length === 0)) {
    throw new Error('Zeus runtime log export requires non-empty text/plain .log payload');
  }
  const target = await input.chooseFile();
  if (target.canceled || !target.filePath) return { saved: false, filePath: null };
  const content = await resolveRuntimeLogExportContent(input);
  await input.writeTextFile(target.filePath, content);
  return { saved: true, filePath: target.filePath };
}

async function resolveRuntimeLogExportContent(input: ExportRuntimeLogsToFileInput): Promise<string> {
  if (input.payload.sourceFilePath) {
    if (!input.isAllowedSourceFile?.(input.payload.sourceFilePath)) {
      throw new Error('Zeus runtime log export source must be a terminal.normalized.log under the session directory');
    }
  }
  if (input.payload.sourceFilePath && input.readTextFile) {
    // 优先导出 session 目录中的完整 normalized log，避免只导出 Renderer 当前分页/已加载片段。
    const content = await input.readTextFile(input.payload.sourceFilePath);
    if (content.trim().length > 0) return content.endsWith('\n') ? content : `${content}\n`;
  }
  return input.payload.logs.map((entry) => `[${entry.createdAt}] ${entry.stream}: ${entry.text}`).join('\n') + '\n';
}
