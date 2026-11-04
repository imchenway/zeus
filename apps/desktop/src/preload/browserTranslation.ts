import { createPageTranslator } from '@zeus/browser-translation';
import { browserTranslationBatchCharacters, browserTranslationFragmentCharacters, browserTranslationBatchSize, type BrowserTranslationSegment } from '@zeus/shared/dist/browserTranslation.js';

/** 批注与翻译共用上游保存的原文身份。 */
export { translationSourceElement, sourceText, isTranslationNode } from '@zeus/browser-translation';

/** 请求片段不改变 KISS 的阅读段落和 DOM。 */
interface Request {
  /** Core 校验的身份与纯文本。 */
  segment: BrowserTranslationSegment;
  /** 片段完成后按原序合并。 */
  resolve: (text: string) => void;
  /** 停止或失败时释放等待任务。 */
  reject: (error: Error) => void;
}
/** 每次开启独立持有队列，旧响应不能进入新实例。 */
interface Run {
  /** BrowserHost 签发的身份。 */
  id: string;
  /** 片段的单调编号。 */
  sequence: number;
  /** 尚未发送的请求。 */
  queue: Request[];
  /** 包括正在发送的全部请求。 */
  requests: Set<Request>;
  /** 页面同时最多一个批次。 */
  busy: boolean;
  /** 失败后仅接受用户重试。 */
  error?: Error;
  /** 合并同帧请求的计时器。 */
  timer?: ReturnType<typeof setTimeout>;
}

