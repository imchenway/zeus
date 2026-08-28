export const commandEnvelopeSchemaGeneration = 'zeus-command-envelope-v1';
export const maximumCommandEnvelopePayloadBytes = 1024 * 1024;
const performanceTraceIdentityPattern = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u;

export const commandActorKinds = ['user', 'system', 'local_api', 'remote_control', 'worker'] as const;
export type CommandActorKind = (typeof commandActorKinds)[number];

export const commandScopeKinds = [
  'project',
  'task',
  'task_workspace',
  'task_integration',
  'product_conversation',
  'submission',
  'turn',
  'runtime_segment',
  'approval',
  'git_repository',
  'artifact',
  'memory',
  'command_definition',
  'command_run',
  'settings',
  'integration_account',
  'execution_host',
  'provider_account',
  'provider_remote_control',
  'provider_configuration',
  'provider_import',
] as const;
export type CommandScopeKind = (typeof commandScopeKinds)[number];

export interface CommandActor {
  kind: CommandActorKind;
  /** system 可为 null；其他 actor 必须保留稳定、非敏感身份。 */
  id: string | null;
}

export interface CommandTargetScope {
  kind: CommandScopeKind;
  id: string;
}

export interface CommandEnvelope<TPayload extends Record<string, unknown> = Record<string, unknown>> {
  schemaGeneration: typeof commandEnvelopeSchemaGeneration;
  commandId: string;
  commandType: string;
  actor: CommandActor;
  scope: CommandTargetScope;
  /** create 或没有 revision 的事实使用 null；字段本身不可省略。 */
  expectedRevision: number | null;
  idempotencyKey: string;
  issuedAt: string;
  /**
   * 可选、无正文的短期性能关联身份。旧版信封允许缺失；null 表示命令不属于 HTTP/Renderer trace。
   * 它不能替代 commandId、Provider requestId 或任何业务幂等身份。
   */
  traceIdentity?: string | null;
  payload: TPayload;
}

export type CommandEnvelopeErrorCode = 'ZEUS_COMMAND_ENVELOPE_INVALID' | 'ZEUS_COMMAND_ENVELOPE_SCHEMA_MISMATCH' | 'ZEUS_COMMAND_EXPECTED_REVISION_CONFLICT' | 'ZEUS_DOMAIN_STATE_TRANSITION_REJECTED';

export class CommandEnvelopeError extends Error {
  readonly name = 'CommandEnvelopeError';

  constructor(
    readonly code: CommandEnvelopeErrorCode,
    message: string,
    readonly details: Readonly<Record<string, string | number | boolean | null>> = {},
  ) {
    super(message);
  }
}

/** 在 HTTP/IPC 边界拒绝缺失 actor、scope、revision 或幂等身份的副作用命令。 */
export function parseCommandEnvelope<TPayload extends Record<string, unknown> = Record<string, unknown>>(value: unknown): CommandEnvelope<TPayload> {
  if (!isPlainRecord(value)) throw invalidEnvelope('Command envelope must be an object.', { field: '$' });
  if (value.schemaGeneration !== commandEnvelopeSchemaGeneration) {
    throw new CommandEnvelopeError('ZEUS_COMMAND_ENVELOPE_SCHEMA_MISMATCH', 'Command envelope schema generation is unsupported.', {
      expected: commandEnvelopeSchemaGeneration,
      actual: typeof value.schemaGeneration === 'string' ? value.schemaGeneration : null,
    });
  }
  const commandId = boundedIdentity(value.commandId, 'commandId', 256);
  const commandType = boundedIdentity(value.commandType, 'commandType', 128);
  if (!/^[a-z][a-z0-9_.-]*$/u.test(commandType)) throw invalidEnvelope('commandType must use a stable lowercase namespace.', { field: 'commandType' });
  const idempotencyKey = boundedIdentity(value.idempotencyKey, 'idempotencyKey', 512);
  const issuedAt = validTimestamp(value.issuedAt, 'issuedAt');
  const traceIdentity = parseOptionalTraceIdentity(value.traceIdentity);
  const expectedRevision = nullableRevision(value.expectedRevision);
  const actor = parseActor(value.actor);
  const scope = parseScope(value.scope);
  if (!isPlainRecord(value.payload)) throw invalidEnvelope('payload must be a plain object.', { field: 'payload' });
  assertJsonValue(value.payload, '$.payload', new Set(), 0);
  const payloadBytes = new TextEncoder().encode(JSON.stringify(value.payload)).byteLength;
  if (payloadBytes > maximumCommandEnvelopePayloadBytes) {
    throw invalidEnvelope('payload exceeds the command envelope byte budget; use an ArtifactRef.', {
      field: 'payload',
      payloadBytes,
      maximumBytes: maximumCommandEnvelopePayloadBytes,
    });
  }
  return {
    schemaGeneration: commandEnvelopeSchemaGeneration,
    commandId,
    commandType,
    actor,
    scope,
    expectedRevision,
    idempotencyKey,
    issuedAt,
    ...(traceIdentity === undefined ? {} : { traceIdentity }),
    payload: value.payload as TPayload,
  };
}

