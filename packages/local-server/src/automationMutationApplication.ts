import { createHash } from 'node:crypto';
import { IdempotencyRequestRepository, type ZeusDatabasePort } from '@zeus/storage';

export interface AutomationMutationResult {
  statusCode: number;
  body: unknown;
}

/** 自动化配置写入和响应回执同事务提交，重连只回放已提交结果。 */
export class AutomationMutationApplication {
  private readonly requests: IdempotencyRequestRepository;

  constructor(private readonly db: ZeusDatabasePort) {
    this.requests = new IdempotencyRequestRepository(db);
  }

  execute(input: { method: string; url: string; body: unknown; key: unknown }, mutate: () => AutomationMutationResult): AutomationMutationResult {
    if (typeof input.key !== 'string' || !/^[a-zA-Z0-9:_-]{8,160}$/u.test(input.key)) {
      throw new Error('ZEUS_AUTOMATION_OPERATION_ID_REQUIRED: 自动化写操作需要有效的幂等标识。');
    }
    const key = input.key;
    const scope = `automation-http:${input.method}:${input.url.split('?')[0]}`;
    const requestHash = createHash('sha256')
      .update(JSON.stringify(input.body ?? null))
      .digest('hex');
    return this.db.commitCriticalFactSync(() => {
      const previous = this.requests.get(scope, key);
      if (previous) {
        if (previous.requestHash !== requestHash) throw new Error('ZEUS_AUTOMATION_OPERATION_CONFLICT: 同一操作标识不能用于不同参数。');
        if (previous.status !== 'completed' || previous.httpStatus === null || previous.responseJson === null) {
          throw new Error('ZEUS_AUTOMATION_OPERATION_OUTCOME_UNKNOWN: 操作结果需要恢复，不能直接重试。');
        }
        return { statusCode: previous.httpStatus, body: JSON.parse(previous.responseJson) as unknown };
      }
      const result = mutate();
      this.requests.createOrGet({ scope, idempotencyKey: key, requestHash, status: 'completed', httpStatus: result.statusCode, response: result.body, createdAt: new Date().toISOString() });
      return result;
    });
  }
}
