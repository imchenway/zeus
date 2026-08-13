import { useEffect, useMemo, useRef, useState, type Dispatch, type FormEvent, type KeyboardEvent, type SetStateAction } from 'react';
import {
  buildTaskPushLayout,
  renderTaskPushLayoutText,
  type TaskPushContextConversationOption,
  type TaskPushContextOption,
  type TaskPushMessageLayout,
  type TaskPushParentContextOption,
  type TaskPushPromptAttachment,
  type TaskPushPromptParentContext,
  type TaskPushPromptRelatedContext,
  type TaskPushRelatedContextOption,
  type TaskPushSupplementalAttachment,
} from '@zeus/shared';
import type { TaskRecord } from '../apiClient.js';
import type { CodexTaskPushCapabilities, NativeConversationAttachment, NativePermissionMode, NativeServiceTierSelection, TaskPushSupplementalAttachmentDraft, TaskPushSupplementalAttachmentInput } from '../session/sessionTypes.js';
import { useConversationInputResources } from '../session/useConversationInputResources.js';
import { normalizeServiceTierSelection, serviceTierOptions, serviceTierSelectionFromValue, serviceTierSelectionValue } from '../session/serviceTierSelection.js';
import { readConversationRuntimePreferences, writeConversationRuntimePreferences } from '../session/conversationRuntimePreferences.js';
import { resolveModelCapability } from '../session/modelSelection.js';
import { Button } from '../ui/Button.js';
import { ModalPortal } from '../ui/ModalPortal.js';
import { ZeusSelect } from '../ZeusSelect.js';
import { presentModelOptions } from '../modelOptionPresentation.js';
import { TaskPushSupplementalAttachmentCards } from './TaskPushSupplementalAttachmentCards.js';

export interface TaskModelPushForm {
  model: string;
  effort: string;
  serviceTier: NativeServiceTierSelection;
  serviceTierDowngraded: boolean;
  workMode: 'default' | 'plan';
  permissionMode: NativePermissionMode;
  workspaceMode: 'direct' | 'worktree';
  directConcurrencyConfirmed: boolean;
  repositorySelections: Record<string, { sourceRef: string; branchName: string; includeLocalChanges: boolean }>;
  currentConversationIds: string[];
  parentContextSelections: Record<string, { selected: boolean; conversationIds: string[]; attachmentKeys: string[] }>;
  relatedContextSelections: Record<string, { selected: boolean; conversationIds: string[]; attachmentKeys: string[] }>;
  supplementalInfo: string;
  supplementalAttachments: TaskPushSupplementalAttachmentDraft[];
}

export type TaskModelPushModalStatus = 'loading' | 'ready' | 'authenticating' | 'authenticated' | 'submitting' | 'error';

export type TaskModelPushPreferences = Pick<TaskModelPushForm, 'model' | 'effort' | 'serviceTier' | 'workMode' | 'permissionMode'> & {
  workspaceMode?: 'direct' | 'worktree';
};

type TaskPushRepositoryCapability = CodexTaskPushCapabilities['repositories'][number];
type TaskPushSourceRef = TaskPushRepositoryCapability['sourceRefs'][number];
type TaskPushContextCapability = CodexTaskPushCapabilities['parentContextOptions'][number] | CodexTaskPushCapabilities['relatedContextOptions'][number];

interface TaskPushCommonSource {
  key: string;
  label: string;
  kind: TaskPushSourceRef['kind'];
  group: string;
  refsByRepository: Record<string, string>;
}

const preferencesKeyPrefix = 'zeus.task-model-push-preferences:v1:';

/** 统一兼容混合版本运行服务缺失的可选上下文集合；模型与仓库等创建必需能力仍保持严格校验。 */
export function normalizeTaskModelPushCapabilities(capabilities: CodexTaskPushCapabilities): CodexTaskPushCapabilities {
  const normalizeContext = <T extends TaskPushContextCapability>(option: T): T => ({
    ...option,
    conversations: Array.isArray(option.conversations) ? option.conversations : [],
    attachments: Array.isArray(option.attachments) ? option.attachments : [],
  });
  return {
    ...capabilities,
    currentAttachmentOptions: Array.isArray(capabilities.currentAttachmentOptions) ? capabilities.currentAttachmentOptions : [],
    currentConversationOptions: Array.isArray(capabilities.currentConversationOptions) ? capabilities.currentConversationOptions : [],
    parentContextOptions: Array.isArray(capabilities.parentContextOptions) ? capabilities.parentContextOptions.map(normalizeContext) : [],
    relatedContextOptions: Array.isArray(capabilities.relatedContextOptions) ? capabilities.relatedContextOptions.map(normalizeContext) : [],
  };
}

function taskPushSourceIdentity(source: TaskPushSourceRef): string {
  return JSON.stringify([source.kind, source.kind === 'remote' ? source.group : '', source.label]);
}

/** 只聚合每个仓库都唯一存在的同来源分支，避免批量选择时猜测真实 Git 引用。 */
function resolveTaskPushCommonSources(repositories: TaskPushRepositoryCapability[]): TaskPushCommonSource[] {
  if (repositories.length < 2) return [];
  const sourcesByRepository = repositories.map((repository) => {
    const sourcesByIdentity = new Map<string, TaskPushSourceRef[]>();
    for (const source of repository.sourceRefs) {
      const key = taskPushSourceIdentity(source);
      const matches = sourcesByIdentity.get(key) ?? [];
      matches.push(source);
      sourcesByIdentity.set(key, matches);
    }
    return sourcesByIdentity;
  });
  const commonSources: TaskPushCommonSource[] = [];
  for (const [key, firstMatches] of sourcesByRepository[0] ?? []) {
    if (firstMatches.length !== 1) continue;
    const refsByRepository: Record<string, string> = {};
    let complete = true;
    for (let index = 0; index < repositories.length; index += 1) {
      const repository = repositories[index];
      const matches = sourcesByRepository[index]?.get(key);
      if (!repository || matches?.length !== 1) {
        complete = false;
        break;
      }
      refsByRepository[repository.id] = matches[0]!.ref;
    }
    if (!complete) continue;
    const source = firstMatches[0]!;
    commonSources.push({ key, label: source.label, kind: source.kind, group: source.kind === 'remote' ? source.group : '', refsByRepository });
  }
  return commonSources.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === 'local' ? -1 : 1;
    return left.group.localeCompare(right.group) || left.label.localeCompare(right.label);
  });
}

function resolveSelectedTaskPushCommonSourceKey(repositories: TaskPushRepositoryCapability[], selections: TaskModelPushForm['repositorySelections'], commonSources: TaskPushCommonSource[]): string {
  return commonSources.find((source) => repositories.every((repository) => selections[repository.id]?.sourceRef === source.refsByRepository[repository.id]))?.key ?? '';
}

function taskPushCommonSourceLabel(source: TaskPushCommonSource, repositoryCount: number, zh: boolean): string {
  if (zh) return `${source.label} · ${source.kind === 'local' ? '本地' : `${source.group} 远端`} · ${repositoryCount} 个仓库`;
  return `${source.label} · ${source.kind === 'local' ? 'local' : `${source.group} remote`} · ${repositoryCount} repositories`;
}

