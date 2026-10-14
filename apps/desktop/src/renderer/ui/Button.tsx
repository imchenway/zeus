import { forwardRef, type ButtonHTMLAttributes } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'danger';
export type ButtonSize = 'compact' | 'regular';

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  /** 显式提示优先于原有 title 参数，避免同一按钮弹出两种提示。 */
  'data-icon-tooltip'?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  busy?: boolean;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ busy = false, className, disabled, size = 'regular', title, type = 'button', variant = 'secondary', ...buttonProps }, ref) {
  return (
    <button
      {...buttonProps}
      data-icon-tooltip={buttonProps['data-icon-tooltip'] || title}
      ref={ref}
      type={type}
      className={['zeus-button', className].filter(Boolean).join(' ')}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      data-loading={busy ? 'true' : undefined}
      data-zeus-primitive="button"
      data-button-size={size}
      data-button-variant={variant}
    />
  );
});
