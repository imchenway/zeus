import type { CodexDynamicToolSpec } from '@zeus/ai-runtime';
import type { ConversationContextDraft } from '@zeus/shared';
import type { ConversationProviderItemRepository, ConversationRepository, ConversationSnapshotV2Repository, ConversationSubmissionRepository } from '@zeus/storage';
import type { BrowserAutomationToolCall, BrowserAutomationToolResult } from './browserAutomation.js';
import { coordinatorError, isRecord, parseJsonRecord } from './codexNativeConversationPolicy.js';

/** 单条引用附近最多携带的原文字符数。 */
const excerptCharacterLimit = 2000;
/** 首发所有引用的原文快照合计最多携带的字符数。 */
const totalExcerptCharacterLimit = 6000;
/** 按需读取复用已有历史分页，每页正文最多 16384 个 UTF-8 字节。 */
const sourcePageByteLimit = 16_384;

/** 来源关系随不可变提交保存，读取只访问同项目、同任务的既有产品历史。 */
export class ConversationSourceContextReader {
  /** 复用产品记录、提交、回答和历史查询，不读取 Provider 私有日志。 */
  constructor(
    private readonly conversations: ConversationRepository,
    private readonly submissions: ConversationSubmissionRepository,
    private readonly providerItems: ConversationProviderItemRepository,
    private readonly snapshots: ConversationSnapshotV2Repository,
  ) {}

  /** 从经过结构校验的引用核实来源，并附上引用附近的有界原文。 */
  enrich(context: Record<string, unknown> | undefined, owner: { id: string; projectId: string; taskId: string | null }, inheritedSourceId?: string): Record<string, unknown> | undefined {
    if (!context) return context;
    /** 字段结构已由公开命令入口校验；来源快照始终由此处重新生成。 */
    const draft = context as unknown as ConversationContextDraft;
    if (!draft.responseAnnotations.length) return context;
    /** 目录继承身份与引用身份必须指向同一个来源。 */
    const sourceIds = new Set([inheritedSourceId, ...draft.responseAnnotations.map((entry) => entry.anchor.sourceConversationId)].filter((id): id is string => Boolean(id)));
    if (!sourceIds.size) return context;
    if (sourceIds.size !== 1) throw coordinatorError('ZEUS_CONVERSATION_SOURCE_MISMATCH', '同一次侧栏引用必须来自同一会话。');
    /** 使用稳定产品身份，不借用当前 Provider 的 thread 身份。 */
    const sourceId = [...sourceIds][0]!;
    if (sourceId === owner.id) throw coordinatorError('ZEUS_CONVERSATION_SOURCE_MISMATCH', '侧栏来源不能指向当前会话自身。');
    /** 已建立的侧栏关系不能在后续消息中换成其他会话。 */
    const previous = this.sourceMetadata(owner.id);
    if (previous && previous.id !== sourceId) throw coordinatorError('ZEUS_CONVERSATION_SOURCE_MISMATCH', '当前侧栏已关联其他来源会话。');
    /** 会话归属检查同时覆盖首发和后续引用。 */
    const source = this.requireSource(owner, sourceId);
    /** 每次提交冻结当时可读原文；后续来源变化不会重写已发送引用。 */
    let remainingCharacters = totalExcerptCharacterLimit;
    /** 引用位置保留产品回答和轮次身份，便于后续精确读取。 */
    const references = draft.responseAnnotations.map((annotation) => {
      /** 回答定位同时接受产品身份和已有客户端使用的原生条目身份。 */
      const item = this.sourceAnswer(source.id, annotation.anchor.itemId);
      /** 预览只用于显示身份；引用定位使用已保存的完整正文，预算耗尽时不再读取。 */
      const text = remainingCharacters > 0 ? this.snapshots.readAssistantMessageText({ conversationId: source.id, turnId: item.turnId, providerItemId: item.providerItemId }) : null;
      if (!text) return { itemId: item.id, turnId: item.turnId, excerpt: '', truncated: true };
      /** 同一短语重复出现时，优先匹配选区偏移附近的原文。 */
      const before = text.lastIndexOf(annotation.anchor.selectedText, annotation.anchor.startOffset);
      /** 后方的匹配用于处理原文含有 Markdown 标记的偏移差异。 */
      const after = text.indexOf(annotation.anchor.selectedText, annotation.anchor.startOffset);
      /** 两侧匹配都存在时取最近位置，不固定引用第一次出现的短语。 */
      const found = before < 0 ? after : after < 0 || annotation.anchor.startOffset - before <= after - annotation.anchor.startOffset ? before : after;
      /** 渲染选文无法对应原文时只保留来源身份，不能用偏移猜测并附上其他段落。 */
      if (found < 0) return { itemId: item.id, turnId: item.turnId, excerpt: '', truncated: true };
      /** 总预算耗尽后仍保留来源身份，正文通过读取工具取得。 */
      const length = Math.min(excerptCharacterLimit, remainingCharacters);
      /** 靠近末尾的引用仍尽量保留完整的前文窗口。 */
      const start = Math.max(0, Math.min(found - Math.floor(length / 2), text.length - length));
      /** 快照只包含当前预算内的原文，不生成摘要或推测内容。 */
      const excerpt = text.slice(start, start + length);
      remainingCharacters -= excerpt.length;
      return { itemId: item.id, turnId: item.turnId, excerpt, truncated: start > 0 || start + length < text.length };
    });
    /** 补充原文后仍遵守公开上下文的总字节上限。 */
    const enriched = { ...context, sourceConversation: { id: source.id, title: source.title, references } };
    if (Buffer.byteLength(JSON.stringify(enriched), 'utf8') > 1_000_000) throw coordinatorError('ZEUS_INVALID_CONVERSATION_CONTEXT', '来源原文与评论合计不能超过 1 MB。');
    return enriched;
  }

