import assert from 'node:assert/strict';
import { resolveTestDisplayPlacement, TestDisplayPlacementError } from '../apps/desktop/src/main/testDisplayPlacement.js';

const displays = [
  { id: 1, internal: true, workArea: { x: 0, y: 0, width: 1512, height: 982 } },
  { id: 5, internal: false, workArea: { x: 1512, y: 0, width: 2304, height: 1296 } },
  { id: 3, internal: false, workArea: { x: 3816, y: -420, width: 1296, height: 2240 } },
] as const;

const placement = resolveTestDisplayPlacement({
  requestedDisplayId: '3',
  displays,
  primaryDisplayId: 5,
  preferredSize: { width: 1240, height: 820 },
  minimumSize: { width: 640, height: 560 },
});
assert.deepEqual(placement, {
  targetDisplayId: '3',
  bounds: { x: 3844, y: 290, width: 1240, height: 820 },
});

for (const [requestedDisplayId, expectedCode] of [
  ['', 'ZEUS_TEST_DISPLAY_ID_INVALID'],
  ['404', 'ZEUS_TEST_DISPLAY_NOT_FOUND'],
  ['1', 'ZEUS_TEST_DISPLAY_NOT_EXTERNAL'],
  ['5', 'ZEUS_TEST_DISPLAY_IS_PRIMARY'],
] as const) {
  assert.throws(
    () =>
      resolveTestDisplayPlacement({
        requestedDisplayId,
        displays,
        primaryDisplayId: 5,
        preferredSize: { width: 1240, height: 820 },
        minimumSize: { width: 640, height: 560 },
      }),
    (error: unknown) => error instanceof TestDisplayPlacementError && error.code === expectedCode,
  );
}

console.info(JSON.stringify({ verified: true, targetDisplayId: placement.targetDisplayId, bounds: placement.bounds }));
