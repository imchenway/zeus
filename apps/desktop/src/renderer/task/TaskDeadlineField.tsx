import { useId, useState } from 'react';
import { BellIcon as Bell } from '@phosphor-icons/react/dist/csr/Bell';
import { BellSlashIcon as BellSlash } from '@phosphor-icons/react/dist/csr/BellSlash';
import { formatTaskDeadline, normalizeTaskDeadline, type TaskDeadline } from '@zeus/shared';
import type { TaskRecord } from '../apiClient.js';
import type { TaskEditResult } from './TaskDetailPaneContent.js';
import { Button } from '../ui/Button.js';
import { FormDialog } from '../ui/FormDialog.js';
import './task-deadline.css';

/** 创建和详情共用单行截止时间，日期和提醒分别在现有表单弹窗中配置。 */
export function TaskDeadlineField(props: {
  /** 当前截止配置。 */
  value: TaskDeadline | null;
  /** 保存完整配置；详情同时校验打开配置页时的任务修订。 */
  onChange(value: TaskDeadline | null, expectedUpdatedAt?: string): void | Promise<void>;
  /** 创建草稿不需要修改冲突修订。 */
  expectedUpdatedAt?: string;
  /** 外部操作期间禁止修改。 */
  disabled?: boolean;
  /** 当前界面语言。 */
  language: string;
}) {
  /** 标签与单选组使用当前字段的独立身份。 */
  const id = useId();
  /** 打开时固定原始修订，刷新不会覆盖正在编辑的草稿。 */
  const [draft, setDraft] = useState<{ page: 'deadline' | 'reminder'; value: TaskDeadline | null; expectedUpdatedAt?: string } | null>(null);
  /** 保存期间保留配置页并禁止重复提交。 */
  const [saving, setSaving] = useState(false);
  /** 错误保留草稿，允许用户重试或取消。 */
  const [error, setError] = useState('');
  /** 仅文案随语言切换，截止时区不变。 */
  const zh = props.language === 'zh-CN';
  /** 常态只展示日期与可选时间，完整时区放在提示和配置页。 */
  const text = props.value ? `${props.value.date}${props.value.time ? ` ${props.value.time}` : ''}` : zh ? '未设置' : 'Not set';
  /** 图标仍保留明确的可访问名称和关闭状态。 */
  const reminderLabel = !props.value ? (zh ? '请先设置截止时间' : 'Set a deadline first') : props.value.reminder === 'off' ? (zh ? '提醒设置：已关闭' : 'Reminder settings: off') : zh ? '提醒设置' : 'Reminder settings';
  /** 只在用户进入配置页时创建草稿。 */
  function open(page: 'deadline' | 'reminder'): void {
    setError('');
    setDraft({ page, value: props.value, expectedUpdatedAt: props.expectedUpdatedAt });
  }
  /** 日期、时区和提醒方式沿用同一次原子保存。 */
  async function save(): Promise<void> {
    if (!draft || saving || props.disabled) return;
    setSaving(true);
    setError('');
    try {
      await props.onChange(normalizeTaskDeadline(draft.value), draft.expectedUpdatedAt);
      setDraft(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : zh ? '保存失败，请重试。' : 'Could not save. Try again.');
    } finally {
      setSaving(false);
    }
  }
  return (
    <>
      <div className="task-deadline-field">
        <Button className="task-deadline-value" size="compact" disabled={props.disabled} title={formatTaskDeadline(props.value)} aria-label={`${zh ? '编辑截止时间' : 'Edit deadline'}：${text}`} onClick={() => open('deadline')}>
          {text}
        </Button>
        <Button className="task-deadline-reminder" size="compact" disabled={props.disabled || !props.value} title={reminderLabel} aria-label={reminderLabel} onClick={() => open('reminder')}>
          {props.value?.reminder === 'off' ? <BellSlash aria-hidden="true" /> : <Bell aria-hidden="true" />}
        </Button>
      </div>
      {draft ? (
        <FormDialog
          className="task-deadline-dialog"
          title={draft.page === 'reminder' ? (zh ? '提醒设置' : 'Reminder settings') : zh ? '截止时间' : 'Deadline'}
          description={draft.page === 'reminder' ? formatTaskDeadline(draft.value) : undefined}
          zh={zh}
          busy={saving || Boolean(props.disabled)}
          submitLabel={zh ? '保存' : 'Save'}
          onClose={() => setDraft(null)}
          onSubmit={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void save();
          }}
        >
          {draft.page === 'deadline' ? (
            <>
              <div className="task-deadline-date-fields">
                <label htmlFor={`${id}-date`}>
                  {zh ? '日期' : 'Date'}
                  <input
                    id={`${id}-date`}
                    type="date"
                    min="0001-01-01"
                    max="9998-12-31"
                    value={draft.value?.date ?? ''}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        value: event.currentTarget.value
                          ? { date: event.currentTarget.value, time: draft.value?.time ?? null, timeZone: draft.value?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone, reminder: draft.value?.reminder ?? 'advance' }
                          : null,
                      })
                    }
                  />
                </label>
                <label htmlFor={`${id}-time`}>
                  {zh ? '时间（可选）' : 'Time (optional)'}
                  <input
                    id={`${id}-time`}
                    type="time"
                    step="60"
                    disabled={!draft.value}
                    value={draft.value?.time ?? ''}
                    onChange={(event) => draft.value && setDraft({ ...draft, value: { ...draft.value, time: event.currentTarget.value || null } })}
                  />
                </label>
              </div>
              {draft.value ? (
                <small>
                  {draft.value.timeZone}
                  {!draft.value.time ? (zh ? ' · 当天结束后逾期' : ' · Overdue after this day ends') : ''}
                </small>
              ) : null}
              <Button className="task-deadline-clear" size="compact" disabled={!draft.value} onClick={() => setDraft({ ...draft, value: null })}>
                {zh ? '清除截止时间' : 'Clear deadline'}
              </Button>
            </>
          ) : (
            <div className="task-deadline-reminder-options">
              {(['advance', 'at_deadline', 'off'] as const).map((reminder) => (
                <label key={reminder}>
                  <input type="radio" name={`${id}-reminder`} value={reminder} checked={draft.value?.reminder === reminder} onChange={() => draft.value && setDraft({ ...draft, value: { ...draft.value, reminder } })} />
                  {reminder === 'advance'
                    ? draft.value?.time
                      ? zh
                        ? '提前 30 分钟'
                        : '30 minutes before'
                      : zh
                        ? '当天 09:00'
                        : 'At 09:00 that day'
                    : reminder === 'at_deadline'
                      ? zh
                        ? '截止时提醒'
                        : 'At deadline'
                      : zh
                        ? '关闭提醒'
                        : 'Off'}
                </label>
              ))}
            </div>
          )}
          {error ? (
            <p className="task-deadline-error" role="alert">
              {error}
            </p>
          ) : null}
        </FormDialog>
      ) : null}
    </>
  );
}

