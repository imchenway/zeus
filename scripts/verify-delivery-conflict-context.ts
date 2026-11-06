import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { defaultGitDeliverySettings } from '../packages/shared/src/index.js';
import { createZeusDatabase, ProjectRepository, TaskRepository, ConversationRepository, ConversationSubmissionRepository, GitDeliveryRepository } from '../packages/storage/src/index.js';
import { conversationRepositoryId, resolveConversationGitWorkspace } from '../packages/local-server/src/conversationGitWorkspace.js';
import { resolveGitDeliveryConflictWorkspace } from '../packages/local-server/src/gitDeliveryExecution.js';
import { conversationGitDeliveryTarget } from '../apps/desktop/src/renderer/git/conversationGitDeliveryTarget.js';

/** 所有 Git 与数据库操作仅访问本次创建的临时目录。 */
const root = await realpath(await mkdtemp(join(tmpdir(), 'zeus-delivery-origin-')));
/** Git 参数不经 shell 解释，并禁用用户钩子和签名。 */
const execute = promisify(execFile);
/** 在指定临时仓库运行 Git。 */
async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execute('git', ['-c', 'user.name=Probe', '-c', 'user.email=probe@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd })).stdout.trim();
}
/** 临时业务数据库提供真实持久关系。 */
const db = await createZeusDatabase(join(root, 'data.db'));
try {
  /** 原仓库和隔离工作树分别对应两个会话的执行目录。 */
  const source = join(root, 'source'),
    isolated = join(root, 'isolated');
  await mkdir(source);
  await git(source, 'init', '-b', 'main');
  await git(source, 'commit', '--allow-empty', '-m', 'initial');
  await git(source, 'worktree', 'add', '--detach', isolated);
  const project = new ProjectRepository(db).create({ name: 'Conflict context', localPath: source });
  const task = new TaskRepository(db).create({ projectId: project.id, title: 'Origin task', taskType: 'feature', description: '', createdFrom: 'probe', sourceContext: {} });
  const conversations = new ConversationRepository(db),
    submissions = new ConversationSubmissionRepository(db),
    deliveries = new GitDeliveryRepository(db);
  const origin = conversations.create({ projectId: project.id, taskId: task.id, title: 'Origin' });
  const conflict = conversations.create({ projectId: project.id, title: 'Conflict' });
  for (const [conversationId, path, mode] of [
    [origin.id, source, 'direct'],
    [conflict.id, isolated, 'worktree'],
  ]) {
    submissions.createOrGet({
      conversationId,
      idempotencyKey: conversationId,
      requestHash: conversationId,
      clientMessageId: conversationId,
      kind: 'message',
      requestedDelivery: 'send_now',
      status: 'completed',
      createdAt: new Date().toISOString(),
      input: { context: { projectLocalPath: path, executionWorkspaceMode: mode } },
    });
  }
  const repositoryId = conversationRepositoryId(origin.id, '.');
  const run = deliveries.create(
    'origin-run',
    project.id,
    {
      scope: { kind: 'conversation', conversationId: origin.id },
      mode: 'merge',
      message: '',
      settings: { ...defaultGitDeliverySettings, commit: false, merge: true, push: false, resolveConflicts: true },
      repositories: [{ repositoryId, paths: [], expectedBranch: 'main', expectedHeadSha: await git(source, 'rev-parse', 'HEAD'), mergeBranch: 'main' }],
    },
    {},
    null,
  );
  deliveries.updateStep(run.steps[0], { state: 'waiting', conversationId: conflict.id, result: { merge: { integrationPath: isolated } } });
  assert.equal(resolveGitDeliveryConflictWorkspace(db, project.id, run.steps[0].id).taskId, task.id);
  conversations.attachDeliveryConflictTask(conflict.id);
  assert.equal(conversations.getRecordById(conflict.id)?.taskId, task.id);
  assert.equal((await resolveConversationGitWorkspace(project, conflict.id, conversations, submissions)).localPath, isolated);
  const context = conversations.getDeliveryConflictOrigin(conflict.id)!;
  assert.deepEqual(conversationGitDeliveryTarget({ id: conflict.id, projectId: project.id, taskId: task.id, deliverySourceConversationId: context.conversationId }), { projectId: project.id, conversationId: origin.id });
  /** 隔离目录回收后仍能找到原交付，但不能假装隔离现场可继续使用。 */
  await git(source, 'worktree', 'remove', isolated);
  assert.equal(conversations.getDeliveryConflictOrigin(conflict.id)?.conversationId, origin.id);
  assert.equal((await resolveConversationGitWorkspace(project, origin.id, conversations, submissions)).localPath, source);
  await assert.rejects(resolveConversationGitWorkspace(project, conflict.id, conversations, submissions), { code: 'ZEUS_CONVERSATION_WORKTREE_UNAVAILABLE' });
  console.log('PASS: task ownership, isolated Git identity, delivery navigation, reclaimed conflict directory');
} finally {
  db.close();
  await rm(root, { recursive: true, force: true });
}
