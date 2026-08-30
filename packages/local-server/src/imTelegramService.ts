import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, relative, resolve } from 'node:path';
import {
  canonicalCommandInputJson,
  commandEnvelopeSchemaGeneration,
  imAttachmentLimits,
  parseCanonicalRequestUserInputQuestions,
  type CanonicalRequestUserInputQuestion,
  type ImAgentPresetRef,
  type ImConnectionHealth,
  type ImConnectionSnapshot,
  type ImPairingSessionSnapshot,
  type ImSettingsSnapshot,
  type ImTelegramConnectionCreated,
  type ImTelegramConnectionLogEntry,
} from '@zeus/shared';
import {
  ImRepository,
  type DigitalEmployeeRecord,
  type ImConnectionRecord,
  type ImTrustedEndpointRecord,
  type ZeusConversationPlanActionRecord,
  type ZeusConversationRecord,
  type ZeusConversationServerRequestRecord,
  type ZeusProjectRecord,
  type ZeusTaskRecord,
} from '@zeus/storage';
import type { SecretStore } from '@zeus/security-core';
import {
  createTelegramBotMessageClient,
  createTelegramLongPollingClient,
  createTelegramPollingService,
  downloadTelegramRemoteFile,
  getTelegramBotProfile,
  getTelegramRemoteFile,
  TelegramApiRejectedError,
  type TelegramCommandResponse,
  type TelegramInboundAttachment,
  type TelegramMessageSender,
  type TelegramPollingService,
  type TelegramUpdate,
} from '@zeus/telegram-adapter';
import { telegramChildOperation, TelegramCommandApplication, telegramCommandTypes } from './telegramCommandApplication.js';

const pairingLifetimeMs = 10 * 60 * 1_000;
const interactionLifetimeMs = 10 * 60 * 1_000;
const onlinePollWindowMs = 90 * 1_000;
const synchronizationIntervalMs = 2_000;
const telegramLongMessageLimit = 3_900;
const imChannels: ImSettingsSnapshot['channels'] = [
  { id: 'wechat', name: '微信', availability: 'unsupported' },
  { id: 'feishu', name: '飞书', availability: 'unsupported' },
  { id: 'dingtalk', name: '钉钉', availability: 'unsupported' },
  { id: 'wecom', name: '企业微信', availability: 'unsupported' },
  { id: 'qq', name: 'QQ', availability: 'unsupported' },
  { id: 'slack', name: 'Slack', availability: 'unsupported' },
  { id: 'telegram', name: 'Telegram', availability: 'available' },
  { id: 'discord', name: 'Discord', availability: 'unsupported' },
  { id: 'whatsapp', name: 'WhatsApp', availability: 'unsupported' },
  { id: 'ai_office', name: 'AI Office', availability: 'unsupported' },
];

interface ImInteractionDraft {
  requestId: string;
  answers: Record<string, string[]>;
}

type ImPendingTextAction = { kind: 'request_user_input'; conversationId: string; requestId: string; questionId: string; customOther: boolean } | { kind: 'plan_refinement'; conversationId: string; requestId: string };

export interface ImTelegramPresetSnapshot {
  ref: ImAgentPresetRef;
  name: string;
  agentKind: 'codex' | 'pi';
  model: string | null;
  reasoningEffort: string | null;
  permissionMode: 'read-only' | 'auto' | 'full-access';
  workMode: 'default' | 'plan';
  prompt: string;
  skillId: string | null;
}

export interface ImDownloadedAttachment {
  name: string;
  mime: string;
  size: number;
  localPath: string;
}

export interface ImConversationOutboundResource {
  id: string;
  displayName: string;
  mime: string;
  localPath: string;
}

export interface ImConversationOutboundItem {
  id: string;
  sequence: number;
  text: string;
  resources: ImConversationOutboundResource[];
  resourceFailures: number;
}

export interface ImTaskNotification {
  sequence: number;
  eventType: string;
  title: string;
  createdAt: string;
}

export interface ImTelegramBridgeOperations {
  listConversations(projectId: string): ZeusConversationRecord[];
  createProjectConversation(input: { project: ZeusProjectRecord; content: string; attachments: ImDownloadedAttachment[]; preset: ImTelegramPresetSnapshot; operationIdentity: string }): Promise<{ conversationId: string }>;
  sendConversationMessage(input: { projectId: string; conversationId: string; content: string; attachments: ImDownloadedAttachment[]; delivery: 'queue' | 'steer_now'; operationIdentity: string }): Promise<void>;
  interruptConversation(input: { projectId: string; conversationId: string; operationIdentity: string }): Promise<boolean>;
  resumeConversation(input: { projectId: string; conversationId: string; operationIdentity: string }): Promise<boolean>;
  readConversationOutput(input: { projectId: string; conversationId: string; afterSequence: number }): Promise<ImConversationOutboundItem[]>;
  listPendingRequests(input: { projectId: string; conversationId: string }): ZeusConversationServerRequestRecord[];
  getPendingRequest(input: { projectId: string; conversationId: string; requestId: string }): ZeusConversationServerRequestRecord | undefined;
  respondToRequest(input: { projectId: string; conversationId: string; requestId: string; response: Record<string, unknown>; operationIdentity: string }): Promise<void>;
  getPendingPlan(input: { projectId: string; conversationId: string }): ZeusConversationPlanActionRecord | undefined;
  getPlan(input: { projectId: string; conversationId: string; requestId: string }): ZeusConversationPlanActionRecord | undefined;
  respondToPlan(input: { projectId: string; conversationId: string; requestId: string; action: 'implement' | 'refine' | 'dismiss'; feedback?: string; operationIdentity: string }): Promise<void>;
  readTaskNotifications(input: { projectId: string; taskId: string; afterSequence: number }): ImTaskNotification[];
  readTaskAttachments(task: ZeusTaskRecord): ImDownloadedAttachment[];
  listTasks(projectId: string): ZeusTaskRecord[];
  getTask(taskId: string): ZeusTaskRecord | undefined;
  createTask(input: { projectId: string; title: string; attachments: ImDownloadedAttachment[]; operationIdentity: string }): Promise<ZeusTaskRecord>;
  updateTask(input: { task: ZeusTaskRecord; field: 'title' | 'description'; value: string; attachments: ImDownloadedAttachment[]; operationIdentity: string }): Promise<ZeusTaskRecord>;
  updateTaskStatus(input: { task: ZeusTaskRecord; managementStatus: string; operationIdentity: string }): Promise<ZeusTaskRecord>;
  controlTask(input: { task: ZeusTaskRecord; action: 'run' | 'pause' | 'continue' | 'cancel'; operationIdentity: string }): Promise<ZeusTaskRecord>;
  pushTask(input: { task: ZeusTaskRecord; content: string; preset: ImTelegramPresetSnapshot; operationIdentity: string }): Promise<{ conversationId: string }>;
}

export class ImTelegramService {
  private pollingService: TelegramPollingService | undefined;
  private pollingTimer: ReturnType<typeof setInterval> | undefined;
  private synchronizationTimer: ReturnType<typeof setInterval> | undefined;
  private sender: TelegramMessageSender | undefined;
  private pollInFlight = false;
  private synchronizationInFlight = false;
  private readonly pairingPlaintext = new Map<string, string>();
  private readonly interactionDrafts = new Map<string, ImInteractionDraft>();
  private readonly pendingTextActions = new Map<string, ImPendingTextAction>();
  private readonly chatDeliveryTails = new Map<string, Promise<void>>();

  constructor(
    private readonly options: {
      repository: ImRepository;
      secretStore: SecretStore;
      telegramCommands: TelegramCommandApplication;
      projects: { getById(id: string): ZeusProjectRecord | undefined; list(): ZeusProjectRecord[] };
      digitalEmployees: { getById(id: string): DigitalEmployeeRecord | undefined; listByProject(projectId: string): DigitalEmployeeRecord[] };
      operations: ImTelegramBridgeOperations;
      conversationAttachmentRoot?: string;
      taskAttachmentRoot?: string;
      now(): Date;
      redactSensitiveText(value: string): { text: string };
      save(): Promise<void>;
      readLegacyToken(): Promise<string | undefined>;
      clearLegacyToken(): Promise<void>;
    },
  ) {}

  async restore(): Promise<void> {
    const connection = this.options.repository.getConnectionByChannel('telegram');
    if (!connection) return;
    const token = await this.readToken(connection.id);
    if (!token) {
      this.options.repository.markChecked(connection.id, { now: this.nowIso(), error: 'Keychain 中没有该连接的 Token。' });
      await this.options.save();
      return;
    }
    await this.startPolling(connection, token);
  }

  async close(): Promise<void> {
    if (this.pollingTimer) clearInterval(this.pollingTimer);
    if (this.synchronizationTimer) clearInterval(this.synchronizationTimer);
    this.pollingTimer = undefined;
    this.synchronizationTimer = undefined;
    await this.pollingService?.stop();
    this.pollingService = undefined;
    this.sender = undefined;
    this.pairingPlaintext.clear();
    this.interactionDrafts.clear();
    this.pendingTextActions.clear();
  }

  async settingsSnapshot(): Promise<ImSettingsSnapshot & { legacyTelegramTokenPending: boolean }> {
    return {
      channels: imChannels,
      connections: this.options.repository.listConnections().flatMap((record) => {
        const snapshot = this.toConnectionSnapshot(record);
        return snapshot ? [snapshot] : [];
      }),
      legacyTelegramTokenPending: Boolean(await this.options.readLegacyToken()),
    };
  }

  selectionOptions(): Array<{ id: string; name: string; presets: Array<{ ref: ImAgentPresetRef; name: string }> }> {
    return this.options.projects.list().map((project) => ({
      id: project.id,
      name: project.name,
      presets: [
        { ref: { kind: 'zeus_default', digitalEmployeeId: null }, name: '跟随 Zeus 默认' },
        ...this.options.digitalEmployees
          .listByProject(project.id)
          .filter((employee) => employee.enabled && employee.agentKind === 'codex')
          .map((employee) => ({ ref: { kind: 'digital_employee' as const, digitalEmployeeId: employee.id }, name: employee.name })),
      ],
    }));
  }

  createInputAllowed(input: { projectId: string; agentPreset: ImAgentPresetRef }): { project: ZeusProjectRecord; preset: ImTelegramPresetSnapshot } {
    if (this.options.repository.getConnectionByChannel('telegram')) throw imError('ZEUS_IM_CONNECTION_EXISTS', 'Telegram 已有接入；请先移除现有连接。', 409);
    const project = this.options.projects.getById(input.projectId);
    if (!project) throw imError('ZEUS_IM_PROJECT_NOT_FOUND', '所选 Zeus 项目不存在或不可用。', 404);
    return { project, preset: this.resolvePreset(project.id, input.agentPreset) };
  }

  async createConnection(input: { connectionId: string; projectId: string; agentPreset: ImAgentPresetRef; botToken?: string; useLegacyToken?: boolean }): Promise<{ connection: ImConnectionSnapshot; pairingId: string }> {
    const prepared = this.createInputAllowed(input);
    const token = input.useLegacyToken ? await this.options.readLegacyToken() : input.botToken?.trim();
    if (!token) throw imError('ZEUS_IM_TOKEN_REQUIRED', '请输入 BotFather Token。', 400);
    if (!/^\d{5,20}:[A-Za-z0-9_-]{20,128}$/u.test(token)) throw imError('ZEUS_IM_TOKEN_FORMAT_INVALID', 'BotFather Token 格式无效。', 400);
    const profile = await getTelegramBotProfile({ token });
    const now = this.nowIso();
    await this.options.secretStore.setSecret(imTelegramTokenAccount(input.connectionId), token);
    const connection = this.options.repository.createConnection({
      id: input.connectionId,
      projectId: prepared.project.id,
      agentPreset: prepared.preset.ref,
      botId: String(profile.id),
      botUsername: profile.username,
      botDisplayName: profile.firstName,
      now,
    });
    const pairing = this.createPairing(connection);
    this.options.repository.appendLog({ connectionId: connection.id, level: 'info', event: 'connection.created', message: `已通过 getMe 验证 @${profile.username}，等待私聊配对。`, now });
    await this.options.save();
    if (input.useLegacyToken) await this.options.clearLegacyToken();
    await this.startPolling(connection, token);
    return { connection: this.requireSnapshot(connection), pairingId: pairing.id };
  }

