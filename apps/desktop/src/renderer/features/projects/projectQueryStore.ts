import { userFacingErrorCause, type UserFacingErrorCause } from '@zeus/shared';
import type { ProjectApiClient } from './projectApiClient.js';
import type { ProjectRecord } from '../../apiClient.js';
import { errorMessage, ExternalStore } from '../../externalStore.js';
import { readProjectActivityOrder, resolveProjectActivityOrder, writeProjectActivityOrder, type ProjectActivityOrder } from './projectActivityOrder.js';

export interface ProjectQuerySnapshot {
  items: readonly ProjectRecord[];
  selectedProjectId: string | null;
  loading: boolean;
  error: string | null;
  /** 可选底层原因供界面生成本地化提示，原错误字符串仍保留。 */
  errorCause?: UserFacingErrorCause | null;
  revision: number;
}

export class ProjectQueryStore extends ExternalStore<ProjectQuerySnapshot> {
  /** 最近完整小时冻结的顺序，不由会话状态或单条项目更新推进。 */
  private activityOrder: ProjectActivityOrder;

  /** 首屏恢复已保存的自动顺序，再接入当前小时的完整统计。 */
  constructor(
    private readonly client: ProjectApiClient | null,
    initialItems: readonly ProjectRecord[],
  ) {
    /** 初始完整快照与本机顺序共同决定首屏顺序，避免挂载后跳动。 */
    const activityOrder = resolveProjectActivityOrder(initialItems, readProjectActivityOrder());
    /** 初始项目位置。 */
    const ranks = new Map(activityOrder.projectIds.map((id, index) => [id, index]));
    super({
      items: [...initialItems].sort((left, right) => ranks.get(left.id)! - ranks.get(right.id)!),
      selectedProjectId: initialItems[0]?.id ?? null,
      loading: false,
      error: null,
      errorCause: null,
      revision: 0,
    });
    this.activityOrder = activityOrder;
  }

  /** 刷新依据是已采用的完整统计，不能把局部回执误认为整批已刷新。 */
  getActivityHour(): number {
    return this.activityOrder.hour;
  }

  /** 完整查询允许推进小时；编辑回执及筛选列表只更新内容。 */
  replace(items: readonly ProjectRecord[], complete = true): void {
    /** 迟到响应不能把已知统计时间回退到上个小时。 */
    const previousActivity = new Map(this.snapshot.items.map((item) => [item.id, item]));
    items = items.map((item) => {
      /** 其他项目字段仍由既有查询流程接管。 */
      const previous = previousActivity.get(item.id);
      return (previous?.activityHour ?? -1) > (item.activityHour ?? -1) ? { ...item, activityHour: previous?.activityHour, hourlyUserMessageCount: previous?.hourlyUserMessageCount } : item;
    });
    this.activityOrder = resolveProjectActivityOrder(items, readProjectActivityOrder(this.activityOrder), complete);
    writeProjectActivityOrder(this.activityOrder);
    /** 各项目视图直接复用此顺序，不各自计算活跃排名。 */
    const ranks = new Map(this.activityOrder.projectIds.map((id, index) => [id, index]));
    items = [...items].sort((left, right) => ranks.get(left.id)! - ranks.get(right.id)!);
    // 任务分页和局部写回不改变项目记录时，不重复发布项目集合。
    if (items === this.snapshot.items || (items.length === this.snapshot.items.length && items.every((item, index) => item === this.snapshot.items[index]))) return;
    const selectedProjectId = this.snapshot.selectedProjectId && items.some((item) => item.id === this.snapshot.selectedProjectId) ? this.snapshot.selectedProjectId : (items[0]?.id ?? null);
    this.publish({ ...this.snapshot, items, selectedProjectId, error: null, errorCause: null, revision: this.snapshot.revision + 1 });
  }

  select(projectId: string | null): void {
    if (projectId === this.snapshot.selectedProjectId) return;
    this.publish({ ...this.snapshot, selectedProjectId: projectId });
  }

  async load(query?: string): Promise<readonly ProjectRecord[]> {
    const client = this.requireClient();
    this.publish({ ...this.snapshot, loading: true, error: null, errorCause: null });
    try {
      const items = await client.loadProjects(query ? { query } : undefined);
      this.replace(items, !query);
      this.publish({ ...this.snapshot, loading: false });
      return items;
    } catch (error) {
      this.publish({ ...this.snapshot, loading: false, error: errorMessage(error), errorCause: userFacingErrorCause(error) });
      throw error;
    }
  }

  async loadOne(projectId: string): Promise<ProjectRecord> {
    const project = await this.requireClient().loadProject(projectId);
    this.upsert(project);
    return project;
  }

  upsert(project: ProjectRecord): void {
    const items = this.snapshot.items.some((item) => item.id === project.id) ? this.snapshot.items.map((item) => (item.id === project.id ? project : item)) : [...this.snapshot.items, project];
    this.replace(items, false);
  }

  remove(projectId: string): void {
    this.replace(this.snapshot.items.filter((item) => item.id !== projectId));
  }

  private requireClient(): ProjectApiClient {
    if (!this.client) throw new Error('Project API client is unavailable.');
    return this.client;
  }
}
