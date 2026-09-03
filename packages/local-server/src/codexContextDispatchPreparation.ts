import type {CodexAppServerManager, CodexResponsesRuntime} from '@zeus/ai-runtime';
import type {CodexBootstrapAdditionalContext} from '@zeus/shared';
import {emitPluginCompactionHook} from './codexConversationDispatchContext.js';
import {mergeCodexAdditionalContext} from './codexNativeContextProtocol.js';
import {runCodexPortableContextCompaction} from './codexPortableContextCompaction.js';
import type {CodexProviderCommandApplicationService} from './codexProviderCommandApplication.js';
import type {ContextDispatchEnvelope, ProviderDispatchContextCompiler} from './contextDispatchService.js';
import type {ConversationSegmentLifecycle} from './conversationExecutionCoordinator.js';
import type {ZeusConversationPluginRuntime} from './zeusConversationPluginRuntime.js';

interface PrepareCodexContextInput {
  manager: CodexAppServerManager;
  providerCommands: CodexProviderCommandApplicationService;
  compileDispatchContext?: ProviderDispatchContextCompiler;
  plugins?: ZeusConversationPluginRuntime;
  segmentLifecycle?: ConversationSegmentLifecycle;
  conversation: { id: string; projectId: string };
  submission: { id: string; createdAt: string };
  providerGenerationId: string | null;
  providerInput: Array<Record<string, unknown>>;
  providerBootstrapUtf8Bytes: number;
  threadStartedForSubmission: boolean;
  context: {
    projectLocalPath: string;
    taskId: string | null;
    model: string;
    modelSourceId: string | null;
    effort: string | null;
    serviceTier: string | null | undefined;
    permissionMode: string;
    allowCodeChanges: boolean;
    additionalContext?: CodexBootstrapAdditionalContext;
  };
  pluginPromptContext?: CodexBootstrapAdditionalContext;
  responsesRuntime: CodexResponsesRuntime | null;
  beforePortableProviderWrite(): void;
  now(): string;
}

export interface PreparedCodexDispatchContext {
  compiled: ContextDispatchEnvelope | null;
  pluginCompactContext: CodexBootstrapAdditionalContext | undefined;
}

/** 在 Provider 写入前完成换路由所需的有界交接上下文。 */
export async function prepareCodexDispatchContext(input: PrepareCodexContextInput): Promise<PreparedCodexDispatchContext> {
  let pluginCompactContext: CodexBootstrapAdditionalContext | undefined;
  const lifecycle = input.segmentLifecycle;
  if (lifecycle?.contextCompactionPlan) {
    await emitPluginCompactionHook({ plugins: input.plugins, event: 'PreCompact', conversationId: input.conversation.id, cwd: input.context.projectLocalPath, model: input.context.model });
    await lifecycle.beginContextCompaction(input.now());
    try {
      input.beforePortableProviderWrite();
      const compacted = await runCodexPortableContextCompaction({
        manager: input.manager,
        providerCommands: input.providerCommands,
        providerGenerationId: input.providerGenerationId,
        conversationId: input.conversation.id,
        plan: lifecycle.contextCompactionPlan,
        model: input.context.model,
        effort: input.context.effort,
        serviceTier: input.context.serviceTier ?? null,
        cwd: input.context.projectLocalPath,
        responsesRuntime: input.responsesRuntime,
        issuedAt: input.submission.createdAt,
      });
      await lifecycle.completeContextCompaction({ summary: compacted.summary, usage: compacted.usage, evidence: compacted.evidence, completedAt: input.now() });
    } catch (error) {
      await lifecycle.failContextCompaction(error, input.now());
      throw error;
    }
    // Provider 压缩已完成后，Hook 失败只能阻断本轮派发，不能把已发生的压缩改写成失败。
    pluginCompactContext = await emitPluginCompactionHook({
      plugins: input.plugins,
      event: 'PostCompact',
      conversationId: input.conversation.id,
      cwd: input.context.projectLocalPath,
      model: input.context.model,
    });
  }

  const compile = async (): Promise<ContextDispatchEnvelope | null> => {
    if (!input.compileDispatchContext) return null;
    const fixedAdditionalContext = mergeCodexAdditionalContext(lifecycle?.codexBootstrapAdditionalContext, input.context.additionalContext, input.pluginPromptContext, pluginCompactContext);
    return input.compileDispatchContext({
      provider: 'codex',
      conversationId: input.conversation.id,
      submissionId: input.submission.id,
      projectId: input.conversation.projectId,
      projectLocalPath: input.context.projectLocalPath,
      taskId: input.context.taskId,
      modelId: input.context.model,
      modelSourceId: input.context.modelSourceId,
      operationRisk: input.context.permissionMode === 'read-only' && !input.context.allowCodeChanges ? 'read_only' : 'local_write',
      fixedRequestUtf8Bytes: Buffer.byteLength(JSON.stringify({ input: input.providerInput, ...(fixedAdditionalContext ? { additionalContext: fixedAdditionalContext } : {}) }), 'utf8'),
      providerBootstrapUtf8Bytes: input.providerBootstrapUtf8Bytes,
      providerHistoryMode: input.threadStartedForSubmission ? 'bootstrap' : 'latest',
      providerGenerationId: input.providerGenerationId,
    });
  };

    // 同一 thread 的原生压缩由 app-server 自主管理；这里只压缩换路由时必须携带的有界交接上下文。
    return {compiled: await compile(), pluginCompactContext};
}
