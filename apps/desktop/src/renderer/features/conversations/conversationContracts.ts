import type { NativeProjectConversationChoicesSnapshot, NativeConversationChoicesSnapshot } from '../../session/sessionTypes.js';

export interface NativeProjectConversationChoiceGroupsSnapshot {
  projectId: string;
  projectChoices: NativeProjectConversationChoicesSnapshot;
  taskChoicesByTaskId: Record<string, NativeConversationChoicesSnapshot>;
}
