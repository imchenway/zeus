import { describe, expect, it } from 'vitest';
import { createGitOperationConfirmation, confirmGitOperation, executeHighRiskGitOperation, isGitConfirmationExpired, type GitOperationConfirmation } from '../src/index';

describe('git operation confirmations', () => {
  it('creates a pending confirmation for high-risk stash operations without executing git', () => {
    const confirmation = createGitOperationConfirmation({
      operation: 'stash',
      cwd: '/repo',
      reason: '用户在 Diff 审查页请求暂存当前变更',
    });

    expect(confirmation.status).toBe('pending');
    expect(confirmation.operation).toBe('stash');
    expect(confirmation.cwd).toBe('/repo');
    expect(confirmation.riskLevel).toBe('high');
    expect(confirmation.confirmationText).toBe('确认执行 Git stash');
    expect(confirmation.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(confirmation.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('marks a pending confirmation as confirmed before the caller executes the operation', () => {
    const pending: GitOperationConfirmation = createGitOperationConfirmation({
      operation: 'commit',
      cwd: '/repo',
      reason: '提交 AI 修改',
      message: 'feat: add zeus task controls',
    });

    const confirmed = confirmGitOperation(pending);

    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.confirmedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(confirmed.message).toBe('feat: add zeus task controls');
  });

  it('marks pending confirmations as expired after their explicit expiration time', () => {
    const pending: GitOperationConfirmation = createGitOperationConfirmation(
      {
        operation: 'rollback',
        cwd: '/repo',
        reason: '回滚高风险变更需要短时有效确认',
      },
      {
        createdAt: new Date('2026-06-14T00:00:00.000Z'),
        ttlMs: 10 * 60 * 1000,
      },
    );

    expect(pending.createdAt).toBe('2026-06-14T00:00:00.000Z');
    expect(pending.expiresAt).toBe('2026-06-14T00:10:00.000Z');
    expect(isGitConfirmationExpired(pending, new Date('2026-06-14T00:09:59.999Z'))).toBe(false);
    expect(isGitConfirmationExpired(pending, new Date('2026-06-14T00:10:00.000Z'))).toBe(true);
  });

  it('executes only whitelisted high-risk git operations through an injected runner after confirmation', async () => {
    const calls: Array<{ cwd: string; args: string[] }> = [];
    const confirmed = confirmGitOperation(
      createGitOperationConfirmation({
        operation: 'commit',
        cwd: '/repo',
        reason: '提交已审查变更',
        message: 'feat: reviewed change',
      }),
    );

    const result = await executeHighRiskGitOperation({
      confirmation: confirmed,
      operation: 'commit',
      message: 'feat: reviewed change',
      runner: async (cwd, args) => {
        calls.push({ cwd, args });
        return { stdout: 'committed', stderr: '' };
      },
    });

    expect(calls).toEqual([{ cwd: '/repo', args: ['commit', '-m', 'feat: reviewed change'] }]);
    expect(result).toMatchObject({
      operation: 'commit',
      stdout: 'committed',
      stderr: '',
    });
  });

  it('builds safe git arguments for branch, stash, pull, push and rollback operations without accepting arbitrary subcommands', async () => {
    const calls: string[][] = [];
    const run = async (operation: GitOperationConfirmation['operation'], input: Record<string, string | undefined> = {}) =>
      executeHighRiskGitOperation({
        confirmation: confirmGitOperation(
          createGitOperationConfirmation({
            operation,
            cwd: '/repo',
            reason: '设计书 Git 操作确认',
            message: input.message,
          }),
        ),
        operation,
        branchName: input.branchName,
        baseRef: input.baseRef,
        stashRef: input.stashRef,
        remote: input.remote,
        targetRef: input.targetRef,
        message: input.message,
        runner: async (_cwd, args) => {
          calls.push(args);
          return { stdout: args.join(' '), stderr: '' };
        },
      });

    await run('stash', { message: 'save reviewed work' });
    await run('apply_stash', { stashRef: 'stash@{1}' });
    await run('branch', { branchName: 'feature/reviewed', baseRef: 'main' });
    await run('switch_branch', { branchName: 'release/0.1' });
    await run('pull', { remote: 'origin', targetRef: 'main' });
    await run('push', { remote: 'origin', targetRef: 'feature/reviewed' });
    await run('rollback', { targetRef: 'HEAD~1' });

    expect(calls).toEqual([
      ['stash', 'push', '-m', 'save reviewed work'],
      ['stash', 'apply', 'stash@{1}'],
      ['switch', '-c', 'feature/reviewed', 'main'],
      ['switch', 'release/0.1'],
      ['pull', '--ff-only', 'origin', 'main'],
      ['push', 'origin', 'feature/reviewed'],
      ['restore', '--source', 'HEAD~1', '--', '.'],
    ]);
  });

  it('rejects execution when confirmation is not confirmed, operation mismatches, or refs contain unsafe shell-like characters', async () => {
    const pending = createGitOperationConfirmation({
      operation: 'push',
      cwd: '/repo',
      reason: '推送前确认',
    });
    const confirmed = confirmGitOperation(
      createGitOperationConfirmation({
        operation: 'push',
        cwd: '/repo',
        reason: '推送前确认',
      }),
    );
    const runner = async () => ({ stdout: '', stderr: '' });

    await expect(
      executeHighRiskGitOperation({
        confirmation: pending,
        operation: 'push',
        remote: 'origin',
        targetRef: 'main',
        runner,
      }),
    ).rejects.toThrow('confirmed');
    await expect(
      executeHighRiskGitOperation({
        confirmation: confirmed,
        operation: 'pull',
        remote: 'origin',
        targetRef: 'main',
        runner,
      }),
    ).rejects.toThrow('match');
    await expect(
      executeHighRiskGitOperation({
        confirmation: confirmed,
        operation: 'push',
        remote: 'origin;rm -rf /',
        targetRef: 'main',
        runner,
      }),
    ).rejects.toThrow('unsafe');
  });
});
