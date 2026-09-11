import { CommandDefinitionRepository, SettingRepository, type ZeusDatabase } from '@zeus/storage';
import { type CommandDefinitionInput, type CommandParameterDefinition, validateCommandDefinitionInput } from '@zeus/shared';

/** 所有微信操作共用的项目与开发者工具参数；留空时使用当前项目和标准安装位置。 */
const wechatParameters: CommandParameterDefinition[] = [
  { key: 'WX_PROJECT_PATH', label: '小程序项目目录', description: '包含 project.config.json 的目录；留空使用当前项目。相对路径以当前项目为起点。', type: 'string', required: false, sensitive: false },
  { key: 'WX_CLI_PATH', label: '微信开发者工具路径', description: '非标准安装位置时填写 CLI 文件路径；留空自动查找。', type: 'string', required: false, sensitive: false },
  { key: 'WX_PORT', label: '开发者工具服务端口', description: '通常留空由微信工具识别；使用指定端口时填写 1–65535。', type: 'number', required: false, sensitive: false },
];

/** 随应用交付的微信命令目录，执行仍经过通用命令的确认、权限、日志与产物链路。 */
export const builtinWechatCommands: CommandDefinitionInput[] = [
  { name: 'wx-dev-upload', title: '微信开发版上传', action: 'upload', description: '上传当前小程序开发版。需安装并登录微信开发者工具、开启服务端口。' },
  { name: 'wx-dev-preview', title: '微信开发版预览', action: 'preview', description: '生成小程序预览二维码并保存为执行产物。需登录微信开发者工具、开启服务端口。' },
  { name: 'wx-auto-preview', title: '微信手机自动预览', action: 'auto-preview', description: '向手机发起自动预览并保存返回信息。需登录微信开发者工具、开启服务端口。' },
  { name: 'wx-remote-debug', title: '微信真机调试', action: 'remote-debug', description: '发起免扫码真机调试，等待手机连接后保存设备信息。需登录微信开发者工具、开启服务端口。' },
].map(({ action, ...definition }) => ({
  ...definition,
  command: `ELECTRON_RUN_AS_NODE=1 "$ZEUS_BUILTIN_NODE" "$ZEUS_BUILTIN_WECHAT" ${action}`,
  parameters: [
    ...wechatParameters,
    ...(action === 'upload'
      ? [
          { key: 'WX_VERSION', label: '上传版本号', description: '微信开发版的版本号。', type: 'string' as const, required: true, sensitive: false },
          { key: 'WX_DESCRIPTION', label: '版本备注', description: '本次上传的说明。', type: 'string' as const, required: false, sensitive: false },
        ]
      : []),
  ],
  timeoutSeconds: 600,
  enabled: true,
  telegramEnabled: false,
  riskFlags: { gitWrite: false, outsideProjectWrite: true, externalServiceWrite: true },
}));

/** 首次启动补齐内置命令；同名或同别名的用户定义优先，后续启动不恢复用户删除的命令。 */
export function installBuiltinWechatCommands(db: ZeusDatabase): void {
  /** 持久化初始化标记，避免启动时覆盖用户修改或重新启用已删除命令。 */
  const installationKey = 'commands.builtinWechatInstalled';
  /** 默认命令属于应用设置，不写入受防降级保护的数据库结构迁移历史。 */
  const settings = new SettingRepository(db);
  if (settings.getJson<boolean>(installationKey)) return;
  /** 使用既有仓库维护名称、参数与别名。 */
  const definitions = new CommandDefinitionRepository(db);
  db.transaction(() => {
    for (const definition of builtinWechatCommands) {
      if (validateCommandDefinitionInput(definition).length) throw new Error(`内置微信命令定义无效：${definition.name}`);
      if (definitions.findTokenConflicts({ scope: 'global', projectId: null, tokens: [definition.name] }).length) continue;
      definitions.create({ ...definition, id: `builtin_${definition.name}`, scope: 'global', projectId: null });
    }
    settings.setJson(installationKey, true);
  });
}
