import type { CodexRemoteControlPairing, CodexRemoteControlSnapshot } from '../../apiClient.js';
import type { RemoteControlApiClient } from './remoteControlApiClient.js';
import { errorMessage, ExternalStore } from '../../externalStore.js';

export interface RemoteControlQuerySnapshot {
  phase: 'idle' | 'loading' | 'ready' | 'error';
  value: CodexRemoteControlSnapshot | null;
  pairing: CodexRemoteControlPairing | null;
  command: 'idle' | 'enabling' | 'disabling' | 'pairing' | 'revoking';
  message: string | null;
  error: string | null;
}

const initialSnapshot: RemoteControlQuerySnapshot = {
  phase: 'idle',
  value: null,
  pairing: null,
  command: 'idle',
  message: null,
  error: null,
};

/** Remote Control 的唯一 Renderer projection；轮询和命令不进入 App 全局 state。 */
export class RemoteControlQueryStore extends ExternalStore<RemoteControlQuerySnapshot> {
  private generation = 0;

  constructor(private readonly client: RemoteControlApiClient) {
    super(initialSnapshot);
  }

  async load(): Promise<void> {
    const generation = ++this.generation;
    this.publish({ ...this.snapshot, phase: 'loading', error: null });
    try {
      const value = await this.client.loadCodexRemoteControl();
      if (generation !== this.generation) return;
      this.publish({ ...this.snapshot, phase: 'ready', value, error: null });
    } catch (error) {
      if (generation !== this.generation) return;
      this.publish({ ...this.snapshot, phase: 'error', error: errorMessage(error) });
    }
  }

  enable(): Promise<void> {
    return this.run('enabling', () => this.client.enableCodexRemoteControl());
  }

  disable(): Promise<void> {
    return this.run('disabling', () => this.client.disableCodexRemoteControl());
  }

  async startPairing(): Promise<void> {
    if (this.snapshot.command !== 'idle') return;
    this.publish({ ...this.snapshot, command: 'pairing', message: null, error: null });
    try {
      let value = this.snapshot.value;
      if (!value?.enabled || value.status.status === 'disabled') value = await this.client.enableCodexRemoteControl();
      const pairing = await this.client.startCodexRemoteControlPairing();
      this.publish({ ...this.snapshot, phase: 'ready', value, pairing, command: 'idle' });
    } catch (error) {
      this.publish({ ...this.snapshot, command: 'idle', error: errorMessage(error) });
    }
  }

  async refreshPairing(claimedMessage: string): Promise<boolean> {
    const pairing = this.snapshot.pairing;
    if (!pairing || pairing.claimed) return false;
    try {
      const result = await this.client.loadCodexRemoteControlPairingStatus({ pairingCode: pairing.pairingCode });
      if (!result.claimed || this.snapshot.pairing?.pairingCode !== pairing.pairingCode) return false;
      const value = await this.client.loadCodexRemoteControl();
      this.publish({ ...this.snapshot, phase: 'ready', value, pairing: { ...pairing, claimed: true }, message: claimedMessage });
      return true;
    } catch {
      return false;
    }
  }

  revoke(environmentId: string, clientId: string): Promise<void> {
    return this.run('revoking', () => this.client.revokeCodexRemoteControlClient(environmentId, clientId));
  }

  setMessage(message: string | null): void {
    this.publish({ ...this.snapshot, message });
  }

  private async run(command: Exclude<RemoteControlQuerySnapshot['command'], 'idle'>, operation: () => Promise<CodexRemoteControlSnapshot>): Promise<void> {
    if (this.snapshot.command !== 'idle') return;
    this.publish({ ...this.snapshot, command, message: null, error: null });
    try {
      const value = await operation();
      this.publish({ ...this.snapshot, phase: 'ready', value, command: 'idle' });
    } catch (error) {
      this.publish({ ...this.snapshot, phase: 'error', command: 'idle', error: errorMessage(error) });
    }
  }
}
