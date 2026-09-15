import { serializeConversationContext, type ConversationContextDraft } from '@zeus/shared';
import type { AsyncQuestionAnswer } from '@zeus/shared';
import type { TaskPushMessageLayout } from '@zeus/shared';
import type { ZeusConversationSubmissionRecord } from '@zeus/storage';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { ConversationDispatchContext, NativeConversationAttachmentInput, NativeConversationSkillInput, NativeSubmissionRecoveryKind } from './codexNativeConversationContracts.js';
import { coordinatorError, isRecord, parseJsonRecord } from './codexNativeConversationPolicy.js';

export interface PersistedSubmissionInput {
  /** 绑定原始异步问题，沿用现有提交及确认链路。 */
  questionAnswer?: AsyncQuestionAnswer;
  text: string;
  requestedServiceTier?: string | null;
  serviceTierDowngrade?: {
    reason: 'model_unsupported' | 'app_server_rejected' | 'provider_reported_standard';
    actualServiceTier: string | null;
  };
  composerDraft?: string;
  attachments?: NativeConversationAttachmentInput[];
  browserComments?: Record<string, unknown>[];
  browserCommentContent?: string;
  conversationContext?: Record<string, unknown>;
  context: ConversationDispatchContext;
  displayText?: string;
  origin?: 'implement_plan' | 'refine_plan';
  planItemId?: string;
  delivery?: 'queue' | 'steer_now';
  expectedTurnId?: string | null;
  taskPushLayout?: TaskPushMessageLayout;
  internalOperation?: boolean;
  requestAnswerId?: string;
  recoveryKind?: NativeSubmissionRecoveryKind;
  goalObjective?: string;
  skill?: NativeConversationSkillInput;
  /** 当前提交完整的显式 Skill 选择；旧单项记录只在读取入口归一化。 */
  skills?: NativeConversationSkillInput[];
  /** 用户显式指定电脑操作的意图；能力授权由全局开关决定。 */
  computerUseRequested?: boolean;
}

export function readNativeSubmissionRecoveryKind(submission: ZeusConversationSubmissionRecord, input = parseJsonRecord(submission.inputJson)): NativeSubmissionRecoveryKind | null {
  if (input.recoveryKind === 'interaction_response') return 'interaction_response';
  // 0.3.72 等旧版本没有持久化 recoveryKind；只按该内部幂等键识别未进入 Provider turn 的历史续接。
  return submission.idempotencyKey.startsWith('interaction-recovery-response:') ? 'interaction_response' : null;
}

export function readNativeSubmissionTaskPushLayout(submission: ZeusConversationSubmissionRecord): TaskPushMessageLayout | null {
  const value = parseJsonRecord(submission.inputJson).taskPushLayout;
  if (value === undefined) return null;
  if (!isRecord(value) || value.kind !== 'task_push' || !Array.isArray(value.blocks) || typeof value.supplementalInfo !== 'string' || (value.supplementalAttachments !== undefined && !Array.isArray(value.supplementalAttachments))) {
    throw coordinatorError('ZEUS_NATIVE_PERSISTED_STATE_INVALID', 'Persisted task push layout is invalid.');
  }
  return { ...value, supplementalAttachments: value.supplementalAttachments ?? [] } as unknown as TaskPushMessageLayout;
}

/** 新旧提交共用的资源读取边界；保持用户选择顺序并核对磁盘身份。 */
export function readNativeSubmissionSkills(submission: ZeusConversationSubmissionRecord): NativeConversationSkillInput[] {
  const input = parseJsonRecord(submission.inputJson);
  const values = input.skills ?? (input.skill === undefined ? [] : [input.skill]);
  if (!Array.isArray(values) || values.length > 8) throw coordinatorError('ZEUS_NATIVE_PERSISTED_STATE_INVALID', 'Skill 选择必须为最多 8 项的数组。');
  return values.map(readPersistedSkill);
}

/** 校验一个持久化 Skill，避免模型请求使用未经目录确认的路径。 */
function readPersistedSkill(value: unknown): NativeConversationSkillInput {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    !value.id ||
    typeof value.name !== 'string' ||
    !value.name.trim() ||
    (value.description !== undefined && (typeof value.description !== 'string' || !value.description.trim())) ||
    typeof value.path !== 'string' ||
    !isAbsolute(value.path)
  ) {
    throw coordinatorError('ZEUS_NATIVE_PERSISTED_STATE_INVALID', 'Persisted Skill selection is invalid.');
  }
  try {
    const canonicalPath = realpathSync(value.path);
    if (!statSync(canonicalPath).isFile()) throw new Error('Skill path is not a file.');
    return {
      id: value.id,
      name: value.name.trim(),
      description: typeof value.description === 'string' ? value.description.trim() : value.name.trim(),
      path: canonicalPath,
    };
  } catch {
    throw coordinatorError('ZEUS_SKILL_NOT_FOUND', `所选 Skill “${value.name}” 已不存在，请重新选择。`);
  }
}

/** 恢复最近一轮完整的显式选择，空数组表示明确清除。 */
export function readNativeConversationSkills(submissions: readonly ZeusConversationSubmissionRecord[]): NativeConversationSkillInput[] {
  for (let index = submissions.length - 1; index >= 0; index -= 1) {
    const input = parseJsonRecord(submissions[index]!.inputJson);
    if (input.skills !== undefined || input.skill !== undefined) return readNativeSubmissionSkills(submissions[index]!);
  }
  return [];
}

/** 两条链路共用批注与引用正文，防止只保存界面元数据却没有交给模型。 */
export function appendConversationResourceContext(prompt: string, browserCommentContent: string | undefined, browserComments: Record<string, unknown>[] | undefined, conversationContext: Record<string, unknown> | undefined): string {
  const browserContext = browserCommentContent?.trim() || (browserComments?.length ? JSON.stringify({ browserComments }) : '');
  const readableContext = conversationContext ? serializeConversationContext(conversationContext as unknown as ConversationContextDraft).trim() : '';
  const missingReadableContext = readableContext && !prompt.includes(readableContext) ? readableContext : '';
  return [prompt, browserContext && !prompt.includes(browserContext) ? browserContext : '', missingReadableContext].filter((part) => part.trim()).join('\n\n');
}
