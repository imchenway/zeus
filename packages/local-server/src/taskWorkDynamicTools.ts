import type { CodexDynamicToolSpec } from '@zeus/ai-runtime';
import type { BrowserAutomationToolCall, BrowserAutomationToolResult } from './browserAutomation.js';

/** 本地工作工具只接受调用者原会话身份，不让模型指定别人的工作。 */
export interface TaskWorkToolPort {
  /** 查询或在当前授权安排内拆出子工作。 */
  invoke(input: BrowserAutomationToolCall): Promise<BrowserAutomationToolResult>;
}

/** 原始 Provider 工具用于编排真实工作，不生成模型内部不可见的伪员工。 */
export function zeusWorkDynamicTools(): CodexDynamicToolSpec[] {
  return [
    {
      type: 'namespace',
      name: 'zeus_work',
      description:
        '在当前任务中读取工作、把用户明确的执行要求正式指派、按已授权成员范围委派及记录部署凭证。先 inspect 核对来源和现有安排。讨论和建议不自动变成执行要求；用户明确要求开始执行时才 assign。已有工作内的拆分只用 delegate。暂停和未知外部结果不会自动重放。',
      tools: [
        {
          type: 'function',
          name: 'inspect',
          description: '读取当前任务讨论的用户请求身份、实际员工和现有分工；执行会话返回当前工作、允许委派成员、子成果、命令证据和部署凭证。',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        },
        {
          type: 'function',
          name: 'assign',
          description:
            '只在用户明确要求执行时，把当前任务讨论转成正式工作。必须引用 inspect 返回的当前用户请求身份；先复用已有待执行分工，不重复另建整项任务。已有安排只调整所选分工，不启动或恢复整套安排；没有安排时按员工默认和任务配置预检后执行。需要调研、建议或头脑风暴时不要调用。工作运行内请使用 delegate。',
          inputSchema: {
            type: 'object',
            properties: {
              sourceRequestId: { type: 'string' },
              employeeId: { type: 'string' },
              title: { type: 'string', maxLength: 240 },
              description: { type: 'string', maxLength: 4000 },
              workItemId: { type: 'string' },
              expectedRevision: { type: 'integer', minimum: 1 },
            },
            required: ['sourceRequestId', 'employeeId', 'title', 'description'],
            additionalProperties: false,
          },
        },
        {
          type: 'function',
          name: 'record_deployment',
          description:
            '保存实际部署后的结构化凭证，不执行部署，不代替外部操作授权。环境、修订、地址和结果必须如实声明，并引用 inspect 返回的本工作命令身份。成功需要不同的部署命令和后续验证命令均已成功完成；没有确认结果时用 unknown。失败或未知凭证不会满足部署成果要求。不得在地址、摘要或命令中保存秘密。',
          inputSchema: {
            type: 'object',
            properties: {
              environment: { type: 'string', maxLength: 240 },
              revision: { type: 'string', maxLength: 240 },
              url: { type: 'string', maxLength: 2000 },
              outcome: { type: 'string', enum: ['succeeded', 'failed', 'unknown'] },
              summary: { type: 'string', maxLength: 4000 },
              deploymentCommandId: { type: 'string' },
              verificationCommandId: { type: 'string' },
            },
            required: ['environment', 'revision', 'url', 'outcome', 'summary', 'deploymentCommandId'],
            additionalProperties: false,
          },
        },
        {
          type: 'function',
          name: 'propose_memory',
          description: '提出一条可复用的个人经验，先交给用户审查，审核前不生效。只记录稳定方法、领域知识或明确偏好；不记录一次任务结果、秘密或未经验证的猜测。必须说明依据、适用范围与例外。',
          inputSchema: {
            type: 'object',
            properties: {
              topic: { type: 'string', maxLength: 160 },
              kind: { type: 'string', enum: ['domain_knowledge', 'stable_workflow', 'preference'] },
              content: { type: 'string', maxLength: 8000 },
              reason: { type: 'string', maxLength: 2000 },
            },
            required: ['topic', 'kind', 'content', 'reason'],
            additionalProperties: false,
          },
        },
        {
          type: 'function',
          name: 'delegate',
          description: '为允许的员工创建一份有边界的子分工。必须给出目标与完成标准；依赖只能引用 inspect 返回的同轮子工作。保存后由任务安排统一调度，同一工具调用不会重复创建。',
          inputSchema: {
            type: 'object',
            properties: { employeeId: { type: 'string' }, title: { type: 'string', maxLength: 240 }, description: { type: 'string', maxLength: 4000 }, dependencyIds: { type: 'array', items: { type: 'string' }, maxItems: 24 } },
            required: ['employeeId', 'title', 'description'],
            additionalProperties: false,
          },
        },
        {
          type: 'function',
          name: 'submit_team_plan',
          description: '仅供数字团队当前 CTO 规划节点提交结构化计划。计划必须逐一引用冻结流程中的员工 nodeId，并给出目标、范围、禁止事项和验收标准；本工具只登记当前轮次结果，不能批准计划或启动后继节点。',
          inputSchema: {
            type: 'object',
            properties: {
              summary: { type: 'string', maxLength: 4_000 },
              assignments: {
                type: 'array',
                minItems: 1,
                maxItems: 64,
                items: {
                  type: 'object',
                  properties: {
                    nodeId: { type: 'string', maxLength: 256 },
                    objective: { type: 'string', maxLength: 4_000 },
                    scope: { type: 'array', items: { type: 'string', maxLength: 1_000 }, maxItems: 64 },
                    excludedScope: { type: 'array', items: { type: 'string', maxLength: 1_000 }, maxItems: 64 },
                    acceptanceCriteria: { type: 'array', items: { type: 'string', maxLength: 1_000 }, minItems: 1, maxItems: 64 },
                    expectedDeliverables: { type: 'array', items: { type: 'string', maxLength: 1_000 }, minItems: 1, maxItems: 64 },
                  },
                  required: ['nodeId', 'objective', 'scope', 'excludedScope', 'acceptanceCriteria', 'expectedDeliverables'],
                  additionalProperties: false,
                },
              },
            },
            required: ['summary', 'assignments'],
            additionalProperties: false,
          },
        },
        {
          type: 'function',
          name: 'submit_team_result',
          description: '仅供数字团队当前节点提交结构化结果。必须如实列出产物、代码提交和验证状态；Core 会在轮次终态后从当前准确轮次生成命令、消息和变化证据并核对代码版本，不能用完成文字代替验真。',
          inputSchema: {
            type: 'object',
            properties: {
              outcome: { type: 'string', enum: ['succeeded', 'failed', 'blocked'] },
              summary: { type: 'string', maxLength: 4_000 },
              verification: { type: 'string', enum: ['passed', 'failed', 'not_run'] },
              repositoryResults: {
                type: 'array',
                maxItems: 64,
                items: {
                  type: 'object',
                  properties: {
                    repositoryId: { type: 'string', maxLength: 256 },
                    baseSha: { type: 'string', pattern: '^[0-9a-fA-F]{40,64}$' },
                    headSha: { type: 'string', pattern: '^[0-9a-fA-F]{40,64}$' },
                  },
                  required: ['repositoryId', 'baseSha', 'headSha'],
                  additionalProperties: false,
                },
              },
              verifiedCandidates: {
                type: 'array',
                maxItems: 64,
                items: {
                  type: 'object',
                  properties: { repositoryId: { type: 'string', maxLength: 256 }, headSha: { type: 'string', pattern: '^[0-9a-fA-F]{40,64}$' } },
                  required: ['repositoryId', 'headSha'],
                  additionalProperties: false,
                },
              },
              artifactRefs: { type: 'array', items: { type: 'object', additionalProperties: true }, maxItems: 64 },
              remainingIssues: { type: 'array', items: { type: 'string', maxLength: 1_000 }, maxItems: 64 },
            },
            required: ['outcome', 'summary', 'verification', 'repositoryResults', 'verifiedCandidates', 'artifactRefs', 'remainingIssues'],
            additionalProperties: false,
          },
        },
      ],
    },
  ];
}
