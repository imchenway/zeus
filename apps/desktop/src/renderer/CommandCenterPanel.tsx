import {useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent} from 'react';
import {ClockCounterClockwiseIcon as ClockCounterClockwise} from '@phosphor-icons/react/dist/csr/ClockCounterClockwise';
import {GlobeIcon as Globe} from '@phosphor-icons/react/dist/csr/Globe';
import {PencilSimpleIcon as PencilSimple} from '@phosphor-icons/react/dist/csr/PencilSimple';
import {PlayIcon as Play} from '@phosphor-icons/react/dist/csr/Play';
import {PlusIcon as Plus} from '@phosphor-icons/react/dist/csr/Plus';
import {StopIcon as Stop} from '@phosphor-icons/react/dist/csr/Stop';
import {TrashIcon as Trash} from '@phosphor-icons/react/dist/csr/Trash';
import {commandNeedsHighRiskConfirmation, type CommandRiskFlags} from '@zeus/shared';
import type {
  CommandDefinition,
  CommandDefinitionInput,
  CommandParameterDefinition,
  CommandRun,
  CommandRunDetail,
  DashboardClient,
  ProjectConfig,
  ProjectRecord,
  SaveProjectConfigRequest,
} from './apiClient.js';
import {Button} from './ui/Button.js';
import {ModalPortal} from './ui/ModalPortal.js';
import './commandCenter.css';

export interface CommandCenterPanelProps {
  mode: 'global' | 'project';
  project?: ProjectRecord;
  client: DashboardClient;
  language: 'zh-CN' | 'en-US';
}

interface CommandDraft {
  name: string;
  aliases: string;
  title: string;
  description: string;
  command: string;
  timeoutSeconds: string;
  enabled: boolean;
  telegramEnabled: boolean;
  riskFlags: CommandRiskFlags;
  parameters: CommandParameterDefinition[];
}

interface CommandPermissionRequest {
  command: CommandDefinition;
  missingShell: boolean;
  missingGitWrite: boolean;
}

const emptyDraft: CommandDraft = {
  name: '',
  aliases: '',
  title: '',
  description: '',
  command: '',
  timeoutSeconds: '300',
  enabled: true,
  telegramEnabled: false,
  riskFlags: {gitWrite: false, outsideProjectWrite: false, externalServiceWrite: false},
  parameters: [],
};

function CommandRunDurationValue(props: {run: CommandRun; zh: boolean}) {
  const shouldTick = props.run.status === 'running' && Boolean(props.run.startedAt) && !props.run.endedAt;
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!shouldTick) return undefined;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [shouldTick, props.run.startedAt]);

  return <span className="command-run-duration">{formatRunDuration(props.run, nowMs, props.zh)}</span>;
}

