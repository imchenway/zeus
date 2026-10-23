import { filePreviewMime, filePreviewKind, filePreviewLimits, userFacingErrorCause } from '@zeus/shared';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, link, mkdir, open, readFile, realpath, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { createConversationAttachmentGrant, resolveConversationAttachmentGrant } from '@zeus/local-server/conversation-attachment-grant';
import {
  buildTaskAttachmentPreviewDataUrl,
  coerceTaskClipboardAttachmentBuffer,
  extractTaskClipboardResidualText,
  inferTaskClipboardAttachmentMimeType,
  isSupportedImageInputMimeType,
  readTaskClipboardAttachmentsFromClipboard,
  readTaskClipboardFileReferencesFromClipboard,
  safelyReadTaskClipboardImageAttachment,
  type NativeTaskClipboardReader,
  type TaskClipboardAttachmentPayload,
  type TaskClipboardReadOptions,
} from './taskClipboard.js';
import type { MainCommandExecutionContext } from './mainCommandLedger.js';

export type ConversationInputResourceSource = 'picker' | 'paste' | 'drop';
export type ConversationInputResourceKind = 'image' | 'file' | 'directory' | 'pasted_text';

export type ConversationInputResource = {
  name: string;
  mime: string;
  size: number;
  kind: ConversationInputResourceKind;
  source: ConversationInputResourceSource;
  characterCount?: number;
  restorableText?: string;
} & ({ localPath: string; uploadRef?: never } | { localPath?: never; uploadRef: string });

export interface ConversationResourcePayload {
  name?: string;
  type?: string;
  data?: ArrayBuffer | Uint8Array;
  text?: string;
  source?: ConversationInputResourceSource;
  kind?: ConversationInputResourceKind;
}

/** 附件命令将明确失败保存为业务回执，只有回执缺失才属于结果未知。 */
export type ConversationResourceCommandResult = { ok: true; value: ConversationInputResource[] | { resources: ConversationInputResource[]; text: string } } | { ok: false; error: string };

export interface ConversationInputResourceBroker {
  /** 默认保存文件副本；只有明确的原生引用选择入口才能签发源路径授权。 */
  describePaths(paths: string[], source: ConversationInputResourceSource, command: MainCommandExecutionContext, clipboardImage?: TaskClipboardAttachmentPayload | null, mode?: 'copy' | 'reference'): Promise<ConversationInputResource[]>;
  /** 二进制与长文本共用副本保存，写入前才记录命令标记。 */
  materialize(payloads: ConversationResourcePayload[], command: MainCommandExecutionContext): Promise<ConversationInputResource[]>;
  /** 同次粘贴的正文与图片在异步读取前固定。 */
  readClipboard(command: MainCommandExecutionContext): Promise<{ resources: ConversationInputResource[]; text: string }>;
  /** 保存完整副本的结果及校验值，供回执丢失时核对。 */
  recordResult(command: MainCommandExecutionContext, result: ConversationResourceCommandResult): Promise<void>;
  /** 只核对同次导入的受管文件，不读取剪贴板或重放导入。 */
  recoverResult(commandId: string, requestSha256: string): Promise<ConversationResourceCommandResult | null>;
  resolve(resource: { localPath?: string; uploadRef?: string }): Promise<string | null>;
  preview(resource: { localPath?: string; uploadRef?: string }): Promise<{ previewUrl: string; mimeType: string } | null>;
}

export interface CreateConversationInputResourceBrokerOptions {
  attachmentRoot: string;
  grantSecret: string;
  clipboard: NativeTaskClipboardReader;
  clipboardReadOptions?: TaskClipboardReadOptions;
  convertImagePathToPng?: (path: string) => Uint8Array | null;
}

/** 单次添加最多接受的资源数量，超限明确拒绝而非截断。 */
const maximumResourceCount = 100;
/** 单个附件的内容上限，单位为字节。 */
const maximumResourceBytes = 100 * 1024 * 1024;
/** 单批附件内容上限，单位为字节。 */
const maximumBatchBytes = 256 * 1024 * 1024;
/** 达到此字符数的粘贴正文保存为文本附件。 */
const longPasteThreshold = 5_000;
/** 草稿中允许直接恢复的文本字符数上限。 */
const maximumRestorableTextCharacters = 25_000;
/** 结果记录包括最多 100 份可恢复文本和路径元信息，单位为字节。 */
const maximumImportReceiptBytes = 16 * 1024 * 1024;

