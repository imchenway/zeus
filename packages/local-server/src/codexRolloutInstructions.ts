import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { extname, isAbsolute } from 'node:path';

/** 原生规则输入保留实际所属轮次、完整正文与发生时间。 */
export interface CodexRolloutInstruction {
  /** 原始消息与内容块共同决定稳定显示身份。 */
  id: string;
  /** 原生轮次身份，不用读取时的活动轮次代替。 */
  turnId: string;
  /** 保留规则与替换说明的原文。 */
  text: string;
  /** 原始记录时间，无有效时间时交给所属轮次提供时间。 */
  occurredAt: string | null;
}

/** 追加读取只保留尚未归属到本地轮次的规则更新。 */
interface InstructionCursor {
  /** 文件重建时据此重新核对线程身份。 */
  identity: string;
  /** 已读取的完整行末尾字节位置。 */
  offset: number;
  /** 线程身份只从原始 session_meta 获取。 */
  threadId: string | null;
  /** 初次载入的规则不作为更新重复展示。 */
  initialized: boolean;
  /** 实时通知可能先于本地轮次创建，暂存到下一次同源读取。 */
  pending: Map<string, CodexRolloutInstruction>;
}

/** 从受绑定的原生日志增量补充 App Server 未提供的规则更新事实。 */
export class CodexRolloutInstructionReader {
  /** 各线程独立维护追加位置，避免每个事件重复扫描全部历史。 */
  private readonly cursors = new Map<string, InstructionCursor>();

  /** 只消费来源与线程均已确认的完整记录，未就绪的轮次留待下次处理。 */
  async read(input: { rolloutPath: string | null; providerThreadId: string; project(record: CodexRolloutInstruction): boolean }): Promise<void> {
    if (!input.rolloutPath || !isAbsolute(input.rolloutPath) || extname(input.rolloutPath).toLowerCase() !== '.jsonl') return;
    /** 路径只来自会话绑定，拒绝符号链接和不可读取文件。 */
    const information = await lstat(input.rolloutPath).catch(() => null);
    if (!information?.isFile() || information.isSymbolicLink()) return;
    /** 同一真实文件与线程共用游标，切换原生线程不能串入旧上下文。 */
    const path = await realpath(input.rolloutPath).catch(() => null);
    if (!path) return;
    /** inode 与创建时间区分日志轮换，长度回退也必须重新扫描。 */
    const identity = `${information.dev}:${information.ino}:${information.birthtimeMs}`;
    /** 真实路径限制同一日志的重复读取。 */
    const key = `${input.providerThreadId}:${path}`;
    /** 文件发生轮换时丢弃旧的线程判定和半轮次内容。 */
    let cursor = this.cursors.get(key);
    if (!cursor || cursor.identity !== identity || cursor.offset > information.size) {
      cursor = { identity, offset: 0, threadId: null, initialized: false, pending: new Map() };
      this.cursors.set(key, cursor);
    }
    if (cursor.threadId && cursor.threadId !== input.providerThreadId) return;
    if (information.size > cursor.offset) {
      /** 本次只读已观察到的长度，后续追加在下一次边界通知中处理。 */
      const stream = createReadStream(path, { start: cursor.offset, end: information.size - 1 });
      /** 完整行才推进游标，写到一半的 JSON 不会被永久跳过。 */
      let pending: Buffer = Buffer.alloc(0);
      try {
        for await (const chunk of stream) {
          /** 按字节拼接，UTF-8 中文跨块时不损坏原文。 */
          const bytes = pending.length ? Buffer.concat([pending, chunk]) : (chunk as Buffer);
          /** 当前缓冲区中已处理的完整行结束位置。 */
          let start = 0;
          /** 逐行读取避免将整份会话历史保留在内存。 */
          let end = bytes.indexOf(10, start);
          while (end >= 0) {
            this.capture(bytes.subarray(start, end).toString('utf8'), cursor, input.providerThreadId);
            cursor.offset += end + 1 - start;
            start = end + 1;
            end = bytes.indexOf(10, start);
          }
          pending = bytes.subarray(start);
        }
      } catch {
        // 原日志暂不可读时保留已完成的行，不中断模型消息与其他过程投影。
        return;
      }
    }
    if (cursor.threadId !== input.providerThreadId) return;
    for (const [id, record] of cursor.pending) if (input.project(record)) cursor.pending.delete(id);
  }

  /** 严格按内容块来源提取规则，不把用户提及 AGENTS 的普通消息当成更新。 */
  private capture(line: string, cursor: InstructionCursor, expectedThreadId: string): void {
    /** 日志完整行也可能有损坏，局部记录失败不影响后续原始事实。 */
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (!isRecord(entry) || !isRecord(entry.payload)) return;
    /** 原生记录的实际载荷。 */
    const payload = entry.payload;
    if (entry.type === 'session_meta') {
      cursor.threadId = typeof payload.id === 'string' ? payload.id : null;
      return;
    }
    if (cursor.threadId !== expectedThreadId || entry.type !== 'response_item' || payload.type !== 'message' || payload.role !== 'user' || !Array.isArray(payload.content)) return;
    /** 内容类型与来源一同核对，不能仅凭 user 角色或正文判断。 */
    const metadata = isRecord(payload.internal_chat_message_metadata_passthrough) ? payload.internal_chat_message_metadata_passthrough : {};
    if (!Array.isArray(metadata.content_item_kinds) || !metadata.content_item_kinds.includes('agents_md.instructions')) {
      cursor.initialized = true;
      return;
    }
    if (typeof metadata.turn_id !== 'string' || !Array.isArray(metadata.content_item_metadata)) return;
    /** 首次规则载入可能含多个规则块，整条记录都属于同一次初始上下文。 */
    const initial = !cursor.initialized;
    for (const [index, block] of payload.content.entries()) {
      /** 块的来源位置与原始内容位置严格一致。 */
      const source = metadata.content_item_metadata[index];
      if (metadata.content_item_kinds[index] !== 'agents_md.instructions' || !isRecord(source) || !isRecord(source.provenance) || source.provenance.type !== 'agents_md') continue;
      if (!isRecord(block) || block.type !== 'input_text' || typeof block.text !== 'string' || !block.text.trim()) continue;
      cursor.initialized = true;
      if (initial) continue;
      /** 原生消息身份优先，缺失时以原始记录内容生成稳定身份。 */
      const messageId = typeof payload.id === 'string' && payload.id ? payload.id : createHash('sha256').update(line).digest('hex');
      /** 一个输入记录可能有多块规则，分别保留原位置。 */
      const id = `${messageId}:agents-md:${index}`;
      cursor.pending.set(id, {
        id,
        turnId: metadata.turn_id,
        text: block.text,
        occurredAt: typeof entry.timestamp === 'string' && Number.isFinite(Date.parse(entry.timestamp)) ? entry.timestamp : null,
      });
    }
  }
}

/** 只把 JSON 对象当作结构化来源。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
