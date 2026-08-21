import type { Rectangle } from 'electron';

export interface TestDisplayPlacementDisplay {
  id: string | number;
  internal: boolean;
  detected?: boolean;
  workArea: Rectangle;
}

export interface TestDisplayPlacement {
  bounds: Rectangle;
  targetDisplayId: string;
}

export type TestDisplayPlacementErrorCode = 'ZEUS_TEST_DISPLAY_ID_INVALID' | 'ZEUS_TEST_DISPLAY_NOT_FOUND' | 'ZEUS_TEST_DISPLAY_NOT_EXTERNAL' | 'ZEUS_TEST_DISPLAY_IS_PRIMARY' | 'ZEUS_TEST_DISPLAY_WORK_AREA_INVALID';

export class TestDisplayPlacementError extends Error {
  constructor(
    readonly code: TestDisplayPlacementErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TestDisplayPlacementError';
  }
}

/**
 * 打包测试身份可显式要求首个窗口在指定非主外接屏内创建。
 * 这里直接返回 BrowserWindow 构造参数；调用方不得先创建窗口再移动。
 */
export function resolveTestDisplayPlacement(input: {
  requestedDisplayId: string;
  displays: readonly TestDisplayPlacementDisplay[];
  primaryDisplayId: string | number;
  preferredSize: { width: number; height: number };
  minimumSize: { width: number; height: number };
}): TestDisplayPlacement {
  const requestedDisplayId = input.requestedDisplayId.trim();
  if (!/^-?\d+$/.test(requestedDisplayId) || !Number.isSafeInteger(Number(requestedDisplayId))) {
    throw new TestDisplayPlacementError('ZEUS_TEST_DISPLAY_ID_INVALID', `ZEUS_TEST_DISPLAY_ID 不是有效显示器 ID：${requestedDisplayId || '(empty)'}`);
  }

  const target = input.displays.find((display) => String(display.id) === requestedDisplayId && display.detected !== false);
  if (!target) {
    throw new TestDisplayPlacementError('ZEUS_TEST_DISPLAY_NOT_FOUND', `指定的测试显示器当前不可用：${requestedDisplayId}`);
  }
  if (String(target.id) === String(input.primaryDisplayId)) {
    throw new TestDisplayPlacementError('ZEUS_TEST_DISPLAY_IS_PRIMARY', `指定的测试显示器是当前主屏，拒绝创建测试窗口：${requestedDisplayId}`);
  }
  if (target.internal) {
    throw new TestDisplayPlacementError('ZEUS_TEST_DISPLAY_NOT_EXTERNAL', `指定的测试显示器是内置屏，拒绝创建测试窗口：${requestedDisplayId}`);
  }

  const workArea = normalizeRectangle(target.workArea);
  if (!workArea) {
    throw new TestDisplayPlacementError('ZEUS_TEST_DISPLAY_WORK_AREA_INVALID', `指定测试显示器的工作区无效：${requestedDisplayId}`);
  }
  const width = Math.min(workArea.width, Math.max(input.minimumSize.width, normalizeDimension(input.preferredSize.width, input.minimumSize.width)));
  const height = Math.min(workArea.height, Math.max(input.minimumSize.height, normalizeDimension(input.preferredSize.height, input.minimumSize.height)));
  return {
    bounds: {
      x: Math.round(workArea.x + (workArea.width - width) / 2),
      y: Math.round(workArea.y + (workArea.height - height) / 2),
      width,
      height,
    },
    targetDisplayId: String(target.id),
  };
}

function normalizeRectangle(value: Rectangle): Rectangle | undefined {
  if (![value.x, value.y, value.width, value.height].every((part) => Number.isFinite(part))) return undefined;
  if (value.width <= 0 || value.height <= 0) return undefined;
  return {
    x: Math.round(value.x),
    y: Math.round(value.y),
    width: Math.round(value.width),
    height: Math.round(value.height),
  };
}

function normalizeDimension(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : fallback;
}
