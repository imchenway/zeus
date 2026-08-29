import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { Client, StreamableHTTPClientTransport, type Tool } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { SecretStore } from '@zeus/security-core';
import type { PluginApprovalMode } from '@zeus/storage';
import type { PluginActivationSnapshot } from './zeusPluginService.js';

const maximumToolResultBytes = 8 * 1024 * 1024;
const maximumAppDocumentBytes = 2 * 1024 * 1024;

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
  structuredContent: unknown;
  isError: boolean;
  app: ZeusPluginMcpAppDocument | null;
}

export interface ZeusPluginMcpCatalog {
  tools: ZeusPluginDynamicTool[];
  appTools: ZeusPluginDynamicTool[];
  failures: Array<{ pluginId: string; pluginRevisionId: string; serverId: string; error: string }>;
}

export interface ZeusPluginMcpBroker {
  listTools(conversationId: string): Promise<ZeusPluginMcpCatalog>;
  invoke(input: { conversationId: string; namespace?: string | null; toolName: string; args: Record<string, unknown>; signal?: AbortSignal }): Promise<ZeusPluginMcpToolResult>;
  invokeApp(input: { conversationId: string; pluginId: string; serverId: string; toolName: string; args: Record<string, unknown>; approved: boolean; signal?: AbortSignal }): Promise<ZeusPluginMcpToolResult>;
  invokeHook(input: { conversationId: string; pluginId: string; serverId: string; toolName: string; args: Record<string, unknown>; signal: AbortSignal }): Promise<unknown>;
  closeConversation(conversationId: string): Promise<void>;
  close(): Promise<void>;
}

