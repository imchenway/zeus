import { accessSync, constants } from 'node:fs';
import { isAbsolute } from 'node:path';

/** 在 Core 与模型进程启动前安装共用 askpass；系统凭据库按现有产品身份隔离。 */
export function configureProjectGitAuthentication(helperPath: string, service: string): void {
  if (process.platform !== 'darwin' && process.platform !== 'win32') return;
  if (!isAbsolute(helperPath) || !service || service.trim() !== service || service.length > 160 || /\p{Cc}/u.test(service)) throw new Error('Git 系统认证组件配置无效。');
  accessSync(helperPath, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
  // 显式提供的 askpass 和禁用交互策略仍由用户控制；默认覆盖没有终端的模型命令。
  process.env.GIT_ASKPASS ||= helperPath;
  process.env.SSH_ASKPASS ||= helperPath;
  process.env.SSH_ASKPASS_REQUIRE ||= 'force';
  process.env.DISPLAY ||= 'zeus';
  process.env.ZEUS_GIT_ASKPASS_SERVICE = `${service}.Git.SSH`;
}
