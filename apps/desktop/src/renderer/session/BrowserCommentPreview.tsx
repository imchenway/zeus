import { useEffect, useState } from 'react';
import type { ZeusBrowserComment } from '@zeus/shared';
import { PreviewImage } from '../code/FilePreview.js';

/** 草稿、排队消息和历史消息共用批注文字与截图预览。 */
export function BrowserCommentPreview(props: { comments: ZeusBrowserComment[]; zh: boolean }) {
  return (
    <div className="session-browser-comment-previews">
      {props.comments.map((comment) => (
        <BrowserCommentEntry key={comment.id} comment={comment} zh={props.zh} />
      ))}
    </div>
  );
}

/** 按需读取批注专属目录，避免把截图误当成普通上传附件。 */
function BrowserCommentEntry(props: { comment: ZeusBrowserComment; zh: boolean }) {
  /** 只在展开时加载图片，收起后释放大图。 */
  const [open, setOpen] = useState(false);
  /** null 表示尚未完成，空串表示读取失败。 */
  const [url, setUrl] = useState<string | null>(null);
  /** 批注绑定的持久截图路径。 */
  const path = props.comment.screenshotPath;
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
  }, [open, path]);
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        {props.zh ? '批注' : 'Comment'} {props.comment.number} · {props.comment.body || (props.zh ? '查看页面调整' : 'View page changes')}
      </summary>
      {open ? (
        <div className="session-browser-comment-content">
          <p>{props.comment.anchor.pageTitle || props.comment.anchor.pageUrl}</p>
          <p>{props.comment.body}</p>
          {props.comment.designChanges.map((change, index) => (
            <p key={index}>
              {change.property || change.kind}: {change.previous} → {change.next}
            </p>
          ))}
          {path ? (
            url ? (
              <div className="file-preview">
                <PreviewImage url={url} name={props.comment.anchor.pageTitle || (props.zh ? '批注截图' : 'Comment screenshot')} zh={props.zh} />
              </div>
            ) : (
              <p role="status">{url === null ? (props.zh ? '正在加载截图…' : 'Loading screenshot…') : props.zh ? '截图不可用，批注文字仍可查看。' : 'Screenshot unavailable. Comment text is still available.'}</p>
            )
          ) : null}
        </div>
      ) : null}
    </details>
  );
}
