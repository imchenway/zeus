import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { Client, StreamableHTTPClientTransport, type Tool } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { SecretStore } from './securityCore.js';
import type { PluginApprovalMode } from '@zeus/storage';
import type { PluginActivationState } from './zeusPluginService.js';

const maximumToolResultBytes = 8 * 1024 * 1024;
const maximumAppDocumentBytes = 2 * 1024 * 1024;
/** 弱网或失联 MCP Server 最多占用一次按需发现五秒。 */
const mcpCatalogConnectionTimeoutMs = 5_000;

export interface ZeusPluginDynamicTool {
  name: string;
  namespace: string;
  toolName: string;
  label: string;
  description: string;
  inputSchema: Record<string, unknown>;
  pluginId: string;
  pluginRevisionId: string;
  serverId: string;
  originalToolName: string;
  approvalMode: PluginApprovalMode;
  appResourceUri: string | null;
  definitionSha256: string;
  /** MCP 明确声明的只读能力；缺失时不能在只读模式执行。 */
  readOnly?: boolean;
}

export interface ZeusPluginMcpAppDocument {
  resourceUri: string;
  html: string;
  csp: Record<string, unknown>;
  permissions: Record<string, unknown>;
  domain: string | null;
}

export interface ZeusPluginMcpToolResult {
  text: string;
  /** 保留 MCP 实际返回的图片，不能把 base64 当成正文送给模型。 */
  images?: Array<{ data: string; mimeType: string }>;
  structuredContent: unknown;
  isError: boolean;
  app: ZeusPluginMcpAppDocument | null;
}

export interface ZeusPluginMcpCatalog {
  tools: ZeusPluginDynamicTool[];
  appTools: ZeusPluginDynamicTool[];
  failures: Array<{ pluginId: string; pluginRevisionId: string; serverId: string; error: string }>;
}

/** 工具审批的来源；每种来源都必须绑定同一工具定义和最终参数。 */
export type ZeusPluginMcpApprovalSource = 'policy' | 'pre_tool_hook' | 'permission_hook' | 'user';

/** 传到最终执行边界的审批依据，禁止跨修订、定义、策略或参数复用。 */
export interface ZeusPluginMcpApprovalEvidence {
  source: ZeusPluginMcpApprovalSource;
  pluginRevisionId: string;
  definitionSha256: string;
  approvalMode: PluginApprovalMode;
  argumentsSha256: string;
}

/** 在所有等待结束后按最终参数生成审批依据。 */
export function createZeusPluginMcpApprovalEvidence(tool: ZeusPluginDynamicTool, args: Record<string, unknown>, source: ZeusPluginMcpApprovalSource): ZeusPluginMcpApprovalEvidence {
  return {
    source,
    pluginRevisionId: tool.pluginRevisionId,
    definitionSha256: tool.definitionSha256,
    approvalMode: tool.approvalMode,
    argumentsSha256: createHash('sha256').update(canonicalJson(args)).digest('hex'),
  };
}

export interface ZeusPluginMcpBroker {
  listTools(conversationId: string): Promise<ZeusPluginMcpCatalog>;
  invoke(input: { conversationId: string; tool: ZeusPluginDynamicTool; args: Record<string, unknown>; approval: ZeusPluginMcpApprovalEvidence; signal?: AbortSignal }): Promise<ZeusPluginMcpToolResult>;
  invokeApp(input: { conversationId: string; tool: ZeusPluginDynamicTool; args: Record<string, unknown>; approval: ZeusPluginMcpApprovalEvidence; signal?: AbortSignal }): Promise<ZeusPluginMcpToolResult>;
  invokeHook(input: { conversationId: string; pluginId: string; pluginRevisionId: string; serverId: string; toolName: string; args: Record<string, unknown>; signal: AbortSignal }): Promise<unknown>;
  closeConversation(conversationId: string): Promise<void>;
  close(): Promise<void>;
}

