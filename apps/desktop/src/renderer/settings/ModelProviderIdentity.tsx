import type { ReactNode } from 'react';
import { PlugsConnectedIcon } from '@phosphor-icons/react/dist/csr/PlugsConnected';
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
