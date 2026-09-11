import type { DigitalEmployeeRecord, LongTermMemoryRecord, LongTermMemoryRepository } from '@zeus/storage';

/** 工作与讨论共用员工经验检索，预算限制总输入且不截断单条经验。 */
export function selectEmployeeMemories(repository: LongTermMemoryRepository, employee: DigitalEmployeeRecord, projectId: string, query: string, asOf: string): LongTermMemoryRecord[] {
  if (employee.memoryEnabled === false) return [];
  /** 只取当前员工范围，普通项目记忆仍由原上下文编译器处理。 */
  const candidates = repository
    .resolveForContext({ projectId, employeeId: employee.id, asOf, minimumConfidence: 0.7 })
    .selected.filter((record) => record.scope.kind === 'employee' && (record.kind !== 'domain_knowledge' || relevantEmployeeKnowledge(record.memoryKey + record.content, query)));
  /** 大条目跳过而非裁断；八条总计不超过一万二千字符。 */
  const selected: LongTermMemoryRecord[] = [];
  let remaining = 12_000;
  for (const record of candidates) {
    const size = record.content.length + record.memoryKey.length + record.source.reference.length;
    if (selected.length === 8) break;
    if (size > remaining) continue;
    selected.push(record);
    remaining -= size;
  }
  return selected;
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
