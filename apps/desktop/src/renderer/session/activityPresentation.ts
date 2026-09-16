import type { NativeSessionItemBuffer } from './sessionTypes.js';

/** 展示只读取真实调用与结果，不改变执行状态或历史身份。 */
type ActivityItem = Pick<NativeSessionItemBuffer, 'payload' | 'status'>;

/** 已结束的工具也可能等待用户操作，不能统一写成成功。 */
export type ActivityOutcome = 'running' | 'completed' | 'failed' | 'cancelled' | 'waiting' | 'observe' | 'unknown';

/** 两种 Provider 使用同一原生工具注册表，仅名称分隔方式不同。 */
export function nativeActivityTool(payload: Record<string, unknown>): { kind: 'browser' | 'computer'; method: string } | null {
  /** 原生协议使用 namespace/tool，Pi 使用注册后的完整名称。 */
  const name = String(payload.toolName ?? payload.name ?? payload.tool ?? '');
  /** 只识别准确命名空间，插件或正文里的同名词不能冒充原生操作。 */
  const match = name.match(/^(?:functions\.)?zeus_(browser|computer)(?:__|[._])([a-z_]+)$/u);
  if (match) return { kind: match[1] as 'browser' | 'computer', method: match[2]! };
  if (payload.namespace === 'zeus_browser' || payload.namespace === 'zeus_computer') {
    return { kind: payload.namespace === 'zeus_browser' ? 'browser' : 'computer', method: name };
  }
  return null;
}

