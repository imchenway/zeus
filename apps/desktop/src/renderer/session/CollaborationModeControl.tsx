import {LightbulbIcon as Lightbulb} from '@phosphor-icons/react/dist/csr/Lightbulb';
import {XIcon as X} from '@phosphor-icons/react/dist/csr/X';
import type {NativeCollaborationMode} from './sessionTypes.js';
import type {SessionUiLanguage} from './ThreadItemView.js';

export function CollaborationModeControl(props: {
    language: SessionUiLanguage;
    value: NativeCollaborationMode;
    disabled?: boolean;
    onChange: (mode: NativeCollaborationMode) => void | Promise<void>
}) {
    const plan = props.value === 'plan';
    const label = props.language === 'zh-CN' ? '计划' : 'Plan';
    const action = plan ? (props.language === 'zh-CN' ? '退出 PLAN 模式' : 'Exit Plan mode') : props.language === 'zh-CN' ? '创建计划' : 'Create a plan';
    return (
        <button
            type="button"
            className="session-collaboration-mode"
            data-active={plan || undefined}
            aria-pressed={plan}
            aria-label={action}
            title={action}
            disabled={props.disabled}
            onClick={() => void props.onChange(plan ? 'default' : 'plan')}
        >
            <Lightbulb aria-hidden="true" weight={plan ? 'fill' : 'regular'}/>
            <span>{label}</span>
            {plan ? <X className="session-collaboration-mode-close" aria-hidden="true"/> : null}
        </button>
    );
}
