import { parseCanonicalRequestUserInputQuestions, type CanonicalRequestUserInputQuestion } from './requestUserInput.js';

/** 助手消息的产品语义；消息完成不代表所属轮次结束。 */
export type AssistantMessageKind = 'progress' | 'question' | 'final';

/** 保存模型原始交付字段与统一分类，供实时消息和历史快照共同使用。 */
export interface AssistantMessageMetadata {
  phase: string;
  delivery?: string;
  questions?: unknown[];
  messageKind: AssistantMessageKind;
}

/** 回答只归属一个原始问题和轮次；另开消息必须由用户明确选择。 */
export interface AsyncQuestionAnswer {
  providerItemId: string;
  providerTurnId: string;
  answers: Record<string, { answers: string[] }>;
  asNewMessage?: boolean;
}

/** 历史问题按提交账本恢复答复状态，避免依赖同一分页恰好包含用户消息。 */
export interface AsyncQuestionResponse {
  status: string;
  answer: AsyncQuestionAnswer;
}

/** 将异步工具的问题结构转换为已有表单契约，不改变同步询问的校验规则。 */
export function asyncMessageQuestions(payload: Record<string, unknown>): CanonicalRequestUserInputQuestion[] {
  if (payload.delivery !== 'async' || !Array.isArray(payload.questions) || payload.questions.length === 0) return [];
  const result = parseCanonicalRequestUserInputQuestions({
    questions: payload.questions.map((question: unknown, index: number) => {
      if (!question || typeof question !== 'object' || Array.isArray(question)) return null;
      const raw = question as Record<string, unknown>;
      return {
        id: `question_${index + 1}`,
        header: typeof raw.title === 'string' ? raw.title : '',
        question: raw.title,
        options: raw.options == null ? null : Array.isArray(raw.options) ? raw.options.map((label: unknown) => ({ label, description: '' })) : raw.options,
        isOther: raw.options != null,
        isSecret: false,
        multiple: false,
      };
    }),
  });
  return result.ok ? result.questions : [];
}

/** 优先使用结构化交付事实；缺少结构的问题也不能因 final_answer 被当作最终交付。 */
export function classifyAssistantMessage(payload: Record<string, unknown>, fallbackPhase?: string | null): AssistantMessageKind {
  if (payload.delivery === 'async') return asyncMessageQuestions(payload).length > 0 ? 'question' : 'progress';
  const phase = typeof payload.phase === 'string' ? payload.phase : fallbackPhase;
  return !phase || phase === 'final_answer' || phase === 'finalAnswer' ? 'final' : 'progress';
}

/** 元数据只复制展示必需的原始字段；分类永远由共同入口重新计算。 */
export function assistantMessageMetadata(payload: Record<string, unknown>, fallbackPhase?: string | null): AssistantMessageMetadata {
  return {
    phase: typeof payload.phase === 'string' ? payload.phase : (fallbackPhase ?? 'final_answer'),
    ...(typeof payload.delivery === 'string' ? { delivery: payload.delivery } : {}),
    ...(Array.isArray(payload.questions) ? { questions: payload.questions } : {}),
    messageKind: classifyAssistantMessage(payload, fallbackPhase),
  };
}

/** 关联问题的文本沿用普通引导输入，模型可以明确对应每个回答。 */
export function formatAsyncQuestionAnswer(questions: CanonicalRequestUserInputQuestion[], answers: AsyncQuestionAnswer['answers']): string {
  return questions.map((question) => `${question.question}\n${answers[question.id]?.answers.join('\n') ?? ''}`).join('\n\n');
}