  pairingResponse(connection: ImConnectionSnapshot, pairingId: string): ImTelegramConnectionCreated {
    const pairing = this.requirePairingSnapshot(pairingId);
    return { connection, pairing };
  }

  async repair(connectionId: string): Promise<{ connection: ImConnectionSnapshot; pairingId: string }> {
    const connection = this.requireConnection(connectionId);
    if (!(await this.readToken(connection.id))) throw imError('ZEUS_IM_TOKEN_MISSING', '该连接的 Keychain Token 已不存在，请移除后重新接入。', 409);
    this.options.repository.beginRepair(connection.id, this.nowIso());
    this.interactionDrafts.clear();
    this.pendingTextActions.clear();
    const pairing = this.createPairing(this.requireConnection(connection.id));
    this.options.repository.appendLog({ connectionId, level: 'info', event: 'pairing.regenerated', message: '已撤销旧配对码并生成新的 10 分钟单次配对会话。', now: this.nowIso() });
    await this.options.save();
    return { connection: this.requireSnapshot(this.requireConnection(connectionId)), pairingId: pairing.id };
  }

  pairingStatus(connectionId: string): { connection: ImConnectionSnapshot; pairing: ImPairingSessionSnapshot | null } {
    const connection = this.requireConnection(connectionId);
    const pairing = this.options.repository.getLatestPairing(connection.id);
    const pairingSnapshot = pairing && this.pairingPlaintext.has(pairing.id) ? this.toPairingSnapshot(pairing.id, pairing.connectionId, pairing.expiresAt, Boolean(pairing.consumedAt)) : null;
    return { connection: this.requireSnapshot(connection), pairing: pairingSnapshot };
  }

  async check(connectionId: string): Promise<ImConnectionSnapshot> {
    const connection = this.requireConnection(connectionId);
    const token = await this.readToken(connection.id);
    if (!token) throw imError('ZEUS_IM_TOKEN_MISSING', '该连接的 Keychain Token 已不存在。', 409);
    try {
      const profile = await getTelegramBotProfile({ token });
      const updated = this.options.repository.markChecked(connection.id, { now: this.nowIso(), botId: String(profile.id), botUsername: profile.username, botDisplayName: profile.firstName });
      this.options.repository.appendLog({ connectionId, level: 'info', event: 'connection.checked', message: 'getMe 校验成功。', now: this.nowIso() });
      await this.options.save();
      if (!this.pollingService?.status().running) await this.startPolling(updated, token);
      return this.requireSnapshot(updated);
    } catch (error) {
      const message = boundedError(error, this.options.redactSensitiveText);
      this.options.repository.markChecked(connection.id, { now: this.nowIso(), error: message });
      this.options.repository.appendLog({ connectionId, level: 'error', event: 'connection.check_failed', message, now: this.nowIso() });
      await this.options.save();
      throw error;
    }
  }

  async update(connectionId: string, input: { expectedRevision: number; agentPreset?: ImAgentPresetRef; remoteApprovalEnabled?: boolean }): Promise<ImConnectionSnapshot> {
    const connection = this.requireConnection(connectionId);
    if (input.agentPreset) this.resolvePreset(connection.projectId, input.agentPreset);
    const updated = this.options.repository.updateConnectionConfig(connectionId, { ...input, now: this.nowIso() });
    if (!updated) throw imError('ZEUS_IM_CONNECTION_REVISION_CONFLICT', '连接配置已变化，请刷新后重试。', 409);
    this.options.repository.appendLog({
      connectionId,
      level: 'info',
      event: 'connection.updated',
      message: input.remoteApprovalEnabled === true ? '用户已明确开启 Telegram 远程审批。' : input.remoteApprovalEnabled === false ? 'Telegram 远程审批已关闭。' : 'Agent Preset 已更新；只影响之后创建的会话和任务推送。',
      now: this.nowIso(),
    });
    await this.options.save();
    return this.requireSnapshot(updated);
  }

  async remove(connectionId: string): Promise<void> {
    this.requireConnection(connectionId);
    await this.close();
    await this.options.secretStore.deleteSecret(imTelegramTokenAccount(connectionId));
    this.options.repository.removeConnection(connectionId, this.nowIso());
    await this.options.save();
  }

  logs(connectionId: string): ImTelegramConnectionLogEntry[] {
    this.requireConnection(connectionId);
    return this.options.repository.listLogs(connectionId).map(({ id, occurredAt, level, event, message }) => ({ id, occurredAt, level, event, message }));
  }

  private async startPolling(connection: ImConnectionRecord, token: string): Promise<void> {
    if (this.pollingTimer) clearInterval(this.pollingTimer);
    if (this.synchronizationTimer) clearInterval(this.synchronizationTimer);
    await this.pollingService?.stop();
    this.sender = createTelegramBotMessageClient({ token });
    this.pollingService = createTelegramPollingService({
      client: createTelegramLongPollingClient({ token }),
      allowedUserIds: [],
      initialOffset: connection.pollingOffset,
      handleUpdate: (update) => this.handleUpdate(connection.id, update),
      onPollComplete: async (status) => {
        this.options.repository.recordPoll(connection.id, { offset: status.offset, now: this.nowIso(), error: status.lastError });
        await this.options.save();
      },
    });
    await this.pollingService.start();
    const run = (): void => {
      if (this.pollInFlight) return;
      this.pollInFlight = true;
      void this.pollingService!.pollOnce()
        .then(async (status) => {
          if (status.lastError) {
            const message = boundedError(status.lastError, this.options.redactSensitiveText);
            this.options.repository.recordPoll(connection.id, { offset: status.offset, now: this.nowIso(), error: message });
            this.options.repository.appendLog({ connectionId: connection.id, level: 'error', event: 'poll.failed', message, now: this.nowIso() });
            await this.options.save();
          }
        })
        .finally(() => (this.pollInFlight = false));
    };
    run();
    this.pollingTimer = setInterval(run, 30_000);
    this.pollingTimer.unref?.();
    const synchronize = (): void => {
      if (this.synchronizationInFlight) return;
      this.synchronizationInFlight = true;
      void this.synchronizeConnection(connection.id)
        .catch(async (error) => {
          const message = boundedError(error, this.options.redactSensitiveText);
          this.options.repository.appendLog({ connectionId: connection.id, level: 'warning', event: 'synchronization.failed', message, now: this.nowIso() });
          const endpoint = this.options.repository.getTrustedEndpoint(connection.id);
          if (endpoint) {
            try {
              await this.sendTracked(connection, Number(endpoint.providerChatId), 'Zeus 本次结果、交互或附件回传失败，请查看桌面端连接日志。', stableIdentity('im_synchronization_failure', `${connection.id}:${errorCode(error)}:${message}`));
            } catch (deliveryError) {
              this.options.repository.appendLog({ connectionId: connection.id, level: 'error', event: 'synchronization.failure_notice_failed', message: boundedError(deliveryError, this.options.redactSensitiveText), now: this.nowIso() });
            }
          }
          await this.options.save();
        })
        .finally(() => (this.synchronizationInFlight = false));
    };
    synchronize();
    this.synchronizationTimer = setInterval(synchronize, synchronizationIntervalMs);
    this.synchronizationTimer.unref?.();
  }

  private async synchronizeConnection(connectionId: string): Promise<void> {
    const connection = this.requireConnection(connectionId);
    if (connection.state !== 'active') return;
    const endpoint = this.options.repository.getTrustedEndpoint(connection.id);
    if (!endpoint) return;
    const binding = this.options.repository.getBinding(connection.id, endpoint.id);
    if (binding) {
      const conversation = this.options.operations.listConversations(connection.projectId).find((candidate) => candidate.id === binding.conversationId);
      if (conversation && conversation.projectId === connection.projectId && !conversation.archived) {
        await this.synchronizeConversationOutput(connection, endpoint, binding.conversationId);
        await this.synchronizeConversationInteractions(connection, endpoint, binding.conversationId);
      }
    }
    const subscribedTaskIds = new Set(
      this.options.repository
        .listDeliveryCursorIdentities(connection.id, 'task:')
        .filter((identity) => identity.startsWith('task:'))
        .map((identity) => identity.slice('task:'.length))
        .filter(Boolean),
    );
    if (binding?.taskId) subscribedTaskIds.add(binding.taskId);
    for (const taskId of subscribedTaskIds) await this.synchronizeTaskNotifications(connection, endpoint, taskId);
  }

  private async synchronizeTaskNotifications(connection: ImConnectionRecord, endpoint: ImTrustedEndpointRecord, taskId: string): Promise<void> {
    const cursorIdentity = `task:${taskId}`;
    const cursor = this.options.repository.getDeliveryCursor(connection.id, cursorIdentity);
    const notifications = this.options.operations.readTaskNotifications({ projectId: connection.projectId, taskId, afterSequence: cursor });
    for (const notification of notifications.sort((left, right) => left.sequence - right.sequence)) {
      if (isUserVisibleTaskNotification(notification.eventType)) {
        await this.sendTracked(connection, Number(endpoint.providerChatId), `任务状态通知：${notification.title}`, stableIdentity('im_task_notification', `${connection.id}:${taskId}:${notification.sequence}`));
      }
      this.options.repository.setDeliveryCursor(connection.id, cursorIdentity, notification.sequence, this.nowIso());
      await this.options.save();
    }
  }

  private async synchronizeConversationOutput(connection: ImConnectionRecord, endpoint: ImTrustedEndpointRecord, conversationId: string): Promise<void> {
    const chatId = Number(endpoint.providerChatId);
    if (!Number.isSafeInteger(chatId)) throw imError('ZEUS_IM_ENDPOINT_INVALID', '可信 Telegram chat_id 无效。', 409);
    const cursor = this.options.repository.getDeliveryCursor(connection.id, conversationId);
    const items = await this.options.operations.readConversationOutput({ projectId: connection.projectId, conversationId, afterSequence: cursor });
    for (const item of items.sort((left, right) => left.sequence - right.sequence)) {
      const baseIdentity = stableIdentity('im_delivery', `${connection.id}:${conversationId}:${item.sequence}`);
      if (item.text.trim()) {
        if ([...item.text].length <= telegramLongMessageLimit) {
          await this.sendModelText(connection, chatId, item.text, `${baseIdentity}:text`);
        } else {
          const summary = `${takeCodePoints(item.text, 3_200)}\n\n完整回复较长，已附上 Markdown 文件。`;
          await this.sendModelText(connection, chatId, summary, `${baseIdentity}:summary`);
          const markdownPath = await this.materializeLongReply(connection, conversationId, item);
          await this.sendTrackedFile(connection, chatId, { id: `${item.id}:full`, displayName: `zeus-reply-${item.sequence}.md`, mime: 'text/markdown', localPath: markdownPath }, `${baseIdentity}:markdown`);
        }
      }
      for (const resource of item.resources) {
        await this.sendTrackedFile(connection, chatId, resource, `${baseIdentity}:resource:${resource.id}`);
      }
      if (item.resourceFailures > 0) {
        await this.sendTracked(connection, chatId, `${item.resourceFailures} 个会话资源未通过文件身份、授权根或大小校验，已失败关闭；请回到 Zeus 桌面端查看。`, `${baseIdentity}:resource-failures`);
      }
      this.options.repository.setDeliveryCursor(connection.id, conversationId, item.sequence, this.nowIso());
      await this.options.save();
    }
  }

