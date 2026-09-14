import { createHash } from 'node:crypto';
import { TaskWorkStoreError, type ConversationProviderItemRepository, type TaskWorkDeliverableBundle, type TaskWorkRunRecord, type TurnChangeSetRepository, type TaskWorkDeploymentReceipt } from '@zeus/storage';

/** 冻结原会话真实产物，不通过模型文字推断代码、验证或部署成功。 */
export function captureTaskWorkEvidence(input: {
  run: TaskWorkRunRecord;
  message: { id: string; content: string };
  changes: TurnChangeSetRepository;
  providerItems: ConversationProviderItemRepository;
  deployments?: TaskWorkDeploymentReceipt[];
  /** 原安排的交付要求随同证据缺口展示。 */
  requiredKinds?: TaskWorkDeliverableBundle['availableKinds'];
}): {
  content: string;
  bundle: TaskWorkDeliverableBundle;
} {
  /** 来源摘要随正文一起冻结，后续会话改变不会改写这份成果。 */
  const bundle: TaskWorkDeliverableBundle = { availableKinds: ['document'], sources: [{ kind: 'message', id: input.message.id, sha256: digest(input.message.content), status: 'submitted' }], gaps: [] };
  /** 说明与机器证据分开排列，避免把运行日志包装成验收结论。 */
  const sections = ['## 成果说明', input.message.content];
  if (input.run.conversationId) {
    /** 读取该工作独占会话的已记录变更，不读取项目其他现场。 */
    const changes = input.changes.listByConversation(input.run.conversationId);
    for (const change of changes) {
      if (change.state !== 'applied' || !change.unifiedDiff.trim()) {
        if (change.state !== 'undone') bundle.gaps.push(`变更 ${change.id} 未形成完整可审查差异：${change.unavailableReason ?? change.state}`);
        continue;
      }
      bundle.sources.push({ kind: 'change_set', id: change.id, sha256: digest(change.unifiedDiff), status: change.state });
      if (!bundle.availableKinds.includes('code')) bundle.availableKinds.push('code');
      sections.push(`## 代码变更 · ${change.id}`, `提交前摘要：${change.preImageDigest ?? '未提供'}\n\n提交后摘要：${change.postImageDigest ?? '未提供'}`, fenced(change.unifiedDiff, 'diff'));
    }
    /** 命令证据只复制明确的完成记录与输出，不用命令名字猜测验证范围。 */
    const commands = input.providerItems.listByConversation(input.run.conversationId).filter((item) => item.itemType === 'commandExecution');
    for (const command of commands) {
      /** Provider 明确字段以外的内容不进入成果元数据。 */
      const payload = readCommandPayload(command.payloadJson);
      if (!payload) {
        bundle.gaps.push(`命令 ${command.id} 的原始记录无法读取。`);
        continue;
      }
      /** 部分来源将原始项目放入 item 包装中。 */
      const detail = payload.item && typeof payload.item === 'object' ? (payload.item as Record<string, unknown>) : payload;
      /** 完整输出优先使用 Provider 原始字段。 */
      const output = typeof detail.aggregatedOutput === 'string' ? detail.aggregatedOutput : command.textContent;
      /** 只有真实数字返回值才记录成功与失败。 */
      const exitCode = typeof detail.exitCode === 'number' ? detail.exitCode : null;
      /** 命令文本不从任意工具参数中推测。 */
      const title = typeof detail.command === 'string' ? detail.command : command.id;
      if (command.status === 'in_progress') {
        bundle.gaps.push(`命令 ${command.id} 尚无完成结果。`);
        continue;
      }
      bundle.sources.push({ kind: 'command', id: command.id, command: title, sha256: digest(JSON.stringify({ title, output, exitCode })), status: exitCode === 0 ? 'passed' : exitCode !== null ? 'failed' : 'unverified' });
      if (exitCode !== null && !bundle.availableKinds.includes('verification')) bundle.availableKinds.push('verification');
      if (exitCode !== 0) bundle.gaps.push(`命令 ${command.id} ${exitCode === null ? '缺少明确退出状态' : `退出状态为 ${exitCode}`}，请审查其影响。`);
      sections.push(`## 执行记录 · ${command.id}`, fenced(title, 'text'), `退出状态：${exitCode ?? '未提供'}。此记录只证明命令执行结果，验证范围需要结合任务标准审查。`, fenced(output, 'text'));
    }
  }
  if (input.deployments?.length) {
    bundle.deployments = input.deployments;
    for (const receipt of input.deployments) {
      bundle.sources.push({ kind: 'deployment', id: receipt.id, sha256: receipt.contentSha256, status: receipt.outcome });
      sections.push(
        `## 部署凭证 · ${receipt.id}`,
        '以下环境、修订与结果是执行员工的声明；命令输出来自原运行记录，仍需结合交付标准审查。',
        fenced(
          `环境：${receipt.environment}\n代码或产物修订：${receipt.revision}\n地址：${receipt.url}\n声明结果：${receipt.outcome === 'succeeded' ? '成功，待审查确认' : receipt.outcome === 'failed' ? '失败' : '尚未确认'}\n记录时间：${receipt.createdAt}\n说明：${receipt.summary}`,
          'text',
        ),
      );
      for (const command of receipt.commands)
        sections.push(
          `### ${command.purpose === 'deploy' ? '部署' : '验证'}依据 · ${command.id}`,
          fenced(command.command, 'text'),
          `退出状态：${command.exitCode ?? '未知'}；完成时间：${command.completedAt ?? '未提供'}`,
          fenced(command.output, 'text'),
        );
      if (receipt.outcome !== 'succeeded') bundle.gaps.push(`部署凭证 ${receipt.id} 的结果为${receipt.outcome === 'failed' ? '失败' : '未知'}，不能当作部署成功。`);
    }
    /** 只把有两类成功依据的最后一次部署计为所需成果，旧失败仍保留待审缺口。 */
    const latest = input.deployments.at(-1)!;
    if (latest.outcome === 'succeeded' && ['deploy', 'verify'].every((purpose) => latest.commands.some((command) => command.purpose === purpose && command.exitCode === 0))) bundle.availableKinds.push('deployment');
  }
  for (const kind of input.requiredKinds ?? []) {
    if (!bundle.availableKinds.includes(kind)) bundle.gaps.push(`尚缺少安排要求的${{ document: '成果说明', code: '代码差异', verification: '运行验证', deployment: '部署及后续验证凭证' }[kind]}，请补充后再验收。`);
  }
  if (bundle.gaps.length) sections.push('## 需要核对的证据缺口', ...bundle.gaps.map((gap) => `- ${gap}`));
  /** 有界资产读取契约下拒绝截断后冒充完整成果。 */
  const content = sections.join('\n\n');
  if (Buffer.byteLength(content, 'utf8') > 12 * 1024 * 1024) throw new Error('成果证据超过单份正文上限，请在原会话中整理分块成果后重新提交。');
  return { content, bundle };
}

