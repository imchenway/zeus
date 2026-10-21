import { estimateModelUsageWithSnapshot, sumEstimatedCosts, type EstimatedMoney, type UsageRequestPriceSnapshot } from './modelPricing.js';
import type { CodexUsageEstimate } from './codexUsage.js';

/** 会话浮层按需读取的信息，不参与消息首屏和实时事件的加载。 */
export interface ConversationInformation {
  /** 输入包含缓存读写，按次计费单独保留。 */
  cost: { input: EstimatedMoney[]; output: EstimatedMoney[]; perRequest: EstimatedMoney[]; complete: boolean };
  /** 只包含有调用或技能读取事实的资源，不使用已安装目录冒充使用记录。 */
  resources: { mcp: string[]; skills: string[] };
}

/** 按每次请求冻结的费率拆分，不使用当前模型价格或 Token 比例分摊。 */
export function conversationCostBreakdown(requests: UsageRequestPriceSnapshot[]): ConversationInformation['cost'] {
  /** 各计费类别分别聚合，币种之间不相加。 */
  const parts: Record<'input' | 'output' | 'perRequest', CodexUsageEstimate[]> = { input: [], output: [], perRequest: [] };
  /** 空账本没有完整的费用依据。 */
  let complete = requests.length > 0;
  for (const request of requests) {
    /** 请求的历史费率决定拆分方式。 */
    const rate = request.estimate.rateSnapshot;
    if (rate.price?.perRequest != null) {
      parts.perRequest.push(request.estimate);
      complete &&= Boolean(request.estimate.costs?.length || request.estimate.apiEquivalentUsd !== null);
      continue;
    }
    /** 输入费用沿用已有计价函数，保留缓存读写并移除输出。 */
    const input = estimateModelUsageWithSnapshot({ ...request.usage, totalTokens: request.usage.inputTokens, outputTokens: 0, reasoningOutputTokens: 0 }, rate);
    /** 输出费用移除全部输入类别，避免重复计算缓存。 */
    const output = estimateModelUsageWithSnapshot({ ...request.usage, totalTokens: request.usage.outputTokens, inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0 }, rate);
    parts.input.push(input);
    parts.output.push(output);
    complete &&= Boolean(input.costs?.length || input.apiEquivalentUsd !== null) && Boolean(output.costs?.length || output.apiEquivalentUsd !== null);
  }
  return { input: sumEstimatedCosts(parts.input), output: sumEstimatedCosts(parts.output), perRequest: sumEstimatedCosts(parts.perRequest), complete };
}

/** 原生与历史工具记录共用资源提取，不扫描助手正文或任意命令文本。 */
export function conversationUsedResources(items: Array<{ type: string; payload: Record<string, unknown> }>, selectedSkills: string[] = []): ConversationInformation['resources'] {
  /** 同一工具重复调用只展示一次，顺序保留首次出现位置。 */
  const mcp = new Set<string>();
  /** 仅合入已接受提交中明确使用的技能。 */
  const skills = new Set(selectedSkills);
  /** 两个平台均以实际读取的技能入口文件确定名称。 */
  const addSkillPath = (value: unknown): void => {
    if (typeof value !== 'string') return;
    /** 文件的父目录是本地技能身份，不将任意路径正文解释为调用。 */
    const match = value.match(/(?:^|[\\/])([^\\/]+)[\\/]SKILL\.md$/iu);
    if (match?.[1]) skills.add(match[1]);
  };
  for (const item of items) {
    /** 供应商类型名称归一后只匹配已有的工具类别。 */
    const type = item.type.replace(/[_-]/gu, '').toLowerCase();
    /** 用户和助手正文即使含有同名字段，也不构成工具调用。 */
    const toolCall = ['mcptoolcall', 'dynamictoolcall', 'toolcall', 'tool', 'commandexecution'].includes(type);
    /** 工具身份只读取结构化字段。 */
    const payload = item.payload;
    /** 插件工具保留独立命名空间。 */
    const namespace = informationString(payload.server ?? payload.namespace);
    /** 不同供应商的工具名归为同一展示字段。 */
    const name = informationString(payload.tool ?? payload.toolName ?? payload.name);
    if (type === 'mcptoolcall' || (toolCall && (namespace?.startsWith('zeus_mcp_') || name?.startsWith('mcp__') || name?.startsWith('zeus_mcp_')))) {
      /** 缺少工具名称时仍保留已确认的服务器。 */
      const label = [namespace, name].filter(Boolean).join(' / ');
      if (label) mcp.add(label);
    }
    /** 调用参数可能仍是 JSON 字符串，未完成或无效内容不推断。 */
    let args = informationRecord(payload.arguments ?? payload.args);
    if (typeof (payload.arguments ?? payload.args) === 'string') {
      try {
        args = informationRecord(JSON.parse(String(payload.arguments ?? payload.args)));
      } catch {
        // 不完整参数等待后续记录补齐，不从破损文本猜测资源身份。
      }
    }
    if (toolCall && (name === 'read' || name === 'read_file')) addSkillPath(args.path ?? args.file_path);
    if (toolCall && ((namespace === 'skills' && name === 'read') || name === 'skills.read')) {
      /** 远端技能保留正式资源标识，不假造本地文件位置。 */
      const skill = informationString(args.package ?? args.resource);
      if (skill) skills.add(skill);
    }
    if (type === 'commandexecution' && Array.isArray(payload.commandActions)) {
      for (const action of payload.commandActions) {
        /** 仅接受供应商明确标注的读取动作。 */
        const record = informationRecord(action);
        if (record.type === 'read') addSkillPath(record.path);
      }
    }
  }
  return { mcp: [...mcp], skills: [...skills] };
}

/** 外部工具参数仅接受普通对象形态。 */
function informationRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** 空白身份不能成为清单中的有效记录。 */
function informationString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
