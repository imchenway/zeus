import '@xterm/xterm/css/xterm.css';
import '@xyflow/react/dist/style.css';
import './styles.css';
import './session/session.css';
import './ui/primitives.css';
import type { WorkspacePageProps } from './features/workspace/workspaceContracts.js';
import { useWorkspaceQueryState } from './features/workspace/useWorkspaceQueryState.js';
import { useWorkspaceDomainActions } from './features/workspace/useWorkspaceDomainActions.js';
import { useWorkspaceOperations } from './features/workspace/useWorkspaceOperations.js';
import { useWorkspaceLifecycle } from './features/workspace/useWorkspaceLifecycle.js';
import { WorkspaceView } from './features/workspace/WorkspaceView.js';
export {
  buildMermaidDiagramExport,
  buildMermaidDiagramSource,
  buildPlantUmlDiagramExport,
  buildPlantUmlDiagramSource,
  toReactFlowElements,
  toSigmaGraph,
  type MermaidDiagramExportFile,
  type PlantUmlDiagramExportFile,
} from '@zeus/diagram-engine';
export {
  type MainNavTarget,
  type SettingsCategory,
  type NativeConversationChoiceTaskLoadState,
  beginNativeConversationChoiceTaskLoad,
  completeNativeConversationChoiceTaskLoad,
  failNativeConversationChoiceTaskLoad,
  type NativeConversationChoiceLoadCoordinator,
  createNativeConversationChoiceLoadCoordinator,
  type NativeProjectConversationChoiceLoadCoordinator,
  createNativeProjectConversationChoiceLoadCoordinator,
  type TaskRuntimeControlHandlerResult,
  type NormalizedTaskRuntimeControlHandlerResult,
  type TaskRuntimeConversationNavigation,
  shouldRefreshConversationForRuntimeEvent,
  shouldRefreshNativeConversationListForRealtimeEvent,
  PROJECT_SIDEBAR_DEFAULT_WIDTH,
  PROJECT_SIDEBAR_MIN_WIDTH,
  PROJECT_SIDEBAR_MAX_WIDTH,
  PROJECT_SIDEBAR_MIN_WORKSPACE_WIDTH,
  PROJECT_SIDEBAR_SEPARATOR_WIDTH,
  PROJECT_SIDEBAR_WIDTH_STORAGE_KEY,
  type ProjectSidebarWidthStorage,
  clampProjectSidebarWidth,
  readProjectSidebarPreferredWidth,
  adjustProjectSidebarWidthForKeyboard,
  resolveProjectSidebarDragResult,
  type ProjectSidebarDragState,
  type ProjectSidebarDragEvent,
  transitionProjectSidebarDrag,
  writeProjectSidebarPreferredWidth,
  SessionMobileSourceTrigger,
  scheduleSessionDrawerInitialFocus,
  resolveSessionDrawerInitialFocusTarget,
  resolveSelectedNativeConversationForProject,
  resolveTaskConversationToView,
  toAppShellSettingsSavePayload,
  resolveTaskTableColumnsSaveResponse,
  mergeAppShellSettingsSaveResponse,
  buildRuntimeSessionTaskDraft,
  buildGraphConversationTaskIntent,
  buildGraphNodeTaskIntent,
  buildProjectDirectoryResolution,
  buildTemplateTaskDraft,
  buildDefaultTaskDraft,
  buildTaskCreateInitialForm,
  normalizeTaskCreateDraft,
  normalizeTaskRuntimeControlHandlerResult,
  resolveTaskRuntimeActionRoute,
  resolveTaskRuntimeConversationNavigation,
  isProjectGraphViewForProject,
  type LocalUiErrorSnapshot,
} from './features/workspace/workspaceSupport.js';
export {
  GENERIC_SHELL_CRITICAL_CONFIRMATION_PHRASE,
  type GenericShellCommandRiskLevel,
  type GenericShellCommandRisk,
  classifyGenericShellCommandRisk,
  type GitOperationExecutionForm,
  buildGitOperationExecutionInput,
  buildGitDiffReviewSummary,
  buildGitDiffDecisionSummary,
  isGenericShellCriticalConfirmationSatisfied,
} from './features/workspace/workspaceFormatters.js';
export {
  type GraphNodeActionMenuItem,
  buildGraphNodeActionMenu,
  type AggregatedGraphNode,
  type AggregatedGraphEdge,
  buildGraphNeighborhoodSlice,
  buildVisibleGraphSlice,
  buildGraphQuestionRequest,
  type GraphSearchFilterInput,
  buildGraphSearchRequest,
  normalizeGraphMinConfidence,
  isAggregatedGraphNode,
  buildAggregatedGraphNodes,
  buildAggregatedGraphEdges,
  type SigmaRuntimeGraphNode,
  type SigmaRuntimeGraph,
  buildSigmaRuntimeGraph,
  GraphRuntimeCanvas,
  buildGraphCanvasLayout,
  buildGraphCanvasViewport,
} from './features/graph/GraphCanvas.js';
export { resolveRuntimeNormalizedLogPath } from './features/workspace/WorkspaceChrome.js';
/** Zeus 主界面：展示真实 API snapshot；无真实记录时才展示空状态。 */
export function WorkspacePage(props: WorkspacePageProps) {
  const state = useWorkspaceQueryState(props);
  const domainActions = useWorkspaceDomainActions(state);
  const operations = useWorkspaceOperations(state, domainActions);
  useWorkspaceLifecycle(state, domainActions, operations);
  return <WorkspaceView state={state} domainActions={domainActions} operations={operations} />;
}
