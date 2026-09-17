import type { ContextCapacityCapability } from '@zeus/shared';

/** 将项目记住的值作为初始选择，界面只显示具体容量或默认。 */
export function contextCapacitySelectionValue(value: number | null | undefined, projectCapacity?: number | null): string {
  const capacity = value === undefined ? projectCapacity : value;
  return capacity == null ? 'default' : String(capacity);
}

/** 下拉选择始终产生明确值，默认用空值表示。 */
export function contextCapacitySelectionFromValue(value: string): number | null {
  return value === 'default' ? null : Number(value);
}

/** 所有入口共用单行选项；上限由当前模型提供。 */
export function contextCapacitySelectionOptions(capability: ContextCapacityCapability | undefined, zh: boolean) {
  return [{ value: 'default', label: zh ? '默认' : 'Default' }, ...(capability?.choices ?? []).map((capacity) => ({ value: String(capacity), label: capacity >= 1_000_000 ? `${capacity / 1_000_000}M` : `${capacity / 1_000}K` }))];
}

/** 切换模型后不能静默保留不支持的容量。 */
export function contextCapacitySelectionAllowed(value: number | null | undefined, projectCapacity: number | null | undefined, capability: ContextCapacityCapability | undefined): boolean {
  const capacity = value === undefined ? projectCapacity : value;
  return capacity == null || capability?.choices.includes(capacity) === true;
}
