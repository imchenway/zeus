import { formatVisibleApplicationError } from '../../ui/ApplicationErrorDialog.js';
import { useEffect, useMemo, useState } from 'react';
import { ArrowClockwiseIcon } from '@phosphor-icons/react/dist/csr/ArrowClockwise';
import { ZeusSelect, type ZeusSelectOption } from '../../ZeusSelect.js';
import type { SkillCatalog } from '../codex/codexContracts.js';
import type { NativeConversationAppClient } from '../workspace/workspaceSupport.js';

export const skillCatalogChangedEvent = 'zeus:skill-catalog-changed';

export function SkillSelector(props: {
  client: Pick<NativeConversationAppClient, 'loadSkills'> | null;
  projectId?: string;
  value: string;
  /** 多选追加入口不表示当前已选状态，也不提供无效的空选项。 */
  adding?: boolean;
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
  /** 重试只刷新当前选择器，不影响其他表单或已经选择的 Skill。 */
  const [reloadRevision, setReloadRevision] = useState(0);
  const zh = props.language === 'zh-CN';
  const catalogProvided = props.catalog !== undefined;

  useEffect(() => {
    if (catalogProvided) setCatalog(props.catalog ?? null);
  }, [catalogProvided, props.catalog]);

  /** 切换项目时清空旧目录，重试同一项目时保留已加载的可选项。 */
  useEffect(() => {
    if (!catalogProvided) {
      setCatalog(null);
      setError(null);
    }
  }, [catalogProvided, props.projectId]);

  useEffect(() => props.onCatalogChange?.(catalog), [catalog, props.onCatalogChange]);

  useEffect(() => {
    if (catalogProvided || !props.client) return;
    let active = true;
    const load = async (forceReload = false) => {
      setLoading(true);
      try {
        const next = await props.client!.loadSkills(props.projectId, forceReload);
        if (!active) return;
        setCatalog(next);
        setError(null);
      } catch (reason) {
        // 可选目录读取失败仅在选择器显示，不打断对话或任务推送。
        if (active) setError(formatVisibleApplicationError(reason, zh ? 'zh-CN' : 'en'));
      } finally {
        if (active) setLoading(false);
      }
    };
    void load(reloadRevision > 0);
    const refresh = () => void load(true);
    window.addEventListener(skillCatalogChangedEvent, refresh);
    return () => {
      active = false;
      window.removeEventListener(skillCatalogChangedEvent, refresh);
    };
  }, [catalogProvided, props.client, props.projectId, reloadRevision, zh]);

  const options = useMemo<ZeusSelectOption<string>[]>(() => {
    const items: ZeusSelectOption<string>[] = [
      ...(props.adding ? [] : [{ value: '', label: zh ? '不使用 Skill' : 'No skill', group: zh ? '默认' : 'Default' }]),
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
      items.push({
        value: props.value,
        label: !catalog ? (zh ? '已选 Skill（待确认）' : 'Selected skill (unverified)') : zh ? '原 Skill 已不可用' : 'Previous skill unavailable',
        group: zh ? '需要重选' : 'Reselect',
        disabled: true,
        searchText: props.value,
      });
    }
    return items;
  }, [catalog, props.adding, props.allowedIds, props.value, zh]);

  const selected = options.find((option) => option.value === props.value);
  const fallbackLabel = loading ? (zh ? '正在读取 Skill…' : 'Loading skills…') : props.adding ? (zh ? '添加 Skill' : 'Add skill') : zh ? '不使用 Skill' : 'No skill';
  return (
    <span className={`codex-skill-selector${props.className ? ` ${props.className}` : ''}`} title={selected?.label}>
      <ZeusSelect
        ariaLabel={props.ariaLabel ?? (zh ? '选择 Skill' : 'Choose skill')}
        value={props.value}
        options={options}
        onChange={props.onChange}
        triggerLabel={selected?.label ?? fallbackLabel}
        disabled={props.disabled}
        searchPlaceholder={zh ? '搜索名称、说明或路径' : 'Search name, description, or path'}
        emptyLabel={zh ? '没有匹配的 Skill' : 'No matching skills'}
        searchable
        size="regular"
      />
      {/* 目录失败不接管选择入口；只有独立的重试按钮等待刷新完成。 */}
      {error ? (
        <button
          type="button"
          className="zeus-select-trigger codex-skill-retry"
          title={error}
          aria-label={loading ? (zh ? '正在重新加载 Skill' : 'Reloading skills') : `${zh ? 'Skill 目录加载失败，重试。' : 'Skills failed to load. Retry.'} ${error}`}
          disabled={props.disabled || loading || !props.client}
          onClick={() => setReloadRevision((revision) => revision + 1)}
        >
          <ArrowClockwiseIcon size={14} aria-hidden="true" />
          {loading ? (zh ? '重试中' : 'Retrying') : zh ? '重试' : 'Retry'}
        </button>
      ) : null}
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
        adding
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
