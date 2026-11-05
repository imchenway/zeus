import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createZeusDatabase, ProjectRepository, ConversationWorktreeRecoveryRepository } from '../packages/storage/src/index.js';
import { removeConversationWorktrees, type ConversationWorktreeCleanup } from '../packages/local-server/src/conversationWorktreeLifecycle.js';

/** 只在临时仓库执行固定 Git 参数，不访问用户仓库。 */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Cleanup check', '-c', 'user.email=cleanup@example.invalid', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** 创建带真实提交的来源仓库。 */
async function repository(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  git(path, 'init');
  await writeFile(join(path, 'file.txt'), 'committed\n');
  git(path, 'add', '.');
  git(path, 'commit', '-m', 'initial');
}

/** 全部 Git 与 SQLite 数据均限于独立临时目录。 */
const root = await realpath(await mkdtemp(join(tmpdir(), 'zeus-worktree-cleanup-')));
/** 使用真实恢复仓储，验证删除前已保存全部成员身份。 */
const db = await createZeusDatabase(join(root, 'check.db'));
try {
  /** 来源项目只用于临时数据库外键与恢复记录。 */
  const project = new ProjectRepository(db).create({ name: 'Cleanup check', localPath: root });
  for (const dirtyParent of [false, true]) {
    /** 两次独立现场分别覆盖干净父仓及检查后出现其他改动。 */
    const scene = join(root, dirtyParent ? 'dirty' : 'clean');
    /** 父仓与子仓分别拥有自己的 Git 公共目录。 */
    const parent = join(scene, 'parent');
    const child = join(scene, 'child');
    const worktree = join(scene, 'worktree');
    const nested = join(worktree, 'packages', 'child');
    await repository(parent);
    await repository(child);
    git(parent, 'update-index', '--add', '--cacheinfo', `160000,${git(child, 'rev-parse', 'HEAD')},packages/child`);
    git(parent, 'commit', '-m', 'track child');
    git(parent, 'worktree', 'add', '-b', 'cleanup-parent', worktree);
    await rm(nested, { recursive: true, force: true });
    git(child, 'worktree', 'add', '-b', 'cleanup-child', nested);
    assert.equal(git(worktree, 'status', '--porcelain'), '');
    /** 复用实际清理接口，父仓和子仓都未授权丢弃本地改动。 */
    const plans: ConversationWorktreeCleanup[] = [
      [parent, worktree],
      [child, nested],
    ].map(([repositoryPath, worktreePath]) => ({
      projectId: project.id,
      rootPath: worktree,
      repositoryPath,
      worktreePath,
      branchName: git(worktreePath, 'branch', '--show-current'),
      headSha: git(worktreePath, 'rev-parse', 'HEAD'),
      force: false,
    }));
    if (dirtyParent) await writeFile(join(worktree, 'file.txt'), 'keep this change\n');
    if (dirtyParent) {
      await assert.rejects(removeConversationWorktrees(db, plans), { code: 'ZEUS_TASK_WORKSPACE_DIRTY' });
      assert.equal(existsSync(worktree), true);
      assert.equal(existsSync(nested), false);
    } else {
      assert.equal(await removeConversationWorktrees(db, plans), 2);
      assert.equal(existsSync(worktree), false);
    }
    assert.equal(new ConversationWorktreeRecoveryRepository(db).list(project.id, worktree).length, 2);
    assert.equal(git(child, 'rev-parse', 'cleanup-child'), plans[1].headSha);
    assert.equal(git(parent, 'rev-parse', 'cleanup-parent'), plans[0].headSha);
  }
  console.log('PASS: nested cleanup, unrelated changes preserved, recovery identities and branches retained');
} finally {
  db.close();
  await rm(root, { recursive: true, force: true });
}