export function buildTaskModelPushMessage(
  task: Pick<TaskRecord, 'id' | 'taskCode' | 'title' | 'taskType' | 'description' | 'defectCurrentState' | 'defectExpectedOutcome' | 'defectReproductionSteps' | 'optimizationCurrentState' | 'optimizationExpectedOutcome' | 'tags'>,
  supplementalInfo: string,
  currentAttachments: TaskPushPromptAttachment[] = [],
  currentConversationPaths: string[] = [],
  parentContexts: TaskPushPromptParentContext[] = [],
  relatedContexts: TaskPushPromptRelatedContext[] = [],
  supplementalAttachments: TaskPushSupplementalAttachment[] = [],
): string {
  return renderTaskPushLayoutText(buildTaskModelPushLayout(task, supplementalInfo, currentAttachments, currentConversationPaths, parentContexts, relatedContexts, supplementalAttachments));
}

export function buildTaskModelPushLayout(
  task: Pick<TaskRecord, 'id' | 'taskCode' | 'title' | 'taskType' | 'description' | 'defectCurrentState' | 'defectExpectedOutcome' | 'defectReproductionSteps' | 'optimizationCurrentState' | 'optimizationExpectedOutcome' | 'tags'>,
  supplementalInfo: string,
  currentAttachments: TaskPushPromptAttachment[] = [],
  currentConversationPaths: string[] = [],
  parentContexts: TaskPushPromptParentContext[] = [],
  relatedContexts: TaskPushPromptRelatedContext[] = [],
  supplementalAttachments: TaskPushSupplementalAttachment[] = [],
): TaskPushMessageLayout {
  return buildTaskPushLayout({
    taskId: task.id,
    taskCode: task.taskCode,
    taskTitle: task.title,
    taskType: task.taskType,
    taskDescription: task.description,
    defectCurrentState: task.defectCurrentState,
    defectExpectedOutcome: task.defectExpectedOutcome,
    defectReproductionSteps: task.defectReproductionSteps,
    optimizationCurrentState: task.optimizationCurrentState,
    optimizationExpectedOutcome: task.optimizationExpectedOutcome,
    tags: task.tags,
    attachments: currentAttachments,
    conversationPaths: currentConversationPaths,
    supplementalInfo,
    supplementalAttachments,
    parentContexts,
    relatedContexts,
  });
}

export function taskPushSupplementalLayoutAttachments(attachments: TaskPushSupplementalAttachmentDraft[]): TaskPushSupplementalAttachment[] {
  return attachments.map((attachment) => ({
    key: attachment.taskPushAttachmentKey,
    name: attachment.name,
    kind: attachment.kind ?? (attachment.mime === 'inode/directory' ? 'directory' : attachment.mime.startsWith('image/') ? 'image' : 'file'),
    mimeType: attachment.mime,
    size: attachment.size,
  }));
}

export function taskPushSupplementalRequestAttachments(attachments: TaskPushSupplementalAttachmentDraft[]): TaskPushSupplementalAttachmentInput[] {
  return attachments.map((attachment) => {
    const metadata = {
      taskPushAttachmentKey: attachment.taskPushAttachmentKey,
      name: attachment.name,
      mime: attachment.mime,
      size: attachment.size,
      kind: attachment.kind ?? (attachment.mime === 'inode/directory' ? ('directory' as const) : attachment.mime.startsWith('image/') ? ('image' as const) : ('file' as const)),
    };
    if (attachment.localPath) return { ...metadata, localPath: attachment.localPath };
    if (attachment.uploadRef) return { ...metadata, uploadRef: attachment.uploadRef };
    throw new Error('本次推送附件缺少本机资源身份。');
  });
}

function supplementalAttachmentIdentity(attachment: NativeConversationAttachment): string {
  return attachment.localPath ?? attachment.uploadRef;
}

function createSupplementalAttachmentKey(): string {
  const id = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `task-push-supplemental-${id}`;
}

function mergeSupplementalAttachments(current: TaskPushSupplementalAttachmentDraft[], added: NativeConversationAttachment[]): TaskPushSupplementalAttachmentDraft[] {
  const byIdentity = new Map(current.map((attachment) => [supplementalAttachmentIdentity(attachment), attachment]));
  for (const attachment of added) {
    const identity = supplementalAttachmentIdentity(attachment);
    if (byIdentity.has(identity)) continue;
    byIdentity.set(identity, { ...attachment, taskPushAttachmentKey: createSupplementalAttachmentKey() });
  }
  return [...byIdentity.values()];
}

export function selectedTaskPushCurrentConversationPaths(options: TaskPushContextConversationOption[], conversationIds: string[]): string[] {
  const selectedConversationIds = new Set(conversationIds);
  return options.filter((conversation) => selectedConversationIds.has(conversation.id) && conversation.available && conversation.path).map((conversation) => conversation.path!);
}

/** 按服务端给出的根到父顺序生成正文上下文；附件只走结构化通道，不进入文本。 */
export function selectedTaskPushParentContexts(options: TaskPushParentContextOption[], selections: TaskModelPushForm['parentContextSelections']): TaskPushPromptParentContext[] {
  return selectedTaskPushContexts(options, selections);
}

export function selectedTaskPushRelatedContexts(options: TaskPushRelatedContextOption[], selections: TaskModelPushForm['relatedContextSelections']): TaskPushPromptRelatedContext[] {
  return selectedTaskPushContexts(options, selections);
}

function selectedTaskPushContexts<T extends TaskPushContextOption>(
  options: T[],
  selections: Record<string, { selected: boolean; conversationIds: string[]; attachmentKeys: string[] }>,
): Array<TaskPushPromptParentContext | TaskPushPromptRelatedContext> {
  return options.flatMap((option) => {
    const selection = selections[option.taskId];
    if (!selection?.selected) return [];
    const selectedConversationIds = new Set(selection.conversationIds);
    const selectedAttachmentKeys = new Set(selection.attachmentKeys);
    return [
      {
        taskId: option.taskId,
        taskCode: option.taskCode,
        taskTitle: option.taskTitle,
        taskType: option.taskType,
        taskDescription: option.taskDescription,
        defectCurrentState: option.defectCurrentState,
        defectExpectedOutcome: option.defectExpectedOutcome,
        defectReproductionSteps: option.defectReproductionSteps,
        optimizationCurrentState: option.optimizationCurrentState,
        optimizationExpectedOutcome: option.optimizationExpectedOutcome,
        tags: option.tags,
        attachments: option.attachments.filter((attachment) => selectedAttachmentKeys.has(attachment.key) && attachment.available),
        conversationPaths: option.conversations.filter((conversation) => selectedConversationIds.has(conversation.id) && conversation.available && conversation.path).map((conversation) => conversation.path!),
      },
    ];
  });
}

type TaskPushContextSelections = TaskModelPushForm['parentContextSelections'];

