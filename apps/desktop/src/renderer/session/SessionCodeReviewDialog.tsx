import { type FormEvent, type KeyboardEvent, useEffect, useMemo, useState } from 'react';
import type { CodexConversationCapabilities, CodexTaskPushModelCapability, NativeConversationChoice, NativePermissionMode, NativeServiceTierSelection, NativeSessionState, TaskWorkspaceSnapshot } from './sessionTypes.js';
import { normalizeServiceTierSelection, serviceTierOptions, serviceTierSelectionFromValue, serviceTierSelectionValue } from './serviceTierSelection.js';
import { resolveModelCapability } from './modelSelection.js';
import type { SessionUiLanguage } from './ThreadItemView.js';
import { Button } from '../ui/Button.js';
import { ModalPortal } from '../ui/ModalPortal.js';
import { ZeusSelect } from '../ZeusSelect.js';
import { readConversationRuntimePreferences, writeConversationRuntimePreferences } from './conversationRuntimePreferences.js';
import { presentModelOptions } from '../modelOptionPresentation.js';
import { useApplicationErrorDialog } from '../ui/ApplicationErrorDialog.js';
import { SkillSelector } from '../features/skills/SkillSelector.js';
import { readSkillWorkflowDefault } from '../features/skills/skillWorkflowPreferences.js';
import type { CodexApiClient } from '../features/codex/codexApiClient.js';

export interface SessionCodeReviewSelection {
  agentKind: 'codex' | 'pi';
  model: string;
  effort: string;
  serviceTierSelection: NativeServiceTierSelection;
  permissionMode: NativePermissionMode;
  skillId?: string;
}

interface SessionCodeReviewForm {
  model: string;
  effort: string;
  serviceTierSelection: NativeServiceTierSelection;
  serviceTierDowngraded: boolean;
  skillId: string;
}

interface SessionCodeReviewDialogProps {
  open: boolean;
  language: SessionUiLanguage;
  conversation: NativeConversationChoice;
  state: NativeSessionState;
  workspace: TaskWorkspaceSnapshot | null;
  capabilities: CodexConversationCapabilities | null;
  onLoadCapabilities?: (projectId: string) => Promise<CodexConversationCapabilities>;
  onLoadSkills?: Pick<CodexApiClient, 'loadSkills'>['loadSkills'];
  onClose: () => void;
  onStart?: (
    selection: SessionCodeReviewSelection,
  ) => void | boolean | { state: 'preparing'; cancel: () => void } | { state: 'failed'; message: string } | Promise<void | boolean | { state: 'preparing'; cancel: () => void } | { state: 'failed'; message: string }>;
}

