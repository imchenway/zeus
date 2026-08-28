import type { CodexThreadSnapshot } from '@zeus/ai-runtime';
import type { ConversationRepository } from '@zeus/storage';
import { isAbsolute } from 'node:path';

/** 只接收 app-server 明确返回的绝对路径；缺失或相对路径都不推测本地会话位置。 */
export function threadPath(snapshot: CodexThreadSnapshot): string | undefined {
  return typeof snapshot.path === 'string' && snapshot.path.trim() && isAbsolute(snapshot.path.trim()) ? snapshot.path.trim() : undefined;
}

export function persistThreadProviderSettings(conversations: Pick<ConversationRepository, 'updateProviderThreadPath' | 'upsertProviderSettingsSnapshot'>, conversationId: string, thread: CodexThreadSnapshot): void {
  const providerThreadPath = threadPath(thread);
  if (providerThreadPath) {
    conversations.updateProviderThreadPath(conversationId, {
      providerThreadId: thread.id,
      providerThreadPath,
    });
  }
  const settings = thread.providerSettings;
  if (!settings) return;
  conversations.upsertProviderSettingsSnapshot(conversationId, {
    generationId: settings.generationId,
    sequence: settings.sequence,
    model: settings.model,
    ...(settings.effort ? { effort: settings.effort } : {}),
    ...(Object.prototype.hasOwnProperty.call(settings, 'serviceTier') ? { serviceTier: settings.serviceTier } : {}),
  });
}
