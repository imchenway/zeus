import { useId } from 'react';
import { selectionFromEffectiveServiceTier, serviceTierOptions, serviceTierPickerValue } from './serviceTierSelection.js';
import type { CodexTaskPushModelCapability, NativeServiceTierSelection } from './sessionTypes.js';
import type { SessionUiLanguage } from './ThreadItemView.js';
import { Button } from '../ui/Button.js';
import { IconTooltip } from '../ui/IconTooltip.js';
import { ComposerDropdown } from './ComposerDropdown.js';

/** 各速度档位共用快速模式的圆角闪电轮廓。 */
const lightningPath = 'M13.6 2.8 5.2 12.2c-.6.7-.1 1.8.8 1.8h4.2l-1 6.1c-.2 1 .9 1.5 1.6.8l8-9.5c.6-.7.1-1.8-.8-1.8h-4.1l1.3-6c.2-1-.9-1.5-1.6-.8Z';

/** 前层闪电和它的遮罩使用相同位置。 */
const frontLightningTransform = 'translate(-.7 2.1) scale(.89)';

/** 单个可用加速档位可以直接切换，多个可用档位使用共享菜单。 */
export function ServiceTierSelect(props: {
  language: SessionUiLanguage;
  model: CodexTaskPushModelCapability | null | undefined;
  value: NativeServiceTierSelection;
  disabled?: boolean;
  onChange: (selection: NativeServiceTierSelection) => void | Promise<void>;
}) {
  /** 遮罩 ID 独立于同一窗口的其他速度按钮。 */
  const lightningGapId = useId();
  /** 会话速度菜单使用英文档位名与说明，与输出速率明细一致。 */
  const options = serviceTierOptions(props.model, 'en-US');
  /** 当前有效的速度用于菜单选中状态。 */
  const value = serviceTierPickerValue(props.value, props.model);
  const selected = options.find((option) => option.value === value) ?? options[0]!;
  const active = selected !== options[0];
  /** 单闪电用于已选的加速档位，超快沿用已有双闪电。 */
  const ultrafast = active && value === 'ultrafast';
  /** 中英文速度按钮共用图形及点击规则。 */
  const zh = props.language === 'zh-CN';
  /** 图标对两种触发器保持同一尺寸。 */
  const icon = (
    <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill={active ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
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

  /** 速度提示与下拉选项共用目录名称。 */
  const title = zh ? `速度：${selected.label}` : `Speed: ${selected.label}`;
  if (options.length <= 2) {
    /** 没有可用档位时仍可清除之前保存的选择。 */
    const next = active || (options.length === 1 && props.value.type === 'catalog') ? options[0] : options[1];
    const accessibleLabel = next ? (zh ? `切换为${next.label}速度` : `Switch to ${next.label} speed`) : zh ? '当前模型没有其他速度档位' : 'No other speeds are available for this model';
    return (
      <IconTooltip label={title}>
        <Button
          unstyled
          type="button"
          className="session-service-tier-toggle"
          data-active={active || undefined}
          aria-label={accessibleLabel}
          aria-pressed={active}
          disabled={props.disabled || !next}
          onClick={() => next && props.onChange(selectionFromEffectiveServiceTier(next.value))}
        >
          {icon}
        </Button>
      </IconTooltip>
    );
  }

  return (
    <ComposerDropdown
      label={zh ? '速度' : 'Speed'}
      triggerLabel={title}
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
