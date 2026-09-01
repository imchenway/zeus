type InvalidCommandFactory = (message: string) => Error;

/** 各领域命令只保留自己的错误码与策略，共用完全相同的输入形状校验。 */
export function createCommandValidation(invalidCommand: InvalidCommandFactory) {
  return {
    requireRecord(value: unknown, field: string): Record<string, unknown> {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidCommand(`${field} must be an object.`);
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) throw invalidCommand(`${field} must be a plain object.`);
      return value as Record<string, unknown>;
    },
    assertExactKeys(value: Record<string, unknown>, expected: readonly string[], commandType: string): void {
      const actual = Object.keys(value).sort();
      const normalizedExpected = [...expected].sort();
      if (actual.length === normalizedExpected.length && actual.every((key, index) => key === normalizedExpected[index])) return;
      throw invalidCommand(`${commandType} must contain exactly: ${normalizedExpected.join(', ')}.`);
    },
    boundedIdentity(value: unknown, field: string): string {
      if (
        typeof value !== 'string' ||
        value.trim() !== value ||
        value.length < 1 ||
        value.length > 512 ||
        Array.from(value).some((character) => {
          const point = character.codePointAt(0) ?? 0;
          return point <= 31 || point === 127;
        })
      ) {
        throw invalidCommand(`${field} is invalid.`);
      }
      return value;
    },
    validSha256(value: unknown, field: string): string {
      if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) throw invalidCommand(`${field} must be a lowercase SHA-256.`);
      return value;
    },
  };
}
