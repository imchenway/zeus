import { type Dispatch, type FormEvent, type KeyboardEvent, type SetStateAction, useEffect, useMemo, useRef, useState } from 'react';
import {
  buildTaskPushLayout,
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
import type { ProjectModelServiceTierPreference, TaskRecord } from '../apiClient.js';
import type {
  CodexConversationCapabilities,
  CodexTaskPushCapabilities,
  CodexTaskPushModelCapability,
  NativeConversationAttachment,
  NativePermissionMode,
  NativeServiceTierSelection,
  TaskPushSupplementalAttachmentDraft,
  TaskPushSupplementalAttachmentInput,
} from '../session/sessionTypes.js';
import { useConversationInputResources } from '../session/useConversationInputResources.js';
import { ConversationPendingAttachmentImages } from '../session/ConversationResources.js';
import { normalizeServiceTierSelection, serviceTierOptions, serviceTierSelectionFromValue, serviceTierSelectionValue } from '../session/serviceTierSelection.js';
import { readConversationRuntimePreferences, writeConversationRuntimePreferences } from '../session/conversationRuntimePreferences.js';
import { resolveModelCapability } from '../session/modelSelection.js';
import { Button } from '../ui/Button.js';
import { ModalPortal } from '../ui/ModalPortal.js';
import { VisibleApplicationError } from '../ui/ApplicationErrorDialog.js';
import { ZeusSelect } from '../ZeusSelect.js';
import { presentModelOptions } from '../modelOptionPresentation.js';
import { projectModelServiceTierSelection } from '../session/projectServiceTierPreferences.js';
import { TaskPushSupplementalAttachmentCards } from './TaskPushSupplementalAttachmentCards.js';
import { SkillSelector } from '../features/skills/SkillSelector.js';
import type { CodexApiClient } from '../features/codex/codexApiClient.js';

export interface TaskModelPushForm {
  stageId?: string;
  model: string;
  effort: string;
  serviceTier: NativeServiceTierSelection;
  serviceTierDowngraded: boolean;
  workMode: 'default' | 'plan';
  permissionMode: NativePermissionMode;
  skillId: string;
  workspaceMode: 'direct' | 'worktree';
  /** 工作方式经过用户选择或来自项目记忆时，不再被后台发现覆盖。 */
  workspaceModeSelected?: boolean;
  /** 首次发现 Git 后固定默认方式，不因后台清单变空而静默切换成直接目录。 */
  workspaceModeResolved?: boolean;
  /** 已展示的仓库集合发生变化时，创建前要求用户核对新清单。 */
  repositorySelectionNeedsReview?: boolean;
  taskBranchMode: 'create' | 'existing';
  environmentId: string;
  directConcurrencyConfirmed: boolean;
  repositorySelections: Record<string, { sourceRef: string; branchName: string; includeLocalChanges: boolean }>;
  currentConversationIds: string[];
  parentContextSelections: Record<string, { selected: boolean; conversationIds: string[]; attachmentKeys: string[] }>;
  relatedContextSelections: Record<string, { selected: boolean; conversationIds: string[]; attachmentKeys: string[] }>;
  supplementalInfo: string;
  supplementalAttachments: TaskPushSupplementalAttachmentDraft[];
}

export type TaskModelPushModalStatus = 'loading' | 'ready' | 'submitting' | 'error';

/** 入口只根据已读取的账号和项目目录选择下一步，不替换模型或启动执行。 */
export function resolveTaskModelPushEntry(capabilities: CodexConversationCapabilities, hasConfiguredProvider: boolean): 'confirmation' | 'choose' | 'custom' {
  /** 未就绪占位账号不能视为无需登录的可用 Codex。 */
  const codexReady = capabilities.codexAccount.generationId !== 'codex-unavailable' && (!capabilities.codexAccount.requiresOpenaiAuth || capabilities.codexAccount.signedIn);
  if (capabilities.models.some((model) => model.available !== false && (model.agentKind === 'pi' || model.sourceId !== 'codex' || codexReady))) return 'confirmation';
  return hasConfiguredProvider ? 'custom' : 'choose';
}

export type TaskModelPushPreferences = Pick<TaskModelPushForm, 'model' | 'effort' | 'serviceTier' | 'workMode' | 'permissionMode'> & {
  workspaceMode?: 'direct' | 'worktree';
};

type TaskPushRepositoryCapability = CodexTaskPushCapabilities['repositories'][number];
type TaskPushSourceRef = TaskPushRepositoryCapability['sourceRefs'][number];
type TaskPushContextCapability = CodexTaskPushCapabilities['parentContextOptions'][number] | CodexTaskPushCapabilities['relatedContextOptions'][number];
type TaskPushEnvironmentCapability = NonNullable<CodexTaskPushCapabilities['existingEnvironments']>[number];

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
    existingEnvironments: Array.isArray(capabilities.existingEnvironments) ? capabilities.existingEnvironments : [],
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

export function taskPushEnvironmentLabel(environment: TaskPushEnvironmentCapability, zh: boolean, availableAfterStop = false): string {
  const branches = Array.from(new Set(environment.repositories.map((repository) => repository.branchName)));
  const branchLabel = branches.length === 1 ? branches[0]! : branches.join(zh ? '、' : ', ');
  const repositoryLabel = environment.repositories.length === 1 ? environment.repositories[0]!.repositoryName : zh ? `${environment.repositories.length} 个仓库` : `${environment.repositories.length} repositories`;
  const unavailableLabel = availableAfterStop
    ? zh
      ? ' · 停止后继续'
      : ' · continue after stop'
    : environment.unavailableReason === 'active_conversation'
      ? zh
        ? ' · 正有会话使用'
        : ' · active conversation'
      : environment.unavailableReason === 'closed_workspace'
        ? zh
          ? ' · 已部分关闭'
          : ' · partially closed'
        : '';
  return `${branchLabel} · ${repositoryLabel}${unavailableLabel}`;
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

export function taskPushSupplementalAttachmentIdentity(attachment: NativeConversationAttachment): string {
  return attachment.localPath ?? attachment.uploadRef;
}

function createSupplementalAttachmentKey(): string {
  const id = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `task-push-supplemental-${id}`;
}

export function mergeTaskPushSupplementalAttachments(current: TaskPushSupplementalAttachmentDraft[], added: NativeConversationAttachment[]): TaskPushSupplementalAttachmentDraft[] {
  const byIdentity = new Map(current.map((attachment) => [taskPushSupplementalAttachmentIdentity(attachment), attachment]));
  for (const attachment of added) {
    const identity = taskPushSupplementalAttachmentIdentity(attachment);
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
  const selectedIds = new Set(props.selectedIds);
  return (
    <section className="task-model-push-parent-context task-model-push-current-conversations" aria-label={props.zh ? '当前任务历史会话信息' : 'Current task conversation history'}>
      <span className="task-model-push-section-heading">
        <strong>{props.zh ? '当前任务历史会话信息' : 'Current task conversation history'}</strong>
        <small>{props.zh ? '选择本次需要发送的历史会话' : 'Select the previous conversations to send with this task'}</small>
      </span>
      <div className="task-model-push-parent-list">
        {props.options.length > 0 ? (
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
        ) : (
          <p className="task-model-push-context-empty" role="status">
            {props.zh ? '此任务还没有会话。创建会话后，可以在这里选择要提供给 AI 的历史对话。' : 'This task has no conversations yet. After creating one, you can select past conversations here to share with the AI.'}
          </p>
        )}
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

/** 根据已选布局匹配独立图片来源，复用会话缩略图与放大弹窗。 */
export function TaskPushLayoutPreview(props: { layout: TaskPushMessageLayout; language: 'zh-CN' | 'en-US'; previewAttachments: NativeConversationAttachment[] }) {
  const supplementalAttachments = props.layout.supplementalAttachments ?? [];
  const attachmentsByKey = new Map([...props.layout.blocks.flatMap((block) => block.attachments), ...supplementalAttachments].map((attachment) => [attachment.key, attachment]));
  // 不按文件名匹配，也不将本机预览路径写回布局。
  const previewAttachmentsByKey = new Map(props.previewAttachments.map((attachment) => [attachment.taskPushAttachmentKey, attachment]));

  /** 当前字段和补充附件共用同一图片匹配入口。 */
  function renderAttachment(key: string) {
    // 元数据决定是否为图片，来源只负责提供受控预览输入。
    const attachment = attachmentsByKey.get(key);
    const previewAttachment = previewAttachmentsByKey.get(key);
    if (!attachment) return null;
    if (attachment.kind === 'image' && previewAttachment) {
      return <ConversationPendingAttachmentImages key={key} attachments={[{ ...previewAttachment, kind: 'image' }]} language={props.language} />;
    }
    return (
      <span key={key} className="task-push-layout-attachment">
        {attachment.kind === 'image' ? (props.language === 'zh-CN' ? '图片预览不可用' : 'Image preview unavailable') : props.language === 'zh-CN' ? '附件' : 'Attachment'} · {attachment.name}
      </span>
    );
  }
  return (
    <section className="task-model-push-canonical task-push-layout" aria-label={props.language === 'zh-CN' ? '将发送的任务内容' : 'Task content to send'}>
      <strong>{props.language === 'zh-CN' ? '将发送的任务内容' : 'Task content to send'}</strong>
      {props.layout.blocks.map((block) => (
        <article key={`${block.contextKind}:${block.taskId ?? 'current'}`} className="task-push-layout-block">
          <header>
            <strong>
              {block.contextKind === 'current'
                ? block.taskTitle
                : `${block.contextKind === 'parent' ? (props.language === 'zh-CN' ? '父任务' : 'Parent task') : props.language === 'zh-CN' ? '关联任务' : 'Related task'}：${block.taskCode ?? block.taskId} · ${block.taskTitle}`}
            </strong>
          </header>
          {block.fields.map((field) => (
            <section key={field.field} className="task-push-layout-field">
              <strong>{field.label}：</strong>
              {field.attachmentKeys.map(renderAttachment)}
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
          <strong>{props.language === 'zh-CN' ? '补充信息：' : 'Additional information:'}</strong>
          {supplementalAttachments.map((attachment) => renderAttachment(attachment.key))}
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
        serviceTier: { type: 'standard' },
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
      serviceTier: { type: 'standard' },
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
    ...(form.workspaceModeSelected ? { workspaceMode: form.workspaceMode } : {}),
  });
  storage.setItem(
    `${preferencesKeyPrefix}${encodeURIComponent(projectId)}`,
    JSON.stringify({
      model: form.model,
      effort: form.effort,
      workMode: form.workMode,
      permissionMode: form.permissionMode,
      ...(form.workspaceModeSelected ? { workspaceMode: form.workspaceMode } : {}),
    }),
  );
}

export function resolveTaskModelPushInitialForm(
  capabilities: CodexTaskPushCapabilities,
  remembered: TaskModelPushPreferences | null,
  serviceTierPreferences: readonly ProjectModelServiceTierPreference[] = [],
  skillId = '',
): TaskModelPushForm {
  const availableModels = capabilities.models.filter((model) => model.available !== false);
  const rememberedModel = resolveModelCapability(availableModels, remembered?.model);
  // 已记住或已配置的模型失效时等待用户明确选择。
  const requestedModel = remembered?.model || capabilities.preferredModel;
  const selectedModel = requestedModel ? resolveModelCapability(availableModels, requestedModel) : availableModels[0];
  const effort = rememberedModel && remembered && selectedModel?.supportedReasoningEfforts.includes(remembered.effort) ? remembered.effort : (selectedModel?.defaultReasoningEffort ?? selectedModel?.supportedReasoningEfforts[0] ?? '');
  // 模型目录未就绪不能阻断本地仓库表单，模型到达后由既有选择器补齐模型能力。
  const normalizedServiceTier = selectedModel
    ? normalizeServiceTierSelection(projectModelServiceTierSelection(serviceTierPreferences, selectedModel), selectedModel)
    : { selection: remembered?.serviceTier ?? { type: 'standard' as const }, downgraded: false };
  const firstAvailableEnvironment = capabilities.existingEnvironments?.find((environment) => environment.available);
  return {
    model: selectedModel?.id ?? requestedModel ?? '',
    effort,
    serviceTier: normalizedServiceTier.selection,
    serviceTierDowngraded: normalizedServiceTier.downgraded,
    workMode: remembered?.workMode ?? 'default',
    // 用户已确认：项目没有成功记忆时，权限必须回退为只读。
    permissionMode: remembered?.permissionMode ?? 'read-only',
    skillId,
    workspaceMode: remembered?.workspaceMode ?? (capabilities.repositories.length > 0 ? 'worktree' : 'direct'),
    workspaceModeSelected: Boolean(remembered?.workspaceMode),
    workspaceModeResolved: capabilities.repositories.length > 0,
    taskBranchMode: 'create',
    environmentId: firstAvailableEnvironment?.id ?? '',
    directConcurrencyConfirmed: false,
    repositorySelections: Object.fromEntries(
      capabilities.repositories.map((repository) => {
        const currentSourceRef = repository.sourceRefs.find((source) => source.current)?.ref ?? '';
        return [
          repository.id,
          {
            // 来源默认使用真实当前本地分支，远端来源始终由用户明确选择。
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

/** 只更新仓库选择，保留整张推送草稿；仓库或来源消失时要求重新核对。 */
export function reconcileTaskPushRepositories(form: TaskModelPushForm, capabilities: CodexTaskPushCapabilities): TaskModelPushForm {
  /** 旧选择的键集合用于识别仓库新增或移除，首次加载不触发复核。 */
  const previousIds = Object.keys(form.repositorySelections);
  /** 已展示清单变化后不能静默改变本次隔离范围。 */
  const changed = previousIds.length > 0 && (previousIds.length !== capabilities.repositories.length || capabilities.repositories.some((repository) => !previousIds.includes(repository.id)));
  /** 已选来源消失后明确要求重选，禁止切换到其他默认分支。 */
  const sourceMissing = capabilities.repositories.some((repository) => {
    const sourceRef = form.repositorySelections[repository.id]?.sourceRef;
    return Boolean(sourceRef) && !repository.sourceRefs.some((source) => source.ref === sourceRef);
  });
  return {
    ...form,
    workspaceMode: form.workspaceModeSelected || form.workspaceModeResolved ? form.workspaceMode : capabilities.repositories.length > 0 ? 'worktree' : 'direct',
    workspaceModeResolved: form.workspaceModeResolved || capabilities.repositories.length > 0,
    repositorySelectionNeedsReview: form.repositorySelectionNeedsReview || changed || sourceMissing,
    repositorySelections: Object.fromEntries(
      capabilities.repositories.map((repository) => {
        /** 保留仍存在的来源及用户填写的新分支名，失效来源清空以要求重选。 */
        const previous = form.repositorySelections[repository.id];
        /** 来源失效时同时撤销带入原目录改动，避免重选来源后沿用旧勾选。 */
        const sourceAvailable = repository.sourceRefs.some((source) => source.ref === previous?.sourceRef);
        return [
          repository.id,
          previous
            ? { ...previous, sourceRef: sourceAvailable ? previous.sourceRef : '', includeLocalChanges: sourceAvailable && previous.includeLocalChanges }
            : {
                sourceRef: repository.sourceRefs.find((source) => source.current)?.ref ?? '',
                branchName: repository.suggestedBranchName,
                includeLocalChanges: false,
              },
        ];
      }),
    ),
  };
}

export function TaskModelPushModal(props: {
  open: boolean;
  language: 'zh-CN' | 'en-US';
  task: TaskRecord | null;
  projectName?: string;
  capabilities: CodexTaskPushCapabilities | null;
  runtimeCapabilities: CodexConversationCapabilities | null;
  serviceTierPreferences: readonly ProjectModelServiceTierPreference[];
  form: TaskModelPushForm;
  status: TaskModelPushModalStatus;
  refreshingRepositoryId: string | null;
  error: string | null;
  skillClient: Pick<CodexApiClient, 'loadSkills'> | null;
  onChange: Dispatch<SetStateAction<TaskModelPushForm>>;
  onServiceTierPreferenceChange: (model: CodexTaskPushModelCapability, selection: NativeServiceTierSelection) => void | Promise<void>;
  onRefreshRepository: (repositoryId: string) => void;
  /** 本地发现与各仓远端拉取分别操作。 */
  onRefreshLocalRepositories: () => void;
  /** 接入在同一任务流程内完成，不提交表单。 */
  onConnectModel?: () => void;
  /** 查询失败原地重新读取，不重建表单。 */
  onRetryModels?: () => void;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const commonSources = useMemo(() => resolveTaskPushCommonSources(props.capabilities?.repositories ?? []), [props.capabilities?.repositories]);
  /** 接入过程中表单状态保留，返回时恢复同一任务的阅读位置。 */
  const bodyRef = useRef<HTMLDivElement>(null);
  const readingPositionRef = useRef({ taskId: props.task?.id, scrollTop: 0, focusSelector: '[data-task-push-primary]' });
  if (readingPositionRef.current.taskId !== props.task?.id) readingPositionRef.current = { taskId: props.task?.id, scrollTop: 0, focusSelector: '[data-task-push-primary]' };
  useEffect(() => {
    if (!props.open) return;
    /** 接入返回后恢复触发位置；原控件不存在时回到确认操作。 */
    const frame = window.requestAnimationFrame(() => {
      /** 表单重新挂载后按稳定标识找到控件，不保留已卸载的节点。 */
      const form = bodyRef.current?.closest('form');
      const target = form?.querySelector<HTMLElement>(readingPositionRef.current.focusSelector) ?? form?.querySelector<HTMLElement>('[data-task-push-primary]');
      target?.focus({ preventScroll: true });
      if (bodyRef.current) bodyRef.current.scrollTop = readingPositionRef.current.scrollTop;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [props.open, props.task?.id]);
  const supplementalTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [supplementalResourceError, setSupplementalResourceError] = useState<string | null>(null);
  const repositoryRefreshError = props.capabilities?.repositories.find((repository) => repository.remoteRefreshError)?.remoteRefreshError ?? null;
  const resourceInputDisabled = !props.open || props.status === 'submitting';
  const inputResources = useConversationInputResources({
    language: props.language === 'zh-CN' ? 'zh-CN' : 'en',
    textareaRef: supplementalTextareaRef,
    text: props.form.supplementalInfo,
    disabled: resourceInputDisabled,
    onTextChange: (supplementalInfo) => props.onChange((current) => ({ ...current, supplementalInfo })),
    onAddAttachments: (attachments) => {
      setSupplementalResourceError(null);
      props.onChange((current) => ({ ...current, supplementalAttachments: mergeTaskPushSupplementalAttachments(current.supplementalAttachments, attachments) }));
    },
    onRemoveAttachment: (attachment) => {
      const identity = taskPushSupplementalAttachmentIdentity(attachment);
      props.onChange((current) => ({ ...current, supplementalAttachments: current.supplementalAttachments.filter((candidate) => taskPushSupplementalAttachmentIdentity(candidate) !== identity) }));
    },
    onError: setSupplementalResourceError,
  });
  useEffect(() => {
    setSupplementalResourceError(null);
  }, [props.open, props.task?.id]);
  const runtimeCapabilities = props.capabilities ?? props.runtimeCapabilities;
  const codexAccount = props.runtimeCapabilities?.codexAccount ?? props.capabilities?.codexAccount;
  const requestedModel = resolveModelCapability(runtimeCapabilities?.models, props.form.model);
  const modelPresentation = useMemo(() => presentModelOptions(runtimeCapabilities?.models ?? [], requestedModel?.id ?? props.form.model, props.language), [props.form.model, props.language, requestedModel?.id, runtimeCapabilities?.models]);
  // 目录变化不能静默替换用户选中的模型；失效时保留原选择并请求处理。
  const selectedModel = requestedModel?.available === false ? undefined : requestedModel;
  if (!props.open || !props.task) return null;
  const zh = props.language === 'zh-CN';
  const busy = props.status === 'submitting' || inputResources.processing;
  const codexLoginRequired = selectedModel?.agentKind !== 'pi' && selectedModel?.sourceId === 'codex' && codexAccount?.requiresOpenaiAuth === true && !codexAccount.signedIn;
  /** 只有已完成的能力查询才能判定需要接入；查询失败保持为失败。 */
  const modelSetupRequired = Boolean(props.capabilities) && (!selectedModel || codexLoginRequired);
  const repositories = props.capabilities?.repositories ?? [];
  /** 后台扫描状态不清空上一次可用仓库，也不限制直接目录和已有环境。 */
  const discovery = props.capabilities?.repositoryDiscovery;
  const existingEnvironments = props.capabilities?.existingEnvironments ?? [];
  const availableEnvironments = existingEnvironments.filter((environment) => environment.available);
  const selectedEnvironment = existingEnvironments.find((environment) => environment.id === props.form.environmentId);
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
    const capability = resolveModelCapability(runtimeCapabilities?.models, model);
    const normalizedTier = normalizeServiceTierSelection(projectModelServiceTierSelection(props.serviceTierPreferences, capability), capability);
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
      <form
        className="task-model-push-modal zeus-solid-form-surface"
        role="dialog"
        aria-modal="true"
        aria-labelledby="task-model-push-title"
        onSubmit={props.onSubmit}
        onKeyDown={handleKeyDown}
        onFocusCapture={(event) => {
          /** 保存接入按钮或具备稳定标识的输入框，返回时保持键盘位置。 */
          const target = event.target;
          if (!(target instanceof HTMLElement)) return;
          if (target.matches('.task-model-connect-link')) readingPositionRef.current.focusSelector = '.task-model-connect-link';
          else if (target.matches('[data-task-push-primary]')) readingPositionRef.current.focusSelector = '[data-task-push-primary]';
          else if (target.id) readingPositionRef.current.focusSelector = `#${CSS.escape(target.id)}`;
        }}
      >
        <header className="task-model-push-header">
          <span>
            <strong id="task-model-push-title">{zh ? '推送任务' : 'Push task'}</strong>
            <small>{props.projectName ? `${props.projectName} · ${props.task.taskCode ?? props.task.id}` : (props.task.taskCode ?? props.task.id)}</small>
          </span>
          <button type="button" aria-label={zh ? '关闭' : 'Close'} onClick={props.onClose} disabled={busy}>
            ×
          </button>
        </header>

        <div
          ref={bodyRef}
          className="task-model-push-body"
          onScroll={(event) => {
            readingPositionRef.current.scrollTop = event.currentTarget.scrollTop;
          }}
        >
          <p className="task-flow-context task-push-task-title">{props.task.title}</p>
          {props.error || supplementalResourceError || repositoryRefreshError ? (
            <div className="task-flow-feedback" role="status">
              <VisibleApplicationError error={props.error ?? supplementalResourceError ?? repositoryRefreshError} language={zh ? 'zh-CN' : 'en'} />
              {props.error && props.onRetryModels ? (
                <Button variant="secondary" size="compact" onClick={props.onRetryModels} disabled={busy || props.status === 'loading'}>
                  {zh ? '重新检查' : 'Check again'}
                </Button>
              ) : null}
            </div>
          ) : null}
          {modelSetupRequired ? (
            <p className="task-flow-feedback" role="status">
              {zh ? '连接一个可用模型后即可推送。当前任务与填写内容会保留。' : 'Connect an available model to push. Your task and entered details will be preserved.'}
            </p>
          ) : null}
          <div className="task-model-push-config-grid">
            <label>
              <span>{zh ? '模型' : 'Model'}</span>
              <ZeusSelect
                size="regular"
                ariaLabel={zh ? '模型' : 'Model'}
                value={props.form.model}
                options={modelPresentation.options}
                triggerLabel={selectedModel ? modelPresentation.triggerLabel : props.form.model || (zh ? '选择或接入模型' : 'Choose or connect a model')}
                onChange={onModelChange}
                disabled={!runtimeCapabilities || modelPresentation.options.length === 0 || busy || Boolean(props.form.stageId)}
                searchPlaceholder={zh ? '搜索供应商或模型' : 'Search providers or models'}
                emptyLabel={zh ? '没有匹配模型' : 'No matching models'}
              />
            </label>
            <div className="task-model-push-config-grid task-model-push-model-options">
              <label>
                <span>Skill</span>
                <SkillSelector
                  client={props.skillClient}
                  projectId={props.task.projectId}
                  value={props.form.skillId}
                  onChange={(skillId) => props.onChange({ ...props.form, skillId })}
                  language={props.language}
                  disabled={busy}
                  ariaLabel={zh ? '推送任务使用的 Skill' : 'Skill for task push'}
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
                    disabled={busy || Boolean(props.form.stageId)}
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
                  onChange={(value) => {
                    if (!selectedModel) return;
                    const selection = serviceTierSelectionFromValue(value);
                    props.onChange({
                      ...props.form,
                      serviceTier: selection,
                      serviceTierDowngraded: !selectedModel.serviceTiers.some((tier) => tier.id === 'priority') && selection.type === 'catalog',
                    });
                    void props.onServiceTierPreferenceChange(selectedModel, selection);
                  }}
                  disabled={!selectedModel || busy || Boolean(props.form.stageId)}
                  searchable={false}
                />
              </label>
              {props.form.serviceTierDowngraded ? (
                <p className="task-model-push-warning" role="status">
                  {zh ? '当前模型不支持 Fast，本次将使用标准速度。' : 'The current model does not support Fast. This request will use standard speed.'}
                </p>
              ) : null}
            </div>
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
                disabled={busy || Boolean(props.form.stageId)}
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
                disabled={busy || Boolean(props.form.stageId)}
                searchable={false}
              />
            </label>
          </div>
          {props.form.stageId ? (
            <small className="task-model-push-stage-lock">
              {zh
                ? '本次使用任务阶段中设定的模型、速度和权限。若需调整，请返回任务详情修改尚未启动的阶段。'
                : 'This run uses the model, speed, and permissions set for the task stage. To change them, return to the task details and edit a stage that has not started.'}
            </small>
          ) : null}

          {props.onConnectModel && !modelSetupRequired ? (
            <Button className="task-model-connect-link" variant="secondary" size="compact" onClick={props.onConnectModel} disabled={busy}>
              {zh ? '接入其他模型' : 'Connect another model'}
            </Button>
          ) : null}
          <section className="task-model-push-workspace" aria-label={zh ? '本次推送工作区' : 'Workspace for this push'}>
            <span className="task-model-push-section-heading">
              <strong>{zh ? '本次推送工作区' : 'Workspace for this push'}</strong>
              <small>{zh ? '直接修改项目文件，或使用独立分支与工作目录（worktree）' : 'Edit project files directly, or use a separate branch and working folder (worktree)'}</small>
            </span>
            <fieldset className="task-model-push-mode-choice">
              <legend>{zh ? '工作方式' : 'Workspace mode'}</legend>
              <label className={props.form.workspaceMode === 'direct' ? 'is-selected' : undefined}>
                <input
                  type="radio"
                  name="task-workspace-mode"
                  value="direct"
                  checked={props.form.workspaceMode === 'direct'}
                  onChange={() => props.onChange({ ...props.form, workspaceMode: 'direct', workspaceModeSelected: true, directConcurrencyConfirmed: false })}
                  disabled={busy}
                />
                <span>
                  <strong>{zh ? '直接使用项目目录' : 'Use project directory directly'}</strong>
                  <small>{zh ? '修改会直接写入项目文件' : 'Changes are written directly to the project files'}</small>
                </span>
              </label>
              <label className={props.form.workspaceMode === 'worktree' ? 'is-selected' : undefined}>
                <input
                  type="radio"
                  name="task-workspace-mode"
                  value="worktree"
                  checked={props.form.workspaceMode === 'worktree'}
                  onChange={() => props.onChange({ ...props.form, workspaceMode: 'worktree', workspaceModeSelected: true, directConcurrencyConfirmed: false })}
                  disabled={busy}
                />
                <span>
                  <strong>Worktree</strong>
                  <small>{zh ? '自动发现全部 Git 仓库，并创建或继续独立任务分支' : 'Discover all Git repositories, then create or continue isolated task branches'}</small>
                </span>
              </label>
            </fieldset>
            <div className="task-model-push-section-heading">
              <span role="status" className={discovery?.status === 'failed' ? 'task-model-push-error' : 'task-model-push-message'}>
                {discovery?.status === 'running'
                  ? zh
                    ? '正在发现项目中的 Git 仓库…'
                    : 'Discovering Git repositories in this project…'
                  : discovery?.status === 'failed'
                    ? discovery.error
                    : discovery?.status === 'not_started'
                      ? zh
                        ? '尚未发现本地仓库，可刷新后选择分支。'
                        : 'Local repositories have not been discovered yet. Refresh to select branches.'
                      : zh
                        ? '本地 Git 仓库'
                        : 'Local Git repositories'}
              </span>
              <Button variant="secondary" size="compact" onClick={props.onRefreshLocalRepositories} busy={discovery?.status === 'running'} disabled={busy || discovery?.status === 'running'}>
                {zh ? (discovery?.status === 'failed' ? '重试发现仓库' : '刷新本地仓库') : discovery?.status === 'failed' ? 'Retry discovery' : 'Refresh local repositories'}
              </Button>
            </div>
            {props.form.workspaceMode === 'worktree' && props.form.taskBranchMode === 'create' && props.form.repositorySelectionNeedsReview ? (
              <label className="task-model-push-concurrency-confirm">
                <input type="checkbox" checked={false} disabled={busy} onChange={() => props.onChange({ ...props.form, repositorySelectionNeedsReview: false })} />
                <span>{zh ? '仓库清单或已选来源分支已变化，请重新选择失效来源，并核对下方清单后勾选确认。' : 'Repositories or selected source branches changed. Reselect unavailable sources, review the list below, then confirm.'}</span>
              </label>
            ) : null}
            {props.form.workspaceMode === 'worktree' && existingEnvironments.length > 0 ? (
              <fieldset className="task-model-push-mode-choice task-model-push-branch-choice">
                <legend>{zh ? '任务分支方式' : 'Task branch mode'}</legend>
                <label className={props.form.taskBranchMode === 'create' ? 'is-selected' : undefined}>
                  <input type="radio" name="task-branch-mode" value="create" checked={props.form.taskBranchMode === 'create'} onChange={() => props.onChange({ ...props.form, taskBranchMode: 'create' })} disabled={busy} />
                  <span>
                    <strong>{zh ? '创建新的任务分支' : 'Create new task branches'}</strong>
                    <small>{zh ? '从下方所选分支创建任务专用分支' : 'Create a task branch from the source branch selected below'}</small>
                  </span>
                </label>
                <label className={props.form.taskBranchMode === 'existing' ? 'is-selected' : undefined}>
                  <input
                    type="radio"
                    name="task-branch-mode"
                    value="existing"
                    checked={props.form.taskBranchMode === 'existing'}
                    onChange={() => props.onChange({ ...props.form, taskBranchMode: 'existing', environmentId: availableEnvironments[0]?.id ?? '' })}
                    disabled={busy || availableEnvironments.length === 0}
                  />
                  <span>
                    <strong>{zh ? '继续已有任务分支' : 'Continue existing task branches'}</strong>
                    <small>
                      {availableEnvironments.length > 0
                        ? zh
                          ? '创建新对话，继续使用原来的独立工作目录和分支'
                          : 'Start a new conversation using the existing separate working folder and branch'
                        : zh
                          ? '现有任务分支正在写入或已部分关闭'
                          : 'Existing task branches are active or partially closed'}
                    </small>
                  </span>
                </label>
              </fieldset>
            ) : null}
            {props.form.workspaceMode === 'direct' ? (
              <div className="task-model-push-direct-summary">
                <small>
                  {zh ? '工作目录' : 'Working directory'}：{props.capabilities?.directWorkspace.path ?? '—'}
                </small>
                <p className="task-model-push-warning">{zh ? 'AI 将直接修改此目录中的文件，影响当前项目和 Git 分支。' : 'The AI will edit files directly in this folder, affecting the current project and Git branch.'}</p>
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
            ) : props.form.taskBranchMode === 'existing' ? (
              <section className="task-model-push-existing-environment" aria-labelledby="task-model-push-existing-environment-title">
                <span className="task-model-push-section-heading">
                  <strong id="task-model-push-existing-environment-title">{zh ? '选择已有任务分支' : 'Choose existing task branches'}</strong>
                  <small>{zh ? '多仓库任务会继续使用原来的全部工作目录' : 'Tasks with multiple repositories will keep using all their original working folders'}</small>
                </span>
                <ZeusSelect
                  size="regular"
                  ariaLabel={zh ? '选择已有任务分支' : 'Choose existing task branches'}
                  value={props.form.environmentId}
                  options={existingEnvironments.map((environment) => ({
                    value: environment.id,
                    label: taskPushEnvironmentLabel(environment, zh),
                    group: environment.available ? (zh ? '可继续' : 'Available') : zh ? '暂不可用' : 'Unavailable',
                    disabled: !environment.available,
                  }))}
                  onChange={(environmentId) => props.onChange({ ...props.form, environmentId })}
                  disabled={busy || availableEnvironments.length === 0}
                  searchPlaceholder={zh ? '搜索任务分支或仓库' : 'Search task branches or repositories'}
                  emptyLabel={zh ? '没有匹配的任务分支' : 'No matching task branches'}
                />
                {selectedEnvironment ? (
                  <ul className="task-model-push-existing-repositories">
                    {selectedEnvironment.repositories.map((repository) => (
                      <li key={`${repository.repositoryId ?? repository.repositoryRelativePath}:${repository.branchName}`}>
                        <span>{repository.repositoryName}</span>
                        <code>{repository.branchName}</code>
                        <small>{zh ? `来源：${repository.sourceBranch}` : `Source: ${repository.sourceBranch}`}</small>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="task-model-push-error" role="alert">
                    {zh ? '请选择一组当前可继续的任务分支。' : 'Choose a task branch environment that is currently available.'}
                  </p>
                )}
              </section>
            ) : !props.capabilities ? (
              <p className={props.status === 'error' ? 'task-model-push-error' : 'task-model-push-message'} role="status">
                {props.status === 'error' ? (
                  <VisibleApplicationError error={props.error ?? (zh ? 'Git 仓库检查未完成。' : 'The Git repository check did not complete.')} language={zh ? 'zh-CN' : 'en'} />
                ) : zh ? (
                  '正在读取任务工作区与 Git 仓库…'
                ) : (
                  'Loading the task workspace and Git repositories…'
                )}
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
                      {repository.unavailableReason ? (
                        <p className="task-model-push-error" role="alert">
                          {repository.unavailableReason}
                        </p>
                      ) : null}
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
                        {repository.remoteRefreshError ? (
                          <VisibleApplicationError error={repository.remoteRefreshError} language={zh ? 'zh-CN' : 'en'} />
                        ) : repository.remoteRefreshStatus === 'succeeded' ? (
                          zh ? (
                            '远端分支已手动刷新。来源分支仍由你选择。'
                          ) : (
                            'Remote branches were refreshed manually. The source branch remains your choice.'
                          )
                        ) : repository.defaultRemoteName ? (
                          zh ? (
                            '当前展示本地分支和本机已知的远端分支；需要最新远端状态时再手动刷新。'
                          ) : (
                            'Local branches and locally known remote branches are shown. Refresh manually when current remote state is needed.'
                          )
                        ) : zh ? (
                          '该仓库没有远端，将使用本地分支的代码。默认不包含未提交的修改。'
                        ) : (
                          'This repository has no remote, so local branch code will be used. Uncommitted changes are excluded by default.'
                        )}
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
                          <span>{zh ? '包含当前项目目录中尚未提交的修改。' : 'Include uncommitted changes from the current project folder.'}</span>
                        </label>
                      ) : null}
                    </fieldset>
                  );
                })}
              </div>
            ) : discovery?.status === 'completed' ? (
              <p className="task-model-push-error" role="alert">
                {zh ? '项目目录下没有发现 Git 仓库。请先自行初始化仓库，或改用“直接使用项目目录”。' : 'No Git repository was found. Initialize one first, or use the project directory directly.'}
              </p>
            ) : null}
            {props.form.workspaceMode === 'worktree' && props.form.taskBranchMode === 'create' ? (
              <small className="task-model-push-worktree-root">
                {zh ? '新工作区路径' : 'New workspace path'}：{props.capabilities?.git.worktreeRoot ?? '—'}/&lt;{zh ? '项目' : 'project'}&gt;/&lt;{zh ? '推送标识' : 'push-id'}&gt;/{props.task.taskCode ?? props.task.id}
              </small>
            ) : null}
          </section>

          <section className="task-model-push-supplement" aria-busy={inputResources.processing || undefined} aria-labelledby="task-model-push-supplement-label">
            <label id="task-model-push-supplement-label" htmlFor="task-model-push-supplement-input">
              {zh ? '补充信息（可选）' : 'Supplemental information (optional)'}
            </label>
            <TaskPushSupplementalAttachmentCards
              attachments={props.form.supplementalAttachments}
              language={props.language}
              disabled={busy}
              onRemove={(attachment) => {
                const identity = taskPushSupplementalAttachmentIdentity(attachment);
                props.onChange((current) => ({ ...current, supplementalAttachments: current.supplementalAttachments.filter((candidate) => taskPushSupplementalAttachmentIdentity(candidate) !== identity) }));
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
          </section>

          <TaskPushCurrentConversationPicker
            options={currentConversationOptions}
            selectedIds={props.form.currentConversationIds}
            busy={busy}
            zh={zh}
            onChange={(currentConversationIds) => props.onChange((current) => ({ ...current, currentConversationIds }))}
          />

          <TaskPushContextPicker kind="parent" options={parentContextOptions} selections={props.form.parentContextSelections} busy={busy} zh={zh} onChange={(taskId, selection) => changeContextSelection('parent', taskId, selection)} />
          <TaskPushContextPicker kind="related" options={relatedContextOptions} selections={props.form.relatedContextSelections} busy={busy} zh={zh} onChange={(taskId, selection) => changeContextSelection('related', taskId, selection)} />

          <TaskPushLayoutPreview layout={taskPushLayout} language={props.language} previewAttachments={[...(props.capabilities?.attachmentPreviewSources ?? []), ...props.form.supplementalAttachments]} />
          {props.status === 'loading' ? (
            <p className="task-model-push-message">
              {runtimeCapabilities ? (zh ? '正在读取任务上下文、模型配置与工作目录…' : 'Loading task context, model configuration and working folder…') : zh ? '正在读取模型配置…' : 'Loading model configuration…'}
            </p>
          ) : null}
        </div>

        <footer className="task-model-push-footer">
          <small>
            {modelSetupRequired
              ? zh
                ? '接入完成后返回这里，再次确认才会开始。'
                : 'After setup, return here and confirm again to start.'
              : zh
                ? '确认后创建会话，开始执行这个任务。'
                : 'Confirm to create a conversation and start this task.'}
          </small>
          <span>
            <Button variant="secondary" size="regular" onClick={props.onClose} disabled={props.status === 'submitting'}>
              {zh ? '取消' : 'Cancel'}
            </Button>
            <Button
              data-task-push-primary
              type={modelSetupRequired && props.onConnectModel ? 'button' : 'submit'}
              onClick={modelSetupRequired ? props.onConnectModel : undefined}
              variant="primary"
              size="regular"
              busy={busy}
              disabled={
                busy ||
                !props.capabilities ||
                props.status === 'loading' ||
                (!modelSetupRequired && (!props.form.model || !selectedModel)) ||
                (!modelSetupRequired &&
                  (props.form.workspaceMode === 'direct'
                    ? directWorkspaceNeedsConfirmation && !props.form.directConcurrencyConfirmed
                    : props.form.taskBranchMode === 'existing'
                      ? !selectedEnvironment?.available
                      : !discovery?.completedAt ||
                        Boolean(props.form.repositorySelectionNeedsReview) ||
                        repositories.length === 0 ||
                        repositories.some((repository) => {
                          const selection = props.form.repositorySelections[repository.id];
                          return !selection?.sourceRef || !selection.branchName.trim();
                        })))
              }
            >
              {props.status === 'submitting' ? (zh ? '正在推送…' : 'Pushing…') : modelSetupRequired ? (zh ? '连接模型' : 'Connect a model') : zh ? '推送任务' : 'Push task'}
            </Button>
          </span>
        </footer>
      </form>
    </ModalPortal>
  );
  return modal;
}