  private async synchronizeConversationInteractions(connection: ImConnectionRecord, endpoint: ImTrustedEndpointRecord, conversationId: string): Promise<void> {
    for (const request of this.options.operations.listPendingRequests({ projectId: connection.projectId, conversationId })) {
      await this.synchronizeServerRequest(connection, endpoint, request);
    }
    const plan = this.options.operations.getPendingPlan({ projectId: connection.projectId, conversationId });
    if (plan) await this.synchronizePlanRequest(connection, endpoint, plan);
  }

  private async synchronizeServerRequest(connection: ImConnectionRecord, endpoint: ImTrustedEndpointRecord, request: ZeusConversationServerRequestRecord): Promise<void> {
    const expectedRevision = interactionRevision(request.createdAt);
    const draftKey = interactionDraftKey(connection.id, endpoint.id, request.id);
    if (this.pendingTextActions.get(endpoint.id)?.requestId === request.id) return;
    if (request.requestKind === 'request_user_input') {
      const payload = parseJsonRecord(request.payloadJson);
      const parsed = parseCanonicalRequestUserInputQuestions(payload);
      if (!parsed.ok) {
        await this.sendDesktopOnlyNotice(connection, endpoint, request, '问题结构无法安全解析，请回到 Zeus 桌面端处理。', expectedRevision);
        return;
      }
      if (request.containsSecret || parsed.questions.some((question) => question.isSecret)) {
        await this.sendDesktopOnlyNotice(connection, endpoint, request, '该输入包含敏感问题，Telegram 不接收答案，请回到 Zeus 桌面端处理。', expectedRevision);
        return;
      }
      const draft = this.interactionDrafts.get(draftKey) ?? { requestId: request.id, answers: {} };
      this.interactionDrafts.set(draftKey, draft);
      const nextQuestionIndex = parsed.questions.findIndex((question) => !draft.answers[question.id]?.length);
      if (nextQuestionIndex < 0) {
        await this.submitRequestUserInput(connection, endpoint, request, draft);
        return;
      }
      if (this.options.repository.hasLiveActionCapability({ connectionId: connection.id, endpointId: endpoint.id, targetKind: 'server_request', targetId: request.id, now: this.nowIso() })) return;
      await this.sendRequestQuestion(connection, endpoint, request, parsed.questions, nextQuestionIndex, draft, expectedRevision);
      return;
    }
    if (this.options.repository.hasLiveActionCapability({ connectionId: connection.id, endpointId: endpoint.id, targetKind: 'server_request', targetId: request.id, now: this.nowIso() })) return;
    if (!connection.remoteApprovalEnabled) {
      await this.sendDesktopOnlyNotice(connection, endpoint, request, '远程审批未开启，请回到 Zeus 桌面端处理。', expectedRevision);
      return;
    }
    const payload = parseJsonRecord(request.payloadJson);
    const detail = approvalDetail(request.requestKind, payload, this.options.redactSensitiveText);
    const keyboard: Array<Array<{ text: string; callbackData: string }>> = [];
    if ((request.requestKind === 'command' || request.requestKind === 'file') && approvalDecisionAdvertised(payload, 'accept')) {
      keyboard.push([{ text: '批准一次', callbackData: this.createCapability(connection, endpoint, 'approval.accept', 'server_request', request.id, expectedRevision) }]);
    }
    keyboard.push([{ text: '拒绝', callbackData: this.createCapability(connection, endpoint, 'approval.decline', 'server_request', request.id, expectedRevision) }]);
    const limitation = request.requestKind === 'permissions' || request.requestKind === 'mcp' ? '\n\n此类请求在 Telegram 仅提供失败关闭的拒绝操作；批准请回桌面端。' : '';
    await this.sendTracked(connection, Number(endpoint.providerChatId), `Zeus 等待 ${request.requestKind} 审批：\n${detail}${limitation}`, stableIdentity('im_interaction_notice', `${request.id}:${inlineKeyboardIdentity(keyboard)}`), {
      inlineKeyboard: keyboard,
    });
    await this.options.save();
  }

  private async sendRequestQuestion(
    connection: ImConnectionRecord,
    endpoint: ImTrustedEndpointRecord,
    request: ZeusConversationServerRequestRecord,
    questions: CanonicalRequestUserInputQuestion[],
    questionIndex: number,
    draft: ImInteractionDraft,
    expectedRevision: number,
  ): Promise<void> {
    const question = questions[questionIndex]!;
    const selected = new Set(draft.answers[question.id] ?? []);
    const lines = [`${questionIndex + 1}/${questions.length} · ${question.header}`, question.question];
    const keyboard: Array<Array<{ text: string; callbackData: string }>> = [];
    if (question.options === null) {
      this.createCapability(connection, endpoint, `rui.await_text.${questionIndex}`, 'server_request', request.id, expectedRevision);
      this.pendingTextActions.set(endpoint.id, { kind: 'request_user_input', conversationId: request.conversationId, requestId: request.id, questionId: question.id, customOther: false });
      lines.push('', '请直接回复自定义文本。');
    } else {
      question.options.forEach((option, optionIndex) => {
        const mark = selected.has(option.label) ? '✓ ' : '';
        keyboard.push([{ text: `${mark}${option.label}`.slice(0, 64), callbackData: this.createCapability(connection, endpoint, `rui.option.${questionIndex}.${optionIndex}`, 'server_request', request.id, expectedRevision) }]);
        if (option.description) lines.push(`- ${option.label}：${option.description}`);
      });
      if (question.isOther) keyboard.push([{ text: '其他（自定义输入）', callbackData: this.createCapability(connection, endpoint, `rui.other.${questionIndex}`, 'server_request', request.id, expectedRevision) }]);
      if (question.multiple) keyboard.push([{ text: selected.size ? '完成本题' : '请至少选择一项', callbackData: this.createCapability(connection, endpoint, `rui.done.${questionIndex}`, 'server_request', request.id, expectedRevision) }]);
    }
    await this.sendTracked(
      connection,
      Number(endpoint.providerChatId),
      lines.join('\n'),
      stableIdentity('im_rui_prompt', `${request.id}:${questionIndex}:${[...selected].sort().join('|')}:${inlineKeyboardIdentity(keyboard)}`),
      keyboard.length ? { inlineKeyboard: keyboard } : undefined,
    );
    await this.options.save();
  }

  private async sendDesktopOnlyNotice(connection: ImConnectionRecord, endpoint: ImTrustedEndpointRecord, request: ZeusConversationServerRequestRecord, reason: string, expectedRevision: number): Promise<void> {
    if (this.options.repository.hasLiveActionCapability({ connectionId: connection.id, endpointId: endpoint.id, targetKind: 'server_request', targetId: request.id, now: this.nowIso() })) return;
    this.createCapability(connection, endpoint, 'notice.desktop_only', 'server_request', request.id, expectedRevision, 7 * 24 * 60 * 60 * 1_000);
    await this.sendTracked(connection, Number(endpoint.providerChatId), `Zeus 有一项待处理请求。${reason}`, stableIdentity('im_desktop_notice', request.id));
    await this.options.save();
  }

  private async synchronizePlanRequest(connection: ImConnectionRecord, endpoint: ImTrustedEndpointRecord, plan: ZeusConversationPlanActionRecord): Promise<void> {
    if (this.pendingTextActions.get(endpoint.id)?.requestId === plan.id) return;
    if (this.options.repository.hasLiveActionCapability({ connectionId: connection.id, endpointId: endpoint.id, targetKind: 'plan_action', targetId: plan.id, now: this.nowIso() })) return;
    const expectedRevision = interactionRevision(plan.updatedAt);
    const keyboard = [
      [{ text: '实施计划', callbackData: this.createCapability(connection, endpoint, 'plan.implement', 'plan_action', plan.id, expectedRevision) }],
      [{ text: '提出修改', callbackData: this.createCapability(connection, endpoint, 'plan.refine', 'plan_action', plan.id, expectedRevision) }],
      [{ text: '暂不实施', callbackData: this.createCapability(connection, endpoint, 'plan.dismiss', 'plan_action', plan.id, expectedRevision) }],
    ];
    await this.sendTracked(connection, Number(endpoint.providerChatId), 'Agent 已提交实施计划，请选择后续操作。', stableIdentity('im_plan_prompt', `${plan.id}:${inlineKeyboardIdentity(keyboard)}`), { inlineKeyboard: keyboard });
    await this.options.save();
  }

  private async submitRequestUserInput(connection: ImConnectionRecord, endpoint: ImTrustedEndpointRecord, request: ZeusConversationServerRequestRecord, draft: ImInteractionDraft): Promise<void> {
    await this.options.operations.respondToRequest({
      projectId: connection.projectId,
      conversationId: request.conversationId,
      requestId: request.id,
      response: { type: 'userInput', answers: Object.fromEntries(Object.entries(draft.answers).map(([id, answers]) => [id, { answers }])) },
      operationIdentity: stableIdentity('im_request_response', `${connection.id}:${request.id}:${JSON.stringify(draft.answers)}`),
    });
    this.options.repository.consumeCapabilitiesForTarget({ connectionId: connection.id, endpointId: endpoint.id, targetKind: 'server_request', targetId: request.id, now: this.nowIso() });
    this.interactionDrafts.delete(interactionDraftKey(connection.id, endpoint.id, request.id));
    this.pendingTextActions.delete(endpoint.id);
    await this.sendTracked(connection, Number(endpoint.providerChatId), '已提交回答。', stableIdentity('im_request_response_ack', request.id));
  }

  private async materializeLongReply(connection: ImConnectionRecord, conversationId: string, item: ImConversationOutboundItem): Promise<string> {
    const configuredRoot = this.options.conversationAttachmentRoot;
    if (!configuredRoot) throw imError('ZEUS_IM_CONVERSATION_ATTACHMENT_ROOT_UNAVAILABLE', '会话附件授权根不可用，已阻止生成长回复附件。', 503);
    const allowedRoot = resolve(configuredRoot);
    const directory = resolve(allowedRoot, 'im-outbound', connection.id, conversationId);
    if (!directory.startsWith(`${allowedRoot}/`)) throw imError('ZEUS_IM_ATTACHMENT_PATH_INVALID', '长回复附件路径不在授权根内。', 500);
    await mkdir(directory, { recursive: true });
    const realAllowedRoot = await realpath(allowedRoot);
    const realDirectory = await realpath(directory);
    if (!isPathInside(realDirectory, realAllowedRoot)) throw imError('ZEUS_IM_ATTACHMENT_PATH_INVALID', '长回复目录解析到授权根之外。', 500);
    const path = resolve(realDirectory, `${String(item.sequence).padStart(12, '0')}-${item.id.replace(/[^A-Za-z0-9_-]/gu, '_').slice(0, 48)}.md`);
    if (!path.startsWith(`${realDirectory}/`)) throw imError('ZEUS_IM_ATTACHMENT_PATH_INVALID', '长回复附件路径身份无效。', 500);
    try {
      await writeFile(path, item.text, { flag: 'wx' });
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error;
      if ((await readFile(path, 'utf8')) !== item.text) throw imError('ZEUS_IM_LONG_REPLY_INTEGRITY_FAILED', '已有长回复附件与当前 Snapshot V2 正文不一致。', 409);
    }
    const realFile = await realpath(path);
    if (!isPathInside(realFile, realAllowedRoot) || !(await stat(realFile)).isFile()) throw imError('ZEUS_IM_LONG_REPLY_INTEGRITY_FAILED', '长回复附件未通过真实路径或文件身份校验。', 409);
    return realFile;
  }

