import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { userInfo } from 'node:os';
import { delimiter, extname, isAbsolute, join, resolve } from 'node:path';
import type { CommandShell } from '@zeus/shared';

/** 业务命令只继承公开执行上下文；宿主控制、bootstrap、认证和调试字段默认不外传。 */
const businessZeusEnvironmentKeys = new Set([
  'ZEUS_PROJECT_ROOT',
  'ZEUS_COMMAND_SCRIPTS_DIR',
  'ZEUS_COMMAND_RUN_DIR',
  'ZEUS_COMMAND_ID',
  'ZEUS_COMMAND_RUN_ID',
  'ZEUS_BUILTIN_NODE',
  'ZEUS_BUILTIN_WECHAT',
  'ZEUS_RELEASE_NOTES_API_URL',
  'ZEUS_RELEASE_NOTES_CAPABILITY',
  'ZEUS_CODEX_EXTERNAL_AGENT_HOME',
  'ZEUS_CODEX_COMMAND_PATH',
  'ZEUS_RUNTIME_TIMEOUT_SECONDS',
  'ZEUS_SHELL_PATH',
  'ZEUS_SHELL_LOGIN',
  'ZEUS_WINDOWS_DESKTOP_MODE',
  // 仅传递非敏感的系统凭据命名空间；口令始终由原生 askpass 通过管道交给 SSH。
  'ZEUS_GIT_ASKPASS_SERVICE',
  // 项目内的打包和发布脚本已使用这些业务配置，不能当成宿主控制字段删除。
  'ZEUS_PACKAGE_OUTPUT_DIR',
  'ZEUS_PACKAGE_VARIANT',
  'ZEUS_RELEASE_BUILD',
  'ZEUS_RELEASE_OUTPUT_DIR',
  'ZEUS_RELEASE_SIGNED',
  'ZEUS_RELEASE_NOTARIZED',
  'ZEUS_FAST_RELEASE',
  'ZEUS_REQUIRE_DISTRIBUTABLE_RELEASE',
  'ZEUS_RELEASE_ISOLATED_SOURCE',
  'ZEUS_RELEASE_VALIDATE_ISOLATION',
]);

/** Zeus 前缀属于宿主保留空间；已登记的业务配置在保存和执行边界使用同一规则。 */
export function isBusinessProcessEnvironmentKey(key: string): boolean {
  return !key.toUpperCase().startsWith('ZEUS_') || businessZeusEnvironmentKeys.has(key.toUpperCase());
}

/** 保留调用方明确使用的 Provider/业务环境，删除所有未登记的 Zeus 宿主私有字段。 */
export function businessProcessEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  /** 统一大小写后再筛选，防止 Windows 的混合大小写字段绕过边界。 */
  const env = normalizeProcessEnvironment(source);
  for (const key of Object.keys(env)) if (!isBusinessProcessEnvironmentKey(key)) delete env[key];
  return env;
}

/** 统一解析结果可交给 Node、PTY 或 Windows 私有宿主，不再次拼接参数。 */
export interface ExecutableInvocation {
  /** 已确认存在的启动程序。 */
  command: string;
  /** 参数数组；批处理参数由固定依赖转义。 */
  args: string[];
  /** Windows 环境变量去除大小写重复项。 */
  env: NodeJS.ProcessEnv;
  /** 为 cmd 生成的参数已经按 Windows 规则转义。 */
  windowsVerbatimArguments?: boolean;
}

/** 固定 cross-spawn 的解析入口，复用其批处理和 npm shim 转义。 */
const parseSpawn = createRequire(import.meta.url)('cross-spawn/lib/parse') as (command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => { command: string; args: string[]; options: { windowsVerbatimArguments?: boolean } };

/** Windows 环境大小写不敏感，保留最后一次显式覆盖，PATH 统一命名。 */
export function normalizeProcessEnvironment(source: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  if (platform !== 'win32') return { ...source };
  /** 后写值覆盖先前同名值，避免 Path/PATH 让实际启动读到旧目录。 */
  const entries = new Map<string, [string, string]>();
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) entries.delete(key.toUpperCase());
    else entries.set(key.toUpperCase(), [key.toUpperCase() === 'PATH' ? 'PATH' : key, value]);
  }
  return Object.fromEntries(entries.values());
}

/** 读取环境变量时遵守 Windows 名称大小写规则。 */
export function processEnvironmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return Object.entries(env).find(([key]) => (process.platform === 'win32' ? key.toUpperCase() === name.toUpperCase() : key === name))?.[1];
}

