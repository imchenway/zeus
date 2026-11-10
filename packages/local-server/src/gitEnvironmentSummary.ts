import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { watch, type FSWatcher } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { deliveryWorkspacesForConversationBranch, type GitEnvironmentScope, type GitEnvironmentSummary, type GitEnvironmentStatus } from '@zeus/shared';
import { buildTaskEnvironmentRootPath, discoverGitRepositories, getGitCommonDirectory, getGitWorktreeClean, getTaskWorkspaceReview, type TaskWorkspaceReview } from '@zeus/git-core';
import type { ProjectRepository, TaskRepository, TaskEnvironmentRepository, TaskWorkspaceRepository, ConversationRepository, ConversationSubmissionRepository, ZeusTaskWorkspaceRecord } from '@zeus/storage';
import { conversationRepositoryId, resolveConversationGitWorkspace } from './conversationGitWorkspace.js';
import type { ConversationRealtimeSocket } from './conversationSyncRoutes.js';

/** Git 目录由 Git 自身解析，支持普通仓库、独立 worktree 和路径别名。 */
const readGit = promisify(execFile);

/** 最近访问的工作树保留监听五分钟，切换会话无需重新初始化，单位毫秒。 */
const IDLE_SUMMARY_RETENTION_MS = 5 * 60_000;
/** 无订阅的目录监听最多保留八组，避免浏览大量会话后资源持续增长。 */
const MAX_IDLE_SUMMARIES = 8;

/** 单个真实工作树的共享摘要和有效订阅。 */
interface SummaryEntry {
  /** 真实目录与排除范围共同组成缓存身份。 */
  key: string;
  /** Git 执行目录。 */
  path: string;
  /** 嵌套仓库和共享目录由既有范围规则排除。 */
  ignoredPaths: string[];
  /** 文件变化次数，读取期间变化不得被旧结果覆盖。 */
  revision: number;
  /** 当前快照对应的变化次数。 */
  loadedRevision: number;
  /** 同一工作树只有一个在途 Git 读取。 */
  request?: Promise<TaskWorkspaceReview>;
  /** 上次成功结果，后台刷新失败不覆盖它。 */
  snapshot?: TaskWorkspaceReview;
  /** 活跃交付窗口共享这些文件监听器。 */
  watchers: FSWatcher[];
  /** 对应交付订阅的合并刷新入口。 */
  listeners: Set<() => void>;
  /** 监听失效时仅对仍被订阅的工作树补充核对。 */
  fallback?: ReturnType<typeof setInterval>;
}

/** 已经过项目和任务归属校验的读取目录。 */
interface SummarySource {
  /** 与交付事件一致的仓库或工作区身份。 */
  id: string;
  /** 真实读取路径，不接受客户端路径。 */
  path: string;
  /** 不属于当前仓库的嵌套路径。 */
  ignoredPaths: string[];
  /** 普通项目只移除嵌套仓库的未跟踪目录占位，不隐藏父仓已跟踪文件。 */
  nestedPaths?: string[];
}

/** Git 状态服务提供卡片按需读取与交付窗口订阅，共用工作区身份校验。 */
export class GitEnvironmentSummaryService {
  /** 同一持久范围的并发只读请求共用检查，完成即释放，不缓存过期 Git 状态。 */
  private readonly statusReads = new Map<string, Promise<GitEnvironmentStatus>>();
  /** 同一工作树和排除范围跨窗口共享初始化与读取。 */
  private readonly entries = new Map<string, { promise: Promise<SummaryEntry>; listeners: Set<() => void> }>();
  /** 按退出订阅的顺序回收空闲工作树；重新订阅会移出此集合。 */
  private readonly idleEntries = new Map<string, { entry: SummaryEntry; timer: ReturnType<typeof setTimeout> }>();
  /** 宿主关闭后，迟到的初始化结果也必须立即释放。 */
  private closed = false;
  /** 项目操作和宿主关闭通知当前订阅。 */
  private readonly subscriptions = new Set<{ projectId: string; invalidate: (repositoryId?: string) => void; close: () => void }>();

