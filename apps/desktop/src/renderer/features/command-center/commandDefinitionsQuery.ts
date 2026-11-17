import { CachedQuery } from '../../cachedQuery.js';
import type { CommandDefinition } from '@zeus/shared';
import type { CommandCenterApiClient } from './commandCenterApiClient.js';

/** 命令定义缓存只属于当前客户端，跨项目最多保留十六个目录。 */
const definitionsByClient = new WeakMap<CommandCenterApiClient, Map<string, CachedQuery<CommandDefinition[]>>>();

/** 全局目录与各项目目录独立读取，短暂返回同一页面不重做网络往返。 */
export function commandDefinitionsQuery(client: CommandCenterApiClient, mode: 'global' | 'project', projectId?: string): CachedQuery<CommandDefinition[]> {
  const queries = definitionsByClient.get(client) ?? new Map<string, CachedQuery<CommandDefinition[]>>();
  const key = mode === 'global' ? 'global' : `project:${projectId ?? ''}`;
  const query = queries.get(key) ?? new CachedQuery(() => (mode === 'global' ? client.loadGlobalCommands() : projectId ? client.loadProjectCommands(projectId) : Promise.resolve([])), 30_000);
  queries.delete(key);
  queries.set(key, query);
  while (queries.size > 16) queries.delete(queries.keys().next().value!);
  definitionsByClient.set(client, queries);
  return query;
}

/** 项目目录可能包含全局定义；任一写入使当前客户端的派生目录失效。 */
export function invalidateCommandDefinitions(client: CommandCenterApiClient): void {
  for (const query of definitionsByClient.get(client)?.values() ?? []) query.invalidate();
}