/** 程序只从显式路径或 PATH 查找；不把项目当前目录暗中加入 Windows 搜索路径。 */
export function findExecutable(command: string, env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string | null {
  if (!command || command.includes('\0')) return null;
  /** 显式相对路径以调用方工作目录解析。 */
  const explicit = isAbsolute(command) || /[\\/]/u.test(command);
  /** Windows 优先 PATHEXT，防止 npm 同目录的无扩展名 Unix shim 遮住 cmd；显式扩展名只检查原文件。 */
  const suffixes = process.platform === 'win32' && !extname(command) ? [...(processEnvironmentValue(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((value) => /^\.[a-z0-9]+$/iu.test(value)), ''] : [''];
  /** 空 PATH 项不代表当前项目，避免项目文件冒充系统工具。 */
  const directories = explicit ? [cwd] : (processEnvironmentValue(env, 'PATH') ?? '').split(delimiter).filter(Boolean);
  for (const directory of directories) {
    for (const suffix of suffixes) {
      /** PATH 条目可能由 Windows 安装器包上引号。 */
      const candidate = resolve(directory.replace(/^"|"$/gu, ''), `${command}${suffix}`);
      try {
        if (!statSync(candidate).isFile()) continue;
        accessSync(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
        return realpathSync(candidate);
      } catch {
        // 当前候选不可用时继续同一显式命令的扩展名或下一个 PATH 目录。
      }
    }
  }
  return null;
}

/** 取系统自带解释器的准确路径，不从项目目录寻找 cmd 或 PowerShell。 */
function windowsSystemShell(name: 'cmd' | 'powershell', env: NodeJS.ProcessEnv): string {
  /** SystemRoot 来自 Windows 系统环境，不使用写死的盘符。 */
  const root = processEnvironmentValue(env, 'SystemRoot');
  if (!root || !isAbsolute(root)) throw new Error('Windows SystemRoot 环境变量无效，命令尚未启动。');
  /** 系统 PowerShell 是固定语义，不自动升级为用户安装的 pwsh。 */
  const candidate = name === 'cmd' ? join(root, 'System32', 'cmd.exe') : join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const executable = findExecutable(candidate, env);
  if (!executable) throw new Error(`系统解释器不可用：${candidate}`);
  return executable;
}

/** PowerShell 管道统一使用 UTF-8，正文仍通过 UTF-16 编码参数完整传入。 */
export function powerShellCommandArguments(script: string): string[] {
  /** 系统 PowerShell 的默认代码页不能保证中文 JSON 与 Node 管道一致。 */
  const source = `[Console]::InputEncoding = [Console]::OutputEncoding = $OutputEncoding = [Text.UTF8Encoding]::new($false)\n& {\n${script}\n}`;
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')];
}

/** 解析普通程序和 Windows npm 批处理入口，转义只执行一次。 */
export function resolveExecutableInvocation(command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): ExecutableInvocation {
  /** 所有启动方共享最终环境，避免检测与运行看到不同 PATH。 */
  const env = normalizeProcessEnvironment(options.env);
  /** 缺少程序在外部写入边界之前报错，不伪装成执行结果未知。 */
  const executable = findExecutable(command, env, options.cwd);
  if (!executable) throw new Error(`找不到可执行程序：${command}。命令尚未启动。`);
  if (process.platform !== 'win32') return { command: executable, args: [...args], env };
  if (/\.ps1$/iu.test(executable)) return { command: windowsSystemShell('powershell', env), args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', executable, ...args], env };
  /** 固定依赖负责引号、百分号、感叹号和 node_modules/.bin 的双层解释。 */
  const parsed = parseSpawn(executable, [...args], { env });
  /** shebang 可能改为 node 等名称，再次固定绝对路径以免原生 API 搜索项目目录。 */
  const parsedCommand = parsed.options.windowsVerbatimArguments ? windowsSystemShell('cmd', env) : findExecutable(parsed.command, env, options.cwd);
  if (!parsedCommand) throw new Error(`程序解释器不可用：${parsed.command}`);
  return {
    command: parsedCommand,
    args: parsed.args,
    env,
    ...(parsed.options.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  };
}

/** 按保存的解释器执行脚本；不存在时拒绝，不自动换解释器重试。 */
export function resolveCommandInvocation(shell: CommandShell, script: string, sourceEnv: NodeJS.ProcessEnv = process.env): ExecutableInvocation {
  if (!script.trim() || script.includes('\0')) throw new Error('命令正文为空或包含空字符。');
  /** 先固定环境再解析解释器。 */
  const env = normalizeProcessEnvironment(sourceEnv);
  if (shell === 'powershell') {
    if (process.platform !== 'win32') throw new Error('此命令使用 Windows PowerShell，请在 Windows 执行或明确修改解释器和脚本。');
    return { command: windowsSystemShell('powershell', env), args: powerShellCommandArguments(script), env };
  }
  if (shell === 'cmd') {
    if (process.platform !== 'win32') throw new Error('此命令使用 Windows cmd，请在 Windows 执行或明确修改解释器和脚本。');
    /** cmd 的上限是展开前的完整命令行；不能把超限命令静默改成百分号语义不同的批处理。 */
    const command = windowsSystemShell('cmd', env);
    const args = ['/d', '/s', '/c', `"${script}"`];
    if (command.length + args.join(' ').length + 3 > 8191) throw new Error('Windows cmd 命令超过 8191 字符。请显式调用批处理文件；命令尚未启动。');
    return { command, args, env, windowsVerbatimArguments: true };
  }
  return resolveExecutableInvocation(shell, ['-lc', script], { env });
}

/** 交互终端采用对应解释器的参数，不把 Unix 登录参数传给 PowerShell。 */
export function resolveInteractiveShell(settings: { path: string | null; login: boolean }, env: NodeJS.ProcessEnv = process.env): { command: string; args: string[] } {
  /** Windows 默认使用系统 PowerShell；用户已保存的路径始终优先。 */
  const command = settings.path || (process.platform === 'win32' ? windowsSystemShell('powershell', env) : env.SHELL?.trim() || userInfo().shell || '/bin/sh');
  if (/(?:^|[\\/])(?:powershell|pwsh)(?:\.exe)?$/iu.test(command)) return { command, args: ['-NoLogo', '-NoExit'] };
  if (/(?:^|[\\/])cmd(?:\.exe)?$/iu.test(command)) return { command, args: ['/d', '/k'] };
  return { command, args: settings.login ? ['-l', '-i'] : ['-i'] };
}
