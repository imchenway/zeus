import React, { useEffect, useRef, useState } from 'react';
import { ModelSelectQa } from './model-select-qa.js';
import { asyncMessageQuestions, buildTaskPushLayout, describeUserFacingError, formatAsyncQuestionAnswer, type UserFacingErrorCause } from '@zeus/shared';
import { ConversationTranscript, MessageDeliveryOutcomeFeedback } from '../src/renderer/session/ConversationTranscript.js';
import { ApplicationErrorDialogHost, VisibleApplicationError } from '../src/renderer/ui/ApplicationErrorDialog.js';
import { Button } from '../src/renderer/ui/Button.js';
import { ConversationMarkdown } from '../src/renderer/session/ConversationMarkdown.js';
import { ConversationInlineResource } from '../src/renderer/session/ConversationResources.js';
import { ConversationComposer } from '../src/renderer/session/ConversationComposer.js';
import { SessionActivityGroup } from '../src/renderer/session/SessionActivity.js';
import type { NativeConversationAttachment, NativeSessionItemBuffer, NativeSessionState } from '../src/renderer/session/sessionTypes.js';
import { TaskPushLayoutPreview } from '../src/renderer/task/TaskModelPushModal.js';
import { TurnChangeCard, TurnDiffWorkspace } from '../src/renderer/session/TurnChanges.js';
import { ThreadItemView } from '../src/renderer/session/ThreadItemView.js';
import { TaskGitDiffTable } from '../src/renderer/task/TaskGitDiffTable.js';
import type { ConversationCodeComment, ConversationResource, TurnChangeSet } from '@zeus/shared';
import { ModalPortal } from '../src/renderer/ui/ModalPortal.js';
import { AsyncQuestionPanel } from '../src/renderer/session/AsyncQuestionMessage.js';
import { normalizeRequestQuestions, RequestUserInputPanel } from '../src/renderer/session/PendingRequestSurface.js';
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
  { query: 'queue-actions', title: '排队消息操作', summary: '按真实送达状态核对删除、引导和状态检查入口。', answer: '', activities: [] },
  { query: 'message-layout', title: '消息间距与耗时', summary: '真实时间线的耗时入口与悬停操作栏。', answer: '', activities: [] },
  { query: 'model-select', title: '模型选择与置顶', summary: '共享选择框的分组、焦点、搜索和持久置顶。', answer: '', activities: [] },
  { query: 'paste-focus', title: '附件粘贴焦点', summary: '真实任务输入的异步附件与光标保持。', answer: '', activities: [] },
  { query: 'composer', title: '粘贴 Markdown', summary: '真实输入组件的 Markdown 排版、直接编辑和发送原文。', answer: '', activities: [] },
  { query: 'error-layout', title: '会话错误提示预览', summary: '已确认的提示样式直接来自会话组件。', answer: '', activities: [] },
  { query: 'review', title: 'Markdown 变更审核', summary: '真实审核组件的预览、差异与读取状态。', answer: '', activities: [] },
  { query: 'questions', title: '询问表单', summary: 'PLAN 和异步询问复用相同组件；这里仅模拟提交结果。', answer: '', activities: [] },
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

