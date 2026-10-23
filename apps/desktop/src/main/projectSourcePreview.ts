import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { openRegularFileNoFollow } from '@zeus/storage/platform-security';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { filePreviewLimits, filePreviewMime, projectSourcePreviewKind, type ProjectSourcePreviewGrant, type ProjectSourcePreviewRequest } from '@zeus/shared';

/** 只向页面提供已知的静态资源，不把目录浏览或任意文件读取作为预览能力。 */
const resourceMimeTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.xhtml': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};

/** 草稿只保存在当前窗口的预览生命周期中。 */
interface SourcePreviewGrant extends ProjectSourcePreviewGrant {
  /** 发起预览的受信窗口。 */
  owner: number;
  /** 主进程解析后的准确项目根。 */
  root: string;
  /** 当前草稿对应的项目相对文件。 */
  path: string;
  /** 当前草稿，不写入文件系统。 */
  content: string;
}

/** 主进程与隔离浏览器检查共用同一份资源读取实现。 */
export class ProjectSourcePreviewService {
  /** 每个授权都绑定窗口，关闭窗口时统一撤销。 */
  private readonly grants = new Map<string, SourcePreviewGrant>();

  /** 地址与 CSP 来源由宿主配置，渲染器不能指定。 */
  constructor(
    private readonly services: {
      /** 继续使用已有项目身份解析。 */
      loadProjectRoot(projectId: string): Promise<string>;
      /** 验证宿主可提供独立 HTTP 地址，桌面使用专用协议。 */
      resourceUrl?(id: string, path: string): string;
      /** 精确资源来源，桌面只允许专用协议。 */
      resourceSource?: string;
    },
  ) {}

  /** 校验项目文件后创建草稿授权；不接受未保存到项目的任意路径。 */
  async prepare(owner: number, input: ProjectSourcePreviewRequest): Promise<ProjectSourcePreviewGrant> {
    if (!input || typeof input.projectId !== 'string' || typeof input.relativePath !== 'string' || typeof input.content !== 'string' || !projectSourcePreviewKind(input.relativePath)) throw new Error('此文件不支持效果预览。');
    if (Buffer.byteLength(input.content, 'utf8') > filePreviewLimits.text) throw new Error('文件超过 2 MiB 效果预览上限。');
    /** 根目录只由项目服务解析。 */
    const root = await realpath(await this.services.loadProjectRoot(input.projectId));
    /** 文件真实路径仍须位于项目根内。 */
    const path = await this.authorizedPath(root, input.relativePath);
    if ((await stat(path)).size > filePreviewLimits.text) throw new Error('文件超过 2 MiB 效果预览上限。');
    /** URL 保留项目相对目录，让样式、脚本和图片按原位置解析。 */
    const normalized = relative(root, path).split(sep).join('/');
    /** 不可猜测授权身份。 */
    const id = randomUUID();
    /** 逐段编码避免文件名中的空格、井号改变 URL。 */
    const encoded = normalized.split('/').map(encodeURIComponent).join('/');
    /** 宿主只替换传输地址，不改变资源权限。 */
    const url = this.services.resourceUrl?.(id, encoded) ?? `zeus-source-preview://${id}/${encoded}`;
    /** 项目根 URL 不含资源路径，不把验证宿主的路由当成项目文件。 */
    const rootUrl = this.services.resourceUrl?.(id, '') ?? `zeus-source-preview://${id}/`;
    /** 上限覆盖源码页的二十个标签，阻止异常调用无限保留草稿。 */
    const owned = [...this.grants.values()].filter((grant) => grant.owner === owner);
    if (owned.length >= 24) this.grants.delete(owned[0]!.id);
    this.grants.set(id, { owner, root, path: normalized, content: input.content, id, url, rootUrl });
    return { id, url, rootUrl };
  }

  /** 渲染器只能释放自己窗口持有的授权。 */
  release(owner: number, ids?: string[]): void {
    for (const [id, grant] of this.grants) if (grant.owner === owner && (!ids || ids.includes(id))) this.grants.delete(id);
  }

  /** 协议分发只按已登记令牌寻找所属工作区，不接受页面指定根目录。 */
  owns(id: string): boolean {
    return this.grants.has(id);
  }

