/** 输入建议图标的离线检查；先执行 pnpm exec tsc -b，再用 Node 运行本文件，不调用模型。 */
import assert from 'node:assert/strict';
import { log } from 'node:console';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { InputSuggestionButton } from '../apps/desktop/dist/renderer/session/InputSuggestionControl.js';
import { inputSuggestionIdentity, inputSuggestionRetryDelay } from '../apps/desktop/dist/renderer/session/inputSuggestionStore.js';
import { serviceTierOptions } from '../apps/desktop/dist/renderer/session/serviceTierSelection.js';
import { normalizeInputSuggestionSettings } from '../packages/shared/dist/inputSuggestion.js';

/** 缺省使用标准速度，Fast 必须保存且参与请求身份，不能复用标准速度的旧结果。 */
const standardSettings = normalizeInputSuggestionSettings({ enabled: true, modelRef: 'codex:check' });
/** 同一模型和深度只改变速度，结果身份也必须变化。 */
const fastSettings = normalizeInputSuggestionSettings({ ...standardSettings, serviceTier: 'priority' });
assert.equal(standardSettings.serviceTier, null);
assert.equal(fastSettings.serviceTier, 'priority');
assert.notEqual(inputSuggestionIdentity({ settings: standardSettings }).modelKey, inputSuggestionIdentity({ settings: fastSettings }).modelKey);
assert.equal(serviceTierOptions(undefined, 'zh-CN').find((option) => option.value === 'priority').disabled, true);
assert.equal(serviceTierOptions({ serviceTiers: [{ id: 'priority', name: 'Fast', description: '' }] }, 'zh-CN').find((option) => option.value === 'priority').disabled, false);

// 只恢复临时或未分类的生成失败；无需改写、无效输出、明确配置错误和耗尽次数都必须停止。
assert.equal(inputSuggestionRetryDelay({ reason: 'timed_out' }, 0), 2_000);
assert.equal(inputSuggestionRetryDelay({ reason: 'failed', cause: { message: '连接中断', code: 'ECONNRESET' } }, 1), 5_000);
assert.equal(inputSuggestionRetryDelay({ reason: 'failed' }, 2), null);
for (const reason of ['no_change', 'context_unavailable', 'model_unavailable', 'effort_unavailable', 'service_tier_unavailable', 'cancelled']) {
  assert.equal(inputSuggestionRetryDelay({ reason }, 0), null);
}
for (const code of ['ZEUS_MODEL_HTTP_401', 'ZEUS_MODEL_TEXT_OUTPUT_LIMIT', 'ZEUS_INPUT_SUGGESTION_INVALID', 'ZEUS_INPUT_SUGGESTION_OUTPUT_INVALID', 'UNKNOWN_CONFIGURATION']) {
  assert.equal(inputSuggestionRetryDelay({ reason: 'failed', cause: { message: '生成未完成', cause: { code, message: '不可自动恢复' } } }, 0), null);
}

/** 共用最小界面状态，不依赖会话、密钥或浏览器。 */
const suggestion = {
  requestId: null,
  previewRef: { current: null },
  claimPreview: () => false,
  available: true,
  pending: false,
  retryAttempt: 0,
  retryAt: null,
  mode: 'suggest',
  reason: null,
  cause: null,
  requestManual: () => {},
  dismiss: () => {},
};
/** 真实组件渲染覆盖加载、失败、超时、无需改写和正常入口。 */
for (const state of [
  { pending: true },
  { pending: true, retryAttempt: 1, retryAt: 1 },
  { reason: 'failed', cause: { code: 'ZEUS_MODEL_TEXT_OUTPUT_LIMIT', message: '模型文本生成结果不完整。' } },
  { reason: 'timed_out' },
  { reason: 'service_tier_unavailable' },
  { reason: 'no_change' },
  {},
]) {
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
    assert.match(button, state.retryAt ? /等待自动重试.*1\/2.*取消生成/u : /正在生成输入建议.*取消生成/u);
  } else if (state.reason === 'failed' || state.reason === 'timed_out' || state.reason === 'service_tier_unavailable') {
    assert.match(button, /data-error="true"/u);
    /** 失败入口沿用当前组件的直接重试行为。 */
    assert.match(button, /点击重试生成/u);
    if (state.reason === 'failed') assert.match(button, /输出上限/u);
    if (state.reason === 'service_tier_unavailable') assert.match(button, /不支持已选 Fast 模式/u);
  } else {
    assert.match(button, /生成输入建议/u);
  }
}
/** 有效手动候选复用原生预览，按钮始终重新生成，不绑定旧浮层的默认打开动作。 */
const currentDraftPreview = renderToStaticMarkup(
  createElement(InputSuggestionButton, {
    suggestion: { ...suggestion, requestId: 'current-request', polishedText: '请定位输入问题并完成修复。', sourceDraft: '请定位问题' },
    draft: '请定位问题',
    inputRef: { current: null },
    language: 'zh-CN',
    configured: true,
  }),
);
assert.match(currentDraftPreview, /popover="auto" role="dialog"/u);
assert.match(currentDraftPreview, /data-icon-tooltip="点击或按下 Tab 采用，可撤消"/u);
assert.match(currentDraftPreview, /重新生成输入建议/u);
assert.doesNotMatch(currentDraftPreview, /popovertarget|session-suggestion-preview-hint|查看输入建议|当前输入已变化/u);
log('输入建议图标与候选预览静态渲染检查通过。');
