import type { CanonicalRequestUserInputQuestion } from '@zeus/shared';
import { validateCanonicalRequestUserInputAnswers } from '@zeus/shared';

/** 单次 ACP 决定。原生永久授权没有 Zeus 会话内授权的作用域。 */
export type AntigravityDecision = 'accept' | 'decline' | 'cancel';

/** agy 给出的操作证据，同时供工具过程和审批卡使用。 */
export interface AntigravityTool {
  toolName: string;
  kind: string;
  args: Record<string, unknown>;
  paths: string[];
  command?: string;
  cwd?: string;
}

/** 宿主在对应的原生请求上等待界面答复，delivered 表示该答复已写入 CLI。 */
export type AntigravityInteraction = ({ kind: 'permission'; tool: AntigravityTool; decisions: AntigravityDecision[] } | { kind: 'question'; questions: CanonicalRequestUserInputQuestion[] }) & { delivered: Promise<boolean> };

/** ACP 的部分更新只带变化字段。 */
export function acpRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** 保留命令的原始文字与换行，只用 trim 判断是否有内容。 */
function textField(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && Boolean(value.trim()));
}

/** 工具声明、权限请求与执行结果可能分开发送，共用原生调用身份合并。 */
export function mergeAcpTool(previous: Record<string, unknown> | undefined, update: Record<string, unknown>): Record<string, unknown> {
  const rawOutput = update.rawOutput;
  return {
    ...previous,
    ...update,
    rawInput: { ...acpRecord(previous?.rawInput), ...acpRecord(update.rawInput ?? update.args) },
    ...(rawOutput !== null && typeof rawOutput === 'object' && !Array.isArray(rawOutput) ? { rawOutput: { ...acpRecord(previous?.rawOutput), ...acpRecord(rawOutput) } } : {}),
  };
}

/** 路径来自工具参数、ACP 位置及编辑差异；命令标题仅用作名称。 */
export function readAcpTool(call: Record<string, unknown>): AntigravityTool {
  const args = acpRecord(call.rawInput);
  const paths = new Set<string>();
  const targets = [
    args.AbsolutePath,
    args.TargetFile,
    args.Path,
    args.path,
    args.FilePath,
    args.DirectoryPath,
    args.SearchPath,
    args.SourcePath,
    args.DestinationPath,
    args.SourceFile,
    args.DestinationFile,
    args.filePath,
    args.targetPath,
    args.sourcePath,
    args.destinationPath,
    ...(Array.isArray(call.locations) ? call.locations.map((item) => acpRecord(item).path) : []),
    ...(Array.isArray(call.content)
      ? call.content
          .map(acpRecord)
          .filter((item) => item.type === 'diff')
          .map((item) => item.path)
      : []),
  ];
  for (const target of targets) if (typeof target === 'string' && target.trim()) paths.add(target);
  return {
    toolName: textField(call.title, call.kind) ?? 'Antigravity',
    kind: textField(call.kind) ?? 'other',
    args,
    paths: [...paths],
    command: textField(args.CommandLine, args.commandLine, args.command_line, args.command),
    cwd: textField(args.Cwd, args.WorkingDirectory, args.working_dir, args.workingDir, args.cwd),
  };
}

/** 只有 ACP 发来的字段才能成为命令输出、退出码或文件变更。 */
export function acpToolProgress(call: Record<string, unknown>): Record<string, unknown> {
  const tool = readAcpTool(call);
  const output = acpRecord(call.rawOutput);
  const blocks = Array.isArray(call.content) ? call.content.map(acpRecord) : [];
  const text = blocks
    .flatMap((block) => {
      const part = block.type === 'content' ? acpRecord(block.content) : block;
      return part.type === 'text' && typeof part.text === 'string' ? [part.text] : [];
    })
    .join('\n');
  const aggregatedOutput = textField(output.combinedOutput, output.combined_output, output.stdout, typeof call.rawOutput === 'string' ? call.rawOutput : undefined, text);
  const exitCode = output.exitCode ?? output.exit_code;
  const command = tool.command ?? textField(output.commandLine, output.command_line);
  const cwd = tool.cwd ?? textField(output.workingDir, output.working_dir);
  /** ACP 工具明确提供服务器和工具身份时，交给公共 MCP 清单。 */
  const server = textField(tool.args.ServerName);
  const toolName = textField(tool.args.ToolName);
  return {
    toolCallId: call.toolCallId,
    toolName: tool.toolName,
    toolKind: tool.kind,
    arguments: tool.args,
    ...(server && toolName ? { type: 'mcpToolCall', server, tool: toolName } : {}),
    ...(command ? { command } : {}),
    ...(cwd ? { cwd } : {}),
    ...(aggregatedOutput ? { aggregatedOutput, output: aggregatedOutput } : {}),
    ...(typeof exitCode === 'number' && Number.isSafeInteger(exitCode) ? { exitCode } : {}),
    ...(tool.paths[0] ? { filePath: tool.paths[0] } : {}),
    ...(blocks.some((block) => block.type === 'diff') ? { changes: blocks.filter((block) => block.type === 'diff' && typeof block.path === 'string') } : {}),
    ...(blocks.length ? { content: blocks } : {}),
    ...(call.rawOutput !== undefined ? { toolResult: call.rawOutput } : {}),
    ...(output.stderr ? { stderr: output.stderr } : {}),
    ...(call.status ? { status: call.status } : {}),
  };
}

