import {
  parseZentaoTaskSyncLink,
  type ZentaoRemoteExecutionSummary,
  type ZentaoRemoteItemDetail,
  type ZentaoRemoteItemSummary,
  type ZentaoRemoteKind,
  type ZentaoRemoteListResult,
  type ZentaoRemoteProductSummary,
  type ZentaoRemoteProjectSummary,
  type ZentaoTaskSyncLink,
  type ZentaoTaskSyncRequest,
  type ZentaoInstanceRecord,
  type ZentaoTaskEffort,
  type ZentaoTaskEffortRequest,
  type ZentaoTaskEffortsResult,
} from '@zeus/shared';
import type { ZeusTaskRecord } from '@zeus/storage';
import type { ZentaoCredentialService } from './zentaoCredentialService.js';

const maximumRemoteItems = 2_000;
const maximumPageSize = 100;

export interface ZentaoRemoteWriteResult {
  mode: 'created' | 'updated';
  remote: ZentaoRemoteItemSummary;
  link: ZentaoTaskSyncLink;
}

export interface ZentaoSyncService {
  listProjects(instanceId: string): Promise<ZentaoRemoteProjectSummary[]>;
  listExecutions(instanceId: string, projectId: string): Promise<ZentaoRemoteExecutionSummary[]>;
  listProducts(instanceId: string): Promise<ZentaoRemoteProductSummary[]>;
  listItems(instanceId: string, input: { kind: ZentaoRemoteKind; projectId: string; executionId?: string; productId?: string; query?: string; offset?: number; limit?: number }): Promise<ZentaoRemoteListResult>;
  listMyItems(instanceId: string, input: { kind?: ZentaoRemoteKind; query?: string; offset?: number; limit?: number }): Promise<ZentaoRemoteListResult>;
  getItem(instanceId: string, kind: ZentaoRemoteKind, objectId: string): Promise<ZentaoRemoteItemDetail>;
  pushTask(instanceId: string, input: ZentaoTaskSyncRequest, task: ZeusTaskRecord): Promise<ZentaoRemoteWriteResult>;
  /** 根据本地受控关联读取禅道工时汇总和日志。 */
  getEfforts(instanceId: string, task: ZeusTaskRecord): Promise<ZentaoTaskEffortsResult>;
  /** 为已关联的禅道任务登记一次实际工时。 */
  recordEffort(instanceId: string, input: ZentaoTaskEffortRequest, task: ZeusTaskRecord): Promise<ZentaoRemoteItemDetail>;
}

