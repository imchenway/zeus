/** 输入建议图标的离线检查；先执行 pnpm exec tsc -b，再用 Node 运行本文件，不调用模型。 */
import assert from 'node:assert/strict';
import { log } from 'node:console';
import { renderToStaticMarkup } from 'react-dom/server';
import { InputSuggestionButton } from '../apps/desktop/dist/renderer/session/InputSuggestionControl.js';

/** 记录按钮操作，确认加载时可以取消且不会重复生成。 */
const actions = [];
/** 共用最小界面状态，不依赖会话、密钥或浏览器。 */
const suggestion = {
  available: true,
  pending: false,
  mode: 'suggest',
  reason: null,
  cause: null,
  requestManual: () => actions.push('request'),
  dismiss: () => actions.push('dismiss'),
};
/** 真实组件渲染覆盖加载、失败、超时、空结果和正常入口。 */
for (const state of [{ pending: true }, { reason: 'failed', cause: { code: 'ZEUS_MODEL_TEXT_OUTPUT_LIMIT', message: '模型文本生成结果不完整。' } }, { reason: 'timed_out' }, { reason: 'no_suggestion' }, {}]) {
  /** 保留组件生成的事件处理函数，检查真实按钮行为。 */
  const element = InputSuggestionButton({ suggestion: { ...suggestion, ...state }, draft: '', language: 'zh-CN', configured: true });
  /** 图标提示内部的按钮是唯一可操作入口。 */
  const button = element.props.children[0].props.children;
  /** 静态渲染确保没有新增底部段落、第二个按钮或重复图标。 */
  const markup = renderToStaticMarkup(element);
  assert.equal((markup.match(/<button\b/gu) ?? []).length, 1);
  assert.equal((markup.match(/<svg\b/gu) ?? []).length, 1);
  assert.doesNotMatch(markup, /<p\b|application-error-inline|session-composer-suggestion-status/u);
  assert.match(markup, /class="visually-hidden" role="status"/u);
  assert.equal(button.props['aria-busy'], undefined, '取消按钮不能命中全局忙碌按钮样式');
  assert.equal(button.props.disabled, false);
  if (state.pending) {
    assert.equal(element.props['aria-busy'], true);
    assert.match(button.props['aria-label'], /正在生成输入建议.*取消生成/u);
    button.props.onClick();
    assert.deepEqual(actions, ['dismiss']);
  } else if (state.reason === 'failed' || state.reason === 'timed_out') {
    assert.equal(button.props['data-error'], true);
    assert.match(button.props['aria-label'], /查看详情/u);
    if (state.reason === 'failed') assert.match(button.props['aria-label'], /输出上限/u);
  } else {
    button.props.onClick();
    assert.equal(actions.at(-1), 'request');
  }
}
log('输入建议图标状态与取消操作检查通过。');
