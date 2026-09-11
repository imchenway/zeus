import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ModelSelectQa } from './model-select-qa.js';
import { asyncMessageQuestions, buildTaskPushLayout, describeUserFacingError, formatAsyncQuestionAnswer, type ConversationNavigationEntry, type UserFacingErrorCause } from '@zeus/shared';
import { ConversationTranscript, MessageDeliveryOutcomeFeedback } from '../src/renderer/session/ConversationTranscript.js';
import { ApplicationErrorDialogHost, VisibleApplicationError } from '../src/renderer/ui/ApplicationErrorDialog.js';
import { Button } from '../src/renderer/ui/Button.js';
import { ConversationMarkdown } from '../src/renderer/session/ConversationMarkdown.js';
import { ConversationInlineResource } from '../src/renderer/session/ConversationResources.js';
import { ConversationComposer, type ComposerRuntimeSettings } from '../src/renderer/session/ConversationComposer.js';
import { SessionActivityGroup } from '../src/renderer/session/SessionActivity.js';
import { SubagentWorkspace } from '../src/renderer/session/SubagentWorkspace.js';
import { RuntimeDetails } from '../src/renderer/session/RuntimeDetails.js';
import type { NativeConversationAttachment, NativeRuntimeDetailsSnapshot, NativeSessionItemBuffer, NativeSessionState, NativeSubagentSummary, NativeSubagentThreadSnapshot } from '../src/renderer/session/sessionTypes.js';
import { TaskPushLayoutPreview } from '../src/renderer/task/TaskModelPushModal.js';
import { TurnChangeCard, TurnDiffWorkspace } from '../src/renderer/session/TurnChanges.js';
import { ThreadItemView } from '../src/renderer/session/ThreadItemView.js';
import { ProjectConversationTree } from '../src/renderer/session/ProjectConversationTree.js';
import type { NativeConversationChoice } from '../src/renderer/session/sessionTypes.js';
import { TaskGitDiffTable } from '../src/renderer/task/TaskGitDiffTable.js';
import type { ConversationCodeComment, ConversationResource, ConversationResponseAnnotation, TurnChangeSet } from '@zeus/shared';
import { ModalPortal } from '../src/renderer/ui/ModalPortal.js';
import { AsyncQuestionPanel } from '../src/renderer/session/AsyncQuestionMessage.js';
import { normalizeRequestQuestions, RequestUserInputPanel } from '../src/renderer/session/PendingRequestSurface.js';
import { PlanImplementationRequestSurface } from '../src/renderer/session/PlanImplementationRequestSurface.js';
import { createInitialSessionState } from '../src/renderer/session/sessionReducer.js';
import type { ComposerInputHandle } from '../src/renderer/session/MarkdownComposerEditor.js';
import { buildTaskCreateInitialForm, getLanguageCopy, TaskCreateModal } from '../src/renderer/features/workspace/workspaceSupport.js';

interface QaScene {
  query: string;
  title: string;
  summary: string;
  answer: string;
  activities: Array<{ type: string; status: string; text?: string; payload?: Record<string, unknown> }>;
}

const scenes: QaScene[] = [
  { query: 'navigation', title: '完整历史刻度', summary: '生产时间线的长历史定位与动效记录。', answer: '', activities: [] },
  { query: 'queue-actions', title: '排队消息操作', summary: '按真实送达状态核对删除、引导和状态检查入口。', answer: '', activities: [] },
  { query: 'conversation-visibility', title: '进行中会话展示', summary: '进行中的会话不受普通会话数量限制。', answer: '', activities: [] },
  { query: 'message-layout', title: '消息间距与耗时', summary: '真实时间线的耗时入口与悬停操作栏。', answer: '', activities: [] },
  { query: 'model-select', title: '模型选择与置顶', summary: '共享选择框的分组、焦点、搜索和持久置顶。', answer: '', activities: [] },
  { query: 'paste-focus', title: '附件粘贴焦点', summary: '真实任务输入的异步附件与光标保持。', answer: '', activities: [] },
  { query: 'composer', title: '粘贴 Markdown', summary: '真实输入组件的 Markdown 排版、直接编辑和发送原文。', answer: '', activities: [] },
  { query: 'error-layout', title: '会话错误提示预览', summary: '已确认的提示样式直接来自会话组件。', answer: '', activities: [] },
  { query: 'review', title: 'Markdown 变更审核', summary: '真实审核组件的预览、差异与读取状态。', answer: '', activities: [] },
  { query: 'questions', title: '询问表单', summary: 'PLAN 和异步询问复用相同组件；这里仅模拟提交结果。', answer: '', activities: [] },
  { query: 'plan-implementation', title: '计划确认与修改', summary: '真实计划确认卡片的单行尺寸、自适应输入和行尾操作。', answer: '', activities: [] },
  { query: 'images', title: '推送图片预览', summary: '检查四类同名图片、失败态、重渲染和嵌套弹窗。', answer: '', activities: [] },
  { query: 'copy', title: '提示语与错误操作', summary: '中英文真实消息提示组件', answer: '', activities: [] },
  {
    query: 'overview',
    title: '会话核心组件',
    summary: '一份数据同时驱动浅色和深色真实组件。',
    answer: '已收缩为一个场景表：\n\n- 正文使用 `ConversationMarkdown`\n- 活动使用 `SessionActivityGroup`\n- 样式直接来自生产 Renderer',
    activities: [
      { type: 'commandExecution', status: 'completed', payload: { command: ['pnpm', 'lint'] } },
      { type: 'fileChange', status: 'completed', payload: { path: 'apps/desktop/src/renderer/session/ConversationTranscript.tsx' } },
    ],
  },
  {
    query: 'motion',
    title: '进行中活动焦点',
    summary: '只保留会话动效的最小真实组件链。',
    answer: '正在收口最后一项工作。',
    activities: [
      { type: 'commandExecution', status: 'completed', payload: { command: ['pnpm', 'typecheck'] } },
      { type: 'webSearch', status: 'completed', payload: { query: 'Zeus 会话视觉验收' } },
      { type: 'commandExecution', status: 'in_progress', payload: { command: ['pnpm', 'build'] } },
    ],
  },
  {
    query: 'error',
    title: '失败态可读性',
    summary: '用一条真实失败活动核对文字、层级和对比度。',
    answer: '操作未完成，错误详情保持可见。',
    activities: [{ type: 'commandExecution', status: 'failed', payload: { command: ['pnpm', 'package:mac'], error: 'Package probe failed.' } }],
  },
];

function activity(scene: QaScene, index: number): NativeSessionItemBuffer {
  const source = scene.activities[index]!;
  const id = `${scene.query}-${index + 1}`;
  return {
    key: `qa:${id}`,
    conversationId: 'qa-conversation',
    threadId: 'qa-thread',
    turnId: 'qa-turn',
    itemId: id,
    type: source.type,
    status: source.status,
    phase: 'prework',
    text: source.text ?? '',
    payload: source.payload ?? {},
    resources: [],
    updatedAt: '2026-09-02T00:00:00.000Z',
  };
}

export function sceneFromSearch(search: string): QaScene {
  const parameters = new URLSearchParams(search);
  return scenes.find((scene) => parameters.has(scene.query)) ?? scenes[0]!;
}

/** 统一挂载验收场景，界面就绪回报覆盖每个入口。 */
export function SessionQaApp(props: { scene: QaScene }) {
  // 完整测试包通过开发入口承载 QA 时，只有组件实际挂载后才报告界面就绪。
  useEffect(() => {
    window.zeus?.reportRendererBootstrapReady?.();
  }, []);
  if (props.scene.query === 'navigation') return <NavigationQa />;
  if (props.scene.query === 'conversation-visibility') return <ConversationVisibilityQa />;

  if (props.scene.query === 'queue-actions') return <QueueActionsQa />;
  if (props.scene.query === 'message-layout') return <MessageLayoutQa />;
  if (props.scene.query === 'model-select') return <ModelSelectQa />;
  if (props.scene.query === 'error-layout') return <ErrorLayoutQa />;
  if (props.scene.query === 'paste-focus') return <TaskPasteFocusQa />;
  if (props.scene.query === 'composer') return <ComposerMarkdownQa />;
  if (props.scene.query === 'review') return <MarkdownReviewQa />;
  if (props.scene.query === 'questions') return <QuestionQa />;
  if (props.scene.query === 'plan-implementation') return <PlanImplementationQa />;
  if (props.scene.query === 'images') return <TaskPushImagesQa />;
  if (props.scene.query === 'copy') return <CopyErrorQa />;
  const items = props.scene.activities.map((_, index) => activity(props.scene, index));
  return (
    <main className="macos-ai-app zeus-shell qa-page">
      <header className="qa-heading">
        <p>2026-09-02 · 数据驱动视觉验收</p>
        <h1>{props.scene.title}</h1>
        <span>{props.scene.summary}</span>
      </header>
      <div className="qa-themes">
        {(['light', 'dark'] as const).map((theme) => (
          <section className={`qa-theme theme-${theme}`} data-theme={theme} key={theme}>
            <p className="qa-user-message">请检查当前会话状态。</p>
            <SessionActivityGroup items={items} language="zh-CN" category="mixed" motionActive />
            <article className="qa-answer">
              <ConversationMarkdown text={props.scene.answer} streamId={`qa:${props.scene.query}`} phase="final" language="zh-CN" />
            </article>
          </section>
        ))}
      </div>
      <nav className="qa-scenes" aria-label="QA 场景">
        {scenes.map((scene) => (
          <a href={`?${scene.query}`} aria-current={scene === props.scene ? 'page' : undefined} key={scene.query}>
            {scene.title}
          </a>
        ))}
      </nav>
    </main>
  );
}

/** 使用生产会话树检查数量截断、实时状态、搜索和展开更多。 */
function ConversationVisibilityQa() {
  /** 沿用侧栏默认普通会话额度与每次追加数量。 */
  const [limit, setLimit] = useState(6);
  /** 运行结束后恢复普通会话额度，避免永久保留旧运行标记。 */
  const [running, setRunning] = useState(true);
  /** 搜索结果应全部展示，不受额度影响。 */
  const [query, setQuery] = useState('');
  /** 选择记录用于验证额外显示的会话可以正常进入。 */
  const [selected, setSelected] = useState<string | null>(null);
  /** 人工检查直接读取生产树的可见条目。 */
  const surface = useRef<HTMLDivElement>(null);
  /** 将检查结果显示在页面，便于保存运行证据。 */
  const [result, setResult] = useState('等待检查');
  /** 运行会话故意排在 14 条普通会话之后，复现旧截断隐藏活动现场。 */
  const conversations: NativeConversationChoice[] = Array.from({ length: 24 }, (_, index) => ({
    id: `qa-sidebar-${index + 1}`,
    navigationId: `qa-navigation-${index + 1}`,
    projectId: 'qa-project',
    taskId: null,
    title: `${index < 14 ? '普通会话' : '运行会话'} ${index + 1}`,
    summary: null,
    status: 'ready',
    stage: 'completed',
    stageUpdatedAt: new Date(Date.UTC(2026, 8, 10, 2, 0, 24 - index)).toISOString(),
    transportKind: 'codex_native',
    providerId: 'qa-provider',
    providerThreadId: null,
    providerModel: null,
    providerState: null,
    createdAt: '2026-09-10T02:00:00Z',
    updatedAt: '2026-09-10T02:00:00Z',
    archived: false,
    hasUnreadAttention: false,
    attentionKind: null,
    attentionRevision: 0,
    attentionTurnId: null,
    attentionUpdatedAt: null,
    pendingRequestKind: null,
    listRuntimeState: running && index >= 14 && index < 23 ? (['streaming', 'queued', 'connecting', 'reconnecting'] as const)[index % 4] : 'ready',
    resumable: true,
    readOnly: false,
  }));
  /** 同一个项目混合直属会话和任务会话，验证合并后的统一截断。 */
  const group = {
    projectId: 'qa-project',
    projectName: '会话可见性预览',
    conversations: conversations.slice(0, 12),
    taskStatuses: [],
    tasks: conversations.slice(12).map((conversation) => ({ taskId: conversation.id, taskCode: '预览任务', taskTitle: conversation.title, managementStatus: 'running', conversations: [conversation] })),
  };
  /** 精确检查结果身份与顺序，最后一条的实时导航状态覆盖目录中的 ready。 */
  function checkVisible(): void {
    /** 预览期望保留前若干普通会话和全部运行会话，搜索时不截断。 */
    const expected = conversations
      .filter((conversation, index) => (query.trim() ? conversation.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()) : (running && index >= 14) || index < limit))
      .map((conversation) => conversation.title);
    /** 读取完整标题，避免可见数量正确但条目身份或顺序错误。 */
    const actual = [...(surface.current?.querySelectorAll('.session-conversation-title') ?? [])].map((element) => element.textContent);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`会话展示检查失败：${JSON.stringify(actual)}`);
    setResult(`运行检查通过：展示 ${actual.length} 条会话，普通额度 ${limit}，${running ? '10 条进行中' : '运行已结束'}`);
  }
  return (
    <main className="macos-ai-app zeus-shell session-codex-parity-v1 qa-error-layout theme-light" data-theme="light">
      <header className="qa-error-layout-heading">
        <div>
          <h1>进行中会话展示</h1>
          <p>14 条普通会话之后排列 10 条进行中的会话，默认额度为 6。</p>
        </div>
        <nav aria-label="预览设置">
          <input type="search" aria-label="搜索会话" value={query} onChange={(event) => setQuery(event.target.value)} />
          <Button aria-pressed={!running} onClick={() => setRunning((current) => !current)}>
            切换运行结束
          </Button>
          <Button
            onClick={() => {
              setLimit(6);
              setQuery('');
              setRunning(true);
            }}
          >
            恢复默认
          </Button>
          <Button onClick={checkVisible}>检查会话展示</Button>
        </nav>
      </header>
      <p role="status" className="qa-error-layout-note">
        {result}
        {selected ? `；已选择 ${selected}` : ''}
      </p>
      <div ref={surface} style={{ maxWidth: 340, marginInline: 'auto' }}>
        <ProjectConversationTree
          groups={[group]}
          language="zh-CN"
          compactProjectLabel
          query={query}
          visibleConversationCount={limit}
          conversationStates={{ 'qa-navigation-24': running ? 'streaming' : 'ready' }}
          selectedConversationId={selected}
          onSelectConversation={(conversation) => setSelected(conversation.navigationId!)}
          onShowMore={() => setLimit((current) => current + 10)}
        />
      </div>
    </main>
  );
}

