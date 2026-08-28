import type { ProjectApiClient } from './projectApiClient.js';
import type { ProjectRecord } from '../../apiClient.js';

export interface ProjectQuerySnapshot {
  items: readonly ProjectRecord[];
  selectedProjectId: string | null;
  loading: boolean;
  error: string | null;
  revision: number;
}

export class ProjectQueryStore {
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): ProjectQuerySnapshot => this.snapshot;

  private readonly listeners = new Set<() => void>();
  private snapshot: ProjectQuerySnapshot;

  constructor(
    private readonly client: ProjectApiClient | null,
    initialItems: readonly ProjectRecord[],
  ) {
    this.snapshot = { items: initialItems, selectedProjectId: initialItems[0]?.id ?? null, loading: false, error: null, revision: 0 };
  }

  replace(items: readonly ProjectRecord[]): void {
    if (items === this.snapshot.items) return;
    const selectedProjectId = this.snapshot.selectedProjectId && items.some((item) => item.id === this.snapshot.selectedProjectId) ? this.snapshot.selectedProjectId : (items[0]?.id ?? null);
    this.publish({ ...this.snapshot, items, selectedProjectId, error: null, revision: this.snapshot.revision + 1 });
  }

  select(projectId: string | null): void {
    if (projectId === this.snapshot.selectedProjectId) return;
    this.publish({ ...this.snapshot, selectedProjectId: projectId });
  }

  async load(query?: string): Promise<readonly ProjectRecord[]> {
    const client = this.requireClient();
    this.publish({ ...this.snapshot, loading: true, error: null });
    try {
      const items = await client.loadProjects(query ? { query } : undefined);
      this.replace(items);
      this.publish({ ...this.snapshot, loading: false });
      return items;
    } catch (error) {
      this.publish({ ...this.snapshot, loading: false, error: messageFrom(error) });
      throw error;
    }
  }

  async loadOne(projectId: string): Promise<ProjectRecord> {
    const project = await this.requireClient().loadProject(projectId);
    this.upsert(project);
    return project;
  }

  upsert(project: ProjectRecord): void {
    const items = this.snapshot.items.some((item) => item.id === project.id) ? this.snapshot.items.map((item) => (item.id === project.id ? project : item)) : [...this.snapshot.items, project];
    this.replace(items);
  }

  remove(projectId: string): void {
    this.replace(this.snapshot.items.filter((item) => item.id !== projectId));
  }

  private requireClient(): ProjectApiClient {
    if (!this.client) throw new Error('Project API client is unavailable.');
    return this.client;
  }

  private publish(snapshot: ProjectQuerySnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
