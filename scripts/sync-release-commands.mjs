#!/usr/bin/env node
/* global AbortController, URL, clearTimeout, console, fetch, process, setTimeout */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { validateCommandDefinitionInput } from '../packages/shared/dist/index.js';
import { parseBoolean } from './release-script-utils.mjs';

const repositoryRoot = resolve(import.meta.dirname, '..');
const manifestPath = join(import.meta.dirname, 'zeus-release-command-definitions.json');
const expectedCommandNames = ['zeus-release'];
const legacyCommandNames = ['zeus-release-notes', 'zeus-release-prepare', 'zeus-release-gate', 'zeus-release-publish'];

main().catch((error) => {
  console.error(redactError(error));
  process.exitCode = 1;
});

async function main() {
  const manifest = readManifest();
  const validateOnly = parseBoolean('VALIDATE_ONLY', process.env.VALIDATE_ONLY, false);
  const applyCommands = parseBoolean('APPLY_COMMANDS', process.env.APPLY_COMMANDS, false);
  const outputDirectory = resolveOutputDirectory();
  mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });

  if (validateOnly) {
    if (applyCommands) throw new Error('VALIDATE_ONLY=true 时不能同时设置 APPLY_COMMANDS=true。');
    const reportPath = join(outputDirectory, 'Zeus-release-command-definitions-validation.md');
    writeFileSync(reportPath, buildValidationReport(manifest), { mode: 0o600 });
    console.log(`一键发布命令定义验证通过：${reportPath}`);
    console.log(`ZEUS_ARTIFACT_FILE=${reportPath}`);
    return;
  }

  const apiBaseUrl = requiredLoopbackBaseUrl(process.env.ZEUS_API_BASE_URL);
  const apiToken = requiredSecret(process.env.ZEUS_API_TOKEN, 'ZEUS_API_TOKEN');
  const projectId = requiredValue(process.env.ZEUS_PROJECT_ID, 'ZEUS_PROJECT_ID');
  const api = createApiClient(apiBaseUrl, apiToken);

  const health = await api.get('/health', false);
  if (health?.ok !== true || health?.app !== 'Zeus') {
    throw new Error('目标地址没有返回可确认的 Zeus 健康状态，拒绝同步命令。');
  }

  const project = await api.get(`/api/projects/${encodeURIComponent(projectId)}`);
  assertMatchingProject(project, projectId);
  const currentCommands = await api.get(`/api/projects/${encodeURIComponent(projectId)}/commands`);
  if (!Array.isArray(currentCommands)) throw new Error('Zeus 命令列表响应格式无效。');

  const plan = buildSyncPlan(manifest.commands, currentCommands, projectId);
  const planPath = join(outputDirectory, `Zeus-release-command-sync-${applyCommands ? 'result' : 'plan'}.md`);

  if (plan.blockers.length > 0) {
    writeFileSync(planPath, buildPlanReport({ apiBaseUrl, project, applyCommands, plan, result: '已阻断，未写入' }), { mode: 0o600 });
    console.log(`命令同步存在阻断项：${planPath}`);
    console.log(`ZEUS_ARTIFACT_FILE=${planPath}`);
    throw new Error(`命令同步被 ${plan.blockers.length} 个冲突阻断；未修改 Zeus 命令定义。`);
  }

  if (!applyCommands) {
    writeFileSync(planPath, buildPlanReport({ apiBaseUrl, project, applyCommands, plan, result: '只读预览，未写入' }), { mode: 0o600 });
    console.log(`命令同步计划已生成：${planPath}`);
    console.log(`待创建 ${plan.creates.length} 条、更新 ${plan.updates.length} 条、移除旧命令 ${plan.deletes.length} 条、保持 ${plan.unchanged.length} 条。`);
    console.log(`ZEUS_ARTIFACT_FILE=${planPath}`);
    return;
  }

  const expectedConfirmation = `SYNC_RELEASE_COMMANDS_${projectId}`;
  if (process.env.SYNC_CONFIRMATION?.trim() !== expectedConfirmation) {
    throw new Error(`真实同步必须设置 SYNC_CONFIRMATION=${expectedConfirmation}。`);
  }

  for (const action of plan.creates) {
    await api.post(`/api/projects/${encodeURIComponent(projectId)}/commands`, action.definition);
  }
  for (const action of plan.updates) {
    await api.patch(`/api/projects/${encodeURIComponent(projectId)}/commands/${encodeURIComponent(action.commandId)}`, action.definition);
  }
  for (const action of plan.deletes) {
    await api.delete(`/api/projects/${encodeURIComponent(projectId)}/commands/${encodeURIComponent(action.commandId)}`);
  }

  const commandsAfter = await api.get(`/api/projects/${encodeURIComponent(projectId)}/commands`);
  if (!Array.isArray(commandsAfter)) throw new Error('同步后 Zeus 命令列表响应格式无效。');
  const verification = buildSyncPlan(manifest.commands, commandsAfter, projectId);
  if (verification.blockers.length > 0 || verification.creates.length > 0 || verification.updates.length > 0 || verification.deletes.length > 0) {
    throw new Error('同步请求已返回，但回读结果与声明文件不一致；请保留现场后重新执行只读预览。');
  }

  writeFileSync(
    planPath,
    buildPlanReport({
      apiBaseUrl,
      project,
      applyCommands,
      plan,
      result: `同步并回读通过：创建 ${plan.creates.length} 条，更新 ${plan.updates.length} 条，移除旧命令 ${plan.deletes.length} 条，保持 ${plan.unchanged.length} 条`,
    }),
    { mode: 0o600 },
  );
  console.log(`一键发布命令已同步并回读验证：${planPath}`);
  console.log(`ZEUS_ARTIFACT_FILE=${planPath}`);
}