export function parsePerformanceTraceIdentity(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const normalized = normalizePerformanceTraceIdentity(value);
  if (!normalized) {
    throw invalidEnvelope('traceIdentity must be null, a UUID, or a 32-character hexadecimal identity.', { field: 'traceIdentity' });
  }
  return normalized;
}

export function normalizePerformanceTraceIdentity(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.toLowerCase();
  return performanceTraceIdentityPattern.test(normalized) ? normalized : null;
}

export function isPerformanceTraceIdentity(value: unknown): value is string {
  return typeof value === 'string' && performanceTraceIdentityPattern.test(value);
}

function parseOptionalTraceIdentity(value: unknown): string | null | undefined {
  return value === undefined ? undefined : parsePerformanceTraceIdentity(value);
}

export function assertExpectedRevision(currentRevision: number, expectedRevision: number | null, scope: CommandTargetScope): void {
  if (!Number.isSafeInteger(currentRevision) || currentRevision < 0) throw invalidEnvelope('Current revision must be a non-negative safe integer.', { field: 'currentRevision' });
  if (expectedRevision === null || currentRevision === expectedRevision) return;
  throw new CommandEnvelopeError('ZEUS_COMMAND_EXPECTED_REVISION_CONFLICT', 'Command expected revision is stale.', {
    scopeKind: scope.kind,
    scopeId: scope.id,
    expectedRevision,
    currentRevision,
  });
}

/**
 * Command 正文摘要的跨 Node/Renderer 规范化形式。正文与 Envelope 分离后，两端必须使用
 * 同一个 JSON 规则；对象键排序、对象 undefined 省略、数组 undefined 归一为 null。
 */
export function canonicalCommandInputJson(value: unknown): string {
  return JSON.stringify(canonicalCommandInputValue(value, new Set(), 0));
}

export interface DomainStateMachine<TState extends string> {
  name: string;
  states: readonly TState[];
  transitions: Readonly<Record<TState, readonly TState[]>>;
  terminalStates: readonly TState[];
}

/** 状态机定义本身也被完整校验，避免遗漏状态被运行时默认放行。 */
export function defineDomainStateMachine<TState extends string>(machine: DomainStateMachine<TState>): DomainStateMachine<TState> {
  const states = new Set(machine.states);
  if (!machine.name.trim() || states.size !== machine.states.length || states.size === 0) throw invalidEnvelope('Domain state machine has invalid or duplicate states.', { machine: machine.name || null });
  for (const state of machine.states) {
    const targets = machine.transitions[state];
    if (!Array.isArray(targets)) throw invalidEnvelope('Domain state machine omits a transition set.', { machine: machine.name, state });
    if (new Set(targets).size !== targets.length || targets.some((target) => !states.has(target))) {
      throw invalidEnvelope('Domain state machine contains an unknown or duplicate target.', { machine: machine.name, state });
    }
  }
  if (machine.terminalStates.some((state) => !states.has(state) || machine.transitions[state].length > 0)) {
    throw invalidEnvelope('Terminal states must exist and have no outgoing transitions.', { machine: machine.name });
  }
  return Object.freeze(machine);
}

