import { codexRemoteControlBootstrapTimeoutMs } from '@zeus/ai-runtime';

export interface ExecutionHostCloseResources {
  recordClosing(): Promise<void>;
  closeRuntime(): Promise<void>;
  /** Unix Core 等已提交的 Codex 启动完成 PID 登记。 */
  waitForCodexDaemonCommands?(): Promise<void>;
  closeControlServer(): Promise<void>;
  removeRendezvous(): Promise<void>;
  removeStartupStatus(): Promise<void>;
  removeLockIdentity(): Promise<void>;
  releaseKernelLease(): void;
  recordClosed(): Promise<void>;
}

const executionHostRuntimeCloseTimeoutMs = 20_000;
const executionHostControlCloseTimeoutMs = 5_000;

/** 向独立 Core 请求停止工作时的等待上限，单位为毫秒。 */
export const executionHostStopBeforeShutdownTimeoutMs = 10_000;
/** 等待独立 Core 正常退出的基础时限，单位为毫秒。 */
export const executionHostGracefulExitTimeoutMs = 45_000;
/** Unix 的已提交 Codex 命令在 Core 退出前完成，Windows 由 Main 等待，单位为毫秒。 */
const executionHostDaemonDrainTimeoutMs = process.platform === 'win32' ? 0 : codexRemoteControlBootstrapTimeoutMs;
/** Core 正常退出包含等待本进程内的守护进程启动命令，单位为毫秒。 */
export const executionHostShutdownTimeoutMs = executionHostGracefulExitTimeoutMs + executionHostDaemonDrainTimeoutMs;
/** 发出已核验身份的强制结束请求后，等待进程和租约释放的上限，单位为毫秒。 */
export const executionHostForcedExitTimeoutMs = 5_000;
/** Main 等待独立 Core 的总上限，额外覆盖启动期发现、控制请求、身份核验和关闭本地桥，单位为毫秒。 */
export const desktopExecutionHostCloseTimeoutMs = executionHostStopBeforeShutdownTimeoutMs + executionHostShutdownTimeoutMs + executionHostForcedExitTimeoutMs + 45_000;

/**
 * Execution Host 关闭顺序的唯一组合点。
 *
 * Runtime 关闭失败时不删发现身份、不释放 writer lease，由调用方以非零码退出进程后让 OS 最终释放 fd。
 * Runtime 已关闭时，每个外层资源都必须独立尝试，最后聚合报错，禁止前一个失败短路后续收口。
 */
export async function closeExecutionHostResources(resources: ExecutionHostCloseResources): Promise<void> {
  const errors: unknown[] = [];
  await attempt('recordClosing', () => resources.recordClosing(), errors);

  let runtimeClosed = false;
  try {
    await withCloseTimeout(resources.closeRuntime(), executionHostRuntimeCloseTimeoutMs, 'Core 收尾超过 20 秒');
    runtimeClosed = true;
  } catch (error) {
    errors.push(closeStageError('closeRuntime', error));
  }
  const waitForDaemonCommands = resources.waitForCodexDaemonCommands;
  if (waitForDaemonCommands) {
    await attempt('waitForCodexDaemonCommands', () => withCloseTimeout(waitForDaemonCommands(), executionHostDaemonDrainTimeoutMs, 'Codex 守护进程启动命令未在 Core 退出前完成。'), errors);
  }
  await attempt('closeControlServer', () => withCloseTimeout(resources.closeControlServer(), executionHostControlCloseTimeoutMs, '控制服务关闭超过 5 秒'), errors);

  if (runtimeClosed) {
    await attempt('removeRendezvous', () => resources.removeRendezvous(), errors);
    await attempt('removeStartupStatus', () => resources.removeStartupStatus(), errors);
    await attempt('removeLockIdentity', () => resources.removeLockIdentity(), errors);
    try {
      resources.releaseKernelLease();
    } catch (error) {
      errors.push(closeStageError('releaseKernelLease', error));
    }
    await attempt('recordClosed', () => resources.recordClosed(), errors);
  }

  if (errors.length > 0) {
    const detail = errors
      .map((error) => summarizeCloseError(error))
      .join('; ')
      .slice(0, 2_000);
    throw new AggregateError(errors, `Zeus execution-host shutdown failed: ${detail}`);
  }
}

/** 限制单个退出步骤的等待时间，超时后由调用方继续回收其余资源；单位为毫秒。 */
export async function withCloseTimeout(operation: Promise<unknown>, timeoutMs: number, message: string): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function attempt(stage: string, operation: () => Promise<void>, errors: unknown[]): Promise<void> {
  try {
    await operation();
  } catch (error) {
    errors.push(closeStageError(stage, error));
  }
}

function closeStageError(stage: string, error: unknown): Error {
  return new Error(`${stage}: ${summarizeCloseError(error)}`, { cause: error });
}

function summarizeCloseError(error: unknown, depth = 0): string {
  if (depth >= 3) return error instanceof Error ? error.message : String(error);
  if (error instanceof AggregateError) {
    const nested = [...error.errors].map((entry) => summarizeCloseError(entry, depth + 1)).filter(Boolean);
    return nested.length > 0 ? `${error.message} [${nested.join(' | ')}]` : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
