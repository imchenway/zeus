import { createContext } from 'react';

/** 会话侧栏只协调显示位置，不持有或更改项目底栏的业务状态。 */
export const ProjectToolContext = createContext({
  /** 项目底栏打开时，会话保留侧栏内容但暂时隐藏。 */
  open: false,
  /** 用户主动打开会话内容时让出项目底栏区域。 */
  revealSessionContext: () => {},
});
