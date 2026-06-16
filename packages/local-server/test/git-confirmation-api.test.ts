import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLocalServer } from '../src/index';
import { AuditLogRepository, createZeusDatabase } from '@zeus/storage';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'zeus-git-confirm-api-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('git confirmation API', () => {
  it('rejects unsupported git confirmation operations before creating audit records', async () => {
    const dbPath = join(tempDir, 'zeus.db');
    const server = await createLocalServer({
      dbPath,
      apiToken: 'token',
      projectRoot: tempDir,
    });

    const response = await server.inject({
      method: 'POST',
      url: '/api/git/confirmations',
      headers: { authorization: 'Bearer token' },
      payload: { operation: 'merge', reason: '合并不应绕过本地确认契约' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: 'ZEUS_INVALID_GIT_CONFIRMATION_OPERATION',
    });
    await server.close();

    expect(new AuditLogRepository(await createZeusDatabase(dbPath)).listRecent()).toEqual([]);
  });

  it('creates a pending high-risk git confirmation without executing git writes', async () => {
    const dbPath = join(tempDir, 'zeus.db');
    const server = await createLocalServer({
      dbPath,
      apiToken: 'token',
      projectRoot: tempDir,
    });

    const response = await server.inject({
      method: 'POST',
      url: '/api/git/confirmations',
      headers: { authorization: 'Bearer token' },
      payload: { operation: 'stash', reason: '保存当前工作区，稍后恢复' },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      operation: 'stash',
      cwd: tempDir,
      reason: '保存当前工作区，稍后恢复',
      status: 'pending',
      riskLevel: 'high',
      confirmationText: '确认执行 Git stash',
    });
    expect(response.json().expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    await server.close();

    const auditLogs = new AuditLogRepository(await createZeusDatabase(dbPath)).listRecent();
    expect(auditLogs.map((entry) => entry.action)).toContain('git.confirmation.created');
    expect(JSON.stringify(auditLogs)).toContain('stash');
  });

  it('rejects blank git confirmation reasons and trims accepted reasons before audit', async () => {
    const dbPath = join(tempDir, 'zeus.db');
    const server = await createLocalServer({
      dbPath,
      apiToken: 'token',
      projectRoot: tempDir,
    });

    const blank = await server.inject({
      method: 'POST',
      url: '/api/git/confirmations',
      headers: { authorization: 'Bearer token' },
      payload: { operation: 'stash', reason: '   ' },
    });
    const accepted = await server.inject({
      method: 'POST',
      url: '/api/git/confirmations',
      headers: { authorization: 'Bearer token' },
      payload: { operation: 'stash', reason: '  保存真实工作区变更  ' },
    });

    expect(blank.statusCode).toBe(400);
    expect(blank.json()).toMatchObject({
      error: 'ZEUS_INVALID_GIT_CONFIRMATION',
    });
    expect(accepted.statusCode).toBe(201);
    expect(accepted.json()).toMatchObject({ reason: '保存真实工作区变更' });
    await server.close();

    const auditText = JSON.stringify(new AuditLogRepository(await createZeusDatabase(dbPath)).listRecent());
    expect(auditText).toContain('保存真实工作区变更');
    expect(auditText).not.toContain('  保存真实工作区变更  ');
  });

  it('confirms a pending high-risk git operation before execution', async () => {
    const dbPath = join(tempDir, 'zeus.db');
    const server = await createLocalServer({
      dbPath,
      apiToken: 'token',
      projectRoot: tempDir,
    });
    const created = await server.inject({
      method: 'POST',
      url: '/api/git/confirmations',
      headers: { authorization: 'Bearer token' },
      payload: {
        operation: 'commit',
        reason: '提交已审查变更',
        message: 'feat: reviewed change',
      },
    });
    const confirmationId = created.json().id;

    const confirmed = await server.inject({
      method: 'POST',
      url: `/api/git/confirmations/${confirmationId}/confirm`,
      headers: { authorization: 'Bearer token' },
    });

    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toMatchObject({
      id: confirmationId,
      operation: 'commit',
      status: 'confirmed',
      message: 'feat: reviewed change',
    });
    expect(confirmed.json().confirmedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    await server.close();

    expect(new AuditLogRepository(await createZeusDatabase(dbPath)).listRecent().map((entry) => entry.action)).toEqual(['security.confirmation.approved', 'git.confirmation.confirmed', 'git.confirmation.created']);
  });

  it('rejects a pending high-risk git confirmation without executing git writes', async () => {
    const dbPath = join(tempDir, 'zeus.db');
    const gitRuns: Array<{ cwd: string; args: string[] }> = [];
    const server = await createLocalServer({
      dbPath,
      apiToken: 'token',
      projectRoot: tempDir,
      gitCommandRunner: async (cwd, args) => {
        gitRuns.push({ cwd, args });
        return { stdout: 'should-not-run', stderr: '' };
      },
    });
    const created = await server.inject({
      method: 'POST',
      url: '/api/git/confirmations',
      headers: { authorization: 'Bearer token' },
      payload: { operation: 'stash', reason: '用户取消暂存当前工作区' },
    });
    const confirmationId = created.json().id;

    const rejected = await server.inject({
      method: 'POST',
      url: `/api/git/confirmations/${confirmationId}/reject`,
      headers: { authorization: 'Bearer token' },
      payload: { reason: '用户在二次确认弹窗中拒绝' },
    });
    const executed = await server.inject({
      method: 'POST',
      url: '/api/git/operations',
      headers: { authorization: 'Bearer token' },
      payload: { confirmationId, operation: 'stash', message: 'save work' },
    });

    expect(rejected.statusCode).toBe(200);
    expect(rejected.json()).toMatchObject({
      id: confirmationId,
      operation: 'stash',
      status: 'rejected',
      rejectedReason: '用户在二次确认弹窗中拒绝',
    });
    expect(rejected.json().rejectedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(executed.statusCode).toBe(409);
    expect(executed.json()).toMatchObject({
      error: 'ZEUS_GIT_CONFIRMATION_REJECTED',
    });
    expect(gitRuns).toEqual([]);
    await server.close();

    expect(new AuditLogRepository(await createZeusDatabase(dbPath)).listRecent().map((entry) => entry.action)).toEqual(['security.confirmation.rejected', 'git.confirmation.created']);
  });

  it('rejects repeated confirmation of the same high-risk git operation', async () => {
    const dbPath = join(tempDir, 'zeus.db');
    const server = await createLocalServer({
      dbPath,
      apiToken: 'token',
      projectRoot: tempDir,
    });
    const created = await server.inject({
      method: 'POST',
      url: '/api/git/confirmations',
      headers: { authorization: 'Bearer token' },
      payload: {
        operation: 'stash',
        reason: '只允许一次确认当前 Git 写操作意图',
      },
    });
    const confirmationId = created.json().id;

    const firstConfirm = await server.inject({
      method: 'POST',
      url: `/api/git/confirmations/${confirmationId}/confirm`,
      headers: { authorization: 'Bearer token' },
    });
    const secondConfirm = await server.inject({
      method: 'POST',
      url: `/api/git/confirmations/${confirmationId}/confirm`,
      headers: { authorization: 'Bearer token' },
    });

    expect(firstConfirm.statusCode).toBe(200);
    expect(secondConfirm.statusCode).toBe(409);
    expect(secondConfirm.json()).toMatchObject({
      error: 'ZEUS_GIT_CONFIRMATION_ALREADY_CONFIRMED',
    });
    await server.close();

    expect(new AuditLogRepository(await createZeusDatabase(dbPath)).listRecent().map((entry) => entry.action)).toEqual(['security.confirmation.approved', 'git.confirmation.confirmed', 'git.confirmation.created']);
  });

  it('rejects expired pending git confirmations before execution', async () => {
    const dbPath = join(tempDir, 'zeus.db');
    let currentTime = new Date('2026-06-14T00:00:00.000Z');
    const server = await createLocalServer({
      dbPath,
      apiToken: 'token',
      projectRoot: tempDir,
      now: () => currentTime,
    });
    const created = await server.inject({
      method: 'POST',
      url: '/api/git/confirmations',
      headers: { authorization: 'Bearer token' },
      payload: {
        operation: 'rollback',
        reason: '回滚必须在短时间窗口内二次确认',
      },
    });
    const confirmation = created.json();
    currentTime = new Date('2026-06-14T00:10:00.000Z');

    const expired = await server.inject({
      method: 'POST',
      url: `/api/git/confirmations/${confirmation.id}/confirm`,
      headers: { authorization: 'Bearer token' },
    });

    expect(created.statusCode).toBe(201);
    expect(confirmation).toMatchObject({
      operation: 'rollback',
      createdAt: '2026-06-14T00:00:00.000Z',
      expiresAt: '2026-06-14T00:10:00.000Z',
      status: 'pending',
    });
    expect(expired.statusCode).toBe(409);
    expect(expired.json()).toMatchObject({
      error: 'ZEUS_GIT_CONFIRMATION_EXPIRED',
    });
    await server.close();

    expect(new AuditLogRepository(await createZeusDatabase(dbPath)).listRecent().map((entry) => entry.action)).toEqual(['git.confirmation.created']);
  });

  it('redacts sensitive git confirmation reason and message in responses and audit logs', async () => {
    const dbPath = join(tempDir, 'zeus.db');
    const server = await createLocalServer({
      dbPath,
      apiToken: 'token',
      projectRoot: tempDir,
    });

    const response = await server.inject({
      method: 'POST',
      url: '/api/git/confirmations',
      headers: { authorization: 'Bearer token' },
      payload: {
        operation: 'commit',
        reason: '提交前说明 token=git-secret-real',
        message: 'feat: safe commit --api-key git-api-real',
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      reason: '提交前说明 token=[REDACTED]',
      message: 'feat: safe commit --api-key [REDACTED]',
    });
    await server.close();

    const auditText = JSON.stringify(new AuditLogRepository(await createZeusDatabase(dbPath)).listRecent());
    expect(auditText).toContain('[REDACTED]');
    expect(auditText).not.toContain('git-secret-real');
    expect(auditText).not.toContain('git-api-real');
  });

  it('executes a confirmed high-risk git operation through the controlled git runner and consumes it once', async () => {
    const dbPath = join(tempDir, 'zeus.db');
    const gitRuns: Array<{ cwd: string; args: string[] }> = [];
    const server = await createLocalServer({
      dbPath,
      apiToken: 'token',
      projectRoot: tempDir,
      gitCommandRunner: async (cwd, args) => {
        gitRuns.push({ cwd, args });
        return { stdout: 'pushed', stderr: '' };
      },
    });
    const created = await server.inject({
      method: 'POST',
      url: '/api/git/confirmations',
      headers: { authorization: 'Bearer token' },
      payload: { operation: 'switch_branch', reason: '切换到已存在的发布分支' },
    });
    const confirmationId = created.json().id;
    await server.inject({
      method: 'POST',
      url: `/api/git/confirmations/${confirmationId}/confirm`,
      headers: { authorization: 'Bearer token' },
    });

    const executed = await server.inject({
      method: 'POST',
      url: '/api/git/operations',
      headers: { authorization: 'Bearer token' },
      payload: {
        confirmationId,
        operation: 'switch_branch',
        branchName: 'release/0.1',
      },
    });
    const repeated = await server.inject({
      method: 'POST',
      url: '/api/git/operations',
      headers: { authorization: 'Bearer token' },
      payload: {
        confirmationId,
        operation: 'switch_branch',
        branchName: 'release/0.1',
      },
    });

    expect(executed.statusCode).toBe(200);
    expect(executed.json()).toMatchObject({
      operation: 'switch_branch',
      args: ['switch', 'release/0.1'],
      stdout: 'pushed',
    });
    expect(repeated.statusCode).toBe(409);
    expect(repeated.json()).toMatchObject({
      error: 'ZEUS_GIT_CONFIRMATION_ALREADY_CONSUMED',
    });
    expect(gitRuns).toEqual([{ cwd: tempDir, args: ['switch', 'release/0.1'] }]);
    await server.close();

    expect(new AuditLogRepository(await createZeusDatabase(dbPath)).listRecent().map((entry) => entry.action)).toEqual(['git.operation.executed', 'security.confirmation.approved', 'git.confirmation.confirmed', 'git.confirmation.created']);
  });

  it('executes project git pull and push only through confirmed high-risk operations', async () => {
    const dbPath = join(tempDir, 'zeus.db');
    const gitRuns: Array<{ cwd: string; args: string[] }> = [];
    const server = await createLocalServer({
      dbPath,
      apiToken: 'token',
      projectRoot: tempDir,
      gitCommandRunner: async (cwd, args) => {
        gitRuns.push({ cwd, args });
        return { stdout: args.join(' '), stderr: '' };
      },
    });
    const project = await server.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { authorization: 'Bearer token' },
      payload: { name: '远端 Git 项目', localPath: tempDir },
    });
    const projectId = project.json().id;

    async function confirm(operation: string): Promise<string> {
      const created = await server.inject({
        method: 'POST',
        url: '/api/git/confirmations',
        headers: { authorization: 'Bearer token' },
        payload: { operation, reason: `确认执行 ${operation}` },
      });
      const confirmationId = created.json().id;
      await server.inject({
        method: 'POST',
        url: `/api/git/confirmations/${confirmationId}/confirm`,
        headers: { authorization: 'Bearer token' },
      });
      return confirmationId;
    }

    const pull = await server.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/git/pull`,
      headers: { authorization: 'Bearer token' },
      payload: {
        confirmationId: await confirm('pull'),
        remote: 'origin',
        targetRef: 'main',
      },
    });
    const push = await server.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/git/push`,
      headers: { authorization: 'Bearer token' },
      payload: {
        confirmationId: await confirm('push'),
        remote: 'origin',
        targetRef: 'HEAD',
      },
    });

    expect([pull.statusCode, push.statusCode]).toEqual([200, 200]);
    expect(gitRuns.map((run) => run.args)).toEqual([
      ['pull', '--ff-only', 'origin', 'main'],
      ['push', 'origin', 'HEAD'],
    ]);
    await server.close();
  });

  it('executes design-book project and task git routes only through confirmed high-risk operations', async () => {
    const dbPath = join(tempDir, 'zeus.db');
    const gitRuns: Array<{ cwd: string; args: string[] }> = [];
    const server = await createLocalServer({
      dbPath,
      apiToken: 'token',
      projectRoot: tempDir,
      gitCommandRunner: async (cwd, args) => {
        gitRuns.push({ cwd, args });
        return { stdout: args.join(' '), stderr: '' };
      },
    });
    const project = await server.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { authorization: 'Bearer token' },
      payload: { name: '真实项目', localPath: tempDir },
    });
    const projectId = project.json().id;
    const task = await server.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: { authorization: 'Bearer token' },
      payload: {
        projectId,
        title: '需要 Git 回滚的真实任务',
        description: '通过设计书 task rollback 路由执行已确认回滚',
      },
    });
    const taskId = task.json().id;

    async function confirm(operation: string): Promise<string> {
      const created = await server.inject({
        method: 'POST',
        url: '/api/git/confirmations',
        headers: { authorization: 'Bearer token' },
        payload: { operation, reason: `确认执行 ${operation}` },
      });
      const confirmationId = created.json().id;
      await server.inject({
        method: 'POST',
        url: `/api/git/confirmations/${confirmationId}/confirm`,
        headers: { authorization: 'Bearer token' },
      });
      return confirmationId;
    }

    const branch = await server.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/git/branch`,
      headers: { authorization: 'Bearer token' },
      payload: {
        confirmationId: await confirm('branch'),
        branchName: 'feature/design-api',
      },
    });
    const checkout = await server.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/git/checkout`,
      headers: { authorization: 'Bearer token' },
      payload: {
        confirmationId: await confirm('switch_branch'),
        branchName: 'main',
      },
    });
    const commit = await server.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/git/commit`,
      headers: { authorization: 'Bearer token' },
      payload: {
        confirmationId: await confirm('commit'),
        message: 'feat: design git routes',
      },
    });
    const stash = await server.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/git/stash`,
      headers: { authorization: 'Bearer token' },
      payload: { confirmationId: await confirm('stash'), message: 'save work' },
    });
    const applyStash = await server.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/git/apply-stash`,
      headers: { authorization: 'Bearer token' },
      payload: {
        confirmationId: await confirm('apply_stash'),
        stashRef: 'stash@{0}',
      },
    });
    const rollback = await server.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/git/rollback`,
      headers: { authorization: 'Bearer token' },
      payload: { confirmationId: await confirm('rollback'), targetRef: 'HEAD' },
    });

    expect([branch, checkout, commit, stash, applyStash, rollback].map((response) => response.statusCode)).toEqual([200, 200, 200, 200, 200, 200]);
    expect(gitRuns.map((run) => run.args)).toEqual([
      ['switch', '-c', 'feature/design-api'],
      ['switch', 'main'],
      ['commit', '-m', 'feat: design git routes'],
      ['stash', 'push', '-m', 'save work'],
      ['stash', 'apply', 'stash@{0}'],
      ['restore', '--source', 'HEAD', '--', '.'],
    ]);
    await server.close();
  });

  it('rejects git operation execution before confirmation or when operation mismatches confirmation', async () => {
    const dbPath = join(tempDir, 'zeus.db');
    const server = await createLocalServer({
      dbPath,
      apiToken: 'token',
      projectRoot: tempDir,
      gitCommandRunner: async () => ({ stdout: '', stderr: '' }),
    });
    const created = await server.inject({
      method: 'POST',
      url: '/api/git/confirmations',
      headers: { authorization: 'Bearer token' },
      payload: { operation: 'stash', reason: '暂存已审查变更' },
    });
    const confirmationId = created.json().id;

    const pendingExecution = await server.inject({
      method: 'POST',
      url: '/api/git/operations',
      headers: { authorization: 'Bearer token' },
      payload: { confirmationId, operation: 'stash', message: 'save work' },
    });
    await server.inject({
      method: 'POST',
      url: `/api/git/confirmations/${confirmationId}/confirm`,
      headers: { authorization: 'Bearer token' },
    });
    const mismatchedExecution = await server.inject({
      method: 'POST',
      url: '/api/git/operations',
      headers: { authorization: 'Bearer token' },
      payload: {
        confirmationId,
        operation: 'commit',
        message: 'feat: wrong op',
      },
    });

    expect(pendingExecution.statusCode).toBe(409);
    expect(pendingExecution.json()).toMatchObject({
      error: 'ZEUS_GIT_CONFIRMATION_NOT_CONFIRMED',
    });
    expect(mismatchedExecution.statusCode).toBe(400);
    expect(mismatchedExecution.json()).toMatchObject({
      error: 'ZEUS_GIT_OPERATION_MISMATCH',
    });
    await server.close();
  });
});