export function createZeusPluginMcpBroker(options: {
  dataRoot: string;
  getActivations(conversationId: string): Promise<PluginActivationState[]>;
  secretStore: Pick<SecretStore, 'getSecret'>;
  publish?: (type: string, payload: Record<string, unknown>) => void;
}): ZeusPluginMcpBroker {
  if (!isAbsolute(options.dataRoot)) throw new Error('Plugin MCP dataRoot 必须是绝对路径。');
  const connections = new Map<string, Promise<McpConnection>>();

  /** 每次调用重新读取当前启用和权限状态，不复用会话级目录。 */
  async function listTools(conversationId: string): Promise<ZeusPluginMcpCatalog> {
    return buildCatalog(conversationId);
  }

  /** 当前 MCP Server 并行连接，单个慢服务不再串行放大等待时间。 */
  async function buildCatalog(conversationId: string): Promise<ZeusPluginMcpCatalog> {
    const activations = await options.getActivations(conversationId);
    const tools: ZeusPluginDynamicTool[] = [];
    const appTools: ZeusPluginDynamicTool[] = [];
    const failures: ZeusPluginMcpCatalog['failures'] = [];
    const servers = activations.flatMap((activation) => activationServers(activation).map((server) => ({ activation, server })));
    const activeConnectionKeys = new Set(servers.map(({ activation, server }) => connectionKey(conversationId, activation, server)));
    await closeStaleConnections(conversationId, activeConnectionKeys);
    const results = await Promise.all(
      servers.map(async ({ activation, server }) => {
        try {
          const connection = await requireConnection(conversationId, activation, server);
          return { activation, server, connection };
        } catch (error) {
          return { activation, server, error };
        }
      }),
    );
    for (const result of results) {
      const { activation, server } = result;
      if (result.connection) {
        for (const tool of result.connection.tools) {
          const visibility = toolVisibility(tool);
          const policy = resolvePolicy(activation, server.id, tool.name);
          if (!policy.enabled) continue;
          const namespace = toolNamespace(activation.name, server.id);
          const safeToolName = safeToolIdentity(tool.name);
          const name = `${namespace}__${safeToolName}`;
          if (tools.some((candidate) => candidate.name === name)) throw new Error(`MCP 工具规范化后重名：${tool.name}`);
          const dynamicTool: ZeusPluginDynamicTool = {
            name,
            namespace,
            toolName: safeToolName,
            label: tool.title?.trim() || `${activation.name}/${server.id}/${tool.name}`,
            description: tool.description?.trim() || `调用 ${activation.name} Plugin 的 ${tool.name} MCP 工具。`,
            inputSchema: normalizeInputSchema(tool.inputSchema),
            readOnly: tool.annotations?.readOnlyHint === true,
            pluginId: activation.pluginId,
            pluginRevisionId: activation.pluginRevisionId,
            serverId: server.id,
            originalToolName: tool.name,
            approvalMode: policy.approvalMode,
            appResourceUri: appResourceUri(tool),
            definitionSha256: toolDefinitionSha256(tool),
          };
          if (visibility !== 'app') tools.push(dynamicTool);
          if (visibility !== 'model') appTools.push(dynamicTool);
        }
        continue;
      }
      const failure = {
        pluginId: activation.pluginId,
        pluginRevisionId: activation.pluginRevisionId,
        serverId: server.id,
        error: result.error instanceof Error ? result.error.message : String(result.error),
      };
      failures.push(failure);
      options.publish?.('plugin.mcp.connection_failed', { conversationId, ...failure });
    }
    tools.sort((left, right) => left.name.localeCompare(right.name));
    appTools.sort((left, right) => left.name.localeCompare(right.name));
    return { tools, appTools, failures };
  }

  /** 按已检查的工具身份调用模型可见工具。 */
  async function invoke(input: { conversationId: string; tool: ZeusPluginDynamicTool; args: Record<string, unknown>; approval: ZeusPluginMcpApprovalEvidence; signal?: AbortSignal }): Promise<ZeusPluginMcpToolResult> {
    const catalog = await listTools(input.conversationId);
    const currentTool = catalog.tools.find((candidate) => sameToolIdentity(candidate, input.tool));
    if (!currentTool) throw brokerError('ZEUS_PLUGIN_MCP_TOOL_CHANGED', 'Plugin 修订、工具定义或权限策略已变化，请重新读取当前目录后调用。');
    return invokeCurrentTool(input.conversationId, currentTool, input.args, input.approval, input.signal);
  }

  /** 按已检查的 App 工具身份调用，并保留审批边界。 */
  async function invokeApp(input: { conversationId: string; tool: ZeusPluginDynamicTool; args: Record<string, unknown>; approval: ZeusPluginMcpApprovalEvidence; signal?: AbortSignal }): Promise<ZeusPluginMcpToolResult> {
    const catalog = await listTools(input.conversationId);
    const currentTool = catalog.appTools.find((candidate) => sameToolIdentity(candidate, input.tool));
    if (!currentTool) throw brokerError('ZEUS_PLUGIN_MCP_TOOL_CHANGED', 'MCP App 的 Plugin 修订、工具定义或权限策略已变化，请重新发起操作。');
    return invokeCurrentTool(input.conversationId, currentTool, input.args, input.approval, input.signal);
  }

  /** 执行前再次核对当前修订和工具定义，停用、删除或改权限后拒绝旧调用。 */
  async function invokeCurrentTool(conversationId: string, tool: ZeusPluginDynamicTool, args: Record<string, unknown>, approval: ZeusPluginMcpApprovalEvidence, signal?: AbortSignal): Promise<ZeusPluginMcpToolResult> {
    const activations = await options.getActivations(conversationId);
    const activation = activations.find((candidate) => candidate.pluginId === tool.pluginId && candidate.pluginRevisionId === tool.pluginRevisionId);
    if (!activation) throw brokerError('ZEUS_PLUGIN_ACTIVATION_MISSING', 'Plugin 已停用、删除或更新，当前工具调用已拒绝。');
    const server = activationServers(activation).find((candidate) => candidate.id === tool.serverId);
    if (!server) throw brokerError('ZEUS_PLUGIN_MCP_SERVER_NOT_FOUND', '当前 Plugin 修订中不存在该 MCP Server。');
    const policy = resolvePolicy(activation, server.id, tool.originalToolName);
    if (!policy.enabled || policy.approvalMode === 'deny') throw brokerError('ZEUS_PLUGIN_MCP_TOOL_DENIED', 'Plugin MCP 工具策略已拒绝执行。');
    if (policy.approvalMode !== tool.approvalMode) throw brokerError('ZEUS_PLUGIN_MCP_TOOL_CHANGED', 'Plugin MCP 工具审批策略已变化，请重新发起调用。');
    validateApprovalEvidence(tool, args, approval);
    const connection = await requireConnection(conversationId, activation, server);
    /** 最终调用前重新读取 Server 定义，不能只相信审批前的连接缓存。 */
    const listed = await connection.client.listTools();
    connection.tools = listed.tools;
    const definition = listed.tools.find((candidate) => candidate.name === tool.originalToolName);
    if (!definition || toolDefinitionSha256(definition) !== tool.definitionSha256) throw brokerError('ZEUS_PLUGIN_MCP_TOOL_CHANGED', 'MCP Server 的工具定义已变化，请重新读取当前目录后调用。');
    const result = await connection.client.callTool({ name: tool.originalToolName, arguments: structuredClone(args) }, { ...(signal ? { signal } : {}), timeout: 10 * 60_000, toolDefinition: definition });
    const text = toolResultText(result);
    const app = tool.appResourceUri ? await readMcpAppDocument(connection.client, tool.appResourceUri, signal) : null;
    options.publish?.('plugin.mcp.tool_completed', {
      conversationId,
      pluginId: tool.pluginId,
      pluginRevisionId: tool.pluginRevisionId,
      serverId: tool.serverId,
      toolName: tool.originalToolName,
      isError: result.isError === true,
      hasApp: Boolean(app),
    });
    return { text, images: toolResultImages(result.content), structuredContent: result.structuredContent, isError: result.isError === true, app };
  }

  /** Hook 信任记录绑定候选 Plugin 修订；执行时仍重新核对当前修订、策略和工具定义。 */
  async function invokeHook(input: { conversationId: string; pluginId: string; pluginRevisionId: string; serverId: string; toolName: string; args: Record<string, unknown>; signal: AbortSignal }): Promise<unknown> {
    const activations = await options.getActivations(input.conversationId);
    const activation = activations.find((candidate) => candidate.pluginId === input.pluginId && candidate.pluginRevisionId === input.pluginRevisionId);
    if (!activation) throw brokerError('ZEUS_PLUGIN_ACTIVATION_MISSING', 'Hook 引用的 Plugin 当前未启用。');
    const server = activationServers(activation).find((candidate) => candidate.id === input.serverId);
    if (!server) throw brokerError('ZEUS_PLUGIN_MCP_SERVER_NOT_FOUND', 'Hook 引用的 MCP Server 不存在。');
    const policy = resolvePolicy(activation, server.id, input.toolName);
    if (!policy.enabled || policy.approvalMode === 'deny') throw brokerError('ZEUS_PLUGIN_MCP_TOOL_DENIED', 'Hook 引用的 MCP 工具已被权限策略禁用。');
    const connection = await requireConnection(input.conversationId, activation, server);
    const listed = await connection.client.listTools();
    connection.tools = listed.tools;
    const definition = listed.tools.find((candidate) => candidate.name === input.toolName);
    if (!definition) throw brokerError('ZEUS_PLUGIN_MCP_TOOL_NOT_FOUND', 'Hook 引用的 MCP 工具不存在。');
    return connection.client.callTool({ name: input.toolName, arguments: structuredClone(input.args) }, { signal: input.signal, timeout: 10 * 60_000, toolDefinition: definition });
  }

  /** 同一会话和同一当前配置复用连接，配置变化会产生新身份。 */
  async function requireConnection(conversationId: string, activation: PluginActivationState, server: ActivationServer): Promise<McpConnection> {
    const key = connectionKey(conversationId, activation, server);
    const existing = connections.get(key);
    if (existing) return existing;
    const pending = connect(activation, server).catch((error) => {
      connections.delete(key);
      throw error;
    });
    connections.set(key, pending);
    return pending;
  }

  /** 建立单个 MCP 连接并在有界时间内读取目录。 */
  async function connect(activation: PluginActivationState, server: ActivationServer): Promise<McpConnection> {
    const client = new Client({ name: 'zeus-plugin-host', version: '0.3.74' }, { enforceStrictCapabilities: true, listMaxPages: 64 });
    const dataDirectory = join(options.dataRoot, activation.pluginId);
    const transport =
      server.transport === 'stdio'
        ? new StdioClientTransport({
            command: expandEnvironment(requiredString(server.config.command, 'MCP command'), activation.installPath, dataDirectory),
            args: optionalStringArray(server.config.args).map((value) => expandEnvironment(value, activation.installPath, dataDirectory)),
            env: {
              ...getDefaultEnvironment(),
              ...expandedEnvironment(recordOrEmpty(server.config.env), activation.installPath, dataDirectory),
              PLUGIN_ROOT: activation.installPath,
              PLUGIN_DATA: dataDirectory,
              CLAUDE_PLUGIN_ROOT: activation.installPath,
              CLAUDE_PLUGIN_DATA: dataDirectory,
            },
            cwd: activation.installPath,
            stderr: 'pipe',
            maxBufferSize: 10 * 1024 * 1024,
          })
        : new StreamableHTTPClientTransport(new URL(requiredString(server.config.url, 'MCP url')), {
            requestInit: { headers: await remoteHeaders(server, activation, dataDirectory, options.secretStore) },
            reconnectionOptions: { maxReconnectionDelay: 10_000, initialReconnectionDelay: 1_000, reconnectionDelayGrowFactor: 1.5, maxRetries: 0 },
          });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const listed = await Promise.race([
        client.connect(transport).then(() => client.listTools()),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(brokerError('ZEUS_PLUGIN_MCP_CONNECTION_TIMEOUT', 'MCP Server 连接或目录读取超过五秒。')), mcpCatalogConnectionTimeoutMs);
        }),
      ]);
      return { client, tools: listed.tools, transport };
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  /** 关闭当前配置中已不存在的连接，防止停用或更新后继续复用旧进程。 */
  async function closeStaleConnections(conversationId: string, activeKeys: Set<string>): Promise<void> {
    const targets = [...connections.entries()].filter(([key]) => key.startsWith(`${conversationId}:`) && !activeKeys.has(key));
    await Promise.allSettled(
      targets.map(async ([key, promise]) => {
        connections.delete(key);
        const connection = await promise;
        await connection.client.close();
      }),
    );
  }

  async function closeConversation(conversationId: string): Promise<void> {
    const targets = [...connections.entries()].filter(([key]) => key.startsWith(`${conversationId}:`));
    await Promise.allSettled(
      targets.map(async ([key, promise]) => {
        connections.delete(key);
        const connection = await promise;
        await connection.client.close();
      }),
    );
  }

  async function close(): Promise<void> {
    const conversationIds = new Set([...connections.keys()].map((key) => key.slice(0, key.indexOf(':'))));
    await Promise.all([...conversationIds].map(closeConversation));
  }

  return { listTools, invoke, invokeApp, invokeHook, closeConversation, close };
}

