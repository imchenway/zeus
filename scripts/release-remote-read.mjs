const transientRemoteFailurePattern =
  /(timed?\s*out|timeout|ssl_error_syscall|tls(?:v\d+(?:\.\d+)?)?.*(?:closed|handshake|eof|alert|error)|unexpected eof|early eof|connection (?:reset|closed|aborted|refused)|connectionreset|econnreset|econnrefused|econnaborted|temporary failure|could not resolve host|name or service not known|network is unreachable|enetunreach|proxy connect aborted|failed to connect|empty reply from server|stream error|http\s*(?:408|425|429|5\d\d)|bad gateway|service unavailable|gateway timeout|failed to log in to github\.com account|token in keyring is invalid)/iu;

const transientErrorCodes = new Set(['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EAI_AGAIN', 'ENETUNREACH']);

export const releaseRemoteReadTimeoutMs = 60_000;
export const releaseRemoteReadAttempts = 3;
export const releaseRemoteReadRetryDelaysMs = [1_000, 3_000];

export function commandResultSucceeded(result) {
  return !result.error && result.status === 0;
}

export function commandFailureDetail(result) {
  return String(result.stderr ?? '').trim() || String(result.stdout ?? '').trim() || result.error?.message || `退出码 ${result.status ?? 'unknown'}`;
}

/** 为明确的 GitHub 认证失败提供两端共用的人工恢复步骤，不把普通网络错误当作凭证失效。 */
export function githubAuthenticationRecoveryHint(detail) {
  if (!/(failed to log in to github\.com account|token in [^\r\n]+ is invalid|not logged into any github hosts|gh auth login|HTTP 401)/iu.test(detail)) return '';
  return (
    '请在运行发布的同一系统用户环境中恢复 GitHub CLI 认证：\n' +
    '1. 若设置了 GH_TOKEN 或 GITHUB_TOKEN，请先更新对应环境变量中的凭证；环境变量凭证会优先于本地登录。\n' +
    '2. 使用本地登录时执行：gh auth login --hostname github.com --web，并完成浏览器授权。\n' +
    '3. 执行：gh auth status --hostname github.com，确认登录成功。\n'
  );
}

export function isTransientRemoteReadFailure(result) {
  if (transientErrorCodes.has(result.error?.code)) return true;
  const detail = `${result.stderr ?? ''}\n${result.stdout ?? ''}\n${result.error?.message ?? ''}`;
  return transientRemoteFailurePattern.test(detail);
}

export function runRemoteReadWithRetrySync(input) {
  const attempts = input.attempts ?? releaseRemoteReadAttempts;
  const retryDelaysMs = input.retryDelaysMs ?? releaseRemoteReadRetryDelaysMs;
  const shouldRetry = input.shouldRetry ?? isTransientRemoteReadFailure;
  const sleep = input.sleep ?? sleepSync;

  if (!Number.isInteger(attempts) || attempts < 1) throw new Error('远程只读重试次数必须是正整数。');

  let result = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    result = input.execute(attempt);
    if (commandResultSucceeded(result)) return { result, attemptsUsed: attempt };
    if (attempt >= attempts || !shouldRetry(result)) return { result, attemptsUsed: attempt };

    const delayMs = retryDelaysMs[Math.min(attempt - 1, retryDelaysMs.length - 1)] ?? 0;
    input.onRetry?.({
      attempt,
      nextAttempt: attempt + 1,
      attempts,
      delayMs,
      detail: commandFailureDetail(result),
    });
    if (delayMs > 0) sleep(delayMs);
  }

  return { result, attemptsUsed: attempts };
}

function sleepSync(delayMs) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
}