  /** GET/HEAD 只读取本次项目内的已知资源，其他方法与失效授权返回明确失败。 */
  async respond(id: string, pathname: string, request: Request): Promise<Response> {
    /** 当前活动的窗口授权。 */
    const grant = this.grants.get(id);
    if (!grant || !['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 404 });
    try {
      /** 解码后再次校验路径，不依赖 URL 的自动归一化。 */
      const requested = decodeURIComponent(pathname).replace(/^\//u, '');
      /** 草稿入口与磁盘资源分开，切换文件后不借用旧内容。 */
      const draft = requested === grant.path;
      /** 只返回当前草稿或有界静态资源。 */
      let bytes: Buffer;
      /** 文件 MIME 来自固定资源表。 */
      let mime: string;
      if (draft) {
        bytes = Buffer.from(grant.content, 'utf8');
        mime = projectSourcePreviewKind(grant.path) === 'html' ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8';
      } else {
        /** 每次访问重新解析链接，不能通过文件替换扩大权限。 */
        const path = await this.authorizedPath(grant.root, requested);
        mime = resourceMimeTypes[extname(path).toLowerCase()] ?? filePreviewMime(path);
        if (!resourceMimeTypes[extname(path).toLowerCase()] && !/^(image|audio|video)\//u.test(mime)) return new Response(null, { status: 415 });
        /** 打开前的文件身份与句柄身份核对，避免链接替换后读取项目外内容。 */
        const expected = await stat(path);
        if (expected.size > filePreviewLimits.image) return new Response(null, { status: 413 });
        /** 不跟随最后一级被替换的符号链接。 */
        const handle = await openRegularFileNoFollow(path, constants.O_RDONLY);
        try {
          /** 打开后的真实文件身份。 */
          const actual = await handle.stat();
          if (expected.dev !== actual.dev || expected.ino !== actual.ino || expected.size !== actual.size || expected.mtimeMs !== actual.mtimeMs) throw new Error('预览资源已变化。');
          /** 按已核对大小分配，文件异常增长也不能扩大读取缓冲区。 */
          bytes = Buffer.alloc(actual.size);
          /** 有界读取偏移，普通文件也允许分段返回。 */
          let offset = 0;
          while (offset < bytes.byteLength) {
            /** 本轮读取的真实字节数。 */
            const chunk = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
            if (!chunk.bytesRead) throw new Error('预览资源已变化。');
            offset += chunk.bytesRead;
          }
          /** 读取期间的尺寸变化仍须有界。 */
          const after = await handle.stat();
          if (bytes.byteLength > filePreviewLimits.image || after.size !== actual.size || after.mtimeMs !== actual.mtimeMs) throw new Error('预览资源已变化。');
        } finally {
          await handle.close();
        }
      }
      /** 授权可能在异步读取期间被撤销。 */
      if (this.grants.get(id) !== grant) return new Response(null, { status: 410 });
      /** 页面可执行自己的脚本，但不能访问桌面桥接或其他框架。 */
      const source = this.services.resourceSource ?? 'zeus-source-preview:';
      /** CSP 由独立页面响应提供，不继承源码编辑器的脚本能力。 */
      const csp = `default-src 'none'; script-src 'unsafe-inline' ${source} https:; style-src 'unsafe-inline' ${source} https:; img-src ${source} data: blob: https:; font-src ${source} data: https:; media-src ${source}; connect-src ${source}; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts`;
      return new Response(request.method === 'HEAD' ? null : new Uint8Array(bytes), {
        headers: { 'Content-Type': mime, 'Content-Length': String(bytes.byteLength), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Access-Control-Allow-Origin': 'null', 'Content-Security-Policy': csp },
      });
    } catch {
      return new Response('预览资源不可用或超出项目目录。', { status: 404 });
    }
  }

  /** 拒绝越界、Git 管理目录与指向项目外的链接。 */
  private async authorizedPath(root: string, path: string): Promise<string> {
    if (!path || isAbsolute(path) || path.includes('\\') || path.includes('\0') || path.split('/').some((part) => !part || part === '.' || part === '..' || part === '.git')) throw new Error('预览文件路径无效。');
    /** 真实路径解析会展开符号链接。 */
    const absolute = await realpath(resolve(root, path));
    /** 真实根目录下的相对位置。 */
    const child = relative(root, absolute);
    if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child) || child.split(sep).includes('.git') || !(await stat(absolute)).isFile()) throw new Error('预览文件超出项目目录。');
    return absolute;
  }
}