/** 禅道数据适配层：接口字段在这里归一化，渲染层不依赖具体禅道版本的字段命名。 */
export function createZentaoSyncService(options: { credentials: ZentaoCredentialService; now?: () => string }): ZentaoSyncService {
  const now = options.now ?? (() => new Date().toISOString());

  async function request(instanceId: string, path: string, method: 'GET' | 'POST' | 'PUT' = 'GET', body?: Record<string, unknown>): Promise<{ instance: ZentaoInstanceRecord; status: number; payload: unknown }> {
    const instance = await options.credentials.get(instanceId);
    if (!instance) throw syncError('ZEUS_ZENTAO_INSTANCE_NOT_FOUND', '禅道实例不存在。', 404);
    const response = await options.credentials.request(instanceId, { path, method, body });
    return { instance, ...response };
  }

  async function successfulRequest(instanceId: string, path: string, method: 'GET' | 'POST' | 'PUT' = 'GET', body?: Record<string, unknown>) {
    const response = await request(instanceId, path, method, body);
    if (response.status < 200 || response.status >= 300) {
      throw syncError(`ZEUS_ZENTAO_HTTP_${response.status}`, remoteMessage(response.payload, response.status), response.status >= 400 && response.status < 600 ? response.status : 502);
    }
    if (isRecord(response.payload) && (response.payload.status === 'fail' || response.payload.status === 'error' || response.payload.result === false)) {
      throw syncError('ZEUS_ZENTAO_REMOTE_REJECTED', remoteMessage(response.payload, response.status), 502);
    }
    return response;
  }

  async function successfulMyWorkRequest(instanceId: string, kind: ZentaoRemoteKind) {
    const instance = await options.credentials.get(instanceId);
    if (!instance) throw syncError('ZEUS_ZENTAO_INSTANCE_NOT_FOUND', '禅道实例不存在。', 404);
    const response = await options.credentials.requestMyWork(instanceId, kind);
    if (response.status < 200 || response.status >= 300) {
      throw syncError(`ZEUS_ZENTAO_HTTP_${response.status}`, remoteMessage(response.payload, response.status), response.status >= 400 && response.status < 600 ? response.status : 502);
    }
    return { instance, ...response };
  }

  return {
    async listProjects(instanceId) {
      // 禅道项目列表必须显式带 status=doing，避免把已归档项目带入导入选择器。
      const response = await successfulRequest(instanceId, '/projects?status=doing');
      return extractRecords(response.payload, ['projects', 'items'])
        .slice(0, maximumRemoteItems)
        .map((item) => normalizeProject(item))
        .filter((item): item is ZentaoRemoteProjectSummary => Boolean(item));
    },
    async listExecutions(instanceId, projectId) {
      const normalizedProjectId = requireId(projectId, '项目');
      const response = await successfulRequest(instanceId, `/projects/${encodeURIComponent(normalizedProjectId)}/executions`);
      return extractRecords(response.payload, ['executions', 'items'])
        .slice(0, maximumRemoteItems)
        .map((item) => normalizeExecution(item, normalizedProjectId))
        .filter((item): item is ZentaoRemoteExecutionSummary => Boolean(item));
    },
    async listProducts(instanceId) {
      const response = await successfulRequest(instanceId, '/products');
      return extractRecords(response.payload, ['products', 'items'])
        .slice(0, maximumRemoteItems)
        .map(normalizeProduct)
        .filter((item): item is ZentaoRemoteProductSummary => Boolean(item));
    },
    async listItems(instanceId, input) {
      const projectId = requireId(input.projectId, '项目');
      const offset = clampInteger(input.offset, 0, 100_000, 0);
      const limit = clampInteger(input.limit, 1, maximumPageSize, 30);
      const path =
        input.kind === 'task'
          ? input.executionId
            ? `/executions/${encodeURIComponent(requireId(input.executionId, '执行'))}/tasks`
            : null
          : input.executionId
            ? `/executions/${encodeURIComponent(requireId(input.executionId, '执行'))}/bugs`
            : input.productId
              ? `/products/${encodeURIComponent(requireId(input.productId, '产品'))}/bugs`
              : `/projects/${encodeURIComponent(projectId)}/bugs`;
      if (!path) throw syncError('ZEUS_ZENTAO_EXECUTION_REQUIRED', '读取禅道任务前必须选择执行。', 400);
      const response = await successfulRequest(instanceId, path);
      const normalized = extractRecords(response.payload, input.kind === 'task' ? ['tasks', 'items'] : ['bugs', 'items'])
        .slice(0, maximumRemoteItems)
        .map((item) => normalizeSummary(input.kind, item, response.instance))
        .filter((item): item is ZentaoRemoteItemSummary => Boolean(item));
      const query = input.query?.trim().toLocaleLowerCase();
      const filtered = query ? normalized.filter((item) => `${item.objectId} ${item.title} ${item.status} ${item.priority}`.toLocaleLowerCase().includes(query)) : normalized;
      return {
        items: filtered.slice(offset, offset + limit),
        total: filtered.length,
        offset,
        limit,
        hasMore: offset + limit < filtered.length,
      };
    },
    async listMyItems(instanceId, input) {
      const offset = clampInteger(input.offset, 0, 100_000, 0);
      const limit = clampInteger(input.limit, 1, maximumPageSize, 30);
      // 导入场景不传 kind 时同时读取任务和缺陷，再对合并结果统一搜索与分页。
      const kinds: ZentaoRemoteKind[] = input.kind ? [input.kind] : ['task', 'bug'];
      const responses = await Promise.all(
        kinds.map(async (kind) => ({
          kind,
          response: await successfulMyWorkRequest(instanceId, kind),
        })),
      );
      const normalized = responses.flatMap(({ kind, response }) =>
        extractMyWorkRecords(response.payload, kind)
          .slice(0, maximumRemoteItems)
          .map((item) => normalizeSummary(kind, item, response.instance))
          .filter((item): item is ZentaoRemoteItemSummary => Boolean(item)),
      );
      const query = input.query?.trim().toLocaleLowerCase();
      const filtered = query ? normalized.filter((item) => `${item.objectId} ${item.title} ${item.status} ${item.priority}`.toLocaleLowerCase().includes(query)) : normalized;
      return {
        items: filtered.slice(offset, offset + limit),
        total: filtered.length,
        offset,
        limit,
        hasMore: offset + limit < filtered.length,
      };
    },
    async getItem(instanceId, kind, objectId) {
      const id = requireObjectId(objectId);
      const response = await successfulRequest(instanceId, `/${kind === 'task' ? 'tasks' : 'bugs'}/${encodeURIComponent(id)}`);
      return normalizeDetail(kind, unwrapRecord(response.payload), response.instance, id);
    },
    async getEfforts(instanceId, task) {
      /** 远端编号只接受本地任务已经保存的关联。 */
      const link = requireZentaoTaskLink(task, instanceId);
      /** 汇总与日志互不依赖，可并行读取。 */
      const [detail, logs] = await Promise.all([successfulRequest(instanceId, `/tasks/${encodeURIComponent(link.objectId)}`), successfulRequest(instanceId, `/tasks/${encodeURIComponent(link.objectId)}/estimate`)]);
      /** 禅道的日志列表可能按日志编号组成对象。 */
      const raw = unwrapRecord(logs.payload);
      if (!isRecord(raw.effort) && !Array.isArray(raw.effort) && !Array.isArray(raw.efforts)) throw syncError('ZEUS_ZENTAO_EFFORT_RESPONSE_INVALID', '禅道日志响应格式无效，无法确认日志列表。', 502);
      /** 将受限响应归一化为日志数组，不把缺失小时数伪造为零。 */
      const records: Record<string, unknown>[] = isRecord(raw.effort)
        ? Object.entries(raw.effort).flatMap(([id, value]) => (isRecord(value) ? [{ ...value, id: value.id ?? id }] : []))
        : ((Array.isArray(raw.effort) ? raw.effort : raw.efforts) as unknown[]).filter(isRecord);
      return {
        task: normalizeDetail('task', unwrapRecord(detail.payload), detail.instance, link.objectId),
        items: records
          .map(normalizeEffort)
          .filter((entry): entry is ZentaoTaskEffort => entry !== null)
          .sort((a, b) => b.date.localeCompare(a.date) || Number(b.id) - Number(a.id)),
      };
    },
    async recordEffort(instanceId, input, task) {
      validateZentaoEffort(input);
      /** 受控关联同时隔离实例和对象类型。 */
      const link = requireZentaoTaskLink(task, instanceId);
      /** 21.7.5 使用单元素数组登记一条日志，不发送历史累计工时。 */
      const response = await successfulRequest(instanceId, `/tasks/${encodeURIComponent(link.objectId)}/estimate`, 'POST', {
        date: [input.date],
        work: [input.work.trim()],
        consumed: [input.consumed],
        left: [input.left],
      });
      /** 写入返回必须确实指向目标任务，不能将错误报文当作成功。 */
      const raw = unwrapRecord(response.payload);
      if (objectIdFrom(raw, 'task') !== link.objectId || remoteHours(raw.consumed) === undefined || remoteHours(raw.left) === undefined)
        throw syncError('ZEUS_ZENTAO_EFFORT_RESULT_UNKNOWN', '禅道已响应，但工时登记结果未能确认，请先在禅道核对，勿重复提交。', 502);
      return normalizeDetail('task', raw, response.instance, link.objectId);
    },
    async pushTask(instanceId, input, task) {
      validateZentaoTaskSyncInput(input);
      const existing = readTaskZentaoLink(task.sourceContextJson);
      if (existing && (existing.instanceId !== instanceId || existing.kind !== input.kind)) throw syncError('ZEUS_ZENTAO_LINK_CONFLICT', '任务已关联禅道对象，不能更换实例或对象类型。', 409);
      if (!existing && input.kind !== 'task') throw syncError('ZEUS_ZENTAO_SYNC_KIND_INVALID', '新同步对象统一创建为禅道任务。', 400);
      if (existing && ((existing.projectId && existing.projectId !== input.projectId) || (existing.executionId && input.executionId && existing.executionId !== input.executionId)))
        throw syncError('ZEUS_ZENTAO_LINK_CONFLICT', '已关联任务不能在同步时更换禅道项目或执行。', 409);
      const sameRemote = existing?.instanceId === instanceId && existing.kind === input.kind;
      const remoteId = sameRemote ? existing?.objectId : undefined;
      const projectId = input.projectId || existing?.projectId;
      const executionId = input.executionId || existing?.executionId;
      const productId = input.productId || existing?.productId;
      if (!projectId) throw syncError('ZEUS_ZENTAO_PROJECT_REQUIRED', '同步到禅道前必须选择项目。', 400);

      let path: string;
      let body: Record<string, unknown>;
      if (input.kind === 'task') {
        if (!remoteId && !executionId) throw syncError('ZEUS_ZENTAO_EXECUTION_REQUIRED', '创建禅道任务前必须选择执行。', 400);
        path = remoteId ? `/tasks/${encodeURIComponent(remoteId)}` : `/executions/${encodeURIComponent(executionId!)}/tasks`;
        body = taskPayload(task, { ...input, projectId, executionId });
        if (remoteId && input.remoteType === undefined) delete body.type;
        if (!remoteId) {
          /** 新建任务默认指派给当前验证账号。 */
          const instance = await options.credentials.get(instanceId);
          body.assignedTo = instance?.account;
        } else if (input.estimate !== undefined) {
          /** 已开始任务的最初预计工时保持不变。 */
          const current = await successfulRequest(instanceId, path);
          if (unwrapRecord(current.payload).status !== 'wait') delete body.estimate;
        }
      } else {
        // 历史 Bug 只更新原对象，新建始终进入任务分支。
        path = `/bugs/${encodeURIComponent(remoteId!)}`;
        body = bugPayload(task, { ...input, projectId, executionId, productId });
        if (input.remoteType === undefined) delete body.type;
      }
      if (remoteId) {
        // 内容同步不承担移动远端对象的职责，接口层也不发送这些关联字段。
        delete body.project;
        delete body.execution;
        delete body.product;
      }
      const response = await successfulRequest(instanceId, path, remoteId ? 'PUT' : 'POST', body);
      const returned = unwrapRecord(response.payload);
      const objectId = extractObjectId(response.payload, input.kind);
      if (!objectId) throw syncError('ZEUS_ZENTAO_OBJECT_ID_MISSING', '禅道已响应，但未返回对象编号，请先在禅道核对写入结果。', 502);
      if (remoteId && objectId !== remoteId) throw syncError('ZEUS_ZENTAO_OBJECT_ID_MISMATCH', '禅道返回的对象编号与已关联对象不一致，请先核对写入结果。', 502);
      const remote = normalizeSummary(input.kind, returned, response.instance, objectId) ?? {
        kind: input.kind,
        objectId,
        title: task.title,
        status: '已同步',
        priority: String(remotePriority(task.priority)),
        sourceUrl: buildSourceUrl(response.instance, input.kind, objectId),
        projectId,
        executionId,
        productId,
        updatedAt: now(),
      };
      const syncedAt = now();
      return {
        mode: remoteId ? 'updated' : 'created',
        remote,
        link: {
          instanceId,
          kind: input.kind,
          objectId,
          sourceUrl: remote.sourceUrl,
          projectId,
          executionId,
          productId,
          remoteTitle: remote.title || task.title,
          remoteUpdatedAt: remote.updatedAt,
          lastSyncedAt: syncedAt,
        },
      };
    },
  };
}

