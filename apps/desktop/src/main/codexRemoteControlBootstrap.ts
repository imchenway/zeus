import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { checkAiCliAdapter, codexInstallationCommand, codexStandaloneCandidates, normalizeProcessEnvironment } from '@zeus/ai-runtime';
import { assertPrivatePathSync, ensurePrivatePathSync, publishFileSync, readPrivateFileSync, windowsSecurityRequestAsync } from '@zeus/storage/platform-security';

/** 保留官方设置其余字段，只关闭专属 daemon 自动安装；已有 updater 必须由用户显式停止。 */
function disableDaemonAutomaticInstallation(home: string): void {
  /** 官方 daemon 两种安装布局共用同一受保护状态目录。 */
  const directory = join(home, 'app-server-daemon');
  ensurePrivatePathSync(directory, 'directory');
  /** 官方文档登记的配置真源，不另造更新偏好。 */
  const settingsPath = join(directory, 'settings.json');
  /** 只读取有界私有文件，错误格式必须由用户修复，不能覆盖丢失其他设置。 */
  const existing = existsSync(settingsPath);
  /** 官方配置对象保留所有未知字段，以免删除未来版本设置。 */
  const settings: unknown = existing ? JSON.parse(readPrivateFileSync(settingsPath, 1024 * 1024).toString('utf8')) : {};
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Codex daemon 设置不是 JSON 对象，尚未启动，请先修复设置。');
  /** 只修改明确登记的 updater 开关。 */
  const record = settings as Record<string, unknown>;
  /** 缺少 updater 时采用官方对象结构，不接受把未知值静默丢弃。 */
  const updater = record.updater === undefined ? {} : record.updater;
  if (!updater || typeof updater !== 'object' || Array.isArray(updater)) throw new Error('Codex daemon updater 设置无效，尚未启动，请先修复设置。');
  if ((updater as Record<string, unknown>).autoUpdateEnabled !== false) {
    /** 同目录候选经 DACL 校验后原子发布，失败不留下半份 settings。 */
    const temporary = join(directory, `.settings-${randomUUID()}.json`);
    try {
      writeFileSync(temporary, `${JSON.stringify({ ...record, updater: { ...updater, autoUpdateEnabled: false } }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      ensurePrivatePathSync(temporary, 'file');
      publishFileSync(temporary, settingsPath, { replace: existing });
    } finally {
      rmSync(temporary, { force: true });
    }
  }
  /** 文件存在也可能是残留，仍不能把它当作后台更新已停止的证据。 */
  if (['app-server-updater.pid', 'daemon-updater.pid'].some((name) => existsSync(join(directory, name)))) {
    throw new Error('已关闭 Codex daemon 自动安装，但已有后台更新进程尚未确认停止。请先通过现有停止远程接管/停止工作流程停止后，再手动启动；Zeus 不会自动终止正在使用的 daemon。');
  }
}

/** Main 只启动当前数据根的官方 standalone daemon，不接受 Core 提供的程序、参数或环境。 */
export async function ensureWindowsCodexRemoteControl(codexHome: string): Promise<{ socketPath: string }> {
  if (process.platform !== 'win32' || !isAbsolute(codexHome)) throw new Error('Codex Windows 守护进程需要当前桌面的完整数据目录。');
  /** 查询有效 token，管理员组成员身份不能代替是否提权。 */
  const token = await windowsSecurityRequestAsync<{ elevated: boolean }>({ operation: 'token-status' });
  if (token.elevated !== false) throw new Error('请以普通用户启动 Zeus；Codex Windows 守护进程不支持提权启动。');
  /** 安装身份来自受保护的数据根和官方 current 发布布局，不使用 PATH。 */
  const home = realpathSync(codexHome);
  assertPrivatePathSync(home, 'directory');
  /** 候选入口固定为官方 current，不读取 Core 配置的任意路径。 */
  const candidate = codexStandaloneCandidates(home).find((path) => existsSync(path));
  if (!candidate) throw new Error(`Zeus 专属目录未安装 Codex standalone。请在 PowerShell 运行：${codexInstallationCommand(home)}`);
  /** 固定 current 本次解析的真实发布版本，后续原子切换不改变当前命令。 */
  const command = realpathSync(candidate);
  /** releases 本身不能通过目录联接逃离当前专属安装根。 */
  const releases = realpathSync(join(home, 'packages', 'standalone', 'releases'));
  if (relative(home, releases).replace(/\\/gu, '/').toLowerCase() !== 'packages/standalone/releases') throw new Error('Codex 发布目录离开了当前专属安装根，请修复安装。');
  assertPrivatePathSync(releases, 'directory');
  /** 两种已发布布局均定位到对应 release 根。 */
  const releaseDirectory = basename(dirname(command)).toLowerCase() === 'bin' ? dirname(dirname(command)) : dirname(command);
  /** 发布目录同时记录精确版本和 CPU 架构。 */
  const releaseName = relative(releases, releaseDirectory);
  /** 原生包必须与当前 Electron 架构相同。 */
  const target = process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : process.arch === 'x64' ? 'x86_64-pc-windows-msvc' : null;
  /** 沿用官方 stable、alpha 和 beta 版本命名，不接纳额外路径段。 */
  const match = target ? releaseName.match(new RegExp(`^(\\d+\\.\\d+\\.\\d+(?:-(?:alpha|beta)(?:\\.\\d+)*)?)-${target}$`, 'u')) : null;
  if (!match || basename(command).toLowerCase() !== 'codex.exe') throw new Error('Codex 固定入口不属于当前架构的官方 standalone 发布目录，请修复专属安装。');
  assertPrivatePathSync(releaseDirectory, 'directory');
  assertPrivatePathSync(command, 'file');
  /** 文件布局沿用官方 Windows 安装器的完整性条件，保留已有平铺布局。 */
  const packaged = dirname(command) !== releaseDirectory;
  /** 随包组件缺失时拒绝将普通 exe 认作完整官方安装。 */
  const resources = packaged
    ? ['codex-package.json', 'bin/codex-code-mode-host.exe', 'codex-path/rg.exe', 'codex-resources/codex-command-runner.exe', 'codex-resources/codex-windows-sandbox-setup.exe']
    : ['codex-resources/rg.exe', 'codex-resources/codex-command-runner.exe', 'codex-resources/codex-windows-sandbox-setup.exe'];
  for (const resource of resources) assertPrivatePathSync(join(releaseDirectory, resource), 'file');
  /** 真实版本和 app-server 能力必须匹配发布目录；这不是密码学发行签名的替代声明。 */
  const status = await checkAiCliAdapter('codex', { commandPath: command });
  if (!status.available || status.version !== match[1]) throw new Error(`Codex 官方安装身份检查失败：${status.reason}`);
  disableDaemonAutomaticInstallation(home);
  /** daemon 独立于 Core 与 Zeus 安装目录，命令环境不含 Zeus 私有桥凭据。 */
  const env = normalizeProcessEnvironment(process.env);
  // 认证命名空间是公开的非敏感执行上下文；保留它才能与 Git 页面共用系统记忆。
  for (const key of Object.keys(env)) if ((key.toUpperCase().startsWith('ZEUS_') && key.toUpperCase() !== 'ZEUS_GIT_ASKPASS_SERVICE') || key.toUpperCase() === 'ELECTRON_RUN_AS_NODE') delete env[key];
  env.CODEX_HOME = home;
  return new Promise((resolveDaemon, reject) => {
    /** 只有此固定 bootstrap 在 Main 原生启动；官方 CLI 自行管理后台 daemon 的生命周期。 */
    const child = spawn(command, ['remote-control', 'start', '--json'], { cwd: home, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
    /** 输出仅用于本次启动诊断，超限或超时不自动再次启动。 */
    let stdout = '';
    /** stderr 保留真实 CLI 失败原因。 */
    let stderr = '';
    /** 合并两路输出计数，限制本次回执占用。 */
    let bytes = 0;
    /** 一旦结果未知，本次调用只报告该唯一状态。 */
    let unknown: Error | undefined;
    /** 杀死 bootstrap 不能证明它尚未创建 daemon，因此保留结果未知。 */
    const stop = (message: string) => {
      if (unknown) return;
      unknown = new Error(message);
      clearTimeout(timer);
      reject(unknown);
      child.kill();
    };
    /** 限制单次启动等待，不能因退出事件缺失无限等待。 */
    const timer = setTimeout(() => stop('Codex 守护进程启动超时，结果未知。请检查实际状态后手动重试。'), 30_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    for (const stream of ['stdout', 'stderr'] as const)
      child[stream].on('data', (chunk: string) => {
        if (unknown) return;
        bytes += Buffer.byteLength(chunk);
        if (bytes > 128 * 1024) {
          stop('Codex 守护进程启动输出超限，结果未知。请检查实际状态后手动重试。');
          return;
        }
        if (stream === 'stdout') stdout += chunk;
        else stderr += chunk;
      });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (unknown) {
        reject(unknown);
        return;
      }
      if (code !== 0) {
        reject(new Error(`Codex 守护进程启动失败（${code}）：${stderr.trim() || '官方 CLI 未返回诊断。'}`));
        return;
      }
      try {
        /** 只接纳官方 JSON 回执；连接及初始化成功由调用方另行确认。 */
        const result = JSON.parse(stdout) as { daemon?: { socketPath?: unknown } };
        /** 接线只使用官方实际返回的控制端点。 */
        const socketPath = result.daemon?.socketPath;
        if (typeof socketPath !== 'string' || !isAbsolute(socketPath)) throw new Error('官方 CLI 未返回有效控制套接字。');
        /** daemon 必须仍属于当前数据根，不能借用其他用户安装的会话。 */
        const childPath = relative(home, socketPath);
        if (!childPath || isAbsolute(childPath) || childPath === '..' || childPath.startsWith('..\\') || childPath.startsWith('../')) throw new Error('Codex 控制套接字不属于当前数据目录。');
        resolveDaemon({ socketPath });
      } catch (error) {
        reject(new Error(`Codex 守护进程回执无法确认：${error instanceof Error ? error.message : String(error)}。请检查后手动重试。`));
      }
    });
  });
}
