import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  MarkerType,
  useNodesState,
  useEdgesState,
  useReactFlow,
  type Connection,
  type Node,
  type NodeProps,
  type NodeTypes,
  type OnEdgesChange,
  type OnNodesChange,
  type Viewport,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { DigitalTeamEdge, DigitalTeamExecutionMode, DigitalTeamNode, DigitalTeamNodeType, DigitalTeamWorkflowDefinition, DigitalTeamWorkflowValidationIssue } from '@zeus/shared';
import { digitalTeamNodeTypes } from '@zeus/shared';
import { useEffect, type DragEvent as ReactDragEvent } from 'react';

/** 数字团队跨组件拖放使用的受限数据类型。 */
export const digitalTeamDragMime = 'application/x-zeus-digital-team-node';

/** 角色栏拖入画布时唯一允许传递的员工身份。 */
export type DigitalTeamDragPayload = { kind: 'employee'; employeeId: string };

/** 运行节点投影只影响外观，不写回模板定义。 */
export interface DigitalTeamCanvasRuntimeState {
  /** 当前尝试的真实状态。 */
  status: string;
  /** 当前尝试号。 */
  attempt?: number;
}

/** 画布对上层只暴露持久图变化和明确选择。 */
export interface WorkflowCanvasProps {
  /** 当前模板或冻结运行图。 */
  definition: DigitalTeamWorkflowDefinition;
  /** 项目员工姓名索引。 */
  employeeNames: ReadonlyMap<string, string>;
  /** 当前选中节点。 */
  selectedNodeId: string | null;
  /** 共享校验器产生的问题。 */
  issues: DigitalTeamWorkflowValidationIssue[];
  /** 运行时节点状态。 */
  runtimeStateByNodeId?: ReadonlyMap<string, DigitalTeamCanvasRuntimeState>;
  /** 运行图禁止结构修改。 */
  readOnly?: boolean;
  /** 更新可持久化图。 */
  onChange(definition: DigitalTeamWorkflowDefinition | ((current: DigitalTeamWorkflowDefinition) => DigitalTeamWorkflowDefinition)): void;
  /** 切换检查器选中节点。 */
  onSelectNode(nodeId: string | null): void;
  /** 在画布坐标创建节点。 */
  onAdd(payload: DigitalTeamDragPayload, position: { x: number; y: number }): void;
}

/** React Flow 仅附加展示数据，持久协议仍以共享 WorkflowDefinition 为准。 */
type CanvasNodeData = Record<string, unknown> & {
  workflowNode: DigitalTeamNode;
  employeeName: string | null;
  issues: string[];
  runtimeState: DigitalTeamCanvasRuntimeState | null;
};

/** React Flow 渲染节点保留业务节点的五种类型。 */
type CanvasNode = Node<CanvasNodeData, DigitalTeamNodeType>;

/** 五类节点共用稳定组件引用，避免实时状态更新时重建节点类型表。 */
const canvasNodeTypes: NodeTypes = Object.fromEntries(digitalTeamNodeTypes.map((type) => [type, WorkflowNodeCard])) as NodeTypes;

/** 人工确认职责的人类可读名称。 */
const approvalPurposeLabels = {
  plan_approval: '规划批准',
  final_acceptance: '最终验收',
} as const;

/** 画布与常用配置共用实际执行方式，不根据员工名称推断权限。 */
export const digitalTeamWorkModeLabels: Record<DigitalTeamExecutionMode, string> = {
  read_only: '只读分析',
  isolated_write: '修改代码',
  candidate_read_only: '验收代码',
};

/** 提供 React Flow 上下文，并让内部组件使用准确的屏幕到画布坐标换算。 */
export function WorkflowCanvas(props: WorkflowCanvasProps) {
  return (
    <ReactFlowProvider>
      <WorkflowCanvasSurface {...props} />
    </ReactFlowProvider>
  );
}

