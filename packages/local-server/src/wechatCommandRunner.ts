import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { resolveExecutableInvocation, processEnvironmentValue } from '@zeus/ai-runtime';
import { accessSync, constants, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import automator from 'miniprogram-automator';

/** 解析用户输入的本地路径，支持家目录及相对当前项目的路径。 */
function localPath(value: string, base: string): string {
  return resolve(base, value === '~' ? homedir() : value.startsWith('~/') ? join(homedir(), value.slice(2)) : value);
}

/** 端口属于外部输入，只接受有效整数，不能交给 CLI 隐式截断。 */
function servicePort(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  if (!/^\d+$/u.test(value) || Number(value) < 1 || Number(value) > 65535) throw new Error('开发者工具服务端口必须为 1–65535 的整数。');
  return ['--port', value];
}

/** 自动查找当前平台的标准安装位置，自定义路径错误时不切换到另一份工具。 */
function resolveWechatCli(projectRoot: string): string {
  /** Windows 同时检查按用户和按机器安装目录，环境变量决定盘符。 */
  const windowsRoots = ['ProgramFiles(x86)', 'ProgramFiles', 'LOCALAPPDATA'].map((name) => processEnvironmentValue(process.env, name)).filter((value): value is string => Boolean(value));
  /** 显式配置优先，不在配置错误时悄悄调用另一份开发者工具。 */
  const candidates = process.env.WX_CLI_PATH?.trim()
    ? [localPath(process.env.WX_CLI_PATH.trim(), projectRoot)]
    : process.platform === 'win32'
      ? windowsRoots.flatMap((root) => ['Tencent/微信web开发者工具', 'Tencent/WechatDevTools', 'Tencent/WechatTool', 'Programs/微信开发者工具'].map((directory) => join(root, directory, 'cli.bat')))
      : ['/Applications/wechatwebdevtools.app/Contents/MacOS/cli', join(homedir(), 'Applications/wechatwebdevtools.app/Contents/MacOS/cli')];
  for (const candidate of candidates) {
    try {
      accessSync(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // 标准位置可能未安装，全部查找结束后给出统一安装指引。
    }
  }
  throw new Error('未找到可执行的微信开发者工具。请安装微信开发者工具，或填写正确的 CLI 文件路径。');
}

/** 直接传递参数数组，项目路径和版本备注不会作为 shell 代码解释。 */
async function runCli(cli: string, args: string[], projectRoot: string): Promise<void> {
  await new Promise<void>((resolveRun, reject) => {
    /** runner 与 CLI 继承 Core Job；Main 已先打开用户持有的 GUI，停止命令不关闭该 GUI。 */
    const invocation = process.platform === 'win32' ? resolveExecutableInvocation(cli, args, { cwd: projectRoot, env: process.env }) : { command: cli, args, env: process.env };
    /** Unix 保留原有终端输入和输出；只有 Windows 批处理需要管道桥接。 */
    const child = spawn(invocation.command, invocation.args, {
      cwd: projectRoot,
      env: invocation.env,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      stdio: process.platform === 'win32' ? ['pipe', 'pipe', 'pipe'] : 'inherit',
      shell: false,
      windowsHide: true,
    });
    if (process.platform === 'win32') {
      child.stdout?.pipe(process.stdout, { end: false });
      child.stderr?.pipe(process.stderr, { end: false });
      child.stdin?.end();
    }
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolveRun();
      else reject(new Error(`微信开发者工具执行失败（${signal ?? code}）。请检查上方日志，并确认已登录、已开启服务端口且具有小程序开发权限。`));
    });
  });
}

/** 只登记本次运行目录内已写出的非空普通文件，不将“已发起”当成产物成功。 */
function registerArtifact(path: string): void {
  if (!statSync(path).isFile() || statSync(path).size === 0) throw new Error(`微信开发者工具没有生成有效产物：${path}`);
  process.stdout.write(`ZEUS_ARTIFACT_FILE=${path}\n`);
}

/** 真机必须完成官方连接流程并返回设备信息，单纯打开开发者工具不算成功。 */
async function remoteDebug(cli: string, projectPath: string, portArgs: string[], outputPath: string): Promise<void> {
  /** Unix 沿用 SDK 的启动和连接时序；Windows 单独处理 SDK 不支持的批处理入口。 */
  const miniProgram = process.platform === 'win32' ? await launchWindowsAutomation(cli, projectPath, portArgs) : await automator.launch({ cliPath: cli, projectPath, args: portArgs, timeout: 45_000 });
  /** 真机连接与设备查询共用等待上限，结束后释放连接但保留微信调试窗口。 */
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    /** 完整连接结果，包含官方连接事件之后才能获得的设备信息。 */
    const device = await Promise.race([
      (async () => {
        await miniProgram.remote(true);
        return miniProgram.systemInfo();
      })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('等待手机连接或设备信息超时，请检查手机微信与开发者工具登录状态。')), 120_000);
      }),
    ]);
    if (!device || typeof device !== 'object' || !('platform' in device) || typeof device.platform !== 'string' || !device.platform.trim() || device.platform === 'devtools') throw new Error('未获得真实手机设备信息，不能确认真机调试成功。');
    writeFileSync(outputPath, JSON.stringify({ status: 'connected', connectionEvidence: 'Tool.onRemoteDebugConnected', device }, null, 2), { mode: 0o600 });
    registerArtifact(outputPath);
  } finally {
    clearTimeout(timer);
    miniProgram.disconnect();
  }
}

