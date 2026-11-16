import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { ensurePrivatePathSync, openRegularFileNoFollow, publishFile, readPrivateFileSync } from '@zeus/storage/platform-security';
import type { SecretStore } from '@zeus/local-server';
import type { ZeusBrowserPasswordAccount, ZeusBrowserPasswordImportPreview, ZeusBrowserPasswordImportResult } from '@zeus/shared';

/** 沿用平台私有文件读取器的 4 MiB 上限，拒绝超限而不截断密码。 */
const maximumPasswordBytes = 4 * 1024 * 1024;
/** 密钥由系统凭据后端保护，与浏览器普通资料及备份分开。 */
const passwordKeyAccount = 'browser.passwords.key';
/** 文件头用于拒绝不属于 Zeus 密码库的文件；认证由 GCM 提供。 */
const passwordFileMagic = Buffer.from('ZPWD');
/** 用户离开确认流程后，未提交的明文导入内容最多保留十分钟。 */
const importLifetimeMs = 10 * 60 * 1000;

/** 密码只在主进程解密，并且不参与账号列表或导入回执。 */
interface PasswordEntry extends ZeusBrowserPasswordAccount {
  password: string;
}

/** 每次原子保存改变修订，防止旧预览覆盖其后发生的修改。 */
interface PasswordState {
  revision: string;
  entries: PasswordEntry[];
}

/** 同一站点、账号在 CSV 中的不同密码候选。 */
interface ImportGroup {
  id: string;
  origin: string;
  username: string;
  existing?: PasswordEntry;
  variants: Array<{ row: number; password: string }>;
  /** 同一账号内按密码去重，避免大文件逐项扫描所有候选。 */
  passwords: Set<string>;
}

/** 每个设置窗口只保留最近一次导入，页面不能取得候选密码。 */
interface PendingPasswordImport {
  token: string;
  revision: string;
  groups: ImportGroup[];
  skipped: number;
  invalid: number;
  timer: ReturnType<typeof setTimeout>;
}

/** 协议、主机和有效端口共同确定密码范围，拒绝带凭据的网址。 */
export function browserPasswordOrigin(value: string): string {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('只支持不含账号密码的 HTTP 或 HTTPS 地址。');
  return url.origin;
}

/** 用户名保留大小写及空格，使用结构化键避免分隔符冲突。 */
function accountIdentity(origin: string, username: string): string {
  return JSON.stringify([origin, username]);
}

/** 判断是否需要用户在已有密码与 CSV 候选之间选择。 */
function hasPasswordConflict(group: ImportGroup): boolean {
  return group.variants.length > 1 || Boolean(group.existing && group.existing.password !== group.variants[0]?.password);
}

/** 本机密码库复用系统密钥与原子私有文件，不增加主密码或解锁状态。 */
export class BrowserPasswordStore {
  /** ponytail: 单个密码文件串行读写；分为多个资料时按资料各建实例。 */
  private tail: Promise<unknown> = Promise.resolve();
  /** 每个窗口独立确认导入，关闭或超时即释放明文候选。 */
  private readonly pending = new Map<number, PendingPasswordImport>();
  /** 仅在进程存活期间缓存系统解密后的随机密钥。 */
  private key: Buffer | undefined;

  /** 文件必须位于当前 Zeus 资料根；凭据后端使用同一资料的隔离身份。 */
  constructor(
    private readonly path: string,
    private readonly secrets: SecretStore,
  ) {}