export function CommandCenterPanel(props: CommandCenterPanelProps) {
  const zh = props.language === 'zh-CN';
  const [commands, setCommands] = useState<CommandDefinition[]>([]);
  const [runs, setRuns] = useState<CommandRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<CommandDefinition | 'new' | null>(null);
  const [draft, setDraft] = useState<CommandDraft>(emptyDraft);
  const [permissionRequest, setPermissionRequest] = useState<CommandPermissionRequest | null>(null);
  const [runningCommand, setRunningCommand] = useState<CommandDefinition | null>(null);
  const [runParameters, setRunParameters] = useState<Record<string, string | number | boolean>>({});
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [runDetail, setRunDetail] = useState<CommandRunDetail | null>(null);
  const [artifactPreviewUrls, setArtifactPreviewUrls] = useState<Record<string, string>>({});
  const artifactPreviewUrlsRef = useRef<Record<string, string>>({});

  const canMaintain = props.mode === 'global' || Boolean(props.project);
  const activeRuns = useMemo(() => runs.filter((run) => run.status === 'running'), [runs]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    const request =
      props.mode === 'global'
        ? props.client.loadGlobalCommands()
        : props.project
          ? props.client.loadProjectCommands(props.project.id)
          : Promise.resolve([]);
    void request
      .then((items) => {
        if (active) setCommands(items);
      })
      .catch((loadError) => {
        if (active) setError(toMessage(loadError));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [props.client, props.mode, props.project?.id]);

  useEffect(() => {
    if (props.mode !== 'project' || !props.project) {
      setRuns([]);
      return;
    }
    let active = true;
    void props.client
      .loadCommandRuns(props.project.id)
      .then((items) => {
        if (active) setRuns(items);
      })
      .catch((loadError) => {
        if (active) setError(toMessage(loadError));
      });
    return () => {
      active = false;
    };
  }, [props.client, props.mode, props.project?.id]);

  useEffect(() => {
    if (!selectedRunId) {
      setRunDetail(null);
      return;
    }
    let active = true;
    const load = () =>
      props.client
        .loadCommandRun(selectedRunId)
        .then((detail) => {
          if (!active) return;
          setRunDetail(detail);
          setRuns((current) => current.map((run) => (run.id === detail.run.id ? detail.run : run)));
        })
        .catch((loadError) => {
          if (active) setError(toMessage(loadError));
        });
    void load();
    const timer = activeRuns.some((run) => run.id === selectedRunId) ? window.setInterval(() => void load(), 1000) : undefined;
    return () => {
      active = false;
      if (timer) window.clearInterval(timer);
    };
  }, [activeRuns, props.client, selectedRunId]);

  useEffect(() => {
    artifactPreviewUrlsRef.current = artifactPreviewUrls;
  }, [artifactPreviewUrls]);

  useEffect(
    () => () => {
      for (const url of Object.values(artifactPreviewUrlsRef.current)) URL.revokeObjectURL(url);
    },
    [],
  );

  async function reloadCommands(): Promise<void> {
    const items =
      props.mode === 'global'
        ? await props.client.loadGlobalCommands()
        : props.project
          ? await props.client.loadProjectCommands(props.project.id)
          : [];
    setCommands(items);
  }

  async function reloadRuns(selectRunId?: string): Promise<void> {
    if (!props.project) return;
    const items = await props.client.loadCommandRuns(props.project.id);
    setRuns(items);
    if (selectRunId) setSelectedRunId(selectRunId);
  }

  function openCreate(): void {
    setDraft({...emptyDraft, riskFlags: {...emptyDraft.riskFlags}, parameters: []});
    setEditing('new');
    setError(null);
  }

  function openEdit(command: CommandDefinition): void {
    setDraft({
      name: command.name,
      aliases: command.aliases.join(', '),
      title: command.title,
      description: command.description,
      command: command.command,
      timeoutSeconds: String(command.timeoutSeconds),
      enabled: command.enabled,
      telegramEnabled: command.telegramEnabled,
      riskFlags: {...command.riskFlags},
      parameters: command.parameters.map((parameter) => ({...parameter})),
    });
    setEditing(command);
    setError(null);
  }

  async function saveDefinition(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!editing || busy) return;
    const input = draftToInput(draft);
    setBusy(true);
    setError(null);
    try {
      if (editing === 'new') {
        if (props.mode === 'global') await props.client.createGlobalCommand(input);
        else if (props.project) await props.client.createProjectCommand(props.project.id, input);
      } else if (editing.scope === 'global') {
        await props.client.updateGlobalCommand(editing.id, input);
      } else if (props.project) {
        await props.client.updateProjectCommand(props.project.id, editing.id, input);
      }
      await reloadCommands();
      setEditing(null);
      setNotice(zh ? '命令定义已保存。' : 'Command definition saved.');
    } catch (saveError) {
      setError(toMessage(saveError));
    } finally {
      setBusy(false);
    }
  }

  async function removeCommand(command: CommandDefinition): Promise<void> {
    if (pendingDeleteId !== command.id) {
      setPendingDeleteId(command.id);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (command.scope === 'global') await props.client.deleteGlobalCommand(command.id);
      else if (props.project) await props.client.deleteProjectCommand(props.project.id, command.id);
      await reloadCommands();
      setPendingDeleteId(null);
      setNotice(zh ? '命令定义已删除，历史记录仍保留。' : 'Command deleted; history remains available.');
    } catch (deleteError) {
      setError(toMessage(deleteError));
    } finally {
      setBusy(false);
    }
  }

  function showRunConfirmation(command: CommandDefinition): void {
    const initialValues: Record<string, string | number | boolean> = {};
    for (const parameter of command.parameters) {
      if (parameter.defaultValue !== undefined) initialValues[parameter.key] = parameter.defaultValue;
      else if (parameter.type === 'boolean') initialValues[parameter.key] = false;
      else initialValues[parameter.key] = '';
    }
    setRunParameters(initialValues);
    setRunningCommand(command);
    setError(null);
  }

  async function openRun(command: CommandDefinition): Promise<void> {
    if (!props.project || busy) return;
    setBusy(true);
    setError(null);
    try {
      const config = await props.client.loadProjectConfig(props.project.id);
      const missingShell = !config.security.allowShell;
      const missingGitWrite = command.riskFlags.gitWrite && !config.security.allowGitWrite;
      if (missingShell || missingGitWrite) {
        setPermissionRequest({command, missingShell, missingGitWrite});
        return;
      }
      showRunConfirmation(command);
    } catch (loadError) {
      setError(toMessage(loadError));
    } finally {
      setBusy(false);
    }
  }

  async function enablePermissionsAndContinue(): Promise<void> {
    if (!permissionRequest || !props.project || busy) return;
    setBusy(true);
    setError(null);
    try {
      const config = await props.client.loadProjectConfig(props.project.id);
      const input = projectConfigWithCommandPermissions(config, permissionRequest.command);
      await props.client.saveProjectConfig(props.project.id, input);
      const command = permissionRequest.command;
      setPermissionRequest(null);
      showRunConfirmation(command);
      setNotice(zh ? '已开启所需项目权限，请确认本次运行。' : 'Required project permissions enabled. Confirm this run to continue.');
    } catch (saveError) {
      setError(toMessage(saveError));
    } finally {
      setBusy(false);
    }
  }

  async function submitRun(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!runningCommand || !props.project || busy) return;
    setBusy(true);
    setError(null);
    try {
      const confirmation = await props.client.createCommandConfirmation(props.project.id, runningCommand.id, {
        parameters: runParameters,
        trigger: 'desktop',
      });
      const run = await props.client.startCommandRun(props.project.id, runningCommand.id, {
        confirmationId: confirmation.id,
        parameters: runParameters,
      });
      await reloadRuns(run.id);
      setRunningCommand(null);
      setNotice(zh ? `已启动 ${runningCommand.title}。` : `${runningCommand.title} started.`);
    } catch (runError) {
      setError(toMessage(runError));
      await reloadRuns().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  async function stopRun(run: CommandRun): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await props.client.stopCommandRun(run.id);
      await reloadRuns(run.id);
    } catch (stopError) {
      setError(toMessage(stopError));
    } finally {
      setBusy(false);
    }
  }

  async function previewArtifact(artifactId: string): Promise<void> {
    if (artifactPreviewUrls[artifactId]) return;
    try {
      const blob = await props.client.loadCommandArtifact(artifactId);
      setArtifactPreviewUrls((current) => ({...current, [artifactId]: URL.createObjectURL(blob)}));
    } catch (previewError) {
      setError(toMessage(previewError));
    }
  }

  const heading =
    props.mode === 'global'
      ? zh
        ? '全局命令'
        : 'Global commands'
      : zh
        ? `${props.project?.name ?? '项目'}命令`
        : `${props.project?.name ?? 'Project'} commands`;

  return (
    <section className="command-center" aria-labelledby="command-center-title">
      <header className="command-center-header">
        <span>
          <h2 id="command-center-title">{heading}</h2>
          <p>
            {props.mode === 'global'
              ? zh
                ? '维护可在任意当前项目根目录执行的用户脚本。Zeus 不注入默认命令。'
                : 'Maintain user scripts that run in the selected project root. Zeus seeds no defaults.'
              : zh
                ? '全局命令只读展示；项目命令可在这里维护和执行。'
                : 'Global commands are read-only here; project commands can be maintained and run.'}
          </p>
        </span>
        <Button variant="primary" onClick={openCreate} disabled={!canMaintain || busy}>
          <Plus aria-hidden="true" />
          {zh ? '新建命令' : 'New command'}
        </Button>
      </header>

      <div className="command-center-live" role="status" aria-live="polite">
        {error ? <span className="command-center-error">{error}</span> : notice ? <span>{notice}</span> : null}
      </div>

      <section className="command-definition-list" aria-label={zh ? '命令定义列表' : 'Command definitions'}>
        {loading ? (
          <p className="command-center-empty">{zh ? '正在加载命令…' : 'Loading commands…'}</p>
        ) : commands.length === 0 ? (
          <p className="command-center-empty">{zh ? '尚未配置命令。' : 'No commands configured.'}</p>
        ) : (
          commands.map((command) => {
            const editable = props.mode === 'global' ? command.scope === 'global' : command.scope === 'project';
            return (
              <article className="command-definition-row" key={command.id} data-enabled={command.enabled ? 'true' : 'false'}>
                <span className="command-definition-leading" aria-hidden="true">
                  {command.scope === 'global' ? <Globe /> : <span>⌘</span>}
                </span>
                <span className="command-definition-copy">
                  <span className="command-definition-title">
                    <strong>{command.title}</strong>
                    <code>{command.name}</code>
                    <small>{command.scope === 'global' ? (zh ? '全局' : 'Global') : zh ? '项目' : 'Project'}</small>
                  </span>
                  <span>{command.description || command.command}</span>
                  <small>
                    {command.aliases.length > 0 ? `${zh ? '别名' : 'Aliases'}: ${command.aliases.join(', ')} · ` : ''}
                    {command.timeoutSeconds}s · {command.telegramEnabled ? 'Telegram on' : 'Telegram off'} ·{' '}
                    {command.enabled ? (zh ? '已启用' : 'Enabled') : zh ? '已停用' : 'Disabled'}
                  </small>
                </span>
                <span className="command-definition-actions">
                  {props.mode === 'project' ? (
                    <Button size="compact" onClick={() => void openRun(command)} disabled={!command.enabled || !props.project || busy}>
                      <Play aria-hidden="true" />
                      {zh ? '运行' : 'Run'}
                    </Button>
                  ) : null}
                  {editable ? (
                    <>
                      <Button size="compact" onClick={() => openEdit(command)} disabled={busy} aria-label={`${zh ? '编辑' : 'Edit'} ${command.title}`}>
                        <PencilSimple aria-hidden="true" />
                      </Button>
                      <Button
                        size="compact"
                        variant={pendingDeleteId === command.id ? 'danger' : 'secondary'}
                        onClick={() => void removeCommand(command)}
                        disabled={busy}
                        aria-label={`${pendingDeleteId === command.id ? (zh ? '确认删除' : 'Confirm delete') : zh ? '删除' : 'Delete'} ${command.title}`}
                      >
                        <Trash aria-hidden="true" />
                        {pendingDeleteId === command.id ? (zh ? '确认' : 'Confirm') : null}
                      </Button>
                    </>
                  ) : null}
                </span>
              </article>
            );
          })
        )}
      </section>

      {props.mode === 'project' ? (
        <section className="command-run-history" aria-labelledby="command-run-history-title">
          <header>
            <span>
              <ClockCounterClockwise aria-hidden="true" />
              <strong id="command-run-history-title">{zh ? '执行历史' : 'Run history'}</strong>
            </span>
            {activeRuns.length > 0 ? <small>{zh ? `${activeRuns.length} 条运行中` : `${activeRuns.length} running`}</small> : null}
          </header>
          {runs.length === 0 ? (
            <p className="command-center-empty">{zh ? '尚无执行记录。' : 'No run history.'}</p>
          ) : (
            <div className="command-run-layout">
              <div className="command-run-list" role="list">
                {runs.map((run) => (
                  <button
                    type="button"
                    role="listitem"
                    className={selectedRunId === run.id ? 'selected' : ''}
                    onClick={() => setSelectedRunId(run.id)}
                    key={run.id}
                  >
                    <span>
                      <strong>{run.commandSnapshot.title}</strong>
                      <small>
                        {formatRunTime(run.createdAt)} · {zh ? '耗时' : 'Duration'} <CommandRunDurationValue run={run} zh={zh} />
                      </small>
                    </span>
                    <span className={`command-run-status status-${run.status}`}>{runStatusLabel(run.status, zh)}</span>
                  </button>
                ))}
              </div>
              {runDetail ? (
                <section className="command-run-detail" aria-label={zh ? '执行详情' : 'Run details'}>
                  <header>
                    <span>
                      <strong>{runDetail.run.commandSnapshot.title}</strong>
                      <small>{runDetail.run.cwd}</small>
                    </span>
                    {runDetail.run.status === 'running' ? (
                      <Button variant="danger" size="compact" onClick={() => void stopRun(runDetail.run)} disabled={busy}>
                        <Stop aria-hidden="true" />
                        {zh ? '停止' : 'Stop'}
                      </Button>
                    ) : null}
                  </header>
                  <dl>
                    <div><dt>{zh ? '状态' : 'Status'}</dt><dd>{runStatusLabel(runDetail.run.status, zh)}</dd></div>
                    <div><dt>{zh ? '实际耗时' : 'Duration'}</dt><dd><CommandRunDurationValue run={runDetail.run} zh={zh} /></dd></div>
                    <div><dt>{zh ? '超时上限' : 'Timeout limit'}</dt><dd>{runDetail.run.timeoutSeconds}s</dd></div>
                    <div><dt>{zh ? '退出码' : 'Exit code'}</dt><dd>{runDetail.run.exitCode ?? '—'}</dd></div>
                  </dl>
                  {runDetail.run.failureReason ? <p className="command-run-failure">{runDetail.run.failureReason}</p> : null}
                  <pre className="command-run-log" aria-label={zh ? '终端日志' : 'Terminal logs'}>
                    {runDetail.logs.length > 0 ? runDetail.logs.map((log) => log.text).join('') : zh ? '暂无日志。' : 'No logs yet.'}
                  </pre>
                  {runDetail.artifacts.length > 0 ? (
                    <section className="command-artifacts" aria-label={zh ? '命令产物' : 'Command artifacts'}>
                      <strong>{zh ? '产物' : 'Artifacts'}</strong>
                      {runDetail.artifacts.map((artifact) => (
                        <div key={artifact.id}>
                          <button type="button" onClick={() => void previewArtifact(artifact.id)}>
                            {artifact.relativePath} · {formatBytes(artifact.byteLength)}
                          </button>
                          {artifact.mimeType?.startsWith('image/') && artifactPreviewUrls[artifact.id] ? (
                            <img src={artifactPreviewUrls[artifact.id]} alt={artifact.relativePath} />
                          ) : null}
                        </div>
                      ))}
                    </section>
                  ) : null}
                </section>
              ) : (
                <p className="command-center-empty">{zh ? '选择一条记录查看终端日志与产物。' : 'Select a run to view logs and artifacts.'}</p>
              )}
            </div>
          )}
        </section>
      ) : null}

      {editing ? (
        <CommandDefinitionModal
          draft={draft}
          busy={busy}
          error={error}
          language={props.language}
          title={editing === 'new' ? (zh ? '新建命令' : 'New command') : zh ? '编辑命令' : 'Edit command'}
          onChange={setDraft}
          onClose={() => setEditing(null)}
          onSubmit={(event) => void saveDefinition(event)}
        />
      ) : null}

      {permissionRequest && props.project ? (
        <CommandPermissionModal
          request={permissionRequest}
          project={props.project}
          busy={busy}
          error={error}
          language={props.language}
          onClose={() => setPermissionRequest(null)}
          onContinue={() => void enablePermissionsAndContinue()}
        />
      ) : null}

      {runningCommand && props.project ? (
        <CommandRunModal
          command={runningCommand}
          project={props.project}
          values={runParameters}
          busy={busy}
          error={error}
          language={props.language}
          onValuesChange={setRunParameters}
          onClose={() => setRunningCommand(null)}
          onSubmit={(event) => void submitRun(event)}
        />
      ) : null}
    </section>
  );
}

