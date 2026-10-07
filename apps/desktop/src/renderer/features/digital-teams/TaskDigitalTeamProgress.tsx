import { useEffect, useState } from 'react';
import type { TaskRecord } from '../../apiClient.js';
import type { ZeusRealtimeConnectionState, ZeusRealtimeEvent } from '../../transport/dashboardClientContracts.js';
import { Button } from '../../ui/Button.js';
import { VisibleApplicationError } from '../../ui/ApplicationErrorDialog.js';
import type { DigitalTeamApiClient, DigitalTeamRunProjection } from './digitalTeamApiClient.js';
import { digitalTeamRunReadOnlyDescription, digitalTeamRunStatusLabel, getDigitalTeamRunBlocker } from './digitalTeamRunPresentation.js';
import './digitalTeams.css';

/** 团队状态沿用真实事件订阅，恢复连接后重新读取权威投影。 */
export type DigitalTeamProgressSubscription = (onEvent: (event: ZeusRealtimeEvent) => void, onConnectionState: (state: ZeusRealtimeConnectionState) => void) => (() => void) | void;

/** 任务详情与当前会话共用同一个只读进展入口。 */
export interface TaskDigitalTeamProgressProps {
  /** 当前真实任务，不按标题猜测流程身份。 */
  task: Pick<TaskRecord, 'id' | 'projectId'>;
  /** 独立会话只显示实际绑定它的团队；任务详情省略此项查看最新运行。 */
  conversationId?: string;
  /** 状态提示与操作文字使用当前界面语言。 */
  language: 'zh-CN' | 'en-US';
  /** 只接收读取端口，组件不能启动、批准或返工。 */
  client: Pick<DigitalTeamApiClient, 'loadDigitalTeamRuns' | 'loadDigitalTeamRun'>;
  /** 使用已有事件订阅能力，没有事件时仍可定时对账。 */
  subscribe?: DigitalTeamProgressSubscription;
  /** 打开准确运行记录，由原页面处理明确的后续操作。 */
  onOpenRun(runId: string): void;
}

/** 读取状态绑定任务身份，切换任务时不短暂显示另一任务的错误。 */
interface TeamProgressState {
  /** 项目、任务与会话共同限定读取身份。 */
  identity: string;
  /** 最近一次成功读取的准确运行和当前尝试。 */
  projection: DigitalTeamRunProjection | null;
  /** 断线只标记读取暂不可用，保留最近已知进展。 */
  stale: boolean;
}

