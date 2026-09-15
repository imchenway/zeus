import { lazy } from 'react';
import { AutomationsWorkspace } from './tools/AutomationsWorkspace.js';
import { ExtensionsWorkspace } from './tools/ExtensionsWorkspace.js';

/** 数字团队画布只在用户进入入口后加载，避免 React Flow 增加普通会话首屏体积。 */
const DigitalTeamWorkspace = lazy(() => import('../features/digital-teams/DigitalTeamWorkspace.js').then((module) => ({ default: module.DigitalTeamWorkspace })));

/** 桌面渲染端唯一的 Zeus 组装入口，不向工具页暴露工作台内部状态。 */
export const toolPages = { automations: AutomationsWorkspace, digitalTeams: DigitalTeamWorkspace, extensions: ExtensionsWorkspace } as const;
export { zeusDistribution, zeusReleaseBaseUrl } from './distribution.js';
