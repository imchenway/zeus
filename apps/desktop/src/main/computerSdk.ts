import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** 仅开放官方 SDK 与 Electron 权限适配入口。 */
type ComputerSdkEntry = '@trycua/cua-driver' | '@trycua/cua-driver/electron';

/** 原生 SDK 从真实解包目录加载，使官方依赖解析和 dlopen 使用同一物理路径。 */
export function computerSdkUrl(entry: ComputerSdkEntry): string {
  /** 开发依赖沿用正常 Node 解析，打包时只转换应用自身的 ASAR 边界。 */
  const resolved = fileURLToPath(import.meta.resolve(entry));
  /** SDK、绑定及原生库整组解包，不修改第三方生成代码或尝试第二套加载器。 */
  const physical = resolved.replace(/([/\\])app\.asar([/\\])/u, '$1app.asar.unpacked$2');
  if (!existsSync(physical)) throw new Error('Computer Use 原生组件不完整，请使用完整构建的应用包。');
  return pathToFileURL(physical).href;
}
