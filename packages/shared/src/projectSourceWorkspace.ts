export type ProjectSourceEntryKind = 'file' | 'directory' | 'symlink';

export interface ProjectSourceRevision {
  sha256: string;
  byteLength: number;
  modifiedAtMs: number;
}

export interface ProjectSourceEntry {
  name: string;
  relativePath: string;
  kind: ProjectSourceEntryKind;
  byteLength: number;
  modifiedAtMs: number;
  accessible: boolean;
  symlinkTargetInsideProject?: boolean;
}

export interface ProjectSourceDirectorySnapshot {
  relativePath: string;
  entries: ProjectSourceEntry[];
}

export interface ProjectSourceSearchResult {
  entries: ProjectSourceEntry[];
  truncated: boolean;
}

/** 全局搜索中的源码命中，保留项目相对路径与可直接定位的文本位置。 */
export interface ProjectSourceContentMatch {
  relativePath: string;
  line: number;
  column: number;
  preview: string;
  matchKind: 'path' | 'content';
  /** 匹配文本在预览中的 UTF-16 起点，用于高亮长代码行中的真实命中。 */
  previewMatchStart?: number;
  /** 预览内匹配文本的 UTF-16 长度。 */
  previewMatchLength?: number;
}

/** 项目内容查找与标题栏快捷搜索共用文件读取边界。 */
export interface ProjectSourceContentSearchOptions {
  /** 仅查正文并返回完整命中列表；默认保留标题栏路径与内容摘要。 */
  contentOnly?: boolean;
  /** 为真时区分大小写。 */
  caseSensitive?: boolean;
  /** 为真时按 Unicode 字母、数字和代码标识符边界匹配整词。 */
  wholeWord?: boolean;
}

export interface ProjectSourceContentSearchResult {
  matches: ProjectSourceContentMatch[];
  truncated: boolean;
}

export interface ProjectSourceDocument {
  relativePath: string;
  name: string;
  language: string;
  content: string;
  encoding: 'utf-8';
  eol: 'lf' | 'crlf' | 'cr';
  hasBom: boolean;
  editable: boolean;
  /** 项目内受大小限制的只读图片，以数据地址交给图片元素解码。 */
  imagePreviewUrl?: string;
  readOnlyReason?: 'binary' | 'invalid_encoding' | 'too_large' | 'symlink' | 'not_regular_file';
  revision: ProjectSourceRevision;
}

export interface ProjectSourceEvent {
  projectId: string;
  relativePath: string;
  parentRelativePath: string;
  kind: 'created' | 'changed' | 'deleted' | 'renamed' | 'unknown';
}

export interface ProjectCodeWorkspacePreference {
  openFiles: string[];
  activeFile: string | null;
  expandedDirectories: string[];
  treeWidth: number;
}

/** 源码页可编辑文本的效果预览；媒体文件继续使用统一文件预览。 */
export type ProjectSourcePreviewKind = 'html' | 'markdown';

/** 格式识别由主进程和源码页共用，避免高亮语言覆盖改变预览能力。 */
export function projectSourcePreviewKind(path: string): ProjectSourcePreviewKind | null {
  /** 只识别文件扩展名，不把项目路径交给浏览器直接访问。 */
  const extension = path.split('.').pop()?.toLowerCase();
  if (['html', 'htm', 'xhtml'].includes(extension ?? '')) return 'html';
  if (['md', 'markdown', 'mdown', 'mkd'].includes(extension ?? '')) return 'markdown';
  return null;
}

/** 预览只接受项目文件身份与当前草稿，不接受任意目录授权。 */
export interface ProjectSourcePreviewRequest {
  /** 当前项目身份。 */
  projectId: string;
  /** 项目内已存在的文件。 */
  relativePath: string;
  /** 当前编辑内容，预览不会写入磁盘。 */
  content: string;
}

/** 临时资源授权绑定发起窗口，切换或关闭预览后撤销。 */
export interface ProjectSourcePreviewGrant {
  /** 主进程生成的不可猜测身份。 */
  id: string;
  /** 文件所在位置同时作为相对资源的解析基准。 */
  url: string;
  /** 当前授权对应的项目根 URL，用于准确解析本地链接。 */
  rootUrl: string;
}

export interface SaveProjectSourceFileInput {
  projectId: string;
  relativePath: string;
  content: string;
  expectedRevision: ProjectSourceRevision;
  eol: ProjectSourceDocument['eol'];
  hasBom: boolean;
}

export interface CreateProjectSourceEntryInput {
  projectId: string;
  parentRelativePath: string;
  name: string;
  kind: 'file' | 'directory';
}

export interface MoveProjectSourceEntryInput {
  projectId: string;
  relativePath: string;
  targetParentRelativePath: string;
  targetName: string;
}

export interface TrashProjectSourceEntryInput {
  projectId: string;
  relativePath: string;
}