/** 受信原生输入统一生成独立副本或明确的文件引用。 */
export function createConversationInputResourceBroker(options: CreateConversationInputResourceBrokerOptions): ConversationInputResourceBroker {
  /** 文件、副本回执及预览使用同一个受管根目录。 */
  const attachmentRoot = resolve(options.attachmentRoot);

  return {
    /** 添加附件保存原始内容；引用入口仅返回精确源路径授权。 */
    async describePaths(paths, source, command, clipboardImage, mode = 'copy') {
      if (paths.length > maximumResourceCount) throw new Error('一次最多添加 100 个附件。');
      /** 单次命令拥有独立文件名，移除其他草稿不会影响该副本。 */
      const operationKey = commandResourceKey(command.envelope.commandId);
      /** 本批实际保存的字节数。 */
      let batchBytes = 0;
      /** 只有全部请求完成后才把资源交给输入框。 */
      const resources: ConversationInputResource[] = [];
      /** 同一来源在一批内只导入一次。 */
      const seen = new Set<string>();
      /** 原生文件图标不能代替 Windows 文件；多项输入不合并成一张位图。 */
      const fallbackImage = mode === 'copy' && process.platform !== 'win32' && source === 'paste' && paths.length === 1 && inferTaskClipboardAttachmentMimeType(paths[0] ?? '').startsWith('image/') ? (clipboardImage ?? null) : null;
      for (const [index, path] of paths.entries()) {
        if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) throw new Error('附件路径无效。');
        /** 来源打开失败可以使用同次图片快照；副本写入开始后禁止换源。 */
        let persistenceStarted = false;
        try {
          /** 解析符号链接后按用户选定的真实文件读取。 */
          const canonicalPath = await realpath(path);
          if (seen.has(canonicalPath)) continue;
          seen.add(canonicalPath);
          /** 目录只允许显式引用，不会随普通拖放隐式复制。 */
          const pathStat = await stat(canonicalPath);
          if (!pathStat.isFile() && !pathStat.isDirectory()) throw new Error('只能添加普通文件，不能添加设备或管道。');
          /** 文件名只用于展示和副本后缀，不决定是否保存独立副本。 */
          const mime = pathStat.isDirectory() ? 'inode/directory' : inferTaskClipboardAttachmentMimeType(canonicalPath);
          if (mode === 'reference') {
            resources.push({
              name: basename(canonicalPath),
              mime,
              size: pathStat.isDirectory() ? 0 : pathStat.size,
              kind: pathStat.isDirectory() ? 'directory' : isSupportedImageInputMimeType(mime) ? 'image' : 'file',
              source,
              uploadRef: createConversationAttachmentGrant(canonicalPath, options.grantSecret),
            });
            continue;
          }
          if (pathStat.isDirectory()) throw new Error('目录请通过“引用项目目录”添加；普通附件只保存文件副本。');
          if (pathStat.size > maximumResourceBytes || batchBytes + pathStat.size > maximumBatchBytes) throw new Error('附件超过大小限制：单个文件 100 MiB，单批 256 MiB。');
          /** 流式读取不把整个普通文件装入内存；首次读取成功后才开始落盘。 */
          const saved = await copyResourceFile(canonicalPath, attachmentRoot, `${operationKey}-${index + 1}`, maximumBatchBytes - batchBytes, async () => {
            await command.markWriteStarted();
            persistenceStarted = true;
          });
          batchBytes += saved.size;
          resources.push({ name: basename(canonicalPath), mime, size: saved.size, kind: isSupportedImageInputMimeType(mime) ? 'image' : 'file', source, localPath: saved.path });
        } catch (error) {
          if (!persistenceStarted && fallbackImage && isUnreadableSourceError(error)) return this.materialize([{ ...fallbackImage, source }], command);
          throw new Error(`附件无法保存：${userFacingErrorCause(error).message}`, { cause: error });
        }
      }
      return resources;
    },

    /** 先校验整批内存载荷，再保存，空文件也是有效附件。 */
    async materialize(payloads, command) {
      if (payloads.length > maximumResourceCount) throw new Error('一次最多添加 100 个附件。');
      /** 单批输入总量在任何文件写入前完成检查。 */
      const totalBytes = payloads.reduce((total, payload) => {
        /** 文本按 UTF-8 字节而非字符数计入附件容量。 */
        const bytes = typeof payload.text === 'string' ? Buffer.byteLength(payload.text, 'utf8') : coerceTaskClipboardAttachmentBuffer(payload.data)?.byteLength;
        if (bytes === undefined || bytes > maximumResourceBytes) throw new Error('附件内容无效或超过单文件 100 MiB 限制。');
        return total + bytes;
      }, 0);
      if (totalBytes > maximumBatchBytes) throw new Error('附件超过单批 256 MiB 限制。');
      /** 同批内容使用稳定命令前缀。 */
      const operationKey = commandResourceKey(command.envelope.commandId);
      /** 仅返回完整保存的本批资源。 */
      const resources: ConversationInputResource[] = [];
      /** 实际内容总量也复验，防止载荷格式与预检查不一致。 */
      let batchBytes = 0;
      for (const [index, payload] of payloads.entries()) {
        /** 来源只影响展示与诊断，不改变副本所有权。 */
        const source = normalizeSource(payload.source);
        /** 文本附件保留有限长度的可恢复正文。 */
        const text = typeof payload.text === 'string' ? payload.text : undefined;
        /** 写入与摘要使用同一份规范化字节。 */
        const data = text === undefined ? coerceTaskClipboardAttachmentBuffer(payload.data) : Buffer.from(text, 'utf8');
        if (!data || data.byteLength > maximumResourceBytes || batchBytes + data.byteLength > maximumBatchBytes) throw new Error('附件内容无效或超过大小限制。');
        batchBytes += data.byteLength;
        /** 粘贴正文与普通二进制文件采用不同展示类型。 */
        const pastedText = text !== undefined || payload.kind === 'pasted_text';
        /** 副本文件名满足两端长度限制。 */
        const safeName = sanitizeResourceName(payload.name || (pastedText ? 'Pasted text.txt' : `pasted-resource-${index + 1}`));
        /** 内容摘要用于禁止同名文件被不同内容覆盖。 */
        const contentHash = createHash('sha256').update(data).digest('hex');
        /** 每次导入独立命名，不复用其他消息的可删除路径。 */
        const filePath = join(attachmentRoot, `${operationKey}-${index + 1}-${contentHash.slice(0, 16)}-${safeName}`);
        await command.markWriteStarted();
        await mkdir(attachmentRoot, { recursive: true, mode: 0o700 });
        await writeAtomicResourceFile(filePath, data, contentHash);
        /** MIME 沿用实际输入和扩展名，不因保存副本改变类型。 */
        const mime = pastedText ? 'text/plain' : normalizeMime(payload.type, filePath);
        resources.push({
          name: safeName,
          mime,
          size: data.byteLength,
          kind: pastedText ? 'pasted_text' : isSupportedImageInputMimeType(mime) ? 'image' : 'file',
          source,
          ...(pastedText ? { characterCount: text?.length ?? 0 } : {}),
          ...(pastedText && text !== undefined && text.length <= maximumRestorableTextCharacters ? { restorableText: text } : {}),
          localPath: filePath,
        });
      }
      return resources;
    },

    /** 读取后固定正文和图片，异步文件处理不再取后续剪贴板内容。 */
    async readClipboard(command) {
      /** 在异步文件读取前固定图片数据，Windows 文件引用不使用可能为资源管理器图标的位图。 */
      const clipboardImage = safelyReadTaskClipboardImageAttachment(options.clipboard);
      /** 正文与本次图片采用同一粘贴时刻。 */
      const clipboardText = safelyReadClipboardText(options.clipboard);
      const referencedPaths = await readTaskClipboardFileReferencesFromClipboard(options.clipboard, options.clipboardReadOptions);
      if (referencedPaths.length > 0) {
        return {
          resources: await this.describePaths(referencedPaths, 'paste', command, clipboardImage),
          // 路径已经变成附件，剪贴板正文里剩下的说明文字仍要留在输入框。
          text: extractTaskClipboardResidualText(clipboardText, referencedPaths),
        };
      }
      // 上一步已读取系统文件引用；二进制回退只检查 Electron 格式，避免重复启动 osascript。
      const binaryResources = clipboardImage ? [clipboardImage] : await readTaskClipboardAttachmentsFromClipboard(options.clipboard);
      if (binaryResources.length > 0) {
        return {
          resources: await this.materialize(
            binaryResources.map((resource) => ({ ...resource, source: 'paste' })),
            command,
          ),
          text: '',
        };
      }
      const text = clipboardText;
      if (text.length >= longPasteThreshold) {
        return {
          resources: await this.materialize([{ name: 'Pasted text.txt', type: 'text/plain', text, source: 'paste', kind: 'pasted_text' }], command),
          text: '',
        };
      }
      return { resources: [], text };
    },

    /** 副本确认完成后保存原始结果；回执文件不保存源文件内容。 */
    async recordResult(command, result) {
      if (!result.ok) return;
      /** 无本地副本的取消选择和显式引用只需要命令账本回执。 */
      const resources = Array.isArray(result.value) ? result.value : result.value.resources;
      /** 每条核对证据绑定完整摘要及同一命令创建的受管路径。 */
      const files: Array<{ path: string; sha256: string; size: number }> = [];
      for (const resource of resources) {
        if (!resource.localPath) continue;
        /** 防止结果记录把外部路径当作本次副本。 */
        const path = await resolveInputResourcePath({ localPath: resource.localPath }, options.grantSecret, attachmentRoot);
        if (!path || !basename(path).startsWith(`${commandResourceKey(command.envelope.commandId)}-`)) throw new Error('附件副本归属与本次操作不一致。');
        /** 读取完整摘要，恢复时不能仅凭文件存在判断成功。 */
        const fingerprint = await resourceFingerprint(path);
        if (fingerprint.size !== resource.size) throw new Error('附件副本大小与保存结果不一致。');
        files.push({ path, ...fingerprint });
      }
      if (files.length === 0) return;
      /** 摘要与完整返回值一起原子保存，避免只恢复部分附件。 */
      const data = Buffer.from(JSON.stringify({ commandId: command.envelope.commandId, requestSha256: command.requestSha256, result, files }));
      if (data.byteLength > maximumImportReceiptBytes) throw new Error('附件结果记录超过大小限制。');
      await command.markWriteStarted();
      await mkdir(join(attachmentRoot, '.imports'), { recursive: true, mode: 0o700 });
      await writeAtomicResourceFile(join(attachmentRoot, '.imports', `${commandResourceKey(command.envelope.commandId)}.json`), data, createHash('sha256').update(data).digest('hex'));
    },

    /** 只读校验已完成的导入证据；缺记录、文件变化或归属不符均不恢复成功。 */
    async recoverResult(commandId, requestSha256) {
      try {
        /** 命令身份只用于生成受管记录路径，不能指定任意文件。 */
        const path = join(attachmentRoot, '.imports', `${commandResourceKey(commandId)}.json`);
        if ((await stat(path)).size > maximumImportReceiptBytes) return null;
        /** 记录来自本地受管目录，仍需检查身份、结构及所有文件摘要。 */
        const record = JSON.parse(await readFile(path, 'utf8')) as { commandId?: unknown; requestSha256?: unknown; result?: ConversationResourceCommandResult; files?: Array<{ path: string; sha256: string; size: number }> };
        if (record.commandId !== commandId || record.requestSha256 !== requestSha256 || record.result?.ok !== true || !Array.isArray(record.files) || record.files.length === 0 || record.files.length > maximumResourceCount) return null;
        /** 返回值中的每个副本必须有且仅有对应的完整文件证据。 */
        const resources = Array.isArray(record.result.value) ? record.result.value : record.result.value.resources;
        if (!Array.isArray(resources) || resources.length > maximumResourceCount) return null;
        /** 文件证据不能缺项或重复指向同一副本。 */
        const localResources = resources.filter((resource) => typeof resource.localPath === 'string');
        if (localResources.length !== record.files.length) return null;
        if (record.files.some((file) => !file || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > maximumResourceBytes)) return null;
        if (record.files.reduce((total, file) => total + file.size, 0) > maximumBatchBytes) return null;
        if (new Set(record.files.map((file) => file.path)).size !== record.files.length) return null;
        for (const file of record.files) {
          if (typeof file.path !== 'string' || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(file.sha256)) return null;
          /** 返回给草稿的大小和路径必须与落盘证据一致。 */
          const resource = localResources.find((candidate) => candidate.localPath === file.path);
          if (!resource || resource.size !== file.size || !basename(file.path).startsWith(`${commandResourceKey(commandId)}-`)) return null;
          /** 真实路径也必须位于同一受管根内。 */
          const canonicalPath = await resolveInputResourcePath({ localPath: file.path }, options.grantSecret, attachmentRoot);
          if (canonicalPath !== file.path) return null;
          /** 全量摘要匹配后才可恢复原结果。 */
          const fingerprint = await resourceFingerprint(file.path);
          if (fingerprint.size !== file.size || fingerprint.sha256 !== file.sha256) return null;
        }
        return record.result;
      } catch {
        return null;
      }
    },

    async resolve(resource) {
      return resolveInputResourcePath(resource, options.grantSecret, attachmentRoot);
    },

    async preview(resource) {
      const resolvedPath = await resolveInputResourcePath(resource, options.grantSecret, attachmentRoot);
      if (!resolvedPath) return null;
      const mimeType = filePreviewMime(resolvedPath);
      if (!mimeType.startsWith('image/')) return null;
      const pathStat = await stat(resolvedPath);
      if (!pathStat.isFile() || pathStat.size > filePreviewLimits.image) return null;
      const data = await readFile(resolvedPath);
      const previewUrl = filePreviewKind(mimeType) === 'image' ? `data:${mimeType};base64,${data.toString('base64')}` : undefined;
      if (previewUrl) return { previewUrl, mimeType };
      const png = options.convertImagePathToPng?.(resolvedPath);
      const convertedPreviewUrl = png ? buildTaskAttachmentPreviewDataUrl(png, 'image/png') : undefined;
      return convertedPreviewUrl ? { previewUrl: convertedPreviewUrl, mimeType: 'image/png' } : null;
    },
  };
}

