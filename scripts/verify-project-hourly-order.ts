import assert from 'node:assert/strict';
import { resolveProjectActivityOrder } from '../apps/desktop/src/renderer/features/projects/projectActivityOrder.js';
import type { ProjectRecord } from '../apps/desktop/src/renderer/features/projects/projectContracts.js';

/** 最小可运行检查：pnpm exec tsx scripts/verify-project-hourly-order.ts；仅按需手动运行。 */
function verifyProjectHourlyOrder(): void {
  /** 已冻结顺序用于检查实时计数、跨小时和同分规则。 */
  const previous = { hour: 100, projectIds: ['a', 'b'], activeProjectIds: [] };
  /** 两个项目分别在同一小时接纳 1 次和 10 次主动发送。 */
  const projects: ProjectRecord[] = [
    { id: 'a', name: '项目甲', localPath: '/a', activityHour: 100, hourlyUserMessageCount: 1, currentHourUserMessageCount: 0 },
    { id: 'b', name: '项目乙', localPath: '/b', activityHour: 100, hourlyUserMessageCount: 10, currentHourUserMessageCount: 0 },
  ];
  assert.deepEqual(resolveProjectActivityOrder(projects, previous), previous);
  assert.deepEqual(resolveProjectActivityOrder([], previous), previous);
  /** 新完整小时按发送数重排，下一小时同分继续保留该顺序。 */
  const nextProjects = projects.map((project) => ({ ...project, activityHour: 101 }));
  /** 当前小时的高活跃项目应当排在前面。 */
  const next = resolveProjectActivityOrder(nextProjects, previous);
  assert.deepEqual(next, { hour: 101, projectIds: ['b', 'a'], activeProjectIds: [] });
  assert.deepEqual(resolveProjectActivityOrder(nextProjects, previous, false), previous);
  assert.deepEqual(resolveProjectActivityOrder([nextProjects[0]!, projects[1]!], previous), previous);
  assert.deepEqual(resolveProjectActivityOrder(projects, next), next);
  assert.deepEqual(
    resolveProjectActivityOrder(
      nextProjects.map((project) => ({ ...project, activityHour: 102, hourlyUserMessageCount: 0 })),
      next,
    ),
    { hour: 102, projectIds: ['b', 'a'], activeProjectIds: [] },
  );
  /** 两个项目首次活跃时按本小时计数排序，不沿用上一小时的高低。 */
  const active = nextProjects.map((project) => ({ ...project, currentHourUserMessageCount: project.id === 'a' ? 2 : 1 }));
  /** 本小时已触发的项目记录与最终顺序一起保存。 */
  const firstActivity = resolveProjectActivityOrder(active, next);
  assert.deepEqual(firstActivity, { hour: 101, projectIds: ['a', 'b'], activeProjectIds: ['a', 'b'] });
  assert.deepEqual(resolveProjectActivityOrder(active, next, false), next);
  assert.deepEqual(resolveProjectActivityOrder([{ ...active[0]!, currentHourUserMessageCount: undefined }, active[1]!], next), next);
  /** 同一项目后来发送更多消息仍不重排，模拟重启恢复后也保持相同结果。 */
  const later = active.map((project) => ({ ...project, currentHourUserMessageCount: project.id === 'b' ? 5 : 2 }));
  assert.deepEqual(resolveProjectActivityOrder(later, JSON.parse(JSON.stringify(firstActivity))), firstActivity);
  /** 第三个项目首次活跃时，按全部项目当前计数重排，而非将新项目直接置前。 */
  const third: ProjectRecord = { id: 'c', name: '项目丙', localPath: '/c', activityHour: 101, hourlyUserMessageCount: 0, currentHourUserMessageCount: 1 };
  /** 新项目只触发一次，迟到的上一小时数据不能回退顺序或触发记录。 */
  const reordered = resolveProjectActivityOrder([...later, third], firstActivity);
  assert.deepEqual(reordered, { hour: 101, projectIds: ['b', 'a', 'c'], activeProjectIds: ['a', 'b', 'c'] });
  assert.deepEqual(resolveProjectActivityOrder([...later, third], reordered), reordered);
  assert.deepEqual(
    resolveProjectActivityOrder(
      [...later, third].map((project) => ({ ...project, activityHour: 100 })),
      reordered,
    ),
    reordered,
  );
  assert.deepEqual(
    resolveProjectActivityOrder(
      [...later, third].map((project) => ({ ...project, activityHour: 102, hourlyUserMessageCount: 0, currentHourUserMessageCount: 0 })),
      reordered,
    ),
    { hour: 102, projectIds: ['b', 'a', 'c'], activeProjectIds: [] },
  );
}

verifyProjectHourlyOrder();
