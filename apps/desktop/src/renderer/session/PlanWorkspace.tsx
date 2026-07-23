import {ArrowsInIcon as ArrowsIn} from '@phosphor-icons/react/dist/csr/ArrowsIn';
import {ArrowsOutIcon as ArrowsOut} from '@phosphor-icons/react/dist/csr/ArrowsOut';
import {LightbulbIcon as Lightbulb} from '@phosphor-icons/react/dist/csr/Lightbulb';
import {XIcon as X} from '@phosphor-icons/react/dist/csr/X';
import type {NativeSessionItemBuffer} from './sessionTypes.js';
import {SafeMarkdown, type SessionUiLanguage} from './ThreadItemView.js';

export function PlanWorkspace(props: {
    item: NativeSessionItemBuffer;
    language: SessionUiLanguage;
    fullWidth: boolean;
    onFullWidthChange: (fullWidth: boolean) => void;
    onClose: () => void
}) {
    const zh = props.language === 'zh-CN';
    return (
        <aside className="session-plan-workspace" data-full-width={props.fullWidth || undefined}
               aria-label={zh ? '计划工作区' : 'Plan workspace'}>
            <header>
        <span className="session-plan-workspace-tab">
          <Lightbulb aria-hidden="true" weight="regular"/>
          <strong>{zh ? '计划' : 'Plan'}</strong>
        </span>
                <nav aria-label={zh ? '计划工作区操作' : 'Plan workspace actions'}>
                    <button
                        type="button"
                        aria-label={props.fullWidth ? (zh ? '恢复分栏' : 'Restore split') : zh ? '扩展为全宽' : 'Expand full width'}
                        title={props.fullWidth ? (zh ? '恢复分栏' : 'Restore split') : zh ? '扩展为全宽' : 'Expand full width'}
                        onClick={() => props.onFullWidthChange(!props.fullWidth)}
                    >
                        {props.fullWidth ? <ArrowsIn aria-hidden="true"/> : <ArrowsOut aria-hidden="true"/>}
                    </button>
                    <button type="button" aria-label={zh ? '关闭计划工作区' : 'Close plan workspace'}
                            title={zh ? '关闭' : 'Close'} onClick={props.onClose}>
                        <X aria-hidden="true"/>
                    </button>
                </nav>
            </header>
            <section className="session-plan-workspace-content">
                <SafeMarkdown text={props.item.text} language={props.language}/>
            </section>
        </aside>
    );
}
