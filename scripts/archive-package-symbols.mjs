import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { listAsarFilePaths, readAsarFiles } from './verify-packaged-app-health.mjs';
import { sha256File } from './release-script-utils.mjs';

/** 构建输入固定来自当前工作树，避免归档其他检出的调试文件。 */
const root = resolve(import.meta.dirname, '..');
/** 只归档应用运行脚本和第一方工作区包；原生二进制使用对应平台的独立调试符号。 */
const scriptPattern = /^(?:dist\/(?:main|preload|renderer)\/|node_modules\/@zeus\/[^/]+\/dist\/).+\.(?:js|cjs|mjs)$/u;

/** 对已读取的脚本、对照表和源码包记录原始字节指纹。 */
function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** 核对实际打包内容后，在安装包旁保存独立定位目录；任一步失败都不宣布打包成功。 */
export async function archivePackageSymbols({ asarPath, outputRoot, platform, arch, variant, installerPaths = [] }) {
  /** 报告中的 ASAR 指纹直接定位本次归档，重复构建也保留各自的安装器指纹。 */
  const asarSha256 = await sha256File(asarPath);
  /** 打包清单决定归档范围，不收集未进入安装包的残留构建文件。 */
  const scriptPaths = listAsarFilePaths(asarPath, '')
    .filter((path) => scriptPattern.test(path))
    .sort();
  if (!scriptPaths.some((path) => path.startsWith('dist/renderer/')) || !scriptPaths.includes('dist/main/main.js') || !scriptPaths.includes('dist/preload/index.cjs')) throw new Error('定位文件归档缺少应用运行入口。');
  /** 复用已随应用生成的完整源码包，保持 TypeScript 对照表指向的源码可用。 */
  const sourcePath = 'dist/licenses/zeus-source.tar.gz';
  const packed = readAsarFiles(asarPath, [...scriptPaths, sourcePath, 'package.json']);
  /** 应用和 Electron 版本分别来自实际包与当前构建清单。 */
  const app = JSON.parse(packed.get('package.json').toString('utf8'));
  const workspace = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (app.version !== workspace.version) throw new Error('定位文件归档的应用版本与构建输入不一致。');
  /** 每次构建使用独立目录，旧版本的定位文件不会被覆盖或清理。 */
  const symbolsRoot = join(outputRoot, 'symbols');
  await mkdir(symbolsRoot, { recursive: true });
  const staging = await mkdtemp(join(symbolsRoot, `.pending-${asarSha256}-`));
  try {
    /** 清单同时绑定源码、运行脚本、对照表、ASAR 和最终安装器。 */
    const manifest = {
      appVersion: app.version,
      electronVersion: workspace.devDependencies.electron,
      platform,
      arch,
      variant,
      createdAt: new Date().toISOString(),
      asar: { sha256: asarSha256, bytes: (await stat(asarPath)).size },
      source: { path: 'zeus-source.tar.gz', sha256: sha256(packed.get(sourcePath)), bytes: packed.get(sourcePath).length },
      installers: [],
      scripts: [],
    };
    await writeFile(join(staging, manifest.source.path), packed.get(sourcePath));
    for (const path of scriptPaths) {
      /** 第一方工作区包在 ASAR 的 node_modules 中，本机构建输入位于 packages。 */
      const local = path.startsWith('dist/') ? join(root, 'apps/desktop', path) : join(root, 'packages', path.slice('node_modules/@zeus/'.length));
      const script = packed.get(path);
      if (!(await readFile(local)).equals(script)) throw new Error(`定位文件与安装包脚本不匹配：${path}`);
      /** Vite／Rolldown 的生成助手可能没有 map；主进程、preload 和工作区源码必须有映射。 */
      const map = await readFile(`${local}.map`).catch((error) => {
        if (error.code === 'ENOENT' && path.startsWith('dist/renderer/')) return undefined;
        throw error;
      });
      if (map) {
        /** 原始 map 不做改写，损坏或指向其他脚本时直接阻止完成打包。 */
        const mapping = JSON.parse(map.toString('utf8'));
        if (mapping.version !== 3 || typeof mapping.mappings !== 'string' || !Array.isArray(mapping.sources) || (mapping.file && basename(mapping.file) !== basename(path))) throw new Error(`定位对照表无效：${path}.map`);
      }
      /** 保留包内相对路径，让同名动态脚本和工作区文件不发生覆盖。 */
      const scriptFile = `app/${path}`;
      const sourceMapFile = map ? `${scriptFile}.map` : null;
      await mkdir(dirname(join(staging, scriptFile)), { recursive: true });
      await writeFile(join(staging, scriptFile), script);
      if (map) await writeFile(join(staging, sourceMapFile), map);
      manifest.scripts.push({
        asarPath: path,
        scriptFile,
        scriptSha256: sha256(script),
        sourceMapFile,
        sourceMapSha256: map ? sha256(map) : null,
        ...(map ? {} : { sourceMapNote: '构建器未生成源码映射；请按归档脚本的实际代码位置定位。' }),
      });
    }
    if (!manifest.scripts.some((script) => script.asarPath.startsWith('dist/renderer/') && script.sourceMapFile)) throw new Error('定位文件归档缺少 Renderer 源码映射。');
    for (const path of installerPaths) {
      manifest.installers.push({ fileName: basename(path), sha256: await sha256File(path), bytes: (await stat(path)).size });
    }
    await writeFile(join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    /** 清单和全部文件完成后才发布目录，未完成的归档不会伪装成可用产物。 */
    const destination = join(symbolsRoot, basename(staging).replace(/^\.pending-/u, ''));
    await rename(staging, destination);
    return destination;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}