function CommandDefinitionModal(props: {
  draft: CommandDraft;
  title: string;
  busy: boolean;
  error: string | null;
  language: 'zh-CN' | 'en-US';
  onChange: (draft: CommandDraft) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const zh = props.language === 'zh-CN';
  const update = <K extends keyof CommandDraft>(key: K, value: CommandDraft[K]) => props.onChange({...props.draft, [key]: value});
  const updateParameter = (index: number, patch: Partial<CommandParameterDefinition>) =>
    update(
      'parameters',
      props.draft.parameters.map((parameter, parameterIndex) => parameterIndex === index ? {...parameter, ...patch} : parameter),
    );
  const handleKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key === 'Escape' && !props.busy) props.onClose();
  };
  return (
    <ModalPortal
      rootClassName="command-modal-portal-root"
      backdropClassName="command-modal-backdrop"
      dismissDisabled={props.busy}
      onDismiss={props.onClose}
    >
      <form
        className="command-modal command-definition-modal command-editor-form zeus-solid-form-surface"
        role="dialog"
        aria-modal="true"
        aria-labelledby="command-definition-modal-title"
        onSubmit={props.onSubmit}
        onKeyDown={handleKeyDown}
      >
        <header className="command-modal-header">
          <span>
            <h3 id="command-definition-modal-title">{props.title}</h3>
            <p>{zh ? '命令在目标项目根目录中通过 sh -lc 执行。' : 'Commands run through sh -lc in the target project root.'}</p>
          </span>
          <button type="button" aria-label={zh ? '关闭' : 'Close'} onClick={props.onClose} disabled={props.busy}>×</button>
        </header>
        <div className="command-modal-body">
          {props.error ? <p className="command-modal-error" role="alert">{props.error}</p> : null}
          <div className="command-editor-grid">
            <label>{zh ? '名称' : 'Name'}<input autoFocus required value={props.draft.name} onChange={(event) => update('name', event.currentTarget.value)} placeholder="my-command" /></label>
            <label>{zh ? '标题' : 'Title'}<input required maxLength={80} value={props.draft.title} onChange={(event) => update('title', event.currentTarget.value)} /></label>
            <label className="wide">{zh ? '别名（逗号分隔）' : 'Aliases (comma separated)'}<input value={props.draft.aliases} onChange={(event) => update('aliases', event.currentTarget.value)} /></label>
            <label className="wide">{zh ? '说明' : 'Description'}<textarea maxLength={400} rows={2} value={props.draft.description} onChange={(event) => update('description', event.currentTarget.value)} /></label>
            <label className="wide">{zh ? '命令' : 'Command'}<textarea required maxLength={1024} rows={4} value={props.draft.command} onChange={(event) => update('command', event.currentTarget.value)} /></label>
            <label>{zh ? '超时（秒）' : 'Timeout (seconds)'}<input required type="number" min={5} max={3600} value={props.draft.timeoutSeconds} onChange={(event) => update('timeoutSeconds', event.currentTarget.value)} /></label>
          </div>
          <fieldset className="command-editor-switches">
            <legend>{zh ? '可用性与风险' : 'Availability and risk'}</legend>
            <Check label={zh ? '启用命令' : 'Enable command'} checked={props.draft.enabled} onChange={(checked) => update('enabled', checked)} />
            <Check label={zh ? '允许 Telegram' : 'Allow Telegram'} checked={props.draft.telegramEnabled} onChange={(checked) => update('telegramEnabled', checked)} />
            <Check label={zh ? 'Git 写入' : 'Git write'} checked={props.draft.riskFlags.gitWrite} onChange={(checked) => update('riskFlags', {...props.draft.riskFlags, gitWrite: checked})} />
            <Check label={zh ? '项目外写入' : 'Outside-project write'} checked={props.draft.riskFlags.outsideProjectWrite} onChange={(checked) => update('riskFlags', {...props.draft.riskFlags, outsideProjectWrite: checked})} />
            <Check label={zh ? '外部服务写入' : 'External service write'} checked={props.draft.riskFlags.externalServiceWrite} onChange={(checked) => update('riskFlags', {...props.draft.riskFlags, externalServiceWrite: checked})} />
          </fieldset>
          <section className="command-parameter-editor" aria-labelledby="command-parameter-heading">
            <header>
              <span><strong id="command-parameter-heading">{zh ? '声明式参数' : 'Declarative parameters'}</strong><small>{zh ? '参数以环境变量注入；ZEUS_* 为保留名称。' : 'Parameters are injected as environment variables; ZEUS_* is reserved.'}</small></span>
              <Button size="compact" onClick={() => update('parameters', [...props.draft.parameters, newParameter()])}><Plus aria-hidden="true" />{zh ? '添加参数' : 'Add parameter'}</Button>
            </header>
            {props.draft.parameters.map((parameter, index) => (
              <fieldset className="command-parameter-row" key={`${parameter.key}-${index}`}>
                <legend>{zh ? `参数 ${index + 1}` : `Parameter ${index + 1}`}</legend>
                <label>{zh ? '环境变量' : 'Environment key'}<input required value={parameter.key} onChange={(event) => updateParameter(index, {key: event.currentTarget.value.toLocaleUpperCase()})} placeholder="DEPTH" /></label>
                <label>{zh ? '标签' : 'Label'}<input required value={parameter.label} onChange={(event) => updateParameter(index, {label: event.currentTarget.value})} /></label>
                <label>{zh ? '类型' : 'Type'}
                  <select value={parameter.type} onChange={(event) => updateParameter(index, {type: event.currentTarget.value as CommandParameterDefinition['type'], defaultValue: undefined})}>
                    <option value="string">string</option><option value="number">number</option><option value="boolean">boolean</option>
                  </select>
                </label>
                <label>{zh ? '默认值' : 'Default value'}
                  {parameter.type === 'boolean' ? (
                    <select value={parameter.defaultValue === undefined ? '' : parameter.defaultValue ? 'true' : 'false'} disabled={parameter.sensitive} onChange={(event) => updateParameter(index, {defaultValue: event.currentTarget.value === '' ? undefined : event.currentTarget.value === 'true'})}>
                      <option value="">{zh ? '无' : 'None'}</option><option value="true">true</option><option value="false">false</option>
                    </select>
                  ) : (
                    <input
                      type={parameter.type === 'number' ? 'number' : 'text'}
                      disabled={parameter.sensitive}
                      value={parameter.defaultValue === undefined ? '' : String(parameter.defaultValue)}
                      onChange={(event) => updateParameter(index, {defaultValue: event.currentTarget.value === '' ? undefined : parameter.type === 'number' ? Number(event.currentTarget.value) : event.currentTarget.value})}
                    />
                  )}
                </label>
                <label className="wide">{zh ? '说明' : 'Description'}<input maxLength={200} value={parameter.description} onChange={(event) => updateParameter(index, {description: event.currentTarget.value})} /></label>
                <span className="command-parameter-flags">
                  <Check label={zh ? '必填' : 'Required'} checked={parameter.required} onChange={(checked) => updateParameter(index, {required: checked})} />
                  <Check label={zh ? '敏感' : 'Sensitive'} checked={parameter.sensitive} onChange={(checked) => updateParameter(index, {sensitive: checked, defaultValue: checked ? undefined : parameter.defaultValue})} />
                  <Button size="compact" variant="danger" onClick={() => update('parameters', props.draft.parameters.filter((_, parameterIndex) => parameterIndex !== index))}><Trash aria-hidden="true" />{zh ? '移除' : 'Remove'}</Button>
                </span>
              </fieldset>
            ))}
          </section>
        </div>
        <footer className="command-modal-footer"><Button onClick={props.onClose} disabled={props.busy}>{zh ? '取消' : 'Cancel'}</Button><Button type="submit" variant="primary" busy={props.busy}>{zh ? '保存命令' : 'Save command'}</Button></footer>
      </form>
    </ModalPortal>
  );
}

