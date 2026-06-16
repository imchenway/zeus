import { describe, expect, it } from 'vitest';
import { createMacOSKeychainStore, getSecretPresenceLabel } from '../src/index.js';

describe('macOS Keychain adapter', () => {
  it('writes, reads, and deletes secrets through the macOS security command contract', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const store = createMacOSKeychainStore({
      service: 'Zeus',
      execute: async (command, args) => {
        calls.push({ command, args });
        if (args[0] === 'find-generic-password') return { stdout: 'telegram-token-real\n', stderr: '' };
        return { stdout: '', stderr: '' };
      },
    });

    await store.setSecret('telegram.botToken', 'telegram-token-real');
    await expect(store.getSecret('telegram.botToken')).resolves.toBe('telegram-token-real');
    await store.deleteSecret('telegram.botToken');

    expect(calls.map((call) => [call.command, ...call.args])).toEqual([
      ['security', 'add-generic-password', '-U', '-s', 'Zeus', '-a', 'telegram.botToken', '-w', 'telegram-token-real'],
      ['security', 'find-generic-password', '-s', 'Zeus', '-a', 'telegram.botToken', '-w'],
      ['security', 'delete-generic-password', '-s', 'Zeus', '-a', 'telegram.botToken'],
    ]);
  });

  it('returns secret presence labels without exposing secret values', () => {
    expect(getSecretPresenceLabel('telegram-token-real')).toEqual({
      configured: true,
      label: '已安全保存',
    });
    expect(getSecretPresenceLabel(undefined)).toEqual({
      configured: false,
      label: '未配置',
    });
  });
});