/** ACP 只接受它在本次请求内公布的 optionId。 */
export function acpPermissionOptions(params: Record<string, unknown>): Map<AntigravityDecision, string> {
  const decisions = new Map<AntigravityDecision, string>();
  for (const option of Array.isArray(params.options) ? params.options.map(acpRecord) : []) {
    const decision = option.kind === 'allow_once' ? 'accept' : option.kind === 'reject_once' ? 'decline' : null;
    if (decision && typeof option.optionId === 'string' && option.optionId.trim() && !decisions.has(decision)) decisions.set(decision, option.optionId);
  }
  return decisions;
}

/** 选项显示名与 ACP 接受的值分别保存，重复标题仍可准确回写。 */
interface NativeChoice {
  value: string;
  label: string;
  description: string;
}

/** 一道 Zeus 问题可以对应 agy 的选择字段和补充文字字段。 */
interface NativeQuestion {
  /** 使用界面问题结构，选项同时保留 ACP 接受的值。 */
  question: Omit<CanonicalRequestUserInputQuestion, 'options'> & { options: NativeChoice[] | null };
  /** 自由输入写入的原生字段名。 */
  textKey?: string;
}

/** 将协议值转成唯一的界面标签。 */
function nativeChoices(entries: unknown[]): NativeChoice[] | null {
  const labels = new Set<string>();
  const ids = new Set<string>();
  const choices: NativeChoice[] = [];
  for (const entry of entries) {
    const option = acpRecord(entry);
    const value = typeof entry === 'string' ? entry : (option.const ?? option.optionId);
    if (typeof value !== 'string' || !value.trim() || ids.has(value)) return null;
    ids.add(value);
    const name = (textField(option.title, option.name) ?? value).trim();
    let label = name;
    for (let suffix = 2; labels.has(label); suffix += 1) label = `${name} (${suffix})`;
    labels.add(label);
    choices.push({ label, value, description: textField(option.description) ?? '' });
  }
  return choices.length ? choices : null;
}

/** 新版 elicitation 表单与旧版 interaction_ 使用同一套问题卡。 */
export function acpQuestions(form: boolean, params: Record<string, unknown>): NativeQuestion[] | null {
  if (!form) {
    const call = acpRecord(params.toolCall);
    const choices = Array.isArray(params.options) ? nativeChoices(params.options) : null;
    if (typeof call.toolCallId !== 'string' || !choices) return null;
    return [{ question: { id: call.toolCallId, question: textField(call.title) ?? '请选择一项', header: '', options: choices, isOther: false, multiple: false, isSecret: false } }];
  }
  if (params.mode !== undefined && params.mode !== 'form') return null;
  const fields = acpRecord(acpRecord(params.requestedSchema).properties);
  const ids = new Set<string>();
  for (const key of Object.keys(fields)) {
    const match = /^(q\d+)(?:_other)?$/u.exec(key);
    if (!match) return null;
    ids.add(match[1]!);
  }
  const questions: NativeQuestion[] = [];
  for (const id of [...ids].sort((left, right) => Number(left.slice(1)) - Number(right.slice(1)))) {
    const field = acpRecord(fields[id]);
    const other = acpRecord(fields[id + '_other']);
    const multiple = field.type === 'array';
    const schema = multiple ? acpRecord(field.items) : field;
    const variants = schema.oneOf ?? schema.anyOf ?? schema.enum;
    const choices = Array.isArray(variants) ? nativeChoices(variants) : null;
    const freeText = !choices && field.type === 'string' && variants === undefined;
    if ((fields[id] !== undefined && ((!choices && !freeText) || (!multiple && field.type !== 'string'))) || (fields[id + '_other'] !== undefined && other.type !== 'string')) return null;
    const textKey = freeText ? id : other.type === 'string' ? id + '_other' : undefined;
    if (!choices && !textKey) return null;
    const title = textField(field.title, other.title, field.description, params.message) ?? id;
    questions.push({
      question: {
        id,
        question: title,
        header: '',
        options: choices,
        multiple,
        isOther: Boolean(choices && textKey),
        isSecret: field.format === 'password' || other.format === 'password' || field.writeOnly === true || other.writeOnly === true,
      },
      textKey,
    });
  }
  return questions.length ? questions : null;
}

/** 校验同一张卡的答案后恢复原生字段，空回答表示用户跳过。 */
export function acpQuestionContent(plans: NativeQuestion[], response: unknown): Record<string, string | string[]> | null {
  const answers = acpRecord(acpRecord(response).answers);
  if (!Object.keys(answers).length) return null;
  const invalid = validateCanonicalRequestUserInputAnswers({ questions: plans.map((plan) => plan.question) }, answers);
  if (invalid) throw new Error(invalid);
  const content: Record<string, string | string[]> = {};
  for (const { question, textKey } of plans) {
    const values: string[] = [];
    for (const answer of acpRecord(answers[question.id]).answers as string[]) {
      const choice = question.options?.find((entry) => entry.label === answer);
      if (choice) values.push(choice.value);
      else if (textKey) content[textKey] = answer;
    }
    if (values.length) content[question.id] = question.multiple ? values : values[0]!;
  }
  return content;
}
