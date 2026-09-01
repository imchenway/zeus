import { useEffect, useMemo } from 'react';
import { presentModelOptions } from '../../modelOptionPresentation.js';
import { resolveModelCapability } from '../../session/modelSelection.js';
import type { CodexTaskPushModelCapability } from '../../session/sessionTypes.js';
import { ZeusSelect } from '../../ZeusSelect.js';
import { SkillMultiSelector } from '../skills/SkillSelector.js';
import type { NativeConversationAppClient } from '../workspace/workspaceSupport.js';
import type { DigitalEmployeeAgentKind, DigitalEmployeePermissionMode, DigitalEmployeeWorkMode } from './digitalEmployeeContracts.js';
import type { DigitalEmployeeLanguage } from './digitalEmployeeUiSupport.js';

export interface AgentExecutionConfigValue {
  agentKind: DigitalEmployeeAgentKind;
  model: string;
  reasoningEffort: string;
  serviceTier: string;
  workMode: DigitalEmployeeWorkMode;
  permissionMode: DigitalEmployeePermissionMode;
  skillIds: string[];
  prompt: string;
}

export function AgentExecutionConfigFields(props: {
  value: AgentExecutionConfigValue;
  onChange(value: Partial<AgentExecutionConfigValue>): void;
  models: readonly CodexTaskPushModelCapability[];
  skillClient: Pick<NativeConversationAppClient, 'loadSkills'> | null;
  language: DigitalEmployeeLanguage;
  projectId?: string;
  readOnly?: boolean;
  allowProjectDefaultModel?: boolean;
  compact?: boolean;
}) {
  const zh = props.language === 'zh-CN';
  const modelPresentation = useMemo(() => presentModelOptions(props.models, props.value.model, props.language, { preserveMissingSelection: true }), [props.language, props.models, props.value.model]);
  const selectedModel = resolveModelCapability(props.models, props.value.model);
  const unavailableSelection = selectedModel?.available === false ? selectedModel : !selectedModel && props.value.model ? { id: props.value.model, model: props.value.model, displayName: props.value.model, sourceName: '' } : null;
  const modelOptions = useMemo(
    () => [
      ...(props.allowProjectDefaultModel ? [{ value: '', label: zh ? '跟随项目默认' : 'Use project default', searchText: zh ? '项目默认 不指定' : 'project default unspecified' }] : []),
      ...modelPresentation.options,
      ...(unavailableSelection
        ? [
            {
              value: unavailableSelection.id,
              label: `${unavailableSelection.displayName ?? unavailableSelection.model} · ${zh ? '当前不可用' : 'Currently unavailable'}`,
              group: unavailableSelection.sourceName || (zh ? '历史配置' : 'Saved configuration'),
              searchText: `${unavailableSelection.sourceName ?? ''} ${unavailableSelection.displayName ?? unavailableSelection.model}`,
              disabled: true,
            },
          ]
        : []),
    ],
    [modelPresentation.options, props.allowProjectDefaultModel, unavailableSelection, zh],
  );

  useEffect(() => {
    if (props.readOnly || props.allowProjectDefaultModel || props.value.model || !modelPresentation.selectedId) return;
    const model = resolveModelCapability(props.models, modelPresentation.selectedId);
    if (model) props.onChange(modelDefaults(model));
  }, [modelPresentation.selectedId, props.allowProjectDefaultModel, props.models, props.onChange, props.readOnly, props.value.model]);

  const reasoningValues = selectedModel?.supportedReasoningEfforts ?? [];
  const serviceValues = (selectedModel?.serviceTiers ?? []).map((tier) => ({ value: tier.id, label: tier.name || tier.id }));
  const permissionOptions = (['read-only', 'auto', 'full-access'] as const).map((permissionMode) => ({
    value: permissionMode,
    label: permissionMode === 'read-only' ? (zh ? '只读' : 'Read-only') : permissionMode === 'auto' ? (zh ? '自动' : 'Auto') : zh ? '完全访问' : 'Full access',
  }));

  return (
    <div className={`digital-employee-agent-config${props.compact ? ' is-compact' : ''}`}>
      <div className="digital-employee-form-grid">
        <label>
          <span>{zh ? '模型' : 'Model'}</span>
          <ZeusSelect
            size="regular"
            ariaLabel={zh ? '选择供应商和模型' : 'Choose provider and model'}
            value={selectedModel?.id ?? props.value.model}
            onChange={(identity) => {
              if (!identity) {
                props.onChange({ model: '', reasoningEffort: '', serviceTier: '' });
                return;
              }
              const model = resolveModelCapability(props.models, identity);
              if (model) props.onChange(modelDefaults(model));
            }}
            options={modelOptions}
            triggerLabel={props.value.model ? (unavailableSelection ? (zh ? '当前模型不可用' : 'Current model unavailable') : modelPresentation.triggerLabel) : zh ? '跟随项目默认' : 'Use project default'}
            searchPlaceholder={zh ? '搜索供应商或模型' : 'Search providers or models'}
            emptyLabel={zh ? '没有匹配模型' : 'No matching models'}
            disabled={props.readOnly || props.models.length === 0}
          />
        </label>
        <label>
          <span>{zh ? '推理级别' : 'Reasoning effort'}</span>
          <ZeusSelect
            size="regular"
            ariaLabel={zh ? '选择推理级别' : 'Choose reasoning effort'}
            value={props.value.reasoningEffort}
            onChange={(reasoningEffort) => props.onChange({ reasoningEffort })}
            options={capabilityOptions(props.value.reasoningEffort, reasoningValues, zh ? '跟随模型默认' : 'Use model default', zh ? '当前值不可用' : 'Current value unavailable')}
            disabled={props.readOnly || !selectedModel}
            searchable={false}
          />
        </label>
        <label>
          <span>{zh ? '服务速率' : 'Service tier'}</span>
          <ZeusSelect
            size="regular"
            ariaLabel={zh ? '选择服务速率' : 'Choose service tier'}
            value={props.value.serviceTier}
            onChange={(serviceTier) => props.onChange({ serviceTier })}
            options={capabilityOptions(props.value.serviceTier, serviceValues, zh ? '跟随模型默认' : 'Use model default', zh ? '当前值不可用' : 'Current value unavailable')}
            disabled={props.readOnly || !selectedModel}
            searchable={false}
          />
        </label>
        <label>
          <span>{zh ? '工作模式' : 'Work mode'}</span>
          <ZeusSelect
            size="regular"
            ariaLabel={zh ? '选择工作模式' : 'Choose work mode'}
            value={props.value.workMode}
            onChange={(workMode) => props.onChange({ workMode })}
            options={[
              { value: 'default', label: zh ? '默认' : 'Default' },
              { value: 'plan', label: zh ? '规划' : 'Plan' },
            ]}
            disabled={props.readOnly}
            searchable={false}
          />
        </label>
        <label>
          <span>{zh ? '权限模式' : 'Permission mode'}</span>
          <ZeusSelect
            size="regular"
            ariaLabel={zh ? '选择权限模式' : 'Choose permission mode'}
            value={props.value.permissionMode}
            onChange={(permissionMode) => props.onChange({ permissionMode })}
            options={permissionOptions}
            disabled={props.readOnly}
            searchable={false}
          />
        </label>
      </div>
      <label>
        <span>Skills</span>
        <SkillMultiSelector
          client={props.skillClient}
          projectId={props.projectId}
          value={props.value.skillIds}
          onChange={(skillIds) => props.onChange({ skillIds })}
          language={props.language}
          disabled={props.readOnly}
          ariaLabel={zh ? '添加允许使用的 Skill' : 'Add an allowed skill'}
        />
        <small>{zh ? '可搜索并选择多个 Skill；Skill 不会扩大工具或权限范围。' : 'Search and select multiple skills; skills never expand tool or permission boundaries.'}</small>
      </label>
      <label>
        <span>{zh ? '员工提示词' : 'Employee prompt'}</span>
        <textarea rows={props.compact ? 4 : 7} value={props.value.prompt} onChange={(event) => props.onChange({ prompt: event.currentTarget.value })} disabled={props.readOnly} maxLength={20000} />
      </label>
    </div>
  );
}

function modelDefaults(model: CodexTaskPushModelCapability): Partial<AgentExecutionConfigValue> {
  return {
    agentKind: model.agentKind ?? 'codex',
    model: model.id,
    reasoningEffort: model.defaultReasoningEffort ?? model.supportedReasoningEfforts[0] ?? '',
    serviceTier: model.defaultServiceTier ?? '',
  };
}

function capabilityOptions(currentValue: string, values: readonly string[] | ReadonlyArray<{ value: string; label: string }>, defaultLabel: string, unavailableLabel: string): Array<{ value: string; label: string; disabled?: boolean }> {
  const normalized = values.map((value) => (typeof value === 'string' ? { value, label: value } : value));
  const options: Array<{ value: string; label: string; disabled?: boolean }> = [{ value: '', label: defaultLabel }, ...normalized];
  if (currentValue && !normalized.some((value) => value.value === currentValue)) options.push({ value: currentValue, label: `${currentValue} · ${unavailableLabel}`, disabled: true });
  return options;
}
