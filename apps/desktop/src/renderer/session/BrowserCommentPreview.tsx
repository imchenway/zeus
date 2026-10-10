import { useEffect, useState } from 'react';
import type { ZeusBrowserComment } from '@zeus/shared';
import { PreviewImage } from '../code/FilePreview.js';

/** 草稿、排队消息和历史消息共用评论文字与截图预览。 */
export function BrowserCommentPreview(props: { comments: ZeusBrowserComment[]; zh: boolean }) {
  return (
    <section className="session-message-context-summary session-browser-comment-previews" aria-label={props.zh ? '网页评论' : 'Browser comments'}>
      <header>
        <strong>{props.zh ? '网页评论' : 'Browser comments'}</strong>
        <span>{props.comments.length}</span>
      </header>
      <div className="session-message-response-annotations">
        {props.comments.map((comment) => (
          <BrowserCommentEntry key={comment.id} comment={comment} zh={props.zh} />
        ))}
      </div>
    </section>
  );
}

/** 按需读取评论专属目录，避免把截图误当成普通上传附件。 */
function BrowserCommentEntry(props: { comment: ZeusBrowserComment; zh: boolean }) {
  /** 只在展开时加载图片，收起后释放大图。 */
  const [open, setOpen] = useState(false);
  /** null 表示尚未完成，空串表示读取失败。 */
  const [url, setUrl] = useState<string | null>(null);
  /** 评论绑定的持久截图路径。 */
  const path = props.comment.screenshotPath;
  /** 文字、元素和区域评论都保留批注当时的内容，不依赖当前网页。 */
  const quotedText = props.comment.anchor.textRange?.text || props.comment.anchor.immediateText || props.comment.anchor.accessibleName || props.comment.anchor.nearbyText;
  useEffect(() => {
    let active = true;
    setUrl(null);
    if (open && path) {
      void (window.zeus?.getBrowserCommentPreview(path) ?? Promise.resolve(null))
        .then((preview) => {
          if (active) setUrl(preview?.previewUrl ?? '');
        })
        .catch(() => {
          if (active) setUrl('');
        });
    }
    return () => {
      active = false;
    };
  }, [open, path, props.comment.updatedAt]);
  return (
    <article>
      <span>
        {props.zh ? '评论' : 'Comment'} {props.comment.number} · {props.comment.anchor.pageTitle || props.comment.anchor.pageUrl}
      </span>
      {quotedText ? <blockquote>{quotedText}</blockquote> : null}
      <p>{props.comment.body}</p>
      {props.comment.designChanges.map((change, index) => (
        <p key={index}>
          {change.property || change.kind}: {change.previous} → {change.next}
        </p>
      ))}
      {path ? (
        <details className="session-browser-comment-screenshot" onToggle={(event) => setOpen(event.currentTarget.open)}>
          <summary>{props.zh ? '查看批注截图' : 'View comment screenshot'}</summary>
          {open ? (
            url ? (
              <div className="file-preview">
                <PreviewImage url={url} name={props.comment.anchor.pageTitle || (props.zh ? '评论截图' : 'Comment screenshot')} zh={props.zh} />
              </div>
            ) : (
              <p role="status">{url === null ? (props.zh ? '正在加载截图…' : 'Loading screenshot…') : props.zh ? '截图不可用，评论文字仍可查看。' : 'Screenshot unavailable. Comment text is still available.'}</p>
            )
          ) : null}
        </details>
      ) : null}
    </article>
  );
}
