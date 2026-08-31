import { useEffect, useMemo, useState } from 'react';
import { ZeusSelect, type ZeusSelectOption } from '../../ZeusSelect.js';
import type { SkillCatalog } from '../codex/codexContracts.js';
import type { NativeConversationAppClient } from '../workspace/workspaceSupport.js';

export const skillCatalogChangedEvent = 'zeus:skill-catalog-changed';

export function SkillSelector(props: {
  client: Pick<NativeConversationAppClient, 'loadSkills'> | null;
  projectId?: string;
  value: string;
  onChange(value: string): void;
  language: 'zh-CN' | 'en-US';
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
  catalog?: SkillCatalog | null;
  allowedIds?: readonly string[];
  onCatalogChange?(catalog: SkillCatalog | null): void;
}) {
  const [catalog, setCatalog] = useState<SkillCatalog | null>(props.catalog ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const zh = props.language === 'zh-CN';
  const catalogProvided = props.catalog !== undefined;

  useEffect(() => {
    if (catalogProvided) setCatalog(props.catalog ?? null);
  }, [catalogProvided, props.catalog]);

  useEffect(() => props.onCatalogChange?.(catalog), [catalog, props.onCatalogChange]);

  useEffect(() => {
    if (catalogProvided || !props.client) return;
    let active = true;
    const load = async (forceReload = false) => {
      setLoading(true);
      setError(null);
      try {
        const next = await props.client!.loadSkills(props.projectId, forceReload);
        if (!active) return;
        setCatalog(next);
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : zh ? '无法读取 Skill' : 'Unable to load skills');
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    const refresh = () => void load(true);
    window.addEventListener(skillCatalogChangedEvent, refresh);
    return () => {
      active = false;
      window.removeEventListener(skillCatalogChangedEvent, refresh);
    };
  }, [catalogProvided, props.client, props.projectId, zh]);

  const options = useMemo<ZeusSelectOption<string>[]>(() => {
    const items: ZeusSelectOption<string>[] = [
      {
        value: '',
        label: zh ? '不使用 Skill' : 'No skill',
        group: zh ? '默认' : 'Default',
      },
      ...(catalog?.skills ?? [])
        .filter((skill) => !props.allowedIds || props.allowedIds.includes(skill.id))
        .map((skill) => ({
          value: skill.id,
          label: skill.name,
          group: scopeLabel(skill.scope, zh),
          searchText: `${skill.invocation} ${skill.description} ${skill.path}`,
        })),
    ];
    if (props.value && !items.some((item) => item.value === props.value)) {
      items.push({ value: props.value, label: zh ? '原 Skill 已不可用' : 'Previous skill unavailable', group: zh ? '需要重选' : 'Reselect', disabled: true, searchText: props.value });
    }
    return items;
  }, [catalog?.skills, props.allowedIds, props.value, zh]);

  const selected = options.find((option) => option.value === props.value);
  const fallbackLabel = loading ? (zh ? '正在读取 Skill…' : 'Loading skills…') : error ? (zh ? 'Skill 不可用' : 'Skills unavailable') : zh ? '不使用 Skill' : 'No skill';
  return (
    <span className={`codex-skill-selector${props.className ? ` ${props.className}` : ''}`} title={error ?? selected?.label}>
      <ZeusSelect
        ariaLabel={props.ariaLabel ?? (zh ? '选择 Skill' : 'Choose skill')}
        value={props.value}
        options={options}
        onChange={props.onChange}
        triggerLabel={selected?.label ?? fallbackLabel}
        disabled={props.disabled || loading || !props.client || Boolean(error)}
        searchPlaceholder={zh ? '搜索名称、说明或路径' : 'Search name, description, or path'}
        emptyLabel={zh ? '没有匹配的 Skill' : 'No matching skills'}
        searchable
        size="regular"
      />
      {error ? <small className="codex-skill-selector-error">{error}</small> : null}
    </span>
  );
}

export function SkillMultiSelector(props: {
  client: Pick<NativeConversationAppClient, 'loadSkills'> | null;
  projectId?: string;
  value: string[];
  onChange(value: string[]): void;
  language: 'zh-CN' | 'en-US';
  disabled?: boolean;
  allowedIds?: readonly string[];
  ariaLabel?: string;
}) {
  const [candidate, setCandidate] = useState('');
  const [catalog, setCatalog] = useState<SkillCatalog | null>(null);
  const zh = props.language === 'zh-CN';
  return (
    <span className="codex-skill-multi-selector">
      <SkillSelector
        client={props.client}
        projectId={props.projectId}
        value={candidate}
        onChange={(skillId) => {
          setCandidate('');
          if (skillId && !props.value.includes(skillId)) props.onChange([...props.value, skillId]);
        }}
        language={props.language}
        disabled={props.disabled}
        allowedIds={props.allowedIds}
        ariaLabel={props.ariaLabel ?? (zh ? '添加 Skill' : 'Add skill')}
        onCatalogChange={setCatalog}
      />
      <span className="digital-employee-skill-policy-list">
        {props.value.map((skillId) => {
          const skill = catalog?.skills.find((candidate) => candidate.id === skillId);
          return (
            <span key={skillId} title={skill ? skill.invocation : skillId}>
              <code>{skill?.name ?? (zh ? '原 Skill 已不可用' : 'Previous skill unavailable')}</code>
              <button type="button" disabled={props.disabled} onClick={() => props.onChange(props.value.filter((id) => id !== skillId))}>
                {zh ? '移除' : 'Remove'}
              </button>
            </span>
          );
        })}
        {props.value.length === 0 ? <small>{zh ? '未选择 Skill。' : 'No skills selected.'}</small> : null}
      </span>
    </span>
  );
}

function scopeLabel(scope: SkillCatalog['skills'][number]['scope'], zh: boolean): string {
  if (scope === 'plugin-personal') return zh ? 'Plugin · 个人' : 'Plugin · Personal';
  if (scope === 'plugin-project') return zh ? 'Plugin · 项目' : 'Plugin · Project';
  if (scope === 'user') return zh ? '个人安装' : 'User';
  if (scope === 'repo') return zh ? '当前项目' : 'Repository';
  if (scope === 'system') return zh ? '系统内置' : 'System';
  return zh ? '管理员' : 'Admin';
}
