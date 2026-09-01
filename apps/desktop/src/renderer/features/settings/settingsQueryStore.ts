import type { AppShellSettings } from '../../apiClient.js';
import type { SettingsApiClient } from './settingsApiClient.js';
import { errorMessage, ExternalStore } from '../../externalStore.js';

export type SettingsUpdater = AppShellSettings | ((current: AppShellSettings) => AppShellSettings);

export interface SettingsQuerySnapshot {
  value: AppShellSettings;
  loading: boolean;
  saving: boolean;
  error: string | null;
  revision: number;
}

export class SettingsQueryStore extends ExternalStore<SettingsQuerySnapshot> {
  constructor(
    private readonly client: SettingsApiClient | null,
    initialValue: AppShellSettings,
  ) {
    super({ value: initialValue, loading: false, saving: false, error: null, revision: 0 });
  }

  update(updater: SettingsUpdater): AppShellSettings {
    const value = typeof updater === 'function' ? updater(this.snapshot.value) : updater;
    if (value === this.snapshot.value) return value;
    this.publish({ ...this.snapshot, value, error: null, revision: this.snapshot.revision + 1 });
    return value;
  }

  async load(): Promise<AppShellSettings> {
    const client = this.requireClient();
    this.publish({ ...this.snapshot, loading: true, error: null });
    try {
      const value = await client.loadAppShellSettings();
      this.publish({ ...this.snapshot, value, loading: false, revision: this.snapshot.revision + 1 });
      return value;
    } catch (error) {
      this.publish({ ...this.snapshot, loading: false, error: errorMessage(error) });
      throw error;
    }
  }

  async save(input: Parameters<SettingsApiClient['saveAppShellSettings']>[0]): Promise<AppShellSettings> {
    const client = this.requireClient();
    this.publish({ ...this.snapshot, saving: true, error: null });
    try {
      const value = await client.saveAppShellSettings(input);
      this.publish({ ...this.snapshot, value, saving: false, revision: this.snapshot.revision + 1 });
      return value;
    } catch (error) {
      this.publish({ ...this.snapshot, saving: false, error: errorMessage(error) });
      throw error;
    }
  }

  private requireClient(): SettingsApiClient {
    if (!this.client) throw new Error('Settings API client is unavailable.');
    return this.client;
  }
}
