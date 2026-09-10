import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore, ArtifactStoreError, ConversationExecutionRepository, ZeusStorageWriteFaultError, createZeusDatabase, type ArtifactOwnerIdentity } from '../packages/storage/src/index.js';
import { ManagedConversationToolResultStore, PortableConversationContextBuilder, planPortableContextCompaction } from '../packages/local-server/src/conversationPortableContext.js';
import { searchPiWorkspace } from '../packages/local-server/src/piWorkspaceSearch.js';
import { completedItemProjection, liveProgressProjection } from '../packages/local-server/src/codexNativeConversationPolicy.js';

const probeRoot = await mkdtemp(join(tmpdir(), 'zeus-artifact-store-probe-'));
const observed: Record<string, unknown> = {};

try {
  await verifyCasAuthorizationAndGc();
  await verifyQuotaCompensation();
  await verifyExternalFaultBridge();
  await verifyConversationToolResultReplay();
  await verifyContextBudgetAndSearch();
} finally {
  await rm(probeRoot, { recursive: true, force: true });
}

console.log(JSON.stringify({ status: 'passed', observed }, null, 2));

/** 在真实文件、ripgrep、SQLite 和原件存储上检查上下文边界与可恢复性。 */
async function verifyContextBudgetAndSearch(): Promise<void> {
  /** 独立账本只服务本次上下文检查。 */
  const database = await createZeusDatabase(join(probeRoot, 'context.db'));
  try {
    /** 通过产品仓储读取历史，保留原始完成记录作为核对证据。 */
    const execution = new ConversationExecutionRepository(database);
    /** 完整输出写入本次探针目录。 */
    const store = new ManagedConversationToolResultStore(probeRoot, execution, new ArtifactStore(database, join(probeRoot, 'context-artifacts'), undefined, { minimumFreeBytes: 0 }));
    /** 同时覆盖中文三字节字符与四字节表情。 */
    const text = '甲😀乙'.repeat(8_000);
    /** 每种工具使用独立调用身份。 */
    const identity = { conversationId: 'context-conversation', turnId: 'context-turn', segmentId: 'context-segment', createdAt: '2026-09-10T08:30:00.000Z' };
    for (const toolKind of ['read', 'search', 'command', 'other'] as const) {
      /** 归档后仅预览受限，原件保持完整。 */
      const stored = await store.store({ ...identity, toolPairId: toolKind, toolKind, text });
      assertProbe(Buffer.byteLength(stored.projection, 'utf8') < 17_000 && !stored.projection.includes('\uFFFD') && stored.projection.isWellFormed(), '各类中文工具预览必须有界且保持完整字符');
      /** 按真实返回的分页水位重建原文。 */
      let restored = '';
      let offset: number | null = 0;
      while (offset !== null) {
        /** 分页读取不会再次执行原始工具。 */
        const page = await store.readPage({ conversationId: identity.conversationId, handle: stored.record.handle, offset });
        assertProbe(Buffer.byteLength(page.text, 'utf8') <= 16_384 && page.text.isWellFormed() && (page.nextOffset === null || page.nextOffset > offset), '每页必须有界、完整并推进水位');
        restored += page.text;
        offset = page.nextOffset;
      }
      assertProbe(restored === text, '有界分页必须能无损重建中文与表情原文');
      assertProbe((await store.readPage({ conversationId: identity.conversationId, handle: stored.record.handle, offset: 1, limit: 1 })).text === '😀', '小页不能拆开表情字符');
      assertProbe(await captureArtifactCode(() => store.readPage({ conversationId: identity.conversationId, handle: stored.record.handle, offset: 2 })), '字符中间的非法偏移必须拒绝');
    }
    database.execute(`INSERT INTO conversation_runtime_segments (id, conversation_id, runtime_kind, state, opened_at, created_at, updated_at) VALUES (?, ?, 'codex', 'current', ?, ?, ?)`, [
      identity.segmentId,
      identity.conversationId,
      identity.createdAt,
      identity.createdAt,
      identity.createdAt,
    ]);
    /** 复现既有历史把输出藏在工具调用 payload 中的路径。 */
    const completedPayload = { type: 'tool_call', itemType: 'commandExecution', payload: { command: 'rg needle source', cwd: probeRoot, status: 'completed', exitCode: 0, aggregatedOutput: text, result: { text }, futureOutput: text } };
    execution.appendModelHistory({ ...identity, role: 'assistant', toolPairId: 'command', content: completedPayload, confirmedAt: identity.createdAt });
    execution.appendModelHistory({ ...identity, role: 'tool', toolPairId: 'command', content: { projection: '匹配文件：source.ts' }, confirmedAt: identity.createdAt });
    execution.appendModelHistory({ ...identity, role: 'assistant', content: { text: '普通回复需要保留' }, reasoningSource: { readableSummary: false }, confirmedAt: identity.createdAt });
    execution.appendModelHistory({ ...identity, role: 'assistant', content: { text: '按能力省略的思考摘要' }, reasoningSource: { readableSummary: true }, confirmedAt: identity.createdAt });
    /** 关闭思考摘要能力时，普通回复仍然必须保留。 */
    const target = { readableReasoningSummary: false, media: false, contextWindow: 4_096, currentInputUtf8Bytes: Buffer.byteLength('继续', 'utf8') };
    const context = new PortableConversationContextBuilder(execution).build(identity.conversationId, target);
    const serialized = JSON.stringify(context);
    assertProbe(serialized.includes('普通回复需要保留') && !serialized.includes('按能力省略的思考摘要'), '普通回复不能误归入思考摘要');
    assertProbe(
      serialized.includes('rg needle source') && serialized.includes('"exitCode":0') && !serialized.includes('aggregatedOutput') && !serialized.includes('futureOutput') && Buffer.byteLength(serialized, 'utf8') < 2_048,
      '交接历史必须保留调用参数、成功退出码并排除重复大输出',
    );
    assertProbe(execution.confirmedModelHistory(identity.conversationId)[0]!.contentJson.includes('aggregatedOutput'), '上下文投影不能改写既有历史证据');
    /** 相同字符数的中文更早触发真实字节预算，英文小上下文保持直传。 */
    const entry = { sequence: 1, role: 'user' as const, content: '汉'.repeat(5_000), sourceSegmentId: identity.segmentId, sourceRuntime: 'codex' as const };
    const largeContext = { ...context, entries: [entry, { ...entry, sequence: 2, content: '继续' }] };
    const plan = planPortableContextCompaction(largeContext, target);
    assertProbe(plan && plan.estimatedInputTokens === Math.ceil((Buffer.byteLength(JSON.stringify(largeContext.entries), 'utf8') + target.currentInputUtf8Bytes) / 4), '中文交接历史必须按字节计入压缩估算');
    assertProbe(planPortableContextCompaction({ ...largeContext, entries: [{ ...entry, content: 'a'.repeat(5_000) }] }, target) === null, '小英文历史不能因单位修正被多余压缩');
    observed.contextBudget = {
      previewBodyMaximumBytes: 16_384,
      unicodeRoundTrip: true,
      toolCallBytesBefore: Buffer.byteLength(JSON.stringify(completedPayload), 'utf8'),
      portableContextBytesAfter: Buffer.byteLength(serialized, 'utf8'),
      originalHistoryRetained: true,
      ordinaryRepliesRetained: true,
      utf8CompactionEstimate: true,
    };

    /** 真实进程以非零状态退出，长日志经过流式展示、完成事件、归档和历史交接。 */
    const failedProcess = spawnSync(process.execPath, ['-e', "process.stdout.write('progress line\\n'.repeat(5000)); process.exit(7)"], { encoding: 'utf8' });
    assertProbe(failedProcess.status === 7, '诊断进程必须真实产生非零退出码');
    /** 文本错误和结构化长错误使用相同的结果摘要预算。 */
    for (const error of ['短错误', { message: '失败😀'.repeat(1_000), data: text }]) {
      /** 每种错误形状使用独立工具身份。 */
      const toolPairId = `failed-${typeof error}`;
      /** 原生事件在日志之前建立命令与状态字段。 */
      const started = { id: toolPairId, type: 'commandExecution', command: '本地诊断进程', cwd: probeRoot, status: 'inProgress', aggregatedOutput: '', exitCode: null };
      /** 复用真实流式展示的合并路径，保留后方的长展示文本。 */
      const streamed = liveProgressProjection({ payloadJson: JSON.stringify(started) }, 'command_output', failedProcess.stdout, true);
      /** 完成事件结束不等于命令成功，必须单独保留非零退出码。 */
      const completed = completedItemProjection(
        { payloadJson: JSON.stringify(streamed.payload), textContent: '' },
        { ...started, status: 'completed', aggregatedOutput: failedProcess.stdout, exitCode: failedProcess.status, error },
        'commandExecution',
      );
      /** 与原生事件写入归档的正文选择一致。 */
      const rawText = completed.textContent || JSON.stringify(completed.payload);
      /** 日志头尾不会包含位于两段长输出之间的退出码。 */
      const stored = await store.store({ ...identity, toolPairId, toolKind: 'command', text: rawText });
      assertProbe(rawText.includes('"exitCode":7') && !stored.projection.includes('exitCode'), '诊断必须覆盖日志预览遗漏退出码的真实组合');
      execution.appendModelHistory({ ...identity, role: 'assistant', toolPairId, content: { type: 'tool_call', itemType: 'commandExecution', payload: completed.payload }, confirmedAt: identity.createdAt });
      execution.appendModelHistory({ ...identity, role: 'tool', toolPairId, content: { projection: stored.projection, handle: stored.record.handle }, confirmedAt: identity.createdAt });
      /** 检查交接给目标模型的内容，不以数据库原件存在代替首屏可见。 */
      const handedOff = new PortableConversationContextBuilder(execution).build(identity.conversationId, target);
      /** 当前调用的执行摘要应独立于日志预览。 */
      const call = handedOff.entries.find((candidate) => candidate.role === 'assistant' && candidate.toolPairId === toolPairId)?.content as { payload: Record<string, unknown> };
      assertProbe(call.payload.exitCode === 7 && call.payload.status === 'completed' && !('aggregatedOutput' in call.payload) && !('presentation' in call.payload), '去重后必须保留非零退出码及完成状态，排除重复日志');
      assertProbe(typeof call.payload.error === 'string' && call.payload.error.isWellFormed() && Buffer.byteLength(call.payload.error, 'utf8') < 1_200, '错误摘要必须保持字符完整且有界');
      assertProbe(typeof error === 'string' ? call.payload.error === error : call.payload.error.includes('错误摘要已截断'), '短错误完整保留，长错误须提示读取原件');
    }
    observed.contextResultSemantics = { failedProcessExitCode: failedProcess.status, exitCodeRetainedAfterHandoff: true, completedStatusRetained: true, boundedErrorSummary: true, duplicateOutputExcluded: true };

    /** 搜索输入全部来自本次创建的普通文件。 */
    const cwd = join(probeRoot, 'workspace-search');
    await mkdir(cwd);
    await writeFile(join(cwd, 'source.md'), 'needle 原文\nneedle 第二条\nneedle 第三条\n-danger\n');
    await writeFile(join(cwd, 'ignored.txt'), 'needle 不应被 Markdown 筛选返回\n');
    /** 调用与运行适配器一致的搜索入口。 */
    const search = (args: Record<string, unknown>, path = cwd) => searchPiWorkspace({ cwd, path, tool: 'grep', args });
    const files = await search({ pattern: 'needle', glob: '*.md' });
    assertProbe(files.includes('source.md') && !files.includes('原文') && !files.includes('ignored.txt'), '默认搜索只返回匹配的文件名并应用文件筛选');
    const content = await search({ pattern: 'needle', glob: '*.md', outputMode: 'content', limit: 2 });
    assertProbe(content.includes('原文') && content.includes('第二条') && !content.includes('第三条') && content.includes('最多 2 条'), '正文搜索必须保留行号并明确逐文件上限');
    assertProbe((await search({ pattern: '-danger' })).includes('source.md'), '以短横线开头的表达式不能被解释成命令参数');
    assertProbe((await searchPiWorkspace({ cwd, path: cwd, tool: 'find', args: { pattern: '*.md' } })).includes('source.md'), '文件查找必须沿用有界搜索入口');
    assertProbe((await search({ pattern: 'never-matches' })) === '没有匹配结果。', '只有正常零匹配才能返回无匹配提示');
    assertProbe(await captureArtifactCode(() => search({ pattern: '[' })), '非法表达式不能被伪装成无匹配');
    assertProbe(await captureArtifactCode(() => search({ pattern: 'needle' }, join(cwd, 'missing'))), '不存在的路径必须报错');
    assertProbe(await captureArtifactCode(() => searchPiWorkspace({ cwd, path: cwd, tool: 'grep', args: { pattern: 'needle' }, signal: AbortSignal.abort() })), '取消的搜索必须保持取消状态');
    await writeFile(join(cwd, 'large-a.txt'), `${'needle'.padEnd(250, 'x')}\n`.repeat(200));
    await writeFile(join(cwd, 'large-b.txt'), `${'needle'.padEnd(250, 'x')}\n`.repeat(200));
    const bounded = await search({ pattern: 'needle', glob: 'large-*.txt', outputMode: 'content', limit: 200 });
    assertProbe(bounded.includes('结果不完整') && Buffer.byteLength(bounded, 'utf8') < 67_000, '大量匹配必须停止收集并明确结果不完整');
    /** 继续经过 Pi 使用的搜索结果归档与首屏预览，不能只检查搜索函数自身。 */
    const searchResult = await store.store({ ...identity, toolPairId: 'bounded-search', toolKind: 'search', text: bounded });
    assertProbe(
      searchResult.projection.includes('结果不完整') && searchResult.projection.includes('分页仅能读取已收集部分') && searchResult.projection.includes('继续读取') && Buffer.byteLength(searchResult.projection, 'utf8') < 17_000,
      '收集截断说明必须在有界首屏中可见，不能与普通分页截断混淆',
    );
    observed.workspaceSearch = { filenamesFirst: true, scopedContent: true, optionBoundary: true, errorsPreserved: true, cancellationPreserved: true, collectionMaximumBytes: 65_536, incompleteCollectionVisibleInPreview: true };
  } finally {
    await database.close();
  }
}

