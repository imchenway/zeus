import { useEffect, useMemo, useState } from 'react';
import { AtIcon as At } from '@phosphor-icons/react/dist/csr/At';
import type { SkillCatalog } from '../features/codex/codexContracts.js';
import { ZeusSelect, type ZeusSelectOption } from '../ZeusSelect.js';

export interface ExtensionMentionSelection {
  token: string;
  reference?: { kind: 'plugin' | 'skill'; id: string };
}

export function ExtensionMentionSelector(props: {
  projectId?: string;
  language: 'zh-CN' | 'en-US';
  disabled?: boolean;
  loadCatalog?: (projectId?: string, forceReload?: boolean) => Promise<SkillCatalog>;
  onInsert(selection: ExtensionMentionSelection): void;
}) {
  const zh = props.language === 'zh-CN';
  const [catalog, setCatalog] = useState<SkillCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!props.loadCatalog) return;
    let active = true;
    void props
      .loadCatalog(props.projectId)
      .then((next) => {
        if (active) setCatalog(next);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : zh ? '扩展目录不可用' : 'Extension catalog unavailable');
      });
    return () => {
      active = false;
    };
  }, [props.loadCatalog, props.projectId, zh]);

  const selections = useMemo(() => {
    const values = new Map<string, ExtensionMentionSelection>();
    const items: ZeusSelectOption<string>[] = [];
    for (const plugin of catalog?.plugins ?? []) {
      const value = `plugin:${plugin.id}`;
      const token = `@${plugin.name}`;
      const identity = plugin.id.slice(-6);
      const source = plugin.sourceRef ? `${plugin.sourceKind}:${plugin.sourceRef}` : plugin.sourceKind;
      values.set(value, { token, reference: { kind: 'plugin', id: plugin.id } });
      items.push({
        value,
        label: `${token} · ${plugin.scope} · ${source} · ${identity}`,
        group: 'Plugin',
        searchText: `${plugin.displayName} ${plugin.description} ${plugin.scope} ${plugin.sourceKind} ${plugin.sourceLocator} ${plugin.sourceRef ?? ''} ${plugin.id}`,
      });
    }
    for (const skill of catalog?.skills ?? []) {
      const token = skill.invocation || `@${skill.name}`;
      const value = skill.source === 'plugin' && skill.pluginId ? `plugin-skill:${skill.id}` : `skill:${skill.id}`;
      values.set(value, {
        token,
        ...(skill.source === 'plugin' ? { reference: { kind: 'skill' as const, id: skill.id } } : {}),
      });
      items.push({
        value,
        label: skill.source === 'plugin' && skill.pluginId ? `${token} · ${skill.scope} · ${skill.pluginId.slice(-6)}` : token,
        group: skill.source === 'plugin' ? (zh ? 'Plugin 内 Skill' : 'Plugin skill') : 'Skill',
        searchText: `${skill.name} ${skill.description} ${skill.path} ${skill.pluginId ?? ''}`,
      });
    }
    return { items, values };
  }, [catalog?.plugins, catalog?.skills, zh]);

  if (!props.loadCatalog) return null;
  return (
    <ZeusSelect
      ariaLabel={zh ? '插入 Plugin 或 Skill' : 'Insert a plugin or skill'}
      className="session-extension-mention-selector"
      value=""
      options={selections.items}
      onChange={(value) => {
        const selection = selections.values.get(value);
        if (selection) props.onInsert(selection);
      }}
      triggerLabel={error ? '!' : '@'}
      triggerIcon={<At aria-hidden="true" weight="bold" />}
      disabled={props.disabled || Boolean(error) || !catalog}
      searchable
      searchPlaceholder={zh ? '搜索 Plugin 或 Skill' : 'Search plugins or skills'}
      emptyLabel={zh ? '没有可用的扩展' : 'No extensions available'}
      size="compact"
      hideSelectedLabel
    />
  );
}