/** 复现真实队列投影与消息布局，只操作预览数据，不连接模型或正式数据。 */
function QueueActionsQa() {
  /** 地址参数可直接定位待验收状态。 */
  const parameters = new URLSearchParams(window.location.search);
  /** 正常排队作为默认视觉对照，其他状态用于验证权限和恢复提示。 */
  const [scenario, setScenario] = useState(parameters.get('state') ?? 'queued');
  /** 内容样本覆盖短消息、长文本、附件和连续排队。 */
  const [sample, setSample] = useState(parameters.get('sample') ?? 'reference');
  /** 主题与窄栏只改变本页，不写入应用设置。 */
  const [dark, setDark] = useState(parameters.has('dark'));
  /** 通过真实内容容器复现任务窄分栏。 */
  const [narrow, setNarrow] = useState(parameters.has('narrow'));
  /** 中英文沿用生产组件的文案。 */
  const [language, setLanguage] = useState<'zh-CN' | 'en-US'>(parameters.has('en') ? 'en-US' : 'zh-CN');
  /** 可复现异步操作中的禁用与失败反馈。 */
  const [failAction, setFailAction] = useState(false);
  /** 保留每条原提交的操作结果，便于检查连续队列。 */
  const [outcomes, setOutcomes] = useState<Record<string, 'accepted' | 'deleted'>>({});
  /** 检查只读取当前场景中的生产组件。 */
  const surface = useRef<HTMLDivElement>(null);
  /** 显示操作回调与人工运行检查结果。 */
  const [result, setResult] = useState('等待检查');
  /** 定稿对照文本与英文文本具有同一含义。 */
  const reference = language === 'zh-CN' ? '而且主智能体发送给子智能体的提示词为什么没显示?' : 'Why are the prompts sent from the main agent to subagents not displayed?';
  /** 长文本保留 Markdown 结构，并触发原有展开全文入口。 */
  const content =
    sample === 'short'
      ? language === 'zh-CN'
        ? '好'
        : 'OK'
      : sample === 'long'
        ? `${reference}\n\n${(language === 'zh-CN' ? '请保留每条消息的原始顺序，并确认附件与执行状态清晰可见。\n\n' : 'Keep the original message order, with attachments and execution state clearly visible.\n\n').repeat(26)}`
        : reference;
  /** 多条消息共享权威队列，队首之外的引导由生产逻辑禁用。 */
  const submissions = (sample === 'multiple' ? [content, language === 'zh-CN' ? '好' : 'OK', language === 'zh-CN' ? '也请检查深色主题。' : 'Also check the dark theme.'] : [content])
    .map((text, index) => ({
      id: `qa-submission-${index + 1}`,
      content: text,
      position: index + 1,
      status: scenario === 'accepted' || outcomes[`qa-submission-${index + 1}`] === 'accepted' ? 'resolved' : scenario === 'queued' || scenario === 'restoring' ? 'queued' : 'paused',
      pausedReason: ['queued', 'accepted', 'restoring'].includes(scenario) ? null : scenario,
      providerTurnId: scenario === 'accepted' || outcomes[`qa-submission-${index + 1}`] === 'accepted' ? 'qa-turn' : null,
      createdAt: '2026-09-10T02:00:00Z',
      attachments: sample === 'attachment' ? [{ name: '排队消息说明.md', mime: 'text/markdown', size: 128, kind: 'file' as const, localPath: '/qa/排队消息说明.md' }] : [],
      error:
        scenario === 'outcome_unknown' || scenario === 'recovery_required' ? { code: 'ZEUS_CODEX_RPC_PROTOCOL_ERROR', message: 'Codex 响应无法读取，已发出的操作需要核对结果。', recoveryRequired: scenario === 'recovery_required' } : null,
    }))
    .filter((submission) => outcomes[submission.id] !== 'deleted');
  /** 已接纳消息恢复为普通历史，检查底栏消失后不会重复正文或遗留占位。 */
  const acceptedItems: NativeSessionItemBuffer[] = submissions
    .filter((submission) => submission.status === 'resolved')
    .map((submission) => ({
      key: submission.id,
      itemId: submission.id,
      localItemId: submission.id,
      conversationId: 'qa-queue',
      threadId: 'qa-thread',
      turnId: 'qa-turn',
      type: 'userMessage',
      status: 'completed',
      phase: 'user',
      text: submission.content,
      payload: { submissionId: submission.id, attachments: submission.attachments },
      resources: [],
      updatedAt: submission.createdAt,
    }));
  /** 活动轮次确保普通队列正在等待，恢复原因直接传给生产投影。 */
  const state: NativeSessionState = {
    ...createInitialSessionState(),
    conversationId: 'qa-queue',
    transportState: 'ready',
    activeTurnId: 'qa-turn',
    startedTurnId: 'qa-turn',
    conversationState: 'active_prework',
    items: Object.fromEntries(acceptedItems.map((item) => [item.key, item])),
    itemOrder: acceptedItems.map((item) => item.key),
    queue: { state: { type: 'active', turnId: 'qa-turn', phase: 'prework' }, submissions, waitReason: scenario === 'restoring' ? 'conversation_restoring' : null },
  };
  /** 切换场景时清除本页模拟结果，避免上一场景影响新的操作检查。 */
  function resetPreview(): void {
    setOutcomes({});
    setResult('等待检查');
  }
  /** 延迟只用于观察真实按钮的处理中状态；失败不改变原提交。 */
  async function runAction(id: string, outcome: 'accepted' | 'deleted'): Promise<void> {
    setResult(`操作处理中：${id}`);
    await new Promise((resolve) => window.setTimeout(resolve, 1200));
    if (failAction) {
      setResult(`操作失败，原消息保留：${id}`);
      throw new Error('预览操作失败，原消息保留。');
    }
    setOutcomes((current) => ({ ...current, [id]: outcome }));
    setResult(`${outcome === 'accepted' ? '引导' : '删除'}回调已触发：${id}`);
  }
  /** 沿用既有运行检查，确认状态变化没有重新开放未知送达消息的操作。 */
  function checkActions(): void {
    /** 已接纳消息退出队列操作，其余按真实状态计算可见入口。 */
    const pendingCount = submissions.filter((submission) => submission.status !== 'resolved').length;
    /** 正常排队与已确认未发送可取消，恢复期间仍由生产权限控制。 */
    const expectedDelete = ['queued', 'restoring', 'recovered_unsent'].includes(scenario) ? pendingCount : 0;
    /** 引导入口只在 queued 状态显示，不可用原因由生产组件说明。 */
    const expectedSteer = ['queued', 'restoring'].includes(scenario) ? pendingCount : 0;
    /** 两种结果未知状态都仅提供检查处理状态。 */
    const expectedCheck = ['outcome_unknown', 'recovery_required'].includes(scenario) ? pendingCount : 0;
    if (
      surface.current?.querySelectorAll('.session-queued-thread-delete').length !== expectedDelete ||
      surface.current?.querySelectorAll('.session-queued-thread-steer').length !== expectedSteer ||
      [...(surface.current?.querySelectorAll('button') ?? [])].filter((button) => button.textContent === (language === 'zh-CN' ? '检查处理状态' : 'Check processing status')).length !== expectedCheck
    )
      throw new Error(`队列操作检查失败：${scenario}`);
    setResult(`运行检查通过：${scenario} / ${sample} / ${language}`);
  }
  return (
    <main className={`macos-ai-app zeus-shell session-codex-parity-v1 qa-error-layout ${dark ? 'theme-dark' : 'theme-light'}`} data-theme={dark ? 'dark' : 'light'}>
      <header className="qa-error-layout-heading">
        <div>
          <h1>排队消息操作</h1>
          <p>使用生产消息组件，检查定稿布局、状态与操作。</p>
        </div>
        <nav aria-label="预览设置">
          <label>
            消息状态{' '}
            <select
              value={scenario}
              onChange={(event) => {
                setScenario(event.target.value);
                resetPreview();
              }}
            >
              {['queued', 'restoring', 'outcome_unknown', 'recovery_required', 'recovered_unsent', 'accepted'].map((value, index) => (
                <option key={value} value={value}>
                  {['正常排队', '正在恢复', '送达未知', '引导待核对', '已确认未发送', '已接纳'][index]}
                </option>
              ))}
            </select>
          </label>
          <label>
            消息内容{' '}
            <select
              value={sample}
              onChange={(event) => {
                setSample(event.target.value);
                resetPreview();
              }}
            >
              {['reference', 'short', 'long', 'attachment', 'multiple'].map((value, index) => (
                <option key={value} value={value}>
                  {['定稿正文', '短消息', '长文本', '附件', '多条排队'][index]}
                </option>
              ))}
            </select>
          </label>
          <Button aria-pressed={dark} onClick={() => setDark((current) => !current)}>
            深色
          </Button>
          <Button aria-pressed={narrow} onClick={() => setNarrow((current) => !current)}>
            窄分栏
          </Button>
          <Button aria-pressed={language === 'en-US'} onClick={() => setLanguage((current) => (current === 'zh-CN' ? 'en-US' : 'zh-CN'))}>
            English
          </Button>
          <Button aria-pressed={failAction} onClick={() => setFailAction((current) => !current)}>
            操作失败
          </Button>
          <Button onClick={checkActions}>检查操作入口</Button>
        </nav>
      </header>
      <p role="status" className="qa-error-layout-note">
        {result}
      </p>
      <div ref={surface} style={{ maxWidth: narrow ? 360 : undefined, marginInline: 'auto' }}>
        <ConversationTranscript
          state={state}
          language={language}
          transcriptHydrated
          onSendQueuedNow={(id) => runAction(id, 'accepted')}
          onCancelQueuedSubmission={(id) => runAction(id, 'deleted')}
          onRecoverQueue={() => setResult('检查处理状态回调已触发')}
        />
      </div>
      <ApplicationErrorDialogHost />
    </main>
  );
}