function CommandPermissionModal(props: {
  request: CommandPermissionRequest;
  project: ProjectRecord;
  busy: boolean;
  error: string | null;
  language: 'zh-CN' | 'en-US';
  onClose: () => void;
  onContinue: () => void;
}) {
  const zh = props.language === 'zh-CN';
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && !props.busy) props.onClose();
  };
  return (
    <ModalPortal
      rootClassName="command-modal-portal-root"
      backdropClassName="command-modal-backdrop"
      dismissDisabled={props.busy}
      onDismiss={props.onClose}
    >
      <div
        className="command-modal command-permission-modal zeus-solid-form-surface"
        role="dialog"
        aria-modal="true"
        aria-labelledby="command-permission-modal-title"
        aria-describedby="command-permission-modal-description"
        onKeyDown={handleKeyDown}
      >
        <header className="command-modal-header">
          <span>
            <h3 id="command-permission-modal-title">{zh ? '开启项目命令权限' : 'Enable project command permissions'}</h3>
            <p>{props.project.name} · {props.request.command.title}</p>
          </span>
          <button type="button" aria-label={zh ? '关闭' : 'Close'} onClick={props.onClose} disabled={props.busy}>×</button>
        </header>
        <div className="command-modal-body command-permission-body">
          {props.error ? <p className="command-modal-error" role="alert">{props.error}</p> : null}
          <p id="command-permission-modal-description">
            {zh
              ? '运行此命令前需要开启下列项目权限。权限会保存到当前项目，但不会因此立即执行命令。'
              : 'This command needs the following project permissions. They will be saved for this project, but the command will not run yet.'}
          </p>
          <ul>
            {props.request.missingShell ? <li><strong>{zh ? 'Shell' : 'Shell'}</strong><span>{zh ? '允许任务请求当前项目的 Shell 能力。' : 'Allow tasks to request Shell access for this project.'}</span></li> : null}
            {props.request.missingGitWrite ? <li><strong>{zh ? 'Git 写操作' : 'Git write'}</strong><span>{zh ? '允许此项目中的命令执行 Git 写操作。' : 'Allow commands in this project to perform Git writes.'}</span></li> : null}
          </ul>
          <p className="command-permission-next-step">
            {zh ? '开启后仍会进入本次运行确认；只有再次点击“确认并运行”才会执行。' : 'After enabling, you will still review this run. It executes only after you select “Confirm and run”.'}
          </p>
        </div>
        <footer className="command-modal-footer">
          <Button autoFocus onClick={props.onClose} disabled={props.busy}>{zh ? '取消' : 'Cancel'}</Button>
          <Button variant={props.request.missingGitWrite ? 'danger' : 'primary'} busy={props.busy} onClick={props.onContinue}>
            {zh ? '开启并继续' : 'Enable and continue'}
          </Button>
        </footer>
      </div>
    </ModalPortal>
  );
}