  /** 模型只能读取当前侧栏已持久关联的来源，不能指定任意会话或文件路径。 */
  async invoke(input: BrowserAutomationToolCall): Promise<BrowserAutomationToolResult> {
    if (input.tool !== 'read_source') throw coordinatorError('ZEUS_NATIVE_TOOL_UNSUPPORTED', '来源会话工具不存在。');
    /** 公共工具参数在执行边界再次校验，不依赖模型遵守 schema。 */
    const args = input.arguments;
    if (Object.keys(args).some((key) => !['scope', 'itemId', 'cursor', 'handle', 'offset'].includes(key))) throw coordinatorError('ZEUS_CONVERSATION_SOURCE_ARGUMENT_INVALID', '来源读取包含未知参数。');
    for (const key of ['itemId', 'cursor', 'handle'] as const) {
      if (args[key] !== undefined && (typeof args[key] !== 'string' || !args[key].trim() || args[key].length > 8192)) throw coordinatorError('ZEUS_CONVERSATION_SOURCE_ARGUMENT_INVALID', `${key} 必须是非空且有界的字符串。`);
    }
    if (args.scope !== undefined && args.scope !== 'turn' && args.scope !== 'history') throw coordinatorError('ZEUS_CONVERSATION_SOURCE_ARGUMENT_INVALID', 'scope 必须为 turn 或 history。');
    if (args.offset !== undefined && (typeof args.offset !== 'number' || !Number.isSafeInteger(args.offset) || args.offset < 0 || !args.handle))
      throw coordinatorError('ZEUS_CONVERSATION_SOURCE_ARGUMENT_INVALID', 'offset 必须与正文句柄一起使用，且为非负整数。');
    /** 调用身份来自工具宿主，不接受模型参数覆盖。 */
    const owner = this.conversations.getRecordById(input.conversationId);
    /** 读取首次来源提交，可在重启或切换 Provider 后恢复关系。 */
    const metadata = this.sourceMetadata(input.conversationId);
    if (!owner || !metadata) throw coordinatorError('ZEUS_CONVERSATION_SOURCE_UNAVAILABLE', '当前会话尚未保存可读取的来源；可从主会话重新引用一次以建立关系。');
    /** 每次读取都重新检查来源的实际归属，不能只依赖旧标题或文件路径。 */
    const source = this.requireSource(owner, metadata.id);
    /** 正文句柄由已有历史查询生成，并继续绑定来源会话身份。 */
    const page = args.handle
      ? this.snapshots.readContentPage({ conversationId: source.id, handle: args.handle as string, offset: args.offset as number | undefined, byteLimit: sourcePageByteLimit, dialogueOnly: true })
      : args.scope === 'history'
        ? this.snapshots.listModelHistoryPage({ conversationId: source.id, cursor: args.cursor as string | undefined, dialogueOnly: true, direction: 'tail', entryLimit: 8, byteLimit: sourcePageByteLimit })
        : this.snapshots.listTurnModelHistoryPage({
            conversationId: source.id,
            turnId: this.sourceTurn(source.id, metadata, args.itemId as string | undefined),
            cursor: args.cursor as string | undefined,
            dialogueOnly: true,
            entryLimit: 8,
            byteLimit: sourcePageByteLimit,
          });
    return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify({ sourceConversation: { id: source.id, title: source.title }, page }) }] };
  }

  /** 产品会话归属是读取边界，Provider 和设备切换不会改变该边界。 */
  private requireSource(owner: { projectId: string; taskId: string | null }, sourceId: string) {
    /** 只读取轻量记录，避免为了校验加载整段消息。 */
    const source = this.conversations.getRecordById(sourceId);
    if (!source || source.projectId !== owner.projectId || source.taskId !== owner.taskId) throw coordinatorError('ZEUS_CONVERSATION_SOURCE_FORBIDDEN', '来源会话不属于当前项目或任务。');
    return source;
  }

  /** 来源快照由命令入口写入不可变提交，前端临时状态不是读取授权依据。 */
  private sourceMetadata(conversationId: string): ConversationContextDraft['sourceConversation'] | undefined {
    /** 首次带来源的提交不受队列重排或消息删除后的显示位置影响。 */
    const submission = this.submissions.getSourceContextSubmission(conversationId);
    if (!submission) return undefined;
    /** 只读取结构化来源字段，不从模型文字猜测会话身份。 */
    const input = parseJsonRecord(submission.inputJson);
    /** 历史提交中的上下文必须仍为对象。 */
    const context = isRecord(input.conversationContext) ? input.conversationContext : null;
    /** 缺少稳定来源身份的旧记录不能擅自建立关系。 */
    const source = context && isRecord(context.sourceConversation) ? context.sourceConversation : null;
    if (!source || typeof source.id !== 'string' || !source.id.trim() || !Array.isArray(source.references)) return undefined;
    return source as unknown as NonNullable<ConversationContextDraft['sourceConversation']>;
  }

  /** 默认读取首次引用所属轮次，也允许继续定位同一来源内的其他回答。 */
  private sourceTurn(sourceId: string, metadata: NonNullable<ConversationContextDraft['sourceConversation']>, itemId?: string): string {
    /** 默认引用没有位置时明确失败，不退回任意一轮历史。 */
    const id = itemId ?? metadata.references[0]?.itemId;
    /** 产品或原生回答身份都必须解析到来源会话内。 */
    if (!id) throw coordinatorError('ZEUS_CONVERSATION_SOURCE_ITEM_NOT_FOUND', '来源回答已不可用。');
    return this.sourceAnswer(sourceId, id).turnId;
  }

  /** 仅回答正文可成为引用来源，不能用工具或思考记录冒充回答。 */
  private sourceAnswer(sourceId: string, itemId: string) {
    /** 查询绑定来源身份，不能凭原生条目 ID 跨会话读取。 */
    const item = this.providerItems.getByConversationItemId(sourceId, itemId);
    if (!item || item.itemType.toLowerCase() !== 'agentmessage' || !item.textContent.trim()) throw coordinatorError('ZEUS_CONVERSATION_SOURCE_ITEM_NOT_FOUND', '来源回答已不可用，无法定位本次引用。');
    return item;
  }
}

