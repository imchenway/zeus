import type { FilePreviewSourceWorkspace, ProjectSourceWorktree } from '@zeus/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { GitBranchIcon } from '@phosphor-icons/react/dist/csr/GitBranch';
import { ZeusSelect } from '../ZeusSelect.js';
import { VisibleApplicationError } from '../ui/ApplicationErrorDialog.js';

/** 项目源码切换目录时沿用主页面的未保存保护，选择器不直接重建编辑器。 */
export function ProjectSourceWorktreeSelect(props: {
  /** 所属业务项目，始终不是 file-source 临时身份。 */
  projectId: string;
  /** 未选择额外目录时使用项目目录；预览进入的工作区使用真实根目录匹配。 */
  currentRoot?: string;
  /** 选择器跟随应用语言。 */
  language: 'zh-CN' | 'en-US';
  /** 返回 Main 已确认的目录，调用方完成导航与草稿处理。 */
  onSelect(workspace: FilePreviewSourceWorkspace): void;
}) {
  /** 中英文分组和动作使用同一份工作树清单。 */
  const zh = props.language === 'zh-CN';
  /** 清单只来自 Main 的 Git 查询，不从目录树中猜测。 */
  const [worktrees, setWorktrees] = useState<ProjectSourceWorktree[]>([]);
  /** 初次读取与后台刷新分开，已有入口在刷新期间仍可返回项目目录。 */
  const [loading, setLoading] = useState(true);
  /** 选择期间锁定入口，返回后是否导航由未保存保护决定。 */
  const [selecting, setSelecting] = useState(false);
  /** 读取与选择错误保持在对应入口，不丢失当前源码。 */
  const [loadError, setLoadError] = useState<unknown>(null);
  /** 后台刷新不能抹掉本次选择失败的原因。 */
  const [selectionError, setSelectionError] = useState<unknown>(null);
  /** 选择失败优先显示，清单错误仍保留供下一次选择查看。 */
  const error = selectionError ?? loadError;
  /** 项目切换与卸载后不消费旧目录结果。 */
  const revision = useRef(0);
  /** 同一次点击与焦点进入只触发一次读取。 */
  const inFlight = useRef(false);
  /** 清单在打开或重新聚焦时读取，覆盖其他窗口新增、删除工作树。 */
  const reload = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    const version = revision.current;
    try {
      if (!window.zeus) throw new Error('源码工作目录服务不可用。');
      const choices = await window.zeus.listProjectSourceWorktrees(props.projectId);
      if (version !== revision.current) return;
      setWorktrees(choices);
      setLoadError(null);
    } catch (reason) {
      if (version === revision.current) setLoadError(reason);
    } finally {
      if (version === revision.current) {
        inFlight.current = false;
        setLoading(false);
      }
    }
  }, [props.projectId]);
  useEffect(() => {
    revision.current += 1;
    inFlight.current = false;
    setWorktrees([]);
    setLoading(true);
    setSelecting(false);
    setSelectionError(null);
    setLoadError(null);
    void reload();
    const refresh = () => {
      void reload();
    };
    window.addEventListener('focus', refresh);
    return () => {
      revision.current += 1;
      window.removeEventListener('focus', refresh);
    };
  }, [reload]);
  /** 预览可能打开环境容器，此时保留当前根目录显示，仍可切换到登记工作树。 */
  const current = props.currentRoot ? worktrees.find((entry) => entry.localPath === props.currentRoot) : worktrees.find((entry) => entry.kind === 'project');
  /** 普通项目与游离工作树都有明确名称，不把目录选择标成分支检出。 */
  const label = (entry: ProjectSourceWorktree): string => (entry.kind === 'project' ? (zh ? '项目目录' : 'Project folder') : entry.branch || `${zh ? '游离 HEAD' : 'Detached HEAD'} · ${entry.headSha.slice(0, 8)}`);
  return (
    <span
      className="project-source-worktree-control"
      onPointerDownCapture={(event) => {
        if (!selecting && event.target instanceof Element && event.target.closest('.zeus-select-trigger')) void reload();
      }}
      onFocusCapture={(event) => {
        if (!selecting && event.target instanceof Element && event.target.closest('.zeus-select-trigger')) void reload();
      }}
    >
      <ZeusSelect
        ariaLabel={zh ? '源码工作目录' : 'Source working directory'}
        className="project-source-worktree-select"
        value={current?.id ?? (props.currentRoot ? '' : 'project')}
        triggerLabel={current ? label(current) : props.currentRoot ? (zh ? '当前工作目录' : 'Current working directory') : loading ? (zh ? '正在读取工作树' : 'Loading worktrees') : zh ? '项目目录' : 'Project folder'}
        triggerTitle={current?.localPath ?? props.currentRoot}
        triggerIcon={<GitBranchIcon />}
        options={[
          { value: 'project', label: zh ? '项目目录' : 'Project folder', description: worktrees.find((entry) => entry.kind === 'project')?.localPath },
          ...worktrees
            .filter((entry) => entry.kind === 'worktree')
            .map((entry) => ({ value: entry.id, label: label(entry), group: entry.repositoryName, description: entry.localPath, searchText: `${entry.repositoryName} ${entry.branch ?? ''} ${entry.localPath}` })),
        ]}
        onChange={(worktreeId) => {
          if (selecting || current?.id === worktreeId) return;
          if (!window.zeus) {
            setSelectionError(new Error('源码工作目录服务不可用。'));
            return;
          }
          const version = revision.current;
          setSelecting(true);
          setSelectionError(null);
          void window.zeus
            .selectProjectSourceWorktree({ projectId: props.projectId, worktreeId })
            .then((workspace) => {
              if (version === revision.current) props.onSelect(workspace);
            })
            .catch((reason: unknown) => {
              if (version === revision.current) setSelectionError(reason);
            })
            .finally(() => {
              if (version === revision.current) setSelecting(false);
            });
        }}
        disabled={selecting || (loading && !worktrees.length)}
        searchable
        searchPlaceholder={zh ? '搜索工作树、分支或目录' : 'Search worktrees, branches or folders'}
        emptyLabel={zh ? '没有匹配的工作树' : 'No matching worktrees'}
        popoverMinWidth={360}
        size="compact"
      />
      {error ? (
        <span role="alert">
          <VisibleApplicationError error={error} language={zh ? 'zh-CN' : 'en'} />
        </span>
      ) : null}
    </span>
  );
}