function TaskPushCurrentConversationPicker(props: { options: TaskPushContextConversationOption[]; selectedIds: string[]; busy: boolean; zh: boolean; onChange: (conversationIds: string[]) => void }) {
  if (props.options.length === 0) return null;
  const selectedIds = new Set(props.selectedIds);
  return (
    <section className="task-model-push-parent-context task-model-push-current-conversations" aria-label={props.zh ? '当前任务历史会话信息' : 'Current task conversation history'}>
      <span className="task-model-push-section-heading">
        <strong>{props.zh ? '当前任务历史会话信息' : 'Current task conversation history'}</strong>
        <small>{props.zh ? '选择本次需要发送的历史会话' : 'Select the previous conversations to send with this task'}</small>
      </span>
      <div className="task-model-push-parent-list">
        <fieldset className="task-model-push-parent is-selected">
          <div className="task-model-push-parent-resources">
            <div>
              {props.options.map((conversation) => (
                <label key={conversation.id} className={!conversation.available ? 'is-unavailable' : undefined}>
                  <input
                    type="checkbox"
                    checked={selectedIds.has(conversation.id)}
                    onChange={(event) => props.onChange(event.currentTarget.checked ? [...props.selectedIds.filter((id) => id !== conversation.id), conversation.id] : props.selectedIds.filter((id) => id !== conversation.id))}
                    disabled={props.busy || !conversation.available}
                  />
                  <span>
                    <strong>{conversation.title}</strong>
                    <small>
                      {conversation.archived ? (props.zh ? '已归档 · ' : 'Archived · ') : ''}
                      {conversation.available ? conversation.path : conversation.unavailableReason}
                    </small>
                  </span>
                </label>
              ))}
            </div>
          </div>
        </fieldset>
      </div>
    </section>
  );
}

function taskPushAttachmentFieldLabel(field: TaskPushPromptAttachment['field'], zh: boolean): string {
  const labels = zh
    ? { description: '需求描述', defectCurrentState: '现状', defectExpectedOutcome: '预期', defectReproductionSteps: '复现步骤', optimizationCurrentState: '现状', optimizationExpectedOutcome: '预期', tags: '标签' }
    : {
        description: 'Description',
        defectCurrentState: 'Current state',
        defectExpectedOutcome: 'Expected outcome',
        defectReproductionSteps: 'Reproduction steps',
        optimizationCurrentState: 'Current state',
        optimizationExpectedOutcome: 'Expected outcome',
        tags: 'Tags',
      };
  return labels[field];
}

function TaskPushContextPicker(props: {
  kind: 'parent' | 'related';
  options: TaskPushContextOption[];
  selections: TaskPushContextSelections;
  busy: boolean;
  zh: boolean;
  onChange: (taskId: string, selection: TaskPushContextSelections[string]) => void;
}) {
  if (props.options.length === 0) return null;
  const title = props.kind === 'parent' ? (props.zh ? '父任务上下文' : 'Parent task context') : props.zh ? '关联任务上下文' : 'Related task context';
  const attachmentTitle = props.kind === 'parent' ? (props.zh ? '父任务附件' : 'Parent attachments') : props.zh ? '关联任务附件' : 'Related attachments';
  return (
    <section className="task-model-push-parent-context" aria-label={title}>
      <span className="task-model-push-section-heading">
        <strong>{title}</strong>
        <small>{props.zh ? '默认全部不选；任务、会话和附件均需本次手动勾选' : 'Nothing is selected by default; select tasks, sessions, and attachments manually for this push'}</small>
      </span>
      <div className="task-model-push-parent-list">
        {props.options.map((option) => {
          const selection = props.selections[option.taskId] ?? { selected: false, conversationIds: [], attachmentKeys: [] };
          const selectedConversations = new Set(selection.conversationIds);
          const selectedAttachments = new Set(selection.attachmentKeys);
          const updateResource = (field: 'conversationIds' | 'attachmentKeys', value: string, selected: boolean): void => {
            const values = selection[field];
            props.onChange(option.taskId, { ...selection, [field]: selected ? [...values.filter((entry) => entry !== value), value] : values.filter((entry) => entry !== value) });
          };
          return (
            <fieldset key={option.taskId} className={selection.selected ? 'task-model-push-parent is-selected' : 'task-model-push-parent'}>
              <legend>
                <label>
                  <input type="checkbox" checked={selection.selected} onChange={(event) => props.onChange(option.taskId, { selected: event.currentTarget.checked, conversationIds: [], attachmentKeys: [] })} disabled={props.busy} />
                  <span>
                    <strong>
                      {option.taskCode} · {option.taskTitle}
                    </strong>
                    <small>{option.taskType === 'defect' ? (props.zh ? '缺陷' : 'Defect') : option.taskType === 'optimization' ? (props.zh ? '优化' : 'Optimization') : props.zh ? '需求' : 'Requirement'}</small>
                  </span>
                </label>
              </legend>
              {selection.selected ? (
                <div className="task-model-push-parent-resources">
                  <div>
                    <strong>{props.zh ? '内部会话' : 'Sessions'}</strong>
                    {option.conversations.length > 0 ? (
                      option.conversations.map((conversation) => (
                        <label key={conversation.id} className={!conversation.available ? 'is-unavailable' : undefined}>
                          <input
                            type="checkbox"
                            checked={selectedConversations.has(conversation.id)}
                            onChange={(event) => updateResource('conversationIds', conversation.id, event.currentTarget.checked)}
                            disabled={props.busy || !conversation.available}
                          />
                          <span>
                            <strong>{conversation.title}</strong>
                            <small>
                              {conversation.archived ? (props.zh ? '已归档 · ' : 'Archived · ') : ''}
                              {conversation.available ? conversation.path : conversation.unavailableReason}
                            </small>
                          </span>
                        </label>
                      ))
                    ) : (
                      <small>{props.zh ? '没有会话' : 'No sessions'}</small>
                    )}
                  </div>
                  <div>
                    <strong>{attachmentTitle}</strong>
                    {option.attachments.length > 0 ? (
                      option.attachments.map((attachment) => (
                        <label key={attachment.key} className={!attachment.available ? 'is-unavailable' : undefined}>
                          <input
                            type="checkbox"
                            checked={selectedAttachments.has(attachment.key)}
                            onChange={(event) => updateResource('attachmentKeys', attachment.key, event.currentTarget.checked)}
                            disabled={props.busy || !attachment.available}
                          />
                          <span>
                            <strong>{attachment.name}</strong>
                            <small>
                              {attachment.available ? `${taskPushAttachmentFieldLabel(attachment.field, props.zh)} · ${attachment.kind}${attachment.size !== undefined ? ` · ${attachment.size} B` : ''}` : attachment.unavailableReason}
                            </small>
                          </span>
                        </label>
                      ))
                    ) : (
                      <small>{props.zh ? '没有附件' : 'No attachments'}</small>
                    )}
                  </div>
                </div>
              ) : null}
            </fieldset>
          );
        })}
      </div>
    </section>
  );
}

