/** 项目语言服务只接受源码相对路径，不向渲染进程暴露文件系统或任意命令。 */
export interface SourceRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}
export interface SourceBuffer {
  relativePath: string;
  content: string;
  version: number;
}
export interface SourceLanguageRequest {
  projectId: string;
  relativePath: string;
  operation: 'completion' | 'hover' | 'definition' | 'references' | 'rename' | 'diagnostics' | 'format';
  offset: number;
  buffers: SourceBuffer[];
  newName?: string;
  tabSize?: number;
  insertSpaces?: boolean;
}
export interface SourceLocation {
  relativePath: string;
  range: SourceRange;
}
export interface SourceLanguageEdit extends SourceLocation {
  text: string;
}
export interface SourceLanguageResult {
  configPath: string | null;
  completions?: Array<{ label: string; kind: string; sortText: string; insertText: string }>;
  hover?: { range: SourceRange; text: string; documentation: string };
  locations?: SourceLocation[];
  edits?: SourceLanguageEdit[];
  renameError?: string;
  editContents?: Record<string, string>;
  diagnostics?: Array<{ range: SourceRange; message: string; code: number; severity: 'error' | 'warning' | 'info' }>;
}