export function SessionQaApp(props: { scene: QaScene }) {
  if (props.scene.query === 'queue-actions') return <QueueActionsQa />;
  if (props.scene.query === 'message-layout') return <MessageLayoutQa />;
  if (props.scene.query === 'model-select') return <ModelSelectQa />;
  if (props.scene.query === 'error-layout') return <ErrorLayoutQa />;
  if (props.scene.query === 'paste-focus') return <TaskPasteFocusQa />;
  if (props.scene.query === 'composer') return <ComposerMarkdownQa />;
  if (props.scene.query === 'review') return <MarkdownReviewQa />;
  if (props.scene.query === 'questions') return <QuestionQa />;
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

/** 复现真实队列状态并检查生产时间线的操作入口，不连接模型或正式数据。 */
function QueueActionsQa() {
  /** 单条消息在正常排队、未知送达和已接纳之间切换。 */
  const [scenario, setScenario] = useState('outcome_unknown');
  /** 检查只读取当前场景的实际按钮。 */
  const surface = useRef<HTMLDivElement>(null);
  /** 回调结果用于确认检查入口沿用原有恢复操作。 */
  const [result, setResult] = useState('等待检查');
  /** 复用现场错误码，正文使用固定的非业务示例。 */
  const submission = {
    id: 'qa-submission',
    content: '请调整执行人头像的显示。',
    position: 1,
    status: scenario === 'queued' ? 'queued' : scenario === 'accepted' ? 'resolved' : 'paused',
    pausedReason: scenario === 'queued' || scenario === 'accepted' ? null : scenario,
    providerTurnId: scenario === 'accepted' ? 'qa-turn' : null,
    error: scenario === 'outcome_unknown' || scenario === 'recovery_required' ? { code: 'ZEUS_CODEX_RPC_PROTOCOL_ERROR', message: 'Codex 响应无法读取，已发出的操作需要核对结果。', recoveryRequired: scenario === 'recovery_required' } : null,
  };
  /** 活动轮次确保普通队列确实处于等待，而非空闲队首交接。 */
  const state: NativeSessionState = {
    ...createInitialSessionState(),
    conversationId: 'qa-queue',
    transportState: 'ready',
    activeTurnId: 'qa-turn',
    startedTurnId: 'qa-turn',
    conversationState: 'active_prework',
    queue: { state: { type: 'active', turnId: 'qa-turn', phase: 'prework' }, submissions: [submission] },
  };
  /** 只比较用户可见的按钮，防止恢复状态重新暴露删除或引导。 */
  function checkActions(): void {
    /** 待发送消息可删除；未知送达只能核对；接纳后不再有队列操作。 */
    const expectedDelete = scenario === 'queued' || scenario === 'recovered_unsent';
    /** 引导只对正常排队消息开放。 */
    const expectedSteer = scenario === 'queued';
    /** 两类未知送达均保留检查入口。 */
    const expectedCheck = scenario === 'outcome_unknown' || scenario === 'recovery_required';
    if (
      Boolean(surface.current?.querySelector('.session-queued-thread-delete')) !== expectedDelete ||
      Boolean(surface.current?.querySelector('.session-queued-thread-steer')) !== expectedSteer ||
      [...(surface.current?.querySelectorAll('button') ?? [])].some((button) => button.textContent === '检查处理状态') !== expectedCheck
    ) {
      throw new Error(`队列操作检查失败：${scenario}`);
    }
    setResult(`运行检查通过：${scenario}`);
  }
  return (
    <main className="macos-ai-app zeus-shell qa-error-layout theme-light" data-theme="light">
      <h1>排队消息操作</h1>
      <nav aria-label="消息状态">
        {['outcome_unknown', 'queued', 'recovery_required', 'recovered_unsent', 'accepted'].map((value, index) => (
          <Button
            key={value}
            aria-pressed={scenario === value}
            onClick={() => {
              setScenario(value);
              setResult('等待检查');
            }}
          >
            {['送达未知', '正常排队', '引导待核对', '已确认未发送', '已接纳'][index]}
          </Button>
        ))}
      </nav>
      <Button onClick={checkActions}>检查操作入口</Button>
      <p role="status">{result}</p>
      <div ref={surface}>
        <ConversationTranscript
          state={state}
          language="zh-CN"
          transcriptHydrated
          onSendQueuedNow={() => setScenario('accepted')}
          onCancelQueuedSubmission={() => setResult('取消回调已触发')}
          onRecoverQueue={() => setResult('检查处理状态回调已触发')}
        />
      </div>
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
  /** 预览主题不修改应用设置。 */
  const [dark, setDark] = useState(parameters.has('dark'));
  /** 通过内容列宽复现任务侧栏空间，不依赖浏览器窗口尺寸。 */
  const [narrow, setNarrow] = useState(parameters.has('narrow'));
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
  /** 真实节点必须可点击，已知网址不匹配或没有受信资源的链接继续保持不可打开。 */
  function checkLinks(): void {
    /** 只读取本场景正文，不将来源入口计入结果。 */
    const buttons = [...(contentRef.current?.querySelectorAll('.session-conversation-markdown .session-inline-resource') ?? [])].map((button) => button.textContent);
    if (buttons.join('|') !== '交互预览|访问网站') throw new Error(`正文链接检查失败：${buttons.join('|')}`);
    setLinkResult('运行检查通过：历史链接和实时链接均可点击，未登记及同名不同网址的链接不可打开');
  }
  /** 正文与来源入口应传回同一个受信编号，目标由产品原有打开流程决定。 */
  function openResource(resource: ConversationResource): void {
    if (!resources.some((candidate) => candidate.id === resource.id)) throw new Error('资源打开检查失败：编号未登记');
    setLinkResult(`打开回调：${resource.id}`);
  }
  /** 手动运行生产布局检查，覆盖计时合并、缺失过程与缺失时间的展示边界。 */
  function checkLayout(): void {
    /** 完成态仅保留一个耗时，时间未知或仍运行时不显示完成耗时。 */
    const durations = contentRef.current?.querySelectorAll('time.session-turn-duration') ?? [];
    /** 无过程的答复不能出现展开按钮。 */
    const controls = contentRef.current?.querySelectorAll('.session-turn-process-control > button') ?? [];
    if (durations.length !== (active || parameters.has('no-time') ? 0 : 1) || controls.length !== (active || parameters.has('no-process') ? 0 : 1)) throw new Error('耗时或过程入口数量不正确');
    if (durations.length && durations[0]?.getAttribute('datetime') !== 'PT181S') throw new Error('耗时未沿用真实轮次的起止时间');
    /** 有后续交付资源时，耗时仍应位于最终正文前面。 */
    const answer = contentRef.current?.querySelector('.session-thread-item-assistant .session-markdown');
    if (durations[0] && answer && !(durations[0].compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING)) throw new Error('耗时入口没有放在最终正文之前');
    setLinkResult('运行检查通过：耗时只显示一次，过程入口与轮次状态一致');
  }
  /** 合成数据仅经过真实渲染链，不连接或调用模型。 */
  const items: NativeSessionItemBuffer[] = [
    { type: 'userMessage', phase: 'user', text: '请检查浏览器中的会话布局。', payload: {}, status: 'completed' },
    ...(parameters.has('no-process')
      ? []
      : [
          { type: 'commandExecution', phase: 'prework', text: '', payload: { command: ['pnpm', 'build'] }, status: 'completed' },
          { type: 'reasoning', phase: 'prework', text: 'Inspecting browser snapshot', payload: {}, status: active ? 'in_progress' : 'completed' },
        ]),
    ...(!active && !parameters.has('no-answer')
      ? [
          {
            type: 'agentMessage',
            phase: 'final_answer',
            text: links
              ? '已完成会话消息优化。\n\n[交互预览](http://127.0.0.1:4529/qa/session-styles.html?model-select) · [访问网站](https://example.com)\n\n[未登记链接](https://unregistered.example/) · [网站](https://different.example/)'
              : '已检查会话布局，耗时与处理过程合并在正文上方；鼠标放到消息上时显示复制、反馈与时间戳。',
            payload: {},
            status: 'completed',
          },
        ]
      : []),
    ...(!active && parameters.has('deliverable') ? [{ type: 'fileChange', phase: 'prework', text: '', payload: {}, status: 'completed' }] : []),
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
        completedAt: active ? null : completedAt,
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
          <Button onClick={checkLayout}>检查耗时入口</Button>
          {links ? <Button onClick={checkLinks}>检查链接</Button> : null}
        </nav>
      </header>
      <div ref={contentRef} style={{ maxWidth: narrow ? 360 : 1000, margin: 'auto' }}>
        <ConversationTranscript state={state} language={parameters.has('en') ? 'en-US' : 'zh-CN'} transcriptHydrated onOpenResource={openResource} />
      </div>
      <div className="qa-error-layout-note">
        <p role="status">{linkResult}</p>
        {links ? (
          <>
            <span>来源：</span>
            <ConversationInlineResource resource={resources[0]!} label="交互预览" language="zh-CN" onOpenResource={openResource} />
          </>
        ) : null}
      </div>
    </main>
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
    addedLines: 258,
    deletedLines: 25,
    unifiedDiff: '',
    preImageDigest: null,
    postImageDigest: null,
    conflict: null,
    unavailableReason: '连续修改之间的文件内容或权限不一致，无法安全撤销或重新应用。',
    createdAt: '2026-09-08T12:16:00Z',
    updatedAt: '2026-09-08T12:16:00Z',
    files: [
      ['apps/desktop/qa/session-core-qa.tsx', 63, 7],
      ['apps/desktop/src/renderer/session/ConversationComposer.tsx', 2, 1],
      ['apps/desktop/src/renderer/session/session.css', 54, 0],
      ['apps/desktop/src/renderer/session/StructuredComposerInput.tsx', 110, 15],
      ['apps/desktop/src/renderer/session/useConversationInputResources.ts', 20, 1],
      ['apps/desktop/src/renderer/session/SessionWorkspace.tsx', 7, 1],
      ['docs/ZEUS-0375_输入框粘贴Markdown展示.md', 2, 0],
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

/** 使用真实会话输入组件验收粘贴，只在本页记录发送结果，不调用模型。 */
function ComposerMarkdownQa() {
  /** 地址参数覆盖窄分栏、深色和英文。 */
  const parameters = new URLSearchParams(window.location.search);
  /** 草稿沿用真实输入框回写路径。 */
  const [state, setState] = useState(createInitialSessionState);
  /** 展示提交内容，便于比较缩进、转义和技能调用是否保留。 */
  const [submitted, setSubmitted] = useState('');
  /** 只读状态可在编辑期间切换，核对发送和编辑禁用条件。 */
  const [readOnly, setReadOnly] = useState(false);
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
      <h1>粘贴 Markdown</h1>
      <p>Markdown 默认排版，点击内容直接修改；Shift+Enter 换行，Enter 记录发送原文。</p>
      <textarea aria-label="粘贴样例" value={pasteSample} onChange={(event) => setPasteSample(event.currentTarget.value)} style={{ display: 'block', width: '100%', height: 72, marginBlock: 12 }} />
      <label>
        <input type="checkbox" checked={readOnly} onChange={(event) => setReadOnly(event.currentTarget.checked)} />
        只读
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
        <ConversationComposer
          textareaRef={textareaRef}
          state={state}
          language={parameters.has('en') ? 'en-US' : 'zh-CN'}
          readOnly={readOnly}
          permissionMode="auto"
          collaborationMode="default"
          capabilities={{
            generationId: 'qa',
            initializedAt: '',
            projectId: 'qa',
            preferredModel: 'qa-model',
            models: [{ id: 'qa-model', model: 'qa-model', displayName: '验收模型', supportedReasoningEfforts: [], serviceTiers: [] }],
            codexAccount: { generationId: 'qa', requiresOpenaiAuth: false, signedIn: false, accountType: null, planType: null },
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
          onInterrupt={() => undefined}
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
  const synchronous = scenario === 'plan' || scenario === 'multiple';
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
      ...(scenario === 'freeform' || scenario === 'newturn' ? {} : { options: ['手动调整后，关闭再打开同一个任务的代码交付窗口', '重启 Zeus 后，再打开代码交付窗口', '切换到另一个任务的代码交付窗口'] }),
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
    <main className="macos-ai-app zeus-shell qa-page">
      <style>{'.qa-page { display: block !important; box-sizing: border-box; width: 100%; height: auto; overflow: auto; min-width: 0; }'}</style>
      <h1>PLAN 与异步询问共用表单验收</h1>
      <nav aria-label="询问场景">
        {['single', 'plan', 'multi', 'multiple', 'freeform', 'failed', 'closed', 'delivered', 'newturn'].map((name) => (
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
            {scenario === 'plan' || scenario === 'multiple' ? (
              <RequestUserInputPanel
                request={{ id: identity, expiresAt: null }}
                questions={normalizeRequestQuestions({ payload: { questions: asyncMessageQuestions(item.payload).map((question) => ({ ...question, multiple: scenario === 'multiple' })) } })}
                language={language}
                autoFocus
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
