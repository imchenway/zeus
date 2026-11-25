import { useEffect, useRef, useState } from 'react';
import { CaretRightIcon } from '@phosphor-icons/react/dist/csr/CaretRight';
import { XIcon } from '@phosphor-icons/react/dist/csr/X';
import type { ModelSetupController, SubscriptionSetupProvider } from './useModelSetup.js';
import { ZeusSelect } from '../ZeusSelect.js';
import { Button } from '../ui/Button.js';
import { ModalPortal } from '../ui/ModalPortal.js';
import { VisibleApplicationError } from '../ui/ApplicationErrorDialog.js';
import { ManagedCliProgress } from './ManagedCliProgress.js';
import { ModelProviderAvailableModels, ModelProviderIdentity, ModelProviderMark } from './ModelProviderIdentity.js';
import { ModelConnectionsSettingsPane } from './ModelConnectionsSettingsPane.js';
import { CodexInstallationGuide } from './CodexInstallationGuide.js';
import { AntigravityAccountSettings } from './AntigravityAccountSettings.js';
import { CopilotAccountSettings } from './CopilotAccountSettings.js';
import { presentModelOptions } from '../modelOptionPresentation.js';

/** 模型供应商设置顶部的常驻订阅入口，状态来自实际账号查询。 */
export function CodexAccountSettings({ controller }: { controller: ModelSetupController }) {
  /** 沿用当前应用语言。 */
  const zh = controller.input.settings.appLanguage === 'zh-CN';
  /** 显示最近一次真实账号查询结果。 */
  const account = controller.account;
  /** 只有 ChatGPT 账号认证成功才表示订阅已登录。 */
  const signedIn = account?.signedIn && account.accountType === 'chatgpt';
  /** 先提供程序首装入口，缺少 CLI 时无需等待账号查询结果。 */
  const installationMissing = controller.installationCheck?.installationIssue === 'not_found';
  /** 程序已就绪时可以打开登录入口，授权由登录流程确认。 */
  const canOfferLogin = controller.accountChecked || controller.installationCheck?.available === true;
  /** 总览读取不完整时提供真实重连入口，不能把未知账号状态伪装成未登录。 */
  const reconnectNeeded =
    !installationMissing && Boolean(controller.error) && (!controller.accountChecked || !controller.modelsChecked || (typeof controller.error !== 'string' && controller.error?.code === 'ZEUS_CODEX_UPDATE_ACTIVATION_FAILED'));
  /** 账号与版本操作共用当前程序的忙碌状态。 */
  const actionsDisabled = controller.operation !== 'idle' || controller.installingCodex;
  /** 已确认的外部安装不显示 Zeus 托管更新入口。 */
  const showUpdate = !installationMissing && !controller.installingCodex && controller.operation !== 'updating' && controller.updateCheck?.managedInstallation !== false;
  /** 只有检测到受管程序的目标版本才提供安装更新。 */
  const updateAvailable = showUpdate && controller.updateCheck?.managedInstallation && controller.updateCheck.status === 'available';
  /** 更新结果与本机版本分开表达，未检测时不猜测是否最新。 */
  const updateLabel = controller.updateCheck
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
      <ModelProviderIdentity provider="codex" name={zh ? 'Codex 订阅' : 'Codex subscription'} connected={signedIn} busy={controller.installingCodex || controller.operation === 'checking' || controller.operation === 'updating'}>
        {controller.installingCodex
          ? zh
            ? '安装中'
            : 'Installing'
          : controller.operation === 'updating'
            ? zh
              ? '更新中'
              : 'Updating'
            : signedIn
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
      </ModelProviderIdentity>
      <div className="model-setup-actions">
        {showUpdate ? (
          <Button variant="secondary" disabled={actionsDisabled} busy={controller.operation === 'checking_update'} onClick={() => controller.refreshCodexOverview('check_update')}>
            {zh ? '检测更新' : 'Check updates'}
          </Button>
        ) : null}
        {updateAvailable ? (
          <Button variant="primary" disabled={actionsDisabled} onClick={() => controller.refreshCodexOverview('install_update')}>
            {zh ? '安装更新' : 'Install update'}
          </Button>
        ) : null}
        {signedIn ? (
          <Button variant="secondary" disabled={actionsDisabled} aria-label={zh ? '管理 Codex 官方用量' : 'Manage official Codex usage'} onClick={() => controller.openUsageManagement()}>
            {zh ? '用量' : 'Usage'}
          </Button>
        ) : null}
        {signedIn ? (
          <Button variant="secondary" disabled={actionsDisabled} aria-label={zh ? '退出登录 Codex' : 'Sign out of Codex'} onClick={() => controller.logoutAccount()}>
            {zh ? '退出登录' : 'Sign out'}
          </Button>
        ) : installationMissing ? (
          <Button variant="primary" disabled={actionsDisabled} aria-label={zh ? '安装 Codex' : 'Install Codex'} onClick={() => controller.installCodex()}>
            {zh ? '安装' : 'Install'}
          </Button>
        ) : canOfferLogin || !reconnectNeeded ? (
          <Button variant={reconnectNeeded ? 'secondary' : 'primary'} disabled={actionsDisabled || !canOfferLogin} aria-label={zh ? '登录 Codex' : 'Sign in to Codex'} onClick={() => controller.open('codex')}>
            {zh ? '登录' : 'Sign in'}
          </Button>
        ) : null}
        {reconnectNeeded ? (
          <Button variant="primary" disabled={actionsDisabled} busy={controller.operation === 'activating'} aria-label={zh ? '重新连接 Codex' : 'Reconnect Codex'} onClick={() => controller.reconnectCodex()}>
            {zh ? '重新连接' : 'Reconnect'}
          </Button>
        ) : null}
      </div>
      <div className="model-provider-account-detail">
        <p>{zh ? '通过 ChatGPT 账号使用订阅额度和账户点数（Credits）。' : 'Use subscription limits and credits with your ChatGPT account.'}</p>
        {showUpdate ? <p role="status">{updateLabel}</p> : null}
        {updateAvailable ? (
          <p>
            {zh
              ? '更新后将重新连接。若连接失败，请先重新连接；Zeus 不会自动降级或用旧数据覆盖对话。'
              : 'Updating reconnects Codex. If it fails, reconnect first; Zeus will not downgrade automatically or overwrite conversations with older data.'}
          </p>
        ) : null}
      </div>
      {controller.operation === 'updating' || (controller.installingCodex && controller.step === null) ? <ManagedCliProgress program="Codex CLI" zh={zh} {...controller.updateProgress} /> : null}
      <ModelProviderAvailableModels
        provider="codex"
        zh={zh}
        models={controller.modelsChecked ? controller.models : null}
        message={
          controller.modelsChecked
            ? zh
              ? '当前运行时没有返回可用的 Codex 模型。'
              : 'The current runtime returned no available Codex models.'
            : controller.error
              ? zh
                ? '暂时无法读取当前账号的模型目录。'
                : 'The current account model catalog is temporarily unavailable.'
              : zh
                ? '正在读取当前账号的模型目录…'
                : 'Loading the current account model catalog…'
        }
      />
      {!controller.step && controller.error ? (
        <p role="status">
          <VisibleApplicationError error={controller.error} language={zh ? 'zh-CN' : 'en'} />
        </p>
      ) : null}
    </section>
  );
}