function taskPayload(task: ZeusTaskRecord, input: ZentaoTaskSyncRequest & { projectId: string; executionId?: string }): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    name: task.title,
    desc: [
      task.description,
      task.defectCurrentState ? `缺陷现象：\n${task.defectCurrentState}` : '',
      task.defectReproductionSteps ? `重现步骤：\n${task.defectReproductionSteps}` : '',
      task.defectExpectedOutcome ? `期望结果：\n${task.defectExpectedOutcome}` : '',
      task.optimizationCurrentState ? `优化现状：\n${task.optimizationCurrentState}` : '',
      task.optimizationExpectedOutcome ? `优化目标：\n${task.optimizationExpectedOutcome}` : '',
    ]
      .filter(Boolean)
      .join('\n\n'),
    type: input.remoteType?.trim() || 'devel',
    pri: remotePriority(task.priority),
    project: input.projectId,
  };
  if (input.executionId) payload.execution = input.executionId;
  if (input.estStarted) payload.estStarted = input.estStarted;
  if (input.deadline) payload.deadline = input.deadline;
  if (input.estimate !== undefined) payload.estimate = input.estimate;
  return payload;
}

function bugPayload(task: ZeusTaskRecord, input: ZentaoTaskSyncRequest & { projectId: string; executionId?: string; productId?: string }): Record<string, unknown> {
  const sections = [
    task.defectCurrentState ? `缺陷现象：\n${task.defectCurrentState}` : '',
    task.defectReproductionSteps ? `重现步骤：\n${task.defectReproductionSteps}` : '',
    task.defectExpectedOutcome ? `期望结果：\n${task.defectExpectedOutcome}` : '',
    task.description ? `补充说明：\n${task.description}` : '',
  ].filter(Boolean);
  const payload: Record<string, unknown> = {
    title: task.title,
    steps: sections.join('\n\n'),
    product: input.productId,
    project: input.projectId,
    pri: remotePriority(task.priority),
    severity: 3,
    type: input.remoteType?.trim() || 'codeerror',
  };
  if (input.executionId) payload.execution = input.executionId;
  return payload;
}

