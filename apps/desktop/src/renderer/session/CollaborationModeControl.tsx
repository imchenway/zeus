import { ListChecksIcon as ListChecks } from '@phosphor-icons/react/dist/csr/ListChecks';
import type { NativeCollaborationMode } from './sessionTypes.js';
import type { SessionUiLanguage } from './ThreadItemView.js';

/** 展示计划模式是否仍在规划，正式计划只能通过确认动作进入实施。 */
export function CollaborationModeControl(props: {
  language: SessionUiLanguage;
  value: NativeCollaborationMode;
  /** 当前会话是否已有等待用户确认的正式计划。 */
  formalPlanReady?: boolean;
  disabled?: boolean;
  onChange: (mode: NativeCollaborationMode) => void | Promise<void>;
}) {
  const plan = props.value === 'plan';
  const action = plan ? (props.language === 'zh-CN' ? '退出计划模式' : 'Exit plan mode') : props.language === 'zh-CN' ? '创建计划' : 'Create a plan';
  /** 开启后持续说明规划状态，权限继续由独立控件表达。 */
  const title =
    props.language === 'zh-CN'
      ? plan
        ? props.formalPlanReady
          ? `计划模式：正式计划待确认；${action}`
          : `计划模式：正在规划，尚未形成正式计划，下一条消息继续规划；${action}`
        : `计划模式：关闭；${action}`
      : plan
        ? props.formalPlanReady
          ? `Plan mode: formal plan awaiting confirmation; ${action}`
          : `Plan mode: planning without implementation; no formal plan yet, the next message continues planning; ${action}`
        : `Plan mode: off; ${action}`;
  return (
    <button type="button" className="session-collaboration-mode" data-active={plan || undefined} aria-pressed={plan} aria-label={title} title={title} disabled={props.disabled} onClick={() => void props.onChange(plan ? 'default' : 'plan')}>
      <span className="session-collaboration-mode-icon" aria-hidden="true">
        <ListChecks weight={plan ? 'bold' : 'regular'} />
      </span>
    </button>
  );
}