/** Codex 与 Pi 共用工具契约，Pi 名称由原生工具注册表统一映射。 */
export function conversationSourceDynamicTools(): CodexDynamicToolSpec[] {
  return [
    {
      type: 'namespace',
      name: 'zeus_conversation',
      description: '读取当前侧栏持久关联的来源会话上下文。',
      tools: [
        {
          type: 'function',
          name: 'read_source',
          deferLoading: true,
          description:
            '只读查询来源会话。默认返回引用轮次的用户与助手对话；scope=history 从来源会话末尾分页。用 nextCursor 继续，遇到 null 停止。content.truncated 为 true 时，用其 handle 读取正文，首次省略 offset；随后使用返回的 nextOffset，遇到 null 停止。不会读取隐藏思考或重新执行工具。',
          inputSchema: {
            type: 'object',
            properties: {
              scope: { type: 'string', enum: ['turn', 'history'], description: '默认 turn 读取引用轮次，history 读取来源历史。' },
              itemId: { type: 'string', description: '来源回答 ID；省略时定位首次引用的回答。' },
              cursor: { type: 'string', description: '上一页返回的非空 nextCursor，必须沿用原 scope。' },
              handle: { type: 'string', description: '来源历史返回的正文句柄，读取全文时使用。' },
              offset: { type: 'integer', minimum: 0, description: '正文分页的字符偏移，必须与 handle 一起使用，不接受 null。' },
            },
            additionalProperties: false,
          },
        },
      ],
    },
  ];
}
