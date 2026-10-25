import assert from 'node:assert/strict';
import { createCodexAppServerManager, type CodexTransportState, type SelectableConnectionModel } from '@zeus/ai-runtime';
import type { ZeusProjectRecord, ZeusTaskRecord } from '@zeus/storage';
import { ConversationCapabilityQueryApplication } from '../packages/local-server/src/conversationCapabilityQueryApplication.js';
import { createTaskRuntimeOperations } from '../packages/local-server/src/taskRuntimeOperations.js';
import { hasAvailableConversationModel } from '../apps/desktop/src/renderer/session/modelSelection.js';

/** 隔离检查只使用内存目录，不打开真实服务、凭据或用户数据库。 */
const project = { id: 'isolated-project', localPath: process.cwd() } as ZeusProjectRecord;
/** 任务推送仅核对能力投影，不创建工作区。 */
const task = { id: 'isolated-task', projectId: project.id, taskCode: 'ISOLATED', title: '供应商隔离', description: '' } as ZeusTaskRecord;
/** API 模型保留与订阅模型相同的裸名称，用完整来源身份区分。 */
const apiModel: SelectableConnectionModel = {
  id: 'domestic:shared-model',
  model: 'shared-model',
  displayName: '国内模型',
  sourceId: 'domestic',
  sourceName: '国内连接',
  agentKind: 'pi',
  enabled: true,
  available: true,
  availabilityReason: '本地已配置',
  supportedReasoningEfforts: [],
  defaultReasoningEffort: null,
  serviceTiers: [],
  defaultServiceTier: null,
  speedLabel: 'standard',
  tools: 'supported',
  imageInput: 'unsupported',
  runtimeAdapter: 'pi_sdk',
  protocolFamily: 'openai_completions',
  authenticationScheme: 'bearer',
  supports1MContext: false,
  contextWindow: 64_000,
};
/** 模拟已有 Codex 目录但尚无同代账户缓存的现场。 */
let transport = {
  type: 'ready',
  generationId: 'isolated',
  capabilities: {
    generationId: 'isolated',
    initializedAt: new Date(0).toISOString(),
    models: [{ id: 'shared-model', model: 'shared-model', supportedReasoningEfforts: [], serviceTiers: [], raw: {} }],
    modelBudgets: {},
    goals: { supported: false, enabled: false, stage: null },
  },
} as CodexTransportState;
/** 默认选订阅模型，用于确认显式 API 选择不会被全局默认覆盖。 */
let preferredModel = 'shared-model';
/** 记录真正准备 Codex 的次数，其他入口应保持为零。 */
let codexStarts = 0;
/** 本地查询端口只返回本次检查的内存数据。 */
const queries = new ConversationCapabilityQueryApplication({
  projects: { getById: () => project },
  tasks: { getById: () => task },
  settings: { getJson: () => undefined },
  repositories: { listByProject: () => [] },
  sharedPaths: { listByProject: () => [] },
  environments: { listByTask: () => [] },
  workspaces: { getByRepositoryBranch: () => undefined, listByEnvironment: () => [] },
  conversations: { listByProject: () => ({ items: [], total: 0 }), listByEnvironment: () => [] },
  submissions: { listByConversation: () => [], hasInFlightByConversation: () => false },
  provider: {
    getState: () => transport,
    /** 目录必须明确要求缓存，缺少缓存时保留账户未知状态。 */
    readAccount: async (input) => {
      assert.equal(input.cachedOnly, true);
      throw Object.assign(new Error('当前世代尚无账户缓存。'), { code: 'ZEUS_CODEX_ACCOUNT_SNAPSHOT_UNAVAILABLE' });
    },
  },
  modelCatalog: { hasConfiguredProvider: () => true, listSelectableModels: async () => [apiModel] },
  git: {
    readRepositoryContext: async () => {
      throw new Error('不应读取仓库');
    },
    readWorktreeClean: async () => true,
  },
  taskContext: { read: () => ({ revision: 'isolated', attachmentPreviewSources: [], current: { options: [] }, parent: { options: [] }, related: { options: [] } }), readAttachmentOptions: () => [] },
  readDefaultModel: () => preferredModel,
  readTaskBranchPrefix: () => 'task',
  codexNativeEnabled: () => true,
  now: () => new Date(0),
});
/** 复用真实命令预检；误启动 Codex 会立即失败，不进行网络请求。 */
const operations = createTaskRuntimeOperations({
  conversationCapabilityQueries: queries,
  codexNativeEnabled: true,
  currentCodexRuntimeCommandPath: () => 'unused',
  codexAppServerManager: {
    ensureReady: async () => {
      codexStarts += 1;
      throw new Error('Codex 网络不可达');
    },
  },
});
/** 会话、任务与员工目录必须各自保留 API 模型。 */
const conversation = await queries.readConversation(project.id);
assert(conversation.models.some((model) => model.id === apiModel.id));
assert.equal(conversation.codexAccount.signedIn, false);
assert.equal(hasAvailableConversationModel(conversation), true);
assert.equal((await queries.readTaskPush(project.id, task.id, { readProviderAccount: true })).taskId, task.id);
assert((await queries.readDigitalEmployee()).models.some((model) => model.id === apiModel.id));
assert.equal((await operations.resolveConversationCapabilities(project, apiModel.id)).models.length, 2);
assert.equal(codexStarts, 0);
await assert.rejects(operations.resolveConversationCapabilities(project, 'deleted:model'), { code: 'ZEUS_MODEL_UNAVAILABLE' });
assert.equal(codexStarts, 0);
await assert.rejects(operations.resolveConversationCapabilities(project, preferredModel), /Codex 网络不可达/);
assert.equal(codexStarts, 1);
/** Codex 未启动时，默认 API 模型仍可解析；缓存读取必须立即报告缺失。 */
transport = { type: 'idle' };
preferredModel = apiModel.id;
assert.equal((await operations.resolveConversationCapabilities(project)).preferredModel, apiModel.id);
assert.equal(codexStarts, 1);
assert.equal(hasAvailableConversationModel({ ...conversation, models: conversation.models.filter((model) => model.agentKind === 'codex') }), true);
assert.equal(
  hasAvailableConversationModel({
    ...conversation,
    models: conversation.models.filter((model) => model.agentKind === 'codex'),
    codexAccount: { generationId: 'isolated', accountScopeId: 'isolated', requiresOpenaiAuth: true, signedIn: false, accountType: null, planType: null },
  }),
  false,
);
assert.equal(hasAvailableConversationModel({ ...conversation, models: [], codexAccount: queries.unavailableCodexAccount() }), false);
/** 无本地账户快照时禁止等待未启动的 app-server。 */
const manager = createCodexAppServerManager({
  spawn: () => {
    throw new Error('不应启动进程');
  },
});
await assert.rejects(manager.readAccount({ cachedOnly: true }), { code: 'ZEUS_CODEX_ACCOUNT_SNAPSHOT_UNAVAILABLE' });
console.log('供应商目录与执行分流检查通过。');
