import type { ToolResult } from '@trycua/cua-driver';
import type { BrowserAutomationContentItem } from '@zeus/local-server';

/** 保留原生结果与成功判定，只精简重复树并按 Zeus 后台边界给出下一步。 */
export function projectComputerToolResult(result: ToolResult): { contentItems: BrowserAutomationContentItem[]; success: boolean } {
  /** 非结构化错误原样返回，不把解析失败当作成功或重新派发动作。 */
  let text = result.structuredJson ?? result.rawJson;
  try {
    /** 只处理顶层工具协议，不遍历或改写控件中不可信的页面正文。 */
    const state = JSON.parse(text) as Record<string, unknown> | null;
    if (state && typeof state === 'object' && !Array.isArray(state)) {
      if (Array.isArray(state.elements)) {
        /** elements 已保留身份、层级、动作与几何信息，无需再发送同一棵 Markdown 树。 */
        delete state.tree_markdown;
        delete state._note;
        /** 窗口无法匹配不是遍历预算不足，新弹窗必须先确认真实窗口身份。 */
        const backgroundInput = state.background_input as { exact_window?: { status?: unknown } } | null | undefined;
        if (backgroundInput?.exact_window?.status === 'ax_unresolved') {
          delete state.escalation;
          state.zeus_next_step =
            'The requested window exists, but its accessibility surface is unresolved. Use list_windows to identify a newly opened dialog, then get_window_state with its actual pid and window_id. Increasing tree budgets cannot resolve a different window. Do not send input while unresolved or switch to foreground or system input.';
        } else if (state.elements_complete === false || state.truncated === true) {
          state.zeus_next_step =
            'Partial tree: absence is inconclusive. Keep query and increase the exhausted budget: max_elements for node_budget, max_depth for depth, timeout_ms for timeout. query only filters collected nodes; repeating the same budget cannot find omitted elements.';
        }
      }
      if (state.effect === 'suspected_noop') {
        /** 原生已经投递动作；疑似无效只是推测，不能触发像素升级或自动重放。 */
        delete state.escalation;
        state.zeus_next_step = 'Action dispatched; effect unverified. Use get_window_state or verify_state once to check the expected change. Do not repeat the action or switch input routes before observing.';
      }
      if (process.platform === 'darwin' && state.code === 'background_unavailable' && state.effect === 'refused') {
        /** SDK 的前台或像素建议不适用于 Zeus，拒绝后保留错误码并停止该输入路线。 */
        delete state.escalation;
        state.reason = 'The native driver refused this background route. Zeus does not allow foreground or pixel-targeted text fallback on macOS.';
        if (typeof state.summary === 'string') state.summary = state.reason;
        state.zeus_next_step =
          'Stop this input route. Use an already authorized application API if available, or report the unsupported control. Do not retry through set_value, pixels, foreground input, shell or another system-input tool.';
      }
      text = JSON.stringify(state);
    }
  } catch {
    /* 原生纯文本或不可解析结果保留原文。 */
  }
  /** 图片、原始 MIME 和成功状态沿用现有协议，不把结果投影当作动作验证。 */
  const images: BrowserAutomationContentItem[] = result.images
    .filter((image) => image.mimeType.startsWith('image/') && image.dataBase64.length > 0)
    .map((image) => ({ type: 'inputImage', imageUrl: `data:${image.mimeType};base64,${image.dataBase64}` }));
  return { contentItems: [{ type: 'inputText', text }, ...images], success: !result.isError };
}