/** 从已经打开的源文件流式生成副本，校验期间变化的文件不会作为成功结果发布。 */
async function copyResourceFile(sourcePath: string, root: string, operationKey: string, remainingBytes: number, beforeWrite: () => Promise<void>): Promise<{ path: string; size: number }> {
  /** 文件句柄固定本次读取对象，不在复制过程中重新打开同名路径。 */
  const source = await open(sourcePath, 'r');
  /** 临时文件只归当前导入所有，失败时可以安全释放。 */
  const temporaryPath = join(root, `.${operationKey}-${randomUUID()}.tmp`);
  try {
    /** 纳秒时间与长度用于发现读取期间的源文件修改。 */
    const initial = await source.stat({ bigint: true });
    if (!initial.isFile()) throw new Error('附件来源不是普通文件。');
    if (initial.size > BigInt(Math.min(maximumResourceBytes, remainingBytes))) throw new Error('附件超过大小限制：单个文件 100 MiB，单批 256 MiB。');
    /** 复制缓冲区固定为 64 KiB，内存使用不随文件大小增长。 */
    const buffer = Buffer.alloc(64 * 1024);
    /** 首次读取失败仍属于保存前失败。 */
    let read = await source.read(buffer, 0, buffer.length, null);
    await beforeWrite();
    await mkdir(root, { recursive: true, mode: 0o700 });
    /** 独占创建临时文件，避免覆盖任何既有副本。 */
    const target = await open(temporaryPath, 'wx', 0o600);
    /** 摘要与实际写入使用相同字节。 */
    const hash = createHash('sha256');
    /** 实际字节数也参与上限检查，防止来源在读取中增长。 */
    let size = 0;
    try {
      while (read.bytesRead > 0) {
        size += read.bytesRead;
        if (size > maximumResourceBytes || size > remainingBytes) throw new Error('读取中的附件超过大小限制。');
        /** 每块写完才复用缓冲区。 */
        const chunk = buffer.subarray(0, read.bytesRead);
        hash.update(chunk);
        await target.writeFile(chunk);
        read = await source.read(buffer, 0, buffer.length, null);
      }
      /** 来源内容发生变化时，让用户重新明确添加，不保存混合内容。 */
      const completed = await source.stat({ bigint: true });
      if (initial.size !== completed.size || initial.mtimeNs !== completed.mtimeNs || initial.ctimeNs !== completed.ctimeNs || BigInt(size) !== completed.size) throw new Error('附件在读取期间发生变化，请重新添加。');
      await target.sync();
    } finally {
      await target.close();
    }
    /** 完整内容摘要进入独立命令的文件名，不跨草稿共享可删除路径。 */
    const sha256 = hash.digest('hex');
    /** 最终路径仅位于当前受管目录。 */
    const path = join(root, `${operationKey}-${sha256.slice(0, 16)}-${sanitizeResourceName(basename(sourcePath))}`);
    await publishResourceFile(temporaryPath, path, sha256);
    return { path, size };
  } finally {
    await source.close();
    await unlink(temporaryPath).catch(() => undefined);
  }
}

