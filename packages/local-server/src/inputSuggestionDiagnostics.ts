import { appendFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** 诊断只接受标量元数据，不能传入请求、响应、正文或错误对象。 */
export type InputSuggestionDiagnostic = Readonly<Record<string, string | number | boolean | null | undefined>>;

/** 字段白名单同时约束 Core 和 Renderer，未知字段不会进入可分享日志。 */
const diagnosticFields = new Set([
  'event',
  'requestId',
  'projectId',
  'conversationId',
  'mode',
  'trigger',
  'modelRef',
  'effort',
  'protocol',
  'stage',
  'outcome',
  'cancellation',
  'outputKind',
  'errorCode',
  'promptHash',
  'maxTokens',
  'elapsedMs',
  'httpStatus',
  'inputCharacters',
  'outputCharacters',
  'materialMs',
  'modelPreparationMs',
  'generationMs',
  'processReused',
  'textCharacters',
  'reasoningCharacters',
  'transportAttempts',
  'droppedEntries',
]);
/** 每个进程最多保留当前文件和两份历史文件，总量约六 MiB。 */
const maximumDiagnosticFileBytes = 2 * 1024 * 1024;
/** 磁盘异常时不允许日志队列无限占用内存。 */
const maximumPendingDiagnosticEntries = 512;

/** 白名单字符串只承载身份、枚举和阶段；拒绝含凭据形态的值。 */
function diagnosticScalar(value: unknown): string | number | boolean | null | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.max(0, Math.round(value)) : undefined;
  if (typeof value === 'boolean' || value === null) return value;
  if (typeof value !== 'string') return undefined;
  if (/(?:bearer\s|\bsk-|\bsecret-|(?:token|api[-_]?key|secret|password)\s*[=:])/iu.test(value)) return '[REDACTED]';
  return value.replace(/\p{Cc}/gu, ' ').slice(0, 256);
}

/** 按进程分别串行写入有界日志；日志失败不改变业务结果，也不触发业务重试。 */
export function createInputSuggestionDiagnosticLog(options: {
  /** 复用数据布局中的正式本机日志目录。 */
  directory: string;
  /** Core 与界面分文件，避免不同进程同时轮转同一个文件。 */
  source: 'core' | 'desktop';
  /** 每条日志记录真实构建身份，便于区分工作区与已安装应用。 */
  appVersion: string;
  /** 宿主身份只作关联，不包含接口令牌。 */
  instanceId?: string;
}) {
  /** 文件名固定，不接受 Renderer 提供路径。 */
  const path = join(options.directory, `input-suggestions-${options.source}.log`);
  /** 单个拥有者内保证记录和轮转顺序。 */
  let pending = Promise.resolve();
  /** 队列长度只统计未落盘的有界记录。 */
  let pendingCount = 0;
  /** 恢复写入后标记丢失数量，不能把缺失日志误当成没有事件。 */
  let droppedEntries = 0;
  /** 同一轮磁盘故障只输出一次固定说明。 */
  let writeFailureReported = false;

  return {
    /** 立即冻结时间和元数据，再异步落盘，不占用模型生成期限。 */
    record(entry: InputSuggestionDiagnostic): void {
      if (pendingCount >= maximumPendingDiagnosticEntries) {
        droppedEntries += 1;
        return;
      }
      /** 明确复制已允许字段，额外的正文或凭据字段直接丢弃。 */
      const metadata = Object.fromEntries(
        Object.entries(entry)
          .filter(([key]) => diagnosticFields.has(key))
          .map(([key, value]) => [key, diagnosticScalar(value)]),
      );
      /** 运行身份由日志拥有者提供，不能由界面伪造。 */
      const line = `${JSON.stringify({ ...metadata, timestamp: new Date().toISOString(), source: options.source, appVersion: options.appVersion, instanceId: options.instanceId, pid: process.pid, nodeVersion: process.versions.node, electronVersion: process.versions.electron ?? null, platform: process.platform, arch: process.arch, ...(droppedEntries ? { droppedEntries } : {}) })}\n`;
      droppedEntries = 0;
      pendingCount += 1;
      pending = pending
        .then(async () => {
          await mkdir(options.directory, { recursive: true, mode: 0o700 });
          /** 只把不存在视为空文件，权限或磁盘错误由统一失败路径处理。 */
          const size = await stat(path).then(
            (value) => value.size,
            (error: NodeJS.ErrnoException) => {
              if (error.code === 'ENOENT') return 0;
              throw error;
            },
          );
          if (size + Buffer.byteLength(line) > maximumDiagnosticFileBytes) {
            await rm(`${path}.2`, { force: true });
            await rename(`${path}.1`, `${path}.2`).catch((error: NodeJS.ErrnoException) => {
              if (error.code !== 'ENOENT') throw error;
            });
            await rename(path, `${path}.1`);
          }
          await appendFile(path, line, { encoding: 'utf8', mode: 0o600 });
          writeFailureReported = false;
        })
        .catch(() => {
          droppedEntries += 1;
          if (!writeFailureReported) console.error('Zeus 输入建议诊断日志无法写入；生成结果不受影响。');
          writeFailureReported = true;
        })
        .finally(() => {
          pendingCount -= 1;
        });
    },
    /** 服务正常关闭时等待已接收记录落盘。 */
    flush: (): Promise<void> => pending,
  };
}
