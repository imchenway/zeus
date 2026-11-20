import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { ArtifactStore, ConversationToolResultRecord, ZeusDatabase } from '@zeus/storage';
import { isRecord } from './codexNativeConversationPolicy.js';
import { parseJsonObject } from './localServerPlatformSupport.js';

/** 进度与清理后的记录在同一 SQLite 事务中提交。 */
const commandOutputCleanupKey = 'conversation.command_output_cleanup';
/** 清理完成后跳过旧启动诊断扫描。 */
const mcpStartupCleanupKey = 'conversation.mcp_startup_cleanup';

/** 启动进度只属于运行诊断，历史同步从现有快照恢复。 */
export const codexMcpStartupNotification = 'mcpServer/startupStatus/updated';

/** 只匹配归档中逐字相同的输出，同时记录原件是文本还是 Provider 包。 */
function compactArchivedCommandOutput(payload: Record<string, unknown>, result: Pick<ConversationToolResultRecord, 'handle' | 'sha256' | 'byteLength'>, archivedText: string): Record<string, unknown> {
  const output = payload.aggregatedOutput;
  if (typeof output !== 'string' || !output.length) return payload;
  const format = archivedText === output ? 'text' : parseJsonObject(archivedText).aggregatedOutput === output ? 'provider_item' : null;
  if (!format) return payload;
  const compact = { ...payload };
  delete compact.aggregatedOutput;
  return {
    ...compact,
    archivedCommandOutputFormat: format,
    toolResult: { handle: result.handle, sha256: result.sha256, byteLength: result.byteLength, projectionTruncated: true },
  };
}

/** 原件归档后比较持久化的内容哈希，已有工具句柄可能来自不同的完成通知。 */
export function compactNewCommandOutput(payload: Record<string, unknown>, result: ConversationToolResultRecord, archivedText: string): Record<string, unknown> {
  const ref = parseJsonObject(result.projectionJson).artifactRef;
  if (!isRecord(ref) || typeof payload.aggregatedOutput !== 'string') return payload;
  /** 已登记的本地命令原件有时直接保存 stdout，Provider 完成包则保留原始结构。 */
  const output = payload.aggregatedOutput;
  const candidate = ref.contentSha256 === createHash('sha256').update(output).digest('hex') ? output : archivedText;
  return ref.contentSha256 === createHash('sha256').update(candidate).digest('hex') ? compactArchivedCommandOutput(payload, result, candidate) : payload;
}

/** 工作凭证从同一会话的受授权原件恢复命令输出，保留完整正文和原有哈希口径。 */
export function readCommandEvidenceOutput(artifacts: ArtifactStore | undefined, conversationId: string, payload: Record<string, unknown>, fallback: string): string {
  if (typeof payload.aggregatedOutput === 'string') return payload.aggregatedOutput;
  const format = payload.archivedCommandOutputFormat;
  if (format !== 'text' && format !== 'provider_item') return fallback;
  const result = payload.toolResult;
  if (!artifacts || !isRecord(result) || typeof result.handle !== 'string' || typeof result.sha256 !== 'string' || typeof result.byteLength !== 'number' || !Number.isSafeInteger(result.byteLength)) {
    throw new Error('命令输出归档引用不完整。');
  }
  const resolved = artifacts.readAuthorizedSync({
    sha256: result.sha256,
    owner: { kind: 'conversation_tool_result', id: result.handle },
    maximumContentBytes: Math.max(1, result.byteLength),
  });
  if (resolved.ref.owner.conversationId !== conversationId) throw new Error('命令输出归档不属于当前会话。');
  const text = Buffer.from(resolved.bytes).toString('utf8');
  if (format === 'text') return text;
  const output = parseJsonObject(text).aggregatedOutput;
  if (typeof output !== 'string') throw new Error('命令输出归档缺少原始输出字段。');
  return output;
}

