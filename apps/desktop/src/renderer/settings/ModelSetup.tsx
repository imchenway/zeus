import type { CodexRuntimeUpdateProgress } from '../features/codex/codexApiClient.js';
import type { ModelSetupController } from './useModelSetup.js';
import { Button } from '../ui/Button.js';
import { ModalPortal } from '../ui/ModalPortal.js';
import { VisibleApplicationError } from '../ui/ApplicationErrorDialog.js';
import { ModelConnectionsSettingsPane } from './ModelConnectionsSettingsPane.js';
import { CodexInstallationGuide } from './CodexInstallationGuide.js';
import { presentModelOptions } from '../modelOptionPresentation.js';

/** 更新阶段文案与原生“检查更新”窗口保持同一结构。 */
function codexUpdateProgressLabel(stage: CodexRuntimeUpdateProgress['stage'], zh: boolean): string {
  /** 中文与英文共用同一阶段顺序。 */
  const labels: Record<CodexRuntimeUpdateProgress['stage'], [string, string]> = {
    checking: ['正在检查最新版本', 'Checking the latest version'],
    waiting: ['等待当前工作安全结束', 'Waiting for current work to finish safely'],
    preparing: ['正在准备更新', 'Preparing update'],
    downloading: ['正在下载 Codex', 'Downloading Codex'],
    installing: ['正在安装 Codex', 'Installing Codex'],
    verifying: ['正在校验安装结果', 'Verifying installation'],
    switching: ['正在切换运行实例', 'Switching runtimes'],
    completed: ['更新完成', 'Update complete'],
  };
  return labels[stage][zh ? 0 : 1];
}

