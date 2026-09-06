import { userFacingErrorCause, type UserFacingErrorCause } from '@zeus/shared';
import type { AppShellSettings } from '../../apiClient.js';
import type { SettingsApiClient } from './settingsApiClient.js';
import { errorMessage, ExternalStore } from '../../externalStore.js';

export type SettingsUpdater = AppShellSettings | ((current: AppShellSettings) => AppShellSettings);

export interface SettingsQuerySnapshot {
  value: AppShellSettings;
  loading: boolean;
  saving: boolean;
  error: string | null;
  /** 可选底层原因供界面生成本地化提示，原错误字符串仍保留。 */
  errorCause?: UserFacingErrorCause | null;
  revision: number;
}

export class SettingsQueryStore extends ExternalStore<SettingsQuerySnapshot> {
  constructor(
    private readonly client: SettingsApiClient | null,
    initialValue: AppShellSettings,
  ) {
    super({ value: initialValue, loading: false, saving: false, error: null, errorCause: null, revision: 0 });
  }

  update(updater: SettingsUpdater): AppShellSettings {
    const value = typeof updater === 'function' ? updater(this.snapshot.value) : updater;
    if (value === this.snapshot.value) return value;
    this.publish({ ...this.snapshot, value, error: null, errorCause: null, revision: this.snapshot.revision + 1 });
    return value;
  }

  async load(): Promise<AppShellSettings> {
    const client = this.requireClient();
    this.publish({ ...this.snapshot, loading: true, error: null, errorCause: null });
    try {
      const value = await client.loadAppShellSettings();
      this.publish({ ...this.snapshot, value, loading: false, revision: this.snapshot.revision + 1 });
      return value;
    } catch (error) {
      this.publish({ ...this.snapshot, loading: false, error: errorMessage(error), errorCause: userFacingErrorCause(error) });
      throw error;
    }
  }

  async save(input: Parameters<SettingsApiClient['saveAppShellSettings']>[0]): Promise<AppShellSettings> {
    const client = this.requireClient();
    this.publish({ ...this.snapshot, saving: true, error: null, errorCause: null });
    try {
      const value = await client.saveAppShellSettings(input);
      this.publish({ ...this.snapshot, value, saving: false, revision: this.snapshot.revision + 1 });
      return value;
    } catch (error) {
      this.publish({ ...this.snapshot, saving: false, error: errorMessage(error), errorCause: userFacingErrorCause(error) });
      throw error;
    }
  }

  private requireClient(): SettingsApiClient {
    if (!this.client) throw new Error('Settings API client is unavailable.');
    return this.client;
  }
}
