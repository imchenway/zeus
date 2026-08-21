import { statSync } from 'node:fs';
import { type CommandDefinition, isTaskAttachmentField, type TaskAttachmentField, validateCommandDefinitionInput } from '@zeus/shared';
import { CommandDefinitionRepository, isTaskManagementStatus, isTaskType, type TaskManagementStatus, type TaskType, type ZeusDatabase } from '@zeus/storage';

export interface LocalDataExportSnapshot {
  app: 'Zeus';
  schemaVersion: 1 | 2;
  exportedAt: string;
  redaction: {
    secretsRedacted: true;
  };
  data: {
    projects: PortableProjectRecord[];
    tasks: PortableTaskRecord[];
    taskEvents: PortableTaskEventRecord[];
    taskTemplates: PortableTaskTemplateRecord[];
    commandDefinitions?: CommandDefinition[];
  };
}

export interface ImportLocalDataResult {
  imported: boolean;
  importedCounts: {
    projects: number;
    tasks: number;
    taskEvents: number;
    taskTemplates: number;
    commandDefinitions: number;
  };
  importedAt: string;
}

export interface PortableProjectRecord {
  id: string;
  name: string;
  slug: string;
  localPath: string;
  description: string | null;
  note: string | null;
  defaultTemplateId: string | null;
  scanStatus: string;
  createdAt: string;
  updatedAt: string;
}

export interface PortableTaskRecord {
  id: string;
  projectId: string;
  title: string;
  taskType?: TaskType;
  description: string;
  defectCurrentState?: string;
  defectExpectedOutcome?: string;
  defectReproductionSteps?: string;
  optimizationCurrentState?: string;
  optimizationExpectedOutcome?: string;
  managementStatus?: TaskManagementStatus;
  status: string;
  tags: string[];
  templateId: string | null;
  taskCode?: string;
  taskSequence?: number | null;
  priority?: string;
  createdFrom: string;
  sourceContextJson: string;
  createdAt: string;
  updatedAt: string;
}

export interface PortableTaskEventRecord {
  id: string;
  taskId: string;
  eventType: string;
  title: string;
  payloadJson: string;
  createdAt: string;
}

export interface PortableTaskTemplateRecord {
  id: string;
  name: string;
  description: string;
  category: string;
  promptTemplate: string;
  defaultOptionsJson: string;
  projectId: string | null;
  builtIn: boolean;
  createdAt: string;
  updatedAt: string;
}

export function exportLocalBusinessData(db: ZeusDatabase, exportedAt: string): LocalDataExportSnapshot {
  const projects = db
    .select<PortableProjectDbRow>(
      `SELECT id, name, slug, local_path, description, note, default_template_id, scan_status, created_at, updated_at
     FROM projects WHERE deleted_at IS NULL ORDER BY created_at ASC, id ASC`,
    )
    .map(mapPortableProjectRow);
  const projectIds = new Set(projects.map((project) => project.id));
  const tasks = db
    .select<PortableTaskDbRow>(
      `SELECT id,
                project_id,
                title,
                task_type,
                description,
                defect_current_state,
                defect_expected_outcome,
                defect_reproduction_steps,
                optimization_current_state,
                optimization_expected_outcome,
                management_status,
                status,
                tags_json,
                template_id,
                task_code,
                task_sequence,
                priority,
                created_from,
                source_context_json,
                created_at,
                updated_at
     FROM tasks WHERE deleted_at IS NULL ORDER BY created_at ASC, id ASC`,
    )
    .map(mapPortableTaskRow)
    .filter((task) => projectIds.has(task.projectId));
  const taskIds = new Set(tasks.map((task) => task.id));
  const taskEvents = db
    .select<PortableTaskEventDbRow>(
      `SELECT id, task_id, event_type, title, payload_json, created_at
     FROM task_events ORDER BY created_at ASC, id ASC`,
    )
    .map(mapPortableTaskEventRow)
    .filter((event) => taskIds.has(event.taskId));
  const taskTemplates = db
    .select<PortableTaskTemplateDbRow>(
      `SELECT id, name, description, category, prompt_template, default_options_json, project_id, built_in, created_at, updated_at
     FROM task_templates WHERE deleted_at IS NULL AND built_in = 0 ORDER BY created_at ASC, id ASC`,
    )
    .map(mapPortableTaskTemplateRow)
    .filter((template) => !template.projectId || projectIds.has(template.projectId));
  const commandDefinitions = new CommandDefinitionRepository(db);
  const portableCommands = [...commandDefinitions.listGlobal(), ...projects.flatMap((project) => commandDefinitions.listProject(project.id))];
  return {
    app: 'Zeus',
    schemaVersion: 2,
    exportedAt,
    redaction: { secretsRedacted: true },
    data: { projects, tasks, taskEvents, taskTemplates, commandDefinitions: portableCommands },
  };
}