type ActivationServer = { id: string; transport: 'stdio' | 'http'; config: Record<string, unknown> };
type McpConnection = { client: Client; tools: Tool[]; transport: StdioClientTransport | StreamableHTTPClientTransport };

function activationServers(activation: PluginActivationState): ActivationServer[] {
  const servers: ActivationServer[] = activation.components.mcpServers.map((server) => ({ id: server.id, transport: server.transport, config: server.config }));
  for (const connector of activation.connectors) {
    if (!connector.connected) continue;
    const config = connector.serverConfig;
    const transport = typeof config.command === 'string' ? 'stdio' : typeof config.url === 'string' ? 'http' : null;
    if (!transport) continue;
    if (servers.some((candidate) => candidate.id === connector.connectorId)) throw brokerError('ZEUS_PLUGIN_MCP_SERVER_DUPLICATE', `Connector ${connector.connectorId} 与 Plugin MCP Server 同名。`);
    servers.push({ id: connector.connectorId, transport, config: { ...config, __secretAccount: connector.secretAccount, __updatedAt: connector.updatedAt } });
  }
  return servers;
}

function resolvePolicy(activation: PluginActivationState, serverId: string, toolName: string): { enabled: boolean; approvalMode: PluginApprovalMode } {
  const exact = activation.mcpPolicies.find((policy) => policy.serverId === serverId && policy.toolName === toolName);
  const server = activation.mcpPolicies.find((policy) => policy.serverId === serverId && policy.toolName === '*');
  return exact ?? server ?? { enabled: true, approvalMode: 'prompt' };
}

