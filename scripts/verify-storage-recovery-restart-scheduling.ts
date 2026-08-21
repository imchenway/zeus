import { StorageRecoveryRestartCoordinator } from '../apps/desktop/src/main/storageRecoveryRestartCoordinator.js';

const coordinator = new StorageRecoveryRestartCoordinator();
let scheduled = 0;
let receiptFailureObserved = false;

assertBehavior(!coordinator.ensureScheduled(() => (scheduled += 1)), '预检尚未通过时不得安排重启。');

try {
  try {
    await fakeMainLedgerExecute(async () => {
      coordinator.request();
      return { restartScheduled: true as const };
    });
  } finally {
    coordinator.ensureScheduled(() => {
      scheduled += 1;
    });
  }
} catch (error) {
  receiptFailureObserved = error instanceof Error && error.message === 'synthetic receipt fsync failure';
}

assertBehavior(receiptFailureObserved, '行为探针必须经过 effect 成功、Main receipt 失败的窗口。');
assertBehavior(coordinator.isRequested() && scheduled === 1, 'receipt 失败后仍必须恰好安排一次真实重启。');
assertBehavior(!coordinator.ensureScheduled(() => (scheduled += 1)) && scheduled === 1, '重复 finally 不得安装第二个重启 timer。');

console.log(JSON.stringify({ status: 'passed', observed: { receiptFailureObserved, restartRequested: coordinator.isRequested(), scheduled } }, null, 2));

async function fakeMainLedgerExecute<T>(effect: () => Promise<T>): Promise<T> {
  await effect();
  throw new Error('synthetic receipt fsync failure');
}

function assertBehavior(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`存储恢复重启调度行为探针失败：${message}`);
}
