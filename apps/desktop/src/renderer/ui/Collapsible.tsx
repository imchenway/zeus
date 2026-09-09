import type { ReactNode } from 'react';
import { useMotionPresence } from './useMotionPresence.js';

/** 受控折叠共用高度过渡；收起立即退出键盘与读屏导航，过渡结束才释放内容。 */
export function Collapsible(props: { open: boolean; id?: string; children: ReactNode }) {
  /** 展开期间保留组件身份，连续点击直接反转当前过渡。 */
  const { ref, present } = useMotionPresence<HTMLDivElement>(props.open);
  return (
    <div ref={ref} id={props.id} data-zeus-primitive="collapsible" data-open={props.open} inert={!props.open} aria-hidden={!props.open}>
      {present ? props.children : null}
    </div>
  );
}
