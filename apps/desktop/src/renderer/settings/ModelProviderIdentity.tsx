import { useId, type ReactNode } from 'react';
import { PlugsConnectedIcon } from '@phosphor-icons/react/dist/csr/PlugsConnected';
import { compareModelOptions, type ModelOptionSource } from '../modelOptionPresentation.js';
import { ModelProviderBadge } from '../modelProviderAppearance.js';
import type { SubscriptionSetupProvider } from './useModelSetup.js';

/** 订阅账号和接入选项共用同一份品牌素材。 */
export function ModelProviderMark({ provider }: { provider: SubscriptionSetupProvider | 'custom' }): React.JSX.Element {
  return (
    <span className="model-provider-symbol" data-provider={provider} aria-hidden="true">
      {provider === 'custom' ? <PlugsConnectedIcon size={23} /> : null}
    </span>
  );
}

/** 统一订阅供应商的标识和当前账号状态，行内操作仍由各供应商提供。 */
export function ModelProviderIdentity({ provider, name, connected, busy, children }: { provider: SubscriptionSetupProvider; name: string; connected?: boolean; busy?: boolean; children: ReactNode }): React.JSX.Element {
  return (
    <header className="model-provider-identity" data-provider={provider}>
      <ModelProviderMark provider={provider} />
      <div className="model-provider-identity-copy">
        <strong>{name}</strong>
        <span className="account-sign-in-state" data-signed-in={connected || undefined} data-pending={busy || undefined} role="status">
          {children}
        </span>
      </div>
    </header>
  );
}

/** 订阅账号的只读模型目录，名称和排序与模型选择器一致。 */
export function ModelProviderAvailableModels({ provider, zh, models, message }: { provider: SubscriptionSetupProvider; zh: boolean; models: readonly ModelOptionSource[] | null; message: string }): React.JSX.Element {
  /** 标题与列表的关系在同一个窗口的多个账号卡片中保持唯一。 */
  const titleId = useId();
  /** 空目录与尚未完成读取分别显示零个模型和等待状态。 */
  const available = models?.filter((model) => model.available !== false).sort(compareModelOptions);
  return (
    <section className="codex-available-models" aria-labelledby={titleId}>
      <strong id={titleId}>
        {zh ? '当前可用模型' : 'Available models'}
        {available ? ` · ${available.length}` : ''}
      </strong>
      {available?.length ? (
        <ul>
          {available.map((model) => (
            <li key={model.id}>
              <span className="model-provider-labelled">
                <ModelProviderBadge sourceId={provider} />
                {model.displayName?.trim() || model.model}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <small role="status">{message}</small>
      )}
    </section>
  );
}
