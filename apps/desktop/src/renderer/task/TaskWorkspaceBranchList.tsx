import { useMemo } from 'react';
import type { TaskWorkspaceIndexSnapshot } from '../session/sessionTypes.js';

interface TaskWorkspaceBranchGroup<Workspace extends TaskWorkspaceIndexSnapshot> {
  branchName: string;
  workspaces: Workspace[];
}

export function TaskWorkspaceBranchList<Workspace extends TaskWorkspaceIndexSnapshot>(props: {
  workspaces: Workspace[];
  selectedWorkspaceId: string;
  zh: boolean;
  disabled?: boolean;
  stateLabel: (workspace: Workspace, zh: boolean) => string;
  onSelect: (workspaceId: string) => void;
}) {
  const groups = useMemo(() => groupTaskWorkspacesByCurrentBranch(props.workspaces), [props.workspaces]);

  return (
    <aside className="task-git-review-workspaces" aria-label={props.zh ? '任务分支' : 'Task branches'}>
      <strong>
        {props.zh ? '任务分支' : 'Task branches'} <small>{groups.length}</small>
      </strong>
      {groups.map((group) => {
        const selected = group.workspaces.some((workspace) => workspace.id === props.selectedWorkspaceId);
        return (
          <section
            key={group.branchName}
            className={`task-git-workspace-branch-group${selected ? ' is-active' : ''}`}
            aria-label={props.zh ? `${group.branchName}，${group.workspaces.length} 个仓库` : `${group.branchName}, ${group.workspaces.length} ${group.workspaces.length === 1 ? 'repository' : 'repositories'}`}
          >
            <header>
              <strong title={group.branchName}>{group.branchName}</strong>
              <small>{props.zh ? `${group.workspaces.length} 个仓库` : `${group.workspaces.length} ${group.workspaces.length === 1 ? 'repository' : 'repositories'}`}</small>
            </header>
            <div>
              {group.workspaces.map((workspace) => {
                const repositoryLabel = workspace.repositoryName || workspace.repositoryRelativePath || (props.zh ? '项目仓库' : 'Project repository');
                const showRelativePath = Boolean(workspace.repositoryRelativePath && workspace.repositoryRelativePath !== repositoryLabel);
                const active = workspace.id === props.selectedWorkspaceId;
                return (
                  <button type="button" key={workspace.id} className={active ? 'is-active' : ''} aria-pressed={active} onClick={() => props.onSelect(workspace.id)} disabled={props.disabled}>
                    <span>{repositoryLabel}</span>
                    {showRelativePath ? <small>{workspace.repositoryRelativePath}</small> : null}
                    <small>{props.stateLabel(workspace, props.zh)}</small>
                  </button>
                );
              })}
            </div>
          </section>
        );
      })}
    </aside>
  );
}

function groupTaskWorkspacesByCurrentBranch<Workspace extends TaskWorkspaceIndexSnapshot>(workspaces: Workspace[]): TaskWorkspaceBranchGroup<Workspace>[] {
  const groups = new Map<string, Workspace[]>();
  for (const workspace of workspaces) {
    const branchName = workspace.branchName;
    const existing = groups.get(branchName);
    if (existing) existing.push(workspace);
    else groups.set(branchName, [workspace]);
  }
  return [...groups].map(([branchName, groupedWorkspaces]) => ({ branchName, workspaces: groupedWorkspaces }));
}