function CommandRunModal(props: {
  command: CommandDefinition;
  project: ProjectRecord;
  values: Record<string, string | number | boolean>;
  busy: boolean;
  error: string | null;
  language: 'zh-CN' | 'en-US';
  onValuesChange: (values: Record<string, string | number | boolean>) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const zh = props.language === 'zh-CN';
  const highRisk = commandNeedsHighRiskConfirmation(props.command.riskFlags);
  const riskLabels = commandRiskLabels(props.command.riskFlags, zh);
  const handleKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key === 'Escape' && !props.busy) props.onClose();
  };
  return (
    <ModalPortal
      rootClassName="command-modal-portal-root"
      backdropClassName="command-modal-backdrop"
      dismissDisabled={props.busy}
      onDismiss={props.onClose}
    >
      <form
        className="command-modal command-run-modal command-run-form zeus-solid-form-surface"
        role="dialog"
        aria-modal="true"
        aria-labelledby="command-run-modal-title"
        onSubmit={props.onSubmit}
        onKeyDown={handleKeyDown}
      >
        <header className="command-modal-header">
          <span><h3 id="command-run-modal-title">{props.command.title}</h3><code>{props.command.command}</code></span>
          <button type="button" aria-label={zh ? '关闭' : 'Close'} onClick={props.onClose} disabled={props.busy}>×</button>
        </header>
        <div className="command-modal-body">
          {props.error ? <p className="command-modal-error" role="alert">{props.error}</p> : null}
          <dl>
            <div><dt>{zh ? '项目目录' : 'Project directory'}</dt><dd>{props.project.localPath}</dd></div>
            <div><dt>{zh ? '超时' : 'Timeout'}</dt><dd>{props.command.timeoutSeconds}s</dd></div>
            <div><dt>{zh ? '风险' : 'Risk'}</dt><dd>{highRisk ? (zh ? '高风险' : 'High risk') : zh ? '普通' : 'Normal'}</dd></div>
          </dl>
          {props.command.parameters.map((parameter, index) => (
            <label key={parameter.key}>
              {parameter.label}<small>{parameter.key}{parameter.required ? ' · required' : ''}</small>
              {parameter.type === 'boolean' ? (
                <input autoFocus={index === 0} type="checkbox" checked={Boolean(props.values[parameter.key])} onChange={(event) => props.onValuesChange({...props.values, [parameter.key]: event.currentTarget.checked})} />
              ) : (
                <input
                  autoFocus={index === 0}
                  required={parameter.required}
                  type={parameter.sensitive ? 'password' : parameter.type === 'number' ? 'number' : 'text'}
                  value={String(props.values[parameter.key] ?? '')}
                  onChange={(event) => props.onValuesChange({...props.values, [parameter.key]: parameter.type === 'number' ? Number(event.currentTarget.value) : event.currentTarget.value})}
                />
              )}
              {parameter.description ? <small>{parameter.description}</small> : null}
            </label>
          ))}
          {highRisk ? (
            <section className="command-high-risk-summary" aria-label={zh ? '高风险操作说明' : 'High-risk operation details'}>
              <strong>{zh ? '本次运行包含高风险操作' : 'This run includes high-risk operations'}</strong>
              <ul>{riskLabels.map((label) => <li key={label}>{label}</li>)}</ul>
              <p>{zh ? '请核对命令、项目目录和参数；点击确认按钮即授权本次执行。' : 'Review the command, project directory, and parameters. Selecting the confirmation button authorizes this run.'}</p>
            </section>
          ) : null}
        </div>
        <footer className="command-modal-footer">
          <Button onClick={props.onClose} disabled={props.busy}>{zh ? '取消' : 'Cancel'}</Button>
          <Button autoFocus={props.command.parameters.length === 0} type="submit" variant={highRisk ? 'danger' : 'primary'} busy={props.busy}><Play aria-hidden="true" />{zh ? '确认并运行' : 'Confirm and run'}</Button>
        </footer>
      </form>
    </ModalPortal>
  );
}

