/** 输入建议核心检查：pnpm exec tsx scripts/verify-input-suggestion-context.ts，不调用外部模型。 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import Fastify from 'fastify';
import { createConfiguredModelDefinition, normalizeModelConnection, modelRef, modelConnectionSecretAccount } from '../packages/ai-runtime/src/index.js';
import { createModelConnectionService } from '../packages/local-server/src/modelConnectionService.js';
import { registerInputSuggestionRoutes } from '../packages/local-server/src/inputSuggestionRoutes.js';
import { createCodexTextPool } from '../packages/local-server/src/gitCommitCodexGeneration.js';
import { SettingRepository } from '../packages/storage/src/index.js';
import { createZeusDatabase, ProjectRepository, ConversationRepository, ConversationExecutionRepository, ConversationSnapshotV2Repository as SnapshotRepository, LongTermMemoryRepository } from '../packages/storage/src/index.js';
import type { ConversationModelHistoryPageItem, ConversationSnapshotV2, ConversationSnapshotV2Repository, LongTermMemoryRecord } from '../packages/storage/src/index.js';
import { createInputSuggestionContextReader, inputSuggestionSourcesFingerprint } from '../packages/local-server/src/inputSuggestionContext.js';
import { getInputSuggestionSession } from '../apps/desktop/src/renderer/session/inputSuggestionStore.js';

/** 检查材料使用稳定身份和真实角色，正文并不包含可执行命令。 */
function message(sequence: number, role: 'user' | 'assistant', text: string, turnId = `turn-${sequence}`): ConversationModelHistoryPageItem {
  return {
    id: `message-${sequence}`,
    sequence,
    turnId,
    role,
    confirmedAt: String(sequence).padStart(5, '0'),
    phase: role === 'assistant' ? 'final' : null,
    content: { preview: text, truncated: false, byteLength: text.length, contentHandle: null },
  } as ConversationModelHistoryPageItem;
}

