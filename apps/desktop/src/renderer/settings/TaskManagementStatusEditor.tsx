import { useEffect, useState } from 'react';
import type { TaskManagementStatusConfig, TaskManagementStatusDefinition } from '@zeus/shared';
import { normalizeTaskManagementStatusConfig } from '@zeus/shared';
import { Button } from '../ui/Button.js';
import { ModalPortal } from '../ui/ModalPortal.js';
import { ZeusSelect } from '../ZeusSelect.js';

interface PendingStatusDeletion {
  statusId: string;
  replacementStatusId: string;
  taskCount: number;
}

export interface TaskManagementStatusEditorProps {
  language: 'zh-CN' | 'en-US';
  config: TaskManagementStatusConfig;
  usageCounts: Record<string, number>;
  labelForStatus: (status: TaskManagementStatusDefinition) => string;
  onChange: (config: TaskManagementStatusConfig, deletion?: { removedStatusId: string; replacementStatusId?: string }) => void;
}

const newStatusColors = ['#3b82f6', '#8b5cf6', '#16a34a', '#d97706', '#dc2626', '#0891b2', '#db2777', '#6b7280'];

function createStatusId(existingIds: Set<string>): string {
  const randomPart = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID().replaceAll('-', '').slice(0, 12) : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  let candidate = `status_${randomPart}`;
  let suffix = 1;
  while (existingIds.has(candidate)) {
    candidate = `status_${randomPart}_${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function moveStatus(config: TaskManagementStatusConfig, statusId: string, targetIndex: number): TaskManagementStatusConfig {
  const sourceIndex = config.statuses.findIndex((status) => status.id === statusId);
  if (sourceIndex < 0 || targetIndex < 0 || targetIndex >= config.statuses.length || sourceIndex === targetIndex) return config;
  const statuses = config.statuses.map((status) => ({ ...status }));
  const [moved] = statuses.splice(sourceIndex, 1);
  statuses.splice(targetIndex, 0, moved);
  return { statuses, roles: { ...config.roles } };
}

function removeStatus(config: TaskManagementStatusConfig, statusId: string, replacementStatusId?: string): TaskManagementStatusConfig {
  const statuses = config.statuses.filter((status) => status.id !== statusId).map((status) => ({ ...status }));
  if (statuses.length === 0) return config;
  const fallbackStatusId = replacementStatusId && statuses.some((status) => status.id === replacementStatusId) ? replacementStatusId : statuses[0].id;
  const roles = { ...config.roles };
  for (const roleName of Object.keys(roles) as Array<keyof typeof roles>) {
    if (roles[roleName] === statusId) roles[roleName] = fallbackStatusId;
  }
  return normalizeTaskManagementStatusConfig({ statuses, roles }, config);
}

function StatusNameInput(props: { language: 'zh-CN' | 'en-US'; index: number; displayName: string; onCommit: (label: string) => void }) {
  const [value, setValue] = useState(props.displayName);
  useEffect(() => setValue(props.displayName), [props.displayName]);
  const commit = (): void => {
    const label = value.trim();
    if (!label) {
      setValue(props.displayName);
      return;
    }
    props.onCommit(label);
  };
  return (
    <label className="task-status-config-name">
      <span className="sr-only">{props.language === 'zh-CN' ? `状态 ${props.index + 1} 名称` : `Status ${props.index + 1} name`}</span>
      <input
        type="text"
        maxLength={48}
        value={value}
        aria-label={props.language === 'zh-CN' ? `修改状态 ${props.displayName} 的名称` : `Rename status ${props.displayName}`}
        onChange={(event) => setValue(event.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
          if (event.key === 'Escape') {
            setValue(props.displayName);
            event.currentTarget.blur();
          }
        }}
      />
    </label>
  );
}

export function TaskManagementStatusEditor(props: TaskManagementStatusEditorProps) {
  const zh = props.language === 'zh-CN';
  const [draggedStatusId, setDraggedStatusId] = useState<string | null>(null);
  const [pendingDeletion, setPendingDeletion] = useState<PendingStatusDeletion | null>(null);
  const roleStatusIds = new Set(Object.values(props.config.roles));

  const requestDelete = (status: TaskManagementStatusDefinition): void => {
    if (props.config.statuses.length <= 1) return;
    const alternatives = props.config.statuses.filter((candidate) => candidate.id !== status.id);
    const taskCount = props.usageCounts[status.id] ?? 0;
    if (taskCount === 0 && !roleStatusIds.has(status.id)) {
      props.onChange(removeStatus(props.config, status.id), { removedStatusId: status.id });
      return;
    }
    setPendingDeletion({ statusId: status.id, replacementStatusId: alternatives[0]?.id ?? '', taskCount });
  };

  const addStatus = (): void => {
    const existingIds = new Set(props.config.statuses.map((status) => status.id));
    const id = createStatusId(existingIds);
    const definition: TaskManagementStatusDefinition = {
      id,
      label: zh ? '新状态' : 'New status',
      color: newStatusColors[props.config.statuses.length % newStatusColors.length],
    };
    props.onChange({ statuses: [...props.config.statuses.map((status) => ({ ...status })), definition], roles: { ...props.config.roles } });
  };

  const deletingStatus = pendingDeletion ? props.config.statuses.find((status) => status.id === pendingDeletion.statusId) : undefined;
  const deletionAlternatives = pendingDeletion ? props.config.statuses.filter((status) => status.id !== pendingDeletion.statusId) : [];

  return (
    <section className="task-status-config-editor" aria-label={zh ? '任务状态配置' : 'Task status configuration'}>
      <ol className="task-status-config-list">
        {props.config.statuses.map((status, index) => (
          <li
            key={status.id}
            className={draggedStatusId === status.id ? 'dragging' : undefined}
            onDragOver={(event) => {
              if (draggedStatusId) event.preventDefault();
            }}
            onDrop={(event) => {
              event.preventDefault();
              if (draggedStatusId) props.onChange(moveStatus(props.config, draggedStatusId, index));
              setDraggedStatusId(null);
            }}
          >
            <button
              type="button"
              className="task-status-config-drag-handle"
              draggable
              aria-label={zh ? `拖动 ${props.labelForStatus(status)}` : `Drag ${props.labelForStatus(status)}`}
              title={zh ? '拖动调整顺序' : 'Drag to reorder'}
              onDragStart={(event) => {
                setDraggedStatusId(status.id);
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', status.id);
              }}
              onDragEnd={() => setDraggedStatusId(null)}
            >
              <span aria-hidden="true">⋮⋮</span>
            </button>
            <span className="task-status-config-rank" aria-hidden="true">
              {index + 1}
            </span>
            <StatusNameInput
              language={props.language}
              index={index}
              displayName={props.labelForStatus(status)}
              onCommit={(label) =>
                props.onChange({
                  statuses: props.config.statuses.map((candidate) => (candidate.id === status.id ? { ...candidate, label } : { ...candidate })),
                  roles: { ...props.config.roles },
                })
              }
            />
            <label className="task-status-config-color">
              <span className="sr-only">{zh ? `${props.labelForStatus(status)} 的颜色` : `Color for ${props.labelForStatus(status)}`}</span>
              <input
                type="color"
                value={status.color}
                aria-label={zh ? `修改状态 ${props.labelForStatus(status)} 的颜色` : `Change color for ${props.labelForStatus(status)}`}
                onChange={(event) => {
                  const color = event.currentTarget.value;
                  props.onChange({
                    statuses: props.config.statuses.map((candidate) => (candidate.id === status.id ? { ...candidate, color } : { ...candidate })),
                    roles: { ...props.config.roles },
                  });
                }}
              />
              <span aria-hidden="true">{status.color.toUpperCase()}</span>
            </label>
            <span className="task-status-config-actions">
              <button type="button" aria-label={zh ? `上移 ${props.labelForStatus(status)}` : `Move ${props.labelForStatus(status)} up`} disabled={index === 0} onClick={() => props.onChange(moveStatus(props.config, status.id, index - 1))}>
                ↑
              </button>
              <button
                type="button"
                aria-label={zh ? `下移 ${props.labelForStatus(status)}` : `Move ${props.labelForStatus(status)} down`}
                disabled={index === props.config.statuses.length - 1}
                onClick={() => props.onChange(moveStatus(props.config, status.id, index + 1))}
              >
                ↓
              </button>
              <button
                type="button"
                className="task-status-config-delete"
                aria-label={zh ? `删除 ${props.labelForStatus(status)}` : `Delete ${props.labelForStatus(status)}`}
                disabled={props.config.statuses.length <= 1}
                onClick={() => requestDelete(status)}
              >
                ×
              </button>
            </span>
          </li>
        ))}
      </ol>
      <Button variant="secondary" size="compact" onClick={addStatus}>
        {zh ? '新增状态' : 'Add status'}
      </Button>
      {pendingDeletion && deletingStatus ? (
        <ModalPortal rootClassName="task-status-delete-portal" backdropClassName="task-create-modal-backdrop" onDismiss={() => setPendingDeletion(null)}>
          <section className="task-status-delete-dialog zeus-solid-form-surface" role="dialog" aria-modal="true" aria-labelledby="task-status-delete-title">
            <header>
              <strong id="task-status-delete-title">{zh ? `删除“${props.labelForStatus(deletingStatus)}”` : `Delete “${props.labelForStatus(deletingStatus)}”`}</strong>
              <p>
                {pendingDeletion.taskCount > 0
                  ? zh
                    ? `有 ${pendingDeletion.taskCount} 个任务正在使用这个状态。请选择替代状态，保存时会先迁移任务。`
                    : `${pendingDeletion.taskCount} tasks use this status. Choose a replacement; tasks will migrate before deletion.`
                  : zh
                    ? '这个状态承接现有任务行为。请选择接续该行为的替代状态。'
                    : 'This status carries existing task behavior. Choose a replacement for that behavior.'}
              </p>
            </header>
            <ZeusSelect
              size="regular"
              ariaLabel={zh ? '选择替代状态' : 'Choose replacement status'}
              value={pendingDeletion.replacementStatusId}
              onChange={(replacementStatusId) => setPendingDeletion((current) => (current ? { ...current, replacementStatusId } : current))}
              searchable={false}
              options={deletionAlternatives.map((status) => ({ value: status.id, label: props.labelForStatus(status), color: status.color }))}
            />
            <footer>
              <Button variant="secondary" onClick={() => setPendingDeletion(null)}>
                {zh ? '取消' : 'Cancel'}
              </Button>
              <Button
                variant="danger"
                disabled={!pendingDeletion.replacementStatusId}
                onClick={() => {
                  const replacementStatusId = pendingDeletion.replacementStatusId;
                  props.onChange(removeStatus(props.config, pendingDeletion.statusId, replacementStatusId), { removedStatusId: pendingDeletion.statusId, replacementStatusId });
                  setPendingDeletion(null);
                }}
              >
                {zh ? '迁移并删除' : 'Migrate and delete'}
              </Button>
            </footer>
          </section>
        </ModalPortal>
      ) : null}
    </section>
  );
}
