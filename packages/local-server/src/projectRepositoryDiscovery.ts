import { discoverGitRepositories } from '@zeus/git-core';
import type { ProjectRepositoryDiscovery } from '@zeus/shared';
import type { ProjectRepository, ProjectRepositoryRegistrationRepository, SettingRepository, ZeusDatabase, ZeusProjectRecord } from '@zeus/storage';

/** 仓库发现记录与项目其他设置共用持久存储，不复用代码图谱扫描状态。 */
const discoverySettingsPrefix = 'project-repository-discovery:';

/** 请求身份用于拒绝目录切换和较新扫描发生后的过期结果。 */
interface DiscoveryRecord extends ProjectRepositoryDiscovery {
  /** 触发本次扫描的耐久命令身份。 */
  requestId: string;
}

/** 只读取当前项目目录的发现状态；查询路径不会补扫或写入设置。 */
export function readProjectRepositoryDiscovery(settings: Pick<SettingRepository, 'getJson'>, project: ZeusProjectRecord): ProjectRepositoryDiscovery {
  /** 只接受属于当前项目目录的记录。 */
  const record = settings.getJson<DiscoveryRecord>(discoverySettingsPrefix + project.id);
  if (record?.localPath === project.localPath) {
    return { projectId: project.id, localPath: record.localPath, status: record.status, completedAt: record.completedAt, error: record.error };
  }
  return { projectId: project.id, localPath: project.localPath, status: 'not_started', completedAt: null, error: null };
}

/** 项目命令保存发现意图，提交后异步读取磁盘并原子发布完整仓库清单。 */
export class ProjectRepositoryDiscoveryService {
  /** ponytail: 各项目串行扫描，避免集中补扫争抢磁盘；吞吐不足时再使用有界并发。 */
  private work: Promise<void> = Promise.resolve();
  /** 同一耐久请求只进入后台链一次。 */
  private readonly scheduled = new Set<string>();
  /** 退出时停止目录遍历，保留进行中状态供下一次启动恢复。 */
  private readonly abort = new AbortController();

  /** 复用已有存储、事务与实时通知端口。 */
  constructor(
    private readonly ports: {
      db: ZeusDatabase;
      projects: Pick<ProjectRepository, 'getById' | 'list'>;
      repositories: Pick<ProjectRepositoryRegistrationRepository, 'replaceForProject'>;
      settings: Pick<SettingRepository, 'getJson' | 'setJson'>;
      publishRealtimeEvent(type: string, payload: Record<string, unknown>): void;
      redactSensitiveText(value: string): { text: string };
    },
  ) {}

  /** 在项目创建、路径修改或刷新命令的事务内调用；响应无需等待扫描。 */
  request(project: ZeusProjectRecord, requestId: string): ProjectRepositoryDiscovery {
    /** 同目录的进行中请求只合并，不清空上次成功时间。 */
    const current = this.ports.settings.getJson<DiscoveryRecord>(discoverySettingsPrefix + project.id);
    if (current?.localPath === project.localPath && current.status === 'running') {
      this.ports.db.afterCommit(() => this.schedule(current));
      return readProjectRepositoryDiscovery(this.ports.settings, project);
    }
    /** 请求意图和父项目命令在同一事务持久保存。 */
    const record: DiscoveryRecord = {
      projectId: project.id,
      localPath: project.localPath,
      requestId,
      status: 'running',
      completedAt: current?.localPath === project.localPath ? current.completedAt : null,
      error: null,
    };
    this.ports.settings.setJson(discoverySettingsPrefix + project.id, record);
    this.ports.db.afterCommit(() => {
      this.notify(record);
      this.schedule(record);
    });
    return readProjectRepositoryDiscovery(this.ports.settings, project);
  }

  /** 启动只恢复已持久接纳的未完成请求，不扫描所有旧项目。 */
  recover(): void {
    for (const project of this.ports.projects.list()) {
      /** 仅恢复明确未完成且目录仍一致的记录。 */
      const record = this.ports.settings.getJson<DiscoveryRecord>(discoverySettingsPrefix + project.id);
      if (record?.localPath === project.localPath && record.status === 'running') this.schedule(record);
    }
  }

  /** 必须在关闭数据库前停止所有后台写回。 */
  async close(): Promise<void> {
    this.abort.abort();
    await this.work;
  }

  /** 合并重复请求，并让扫描在命令提交和响应完成后才开始。 */
  private schedule(record: DiscoveryRecord): void {
    /** 项目和请求共同确定一次后台扫描。 */
    const key = `${record.projectId}:${record.requestId}`;
    if (this.abort.signal.aborted || this.scheduled.has(key)) return;
    this.scheduled.add(key);
    this.work = this.work
      .then(async () => {
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (this.abort.signal.aborted || !this.isCurrent(record)) return;
        await this.discover(record);
      })
      .catch((error: unknown) => {
        console.error('项目仓库发现未能保存结果，进行中记录将在重启后恢复。', this.ports.redactSensitiveText(String(error)).text);
      })
      .finally(() => this.scheduled.delete(key));
  }

  /** 完整成功才替换仓库清单；失败和退出均保留上次成功结果。 */
  private async discover(record: DiscoveryRecord): Promise<void> {
    try {
      /** 候选全部读取成功后才允许写回数据库。 */
      const repositories = await discoverGitRepositories(record.localPath, 6, this.abort.signal);
      if (this.abort.signal.aborted || !this.isCurrent(record)) return;
      this.ports.db.durableTransactionSync(() => {
        this.ports.repositories.replaceForProject(
          record.projectId,
          repositories.map((repository) => ({
            projectId: record.projectId,
            name: repository.name,
            relativePath: repository.relativePath,
            localPath: repository.localPath,
          })),
        );
        /** 完成状态与仓库清单一起提交。 */
        const completed: DiscoveryRecord = { ...record, status: 'completed', completedAt: new Date().toISOString(), error: null };
        this.ports.settings.setJson(discoverySettingsPrefix + record.projectId, completed);
        this.ports.db.afterCommit(() => this.notify(completed));
      });
    } catch (error) {
      if (this.abort.signal.aborted || !this.isCurrent(record)) return;
      /** 失败只更新状态和原因，不替换已登记仓库。 */
      const failed: DiscoveryRecord = { ...record, status: 'failed', error: this.ports.redactSensitiveText(error instanceof Error ? error.message : String(error)).text };
      this.ports.db.durableTransactionSync(() => {
        this.ports.settings.setJson(discoverySettingsPrefix + record.projectId, failed);
        this.ports.db.afterCommit(() => this.notify(failed));
      });
    }
  }

  /** 项目删除、目录变化或新请求接纳后，旧扫描不能发布。 */
  private isCurrent(record: DiscoveryRecord): boolean {
    /** 当前项目身份用于排除已删除或已改目录的请求。 */
    const project = this.ports.projects.getById(record.projectId);
    /** 当前请求身份防止旧扫描覆盖后续请求。 */
    const current = this.ports.settings.getJson<DiscoveryRecord>(discoverySettingsPrefix + record.projectId);
    return project?.localPath === record.localPath && current?.requestId === record.requestId && current.localPath === record.localPath;
  }

  /** 事件只用于失效通知，接收方重新读取权威仓库和分支。 */
  private notify(record: DiscoveryRecord): void {
    this.ports.publishRealtimeEvent('project.repositories.changed', { projectId: record.projectId, status: record.status });
  }
}
