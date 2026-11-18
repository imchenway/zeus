import { useId } from 'react';
import { selectionFromEffectiveServiceTier, serviceTierOptions, serviceTierSelectionValue } from './serviceTierSelection.js';
import type { CodexTaskPushModelCapability, NativeServiceTierSelection } from './sessionTypes.js';
import type { SessionUiLanguage } from './ThreadItemView.js';
import { Button } from '../ui/Button.js';
import { IconTooltip } from '../ui/IconTooltip.js';
import { ComposerDropdown } from './ComposerDropdown.js';

/** 三档共用快速模式的圆角闪电轮廓。 */
const lightningPath = 'M13.6 2.8 5.2 12.2c-.6.7-.1 1.8.8 1.8h4.2l-1 6.1c-.2 1 .9 1.5 1.6.8l8-9.5c.6-.7.1-1.8-.8-1.8h-4.1l1.3-6c.2-1-.9-1.5-1.6-.8Z';

/** 前层闪电和它的遮罩使用相同位置。 */
const frontLightningTransform = 'translate(-.7 2.1) scale(.89)';

/** 会话输入栏仅在可选超快时使用三档菜单。 */
export function ServiceTierSelect(props: {
  language: SessionUiLanguage;
  model: CodexTaskPushModelCapability | null | undefined;
  value: NativeServiceTierSelection;
  disabled?: boolean;
  onChange: (selection: NativeServiceTierSelection) => void | Promise<void>;
}) {
  /** 遮罩 ID 独立于同一窗口的其他速度按钮。 */
  const lightningGapId = useId();
  /** 展示当前模型可选的标准和加速档位。 */
  const options = serviceTierOptions(props.model, props.language);
  /** 当前选择保留目录 ID，切换模型后仍可显式选回标准。 */
  const value = serviceTierSelectionValue(props.value);
  /** 模型目录未提供超快时，使用标准与 Fast 的原单击切换。 */
  const hasSpeedMenu = options.some((option) => option.value === 'ultrafast');
  /** Fast 与超快分别使用单闪电与描边叠放。 */
  const fast = value === 'priority';
  /** 授权失效后，已保存的超快在旧按钮上按有效的标准速度显示。 */
  const ultrafast = hasSpeedMenu && value === 'ultrafast';
  /** 中英文速度按钮共用图形及点击规则。 */
  const zh = props.language === 'zh-CN';
  /** 图标对两种触发器保持同一尺寸。 */
  const icon = (
    <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill={fast || ultrafast ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
      {ultrafast ? (
        <>
          {/* 沿前层轮廓从后层留出透明间隔，叠放时仍可辨认两道闪电。 */}
          <mask id={lightningGapId} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
            <rect width="24" height="24" fill="white" stroke="none" />
            <path d={lightningPath} transform={frontLightningTransform} fill="black" stroke="black" strokeWidth="3.3" />
          </mask>
          <g mask={`url(#${lightningGapId})`}>
            <path d={lightningPath} transform="translate(5.35 .55) scale(.82)" fill="none" strokeWidth="1.8" />
          </g>
          <path d={lightningPath} transform={frontLightningTransform} />
        </>
      ) : (
        <path d={lightningPath} />
      )}
    </svg>
  );

  if (!hasSpeedMenu) {
    /** Fast 不可用时允许清除已记住的 Fast。 */
    const fastUnavailable = !options.some((option) => option.value === 'priority' && !option.disabled);
    /** 保留原按钮的档位提示。 */
    const title = zh ? `速度：${fast ? 'Fast' : '标准'}` : `Speed: ${fast ? 'Fast' : 'Standard'}`;
    /** 无障碍名称说明当前点击动作和能力限制。 */
    const accessibleLabel = fast
      ? fastUnavailable
        ? zh
          ? '已记住 Fast，但当前模型不支持；发送时将按标准速度运行。点击切换为标准速度'
          : 'Fast is remembered but unsupported by this model; sends use Standard. Click to switch to Standard'
        : zh
          ? '切换为标准速度'
          : 'Switch to Standard speed'
      : fastUnavailable
        ? zh
          ? '当前模型不支持 Fast'
          : 'The current model does not support Fast'
        : zh
          ? '切换为 Fast 速度'
          : 'Switch to Fast speed';
    return (
      <IconTooltip label={title}>
        <Button
          unstyled
          type="button"
          className="session-service-tier-toggle"
          data-active={fast || undefined}
          aria-label={accessibleLabel}
          aria-pressed={fast}
          disabled={props.disabled || (fastUnavailable && !fast)}
          onClick={() => props.onChange(fast ? { type: 'standard' } : { type: 'catalog', id: 'priority' })}
        >
          {icon}
        </Button>
      </IconTooltip>
    );
  }

  /** 纯图标菜单触发器将选中档位写入提示及无障碍名称。 */
  const selected = options.find((option) => option.value === value) ?? options[0];
  /** 悬停提示显示当前档位名称。 */
  const title = zh ? `速度：${selected.label}` : `Speed: ${selected.label}`;
  /** 记住的 Fast 不可用时说明发送会走标准速度。 */
  const triggerLabel = !selected.disabled ? title : zh ? `${title}，当前不可选，发送时使用标准速度` : `${title}, unavailable. Sends use Standard`;

  return (
    <ComposerDropdown
      label={zh ? '速度' : 'Speed'}
      triggerLabel={triggerLabel}
      title={title}
      className="session-service-tier-dropdown"
      hideSelectedLabel
      value={value}
      options={options}
      disabled={props.disabled}
      onChange={(next) => props.onChange(selectionFromEffectiveServiceTier(next))}
      triggerIcon={icon}
    />
  );
}
