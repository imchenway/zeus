import { type ClipboardEventHandler, type CompositionEventHandler, type FocusEventHandler, type KeyboardEvent, type RefObject, type UIEventHandler, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { SkillCatalog } from '../features/codex/codexContracts.js';
import type { DigitalEmployeeRecord } from '../features/digital-employees/digitalEmployeeContracts.js';
import type { PluginSkillReference } from './sessionTypes.js';

type StructuredTokenKind = 'expert' | 'skill' | 'plugin' | 'plugin-skill' | 'computer';

interface StructuredToken {
  id: string;
  kind: StructuredTokenKind;
  start: number;
  end: number;
  label: string;
  stableId: string;
}

interface TriggerRange {
  kind: '@' | '/';
  start: number;
  end: number;
  query: string;
}

interface MenuOption {
  id: string;
  group: string;
  label: string;
  detail: string;
  disabled?: boolean;
  disabledReason?: string;
  token?: Omit<StructuredToken, 'id' | 'start' | 'end'>;
  action?: 'plan' | 'goal' | 'computer-settings';
}

export interface StructuredComposerSelection {
  displayText: string;
  promptText: string;
  expertMentions: Array<{ employeeId: string }>;
  skillReferences: Array<{ id: string }>;
  pluginReferences: PluginSkillReference[];
  computerUseRequested: boolean;
}

export interface StructuredComposerInputProps {
  value: string;
  onValueChange(value: string): void;
  onSelectionChange(selection: StructuredComposerSelection): void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  projectId?: string;
  language: 'zh-CN' | 'en-US';
  disabled?: boolean;
  autoFocus?: boolean;
  ariaLabel: string;
  placeholder: string;
  ariaKeyShortcuts?: string;
  loadCatalog?: (projectId?: string, forceReload?: boolean) => Promise<SkillCatalog>;
  loadEmployees?: (projectId: string) => Promise<DigitalEmployeeRecord[]>;
  goalAvailable?: boolean;
  goalActive?: boolean;
  onPlanMode(): void;
  onGoalMode(): void;
  onOpenComputerSettings?(): void;
  onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void;
  onPaste?: ClipboardEventHandler<HTMLTextAreaElement>;
  onCompositionStart?: CompositionEventHandler<HTMLTextAreaElement>;
  onCompositionEnd?: CompositionEventHandler<HTMLTextAreaElement>;
  onBlur?: FocusEventHandler<HTMLTextAreaElement>;
  onScroll?: UIEventHandler<HTMLTextAreaElement>;
}

export function StructuredComposerInput(props: StructuredComposerInputProps) {
  const zh = props.language === 'zh-CN';
  const listboxId = useId();
  const [tokens, setTokens] = useState<StructuredToken[]>([]);
  const [trigger, setTrigger] = useState<TriggerRange | null>(null);
  const [activeOption, setActiveOption] = useState(0);
  const [catalog, setCatalog] = useState<SkillCatalog | null>(null);
  const [employees, setEmployees] = useState<DigitalEmployeeRecord[]>([]);
  const [loadingEmployees, setLoadingEmployees] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [employeeError, setEmployeeError] = useState<string | null>(null);
  const [computerEnabled, setComputerEnabled] = useState(false);
  const [mirrorScrollTop, setMirrorScrollTop] = useState(0);
  const composingRef = useRef(false);

  useEffect(() => {
    let active = true;
    setCatalog(null);
    setCatalogError(null);
    if (props.loadCatalog) {
      void props
        .loadCatalog(props.projectId)
        .then((value) => {
          if (active) setCatalog(value);
        })
        .catch((error: unknown) => {
          if (active) setCatalogError(error instanceof Error ? error.message : zh ? '扩展目录不可用' : 'Extension catalog unavailable');
        });
    }
    return () => {
      active = false;
    };
  }, [props.loadCatalog, props.projectId, zh]);

  useEffect(() => {
    let active = true;
    setEmployees([]);
    setEmployeeError(null);
    if (!props.projectId || !props.loadEmployees) return () => undefined;
    setLoadingEmployees(true);
    void props
      .loadEmployees(props.projectId)
      .then((value) => {
        if (active) setEmployees(value.filter((employee) => employee.enabled && employee.entrypointMigrationState === 'ready' && employee.entrypoint?.kind === 'agent'));
      })
      .catch((error: unknown) => {
        if (active) setEmployeeError(error instanceof Error ? error.message : zh ? '数字员工目录不可用' : 'Digital employee directory unavailable');
      })
      .finally(() => {
        if (active) setLoadingEmployees(false);
      });
    return () => {
      active = false;
    };
  }, [props.loadEmployees, props.projectId, zh]);

  useEffect(() => {
    let active = true;
    if (!window.zeus?.getComputerSettings) return () => undefined;
    void window.zeus
      .getComputerSettings()
      .then((settings) => {
        if (active) setComputerEnabled(settings.enabled);
      })
      .catch(() => {
        if (active) setComputerEnabled(false);
      });
    return () => {
      active = false;
    };
  }, [props.projectId]);

  useEffect(() => {
    setTokens((current) => current.filter((token) => props.value.slice(token.start, token.end) === token.label));
    if (!props.value) setTrigger(null);
  }, [props.value]);

  const selection = useMemo(() => selectionFromTokens(props.value, tokens), [props.value, tokens]);
  useEffect(() => props.onSelectionChange(selection), [props.onSelectionChange, selection]);

  const options = useMemo(() => {
    if (!trigger) return [];
    const query = trigger.query.toLocaleLowerCase();
    const selectedIds = new Set(tokens.map((token) => `${token.kind}:${token.stableId}`));
    const selectedExpertCount = tokens.filter((token) => token.kind === 'expert').length;
    const selectedSkillCount = tokens.filter((token) => token.kind === 'skill').length;
    const values: MenuOption[] = [];
    if (trigger.kind === '@') {
      for (const employee of employees) {
        const haystack = `${employee.name} ${employee.role} ${employee.domain}`.toLocaleLowerCase();
        if (query && !haystack.includes(query)) continue;
        values.push({
          id: `expert:${employee.id}`,
          group: zh ? '数字员工' : 'Digital employees',
          label: `@${employee.name}`,
          detail: [employee.role, employee.domain].filter(Boolean).join(' · '),
          disabled: props.goalActive || selectedIds.has(`expert:${employee.id}`) || selectedExpertCount >= 8,
          disabledReason: props.goalActive ? (zh ? '目标编辑与专家点名互斥' : 'Goal editing cannot include expert mentions') : selectedExpertCount >= 8 ? (zh ? '每轮最多点名 8 名数字员工' : 'Up to 8 digital employees per turn') : undefined,
          token: { kind: 'expert', label: `@${employee.name}`, stableId: employee.id },
        });
      }
      return values;
    }

    const fixed: MenuOption[] = [
      { id: 'mode:plan', group: zh ? '模式' : 'Modes', label: zh ? '计划模式' : 'Plan mode', detail: zh ? '切换本轮协作模式' : 'Switch collaboration mode for this turn', action: 'plan' },
      {
        id: 'mode:goal',
        group: zh ? '模式' : 'Modes',
        label: zh ? '目标模式' : 'Goal mode',
        detail: zh ? '进入目标编辑流程' : 'Open goal editing',
        action: 'goal',
        disabled: !props.goalAvailable || tokens.some((token) => token.kind === 'expert'),
        disabledReason: tokens.some((token) => token.kind === 'expert') ? (zh ? '目标编辑与专家点名互斥' : 'Goal editing cannot include expert mentions') : undefined,
      },
      {
        id: 'computer:request',
        group: 'Computer Use',
        label: 'Computer Use',
        detail: computerEnabled ? (zh ? '仅为本轮启用' : 'Enable for this turn only') : zh ? '需要先在设置中全局启用' : 'Enable globally in Settings first',
        disabled: !computerEnabled || selectedIds.has('computer:computer-use'),
        disabledReason: !computerEnabled ? (zh ? 'Computer Use 尚未启用' : 'Computer Use is disabled') : undefined,
        token: { kind: 'computer', label: '/Computer Use', stableId: 'computer-use' },
      },
    ];
    if (!computerEnabled && props.onOpenComputerSettings) {
      fixed.push({
        id: 'computer:settings',
        group: 'Computer Use',
        label: zh ? '前往 Computer Use 设置' : 'Open Computer Use settings',
        detail: zh ? '在设置中启用并授权' : 'Enable and grant permissions in Settings',
        action: 'computer-settings',
      });
    }
    for (const option of fixed) {
      const haystack = `${option.label} ${option.detail} ${option.group}`.toLocaleLowerCase();
      if (!query || haystack.includes(query)) values.push(option);
    }
    for (const plugin of catalog?.plugins ?? []) {
      const haystack = `${plugin.name} ${plugin.displayName} ${plugin.description}`.toLocaleLowerCase();
      if (query && !haystack.includes(query)) continue;
      values.push({
        id: `plugin:${plugin.id}`,
        group: 'Plugin',
        label: `/${plugin.displayName || plugin.name}`,
        detail: plugin.description,
        disabled: selectedIds.has(`plugin:${plugin.id}`),
        token: { kind: 'plugin', label: `/${plugin.displayName || plugin.name}`, stableId: plugin.id },
      });
    }
    for (const skill of catalog?.skills ?? []) {
      const pluginSkill = skill.source === 'plugin';
      const kind: StructuredTokenKind = pluginSkill ? 'plugin-skill' : 'skill';
      const haystack = `${skill.name} ${skill.description} ${skill.shortDescription ?? ''} ${skill.pluginName ?? ''}`.toLocaleLowerCase();
      if (query && !haystack.includes(query)) continue;
      values.push({
        id: `${kind}:${skill.id}`,
        group: pluginSkill ? (zh ? 'Plugin Skill' : 'Plugin Skill') : 'Skill',
        label: `/${skill.name}`,
        detail: skill.shortDescription || skill.description,
        disabled: selectedIds.has(`${kind}:${skill.id}`) || (!pluginSkill && selectedSkillCount >= 8),
        disabledReason: !pluginSkill && selectedSkillCount >= 8 ? (zh ? '每轮最多选择 8 个 Skill' : 'Up to 8 Skills per turn') : undefined,
        token: { kind, label: `/${skill.name}`, stableId: skill.id },
      });
    }
    return values;
  }, [catalog?.plugins, catalog?.skills, computerEnabled, employees, props.goalActive, props.goalAvailable, props.onOpenComputerSettings, tokens, trigger, zh]);

  useEffect(() => setActiveOption(firstEnabledOption(options)), [options]);

  function updateTrigger(caret: number): void {
    if (composingRef.current || props.disabled) {
      setTrigger(null);
      return;
    }
    setTrigger(findTrigger(props.value, caret));
  }

  function updateValue(nextValue: string, caret: number): void {
    const nextTokens = reconcileTokens(props.value, nextValue, tokens);
    setTokens(nextTokens);
    props.onSelectionChange(selectionFromTokens(nextValue, nextTokens));
    props.onValueChange(nextValue);
    requestAnimationFrame(() => setTrigger(findTrigger(nextValue, caret)));
  }

  function choose(option: MenuOption): void {
    if (!trigger || option.disabled) return;
    if (option.action) {
      const next = `${props.value.slice(0, trigger.start)}${props.value.slice(trigger.end)}`;
      const nextTokens = reconcileTokens(props.value, next, tokens);
      setTokens(nextTokens);
      props.onSelectionChange(selectionFromTokens(next, nextTokens));
      setTrigger(null);
      props.onValueChange(next);
      if (option.action === 'plan') props.onPlanMode();
      else if (option.action === 'goal') props.onGoalMode();
      else props.onOpenComputerSettings?.();
      requestAnimationFrame(() => {
        props.textareaRef.current?.focus();
        props.textareaRef.current?.setSelectionRange(trigger.start, trigger.start);
      });
      return;
    }
    if (!option.token) return;
    const suffix = props.value.slice(trigger.end);
    const needsSpace = suffix.length === 0 || !/^\s/u.test(suffix);
    const replacement = `${option.token.label}${needsSpace ? ' ' : ''}`;
    const next = `${props.value.slice(0, trigger.start)}${replacement}${suffix}`;
    const delta = replacement.length - (trigger.end - trigger.start);
    const shifted = tokens.filter((token) => token.end <= trigger.start || token.start >= trigger.end).map((token) => (token.start >= trigger.end ? { ...token, start: token.start + delta, end: token.end + delta } : token));
    const token: StructuredToken = { ...option.token, id: createTokenId(), start: trigger.start, end: trigger.start + option.token.label.length };
    const nextTokens = [...shifted, token].sort((left, right) => left.start - right.start);
    setTokens(nextTokens);
    props.onSelectionChange(selectionFromTokens(next, nextTokens));
    setTrigger(null);
    props.onValueChange(next);
    const caret = trigger.start + replacement.length;
    requestAnimationFrame(() => {
      props.textareaRef.current?.focus();
      props.textareaRef.current?.setSelectionRange(caret, caret);
    });
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (!composingRef.current && trigger && options.length > 0) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveOption((current) => nextEnabledOption(options, current, event.key === 'ArrowDown' ? 1 : -1));
        return;
      }
      if ((event.key === 'Enter' || event.key === 'Tab') && options[activeOption] && !options[activeOption]!.disabled) {
        event.preventDefault();
        choose(options[activeOption]!);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setTrigger(null);
        return;
      }
    }
    if (!composingRef.current && handleAtomicTokenKey(event, props.value, tokens, updateValue)) {
      setTrigger(null);
      return;
    }
    props.onKeyDown(event);
  }

  const activeDescendant = trigger && options[activeOption] ? `${listboxId}-${safeDomId(options[activeOption]!.id)}` : undefined;
  return (
    <div className="structured-composer-root">
      <div className="structured-composer-editor">
        <div className="structured-composer-mirror" aria-hidden="true" style={{ transform: `translateY(${-mirrorScrollTop}px)` }}>
          {renderMirror(props.value, tokens)}
        </div>
        <textarea
          ref={props.textareaRef}
          aria-label={props.ariaLabel}
          aria-keyshortcuts={props.ariaKeyShortcuts}
          aria-autocomplete={trigger ? 'list' : undefined}
          aria-controls={trigger ? listboxId : undefined}
          aria-expanded={trigger ? true : undefined}
          aria-activedescendant={activeDescendant}
          autoFocus={props.autoFocus}
          placeholder={props.placeholder}
          value={props.value}
          disabled={props.disabled}
          onChange={(event) => updateValue(event.currentTarget.value, event.currentTarget.selectionStart)}
          onClick={(event) => updateTrigger(event.currentTarget.selectionStart)}
          onKeyUp={(event) => {
            if (!['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key)) updateTrigger(event.currentTarget.selectionStart);
          }}
          onSelect={(event) => updateTrigger(event.currentTarget.selectionStart)}
          onCompositionStart={(event) => {
            composingRef.current = true;
            setTrigger(null);
            props.onCompositionStart?.(event);
          }}
          onCompositionEnd={(event) => {
            composingRef.current = false;
            props.onCompositionEnd?.(event);
            requestAnimationFrame(() => updateTrigger(event.currentTarget.selectionStart));
          }}
          onBlur={props.onBlur}
          onPaste={props.onPaste}
          onKeyDown={handleKeyDown}
          onScroll={(event) => {
            setMirrorScrollTop(event.currentTarget.scrollTop);
            props.onScroll?.(event);
          }}
        />
      </div>
      {trigger ? (
        <div className="structured-composer-menu" id={listboxId} role="listbox" aria-label={trigger.kind === '@' ? (zh ? '选择数字员工' : 'Select digital employees') : zh ? '选择命令' : 'Select command'}>
          {options.map((option, index) => (
            <div
              id={`${listboxId}-${safeDomId(option.id)}`}
              key={option.id}
              role="option"
              aria-selected={index === activeOption}
              aria-disabled={option.disabled || undefined}
              className="structured-composer-option"
              data-active={index === activeOption ? 'true' : 'false'}
              data-disabled={option.disabled ? 'true' : 'false'}
              onMouseDown={(event) => {
                event.preventDefault();
                choose(option);
              }}
            >
              <span className="structured-composer-option-group">{option.group}</span>
              <strong>{option.label}</strong>
              <small>{option.disabledReason || option.detail}</small>
            </div>
          ))}
          {options.length === 0 ? (
            <p className="structured-composer-empty" role="status">
              {trigger.kind === '@'
                ? employeeError || (loadingEmployees ? (zh ? '正在加载数字员工…' : 'Loading digital employees…') : zh ? '没有匹配的数字员工' : 'No matching digital employees')
                : catalogError || (zh ? '没有匹配的命令或扩展' : 'No matching commands or extensions')}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function selectionFromTokens(value: string, tokens: StructuredToken[]): StructuredComposerSelection {
  const ordered = [...tokens].sort((left, right) => left.start - right.start);
  let cursor = 0;
  let promptText = '';
  for (const token of ordered) {
    promptText += value.slice(cursor, token.start);
    cursor = token.end;
  }
  promptText += value.slice(cursor);
  return {
    displayText: value,
    promptText: promptText.replaceAll(/[ \t]{2,}/gu, ' ').trim(),
    expertMentions: ordered.filter((token) => token.kind === 'expert').map((token) => ({ employeeId: token.stableId })),
    skillReferences: ordered.filter((token) => token.kind === 'skill').map((token) => ({ id: token.stableId })),
    pluginReferences: ordered.filter((token) => token.kind === 'plugin' || token.kind === 'plugin-skill').map((token) => ({ kind: token.kind === 'plugin' ? ('plugin' as const) : ('skill' as const), id: token.stableId })),
    computerUseRequested: ordered.some((token) => token.kind === 'computer'),
  };
}

function findTrigger(value: string, caret: number): TriggerRange | null {
  const before = value.slice(0, caret);
  const match = /(^|\s)([/@])([^\s/@]*)$/u.exec(before);
  if (!match) return null;
  const prefixLength = match[1]?.length ?? 0;
  const start = match.index + prefixLength;
  return { kind: match[2] as '@' | '/', start, end: caret, query: match[3] ?? '' };
}

function reconcileTokens(previousValue: string, nextValue: string, tokens: StructuredToken[]): StructuredToken[] {
  let prefix = 0;
  while (prefix < previousValue.length && prefix < nextValue.length && previousValue[prefix] === nextValue[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < previousValue.length - prefix && suffix < nextValue.length - prefix && previousValue[previousValue.length - 1 - suffix] === nextValue[nextValue.length - 1 - suffix]) suffix += 1;
  const previousEnd = previousValue.length - suffix;
  const delta = nextValue.length - previousValue.length;
  return tokens
    .flatMap((token) => {
      if (token.end <= prefix) return [token];
      if (token.start >= previousEnd) return [{ ...token, start: token.start + delta, end: token.end + delta }];
      return [];
    })
    .filter((token) => nextValue.slice(token.start, token.end) === token.label);
}

function handleAtomicTokenKey(event: KeyboardEvent<HTMLTextAreaElement>, value: string, tokens: StructuredToken[], update: (value: string, caret: number) => void): boolean {
  const start = event.currentTarget.selectionStart;
  const end = event.currentTarget.selectionEnd;
  if (event.key === 'ArrowLeft' && start === end) {
    const token = tokens.find((candidate) => start > candidate.start && start <= candidate.end);
    if (!token) return false;
    event.preventDefault();
    event.currentTarget.setSelectionRange(token.start, token.start);
    return true;
  }
  if (event.key === 'ArrowRight' && start === end) {
    const token = tokens.find((candidate) => start >= candidate.start && start < candidate.end);
    if (!token) return false;
    event.preventDefault();
    event.currentTarget.setSelectionRange(token.end, token.end);
    return true;
  }
  if (event.key !== 'Backspace' && event.key !== 'Delete') return false;
  const overlapped = tokens.filter((token) => (start === end ? (event.key === 'Backspace' ? start > token.start && start <= token.end : start >= token.start && start < token.end) : token.start < end && token.end > start));
  if (overlapped.length === 0) return false;
  event.preventDefault();
  let removeStart = Math.min(start, ...overlapped.map((token) => token.start));
  let removeEnd = Math.max(end, ...overlapped.map((token) => token.end));
  if (removeEnd < value.length && value[removeEnd] === ' ') removeEnd += 1;
  else if (removeStart > 0 && value[removeStart - 1] === ' ') removeStart -= 1;
  update(`${value.slice(0, removeStart)}${value.slice(removeEnd)}`, removeStart);
  requestAnimationFrame(() => event.currentTarget.setSelectionRange(removeStart, removeStart));
  return true;
}

function renderMirror(value: string, tokens: StructuredToken[]) {
  const ordered = [...tokens].sort((left, right) => left.start - right.start);
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  for (const token of ordered) {
    if (token.start > cursor) parts.push(<span key={`text:${cursor}`}>{value.slice(cursor, token.start)}</span>);
    parts.push(
      <span key={token.id} className="structured-composer-token" data-kind={token.kind}>
        {value.slice(token.start, token.end)}
      </span>,
    );
    cursor = token.end;
  }
  if (cursor < value.length) parts.push(<span key={`text:${cursor}`}>{value.slice(cursor)}</span>);
  parts.push(<span key="tail">&#8203;</span>);
  return parts;
}

function firstEnabledOption(options: MenuOption[]): number {
  const index = options.findIndex((option) => !option.disabled);
  return index < 0 ? 0 : index;
}

function nextEnabledOption(options: MenuOption[], current: number, direction: 1 | -1): number {
  if (options.length === 0) return 0;
  for (let offset = 1; offset <= options.length; offset += 1) {
    const index = (current + direction * offset + options.length) % options.length;
    if (!options[index]?.disabled) return index;
  }
  return current;
}

function createTokenId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `composer-token-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function safeDomId(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9_-]/gu, '-');
}