function readManifest() {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || !Array.isArray(manifest.commands)) {
    throw new Error(`命令声明文件格式无效：${manifestPath}`);
  }
  if (typeof manifest.purpose !== 'string' || !manifest.purpose.trim()) throw new Error('命令声明文件缺少 purpose。');
  const actualNames = manifest.commands.map((command) => command?.name).sort();
  if (!isDeepStrictEqual(actualNames, [...expectedCommandNames].sort())) {
    throw new Error(`命令声明文件必须且只能包含：${expectedCommandNames.join('、')}。`);
  }

  const desiredTokens = new Set();
  for (const command of manifest.commands) {
    const issues = validateCommandDefinitionInput(command);
    if (issues.length > 0) {
      throw new Error(`命令 ${command?.name ?? '（未命名）'} 定义无效：${issues.map((issue) => `${issue.field}: ${issue.message}`).join('；')}`);
    }
    if (command.enabled !== true || command.telegramEnabled !== false) {
      throw new Error(`命令 ${command.name} 必须启用桌面执行并关闭 Telegram。`);
    }
    if (!hasCompleteRiskFlags(command.riskFlags)) throw new Error(`命令 ${command.name} 必须显式声明三类风险。`);
    for (const token of [command.name, ...(command.aliases ?? [])]) {
      const normalized = normalizeToken(token);
      if (desiredTokens.has(normalized)) throw new Error(`声明文件内名称或别名重复：${token}`);
      desiredTokens.add(normalized);
    }
  }
  return { purpose: manifest.purpose.trim(), commands: manifest.commands.map(toDefinitionInput) };
}

function hasCompleteRiskFlags(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && typeof value.gitWrite === 'boolean' && typeof value.outsideProjectWrite === 'boolean' && typeof value.externalServiceWrite === 'boolean';
}

function toDefinitionInput(command) {
  return {
    name: command.name.trim(),
    aliases: (command.aliases ?? []).map((alias) => alias.trim()),
    title: command.title.trim(),
    description: command.description?.trim() ?? '',
    command: command.command.trim(),
    parameters: command.parameters ?? [],
    timeoutSeconds: command.timeoutSeconds ?? 300,
    enabled: command.enabled ?? true,
    telegramEnabled: command.telegramEnabled ?? false,
    riskFlags: {
      gitWrite: command.riskFlags?.gitWrite ?? false,
      outsideProjectWrite: command.riskFlags?.outsideProjectWrite ?? false,
      externalServiceWrite: command.riskFlags?.externalServiceWrite ?? false,
    },
  };
}

function buildSyncPlan(definitions, currentCommands, projectId) {
  const creates = [];
  const updates = [];
  const unchanged = [];
  const deletes = [];
  const blockers = [];

  for (const definition of definitions) {
    const existing = currentCommands.find((command) => command.scope === 'project' && command.projectId === projectId && normalizeToken(command.name) === normalizeToken(definition.name));
    const desiredTokens = new Set([definition.name, ...(definition.aliases ?? [])].map(normalizeToken));
    const conflicts = currentCommands.filter((command) => {
      if (existing && command.id === existing.id) return false;
      return [command.name, ...(command.aliases ?? [])].some((token) => desiredTokens.has(normalizeToken(token)));
    });

    if (conflicts.length > 0) {
      blockers.push({
        name: definition.name,
        reason: conflicts.map((command) => `${command.scope}:${command.name} (${command.id})`).join('、'),
      });
      continue;
    }
    if (!existing) {
      creates.push({ name: definition.name, definition });
      continue;
    }
    if (isDeepStrictEqual(toDefinitionInput(existing), definition)) {
      unchanged.push({ name: definition.name, commandId: existing.id });
    } else {
      updates.push({ name: definition.name, commandId: existing.id, definition });
    }
  }
  for (const command of currentCommands) {
    if (command.scope !== 'project' || command.projectId !== projectId) continue;
    if (legacyCommandNames.includes(normalizeToken(command.name)))
      deletes.push({
        name: command.name,
        commandId: command.id,
      });
  }
  return { creates, updates, unchanged, deletes, blockers };
}

