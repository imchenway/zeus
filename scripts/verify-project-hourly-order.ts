import assert from 'node:assert/strict';
import { resolveProjectActivityOrder } from '../apps/desktop/src/renderer/features/projects/projectActivityOrder.js';
import type { ProjectRecord } from '../apps/desktop/src/renderer/features/projects/projectContracts.js';

/** 最小可运行检查：pnpm exec tsx scripts/verify-project-hourly-order.ts；仅按需手动运行。 */
function verifyProjectHourlyOrder(): void {
  /** 已冻结顺序用于检查实时计数、跨小时和同分规则。 */
  const previous = { hour: 100, projectIds: ['a', 'b'] };
  /** 两个项目分别在同一小时接纳 1 次和 10 次主动发送。 */
  const projects: ProjectRecord[] = [
    { id: 'a', name: '项目甲', localPath: '/a', activityHour: 100, hourlyUserMessageCount: 1 },
    { id: 'b', name: '项目乙', localPath: '/b', activityHour: 100, hourlyUserMessageCount: 10 },
  ];
  assert.deepEqual(resolveProjectActivityOrder(projects, previous), previous);
  assert.deepEqual(resolveProjectActivityOrder([], previous), previous);
  /** 新完整小时按发送数重排，下一小时同分继续保留该顺序。 */
  const nextProjects = projects.map((project) => ({ ...project, activityHour: 101 }));
  /** 当前小时的高活跃项目应当排在前面。 */
  const next = resolveProjectActivityOrder(nextProjects, previous);
  assert.deepEqual(next, { hour: 101, projectIds: ['b', 'a'] });
  assert.deepEqual(resolveProjectActivityOrder(nextProjects, previous, false), previous);
  assert.deepEqual(resolveProjectActivityOrder([nextProjects[0]!, projects[1]!], previous), previous);
  assert.deepEqual(resolveProjectActivityOrder(projects, next), next);
  assert.deepEqual(
    resolveProjectActivityOrder(
      nextProjects.map((project) => ({ ...project, activityHour: 102, hourlyUserMessageCount: 0 })),
      next,
    ),
    { hour: 102, projectIds: ['b', 'a'] },
  );
}

verifyProjectHourlyOrder();