/** 在真实临时 SQLite 与 Artifact 文件上验证原文归档、完成回显和并发重复归档。 */
async function verifyConversationToolResultReplay(): Promise<void> {
  /** 独立数据库用于验证关闭重开后的稳定句柄。 */
  const databasePath = join(probeRoot, 'tool-results.db');
  /** 工具原件只落在本次探针的临时目录。 */
  const artifactRoot = join(probeRoot, 'tool-artifacts');
  /** 首次打开的数据库连接。 */
  const database = await createZeusDatabase(databasePath);
  /** 保存重启后仍需读取的原始句柄。 */
  let originalHandle = '';
  /** 超过投影上限的原文，确保回显不是完整原件。 */
  const originalText = `${'完整工具结果\n'.repeat(4_096)}原文结尾`;
  /** 同一真实调用的固定归档身份。 */
  const input = { conversationId: 'tool-conversation', turnId: 'tool-turn', segmentId: 'tool-segment', toolPairId: 'tool-call', toolKind: 'other' as const, text: originalText, createdAt: '2026-09-08T03:05:17.586Z' };
  try {
    /** 使用产品中的真实存储实现，不替换数据库或文件写入。 */
    const execution = new ConversationExecutionRepository(database);
    /** 禁止探针触碰正式 Artifact。 */
    const artifacts = new ArtifactStore(database, artifactRoot, undefined, { minimumFreeBytes: 0 });
    /** 动态工具执行和完成通知共用的归档入口。 */
    const store = new ManagedConversationToolResultStore(artifactRoot, execution, artifacts);
    /** 首次执行保存完整原文。 */
    const original = await store.store(input);
    originalHandle = original.record.handle;
    /** 完成事件只回显已经截断的模型投影。 */
    const echoed = await store.store({ ...input, text: original.projection, createdAt: '2026-09-08T03:05:18.586Z' });
    assertProbe(echoed.record.handle === originalHandle && echoed.projection === original.projection, '完成回显必须复用原句柄和原投影');
    assertProbe(database.countRows('conversation_tool_results') === 1 && database.countRows('artifact_owners') === 1 && database.countRows('artifact_objects') === 1, '重复通知不得新增结果或 Artifact 引用');
    assertProbe((await store.readPage({ conversationId: input.conversationId, handle: originalHandle, offset: originalText.length - 4 })).text === '原文结尾', '完成回显不能覆盖原件尾部');
    assertProbe(execution.recordToolResult({ ...original.record, handle: 'duplicate-candidate' }).handle === originalHandle, '数据库插入冲突必须返回首次记录');
    assertProbe(captureStorageFault(() => execution.recordToolResult({ ...original.record, toolPairId: 'another-call' }))?.includes('身份冲突'), '同一句柄不能属于另一调用');
    for (const scope of [{ turnId: 'another-turn' }, { segmentId: 'another-segment' }]) {
      assertProbe((await captureArtifactCode(() => store.store({ ...input, ...scope })))?.includes('身份冲突'), '跨轮次或分段的调用编号冲突必须拒绝');
    }
    assertProbe((await captureArtifactCode(() => store.readPage({ conversationId: 'another-conversation', handle: originalHandle })))?.includes('不属于当前'), '句柄不能被其他会话读取');
    assertProbe((await store.store({ ...input, conversationId: 'another-conversation' })).record.handle !== originalHandle, '不同会话中的同名调用必须独立保存');

    /** 两个存储实例同时首次归档，强制经过数据库唯一键裁定。 */
    const concurrentStores = [store, new ManagedConversationToolResultStore(artifactRoot, new ConversationExecutionRepository(database), artifacts)];
    /** 不同候选原文也必须返回唯一记录对应的投影。 */
    const concurrent = await Promise.all(concurrentStores.map((candidate, index) => candidate.store({ ...input, toolPairId: 'concurrent-call', text: `${originalText}${index}` })));
    assertProbe(
      concurrent[0]!.record.handle === concurrent[1]!.record.handle && concurrent[0]!.projection === concurrent[1]!.projection && concurrent[0]!.projection.includes(concurrent[0]!.record.handle),
      '并发归档不能返回悬空句柄或不同投影',
    );

    /** 最小 PNG 原件用于核对图片重入和图片序号隔离。 */
    const imageUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9e0AAAAASUVORK5CYII=';
    /** 同一图片的两个并发归档请求。 */
    const images = await Promise.all(concurrentStores.map((candidate) => candidate.storeImage({ ...input, toolPairId: 'tool-call:image:0', imageUrl })));
    assertProbe(images[0]!.record.handle === images[1]!.record.handle && images[0]!.projectionText === images[1]!.projectionText && images.every((image) => image.projectedImageUrl === imageUrl), '并发图片必须复用原件、句柄和投影说明');
    assertProbe((await store.storeImage({ ...input, toolPairId: 'tool-call:image:1', imageUrl })).record.handle !== images[0]!.record.handle, '同一调用的不同图片序号不能合并');
    assertProbe((await captureArtifactCode(() => store.storeImage({ ...input, imageUrl })))?.includes('类型不匹配'), '图片与文字不得共享同一结果编号');
    /** 以另一张超过热投影上限的图片验证重入必须读取原件。 */
    const largeImageUrl = `data:image/png;base64,${Buffer.concat([Buffer.from(imageUrl.split(',')[1]!, 'base64'), Buffer.alloc(800 * 1024)]).toString('base64')}`;
    assertProbe((await store.storeImage({ ...input, toolPairId: 'tool-call:image:0', imageUrl: largeImageUrl })).projectedImageUrl === imageUrl, '原图句柄不能配上重入请求中的另一张图');
    /** 超限图片只能通过显式原图读取获得内容。 */
    const largeImage = await store.storeImage({ ...input, toolPairId: 'large-call:image:0', imageUrl: largeImageUrl });
    assertProbe(largeImage.projectedImageUrl === null && (await store.storeImage({ ...input, toolPairId: 'large-call:image:0', imageUrl })).projectedImageUrl === null, '超限原图重入仍应保持有界热投影');
    assertProbe((await store.readImage({ conversationId: input.conversationId, handle: largeImage.record.handle, detail: 'original' })).imageUrl === largeImageUrl, '原图读取必须保留完整内容');
    assertProbe(database.countRows('artifact_owners') === database.countRows('conversation_tool_results'), '并发未采用的候选不能遗留 owner 引用');
    assertProbe(database.get<{ count: number }>(`SELECT COUNT(*) AS count FROM artifact_retention_holds WHERE state = 'active'`)?.count === database.countRows('conversation_tool_results'), '并发未采用的候选不能遗留活动保留锁');
    assertProbe(database.get<{ quick_check: string }>('PRAGMA quick_check')?.quick_check === 'ok', '工具结果账本必须完整');
    observed.toolResultReplay = { originalRetained: true, concurrentText: true, concurrentImages: true, scopeIsolation: true, boundedImages: true, candidateReferencesReleased: true };
  } finally {
    await database.close();
  }
  /** 重开数据库排除仅靠进程内缓存去重的实现。 */
  const reopened = await createZeusDatabase(databasePath);
  try {
    /** 新实例仍通过已保存的唯一键复用结果。 */
    const store = new ManagedConversationToolResultStore(artifactRoot, new ConversationExecutionRepository(reopened), new ArtifactStore(reopened, artifactRoot, undefined, { minimumFreeBytes: 0 }));
    assertProbe((await store.store({ ...input, text: '重启后的完成回显' })).record.handle === originalHandle, '重启后的回显必须复用旧句柄');
    observed.toolResultReplayAfterReopen = true;
  } finally {
    await reopened.close();
  }
}