export function SessionCodeReviewDialog(props: SessionCodeReviewDialogProps) {
  const zh = props.language === 'zh-CN';
  const permissionMode: NativePermissionMode = 'read-only';
  const inheritedModel = props.state.snapshot?.nextTurnSettings?.model ?? props.state.providerSettings?.model ?? props.conversation.providerModel ?? '';
  const inheritedEffort = props.state.snapshot?.nextTurnSettings?.effort ?? props.state.providerSettings?.effort ?? '';
  const inheritedServiceTier = props.state.snapshot?.nextTurnSettings?.serviceTier ?? props.state.providerSettings?.serviceTier;
  const [capabilities, setCapabilities] = useState<CodexConversationCapabilities | null>(null);
  const [form, setForm] = useState<SessionCodeReviewForm | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'submitting' | 'preparing' | 'error'>('loading');
  const [error, setError] = useState<unknown>(null);
  useApplicationErrorDialog(error, {
    language: zh ? 'zh-CN' : 'en',
  });
  const [cancelPreparation, setCancelPreparation] = useState<(() => void) | null>(null);

  useEffect(() => {
    if (!props.open) {
      setCapabilities(null);
      setForm(null);
      setStatus('loading');
      setError(null);
      setCancelPreparation(null);
      return;
    }

    let active = true;
    const acceptCapabilities = (nextCapabilities: CodexConversationCapabilities): void => {
      if (!active) return;
      const remembered = readConversationRuntimePreferences(browserStorage(), props.conversation.projectId, 'code_review');
      setCapabilities(nextCapabilities);
      setForm(
        (current) =>
          current ??
          resolveInitialForm(
            nextCapabilities,
            remembered?.model ?? inheritedModel,
            remembered?.effort ?? inheritedEffort,
            remembered?.serviceTier.type === 'catalog' ? remembered.serviceTier.id : remembered?.serviceTier.type === 'standard' ? null : inheritedServiceTier,
            readSkillWorkflowDefault('code_review'),
          ),
      );
      setStatus('ready');
      setError(null);
    };

    if (props.capabilities) {
      acceptCapabilities(props.capabilities);
      return () => {
        active = false;
      };
    }

    if (!props.onLoadCapabilities) {
      setStatus('error');
      setError(zh ? '模型配置读取入口不可用。' : 'Model configuration loading is unavailable.');
      return () => {
        active = false;
      };
    }

    setStatus('loading');
    setError(null);
    void props
      .onLoadCapabilities(props.conversation.projectId)
      .then(acceptCapabilities)
      .catch((reason: unknown) => {
        if (!active) return;
        setStatus('error');
        setError(reason);
      });
    return () => {
      active = false;
    };
  }, [inheritedEffort, inheritedModel, inheritedServiceTier, props.capabilities, props.conversation.projectId, props.onLoadCapabilities, props.open, zh]);

  const modelPresentation = useMemo(() => presentModelOptions(capabilities?.models ?? [], form?.model ?? '', props.language), [capabilities?.models, form?.model, props.language]);
  const selectedModel = useMemo(() => resolveModelCapability(modelPresentation.models, modelPresentation.selectedId) ?? undefined, [modelPresentation.models, modelPresentation.selectedId]);
  const skillClient = useMemo(() => (props.onLoadSkills ? { loadSkills: props.onLoadSkills } : null), [props.onLoadSkills]);

  useEffect(() => {
    if (!props.open || !form) return;
    writeConversationRuntimePreferences(browserStorage(), props.conversation.projectId, 'code_review', {
      model: form.model,
      ...(form.effort ? { effort: form.effort } : {}),
      serviceTier: form.serviceTierSelection,
      permissionMode,
      collaborationMode: 'default',
    });
  }, [form, permissionMode, props.conversation.projectId, props.open]);
  if (!props.open) return null;
  const busy = status === 'submitting';

  function close(): void {
    cancelPreparation?.();
    props.onClose();
  }

  function changeModel(model: string): void {
    if (!form) return;
    const capability = findModel(capabilities, model);
    const normalizedTier = normalizeServiceTierSelection(form.serviceTierSelection, capability);
    setForm({
      model: capability?.id ?? model,
      effort: capability?.defaultReasoningEffort ?? capability?.supportedReasoningEfforts[0] ?? '',
      serviceTierSelection: normalizedTier.selection,
      serviceTierDowngraded: normalizedTier.downgraded,
      skillId: form.skillId,
    });
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!form || !selectedModel || !props.onStart) {
      setStatus('error');
      setError(zh ? '当前现场无法启动代码审查。' : 'Code review cannot be started from the current context.');
      return;
    }
    setStatus('submitting');
    setError(null);
    try {
      const accepted = await props.onStart({
        agentKind: selectedModel.agentKind === 'pi' ? 'pi' : 'codex',
        model: selectedModel.id,
        effort: form.effort,
        serviceTierSelection: form.serviceTierSelection,
        permissionMode,
        ...(form.skillId ? { skillId: form.skillId } : {}),
      });
      if (accepted === false) throw new Error(zh ? '代码审查会话未被接受，请查看当前错误提示。' : 'The code review conversation was not accepted. Check the current error notice.');
      if (accepted && typeof accepted === 'object' && accepted.state === 'failed') throw new Error(accepted.message);
      if (accepted && typeof accepted === 'object' && accepted.state === 'preparing') {
        setCancelPreparation(() => accepted.cancel);
        setStatus('preparing');
        return;
      }
      props.onClose();
    } catch (reason) {
      setStatus('error');
      setError(reason);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLFormElement>): void {
    if (event.key !== 'Escape' || busy) return;
    event.preventDefault();
    close();
  }

  return (
    <ModalPortal rootClassName="session-code-review-portal-root" dismissDisabled={busy} onDismiss={close}>
      <form className="session-code-review-modal zeus-solid-form-surface" role="dialog" aria-modal="true" aria-labelledby="session-code-review-title" onSubmit={(event) => void submit(event)} onKeyDown={handleKeyDown}>
        <header>
          <span>
            <strong id="session-code-review-title">{zh ? '开始代码审查' : 'Start code review'}</strong>
            <small>{zh ? '创建独立 AI 会话，并复用当前执行环境' : 'Create an independent AI conversation in the current execution environment'}</small>
          </span>
          <button type="button" aria-label={zh ? '关闭' : 'Close'} onClick={close} disabled={busy}>
            ×
          </button>
        </header>

        <div className="session-code-review-body">
          <section className="session-code-review-scope" aria-labelledby="session-code-review-scope-title">
            <span>
              <strong id="session-code-review-scope-title">{zh ? '审查范围' : 'Review scope'}</strong>
              <small>{zh ? '只审查当前会话对应仓库，不会自动跨到同一环境的其他仓库。' : 'Only the repository attached to this conversation is reviewed; other repositories in the environment are excluded.'}</small>
            </span>
            <dl>
              <div>
                <dt>{zh ? '仓库' : 'Repository'}</dt>
                <dd>{props.workspace?.repositoryName ?? props.workspace?.repositoryRelativePath ?? '—'}</dd>
              </div>
              <div>
                <dt>{zh ? '范围' : 'Range'}</dt>
                <dd>{zh ? '来源基线至当前现场的全部变化' : 'All changes from the source baseline to the current workspace'}</dd>
              </div>
              <div>
                <dt>{zh ? '权限' : 'Permission'}</dt>
                <dd>{permissionModeLabel(permissionMode, zh)}</dd>
              </div>
            </dl>
            <p>{zh ? '固定要求：只分析并报告，不修改文件，不提交、推送或合入代码。' : 'Fixed rule: analyze and report only. Do not modify files, commit, push, or merge.'}</p>
          </section>

          <section className="session-code-review-config" aria-label={zh ? '模型配置' : 'Model configuration'}>
            <label>
              <span>{zh ? '模型' : 'Model'}</span>
              <ZeusSelect
                size="regular"
                ariaLabel={zh ? '代码审查模型' : 'Code review model'}
                value={modelPresentation.selectedId || form?.model || ''}
                options={modelPresentation.options}
                triggerLabel={modelPresentation.triggerLabel}
                onChange={changeModel}
                disabled={!form || modelPresentation.options.length === 0 || busy}
                searchPlaceholder={zh ? '搜索供应商或模型' : 'Search providers or models'}
                emptyLabel={zh ? '没有匹配模型' : 'No matching models'}
              />
            </label>
            <label>
              <span>Skill</span>
              <SkillSelector
                client={skillClient}
                projectId={props.conversation.projectId}
                value={form?.skillId ?? ''}
                onChange={(skillId) => setForm((current) => (current ? { ...current, skillId } : current))}
                language={props.language}
                disabled={!form || busy}
                ariaLabel={zh ? '代码审查使用的 Skill' : 'Skill for code review'}
              />
            </label>
            {selectedModel && selectedModel.supportedReasoningEfforts.length > 0 ? (
              <label>
                <span>{zh ? '推理强度' : 'Reasoning effort'}</span>
                <ZeusSelect
                  size="regular"
                  ariaLabel={zh ? '代码审查推理强度' : 'Code review reasoning effort'}
                  value={form?.effort ?? ''}
                  options={selectedModel.supportedReasoningEfforts.map((effort) => ({ value: effort, label: effort }))}
                  onChange={(effort) => setForm((current) => (current ? { ...current, effort } : current))}
                  disabled={!form || busy}
                  searchable={false}
                />
              </label>
            ) : null}
            <label>
              <span>{zh ? '速度' : 'Speed'}</span>
              <ZeusSelect
                size="regular"
                ariaLabel={zh ? '代码审查速度' : 'Code review speed'}
                value={serviceTierSelectionValue(form?.serviceTierSelection ?? { type: 'standard' })}
                options={serviceTierOptions(selectedModel, props.language)}
                onChange={(value) =>
                  setForm((current) =>
                    current
                      ? {
                          ...current,
                          serviceTierSelection: serviceTierSelectionFromValue(value),
                          serviceTierDowngraded: false,
                        }
                      : current,
                  )
                }
                disabled={!form || !selectedModel || busy}
                searchable={false}
              />
            </label>
          </section>

          {status === 'loading' ? <p className="session-code-review-message">{zh ? '正在读取当前模型配置…' : 'Loading the current model configuration…'}</p> : null}
          {status === 'preparing' ? (
            <p className="session-code-review-message" role="status">
              {zh ? '正在准备，完成后自动开始。' : 'Preparing. This will start automatically when ready.'}
            </p>
          ) : null}
        </div>

        <footer>
          <small>
            {status === 'preparing'
              ? zh
                ? '准备期间不会创建半成品会话。'
                : 'No partial conversation is created while preparing.'
              : zh
                ? '确认后会切换到新建的审查会话。'
                : 'After confirmation, Zeus switches to the new review conversation.'}
          </small>
          <span>
            <Button type="button" size="compact" onClick={close} disabled={busy}>
              {zh ? '取消' : 'Cancel'}
            </Button>
            <Button type="submit" variant="primary" size="compact" busy={busy} disabled={!form || !selectedModel || status === 'loading' || status === 'preparing'}>
              {busy ? (zh ? '正在启动…' : 'Starting…') : zh ? '确认并开始审查' : 'Confirm and start review'}
            </Button>
          </span>
        </footer>
      </form>
    </ModalPortal>
  );
}