  private async sendModelText(connection: ImConnectionRecord, chatId: number, text: string, operationIdentity: string): Promise<void> {
    try {
      await this.sendTracked(connection, chatId, text, `${operationIdentity}:html`, { parseMode: 'HTML' });
    } catch (error) {
      if (!(error instanceof TelegramApiRejectedError) || (error.status !== 400 && !/(parse|entit)/iu.test(error.message))) throw error;
      await this.sendTracked(connection, chatId, text, `${operationIdentity}:plain`);
    }
  }

  private async sendTrackedFile(connection: ImConnectionRecord, chatId: number, resource: ImConversationOutboundResource, operationIdentity: string): Promise<void> {
    await this.withChatDelivery(chatId, async () => {
      const sender = this.sender;
      if (!sender) throw imError('ZEUS_IM_SENDER_UNAVAILABLE', 'Telegram 发送器当前不可用。', 503);
      const isImage = resource.mime.startsWith('image/') && Boolean(sender.sendPhoto);
      if (!isImage && !sender.sendDocument) throw imError('ZEUS_IM_FILE_SENDER_UNAVAILABLE', 'Telegram 文件发送器当前不可用。', 503);
      const input = {
        chatIdentitySha256: createHash('sha256').update(String(chatId)).digest('hex'),
        resourceIdentitySha256: createHash('sha256').update(`${resource.id}\0${resource.localPath}`).digest('hex'),
        kind: isImage ? 'photo' : 'document',
      };
      const request = internalTelegramCommandRequest({ commandType: telegramCommandTypes.imMessageSend, scopeId: `im.connection.${connection.id}`, operationIdentity, input });
      const parsed = this.options.telegramCommands.parse<typeof input>({ value: request, commandType: telegramCommandTypes.imMessageSend, scopeId: `im.connection.${connection.id}` });
      await this.options.telegramCommands.executeExternal({
        parsed,
        destinationId: isImage ? 'telegram-send-photo' : 'telegram-send-document',
        resourceId: connection.id,
        children: [telegramChildOperation(parsed.operationIdentity, isImage ? 'send_photo' : 'send_document')],
        invoke: async () => {
          if (isImage) await sender.sendPhoto!(chatId, resource.localPath, resource.displayName);
          else await sender.sendDocument!(chatId, resource.localPath, resource.displayName);
          return { accepted: true };
        },
      });
    });
  }

  private async handleUpdate(connectionId: string, update: TelegramUpdate): Promise<TelegramCommandResponse | undefined> {
    const connection = this.requireConnection(connectionId);
    const updateIdentity = String(update.updateId);
    const operationIdentity = stableIdentity('im_inbound', `${connection.id}:${updateIdentity}`);
    if (!this.options.repository.reserveInbound({ connectionId, updateId: updateIdentity, operationIdentity, now: this.nowIso() })) return undefined;
    try {
      const startToken = parsePairingStart(update.text);
      if (startToken) {
        await this.handlePairingStart(connection, update, startToken, operationIdentity);
        this.options.repository.completeInbound({ connectionId, updateId: updateIdentity, now: this.nowIso() });
        await this.options.save();
        return undefined;
      }
      const endpoint = this.requireTrustedUpdate(connection, update);
      if (update.callbackData) await this.handleCallback(connection, endpoint, update, operationIdentity);
      else await this.handleTrustedMessage(connection, endpoint, update, operationIdentity);
      this.options.repository.completeInbound({ connectionId, updateId: updateIdentity, now: this.nowIso() });
      await this.options.save();
      return undefined;
    } catch (error) {
      const code = errorCode(error);
      const message = boundedError(error, this.options.redactSensitiveText);
      this.options.repository.completeInbound({ connectionId, updateId: updateIdentity, now: this.nowIso(), errorCode: code });
      this.options.repository.appendLog({ connectionId, level: 'warning', event: 'update.rejected', message: `${code}: ${message}`, now: this.nowIso() });
      await this.options.save();
      try {
        await this.sendTracked(connection, update.chatId, userVisibleError(error), `${operationIdentity}:error`);
      } catch (deliveryError) {
        this.options.repository.appendLog({ connectionId, level: 'error', event: 'update.error_delivery_failed', message: boundedError(deliveryError, this.options.redactSensitiveText), now: this.nowIso() });
      }
      if (update.callbackQueryId) {
        try {
          await this.sender?.answerCallbackQuery?.(update.callbackQueryId, { text: userVisibleError(error), showAlert: true });
        } catch (callbackError) {
          this.options.repository.appendLog({ connectionId, level: 'error', event: 'callback.answer_failed', message: boundedError(callbackError, this.options.redactSensitiveText), now: this.nowIso() });
        }
      }
      await this.options.save();
      return undefined;
    }
  }

  private async handlePairingStart(connection: ImConnectionRecord, update: TelegramUpdate, token: string, operationIdentity: string): Promise<void> {
    if (update.chatType !== 'private' || update.chatId !== update.userId) throw imError('ZEUS_IM_PRIVATE_CHAT_REQUIRED', '请只在该 Bot 的一对一私聊中完成配对。', 403);
    if (this.options.repository.getTrustedEndpoint(connection.id)) throw imError('ZEUS_IM_ENDPOINT_ALREADY_PAIRED', '该 Bot 已绑定其他私聊用户；请回到 Zeus 桌面端重新配对。', 403);
    const consumed = this.options.repository.consumePairing({
      tokenHash: hashSecret(token),
      providerUserId: String(update.userId),
      providerChatId: String(update.chatId),
      displayName: update.senderDisplayName ?? null,
      now: this.nowIso(),
    });
    if (!consumed || consumed.connection.id !== connection.id) throw imError('ZEUS_IM_PAIRING_INVALID', '配对码无效、已过期或已使用；请在 Zeus 桌面端重新生成。', 403);
    this.pairingPlaintext.delete(this.options.repository.getLatestPairing(connection.id)?.id ?? '');
    this.options.repository.appendLog({ connectionId: connection.id, level: 'info', event: 'pairing.completed', message: '已绑定一个 Telegram 私聊可信端点。', now: this.nowIso() });
    await this.sendTracked(
      connection,
      update.chatId,
      `已安全绑定到 Zeus 项目「${this.options.projects.getById(connection.projectId)?.name ?? connection.projectId}」。\n\n发送消息开始对话，或发送 /help 查看可用命令。`,
      `${operationIdentity}:paired`,
    );
  }

  private requireTrustedUpdate(connection: ImConnectionRecord, update: TelegramUpdate): ImTrustedEndpointRecord {
    if (update.chatType !== 'private' || update.chatId !== update.userId) throw imError('ZEUS_IM_PRIVATE_CHAT_REQUIRED', '该 Bot 只接受已绑定用户的一对一私聊。', 403);
    const endpoint = this.options.repository.getTrustedEndpoint(connection.id);
    if (!endpoint || endpoint.providerUserId !== String(update.userId) || endpoint.providerChatId !== String(update.chatId)) {
      throw imError('ZEUS_IM_UNTRUSTED_ENDPOINT', '当前 Telegram 用户或聊天不是此 Bot 的可信端点。', 403);
    }
    if (connection.state !== 'active') throw imError('ZEUS_IM_CONNECTION_RECONFIGURE_REQUIRED', '该连接需要在 Zeus 桌面端重新配置。', 409);
    return endpoint;
  }

  private async handleTrustedMessage(connection: ImConnectionRecord, endpoint: ImTrustedEndpointRecord, update: TelegramUpdate, operationIdentity: string): Promise<void> {
    const command = parseImCommand(update.text);
    const pendingText = this.pendingTextActions.get(endpoint.id) ?? this.recoverPendingTextAction(connection, endpoint);
    if (!command && pendingText) {
      await this.handlePendingTextAction(connection, endpoint, update, pendingText, operationIdentity);
      return;
    }
    const preset = this.resolvePreset(connection.projectId, connection.agentPreset, connection.id);
    if (command?.name === 'help') {
      await this.sendTracked(connection, update.chatId, helpText(), `${operationIdentity}:help`);
      return;
    }
    if (command?.name === 'new') {
      this.options.repository.clearBinding(connection.id, endpoint.id);
      if (!command.rest) {
        await this.sendTracked(connection, update.chatId, '已切换到新会话。请发送第一条消息。', `${operationIdentity}:new`);
        return;
      }
      await this.startConversation(connection, endpoint, command.rest, update, preset, operationIdentity);
      return;
    }
    if (command?.name === 'conversations') {
      await this.sendConversationList(connection, endpoint, update.chatId, operationIdentity);
      return;
    }
    if (command?.name === 'steer') {
      if (!command.rest) throw imError('ZEUS_IM_COMMAND_INPUT_REQUIRED', '/steer 后需要输入要追加到当前轮次的内容。', 400);
      await this.continueConversation(connection, endpoint, command.rest, update, operationIdentity, 'steer_now');
      return;
    }
    if (command?.name === 'stop') {
      const binding = this.requireBinding(connection, endpoint);
      const stopped = await this.options.operations.interruptConversation({ projectId: connection.projectId, conversationId: binding.conversationId, operationIdentity });
      await this.sendTracked(connection, update.chatId, stopped ? '已请求中断当前轮次。' : '当前会话没有可中断的运行轮次。', `${operationIdentity}:stop`);
      return;
    }
    if (command?.name === 'continue') {
      const binding = this.requireBinding(connection, endpoint);
      const resumed = await this.options.operations.resumeConversation({ projectId: connection.projectId, conversationId: binding.conversationId, operationIdentity });
      await this.sendTracked(connection, update.chatId, resumed ? '已请求恢复当前会话。' : '当前会话没有需要恢复的队列。', `${operationIdentity}:continue`);
      return;
    }
    if (command?.name === 'tasks' || command?.name === 'task') {
      await this.handleTaskCommand(connection, endpoint, update, command, preset, operationIdentity);
      return;
    }
    const content = update.text.trim();
    if (!content && !update.attachments?.length) throw imError('ZEUS_IM_EMPTY_MESSAGE', '消息没有可处理的文字或附件。', 400);
    const binding = this.options.repository.getBinding(connection.id, endpoint.id);
    if (binding) await this.continueConversation(connection, endpoint, content, update, operationIdentity, 'queue');
    else await this.startConversation(connection, endpoint, content, update, preset, operationIdentity);
  }

