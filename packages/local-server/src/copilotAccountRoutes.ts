import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { CopilotRuntimeManager } from '@zeus/ai-runtime';
import { userFacingErrorCause } from '@zeus/shared';

/** Copilot 账户和模型目录由 Core 持有；Renderer 只接收授权状态和设备码。 */
export function registerCopilotAccountRoutes(input: { server: FastifyInstance; manager: CopilotRuntimeManager; readOnlyValidation: boolean }): void {
  const { server, manager } = input;

  /** SDK 尚未启动时只报告未知，不因打开设置页启动进程。 */
  server.get('/api/copilot/account', async () => ({ account: manager.readAccount(), models: manager.readModels(), quotas: manager.readQuotas() }));

  /** 用户主动刷新时读取 SDK 实际登录身份及该账号可用模型。 */
  server.post('/api/copilot/account/refresh', async (_request, reply) => {
    if (input.readOnlyValidation) return unavailable(reply);
    try {
      const account = await manager.refreshAccount();
      const models = account.authenticated ? await manager.refreshModels() : [];
      return { account, models, quotas: manager.readQuotas() };
    } catch (cause) {
      console.warn('Copilot account refresh failed', userFacingErrorCause(cause));
      return reply.code(503).send({ error: 'ZEUS_COPILOT_ACCOUNT_UNAVAILABLE', message: 'Copilot 账户状态暂不可用。' });
    }
  });

  /** 设备码登录只创建一次 SDK flow，登录凭据始终留在 SDK 宿主。 */
  server.post('/api/copilot/account/login', async (_request, reply) => {
    if (input.readOnlyValidation) return unavailable(reply);
    try {
      return await manager.beginLogin();
    } catch (cause) {
      console.warn('Copilot sign-in failed', userFacingErrorCause(cause));
      return reply.code(503).send({ error: 'ZEUS_COPILOT_LOGIN_UNAVAILABLE', message: 'Copilot 登录暂不可用。' });
    }
  });

  /** 授权等待只读内存状态，刷新页面不会再次发起 SDK 登录。 */
  server.get('/api/copilot/account/login/:loginId', async (request: FastifyRequest<{ Params: { loginId: string } }>, reply) => {
    const step = manager.readLoginStep(request.params.loginId);
    return step ? { step } : reply.code(404).send({ error: 'ZEUS_COPILOT_LOGIN_NOT_FOUND' });
  });

  /** 推进一次 SDK 登录由 Core 后台完成，HTTP 不等待用户在浏览器确认。 */
  server.post('/api/copilot/account/login/:loginId/advance', async (request: FastifyRequest<{ Params: { loginId: string }; Body: { input?: string } }>, reply) => {
    if (input.readOnlyValidation) return unavailable(reply);
    if (request.body?.input !== undefined && (typeof request.body.input !== 'string' || request.body.input.length > 4_096)) return reply.code(400).send({ error: 'ZEUS_COPILOT_LOGIN_INPUT_INVALID' });
    try {
      return { step: manager.startLoginAdvance(request.params.loginId, request.body?.input) };
    } catch {
      return reply.code(404).send({ error: 'ZEUS_COPILOT_LOGIN_NOT_FOUND' });
    }
  });

  /** 用户取消时终止当前 SDK 授权轮询。 */
  server.post('/api/copilot/account/login/:loginId/cancel', async (request: FastifyRequest<{ Params: { loginId: string } }>, reply) => {
    if (input.readOnlyValidation) return unavailable(reply);
    try {
      await manager.cancelLogin(request.params.loginId);
      return { cancelled: true };
    } catch (cause) {
      console.warn('Copilot sign-in cancellation failed', userFacingErrorCause(cause));
      return reply.code(503).send({ error: 'ZEUS_COPILOT_LOGIN_CANCEL_FAILED' });
    }
  });

  /** 登出后重新读取 SDK 账户事实，旧模型目录立即失效。 */
  server.post('/api/copilot/account/logout', async (_request, reply) => {
    if (input.readOnlyValidation) return unavailable(reply);
    try {
      return { account: await manager.logout(), models: [], quotas: [] };
    } catch (cause) {
      console.warn('Copilot sign-out failed', userFacingErrorCause(cause));
      return reply.code(503).send({ error: 'ZEUS_COPILOT_LOGOUT_FAILED' });
    }
  });
}

/** 只读验证进程不能启动真实 Copilot 进程或修改账户。 */
function unavailable(reply: FastifyReply): FastifyReply {
  return reply.code(409).send({ error: 'ZEUS_COPILOT_READ_ONLY_VALIDATION' });
}
