import assert from 'node:assert/strict';
import { closeExecutionHostResources, type ExecutionHostCloseResources } from '../apps/desktop/src/main/executionHostClosePlan.js';

const successCalls: string[] = [];
await closeExecutionHostResources(resources(successCalls));
assert.deepEqual(successCalls, ['record-closing', 'runtime', 'control', 'rendezvous', 'startup', 'identity', 'lease', 'record-closed']);

const runtimeFailureCalls: string[] = [];
await assert.rejects(
  closeExecutionHostResources(
    resources(runtimeFailureCalls, {
      runtime: new Error('runtime close failed'),
    }),
  ),
  (error: unknown) =>
    error instanceof AggregateError && error.errors.some((entry) => entry instanceof Error && entry.message === 'closeRuntime: runtime close failed' && entry.cause instanceof Error && entry.cause.message === 'runtime close failed'),
);
assert.deepEqual(runtimeFailureCalls, ['record-closing', 'runtime', 'control']);

const cleanupFailureCalls: string[] = [];
await assert.rejects(
  closeExecutionHostResources(
    resources(cleanupFailureCalls, {
      rendezvous: new Error('rendezvous cleanup failed'),
      startup: new Error('startup cleanup failed'),
    }),
  ),
  (error: unknown) => error instanceof AggregateError && error.errors.length === 2,
);
assert.deepEqual(cleanupFailureCalls, ['record-closing', 'runtime', 'control', 'rendezvous', 'startup', 'identity', 'lease', 'record-closed']);

process.stdout.write('Execution Host close plan verified: cleanup is best-effort; runtime failure retains identity/lease and all callers can exit non-zero.\n');

function resources(calls: string[], failures: Partial<Record<'runtime' | 'control' | 'rendezvous' | 'startup' | 'identity' | 'lease', Error>> = {}): ExecutionHostCloseResources {
  const asynchronous = (name: keyof typeof failures | 'record-closing' | 'record-closed') => async () => {
    calls.push(name);
    const failure = failures[name as keyof typeof failures];
    if (failure) throw failure;
  };
  return {
    recordClosing: asynchronous('record-closing'),
    closeRuntime: asynchronous('runtime'),
    closeControlServer: asynchronous('control'),
    removeRendezvous: asynchronous('rendezvous'),
    removeStartupStatus: asynchronous('startup'),
    removeLockIdentity: asynchronous('identity'),
    releaseKernelLease: () => {
      calls.push('lease');
      if (failures.lease) throw failures.lease;
    },
    recordClosed: asynchronous('record-closed'),
  };
}
