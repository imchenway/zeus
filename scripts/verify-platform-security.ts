import assert from 'node:assert/strict';
import { closeSync, constants, existsSync, linkSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertPrivatePathSync,
  assertWindowsPortablePath,
  assertWindowsPortablePaths,
  ensurePrivatePathSync,
  openRegularFileNoFollow,
  openRegularFileNoFollowSync,
  pathIsInside,
  publishFileSync,
  readPrivateFileSync,
} from '../packages/storage/src/platformSecurity.js';
import { createPlatformSecretStore } from '../packages/local-server/src/securityCore.js';

/** 所有读写仅发生在本次创建的临时目录，不接触现有用户数据或钥匙串。 */
const root = mkdtempSync(join(tmpdir(), 'zeus-platform-security-'));
try {
  ensurePrivatePathSync(root, 'directory');
  assertPrivatePathSync(root, 'directory');
  /** 首次发布和重复发布使用不同暂存文件，确保冲突不会覆盖已有内容。 */
  const target = join(root, 'identity.json');
  const first = join(root, 'first.tmp');
  const second = join(root, 'second.tmp');
  writeFileSync(first, '{"owner":"first"}', { mode: 0o600 });
  ensurePrivatePathSync(first, 'file');
  publishFileSync(first, target, { replace: false });
  assert.equal(readPrivateFileSync(target, 1024).toString(), '{"owner":"first"}');
  writeFileSync(second, '{"owner":"second"}', { mode: 0o600 });
  ensurePrivatePathSync(second, 'file');
  assert.throws(
    () => publishFileSync(second, target, { replace: false }),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'EEXIST',
  );
  assert.equal(readFileSync(target, 'utf8'), '{"owner":"first"}');
  assert.ok(existsSync(second));
  publishFileSync(second, target, { replace: true });
  assert.equal(readPrivateFileSync(target, 1024).toString(), '{"owner":"second"}');
  /** 私有内容拒绝越界读取和可通过第二目录项替换的硬链接。 */
  assert.throws(() => readPrivateFileSync(target, 1));
  assert.throws(() => readPrivateFileSync(target, Number.POSITIVE_INFINITY));
  const alias = join(root, 'identity-alias.json');
  linkSync(target, alias);
  assert.throws(() => readPrivateFileSync(target, 1024));
  unlinkSync(alias);
  /** 同步 SQLite 头读取与异步备份流使用相同的普通文件身份边界。 */
  const descriptor = openRegularFileNoFollowSync(target, constants.O_RDONLY);
  try {
    assert.equal(readFileSync(descriptor, 'utf8'), '{"owner":"second"}');
  } finally {
    closeSync(descriptor);
  }
  const handle = await openRegularFileNoFollow(target, constants.O_RDONLY);
  try {
    assert.equal(await handle.readFile('utf8'), '{"owner":"second"}');
  } finally {
    await handle.close();
  }
  assert.equal(pathIsInside(join(root, '..', 'outside'), root), false);
  for (const path of ['C:/escape', 'asset:secret', 'AUX.txt', 'folder/CON', 'trailing.', 'trailing ', '../escape', 'folder\\escape']) assert.throws(() => assertWindowsPortablePath(path));
  assertWindowsPortablePath('资料/有效文件.txt');
  assertWindowsPortablePaths(['assets/资料/a.txt', 'assets/资料/b.txt']);
  for (const paths of [
    ['assets/A/a', 'assets/a/b'],
    ['assets/a', 'assets/a/b'],
    ['assets/a/b', 'assets/a'],
    ['assets/A', 'assets/a'],
  ])
    assert.throws(() => assertWindowsPortablePaths(paths));

  if (process.platform === 'win32') {
    assert.equal(pathIsInside('D:\\outside', 'C:\\allowed'), false);
    /** Windows 以真实 DPAPI 检查长凭据、命名空间隔离和删除；不会使用系统正式账户。 */
    const primary = createPlatformSecretStore({ service: 'Zeus Verification A', dataRootPath: root });
    const isolated = createPlatformSecretStore({ service: 'Zeus Verification B', dataRootPath: root });
    const secret = '中'.repeat(32 * 1024);
    assert.equal(await primary.getSecret('verification.token'), undefined);
    assert.equal(existsSync(join(root, 'runtime', 'secrets')), false, '读取缺项不得创建凭据目录');
    await primary.setSecret('verification.token', secret);
    assert.equal(await primary.getSecret('verification.token'), secret);
    assert.equal(await isolated.getSecret('verification.token'), undefined);
    await primary.deleteSecret('verification.token');
    assert.equal(await primary.getSecret('verification.token'), undefined);
  }
  console.log(JSON.stringify({ status: 'passed', platform: process.platform, atomicPublication: true, portablePaths: true, windowsDpapi: process.platform === 'win32' ? 'passed' : 'not_run' }));
} finally {
  rmSync(root, { recursive: true, force: true });
}