export function TaskPushLayoutPreview(props: { layout: TaskPushMessageLayout; language: 'zh-CN' | 'en-US' }) {
  const supplementalAttachments = props.layout.supplementalAttachments ?? [];
  const attachmentsByKey = new Map([...props.layout.blocks.flatMap((block) => block.attachments), ...supplementalAttachments].map((attachment) => [attachment.key, attachment]));
  return (
    <section className="task-model-push-canonical task-push-layout" aria-label={props.language === 'zh-CN' ? '将发送的任务内容' : 'Task content to send'}>
      <strong>{props.language === 'zh-CN' ? '将发送的任务内容' : 'Task content to send'}</strong>
      {props.layout.blocks.map((block) => (
        <article key={`${block.contextKind}:${block.taskId ?? 'current'}`} className="task-push-layout-block">
          <header>
            <strong>{block.contextKind === 'current' ? block.taskTitle : `${block.contextKind === 'parent' ? '父任务' : '关联任务'}：${block.taskCode ?? block.taskId} · ${block.taskTitle}`}</strong>
          </header>
          {block.fields.map((field) => (
            <section key={field.field} className="task-push-layout-field">
              <strong>{field.label}：</strong>
              {field.attachmentKeys.map((key) => {
                const attachment = attachmentsByKey.get(key);
                return attachment ? (
                  <span key={key} className="task-push-layout-attachment">
                    {attachment.kind === 'image' ? '图片' : '附件'} · {attachment.name}
                  </span>
                ) : null;
              })}
              {field.text ? <p>{field.text}</p> : null}
            </section>
          ))}
          {block.conversationPaths.length > 0 ? (
            <section className="task-push-layout-field">
              <strong>{block.contextKind === 'current' ? '当前任务历史会话信息：' : '会话文件路径：'}</strong>
              {block.conversationPaths.map((path) => (
                <code key={path}>{path}</code>
              ))}
            </section>
          ) : null}
        </article>
      ))}
      {props.layout.supplementalInfo || supplementalAttachments.length > 0 ? (
        <section className="task-push-layout-field">
          <strong>补充信息：</strong>
          {supplementalAttachments.map((attachment) => (
            <span key={attachment.key} className="task-push-layout-attachment">
              {attachment.kind === 'image' ? '图片' : '附件'} · {attachment.name}
            </span>
          ))}
          {props.layout.supplementalInfo ? <p>{props.layout.supplementalInfo}</p> : null}
        </section>
      ) : null}
    </section>
  );
}

export function readTaskModelPushPreferences(storage: Pick<Storage, 'getItem'> | undefined, projectId: string): TaskModelPushPreferences | null {
  if (!storage) return null;
  try {
    const current = readConversationRuntimePreferences(storage, projectId, 'task_development');
    if (current?.model) {
      return {
        model: current.model,
        effort: current.effort ?? '',
        serviceTier: current.serviceTier,
        workMode: current.collaborationMode,
        permissionMode: current.permissionMode,
        ...(current.workspaceMode ? { workspaceMode: current.workspaceMode } : {}),
      };
    }
    const value = JSON.parse(storage.getItem(`${preferencesKeyPrefix}${encodeURIComponent(projectId)}`) ?? 'null') as Partial<TaskModelPushPreferences> | null;
    if (!value || typeof value.model !== 'string' || typeof value.effort !== 'string') return null;
    if (value.workMode !== 'default' && value.workMode !== 'plan') return null;
    if (value.permissionMode !== 'read-only' && value.permissionMode !== 'auto' && value.permissionMode !== 'full-access') return null;
    return {
      model: value.model,
      effort: value.effort,
      serviceTier: value.serviceTier?.type === 'catalog' && typeof value.serviceTier.id === 'string' ? value.serviceTier : { type: 'standard' },
      workMode: value.workMode,
      permissionMode: value.permissionMode,
      ...(value.workspaceMode === 'direct' || value.workspaceMode === 'worktree' ? { workspaceMode: value.workspaceMode } : {}),
    };
  } catch {
    return null;
  }
}

export function writeTaskModelPushPreferences(storage: Pick<Storage, 'getItem' | 'setItem'> | undefined, projectId: string, form: TaskModelPushForm): void {
  if (!storage) return;
  writeConversationRuntimePreferences(storage, projectId, 'task_development', {
    model: form.model,
    ...(form.effort ? { effort: form.effort } : {}),
    serviceTier: form.serviceTier,
    permissionMode: form.permissionMode,
    collaborationMode: form.workMode,
    workspaceMode: form.workspaceMode,
  });
  storage.setItem(
    `${preferencesKeyPrefix}${encodeURIComponent(projectId)}`,
    JSON.stringify({
      model: form.model,
      effort: form.effort,
      serviceTier: form.serviceTier,
      workMode: form.workMode,
      permissionMode: form.permissionMode,
      workspaceMode: form.workspaceMode,
    } satisfies TaskModelPushPreferences),
  );
}

export function resolveTaskModelPushInitialForm(capabilities: CodexTaskPushCapabilities, remembered: TaskModelPushPreferences | null, serviceTier: NativeServiceTierSelection = { type: 'standard' }): TaskModelPushForm {
  const availableModels = capabilities.models.filter((model) => model.available !== false);
  const rememberedModel = resolveModelCapability(availableModels, remembered?.model);
  const selectedModel = rememberedModel ?? resolveModelCapability(availableModels, capabilities.preferredModel) ?? availableModels[0];
  if (!selectedModel) throw new Error('Codex app-server did not report an available model.');
  const effort = rememberedModel && remembered && selectedModel.supportedReasoningEfforts.includes(remembered.effort) ? remembered.effort : (selectedModel.defaultReasoningEffort ?? selectedModel.supportedReasoningEfforts[0] ?? '');
  const requestedServiceTier = remembered?.serviceTier ?? serviceTier;
  const normalizedServiceTier = normalizeServiceTierSelection(requestedServiceTier, selectedModel);
  return {
    model: selectedModel.id,
    effort,
    serviceTier: normalizedServiceTier.selection,
    serviceTierDowngraded: normalizedServiceTier.downgraded,
    workMode: remembered?.workMode ?? 'default',
    // 用户已确认：项目没有成功记忆时，权限必须回退为只读。
    permissionMode: remembered?.permissionMode ?? 'read-only',
    workspaceMode: remembered?.workspaceMode ?? (capabilities.repositories.length > 0 ? 'worktree' : 'direct'),
    directConcurrencyConfirmed: false,
    repositorySelections: Object.fromEntries(
      capabilities.repositories.map((repository) => {
        const currentSourceRef = repository.sourceRefs.find((source) => source.current)?.ref ?? '';
        return [
          repository.id,
          {
            // 远端模式按当前同名远端分支选默认值；纯本地模式才使用当前本地分支。
            sourceRef: currentSourceRef,
            branchName: repository.suggestedBranchName,
            includeLocalChanges: false,
          },
        ];
      }),
    ),
    currentConversationIds: [],
    parentContextSelections: {},
    relatedContextSelections: {},
    supplementalInfo: '',
    supplementalAttachments: [],
  };
}