  private recoverPendingTextAction(connection: ImConnectionRecord, endpoint: ImTrustedEndpointRecord): ImPendingTextAction | undefined {
    const binding = this.options.repository.getBinding(connection.id, endpoint.id);
    if (!binding) return undefined;
    const ruiCapability = this.options.repository.findLiveActionCapability({ connectionId: connection.id, endpointId: endpoint.id, now: this.nowIso(), actionPrefix: 'rui.await_text.' });
    if (ruiCapability?.targetKind === 'server_request') {
      const request = this.options.operations.getPendingRequest({ projectId: connection.projectId, conversationId: binding.conversationId, requestId: ruiCapability.targetId });
      const questionIndex = Number(ruiCapability.actionKind.split('.')[2]);
      const parsed = request?.requestKind === 'request_user_input' && !request.containsSecret ? parseCanonicalRequestUserInputQuestions(parseJsonRecord(request.payloadJson)) : null;
      if (request && parsed?.ok && Number.isSafeInteger(questionIndex) && parsed.questions[questionIndex] && !parsed.questions[questionIndex]!.isSecret) {
        const recovered: ImPendingTextAction = {
          kind: 'request_user_input',
          conversationId: request.conversationId,
          requestId: request.id,
          questionId: parsed.questions[questionIndex]!.id,
          customOther: parsed.questions[questionIndex]!.options !== null,
        };
        this.pendingTextActions.set(endpoint.id, recovered);
        return recovered;
      }
    }
    const planCapability = this.options.repository.findLiveActionCapability({ connectionId: connection.id, endpointId: endpoint.id, now: this.nowIso(), actionPrefix: 'plan.await_refinement' });
    if (planCapability?.targetKind === 'plan_action') {
      const plan = this.options.operations.getPlan({ projectId: connection.projectId, conversationId: binding.conversationId, requestId: planCapability.targetId });
      if (plan?.status === 'pending') {
        const recovered: ImPendingTextAction = { kind: 'plan_refinement', conversationId: plan.conversationId, requestId: plan.id };
        this.pendingTextActions.set(endpoint.id, recovered);
        return recovered;
      }
    }
    return undefined;
  }

  private async handlePendingTextAction(connection: ImConnectionRecord, endpoint: ImTrustedEndpointRecord, update: TelegramUpdate, pending: ImPendingTextAction, operationIdentity: string): Promise<void> {
    const text = update.text.trim();
    if (!text) throw imError('ZEUS_IM_INTERACTION_TEXT_REQUIRED', '该交互需要非空文本输入。', 400);
    if (pending.kind === 'plan_refinement') {
      const plan = this.options.operations.getPlan({ projectId: connection.projectId, conversationId: pending.conversationId, requestId: pending.requestId });
      if (!plan || plan.status !== 'pending') throw imError('ZEUS_IM_PLAN_STALE', '计划实施请求已过期或已处理。', 409);
      await this.options.operations.respondToPlan({ projectId: connection.projectId, conversationId: pending.conversationId, requestId: pending.requestId, action: 'refine', feedback: text, operationIdentity });
      this.options.repository.consumeCapabilitiesForTarget({ connectionId: connection.id, endpointId: endpoint.id, targetKind: 'plan_action', targetId: pending.requestId, now: this.nowIso() });
      this.pendingTextActions.delete(endpoint.id);
      await this.sendTracked(connection, update.chatId, '已提交计划修改意见。', `${operationIdentity}:plan-refine`);
      return;
    }
    const request = this.options.operations.getPendingRequest({ projectId: connection.projectId, conversationId: pending.conversationId, requestId: pending.requestId });
    if (!request || request.status !== 'pending' || request.requestKind !== 'request_user_input' || request.containsSecret) throw imError('ZEUS_IM_REQUEST_STALE', '输入请求已过期、已处理或不能通过 Telegram 回答。', 409);
    const parsed = parseCanonicalRequestUserInputQuestions(parseJsonRecord(request.payloadJson));
    if (!parsed.ok) throw imError('ZEUS_IM_REQUEST_INVALID', '输入请求结构已变化，请回到桌面端处理。', 409);
    const question = parsed.questions.find((candidate) => candidate.id === pending.questionId);
    if (!question || question.isSecret) throw imError('ZEUS_IM_REQUEST_STALE', '输入问题已变化或包含敏感信息。', 409);
    const draftKey = interactionDraftKey(connection.id, endpoint.id, request.id);
    const draft = this.interactionDrafts.get(draftKey) ?? { requestId: request.id, answers: {} };
    draft.answers[question.id] = [text];
    this.interactionDrafts.set(draftKey, draft);
    this.pendingTextActions.delete(endpoint.id);
    this.options.repository.consumeCapabilitiesForTarget({ connectionId: connection.id, endpointId: endpoint.id, targetKind: 'server_request', targetId: request.id, now: this.nowIso() });
    const nextIndex = parsed.questions.findIndex((candidate) => !draft.answers[candidate.id]?.length);
    if (nextIndex < 0) await this.submitRequestUserInput(connection, endpoint, request, draft);
    else await this.sendRequestQuestion(connection, endpoint, request, parsed.questions, nextIndex, draft, interactionRevision(request.createdAt));
  }

  private async startConversation(connection: ImConnectionRecord, endpoint: ImTrustedEndpointRecord, content: string, update: TelegramUpdate, preset: ImTelegramPresetSnapshot, operationIdentity: string): Promise<void> {
    const project = this.options.projects.getById(connection.projectId);
    if (!project) throw imError('ZEUS_IM_PROJECT_NOT_FOUND', '绑定项目已经不存在。', 409);
    const attachments = await this.downloadAttachments(connection, update, operationIdentity);
    const result = await this.options.operations.createProjectConversation({ project, content: applyPresetPrompt(preset, content), attachments, preset, operationIdentity });
    this.options.repository.setBinding({ connectionId: connection.id, endpointId: endpoint.id, conversationId: result.conversationId, now: this.nowIso() });
    await this.sendTracked(connection, update.chatId, '已创建新会话并提交消息。结果会继续回传到此私聊。', `${operationIdentity}:accepted`);
  }

  private async continueConversation(connection: ImConnectionRecord, endpoint: ImTrustedEndpointRecord, content: string, update: TelegramUpdate, operationIdentity: string, delivery: 'queue' | 'steer_now'): Promise<void> {
    const binding = this.requireBinding(connection, endpoint);
    const conversation = this.options.operations.listConversations(connection.projectId).find((item) => item.id === binding.conversationId);
    if (!conversation || conversation.projectId !== connection.projectId || conversation.archived) {
      this.options.repository.clearBinding(connection.id, endpoint.id);
      throw imError('ZEUS_IM_CONVERSATION_UNAVAILABLE', '当前绑定会话已不可用；已清除绑定，请重新发送消息创建会话。', 409);
    }
    const attachments = await this.downloadAttachments(connection, update, operationIdentity);
    await this.options.operations.sendConversationMessage({ projectId: connection.projectId, conversationId: conversation.id, content, attachments, delivery, operationIdentity });
    await this.sendTracked(connection, update.chatId, delivery === 'steer_now' ? '已追加到当前轮次。' : '消息已进入 Zeus 耐久队列。', `${operationIdentity}:accepted`);
  }

  private async sendConversationList(connection: ImConnectionRecord, endpoint: ImTrustedEndpointRecord, chatId: number, operationIdentity: string): Promise<void> {
    const conversations = this.options.operations
      .listConversations(connection.projectId)
      .filter((conversation) => !conversation.archived)
      .slice(0, 8);
    if (conversations.length === 0) {
      await this.sendTracked(connection, chatId, '当前项目还没有会话。发送普通消息即可创建。', `${operationIdentity}:empty`);
      return;
    }
    const keyboard = conversations.map((conversation) => [
      {
        text: conversation.title.slice(0, 48),
        callbackData: this.createCapability(connection, endpoint, 'conversation.switch', 'conversation', conversation.id, null),
      },
    ]);
    await this.sendTracked(connection, chatId, '选择要继续的项目会话：', `${operationIdentity}:list`, { inlineKeyboard: keyboard });
  }

