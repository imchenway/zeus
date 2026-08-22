#!/usr/bin/env node
/* global console */
import { isTransientRemoteReadFailure, runRemoteReadWithRetrySync } from './release-remote-read.mjs';

function assertProbe(condition, message) {
  if (!condition) throw new Error(`发布公网只读重试行为不符合预期：${message}`);
}

function commandResult(status, stderr = '') {
  return { status, stdout: '', stderr, error: null };
}

function executeSequence(results) {
  let calls = 0;
  const outcome = runRemoteReadWithRetrySync({
    execute: () => results[Math.min(calls++, results.length - 1)],
    retryDelaysMs: [0, 0],
  });
  return { ...outcome, calls };
}

const sslRecovery = executeSequence([commandResult(128, 'LibreSSL SSL_connect: SSL_ERROR_SYSCALL in connection to github.com:443'), commandResult(0)]);
assertProbe(sslRecovery.result.status === 0 && sslRecovery.calls === 2, 'SSL_ERROR_SYSCALL 后必须重试并接受后续成功结果');

const keyringRecovery = executeSequence([commandResult(1, 'The token in keyring is invalid.'), commandResult(0)]);
assertProbe(keyringRecovery.result.status === 0 && keyringRecovery.calls === 2, '钥匙串登录探测的瞬时失败后必须重新读取');

const exhaustedAuthentication = executeSequence([commandResult(1, 'The token in keyring is invalid.'), commandResult(1, 'The token in keyring is invalid.'), commandResult(1, 'The token in keyring is invalid.')]);
assertProbe(exhaustedAuthentication.result.status === 1 && exhaustedAuthentication.calls === 3, '连续登录失败必须在有限次数后保持失败关闭');

const deterministicFailure = executeSequence([commandResult(2, 'unknown flag: --broken'), commandResult(0)]);
assertProbe(deterministicFailure.result.status === 2 && deterministicFailure.calls === 1, '确定性命令错误不得重试');

assertProbe(isTransientRemoteReadFailure(commandResult(1, 'HTTP 503 Service Unavailable')), 'GitHub 5xx 必须识别为瞬时读取故障');
assertProbe(!isTransientRemoteReadFailure(commandResult(1, 'HTTP 403 Resource not accessible by integration')), '确定性权限拒绝不得识别为瞬时读取故障');

console.log('发布公网只读重试行为探针通过。');
