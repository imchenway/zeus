import type {SVGProps} from 'react';

type MessageIconProps = Omit<SVGProps<SVGSVGElement>, 'children'>;

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

export function MessageCheckIcon(props: MessageIconProps) {
    return (
        <svg {...iconProps(props)}>
            <path d="m5 12.5 4.25 4.25L19 7"/>
        </svg>
    );
}

export function MessageThumbIcon(props: MessageIconProps & { direction: 'up' | 'down'; selected?: boolean }) {
    const {direction, selected, ...svgProps} = props;
    return (
        <svg {...iconProps(svgProps)} fill={selected ? 'currentColor' : 'none'}>
            <g transform={direction === 'down' ? 'rotate(180 12 12)' : undefined}>
                <path
                    d="M8 10.1 11.1 4.4c.42-.78 1.58-.62 1.78.24.13.56.19 1.14.19 1.72 0 1.08-.24 2.14-.69 3.12h5.23a2.1 2.1 0 0 1 2.04 2.58l-1.3 5.55a2.65 2.65 0 0 1-2.58 2.04H8Z"/>
                <path d="M4.25 10.1H8v9.55H4.25Z"/>
            </g>
        </svg>
    );
}

export function MessageExpandIcon(props: MessageIconProps & { collapsed?: boolean }) {
    const {collapsed, ...svgProps} = props;
    return collapsed ? (
        <svg {...iconProps(svgProps)}>
            <path d="M9.5 3.75v5.75H3.75M14.5 20.25V14.5h5.75M9.5 9.5 3.75 3.75M14.5 14.5l5.75 5.75"/>
        </svg>
    ) : (
        <svg {...iconProps(svgProps)}>
            <path d="M14.5 3.75h5.75V9.5M9.5 20.25H3.75V14.5M14.5 9.5l5.75-5.75M9.5 14.5l-5.75 5.75"/>
        </svg>
    );
}

export function MessageEditIcon(props: MessageIconProps) {
    return (
        <svg {...iconProps(props)}>
            <path
                d="m14.5 5.5 4 4M5.25 18.75l3.85-.78 9.02-9.02a1.9 1.9 0 0 0 0-2.69l-.38-.38a1.9 1.9 0 0 0-2.69 0L6.03 14.9Z"/>
            <path d="M4.75 20.25h14.5"/>
        </svg>
    );
}