/** 读取受管普通文件的完整摘要，拒绝目录和超过附件上限的文件。 */
async function resourceFingerprint(path: string): Promise<{ sha256: string; size: number }> {
  /** 同一文件句柄同时用于元信息与内容读取。 */
  const handle = await open(path, 'r');
  try {
    /** 内容读取前先检查文件类型和大小。 */
    const metadata = await handle.stat({ bigint: true });
    if (!metadata.isFile() || metadata.size > BigInt(maximumResourceBytes)) throw new Error('附件副本类型或大小无效。');
    /** 哈希在流式读取中累计，不保留整个文件。 */
    const hash = createHash('sha256');
    /** 读取中的文件增长也受上限约束。 */
    let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      size += chunk.length;
      if (size > maximumResourceBytes) throw new Error('附件副本超过大小限制。');
      hash.update(chunk);
    }
    /** 核对期间发生内容变化时不能把混合读取当作完成证据。 */
    const completed = await handle.stat({ bigint: true });
    if (metadata.size !== completed.size || metadata.mtimeNs !== completed.mtimeNs || metadata.ctimeNs !== completed.ctimeNs || BigInt(size) !== completed.size) throw new Error('附件副本在核对期间发生变化。');
    return { sha256: hash.digest('hex'), size };
  } finally {
    await handle.close();
  }
}

