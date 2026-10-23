import { activeSystemWindow } from './systemWindows.js';
import { openRegularFileNoFollow } from '@zeus/storage/platform-security';
import { BrowserWindow, dialog, ipcMain, nativeImage, protocol, shell } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, open, readFile, realpath, rm, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import {
  decodeFilePreviewText,
  filePreviewKind,
  filePreviewLimits,
  filePreviewMime,
  type FilePreviewIntent,
  type FilePreviewItem,
  type FilePreviewRequest,
  type FilePreviewSource,
  type FilePreviewRevertInput,
  type FilePreviewSaveInput,
} from '@zeus/shared';
import { ProjectSourceWorkspaceService } from './projectSourceWorkspace.js';
import type { MainCommandLedger, MainCommandRequest } from './mainCommandLedger.js';
import { getFilePreviewBlame } from '@zeus/git-core';

/** 只读媒体协议必须在 Electron 就绪前登记；不允许任意 file URL。 */
protocol.registerSchemesAsPrivileged([
  { scheme: 'zeus-preview', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
  // 源码效果预览使用独立页面源，不向 HTML 暴露主窗口或桌面桥接。
  { scheme: 'zeus-source-preview', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

/** 系统图片解码异步执行并限制超时，不阻塞主进程或调用 shell。 */
const execFileAsync = promisify(execFile);

/** 每份授权绑定发起窗口，临时历史文件随授权一起清理。 */
interface PreviewGrant {
  /** 窗口销毁时撤销所有关联资源。 */
  owner: number;
  /** 两端必须来自同一次读取，不能拼接不同文件的令牌。 */
  batch: string;
  /** 原始业务来源用于跳回所属项目，不由文件路径猜测项目。 */
  request: FilePreviewRequest;
  /** 用于重复检查文件未被替换的授权来源。 */
  source: FilePreviewSource;
  /** 原始或历史副本路径。 */
  path: string;
  /** 获取预览时的真实文件身份。 */
  identity: string;
  /** 历史读取目录，仅删除服务自身创建的目录。 */
  temporary?: string;
  /** 渲染层可见的有限描述。 */
  item: FilePreviewItem;
  /** ICNS 的只读 PNG 预览；系统操作和导出继续使用原始文件。 */
  image?: Buffer;
}

/** 验证并固定普通文件路径，阻止越界链接和 Git 内部文件泄漏。 */
async function authorizedPath(source: FilePreviewSource): Promise<string> {
  if (!source.root || !source.path) throw new Error('文件授权路径缺失。');
  /** 授权根的真实路径。 */
  const root = await realpath(source.root);
  /** 本次读取的准确文件路径。 */
  const path = await realpath(source.path);
  /** 当前子进程或授权根相对位置。 */
  const child = relative(root, path);
  if (!child || isAbsolute(child) || child === '..' || child.startsWith(`..${sep}`) || resolve(root, child) !== path || child.split(sep).includes('.git')) throw new Error('文件超出授权目录。');
  if (!(await stat(path)).isFile()) throw new Error('目标不是普通文件。');
  return path;
}

/** 固定文件身份，防止列表中的旧预览悄悄切换到新内容。 */
async function fileIdentity(path: string): Promise<string> {
  /** 文件身份信息。 */
  const info = await stat(path);
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
}

/** Git 二进制直接流入临时文件，不经字符串或主进程大缓冲区。 */
async function materializeBlob(source: FilePreviewSource, directory: string): Promise<string> {
  if (!source.root || !source.blob || !/^[a-f0-9]{40,64}$/u.test(source.blob)) throw new Error('历史对象授权无效。');
  /** 本次读取的准确文件路径。 */
  const path = join(directory, basename(source.name));
  /** 当前子进程或授权根相对位置。 */
  const child = spawn('git', ['cat-file', 'blob', source.blob], { cwd: source.root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0' } });
  /** 当前资源字节数。 */
  let size = 0;
  /** 限制长度的读取错误详情。 */
  let failure = '';
  /** 限制单次读取等待时间。 */
  const timeout = setTimeout(() => child.kill(), 30_000);
  child.stderr.on('data', (bytes: Buffer) => {
    failure = (failure + bytes.toString()).slice(-2048);
  });
  child.stdout.on('data', (bytes: Buffer) => {
    size += bytes.length;
    if (size > filePreviewLimits.historical) child.kill();
  });
  /** 等待实际 Git 子进程退出。 */
  const completion = new Promise<void>((accept, reject) => {
    child.once('error', reject);
    child.once('close', (code) => (code === 0 ? accept() : reject(new Error(size > filePreviewLimits.historical ? '历史文件超过 512 MiB 读取上限。' : failure || '历史文件读取失败。'))));
  });
  try {
    await Promise.all([pipeline(child.stdout, createWriteStream(path, { mode: 0o600, flags: 'wx' })), completion]);
  } finally {
    clearTimeout(timeout);
    child.kill();
  }
  return path;
}

/** 主进程统一提供预览、释放及用户主动的系统操作。 */
export function registerFilePreview(services: {
  /** 限定正式应用自身的受信窗口主框架。 */
  requireWindow(event: Electron.IpcMainInvokeEvent): BrowserWindow;
  /** 从业务身份解析授权，附件继续复用原有凭据检查。 */
  resolve(input: FilePreviewRequest, window: BrowserWindow): Promise<FilePreviewIntent>;
  /** 当前应用数据下独立的临时资源根。 */
  temporaryRoot: string;
  /** 文件写入沿用主进程命令回执，结果未知时禁止自动重放。 */
  commandLedger(): MainCommandLedger;
  /** 只有宿主固定的当前工作区路径能进入源码编辑页。 */
  openSource(window: BrowserWindow, target: { root: string; path: string }, request: FilePreviewRequest): Promise<void>;
}): void {
  /** 随机令牌只授予单个文件，绝不包含本地服务密钥。 */
  const grants = new Map<string, PreviewGrant>();
  /** 避免重复安装窗口销毁监听。 */
  const owners = new Set<number>();
  /** 系统快速预览随页内资源关闭。 */
  const quickLooks = new Map<number, { id: string; owner: number; window: BrowserWindow }>();

  /** 撤销令牌并删除本服务创建的历史副本。 */
  async function release(ids: string[], owner: number): Promise<void> {
    for (const id of ids) {
      /** 当前窗口持有的资源授权。 */
      const grant = grants.get(id);
      if (!grant || grant.owner !== owner) continue;
      grants.delete(id);
      for (const [windowId, preview] of quickLooks) {
        if (preview.owner !== owner || preview.id !== id) continue;
        // 多个系统预览各自释放，不能关闭另一窗口正在查看的文件。
        if (!preview.window.isDestroyed()) preview.window.closeFilePreview();
        quickLooks.delete(windowId);
      }
      if (grant.temporary) await rm(grant.temporary, { recursive: true, force: true });
    }
  }

  /** 流式请求和系统操作前再次确认授权及文件身份。 */
  async function currentPath(grant: PreviewGrant): Promise<string> {
    /** 本次读取的准确文件路径。 */
    const path = grant.temporary ? grant.path : await authorizedPath(grant.source);
    if (path !== grant.path || (await fileIdentity(path)) !== grant.identity) throw new Error('文件已变化，请刷新预览。');
    return path;
  }

  /** 协议只接受活动令牌和 GET/HEAD，分段响应支持 PDF 与媒体拖动。 */
  protocol.handle('zeus-preview', async (request) => {
    /** 只向自身文件窗口或明确配置的开发页面开放读取，不使用通配来源。 */
    const origin = request.headers.get('origin');
    /** 开发入口只接受配置中的精确来源。 */
    const developmentOrigin = process.env.ZEUS_DEV_SERVER_URL ? new URL(process.env.ZEUS_DEV_SERVER_URL).origin : '';
    /** 不向任意网页开放资源读取。 */
    const cors: Record<string, string> = origin === 'file://' || (origin && origin === developmentOrigin) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};
    try {
      /** 只含资源令牌的协议地址。 */
      const url = new URL(request.url);
      /** 当前窗口持有的资源授权。 */
      const grant = grants.get(url.hostname);
      if (!grant || !['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 404, headers: cors });
      /** 本次读取的准确文件路径。 */
      const path = await currentPath(grant);
      /** 当前资源字节数。 */
      const size = grant.image?.byteLength ?? grant.item.byteLength;
      /** 媒体播放器请求的字节范围。 */
      const range = request.headers.get('range');
      /** 本次响应起始字节。 */
      let start = 0;
      /** 本次响应末尾字节。 */
      let end = size - 1;
      if (range) {
        /** 严格解析后的范围或对象记录。 */
        const match = /^bytes=(\d*)-(\d*)$/u.exec(range);
        if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416, headers: { ...cors, 'Content-Range': `bytes */${size}` } });
        start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
        end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return new Response(null, { status: 416, headers: { ...cors, 'Content-Range': `bytes */${size}` } });
      }
      /** 仅允许受限内容与不缓存响应。 */
      const headers = {
        'Content-Type': grant.image ? 'image/png' : grant.item.mime,
        'Content-Length': String(Math.max(0, end - start + 1)),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': grant.item.kind === 'pdf' ? "default-src 'none'; object-src 'self'" : "default-src 'none'; sandbox",
        ...cors,
        ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
      };
      if (request.method === 'HEAD' || !size) return new Response(null, { status: range ? 206 : 200, headers });
      if (grant.image) return new Response(new Uint8Array(grant.image.subarray(start, end + 1)), { status: range ? 206 : 200, headers });
      /** 本次读取拥有的文件句柄。 */
      const handle = await openRegularFileNoFollow(path, constants.O_RDONLY);
      /** 已打开文件的身份信息。 */
      const opened = await handle.stat();
      if (`${opened.dev}:${opened.ino}:${opened.size}:${opened.mtimeMs}:${opened.ctimeMs}` !== grant.identity) {
        await handle.close();
        throw new Error('文件已变化。');
      }
      /** 当前请求独立的只读文件流。 */
      const stream = handle.createReadStream({ start, end, autoClose: true });
      request.signal.addEventListener('abort', () => stream.destroy(), { once: true });
      return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { status: range ? 206 : 200, headers });
    } catch {
      return new Response('文件已不可用，请刷新预览。', { status: 410, headers: cors });
    }
  });

  /** 加载与区块撤销后的刷新共享同一授权及解码链路。 */
  async function loadPreview(input: FilePreviewRequest, window: BrowserWindow): Promise<FilePreviewItem[]> {
    /** 一次读取固定两端关系。 */
    const batch = randomUUID();
    if (!owners.has(window.id)) {
      owners.add(window.id);
      window.once('closed', () => {
        owners.delete(window.id);
        void release([...grants.keys()], window.id);
      });
    }
    /** 由业务身份解析出的文件读取授权。 */
    const intent = await services.resolve(input, window);
    /** 文件数固定为一份或前后两份，避免批量预加载。 */
    const items = await Promise.all(
      intent.sides.slice(0, 2).map(async (source): Promise<FilePreviewItem> => {
        /** 当前已授权的文件描述。 */
        const item: FilePreviewItem = { id: '', name: source.name, label: source.label, kind: 'unavailable', mime: filePreviewMime(source.name), byteLength: 0, review: source.review, missing: source.missing };
        /** 本次资源专属临时目录。 */
        let temporary: string | undefined;
        /** 解码内容绑定本次授权，释放时随授权回收。 */
        let image: Buffer | undefined;
        try {
          if (source.reason) return { ...item, reason: source.reason };
          if (source.blob || source.sha256) {
            await mkdir(services.temporaryRoot, { recursive: true, mode: 0o700 });
            temporary = await mkdtemp(join(services.temporaryRoot, 'preview-'));
          }
          /** 本次读取的准确文件路径。 */
          const path = temporary && source.blob ? await materializeBlob(source, temporary) : await authorizedPath(source);
          /** 轮次快照也使用独立副本，系统应用不能修改恢复证据。 */
          let previewPath = path;
          if (temporary && source.sha256) {
            previewPath = join(temporary, basename(source.name));
            if ((await stat(path)).size > filePreviewLimits.historical) throw new Error('历史快照超过读取上限。');
            await copyFile(path, previewPath, constants.COPYFILE_EXCL);
            /** 快照完整性检查摘要。 */
            const hash = createHash('sha256');
            for await (const bytes of createReadStream(previewPath)) hash.update(bytes);
            if (hash.digest('hex') !== source.sha256) throw new Error('历史快照校验失败。');
          }
          /** 读取前固定的文件身份。 */
          const identity = await fileIdentity(previewPath);
          item.byteLength = (await stat(previewPath)).size;
          item.kind = filePreviewKind(item.mime);
          /** 浏览器不能直接显示的常见图片复用系统只读转码。 */
          const convertImage = ['image/icns', 'image/heic', 'image/heif', 'image/tiff'].includes(item.mime);
          if (convertImage && process.platform === 'darwin' && item.byteLength <= filePreviewLimits.image) {
            try {
              /** 只接受头部和声明长度一致的 ICNS 容器，拒绝误标的其他格式。 */
              const header = Buffer.alloc(8);
              /** 有界读取后立即释放句柄，不持有原始图标文件。 */
              const handle = await open(previewPath, 'r');
              try {
                await handle.read(header, 0, header.length, 0);
              } finally {
                await handle.close();
              }
              if (item.mime === 'image/icns' && (item.byteLength <= header.length || header.toString('ascii', 0, 4) !== 'icns' || header.readUInt32BE(4) !== item.byteLength)) throw new Error('无效的 ICNS 文件头。');
              await mkdir(services.temporaryRoot, { recursive: true, mode: 0o700 });
              /** 解码临时文件只属于本次转换，读取完成后立即清理。 */
              const directory = await mkdtemp(join(services.temporaryRoot, 'icon-'));
              try {
                /** sips 实际解码图标内容，避免 Quick Look 为损坏文件生成通用图标。 */
                const pngPath = join(directory, 'preview.png');
                await execFileAsync('/usr/bin/sips', ['-s', 'format', 'png', '-Z', '1024', previewPath, '--out', pngPath], { timeout: 15_000, maxBuffer: 16 * 1024 });
                if ((await stat(pngPath)).size > filePreviewLimits.image) throw new Error('解码图片超过预览上限。');
                image = await readFile(pngPath);
              } finally {
                await rm(directory, { recursive: true, force: true });
              }
              item.kind = 'image';
            } catch {
              item.kind = 'system';
              item.reason = '此图片无法转换为页内预览，请用系统应用打开原文件。';
            }
          }
          /** 大文本只读取前 2 MiB；无法解码时保留系统操作和编码选择。 */
          if (item.mime === 'application/octet-stream' || item.mime === 'image/svg+xml') {
            /** 文件正文读取始终受限，不随大文件大小分配缓冲区。 */
            const chunks: Buffer[] = [];
            for await (const chunk of createReadStream(previewPath, { start: 0, end: filePreviewLimits.text - 1 })) chunks.push(chunk as Buffer);
            /** 有界片段用于只读解码，不能进入源码保存路径。 */
            const bytes = Buffer.concat(chunks);
            try {
              const decoded = decodeFilePreviewText(bytes, input.textEncoding, item.byteLength > bytes.length);
              item.content = decoded.content;
              item.encoding = decoded.encoding;
              item.truncated = item.byteLength > bytes.length;
              if (item.truncated) item.reason = '只读预览前 2 MiB 内容；请用外部编辑器查看完整文件。';
              if (item.kind === 'system') {
                item.kind = 'text';
                item.mime = 'text/plain';
              }
            } catch {
              item.reason = input.textEncoding ? '无法按所选编码读取文本。请检查编码，或用系统应用打开。' : '此文件不是可识别的 Unicode 文本。可选择其他预览编码，或用系统应用打开。';
            }
          }
          if (item.kind === 'pdf') {
            /** 本次读取拥有的文件句柄。 */
            const handle = await open(previewPath, 'r');
            try {
              /** 用于检查 PDF 的有限文件头。 */
              const header = Buffer.alloc(5);
              await handle.read(header, 0, 5, 0);
              if (header.toString() !== '%PDF-') {
                item.kind = 'system';
                item.reason = 'PDF 文件头无效，无法页内预览。';
              }
            } finally {
              await handle.close();
            }
          }
          if (convertImage && process.platform === 'win32' && item.byteLength <= filePreviewLimits.image) {
            try {
              /** Windows 使用已安装的系统缩略图解码器，不把通用文件图标当作图片正文。 */
              const thumbnail = await nativeImage.createThumbnailFromPath(previewPath, { width: 1024, height: 1024 });
              if (thumbnail.isEmpty()) throw new Error('系统未返回图片内容。');
              /** Windows 只按宽度缩放，长图在编码前再限制两边尺寸。 */
              const size = thumbnail.getSize();
              /** 保留原图比例，避免长图占用无界 PNG 缓冲区。 */
              const scale = Math.min(1, 1024 / Math.max(size.width, size.height));
              image = (scale < 1 ? thumbnail.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) }) : thumbnail).toPNG();
              if (image.byteLength > filePreviewLimits.image) throw new Error('解码图片超过预览上限。');
              item.kind = 'image';
            } catch {
              image = undefined;
              item.kind = 'system';
              item.reason = 'Windows 无法解码此图片，请用系统应用打开原文件。';
            }
          }
          if (item.kind === 'image' && item.byteLength > filePreviewLimits.image) {
            item.kind = 'system';
            item.reason = '图片超过 16 MiB 页内预览上限。';
          }
          if (item.kind === 'system' && !item.reason)
            item.reason =
              item.mime === 'application/octet-stream' && item.byteLength > filePreviewLimits.text
                ? '请用系统应用打开此文件；文本页内读取上限为 2 MiB。'
                : item.mime === 'image/icns' && item.byteLength > filePreviewLimits.image
                  ? '图标超过 16 MiB 页内预览上限，请用系统应用打开。'
                  : '请用系统应用打开此格式。';
          // Git 差异沿用随正文读取的归属；普通文件仍通过版本令牌按需读取。
          if (source.git && (source.blob || source.git.baseRef !== undefined) && item.content !== undefined && !item.truncated) {
            try {
              /** 使用已授权原文件保留 BOM 和换行，其他编码不冒充 UTF-8 工作区归属。 */
              if (item.encoding !== 'utf-8' && !source.git.ref) throw new Error('此编码的工作区文本暂不提供逐行提交归属。');
              item.blame = (await getFilePreviewBlame(source.git, previewPath)).lines;
            } catch (error) {
              item.blameError = error instanceof Error ? error.message : '读取提交归属失败。';
            }
          }
          if ((await fileIdentity(previewPath)) !== identity) throw new Error('读取期间文件发生变化，请刷新。');
          if (source.edit && item.kind === 'text') {
            try {
              // 先核对当前文件存在且仍在工作区内，历史不存在的一侧不伪造编辑目标。
              await authorizedPath({ ...source.edit, name: source.name, label: source.label });
              item.canEdit = true;
            } catch {
              item.canEdit = false;
            }
          }
          item.id = randomUUID();
          if (['image', 'pdf', 'audio', 'video'].includes(item.kind)) item.url = `zeus-preview://${item.id}/${encodeURIComponent(basename(source.name))}`;
          grants.set(item.id, { owner: window.id, batch, request: input, source, path: previewPath, temporary, identity, item, image });
          return item;
        } catch (error) {
          if (temporary) await rm(temporary, { recursive: true, force: true });
          return {
            ...item,
            id: '',
            kind: 'unavailable',
            missing: error instanceof Error && 'code' in error && error.code === 'ENOENT',
            reason:
              error instanceof Error && 'code' in error && error.code === 'ENOENT'
                ? '此版本中不存在该文件。'
                : error instanceof Error && 'code' in error && error.code === 'EACCES'
                  ? '没有权限读取此文件。'
                  : error instanceof Error
                    ? error.message
                    : '文件读取失败。',
          };
        }
      }),
    );
    if (window.isDestroyed())
      await release(
        items.map((item) => item.id),
        window.id,
      );
    /** 真实工作区正文开放页内编辑，完整旧版配对后再开放逐块恢复。 */
    const before = items[0];
    const after = items[1];
    const target = after?.id ? grants.get(after.id) : undefined;
    if (
      target &&
      after?.canEdit &&
      after.encoding === 'utf-8' &&
      !after.truncated &&
      !target.temporary &&
      target.source.edit &&
      !target.source.blob &&
      !target.source.sha256 &&
      target.source.edit.path === target.source.path &&
      (await lstat(target.source.path).catch(() => null))?.isSymbolicLink() === false &&
      // 混合换行和仅 CR 文件继续交给源码编辑，避免恢复一块时规范化其他行。
      !/\r(?!\n)/u.test(after.content ?? '') &&
      !((after.content ?? '').includes('\r\n') && /(?<!\r)\n/u.test(after.content ?? ''))
    ) {
      after.canEditInline = true;
      after.canRevert = Boolean(before?.id && before.kind === 'text' && before.encoding === 'utf-8' && !before.truncated);
    }
    return items;
  }

  ipcMain.handle('zeus:file-preview:load', (event, input: FilePreviewRequest) => loadPreview(input, services.requireWindow(event)));

  /** 同一文件的页内保存和区块恢复共用写锁，跨窗口也不能并发覆盖。 */
  const reverting = new Set<string>();
  ipcMain.handle('zeus:file-preview:revert-block', (event, request: MainCommandRequest<FilePreviewRevertInput>) => {
    /** 命令执行前固定发起窗口。 */
    const window = services.requireWindow(event);
    return services.commandLedger().execute(request, 'desktop.file_preview.revert_block', async (input, command) => {
      /** 两个令牌必须属于当前窗口、同一次加载及可写工作区版本。 */
      const before = grants.get(input?.beforeId);
      const after = grants.get(input?.afterId);
      if (!before || !after || before.owner !== window.id || after.owner !== window.id || before.batch !== after.batch || before === after || !after.item.canRevert || !after.source.edit) throw new Error('区块恢复授权已失效，请刷新差异。');
      if (![input.oldStart, input.oldLines, input.newStart, input.newLines].every((value) => Number.isSafeInteger(value) && value >= 0) || input.oldLines + input.newLines === 0) throw new Error('区块行范围无效。');
      /** 保留行尾终止符，使文件末尾的换行状态参与恢复。 */
      const oldLines = before.item.content!.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
      const newLines = after.item.content!.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
      if (input.oldStart + input.oldLines > oldLines.length || input.newStart + input.newLines > newLines.length) throw new Error('区块超出文件范围。');
      /** 替换内容只从已授权的旧版取得，当前版其他行保持原样。 */
      const replacement = oldLines.slice(input.oldStart, input.oldStart + input.oldLines).join('');
      if (replacement === newLines.slice(input.newStart, input.newStart + input.newLines).join('')) throw new Error('此区块没有可恢复的差异。');
      const path = await currentPath(after);
      await currentPath(before);
      if (reverting.has(path)) throw new Error('此文件正在恢复区块，请等待完成。');
      reverting.add(path);
      try {
        /** 保存复用源码服务的目录边界、编码、摘要冲突及原子替换规则。 */
        const root = await realpath(after.source.edit.root);
        const relativePath = relative(root, path).split(sep).join('/');
        const workspace = new ProjectSourceWorkspaceService({
          loadProjectRoot: async () => root,
          trashItem: async () => {
            throw new Error('区块恢复不能删除文件。');
          },
        });
        const document = await workspace.readFile('preview', relativePath);
        if (!document.editable || document.content !== after.item.content!.replace(/\r\n?|\n/gu, '\n')) throw new Error('工作区文件已变化或不可编辑，请刷新差异。');
        newLines.splice(input.newStart, input.newLines, replacement);
        await workspace.saveFile({ projectId: 'preview', relativePath, content: newLines.join(''), eol: document.eol, hasBom: document.hasBom, expectedRevision: document.revision }, async () => {
          await currentPath(after);
          await currentPath(before);
          await command.markWriteStarted();
        });
        /** 返回新授权与新正文；旧令牌仍由原预览生命周期统一释放。 */
        return await loadPreview(after.request, window);
      } finally {
        reverting.delete(path);
      }
    });
  });

  /** 页内编辑按读取时的授权版本保存，不能将历史副本或任意路径作为目标。 */
  ipcMain.handle('zeus:file-preview:save', (event, request: MainCommandRequest<FilePreviewSaveInput>) => {
    /** 保存始终绑定受信发起窗口。 */
    const window = services.requireWindow(event);
    return services.commandLedger().execute(request, 'desktop.file_preview.save', async (input, command) => {
      /** 写入能力只来自主进程登记的当前正文。 */
      const grant = grants.get(input?.id);
      if (!grant || grant.owner !== window.id || !grant.item.canEditInline || !grant.source.edit) throw new Error('文件编辑授权已失效，请刷新差异。');
      if (typeof input.content !== 'string' || Buffer.byteLength(input.content, 'utf8') > filePreviewLimits.text || input.content.includes('\0')) throw new Error('只支持不超过 2 MiB 的文本正文。');
      /** 新旧正文先通过身份检查，再进入共享写锁。 */
      const path = await currentPath(grant);
      if (reverting.has(path)) throw new Error('此文件正在保存，请等待完成。');
      reverting.add(path);
      try {
        /** 使用源码服务已有的路径、摘要冲突、编码及原子替换规则。 */
        const root = await realpath(grant.source.edit.root);
        const relativePath = relative(root, path).split(sep).join('/');
        const workspace = new ProjectSourceWorkspaceService({
          loadProjectRoot: async () => root,
          trashItem: async () => {
            throw new Error('页内编辑不能删除文件。');
          },
        });
        const document = await workspace.readFile('preview', relativePath);
        if (!document.editable || document.content !== grant.item.content!.replace(/\r\n?|\n/gu, '\n')) throw new Error('文件已变化或不可编辑，请刷新差异。');
        await workspace.saveFile({ projectId: 'preview', relativePath, content: input.content, eol: document.eol, hasBom: document.hasBom, expectedRevision: document.revision }, async () => {
          await currentPath(grant);
          await command.markWriteStarted();
        });
        return await loadPreview(grant.request, window);
      } finally {
        reverting.delete(path);
      }
    });
  });

  ipcMain.handle('zeus:file-preview:release', (event, ids: unknown) => {
    /** 发起操作的受信窗口。 */
    const window = services.requireWindow(event);
    return release(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [], window.id);
  });

  ipcMain.handle('zeus:file-preview:blame', async (event, id: string) => {
    /** 归属读取只能使用当前窗口持有的版本令牌。 */
    const window = services.requireWindow(event);
    /** 查不到授权、截断文本和未记录 Git 身份的快照都不能借用其他版本。 */
    const grant = grants.get(id);
    if (!grant || grant.owner !== window.id) throw new Error('预览授权已失效。');
    if (!grant.source.git || grant.item.truncated || grant.item.encoding !== 'utf-8') return null;
    /** 读取前后均验证预览文件身份，防止磁盘变更导致归属错行。 */
    const path = await currentPath(grant);
    // 已随正文读取的归属绑定同一授权文件，复用结果避免重复启动 Git。
    if (grant.item.blame !== undefined) return { path: grant.source.git.path, lines: grant.item.blame };
    if (grant.item.blameError) throw new Error(grant.item.blameError);
    /** 复用 Git Core 的跨平台进程管理。 */
    const result = await getFilePreviewBlame(grant.source.git, path);
    await currentPath(grant);
    return result;
  });

  ipcMain.handle('zeus:file-preview:action', async (event, id: string, action: 'quick-look' | 'open' | 'reveal' | 'export' | 'edit') => {
    /** 发起操作的受信窗口。 */
    const window = services.requireWindow(event);
    /** 读取期间切换焦点不改变原来发起操作的预览窗口。 */
    const previewWindow = activeSystemWindow(window);
    /** 当前窗口持有的资源授权。 */
    const grant = grants.get(id);
    if (!grant || grant.owner !== window.id) throw new Error('预览授权已失效。');
    if (action === 'edit') {
      if (!grant.item.canEdit || !grant.source.edit) throw new Error('此文件没有可编辑的工作区版本。');
      /** 编辑读取最新工作区文件，历史副本只负责提供受信的目标身份。 */
      const path = await authorizedPath({ ...grant.source.edit, name: grant.item.name, label: grant.item.label });
      await services.openSource(window, { root: await realpath(grant.source.edit.root), path }, grant.request);
      return;
    }
    /** 本次读取的准确文件路径。 */
    const path = await currentPath(grant);
    if (action === 'quick-look') {
      if (process.platform !== 'darwin') throw new Error('当前系统不支持快速预览，请选择打开文件。');
      quickLooks.set(previewWindow.id, { id, owner: window.id, window: previewWindow });
      previewWindow.previewFile(path, grant.item.name);
    } else if (action === 'reveal') shell.showItemInFolder(path);
    else if (action === 'open') {
      /** 本次操作的可见错误。 */
      const error = await shell.openPath(path);
      if (error) throw new Error(error);
    } else if (action === 'export') {
      /** 用户操作的实际结果。 */
      const result = await dialog.showSaveDialog(previewWindow, { defaultPath: basename(grant.item.name), title: '导出此版本文件' });
      if (!result.canceled && result.filePath) await copyFile(path, result.filePath);
    } else throw new Error('文件预览操作无效。');
  });
}
