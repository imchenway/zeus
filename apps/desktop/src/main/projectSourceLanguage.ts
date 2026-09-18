import { Worker } from 'node:worker_threads';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { SourceLanguageRequest, SourceLanguageResult } from '@zeus/shared';

interface LanguageWorker {
  worker: Worker;
  root: string;
  timer: ReturnType<typeof setTimeout>;
  pending: Map<number, { resolve(value: SourceLanguageResult): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>;
}

/** 每个窗口和项目隔离语言状态；计算移到线程，避免大型项目阻塞应用主进程。 */
export class ProjectSourceLanguageService {
  readonly #workers = new Map<string, LanguageWorker>();
  #sequence = 0;

  async request(owner: number, rootPath: string, input: SourceLanguageRequest): Promise<SourceLanguageResult> {
    if (!input || typeof input.projectId !== 'string' || !['completion', 'hover', 'definition', 'references', 'rename', 'diagnostics', 'format'].includes(input.operation)) throw new Error('语言服务请求无效。');
    if (!Number.isSafeInteger(input.offset) || input.offset < 0 || !Array.isArray(input.buffers) || input.buffers.length > 20) throw new Error('源码缓冲区请求无效。');
    if (input.newName !== undefined && (typeof input.newName !== 'string' || input.newName.length > 256)) throw new Error('符号名称无效。');
    const root = await realpath(rootPath);
    const paths = [input.relativePath, ...input.buffers.map((buffer) => buffer.relativePath)];
    let bytes = 0;
    for (const buffer of input.buffers) {
      if (typeof buffer.content !== 'string' || !Number.isSafeInteger(buffer.version)) throw new Error('源码缓冲区无效。');
      bytes += Buffer.byteLength(buffer.content);
    }
    if (bytes > 16 * 1024 * 1024) throw new Error('语言分析的打开文件总量超过 16 MB。');
    await Promise.all(
      [...new Set(paths)].map(async (path) => {
        if (typeof path !== 'string' || !path || isAbsolute(path) || path.includes('\0') || path.includes('\\') || path.split('/').some((part) => ['.', '..', '.git'].includes(part))) throw new Error('语言服务路径必须位于当前项目中。');
        const canonical = await realpath(resolve(root, path));
        const inside = relative(root, canonical);
        if (inside.startsWith('..' + sep) || inside === '..' || isAbsolute(inside)) throw new Error('语言服务不能访问项目外部文件。');
      }),
    );
    const key = owner + ':' + input.projectId;
    let entry = this.#workers.get(key);
    if (entry && entry.root !== root) {
      this.release(owner, input.projectId);
      entry = undefined;
    }
    if (!entry) {
      // 有界缓存：空闲项目可随时重建，草稿始终由请求中的编辑器缓冲区提供。
      if (this.#workers.size >= 4) this.#dispose(this.#workers.keys().next().value!);
      const worker = new Worker(new URL('./sourceLanguageWorker.js', import.meta.url), { workerData: { root }, resourceLimits: { maxOldGenerationSizeMb: 512 } });
      entry = { worker, root, pending: new Map(), timer: setTimeout(() => this.#dispose(key), 120_000) };
      entry.timer.unref();
      worker.unref();
      this.#workers.set(key, entry);
      const current = entry;
      worker.on('message', (message: { id: number; result?: SourceLanguageResult; error?: string }) => {
        const pending = current.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        current.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error));
        else pending.resolve(message.result!);
      });
      worker.on('error', (error) => {
        if (this.#workers.get(key) === current) this.#dispose(key, error);
      });
      worker.on('exit', () => {
        if (this.#workers.get(key) === current) this.#dispose(key, new Error('项目语言服务已退出，请重试。'));
      });
    }
    if (entry.pending.size >= 16) throw new Error('项目语言分析正在处理较多请求，请稍后重试。');
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => this.#dispose(key), 120_000);
    entry.timer.unref();
    const id = ++this.#sequence;
    return new Promise((resolveResult, reject) => {
      const timer = setTimeout(() => this.#dispose(key, new Error('项目语言分析超时，请缩小项目范围后重试。')), 30_000);
      timer.unref();
      entry!.pending.set(id, { resolve: resolveResult, reject, timer });
      entry!.worker.postMessage({ id, input });
    });
  }

  release(owner: number, projectId?: string): void {
    for (const key of this.#workers.keys()) if (projectId ? key === owner + ':' + projectId : key.startsWith(owner + ':')) this.#dispose(key);
  }

  dispose(): void {
    for (const key of this.#workers.keys()) this.#dispose(key);
  }

  #dispose(key: string, error = new Error('项目语言服务已关闭。')): void {
    const entry = this.#workers.get(key);
    if (!entry) return;
    this.#workers.delete(key);
    clearTimeout(entry.timer);
    for (const pending of entry.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    entry.pending.clear();
    void entry.worker.terminate();
  }
}
