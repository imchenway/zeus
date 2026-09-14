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
      const summary = normalizeSummary(kind, unwrapRecord(response.payload), response.instance, id);
      if (!summary) throw syncError('ZEUS_ZENTAO_OBJECT_INVALID', '禅道返回的数据缺少对象编号。', 502);
      const raw = unwrapRecord(response.payload);
      const reproductionSteps = firstText(raw, ['steps', 'reproductionSteps', 'reproduction']) ?? '';
      const expectedOutcome = firstText(raw, ['expectedOutcome', 'expected', 'expect', 'verify']) ?? '';
      const description = firstText(raw, ['desc', 'description', 'spec', 'content']) ?? (kind === 'bug' ? reproductionSteps : '');
      return {
        ...summary,
        description,
        currentState: firstText(raw, ['currentState', 'phenomenon', 'actual']) ?? '',
        reproductionSteps,
        expectedOutcome,
        estStarted: firstText(raw, ['estStarted', 'estStart', 'started']) ?? undefined,
        deadline: firstText(raw, ['deadline', 'dueDate']) ?? undefined,
        remoteType: firstText(raw, ['type', 'taskType', 'bugType']) ?? undefined,
      };
    },
    async pushTask(instanceId, input, task) {
      validatePushInput(input);
      const existing = readTaskZentaoLink(task.sourceContextJson);
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
      } else {
        if (!remoteId && !productId) throw syncError('ZEUS_ZENTAO_PRODUCT_REQUIRED', '创建禅道缺陷前必须选择产品。', 400);
        path = remoteId ? `/bugs/${encodeURIComponent(remoteId)}` : `/products/${encodeURIComponent(productId!)}/bugs`;
        body = bugPayload(task, { ...input, projectId, executionId, productId });
      }
      const response = await successfulRequest(instanceId, path, remoteId ? 'PUT' : 'POST', body);
      const returned = unwrapRecord(response.payload);
      const objectId = remoteId ?? extractObjectId(response.payload, input.kind);
      if (!objectId) throw syncError('ZEUS_ZENTAO_OBJECT_ID_MISSING', '禅道已响应，但没有返回新对象编号；本地未确认关联。', 502);
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
    desc: task.description,
    type: input.remoteType?.trim() || 'devel',
    pri: remotePriority(task.priority),
    project: input.projectId,
  };
  if (input.executionId) payload.execution = input.executionId;
  if (input.estStarted) payload.estStarted = input.estStarted;
  if (input.deadline) payload.deadline = input.deadline;
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

function validatePushInput(input: ZentaoTaskSyncRequest): void {
  if (!input.taskId.trim() || !input.expectedUpdatedAt.trim() || !input.projectId.trim()) throw syncError('ZEUS_ZENTAO_SYNC_INPUT_INVALID', '禅道同步参数不完整。', 400);
  if (input.kind !== 'task' && input.kind !== 'bug') throw syncError('ZEUS_ZENTAO_SYNC_KIND_INVALID', '禅道同步对象类型无效。', 400);
  if (input.estStarted && !/^\d{4}-\d{2}-\d{2}$/u.test(input.estStarted)) throw syncError('ZEUS_ZENTAO_DATE_INVALID', '预计开始日期格式无效。', 400);
  if (input.deadline && !/^\d{4}-\d{2}-\d{2}$/u.test(input.deadline)) throw syncError('ZEUS_ZENTAO_DATE_INVALID', '截止日期格式无效。', 400);
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