/** KISS 处理网页；此适配器只处理 Zeus 服务协议、状态和取消。 */
export function createBrowserPageTranslation(options: {
  /** Core 返回校验后的纯文本。 */
  translate: (runId: string, segments: BrowserTranslationSegment[]) => Promise<BrowserTranslationSegment[]>;
  /** 工具栏状态不含原文或凭据。 */
  report: (runId: string, state: 'working' | 'ready' | 'error', message?: string) => void;
  /** 上游 DOM 写入后重新定位批注。 */
  onLayout: () => void;
}) {
  /** 页面唯一翻译实例。 */
  let engine: ReturnType<typeof createPageTranslator> | undefined;
  /** 关闭后旧对象与回调一起失效。 */
  let active: Run | undefined;
  /** 服务切换时清空缓存。 */
  let cacheService = '';
  /** 单页缓存最多 256 段，导航销毁。 */
  const cache = new Map<string, string>();

  /** 按 Core 长度上限拆分，不改变页面排版。 */
  function fragments(source: string): string[] {
    /** 片段保持原顺序。 */
    const result: string[] = [];
    while (source.length > browserTranslationFragmentCharacters) {
      /** 尽量保留英文单词和 UTF-16 代理对。 */
      let end = source.lastIndexOf(' ', browserTranslationFragmentCharacters);
      if (end < browserTranslationFragmentCharacters / 2) end = browserTranslationFragmentCharacters;
      if (/[\uD800-\uDBFF]/u.test(source[end - 1]!)) end -= 1;
      result.push(source.slice(0, end));
      source = source.slice(end).trimStart();
    }
    if (source) result.push(source);
    return result;
  }

  /** 取消必须释放全部等待的上游任务。 */
  function cancel(run: Run, error = new Error('Request terminated')): void {
    if (run.timer) clearTimeout(run.timer);
    run.timer = undefined;
    for (const request of run.requests) request.reject(error);
    run.requests.clear();
    run.queue = [];
  }

  /** DOM 错误和服务错误都进入可见失败状态。 */
  function fail(run: Run, cause: unknown): void {
    if (active !== run) return;
    /** 导航或还原不显示为服务故障。 */
    const error = cause instanceof Error ? cause : new Error('翻译失败，请重试。');
    if (error.message === 'Request terminated') return;
    run.error = error;
    cancel(run, error);
    options.report(run.id, 'error', error.message);
  }

  /** 等待上游 DOM 写入与当前批次结束后更新状态。 */
  function layout(run: Run): void {
    options.onLayout();
    requestAnimationFrame(() => {
      if (active === run && !run.error && !run.busy && !run.requests.size) options.report(run.id, 'ready');
    });
  }

  /** FIFO 批次遵守共享片段数和字符数上限。 */
  async function pump(run: Run): Promise<void> {
    run.timer = undefined;
    if (active !== run || run.busy || run.error || !run.queue.length) return;
    /** 本批片段通过 id 对齐服务返回值。 */
    const batch: Request[] = [];
    /** 大小单位为 UTF-16 字符。 */
    let characters = 0;
    while (run.queue.length && batch.length < browserTranslationBatchSize) {
      /** 队首已按单段上限拆分。 */
      const request = run.queue[0]!;
      if (characters + request.segment.text.length > browserTranslationBatchCharacters) break;
      batch.push(run.queue.shift()!);
      characters += request.segment.text.length;
    }
    run.busy = true;
    options.report(run.id, 'working');
    try {
      /** 返回顺序不影响段落顺序。 */
      const result = new Map(
        (
          await options.translate(
            run.id,
            batch.map((request) => request.segment),
          )
        ).map((segment) => [segment.id, segment.text]),
      );
      if (active !== run || run.error) return;
      for (const request of batch) {
        /** 缺失片段不能标记为完成。 */
        const text = result.get(request.segment.id);
        if (!text) throw new Error('翻译返回内容不完整，请重试。');
        run.requests.delete(request);
        request.resolve(text);
      }
    } catch (error) {
      fail(run, error);
    } finally {
      run.busy = false;
      if (active === run && !run.error) {
        if (run.queue.length) schedule(run);
        else layout(run);
      }
    }
  }

  /** 合并 40 毫秒内到达的可见段落请求。 */
  function schedule(run: Run): void {
    if (!run.timer && !run.busy && !run.error)
      run.timer = setTimeout(() => {
        void pump(run);
      }, 40);
  }

  /** 纯文本通过 IPC 发送，返回后由 KISS 转义再插入。 */
  async function translate(run: Run, source: string): Promise<{ trText: string; isSame: boolean }> {
    if (active !== run) throw new Error('Request terminated');
    if (run.error) throw run.error;
    /** 缓存按服务和完整阅读段落隔离。 */
    const cached = cache.get(source);
    if (cached !== undefined) return { trText: cached, isSame: cached.trim() === source.trim() };
    /** 同一段的服务片段按顺序恢复。 */
    const pending = fragments(source).map(
      (text) =>
        new Promise<string>((resolve, reject) => {
          /** 身份在本次运行内唯一。 */
          const request: Request = { segment: { id: `p${++run.sequence}`, text }, resolve, reject };
          run.queue.push(request);
          run.requests.add(request);
        }),
    );
    schedule(run);
    /** 全段完成后才显示和缓存。 */
    const trText = (await Promise.all(pending)).join(' ');
    if (active !== run) throw new Error('Request terminated');
    if (cache.size >= 256) cache.delete(cache.keys().next().value!);
    cache.set(source, trText);
    return { trText, isSame: trText.trim() === source.trim() };
  }

  /** 先废弃身份，再由上游恢复 DOM 和释放观察器。 */
  function stop(): void {
    /** 已完成缓存可以保留，运行队列不能复用。 */
    const previous = active;
    active = undefined;
    engine?.stop();
    engine = undefined;
    if (previous) cancel(previous);
    options.onLayout();
  }

  /** 仅在用户开启后创建上游识别和视口观察实例。 */
  function start(id: string, serviceId: string): void {
    stop();
    if (cacheService !== serviceId) {
      cache.clear();
      cacheService = serviceId;
    }
    if (document.contentType !== 'text/html' || !document.body || document.querySelector('embed[type="application/pdf"]')) {
      options.report(id, 'error', '当前支持 HTML 网页正文，PDF 和图片文字暂不支持。');
      return;
    }
    /** 回调绑定此对象，不能访问下一轮的队列。 */
    const run: Run = { id, sequence: 0, queue: [], requests: new Set(), busy: false };
    active = run;
    options.report(id, 'working');
    try {
      engine = createPageTranslator({
        translate: (text) => translate(run, text),
        cancel: () => cancel(run),
        onLayout: () => layout(run),
        onError: (error) => fail(run, error),
        onRetry: () => {
          if (active === run) {
            run.error = undefined;
            options.report(id, 'working');
          }
        },
      });
    } catch (error) {
      fail(run, error);
    }
  }
  return { start, stop };
}