export function TaskModelPushModal(props: {
  open: boolean;
  language: 'zh-CN' | 'en-US';
  task: TaskRecord | null;
  projectName?: string;
  capabilities: CodexTaskPushCapabilities | null;
  form: TaskModelPushForm;
  status: TaskModelPushModalStatus;
  refreshingRepositoryId: string | null;
  error: string | null;
  onChange: Dispatch<SetStateAction<TaskModelPushForm>>;
  onRefreshRepository: (repositoryId: string) => void;
  onClose: () => void;
  onCancelAuthentication: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const commonSources = useMemo(() => resolveTaskPushCommonSources(props.capabilities?.repositories ?? []), [props.capabilities?.repositories]);
  const supplementalTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [supplementalResourceError, setSupplementalResourceError] = useState<string | null>(null);
  const resourceInputDisabled = !props.open || props.status === 'authenticating' || props.status === 'submitting';
  const inputResources = useConversationInputResources({
    textareaRef: supplementalTextareaRef,
    text: props.form.supplementalInfo,
    disabled: resourceInputDisabled,
    onTextChange: (supplementalInfo) => props.onChange((current) => ({ ...current, supplementalInfo })),
    onAddAttachments: (attachments) => {
      setSupplementalResourceError(null);
      props.onChange((current) => ({ ...current, supplementalAttachments: mergeSupplementalAttachments(current.supplementalAttachments, attachments) }));
    },
    onRemoveAttachment: (attachment) => {
      const identity = supplementalAttachmentIdentity(attachment);
      props.onChange((current) => ({ ...current, supplementalAttachments: current.supplementalAttachments.filter((candidate) => supplementalAttachmentIdentity(candidate) !== identity) }));
    },
    onError: setSupplementalResourceError,
  });
  useEffect(() => {
    setSupplementalResourceError(null);
  }, [props.open, props.task?.id]);
  const requestedModel = resolveModelCapability(props.capabilities?.models, props.form.model);
  const modelPresentation = useMemo(() => presentModelOptions(props.capabilities?.models ?? [], requestedModel?.id ?? props.form.model, props.language), [props.capabilities?.models, props.form.model, props.language, requestedModel?.id]);
  const selectedModel = resolveModelCapability(modelPresentation.models, modelPresentation.selectedId);
  useEffect(() => {
    if (!props.open || !selectedModel || props.form.model === selectedModel.id) return;
    props.onChange((current) => {
      if (current.model === selectedModel.id) return current;
      const normalizedTier = normalizeServiceTierSelection(current.serviceTier, selectedModel);
      return {
        ...current,
        model: selectedModel.id,
        effort: selectedModel.defaultReasoningEffort ?? selectedModel.supportedReasoningEfforts[0] ?? '',
        serviceTier: normalizedTier.selection,
        serviceTierDowngraded: normalizedTier.downgraded,
      };
    });
  }, [props.form.model, props.onChange, props.open, selectedModel]);
  if (!props.open || !props.task) return null;
  const zh = props.language === 'zh-CN';
  const authenticating = props.status === 'authenticating';
  const authenticated = props.status === 'authenticated';
  const busy = authenticating || authenticated || props.status === 'submitting' || inputResources.processing;
  const codexLoginRequired = selectedModel?.agentKind !== 'pi' && props.capabilities?.codexAccount.requiresOpenaiAuth === true && !props.capabilities.codexAccount.signedIn;
  const repositories = props.capabilities?.repositories ?? [];
  const selectedCommonSourceKey = resolveSelectedTaskPushCommonSourceKey(repositories, props.form.repositorySelections, commonSources);
  const selectedCommonSource = commonSources.find((source) => source.key === selectedCommonSourceKey);
  const hasRepositorySourceSelection = repositories.some((repository) => Boolean(props.form.repositorySelections[repository.id]?.sourceRef));
  const directWorkspaceBusy = (props.capabilities?.directWorkspace.activeWritableConversationCount ?? 0) > 0;
  const directWorkspaceNeedsConfirmation = directWorkspaceBusy && props.form.permissionMode !== 'read-only';
  const parentContextOptions = props.capabilities?.parentContextOptions ?? [];
  const relatedContextOptions = props.capabilities?.relatedContextOptions ?? [];
  const currentAttachments = props.capabilities?.currentAttachmentOptions ?? [];
  const currentConversationOptions = props.capabilities?.currentConversationOptions ?? [];
  const selectedCurrentConversationPaths = selectedTaskPushCurrentConversationPaths(currentConversationOptions, props.form.currentConversationIds);
  const selectedParentContexts = selectedTaskPushParentContexts(parentContextOptions, props.form.parentContextSelections);
  const selectedRelatedContexts = selectedTaskPushRelatedContexts(relatedContextOptions, props.form.relatedContextSelections);
  const taskPushLayout = buildTaskModelPushLayout(
    props.task,
    props.form.supplementalInfo,
    currentAttachments,
    selectedCurrentConversationPaths,
    selectedParentContexts,
    selectedRelatedContexts,
    taskPushSupplementalLayoutAttachments(props.form.supplementalAttachments),
  );

  function onModelChange(model: string): void {
    const capability = resolveModelCapability(props.capabilities?.models, model);
    const normalizedTier = normalizeServiceTierSelection(props.form.serviceTier, capability);
    props.onChange({
      ...props.form,
      model: capability?.id ?? model,
      effort: capability?.defaultReasoningEffort ?? capability?.supportedReasoningEfforts[0] ?? '',
      serviceTier: normalizedTier.selection,
      serviceTierDowngraded: normalizedTier.downgraded,
    });
  }

  function handleKeyDown(event: KeyboardEvent<HTMLFormElement>): void {
    if (event.key === 'Escape' && !busy) props.onClose();
  }

  function changeContextSelection(kind: 'parent' | 'related', taskId: string, next: { selected: boolean; conversationIds: string[]; attachmentKeys: string[] }): void {
    const field = kind === 'parent' ? 'parentContextSelections' : 'relatedContextSelections';
    props.onChange({ ...props.form, [field]: { ...props.form[field], [taskId]: next } });
  }

  function applyCommonSource(sourceKey: string): void {
    const commonSource = commonSources.find((source) => source.key === sourceKey);
    if (!commonSource) return;
    const repositorySelections = { ...props.form.repositorySelections };
    for (const repository of repositories) {
      const sourceRef = commonSource.refsByRepository[repository.id];
      if (!sourceRef) return;
      const current = repositorySelections[repository.id] ?? {
        sourceRef: '',
        branchName: repository.suggestedBranchName,
        includeLocalChanges: false,
      };
      repositorySelections[repository.id] = { ...current, sourceRef };
    }
    props.onChange({ ...props.form, repositorySelections });
  }

  const modal = (
    <ModalPortal rootClassName="task-model-push-portal-root" backdropClassName="task-model-push-backdrop" dismissDisabled={busy} onDismiss={props.onClose}>
      <form className="task-model-push-modal zeus-solid-form-surface" role="dialog" aria-modal="true" aria-labelledby="task-model-push-title" onSubmit={props.onSubmit} onKeyDown={handleKeyDown}>
        <header className="task-model-push-header">
          <span>
            <strong id="task-model-push-title">{zh ? '推送到新会话' : 'Push to new conversation'}</strong>
            <small>{props.projectName ? `${props.projectName} · ${props.task.taskCode ?? props.task.id}` : (props.task.taskCode ?? props.task.id)}</small>
          </span>
          <button type="button" aria-label={zh ? '关闭' : 'Close'} onClick={props.onClose} disabled={busy}>
            ×
          </button>
        </header>

        <div className="task-model-push-body">
          <section className="task-model-push-workspace" aria-label={zh ? '本次推送工作区' : 'Workspace for this push'}>
            <span className="task-model-push-section-heading">
              <strong>{zh ? '本次推送工作区' : 'Workspace for this push'}</strong>
              <small>{zh ? '直接使用项目目录，或按需创建独立分支和 worktree' : 'Use the project directory directly, or create isolated branches and worktrees'}</small>
            </span>
            <fieldset className="task-model-push-mode-choice">
              <legend>{zh ? '工作方式' : 'Workspace mode'}</legend>
              <label className={props.form.workspaceMode === 'direct' ? 'is-selected' : undefined}>
                <input
                  type="radio"
                  name="task-workspace-mode"
                  value="direct"
                  checked={props.form.workspaceMode === 'direct'}
                  onChange={() => props.onChange({ ...props.form, workspaceMode: 'direct', directConcurrencyConfirmed: false })}
                  disabled={busy}
                />
                <span>
                  <strong>{zh ? '直接使用项目目录' : 'Use project directory directly'}</strong>
                  <small>{zh ? '不创建分支或隔离目录，修改直接写入真实项目' : 'No branch or isolated directory; changes write to the real project'}</small>
                </span>
              </label>
              <label className={props.form.workspaceMode === 'worktree' ? 'is-selected' : undefined}>
                <input
                  type="radio"
                  name="task-workspace-mode"
                  value="worktree"
                  checked={props.form.workspaceMode === 'worktree'}
                  onChange={() => props.onChange({ ...props.form, workspaceMode: 'worktree', directConcurrencyConfirmed: false })}
                  disabled={busy}
                />
                <span>
                  <strong>Worktree</strong>
                  <small>{zh ? '自动发现全部 Git 仓库，并创建独立任务分支' : 'Discover all Git repositories and create isolated task branches'}</small>
                </span>
              </label>
            </fieldset>
            {props.form.workspaceMode === 'direct' ? (
              <div className="task-model-push-direct-summary">
                <small>
                  {zh ? '工作目录' : 'Working directory'}：{props.capabilities?.directWorkspace.path ?? '—'}
                </small>
                <p className="task-model-push-warning">
                  {zh ? 'AI 将直接读写项目真实目录；现有文件和当前 Git 分支不会被隔离。' : 'The agent writes directly to the real project directory; existing files and the current Git branch are not isolated.'}
                </p>
                {directWorkspaceNeedsConfirmation ? (
                  <label className="task-model-push-concurrency-confirm">
                    <input type="checkbox" checked={props.form.directConcurrencyConfirmed} onChange={(event) => props.onChange({ ...props.form, directConcurrencyConfirmed: event.currentTarget.checked })} disabled={busy} />
                    <span>
                      {zh
                        ? `当前已有 ${props.capabilities?.directWorkspace.activeWritableConversationCount ?? 0} 条可写会话使用这个目录；我了解并发修改可能互相覆盖。`
                        : `${props.capabilities?.directWorkspace.activeWritableConversationCount ?? 0} writable conversation(s) already use this directory; I understand concurrent changes may overwrite each other.`}
                    </span>
                  </label>
                ) : null}
              </div>
            ) : !props.capabilities ? (
              <p className={props.status === 'error' ? 'task-model-push-error' : 'task-model-push-message'} role="status">
                {props.status === 'error'
                  ? zh
                    ? 'Git 仓库检查未完成，不能判断项目是否存在仓库。请根据下方错误处理后重试。'
                    : 'The Git repository check did not complete, so repository presence is unknown. Resolve the error below and try again.'
                  : zh
                    ? '正在扫描项目目录下的 Git 仓库…'
                    : 'Scanning the project directory for Git repositories…'}
              </p>
            ) : repositories.length > 0 ? (
              <div className="task-model-push-repository-list">
                {repositories.length > 1 ? (
                  <section className="task-model-push-batch-source" aria-labelledby="task-model-push-batch-source-title">
                    <span className="task-model-push-batch-source-heading">
                      <strong id="task-model-push-batch-source-title">{zh ? '批量选择来源分支' : 'Select source branch for all repositories'}</strong>
                      <small>{zh ? `${repositories.length} 个仓库` : `${repositories.length} repositories`}</small>
                    </span>
                    {commonSources.length > 0 ? (
                      <ZeusSelect
                        size="regular"
                        ariaLabel={zh ? '批量选择来源分支' : 'Select source branch for all repositories'}
                        ariaDescribedBy="task-model-push-batch-source-description"
                        value={selectedCommonSourceKey}
                        triggerLabel={
                          selectedCommonSource
                            ? taskPushCommonSourceLabel(selectedCommonSource, repositories.length, zh)
                            : hasRepositorySourceSelection
                              ? zh
                                ? '逐仓选择不一致'
                                : 'Repository selections differ'
                              : zh
                                ? '批量选择来源分支'
                                : 'Select a source branch for all repositories'
                        }
                        options={commonSources.map((source) => ({
                          value: source.key,
                          label: taskPushCommonSourceLabel(source, repositories.length, zh),
                          group: source.kind === 'local' ? (zh ? '本地分支' : 'Local branches') : zh ? `${source.group} 远端分支` : `${source.group} remote branches`,
                        }))}
                        onChange={applyCommonSource}
                        disabled={busy || props.refreshingRepositoryId !== null}
                        searchable
                        searchPlaceholder={zh ? '搜索全部仓库共有的分支' : 'Search branches shared by all repositories'}
                        emptyLabel={zh ? '没有匹配的共同来源分支' : 'No matching common source branch'}
                      />
                    ) : (
                      <p className="task-model-push-batch-source-empty" role="status">
                        {zh ? '没有全部仓库共同拥有且来源一致的分支，请继续逐仓选择。' : 'No source branch with the same origin exists in every repository. Select each repository below.'}
                      </p>
                    )}
                    <small id="task-model-push-batch-source-description" aria-live="polite">
                      {selectedCommonSource
                        ? zh
                          ? `已将 ${selectedCommonSource.label} 应用到全部仓库；仍可逐仓调整。`
                          : `${selectedCommonSource.label} is applied to every repository. You can still adjust repositories individually.`
                        : commonSources.length > 0 && hasRepositorySourceSelection
                          ? zh
                            ? '当前逐仓选择不一致；可重新批量应用，也可保留现状。'
                            : 'Repository selections currently differ. Apply a common branch again or keep the individual choices.'
                          : zh
                            ? '这里只显示全部仓库都存在的同来源分支；应用后仍可逐仓调整。'
                            : 'Only branches with the same origin in every repository are shown. You can still adjust repositories individually.'}
                    </small>
                  </section>
                ) : null}
                {repositories.map((repository) => {
                  const selection = props.form.repositorySelections[repository.id] ?? {
                    sourceRef: '',
                    branchName: repository.suggestedBranchName,
                    includeLocalChanges: false,
                  };
                  const selectedSource = repository.sourceRefs.find((source) => source.ref === selection.sourceRef);
                  const refreshing = props.refreshingRepositoryId === repository.id;
                  return (
                    <fieldset key={repository.id} className="task-model-push-repository">
                      <legend>
                        <span>
                          <strong>{repository.name}</strong>
                          <small>{repository.relativePath}</small>
                        </span>
                        <Button variant="secondary" size="compact" busy={refreshing} onClick={() => props.onRefreshRepository(repository.id)} disabled={busy || refreshing || !repository.defaultRemoteName}>
                          {refreshing ? (zh ? '正在刷新…' : 'Refreshing…') : zh ? '刷新远端分支' : 'Refresh remote branches'}
                        </Button>
                      </legend>
                      <div className="task-model-push-workspace-grid">
                        <label>
                          <span>{zh ? '来源分支（必选）' : 'Source branch (required)'}</span>
                          <ZeusSelect
                            size="regular"
                            ariaLabel={`${repository.name} ${zh ? '来源分支' : 'source branch'}`}
                            value={selection.sourceRef}
                            options={[
                              { value: '', label: zh ? '请选择来源分支' : 'Select source branch', disabled: true },
                              ...repository.sourceRefs.map((source) => ({
                                value: source.ref,
                                label: `${source.label}${source.current ? (zh ? ' · 当前分支' : ' · current branch') : ''}`,
                                group: source.kind === 'local' ? (zh ? '本地分支' : 'Local branches') : zh ? `${source.group} 远端分支` : `${source.group} remote branches`,
                              })),
                            ]}
                            onChange={(sourceRef) =>
                              props.onChange({
                                ...props.form,
                                repositorySelections: { ...props.form.repositorySelections, [repository.id]: { ...selection, sourceRef } },
                              })
                            }
                            disabled={!props.capabilities || busy || refreshing}
                            searchPlaceholder={zh ? '搜索分支' : 'Search branches'}
                          />
                        </label>
                        <label>
                          <span>{zh ? '新分支' : 'New branch'}</span>
                          <input
                            value={selection.branchName}
                            onChange={(event) =>
                              props.onChange({
                                ...props.form,
                                repositorySelections: { ...props.form.repositorySelections, [repository.id]: { ...selection, branchName: event.target.value } },
                              })
                            }
                            disabled={busy}
                            spellCheck={false}
                          />
                        </label>
                      </div>
                      <p className={repository.remoteRefreshError ? 'task-model-push-error' : 'task-model-push-warning'}>
                        {repository.remoteRefreshError
                          ? zh
                            ? `远端刷新失败：${repository.remoteRefreshError}。本地分支、已知远端分支和当前选择不受影响。`
                            : `Remote refresh failed: ${repository.remoteRefreshError}. Local branches, known remote branches, and the current selection remain available.`
                          : repository.remoteRefreshStatus === 'succeeded'
                            ? zh
                              ? '远端分支已手动刷新。来源分支仍由你选择。'
                              : 'Remote branches were refreshed manually. The source branch remains your choice.'
                            : repository.defaultRemoteName
                              ? zh
                                ? '当前展示本地分支和本机已知的远端分支；需要最新远端状态时再手动刷新。'
                                : 'Local branches and locally known remote branches are shown. Refresh manually when current remote state is needed.'
                              : zh
                                ? '该仓库没有远端，当前使用本地分支快照。默认不带入原工作区未提交内容。'
                                : 'This repository has no remote, so a local branch snapshot is used. Local uncommitted changes are excluded by default.'}
                      </p>
                      {selectedSource?.kind === 'local' && repository.clean === false ? (
                        <label className="task-model-push-concurrency-confirm">
                          <input
                            type="checkbox"
                            checked={selection.includeLocalChanges}
                            onChange={(event) =>
                              props.onChange({
                                ...props.form,
                                repositorySelections: {
                                  ...props.form.repositorySelections,
                                  [repository.id]: {
                                    ...selection,
                                    includeLocalChanges: event.currentTarget.checked,
                                  },
                                },
                              })
                            }
                            disabled={busy}
                          />
                          <span>{zh ? '显式带入当前项目目录中的未提交内容。' : 'Explicitly copy uncommitted changes from the current project directory.'}</span>
                        </label>
                      ) : null}
                    </fieldset>
                  );
                })}
              </div>
            ) : (
              <p className="task-model-push-error" role="alert">
                {zh ? '项目目录下没有发现 Git 仓库。请先自行初始化仓库，或改用“直接使用项目目录”。' : 'No Git repository was found. Initialize one first, or use the project directory directly.'}
              </p>
            )}
            {props.form.workspaceMode === 'worktree' ? (
              <small className="task-model-push-worktree-root">
                {zh ? '新工作区路径' : 'New workspace path'}：{props.capabilities?.git.worktreeRoot ?? '—'}/&lt;{zh ? '项目' : 'project'}&gt;/&lt;{zh ? '推送标识' : 'push-id'}&gt;/{props.task.taskCode ?? props.task.id}
              </small>
            ) : null}
          </section>

          <div className="task-model-push-config-grid">
            <label>
              <span>{zh ? '模型' : 'Model'}</span>
              <ZeusSelect
                size="regular"
                ariaLabel={zh ? '模型' : 'Model'}
                value={modelPresentation.selectedId || props.form.model}
                options={modelPresentation.options}
                triggerLabel={modelPresentation.triggerLabel}
                onChange={onModelChange}
                disabled={!props.capabilities || modelPresentation.options.length === 0 || busy}
                searchPlaceholder={zh ? '搜索供应商或模型' : 'Search providers or models'}
                emptyLabel={zh ? '没有匹配模型' : 'No matching models'}
              />
            </label>
            {selectedModel?.supportedReasoningEfforts.length ? (
              <label>
                <span>{zh ? '模型等级' : 'Reasoning effort'}</span>
                <ZeusSelect
                  size="regular"
                  ariaLabel={zh ? '模型等级' : 'Reasoning effort'}
                  value={props.form.effort}
                  options={selectedModel.supportedReasoningEfforts.map((effort) => ({
                    value: effort,
                    label: effort,
                  }))}
                  onChange={(effort) => props.onChange({ ...props.form, effort })}
                  disabled={busy}
                  searchable={false}
                />
              </label>
            ) : null}
            <label>
              <span>{zh ? '速度' : 'Speed'}</span>
              <ZeusSelect
                size="regular"
                ariaLabel={zh ? '速度' : 'Speed'}
                value={serviceTierSelectionValue(props.form.serviceTier)}
                options={serviceTierOptions(selectedModel, props.language)}
                onChange={(value) => props.onChange({ ...props.form, serviceTier: serviceTierSelectionFromValue(value), serviceTierDowngraded: false })}
                disabled={!selectedModel || busy}
                searchable={false}
              />
            </label>
            <label>
              <span>{zh ? '工作模式' : 'Work mode'}</span>
              <ZeusSelect
                size="regular"
                ariaLabel={zh ? '工作模式' : 'Work mode'}
                value={props.form.workMode}
                options={[
                  { value: 'default', label: zh ? '默认' : 'Default' },
                  { value: 'plan', label: zh ? '规划' : 'Plan' },
                ]}
                onChange={(workMode) => props.onChange({ ...props.form, workMode })}
                disabled={busy}
                searchable={false}
              />
            </label>
            <label>
              <span>{zh ? '权限模式' : 'Permission mode'}</span>
              <ZeusSelect<NativePermissionMode>
                size="regular"
                ariaLabel={zh ? '权限模式' : 'Permission mode'}
                value={props.form.permissionMode}
                options={[
                  { value: 'read-only', label: zh ? '只读' : 'Read only' },
                  { value: 'auto', label: zh ? '自动' : 'Auto' },
                  { value: 'full-access', label: zh ? '完全访问' : 'Full access' },
                ]}
                onChange={(permissionMode) => props.onChange({ ...props.form, permissionMode })}
                disabled={busy}
                searchable={false}
              />
            </label>
          </div>

          {codexLoginRequired || authenticating || authenticated ? (
            <section className={`task-model-push-account${authenticated ? ' is-success' : ''}`} role="status" aria-live="polite" aria-atomic="true">
              <span>
                <strong>{authenticated ? (zh ? '登录成功，正在继续' : 'Signed in, continuing') : zh ? 'Zeus 专属 Codex 需要登录' : 'Sign in to Codex for Zeus'}</strong>
                <small>
                  {authenticated
                    ? zh
                      ? 'Zeus 已验证专属 Codex 账号，正在恢复刚才的配置并创建会话。'
                      : 'Zeus verified its Codex account and is restoring your configuration to create the conversation.'
                    : zh
                      ? 'Zeus 与 Codex App 使用独立账号状态，不会复制或覆盖 Codex App 的登录信息。'
                      : 'Zeus keeps a separate account state and does not copy or overwrite the Codex App sign-in.'}
                </small>
              </span>
              <p>
                {authenticated
                  ? zh
                    ? '无需再次确认，请稍候。'
                    : 'No further confirmation is needed.'
                  : authenticating
                    ? zh
                      ? '官方登录页已打开。完成后无需点击网页中的“打开 ChatGPT”或“打开 Codex”，Zeus 会自动返回并继续。'
                      : 'The official sign-in page is open. You do not need to choose “Open ChatGPT” or “Open Codex”; Zeus will return and continue automatically.'
                    : zh
                      ? '点击“登录并继续”会打开官方登录页。完成后无需点击网页中的其他按钮，Zeus 会自动返回；当前模型、工作区、权限、补充信息和本次附件都会保留。'
                      : 'Choose “Sign in and continue” to open the official sign-in page. You do not need to choose another button there; Zeus will return automatically and preserve your model, workspace, permissions, supplemental information, and attachments for this push.'}
              </p>
            </section>
          ) : null}

          <TaskPushCurrentConversationPicker
            options={currentConversationOptions}
            selectedIds={props.form.currentConversationIds}
            busy={busy}
            zh={zh}
            onChange={(currentConversationIds) => props.onChange((current) => ({ ...current, currentConversationIds }))}
          />

          <section className="task-model-push-supplement" aria-busy={inputResources.processing || undefined} aria-labelledby="task-model-push-supplement-label">
            <label id="task-model-push-supplement-label" htmlFor="task-model-push-supplement-input">
              {zh ? '补充信息（可选）' : 'Supplemental information (optional)'}
            </label>
            <TaskPushSupplementalAttachmentCards
              attachments={props.form.supplementalAttachments}
              language={props.language}
              disabled={busy}
              onRemove={(attachment) => {
                const identity = supplementalAttachmentIdentity(attachment);
                props.onChange((current) => ({ ...current, supplementalAttachments: current.supplementalAttachments.filter((candidate) => supplementalAttachmentIdentity(candidate) !== identity) }));
              }}
              onRestoreText={inputResources.restorePastedText}
              onError={setSupplementalResourceError}
            />
            <textarea
              ref={supplementalTextareaRef}
              id="task-model-push-supplement-input"
              value={props.form.supplementalInfo}
              maxLength={20_000}
              onChange={(event) => props.onChange({ ...props.form, supplementalInfo: event.target.value })}
              onPaste={inputResources.handlePaste}
              onKeyDown={inputResources.handlePasteShortcut}
              disabled={busy}
              placeholder={zh ? '仅影响本次推送，不会修改任务本身。' : 'Applies only to this push and does not modify the task.'}
            />
            {supplementalResourceError ? (
              <p className="task-model-push-supplement-error" role="alert">
                {supplementalResourceError}
              </p>
            ) : null}
          </section>

          <TaskPushContextPicker kind="parent" options={parentContextOptions} selections={props.form.parentContextSelections} busy={busy} zh={zh} onChange={(taskId, selection) => changeContextSelection('parent', taskId, selection)} />
          <TaskPushContextPicker kind="related" options={relatedContextOptions} selections={props.form.relatedContextSelections} busy={busy} zh={zh} onChange={(taskId, selection) => changeContextSelection('related', taskId, selection)} />

          <TaskPushLayoutPreview layout={taskPushLayout} language={props.language} />

          {props.status === 'loading' ? <p className="task-model-push-message">{zh ? '正在连接 app-server 并读取可用模型…' : 'Connecting to app-server and loading models…'}</p> : null}
          {props.error ? (
            <p className="task-model-push-error" role="alert">
              {props.error}
            </p>
          ) : null}
        </div>

        <footer className="task-model-push-footer">
          <small>{zh ? '确认后会创建新会话并立即进入；历史会话不会被覆盖。' : 'A new conversation will be created and opened; history remains unchanged.'}</small>
          <span>
            <Button variant="secondary" size="regular" onClick={authenticating ? props.onCancelAuthentication : props.onClose} disabled={props.status === 'submitting'}>
              {authenticating ? (zh ? '取消登录' : 'Cancel sign-in') : zh ? '取消' : 'Cancel'}
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="regular"
              busy={busy}
              disabled={
                busy ||
                props.status === 'loading' ||
                !props.form.model ||
                (props.form.workspaceMode === 'direct'
                  ? directWorkspaceNeedsConfirmation && !props.form.directConcurrencyConfirmed
                  : repositories.length === 0 ||
                    repositories.some((repository) => {
                      const selection = props.form.repositorySelections[repository.id];
                      return !selection?.sourceRef || !selection.branchName.trim();
                    }))
              }
            >
              {authenticating
                ? zh
                  ? '等待登录…'
                  : 'Waiting for sign-in…'
                : authenticated
                  ? zh
                    ? '登录成功，正在继续…'
                    : 'Signed in, continuing…'
                  : props.status === 'submitting'
                    ? zh
                      ? '正在创建…'
                      : 'Creating…'
                    : codexLoginRequired
                      ? zh
                        ? '登录并继续'
                        : 'Sign in and continue'
                      : zh
                        ? '创建新会话'
                        : 'Create conversation'}
            </Button>
          </span>
        </footer>
      </form>
    </ModalPortal>
  );
  return modal;
}