/** 跨八轮且包括同轮补充，旧实现的三轮窗口无法包含这些原始约束。 */
const messages = [message(1, 'user', '保留原功能，最多重试 5 次，每次最多 60 秒，不得覆盖内置供应商配置。')];
for (let index = 2; index < 16; index += 2) messages.push(message(index, 'assistant', '本轮说明。'), message(index + 1, 'user', `继续处理第 ${index} 项。`));
messages.push(message(16, 'user', '补充：不能自动提交。', 'current'), message(17, 'assistant', '很长的助手正文。'.repeat(4000), 'current'), message(18, 'user', '把每次时限改为 45 秒，其他要求保留。', 'current'));
/** 每次查询只记录身份和水位，用于判断是否真正增量读取。 */
const queries: Array<Parameters<ConversationSnapshotV2Repository['listModelHistoryPage']>[0]> = [];
/** 最小仓库替身保留分页方向和角色隔离，不复制取材算法。 */
const repository = {
  listModelHistoryPage(input: Parameters<ConversationSnapshotV2Repository['listModelHistoryPage']>[0]) {
    queries.push(input);
    /** 工具和思考不属于本检查的对话材料。 */
    const matches = messages.filter((item) => item.role === input.dialogueRole && (input.afterSequence === undefined || item.sequence > input.afterSequence));
    /** 反向查询保持输出正序。 */
    const items = input.direction === 'tail' ? matches.slice(-(input.entryLimit ?? 64)) : matches.slice(0, input.entryLimit ?? 64);
    return { items, nextCursor: null, hasMore: false } as ReturnType<ConversationSnapshotV2Repository['listModelHistoryPage']>;
  },
  readContentPage: () => {
    throw new Error('本检查没有正文句柄，不应读取外部正文。');
  },
};
/** 当前会话状态与高水位可以变化，草稿不进入此对象。 */
const snapshot = {
  orderEpoch: 1,
  eventStreamGeneration: 'stream',
  conversation: { id: 'conversation', projectId: 'project' },
  collections: { modelHistory: { throughSequence: 18 } },
  recentClosedTurns: [],
  activeTurn: { id: 'current', status: 'running', hasError: false },
} as unknown as ConversationSnapshotV2;
/** 记忆由宿主解析过有效期；取材层还须核对确认级别和作用范围。 */
const sources = {
  task: null,
  memories: [
    { id: 'style', scope: { kind: 'global', id: '*' }, confirmationLevel: 'explicit', kind: 'preference', memoryKey: '表达', content: '用简洁自然的中文，先说结论。' },
    { id: 'unconfirmed', scope: { kind: 'global', id: '*' }, confirmationLevel: 'observed', kind: 'preference', content: '不应使用的推测偏好' },
    { id: 'foreign', scope: { kind: 'project', id: 'another-project' }, confirmationLevel: 'explicit', kind: 'preference', content: '其他项目的材料' },
    { id: 'unrelated', scope: { kind: 'global', id: '*' }, confirmationLevel: 'explicit', kind: 'domain_knowledge', memoryKey: 'garden', content: 'gardening flowers water' },
    { id: 'unrelated-preference', scope: { kind: 'global', id: '*' }, confirmationLevel: 'explicit', kind: 'preference', memoryKey: 'garden', content: 'gardening flowers water' },
  ] as LongTermMemoryRecord[],
};
/** 同一读取器由建议和润色共享。 */
const reader = createInputSuggestionContextReader(repository);
/** 长助手回复不能挤掉开场约束、同轮补充和最新修正。 */
const first = reader.read({ snapshot, projectId: 'project', sources });
for (const required of ['最多重试 5 次', '不得覆盖内置供应商配置', '不能自动提交', '45 秒', '简洁自然的中文', '本轮仍在进行']) assert.ok(first.text.includes(required), required);
assert.ok(first.text.length <= 16_000);
assert.doesNotMatch(first.text, /不应使用的推测偏好|其他项目的材料|gardening/);
/** 同轮补充、助手答复和最新修正按真实顺序交错，不能重新按角色分组。 */
assert.match(first.text, /消息 message-16\][\s\S]*消息 message-17\][\s\S]*消息 message-18\]/u);
/** 同一来源重复取材不扫描已缓存历史；更换草稿也不会写入缓存。 */
const queryCount = queries.length;
assert.equal(reader.read({ snapshot, projectId: 'project', sources, draft: '继续完善原要求' }).text, first.text);
assert.equal(queries.length, queryCount);
/** 新用户要求只读取高水位后的增量，并使用户身份变化。 */
const beforeUser = reader.userRevision('conversation');
messages.push(message(19, 'user', '最新修正：只报告，不改文件。', 'current'));
snapshot.collections.modelHistory.throughSequence = 19;
assert.match(reader.read({ snapshot, projectId: 'project', sources }).text, /只报告，不改文件/);
assert.ok(queries.some((query) => query.afterSequence === 18));
assert.notEqual(reader.userRevision('conversation'), beforeUser);
/** 助手进度不会改变用户要求身份。 */
const stableUser = reader.userRevision('conversation');
messages.push(message(20, 'assistant', '进度：正在整理材料。', 'current'));
assert.equal(reader.userRevision('conversation'), stableUser);
/** 任务资料和记忆变动使候选失效，且不复用旧记忆内容。 */
const changedSources = { ...sources, memories: [] };
assert.notEqual(inputSuggestionSourcesFingerprint(sources), inputSuggestionSourcesFingerprint(changedSources));
assert.doesNotMatch(reader.read({ snapshot, projectId: 'project', sources: changedSources }).text, /简洁自然的中文/);
/** 会话修订重新读取历史，不能继续使用原文旧副本。 */
messages[0] = message(1, 'user', '已修订的原始要求：最多重试 3 次。');
snapshot.orderEpoch += 1;
assert.match(reader.read({ snapshot, projectId: 'project', sources }).text, /最多重试 3 次/);
/** 失败、中断和回复结束均不得自动宣称任务已验收。 */
for (const status of ['failed', 'interrupted', 'completed']) {
  snapshot.activeTurn!.status = status;
  assert.match(reader.read({ snapshot, projectId: 'project', sources }).text, status === 'completed' ? /不代表任务已经验收/ : /本轮失败或中断/);
}
assert.equal(reader.read({ snapshot: null, projectId: 'project', sources: { task: null, memories: [] }, draft: '请帮我润色' }).hasDialogue, false);

