import { createHash } from 'node:crypto';
import { classifyAssistantMessage } from '@zeus/shared';
import type { ConversationModelHistoryPageItem, ConversationSnapshotV2, ConversationSnapshotV2Repository, LongTermMemoryRecord } from '@zeus/storage';
import { relevantEmployeeKnowledge } from './employeeMemoryContext.js';

/** 建议只读当前规则、任务和已确认记忆，不创建画像，也不读取 Provider 私有记忆目录。 */
export interface InputSuggestionSources {
  /** 与正常会话共用读取器合成的全局与项目规则；空值表示没有规则文件。 */
  agentRules: string | null;
  /** 任务身份由会话所属关系解析，不从标题猜测。 */
  task: { id: string; title: string; description: string; updatedAt: string } | null;
  /** 调用方已按当前项目、全局范围、有效期和统一脱敏边界解析的记忆。 */
  memories: readonly LongTermMemoryRecord[];
}

/** 历史读取只依赖已有分页与正文句柄，便于检查同一会话的身份边界。 */
type SuggestionRepository = Pick<ConversationSnapshotV2Repository, 'listModelHistoryPage' | 'readContentPage'>;

/** 缓存仅持有有界的已发送原文投影，不保存草稿或生成结果。 */
interface CachedHistory {
  /** 顺序重建、流重建或资料修改均使原文候选失效。 */
  revision: string;
  /** 增量读取从本次冻结水位继续，不重复扫描已有正文。 */
  throughSequence: number;
  /** 开场原话独立保留，不随近期候选淘汰。 */
  opening: ConversationModelHistoryPageItem | null;
  /** 最近用户消息包含同轮补充和问题答复。 */
  users: ConversationModelHistoryPageItem[];
  /** 助手材料独立限额，长回复不会挤掉用户要求。 */
  assistants: ConversationModelHistoryPageItem[];
}

/** 资料正文及有效状态共同决定身份，删除记忆也会改变结果。 */
export function inputSuggestionSourcesFingerprint(sources: InputSuggestionSources): string {
  return createHash('sha256').update(JSON.stringify(sources)).digest('hex');
}

/** 超长原文保留首尾并标明缺口，避免只保留开头而丢掉末尾修正。 */
function excerpt(text: string, limit: number): string {
  if (text.length <= limit) return text;
  /** 裁剪标记是材料说明，不是模型自行生成的摘要。 */
  const marker = '\n[中间内容已裁剪]\n';
  /** 极小剩余额度也不能因负偏移重新带入全文。 */
  if (limit <= marker.length) return text.slice(0, Math.max(0, limit)).replace(/[\uD800-\uDBFF]$/u, '');
  /** 按 UTF-16 预算计算，同时避免切断一个 Unicode 字符。 */
  const half = Math.max(0, Math.floor((limit - marker.length) / 2));
  return text.slice(0, half).replace(/[\uD800-\uDBFF]$/u, '') + marker + text.slice(-half).replace(/^[\uDC00-\uDFFF]/u, '');
}

/** 正文页沿用存储层脱敏及身份校验；超长消息至多读取首尾两页。 */
function readMessage(repository: SuggestionRepository, conversationId: string, item: ConversationModelHistoryPageItem, limit: number): string {
  if (!item.content.truncated || !item.content.contentHandle) return excerpt(item.content.preview, limit);
  /** 字节预算涵盖中文和表情，内容页仍由仓库限制最大值。 */
  const head = repository.readContentPage({ conversationId, handle: item.content.contentHandle, byteLimit: Math.max(1024, Math.min(32_768, limit * 4)) });
  if (head.nextOffset === null) return excerpt(head.text, limit);
  /** 偏移使用正文页提供的字符位置，不从预览字符串或句柄猜测。 */
  const tail = repository.readContentPage({ conversationId, handle: item.content.contentHandle, offset: Math.max(head.nextOffset, head.totalCharacters - Math.floor(limit / 2)), byteLimit: Math.max(1024, Math.min(32_768, limit * 4)) });
  return excerpt(`${head.text}\n[中间内容已裁剪]\n${tail.text}`, limit);
}

/** 同一消息在开场页、增量页和最近页重叠时只保留一次。 */
function uniqueMessages(items: readonly ConversationModelHistoryPageItem[]): ConversationModelHistoryPageItem[] {
  return [...new Map(items.map((item) => [item.id, item])).values()].sort((left, right) => (left.messageCreatedAt ?? left.confirmedAt).localeCompare(right.messageCreatedAt ?? right.confirmedAt) || left.sequence - right.sequence);
}

