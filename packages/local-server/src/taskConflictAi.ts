export interface TaskConflictAiBlock {
  index: number;
  start: number;
  end: number;
  startLine: number;
  source: string;
  base: string;
  task: string;
}

export interface TaskConflictAiSuggestion {
  index: number;
  content: string;
  explanation: string;
}

const conflictPattern = /^<<<<<<<[^\r\n]*(?:\r?\n|$)([\s\S]*?)(?:^\|\|\|\|\|\|\|[^\r\n]*(?:\r?\n|$)([\s\S]*?))?^=======[^\r\n]*(?:\r?\n|$)([\s\S]*?)^>>>>>>>[^\r\n]*(?:\r?\n|$)?/gmu;

/** AI 只接收当前草稿中的真实冲突块，不把整份大文件复制进提示词。 */
export function parseTaskConflictAiBlocks(content: string): TaskConflictAiBlock[] {
  const blocks: TaskConflictAiBlock[] = [];
  conflictPattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = conflictPattern.exec(content))) {
    blocks.push({
      index: blocks.length,
      start: match.index,
      end: conflictPattern.lastIndex,
      startLine: countNewlines(content.slice(0, match.index)) + 1,
      source: match[1],
      base: match[2] ?? '',
      task: match[3],
    });
  }
  return blocks;
}

export function buildTaskConflictAiPrompt(input: { path: string; targetBranch: string; taskBranch: string; blocks: TaskConflictAiBlock[] }): string {
  const serializedBlocks = input.blocks.map((block) => ({
    index: block.index,
    startLine: block.startLine,
    base: block.base,
    target: block.source,
    task: block.task,
  }));
  return [
    '你正在为 Zeus 生成 Git 三方冲突的可审查草稿。',
    '当前工作目录是只读的；可以读取仓库了解上下文，但不要修改文件、执行 Git 写操作或创建提交。',
    '请处理下面列出的全部冲突块。只输出一个 JSON 对象，不要输出 Markdown 代码围栏或额外说明。',
    'JSON 格式：{"resolutions":[{"index":0,"content":"最终内容","explanation":"为什么这样组合"}]}。',
    'content 只能是替换该冲突标记区的最终文本，不能包含 <<<<<<<、|||||||、======= 或 >>>>>>>。',
    '必须保留两侧互不冲突的有效修改；需要业务判断时依据仓库真实代码，无法判断时不要猜测，可省略该 index。',
    `文件：${input.path}`,
    `目标分支：${input.targetBranch}`,
    `任务分支：${input.taskBranch}`,
    `冲突块：${JSON.stringify(serializedBlocks)}`,
  ].join('\n');
}

export function parseTaskConflictAiAnswer(answer: string, blocks: TaskConflictAiBlock[]): TaskConflictAiSuggestion[] {
  const parsed = JSON.parse(stripOptionalJsonFence(answer)) as unknown;
  if (!isRecord(parsed) || !Array.isArray(parsed.resolutions)) throw taskConflictAiError('ZEUS_CONFLICT_AI_RESPONSE_INVALID', 'AI 没有返回可识别的冲突草稿。');
  const allowed = new Set(blocks.map((block) => block.index));
  const seen = new Set<number>();
  const suggestions: TaskConflictAiSuggestion[] = [];
  for (const value of parsed.resolutions) {
    if (!isRecord(value) || !Number.isInteger(value.index) || typeof value.content !== 'string' || typeof value.explanation !== 'string') {
      throw taskConflictAiError('ZEUS_CONFLICT_AI_RESPONSE_INVALID', 'AI 返回的冲突草稿字段不完整。');
    }
    const index = value.index as number;
    if (!allowed.has(index) || seen.has(index)) throw taskConflictAiError('ZEUS_CONFLICT_AI_RESPONSE_INVALID', 'AI 返回了未知或重复的冲突块。');
    if (/^(?:<<<<<<<|\|\|\|\|\|\|\||=======|>>>>>>>)/mu.test(value.content)) {
      throw taskConflictAiError('ZEUS_CONFLICT_AI_RESPONSE_INVALID', 'AI 草稿仍包含 Git 冲突标记。');
    }
    if (value.content.length > 300_000) throw taskConflictAiError('ZEUS_CONFLICT_AI_RESPONSE_TOO_LARGE', 'AI 返回的单个冲突块过大。');
    seen.add(index);
    suggestions.push({ index, content: value.content, explanation: value.explanation.trim().slice(0, 1_000) });
  }
  if (suggestions.length === 0) throw taskConflictAiError('ZEUS_CONFLICT_AI_NO_SUGGESTION', 'AI 没有生成可应用的冲突草稿。');
  return suggestions;
}

function stripOptionalJsonFence(value: string): string {
  const trimmed = value.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(trimmed);
  return fenced?.[1]?.trim() ?? trimmed;
}

function countNewlines(value: string): number {
  return (value.match(/\n/gu) ?? []).length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function taskConflictAiError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
