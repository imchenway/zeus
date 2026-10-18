import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildAppShellMenuTemplate, shouldQuitWhenAllWindowsClosed } from '../apps/desktop/src/main/appShellPolicy.js';
import { openSourceLocation } from '../apps/desktop/src/main/sourceOpen.js';
import { extractTaskClipboardFileReferences, readTaskClipboardAttachmentsFromClipboard, readTaskClipboardFileReferencesFromClipboard, type NativeTaskClipboardReader } from '../apps/desktop/src/main/taskClipboard.js';

// 真实临时目录验证路径边界，不读取或修改用户项目。
const directory = await mkdtemp(join(tmpdir(), 'zeus-windows-desktop-'));
try {
  // 特殊字符和中文路径必须保持完整，文件 URL 只解码一次。
  const project = join(directory, '项目 目录');
  const source = join(project, '百分号%20文件.txt');
  const outside = join(directory, 'outside');
  await mkdir(project);
  await mkdir(outside);
  await writeFile(source, 'source');
  await writeFile(join(outside, 'private.txt'), 'outside');
  assert.deepEqual(extractTaskClipboardFileReferences([pathToFileURL(source).href]), [source]);
  if (process.platform === 'win32') assert.deepEqual(extractTaskClipboardFileReferences([source]), [source]);

  /** 原生读取失败时不能读取文件图标并把它误当附件。 */
  const emptyClipboard: NativeTaskClipboardReader = {
    readText: () => '',
    readHTML: () => '',
    availableFormats: () => [],
    readBuffer: () => new Uint8Array(),
    readImage: () => {
      assert.fail('原生文件读取失败后不得读取 bitmap');
    },
  };
  /** 系统失败按原错误返回，保持一次粘贴只报告一次失败。 */
  const failedClipboard = {
    readSystemFileReferences: async (): Promise<string[]> => {
      throw new Error('clipboard-read-failed');
    },
  };
  await assert.rejects(readTaskClipboardAttachmentsFromClipboard(emptyClipboard, failedClipboard), /clipboard-read-failed/u);
  await assert.rejects(readTaskClipboardFileReferencesFromClipboard(emptyClipboard, failedClipboard), /clipboard-read-failed/u);
  await assert.rejects(readTaskClipboardAttachmentsFromClipboard(emptyClipboard, { readSystemFileReferences: async () => [join(directory, 'missing.txt')] }), /文件无法读取/u);

  // 打开回调只有在真实目录归属通过后才允许执行。
  let openedPath: string | null = null;
  const options = {
    projectRoot: project,
    source: { sourceRef: source },
    checkAccess: access,
    /** 记录系统打开请求，不在检查期间启动外部应用。 */
    openPath: async (path: string): Promise<string> => {
      openedPath = path;
      return '';
    },
  };
  assert.equal((await openSourceLocation(options)).opened, true);
  assert.equal(openedPath, await realpath(source));
  await assert.rejects(openSourceLocation({ ...options, source: { sourceRef: '../outside/private.txt' } }), /项目根目录/u);
  await symlink(outside, join(project, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(openSourceLocation({ ...options, source: { sourceRef: 'linked/private.txt' } }), /项目根目录/u);

  // 托盘驻留是 Windows 与 macOS 的明确产品行为，不受默认退出行为影响。
  for (const platform of ['win32', 'darwin']) {
    assert.equal(shouldQuitWhenAllWindowsClosed({ platform, backgroundModeEnabled: true }), false);
    assert.equal(shouldQuitWhenAllWindowsClosed({ platform, backgroundModeEnabled: false }), true);
  }
  // 复用菜单生成器，恢复入口必须是可操作动作。
  let recoveryRequested = false;
  /** 菜单检查不触发其他桌面动作。 */
  const noop = (): void => {};
  const menu = buildAppShellMenuTemplate({
    applicationName: 'Zeus Test',
    settings: { appLanguage: 'zh-CN', webviewDebugEnabled: false, multiWindowEnabled: true, backgroundModeEnabled: true, desktopNotificationsEnabled: true, openAtLoginEnabled: false },
    createNewConversation: noop,
    showMainWindow: noop,
    openSettings: noop,
    checkForUpdates: noop,
    recoverUpdate: () => {
      recoveryRequested = true;
    },
    openLogsDirectory: noop,
    closeFocusedWindow: noop,
    quit: noop,
  });
  await menu[0]?.submenu?.find((entry) => entry.label === '恢复上次安装…')?.click?.();
  assert.equal(recoveryRequested, true);
  console.log(`桌面路径与菜单协议检查通过（${process.platform}/${process.arch}）；不代表 Windows 原生界面验收。`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