/** 用生产时间线复现消息间距与耗时布局，状态切换仅影响预览数据。 */
function MessageLayoutQa() {
  /** 地址参数支持直接打开英文、窄分栏、深色和无最终答复场景。 */
  const parameters = new URLSearchParams(window.location.search);
  /** 链接场景直接呈现最终答复，复现历史资源只有名称和编号的恢复结果。 */
  const links = parameters.has('links');
  /** 手动切换运行终态，检查每种耗时文案及过程折叠。 */
  const [status, setStatus] = useState<'running' | 'completed' | 'failed' | 'interrupted'>(links || parameters.has('completed') ? 'completed' : 'running');
  /** 检查真实正文节点与资源打开回调，不连接原生宿主或模型。 */
  const contentRef = useRef<HTMLDivElement>(null);
  /** 保留手动检查和点击的结果，便于在页面核对资源身份。 */
  const [linkResult, setLinkResult] = useState('等待检查或点击链接');
  /** 批注沿用真实选区与编辑组件，草稿只保留在当前预览中。 */
  const [responseAnnotations, setResponseAnnotations] = useState<ConversationResponseAnnotation[]>([]);
  /** 预览主题不修改应用设置。 */
  const [dark, setDark] = useState(parameters.has('dark'));
  /** 通过内容列宽复现任务侧栏空间，不依赖浏览器窗口尺寸。 */
  const [narrow, setNarrow] = useState(parameters.has('narrow'));
  /** 同一份消息切换主会话和子智能体，直接对照共享展示。 */
  const [subagent, setSubagent] = useState(parameters.has('subagent'));
  /** 后台补入指令用于核验静态阅读位置，保持已有消息身份不变。 */
  const [followupCount, setFollowupCount] = useState(0);
  /** 运行态只显示过程，结束后才加入最终答复。 */
  const active = status === 'running';
  /** 固定起止时间用于确认耗时始终为三分一秒。 */
  const startedAt = '2026-09-09T05:48:00Z';
  /** 固定完成时间同时作为答复时间戳。 */
  const completedAt = '2026-09-09T05:51:01Z';
  /** 第一项沿用历史资源投影的名称占位，第二项保留实时资源的真实网址。 */
  const resources: ConversationResource[] = [
    { id: 'preview-resource', displayName: '交互预览', url: '交互预览' },
    { id: 'website-resource', displayName: '网站', url: 'https://example.com/' },
  ].map((resource) => ({
    ...resource,
    kind: 'website',
    presentation: 'inline',
    projectId: 'qa',
    conversationId: 'qa-layout',
    turnId: 'qa-layout-turn',
    itemId: 'layout-3',
    domain: resource.displayName,
    local: false,
    createdAt: completedAt,
    updatedAt: completedAt,
  }));
  // 文件链接与两侧正文同排，检查前置文件图标是否影响文字基线。
  resources.unshift({
    id: 'document-resource',
    projectId: 'qa',
    conversationId: 'qa-layout',
    turnId: 'qa-layout-turn',
    itemId: 'layout-3',
    kind: 'file',
    presentation: 'inline',
    displayName: '分析文档',
    projectRelativePath: 'docs/分析文档.md',
    iconKind: 'markdown',
    createdAt: completedAt,
    updatedAt: completedAt,
  });
  /** 真实节点必须可点击，已知网址不匹配或没有受信资源的链接继续保持不可打开。 */
  function checkLinks(): void {
    /** 只读取本场景正文，不将来源入口计入结果。 */
    const buttons = [...(contentRef.current?.querySelectorAll('.session-conversation-markdown .session-inline-resource') ?? [])].map((button) => button.textContent);
    if (buttons.join('|') !== '分析文档|交互预览|访问网站') throw new Error(`正文链接检查失败：${buttons.join('|')}`);
    setLinkResult('运行检查通过：历史链接和实时链接均可点击，未登记及同名不同网址的链接不可打开');
  }
  /** 正文与来源入口应传回同一个受信编号，目标由产品原有打开流程决定。 */
  function openResource(resource: ConversationResource): void {
    if (!resources.some((candidate) => candidate.id === resource.id)) throw new Error('资源打开检查失败：编号未登记');
    setLinkResult(`打开回调：${resource.id}`);
  }
  /** 手动运行生产布局检查，覆盖计时合并、缺失过程与缺失时间的展示边界。 */
  function checkLayout(): void {
    /** 不可读输入不能留下气泡，可读首条指令和每次追加的指令仍须保留。 */
    if (subagent && contentRef.current?.querySelectorAll('.session-thread-item-user').length !== 1 + followupCount) throw new Error('不可读指令未隐藏或可读指令丢失');
    /** 完成态仅保留一个耗时，时间未知或仍运行时不显示完成耗时。 */
    const durations = contentRef.current?.querySelectorAll('time.session-turn-duration') ?? [];
    /** 无过程的答复不能出现展开按钮。 */
    const controls = contentRef.current?.querySelectorAll('.session-turn-process-control > button') ?? [];
    if (durations.length !== (active || parameters.has('no-time') || parameters.has('no-end-time') ? 0 : 1) || controls.length !== (active || parameters.has('no-process') ? 0 : 1)) throw new Error('耗时或过程入口数量不正确');
    if (durations.length && durations[0]?.getAttribute('datetime') !== 'PT181S') throw new Error('耗时未沿用真实轮次的起止时间');
    /** 有后续交付资源时，耗时仍应位于最终正文前面。 */
    const answer = contentRef.current?.querySelector('.session-thread-item-assistant .session-markdown');
    if (durations[0] && answer && !(durations[0].compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING)) throw new Error('耗时入口没有放在最终正文之前');
    setLinkResult('运行检查通过：耗时只显示一次，过程入口与轮次状态一致');
  }
  /** 合成数据仅经过真实渲染链，不连接或调用模型。 */
  const items: NativeSessionItemBuffer[] = [
    { type: 'userMessage', phase: 'user', text: '请检查浏览器中的会话布局。\n保留主智能体下发的完整指令。', payload: subagent ? { subagentInput: { sender: '/root', fromParent: true, contentState: 'available' } } : {}, status: 'completed' },
    ...(parameters.has('no-process')
      ? []
      : [
          { type: 'commandExecution', phase: 'prework', text: '', payload: { command: ['pnpm', 'build'] }, status: 'completed' },
          { type: 'reasoning', phase: 'prework', text: 'Inspecting browser snapshot', payload: {}, status: active ? 'in_progress' : 'completed' },
        ]),
    ...(subagent ? [{ type: 'userMessage', phase: 'user', text: '', payload: { subagentInput: { sender: '/root', fromParent: true, contentState: 'unavailable' } }, status: 'completed' }] : []),
    ...(!active && !parameters.has('no-answer')
      ? [
          {
            type: 'agentMessage',
            phase: 'final_answer',
            text: links
              ? '边界已补充到[分析文档](docs/分析文档.md)。\n\n[交互预览](http://127.0.0.1:4529/qa/session-styles.html?model-select) · [访问网站](https://example.com)\n\n[未登记链接](https://unregistered.example/) · [网站](https://different.example/)'
              : '已检查会话布局，耗时与处理过程合并在正文上方；鼠标放到消息上时显示复制、反馈与时间戳。',
            payload: {},
            status: 'completed',
          },
        ]
      : []),
    ...(!active && parameters.has('deliverable') ? [{ type: 'fileChange', phase: 'prework', text: '', payload: {}, status: 'completed' }] : []),
    ...Array.from({ length: followupCount }, (_, index) => ({
      type: 'userMessage',
      phase: 'user',
      text: `后续指令 ${index + 1}：继续检查消息展示。`,
      payload: { subagentInput: { sender: '/root', fromParent: true, contentState: 'available' } },
      status: 'completed',
    })),
  ].map((item, index) => ({
    ...item,
    key: `layout-${index}`,
    itemId: `layout-${index}`,
    conversationId: 'qa-layout',
    threadId: 'qa-layout',
    turnId: 'qa-layout-turn',
    resources: item.type === 'fileChange' ? [{ ...resources[1]!, delivery: 'assistant' }] : links && item.phase === 'final_answer' ? resources : [],
    updatedAt: completedAt,
  }));
  /** 计时与终态均使用生产会话结构，覆盖无答复和缺少计时信息的轮次。 */
  const state: NativeSessionState = {
    ...createInitialSessionState(),
    conversationId: 'qa-layout',
    contextDraft: { responseAnnotations, codeComments: [] },
    activeTurnId: active ? 'qa-layout-turn' : null,
    transportState: 'ready',
    conversationState: active ? 'active_prework' : 'idle',
    items: Object.fromEntries(items.map((item) => [item.key, item])),
    itemOrder: items.map((item) => item.key),
    turnsByProviderId: {
      'qa-layout-turn': {
        id: 'qa-layout-turn',
        providerTurnId: 'qa-layout-turn',
        submissionId: null,
        status,
        startedAt: parameters.has('no-time') ? null : startedAt,
        completedAt: active || parameters.has('no-end-time') ? null : completedAt,
        createdAt: startedAt,
        updatedAt: completedAt,
      },
    },
    terminalTurnIds: active ? {} : { 'qa-layout-turn': status },
  };
  return (
    <main className={`macos-ai-app zeus-shell session-codex-parity-v1 qa-error-layout theme-${dark ? 'dark' : 'light'}`} data-theme={dark ? 'dark' : 'light'}>
      <header className="qa-error-layout-heading">
        <div>
          <h1>会话消息布局</h1>
          <p>生产时间线组件 · 预览数据</p>
        </div>
        <nav aria-label="消息布局场景">
          {(['running', 'completed', 'failed', 'interrupted'] as const).map((value, index) => (
            <Button key={value} aria-pressed={status === value} onClick={() => setStatus(value)}>
              {['进行中', '已完成', '失败', '中断'][index]}
            </Button>
          ))}
          <Button aria-pressed={dark} onClick={() => setDark(!dark)}>
            深色
          </Button>
          <Button aria-pressed={narrow} onClick={() => setNarrow(!narrow)}>
            窄分栏
          </Button>
          <Button aria-pressed={subagent} onClick={() => setSubagent(!subagent)}>
            子智能体
          </Button>
          <Button onClick={checkLayout}>检查耗时入口</Button>
          {subagent ? <Button onClick={() => setFollowupCount(followupCount + 1)}>补充指令</Button> : null}
          {links ? <Button onClick={checkLinks}>检查链接</Button> : null}
        </nav>
      </header>
      <div ref={contentRef} style={{ maxWidth: narrow ? 360 : 1000, margin: 'auto' }}>
        {links ? (
          <ConversationTranscript
            state={state}
            language={parameters.has('en') ? 'en-US' : 'zh-CN'}
            transcriptHydrated
            onOpenResource={openResource}
            onAddResponseAnnotation={(anchor) => {
              /** 同一编号贯穿标记、编辑、保存和删除。 */
              const id = crypto.randomUUID();
              setResponseAnnotations((current) => [...current, { id, anchor }]);
              return id;
            }}
            onUpdateResponseAnnotation={(id, note) => setResponseAnnotations((current) => current.map((annotation) => (annotation.id === id ? { ...annotation, note } : annotation)))}
            onRemoveResponseAnnotation={(id) => setResponseAnnotations((current) => current.filter((annotation) => annotation.id !== id))}
          />
        ) : (
          <ThreadLayoutQa state={state} subagent={subagent} language={parameters.has('en') ? 'en-US' : 'zh-CN'} narrow={narrow} onNarrowChange={setNarrow} onClose={() => setSubagent(false)} />
        )}
      </div>
      <div className="qa-error-layout-note">
        <p role="status">{linkResult}</p>
        {links ? (
          <>
            <span>来源：</span>
            <ConversationInlineResource resource={resources[1]!} label="交互预览" language="zh-CN" onOpenResource={openResource} />
          </>
        ) : null}
      </div>
    </main>
  );
}

/** 主、子线程使用同一组场景数据；只模拟读取回调，不连接真实模型。 */
function ThreadLayoutQa(props: { state: NativeSessionState; subagent: boolean; language: 'zh-CN' | 'en-US'; narrow: boolean; onNarrowChange: (narrow: boolean) => void; onClose: () => void }) {
  /** 预览中的缺失指标沿用真实不可用值。 */
  const missing = { state: 'unavailable' as const, reason: '预览未提供该项数据' };
  /** 完整详情覆盖缺失指标、长目录与可复制的线程身份。 */
  const runtime: NativeRuntimeDetailsSnapshot = {
    model: { state: 'available', value: 'gpt-5.6-sol' },
    effort: { state: 'available', value: 'high' },
    serviceTier: { state: 'available', value: 'priority' },
    usage: {
      serviceTier: missing,
      totalTokens: { state: 'available', value: 124000 },
      inputTokens: missing,
      outputTokens: missing,
      reasoningOutputTokens: missing,
      contextTokens: { state: 'available', value: 47500 },
      contextWindow: { state: 'available', value: 258000 },
      cacheHitRate: { state: 'available', value: 0.613 },
      apiEquivalentUsd: missing,
      priceCoverage: missing,
      pricingCatalogDate: missing,
      pricingSourceUrls: missing,
      historyComplete: missing,
    },
    performance: { latestOutputTokensPerSecond: missing, latestFirstVisibleResponseMs: missing, cumulativeProcessedDurationMs: missing },
    activity: { turnCount: { state: 'available', value: 1 }, modelRequestCount: missing, toolOrCommandCount: missing, retryCount: missing, failedTurnCount: missing },
    changeSummary: missing,
    environment: {
      cwd: { state: 'available', value: '/workspace/zeus/tasks/ZEUS-0541/long-directory-for-layout-verification' },
      branch: { state: 'available', value: 'zeus/ZEUS-0541-task-02' },
      nativeSessionId: { state: 'available', value: 'qa-agent-thread' },
      nativeSessionPath: { state: 'available', value: '/workspace/provider/sessions/2026/09/10/qa-agent-thread.jsonl' },
    },
  };
  /** 标题与原生轮次使用相同终态，改变场景时详情需重新读取才更新。 */
  const turn = props.state.turnsByProviderId['qa-layout-turn']!;
  /** 面板列表由生产组件打开，确保导航和最终刷新都经过真实路径。 */
  const agent: NativeSubagentSummary = {
    id: 'qa-agent-thread',
    parentThreadId: 'qa-parent',
    title: 'Kierkegaard',
    nickname: 'Kierkegaard',
    role: null,
    path: '/root/worker',
    preview: '',
    status: turn.status as NativeSubagentSummary['status'],
    createdAt: turn.createdAt,
    updatedAt: turn.updatedAt,
  };
  /** 旧指令字段故意提供内容，确认已移除独立栏且不拿它替代加密输入。 */
  const prompt = { state: 'available' as const, text: '独立任务指令栏不应再出现', source: 'provider_thread_source' as const, reason: null };
  /** 消息仍经子线程适配器进入共享时间线。 */
  const thread: NativeSubagentThreadSnapshot = {
    conversationId: 'qa-layout',
    parentThreadId: 'qa-parent',
    agent,
    taskInstruction: prompt,
    inheritedContext: prompt,
    runtime,
    historyBoundary: { state: 'confirmed', createdAt: turn.createdAt, ownedTurnCount: 1, hiddenInheritedTurnCount: 0, hiddenAmbiguousTurnCount: 0, reason: null },
    turns: [
      {
        id: turn.id,
        status: turn.status,
        startedAt: turn.startedAt,
        completedAt: turn.completedAt,
        items: props.state.itemOrder.map((key) => {
          /** 每条输入保留自身身份，完成场景仅追加最终答复。 */
          const item = props.state.items[key]!;
          return { ...item, id: item.itemId, providerItemId: item.itemId, startedAt: turn.startedAt, completedAt: turn.completedAt, updatedAt: item.updatedAt ?? turn.updatedAt };
        }),
      },
    ],
  };
  return (
    <div className="session-workspace-root" style={{ display: 'flex', flexDirection: 'column', height: 560, minWidth: 0 }}>
      {props.subagent ? (
        <SubagentWorkspace
          language={props.language}
          conversationId="qa-layout"
          activityRevision={turn.status}
          hintCount={1}
          initialSnapshot={{ conversationId: 'qa-layout', parentThreadId: 'qa-parent', items: [agent] }}
          fullWidth={!props.narrow}
          onFullWidthChange={(wide) => props.onNarrowChange(!wide)}
          onClose={props.onClose}
          loadList={async () => ({ conversationId: 'qa-layout', parentThreadId: 'qa-parent', items: [agent] })}
          loadThread={async () => thread}
        />
      ) : (
        <>
          <header className="session-thread-header">
            <div className="session-thread-title-copy">
              <span className="session-thread-title-row">
                <strong>会话消息布局</strong>
              </span>
            </div>
            <div className="session-thread-subtitle-row">
              <RuntimeDetails runtime={runtime} scope="session" language={props.language} />
            </div>
          </header>
          <ConversationTranscript state={props.state} language={props.language} transcriptHydrated />
        </>
      )}
    </div>
  );
}

