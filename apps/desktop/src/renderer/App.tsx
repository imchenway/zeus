import { type ComponentProps, useCallback, useEffect, useRef, useState } from 'react';
import { RendererErrorBoundary } from './ErrorBoundary.js';
import { reportApplicationError } from './ui/ApplicationErrorDialog.js';
import { type MainNavTarget, type SettingsCategory, WorkspacePage } from './WorkspacePage.js';

export { buildProjectDirectoryResolution, buildTemplateTaskDraft } from './WorkspacePage.js';

type AppProps = Omit<ComponentProps<typeof WorkspacePage>, 'shellNavigation'>;

/**
 * Renderer composition root：只拥有窗口级错误边界、顶层路由和全局导航状态。
 * 项目、任务、会话、Git、设置与远控业务均由 WorkspacePage 及各自 feature controller 接管。
 */
export function App(props: AppProps) {
  const [activeNavTarget, setActiveNavTarget] = useState<MainNavTarget>(() => initialMainRoute(props));
  const [settingsCategory, setSettingsCategory] = useState<SettingsCategory>(() => initialSettingsCategory(props));
  /** 地址栏导航复用工作区草稿保护，不在根组件复制保存逻辑。 */
  const leaveGuardRef = useRef<((leave: () => void, cancel?: () => void) => void) | null>(null);
  /** 工作区始终通过自己的最新状态处理离开。 */
  const registerLeaveGuard = useCallback((guard: typeof leaveGuardRef.current) => {
    leaveGuardRef.current = guard;
  }, []);

  useEffect(() => {
    const syncRoute = (event: HashChangeEvent): void => {
      /** 在用户选择保存或放弃前，保留当前地址和草稿。 */
      const targetHash = new URL(event.newURL).hash;
      if (leaveGuardRef.current) window.history.replaceState(null, '', event.oldURL);
      /** 确认离开后才同步目标地址及页面状态。 */
      const applyRoute = (): void => {
        window.history.replaceState(null, '', event.newURL);
        setActiveNavTarget(routeFromHash(targetHash));
        /** 同一次导航同时恢复设置子页面。 */
        const category = settingsCategoryFromHash(targetHash);
        if (category) setSettingsCategory(category);
      };
      if (leaveGuardRef.current) leaveGuardRef.current(applyRoute);
      else applyRoute();
    };
    globalThis.addEventListener?.('hashchange', syncRoute);
    return () => globalThis.removeEventListener?.('hashchange', syncRoute);
  }, []);

  const navigate = useCallback((target: MainNavTarget): void => {
    setActiveNavTarget(target);
    if (typeof window !== 'undefined' && routeFromHash(window.location.hash) !== target) window.history.replaceState(null, '', `#${target}`);
  }, []);

  const selectSettingsCategory = useCallback((category: SettingsCategory): void => {
    setSettingsCategory(category);
    setActiveNavTarget('settings');
    if (typeof window !== 'undefined') window.history.replaceState(null, '', `#settings-${category}`);
  }, []);

  const language = props.initialAppShellSettings?.appLanguage ?? 'zh-CN';
  return (
    <RendererErrorBoundary
      appLanguage={language}
      onFatalError={(error) =>
        reportApplicationError(error, {
          language: language === 'zh-CN' ? 'zh-CN' : 'en',
        })
      }
    >
      <WorkspacePage
        {...props}
        shellNavigation={{
          activeNavTarget,
          settingsCategory,
          onNavigate: navigate,
          onSettingsCategoryChange: selectSettingsCategory,
          onRegisterLeaveGuard: registerLeaveGuard,
        }}
      />
    </RendererErrorBoundary>
  );
}

function initialMainRoute(props: AppProps): MainNavTarget {
  if (props.initialMainNavTarget) return routeFromHash(`#${props.initialMainNavTarget}`);
  if (typeof window !== 'undefined' && window.location.hash) return routeFromHash(window.location.hash);
  if (props.initialSecuritySecrets || props.initialReleaseStatus || props.initialSecurityAuditLogs?.length || props.initialLocalError) return 'settings';
  if (props.initialProjectConfig || props.initialProjectDatabaseSecret || props.initialArchivedProjects?.length) return 'projects';
  if (props.initialGitDiff || props.initialGitConfirmation) return 'projects';
  if ((props.snapshot?.tasks.length ?? 0) > 0) return 'conversations';
  return 'projects';
}

function initialSettingsCategory(props: AppProps): SettingsCategory {
  const fromHash = typeof window === 'undefined' ? undefined : settingsCategoryFromHash(window.location.hash);
  if (fromHash) return fromHash;
  if (props.initialMainNavTarget === 'settings-data') return 'data';
  if (props.initialMainNavTarget === 'telegram' || props.initialSecuritySecrets?.telegramBotToken.configured) return 'im';
  if (props.initialRuntimeSettings || props.initialRuntimeStatus) return 'runtime';
  if (props.initialReleaseStatus) return 'release';
  return 'general';
}

function routeFromHash(hash: string | undefined): MainNavTarget {
  const target = hash?.replace(/^#/, '');
  if (!target) return 'conversations';
  if (target === 'dashboard' || target === 'tasks' || target === 'runtime' || target === 'conversations') return 'conversations';
  if (target === 'git-diff' || target === 'projects' || target === 'project-commands' || target.startsWith('project-code')) return 'projects';
  if (target === 'skills') return 'skills';
  if (target === 'digital-teams') return 'digital-teams';
  if (target === 'automations') return 'automations';
  if (target === 'telegram' || target === 'settings' || target.startsWith('settings-')) return 'settings';
  return 'conversations';
}

function settingsCategoryFromHash(hash: string | undefined): SettingsCategory | undefined {
  const target = hash?.replace(/^#settings-/, '');
  if (target === 'telegram') {
    if (typeof window !== 'undefined') window.history.replaceState(null, '', '#settings-im');
    return 'im';
  }
  return settingsCategories.includes(target as SettingsCategory) ? (target as SettingsCategory) : undefined;
}

const settingsCategories = ['general', 'usage', 'memory', 'agents', 'tasks', 'employees', 'runtime', 'models', 'browser', 'terminal', 'im', 'zentao', 'commands', 'release', 'data'] as const satisfies readonly SettingsCategory[];