/** Windows 只启动一次批处理，再重试只读连接，不向其他平台改变 SDK 启动语义。 */
async function launchWindowsAutomation(cli: string, projectPath: string, portArgs: string[]): Promise<Awaited<ReturnType<typeof automator.connect>>> {
  /** SDK 的 launch 直接 spawn 批处理，由统一解析器提供 Windows 参数转义。 */
  const port = await reserveAutomationPort();
  await runCli(cli, ['auto', '--project', projectPath, '--auto-port', String(port), ...portArgs], projectPath);
  return connectAutomation(port);
}

/** 让操作系统分配本机空闲端口，避免与用户已打开的自动化会话冲突。 */
async function reserveAutomationPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => (error ? reject(error) : address && typeof address !== 'string' ? resolvePort(address.port) : reject(new Error('无法分配微信自动化端口。'))));
    });
  });
}

/** 工具启动需要时间，只在有限期限内重试连接，不重复触发外部操作。 */
async function connectAutomation(port: number): Promise<Awaited<ReturnType<typeof automator.connect>>> {
  const deadline = Date.now() + 45_000;
  while (true) {
    try {
      return await automator.connect({ wsEndpoint: `ws://127.0.0.1:${port}` });
    } catch (error) {
      if (Date.now() >= deadline) throw new Error(`无法连接微信开发者工具自动化服务：${error instanceof Error ? error.message : String(error)}`);
      await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
    }
  }
}

/** 微信命令独立进程入口，只使用应用随包运行时与本次命令提供的上下文。 */
async function main(): Promise<void> {
  // Electron 仅用于运行本文件；微信自己的运行时不能继承此开关。
  delete process.env.ELECTRON_RUN_AS_NODE;
  /** 固定操作枚举，禁止将额外命令透传给开发者工具。 */
  const action = process.argv[2];
  if (!['upload', 'preview', 'auto-preview', 'remote-debug'].includes(action)) throw new Error('不支持的内置微信操作。');
  if (!process.env.ZEUS_PROJECT_ROOT || !process.env.ZEUS_COMMAND_RUN_DIR) throw new Error('请从 Zeus 项目命令入口运行微信命令。');
  /** 当前项目是所有相对输入路径的基准。 */
  const projectRoot = realpathSync(process.env.ZEUS_PROJECT_ROOT);
  /** 微信项目需要指向含 project.config.json 的目录，不猜测框架构建输出。 */
  const projectPath = realpathSync(localPath(process.env.WX_PROJECT_PATH?.trim() || '.', projectRoot));
  /** 在触发外部操作前验证微信项目，避免上传错误目录。 */
  const projectConfig: unknown = JSON.parse(readFileSync(join(projectPath, 'project.config.json'), 'utf8'));
  if (!projectConfig || typeof projectConfig !== 'object' || !('appid' in projectConfig) || typeof projectConfig.appid !== 'string' || !projectConfig.appid.trim())
    throw new Error('project.config.json 缺少有效 AppID，请选择已配置的小程序项目。');
  /** 所有输出只写入命令中心创建的专属运行目录。 */
  const runDirectory = realpathSync(process.env.ZEUS_COMMAND_RUN_DIR);
  /** 调用微信工具前完成路径和端口校验。 */
  const cli = resolveWechatCli(projectRoot);
  /** 空端口交给微信 CLI 按自身服务端口配置连接。 */
  const portArgs = servicePort(process.env.WX_PORT);
  /** 固定产物文件名，本次运行目录负责隔离并发执行。 */
  const infoPath = join(runDirectory, `wx-${action}.json`);
  if (action === 'remote-debug') {
    await remoteDebug(cli, projectPath, portArgs, infoPath);
    return;
  }
  /** 参数以数组交给子进程，不拼接用户输入。 */
  const args = [action, '--project', projectPath, ...portArgs, '--info-output', infoPath];
  if (action === 'upload') {
    if (!process.env.WX_VERSION?.trim()) throw new Error('请填写上传版本号。');
    args.push('--version', process.env.WX_VERSION.trim(), '--desc', process.env.WX_DESCRIPTION ?? '');
  }
  /** 预览二维码路径与信息文件都由命令中心管理。 */
  const qrPath = join(runDirectory, 'wx-preview.png');
  if (action === 'preview') args.push('--qr-format', 'image', '--qr-output', qrPath);
  await runCli(cli, args, projectRoot);
  if (action === 'preview') registerArtifact(qrPath);
  registerArtifact(infoPath);
  process.stdout.write(action === 'auto-preview' ? '已发起手机自动预览；请在手机微信查看。\n' : '微信命令执行完成。\n');
}

// 运行失败沿用命令中心的非零退出状态，错误保留在执行日志中。
void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
