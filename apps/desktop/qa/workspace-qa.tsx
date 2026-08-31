import React, { useEffect, useState } from 'react';
import type { ConversationResourcePreview } from '@zeus/shared';
import { defaultSourceWorkspaceViewMode, SourceWorkspace } from '../src/renderer/session/SourceWorkspace.js';
import type { CodexTaskPushCapabilities } from '../src/renderer/session/sessionTypes.js';
import type { TaskRecord } from '../src/renderer/apiClient.js';
import { type TaskModelPushForm, TaskModelPushModal, type TaskModelPushModalStatus } from '../src/renderer/task/TaskModelPushModal.js';

const markdownSourcePreview: ConversationResourcePreview = {
  kind: 'source',
  resource: {
    id: 'resource-markdown-preview',
    projectId: 'project-zeus',
    conversationId: 'conversation-markdown-preview',
    turnId: 'turn-markdown-preview',
    itemId: 'item-markdown-preview',
    kind: 'file',
    presentation: 'inline',
    displayName: 'TASK_20260825_007_会话Markdown文件默认预览.md',
    projectRelativePath: 'docs/TASK_20260825_007_会话Markdown文件默认预览.md',
    iconKind: 'markdown',
    createdAt: '2026-08-25T00:00:00.000Z',
    updatedAt: '2026-08-25T00:00:00.000Z',
  },
  language: 'markdown',
  content: '# Markdown 默认预览\n\n从会话正文点击 Markdown 文件后，应直接看到渲染后的正文。\n\n## 验收点\n\n- 首次打开显示预览\n- 可以切换到源码\n- 再次打开恢复预览\n\n```ts\nconst mode = "preview";\n```',
  lineCount: 13,
  truncated: false,
};

const typescriptSourcePreview: ConversationResourcePreview = {
  kind: 'source',
  resource: {
    id: 'resource-typescript-preview',
    projectId: 'project-zeus',
    conversationId: 'conversation-markdown-preview',
    turnId: 'turn-markdown-preview',
    itemId: 'item-typescript-preview',
    kind: 'file',
    presentation: 'inline',
    displayName: 'SourceWorkspace.tsx',
    projectRelativePath: 'apps/desktop/src/renderer/session/SourceWorkspace.tsx',
    iconKind: 'typescript',
    createdAt: '2026-08-25T00:00:00.000Z',
    updatedAt: '2026-08-25T00:00:00.000Z',
  },
  language: 'typescript',
  content: 'export const defaultView = "source";\n',
  lineCount: 1,
  truncated: false,
};

export function SourcePreviewQaApp() {
  const [preview, setPreview] = useState<ConversationResourcePreview>(markdownSourcePreview);
  const [viewMode, setViewMode] = useState(() => defaultSourceWorkspaceViewMode(markdownSourcePreview));
  const [fullWidth, setFullWidth] = useState(false);

  function openPreview(nextPreview: ConversationResourcePreview): void {
    setPreview(nextPreview);
    setViewMode(defaultSourceWorkspaceViewMode(nextPreview));
  }

  return (
    <main className="macos-ai-app zeus-shell session-codex-parity-v1 qa-page qa-source-preview-page" data-theme="light" data-testid="source-preview-fixture">
      <header>
        <div>
          <p>2026-08-25 · 真实组件交互验收</p>
          <h1>会话 Markdown 文件默认预览</h1>
        </div>
        <nav className="qa-source-preview-actions" aria-label="资源打开入口">
          <button type="button" onClick={() => openPreview(markdownSourcePreview)}>
            打开 Markdown
          </button>
          <button type="button" onClick={() => openPreview(typescriptSourcePreview)}>
            打开 TypeScript
          </button>
        </nav>
      </header>
      <div className="qa-source-preview-workspace">
        <SourceWorkspace preview={preview} viewMode={viewMode} onViewModeChange={setViewMode} language="zh-CN" fullWidth={fullWidth} onFullWidthChange={setFullWidth} onClose={() => undefined} />
      </div>
    </main>
  );
}

const taskPushQaTask: TaskRecord = {
  id: 'task-zeus-0338',
  projectId: 'project-zeus',
  taskCode: 'ZEUS-0338',
  title: '会话的输出方式',
  taskType: 'optimization',
  description: '',
  optimizationCurrentState: '推送弹窗不能被无关的账户读取阻塞。',
  optimizationExpectedOutcome: 'Git 与 Worktree 读取独立收敛。',
  status: 'ready',
  tags: [],
};

