import { type ComponentProps, useCallback, useEffect, useState } from 'react';
import { RendererErrorBoundary } from './ErrorBoundary.js';
import { reportApplicationError } from './ui/ApplicationErrorDialog.js';
import { type MainNavTarget, type SettingsCategory, WorkspacePage } from './WorkspacePage.js';

export { buildGraphConversationTaskIntent, buildGraphNodeTaskIntent, buildProjectDirectoryResolution, buildTemplateTaskDraft } from './WorkspacePage.js';

type AppProps = Omit<ComponentProps<typeof WorkspacePage>, 'shellNavigation'>;

/**
 * Renderer composition root：只拥有窗口级错误边界、顶层路由和全局导航状态。
 * 项目、任务、会话、Git、设置与远控业务均由 WorkspacePage 及各自 feature controller 接管。
 */
export function App(props: AppProps) {
  const [activeNavTarget, setActiveNavTarget] = useState<MainNavTarget>(() => initialMainRoute(props));
  const [settingsCategory, setSettingsCategory] = useState<SettingsCategory>(() => initialSettingsCategory(props));

  useEffect(() => {
    const syncRoute = (): void => {
      setActiveNavTarget(routeFromHash(globalThis.location?.hash));
      const category = settingsCategoryFromHash(globalThis.location?.hash);
      if (category) setSettingsCategory(category);
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
  if (props.initialGitDiff || props.initialGitConfirmation || props.initialGraphView || props.initialGraphAnswer || props.initialGraphConversations?.length) return 'projects';
  if ((props.snapshot?.tasks.length ?? 0) > 0) return 'conversations';
  return 'projects';
}

function initialSettingsCategory(props: AppProps): SettingsCategory {
  const fromHash = typeof window === 'undefined' ? undefined : settingsCategoryFromHash(window.location.hash);
  if (fromHash) return fromHash;
  if (props.initialMainNavTarget === 'settings-data') return 'data';
  if (props.initialMainNavTarget === 'telegram' || props.initialSecuritySecrets?.telegramBotToken.configured) return 'im';
  if (props.initialRuntimeSettings || props.initialRuntimeStatus) return 'runtime';
  if (props.initialSecuritySecrets || props.initialSecurityAuditLogs?.length) return 'security';
  if (props.initialGitConfirmation && props.initialMainNavTarget === 'settings') return 'git';
  if (props.initialReleaseStatus) return 'release';
  return 'general';
}

function routeFromHash(hash: string | undefined): MainNavTarget {
  const target = hash?.replace(/^#/, '');
  if (!target) return 'conversations';
  if (target === 'dashboard' || target === 'tasks' || target === 'runtime' || target === 'conversations') return 'conversations';
  if (target === 'code-map' || target === 'git-diff' || target === 'projects' || target === 'project-commands' || target.startsWith('project-code')) return 'projects';
  if (target === 'skills') return 'skills';
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

const settingsCategories = ['general', 'usage', 'memory', 'tasks', 'employees', 'runtime', 'models', 'browser', 'im', 'zentao', 'security', 'commands', 'git', 'release', 'data'] as const satisfies readonly SettingsCategory[];
