import type { SVGProps } from 'react';

/** 消息图标沿用原生矢量属性，绘制内容由组件统一提供。 */
type MessageIconProps = Omit<SVGProps<SVGSVGElement>, 'children'>;

/** 统一线宽和圆头描边，保留消息操作的现有视觉分量。 */
function iconProps(props: MessageIconProps): SVGProps<SVGSVGElement> {
  return {
    ...props,
    'aria-hidden': true,
    fill: 'none',
    focusable: 'false',
    stroke: 'currentColor',
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    strokeWidth: 1.7,
    viewBox: '0 0 24 24',
  };
}

/** 保留两个方框的原有重叠位置，仅柔化边角；后框省略被遮挡的边。 */
export function MessageCopyIcon(props: MessageIconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M8.25 8.25V4.4q0-.65.65-.65h10.7q.65 0 .65.65v10.7q0 .65-.65.65h-3.85" />
      <rect x="3.75" y="8.25" width="12" height="12" rx=".65" />
    </svg>
  );
}

export function MessageCheckIcon(props: MessageIconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="m5 12.5 4.25 4.25L19 7" />
    </svg>
  );
}

/** 赞和踩共用微圆角轮廓，保留上下翻转和选中填充。 */
export function MessageThumbIcon(props: MessageIconProps & { direction: 'up' | 'down'; selected?: boolean }) {
  /** 状态属性仅控制绘制，不透传到矢量根节点。 */
  const { direction, selected, ...svgProps } = props;
  return (
    <svg {...iconProps(svgProps)} fill={selected ? 'currentColor' : 'none'}>
      <g transform={direction === 'down' ? 'rotate(180 12 12)' : undefined}>
        <path d="M8 10.75q0-.4.2-.77l2.9-5.58c.42-.78 1.58-.62 1.78.24.13.56.19 1.14.19 1.72 0 .95-.18 1.88-.53 2.77q-.14.35.24.35h4.83a2.1 2.1 0 0 1 2.04 2.58l-1.3 5.55a2.65 2.65 0 0 1-2.58 2.04H8.55q-.55 0-.55-.55Z" />
        <rect x="4.25" y="10.1" width="3.75" height="9.55" rx=".55" />
      </g>
    </svg>
  );
}

/** 展开和收起保留箭头方向与跨度，用短圆弧连接箭头两翼。 */
export function MessageExpandIcon(props: MessageIconProps & { collapsed?: boolean }) {
  /** 根据当前展开状态选择对应方向，不改变按钮交互。 */
  const { collapsed, ...svgProps } = props;
  return collapsed ? (
    <svg {...iconProps(svgProps)}>
      <path d="M9.5 3.75V8.9q0 .6-.6.6H3.75M14.5 20.25V15.1q0-.6.6-.6h5.15M9.32 9.32 3.75 3.75M14.68 14.68l5.57 5.57" />
    </svg>
  ) : (
    <svg {...iconProps(svgProps)}>
      <path d="M14.5 3.75h5.15q.6 0 .6.6V9.5M9.5 20.25H4.35q-.6 0-.6-.6V14.5M14.5 9.5l5.57-5.57M9.5 14.5l-5.57 5.57" />
    </svg>
  );
}

export function MessageEditIcon(props: MessageIconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="m14.5 5.5 4 4M5.25 18.75l3.85-.78 9.02-9.02a1.9 1.9 0 0 0 0-2.69l-.38-.38a1.9 1.9 0 0 0-2.69 0L6.03 14.9Z" />
      <path d="M4.75 20.25h14.5" />
    </svg>
  );
}

export function MessageRemoteDeviceIcon(props: MessageIconProps) {
  return (
    <svg {...iconProps(props)}>
      <rect x="7.25" y="2.75" width="9.5" height="18.5" rx="2" />
      <path d="M10 5.75h4M10.75 18.25h2.5" />
    </svg>
  );
}
