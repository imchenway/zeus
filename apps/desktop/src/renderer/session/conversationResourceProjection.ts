import type { ConversationFileIconKind, ConversationResource } from '@zeus/shared';
import type { NativeConversationSnapshot, NativeConversationResourceV2Item, NativeItemSnapshot } from './sessionTypes.js';

/** 资源元数据到会话项的投影，不持有订阅、重连或发送状态。 */
const conversationFileIconKinds = new Set<ConversationFileIconKind>(['code', 'java', 'javascript', 'typescript', 'json', 'markdown', 'sql', 'html', 'css', 'image', 'pdf', 'spreadsheet', 'presentation', 'document', 'archive', 'file']);

export async function attachV2ResourcesToSnapshot(snapshot: NativeConversationSnapshot, metadata: NativeConversationResourceV2Item[]): Promise<NativeConversationSnapshot> {
  const providerThreadId = snapshot.providerThreadId;
  if (metadata.length === 0) return snapshot;
  const resourcesByItemId = new Map<string, ConversationResource[]>();
  const projectedResources: ConversationResource[] = [];
  for (const item of metadata) {
    const resource = conversationResourceFromV2Metadata(snapshot, item);
    if (!resource) continue;
    projectedResources.push(resource);
    const resources = resourcesByItemId.get(item.itemId) ?? [];
    resources.push(resource);
    resourcesByItemId.set(item.itemId, resources);
  }
  const canResolveProviderStateId = Boolean(providerThreadId && globalThis.crypto?.subtle);
  const projectedItemIds = await Promise.all(
    snapshot.items.map(async (item) => ({
      item,
      providerStateId: canResolveProviderStateId && item.providerItemId ? await conversationProviderItemStateId(providerThreadId!, item.providerItemId) : null,
    })),
  );
  const actualDeliveryItemIds = new Set<string>();
  for (const { item, providerStateId } of projectedItemIds) {
    if (syntheticAssistantDeliverableItemId(item)) continue;
    const resourceItemId = providerStateId ?? (resourcesByItemId.has(item.id) ? item.id : null);
    if (resourceItemId && resourcesByItemId.get(resourceItemId)?.some((resource) => resource.delivery === 'assistant')) actualDeliveryItemIds.add(resourceItemId);
  }
  let changed = false;
  const syntheticDeliveryItemIds = new Set<string>();
  const items = projectedItemIds.flatMap(({ item, providerStateId }) => {
    const syntheticItemId = syntheticAssistantDeliverableItemId(item);
    if (syntheticItemId && actualDeliveryItemIds.has(syntheticItemId)) {
      changed = true;
      return [];
    }
    if (syntheticItemId) syntheticDeliveryItemIds.add(syntheticItemId);
    const exactItemId = providerStateId ?? syntheticItemId ?? (resourcesByItemId.has(item.id) ? item.id : null);
    const exactResources = exactItemId ? resourcesByItemId.get(exactItemId) : undefined;
    // 本地持久用户消息可能没有 providerItemId，而 Provider 会为同一附件生成一个或
    // 多个别名 item。此时按同轮次的耐久附件身份回接，不能退回 payload.localPath；
    // 后者在 Test 数据根、迁移或历史 Worktree 清理后不再是可授权读取入口。
    const attachmentResources = conversationResourcesMatchingItemAttachments(item, projectedResources);
    const resources = dedupeById([...(exactResources ?? []), ...attachmentResources]);
    if (!resources?.length) return [item];
    const merged = dedupeById([...(item.resources ?? []), ...resources]);
    const currentResources = new Map((item.resources ?? []).map((resource) => [resource.id, resource]));
    const resourcesChanged = merged.length !== currentResources.size || merged.some((resource) => currentResources.get(resource.id)?.delivery !== resource.delivery);
    if (!resourcesChanged) return [item];
    changed = true;
    return [{ ...item, resources: merged }];
  });
  for (const [itemId, resources] of resourcesByItemId) {
    const deliverables = resources.filter((resource) => resource.delivery === 'assistant');
    if (deliverables.length === 0 || actualDeliveryItemIds.has(itemId) || syntheticDeliveryItemIds.has(itemId)) continue;
    items.push(syntheticAssistantDeliverableItem(snapshot, itemId, deliverables));
    changed = true;
  }
  return changed ? { ...snapshot, items: items.sort(compareV2ResourceItems) } : snapshot;
}

function syntheticAssistantDeliverableItemId(item: NativeItemSnapshot): string | null {
  return typeof item.payload.v2SyntheticAssistantDeliverableItemId === 'string' ? item.payload.v2SyntheticAssistantDeliverableItemId : null;
}

function syntheticAssistantDeliverableItem(snapshot: NativeConversationSnapshot, itemId: string, resources: ConversationResource[]): NativeItemSnapshot {
  const orderedResources = [...resources].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  const first = orderedResources[0]!;
  const last = orderedResources[orderedResources.length - 1]!;
  const turnId = snapshot.turns.find((turn) => turn.id === first.turnId)?.providerTurnId ?? first.turnId;
  const imageOnly = orderedResources.every((resource) => (resource.kind === 'attachment' && resource.previewKind === 'image') || ('mimeType' in resource && resource.mimeType?.startsWith('image/')));
  return {
    id: itemId,
    turnId,
    providerItemId: null,
    type: imageOnly ? 'imageGeneration' : 'assistantDeliverable',
    status: 'completed',
    phase: 'prework',
    text: '',
    payload: { v2SyntheticAssistantDeliverableItemId: itemId },
    resources: orderedResources,
    startedAt: first.createdAt,
    completedAt: last.updatedAt,
    updatedAt: last.updatedAt,
  };
}

