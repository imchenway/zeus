import { randomUUID } from 'node:crypto';
import type { ToolResult } from '@trycua/cua-driver';
import type { BrowserAutomationToolCall, BrowserAutomationToolResult } from '@zeus/local-server';
import { BrowserCuaBridge, type BrowserCuaSurface } from './browserCuaBridge.js';
import type { ComputerHost } from './computerHost.js';

/** 只保存 CUA 返回的能力身份，不保存或重建页面定位信息。 */
interface BrowserCuaSession {
  /** 随机命名会话由宿主独占。 */
  id: string;
  /** 页面与产品轮次决定清理范围。 */
  input: BrowserAutomationToolCall;
  /** 布局或可见性变化后，等到下一次 CUA 动作更新位置再显示光标。 */
  cursorHidden: boolean;
  /** 对外引用只映射 CUA 原生能力；Driver 重建也不会复用旧的工具引用。 */
  refs: Map<string, string>;
  /** 同一 CUA 快照分页时复用已签发的对外引用。 */
  names: Map<string, string>;
  /** 原生快照更新后撤销旧引用。 */
  snapshotId?: string;
  /** 原生实例或窗口变更后，旧能力不能用于输入。 */
  binding?: { targetId: string; tabId: string; windowId: number; generation: number };
}

/** Zeus 只负责把自己的标签交给 CUA，语义观察和操作直接使用官方工具。 */
export class BrowserCuaHost {
  /** 网页 CDP 与私有 worker 共用的宿主桥。 */
  private readonly bridge = new BrowserCuaBridge();
  /** 每个产品轮次、每个网页有独立的原生能力。 */
  private readonly sessions = new Map<string, BrowserCuaSession>();
  /** 保持既有 eN 工具接口，整个宿主生命周期内不复用元素引用。 */
  private refSequence = 0;
  /** 地址仅由 Main 传给 CUA，不作为页面或模型 API。 */
  endpoint: string | undefined;

  /** 延迟取得 Main 生命周期内唯一的 CUA Driver 宿主。 */
  constructor(private readonly computer: () => ComputerHost) {}

  /** 在原生 worker 启动前准备受控传输。 */
  async initialize(): Promise<void> {
    this.endpoint = await this.bridge.start();
  }

