import { spawn, execFile as execFileCallback, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { publishFile } from '@zeus/storage/platform-security';
import { basename, dirname, join } from 'node:path';
import { release } from 'node:os';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import {
  faultEvidenceCompressedMaxBytes,
  faultEvidenceMaxBytes,
  faultReportMaxBytes,
  faultReportContext,
  normalizeFaultReportPacket,
  redactFaultReportText,
  type FaultReportAttachment,
  type FaultReportEvent,
  type FaultReportPacket,
  type FaultReportScene,
} from '@zeus/shared';
import { inspectWindowsRuntimeIdentity, stopWindowsRuntimeIdentity } from '@zeus/ai-runtime';
import { prepareFaultSubmission, saveFaultReport, uploadSavedFaultReport, writeFrozenFaultPacket } from './faultReporting.js';
import { createExecutionHostControlClient, inspectExecutionHostKernelLease, readExecutionHostRendezvous } from './executionHostProtocol.js';
import { sameZeusDataRootHostIdentity } from './dataRootIdentity.js';
import type { FaultMonitorBootstrap, FaultMonitorPulse, FaultWatchdogMessage } from './faultMonitor.js';

/** 原生采样最多运行四秒；工具自身失效也不能无限占住恢复过程。 */
const execFile = promisify(execFileCallback);
/** 预先确认附件可在匿名上传预算内发送，不能把必然失败的附件写入清单。 */
const compress = promisify(gzip);
/** 连续无响应期限为十五秒，启动首次就绪期限为三十秒。 */
const unresponsiveMs = 15_000;
/** 首次加载拥有独立期限，不能把能响应 IPC 的白屏当成启动成功。 */
const startupMs = 30_000;

/** 文件系统和独立采集工具也有期限；失败保留已取得的证据并提供恢复入口。 */
async function deadline<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('故障现场操作超过期限。')), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

/** 操作系统存活查询只用于已由本次私有 IPC 绑定的进程。 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** 运行状态通过替换同目录临时文件保存，异常退出后仍有上一份完整现场。 */
async function writePrivateJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    await publishFile(temporary, path, { replace: true });
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

/** 转储只从本轮 Crashpad 目录读取，最多遍历两层，不扫描用户工作区。 */
async function crashFiles(directory: string, since: number, notes: string[], depth = 0): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    notes.push(`Crashpad: ${basename(directory)} 目录不可读取（${error.code ?? 'unavailable'}）。`);
    return [];
  });
  if (entries.length > 256) notes.push('Crashpad: 达到每目录 256 项扫描上限，可能遗漏转储。');
  const result: string[] = [];
  for (const entry of entries.slice(0, 256)) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && depth < 2) result.push(...(await crashFiles(path, since, notes, depth + 1)));
    else if (entry.isFile() && entry.name.endsWith('.dmp') && ((await stat(path).catch(() => null))?.mtimeMs ?? 0) >= since) result.push(path);
  }
  const dated = await Promise.all(result.map(async (path) => ({ path, at: (await stat(path).catch(() => null))?.mtimeMs ?? 0 })));
  return dated
    .sort((left, right) => right.at - left.at)
    .slice(0, 4)
    .map((entry) => entry.path);
}

