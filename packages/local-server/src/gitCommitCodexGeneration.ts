import { createCodexAppServerManager, type CodexAppServerManager } from '@zeus/ai-runtime';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildGitCommitPrompt, type GitCommitMessageInput } from './gitCommitMessageGeneration.js';

/** 使用已登录账号的独立临时运行进程，不接入项目会话或工作目录。 */
export async function generateCodexCommitMessage(
  input: GitCommitMessageInput,
  options: { commandPath: string; codexHome: string; externalAgentHome?: string; manager?: CodexAppServerManager; timeoutMs?: number },
): Promise<{ message: string; model: string }> {
  const modelId = input.modelRef?.slice('codex:'.length);
  if (!input.files.length || !input.stagedDiff.trim() || !modelId) throw new Error('请选择 Codex 模型并暂存需要提交的改动。');
  const manager = options.manager ?? createCodexAppServerManager({ codexHome: options.codexHome });
  const cwd = await mkdtemp(join(tmpdir(), 'zeus-commit-'));
  let threadId = '';
  let unsubscribe = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Codex 生成超时，请重试。')), options.timeoutMs ?? 120_000);
    });
    const run = async () => {
      const capabilities = await manager.ensureReady({ commandPath: options.commandPath, ...(options.externalAgentHome ? { externalAgentHome: options.externalAgentHome } : {}) });
      const model = capabilities.models.find((item) => item.model === modelId && item.raw.hidden !== true);
      if (!model) throw new Error('所选 Codex 模型已不可用，请刷新模型列表。');
      const account = await manager.readAccount();
      if (!account.signedIn && account.requiresOpenaiAuth) throw new Error('请先在 Zeus 中登录 Codex。');
      const { system, prompt } = buildGitCommitPrompt(input);
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
      const messages = new Map<string, string>();
      const completed = new Promise<string>((resolve, reject) => {
        unsubscribe = manager.subscribe((event) => {
          const params = asRecord(event.params);
          if (params.threadId !== threadId) return;
          const item = asRecord(params.item);
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
      const [, text] = await Promise.all([
        manager.startTurn({ threadId, model: model.model, input: [{ type: 'text', text: prompt, text_elements: [] }], ...(model.supportedReasoningEfforts.includes('low') ? { effort: 'low' } : {}) }),
        completed,
      ]);
      const message = text.replace(/^```[^\n]*\n([\s\S]*?)\n```$/u, '$1').trim();
      if (!message || message.length > 10_000) throw new Error('Codex 未返回有效的提交说明，请重试。');
      return { message, model: `Codex · ${model.displayName || model.model}` };
    };
    return await Promise.race([run(), timeout]);
  } finally {
    clearTimeout(timer);
    unsubscribe();
    // 独立进程关闭也会终止超时轮次，不影响其他会话。
    try {
      await manager.close();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }
}
function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}
