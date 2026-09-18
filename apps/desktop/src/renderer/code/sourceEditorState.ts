import type { editor } from 'monaco-editor';
import type { SourceBuffer, SourceRange, SourceLanguageEdit } from '@zeus/shared';

/** 文档生命周期属于标签页，视图卸载仅保存光标和滚动，保留原生撤销栈。 */
export interface SourceModelEntry {
  projectId: string;
  path: string;
  model: editor.ITextModel;
  reference?: { dispose(): void };
  retaining?: Promise<void>;
  retained?: boolean;
  viewState?: editor.ICodeEditorViewState | null;
}
export interface SourceWorkspaceActions {
  open(path: string, range?: SourceRange): Promise<void>;
  hasOpenFile(path: string): boolean;
  buffers(): SourceBuffer[];
  prepareEdits(edits: SourceLanguageEdit[], contents: Record<string, string>): Promise<void>;
  changed(path: string, content: string): void;
  reportStatus(message: string): void;
}
export const sourceModels = new Map<string, SourceModelEntry>();
export const sourceWorkspaces = new Map<string, SourceWorkspaceActions>();

export function sourceModelKey(projectId: string, path: string): string {
  return projectId + '\0' + path;
}

export function sourceBuffers(projectId: string): SourceBuffer[] {
  const workspace = sourceWorkspaces.get(projectId);
  if (workspace) return workspace.buffers();
  return [...sourceModels.values()].filter((entry) => entry.projectId === projectId && entry.retained).map((entry) => ({ relativePath: entry.path, content: entry.model.getValue(), version: entry.model.getVersionId() }));
}

export function retainSourceModels(projectId: string, paths: string[], includeTransient = false): void {
  const retained = new Set(paths);
  for (const [key, entry] of sourceModels) {
    if (entry.projectId === projectId && (entry.retained || includeTransient) && !retained.has(entry.path)) {
      entry.reference?.dispose();
      entry.model.dispose();
      sourceModels.delete(key);
    }
  }
}

export function releaseSourceWorkspace(projectId: string): void {
  retainSourceModels(projectId, [], true);
  sourceWorkspaces.delete(projectId);
  void window.zeus?.releaseProjectSourceLanguage(projectId).catch(() => undefined);
}

export function trackSourceModel(entry: SourceModelEntry): void {
  sourceModels.set(sourceModelKey(entry.projectId, entry.path), entry);
  const listener = entry.model.onDidChangeContent(() => sourceWorkspaces.get(entry.projectId)?.changed(entry.path, entry.model.getValue()));
  entry.model.onWillDispose(() => {
    listener.dispose();
    const key = sourceModelKey(entry.projectId, entry.path);
    if (sourceModels.get(key)?.model === entry.model) sourceModels.delete(key);
  });
}