function browserStorage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

function resolveInitialForm(capabilities: CodexConversationCapabilities, inheritedModel: string, inheritedEffort: string, inheritedServiceTier: string | null | undefined, skillId: string): SessionCodeReviewForm {
  const selectedModel = findModel(capabilities, inheritedModel) ?? findModel(capabilities, capabilities.preferredModel) ?? capabilities.models.find((model) => model.available !== false);
  if (!selectedModel) throw new Error('No review model is available.');
  const effort = selectedModel.supportedReasoningEfforts.includes(inheritedEffort) ? inheritedEffort : (selectedModel.defaultReasoningEffort ?? selectedModel.supportedReasoningEfforts[0] ?? '');
  const inheritedSelection: NativeServiceTierSelection = inheritedServiceTier ? { type: 'catalog', id: inheritedServiceTier } : { type: 'standard' };
  const normalizedTier = normalizeServiceTierSelection(inheritedSelection, selectedModel);
  return {
    model: selectedModel.id,
    effort,
    serviceTierSelection: normalizedTier.selection,
    serviceTierDowngraded: normalizedTier.downgraded,
    skillId,
  };
}

function findModel(capabilities: CodexConversationCapabilities | null, model: string | null | undefined): CodexTaskPushModelCapability | undefined {
  return (
    resolveModelCapability(
      capabilities?.models.filter((candidate) => candidate.available !== false),
      model,
    ) ?? undefined
  );
}

function permissionModeLabel(permissionMode: NativePermissionMode, zh: boolean): string {
  if (permissionMode === 'full-access') return zh ? '完全访问' : 'Full access';
  if (permissionMode === 'auto') return zh ? '自动' : 'Auto';
  return zh ? '只读（固定）' : 'Read only (fixed)';
}