/** 展示已确认的会话提示；错误、正文和变更卡片均使用真实组件。 */
function ErrorLayoutQa() {
  /** 主题只影响预览，不修改应用设置。 */
  const [dark, setDark] = useState(false);
  /** 文件审核只展示预览反馈，不读取或操作工作区。 */
  const [review, setReview] = useState(false);
  /** 沿用用户截图中的错误码和原始说明，不假设消息已经发送或取消。 */
  const error = { code: 'ZEUS_NATIVE_SUBMISSION_NOT_QUEUED', message: '这条消息已取消、替换或离开待发送状态，不会再次发送。' };
  /** 合成消息复现未确认状态，预览不提供重发入口。 */
  const pending: NativeSessionItemBuffer = {
    key: 'preview-pending',
    conversationId: 'preview',
    threadId: 'preview',
    turnId: 'preview-turn',
    itemId: 'preview-pending',
    type: 'userMessage',
    phase: 'user',
    text: '',
    status: 'paused',
    optimistic: true,
    resources: [],
    payload: { deliveryError: error },
  };
  /** 回复文字用于对照截图中的正文边缘，不代表本次新增交付结果。 */
  const answer: NativeSessionItemBuffer = {
    ...pending,
    key: 'preview-answer',
    itemId: 'preview-answer',
    type: 'agentMessage',
    phase: 'final',
    status: 'completed',
    optimistic: false,
    payload: {},
    updatedAt: '2026-09-08T12:16:00Z',
    text: '已实现：粘贴 Markdown 后自动显示格式，表格支持横向滚动；点击“编辑原文”可继续修改。\n\nlint、类型检查、构建及模拟粘贴、编辑、提交检查通过。真实剪贴板、原生快捷键、输入法和截图仍待验收。',
  };
  /** 固定文件摘要只提供截图相同的视觉参照，撤销限制保持可见。 */
  const changeSet: TurnChangeSet = {
    id: 'preview-changes',
    projectId: 'preview',
    conversationId: 'preview',
    turnId: 'preview-turn',
    providerTurnId: 'preview-turn',
    state: 'unavailable',
    fileCount: 7,
    addedLines: 225,
    deletedLines: 57,
    unifiedDiff: '',
    preImageDigest: null,
    postImageDigest: null,
    conflict: null,
    unavailableReason: '连续修改之间的文件内容或权限不一致，无法安全撤销或重新应用。',
    createdAt: '2026-09-08T12:16:00Z',
    updatedAt: '2026-09-08T12:16:00Z',
    files: [
      ['apps/desktop/qa/session-core-qa.tsx', 63, 7],
      ['apps/desktop/src/renderer/session/ConversationComposer.tsx', 4, 4],
      ['apps/desktop/src/renderer/session/session.css', 21, 27],
      ['apps/desktop/src/renderer/session/StructuredComposerInput.tsx', 110, 15],
      ['apps/desktop/src/renderer/session/useConversationInputResources.ts', 20, 1],
      ['apps/desktop/src/renderer/session/SessionWorkspace.tsx', 7, 1],
      ['docs/ZEUS-0375_输入框粘贴Markdown展示.md', 0, 2],
    ].map(([path, addedLines, deletedLines], index) => ({
      id: String(index),
      oldPath: String(path),
      newPath: String(path),
      changeType: 'modified',
      addedLines: Number(addedLines),
      deletedLines: Number(deletedLines),
      unifiedDiff: '',
      preHash: null,
      postHash: null,
      reversible: false,
      unavailableReason: null,
    })),
  };
  return (
    <main className={`macos-ai-app zeus-shell session-codex-parity-v1 qa-error-layout theme-${dark ? 'dark' : 'light'}`} data-theme={dark ? 'dark' : 'light'}>
      <header className="qa-error-layout-heading">
        <div>
          <h1>会话错误提示</h1>
          <p>已确认样式 · 直接展示会话组件</p>
        </div>
        <nav aria-label="预览切换">
          <Button aria-pressed={dark} onClick={() => setDark(!dark)}>
            {dark ? '浅色' : '深色'}
          </Button>
        </nav>
      </header>
      <div className="session-transcript">
        <MessageDeliveryOutcomeFeedback item={pending} language="zh-CN" />
        <ThreadItemView item={answer} language="zh-CN" showAssistantActions />
        <TurnChangeCard changeSet={changeSet} language="zh-CN" onReview={() => setReview(true)} />
      </div>
      {review ? (
        <p className="qa-error-layout-note" role="status">
          这是文件摘要预览，未读取工作区或执行撤销。<Button onClick={() => setReview(false)}>收起</Button>
        </p>
      ) : null}
      <ApplicationErrorDialogHost language="zh-CN" />
    </main>
  );
}

/** 计划确认使用真实卡片，响应只显示在页面内，便于检查布局、快捷键及重复操作。 */
function PlanImplementationQa() {
  /** 地址参数沿用其他预览的主题、语言和窄宽度入口。 */
  const parameters = new URLSearchParams(window.location.search);
  /** 手动保持处理态，检查禁用按钮的尺寸及颜色。 */
  const [busy, setBusy] = useState(false);
  /** 记录每次真实回调，输入法确认和换行不应增加提交次数。 */
  const [responses, setResponses] = useState<Array<{ action: 'implement' | 'refine' | 'dismiss'; feedback?: string; attachments?: NativeConversationAttachment[] }>>([]);
  /** 复用既有粘贴焦点检查，在页面内显示结果。 */
  const [pasteResult, setPasteResult] = useState('');
  /** 浏览器预览模拟资源桥，真实应用仍使用原生授权和文件读取。 */
  useEffect(() => {
    if (window.zeus) return;
    window.zeus = {
      authorizeConversationFiles: async (files, source) => {
        await nextQaTask();
        await nextQaTask();
        if (parameters.has('resource-error')) throw new Error('附件读取失败（预览）');
        return {
          resources: files.map((file) => ({ name: file.name, kind: file.type.startsWith('image/') ? 'image' : 'file', mime: file.type || 'application/octet-stream', size: file.size, source, uploadRef: `qa:${file.name}` })),
          failedCount: 0,
        };
      },
      materializeConversationResources: async (resources) =>
        resources.map((resource) => ({
          name: resource.name ?? 'Pasted text.txt',
          kind: 'pasted_text',
          mime: 'text/plain',
          size: new Blob([resource.text ?? '']).size,
          source: 'paste',
          characterCount: resource.text?.length,
          restorableText: resource.text,
          uploadRef: 'qa:pasted-text',
        })),
      readConversationClipboardResources: async () => ({ resources: [{ name: '剪贴板附件.txt', kind: 'file', mime: 'text/plain', size: 12, source: 'paste', uploadRef: 'qa:clipboard-file' }], text: '' }),
      discardConversationResources: async (resources) => ({ discardedCount: resources.length }),
    } as NonNullable<Window['zeus']>;
    return () => {
      delete window.zeus;
    };
  }, []);
  return (
    <main
      className={`macos-ai-app zeus-shell session-codex-parity-v1 theme-${parameters.has('dark') ? 'dark' : 'light'}`}
      data-theme={parameters.has('dark') ? 'dark' : 'light'}
      style={{ display: 'block', boxSizing: 'border-box', minHeight: '100vh', padding: 24 }}
    >
      <h1>计划确认与修改</h1>
      <label>
        <input type="checkbox" checked={busy} onChange={(event) => setBusy(event.currentTarget.checked)} />
        处理中
      </label>
      <button
        type="button"
        onClick={async () => {
          /** 检查真实计划输入节点，不读取系统剪贴板或用户文件。 */
          const textarea = document.querySelector('.session-plan-refinement textarea');
          if (!(textarea instanceof HTMLTextAreaElement)) return setPasteResult('先展开修改意见');
          try {
            setPasteResult(await checkAttachmentFocus(textarea, textarea));
          } catch (error) {
            setPasteResult(error instanceof Error ? error.message : String(error));
          }
        }}
      >
        检查附件粘贴与焦点
      </button>
      <output>{pasteResult}</output>
      <div className="ai-workspace" style={{ display: 'block', height: 'auto', blockSize: 'auto', padding: 0, width: parameters.has('narrow') ? 360 : 900, maxWidth: '100%', margin: '24px auto' }}>
        <div className="session-interaction-dock" style={{ inlineSize: '100%' }}>
          <PlanImplementationRequestSurface
            request={{ id: 'qa-plan-implementation', conversationId: 'qa-plan', turnId: 'qa-turn', planItemId: 'qa-plan-item', status: 'pending', submissionId: null, createdAt: '', resolvedAt: null, updatedAt: '' }}
            language={parameters.has('en') ? 'en-US' : 'zh-CN'}
            busy={busy}
            onRespond={(_id, response) => setResponses((current) => [...current, response])}
            onChooseAttachments={chooseComposerQaAttachments}
          />
        </div>
      </div>
      <pre aria-label="计划响应记录" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
        {JSON.stringify(responses, null, 2)}
      </pre>
      <ApplicationErrorDialogHost language={parameters.has('en') ? 'en' : 'zh-CN'} />
    </main>
  );
}

/** 固定附件只进入预览草稿，不读取用户文件或打开原生文件选择器。 */
async function chooseComposerQaAttachments(): Promise<NativeConversationAttachment[]> {
  return [{ name: '对齐检查.txt', kind: 'file', mime: 'text/plain', size: 12, uploadRef: `qa:${crypto.randomUUID()}` }];
}

