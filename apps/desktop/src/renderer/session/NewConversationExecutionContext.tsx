import { temporaryWorkspaceId, type ConversationWorktreeOptions } from '@zeus/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { FolderIcon as Folder } from '@phosphor-icons/react/dist/csr/Folder';
import { GitBranchIcon as GitBranch } from '@phosphor-icons/react/dist/csr/GitBranch';
import type { ProjectGitAction, ProjectGitActionResponse, ProjectGitWorkbenchSnapshot, ProjectRecord } from '../apiClient.js';
import type { SessionUiLanguage } from './ThreadItemView.js';
import { useApplicationErrorDialog } from '../ui/ApplicationErrorDialog.js';
import { ZeusSelect } from '../ZeusSelect.js';
import { Button } from '../ui/Button.js';

export interface NewConversationExecutionContextProps {
  language: SessionUiLanguage;
  projectId: string;
  projects: readonly Pick<ProjectRecord, 'id' | 'name' | 'localPath'>[];
  workspaceMode: 'direct' | 'worktree';
  worktree?: ConversationWorktreeOptions;
  onWorktreeChange: (options: ConversationWorktreeOptions) => void;
  onWorkspaceModeChange: (mode: 'direct' | 'worktree') => void;
  disabled?: boolean;
  onSelectProject?: (projectId: string) => void | Promise<void>;
  onLoadProjectGit?: (projectId: string) => Promise<ProjectGitWorkbenchSnapshot>;
  onExecuteProjectGit?: (projectId: string, repositoryId: string, action: ProjectGitAction) => Promise<ProjectGitActionResponse>;
  onBusyChange?: (busy: boolean) => void;
}