/** 只接受禅道实际返回的有限非负小时数。 */
function remoteHours(value: unknown): number | undefined {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return undefined;
  /** 外部系统的数值字符串在适配边界转换。 */
  const hours = Number(value);
  return Number.isFinite(hours) && hours >= 0 ? hours : undefined;
}

/** 任务详情在读取、写入和日志回执中采用同一归一化规则。 */
function normalizeDetail(kind: ZentaoRemoteKind, raw: Record<string, unknown>, instance: ZentaoInstanceRecord, id: string): ZentaoRemoteItemDetail {
  if (objectIdFrom(raw, kind) && objectIdFrom(raw, kind) !== id) throw syncError('ZEUS_ZENTAO_OBJECT_INVALID', '禅道返回的对象编号与请求不一致。', 502);
  /** 对象名称与身份必须来自真实响应。 */
  const summary = normalizeSummary(kind, raw, instance, id);
  if (!summary) throw syncError('ZEUS_ZENTAO_OBJECT_INVALID', '禅道返回的对象详情不完整。', 502);
  return {
    ...summary,
    description: firstText(raw, ['desc', 'description', 'spec', 'content', ...(kind === 'bug' ? ['steps'] : [])]) ?? '',
    currentState: firstText(raw, ['currentState', 'phenomenon', 'actual']) ?? '',
    reproductionSteps: firstText(raw, ['steps', 'reproductionSteps', 'reproduction']) ?? '',
    expectedOutcome: firstText(raw, ['expectedOutcome', 'expected', 'expect', 'verify']) ?? '',
    estStarted: firstText(raw, ['estStarted', 'estStart', 'started']) ?? undefined,
    deadline: firstText(raw, ['deadline', 'dueDate']) ?? undefined,
    remoteType: firstText(raw, ['type', 'taskType', 'bugType']) ?? undefined,
    estimate: remoteHours(raw.estimate),
    consumed: remoteHours(raw.consumed),
    left: remoteHours(raw.left),
  };
}

