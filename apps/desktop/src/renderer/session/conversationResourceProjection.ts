import type { ConversationFileIconKind, ConversationResource } from '@zeus/shared';
import type { NativeConversationSnapshot, NativeConversationResourceV2Item, NativeItemSnapshot, NativeSessionItemBuffer } from './sessionTypes.js';

/** 汇总待补载正文的链接身份与完成状态，旧消息失败不挡住新回复，普通文字增量不重试。 */
export function inlineResourceRequestSignature(items: readonly { key: string; turnId: string; providerItemId?: string | null; status?: string | null; text: string }[]): string {
  return JSON.stringify(items.map((item) => [item.turnId, item.providerItemId ?? item.key, item.status ?? '', [...item.text.matchAll(/!?\[([^\]\n]+)\]\(([^)\n]+)\)/gu)].map((match) => match[0])]));
}

/** 资源元数据到会话项的投影，不持有订阅、重连或发送状态。 */
const conversationFileIconKinds = new Set<ConversationFileIconKind>(['code', 'java', 'javascript', 'typescript', 'json', 'markdown', 'sql', 'html', 'css', 'image', 'pdf', 'spreadsheet', 'presentation', 'document', 'archive', 'file']);

/** 按持久消息身份挂接历史和实时资源，线程切换与多来源别名都不改变归属。 */
export async function attachV2ResourcesToSnapshot(snapshot: NativeConversationSnapshot, metadata: NativeConversationResourceV2Item[], displayedItems: readonly NativeSessionItemBuffer[] = []): Promise<NativeConversationSnapshot> {
  if (metadata.length === 0) return snapshot;
  /** 由服务端持久身份关联历史消息，不用当前线程重算旧消息的资源身份。 */
  const resourceItemsByEntry = Map.groupBy(
    metadata.filter((item) => item.ownerEntryId),
    (item) => item.ownerEntryId!,
  );
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
  /** 历史正文接收原消息名下的所有资源别名。 */
  const projectedItemIds = snapshot.items.map((item) => ({
    item,
    resourceItemIds: [...new Set([...(resourceItemsByEntry.get(item.transcript.placement.entryId) ?? []).map((resource) => resource.itemId), item.id])],
  }));
  /** 只补入确有登记资源的实时条目，不把整个会话缓冲复制进有界快照。 */
  const snapshotEntryIds = new Set(snapshot.items.map((item) => item.transcript.placement.entryId));
  /** 乐观输入没有权威位置，不能因同名附件获得另一条消息的资源。 */
  const missingDisplayedItems = displayedItems.filter((item) => item.conversationId === snapshot.id && !item.optimistic && item.transcript && !snapshotEntryIds.has(item.transcript.placement.entryId));
  /** 实时正文与历史正文共用服务端登记的持久归属，不重新计算 Provider 身份。 */
  const displayedItemIds = missingDisplayedItems.map((item) => {
    /** 只接管确有可用资源的原消息，多个资源别名仍归属同一正文。 */
    const resourceItemIds = [...new Set([...(resourceItemsByEntry.get(item.transcript!.placement.entryId) ?? []).map((resource) => resource.itemId), item.transcript!.placement.entryId])].filter((id) => resourcesByItemId.has(id));
    if (resourceItemIds.length === 0) return null;
    return {
      resourceItemIds,
      item: {
        id: item.transcript!.placement.entryId,
        turnId: item.turnId,
        providerItemId: item.providerItemId ?? item.itemId,
        type: item.type,
        status: item.status,
        phase: item.phase,
        protocolFamily: item.protocolFamily,
        stageId: item.stageId,
        text: item.text,
        payload: item.payload,
        resources: item.resources,
        messageCreatedAt: item.messageCreatedAt,
        startedAt: item.timelineAt ?? null,
        completedAt: null,
        updatedAt: item.updatedAt ?? item.timelineAt ?? '',
        transcript: item.transcript!,
      } satisfies NativeItemSnapshot,
    };
  });
  for (const projected of displayedItemIds) {
    if (projected) projectedItemIds.push(projected);
  }
  const actualDeliveryItemIds = new Set<string>();
  for (const { item, resourceItemIds } of projectedItemIds) {
    if (syntheticAssistantDeliverableItemId(item)) continue;
    for (const resourceItemId of resourceItemIds) if (resourcesByItemId.get(resourceItemId)?.some((resource) => resource.delivery === 'assistant')) actualDeliveryItemIds.add(resourceItemId);
  }
  /** 新挂接的实时条目本身也是快照增量，即使原缓冲已有同一资源也必须接管。 */
  let changed = displayedItemIds.some(Boolean);
  const syntheticDeliveryItemIds = new Set<string>();
  const items = projectedItemIds.flatMap(({ item, resourceItemIds }) => {
    const syntheticItemId = syntheticAssistantDeliverableItemId(item);
    if (syntheticItemId && actualDeliveryItemIds.has(syntheticItemId)) {
      changed = true;
      return [];
    }
    if (syntheticItemId) syntheticDeliveryItemIds.add(syntheticItemId);
    /** 同一正文可接收多个 Provider 别名归档的资源。 */
    const exactResources = resourceItemIds.flatMap((id) => resourcesByItemId.get(id) ?? []);
    // 本地持久用户消息可能没有 providerItemId，而 Provider 会为同一附件生成一个或
    // 多个别名 item。此时按同轮次的耐久附件身份回接，不能退回 payload.localPath；
    // 后者在 Test 数据根、迁移或历史 Worktree 清理后不再是可授权读取入口。
    const attachmentResources = conversationResourcesMatchingItemAttachments(item, projectedResources);
    const resources = dedupeById([...(exactResources ?? []), ...attachmentResources]);
    if (!resources?.length) return [item];
    const merged = dedupeById([...(item.resources ?? []), ...resources]);
    const currentResources = new Map((item.resources ?? []).map((resource) => [resource.id, resource]));
    /** 历史资源恢复图片身份后也必须接管旧附件引用，不能只比较交付状态。 */
    const resourcesChanged =
      merged.length !== currentResources.size ||
      merged.some((resource) => {
        /** 同一资源编号仍可能补齐稳定的图片身份。 */
        const current = currentResources.get(resource.id);
        return current?.delivery !== resource.delivery || (resource.kind === 'attachment' && current?.kind === 'attachment' && current.attachmentRef !== resource.attachmentRef);
      });
    if (!resourcesChanged) return [item];
    changed = true;
    return [{ ...item, resources: merged }];
  });
  for (const [itemId, resources] of resourcesByItemId) {
    const deliverables = resources.filter((resource) => resource.delivery === 'assistant');
    if (deliverables.length === 0 || actualDeliveryItemIds.has(itemId) || syntheticDeliveryItemIds.has(itemId)) continue;
    const transcript = metadata.find((item) => item.itemId === itemId)?.transcript;
    if (!transcript) continue;
    items.push(syntheticAssistantDeliverableItem(snapshot, itemId, deliverables, transcript));
    changed = true;
  }
  return changed ? { ...snapshot, items: items.sort(compareV2ResourceItems) } : snapshot;
}

function syntheticAssistantDeliverableItemId(item: NativeItemSnapshot): string | null {
  return typeof item.payload.v2SyntheticAssistantDeliverableItemId === 'string' ? item.payload.v2SyntheticAssistantDeliverableItemId : null;
}

function syntheticAssistantDeliverableItem(snapshot: NativeConversationSnapshot, itemId: string, resources: ConversationResource[], transcript: NativeConversationResourceV2Item['transcript']): NativeItemSnapshot {
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
    transcript,
  };
}

/** 合成交付项仍按资源的持久位置排列，不使用资源更新时间。 */
function compareV2ResourceItems(left: NativeItemSnapshot, right: NativeItemSnapshot): number {
  return (left.transcript.placement.order ?? Number.MAX_SAFE_INTEGER) - (right.transcript.placement.order ?? Number.MAX_SAFE_INTEGER) || left.id.localeCompare(right.id);
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
      resource.turnId === (item.transcript.placement.turnId ?? item.turnId) &&
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