function compareV2ResourceItems(left: NativeItemSnapshot, right: NativeItemSnapshot): number {
  return (left.startedAt ?? left.updatedAt).localeCompare(right.startedAt ?? right.updatedAt) || left.id.localeCompare(right.id);
}

async function conversationProviderItemStateId(providerThreadId: string, providerItemId: string): Promise<string> {
  const source = new TextEncoder().encode(`${providerThreadId}\u0000${providerItemId}`);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', source));
  const hex = [...digest].map((value) => value.toString(16).padStart(2, '0')).join('');
  return `conversation_provider_item_${hex.slice(0, 32)}`;
}

function conversationResourceFromV2Metadata(snapshot: NativeConversationSnapshot, item: NativeConversationResourceV2Item): ConversationResource | null {
  const presentation = item.presentation === 'card' ? 'card' : 'inline';
  const base = {
    id: item.id,
    projectId: snapshot.projectId,
    conversationId: snapshot.id,
    turnId: item.turnId,
    itemId: item.itemId,
    presentation,
    ...(item.delivery === 'assistant' ? { delivery: 'assistant' as const } : {}),
    displayName: item.displayName,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  } as const;
  const iconKind = conversationFileIconKinds.has(item.iconKind as ConversationFileIconKind) ? (item.iconKind as ConversationFileIconKind) : item.mimeType?.startsWith('image/') ? 'image' : 'file';
  if (item.kind === 'file') {
    return {
      ...base,
      kind: 'file',
      projectRelativePath: item.displayName,
      iconKind,
      ...(item.mimeType ? { mimeType: item.mimeType } : {}),
    };
  }
  if (item.kind === 'website') {
    let domain = item.displayName;
    try {
      domain = new URL(item.displayName).hostname || item.displayName;
    } catch {
      // V2 元数据故意不下发真实 URL；点击时仍由受信资源 id 解析实际目标。
    }
    return { ...base, kind: 'website', url: item.displayName, domain, title: item.displayName, local: false };
  }
  if (item.kind === 'attachment') {
    return {
      ...base,
      kind: 'attachment',
      attachmentRef: item.attachmentRef ?? item.id,
      previewKind: item.previewKind === 'image' || item.previewKind === 'document' ? item.previewKind : 'none',
      iconKind,
      ...(item.mimeType ? { mimeType: item.mimeType } : {}),
      ...(item.taskPushAttachmentKey ? { taskPushAttachmentKey: item.taskPushAttachmentKey } : {}),
    };
  }
  return null;
}

function conversationResourcesMatchingItemAttachments(item: NativeConversationSnapshot['items'][number], resources: ConversationResource[]): ConversationResource[] {
  const attachments = conversationItemAttachmentDescriptors(item);
  if (attachments.length === 0) return [];
  const taskPushAttachmentKeys = new Set(attachments.map((attachment) => attachment.taskPushAttachmentKey).filter((value): value is string => Boolean(value)));
  const uploadRefs = new Set(attachments.map((attachment) => attachment.uploadRef).filter((value): value is string => Boolean(value)));
  const names = new Set(attachments.map((attachment) => attachment.name));
  return resources.filter(
    (resource) =>
      resource.kind === 'attachment' &&
      resource.turnId === item.turnId &&
      ((resource.taskPushAttachmentKey && taskPushAttachmentKeys.has(resource.taskPushAttachmentKey)) || uploadRefs.has(resource.attachmentRef) || names.has(resource.displayName)),
  );
}

function conversationItemAttachmentDescriptors(item: NativeConversationSnapshot['items'][number]): Array<{ name: string; uploadRef: string | null; taskPushAttachmentKey: string | null }> {
  const content = typeof item.payload.content === 'object' && item.payload.content !== null && !Array.isArray(item.payload.content) ? (item.payload.content as Record<string, unknown>) : null;
  const sources = [item.payload.attachments, content?.attachments].filter(Array.isArray);
  const descriptors = sources.flatMap((source) =>
    source.flatMap((entry) => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return [];
      const attachment = entry as Record<string, unknown>;
      const name = typeof attachment.name === 'string' ? attachment.name : '';
      if (!name) return [];
      return [
        {
          name,
          uploadRef: typeof attachment.uploadRef === 'string' && attachment.uploadRef ? attachment.uploadRef : null,
          taskPushAttachmentKey: typeof attachment.taskPushAttachmentKey === 'string' && attachment.taskPushAttachmentKey ? attachment.taskPushAttachmentKey : null,
        },
      ];
    }),
  );
  return [...new Map(descriptors.map((descriptor) => [`${descriptor.taskPushAttachmentKey ?? ''}\u0000${descriptor.uploadRef ?? ''}\u0000${descriptor.name}`, descriptor])).values()];
}

function dedupeById<T extends { id: string }>(items: T[]): T[] {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}