/** 使用真实会话输入组件验收工具栏及粘贴，只在本页记录发送结果，不调用模型。 */
function ComposerMarkdownQa() {
  /** 地址参数覆盖窄分栏、深色和英文。 */
  const parameters = new URLSearchParams(window.location.search);
  /** 草稿沿用真实输入框回写路径。 */
  const [state, setState] = useState(() => {
    /** 长记录与输入框放在同一真实容器内，核对返回最新按钮的悬停与滚动。 */
    const initial = createInitialSessionState();
    if (!parameters.has('history')) return initial;
    /** 单条长回复足以产生滚动距离，不连接模型或读取用户历史。 */
    const item = activity(
      {
        query: 'composer-history',
        title: '',
        summary: '',
        answer: '',
        activities: [{ type: 'agentMessage', status: 'completed', text: Array.from({ length: 24 }, (_, index) => `第 ${index + 1} 段会话记录：检查返回最新消息按钮，鼠标悬停和键盘聚焦时保持位置，点击后回到末尾。`).join('\n\n') }],
      },
      0,
    );
    item.phase = 'final_answer';
    return { ...initial, conversationId: item.conversationId, items: { [item.key]: item }, itemOrder: [item.key], terminalTurnIds: { [item.turnId]: 'completed' as const } };
  });
  /** 展示提交内容，便于比较缩进、转义和技能调用是否保留。 */
  const [submitted, setSubmitted] = useState('');
  /** 只读状态可在编辑期间切换，核对发送和编辑禁用条件。 */
  const [readOnly, setReadOnly] = useState(false);
  /** 真实设置回写控制选中状态，模型切换后不会被旧属性还原。 */
  const [settings, setSettings] = useState<ComposerRuntimeSettings>({ model: 'qa-model', effort: 'max', permissionMode: 'auto', collaborationMode: 'default' });
  /** 保留统一输入接口，样例通过真实编辑器的粘贴处理插入，不访问系统剪贴板。 */
  const textareaRef = useRef<ComposerInputHandle | null>(null);
  /** 用户提供的十二列表格，保留转义、长编号及前导零。 */
  const sample = String.raw`| id | batch\_tag | pick\_bill\_date | delivery\_spot\_id | pick\_bill\_id | pick\_bill\_no | collect\_status | begin\_collect\_time | end\_collect\_time | allocate\_dtl | delete\_flag | update\_time |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 2093161985053044748 | 2093161985044656133 | 20260828 | 00000852 | 2093161972491100160 | 000126082800428 | 5 | 2026-08-28 15:40:15 | 2026-08-28 15:40:44 | 1 | 0 | 2026-08-28 18:07:13 |`;
  /** 可以替换样例，检查普通文本、命令及 Markdown 的同一粘贴路径。 */
  const [pasteSample, setPasteSample] = useState(sample);
  /** 仅普通浏览器 QA 注入附件返回值，不接触原生剪贴板或磁盘。 */
  useEffect(() => {
    if (window.zeus) return;
    window.zeus = {
      authorizeConversationFiles: async () => {
        await nextQaTask();
        await nextQaTask();
        return { resources: [{ name: '焦点检查.txt', kind: 'file', mime: 'text/plain', uploadRef: `qa:${crypto.randomUUID()}` }], failedCount: 0 };
      },
    } as NonNullable<Window['zeus']>;
    return () => {
      delete window.zeus;
    };
  }, []);
  /** 焦点检查结果直接显示，明确区分模拟附件与原生剪贴板。 */
  const [focusResult, setFocusResult] = useState('');
  return (
    <main
      className={`macos-ai-app zeus-shell session-codex-parity-v1 theme-${parameters.has('dark') ? 'dark' : 'light'}`}
      data-theme={parameters.has('dark') ? 'dark' : 'light'}
      style={{ display: 'block', boxSizing: 'border-box', minHeight: '100vh', padding: 24 }}
    >
      <h1>会话输入框与工具栏</h1>
      <p>Markdown 默认排版，点击内容直接修改；Shift+Enter 换行，Enter 记录发送原文。</p>
      <textarea aria-label="粘贴样例" value={pasteSample} onChange={(event) => setPasteSample(event.currentTarget.value)} style={{ display: 'block', width: '100%', height: 72, marginBlock: 12 }} />
      <label>
        <input type="checkbox" checked={readOnly} onChange={(event) => setReadOnly(event.currentTarget.checked)} />
        只读
      </label>
      <label>
        <input
          type="checkbox"
          checked={state.activeTurnId !== null}
          onChange={(event) =>
            setState((current) => ({
              ...current,
              conversationState: event.target.checked ? 'active_prework' : 'native_loading',
              activeTurnId: event.target.checked ? 'qa-turn' : null,
              startedTurnId: event.target.checked ? 'qa-turn' : null,
            }))
          }
        />
        响应进行中（清空草稿显示停止）
      </label>
      <button
        type="button"
        disabled={readOnly}
        onClick={() => {
          textareaRef.current?.focus();
          /** 目标为真实编辑节点，CodeMirror 的粘贴处理负责插入与撤销。 */
          const editor = document.querySelector('.structured-composer-editor [contenteditable="true"]');
          if (!editor) return;
          /** 仅使用固定样例构造粘贴内容。 */
          const data = new DataTransfer();
          data.setData('text/plain', pasteSample);
          editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
        }}
      >
        模拟粘贴
      </button>
      <button
        type="button"
        disabled={readOnly}
        onClick={() => {
          const control = document.querySelector<HTMLElement>('.structured-composer-editor [role="textbox"]');
          if (control && textareaRef.current) void checkAttachmentFocus(control, textareaRef.current).then(setFocusResult, (error) => setFocusResult(`失败：${String(error)}`));
        }}
      >
        检查附件粘贴焦点
      </button>
      <button
        type="button"
        disabled={readOnly}
        onClick={() => {
          const control = document.querySelector<HTMLElement>('.structured-composer-editor [role="textbox"]');
          const other = document.querySelector<HTMLElement>('textarea[aria-label="粘贴样例"]');
          if (control && textareaRef.current && other) void checkAttachmentFocus(control, textareaRef.current, other).then(setFocusResult, (error) => setFocusResult(`失败：${String(error)}`));
        }}
      >
        检查主动转移焦点
      </button>
      <button
        type="button"
        disabled={readOnly}
        onClick={() => {
          const control = document.querySelector<HTMLElement>('.structured-composer-editor [role="textbox"]');
          if (control && textareaRef.current) void checkAttachmentFocus(control, textareaRef.current, null).then(setFocusResult, (error) => setFocusResult(`失败：${String(error)}`));
        }}
      >
        检查意外失焦恢复
      </button>
      <output aria-label="附件焦点检查">{focusResult}</output>
      <div className="ai-workspace" style={{ display: 'block', height: 'auto', blockSize: 'auto', boxSizing: 'border-box', width: parameters.has('narrow') ? 360 : 1000, maxWidth: '100%', marginBlock: 24 }}>
        {parameters.has('history') ? (
          <div style={{ display: 'flex', height: 300 }}>
            <ConversationTranscript state={state} language={parameters.has('en') ? 'en-US' : 'zh-CN'} transcriptHydrated />
          </div>
        ) : null}
        <ConversationComposer
          textareaRef={textareaRef}
          state={state}
          language={parameters.has('en') ? 'en-US' : 'zh-CN'}
          readOnly={readOnly}
          permissionMode={settings.permissionMode}
          collaborationMode={settings.collaborationMode}
          runtimeSettings={settings}
          onRuntimeSettingsChange={setSettings}
          goalAvailable
          onSetGoal={(objective) => {
            setSubmitted(`目标：${objective}`);
            return true;
          }}
          capabilities={{
            generationId: 'qa',
            initializedAt: '',
            projectId: 'qa',
            preferredModel: 'qa-model',
            models: [
              {
                id: 'qa-model',
                model: 'GPT-6-Astra',
                sourceName: 'Codex',
                displayName: 'GPT-6-Astra',
                supportedReasoningEfforts: ['xhigh', 'max'],
                defaultReasoningEffort: 'max',
                serviceTiers: [{ id: 'priority', name: 'Fast', description: '预览速度状态' }],
              },
              {
                id: 'qa-long-model',
                model: 'Model with a deliberately long name for narrow window inspection',
                sourceName: 'Long provider name',
                supportedReasoningEfforts: ['xhigh', 'max'],
                defaultReasoningEffort: 'xhigh',
                serviceTiers: [],
              },
            ],
            codexAccount: { generationId: 'qa', requiresOpenaiAuth: false, signedIn: false, accountType: null, planType: null },
          }}
          onChooseAttachments={async () => {
            /** 通过真实附件草稿路径加入固定样例。 */
            const attachments = await chooseComposerQaAttachments();
            setState((current) => ({ ...current, attachments: [...current.attachments, ...attachments] }));
          }}
          onAddAttachments={(attachments) => setState((current) => ({ ...current, attachments: [...current.attachments, ...attachments] }))}
          onRemoveAttachment={(attachment) => setState((current) => ({ ...current, attachments: current.attachments.filter((candidate) => candidate !== attachment) }))}
          onDraftChange={(draft) => setState((current) => ({ ...current, draft }))}
          onSubmit={(_delivery, settings) => {
            // 当前验收页不加载技能目录，提交正文必须逐字符等于原始草稿。
            if (settings?.promptText !== state.draft) throw new Error('格式预览改变了发送原文。');
            setSubmitted(`原文逐字符一致：是\n${JSON.stringify(settings, null, 2)}`);
            setState((current) => ({ ...current, draft: '' }));
          }}
          onInterrupt={async () => {
            /** 保留停止请求的等待阶段，核对真实按钮的加载动画与重复点击禁用。 */
            setState((current) => ({ ...current, busyOperation: 'interrupt' }));
            setSubmitted('正在停止预览响应…');
            await new Promise((resolve) => window.setTimeout(resolve, 1200));
            setSubmitted('已停止预览响应');
            setState((current) => ({ ...current, busyOperation: null, conversationState: 'native_loading', activeTurnId: null, startedTurnId: null }));
          }}
        />
      </div>
      <output aria-label="当前草稿" style={{ display: 'block', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
        {JSON.stringify(state.draft)}
      </output>
      <pre aria-label="发送内容" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
        {submitted}
      </pre>
    </main>
  );
}

/** 让浏览器提交本轮 React 更新，模拟附件读取跨越事件循环。 */
function nextQaTask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** 在真实编辑节点上粘贴文件，检查处理中可输入、完成后的焦点和原选区。 */
async function checkAttachmentFocus(control: HTMLElement, input: ComposerInputHandle, other?: HTMLElement | null): Promise<string> {
  input.focus();
  input.setSelectionRange(0, Math.min(2, input.value.length));
  /** 原文选区不应因为添加附件而移动到末尾。 */
  const start = input.selectionStart;
  const end = input.selectionEnd;
  const count = document.querySelectorAll('.pending-resource-card').length;
  const data = new DataTransfer();
  data.items.add(new File(['qa'], '焦点检查.txt', { type: 'text/plain' }));
  control.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  await nextQaTask();
  if (control.matches(':disabled') || document.activeElement !== control) throw new Error('附件处理中输入框丢失焦点或被禁用');
  if (other) other.focus();
  else if (other === null) control.blur();
  // 读取结果、附件回写和焦点完成回调分别推进，不用延长固定等待掩盖失败。
  await nextQaTask();
  await nextQaTask();
  await nextQaTask();
  if (document.querySelectorAll('.pending-resource-card').length <= count) throw new Error('附件未进入真实输入组件');
  if (document.activeElement !== (other ?? control)) throw new Error(other ? '主动转移焦点后被抢回' : '附件完成后光标丢失');
  if (!other && (input.selectionStart !== start || input.selectionEnd !== end)) throw new Error('附件改变了原选区');
  return other ? '通过：附件已加入，用户新焦点保持不变' : other === null ? '通过：意外失焦后恢复原输入框及选区' : '通过：附件已加入，处理中可输入，光标与选区保持不变';
}

/** 真实任务创建表单；地址参数选择需求、缺陷或优化，以及对应粘贴字段。 */
function TaskPasteFocusQa() {
  /** 本页只更新草稿，不提交任务。 */
  const parameters = new URLSearchParams(window.location.search);
  const [form, setForm] = useState(() => ({
    ...buildTaskCreateInitialForm('zh-CN'),
    projectId: 'qa',
    taskType: (parameters.get('type') ?? 'requirement') as 'requirement' | 'defect' | 'optimization',
    title: '附件焦点检查',
    description: '继续输入任务说明',
    defectCurrentState: '当前状态',
    defectExpectedOutcome: '预期结果',
    defectReproductionSteps: '复现步骤',
    optimizationCurrentState: '当前状态',
    optimizationExpectedOutcome: '预期结果',
    tags: '焦点',
  }));
  /** 保留真实标题控件供弹窗初始焦点使用。 */
  const titleRef = useRef<HTMLInputElement | null>(null);
  /** 页面打开后运行一次现有组件的粘贴检查，结果显示在弹窗提示区。 */
  const [result, setResult] = useState('正在检查附件粘贴焦点');
  useEffect(() => {
    const timer = setTimeout(() => {
      const control = document.getElementById(`task-create-${parameters.get('field') ?? 'description'}-input`);
      if (!(control instanceof HTMLTextAreaElement) && !(control instanceof HTMLInputElement)) {
        setResult('失败：目标字段未挂载');
        return;
      }
      void checkAttachmentFocus(control, control, parameters.has('move') ? (titleRef.current ?? undefined) : undefined).then(setResult, (error) => setResult(`失败：${String(error)}`));
    }, 0);
    return () => clearTimeout(timer);
  }, []);
  return (
    <TaskCreateModal
      open
      projects={[]}
      copy={getLanguageCopy('zh-CN').taskWorkspace}
      form={form}
      busy={false}
      titleInputRef={titleRef}
      parentTasks={[]}
      error={result}
      onProjectChange={(projectId) => setForm((current) => ({ ...current, projectId }))}
      onFormChange={(field, value) => setForm((current) => ({ ...current, [field]: value }))}
      onTaskTypeChange={(taskType) => setForm((current) => ({ ...current, taskType: taskType as typeof current.taskType }))}
      onPriorityChange={(priority) => setForm((current) => ({ ...current, priority }))}
      onParentChange={(parentTaskId) => setForm((current) => ({ ...current, parentTaskId }))}
      onReadClipboardResources={async () => {
        await nextQaTask();
        await nextQaTask();
        return { resources: [{ path: `qa:${crypto.randomUUID()}`, name: '焦点检查.txt', kind: 'file', mimeType: 'text/plain' }], text: '' };
      }}
      onAuthorizeFiles={async () => ({ resources: [], failedCount: 0 })}
      onMaterializeResources={async () => []}
      onAddAttachments={(attachments) => setForm((current) => ({ ...current, attachments: [...current.attachments, ...attachments] }))}
      onRemoveAttachment={(path) => setForm((current) => ({ ...current, attachments: current.attachments.filter((attachment) => attachment.path !== path) }))}
      onParseThirdPartyLink={async () => ({ kind: 'unsupported' })}
      onApplyThirdPartyTaskInfo={() => undefined}
      onOpenThirdPartyLink={async () => false}
      onClose={() => undefined}
      onSubmit={(event) => event.preventDefault()}
    />
  );
}

/** 复用真实询问组件的手动验收入口，不连接或冒充真实模型。 */
function QuestionQa() {
  /** 同一真实组件入口覆盖语言、主题和窄分栏。 */
  const parameters = new URLSearchParams(window.location.search);
  /** 语言只控制展示，不改变问题与答案内容。 */
  const language = parameters.has('en') ? 'en-US' : 'zh-CN';
  /** 场景通过地址参数切换，刷新可重置本次提交次数。 */
  const scenario = parameters.get('case') ?? 'single';
  /** PLAN 真实已答题记录用于对照，跨轮次场景复现用户反馈。 */
  const synchronous = scenario === 'plan' || scenario === 'multiple' || scenario === 'plan-freeform';
  /** 另发消息属于新的执行轮次，不能依赖原题仍在首屏。 */
  const asNewMessage = scenario === 'newturn' || scenario === 'closed';
  /** 独立问题身份避免各场景草稿串用。 */
  const identity = `qa-question-${scenario}`;
  /** 答复送达通过按钮推进，以便观察接收和送达的区别。 */
  const [delivery, setDelivery] = useState(parameters.has('pending') ? 'dispatching' : scenario === 'delivered' || parameters.has('answered') ? 'resolved' : '');
  /** 已接收的表单立即收起，可手动重新挂载检查草稿。 */
  const [open, setOpen] = useState(true);
  /** 次数与正文是浏览器交互检查的可见证据。 */
  const [calls, setCalls] = useState(0);
  /** 保存当前已接收的回答。 */
  const [answers, setAnswers] = useState<Record<string, { answers: string[] }>>({
    question_1: { answers: [scenario === 'newturn' ? '0.3.111' : scenario === 'freeform' || parameters.has('custom') ? '不需要你测\n请继续完成样式优化，并保留长文本换行。' : '手动调整后，关闭再打开同一个任务的代码交付窗口'] },
    ...(scenario === 'multi' ? { question_2: { answers: ['上次的屏幕'] } } : {}),
  });
  /** 与截图一致的长标题和选项，也覆盖只有自由输入的问题。 */
  const questions = [
    {
      title:
        scenario === 'newturn'
          ? '能看到最新模型的那位用户，Zeus「关于」里显示的具体版本号是多少？需要确认是否也是 0.3.111，才能排除安装包版本差异。'
          : '尺寸会在哪一步变回去？我已确认本机有保存记录，这个信息能帮我区分保存错误和重新打开时的恢复错误。',
      ...(scenario === 'freeform' || scenario === 'newturn' || scenario === 'plan-freeform' ? {} : { options: ['手动调整后，关闭再打开同一个任务的代码交付窗口', '重启 Zeus 后，再打开代码交付窗口', '切换到另一个任务的代码交付窗口'] }),
    },
    ...(scenario === 'multi' ? [{ title: '第二个问题：请选择窗口位置。', options: ['上次的屏幕', '当前屏幕'] }] : []),
  ];
  /** 活动问题携带答复账本；ledger 参数单独覆盖未载入用户回答的历史。 */
  const item: NativeSessionItemBuffer = {
    key: identity,
    conversationId: 'qa-questions',
    threadId: 'qa-thread',
    turnId: 'qa-turn',
    itemId: identity,
    providerItemId: identity,
    type: 'agentMessage',
    status: 'completed',
    phase: 'prework',
    text: questions.map((question) => question.title).join('\n'),
    resources: [],
    payload: { delivery: 'async', questions, ...(delivery ? { questionResponse: { status: delivery, answer: { providerItemId: identity, providerTurnId: 'qa-turn', answers } } } : {}) },
  };
  /** 合成用户消息经过完整生产时间线，检查回答卡片及消息操作。 */
  const reply: NativeSessionItemBuffer = {
    ...item,
    key: `${identity}-reply`,
    turnId: asNewMessage ? 'qa-answer-turn' : item.turnId,
    itemId: `${identity}-reply`,
    providerItemId: delivery === 'resolved' ? `${identity}-reply` : undefined,
    type: 'userMessage',
    phase: 'user',
    status: delivery === 'resolved' ? 'completed' : 'steering',
    optimistic: delivery !== 'resolved',
    text: formatAsyncQuestionAnswer(asyncMessageQuestions(item.payload), answers),
    payload: {
      delivery: asNewMessage ? 'queue' : 'steer_now',
      questionAnswer: { providerItemId: identity, providerTurnId: item.turnId, answers, questions: asyncMessageQuestions(item.payload), ...(asNewMessage ? { asNewMessage: true } : {}) },
    },
  };
  /** 单独保留账本模式，避免只验同一页同时有问答的情况。 */
  const showReply = Boolean(delivery) && !parameters.has('ledger') && !synchronous;
  /** 只建立组件需要的会话状态，其余沿用生产初始值。 */
  const state: NativeSessionState = {
    ...createInitialSessionState(),
    conversationId: item.conversationId,
    activeTurnId: asNewMessage && delivery ? reply.turnId : item.turnId,
    transportState: 'ready',
    conversationState: 'active_prework',
    items: { ...(parameters.has('orphan') || synchronous ? {} : { [identity]: item }), ...(showReply ? { [reply.key]: reply } : {}) },
    itemOrder: [...(parameters.has('orphan') || synchronous ? [] : [identity]), ...(showReply ? [reply.key] : [])],
    terminalTurnIds: { ...(asNewMessage ? { [item.turnId]: 'completed' as const } : {}), ...(parameters.has('finished') ? { [reply.turnId]: 'completed' as const } : {}) },
    pendingRequests:
      synchronous && delivery
        ? [
            {
              id: identity,
              conversationId: item.conversationId,
              turnId: item.turnId,
              itemId: identity,
              generationId: 'qa',
              type: 'request_user_input',
              status: 'resolved',
              payload: { questions: asyncMessageQuestions(item.payload) },
              response: { answers },
              containsSecret: false,
              expiresAt: null,
              createdAt: '',
              resolvedAt: '',
            },
          ]
        : [],
  };

  /** 模拟有延迟的接收；失败场景必须保留真实表单中的选择和输入。 */
  async function accept(_item: NativeSessionItemBuffer, nextAnswers: Record<string, { answers: string[] }>): Promise<void> {
    setCalls((count) => count + 1);
    await new Promise((resolve) => window.setTimeout(resolve, 800));
    if (scenario === 'failed') throw Object.assign(new Error('验收用提交失败'), { code: 'ZEUS_COMMAND_DELIVERY_IDEMPOTENCY_CONFLICT' });
    setAnswers(nextAnswers);
    setDelivery('dispatching');
  }

  return (
    <main className={`macos-ai-app zeus-shell qa-page theme-${parameters.has('dark') ? 'dark' : 'light'}`} data-theme={parameters.has('dark') ? 'dark' : 'light'}>
      <style>{'.qa-page { display: block !important; box-sizing: border-box; width: 100%; height: auto; overflow: auto; min-width: 0; }'}</style>
      <h1>PLAN 与异步询问共用表单验收</h1>
      <nav aria-label="询问场景">
        {['single', 'plan', 'plan-freeform', 'multi', 'multiple', 'freeform', 'failed', 'closed', 'delivered', 'newturn'].map((name) => (
          <a key={name} href={`?questions&case=${name}`} style={{ marginRight: 16 }}>
            {name}
          </a>
        ))}
      </nav>
      <p role="status">
        提交次数：{calls}；送达状态：{delivery || '未提交'}
      </p>
      <button type="button" onClick={() => setOpen((value) => !value)}>
        切换表单挂载
      </button>
      <button type="button" disabled={!delivery} onClick={() => setDelivery('resolved')}>
        确认送达
      </button>
      <section
        className={`workspace-detail-pane session-codex-parity-v1 theme-${parameters.has('dark') ? 'dark' : 'light'}`}
        data-theme={parameters.has('dark') ? 'dark' : 'light'}
        style={{ maxWidth: parameters.has('narrow') ? 360 : 900, margin: '24px auto' }}
      >
        <ConversationTranscript state={state} language={language} transcriptHydrated onOpenAsyncQuestion={() => setOpen(true)} />
        {open && !delivery ? (
          <div className="session-interaction-dock">
            {synchronous ? (
              <RequestUserInputPanel
                request={{ id: identity, expiresAt: null }}
                questions={normalizeRequestQuestions({ payload: { questions: asyncMessageQuestions(item.payload).map((question) => ({ ...question, multiple: scenario === 'multiple' })) } })}
                language={language}
                autoFocus
                onChooseAttachments={chooseComposerQaAttachments}
                onRespond={async (_id, response) => {
                  await accept(item, response.answers as typeof answers);
                  setOpen(false);
                }}
              />
            ) : (
              <AsyncQuestionPanel item={item} state={state} language={language} onAnswer={accept} onDismiss={() => setOpen(false)} />
            )}
          </div>
        ) : null}
      </section>
      <ApplicationErrorDialogHost language="zh-CN" />
    </main>
  );
}

/** 浏览器使用合成图片；已有原生桥时保持真实读取，不覆盖 Electron 的能力。 */
function TaskPushImagesQa() {
  /** 读取次数用于发现重渲染导致的重复加载。 */
  const [reads, setReads] = useState(0);
  /** 只在浏览器预览桥就绪后挂载图片组件。 */
  const [ready, setReady] = useState(false);
  /** 模拟推送配置变化，图片身份保持不变。 */
  const [revision, setRevision] = useState(0);
  /** 外层弹窗必须在图片关闭后保持打开。 */
  const [open, setOpen] = useState(false);
  /** 四个来源故意使用同名文件，以稳定标识区分。 */
  const sources = ['current', 'parent', 'related', 'supplemental'];
  /** 原生验收可指向当前 Test 身份下已准备的附件目录。 */
  const imageRoot = new URLSearchParams(window.location.search).get('imageRoot') ?? '/qa';
  /** 来源仅传入预览组件，不写回任务布局。 */
  const attachments: NativeConversationAttachment[] = [...sources, 'missing'].map((source) => ({ name: '同名.png', mime: 'image/png', size: 1, kind: 'image', localPath: `${imageRoot}/${source}.png`, taskPushAttachmentKey: source }));
  /** 每个字段只通过附件标识绑定来源。 */
  const promptAttachment = (source: string) => ({ key: source, name: '同名.png', kind: 'image' as const, field: 'description' as const });
  /** 使用实际布局构建器，覆盖字段图片和补充图片的共同入口。 */
  const layout = buildTaskPushLayout({
    taskTitle: '当前任务',
    taskType: 'requirement',
    taskDescription: '蓝色图片',
    attachments: [promptAttachment('current')],
    parentContexts: [{ taskId: 'parent', taskCode: '父任务', taskTitle: '父任务', taskType: 'requirement', taskDescription: '绿色图片', attachments: [promptAttachment('parent')], conversationPaths: [] }],
    relatedContexts: [{ taskId: 'related', taskCode: '关联任务', taskTitle: '关联任务', taskType: 'requirement', taskDescription: '红色图片', attachments: [promptAttachment('related')], conversationPaths: [] }],
    supplementalAttachments: [promptAttachment('supplemental'), promptAttachment('missing')],
    supplementalInfo: '紫色图片；缺失图片明确失败。',
  });

  useEffect(() => {
    if (window.zeus) {
      setReady(true);
      return;
    }
    /** 固定色块只用于人工组件检查，不访问文件或模型服务。 */
    const colors: Record<string, string> = { current: '#2878d4', parent: '#24844b', related: '#ca4848', supplemental: '#804ac4' };
    /** 按请求路径返回不同图片，缺失来源返回明确失败。 */
    const loadPreview = async (path: string) => {
      setReads((count) => count + 1);
      const source = path.split('/').at(-1)?.replace('.png', '') ?? '';
      if (!colors[source]) return null;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160"><rect width="240" height="160" fill="${colors[source]}"/><text x="12" y="84" fill="white" font-size="25">${source}</text></svg>`;
      return { previewUrl: `data:image/svg+xml,${encodeURIComponent(svg)}`, mimeType: 'image/svg+xml' };
    };
    window.zeus = { getTaskAttachmentPreview: loadPreview } as NonNullable<Window['zeus']>;
    setReady(true);
    return () => {
      delete window.zeus;
    };
  }, []);

  return (
    <main className="macos-ai-app zeus-shell qa-page">
      <h1>推送图片预览验收</h1>
      <Button disabled={!ready} onClick={() => setOpen(true)}>
        打开推送预览
      </Button>
      <output>
        读取次数：{reads}；配置更新：{revision}；推送弹窗：{open ? '打开' : '关闭'}
      </output>
      {open ? (
        <ModalPortal onDismiss={() => setOpen(false)}>
          <form
            className="task-model-push-modal zeus-solid-form-surface"
            role="dialog"
            aria-label="图片验收推送弹窗"
            onSubmit={(event) => event.preventDefault()}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setOpen(false);
            }}
          >
            <div className="task-model-push-body">
              <Button onClick={() => setRevision((value) => value + 1)}>更新配置</Button>
              <TaskPushLayoutPreview layout={layout} language="zh-CN" previewAttachments={attachments} />
              <Button onClick={() => setOpen(false)}>关闭推送预览</Button>
            </div>
          </form>
        </ModalPortal>
      ) : null}
    </main>
  );
}

