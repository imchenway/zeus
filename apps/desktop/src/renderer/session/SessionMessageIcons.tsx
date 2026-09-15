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

/** 保留双框位置，用实际尺寸下可见的圆角和轻描边柔化轮廓。 */
export function MessageCopyIcon(props: MessageIconProps) {
  return (
    <svg {...iconProps(props)} strokeWidth={1.5}>
      <path d="M8.25 8.25V5.4A1.65 1.65 0 0 1 9.9 3.75h8.7a1.65 1.65 0 0 1 1.65 1.65v8.7a1.65 1.65 0 0 1-1.65 1.65h-2.85" />
      <rect x="3.75" y="8.25" width="12" height="12" rx="1.65" />
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

/** 赞和踩共用连续轮廓；选中时仅加淡填色，保留袖口分界与清晰描边。 */
export function MessageThumbIcon(props: MessageIconProps & { direction: 'up' | 'down'; selected?: boolean }) {
  /** 状态属性仅控制绘制，不透传到矢量根节点。 */
  const { direction, selected, ...svgProps } = props;
  return (
    <svg {...iconProps(svgProps)} strokeWidth={1.5} fill={selected ? 'currentColor' : 'none'} fillOpacity={0.12}>
      <g transform={direction === 'down' ? 'rotate(180 12 12)' : undefined}>
        <path d="M8 10.25c.75-.85 1.45-2.2 2.1-3.55l.95-1.95c.35-.7.95-.8 1.4-.25.95 1.15.55 2.9.1 4.35-.1.35.1.6.45.6h4.5c1.45 0 2.4 1.2 2.05 2.6l-1.25 5.2c-.35 1.5-1.3 2.35-2.85 2.35H5.5c-.7 0-1.25-.55-1.25-1.25V11.5c0-.7.55-1.25 1.25-1.25Z" />
        <path d="M8 10.25v9.35" fill="none" />
      </g>
    </svg>
  );
}

/** 箭头轮廓向中心收拢，与相邻图标平衡视觉大小，保留线宽和按钮点击范围。 */
export function MessageExpandIcon(props: MessageIconProps & { collapsed?: boolean }) {
  /** 根据当前展开状态选择对应方向，不改变按钮交互。 */
  const { collapsed, ...svgProps } = props;
  return collapsed ? (
    <svg {...iconProps(svgProps)} strokeWidth={1.5}>
      <path d="M9.75 5v3.8q0 .95-.95 .95H5M14.25 19v-3.8q0-.95.95-.95H19M9.5 9.5 5 5M14.5 14.5 19 19" />
    </svg>
  ) : (
    <svg {...iconProps(svgProps)} strokeWidth={1.5}>
      <path d="M14.25 5h3.8q.95 0 .95.95v3.8M9.75 19h-3.8q-.95 0-.95-.95v-3.8M14.25 9.75l4.5-4.5M9.75 14.25l-4.5 4.5" />
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
