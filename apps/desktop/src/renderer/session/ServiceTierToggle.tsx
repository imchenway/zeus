import { fastServiceTier } from './serviceTierSelection.js';
import type { CodexTaskPushModelCapability, NativeServiceTierSelection } from './sessionTypes.js';
import type { SessionUiLanguage } from './ThreadItemView.js';

/** 用闪电表示速度切换，沿用当前模型能力和已选状态。 */
export function ServiceTierToggle(props: {
  language: SessionUiLanguage;
  model: CodexTaskPushModelCapability | null | undefined;
  value: NativeServiceTierSelection;
  disabled?: boolean;
  onChange: (selection: NativeServiceTierSelection) => void | Promise<void>;
}) {
  const fast = fastServiceTier(props.model);
  const active = props.value.type === 'catalog' && props.value.id === 'priority';
  const unsupported = !fast;
  const action = active ? (props.language === 'zh-CN' ? '切换为标准速度' : 'Switch to Standard speed') : props.language === 'zh-CN' ? '切换为 Fast 速度' : 'Switch to Fast speed';
  const title =
    unsupported && active
      ? props.language === 'zh-CN'
        ? '已记住 Fast，但当前模型不支持；发送时将按标准速度运行。点击切换为标准速度'
        : 'Fast is remembered but unsupported by this model; sends use Standard. Click to switch to Standard'
      : unsupported
        ? props.language === 'zh-CN'
          ? '当前模型不支持 Fast'
          : 'The current model does not support Fast'
        : `${props.language === 'zh-CN' ? '速度' : 'Speed'}：${active ? 'Fast' : props.language === 'zh-CN' ? '标准' : 'Standard'}；${action}`;

  return (
    <button
      type="button"
      className="session-service-tier-toggle"
      data-active={active || undefined}
      data-unavailable={unsupported && active ? 'true' : undefined}
      aria-label={unsupported ? title : action}
      aria-pressed={active}
      title={title}
      disabled={props.disabled || (unsupported && !active)}
      onClick={() => void props.onChange(active ? { type: 'standard' } : { type: 'catalog', id: 'priority' })}
    >
      {/* 实心闪电使用柔和转角，保证小尺寸辨识度；两种速度沿用同一轮廓，以颜色区分。 */}
      <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
        <path d="M13.6 2.8 5.2 12.2c-.6.7-.1 1.8.8 1.8h4.2l-1 6.1c-.2 1 .9 1.5 1.6.8l8-9.5c.6-.7.1-1.8-.8-1.8h-4.1l1.3-6c.2-1-.9-1.5-1.6-.8Z" />
      </svg>
      {unsupported && active ? <span>{props.language === 'zh-CN' ? 'Fast（已记住，当前不可用）' : 'Fast (remembered, currently unavailable)'}</span> : null}
    </button>
  );
}