function assertMatchingProject(project, projectId) {
  if (!project || typeof project !== 'object' || project.id !== projectId || typeof project.localPath !== 'string') {
    throw new Error('ZEUS_PROJECT_ID 对应的项目响应格式无效。');
  }
  if (project.archivedAt) throw new Error('目标 Zeus 项目已归档，拒绝同步命令。');
  if (!existsSync(project.localPath)) throw new Error(`目标 Zeus 项目目录不存在：${project.localPath}`);
  const actualProjectRoot = realpathSync(project.localPath);
  const expectedProjectRoot = realpathSync(repositoryRoot);
  if (actualProjectRoot !== expectedProjectRoot) {
    throw new Error(`目标 Zeus 项目不是当前仓库：expected=${expectedProjectRoot} actual=${actualProjectRoot}`);
  }
}

function createApiClient(baseUrl, token) {
  async function request(method, path, body, authorized = true) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(new URL(path, baseUrl), {
        method,
        headers: {
          ...(authorized ? { authorization: `Bearer ${token}` } : {}),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const code = typeof payload?.error === 'string' ? payload.error : `HTTP_${response.status}`;
        const message = typeof payload?.message === 'string' ? payload.message : response.statusText;
        throw new Error(`Zeus API 请求失败：${method} ${path}，${code}，${message}`);
      }
      return payload;
    } finally {
      clearTimeout(timeout);
    }
  }
  return {
    get: (path, authorized = true) => request('GET', path, undefined, authorized),
    post: (path, body) => request('POST', path, body),
    patch: (path, body) => request('PATCH', path, body),
    delete: (path) => request('DELETE', path),
  };
}

function buildValidationReport(manifest) {
  return [
    '# Zeus 发布命令声明验证',
    '',
    `- 用途：${manifest.purpose}`,
    `- 声明文件：${manifestPath}`,
    `- 命令数量：${manifest.commands.length}`,
    '- Zeus 命令定义校验：通过。',
    '- 名称与别名内部冲突检查：通过。',
    '- 本次模式：仅验证声明文件，没有连接或修改 Zeus 运行数据。',
    '',
    '## 命令',
    '',
    ...manifest.commands.map((command) => `- \`${command.name}\` → \`${command.command}\``),
    '',
  ].join('\n');
}

function buildPlanReport(input) {
  return [
    `# Zeus 发布命令同步${input.applyCommands ? '结果' : '计划'}`,
    '',
    '## 目标',
    '',
    `- Zeus API：${input.apiBaseUrl}`,
    `- 项目：${input.project.name ?? input.project.id}`,
    `- 项目 ID：${input.project.id}`,
    `- 项目目录：${input.project.localPath}`,
    '- API token：已提供但未写入报告。',
    '',
    '## 结果',
    '',
    `- ${input.result}`,
    `- 待创建：${formatNames(input.plan.creates)}`,
    `- 待更新：${formatNames(input.plan.updates)}`,
    `- 待移除旧命令：${formatNames(input.plan.deletes)}`,
    `- 无需改变：${formatNames(input.plan.unchanged)}`,
    `- 阻断冲突：${input.plan.blockers.length === 0 ? '无' : input.plan.blockers.map((item) => `${item.name} ← ${item.reason}`).join('；')}`,
    '',
    '## 安全边界',
    '',
    '- 只创建或更新声明文件中的一条项目命令，并软删除四个精确命名的旧发布阶段命令；不创建全局命令。',
    '- 不删除其他未声明命令，不修改项目 Shell 或 Git 写入权限。',
    '- 真实同步要求显式开启 APPLY_COMMANDS，并提供绑定项目 ID 的确认值。',
    '- 任一名称或别名冲突会在写入前阻断；网络中断后的重试依赖幂等回读，不执行破坏性回滚。',
    '',
  ].join('\n');
}

function formatNames(actions) {
  return actions.length === 0 ? '无' : actions.map((action) => `\`${action.name}\``).join('、');
}

function requiredLoopbackBaseUrl(rawValue) {
  const value = requiredValue(rawValue, 'ZEUS_API_BASE_URL');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('ZEUS_API_BASE_URL 必须是有效 URL。');
  }
  const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
  if (url.protocol !== 'http:' || !loopbackHosts.has(url.hostname) || !url.port || url.username || url.password || url.search || url.hash) {
    throw new Error('ZEUS_API_BASE_URL 只接受带端口的本机 HTTP 地址，例如 http://127.0.0.1:43123。');
  }
  url.pathname = '/';
  return url.href;
}

function requiredValue(rawValue, name) {
  const value = rawValue?.trim() ?? '';
  if (!value) throw new Error(`${name} 为必填项。`);
  return value;
}

function requiredSecret(rawValue, name) {
  const value = requiredValue(rawValue, name);
  if (value.length < 16) throw new Error(`${name} 格式无效。`);
  return value;
}

function resolveOutputDirectory() {
  const commandRunDirectory = process.env.ZEUS_COMMAND_RUN_DIR?.trim();
  return commandRunDirectory ? resolve(commandRunDirectory) : mkdtempSync(join(tmpdir(), 'zeus-release-command-sync-'));
}

function normalizeToken(value) {
  return String(value ?? '')
    .trim()
    .toLocaleLowerCase();
}

function redactError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const token = process.env.ZEUS_API_TOKEN?.trim();
  return token ? message.split(token).join('[REDACTED]') : message;
}
