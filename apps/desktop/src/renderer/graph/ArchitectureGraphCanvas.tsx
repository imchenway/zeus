import { type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { CubeIcon as Cube } from '@phosphor-icons/react/dist/csr/Cube';
import type { GraphViewSnapshot } from '../apiClient.js';

type ArchitectureNode = GraphViewSnapshot['nodes'][number];
type ArchitectureEdge = GraphViewSnapshot['edges'][number];

export type ArchitectureWorkload = {
  module: ArchitectureNode | null;
  application: ArchitectureNode | null;
  primaryNode: ArchitectureNode;
  label: string;
};

export type ArchitectureLayerModel = {
  projectName: string;
  workloads: ArchitectureWorkload[];
  sharedModules: ArchitectureNode[];
  foundationModules: ArchitectureNode[];
  dependencyEdges: ArchitectureEdge[];
  businessDependencyEdges: ArchitectureEdge[];
  foundationDependencyEdges: ArchitectureEdge[];
  objectCount: number;
};

type ArchitectureGraphCanvasProps = {
  model: ArchitectureLayerModel;
  appLanguage: 'zh-CN' | 'en-US';
  zoom: number;
  controls: ReactNode;
  currentNodeId?: string | null;
  currentEdgeId?: string | null;
  onSelectNode?: (nodeId: string) => void;
  onSelectEdge?: (edgeId: string) => void;
  onClearSelection?: () => void;
  onOpenGraphSource?: (source: { sourceRef: string; lineStart?: number }) => void;
};

const sharedModulePattern = /(?:^|[-_.])(api|sdk|contract|client|facade|interface|model|dto)(?:$|[-_.])/iu;
const foundationModulePattern = /(?:^|[-_.])(common|foundation|infrastructure|infra|framework|starter|platform|kernel)(?:$|[-_.])/iu;

export function buildArchitectureLayerModel(nodes: Array<ArchitectureNode>, edges: Array<ArchitectureEdge>, title = ''): ArchitectureLayerModel {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const moduleNodes = nodes.filter((node) => isArchitectureModule(node));
  const applicationNodes = nodes.filter((node) => node.metadata.stereotype === 'spring_boot_application');
  const containsEdges = edges.filter((edge) => edge.edgeType === 'contains');
  const dependencyEdges = edges.filter((edge) => edge.edgeType === 'module_depends_on');
  const moduleIds = new Set(moduleNodes.map((node) => node.id));
  const moduleContainsEdges = containsEdges.filter((edge) => moduleIds.has(edge.sourceNodeId) && moduleIds.has(edge.targetNodeId));
  const applicationByOwnerId = new Map<string, ArchitectureNode>();

  for (const edge of containsEdges) {
    const target = nodesById.get(edge.targetNodeId);
    if (!target || target.metadata.stereotype !== 'spring_boot_application' || !moduleIds.has(edge.sourceNodeId)) continue;
    applicationByOwnerId.set(edge.sourceNodeId, target);
  }

  const workloadModuleIds = new Set(applicationByOwnerId.keys());
  const workloads = moduleNodes
    .filter((node) => workloadModuleIds.has(node.id))
    .map((module): ArchitectureWorkload => {
      const application = applicationByOwnerId.get(module.id) ?? null;
      return {
        module,
        application,
        primaryNode: application ?? module,
        label: formatArchitectureWorkloadLabel(module.name, application?.name),
      };
    });

  const ownedApplicationIds = new Set(workloads.flatMap((workload) => (workload.application ? [workload.application.id] : [])));
  for (const application of applicationNodes) {
    if (ownedApplicationIds.has(application.id)) continue;
    workloads.push({
      module: null,
      application,
      primaryNode: application,
      label: formatArchitectureWorkloadLabel('', application.name),
    });
  }
  workloads.sort((left, right) => left.label.localeCompare(right.label, 'en'));

  const aggregatorModuleIds = new Set(moduleContainsEdges.map((edge) => edge.sourceNodeId));
  const incomingModuleIds = new Set(moduleContainsEdges.map((edge) => edge.targetNodeId));
  const rootModule = moduleNodes.find((node) => aggregatorModuleIds.has(node.id) && !incomingModuleIds.has(node.id)) ?? moduleNodes.find((node) => !incomingModuleIds.has(node.id)) ?? null;
  const candidateLeafModules = moduleNodes.filter((node) => node.id !== rootModule?.id && !aggregatorModuleIds.has(node.id) && !workloadModuleIds.has(node.id));
  const foundationModules = candidateLeafModules.filter((node) => foundationModulePattern.test(node.name));
  const foundationModuleIds = new Set(foundationModules.map((node) => node.id));
  const sharedModules = candidateLeafModules.filter((node) => !foundationModuleIds.has(node.id) && (sharedModulePattern.test(node.name) || !foundationModulePattern.test(node.name)));
  const sharedModuleIds = new Set(sharedModules.map((node) => node.id));
  const serviceBoundaryIds = new Set(moduleNodes.filter((node) => aggregatorModuleIds.has(node.id) && node.id !== rootModule?.id).map((node) => node.id));
  const businessDependencyEdges = dependencyEdges.filter((edge) => (serviceBoundaryIds.has(edge.sourceNodeId) || workloadModuleIds.has(edge.sourceNodeId)) && sharedModuleIds.has(edge.targetNodeId));
  const foundationDependencyEdges = dependencyEdges.filter((edge) => sharedModuleIds.has(edge.sourceNodeId) && foundationModuleIds.has(edge.targetNodeId));
  const projectName = rootModule?.name || normalizeArchitectureProjectTitle(title);
  const objectCount = (projectName ? 1 : 0) + workloads.length + sharedModules.length + foundationModules.length;

  return {
    projectName,
    workloads,
    sharedModules,
    foundationModules,
    dependencyEdges,
    businessDependencyEdges,
    foundationDependencyEdges,
    objectCount,
  };
}

export function ArchitectureGraphCanvas(props: ArchitectureGraphCanvasProps) {
  const copy =
    props.appLanguage === 'zh-CN'
      ? {
          canvas: '系统架构分层图',
          business: '业务服务',
          businessSummary: (count: number) => `${count} 个可运行服务`,
          shared: '共享契约',
          sharedSummary: (count: number) => `${count} 个跨服务模块`,
          foundation: '公共基础',
          foundationSummary: (count: number) => `${count} 个基础模块`,
          moduleFallback: '未识别模块',
          applicationFallback: '未识别启动入口',
          relation: '依赖',
        }
      : {
          canvas: 'Layered system architecture',
          business: 'Business services',
          businessSummary: (count: number) => `${count} runnable service${count === 1 ? '' : 's'}`,
          shared: 'Shared contracts',
          sharedSummary: (count: number) => `${count} cross-service module${count === 1 ? '' : 's'}`,
          foundation: 'Common foundation',
          foundationSummary: (count: number) => `${count} foundation module${count === 1 ? '' : 's'}`,
          moduleFallback: 'Unresolved module',
          applicationFallback: 'Unresolved entry point',
          relation: 'depends on',
        };
  const nodesById = new Map(
    [...props.model.workloads.flatMap((workload) => [workload.module, workload.application]), ...props.model.sharedModules, ...props.model.foundationModules]
      .filter((node): node is ArchitectureNode => Boolean(node))
      .map((node) => [node.id, node]),
  );

  return (
    <section className="graph-canvas architecture-layer-canvas" aria-label={copy.canvas}>
      <div className="architecture-layer-scroll" onClick={(event) => event.target === event.currentTarget && props.onClearSelection?.()}>
        <article
          className="architecture-layer-board"
          style={
            {
              '--architecture-zoom': String(props.zoom),
              '--architecture-workload-count': String(Math.max(1, props.model.workloads.length)),
            } as CSSProperties
          }
        >
          <header className="architecture-project-boundary">
            <strong>{props.model.projectName}</strong>
          </header>

          {props.model.workloads.length > 0 ? (
            <ArchitectureLayer title={copy.business} summary={copy.businessSummary(props.model.workloads.length)} kind="business">
              <div className="architecture-workload-grid">
                {props.model.workloads.map((workload) => (
                  <ArchitectureNodeButton
                    key={workload.primaryNode.id}
                    node={workload.primaryNode}
                    label={workload.label}
                    detail={workload.application?.name ?? workload.module?.name ?? copy.applicationFallback}
                    moduleName={workload.module?.name ?? copy.moduleFallback}
                    selected={props.currentNodeId === workload.primaryNode.id || props.currentNodeId === workload.module?.id}
                    onSelectNode={props.onSelectNode}
                    onOpenGraphSource={props.onOpenGraphSource}
                  />
                ))}
              </div>
            </ArchitectureLayer>
          ) : null}

          {props.model.businessDependencyEdges.length > 0 && props.model.sharedModules.length > 0 ? (
            <ArchitectureDependencyBridge
              id="business-shared"
              edges={props.model.businessDependencyEdges}
              targets={props.model.sharedModules}
              nodesById={nodesById}
              currentEdgeId={props.currentEdgeId}
              relationLabel={copy.relation}
              fallbackSourceName={copy.business}
              onSelectEdge={props.onSelectEdge}
            />
          ) : null}

          {props.model.sharedModules.length > 0 ? (
            <ArchitectureLayer title={copy.shared} summary={copy.sharedSummary(props.model.sharedModules.length)} kind="shared">
              <div className="architecture-shared-grid">
                {props.model.sharedModules.map((node) => (
                  <ArchitectureNodeButton key={node.id} node={node} label={node.name} selected={props.currentNodeId === node.id} onSelectNode={props.onSelectNode} onOpenGraphSource={props.onOpenGraphSource} compact />
                ))}
              </div>
            </ArchitectureLayer>
          ) : null}

          {props.model.foundationDependencyEdges.length > 0 && props.model.foundationModules.length > 0 ? (
            <ArchitectureDependencyBridge
              id="shared-foundation"
              edges={props.model.foundationDependencyEdges}
              sources={props.model.sharedModules}
              targets={props.model.foundationModules}
              nodesById={nodesById}
              currentEdgeId={props.currentEdgeId}
              relationLabel={copy.relation}
              onSelectEdge={props.onSelectEdge}
            />
          ) : null}

          {props.model.foundationModules.length > 0 ? (
            <ArchitectureLayer title={copy.foundation} summary={copy.foundationSummary(props.model.foundationModules.length)} kind="foundation">
              <div className="architecture-foundation-grid">
                {props.model.foundationModules.map((node) => (
                  <ArchitectureNodeButton key={node.id} node={node} label={node.name} selected={props.currentNodeId === node.id} onSelectNode={props.onSelectNode} onOpenGraphSource={props.onOpenGraphSource} compact />
                ))}
              </div>
            </ArchitectureLayer>
          ) : null}
        </article>
      </div>
      {props.controls}
    </section>
  );
}

function ArchitectureLayer(props: { title: string; summary: string; kind: 'business' | 'shared' | 'foundation'; children: ReactNode }) {
  return (
    <section className={`architecture-layer architecture-layer-${props.kind}`} aria-label={props.title}>
      <header>
        <strong>{props.title}</strong>
        <span>{props.summary}</span>
      </header>
      {props.children}
    </section>
  );
}

function ArchitectureNodeButton(props: {
  node: ArchitectureNode;
  label: string;
  detail?: string;
  moduleName?: string;
  compact?: boolean;
  selected: boolean;
  onSelectNode?: (nodeId: string) => void;
  onOpenGraphSource?: (source: { sourceRef: string; lineStart?: number }) => void;
}) {
  const lineStart = typeof props.node.metadata.lineStart === 'number' ? props.node.metadata.lineStart : undefined;
  const openSource = (): void => {
    if (!props.node.sourceRef) return;
    props.onOpenGraphSource?.({ sourceRef: props.node.sourceRef, lineStart });
  };

  return (
    <button
      type="button"
      className={`architecture-node${props.compact ? ' architecture-node-compact' : ''}${props.selected ? ' current-architecture-node' : ''}`}
      aria-current={props.selected ? 'true' : undefined}
      data-graph-node-id={props.node.id}
      data-graph-source-ref={props.node.sourceRef}
      data-graph-source-line={lineStart}
      title={props.moduleName ? `${props.label} · ${props.detail ?? ''} · ${props.moduleName}` : props.label}
      onClick={(event) => {
        event.stopPropagation();
        props.onSelectNode?.(props.node.id);
      }}
      onDoubleClick={openSource}
    >
      <Cube aria-hidden="true" weight="regular" />
      <span>
        <strong>{props.label}</strong>
        {props.detail ? <small>{props.detail}</small> : null}
      </span>
    </button>
  );
}

function ArchitectureDependencyBridge(props: {
  id: string;
  edges: ArchitectureEdge[];
  sources?: ArchitectureNode[];
  targets: ArchitectureNode[];
  nodesById: Map<string, ArchitectureNode>;
  currentEdgeId?: string | null;
  relationLabel: string;
  fallbackSourceName?: string;
  onSelectEdge?: (edgeId: string) => void;
}) {
  const markerId = `architecture-arrow-${props.id}`;
  const targetIndexById = new Map(props.targets.map((node, index) => [node.id, index]));
  const sourceIndexById = new Map((props.sources ?? []).map((node, index) => [node.id, index]));
  const targetCount = Math.max(1, props.targets.length);
  const sourceCount = Math.max(1, props.sources?.length ?? 1);

  return (
    <svg className="architecture-dependency-bridge" viewBox="0 0 1000 56" role="group" aria-label={props.relationLabel} preserveAspectRatio="none">
      <defs>
        <marker id={markerId} markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto">
          <path d="M 0 0 L 9 4.5 L 0 9 z" />
        </marker>
      </defs>
      {props.edges.map((edge) => {
        const sourceIndex = sourceIndexById.get(edge.sourceNodeId);
        const targetIndex = targetIndexById.get(edge.targetNodeId);
        const sourceX = typeof sourceIndex === 'number' ? ((sourceIndex + 0.5) / sourceCount) * 1000 : 500;
        const targetX = typeof targetIndex === 'number' ? ((targetIndex + 0.5) / targetCount) * 1000 : 500;
        const path = `M ${roundGraphCoordinate(sourceX)} 0 V 18 H ${roundGraphCoordinate(targetX)} V 54`;
        const sourceName = props.nodesById.get(edge.sourceNodeId)?.name ?? props.fallbackSourceName ?? edge.sourceNodeId;
        const targetName = props.nodesById.get(edge.targetNodeId)?.name ?? edge.targetNodeId;
        return (
          <g
            className={`architecture-layer-edge${props.currentEdgeId === edge.id ? ' current-architecture-edge' : ''}`}
            key={edge.id}
            role="button"
            tabIndex={0}
            aria-current={props.currentEdgeId === edge.id ? 'true' : undefined}
            aria-label={`${sourceName} ${props.relationLabel} ${targetName}`}
            data-graph-edge-id={edge.id}
            onClick={(event) => {
              event.stopPropagation();
              props.onSelectEdge?.(edge.id);
            }}
            onKeyDown={(event) => activateArchitectureEdgeFromKeyboard(event, edge.id, props.onSelectEdge)}
          >
            <path className="architecture-layer-edge-hit" d={path} />
            <path className="architecture-layer-edge-line" d={path} markerEnd={`url(#${markerId})`} />
          </g>
        );
      })}
    </svg>
  );
}

function activateArchitectureEdgeFromKeyboard(event: ReactKeyboardEvent<SVGGElement>, edgeId: string, onSelectEdge: ((edgeId: string) => void) | undefined): void {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  onSelectEdge?.(edgeId);
}

function isArchitectureModule(node: ArchitectureNode): boolean {
  return node.nodeType === 'module' || node.metadata.sourceKind === 'maven_project';
}

function normalizeArchitectureProjectTitle(title: string): string {
  return title.replace(/\s+(?:系统架构图|Architecture)$/iu, '').trim();
}

function formatArchitectureWorkloadLabel(moduleName: string, applicationName = ''): string {
  const applicationStem = applicationName.replace(/Application$/u, '');
  const rawLabel = applicationStem || moduleName.split(/[-_.]/u).filter(Boolean).at(-1) || moduleName;
  if (!rawLabel) return 'Service';
  if (/^base$/iu.test(rawLabel)) return 'Base';
  if (/^xxljob$/iu.test(rawLabel)) return 'XXL-JOB';
  if (/^[a-z]{2,4}$/iu.test(rawLabel)) return rawLabel.toLocaleUpperCase('en-US');
  return rawLabel.replace(/([a-z0-9])([A-Z])/gu, '$1-$2').toLocaleUpperCase('en-US');
}

function roundGraphCoordinate(value: number): number {
  return Math.round(value * 10) / 10;
}
