import type { NativeConversationChoice, NativeConversationChoicesSnapshot, NativeProjectConversationChoicesSnapshot } from '../../session/sessionTypes.js';
import type { ConversationApiClient } from './conversationApiClient.js';
import { errorMessage, ExternalStore } from '../../externalStore.js';

export interface ConversationQuerySnapshot {
  choicesByTask: Readonly<Record<string, NativeConversationChoicesSnapshot>>;
  choicesByProject: Readonly<Record<string, NativeProjectConversationChoicesSnapshot>>;
  archived: readonly NativeConversationChoice[];
  archivedLoadState: 'idle' | 'loading' | 'ready' | 'error';
  restoringConversationId: string | null;
  error: string | null;
  revision: number;
}

type RecordUpdater<T> = Readonly<Record<string, T>> | ((current: Readonly<Record<string, T>>) => Readonly<Record<string, T>>);

export class ConversationQueryStore extends ExternalStore<ConversationQuerySnapshot> {
  constructor(
    private readonly client: ConversationApiClient | null,
    initial: { taskChoices?: readonly NativeConversationChoicesSnapshot[]; projectChoices?: readonly NativeProjectConversationChoicesSnapshot[] },
  ) {
    super({
      choicesByTask: Object.fromEntries((initial.taskChoices ?? []).map((entry) => [entry.taskId, entry])),
      choicesByProject: Object.fromEntries((initial.projectChoices ?? []).map((entry) => [entry.projectId, entry])),
      archived: [],
      archivedLoadState: 'idle',
      restoringConversationId: null,
      error: null,
      revision: 0,
    });
  }

  updateTaskChoices(updater: RecordUpdater<NativeConversationChoicesSnapshot>): void {
    const choicesByTask = typeof updater === 'function' ? updater(this.snapshot.choicesByTask) : updater;
    this.publish({ ...this.snapshot, choicesByTask, revision: this.snapshot.revision + 1 });
  }

  updateProjectChoices(updater: RecordUpdater<NativeProjectConversationChoicesSnapshot>): void {
    const choicesByProject = typeof updater === 'function' ? updater(this.snapshot.choicesByProject) : updater;
    this.publish({ ...this.snapshot, choicesByProject, revision: this.snapshot.revision + 1 });
  }

  setArchived(items: readonly NativeConversationChoice[]): void {
    this.publish({ ...this.snapshot, archived: items, archivedLoadState: 'ready', error: null, revision: this.snapshot.revision + 1 });
  }

  setArchivedLoadState(archivedLoadState: ConversationQuerySnapshot['archivedLoadState']): void {
    this.publish({ ...this.snapshot, archivedLoadState });
  }

  setRestoringConversationId(restoringConversationId: string | null): void {
    this.publish({ ...this.snapshot, restoringConversationId });
  }

  async loadArchived(): Promise<readonly NativeConversationChoice[]> {
    const client = this.requireClient();
    this.publish({ ...this.snapshot, archivedLoadState: 'loading', error: null });
    try {
      const result = await client.loadArchivedConversations();
      this.setArchived(result.choices);
      return result.choices;
    } catch (error) {
      this.publish({ ...this.snapshot, archivedLoadState: 'error', error: errorMessage(error) });
      throw error;
    }
  }

  private requireClient(): ConversationApiClient {
    if (!this.client) throw new Error('Conversation API client is unavailable.');
    return this.client;
  }
}
