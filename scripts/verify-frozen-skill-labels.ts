import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createZeusSkillService } from '../packages/local-server/src/zeusSkillService.js';
import { createCodexApiClient } from '../apps/desktop/src/renderer/features/codex/codexApiClient.js';
import type { LocalApiTransport } from '../apps/desktop/src/renderer/transport/localApiTransport.js';

/** 独立临时目录验证冻结名称读取，不访问用户真实清单或启动 Provider。 */
const root = await mkdtemp(join(tmpdir(), 'zeus-skill-labels-'));
/** 使用不透明目录复现截图中的路径形态。 */
const snapshotId = 'a'.repeat(64);
/** 故意让名称与目录不同，名称必须来自清单。 */
const catalog = { cwd: root, skills: [{ id: 'b'.repeat(32), name: 'domain-modeling', path: join(root, snapshotId, 'c'.repeat(24), 'SKILL.md') }], errors: [], refreshedAt: new Date().toISOString() };
/** 服务读取冻结清单时不得查询 Provider 或现有目录。 */
const service = createZeusSkillService({
  skillsRoot: join(root, 'skills'),
  snapshotRoot: root,
  manager: {
    /** 冻结名称读取不能走当前技能发现。 */
    async listSkills() {
      throw new Error('不得查询 Provider');
    },
  },
  /** 只读名称不允许启动外部运行服务。 */
  async ensureReady() {
    throw new Error('不得启动 Provider');
  },
});
try {
  await mkdir(join(root, snapshotId));
  await writeFile(join(root, snapshotId, 'catalog.json'), JSON.stringify(catalog));
  assert.deepEqual(await service.readFrozen(snapshotId), catalog);
  await assert.rejects(service.readFrozen('../catalog.json'), { code: 'ZEUS_SKILL_INPUT_INVALID' });
  await assert.rejects(service.readFrozen('d'.repeat(64)), { code: 'ZEUS_SKILL_NOT_FOUND' });
  /** 并发摘要和详情共用同一清单请求。 */
  let reads = 0;
  /** 实际客户端的只读传输边界，断言查询只指向指定冻结清单。 */
  const client = createCodexApiClient({
    /** 验证真实客户端发出的冻结清单查询。 */
    async request(path: string) {
      reads++;
      assert.equal(path, `/api/skills?snapshotId=${snapshotId}`);
      return service.readFrozen(snapshotId);
    },
  } as LocalApiTransport);
  assert.deepEqual(await Promise.all([client.loadSkills(undefined, false, snapshotId), client.loadSkills(undefined, false, snapshotId)]), [catalog, catalog]);
  assert.equal(reads, 1);
  /** 不同连接不共享清单或失败缓存。 */
  const failing = createCodexApiClient({
    /** 请求失败后必须允许再次读取。 */
    async request() {
      reads++;
      throw new Error('暂不可用');
    },
  } as unknown as LocalApiTransport);
  await assert.rejects(failing.loadSkills(undefined, false, snapshotId));
  await assert.rejects(failing.loadSkills(undefined, false, snapshotId));
  assert.equal(reads, 3);
  console.info('冻结技能名称：清单读取、路径边界、缺失降级、请求去重和失败重试检查通过。');
} finally {
  await rm(root, { recursive: true, force: true });
}
