import { existsSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLocalServer, zeusLocalServerHost } from '../src/index.js';

describe('Zeus local server', () => {
  it('exposes health and keeps the host limited to localhost', async () => {
    expect(zeusLocalServerHost).toBe('127.0.0.1');
    const dir = await mkdtemp(join(tmpdir(), 'zeus-server-'));
    try {
      const server = await createLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'test-token',
      });
      const response = await server.inject({ method: 'GET', url: '/health' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        ok: true,
        app: 'Zeus',
        host: '127.0.0.1',
        status: 'ok',
        appName: 'Zeus',
        version: '0.1.0',
        database: 'ok',
        runtime: 'ok',
      });
      await server.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports the Health API version from the real project package manifest instead of a hard-coded value', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-server-health-version-'));
    const projectRoot = join(dir, 'project-root');
    try {
      await mkdir(projectRoot, { recursive: true });
      await writeFile(join(projectRoot, 'package.json'), JSON.stringify({ name: 'zeus', version: '9.8.7-real' }), 'utf8');
      const server = await createLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'test-token',
        projectRoot,
      });
      const response = await server.inject({ method: 'GET', url: '/health' });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        appName: 'Zeus',
        version: '9.8.7-real',
        database: 'ok',
        runtime: 'ok',
      });
      await server.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('creates project and task records through token-protected APIs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-server-'));
    try {
      const server = await createLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'test-token',
      });
      const projectResponse = await server.inject({
        method: 'POST',
        url: '/api/projects',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          name: 'Zeus',
          localPath: '/Users/david/hypha/zeus',
          description: '真实当前仓库',
          note: '夜间巡检重点关注 release 门禁',
        },
      });
      expect(projectResponse.statusCode, projectResponse.body).toBe(201);
      const project = projectResponse.json();
      expect(project.name).toBe('Zeus');

      const taskResponse = await server.inject({
        method: 'POST',
        url: '/api/tasks',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          projectId: project.id,
          title: '分析当前项目结构',
          description: '扫描真实当前仓库并生成图谱',
          sourceContext: { path: '/Users/david/hypha/zeus' },
        },
      });
      expect(taskResponse.statusCode).toBe(201);
      expect(taskResponse.json()).toMatchObject({
        projectId: project.id,
        status: 'ready',
      });
      await server.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects project creation when the local path does not exist or is unreadable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-project-path-validation-'));
    try {
      const server = await createLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'test-token',
      });
      const response = await server.inject({
        method: 'POST',
        url: '/api/projects',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          name: 'Missing Project',
          localPath: join(dir, 'missing-project'),
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: 'ZEUS_INVALID_PROJECT_PATH',
      });
      expect(
        (
          await server.inject({
            method: 'GET',
            url: '/api/projects',
            headers: { authorization: 'Bearer test-token' },
          })
        ).json(),
      ).toEqual([]);
      await server.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('detects project language and dependency manifests from real files when creating a project', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-project-detect-config-'));
    const gitRoot = join(dir, 'git-root');
    const projectRoot = join(gitRoot, 'packages', 'real-project');
    try {
      await mkdir(join(gitRoot, '.git'), { recursive: true });
      await mkdir(projectRoot, { recursive: true });
      await writeFile(join(projectRoot, 'package.json'), JSON.stringify({ name: 'real-project', scripts: { build: 'tsc -b' } }), 'utf8');
      await writeFile(
        join(projectRoot, 'pnpm-workspace.yaml'),
        `packages:
  - apps/*
`,
        'utf8',
      );
      await writeFile(join(projectRoot, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true } }), 'utf8');
      const server = await createLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'test-token',
        projectRoot,
      });

      const projectResponse = await server.inject({
        method: 'POST',
        url: '/api/projects',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          name: 'Real TypeScript Project',
          localPath: projectRoot,
          description: '真实临时项目清单',
        },
      });
      expect(projectResponse.statusCode, projectResponse.body).toBe(201);
      const project = projectResponse.json();

      const configResponse = await server.inject({
        method: 'GET',
        url: `/api/projects/${project.id}/config`,
        headers: { authorization: 'Bearer test-token' },
      });
      expect(configResponse.statusCode).toBe(200);
      expect(configResponse.json()).toMatchObject({
        projectId: project.id,
        language: { primary: 'typescript', additional: ['javascript'] },
        dependencies: {
          packageManagers: ['pnpm'],
          manifestPaths: ['package.json', 'pnpm-workspace.yaml', 'tsconfig.json'],
        },
        vcs: { isGitRepository: true, gitRoot },
      });
      await server.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('loads and saves project configuration without creating fake project data', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-project-config-api-'));
    try {
      const server = await createLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'test-token',
      });
      const projectResponse = await server.inject({
        method: 'POST',
        url: '/api/projects',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          name: 'Zeus',
          localPath: '/Users/david/hypha/zeus',
          description: '真实当前仓库',
          defaultModel: 'gpt-5.1-codex',
          defaultWorkMode: 'develop',
          defaultTaskPrompt: '创建项目时写入默认任务提示词',
        },
      });
      const project = projectResponse.json();

      const defaultConfigResponse = await server.inject({
        method: 'GET',
        url: `/api/projects/${project.id}/config`,
        headers: { authorization: 'Bearer test-token' },
      });
      expect(defaultConfigResponse.statusCode).toBe(200);
      expect(defaultConfigResponse.json()).toMatchObject({
        projectId: project.id,
        defaultModel: 'gpt-5.1-codex',
        defaultWorkMode: 'develop',
        defaultTaskPrompt: '创建项目时写入默认任务提示词',
        scan: {
          ignoreDirectories: ['node_modules', 'dist', '.tmp', 'coverage'],
          indexScope: 'project',
        },
        language: { primary: 'typescript', additional: ['javascript'] },
        dependencies: {
          packageManagers: ['pnpm'],
          manifestPaths: ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'tsconfig.json'],
        },
        database: { connectionName: null, schemaPaths: [] },
        telegram: { alias: null },
        security: { allowShell: false, allowGitWrite: false },
      });

      const saveResponse = await server.inject({
        method: 'PUT',
        url: `/api/projects/${project.id}/config`,
        headers: { authorization: 'Bearer test-token' },
        payload: {
          defaultModel: 'gpt-5.1-codex',
          defaultWorkMode: 'develop',
          defaultTaskPrompt: '只基于真实代码和测试证据执行',
          scan: {
            ignoreDirectories: ['node_modules', 'dist'],
            indexScope: 'src',
          },
          language: { primary: 'typescript', additional: ['java'] },
          dependencies: {
            packageManagers: ['pnpm'],
            manifestPaths: ['package.json', 'pnpm-workspace.yaml'],
          },
          database: {
            connectionName: 'local-sqlite',
            schemaPaths: ['packages/storage/src/index.ts'],
          },
          telegram: { alias: 'zeus-local' },
          security: { allowShell: true, allowGitWrite: false },
        },
      });

      expect(saveResponse.statusCode).toBe(200);
      expect(saveResponse.json()).toMatchObject({
        projectId: project.id,
        defaultModel: 'gpt-5.1-codex',
        defaultWorkMode: 'develop',
        defaultTaskPrompt: '只基于真实代码和测试证据执行',
        scan: {
          ignoreDirectories: ['node_modules', 'dist'],
          indexScope: 'src',
        },
        language: { primary: 'typescript', additional: ['java'] },
        dependencies: {
          packageManagers: ['pnpm'],
          manifestPaths: ['package.json', 'pnpm-workspace.yaml'],
        },
        database: {
          connectionName: 'local-sqlite',
          schemaPaths: ['packages/storage/src/index.ts'],
        },
        telegram: { alias: 'zeus-local' },
        security: { allowShell: true, allowGitWrite: false },
      });

      const reloadedResponse = await server.inject({
        method: 'GET',
        url: `/api/projects/${project.id}/config`,
        headers: { authorization: 'Bearer test-token' },
      });
      expect(reloadedResponse.json()).toMatchObject(saveResponse.json());
      await server.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects project database connection URIs that include passwords before storing config', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-project-db-uri-secret-'));
    try {
      const server = await createLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'test-token',
      });
      const projectResponse = await server.inject({
        method: 'POST',
        url: '/api/projects',
        headers: { authorization: 'Bearer test-token' },
        payload: { name: 'Zeus', localPath: '/Users/david/hypha/zeus' },
      });
      const project = projectResponse.json();

      const rejectResponse = await server.inject({
        method: 'PUT',
        url: `/api/projects/${project.id}/config`,
        headers: { authorization: 'Bearer test-token' },
        payload: {
          database: {
            connectionName: 'postgresql://zeus:secret-password@localhost:5432/app',
            schemaPaths: [],
          },
        },
      });
      const reloadedResponse = await server.inject({
        method: 'GET',
        url: `/api/projects/${project.id}/config`,
        headers: { authorization: 'Bearer test-token' },
      });

      expect(rejectResponse.statusCode).toBe(400);
      expect(rejectResponse.json()).toMatchObject({
        error: 'ZEUS_DATABASE_CONNECTION_SECRET_IN_URI',
      });
      expect(rejectResponse.body).not.toContain('secret-password');
      expect(reloadedResponse.json().database.connectionName).toBeNull();
      await server.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects token-authenticated API requests from non-local web origins', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-server-origin-'));
    try {
      const server = await createLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'test-token',
      });
      const response = await server.inject({
        method: 'GET',
        url: '/api/projects',
        headers: {
          authorization: 'Bearer test-token',
          origin: 'https://evil.example',
        },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: 'ZEUS_FORBIDDEN_ORIGIN' });
      await server.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('allows local app dev origins and answers API preflight without exposing arbitrary origins', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-server-cors-'));
    try {
      const server = await createLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'test-token',
      });
      const preflight = await server.inject({
        method: 'OPTIONS',
        url: '/api/projects',
        headers: {
          origin: 'http://localhost:5173',
          'access-control-request-method': 'GET',
          'access-control-request-headers': 'authorization,content-type',
        },
      });

      expect(preflight.statusCode).toBe(204);
      expect(preflight.headers['access-control-allow-origin']).toBe('http://localhost:5173');
      expect(preflight.headers['access-control-allow-headers']).toContain('authorization');
      expect(preflight.headers['access-control-allow-methods']).toContain('GET');

      const response = await server.inject({
        method: 'GET',
        url: '/api/projects',
        headers: {
          authorization: 'Bearer test-token',
          origin: 'http://localhost:5173',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBe('http://localhost:5173');
      await server.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('archives a project and removes its tasks from active dashboard', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-project-archive-api-'));
    try {
      const server = await createLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'test-token',
      });
      const projectResponse = await server.inject({
        method: 'POST',
        url: '/api/projects',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          name: 'Zeus',
          localPath: '/Users/david/hypha/zeus',
          description: '真实当前仓库',
          note: '夜间巡检重点关注 release 门禁',
        },
      });
      const project = projectResponse.json();
      await server.inject({
        method: 'POST',
        url: '/api/tasks',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          projectId: project.id,
          title: '分析当前项目结构',
          description: '真实任务',
          sourceContext: { path: '/Users/david/hypha/zeus' },
        },
      });

      const archiveResponse = await server.inject({
        method: 'POST',
        url: `/api/projects/${project.id}/archive`,
        headers: { authorization: 'Bearer test-token' },
      });
      expect(archiveResponse.statusCode).toBe(200);
      expect(archiveResponse.json().id).toBe(project.id);

      const dashboardResponse = await server.inject({
        method: 'GET',
        url: '/api/dashboard',
        headers: { authorization: 'Bearer test-token' },
      });
      expect(dashboardResponse.json().projects).toHaveLength(0);
      expect(dashboardResponse.json().tasks).toHaveLength(0);

      const archivedResponse = await server.inject({
        method: 'GET',
        url: '/api/projects/archived',
        headers: { authorization: 'Bearer test-token' },
      });
      expect(archivedResponse.statusCode).toBe(200);
      expect(archivedResponse.json().map((item: { id: string }) => item.id)).toEqual([project.id]);

      const restoreResponse = await server.inject({
        method: 'POST',
        url: `/api/projects/${project.id}/restore`,
        headers: { authorization: 'Bearer test-token' },
      });
      expect(restoreResponse.statusCode).toBe(200);
      expect(restoreResponse.json().id).toBe(project.id);

      const restoredDashboardResponse = await server.inject({
        method: 'GET',
        url: '/api/dashboard',
        headers: { authorization: 'Bearer test-token' },
      });
      expect(restoredDashboardResponse.json().projects).toHaveLength(1);
      expect(restoredDashboardResponse.json().tasks).toHaveLength(1);
      await server.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reads, searches, updates, confirms archive, and deletes real projects through APIs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-project-management-api-'));
    try {
      const server = await createLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'test-token',
      });
      const projectResponse = await server.inject({
        method: 'POST',
        url: '/api/projects',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          name: 'Zeus',
          localPath: '/Users/david/hypha/zeus',
          description: '真实当前仓库',
          note: '夜间巡检重点关注 release 门禁',
        },
      });
      const project = projectResponse.json();
      const hermesPath = join(dir, 'hermes');
      await mkdir(hermesPath, { recursive: true });
      await server.inject({
        method: 'POST',
        url: '/api/projects',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          name: 'Hermes',
          localPath: hermesPath,
          description: '另一个真实仓库',
        },
      });

      const detailResponse = await server.inject({
        method: 'GET',
        url: `/api/projects/${project.id}`,
        headers: { authorization: 'Bearer test-token' },
      });
      const searchResponse = await server.inject({
        method: 'GET',
        url: '/api/projects?query=真实当前仓库',
        headers: { authorization: 'Bearer test-token' },
      });
      const updateResponse = await server.inject({
        method: 'PATCH',
        url: `/api/projects/${project.id}`,
        headers: { authorization: 'Bearer test-token' },
        payload: {
          name: 'Zeus Workbench',
          description: '本地优先工作台',
          note: '备注已更新为图谱验收入口',
        },
      });
      const invalidPathUpdateResponse = await server.inject({
        method: 'PATCH',
        url: `/api/projects/${project.id}`,
        headers: { authorization: 'Bearer test-token' },
        payload: { localPath: join(dir, 'missing-update-path') },
      });
      const afterInvalidPathUpdateResponse = await server.inject({
        method: 'GET',
        url: `/api/projects/${project.id}`,
        headers: { authorization: 'Bearer test-token' },
      });
      const confirmationResponse = await server.inject({
        method: 'POST',
        url: `/api/projects/${project.id}/archive-confirmation`,
        headers: { authorization: 'Bearer test-token' },
      });
      const deleteResponse = await server.inject({
        method: 'DELETE',
        url: `/api/projects/${project.id}`,
        headers: { authorization: 'Bearer test-token' },
      });
      const dashboardResponse = await server.inject({
        method: 'GET',
        url: '/api/dashboard',
        headers: { authorization: 'Bearer test-token' },
      });

      expect(detailResponse.statusCode).toBe(200);
      expect(detailResponse.json().note).toBe('夜间巡检重点关注 release 门禁');
      expect(searchResponse.json().map((item: { id: string }) => item.id)).toEqual([project.id]);
      expect(updateResponse.json().name).toBe('Zeus Workbench');
      expect(updateResponse.json().note).toBe('备注已更新为图谱验收入口');
      expect(invalidPathUpdateResponse.statusCode).toBe(400);
      expect(invalidPathUpdateResponse.json()).toMatchObject({
        error: 'ZEUS_INVALID_PROJECT_PATH',
      });
      expect(afterInvalidPathUpdateResponse.json().localPath).toBe('/Users/david/hypha/zeus');
      expect(confirmationResponse.json().confirmationText).toBe('确认归档项目 Zeus Workbench');
      expect(deleteResponse.statusCode).toBe(200);
      expect(dashboardResponse.json().projects.map((item: { name: string }) => item.name)).toEqual(['Hermes']);
      await server.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('persists app shell operations settings and clears local caches through token-protected APIs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-app-shell-api-'));
    try {
      const server = await createLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'test-token',
        projectRoot: '/Users/david/hypha/zeus',
        localConfigPath: join(dir, 'zeus.config.json'),
      });
      const projectResponse = await server.inject({
        method: 'POST',
        url: '/api/projects',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          name: 'Zeus',
          localPath: '/Users/david/hypha/zeus',
          description: '真实项目',
        },
      });
      const projectId = projectResponse.json().id;

      const initialResponse = await server.inject({
        method: 'GET',
        url: '/api/settings/app-shell',
        headers: { authorization: 'Bearer test-token' },
      });
      expect(initialResponse.statusCode).toBe(200);
      expect(initialResponse.json()).toMatchObject({
        appLanguage: 'zh-CN',
        appearance: 'system',
        webviewDebugEnabled: false,
        developerModeEnabled: false,
        multiWindowEnabled: true,
        backgroundModeEnabled: true,
        desktopNotificationsEnabled: true,
        openAtLoginEnabled: false,
        autoUpdateChannel: 'manual',
        defaultProjectId: null,
        defaultModel: null,
        defaultTaskTemplateId: null,
      });
      expect(initialResponse.json().localLogDirectory).toContain('logs');
      expect(initialResponse.json().localConfigPath).toBe(join(dir, 'zeus.config.json'));
      expect(JSON.stringify(initialResponse.json())).not.toContain('test-token');
      expect(existsSync(initialResponse.json().localLogDirectory)).toBe(true);
      expect(statSync(initialResponse.json().localLogDirectory).isDirectory()).toBe(true);
      expect(initialResponse.json().dataPortability).toMatchObject({
        importSupported: true,
        exportSupported: true,
        redactsSecrets: true,
      });

      const savedResponse = await server.inject({
        method: 'PUT',
        url: '/api/settings/app-shell',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          appLanguage: 'en-US',
          appearance: 'dark',
          webviewDebugEnabled: true,
          developerModeEnabled: true,
          backgroundModeEnabled: false,
          desktopNotificationsEnabled: false,
          openAtLoginEnabled: true,
          autoUpdateChannel: 'manual',
          defaultProjectId: projectId,
          defaultModel: 'gpt-5.1-codex',
          defaultTaskTemplateId: 'task_template_bug_fix',
        },
      });
      expect(savedResponse.statusCode).toBe(200);
      expect(savedResponse.json()).toMatchObject({
        appLanguage: 'en-US',
        appearance: 'dark',
        webviewDebugEnabled: true,
        developerModeEnabled: true,
        backgroundModeEnabled: false,
        desktopNotificationsEnabled: false,
        openAtLoginEnabled: true,
        defaultProjectId: projectId,
        defaultModel: 'gpt-5.1-codex',
        defaultTaskTemplateId: 'task_template_bug_fix',
      });

      const scanResponse = await server.inject({
        method: 'POST',
        url: '/api/graph/scan-current',
        headers: { authorization: 'Bearer test-token' },
      });
      expect(scanResponse.statusCode).toBe(200);
      expect(scanResponse.json().viewCount).toBeGreaterThan(0);
      const graphBeforeClearResponse = await server.inject({
        method: 'GET',
        url: '/api/graph/views/architecture',
        headers: { authorization: 'Bearer test-token' },
      });
      expect(graphBeforeClearResponse.statusCode).toBe(200);

      const clearResponse = await server.inject({
        method: 'POST',
        url: '/api/settings/cache/clear',
        headers: { authorization: 'Bearer test-token' },
      });
      expect(clearResponse.statusCode).toBe(200);
      expect(clearResponse.json()).toMatchObject({
        cleared: true,
        clearedCaches: ['code-index', 'graph-view', 'layout'],
      });
      const graphAfterClearResponse = await server.inject({
        method: 'GET',
        url: '/api/graph/views/architecture',
        headers: { authorization: 'Bearer test-token' },
      });
      expect(graphAfterClearResponse.statusCode).toBe(404);
      expect(graphAfterClearResponse.json().error).toBe('ZEUS_GRAPH_VIEW_NOT_FOUND');

      await server.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('exports redacted local settings and imports safe runtime, app, code map, and Telegram settings', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-data-portability-api-'));
    try {
      const server = await createLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'test-token',
        projectRoot: '/Users/david/hypha/zeus',
      });
      await server.inject({
        method: 'PUT',
        url: '/api/settings/app-shell',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          appearance: 'dark',
          webviewDebugEnabled: true,
          desktopNotificationsEnabled: false,
          openAtLoginEnabled: true,
        },
      });
      await server.inject({
        method: 'PUT',
        url: '/api/runtime/settings',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          defaultAdapterId: 'claude',
          adapterModels: { claude: 'claude-opus-4-1' },
          adapterDefaultArgs: { claude: ['--model', 'claude-opus-4-1'] },
          adapterCliPaths: { claude: '/usr/local/bin/claude' },
          terminalEnv: { ZEUS_MODE: 'local' },
          shell: { path: '/bin/zsh', login: true },
          concurrency: { maxPerProject: 2, maxGlobal: 4 },
          executionTimeoutSeconds: 7200,
          logRetentionDays: 30,
          autoConfirmationPolicy: 'low_risk_only',
        },
      });
      await server.inject({
        method: 'PUT',
        url: '/api/code-map/settings',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          defaultScanScope: 'src',
          defaultIgnoreDirectories: ['node_modules', 'dist'],
          maxCallChainDepth: 5,
          showLowConfidenceEdges: true,
          layoutAlgorithm: 'dagre',
          graphCacheStrategy: 'memory',
          tableRelationInference: 'name_only',
          aiSummaryEnabled: true,
          incrementalScanEnabled: true,
          performanceMonitoringEnabled: true,
          moduleFlowManualNotes: '只导入真实人工备注',
        },
      });
      await server.inject({
        method: 'PUT',
        url: '/api/telegram/notification-settings',
        headers: { authorization: 'Bearer test-token' },
        payload: { enabled: true, chatIds: [123456], silentMode: true },
      });
      await server.inject({
        method: 'PUT',
        url: '/api/telegram/security-settings',
        headers: { authorization: 'Bearer test-token' },
        payload: { allowedUserIds: [42, 77] },
      });

      const exportResponse = await server.inject({
        method: 'GET',
        url: '/api/settings/export',
        headers: { authorization: 'Bearer test-token' },
      });
      expect(exportResponse.statusCode).toBe(200);
      expect(exportResponse.json()).toMatchObject({
        app: 'Zeus',
        schemaVersion: 1,
        redaction: { secretsRedacted: true },
        settings: {
          appShell: {
            appearance: 'dark',
            webviewDebugEnabled: true,
            desktopNotificationsEnabled: false,
            openAtLoginEnabled: true,
          },
          runtime: {
            defaultAdapterId: 'claude',
            autoConfirmationPolicy: 'low_risk_only',
            concurrency: { maxPerProject: 2, maxGlobal: 4 },
          },
          codeMap: {
            graphCacheStrategy: 'memory',
            layoutAlgorithm: 'dagre',
            moduleFlowManualNotes: '只导入真实人工备注',
          },
          telegramNotification: {
            enabled: true,
            chatIds: [123456],
            silentMode: true,
          },
          telegramSecurity: { allowedUserIds: [42, 77] },
        },
      });
      expect(JSON.stringify(exportResponse.json())).not.toContain('telegram-token-real');

      const importResponse = await server.inject({
        method: 'POST',
        url: '/api/settings/import',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          schemaVersion: 1,
          settings: {
            appShell: {
              appearance: 'light',
              webviewDebugEnabled: false,
              multiWindowEnabled: false,
              backgroundModeEnabled: false,
              autoUpdateChannel: 'manual',
            },
            runtime: {
              defaultAdapterId: 'gemini',
              adapterModels: { gemini: 'gemini-2.5-pro' },
              adapterDefaultArgs: { gemini: ['--yolo'] },
              adapterCliPaths: { gemini: '/opt/homebrew/bin/gemini' },
              terminalEnv: { ZEUS_IMPORTED: '1' },
              shell: { path: '/bin/bash', login: false },
              concurrency: { maxPerProject: 1, maxGlobal: 3 },
              executionTimeoutSeconds: 3600,
              logRetentionDays: 14,
              autoConfirmationPolicy: 'never',
            },
            codeMap: {
              defaultScanScope: 'project',
              defaultIgnoreDirectories: ['node_modules'],
              maxCallChainDepth: 4,
              showLowConfidenceEdges: false,
              layoutAlgorithm: 'hierarchical',
              graphCacheStrategy: 'sqlite',
              tableRelationInference: 'foreign_key_and_name',
              aiSummaryEnabled: false,
              incrementalScanEnabled: false,
              performanceMonitoringEnabled: false,
              moduleFlowManualNotes: '导入后的真实备注',
            },
            telegramNotification: {
              enabled: false,
              chatIds: [987654],
              silentMode: false,
            },
            telegramSecurity: { allowedUserIds: [1001] },
          },
        },
      });
      expect(importResponse.statusCode).toBe(200);
      expect(importResponse.json()).toMatchObject({
        imported: true,
        importedSettings: ['app-shell', 'runtime', 'code-map', 'telegram-notification', 'telegram-security'],
      });

      const appShellResponse = await server.inject({
        method: 'GET',
        url: '/api/settings/app-shell',
        headers: { authorization: 'Bearer test-token' },
      });
      expect(appShellResponse.json()).toMatchObject({
        appearance: 'light',
        webviewDebugEnabled: false,
        multiWindowEnabled: false,
      });
      const runtimeResponse = await server.inject({
        method: 'GET',
        url: '/api/runtime/settings',
        headers: { authorization: 'Bearer test-token' },
      });
      expect(runtimeResponse.json()).toMatchObject({
        defaultAdapterId: 'gemini',
        terminalEnv: { ZEUS_IMPORTED: '1' },
        autoConfirmationPolicy: 'never',
      });
      const codeMapResponse = await server.inject({
        method: 'GET',
        url: '/api/code-map/settings',
        headers: { authorization: 'Bearer test-token' },
      });
      expect(codeMapResponse.json()).toMatchObject({
        graphCacheStrategy: 'sqlite',
        moduleFlowManualNotes: '导入后的真实备注',
      });
      const telegramNotificationResponse = await server.inject({
        method: 'GET',
        url: '/api/telegram/notification-settings',
        headers: { authorization: 'Bearer test-token' },
      });
      expect(telegramNotificationResponse.json()).toEqual({
        enabled: false,
        chatIds: [987654],
        silentMode: false,
      });
      const telegramSecurityResponse = await server.inject({
        method: 'GET',
        url: '/api/telegram/security-settings',
        headers: { authorization: 'Bearer test-token' },
      });
      expect(telegramSecurityResponse.json()).toEqual({
        allowedUserIds: [1001],
      });

      const auditResponse = await server.inject({
        method: 'GET',
        url: '/api/security/audit-logs',
        headers: { authorization: 'Bearer test-token' },
      });
      expect(auditResponse.json().map((entry: { action: string }) => entry.action)).toContain('settings.data_import.completed');
      await server.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('exports and imports redacted local business data snapshots without secrets', async () => {
    const sourceDir = await mkdtemp(join(tmpdir(), 'zeus-data-export-source-'));
    const targetDir = await mkdtemp(join(tmpdir(), 'zeus-data-export-target-'));
    try {
      const source = await createLocalServer({
        dbPath: join(sourceDir, 'zeus.db'),
        apiToken: 'test-token',
        projectRoot: '/Users/david/hypha/zeus',
      });
      const projectResponse = await source.inject({
        method: 'POST',
        url: '/api/projects',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          name: 'Zeus',
          localPath: '/Users/david/hypha/zeus',
          description: '真实当前仓库',
          note: '导出导入需要保留的本机备注',
        },
      });
      const project = projectResponse.json();
      const templateResponse = await source.inject({
        method: 'POST',
        url: '/api/task-templates',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          projectId: project.id,
          name: '真实迁移模板',
          description: '导入导出验证模板',
          promptTemplate: '分析 {{project_path}}',
          category: 'custom',
          defaultOptions: { allowCodeChanges: false },
        },
      });
      const template = templateResponse.json();
      const taskResponse = await source.inject({
        method: 'POST',
        url: '/api/tasks',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          projectId: project.id,
          title: '导出真实任务',
          description: '用于验证本地数据迁移',
          tags: ['portable'],
          sourceContext: {
            path: '/Users/david/hypha/zeus',
            templateId: template.id,
          },
        },
      });
      const task = taskResponse.json();
      await source.inject({
        method: 'PATCH',
        url: `/api/tasks/${task.id}/status`,
        headers: { authorization: 'Bearer test-token' },
        payload: { status: 'running' },
      });

      const exportResponse = await source.inject({
        method: 'GET',
        url: '/api/data/export',
        headers: { authorization: 'Bearer test-token' },
      });
      expect(exportResponse.statusCode).toBe(200);
      const snapshot = exportResponse.json();
      expect(snapshot).toMatchObject({
        app: 'Zeus',
        schemaVersion: 1,
        redaction: { secretsRedacted: true },
        data: {
          projects: [
            {
              id: project.id,
              name: 'Zeus',
              note: '导出导入需要保留的本机备注',
            },
          ],
          tasks: [{ id: task.id, projectId: project.id, title: '导出真实任务' }],
          taskTemplates: [{ id: template.id, projectId: project.id, builtIn: false }],
        },
      });
      expect(snapshot.data.taskEvents.some((event: { taskId: string; eventType: string }) => event.taskId === task.id && event.eventType === 'task.status.changed')).toBe(true);
      expect(JSON.stringify(snapshot)).not.toContain('telegram-token-real');
      await source.close();

      const target = await createLocalServer({
        dbPath: join(targetDir, 'zeus.db'),
        apiToken: 'test-token',
        projectRoot: '/Users/david/hypha/zeus',
      });
      const legacySnapshot = JSON.parse(JSON.stringify(snapshot));
      // 旧版导出快照没有项目备注字段，导入时必须按 null 处理，不能把 undefined 写入数据库。
      delete legacySnapshot.data.projects[0].note;
      const importResponse = await target.inject({
        method: 'POST',
        url: '/api/data/import',
        headers: { authorization: 'Bearer test-token' },
        payload: legacySnapshot,
      });
      expect(importResponse.statusCode).toBe(200);
      expect(importResponse.json()).toMatchObject({
        imported: true,
        importedCounts: { projects: 1, tasks: 1, taskTemplates: 1 },
      });
      const dashboardResponse = await target.inject({
        method: 'GET',
        url: '/api/dashboard',
        headers: { authorization: 'Bearer test-token' },
      });
      expect(dashboardResponse.json().projects.map((item: { id: string }) => item.id)).toContain(project.id);
      expect(dashboardResponse.json().projects.find((item: { id: string; note?: string | null }) => item.id === project.id)?.note).toBeNull();
      expect(dashboardResponse.json().tasks.map((item: { id: string }) => item.id)).toContain(task.id);
      const eventsResponse = await target.inject({
        method: 'GET',
        url: `/api/tasks/${task.id}/events`,
        headers: { authorization: 'Bearer test-token' },
      });
      expect(eventsResponse.json().map((event: { eventType: string }) => event.eventType)).toContain('task.status.changed');
      await target.close();
    } finally {
      await rm(sourceDir, { recursive: true, force: true });
      await rm(targetDir, { recursive: true, force: true });
    }
  });

  it('rejects local business data imports that would create projects with missing local paths', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-data-import-missing-path-'));
    try {
      const target = await createLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'test-token',
        projectRoot: '/Users/david/hypha/zeus',
      });
      const missingPath = join(dir, 'missing-project-path');
      const snapshot = {
        app: 'Zeus',
        schemaVersion: 1,
        exportedAt: '2026-06-15T00:00:00.000Z',
        redaction: { secretsRedacted: true },
        data: {
          projects: [
            {
              id: 'project_missing_path',
              name: 'Missing Path Project',
              slug: 'missing-path-project',
              localPath: missingPath,
              description: '不应导入不存在的本地路径',
              note: null,
              defaultTemplateId: null,
              scanStatus: 'idle',
              createdAt: '2026-06-15T00:00:00.000Z',
              updatedAt: '2026-06-15T00:00:00.000Z',
            },
          ],
          tasks: [
            {
              id: 'task_missing_path',
              projectId: 'project_missing_path',
              title: '不应被导入的任务',
              description: '项目路径不存在时任务也不能写入',
              status: 'ready',
              tags: [],
              templateId: null,
              createdFrom: 'manual',
              sourceContextJson: '{}',
              createdAt: '2026-06-15T00:00:00.000Z',
              updatedAt: '2026-06-15T00:00:00.000Z',
            },
          ],
          taskEvents: [],
          taskTemplates: [],
        },
      };

      const importResponse = await target.inject({
        method: 'POST',
        url: '/api/data/import',
        headers: { authorization: 'Bearer test-token' },
        payload: snapshot,
      });
      const dashboardResponse = await target.inject({
        method: 'GET',
        url: '/api/dashboard',
        headers: { authorization: 'Bearer test-token' },
      });

      expect(importResponse.statusCode).toBe(400);
      expect(importResponse.json()).toMatchObject({
        error: 'ZEUS_INVALID_DATA_IMPORT_PROJECT_PATH',
      });
      expect(JSON.stringify(importResponse.json())).not.toContain('test-token');
      expect(dashboardResponse.json().projects).toEqual([]);
      expect(dashboardResponse.json().tasks).toEqual([]);
      await target.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