  private async handleCallback(connection: ImConnectionRecord, endpoint: ImTrustedEndpointRecord, update: TelegramUpdate, operationIdentity: string): Promise<void> {
    const raw = update.callbackData ?? '';
    const token = raw.startsWith('zi|') ? raw.slice(3) : '';
    if (!token) throw imError('ZEUS_IM_CALLBACK_INVALID', '交互按钮无效。', 400);
    const capability = this.options.repository.consumeActionCapability(hashSecret(token), { connectionId: connection.id, endpointId: endpoint.id, now: this.nowIso() });
    if (!capability) throw imError('ZEUS_IM_CALLBACK_EXPIRED', '该按钮已过期、已使用或不属于当前用户。', 409);
    if (capability.actionKind === 'conversation.switch' && capability.targetKind === 'conversation') {
      const conversation = this.options.operations.listConversations(connection.projectId).find((item) => item.id === capability.targetId);
      if (!conversation || conversation.projectId !== connection.projectId || conversation.archived) throw imError('ZEUS_IM_CONVERSATION_UNAVAILABLE', '目标会话已不可用。', 409);
      if (this.options.repository.getDeliveryCursor(connection.id, conversation.id) === 0) {
        const existingOutput = await this.options.operations.readConversationOutput({ projectId: connection.projectId, conversationId: conversation.id, afterSequence: 0 });
        const latestSequence = existingOutput.at(-1)?.sequence;
        if (latestSequence) this.options.repository.setDeliveryCursor(connection.id, conversation.id, latestSequence, this.nowIso());
      }
      this.options.repository.setBinding({ connectionId: connection.id, endpointId: endpoint.id, conversationId: conversation.id, taskId: conversation.taskId, now: this.nowIso() });
      await this.sender?.answerCallbackQuery?.(update.callbackQueryId ?? '', { text: '已切换会话' });
      await this.sendTracked(connection, update.chatId, `已切换到「${conversation.title}」。`, `${operationIdentity}:switched`);
      return;
    }
    if (capability.targetKind === 'server_request') {
      const binding = this.requireBinding(connection, endpoint);
      const request = this.options.operations.getPendingRequest({ projectId: connection.projectId, conversationId: binding.conversationId, requestId: capability.targetId });
      if (!request || request.status !== 'pending' || interactionRevision(request.createdAt) !== capability.expectedRevision) throw imError('ZEUS_IM_REQUEST_STALE', '请求已过期、已处理或 revision 已变化。', 409);
      if (capability.actionKind === 'approval.accept' || capability.actionKind === 'approval.decline') {
        if (!connection.remoteApprovalEnabled) throw imError('ZEUS_IM_REMOTE_APPROVAL_DISABLED', '远程审批已经关闭。', 403);
        const decision = capability.actionKind === 'approval.accept' ? 'accept' : 'decline';
        const payload = parseJsonRecord(request.payloadJson);
        if (decision === 'accept' && request.requestKind !== 'command' && request.requestKind !== 'file') throw imError('ZEUS_IM_APPROVAL_FAIL_CLOSED', '该类型请求只能在 Telegram 拒绝，批准请回桌面端。', 403);
        if (decision === 'accept' && !approvalDecisionAdvertised(payload, 'accept')) throw imError('ZEUS_IM_APPROVAL_NOT_ADVERTISED', 'Provider 未声明可用的一次性批准能力。', 409);
        const response =
          request.requestKind === 'permissions'
            ? { type: 'permissions', permissions: {}, scope: 'turn' }
            : request.requestKind === 'mcp'
              ? { type: 'MCP', action: 'decline', content: null, _meta: null }
              : { type: request.requestKind, decision };
        await this.options.operations.respondToRequest({ projectId: connection.projectId, conversationId: request.conversationId, requestId: request.id, response, operationIdentity });
        this.options.repository.consumeCapabilitiesForTarget({ connectionId: connection.id, endpointId: endpoint.id, targetKind: 'server_request', targetId: request.id, now: this.nowIso() });
        await this.answerCallback(update, decision === 'accept' ? '已批准' : '已拒绝');
        await this.sendTracked(connection, update.chatId, decision === 'accept' ? '已提交一次性批准。' : '已提交拒绝。', `${operationIdentity}:approval`);
        return;
      }
      const action = parseRuiCapabilityAction(capability.actionKind);
      if (action) {
        if (request.requestKind !== 'request_user_input' || request.containsSecret) throw imError('ZEUS_IM_REQUEST_STALE', '该输入请求不能通过 Telegram 回答。', 409);
        const parsed = parseCanonicalRequestUserInputQuestions(parseJsonRecord(request.payloadJson));
        if (!parsed.ok) throw imError('ZEUS_IM_REQUEST_INVALID', '输入请求结构已变化，请回到桌面端处理。', 409);
        const question = parsed.questions[action.questionIndex];
        if (!question || question.isSecret) throw imError('ZEUS_IM_REQUEST_STALE', '目标问题已变化或包含敏感信息。', 409);
        const draftKey = interactionDraftKey(connection.id, endpoint.id, request.id);
        const draft = this.interactionDrafts.get(draftKey) ?? { requestId: request.id, answers: {} };
        this.interactionDrafts.set(draftKey, draft);
        if (action.kind === 'other') {
          this.options.repository.consumeCapabilitiesForTarget({ connectionId: connection.id, endpointId: endpoint.id, targetKind: 'server_request', targetId: request.id, now: this.nowIso() });
          this.createCapability(connection, endpoint, `rui.await_text.${action.questionIndex}`, 'server_request', request.id, interactionRevision(request.createdAt));
          this.pendingTextActions.set(endpoint.id, { kind: 'request_user_input', conversationId: request.conversationId, requestId: request.id, questionId: question.id, customOther: true });
          await this.answerCallback(update, '请发送自定义答案');
          await this.sendTracked(connection, update.chatId, `请直接回复「${question.header}」的自定义答案。`, `${operationIdentity}:other`);
          return;
        }
        if (action.kind === 'option') {
          const option = question.options?.[action.optionIndex];
          if (!option) throw imError('ZEUS_IM_REQUEST_STALE', '目标选项已变化。', 409);
          if (question.multiple) {
            const selected = new Set(draft.answers[question.id] ?? []);
            if (selected.has(option.label)) selected.delete(option.label);
            else selected.add(option.label);
            draft.answers[question.id] = [...selected];
            this.options.repository.consumeCapabilitiesForTarget({ connectionId: connection.id, endpointId: endpoint.id, targetKind: 'server_request', targetId: request.id, now: this.nowIso() });
            await this.answerCallback(update, selected.has(option.label) ? '已选择' : '已取消');
            await this.sendRequestQuestion(connection, endpoint, request, parsed.questions, action.questionIndex, draft, interactionRevision(request.createdAt));
            return;
          }
          draft.answers[question.id] = [option.label];
        }
        if (action.kind === 'done' && !draft.answers[question.id]?.length) throw imError('ZEUS_IM_ANSWER_REQUIRED', '请至少选择一项后再完成本题。', 400);
        this.options.repository.consumeCapabilitiesForTarget({ connectionId: connection.id, endpointId: endpoint.id, targetKind: 'server_request', targetId: request.id, now: this.nowIso() });
        const nextIndex = parsed.questions.findIndex((candidate) => !draft.answers[candidate.id]?.length);
        await this.answerCallback(update, '已记录');
        if (nextIndex < 0) await this.submitRequestUserInput(connection, endpoint, request, draft);
        else await this.sendRequestQuestion(connection, endpoint, request, parsed.questions, nextIndex, draft, interactionRevision(request.createdAt));
        return;
      }
    }
    if (capability.targetKind === 'plan_action') {
      const binding = this.requireBinding(connection, endpoint);
      const plan = this.options.operations.getPlan({ projectId: connection.projectId, conversationId: binding.conversationId, requestId: capability.targetId });
      if (!plan || plan.status !== 'pending' || interactionRevision(plan.updatedAt) !== capability.expectedRevision) throw imError('ZEUS_IM_PLAN_STALE', '计划实施请求已过期、已处理或 revision 已变化。', 409);
      if (capability.actionKind === 'plan.refine') {
        this.options.repository.consumeCapabilitiesForTarget({ connectionId: connection.id, endpointId: endpoint.id, targetKind: 'plan_action', targetId: plan.id, now: this.nowIso() });
        this.createCapability(connection, endpoint, 'plan.await_refinement', 'plan_action', plan.id, interactionRevision(plan.updatedAt));
        this.pendingTextActions.set(endpoint.id, { kind: 'plan_refinement', conversationId: plan.conversationId, requestId: plan.id });
        await this.answerCallback(update, '请发送修改意见');
        await this.sendTracked(connection, update.chatId, '请直接回复要修改的内容。', `${operationIdentity}:plan-refine-prompt`);
        return;
      }
      const action = capability.actionKind === 'plan.implement' ? 'implement' : capability.actionKind === 'plan.dismiss' ? 'dismiss' : null;
      if (!action) throw imError('ZEUS_IM_CALLBACK_UNSUPPORTED', '该计划交互已不再受支持。', 409);
      await this.options.operations.respondToPlan({ projectId: connection.projectId, conversationId: plan.conversationId, requestId: plan.id, action, operationIdentity });
      this.options.repository.consumeCapabilitiesForTarget({ connectionId: connection.id, endpointId: endpoint.id, targetKind: 'plan_action', targetId: plan.id, now: this.nowIso() });
      await this.answerCallback(update, action === 'implement' ? '已选择实施' : '已选择暂不实施');
      await this.sendTracked(connection, update.chatId, action === 'implement' ? '已请求实施计划。' : '已暂不实施该计划。', `${operationIdentity}:plan`);
      return;
    }
    throw imError('ZEUS_IM_CALLBACK_UNSUPPORTED', '该交互已不再受支持。', 409);
  }

  private async answerCallback(update: TelegramUpdate, text: string): Promise<void> {
    if (update.callbackQueryId) await this.sender?.answerCallbackQuery?.(update.callbackQueryId, { text });
  }

  private async handleTaskCommand(connection: ImConnectionRecord, endpoint: ImTrustedEndpointRecord, update: TelegramUpdate, command: ImParsedCommand, preset: ImTelegramPresetSnapshot, operationIdentity: string): Promise<void> {
    const args = command.rest.split(/\s+/u).filter(Boolean);
    const action = command.name === 'tasks' ? 'list' : (args.shift() ?? 'list').toLowerCase();
    const tasks = this.options.operations.listTasks(connection.projectId);
    if (action === 'list') {
      const text = tasks.length ? ['当前项目任务：', ...tasks.slice(0, 20).map((task) => `- ${task.taskCode} · ${task.title} · ${task.managementStatus} / ${task.status}`)].join('\n') : '当前项目没有任务。';
      await this.sendTracked(connection, update.chatId, text, `${operationIdentity}:tasks`);
      return;
    }
    if (action === 'create') {
      const title = args.join(' ').trim();
      if (!title) throw imError('ZEUS_IM_TASK_TITLE_REQUIRED', '用法：/task create <标题>', 400);
      const attachments = await this.downloadAttachments(connection, update, operationIdentity, 'task');
      const task = await this.options.operations.createTask({ projectId: connection.projectId, title, attachments, operationIdentity });
      await this.sendTracked(connection, update.chatId, `已创建 ${task.taskCode} · ${task.title}`, `${operationIdentity}:task-created`);
      return;
    }
    const taskRef = args.shift();
    const task = tasks.find((candidate) => candidate.id === taskRef || candidate.taskCode.toLowerCase() === taskRef?.toLowerCase());
    if (!task) throw imError('ZEUS_IM_TASK_NOT_FOUND', '未在绑定项目中找到该任务。', 404);
    if (action === 'show' || action === 'detail') {
      await this.sendTracked(connection, update.chatId, taskDetail(task), `${operationIdentity}:task-detail`);
      return;
    }
    if (action === 'edit') {
      const field = args.shift();
      if (field !== 'title' && field !== 'description') throw imError('ZEUS_IM_TASK_EDIT_FIELD_INVALID', '用法：/task edit <任务> title|description <内容>', 400);
      const value = args.join(' ').trim();
      if (!value) throw imError('ZEUS_IM_TASK_EDIT_VALUE_REQUIRED', '任务编辑内容不能为空。', 400);
      const attachments = await this.downloadAttachments(connection, update, operationIdentity, 'task');
      const updated = await this.options.operations.updateTask({ task, field, value, attachments, operationIdentity });
      await this.sendTracked(connection, update.chatId, `已更新 ${updated.taskCode}。`, `${operationIdentity}:task-updated`);
      return;
    }
    if (action === 'status') {
      const managementStatus = args.shift();
      if (!managementStatus) throw imError('ZEUS_IM_TASK_STATUS_REQUIRED', '用法：/task status <任务> <项目状态>', 400);
      const updated = await this.options.operations.updateTaskStatus({ task, managementStatus, operationIdentity });
      await this.sendTracked(connection, update.chatId, `${updated.taskCode} 已更新为 ${updated.managementStatus}。`, `${operationIdentity}:task-status`);
      return;
    }
    if (action === 'push-current') {
      const binding = this.requireBinding(connection, endpoint);
      const conversation = this.options.operations.listConversations(connection.projectId).find((candidate) => candidate.id === binding.conversationId);
      if (!conversation || conversation.projectId !== connection.projectId || conversation.archived) throw imError('ZEUS_IM_CONVERSATION_UNAVAILABLE', '当前绑定会话已不可用。', 409);
      const content = args.join(' ').trim() || `请处理任务 ${task.taskCode}：${task.title}`;
      await this.options.operations.sendConversationMessage({
        projectId: connection.projectId,
        conversationId: conversation.id,
        content,
        attachments: this.options.operations.readTaskAttachments(task),
        delivery: 'queue',
        operationIdentity,
      });
      const latestTaskEvent = this.options.operations.readTaskNotifications({ projectId: connection.projectId, taskId: task.id, afterSequence: 0 }).at(-1);
      this.options.repository.setDeliveryCursor(connection.id, `task:${task.id}`, latestTaskEvent?.sequence ?? 0, this.nowIso());
      this.options.repository.setBinding({ connectionId: connection.id, endpointId: endpoint.id, conversationId: conversation.id, taskId: task.id, now: this.nowIso() });
      await this.sendTracked(connection, update.chatId, `已把 ${task.taskCode} 推送到当前会话。`, `${operationIdentity}:task-pushed-current`);
      return;
    }
    if (action === 'push') {
      const content = args.join(' ').trim() || `请处理任务 ${task.taskCode}：${task.title}`;
      const pushed = await this.options.operations.pushTask({ task, content: applyPresetPrompt(preset, content), preset, operationIdentity });
      const latestTaskEvent = this.options.operations.readTaskNotifications({ projectId: connection.projectId, taskId: task.id, afterSequence: 0 }).at(-1);
      this.options.repository.setDeliveryCursor(connection.id, `task:${task.id}`, latestTaskEvent?.sequence ?? 0, this.nowIso());
      this.options.repository.setBinding({ connectionId: connection.id, endpointId: endpoint.id, conversationId: pushed.conversationId, taskId: task.id, now: this.nowIso() });
      await this.sendTracked(connection, update.chatId, `已把 ${task.taskCode} 推送到新会话，并切换当前聊天绑定。`, `${operationIdentity}:task-pushed`);
      return;
    }
    if (action === 'run' || action === 'pause' || action === 'continue' || action === 'cancel') {
      const updated = await this.options.operations.controlTask({ task, action, operationIdentity });
      await this.sendTracked(connection, update.chatId, `${updated.taskCode} 运行状态：${updated.status}`, `${operationIdentity}:task-control`);
      return;
    }
    throw imError('ZEUS_IM_TASK_COMMAND_UNSUPPORTED', '不支持该任务命令。发送 /help 查看用法。', 400);
  }

