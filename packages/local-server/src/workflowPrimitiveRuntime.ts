import { interrupt } from '@langchain/langgraph';
import { createHash } from 'node:crypto';
import {
  bindWorkflowInputs,
  canonicalCommandInputJson,
  digitalTeamExecutionDefinition,
  routeWorkflowInput,
  workflowValueIssue,
  type DigitalTeamEmployeeNode,
  type DigitalTeamNode,
  type DigitalTeamNodeAttemptRecord,
  type WorkflowValue,
  type WorkflowToolReference,
  type WorkflowDataContract,
} from '@zeus/shared';
import type { DigitalTeamNodeAttemptRepository, DigitalTeamWorkflowRunRepository, DigitalTeamWorkflowRunRecord } from '@zeus/storage';
import { DigitalTeamWorkflowRouteError, type DigitalTeamApprovalInput, type DigitalTeamCommandContext } from './digitalTeamWorkflowRoutes.js';
import { advanceWorkflowGraph } from './workflowGraphEngine.js';

/** null、false、零和空字符串都是有效输出，不能退回到整份结果对象。 */
function workflowAttemptOutput(attempt: DigitalTeamNodeAttemptRecord): WorkflowValue {
  if (attempt.execution?.output !== undefined) return attempt.execution.output;
  if (attempt.result?.output !== undefined) return attempt.result.output;
  return attempt.result as unknown as WorkflowValue;
}

/** 业务能力全部通过既有端口执行，原语运行器不持有模型或外部系统凭据。 */
export interface WorkflowPrimitiveRuntimeOptions {
  /** 运行权威账本。 */
  runs: DigitalTeamWorkflowRunRepository;
  /** 准确尝试权威账本。 */
  attempts: DigitalTeamNodeAttemptRepository;
  /** 当前时钟。 */
  now(): Date;
  /** 将内存事务保存到本地耐久数据库。 */
  save(): Promise<void>;
  /** 候选预检在创建验证尝试前完成，避免新候选使刚创建的尝试失效。 */
  prepareAgent?(run: DigitalTeamWorkflowRunRecord, node: DigitalTeamEmployeeNode): Promise<boolean>;
  /** 调用已有员工执行链路。 */
  dispatchAgent(run: DigitalTeamWorkflowRunRecord, node: DigitalTeamEmployeeNode, attempt: DigitalTeamNodeAttemptRecord): Promise<void>;
  /** 启动固定版本子流程；相同尝试复用同一运行身份。 */
  startWorkflow(run: DigitalTeamWorkflowRunRecord, node: Extract<DigitalTeamNode, { type: 'invoke' }>, attempt: DigitalTeamNodeAttemptRecord): Promise<string>;
  /** 通过当前 Plugin broker 核对身份、权限与审批后调用。 */
  invokeTool(run: DigitalTeamWorkflowRunRecord, reference: WorkflowToolReference, input: Record<string, WorkflowValue>, approved: boolean, signal?: AbortSignal): Promise<WorkflowValue>;
  /** 异步外部结果落库后通知主协调器继续推进。 */
  onSettled?(runId: string, error?: unknown): void;
  /** 固定成果在执行边界核对本任务授权、准确版本和实际内容摘要。 */
  resolveArtifact?(run: DigitalTeamWorkflowRunRecord, id: string, sha256: string): Promise<WorkflowValue>;
  /** 节点完成后复用代码候选和缺陷门禁。 */
  complete(run: DigitalTeamWorkflowRunRecord): Promise<void>;
}

/** 维护原语的准确尝试；外部动作结果未知时保留记录并停止派发。 */
export class WorkflowPrimitiveRuntime {
  /** 当前进程正在执行的外部动作，重启后不隐式重发。 */
  private readonly active = new Map<string, { controller: AbortController; promise?: Promise<void> }>();

  /** 业务端口与时间由主协调器统一提供。 */
  constructor(private readonly options: WorkflowPrimitiveRuntimeOptions) {}

