import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FilePreviewItem } from '@zeus/shared';
import { getFilePreviewBlame, getGitFilePreviewSources, parseGitUnifiedDiff } from '../packages/git-core/src/index.js';
import { fullFileDiff, normalizedFileLine } from '../apps/desktop/src/renderer/code/fullFileDiff.js';

/** 检查只使用临时 Git 仓库，不提交或改写用户仓库。 */
const root = await mkdtemp(join(tmpdir(), 'zeus-code-reading-'));
/** 所有命令固定在临时仓库执行，避免继承调用目录。 */
function git(...args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: '阅读检查', GIT_AUTHOR_EMAIL: 'reading@example.invalid', GIT_COMMITTER_NAME: '阅读检查', GIT_COMMITTER_EMAIL: 'reading@example.invalid' },
  });
}
/** 创建完整文本预览，字段与实际 IPC 结构一致。 */
function item(content: string): FilePreviewItem {
  return { id: 'check', name: 'sample.ts', label: '检查内容', kind: 'text', mime: 'text/plain', byteLength: Buffer.byteLength(content), content };
}
try {
  git('init', '--quiet');
  git('config', 'core.autocrlf', 'false');
  /** 文件头尾上下文用于确认补丁以外内容确实补全。 */
  const before = Array.from({ length: 30 }, (_, index) => `const value${index + 1} = ${index + 1};`).join('\n') + '\n';
  await writeFile(join(root, 'sample.ts'), before);
  git('add', 'sample.ts');
  git('commit', '--quiet', '-m', '初始化检查样本');
  /** 中间修改保留明显的上下文区间。 */
  const after = before.replace('value15 = 15', 'value15 = 150');
  await writeFile(join(root, 'sample.ts'), after);
  /** 使用真实 Git 补丁，不手工构造差异行号。 */
  const diff = parseGitUnifiedDiff(git('diff', '--', 'sample.ts'))[0]!;
  /** LF、CRLF、BOM 与文件尾换行均保留正确的全文和增删身份。 */
  for (const content of [after, after.replaceAll('\n', '\r\n'), `\uFEFF${after}`]) {
    const full = fullFileDiff(diff, [item(before), item(content)]);
    assert.ok(full, '完整预览应能还原全文');
    assert.equal(full.hunks[0]!.lines.filter((line) => line.type !== 'addition').length, 30);
    assert.equal(full.hunks[0]!.lines.filter((line) => line.type === 'addition').length, 1);
  }
  assert.equal(normalizedFileLine('\uFEFFconst value1 = 1;\r', 1), 'const value1 = 1;');
  assert.equal(fullFileDiff(diff, [item(before), item(after.replace('value1 = 1', 'value1 = 9'))]), null, '上下文过期必须拒绝');
  assert.equal(fullFileDiff(diff, [item(before), { ...item(after), truncated: true }]), null, '截断文本不能作为全文');
  /** 正文的加减号与 Markdown 分隔线不能误识别为文件头。 */
  const punctuation = parseGitUnifiedDiff('diff --git a/sample.ts b/sample.ts\n--- a/sample.ts\n+++ b/sample.ts\n@@ -1,2 +1,2 @@\n----\n--- old\n++++\n+++ new\n')[0]!;
  assert.ok(fullFileDiff(punctuation, [item('---\n-- old\n'), item('+++\n++ new\n')]));
  /** 新增与删除只允许明确不存在的一侧充当空文本。 */
  const addedDiff = parseGitUnifiedDiff('diff --git a/sample.ts b/sample.ts\nnew file mode 100644\n--- /dev/null\n+++ b/sample.ts\n@@ -0,0 +1 @@\n+new\n')[0]!;
  assert.ok(fullFileDiff(addedDiff, [{ ...item(''), kind: 'unavailable', missing: true }, item('new\n')]));
  assert.equal(fullFileDiff(addedDiff, [{ ...item(''), kind: 'unavailable' }, item('new\n')]), null);
  const deletedDiff = parseGitUnifiedDiff('diff --git a/sample.ts b/sample.ts\ndeleted file mode 100644\n--- a/sample.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n')[0]!;
  assert.ok(fullFileDiff(deletedDiff, [item('old\n'), { ...item(''), kind: 'unavailable', missing: true }]));
  /** 历史侧返回固定提交；工作区侧只把真正修改行标为未提交。 */
  const sides = await getGitFilePreviewSources(root, { path: 'sample.ts' });
  const historical = await getFilePreviewBlame(sides[0]!.git!, join(root, 'sample.ts'));
  const current = await getFilePreviewBlame(sides[1]!.git!, join(root, 'sample.ts'));
  assert.equal(historical.lines.length, 30);
  assert.equal(current.lines[0]!.author, '阅读检查');
  assert.match(current.lines[14]!.commitHash, /^0+$/u);
  git('add', 'sample.ts');
  /** 暂存内容读取为固定副本，之后的磁盘修改不影响其归属。 */
  const staged = await getGitFilePreviewSources(root, { path: 'sample.ts', stage: 'staged' });
  const stagedPath = join(root, 'staged-content');
  await writeFile(stagedPath, git('show', ':sample.ts'));
  await writeFile(join(root, 'sample.ts'), after.replace('value20 = 20', 'value20 = 200'));
  const stagedBlame = await getFilePreviewBlame(staged[1]!.git!, stagedPath);
  assert.match(stagedBlame.lines[14]!.commitHash, /^0+$/u);
  assert.equal(stagedBlame.lines[19]!.author, '阅读检查');
  git('commit', '--quiet', '-m', '保存检查修改');
  await assert.rejects(() => getFilePreviewBlame(sides[1]!.git!, join(root, 'sample.ts')), /基线已变化/u);
  git('mv', 'sample.ts', 'renamed.ts');
  /** 重命名后的编辑目标必须为当前路径，历史侧仍使用旧路径。 */
  const renamed = await getGitFilePreviewSources(root, { path: 'renamed.ts' });
  assert.equal(renamed[0]!.name, 'sample.ts');
  assert.equal(renamed[0]!.edit!.path, join(root, 'renamed.ts'));
  await writeFile(join(root, 'new.ts'), 'const added = true;\n');
  const added = await getGitFilePreviewSources(root, { path: 'new.ts' });
  assert.equal(added[0]!.missing, true);
  const untracked = await getFilePreviewBlame(added[1]!.git!, join(root, 'new.ts'));
  assert.equal(untracked.lines.length, 1);
  assert.match(untracked.lines[0]!.commitHash, /^0+$/u);
  assert.equal(await readFile(join(root, 'new.ts'), 'utf8'), 'const added = true;\n');
  console.log('代码阅读检查通过：全文、CRLF、BOM、过期拒绝、历史/工作区/暂存归属、重命名与新增文件。');
} finally {
  await rm(root, { recursive: true, force: true });
}