/** 只解析完整 JSON；截断结果不靠正文关键词猜应用或状态。 */
function record(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      /** 参数只接受对象，嵌套字符串不递归解析。 */
      const parsed: unknown = JSON.parse(value);
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** 原生结果可能经过已有归档的 text 包装，最多解包三层。 */
function activityResult(payload: Record<string, unknown>): Record<string, unknown> {
  /** 优先使用结构化原始结果，再使用有界归档正文。 */
  const content = payload.contentItems;
  /** 只读取文本块，不将图片或外部页面内容当作应用元信息。 */
  const text = Array.isArray(content) ? content.find((block) => record(block).type === 'inputText') : null;
  /** Pi 的正文已由共享过程投影统一到 output。 */
  let result = record(record(text).text ?? payload.output ?? record(payload.toolResult).projection);
  for (let depth = 0; depth < 3 && typeof result.text === 'string'; depth++) result = record(result.text);
  return result;
}

/** 失败、取消与未确认结果优先于调用完成；不从自然语言推断成功。 */
export function activityOutcome(item: ActivityItem): ActivityOutcome {
  /** 字符串状态来自记录与原生返回，普通页面内容不能改变执行状态。 */
  const status = String(item.payload.status ?? item.status).toLowerCase();
  /** 仅原生工具的协议结果允许提供接管和动作确认状态。 */
  const result = nativeActivityTool(item.payload) ? activityResult(item.payload) : {};
  if (item.status === 'failed' || status === 'failed' || item.payload.success === false || item.payload.isError === true || (typeof item.payload.exitCode === 'number' && item.payload.exitCode !== 0)) return 'failed';
  if (['cancelled', 'canceled', 'interrupted'].includes(item.status) || ['cancelled', 'canceled', 'interrupted'].includes(status)) return 'cancelled';
  if (result.status === 'waiting_for_user') return 'waiting';
  if (result.status === 'user_control_resumed') return 'observe';
  if (result.outcome === 'unknown' || record(result.action).outcome === 'unknown' || ['timed_out', 'observation_failed'].includes(String(record(result.confirmation).status)) || status === 'unknown') return 'unknown';
  // 桌面返回截断时可能包含接管说明，未读到结果前不能宣称操作完成。
  if (item.status === 'completed' && nativeActivityTool(item.payload)?.kind === 'computer' && item.payload.v2ContentTruncated === true && Object.keys(result).length === 0) return 'unknown';
  return item.status === 'completed' ? 'completed' : 'running';
}

/** 动作名只描述工具实际能力，输入内容和内部选择器不进入摘要。 */
const actionNames: Record<string, readonly [string, string]> = {
  list_tabs: ['查看标签页', 'Inspect tabs'],
  open: ['打开页面', 'Open page'],
  navigate: ['导航页面', 'Navigate'],
  snapshot: ['读取页面', 'Inspect page'],
  element: ['查看元素', 'Inspect element'],
  screenshot: ['截取画面', 'Capture screenshot'],
  click: ['点击', 'Click'],
  type: ['输入', 'Type'],
  press: ['按键', 'Press key'],
  press_key: ['按键', 'Press key'],
  scroll: ['滚动', 'Scroll'],
  wait: ['等待页面', 'Wait for page'],
  wait_for: ['等待界面', 'Wait for app'],
  select_tab: ['切换标签页', 'Select tab'],
  close_tab: ['关闭标签页', 'Close tab'],
  history: ['浏览历史操作', 'Navigate history'],
  list_apps: ['查看运行中的应用', 'Inspect running apps'],
  get_app_state: ['观察应用界面', 'Inspect app'],
  drag: ['拖动', 'Drag'],
  type_text: ['输入', 'Type'],
  set_value: ['设置控件值', 'Set value'],
  clipboard: ['剪贴板操作', 'Clipboard operation'],
  downloads: ['查看下载', 'Inspect downloads'],
  developer: ['开发工具操作', 'Developer tools'],
  catalog: ['查看浏览器能力', 'Inspect browser capabilities'],
  invoke: ['浏览器操作', 'Browser operation'],
  release_handles: ['释放浏览器引用', 'Release browser handles'],
};

/** 状态同时使用文字，不能只依赖图标或颜色。 */
export function activityOutcomeLabel(outcome: ActivityOutcome, zh: boolean): string {
  /** 固定状态词覆盖中英文，不把“完成调用”描述成业务验证通过。 */
  const labels = {
    running: ['进行中', 'In progress'],
    completed: ['已完成', 'Completed'],
    failed: ['失败', 'Failed'],
    cancelled: ['已取消', 'Cancelled'],
    waiting: ['等待用户操作结束', 'Waiting for user'],
    observe: ['需重新观察', 'Observation required'],
    unknown: ['结果待确认', 'Result unconfirmed'],
  };
  return labels[outcome][zh ? 0 : 1]!;
}

/** 操作来源、目标和结果共用一行，原始工具参数仍保留在详情。 */
export function nativeActivityTitle(item: ActivityItem, zh: boolean): string | null {
  /** 无法准确识别的工具继续使用原有通用展示。 */
  const tool = nativeActivityTool(item.payload);
  if (!tool) return null;
  /** 参数只能影响展示目标，不能作为成功证据。 */
  const args = record(item.payload.arguments ?? item.payload.args);
  /** 应用名称优先使用原生观察结果中的真实元信息。 */
  const app = record(activityResult(item.payload).application).name ?? args.app;
  /** 路径和反向域名标识放在详情，避免直接显示内部应用标识。 */
  const appName = typeof app === 'string' && app.trim() && !app.includes('/') && !/^[\w-]+(?:\.[\w-]+){2,}$/u.test(app) ? app.trim() : null;
  /** Chrome 和 Edge 沿用用户明确指定的浏览器，其余为内置浏览器。 */
  const source = tool.kind === 'computer' ? (zh ? '桌面操作' : 'Desktop') : args.surface === 'chrome' ? 'Chrome' : args.surface === 'edge' ? 'Edge' : zh ? '浏览器' : 'Browser';
  /** 显示有限长度对象名称，完整参数仍可展开查看。 */
  let target = tool.kind === 'computer' ? appName : null;
  if (tool.kind === 'browser' && typeof args.url === 'string') {
    try {
      /** 只展示域名，避免把查询参数或凭据放进摘要。 */
      const url = new URL(args.url);
      target = url.protocol === 'file:' ? (zh ? '本地网页' : 'Local page') : url.hostname;
    } catch {
      /* 无效地址仍由原工具报告错误，展示层不猜测目标。 */
    }
  }
  /** 未收录的方法使用类别动作，内部工具名仍在详情中。 */
  const action = actionNames[tool.method]?.[zh ? 0 : 1] ?? (zh ? '操作' : 'Operation');
  /** 完成桌面输入仅说明动作已发送，不声称已验证界面效果。 */
  const outcome = activityOutcome(item);
  /** 观察与截图完成可以直接描述，其余桌面写操作使用保守结果词。 */
  const status = outcome === 'completed' && tool.kind === 'computer' && !['list_apps', 'get_app_state', 'screenshot'].includes(tool.method) ? (zh ? '已发送操作' : 'Action sent') : activityOutcomeLabel(outcome, zh);
  return [source, target ? target.slice(0, 100) : null, action, status].filter(Boolean).join(' · ');
}
