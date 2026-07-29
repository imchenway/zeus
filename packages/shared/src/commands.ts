/** 命令中心只描述用户脚本的通用执行契约，不包含 Git、微信等产品内置业务类型。 */
export type CommandScope = 'global' | 'project';

export type CommandParameterType = 'string' | 'number' | 'boolean';

export interface CommandParameterDefinition {
  key: string;
  label: string;
  description: string;
  type: CommandParameterType;
  required: boolean;
  sensitive: boolean;
  defaultValue?: string | number | boolean;
}

export interface CommandRiskFlags {
  gitWrite: boolean;
  outsideProjectWrite: boolean;
  externalServiceWrite: boolean;
}

export interface CommandDefinition {
  id: string;
  scope: CommandScope;
  projectId: string | null;
  name: string;
  aliases: string[];
  title: string;
  description: string;
  command: string;
  parameters: CommandParameterDefinition[];
  timeoutSeconds: number;
  enabled: boolean;
  telegramEnabled: boolean;
  riskFlags: CommandRiskFlags;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface CommandDefinitionInput {
  name: string;
  aliases?: string[];
  title: string;
  description?: string;
  command: string;
  parameters?: CommandParameterDefinition[];
  timeoutSeconds?: number;
  enabled?: boolean;
  telegramEnabled?: boolean;
  riskFlags?: Partial<CommandRiskFlags>;
}

export type CommandRunStatus = 'pending_confirmation' | 'running' | 'succeeded' | 'failed' | 'timed_out' | 'cancelled' | 'rejected';
export type CommandRunTrigger = 'desktop' | 'telegram';

export interface CommandRun {
  id: string;
  commandId: string | null;
  projectId: string;
  runtimeSessionId: string | null;
  trigger: CommandRunTrigger;
  status: CommandRunStatus;
  commandSnapshot: CommandDefinition;
  parameterSnapshot: Record<string, string | number | boolean>;
  cwd: string;
  timeoutSeconds: number;
  exitCode: number | null;
  failureReason: string | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CommandArtifact {
  id: string;
  runId: string;
  relativePath: string;
  absolutePath: string;
  mimeType: string | null;
  byteLength: number;
  createdAt: string;
}

export interface CommandConfirmation {
  id: string;
  commandId: string;
  projectId: string;
  commandRevision: number;
  cwd: string;
  parameterDigest: string;
  riskLevel: 'normal' | 'high';
  expiresAt: string;
}

export interface CommandValidationIssue {
  field: string;
  message: string;
}

export const commandNamePattern = /^[A-Za-z][A-Za-z0-9_-]{2,63}$/u;
export const commandAliasPattern = /^[A-Za-z][A-Za-z0-9_-]{1,63}$/u;
export const commandParameterKeyPattern = /^[A-Z][A-Z0-9_]{0,63}$/u;

export const defaultCommandRiskFlags: CommandRiskFlags = {
  gitWrite: false,
  outsideProjectWrite: false,
  externalServiceWrite: false,
};

export function commandNeedsHighRiskConfirmation(riskFlags: CommandRiskFlags): boolean {
  return riskFlags.gitWrite || riskFlags.outsideProjectWrite || riskFlags.externalServiceWrite;
}

/** 与 Vibego 命令定义限制保持一致，并补充 Zeus 声明式环境变量约束。 */
export function validateCommandDefinitionInput(input: CommandDefinitionInput): CommandValidationIssue[] {
  const issues: CommandValidationIssue[] = [];
  const name = input.name?.trim() ?? '';
  const aliases = (input.aliases ?? []).map((alias) => alias.trim());
  const title = input.title?.trim() ?? '';
  const description = input.description?.trim() ?? '';
  const command = input.command?.trim() ?? '';
  const timeoutSeconds = input.timeoutSeconds ?? 300;
  const parameters = input.parameters ?? [];

  if (!commandNamePattern.test(name)) {
    issues.push({field: 'name', message: '名称必须以字母开头，只能包含字母、数字、下划线或连字符，长度为 3–64。'});
  }
  if (aliases.length > 10) issues.push({field: 'aliases', message: '别名最多 10 个。'});
  const normalizedAliases = new Set<string>();
  for (const alias of aliases) {
    if (!commandAliasPattern.test(alias)) {
      issues.push({field: 'aliases', message: `别名 ${alias || '（空）'} 不符合格式要求。`});
      continue;
    }
    const normalized = alias.toLocaleLowerCase();
    if (normalized === name.toLocaleLowerCase()) issues.push({field: 'aliases', message: `别名 ${alias} 不能与命令名称相同。`});
    if (normalizedAliases.has(normalized)) issues.push({field: 'aliases', message: `别名 ${alias} 重复。`});
    normalizedAliases.add(normalized);
  }
  if (!title) issues.push({field: 'title', message: '标题不能为空。'});
  if (title.length > 80) issues.push({field: 'title', message: '标题最多 80 个字符。'});
  if (description.length > 400) issues.push({field: 'description', message: '说明最多 400 个字符。'});
  if (!command) issues.push({field: 'command', message: '命令不能为空。'});
  if (command.length > 1024) issues.push({field: 'command', message: '命令最多 1024 个字符。'});
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 5 || timeoutSeconds > 3600) {
    issues.push({field: 'timeoutSeconds', message: '超时必须是 5–3600 秒的整数。'});
  }

  const parameterKeys = new Set<string>();
  for (const parameter of parameters) {
    const key = parameter.key?.trim() ?? '';
    if (!commandParameterKeyPattern.test(key)) {
      issues.push({field: 'parameters', message: `参数 ${key || '（空）'} 必须使用大写环境变量格式。`});
    }
    if (key.startsWith('ZEUS_')) issues.push({field: 'parameters', message: `参数 ${key} 不能覆盖 ZEUS_* 保留变量。`});
    if (parameterKeys.has(key)) issues.push({field: 'parameters', message: `参数 ${key} 重复。`});
    parameterKeys.add(key);
    if (!parameter.label?.trim() || parameter.label.trim().length > 80) {
      issues.push({field: 'parameters', message: `参数 ${key || '（空）'} 的标签不能为空且最多 80 个字符。`});
    }
    if ((parameter.description?.trim() ?? '').length > 200) {
      issues.push({field: 'parameters', message: `参数 ${key || '（空）'} 的说明最多 200 个字符。`});
    }
    if (!['string', 'number', 'boolean'].includes(parameter.type)) {
      issues.push({field: 'parameters', message: `参数 ${key || '（空）'} 类型不受支持。`});
    }
    if (parameter.sensitive && parameter.defaultValue !== undefined) {
      issues.push({field: 'parameters', message: `敏感参数 ${key || '（空）'} 不能配置默认值。`});
    }
    if (parameter.defaultValue !== undefined && !commandParameterValueMatchesType(parameter.defaultValue, parameter.type)) {
      issues.push({field: 'parameters', message: `参数 ${key || '（空）'} 的默认值类型不匹配。`});
    }
  }
  return issues;
}

export function commandParameterValueMatchesType(value: unknown, type: CommandParameterType): value is string | number | boolean {
  if (type === 'string') return typeof value === 'string';
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === 'boolean';
}
