export interface ExecutionHostCloseResources {
  recordClosing(): Promise<void>;
  closeRuntime(): Promise<void>;
  closeControlServer(): Promise<void>;
  removeRendezvous(): Promise<void>;
  removeStartupStatus(): Promise<void>;
  removeLockIdentity(): Promise<void>;
  releaseKernelLease(): void;
  recordClosed(): Promise<void>;
}

const executionHostRuntimeCloseTimeoutMs = 20_000;
const executionHostControlCloseTimeoutMs = 5_000;

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

async function withCloseTimeout(operation: Promise<void>, timeoutMs: number, message: string): Promise<void> {
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