function Check(props: {label: string; checked: boolean; onChange: (checked: boolean) => void}) {
  return <label className="command-check"><input type="checkbox" checked={props.checked} onChange={(event) => props.onChange(event.currentTarget.checked)} /><span>{props.label}</span></label>;
}

function newParameter(): CommandParameterDefinition {
  return {key: '', label: '', description: '', type: 'string', required: false, sensitive: false};
}

function draftToInput(draft: CommandDraft): CommandDefinitionInput {
  return {
    name: draft.name.trim(),
    aliases: draft.aliases.split(',').map((alias) => alias.trim()).filter(Boolean),
    title: draft.title.trim(),
    description: draft.description.trim(),
    command: draft.command.trim(),
    timeoutSeconds: Number(draft.timeoutSeconds),
    enabled: draft.enabled,
    telegramEnabled: draft.telegramEnabled,
    riskFlags: draft.riskFlags,
    parameters: draft.parameters.map((parameter) => ({...parameter, key: parameter.key.trim(), label: parameter.label.trim(), description: parameter.description.trim()})),
  };
}

function projectConfigWithCommandPermissions(config: ProjectConfig, command: CommandDefinition): SaveProjectConfigRequest {
  return {
    defaultModel: config.defaultModel,
    defaultWorkMode: config.defaultWorkMode,
    defaultTaskPrompt: config.defaultTaskPrompt,
    scan: config.scan,
    language: config.language,
    dependencies: config.dependencies,
    database: config.database,
    telegram: config.telegram,
    security: {
      allowShell: true,
      allowGitWrite: config.security.allowGitWrite || command.riskFlags.gitWrite,
    },
  };
}

