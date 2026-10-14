import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConversationSystemMessage, ConversationSystemMessageInput, ConversationTranscriptEnvelope, ConversationNavigationEntry } from '@zeus/shared';
import { ConversationTranscript } from '../src/renderer/session/ConversationTranscript.js';
import { ConversationComposer } from '../src/renderer/session/ConversationComposer.js';
import { NewConversationComposer } from '../src/renderer/session/SessionWorkspace.js';
import { createInitialSessionState } from '../src/renderer/session/sessionReducer.js';
import type { NativeSessionItemBuffer, NativeSessionState } from '../src/renderer/session/sessionTypes.js';
import { bindDraftSystemMessages } from '../src/renderer/session/conversationSystemMessages.js';
import { buildConversationCommandRequest, conversationClientCommandTypes } from '../src/renderer/features/conversations/conversationCommandClient.js';
import type { CodexConversationCapabilities } from '../src/renderer/features/codex/codexContracts.js';
import { ApplicationErrorDialogHost } from '../src/renderer/ui/ApplicationErrorDialog.js';

/** 地址只指向本任务手动启动的隔离验收服务。 */
const origin = 'http://127.0.0.1:18545';
/** 只提供本地预览模型选项；发送回调明确失败，不运行 Provider。 */
const capabilities: CodexConversationCapabilities = {
  generationId: 'qa',
  initializedAt: '',
  projectId: 'qa',
  preferredModel: 'qa-model',
  models: [{ id: 'qa-model', model: 'QA', sourceName: 'Zeus', displayName: 'QA', supportedReasoningEfforts: [], serviceTiers: [] }],
  codexAccount: { generationId: 'qa', requiresOpenaiAuth: false, signedIn: false, accountType: null, planType: null },
};
/** 固定身份由隔离数据库产生，不连接真实用户会话。 */
interface Fixture {
  projectId: string;
  conversationId: string;
  anchor: ConversationTranscriptEnvelope;
  startedAt: string;
  bodyEntry: ConversationNavigationEntry;
  bodyAnchor: ConversationTranscriptEnvelope;
}

