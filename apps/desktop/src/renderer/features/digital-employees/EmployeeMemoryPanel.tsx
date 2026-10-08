import { useEffect, useMemo, useState } from 'react';
import { MemorySettingsPane } from '../memory/MemorySettingsPane.js';
import { EmployeeMemoryProposals } from './EmployeeMemoryProposals.js';
import type { DigitalEmployeeApiClient } from './digitalEmployeeApiClient.js';
import type { TaskWorkRunRecord } from './digitalEmployeeContracts.js';

/** 选择原因只描述输入事实，不推断模型是否遵循。 */
const reasonLabels: Record<string, string> = {
  selected: '已加入输入',
  reading_disabled: '读取已关闭',
  unconfirmed: '未经确认',
  already_in_prompt: '提示词已包含',
  not_relevant: '与本次目标无关',
  input_budget: '超过输入预算',
  superseded: '已被修正',
  tombstoned: '已停用',
  review_due: '待复核',
  scope_shadowed: '使用项目内记录',
  head_conflict: '存在冲突',
  confidence_below_threshold: '置信度不足',
};

/** 员工记忆复用治理页面、建议命令与真实运行快照。 */
export function EmployeeMemoryPanel(props: { client: DigitalEmployeeApiClient; employeeId: string; language: 'zh-CN' | 'en-US' }) {
  /** 员工身份保持稳定，避免普通界面刷新重载记忆。 */
  const scope = useMemo(() => ({ kind: 'employee' as const, id: props.employeeId }), [props.employeeId]);
  /** 接纳建议后刷新既有记录。 */
  const [revision, setRevision] = useState(0);
  /** 历史只从正式派发记录加载。 */
  const [runs, setRuns] = useState<TaskWorkRunRecord[]>([]);
  /** 加载失败保持可见。 */
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void props.client
      .loadEmployeeMemoryUses(props.employeeId)
      .then((next) => {
        if (active) {
          setRuns(next);
          setError(null);
        }
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      active = false;
    };
  }, [props.client, props.employeeId, revision]);
  return (
    <details className="digital-employee-disclosure">
      <summary>管理员工记忆</summary>
      <p>只保存可复用的工作方法、岗位知识与纠错经验、岗位相关偏好。不要重复提示词、项目记忆或 Skill；任务总结不会自动保存为个人经验。</p>
      <MemorySettingsPane client={props.client.employeeMemory} language={props.language} projects={[]} fixedScope={scope} scopeLabel="员工记忆" refreshRevision={revision} />
      <EmployeeMemoryProposals client={props.client} employeeId={props.employeeId} onAccepted={() => setRevision((value) => value + 1)} />
      <details>
        <summary>使用记录（最近 100 次派发）</summary>
        <button type="button" onClick={() => setRevision((value) => value + 1)}>
          刷新
        </button>
        {error ? <p role="alert">{error}</p> : !runs.length ? <p>暂无派发记录。</p> : null}
        {runs.map((run) => (
          <details key={run.id}>
            <summary>
              {run.createdAt} · {run.taskId} · {run.projectId}
            </summary>
            {Array.isArray(run.entrypointSnapshot.memorySelection) ? (
              run.entrypointSnapshot.memorySelection.map((item: { record: { id: string; memoryKey: string; content: string; source: { reference: string }; reviewAfter: string }; reason: string; selected: boolean }) => (
                <article key={item.record.id}>
                  <strong>
                    {item.record.memoryKey} · {reasonLabels[item.reason] ?? item.reason}
                  </strong>
                  <p>{item.record.content}</p>
                  <small>
                    来源：{item.record.source.reference} · 复核：{item.record.reviewAfter}
                  </small>
                </article>
              ))
            ) : (
              <p>历史运行未记录未选原因；已加入输入的记忆：{JSON.stringify(run.entrypointSnapshot.memorySnapshot ?? [])}</p>
            )}
          </details>
        ))}
      </details>
    </details>
  );
}
