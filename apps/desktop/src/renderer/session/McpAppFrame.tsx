import { useEffect, useMemo, useRef, useState } from 'react';

interface McpAppDocument {
  resourceUri: string;
  html: string;
  csp: Record<string, unknown>;
  permissions: Record<string, unknown>;
  domain: string | null;
}

export interface McpAppToolCall {
  conversationId: string;
  pluginId: string;
  serverId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

export interface McpAppToolResult {
  text?: string;
  structuredContent?: unknown;
  isError?: boolean;
}

export function McpAppFrame(props: { value: unknown; context: Record<string, unknown>; language: 'zh-CN' | 'en-US'; onCallTool?: (input: McpAppToolCall) => Promise<McpAppToolResult> }) {
  const app = readApp(props.value);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [bridgeState, setBridgeState] = useState<'waiting' | 'ready' | 'rejected'>('waiting');
  const source = useMemo(() => (app ? sandboxDocument(app) : ''), [app]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || !app) return;
    const onMessage = (event: MessageEvent<unknown>) => {
      if (event.source !== frame.contentWindow || !isRecord(event.data) || event.data.jsonrpc !== '2.0') return;
      const id = typeof event.data.id === 'string' || typeof event.data.id === 'number' ? event.data.id : null;
      const method = typeof event.data.method === 'string' ? event.data.method : '';
      if (method === 'ui/initialize' && id !== null) {
        frame.contentWindow?.postMessage(
          {
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: '2025-06-18',
              hostInfo: { name: 'zeus-plugin-host', version: '0.3.74' },
              hostCapabilities: { openLinks: false, toolCalls: true, serverTools: true },
              context: { resourceUri: app.resourceUri, displayMode: 'inline' },
            },
          },
          '*',
        );
        setBridgeState('ready');
        return;
      }
      if (method === 'ui/notifications/initialized') {
        setBridgeState('ready');
        if (isRecord(props.context.toolResult)) {
          frame.contentWindow?.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: mcpToolResult(props.context.toolResult) }, '*');
        }
        return;
      }
      if (method === 'tools/call' && id !== null) {
        void callAppTool(props.context, event.data.params, props.onCallTool).then(
          (result) => frame.contentWindow?.postMessage({ jsonrpc: '2.0', id, result }, '*'),
          (reason) => {
            frame.contentWindow?.postMessage({ jsonrpc: '2.0', id, error: { code: -32000, message: reason instanceof Error ? reason.message.slice(0, 1200) : 'MCP App tool call failed.' } }, '*');
            setBridgeState('rejected');
          },
        );
        return;
      }
      if (id !== null) {
        frame.contentWindow?.postMessage({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Zeus MCP App Host Bridge does not permit this method from the renderer.' } }, '*');
        setBridgeState('rejected');
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [app, props.context, props.onCallTool]);

  if (!app) return <p className="session-mcp-app-error">{props.language === 'zh-CN' ? 'MCP App 文档无效。' : 'Invalid MCP App document.'}</p>;
  return (
    <section className="session-mcp-app" aria-label={props.language === 'zh-CN' ? '交互式 MCP App' : 'Interactive MCP App'}>
      <header>
        <strong>MCP App</strong>
        <span>{app.resourceUri}</span>
        <em data-state={bridgeState}>
          {bridgeState === 'ready'
            ? props.language === 'zh-CN'
              ? '已连接受控桥'
              : 'Controlled bridge ready'
            : bridgeState === 'rejected'
              ? props.language === 'zh-CN'
                ? '已拒绝越权请求'
                : 'Blocked request'
              : props.language === 'zh-CN'
                ? '正在初始化'
                : 'Initializing'}
        </em>
      </header>
      <iframe ref={frameRef} title={app.resourceUri} sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={source} />
    </section>
  );
}

async function callAppTool(context: Record<string, unknown>, value: unknown, invoke: ((input: McpAppToolCall) => Promise<McpAppToolResult>) | undefined): Promise<Record<string, unknown>> {
  if (!isRecord(value) || typeof value.name !== 'string' || !value.name.trim() || (value.arguments !== undefined && !isRecord(value.arguments))) throw new Error('MCP App tools/call 参数无效。');
  if (!invoke) throw new Error('当前会话不允许 MCP App 调用工具。');
  const conversationId = requiredIdentity(context.conversationId, 'conversationId');
  const pluginId = requiredIdentity(context.pluginId, 'pluginId');
  const serverId = requiredIdentity(context.serverId, 'serverId');
  const result = await invoke({ conversationId, pluginId, serverId, toolName: value.name.trim(), arguments: value.arguments ?? {} });
  return mcpToolResult(result);
}

function mcpToolResult(value: McpAppToolResult | Record<string, unknown>): Record<string, unknown> {
  const text = typeof value.text === 'string' ? value.text : '';
  return {
    content: text ? [{ type: 'text', text }] : [],
    ...(value.structuredContent === undefined ? {} : { structuredContent: value.structuredContent }),
    ...(value.isError === true ? { isError: true } : {}),
  };
}

function requiredIdentity(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || value.length > 256) throw new Error(`MCP App ${label} 无效。`);
  return value;
}

function readApp(value: unknown): McpAppDocument | null {
  if (!isRecord(value) || typeof value.resourceUri !== 'string' || !value.resourceUri.startsWith('ui://') || typeof value.html !== 'string' || value.html.length > 2 * 1024 * 1024) return null;
  return {
    resourceUri: value.resourceUri,
    html: value.html,
    csp: isRecord(value.csp) ? value.csp : {},
    permissions: isRecord(value.permissions) ? value.permissions : {},
    domain: typeof value.domain === 'string' ? value.domain : null,
  };
}

function sandboxDocument(app: McpAppDocument): string {
  const csp = contentSecurityPolicy(app.csp);
  const meta = `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp)}"><meta name="referrer" content="no-referrer">`;
  if (/<head(?:\s[^>]*)?>/iu.test(app.html)) return app.html.replace(/<head(\s[^>]*)?>/iu, (match) => `${match}${meta}`);
  return `<!doctype html><html><head>${meta}</head><body>${app.html}</body></html>`;
}

function contentSecurityPolicy(value: Record<string, unknown>): string {
  const connect = safeOrigins(value.connectDomains ?? value.connect_domains);
  const resources = safeOrigins(value.resourceDomains ?? value.resource_domains);
  const frames = safeOrigins(value.frameDomains ?? value.frame_domains);
  return [
    `default-src 'none'`,
    `base-uri 'none'`,
    `form-action 'none'`,
    `object-src 'none'`,
    `script-src 'unsafe-inline' ${resources.join(' ')}`.trim(),
    `style-src 'unsafe-inline' ${resources.join(' ')}`.trim(),
    `img-src data: blob: ${resources.join(' ')}`.trim(),
    `font-src data: ${resources.join(' ')}`.trim(),
    `connect-src ${connect.length ? connect.join(' ') : "'none'"}`,
    `frame-src ${frames.length ? frames.join(' ') : "'none'"}`,
  ].join('; ');
}

function safeOrigins(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== 'string') return [];
    try {
      const url = new URL(entry);
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(url.hostname))) return [];
      return [url.origin];
    } catch {
      return [];
    }
  });
}

function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