/** 按不可变句柄分批清理存量。保留原件缺失、输出不一致和活动中的记录。 */
export async function compactStoredCommandOutputs(db: ZeusDatabase, artifacts: ArtifactStore, shouldStop: () => boolean): Promise<void> {
  type Progress = { cursor: string; done?: true; unreadable?: number };
  const state = db.get<{ value_json: string }>('SELECT value_json FROM settings WHERE key = ?', [commandOutputCleanupKey]);
  const progress = state ? (JSON.parse(state.value_json) as Progress) : { cursor: '' };
  if (progress.done) return;
  let unreadable = progress.unreadable ?? 0;
  while (!shouldStop()) {
    await delay(10);
    if (shouldStop()) return;
    const page = db.select<{ handle: string; sha256: string; conversation_id: string; turn_id: string; segment_id: string; tool_pair_id: string; thread_id: string | null; byte_length: number }>(
      `SELECT r.handle, r.sha256, r.conversation_id, r.turn_id, r.segment_id, r.tool_pair_id, r.byte_length, s.native_session_id AS thread_id
         FROM conversation_tool_results AS r
         JOIN conversation_runtime_segments AS s ON s.id = r.segment_id AND s.conversation_id = r.conversation_id
        WHERE r.handle > ? ORDER BY r.handle LIMIT 64`,
      [progress.cursor],
    );
    const changes: { sql: string; args: string[] }[] = [];
    for (const result of page) {
      if (shouldStop()) return;
      /** 只从对应的会话、执行分段和原生条目读取候选，保留运行中的最新状态。 */
      const copies = db.select<{ kind: 'history' | 'process' | 'provider'; id: string; doc: string }>(
        `SELECT 'history' AS kind, id, content_json AS doc FROM conversation_model_history
           WHERE conversation_id = ? AND turn_id = ? AND segment_id = ? AND tool_pair_id = ? AND role = 'assistant'
             AND json_valid(content_json) AND json_extract(content_json, '$.itemType') = 'commandExecution'
             AND json_type(content_json, '$.payload.aggregatedOutput') = 'text'
         UNION ALL
         SELECT 'process', id, detail_json FROM conversation_process_items
           WHERE segment_id = ? AND source_event_id = ? AND conversation_id = ? AND turn_id = ? AND status != 'in_progress'
             AND json_valid(detail_json) AND json_type(detail_json, '$.payload.aggregatedOutput') = 'text'
         UNION ALL
         SELECT 'provider', id, payload_projection_json FROM conversation_provider_item_states
           WHERE provider_thread_id = ? AND provider_item_id = ? AND conversation_id = ?
             AND item_type = 'commandExecution' AND status != 'in_progress'
             AND json_valid(payload_projection_json) AND json_type(payload_projection_json, '$.aggregatedOutput') = 'text'`,
        [
          result.conversation_id,
          result.turn_id,
          result.segment_id,
          result.tool_pair_id,
          result.segment_id,
          `codex:item:${result.tool_pair_id}`,
          result.conversation_id,
          result.turn_id,
          result.thread_id,
          result.tool_pair_id,
          result.conversation_id,
        ],
      );
      if (!copies.length) continue;
      let archivedText: string;
      try {
        const archive = await artifacts.readAuthorized({
          sha256: result.sha256,
          owner: { kind: 'conversation_tool_result', id: result.handle },
          maximumContentBytes: Math.max(1, result.byte_length),
        });
        if (archive.ref.owner.conversationId !== result.conversation_id) throw new Error('工具结果归档会话不匹配。');
        archivedText = Buffer.from(archive.bytes).toString('utf8');
      } catch {
        unreadable++;
        continue;
      }
      for (const copy of copies) {
        const doc = parseJsonObject(copy.doc);
        const payload = copy.kind === 'provider' ? doc : doc.payload;
        if (!isRecord(payload)) continue;
        const compact = compactArchivedCommandOutput(payload, { ...result, byteLength: result.byte_length }, archivedText);
        if (compact === payload) continue;
        /** 原文同时参与条件匹配，异步读取文件期间修改过的记录交给原写入方处理。 */
        const update = {
          history: 'UPDATE conversation_model_history SET content_json = ? WHERE id = ? AND content_json = ?',
          process: 'UPDATE conversation_process_items SET detail_json = ? WHERE id = ? AND detail_json = ?',
          provider: "UPDATE conversation_provider_item_states SET payload_projection_json = ?, text_projection = CASE WHEN text_projection = ? THEN '' ELSE text_projection END WHERE id = ? AND payload_projection_json = ?",
        }[copy.kind];
        /** 过程文本与归档输出一致时也去掉副本。 */
        const output = String(payload.aggregatedOutput);
        if (copy.kind === 'process' && doc.text === output) doc.text = '';
        changes.push({
          sql: update,
          args: [JSON.stringify(copy.kind === 'provider' ? compact : { ...doc, payload: compact }), ...(copy.kind === 'provider' ? [output] : []), copy.id, copy.doc],
        });
      }
    }
    if (shouldStop()) return;
    const cursor = page.at(-1)?.handle ?? progress.cursor;
    db.transaction(() => {
      for (const change of changes) db.execute(change.sql, change.args);
      /** 现有历史读取会从结果表还原完全一致的预览。保留旧记录不一致的投影。 */
      for (const result of page) {
        db.execute(
          `UPDATE conversation_model_history AS history
              SET content_json = json_remove(history.content_json, '$.projection')
            WHERE conversation_id = ? AND turn_id = ? AND role = 'tool' AND tool_pair_id = ?
              AND json_valid(history.content_json)
              AND json_extract(history.content_json, '$.handle') = ?
              AND json_type(history.content_json, '$.projection') = 'text'
              AND json_extract(history.content_json, '$.projection') =
                  (SELECT json_extract(projection_json, '$.text') FROM conversation_tool_results
                    WHERE handle = ? AND json_valid(projection_json))`,
          [result.conversation_id, result.turn_id, result.tool_pair_id, result.handle, result.handle],
        );
      }
      db.execute('INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at', [
        commandOutputCleanupKey,
        JSON.stringify({ cursor, ...(page.length ? {} : { done: true }), unreadable }),
        new Date().toISOString(),
      ]);
    });
    await db.save();
    if (!page.length) {
      if (unreadable) console.warn(`Zeus 已保留 ${unreadable} 个无法核对原件的会话工具结果副本。`);
      return;
    }
    progress.cursor = cursor;
  }
}

