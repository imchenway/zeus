import type { ReactNode } from 'react';
import { useMotionPresence } from './useMotionPresence.js';

/** 受控折叠共用高度过渡；收起立即退出键盘与读屏导航，过渡结束才释放内容。 */
export function Collapsible(props: { open: boolean; id?: string; children: ReactNode; /** 开合及异步内容变化共用连续的高度过渡。 */ animateHeight?: boolean }) {
  /** 展开期间保留组件身份，连续点击直接反转当前过渡。 */
  const { ref, contentRef, present } = useMotionPresence<HTMLDivElement>(props.open, props.animateHeight);
  return (
    <div ref={ref} id={props.id} data-zeus-primitive="collapsible" data-open={props.open} data-animate-height={props.animateHeight || undefined} inert={!props.open} aria-hidden={!props.open}>
      {props.animateHeight ? (
        <div ref={contentRef} style={{ display: 'flow-root' }}>
          {present ? props.children : null}
        </div>
      ) : present ? (
        props.children
      ) : null}
    </div>
  );
}
