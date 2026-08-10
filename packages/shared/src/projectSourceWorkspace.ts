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

export interface ProjectSourceDocument {
  relativePath: string;
  name: string;
  language: string;
  content: string;
  encoding: 'utf-8';
  eol: 'lf' | 'crlf' | 'cr';
  hasBom: boolean;
  editable: boolean;
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
