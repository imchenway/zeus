import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLocalServer } from '../src/index';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'zeus-graph-node-task-api-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('graph node task API', () => {
  it('creates and links tasks through the project-scoped graph task APIs', async () => {
    const server = await createLocalServer({
      dbPath: join(tempDir, 'zeus.db'),
      apiToken: 'token',
      projectRoot: '/Users/david/hypha/zeus',
    });
    const projectResponse = await server.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { authorization: 'Bearer token' },
      payload: { name: 'Zeus', localPath: '/Users/david/hypha/zeus' },
    });
    const projectId = projectResponse.json().id;
    await server.inject({
      method: 'POST',
      url: '/api/graph/scan-current',
      headers: { authorization: 'Bearer token' },
    });
    const graphView = await server.inject({
      method: 'GET',
      url: '/api/graph/views/architecture',
      headers: { authorization: 'Bearer token' },
    });
    const view = graphView.json();
    const node = view.nodes[0];

    const nodeTaskResponse = await server.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/graph/nodes/${node.id}/create-task`,
      headers: { authorization: 'Bearer token' },
      payload: { intent: '按项目级图谱节点创建任务' },
    });
    const viewTaskResponse = await server.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/graph/views/${view.viewType}/create-task`,
      headers: { authorization: 'Bearer token' },
      payload: { intent: '按项目级图谱视图创建任务' },
    });
    const manualTask = await server.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: { authorization: 'Bearer token' },
      payload: {
        projectId,
        title: '手动图谱关联任务',
        description: '后续关联一个真实图谱节点',
      },
    });
    const linkResponse = await server.inject({
      method: 'POST',
      url: `/api/tasks/${manualTask.json().id}/link-graph-node`,
      headers: { authorization: 'Bearer token' },
      payload: { nodeId: node.id, reason: '把手动任务绑定到真实图谱节点' },
    });

    expect(nodeTaskResponse.statusCode).toBe(201);
    const nodeTask = nodeTaskResponse.json();
    expect(nodeTask.projectId).toBe(projectId);
    expect(nodeTask.createdFrom).toBe('graph_node');
    expect(JSON.parse(nodeTask.sourceContextJson).graphNode).toMatchObject({
      id: node.id,
      sourceRef: node.sourceRef,
    });

    expect(viewTaskResponse.statusCode).toBe(201);
    const viewTask = viewTaskResponse.json();
    const viewContext = JSON.parse(viewTask.sourceContextJson);
    expect(viewTask.projectId).toBe(projectId);
    expect(viewTask.createdFrom).toBe('graph_view');
    expect(viewContext.graphView).toMatchObject({
      viewType: view.viewType,
      title: view.title,
    });
    expect(viewContext.sourceNodes.length).toBeGreaterThan(0);

    expect(linkResponse.statusCode).toBe(200);
    const linkedTask = linkResponse.json();
    const linkedContext = JSON.parse(linkedTask.sourceContextJson);
    expect(linkedContext.linkedGraphNodes).toEqual([
      expect.objectContaining({
        id: node.id,
        sourceRef: node.sourceRef,
        reason: '把手动任务绑定到真实图谱节点',
      }),
    ]);
    const events = await server.inject({
      method: 'GET',
      url: `/api/tasks/${linkedTask.id}/events`,
      headers: { authorization: 'Bearer token' },
    });
    expect(events.json().map((event: { eventType: string }) => event.eventType)).toContain('task.linked_graph_node');
    await server.close();
  });

  it('creates a real task from a sourced graph node', async () => {
    const server = await createLocalServer({
      dbPath: join(tempDir, 'zeus.db'),
      apiToken: 'token',
      projectRoot: '/Users/david/hypha/zeus',
    });
    const projectResponse = await server.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { authorization: 'Bearer token' },
      payload: { name: 'Zeus', localPath: '/Users/david/hypha/zeus' },
    });
    const projectId = projectResponse.json().id;
    await server.inject({
      method: 'POST',
      url: '/api/graph/scan-current',
      headers: { authorization: 'Bearer token' },
    });
    const graphView = await server.inject({
      method: 'GET',
      url: '/api/graph/views/architecture',
      headers: { authorization: 'Bearer token' },
    });
    const node = graphView.json().nodes[0];

    const response = await server.inject({
      method: 'POST',
      url: `/api/graph/nodes/${node.id}/tasks`,
      headers: { authorization: 'Bearer token' },
      payload: { projectId, intent: '分析该节点的实现风险' },
    });

    expect(response.statusCode).toBe(201);
    const task = response.json();
    expect(task.projectId).toBe(projectId);
    expect(task.createdFrom).toBe('graph_node');
    expect(task.title).toContain(node.name);
    const context = JSON.parse(task.sourceContextJson);
    expect(context.graphNode).toMatchObject({
      id: node.id,
      sourceRef: node.sourceRef,
      nodeType: node.nodeType,
    });
    expect(context.suggestedTestScope).toEqual(expect.arrayContaining([node.sourceRef]));
    expect(Array.isArray(context.relatedEdges)).toBe(true);
    await server.close();
  });

  it('creates a real task from a memory cached graph node without SQLite graph facts', async () => {
    const server = await createLocalServer({
      dbPath: join(tempDir, 'zeus.db'),
      apiToken: 'token',
      projectRoot: '/Users/david/hypha/zeus',
    });
    const projectResponse = await server.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { authorization: 'Bearer token' },
      payload: { name: 'Zeus', localPath: '/Users/david/hypha/zeus' },
    });
    const projectId = projectResponse.json().id;
    await server.inject({
      method: 'PUT',
      url: '/api/code-map/settings',
      headers: { authorization: 'Bearer token' },
      payload: {
        defaultScanScope: 'project',
        defaultIgnoreDirectories: ['node_modules', 'dist', '.tmp', 'coverage'],
        maxCallChainDepth: 3,
        showLowConfidenceEdges: false,
        layoutAlgorithm: 'hierarchical',
        graphCacheStrategy: 'memory',
        tableRelationInference: 'foreign_key_and_name',
        aiSummaryEnabled: false,
        incrementalScanEnabled: true,
        performanceMonitoringEnabled: false,
      },
    });
    await server.inject({
      method: 'POST',
      url: '/api/graph/scan-current',
      headers: { authorization: 'Bearer token' },
    });
    const graphView = await server.inject({
      method: 'GET',
      url: '/api/graph/views/architecture',
      headers: { authorization: 'Bearer token' },
    });
    const node = graphView.json().nodes[0];

    const response = await server.inject({
      method: 'POST',
      url: `/api/graph/nodes/${node.id}/tasks`,
      headers: { authorization: 'Bearer token' },
      payload: { projectId, intent: '分析 memory 图节点的实现风险' },
    });

    expect(response.statusCode).toBe(201);
    const task = response.json();
    const context = JSON.parse(task.sourceContextJson);
    expect(context.graphNode).toMatchObject({
      id: node.id,
      sourceRef: node.sourceRef,
      nodeType: node.nodeType,
    });
    expect(context.suggestedTestScope).toEqual(expect.arrayContaining([node.sourceRef]));
    expect(Array.isArray(context.relatedEdges)).toBe(true);
    await server.close();
  });
});
