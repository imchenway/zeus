import { useState } from 'react';
import type { WorkflowValue } from '@zeus/shared';
import { Button } from '../../ui/Button.js';

/** 回应表单只提交当前尝试，服务端再次核对权限、期限及绑定摘要。 */
export function WorkflowWaitResponse(props: { toolApproval?: boolean; disabled: boolean; onRespond(response: WorkflowValue, approved: boolean): Promise<void> }) {
  /** 原始结构化回应，错误输入不会被转换成另一份有效值。 */
  const [response, setResponse] = useState('{}');
  /** 提交中阻止重复操作。 */
  const [busy, setBusy] = useState(false);
  /** 业务拒绝就近展示并保留用户输入。 */
  const [error, setError] = useState<string | null>(null);
  /** 提交使用父级准确运行与尝试快照。 */
  const submit = async (approved: boolean): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await props.onRespond(props.toolApproval ? { approved } : (JSON.parse(response) as WorkflowValue), approved);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="digital-team-workflow-fields" aria-label="回应等待">
      {!props.toolApproval ? (
        <label>
          <span>结构化回应（JSON）</span>
          <textarea rows={5} value={response} spellCheck={false} onChange={(event) => setResponse(event.currentTarget.value)} />
        </label>
      ) : null}
      <div className="digital-team-inspector-actions">
        <Button variant="primary" disabled={props.disabled || busy} onClick={() => void submit(true)}>
          {busy ? '提交中…' : props.toolApproval ? '批准工具调用' : '提交回应'}
        </Button>
        {props.toolApproval ? (
          <Button disabled={props.disabled || busy} onClick={() => void submit(false)}>
            拒绝
          </Button>
        ) : null}
      </div>
      {error ? (
        <p className="digital-team-message is-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
