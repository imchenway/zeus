import { useState } from 'react';
import type { DigitalTeamNode, DigitalTeamWorkflowDefinition, DigitalTeamWorkflowTemplateRecord, WorkflowBinding, WorkflowDataContract, WorkflowToolReference, WorkflowValue } from '@zeus/shared';
import { ZeusSelect } from '../../ZeusSelect.js';
import { Button } from '../../ui/Button.js';

/** JSON 配置保留输入中的错误，并让正式校验阻止使用旧的有效值保存。 */
export function WorkflowJsonField(props: { label: string; value: unknown; onChange(value: unknown): void; onInvalid?(): void }) {
  const [text, setText] = useState(() => JSON.stringify(props.value === undefined ? null : props.value, null, 2));
  const [error, setError] = useState<string | null>(null);
  return (
    <label>
      <span>{props.label}</span>
      <textarea
        rows={4}
        spellCheck={false}
        value={text}
        aria-invalid={Boolean(error)}
        onChange={(event) => {
          const next = event.currentTarget.value;
          setText(next);
          try {
            const value: unknown = JSON.parse(next);
            setError(null);
            props.onChange(value);
          } catch {
            setError('请输入有效 JSON。');
            if (props.onInvalid) props.onInvalid();
            else props.onChange(next);
          }
        }}
      />
      {error ? <span role="alert">{error}</span> : null}
    </label>
  );
}

/** 通用输入行直接展示来源，不要求用户编写可执行表达式。 */
function WorkflowInputFields(props: { node: DigitalTeamNode; definition: DigitalTeamWorkflowDefinition; onChange(node: DigitalTeamNode): void }) {
  const inputs = (props.node.data as WorkflowDataContract).inputs ?? {};
  const entries = Object.entries(inputs);
  const replace = (index: number, name: string, binding: WorkflowBinding): void => {
    if (entries.some(([key], position) => position !== index && key === name)) return;
    const next = entries.map(([key, value], position) => (position === index ? [name, binding] : [key, value]));
    props.onChange({ ...props.node, data: { ...props.node.data, inputs: Object.fromEntries(next) } } as DigitalTeamNode);
  };
  return (
    <section className="digital-team-workflow-fields" aria-label="输入绑定">
      <h3>输入</h3>
      {entries.map(([name, binding], index) => (
        <div className="digital-team-workflow-binding" key={index}>
          <label>
            <span>字段名</span>
            <input value={name} onChange={(event) => replace(index, event.currentTarget.value, binding)} />
          </label>
          <ZeusSelect
            size="regular"
            ariaLabel={`输入 ${name} 的来源`}
            value={binding.source}
            options={[
              { value: 'literal', label: '常量' },
              { value: 'task', label: '任务字段' },
              { value: 'node', label: '上游输出' },
              { value: 'artifact', label: '固定成果' },
            ]}
            onChange={(source) =>
              replace(index, name, source === 'literal' ? { source, value: '' } : source === 'task' ? { source, path: '' } : source === 'node' ? { source, nodeId: '', path: '' } : { source: 'artifact', id: '', sha256: '' })
            }
          />
          {binding.source === 'literal' ? (
            <WorkflowJsonField
              label={`常量 ${name}`}
              value={binding.value}
              onInvalid={() => replace(index, name, { ...binding, parseError: true })}
              onChange={(value) => replace(index, name, { source: 'literal', value: value as WorkflowValue, parseError: undefined })}
            />
          ) : binding.source === 'artifact' ? (
            <>
              <label>
                <span>成果身份</span>
                <input value={binding.id} onChange={(event) => replace(index, name, { ...binding, id: event.currentTarget.value })} />
              </label>
              <label>
                <span>SHA-256</span>
                <input value={binding.sha256} onChange={(event) => replace(index, name, { ...binding, sha256: event.currentTarget.value })} />
              </label>
            </>
          ) : (
            <>
              {binding.source === 'node' ? (
                <ZeusSelect
                  size="regular"
                  ariaLabel={`输入 ${name} 的上游节点`}
                  value={binding.nodeId}
                  options={props.definition.nodes.filter((node) => node.id !== props.node.id).map((node) => ({ value: node.id, label: node.data.title }))}
                  onChange={(nodeId) => replace(index, name, { ...binding, nodeId })}
                />
              ) : null}
              <label>
                <span>字段路径</span>
                <input value={binding.path} placeholder="decision" onChange={(event) => replace(index, name, { ...binding, path: event.currentTarget.value })} />
              </label>
            </>
          )}
          <Button size="compact" onClick={() => props.onChange({ ...props.node, data: { ...props.node.data, inputs: Object.fromEntries(entries.filter((_entry, position) => position !== index)) } } as DigitalTeamNode)}>
            移除输入
          </Button>
        </div>
      ))}
      <Button
        size="compact"
        onClick={() =>
          props.onChange({
            ...props.node,
            data: { ...props.node.data, inputs: { ...inputs, [Array.from({ length: 65 }, (_value, index) => `input${index + 1}`).find((name) => !Object.hasOwn(inputs, name)) ?? 'input66']: { source: 'literal', value: '' } } },
          } as DigitalTeamNode)
        }
      >
        添加输入
      </Button>
    </section>
  );
}

