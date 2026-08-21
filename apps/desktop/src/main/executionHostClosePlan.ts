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

/**
 * Execution Host 关闭顺序的唯一组合点。
 *
 * Runtime 关闭失败时不删发现身份、不释放 writer lease，由调用方以非零码退出进程后让 OS 最终释放 fd。
 * Runtime 已关闭时，每个外层资源都必须独立尝试，最后聚合报错，禁止前一个失败短路后续收口。
 */
export async function closeExecutionHostResources(resources: ExecutionHostCloseResources): Promise<void> {
  const errors: unknown[] = [];
  await attempt(() => resources.recordClosing(), errors);

  let runtimeClosed = false;
  try {
    await resources.closeRuntime();
    runtimeClosed = true;
  } catch (error) {
    errors.push(error);
  }
  await attempt(() => resources.closeControlServer(), errors);

  if (runtimeClosed) {
    await attempt(() => resources.removeRendezvous(), errors);
    await attempt(() => resources.removeStartupStatus(), errors);
    await attempt(() => resources.removeLockIdentity(), errors);
    try {
      resources.releaseKernelLease();
    } catch (error) {
      errors.push(error);
    }
    await attempt(() => resources.recordClosed(), errors);
  }

  if (errors.length > 0) throw new AggregateError(errors, 'Zeus execution-host shutdown failed.');
}

async function attempt(operation: () => Promise<void>, errors: unknown[]): Promise<void> {
  try {
    await operation();
  } catch (error) {
    errors.push(error);
  }
}
