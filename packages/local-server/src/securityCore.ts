import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface SecretStore {
  setSecret(account: string, value: string): Promise<void>;
  getSecret(account: string): Promise<string | undefined>;
  deleteSecret(account: string): Promise<void>;
}

export interface SecretPresenceLabel {
  configured: boolean;
  label: '已安全保存' | '未配置';
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