  private async downloadAttachments(connection: ImConnectionRecord, update: TelegramUpdate, operationIdentity: string, purpose: 'conversation' | 'task' = 'conversation'): Promise<ImDownloadedAttachment[]> {
    const attachments = update.attachments ?? [];
    if (attachments.length > imAttachmentLimits.maximumFilesPerIntent) throw imError('ZEUS_IM_ATTACHMENT_COUNT_EXCEEDED', `单次最多接收 ${imAttachmentLimits.maximumFilesPerIntent} 个附件。`, 413);
    if (attachments.reduce((sum, attachment) => sum + (attachment.fileSize ?? 0), 0) > imAttachmentLimits.maximumIntentBytes) throw imError('ZEUS_IM_ATTACHMENT_TOTAL_EXCEEDED', '单次附件总量不能超过 100 MiB。', 413);
    if (attachments.length === 0) return [];
    const token = await this.readToken(connection.id);
    if (!token) throw imError('ZEUS_IM_TOKEN_MISSING', '连接 Token 已不存在，无法下载附件。', 409);
    const configuredRoot = purpose === 'task' ? this.options.taskAttachmentRoot : this.options.conversationAttachmentRoot;
    if (!configuredRoot) throw imError('ZEUS_IM_ATTACHMENT_ROOT_UNAVAILABLE', 'Zeus 附件授权根不可用，已阻止接收 Telegram 附件。', 503);
    const allowedRoot = resolve(configuredRoot);
    const intentRoot = resolve(allowedRoot, 'im-inbound', connection.id, stableIdentity('intent', operationIdentity));
    if (!intentRoot.startsWith(`${allowedRoot}/`)) throw imError('ZEUS_IM_ATTACHMENT_PATH_INVALID', '附件存储路径不在 Zeus 授权根内。', 500);
    await mkdir(intentRoot, { recursive: true });
    const realAllowedRoot = await realpath(allowedRoot);
    const realIntentRoot = await realpath(intentRoot);
    if (!isPathInside(realIntentRoot, realAllowedRoot)) throw imError('ZEUS_IM_ATTACHMENT_PATH_INVALID', '附件目录解析到 Zeus 授权根之外。', 500);
    const downloaded: ImDownloadedAttachment[] = [];
    let total = 0;
    for (let index = 0; index < attachments.length; index += 1) {
      const attachment = attachments[index]!;
      if (attachment.fileSize !== null && attachment.fileSize > imAttachmentLimits.maximumFileBytes) throw imError('ZEUS_IM_ATTACHMENT_TOO_LARGE', '单文件不能超过 20 MiB。', 413);
      const remote = await getTelegramRemoteFile({ token, fileId: attachment.fileId });
      if (remote.fileSize !== null && remote.fileSize > imAttachmentLimits.maximumFileBytes) throw imError('ZEUS_IM_ATTACHMENT_TOO_LARGE', '单文件不能超过 20 MiB。', 413);
      const bytes = await downloadTelegramRemoteFile({ token, filePath: remote.filePath, maximumBytes: imAttachmentLimits.maximumFileBytes });
      total += bytes.byteLength;
      if (total > imAttachmentLimits.maximumIntentBytes) throw imError('ZEUS_IM_ATTACHMENT_TOTAL_EXCEEDED', '单次附件总量不能超过 100 MiB。', 413);
      const mime = sniffMime(bytes, attachment);
      const baseName = safeAttachmentName(attachment, index, mime);
      const name = baseName;
      const localPath = resolve(realIntentRoot, name);
      if (!localPath.startsWith(`${realIntentRoot}/`)) throw imError('ZEUS_IM_ATTACHMENT_PATH_INVALID', '附件文件名未通过路径身份校验。', 400);
      try {
        await writeFile(localPath, bytes, { flag: 'wx' });
      } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error;
        const existing = await readFile(localPath);
        if (!sameBytes(existing, bytes)) throw imError('ZEUS_IM_ATTACHMENT_INTEGRITY_FAILED', '恢复中的附件与已下载文件身份不一致。', 409);
      }
      const realFile = await realpath(localPath);
      const fileStat = await stat(realFile);
      if (!isPathInside(realFile, realAllowedRoot) || !fileStat.isFile() || fileStat.size !== bytes.byteLength) throw imError('ZEUS_IM_ATTACHMENT_INTEGRITY_FAILED', '附件未通过真实路径、类型或实际大小校验。', 409);
      downloaded.push({ name, mime, size: bytes.byteLength, localPath: realFile });
    }
    return downloaded;
  }

  private createPairing(connection: ImConnectionRecord): { id: string } {
    this.pairingPlaintext.clear();
    const plaintext = randomBytes(32).toString('base64url');
    const now = this.options.now();
    const pairing = this.options.repository.createPairingSession({ connectionId: connection.id, tokenHash: hashSecret(plaintext), expiresAt: new Date(now.getTime() + pairingLifetimeMs).toISOString(), now: now.toISOString() });
    this.pairingPlaintext.set(pairing.id, plaintext);
    return { id: pairing.id };
  }

  private requirePairingSnapshot(pairingId: string): ImPairingSessionSnapshot {
    const pairing = this.options.repository.getPairingSession(pairingId);
    const plaintext = this.pairingPlaintext.get(pairingId);
    if (!pairing || !plaintext || pairing.consumedAt || Date.parse(pairing.expiresAt) <= this.options.now().getTime()) throw imError('ZEUS_IM_PAIRING_PLAINTEXT_UNAVAILABLE', '配对码已过期或进程已重启，请重新生成。', 409);
    return this.toPairingSnapshot(pairing.id, pairing.connectionId, pairing.expiresAt, false);
  }

  private toPairingSnapshot(pairingId: string, connectionId: string, expiresAt: string, consumed: boolean): ImPairingSessionSnapshot {
    const connection = this.requireConnection(connectionId);
    const plaintext = this.pairingPlaintext.get(pairingId);
    if (!plaintext) throw imError('ZEUS_IM_PAIRING_PLAINTEXT_UNAVAILABLE', '配对码只保存在当前进程内，请重新生成。', 409);
    return {
      id: pairingId,
      connectionId,
      deepLink: `https://t.me/${connection.botUsername}?start=${plaintext}`,
      qrCodeDataUrl: null,
      expiresAt,
      remainingSeconds: Math.max(0, Math.floor((Date.parse(expiresAt) - this.options.now().getTime()) / 1_000)),
      consumed,
    };
  }

  private resolvePreset(projectId: string, ref: ImAgentPresetRef, connectionId?: string): ImTelegramPresetSnapshot {
    if (ref.kind === 'zeus_default') {
      return { ref, name: '跟随 Zeus 默认', agentKind: 'codex', model: null, reasoningEffort: null, permissionMode: 'auto', workMode: 'default', prompt: '', skillId: null };
    }
    const employee = this.options.digitalEmployees.getById(ref.digitalEmployeeId);
    if (!employee || employee.projectId !== projectId || !employee.enabled) {
      if (connectionId) this.options.repository.markPresetUnavailable(connectionId, this.nowIso());
      throw imError('ZEUS_IM_AGENT_PRESET_UNAVAILABLE', '绑定的数字员工已停用、删除或不属于该项目，请在 Zeus 桌面端重新选择。', 409);
    }
    if (employee.agentKind !== 'codex') throw imError('ZEUS_IM_AGENT_PRESET_UNAVAILABLE', '项目普通会话当前只支持 Codex 数字员工，请重新选择。', 409);
    return {
      ref,
      name: employee.name,
      agentKind: employee.agentKind,
      model: employee.model,
      reasoningEffort: employee.reasoningEffort,
      permissionMode: employee.permissionMode,
      workMode: employee.workMode,
      prompt: employee.prompt,
      skillId: employee.skillIds[0] ?? null,
    };
  }

  private toConnectionSnapshot(record: ImConnectionRecord): ImConnectionSnapshot | null {
    const project = this.options.projects.getById(record.projectId);
    if (!project) return null;
    let presetName = '跟随 Zeus 默认';
    if (record.agentPreset.kind === 'digital_employee') presetName = this.options.digitalEmployees.getById(record.agentPreset.digitalEmployeeId)?.name ?? '数字员工不可用';
    const endpoint = this.options.repository.getTrustedEndpoint(record.id);
    return {
      id: record.id,
      channelId: 'telegram',
      projectId: project.id,
      projectName: project.name,
      agentPreset: record.agentPreset,
      agentPresetName: presetName,
      remoteApprovalEnabled: record.remoteApprovalEnabled,
      state: record.state,
      bot: { idMasked: maskProviderId(record.botId), username: record.botUsername, displayName: record.botDisplayName },
      trustedEndpoint: endpoint
        ? { id: endpoint.id, providerUserIdMasked: maskProviderId(endpoint.providerUserId), providerChatIdMasked: maskProviderId(endpoint.providerChatId), displayName: endpoint.displayName, pairedAt: endpoint.pairedAt }
        : null,
      health: this.health(record),
      revision: record.revision,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  private health(record: ImConnectionRecord): ImConnectionHealth {
    const polling = this.pollingService?.status().running === true;
    const tokenValidated = Boolean(record.tokenValidatedAt);
    const recent = Boolean(record.lastSuccessfulPollAt && this.options.now().getTime() - Date.parse(record.lastSuccessfulPollAt) <= onlinePollWindowMs);
    const online = tokenValidated && polling && recent;
    const reason = online ? 'Token 已验证、轮询运行中，且最近 90 秒内轮询成功。' : !tokenValidated ? 'Token 尚未成功验证。' : !polling ? '轮询未运行。' : '最近 90 秒内没有成功轮询。';
    return { online, tokenValidated, polling, lastCheckedAt: record.lastCheckedAt, lastSuccessfulPollAt: record.lastSuccessfulPollAt, lastError: record.lastError, reason };
  }

  private createCapability(connection: ImConnectionRecord, endpoint: ImTrustedEndpointRecord, actionKind: string, targetKind: string, targetId: string, expectedRevision: number | null, lifetimeMs = interactionLifetimeMs): string {
    const token = randomBytes(24).toString('base64url');
    const now = this.options.now();
    this.options.repository.createActionCapability({
      connectionId: connection.id,
      endpointId: endpoint.id,
      tokenHash: hashSecret(token),
      actionKind,
      targetKind,
      targetId,
      expectedRevision,
      expiresAt: new Date(now.getTime() + lifetimeMs).toISOString(),
      now: now.toISOString(),
    });
    return `zi|${token}`;
  }

  private async sendTracked(
    connection: ImConnectionRecord,
    chatId: number,
    text: string,
    operationIdentity: string,
    messageOptions?: { inlineKeyboard?: Array<Array<{ text: string; callbackData: string }>>; parseMode?: 'HTML' },
  ): Promise<void> {
    await this.withChatDelivery(chatId, async () => {
      const sender = this.sender;
      if (!sender) throw imError('ZEUS_IM_SENDER_UNAVAILABLE', 'Telegram 发送器当前不可用。', 503);
      const input = {
        chatIdentitySha256: createHash('sha256').update(String(chatId)).digest('hex'),
        messageSha256: createHash('sha256').update(text).digest('hex'),
        hasKeyboard: Boolean(messageOptions?.inlineKeyboard?.length),
        parseMode: messageOptions?.parseMode ?? null,
      };
      const request = internalTelegramCommandRequest({ commandType: telegramCommandTypes.imMessageSend, scopeId: `im.connection.${connection.id}`, operationIdentity, input });
      const parsed = this.options.telegramCommands.parse<typeof input>({ value: request, commandType: telegramCommandTypes.imMessageSend, scopeId: `im.connection.${connection.id}` });
      await this.options.telegramCommands.executeExternal({
        parsed,
        destinationId: 'telegram-send-message',
        resourceId: connection.id,
        children: [telegramChildOperation(parsed.operationIdentity, 'send_message')],
        invoke: async () => {
          const sent = await sender.sendMessage(chatId, text, { inlineKeyboard: messageOptions?.inlineKeyboard, ...(messageOptions?.parseMode ? { parseMode: messageOptions.parseMode } : {}) });
          return { messageId: sent?.messageId ?? null };
        },
      });
    });
  }

  private withChatDelivery<T>(chatId: number, deliver: () => Promise<T>): Promise<T> {
    const key = String(chatId);
    const previous = this.chatDeliveryTails.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(deliver);
    const tail = current.then(
      () => undefined,
      () => undefined,
    );
    this.chatDeliveryTails.set(key, tail);
    void tail.finally(() => {
      if (this.chatDeliveryTails.get(key) === tail) this.chatDeliveryTails.delete(key);
    });
    return current;
  }

  private requireConnection(id: string): ImConnectionRecord {
    const connection = this.options.repository.getConnection(id);
    if (!connection) throw imError('ZEUS_IM_CONNECTION_NOT_FOUND', 'IM 连接不存在。', 404);
    return connection;
  }

  private requireSnapshot(connection: ImConnectionRecord): ImConnectionSnapshot {
    const snapshot = this.toConnectionSnapshot(connection);
    if (!snapshot) throw imError('ZEUS_IM_PROJECT_NOT_FOUND', '绑定项目不存在。', 409);
    return snapshot;
  }

  private requireBinding(connection: ImConnectionRecord, endpoint: ImTrustedEndpointRecord) {
    const binding = this.options.repository.getBinding(connection.id, endpoint.id);
    if (!binding) throw imError('ZEUS_IM_CONVERSATION_NOT_SELECTED', '当前没有绑定会话。发送普通消息创建新会话，或用 /conversations 选择历史会话。', 409);
    return binding;
  }

  private readToken(connectionId: string): Promise<string | undefined> {
    return this.options.secretStore.getSecret(imTelegramTokenAccount(connectionId));
  }

  private nowIso(): string {
    return this.options.now().toISOString();
  }
}

export function imTelegramTokenAccount(connectionId: string): string {
  return `im.connection.${connectionId}.telegram.bottoken`;
}

export function internalTelegramCommandRequest<TInput extends object>(input: { commandType: (typeof telegramCommandTypes)[keyof typeof telegramCommandTypes]; scopeId: string; operationIdentity: string; input: TInput }) {
  const inputSha256 = createHash('sha256').update(canonicalCommandInputJson(input.input)).digest('hex');
  const commandId = stableIdentity('command_im', `${input.commandType}:${input.operationIdentity}`);
  return {
    command: {
      schemaGeneration: commandEnvelopeSchemaGeneration,
      commandId,
      commandType: input.commandType,
      actor: { kind: 'system' as const, id: 'telegram-im-bridge' },
      scope: { kind: 'settings' as const, id: input.scopeId },
      expectedRevision: null,
      idempotencyKey: `${input.commandType}:${input.operationIdentity}`,
      issuedAt: '2000-01-01T00:00:00.000Z',
      payload: { operationIdentity: input.operationIdentity, inputSha256 },
    },
    input: input.input,
  };
}

export function stableIdentity(prefix: string, input: string): string {
  return `${prefix}_${createHash('sha256').update(input).digest('hex').slice(0, 40)}`;
}

function hashSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function parsePairingStart(text: string): string | null {
  const match = text.trim().match(/^\/start(?:@[A-Za-z0-9_]+)?\s+([A-Za-z0-9_-]{43})$/u);
  return match?.[1] ?? null;
}

interface ImParsedCommand {
  name: 'help' | 'new' | 'conversations' | 'steer' | 'stop' | 'continue' | 'tasks' | 'task';
  rest: string;
}

function parseImCommand(text: string): ImParsedCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  const [raw = '', ...parts] = trimmed.split(/\s+/u);
  const name = raw.slice(1).split('@')[0]?.toLowerCase();
  if (!name || !['help', 'new', 'conversations', 'steer', 'stop', 'continue', 'tasks', 'task'].includes(name)) throw imError('ZEUS_IM_COMMAND_UNSUPPORTED', '未知 IM 命令。发送 /help 查看可用命令。', 400);
  return { name: name as ImParsedCommand['name'], rest: parts.join(' ').trim() };
}