export function createZeusPluginMcpBroker(options: {
  dataRoot: string;
  getActivations(conversationId: string): Promise<PluginActivationSnapshot[]>;
  secretStore: Pick<SecretStore, 'getSecret'>;
  publish?: (type: string, payload: Record<string, unknown>) => void;
}): ZeusPluginMcpBroker {
  if (!isAbsolute(options.dataRoot)) throw new Error('Plugin MCP dataRoot 必须是绝对路径。');
  const connections = new Map<string, Promise<McpConnection>>();
  const catalogs = new Map<string, Promise<ZeusPluginMcpCatalog>>();

  async function listTools(conversationId: string): Promise<ZeusPluginMcpCatalog> {
    const existing = catalogs.get(conversationId);
    if (existing) return existing;
    const pending = buildCatalog(conversationId).catch((error) => {
      catalogs.delete(conversationId);
      throw error;
    });
    catalogs.set(conversationId, pending);
    return pending;
  }

  async function buildCatalog(conversationId: string): Promise<ZeusPluginMcpCatalog> {
    const activations = await options.getActivations(conversationId);
    const tools: ZeusPluginDynamicTool[] = [];
    const appTools: ZeusPluginDynamicTool[] = [];
    const failures: ZeusPluginMcpCatalog['failures'] = [];
    for (const activation of activations) {
      for (const server of activationServers(activation)) {
        try {
          const connection = await requireConnection(conversationId, activation, server);
          for (const tool of connection.tools) {
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
        } catch (error) {
          const failure = {
            pluginId: activation.pluginId,
            pluginRevisionId: activation.pluginRevisionId,
            serverId: server.id,
            error: error instanceof Error ? error.message : String(error),
          };
          failures.push(failure);
          options.publish?.('plugin.mcp.connection_failed', { conversationId, ...failure });
        }
      }
    }
    tools.sort((left, right) => left.name.localeCompare(right.name));
    appTools.sort((left, right) => left.name.localeCompare(right.name));
    return { tools, appTools, failures };
  }

  async function invoke(input: { conversationId: string; namespace?: string | null; toolName: string; args: Record<string, unknown>; signal?: AbortSignal }): Promise<ZeusPluginMcpToolResult> {
    const catalog = await listTools(input.conversationId);
    const tool = catalog.tools.find((candidate) => (input.namespace ? candidate.namespace === input.namespace && candidate.toolName === input.toolName : candidate.name === input.toolName));
    if (!tool) throw brokerError('ZEUS_PLUGIN_MCP_TOOL_NOT_FOUND', '当前会话的冻结 Plugin 修订未注册该 MCP 工具。');
    if (tool.approvalMode === 'deny') throw brokerError('ZEUS_PLUGIN_MCP_TOOL_DENIED', 'Plugin MCP 工具策略已拒绝执行。');
    return invokeFrozenTool(input.conversationId, tool, input.args, input.signal);
  }

  async function invokeApp(input: { conversationId: string; pluginId: string; serverId: string; toolName: string; args: Record<string, unknown>; approved: boolean; signal?: AbortSignal }): Promise<ZeusPluginMcpToolResult> {
    const catalog = await listTools(input.conversationId);
    const tool = catalog.appTools.find((candidate) => candidate.pluginId === input.pluginId && candidate.serverId === input.serverId && candidate.originalToolName === input.toolName);
    if (!tool) throw brokerError('ZEUS_PLUGIN_MCP_APP_TOOL_NOT_FOUND', '该工具未在当前会话冻结目录中声明为 MCP App 可见。');
    if (tool.approvalMode === 'deny') throw brokerError('ZEUS_PLUGIN_MCP_TOOL_DENIED', 'Plugin MCP App 工具策略已拒绝执行。');
    if (tool.approvalMode === 'prompt' && !input.approved) throw brokerError('ZEUS_PLUGIN_MCP_APP_APPROVAL_REQUIRED', 'MCP App 工具需要审批；请在扩展管理中设为允许，或配置可信 PermissionRequest Hook。');
    return invokeFrozenTool(input.conversationId, tool, input.args, input.signal);
  }

  async function invokeFrozenTool(conversationId: string, tool: ZeusPluginDynamicTool, args: Record<string, unknown>, signal?: AbortSignal): Promise<ZeusPluginMcpToolResult> {
    const activations = await options.getActivations(conversationId);
    const activation = activations.find((candidate) => candidate.pluginId === tool.pluginId && candidate.pluginRevisionId === tool.pluginRevisionId);
    if (!activation) throw brokerError('ZEUS_PLUGIN_ACTIVATION_MISSING', 'Plugin 激活快照与 MCP 工具目录不一致。');
    const server = activationServers(activation).find((candidate) => candidate.id === tool.serverId);
    if (!server) throw brokerError('ZEUS_PLUGIN_MCP_SERVER_NOT_FOUND', '冻结 Plugin 修订中不存在该 MCP Server。');
    const connection = await requireConnection(conversationId, activation, server);
    const definition = connection.tools.find((candidate) => candidate.name === tool.originalToolName);
    if (!definition || toolDefinitionSha256(definition) !== tool.definitionSha256) throw brokerError('ZEUS_PLUGIN_MCP_TOOL_CHANGED', 'MCP Server 的工具 Schema 或元数据在会话期间发生漂移；Zeus 不会在旧会话中采用新定义。');
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
    return { text, structuredContent: result.structuredContent, isError: result.isError === true, app };
  }

  async function invokeHook(input: { conversationId: string; pluginId: string; serverId: string; toolName: string; args: Record<string, unknown>; signal: AbortSignal }): Promise<unknown> {
    const activations = await options.getActivations(input.conversationId);
    const activation = activations.find((candidate) => candidate.pluginId === input.pluginId);
    if (!activation) throw brokerError('ZEUS_PLUGIN_ACTIVATION_MISSING', 'Hook 引用的 Plugin 未在会话快照中激活。');
    const server = activationServers(activation).find((candidate) => candidate.id === input.serverId);
    if (!server) throw brokerError('ZEUS_PLUGIN_MCP_SERVER_NOT_FOUND', 'Hook 引用的 MCP Server 不存在。');
    const policy = resolvePolicy(activation, server.id, input.toolName);
    if (!policy.enabled || policy.approvalMode === 'deny') throw brokerError('ZEUS_PLUGIN_MCP_TOOL_DENIED', 'Hook 引用的 MCP 工具已被权限策略禁用。');
    const connection = await requireConnection(input.conversationId, activation, server);
    const definition = connection.tools.find((candidate) => candidate.name === input.toolName);
    if (!definition) throw brokerError('ZEUS_PLUGIN_MCP_TOOL_NOT_FOUND', 'Hook 引用的 MCP 工具不存在。');
    return connection.client.callTool({ name: input.toolName, arguments: structuredClone(input.args) }, { signal: input.signal, timeout: 10 * 60_000, toolDefinition: definition });
  }

  async function requireConnection(conversationId: string, activation: PluginActivationSnapshot, server: ActivationServer): Promise<McpConnection> {
    const key = connectionKey(conversationId, activation.pluginRevisionId, server.id);
    const existing = connections.get(key);
    if (existing) return existing;
    const pending = connect(activation, server).catch((error) => {
      connections.delete(key);
      throw error;
    });
    connections.set(key, pending);
    return pending;
  }

  async function connect(activation: PluginActivationSnapshot, server: ActivationServer): Promise<McpConnection> {
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
    await client.connect(transport);
    const listed = await client.listTools();
    return { client, tools: listed.tools, transport };
  }

  async function closeConversation(conversationId: string): Promise<void> {
    catalogs.delete(conversationId);
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
    catalogs.clear();
  }

  return { listTools, invoke, invokeApp, invokeHook, closeConversation, close };
}

type ActivationServer = { id: string; transport: 'stdio' | 'http'; config: Record<string, unknown> };
type McpConnection = { client: Client; tools: Tool[]; transport: StdioClientTransport | StreamableHTTPClientTransport };

function activationServers(activation: PluginActivationSnapshot): ActivationServer[] {
  const servers: ActivationServer[] = activation.components.mcpServers.map((server) => ({ id: server.id, transport: server.transport, config: server.config }));
  for (const connector of activation.connectors) {
    if (!connector.connected) continue;
    const config = connector.serverConfig;
    const transport = typeof config.command === 'string' ? 'stdio' : typeof config.url === 'string' ? 'http' : null;
    if (!transport) continue;
    if (servers.some((candidate) => candidate.id === connector.connectorId)) throw brokerError('ZEUS_PLUGIN_MCP_SERVER_DUPLICATE', `Connector ${connector.connectorId} 与 Plugin MCP Server 同名。`);
    servers.push({ id: connector.connectorId, transport, config: { ...config, __secretAccount: connector.secretAccount } });
  }
  return servers;
}

function resolvePolicy(activation: PluginActivationSnapshot, serverId: string, toolName: string): { enabled: boolean; approvalMode: PluginApprovalMode } {
  const exact = activation.mcpPolicies.find((policy) => policy.serverId === serverId && policy.toolName === toolName);
  const server = activation.mcpPolicies.find((policy) => policy.serverId === serverId && policy.toolName === '*');
  return exact ?? server ?? { enabled: true, approvalMode: 'prompt' };
}

async function remoteHeaders(server: ActivationServer, activation: PluginActivationSnapshot, dataDirectory: string, secretStore: Pick<SecretStore, 'getSecret'>): Promise<Record<string, string>> {
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

function toolResultText(result: { content: unknown[]; structuredContent?: unknown }): string {
  const text = result.content
    .map((entry) => (isRecord(entry) && entry.type === 'text' && typeof entry.text === 'string' ? entry.text : JSON.stringify(entry)))
    .filter(Boolean)
    .join('\n');
  const output = text || (result.structuredContent === undefined ? '' : JSON.stringify(result.structuredContent));
  if (Buffer.byteLength(output, 'utf8') > maximumToolResultBytes) throw brokerError('ZEUS_PLUGIN_MCP_RESULT_TOO_LARGE', 'MCP 工具结果超过 8 MiB。');
  return output;
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
  return `mcp__${safeToolIdentity(pluginName)}__${safeToolIdentity(serverId)}`;
}

function safeToolIdentity(value: string): string {
  const normalized = value
    .replaceAll(/[^a-zA-Z0-9_-]/gu, '_')
    .replaceAll(/_+/gu, '_')
    .slice(0, 48);
  const base = normalized || 'tool';
  return `${base}_${createHash('sha256').update(value).digest('hex').slice(0, 8)}`;
}

function connectionKey(conversationId: string, revisionId: string, serverId: string): string {
  return `${conversationId}:${revisionId}:${serverId}`;
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
