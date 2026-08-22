import { resolve } from 'node:path';
import { ColdEvidenceRepository, createZeusDatabase } from '../packages/storage/src/index.js';
import { ContextSourceCatalog } from '../packages/local-server/src/contextSourceCatalog.js';

const databasePath = resolve(requiredEnvironment('ZEUS_PROBE_DATABASE_PATH'));
const providerRoot = resolve(requiredEnvironment('ZEUS_PROBE_PROVIDER_ROOT'));
const relativePath = requiredEnvironment('ZEUS_PROBE_PROVIDER_RELATIVE_PATH');
const projectId = requiredEnvironment('ZEUS_PROBE_PROJECT_ID');
const taskCode = requiredEnvironment('ZEUS_PROBE_TASK_CODE');
const nativeSessionId = requiredEnvironment('ZEUS_PROBE_NATIVE_SESSION_ID');
const providerId = process.env.ZEUS_PROBE_PROVIDER_ID?.trim() || 'pi';
const database = await createZeusDatabase(databasePath);

try {
  const evidence = new ColdEvidenceRepository(database);
  const catalog = new ContextSourceCatalog([{ id: 'zarch-pi-provider', path: providerRoot, owner: 'provider' }], evidence, (source) => source.projectId === projectId && source.nativeSessionId === nativeSessionId);
  const source = await catalog.indexJsonl({
    rootId: 'zarch-pi-provider',
    relativePath,
    kind: 'provider_history',
    projectId,
    taskCode,
    providerId,
    nativeSessionId,
    summary: 'ZARCH 隔离 Zeus Test 的真实 Pi Provider 会话文件。',
    indexedAt: new Date().toISOString(),
  });
  const page = await catalog.readColdEvidencePage({ sourceId: source.id, limit: 100, maximumBytes: 1024 * 1024 });
  const records = page.entries.map((entry) => JSON.parse(entry.text) as Record<string, unknown>);
  const messages = records
    .filter((record) => record.type === 'message')
    .map((record) => record.message)
    .filter(isRecord);
  const assistantText = messages
    .filter((message) => message.role === 'assistant')
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .filter(isRecord)
    .filter((content) => content.type === 'text' && typeof content.text === 'string')
    .map((content) => content.text as string)
    .at(-1);
  if (source.status !== 'ready' || source.nativeSessionId !== nativeSessionId || assistantText !== 'ZARCH-ISOLATED-PI-OK') {
    throw new Error('真实 Pi Provider 文件没有形成可按原生会话身份读取的完整冷证据。');
  }
  console.log(
    JSON.stringify(
      {
        status: 'passed',
        source: {
          id: source.id,
          kind: source.kind,
          projectId: source.projectId,
          taskCode: source.taskCode,
          providerId: source.providerId,
          nativeSessionId: source.nativeSessionId,
          sourceByteLength: source.sourceByteLength,
          indexedThroughByte: source.indexedThroughByte,
          indexedPrefixSha256: source.indexedPrefixSha256,
        },
        page: {
          entries: page.entries.length,
          hasMore: page.hasMore,
          nextOrdinal: page.nextOrdinal,
          returnedBytes: page.returnedBytes,
          eventKinds: page.entries.map((entry) => entry.anchor.eventKind),
          assistantReply: assistantText,
        },
      },
      null,
      2,
    ),
  );
} finally {
  await database.close();
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`缺少环境变量：${name}`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