/** 无效日志不显示为合法的零小时记录。 */
function normalizeEffort(raw: Record<string, unknown>): ZentaoTaskEffort | null {
  /** 日志自己的稳定编号。 */
  const id = objectIdFrom(raw, 'effort');
  /** 每条日志的本次耗时和当时剩余工时。 */
  const consumed = remoteHours(raw.consumed);
  const left = remoteHours(raw.left);
  if (!id || consumed === undefined || left === undefined || raw.deleted === '1' || raw.deleted === 1) return null;
  return { id, date: firstText(raw, ['date']) ?? '', account: firstText(raw, ['account']) ?? '', work: firstText(raw, ['work']) ?? '', consumed, left };
}

/** 拒绝客户端指定任意远端任务，工时只登记到本地已关联对象。 */
export function requireZentaoTaskLink(task: ZeusTaskRecord, instanceId: string): ZentaoTaskSyncLink {
  /** 解析已有受控关联，不创建新的关联。 */
  const link = readTaskZentaoLink(task.sourceContextJson);
  if (!link || link.instanceId !== instanceId || link.kind !== 'task') throw syncError('ZEUS_ZENTAO_TASK_LINK_REQUIRED', '工时登记仅支持当前实例中已关联的禅道任务。', 409);
  return link;
}

/** HTTP 入口和服务写入均校验工时，防止绕过界面约束。 */
export function validateZentaoEffort(input: ZentaoTaskEffortRequest): void {
  if (typeof input.taskId !== 'string' || !input.taskId.trim() || typeof input.expectedUpdatedAt !== 'string' || !input.expectedUpdatedAt.trim()) throw syncError('ZEUS_ZENTAO_EFFORT_INPUT_INVALID', '任务编号和修订时间不能为空。', 400);
  if (typeof input.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(input.date)) throw syncError('ZEUS_ZENTAO_DATE_INVALID', '工作日期格式无效。', 400);
  /** 额外检查日历有效性，拒绝二月三十日等日期。 */
  const date = new Date(`${input.date}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== input.date) throw syncError('ZEUS_ZENTAO_DATE_INVALID', '工作日期无效。', 400);
  if (typeof input.consumed !== 'number' || !Number.isFinite(input.consumed) || input.consumed <= 0 || typeof input.left !== 'number' || !Number.isFinite(input.left) || input.left < 0)
    throw syncError('ZEUS_ZENTAO_HOURS_INVALID', '本次耗时必须大于零，剩余工时必须为非负数，单位为小时。', 400);
  if (typeof input.work !== 'string' || !input.work.trim()) throw syncError('ZEUS_ZENTAO_WORK_REQUIRED', '请填写本次工作说明。', 400);
}

function normalizeProject(value: Record<string, unknown>): ZentaoRemoteProjectSummary | null {
  const id = objectIdFrom(value, 'project');
  const name = firstText(value, ['name', 'projectName', 'title']);
  return id && name ? { id, name, status: firstText(value, ['status', 'statusName']) ?? undefined } : null;
}

function normalizeExecution(value: Record<string, unknown>, projectId: string): ZentaoRemoteExecutionSummary | null {
  const id = objectIdFrom(value, 'execution');
  const name = firstText(value, ['name', 'executionName', 'title']);
  return id && name ? { id, projectId, name, status: firstText(value, ['status', 'statusName']) ?? undefined } : null;
}

function normalizeProduct(value: Record<string, unknown>): ZentaoRemoteProductSummary | null {
  const id = objectIdFrom(value, 'product');
  const name = firstText(value, ['name', 'productName', 'title']);
  return id && name ? { id, name, status: firstText(value, ['status', 'statusName']) ?? undefined } : null;
}

function normalizeSummary(kind: ZentaoRemoteKind, value: Record<string, unknown>, instance: ZentaoInstanceRecord, fallbackId?: string): ZentaoRemoteItemSummary | null {
  const objectId = fallbackId ?? objectIdFrom(value, kind);
  const title = firstText(value, ['name', 'title', 'bugTitle', 'taskName']) ?? '';
  if (!objectId || !title) return null;
  const project = nestedIdentity(value, ['project', 'projectID', 'projectId']);
  const execution = nestedIdentity(value, ['execution', 'executionID', 'executionId']);
  const product = nestedIdentity(value, ['product', 'productID', 'productId']);
  return {
    kind,
    objectId,
    title,
    status: firstText(value, ['status', 'statusName', 'state']) ?? '未知',
    priority: firstText(value, ['pri', 'priority', 'priorityName']) ?? '未设置',
    sourceUrl: buildSourceUrl(instance, kind, objectId),
    projectId: project.id,
    projectName: project.name,
    executionId: execution.id,
    executionName: execution.name,
    productId: product.id,
    productName: product.name,
    updatedAt: firstText(value, ['lastEditedDate', 'editedDate', 'updatedAt', 'updateDate', 'lastEdited']) ?? undefined,
  };
}

function extractRecords(payload: unknown, preferredKeys: string[]): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload.filter(isRecord).slice(0, maximumRemoteItems);
  if (!isRecord(payload)) return [];
  for (const key of preferredKeys) {
    const value = payload[key];
    if (Array.isArray(value)) return value.filter(isRecord).slice(0, maximumRemoteItems);
  }
  if (Array.isArray(payload.data)) return payload.data.filter(isRecord).slice(0, maximumRemoteItems);
  if (isRecord(payload.data)) return extractRecords(payload.data, preferredKeys);
  return [];
}

function extractMyWorkRecords(payload: unknown, kind: ZentaoRemoteKind): Record<string, unknown>[] {
  const preferredKeys = kind === 'task' ? ['tasks', 'items'] : ['bugs', 'items'];
  for (const candidate of nestedPayloadCandidates(payload)) {
    const records = extractRecords(candidate, preferredKeys);
    if (records.length > 0) return records;
    if (!isRecord(candidate)) continue;
    for (const key of preferredKeys) {
      const records = keyedRecords(candidate[key], kind);
      if (records.length > 0) return records;
    }
  }
  return [];
}

function nestedPayloadCandidates(payload: unknown): unknown[] {
  const candidates: unknown[] = [];
  let current = payload;
  for (let index = 0; index < 4; index += 1) {
    candidates.push(current);
    if (typeof current === 'string') {
      try {
        current = JSON.parse(current) as unknown;
        continue;
      } catch {
        break;
      }
    }
    if (isRecord(current) && typeof current.data === 'string') {
      try {
        current = JSON.parse(current.data) as unknown;
        continue;
      } catch {
        break;
      }
    }
    if (isRecord(current) && isRecord(current.data)) {
      current = current.data;
      continue;
    }
    if (isRecord(current) && isRecord(current.result)) {
      current = current.result;
      continue;
    }
    break;
  }
  return candidates;
}

function keyedRecords(value: unknown, kind: ZentaoRemoteKind): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter(isRecord).slice(0, maximumRemoteItems);
  if (!isRecord(value)) return [];
  return Object.entries(value)
    .map(([key, candidate]) => {
      if (!isRecord(candidate)) return null;
      const normalizedKey = key.trim();
      const objectId = /^\d+$/u.test(normalizedKey) ? normalizedKey : objectIdFrom(candidate, kind);
      return objectId ? { ...candidate, id: objectId } : null;
    })
    .filter((candidate): candidate is Record<string, unknown> & { id: string } => Boolean(candidate))
    .slice(0, maximumRemoteItems);
}

function unwrapRecord(payload: unknown): Record<string, unknown> {
  if (!isRecord(payload)) return {};
  if (isRecord(payload.data)) return payload.data;
  if (isRecord(payload.result)) return payload.result;
  return payload;
}

function objectIdFrom(value: Record<string, unknown>, kind: string): string | null {
  // 列表项有时同时包含关联字段（例如项目项里的 project=0）；对象自身的 id 必须优先。
  const keys = ['id', `${kind}ID`, `${kind}Id`, kind];
  for (const key of keys) {
    const candidate = value[key];
    const id = typeof candidate === 'number' ? String(candidate) : typeof candidate === 'string' ? candidate.trim() : '';
    if (/^\d+$/u.test(id)) return id;
  }
  return null;
}

function extractObjectId(payload: unknown, kind: ZentaoRemoteKind): string | null {
  const record = unwrapRecord(payload);
  return objectIdFrom(record, kind) ?? (isRecord(record.data) ? objectIdFrom(record.data, kind) : null);
}

function nestedIdentity(value: Record<string, unknown>, keys: string[]): { id?: string; name?: string } {
  for (const key of keys) {
    const candidate = value[key];
    if (isRecord(candidate)) {
      const id = typeof candidate.id === 'number' ? String(candidate.id) : typeof candidate.id === 'string' ? candidate.id.trim() : undefined;
      const name = firstText(candidate, ['name', 'title']);
      if (id || name) return { id, name: name ?? undefined };
    }
    const id = typeof candidate === 'number' ? String(candidate) : typeof candidate === 'string' && /^\d+$/u.test(candidate.trim()) ? candidate.trim() : undefined;
    if (id) return { id };
  }
  return {};
}

function firstText(value: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    if (typeof candidate === 'number') return String(candidate);
  }
  return null;
}

function remotePriority(priority: string): number {
  const normalized = priority.trim().toLowerCase();
  if (/^p[0-4]$/u.test(normalized)) return Number(normalized.slice(1)) + 1;
  const numeric = Number(normalized);
  return Number.isInteger(numeric) && numeric >= 1 && numeric <= 5 ? numeric : 3;
}

function buildSourceUrl(instance: ZentaoInstanceRecord, kind: ZentaoRemoteKind, objectId: string): string {
  return `${instance.host}${instance.basePath}/${kind}-view-${encodeURIComponent(objectId)}.html`;
}

function readTaskZentaoLink(sourceContextJson: string): ReturnType<typeof parseZentaoTaskSyncLink> {
  try {
    const parsed = JSON.parse(sourceContextJson) as unknown;
    if (!isRecord(parsed)) return null;
    return parseZentaoTaskSyncLink(parsed.zentao);
  } catch {
    return null;
  }
}

/** 在远端写入标记之前检查同步字段，错误输入可以安全修正后再提交。 */
export function validateZentaoTaskSyncInput(input: ZentaoTaskSyncRequest): void {
  if (!input.taskId.trim() || !input.expectedUpdatedAt.trim() || !input.projectId.trim()) throw syncError('ZEUS_ZENTAO_SYNC_INPUT_INVALID', '禅道同步参数不完整。', 400);
  if (input.kind !== 'task' && input.kind !== 'bug') throw syncError('ZEUS_ZENTAO_SYNC_KIND_INVALID', '禅道同步对象类型无效。', 400);
  for (const value of [input.estStarted, input.deadline, input.remoteType]) {
    if (value !== undefined && typeof value !== 'string') throw syncError('ZEUS_ZENTAO_SYNC_INPUT_INVALID', '禅道日期和任务类型必须为文本。', 400);
  }
  if (input.estStarted && !/^\d{4}-\d{2}-\d{2}$/u.test(input.estStarted)) throw syncError('ZEUS_ZENTAO_DATE_INVALID', '预计开始日期格式无效。', 400);
  if (input.deadline && !/^\d{4}-\d{2}-\d{2}$/u.test(input.deadline)) throw syncError('ZEUS_ZENTAO_DATE_INVALID', '截止日期格式无效。', 400);
  if (input.estimate !== undefined && (typeof input.estimate !== 'number' || !Number.isFinite(input.estimate) || input.estimate < 0)) throw syncError('ZEUS_ZENTAO_HOURS_INVALID', '预计工时必须为非负数，单位为小时。', 400);
}

function requireId(value: string | undefined, label: string): string {
  const normalized = value?.trim() ?? '';
  if (!/^\d+$/u.test(normalized)) throw syncError('ZEUS_ZENTAO_ID_INVALID', `${label}编号无效。`, 400);
  return normalized;
}

function requireObjectId(value: string): string {
  return requireId(value, '禅道对象');
}

function clampInteger(value: number | undefined, minimum: number, maximum: number, fallback: number): number {
  return Number.isSafeInteger(value) ? Math.min(maximum, Math.max(minimum, value!)) : fallback;
}

function remoteMessage(payload: unknown, status: number): string {
  if (isRecord(payload)) {
    const message = firstText(payload, ['message', 'error', 'msg']);
    if (message) return `禅道接口返回 HTTP ${status}：${message.slice(0, 256)}`;
  }
  return `禅道接口返回 HTTP ${status}。`;
}

function syncError(code: string, message: string, statusCode: number): Error & { code: string; statusCode: number } {
  return Object.assign(new Error(message), { code, statusCode });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