/** 丢弃旧 MCP 事件所在的补拉前缀，推进基线让客户端读取快照，避免在游标内留下断点。 */
export async function clearMcpStartupHistory(db: ZeusDatabase, shouldStop: () => boolean): Promise<void> {
  if (db.get('SELECT key FROM settings WHERE key = ?', [mcpStartupCleanupKey])) return;
  let conversationId = '';
  let generationId = '';
  while (!shouldStop()) {
    await delay(10);
    if (shouldStop()) return;
    const page = db.select<{ conversation_id: string; generation_id: string }>(
      `SELECT conversation_id, generation_id FROM conversation_sync_event_streams
        WHERE (conversation_id, generation_id) > (?, ?) ORDER BY conversation_id, generation_id LIMIT 32`,
      [conversationId, generationId],
    );
    db.transaction(() => {
      for (const stream of page) {
        const ids = [stream.conversation_id, stream.generation_id];
        const sequence = db.get<{ sequence: number | null }>(
          `SELECT MAX(sequence) AS sequence FROM conversation_sync_events
            WHERE conversation_id = ? AND generation_id = ? AND json_extract(payload_json, '$.type') = 'conversation.mcpStartup.changed'`,
          ids,
        )?.sequence;
        if (sequence == null) continue;
        db.execute('DELETE FROM conversation_sync_events WHERE conversation_id = ? AND generation_id = ? AND sequence <= ?', [...ids, sequence]);
        db.execute('UPDATE conversation_sync_event_streams SET base_sequence = ? WHERE conversation_id = ? AND generation_id = ?', [sequence + 1, ...ids]);
      }
      if (!page.length) {
        db.execute('DELETE FROM provider_event_receipts WHERE method = ?', [codexMcpStartupNotification]);
        db.execute("DELETE FROM settings WHERE key = 'codex.native.mcp_startup_status'");
        db.execute('INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)', [mcpStartupCleanupKey, 'true', new Date().toISOString()]);
      }
    });
    await db.save();
    const last = page.at(-1);
    if (!last) return;
    conversationId = last.conversation_id;
    generationId = last.generation_id;
  }
}