/** 人工验收使用的错误来源；合成内容不调用 AI 服务或修改任务。 */
const copyErrorScenes: Array<{ id: string; title: string; error: UserFacingErrorCause; archive?: boolean }> = [
  { id: 'login', title: '未登录', error: { code: 'ZEUS_UNIFIED_QUEUE_HEAD_FAILED', message: 'Queue paused', cause: { code: 'ZEUS_CODEX_LOGIN_REQUIRED', message: 'Sign-in required' } } },
  { id: 'permission', title: '权限不足', error: { code: 'EACCES', message: 'Permission denied: /Users/example/private/data' } },
  { id: 'connection', title: '连接中断', error: { code: 'ECONNRESET', message: 'Connection reset' } },
  { id: 'quota', title: '用量限制', error: { code: 'insufficient_quota', message: 'Usage limit reached' } },
  { id: 'rejected', title: '模型拒绝', error: { code: 'content_filter', message: 'Request declined by model service' } },
  { id: 'configuration', title: '配置错误', error: { code: 'ZEUS_MODEL_API_KEY_REQUIRED', message: 'API key missing' } },
  {
    id: 'archive',
    title: '归档受阻',
    archive: true,
    error: { code: 'ZEUS_NATIVE_CONVERSATION_IN_PROGRESS', message: 'Conversation has unfinished work', cause: { code: 'ZEUS_CONVERSATION_ARCHIVE_PENDING_REQUEST', message: 'Pending approval' } },
  },
  { id: 'unknown', title: '原因未知与脱敏', error: { code: 'ZEUS_UNRECOGNIZED_EXAMPLE', message: 'Unexpected failure api_key=qa-secret-value token=qa-token-value /Users/example/private-file\nBearer qa-bearer-value' } },
  { id: 'outcome', title: '结果未确认', error: { code: 'ZEUS_CONVERSATION_DISPATCH_COMMAND_OUTCOME_UNKNOWN', message: 'Result unconfirmed', cause: { code: 'ECONNRESET', message: 'Connection interrupted after write' } } },
  { id: 'unsent', title: '恢复未发消息', error: { code: 'ZEUS_RECOVERED_UNSENT_CONFIRMATION_REQUIRED', message: 'Recovered unsent message' } },
];

