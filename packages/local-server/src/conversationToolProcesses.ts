import { createHash } from 'node:crypto';
import { accessSync, constants, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AiRuntimeSessionManager } from '@zeus/ai-runtime';
import type { ConversationCollaborationMode, ConversationPermissionMode, ConversationRuntimeRepository, RuntimeSessionRepository, TerminalEventRepository } from '@zeus/storage';
import { canonicalToolPath, conversationSandboxProfile, effectiveToolPermission, restrictToolPermission, toolSandboxMode } from './conversationToolPolicy.js';

/** 进程归属使用会话身份，生命周期和输出沿用宿主 Runtime。 */
export interface ConversationProcessOwner {
  /** 稳定会话身份。 */
  conversationId: string;
  /** 当前实际执行轮次。 */
  turnId: string;
  /** 工作区所属项目。 */
  projectId: string;
  /** 可选任务归属。 */
  taskId?: string | null;
  /** 已解析的工作目录。 */
  cwd: string;
  /** 本轮冻结的权限。 */
  permissionMode: ConversationPermissionMode;
  /** 计划模式强制只读。 */
  workMode: ConversationCollaborationMode;
  /** 本轮已授权附件和 Skill 的只读目录。 */
  readableRoots: readonly string[];
}

/** 复用受管进程，不维护第二套 spawn、日志或跨重启 PID 恢复机制。 */
export function createConversationToolProcesses(options: {
  runtime(): AiRuntimeSessionManager;
  bindings: ConversationRuntimeRepository;
  sessions: RuntimeSessionRepository;
  events: TerminalEventRepository;
  save(): Promise<void>;
  scratchRoot: string;
  environment(): NodeJS.ProcessEnv;
}) {
  /** 拒绝跨会话操作和宿主重启后失效的输入句柄。 */
  function assertOwner(conversationId: string, processId: string): void {
    if (options.bindings.getProcess(processId)?.conversationId !== conversationId) throw new Error('进程不属于当前会话。');
  }

  /** 只读取已保存输出；游标按稳定事件序号推进，不重复执行命令。 */
  function read(conversationId: string, processId: string, cursor = 0) {
    assertOwner(conversationId, processId);
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('输出游标必须是非负整数。');
    const live = options.runtime().getSession(processId);
    const saved = options.sessions.getById(processId);
    const page = options.events.listBySessionPage(processId, { offset: cursor, limit: 64 });
    /** 进程退出不等于命令成功；缺失退出码时保留结果未知。 */
    const status = live?.status ?? (saved && saved.status !== 'running' ? saved.status : 'outcome_unknown');
    /** 使用宿主实际回报，不从工具调用完成或输出文字推测退出码。 */
    const exitCode = live?.exitCode ?? saved?.exitCode ?? null;
    return {
      processId,
      status: status === 'exited' ? (exitCode === 0 ? 'exited' : exitCode === null ? 'outcome_unknown' : 'failed') : status,
      exitCode,
      inputAvailable: live?.status === 'running',
      cursor: cursor + page.items.length,
      hasMore: cursor + page.items.length < page.total,
      output: page.items.map((item) => item.content).join(''),
      outputArtifacts: page.items.flatMap((item) => (item.rawChunkPath ? [item.rawChunkPath] : [])),
    };
  }

  /** 启动前持久化调用身份；相同调用即使结果未知也不自动重放。 */
  async function start(owner: ConversationProcessOwner, input: { toolCallId: string; command: string; escalated: boolean; yieldTimeMs?: number }) {
    if (input.escalated && effectiveToolPermission(owner.permissionMode, owner.workMode) === 'read-only') throw new Error('只读或计划模式不能升级命令权限。');
    const processId = `conversation_process_${createHash('sha256').update(`${owner.conversationId}:${owner.turnId}:${input.toolCallId}`).digest('hex').slice(0, 32)}`;
    const mode = input.escalated ? 'danger-full-access' : toolSandboxMode(owner.permissionMode, owner.workMode);
    const requestHash = createHash('sha256')
      .update(JSON.stringify({ command: input.command, cwd: owner.cwd, mode, readableRoots: mode === 'danger-full-access' ? [] : owner.readableRoots }))
      .digest('hex');
    const previous = options.bindings.getProcess(processId);
    if (previous) {
      if (previous.requestHash !== requestHash) throw new Error('该调用身份已绑定其他命令或权限，不能重复使用。');
      return read(owner.conversationId, processId);
    }
    // 受限命令可能已部分执行；同轮换调用身份升级权限也不能自动重放它。
    if (
      input.escalated &&
      options.bindings.listProcesses(owner.conversationId).some((binding) => {
        if (binding.turnId !== owner.turnId || binding.permission === 'danger-full-access') return false;
        const session = options.sessions.getById(binding.processId);
        return session?.cwd === owner.cwd && (JSON.parse(session.argsJson) as string[]).at(-1) === input.command;
      })
    )
      throw new Error('该命令已在本轮受限环境中尝试，可能产生部分结果。请先核对结果，不能通过权限升级自动重放；后续执行需要用户重新明确授权。');
    const scratchDirectory = join(options.scratchRoot, processId);
    if (mode !== 'danger-full-access') {
      if (process.platform !== 'darwin') throw new Error('当前系统尚未接入可验证的命令隔离组件；命令尚未执行。');
      try {
        accessSync('/usr/bin/sandbox-exec', constants.X_OK);
      } catch {
        throw new Error('本机命令隔离组件不可用；命令尚未执行。');
      }
      mkdirSync(scratchDirectory, { recursive: true, mode: 0o700 });
    }
    const profile = mode === 'danger-full-access' ? null : conversationSandboxProfile({ cwd: owner.cwd, scratchDirectory, permission: owner.permissionMode, workMode: owner.workMode, readableRoots: owner.readableRoots });
    options.bindings.bindProcess({ processId, conversationId: owner.conversationId, turnId: owner.turnId, requestHash, permission: mode });
    await options.save();
    await options.runtime().startSession({
      id: processId,
      projectId: owner.projectId,
      ...(owner.taskId ? { taskId: owner.taskId } : {}),
      cwd: owner.cwd,
      // AI 命令通过输出游标和标准输入交互，不需要终端设备或自动分页器。
      terminal: false,
      command: mode === 'danger-full-access' ? '/bin/zsh' : '/usr/bin/sandbox-exec',
      args: mode === 'danger-full-access' ? ['-lc', input.command] : ['-p', profile!, '/bin/zsh', '-lc', input.command],
      env: { ...options.environment(), ...(mode === 'danger-full-access' ? {} : { TMPDIR: scratchDirectory }) },
    });
    await options.runtime().waitForSessionCompletion(processId, Math.max(0, Math.min(30_000, input.yieldTimeMs ?? 1_000)));
    await options.save();
    return read(owner.conversationId, processId);
  }

  /** 输入只能送给当前宿主持有的同一进程；旧 PID 不可复用。 */
  async function interact(
    owner: Pick<ConversationProcessOwner, 'conversationId' | 'cwd' | 'permissionMode' | 'workMode'>,
    input: { processId: string; action: 'read' | 'write' | 'stop'; cursor?: number; text?: string; yieldTimeMs?: number },
  ) {
    const { conversationId } = owner;
    assertOwner(conversationId, input.processId);
    if (input.action === 'write') {
      const current = effectiveToolPermission(owner.permissionMode, owner.workMode);
      const previous = options.bindings.getProcess(input.processId)!;
      const retained = previous.permission === 'danger-full-access' ? 'full-access' : previous.permission === 'workspace-write' ? 'auto' : 'read-only';
      if (current === 'read-only' || restrictToolPermission(retained, current) !== retained) throw new Error('旧进程权限超出本轮授权，不能继续输入；可以读取已有输出或停止。');
      const saved = options.sessions.getById(input.processId);
      if (current !== 'full-access' && (!saved || canonicalToolPath(saved.cwd) !== canonicalToolPath(owner.cwd))) throw new Error('旧进程不属于本轮工作区，不能继续输入。');
    }
    if (input.action !== 'read') {
      if (!options.runtime().getSession(input.processId)) throw new Error('执行宿主已变化，原进程输入身份失效。请先核对已有输出；不会自动重新启动命令。');
      if (input.action === 'write') options.runtime().inputSession(input.processId, input.text ?? '');
      else options.runtime().stopSession(input.processId);
    }
    if (options.runtime().getSession(input.processId)) await options.runtime().waitForSessionCompletion(input.processId, Math.max(0, Math.min(30_000, input.yieldTimeMs ?? 1_000)));
    await options.save();
    return read(conversationId, input.processId, input.cursor);
  }

  /** 显式停止或归档清理本会话的活动进程；普通回合结束和关闭界面不清理。 */
  function stopOwned(conversationId: string): void {
    for (const binding of options.bindings.listProcesses(conversationId)) {
      if (options.runtime().getSession(binding.processId)?.status === 'running') options.runtime().stopSession(binding.processId);
    }
  }

  return { start, interact, stopOwned };
}

/** 宿主共用的进程通道类型。 */
export type ConversationToolProcesses = ReturnType<typeof createConversationToolProcesses>;
