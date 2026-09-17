/** 将实时事件和历史过程转换为同一组对话组件识别的类型与字段。 */
export function conversationProcessPresentation(kind: string, detail: unknown): { type: string; payload: Record<string, unknown> } {
  /** 原始记录保留协议来源，展示只依赖活动及工具定义。 */
  const record = processRecord(detail);
  /** 调用参数来自调用块，执行结果覆盖完成时更新的字段。 */
  const source = { ...processRecord(record.block), ...processRecord(record.payload ?? (record.block ? {} : record)) };
  /** 只转发已有组件消费的字段，避免原始事件决定任意显示行为。 */
  const payload: Record<string, unknown> = {};
  for (const key of [
    'type',
    'command',
    'cwd',
    'aggregatedOutput',
    'output',
    'stdout',
    'stderr',
    'name',
    'toolName',
    // 原生工具的身份与返回状态必须在历史和实时展示中一致。
    'tool',
    'namespace',
    'server',
    'success',
    'isError',
    'contentItems',
    'toolResult',
    'arguments',
    'args',
    'query',
    'status',
    'error',
    'summary',
    'content',
    'presentation',
    'commandActions',
    'filePath',
    'changes',
    'exitCode',
    'requestType',
    'recovery',
    'submissionAuthority',
    'providerThreadId',
    'providerTurnId',
    'providerItemId',
    'callId',
    'questions',
    'outcome',
    'answers',
    'resolutionReason',
  ]) {
    if (source[key] !== undefined && source[key] !== null) payload[key] = source[key];
  }
  for (const key of ['provider', 'itemType', 'eventType', 'protocolFamily', 'stageId', 'reasoningPresentation']) {
    if (record[key] !== undefined) payload[key] = record[key];
  }
  /** 标准过程类型与 app-server 共用；等待和重试说明不伪装成工具或可回答问题。 */
  let type =
    kind === 'reasoning'
      ? 'reasoning'
      : kind === 'command'
        ? 'commandExecution'
        : kind === 'context_compaction'
          ? 'contextCompaction'
          : kind === 'warning'
            ? 'error'
            : kind === 'waiting'
              ? record.provider === 'pi' && payload.recovery !== 'content_only'
                ? 'commentary'
                : 'requestUserInput'
              : kind === 'retry'
                ? 'commentary'
                : 'dynamicToolCall';
  if (record.provider !== 'pi' || (kind !== 'tool' && kind !== 'command')) {
    // 原生事件已声明工具语义，历史回看不能将文件修改或搜索降级为通用工具。
    if (kind === 'tool' && ['fileChange', 'webSearch', 'imageView', 'mcpToolCall', 'dynamicToolCall'].includes(String(record.itemType))) type = String(record.itemType);
    return { type, payload };
  }
  /** Pi 标准工具跨模型共用同一名称及参数结构。 */
  const name = processString(source.toolName ?? source.name);
  /** 工具结束事件可能没有参数，由持久化调用块补齐。 */
  const args = processRecord(source.args ?? source.arguments ?? source.input);
  /** 文件目标和搜索模式只用于展示，不据此执行或授权操作。 */
  const path = processString(args.path);
  /** 搜索参数保留字面文本，不猜测模型或命令的意图。 */
  const pattern = processString(args.pattern);
  if (name) payload.toolName = name;
  if (name === 'bash') {
    type = 'commandExecution';
    if (processString(args.command)) payload.command = args.command;
  } else if (name === 'read' || name === 'ls' || name === 'grep' || name === 'find') {
    type = 'commandExecution';
    if (path || pattern) payload.commandActions = [{ type: name === 'read' ? 'read' : name === 'ls' ? 'listFiles' : 'search', ...(path ? { path } : {}), ...(pattern ? { query: pattern } : {}) }];
  } else if (name === 'write' || name === 'edit') {
    type = 'fileChange';
    if (path) payload.filePath = path;
  }
  /** 返回正文和不可变结果句柄分别供共享工具输出与分页组件使用。 */
  const result = processRecord(source.result ?? source.partialResult);
  /** 实际执行结果中的文本块，不包含图片等非文本数据。 */
  const output = Array.isArray(result.content) ? result.content.flatMap((block) => (processRecord(block).type === 'text' && typeof processRecord(block).text === 'string' ? [processRecord(block).text as string] : [])).join('\n') : '';
  /** 结果归档由宿主负责，展示只消费已有句柄。 */
  const resultDetails = processRecord(result.details);
  if (result.isError === true) payload.isError = true;
  if (Number.isInteger(resultDetails.exitCode)) payload.exitCode = resultDetails.exitCode;
  if (output) payload.output = output;
  if (processString(resultDetails.toolResultHandle)) payload.toolResult = { handle: resultDetails.toolResultHandle, projection: JSON.stringify({ text: output }), projectionTruncated: true };
  return { type, payload };
}

/** 过程存储与实时消息共用 Provider 身份，历史调用块和执行结果归于同一项。 */
export function conversationProcessProviderItemId(sourceEventId: string | null): string | null {
  if (!sourceEventId) return null;
  for (const pattern of [/^codex:item:(.+)$/u, /^pi:block:(.+)$/u, /^pi:(?:tool_execution|tool_call|toolcall):(.+)$/u]) {
    /** 只识别已有来源前缀，不从正文猜测调用编号。 */
    const match = sourceEventId.match(pattern);
    if (match?.[1]) return match[1];
  }
  return null;
}

/** 外部事件中的对象只接受普通记录形态。 */
function processRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** 空字段不能覆盖之前已确认的工具名称或目标。 */
function processString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}
