import { createContext } from 'react';
import type { ConversationCodeComment, ConversationCodeCommentPosition, ConversationContextDraft, ConversationResponseAnnotation } from '@zeus/shared';

/** 文件阅览沿所属会话交付选区；没有可用侧栏的窗口不提供该动作。 */
export const FileSelectionQuestionContext = createContext<((position: ConversationCodeCommentPosition, sendImmediately: boolean) => void) | null>(null);

/** 解释队列保留引用的真实来源，不把文件选区伪装为会话回答。 */
export type SideQuestionReference = ConversationResponseAnnotation | ConversationCodeComment;

/** 首发和后续解释共用同一上下文转换，保留文件位置与回答来源身份。 */
export function sideQuestionReferenceContext(reference: SideQuestionReference): ConversationContextDraft {
  return 'anchor' in reference ? { responseAnnotations: [reference], codeComments: [] } : { responseAnnotations: [], codeComments: [reference] };
}