/** 真实消息区、输入框与错误详情组合；故障由预览控制按钮注入。 */
export function SystemMessagesQa() {
  /** 首屏始终从正式系统消息读取接口恢复。 */
  const [fixture, setFixture] = useState<Fixture | null>(null);
  const [state, setState] = useState<NativeSessionState>(createInitialSessionState);
  /** 操作计数用于识别读取重试是否误触发发送。 */
  const [reads, setReads] = useState(0);
  const [sends, setSends] = useState(0);
  const [offline, setOffline] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const [draft, setDraft] = useState(false);
  /** 初次目录失败，用户重试后恢复。 */
  const navigationFailed = useRef(false);
  /** 读取 JSON 保留 HTTP 错误，不将失败当成空页。 */
  const request = useCallback(async (path: string, init?: RequestInit) => {
    const response = await fetch(origin + path, init);
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  }, []);
  useEffect(() => {
    void request('/qa-fixture').then(async (data: Fixture) => {
      const page = await request(`/api/projects/${data.projectId}/conversations/${data.conversationId}/system-messages`);
      /** 第一条正文有真正登记的位置，后续错误与它共享排序空间。 */
      const item: NativeSessionItemBuffer = {
        key: 'qa-before',
        itemId: 'qa-before',
        providerItemId: 'qa-before',
        conversationId: data.conversationId,
        threadId: data.conversationId,
        turnId: 'qa-turn',
        type: 'userMessage',
        phase: 'user',
        status: 'completed',
        text: '报错前的消息',
        payload: {},
        resources: [],
        timelineAt: data.startedAt,
        updatedAt: data.startedAt,
        transcript: data.anchor,
      };
      setState({
        ...createInitialSessionState(),
        projectId: data.projectId,
        conversationId: data.conversationId,
        transportState: 'ready',
        conversationState: 'native_idle',
        items: { [item.key]: item },
        itemOrder: [item.key],
        systemMessages: Object.fromEntries(page.items.map((message: ConversationSystemMessage) => [message.id, message])),
      });
      setFixture(data);
    });
  }, [request]);
  /** 发送系统记录走正式公开命令，断连时只阻断本次写入。 */
  const save = useCallback(
    async (input: ConversationSystemMessageInput): Promise<ConversationSystemMessage> => {
      if (!fixture || offline) throw new Error('验收：连接暂时不可用');
      const body = await buildConversationCommandRequest({ commandType: conversationClientCommandTypes.systemMessageSave, conversationId: fixture.conversationId, value: input });
      const message = await request(`/api/projects/${fixture.projectId}/conversations/${fixture.conversationId}/system-messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      setState((current) => ({ ...current, systemMessages: { ...current.systemMessages, [message.id]: message } }));
      return message;
    },
    [fixture, offline, request],
  );
  /** 目录重试只增加读取次数，不触发发送回调。 */
  const navigation = useCallback(async () => {
    setReads((value) => value + 1);
    if (!navigationFailed.current && !sessionStorage.getItem(`qa-navigation-${fixture!.conversationId}`)) {
      navigationFailed.current = true;
      sessionStorage.setItem(`qa-navigation-${fixture!.conversationId}`, 'reported');
      throw new Error('no such column: process.protocol_family');
    }
    const snapshot = await request(`/api/projects/${fixture!.projectId}/conversations/${fixture!.conversationId}/navigation`);
    return { ...snapshot, entries: [fixture!.bodyEntry] };
  }, [fixture, request]);
  /** 正文失败只重试当前历史读取；成功后使用原位置补入正文。 */
  const loadBody = useCallback(async () => {
    if (!fixture) return;
    setReads((value) => value + 1);
    if (!sessionStorage.getItem(`qa-body-${fixture.conversationId}`)) {
      sessionStorage.setItem(`qa-body-${fixture.conversationId}`, 'reported');
      throw new Error('验收：导航目标正文读取失败');
    }
    setState((current) => {
      const before = current.items['qa-before']!;
      const item = { ...before, key: 'qa-body', itemId: 'qa-body', providerItemId: 'qa-body', turnId: 'qa-body-turn', text: '历史正文内容', timelineAt: fixture.bodyEntry.occurredAt, transcript: fixture.bodyAnchor };
      return { ...current, items: { ...current.items, [item.key]: item }, itemOrder: [...new Set([...current.itemOrder, item.key])] };
    });
  }, [fixture]);
  /** 新消息模拟渲染输入，系统记录仍由真实存储负责。 */
  async function append(): Promise<void> {
    const position = await request('/qa-next', { method: 'POST' });
    setSends((value) => value + 1);
    setState((current) => {
      const id = `qa-after-${crypto.randomUUID()}`;
      const previous = current.items['qa-before']!;
      const item = { ...previous, key: id, itemId: id, providerItemId: id, text: `报错后的消息 ${sends + 1}`, timelineAt: new Date().toISOString(), transcript: position };
      return { ...current, items: { ...current.items, [id]: item }, itemOrder: [...current.itemOrder, id] };
    });
  }
  if (!fixture) return <p>正在加载隔离会话…</p>;
  return (
    <main
      className="macos-ai-app zeus-shell session-codex-parity-v1 qa-error-layout theme-light"
      data-theme="light"
      style={{ maxWidth: narrow ? 430 : 1000, width: '100%', height: '100vh', margin: 'auto', display: 'flex', flexDirection: 'column' }}
    >
      <header className="qa-error-layout-heading">
        <h1>Zeus 系统消息验收</h1>
        <nav aria-label="验收控制">
          <button onClick={() => void append()}>追加后续消息</button>
          <button onClick={() => setNarrow(!narrow)} aria-pressed={narrow}>
            窄窗口
          </button>
          <button onClick={() => setOffline(!offline)} aria-pressed={offline}>
            断连写入
          </button>
          <button onClick={() => setDraft(!draft)} aria-pressed={draft}>
            创建前草稿
          </button>
          <button
            onClick={() => {
              bindDraftSystemMessages(fixture.projectId, null, fixture.conversationId);
              setDraft(false);
            }}
          >
            归入此会话
          </button>
        </nav>
        <p>
          读取 {reads} 次 · 用户发送 {sends} 次 · 系统记录 {Object.keys(state.systemMessages ?? {}).length} 条
        </p>
      </header>
      <div className="conversation-pane" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {draft ? (
          <NewConversationComposer
            language="zh-CN"
            owner={{ kind: 'project', projectId: fixture.projectId }}
            task={null}
            capabilities={capabilities}
            onStartProject={async () => {
              throw new Error('验收：新会话创建失败');
            }}
            onChooseAttachments={async () => {
              throw new Error('验收：草稿附件读取失败');
            }}
          />
        ) : (
          <>
            <ConversationTranscript state={state} language="zh-CN" transcriptHydrated onSaveSystemMessage={save} onLoadNavigation={navigation} onLoadNavigationTurn={loadBody} />
            <ConversationComposer
              capabilities={capabilities}
              state={state}
              language="zh-CN"
              permissionMode="read-only"
              collaborationMode="default"
              onDraftChange={(text) => setState((current) => ({ ...current, draft: text }))}
              onSubmit={() => {
                setSends((value) => value + 1);
                throw new Error('验收：提交失败');
              }}
              onInterrupt={() => undefined}
              onChooseAttachments={async () => {
                throw new Error('验收：附件读取失败');
              }}
            />
          </>
        )}
      </div>
      <ApplicationErrorDialogHost language="zh-CN" />
    </main>
  );
}