function commandRiskLabels(riskFlags: CommandRiskFlags, zh: boolean): string[] {
  const labels: string[] = [];
  if (riskFlags.gitWrite) labels.push(zh ? 'Git 写操作' : 'Git write');
  if (riskFlags.outsideProjectWrite) labels.push(zh ? '写入项目目录之外' : 'Write outside the project');
  if (riskFlags.externalServiceWrite) labels.push(zh ? '写入外部服务' : 'Write to an external service');
  return labels;
}

function runStatusLabel(status: CommandRun['status'], zh: boolean): string {
  const labels: Record<CommandRun['status'], [string, string]> = {
    pending_confirmation: ['待确认', 'Pending'],
    running: ['运行中', 'Running'],
    succeeded: ['成功', 'Succeeded'],
    failed: ['失败', 'Failed'],
    timed_out: ['超时', 'Timed out'],
    cancelled: ['已取消', 'Cancelled'],
    rejected: ['已拒绝', 'Rejected'],
  };
  return labels[status][zh ? 0 : 1];
}

function formatRunTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'}).format(new Date(value));
}

function formatRunDuration(run: CommandRun, nowMs: number, zh: boolean): string {
  if (!run.startedAt) return zh ? '未启动' : 'Not started';
  const startedAtMs = Date.parse(run.startedAt);
  const endedAtMs = run.endedAt ? Date.parse(run.endedAt) : nowMs;
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs)) return '—';

  const totalSeconds = Math.floor(Math.max(0, endedAtMs - startedAtMs) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