/** 界面显示真实供应商名称，发给项目的是目录中的模型引用。 */
const subscriptionProviderNames: Record<SubscriptionSetupProvider, string> = {
  codex: 'Codex',
  copilot: 'GitHub Copilot',
  antigravity: 'Google Antigravity',
};

/** 单一模态面按步骤展示登录和配置，供应商编辑器在返回首屏时保留普通字段。 */
export function ModelSetupDialog({ controller: c }: { controller: ModelSetupController }) {
  /** 沿用当前应用语言。 */
  const zh = c.input.settings.appLanguage === 'zh-CN';
  /** 持久化期间保持当前工作面，避免中途丢失结果。 */
  const locked = c.operation === 'importing' || c.operation === 'saving' || c.operation === 'configuring' || c.editorBusy;
  /** 仅在模型选择步骤保留用户的实际选择。 */
  const [modelId, setModelId] = useState('');
  /** 切换步骤时朗读新标题，并让后续 Tab 从当前面继续。 */
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (c.step) titleRef.current?.focus({ preventScroll: true });
  }, [c.step]);
  /** 模型列表沿用会话选择器的排序和显示名。 */
  const language = c.input.settings.appLanguage;
  const selection = c.subscriptionSelection;
  const { options: modelOptions, selectedId } = presentModelOptions(selection?.models ?? [], modelId, language);
  if (!c.step) return null;
  /** 标题用于可见步骤和模态的无障碍名称。 */
  const titles: Record<NonNullable<typeof c.step>, [string, string]> = {
    choose: ['配置模型', 'Set up a model'],
    codex: ['连接 Codex', 'Connect Codex'],
    copilot: ['连接账号', 'Connect an account'],
    antigravity: ['连接账号', 'Connect an account'],
    select_model: ['选择模型', 'Choose a model'],
    custom: ['自定义供应商', 'Custom providers'],
    config: ['导入 Codex 配置', 'Import Codex configuration'],
  };
  /** 新会话提供订阅账号，任务和独立设置沿用各自已有入口。 */
  const options: Array<{ provider: SubscriptionSetupProvider | 'custom'; name: string; detail: string }> = [
    { provider: 'codex', name: subscriptionProviderNames.codex, detail: zh ? 'ChatGPT 订阅或账户点数' : 'ChatGPT subscription or credits' },
    { provider: 'copilot', name: subscriptionProviderNames.copilot, detail: zh ? 'GitHub Copilot 订阅' : 'GitHub Copilot subscription' },
    { provider: 'antigravity', name: subscriptionProviderNames.antigravity, detail: zh ? 'Google 账号和 Google One AI 额度' : 'Google account and Google One AI quota' },
    { provider: 'custom', name: zh ? '自定义供应商' : 'Custom provider', detail: zh ? 'API Key 或已有连接' : 'API key or existing connection' },
  ];
  return (
    <ModalPortal rootClassName="model-setup-portal" dismissDisabled={locked} onDismiss={c.close} role="dialog" aria-labelledby="model-setup-title" aria-describedby={c.step === 'choose' ? 'model-setup-description' : undefined}>
      <section className="model-setup-dialog zeus-solid-form-surface" data-modal-surface="dialog">
        <header className="model-setup-heading">
          <div className="model-setup-heading-content">
            {c.step === 'codex' || c.step === 'config' ? <ModelProviderMark provider="codex" /> : null}
            <div>
              <h2 id="model-setup-title" ref={titleRef} tabIndex={-1}>
                {titles[c.step][zh ? 0 : 1]}
              </h2>
              {c.step === 'choose' ? (
                <p id="model-setup-description">
                  {c.taskTarget
                    ? zh
                      ? '接入后返回推送确认。'
                      : 'Return to push confirmation after setup.'
                    : c.conversationTarget
                      ? zh
                        ? '选择供应商。接入后返回当前草稿。'
                        : 'Choose a provider, then return to your draft.'
                      : zh
                        ? '选择要使用的模型服务。'
                        : 'Choose a model provider.'}
                </p>
              ) : null}
              {c.taskTarget ? <small className="model-setup-task-context">{c.taskTarget.label}</small> : null}
            </div>
          </div>
          <Button variant="secondary" size="compact" className="model-setup-close" aria-label={zh ? '关闭配置模型' : 'Close model setup'} disabled={locked} onClick={c.close}>
            <XIcon size={16} aria-hidden="true" />
          </Button>
        </header>
        <div className="model-setup-body">
          {c.step === 'choose' ? (
            <div className="model-setup-options">
              {options
                .filter((option) => c.conversationTarget || option.provider === 'codex' || option.provider === 'custom')
                .map((option) => (
                  <Button
                    key={option.provider}
                    variant="secondary"
                    className="model-setup-provider-option"
                    data-provider={option.provider}
                    disabled={c.operation !== 'idle'}
                    onClick={() => {
                      setModelId('');
                      if (option.provider === 'codex' && !c.conversationTarget) return c.prepareCodex();
                      if (option.provider === 'custom') c.setCustomVisited(true);
                      c.setStep(option.provider);
                      if (option.provider === 'codex') return c.checkInstallation();
                    }}
                  >
                    <ModelProviderMark provider={option.provider} />
                    <span className="model-setup-option-copy">
                      <strong>{option.name}</strong>
                      <small>{option.detail}</small>
                    </span>
                    <CaretRightIcon className="model-setup-option-arrow" size={16} aria-hidden="true" />
                  </Button>
                ))}
            </div>
          ) : null}
          {c.step === 'copilot' ? (
            <div className="model-setup-subscription">
              <CopilotAccountSettings client={c.input.client} language={language} choosingModel={c.operation === 'activating'} onChooseModel={() => c.chooseSubscriptionModels('copilot')} />
            </div>
          ) : null}
          {c.step === 'antigravity' ? (
            <div className="model-setup-subscription">
              <AntigravityAccountSettings client={c.input.client} language={language} choosingModel={c.operation === 'activating'} onChooseModel={() => c.chooseSubscriptionModels('antigravity')} />
            </div>
          ) : null}
          {c.step === 'select_model' && selection ? (
            <section className="model-setup-select-model">
              <ModelProviderIdentity provider={selection.provider} name={subscriptionProviderNames[selection.provider]} connected>
                {zh ? '已连接' : 'Connected'}
              </ModelProviderIdentity>
              <ZeusSelect size="regular" value={selectedId} onChange={setModelId} ariaLabel={zh ? '选择模型' : 'Choose a model'} disabled={locked} options={modelOptions} />
            </section>
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
              {c.installingCodex ? (
                <ManagedCliProgress program="Codex CLI" zh={zh} {...c.updateProgress} />
              ) : c.conversationTarget && c.operation === 'idle' && c.installationCheck && !c.modelsPending ? null : (
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
                                ? '登录成功'
                                : 'Signed in'
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
              )}
              {!c.installingCodex && c.installationCheck ? (
                <CodexInstallationGuide
                  key={c.installationCheck.checkedAt}
                  zh={zh}
                  status={c.installationCheck}
                  busy={c.operation !== 'idle'}
                  compact={Boolean(c.conversationTarget)}
                  onInstall={c.installCodex}
                  onCheck={c.checkInstallation}
                  onOpenGuide={c.openInstallGuide}
                />
              ) : null}
              {c.installingCodex ? null : c.installationCheck?.available ? (
                <>
                  {c.conversationTarget && c.account?.signedIn && c.account.accountType === 'chatgpt' && !c.modelsPending ? (
                    <Button variant="primary" disabled={c.operation !== 'idle'} onClick={() => c.chooseSubscriptionModels('codex')}>
                      {zh ? '选择模型' : 'Choose a model'}
                    </Button>
                  ) : (
                    <Button
                      variant="primary"
                      disabled={c.operation !== 'idle'}
                      busy={c.operation === 'inspecting' || c.operation === 'authenticating' || c.operation === 'activating'}
                      onClick={() => (c.modelsPending ? c.retrySubscriptionModels() : c.prepareCodex())}
                    >
                      {c.modelsPending ? (zh ? '重试同步模型' : 'Retry model synchronization') : zh ? '登录 Codex 订阅' : 'Sign in with Codex subscription'}
                    </Button>
                  )}
                  {c.modelsPending ? (
                    <Button variant="secondary" disabled={c.operation !== 'idle'} onClick={() => c.prepareCodex()}>
                      {zh ? '重新登录' : 'Sign in again'}
                    </Button>
                  ) : null}
                  <Button variant="secondary" disabled={c.operation !== 'idle'} onClick={() => c.inspectConfig()}>
                    {zh ? '导入已有配置（可选）' : 'Import configuration (optional)'}
                  </Button>
                </>
              ) : !c.installationCheck ? (
                <Button variant="secondary" disabled={c.operation !== 'idle'} busy={c.operation === 'detecting'} onClick={() => c.checkInstallation()}>
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
                <Button disabled={c.operation !== 'idle'} busy={c.operation === 'importing'} onClick={() => c.importConfig()}>
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
        <footer className={c.step === 'choose' && !c.taskTarget ? 'model-setup-actions model-setup-actions-end' : 'model-setup-actions'}>
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
                ? '上一步'
                : 'Back'}
          </Button>
          {c.step === 'select_model' && selectedId ? (
            <Button variant="primary" disabled={locked} busy={c.operation === 'saving'} onClick={() => c.finish(selectedId).catch(() => undefined)}>
              {zh ? '使用此模型' : 'Use this model'}
            </Button>
          ) : null}
        </footer>
      </section>
    </ModalPortal>
  );
}
