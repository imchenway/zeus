import {forwardRef, type ButtonHTMLAttributes} from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'danger';
export type ButtonSize = 'compact' | 'regular';

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  busy?: boolean;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {busy = false, className, disabled, size = 'regular', type = 'button', variant = 'secondary', ...buttonProps},
  ref,
) {
  return (
    <button
      {...buttonProps}
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
