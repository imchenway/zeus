import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalServer } from '../src/index.js';
import type { SecretStore } from '@zeus/security-core';
import { AuditLogRepository, createZeusDatabase } from '@zeus/storage';

const tmpRoots: string[] = [];

function createMemorySecretStore(): SecretStore & {
  values: Map<string, string>;
} {
  const values = new Map<string, string>();
  return {
    values,
    async setSecret(account, value) {
      values.set(account, value);
    },
    async getSecret(account) {
      return values.get(account);
    },
    async deleteSecret(account) {
      values.delete(account);
    },
  };
}

async function createTmpDb(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'zeus-security-api-'));
  tmpRoots.push(root);
  return join(root, 'zeus.json');
}

afterEach(async () => {
  await Promise.all(tmpRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Security Keychain local API', () => {
  it('stores Telegram token in SecretStore and never returns the token value', async () => {
    const secretStore = createMemorySecretStore();
    const dbPath = await createTmpDb();
    const server = await createLocalServer({
      dbPath,
      apiToken: 'test-token',
      telegramAllowedUserIds: [42],
      secretStore,
    });

    const save = await server.inject({
      method: 'PUT',
      url: '/api/security/secrets/telegram-bot-token',
      headers: { authorization: 'Bearer test-token' },
      payload: { token: 'telegram-token-real' },
    });
    const status = await server.inject({
      method: 'GET',
      url: '/api/security/secrets',
      headers: { authorization: 'Bearer test-token' },
    });
    const runtime = await server.inject({
      method: 'GET',
      url: '/api/settings/runtime-status',
      headers: { authorization: 'Bearer test-token' },
    });
    const visibleAudit = await server.inject({
      method: 'GET',
      url: '/api/security/audit-logs',
      headers: { authorization: 'Bearer test-token' },
    });

    expect(save.statusCode).toBe(200);
    expect(save.body).not.toContain('telegram-token-real');
    expect(secretStore.values.get('telegram.botToken')).toBe('telegram-token-real');
    expect(status.json()).toEqual({
      telegramBotToken: { configured: true, label: '已安全保存' },
      externalApiKey: { configured: false, label: '未配置' },
    });
    expect(status.body).not.toContain('telegram-token-real');
    expect(runtime.json().telegram).toMatchObject({
      enabled: true,
      reason: 'Telegram long polling 可启用。',
    });
    expect(visibleAudit.statusCode).toBe(200);
    expect(visibleAudit.json()[0]).toMatchObject({
      action: 'security.secret.telegram_bot_token.saved',
      resourceType: 'secret',
      resourceId: 'telegram.botToken',
      payload: { configured: true, secretValueStored: false },
    });
    expect(visibleAudit.body).not.toContain('telegram-token-real');
    await server.close();

    const auditLogs = new AuditLogRepository(await createZeusDatabase(dbPath)).listRecent();
    expect(auditLogs.map((entry) => entry.action)).toContain('security.secret.telegram_bot_token.saved');
    expect(JSON.stringify(auditLogs)).not.toContain('telegram-token-real');
  });

  it('stores external API key in SecretStore and never returns the key value', async () => {
    const secretStore = createMemorySecretStore();
    const dbPath = await createTmpDb();
    const server = await createLocalServer({
      dbPath,
      apiToken: 'test-token',
      telegramAllowedUserIds: [42],
      secretStore,
    });

    const save = await server.inject({
      method: 'PUT',
      url: '/api/security/secrets/external-api-key',
      headers: { authorization: 'Bearer test-token' },
      payload: { key: 'external-api-key-real' },
    });
    const status = await server.inject({
      method: 'GET',
      url: '/api/security/secrets',
      headers: { authorization: 'Bearer test-token' },
    });
    const audit = await server.inject({
      method: 'GET',
      url: '/api/security/audit-logs',
      headers: { authorization: 'Bearer test-token' },
    });

    expect(save.statusCode).toBe(200);
    expect(save.json()).toEqual({
      telegramBotToken: { configured: false, label: '未配置' },
      externalApiKey: { configured: true, label: '已安全保存' },
    });
    expect(save.body).not.toContain('external-api-key-real');
    expect(secretStore.values.get('external.apiKey')).toBe('external-api-key-real');
    expect(status.json()).toEqual({
      telegramBotToken: { configured: false, label: '未配置' },
      externalApiKey: { configured: true, label: '已安全保存' },
    });
    expect(audit.json()[0]).toMatchObject({
      action: 'security.secret.external_api_key.saved',
      resourceType: 'secret',
      resourceId: 'external.apiKey',
      payload: { configured: true, secretValueStored: false },
    });
    expect(audit.body).not.toContain('external-api-key-real');

    const cleared = await server.inject({
      method: 'DELETE',
      url: '/api/security/secrets/external-api-key',
      headers: { authorization: 'Bearer test-token' },
    });
    expect(cleared.json()).toEqual({
      telegramBotToken: { configured: false, label: '未配置' },
      externalApiKey: { configured: false, label: '未配置' },
    });
    expect(secretStore.values.has('external.apiKey')).toBe(false);
    await server.close();
  });

  it('stores and clears project database connection secret without exposing the password', async () => {
    const secretStore = createMemorySecretStore();
    const dbPath = await createTmpDb();
    const server = await createLocalServer({
      dbPath,
      apiToken: 'test-token',
      telegramAllowedUserIds: [42],
      secretStore,
    });
    const projectResponse = await server.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        name: 'Zeus',
        localPath: '/Users/david/hypha/zeus',
        description: '真实项目',
      },
    });
    const projectId = projectResponse.json().id;
    await server.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/config`,
      headers: { authorization: 'Bearer test-token' },
      payload: {
        defaultModel: null,
        defaultWorkMode: 'develop',
        defaultTaskPrompt: '',
        scan: { ignoreDirectories: [], indexScope: 'project' },
        language: { primary: 'typescript', additional: [] },
        dependencies: {
          packageManagers: ['pnpm'],
          manifestPaths: ['package.json'],
        },
        database: { connectionName: 'local-postgres', schemaPaths: [] },
        telegram: { alias: null },
        security: { allowShell: false, allowGitWrite: false },
      },
    });

    const saved = await server.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/database/secret`,
      headers: { authorization: 'Bearer test-token' },
      payload: { password: 'db-password-real' },
    });
    const status = await server.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/database/secret`,
      headers: { authorization: 'Bearer test-token' },
    });
    const audit = await server.inject({
      method: 'GET',
      url: '/api/security/audit-logs',
      headers: { authorization: 'Bearer test-token' },
    });

    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({
      connectionName: 'local-postgres',
      password: { configured: true, label: '已安全保存' },
    });
    expect(saved.body).not.toContain('db-password-real');
    expect(secretStore.values.get(`project.${projectId}.database.local-postgres.password`)).toBe('db-password-real');
    expect(status.json()).toEqual({
      connectionName: 'local-postgres',
      password: { configured: true, label: '已安全保存' },
    });
    expect(audit.json()[0]).toMatchObject({
      action: 'security.secret.database_connection_password.saved',
      resourceType: 'secret',
      resourceId: `project.${projectId}.database.local-postgres.password`,
      payload: {
        projectId,
        connectionName: 'local-postgres',
        configured: true,
        secretValueStored: false,
      },
    });
    expect(audit.body).not.toContain('db-password-real');
    const cleared = await server.inject({
      method: 'DELETE',
      url: `/api/projects/${projectId}/database/secret`,
      headers: { authorization: 'Bearer test-token' },
    });
    expect(cleared.json()).toEqual({
      connectionName: 'local-postgres',
      password: { configured: false, label: '未配置' },
    });
    expect(secretStore.values.has(`project.${projectId}.database.local-postgres.password`)).toBe(false);
    await server.close();
  });

  it('resets security settings by clearing secrets, disabling notifications, and writing audit log', async () => {
    const secretStore = createMemorySecretStore();
    secretStore.values.set('telegram.botToken', 'telegram-token-real');
    const dbPath = await createTmpDb();
    const server = await createLocalServer({
      dbPath,
      apiToken: 'test-token',
      telegramAllowedUserIds: [42],
      telegramNotificationChatIds: [1001],
      secretStore,
    });

    const response = await server.inject({
      method: 'POST',
      url: '/api/security/reset',
      headers: { authorization: 'Bearer test-token' },
    });
    const secrets = await server.inject({
      method: 'GET',
      url: '/api/security/secrets',
      headers: { authorization: 'Bearer test-token' },
    });
    const notifications = await server.inject({
      method: 'GET',
      url: '/api/telegram/notification-settings',
      headers: { authorization: 'Bearer test-token' },
    });
    const securitySettings = await server.inject({
      method: 'GET',
      url: '/api/telegram/security-settings',
      headers: { authorization: 'Bearer test-token' },
    });
    const audit = await server.inject({
      method: 'GET',
      url: '/api/security/audit-logs',
      headers: { authorization: 'Bearer test-token' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      secrets: {
        telegramBotToken: { configured: false, label: '未配置' },
        externalApiKey: { configured: false, label: '未配置' },
      },
      telegramNotificationSettings: {
        enabled: false,
        chatIds: [],
        silentMode: true,
      },
      telegramSecuritySettings: { allowedUserIds: [] },
    });
    expect(secretStore.values.has('telegram.botToken')).toBe(false);
    expect(secrets.json()).toEqual({
      telegramBotToken: { configured: false, label: '未配置' },
      externalApiKey: { configured: false, label: '未配置' },
    });
    expect(notifications.json()).toEqual({
      enabled: false,
      chatIds: [],
      silentMode: true,
    });
    expect(securitySettings.json()).toEqual({ allowedUserIds: [] });
    expect(audit.json()[0]).toMatchObject({
      action: 'security.reset.completed',
      resourceType: 'security',
      payload: {
        clearedSecrets: ['telegram.botToken', 'external.apiKey', 'project.database.password'],
        telegramNotificationsDisabled: true,
        telegramAllowedUserIdsCleared: true,
      },
    });
    expect(response.body).not.toContain('telegram-token-real');
    expect(audit.body).not.toContain('telegram-token-real');
    await server.close();
  });
  it('clears Telegram token from SecretStore', async () => {
    const secretStore = createMemorySecretStore();
    secretStore.values.set('telegram.botToken', 'telegram-token-real');
    const dbPath = await createTmpDb();
    const server = await createLocalServer({
      dbPath,
      apiToken: 'test-token',
      telegramAllowedUserIds: [42],
      secretStore,
    });

    const response = await server.inject({
      method: 'DELETE',
      url: '/api/security/secrets/telegram-bot-token',
      headers: { authorization: 'Bearer test-token' },
    });

    expect(response.statusCode).toBe(200);
    expect(secretStore.values.has('telegram.botToken')).toBe(false);
    expect(response.json()).toEqual({
      telegramBotToken: { configured: false, label: '未配置' },
      externalApiKey: { configured: false, label: '未配置' },
    });
    await server.close();

    expect(new AuditLogRepository(await createZeusDatabase(dbPath)).listRecent().map((entry) => entry.action)).toContain('security.secret.telegram_bot_token.deleted');
  });
});