  /** 沿用服务端持久身份和工作树边界。 */
  constructor(
    private readonly options: {
      /** 注册当前宿主的只读订阅端点。 */
      server: FastifyInstance;
      /** 项目身份和允许读取的本地根目录。 */
      projects: ProjectRepository;
      /** 核验任务所属项目。 */
      tasks: TaskRepository;
      /** 任务环境根目录包含整次工作涉及的仓库，不能用首仓目录代替。 */
      environments: TaskEnvironmentRepository;
      /** 任务环境、冲突工作区及生命周期的权威记录。 */
      workspaces: TaskWorkspaceRepository;
      /** 独立会话的归属与绑定身份。 */
      conversations: ConversationRepository;
      /** 会话首次提交中持久化的目录模式。 */
      submissions: ConversationSubmissionRepository;
      /** 复用任务交付既有的嵌套仓库和共享路径排除规则。 */
      ignoredPaths(workspace: ZeusTaskWorkspaceRecord): string[];
      /** 只接受当前宿主的有效认证令牌。 */
      authorized(request: FastifyRequest): boolean;
    },
  ) {}

  /** 使用现有本机 WebSocket 认证，连接生命周期即摘要订阅生命周期。 */
  register(): void {
    this.options.server.get('/api/projects/:projectId/git/environment-status', async (request, reply) => {
      const scope = request.query as GitEnvironmentScope;
      if (Object.values(scope).some((value) => typeof value !== 'string' || !value || value.length > 200) || (scope.taskId && scope.conversationId) || (scope.workspaceId && !scope.taskId)) {
        return reply.code(400).send({ message: 'Invalid Git environment scope' });
      }
      /** 多窗口同时恢复焦点时不重复启动同一批仓库检查。 */
      const projectId = (request.params as { projectId: string }).projectId;
      /** 请求身份只包含持久范围，同一项目中的不同工作区不能合并。 */
      const key = JSON.stringify([projectId, scope.taskId, scope.workspaceId, scope.conversationId]);
      /** 已启动的检查继续服务相同范围的新读取。 */
      const pending = this.statusReads.get(key);
      if (pending) return pending;
      /** 真实写入可使旧检查失效，其回执只能清理自身。 */
      const reading = this.readStatus(projectId, scope).finally(() => {
        if (this.statusReads.get(key) === reading) this.statusReads.delete(key);
      });
      this.statusReads.set(key, reading);
      return reading;
    });
    this.options.server.get('/api/projects/:projectId/git/summary-events', { websocket: true }, (socket, request) => {
      /** 连接尚未读取目录时也必须先验证宿主令牌。 */
      const subscriber = socket as ConversationRealtimeSocket;
      if (!this.options.authorized(request)) return subscriber.close(1008, 'Missing or invalid Zeus local API token');
      /** 参数只能表达持久身份，不能提供文件系统路径。 */
      const projectId = (request.params as { projectId: string }).projectId;
      /** 查询参数只携带持久身份，后续每次刷新都重新核对归属。 */
      const scope = request.query as GitEnvironmentScope;
      if (Object.values(scope).some((value) => typeof value !== 'string' || !value || value.length > 200) || (scope.taskId && scope.conversationId) || (scope.workspaceId && !scope.taskId))
        return subscriber.close(1008, 'Invalid Git summary scope');
      this.subscribe(projectId, scope, subscriber);
    });
  }

  /** 真实 Git 操作或任务生命周期变化才使关联摘要失效。 */
  invalidateProject(projectId: string, repositoryId?: string): void {
    /** 写入完成后的新请求重新核验，旧读取的回执不能移除这次新读取。 */
    for (const key of this.statusReads.keys()) if (JSON.parse(key)[0] === projectId) this.statusReads.delete(key);
    for (const subscription of this.subscriptions) if (subscription.projectId === projectId) subscription.invalidate(repositoryId);
  }

  /** 宿主关闭时先解除连接和文件监听。 */
  close(): void {
    this.closed = true;
    for (const subscription of [...this.subscriptions]) subscription.close();
    for (const { entry } of this.idleEntries.values()) this.disposeEntry(entry);
  }