/** 凭证引用必须来自原工作会话，完成前或缺少退出状态时不能宣称成功。 */
export function captureDeploymentCommands(
  run: TaskWorkRunRecord,
  providerItems: ConversationProviderItemRepository,
  input: { deploymentCommandId: string; verificationCommandId?: string; outcome: 'succeeded' | 'failed' | 'unknown' },
): TaskWorkDeploymentReceipt['commands'] {
  /** 两个不同命令分别提供执行和后续核对证据。 */
  const identities = [{ id: input.deploymentCommandId, purpose: 'deploy' as const }, ...(input.verificationCommandId ? [{ id: input.verificationCommandId, purpose: 'verify' as const }] : [])];
  if (input.outcome === 'succeeded' && (!input.verificationCommandId || input.deploymentCommandId === input.verificationCommandId))
    throw new TaskWorkStoreError('ZEUS_TASK_WORK_DEPLOYMENT_EVIDENCE', '成功凭证需要分别引用部署命令和后续验证命令。');
  /** 工具只能看到该工作独占会话的命令。 */
  const records = run.conversationId ? providerItems.listByConversation(run.conversationId) : [];
  /** 成功凭证的验证必须在部署结束后开始，不能拿部署前的检查冒充结果。 */
  if (input.outcome === 'succeeded') {
    const deployed = records.find((item) => item.id === input.deploymentCommandId);
    const verified = records.find((item) => item.id === input.verificationCommandId);
    if (!deployed?.completedAt || !verified?.startedAt || !Number.isFinite(Date.parse(deployed.completedAt)) || !Number.isFinite(Date.parse(verified.startedAt)) || Date.parse(verified.startedAt) < Date.parse(deployed.completedAt))
      throw new TaskWorkStoreError('ZEUS_TASK_WORK_DEPLOYMENT_EVIDENCE', '成功凭证需要部署完成后执行的验证记录。');
  }
  return identities.map(({ id, purpose }) => {
    /** 拒绝其他运行来源及未完成的命令记录。 */
    const record = records.find((item) => item.id === id && item.itemType === 'commandExecution');
    if (!record || record.status === 'in_progress') throw new TaskWorkStoreError('ZEUS_TASK_WORK_DEPLOYMENT_EVIDENCE', '引用命令不属于本工作，或执行尚未结束。');
    /** 不补造被截断或损坏的原始载荷。 */
    const payload = readCommandPayload(record.payloadJson);
    const detail = payload?.item && typeof payload.item === 'object' ? (payload.item as Record<string, unknown>) : payload;
    if (!detail || typeof detail.command !== 'string') throw new TaskWorkStoreError('ZEUS_TASK_WORK_DEPLOYMENT_EVIDENCE', '命令原始记录不完整，不能生成部署凭证。');
    const exitCode = typeof detail.exitCode === 'number' && Number.isInteger(detail.exitCode) ? detail.exitCode : null;
    if (input.outcome === 'succeeded' && (record.status !== 'completed' || exitCode !== 0)) throw new TaskWorkStoreError('ZEUS_TASK_WORK_DEPLOYMENT_EVIDENCE', '部署或验证命令没有成功完成，不能记录为成功。');
    const output = typeof detail.aggregatedOutput === 'string' ? detail.aggregatedOutput : record.textContent;
    return { id, purpose, command: detail.command, output, exitCode, completedAt: record.completedAt, sha256: digest(JSON.stringify({ command: detail.command, output, exitCode })) };
  });
}

/** 使用比正文更长的围栏，原代码无法逃逸成成果说明。 */
function fenced(content: string, language: string): string {
  /** 围栏长度由真实正文决定，不改动原文。 */
  let width = 3;
  for (const match of content.matchAll(/`+/g)) width = Math.max(width, match[0].length + 1);
  /** 围栏仅占用最长连续反引号长度，不展开大数组。 */
  const fence = '`'.repeat(width);
  return `${fence}${language}\n${content}\n${fence}`;
}
/** 所有证据摘要使用同一种内容哈希。 */
function digest(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** 原始记录损坏时保留证据缺口，不丢弃整份成果。 */
function readCommandPayload(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
