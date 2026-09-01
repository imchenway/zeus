import type { CodexDynamicToolNamespaceSpec, CodexDynamicToolSpec, PiZeusToolDefinitionSpec } from '@zeus/ai-runtime';
import type { BrowserAutomationPort, BrowserAutomationToolCall, BrowserAutomationToolResult } from './browserAutomation.js';
import { browserFrozenContractEntry, browserFrozenContractVersion, browserFrozenMethodSupportsSurface, validateBrowserFrozenArguments } from './browserFrozenContract.js';
import { zeusBrowserDynamicTools } from './browserDynamicTools.js';
import { zeusComputerDynamicTools } from './computerDynamicTools.js';

export const zeusNativeToolNamespaces = ['zeus_browser', 'zeus_computer'] as const;
export type ZeusNativeToolNamespace = (typeof zeusNativeToolNamespaces)[number];

export interface ZeusToolRegistry {
  codexTools: CodexDynamicToolSpec[];
  piTools: PiZeusToolDefinitionSpec[];
  resolvePiTool(name: string): { namespace: ZeusNativeToolNamespace; tool: string } | null;
  has(namespace: ZeusNativeToolNamespace, tool: string): boolean;
}

export interface ZeusToolBroker {
  readonly registry: ZeusToolRegistry;
  invoke(input: BrowserAutomationToolCall & { namespace: ZeusNativeToolNamespace }): Promise<BrowserAutomationToolResult>;
  invokePi(input: Omit<BrowserAutomationToolCall, 'tool'> & { toolName: string }): Promise<BrowserAutomationToolResult>;
}

export interface ZeusToolAuditEvent {
  phase: 'started' | 'completed' | 'failed';
  conversationId: string;
  threadId: string;
  turnId: string;
  callId: string;
  namespace: ZeusNativeToolNamespace;
  tool: string;
  surface: string;
  durationMs?: number;
  success?: boolean;
  resultKinds?: Array<'text' | 'image'>;
  errorCode?: string;
}

export interface CreateZeusToolBrokerOptions {
  timeoutMs?: number;
  audit?: (event: ZeusToolAuditEvent) => void | Promise<void>;
}

export function createZeusToolRegistry(): ZeusToolRegistry {
  const codexTools = [...zeusBrowserDynamicTools(), ...zeusComputerDynamicTools()];
  const mapping = new Map<string, { namespace: ZeusNativeToolNamespace; tool: string }>();
  const piTools: PiZeusToolDefinitionSpec[] = [];
  for (const namespace of codexTools.filter(isNamespace)) {
    if (!isZeusNativeToolNamespace(namespace.name)) continue;
    for (const tool of namespace.tools) {
      const name = `${namespace.name}_${tool.name}`;
      mapping.set(name, { namespace: namespace.name, tool: tool.name });
      piTools.push({
        name,
        label: piToolLabel(namespace.name, tool.name),
        description: tool.description,
        parameters: asSchemaRecord(tool.inputSchema),
        ...(isSequentialTool(namespace.name, tool.name) ? { executionMode: 'sequential' } : {}),
        ...(tool.deferLoading ? { deferLoading: true } : {}),
      });
    }
  }
  return {
    codexTools,
    piTools,
    resolvePiTool: (name) => mapping.get(name) ?? null,
    has: (namespace, tool) => codexTools.some((spec) => isNamespace(spec) && spec.name === namespace && spec.tools.some((candidate) => candidate.name === tool)),
  };
}

