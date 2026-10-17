import { lazy, Suspense, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import type { Text } from '@codemirror/state';
import type { ProjectSourcePreviewGrant, ProjectSourcePreviewKind } from '@zeus/shared';
import { ArrowClockwiseIcon as ArrowClockwise } from '@phosphor-icons/react/dist/csr/ArrowClockwise';
import { VisibleApplicationError } from '../ui/ApplicationErrorDialog.js';

/** 只有显示文档效果时才加载 Markdown 与图表渲染。 */
const Markdown = lazy(() => import('../session/ConversationMarkdown.js').then((module) => ({ default: module.ConversationMarkdown })));

/** HTML 与 Markdown 使用当前草稿；文件身份变化时重新建立独立生命周期。 */
export function ProjectSourceRenderedPreview(props: {
  /** 项目授权身份。 */
  projectId: string;
  /** 当前源码文件。 */
  path: string;
  /** 预览格式来自共享文件类型识别。 */
  kind: ProjectSourcePreviewKind;
  /** 保留文档树，预览显示时才展开内容。 */
  draft: string | Text;
  /** 界面语言。 */
  language: 'zh-CN' | 'en-US';
  /** 本地文件链接复用源码打开入口。 */
  openFile(path: string): Promise<void>;
}) {
  /** 后台更新不阻塞编辑器输入。 */
  const deferredDraft = useDeferredValue(props.draft);
  /** 只为当前预览内容生成字符串。 */
  const content = useMemo(() => deferredDraft.toString(), [deferredDraft]);
  /** 当前内容与资源地址绑定在同一回执。 */
  const [preview, setPreview] = useState<{ grant: ProjectSourcePreviewGrant; content: string } | null>(null);
  /** 刷新会重新读取相对资源，不保存文件。 */
  const [attempt, setAttempt] = useState(0);
  /** 加载与失败在当前文件内显示。 */
  const [loading, setLoading] = useState(true);
  /** 预览失败仍保留源码模式和编辑草稿。 */
  const [error, setError] = useState<unknown>(null);
  /** 页内锚点仅滚动预览，不改变工作区路由。 */
  const root = useRef<HTMLElement>(null);
  /** 界面文案沿用项目语言。 */
  const zh = props.language === 'zh-CN';

  useEffect(() => {
    /** 迟到回执只释放授权，不替换新文件。 */
    let active = true;
    /** 本次加载拥有的临时资源。 */
    let id: string | undefined;
    /** 桌面桥接只存在于受信主页面。 */
    const bridge = window.zeus;
    setLoading(true);
    setError(null);
    if (!bridge?.prepareProjectSourcePreview) {
      setLoading(false);
      setError(zh ? '文件预览服务尚未连接。' : 'File preview service is unavailable.');
      return;
    }
    void bridge
      .prepareProjectSourcePreview({ projectId: props.projectId, relativePath: props.path, content })
      .then((grant) => {
        id = grant.id;
        if (active) setPreview({ grant, content });
        else void bridge.releaseProjectSourcePreview([id]).catch(() => undefined);
      })
      .catch((cause: unknown) => {
        if (active) setError(cause);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      if (id) void bridge.releaseProjectSourcePreview([id]).catch(() => undefined);
    };
  }, [props.projectId, props.path, content, attempt, zh]);

  /** 仅把相对资源解析到当前授权；外部图片只接受 HTTPS。 */
  const filePreview = useMemo(
    () => ({
      imageUrl(path: string): string | undefined {
        if (!preview) return undefined;
        try {
          /** URL 的目录保留原文件位置。 */
          const target = new URL(path, preview.grant.url);
          /** 授权域固定，不能把任意本地路径交给图片元素。 */
          const base = new URL(preview.grant.rootUrl);
          return target.protocol === 'https:' || (target.protocol === base.protocol && target.host === base.host && target.href.startsWith(preview.grant.rootUrl)) ? target.href : undefined;
        } catch {
          return undefined;
        }
      },
      async openLink(path: string): Promise<void> {
        try {
          if (path.startsWith('#')) {
            /** 页内锚点不改变应用 hash 路由。 */
            const id = decodeURIComponent(path.slice(1));
            root.current?.querySelector<HTMLElement>(`[id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'start' });
            return;
          }
          if (/^https:\/\//iu.test(path)) {
            /** 用户点击外部链接后复用现有受信打开流程。 */
            const result = await window.zeus?.openExternalHttpsUrl(path);
            if (!result?.opened) throw new Error(result?.error ?? (zh ? '链接无法打开。' : 'Could not open link.'));
            return;
          }
          if (!preview) return;
          /** 本地链接只在当前预览授权域中解析。 */
          const target = new URL(path, preview.grant.url);
          /** 明确拒绝危险协议和其他域。 */
          const base = new URL(preview.grant.rootUrl);
          if (target.protocol !== base.protocol || target.host !== base.host || !target.href.startsWith(preview.grant.rootUrl)) throw new Error(zh ? '此链接不在当前项目内。' : 'This link is outside the project.');
          await props.openFile(decodeURIComponent(target.href.slice(preview.grant.rootUrl.length).split(/[?#]/u)[0]!));
        } catch (cause) {
          setError(cause);
        }
      },
    }),
    [preview, props.openFile, zh],
  );

  return (
    <section ref={root} className="project-source-rendered-preview" aria-label={zh ? '文件效果预览' : 'Rendered file preview'} aria-busy={loading || deferredDraft !== props.draft}>
      <button type="button" className="project-source-preview-refresh" aria-label={zh ? '刷新预览' : 'Refresh preview'} data-icon-tooltip={zh ? '刷新预览' : 'Refresh preview'} onClick={() => setAttempt((value) => value + 1)}>
        <ArrowClockwise size={16} aria-hidden="true" />
      </button>
      {error ? (
        <div className="project-source-preview-message" role="status">
          <VisibleApplicationError error={error} language={zh ? 'zh-CN' : 'en'} />
        </div>
      ) : !preview ? (
        <p className="project-source-preview-message" role="status">
          {zh ? '正在打开预览…' : 'Opening preview…'}
        </p>
      ) : props.kind === 'html' ? (
        <iframe
          className="project-source-html-preview"
          src={preview.grant.url}
          title={props.path}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          onError={() => setError(zh ? '页面预览加载失败，请重试。' : 'Page preview failed. Please retry.')}
        />
      ) : (
        <div className="project-source-markdown-preview">
          <Suspense fallback={null}>
            <Markdown text={preview.content} streamId={`source:${props.projectId}:${props.path}`} phase="final" language={props.language} documentMode renderImmediately filePreview={filePreview} />
          </Suspense>
        </div>
      )}
    </section>
  );
}
