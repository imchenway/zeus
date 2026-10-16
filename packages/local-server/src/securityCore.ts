import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { windowsSecurityRequestAsync } from '@zeus/storage/platform-security';

/** 将系统凭据命令转换为异步调用。 */
const execFileAsync = promisify(execFile);

/** 平台凭据后端只暴露读写删除，不向业务层暴露加密材料。 */
export interface SecretStore {
  setSecret(account: string, value: string): Promise<void>;
  getSecret(account: string): Promise<string | undefined>;
  deleteSecret(account: string): Promise<void>;
}

/** 设置界面的凭据存在状态，不包含凭据本身。 */
export interface SecretPresenceLabel {
  configured: boolean;
  label: '已安全保存' | '未配置';
}

/** 依据实际运行平台选择原生凭据后端；独立宿主不依赖 Electron Main。 */
export function createPlatformSecretStore(options: { service: string; dataRootPath: string }): SecretStore {
  if (process.platform === 'darwin') return createMacOSKeychainStore({ service: options.service });
  if (process.platform !== 'win32') throw new Error('当前系统尚未配置 Zeus 原生凭据后端。');
  if (!options.service || options.service.trim() !== options.service || options.service.length > 160 || /\p{Cc}/u.test(options.service)) throw new Error('Zeus 凭据 service 无效。');
  /** 凭据密文与运行根隔离；备份不包含该系统凭据目录。 */
  const directory = join(options.dataRootPath, 'runtime', 'secrets');
  /** 账户名维持既有契约，秘密不会出现在进程命令行或诊断结果中。 */
  const request = <T>(operation: string, account: string, value?: string): Promise<T> => {
    if (!/^[a-z0-9_.:-]+$/iu.test(account)) throw new Error('Zeus 凭据 account 无效。');
    return windowsSecurityRequestAsync<T>({ operation, directory, service: options.service, account, ...(value === undefined ? {} : { value }) });
  };
  return {
    async setSecret(account, value) {
      if (!value || value.includes('\0') || value.length > 64 * 1024) throw new Error('Zeus 凭据内容无效或超过大小上限。');
      await request('secret-set', account, value);
    },
    async getSecret(account) {
      return (await request<{ value: string | null }>('secret-get', account)).value ?? undefined;
    },
    async deleteSecret(account) {
      await request('secret-delete', account);
    },
  };
}

/** 创建 macOS Keychain 适配器；独立测试身份必须传入自己的 service。 */
export function createMacOSKeychainStore(options: { service?: string } = {}): SecretStore {
  const service = options.service ?? 'Zeus';
  if (service.trim() !== service || service.length < 1 || service.length > 160 || Array.from(service).some((character) => (character.codePointAt(0) ?? 0) <= 31 || character.codePointAt(0) === 127)) {
    throw new Error('Invalid Zeus Keychain service name');
  }
  const run = (args: string[]) => execFileAsync('security', args);
  const validateAccount = (account: string) => {
    if (!/^[a-z0-9_.:-]+$/iu.test(account)) throw new Error('Invalid Zeus Keychain account name');
  };
  const missing = (error: unknown) => error instanceof Error && /could not be found|The specified item could not be found|SecKeychainSearchCopyNext/u.test(error.message);
  return {
    async setSecret(account, value) {
      validateAccount(account);
      await run(['add-generic-password', '-U', '-s', service, '-a', account, '-w', value]);
    },
    async getSecret(account) {
      validateAccount(account);
      try {
        const { stdout } = await run(['find-generic-password', '-s', service, '-a', account, '-w']);
        return stdout.trim() || undefined;
      } catch (error) {
        if (missing(error)) return undefined;
        throw error;
      }
    },
    async deleteSecret(account) {
      validateAccount(account);
      try {
        await run(['delete-generic-password', '-s', service, '-a', account]);
      } catch (error) {
        if (!missing(error)) throw error;
      }
    },
  };
}

export function getSecretPresenceLabel(value: string | undefined): SecretPresenceLabel {
  return value ? { configured: true, label: '已安全保存' } : { configured: false, label: '未配置' };
}
