import React, { useEffect, useRef, useState } from 'react';
import { asyncMessageQuestions, buildTaskPushLayout, describeUserFacingError, type UserFacingErrorCause } from '@zeus/shared';
import { MessageDeliveryOutcomeFeedback } from '../src/renderer/session/ConversationTranscript.js';
import { ApplicationErrorDialogHost, VisibleApplicationError } from '../src/renderer/ui/ApplicationErrorDialog.js';
import { Button } from '../src/renderer/ui/Button.js';
import { ConversationMarkdown } from '../src/renderer/session/ConversationMarkdown.js';
import { SessionActivityGroup } from '../src/renderer/session/SessionActivity.js';
import type { NativeConversationAttachment, NativeSessionItemBuffer, NativeSessionState } from '../src/renderer/session/sessionTypes.js';
import { TaskPushLayoutPreview } from '../src/renderer/task/TaskModelPushModal.js';
import { ModalPortal } from '../src/renderer/ui/ModalPortal.js';
import { AsyncQuestionMessage, AsyncQuestionPanel } from '../src/renderer/session/AsyncQuestionMessage.js';
import { normalizeRequestQuestions, RequestUserInputPanel } from '../src/renderer/session/PendingRequestSurface.js';
import { createInitialSessionState } from '../src/renderer/session/sessionReducer.js';

interface QaScene {
  query: string;
  title: string;
  summary: string;
  answer: string;
  activities: Array<{ type: string; status: string; text?: string; payload?: Record<string, unknown> }>;
}

const scenes: QaScene[] = [
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

/** 复用真实询问组件的手动验收入口，不连接或冒充真实模型。 */
function QuestionQa() {
  /** 场景通过地址参数切换，刷新可重置本次提交次数。 */
  const scenario = new URLSearchParams(window.location.search).get('case') ?? 'single';
  /** 独立问题身份避免各场景草稿串用。 */
  const identity = `qa-question-${scenario}`;
  /** 答复送达通过按钮推进，以便观察接收和送达的区别。 */
  const [delivery, setDelivery] = useState(scenario === 'delivered' ? 'resolved' : '');
  /** 已接收的表单立即收起，可手动重新挂载检查草稿。 */
  const [open, setOpen] = useState(true);
  /** 次数与正文是浏览器交互检查的可见证据。 */
  const [calls, setCalls] = useState(0);
  /** 保存当前已接收的回答。 */
  const [answers, setAnswers] = useState<Record<string, { answers: string[] }>>({ question_1: { answers: ['手动调整后，关闭再打开同一个任务的代码交付窗口'] } });
  /** 与截图一致的长标题和选项，也覆盖只有自由输入的问题。 */
  const questions = [
    {
      title: '尺寸会在哪一步变回去？我已确认本机有保存记录，这个信息能帮我区分保存错误和重新打开时的恢复错误。',
      ...(scenario === 'freeform' ? {} : { options: ['手动调整后，关闭再打开同一个任务的代码交付窗口', '重启 Zeus 后，再打开代码交付窗口', '切换到另一个任务的代码交付窗口'] }),
    },
    ...(scenario === 'multi' ? [{ title: '第二个问题：请选择窗口位置。', options: ['上次的屏幕', '当前屏幕'] }] : []),
  ];
  /** 活动问题携带答复记录，状态中刻意不放用户回答气泡。 */
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
  /** 只建立组件需要的会话状态，其余沿用生产初始值。 */
  const state: NativeSessionState = {
    ...createInitialSessionState(),
    conversationId: item.conversationId,
    activeTurnId: item.turnId,
    items: { [identity]: item },
    terminalTurnIds: scenario === 'closed' ? { [item.turnId]: 'completed' } : {},
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
      <style>{'.qa-page { display: block !important; width: 100%; height: auto; overflow: auto; min-width: 0; }'}</style>
      <h1>PLAN 与异步询问共用表单验收</h1>
      <nav aria-label="询问场景">
        {['single', 'plan', 'multi', 'multiple', 'freeform', 'failed', 'closed', 'delivered'].map((name) => (
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
      <section className="workspace-detail-pane session-codex-parity-v1" style={{ maxWidth: 900, margin: '24px auto' }}>
        <AsyncQuestionMessage item={item} state={state} language="zh-CN" onOpen={() => setOpen(true)} />
        {open && !delivery ? (
          <div className="session-interaction-dock">
            {scenario === 'plan' || scenario === 'multiple' ? (
              <RequestUserInputPanel
                request={{ id: identity, expiresAt: null }}
                questions={normalizeRequestQuestions({ payload: { questions: asyncMessageQuestions(item.payload).map((question) => ({ ...question, multiple: scenario === 'multiple' })) } })}
                language="zh-CN"
                autoFocus
                onRespond={async (_id, response) => {
                  await accept(item, response.answers as typeof answers);
                  setOpen(false);
                }}
              />
            ) : (
              <AsyncQuestionPanel item={item} state={state} language="zh-CN" onAnswer={accept} onDismiss={() => setOpen(false)} />
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
        <section className="qa-theme theme-light" data-theme="light">
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