/** 导入计划必须在任何 Artifact/SQLite mutation 之前完整验证，不能再静默 filter 非法记录。 */
export function validateLocalBusinessDataImport(db: ZeusDatabase, snapshot: LocalDataExportSnapshot): string | null {
  if (!Array.isArray(snapshot.data.projects) || !snapshot.data.projects.every(isPortableProjectRecord)) return 'data.projects contains an invalid project record';
  if (!Array.isArray(snapshot.data.tasks) || !snapshot.data.tasks.every(isPortableTaskRecord)) return 'data.tasks contains an invalid task record';
  if (!Array.isArray(snapshot.data.taskEvents) || !snapshot.data.taskEvents.every(isPortableTaskEventRecord)) return 'data.taskEvents contains an invalid task event record';
  if (!Array.isArray(snapshot.data.taskTemplates) || !snapshot.data.taskTemplates.every((template) => isPortableTaskTemplateRecord(template) && !template.builtIn)) {
    return 'data.taskTemplates contains an invalid or built-in template';
  }
  const projects = snapshot.data.projects;
  const projectIds = new Set(projects.map((project) => project.id));
  if (projectIds.size !== projects.length) return 'data.projects contains duplicate ids';
  const tasks = snapshot.data.tasks;
  const taskIds = new Set(tasks.map((task) => task.id));
  if (taskIds.size !== tasks.length || tasks.some((task) => !projectIds.has(task.projectId))) return 'data.tasks contains duplicate ids or a missing project reference';
  const taskEvents = snapshot.data.taskEvents;
  if (new Set(taskEvents.map((event) => event.id)).size !== taskEvents.length || taskEvents.some((event) => !taskIds.has(event.taskId))) return 'data.taskEvents contains duplicate ids or a missing task reference';
  const templates = snapshot.data.taskTemplates;
  if (new Set(templates.map((template) => template.id)).size !== templates.length || templates.some((template) => template.projectId && !projectIds.has(template.projectId))) {
    return 'data.taskTemplates contains duplicate ids or a missing project reference';
  }
  const commands = snapshot.schemaVersion >= 2 ? snapshot.data.commandDefinitions : [];
  if (snapshot.schemaVersion >= 2 && (!Array.isArray(commands) || !commands.every((command) => isPortableCommandDefinition(command) && (command.scope === 'global' || (command.projectId !== null && projectIds.has(command.projectId)))))) {
    return 'data.commandDefinitions contains an invalid command or project reference';
  }
  if (Array.isArray(commands)) {
    if (new Set(commands.map((command) => command.id)).size !== commands.length) return 'data.commandDefinitions contains duplicate ids';
    const repository = new CommandDefinitionRepository(db);
    for (const command of commands) {
      if (repository.findTokenConflicts({ scope: command.scope, projectId: command.projectId, tokens: [command.name, ...command.aliases], excludeCommandId: command.id }).length > 0) {
        return `data.commandDefinitions conflicts with an existing command token: ${command.name}`;
      }
    }
  }
  return null;
}

export function plannedLocalBusinessDataImportCounts(snapshot: LocalDataExportSnapshot): ImportLocalDataResult['importedCounts'] {
  return {
    projects: snapshot.data.projects.length,
    tasks: snapshot.data.tasks.length,
    taskEvents: snapshot.data.taskEvents.length,
    taskTemplates: snapshot.data.taskTemplates.length,
    commandDefinitions: snapshot.schemaVersion >= 2 && Array.isArray(snapshot.data.commandDefinitions) ? snapshot.data.commandDefinitions.length : 0,
  };
}