/** 目录发现与最终执行必须引用完全相同的 Plugin、工具定义和审批策略。 */
function sameToolIdentity(left: ZeusPluginDynamicTool, right: ZeusPluginDynamicTool): boolean {
  return (
    left.name === right.name &&
    left.namespace === right.namespace &&
    left.toolName === right.toolName &&
    left.pluginId === right.pluginId &&
    left.pluginRevisionId === right.pluginRevisionId &&
    left.serverId === right.serverId &&
    left.originalToolName === right.originalToolName &&
    left.definitionSha256 === right.definitionSha256 &&
    left.approvalMode === right.approvalMode &&
    left.readOnly === right.readOnly &&
    left.appResourceUri === right.appResourceUri
  );
}

/** 校验审批确实属于本次工具身份和最终参数，策略收紧后旧依据立即失效。 */
function validateApprovalEvidence(tool: ZeusPluginDynamicTool, args: Record<string, unknown>, approval: ZeusPluginMcpApprovalEvidence): void {
  const argumentsSha256 = createHash('sha256').update(canonicalJson(args)).digest('hex');
  if (approval.pluginRevisionId !== tool.pluginRevisionId || approval.definitionSha256 !== tool.definitionSha256 || approval.approvalMode !== tool.approvalMode || approval.argumentsSha256 !== argumentsSha256) {
    throw brokerError('ZEUS_PLUGIN_MCP_APPROVAL_STALE', 'Plugin MCP 工具身份或参数已变化，原审批依据不能继续使用。');
  }
  if (tool.approvalMode === 'prompt' && approval.source === 'policy') {
    throw brokerError('ZEUS_PLUGIN_MCP_APP_APPROVAL_REQUIRED', 'Plugin MCP 工具需要本次 Hook 或用户审批。');
  }
}

