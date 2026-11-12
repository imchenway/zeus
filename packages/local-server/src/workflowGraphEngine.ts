import { Annotation, Command, END, MemorySaver, Send, START, StateGraph, interrupt } from '@langchain/langgraph';
import type { DigitalTeamNodeAttemptRecord, DigitalTeamWorkflowDefinition } from '@zeus/shared';

/** 图推进只交换节点身份，业务输入和输出由准确尝试账本保存。 */
const workflowGraphState = Annotation.Root({
  /** 本次已满足依赖的节点。 */
  ready: Annotation<string[]>({ reducer: (_previous, next) => next, default: () => [] }),
  /** 并行执行回执数，避免并发写入单值通道。 */
  completed: Annotation<number>({ reducer: (previous, next) => previous + next, default: () => 0 }),
});

/** Zeus 提供状态、受控调用和持久化；LangGraph 唯一负责新流程的推进。 */
export interface WorkflowGraphHost {
  /** 当前冻结图。 */
  definition: DigitalTeamWorkflowDefinition;
  /** 当前运行身份。 */
  runId: string;
  /** 读取准确尝试；暂停、返工和外部回执都使用同一账本。 */
  attempts(): DigitalTeamNodeAttemptRecord[];
  /** 是否仍然允许本运行继续派发。 */
  canDispatch(): boolean;
  /** 执行或登记跳过，必须先耐久保存意图。 */
  execute(nodeId: string, skipped: boolean): Promise<void>;
  /** 记录图决定等待或结束时的准确业务事实，避免异步回执被空扫描吞掉。 */
  observeIdle(): void;
  /** 上一次 LangGraph 检查点。 */
  checkpoint?: string;
  /** 在继续执行前保存检查点到现有运行账本。 */
  saveCheckpoint(checkpoint: string): Promise<void>;
}

/** 检查依赖边的真实选择状态，保留未决定与未选择的差异。 */
export function workflowRunnableNodes(host: Pick<WorkflowGraphHost, 'definition' | 'attempts'>): Array<{ id: string; skipped: boolean }> {
  const current = new Map(host.attempts().map((attempt) => [attempt.nodeId, attempt]));
  return host.definition.nodes.flatMap((node) => {
    const attempt = current.get(node.id);
    if (attempt && !['prepared', 'invalidated', 'cancelled'].includes(attempt.status)) return [];
    const edges = host.definition.edges.filter((edge) => edge.target === node.id);
    if (!edges.length) return [{ id: node.id, skipped: false }];
    let selected = 0;
    for (const edge of edges) {
      const predecessor = current.get(edge.source);
      if (!predecessor || !['succeeded', 'skipped'].includes(predecessor.status)) return [];
      if (predecessor.status === 'succeeded' && (!predecessor.execution?.selectedTargets || predecessor.execution.selectedTargets.includes(node.id))) selected += 1;
    }
    return [{ id: node.id, skipped: selected === 0 }];
  });
}

/** 在既有 SQLite 控制快照中耐久保存 LangGraph 检查点和待提交写入。 */
class WorkflowCheckpointSaver extends MemorySaver {
  /** 串行保存并行节点的检查点，防止较旧快照覆盖较新写入。 */
  private saving: Promise<void> = Promise.resolve();

  /** 恢复带类型的字节数据，保持 LangGraph 自己的序列化协议。 */
  constructor(
    private readonly persist: (snapshot: string) => Promise<void>,
    snapshot?: string,
  ) {
    super();
    if (snapshot) {
      const restored = JSON.parse(snapshot, (_key, value: unknown) => (value && typeof value === 'object' && 'workflowBytes' in value ? new Uint8Array(Buffer.from(String(value.workflowBytes), 'base64')) : value)) as Pick<
        MemorySaver,
        'storage' | 'writes'
      >;
      this.storage = restored.storage;
      this.writes = restored.writes;
    }
  }

  /** 每次检查点先交给库维护，再保存到现有业务账本。 */
  override async put(...args: Parameters<MemorySaver['put']>): ReturnType<MemorySaver['put']> {
    const result = await super.put(...args);
    await this.flush();
    return result;
  }

  /** 节点结果写入也必须耐久化，恢复时才能识别已执行动作。 */
  override async putWrites(...args: Parameters<MemorySaver['putWrites']>): Promise<void> {
    await super.putWrites(...args);
    await this.flush();
  }

  /** 普通值通道保留最近八个完整检查点，返工事实仍永久保留在尝试账本。 */
  private flush(): Promise<void> {
    this.saving = this.saving.then(async () => {
      for (const namespaces of Object.values(this.storage))
        for (const checkpoints of Object.values(namespaces)) {
          const ids = Object.keys(checkpoints).sort();
          for (const id of ids.slice(0, -8)) {
            delete checkpoints[id];
            for (const key of Object.keys(this.writes)) if (key.includes(id)) delete this.writes[key];
          }
        }
      const snapshot = JSON.stringify({ storage: this.storage, writes: this.writes }, (_key, value: unknown) => (value instanceof Uint8Array ? { workflowBytes: Buffer.from(value).toString('base64') } : value));
      await this.persist(snapshot);
    });
    return this.saving;
  }
}

/** 推进所有可执行分支；等待时 interrupt 释放资源，后续从耐久检查点恢复。 */
export async function advanceWorkflowGraph(host: WorkflowGraphHost): Promise<void> {
  const saver = new WorkflowCheckpointSaver(host.saveCheckpoint, host.checkpoint);
  const graph = new StateGraph(workflowGraphState)
    .addNode('schedule', () => {
      if (!host.canDispatch()) {
        host.observeIdle();
        return { ready: [] };
      }
      const ready = workflowRunnableNodes(host);
      if (!ready.length) host.observeIdle();
      if (!ready.length && host.attempts().some((attempt) => ['active', 'dispatching', 'waiting', 'awaiting_approval', 'outcome_unknown'].includes(attempt.status))) interrupt({ runId: host.runId });
      return { ready: ready.map((node) => node.id) };
    })
    .addNode('execute', async (state: { nodeId: string }) => {
      if (host.canDispatch()) {
        const node = workflowRunnableNodes(host).find((candidate) => candidate.id === state.nodeId);
        if (node) await host.execute(node.id, node.skipped);
      }
      return { completed: 1 };
    })
    .addEdge(START, 'schedule')
    .addConditionalEdges('schedule', (state) => (state.ready.length ? state.ready.map((nodeId) => new Send('execute', { nodeId })) : END), ['execute', END])
    .addEdge('execute', 'schedule')
    .compile({ checkpointer: saver });
  const config = { configurable: { thread_id: host.runId }, recursionLimit: 520, durability: 'sync' as const };
  const previous = await graph.getState(config);
  await graph.invoke(previous.tasks.some((task) => task.interrupts?.length) ? new Command({ resume: true }) : { ready: [] }, config);
}
