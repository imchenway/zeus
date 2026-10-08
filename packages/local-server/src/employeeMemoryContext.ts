import type { DigitalEmployeeRecord, LongTermMemoryRecord, LongTermMemoryRepository } from '@zeus/storage';

/** 工作与讨论共用员工经验检索，预算限制总输入且不截断单条经验。 */
export function selectEmployeeMemories(repository: LongTermMemoryRepository, employee: DigitalEmployeeRecord, projectId: string, query: string, asOf: string): LongTermMemoryRecord[] {
  return resolveEmployeeMemories(repository, employee, projectId, query, asOf).selected;
}

/** 冻结选择结果与未选原因，预览和派发历史使用同一份事实。 */
export function resolveEmployeeMemories(repository: LongTermMemoryRepository, employee: DigitalEmployeeRecord, projectId: string, query: string, asOf: string) {
  /** 身份固定在当前工作，不因项目员工后续改绑而越界。 */
  const globalEmployeeId = employee.globalEmployeeId === undefined ? employee.templateId : employee.globalEmployeeId;
  /** 普通项目记忆仍由原上下文编译器处理。 */
  const resolution = repository.resolveForContext({ projectId, employeeId: employee.id, globalEmployeeId, asOf, minimumConfidence: 0.7 });
  /** 每条候选都保留正文和来源，便于解释实际输入。 */
  const decisions: Array<{ record: LongTermMemoryRecord; selected: boolean; reason: string }> = resolution.excluded.filter(({ record }) => record.scope.kind === 'employee').map(({ record, reason }) => ({ record, selected: false, reason }));
  /** 超出预算的完整条目不裁断。 */
  const selected: LongTermMemoryRecord[] = [];
  let remaining = 12_000;
  for (const record of resolution.selected.filter((item) => item.scope.kind === 'employee')) {
    const size = record.content.length + record.memoryKey.length + record.source.reference.length;
    const reason =
      employee.memoryEnabled === false
        ? 'reading_disabled'
        : record.confirmationLevel === 'observed'
          ? 'unconfirmed'
          : employee.prompt.includes(record.content)
            ? 'already_in_prompt'
            : record.kind === 'domain_knowledge' && !relevantEmployeeKnowledge(record.memoryKey + record.content, query)
              ? 'not_relevant'
              : selected.length >= 8 || size > remaining
                ? 'input_budget'
                : 'selected';
    decisions.push({ record, selected: reason === 'selected', reason });
    if (reason !== 'selected') continue;
    selected.push(record);
    remaining -= size;
  }
  return { selected, decisions };
}

/** 领域知识按当前目标匹配，不把无关项目细节全部塞进个人上下文。 */
function relevantEmployeeKnowledge(content: string, query: string): boolean {
  /** 英文按词，中文按相邻双字提取有界检索线索。 */
  const terms = query.toLocaleLowerCase().match(/[a-z0-9_]{3,}|[\p{Script=Han}]{2,}/gu) ?? [];
  /** 忽略常见空泛词，减少与任务无关的记忆进入工作。 */
  const excluded = new Set(['任务', '需要', '进行', '完成', '要求', '可以', 'the', 'and', 'for']);
  /** 只匹配正文，不据此给予任何行动权限。 */
  const normalized = content.toLocaleLowerCase();
  return terms
    .slice(0, 100)
    .some((term) =>
      /[\p{Script=Han}]/u.test(term) ? Array.from({ length: term.length - 1 }, (_, index) => term.slice(index, index + 2)).some((pair) => !excluded.has(pair) && normalized.includes(pair)) : !excluded.has(term) && normalized.includes(term),
    );
}