async function remoteHeaders(server: ActivationServer, activation: PluginActivationState, dataDirectory: string, secretStore: Pick<SecretStore, 'getSecret'>): Promise<Record<string, string>> {
  const headers = expandedEnvironment(recordOrEmpty(server.config.headers), activation.installPath, dataDirectory);
  const secretAccount = typeof server.config.__secretAccount === 'string' ? server.config.__secretAccount : null;
  const secret = secretAccount ? await secretStore.getSecret(secretAccount) : undefined;
  if (secret) headers.Authorization = `Bearer ${secret}`;
  return headers;
}

function toolDefinitionSha256(tool: Tool): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        name: tool.name,
        title: tool.title ?? null,
        description: tool.description ?? null,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema ?? null,
        annotations: tool.annotations ?? null,
        execution: tool.execution ?? null,
        _meta: tool._meta ?? null,
      }),
    )
    .digest('hex');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

async function readMcpAppDocument(client: Client, resourceUri: string, signal?: AbortSignal): Promise<ZeusPluginMcpAppDocument> {
  if (!resourceUri.startsWith('ui://')) throw brokerError('ZEUS_PLUGIN_MCP_APP_URI_INVALID', 'MCP App resource URI 必须使用 ui://。');
  const result = await client.readResource({ uri: resourceUri }, { ...(signal ? { signal } : {}), timeout: 60_000, cacheMode: 'refresh' });
  const content = result.contents.find((candidate) => candidate.uri === resourceUri) ?? result.contents[0];
  if (!content || !('text' in content) || typeof content.text !== 'string') throw brokerError('ZEUS_PLUGIN_MCP_APP_RESOURCE_INVALID', 'MCP App 资源必须返回文本 HTML。');
  if (Buffer.byteLength(content.text, 'utf8') > maximumAppDocumentBytes) throw brokerError('ZEUS_PLUGIN_MCP_APP_TOO_LARGE', 'MCP App HTML 超过 2 MiB。');
  const mime = typeof content.mimeType === 'string' ? content.mimeType.toLowerCase() : '';
  if (mime !== 'text/html;profile=mcp-app' && mime !== 'text/html+skybridge') throw brokerError('ZEUS_PLUGIN_MCP_APP_MIME_INVALID', 'MCP App 资源 MIME 类型不受支持。');
  const metadata = isRecord(content._meta) ? content._meta : {};
  const ui = isRecord(metadata.ui) ? metadata.ui : {};
  const app = {
    resourceUri,
    html: content.text,
    csp: isRecord(ui.csp) ? ui.csp : {},
    permissions: isRecord(ui.permissions) ? ui.permissions : {},
    domain: typeof ui.domain === 'string' && ui.domain.trim() ? ui.domain.trim() : null,
  };
  if (Buffer.byteLength(JSON.stringify(app), 'utf8') > 768 * 1024) throw brokerError('ZEUS_PLUGIN_MCP_APP_EVENT_TOO_LARGE', 'MCP App 文档序列化后超过 768 KiB，无法安全进入会话事件流。');
  return app;
}

