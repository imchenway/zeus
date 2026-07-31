import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { BrowserAutomationPort, BrowserAutomationToolCall } from '@zeus/local-server';

export interface DesktopBrowserAutomationBridge {
  baseUrl: string;
  token: string;
  close(): Promise<void>;
}

export interface ReconnectableBrowserAutomationProxy extends BrowserAutomationPort {
  register(input: { leaseId: string; baseUrl: string; token: string } | null): void;
  currentLeaseId(): string | null;
}

const maximumRequestBytes = 2 * 1024 * 1024;
const browserBridgeWaitTimeoutMs = 120_000;

/** 将 Electron BrowserHost 收口到仅监听回环地址的临时桥，执行宿主可在界面重启后重新绑定。 */
export async function startDesktopBrowserAutomationBridge(browserAutomation: BrowserAutomationPort): Promise<DesktopBrowserAutomationBridge> {
  const token = randomBytes(32).toString('base64url');
  const server = createServer((request, response) => {
    void handleDesktopBrowserBridgeRequest(request, response, token, browserAutomation);
  });
  await listenOnLoopback(server);
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    token,
    close: () => closeHttpServer(server),
  };
}

/** 执行宿主持有此代理；界面短暂离线时等待新租约，不把工具调用立即伪装成失败。 */
export function createReconnectableBrowserAutomationProxy(): ReconnectableBrowserAutomationProxy {
  let registration: { leaseId: string; baseUrl: string; token: string } | null = null;
  const waiters = new Set<(value: { leaseId: string; baseUrl: string; token: string }) => void>();

  function register(input: { leaseId: string; baseUrl: string; token: string } | null): void {
    registration = input;
    if (!input) return;
    for (const resolve of waiters) resolve(input);
    waiters.clear();
  }

  async function waitForRegistration(): Promise<{ leaseId: string; baseUrl: string; token: string }> {
    if (registration) return registration;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(onRegistration);
        reject(Object.assign(new Error('Zeus 界面尚未重新连接浏览器自动化宿主。'), { code: 'ZEUS_BROWSER_AUTOMATION_UI_OFFLINE' }));
      }, browserBridgeWaitTimeoutMs);
      timer.unref();
      const onRegistration = (value: { leaseId: string; baseUrl: string; token: string }) => {
        clearTimeout(timer);
        resolve(value);
      };
      waiters.add(onRegistration);
    });
  }

  return {
    register,
    currentLeaseId: () => registration?.leaseId ?? null,
    async invoke(input) {
      let lastError: unknown;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const current = await waitForRegistration();
        try {
          const response = await fetch(`${current.baseUrl}/invoke`, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${current.token}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify(input),
          });
          const payload = (await response.json().catch(() => ({}))) as unknown;
          if (!response.ok) {
            const detail = isRecord(payload) && typeof payload.message === 'string' ? payload.message : `HTTP ${response.status}`;
            throw new Error(`Zeus BrowserHost bridge failed: ${detail}`);
          }
          if (!isBrowserAutomationResult(payload)) throw new Error('Zeus BrowserHost bridge returned an invalid result.');
          return payload;
        } catch (error) {
          lastError = error;
          if (registration?.leaseId === current.leaseId) register(null);
        }
      }
      throw lastError instanceof Error ? lastError : new Error('Zeus BrowserHost bridge is unavailable.');
    },
  };
}

async function handleDesktopBrowserBridgeRequest(request: IncomingMessage, response: ServerResponse, token: string, browserAutomation: BrowserAutomationPort): Promise<void> {
  if (!isAuthorized(request, token)) {
    sendJson(response, 401, { error: 'ZEUS_BROWSER_BRIDGE_UNAUTHORIZED', message: '浏览器自动化桥凭据无效。' });
    return;
  }
  if (request.method !== 'POST' || request.url !== '/invoke') {
    sendJson(response, 404, { error: 'ZEUS_BROWSER_BRIDGE_NOT_FOUND', message: '浏览器自动化桥路径不存在。' });
    return;
  }
  try {
    const input = await readJsonBody(request);
    if (!isBrowserAutomationToolCall(input)) {
      sendJson(response, 400, { error: 'ZEUS_BROWSER_BRIDGE_INPUT_INVALID', message: '浏览器自动化请求格式无效。' });
      return;
    }
    sendJson(response, 200, await browserAutomation.invoke(input));
  } catch (error) {
    sendJson(response, 500, {
      error: 'ZEUS_BROWSER_BRIDGE_INVOKE_FAILED',
      message: error instanceof Error ? error.message : '浏览器自动化调用失败。',
    });
  }
}

function isAuthorized(request: IncomingMessage, token: string): boolean {
  const header = request.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const received = Buffer.from(header.slice('Bearer '.length));
  const expected = Buffer.from(token);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let receivedBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    receivedBytes += buffer.length;
    if (receivedBytes > maximumRequestBytes) throw new Error('浏览器自动化请求超过允许大小。');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function isBrowserAutomationToolCall(value: unknown): value is BrowserAutomationToolCall {
  return isRecord(value) && isNonEmptyString(value.conversationId) && isNonEmptyString(value.threadId) && isNonEmptyString(value.turnId) && isNonEmptyString(value.callId) && isNonEmptyString(value.tool) && isRecord(value.arguments);
}

function isBrowserAutomationResult(value: unknown): value is Awaited<ReturnType<BrowserAutomationPort['invoke']>> {
  return (
    isRecord(value) &&
    typeof value.success === 'boolean' &&
    Array.isArray(value.contentItems) &&
    value.contentItems.every((item) => isRecord(item) && ((item.type === 'inputText' && typeof item.text === 'string') || (item.type === 'inputImage' && typeof item.imageUrl === 'string')))
  );
}

function listenOnLoopback(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function closeHttpServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(payload));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
