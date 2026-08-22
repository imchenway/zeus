import type { ProjectRecord } from '../projects/projectContracts.js';
import type { TaskRecord } from '../tasks/taskContracts.js';

export interface DashboardSnapshot {
  app: 'Zeus';
  localServer: { host: '127.0.0.1'; port: number | null };
  projects: ProjectRecord[];
  tasks: TaskRecord[];
  conversationAttentionByProject: Record<string, ProjectConversationAttentionState>;
  conversationUnreadCountByProject: Record<string, number>;
  runtime: {
    aiCli: { available: boolean; reason: string };
    telegram: { enabled: boolean; reason: string };
  };
  git: {
    isRepository: boolean;
    branch: string;
    clean?: boolean;
    changedFiles: string[];
    conflictFiles?: string[];
    fileStatuses?: Array<{
      path: string;
      originalPath?: string;
      indexStatus: string;
      workingTreeStatus: string;
      category: string;
    }>;
    remoteBranches?: string[];
    recentCommits?: Array<{
      hash: string;
      shortHash: string;
      subject: string;
      author: string;
      authoredAt: string;
      parentHashes: string[];
    }>;
  };
  graph: { nodeCount: number; edgeCount: number; viewCount: number };
}

export type ProjectConversationAttentionState = 'idle' | 'running' | 'unread' | 'completed' | 'failed' | 'interrupted' | 'reply_required';
