import { createCodexAppServerManager, type CodexAppServerManager } from '@zeus/ai-runtime';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildGitCommitPrompt, type GitCommitMessageInput } from './gitCommitMessageGeneration.js';

function commitManager(codexHome: string) {
  return createCodexAppServerManager({
    codexHome,
    lightweightGeneration: true,
    onDiagnostic: ({ stderrSummary }) => {
      const categories = ['stream', 'timeout', 'connection', 'reconnect', '401', '403', '429', 'error'].filter((word) => stderrSummary.toLowerCase().includes(word));
      if (categories.length) console.info(JSON.stringify({ event: 'git_commit_transport_diagnostic', categories }));
    },
  });
}

/** 服务级独占租用池：复用进程但不复用会话，失败进程不再归还。 */
export function createCommitCodexPool() {
  const idle = new Map<string, { manager: CodexAppServerManager; timer: ReturnType<typeof setTimeout> }>();
  const all = new Set<CodexAppServerManager>();
  const warming = new Map<string, Promise<void>>();
  let closed = false;
  return {
    warm(options: { commandPath: string; codexHome: string; externalAgentHome?: string }) {
      const key = JSON.stringify([options.commandPath, options.codexHome, options.externalAgentHome]);
      if (closed || idle.has(key)) return Promise.resolve();
      const existing = warming.get(key);
      if (existing) return existing;
      if (all.size >= 2) return Promise.resolve();
      const manager = commitManager(options.codexHome);
      all.add(manager);
      const promise = (async () => {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            manager.ensureReady(options),
            new Promise<never>((_, reject) => {
              timeout = setTimeout(() => reject(new Error('提交生成服务预热超时。')), 25_000);
            }),
          ]);
          if (closed || idle.has(key)) {
            all.delete(manager);
            await manager.close();
            return;
          }
          const timer = setTimeout(() => {
            idle.delete(key);
            all.delete(manager);
            void manager.close().catch(() => {});
          }, 10 * 60_000);
          timer.unref();
          idle.set(key, { manager, timer });
        } catch (error) {
          all.delete(manager);
          await manager.close();
          throw error;
        } finally {
          clearTimeout(timeout);
          warming.delete(key);
        }
      })();
      warming.set(key, promise);
      return promise;
    },
    async generate(input: GitCommitMessageInput, options: Parameters<typeof generateCodexCommitMessage>[1]) {
      if (closed) throw new Error('提交说明服务正在关闭。');
      const key = JSON.stringify([options.commandPath, options.codexHome, options.externalAgentHome]);
      await warming.get(key);
      options.signal?.throwIfAborted();
      if (closed) throw new Error('提交说明服务正在关闭。');
      const cached = idle.get(key);
      if (cached) {
        clearTimeout(cached.timer);
        idle.delete(key);
      }
      const manager = cached?.manager ?? commitManager(options.codexHome);
      all.add(manager);
      let reusable = false;
      try {
        const result = await generateCodexCommitMessage(input, { ...options, manager, keepAlive: true });
        reusable = true;
        return result;
      } finally {
        if (reusable && !closed && !idle.has(key) && idle.size < 2) {
          const timer = setTimeout(() => {
            idle.delete(key);
            all.delete(manager);
            void manager.close().catch(() => {});
          }, 10 * 60_000);
          timer.unref();
          idle.set(key, { manager, timer });
        } else {
          all.delete(manager);
          await manager.close();
        }
      }
    },
    async close() {
      closed = true;
      for (const entry of idle.values()) clearTimeout(entry.timer);
      idle.clear();
      await Promise.all([...all].map((manager) => manager.close()));
      all.clear();
    },
  };
}

