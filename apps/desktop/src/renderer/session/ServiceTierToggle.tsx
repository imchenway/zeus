import { LightningIcon as Lightning } from '@phosphor-icons/react/dist/csr/Lightning';
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
  const active = props.value.type === 'catalog' && props.value.id === fast?.id;
  const unsupported = !fast;
  const action = active ? (props.language === 'zh-CN' ? '切换为标准速度' : 'Switch to Standard speed') : props.language === 'zh-CN' ? '切换为 Fast 速度' : 'Switch to Fast speed';
  const title = unsupported
    ? props.language === 'zh-CN'
      ? '当前模型不支持 Fast'
      : 'The current model does not support Fast'
    : `${props.language === 'zh-CN' ? '速度' : 'Speed'}：${active ? 'Fast' : props.language === 'zh-CN' ? '标准' : 'Standard'}；${action}`;

  return (
    <button
      type="button"
      className="session-service-tier-toggle"
      data-active={active || undefined}
      aria-label={unsupported ? title : action}
      aria-pressed={active}
      title={title}
      disabled={props.disabled || unsupported}
      onClick={() => void props.onChange(active ? { type: 'standard' } : { type: 'catalog', id: fast!.id })}
    >
      <Lightning aria-hidden="true" weight={active ? 'fill' : 'regular'} />
    </button>
  );
}
