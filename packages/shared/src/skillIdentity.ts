export interface ZeusPluginSkillReference {
  kind: 'skill';
  id: string;
}

export function isZeusNativeSkillId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{32}$/u.test(value);
}

export function isZeusPluginSkillId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 512 && /^plugin:[^:\s\u0000-\u001f\u007f]+:skill:[^:\s\u0000-\u001f\u007f]+$/u.test(value);
}

export function isZeusSkillId(value: unknown): value is string {
  return isZeusNativeSkillId(value) || isZeusPluginSkillId(value);
}

/** 将统一 Skill 目录身份还原为两条既有运行时协议。 */
export function splitZeusSkillIds(values: readonly string[]): { nativeSkillIds: string[]; pluginReferences: ZeusPluginSkillReference[]; invalidIds: string[] } {
  const nativeSkillIds: string[] = [];
  const pluginReferences: ZeusPluginSkillReference[] = [];
  const invalidIds: string[] = [];
  for (const value of values) {
    if (isZeusNativeSkillId(value)) nativeSkillIds.push(value);
    else if (isZeusPluginSkillId(value)) pluginReferences.push({ kind: 'skill', id: value });
    else invalidIds.push(value);
  }
  return { nativeSkillIds, pluginReferences, invalidIds };
}