/** 图片沿内容通道传递，保留其余结果原有文本和结构化信息。 */
function toolResultText(result: { content: unknown[]; structuredContent?: unknown }): string {
  const text = result.content
    .filter((entry) => !isRecord(entry) || entry.type !== 'image')
    .map((entry) => (isRecord(entry) && entry.type === 'text' && typeof entry.text === 'string' ? entry.text : JSON.stringify(entry)))
    .filter(Boolean)
    .join('\n');
  const output = text || (result.structuredContent === undefined ? '' : JSON.stringify(result.structuredContent));
  if (Buffer.byteLength(output, 'utf8') > maximumToolResultBytes) throw brokerError('ZEUS_PLUGIN_MCP_RESULT_TOO_LARGE', 'MCP 工具结果超过 8 MiB。');
  return output;
}

/** 在 MCP 信任边界验证图片并控制总量，后续两条链路复用受管图片存储。 */
function toolResultImages(content: unknown[]): Array<{ data: string; mimeType: string }> {
  const images: Array<{ data: string; mimeType: string }> = [];
  let bytes = 0;
  for (const entry of content) {
    if (!isRecord(entry) || entry.type !== 'image') continue;
    if (typeof entry.data !== 'string' || typeof entry.mimeType !== 'string' || !/^image\/[a-z0-9.+-]+$/iu.test(entry.mimeType) || !/^[a-z0-9+/]+={0,2}$/iu.test(entry.data) || entry.data.length % 4 !== 0)
      throw brokerError('ZEUS_PLUGIN_MCP_IMAGE_INVALID', 'MCP 返回的图片格式无效。');
    bytes += Buffer.byteLength(entry.data, 'base64');
    if (bytes > maximumToolResultBytes) throw brokerError('ZEUS_PLUGIN_MCP_RESULT_TOO_LARGE', 'MCP 图片结果超过 8 MiB。');
    images.push({ data: entry.data, mimeType: entry.mimeType });
  }
  return images;
}

