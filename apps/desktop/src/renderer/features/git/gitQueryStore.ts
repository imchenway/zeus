import type { GitDiffSummary, GitOperationConfirmation } from '../../apiClient.js';
import type { GitApiClient } from './gitApiClient.js';

export interface GitQuerySnapshot {
  diff: GitDiffSummary | undefined;
  hunkDecisions: Readonly<Record<string, 'accepted' | 'rejected'>>;
  patchExportStatus: string;
  confirmation: GitOperationConfirmation | undefined;
  operationStatus: string;
  commitMessage: string;
  branchName: string;
  switchBranchName: string;
  baseRef: string;
  stashRef: string;
  remote: string;
  targetRef: string;
  rollbackRef: string;
  loading: boolean;
  error: string | null;
  revision: number;
}

export type GitQueryFieldUpdater<Key extends keyof GitQuerySnapshot> = GitQuerySnapshot[Key] | ((current: GitQuerySnapshot[Key]) => GitQuerySnapshot[Key]);

export class GitQueryStore {
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): GitQuerySnapshot => this.snapshot;

  private readonly listeners = new Set<() => void>();
  private snapshot: GitQuerySnapshot;

  constructor(
    private readonly client: GitApiClient | null,
    initial: Pick<GitQuerySnapshot, 'diff' | 'confirmation' | 'patchExportStatus' | 'operationStatus'>,
  ) {
    this.snapshot = {
      ...initial,
      hunkDecisions: {},
      commitMessage: '',
      branchName: '',
      switchBranchName: '',
      baseRef: '',
      stashRef: 'stash@{0}',
      remote: 'origin',
      targetRef: 'main',
      rollbackRef: 'HEAD',
      loading: false,
      error: null,
      revision: 0,
    };
  }

  set<Key extends keyof GitQuerySnapshot>(key: Key, updater: GitQueryFieldUpdater<Key>): void {
    const value = typeof updater === 'function' ? (updater as (current: GitQuerySnapshot[Key]) => GitQuerySnapshot[Key])(this.snapshot[key]) : updater;
    if (Object.is(value, this.snapshot[key])) return;
    this.publish({ ...this.snapshot, [key]: value, revision: this.snapshot.revision + 1 });
  }

  async loadDiff(): Promise<GitDiffSummary> {
    const client = this.requireClient();
    this.publish({ ...this.snapshot, loading: true, error: null });
    try {
      const diff = await client.loadGitDiff();
      this.publish({ ...this.snapshot, diff, loading: false, revision: this.snapshot.revision + 1 });
      return diff;
    } catch (error) {
      this.publish({ ...this.snapshot, loading: false, error: messageFrom(error) });
      throw error;
    }
  }

  private requireClient(): GitApiClient {
    if (!this.client) throw new Error('Git API client is unavailable.');
    return this.client;
  }

  private publish(snapshot: GitQuerySnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