/** 切换状态并驱动生产组件，核对失败、检查、恢复和再次失败的操作语义。 */
function CopyErrorQa() {
  const [language, setLanguage] = useState<'zh-CN' | 'en'>(new URLSearchParams(window.location.search).get('language') === 'en' ? 'en' : 'zh-CN');
  const [selected, setSelected] = useState(copyErrorScenes[0]!);
  const [phase, setPhase] = useState<'failed' | 'checking' | 'waiting' | 'complete'>('failed');
  const [action, setAction] = useState('尚未执行操作');
  const checkCompletion = useRef<((error?: Error) => void) | null>(null);
  const zh = language === 'zh-CN';
  const error = selected.error;
  const item: NativeSessionItemBuffer = {
    key: 'copy-message',
    conversationId: 'copy-qa',
    threadId: '',
    turnId: 'copy-turn',
    itemId: 'copy-item',
    localItemId: 'copy-submission',
    type: 'userMessage',
    phase: 'user',
    text: '请继续处理这项任务。',
    status: phase === 'waiting' ? 'queued' : 'paused',
    optimistic: true,
    resources: [],
    updatedAt: '2026-09-05T00:00:00.000Z',
    payload: {
      pausedReason: selected.id === 'unsent' ? 'recovered_unsent' : 'recovery_required',
      recoveryKind: phase === 'waiting' ? 'interaction_response' : undefined,
      deliveryError: { ...error, recoveryRequired: true, retryable: false },
    },
  };
  const check = () =>
    new Promise<void>((resolve, reject) => {
      setPhase('checking');
      setAction('正在核对；未重发消息');
      checkCompletion.current = (failure) => {
        checkCompletion.current = null;
        if (failure) reject(failure);
        else resolve();
      };
    });
  const finishCheck = (failed: boolean) => {
    checkCompletion.current?.(failed ? Object.assign(new Error('Second attempt failed'), { code: 'ECONNRESET' }) : undefined);
    setPhase(failed ? 'failed' : 'waiting');
    setAction(failed ? '检查再次失败；未重发消息' : '检查完成，进入恢复等待');
  };
  return (
    <main className="macos-ai-app zeus-shell qa-page">
      <header className="qa-heading">
        <h1>{zh ? '用户提示语验收' : 'User message review'}</h1>
        <Button onClick={() => setLanguage(zh ? 'en' : 'zh-CN')}>{zh ? 'Switch to English' : '切换中文'}</Button>
        <nav className="qa-scenes" aria-label="错误场景">
          {copyErrorScenes.map((scene) => (
            <Button
              key={scene.id}
              disabled={phase === 'checking'}
              onClick={() => {
                setSelected(scene);
                setPhase('failed');
                setAction('尚未执行操作');
              }}
            >
              {scene.title}
            </Button>
          ))}
        </nav>
      </header>
      <div className="qa-themes">
        <section className="qa-theme theme-light session-codex-parity-v1" data-theme="light">
          <h2>{zh ? '消息处理' : 'Message processing'}</h2>
          {phase === 'complete' ? (
            <p role="status">{zh ? '已完成处理。' : 'Processing complete.'}</p>
          ) : selected.archive ? (
            <VisibleApplicationError error={error} language={language} />
          ) : (
            <MessageDeliveryOutcomeFeedback
              key={selected.id}
              item={item}
              submissionId="copy-submission"
              language={zh ? 'zh-CN' : 'en-US'}
              onRecoverQueue={check}
              onOpenAiSettings={(section) => setAction(section === 'runtime' ? '导航：设置 → AI 连接' : '导航：设置 → 模型供应商')}
              onReconnectCodex={() => setAction('请求连接 Codex；未重发消息')}
              onRetryQueuedSubmission={() => {
                setAction('请求发送已确认未发送的消息');
                setPhase('waiting');
              }}
              onCancelQueuedSubmission={() => {
                setAction('请求取消此消息');
                setPhase('complete');
              }}
            />
          )}
          <p role="status" aria-label="操作记录">
            {action}
          </p>
        </section>
        <section className="qa-theme theme-dark" data-theme="dark">
          <h2>{zh ? '相同原因的深色显示' : 'The same cause in dark appearance'}</h2>
          <VisibleApplicationError error={error} language={language} />
          <p>{describeUserFacingError(error, language).outcomeUnconfirmed ? (zh ? '上次操作结果未确认' : 'The previous result is unconfirmed') : ''}</p>
        </section>
      </div>
      <nav className="qa-scenes" aria-label="验收状态控制">
        <Button disabled={phase !== 'checking'} onClick={() => finishCheck(false)}>
          完成检查：恢复
        </Button>
        <Button disabled={phase !== 'checking'} onClick={() => finishCheck(true)}>
          完成检查：仍失败
        </Button>
        <Button disabled={phase === 'checking'} onClick={() => setPhase('complete')}>
          显示正常完成
        </Button>
        <Button disabled={phase === 'checking'} onClick={() => setPhase('failed')}>
          再次失败
        </Button>
      </nav>
      <ApplicationErrorDialogHost language={language} />
    </main>
  );
}

/** 在既有验收入口运行真实审核组件；仅模拟文件读取与撤销结果。 */
function MarkdownReviewQa() {
  /** 通过查询参数覆盖窄分栏、深色和英文场景。 */
  const parameters = new URLSearchParams(window.location.search);
  /** 保持与实际会话一致的语言类型。 */
  const language = parameters.has('en') ? 'en-US' : 'zh-CN';
  /** 预览中的慢响应同时覆盖快速切换文件后的结果隔离。 */
  const [reads, setReads] = useState(0);
  /** 记录真实行号回调，核对撤销前后的左右定位。 */
  const [openedLine, setOpenedLine] = useState('');
  /** 每个失败样本第一次报错，显式重试后恢复读取。 */
  const failed = useRef(false);
  /** 全宽切换复用审核页真实按钮。 */
  const [fullWidth, setFullWidth] = useState(!parameters.has('narrow'));
  /** 本地评论保留在预览切换期间。 */
  const [comments, setComments] = useState<ConversationCodeComment[]>([]);
  /** 固定验收文件不依赖用户工作区或外部服务。 */
  const [changeSet, setChangeSet] = useState<TurnChangeSet>(() => ({
    id: 'qa-review',
    projectId: 'qa-project',
    conversationId: 'qa-conversation',
    turnId: 'qa-turn',
    providerTurnId: 'qa-turn',
    state: 'applied',
    fileCount: 5,
    addedLines: 10,
    deletedLines: 5,
    unifiedDiff: '',
    preImageDigest: null,
    postImageDigest: null,
    unavailableReason: null,
    conflict: null,
    createdAt: '2026-09-08T00:00:00Z',
    updatedAt: '2026-09-08T00:00:00Z',
    files: ['docs/TASK_20260908_002_可逆界面操作速度实测.md', 'docs/第二份.MARKDOWN', 'docs/重试.mdx', 'docs/空文件.md', 'src/index.ts'].map((path, index) => ({
      id: String(index),
      oldPath: path,
      newPath: path,
      changeType: 'modified',
      addedLines: 2,
      deletedLines: 1,
      unifiedDiff:
        index === 4
          ? "diff --git a/src/index.ts b/src/index.ts\nindex 123..456 100644\n--- a/src/index.ts\n+++ b/src/index.ts\n@@ -10,3 +10,4 @@\n export function demo() {\n-  const value = 'old';\n+  const value = 'new';\n+  const extra = true;\n }\n@@ -30 +31 @@\n---old marker\n\\ No newline at end of file\n+++new marker\n\\ No newline at end of file\n"
          : `@@ -1,2 +1,3 @@\n # 审核样例\n-旧内容\n+新内容\n+第二行`,
      preHash: null,
      postHash: null,
      reversible: true,
      unavailableReason: null,
    })),
  }));
  return (
    <main className={`macos-ai-app ${parameters.has('dark') ? 'theme-dark' : ''}`} data-theme={parameters.has('dark') ? 'dark' : 'light'}>
      <p role="status">
        Markdown 审核验收 · 读取次数：{reads} · 打开位置：{openedLine || '无'}
      </p>
      <div className="session-codex-parity-v1" style={{ display: 'flex', width: fullWidth ? '100%' : 640, maxWidth: '100%', height: 'calc(100vh - 64px)' }}>
        {parameters.has('delivery') ? (
          <TaskGitDiffTable
            hasSelection
            zh={language === 'zh-CN'}
            diff={{
              oldPath: 'src/index.ts',
              newPath: 'src/index.ts',
              changeType: 'modified',
              addedLines: 1,
              deletedLines: 1,
              hunks: [
                {
                  header: '@@ -1,2 +1,2 @@',
                  oldStart: 1,
                  oldLines: 2,
                  newStart: 1,
                  newLines: 2,
                  lines: [
                    { type: 'context', content: 'export const demo = true;', oldLineNumber: 1, newLineNumber: 1 },
                    { type: 'deletion', content: 'const value = 1;', oldLineNumber: 2, newLineNumber: null },
                    { type: 'addition', content: 'const value = 2;', oldLineNumber: null, newLineNumber: 2 },
                  ],
                },
              ],
            }}
          />
        ) : (
          <TurnDiffWorkspace
            changeSet={changeSet}
            language={language}
            fullWidth={fullWidth}
            onFullWidthChange={setFullWidth}
            onClose={() => setReads(0)}
            comments={comments}
            onCommentsChange={setComments}
            onOpenFile={(file, line) => setOpenedLine(`${file.newPath ?? file.oldPath}:${line ?? '全文'}`)}
            onOperate={async (current, action) => {
              /** 模拟持久状态更新，让预览经过与产品相同的刷新边界。 */
              const next = { ...current, state: action === 'undo' ? ('undone' as const) : ('applied' as const), updatedAt: new Date().toISOString() };
              setChangeSet(next);
              return { changeSet: next, auditEventId: null };
            }}
            onLoadPreview={async (current, file) => {
              setReads((value) => value + 1);
              await new Promise((resolve) => setTimeout(resolve, file.id === '0' ? 1500 : 100));
              if (file.id === '2' && !failed.current) {
                failed.current = true;
                throw new Error('预览文件读取失败，请重试。');
              }
              /** 全文包含补丁外上下文，便于辨认完整预览和差异片段。 */
              const content =
                file.id === '3'
                  ? ''
                  : `# ${file.id === '1' ? '第二份文档' : 'Zeus Test 本轮实测'}\n\n${current.state === 'undone' ? '撤销后的内容' : '当前完整内容'}，含补丁外的开头段落。\n\n## 操作统计\n\n| 流程 | 操作调用秒 | 读取调用秒 |\n| --- | ---: | ---: |\n| 自动化 → 扩展管理 | 0.258 | 0.820 |\n| 搜索 → 清空 | 0.180 | 0.296 |\n\n正文中的 \`Date.now()\` 应当保持行内显示。\n\n- 保留差异审核\n- 支持 Markdown 预览\n\n\`\`\`ts\nconst elapsed = Date.now();\n\`\`\`\n\n> 结束语：完整文档可正常阅读。`;
              return {
                kind: 'source',
                content,
                language: 'markdown',
                lineCount: content.split('\n').length,
                truncated: false,
                resource: {
                  id: file.id,
                  projectId: current.projectId,
                  conversationId: current.conversationId,
                  turnId: current.turnId,
                  itemId: file.id,
                  kind: 'file',
                  presentation: 'inline',
                  displayName: file.newPath!,
                  projectRelativePath: file.newPath!,
                  iconKind: 'markdown',
                  createdAt: current.createdAt,
                  updatedAt: current.updatedAt,
                },
              };
            }}
          />
        )}
      </div>
    </main>
  );
}

