import { useEffect, useMemo, useRef, useState } from 'react';
import { CircleNotchIcon as CircleNotch } from '@phosphor-icons/react/dist/csr/CircleNotch';
import { FolderIcon as Folder } from '@phosphor-icons/react/dist/csr/Folder';
import { GitBranchIcon as GitBranch } from '@phosphor-icons/react/dist/csr/GitBranch';
import type { ProjectGitAction, ProjectGitActionResponse, ProjectGitWorkbenchSnapshot, ProjectRecord } from '../apiClient.js';
import type { SessionUiLanguage } from './ThreadItemView.js';
import { useApplicationErrorDialog } from '../ui/ApplicationErrorDialog.js';
import { ZeusSelect } from '../ZeusSelect.js';
import { Button } from '../ui/Button.js';
import { ModalPortal } from '../ui/ModalPortal.js';

const createBranchActionValue = '__zeus create branch__';

export interface NewConversationExecutionContextProps {
  language: SessionUiLanguage;
  projectId: string;
  projects: readonly Pick<ProjectRecord, 'id' | 'name' | 'localPath'>[];
  disabled?: boolean;
  onSelectProject?: (projectId: string) => void;
  onLoadProjectGit?: (projectId: string) => Promise<ProjectGitWorkbenchSnapshot>;
  onExecuteProjectGit?: (projectId: string, repositoryId: string, action: ProjectGitAction) => Promise<ProjectGitActionResponse>;
  onBusyChange?: (busy: boolean) => void;
}

