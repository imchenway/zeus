import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { configureProjectGitAuthentication } from '../apps/desktop/src/main/projectGitAuthentication.js';
import { businessProcessEnvironment } from '../packages/ai-runtime/src/commandExecution.js';

/** 检查调用方提供的本次构建，不使用正式应用或用户私钥。 */
const helper = resolve(process.argv[2] ?? 'apps/desktop/dist/native/ZeusGitAskpass');
/** 只在当前检查进程中暂改这组非敏感环境变量。 */
const environmentKeys = ['GIT_ASKPASS', 'SSH_ASKPASS', 'SSH_ASKPASS_REQUIRE', 'DISPLAY', 'ZEUS_GIT_ASKPASS_SERVICE'];
/** 离开检查时完整恢复调用环境。 */
const previous = new Map(environmentKeys.map((key) => [key, process.env[key]]));
/** 临时密钥与全部输出留在任务专属临时目录。 */
const directory = await mkdtemp(join(tmpdir(), 'zeus-git-askpass-check-'));

try {
  for (const key of environmentKeys) delete process.env[key];
  configureProjectGitAuthentication(helper, 'Zeus Test offline-check');
  assert.equal(process.env.GIT_ASKPASS, helper);
  assert.equal(process.env.SSH_ASKPASS, helper);
  assert.equal(process.env.SSH_ASKPASS_REQUIRE, 'force');
  /** 检查业务环境保留认证身份，同时继续过滤宿主私有字段。 */
  const inherited = businessProcessEnvironment({ ...process.env, ZEUS_PRIVATE_CHECK_VALUE: 'must-not-inherit' });
  assert.equal(inherited.ZEUS_GIT_ASKPASS_SERVICE, 'Zeus Test offline-check.Git.SSH');
  assert.equal(inherited.ZEUS_PRIVATE_CHECK_VALUE, undefined);
  process.env.SSH_ASKPASS = '/explicit/custom-askpass';
  process.env.SSH_ASKPASS_REQUIRE = 'never';
  configureProjectGitAuthentication(helper, 'Zeus');
  assert.equal(process.env.SSH_ASKPASS, '/explicit/custom-askpass');
  assert.equal(process.env.SSH_ASKPASS_REQUIRE, 'never');
  assert.throws(() => configureProjectGitAuthentication(helper, 'bad\nservice'));
  assert.throws(() => configureProjectGitAuthentication('relative-helper', 'Zeus'));

  /** 生成检查专用密钥；固定口令仅为公开样例，不是用户凭据。 */
  const phrase = 'zeus-offline-口令-check';
  /** 包含空格和引号的路径必须保持为单个参数。 */
  const keyPath = join(directory, "示例 key's file");
  /** 使用平台已有 OpenSSH，不安装新依赖。 */
  const keygen = process.platform === 'darwin' ? '/usr/bin/ssh-keygen' : 'ssh-keygen';
  /** 生成临时样例文件，不访问任何 Git 服务器。 */
  const generated = spawnSync(keygen, ['-q', '-t', 'ed25519', '-N', phrase, '-f', keyPath], { encoding: 'utf8', timeout: 15_000 });
  assert.equal(generated.status, 0, '临时 SSH 密钥生成失败');
  for (const [input, accepted] of [
    [phrase, true],
    ['incorrect', false],
    ['contains\nnewline', false],
    ['x'.repeat(1100), false],
  ] as const) {
    /** 真实经过 OpenSSH 与原生 askpass 的匿名输入管道，不打开窗口或访问凭据库。 */
    const checked = spawnSync(keygen, ['-y', '-f', keyPath], {
      input,
      encoding: 'utf8',
      timeout: 20_000,
      env: { ...process.env, SSH_ASKPASS: helper, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: 'zeus', ZEUS_GIT_ASKPASS_STDIN: '1' },
    });
    assert.equal(checked.status === 0, accepted, 'SSH askpass 管道验证结果错误');
    assert.ok(!(checked.stdout ?? '').includes(phrase));
    assert.ok(!(checked.stderr ?? '').includes(phrase));
  }
  console.log('Git 认证离线检查通过：环境继承、显式覆盖、有效口令、错误口令和输入边界；未连接服务器或读写系统凭据。');
} finally {
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(directory, { recursive: true, force: true });
}
