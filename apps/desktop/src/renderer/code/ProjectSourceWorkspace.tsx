import { Suspense, forwardRef, lazy, useCallback, useEffect, useImperativeHandle, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { FileIcon as File } from '@phosphor-icons/react/dist/csr/File';
import { FloppyDiskIcon as FloppyDisk } from '@phosphor-icons/react/dist/csr/FloppyDisk';
import { FolderIcon as Folder } from '@phosphor-icons/react/dist/csr/Folder';
import { FolderOpenIcon as FolderOpen } from '@phosphor-icons/react/dist/csr/FolderOpen';
import { MagnifyingGlassIcon as MagnifyingGlass } from '@phosphor-icons/react/dist/csr/MagnifyingGlass';
import { PlusIcon as Plus } from '@phosphor-icons/react/dist/csr/Plus';
import { XIcon as X } from '@phosphor-icons/react/dist/csr/X';
import type { ProjectCodeWorkspacePreference, ProjectSourceDirectorySnapshot, ProjectSourceDocument, ProjectSourceEntry, ProjectSourceEvent } from '@zeus/shared';
import { Button } from '../ui/Button.js';
import { ModalPortal } from '../ui/ModalPortal.js';
import { useApplicationErrorDialog } from '../ui/ApplicationErrorDialog.js';
import './projectSourceWorkspace.css';

const CodeEditor = lazy(() => import('./CodeEditor.js').then((module) => ({ default: module.CodeEditor })));

type AppLanguage = 'zh-CN' | 'en-US';

interface SourceTab {
  document: ProjectSourceDocument;
  draft: string;
  dirty: boolean;
  saving: boolean;
  externalChange: boolean;
  revealLine?: number | null;
  cursorLine: number;
  cursorColumn: number;
}

type FileOperation =
  | { kind: 'create-file'; parentRelativePath: string }
  | { kind: 'create-directory'; parentRelativePath: string }
  | { kind: 'rename'; entry: ProjectSourceEntry }
  | { kind: 'move'; entry: ProjectSourceEntry }
  | { kind: 'delete'; entry: ProjectSourceEntry }
  | { kind: 'save-as'; tabPath: string }
  | null;

export interface ProjectSourceWorkspaceHandle {
  hasDirtyFiles(): boolean;
  saveAll(): Promise<boolean>;
  discardAll(): void;
  openFile(relativePath: string, line?: number): Promise<void>;
}

export interface ProjectSourceWorkspaceProps {
  project: { id: string; name: string; localPath: string };
  language: AppLanguage;
  preference?: ProjectCodeWorkspacePreference;
  onPreferenceChange?(preference: ProjectCodeWorkspacePreference): void;
  onDirtyChange?(dirty: boolean): void;
  onOpenExternal?(relativePath: string, line?: number): void;
}

export const ProjectSourceWorkspace = forwardRef<ProjectSourceWorkspaceHandle, ProjectSourceWorkspaceProps>(function ProjectSourceWorkspace(props, ref) {
  const zh = props.language === 'zh-CN';
  const bridge = typeof window === 'undefined' ? undefined : window.zeus;
  const initialPreference = normalizePreference(props.preference);
  const [directories, setDirectories] = useState<Record<string, ProjectSourceDirectorySnapshot>>({});
  const [expandedDirectories, setExpandedDirectories] = useState<Set<string>>(() => new Set(initialPreference.expandedDirectories));
  const [tabs, setTabs] = useState<SourceTab[]>([]);
  const [activePath, setActivePath] = useState<string | null>(initialPreference.activeFile);
  const [treeWidth, setTreeWidth] = useState(initialPreference.treeWidth);
  const [treeDrawerOpen, setTreeDrawerOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<ProjectSourceEntry[]>([]);
  const [searchTruncated, setSearchTruncated] = useState(false);
  const [loadingTree, setLoadingTree] = useState(true);
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  useApplicationErrorDialog(error, {
    language: zh ? 'zh-CN' : 'en',
  });
  const [operation, setOperation] = useState<FileOperation>(null);
  const [operationName, setOperationName] = useState('');
  const [operationParent, setOperationParent] = useState('');
  const [pendingClosePath, setPendingClosePath] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ entry: ProjectSourceEntry; x: number; y: number } | null>(null);
  const tabsRef = useRef(tabs);
  const activePathRef = useRef(activePath);
  const dirtyRef = useRef(false);
  tabsRef.current = tabs;
  activePathRef.current = activePath;
  const activeTab = tabs.find((tab) => tab.document.relativePath === activePath) ?? null;
  const dirty = tabs.some((tab) => tab.dirty);
  dirtyRef.current = dirty;

  const loadDirectory = useCallback(
    async (relativePath: string, force = false) => {
      if (!bridge?.listProjectSourceDirectory || (!force && directories[relativePath])) return;
      const snapshot = await bridge.listProjectSourceDirectory({ projectId: props.project.id, relativePath });
      setDirectories((current) => ({ ...current, [relativePath]: snapshot }));
    },
    [bridge, directories, props.project.id],
  );

  const openFile = useCallback(
    async (relativePath: string, line?: number) => {
      const existing = tabsRef.current.find((tab) => tab.document.relativePath === relativePath);
      if (existing) {
        setTabs((current) => current.map((tab) => (tab.document.relativePath === relativePath ? { ...tab, revealLine: line ?? tab.revealLine } : tab)));
        setActivePath(relativePath);
        setTreeDrawerOpen(false);
        return;
      }
      if (!bridge?.readProjectSourceFile) {
        setError(zh ? 'Electron 源码桥接未就绪。' : 'Electron source bridge is unavailable.');
        return;
      }
      setBusyPath(relativePath);
      setError(null);
      try {
        const document = await bridge.readProjectSourceFile({ projectId: props.project.id, relativePath });
        setTabs((current) => {
          const available =
            current.length < 20
              ? current
              : current.filter((tab) => tab.dirty).length === current.length
                ? current
                : current.filter((tab) => tab.dirty || tab.document.relativePath !== current.find((candidate) => !candidate.dirty)?.document.relativePath);
          if (available.length >= 20) {
            setError(zh ? '已打开 20 个文件，请先关闭一个标签。' : 'Twenty files are already open. Close a tab first.');
            return current;
          }
          return [...available, { document, draft: document.content, dirty: false, saving: false, externalChange: false, revealLine: line, cursorLine: line ?? 1, cursorColumn: 1 }];
        });
        setActivePath(relativePath);
        setTreeDrawerOpen(false);
      } catch (loadError) {
        setError(loadError);
      } finally {
        setBusyPath(null);
      }
    },
    [bridge, props.project.id, zh],
  );

  const saveTab = useCallback(
    async (relativePath: string): Promise<boolean> => {
      const tab = tabsRef.current.find((candidate) => candidate.document.relativePath === relativePath);
      if (!tab || !tab.dirty) return true;
      if (!tab.document.editable || !bridge?.saveProjectSourceFile) return false;
      setTabs((current) => current.map((candidate) => (candidate.document.relativePath === relativePath ? { ...candidate, saving: true } : candidate)));
      setError(null);
      try {
        const document = await bridge.saveProjectSourceFile({
          projectId: props.project.id,
          relativePath,
          content: tab.draft,
          expectedRevision: tab.document.revision,
          eol: tab.document.eol,
          hasBom: tab.document.hasBom,
        });
        setTabs((current) => current.map((candidate) => (candidate.document.relativePath === relativePath ? { ...candidate, document, draft: document.content, dirty: false, saving: false, externalChange: false } : candidate)));
        setNotice(zh ? `已保存 ${relativePath}` : `Saved ${relativePath}`);
        return true;
      } catch (saveError) {
        setTabs((current) => current.map((candidate) => (candidate.document.relativePath === relativePath ? { ...candidate, saving: false, externalChange: true } : candidate)));
        setError(saveError);
        return false;
      }
    },
    [bridge, props.project.id, zh],
  );

  const saveAll = useCallback(async (): Promise<boolean> => {
    const dirtyPaths = tabsRef.current.filter((tab) => tab.dirty).map((tab) => tab.document.relativePath);
    const results = await Promise.all(dirtyPaths.map((path) => saveTab(path)));
    return results.every(Boolean);
  }, [saveTab]);

  const discardAll = useCallback(() => {
    setTabs((current) => current.map((tab) => ({ ...tab, draft: tab.document.content, dirty: false, externalChange: false })));
  }, []);

  useImperativeHandle(ref, () => ({ hasDirtyFiles: () => dirtyRef.current, saveAll, discardAll, openFile }), [discardAll, openFile, saveAll]);

  useEffect(() => props.onDirtyChange?.(dirty), [dirty, props.onDirtyChange]);

  useEffect(() => {
    let active = true;
    setLoadingTree(true);
    void (async () => {
      try {
        if (!bridge?.listProjectSourceDirectory) throw new Error(zh ? 'Electron 源码桥接未就绪。' : 'Electron source bridge is unavailable.');
        const root = await bridge.listProjectSourceDirectory({ projectId: props.project.id, relativePath: '' });
        if (!active) return;
        setDirectories({ '': root });
        const expandedSnapshots = await Promise.all(initialPreference.expandedDirectories.map((path) => bridge.listProjectSourceDirectory({ projectId: props.project.id, relativePath: path }).catch(() => null)));
        if (!active) return;
        setDirectories((current) => ({
          ...current,
          ...Object.fromEntries(expandedSnapshots.filter((item): item is ProjectSourceDirectorySnapshot => Boolean(item)).map((item) => [item.relativePath, item])),
        }));
        const restoredDocuments = await Promise.all(initialPreference.openFiles.slice(0, 20).map((relativePath) => bridge.readProjectSourceFile({ projectId: props.project.id, relativePath }).catch(() => null)));
        if (!active) return;
        const restoredTabs = restoredDocuments
          .filter((item): item is ProjectSourceDocument => Boolean(item))
          .map((document) => ({
            document,
            draft: document.content,
            dirty: false,
            saving: false,
            externalChange: false,
            cursorLine: 1,
            cursorColumn: 1,
          }));
        setTabs(restoredTabs);
        setActivePath((current) => (restoredTabs.some((tab) => tab.document.relativePath === current) ? current : (restoredTabs[0]?.document.relativePath ?? null)));
      } catch (loadError) {
        if (active) setError(loadError);
      } finally {
        if (active) setLoadingTree(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [bridge, props.project.id]);

  useEffect(() => {
    if (!bridge?.watchProjectSource || !bridge.onProjectSourceEvent) return undefined;
    const sourceBridge = bridge;
    void sourceBridge.watchProjectSource(props.project.id).catch(setError);
    const unsubscribe = sourceBridge.onProjectSourceEvent((event) => void handleSourceEvent(event));
    return () => {
      unsubscribe();
      void sourceBridge.unwatchProjectSource?.();
    };

    async function handleSourceEvent(event: ProjectSourceEvent): Promise<void> {
      if (event.projectId !== props.project.id) return;
      void sourceBridge
        .listProjectSourceDirectory({ projectId: props.project.id, relativePath: event.parentRelativePath })
        .then((snapshot) => setDirectories((current) => ({ ...current, [snapshot.relativePath]: snapshot })))
        .catch(() => undefined);
      const tab = tabsRef.current.find((candidate) => candidate.document.relativePath === event.relativePath);
      if (!tab) return;
      if (tab.dirty) {
        setTabs((current) => current.map((candidate) => (candidate.document.relativePath === event.relativePath ? { ...candidate, externalChange: true } : candidate)));
        return;
      }
      try {
        const document = await sourceBridge.readProjectSourceFile({ projectId: props.project.id, relativePath: event.relativePath });
        setTabs((current) => current.map((candidate) => (candidate.document.relativePath === event.relativePath ? { ...candidate, document, draft: document.content, externalChange: false } : candidate)));
      } catch {
        setTabs((current) => current.map((candidate) => (candidate.document.relativePath === event.relativePath ? { ...candidate, externalChange: true } : candidate)));
        setError(
          zh
            ? `“${event.relativePath}”已在磁盘中删除、重命名或变得不可访问。标签内容仍保留，可另存为或关闭。`
            : `“${event.relativePath}” was deleted, renamed, or became inaccessible on disk. The tab content is retained and can be saved as or closed.`,
        );
      }
    }
  }, [bridge, props.project.id]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (!searchQuery.trim() || !bridge?.searchProjectSourceEntries) {
        setSearchResults([]);
        setSearchTruncated(false);
        return;
      }
      void bridge
        .searchProjectSourceEntries({ projectId: props.project.id, query: searchQuery })
        .then((result) => {
          setSearchResults(result.entries);
          setSearchTruncated(result.truncated);
        })
        .catch(setError);
    }, 180);
    return () => window.clearTimeout(timer);
  }, [bridge, props.project.id, searchQuery]);

  useEffect(() => {
    if (loadingTree) return undefined;
    const preference: ProjectCodeWorkspacePreference = {
      openFiles: tabs.map((tab) => tab.document.relativePath).slice(-20),
      activeFile: activePath,
      expandedDirectories: [...expandedDirectories].slice(0, 200),
      treeWidth,
    };
    const timer = window.setTimeout(() => props.onPreferenceChange?.(preference), 250);
    return () => window.clearTimeout(timer);
  }, [activePath, expandedDirectories, loadingTree, props.onPreferenceChange, tabs, treeWidth]);

  useEffect(() => {
    const close = () => setContextMenu(null);
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, []);

  async function toggleDirectory(path: string): Promise<void> {
    if (expandedDirectories.has(path)) {
      setExpandedDirectories((current) => {
        const next = new Set(current);
        next.delete(path);
        return next;
      });
      return;
    }
    setBusyPath(path);
    try {
      await loadDirectory(path);
      setExpandedDirectories((current) => new Set(current).add(path));
    } catch (loadError) {
      setError(loadError);
    } finally {
      setBusyPath(null);
    }
  }

  function closeTab(path: string): void {
    const tab = tabsRef.current.find((candidate) => candidate.document.relativePath === path);
    if (tab?.dirty) {
      setPendingClosePath(path);
      return;
    }
    removeTab(path);
  }

  function removeTab(path: string): void {
    setTabs((current) => {
      const index = current.findIndex((candidate) => candidate.document.relativePath === path);
      const next = current.filter((candidate) => candidate.document.relativePath !== path);
      if (activePathRef.current === path) setActivePath(next[Math.min(index, next.length - 1)]?.document.relativePath ?? null);
      return next;
    });
  }

  function beginOperation(next: FileOperation): void {
    setContextMenu(null);
    setOperation(next);
    if (!next) return;
    if (next.kind === 'create-file' || next.kind === 'create-directory') {
      setOperationName('');
      setOperationParent(next.parentRelativePath);
    } else if (next.kind === 'save-as') {
      const tab = tabsRef.current.find((candidate) => candidate.document.relativePath === next.tabPath);
      const extensionIndex = tab?.document.name.lastIndexOf('.') ?? -1;
      const stem = extensionIndex > 0 ? tab!.document.name.slice(0, extensionIndex) : (tab?.document.name ?? 'untitled');
      const extension = extensionIndex > 0 ? tab!.document.name.slice(extensionIndex) : '';
      setOperationName(`${stem}-copy${extension}`);
      setOperationParent(parentPath(next.tabPath));
    } else {
      setOperationName(next.entry.name);
      setOperationParent(parentPath(next.entry.relativePath));
    }
  }

  async function submitOperation(): Promise<void> {
    if (!operation || !bridge) return;
    setError(null);
    setBusyPath(operation.kind);
    try {
      if (operation.kind === 'create-file' || operation.kind === 'create-directory') {
        const entry = await bridge.createProjectSourceEntry({ projectId: props.project.id, parentRelativePath: operationParent, name: operationName, kind: operation.kind === 'create-file' ? 'file' : 'directory' });
        await loadDirectory(operationParent, true);
        if (entry.kind === 'file') await openFile(entry.relativePath);
      } else if (operation.kind === 'save-as') {
        const sourceTab = tabsRef.current.find((tab) => tab.document.relativePath === operation.tabPath);
        if (!sourceTab) throw new Error(zh ? '原文件标签已经关闭。' : 'The source tab is already closed.');
        if (tabsRef.current.length >= 20) throw new Error(zh ? '已达到 20 个打开文件上限，请先关闭一个标签。' : 'The 20 open-file limit has been reached. Close a tab first.');
        const entry = await bridge.createProjectSourceEntry({ projectId: props.project.id, parentRelativePath: operationParent, name: operationName, kind: 'file' });
        const emptyDocument = await bridge.readProjectSourceFile({ projectId: props.project.id, relativePath: entry.relativePath });
        const document = await bridge.saveProjectSourceFile({
          projectId: props.project.id,
          relativePath: entry.relativePath,
          content: sourceTab.draft,
          expectedRevision: emptyDocument.revision,
          eol: sourceTab.document.eol,
          hasBom: sourceTab.document.hasBom,
        });
        setTabs((current) => [...current, { document, draft: document.content, dirty: false, saving: false, externalChange: false, cursorLine: 1, cursorColumn: 1 }]);
        setActivePath(document.relativePath);
        await loadDirectory(operationParent, true);
        setNotice(zh ? `已另存为 ${document.relativePath}` : `Saved as ${document.relativePath}`);
      } else if (operation.kind === 'rename' || operation.kind === 'move') {
        const entry = await bridge.moveProjectSourceEntry({ projectId: props.project.id, relativePath: operation.entry.relativePath, targetParentRelativePath: operationParent, targetName: operationName });
        const oldPath = operation.entry.relativePath;
        setTabs((current) => current.map((tab) => remapMovedTab(tab, oldPath, entry.relativePath, operation.entry.kind === 'directory')));
        setActivePath((current) => remapMovedPath(current, oldPath, entry.relativePath, operation.entry.kind === 'directory'));
        if (operation.entry.kind === 'directory') {
          setExpandedDirectories((current) => new Set([...current].map((path) => remapMovedPath(path, oldPath, entry.relativePath, true) ?? path)));
          // 子目录快照中的相对路径已失效，保留根节点并在展开时按需重新读取。
          setDirectories((current): Record<string, ProjectSourceDirectorySnapshot> => {
            const rootSnapshot = current[''];
            return rootSnapshot ? { '': rootSnapshot } : {};
          });
        }
        await Promise.all([loadDirectory(parentPath(oldPath), true), loadDirectory(operationParent, true)]);
      } else {
        const affectedTabs = tabsRef.current.filter((tab) => isSameOrChild(tab.document.relativePath, operation.entry.relativePath));
        if (
          affectedTabs.some((tab) => tab.dirty) &&
          !window.confirm(zh ? '删除范围内存在未保存文件。继续会放弃这些草稿，并将磁盘文件移入废纸篓。' : 'Unsaved files are inside this entry. Continue to discard drafts and move disk files to Trash?')
        )
          return;
        await bridge.trashProjectSourceEntry({ projectId: props.project.id, relativePath: operation.entry.relativePath });
        setTabs((current) => current.filter((tab) => !isSameOrChild(tab.document.relativePath, operation.entry.relativePath)));
        setActivePath((current) => (current && isSameOrChild(current, operation.entry.relativePath) ? null : current));
        await loadDirectory(parentPath(operation.entry.relativePath), true);
        setNotice(zh ? '已移入系统废纸篓，可在 Finder 中恢复。' : 'Moved to system Trash. You can restore it in Finder.');
      }
      setOperation(null);
    } catch (operationError) {
      setError(operationError);
    } finally {
      setBusyPath(null);
    }
  }

  function startTreeResize(event: ReactPointerEvent<HTMLDivElement>): void {
    const startX = event.clientX;
    const startWidth = treeWidth;
    const onMove = (moveEvent: PointerEvent) => setTreeWidth(clampTreeWidth(startWidth + moveEvent.clientX - startX));
    const onEnd = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onEnd);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onEnd);
  }

  const breadcrumbs = activePath?.split('/') ?? [];

  return (
    <section className="project-source-workspace" style={{ '--zeus-source-tree-width': `${treeWidth}px` } as CSSProperties} data-tree-open={treeDrawerOpen ? 'true' : 'false'}>
      <header className="project-source-toolbar">
        <button type="button" className="project-source-tree-toggle" onClick={() => setTreeDrawerOpen((open) => !open)} aria-label={zh ? '显示代码目录' : 'Show source tree'}>
          <FolderOpen aria-hidden="true" />
        </button>
        <span className="project-source-project-identity">
          <strong>{props.project.name}</strong>
          <small>{props.project.localPath}</small>
        </span>
        <span className="project-source-toolbar-actions">
          <button type="button" onClick={() => beginOperation({ kind: 'create-file', parentRelativePath: activePath ? parentPath(activePath) : '' })} title={zh ? '新建文件' : 'New file'}>
            <File aria-hidden="true" />
            <Plus aria-hidden="true" />
          </button>
          <button type="button" onClick={() => beginOperation({ kind: 'create-directory', parentRelativePath: activePath ? parentPath(activePath) : '' })} title={zh ? '新建目录' : 'New folder'}>
            <Folder aria-hidden="true" />
            <Plus aria-hidden="true" />
          </button>
          <Button size="compact" variant="secondary" onClick={() => void (activePath ? saveTab(activePath) : Promise.resolve())} disabled={!activeTab?.dirty || activeTab.saving}>
            <FloppyDisk aria-hidden="true" />
            {zh ? '保存' : 'Save'}
          </Button>
          <Button size="compact" variant="secondary" onClick={() => void saveAll()} disabled={!dirty}>
            {zh ? '保存全部' : 'Save all'}
          </Button>
        </span>
      </header>

      {notice || activeTab?.externalChange ? (
        <div className="project-source-message success" role="status">
          <span>{notice ?? (zh ? '文件已在外部发生变化，请重新加载或另存为。' : 'The file changed externally. Reload it or save it as a new file.')}</span>
          {activeTab?.externalChange ? (
            <>
              <button type="button" onClick={() => beginOperation({ kind: 'save-as', tabPath: activeTab.document.relativePath })}>
                {zh ? '另存为' : 'Save as'}
              </button>
              <button type="button" onClick={() => void reloadActiveTab()}>
                {zh ? '重新加载' : 'Reload'}
              </button>
            </>
          ) : null}
          <button type="button" aria-label={zh ? '关闭提示' : 'Dismiss'} onClick={() => setNotice(null)}>
            <X aria-hidden="true" />
          </button>
        </div>
      ) : null}

      <div className="project-source-main">
        <aside className="project-source-tree" aria-label={zh ? '代码目录' : 'Source tree'}>
          <label className="project-source-search">
            <MagnifyingGlass aria-hidden="true" />
            <input type="search" value={searchQuery} onChange={(event) => setSearchQuery(event.currentTarget.value)} placeholder={zh ? '搜索文件名' : 'Search file names'} />
          </label>
          <div className="project-source-tree-scroll" role="tree" aria-busy={loadingTree}>
            {searchQuery.trim() ? (
              <SearchResults entries={searchResults} truncated={searchTruncated} busyPath={busyPath} onOpen={(path) => void openFile(path)} zh={zh} />
            ) : loadingTree ? (
              <p className="project-source-empty">{zh ? '正在读取真实项目目录…' : 'Loading the real project directory…'}</p>
            ) : (
              <TreeRows
                directoryPath=""
                depth={0}
                directories={directories}
                expandedDirectories={expandedDirectories}
                activePath={activePath}
                busyPath={busyPath}
                onToggle={(path) => void toggleDirectory(path)}
                onOpen={(path) => void openFile(path)}
                onContextMenu={(entry, event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setContextMenu({ entry, x: event.clientX, y: event.clientY });
                }}
              />
            )}
          </div>
        </aside>
        <div
          className="project-source-tree-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label={zh ? '调整代码目录宽度' : 'Resize source tree'}
          aria-valuemin={200}
          aria-valuemax={420}
          aria-valuenow={treeWidth}
          onPointerDown={startTreeResize}
        />

        <main className="project-source-editor-pane">
          <div className="project-source-tabs" role="tablist" aria-label={zh ? '已打开文件' : 'Open files'}>
            {tabs.map((tab) => (
              <div key={tab.document.relativePath} className={`project-source-tab${tab.document.relativePath === activePath ? ' active' : ''}`}>
                <button type="button" role="tab" aria-selected={tab.document.relativePath === activePath} onClick={() => setActivePath(tab.document.relativePath)}>
                  <span>{tab.document.name}</span>
                  {tab.dirty ? (
                    <i aria-label={zh ? '未保存' : 'Unsaved'}>●</i>
                  ) : tab.externalChange ? (
                    <i className="external" aria-label={zh ? '外部已更改' : 'Changed externally'}>
                      !
                    </i>
                  ) : null}
                </button>
                <button type="button" className="project-source-tab-close" aria-label={zh ? `关闭 ${tab.document.name}` : `Close ${tab.document.name}`} onClick={() => closeTab(tab.document.relativePath)}>
                  ×
                </button>
              </div>
            ))}
          </div>
          {activeTab ? (
            <>
              <nav className="project-source-breadcrumbs" aria-label={zh ? '文件路径' : 'File path'}>
                {breadcrumbs.map((part, index) => (
                  <span key={`${part}-${index}`}>{part}</span>
                ))}
              </nav>
              {!activeTab.document.editable ? (
                <section className="project-source-readonly" aria-label={zh ? '文件不可编辑' : 'File is read-only'}>
                  <strong>{zh ? '此文件只能查看或在外部应用中打开' : 'This file is view-only in Zeus'}</strong>
                  <p>{readOnlyReason(activeTab.document, zh)}</p>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      if (bridge?.openProjectSourceExternally) void bridge.openProjectSourceExternally({ projectId: props.project.id, relativePath: activeTab.document.relativePath }).catch(setError);
                      else props.onOpenExternal?.(activeTab.document.relativePath);
                    }}
                  >
                    {zh ? '在外部应用中打开' : 'Open externally'}
                  </Button>
                </section>
              ) : (
                <Suspense fallback={<div className="project-source-code-editor-loading">{zh ? '正在加载代码编辑器…' : 'Loading code editor…'}</div>}>
                  <CodeEditor
                    path={activeTab.document.relativePath}
                    language={activeTab.document.language}
                    content={activeTab.draft}
                    readOnly={false}
                    revealLine={activeTab.revealLine}
                    onChange={(content) =>
                      setTabs((current) => current.map((tab) => (tab.document.relativePath === activeTab.document.relativePath ? { ...tab, draft: content, dirty: content !== tab.document.content, revealLine: null } : tab)))
                    }
                    onCursorChange={(cursorLine, cursorColumn) => setTabs((current) => current.map((tab) => (tab.document.relativePath === activeTab.document.relativePath ? { ...tab, cursorLine, cursorColumn } : tab)))}
                    onSave={() => void saveTab(activeTab.document.relativePath)}
                    onSaveAll={() => void saveAll()}
                  />
                </Suspense>
              )}
              <footer className="project-source-statusbar">
                <span>{activeTab.document.language}</span>
                <span>UTF-8{activeTab.document.hasBom ? ' BOM' : ''}</span>
                <span>{activeTab.document.eol.toUpperCase()}</span>
                <span>
                  Ln {activeTab.cursorLine}, Col {activeTab.cursorColumn}
                </span>
                {activeTab.externalChange ? <strong>{zh ? '磁盘内容已变化' : 'Disk content changed'}</strong> : null}
              </footer>
            </>
          ) : (
            <section className="project-source-editor-empty">
              <FolderOpen aria-hidden="true" />
              <strong>{zh ? '从左侧目录打开一个文件' : 'Open a file from the source tree'}</strong>
              <span>{zh ? '这里会显示和编辑当前项目中的真实源码。' : 'The real source from this project will appear here.'}</span>
            </section>
          )}
        </main>
      </div>

      {treeDrawerOpen ? <button type="button" className="project-source-tree-backdrop" aria-label={zh ? '关闭代码目录' : 'Close source tree'} onClick={() => setTreeDrawerOpen(false)} /> : null}

      {contextMenu ? (
        <div className="project-source-context-menu" role="menu" style={{ left: contextMenu.x, top: contextMenu.y }} onPointerDown={(event) => event.stopPropagation()}>
          {contextMenu.entry.kind === 'directory' ? (
            <>
              <button role="menuitem" type="button" onClick={() => beginOperation({ kind: 'create-file', parentRelativePath: contextMenu.entry.relativePath })}>
                {zh ? '新建文件' : 'New file'}
              </button>
              <button role="menuitem" type="button" onClick={() => beginOperation({ kind: 'create-directory', parentRelativePath: contextMenu.entry.relativePath })}>
                {zh ? '新建目录' : 'New folder'}
              </button>
            </>
          ) : null}
          <button role="menuitem" type="button" onClick={() => beginOperation({ kind: 'rename', entry: contextMenu.entry })}>
            {zh ? '重命名' : 'Rename'}
          </button>
          <button role="menuitem" type="button" onClick={() => beginOperation({ kind: 'move', entry: contextMenu.entry })}>
            {zh ? '移动…' : 'Move…'}
          </button>
          <button role="menuitem" type="button" onClick={() => void bridge?.revealProjectSourceEntry({ projectId: props.project.id, relativePath: contextMenu.entry.relativePath })}>
            {zh ? '在 Finder 中显示' : 'Reveal in Finder'}
          </button>
          <button role="menuitem" type="button" className="danger" onClick={() => beginOperation({ kind: 'delete', entry: contextMenu.entry })}>
            {zh ? '移入废纸篓…' : 'Move to Trash…'}
          </button>
        </div>
      ) : null}

      {operation ? (
        <ModalPortal rootClassName="project-source-modal-root" backdropClassName="project-source-modal-backdrop" onDismiss={() => setOperation(null)} dismissDisabled={Boolean(busyPath)}>
          <form
            className="project-source-operation-modal zeus-solid-form-surface"
            role="dialog"
            aria-modal="true"
            onSubmit={(event) => {
              event.preventDefault();
              void submitOperation();
            }}
          >
            <header>
              <strong>{operationTitle(operation, zh)}</strong>
              <button type="button" aria-label={zh ? '关闭' : 'Close'} onClick={() => setOperation(null)} disabled={Boolean(busyPath)}>
                ×
              </button>
            </header>
            <div>
              {operation.kind === 'delete' ? (
                <p>{zh ? `“${operation.entry.relativePath}”将移入 macOS 废纸篓，可在 Finder 中恢复。` : `“${operation.entry.relativePath}” will be moved to macOS Trash and can be restored in Finder.`}</p>
              ) : (
                <>
                  {(operation.kind === 'move' || operation.kind === 'create-file' || operation.kind === 'create-directory' || operation.kind === 'save-as') && (
                    <label>
                      <span>{zh ? '目标目录（项目相对路径）' : 'Target directory (project-relative)'}</span>
                      <input value={operationParent} onChange={(event) => setOperationParent(event.currentTarget.value)} placeholder="src/renderer" />
                    </label>
                  )}
                  <label>
                    <span>{zh ? '名称' : 'Name'}</span>
                    <input value={operationName} onChange={(event) => setOperationName(event.currentTarget.value)} autoFocus />
                  </label>
                </>
              )}
            </div>
            <footer>
              <Button type="button" variant="secondary" onClick={() => setOperation(null)} disabled={Boolean(busyPath)}>
                {zh ? '取消' : 'Cancel'}
              </Button>
              <Button type="submit" variant={operation.kind === 'delete' ? 'danger' : 'primary'} busy={Boolean(busyPath)} disabled={operation.kind !== 'delete' && !operationName.trim()}>
                {operation.kind === 'delete' ? (zh ? '移入废纸篓' : 'Move to Trash') : zh ? '确认' : 'Confirm'}
              </Button>
            </footer>
          </form>
        </ModalPortal>
      ) : null}

      {pendingClosePath ? (
        <ModalPortal rootClassName="project-source-modal-root" backdropClassName="project-source-modal-backdrop" onDismiss={() => setPendingClosePath(null)} dismissDisabled={Boolean(busyPath)}>
          <section className="project-source-operation-modal zeus-solid-form-surface" role="dialog" aria-modal="true" aria-labelledby="project-source-close-title">
            <header>
              <strong id="project-source-close-title">{zh ? '文件尚未保存' : 'File is not saved'}</strong>
            </header>
            <div>
              <p>{zh ? '关闭标签前，可以保存全部文件、放弃此文件草稿，或取消关闭。' : 'Before closing, save all files, discard this draft, or cancel.'}</p>
            </div>
            <footer>
              <Button type="button" variant="secondary" onClick={() => setPendingClosePath(null)}>
                {zh ? '取消' : 'Cancel'}
              </Button>
              <Button
                type="button"
                variant="danger"
                onClick={() => {
                  const path = pendingClosePath;
                  setPendingClosePath(null);
                  removeTab(path);
                }}
              >
                {zh ? '放弃' : 'Discard'}
              </Button>
              <Button
                type="button"
                variant="primary"
                busy={busyPath === 'close-tab'}
                onClick={() => {
                  const path = pendingClosePath;
                  setBusyPath('close-tab');
                  void saveAll()
                    .then((saved) => {
                      if (saved && path) {
                        setPendingClosePath(null);
                        removeTab(path);
                      }
                    })
                    .finally(() => setBusyPath(null));
                }}
              >
                {zh ? '保存全部' : 'Save all'}
              </Button>
            </footer>
          </section>
        </ModalPortal>
      ) : null}
    </section>
  );

  async function reloadActiveTab(): Promise<void> {
    if (!activeTab || !bridge?.readProjectSourceFile) return;
    if (activeTab.dirty && !window.confirm(zh ? '重新加载会放弃当前未保存内容，是否继续？' : 'Reloading discards the unsaved draft. Continue?')) return;
    try {
      const document = await bridge.readProjectSourceFile({ projectId: props.project.id, relativePath: activeTab.document.relativePath });
      setTabs((current) => current.map((tab) => (tab.document.relativePath === document.relativePath ? { ...tab, document, draft: document.content, dirty: false, externalChange: false } : tab)));
      setError(null);
    } catch (reloadError) {
      setError(reloadError);
    }
  }
});

