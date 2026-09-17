import { BrowserWindow, dialog, ipcMain, protocol, shell } from 'electron';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, open, readFile, realpath, rm, stat } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { filePreviewKind, filePreviewLimits, filePreviewMime, type FilePreviewIntent, type FilePreviewItem, type FilePreviewRequest, type FilePreviewSource } from '@zeus/shared';

/** 只读媒体协议必须在 Electron 就绪前登记；不允许任意 file URL。 */
protocol.registerSchemesAsPrivileged([{ scheme: 'zeus-preview', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);

/** 每份授权绑定发起窗口，临时历史文件随授权一起清理。 */
interface PreviewGrant {
  /** 窗口销毁时撤销所有关联资源。 */
  owner: number;
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
  if (!child || child === '..' || child.startsWith(`..${sep}`) || resolve(root, child) !== path || child.split(sep).includes('.git')) throw new Error('文件超出授权目录。');
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
  resolve(input: FilePreviewRequest): Promise<FilePreviewIntent>;
  /** 当前应用数据下独立的临时资源根。 */
  temporaryRoot: string;
}): void {
  /** 随机令牌只授予单个文件，绝不包含本地服务密钥。 */
  const grants = new Map<string, PreviewGrant>();
  /** 避免重复安装窗口销毁监听。 */
  const owners = new Set<number>();
  /** 系统快速预览随页内资源关闭。 */
  const quickLooks = new Map<number, string>();

  /** 撤销令牌并删除本服务创建的历史副本。 */
  async function release(ids: string[], owner: number): Promise<void> {
    for (const id of ids) {
      /** 当前窗口持有的资源授权。 */
      const grant = grants.get(id);
      if (!grant || grant.owner !== owner) continue;
      grants.delete(id);
      if (quickLooks.get(owner) === id) {
        BrowserWindow.fromId(owner)?.closeFilePreview();
        quickLooks.delete(owner);
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
      const size = grant.item.byteLength;
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
        'Content-Type': grant.item.mime,
        'Content-Length': String(Math.max(0, end - start + 1)),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': grant.item.kind === 'pdf' ? "default-src 'none'; object-src 'self'" : "default-src 'none'; sandbox",
        ...cors,
        ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
      };
      if (request.method === 'HEAD' || !size) return new Response(null, { status: range ? 206 : 200, headers });
      /** 本次读取拥有的文件句柄。 */
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
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

  ipcMain.handle('zeus:file-preview:load', async (event, input: FilePreviewRequest) => {
    /** 发起操作的受信窗口。 */
    const window = services.requireWindow(event);
    if (!owners.has(window.id)) {
      owners.add(window.id);
      window.once('closed', () => {
        owners.delete(window.id);
        void release([...grants.keys()], window.id);
      });
    }
    /** 由业务身份解析出的文件读取授权。 */
    const intent = await services.resolve(input);
    /** 文件数固定为一份或前后两份，避免批量预加载。 */
    const items = await Promise.all(
      intent.sides.slice(0, 2).map(async (source): Promise<FilePreviewItem> => {
        /** 当前已授权的文件描述。 */
        const item: FilePreviewItem = { id: '', name: source.name, label: source.label, kind: 'unavailable', mime: filePreviewMime(source.name), byteLength: 0, review: source.review };
        /** 本次资源专属临时目录。 */
        let temporary: string | undefined;
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
          /** 小内容严格解码；PDF 校验文件头，避免把错误页面当成阅读器。 */
          if (item.byteLength <= filePreviewLimits.text) {
            /** 受大小限制的原始文件内容。 */
            const bytes = await readFile(previewPath);
            if ((item.mime === 'application/octet-stream' || item.mime === 'image/svg+xml') && bytes.length <= filePreviewLimits.text) {
              try {
                if (bytes.includes(0)) throw new Error('binary');
                item.content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
                if (item.kind === 'system') {
                  item.kind = 'text';
                  item.mime = 'text/plain';
                }
              } catch {
                item.reason = '此文件不是有效的 UTF-8 文本，请使用系统预览。';
              }
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
          if (item.kind === 'image' && item.byteLength > filePreviewLimits.image) {
            item.kind = 'system';
            item.reason = '图片超过 16 MiB 页内预览上限。';
          }
          if (item.kind === 'system' && !item.reason) item.reason = item.byteLength > filePreviewLimits.text ? '此文件使用系统预览；文本页内读取上限为 2 MiB。' : '此格式使用系统预览。';
          if ((await fileIdentity(previewPath)) !== identity) throw new Error('读取期间文件发生变化，请刷新。');
          item.id = randomUUID();
          if (['image', 'pdf', 'audio', 'video'].includes(item.kind)) item.url = `zeus-preview://${item.id}/${encodeURIComponent(basename(source.name))}`;
          grants.set(item.id, { owner: window.id, source, path: previewPath, temporary, identity, item });
          return item;
        } catch (error) {
          if (temporary) await rm(temporary, { recursive: true, force: true });
          return {
            ...item,
            id: '',
            kind: 'unavailable',
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
    return items;
  });

  ipcMain.handle('zeus:file-preview:release', (event, ids: unknown) => {
    /** 发起操作的受信窗口。 */
    const window = services.requireWindow(event);
    return release(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [], window.id);
  });

  ipcMain.handle('zeus:file-preview:action', async (event, id: string, action: 'quick-look' | 'open' | 'reveal' | 'export') => {
    /** 发起操作的受信窗口。 */
    const window = services.requireWindow(event);
    /** 当前窗口持有的资源授权。 */
    const grant = grants.get(id);
    if (!grant || grant.owner !== window.id) throw new Error('预览授权已失效。');
    /** 本次读取的准确文件路径。 */
    const path = await currentPath(grant);
    if (action === 'quick-look') {
      if (process.platform !== 'darwin') throw new Error('当前系统不支持快速预览，请选择打开文件。');
      quickLooks.set(window.id, id);
      window.previewFile(path, grant.item.name);
    } else if (action === 'reveal') shell.showItemInFolder(path);
    else if (action === 'open') {
      /** 本次操作的可见错误。 */
      const error = await shell.openPath(path);
      if (error) throw new Error(error);
    } else if (action === 'export') {
      /** 用户操作的实际结果。 */
      const result = await dialog.showSaveDialog(window, { defaultPath: basename(grant.item.name), title: '导出此版本文件' });
      if (!result.canceled && result.filePath) await copyFile(path, result.filePath);
    } else throw new Error('文件预览操作无效。');
  });
}
