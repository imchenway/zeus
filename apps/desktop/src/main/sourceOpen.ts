import { relative, resolve } from 'node:path';

export interface SourceLocation {
  projectRoot?: string;
  sourceRef: string;
  lineStart?: number;
}

export interface OpenSourceLocationOptions {
  projectRoot: string;
  source: SourceLocation;
  fileExists: (filePath: string) => Promise<boolean>;
  openPath: (filePath: string) => Promise<string>;
}

export interface OpenSourceLocationResult {
  opened: boolean;
  filePath: string;
  lineStart: number | null;
}

/** 打开真实源码文件；只允许访问项目根目录内路径。 */
export async function openSourceLocation(options: OpenSourceLocationOptions): Promise<OpenSourceLocationResult> {
  // 源码路径相对于当前项目；优先使用界面携带的项目根目录。
  const projectRoot = resolve(options.source.projectRoot ?? options.projectRoot);
  const filePath = resolve(projectRoot, options.source.sourceRef);
  const relativePath = relative(projectRoot, filePath);
  if (relativePath.startsWith('..') || relativePath === '' || relativePath.includes('\0')) {
    throw new Error('源码必须位于项目根目录内。');
  }
  if (!(await options.fileExists(filePath))) {
    throw new Error('源码文件不存在。');
  }
  const openError = await options.openPath(filePath);
  if (openError) {
    throw new Error(openError);
  }
  return {
    opened: true,
    filePath,
    lineStart: typeof options.source.lineStart === 'number' ? options.source.lineStart : null,
  };
}