/** 模型供应商设置顶部的常驻订阅入口，状态来自实际账号查询。 */
export function CodexAccountSettings({ controller }: { controller: ModelSetupController }) {
  /** 沿用当前应用语言。 */
  const zh = controller.input.settings.appLanguage === 'zh-CN';
  /** 显示最近一次真实账号查询结果。 */
  const account = controller.account;
  /** 只有 ChatGPT 账号认证成功才表示订阅已登录。 */
  const signedIn = account?.signedIn && account.accountType === 'chatgpt';
  /** 总览读取不完整时提供真实重连入口，不能把未知账号状态伪装成未登录。 */
  const reconnectNeeded = Boolean(controller.error) && (!controller.accountChecked || !controller.modelsChecked || (typeof controller.error !== 'string' && controller.error?.code === 'ZEUS_CODEX_UPDATE_ACTIVATION_FAILED'));
  /** 复用所有模型选择入口的稳定排序，不在设置页另造目录顺序。 */
  const presentedModels = presentModelOptions(controller.models, '', zh ? 'zh-CN' : 'en-US').models;
  /** 只有下载器返回真实字节比例时才展示百分比。 */
  const updateProgressPercent = controller.updateProgress.progress === null ? null : Math.round(controller.updateProgress.progress * 100);
  /** 更新结果与本机版本分开表达，未检测时不猜测是否最新。 */
  const updateLabel =
    controller.operation === 'updating'
      ? zh
        ? '正在更新 Codex 并切换运行实例…'
        : 'Updating Codex and switching runtimes…'
      : controller.updateCheck
        ? controller.updateCheck.status === 'available'
          ? zh
            ? `当前版本 ${controller.updateCheck.currentVersion ?? '未知'} · 可更新至 ${controller.updateCheck.latestVersion ?? '未知'}`
            : `Current ${controller.updateCheck.currentVersion ?? 'unknown'} · ${controller.updateCheck.latestVersion ?? 'unknown'} available`
          : controller.updateCheck.status === 'up_to_date'
            ? zh
              ? `Codex ${controller.updateCheck.currentVersion ?? '未知'} · 已是最新版本`
              : `Codex ${controller.updateCheck.currentVersion ?? 'unknown'} · Up to date`
            : zh
              ? '尚未检测到可更新的 Codex 程序'
              : 'No update-ready Codex installation detected'
        : controller.installationCheck?.version
          ? zh
            ? `当前版本 ${controller.installationCheck.version}`
            : `Current version ${controller.installationCheck.version}`
          : zh
            ? '正在读取 Codex 版本…'
            : 'Loading Codex version…';
  return (
    <section className="settings-product-section model-setup-account" aria-label={zh ? 'Codex 订阅' : 'Codex subscription'}>
      <header className="settings-section-heading">
        <strong>Codex {zh ? '订阅' : 'subscription'}</strong>
        <span className="account-sign-in-state" data-signed-in={signedIn || undefined}>
          {signedIn
            ? zh
              ? `已登录${account.planType ? ` · ${account.planType}` : ''}`
              : `Signed in${account.planType ? ` · ${account.planType}` : ''}`
            : controller.operation === 'checking' && !controller.accountChecked
              ? zh
                ? '正在读取账号状态…'
                : 'Loading account status…'
              : controller.accountChecked
                ? zh
                  ? '未登录订阅账号'
                  : 'Subscription account is not signed in'
                : controller.error
                  ? zh
                    ? '暂时无法读取账号状态'
                    : 'Account status is temporarily unavailable'
                  : zh
                    ? '账号状态尚未检查'
                    : 'Account status not checked'}
        </span>
      </header>
      <p>
        {zh
          ? '通过 ChatGPT 账号登录，支持订阅额度和账户点数（Credits），扣费规则由 OpenAI 决定。登录仅用于 Zeus，第三方模型服务在下方管理。'
          : 'Sign in with ChatGPT for Zeus to use included subscription limits and account credits, billed according to OpenAI rules. Manage third-party model services below.'}
      </p>
      <div className="model-setup-actions">
        {signedIn ? (
          <Button variant="secondary" disabled={controller.operation !== 'idle'} onClick={() => void controller.logoutAccount()}>
            {zh ? '退出登录' : 'Sign out'}
          </Button>
        ) : controller.accountChecked ? (
          <Button variant="primary" disabled={controller.operation !== 'idle'} onClick={() => controller.open('codex')}>
            {zh ? '登录 Codex' : 'Sign in to Codex'}
          </Button>
        ) : null}
        {signedIn ? (
          <Button variant="secondary" disabled={controller.operation !== 'idle'} onClick={() => void controller.openUsageManagement()}>
            {zh ? '管理官方用量' : 'Manage official usage'}
          </Button>
        ) : null}
        {reconnectNeeded ? (
          <Button variant="primary" disabled={controller.operation !== 'idle'} busy={controller.operation === 'activating'} onClick={() => void controller.reconnectCodex()}>
            {zh ? '重新连接 Codex' : 'Reconnect Codex'}
          </Button>
        ) : null}
        {!signedIn && !controller.accountChecked && !reconnectNeeded ? (
          <Button variant="primary" disabled>
            {zh ? '正在读取账号状态…' : 'Loading account status…'}
          </Button>
        ) : null}
      </div>
      <div className="codex-update-row">
        <p className="codex-update-state" role="status" aria-live="polite">
          {updateLabel}
        </p>
        <Button variant="secondary" disabled={controller.operation !== 'idle'} busy={controller.operation === 'checking_update'} onClick={() => void controller.refreshCodexOverview('check_update')}>
          {zh ? '检测更新' : 'Check for updates'}
        </Button>
      </div>
      {controller.updateCheck?.status === 'available' ? (
        controller.updateCheck.managedInstallation ? (
          <div className="codex-update-row">
            <p className="codex-update-state">
              {zh
                ? '更新后将重新连接。若连接失败，请先重新连接；Zeus 不会自动降级或用旧数据覆盖对话。'
                : 'Updating reconnects Codex. If it fails, reconnect first; Zeus will not downgrade automatically or overwrite conversations with older data.'}
            </p>
            <Button variant="primary" disabled={controller.operation !== 'idle'} onClick={() => void controller.refreshCodexOverview('install_update')}>
              {zh ? `安装 ${controller.updateCheck.latestVersion}` : `Install ${controller.updateCheck.latestVersion}`}
            </Button>
          </div>
        ) : (
          <p className="codex-update-state">
            {zh ? '这份 Codex 由你自行安装。请使用原安装方式更新，再点击“检测更新”；Zeus 不会修改它。' : 'This Codex installation is managed outside Zeus. Update it with its original installer, then check again; Zeus will not modify it.'}
          </p>
        )
      ) : null}
      {controller.operation === 'updating' ? (
        <div className="codex-update-progress">
          <div className="codex-update-progress-copy">
            <span>{codexUpdateProgressLabel(controller.updateProgress.stage, zh)}</span>
            {updateProgressPercent === null ? null : <strong>{updateProgressPercent}%</strong>}
          </div>
          <div
            className="codex-update-progress-track"
            data-indeterminate={updateProgressPercent === null ? true : undefined}
            role="progressbar"
            aria-label={zh ? 'Codex 更新进度' : 'Codex update progress'}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={updateProgressPercent ?? undefined}
            aria-valuetext={updateProgressPercent === null ? codexUpdateProgressLabel(controller.updateProgress.stage, zh) : undefined}
          >
            <span style={updateProgressPercent === null ? undefined : { inlineSize: `${updateProgressPercent}%` }} />
          </div>
        </div>
      ) : null}
      <section className="codex-available-models" aria-labelledby="codex-available-models-title">
        <strong id="codex-available-models-title">
          {zh ? '当前可用模型' : 'Available models'}
          {controller.modelsChecked ? ` · ${presentedModels.length}` : ''}
        </strong>
        {!controller.modelsChecked ? (
          <small>{controller.error ? (zh ? '暂时无法读取当前账号的模型目录。' : 'The current account model catalog is temporarily unavailable.') : zh ? '正在读取当前账号的模型目录…' : 'Loading the current account model catalog…'}</small>
        ) : presentedModels.length === 0 ? (
          <small>{zh ? '当前运行时没有返回可用的 Codex 模型。' : 'The current runtime returned no available Codex models.'}</small>
        ) : (
          <ul>
            {presentedModels.map((model) => (
              <li key={model.id}>
                <span>{model.displayName?.trim() || model.model}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      {!controller.step && controller.error ? (
        <p role="status">
          <VisibleApplicationError error={controller.error} language={zh ? 'zh-CN' : 'en'} />
        </p>
      ) : null}
    </section>
  );
}

/** 单一模态面按步骤展示登录和配置，供应商编辑器在返回首屏时保留普通字段。 */
export function ModelSetupDialog({ controller: c }: { controller: ModelSetupController }) {
  /** 沿用当前应用语言。 */
  const zh = c.input.settings.appLanguage === 'zh-CN';
  /** 持久化期间保持当前工作面，避免中途丢失结果。 */
  const locked = c.operation === 'importing' || c.operation === 'saving' || c.operation === 'configuring' || c.editorBusy;
  if (!c.step) return null;
  return (
    <ModalPortal rootClassName="model-setup-portal" dismissDisabled={locked} onDismiss={c.close} role="dialog" aria-labelledby="model-setup-title" aria-describedby="model-setup-description">
      <section className="model-setup-dialog zeus-solid-form-surface" data-modal-surface="dialog">
        <header className="model-setup-heading">
          <div>
            <strong id="model-setup-title">
              {c.step === 'choose'
                ? zh
                  ? '连接模型'
                  : 'Connect a model'
                : c.step === 'custom'
                  ? zh
                    ? 'API Key 与已有供应商'
                    : 'API key or existing provider'
                  : c.step === 'config'
                    ? zh
                      ? '导入 Codex 配置'
                      : 'Import Codex configuration'
                    : zh
                      ? '使用 Codex 订阅'
                      : 'Use a Codex subscription'}
            </strong>
            <p id="model-setup-description">
              {c.taskTarget
                ? zh
                  ? '接入后进入推送确认，检查设置后再开始。'
                  : 'Continue to push confirmation after setup. Review your settings before starting.'
                : c.conversationTarget
                  ? zh
                    ? '接入后返回新对话，已输入的内容会保留，确认后再发送。'
                    : 'Return to your new conversation after setup. Your draft is preserved for you to review and send.'
                  : zh
                    ? '选择模型接入方式，或使用已有供应商。'
                    : 'Choose how to connect, or select an existing provider.'}
            </p>
            {c.taskTarget ? <small className="model-setup-task-context">{c.taskTarget.label}</small> : null}
          </div>
          <Button variant="secondary" aria-label={zh ? '关闭接入引导' : 'Close model setup'} disabled={locked} onClick={c.close}>
            ×
          </Button>
        </header>
        <div className="model-setup-body">
          {c.step === 'choose' ? (
            <div className="model-setup-options">
              <Button variant="secondary" onClick={() => void c.prepareCodex()} disabled={c.operation !== 'idle'}>
                <strong>{zh ? '使用 Codex 订阅' : 'Use Codex subscription'}</strong>
                <span>{zh ? '通过官方网页登录 ChatGPT 账号' : 'Sign in to ChatGPT on the official website'}</span>
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  c.setCustomVisited(true);
                  c.setStep('custom');
                }}
              >
                <strong>{zh ? 'API Key 与已有供应商' : 'API key or existing provider'}</strong>
                <span>{zh ? '填写服务地址与 API Key，选择模型' : 'Enter a service URL and API key, then choose a model'}</span>
              </Button>
            </div>
          ) : null}
          <div hidden={c.step !== 'custom'}>
            {c.customVisited ? (
              <ModelConnectionsSettingsPane
                language={c.input.settings.appLanguage}
                client={c.input.client}
                active={c.step === 'custom'}
                onBusyChange={c.setEditorBusy}
                completionScope={c.conversationTarget ? 'conversation' : c.taskTarget ? 'project' : 'new_projects'}
                onComplete={(reference) => c.finish(reference)}
              />
            ) : null}
          </div>
          {c.step === 'codex' ? (
            <div className="model-setup-codex">
              <p role="status" aria-live="polite">
                {c.operation === 'detecting'
                  ? zh
                    ? '正在检测 Codex 程序…'
                    : 'Checking the Codex installation…'
                  : c.operation === 'configuring'
                    ? zh
                      ? '正在保存路径并重新检测…'
                      : 'Saving the path and checking again…'
                    : c.operation === 'inspecting'
                      ? zh
                        ? '正在准备登录…'
                        : 'Preparing sign-in…'
                      : c.operation === 'authenticating'
                        ? zh
                          ? '请在官方网页完成登录。完成后返回这里确认设置。'
                          : 'Complete sign-in on the official page, then return here to review your settings.'
                        : c.operation === 'activating'
                          ? zh
                            ? '正在加载订阅模型…'
                            : 'Loading subscription models…'
                          : c.operation === 'authenticated'
                            ? zh
                              ? '登录成功，正在返回 Zeus…'
                              : 'Signed in, returning to Zeus…'
                            : c.modelsPending && c.installationCheck?.available
                              ? zh
                                ? '订阅登录已完成，模型同步尚未完成。可以直接重试同步。'
                                : 'Sign-in completed, but model synchronization is pending. Retry synchronization to continue.'
                              : c.installationCheck && !c.installationCheck.available
                                ? zh
                                  ? '完成程序准备后，即可继续订阅登录。'
                                  : 'Prepare Codex to continue signing in.'
                                : zh
                                  ? '登录将打开系统浏览器中的官方授权页。Zeus 不会复制其他应用的账号、密钥或历史会话。'
                                  : 'Sign-in opens the official authorization page in your system browser. Zeus will not copy accounts, keys, or history from other apps.'}
              </p>
              {c.installationCheck ? (
                <CodexInstallationGuide key={c.installationCheck.checkedAt} zh={zh} status={c.installationCheck} busy={c.operation !== 'idle'} onCheck={c.checkInstallation} onSavePath={c.saveCodexPath} onOpenGuide={c.openInstallGuide} />
              ) : null}
              {c.installationCheck?.available ? (
                <>
                  <Button
                    disabled={c.operation !== 'idle'}
                    busy={c.operation === 'inspecting' || c.operation === 'authenticating' || c.operation === 'activating'}
                    onClick={() => void (c.modelsPending ? c.retrySubscriptionModels() : c.prepareCodex())}
                  >
                    {c.modelsPending ? (zh ? '重试同步模型' : 'Retry model synchronization') : zh ? '登录 Codex 订阅' : 'Sign in with Codex subscription'}
                  </Button>
                  {c.modelsPending ? (
                    <Button variant="secondary" disabled={c.operation !== 'idle'} onClick={() => void c.prepareCodex()}>
                      {zh ? '重新登录' : 'Sign in again'}
                    </Button>
                  ) : null}
                  <Button variant="secondary" disabled={c.operation !== 'idle'} onClick={() => void c.inspectConfig()}>
                    {zh ? '导入已有配置（可选）' : 'Import configuration (optional)'}
                  </Button>
                </>
              ) : !c.installationCheck ? (
                <Button variant="secondary" disabled={c.operation !== 'idle'} busy={c.operation === 'detecting'} onClick={() => void c.checkInstallation()}>
                  {zh ? '重新检测 Codex' : 'Check Codex again'}
                </Button>
              ) : null}
            </div>
          ) : null}
          {c.step === 'config' ? (
            <div className="model-setup-import">
              <p>
                {c.needsActivation
                  ? zh
                    ? '配置已导入，需启用后继续；重试不会重复导入。'
                    : 'Configuration was imported; activate it to continue without importing again.'
                  : zh
                    ? '可导入普通偏好、指令、规则、技能及工具配置；不会导入账号、密钥或历史会话。'
                    : 'Import preferences, instructions, rules, skills and tool configuration. Accounts, keys and history are excluded.'}
              </p>
              <ul>
                {c.preview?.entries.map((entry) => (
                  <li key={entry.path}>
                    {entry.path} · {entry.nodeCount}
                  </li>
                ))}
              </ul>
              <div className="model-setup-actions">
                <Button disabled={c.operation !== 'idle'} busy={c.operation === 'importing'} onClick={() => void c.importConfig()}>
                  {c.needsActivation ? (zh ? '重试启用' : 'Retry activation') : zh ? '导入并继续' : 'Import and continue'}
                </Button>
                {!c.needsActivation ? (
                  <Button variant="secondary" disabled={locked} onClick={c.skipImport}>
                    {zh ? '暂不导入' : 'Skip import'}
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}
          {c.error ? (
            <p className="model-setup-error" role="alert">
              <VisibleApplicationError error={c.error} language={zh ? 'zh-CN' : 'en'} />
            </p>
          ) : null}
        </div>
        <footer className="model-setup-actions">
          <Button variant="secondary" disabled={locked} onClick={c.step === 'choose' ? c.close : c.back}>
            {c.step === 'choose'
              ? c.taskTarget
                ? c.taskTarget.entry === 'before_confirmation'
                  ? zh
                    ? '返回任务详情'
                    : 'Back to task'
                  : zh
                    ? '返回推送确认'
                    : 'Back to confirmation'
                : zh
                  ? '稍后设置'
                  : 'Set up later'
              : zh
                ? '返回选择'
                : 'Back to choices'}
          </Button>
          <small>{zh ? '可随时在“设置 → 模型供应商”再次接入。' : 'You can reconnect in Settings → Model providers at any time.'}</small>
        </footer>
      </section>
    </ModalPortal>
  );
}
