import { useEffect, useState } from 'react';
import type { ConversationCodeComment, ConversationCodeCommentPosition } from '@zeus/shared';
import type { SessionUiLanguage } from './ThreadItemView.js';

export function CodeCommentPanel(props: { language: SessionUiLanguage; position: ConversationCodeCommentPosition; comment?: ConversationCodeComment; onCancel: () => void; onSave: (body: string) => void; onDelete?: () => void }) {
  const zh = props.language === 'zh-CN';
  const [body, setBody] = useState(props.comment?.body ?? '');
  useEffect(() => setBody(props.comment?.body ?? ''), [props.comment?.body, props.comment?.id]);
  const startLine = props.position.startLine ?? props.position.line;
  const startSide = props.position.startSide ?? props.position.side;
  const start = `${startSide === 'left' ? 'L' : 'R'}${startLine}`;
  const end = `${props.position.side === 'left' ? 'L' : 'R'}${props.position.line}`;
  const location = start === end ? start : `${start}–${end}`;

  return (
    <span className="session-code-comment-panel" role="group" aria-label={zh ? `第 ${location} 行评论` : `Comment on line ${location}`}>
      <span className="session-code-comment-panel-header">
        <strong>{zh ? '本地评论' : 'Local comment'}</strong>
        <span>{zh ? `对第 ${location} 行发布评论` : `Comment on line ${location}`}</span>
      </span>
      <textarea autoFocus value={body} placeholder={zh ? '请求更改' : 'Request changes'} onChange={(event) => setBody(event.currentTarget.value)} />
      <span className="session-code-comment-panel-footer">
        {props.comment && props.onDelete ? (
          <button type="button" className="is-delete" onClick={props.onDelete}>
            {zh ? '删除' : 'Delete'}
          </button>
        ) : (
          <span />
        )}
        <button type="button" onClick={props.onCancel}>
          {zh ? '取消' : 'Cancel'}
        </button>
        <button type="button" className="is-primary" disabled={!body.trim()} onClick={() => body.trim() && props.onSave(body.trim())}>
          {props.comment ? (zh ? '保存' : 'Save') : zh ? '评论' : 'Comment'}
        </button>
      </span>
    </span>
  );
}