  /** 恢复等待、核对在途结果，然后交由 LangGraph 推进已满足依赖的节点。 */
  async advance(runId: string): Promise<void> {
    const initial = this.run(runId);
    if (['completed', 'failed', 'cancelled'].includes(initial.status)) return;
    for (const attempt of this.current(runId)) {
      if (attempt.nodeType === 'employee') {
        if (attempt.status === 'succeeded' && attempt.execution && attempt.execution.output === undefined && attempt.result) this.update(attempt, { execution: { ...attempt.execution, output: workflowAttemptOutput(attempt) } });
        continue;
      }
      if (attempt.status === 'dispatching' && !this.active.has(attempt.id))
        this.update(attempt, { status: 'outcome_unknown', error: { code: 'ZEUS_WORKFLOW_OUTCOME_UNKNOWN', message: '外部动作缺少已确认回执，请先核对结果，不能自动重发。' } });
      if (attempt.status === 'active' && !this.active.has(attempt.id)) {
        this.finish(attempt, attempt.execution!.input);
        continue;
      }
      if (attempt.status !== 'waiting') continue;
      if (attempt.execution?.childRunId) {
        const child = this.options.runs.getById(attempt.execution.childRunId);
        if (child && child.controlState !== initial.controlState && !['completed', 'failed', 'cancelled'].includes(child.status)) this.options.runs.update(child.id, { expectedRevision: child.revision, controlState: initial.controlState });
        if (!child) this.fail(attempt, '子流程记录丢失，不能猜测执行结果。');
        else if (child.status === 'completed')
          this.finish(
            attempt,
            Object.fromEntries(
              this.current(child.id)
                .filter((item) => item.status === 'succeeded')
                .map((item) => [item.nodeId, workflowAttemptOutput(item)]),
            ),
          );
        else if (['failed', 'cancelled'].includes(child.status)) this.fail(attempt, `子流程以 ${child.status} 结束。`);
        else if (child.status === 'outcome_unknown') this.update(attempt, { status: 'outcome_unknown', error: { message: '子流程结果未知，需要先核对。' } });
        continue;
      }
      const node = digitalTeamExecutionDefinition(initial).nodes.find((item) => item.id === attempt.nodeId);
      if (attempt.execution?.wait?.kind === 'tool_approval' && Date.parse(attempt.execution.wait.deadline) <= this.options.now().getTime()) {
        this.fail(attempt, '工具批准等待已超时。');
        continue;
      }
      if (attempt.execution?.wait?.kind === 'tool_approval' && attempt.execution.wait.respondedBy && node?.type === 'invoke') {
        if (attempt.execution.output && typeof attempt.execution.output === 'object' && !Array.isArray(attempt.execution.output) && attempt.execution.output.approved === true) await this.callTool(initial, node, attempt, true);
        else this.fail(attempt, '工具调用未获批准。');
      } else if (node?.type === 'await' && attempt.execution?.wait && Date.parse(attempt.execution.wait.deadline) <= this.options.now().getTime()) {
        if (node.data.mode === 'timer' || node.data.onTimeout === 'continue') this.finish(attempt, { timedOut: node.data.mode !== 'timer', resumedAt: this.options.now().toISOString() });
        else this.fail(attempt, '等待已超时。');
      }
    }
    let run = this.run(runId);
    const attempts = this.current(runId);
    if (attempts.some((attempt) => attempt.status === 'outcome_unknown')) {
      if (run.status !== 'outcome_unknown') this.options.runs.update(run.id, { expectedRevision: run.revision, status: 'outcome_unknown', error: { code: 'ZEUS_WORKFLOW_OUTCOME_UNKNOWN', message: '存在结果未知的动作，已停止派发。' } });
      return;
    }
    if (run.controlState !== 'running') return;
    if (attempts.some((attempt) => attempt.status === 'failed')) {
      if (!attempts.some((attempt) => ['active', 'dispatching'].includes(attempt.status)))
        this.options.runs.update(run.id, {
          expectedRevision: run.revision,
          status: 'failed',
          completedAt: this.options.now().toISOString(),
          error: { code: 'ZEUS_WORKFLOW_NODE_FAILED', message: '流程包含失败节点，请查看节点原因后返工。' },
        });
      return;
    }
    if (run.runtimeState.graph?.checkpoint && run.runtimeState.graph.observedDigest === this.digest(runId)) return;
    let observedDigest: string | undefined;
    await advanceWorkflowGraph({
      runId,
      definition: digitalTeamExecutionDefinition(run),
      checkpoint: run.runtimeState.graph?.checkpoint,
      observeIdle: () => {
        observedDigest = this.digest(runId);
      },
      attempts: () => this.current(runId),
      canDispatch: () => {
        const latest = this.run(runId);
        return !this.current(runId).some((attempt) => ['failed', 'outcome_unknown'].includes(attempt.status)) && latest.controlState === 'running' && !['completed', 'failed', 'cancelled', 'outcome_unknown'].includes(latest.status);
      },
      execute: (nodeId, skipped) => this.execute(runId, nodeId, skipped),
      saveCheckpoint: async (checkpoint) => {
        const latest = this.run(runId);
        this.options.runs.update(runId, { expectedRevision: latest.revision, runtimeState: { ...latest.runtimeState, graph: { ...latest.runtimeState.graph, checkpoint } } });
        await this.options.save();
      },
    });
    run = this.run(runId);
    if (!['completed', 'failed', 'cancelled'].includes(run.status)) {
      this.options.runs.update(runId, { expectedRevision: run.revision, runtimeState: { ...run.runtimeState, graph: { ...run.runtimeState.graph, observedDigest } } });
      await this.options.save();
    }
    run = this.run(runId);
    const current = new Map(this.current(runId).map((attempt) => [attempt.nodeId, attempt]));
    if (run.controlState === 'running' && digitalTeamExecutionDefinition(run).nodes.every((node) => ['succeeded', 'skipped'].includes(current.get(node.id)?.status ?? ''))) await this.options.complete(run);
  }

