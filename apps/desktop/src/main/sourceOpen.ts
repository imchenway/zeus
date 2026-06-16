import { relative, resolve } from 'node:path';

export interface GraphSourceLocation {
  sourceRef: string;
  lineStart?: number;
}

export interface OpenGraphSourceLocationOptions {
  projectRoot: string;
  source: GraphSourceLocation;
  fileExists: (filePath: string) => Promise<boolean>;
  openPath: (filePath: string) => Promise<string>;
}

export interface OpenGraphSourceLocationResult {
  opened: boolean;
  filePath: string;
  lineStart: number | null;
}

/** 打开图谱节点对应的真实源码文件；只允许访问项目根目录内路径，避免图谱 sourceRef 被滥用为任意文件跳转。 */
export async function openGraphSourceLocation(options: OpenGraphSourceLocationOptions): Promise<OpenGraphSourceLocationResult> {
  const projectRoot = resolve(options.projectRoot);
  const filePath = resolve(projectRoot, options.source.sourceRef);
  const relativePath = relative(projectRoot, filePath);
  if (relativePath.startsWith('..') || relativePath === '' || relativePath.includes('\0')) {
    throw new Error('Graph source must stay inside the project root');
  }
  if (!(await options.fileExists(filePath))) {
    throw new Error('Graph source file does not exist');
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
