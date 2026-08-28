import { GaugeIcon as Gauge } from '@phosphor-icons/react/dist/csr/Gauge';
import { fastServiceTier } from './serviceTierSelection.js';
import type { CodexTaskPushModelCapability, NativeServiceTierSelection } from './sessionTypes.js';
import type { SessionUiLanguage } from './ThreadItemView.js';

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
      <Gauge aria-hidden="true" weight={active ? 'bold' : 'regular'} />
      {unsupported && active ? <span>{props.language === 'zh-CN' ? 'Fast（已记住，当前不可用）' : 'Fast (remembered, currently unavailable)'}</span> : null}
    </button>
  );
}