  /** 串行任务失败仍向调用方报告，并允许后续操作继续。 */
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => undefined);
    return result;
  }

  /** 账号列表不包含密码，也不创建空密码库或申请新的系统凭据。 */
  list(origin?: string): Promise<ZeusBrowserPasswordAccount[]> {
    return this.serial(async () => (await this.load()).entries.filter((entry) => !origin || entry.origin === origin).map(({ id, origin: site, username }) => ({ id, origin: site, username })));
  }

  /** 专属隔离世界读取本站凭据；只供主进程的受控内容脚本桥使用。 */
  credentials(origin: string): Promise<PasswordEntry[]> {
    return this.serial(async () => (await this.load()).entries.filter((entry) => entry.origin === origin));
  }

  /** 原子删除选定账号，不删除其他站点或账号。 */
  remove(id: string, beforeWrite: () => Promise<void>): Promise<void> {
    return this.serial(async () => {
      const state = await this.load();
      const entries = state.entries.filter((entry) => entry.id !== id);
      if (entries.length !== state.entries.length) {
        await beforeWrite();
        await this.save(entries);
      }
    });
  }

  /** 取消仅释放主进程候选，不修改已经保存的密码。 */
  cancel(owner: number, token?: string): void {
    const plan = this.pending.get(owner);
    if (!plan || (token !== undefined && token !== plan.token)) return;
    clearTimeout(plan.timer);
    this.pending.delete(owner);
  }

  /** 结束宿主生命周期时释放候选与内存密钥。 */
  async dispose(): Promise<void> {
    await this.tail;
    for (const owner of this.pending.keys()) this.cancel(owner);
    this.key?.fill(0);
    this.key = undefined;
  }

  /** 读取用户原生选择的 CSV；原文不进入 Renderer、命令账本或附件目录。 */
  prepare(owner: number, filePath: string): Promise<ZeusBrowserPasswordImportPreview> {
    return this.serial(async () => {
      this.cancel(owner);
      const handle = await openRegularFileNoFollow(filePath, constants.O_RDONLY);
      let csv: string;
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size === 0 || info.size > maximumPasswordBytes) throw new Error('CSV 文件须为非空普通文件，大小不能超过 4 MiB。');
        const bytes = Buffer.alloc(info.size + 1);
        let length = 0;
        while (length < bytes.length) {
          const read = await handle.read(bytes, length, bytes.length - length, length);
          if (!read.bytesRead) break;
          length += read.bytesRead;
        }
        const after = await handle.stat();
        if (length !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) throw new Error('CSV 在读取期间发生变化，请重新选择文件。');
        try {
          csv = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
        } finally {
          bytes.fill(0);
        }
      } finally {
        await handle.close();
      }
      /** 复用已安装的 SheetJS 读取引号、逗号和单元格内换行，raw 保留密码原文。 */
      const { read, utils } = await import('xlsx');
      let rows: string[][];
      try {
        const book = read(csv, { type: 'string', raw: true, FS: ',' });
        const sheet = book.Sheets[book.SheetNames[0] ?? ''];
        if (!sheet) throw new Error();
        rows = utils.sheet_to_json<string[]>(sheet, { header: 1, raw: true, defval: '', blankrows: true });
      } catch {
        throw new Error('CSV 无法解析，请重新从 Chrome 导出。');
      } finally {
        csv = '';
      }
      const header = (rows.shift() ?? []).map((value) =>
        String(value)
          .replace(/^\uFEFF/u, '')
          .trim()
          .toLowerCase(),
      );
      const urlColumn = header.indexOf('url');
      const usernameColumn = header.indexOf('username');
      const passwordColumn = header.indexOf('password');
      if ([urlColumn, usernameColumn, passwordColumn].some((column) => column < 0) || new Set(header).size !== header.length) throw new Error('CSV 需要唯一的 url、username、password 列。');
      const state = await this.load();
      const existing = new Map(state.entries.map((entry) => [accountIdentity(entry.origin, entry.username), entry]));
      const groups = new Map<string, ImportGroup>();
      const invalidRows: ZeusBrowserPasswordImportPreview['invalidRows'] = [];
      let skipped = 0;
      for (const [index, row] of rows.entries()) {
        if (row.every((value) => value === '')) continue;
        const line = index + 2;
        const username = String(row[usernameColumn] ?? '');
        const password = String(row[passwordColumn] ?? '');
        let origin: string;
        try {
          origin = browserPasswordOrigin(String(row[urlColumn] ?? ''));
        } catch {
          invalidRows.push({ row: line, reason: '网址无效或不属于 HTTP / HTTPS' });
          continue;
        }
        if (!password || password.includes('\0') || username.includes('\0')) {
          invalidRows.push({ row: line, reason: '密码为空，或账号密码包含空字符' });
          continue;
        }
        const identity = accountIdentity(origin, username);
        const group = groups.get(identity) ?? { id: randomUUID(), origin, username, existing: existing.get(identity), variants: [], passwords: new Set<string>() };
        if (group.passwords.has(password)) skipped += 1;
        else {
          group.variants.push({ row: line, password });
          group.passwords.add(password);
        }
        groups.set(identity, group);
      }
      const token = randomUUID();
      const timer = setTimeout(() => this.cancel(owner, token), importLifetimeMs);
      timer.unref();
      this.pending.set(owner, { token, revision: state.revision, groups: [...groups.values()], skipped, invalid: invalidRows.length, timer });
      return {
        token,
        fileName: basename(filePath),
        added: [...groups.values()].filter((group) => !group.existing && !hasPasswordConflict(group)).length,
        unchanged: skipped + [...groups.values()].filter((group) => group.existing && !hasPasswordConflict(group)).length,
        invalidRows,
        conflicts: [...groups.values()]
          .filter(hasPasswordConflict)
          .map((group) => ({ id: group.id, origin: group.origin, username: group.username, rows: group.variants.map((variant) => variant.row), hasExisting: Boolean(group.existing) })),
      };
    });
  }

  /** 确认时重新核对修订和每项选择，不依据 CSV 顺序自动覆盖旧密码。 */
  commit(owner: number, token: string, choices: Record<string, number>, beforeWrite: () => Promise<void>): Promise<ZeusBrowserPasswordImportResult> {
    return this.serial(async () => {
      const plan = this.pending.get(owner);
      if (!plan || plan.token !== token) throw new Error('导入预览已失效，请重新选择 CSV。');
      const state = await this.load();
      if (state.revision !== plan.revision) throw new Error('密码库已变化，请重新导入以核对最新冲突。');
      const conflicts = new Set(plan.groups.filter(hasPasswordConflict).map((group) => group.id));
      if (Object.keys(choices).some((id) => !conflicts.has(id))) throw new Error('导入选择无效。');
      const result = { added: 0, updated: 0, skipped: plan.skipped, invalid: plan.invalid };
      const entries = new Map(state.entries.map((entry) => [accountIdentity(entry.origin, entry.username), entry]));
      for (const group of plan.groups) {
        const row = hasPasswordConflict(group) ? (choices[group.id] ?? 0) : group.variants[0]!.row;
        if (row === 0) {
          result.skipped += group.variants.length;
          continue;
        }
        const variant = group.variants.find((candidate) => candidate.row === row);
        if (!variant) throw new Error('导入选择不属于当前 CSV 候选。');
        if (variant.password === group.existing?.password) {
          result.skipped += group.variants.length;
          continue;
        }
        result.skipped += group.variants.length - 1;
        entries.set(accountIdentity(group.origin, group.username), { id: group.existing?.id ?? randomUUID(), origin: group.origin, username: group.username, password: variant.password });
        if (group.existing) result.updated += 1;
        else result.added += 1;
      }
      if (result.added || result.updated) {
        await beforeWrite();
        await this.save([...entries.values()]);
      }
      this.cancel(owner, token);
      return result;
    });
  }

  /** 缺少密钥时只允许新建空库使用；已有密文绝不静默重置。 */
  private async encryptionKey(create: boolean): Promise<Buffer> {
    if (this.key) return this.key;
    let encoded: string | undefined;
    try {
      encoded = await this.secrets.getSecret(passwordKeyAccount);
      if (!encoded && create) {
        encoded = randomBytes(32).toString('base64');
        await this.secrets.setSecret(passwordKeyAccount, encoded);
      }
    } catch {
      throw new Error('系统凭据存储不可用，密码库未被修改。');
    }
    const key = Buffer.from(encoded ?? '', 'base64');
    if (key.length !== 32 || key.toString('base64') !== encoded) throw new Error('密码库的系统密钥缺失或无效，原数据已保留。');
    this.key = key;
    return key;
  }

  /** 完整认证后才解析密码库；损坏、权限不足和解密失败都保留原文件。 */
  private async load(): Promise<PasswordState> {
    let bytes: Buffer;
    try {
      await lstat(this.path);
      bytes = readPrivateFileSync(this.path, maximumPasswordBytes);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { revision: 'empty', entries: [] };
      throw new Error('密码库读取失败，原数据已保留。');
    }
    const key = await this.encryptionKey(false);
    try {
      if (bytes.length < 32 || !bytes.subarray(0, 4).equals(passwordFileMagic)) throw new Error();
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(4, 16));
      decipher.setAuthTag(bytes.subarray(16, 32));
      const plain = Buffer.concat([decipher.update(bytes.subarray(32)), decipher.final()]);
      let state: PasswordState;
      try {
        state = JSON.parse(plain.toString('utf8')) as PasswordState;
      } finally {
        plain.fill(0);
      }
      if (
        typeof state.revision !== 'string' ||
        !Array.isArray(state.entries) ||
        state.entries.some((entry) => typeof entry.id !== 'string' || typeof entry.origin !== 'string' || typeof entry.username !== 'string' || typeof entry.password !== 'string' || browserPasswordOrigin(entry.origin) !== entry.origin)
      )
        throw new Error();
      return state;
    } catch {
      throw new Error('密码库无法解密或内容损坏，原数据已保留。');
    }
  }

  /** 先加密再原子发布，磁盘与临时文件始终只包含密文。 */
  private async save(entries: PasswordEntry[]): Promise<void> {
    const key = await this.encryptionKey(true);
    const plain = Buffer.from(JSON.stringify({ revision: randomUUID(), entries }));
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    let encrypted: Buffer;
    try {
      encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
    } finally {
      plain.fill(0);
    }
    const bytes = Buffer.concat([passwordFileMagic, iv, cipher.getAuthTag(), encrypted]);
    if (bytes.length > maximumPasswordBytes) throw new Error('密码库超过 4 MiB，未写入此次更改。');
    ensurePrivatePathSync(dirname(this.path), 'directory');
    const temporary = join(dirname(this.path), `passwords-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
      ensurePrivatePathSync(temporary, 'file');
      await publishFile(temporary, this.path, { replace: true });
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