/** 按角色独立分配预算，保留消息身份供合并排序；来源标签和分隔符算入总长度。 */
function renderMessages(repository: SuggestionRepository, conversationId: string, items: readonly ConversationModelHistoryPageItem[], budget: number): Array<{ item: ConversationModelHistoryPageItem; text: string }> {
  /** 优先选择的消息不能被排序过程挤走。 */
  const selected: Array<{ item: ConversationModelHistoryPageItem; text: string }> = [];
  /** 单条长消息最多占四分之一，短消息可以让更多原话进入材料。 */
  const perMessage = Math.max(256, Math.floor(budget / Math.max(1, Math.min(new Set(items.map((item) => item.id)).size, 4))));
  /** 每条正文及分隔符都从同一预算扣减。 */
  let remaining = budget;
  for (const item of [...new Map(items.map((entry) => [entry.id, entry])).values()]) {
    if (remaining < 128) break;
    /** 角色必须来自持久化身份，不采信正文内伪造的角色说明。 */
    const kind = item.role === 'assistant' ? classifyAssistantMessage({ ...item.assistantMessage }, item.phase) : null;
    /** 阶段进展、问题和最终答复分别标注，最终答复不等于验收。 */
    const label = item.role === 'user' ? '用户原话' : kind === 'question' ? '助手提问' : kind === 'progress' ? '助手阶段进展' : kind === 'final' ? '助手最终答复（陈述不代表验收）' : '助手回复';
    /** 消息身份提供证据来源，不能变成新的执行授权。 */
    const heading = `[${label}；消息 ${item.id}]\n`;
    /** 仅已选材料读取完整正文，候选检索使用有界预览。 */
    const body = readMessage(repository, conversationId, item, Math.min(perMessage, remaining - heading.length - 2)).trim();
    if (!body) continue;
    selected.push({ item, text: heading + body });
    remaining -= heading.length + body.length + 2;
  }
  return selected;
}

/** 当前项目与全局的生效偏好可影响表达，未确认和员工专属经验不能提升为用户要求。 */
function renderSources(sources: InputSuggestionSources, projectId: string | undefined, query: string, state: string): string {
  /** 状态属于材料预算；没有任务和记忆时仍标明运行状态。 */
  let text = `[运行状态]\n${state}`;
  if (sources.task) text += `\n\n[当前任务描述]\n${excerpt(`${sources.task.title}\n${sources.task.description}`, 2_000)}`;
  /** 表达偏好和授权边界也是本操作的相关主题，其他偏好仍须匹配当前原话。 */
  const preferenceQuery = `${query}\n表达风格 语言 语气 口吻 简洁 详细 授权 权限 确认 language tone style concise detailed permission authorization`;
  for (const memory of sources.memories) {
    if (memory.tombstone || memory.confirmationLevel === 'observed' || (memory.scope.kind !== 'global' && !(memory.scope.kind === 'project' && memory.scope.id === projectId))) continue;
    // ponytail: 复用现有中英文词片段匹配；超长会话取材上限仍在，语义召回有实测缺口时再升级检索。
    if (!relevantEmployeeKnowledge(memory.memoryKey + memory.content, ['preference', 'safety_boundary'].includes(memory.kind) ? preferenceQuery : query)) continue;
    /** 整条记忆入选或舍弃，不截断否定词和限制条件。 */
    const block = `\n\n[已确认记忆；${memory.scope.kind}；${memory.id}]\n${memory.content}`;
    if (text.length + block.length <= 4_000) text += block;
  }
  return text;
}

