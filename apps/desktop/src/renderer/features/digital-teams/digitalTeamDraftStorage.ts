import { validateDigitalTeamWorkflowDefinition, type DigitalTeamWorkflowValidationIssue } from '@zeus/shared';
import type { DigitalTeamTemplateSaveInput } from './digitalTeamApiClient.js';

/** 编辑草稿保留来源修订，恢复时不能静默覆盖其他窗口保存的流程。 */
export type DigitalTeamTemplateDraft = Pick<DigitalTeamTemplateSaveInput, 'name' | 'description' | 'definition'> & {
  /** 未保存的新团队没有服务端身份。 */
  id: string | null;
  /** 保存仍使用开始编辑时读取的修订。 */
  revision: number | null;
  /** 不可绘制的旧定义仍保留明确修复提示。 */
  sourceIssues?: DigitalTeamWorkflowValidationIssue[];
};

/** 草稿属于全局团队，不再按项目拆分。 */
const draftStoragePrefix = 'zeus:digital-team-draft:';
/** 最近编辑的团队让页面切换后回到原草稿。 */
const selectionStorageKey = `${draftStoragePrefix}selection`;
/** 新团队与已保存团队分别暂存，避免相互覆盖。 */
const newTeamDraftKey = '__new_team__';
/** 存储不可写时仍保留本窗口的编辑内容。 */
const memoryDrafts = new Map<string, DigitalTeamTemplateDraft | null>();
/** 最近选择在存储不可用时仍支持页面内返回。 */
let memorySelection: string | null | undefined;

/** 读取最近编辑目标；没有记录时由服务端目录决定默认团队。 */
export function readDigitalTeamDraftSelection(): string | null | undefined {
  try {
    /** 选择记录只含团队身份。 */
    const value = localStorage.getItem(selectionStorageKey);
    return value === newTeamDraftKey ? null : value || memorySelection;
  } catch {
    return memorySelection;
  }
}

/** 选择变化不修改流程，也不形成需要保存的业务草稿。 */
export function rememberDigitalTeamDraftSelection(id: string | null): void {
  memorySelection = id;
  try {
    localStorage.setItem(selectionStorageKey, id ?? newTeamDraftKey);
  } catch {
    // 存储不可用时沿用本窗口选择，不阻止页面导航。
  }
}

/** 恢复完整编辑原值，忽略损坏或不可绘制的缓存。 */
export function readDigitalTeamDraft(id: string | null): DigitalTeamTemplateDraft | null {
  /** 每个团队使用独立记录，避免一次编辑重写全部草稿。 */
  const key = `${draftStoragePrefix}${id ?? newTeamDraftKey}`;
  if (memoryDrafts.has(key)) return memoryDrafts.get(key) ?? null;
  try {
    /** 本地缓存不经过规范化，以保留用户输入中的空格和换行。 */
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (isDigitalTeamDraft(value) && value.id === id) return value;
  } catch {
    // 损坏记录不能让团队页无法打开。
  }
  return memoryDrafts.get(key) ?? null;
}

/** 暂存编辑原值；返回值区分持久暂存和仅本窗口保留。 */
export function rememberDigitalTeamDraft(draft: DigitalTeamTemplateDraft): boolean {
  /** 来源身份决定唯一草稿记录。 */
  const key = `${draftStoragePrefix}${draft.id ?? newTeamDraftKey}`;
  memoryDrafts.set(key, draft);
  rememberDigitalTeamDraftSelection(draft.id);
  try {
    localStorage.setItem(key, JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

/** 保存、放弃或删除只清除准确团队的编辑草稿。 */
export function forgetDigitalTeamDraft(id: string | null, expectedDraft?: DigitalTeamTemplateDraft): void {
  /** 新草稿使用固定独立身份。 */
  const key = `${draftStoragePrefix}${id ?? newTeamDraftKey}`;
  /** 旧保存回执不能清掉本窗口刚产生的新输入。 */
  const expected = expectedDraft ? JSON.stringify(expectedDraft) : null;
  /** 内存暂存对应当前窗口的最新编辑。 */
  const current = memoryDrafts.get(key);
  if (expected && current && JSON.stringify(current) !== expected) return;
  memoryDrafts.set(key, null);
  try {
    /** 另一个窗口已经编辑时也保留其持久草稿。 */
    if (expected && localStorage.getItem(key) !== expected) return;
    localStorage.removeItem(key);
  } catch {
    // 本窗口记录已清理，不因为存储异常重复写入流程。
  }
}

/** 只接受可安全交给画布的编辑数据，不把配置未完成当成缓存损坏。 */
function isDigitalTeamDraft(value: unknown): value is DigitalTeamTemplateDraft {
  if (!value || typeof value !== 'object') return false;
  /** 校验缓存字段而不信任解析后的任意对象。 */
  const draft = value as Partial<DigitalTeamTemplateDraft>;
  if (!(draft.id === null || typeof draft.id === 'string') || !(draft.revision === null || (typeof draft.revision === 'number' && Number.isInteger(draft.revision))) || typeof draft.name !== 'string' || typeof draft.description !== 'string')
    return false;
  if (
    draft.sourceIssues !== undefined &&
    (!Array.isArray(draft.sourceIssues) || draft.sourceIssues.some((issue) => !issue || typeof issue.code !== 'string' || typeof issue.message !== 'string' || (issue.nodeId !== undefined && typeof issue.nodeId !== 'string')))
  )
    return false;
  return !validateDigitalTeamWorkflowDefinition(draft.definition).some((issue) => ['ZEUS_DIGITAL_TEAM_WORKFLOW_SHAPE_INVALID', 'ZEUS_DIGITAL_TEAM_WORKFLOW_NODE_INVALID', 'ZEUS_DIGITAL_TEAM_WORKFLOW_EDGE_INVALID'].includes(issue.code));
}