/** 状态层只采纳当前请求的回执，迟到结果不能覆盖新草稿或新要求。 */
const session = getInputSuggestionSession('input-suggestion-check');
/** 可控回执模拟用户输入发生在模型返回之前。 */
let complete: (result: { completedTurnId: null; modelRef: string; text: string; reason: null }) => void = () => {};
/** 记录取消传播，不调用模型或创建任务。 */
let aborted = false;
session.start({
  key: 'request',
  modelKey: 'model',
  turnKey: 'turn',
  sourceDraft: '继续',
  modelRef: 'model',
  request: { mode: 'polish', trigger: 'manual', draft: '继续' },
  generate: (_input, signal) =>
    new Promise((resolve) => {
      complete = resolve;
      signal.addEventListener('abort', () => {
        aborted = true;
      });
    }),
});
session.dismissAutomatic();
assert.equal(session.getSnapshot()?.pending, true);
session.observeUserInput('new-user-input');
assert.equal(aborted, true);
complete({ completedTurnId: null, modelRef: 'model', text: '旧要求的迟到润色', reason: null });
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(session.getSnapshot(), null);
/** 取消后可以重新生成；重复用户事件不能取消后来发起的请求。 */
session.start({
  key: 'new-request',
  modelKey: 'model',
  turnKey: 'turn',
  sourceDraft: '新草稿',
  modelRef: 'model',
  request: { mode: 'polish', trigger: 'manual', draft: '新草稿' },
  generate: async () => ({ completedTurnId: null, modelRef: 'model', text: '新草稿的润色', reason: null }),
});
session.observeUserInput('new-user-input');
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(session.getSnapshot()?.text, '新草稿的润色');
assert.equal(getInputSuggestionSession('another-conversation').getSnapshot(), null);
session.dismiss();
reader.clear();
/** 使用任务自有临时库核对实际 SQL、正文句柄和记忆有效期，不读取用户数据库。 */
const directory = await mkdtemp(join(tmpdir(), 'zeus-0821-context-'));
/** 数据库只在本检查期间存在。 */
const db = await createZeusDatabase(join(directory, 'check.db'));
try {
  /** 协议模拟器只验证真实进程租用，不访问外部模型或用户登录目录。 */
  const commandPath = join(directory, 'codex-check.cjs');
  await writeFile(
    commandPath,
    `#!/usr/bin/env node
/** 逐行处理真实管理器发出的协议消息。 */
const { createInterface } = require('node:readline');
/** 日志只保留进程和线程身份，不记录正文。 */
const { appendFileSync } = require('node:fs');
/** 日志固定写入任务自有临时目录。 */
const { join } = require('node:path');
/** 每个进程独立计数临时线程。 */
let threads = 0;
/** 只输出一条 JSON 协议消息。 */
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  /** 请求来自本地检查用的正式管理器。 */
  const { id, method, params = {} } = JSON.parse(line);
  appendFileSync(join(process.env.CODEX_HOME, 'protocol.jsonl'), JSON.stringify({ pid: process.pid, method, threadId: params.threadId, ephemeral: params.ephemeral, sandbox: params.sandbox, effort: params.effort }) + '\\n');
  if (id === undefined) return;
  if (method === 'initialize') return send({ id, result: {} });
  if (method === 'model/list') return send({ id, result: { data: [{ id: 'check', model: 'check', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }], nextCursor: null } });
  if (method === 'account/read') return send({ id, result: { account: null, requiresOpenaiAuth: false } });
  if (method === 'thread/start') return send({ id, result: { thread: { id: 'thread-' + process.pid + '-' + (++threads) } } });
  if (method === 'turn/start') {
    /** 每次请求均已创建独立线程，完成通知只回到对应线程。 */
    const turn = { id: params.threadId + '-turn', status: 'inProgress', items: [] };
    send({ id, result: { turn } });
    /** 仅用固定口令模拟失败与挂起，不写入日志。 */
    const prompt = params.input[0].text;
    if (prompt === 'WAIT') return;
    send({ method: 'turn/completed', params: { threadId: params.threadId, turn: { ...turn, status: prompt === 'FAIL' ? 'failed' : 'completed', items: [{ id: 'reply', type: 'agentMessage', text: '检查结果', phase: 'final_answer' }] } } });
    return;
  }
  send({ id, error: { code: -32601, message: '检查未定义的方法' } });
});
`,
    { mode: 0o755 },
  );
  /** 两个实例分别代表建议与其他纯文本功能。 */
  const pool = createCodexTextPool();
  /** 对照实例用于确认关闭和取消没有跨实例影响。 */
  const peerPool = createCodexTextPool();
  /** 复用标记必须来自真实就绪进程。 */
  const reuse: boolean[] = [];
  /** 只给本地模拟器使用的模型身份和明确推理深度。 */
  const poolInput = { modelRef: 'codex:check', system: '检查', prompt: 'OK', effort: 'high' };
  /** 每次生成沿用正式超时与清理入口。 */
  const poolOptions = {
    commandPath,
    codexHome: directory,
    timeoutMs: 3000,
    onReuse: (value: boolean) => {
      reuse.push(value);
    },
  };
  try {
    /** 以下耗时来自本地协议模拟器，不能作为真实模型性能结论。 */
    const coldStarted = performance.now();
    assert.equal((await pool.generate(poolInput, poolOptions)).text, '检查结果');
    /** 冷启动与复用分别计时，便于观察进程准备开销。 */
    const coldMs = Math.round(performance.now() - coldStarted);
    /** 第二次仍创建新线程，但复用同一进程。 */
    const warmStarted = performance.now();
    assert.equal((await pool.generate(poolInput, poolOptions)).text, '检查结果');
    console.log(JSON.stringify({ check: 'codex_local_protocol_only', coldMs, reusedMs: Math.round(performance.now() - warmStarted) }));
    assert.deepEqual(reuse, [false, true]);
    /** 真实协议日志确认同进程、不同临时线程，且档位未被替换。 */
    const protocol = (await readFile(join(directory, 'protocol.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(new Set(protocol.map((entry) => entry.pid)).size, 1);
    assert.equal(new Set(protocol.filter((entry) => entry.method === 'turn/start').map((entry) => entry.threadId)).size, 2);
    assert.ok(protocol.filter((entry) => entry.method === 'thread/start').every((entry) => entry.ephemeral === true && entry.sandbox === 'read-only'));
    assert.ok(protocol.filter((entry) => entry.method === 'turn/start').every((entry) => entry.effort === 'high'));
    await assert.rejects(pool.generate({ ...poolInput, prompt: 'FAIL' }, poolOptions));
    await pool.generate(poolInput, poolOptions);
    assert.equal(reuse.at(-1), false);
    await peerPool.generate(poolInput, poolOptions);
    /** 挂起轮次收到取消后销毁进程，下一次不能继续复用。 */
    const controller = new AbortController();
    await assert.rejects(
      pool.generate(
        { ...poolInput, prompt: 'WAIT' },
        {
          ...poolOptions,
          signal: controller.signal,
          onProgress: (stage) => {
            if (stage === '请求已接受，等待生成') controller.abort();
          },
        },
      ),
    );
    await pool.generate(poolInput, poolOptions);
    assert.equal(reuse.at(-1), false);
    await pool.close();
    assert.equal((await peerPool.generate(poolInput, poolOptions)).text, '检查结果');
    assert.equal(reuse.at(-1), true);
  } finally {
    await Promise.all([pool.close(), peerPool.close()]);
  }
  /** 正式仓库负责创建项目和会话，避免伪造外部身份。 */
  const project = new ProjectRepository(db).create({ name: '输入建议检查', localPath: directory });
  /** 原文只写入临时会话。 */
  const conversation = new ConversationRepository(db).create({ projectId: project.id, title: '输入建议检查' });
  /** 持久化历史与正式取材使用同一实现。 */
  const execution = new ConversationExecutionRepository(db);
  for (const item of messages)
    execution.appendModelHistory({
      conversationId: conversation.id,
      turnId: item.turnId,
      segmentId: 'check-segment',
      role: item.role as 'user' | 'assistant',
      content: { text: item.content.preview, phase: item.phase },
      confirmedAt: '2026-10-14T09:30:00.000Z',
    });
  execution.appendModelHistory({ conversationId: conversation.id, turnId: 'current', segmentId: 'check-segment', role: 'tool', content: { text: '不应进入建议的工具正文' }, toolPairId: 'tool', confirmedAt: '2026-10-14T09:30:00.000Z' });
  /** 真实分页负责用户过滤、反向顺序和游标隔离。 */
  const storage = new SnapshotRepository(db);
  /** 最近用户消息必须包含轮内补充，并跳过最后的助手与工具。 */
  const recent = storage.listModelHistoryPage({ conversationId: conversation.id, dialogueRole: 'user', direction: 'tail', entryLimit: 2 });
  assert.deepEqual(
    recent.items.map((item) => item.content.preview),
    ['把每次时限改为 45 秒，其他要求保留。', '最新修正：只报告，不改文件。'],
  );
  assert.ok(recent.nextCursor);
  assert.throws(() => storage.listModelHistoryPage({ conversationId: conversation.id, dialogueRole: 'assistant', cursor: recent.nextCursor! }));
  /** 真实受控正文页也遵守 16,000 字符预算。 */
  const actualSnapshot = { ...snapshot, conversation: { ...snapshot.conversation, id: conversation.id, projectId: project.id }, collections: { modelHistory: { throughSequence: 21 } } } as ConversationSnapshotV2;
  /** 长回复通过内容句柄读取，不能绕过预算或串入其他会话。 */
  const actual = createInputSuggestionContextReader(storage).read({ snapshot: actualSnapshot, projectId: project.id, sources: { task: null, memories: [] } });
  assert.match(actual.text, /最多重试 3 次/);
  assert.match(actual.text, /不能自动提交/);
  assert.ok(actual.text.length <= 16_000);
  assert.doesNotMatch(actual.text, /不应进入建议的工具正文/);
  /** 记忆有效期由正式查询判定，不能把过期偏好传入生成。 */
  const memories = new LongTermMemoryRepository(db);
  for (const [id, reviewAfter] of [
    ['current', '2027-01-01T00:00:00.000Z'],
    ['expired', '2026-10-13T00:00:00.000Z'],
  ])
    memories.recordCandidate({
      id,
      memoryKey: id,
      scope: { kind: 'global', id: '*' },
      candidateKind: 'preference',
      content: id,
      effect: 'advisory',
      confirmationLevel: 'explicit',
      confidence: 1,
      source: { kind: 'user_explicit', reference: 'check', observedAt: '2026-10-01T00:00:00.000Z' },
      reviewAfter,
      recordedAt: '2026-10-01T00:00:00.000Z',
    });
  assert.deepEqual(
    memories.resolveForContext({ projectId: project.id, asOf: '2026-10-14T00:00:00.000Z' }).selected.map((memory) => memory.id),
    ['current'],
  );
  /** 回环流接口检查正式路由和协议适配，不代表真实模型效果或外网速度。 */
  let requests = 0;
  /** 实际发送材料仅用于断言，不写入日志。 */
  let material = '';
  /** 在回执前模拟主会话变化。 */
  let beforeReply = () => {};
  /** 回执覆盖正常结果、原样返回和空建议。 */
  let answer = '请按已明确的要求继续完善。';
  /** 故障和挂起分别检查不重试与总期限。 */
  let behavior: 'normal' | 'failed' | 'stalled' = 'normal';
  /** 仅监听本机随机端口，不连接生产服务。 */
  const modelServer = createServer((request, response) => {
    /** 请求正文不会被保存到日志或文件。 */
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      requests += 1;
      material = body;
      beforeReply();
      if (behavior === 'stalled') return;
      if (behavior === 'failed') {
        response.writeHead(503, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: { message: '本地故障检查' } }));
        return;
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ id: 'check', object: 'chat.completion.chunk', created: 1, model: 'suggestion-check', choices: [{ index: 0, delta: { role: 'assistant', content: answer }, finish_reason: null }] })}\n\n`);
      response.end(`data: ${JSON.stringify({ id: 'check', object: 'chat.completion.chunk', created: 1, model: 'suggestion-check', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>((resolve) => modelServer.listen(0, '127.0.0.1', resolve));
  /** 随机端口必须属于当前检查启动的本地服务。 */
  const address = modelServer.address();
  assert.ok(address && typeof address !== 'string');
  /** 模型能力使用正式规范化入口。 */
  const connection = normalizeModelConnection(
    { name: '输入建议离线检查', baseUrl: `http://127.0.0.1:${address.port}/v1`, models: [createConfiguredModelDefinition('suggestion-check')] },
    { id: 'local-check', apiKeyConfigured: true, createdAt: '2026-10-14T00:00:00.000Z', updatedAt: '2026-10-14T00:00:00.000Z' },
  );
  /** 第二条连接用于证明未读取无关凭据。 */
  const settings = new SettingRepository(db);
  settings.setJson('models.connections', [connection, { ...connection, id: 'unused-connection' }]);
  /** 完整模型身份由共享规则生成。 */
  const selectedRef = modelRef(connection.id, connection.models[0]!.id);
  /** 凭据替身只允许当前选中的连接，不访问用户 Keychain。 */
  const connections = createModelConnectionService({
    settings,
    save: async () => {},
    secretStore: {
      setSecret: async () => {},
      deleteSecret: async () => {},
      getSecret: async (account) => {
        assert.equal(account, modelConnectionSecretAccount(connection.id));
        return 'local-check-only';
      },
    },
  });
  /** 使用正式 HTTP 路由、正式存储与正式 API 适配器。 */
  const api = Fastify();
  /** 取消只作用于当前功能自己的调用。 */
  const cancel = registerInputSuggestionRoutes({
    server: api,
    repository: storage,
    projectExists: (id) => id === project.id,
    getConversation: (id) => (id === conversation.id ? { projectId: project.id } : undefined),
    hasPendingSubmission: () => false,
    readSettings: () => ({ enabled: true, modelRef: selectedRef }),
    modelConnections: connections,
    loadModels: async () => {
      throw new Error('生成不应读取完整目录');
    },
    loadModel: async (ref) => {
      const model = (await connections.listSelectableModels(ref)).find((item) => item.id === ref);
      return model ? { id: model.id, label: model.displayName, supportedReasoningEfforts: model.supportedReasoningEfforts } : undefined;
    },
    readSources: () => ({ task: null, memories: memories.resolveForContext({ projectId: project.id, asOf: '2026-10-14T00:00:00.000Z' }).selected }),
    codexOptions: () => {
      throw new Error('API 生成不得读取 Codex 配置');
    },
  });
  /** 外部接口字段保持原合同。 */
  const payload = { mode: 'polish', trigger: 'manual', projectId: project.id, conversationId: conversation.id, draft: '继续完善' };
  /** 同一路由支持按原文润色与空输入建议。 */
  const generate = async (input = payload) => (await api.inject({ method: 'POST', url: '/api/input-suggestions/generate', payload: input })).json();
  try {
    assert.equal((await generate()).text, answer);
    assert.equal(requests, 1);
    for (const required of ['不能自动提交', '不能代替用户确认和验收', '继续完善']) assert.ok(material.includes(required), required);
    answer = payload.draft;
    assert.equal((await generate()).reason, 'no_change');
    answer = 'NO_SUGGESTION';
    assert.equal((await generate({ ...payload, mode: 'suggest', draft: '' })).reason, 'no_suggestion');
    answer = '助手普通进度不会打断润色。';
    beforeReply = () => {
      execution.appendModelHistory({ conversationId: conversation.id, turnId: 'current', segmentId: 'check-segment', role: 'assistant', content: { text: '普通进度', phase: 'commentary' }, confirmedAt: '2026-10-14T09:31:00.000Z' });
    };
    assert.equal((await generate()).text, answer);
    beforeReply = () => {
      execution.appendModelHistory({ conversationId: conversation.id, turnId: 'current', segmentId: 'check-segment', role: 'user', content: { text: '新增用户要求使旧候选失效。' }, confirmedAt: '2026-10-14T09:32:00.000Z' });
    };
    assert.equal((await generate()).reason, 'cancelled');
    beforeReply = cancel;
    assert.equal((await generate()).reason, 'cancelled');
    beforeReply = () => {};
    behavior = 'failed';
    /** 一个失败操作只产生一次模型请求。 */
    const beforeFailure = requests;
    assert.equal((await generate()).reason, 'failed');
    assert.equal(requests, beforeFailure + 1);
    behavior = 'stalled';
    /** 使用真实 20 秒总期限，不增加检查专用超时配置。 */
    const deadlineStarted = performance.now();
    assert.equal((await generate()).reason, 'timed_out');
    assert.ok(performance.now() - deadlineStarted < 25_000);
  } finally {
    cancel();
    modelServer.closeAllConnections();
    await api.close();
    await new Promise<void>((resolve, reject) => modelServer.close((error) => (error ? reject(error) : resolve())));
  }
} finally {
  db.close();
  await rm(directory, { recursive: true, force: true });
}
console.log('输入建议核心检查通过：跨轮约束、轮内补充、预算、记忆范围、增量与失效、新草稿、运行状态、取消与迟到结果。');
