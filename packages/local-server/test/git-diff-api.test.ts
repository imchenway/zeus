import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startZeusLocalServer } from '../src/index.js';
import { GitSnapshotRepository, createZeusDatabase } from '@zeus/storage';

describe('Zeus Git diff API', () => {
  it('creates a project-scoped readonly git snapshot for a real task', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-project-git-snapshot-'));
    const dbPath = join(dir, 'zeus.db');
    const projectPath = join(dir, 'project-snapshot');
    await mkdir(projectPath, { recursive: true });
    const observedDiffCwds: string[] = [];
    try {
      const running = await startZeusLocalServer({
        dbPath,
        apiToken: 'git-token',
        projectRoot: '/Users/david/hypha/zeus',
        gitDiffReader: async (cwd) => {
          observedDiffCwds.push(cwd);
          return {
            isRepository: true,
            files: ['src/snapshot.ts'],
            diffText: 'diff --git a/src/snapshot.ts b/src/snapshot.ts',
            fileDiffs: [
              {
                oldPath: 'src/snapshot.ts',
                newPath: 'src/snapshot.ts',
                changeType: 'modified',
                addedLines: 3,
                deletedLines: 1,
                hunks: [],
              },
            ],
          };
        },
      });
      const projectResponse = await fetch(`${running.baseUrl}/api/projects`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer git-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'Snapshot Project',
          localPath: projectPath,
        }),
      });
      const project = (await projectResponse.json()) as { id: string };
      const taskResponse = await fetch(`${running.baseUrl}/api/tasks`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer git-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          projectId: project.id,
          title: 'Snapshot task',
          description: '创建项目级 Git 快照',
        }),
      });
      const task = (await taskResponse.json()) as { id: string };

      const response = await fetch(`${running.baseUrl}/api/projects/${project.id}/git/snapshot`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer git-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ taskId: task.id }),
      });
      const body = await response.json();
      await running.close();

      const gitSnapshots = new GitSnapshotRepository(await createZeusDatabase(dbPath));
      const snapshots = gitSnapshots.listSnapshots(task.id);
      const changes = gitSnapshots.listChanges(task.id);

      expect(response.status).toBe(201);
      expect(body).toMatchObject({
        projectId: project.id,
        taskId: task.id,
        snapshotType: 'readonly_diff',
        fileCount: 1,
      });
      expect(observedDiffCwds).toEqual([projectPath]);
      expect(snapshots).toHaveLength(1);
      expect(
        changes.map((change) => ({
          filePath: change.filePath,
          changeType: change.changeType,
          additions: change.additions,
          deletions: change.deletions,
        })),
      ).toEqual([
        {
          filePath: 'src/snapshot.ts',
          changeType: 'modified',
          additions: 3,
          deletions: 1,
        },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns task-scoped readonly git diff and persists a task audit snapshot', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-task-scoped-git-diff-'));
    const dbPath = join(dir, 'zeus.db');
    const projectPath = join(dir, 'project-task');
    await mkdir(projectPath, { recursive: true });
    const observedDiffCwds: string[] = [];
    try {
      const running = await startZeusLocalServer({
        dbPath,
        apiToken: 'git-token',
        projectRoot: '/Users/david/hypha/zeus',
        gitDiffReader: async (cwd) => {
          observedDiffCwds.push(cwd);
          return {
            isRepository: true,
            files: ['src/task.ts'],
            diffText: 'diff --git a/src/task.ts b/src/task.ts',
            fileDiffs: [
              {
                oldPath: 'src/task.ts',
                newPath: 'src/task.ts',
                changeType: 'modified',
                addedLines: 2,
                deletedLines: 1,
                hunks: [],
              },
            ],
          };
        },
      });
      const projectResponse = await fetch(`${running.baseUrl}/api/projects`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer git-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'Task Diff Project',
          localPath: projectPath,
        }),
      });
      const project = (await projectResponse.json()) as { id: string };
      const taskResponse = await fetch(`${running.baseUrl}/api/tasks`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer git-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          projectId: project.id,
          title: 'Review task diff',
          description: '检查任务级 Git Diff 证据链',
        }),
      });
      const task = (await taskResponse.json()) as { id: string };

      const response = await fetch(`${running.baseUrl}/api/tasks/${task.id}/diff`, { headers: { authorization: 'Bearer git-token' } });
      const diff = await response.json();
      await running.close();

      const gitSnapshots = new GitSnapshotRepository(await createZeusDatabase(dbPath));
      const snapshots = gitSnapshots.listSnapshots(task.id);
      const changes = gitSnapshots.listChanges(task.id);

      expect(response.status).toBe(200);
      expect(diff.files).toEqual(['src/task.ts']);
      expect(observedDiffCwds).toEqual([projectPath]);
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]).toMatchObject({
        projectId: project.id,
        taskId: task.id,
        snapshotType: 'readonly_diff',
      });
      expect(
        changes.map((change) => ({
          filePath: change.filePath,
          changeType: change.changeType,
          additions: change.additions,
          deletions: change.deletions,
        })),
      ).toEqual([
        {
          filePath: 'src/task.ts',
          changeType: 'modified',
          additions: 2,
          deletions: 1,
        },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reads project-scoped git status and diff from the project local path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-project-scoped-git-'));
    const projectPath = join(dir, 'project-a');
    await mkdir(projectPath, { recursive: true });
    const observedStatusCwds: string[] = [];
    const observedDiffCwds: string[] = [];
    try {
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'git-token',
        projectRoot: '/Users/david/hypha/zeus',
        gitStatusReader: async (cwd) => {
          observedStatusCwds.push(cwd);
          return {
            isRepository: true,
            branch: 'feature/project-a',
            clean: false,
            changedFiles: ['README.md'],
            conflictFiles: [],
            fileStatuses: [],
            remoteBranches: [],
            recentCommits: [],
          };
        },
        gitDiffReader: async (cwd) => {
          observedDiffCwds.push(cwd);
          return {
            isRepository: true,
            files: ['README.md'],
            diffText: 'diff --git a/README.md b/README.md',
            fileDiffs: [
              {
                oldPath: 'README.md',
                newPath: 'README.md',
                changeType: 'modified',
                addedLines: 1,
                deletedLines: 0,
                hunks: [],
              },
            ],
          };
        },
      });
      const created = await fetch(`${running.baseUrl}/api/projects`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer git-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'Project A', localPath: projectPath }),
      });
      const project = (await created.json()) as { id: string };

      const statusResponse = await fetch(`${running.baseUrl}/api/projects/${project.id}/git/status`, { headers: { authorization: 'Bearer git-token' } });
      const diffResponse = await fetch(`${running.baseUrl}/api/projects/${project.id}/git/diff`, { headers: { authorization: 'Bearer git-token' } });
      const status = await statusResponse.json();
      const diff = await diffResponse.json();
      await running.close();

      expect(statusResponse.status).toBe(200);
      expect(diffResponse.status).toBe(200);
      expect(status.branch).toBe('feature/project-a');
      expect(diff.files).toEqual(['README.md']);
      expect(observedStatusCwds).toEqual([projectPath]);
      expect(observedDiffCwds).toEqual([projectPath]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns readonly git diff summary for the current repository', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-git-diff-'));
    try {
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'git-token',
        projectRoot: '/Users/david/hypha/zeus',
      });
      const response = await fetch(`${running.baseUrl}/api/git/diff`, {
        headers: { authorization: 'Bearer git-token' },
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.isRepository).toBe(true);
      expect(Array.isArray(body.files)).toBe(true);
      expect(typeof body.diffText).toBe('string');
      expect(Array.isArray(body.fileDiffs)).toBe(true);
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('persists readonly git diff snapshots and file changes for audit replay', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-git-diff-snapshot-'));
    const dbPath = join(dir, 'zeus.db');
    try {
      const running = await startZeusLocalServer({
        dbPath,
        apiToken: 'git-token',
        projectRoot: '/Users/david/hypha/zeus',
      });

      const response = await fetch(`${running.baseUrl}/api/git/diff?projectId=project-real&taskId=task-real`, { headers: { authorization: 'Bearer git-token' } });
      const body = await response.json();
      await running.close();

      const gitSnapshots = new GitSnapshotRepository(await createZeusDatabase(dbPath));
      const snapshots = gitSnapshots.listSnapshots('task-real');
      const changes = gitSnapshots.listChanges('task-real');

      expect(response.status).toBe(200);
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]).toMatchObject({
        taskId: 'task-real',
        projectId: 'project-real',
        snapshotType: 'readonly_diff',
      });
      expect(JSON.parse(snapshots[0].statusJson)).toMatchObject({
        isRepository: body.isRepository,
        fileCount: body.files.length,
      });
      expect(changes.map((change) => change.filePath)).toEqual([...body.files].sort());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('persists precise git change types from parsed file diffs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-git-diff-change-types-'));
    const dbPath = join(dir, 'zeus.db');
    try {
      const diffText = [
        'diff --git a/new.ts b/new.ts',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/new.ts',
        '@@ -0,0 +1 @@',
        '+new',
        'diff --git a/old.ts b/old.ts',
        'deleted file mode 100644',
        '--- a/old.ts',
        '+++ /dev/null',
        '@@ -1 +0,0 @@',
        '-old',
        'diff --git a/before.ts b/after.ts',
        'similarity index 90%',
        'rename from before.ts',
        'rename to after.ts',
        '--- a/before.ts',
        '+++ b/after.ts',
        '@@ -1 +1 @@',
        '-before',
        '+after',
      ].join('\n');
      const running = await startZeusLocalServer({
        dbPath,
        apiToken: 'git-token',
        projectRoot: '/Users/david/hypha/zeus',
        gitDiffReader: async () => ({
          isRepository: true,
          files: ['new.ts', 'old.ts', 'after.ts'],
          diffText,
          fileDiffs: [
            {
              oldPath: 'new.ts',
              newPath: 'new.ts',
              changeType: 'added',
              addedLines: 1,
              deletedLines: 0,
              hunks: [],
            },
            {
              oldPath: 'old.ts',
              newPath: 'old.ts',
              changeType: 'deleted',
              addedLines: 0,
              deletedLines: 1,
              hunks: [],
            },
            {
              oldPath: 'before.ts',
              newPath: 'after.ts',
              changeType: 'renamed',
              addedLines: 1,
              deletedLines: 1,
              hunks: [],
            },
          ],
        }),
      });

      const response = await fetch(`${running.baseUrl}/api/git/diff?projectId=project-real&taskId=task-real`, { headers: { authorization: 'Bearer git-token' } });
      await running.close();

      const gitSnapshots = new GitSnapshotRepository(await createZeusDatabase(dbPath));
      const changes = gitSnapshots.listChanges('task-real');
      expect(response.status).toBe(200);
      expect(
        changes.map((change) => ({
          filePath: change.filePath,
          changeType: change.changeType,
          additions: change.additions,
          deletions: change.deletions,
        })),
      ).toEqual([
        {
          filePath: 'after.ts',
          changeType: 'renamed',
          additions: 1,
          deletions: 1,
        },
        { filePath: 'new.ts', changeType: 'added', additions: 1, deletions: 0 },
        {
          filePath: 'old.ts',
          changeType: 'deleted',
          additions: 0,
          deletions: 1,
        },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('links readonly git changes to real graph nodes by source file path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-git-diff-linked-graph-'));
    const dbPath = join(dir, 'zeus.db');
    try {
      const filePath = 'packages/local-server/src/index.ts';
      const running = await startZeusLocalServer({
        dbPath,
        apiToken: 'git-token',
        projectRoot: '/Users/david/hypha/zeus',
        gitDiffReader: async () => ({
          isRepository: true,
          files: [filePath],
          diffText: `diff --git a/${filePath} b/${filePath}
--- a/${filePath}
+++ b/${filePath}
@@ -1 +1 @@
-old
+new
`,
          fileDiffs: [
            {
              oldPath: filePath,
              newPath: filePath,
              changeType: 'modified',
              addedLines: 1,
              deletedLines: 1,
              hunks: [],
            },
          ],
        }),
      });
      await fetch(`${running.baseUrl}/api/graph/scan-current`, {
        method: 'POST',
        headers: { authorization: 'Bearer git-token' },
      });

      const response = await fetch(`${running.baseUrl}/api/git/diff?projectId=project-real&taskId=task-real`, { headers: { authorization: 'Bearer git-token' } });
      await running.close();

      const gitSnapshots = new GitSnapshotRepository(await createZeusDatabase(dbPath));
      const changes = gitSnapshots.listChanges('task-real');
      expect(response.status).toBe(200);
      expect(changes).toHaveLength(1);
      const linkedGraphNodes = JSON.parse(changes[0].linkedGraphNodesJson) as string[];
      expect(linkedGraphNodes.length).toBeGreaterThan(0);
      expect(linkedGraphNodes.every((nodeId) => nodeId.startsWith('node_'))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('exports the current readonly diff as a patch payload', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-git-patch-api-'));
    try {
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'git-token',
        projectRoot: '/Users/david/hypha/zeus',
      });

      const response = await fetch(`${running.baseUrl}/api/git/patch`, {
        headers: { authorization: 'Bearer git-token' },
      });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.fileName).toMatch(/^zeus-diff-.*\.patch$/u);
      expect(body.mimeType).toBe('text/x-patch');
      expect(typeof body.patchText).toBe('string');
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('exports a project-scoped readonly diff as a patch payload from the project local path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-project-git-patch-api-'));
    const projectPath = join(dir, 'project-patch');
    await mkdir(projectPath, { recursive: true });
    const observedDiffCwds: string[] = [];
    try {
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'git-token',
        projectRoot: '/Users/david/hypha/zeus',
        gitDiffReader: async (cwd) => {
          observedDiffCwds.push(cwd);
          return {
            isRepository: true,
            files: ['src/project-patch.ts'],
            diffText: 'diff --git a/src/project-patch.ts b/src/project-patch.ts',
            fileDiffs: [
              {
                oldPath: 'src/project-patch.ts',
                newPath: 'src/project-patch.ts',
                changeType: 'modified',
                addedLines: 4,
                deletedLines: 2,
                hunks: [],
              },
            ],
          };
        },
      });
      const projectResponse = await fetch(`${running.baseUrl}/api/projects`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer git-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'Patch Project', localPath: projectPath }),
      });
      const project = (await projectResponse.json()) as { id: string };

      const response = await fetch(`${running.baseUrl}/api/projects/${project.id}/git/patch`, {
        method: 'POST',
        headers: { authorization: 'Bearer git-token' },
      });
      const body = await response.json();
      await running.close();

      expect(response.status).toBe(200);
      expect(body.fileName).toMatch(/^zeus-diff-.*\.patch$/u);
      expect(body.mimeType).toBe('text/x-patch');
      expect(body.files).toEqual(['src/project-patch.ts']);
      expect(body.patchText).toBe('diff --git a/src/project-patch.ts b/src/project-patch.ts');
      expect(observedDiffCwds).toEqual([projectPath]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
