import { useEffect, useMemo, useState } from 'react';
import { Button } from '../../ui/Button.js';
import { VisibleApplicationError } from '../../ui/ApplicationErrorDialog.js';
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
export function EmployeeMemoryPanel(props: {
  client: DigitalEmployeeApiClient;
  employeeId: string;
  language: 'zh-CN' | 'en-US';
  /** 记忆和历史使用同级入口，不再嵌套折叠。 */
  view: 'memory' | 'history';
}) {
  /** 员工身份保持稳定，避免普通界面刷新重载记忆。 */
  const scope = useMemo(() => ({ kind: 'employee' as const, id: props.employeeId }), [props.employeeId]);
  /** 接纳建议后刷新既有记录。 */
  const [revision, setRevision] = useState(0);
  /** 历史只从正式派发记录加载。 */
  const [runs, setRuns] = useState<TaskWorkRunRecord[]>([]);
  /** 加载失败保持可见。 */
  const [error, setError] = useState<string | null>(null);
  /** 每次显示十条，接口仍保留最近一百次派发供追溯。 */
  const [visibleRunCount, setVisibleRunCount] = useState(10);
  /** 查询期间禁用刷新，失败保留已读取的记录。 */
  const [loading, setLoading] = useState(false);
  /** 日期与页面文案使用用户选择的语言。 */
  const zh = props.language === 'zh-CN';
  useEffect(() => {
    if (props.view !== 'history') return;
    /** 切换员工或离开记录后忽略旧请求，避免跨员工显示。 */
    let active = true;
    setLoading(true);
    setError(null);
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
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [props.client, props.employeeId, revision, props.view]);
  return (
    <div className="employee-memory-section">
      {props.view === 'memory' ? (
        <>
          <MemorySettingsPane client={props.client.employeeMemory} language={props.language} projects={[]} fixedScope={scope} scopeLabel={zh ? '已保存的记忆' : 'Saved memories'} refreshRevision={revision} />
          <EmployeeMemoryProposals client={props.client} employeeId={props.employeeId} onAccepted={() => setRevision((value) => value + 1)} />
        </>
      ) : (
        <>
          <div className="employee-memory-history-heading">
            <h3>{zh ? '最近 100 次派发' : 'Last 100 dispatches'}</h3>
            <Button size="compact" variant="secondary" busy={loading} onClick={() => setRevision((value) => value + 1)}>
              {zh ? '刷新记录' : 'Refresh history'}
            </Button>
          </div>
          {error ? (
            <p role="alert">
              <VisibleApplicationError error={error} language={zh ? 'zh-CN' : 'en'} />
            </p>
          ) : loading ? (
            <p role="status">{zh ? '正在读取记录…' : 'Loading history…'}</p>
          ) : !runs.length ? (
            <p className="employee-settings-help">{zh ? '暂无派发记录。' : 'No dispatch history yet.'}</p>
          ) : null}
          {runs.slice(0, visibleRunCount).map((run) => {
            /** 历史快照只展示保存过的事实，不推断模型是否遵循。 */
            const selection = Array.isArray(run.entrypointSnapshot.memorySelection) ? run.entrypointSnapshot.memorySelection : null;
            /** 较早记录仅保留实际加入输入的记忆摘要。 */
            const snapshots = Array.isArray(run.entrypointSnapshot.memorySnapshot) ? run.entrypointSnapshot.memorySnapshot : [];
            /** 计数来自正式派发快照，不由当前记忆列表推算。 */
            const selectedCount = selection ? selection.filter((item) => item.selected).length : snapshots.length;
            return (
              <details className="employee-memory-use" key={run.id}>
                <summary>
                  <time dateTime={run.createdAt}>{new Date(run.createdAt).toLocaleString(props.language)}</time>
                  <span>{zh ? `加入 ${selectedCount} 条记忆` : `${selectedCount} memories included`}</span>
                </summary>
                {selection ? (
                  selection.length ? (
                    selection.map((item: { record: { id: string; memoryKey: string; content: string; source: { reference: string }; reviewAfter: string }; reason: string; selected: boolean }) => (
                      <article key={item.record.id}>
                        <strong>
                          {item.record.memoryKey} · {reasonLabels[item.reason] ?? item.reason}
                        </strong>
                        <p>{item.record.content}</p>
                        <small>
                          {zh ? '来源' : 'Source'}：{item.record.source.reference} · {zh ? '复核' : 'Review'}：{new Date(item.record.reviewAfter).toLocaleDateString(props.language)}
                        </small>
                      </article>
                    ))
                  ) : (
                    <p className="employee-settings-help">{zh ? '本次没有可选的员工记忆。' : 'No employee memories were available for this dispatch.'}</p>
                  )
                ) : (
                  <p className="employee-settings-help">
                    {zh ? `本次加入 ${snapshots.length} 条记忆。历史记录仅保存摘要，未记录未选原因。` : `${snapshots.length} memories included. This older record kept summaries without exclusion reasons.`}
                  </p>
                )}
                <dl className="employee-memory-run-info">
                  <dt>{zh ? '任务' : 'Task'}</dt>
                  <dd>{run.taskId}</dd>
                  <dt>{zh ? '项目' : 'Project'}</dt>
                  <dd>{run.projectId}</dd>
                  <dt>{zh ? '运行' : 'Run'}</dt>
                  <dd>{run.id}</dd>
                </dl>
              </details>
            );
          })}
          {runs.length > visibleRunCount ? (
            <Button size="compact" variant="secondary" onClick={() => setVisibleRunCount((value) => value + 10)}>
              {zh ? '显示更多记录' : 'Show more history'}
            </Button>
          ) : null}
        </>
      )}
    </div>
  );
}
