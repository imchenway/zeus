/** 输入建议图标的离线检查；先执行 pnpm exec tsc -b，再用 Node 运行本文件，不调用模型。 */
import assert from 'node:assert/strict';
import { log } from 'node:console';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { InputSuggestionButton } from '../apps/desktop/dist/renderer/session/InputSuggestionControl.js';

/** 共用最小界面状态，不依赖会话、密钥或浏览器。 */
const suggestion = {
  available: true,
  pending: false,
  mode: 'suggest',
  reason: null,
  cause: null,
  requestManual: () => {},
  dismiss: () => {},
};
/** 真实组件渲染覆盖加载、失败、超时、空结果和正常入口。 */
for (const state of [{ pending: true }, { reason: 'failed', cause: { code: 'ZEUS_MODEL_TEXT_OUTPUT_LIMIT', message: '模型文本生成结果不完整。' } }, { reason: 'timed_out' }, { reason: 'no_suggestion' }, {}]) {
  /** 通过 React 渲染含原生浮层状态的组件，不直接调用带 Hook 的函数。 */
  const element = createElement(InputSuggestionButton, { suggestion: { ...suggestion, ...state }, draft: '', inputRef: { current: null }, language: 'zh-CN', configured: true });
  /** 静态渲染确保没有新增底部段落、第二个按钮或重复图标。 */
  const markup = renderToStaticMarkup(element);
  /** 只观察实际按钮属性，容器上的忙碌语义不能触发全局按钮圆点。 */
  const button = markup.match(/<button\b[^>]*>/u)?.[0];
  assert.ok(button);
  assert.equal((markup.match(/<button\b/gu) ?? []).length, 1);
  assert.equal((markup.match(/<svg\b/gu) ?? []).length, 1);
  assert.doesNotMatch(markup, /<p\b|application-error-inline|session-composer-suggestion-status/u);
  assert.match(markup, /class="visually-hidden" role="status"/u);
  assert.doesNotMatch(button, /aria-busy|disabled/u);
  if (state.pending) {
    assert.match(markup, /class="session-suggestion-action" aria-busy="true"/u);
    assert.match(button, /正在生成输入建议.*取消生成/u);
  } else if (state.reason === 'failed' || state.reason === 'timed_out') {
    assert.match(button, /data-error="true"/u);
    /** 失败入口沿用当前组件的直接重试行为。 */
    assert.match(button, /点击重试生成/u);
    if (state.reason === 'failed') assert.match(button, /输出上限/u);
  } else {
    assert.match(button, /生成输入建议/u);
  }
}
log('输入建议图标状态渲染检查通过。');
