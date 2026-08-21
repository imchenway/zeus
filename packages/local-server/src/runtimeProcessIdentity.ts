import { spawnSync } from 'node:child_process';

export interface PersistedRuntimeProcessTarget {
  kind: 'process_group' | 'process';
  pid: number;
}

export type PersistedRuntimeProcessIdentityState = 'verified' | 'mismatch' | 'unavailable';

export type PersistedRuntimeProcessDiscovery = { state: 'found'; target: PersistedRuntimeProcessTarget } | { state: 'not_found' | 'unavailable'; target: null };

const persistedRuntimeProcessIdentityEnvironmentKey = 'ZEUS_RUNTIME_PROCESS_IDENTITY_TOKEN';
const persistedRuntimeProcessIdentityTokenPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function runtimeProcessSignalErrorCode(error: unknown): string | null {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : null;
}

export function isSafeRuntimeProcessId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 1;
}

export function persistedRuntimeProcessTargetExists(target: PersistedRuntimeProcessTarget): boolean {
  const signalTarget = target.kind === 'process_group' ? -target.pid : target.pid;
  try {
    process.kill(signalTarget, 0);
    return true;
  } catch (error) {
    // EPERM 等错误表示目标仍可能存在；只有 ESRCH 可以确认已经消失。
    return runtimeProcessSignalErrorCode(error) !== 'ESRCH';
  }
}

export function resolvePersistedRuntimeProcessTarget(pid: number): PersistedRuntimeProcessTarget | null {
  if (!isSafeRuntimeProcessId(pid)) return null;
  if (process.platform !== 'win32') {
    const processGroup = { kind: 'process_group' as const, pid };
    // 两种 POSIX Runtime spawn 都以子 PID 建立独立进程组；组已消失时禁止回退正 PID，避免重启后误杀复用同一 PID 的无关进程。
    return persistedRuntimeProcessTargetExists(processGroup) ? processGroup : null;
  }
  const processTarget = { kind: 'process' as const, pid };
  return persistedRuntimeProcessTargetExists(processTarget) ? processTarget : null;
}

export function inspectPersistedRuntimeProcessIdentity(target: PersistedRuntimeProcessTarget, token: string | null): PersistedRuntimeProcessIdentityState {
  if (!token || !persistedRuntimeProcessIdentityTokenPattern.test(token)) return 'unavailable';
  // Windows 无法通过当前标准库可靠读取其他进程的出生身份；跨重启停止必须 fail-closed，不能只凭可复用 PID 发信号。
  if (target.kind !== 'process_group' || process.platform === 'win32') return 'unavailable';
  const processList = spawnSync('/bin/ps', ['-axo', 'pid=,pgid='], {
    encoding: 'utf8',
    timeout: 2_000,
    maxBuffer: 1024 * 1024,
  });
  if (processList.error || processList.status !== 0 || typeof processList.stdout !== 'string') return 'unavailable';
  const memberPids = processList.stdout
    .split('\n')
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)$/u))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .filter((match) => Number(match[2]) === target.pid)
    .map((match) => Number(match[1]))
    .filter(isSafeRuntimeProcessId);
  if (memberPids.length === 0 || memberPids.length > 256) return 'unavailable';

  const expectedEnvironmentEntry = `${persistedRuntimeProcessIdentityEnvironmentKey}=${token}`;
  // 一次批量读取整个进程组的环境，避免逐成员同步调用 ps 在异常大进程组下阻塞数分钟。
  const environments = spawnSync('/bin/ps', ['eww', '-p', memberPids.join(','), '-o', 'command='], {
    encoding: 'utf8',
    timeout: 3_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (environments.error || environments.status !== 0 || typeof environments.stdout !== 'string') return 'unavailable';
  return environments.stdout.split(/\s+/u).includes(expectedEnvironmentEntry) ? 'verified' : 'mismatch';
}

export function discoverPersistedRuntimeProcessTargetByIdentity(token: string | null): PersistedRuntimeProcessDiscovery {
  if (!token || !persistedRuntimeProcessIdentityTokenPattern.test(token) || process.platform === 'win32' || typeof process.getuid !== 'function') {
    return { state: 'unavailable', target: null };
  }
  // 只在异常的 token 已落盘但 PID 缺失窗口执行一次同用户扫描；正常启动和常规恢复不会走这条较重路径。
  const processList = spawnSync('/bin/ps', ['eww', '-U', String(process.getuid()), '-o', 'pid=,pgid=,command='], {
    encoding: 'utf8',
    timeout: 5_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (processList.error || processList.status !== 0 || typeof processList.stdout !== 'string') return { state: 'unavailable', target: null };
  const expectedEnvironmentEntry = `${persistedRuntimeProcessIdentityEnvironmentKey}=${token}`;
  const matchingGroups = new Set<number>();
  for (const line of processList.stdout.split('\n')) {
    if (!line.split(/\s+/u).includes(expectedEnvironmentEntry)) continue;
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+/u);
    if (!match) return { state: 'unavailable', target: null };
    const processGroupId = Number(match[2]);
    if (!isSafeRuntimeProcessId(processGroupId)) return { state: 'unavailable', target: null };
    matchingGroups.add(processGroupId);
  }
  if (matchingGroups.size === 0) return { state: 'not_found', target: null };
  if (matchingGroups.size !== 1) return { state: 'unavailable', target: null };
  const target = { kind: 'process_group' as const, pid: [...matchingGroups][0]! };
  return persistedRuntimeProcessTargetExists(target) ? { state: 'found', target } : { state: 'not_found', target: null };
}

export function assertPersistedRuntimeProcessIdentity(target: PersistedRuntimeProcessTarget, token: string | null, sessionId: string): void {
  const identity = inspectPersistedRuntimeProcessIdentity(target, token);
  if (identity === 'verified') return;
  const reason = identity === 'mismatch' ? '当前进程组身份与该 Runtime 会话不匹配，可能发生 PID 复用' : '缺少可核验的跨重启进程身份';
  throw new Error(`Runtime 孤儿会话 ${sessionId} ${reason}，已保留 orphan_detected 状态且未向任何进程发送信号。`);
}

export function signalPersistedRuntimeProcessTarget(target: PersistedRuntimeProcessTarget, signal: NodeJS.Signals): void {
  const signalTarget = target.kind === 'process_group' ? -target.pid : target.pid;
  try {
    process.kill(signalTarget, signal);
  } catch (error) {
    // 探活与发信号之间目标可能自然退出，此时等价于终止完成。
    if (runtimeProcessSignalErrorCode(error) === 'ESRCH') return;
    throw error;
  }
}

export async function waitForPersistedRuntimeProcessTargetExit(target: PersistedRuntimeProcessTarget, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (persistedRuntimeProcessTargetExists(target)) {
    if (Date.now() >= deadline) return false;
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 50));
  }
  return true;
}