/** 承载真实拖放、移动、连线、删除和视口持久化。 */
function WorkflowCanvasSurface(props: WorkflowCanvasProps) {
  /** React Flow 官方坐标换算会包含当前平移与缩放。 */
  const { screenToFlowPosition } = useReactFlow<CanvasNode, DigitalTeamEdge>();
  /** 校验问题按节点建立索引，避免每张卡片重复扫描。 */
  const issuesByNodeId = new Map<string, string[]>();
  for (const issue of props.issues) {
    if (!issue.nodeId) continue;
    const current = issuesByNodeId.get(issue.nodeId) ?? [];
    current.push(issue.message);
    issuesByNodeId.set(issue.nodeId, current);
  }
  /** 当前业务图转换为 React Flow 的纯展示节点。 */
  const projectedNodes: CanvasNode[] = props.definition.nodes.map((node) => ({
    id: node.id,
    type: node.type,
    position: node.position,
    /** 当前模板节点均可删除；历史运行图由只读模式统一保护。 */
    deletable: true,
    selected: props.selectedNodeId === node.id,
    data: {
      workflowNode: node,
      employeeName: node.type === 'employee' ? (props.employeeNames.get(node.data.employeeId) ?? null) : null,
      issues: issuesByNodeId.get(node.id) ?? [],
      runtimeState: props.runtimeStateByNodeId?.get(node.id) ?? null,
    },
  }));

  /** 交互状态留在画布，测量与选择不能在上层重新投影时丢失。 */
  const [nodes, setNodes, applyNodesChange] = useNodesState<CanvasNode>(projectedNodes);
  /** 边的选择与删除复用 React Flow 原生状态更新。 */
  const [edges, setEdges, applyEdgesChange] = useEdgesState<DigitalTeamEdge>(props.definition.edges);

  useEffect(() => {
    setNodes((current) => {
      /** 身份索引保留测量结果，同时避免逐节点重复扫描。 */
      const byId = new Map(current.map((node) => [node.id, node]));
      return projectedNodes.map((node) => {
        /** 拖动尚未落盘时，上层选择或状态刷新不能把位置拉回旧坐标。 */
        const previous = byId.get(node.id);
        return { ...previous, ...node, position: previous?.dragging ? previous.position : node.position };
      });
    });
  }, [props.definition.nodes, props.employeeNames, props.selectedNodeId, props.issues, props.runtimeStateByNodeId]);

  useEffect(() => {
    setEdges((current) => {
      /** 边的选中状态仅留在画布，不进入模板。 */
      const byId = new Map(current.map((edge) => [edge.id, edge]));
      return props.definition.edges.map((edge) => ({ ...byId.get(edge.id), ...edge }));
    });
  }, [props.definition.edges]);

  /** 拖动每帧仅更新画布；删除才同步持久图和依赖。 */
  const handleNodesChange: OnNodesChange<CanvasNode> = (changes) => {
    applyNodesChange(changes);
    if (props.readOnly) return;
    /** 本批删除节点的身份集合。 */
    const removedIds = new Set(changes.filter((change) => change.type === 'remove').map((change) => change.id));
    /** 鼠标松开或键盘移动才回写坐标。 */
    const positions = new Map(changes.flatMap((change) => (change.type === 'position' && !change.dragging && change.position ? [[change.id, change.position] as const] : [])));
    if (removedIds.size === 0 && positions.size === 0) return;
    props.onChange((current) => ({
      ...current,
      nodes: current.nodes.filter((node) => !removedIds.has(node.id)).map((node) => (positions.has(node.id) ? { ...node, position: positions.get(node.id)! } : node)),
      edges: current.edges.filter((edge) => !removedIds.has(edge.source) && !removedIds.has(edge.target)),
    }));
    if (props.selectedNodeId && removedIds.has(props.selectedNodeId)) props.onSelectNode(null);
  };

  /** 保留边选中状态，使键盘删除有真实目标。 */
  const handleEdgesChange: OnEdgesChange<DigitalTeamEdge> = (changes) => {
    applyEdgesChange(changes);
    if (props.readOnly) return;
    /** 本批待删除的边。 */
    const removedIds = new Set(changes.filter((change) => change.type === 'remove').map((change) => change.id));
    if (removedIds.size === 0) return;
    props.onChange((current) => ({ ...current, edges: current.edges.filter((edge) => !removedIds.has(edge.id)) }));
  };

  /** 保存唯一且无环的轻量连线；完整门禁继续由共享校验器负责。 */
  const handleConnect = (connection: Connection): void => {
    if (props.readOnly || !connection.source || !connection.target || !isConnectionAllowed(props.definition, connection.source, connection.target)) return;
    /** 同一手势中的视口或节点变化不能覆盖新连线。 */
    const edge = { id: `edge_${crypto.randomUUID()}`, source: connection.source, target: connection.target };
    props.onChange((current) => (isConnectionAllowed(current, edge.source, edge.target) ? { ...current, edges: [...current.edges, edge] } : current));
  };

  /** 外部拖放仅接受角色栏写入的已知负载。 */
  const handleDrop = (event: ReactDragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    if (props.readOnly) return;
    const payload = parseDragPayload(event.dataTransfer.getData(digitalTeamDragMime));
    if (!payload) return;
    props.onAdd(payload, screenToFlowPosition({ x: event.clientX, y: event.clientY }));
  };

  /** 视口结束移动后保存，避免每帧写入上层状态。 */
  const handleMoveEnd = (_event: MouseEvent | TouchEvent | null, viewport: Viewport): void => {
    if (props.readOnly || (viewport.x === props.definition.viewport.x && viewport.y === props.definition.viewport.y && viewport.zoom === props.definition.viewport.zoom)) return;
    props.onChange((current) => ({ ...current, viewport }));
  };

  return (
    <div className="digital-team-flow-surface" onDragOver={(event) => event.preventDefault()} onDrop={handleDrop}>
      <ReactFlow<CanvasNode, DigitalTeamEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={canvasNodeTypes}
        defaultEdgeOptions={{ markerEnd: { type: MarkerType.ArrowClosed }, type: 'smoothstep' }}
        connectionRadius={24}
        connectOnClick
        defaultViewport={props.definition.viewport}
        minZoom={0.25}
        maxZoom={1.8}
        nodesDraggable={!props.readOnly}
        nodesConnectable={!props.readOnly}
        elementsSelectable
        deleteKeyCode={props.readOnly ? null : ['Backspace', 'Delete']}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onConnect={handleConnect}
        isValidConnection={(connection) => Boolean(connection.source && connection.target && isConnectionAllowed(props.definition, connection.source, connection.target))}
        onNodeClick={(_event, node) => props.onSelectNode(node.id)}
        onEdgeClick={() => props.onSelectNode(null)}
        onPaneClick={() => props.onSelectNode(null)}
        onMoveEnd={handleMoveEnd}
        aria-label={props.readOnly ? '数字团队运行图' : '数字团队流程编辑画布'}
        colorMode="system"
      >
        <Background gap={24} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}

/** 五类业务节点使用一致结构，并明确展示职责、错误和运行状态。 */
function WorkflowNodeCard(props: NodeProps<CanvasNode>) {
  /** 当前持久业务节点决定卡片类型与内容。 */
  const node = props.data.workflowNode;
  /** 员工节点始终显示权威数字员工名称，不显示历史节点标题副本。 */
  const displayTitle = node.type === 'employee' ? (props.data.employeeName ?? node.data.title) : node.data.title;
  /** 未分配角色使用原分工标题，内部身份不进入产品界面。 */
  const assignmentLabel = node.type === 'employee' && !props.data.employeeName ? (props.data.issues.length ? '员工不可用' : '待分配员工') : null;
  /** 工作方式来自当前模板或冻结运行中的真实配置，始终在卡片可见。 */
  const workModeLabel = node.type === 'employee' ? digitalTeamWorkModeLabels[node.data.executionMode] : null;
  /** 员工节点直接展示实际工作要求，用户能从连线读出协作分工。 */
  const detail =
    node.type === 'employee'
      ? node.data.instructions.trim() || '按任务目标与员工职责执行'
      : node.type === 'human_confirmation'
        ? approvalPurposeLabels[node.data.purpose]
        : node.type === 'code_integration'
          ? '合并候选'
          : node.type === 'start'
            ? '任务输入'
            : '流程完成';
  /** 当前状态同时提供文字与视觉标记，不依赖颜色表达。 */
  const runtimeLabel = props.data.runtimeState ? `${props.data.runtimeState.status}${props.data.runtimeState.attempt ? ` · 第 ${props.data.runtimeState.attempt} 次` : ''}` : null;
  return (
    <article className={`digital-team-node is-${node.type}${props.selected ? ' is-selected' : ''}${props.data.issues.length ? ' has-error' : ''}`} aria-label={`${displayTitle}，${workModeLabel ? `${workModeLabel}，` : ''}${detail}`}>
      {node.type !== 'start' ? <Handle type="target" position={Position.Left} isConnectable={props.isConnectable} aria-label="输入：连接上游节点" title="输入：从上游节点右侧拖到这里" /> : null}
      <span className="digital-team-node-kind">{nodeTypeLabel(node.type)}</span>
      <strong>{displayTitle}</strong>
      {workModeLabel ? <span className="digital-team-node-status">{workModeLabel}</span> : null}
      <small title={detail}>{detail}</small>
      {assignmentLabel ? <span className="digital-team-node-status">{assignmentLabel}</span> : null}
      {runtimeLabel ? <span className="digital-team-node-status">{runtimeLabel}</span> : null}
      {props.data.issues[0] ? <span className="digital-team-node-error">{props.data.issues[0]}</span> : null}
      {node.type !== 'end' ? <Handle type="source" position={Position.Right} isConnectable={props.isConnectable} aria-label="输出：连接下游节点" title="输出：拖到下游节点左侧" /> : null}
    </article>
  );
}

/** 将持久节点类型转换为短标签。 */
function nodeTypeLabel(type: DigitalTeamNodeType): string {
  if (type === 'start') return '开始';
  if (type === 'employee') return '员工';
  if (type === 'human_confirmation') return '人工确认';
  if (type === 'code_integration') return '代码集成';
  return '结束';
}

/** 解析拖放边界数据，拒绝页面外构造的未知节点类型与空员工身份。 */
function parseDragPayload(value: string): DigitalTeamDragPayload | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object') return null;
    if ('kind' in parsed && parsed.kind === 'employee' && 'employeeId' in parsed && typeof parsed.employeeId === 'string' && parsed.employeeId.trim()) return { kind: 'employee', employeeId: parsed.employeeId };
    return null;
  } catch {
    return null;
  }
}

/** 前端连线提示拒绝自环、重复边和新增环路。 */
export function isConnectionAllowed(definition: DigitalTeamWorkflowDefinition, source: string, target: string): boolean {
  /** 连接端点必须是现有员工分工。 */
  const sourceNode = definition.nodes.find((node) => node.id === source);
  /** 目标也必须是现有员工分工。 */
  const targetNode = definition.nodes.find((node) => node.id === target);
  if (!sourceNode || !targetNode || sourceNode.type !== 'employee' || targetNode.type !== 'employee') return false;
  if (source === target || definition.edges.some((edge) => edge.source === source && edge.target === target)) return false;
  const outgoing = new Map(definition.nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of definition.edges) outgoing.get(edge.source)?.push(edge.target);
  outgoing.get(source)?.push(target);
  const pending = [target];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const nodeId = pending.pop()!;
    if (nodeId === source) return false;
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);
    pending.push(...(outgoing.get(nodeId) ?? []));
  }
  return true;
}