/** 完整目录与延迟正文使用模拟数据，交互、虚拟化和动画均使用生产组件。 */
function NavigationQa() {
  /** 地址允许独立核对超过七条、长历史和窄窗口。 */
  const parameters = useMemo(() => new URLSearchParams(window.location.search), []);
  /** 模拟先取得历史目录、随后模型确认编号的任务推送恢复。 */
  const taskHistory = parameters.has('task-history');
  /** 任务正文沿用发送时的布局快照，两条相同文字的独立发送仍分别保留。 */
  const taskLayout = useMemo(
    () =>
      buildTaskPushLayout({
        taskTitle: '任务详情页优化',
        taskType: 'optimization',
        optimizationCurrentState: '优化信息布局，可以考虑增加 1/3 宽度来重构布局。\n保留任务说明的分段和完整内容。',
        conversationPaths: ['/workspace/history/任务详情页优化.jsonl'],
        supplementalInfo: '根据历史对话中的功能点进行验收。',
      }),
    [],
  );
  /** 目录总量可自然增减，不改变生产导航规则。 */
  const [count, setCount] = useState(Math.max(1, Math.min(10000, Number(parameters.get('count')) || 1000)));
  /** 启动时只读取最后四轮正文。 */
  const [loaded, setLoaded] = useState(() => new Set(Array.from({ length: 4 }, (_, index) => count - 4 + index).filter((index) => index >= 0)));
  /** 持续生成只向最后一轮追加文字。 */
  const [revision, setRevision] = useState(0);
  /** 手动控制持续生成，便于比较静止和生成中的帧耗时。 */
  const [streaming, setStreaming] = useState(false);
  /** 两种主题使用正式主题变量。 */
  const [dark, setDark] = useState(parameters.has('dark'));
  /** 窄容器模拟应用侧栏占用空间。 */
  const [narrow, setNarrow] = useState(parameters.has('narrow'));
  /** 失败由下一次真实读取回调抛出，重试仍经过生产入口。 */
  const directoryFailure = useRef(parameters.has('directory-failure'));
  /** 正文失败只作用于最早轮次。 */
  const bodyFailure = useRef(parameters.has('body-failure'));
  /** 挂载节点用于只读采样实际滚动、帧和长任务。 */
  const surface = useRef<HTMLDivElement>(null);
  /** 运行记录不写入应用数据。 */
  const [report, setReport] = useState('等待运行检查');
  /** 计时器在离开验收页时停止。 */
  const frameRef = useRef(0);
  /** 目录本身与正文加载集合互不依赖。 */
  const entries = useMemo<ConversationNavigationEntry[]>(
    () =>
      Array.from({ length: count }, (_, index) => ({
        id: `history-${index}`,
        turnId: `turn-${index}`,
        providerTurnId: `turn-${index}`,
        clientUserMessageId: taskHistory ? null : `client-${index}`,
        providerItemId: taskHistory ? null : `user-${index}`,
        sequence: index * 2 + 1,
        occurredAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
        /** 示例使用普通发言，避免把验收序号误当成产品标题。 */
        prompt: taskHistory
          ? '任务详情页优化 现状： 优化信息布局，可以考虑增加 1/3 宽度来重构布局 当前任务历史会话信息：…'
          : ['任务说明直接收起来了吗？', '请保留完整的任务说明。', '鼠标移出后应该回到原来的阅读位置。', '预览里只显示发言和答复。'][index % 4]!,
        response: '任务说明已保留，可以继续阅读完整内容。请连续移动鼠标，检查内容切换是否平稳、预览是否保持在窗口内，以及正文阅读位置是否保持。',
        status: 'completed',
      })),
    [count, taskHistory],
  );
  /** 目录首次读取与正文独立。 */
  const loadNavigation = useCallback(async () => {
    if (directoryFailure.current) throw new Error('验收注入：目录读取失败');
    return { conversationId: 'qa-navigation', throughEventSeq: 1, entries };
  }, [entries]);
  /** 延迟补齐目标轮次，让锚点补偿经历真实组件尺寸变化。 */
  const loadTurn = useCallback(async (turnId: string) => {
    await new Promise((resolve) => setTimeout(resolve, 120));
    if (bodyFailure.current && turnId === 'turn-0') throw new Error('验收注入：最早正文读取失败');
    /** 目录身份直接映射示例轮次。 */
    const index = Number(turnId.slice(5));
    setLoaded((previous) => (previous.has(index) ? previous : new Set([...previous, index])));
  }, []);
  useEffect(() => {
    if (!streaming) return;
    /** 每秒十次增量复现持续生成，计数不影响稳定消息身份。 */
    const timer = setInterval(() => setRevision((value) => value + 1), 100);
    return () => clearInterval(timer);
  }, [streaming]);
  useEffect(() => () => cancelAnimationFrame(frameRef.current), []);
  /** 实际正文只投影已经读取的轮次。 */
  const state = useMemo<NativeSessionState>(() => {
    /** 时间线保持用户与答复的真实相对顺序。 */
    const items: NativeSessionItemBuffer[] = [...loaded]
      .sort((a, b) => a - b)
      .flatMap((index) => {
        /** 超出当前目录的旧验收项不会进入新场景。 */
        const entry = entries[index];
        if (!entry) return [];
        return ['user', 'assistant'].map((role) => ({
          key: `${role}-${index}`,
          conversationId: 'qa-navigation',
          threadId: 'qa-navigation',
          turnId: entry.turnId,
          itemId: role === 'user' ? (taskHistory ? `user-${index}` : entry.id) : `answer-${index}`,
          providerItemId: role === 'user' ? `user-${index}` : `answer-${index}`,
          ...(role === 'user' ? { localItemId: entry.id, ...(entry.clientUserMessageId ? { clientUserMessageId: entry.clientUserMessageId } : {}) } : {}),
          type: role === 'user' ? 'userMessage' : 'agentMessage',
          phase: role === 'user' ? 'user' : 'final_answer',
          status: 'completed',
          text: role === 'user' ? entry.prompt : entry.response.repeat(3) + (index === count - 1 ? ' 生成内容。'.repeat(revision % 200) : ''),
          payload: { v2Sequence: entry.sequence + (role === 'user' ? 0 : 1), ...(taskHistory && role === 'user' ? { taskPushLayout: taskLayout } : {}) },
          resources: [],
          updatedAt: entry.occurredAt,
        }));
      });
    return {
      ...createInitialSessionState(),
      conversationId: 'qa-navigation',
      transportState: 'ready',
      conversationState: 'idle',
      transcriptRevision: revision,
      items: Object.fromEntries(items.map((item) => [item.key, item])),
      itemOrder: items.map((item) => item.key),
      turnsByProviderId: Object.fromEntries(
        entries.map((entry) => [
          entry.turnId,
          { id: entry.turnId, providerTurnId: entry.turnId, submissionId: null, status: 'completed', startedAt: entry.occurredAt, completedAt: entry.occurredAt, createdAt: entry.occurredAt, updatedAt: entry.occurredAt },
        ]),
      ),
      terminalTurnIds: Object.fromEntries(entries.map((entry) => [entry.turnId, 'completed'])),
    };
  }, [loaded, entries, revision, count, taskHistory, taskLayout]);

  /** 记录真实帧间隔、长任务和预览容器身份；采样本身不移动鼠标或正文。 */
  function recordFrames() {
    cancelAnimationFrame(frameRef.current);
    /** 宿主元素只在开始时读取，采样不逐帧测量布局。 */
    const transcript = surface.current?.querySelector<HTMLElement>('.session-transcript');
    /** 起始滚动用于核对悬停是否误触发正文定位。 */
    const initialScroll = transcript?.scrollTop ?? 0;
    /** 帧间隔来自浏览器实际时钟。 */
    const frames: number[] = [];
    /** 长任务记录主线程阻塞。 */
    const tasks: number[] = [];
    /** 卡片重建数用于检查相邻预览是否闪回入场。 */
    const cards = new Set<Element>();
    /** 只在有长任务时回调，不逐帧扫描正文。 */
    const observer = new PerformanceObserver((list) => tasks.push(...list.getEntries().map((entry) => entry.duration)));
    observer.observe({ type: 'longtask', buffered: false });
    /** 有限采样便于比较不同操作。 */
    const started = performance.now();
    /** 上一帧时刻用于计算间隔。 */
    let previous = started;
    setReport('采样 10 秒：可扫过、反向、移出重入和进入卡片。');
    /** 只读取帧时钟、滚动值与容器身份，不写入被验收界面。 */
    const sample = (now: number) => {
      frames.push(now - previous);
      previous = now;
      /** 单个已知浮层选择器与正文列表无关。 */
      const card = document.querySelector('.session-navigation-preview');
      if (card) cards.add(card);
      if (now - started < 10000) {
        frameRef.current = requestAnimationFrame(sample);
        return;
      }
      observer.disconnect();
      frames.sort((a, b) => a - b);
      /** 中位数估算当前浏览器实际帧节奏，不冒充显示器规格。 */
      const median = frames[Math.floor(frames.length / 2)] ?? 0;
      setReport(
        JSON.stringify(
          {
            frames: frames.length,
            medianMs: median,
            p95Ms: frames[Math.floor(frames.length * 0.95)],
            maxMs: frames[frames.length - 1],
            overOneAndHalfFrames: frames.filter((value) => value > median * 1.5).length,
            longTasks: tasks,
            previewContainers: cards.size,
            scrollDelta: (transcript?.scrollTop ?? 0) - initialScroll,
            ticks: surface.current?.querySelectorAll('.session-navigation-tick').length,
            renderedRows: surface.current?.querySelectorAll('[data-transcript-row-key]').length,
            reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
          },
          null,
          2,
        ),
      );
    };
    frameRef.current = requestAnimationFrame(sample);
  }
  return (
    <main
      className={`macos-ai-app zeus-shell session-codex-parity-v1 theme-${dark ? 'dark' : 'light'}`}
      data-theme={dark ? 'dark' : 'light'}
      style={{ padding: '48px 16px 16px', height: '100vh', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: 8 }}
    >
      <nav aria-label="刻度验收控制" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Button onClick={() => setDark(!dark)}>深色</Button>
        <Button onClick={() => setNarrow(!narrow)}>窄窗口</Button>
        <Button
          onClick={() => {
            setLoaded((previous) => new Set([...previous, count]));
            setCount(count + 1);
          }}
        >
          新增发言
        </Button>
        <Button onClick={() => setStreaming(!streaming)}>{streaming ? '停止生成' : '持续生成'}</Button>
        <Button
          onClick={() => {
            directoryFailure.current = false;
            bodyFailure.current = false;
            setReport('故障已解除，可在目录或目标占位点击重试。');
          }}
        >
          解除故障
        </Button>
        <Button onClick={recordFrames}>记录帧耗时</Button>
        <a href="?navigation&count=7">短历史</a>
        <a href="?navigation&count=1000">长历史</a>
        <a href="?navigation&count=8&directory-failure">目录故障</a>
        <a href="?navigation&count=8&body-failure">正文故障</a>
        <a href="?navigation&count=8&task-history">任务推送恢复</a>
        <Button
          onClick={() => {
            /** 几何检查读取真实样式，不修改被验收的生产元素。 */
            const ticks = surface.current?.querySelectorAll<HTMLElement>('.session-navigation-tick');
            /** 采样第一条刻度的真实样式与相邻位置差。 */
            const first = ticks?.[0];
            /** 正文虚拟窗口的节点数独立于目录总量。 */
            const rows = surface.current?.querySelectorAll('[data-transcript-row-key]');
            setReport(
              JSON.stringify(
                {
                  ticks: ticks?.length,
                  tickHeight: first?.getBoundingClientRect().height,
                  pitch: first && ticks?.[1] ? ticks[1].getBoundingClientRect().top - first.getBoundingClientRect().top : null,
                  lineWidth: first?.firstElementChild?.getBoundingClientRect().width,
                  lineHeight: first?.firstElementChild?.getBoundingClientRect().height,
                  renderedRows: rows?.length,
                  loadedTurns: loaded.size,
                  railHeight: surface.current?.querySelector('.session-navigation-rail')?.getBoundingClientRect().height,
                  ...(taskHistory
                    ? {
                        taskHistoryCheck:
                          loaded.has(0) && ticks?.length === count && Boolean(surface.current?.querySelector('.session-task-push-field')) && !surface.current?.querySelector('.session-navigation-placeholder')
                            ? '通过'
                            : '失败：目录重复、任务布局缺失或正文尚未恢复',
                      }
                    : {}),
                },
                null,
                2,
              ),
            );
          }}
        >
          检查布局
        </Button>
      </nav>
      <pre role="status" style={{ margin: 0, maxHeight: 180, overflow: 'auto', whiteSpace: 'pre-wrap', fontSize: 11 }}>
        {report}
      </pre>
      <div ref={surface} className="ai-workspace" style={{ width: narrow ? 360 : '100%', maxWidth: '100%', flex: 1, minHeight: 0, display: 'flex' }}>
        <ConversationTranscript state={state} language="zh-CN" transcriptHydrated onLoadNavigation={loadNavigation} onLoadNavigationTurn={loadTurn} />
      </div>
    </main>
  );
}
