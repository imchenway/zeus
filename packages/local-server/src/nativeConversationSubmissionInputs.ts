import type { TaskPushMessageLayout } from '@zeus/shared';
import type { ZeusConversationSubmissionRecord } from '@zeus/storage';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { ConversationDispatchContext, NativeConversationAttachmentInput, NativeConversationSkillInput, NativeSubmissionRecoveryKind } from './codexNativeConversationContracts.js';
import { coordinatorError, isRecord, parseJsonRecord } from './codexNativeConversationPolicy.js';

export interface PersistedSubmissionInput {
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

/** 从持久化提交中恢复经 Skill 目录解析过的选择；发送前再次确认文件仍然存在。 */
export function readNativeSubmissionSkill(submission: ZeusConversationSubmissionRecord): NativeConversationSkillInput | null {
  const value = parseJsonRecord(submission.inputJson).skill;
  if (value === undefined) return null;
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

/** Runtime Segment 重建时恢复最近一次冻结的 Skill，保证切换模型或 Provider 后仍投影同一内容。 */
export function readNativeConversationSkill(submissions: readonly ZeusConversationSubmissionRecord[]): NativeConversationSkillInput | null {
  for (let index = submissions.length - 1; index >= 0; index -= 1) {
    const skill = readNativeSubmissionSkill(submissions[index]!);
    if (skill) return skill;
  }
  return null;
}
