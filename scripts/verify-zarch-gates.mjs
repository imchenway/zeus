#!/usr/bin/env node
/* global process */
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '..');
const checks = [
  { id: 'architecture-governance', command: 'pnpm', args: ['verify:architecture'] },
  { id: 'legacy-conversation-cutover', command: 'node', args: ['scripts/audit-conversation-legacy-access.mjs', '--require-cutover-ready'] },
  { id: 'conversation-query-plans', command: 'pnpm', args: ['exec', 'tsx', 'scripts/verify-conversation-query-plans.ts'] },
  { id: 'performance-trace-shared-build', command: 'pnpm', args: ['--filter', '@zeus/shared', 'build'] },
  { id: 'performance-trace-storage-build', command: 'pnpm', args: ['--filter', '@zeus/storage', 'build'] },
  { id: 'performance-trace-behavior', command: 'pnpm', args: ['exec', 'tsx', 'scripts/verify-performance-trace-behavior.ts'] },
  { id: 'execution-host-work-status', command: 'pnpm', args: ['exec', 'tsx', 'scripts/verify-execution-host-work-status.ts'] },
  { id: 'execution-host-v2-crash-recovery', command: 'pnpm', args: ['verify:execution-host-v2-crash-recovery'] },
  { id: 'data-root-identity-binding', command: 'pnpm', args: ['exec', 'tsx', 'scripts/verify-data-root-identity-binding.ts'] },
  { id: 'data-root-offline-adoption', command: 'pnpm', args: ['verify:data-root-offline-adoption'] },
  { id: 'detached-core-attach-cleanup', command: 'pnpm', args: ['exec', 'tsx', 'scripts/verify-detached-core-attach-cleanup.ts'] },
  { id: 'execution-host-close-plan', command: 'pnpm', args: ['exec', 'tsx', 'scripts/verify-execution-host-close-plan.ts'] },
  { id: 'execution-host-stop-command-behavior', command: 'pnpm', args: ['exec', 'tsx', 'scripts/verify-execution-host-stop-command-behavior.ts'] },
  { id: 'execution-host-stop-command-slice', command: 'node', args: ['scripts/audit-command-side-effect-entries.mjs', '--require-execution-host-stop-command-slice'] },
  { id: 'command-delivery-behavior', command: 'pnpm', args: ['exec', 'tsx', 'scripts/verify-command-delivery-behavior.ts'] },
  { id: 'command-center-command-behavior', command: 'pnpm', args: ['exec', 'tsx', 'scripts/verify-command-center-command-behavior.ts'] },
  { id: 'work-management-command-behavior', command: 'pnpm', args: ['exec', 'tsx', 'scripts/verify-work-management-command-behavior.ts'] },
  { id: 'work-management-task-command-slice', command: 'node', args: ['scripts/audit-command-side-effect-entries.mjs', '--require-work-management-task-command-slice'] },
  { id: 'runtime-session-command-behavior', command: 'pnpm', args: ['exec', 'tsx', 'scripts/verify-runtime-session-command-behavior.ts'] },
  { id: 'conversation-command-behavior', command: 'pnpm', args: ['exec', 'tsx', 'scripts/verify-conversation-command-behavior.ts'] },
  { id: 'graph-conversation-command-behavior', command: 'pnpm', args: ['exec', 'tsx', 'scripts/verify-graph-conversation-command-behavior.ts'] },
  { id: 'graph-conversation-command-slice', command: 'node', args: ['scripts/audit-command-side-effect-entries.mjs', '--require-graph-conversation-create-command-slice'] },
  { id: 'conversation-dispatch-command-behavior', command: 'pnpm', args: ['exec', 'tsx', 'scripts/verify-conversation-dispatch-command-behavior.ts'] },
  { id: 'integration-command-behavior', command: 'pnpm', args: ['exec', 'tsx', 'scripts/verify-integration-command-behavior.ts'] },
  { id: 'settings-command-behavior', command: 'pnpm', args: ['exec', 'tsx', 'scripts/verify-settings-command-behavior.ts'] },
  { id: 'telegram-command-behavior', command: 'pnpm', args: ['exec', 'tsx', 'scripts/verify-telegram-command-behavior.ts'] },
  { id: 'conversation-dispatch-command-slice', command: 'node', args: ['scripts/audit-command-side-effect-entries.mjs', '--require-conversation-dispatch-command-slice'] },
  { id: 'integration-command-slice', command: 'node', args: ['scripts/audit-command-side-effect-entries.mjs', '--require-integration-command-slice'] },
  { id: 'settings-command-slice', command: 'node', args: ['scripts/audit-command-side-effect-entries.mjs', '--require-settings-command-slice'] },
  { id: 'telegram-command-slice', command: 'node', args: ['scripts/audit-command-side-effect-entries.mjs', '--require-telegram-command-slice'] },
  { id: 'git-command-behavior', command: 'pnpm', args: ['exec', 'tsx', 'scripts/verify-git-command-behavior.ts'] },
  { id: 'git-command-slice', command: 'node', args: ['scripts/audit-command-side-effect-entries.mjs', '--require-git-command-slice'] },
  { id: 'workspace-git-command-behavior', command: 'pnpm', args: ['exec', 'tsx', 'scripts/verify-workspace-git-command-behavior.ts'] },
  { id: 'workspace-git-command-slice', command: 'node', args: ['scripts/audit-command-side-effect-entries.mjs', '--require-workspace-git-command-slice'] },
  { id: 'event-flow-behavior', command: 'pnpm', args: ['exec', 'tsx', '--tsconfig', 'apps/desktop/tsconfig.json', 'scripts/verify-event-flow-behavior.ts'] },
  { id: 'provider-runtime-recovery', command: 'pnpm', args: ['exec', 'tsx', 'scripts/verify-provider-runtime-recovery.ts'] },
  { id: 'pi-provider-command-delivery', command: 'pnpm', args: ['exec', 'tsx', 'scripts/verify-pi-provider-command-delivery.ts'] },
  { id: 'codex-provider-command-delivery', command: 'pnpm', args: ['exec', 'tsx', 'scripts/verify-codex-provider-command-delivery.ts'] },
  { id: 'codex-public-command-behavior', command: 'pnpm', args: ['exec', 'tsx', 'scripts/verify-codex-public-command-behavior.ts'] },
  { id: 'memory-command-behavior', command: 'pnpm', args: ['exec', 'tsx', 'scripts/verify-memory-command-behavior.ts'] },
  { id: 'renderer-event-flow', command: 'pnpm', args: ['exec', 'tsx', 'scripts/verify-renderer-event-flow.ts'] },
  { id: 'storage-fault-behavior', command: 'pnpm', args: ['exec', 'tsx', 'scripts/verify-storage-fault-behavior.ts'] },
  { id: 'storage-recovery-restart-scheduling', command: 'pnpm', args: ['verify:storage-recovery-restart'] },
  { id: 'artifact-store-behavior', command: 'pnpm', args: ['exec', 'tsx', 'scripts/verify-artifact-store-behavior.ts'] },
  { id: 'projection-database-behavior', command: 'pnpm', args: ['exec', 'tsx', 'scripts/verify-projection-database-behavior.ts'] },
  { id: 'recovery-promotion-behavior', command: 'pnpm', args: ['exec', 'tsx', 'scripts/verify-recovery-promotion-behavior.ts'] },
  { id: 'zeus-test-database-copy', command: 'pnpm', args: ['exec', 'tsx', 'scripts/verify-zeus-test-database-copy.ts'] },
  { id: 'read-only-validation-storage', command: 'pnpm', args: ['exec', 'tsx', 'scripts/verify-read-only-validation-database.ts'] },
  { id: 'read-only-validation-bootstrap-security', command: 'pnpm', args: ['exec', 'tsx', 'scripts/verify-read-only-validation-bootstrap-security.ts'] },
  { id: 'read-only-validation-fence', command: 'pnpm', args: ['exec', 'tsx', 'scripts/verify-read-only-validation-fence.ts'] },
  { id: 'read-only-validation-ipc-fence', command: 'pnpm', args: ['exec', 'tsx', 'scripts/verify-read-only-validation-ipc-fence.ts'] },
  { id: 'zeus-test-startup-snapshot', command: 'pnpm', args: ['exec', 'tsx', 'scripts/verify-zeus-test-startup-snapshot-behavior.ts'] },
  { id: 'keychain-service-isolation', command: 'pnpm', args: ['exec', 'tsx', 'scripts/verify-keychain-service-isolation.ts'] },
  { id: 'test-display-placement', command: 'pnpm', args: ['exec', 'tsx', 'scripts/verify-test-display-placement.ts'] },
  { id: 'test-data-root-isolation', command: 'pnpm', args: ['exec', 'tsx', 'scripts/verify-test-data-root-isolation.ts'] },
  { id: 'main-command-ledger-behavior', command: 'pnpm', args: ['exec', 'tsx', 'scripts/verify-main-command-ledger-behavior.ts'] },
  { id: 'electron-main-side-effect-inventory', command: 'node', args: ['scripts/audit-electron-main-side-effect-entries.mjs'] },
  { id: 'http-read-side-effect-inventory', command: 'node', args: ['scripts/audit-http-read-side-effects.mjs', '--require-clean'] },
  { id: 'http-read-purity', command: 'pnpm', args: ['exec', 'tsx', 'scripts/verify-http-read-purity.ts'] },
  { id: 'command-side-effect-coverage', command: 'node', args: ['scripts/audit-command-side-effect-entries.mjs', '--require-complete'] },
  { id: 'internal-side-effect-coverage', command: 'pnpm', args: ['exec', 'tsx', 'scripts/audit-internal-side-effect-entries.ts', '--require-complete'] },
  { id: 'command-governance-registry', command: 'pnpm', args: ['exec', 'tsx', 'scripts/verify-command-governance-registry.ts'] },
  { id: 'conversation-event-durability-registry', command: 'pnpm', args: ['exec', 'tsx', 'scripts/audit-conversation-event-durability-registry.ts'] },
  { id: 'renderer-transcript-window', command: 'pnpm', args: ['exec', 'tsx', 'scripts/probe-transcript-viewport.ts'] },
];

const results = [];
for (const check of checks) {
  const startedAt = performance.now();
  const result = spawnSync(check.command, check.args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  const durationMs = Math.round((performance.now() - startedAt) * 100) / 100;
  const exitCode = typeof result.status === 'number' ? result.status : 1;
  results.push({
    id: check.id,
    command: [check.command, ...check.args].join(' '),
    exitCode,
    durationMs,
    signal: result.signal ?? null,
    stdoutSummary: summarizeOutput(result.stdout),
    stderrSummary: summarizeOutput(result.stderr),
  });
}

const failed = results.filter((result) => result.exitCode !== 0);
process.stdout.write(
  `${JSON.stringify(
    {
      schemaVersion: 1,
      status: failed.length === 0 ? 'passed' : 'failed',
      generatedAt: new Date().toISOString(),
      checks: results,
      failedCheckIds: failed.map((result) => result.id),
    },
    null,
    2,
  )}\n`,
);
if (failed.length > 0) process.exitCode = 1;

function summarizeOutput(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return null;
  const maximumCharacters = 8_192;
  if (text.length <= maximumCharacters) return text;
  return `[truncated ${text.length - maximumCharacters} chars]\n${text.slice(-maximumCharacters)}`;
}
