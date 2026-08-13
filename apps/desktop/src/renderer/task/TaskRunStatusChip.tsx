import { CircleNotchIcon as CircleNotch } from '@phosphor-icons/react/dist/csr/CircleNotch';
import type { MouseEventHandler } from 'react';
import type { TaskAgentRunStatus } from '../apiClient.js';

export type TaskSemanticTone = 'neutral' | 'blue' | 'violet' | 'green' | 'amber' | 'orange' | 'red';

export const taskAgentRunStatusLabels: Record<'zh-CN' | 'en-US', Record<TaskAgentRunStatus, string>> = {
  'zh-CN': {
    not_started: '未启动',
    connecting: '正在连接',
    reconnecting: '正在重连',
    running: '运行中',
    waiting_user: '等待用户回复',
    waiting_approval: '等待授权',
    paused: '已暂停',
    idle: '等待新指令',
    failed: '运行失败',
    legacy_readonly: '旧会话只读',
  },
  'en-US': {
    not_started: 'Not started',
    connecting: 'Connecting',
    reconnecting: 'Reconnecting',
    running: 'Running',
    waiting_user: 'Waiting for user',
    waiting_approval: 'Waiting for approval',
    paused: 'Paused',
    idle: 'Waiting for instructions',
    failed: 'Run failed',
    legacy_readonly: 'Legacy read-only',
  },
};

export const animatedTaskRunStatuses = new Set<TaskAgentRunStatus>(['connecting', 'reconnecting', 'running', 'waiting_user', 'waiting_approval']);

export function taskRunStatusTone(status: TaskAgentRunStatus): TaskSemanticTone {
  if (status === 'connecting' || status === 'reconnecting' || status === 'running') return 'blue';
  if (status === 'waiting_user' || status === 'waiting_approval' || status === 'paused') return 'amber';
  if (status === 'failed') return 'red';
  if (status === 'idle') return 'green';
  return 'neutral';
}

export function TaskRunStatusChip(props: { status: TaskAgentRunStatus; label: string; className?: string; ariaLabel?: string; onClick?: MouseEventHandler<HTMLButtonElement> }) {
  const className = ['task-status-chip', 'task-run-status-chip', `task-status-tone-${taskRunStatusTone(props.status)}`, props.onClick ? 'task-run-status-action' : '', props.className].filter(Boolean).join(' ');
  const content = (
    <>
      {animatedTaskRunStatuses.has(props.status) ? <CircleNotch className="session-conversation-state-spinner task-run-status-spinner" aria-hidden="true" /> : <span className="task-run-status-mark" aria-hidden="true" />}
      <strong>{props.label}</strong>
    </>
  );
  if (props.onClick) {
    return (
      <button type="button" className={className} aria-label={props.ariaLabel ?? props.label} onClick={props.onClick}>
        {content}
      </button>
    );
  }
  return (
    <span className={className} aria-label={props.ariaLabel ?? props.label}>
      {content}
    </span>
  );
}