export function createZeusToolBroker(automation: BrowserAutomationPort, options: CreateZeusToolBrokerOptions = {}): ZeusToolBroker {
  const registry = createZeusToolRegistry();
  const timeoutMs = options.timeoutMs ?? 120_000;
  const invoke = async (input: BrowserAutomationToolCall & { namespace: ZeusNativeToolNamespace }): Promise<BrowserAutomationToolResult> => {
    validateToolIdentity(input);
    if (!registry.has(input.namespace, input.tool)) throw Object.assign(new Error(`Zeus 原生工具不存在：${input.namespace}.${input.tool}`), { code: 'ZEUS_NATIVE_TOOL_UNSUPPORTED' });
    if (input.namespace === 'zeus_browser' && input.tool === 'invoke') validateAdvancedBrowserCall(input.arguments);
    const surface = input.namespace === 'zeus_computer' ? 'computer' : typeof input.arguments.surface === 'string' ? input.arguments.surface : 'built_in';
    if (input.namespace === 'zeus_browser' && input.tool === 'invoke') {
      const path = String(input.arguments.path);
      const browserSurface = surface === 'chrome' || surface === 'edge' ? surface : 'built_in';
      if (!browserFrozenMethodSupportsSurface(path, browserSurface)) {
        throw Object.assign(new Error(`unsupported_surface: Browser ${browserFrozenContractVersion} does not expose ${path} on ${browserSurface}.`), { code: 'ZEUS_BROWSER_UNSUPPORTED_SURFACE' });
      }
    }
    const startedAt = Date.now();
    await options.audit?.({ phase: 'started', conversationId: input.conversationId, threadId: input.threadId, turnId: input.turnId, callId: input.callId, namespace: input.namespace, tool: input.tool, surface });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error(`Zeus 原生工具调用超时：${input.namespace}.${input.tool}`), { code: 'ZEUS_NATIVE_TOOL_TIMEOUT' })), timeoutMs);
        timer.unref();
      });
      const result = await Promise.race([automation.invoke(input), timeout]);
      await options.audit?.({
        phase: 'completed',
        conversationId: input.conversationId,
        threadId: input.threadId,
        turnId: input.turnId,
        callId: input.callId,
        namespace: input.namespace,
        tool: input.tool,
        surface,
        durationMs: Date.now() - startedAt,
        success: result.success,
        resultKinds: [...new Set(result.contentItems.map((item) => (item.type === 'inputImage' ? ('image' as const) : ('text' as const))))],
      });
      return result;
    } catch (error) {
      const record = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
      await options.audit?.({
        phase: 'failed',
        conversationId: input.conversationId,
        threadId: input.threadId,
        turnId: input.turnId,
        callId: input.callId,
        namespace: input.namespace,
        tool: input.tool,
        surface,
        durationMs: Date.now() - startedAt,
        success: false,
        errorCode: typeof record.code === 'string' ? record.code : 'ZEUS_NATIVE_TOOL_FAILED',
      });
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  return {
    registry,
    invoke,
    invokePi(input) {
      const resolved = registry.resolvePiTool(input.toolName);
      if (!resolved) throw Object.assign(new Error(`Zeus 原生工具不存在：${input.toolName}`), { code: 'ZEUS_NATIVE_TOOL_UNSUPPORTED' });
      return invoke({ ...input, namespace: resolved.namespace, tool: resolved.tool });
    },
  };
}

export function isZeusNativeToolMutation(namespace: ZeusNativeToolNamespace, tool: string, args: Record<string, unknown>): boolean {
  if (namespace === 'zeus_computer') return tool !== 'list_apps' && tool !== 'get_app_state';
  if (tool === 'invoke') {
    const path = typeof args.path === 'string' ? args.path : '';
    const contract = browserFrozenContractEntry(path);
    return !contract || contract.risk !== 'read';
  }
  if (tool === 'clipboard') return args.action !== 'read';
  return !['list_tabs', 'snapshot', 'element', 'wait', 'screenshot', 'downloads', 'catalog', 'release_handles'].includes(tool);
}

function validateAdvancedBrowserCall(input: Record<string, unknown>): void {
  const path = typeof input.path === 'string' ? input.path.trim() : '';
  if (!path || !browserFrozenContractEntry(path)) {
    throw Object.assign(new Error(`Browser ${browserFrozenContractVersion} 冻结契约未注册方法：${path || '<empty>'}`), { code: 'ZEUS_BROWSER_METHOD_NOT_ALLOWLISTED' });
  }
  const methodArguments = input.arguments === undefined ? {} : input.arguments;
  const issues = validateBrowserFrozenArguments(path, methodArguments);
  if (issues.length > 0) {
    throw Object.assign(new Error(`Browser ${path} 参数不符合冻结契约：${issues.join('；')}`), { code: 'ZEUS_BROWSER_ARGUMENT_INVALID', issues });
  }
}

function validateToolIdentity(input: BrowserAutomationToolCall): void {
  for (const [name, value] of Object.entries({ conversationId: input.conversationId, threadId: input.threadId, turnId: input.turnId, callId: input.callId })) {
    if (typeof value !== 'string' || !value.trim()) throw Object.assign(new Error(`Zeus 原生工具缺少调用身份：${name}`), { code: 'ZEUS_NATIVE_TOOL_IDENTITY_INVALID' });
  }
}

function isNamespace(spec: CodexDynamicToolSpec): spec is CodexDynamicToolNamespaceSpec {
  return spec.type === 'namespace';
}

function isZeusNativeToolNamespace(value: string): value is ZeusNativeToolNamespace {
  return (zeusNativeToolNamespaces as readonly string[]).includes(value);
}

function asSchemaRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : { type: 'object', properties: {}, additionalProperties: false };
}

function isSequentialTool(namespace: ZeusNativeToolNamespace, tool: string): boolean {
  if (namespace === 'zeus_computer') return tool !== 'list_apps' && tool !== 'get_app_state';
  return !['list_tabs', 'snapshot', 'element', 'wait', 'screenshot', 'downloads', 'catalog'].includes(tool);
}

function piToolLabel(namespace: ZeusNativeToolNamespace, tool: string): string {
  const prefix = namespace === 'zeus_browser' ? '浏览器' : '电脑';
  return `${prefix} · ${tool}`;
}