async function verifyCasAuthorizationAndGc(): Promise<void> {
  const database = await createZeusDatabase(join(probeRoot, 'cas.db'));
  try {
    const store = new ArtifactStore(database, join(probeRoot, 'cas-artifacts'), () => '2026-08-21T00:00:00.000Z', { minimumFreeBytes: 0, writeFaultReporter: database });
    const ownerA = owner('tool_result', 'result-a');
    const ownerB = owner('portable_context', 'context-b');
    const content = `${'stable artifact payload\n'.repeat(4_096)}tail`;
    const first = await store.putText({ text: content, mimeType: 'text/plain', owner: ownerA, compression: 'gzip-v1' });
    const second = await store.putText({ text: content, mimeType: 'text/plain', owner: ownerB, compression: 'gzip-v1' });
    const authorized = await store.readAuthorized({ sha256: first.sha256, owner: ownerA, maximumContentBytes: Buffer.byteLength(content) + 1 });

    observed.deduplicatedSha256 = first.sha256 === second.sha256;
    observed.objectCount = database.countRows('artifact_objects');
    observed.ownerCount = database.countRows('artifact_owners');
    observed.authorizedRoundTrip = Buffer.from(authorized.bytes).toString('utf8') === content;
    observed.unauthorizedRead = await captureArtifactCode(() => store.readAuthorized({ sha256: first.sha256, owner: { kind: 'tool_result', id: 'not-owner' } }));

    const hold = store.hold({ sha256: first.sha256, owner: ownerA, ownerClass: 'active_conversation', reason: '活动会话仍在引用完整工具结果', createdAt: '2026-08-21T00:00:00.000Z' });
    store.detachOwner({ sha256: first.sha256, owner: ownerA });
    store.detachOwner({ sha256: first.sha256, owner: ownerB });
    const heldCandidate = store.createGcCandidate({ eligibleBefore: '2026-08-22T00:00:00.000Z', minimumQuarantineMs: 60_000, createdAt: '2026-08-22T00:00:00.000Z' });
    observed.heldArtifactExcluded = heldCandidate.artifactCount === 0;
    store.cancelGcCandidate(heldCandidate.id);
    store.releaseHold({ id: hold.id, releasedAt: '2026-08-22T00:00:01.000Z' });

    const candidate = store.createGcCandidate({ eligibleBefore: '2026-08-22T00:00:00.000Z', minimumQuarantineMs: 60_000, createdAt: '2026-08-22T00:00:02.000Z' });
    const newOwner = owner('conversation_tool_result', 'result-referenced-after-candidate');
    store.attachOwner({ sha256: first.sha256, owner: newOwner, createdAt: '2026-08-22T00:00:03.000Z' });
    const revalidated = store.revalidateGcCandidate(candidate.id);
    observed.newOwnerMakesCandidateUnsafe = !revalidated.safe && revalidated.retainedSha256.includes(first.sha256);
    observed.quarantineBlockedByNewOwner = await captureArtifactCode(() => store.quarantineGcCandidate({ manifestId: candidate.id, expectedManifestSha256: candidate.manifestSha256, quarantinedAt: '2026-08-22T00:00:04.000Z' }));
    store.detachOwner({ sha256: first.sha256, owner: newOwner });
    store.cancelGcCandidate(candidate.id);

    const recoverable = store.createGcCandidate({ eligibleBefore: '2026-08-22T00:00:00.000Z', minimumQuarantineMs: 60_000, createdAt: '2026-08-22T00:00:05.000Z' });
    const quarantined = await store.quarantineGcCandidate({
      manifestId: recoverable.id,
      expectedManifestSha256: recoverable.manifestSha256,
      quarantinedAt: '2026-08-22T00:00:06.000Z',
    });
    const restored = await store.restoreQuarantinedGcCandidate({
      manifestId: recoverable.id,
      expectedManifestSha256: recoverable.manifestSha256,
      restoredAt: '2026-08-22T00:00:07.000Z',
    });
    store.attachOwner({ sha256: first.sha256, owner: ownerA, createdAt: '2026-08-22T00:00:08.000Z' });
    const restoredRead = await store.readAuthorized({ sha256: first.sha256, owner: ownerA, maximumContentBytes: Buffer.byteLength(content) + 1 });
    observed.quarantineAndRestore = quarantined.state === 'quarantined' && restored.state === 'cancelled' && Buffer.from(restoredRead.bytes).toString('utf8') === content;
    const capacity = await store.capacityDiagnostic({ recordSample: true, largestLimit: 5 });
    observed.capacityDiagnostic = capacity.categories.length > 0 && capacity.largest.some((entry) => entry.sha256 === first.sha256) && capacity.reclaimability.blockedByOwner >= 1;
    observed.casQuickCheck = database.get<{ quick_check: string }>(`PRAGMA quick_check`)?.quick_check ?? null;

    assertProbe(observed.deduplicatedSha256 === true && observed.objectCount === 1 && observed.ownerCount === 2, '同内容双 owner 必须只占一个 CAS 对象');
    assertProbe(observed.authorizedRoundTrip === true && observed.unauthorizedRead === 'ZEUS_ARTIFACT_OWNER_MISMATCH', '授权读必须精确匹配 owner');
    assertProbe(observed.heldArtifactExcluded === true, '活动保留锁必须排除 GC 候选');
    assertProbe(observed.newOwnerMakesCandidateUnsafe === true && observed.quarantineBlockedByNewOwner === 'ZEUS_ARTIFACT_GC_CONFLICT', '候选后新引用必须阻断隔离');
    assertProbe(observed.quarantineAndRestore === true && observed.capacityDiagnostic === true, '隔离必须可恢复且容量诊断可观测');
    assertProbe(observed.casQuickCheck === 'ok', 'Artifact 临时账本 quick_check 必须通过');
  } finally {
    await database.close();
  }
}

