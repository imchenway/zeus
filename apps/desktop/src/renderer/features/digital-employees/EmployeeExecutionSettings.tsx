import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { EmployeeWorkSettings } from '@zeus/shared';
import { codexServiceTierLabel } from '../../session/serviceTierSelection.js';
import { ZeusSelect, type ZeusSelectOption } from '../../ZeusSelect.js';
import { modelProviderOption, modelProviderOptionForRef, presentModelOptions } from '../../modelOptionPresentation.js';
import { Button } from '../../ui/Button.js';
import { VisibleApplicationError } from '../../ui/ApplicationErrorDialog.js';
import { PermissionModeControl } from '../../session/PermissionModeControl.js';
import { resolveModelCapability } from '../../session/modelSelection.js';
import type { CodexTaskPushModelCapability } from '../../session/sessionTypes.js';
import { codexCapabilitiesChangedEvent, modelCatalogGeneration } from '../integrations/modelCatalogEvents.js';
import type { SkillCatalog } from '../codex/codexContracts.js';
import { SkillSelector } from '../skills/SkillSelector.js';
import type { NativeConversationAppClient } from '../workspace/workspaceSupport.js';
import type { DigitalEmployeeApiClient } from './digitalEmployeeApiClient.js';
import { errorMessage } from './digitalEmployeeUiSupport.js';