function TreeRows(props: {
  directoryPath: string;
  depth: number;
  directories: Record<string, ProjectSourceDirectorySnapshot>;
  expandedDirectories: Set<string>;
  activePath: string | null;
  busyPath: string | null;
  onToggle(path: string): void;
  onOpen(path: string): void;
  onContextMenu(entry: ProjectSourceEntry, event: ReactMouseEvent<HTMLButtonElement>): void;
}) {
  const directory = props.directories[props.directoryPath];
  if (!directory) return null;
  return directory.entries.map((entry) => {
    const directoryEntry = entry.kind === 'directory';
    const expanded = directoryEntry && props.expandedDirectories.has(entry.relativePath);
    return (
      <div key={entry.relativePath} role="none">
        <button
          type="button"
          role="treeitem"
          aria-selected={entry.relativePath === props.activePath}
          aria-expanded={directoryEntry ? expanded : undefined}
          className={entry.relativePath === props.activePath ? 'selected' : ''}
          style={{ paddingInlineStart: `${10 + props.depth * 14}px` }}
          disabled={!entry.accessible || props.busyPath === entry.relativePath}
          onClick={() => (directoryEntry ? props.onToggle(entry.relativePath) : props.onOpen(entry.relativePath))}
          onContextMenu={(event) => props.onContextMenu(entry, event)}
        >
          <span className="project-source-disclosure" aria-hidden="true">
            {directoryEntry ? (expanded ? '⌄' : '›') : ''}
          </span>
          {directoryEntry ? expanded ? <FolderOpen aria-hidden="true" /> : <Folder aria-hidden="true" /> : <File aria-hidden="true" />}
          <span>{entry.name}</span>
          {entry.kind === 'symlink' ? <small>↗</small> : null}
        </button>
        {expanded ? <TreeRows {...props} directoryPath={entry.relativePath} depth={props.depth + 1} /> : null}
      </div>
    );
  });
}

