/* global fetch, console */
import { Buffer } from 'node:buffer';
import { performance } from 'node:perf_hooks';
import process from 'node:process';

const baseUrl = requiredEnvironment('ZEUS_PROBE_BASE_URL').replace(/\/$/u, '');
const apiToken = requiredEnvironment('ZEUS_PROBE_API_TOKEN');
const authorization = { Authorization: `Bearer ${apiToken}` };

const projectsResult = await fetchJson('/api/projects');
const projects = projectsResult.body;
const conversations = [];
const choiceCounts = {};
for (const project of projects) {
  const choicesResult = await fetchJson(`/api/projects/${encodeURIComponent(project.id)}/conversation-choices`);
  const choices = choicesResult.body.choices ?? [];
  choiceCounts[project.name] = choices.length;
  for (const choice of choices) conversations.push({ project, choice });
}

const firstPass = [];
for (const entry of conversations) firstPass.push(await readSnapshot(entry));
const secondPass = [];
for (const entry of conversations) secondPass.push(await readSnapshot(entry));

const successful = firstPass.filter((entry) => entry.status === 200);
if (successful.length !== conversations.length) {
  throw new Error(`Snapshot V2 未全量成功：${successful.length}/${conversations.length}`);
}
const largest = [...successful].sort((left, right) => right.bytes - left.bytes)[0];
if (!largest) throw new Error('真实历史中没有可验收会话。');

const prefix = `/api/projects/${encodeURIComponent(largest.projectId)}/conversations/${encodeURIComponent(largest.conversationId)}`;
const timeline = await fetchJson(`${prefix}/timeline?limit=100&byteLimit=1048576`);
const modelHistory = await fetchJson(`${prefix}/model-history?direction=tail&limit=100&byteLimit=1048576`);
const turnCandidates = [largest.body.activeTurn, ...(largest.body.recentClosedTurns ?? [])].filter(Boolean);
const processTurn = [...turnCandidates].sort((left, right) => Number(right.process?.latestSequence ?? 0) - Number(left.process?.latestSequence ?? 0))[0];
const processPage = processTurn ? await fetchJson(`${prefix}/turns/${encodeURIComponent(processTurn.id)}/process?limit=100&byteLimit=1048576`) : null;
const resources = await fetchJson(`${prefix}/resources/page?limit=100&byteLimit=1048576`);
const memory = await fetchJson('/api/memory?limit=100');
const resolvedMemory = await fetchJson(`/api/memory/resolved?projectId=${encodeURIComponent(largest.projectId)}`);
const mutation = await fetch(`${baseUrl}/api/memory/candidates`, {
  method: 'POST',
  headers: { ...authorization, 'content-type': 'application/json' },
  body: '{}',
});
const mutationBody = await mutation.json().catch(() => ({}));

const repetitions = 100;
const hotProjects = await measureRepeated('/api/projects', repetitions);
const hotChoices = await measureRepeated(`/api/projects/${encodeURIComponent(largest.projectId)}/conversation-choices`, repetitions);
const hotSnapshot = await measureRepeated(`${prefix}/snapshot-v2`, repetitions, { 'x-zeus-snapshot-caller': 'renderer-session-v2' });
const hotTimeline = await measureRepeated(`${prefix}/timeline?limit=100&byteLimit=1048576`, repetitions);

console.log(
  JSON.stringify(
    {
      status: 'passed',
      projectCount: projects.length,
      conversationCount: conversations.length,
      choiceCounts,
      readOnlyChoiceContract: {
        allReadOnly: conversations.every(({ choice }) => choice.readOnly === true),
        allNonResumable: conversations.every(({ choice }) => choice.resumable === false),
        providerUnavailable: conversations.every(({ choice }) => choice.agent?.supportStatus === 'unavailable'),
      },
      snapshotV2: {
        firstPassStatus200: successful.length,
        secondPassStatus200: secondPass.filter((entry) => entry.status === 200).length,
        firstPassLatencyMs: percentiles(firstPass.map((entry) => entry.durationMs)),
        secondPassLatencyMs: percentiles(secondPass.map((entry) => entry.durationMs)),
        largest: {
          projectId: largest.projectId,
          conversationId: largest.conversationId,
          title: largest.title,
          bytes: largest.bytes,
          responseBytesClaim: largest.body.limits?.responseBytes ?? null,
          returnedTurnCount: largest.body.limits?.returnedTurnCount ?? null,
          activeProcessSequence: largest.body.activeTurn?.process?.latestSequence ?? null,
          modelHistorySequence: largest.body.collections?.modelHistory?.throughSequence ?? null,
          resourcesAvailable: largest.body.collections?.resources?.available ?? false,
        },
      },
      pagination: {
        timeline: pageSummary(timeline),
        modelHistory: pageSummary(modelHistory),
        process: processPage ? pageSummary(processPage) : null,
        resources: pageSummary(resources),
      },
      memory: {
        listStatus: memory.status,
        list: pageSummary(memory),
        resolvedStatus: resolvedMemory.status,
        resolvedBytes: resolvedMemory.bytes,
      },
      writeFence: {
        status: mutation.status,
        code: mutationBody.code ?? mutationBody.error ?? null,
      },
      hotLatencyMs: {
        projects: hotProjects,
        conversationChoices: hotChoices,
        snapshotV2: hotSnapshot,
        timeline: hotTimeline,
      },
    },
    null,
    2,
  ),
);

async function readSnapshot({ project, choice }) {
  const result = await fetchJson(`/api/projects/${encodeURIComponent(project.id)}/conversations/${encodeURIComponent(choice.id)}/snapshot-v2`, {
    'x-zeus-snapshot-caller': 'renderer-session-v2',
  });
  return { ...result, projectId: project.id, conversationId: choice.id, title: choice.title };
}

async function measureRepeated(path, count, extraHeaders = {}) {
  const measurements = [];
  for (let index = 0; index < count; index += 1) {
    const result = await fetchJson(path, extraHeaders);
    if (result.status !== 200) throw new Error(`性能探针请求失败：${path} status=${result.status}`);
    measurements.push(result.durationMs);
  }
  return percentiles(measurements);
}

async function fetchJson(path, extraHeaders = {}) {
  const startedAt = performance.now();
  const response = await fetch(`${baseUrl}${path}`, { headers: { ...authorization, ...extraHeaders } });
  const text = await response.text();
  const durationMs = performance.now() - startedAt;
  let body;
  try {
    body = JSON.parse(text);
  } catch (error) {
    throw new Error(`接口没有返回 JSON：${path}`, { cause: error });
  }
  return { status: response.status, body, bytes: Buffer.byteLength(text), durationMs };
}

function pageSummary(result) {
  const body = result.body;
  const items = Array.isArray(body) ? body : Array.isArray(body.items) ? body.items : Array.isArray(body.records) ? body.records : Array.isArray(body.entries) ? body.entries : [];
  return {
    status: result.status,
    bytes: result.bytes,
    itemCount: items.length,
    hasNextCursor: Boolean(body.nextCursor),
    keys: body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body).sort() : [],
  };
}

function percentiles(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    samples: sorted.length,
    min: rounded(sorted[0] ?? 0),
    p50: rounded(atPercentile(sorted, 0.5)),
    p95: rounded(atPercentile(sorted, 0.95)),
    p99: rounded(atPercentile(sorted, 0.99)),
    max: rounded(sorted.at(-1) ?? 0),
  };
}

function atPercentile(sorted, percentile) {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * percentile) - 1))] ?? 0;
}

function rounded(value) {
  return Math.round(value * 1_000) / 1_000;
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`缺少环境变量：${name}`);
  return value;
}