/** 员工默认、分工覆盖共用会话能力目录与权限确认控件。 */
export function EmployeeExecutionSettings(props: {
  /** 当前层只保存显式字段，空数组表示不使用 Skill。 */
  value: EmployeeWorkSettings;
  /** 上层配置用于展示继承的实际模型能力。 */
  inherited?: EmployeeWorkSettings;
  /** 覆盖层允许逐项删除字段，恢复跟随。 */
  overrides?: boolean;
  /** 模型目录使用现有员工查询入口。 */
  client: Pick<DigitalEmployeeApiClient, 'loadDigitalEmployeeCapabilities'> | null;
  /** Skill 目录与会话共用。 */
  skillClient: Pick<NativeConversationAppClient, 'loadSkills'> | null;
  /** 项目 Skill 的可见范围。 */
  projectId?: string;
  /** 页面语言。 */
  language: 'zh-CN' | 'en-US';
  /** 保存时禁止重复提交。 */
  disabled?: boolean;
  /** 返回完整当前层，不把继承值写成覆盖。 */
  onChange(value: EmployeeWorkSettings): void;
}) {
  /** 能力仅用于选择；派发仍由服务端再次校验。 */
  const [models, setModels] = useState<CodexTaskPushModelCapability[]>([]);
  /** 当前会话默认模型，避免按目录顺序猜测。 */
  const [preferredModel, setPreferredModel] = useState<string | null>(null);
  /** 目录失败保留用户选择，禁止静默切换。 */
  const [error, setError] = useState<string | null>(null);
  /** Skill 名称随目录读取，保存仍使用稳定身份。 */
  const [skillNames, setSkillNames] = useState<Record<string, string>>({});
  /** 目录回调保持稳定，避免选择器效果反复触发。 */
  const receiveSkills = useCallback((catalog: SkillCatalog | null) => {
    if (catalog) setSkillNames(Object.fromEntries(catalog.skills.map((skill) => [skill.id, skill.name])));
  }, []);
  /** 当前语言。 */
  const zh = props.language === 'zh-CN';
  useEffect(() => {
    let active = true;
    /** 账号恢复或退出后只更新选项，保留员工已填写的配置。 */
    const refresh = () => {
      const generation = modelCatalogGeneration();
      void props.client
        ?.loadDigitalEmployeeCapabilities()
        .then((snapshot) => {
          if (!active || generation !== modelCatalogGeneration()) return;
          setModels(snapshot.models);
          setPreferredModel(snapshot.preferredModel ?? null);
          setError(null);
        })
        .catch((cause: unknown) => {
          if (active && generation === modelCatalogGeneration()) setError(errorMessage(cause, zh ? 'zh-CN' : 'en'));
        });
    };
    refresh();
    window.addEventListener(codexCapabilitiesChangedEvent, refresh);
    return () => {
      active = false;
      window.removeEventListener(codexCapabilitiesChangedEvent, refresh);
    };
  }, [props.client, zh]);
  /** 缺省字段继承，显式 null 保留模型默认语义。 */
  const effective = { ...props.inherited, ...props.value };
  /** 空选项代表项目默认，表单值由当前层及继承配置决定。 */
  const savedModelRef = effective.modelOverride ?? '';
  /** 未指定模型时，其他执行字段读取首选模型的能力。 */
  const model = resolveModelCapability(models, savedModelRef || preferredModel);
  /** 已解析的历史型号使用目录中的稳定引用展示选中项。 */
  const modelValue = savedModelRef ? (model?.id ?? savedModelRef) : '';
  /** 模型分组、排序、搜索与置顶跟随任务推送。 */
  const modelPresentation = useMemo(() => presentModelOptions(models, modelValue, props.language, { preserveMissingSelection: true }), [models, modelValue, props.language]);
  /** 已停用或移除的当前模型仍可识别。 */
  const unavailableModel = modelValue !== '' && (!model || model.available === false);
  /** 表单补充项目默认入口和当前失效选项。 */
  const modelFallbackOptions: ZeusSelectOption<string>[] = [{ value: '', label: zh ? '项目默认模型' : 'Project default' }];
  if (unavailableModel) {
    modelFallbackOptions.push({
      value: modelValue,
      ...(model ? modelProviderOption(model) : modelProviderOptionForRef(modelValue)),
      label: [model?.displayName?.trim() || model?.model || modelValue, model?.sourceName, zh ? '不可用' : 'Unavailable'].filter(Boolean).join(' · '),
      disabled: true,
    });
  }
  /** 修改一个字段，不丢失其他覆盖。 */
  const patch = (value: Partial<EmployeeWorkSettings>) => props.onChange({ ...props.value, ...value });
  /** 删除当前层字段后由服务端重新解析继承。 */
  const reset = (key: keyof EmployeeWorkSettings) => {
    const next = { ...props.value };
    delete next[key];
    props.onChange(next);
  };
  /** 统一字段标题及恢复跟随入口。 */
  const field = (key: keyof EmployeeWorkSettings, label: string, control: ReactNode) => (
    <div className="employee-execution-field" key={key}>
      <div className="employee-execution-label">
        <span>{label}</span>
        {props.overrides ? (
          props.value[key] === undefined ? (
            <small>{zh ? '跟随默认' : 'Inherited'}</small>
          ) : (
            <Button size="compact" variant="secondary" disabled={props.disabled} onClick={() => reset(key)}>
              {zh ? '恢复跟随' : 'Inherit'}
            </Button>
          )
        ) : null}
      </div>
      {control}
    </div>
  );
  /** 保留已失效选择供用户识别；绝不以首个选项覆盖。 */
  const select = (label: string, value: string, options: ZeusSelectOption<string>[], onChange: (value: string) => void) => (
    <ZeusSelect
      ariaLabel={label}
      size="regular"
      value={value}
      options={options.some((item) => item.value === value) ? options : [...options, { value, label: `${value} · ${zh ? '不可用' : 'Unavailable'}`, disabled: true }]}
      disabled={props.disabled}
      onChange={onChange}
    />
  );
  return (
    <div className="employee-execution-settings">
      {error ? (
        <p role="alert">
          <VisibleApplicationError error={error} language={zh ? 'zh-CN' : 'en'} />
        </p>
      ) : null}
      <div className="digital-employee-form-grid">
        {field(
          'modelOverride',
          zh ? '模型' : 'Model',
          <ZeusSelect
            size="regular"
            ariaLabel={zh ? '模型' : 'Model'}
            value={modelValue}
            options={[...modelFallbackOptions, ...modelPresentation.options]}
            pinning={modelPresentation.pinning}
            triggerLabel={modelValue && !unavailableModel ? modelPresentation.triggerLabel : undefined}
            onChange={(value) => patch({ modelOverride: value || null })}
            disabled={props.disabled}
            searchPlaceholder={zh ? '搜索供应商或模型' : 'Search providers or models'}
            emptyLabel={zh ? '没有匹配模型' : 'No matching models'}
          />,
        )}
        {field(
          'contextCapacityTokens',
          zh ? '上下文容量' : 'Context capacity',
          select(
            '上下文容量',
            String(effective.contextCapacityTokens ?? ''),
            [{ value: '', label: zh ? '模型默认' : 'Model default' }, ...(model?.contextCapacity?.choices ?? []).map((value) => ({ value: String(value), label: `${value / 1000}k` }))],
            (value) => patch({ contextCapacityTokens: value ? Number(value) : null }),
          ),
        )}
        {field(
          'reasoningEffort',
          zh ? '推理级别' : 'Reasoning',
          select('推理级别', effective.reasoningEffort ?? '', [{ value: '', label: zh ? '模型默认' : 'Model default' }, ...(model?.supportedReasoningEfforts ?? []).map((value) => ({ value, label: value }))], (value) =>
            patch({ reasoningEffort: value || null }),
          ),
        )}
        {field(
          'serviceTier',
          zh ? '速度' : 'Speed',
          select('速度', effective.serviceTier ?? '', [{ value: '', label: zh ? '标准' : 'Standard' }, ...(model?.serviceTiers ?? []).map((tier) => ({ value: tier.id, label: codexServiceTierLabel(tier, props.language) }))], (value) =>
            patch({ serviceTier: value || null }),
          ),
        )}
        {field(
          'workMode',
          zh ? '工作模式' : 'Work mode',
          select(
            '工作模式',
            effective.workMode ?? 'default',
            [
              { value: 'default', label: zh ? '默认' : 'Default' },
              { value: 'plan', label: zh ? '计划' : 'Plan' },
            ],
            (value) => patch({ workMode: value as 'default' | 'plan' }),
          ),
        )}
        {field(
          'permissionMode',
          zh ? '权限模式' : 'Permissions',
          <PermissionModeControl
            language={props.language}
            value={effective.permissionMode ?? 'read-only'}
            supportsAutoReview={Boolean(model) && !['unsupported', 'needs_configuration'].includes(model?.features?.autoReview.state ?? '')}
            showLabel
            disabled={props.disabled}
            onChange={(permissionMode) => patch({ permissionMode })}
          />,
        )}
      </div>
      {field(
        'skillIds',
        'Skill',
        <>
          {(effective.skillIds ?? []).length > 0 ? (
            <div className="employee-skill-list">
              {(effective.skillIds ?? []).map((id) => (
                <Button
                  size="compact"
                  variant="secondary"
                  key={id}
                  aria-label={`${zh ? '移除 Skill' : 'Remove skill'} ${skillNames[id] ?? id}`}
                  disabled={props.disabled}
                  onClick={() => patch({ skillIds: (effective.skillIds ?? []).filter((item) => item !== id) })}
                >
                  {skillNames[id] ?? id} ×
                </Button>
              ))}
              <Button size="compact" variant="secondary" disabled={props.disabled} onClick={() => patch({ skillIds: [] })}>
                {zh ? '清空选择' : 'Clear selection'}
              </Button>
            </div>
          ) : null}
          <SkillSelector
            client={props.skillClient}
            projectId={props.projectId}
            value=""
            adding
            language={props.language}
            disabled={props.disabled}
            onCatalogChange={receiveSkills}
            onChange={(id) => {
              if (id) patch({ skillIds: [...new Set([...(effective.skillIds ?? []), id])] });
            }}
          />
        </>,
      )}
    </div>
  );
}
