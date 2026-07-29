import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type SourceListRowButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  [attribute: `data-${string}`]: string | undefined;
};

interface SourceListRowCommonProps {
  surface: 'content' | 'fill';
  icon: ReactNode;
  label: ReactNode;
  state?: ReactNode;
  actions?: ReactNode;
  expanded?: boolean;
  className?: string;
  buttonProps: SourceListRowButtonProps;
}

export type SourceListRowProps = SourceListRowCommonProps &
  (
    | {
        level: 'root';
        selected?: never;
      }
    | {
        level: 'nested';
        selected?: boolean;
      }
  );

export function SourceListRow(props: SourceListRowProps) {
  const { className: buttonClassName, ...buttonProps } = props.buttonProps;
  const className = ['zeus-source-list-row', props.className].filter(Boolean).join(' ');
  const mainClassName = ['zeus-source-list-row-main', buttonClassName].filter(Boolean).join(' ');

  return (
    <div
      className={className}
      data-zeus-primitive="source-list-row"
      data-source-list-level={props.level}
      data-source-list-surface={props.surface}
      data-selected={props.level === 'nested' && props.selected ? 'true' : undefined}
      data-expanded={props.expanded === undefined ? undefined : props.expanded ? 'true' : 'false'}
    >
      <button {...buttonProps} className={mainClassName} aria-expanded={props.expanded}>
        <span className="zeus-source-list-row-icon" aria-hidden="true">
          {props.icon}
        </span>
        <span className="zeus-source-list-row-label">{props.label}</span>
        {props.state ? <span className="zeus-source-list-row-state">{props.state}</span> : null}
      </button>
      {props.actions ? <div className="zeus-source-list-row-actions">{props.actions}</div> : null}
    </div>
  );
}
