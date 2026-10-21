import type { SVGProps } from 'react';
import { PencilSimpleLineIcon } from '@phosphor-icons/react/dist/csr/PencilSimpleLine';

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

/** 编辑消息使用库内铅笔与底线图形，按钮尺寸和点击范围由原样式控制。 */
export function MessageEditIcon(props: MessageIconProps) {
  return <PencilSimpleLineIcon {...props} weight="regular" aria-hidden="true" focusable="false" />;
}

/** 轮次消耗使用 Hugeicons Token Circle 原始路径；来源为 core-free-icons 4.3.5，许可见 assets/hugeicons/LICENSE.md。 */
export function MessageTokenIcon(props: MessageIconProps) {
  return (
    <svg {...iconProps(props)} strokeWidth={1.5}>
      <path d="M11.5384 7.2534C11.7534 6.91553 12.2466 6.91553 12.4616 7.2534L13.0837 8.23082C13.7716 9.3117 14.6883 10.2284 15.7692 10.9163L16.7466 11.5384C17.0845 11.7534 17.0845 12.2466 16.7466 12.4616L15.7692 13.0837C14.6883 13.7716 13.7716 14.6883 13.0837 15.7692L12.4616 16.7466C12.2466 17.0845 11.7534 17.0845 11.5384 16.7466L10.9163 15.7692C10.2284 14.6883 9.3117 13.7716 8.23082 13.0837L7.2534 12.4616C6.91553 12.2466 6.91553 11.7534 7.2534 11.5384L8.23082 10.9163C9.3117 10.2284 10.2284 9.3117 10.9163 8.23082L11.5384 7.2534Z" />
      <circle cx="12" cy="12" r="10" />
    </svg>
  );
}

/** 轮次费用使用 Hugeicons Money 03 原始路径；来源与许可同 MessageTokenIcon。 */
export function MessageCostIcon(props: MessageIconProps) {
  return (
    <svg {...iconProps(props)} strokeWidth={1.5}>
      <path d="M14.4998 12.001C14.4998 13.3817 13.3805 14.501 11.9998 14.501C10.6191 14.501 9.49982 13.3817 9.49982 12.001C9.49982 10.6203 10.6191 9.50098 11.9998 9.50098C13.3805 9.50098 14.4998 10.6203 14.4998 12.001Z" />
      <path d="M16 5.00098C18.4794 5.00098 20.1903 5.38518 21.1329 5.6773C21.6756 5.84549 22 6.35987 22 6.92803V16.6833C22 17.7984 20.7719 18.6374 19.6762 18.4305C18.7361 18.253 17.5107 18.1104 16 18.1104C11.2491 18.1104 10.1096 19.9161 3.1448 18.3802C2.47265 18.232 2 17.6275 2 16.9392V6.92214C2 5.94628 2.92079 5.23464 3.87798 5.42458C10.1967 6.67844 11.4209 5.00098 16 5.00098Z" />
      <path d="M2 9.00098C3.95133 9.00098 5.70483 7.40605 5.92901 5.75514M18.5005 5.50098C18.5005 7.54062 20.2655 9.46997 22 9.46997M22 15.001C20.1009 15.001 18.2601 16.3112 18.102 18.0993M6.00049 18.4971C6.00049 16.2879 4.20963 14.4971 2.00049 14.4971" />
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
