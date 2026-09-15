import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { type CommandDefinitionInput, validateCommandDefinitionInput } from '@zeus/shared';
import { CommandDefinitionRepository, ProjectRepository, SettingRepository, type ZeusDatabase } from '@zeus/storage';

/** 当前仓库专用的受控发布命令；执行仍经过项目权限和高风险确认。 */
export const builtinReleaseCommand: CommandDefinitionInput = {
  name: 'zeus-release',
  aliases: ['release'],
  title: '发布新版',
  description: '执行 Zeus 受控发布流程：生成发布说明、递增补丁版本、运行发布门禁、推送并回验 GitHub Release。失败后可用同一命令幂等继续。',
  command: 'pnpm release',
  parameters: [],
  timeoutSeconds: 3_600,
  enabled: true,
  telegramEnabled: false,
  riskFlags: { gitWrite: true, outsideProjectWrite: true, externalServiceWrite: true },
};

/** 仅为已登记且路径匹配当前仓库的项目安装一次发布命令。 */
export function installBuiltinReleaseCommand(db: ZeusDatabase, projects: ProjectRepository, projectRoot: string): void {
  const installationKey = 'commands.builtinReleaseInstalled';
  const settings = new SettingRepository(db);
  if (settings.getJson<boolean>(installationKey)) return;

  const project = projects.list().find((candidate) => sameLocalPath(candidate.localPath, projectRoot));
  if (!project) return;
  if (validateCommandDefinitionInput(builtinReleaseCommand).length > 0) throw new Error('内置发布命令定义无效。');

  const definitions = new CommandDefinitionRepository(db);
  db.transaction(() => {
    if (definitions.findTokenConflicts({ scope: 'project', projectId: project.id, tokens: [builtinReleaseCommand.name, ...(builtinReleaseCommand.aliases ?? [])] }).length === 0) {
      definitions.create({ ...builtinReleaseCommand, scope: 'project', projectId: project.id });
    }
    settings.setJson(installationKey, true);
  });
}

function sameLocalPath(left: string, right: string): boolean {
  return canonicalLocalPath(left) === canonicalLocalPath(right);
}

function canonicalLocalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}
