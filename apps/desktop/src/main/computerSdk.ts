import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

/** 仅开放官方 SDK 与 Electron 权限适配入口。 */
type ComputerSdkEntry = '@trycua/cua-driver' | '@trycua/cua-driver/electron';

/** Windows 安装资源与可执行文件分开存放；开发和 macOS 继续使用构建目录。 */
export function computerNativePath(name: string): string {
  if (process.platform === 'win32' && existsSync(resolve(process.resourcesPath, 'native', 'cua-sdk'))) return resolve(process.resourcesPath, 'native', name);
  return resolve(import.meta.dirname, '../native', name).replace(/\.asar(?=[\\/])/u, '.asar.unpacked');
}

/** SDK 绑定与私有原生库从同一构建产物加载，避免宿主校验和 worker 配置不一致。 */
export function computerSdkUrl(entry: ComputerSdkEntry): string {
  /** 入口相对当前构建定位，主进程和不含 app 模块的 SDK 后台进程均可使用。 */
  const physical = computerNativePath(`cua-sdk/dist/${entry === '@trycua/cua-driver/electron' ? 'electron.js' : 'index.js'}`);
  if (!existsSync(physical)) throw new Error('Computer Use 原生组件不完整，请使用完整构建的应用包。');
  return pathToFileURL(physical).href;
}