  /** 最后一个订阅离开后短期保留监听；没有订阅时文件事件只标记失效，不启动 Git。 */
  private releaseEntry(entry: SummaryEntry, listener: () => void): void {
    entry.listeners.delete(listener);
    if (entry.listeners.size || this.idleEntries.has(entry.key)) return;
    if (this.closed) return this.disposeEntry(entry);
    const timer = setTimeout(() => this.disposeEntry(entry), IDLE_SUMMARY_RETENTION_MS);
    timer.unref();
    this.idleEntries.set(entry.key, { entry, timer });
    while (this.idleEntries.size > MAX_IDLE_SUMMARIES) this.disposeEntry(this.idleEntries.values().next().value!.entry);
  }

  /** 回收空闲或关闭中的监听，不能删除同一路径后续创建的新条目。 */
  private disposeEntry(entry: SummaryEntry): void {
    clearTimeout(this.idleEntries.get(entry.key)?.timer);
    this.idleEntries.delete(entry.key);
    for (const watcher of entry.watchers) watcher.close();
    clearInterval(entry.fallback);
    if (this.entries.get(entry.key)?.listeners === entry.listeners) this.entries.delete(entry.key);
  }

  /** 卡片读取与交付订阅共用持久身份校验和仓库范围。 */
  private async resolveScope(projectId: string, scope: GitEnvironmentScope, discovered?: Array<Pick<Awaited<ReturnType<typeof discoverGitRepositories>>[number], 'localPath' | 'relativePath' | 'name'>>) {
    /** 项目路径可能被设置页修改，读取前使用最新记录。 */
    const project = this.options.projects.getById(projectId);
    if (!project) throw new Error('项目已不存在。');
    let sources: SummarySource[];
    /** 仅任务工作树带有工作区生命周期。 */
    let workspace: ZeusTaskWorkspaceRecord | undefined;
    /** 任务和独立会话都按各仓持久记录提供来源。 */
    let sourceBranches: NonNullable<GitEnvironmentSummary['sourceBranches']> = [];
    /** 已完成仓库仍属于整次交付范围。 */
    let repositoryCount = 0;
    /** 目录只来源于项目、工作区或独立会话的持久记录。 */
    let cwd = project.localPath;
    if (scope.taskId) {
      const task = this.options.tasks.getById(scope.taskId);
      if (!task || task.projectId !== projectId) throw new Error('任务不属于当前项目。');
      const workspaces = this.options.workspaces.listByTask(task.id);
      // 缺失绑定且存在多个任务环境时不能任意选一条开发线。
      if (!scope.workspaceId && new Set(workspaces.filter((item) => item.kind !== 'conflict').map((item) => item.environmentId ?? item.branchName)).size > 1) throw new Error('会话未绑定唯一任务工作目录，请在代码交付页选择工作区。');
      workspace = scope.workspaceId ? workspaces.find((item) => item.id === scope.workspaceId) : (workspaces.find((item) => item.state === 'ready') ?? workspaces[0]);
      if (!workspace) throw new Error('任务工作目录不可用，请在代码交付页检查。');
      const selected = deliveryWorkspacesForConversationBranch(workspaces, workspace.id);
      if (!selected.length) throw new Error('任务工作区关联已失效，请在代码交付页检查。');
      repositoryCount = selected.length;
      sourceBranches = selected.map((item) => ({ repositoryRelativePath: item.repositoryRelativePath, branch: item.sourceBranch || null }));
      sources = selected.flatMap((item) => {
        // 正常完成或回收的仓库没有待交付工作树，不应把空 review 当作读取失败。
        if (['merged', 'reclaimed', 'discarded'].includes(item.state)) return [];
        if (!item.worktreePath) throw new Error('任务工作目录丢失，请在代码交付页检查。');
        return [{ id: item.id, path: item.worktreePath, ignoredPaths: this.options.ignoredPaths(item) }];
      });
      /** 工作目录沿用执行上下文的环境根；冲突工作区保留自身隔离目录。 */
      const environment = workspace.environmentId ? this.options.environments.getById(workspace.environmentId) : undefined;
      if (environment && (environment.projectId !== projectId || environment.taskId !== task.id)) throw new Error('任务环境不属于当前任务。');
      cwd =
        workspace.kind === 'conflict'
          ? (workspace.worktreePath ?? workspace.repositoryPath ?? project.localPath)
          : resolve(environment?.rootPath || (!environment ? workspace.worktreePath : null) || buildTaskEnvironmentRootPath(project.localPath, project.slug, task.taskCode, environment?.id ?? workspace.id));
    } else {
      if (scope.conversationId) {
        /** 会话摘要与代码交付使用同一组已核验仓库。 */
        const repository = await resolveConversationGitWorkspace(project, scope.conversationId, this.options.conversations, this.options.submissions);
        cwd = repository.localPath;
        discovered = repository.repositories;
        sourceBranches = repository.sourceBranches;
      } else discovered ??= await discoverGitRepositories(cwd);
      repositoryCount = discovered.length;
      sources = discovered.map((repository) => ({
        id: scope.conversationId ? conversationRepositoryId(scope.conversationId, repository.relativePath) : `project_git_repository_${createHash('sha256').update(`${projectId}\0${repository.relativePath}`).digest('hex').slice(0, 24)}`,
        path: repository.localPath,
        ignoredPaths: [],
        nestedPaths: discovered!
          .filter((nested) => nested.localPath !== repository.localPath)
          .map((nested) => relative(repository.localPath, nested.localPath))
          .filter((path) => path && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
          .map((path) => path.split(sep).join('/')),
      }));
    }
    const summary: Omit<GitEnvironmentStatus, 'dirty'> = {
      projectId,
      cwd,
      branch: workspace?.branchName ?? null,
      sourceBranch: workspace?.sourceBranch ?? (sourceBranches.length && sourceBranches.every((entry) => entry.branch === sourceBranches[0]!.branch) ? sourceBranches[0]!.branch : null),
      sourceBranches,
      workspace: workspace
        ? { id: workspace.id, environmentId: workspace.environmentId, state: workspace.state, worktreePath: workspace.worktreePath, repositoryName: workspace.repositoryName, repositoryRelativePath: workspace.repositoryRelativePath }
        : null,
      repositoryCount,
      repositoryName: discovered?.[0]?.name,
    };
    return { sources, summary, discovered };
  }

  /** 环境卡片只读取分支与是否有更改，不建立目录监听或生成差异统计。 */
  private async readStatus(projectId: string, scope: GitEnvironmentScope): Promise<GitEnvironmentStatus> {
    const { sources, summary: status } = await this.resolveScope(projectId, scope);
    /** 多仓库不展示首仓分支；单仓分支与各仓干净状态互不等待。 */
    const branchSource = sources.find((source) => source.path === status.cwd) ?? (!scope.taskId && status.repositoryCount === 1 ? sources[0] : undefined);
    /** 同一批读取仍保留各仓路径排除规则与失败语义。 */
    const [branch, cleanStates] = await Promise.all([
      branchSource && !status.branch ? readGit('git', ['branch', '--show-current'], { cwd: branchSource.path, timeout: 15_000 }).then((result) => result.stdout.trim() || null) : status.branch,
      Promise.all(sources.map((source) => getGitWorktreeClean(source.path, source.ignoredPaths, source.nestedPaths))),
    ]);
    return { ...status, branch, dirty: cleanStates.some((clean) => !clean) };
  }

  /** 只向连接发送变化后的摘要；短时写入合并，持续写入最多等待一秒。 */
  private subscribe(projectId: string, scope: GitEnvironmentScope, socket: ConversationRealtimeSocket): void {
    /** 本连接当前引用的工作树；移出范围后立即释放。 */
    const held = new Map<string, SummaryEntry>();
    /** 仓库操作只失效对应工作树；未知身份保守核对整个当前范围。 */
    const repositories = new Map<string, SummaryEntry>();
    /** 普通项目的仓库目录在结构变化时重新发现。 */
    let discovered: Array<Pick<Awaited<ReturnType<typeof discoverGitRepositories>>[number], 'localPath' | 'relativePath' | 'name'>> | undefined;
    /** 项目容器监听仅负责新增和移除仓库。 */
    let directoryWatcher: FSWatcher | undefined;
    /** 项目结构监听不可用时才启用低频仓库发现，单位毫秒。 */
    let directoryFallback: ReturnType<typeof setInterval> | undefined;
    /** 防止连接关闭后写回或继续持有监听。 */
    let active = true;
    /** 同一订阅的刷新串行执行，期间变化只补一轮。 */
    let running = false;
    /** 读取期间收到变化时保留下一轮刷新，不并发启动第二次读取。 */
    let pending = false;
    /** 合并延迟与最大等待的计时器，单位毫秒。 */
    let timer: ReturnType<typeof setTimeout> | undefined;
    /** 防止连续写入不断延后刷新。 */
    let deadline: ReturnType<typeof setTimeout> | undefined;
    /** 只比较业务载荷，不以推送时间制造变化。 */
    let previous = '';
    /** 失败后指数退避，避免目录暂时不可读时立即反复启动 Git。 */
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    /** 连续失败次数只影响重试延迟，成功后归零。 */
    let failureCount = 0;
    /** 首次推送优先使用仍受监听的快照；失效数据随后在同一订阅后台刷新。 */
    let initialSnapshot = true;
    /** 将快照或错误放进现有事件信封，并限制慢客户端积压。 */
    const send = (type: string, payload: Record<string, unknown>): void => {
      if (!active || socket.readyState !== socket.OPEN) return;
      /** 去除时间字段后比较业务载荷，避免不变快照触发界面更新。 */
      const content = JSON.stringify([type, payload]);
      if (content === previous) return;
      if ((socket.bufferedAmount ?? 0) > 1_000_000) return socket.close(1013, 'Git summary consumer is too slow');
      previous = content;
      socket.send(JSON.stringify({ id: randomUUID(), type, payload, createdAt: new Date().toISOString() }));
    };
    /** 在连续文件写入期间仍保证摘要能获得执行机会。 */
    const schedule = (): void => {
      if (!active) return;
      pending = true;
      if (running || retryTimer !== undefined) return;
      clearTimeout(timer);
      timer = setTimeout(() => void refresh(), 250);
      deadline ??= setTimeout(() => void refresh(), 1_000);
    };
    /** 当前读取批次结束后不再引用的工作树必须撤销订阅。 */
    const release = (key: string, entry: SummaryEntry): void => {
      held.delete(key);
      for (const [id, repository] of repositories) if (repository === entry) repositories.delete(id);
      this.releaseEntry(entry, schedule);
    };
    /** 重新核验持久身份后组合摘要，不读取完整工作台详情。 */
    const refresh = async (): Promise<void> => {
      clearTimeout(timer);
      clearTimeout(deadline);
      timer = deadline = undefined;
      clearTimeout(retryTimer);
      retryTimer = undefined;
      if (!active || running) return;
      running = true;
      pending = false;
      /** 本次有效目录集合决定哪些旧监听可以释放。 */
      const used = new Set<string>();
      /** 失效快照只发送缓存事件，不触发交付窗口重复读取完整状态。 */
      let cachedPreview = false;
      try {
        const resolved = await this.resolveScope(projectId, scope, discovered);
        const { sources } = resolved;
        /** 差异计数仅在交付订阅中初始化，随后逐仓聚合。 */
        const summary: GitEnvironmentSummary = { ...resolved.summary, files: 0, additions: 0, deletions: 0 };
        const cwd = summary.cwd;
        discovered = resolved.discovered;
        if (!scope.taskId) {
          if (!active) return;
          if (!directoryWatcher) {
            /** 监听故障不阻止已有仓库摘要显示，恢复后自动停止兜底发现。 */
            const recoverDirectoryWatcher = (): void => {
              directoryWatcher?.close();
              directoryWatcher = undefined;
              directoryFallback ??= setInterval(() => {
                discovered = undefined;
                schedule();
              }, 30_000);
              directoryFallback.unref();
            };
            try {
              directoryWatcher = watch(cwd, { recursive: true }, (_event, file) => {
                if (!file) {
                  discovered = undefined;
                  schedule();
                  return;
                }
                const parts = file.split(sep);
                if (parts.at(-1) === '.git') {
                  discovered = undefined;
                  schedule();
                } else if (_event === 'rename' && !parts.includes('.git')) {
                  void stat(resolve(cwd, file))
                    .then((entry) => {
                      if (entry.isDirectory()) {
                        discovered = undefined;
                        schedule();
                      }
                    })
                    .catch(() => {
                      /** 删除普通文件不需要重新发现全部仓库，只有仓库或其父目录消失才重扫。 */
                      const removed = parts.join('/');
                      if (discovered?.some((repository) => repository.relativePath === removed || repository.relativePath.startsWith(`${removed}/`))) {
                        discovered = undefined;
                        schedule();
                      }
                    });
                }
              });
              directoryWatcher.on('error', recoverDirectoryWatcher);
              clearInterval(directoryFallback);
              directoryFallback = undefined;
            } catch {
              recoverDirectoryWatcher();
            }
          }
        }
        /** 聚合前逐仓读取，窗口间由共享 entry 合并在途请求。 */
        for (const source of sources) {
          if (!active) return;
          const entry = await this.entry(source, schedule);
          if (!active) {
            this.releaseEntry(entry, schedule);
            return;
          }
          held.set(entry.key, entry);
          repositories.set(source.id, entry);
          used.add(entry.key);
          const review = initialSnapshot && entry.snapshot ? entry.snapshot : await this.read(entry);
          if (initialSnapshot && entry.loadedRevision !== entry.revision) cachedPreview = true;
          if (entry.loadedRevision !== entry.revision) pending = true;
          if (source.path === cwd || (!scope.taskId && !summary.branch)) summary.branch = review.branch || null;
          /** 与交付页使用相同的嵌套目录占位过滤，暂存和未暂存路径只计一次。 */
          const paths = new Set(
            [...review.stagedFiles, ...review.unstagedFiles, ...review.untrackedFiles]
              .filter((file) => !(file.indexStatus === '?' && file.path.endsWith('/') && source.nestedPaths?.includes(file.path.slice(0, -1))))
              .map((file) => file.path),
          );
          summary.files += paths.size;
          for (const diff of [...review.stagedDiff.fileDiffs, ...review.unstagedDiff.fileDiffs].filter((file) => paths.has(file.newPath) || paths.has(file.oldPath))) {
            summary.additions += diff.addedLines;
            summary.deletions += diff.deletedLines;
          }
        }
        /** 文件内容或路径变化也要通知交付页，不能只按文件数及增删行数去重。 */
        send(cachedPreview ? 'git.summary.cached' : 'git.summary.updated', { summary, revisions: sources.map((source) => [source.id, repositories.get(source.id)?.loadedRevision]) });
        initialSnapshot = false;
        failureCount = 0;
      } catch (error) {
        send('git.summary.error', { message: error instanceof Error ? error.message : 'Git 状态读取失败。' });
        if (active)
          retryTimer = setTimeout(
            () => {
              retryTimer = undefined;
              schedule();
            },
            Math.min(1_000 * 2 ** Math.min(failureCount++, 5), 30_000),
          );
      } finally {
        for (const [key, entry] of held) if (!used.has(key)) release(key, entry);
        running = false;
        if (pending) schedule();
      }
    };
    /** 业务变化保留已显示结果，后台重新核对当前目录集合。 */
    const subscription = {
      projectId,
      invalidate: (repositoryId?: string) => {
        const changed = repositoryId ? repositories.get(repositoryId) : undefined;
        if (changed) changed.revision += 1;
        else {
          discovered = undefined;
          directoryWatcher?.close();
          directoryWatcher = undefined;
          for (const entry of held.values()) entry.revision += 1;
        }
        schedule();
      },
      close: () => {
        if (!active) return;
        active = false;
        clearTimeout(timer);
        clearTimeout(deadline);
        clearTimeout(retryTimer);
        directoryWatcher?.close();
        clearInterval(directoryFallback);
        for (const [key, entry] of held) release(key, entry);
        this.subscriptions.delete(subscription);
        socket.close();
      },
    };
    this.subscriptions.add(subscription);
    socket.on('close', subscription.close);
    send('server.connected', {});
    void refresh();
  }

  /** 初始化文件监听先于读取，避免首次读取期间丢失变化。 */
  private async entry(source: SummarySource, listener: () => void): Promise<SummaryEntry> {
    const path = await realpath(source.path);
    /** 排除范围属于摘要语义，不能让不同范围错误共用缓存。 */
    const key = JSON.stringify([path, [...source.ignoredPaths].sort()]);
    /** 重新使用仍在监听的条目，不因会话或窗口切换强制失效。 */
    clearTimeout(this.idleEntries.get(key)?.timer);
    this.idleEntries.delete(key);
    let pending = this.entries.get(key);
    if (!pending) {
      /** 初始化期间先保留订阅，避免另一个关闭中的窗口释放即将共用的监听。 */
      const listeners = new Set([listener]);
      const promise = this.createEntry(key, path, source.ignoredPaths, listeners);
      pending = { promise, listeners };
      this.entries.set(key, pending);
      void promise.catch(() => {
        if (this.entries.get(key)?.promise === promise) this.entries.delete(key);
      });
    } else pending.listeners.add(listener);
    return pending.promise;
  }

  /** 工作目录与 Git 元数据分别监听，common directory 不作为工作树缓存身份。 */
  private async createEntry(key: string, path: string, ignoredPaths: string[], listeners: Set<() => void>): Promise<SummaryEntry> {
    const entry: SummaryEntry = { key, path, ignoredPaths, revision: 0, loadedRevision: -1, watchers: [], listeners };
    /** 事件只使摘要失效，不直接启动 Git 子进程。 */
    const invalidate = (): void => {
      entry.revision += 1;
      for (const listener of entry.listeners) listener();
    };
    /** 平台监听不可用时保留有界恢复核对，最后一个订阅关闭时撤销。 */
    const fallback = (): void => {
      entry.fallback ??= setInterval(invalidate, 30_000);
      entry.fallback.unref();
    };
    try {
      const [directory, common] = await Promise.all([readGit('git', ['rev-parse', '--absolute-git-dir'], { cwd: path, timeout: 15_000 }).then((result) => realpath(result.stdout.trim())), getGitCommonDirectory(path)]);
      for (const root of new Set([path, directory, common])) {
        try {
          const watcher = watch(root, { recursive: true }, (_event, file) => {
            if (!file) return invalidate();
            const name = file.split(sep).join('/');
            if (root === path) {
              if (name.split('/').includes('.git') || ignoredPaths.some((ignored) => name === ignored || name.startsWith(`${ignored}/`))) return;
            } else if (!/^(?:HEAD$|ORIG_HEAD$|index$|config$|packed-refs$|MERGE_HEAD$|CHERRY_PICK_HEAD$|REVERT_HEAD$|refs(?:\/|$)|reftable(?:\/|$)|rebase-merge(?:\/|$)|rebase-apply(?:\/|$)|info\/exclude$)/u.test(name)) return;
            invalidate();
          });
          watcher.on('error', () => {
            watcher.close();
            fallback();
            invalidate();
          });
          entry.watchers.push(watcher);
        } catch {
          fallback();
        }
      }
      return entry;
    } catch (error) {
      for (const watcher of entry.watchers) watcher.close();
      clearInterval(entry.fallback);
      throw error;
    }
  }

  /** 同一版本复用结果；读取期间的新事件保留为下一轮待刷新。 */
  private read(entry: SummaryEntry): Promise<TaskWorkspaceReview> {
    if (entry.request) return entry.request;
    if (entry.snapshot && entry.loadedRevision === entry.revision) return Promise.resolve(entry.snapshot);
    /** 快照只代表开始读取时的变化次数，迟到事件仍需后续核对。 */
    const revision = entry.revision;
    entry.request = getTaskWorkspaceReview(entry.path, entry.ignoredPaths)
      .then((snapshot) => {
        entry.snapshot = snapshot;
        entry.loadedRevision = revision;
        return snapshot;
      })
      .finally(() => {
        entry.request = undefined;
      });
    return entry.request;
  }
}
