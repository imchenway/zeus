import { useEffect, useState } from 'react';
import type { DigitalTeamEmployeeNode } from '@zeus/shared';
import type { DashboardClient } from '../../dashboardClient.js';
import { FormDialog } from '../../ui/FormDialog.js';
import { ZeusSelect } from '../../ZeusSelect.js';
import type { TaskRecord } from '../tasks/taskContracts.js';
import type { TaskWorkPreview } from '../digital-employees/digitalEmployeeContracts.js';
import { EmployeeExecutionPreview } from '../digital-employees/EmployeeExecutionPreview.js';

/** 节点执行预览独立打开，只有真实任务才能计算完整输入。 */
export function TeamNodeExecutionPreview(props: { client: DashboardClient; projectId: string; task?: TaskRecord; node: DigitalTeamEmployeeNode; language: 'zh-CN' | 'en-US' }) {
  /** 关闭时不占用画布面积。 */
  const [open, setOpen] = useState(false);
  /** 全局流程通过已有任务查看实际配置。 */
  const [tasks, setTasks] = useState<TaskRecord[]>(props.task ? [props.task] : []);
  /** 预览不创建或启动任务。 */
  const [taskId, setTaskId] = useState(props.task?.id ?? '');
  /** 服务端预检结果。 */
  const [preview, setPreview] = useState<TaskWorkPreview | null>(null);
  /** 异步失败保留在弹窗。 */
  const [error, setError] = useState<string | null>(null);
  /** 请求等待状态与派发无关。 */
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open || props.task) return;
    let active = true;
    void props.client
      .loadTasks({ projectId: props.projectId })
      .then((next) => {
        if (active) setTasks(next);
      })
      .catch((cause: unknown) => {
        if (active) setError(String(cause));
      });
    return () => {
      active = false;
    };
  }, [open, props.client, props.projectId, props.task]);
  useEffect(() => {
    if (!open || !taskId) return;
    let active = true;
    setBusy(true);
    setPreview(null);
    setError(null);
    void props.client
      .previewEmployeeWorkflowNode(taskId, { employeeId: props.node.data.employeeId, settings: props.node.data.settings ?? {}, instructions: props.node.data.instructions, executionMode: props.node.data.executionMode })
      .then((next) => {
        if (active) setPreview(next);
      })
      .catch((cause: unknown) => {
        if (active) setError(String(cause));
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [open, taskId, props.client, props.node]);
  return (
    <>
      <button type="button" disabled={!props.node.data.employeeId} onClick={() => setOpen(true)}>
        执行预览
      </button>
      {open ? (
        <FormDialog
          title="执行预览"
          description="按所选任务核对当前节点；正式接纳时会再次校验并固定配置。"
          zh={props.language === 'zh-CN'}
          busy={false}
          submitLabel="关闭"
          onClose={() => setOpen(false)}
          onSubmit={(event) => {
            event.preventDefault();
            setOpen(false);
          }}
        >
          <ZeusSelect ariaLabel="预览任务" size="regular" value={taskId} options={[{ value: '', label: '选择已有任务' }, ...tasks.map((task) => ({ value: task.id, label: task.title }))]} onChange={setTaskId} />
          {busy ? <p role="status">正在解析执行配置…</p> : null}
          {error ? <p role="alert">{error}</p> : null}
          {preview ? <EmployeeExecutionPreview preview={preview} language={props.language} /> : null}
        </FormDialog>
      ) : null}
    </>
  );
}
