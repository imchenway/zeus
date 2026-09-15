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