async function verifyQuotaCompensation(): Promise<void> {
  const database = await createZeusDatabase(join(probeRoot, 'quota.db'));
  try {
    const store = new ArtifactStore(database, join(probeRoot, 'quota-artifacts'), () => '2026-08-21T01:00:00.000Z', {
      quotaBytes: 1,
      minimumFreeBytes: 0,
      writeFaultReporter: database,
    });
    observed.quotaRejection = await captureArtifactCode(() => store.putText({ text: 'larger than one byte', mimeType: 'text/plain', owner: owner('tool_result', 'quota') }));
    observed.quotaLeavesNoReference = database.countRows('artifact_objects') === 0 && database.countRows('artifact_owners') === 0 && database.countRows('artifact_staging_operations') === 0;
    observed.quotaKeepsCoreWritable = database.storageHealthSnapshot().writesAllowed;
    assertProbe(observed.quotaRejection === 'ZEUS_ARTIFACT_CAPACITY_EXHAUSTED' && observed.quotaLeavesNoReference === true, '配额拒绝必须补偿为零引用');
    assertProbe(observed.quotaKeepsCoreWritable === true, '业务配额拒绝不得冒充硬存储故障');
  } finally {
    await database.close();
  }
}

async function verifyExternalFaultBridge(): Promise<void> {
  const database = await createZeusDatabase(join(probeRoot, 'fault.db'));
  try {
    database.execute(`CREATE TABLE artifact_fault_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL)`);
    database.execute(`INSERT INTO artifact_fault_probe (id, value) VALUES (1, 'baseline')`);
    await database.save();
    const injected = Object.assign(new Error('permission denied during artifact staging'), { code: 'EACCES' });
    const store = new ArtifactStore(database, join(probeRoot, 'fault-artifacts'), () => '2026-08-21T02:00:00.000Z', {
      minimumFreeBytes: 0,
      writeFaultReporter: database,
      faultInjection: {
        beforeFileOperation() {
          throw injected;
        },
      },
    });
    observed.externalArtifactFailure = await captureArtifactCode(() => store.putText({ text: 'fault', mimeType: 'text/plain', owner: owner('tool_result', 'fault') }));
    const health = database.storageHealthSnapshot();
    observed.externalFaultHealth = health;
    observed.externalFaultRecorded = database.get<{ count: number }>(`SELECT COUNT(*) AS count FROM artifact_storage_faults WHERE errno = 'EACCES' AND resolved_at IS NULL`)?.count === 1;
    observed.externalFaultOldRead = database.get<{ value: string }>(`SELECT value FROM artifact_fault_probe WHERE id = 1`)?.value === 'baseline';
    observed.externalFaultSecondWrite = captureStorageFault(() => database.execute(`INSERT INTO artifact_fault_probe (id, value) VALUES (2, 'blocked')`));
    observed.externalFaultNoPartialReference = database.countRows('artifact_objects') === 0 && database.countRows('artifact_owners') === 0;
    observed.externalFaultArtifactPreflight = await store.runRecoveryPreflight();

    assertProbe(observed.externalArtifactFailure === 'ZEUS_ARTIFACT_EXTERNAL_WRITE_FAILED', 'Artifact staging EACCES 必须返回外部写故障');
    assertProbe(health.state === 'read_only_fault' && health.fault?.kind === 'permission_denied' && !health.writesAllowed, '外部硬故障必须进入 Core 统一只读态');
    assertProbe(observed.externalFaultRecorded === true && observed.externalFaultOldRead === true, '故障证据和旧事实必须可读');
    assertProbe(observed.externalFaultSecondWrite === 'ZEUS_STORAGE_READ_ONLY_FAULT:permission_denied' && observed.externalFaultNoPartialReference === true, '故障后第二写必须失败关闭且无半引用');
    const artifactPreflight = observed.externalFaultArtifactPreflight as Awaited<ReturnType<typeof store.runRecoveryPreflight>>;
    assertProbe(!artifactPreflight.eligibleForCoreRestart && artifactPreflight.stagingWrite === 'failed' && artifactPreflight.errorCode === 'EACCES', 'Artifact staging 仍不可写时恢复预检必须失败关闭');
  } finally {
    await database.close().catch(() => undefined);
  }
}

function owner(kind: string, id: string): ArtifactOwnerIdentity {
  return { kind, id, generationId: 'artifact-behavior-probe-v1', projectId: 'probe-project', conversationId: 'probe-conversation' };
}

async function captureArtifactCode(operation: () => unknown | Promise<unknown>): Promise<string | null> {
  try {
    await operation();
    return null;
  } catch (error) {
    return error instanceof ArtifactStoreError ? error.code : error instanceof Error ? `${error.name}:${error.message}` : String(error);
  }
}

function captureStorageFault(operation: () => unknown): string | null {
  try {
    operation();
    return null;
  } catch (error) {
    return error instanceof ZeusStorageWriteFaultError ? `${error.code}:${error.fault.kind}` : error instanceof Error ? `${error.name}:${error.message}` : String(error);
  }
}

function assertProbe(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Artifact 行为探针失败：${message}`);
}
