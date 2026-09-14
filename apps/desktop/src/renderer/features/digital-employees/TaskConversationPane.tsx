import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { NativeConversationChoice } from '../../session/sessionTypes.js';
import { Button } from '../../ui/Button.js';
import { VisibleApplicationError } from '../../ui/ApplicationErrorDialog.js';
import { ZeusSelect } from '../../ZeusSelect.js';
import { DigitalEmployeeAvatar } from './DigitalEmployeeAvatar.js';
import type { DigitalEmployeeRecord, TaskWorkItemRecord } from './digitalEmployeeContracts.js';

/** 任务内仅选择原会话；正文、草稿、请求回答和发送都交给原会话组件。 */
export interface TaskConversationPaneProps {
  /** 当前任务已持久化的可见会话。 */
  conversations: NativeConversationChoice[];
  /** 正在载入列表时不能展示空任务文案。 */
  loading?: boolean;
  /** 列表失败与会话读取失败分别就近呈现。 */
  error?: string | null;
  /** 员工身份用于解释会话来自哪份工作。 */
  employees: DigitalEmployeeRecord[];
  /** 工作运行中的会话可能比会话列表更早抵达。 */
  items: TaskWorkItemRecord[];
  /** 当前唯一控制器所选择的会话身份。 */
  activeConversationId?: string | null;
  /** 复用原会话组件，不另建聊天投影或发送接口。 */
  workspace?: ReactNode;
  /** 直接在任务内创建同源单聊或群聊。 */
  newWorkspace?: ReactNode;
  /** 具体工作和待办可要求定位原会话。 */
  conversationRequest?: { conversationId: string } | null;
  /** 全局界面语言。 */
  language: 'zh-CN' | 'en-US';
  /** 选择会话保留任务详情，并读取原会话权威身份。 */
  onSelect?(conversationId: string): Promise<void>;
  /** 完整页面用于更宽的代码、浏览器和长会话阅读。 */
  onOpen?(conversationId: string): void;
  /** 重读会话列表，不创建任何会话。 */
  onReload?(): void;
}

