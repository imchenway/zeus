import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const localHosts = new Set(['127.0.0.1', 'localhost', '::1']);
const execFileAsync = promisify(execFile);

export interface SecretStore {
  setSecret: (account: string, value: string) => Promise<void>;
  getSecret: (account: string) => Promise<string | undefined>;
  deleteSecret: (account: string) => Promise<void>;
}

export interface SecretPresenceLabel {
  configured: boolean;
  label: '已安全保存' | '未配置';
}

export interface MacOSKeychainStoreOptions {
  /** 生产默认保持 `Zeus`；独立测试身份必须传入自己的 service。 */
  service?: string;
}

/** Zeus 本地服务默认只允许本机监听地址。 */
export function isLocalOnlyHost(host: string): boolean {
  return localHosts.has(host);
}

/** 日志脱敏：隐藏常见 token/key/password 形式，避免敏感信息落盘或展示。 */
export function redactSensitiveText(input: string): string {
  return input
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/giu, '[REDACTED SSH PRIVATE KEY]')
    .replace(/\b(authorization)\s*:\s*Bearer\s+[^\s]+/giu, '$1: Bearer [REDACTED]')
    .replace(/\bBearer\s+[^\s]+/giu, 'Bearer [REDACTED]')
    .replace(/\b(cookie)\s*:\s*[^\n\r]+/giu, '$1: [REDACTED]')
    .replace(/\b([A-Z0-9_.-]*(?:token|api[_-]?key|password|secret)[A-Z0-9_.-]*)\s*[:=]\s*("[^"\n\r]*"|'[^'\n\r]*'|[^\s,;]+)/giu, '$1=[REDACTED]');
}

/** 创建 macOS Keychain 适配器；始终调用系统 security 命令。 */
export function createMacOSKeychainStore(options: MacOSKeychainStoreOptions = {}): SecretStore {
  const service = validateKeychainService(options.service ?? 'Zeus');
  return {
    async setSecret(account: string, value: string): Promise<void> {
      validateSecretAccount(account);
      await executeSecurityCommand('security', ['add-generic-password', '-U', '-s', service, '-a', account, '-w', value]);
    },
    async getSecret(account: string): Promise<string | undefined> {
      validateSecretAccount(account);
      try {
        const result = await executeSecurityCommand('security', ['find-generic-password', '-s', service, '-a', account, '-w']);
        const value = result.stdout.trim();
        return value || undefined;
      } catch (error) {
        if (isSecurityItemNotFound(error)) return undefined;
        throw error;
      }
    },
    async deleteSecret(account: string): Promise<void> {
      validateSecretAccount(account);
      try {
        await executeSecurityCommand('security', ['delete-generic-password', '-s', service, '-a', account]);
      } catch (error) {
        if (!isSecurityItemNotFound(error)) throw error;
      }
    },
  };
}

/** 返回可展示状态，不返回密钥本身，避免 token/API key 进入 Renderer 或日志。 */
export function getSecretPresenceLabel(value: string | undefined): SecretPresenceLabel {
  return value ? { configured: true, label: '已安全保存' } : { configured: false, label: '未配置' };
}

async function executeSecurityCommand(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync(command, args);
  return { stdout, stderr };
}

function validateSecretAccount(account: string): void {
  if (!/^[a-z0-9_.:-]+$/iu.test(account)) {
    throw new Error('Invalid Zeus Keychain account name');
  }
}

function validateKeychainService(service: string): string {
  if (service.trim() !== service || service.length < 1 || service.length > 160 || Array.from(service).some(isControlCharacter)) {
    throw new Error('Invalid Zeus Keychain service name');
  }
  return service;
}

function isControlCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0) ?? 0;
  return codePoint <= 31 || codePoint === 127;
}

function isSecurityItemNotFound(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /could not be found|The specified item could not be found|SecKeychainSearchCopyNext/u.test(error.message);
}