const taskPushQaCapabilities: CodexTaskPushCapabilities = {
  generationId: 'provider-account-not-read',
  initializedAt: '2026-08-24T12:35:00.000Z',
  projectId: taskPushQaTask.projectId,
  taskId: taskPushQaTask.id,
  canonicalPrompt: 'ZEUS-0338 会话的输出方式',
  taskContextRevision: 'task-context-revision',
  parentContextRevision: 'task-context-revision',
  repositoryRevision: 'repository-revision',
  currentAttachmentOptions: [],
  currentConversationOptions: [],
  parentContextOptions: [],
  relatedContextOptions: [],
  preferredModel: 'connection-deepseek-v4-flash',
  models: [
    {
      id: 'connection-deepseek-v4-flash',
      model: 'deepseek-v4-flash',
      displayName: 'DeepSeek V4 Flash',
      agentKind: 'pi',
      sourceId: 'deepseek',
      sourceName: 'DeepSeek',
      available: true,
      supportedReasoningEfforts: ['high'],
      defaultReasoningEffort: 'high',
      serviceTiers: [],
    },
  ],
  codexAccount: {
    generationId: 'codex-unavailable',
    requiresOpenaiAuth: false,
    signedIn: false,
    accountType: null,
    planType: null,
  },
  repositories: [
    {
      id: 'repository-zeus',
      projectId: taskPushQaTask.projectId,
      name: 'zeus',
      relativePath: '.',
      localPath: '/Users/david/hypha/zeus',
      createdAt: '2026-08-24T00:00:00.000Z',
      updatedAt: '2026-08-24T00:00:00.000Z',
      branch: 'main',
      headSha: '79cfd91',
      clean: false,
      defaultRemoteName: 'origin',
      remoteRefreshStatus: 'not_requested',
      remoteRefreshError: null,
      sourceRefs: [
        {
          ref: 'refs/heads/main',
          label: 'main',
          kind: 'local',
          group: 'local',
          current: true,
        },
      ],
      suggestedBranchName: 'zeus/ZEUS-0338-01',
    },
  ],
  directWorkspace: {
    path: '/Users/david/hypha/zeus',
    activeWritableConversationCount: 0,
  },
  existingEnvironments: [],
  sharedWritablePaths: [],
  git: {
    primaryWorkspacePath: '/Users/david/hypha/zeus',
    primaryBranch: 'main',
    primaryHeadSha: '79cfd91',
    primaryClean: false,
    defaultRemoteName: 'origin',
    sourceRefs: [
      {
        ref: 'refs/heads/main',
        label: 'main',
        kind: 'local',
        group: 'local',
        current: true,
      },
    ],
    suggestedBranchName: 'zeus/ZEUS-0338-01',
    worktreeRoot: '/Users/david/hypha/.zeus-worktrees',
  },
};

const taskPushQaForm: TaskModelPushForm = {
  model: 'connection-deepseek-v4-flash',
  effort: 'high',
  serviceTier: { type: 'standard' },
  serviceTierDowngraded: false,
  workMode: 'default',
  permissionMode: 'auto',
  workspaceMode: 'worktree',
  taskBranchMode: 'create',
  environmentId: '',
  directConcurrencyConfirmed: false,
  repositorySelections: {
    'repository-zeus': {
      sourceRef: 'refs/heads/main',
      branchName: 'zeus/ZEUS-0338-01',
      includeLocalChanges: false,
    },
  },
  currentConversationIds: [],
  parentContextSelections: {},
  relatedContextSelections: {},
  supplementalInfo: '',
  supplementalAttachments: [],
};

export function TaskPushDecouplingApp() {
  const startReady = new URLSearchParams(window.location.search).has('ready');
  const [capabilities, setCapabilities] = useState<CodexTaskPushCapabilities | null>(() => (startReady ? taskPushQaCapabilities : null));
  const [status, setStatus] = useState<TaskModelPushModalStatus>(() => (startReady ? 'ready' : 'loading'));
  const [form, setForm] = useState<TaskModelPushForm>(taskPushQaForm);

  useEffect(() => {
    document.body.dataset.taskPushSubmitted = 'false';
    if (startReady) return;
    const timer = window.setTimeout(() => {
      setCapabilities(taskPushQaCapabilities);
      setStatus('ready');
    }, 2_500);
    return () => window.clearTimeout(timer);
  }, [startReady]);

  return (
    <main className="macos-ai-app zeus-shell qa-page" data-testid="task-push-decoupling-fixture">
      <p>账户 RPC 保持未完成时，Git 与 Worktree 表单仍必须独立完成加载。</p>
      <TaskModelPushModal
        open
        language="zh-CN"
        task={taskPushQaTask}
        projectName="Zeus"
        capabilities={capabilities}
        runtimeCapabilities={null}
        form={form}
        status={status}
        configImportPreview={null}
        configImportNeedsActivation={false}
        refreshingRepositoryId={null}
        error={null}
        onChange={setForm}
        onRefreshRepository={() => undefined}
        onClose={() => undefined}
        onCancelAuthentication={() => undefined}
        onCancelCodexConfigImport={() => undefined}
        onImportCodexConfig={() => undefined}
        onSkipCodexConfigImport={() => undefined}
        onSubmit={(event) => {
          event.preventDefault();
          document.body.dataset.taskPushSubmitted = 'true';
        }}
      />
    </main>
  );
}
