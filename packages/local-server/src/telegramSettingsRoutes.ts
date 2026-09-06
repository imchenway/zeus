import type {SettingRepository} from '@zeus/storage';
import type {FastifyInstance, FastifyReply, FastifyRequest} from 'fastify';
import {
    createTelegramBotMessageClient,
    dispatchTelegramUpdate,
    getTelegramConfigurationState,
    type TelegramMessageSender,
    type TelegramPollingService,
    type TelegramUpdate
} from './telegramAdapter.js';
import {
    telegramChildOperation,
    telegramCommandTypes,
    type TelegramCommandApplication,
    type TelegramCommandRequest
} from './telegramCommandApplication.js';
import type {
    TelegramDispatchPreviewBody,
    TelegramNotificationSettingsSnapshot,
    TelegramSecuritySettingsSnapshot,
    TelegramSettingsSnapshot,
    TelegramStatusSnapshot,
    TelegramTestConnectionResult,
    UpdateTelegramNotificationSettingsBody,
    UpdateTelegramSecuritySettingsBody,
    UpdateTelegramSettingsBody,
} from './index.js';

/** Telegram 设置、连接测试、派发预览与状态查询路由；命令语义归属 TelegramCommandApplication，路由装配归属本模块。 */
export function registerTelegramSettingsRoutes(options: {
    server: FastifyInstance;
    telegramCommands: TelegramCommandApplication;
    assertTelegramCommandInputKeys: (value: object, allowedKeys: readonly string[]) => void;
    parseTelegramNotificationSettingsInput: (value: UpdateTelegramNotificationSettingsBody, fallback: TelegramNotificationSettingsSnapshot) => TelegramNotificationSettingsSnapshot;
    parseTelegramSecuritySettingsInput: (value: UpdateTelegramSecuritySettingsBody, fallback: TelegramSecuritySettingsSnapshot) => TelegramSecuritySettingsSnapshot;
    parseTelegramDispatchPreviewInput: (value: TelegramDispatchPreviewBody) => TelegramUpdate;
    platformMutableState: {
        telegramNotificationSettings: TelegramNotificationSettingsSnapshot;
        telegramSecuritySettings: TelegramSecuritySettingsSnapshot;
        telegramPollingTimer: ReturnType<typeof setInterval> | undefined;
        telegramPollingService: TelegramPollingService | undefined;
    };
    settings: SettingRepository;
    telegramNotificationSettingsKey: string;
    telegramSecuritySettingsKey: string;
    appendAuditLog: (entry: {
        actorType: string;
        action: string;
        resourceType: string;
        resourceId: string;
        payload: Record<string, unknown>
    }) => void;
    readTelegramToken: () => Promise<string | undefined>;
    now: () => Date;
    getTelegramPollingService: () => TelegramPollingService | undefined;
    redactSensitiveText: (value: string) => { text: string; redacted: boolean };
    isExplicitTelegramApiRejection: (error: unknown) => boolean;
    sendTelegramCommandRouteError: (reply: FastifyReply, error: unknown) => unknown;
    telegramCommandRouteError: (code: string, message: string, statusCode: number) => Error;
}): void {
    const {
        server,
        telegramCommands,
        assertTelegramCommandInputKeys,
        parseTelegramNotificationSettingsInput,
        parseTelegramSecuritySettingsInput,
        parseTelegramDispatchPreviewInput,
        platformMutableState,
        settings,
        telegramNotificationSettingsKey,
        telegramSecuritySettingsKey,
        appendAuditLog,
        readTelegramToken,
        now,
        getTelegramPollingService,
        redactSensitiveText,
        isExplicitTelegramApiRejection,
        sendTelegramCommandRouteError,
        telegramCommandRouteError,
    } = options;

    server.get('/api/telegram/notification-settings', async (): Promise<TelegramNotificationSettingsSnapshot> => platformMutableState.telegramNotificationSettings);

    server.put('/api/telegram/notification-settings', async (request: FastifyRequest<{
        Body: TelegramCommandRequest<UpdateTelegramNotificationSettingsBody>
    }>, reply) => {
        try {
            const parsed = telegramCommands.parse<UpdateTelegramNotificationSettingsBody>({
                value: request.body,
                commandType: telegramCommandTypes.notificationSettingsUpdate,
                scopeId: 'telegram.notification-settings'
            });
            assertTelegramCommandInputKeys(parsed.input, ['enabled', 'chatIds', 'silentMode']);
            const next = parseTelegramNotificationSettingsInput(parsed.input, platformMutableState.telegramNotificationSettings);
            const execution = telegramCommands.executeCore({
                parsed,
                destinationId: 'telegram-settings-core',
                resourceId: 'telegram.notification-settings',
                mutateBusinessState: () => {
                    platformMutableState.telegramNotificationSettings = next;
                    settings.setJson(telegramNotificationSettingsKey, next);
                    appendAuditLog({
                        actorType: 'local_api',
                        action: 'telegram.notification_settings.updated',
                        resourceType: 'telegram',
                        resourceId: 'notification-settings',
                        payload: {enabled: next.enabled, silentMode: next.silentMode, chatIdCount: next.chatIds.length},
                    });
                    return next;
                },
            });
            return execution.result;
        } catch (error) {
            return sendTelegramCommandRouteError(reply, error);
        }
    });

    server.post('/api/telegram/test', async (request: FastifyRequest<{
        Body: TelegramCommandRequest<Record<string, never>>
    }>, reply): Promise<TelegramTestConnectionResult | unknown> => {
        try {
            const parsed = telegramCommands.parse<Record<string, never>>({
                value: request.body,
                commandType: telegramCommandTypes.connectionTest,
                scopeId: 'telegram.connection-test'
            });
            assertTelegramCommandInputKeys(parsed.input, []);
            const chatIds = [...platformMutableState.telegramNotificationSettings.chatIds];
            let sender: TelegramMessageSender | undefined;
            const sentAt = now().toISOString();
            const text = ['Zeus Telegram 测试连接', `时间：${sentAt}`, '这是一条由用户主动触发的真实连接测试，不包含 Token、命令明文或终端输出。'].join('\n');
            const execution = await telegramCommands.executeExternal({
                parsed,
                destinationId: 'telegram-send-message',
                resourceId: 'telegram.connection-test',
                children: [telegramChildOperation(parsed.operationIdentity, 'telegram_configuration_check'), ...chatIds.map((_chatId, index) => telegramChildOperation(parsed.operationIdentity, `send_message_${index}`))],
                beforeWrite: async () => {
                    const token = await readTelegramToken();
                    if (!token || chatIds.length === 0) throw telegramCommandRouteError('ZEUS_TELEGRAM_UNCONFIGURED', 'Telegram Bot Token 或通知 Chat ID 未配置。', 400);
                    sender = createTelegramBotMessageClient({token});
                },
                invoke: async () => {
                    for (const chatId of chatIds) await sender!.sendMessage(chatId, text);
                    return {ok: true, chatIds, attempts: 1, sentAt};
                },
                mutateAcceptedBusinessState: () => {
                    appendAuditLog({
                        actorType: 'local_api',
                        action: 'telegram.test.sent',
                        resourceType: 'telegram',
                        resourceId: 'notification-settings',
                        payload: {chatIdCount: chatIds.length, attempts: 1, sentAt},
                    });
                },
                mutateFailureBusinessState: (outcome, error) => {
                    appendAuditLog({
                        actorType: 'local_api',
                        action: 'telegram.test.failed',
                        resourceType: 'telegram',
                        resourceId: 'notification-settings',
                        payload: {
                            chatIdCount: chatIds.length,
                            outcome,
                            error: redactSensitiveText(error instanceof Error ? error.message : String(error)).text.slice(0, 2_048),
                            sentAt
                        },
                    });
                },
                isExplicitRejection: isExplicitTelegramApiRejection,
            });
            return execution.result;
        } catch (error) {
            return sendTelegramCommandRouteError(reply, error);
        }
    });

    server.get('/api/telegram/security-settings', async (): Promise<TelegramSecuritySettingsSnapshot> => platformMutableState.telegramSecuritySettings);

    server.put('/api/telegram/security-settings', async (request: FastifyRequest<{
        Body: TelegramCommandRequest<UpdateTelegramSecuritySettingsBody>
    }>, reply) => {
        try {
            const parsed = telegramCommands.parse<UpdateTelegramSecuritySettingsBody>({
                value: request.body,
                commandType: telegramCommandTypes.securitySettingsUpdate,
                scopeId: 'telegram.security-settings'
            });
            assertTelegramCommandInputKeys(parsed.input, ['allowedUserIds']);
            const next = parseTelegramSecuritySettingsInput(parsed.input, platformMutableState.telegramSecuritySettings);
            const execution = await telegramCommands.executeExternal({
                parsed,
                destinationId: 'telegram-security-settings',
                resourceId: 'telegram.security-settings',
                children: [telegramChildOperation(parsed.operationIdentity, 'polling_timer_stop'), telegramChildOperation(parsed.operationIdentity, 'polling_service_stop')],
                invoke: async () => {
                    if (platformMutableState.telegramPollingTimer) clearInterval(platformMutableState.telegramPollingTimer);
                    platformMutableState.telegramPollingTimer = undefined;
                    if (platformMutableState.telegramPollingService) await platformMutableState.telegramPollingService.stop();
                    platformMutableState.telegramPollingService = undefined;
                    return next;
                },
                mutateAcceptedBusinessState: () => {
                    platformMutableState.telegramSecuritySettings = next;
                    settings.setJson(telegramSecuritySettingsKey, next);
                    appendAuditLog({
                        actorType: 'local_api',
                        action: 'telegram.security_settings.updated',
                        resourceType: 'telegram',
                        resourceId: 'security-settings',
                        payload: {allowedUserIdsCount: next.allowedUserIds.length},
                    });
                },
            });
            return execution.result;
        } catch (error) {
            return sendTelegramCommandRouteError(reply, error);
        }
    });

    server.post('/api/telegram/dispatch-preview', async (request: FastifyRequest<{
        Body: TelegramCommandRequest<TelegramDispatchPreviewBody>
    }>, reply) => {
        try {
            const parsed = telegramCommands.parse<TelegramDispatchPreviewBody>({
                value: request.body,
                commandType: telegramCommandTypes.dispatchPreview,
                scopeId: 'telegram.dispatch-preview'
            });
            const update = parseTelegramDispatchPreviewInput(parsed.input);
            const execution = await telegramCommands.executeExternal({
                parsed,
                destinationId: 'telegram-dispatch-preview',
                resourceId: 'telegram.dispatch-preview',
                children: [telegramChildOperation(parsed.operationIdentity, 'keychain_token_presence_read'), telegramChildOperation(parsed.operationIdentity, 'telegram_update_dispatch')],
                beforeWrite: async () => {
                    if (!(await readTelegramToken())) throw telegramCommandRouteError('ZEUS_TELEGRAM_UNCONFIGURED', 'Telegram Bot Token 未配置。', 400);
                },
                invoke: async () => dispatchTelegramUpdate(update, {allowedUserIds: platformMutableState.telegramSecuritySettings.allowedUserIds}),
            });
            return execution.result;
        } catch (error) {
            return sendTelegramCommandRouteError(reply, error);
        }
    });

    server.get('/api/telegram/status', async (): Promise<TelegramStatusSnapshot> => {
        const state = getTelegramConfigurationState(await readTelegramToken(), platformMutableState.telegramSecuritySettings.allowedUserIds);
        return {
            configured: state.enabled,
            reason: state.reason,
            polling: getTelegramPollingService()?.status() ?? {
                running: false,
                offset: 0,
                lastError: null,
                handledUpdates: 0,
                lastSuccessfulPollAt: null,
            },
            notificationSettings: platformMutableState.telegramNotificationSettings,
            securitySettings: platformMutableState.telegramSecuritySettings,
        };
    });

    server.patch('/api/telegram/settings', async (request: FastifyRequest<{
        Body: TelegramCommandRequest<UpdateTelegramSettingsBody>
    }>, reply): Promise<TelegramSettingsSnapshot | unknown> => {
        try {
            const parsed = telegramCommands.parse<UpdateTelegramSettingsBody>({
                value: request.body,
                commandType: telegramCommandTypes.settingsUpdate,
                scopeId: 'telegram.settings'
            });
            assertTelegramCommandInputKeys(parsed.input, ['enabled', 'chatIds', 'silentMode', 'allowedUserIds']);
            const nextNotificationSettings = parseTelegramNotificationSettingsInput(parsed.input, platformMutableState.telegramNotificationSettings);
            const nextSecuritySettings = parseTelegramSecuritySettingsInput(parsed.input, platformMutableState.telegramSecuritySettings);
            const execution = await telegramCommands.executeExternal({
                parsed,
                destinationId: 'telegram-settings-composite',
                resourceId: 'telegram.settings',
                children: [telegramChildOperation(parsed.operationIdentity, 'polling_timer_stop'), telegramChildOperation(parsed.operationIdentity, 'polling_service_stop')],
                invoke: async () => {
                    if (platformMutableState.telegramPollingTimer) clearInterval(platformMutableState.telegramPollingTimer);
                    platformMutableState.telegramPollingTimer = undefined;
                    if (platformMutableState.telegramPollingService) await platformMutableState.telegramPollingService.stop();
                    platformMutableState.telegramPollingService = undefined;
                    return {notificationSettings: nextNotificationSettings, securitySettings: nextSecuritySettings};
                },
                mutateAcceptedBusinessState: () => {
                    platformMutableState.telegramNotificationSettings = nextNotificationSettings;
                    platformMutableState.telegramSecuritySettings = nextSecuritySettings;
                    settings.setJson(telegramNotificationSettingsKey, nextNotificationSettings);
                    settings.setJson(telegramSecuritySettingsKey, nextSecuritySettings);
                    appendAuditLog({
                        actorType: 'local_api',
                        action: 'telegram.settings.updated',
                        resourceType: 'telegram',
                        resourceId: 'settings',
                        payload: {
                            chatIdCount: nextNotificationSettings.chatIds.length,
                            allowedUserIdsCount: nextSecuritySettings.allowedUserIds.length,
                            enabled: nextNotificationSettings.enabled,
                            silentMode: nextNotificationSettings.silentMode,
                        },
                    });
                },
            });
            return execution.result;
        } catch (error) {
            return sendTelegramCommandRouteError(reply, error);
        }
    });
}
