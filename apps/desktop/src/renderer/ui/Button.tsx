import { forwardRef, type ButtonHTMLAttributes, type MouseEvent } from 'react';
import { useFormPending } from './Form.js';
import { useAsyncAction } from './useAsyncAction.js';

export type ButtonVariant = 'primary' | 'secondary' | 'danger';
export type ButtonSize = 'compact' | 'regular';

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  /** 显式提示优先于原有 title 参数，避免同一按钮弹出两种提示。 */
  'data-icon-tooltip'?: string;
  /** 导航或缓存校准保留可点击与焦点；命令提交默认锁定当前按钮。 */
  'data-busy-behavior'?: 'background';
  variant?: ButtonVariant;
  size?: ButtonSize;
  busy?: boolean;
  /** 专用控件保留自身外观与原生默认提交语义，只复用交互反馈。 */
  unstyled?: boolean;
};

/** 所有按钮共享异步反馈，专用按钮通过 unstyled 保留原有布局。 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ busy = false, className, disabled, onClick, onDoubleClick, size = 'regular', title, type, unstyled = false, variant = 'secondary', ...buttonProps }, ref) {
  /** 已经打开工作面的读取不占用来源按钮，关闭后仍可重新进入。 */
  const background = buttonProps['data-busy-behavior'] === 'background';
  /** 单击选择与双击命令共用互斥状态；文件导航通过 background 保留原生双击序列。 */
  const action = useAsyncAction((event: MouseEvent<HTMLButtonElement>) => (event.type === 'dblclick' ? onDoubleClick?.(event) : onClick?.(event)));
  /** 回车提交与点击提交共享表单状态，旁边的取消和导航仍可使用。 */
  const formPending = useFormPending();
  /** 专用控件沿用原生默认类型，标准按钮默认不触发表单。 */
  const buttonType = type ?? (unstyled ? undefined : 'button');
  /** 忙碌范围只包含本次动作和所属表单，不读取页面级加载标记。 */
  const pending = busy || action.pending || (formPending && (buttonType === undefined || buttonType === 'submit'));
  return (
    <button
      {...buttonProps}
      data-icon-tooltip={buttonProps['data-icon-tooltip'] || title}
      ref={ref}
      type={buttonType}
      className={unstyled ? className : ['zeus-button', className].filter(Boolean).join(' ')}
      onClick={background ? onClick : action.execute}
      onDoubleClick={onDoubleClick ? (background ? onDoubleClick : action.execute) : undefined}
      disabled={disabled || (!background && pending)}
      aria-busy={pending || buttonProps['aria-busy'] || undefined}
      {...(pending ? { 'data-loading': 'true' } : {})}
      {...(unstyled ? {} : { 'data-zeus-primitive': 'button', 'data-button-size': size, 'data-button-variant': variant })}
    />
  );
});
