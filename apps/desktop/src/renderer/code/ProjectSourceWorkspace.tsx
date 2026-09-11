import { useMotionPresence } from '../ui/useMotionPresence.js';
import { createPortal } from 'react-dom';
import { MenuSurface } from '../ui/MenuSurface.js';
import { MotionPresence } from '../ui/MotionPresence.js';
import { Collapsible } from '../ui/Collapsible.js';
import { Suspense, forwardRef, lazy, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { sourceConflictExtensions } from './sourceConflictExtensions.js';
import { FileIcon as File } from '@phosphor-icons/react/dist/csr/File';
import { FloppyDiskIcon as FloppyDisk } from '@phosphor-icons/react/dist/csr/FloppyDisk';
import { FolderIcon as Folder } from '@phosphor-icons/react/dist/csr/Folder';
import { FolderOpenIcon as FolderOpen } from '@phosphor-icons/react/dist/csr/FolderOpen';
import { MagnifyingGlassIcon as MagnifyingGlass } from '@phosphor-icons/react/dist/csr/MagnifyingGlass';
import { PlusIcon as Plus } from '@phosphor-icons/react/dist/csr/Plus';
import type { ProjectCodeWorkspacePreference, ProjectSourceDirectorySnapshot, ProjectSourceDocument, ProjectSourceEntry, ProjectSourceEvent } from '@zeus/shared';
import type { Text } from '@codemirror/state';
import { Button } from '../ui/Button.js';
import { ModalPortal } from '../ui/ModalPortal.js';
import { useApplicationErrorDialog } from '../ui/ApplicationErrorDialog.js';
import './projectSourceWorkspace.css';
import type { ProjectGitWorkbenchSnapshot } from '../features/git/gitContracts.js';
import type { GitDiffSummary } from '../features/git/gitContracts.js';
import { SideBySideDiff } from '../git/ProjectGitDiffViewer.js';

const CodeEditor = lazy(() => import('./CodeEditor.js').then((module) => ({ default: module.CodeEditor })));
// 文件系统事件在这个时间窗内按目录和文件去重，避免批量写入触发重复读取与渲染。
const sourceEventRefreshDelayMs = 100;

function SourceChanges(props: { projectId: string; zh: boolean; onConflict(path: string): void; onOpen(path: string, diff: GitDiffSummary, staged: boolean): void }) {
  const [snapshot, setSnapshot] = useState<ProjectGitWorkbenchSnapshot | null>(null);
  const [error, setError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  useEffect(() => {
    let active = true;
    setSnapshot(null);
    setError('');
    const load = window.zeus?.loadProjectGitWorkbench;
    if (!load) {
      setError(props.zh ? '当前环境不支持读取 Git 更改。' : 'Git changes are unavailable.');
      return;
    }
    void load(props.projectId)
      .then((value) => {
        if (active) setSnapshot(value);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      active = false;
    };
  }, [props.projectId, props.zh, refreshKey]);
  useEffect(() => {
    const refresh = () => setRefreshKey((key) => key + 1);
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, []);
  return (
    <details className="project-source-module project-source-changes" open>
      <summary>{props.zh ? '更改' : 'Changes'}</summary>
      <div className="project-source-changes-body">
        <button type="button" onClick={() => setRefreshKey((key) => key + 1)}>
          {props.zh ? '刷新更改' : 'Refresh changes'}
        </button>
        {error ? <p role="alert">{error}</p> : !snapshot ? <p>{props.zh ? '正在读取更改…' : 'Loading changes…'}</p> : null}
        {snapshot?.repositories.length === 0 ? <p>{props.zh ? '此项目没有 Git 仓库。' : 'No Git repository.'}</p> : null}
        {snapshot?.repositories.map((repository) => (
          <details key={repository.id} open>
            <summary>
              <strong>{repository.name}</strong>
              <small>{repository.snapshot.branch}</small>
            </summary>
            {(
              [
                [props.zh ? '合并更改' : 'Merge changes', repository.snapshot.fileStatuses.filter((file) => repository.snapshot.conflictFiles.includes(file.path))],
                [
                  props.zh ? '暂存的更改' : 'Staged changes',
                  repository.snapshot.fileStatuses.filter((file) => !repository.snapshot.conflictFiles.includes(file.path) && file.indexStatus !== ' ' && file.indexStatus !== '?' && file.indexStatus !== '!'),
                ],
                [props.zh ? '更改' : 'Changes', repository.snapshot.fileStatuses.filter((file) => !repository.snapshot.conflictFiles.includes(file.path) && file.workingTreeStatus !== ' ' && file.workingTreeStatus !== '!')],
              ] as const
            ).map(([label, files]) => (
              <details key={label} open>
                <summary>
                  {label}
                  <small>{files.length}</small>
                </summary>
                {files.map((file) => (
                  <button
                    key={file.path}
                    type="button"
                    title={file.path}
                    onClick={() => {
                      if (repository.snapshot.conflictFiles.includes(file.path)) {
                        props.onConflict([repository.relativePath === '.' ? '' : repository.relativePath, file.path].filter(Boolean).join('/'));
                        return;
                      }
                      const staged = label === (props.zh ? '暂存的更改' : 'Staged changes');
                      const source = staged ? repository.snapshot.stagedDiff : repository.snapshot.unstagedDiff;
                      props.onOpen(
                        [repository.relativePath === '.' ? '' : repository.relativePath, file.path].filter(Boolean).join('/'),
                        { ...source, fileDiffs: source.fileDiffs.filter((entry) => entry.newPath === file.path || entry.oldPath === file.path), files: [file.path] },
                        staged,
                      );
                    }}
                  >
                    <File aria-hidden="true" />
                    <span>{file.path}</span>
                    <small>{file.indexStatus.trim() || file.workingTreeStatus.trim()}</small>
                  </button>
                ))}
                {files.length === 0 ? <p>{props.zh ? '暂无更改' : 'No changes'}</p> : null}
              </details>
            ))}
          </details>
        ))}
      </div>
    </details>
  );
}

type AppLanguage = 'zh-CN' | 'en-US';

interface SourceTab {
  document: ProjectSourceDocument;
  /** 编辑期间保留文档树，跨进程保存时才展开全文。 */
  draft: string | Text;
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
  const [conflictComparison, setConflictComparison] = useState<{ current: string; incoming: string } | null>(null);
  const conflictExtensions = useMemo(() => sourceConflictExtensions(zh, (current, incoming) => setConflictComparison({ current, incoming })), [zh]);
  const bridge = typeof window === 'undefined' ? undefined : window.zeus;
  const initialPreference = normalizePreference(props.preference);
  const [directories, setDirectories] = useState<Record<string, ProjectSourceDirectorySnapshot>>({});
  const [expandedDirectories, setExpandedDirectories] = useState<Set<string>>(() => new Set(initialPreference.expandedDirectories));
  const [tabs, setTabs] = useState<SourceTab[]>([]);
  const [activePath, setActivePath] = useState<string | null>(initialPreference.activeFile);
  const [changePreview, setChangePreview] = useState<{ projectId: string; path: string; diff: GitDiffSummary; staged: boolean } | null>(null);
  const [treeWidth, setTreeWidth] = useState(initialPreference.treeWidth);
  const [sourceShare, setSourceShare] = useState(55);
  const [treeDrawerOpen, setTreeDrawerOpen] = useState(false);
  /** 窄布局遮罩退出完成后再移除，关闭立即停止命中。 */
  const treeBackdrop = useMotionPresence<HTMLButtonElement>(treeDrawerOpen);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<ProjectSourceEntry[]>([]);
  const [searchTruncated, setSearchTruncated] = useState(false);
  const [loadingTree, setLoadingTree] = useState(true);
  const [busyPath, setBusyPath] = useState<string | null>(null);
  /** 只记录解码失败的内容版本；图片在磁盘更新后可自动重新预览。 */
  const [failedImageRevision, setFailedImageRevision] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  useApplicationErrorDialog(error, {
    language: zh ? 'zh-CN' : 'en',
  });
  const [operation, setOperation] = useState<FileOperation>(null);
  const [operationName, setOperationName] = useState('');
  const [operationParent, setOperationParent] = useState('');
  const [pendingClosePath, setPendingClosePath] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ entry: ProjectSourceEntry; x: number; y: number } | null>(null);
  const directoriesRef = useRef(directories);
  const tabsRef = useRef(tabs);
  const activePathRef = useRef(activePath);
  const dirtyRef = useRef(false);
  const fileOpenRequestedRef = useRef(false);
  directoriesRef.current = directories;
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
      setChangePreview(null);
      fileOpenRequestedRef.current = true;
      const existing = tabsRef.current.find((tab) => tab.document.relativePath === relativePath);
      if (existing) {
        setTabs((current) => current.map((tab) => (tab.document.relativePath === relativePath ? { ...tab, revealLine: line ?? tab.revealLine } : tab)));
        setActivePath(relativePath);
        setTreeDrawerOpen(false);
        return;
      }
      if (!bridge?.readProjectSourceFile) {
        setError(zh ? 'Zeus 的文件编辑服务尚未连接。' : 'Zeus has not connected to the file editing service yet.');
        return;
      }
      setBusyPath(relativePath);
      setError(null);
      try {
        const document = await bridge.readProjectSourceFile({ projectId: props.project.id, relativePath });
        setTabs((current) => {
          if (current.some((tab) => tab.document.relativePath === relativePath)) {
            return current.map((tab) => (tab.document.relativePath === relativePath ? { ...tab, revealLine: line ?? tab.revealLine } : tab));
          }
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
          content: tab.draft.toString(),
          expectedRevision: tab.document.revision,
          eol: tab.document.eol,
          hasBom: tab.document.hasBom,
        });
        /** 保存期间继续输入时保留新草稿，不能用较早的磁盘回执覆盖它。 */
        const editedWhileSaving = tabsRef.current.find((candidate) => candidate.document.relativePath === relativePath)?.draft !== tab.draft;
        setTabs((current) =>
          current.map((candidate) =>
            candidate.document.relativePath === relativePath
              ? { ...candidate, document, draft: candidate.draft === tab.draft ? document.content : candidate.draft, dirty: candidate.draft !== tab.draft, saving: false, externalChange: false }
              : candidate,
          ),
        );
        return !editedWhileSaving;
      } catch (saveError) {
        setTabs((current) => current.map((candidate) => (candidate.document.relativePath === relativePath ? { ...candidate, saving: false, externalChange: true } : candidate)));
        setError(saveError);
        return false;
      }
    },
    [bridge, props.project.id],
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

  useEffect(
    () => () => {
      props.onDirtyChange?.(false);
    },
    [props.onDirtyChange],
  );

  useEffect(() => {
    let active = true;
    setLoadingTree(true);
    void (async () => {
      try {
        if (!bridge?.listProjectSourceDirectory) throw new Error(zh ? 'Zeus 的文件编辑服务尚未连接。' : 'Zeus has not connected to the file editing service yet.');
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
        // 恢复偏好期间可能已收到用户打开请求，不能覆盖新标签与草稿。
        setTabs((current) => {
          const openPaths = new Set(current.map((tab) => tab.document.relativePath));
          return [...current, ...restoredTabs.filter((tab) => !openPaths.has(tab.document.relativePath))].slice(0, 20);
        });
        if (!fileOpenRequestedRef.current) {
          setActivePath((current) => (restoredTabs.some((tab) => tab.document.relativePath === current) ? current : (restoredTabs[0]?.document.relativePath ?? null)));
        }
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
    let active = true;
    let refreshing = false;
    let refreshTimer: number | null = null;
    const pendingDirectoryPaths = new Set<string>();
    const pendingFilePaths = new Set<string>();
    const watcherReady = sourceBridge.watchProjectSource(props.project.id);
    void watcherReady.catch((watchError) => {
      if (active) setError(watchError);
    });
    const unsubscribe = sourceBridge.onProjectSourceEvent(queueSourceEvent);
    return () => {
      active = false;
      unsubscribe();
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      pendingDirectoryPaths.clear();
      pendingFilePaths.clear();
      void watcherReady.then(() => sourceBridge.unwatchProjectSource?.()).catch(() => undefined);
    };

    /** 只把界面已加载的目录或已打开的文件放入有界刷新队列。 */
    function queueSourceEvent(event: ProjectSourceEvent): void {
      if (event.projectId !== props.project.id) return;
      if (Object.prototype.hasOwnProperty.call(directoriesRef.current, event.parentRelativePath)) pendingDirectoryPaths.add(event.parentRelativePath);
      if (tabsRef.current.some((candidate) => candidate.document.relativePath === event.relativePath)) pendingFilePaths.add(event.relativePath);
      scheduleSourceRefresh();
    }

    /** 在当前刷新结束后统一处理积压事件，保证同一时刻最多只有一批磁盘读取。 */
    function scheduleSourceRefresh(): void {
      if (refreshing || refreshTimer !== null || (pendingDirectoryPaths.size === 0 && pendingFilePaths.size === 0)) return;
      refreshTimer = window.setTimeout(() => void flushSourceRefresh(), sourceEventRefreshDelayMs);
    }

    /** 合并读取已加载目录和已打开文件，并一次性更新目录快照。 */
    async function flushSourceRefresh(): Promise<void> {
      refreshTimer = null;
      refreshing = true;
      const directoryPaths = [...pendingDirectoryPaths];
      const filePaths = [...pendingFilePaths];
      pendingDirectoryPaths.clear();
      pendingFilePaths.clear();
      try {
        const snapshots = await Promise.all(directoryPaths.map((relativePath) => sourceBridge.listProjectSourceDirectory({ projectId: props.project.id, relativePath }).catch(() => null)));
        if (active) {
          const availableSnapshots = snapshots.filter((snapshot): snapshot is ProjectSourceDirectorySnapshot => Boolean(snapshot));
          if (availableSnapshots.length > 0) {
            setDirectories((current) => ({ ...current, ...Object.fromEntries(availableSnapshots.map((snapshot) => [snapshot.relativePath, snapshot])) }));
          }
          await Promise.all(filePaths.map(refreshOpenFile));
        }
      } finally {
        refreshing = false;
        if (active) scheduleSourceRefresh();
      }
    }

    /** 保留脏草稿，只标记外部变更；干净标签直接同步磁盘内容。 */
    async function refreshOpenFile(relativePath: string): Promise<void> {
      const tab = tabsRef.current.find((candidate) => candidate.document.relativePath === relativePath);
      if (!tab || !active) return;
      if (tab.dirty) {
        setTabs((current) => current.map((candidate) => (candidate.document.relativePath === relativePath ? { ...candidate, externalChange: true } : candidate)));
        return;
      }
      try {
        const document = await sourceBridge.readProjectSourceFile({ projectId: props.project.id, relativePath });
        if (active) setTabs((current) => current.map((candidate) => (candidate.document.relativePath === relativePath ? { ...candidate, document, draft: document.content, externalChange: false } : candidate)));
      } catch {
        if (active) {
          // 外部删除、重命名或暂时不可访问只更新标签状态，保留内容，不弹出操作失败提示。
          setTabs((current) => current.map((candidate) => (candidate.document.relativePath === relativePath ? { ...candidate, externalChange: true } : candidate)));
        }
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
      // 再次展开也读取磁盘，避免外部文件操作后一直显示旧快照。
      await loadDirectory(path, true);
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
          content: sourceTab.draft.toString(),
          expectedRevision: emptyDocument.revision,
          eol: sourceTab.document.eol,
          hasBom: sourceTab.document.hasBom,
        });
        setTabs((current) => [...current, { document, draft: document.content, dirty: false, saving: false, externalChange: false, cursorLine: 1, cursorColumn: 1 }]);
        setActivePath(document.relativePath);
        await loadDirectory(operationParent, true);
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
        if (operation.entry.kind === 'directory') {
          const deletedPath = operation.entry.relativePath;
          // 删除成功后清除子目录缓存，避免同名目录重新创建时显示旧文件。
          setDirectories((current) => Object.fromEntries(Object.entries(current).filter(([path]) => !isSameOrChild(path, deletedPath))));
          setExpandedDirectories((current) => new Set([...current].filter((path) => !isSameOrChild(path, deletedPath))));
        }
        const currentTabs = tabsRef.current;
        const currentPath = activePathRef.current;
        const remainingTabs = currentTabs.filter((tab) => !isSameOrChild(tab.document.relativePath, operation.entry.relativePath));
        setTabs(remainingTabs);
        if (currentPath && isSameOrChild(currentPath, operation.entry.relativePath)) {
          const activeIndex = currentTabs.findIndex((tab) => tab.document.relativePath === currentPath);
          const nextIndex = currentTabs.slice(0, activeIndex).filter((tab) => !isSameOrChild(tab.document.relativePath, operation.entry.relativePath)).length;
          setActivePath(remainingTabs[Math.min(nextIndex, remainingTabs.length - 1)]?.document.relativePath ?? null);
        }
        await loadDirectory(parentPath(operation.entry.relativePath), true);
      }
      setOperation(null);
    } catch (operationError) {
      setError(operationError);
    } finally {
      setBusyPath(null);
    }
  }

  /** 记录本次拖拽起点；指针捕获保证离开分隔条后仍能平顺拖动。 */
  const treeResize = useRef<{ x: number; width: number } | null>(null);
  /** 只有主鼠标键开始调宽，右键保持菜单行为。 */
  function startTreeResize(event: ReactPointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.dataset.dragging = 'true';
    treeResize.current = { x: event.clientX, width: treeWidth };
  }
  /** 松开、取消或失去捕获均结束同一次拖拽，不留下全局监听。 */
  function finishTreeResize(event: ReactPointerEvent<HTMLDivElement>): void {
    treeResize.current = null;
    delete event.currentTarget.dataset.dragging;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
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

      {/* 成功结果由文件树与标签体现；这里只保留需要用户处理的外部修改提醒。 */}
      {activeTab?.externalChange ? (
        <div className="project-source-message" role="status">
          <span>{zh ? '文件已在外部发生变化，请重新加载或另存为。' : 'The file changed externally. Reload it or save it as a new file.'}</span>
          {activeTab.document.editable || activeTab.document.readOnlyReason === 'symlink' ? (
            <button type="button" onClick={() => beginOperation({ kind: 'save-as', tabPath: activeTab.document.relativePath })}>
              {zh ? '另存为' : 'Save as'}
            </button>
          ) : null}
          <button type="button" onClick={() => void reloadActiveTab()}>
            {zh ? '重新加载' : 'Reload'}
          </button>
        </div>
      ) : null}

      {conflictComparison ? (
        <ModalPortal rootClassName="project-source-modal-root" backdropClassName="project-source-modal-backdrop" onDismiss={() => setConflictComparison(null)}>
          <section className="project-source-conflict-comparison" role="dialog" aria-modal="true" aria-label={zh ? '比较变更' : 'Compare changes'}>
            <header>
              <strong>{zh ? '比较变更' : 'Compare changes'}</strong>
              <button type="button" onClick={() => setConflictComparison(null)}>
                {zh ? '关闭' : 'Close'}
              </button>
            </header>
            <div className="project-source-conflict-columns">
              <section>
                <h3>{zh ? '当前更改' : 'Current changes'}</h3>
                <Suspense fallback={null}>
                  <CodeEditor path="conflict-current" language={activeTab?.document.language ?? null} content={conflictComparison.current} readOnly />
                </Suspense>
              </section>
              <section>
                <h3>{zh ? '传入更改' : 'Incoming changes'}</h3>
                <Suspense fallback={null}>
                  <CodeEditor path="conflict-incoming" language={activeTab?.document.language ?? null} content={conflictComparison.incoming} readOnly />
                </Suspense>
              </section>
            </div>
          </section>
        </ModalPortal>
      ) : null}
      <div className="project-source-main">
        <aside className="project-source-tree" style={{ '--source-module-share': `${sourceShare}%` } as CSSProperties} aria-label={zh ? '代码目录' : 'Source tree'}>
          <details className="project-source-module" open>
            <summary>{zh ? '源码' : 'Source'}</summary>
            <label className="project-source-search">
              <MagnifyingGlass aria-hidden="true" />
              <input type="search" value={searchQuery} onChange={(event) => setSearchQuery(event.currentTarget.value)} placeholder={zh ? '搜索文件名' : 'Search file names'} />
            </label>
            <div className="project-source-tree-scroll" role="tree" aria-busy={loadingTree}>
              {searchQuery.trim() ? (
                <SearchResults entries={searchResults} truncated={searchTruncated} busyPath={busyPath} onOpen={(path) => void openFile(path)} zh={zh} />
              ) : loadingTree ? (
                <p className="project-source-empty">{zh ? '正在读取项目目录…' : 'Loading the project folder…'}</p>
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
          </details>
          <div
            className="project-source-module-resizer"
            role="separator"
            aria-orientation="horizontal"
            aria-label={zh ? '调整源码与更改模块高度' : 'Resize source and changes panels'}
            aria-valuemin={15}
            aria-valuemax={85}
            aria-valuenow={sourceShare}
            tabIndex={0}
            onPointerDown={(event) => {
              event.preventDefault();
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
              const bounds = event.currentTarget.parentElement!.getBoundingClientRect();
              setSourceShare(Math.max(15, Math.min(85, ((event.clientY - bounds.top) / bounds.height) * 100)));
            }}
            onPointerUp={(event) => {
              if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
            }}
            onDoubleClick={() => setSourceShare(55)}
            onKeyDown={(event) => {
              if (!['ArrowUp', 'ArrowDown', 'Home'].includes(event.key)) return;
              event.preventDefault();
              setSourceShare((value) => (event.key === 'Home' ? 55 : Math.max(15, Math.min(85, value + (event.key === 'ArrowUp' ? -5 : 5)))));
            }}
          />
          <SourceChanges projectId={props.project.id} zh={zh} onConflict={(path) => void openFile(path)} onOpen={(path, diff, staged) => setChangePreview({ projectId: props.project.id, path, diff, staged })} />
        </aside>
        <div
          className="project-source-tree-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label={zh ? '调整代码目录宽度' : 'Resize source tree'}
          aria-valuemin={200}
          aria-valuemax={420}
          aria-valuenow={treeWidth}
          tabIndex={0}
          onDoubleClick={() => setTreeWidth(260)}
          onPointerDown={startTreeResize}
          onPointerMove={(event) => {
            if (treeResize.current && event.currentTarget.hasPointerCapture(event.pointerId)) setTreeWidth(clampTreeWidth(treeResize.current.width + event.clientX - treeResize.current.x));
          }}
          onPointerUp={finishTreeResize}
          onPointerCancel={finishTreeResize}
          onLostPointerCapture={finishTreeResize}
          onKeyDown={(event) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return;
            event.preventDefault();
            setTreeWidth(event.key === 'Home' ? 260 : clampTreeWidth(treeWidth + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 24 : 8)));
          }}
        />

        <main className="project-source-editor-pane">
          <div className="project-source-tabs" role="tablist" aria-label={zh ? '已打开文件' : 'Open files'}>
            {tabs.map((tab) => (
              <div key={tab.document.relativePath} className={`project-source-tab${tab.document.relativePath === activePath ? ' active' : ''}`}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={!changePreview && tab.document.relativePath === activePath}
                  onClick={() => {
                    setChangePreview(null);
                    setActivePath(tab.document.relativePath);
                  }}
                >
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
          {changePreview?.projectId === props.project.id ? (
            <section className="project-source-change-preview">
              <header>
                <span>
                  {changePreview.path} · {changePreview.staged ? (zh ? 'HEAD → 暂存区' : 'HEAD → Index') : zh ? '暂存区 → 工作区' : 'Index → Working tree'}
                </span>
                <button type="button" onClick={() => setChangePreview(null)}>
                  {zh ? '关闭对比' : 'Close diff'}
                </button>
              </header>
              {changePreview.diff.fileDiffs.length ? (
                <SideBySideDiff key={`${changePreview.path}:${changePreview.staged}`} diff={changePreview.diff} zh={zh} title={changePreview.path} fill />
              ) : (
                <p>{zh ? '当前快照没有此文件的文本差异，请刷新更改；二进制文件不支持文本对比。' : 'No text diff in this snapshot. Refresh changes; binary files cannot be compared as text.'}</p>
              )}
            </section>
          ) : activeTab ? (
            <>
              <nav className="project-source-breadcrumbs" aria-label={zh ? '文件路径' : 'File path'}>
                {breadcrumbs.map((part, index) => (
                  <span key={`${part}-${index}`}>{part}</span>
                ))}
              </nav>
              {activeTab.document.imagePreviewUrl && failedImageRevision !== activeTab.document.revision.sha256 ? (
                <section className="project-source-image-preview" aria-label={zh ? '图片预览' : 'Image preview'}>
                  <img
                    key={`${activeTab.document.relativePath}:${activeTab.document.revision.sha256}`}
                    src={activeTab.document.imagePreviewUrl}
                    alt={activeTab.document.name}
                    decoding="async"
                    onError={() => setFailedImageRevision(activeTab.document.revision.sha256)}
                  />
                </section>
              ) : !activeTab.document.editable ? (
                <section className="project-source-readonly" aria-label={zh ? '文件不可编辑' : 'File is read-only'}>
                  <strong>{activeTab.document.imagePreviewUrl ? (zh ? '无法预览此图片' : 'Unable to preview this image') : zh ? '此文件只能查看或在外部应用中打开' : 'This file is view-only in Zeus'}</strong>
                  <p>{activeTab.document.imagePreviewUrl ? (zh ? '图片可能已损坏，或当前格式无法解码。' : 'The image may be damaged or cannot be decoded.') : readOnlyReason(activeTab.document, zh)}</p>
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
                    extensions={conflictExtensions}
                    path={activeTab.document.relativePath}
                    language={activeTab.document.language}
                    content={activeTab.draft}
                    savedContent={activeTab.document.content}
                    readOnly={false}
                    revealLine={activeTab.revealLine}
                    onDocumentChange={(content, dirty) => setTabs((current) => current.map((tab) => (tab.document.relativePath === activeTab.document.relativePath ? { ...tab, draft: content, dirty, revealLine: null } : tab)))}
                    onCursorChange={(cursorLine, cursorColumn) => setTabs((current) => current.map((tab) => (tab.document.relativePath === activeTab.document.relativePath ? { ...tab, cursorLine, cursorColumn } : tab)))}
                    onSave={() => void saveTab(activeTab.document.relativePath)}
                    onSaveAll={() => void saveAll()}
                  />
                </Suspense>
              )}
              <footer className="project-source-statusbar">
                {activeTab.document.imagePreviewUrl ? (
                  <span>{zh ? '图片 · 只读' : 'Image · Read-only'}</span>
                ) : (
                  <>
                    <span>{activeTab.document.language}</span>
                    <span>UTF-8{activeTab.document.hasBom ? ' BOM' : ''}</span>
                    <span>{activeTab.document.eol.toUpperCase()}</span>
                    <span>
                      Ln {activeTab.cursorLine}, Col {activeTab.cursorColumn}
                    </span>
                  </>
                )}
                {activeTab.externalChange ? <strong>{zh ? '磁盘内容已变化' : 'Disk content changed'}</strong> : null}
              </footer>
            </>
          ) : (
            <section className="project-source-editor-empty">
              <FolderOpen aria-hidden="true" />
              <strong>{zh ? '从左侧目录打开一个文件' : 'Open a file from the source tree'}</strong>
              <span>{zh ? '打开文件后，可以在这里查看和编辑代码。' : 'Open a file to view and edit its code here.'}</span>
            </section>
          )}
        </main>
      </div>

      {treeBackdrop.present ? (
        <button
          ref={treeBackdrop.ref}
          data-motion-state={treeDrawerOpen ? 'open' : 'closing'}
          inert={!treeDrawerOpen}
          aria-hidden={!treeDrawerOpen}
          type="button"
          className="project-source-tree-backdrop"
          data-zeus-primitive="backdrop"
          aria-label={zh ? '关闭代码目录' : 'Close source tree'}
          onClick={() => setTreeDrawerOpen(false)}
        />
      ) : null}

      {createPortal(
        <div className="macos-ai-app project-source-menu-layer" style={{ display: 'contents' }}>
          <MotionPresence>
            {contextMenu ? (
              <MenuSurface onClose={() => setContextMenu(null)} className="project-source-context-menu" role="menu" style={{ left: contextMenu.x, top: contextMenu.y }} onPointerDown={(event) => event.stopPropagation()}>
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
                <button
                  role="menuitem"
                  type="button"
                  onClick={() => {
                    void bridge?.revealProjectSourceEntry({ projectId: props.project.id, relativePath: contextMenu.entry.relativePath });
                    setContextMenu(null);
                  }}
                >
                  {zh ? '在 Finder 中显示' : 'Reveal in Finder'}
                </button>
                <button role="menuitem" type="button" className="danger" onClick={() => beginOperation({ kind: 'delete', entry: contextMenu.entry })}>
                  {zh ? '移入废纸篓…' : 'Move to Trash…'}
                </button>
              </MenuSurface>
            ) : null}
          </MotionPresence>
        </div>,
        document.body,
      )}

      <MotionPresence>
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
      </MotionPresence>

      <MotionPresence>
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
      </MotionPresence>
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
        {directoryEntry ? (
          <Collapsible open={expanded}>
            <TreeRows {...props} directoryPath={entry.relativePath} depth={props.depth + 1} />
          </Collapsible>
        ) : null}
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
    ? { binary: '检测到二进制内容。', invalid_encoding: '文件不是有效的 UTF-8 文本。', too_large: '文件超过页内读取上限，请在外部应用中打开。', symlink: '符号链接文件在 Zeus 中保持只读。', not_regular_file: '目标不是普通文件。' }
    : {
        binary: 'Binary content was detected.',
        invalid_encoding: 'The file is not valid UTF-8 text.',
        too_large: 'The file exceeds the inline viewing limit. Open it externally.',
        symlink: 'Symlink files remain read-only in Zeus.',
        not_regular_file: 'The target is not a regular file.',
      };
  return document.readOnlyReason ? reasons[document.readOnlyReason] : zh ? '文件不可编辑。' : 'The file is not editable.';
}
