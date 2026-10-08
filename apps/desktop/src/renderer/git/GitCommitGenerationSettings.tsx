import { useEffect, useState } from 'react';
import { GearSixIcon } from '@phosphor-icons/react/dist/csr/GearSix';
import type { GitCommitModelOption } from '../features/git/gitApiClient.js';
import { ZeusSelect } from '../ZeusSelect.js';
import { Button } from '../ui/Button.js';
import { FormDialog } from '../ui/FormDialog.js';
import { formatVisibleApplicationError } from '../ui/ApplicationErrorDialog.js';
import { serviceTierOptions, serviceTierSelectionValue } from '../session/serviceTierSelection.js';
import { loadGitCommitModelOptions, readGitCommitGenerationSettings, saveGitCommitGenerationSettings, type GitCommitGenerationSettings, type GitCommitModelsClient, type GitCommitSettingsScope } from './gitCommitModels.js';

/** 两种交付入口共用提交说明设置，只有点击后才读取模型目录。 */
export function GitCommitGenerationSettingsButton(props: { client: GitCommitModelsClient | null; projectId: string; zh: boolean; disabled: boolean }) {
  /** 弹窗打开时才订阅模型读取。 */
  const [open, setOpen] = useState(false);
  /** 可选档位完全来自当前模型能力。 */
  const [models, setModels] = useState<GitCommitModelOption[]>([]);
  /** 表单草稿在保存前不改变下一次生成。 */
  const [settings, setSettings] = useState<GitCommitGenerationSettings | null>(null);
  /** 保存范围独立于草稿，切换范围不丢弃已编辑的模型与档位。 */
  const [scope, setScope] = useState<GitCommitSettingsScope>('project');
  /** 加载或保存失败保留弹窗并显示原因。 */
  const [error, setError] = useState('');
  /** 单个来源不可用时仍保留其他来源的模型。 */
  const [warning, setWarning] = useState('');
  /** 读取目录期间阻止保存未完成的表单。 */
  const [loading, setLoading] = useState(false);
  /** 推理和速率控件跟随同一模型身份。 */
  const selected = models.find((model) => model.id === settings?.modelRef);

  useEffect(() => {
    if (!open || !props.client) return;
    /** 关闭弹窗或切换项目后，旧读取不能覆盖新的设置。 */
    const controller = new AbortController();
    setLoading(true);
    setSettings(null);
    setModels([]);
    setError('');
    setWarning('');
    void loadGitCommitModelOptions(props.client, props.projectId, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setModels(result.items);
        setSettings(result.modelRef ? result.settings : null);
        setScope(result.settingsScope);
        setWarning(result.warning);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(formatVisibleApplicationError(reason, props.zh ? 'zh-CN' : 'en'));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [open, props.client, props.projectId, props.zh]);

  return (
    <>
      <Button
        size="compact"
        className="task-git-generation-settings-button"
        aria-label={props.zh ? 'AI 生成设置' : 'AI generation settings'}
        title={props.zh ? 'AI 生成设置' : 'AI generation settings'}
        disabled={props.disabled || !props.client}
        onClick={() => setOpen(true)}
      >
        <GearSixIcon size={16} aria-hidden="true" />
      </Button>
      {open ? (
        <FormDialog
          title={props.zh ? 'AI 生成设置' : 'AI generation settings'}
          zh={props.zh}
          busy={false}
          submitLabel={props.zh ? '保存' : 'Save'}
          submitDisabled={loading || !selected || !settings}
          onClose={() => setOpen(false)}
          onSubmit={(event) => {
            event.preventDefault();
            if (!settings || !selected || loading) return;
            if (!saveGitCommitGenerationSettings(props.projectId, settings, scope)) {
              setWarning(props.zh ? '设置已用于本次运行，但无法保存到本机。' : 'Settings apply to this run but could not be saved locally.');
              return;
            }
            setOpen(false);
          }}
        >
          <label>
            <span>{props.zh ? '保存范围' : 'Save scope'}</span>
            <ZeusSelect
              size="compact"
              ariaLabel={props.zh ? 'AI 生成设置保存范围' : 'AI generation settings scope'}
              value={scope}
              options={[
                { value: 'project', label: props.zh ? '当前项目' : 'Current project' },
                { value: 'global', label: props.zh ? '全局' : 'Global' },
              ]}
              onChange={setScope}
              disabled={loading}
              searchable={false}
            />
            <small>
              {scope === 'project'
                ? props.zh
                  ? '仅对当前项目生效。'
                  : 'Applies only to the current project.'
                : props.zh
                  ? '当前项目改用全局设置；其他项目的独立设置优先。'
                  : 'The current project will use global settings. Other project overrides take priority.'}
            </small>
          </label>
          <label>
            <span>{props.zh ? '模型' : 'Model'}</span>
            <ZeusSelect
              size="compact"
              ariaLabel={props.zh ? '提交说明模型' : 'Commit message model'}
              value={settings?.modelRef ?? ''}
              options={models.map((model) => ({ value: model.id, label: model.label }))}
              disabled={loading || !models.length}
              onChange={(id) => {
                /** 切换模型时恢复该模型自己的推理与速率档位。 */
                const model = models.find((item) => item.id === id);
                if (model) setSettings(readGitCommitGenerationSettings(props.projectId, model, scope));
              }}
              searchPlaceholder={props.zh ? '搜索模型' : 'Search models'}
              emptyLabel={props.zh ? '没有可用模型' : 'No available models'}
            />
          </label>
          <label>
            <span>{props.zh ? '推理深度' : 'Reasoning effort'}</span>
            <ZeusSelect
              size="compact"
              ariaLabel={props.zh ? '提交说明推理深度' : 'Commit message reasoning effort'}
              value={settings?.effort ?? ''}
              options={selected?.supportedReasoningEfforts.length ? selected.supportedReasoningEfforts.map((effort) => ({ value: effort, label: effort })) : [{ value: '', label: props.zh ? '模型未提供可选档位' : 'No selectable effort' }]}
              disabled={loading || !selected?.supportedReasoningEfforts.length}
              searchable={false}
              onChange={(effort) => setSettings((current) => (current ? { ...current, effort } : current))}
            />
          </label>
          <label>
            <span>{props.zh ? '速率' : 'Speed'}</span>
            <ZeusSelect
              size="compact"
              ariaLabel={props.zh ? '提交说明速率' : 'Commit message speed'}
              value={serviceTierSelectionValue(settings?.serviceTier ? { type: 'catalog', id: settings.serviceTier } : { type: 'standard' })}
              options={serviceTierOptions(selected, props.zh ? 'zh-CN' : 'en-US')}
              disabled={loading || !selected}
              searchable={false}
              onChange={(value) => setSettings((current) => (current ? { ...current, serviceTier: value === 'priority' ? 'priority' : null } : current))}
            />
          </label>
          {loading ? <small role="status">{props.zh ? '正在读取模型…' : 'Loading models…'}</small> : null}
          {error || warning || (!loading && !models.length) ? (
            <small role="status">{error || warning || (props.zh ? '暂无可用模型，请在设置中配置模型连接。' : 'No models available. Configure a model connection in Settings.')}</small>
          ) : null}
        </FormDialog>
      ) : null}
    </>
  );
}