  /** Core 命令入口提交回应，绑定主体、运行修订、尝试、输入摘要及等待身份。 */
  respond(runId: string, input: DigitalTeamApprovalInput, context: DigitalTeamCommandContext): void {
    const run = this.run(runId);
    const node = digitalTeamExecutionDefinition(run).nodes.find((item) => item.id === input.nodeId);
    const attempt = this.options.attempts.getCurrentByNode(runId, input.nodeId);
    if (!attempt || attempt.status !== 'waiting' || attempt.attempt !== input.attempt || !attempt.execution?.wait || input.waitId !== attempt.execution.wait.id || input.inputSha256 !== attempt.inputSha256 || run.controlState !== 'running')
      throw new DigitalTeamWorkflowRouteError(409, 'ZEUS_WORKFLOW_RESPONSE_INVALID', '等待已变化、未运行或不属于本次准确输入，请刷新后回应。');
    const wait = attempt.execution.wait;
    if (Date.parse(wait.deadline) <= this.options.now().getTime() || wait.respondedBy) throw new DigitalTeamWorkflowRouteError(409, 'ZEUS_WORKFLOW_RESPONSE_INVALID', '等待已到期或已被回应。');
    const allowed = (wait.kind === 'tool_approval' ? [run.runtimeState.graph?.ownerActorId] : node?.type === 'await' ? node.data.actorIds : []).map((id) => (id === 'initiator' ? run.runtimeState.graph?.ownerActorId : id));
    if (!context.actor.id || !allowed.includes(context.actor.id)) throw new DigitalTeamWorkflowRouteError(409, 'ZEUS_WORKFLOW_RESPONSE_INVALID', '当前主体没有回应此等待的权限。');
    if (node?.type === 'await' && (node.data.mode === 'timer' || (node.data.mode === 'event' && input.eventKey !== node.data.eventKey)))
      throw new DigitalTeamWorkflowRouteError(409, 'ZEUS_WORKFLOW_RESPONSE_INVALID', '等待来源或外部事件关联不匹配。');
    if ((wait.kind === 'tool_approval' || (node?.type === 'await' && node.data.mode === 'human')) && !['user', 'local_api', 'remote_control'].includes(context.actor.kind))
      throw new DigitalTeamWorkflowRouteError(409, 'ZEUS_WORKFLOW_RESPONSE_INVALID', '此等待必须由真实用户回应。');
    const output = wait.kind === 'tool_approval' ? { approved: input.approved } : input.response !== undefined ? input.response : { approved: input.approved, reason: input.reason };
    if (node && (node.data as WorkflowDataContract).outputSchema && wait.kind !== 'tool_approval') {
      const issue = workflowValueIssue(output, (node.data as WorkflowDataContract).outputSchema!);
      if (issue) throw new DigitalTeamWorkflowRouteError(409, 'ZEUS_WORKFLOW_RESPONSE_INVALID', issue);
    }
    this.update(attempt, {
      execution: { ...attempt.execution, output, wait: { ...wait, respondedBy: context.actor.id, responseCommandId: context.commandId } },
      ...(wait.kind === 'tool_approval' ? {} : { status: 'succeeded' as const, completedAt: this.options.now().toISOString() }),
    });
  }