/** 仅源文件读取失败允许图片快照回退，大小限制和写入故障不换来源。 */
function isUnreadableSourceError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && ['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR', 'EIO'].includes(String(error.code));
}

/** 导入身份只产生固定长度文件前缀，不使用用户输入构造目录。 */
function commandResourceKey(commandId: string): string {
  if (typeof commandId !== 'string' || !commandId.trim() || commandId.length > 256 || commandId.includes('\0')) throw new TypeError('Conversation resource command identity is invalid.');
  return `command-${createHash('sha256').update(commandId).digest('hex').slice(0, 24)}`;
}

/** 内存载荷先完整同步，再通过原子发布获得最终文件名。 */
async function writeAtomicResourceFile(destination: string, data: Buffer, expectedSha256: string): Promise<void> {
  const existing = await readFile(destination).catch((error: unknown) => {
    if (isMissingFileError(error)) return null;
    throw error;
  });
  if (existing) {
    if (createHash('sha256').update(existing).digest('hex') !== expectedSha256) throw new Error('Conversation resource CAS destination contains different bytes.');
    return;
  }
  const temporaryPath = join(dirname(destination), `.${basename(destination)}.${randomUUID()}.tmp`);
  try {
    /** 独占创建，仅当前写入者拥有临时文件。 */
    const handle = await open(temporaryPath, 'wx', 0o600);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await publishResourceFile(temporaryPath, destination, expectedSha256);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

/** 文件副本与结果记录共用禁止覆盖的原子发布，目录同步遵循平台能力。 */
async function publishResourceFile(temporaryPath: string, destination: string, expectedSha256: string): Promise<void> {
  try {
    try {
      // hard-link 发布同时具备原子可见与 no-replace 语义；同 command 的并发只允许相同内容胜出。
      await link(temporaryPath, destination);
    } catch (error) {
      if (!isExistingFileError(error)) throw error;
      const concurrentWinner = await resourceFingerprint(destination);
      if (concurrentWinner.sha256 !== expectedSha256) {
        throw new Error('Conversation resource CAS destination contains different bytes.');
      }
    }
    await unlink(temporaryPath);
    // Windows 不支持用普通文件句柄同步目录；文件内容已同步，发布仍使用原子硬链接。
    if (process.platform !== 'win32') {
      /** 支持目录句柄的平台同步新文件的目录项。 */
      const directory = await open(dirname(destination), 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export async function readOrCreateConversationAttachmentGrantSecret(filePath: string): Promise<string> {
  const resolvedPath = resolve(filePath);
  try {
    const existing = (await readFile(resolvedPath, 'utf8')).trim();
    if (existing.length >= 43) {
      await chmod(resolvedPath, 0o600);
      return existing;
    }
    throw new Error('Conversation attachment grant secret is invalid.');
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }

  await mkdir(dirname(resolvedPath), { recursive: true, mode: 0o700 });
  const secret = randomBytes(32).toString('base64url');
  try {
    await writeFile(resolvedPath, `${secret}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return secret;
  } catch (error) {
    if (!isExistingFileError(error)) throw error;
    const existing = (await readFile(resolvedPath, 'utf8')).trim();
    if (existing.length < 43) throw new Error('Conversation attachment grant secret is invalid.');
    await chmod(resolvedPath, 0o600);
    return existing;
  }
}

function normalizeSource(value: unknown): ConversationInputResourceSource {
  return value === 'picker' || value === 'drop' ? value : 'paste';
}

function normalizeMime(value: unknown, filePath: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : inferTaskClipboardAttachmentMimeType(filePath);
}

/** 文件后缀保留可读名称并限制 UTF-8 字节数，为命令身份、摘要和临时文件名留足空间。 */
function sanitizeResourceName(value: string): string {
  const safeName = basename(value)
    .replace(/[^\p{L}\p{N}._ ()[\]-]+/gu, '-')
    .replace(/\s+/gu, ' ')
    .trim();
  /** 保留常规扩展名，使本地预览和外部程序仍能识别副本类型。 */
  const extension = Buffer.byteLength(extname(safeName), 'utf8') <= 32 ? extname(safeName) : '';
  /** 按完整字符截取，不在中文或表情编码中间截断。 */
  const characters = [...(extension ? safeName.slice(0, -extension.length) : safeName || 'pasted-resource')];
  while (Buffer.byteLength(characters.join('') + extension, 'utf8') > 150) characters.pop();
  return (characters.join('') || 'attachment') + extension;
}

async function resolveInputResourcePath(resource: { localPath?: string; uploadRef?: string }, grantSecret: string, attachmentRoot: string): Promise<string | null> {
  const granted = typeof resource.uploadRef === 'string' ? resolveConversationAttachmentGrant(resource.uploadRef, grantSecret) : null;
  const requested = granted ?? (typeof resource.localPath === 'string' ? resource.localPath : '');
  if (!requested || !isAbsolute(requested) || requested.includes('\0')) return null;
  try {
    const canonicalPath = await realpath(requested);
    if (granted) return canonicalPath === granted ? canonicalPath : null;
    const root = await realpath(attachmentRoot);
    const delta = relative(root, canonicalPath);
    return delta && !delta.startsWith('..') && !isAbsolute(delta) ? canonicalPath : null;
  } catch {
    return null;
  }
}

function safelyReadClipboardText(reader: NativeTaskClipboardReader): string {
  try {
    return reader.readText();
  } catch {
    return '';
  }
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function isExistingFileError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'EEXIST';
}
