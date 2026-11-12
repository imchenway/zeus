import type { WorkflowToolReference, WorkflowValue } from '@zeus/shared';
import type { DigitalTeamWorkflowRunRecord } from '@zeus/storage';
import type { ZeusConversationPluginRuntime } from './zeusConversationPluginRuntime.js';
import { createZeusPluginMcpApprovalEvidence } from './zeusPluginMcpBroker.js';

/** Invoke 工具沿用现有 Plugin broker，保存的引用不能覆盖当前策略或借用其他项目授权。 */
export async function invokeWorkflowPluginTool(
  options: {
    /** 当前真实项目身份，由会话仓储读取。 */
    conversationProjectId?: string | null;
    /** 已启用 Plugin 运行时。 */
    runtime: Pick<ZeusConversationPluginRuntime, 'getCatalog' | 'invokeMcp'>;
  },
  run: DigitalTeamWorkflowRunRecord,
  reference: WorkflowToolReference,
  input: Record<string, WorkflowValue>,
  approved: boolean,
  signal?: AbortSignal,
): Promise<WorkflowValue> {
  /** 策略拒绝或工具已返回的明确失败，不等同于连接中断后的未知结果。 */
  const reject = (message: string): never => {
    throw Object.assign(new Error(message), { code: 'ZEUS_WORKFLOW_TOOL_REJECTED' });
  };
  if (options.conversationProjectId !== run.projectId) reject('工具授权会话不属于当前项目。');
  const catalog = await options.runtime.getCatalog(reference.conversationId);
  const tool = catalog.tools.find(
    (candidate) =>
      candidate.name === reference.tool.name && candidate.pluginRevisionId === reference.tool.pluginRevisionId && candidate.definitionSha256 === reference.tool.definitionSha256 && candidate.approvalMode === reference.tool.approvalMode,
  );
  if (!tool || tool.approvalMode === 'deny') return reject('工具定义、修订或权限已变化。');
  if (run.runtimeState.permissionMode !== 'full-access' && tool.readOnly !== true) return reject('当前流程只允许明确只读的工具；写入工具需要本次完整授权。');
  if (tool.approvalMode === 'prompt' && !approved) return reject('此工具需要绑定本次准确输入的人工批准。');
  const result = await options.runtime.invokeMcp({ conversationId: reference.conversationId, tool, args: input, approval: createZeusPluginMcpApprovalEvidence(tool, input, approved ? 'user' : 'policy'), signal });
  if (result.isError) return reject(result.text || '工具返回执行失败。');
  if (result.images?.length) return reject('图像输出需要通过固定成果引用交接，请使用提供结构化成果引用的工具。');
  return JSON.parse(JSON.stringify(result.structuredContent ?? { text: result.text })) as WorkflowValue;
}