export function NewConversationExecutionContext(props: NewConversationExecutionContextProps) {
  const zh = props.language === 'zh-CN';
  const branchTriggerRef = useRef<HTMLButtonElement | null>(null);
  const loadVersionRef = useRef(0);
  const [workbench, setWorkbench] = useState<ProjectGitWorkbenchSnapshot | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  useApplicationErrorDialog(error, {
    language: zh ? 'zh-CN' : 'en',
    title: zh ? '新会话执行环境操作失败' : 'New conversation context failed',
    source: 'NewConversationExecutionContext',
  });
  const [branchBusy, setBranchBusy] = useState(false);
  const [createBranchOpen, setCreateBranchOpen] = useState(false);
  const [createBranchName, setCreateBranchName] = useState('');

  const selectedProject = props.projects.find((project) => project.id === props.projectId) ?? null;
  const rootRepository = useMemo(() => workbench?.repositories.find((repository) => repository.relativePath === '.' || repository.relativePath === '') ?? null, [workbench]);
  const branchLabel = rootRepository?.snapshot.branch || (loadState === 'loading' ? (zh ? '正在读取' : 'Loading') : zh ? '非 Git 目录' : 'Not a Git repository');
  const checkedOutBranches = useMemo(() => new Set(rootRepository?.snapshot.checkedOutBranches ?? []), [rootRepository?.snapshot.checkedOutBranches]);
  const projectOptions = useMemo(
    () =>
      props.projects.map((project) => ({
        value: project.id,
        label: `${project.name} · ${project.localPath}`,
        group: zh ? '项目' : 'Projects',
        searchText: `${project.name} ${project.localPath}`,
      })),
    [props.projects, zh],
  );
  const branchOptions = useMemo(() => {
    if (!rootRepository) return [];
    const unavailableReason = zh ? '已在其他工作区检出' : 'Checked out in another worktree';
    return [
      ...rootRepository.snapshot.localBranches.map((branch) => {
        const current = branch === rootRepository.snapshot.branch;
        const occupied = !current && checkedOutBranches.has(branch);
        return {
          value: branch,
          label: occupied ? `${branch} · ${unavailableReason}` : branch,
          group: zh ? '分支' : 'Branches',
          searchText: `${branch} ${occupied ? unavailableReason : ''}`,
          disabled: occupied,
        };
      }),
      {
        value: createBranchActionValue,
        label: zh ? '创建并检出新分支…' : 'Create and check out a new branch…',
        group: zh ? '操作' : 'Actions',
        searchText: zh ? '新建 创建 检出 分支' : 'new create checkout branch',
        disabled: false,
      },
    ];
  }, [checkedOutBranches, rootRepository, zh]);

  useEffect(() => {
    const version = ++loadVersionRef.current;
    setWorkbench(null);
    setLoadState('loading');
    setError(null);
    setCreateBranchOpen(false);
    setCreateBranchName('');
    if (!props.onLoadProjectGit) {
      setLoadState('error');
      setError(zh ? '当前无法读取项目分支。' : 'Project branches are unavailable.');
      return;
    }
    void props
      .onLoadProjectGit(props.projectId)
      .then((snapshot) => {
        if (version !== loadVersionRef.current) return;
        setWorkbench(snapshot);
        setLoadState('ready');
      })
      .catch((reason: unknown) => {
        if (version !== loadVersionRef.current) return;
        setLoadState('error');
        setError(formatGitContextError(reason, props.language));
      });
    return () => {
      loadVersionRef.current += 1;
    };
  }, [props.language, props.onLoadProjectGit, props.projectId, zh]);

  useEffect(() => {
    props.onBusyChange?.(branchBusy);
    return () => props.onBusyChange?.(false);
  }, [branchBusy, props.onBusyChange]);

  function closeCreateBranchDialog(): void {
    setCreateBranchOpen(false);
    setCreateBranchName('');
    window.requestAnimationFrame(() => branchTriggerRef.current?.focus());
  }

  async function executeBranchAction(action: ProjectGitAction): Promise<boolean> {
    if (!rootRepository || !props.onExecuteProjectGit || branchBusy) return false;
    setBranchBusy(true);
    setError(null);
    try {
      const response = await props.onExecuteProjectGit(props.projectId, rootRepository.id, action);
      setWorkbench((current) => replaceRepositorySnapshot(current, rootRepository.id, response));
      return true;
    } catch (reason) {
      setError(formatGitContextError(reason, props.language));
      return false;
    } finally {
      setBranchBusy(false);
    }
  }

  return (
    <>
      <div className="session-new-conversation-context" aria-label={zh ? '新会话执行上下文' : 'New conversation execution context'}>
        <span className="session-new-conversation-context-control">
          <ZeusSelect
            ariaLabel={zh ? `项目：${selectedProject?.name ?? '不可用'}` : `Project: ${selectedProject?.name ?? 'Unavailable'}`}
            className="session-new-conversation-context-select"
            emptyLabel={zh ? '没有匹配的项目' : 'No matching projects'}
            onChange={(projectId) => {
              if (projectId !== props.projectId) props.onSelectProject?.(projectId);
            }}
            options={projectOptions}
            popoverMinWidth={320}
            searchable
            searchPlaceholder={zh ? '搜索项目' : 'Search projects'}
            size="compact"
            triggerIcon={<Folder />}
            triggerLabel={selectedProject?.name ?? (zh ? '项目不可用' : 'Project unavailable')}
            value={props.projectId}
            disabled={props.disabled || branchBusy || props.projects.length === 0 || !props.onSelectProject}
          />
        </span>

        <span className="session-new-conversation-context-control">
          <ZeusSelect
            ariaLabel={zh ? `分支：${branchLabel}` : `Branch: ${branchLabel}`}
            className="session-new-conversation-context-select"
            emptyLabel={zh ? '没有匹配的本地分支' : 'No matching local branches'}
            onChange={(value) => {
              if (value === createBranchActionValue) {
                setCreateBranchOpen(true);
                return;
              }
              if (value !== rootRepository?.snapshot.branch) void executeBranchAction({ type: 'checkout', branchName: value });
            }}
            options={branchOptions}
            popoverMinWidth={340}
            searchable
            searchPlaceholder={zh ? `搜索 ${selectedProject?.name ?? ''} 分支` : `Search ${selectedProject?.name ?? ''} branches`}
            size="compact"
            triggerIcon={loadState === 'loading' ? <CircleNotch className="session-new-conversation-context-spinner" /> : <GitBranch />}
            triggerLabel={branchLabel}
            triggerRef={branchTriggerRef}
            value={rootRepository?.snapshot.branch ?? branchLabel}
            disabled={props.disabled || branchBusy || loadState !== 'ready' || !rootRepository || !props.onExecuteProjectGit}
          />
        </span>
      </div>

      {createBranchOpen && rootRepository ? (
        <ModalPortal rootClassName="project-git-modal-root" backdropClassName="project-git-modal-backdrop" dismissDisabled={branchBusy} onDismiss={closeCreateBranchDialog}>
          <form
            className="project-git-reference-dialog zeus-solid-form-surface"
            role="dialog"
            aria-modal="true"
            aria-label={zh ? '新建分支' : 'New branch'}
            onSubmit={(event) => {
              event.preventDefault();
              const branchName = createBranchName.trim();
              if (!branchName) return;
              void executeBranchAction({ type: 'create_branch', branchName, baseRef: rootRepository.snapshot.branch === 'detached' ? undefined : rootRepository.snapshot.branch }).then((created) => {
                if (created) closeCreateBranchDialog();
              });
            }}
          >
            <header>
              <strong>{zh ? '新建并检出分支' : 'Create and Checkout Branch'}</strong>
              <small>{zh ? `起点：${rootRepository.snapshot.branch}` : `Starting point: ${rootRepository.snapshot.branch}`}</small>
            </header>
            <main>
              <label>
                <span>{zh ? '分支名称' : 'Branch name'}</span>
                <input autoFocus value={createBranchName} disabled={branchBusy} placeholder="feature/example" onChange={(event) => setCreateBranchName(event.currentTarget.value)} />
              </label>
            </main>
            <footer>
              <Button variant="secondary" onClick={closeCreateBranchDialog} disabled={branchBusy}>
                {zh ? '取消' : 'Cancel'}
              </Button>
              <Button type="submit" variant="primary" busy={branchBusy} disabled={!createBranchName.trim()}>
                {zh ? '创建并检出' : 'Create and Checkout'}
              </Button>
            </footer>
          </form>
        </ModalPortal>
      ) : null}
    </>
  );
}

function replaceRepositorySnapshot(current: ProjectGitWorkbenchSnapshot | null, repositoryId: string, response: ProjectGitActionResponse): ProjectGitWorkbenchSnapshot | null {
  if (!current) return current;
  return {
    ...current,
    refreshedAt: new Date().toISOString(),
    repositories: current.repositories.map((repository) => (repository.id === repositoryId ? { ...repository, snapshot: response.snapshot } : repository)),
  };
}

function formatGitContextError(reason: unknown, language: SessionUiLanguage): string {
  const zh = language === 'zh-CN';
  const message = reason instanceof Error ? reason.message : String(reason);
  if (/already checked out|registered worktree/u.test(message)) return zh ? '该分支已在其他工作区检出。' : 'This branch is checked out in another worktree.';
  if (/would be overwritten|local changes/u.test(message)) return zh ? '当前未提交修改会被分支切换覆盖，请先处理这些修改。' : 'Current local changes would be overwritten. Resolve them before switching branches.';
  if (/not a git repository|repository required/u.test(message.toLocaleLowerCase())) return zh ? '当前项目根目录不是 Git 仓库。' : 'The current project root is not a Git repository.';
  return zh ? `无法更新分支：${message}` : `Unable to update branch: ${message}`;
}