  /** 候选轮与普通执行共用准确绑定和额度预留，已准备尝试保持身份不变。 */
  async prepareAttempt(runId: string, nodeId: string, skipped = false): Promise<DigitalTeamNodeAttemptRecord | undefined> {
    const run = this.run(runId);
    const node = digitalTeamExecutionDefinition(run).nodes.find((item) => item.id === nodeId)!;
    const prior = this.options.attempts.getCurrentByNode(runId, nodeId);
    if (prior?.status === 'prepared' && prior.execution && !skipped) return prior;
    if (!this.reserveAllowed(runId, prior?.status === 'prepared' ? prior.id : undefined)) return;
    const outputs = new Map(
      this.current(runId)
        .filter((attempt) => attempt.status === 'succeeded')
        .map((attempt) => [attempt.nodeId, workflowAttemptOutput(attempt)]),
    );
    let input: Record<string, WorkflowValue> = prior?.status === 'prepared' ? (prior.execution?.input ?? {}) : {};
    let bindingError: unknown;
    if (!skipped && (prior?.status !== 'prepared' || !prior.execution))
      try {
        input = bindWorkflowInputs((node.data as WorkflowDataContract).inputs, run.taskFacts, outputs);
        for (const [key, binding] of Object.entries((node.data as WorkflowDataContract).inputs ?? {}))
          if (binding.source === 'artifact') {
            if (!this.options.resolveArtifact) throw new Error('当前环境未提供正式成果绑定入口。');
            input[key] = await this.options.resolveArtifact(run, binding.id, binding.sha256);
          }
      } catch (error) {
        bindingError = error;
      }
    const inputSha256 = createHash('sha256')
      .update(canonicalCommandInputJson({ input, upstream: this.current(runId).map((attempt) => ({ id: attempt.id, inputSha256: attempt.inputSha256, revision: attempt.revision })) }))
      .digest('hex');
    if (!this.reserveAllowed(runId, prior?.status === 'prepared' ? prior.id : undefined)) return;
    let attempt =
      prior?.status === 'prepared'
        ? prior
        : this.options.attempts.create({
            runId,
            nodeId,
            inputSha256,
            ...(run.runtimeState.verificationRound?.tests.find((test) => test.nodeId === nodeId)?.attemptId ? { id: run.runtimeState.verificationRound.tests.find((test) => test.nodeId === nodeId)!.attemptId } : {}),
          });
    attempt = this.update(attempt, { execution: { input }, ...(skipped ? { status: 'skipped' as const, completedAt: this.options.now().toISOString() } : {}) });
    if (bindingError) {
      this.fail(attempt, bindingError instanceof Error ? bindingError.message : String(bindingError));
      return;
    }
    await this.options.save();
    return attempt;
  }

  /** 创建准确输入快照后执行；重放调度不覆盖既有尝试。 */
  private async execute(runId: string, nodeId: string, skipped: boolean): Promise<void> {
    const run = this.run(runId);
    const node = digitalTeamExecutionDefinition(run).nodes.find((item) => item.id === nodeId)!;
    if (!skipped && node.type === 'employee' && this.options.prepareAgent && !(await this.options.prepareAgent(run, node))) {
      interrupt({ runId, nodeId, reason: 'candidate_preparation' });
      return;
    }
    let attempt = await this.prepareAttempt(runId, nodeId, skipped);
    if (!attempt || attempt.status !== 'prepared') return;
    const input = attempt.execution!.input;
    try {
      if (node.type === 'employee') {
        await this.options.dispatchAgent(run, node, attempt);
        return;
      }
      if (node.type === 'await') {
        this.update(attempt, {
          status: 'waiting',
          startedAt: this.options.now().toISOString(),
          execution: { input, wait: { id: `wait:${attempt.id}`, deadline: new Date(this.options.now().getTime() + node.data.timeoutMs).toISOString(), ...(node.data.eventKey ? { eventKey: node.data.eventKey } : {}) } },
        });
      } else if (node.type === 'route') {
        attempt = this.update(attempt, { status: 'active', execution: { input, selectedTargets: [routeWorkflowInput(node, input)] } });
        this.finish(attempt, input);
      } else if (node.type === 'invoke' && node.data.capability.kind === 'tool') {
        const needsApproval = node.data.capability.reference.tool.approvalMode === 'prompt';
        if (needsApproval) this.update(attempt, { status: 'waiting', execution: { input, wait: { id: `wait:${attempt.id}`, kind: 'tool_approval', deadline: new Date(this.options.now().getTime() + 86_400_000).toISOString() } } });
        else await this.callTool(run, node, attempt, false);
      } else if (node.type === 'invoke' && node.data.capability.kind === 'workflow') {
        const childRunId = await this.options.startWorkflow(run, node, attempt);
        this.update(this.options.attempts.getById(attempt.id)!, { status: 'waiting', execution: { input, childRunId } });
      } else {
        attempt = this.update(attempt, { status: 'active', startedAt: this.options.now().toISOString() });
        /** 汇合只接纳实际选择本节点的成功前驱，不能夹带路由未选择的出口。 */
        const predecessorIds = new Set(
          digitalTeamExecutionDefinition(run)
            .edges.filter((edge) => edge.target === node.id)
            .map((edge) => edge.source),
        );
        const output =
          node.type === 'join'
            ? Object.fromEntries(
                this.current(runId)
                  .filter((item) => predecessorIds.has(item.nodeId) && item.status === 'succeeded' && (!item.execution?.selectedTargets || item.execution.selectedTargets.includes(node.id)))
                  .map((item) => [item.nodeId, workflowAttemptOutput(item)]),
              )
            : input;
        this.finish(attempt, output);
      }
    } catch (error) {
      this.fail(this.options.attempts.getById(attempt.id)!, error instanceof Error ? error.message : String(error));
    }
    await this.options.save();
  }