function applyPresetPrompt(preset: ImTelegramPresetSnapshot, content: string): string {
  if (!preset.prompt.trim()) return content;
  return ['<agent-preset>', `名称：${preset.name}`, preset.prompt.trim(), '</agent-preset>', '', content].join('\n');
}

function helpText(): string {
  return [
    'Zeus IM 命令',
    '/new [消息] — 新建会话',
    '/conversations — 切换项目历史会话',
    '/steer <消息> — 追加当前轮次',
    '/stop — 中断当前轮次',
    '/continue — 恢复当前会话',
    '/tasks — 查看绑定项目任务',
    '/task show <任务>',
    '/task create <标题>',
    '/task edit <任务> title|description <内容>',
    '/task status <任务> <项目状态>',
    '/task push <任务> [说明] — 推送到新会话',
    '/task push-current <任务> [说明] — 推送到当前会话',
    '/task run|pause|continue|cancel <任务>',
    '',
    '归档删除、批量任务、关系/阶段、数字员工接力、Git 工作区和外部集成治理请回到桌面端完成。',
  ].join('\n');
}

function taskDetail(task: ZeusTaskRecord): string {
  return [`${task.taskCode} · ${task.title}`, `项目状态：${task.managementStatus}`, `运行状态：${task.status}`, `类型 / 优先级：${task.taskType} / ${task.priority}`, task.description ? `描述：${task.description}` : '描述：未填写'].join(
    '\n',
  );
}

function maskProviderId(value: string): string {
  if (value.length <= 4) return '••••';
  return `${value.slice(0, 2)}${'•'.repeat(Math.min(6, value.length - 4))}${value.slice(-2)}`;
}

function safeAttachmentName(attachment: TelegramInboundAttachment, index: number, mime: string): string {
  const supplied = attachment.fileName
    ? basename(attachment.fileName)
        .normalize('NFKC')
        .replace(/[^\p{L}\p{N}._-]+/gu, '_')
    : '';
  const suppliedExtension = extname(supplied).slice(0, 16);
  const extension = suppliedExtension || extensionForMime(mime);
  const stem = supplied ? supplied.slice(0, Math.max(1, supplied.length - suppliedExtension.length)).slice(0, 80) : `${attachment.kind}-${index + 1}`;
  return `${String(index + 1).padStart(2, '0')}-${stableIdentity('file', attachment.fileId).slice(-12)}-${stem}${extension}`;
}

function sniffMime(bytes: Uint8Array, attachment: TelegramInboundAttachment): string {
  const starts = (...values: number[]): boolean => values.every((value, index) => bytes[index] === value);
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (starts(0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (starts(0x25, 0x50, 0x44, 0x46)) return 'application/pdf';
  if (starts(0x50, 0x4b, 0x03, 0x04)) return attachment.mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ? attachment.mimeType : 'application/zip';
  if (starts(0x49, 0x44, 0x33) || starts(0xff, 0xfb) || starts(0xff, 0xf3) || starts(0xff, 0xf2)) return 'audio/mpeg';
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(4, 12)).includes('ftyp')) return attachment.kind === 'audio' ? 'audio/mp4' : 'video/mp4';
  if (attachment.mimeType?.startsWith('text/') && !bytes.slice(0, Math.min(bytes.length, 4_096)).some((byte) => byte === 0)) return attachment.mimeType;
  return attachment.mimeType && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/iu.test(attachment.mimeType) ? attachment.mimeType : 'application/octet-stream';
}

function extensionForMime(mime: string): string {
  return ({ 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'application/pdf': '.pdf', 'application/zip': '.zip', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'video/mp4': '.mp4' } as Record<string, string>)[mime] ?? '.bin';
}

function boundedError(error: unknown, redactor: (value: string) => { text: string }): string {
  return redactor(error instanceof Error ? error.message : String(error)).text.slice(0, 2_048);
}

function errorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string' ? String((error as { code: string }).code).slice(0, 128) : 'ZEUS_IM_UPDATE_FAILED';
}

function userVisibleError(error: unknown): string {
  if (error && typeof error === 'object' && 'userMessage' in error && typeof (error as { userMessage?: unknown }).userMessage === 'string') return (error as { userMessage: string }).userMessage;
  return '这条 Telegram 请求未能完成，请回到 Zeus 桌面端检查连接日志。';
}

function parseJsonRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function interactionRevision(value: string): number {
  return Number.parseInt(createHash('sha256').update(value).digest('hex').slice(0, 12), 16);
}

function interactionDraftKey(connectionId: string, endpointId: string, requestId: string): string {
  return `${connectionId}\0${endpointId}\0${requestId}`;
}

function inlineKeyboardIdentity(keyboard: Array<Array<{ callbackData: string }>>): string {
  return createHash('sha256')
    .update(keyboard.flatMap((row) => row.map((button) => button.callbackData)).join('\0'))
    .digest('hex')
    .slice(0, 24);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return createHash('sha256').update(left).digest('hex') === createHash('sha256').update(right).digest('hex');
}

function isPathInside(candidate: string, root: string): boolean {
  const child = relative(root, candidate);
  return Boolean(child) && child !== '..' && !child.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(child);
}

function takeCodePoints(value: string, maximum: number): string {
  const points = [...value];
  return points.length <= maximum ? value : `${points.slice(0, Math.max(0, maximum - 1)).join('')}…`;
}

function isUserVisibleTaskNotification(eventType: string): boolean {
  return /(?:status|runtime|completed|failed|cancelled|confirmation|result)/iu.test(eventType);
}

function approvalDecisionAdvertised(payload: Record<string, unknown>, decision: 'accept' | 'decline'): boolean {
  const advertised = Array.isArray(payload.availableDecisions)
    ? payload.availableDecisions.flatMap((entry) => {
        if (typeof entry === 'string') return [entry];
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
        const record = entry as Record<string, unknown>;
        return [record.decision, record.id, record.value, record.name].filter((value): value is string => typeof value === 'string');
      })
    : [];
  return advertised.includes(decision);
}

function approvalDetail(requestKind: string, payload: Record<string, unknown>, redactor: (value: string) => { text: string }): string {
  const selected = ['command', 'cwd', 'path', 'reason', 'title'].flatMap((key) => (typeof payload[key] === 'string' ? [`${key}: ${String(payload[key])}`] : []));
  const raw = selected.length ? selected.join('\n') : `${requestKind} 请求 ${createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 12)}`;
  return redactor(raw).text.slice(0, 1_500);
}

function parseRuiCapabilityAction(value: string): { kind: 'option'; questionIndex: number; optionIndex: number } | { kind: 'other' | 'done'; questionIndex: number } | null {
  const parts = value.split('.');
  if (parts[0] !== 'rui') return null;
  const questionIndex = Number(parts[2]);
  if (!Number.isSafeInteger(questionIndex) || questionIndex < 0) return null;
  if (parts[1] === 'option') {
    const optionIndex = Number(parts[3]);
    return Number.isSafeInteger(optionIndex) && optionIndex >= 0 ? { kind: 'option', questionIndex, optionIndex } : null;
  }
  return parts[1] === 'other' || parts[1] === 'done' ? { kind: parts[1], questionIndex } : null;
}

export function imError(code: string, userMessage: string, statusCode: number): Error & { code: string; userMessage: string; statusCode: number } {
  return Object.assign(new Error(userMessage), { code, userMessage, statusCode });
}
