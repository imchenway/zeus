import type { FastifyInstance } from 'fastify';
import type { AntigravityRuntimeDriver } from '@zeus/ai-runtime';
import type { SettingRepository } from '@zeus/storage';

/** 上次已通过官方 CLI 账号检查的接入在下次启动时重新读目录。 */
const enabledSetting = 'antigravity.google-account-enabled';

/** 授权只通过 agy 启动，设置页读取脱敏状态和当前模型目录。 */
export function registerAntigravityAccountRoutes(options: { server: FastifyInstance; driver: AntigravityRuntimeDriver | null; settings: Pick<SettingRepository, 'getJson' | 'setJson'>; persist: () => Promise<void> }): void {
  const { server, driver } = options;

  /** 保存 Zeus 启动时是否恢复 Antigravity 接入。 */
  async function setRestoreEnabled(enabled: boolean): Promise<void> {
    const previous = options.settings.getJson(enabledSetting) === true;
    if (previous === enabled) return;
    options.settings.setJson(enabledSetting, enabled);
    try {
      await options.persist();
    } catch (error) {
      options.settings.setJson(enabledSetting, previous);
      throw error;
    }
  }

  /** 授权后保留 Zeus 的接入选择，待验证账号也可在下次启动时继续。 */
  async function rememberConnection(): Promise<void> {
    const status = driver?.readAccount().status;
    if (status === 'ready' || status === 'verification_required') await setRestoreEnabled(true);
  }

  if (driver && options.settings.getJson(enabledSetting) === true) {
    server.addHook('onReady', async () => {
      void driver.restoreGoogleAccount();
    });
  }
  server.get('/api/antigravity/account', async () => driver?.readAccount() ?? { status: 'unavailable', models: [] });
  /** 只为用户主动打开验证页面返回当前链接，禁止缓存。 */
  server.get('/api/antigravity/account/verification', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { url: driver?.readVerificationUrl() ?? null };
  });
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
  /** 退出当前 Zeus 的账号接入。 */
  server.post('/api/antigravity/account/logout', async (_request, reply) => {
    if (!driver) return reply.code(409).send({ error: 'ZEUS_AGY_UNAVAILABLE' });
    try {
      return await driver.logoutAccount(() => setRestoreEnabled(false));
    } catch (cause) {
      if (cause instanceof Error && 'code' in cause && cause.code === 'ZEUS_AGY_BUSY') return reply.code(409).send({ error: cause.code, message: cause.message });
      return reply.code(503).send({ error: 'ZEUS_AGY_LOGOUT_FAILED', message: '暂时无法退出 Antigravity，请重试。' });
    }
  });
}
