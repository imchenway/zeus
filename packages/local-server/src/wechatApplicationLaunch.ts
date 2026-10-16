import { fileURLToPath } from 'node:url';
import type { CommandDefinition } from '@zeus/shared';
import { builtinWechatInvocation } from './builtinWechatCommands.js';

/** 固定动作和正式内置身份一一对应，不把命令名称作为授权证据。 */
const actions = { 'builtin_wx-dev-upload': 'upload', 'builtin_wx-dev-preview': 'preview', 'builtin_wx-auto-preview': 'auto-preview', 'builtin_wx-remote-debug': 'remote-debug' } as const;

/** 只有未改写的内置微信命令可以启动用户持有的开发者工具，普通命令仍受 Job 管理。 */
export function resolveWechatApplicationLaunch(definition: CommandDefinition): { command: string; args: string[] } | null {
  if (process.platform !== 'win32' || !Object.hasOwn(actions, definition.id)) return null;
  /** 固定动作不能来自用户参数或可修改的正文。 */
  const action = actions[definition.id as keyof typeof actions];
  /** 模板和解释器均须匹配应用提供的原始定义。 */
  const known = (['darwin', 'win32'] as const).map((platform) => builtinWechatInvocation(action, platform));
  if (!known.some((template) => template.command === definition.command && template.shell === (definition.shell ?? 'sh'))) return null;
  /** 随包入口由模块位置确定，不接受环境变量覆盖。 */
  const entry = fileURLToPath(new URL('./wechatCommandRunner.js', import.meta.url));
  return { command: process.execPath, args: [entry, action] };
}
