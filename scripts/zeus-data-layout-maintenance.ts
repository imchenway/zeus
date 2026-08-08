import { prepareZeusDataRoot, retireVerifiedLegacyRoot } from '../apps/desktop/src/main/zeusDataMigration.js';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const [action, root, ...argumentsAfterRoot] = process.argv.slice(2);
if (!action || !root || !['migrate', 'retire-legacy-root'].includes(action)) {
  throw new Error('用法：tsx scripts/zeus-data-layout-maintenance.ts <migrate|retire-legacy-root> <数据根> [--copy-root] [--legacy-root <旧根>]');
}

const legacyRoots: string[] = [];
let copyRoot = false;
for (let index = 0; index < argumentsAfterRoot.length; index += 1) {
  if (argumentsAfterRoot[index] === '--copy-root') {
    copyRoot = true;
    continue;
  }
  if (argumentsAfterRoot[index] !== '--legacy-root' || !argumentsAfterRoot[index + 1]) {
    throw new Error('参数只允许 --copy-root 或 --legacy-root <绝对路径>。');
  }
  legacyRoots.push(argumentsAfterRoot[index + 1]!);
  index += 1;
}

if (action === 'migrate') {
  if (!copyRoot) throw new Error('脚本迁移只允许隔离副本，并且必须显式传入 --copy-root；正式根必须由已安装的新 Zeus 在启动执行宿主前迁移。');
  if (resolve(root) === resolve(join(homedir(), '.zeus'))) throw new Error('禁止用 worktree 维护脚本迁移正式 ~/.zeus；请先发布并安装包含相同布局代码的新 Zeus。');
  const result = prepareZeusDataRoot(root, legacyRoots);
  console.log(
    JSON.stringify(
      {
        status: result.status,
        layout: result.layout.kind,
        database: result.layout.database,
        migrationManifestPath: result.migrationManifestPath,
      },
      null,
      2,
    ),
  );
} else {
  if (copyRoot) throw new Error('回收旧根不接受 --copy-root。');
  if (legacyRoots.length !== 1) throw new Error('回收旧根时必须且只能提供一个 --legacy-root。');
  console.log(JSON.stringify(retireVerifiedLegacyRoot(root, legacyRoots[0]!), null, 2));
}