  /** 能力名称、参数和描述来自当前 CUA 运行库。 */
  async catalog(query?: string): Promise<BrowserAutomationToolResult> {
    const tools = await this.computer().browserCatalog();
    const methods = tools
      .filter((tool) => !query || `${tool.name} ${tool.description}`.toLowerCase().includes(query.toLowerCase()))
      .map((tool) => {
        const schema = structuredClone(tool.inputSchema ?? tool.input_schema) as { properties?: Record<string, unknown>; required?: string[] };
        const internal = ['pid', 'window_id', 'target_id', 'tab_id', 'session', 'snapshot_format'];
        for (const name of internal) if (schema.properties) delete schema.properties[name];
        schema.required = schema.required?.filter((name) => !internal.includes(name));
        for (const name of ['ref', 'scope_ref', 'destination_ref']) {
          if (schema.properties?.[name]) schema.properties[name] = { ...(schema.properties[name] as Record<string, unknown>), description: 'Observed opaque eN ref returned by the current Zeus CUA snapshot.' };
        }
        return {
          path: tool.name,
          description: tool.name === 'get_browser_state' ? 'Read a CUA semantic snapshot of the outer Zeus tabId; Zeus supplies the exact native binding. Use query, scope_ref or continuation to narrow the observation.' : tool.description,
          inputSchema: schema,
        };
      });
    return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify({ engine: 'CUA', methods }) }] };
  }

  /** 输入只接收 CUA 快照引用，不把 CSS 字符串重新解释成另一套定位器。 */
  async invoke(input: BrowserAutomationToolCall, surface: BrowserCuaSurface): Promise<BrowserAutomationToolResult> {
    const key = JSON.stringify([input.conversationId, input.threadId, input.turnId, input.arguments.tabId]);
    let session = this.sessions.get(key);
    if (!session) {
      session = { id: `zeus-browser-${randomUUID()}`, input, cursorHidden: false, refs: new Map(), names: new Map() };
      this.sessions.set(key, session);
    }
    this.bridge.register(session.id, surface);
    const computer = this.computer();
    const windowId = this.bridge.windowId(surface.window());
    const observation =
      ['snapshot', 'element', 'screenshot'].includes(input.tool) ||
      (input.tool === 'invoke' && (input.arguments.path === 'get_browser_state' || (input.arguments.path === 'browser_dialog' && (input.arguments.arguments as { action?: unknown } | undefined)?.action === 'inspect')));
    if (session.binding && (session.binding.windowId !== windowId || session.binding.generation !== computer.getBrowserGeneration())) {
      session.binding = undefined;
      if (!observation) throw new Error('浏览器窗口或原生实例已变化，请重新读取快照后操作。');
    }
    if (!session.binding) {
      session.refs.clear();
      session.names.clear();
      session.snapshotId = undefined;
      const result = await computer.browserTool(input, session.id, 'get_browser_state', { pid: process.pid, window_id: windowId }, () => this.sessions.get(key) === session);
      if (this.sessions.get(key) !== session) throw new Error('浏览器控制会话已撤销，请重新观察，不要自动重放动作。');
      const state = this.data(result);
      if (result.isError || state.status !== 'ok' || state.binding_quality !== 'exact') return { ...this.project(input, result, session), success: false };
      const tabs = state.tabs as Array<{ tab_id: string }>;
      if (tabs.length !== 1 || typeof state.target_id !== 'string') throw new Error('CUA 未返回当前网页的唯一精确绑定。');
      session.binding = { targetId: state.target_id, tabId: tabs[0].tab_id, windowId, generation: computer.getBrowserGeneration() };
    }
    let tool: string;
    let args: Record<string, unknown>;
    switch (input.tool) {
      case 'snapshot':
      case 'element':
      case 'screenshot':
        tool = 'get_browser_state';
        args = {
          snapshot_format: 'semantic_v2',
          node_budget: Math.min(300, Number(input.arguments.maxElements ?? 160)),
          query: input.arguments.query,
          scope_ref: input.tool === 'element' ? this.reference(session, input.arguments.target) : input.arguments.scopeRef === undefined ? undefined : this.reference(session, input.arguments.scopeRef),
          continuation: input.arguments.continuation,
          include_screenshot: input.tool === 'screenshot',
        };
        break;
      case 'click':
        tool = 'browser_click';
        args = { ref: this.reference(session, input.arguments.target), input_route: 'trusted' };
        break;
      case 'type':
        tool = 'browser_type';
        args = { ref: this.reference(session, input.arguments.target), text: input.arguments.text, replace: input.arguments.replace !== false };
        break;
      case 'press': {
        if (typeof input.arguments.key !== 'string') throw new Error('按键必须为字符串。');
        const parts = input.arguments.key
          .split('+')
          .map((part) => part.trim())
          .filter(Boolean);
        const logicalKey = parts.pop();
        if (!logicalKey) throw new Error('按键不能为空。');
        /** 修饰键沿用 CDP 标准位掩码，不发送系统键盘事件。 */
        const masks: Record<string, number> = { alt: 1, option: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, shift: 8 };
        let modifiers = 0;
        for (const modifier of parts) {
          const mask = masks[modifier.toLowerCase()];
          if (mask === undefined) throw new Error(`不支持的修饰键：${modifier}`);
          modifiers |= mask;
        }
        /** 使用浏览器逻辑键名，避免平台 Return/Esc 名称差异。 */
        const aliases: Record<string, string> = {
          enter: 'Enter',
          return: 'Enter',
          tab: 'Tab',
          escape: 'Escape',
          esc: 'Escape',
          space: ' ',
          backspace: 'Backspace',
          delete: 'Delete',
          arrowleft: 'ArrowLeft',
          arrowright: 'ArrowRight',
          arrowup: 'ArrowUp',
          arrowdown: 'ArrowDown',
          home: 'Home',
          end: 'End',
          pageup: 'PageUp',
          pagedown: 'PageDown',
        };
        tool = 'browser_type';
        args = { key: aliases[logicalKey.toLowerCase()] ?? (/^f\d+$/iu.test(logicalKey) ? logicalKey.toUpperCase() : logicalKey), modifiers };
        break;
      }
      case 'scroll': {
        tool = 'browser_pointer';
        const zoom = surface.contents.getZoomFactor();
        const bounds = surface.bounds();
        args = {
          action: 'scroll',
          ...(input.arguments.target ? { ref: this.reference(session, input.arguments.target) } : { x: bounds.width / zoom / 2, y: bounds.height / zoom / 2 }),
          delta_x: input.arguments.x ?? 0,
          delta_y: input.arguments.y ?? 600,
        };
        break;
      }
      case 'invoke':
        tool = String(input.arguments.path ?? '');
        args = { ...(input.arguments.arguments as Record<string, unknown> | undefined) };
        if (input.arguments.handle !== undefined || ['pid', 'window_id', 'target_id', 'tab_id', 'session', 'tabId'].some((field) => Object.hasOwn(args, field)))
          throw new Error('CUA 的窗口和会话身份由 Zeus 提供；请用外层 tabId 选择网页，不传原生身份或旧句柄。');
        if (tool === 'get_browser_state') args.snapshot_format = 'semantic_v2';
        break;
      default:
        throw new Error('当前 CUA 浏览器入口不支持此操作。');
    }
    if (input.tool === 'invoke') {
      for (const field of ['ref', 'scope_ref', 'destination_ref']) if (args[field] !== undefined) args[field] = this.reference(session, args[field]);
    }
    const result = await computer.browserTool(input, session.id, tool, { ...args, pid: undefined, window_id: undefined, target_id: session.binding.targetId, tab_id: session.binding.tabId }, () => this.sessions.get(key) === session);
    if (this.sessions.get(key) !== session) throw new Error('浏览器控制会话已撤销，动作结果需要重新观察确认。');
    if (result.isError && observation) session.binding = undefined;
    const cursorAction = ['browser_click', 'browser_pointer'].includes(tool) || (tool === 'browser_type' && args.key === undefined);
    if (!result.isError && cursorAction && session.cursorHidden && surface.visible()) {
      await computer
        .setBrowserCursor(session.id, true)
        .then(() => {
          session.cursorHidden = false;
        })
        .catch((error) => console.warn('CUA browser cursor update failed', error));
    }
    return this.project(input, result, session);
  }

  /** 面板收起、切换或布局变化只隐藏已有光标，保留后台绑定和元素引用。 */
  async hideTabCursor(tabId: string): Promise<void> {
    await Promise.all(
      [...this.sessions.values()]
        .filter((session) => session.input.arguments.tabId === tabId)
        .map(async (session) => {
          session.cursorHidden = true;
          await this.computer().setBrowserCursor(session.id, false);
        }),
    );
  }

  /** 使用 CUA 的语义查询等待页面结果，不在宿主复制元素定位逻辑。 */
  async wait(input: BrowserAutomationToolCall, surface: BrowserCuaSurface): Promise<BrowserAutomationToolResult> {
    if (typeof input.arguments.query !== 'string' || input.arguments.selector !== undefined) throw new Error('CUA 等待需要 query 字符串，不能同时提供 selector。');
    const query = input.arguments.query.trim();
    const state = String(input.arguments.state ?? 'visible');
    if (!query || !['visible', 'hidden', 'enabled'].includes(state)) throw new Error('CUA query 等待需要非空 query，state 支持 visible、hidden、enabled。');
    const timeout = Math.min(30_000, Math.max(0, Number(input.arguments.timeoutMs ?? 5_000)));
    const deadline = Math.min(Date.now() + timeout, input.deadlineUnixMs ?? Number.POSITIVE_INFINITY);
    const expected = typeof input.arguments.text === 'string' ? input.arguments.text.replace(/\s+/gu, ' ').trim() : undefined;
    do {
      const result = await this.invoke({ ...input, deadlineUnixMs: deadline, tool: 'snapshot', arguments: { tabId: input.arguments.tabId, query, maxElements: 80 } }, surface);
      if (!result.success) return result;
      const item = result.contentItems.find((content) => content.type === 'inputText');
      const data = JSON.parse(item?.type === 'inputText' ? item.text : '{}') as Record<string, unknown>;
      const nodes = [...((data.refs ?? []) as Record<string, unknown>[]), ...((data.content_refs ?? []) as Record<string, unknown>[])];
      const visible = nodes.filter((node) => node.visibility === 'visible');
      const matched =
        state === 'hidden'
          ? (data.snapshot as { complete?: boolean } | undefined)?.complete === true && visible.length === 0
          : visible.some(
              (node) =>
                (state !== 'enabled' || (Array.isArray(node.actions) && node.actions.length > 0 && (node.states as { disabled?: boolean } | undefined)?.disabled !== true)) &&
                (expected === undefined || [node.name, node.value].some((text) => typeof text === 'string' && text.replace(/\s+/gu, ' ').trim() === expected)),
            );
      if (matched) return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify({ tabId: input.arguments.tabId, query, state, matched: true }) }] };
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(250, remaining)));
    } while (Date.now() <= deadline);
    return { success: false, contentItems: [{ type: 'inputText', text: JSON.stringify({ tabId: input.arguments.tabId, query, state, matched: false, reason: 'condition_timeout' }) }] };
  }

  /** 轮次结束保留标签，只撤销该轮次的 CUA 会话和私有连接。 */
  async endTurn(conversationId: string, turnId: string): Promise<void> {
    await Promise.all([...this.sessions.entries()].filter(([, session]) => session.input.conversationId === conversationId && session.input.turnId === turnId).map(([key, session]) => this.release(key, session)));
  }

  /** 网页关闭或崩溃时，其他轮次不能继续使用旧页面能力。 */
  async releaseTab(tabId: string): Promise<void> {
    await Promise.all([...this.sessions.entries()].filter(([, session]) => session.input.arguments.tabId === tabId).map(([key, session]) => this.release(key, session)));
  }

  /** 关闭原生控制能力后再关闭 CDP 服务。 */
  async close(): Promise<void> {
    await Promise.allSettled([...this.sessions.entries()].map(([key, session]) => this.release(key, session)));
    await this.bridge.close();
  }

  /** 撤销传输发生在等待原生回复之前，迟到调用不能继续发出输入。 */
  private async release(key: string, session: BrowserCuaSession): Promise<void> {
    this.sessions.delete(key);
    this.bridge.release(session.id);
    await this.computer().endBrowserSession(session.id);
  }

  /** CUA 引用包含快照身份，由原生引擎再次校验页面、frame 和文档。 */
  private reference(session: BrowserCuaSession, value: unknown): string {
    const native = typeof value === 'string' ? session.refs.get(value) : undefined;
    if (!native) throw new Error('元素引用已过期或不属于当前网页；请使用最新 Zeus CUA 快照返回的 eN 引用。');
    return native;
  }

  /** 只解析原生工具协议，不解析网页文本中的指令。 */
  private data(result: ToolResult): Record<string, unknown> {
    const data = JSON.parse(result.structuredJson ?? result.rawJson) as Record<string, unknown>;
    return (data.structuredContent as Record<string, unknown> | undefined) ?? data;
  }

  /** 页面快照和动作状态沿用 CUA，内部能力身份与私有端点不进入模型上下文。 */
  private project(input: BrowserAutomationToolCall, result: ToolResult, session: BrowserCuaSession): BrowserAutomationToolResult {
    const data = this.data(result);
    const snapshotId = (data.snapshot as { id?: string } | undefined)?.id;
    if (snapshotId && snapshotId !== session.snapshotId) {
      session.refs.clear();
      session.names.clear();
      session.snapshotId = snapshotId;
    }
    for (const field of ['refs', 'content_refs']) {
      if (!Array.isArray(data[field])) continue;
      for (const node of data[field] as Record<string, unknown>[]) {
        if (typeof node.ref !== 'string') continue;
        const native = node.ref;
        const name = session.names.get(native) ?? `e${++this.refSequence}`;
        session.names.set(native, name);
        session.refs.set(name, native);
        node.ref = name;
      }
    }
    delete data.target_id;
    delete data.tab_id;
    delete data.session;
    const text = JSON.stringify({ ...data, tabId: input.arguments.tabId })
      .split(this.endpoint ?? '\u0000')
      .join('[private CUA transport]/');
    return {
      success: !result.isError && data.status === 'ok',
      contentItems: [{ type: 'inputText', text }, ...result.images.filter((image) => image.mimeType.startsWith('image/')).map((image) => ({ type: 'inputImage' as const, imageUrl: `data:${image.mimeType};base64,${image.dataBase64}` }))],
    };
  }
}
