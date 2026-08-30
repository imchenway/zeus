export const storageTableOwnerIds = [
  'storage_platform',
  'integration_platform',
  'agent_runtime',
  'memory_governance',
  'work_management',
  'conversation_orchestration',
  'execution_assets',
  'code_intelligence',
  'projection_indexer',
  'cache_manager',
] as const;

export type StorageTableOwnerId = (typeof storageTableOwnerIds)[number];

export interface StorageTableOwnershipRecord {
  table: string;
  owner: StorageTableOwnerId;
  documentationOwnerLabel: string;
  authorityClass: 'Z' | 'E' | 'M' | 'D' | 'R' | 'A' | 'mixed';
}

export interface StorageAuxiliaryTableOwnershipRecord extends StorageTableOwnershipRecord {
  database: 'projection_index' | 'projection_cache';
  authorityClass: 'D' | 'R';
}

const ownershipGroups = [
  {
    owner: 'storage_platform',
    documentationOwnerLabel: '存储平台',
    authorityClass: 'E',
    tables: [
      'schema_migrations',
      'conversation_sync_event_streams',
      'conversation_sync_events',
      'conversation_store_metadata',
      'conversation_migration_mappings',
      'conversation_legacy_write_fence',
      'conversation_legacy_cutover_metadata',
      'execution_host_handoffs',
      'execution_host_handoff_requests',
    ],
  },
  {
    owner: 'integration_platform',
    documentationOwnerLabel: '集成与平台',
    authorityClass: 'mixed',
    tables: [
      'settings',
      'audit_logs',
      'event_log',
      'idempotency_requests',
      'command_inbox',
      'command_outbox',
      'command_delivery_receipts',
      'plugin_registrations',
      'plugin_revisions',
      'plugin_marketplaces',
      'plugin_hook_trust',
      'plugin_connector_bindings',
      'plugin_mcp_policies',
      'im_connections',
      'im_trusted_endpoints',
      'im_pairing_sessions',
      'im_chat_bindings',
      'im_inbound_receipts',
      'im_delivery_cursors',
      'im_action_capabilities',
      'im_connection_logs',
    ],
  },
  {
    owner: 'agent_runtime',
    documentationOwnerLabel: 'Agent Runtime',
    authorityClass: 'mixed',
    tables: ['provider_event_receipts', 'conversation_provider_item_states', 'agent_capability_snapshots', 'codex_usage_ledger', 'codex_legacy_imports'],
  },
  {
    owner: 'memory_governance',
    documentationOwnerLabel: 'Memory 治理层',
    authorityClass: 'M',
    tables: ['long_term_memories'],
  },
  {
    owner: 'work_management',
    documentationOwnerLabel: '工作管理',
    authorityClass: 'mixed',
    tables: [
      'projects',
      'project_repositories',
      'project_shared_paths',
      'tasks',
      'task_relations',
      'task_templates',
      'task_events',
      'task_event_file_projection_outbox',
      'task_board_views',
      'task_board_positions',
      'task_environments',
      'task_workspaces',
      'task_integrations',
      'task_integration_attempts',
      'task_workflows',
      'task_stages',
      'task_stage_attempts',
      'task_stage_deliverables',
      'task_work_items',
      'task_work_runs',
      'task_work_deliverables',
      'task_work_decisions',
      'digital_employee_templates',
      'digital_employees',
      'digital_employee_automations',
      'digital_employee_executions',
      'digital_employee_event_receipts',
    ],
  },
  {
    owner: 'conversation_orchestration',
    documentationOwnerLabel: '会话编排',
    authorityClass: 'mixed',
    tables: [
      'conversations',
      'conversation_submissions',
      'conversation_turns',
      'conversation_goals',
      'conversation_goal_events',
      'conversation_plan_actions',
      'conversation_execution_snapshots',
      'conversation_runtime_segments',
      'conversation_switch_operations',
      'conversation_timeline_events',
      'conversation_model_history',
      'cold_evidence_sources',
      'cold_evidence_anchors',
      'conversation_process_items',
      'conversation_portable_contexts',
      'conversation_context_checkpoints',
      'conversation_model_requests',
      'conversation_config_evidence',
      'conversation_persistent_warnings',
      'conversation_recovery_events',
      'conversation_plugin_activations',
      'conversation_plugin_activation_sets',
      'conversation_sequence_counters',
      'conversation_server_requests',
      'conversation_provider_sync_checkpoints',
      'conversation_items',
      'conversation_messages',
      'conversation_message_provider_aliases',
    ],
  },
  {
    owner: 'execution_assets',
    documentationOwnerLabel: '执行与资产',
    authorityClass: 'mixed',
    tables: [
      'conversation_tool_results',
      'conversation_resources',
      'conversation_session_file_edit_grants',
      'runtime_sessions',
      'runtime_logs',
      'terminal_events',
      'command_definitions',
      'command_aliases',
      'command_runs',
      'command_artifacts',
      'git_snapshots',
      'git_changes',
      'turn_change_sets',
      'turn_change_files',
      'artifact_objects',
      'artifact_owners',
      'artifact_staging_operations',
      'artifact_gc_manifests',
      'artifact_gc_manifest_items',
      'artifact_retention_holds',
      'artifact_capacity_samples',
      'artifact_storage_faults',
    ],
  },
  {
    owner: 'code_intelligence',
    documentationOwnerLabel: '代码智能',
    authorityClass: 'D',
    tables: ['code_symbols', 'project_nodes', 'project_edges', 'graph_views'],
  },
] as const satisfies ReadonlyArray<{
  owner: StorageTableOwnerId;
  documentationOwnerLabel: string;
  authorityClass: StorageTableOwnershipRecord['authorityClass'];
  tables: readonly string[];
}>;

/** ZARCH-003 的逐表 owner 机器清单；顺序稳定，可用于文档/schema 差异门禁。 */
export const storageTableOwnership: readonly StorageTableOwnershipRecord[] = ownershipGroups.flatMap((group) =>
  group.tables.map((table) => ({ table, owner: group.owner, documentationOwnerLabel: group.documentationOwnerLabel, authorityClass: group.authorityClass })),
);

/** 可删除重建的独立派生数据库表；不得与 Core 92 表或其备份边界混为一谈。 */
export const storageAuxiliaryTableOwnership: readonly StorageAuxiliaryTableOwnershipRecord[] = [
  ...[
    'projection_metadata',
    'conversation_search_documents',
    'conversation_search_fts',
    'conversation_turn_documents',
    'conversation_projection_watermarks',
    'graph_node_documents',
    'graph_edge_documents',
    'code_symbol_documents',
    'projection_gaps',
  ].map(
    (table): StorageAuxiliaryTableOwnershipRecord => ({
      database: 'projection_index',
      table,
      owner: 'projection_indexer',
      documentationOwnerLabel: '投影索引器',
      authorityClass: 'D',
    }),
  ),
  ...['cache_metadata', 'cache_entries'].map(
    (table): StorageAuxiliaryTableOwnershipRecord => ({
      database: 'projection_cache',
      table,
      owner: 'cache_manager',
      documentationOwnerLabel: '缓存管理器',
      authorityClass: 'R',
    }),
  ),
];

export function storageTableOwner(table: string): StorageTableOwnershipRecord | undefined {
  return storageTableOwnership.find((record) => record.table === table);
}
