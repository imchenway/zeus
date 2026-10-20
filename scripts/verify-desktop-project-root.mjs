import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { URL } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

/** 只使用独立临时目录，不启动 Electron 或读取用户项目。 */
const directory = await mkdtemp(join(tmpdir(), 'zeus-desktop-project-root-'));
try {
  /** 使用实际文件模拟打包目录：app.asar 是文件，不是原生进程可进入的目录。 */
  const resourcesPath = join(directory, '安装资源 中文');
  await mkdir(resourcesPath);
  await writeFile(join(resourcesPath, 'app.asar'), '');
  /** 提取 Main 的实际解析函数，不复制生产路径逻辑。 */
  const source = ts.createSourceFile('main.ts', await readFile(new URL('../apps/desktop/src/main/main.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
  /** 函数删除或改名时检查明确失败。 */
  const declaration = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'resolveMainProjectRoot');
  assert.ok(declaration, '缺少桌面默认项目根解析');
  /** 仅移除类型，执行当前生产源码。 */
  const javascript = ts.transpileModule(declaration.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  /** 保留打包、开发和显式目录三种入口，两端共用同一默认资源根语义。 */
  const context = { app: { isPackaged: true }, process: { env: {}, resourcesPath, cwd: () => directory }, desktopRoot: () => join(resourcesPath, 'app.asar') };
  /** 只向纯路径解析函数提供环境，不执行 Main 的其他初始化。 */
  const resolveRoot = runInNewContext(`${javascript}\nresolveMainProjectRoot`, context);
  assert.equal(resolveRoot(), resourcesPath);
  /** 用真实子进程确认选出的 cwd 可进入，不能只断言字符串形式。 */
  const launched = spawnSync(process.execPath, ['-p', 'process.cwd()'], { cwd: resolveRoot(), encoding: 'utf8', timeout: 5_000, windowsHide: true });
  assert.ifError(launched.error);
  assert.equal(launched.status, 0, launched.stderr);
  assert.equal(await realpath(launched.stdout.trim()), await realpath(resourcesPath));
  context.app.isPackaged = false;
  assert.equal(resolveRoot(), directory);
  context.process.env.ZEUS_PROJECT_ROOT = resourcesPath;
  assert.equal(resolveRoot(), resourcesPath);
} finally {
  await rm(directory, { recursive: true, force: true });
}
process.stdout.write('桌面项目根检查通过：打包版使用真实目录，保留开发及显式目录；当前平台子进程启动成功，未执行 Windows 原生验收。\n');
