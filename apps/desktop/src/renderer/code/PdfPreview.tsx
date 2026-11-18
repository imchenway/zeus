import { useEffect, useRef, useState } from 'react';
import type { PdfPreviewCommand } from '@zeus/shared';
import { nativeViewportOccluded, nativeViewportOverlaysChanged, nativeViewportPopoverSelector } from '../ui/nativeViewport.js';
import { ResourceLoading } from '../ui/ResourceLoading.js';
import { FileFindControls, FileFindMatchCase } from './fileFind.js';

/** 已授权的 Chromium PDF 视图使用与文本编辑器相同的查找栏。 */
export function PdfPreview(props: { id: string; name: string; zh: boolean; searchRequest: number; onOpenFind(): void }) {
  /** 浏览器视图绑定实际宿主元素，而不是操作系统当前焦点。 */
  const body = useRef<HTMLDivElement>(null);
  /** 每次匹配递增以忽略已过期的异步结果。 */
  const request = useRef(0);
  /** 查询条件和当前计数包含在各自的渲染代次。 */
  const [query, setQuery] = useState('');
  const [matchCase, setMatchCase] = useState(false);
  const [match, setMatch] = useState<{ count: number; active: number } | null>(null);
  const [closedRequest, setClosedRequest] = useState(0);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const openFind = props.searchRequest > closedRequest;

  /** 关闭或隐藏宿主时及时归还原生视图的可见区域。 */
  useEffect(() => {
    const element = body.current;
    const view = element?.ownerDocument.defaultView;
    const bridge = window.zeus;
    if (!element || !view || !bridge) return;
    const target = view === window ? '' : view.name;
    let active = true;
    let visible = false;
    let last = '';
    let frame = 0;

    /** 让原生视图跟随窗口布局，遮盖正文的浮层出现时交还绘制区域。 */
    function layout(): void {
      if (!element || !view || !bridge || !active) return;
      const rect = element.getBoundingClientRect();
      const x = Math.max(0, Math.ceil(rect.left));
      const y = Math.max(0, Math.ceil(rect.top));
      const width = Math.floor(Math.min(view.innerWidth, rect.right)) - x;
      const height = Math.floor(Math.min(view.innerHeight, rect.bottom)) - y;
      const overlays = element.ownerDocument.querySelectorAll<HTMLElement>(nativeViewportPopoverSelector);
      const bounds = visible && width > 0 && height > 0 && !nativeViewportOccluded(element, overlays) ? { x, y, width, height } : null;
      const key = JSON.stringify(bounds);
      if (last === key) return;
      last = key;
      void bridge
        .updatePdfPreview(props.id, { action: 'layout', target, bounds })
        .then(() => {
          if (active && bounds) setState('ready');
        })
        .catch(() => {
          if (active) setState('error');
        });
    }

    /** 一帧内合并多个尺寸、滚动及相交变化。 */
    function schedule(): void {
      if (!view) return;
      view.cancelAnimationFrame(frame);
      frame = view.requestAnimationFrame(layout);
    }
    const intersection = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      schedule();
    });
    const overlays = new MutationObserver((records) => {
      if (nativeViewportOverlaysChanged(records, element)) layout();
    });
    const resize = new ResizeObserver(schedule);
    intersection.observe(element);
    overlays.observe(element.ownerDocument.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'hidden', 'inert', 'data-motion-state'] });
    resize.observe(element);
    view.addEventListener('scroll', schedule, true);
    view.addEventListener('resize', schedule);
    return () => {
      active = false;
      view.cancelAnimationFrame(frame);
      view.removeEventListener('scroll', schedule, true);
      view.removeEventListener('resize', schedule);
      intersection.disconnect();
      overlays.disconnect();
      resize.disconnect();
      void bridge.updatePdfPreview(props.id, { action: 'close' }).catch(() => undefined);
    };
  }, [props.id]);

  /** Electron 查找只发送关键字和导航，文件内容留在阅读器进程。 */
  function send(command: PdfPreviewCommand): void {
    void window.zeus?.updatePdfPreview(props.id, command).catch(() => setState('error'));
  }

  /** 后续跳转继续当前原生查找会话。 */
  function navigate(backwards: boolean): void {
    if (!match?.count) return;
    send({ action: 'find', request: ++request.current, query, forward: !backwards, restart: false, matchCase });
  }

  /** 关闭后清除 PDF 高亮并将焦点交回阅读器。 */
  function closeFind(): void {
    setClosedRequest(props.searchRequest);
    if (state === 'ready') send({ action: 'focus' });
    else body.current?.focus();
  }

  useEffect(() =>
    window.zeus?.onPdfPreviewEvent((event) => {
      if (event.id !== props.id) return;
      if (event.action === 'open-find') props.onOpenFind();
      else if (event.action === 'close-find' && openFind) closeFind();
      else if (event.action === 'navigate' && openFind) navigate(event.backwards);
      else if (event.action === 'match' && openFind && event.request === request.current) setMatch({ count: event.count, active: event.active });
    }),
  );

  useEffect(() => {
    request.current += 1;
    setMatch(null);
    if (state !== 'ready') return;
    if (!openFind || !query) send({ action: 'clear' });
    else send({ action: 'find', request: request.current, query, forward: true, restart: true, matchCase });
  }, [props.id, state, openFind, query, matchCase]);

  return (
    <div className="file-preview-pdf">
      {openFind ? (
        <div className="file-find-slot">
          <FileFindControls
            zh={props.zh}
            value={query}
            status={!query || !match ? '' : match.count ? `${match.active} / ${match.count}` : props.zh ? '无匹配' : 'No matches'}
            hasMatches={Boolean(match?.count)}
            request={props.searchRequest}
            options={<FileFindMatchCase zh={props.zh} value={matchCase} onChange={setMatchCase} />}
            onChange={(value) => setQuery(value.slice(0, 4096))}
            onNavigate={navigate}
            onClose={closeFind}
          />
        </div>
      ) : null}
      {state === 'loading' ? <ResourceLoading label={props.zh ? '正在读取 PDF…' : 'Reading PDF…'} /> : null}
      {state === 'error' ? <p role="alert">{props.zh ? 'PDF 阅读器加载失败，请使用“打开文件”。' : 'PDF viewer failed. Use Open to view it in a system app.'}</p> : null}
      <div ref={body} className="file-preview-pdf-body" role="document" aria-label={props.name} tabIndex={-1} />
    </div>
  );
}