/** 使用独立临时会话，不接入项目会话或工作目录。 */
export async function generateCodexCommitMessage(
  input: GitCommitMessageInput,
  options: {
    commandPath: string;
    codexHome: string;
    externalAgentHome?: string;
    manager?: CodexAppServerManager;
    timeoutMs?: number;
    keepAlive?: boolean;
    signal?: AbortSignal;
    onText?: (text: string) => void;
    onProgress?: (stage: string, elapsedMs: number) => void;
  },
): Promise<{ message: string; model: string }> {
  const modelId = input.modelRef?.slice('codex:'.length);
  if (!input.files.length || !input.stagedDiff.trim() || !modelId) throw new Error('请选择 Codex 模型并暂存需要提交的改动。');
  const manager = options.manager ?? createCodexAppServerManager({ codexHome: options.codexHome });
  const cwd = await mkdtemp(join(tmpdir(), 'zeus-commit-'));
  let threadId = '';
  let unsubscribe = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  let succeeded = false;
  let cancelled = false;
  let abort = () => {};
  const startedAt = performance.now();
  let stage = '初始化服务';
  const progress = (next: string) => {
    stage = next;
    options.onProgress?.(stage, Math.round(performance.now() - startedAt));
  };
  let rejectWait: (error: Error) => void = () => {};
  const armTimeout = (ms: number) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      cancelled = true;
      rejectWait(new Error(`Codex ${stage}超时，请重试。`));
    }, ms);
  };
  try {
    const timeout = new Promise<never>((_, reject) => {
      rejectWait = reject;
      abort = () => {
        cancelled = true;
        reject(new Error('提交说明生成已取消。'));
      };
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort();
      armTimeout(options.timeoutMs ?? 25_000);
    });
    const run = async () => {
      progress('初始化服务');
      const capabilities = await manager.ensureReady({ commandPath: options.commandPath, ...(options.externalAgentHome ? { externalAgentHome: options.externalAgentHome } : {}) });
      if (cancelled) throw new Error('提交说明生成已取消。');
      const model = capabilities.models.find((item) => item.model === modelId && item.raw.hidden !== true);
      if (!model) throw new Error('所选 Codex 模型已不可用，请刷新模型列表。');
      const effort = (['low', 'minimal', 'none'] as const).find((value) => model.supportedReasoningEfforts.includes(value));
      if (model.supportedReasoningEfforts.length && !effort) throw new Error('所选模型不支持低思考深度，请选择支持 low 的模型生成提交说明。');
      progress('读取账户');
      const account = await manager.readAccount();
      if (cancelled) throw new Error('提交说明生成已取消。');
      if (!account.signedIn && account.requiresOpenaiAuth) throw new Error('请先在 Zeus 中登录 Codex。');
      const { system, prompt } = buildGitCommitPrompt(input);
      progress('创建临时会话');
      const thread = await manager.startThread({
        model: model.model,
        cwd,
        ephemeral: true,
        approvalPolicy: 'never',
        sandbox: { type: 'readOnly', networkAccess: false },
        baseInstructions: system,
        developerInstructions: '仅根据输入文本生成提交说明。不要调用任何工具，不读取文件、不访问网络、不执行命令。',
      });
      threadId = thread.id;
      if (cancelled) throw new Error('提交说明生成已取消。');
      const messages = new Map<string, string>();
      const streamed = new Map<string, string>();
      const commentary = new Set<string>();
      const completed = new Promise<string>((resolve, reject) => {
        unsubscribe = manager.subscribe((event) => {
          const params = asRecord(event.params);
          if (['transport/process_exit', 'transport/process_error', 'transport/protocol_error'].includes(event.method)) {
            reject(new Error('Codex 生成连接中断，请重新生成。'));
            return;
          }
          if (params.threadId !== threadId) return;
          const item = asRecord(params.item);
          if (event.method === 'item/started' && item.phase === 'commentary') commentary.add(String(item.id));
          if (event.method === 'item/agentMessage/delta' && typeof params.delta === 'string' && !commentary.has(String(params.itemId))) {
            if (streamed.size === 0) progress('接收生成内容');
            const id = String(params.itemId);
            streamed.set(id, (streamed.get(id) ?? '') + params.delta);
            options.onText?.([...streamed.values()].join('\n').slice(0, 10_000));
          }
          if (event.method === 'error' && params.willRetry !== true) {
            reject(new Error('Codex 模型请求失败，请检查网络、登录状态或额度后重试。'));
            return;
          }
          if (event.requestId !== undefined || (event.method === 'item/started' && !['userMessage', 'agentMessage', 'reasoning'].includes(String(item.type)))) {
            reject(new Error('提交说明生成不支持工具调用，请重试。'));
            return;
          }
          if (event.method === 'item/completed' && item.type === 'agentMessage' && item.phase !== 'commentary' && typeof item.text === 'string') messages.set(String(item.id), item.text);
          if (event.method === 'turn/completed') {
            const turn = asRecord(params.turn);
            if (turn.status !== 'completed') {
              reject(new Error('Codex 未完成生成，请检查登录状态或额度后重试。'));
              return;
            }
            for (const entry of Array.isArray(turn.items) ? turn.items : []) {
              const message = asRecord(entry);
              if (message.type === 'agentMessage' && message.phase !== 'commentary' && typeof message.text === 'string') messages.set(String(message.id), message.text);
            }
            resolve([...messages.values()].join('\n').trim());
          }
        });
      });
      // 先订阅再派发，兼容最终通知早于 turn/start 回执到达。
      progress('等待模型响应');
      armTimeout(options.timeoutMs ?? 80_000);
      const [, text] = await Promise.all([
        manager.startTurn({ threadId, model: model.model, input: [{ type: 'text', text: prompt, text_elements: [] }], ...(effort ? { effort } : {}) }).then((turn) => {
          if (stage === '等待模型响应') progress('请求已接受，等待生成');
          return turn;
        }),
        completed,
      ]);
      progress('生成完成');
      const message = text.replace(/^```[^\n]*\n([\s\S]*?)\n```$/u, '$1').trim();
      if (!message || message.length > 10_000) throw new Error('Codex 未返回有效的提交说明，请重试。');
      return { message, model: `Codex · ${model.displayName || model.model}` };
    };
    const result = await Promise.race([run(), timeout]);
    succeeded = true;
    return result;
  } catch (error) {
    options.onProgress?.(`${cancelled ? '已取消或超时' : '失败'}：${stage}`, Math.round(performance.now() - startedAt));
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    unsubscribe();
    // 独立进程关闭也会终止超时轮次，不影响其他会话。
    try {
      if (!options.keepAlive || !succeeded) await manager.close();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }
}
function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}