/** 当前任务只显示紧凑状态，受阻详情与准确运行仍可主动打开。 */
export function TaskDigitalTeamProgress(props: TaskDigitalTeamProgressProps) {
  /** 不同任务的状态不得相互复用。 */
  const identity = JSON.stringify([props.task.projectId, props.task.id, props.conversationId ?? null]);
  /** 当前语言仅影响展示，不改变已保存的诊断原文。 */
  const zh = props.language === 'zh-CN';
  /** 已读取投影保留至下一次实际校准，失败不会弹出阻断窗口。 */
  const [state, setState] = useState<TeamProgressState>({ identity, projection: null, stale: false });
  /** 明确重读操作只重新获取状态，不创建或恢复团队工作。 */
  const [reloadRevision, setReloadRevision] = useState(0);

  useEffect(() => {
    /** 组件卸载或任务切换后忽略旧请求和订阅回调。 */
    let active = true;
    /** 同一组件只允许一次状态读取，重叠事件在完成后再校准一次。 */
    let reading = false;
    /** 请求期间真实事件发生时保留一次补读。 */
    let readAgain = false;
    /** 未终结运行和暂时断线继续对账，空任务不反复读取。 */
    let shouldPoll = true;
    /** 事件既可按任务过滤，也可按已经读取的准确运行过滤。 */
    let currentRunId: string | null = null;

    /** 从真实列表选最新运行，再读取其当前有效尝试与冻结图。 */
    const readProgress = async (): Promise<void> => {
      if (!active) return;
      if (reading) {
        readAgain = true;
        return;
      }
      reading = true;
      try {
        /** 接口返回的任务身份必须与当前页面一致。 */
        const runs = (await props.client.loadDigitalTeamRuns(props.task.projectId, props.task.id, props.conversationId)).filter((run) => run.taskId === props.task.id && run.projectId === props.task.projectId);
        /** 创建时间与稳定身份决定最新运行，避免依赖响应数组偶然顺序。 */
        const latest = runs.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))[0];
        /** 当前尝试由服务端给出，不用旧失败消息推断后继是否运行。 */
        const projection = latest ? await props.client.loadDigitalTeamRun(latest.id) : null;
        if (!active) return;
        if (projection && (projection.run.taskId !== props.task.id || projection.run.projectId !== props.task.projectId)) throw new Error('团队运行返回了不匹配的任务身份。');
        if (projection && props.conversationId && projection.run.mainConversationId !== props.conversationId && !projection.nodeAttempts.some((attempt) => attempt.conversationId === props.conversationId))
          throw new Error('团队运行未绑定当前会话。');
        currentRunId = projection?.run.id ?? null;
        shouldPoll = Boolean(projection && !['completed', 'failed', 'cancelled'].includes(projection.run.status));
        setState({ identity, projection, stale: false });
      } catch {
        if (!active) return;
        shouldPoll = true;
        setState((previous) => ({ identity, projection: previous.identity === identity ? previous.projection : null, stale: true }));
      } finally {
        reading = false;
        if (active && readAgain) {
          readAgain = false;
          void readProgress();
        }
      }
    };
    void readProgress();
    /** 实际连接恢复后补读，漏掉的事件不能让页面永久停在旧阶段。 */
    const dispose = props.subscribe?.(
      (event) => {
        if (event.type.startsWith('digital_team.') && (event.payload.taskId === props.task.id || event.payload.runId === currentRunId)) void readProgress();
      },
      (connectionState) => {
        if (connectionState === 'connected') void readProgress();
      },
    );
    /** 活动运行定期核对，正常读取不会反复显示加载状态。 */
    const timer = window.setInterval(() => {
      if (shouldPoll) void readProgress();
    }, 10_000);
    return () => {
      active = false;
      window.clearInterval(timer);
      if (typeof dispose === 'function') dispose();
    };
  }, [identity, props.client, props.subscribe, props.task.id, props.task.projectId, props.conversationId, reloadRevision]);

  /** 只展示当前任务的事实；初始化时不插入空进度条。 */
  const current = state.identity === identity ? state : null;
  if (!current?.projection && !current?.stale) return null;
  /** 精确受阻节点与只读模式都来自本次运行冻结的内容。 */
  const blocker = current.projection ? getDigitalTeamRunBlocker(current.projection, zh) : null;
  /** 只读分析流程不会被称为已经完成代码开发。 */
  const readOnlyDescription = current.projection ? digitalTeamRunReadOnlyDescription(current.projection.run, zh) : null;
  if (blocker && current.projection)
    return (
      <section className="task-digital-team-progress" aria-label={zh ? '团队进展' : 'Team progress'} role="status">
        <VisibleApplicationError
          error={readOnlyDescription ? `${readOnlyDescription}\n${blocker.reason}` : blocker.reason}
          summary={`${blocker.nodeName} · ${blocker.summary}${current.stale ? (zh ? '（状态待更新）' : ' (status pending refresh)') : ''}`}
          title={zh ? '团队需要处理' : 'Team needs attention'}
          language={zh ? 'zh-CN' : 'en'}
          action={{ label: zh ? '查看分工' : 'View assignment', onClick: () => props.onOpenRun(current.projection!.run.id) }}
        />
      </section>
    );
  return (
    <section className="task-digital-team-progress" aria-label={zh ? '团队进展' : 'Team progress'} role="status">
      <div>
        <strong>{current.projection ? digitalTeamRunStatusLabel(current.projection.run, zh) : zh ? '团队状态暂时无法读取' : 'Team status is temporarily unavailable'}</strong>
        {readOnlyDescription ? <span>{readOnlyDescription}</span> : null}
        {current.stale && current.projection ? <span>{zh ? '连接恢复后会更新进展。' : 'Progress will update after reconnecting.'}</span> : null}
      </div>
      {current.projection ? (
        <Button size="compact" onClick={() => props.onOpenRun(current.projection!.run.id)}>
          {zh ? '查看流程' : 'View workflow'}
        </Button>
      ) : (
        <Button size="compact" onClick={() => setReloadRevision((revision) => revision + 1)}>
          {zh ? '重新读取' : 'Reload'}
        </Button>
      )}
    </section>
  );
}