  /** 外部工具先保存派发意图；返回前中断视为未知，不以自动重试隐藏副作用。 */
  private async callTool(run: DigitalTeamWorkflowRunRecord, node: Extract<DigitalTeamNode, { type: 'invoke' }>, attempt: DigitalTeamNodeAttemptRecord, approved: boolean): Promise<void> {
    if (node.data.capability.kind !== 'tool') return;
    const dispatching = this.update(attempt, { status: 'dispatching', externalOperationId: `workflow-tool:${attempt.id}`, startedAt: this.options.now().toISOString() });
    const controller = new AbortController();
    const operation: { controller: AbortController; promise?: Promise<void> } = { controller };
    this.active.set(attempt.id, operation);
    try {
      await this.options.save();
    } catch (error) {
      this.active.delete(attempt.id);
      throw error;
    }
    /** 网络等待不占住协调器扫描，派发事实已经耐久保存。 */
    operation.promise = (async () => {
      try {
        const output = await this.options.invokeTool(
          run,
          node.data.capability.kind === 'tool'
            ? node.data.capability.reference
            : (() => {
                throw new Error('工具引用无效。');
              })(),
          attempt.execution!.input,
          approved,
          controller.signal,
        );
        const latest = this.options.attempts.getById(attempt.id)!;
        if (!['active', 'dispatching', 'outcome_unknown'].includes(latest.status)) return;
        this.finish(latest.status === 'dispatching' ? this.update(latest, { status: 'active' }) : latest, output);
      } catch (error) {
        const latest = this.options.attempts.getById(dispatching.id)!;
        if (!['active', 'dispatching', 'outcome_unknown'].includes(latest.status)) return;
        if (
          (error as { code?: string }).code === 'ZEUS_WORKFLOW_TOOL_REJECTED' ||
          ['ZEUS_PLUGIN_MCP_TOOL_CHANGED', 'ZEUS_PLUGIN_ACTIVATION_MISSING', 'ZEUS_PLUGIN_MCP_SERVER_NOT_FOUND', 'ZEUS_PLUGIN_MCP_TOOL_DENIED', 'ZEUS_PLUGIN_MCP_APPROVAL_STALE', 'ZEUS_PLUGIN_MCP_APPROVAL_REQUIRED'].includes(
            String((error as { code?: string }).code),
          )
        )
          this.fail(latest, error instanceof Error ? error.message : String(error));
        else this.update(latest, { status: 'outcome_unknown', error: { code: 'ZEUS_WORKFLOW_TOOL_UNKNOWN', message: error instanceof Error ? error.message : String(error) } });
      } finally {
        await this.options.save();
      }
    })()
      .then(
        () => {
          this.options.onSettled?.(run.id);
        },
        (error) => {
          this.options.onSettled?.(run.id, error);
        },
      )
      .finally(() => {
        this.active.delete(attempt.id);
      });
  }

  /** 关闭时取消本进程工具等待，保留已接纳但无法确认结果的副作用记录。 */
  async close(): Promise<void> {
    for (const operation of this.active.values()) operation.controller.abort();
    await this.settleExternal();
  }

  /** 关闭和集成验收等待当前已派发动作落库，不用于普通调度。 */
  async settleExternal(): Promise<void> {
    await Promise.allSettled([...this.active.values()].flatMap((operation) => (operation.promise ? [operation.promise] : [])));
  }