/** 原语配置沿用检查器布局、选择器和按钮；员工同样使用通用数据绑定。 */
export function WorkflowPrimitiveFields(props: {
  /** 当前可编辑节点。 */
  node: DigitalTeamNode;
  /** 当前依赖图。 */
  definition: DigitalTeamWorkflowDefinition;
  /** 当前保存的可调用模板。 */
  templates: DigitalTeamWorkflowTemplateRecord[];
  /** 读取当前项目会话已激活的工具。 */
  loadTools?(conversationId: string): Promise<WorkflowToolReference['tool'][]>;
  /** 更新当前节点。 */
  onChange(node: DigitalTeamNode): void;
}) {
  const node = props.node;
  const [tools, setTools] = useState<WorkflowToolReference['tool'][]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const patch = (data: Record<string, unknown>): void => props.onChange({ ...node, data: { ...node.data, ...data } } as DigitalTeamNode);
  const targets = props.definition.edges.filter((edge) => edge.source === node.id).map((edge) => ({ value: edge.target, label: props.definition.nodes.find((item) => item.id === edge.target)?.data.title ?? edge.target }));
  const load = async (conversationId: string): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      setTools(await props.loadTools!(conversationId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  };
  return (
    <>
      {node.type === 'invoke' ? (
        <>
          <ZeusSelect
            size="regular"
            ariaLabel="调用能力"
            value={node.data.capability.kind}
            options={[
              { value: 'transform', label: '数据映射' },
              { value: 'tool', label: '工具' },
              { value: 'workflow', label: '子流程' },
            ]}
            onChange={(kind) => patch({ capability: kind === 'tool' ? { kind, reference: { conversationId: '', tool: {} } } : kind === 'workflow' ? { kind, templateId: '', templateRevision: 1 } : { kind: 'transform' } })}
          />
          {node.data.capability.kind === 'workflow' ? (
            <ZeusSelect
              size="regular"
              ariaLabel="子流程模板"
              value={node.data.capability.templateId}
              options={props.templates.filter((template) => template.ready).map((template) => ({ value: template.id, label: template.name, description: `修订 ${template.revision}` }))}
              onChange={(templateId) => patch({ capability: { kind: 'workflow', templateId, templateRevision: props.templates.find((template) => template.id === templateId)!.revision } })}
            />
          ) : null}
          {node.data.capability.kind === 'tool' ? (
            <>
              <label>
                <span>授权会话</span>
                <input
                  value={node.data.capability.reference.conversationId}
                  onChange={(event) => {
                    setTools([]);
                    patch({ capability: { kind: 'tool', reference: { conversationId: event.currentTarget.value, tool: {} } } });
                  }}
                />
              </label>
              <Button
                size="compact"
                disabled={loading || !node.data.capability.reference.conversationId || !props.loadTools}
                onClick={() => {
                  if (node.data.capability.kind === 'tool') void load(node.data.capability.reference.conversationId);
                }}
              >
                {loading ? '读取中…' : '读取工具'}
              </Button>
              <ZeusSelect
                size="regular"
                ariaLabel="调用工具"
                value={String(node.data.capability.reference.tool.name ?? '')}
                options={(tools.length ? tools : node.data.capability.reference.tool.name ? [node.data.capability.reference.tool] : []).map((tool) => ({ value: String(tool.name), label: String(tool.label ?? tool.name) }))}
                onChange={(name) => {
                  if (node.data.capability.kind === 'tool') patch({ capability: { kind: 'tool', reference: { ...node.data.capability.reference, tool: tools.find((tool) => tool.name === name)! } } });
                }}
              />
              {error ? <p role="alert">{error}</p> : null}
            </>
          ) : null}
        </>
      ) : null}
      {node.type === 'await' ? (
        <>
          <ZeusSelect
            size="regular"
            ariaLabel="等待来源"
            value={node.data.mode}
            options={[
              { value: 'human', label: '人工回应' },
              { value: 'event', label: '外部事件' },
              { value: 'timer', label: '定时恢复' },
            ]}
            onChange={(mode) => patch({ mode })}
          />
          {node.data.mode !== 'timer' ? (
            <label>
              <span>回应主体（initiator 表示发起人）</span>
              <input
                value={node.data.actorIds.join(', ')}
                onChange={(event) =>
                  patch({
                    actorIds: event.currentTarget.value
                      .split(',')
                      .map((id) => id.trim())
                      .filter(Boolean),
                  })
                }
              />
            </label>
          ) : null}
          {node.data.mode === 'event' ? (
            <label>
              <span>事件关联身份</span>
              <input value={node.data.eventKey ?? ''} onChange={(event) => patch({ eventKey: event.currentTarget.value })} />
            </label>
          ) : null}
          <label>
            <span>{node.data.mode === 'timer' ? '等待时长（秒）' : '超时（秒）'}</span>
            <input type="number" min={0.001} max={31_536_000} step="any" value={node.data.timeoutMs / 1000} onChange={(event) => patch({ timeoutMs: Math.round(Number(event.currentTarget.value) * 1000) })} />
          </label>
          {node.data.mode !== 'timer' ? (
            <ZeusSelect
              size="regular"
              ariaLabel="超时处理"
              value={node.data.onTimeout}
              options={[
                { value: 'fail', label: '失败' },
                { value: 'continue', label: '输出超时结果并继续' },
              ]}
              onChange={(onTimeout) => patch({ onTimeout })}
            />
          ) : null}
        </>
      ) : null}
      {node.type === 'route' ? (
        <section className="digital-team-workflow-fields">
          <h3>分支</h3>
          {node.data.cases.map((rule, index) => {
            const update = (value: Record<string, unknown>): void => patch({ cases: node.data.cases.map((item, position) => (position === index ? { ...item, ...value } : item)) });
            return (
              <div className="digital-team-workflow-binding" key={index}>
                <label>
                  <span>输入字段</span>
                  <input value={rule.field} onChange={(event) => update({ field: event.currentTarget.value })} />
                </label>
                <ZeusSelect
                  size="regular"
                  ariaLabel={`分支 ${index + 1} 比较方式`}
                  value={rule.operator}
                  options={[
                    { value: 'eq', label: '等于' },
                    { value: 'neq', label: '不等于' },
                    { value: 'gt', label: '大于' },
                    { value: 'gte', label: '大于等于' },
                    { value: 'lt', label: '小于' },
                    { value: 'lte', label: '小于等于' },
                    { value: 'exists', label: '字段存在' },
                  ]}
                  onChange={(operator) => update({ operator })}
                />
                {rule.operator !== 'exists' ? <WorkflowJsonField label={`分支 ${index + 1} 比较值`} value={rule.value} onInvalid={() => update({ parseError: true })} onChange={(value) => update({ value, parseError: undefined })} /> : null}
                <ZeusSelect size="regular" ariaLabel={`分支 ${index + 1} 出口`} value={rule.targetId} options={targets} onChange={(targetId) => update({ targetId })} />
                <Button size="compact" onClick={() => patch({ cases: node.data.cases.filter((_item, position) => position !== index) })}>
                  移除分支
                </Button>
              </div>
            );
          })}
          <Button size="compact" onClick={() => patch({ cases: [...node.data.cases, { field: '', operator: 'eq', value: true, targetId: targets[0]?.value ?? '' }] })}>
            添加分支
          </Button>
          <ZeusSelect
            size="regular"
            ariaLabel="默认出口"
            value={node.data.defaultTargetId ?? ''}
            options={[{ value: '', label: '未匹配时失败' }, ...targets]}
            onChange={(defaultTargetId) => patch({ defaultTargetId: defaultTargetId || undefined })}
          />
        </section>
      ) : null}
      <WorkflowInputFields node={node} definition={props.definition} onChange={props.onChange} />
      <WorkflowJsonField label="输出契约（JSON）" value={(node.data as WorkflowDataContract).outputSchema ?? null} onChange={(outputSchema) => patch({ outputSchema: outputSchema ?? undefined })} />
    </>
  );
}
