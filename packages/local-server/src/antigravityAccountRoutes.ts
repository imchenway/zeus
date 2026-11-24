import type { FastifyInstance } from 'fastify';
import type { AntigravityRuntimeDriver } from '@zeus/ai-runtime';
import type { SettingRepository } from '@zeus/storage';

/** 上次已通过官方 CLI 账号检查的接入在下次启动时重新读目录。 */
const enabledSetting = 'antigravity.google-account-enabled';

/** 授权只通过 agy 启动，设置页读取脱敏状态和当前模型目录。 */
export function registerAntigravityAccountRoutes(options: { server: FastifyInstance; driver: AntigravityRuntimeDriver | null; settings: Pick<SettingRepository, 'getJson' | 'setJson'>; persist: () => Promise<void> }): void {
  const { server, driver } = options;

  /** 只记录用户启用接入的选择，Google 凭据留在 agy。 */
  async function rememberConnection(): Promise<void> {
    if (driver?.readAccount().status !== 'ready' || options.settings.getJson(enabledSetting) === true) return;
    options.settings.setJson(enabledSetting, true);
    await options.persist();
  }

  if (driver && options.settings.getJson(enabledSetting) === true) {
    server.addHook('onReady', async () => {
      void driver.restoreGoogleAccount();
    });
  }
  server.get('/api/antigravity/account', async () => driver?.readAccount() ?? { status: 'unavailable', models: [] });
  server.post('/api/antigravity/account/refresh', async (_request, reply) => {
    if (!driver) return reply.code(409).send({ error: 'ZEUS_AGY_UNAVAILABLE' });
    const catalog = await driver.refreshAccount();
    await rememberConnection();
    return catalog;
  });
  server.post('/api/antigravity/account/login', async (_request, reply) => {
    if (!driver) return reply.code(409).send({ error: 'ZEUS_AGY_UNAVAILABLE' });
    const catalog = driver.beginLogin();
    void driver
      .refreshAccount()
      .then(rememberConnection)
      .catch(() => undefined);
    return catalog;
  });
  server.post('/api/antigravity/account/cancel', async (_request, reply) => {
    if (!driver) return reply.code(409).send({ error: 'ZEUS_AGY_UNAVAILABLE' });
    return driver.cancelLogin();
  });
}
