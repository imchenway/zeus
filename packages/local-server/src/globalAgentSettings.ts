import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { GlobalAgentSettingsMetadata, GlobalAgentSettingsSnapshot, SaveGlobalAgentSettingsInput } from '@zeus/shared';
import type { FastifyInstance } from 'fastify';
import { SettingsCommandApplication, SettingsCommandApplicationError, SettingsExternalOperationRejectedError, settingsCommandHttpError, settingsCommandTypes } from './settingsCommandApplication.js';

/** 正文限制为 1 MiB，请求预算另计 JSON 转义和命令封装。 */
const maximumAgentsBytes = 1024 * 1024;

/** 固定全局文件的读取及串行写入。 */
export class GlobalAgentSettings {
  /** 服务端选定的配置目录。 */
  private readonly directory: string;
  /** 不接收客户端路径。 */
  readonly path: string;
  /** 写入顺序，失败不会堵塞后续保存。 */
  private saveQueue: Promise<unknown> = Promise.resolve();

  /** 目录规范化不产生文件系统写入。 */
  constructor(directory: string) {
    this.directory = resolve(directory);
    this.path = join(this.directory, 'AGENTS.md');
  }

  /** 从普通文件读取，拒绝跟随符号链接。 */
  async read(): Promise<GlobalAgentSettingsSnapshot> {
    /** 非阻塞打开避免特殊文件阻塞，同时禁止链接跳转。 */
    const handle = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      if (error.code === 'ELOOP') throw new SettingsExternalOperationRejectedError('AGENTS.md 是符号链接，无法通过全局规则页读写。');
      throw error;
    });
    if (!handle) return { path: this.path, exists: false, content: '', revision: null };
    try {
      /** 在打开后校验真实文件类型与大小。 */
      const stat = await handle.stat();
      if (!stat.isFile()) throw new SettingsExternalOperationRejectedError('AGENTS.md 不是普通文件。');
      if (stat.size > maximumAgentsBytes) throw new SettingsCommandApplicationError('ZEUS_SETTINGS_COMMAND_RESULT_TOO_LARGE', 'AGENTS.md 超过 1 MiB，无法在此编辑。', 413);
      /** 多读一字节，识别读取期间增大的文件，禁止截断。 */
      const buffer = Buffer.alloc(maximumAgentsBytes + 1);
      /** 分段读取的有效长度。 */
      let size = 0;
      while (size < buffer.length) {
        /** 一次读取不保证到达文件结尾。 */
        const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size > maximumAgentsBytes) throw new SettingsCommandApplicationError('ZEUS_SETTINGS_COMMAND_RESULT_TOO_LARGE', 'AGENTS.md 超过 1 MiB，无法在此编辑。', 413);
      /** 保留 BOM，非法编码报错，避免替换字符污染原文。 */
      const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, size));
      return { path: this.path, exists: true, content, revision: createHash('sha256').update(buffer.subarray(0, size)).digest('hex') };
    } finally {
      await handle.close();
    }
  }

  /** 每次保存重新校验输入并进入同一文件队列。 */
  save(input: SaveGlobalAgentSettingsInput): Promise<GlobalAgentSettingsMetadata> {
    validateGlobalAgentSettingsInput(input);
    /** 本次错误仍传给调用方，队列独立恢复。 */
    const result = this.saveQueue.then(() => this.write(input));
    this.saveQueue = result.catch(() => undefined);
    return result;
  }

  /** 写完临时文件后再次核对基线，再替换目标。 */
  private async write(input: SaveGlobalAgentSettingsInput): Promise<GlobalAgentSettingsMetadata> {
    /** 临时文件与目标同目录，替换不会暴露半份正文。 */
    const temporaryPath = join(this.directory, `.AGENTS.md.${randomUUID()}.tmp`);
    try {
      await this.checkRevision(input.baseRevision);
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      /** 独占创建临时文件，不覆盖任何现有文件。 */
      const handle = await open(temporaryPath, 'wx', 0o600);
      try {
        await handle.writeFile(input.content, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      // ponytail: 外部编辑器不共享队列；替换前再次核对，跨进程强互斥需共同文件锁协议。
      await this.checkRevision(input.baseRevision);
      await rename(temporaryPath, this.path);
      return { path: this.path, exists: true, revision: createHash('sha256').update(input.content, 'utf8').digest('hex') };
    } catch (error) {
      // 替换前失败证明目标未写入，不将安全重试误标为结果未知。
      throw new SettingsExternalOperationRejectedError(error instanceof Error ? error.message : 'AGENTS.md 保存失败，原文件未改动。');
    } finally {
      // 清理失败不改变已完成的保存结果。
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  /** 外部编辑或另一窗口保存后，拒绝旧基线覆盖。 */
  private async checkRevision(baseRevision: string | null): Promise<void> {
    /** 真实磁盘快照，不使用页面缓存。 */
    const current = await this.read();
    if (current.revision !== baseRevision) throw new SettingsExternalOperationRejectedError('AGENTS.md 已被其他操作修改。草稿已保留，请重新读取后再编辑。');
  }
}

/** 只接受正文及基线摘要，拒绝路径等额外输入。 */
export function validateGlobalAgentSettingsInput(input: SaveGlobalAgentSettingsInput): void {
  if (
    !input ||
    typeof input !== 'object' ||
    Object.keys(input).some((key) => key !== 'content' && key !== 'baseRevision') ||
    typeof input.content !== 'string' ||
    Buffer.from(input.content, 'utf8').toString('utf8') !== input.content ||
    (input.baseRevision !== null && (typeof input.baseRevision !== 'string' || !/^[a-f0-9]{64}$/.test(input.baseRevision)))
  ) {
    throw new SettingsCommandApplicationError('ZEUS_SETTINGS_COMMAND_INVALID', '全局规则需要有效正文和读取时的内容摘要。', 400);
  }
  if (Buffer.byteLength(input.content, 'utf8') > maximumAgentsBytes) throw new SettingsCommandApplicationError('ZEUS_SETTINGS_COMMAND_RESULT_TOO_LARGE', 'AGENTS.md 不能超过 1 MiB。', 413);
}

/** 沿用设置命令回执，正文不进入回执或审计。 */
export function registerGlobalAgentSettingsRoutes(options: {
  /** 已安装本地鉴权及只读限制的服务器。 */
  server: FastifyInstance;
  /** 全局规则真源目录；不可用时不回退到其他用户配置。 */
  agentRulesDirectory?: string;
  /** 现有设置命令通道。 */
  commands: SettingsCommandApplication;
  /** 统一脱敏入口。 */
  redactSensitiveText(value: string): { text: string };
  /** 只记录保存成功的元信息。 */
  recordSaved(metadata: GlobalAgentSettingsMetadata): void;
}): void {
  /** 单个服务实例负责该目标的写入顺序。 */
  const file = options.agentRulesDirectory ? new GlobalAgentSettings(options.agentRulesDirectory) : null;
  options.server.get('/api/settings/agents', async (_request, reply) => {
    if (!file) return reply.code(503).send({ error: 'ZEUS_AGENTS_SETTINGS_UNAVAILABLE', message: '当前 Zeus 全局规则目录不可用。' });
    try {
      return await file.read();
    } catch (error) {
      /** 读取拒绝只报告文件状态，不产生保存命令。 */
      const mapped = settingsCommandHttpError(error, options.redactSensitiveText);
      return reply.code(error instanceof SettingsExternalOperationRejectedError ? 409 : mapped.statusCode).send(mapped.body);
    }
  });
  options.server.put('/api/settings/agents', { bodyLimit: 8 * 1024 * 1024 }, async (request, reply) => {
    if (!file) return reply.code(503).send({ error: 'ZEUS_AGENTS_SETTINGS_UNAVAILABLE', message: '当前 Zeus 全局规则目录不可用。' });
    try {
      /** 文件摘要是业务输入，命令封装保留原有身份规则。 */
      const parsed = options.commands.parse<SaveGlobalAgentSettingsInput>({ value: request.body, commandType: settingsCommandTypes.agentsPut, scopeKind: 'settings', expectedScopeId: () => 'agents' });
      validateGlobalAgentSettingsInput(parsed.input);
      /** 重复命令复用成功回执，不再次写入。 */
      const saved = await options.commands.executeExternal({
        parsed,
        destinationId: 'filesystem:global-agents',
        resourceId: file.path,
        externalOperationId: `${parsed.operationIdentity}:agents`,
        sensitiveValues: [parsed.input.content],
        invoke: () => file.save(parsed.input),
        mutateAcceptedBusinessState: options.recordSaved,
      });
      return saved.result;
    } catch (error) {
      /** 保留冲突、失败和结果未知的命令语义。 */
      const mapped = settingsCommandHttpError(error, options.redactSensitiveText);
      return reply.code(mapped.statusCode).send(mapped.body);
    }
  });
}