/** 独立 Node 进程负责监控和落盘；Main 或 Renderer 阻塞不会阻塞它的事件循环。 */
async function runWatchdog(bootstrap: FaultMonitorBootstrap): Promise<void> {
  const directory = bootstrap.reports.directory;
  /** 活动标记不包含 Core 令牌，整机掉电后下一次启动可补报已有证据。 */
  const activePath = join(directory, `active-${bootstrap.runId}.json`);
  /** 只在内存中保留当前认证连接。 */
  let pulse: FaultMonitorPulse = {
    at: bootstrap.startedAt,
    processes: [{ role: 'main', pid: bootstrap.mainPid, lastHeartbeatAt: bootstrap.startedAt }],
    windows: [],
    configuration: {},
    reports: bootstrap.reports,
    language: bootstrap.language,
    appearance: bootstrap.appearance,
  };
  /** 最后六十次脱敏操作；通过私有 IPC 到达时即记录，不等待下一次 Main 心跳。 */
  const breadcrumbs: FaultReportEvent[] = [];
  /** IPC 断开后不能再向原 Main PID 发信号，避免进程号复用。 */
  let parentGone = !process.connected || process.ppid <= 1;
  /** 正常退出使用显式通知，不把退出信号当成一次故障。 */
  let cleanExit = false;
  /** 每次故障只采集一次，同一报告身份贯穿上报重试和恢复。 */
  let fault: Promise<void> | undefined;
  /** 当前恢复窗口由守护进程持有，Main 退出不会关闭它的管道。 */
  let panel: ChildProcessWithoutNullStreams | undefined;
  /** 关闭或单独选择重启时取消上传，本机报告保持不变。 */
  let upload: AbortController | undefined;
  /** 恢复动作串行执行，重复点击不能启动多个新 Main。 */
  let recovering = false;
  /** 上报独立于恢复，重复提交不能并行上传同一份现场。 */
  let reporting = false;
  /** 用户补充文字只在首次提交前编辑，默认空白，不影响一键上报。 */
  let reproduction = '';
  /** 首次提交后锁定文字，避免同一报告重试时改变证据内容。 */
  let reproductionLocked = false;
  /** 用户关闭补报窗口后，异步回执不得重新弹出它。 */
  let dismissed = false;
  /** 监控自身的长调度间隔按休眠处理，重新开始连续无响应计时。 */
  let lastTick = Date.now();
  /** 恢复系统后给 Main 和各窗口一段完整的十五秒响应窗口。 */
  let resumedAt = 0;
  /** 当前现场是否已经完整写入报告文件。 */
  let saved: FaultReportPacket | undefined;
  /** 失败后重试保存同一份内存现场，不重新解释故障发生时的业务身份。 */
  let retrySave: (() => Promise<void>) | undefined;
  /** 最小现场尚未写入时，可以从同一次检测入口重试采集。 */
  let lastFault: { reason: FaultReportScene['reason']; windowId?: number; detail: string } | undefined;
  /** Core 的连续失败从独立探针开始计时，允许既有短时宿主恢复完成。 */
  let coreFailureAt: number | undefined;
  /** 进程世代变化后重置探针状态，不能把上一个宿主的失败算给新宿主。 */
  let coreInstance = '';
  /** 同一时刻只允许一个 Core 探针，避免故障时堆积请求。 */
  let coreProbePending = false;
  /** 独立探针最后成功时刻，用于冻结 Core 的最后健康状态。 */
  let coreLastHealthyAt: string | undefined;
  /** 清退时等待最后一次落盘结束，再移除活动标记。 */
  let checkpointOperation: Promise<void> | undefined;

  /** 守护内部错误只进入本机日志，不递归调用错误上报。 */
  function log(message: string): void {
    void appendFile(join(directory, 'watchdog.log'), `${new Date().toISOString()} ${redactFaultReportText(message, 1000)}\n`, { mode: 0o600 }).catch(() => undefined);
  }

  /** 活动标记仅包含可公开到私有诊断中的字段，不序列化启动参数或认证对象。 */
  async function checkpoint(): Promise<void> {
    const packet = normalizeFaultReportPacket({
      reportId: bootstrap.runId,
      occurredAt: bootstrap.startedAt,
      title: 'Zeus 上次退出状态未确认',
      summary: '上次运行未留下正常退出回执，以下为最后持久保存的状态。',
      code: 'ZEUS_UNCLEAN_EXIT',
      operation: 'desktop.lifecycle',
      stack: '',
      context: pulse.windows[0]?.context ?? {},
      appVersion: bootstrap.reports.appVersion,
      platform: process.platform,
      architecture: process.arch,
      osVersion: release(),
      diagnostics: {
        collectedAt: pulse.at,
        build: { electron: process.versions.electron, node: process.versions.node, chrome: process.versions.chrome },
        snapshots: {},
        logs: [],
        notes: [],
        scene: { reason: 'unclean_exit', detectedAt: pulse.at, processes: pulse.processes, breadcrumbs: [...breadcrumbs], configuration: pulse.configuration, attachments: [] },
      },
    });
    while (Buffer.byteLength(JSON.stringify(packet)) > faultReportMaxBytes && packet.diagnostics!.scene!.breadcrumbs.length) packet.diagnostics!.scene!.breadcrumbs.shift();
    await writePrivateJson(activePath, packet);
  }

  /** 本轮附件限定名称、大小和哈希；压缩预算不足时明确记录缺失。 */
  async function attachment(path: string, name: string, kind: FaultReportAttachment['kind'], attachments: FaultReportAttachment[], notes: string[]): Promise<void> {
    if (attachments.length >= 8) {
      notes.push(`${name}: 已达到八个现场附件上限。`);
      return;
    }
    const information = await stat(path);
    if (!information.isFile() || information.size <= 0 || information.size > faultEvidenceMaxBytes) {
      notes.push(`${name}: 附件为空或超过 16 MiB 上限。`);
      return;
    }
    const bytes = await readFile(path);
    if ((await compress(bytes)).length > faultEvidenceCompressedMaxBytes) {
      notes.push(`${name}: 压缩后超过 2 MiB 上传上限，未纳入附件清单。`);
      return;
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (!attachments.some((entry) => entry.sha256 === sha256)) {
      await publishFile(path, join(dirname(path), name), { replace: false });
      attachments.push({ name, kind, bytes: bytes.length, sha256 });
    } else await rm(path, { force: true });
  }

  /** 所有原生附件先保存到当前报告目录，采集异常逐项记录。 */
  async function capture(reportId: string, scene: FaultReportScene, notes: string[]): Promise<void> {
    const evidence = join(directory, `${reportId}.evidence`);
    await mkdir(evidence, { recursive: true, mode: 0o700 });
    const targets = scene.processes.filter((entry) => alive(entry.pid)).slice(0, 4);
    if (process.platform === 'darwin' && targets.length) {
      try {
        const result = await execFile('/bin/ps', ['-p', targets.map((entry) => entry.pid).join(','), '-o', 'pid=,%cpu=,rss='], { timeout: 1_000, maxBuffer: 8 * 1024, env: { ...process.env, LC_ALL: 'C' } });
        for (const line of result.stdout.trim().split('\n')) {
          const [pid, cpuPercent, memoryKiB] = line.trim().split(/\s+/u).map(Number);
          const entry = scene.processes.find((candidate) => candidate.pid === pid);
          if (entry && Number.isFinite(cpuPercent) && Number.isFinite(memoryKiB)) Object.assign(entry, { cpuPercent, memoryKiB });
        }
      } catch {
        notes.push('metrics: 无法取得故障时的独立 CPU 和内存采样，进程状态可能来自最后一次心跳。');
      }
    }
    await Promise.all(
      targets.map(async (entry) => {
        const name = `${entry.role}-${entry.pid}.${process.platform === 'win32' ? 'dmp' : 'txt'}`;
        const path = join(evidence, `.pending-${name}`);
        try {
          if (process.platform === 'darwin') await execFile('/usr/bin/sample', [String(entry.pid), '2', '10', '-file', path], { timeout: 4_000, maxBuffer: 16 * 1024 });
          else if (process.platform === 'win32') {
            const result = await execFile(bootstrap.helperPath, ['--fault-dump', String(entry.pid), path], { timeout: 4_000, maxBuffer: 16 * 1024, windowsHide: true });
            const metric = JSON.parse(result.stdout) as { pid?: number; memoryKiB?: number };
            if (metric.pid === entry.pid && typeof metric.memoryKiB === 'number' && Number.isFinite(metric.memoryKiB)) entry.memoryKiB = metric.memoryKiB;
          } else {
            notes.push(`${entry.role}: 当前平台没有接入原生线程采样。`);
            return;
          }
          await attachment(path, name, process.platform === 'win32' ? 'minidump' : 'thread_sample', scene.attachments, notes);
        } catch {
          notes.push(`${entry.role}: 原生取证失败或超过四秒期限，未将部分文件作为完整附件。`);
        }
      }),
    );
    // Crashpad 在进程退出后完成写入，等待一次短暂落盘，不依赖已经退出的 Main。
    if (scene.reason === 'main_exited' || scene.reason === 'renderer_crashed') await delay(500);
    const dumps = await crashFiles(bootstrap.crashDirectory, Math.max(Date.parse(bootstrap.startedAt), Date.parse(scene.detectedAt) - 300_000), notes);
    for (const [index, source] of dumps.entries()) {
      const name = `crash-${index}.dmp`;
      const path = join(evidence, `.pending-${name}`);
      try {
        if ((await stat(source)).size > faultEvidenceMaxBytes) {
          notes.push(`${name}: 原转储超过 16 MiB 上限，原文件仍保留在 Crashpad 目录。`);
          continue;
        }
        await copyFile(source, path);
        await attachment(path, name, 'minidump', scene.attachments, notes);
      } catch {
        notes.push(`${name}: Crashpad 转储无法读取。`);
      }
    }
    if (!dumps.length && ['main_exited', 'renderer_crashed'].includes(scene.reason)) notes.push('Crashpad: 未找到本轮可读取的崩溃转储，不能据此推断崩溃原因。');
    for (const entry of scene.processes.filter((process) => process.role === 'main' || process.role === 'core')) {
      const source = join(entry.role === 'main' ? bootstrap.crashDirectory : join(dirname(bootstrap.reports.hostLog), 'fault-diagnostics'), `${entry.role}-fatal-${entry.pid}.json`);
      try {
        const info = await stat(source);
        if (info.size > faultEvidenceMaxBytes || info.mtimeMs < Date.parse(bootstrap.startedAt)) continue;
        const raw = JSON.parse(await readFile(source, 'utf8')) as Record<string, unknown>;
        const javascript = raw.javascriptStack as { message?: unknown; stack?: unknown } | undefined;
        const header = raw.header as { event?: unknown } | undefined;
        const heap = raw.javascriptHeap as Record<string, unknown> | undefined;
        // 不上传 Node 原始报告中的环境、启动参数、打开文件和网络接口。
        const projection = {
          processId: entry.pid,
          reason: redactFaultReportText(header?.event, 4000),
          heapBytes: Object.fromEntries(['totalMemory', 'usedMemory', 'availableMemory', 'memoryLimit'].flatMap((key) => (typeof heap?.[key] === 'number' && Number.isFinite(heap[key]) ? [[key, heap[key]]] : []))),
          javascriptStack: {
            message: redactFaultReportText(javascript?.message, 4000),
            stack: Array.isArray(javascript?.stack)
              ? javascript.stack
                  .filter((frame): frame is string => typeof frame === 'string')
                  .slice(0, 80)
                  .map((frame) => redactFaultReportText(frame, 1000))
              : [],
          },
          nativeStack: Array.isArray(raw.nativeStack)
            ? raw.nativeStack
                .slice(0, 80)
                .flatMap((frame: unknown) => (frame && typeof frame === 'object' && typeof (frame as { symbol?: unknown }).symbol === 'string' ? [redactFaultReportText((frame as { symbol: string }).symbol, 1000)] : []))
            : [],
        };
        const name = `${entry.role}-fatal-${entry.pid}.json`;
        const path = join(evidence, `.pending-${name}`);
        await writeFile(path, JSON.stringify(projection), { mode: 0o600, flag: 'wx' });
        await attachment(path, name, 'node_diagnostic', scene.attachments, notes);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') notes.push(`${entry.role}: Node 致命诊断无法读取或投影。`);
      }
    }
    notes.push('native: 线程采样和转储可能包含路径、线程内存及业务数据；只有用户点击上报后才上传到私有诊断存储。');
  }

  /** 原生窗口复用现有更新助手的布局与消息循环，不依赖故障 Renderer。 */
  function show(state: string, title: string, detail: string): void {
    if (cleanExit) return;
    if (!panel || panel.killed || panel.exitCode !== null) {
      panel = spawn(bootstrap.helperPath, process.platform === 'win32' ? ['--update-progress'] : [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      panel.on('error', () => log('原生故障窗口启动失败；现场仍保留在本机。'));
      panel.once('exit', () => {
        if (!recovering && !cleanExit) {
          panel = undefined;
          dismissed = true;
        }
      });
      panel.stdin.on('error', () => undefined);
      panel.stderr.on('data', (chunk: Buffer) => log(`原生故障窗口：${chunk.toString('utf8').slice(0, 2000)}`));
      const actions = createInterface({ input: panel.stdout });
      actions.on('line', (line) => {
        try {
          const value = JSON.parse(line) as { action?: string; reproduction?: unknown };
          if (value.action === 'fault_report') void reportFault(value.reproduction);
          else if (value.action === 'fault_restart') void recover(value.reproduction);
          else if (value.action === 'fault_retry_capture' && !recovering) {
            if (retrySave) void retrySave().catch(() => showCaptureFailure());
            else if (lastFault) {
              fault = undefined;
              void detect(lastFault.reason, lastFault.windowId, lastFault.detail);
            }
          } else if ((value.action === 'closed' || value.action === 'close') && !recovering) {
            dismissed = true;
            if (reporting) upload?.abort();
            if (parentGone) {
              panel?.stdin.end();
              process.exit(0);
            }
          }
        } catch {
          /* 无效助手输出不能触发恢复。 */
        }
      });
    }
    dismissed = false;
    panel.stdin.write(`${JSON.stringify({ type: 'state', state, title, detail, language: pulse.language, appearance: pulse.appearance, reproduction, reproductionEnabled: state === 'fault-saved' && !reproductionLocked })}\n`);
  }

  /** 正常清退确认原生助手真正退出，不让旧窗口持有待替换的程序文件。 */
  async function closePanel(): Promise<void> {
    const current = panel;
    if (!current || !current.pid || current.exitCode !== null || current.signalCode !== null) return;
    const exited = new Promise<void>((resolveExit) => current.once('exit', () => resolveExit()));
    current.stdin.end(`${JSON.stringify({ type: 'quit' })}\n`);
    try {
      await deadline(exited, 2_000);
    } catch {
      current.kill('SIGKILL');
      await deadline(exited, 1_000);
    }
  }

  /** 正常退出保留未完成故障的最小现场，干净运行才删除活动标记。 */
  async function closeNormally(): Promise<void> {
    if (cleanExit) return;
    cleanExit = true;
    upload?.abort();
    const hadFault = Boolean(fault);
    await Promise.allSettled([fault, checkpointOperation]);
    if (!hadFault || saved) await rm(activePath, { force: true });
    await closePanel();
    process.exit(0);
  }

  /** 只停止同一数据根和世代的执行宿主；核验失败时禁止盲目杀 PID。 */
  async function stopCore(): Promise<void> {
    const current = await readExecutionHostRendezvous(bootstrap.dataRoot);
    if (!current || !alive(current.pid)) return;
    if (pulse.core && (current.pid !== pulse.core.pid || current.instanceId !== pulse.core.instanceId)) throw new Error('执行宿主世代已改变，未终止该进程。');
    const client = createExecutionHostControlClient(current);
    await Promise.race([client.shutdown().catch(() => undefined), delay(3_000)]);
    for (let attempt = 0; attempt < 20 && alive(current.pid); attempt++) await delay(100);
    if (!alive(current.pid)) return;
    const verified = await readExecutionHostRendezvous(bootstrap.dataRoot);
    if (
      !verified ||
      verified.instanceId !== current.instanceId ||
      verified.pid !== current.pid ||
      !sameZeusDataRootHostIdentity(verified.dataRootIdentity, current.dataRootIdentity) ||
      inspectExecutionHostKernelLease(bootstrap.dataRoot, current.dataRootIdentity) !== 'held'
    )
      throw new Error('执行宿主身份无法核对，未执行强制结束。');
    if (process.platform === 'win32') {
      const owned = inspectWindowsRuntimeIdentity(current.instanceId);
      if (owned.state !== 'verified' || !owned.identity || owned.childIdentity?.pid !== current.pid || owned.childIdentity.imagePath.toLowerCase() !== bootstrap.executable.toLowerCase())
        throw new Error('Windows 执行宿主 Job 身份无法核对。');
      stopWindowsRuntimeIdentity(current.instanceId, owned.identity.pid);
    } else process.kill(-current.pid, 'SIGKILL');
    for (let attempt = 0; attempt < 30 && alive(current.pid); attempt++) await delay(100);
    if (alive(current.pid)) throw new Error('执行宿主未在强制结束期限内退出。');
  }

  /** 用户已选重启后先结束旧 Main，防止它在 Core 清退期间重新拉起宿主。 */
  async function restart(): Promise<void> {
    if (!parentGone && process.connected && alive(bootstrap.mainPid)) process.kill(bootstrap.mainPid, 'SIGKILL');
    for (let attempt = 0; attempt < 30 && !parentGone && alive(bootstrap.mainPid); attempt++) await delay(100);
    if (!parentGone && alive(bootstrap.mainPid)) throw new Error('旧 Zeus 主进程仍未退出，未启动第二实例。');
    await deadline(stopCore(), 10_000);
    if (saved) {
      await deadline(writePrivateJson(join(directory, `${saved.reportId}.recovery.json`), { recoveredAt: new Date().toISOString() }), 2_000).catch(() => log('恢复回执无法写入，本机故障报告仍保留。'));
      await deadline(rm(activePath, { force: true }), 2_000).catch(() => undefined);
    }
    const environment = { ...process.env };
    delete environment.ELECTRON_RUN_AS_NODE;
    delete environment.ZEUS_FAULT_WATCHDOG;
    const next = spawn(bootstrap.executable, bootstrap.args, { env: environment, detached: true, stdio: 'ignore', windowsHide: true });
    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      next.once('spawn', resolveSpawn);
      next.once('error', rejectSpawn);
    });
    next.unref();
    panel?.stdin.write(`${JSON.stringify({ type: 'quit' })}\n`);
    process.exit(0);
  }

  /** 只有用户单独选择重启时才结束旧进程，上报结果不触发恢复。 */
  async function recover(supplement?: unknown): Promise<void> {
    if (cleanExit || recovering) return;
    if (!reproductionLocked) {
      reproduction = redactFaultReportText(supplement, 4000);
      reproductionLocked = true;
    }
    recovering = true;
    upload?.abort();
    const zh = pulse.language !== 'en-US';
    show('fault-restarting', zh ? '正在重新启动 Zeus' : 'Restarting Zeus', zh ? '故障现场已保留在本机，正在重新启动。' : 'Evidence remains on this device. Restarting now.');
    if (saved && reproduction) await deadline(prepareFaultSubmission(saved.reportId, directory, reproduction), 2_000).catch(() => log('复现文字未能另存，原始故障现场仍保留；继续用户请求的重启。'));
    if (cleanExit) return;
    try {
      await restart();
    } catch (error) {
      recovering = false;
      log(error instanceof Error ? error.message : '故障恢复失败。');
      show(
        'fault-saved',
        zh ? 'Zeus 尚未完成重启' : 'Zeus could not restart',
        zh ? '故障现场已保存在本机。无法确认旧进程已退出，请重试恢复。' : 'Evidence was saved on this device. The previous process could not be confirmed stopped. Retry recovery.',
      );
    }
  }

  /** 保存失败不能展示“已保存”；用户仍能明确选择仅重启。 */
  function showCaptureFailure(): void {
    const zh = pulse.language !== 'en-US';
    show(
      'fault-capture-failed',
      zh ? '故障现场未完整保存' : 'Evidence could not be fully saved',
      zh ? '本机诊断保存失败。可以重试保存现场，或仅重启 Zeus。' : 'Saving diagnostics on this device failed. Retry saving the evidence or restart Zeus.',
    );
  }

  /** 已保存的上次故障只在用户主动上报时读取，补报保持原报告身份和构建信息。 */
  async function pendingReport(): Promise<FaultReportPacket | undefined> {
    const names = (await readdir(directory)).filter((name) => /^[a-f0-9-]{36}\.json$/u.test(name));
    const recent = await Promise.all(names.map(async (name) => ({ name, at: (await stat(join(directory, name))).mtimeMs })));
    for (const item of recent.sort((left, right) => right.at - left.at)) {
      if (
        await stat(join(directory, item.name.replace('.json', '.receipt.json'))).then(
          () => true,
          () => false,
        )
      )
        continue;
      try {
        const submission = await readFile(join(directory, item.name.replace('.json', '.submission.json')), 'utf8').catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
          return null;
        });
        return normalizeFaultReportPacket(JSON.parse(submission ?? (await readFile(join(directory, item.name), 'utf8'))));
      } catch {
        /* 保留损坏报告，继续寻找可读的待上报现场。 */
      }
    }
    return undefined;
  }

  /** 故障窗口只在现场写入成功后提供上报动作。 */
  function showSaved(): void {
    const zh = pulse.language !== 'en-US';
    show(
      'fault-saved',
      zh ? 'Zeus 故障现场已保存' : 'Zeus evidence was saved',
      zh
        ? '上报包含诊断与进程转储，可能含业务数据，仅提交到私有诊断存储。单独选择重启会中断当前工作，未保存的内容可能丢失。'
        : 'Reporting sends diagnostics and process dumps, which may contain business data, to private diagnostic storage. Choosing Restart separately interrupts work and may lose unsaved changes.',
    );
  }

  /** 上传失败或旧报告待补报时，明确区分本机保存与完整接收。 */
  function showPending(): void {
    const zh = pulse.language !== 'en-US';
    show(
      'fault-pending',
      zh ? '故障报告尚未完整上报' : 'The fault report is not fully submitted',
      zh ? '现场已保存在本机。补报将诊断与进程转储提交到私有存储，可能包含业务数据。' : 'Evidence remains on this device. Sending it uploads diagnostics and process dumps to private storage and may include business data.',
    );
  }

  /** 首次上报与补报共用上传流程，成功、失败和取消都不触发重启。 */
  async function reportFault(supplement?: unknown): Promise<void> {
    if (cleanExit || !saved || recovering || reporting) return;
    if (!reproductionLocked) {
      reproduction = redactFaultReportText(supplement, 4000);
      reproductionLocked = true;
    }
    const reportId = saved.reportId;
    const cancellation = new AbortController();
    upload = cancellation;
    reporting = true;
    const zh = pulse.language !== 'en-US';
    show('fault-uploading', zh ? '正在上报故障' : 'Sending the fault report', zh ? '最多等待 15 秒。关闭窗口会取消本次上传，本机现场仍保留。' : 'This takes at most 15 seconds. Closing cancels this upload and keeps the local evidence.');
    try {
      await deadline(uploadSavedFaultReport(reportId, directory, 15_000, cancellation.signal, reproduction), 15_000);
      if (!dismissed && !cancellation.signal.aborted && saved?.reportId === reportId)
        show('fault-reported', zh ? '故障报告已完整接收' : 'The complete report was received', zh ? '诊断与清单中的现场附件均已确认接收。' : 'Diagnostics and every declared evidence attachment were confirmed received.');
    } catch {
      const cancelled = cancellation.signal.aborted;
      cancellation.abort();
      void writePrivateJson(join(directory, `${reportId}.pending.json`), { reportId, attemptedAt: new Date().toISOString() }).catch(() => log('待补报标记无法保存，本机故障报告仍保留。'));
      if (!recovering && !cancelled && !dismissed && saved?.reportId === reportId) showPending();
    } finally {
      reporting = false;
    }
  }

  /** 先写入最小现场，再采样并冻结完整报告，任何网络操作都晚于本机保存。 */
  async function detect(reason: FaultReportScene['reason'], windowId?: number, detail = ''): Promise<void> {
    if (cleanExit || fault) return;
    lastFault = { reason, windowId, detail };
    fault = (async () => {
      if (reason === 'manual_report') {
        const pending = await deadline(pendingReport(), 2_000).catch(() => undefined);
        if (pending) {
          saved = pending;
          reproduction = pending.diagnostics?.reproduction ?? '';
          reproductionLocked = true;
          showPending();
          return;
        }
      }
      saved = undefined;
      reproduction = '';
      reproductionLocked = false;
      if (reporting) {
        dismissed = true;
        upload?.abort();
      }
      retrySave = undefined;
      const detectedAt = new Date().toISOString();
      const window = pulse.windows.find((entry) => entry.id === (windowId ?? pulse.activeWindowId)) ?? pulse.windows[0];
      /** 优先关联故障工作面尚未结束的请求，不用上报时的新请求替换故障身份。 */
      const inFlight = new Map<string, FaultReportEvent>();
      let lastRequest: FaultReportEvent | undefined;
      for (const event of breadcrumbs) {
        if (event.context.windowId !== String(window?.id) || ['projectId', 'conversationId', 'taskId'].some((key) => event.context[key] && window?.context[key] && event.context[key] !== window.context[key])) continue;
        if (event.event === 'local_api.request_started' && event.context.traceId) {
          inFlight.set(event.context.traceId, event);
          lastRequest = event;
        } else if (event.event === 'local_api.request_finished' && event.context.traceId) inFlight.delete(event.context.traceId);
      }
      const request = [...inFlight.values()].at(-1) ?? lastRequest;
      const reportId = randomUUID();
      const scene: FaultReportScene = {
        reason,
        detectedAt,
        processes: pulse.processes.map((entry) => ({
          ...entry,
          ...(entry.role === 'renderer' ? { lastHeartbeatAt: pulse.windows.find((candidate) => candidate.pid === entry.pid)?.lastHeartbeatAt } : entry.role === 'core' ? { lastHeartbeatAt: coreLastHealthyAt } : {}),
        })),
        breadcrumbs: [...breadcrumbs],
        configuration: { ...pulse.configuration },
        attachments: [],
      };
      scene.processes.sort((left, right) => {
        const rank = (entry: typeof left): number => (entry.role === 'main' ? 0 : entry.pid === window?.pid ? 1 : entry.role === 'core' ? 2 : entry.role === 'gpu' ? 3 : 4);
        return rank(left) - rank(right);
      });
      if (typeof request?.details?.operation === 'string') scene.configuration.activeOperation = request.details.operation;
      const input = {
        reportId,
        occurredAt: detectedAt,
        title: 'Zeus 运行故障',
        summary: reason,
        code: `ZEUS_${reason.toUpperCase()}`,
        operation: 'desktop.lifecycle',
        stack: redactFaultReportText(detail),
        context: faultReportContext({ ...window?.context, ...(window ? { windowId: String(window.id) } : {}), ...(request?.context.traceId ? { traceId: request.context.traceId } : {}) }),
      };
      const zh = pulse.language !== 'en-US';
      const notes: string[] = ['native: 首次本机保存尚未完成，原生证据未开始采集。'];
      retrySave = async () => {
        saved = await deadline(saveFaultReport(input, pulse.reports, scene, notes), 7_000);
        await deadline(rm(activePath, { force: true }), 1_000).catch(() => undefined);
        showSaved();
      };
      show(
        'fault-capturing',
        zh ? '正在保存 Zeus 故障现场' : 'Saving Zeus evidence',
        zh ? '正在限时采集进程状态与线程栈，完成后可以上报故障。' : 'Collecting process state and thread stacks with a time limit. Fault reporting will be available when saving finishes.',
      );
      await deadline(
        writePrivateJson(activePath, {
          ...input,
          appVersion: bootstrap.reports.appVersion,
          platform: process.platform,
          architecture: process.arch,
          osVersion: release(),
          diagnostics: { collectedAt: detectedAt, build: { electron: process.versions.electron, node: process.versions.node }, snapshots: {}, logs: [], notes: ['采集在完成前中断，以下仅为已持久保存的最小现场。'], scene },
        }),
        2_000,
      );
      notes.shift();
      await deadline(capture(reportId, scene, notes), 6_000).catch(() => notes.push('native: 达到六秒采集期限，未取得的证据不纳入本次现场。'));
      await retrySave();
    })().catch((error: unknown) => {
      log(error instanceof Error ? error.message : '故障现场保存失败。');
      showCaptureFailure();
    });
    await fault;
  }

  process.on('message', (value: FaultWatchdogMessage) => {
    if (value.kind === 'pulse') {
      pulse = value.value;
    } else if (value.kind === 'breadcrumb') {
      breadcrumbs.push(value.value);
      if (breadcrumbs.length > 60) breadcrumbs.shift();
    } else if (value.kind === 'fault') void detect(value.reason, value.windowId, value.detail);
    else if (value.kind === 'resume') {
      resumedAt = Date.now();
      coreFailureAt = undefined;
    } else if (value.kind === 'clean-exit') {
      void closeNormally().catch(() => process.exit(1));
    }
  });
  process.on('disconnect', () => {
    parentGone = true;
    if (pulse.configuration.phase === 'quitting' && !fault) {
      void closeNormally().catch(() => process.exit(1));
      return;
    }
    if (!cleanExit && !fault) void detect('main_exited');
  });
  /** 正常运行仅保存小型状态，故障后停止覆盖已经冻结的现场。 */
  setInterval(() => {
    const now = Date.now();
    if (now - lastTick > 10_000) {
      resumedAt = now;
      coreFailureAt = undefined;
    }
    lastTick = now;
    if (cleanExit) return;
    if (pulse.core && pulse.reports.core && pulse.configuration.phase !== 'quitting') {
      if (coreInstance !== pulse.core.instanceId) {
        coreInstance = pulse.core.instanceId;
        coreFailureAt = undefined;
        coreLastHealthyAt = undefined;
      }
      if (!coreProbePending) {
        coreProbePending = true;
        const instance = coreInstance;
        const connection = pulse.reports.core;
        void (async () => {
          try {
            const origin = new URL(connection.baseUrl);
            if (!['127.0.0.1', '[::1]', 'localhost'].includes(origin.hostname)) throw new Error('Invalid Core origin');
            const response = await fetch(new URL('/health', connection.baseUrl), { headers: { authorization: `Bearer ${connection.apiToken}` }, signal: AbortSignal.timeout(3_000), redirect: 'error' });
            const health = (await response.json()) as { app?: string };
            if (!response.ok || health.app !== 'Zeus') throw new Error('Core health unavailable');
            if (coreInstance === instance) {
              coreFailureAt = undefined;
              coreLastHealthyAt = new Date().toISOString();
            }
          } catch {
            if (coreInstance === instance) coreFailureAt ??= Date.now();
          } finally {
            coreProbePending = false;
          }
        })();
      }
    }
    const mainStalled = now - Math.max(Date.parse(pulse.at), resumedAt) >= unresponsiveMs;
    const stalled = pulse.windows.find((window) =>
      window.ready ? now - Math.max(Date.parse(window.unresponsiveSince ?? window.lastHeartbeatAt), resumedAt) >= unresponsiveMs : now - Math.max(Date.parse(window.startedAt), resumedAt) >= startupMs,
    );
    const coreStalled = pulse.core && pulse.configuration.phase !== 'quitting' && coreFailureAt !== undefined && now - coreFailureAt >= unresponsiveMs;
    if (fault) {
      // 关闭提示后等待真正恢复才重新布防，同一持续故障不能每两秒重新弹窗。
      if (!dismissed || recovering || mainStalled || stalled || coreStalled) return;
      fault = undefined;
    }
    if (mainStalled) {
      void detect('main_unresponsive');
      return;
    }
    if (stalled) {
      void detect(stalled.ready ? 'renderer_unresponsive' : 'startup_timeout', stalled.id);
      return;
    }
    if (coreStalled && pulse.core) {
      void detect(alive(pulse.core.pid) ? 'core_unresponsive' : 'core_exited');
      return;
    }
    if (!checkpointOperation) {
      checkpointOperation = checkpoint()
        .catch(() => undefined)
        .finally(() => {
          checkpointOperation = undefined;
        });
    }
  }, 2_000);

  /** 先安装 IPC 和退出监听，再开始磁盘读取，避免启动阶段丢失故障通知。 */
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (parentGone && !fault && !cleanExit) void detect('main_exited');
  /** 非正常退出标记来自既有诊断目录；不恢复、执行或上传其中的任何业务命令。 */
  const previous = (await readdir(directory)).filter((name) => /^active-[a-f0-9-]{36}\.json$/u.test(name) && name !== `active-${bootstrap.runId}.json`).slice(0, 8);
  /** 上次进程未能结束取证时，下一次启动可补报已持久保存的最小现场。 */
  let recoveredPrevious = false;
  for (const name of previous) {
    try {
      const input = JSON.parse(await readFile(join(directory, name), 'utf8')) as Record<string, unknown>;
      const packet = normalizeFaultReportPacket(input);
      if (packet.diagnostics) packet.diagnostics.notes.unshift('现场来自上次运行的持久记录，不等同于退出瞬间。');
      const content = JSON.stringify(packet);
      if (Buffer.byteLength(content) > faultReportMaxBytes) throw new Error('旧现场超过大小上限。');
      const published = normalizeFaultReportPacket(JSON.parse(await writeFrozenFaultPacket(join(directory, `${packet.reportId}.json`), content)));
      if (published.reportId !== packet.reportId) throw new Error('Recovered report identity mismatch');
      recoveredPrevious = true;
      await rm(join(directory, name), { force: true });
    } catch {
      log('上次运行的活动标记无法读取，原文件已保留。');
    }
  }
  if (!fault && !cleanExit) await checkpoint();
  if (process.connected) process.send?.({ kind: 'ready' }, () => undefined);
  /** 上传失败后的第一次重新启动显示待补报状态，后续由全局菜单主动打开。 */
  const pendingMarkers = (await readdir(directory)).filter((name) => /^[a-f0-9-]{36}\.pending\.json$/u.test(name));
  const unnotified = [];
  for (const name of pendingMarkers.slice(0, 8)) {
    try {
      const marker = JSON.parse(await readFile(join(directory, name), 'utf8')) as { notifiedAt?: string };
      if (!marker.notifiedAt) {
        unnotified.push(name);
        await writePrivateJson(join(directory, name), { ...marker, notifiedAt: new Date().toISOString() });
      }
    } catch {
      log('待补报标记无法读取，原报告仍保留。');
    }
  }
  if (!fault && !cleanExit && (recoveredPrevious || unnotified.length)) {
    saved = await pendingReport();
    if (saved) {
      reproduction = saved.diagnostics?.reproduction ?? '';
      reproductionLocked = true;
      showPending();
    }
  }
}

/** 只有 Main 启动的私有 IPC 子进程可以进入守护循环。 */
if (process.env.ZEUS_FAULT_WATCHDOG === '1' && process.send) {
  process.once('message', (message: FaultWatchdogMessage) => {
    if (message.kind !== 'bootstrap' || message.value.mainPid <= 1 || (process.ppid > 1 && message.value.mainPid !== process.ppid) || !message.value.reports.directory) process.exit(1);
    void runWatchdog(message.value).catch((error: unknown) => {
      console.error('Zeus fault watchdog failed', redactFaultReportText(error instanceof Error ? error.message : String(error), 2000));
      process.exit(1);
    });
  });
}
