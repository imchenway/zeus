import { TaskPushLayoutPreview } from '../../task/TaskModelPushModal.js';
import type { TaskWorkPreview } from './digitalEmployeeContracts.js';

/** 展示服务端解析结果，界面不重新计算配置或记忆。 */
export function EmployeeExecutionPreview(props: { preview: TaskWorkPreview; language: 'zh-CN' | 'en-US' }) {
  /** 来源来自本次服务端预检。 */
  const sources = (props.preview.entrypoint?.configurationSources ?? {}) as Record<string, string>;
  /** 预览使用会话相同的权限名称，避免展示内部枚举。 */
  const permissionLabels: Record<string, string> = { 'read-only': '只读', auto: '请求批准', 'auto-review': '替我批准', 'full-access': '完全访问' };
  /** 最终值与来源并排，便于核对节点覆盖。 */
  const values: Array<[string, string, unknown]> = [
    ['modelOverride', '模型', props.preview.model?.displayName ?? props.preview.model?.id],
    ['contextCapacityTokens', '上下文容量', props.preview.model?.contextCapacityTokens ?? '模型默认'],
    ['reasoningEffort', '推理级别', props.preview.model?.reasoningEffort],
    ['serviceTier', '速度', props.preview.model?.serviceTier ?? '标准'],
    ['workMode', '工作模式', props.preview.entrypoint?.workMode === 'plan' ? '计划' : '默认'],
    ['permissionMode', '权限模式', permissionLabels[String(props.preview.authority.permissionMode)]],
    ['skillIds', 'Skill', props.preview.skills.map((skill) => skill.name).join('、') || '不使用 Skill'],
  ];
  return (
    <div className="employee-execution-preview">
      <table>
        <thead>
          <tr>
            <th scope="col">配置</th>
            <th scope="col">最终值</th>
            <th scope="col">来源</th>
          </tr>
        </thead>
        <tbody>
          {values.map(([key, label, value]) => (
            <tr key={key}>
              <th scope="row">{label}</th>
              <td>{String(value ?? '默认')}</td>
              <td>{sources[key] ?? '项目或模型默认'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {props.preview.blockers.map((blocker) => (
        <p role="alert" key={blocker.code}>
          {blocker.message}
        </p>
      ))}
      <details open>
        <summary>拟采用记忆</summary>
        {Array.isArray(props.preview.entrypoint?.memorySelection) && props.preview.entrypoint.memorySelection.some((item: { selected: boolean }) => item.selected) ? (
          props.preview.entrypoint.memorySelection
            .filter((item: { selected: boolean }) => item.selected)
            .map((item: { record: { id: string; memoryKey: string; content: string; source: { reference: string }; reviewAfter: string } }) => (
              <article key={item.record.id}>
                <strong>{item.record.memoryKey} · 拟采用</strong>
                <p>{item.record.content}</p>
                <small>
                  来源：{item.record.source.reference} · 复核：{new Date(item.record.reviewAfter).toLocaleDateString(props.language)}
                </small>
              </article>
            ))
        ) : (
          <p>无拟采用的员工记忆。</p>
        )}
      </details>
      {props.preview.promptPreview ? (
        <details open>
          <summary>完整输入</summary>
          <TaskPushLayoutPreview layout={props.preview.promptPreview} language={props.language} previewAttachments={[]} />
        </details>
      ) : null}
    </div>
  );
}