  /** 输出通过契约后才能变为成功；员工既有证据仍由原链路核验。 */
  private finish(attempt: DigitalTeamNodeAttemptRecord, output: WorkflowValue): void {
    const node = digitalTeamExecutionDefinition(this.run(attempt.runId)).nodes.find((item) => item.id === attempt.nodeId)!;
    const issue = (node.data as WorkflowDataContract).outputSchema ? workflowValueIssue(output, (node.data as WorkflowDataContract).outputSchema!) : null;
    if (issue) {
      this.fail(attempt, issue);
      return;
    }
    this.update(attempt, { status: 'succeeded', execution: { ...attempt.execution!, output }, completedAt: this.options.now().toISOString(), error: null });
  }

  /** 明确失败保留原因，不能用跳过掩盖失败。 */
  private fail(attempt: DigitalTeamNodeAttemptRecord, message: string): void {
    this.update(attempt, { status: 'failed', error: { code: 'ZEUS_WORKFLOW_NODE_FAILED', message }, completedAt: this.options.now().toISOString() });
  }

  /** 所有变更使用准确修订，拒绝过期回执覆盖返工。 */
  private update(attempt: DigitalTeamNodeAttemptRecord, input: Omit<Parameters<DigitalTeamNodeAttemptRepository['update']>[1], 'expectedRevision'>): DigitalTeamNodeAttemptRecord {
    return this.options.attempts.update(attempt.id, { expectedRevision: attempt.revision, ...input });
  }

  /** 账本中的尝试就是额度预留，异步预检后必须在创建尝试前重新核对共享余额。 */
  private reserveAllowed(runId: string, reservedAttemptId?: string): boolean {
    const run = this.run(runId);
    let budgetRun = run;
    for (let depth = 0; depth < 4 && budgetRun.runtimeState.graph?.parentRunId; depth += 1) budgetRun = this.run(budgetRun.runtimeState.graph.parentRunId);
    const pendingRuns = [budgetRun.id];
    const counted = new Set<string>();
    let count = 0;
    while (pendingRuns.length) {
      const currentRunId = pendingRuns.pop()!;
      if (counted.has(currentRunId)) continue;
      counted.add(currentRunId);
      const recorded = this.options.attempts.listByRun(currentRunId);
      count += recorded.length;
      for (const recordedAttempt of recorded) if (recordedAttempt.execution?.childRunId) pendingRuns.push(recordedAttempt.execution.childRunId);
    }
    if (reservedAttemptId && this.options.attempts.getById(reservedAttemptId)?.runId === runId) count -= 1;
    if (budgetRun.controlState !== 'running' || ['completed', 'failed', 'cancelled', 'outcome_unknown'].includes(budgetRun.status)) {
      if (run.id !== budgetRun.id && run.controlState === 'running') this.options.runs.update(run.id, { expectedRevision: run.revision, controlState: 'paused' });
      return false;
    }
    if (count >= (budgetRun.runtimeState.graph?.maxNodeAttempts ?? 512)) {
      this.options.runs.update(budgetRun.id, { expectedRevision: budgetRun.revision, controlState: 'paused', error: { code: 'ZEUS_WORKFLOW_BUDGET_EXHAUSTED', message: '本流程及子流程已达到共享节点执行额度。' } });
      if (run.id !== budgetRun.id) this.options.runs.update(run.id, { expectedRevision: run.revision, controlState: 'paused' });
      return false;
    }
    return true;
  }

  /** 检查点写入不算新业务事实，空等待扫描不能改变人工看到的运行修订。 */
  private digest(runId: string): string {
    const run = this.run(runId);
    return createHash('sha256')
      .update(canonicalCommandInputJson({ controlState: run.controlState, attempts: this.current(runId).map((attempt) => ({ id: attempt.id, revision: attempt.revision, status: attempt.status })) }))
      .digest('hex');
  }

  /** 仅读取每个节点的最新尝试，历史证据继续保留。 */
  private current(runId: string): DigitalTeamNodeAttemptRecord[] {
    return digitalTeamExecutionDefinition(this.run(runId)).nodes.flatMap((node) => {
      const attempt = this.options.attempts.getCurrentByNode(runId, node.id);
      return attempt ? [attempt] : [];
    });
  }

  /** 读取当前权威运行，外部等待后不复用旧修订。 */
  private run(runId: string): DigitalTeamWorkflowRunRecord {
    const run = this.options.runs.getById(runId);
    if (!run) throw new Error('流程运行不存在。');
    return run;
  }
}