/** 会话选择只影响沟通目标，员工和工作筛选不改变已保存的草稿。 */
export function TaskConversationPane(props: TaskConversationPaneProps) {
  /** 文案沿用应用语言。 */
  const zh = props.language === 'zh-CN';
  /** 当前阅读目标独立于全局控制器，避免读取期间显示上一位员工的内容。 */
  const [creating, setCreating] = useState(false);
  /** 创建接纳后切换原会话；普通刷新不覆盖用户阅读目标。 */
  const lastActive = useRef(props.activeConversationId);
  useEffect(() => {
    if (props.activeConversationId && props.activeConversationId !== lastActive.current) {
      setCreating(false);
      setTarget(props.activeConversationId);
    }
    lastActive.current = props.activeConversationId;
  }, [props.activeConversationId]);
  const [target, setTarget] = useState<string | null>(null);
  /** 异步读取失败保留原目标，允许准确重试。 */
  const [error, setError] = useState<unknown>(null);
  /** 重试只重新加载当前目标。 */
  const [retry, setRetry] = useState(0);
  /** 回调始终最新，不因父组件重绘重新执行选择。 */
  const selectRef = useRef(props.onSelect);
  selectRef.current = props.onSelect;
  /** 会话列表与工作投影按原始身份合并，保留不同运行的独立会话。 */
  const choices = new Map(props.conversations.map((conversation) => [conversation.id, { id: conversation.id, title: conversation.title, employee: null as DigitalEmployeeRecord | null }]));
  for (const item of props.items) {
    for (const run of item.runs) {
      if (!run.conversationId) continue;
      /** 真实项目员工匹配失败时仍保留工作名称，不伪造员工身份。 */
      const employee = props.employees.find((candidate) => candidate.id === run.employeeId) ?? null;
      /** 同一分工重试和返工有独立会话，用真实次数区分同名选项。 */
      const title = `${employee ? `${employee.name} · ` : ''}${item.title} · ${zh ? `第 ${run.attempt} 次运行` : `Run ${run.attempt}`}`;
      choices.set(run.conversationId, { id: run.conversationId, title, employee });
    }
  }
  /** 首次进入优先继续当前任务已选择的会话，其次使用最近会话。 */
  const initialTarget = props.activeConversationId && choices.has(props.activeConversationId) ? props.activeConversationId : (Array.from(choices.keys()).at(-1) ?? null);
  useEffect(() => {
    if (!target && initialTarget) setTarget(initialTarget);
  }, [initialTarget, target]);
  useEffect(() => {
    if (props.conversationRequest) setTarget(props.conversationRequest.conversationId);
  }, [props.conversationRequest]);
  useEffect(() => {
    setError(null);
    if (!target || !selectRef.current || props.activeConversationId === target) return;
    /** 目标切换和卸载使上一读取的错误失效。 */
    let active = true;
    void selectRef.current(target).catch((cause: unknown) => {
      if (active) setError(cause);
    });
    return () => {
      active = false;
    };
  }, [target, retry, props.activeConversationId]);
  /** 无回调时提供真实的完整会话入口，避免显示无法发送的假输入框。 */
  const inlineAvailable = Boolean(props.onSelect);
  return (
    <section className="task-conversation-pane" aria-label={zh ? '任务沟通' : 'Task conversations'}>
      {choices.size > 0 ? (
        <header className="task-conversation-selector">
          <ZeusSelect
            size="compact"
            ariaLabel={zh ? '选择沟通会话' : 'Choose a conversation'}
            value={target ?? ''}
            options={Array.from(choices.values()).map((choice) => ({ value: choice.id, label: choice.title, icon: choice.employee ? <DigitalEmployeeAvatar {...choice.employee} /> : undefined }))}
            triggerIcon={target && choices.get(target)?.employee ? <DigitalEmployeeAvatar {...choices.get(target)!.employee!} /> : undefined}
            searchable
            onChange={(id) => {
              setCreating(false);
              setTarget(id);
            }}
          />
          {props.newWorkspace ? (
            <Button variant="secondary" size="compact" onClick={() => setCreating((value) => !value)}>
              {creating ? (zh ? '返回会话' : 'Back') : zh ? '发起讨论' : 'New discussion'}
            </Button>
          ) : null}
          {target && props.onOpen && !creating ? (
            <Button variant="secondary" size="compact" onClick={() => props.onOpen?.(target)}>
              {zh ? '完整会话' : 'Full conversation'}
            </Button>
          ) : null}
        </header>
      ) : null}
      {props.error ? (
        <div className="task-conversation-feedback" role="alert">
          <VisibleApplicationError error={props.error} language={zh ? 'zh-CN' : 'en'} />
          {props.onReload ? (
            <Button variant="secondary" size="compact" onClick={props.onReload}>
              {zh ? '重新读取列表' : 'Reload conversations'}
            </Button>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <div className="task-conversation-feedback" role="alert">
          <VisibleApplicationError error={error} language={zh ? 'zh-CN' : 'en'} />
          <Button variant="secondary" size="compact" onClick={() => setRetry((value) => value + 1)}>
            {zh ? '重新打开' : 'Try again'}
          </Button>
        </div>
      ) : props.newWorkspace && (creating || (!props.loading && choices.size === 0)) ? (
        <div className="task-conversation-new session-codex-parity-v1">
          <div>
            <strong>{zh ? '在任务中讨论' : 'Discuss this task'}</strong>
            <p>{zh ? '输入 @ 选择一位或多位数字员工。任务说明随讨论提供；需要执行开发流程时，在工作页安排分工。' : 'Use @ to select one or more digital employees. Task requirements accompany the discussion.'}</p>
          </div>
          {props.newWorkspace}
        </div>
      ) : target && inlineAvailable ? (
        props.activeConversationId === target && props.workspace ? (
          <div className="task-conversation-session session-codex-parity-v1">{props.workspace}</div>
        ) : (
          <p className="task-conversation-feedback" role="status">
            {zh ? '正在读取会话…' : 'Loading conversation…'}
          </p>
        )
      ) : choices.size === 0 ? (
        <div className="task-conversation-empty">
          <strong>{props.loading ? (zh ? '正在读取任务会话…' : 'Loading conversations…') : zh ? '从这里开始协作' : 'Start collaborating here'}</strong>
          {!props.loading ? (
            <p>
              {zh ? '选择上方执行人指派工作，或在右上角新建会话。任务说明会随任务会话提供给员工。' : 'Assign work using the employee selector above, or start a conversation from the top right. Task requirements accompany the conversation.'}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
