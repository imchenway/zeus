import assert from 'node:assert/strict';
import process from 'node:process';
import console from 'node:console';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInitialSessionState, sessionReducer } from '../apps/desktop/dist/renderer/session/sessionReducer.js';
import { ConversationCapabilityQueryApplication } from '../packages/local-server/dist/conversationCapabilityQueryApplication.js';
import { createCodexRuntimeGenerationManager } from '../packages/ai-runtime/dist/codexRuntimeGenerationManager.js';

/** 只核对内存消息状态，不访问生产队列或模型。 */
function checkMessageProjection() {
  /** 两条相同正文必须由独立身份区分。 */
  let state = { ...createInitialSessionState(), conversationId: 'conversation', providerThreadId: 'thread' };
  for (const id of ['first', 'second']) {
    state = sessionReducer(state, {
      type: 'send_started',
      clientUserMessageId: id,
      durableClientUserMessageId: id,
      draft: '继续',
      attachments: [],
      submittedAttachments: [],
      browserSubmission: null,
      browserComments: [],
      contextDraft: state.contextDraft,
      delivery: 'queue',
      previousConversationState: state.conversationState,
      startedAt: '2026-10-25T03:47:42.555Z',
      queuedUntilHydrated: true,
    });
  }
  /** 原消息及资源必须在权威状态接管后继续存在。 */
  const original = state.items[state.itemOrder[0]];
  original.payload.attachments = [{ id: 'image', path: '/evidence.png' }];
  /** 权威失败带有稳定提交身份。 */
  const queue = {
    throughEventSeq: 2,
    state: { type: 'paused', reason: 'recovery_required' },
    submissions: [{ id: 'submission', clientUserMessageId: 'first', status: 'paused', pausedReason: 'recovery_required', content: '继续', error: { code: 'WRITER_BUSY', message: 'thread already has an active writer' } }],
  };
  state = sessionReducer(state, { type: 'queue_hydrated', queue });
  /** 迟到接纳回执不能将已暂停消息改回排队状态。 */
  state = sessionReducer(state, { type: 'send_accepted', clientUserMessageId: 'first', submissionId: 'submission', status: 'queued' });
  /** 读取原位置的同一消息，不创建替代气泡。 */
  const restored = state.items[state.itemOrder[0]];
  assert.equal(restored.status, 'paused');
  assert.equal(restored.payload.queuedUntilHydrated, undefined);
  assert.equal(restored.payload.deliveryError.code, 'WRITER_BUSY');
  assert.equal(restored.text, original.text);
  assert.deepEqual(restored.payload.attachments, original.payload.attachments);
  assert.equal(state.itemOrder.length, 2);
  assert.equal(state.items[state.itemOrder[1]].payload.queuedUntilHydrated, true);
  assert.equal(sessionReducer(state, { type: 'queue_hydrated', queue: { ...queue, throughEventSeq: 1, submissions: [] } }), state);
}

/** Codex 账号失败时独立供应商仍可选择，内部只读目录不请求账号。 */
async function checkProviderIsolation() {
  /** 仅提供本次查询实际使用的本地端口。 */
  const application = new ConversationCapabilityQueryApplication({
    projects: { getById: () => ({ id: 'project' }) },
    codexNativeEnabled: () => true,
    provider: {
      getState: () => ({
        type: 'ready',
        capabilities: {
          generationId: 'generation',
          initializedAt: '',
          goals: { supported: false, enabled: false },
          modelBudgets: {},
          models: [{ id: 'codex-model', model: 'codex-model', supportedReasoningEfforts: [], serviceTiers: [], raw: {} }],
        },
      }),
      readAccount: async () => {
        throw new Error('workspace routing discovery failed');
      },
    },
    modelCatalog: { listSelectableModels: async () => [{ id: 'local-model', model: 'local-model', agentKind: 'pi', sourceId: 'local', available: true, supportedReasoningEfforts: [] }] },
    readDefaultModel: () => 'local-model',
    now: () => new Date(),
  });
  /** 对外查询保留 Codex 不可用事实，其他来源不受影响。 */
  const snapshot = await application.readConversation('project');
  assert.equal(snapshot.models.find((model) => model.sourceId === 'local').available, true);
  assert.equal(snapshot.models.find((model) => model.sourceId === 'codex').available, false);
  assert.equal(snapshot.codexAccount.generationId, 'codex-unavailable');
  assert.equal((await application.readConversation('project', { readProviderAccount: false })).models.find((model) => model.sourceId === 'codex').available, true);
}

/** 启动失败只执行临时替身，确认省略选项后仍使用 daemon 传输。 */
async function checkTransportIdentity() {
  /** 独立临时目录隔离所有启动参数和文件。 */
  const directory = await mkdtemp(join(tmpdir(), 'zeus-recovery-boundary-'));
  /** 临时程序只记录参数并失败，不启动真实 Provider。 */
  const command = join(directory, 'codex');
  /** 参数记录用于识别是否错误切到 stdio。 */
  const calls = join(directory, 'calls');
  /** Windows 由现有 Main 端口启动，替身直接返回失败。 */
  let windowsAttempts = 0;
  /** 使用真实运行管理器核对失败后的传输选择。 */
  const manager = createCodexRuntimeGenerationManager({
    codexHome: directory,
    providerVersionProbe: async () => null,
    ensureRemoteControlDaemon: async () => {
      windowsAttempts += 1;
      throw new Error('isolated bootstrap failure');
    },
  });
  try {
    await writeFile(command, `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n'); process.exit(1);\n`, { mode: 0o700 });
    await assert.rejects(manager.ensureReady({ commandPath: command, remoteControl: true }));
    await assert.rejects(manager.ensureReady({ commandPath: command }));
    if (process.platform === 'win32') assert.equal(windowsAttempts, 2);
    else
      assert.deepEqual(
        (await readFile(calls, 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line)),
        [
          ['remote-control', 'start', '--json'],
          ['remote-control', 'start', '--json'],
        ],
      );
  } finally {
    await manager.close();
    await rm(directory, { recursive: true, force: true });
  }
}

checkMessageProjection();
await checkProviderIsolation();
await checkTransportIdentity();
console.log('会话恢复状态、供应商隔离与传输身份检查通过。');