export function assertDomainStateTransition<TState extends string>(machine: DomainStateMachine<TState>, from: TState, to: TState): void {
  if (from === to || machine.transitions[from]?.includes(to)) return;
  throw new CommandEnvelopeError('ZEUS_DOMAIN_STATE_TRANSITION_REJECTED', `${machine.name} state transition is not allowed.`, {
    machine: machine.name,
    from,
    to,
  });
}

function parseActor(value: unknown): CommandActor {
  if (!isPlainRecord(value) || !commandActorKinds.includes(value.kind as CommandActorKind)) throw invalidEnvelope('actor.kind is invalid.', { field: 'actor.kind' });
  const kind = value.kind as CommandActorKind;
  const id = value.id === null ? null : boundedIdentity(value.id, 'actor.id', 256);
  if (kind !== 'system' && id === null) throw invalidEnvelope('Non-system actors require a stable id.', { field: 'actor.id' });
  return { kind, id };
}

function parseScope(value: unknown): CommandTargetScope {
  if (!isPlainRecord(value) || !commandScopeKinds.includes(value.kind as CommandScopeKind)) throw invalidEnvelope('scope.kind is invalid.', { field: 'scope.kind' });
  return { kind: value.kind as CommandScopeKind, id: boundedIdentity(value.id, 'scope.id', 256) };
}

function nullableRevision(value: unknown): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw invalidEnvelope('expectedRevision must be null or a non-negative safe integer.', { field: 'expectedRevision' });
  return value as number;
}

function boundedIdentity(value: unknown, field: string, maximumLength: number): string {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0 || value.length > maximumLength || Array.from(value).some(isControlCharacter)) {
    throw invalidEnvelope(`${field} is invalid.`, { field, maximumLength });
  }
  return value;
}

function isControlCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0) ?? 0;
  return codePoint <= 31 || codePoint === 127;
}

function validTimestamp(value: unknown, field: string): string {
  const timestamp = boundedIdentity(value, field, 64);
  if (Number.isNaN(Date.parse(timestamp))) throw invalidEnvelope(`${field} must be a valid timestamp.`, { field });
  return timestamp;
}

function assertJsonValue(value: unknown, path: string, stack: Set<object>, depth: number): void {
  if (depth > 32) throw invalidEnvelope('payload exceeds the nesting budget.', { field: path });
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalidEnvelope('payload contains a non-finite number.', { field: path });
    return;
  }
  if (typeof value !== 'object') throw invalidEnvelope('payload contains a non-JSON value.', { field: path, valueType: typeof value });
  if (stack.has(value)) throw invalidEnvelope('payload contains a circular reference.', { field: path });
  stack.add(value);
  try {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => assertJsonValue(entry, `${path}[${index}]`, stack, depth + 1));
      return;
    }
    if (!isPlainRecord(value)) throw invalidEnvelope('payload contains a non-plain object.', { field: path });
    Object.entries(value).forEach(([key, entry]) => assertJsonValue(entry, `${path}.${key}`, stack, depth + 1));
  } finally {
    stack.delete(value);
  }
}

function canonicalCommandInputValue(value: unknown, stack: Set<object>, depth: number): unknown {
  if (depth > 32) throw invalidEnvelope('Command input exceeds the nesting budget.', { field: '$' });
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalidEnvelope('Command input contains a non-finite number.', { field: '$' });
    return value;
  }
  if (!value || typeof value !== 'object') throw invalidEnvelope('Command input must contain JSON data.', { field: '$' });
  if (stack.has(value)) throw invalidEnvelope('Command input contains a circular reference.', { field: '$' });
  stack.add(value);
  try {
    if (Array.isArray(value)) return value.map((entry) => (entry === undefined ? null : canonicalCommandInputValue(entry, stack, depth + 1)));
    if (!isPlainRecord(value)) throw invalidEnvelope('Command input must use plain JSON objects.', { field: '$' });
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const entry = value[key];
      if (entry !== undefined) result[key] = canonicalCommandInputValue(entry, stack, depth + 1);
    }
    return result;
  } finally {
    stack.delete(value);
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalidEnvelope(message: string, details: Readonly<Record<string, string | number | boolean | null>>): CommandEnvelopeError {
  return new CommandEnvelopeError('ZEUS_COMMAND_ENVELOPE_INVALID', message, details);
}
