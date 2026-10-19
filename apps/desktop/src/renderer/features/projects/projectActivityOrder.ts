import type { ProjectRecord } from './projectContracts.js';

/** 本机项目顺序沿用现有界面偏好的 localStorage 存储范围。 */
export const projectActivityOrderStorageKey = 'zeus.project-activity-order';

/** 每小时冻结一次的自动顺序，手动置顶由界面共享入口单独处理。 */
export interface ProjectActivityOrder {
  /** 已采用统计结果的 UTC 小时，尚未取得完整统计时为 -1。 */
  hour: number;
  /** 自动顺序中的项目身份，不保存项目内容。 */
  projectIds: string[];
}

/** 只在所有项目取得同一新小时统计时重排，同分沿用原顺序。 */
export function resolveProjectActivityOrder(projects: readonly ProjectRecord[], previous: ProjectActivityOrder, complete = true): ProjectActivityOrder {
  if (projects.length === 0) return previous;
  /** 已冻结的位置优先于响应数组顺序，新增项目按创建时间和身份追加。 */
  const previousRanks = new Map(previous.projectIds.map((id, index) => [id, index]));
  /** 尚未采用活跃度时的稳定基准顺序。 */
  const ordered = [...projects].sort(
    (left, right) => (previousRanks.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (previousRanks.get(right.id) ?? Number.MAX_SAFE_INTEGER) || (left.createdAt ?? '').localeCompare(right.createdAt ?? '') || left.id.localeCompare(right.id),
  );
  /** 一次局部更新不能把未刷新的项目按零分参与重排。 */
  const hour = projects[0]?.activityHour;
  /** 无统计、旧响应和同小时迟到数据均保持当前顺序。 */
  const advance =
    complete &&
    hour !== undefined &&
    Number.isSafeInteger(hour) &&
    hour > previous.hour &&
    projects.every((project) => project.activityHour === hour && Number.isSafeInteger(project.hourlyUserMessageCount) && project.hourlyUserMessageCount! >= 0);
  if (advance) ordered.sort((left, right) => right.hourlyUserMessageCount! - left.hourlyUserMessageCount!);
  /** 局部列表保留未包含的项目位置，完整列表可以移除已删除项目。 */
  const projectIds = complete ? ordered.map((project) => project.id) : [...previous.projectIds, ...ordered.filter((project) => !previousRanks.has(project.id)).map((project) => project.id)];
  return { hour: advance ? hour : previous.hour, projectIds };
}

/** 恢复本机顺序；损坏或不可访问的偏好只降级为当前窗口已有状态。 */
export function readProjectActivityOrder(fallback: ProjectActivityOrder = { hour: -1, projectIds: [] }): ProjectActivityOrder {
  try {
    if (typeof window === 'undefined') return fallback;
    /** 持久数据必须校验后才能参与排序。 */
    const value: unknown = JSON.parse(window.localStorage.getItem(projectActivityOrderStorageKey) ?? 'null');
    if (!value || typeof value !== 'object') return fallback;
    /** 只接纳已知结构，拒绝无效小时及重复项目身份。 */
    const candidate = value as Partial<ProjectActivityOrder>;
    if (
      !Number.isSafeInteger(candidate.hour) ||
      candidate.hour! < fallback.hour ||
      !Array.isArray(candidate.projectIds) ||
      !candidate.projectIds.every((id) => typeof id === 'string' && id.length > 0) ||
      new Set(candidate.projectIds).size !== candidate.projectIds.length
    )
      return fallback;
    return candidate as ProjectActivityOrder;
  } catch {
    return fallback;
  }
}

/** 保存已冻结顺序；存储不可用时仍保留当前窗口顺序。 */
export function writeProjectActivityOrder(order: ProjectActivityOrder): void {
  try {
    if (typeof window === 'undefined') return;
    /** 只写实际变化，避免多个窗口的 storage 事件相互触发。 */
    const serialized = JSON.stringify(order);
    if (window.localStorage.getItem(projectActivityOrderStorageKey) !== serialized) window.localStorage.setItem(projectActivityOrderStorageKey, serialized);
  } catch {
    // 与既有界面偏好一致：本机存储不可用时，仅失去重启后的顺序恢复。
  }
}