/** 详情沿用任务内容命令，冲突时保持配置页和草稿。 */
export function TaskDeadlineEditor(props: {
  /** 当前任务详情。 */
  task: TaskRecord;
  /** 当前界面语言。 */
  language: string;
  /** 外部操作忙碌状态。 */
  disabled?: boolean;
  /** 原有修改冲突回执。 */
  onSave(deadline: TaskDeadline | null, expectedUpdatedAt: string): Promise<TaskEditResult | undefined>;
}) {
  return (
    <TaskDeadlineField
      value={props.task.deadline ?? null}
      language={props.language}
      disabled={props.disabled}
      expectedUpdatedAt={props.task.updatedAt ?? ''}
      onChange={async (deadline, expectedUpdatedAt) => {
        /** 必须成功接纳本次修订才关闭配置页。 */
        const result = await props.onSave(deadline, expectedUpdatedAt ?? '');
        if (result?.kind === 'conflict') throw new Error(props.language === 'zh-CN' ? '任务已被修改。请取消编辑，读取最新内容后重试。' : 'The task changed. Cancel editing and reopen the latest task.');
        if (result?.kind !== 'updated') throw new Error(props.language === 'zh-CN' ? '保存失败，请重试。' : 'Could not save. Try again.');
      }}
    />
  );
}