function appResourceUri(tool: Tool): string | null {
  const metadata = isRecord(tool._meta) ? tool._meta : {};
  const ui = isRecord(metadata.ui) ? metadata.ui : {};
  const value = typeof ui.resourceUri === 'string' ? ui.resourceUri : typeof metadata['ui/resourceUri'] === 'string' ? metadata['ui/resourceUri'] : null;
  return value?.trim() || null;
}

function toolVisibility(tool: Tool): 'model' | 'app' | 'both' {
  const metadata = isRecord(tool._meta) ? tool._meta : {};
  const ui = isRecord(metadata.ui) ? metadata.ui : {};
  const visibility = ui.visibility;
  if (visibility === 'app' || visibility === 'model') return visibility;
  if (Array.isArray(visibility)) {
    const model = visibility.includes('model');
    const app = visibility.includes('app');
    return model && app ? 'both' : app ? 'app' : 'model';
  }
  return 'both';
}

function normalizeInputSchema(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return { type: 'object', properties: {}, additionalProperties: true };
  return structuredClone(value);
}

function toolNamespace(pluginName: string, serverId: string): string {
  // app-server 保留 mcp__ 命名空间；共同工具使用 Zeus 身份，完整函数名不超过 64 字符。
  return `zeus_mcp_${createHash('sha256')
    .update(JSON.stringify([pluginName, serverId]))
    .digest('hex')
    .slice(0, 16)}`;
}

function safeToolIdentity(value: string): string {
  const normalized = value
    .replaceAll(/[^a-zA-Z0-9_-]/gu, '_')
    .replaceAll(/_+/gu, '_')
    .slice(0, 24);
  const base = normalized || 'tool';
  return `${base}_${createHash('sha256').update(value).digest('hex').slice(0, 8)}`;
}

/** 连接身份包含修订和配置摘要，防止更新后复用旧连接。 */
function connectionKey(conversationId: string, activation: PluginActivationState, server: ActivationServer): string {
  const configurationSha256 = createHash('sha256').update(canonicalJson(server.config)).digest('hex').slice(0, 16);
  return `${conversationId}:${activation.pluginRevisionId}:${server.id}:${configurationSha256}`;
}

function expandedEnvironment(values: Record<string, unknown>, pluginRoot: string, pluginData: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => {
      if (typeof value !== 'string') throw brokerError('ZEUS_PLUGIN_MCP_CONFIGURATION_INVALID', `MCP 环境或 Header ${key} 必须是字符串。`);
      return [key, expandEnvironment(value, pluginRoot, pluginData)];
    }),
  );
}

function expandEnvironment(value: string, pluginRoot: string, pluginData: string): string {
  return value.replaceAll('${PLUGIN_ROOT}', pluginRoot).replaceAll('${PLUGIN_DATA}', pluginData).replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginRoot).replaceAll('${CLAUDE_PLUGIN_DATA}', pluginData);
}

function optionalStringArray(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) throw brokerError('ZEUS_PLUGIN_MCP_CONFIGURATION_INVALID', 'MCP args 必须是字符串数组。');
  return value as string[];
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw brokerError('ZEUS_PLUGIN_MCP_CONFIGURATION_INVALID', `${label} 无效。`);
  return value.trim();
}

function brokerError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
