import { app, nativeImage } from 'electron';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { promisify } from 'node:util';

/** 原生命令使用独立参数，不把应用元信息拼接为 shell 命令。 */
const execFile = promisify(execFileCallback);
/** 同一已安装应用只读取一次图标，工具栏和菜单共用结果。 */
const applicationIcons = new Map<string, Promise<string | undefined>>();

/** 读取本机真实应用图标，避免系统文件图标接口返回通用占位图。 */
export function getApplicationIcon(path: string): Promise<string | undefined> {
  /** 缓存正在读取的结果，合并同时打开工具栏和菜单的请求。 */
  const cached = applicationIcons.get(path);
  if (cached) return cached;
  /** 失败也由下层收敛为可展示的系统图标或空值。 */
  const pending = readApplicationIcon(path);
  applicationIcons.set(path, pending);
  return pending;
}

/** macOS 应用包的 ICNS 使用系统转换器读取，其他情况保留原生文件图标。 */
async function readApplicationIcon(path: string): Promise<string | undefined> {
  if (process.platform === 'darwin' && extname(path).toLowerCase() === '.app') {
    /** 临时文件仅属于此次图标读取，成功或失败后都删除。 */
    let temporaryDirectory: string | undefined;
    try {
      /** 只读取已确认应用包登记的资源名。 */
      const { stdout } = await execFile('/usr/bin/plutil', ['-extract', 'CFBundleIconFile', 'raw', '-o', '-', join(path, 'Contents', 'Info.plist')], { timeout: 3000 });
      /** 禁止应用元信息把资源定位扩展到应用包以外。 */
      const name = stdout.trim();
      if (!name || basename(name) !== name) throw new Error('应用图标资源名无效。');
      /** 部分应用省略默认的 ICNS 扩展名。 */
      const iconPath = join(path, 'Contents', 'Resources', extname(name) ? name : `${name}.icns`);
      temporaryDirectory = await mkdtemp(join(tmpdir(), 'zeus-application-icon-'));
      /** PNG 是 Electron 可直接解码的格式，不将 ICNS 当作图片地址交给渲染层。 */
      const pngPath = join(temporaryDirectory, 'icon.png');
      await execFile('/usr/bin/sips', ['-s', 'format', 'png', iconPath, '--out', pngPath], { timeout: 3000 });
      /** 两倍显示尺寸保持菜单和工具栏图标清晰。 */
      const icon = nativeImage.createFromPath(pngPath);
      if (!icon.isEmpty()) return icon.resize({ width: 40, height: 40 }).toDataURL();
    } catch {
      // 应用包缺少传统图标资源时，保留系统提供的通用图标。
    } finally {
      if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  try {
    /** 图标读取不能阻止用户打开已授权文件。 */
    const icon = await app.getFileIcon(path, { size: 'normal' });
    return icon.isEmpty() ? undefined : icon.toDataURL();
  } catch {
    return undefined;
  }
}
