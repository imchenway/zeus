import { createCodexAppServerManager, type CodexAppServerManager } from '@zeus/ai-runtime';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildGitCommitPrompt, normalizeGitCommitMessage, type GitCommitMessageInput } from './gitCommitMessageGeneration.js';

/** 提交说明与输入建议共用轻量传输，不接入主会话。 */
function textManager(codexHome: string) {
  return createCodexAppServerManager({
    codexHome,
    lightweightGeneration: true,
    onDiagnostic: ({ stderrSummary }) => {
      const categories = ['stream', 'timeout', 'connection', 'reconnect', '401', '403', '429', 'error'].filter((word) => stderrSummary.toLowerCase().includes(word));
      if (categories.length) console.info(JSON.stringify({ event: 'git_commit_transport_diagnostic', categories }));
    },
  });
}

/** 提交说明保留原有校验和回执，池实例不与输入建议共享。 */
export function createCommitCodexPool() {
  return createCodexGenerationPool(generateCodexCommitMessage);
}

/** 输入建议租用自己的轻量进程，每次仍创建独立临时线程。 */
export function createCodexTextPool() {
  return createCodexGenerationPool(generateCodexText);
}

/** 两种纯文本生成复用同一租用实现，实例之间的取消和关闭互不影响。 */
function createCodexGenerationPool<Input, Result>(generate: (input: Input, options: CodexTextGenerationOptions) => Promise<Result>) {
  /** 空闲进程按实际宿主身份分组。 */
  const idle = new Map<string, { manager: CodexAppServerManager; timer: ReturnType<typeof setTimeout> }>();
  /** 关闭宿主时包括仍在运行或预热的进程。 */
  const all = new Set<CodexAppServerManager>();
  /** 同一身份只预热一次。 */
  const warming = new Map<string, Promise<void>>();
  /** 关闭后禁止再次借出进程。 */
  let closed = false;
  return {
    /** 只预热本实例拥有的空闲进程，不借用主会话或其他功能的连接。 */
    warm(options: { commandPath: string; codexHome: string; externalAgentHome?: string }) {
      const key = JSON.stringify([options.commandPath, options.codexHome, options.externalAgentHome]);
      if (closed || idle.has(key)) return Promise.resolve();
      const existing = warming.get(key);
      if (existing) return existing;
      if (all.size >= 2) return Promise.resolve();
      const manager = textManager(options.codexHome);
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
    /** 独占租用不共享线程，成功后才把进程放回池。 */
    async generate(input: Input, options: CodexTextGenerationOptions) {
      if (closed) throw new Error('文本生成服务正在关闭。');
      /** 身份变化不能沿用另一宿主的账号或命令。 */
      const key = JSON.stringify([options.commandPath, options.codexHome, options.externalAgentHome]);
      await warming.get(key);
      options.signal?.throwIfAborted();
      if (closed) throw new Error('文本生成服务正在关闭。');
      /** 从池中取出后不可再被其他请求借用。 */
      const cached = idle.get(key);
      if (cached) {
        clearTimeout(cached.timer);
        idle.delete(key);
      }
      /** 耗时日志只记录是否复用，不包含正文或账号。 */
      options.onReuse?.(cached?.manager.getState().type === 'ready');
      /** 没有空闲进程时才冷启动。 */
      const manager = cached?.manager ?? textManager(options.codexHome);
      all.add(manager);
      /** 失败或取消的进程不能归还。 */
      let reusable = false;
      try {
        /** 具体生成函数保留自己的文本校验和输出合同。 */
        const result = await generate(input, { ...options, manager, keepAlive: true });
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
    /** 关闭只回收本实例的进程与空闲计时器。 */
    async close() {
      closed = true;
      for (const entry of idle.values()) clearTimeout(entry.timer);
      idle.clear();
      await Promise.all([...all].map((manager) => manager.close()));
      all.clear();
    },
  };
}

/** 独立文本生成只接受服务端准备的指令和正文。 */
export interface CodexTextGenerationInput {
  /** 已登录 Codex 目录中的完整模型身份。 */
  modelRef: string;
  /** 当前生成场景的固定系统规则。 */
  system: string;
  /** 当前生成场景提供的有界材料。 */
  prompt: string;
  /** 可选的目录推理档位；调用前再次核对支持范围。 */
  effort?: string;
  /** 不传时使用标准速率，输入建议固定为标准速率。 */
  serviceTier?: 'priority' | null;
}

/** 调用方控制独立进程身份、取消和反馈，不改变 Provider 配置。 */
export interface CodexTextGenerationOptions {
  /** 当前工作树使用的真实 Codex 命令。 */
  commandPath: string;
  /** 当前宿主拥有的独立 Codex 数据目录。 */
  codexHome: string;
  /** 当前宿主明确授权的外部资源目录。 */
  externalAgentHome?: string;
  /** 纯文本生成池可以复用传输，但临时会话始终隔离。 */
  manager?: CodexAppServerManager;
  /** 每阶段等待上限；总时限由调用方 AbortSignal 控制。 */
  timeoutMs?: number;
  /** 只在成功时允许调用方回收传输进程。 */
  keepAlive?: boolean;
  /** 输入、设置变化或 HTTP 断开时取消独立生成。 */
  signal?: AbortSignal;
  /** 输入建议在首次重连错误时结束；提交说明保持既有行为。 */
  stopOnRetry?: boolean;
  /** 原始文本增量由具体场景统一清理。 */
  onText?: (text: string) => void;
  /** 保留提交说明已有的阶段反馈。 */
  onProgress?: (stage: string, elapsedMs: number) => void;
  /** 记录冷启动或进程复用，不暴露提示词。 */
  onReuse?: (reused: boolean) => void;
}

/** 提交说明保留原有校验、单行长度和流式预览，共用独立文本生成。 */
export async function generateCodexCommitMessage(input: GitCommitMessageInput, options: CodexTextGenerationOptions): Promise<{ message: string; model: string }> {
  if (!input.files.length || !input.stagedDiff.trim() || !input.modelRef?.startsWith('codex:')) throw new Error('请选择 Codex 模型并暂存需要提交的改动。');
  /** 只把已准备的提交材料送入临时线程。 */
  const result = await generateCodexText(
    { ...buildGitCommitPrompt(input), modelRef: input.modelRef, effort: input.effort, serviceTier: input.serviceTier },
    {
      ...options,
      onText: options.onText ? (text) => options.onText?.(normalizeGitCommitMessage(text)) : undefined,
    },
  );
  /** 最终结果与已有预览遵循相同的单行、长度约束。 */
  const message = normalizeGitCommitMessage(result.text);
  if (!message) throw new Error('Codex 未返回有效的提交说明，请重试。');
  return { message, model: result.model };
}

/** 使用独立临时会话生成文本；工具或交互请求立即判失败并关闭进程。 */
export async function generateCodexText(input: CodexTextGenerationInput, options: CodexTextGenerationOptions): Promise<{ text: string; model: string }> {
  /** 完整模型身份不能隐式降级到其他模型。 */
  const modelId = input.modelRef.startsWith('codex:') ? input.modelRef.slice('codex:'.length) : '';
  if (!modelId) throw new Error('请选择可用的 Codex 模型。');
  /** 建议和提交说明均采用已有轻量传输管理器。 */
  const manager = options.manager ?? textManager(options.codexHome);
  /** 临时空目录与项目文件分开，结束时删除。 */
  const cwd = await mkdtemp(join(tmpdir(), 'zeus-text-'));
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
        reject(new Error('文本生成已取消。'));
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
      /** 显式设置优先；旧入口未选档位时保持低档位并尊重模型目录默认值。 */
      const effort = input.effort || (['low', 'minimal', 'none'] as const).find((value) => model.supportedReasoningEfforts.includes(value)) || model.defaultReasoningEffort || model.supportedReasoningEfforts[0];
      if (effort && !model.supportedReasoningEfforts.includes(effort)) throw new Error('所选模型不支持此推理深度，请重新选择。');
      progress('读取账户');
      const account = await manager.readAccount();
      if (cancelled) throw new Error('提交说明生成已取消。');
      if (!account.signedIn && account.requiresOpenaiAuth) throw new Error('请先在 Zeus 中登录 Codex。');
      progress('创建临时会话');
      const thread = await manager.startThread({
        model: model.model,
        serviceTier: input.serviceTier ?? null,
        cwd,
        ephemeral: true,
        approvalPolicy: 'never',
        sandbox: { type: 'readOnly', networkAccess: false },
        baseInstructions: input.system,
        developerInstructions: '仅根据给定文本生成结果。不要调用任何工具，不读取文件、不访问网络、不执行命令。',
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
          if (event.method === 'error' && (params.willRetry !== true || options.stopOnRetry)) {
            reject(new Error('Codex 模型请求失败，请检查网络、登录状态或额度后重试。'));
            return;
          }
          if (event.requestId !== undefined || (event.method === 'item/started' && !['userMessage', 'agentMessage', 'reasoning'].includes(String(item.type)))) {
            reject(new Error('独立文本生成不支持工具调用。'));
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
        manager.startTurn({ threadId, model: model.model, serviceTier: input.serviceTier ?? null, input: [{ type: 'text', text: input.prompt, text_elements: [] }], ...(effort ? { effort } : {}) }).then((turn) => {
          if (stage === '等待模型响应') progress('请求已接受，等待生成');
          return turn;
        }),
        completed,
      ]);
      progress('生成完成');
      if (text.length > 10_000) throw new Error('Codex 返回的文本超出生成上限。');
      return { text, model: `Codex · ${model.displayName || model.model}` };
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
