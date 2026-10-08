import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { EmployeeWorkSettings } from '@zeus/shared';
import { ZeusSelect, type ZeusSelectOption } from '../../ZeusSelect.js';
import { PermissionModeControl } from '../../session/PermissionModeControl.js';
import type { CodexTaskPushModelCapability } from '../../session/sessionTypes.js';
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
    void props.client
      ?.loadDigitalEmployeeCapabilities()
      .then((snapshot) => {
        if (active) {
          setModels(snapshot.models);
          setPreferredModel(snapshot.preferredModel ?? null);
          setError(null);
        }
      })
      .catch((cause: unknown) => {
        if (active) setError(errorMessage(cause, zh ? 'zh-CN' : 'en'));
      });
    return () => {
      active = false;
    };
  }, [props.client, zh]);
  /** 缺省字段继承，显式 null 保留模型默认语义。 */
  const effective = { ...props.inherited, ...props.value };
  /** 使用当前选定模型，空值只展示目录默认模型的选项。 */
  const model = models.find((item) => item.id === (effective.modelOverride || preferredModel));
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
            <button type="button" disabled={props.disabled} onClick={() => reset(key)}>
              {zh ? '恢复跟随' : 'Inherit'}
            </button>
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
      {error ? <p role="alert">{error}</p> : null}
      <div className="digital-employee-form-grid">
        {field(
          'modelOverride',
          zh ? '模型' : 'Model',
          select(
            '模型',
            effective.modelOverride ?? '',
            [
              { value: '', label: zh ? '项目默认模型' : 'Project default' },
              ...models.map((item) => ({ value: item.id, label: `${item.displayName ?? item.model}${item.sourceName ? ` · ${item.sourceName}` : ''}`, disabled: item.available === false })),
            ],
            (value) => patch({ modelOverride: value || null }),
          ),
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
          select('速度', effective.serviceTier ?? '', [{ value: '', label: zh ? '标准' : 'Standard' }, ...(model?.serviceTiers ?? []).map((tier) => ({ value: tier.id, label: tier.name }))], (value) => patch({ serviceTier: value || null })),
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
            disabled={props.disabled}
            onChange={(permissionMode) => patch({ permissionMode })}
          />,
        )}
      </div>
      {field(
        'skillIds',
        'Skill',
        <>
          <div className="digital-employee-actions">
            {(effective.skillIds ?? []).map((id) => (
              <button type="button" key={id} disabled={props.disabled} onClick={() => patch({ skillIds: (effective.skillIds ?? []).filter((item) => item !== id) })}>
                {skillNames[id] ?? id} ×
              </button>
            ))}
            <button type="button" disabled={props.disabled} onClick={() => patch({ skillIds: [] })}>
              {zh ? '不使用 Skill' : 'No skills'}
            </button>
          </div>
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
