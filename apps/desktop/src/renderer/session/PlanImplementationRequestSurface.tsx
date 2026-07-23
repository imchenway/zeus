import {type FormEvent, useEffect, useRef, useState} from 'react';
import {ArrowRightIcon as ArrowRight} from '@phosphor-icons/react/dist/csr/ArrowRight';
import {PencilSimpleIcon as PencilSimple} from '@phosphor-icons/react/dist/csr/PencilSimple';
import {XIcon as X} from '@phosphor-icons/react/dist/csr/X';
import type {NativePlanImplementationRequest} from './sessionTypes.js';
import type {SessionUiLanguage} from './ThreadItemView.js';

export function PlanImplementationRequestSurface(props: {
    request: NativePlanImplementationRequest;
    language: SessionUiLanguage;
    busy?: boolean;
    error?: string | null;
    autoFocus?: boolean;
    onRespond: (requestId: string, input: {
        action: 'implement' | 'refine' | 'dismiss';
        feedback?: string
    }) => void | Promise<void>;
}) {
    const zh = props.language === 'zh-CN';
    const [feedbackOpen, setFeedbackOpen] = useState(false);
    const [feedback, setFeedback] = useState('');
    const primaryRef = useRef<HTMLButtonElement | null>(null);
    const inputRef = useRef<HTMLTextAreaElement | null>(null);

    useEffect(() => {
        if (props.autoFocus !== false) primaryRef.current?.focus();
    }, [props.autoFocus, props.request.id]);
    useEffect(() => {
        if (feedbackOpen) inputRef.current?.focus();
    }, [feedbackOpen]);

    function submitFeedback(event: FormEvent): void {
        event.preventDefault();
        if (!feedback.trim() || props.busy) return;
        void props.onRespond(props.request.id, {action: 'refine', feedback: feedback.trim()});
    }

    return (
        <section className="session-question-panel session-plan-implementation-request"
                 aria-busy={props.busy || undefined} data-error={Boolean(props.error) || undefined}
                 data-request-id={props.request.id}>
            <header>
                <strong>{zh ? '实施此计划？' : 'Implement this plan?'}</strong>
                <button type="button" aria-label={zh ? '关闭' : 'Close'}
                        onClick={() => void props.onRespond(props.request.id, {action: 'dismiss'})}
                        disabled={props.busy}>
                    <X aria-hidden="true"/>
                </button>
            </header>
            <div className="session-question-options">
                <button ref={primaryRef} type="button" className="session-question-option is-primary"
                        onClick={() => void props.onRespond(props.request.id, {action: 'implement'})}
                        disabled={props.busy}>
                    <span className="session-question-index">1</span>
                    <span className="session-question-option-copy">
            <strong>{zh ? '是，实施此计划' : 'Yes, implement this plan'}</strong>
          </span>
                    <ArrowRight aria-hidden="true"/>
                </button>
                {feedbackOpen ? (
                    <form className="session-plan-refinement" onSubmit={submitFeedback}>
            <span className="session-question-index">
              <PencilSimple aria-hidden="true"/>
            </span>
                        <textarea
                            ref={inputRef}
                            value={feedback}
                            placeholder={zh ? '告诉 Codex 应该如何做得不同' : 'Tell Codex what to do differently'}
                            onChange={(event) => setFeedback(event.currentTarget.value)}
                            onKeyDown={(event) => {
                                if (event.key === 'Enter' && !event.shiftKey) {
                                    event.preventDefault();
                                    event.currentTarget.form?.requestSubmit();
                                }
                            }}
                        />
                        <button type="submit" disabled={!feedback.trim() || props.busy}>
                            {zh ? '提交' : 'Submit'}
                        </button>
                    </form>
                ) : (
                    <button type="button" className="session-question-option session-question-option-other"
                            onClick={() => setFeedbackOpen(true)} disabled={props.busy}>
            <span className="session-question-index">
              <PencilSimple aria-hidden="true"/>
            </span>
                        <span
                            className="session-question-option-copy">{zh ? '否，并告诉 Codex 应该如何做得不同' : 'No, tell Codex what to do differently'}</span>
                    </button>
                )}
            </div>
            <footer>
                {props.error ? <p role="alert">{props.error}</p> : <span/>}
                <button type="button" onClick={() => void props.onRespond(props.request.id, {action: 'dismiss'})}
                        disabled={props.busy}>
                    {zh ? '跳过' : 'Skip'}
                </button>
            </footer>
        </section>
    );
}