export function NewConversationExecutionContext(props: NewConversationExecutionContextProps) {
  const zh = props.language === 'zh-CN';
  const loadVersionRef = useRef(0);
  const [workbench, setWorkbench] = useState<ProjectGitWorkbenchSnapshot | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<unknown>(null);
  useApplicationErrorDialog(error, { language: zh ? 'zh-CN' : 'en' });
  const [refreshing, setRefreshing] = useState(false);
  const [projectBusy, setProjectBusy] = useState(false);

  const temporary = props.projectId === temporaryWorkspaceId;
  const selectedProject = props.projects.find((project) => project.id === props.projectId) ?? null;
  // 只消费当前项目的快照，切换项目的一帧内也不能沿用旧来源。
  const rootRepository = useMemo(
    () => (workbench?.projectId === props.projectId ? (workbench.repositories.find((repository) => repository.relativePath === '.' || repository.relativePath === '') ?? null) : null),
    [workbench, props.projectId],
  );
  const snapshot = rootRepository?.snapshot;
  const sources = useMemo(
    () => [
      ...(snapshot?.localBranches ?? []).map((ref) => ({ ref, kind: 'local' as const })),
      ...(snapshot?.remoteBranches ?? []).filter((ref) => ref.includes('/') && !ref.endsWith('/HEAD')).map((ref) => ({ ref, kind: 'remote' as const })),
    ],
    [snapshot],
  );
  const worktreeAvailable = loadState === 'ready' && sources.length > 0;
  const sourceAvailable = Boolean(props.worktree && sources.some((source) => source.kind === props.worktree?.sourceKind && source.ref === props.worktree.sourceRef));
  const branchName = props.worktree?.branchName.trim() ?? '';
  const validWorktree = worktreeAvailable && sourceAvailable && branchName.startsWith('zeus/') && branchName.length > 'zeus/'.length;
  const branchLabel = snapshot?.detached ? (zh ? '游离 HEAD' : 'Detached HEAD') : snapshot?.branch || (loadState === 'loading' ? (zh ? '正在读取' : 'Loading') : zh ? '非 Git 目录' : 'Not a Git repository');
  const projectOptions = useMemo(
    () => [
      { value: temporaryWorkspaceId, label: zh ? '临时会话 · 默认目录' : 'Temporary conversation · Default folder', group: zh ? '无项目' : 'Without a project', searchText: '临时 默认 temporary default' },
      ...props.projects
        .filter((project) => project.id !== temporaryWorkspaceId)
        .map((project) => ({
          value: project.id,
          label: `${project.name} · ${project.localPath}`,
          group: zh ? '项目' : 'Projects',
          searchText: `${project.name} ${project.localPath}`,
        })),
    ],
    [props.projects, zh],
  );

  useEffect(() => {
    const version = ++loadVersionRef.current;
    setWorkbench(null);
    setLoadState('loading');
    setError(null);
    setRefreshing(false);
    if (temporary) {
      setLoadState('ready');
      return;
    }
    if (!props.onLoadProjectGit) {
      setLoadState('error');
      setError(zh ? '当前无法读取项目分支。' : 'Project branches are unavailable.');
      return;
    }
    void props
      .onLoadProjectGit(props.projectId)
      .then((value) => {
        if (version !== loadVersionRef.current) return;
        setWorkbench(value);
        setLoadState('ready');
      })
      .catch((reason: unknown) => {
        if (version !== loadVersionRef.current) return;
        setLoadState('error');
        setError(reason);
      });
    return () => {
      loadVersionRef.current += 1;
    };
  }, [props.onLoadProjectGit, props.projectId, temporary, zh]);

  useEffect(() => {
    if (temporary || props.workspaceMode !== 'worktree' || props.worktree || !worktreeAvailable) return;
    const source = sources.find((entry) => entry.kind === 'local' && entry.ref === snapshot?.branch) ?? sources[0];
    if (source) props.onWorktreeChange({ sourceKind: source.kind, sourceRef: source.ref, branchName: `zeus/conversation-${crypto.randomUUID().slice(0, 8)}` });
  }, [temporary, props.workspaceMode, props.worktree, props.onWorktreeChange, worktreeAvailable, sources, snapshot?.branch]);

  useEffect(() => {
    props.onBusyChange?.(projectBusy || refreshing || (!temporary && props.workspaceMode === 'worktree' && !validWorktree));
    return () => props.onBusyChange?.(false);
  }, [projectBusy, refreshing, temporary, props.workspaceMode, validWorktree, props.onBusyChange]);

  async function refreshRemoteBranches(): Promise<void> {
    if (!rootRepository || !props.onExecuteProjectGit || refreshing) return;
    const version = loadVersionRef.current;
    setRefreshing(true);
    setError(null);
    try {
      const response = await props.onExecuteProjectGit(props.projectId, rootRepository.id, { type: 'fetch' });
      if (version !== loadVersionRef.current) return;
      setWorkbench((current) => (current ? { ...current, repositories: current.repositories.map((repository) => (repository.id === rootRepository.id ? { ...repository, snapshot: response.snapshot } : repository)) } : null));
    } catch (reason) {
      if (version === loadVersionRef.current) setError(reason);
    } finally {
      if (version === loadVersionRef.current) setRefreshing(false);
    }
  }

  return (
    <>
      <div className="session-new-conversation-context" aria-label={zh ? '新对话的工作位置' : 'Work location for the new conversation'}>
        <span className="session-new-conversation-context-control">
          <ZeusSelect
            ariaLabel={zh ? `工作目录：${selectedProject?.name ?? '不可用'}` : `Project: ${selectedProject?.name ?? 'Unavailable'}`}
            className="session-new-conversation-context-select"
            emptyLabel={zh ? '没有匹配的项目' : 'No matching projects'}
            onChange={async (projectId) => {
              if (projectId === props.projectId || !props.onSelectProject || projectBusy) return;
              setProjectBusy(true);
              try {
                await props.onSelectProject(projectId);
              } catch (reason) {
                setError(reason);
              } finally {
                setProjectBusy(false);
              }
            }}
            options={projectOptions}
            popoverMinWidth={320}
            searchable
            searchPlaceholder={zh ? '搜索项目' : 'Search projects'}
            size="compact"
            triggerIcon={<Folder />}
            triggerLabel={temporary ? (zh ? '临时会话 · 默认目录' : 'Temporary · Default folder') : (selectedProject?.name ?? (zh ? '项目不可用' : 'Project unavailable'))}
            value={props.projectId}
            disabled={props.disabled || refreshing || projectBusy || props.projects.length === 0 || !props.onSelectProject}
          />
        </span>
        {!temporary ? (
          <span className="session-new-conversation-context-control">
            <ZeusSelect
              ariaLabel={zh ? '工作位置' : 'Work location'}
              className="session-new-conversation-context-select"
              value={props.workspaceMode}
              onChange={(value) => props.onWorkspaceModeChange(value === 'worktree' ? 'worktree' : 'direct')}
              options={[
                { value: 'direct', label: zh ? '项目目录' : 'Project folder' },
                { value: 'worktree', label: zh ? '新建工作树' : 'New worktree', disabled: !worktreeAvailable },
              ]}
              triggerIcon={props.workspaceMode === 'worktree' ? <GitBranch /> : <Folder />}
              triggerLabel={props.workspaceMode === 'worktree' ? (zh ? '新建工作树' : 'New worktree') : zh ? '项目目录' : 'Project folder'}
              size="compact"
              popoverMinWidth={220}
              disabled={props.disabled || refreshing || projectBusy}
            />
          </span>
        ) : null}
        {temporary ? (
          <span title={selectedProject?.localPath}>{zh ? '文件保存在默认目录' : 'Files saved in the default folder'}</span>
        ) : props.workspaceMode === 'direct' ? (
          <span className="session-new-conversation-current-branch" aria-label={zh ? `当前分支：${branchLabel}` : `Current branch: ${branchLabel}`} title={branchLabel}>
            <GitBranch aria-hidden="true" />
            <span>{branchLabel}</span>
          </span>
        ) : (
          <span className="session-new-conversation-context-control">
            <ZeusSelect
              ariaLabel={zh ? '来源分支' : 'Source branch'}
              className="session-new-conversation-context-select"
              popoverClassName="session-worktree-branch-popover"
              size="compact"
              popoverMinWidth={420}
              popoverArrowAlignment="start"
              triggerIcon={<GitBranch />}
              triggerLabel={props.worktree?.sourceRef || (zh ? '选择来源分支' : 'Choose source branch')}
              triggerTitle={[zh ? '工作树来源分支' : 'Worktree source branch', props.worktree?.sourceRef, props.worktree?.branchName].filter(Boolean).join(' · ')}
              value={props.worktree ? `${props.worktree.sourceKind}:${props.worktree.sourceRef}` : ''}
              options={sources.map((source) => ({
                value: `${source.kind}:${source.ref}`,
                label: source.ref,
                group: source.kind === 'local' ? (zh ? '本地分支' : 'Local branches') : zh ? '远程分支' : 'Remote branches',
              }))}
              onChange={(value) => {
                const source = sources.find((entry) => `${entry.kind}:${entry.ref}` === value);
                if (source && props.worktree) props.onWorktreeChange({ ...props.worktree, sourceKind: source.kind, sourceRef: source.ref });
              }}
              searchable
              searchPlaceholder={zh ? `搜索 ${selectedProject?.name ?? ''} 分支` : `Search ${selectedProject?.name ?? ''} branches`}
              emptyLabel={zh ? '没有匹配的分支' : 'No matching branches'}
              disabled={props.disabled || projectBusy || !props.worktree}
              footer={
                <span className="session-new-worktree-fields">
                  <label>
                    <span>{zh ? '工作树分支名' : 'Worktree branch name'}</span>
                    <input
                      aria-label={zh ? '工作树分支名' : 'Worktree branch name'}
                      value={props.worktree?.branchName ?? ''}
                      placeholder="zeus/conversation-example"
                      spellCheck={false}
                      disabled={props.disabled || projectBusy || !props.worktree}
                      onChange={(event) => {
                        if (props.worktree) props.onWorktreeChange({ ...props.worktree, branchName: event.currentTarget.value });
                      }}
                    />
                  </label>
                  <small>{zh ? '从所选分支创建，分支名须以 zeus/ 开头。' : 'Create from the selected branch. The new name must start with zeus/.'}</small>
                  {props.worktree && !sourceAvailable && loadState === 'ready' ? <span role="alert">{zh ? '来源分支已不可用，请重新选择。' : 'The source branch is no longer available. Choose another branch.'}</span> : null}
                  <Button variant="secondary" size="compact" busy={refreshing} disabled={props.disabled || projectBusy || !snapshot?.remotes.length || !props.onExecuteProjectGit} onClick={() => void refreshRemoteBranches()}>
                    {zh ? '刷新远程分支' : 'Refresh remote branches'}
                  </Button>
                </span>
              }
            />
          </span>
        )}
      </div>
    </>
  );
}
