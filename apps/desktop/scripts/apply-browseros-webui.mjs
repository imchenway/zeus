#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { browserOsUpstream } from '../browseros/upstream.mjs';
import { webUiOverlayInputs } from '../browseros/webui-overlay.mjs';

/** 覆盖包由同一工作区内的构建命令产生。 */
const overlayRoot = resolve(import.meta.dirname, '../dist/browseros-webui');
/** 只接受明确提供的 Chromium 源码目录，不猜测或修改已有浏览器安装。 */
const argumentsList = process.argv.slice(2);
if (argumentsList.length !== 2 || argumentsList[0] !== '--chromium-src') throw new Error('请指定 --chromium-src <已应用 BrowserOS 补丁的 Chromium 源码目录>。');
/** 使用真实根目录，后续所有路径必须在其中且不含符号链接。 */
const sourceRoot = await realpath(resolve(argumentsList[1]));
/** 实际 checkout 必须是固定 Chromium 根仓库，而不是它的子目录或其他项目。 */
const gitRoot = await realpath(execFileSync('git', ['-C', sourceRoot, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim());
if (gitRoot !== sourceRoot) throw new Error('必须指定 Chromium Git 仓库根目录。');
/** 已应用的 BrowserOS 补丁保持为工作区修改；不能用另一个提交代替固定基线。 */
const revision = execFileSync('git', ['-C', sourceRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (revision !== browserOsUpstream.chromiumRevision) throw new Error('Chromium HEAD 与固定基线不一致。');
/** 原生覆盖包拥有的新增目录。 */
const nativePrefix = 'chrome/browser/ui/webui/zeus/';
/** 只允许替换预登记的四个构建文件。 */
const existingPaths = new Set(webUiOverlayInputs.map((input) => input.path));

/** 内容身份用于阻止覆盖用户或其他任务的修改。 */
function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** 检查目的路径边界，同时拒绝目录穿越、盘符和符号链接。 */
async function safePath(root, path) {
  if (!/^[A-Za-z0-9_./-]+$/u.test(path) || path.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error(`非法相对路径：${path}`);
  /** 逐级定位，已有祖先只能是普通目录。 */
  let current = root;
  for (const part of path.split('/')) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error(`拒绝符号链接路径：${path}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return current;
}

/** 可选文件仅在不存在时返回空值，不吞掉权限或读取失败。 */
async function readOptional(path) {
  try {
    return await readFile(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return null;
  }
}

/** 清单只允许同一上游、固定接入点及本包自有原生文件。 */
function validateManifest(manifest) {
  if (manifest.artifactKind !== 'browseros-webui-source-overlay' || JSON.stringify(manifest.upstream) !== JSON.stringify(browserOsUpstream) || !Array.isArray(manifest.files)) throw new Error('覆盖包身份或固定上游不一致。');
  /** 重复路径会使覆盖顺序产生歧义，必须拒绝。 */
  const seen = new Set();
  for (const file of manifest.files) {
    if (typeof file.path !== 'string' || seen.has(file.path) || (!existingPaths.has(file.path) && !file.path.startsWith(nativePrefix)) || !/^[a-f0-9]{64}$/u.test(file.sha256) || !Number.isSafeInteger(file.byteLength) || file.byteLength < 0)
      throw new Error('覆盖包含无效或越界文件。');
    if (existingPaths.has(file.path) ? !/^[a-f0-9]{64}$/u.test(file.beforeSha256) : file.beforeSha256 !== null) throw new Error('覆盖包的原始文件身份无效。');
    seen.add(file.path);
  }
  if ([...existingPaths].some((path) => !seen.has(path))) throw new Error('覆盖包缺少必要的构建接入点。');
}

/** 对同一 checkout 的写入串行进行；中断遗留的锁不自动删除。 */
const lockPath = join(sourceRoot, '.zeus-webui-overlay.lock');
await writeFile(lockPath, `${process.pid}\n`, { flag: 'wx' });
try {
  /** 收据只证明文件复制完成，不代表 GN、C++ 编译或应用运行通过。 */
  const receiptPath = await safePath(sourceRoot, '.zeus-webui-overlay.json');
  /** 前次成功接入的文件身份用于安全更新本包拥有的资源。 */
  const priorBytes = await readOptional(receiptPath);
  /** 当前构建包清单须与磁盘实际字节共同核对。 */
  const manifest = JSON.parse(await readFile(await safePath(overlayRoot, 'overlay-manifest.json')));
  validateManifest(manifest);
  /** 没有收据时只允许初次接入或同内容的中断恢复。 */
  const prior = priorBytes ? JSON.parse(priorBytes) : null;
  if (prior) validateManifest(prior);
  /** 前次自有文件与当前候选必须按路径一一比较。 */
  const previous = new Map(prior?.files.map((file) => [file.path, file]) ?? []);
  /** 所有写入先预检，防止遇到后面的冲突时已覆盖前面的文件。 */
  const writes = [];
  for (const file of manifest.files) {
    /** 输出完整性检查覆盖每个原生文件和页面资源。 */
    const bytes = await readFile(await safePath(overlayRoot, file.path));
    if (digest(bytes) !== file.sha256 || bytes.length !== file.byteLength) throw new Error(`覆盖包文件摘要不符：${file.path}`);
    /** 已有内容只允许原始 BrowserOS、前次本包或本次相同内容。 */
    const target = await safePath(sourceRoot, file.path);
    /** 缺失的原始构建文件不能由覆盖包凭空创建。 */
    const current = await readOptional(target);
    if (!current && file.beforeSha256) throw new Error(`Chromium 缺少原始文件：${file.path}`);
    if (current && ![file.sha256, file.beforeSha256, previous.get(file.path)?.sha256].includes(digest(current))) throw new Error(`文件存在未登记修改，停止覆盖：${file.path}`);
    if (!current || digest(current) !== file.sha256) writes.push({ target, bytes });
    previous.delete(file.path);
  }
  /** 仅清理前次收据拥有且当前已移除的资源，不能删除未知文件。 */
  const removals = [];
  for (const file of previous.values()) {
    if (!file.path.startsWith(nativePrefix)) throw new Error('不能移除原有 Chromium 构建入口。');
    /** 过期资源也必须保持前次内容身份才允许移除。 */
    const target = await safePath(sourceRoot, file.path);
    /** 用户修改过的旧资源同样阻止整个接入。 */
    const current = await readOptional(target);
    if (current && digest(current) !== file.sha256) throw new Error(`过期资源存在未登记修改：${file.path}`);
    if (current) removals.push(target);
  }
  /** 同目录临时文件避免写到一半留下损坏内容；不承诺跨文件事务。 */
  async function replaceFile(path, bytes) {
    await mkdir(dirname(path), { recursive: true });
    /** 独占临时名称仅供本次原子替换使用。 */
    const temporary = `${path}.zeus-${randomUUID()}`;
    try {
      await writeFile(temporary, bytes, { flag: 'wx' });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  for (const write of writes) await replaceFile(write.target, write.bytes);
  for (const path of removals) await rm(path);
  await replaceFile(receiptPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`已写入 ${writes.length} 个文件，清理 ${removals.length} 个旧资源；尚未执行原生编译或运行。`);
} finally {
  await rm(lockPath, { force: true });
}