/** 建议与润色共用按需取材；每个会话只缓存原文候选，不调用模型整理摘要。 */
export function createInputSuggestionContextReader(repository: SuggestionRepository) {
  /** 最多 32 个会话共享有界缓存，关闭宿主时清理。 */
  const cache = new Map<string, CachedHistory>();

  /** 单类候选最多两页、64 条和 96 KiB，工具和思考已在 SQL 过滤。 */
  function readCandidates(conversationId: string, role: 'user' | 'assistant', afterSequence?: number): { items: ConversationModelHistoryPageItem[]; hasMore: boolean } {
    /** 首次从尾部选近期原文，后续只读新增消息。 */
    let page = repository.listModelHistoryPage({
      conversationId,
      dialogueRole: role,
      direction: afterSequence === undefined ? 'tail' : 'forward',
      ...(afterSequence === undefined ? {} : { afterSequence }),
      entryLimit: 64,
      byteLimit: 49_152,
    });
    /** 候选页已经脱敏，缓存不读取原始数据库正文。 */
    const items = [...page.items];
    if (page.nextCursor && items.length < 64) {
      page = repository.listModelHistoryPage({ conversationId, dialogueRole: role, cursor: page.nextCursor, entryLimit: 64 - items.length, byteLimit: 49_152 });
      items.push(...page.items);
    }
    return { items: uniqueMessages(items), hasMore: page.hasMore };
  }

  return {
    /** 宿主关闭和模型设置修改不遗留材料缓存。 */
    clear: () => cache.clear(),
    /** 用户新要求的水位独立于助手进度，普通进度不会打断手动润色。 */
    userRevision(conversationId: string): string {
      /** SQL 已按用户角色过滤，工具增量不会改变该身份。 */
      const item = repository.listModelHistoryPage({ conversationId, dialogueRole: 'user', direction: 'tail', entryLimit: 1, byteLimit: 16_384 }).items[0];
      return item ? JSON.stringify([item.id, item.sequence, item.confirmedAt, item.content]) : '';
    },
    /** 草稿只用于当前请求的相关性选择，不写入缓存。 */
    read(input: { snapshot: ConversationSnapshotV2 | null; projectId?: string; sources: InputSuggestionSources; draft?: string }) {
      /** 每次重新解析记忆和任务，资料撤销或变更可立即使缓存失效。 */
      const sourcesFingerprint = inputSuggestionSourcesFingerprint(input.sources);
      /** 新草稿可以没有会话，但仍可参考当前项目的已确认偏好。 */
      const snapshot = input.snapshot;
      /** 缓存键包含权威项目与会话身份。 */
      const key = snapshot ? JSON.stringify([snapshot.conversation.projectId, snapshot.conversation.id]) : '';
      /** 位置和事件流重建必须重读原文，不能沿用旧句柄。 */
      const revision = JSON.stringify([snapshot?.orderEpoch, snapshot?.eventStreamGeneration, sourcesFingerprint]);
      /** 旧候选仅在来源相同时用于增量读取。 */
      const previous = snapshot && cache.get(key)?.revision === revision ? cache.get(key) : undefined;
      /** 无会话时不创建或持久化会话身份。 */
      let history = previous;
      if (snapshot && (!history || history.throughSequence !== snapshot.collections.modelHistory.throughSequence)) {
        /** 只在本会话内读取增量；突增超过缓存预算时重新选最近原文。 */
        const users = readCandidates(snapshot.conversation.id, 'user', previous?.throughSequence);
        /** 助手材料保留近期状态与问题，不需要跨请求保存长回复正文。 */
        const assistants = readCandidates(snapshot.conversation.id, 'assistant');
        history = {
          revision,
          throughSequence: snapshot.collections.modelHistory.throughSequence,
          opening: previous?.opening ?? repository.listModelHistoryPage({ conversationId: snapshot.conversation.id, dialogueRole: 'user', entryLimit: 1, byteLimit: 16_384 }).items[0] ?? null,
          users: previous && !users.hasMore ? uniqueMessages([...previous.users, ...users.items]).slice(-64) : previous ? readCandidates(snapshot.conversation.id, 'user').items : users.items,
          assistants: assistants.items.slice(-24),
        };
        cache.delete(key);
        cache.set(key, history);
        while (cache.size > 32) cache.delete(cache.keys().next().value!);
      }
      /** 原始需求始终参与候选，不因历史跨越三轮而消失。 */
      const users = uniqueMessages([...(history?.opening ? [history.opening] : []), ...(history?.users ?? [])]);
      /** 最新用户原话和草稿用于检索，不能由助手末句定义用户目标。 */
      const query = `${input.draft ?? ''}\n${users
        .slice(-4)
        .map((item) => item.content.preview)
        .join('\n')}`.slice(0, 12_000);
      /** 最新修正优先于普通相关历史，原始需求仍保留独立位置。 */
      const prioritizedUsers = [
        users.at(-1),
        users[0],
        ...users.slice(-4).reverse(),
        ...users.slice(1, -4).sort((left, right) => Number(relevantEmployeeKnowledge(right.content.preview, query)) - Number(relevantEmployeeKnowledge(left.content.preview, query)) || right.sequence - left.sequence),
      ].filter((item): item is ConversationModelHistoryPageItem => Boolean(item));
      /** 用主会话状态标识材料，不将回复结束视为业务验收。 */
      const turn = snapshot?.activeTurn ?? snapshot?.recentClosedTurns[0];
      /** 失败与中断也保留当前要求，不能改用更早的成功回复冒充现状。 */
      const state = !turn
        ? '尚无运行轮次。'
        : turn.status === 'failed' || turn.status === 'interrupted' || turn.hasError
          ? '本轮失败或中断，不能假定任务完成。'
          : turn.status === 'completed'
            ? '本轮回复已结束，不代表任务已经验收。'
            : '本轮仍在进行，助手阶段进展可能尚无最终结果。';
      /** 任务和记忆单独占用最多 4,000 字符。 */
      const support = renderSources(input.sources, input.projectId, query, state);
      /** 助手最多占用 4,000 字符；其余全部优先留给用户原话。 */
      const assistant = snapshot ? renderMessages(repository, snapshot.conversation.id, [...(history?.assistants ?? [])].reverse(), 3_996) : [];
      /** 每条消息前的分隔符计入占用，用户可使用任务、记忆和助手剩余的全部额度。 */
      const assistantLength = assistant.reduce((length, entry) => length + entry.text.length + 2, 0);
      /** 保留用户原话的选择优先级，最终展示顺序不参与预算竞争。 */
      const user = snapshot ? renderMessages(repository, snapshot.conversation.id, prioritizedUsers, 16_000 - support.length - assistantLength) : [];
      /** 入选后统一按消息时间及同时间序号排列，最新用户修正不会被移到此前助手回复之前。 */
      const dialogue = [...user, ...assistant]
        .sort((left, right) => (left.item.messageCreatedAt ?? left.item.confirmedAt).localeCompare(right.item.messageCreatedAt ?? right.item.confirmedAt) || left.item.sequence - right.item.sequence)
        .map((entry) => entry.text);
      return { text: [support, ...dialogue].join('\n\n'), hasDialogue: users.length > 0, sourcesFingerprint };
    },
  };
}