export function importLocalBusinessData(db: ZeusDatabase, snapshot: LocalDataExportSnapshot): ImportLocalDataResult['importedCounts'] {
  const projects = Array.isArray(snapshot.data.projects) ? snapshot.data.projects.filter(isPortableProjectRecord) : [];
  const projectIds = new Set(projects.map((project) => project.id));
  const taskTemplates = Array.isArray(snapshot.data.taskTemplates)
    ? snapshot.data.taskTemplates.filter((template) => isPortableTaskTemplateRecord(template) && !template.builtIn && (!template.projectId || projectIds.has(template.projectId)))
    : [];
  const tasks = Array.isArray(snapshot.data.tasks) ? snapshot.data.tasks.filter((task) => isPortableTaskRecord(task) && projectIds.has(task.projectId)) : [];
  const taskIds = new Set(tasks.map((task) => task.id));
  const taskEvents = Array.isArray(snapshot.data.taskEvents) ? snapshot.data.taskEvents.filter((event) => isPortableTaskEventRecord(event) && taskIds.has(event.taskId)) : [];

  for (const project of projects) {
    // 导入保留原 ID，保证任务、模板和事件仍能关联到真实项目；不写入任何密钥或运行产物。
    db.execute(
      `INSERT OR REPLACE INTO projects (id, name, slug, local_path, description, note, default_template_id, scan_status, created_at, updated_at, archived, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)`,
      [project.id, project.name, project.slug, project.localPath, project.description, project.note ?? null, project.defaultTemplateId, project.scanStatus, project.createdAt, project.updatedAt],
    );
  }
  for (const template of taskTemplates) {
    db.execute(
      `INSERT OR REPLACE INTO task_templates (id, name, description, category, prompt_template, default_options_json, built_in, sort_order, project_id, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, NULL)`,
      [template.id, template.name, template.description, template.category, template.promptTemplate, template.defaultOptionsJson, template.projectId, template.createdAt, template.updatedAt],
    );
  }
  for (const task of tasks) {
    const taskType = isTaskType(task.taskType) ? task.taskType : 'requirement';
    db.execute(
      `INSERT OR REPLACE INTO tasks (id, project_id, title, task_type, description, defect_current_state, defect_expected_outcome, defect_reproduction_steps,
        optimization_current_state, optimization_expected_outcome, management_status, status, tags_json, template_id, task_code, task_sequence, priority, created_from, source_context_json, archived, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL)`,
      [
        task.id,
        task.projectId,
        task.title,
        taskType,
        task.description,
        task.defectCurrentState ?? '',
        task.defectExpectedOutcome ?? '',
        task.defectReproductionSteps ?? '',
        task.optimizationCurrentState ?? '',
        task.optimizationExpectedOutcome ?? '',
        isTaskManagementStatus(task.managementStatus) ? task.managementStatus : 'todo',
        task.status,
        JSON.stringify(task.tags),
        task.templateId,
        task.taskCode ?? null,
        task.taskSequence ?? null,
        task.priority ?? 'normal',
        task.createdFrom,
        normalizeImportedTaskSourceContextJson(task.sourceContextJson, taskType),
        task.createdAt,
        task.updatedAt,
      ],
    );
  }
  for (const event of taskEvents) {
    db.execute(
      `INSERT OR REPLACE INTO task_events (id, task_id, event_type, title, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [event.id, event.taskId, event.eventType, event.title, event.payloadJson, event.createdAt],
    );
  }
  const commandRepository = new CommandDefinitionRepository(db);
  const commandDefinitions =
    snapshot.schemaVersion >= 2 && Array.isArray(snapshot.data.commandDefinitions)
      ? snapshot.data.commandDefinitions.filter((command) => isPortableCommandDefinition(command) && (command.scope === 'global' || (command.projectId !== null && projectIds.has(command.projectId))))
      : [];
  let importedCommandDefinitions = 0;
  for (const command of commandDefinitions) {
    const conflicts = commandRepository.findTokenConflicts({
      scope: command.scope,
      projectId: command.projectId,
      tokens: [command.name, ...command.aliases],
      excludeCommandId: command.id,
    });
    if (conflicts.length > 0) continue;
    db.execute(`DELETE FROM command_aliases WHERE command_id = ?`, [command.id]);
    db.execute(`DELETE FROM command_definitions WHERE id = ?`, [command.id]);
    commandRepository.create({
      ...command,
      id: command.id,
      scope: command.scope,
      projectId: command.projectId,
      enabled: false,
      telegramEnabled: false,
      revision: Math.max(1, command.revision),
      createdAt: command.createdAt,
    });
    importedCommandDefinitions += 1;
  }
  return {
    projects: projects.length,
    tasks: tasks.length,
    taskEvents: taskEvents.length,
    taskTemplates: taskTemplates.length,
    commandDefinitions: importedCommandDefinitions,
  };
}

/** 旧备份可能没有字段归属；导入时立即按任务类型固定归类，不等待下次启动。 */
export function normalizeImportedTaskSourceContextJson(sourceContextJson: string, taskType: unknown): string {
  try {
    const parsed = JSON.parse(sourceContextJson) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return '{}';
    const sourceContext = parsed as Record<string, unknown>;
    if (!Array.isArray(sourceContext.attachments)) return JSON.stringify(sourceContext);
    const field = historicalTaskAttachmentField(taskType);
    const attachments = sourceContext.attachments.map((attachment) =>
      attachment && typeof attachment === 'object' && !Array.isArray(attachment) && !isTaskAttachmentField((attachment as Record<string, unknown>).field) ? { ...(attachment as Record<string, unknown>), field } : attachment,
    );
    return JSON.stringify({ ...sourceContext, attachments });
  } catch {
    return '{}';
  }
}

function historicalTaskAttachmentField(taskType: unknown): TaskAttachmentField {
  if (taskType === 'defect') return 'defectCurrentState';
  if (taskType === 'optimization') return 'optimizationCurrentState';
  return 'description';
}

export function isPortableCommandDefinition(value: unknown): value is CommandDefinition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const command = value as Partial<CommandDefinition>;
  if (
    typeof command.id !== 'string' ||
    (command.scope !== 'global' && command.scope !== 'project') ||
    (command.projectId !== null && typeof command.projectId !== 'string') ||
    typeof command.name !== 'string' ||
    !Array.isArray(command.aliases) ||
    !command.aliases.every((alias) => typeof alias === 'string') ||
    typeof command.title !== 'string' ||
    typeof command.description !== 'string' ||
    typeof command.command !== 'string' ||
    !Array.isArray(command.parameters) ||
    typeof command.timeoutSeconds !== 'number' ||
    typeof command.revision !== 'number' ||
    typeof command.createdAt !== 'string' ||
    typeof command.updatedAt !== 'string'
  ) {
    return false;
  }
  return validateCommandDefinitionInput(command as CommandDefinition).length === 0;
}

export function findInvalidPortableProjectPaths(snapshot: LocalDataExportSnapshot): string[] {
  const projects = Array.isArray(snapshot.data.projects) ? snapshot.data.projects.filter(isPortableProjectRecord) : [];
  const invalidPaths: string[] = [];
  for (const project of projects) {
    const localPath = project.localPath.trim();
    if (!localPath || !localPath.startsWith('/') || localPath.includes('\0')) {
      invalidPaths.push(localPath || project.id);
      continue;
    }
    try {
      const info = statSync(localPath);
      if (!info.isDirectory()) invalidPaths.push(localPath);
    } catch {
      invalidPaths.push(localPath);
    }
  }
  return invalidPaths;
}

export interface PortableProjectDbRow {
  id: string;
  name: string;
  slug: string;
  local_path: string;
  description: string | null;
  note: string | null;
  default_template_id: string | null;
  scan_status: string;
  created_at: string;
  updated_at: string;
}

export interface PortableTaskDbRow {
  id: string;
  project_id: string;
  title: string;
  task_type: string;
  description: string;
  defect_current_state: string;
  defect_expected_outcome: string;
  defect_reproduction_steps: string;
  optimization_current_state: string;
  optimization_expected_outcome: string;
  management_status: string;
  status: string;
  tags_json: string;
  template_id: string | null;
  task_code: string | null;
  task_sequence: number | null;
  priority: string | null;
  created_from: string;
  source_context_json: string;
  created_at: string;
  updated_at: string;
}

export interface PortableTaskEventDbRow {
  id: string;
  task_id: string;
  event_type: string;
  title: string;
  payload_json: string;
  created_at: string;
}

export interface PortableTaskTemplateDbRow {
  id: string;
  name: string;
  description: string;
  category: string;
  prompt_template: string;
  default_options_json: string;
  project_id: string | null;
  built_in: number;
  created_at: string;
  updated_at: string;
}

export function mapPortableProjectRow(row: PortableProjectDbRow): PortableProjectRecord {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    localPath: row.local_path,
    description: row.description,
    note: row.note,
    defaultTemplateId: row.default_template_id,
    scanStatus: row.scan_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapPortableTaskRow(row: PortableTaskDbRow): PortableTaskRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    taskType: isTaskType(row.task_type) ? row.task_type : 'requirement',
    description: row.description,
    defectCurrentState: row.defect_current_state,
    defectExpectedOutcome: row.defect_expected_outcome,
    defectReproductionSteps: row.defect_reproduction_steps,
    optimizationCurrentState: row.optimization_current_state,
    optimizationExpectedOutcome: row.optimization_expected_outcome,
    managementStatus: isTaskManagementStatus(row.management_status) ? row.management_status : 'todo',
    status: row.status,
    tags: parseStringArrayJson(row.tags_json),
    templateId: row.template_id,
    taskCode: row.task_code ?? undefined,
    taskSequence: row.task_sequence,
    priority: row.priority ?? 'normal',
    createdFrom: row.created_from,
    sourceContextJson: row.source_context_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapPortableTaskEventRow(row: PortableTaskEventDbRow): PortableTaskEventRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    eventType: row.event_type,
    title: row.title,
    payloadJson: row.payload_json,
    createdAt: row.created_at,
  };
}

export function mapPortableTaskTemplateRow(row: PortableTaskTemplateDbRow): PortableTaskTemplateRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category,
    promptTemplate: row.prompt_template,
    defaultOptionsJson: row.default_options_json,
    projectId: row.project_id,
    builtIn: row.built_in === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function parseStringArrayJson(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export function isPortableProjectRecord(value: unknown): value is PortableProjectRecord {
  const record = value as Partial<PortableProjectRecord>;
  return (
    typeof record.id === 'string' &&
    typeof record.name === 'string' &&
    typeof record.slug === 'string' &&
    typeof record.localPath === 'string' &&
    typeof record.scanStatus === 'string' &&
    typeof record.createdAt === 'string' &&
    typeof record.updatedAt === 'string'
  );
}

export function isPortableTaskRecord(value: unknown): value is PortableTaskRecord {
  const record = value as Partial<PortableTaskRecord>;
  return (
    typeof record.id === 'string' &&
    typeof record.projectId === 'string' &&
    typeof record.title === 'string' &&
    typeof record.description === 'string' &&
    typeof record.status === 'string' &&
    Array.isArray(record.tags) &&
    typeof record.createdFrom === 'string' &&
    typeof record.sourceContextJson === 'string' &&
    typeof record.createdAt === 'string' &&
    typeof record.updatedAt === 'string'
  );
}

export function isPortableTaskEventRecord(value: unknown): value is PortableTaskEventRecord {
  const record = value as Partial<PortableTaskEventRecord>;
  return typeof record.id === 'string' && typeof record.taskId === 'string' && typeof record.eventType === 'string' && typeof record.title === 'string' && typeof record.payloadJson === 'string' && typeof record.createdAt === 'string';
}

export function isPortableTaskTemplateRecord(value: unknown): value is PortableTaskTemplateRecord {
  const record = value as Partial<PortableTaskTemplateRecord>;
  return (
    typeof record.id === 'string' &&
    typeof record.name === 'string' &&
    typeof record.description === 'string' &&
    typeof record.category === 'string' &&
    typeof record.promptTemplate === 'string' &&
    typeof record.defaultOptionsJson === 'string' &&
    typeof record.builtIn === 'boolean' &&
    typeof record.createdAt === 'string' &&
    typeof record.updatedAt === 'string'
  );
}