function SearchResults(props: { entries: ProjectSourceEntry[]; truncated: boolean; busyPath: string | null; onOpen(path: string): void; zh: boolean }) {
  if (props.entries.length === 0) return <p className="project-source-empty">{props.zh ? '没有匹配的文件。' : 'No matching files.'}</p>;
  return (
    <>
      {props.entries.map((entry) => (
        <button key={entry.relativePath} type="button" role="treeitem" disabled={!entry.accessible || entry.kind === 'directory' || props.busyPath === entry.relativePath} onClick={() => props.onOpen(entry.relativePath)}>
          {entry.kind === 'directory' ? <Folder aria-hidden="true" /> : <File aria-hidden="true" />}
          <span>
            <strong>{entry.name}</strong>
            <small>{entry.relativePath}</small>
          </span>
        </button>
      ))}
      {props.truncated ? <p className="project-source-empty">{props.zh ? '仅显示前 200 项，请缩小搜索范围。' : 'Showing the first 200 results. Refine your search.'}</p> : null}
    </>
  );
}

function normalizePreference(value: ProjectCodeWorkspacePreference | undefined): ProjectCodeWorkspacePreference {
  return {
    openFiles: Array.isArray(value?.openFiles) ? value.openFiles.filter(Boolean).slice(0, 20) : [],
    activeFile: typeof value?.activeFile === 'string' ? value.activeFile : null,
    expandedDirectories: Array.isArray(value?.expandedDirectories) ? value.expandedDirectories.filter(Boolean).slice(0, 200) : [],
    treeWidth: clampTreeWidth(value?.treeWidth ?? 260),
  };
}

