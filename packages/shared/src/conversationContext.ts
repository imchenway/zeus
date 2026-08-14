export interface ConversationResponseTextAnchor {
  itemId: string;
  startOffset: number;
  endOffset: number;
  selectedText: string;
}

export interface ConversationResponseAnnotation {
  id: string;
  anchor: ConversationResponseTextAnchor;
  note?: string;
}

export type ConversationCodeCommentSide = 'left' | 'right';

export interface ConversationCodeCommentPosition {
  path: string;
  line: number;
  side: ConversationCodeCommentSide;
  startLine?: number;
  startSide?: ConversationCodeCommentSide;
}

export interface ConversationCodeComment {
  id: string;
  body: string;
  position: ConversationCodeCommentPosition;
  diffHunk?: string;
}

export interface ConversationContextDraft {
  responseAnnotations: ConversationResponseAnnotation[];
  codeComments: ConversationCodeComment[];
}

export const emptyConversationContextDraft: ConversationContextDraft = {
  responseAnnotations: [],
  codeComments: [],
};

export function hasConversationContext(draft: ConversationContextDraft): boolean {
  return draft.responseAnnotations.length > 0 || draft.codeComments.length > 0;
}

/** 把结构化上下文转换为 Provider 可直接理解的稳定文本，同时保留单独元数据用于本地回显。 */
export function serializeConversationContext(draft: ConversationContextDraft): string {
  const sections: string[] = [];
  if (draft.responseAnnotations.length > 0) {
    sections.push(
      [
        '# 对会话回答的注释',
        ...draft.responseAnnotations.flatMap((annotation, index) => [
          `## 注释 ${index + 1}`,
          `回答项：${annotation.anchor.itemId}`,
          `选中文字：${annotation.anchor.selectedText}`,
          ...(annotation.note?.trim() ? [`用户评论：${annotation.note.trim()}`] : []),
        ]),
      ].join('\n'),
    );
  }
  if (draft.codeComments.length > 0) {
    sections.push(
      [
        '# 对代码的本地评论',
        ...draft.codeComments.flatMap((comment, index) => {
          const startLine = comment.position.startLine ?? comment.position.line;
          const startSide = comment.position.startSide ?? comment.position.side;
          const start = `${startSide === 'left' ? 'L' : 'R'}${startLine}`;
          const end = `${comment.position.side === 'left' ? 'L' : 'R'}${comment.position.line}`;
          return [
            `## 评论 ${index + 1}`,
            `文件：${comment.position.path}`,
            `位置：${start === end ? start : `${start}-${end}`}`,
            `内容：${comment.body.trim()}`,
            ...(comment.diffHunk?.trim() ? [`差异片段：\n\`\`\`diff\n${comment.diffHunk.trim()}\n\`\`\``] : []),
          ];
        }),
      ].join('\n'),
    );
  }
  return sections.join('\n\n');
}