function clampTreeWidth(width: number): number {
  return Math.max(200, Math.min(420, Math.round(Number.isFinite(width) ? width : 260)));
}

function parentPath(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? '' : path.slice(0, index);
}

function isSameOrChild(path: string, parent: string): boolean {
  return path === parent || path.startsWith(`${parent}/`);
}

function remapMovedPath(path: string | null, oldPath: string, newPath: string, directory: boolean): string | null {
  if (!path) return path;
  if (path === oldPath) return newPath;
  return directory && path.startsWith(`${oldPath}/`) ? `${newPath}${path.slice(oldPath.length)}` : path;
}

function remapMovedTab(tab: SourceTab, oldPath: string, newPath: string, directory: boolean): SourceTab {
  const relativePath = remapMovedPath(tab.document.relativePath, oldPath, newPath, directory);
  if (!relativePath || relativePath === tab.document.relativePath) return tab;
  return { ...tab, document: { ...tab.document, relativePath, name: relativePath.split('/').at(-1) ?? relativePath } };
}

function operationTitle(operation: NonNullable<FileOperation>, zh: boolean): string {
  const titles = zh
    ? { 'create-file': '新建文件', 'create-directory': '新建目录', rename: '重命名', move: '移动文件或目录', delete: '确认移入废纸篓', 'save-as': '另存为' }
    : { 'create-file': 'New file', 'create-directory': 'New folder', rename: 'Rename', move: 'Move file or folder', delete: 'Move to Trash', 'save-as': 'Save as' };
  return titles[operation.kind];
}

function readOnlyReason(document: ProjectSourceDocument, zh: boolean): string {
  const reasons = zh
    ? { binary: '检测到二进制内容。', invalid_encoding: '文件不是有效的 UTF-8 文本。', too_large: '文件超过 2 MiB 编辑上限。', symlink: '符号链接文件在 Zeus 中保持只读。', not_regular_file: '目标不是普通文件。' }
    : {
        binary: 'Binary content was detected.',
        invalid_encoding: 'The file is not valid UTF-8 text.',
        too_large: 'The file exceeds the 2 MiB editor limit.',
        symlink: 'Symlink files remain read-only in Zeus.',
        not_regular_file: 'The target is not a regular file.',
      };
  return document.readOnlyReason ? reasons[document.readOnlyReason] : zh ? '文件不可编辑。' : 'The file is not editable.';
}
