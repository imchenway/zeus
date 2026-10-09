import { useCallback, useEffect, useRef, useState } from 'react';
import { DigitalEmployeeAvatar, EmployeeAvatarPicker } from './DigitalEmployeeAvatar.js';
import { Button } from '../../ui/Button.js';
import { FormDialog } from '../../ui/FormDialog.js';
import { VisibleApplicationError } from '../../ui/ApplicationErrorDialog.js';
import type { NativeConversationAppClient } from '../workspace/workspaceSupport.js';
import type { DigitalEmployeeApiClient } from './digitalEmployeeApiClient.js';
import type { DigitalEmployeeTemplateRecord } from './digitalEmployeeContracts.js';
import { emptyTemplateDraft, errorMessage, templateDraft, templateInput, type DigitalEmployeeLanguage, type DigitalEmployeeTemplateDraft } from './digitalEmployeeUiSupport.js';
import { EmployeeMemoryPanel } from './EmployeeMemoryPanel.js';
import { EmployeeExecutionSettings } from './EmployeeExecutionSettings.js';
import './digitalEmployees.css';

export interface DigitalEmployeeTemplatesSettingsProps {
  client: DigitalEmployeeApiClient | null;
  skillClient: Pick<NativeConversationAppClient, 'loadSkills'> | null;
  language: DigitalEmployeeLanguage;
}

/** 编辑区只承载待创建草稿或用户已经创建的独立数字员工。 */
type EditorTarget = { kind: 'new' } | { kind: 'employee'; record: DigitalEmployeeTemplateRecord } | null;

/** 新增数字员工支持从内置模板开始，也支持空白创建。 */
type DigitalEmployeeCreationSource = { kind: 'blank' } | { kind: 'template'; templateId: string } | null;

/** 员工工作配置与记忆管理使用独立入口，修改沿用自动保存。 */
export function DigitalEmployeeTemplatesSettings(props: DigitalEmployeeTemplatesSettingsProps) {
  const zh = props.language === 'zh-CN';
  const [templates, setTemplates] = useState<DigitalEmployeeTemplateRecord[]>([]);
  const loadRevisionRef = useRef(0);
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle');
  const [busy, setBusy] = useState(false);
  /** 保存和删除共用忙状态，但失败提示与重试必须指向原操作。 */
  const [lastAction, setLastAction] = useState<'save' | 'delete'>('save');
  /** 删除使用产品已有页面确认框，避免系统弹窗阻塞应用及后台交互。 */
  const [pendingDelete, setPendingDelete] = useState<DigitalEmployeeTemplateRecord | null>(null);
  /** 同一帧的失焦与选择事件只启动一次写入。 */
  const savingRef = useRef(false);
  const [savedName, setSavedName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editorTarget, setEditorTarget] = useState<EditorTarget>(null);
  /** 新增入口先展示模板或空白创建方式。 */
  const [templateSelectionOpen, setTemplateSelectionOpen] = useState(false);
  /** 记录新增弹窗内待确认的创建来源。 */
  const [creationSource, setCreationSource] = useState<DigitalEmployeeCreationSource>(null);
  const draftsRef = useRef(new Map<string, { draft: DigitalEmployeeTemplateDraft; target: NonNullable<EditorTarget> }>());
  const [draft, setDraft] = useState<DigitalEmployeeTemplateDraft>({ ...emptyTemplateDraft });
  /** 仅筛选当前列表，不改变员工身份或正在编辑的草稿。 */
  const [employeeSearch, setEmployeeSearch] = useState('');
  /** 工作配置与记忆管理分别显示，避免历史记录挤占配置表单。 */
  const [editorSection, setEditorSection] = useState<'work' | 'memory' | 'history'>('work');

  const loadTemplates = useCallback(async () => {
    if (!props.client) return;
    const revision = ++loadRevisionRef.current;
    setLoadState('loading');
    setError(null);
    setSavedName(null);
    try {
      const nextTemplates = await props.client.loadDigitalEmployeeTemplates();
      if (revision !== loadRevisionRef.current) return;
      setTemplates(nextTemplates);

      setLoadState('ready');
    } catch (cause) {
      if (revision !== loadRevisionRef.current) return;
      setLoadState('failed');
      setError(errorMessage(cause, zh ? 'zh-CN' : 'en'));
    }
  }, [props.client, zh]);

  useEffect(() => {
    void loadTemplates();
    return () => {
      loadRevisionRef.current += 1;
    };
  }, [loadTemplates]);

  function rememberDraft(): void {
    if (!editorTarget) return;
    const key = editorTarget.kind === 'new' ? 'new' : editorTarget.record.id;
    if (editorTarget.kind === 'employee' && JSON.stringify(draft) === JSON.stringify(templateDraft(editorTarget.record))) {
      draftsRef.current.delete(key);
      return;
    }
    // 草稿保留原始版本，刷新后的新记录不能替它绕过并发修改校验。
    draftsRef.current.set(key, { draft, target: editorTarget });
  }

  function cancelEditing(): void {
    if (busy || !editorTarget) return;
    draftsRef.current.delete(editorTarget.kind === 'new' ? 'new' : editorTarget.record.id);
    setEditorTarget(null);
    setDraft({ ...emptyTemplateDraft });
    setError(null);
    setSavedName(null);
  }

  /** 打开新增员工的模板选择，不提前创建持久化记录。 */
  function beginCreate(): void {
    if (busy) return;
    rememberDraft();
    setCreationSource(null);
    setTemplateSelectionOpen(true);
    setError(null);
    setSavedName(null);
  }

  /** 关闭模板选择并清理未确认的选择。 */
  function cancelTemplateSelection(): void {
    if (busy) return;
    setTemplateSelectionOpen(false);
    setCreationSource(null);
  }

  /** 用内置模板或空白配置初始化独立的新员工草稿。 */
  function beginCreateFromSelection(): void {
    if (busy || !creationSource) return;
    /** 草稿复制模板的当前值，但不保存模板身份或关联。 */
    let nextDraft: DigitalEmployeeTemplateDraft;
    if (creationSource.kind === 'blank') {
      nextDraft = { ...emptyTemplateDraft };
    } else {
      /** 只允许当前目录中的内置模板成为创建来源。 */
      const source = templates.find((template) => template.builtIn && template.id === creationSource.templateId);
      if (!source) return;
      nextDraft = templateDraft(source);
    }
    setEditorTarget({ kind: 'new' });
    setEditorSection('work');
    setDraft(nextDraft);
    setTemplateSelectionOpen(false);
    setCreationSource(null);
    setError(null);
    setSavedName(null);
  }

  /** 打开用户已经创建的数字员工，内置模板不进入编辑区。 */
  function beginInspect(record: DigitalEmployeeTemplateRecord): void {
    if (busy || record.builtIn) return;
    rememberDraft();
    const cached = draftsRef.current.get(record.id);
    setEditorTarget(cached?.target ?? { kind: 'employee', record });
    setDraft(cached?.draft ?? templateDraft(record));
    setError(null);
    setSavedName(null);
  }

  /** 输入结束或选择配置后保存；新员工仍需完整填写后创建。 */
  async function saveEmployee(nextDraft = draft): Promise<void> {
    if (savingRef.current || busy || loadState === 'loading' || !props.client || !editorTarget) return;
    if (editorTarget.kind === 'employee' && JSON.stringify(nextDraft) === JSON.stringify(templateDraft(editorTarget.record))) return;
    if (!nextDraft.name.trim() || !nextDraft.role.trim() || !nextDraft.prompt.trim()) {
      setError(zh ? '名称、岗位和提示词不能为空。' : 'Name, role, and instructions are required.');
      return;
    }
    savingRef.current = true;
    setLastAction('save');
    setBusy(true);
    setError(null);
    setSavedName(null);
    try {
      const record =
        editorTarget.kind === 'new'
          ? await props.client.createDigitalEmployeeTemplate(templateInput(nextDraft))
          : await props.client.updateDigitalEmployeeTemplate(editorTarget.record.id, editorTarget.record.revision, templateInput(nextDraft));
      setTemplates((current) => {
        const exists = current.some((candidate) => candidate.id === record.id);
        return exists ? current.map((candidate) => (candidate.id === record.id ? record : candidate)) : [...current, record];
      });
      draftsRef.current.delete(editorTarget.kind === 'new' ? 'new' : editorTarget.record.id);
      setEditorTarget({ kind: 'employee', record });
      setDraft(templateDraft(record));
      setSavedName(record.name);
    } catch (cause) {
      setError(errorMessage(cause, zh ? 'zh-CN' : 'en'));
    } finally {
      savingRef.current = false;
      setBusy(false);
    }
  }

  /** 删除员工身份，已完成工作的记录继续保留。 */
  async function deleteEmployee(record: DigitalEmployeeTemplateRecord): Promise<void> {
    if (busy || loadState === 'loading' || !props.client || record.builtIn) return;
    setLastAction('delete');
    setBusy(true);
    setError(null);
    setSavedName(null);
    try {
      await props.client.deleteDigitalEmployeeTemplate(record.id, record.revision);
      draftsRef.current.delete(record.id);
      setTemplates((current) => current.filter((candidate) => candidate.id !== record.id));
      setEditorTarget(null);
      setDraft({ ...emptyTemplateDraft });
    } catch (cause) {
      setError(errorMessage(cause, zh ? 'zh-CN' : 'en'));
    } finally {
      setBusy(false);
    }
  }

  if (!props.client) {
    return (
      <section className="settings-product-pane digital-employee-settings-pane" aria-label={zh ? '数字员工' : 'Digital employees'}>
        <h2 className="settings-page-title">{zh ? '数字员工' : 'Digital employees'}</h2>
        <p className="digital-employee-empty">{zh ? '当前连接不支持数字员工配置。' : 'Digital employee configuration is unavailable on this connection.'}</p>
      </section>
    );
  }

  /** 内置记录只作为新增模板，不进入用户的数字员工列表。 */
  const builtInTemplates = templates.filter((template) => template.builtIn);
  /** 共享目录已排除旧项目迁出身份，此处仅保留用户创建的可编辑员工。 */
  const employees = templates.filter((template) => !template.builtIn);
  /** 姓名和岗位共用简单文本筛选，同名员工仍分别保留。 */
  const visibleEmployees = employees.filter((employee) => `${employee.name} ${employee.role}`.toLocaleLowerCase().includes(employeeSearch.trim().toLocaleLowerCase()));
  return (
    <section className="settings-product-pane digital-employee-settings-pane" aria-label={zh ? '数字员工' : 'Digital employees'}>
      <header className="digital-employee-page-heading">
        <span>
          <h2 className="settings-page-title">{zh ? '数字员工' : 'Digital employees'}</h2>
        </span>
        <span className="digital-employee-actions">
          <Button variant="secondary" size="compact" busy={loadState === 'loading'} disabled={busy} onClick={() => void loadTemplates()}>
            {zh ? '刷新' : 'Refresh'}
          </Button>
          <Button variant="primary" size="compact" disabled={busy || loadState !== 'ready'} onClick={beginCreate}>
            {zh ? '新增' : 'Add'}
          </Button>
        </span>
      </header>

      {pendingDelete ? (
        <FormDialog
          title={zh ? `删除数字员工“${pendingDelete.name}”？` : `Delete digital employee “${pendingDelete.name}”?`}
          description={zh ? '已完成工作的记录会保留。有运行中或待交付的工作时不能删除。' : 'Completed work records will remain. Employees with active or pending work cannot be deleted.'}
          zh={zh}
          busy={busy}
          danger
          submitLabel={zh ? '删除员工' : 'Delete employee'}
          onClose={() => setPendingDelete(null)}
          onSubmit={(event) => {
            event.preventDefault();
            if (busy) return;
            setPendingDelete(null);
            void deleteEmployee(pendingDelete);
          }}
        />
      ) : null}

      {templateSelectionOpen ? (
        <FormDialog
          className="digital-employee-template-picker-dialog"
          title={zh ? '新增数字员工' : 'Add a digital employee'}
          description={zh ? '从模板开始或自己新建。创建后会保存为独立数字员工，与模板不再关联。' : 'Start from a template or create your own. Once created, the employee is independent from the template.'}
          zh={zh}
          busy={busy}
          submitLabel={zh ? '下一步' : 'Continue'}
          submitDisabled={!creationSource}
          onClose={cancelTemplateSelection}
          onSubmit={(event) => {
            event.preventDefault();
            beginCreateFromSelection();
          }}
        >
          <div className="digital-employee-template-picker" role="radiogroup" aria-label={zh ? '数字员工创建方式' : 'Digital employee creation options'}>
            <button
              type="button"
              role="radio"
              aria-checked={creationSource?.kind === 'blank'}
              className={`digital-employee-list-row digital-employee-template-choice ${creationSource?.kind === 'blank' ? 'is-selected' : ''}`}
              onClick={() => setCreationSource({ kind: 'blank' })}
            >
              <span className="digital-employee-template-blank-icon" aria-hidden="true">
                +
              </span>
              <span>
                <strong>{zh ? '自己新建' : 'Create your own'}</strong>
                <small>{zh ? '从空白配置一名数字员工。' : 'Configure a digital employee from scratch.'}</small>
              </span>
              <em>{zh ? '空白' : 'Blank'}</em>
            </button>
            {builtInTemplates.map((template) => (
              <button
                key={template.id}
                type="button"
                role="radio"
                aria-checked={creationSource?.kind === 'template' && creationSource.templateId === template.id}
                className={`digital-employee-list-row digital-employee-template-choice ${creationSource?.kind === 'template' && creationSource.templateId === template.id ? 'is-selected' : ''}`}
                onClick={() => setCreationSource({ kind: 'template', templateId: template.id })}
              >
                <DigitalEmployeeAvatar {...template} />
                <span>
                  <strong>{template.name}</strong>
                  <small>{template.description || `${template.role} · ${template.domain || (zh ? '通用' : 'General')}`}</small>
                </span>
                <em>{zh ? '模板' : 'Template'}</em>
              </button>
            ))}
          </div>
        </FormDialog>
      ) : null}

      {error ? (
        <p className="digital-employee-feedback is-error" role="alert">
          <VisibleApplicationError error={error} language={zh ? 'zh-CN' : 'en'} />
        </p>
      ) : null}

      <div className="digital-employee-master-detail">
        <section className="digital-employee-list-pane" aria-label={zh ? '已创建的数字员工' : 'Created digital employees'}>
          <input
            className="digital-employee-list-search"
            type="search"
            aria-label={zh ? '搜索数字员工' : 'Search digital employees'}
            placeholder={zh ? '搜索姓名或岗位' : 'Search name, role, or domain'}
            value={employeeSearch}
            onChange={(event) => setEmployeeSearch(event.currentTarget.value)}
          />
          {loadState === 'loading' && employees.length === 0 ? (
            <p className="digital-employee-empty" role="status">
              {zh ? '正在读取数字员工…' : 'Loading digital employees…'}
            </p>
          ) : null}
          {loadState === 'failed' && employees.length === 0 ? (
            <Button variant="secondary" size="compact" onClick={() => void loadTemplates()}>
              {zh ? '重试' : 'Retry'}
            </Button>
          ) : null}
          {loadState === 'ready' && employees.length === 0 ? <p className="digital-employee-empty">{zh ? '尚未创建数字员工。' : 'No digital employees yet.'}</p> : null}
          {loadState === 'ready' && employees.length > 0 && visibleEmployees.length === 0 ? <p className="digital-employee-empty">{zh ? '没有匹配的数字员工。' : 'No matching digital employees.'}</p> : null}
          {visibleEmployees.map((employee) => (
            <button
              key={employee.id}
              type="button"
              className={`digital-employee-list-row ${editorTarget?.kind === 'employee' && editorTarget.record.id === employee.id ? 'is-selected' : ''}`}
              aria-pressed={editorTarget?.kind === 'employee' && editorTarget.record.id === employee.id}
              disabled={busy}
              onClick={() => beginInspect(employee)}
            >
              <DigitalEmployeeAvatar {...employee} />
              <span>
                <strong>{employee.name}</strong>
                <small>{employee.role}</small>
              </span>
            </button>
          ))}
        </section>

        <section className="digital-employee-editor-pane" aria-label={zh ? '数字员工详情' : 'Digital employee details'}>
          {!editorTarget ? (
            <div className="digital-employee-empty-state">
              <strong>{employees.length === 0 ? (zh ? '还没有数字员工' : 'No digital employees yet') : zh ? '选择数字员工查看配置' : 'Select a digital employee to inspect'}</strong>
            </div>
          ) : (
            <>
              <div className="employee-identity-heading">
                <DigitalEmployeeAvatar {...draft} />
                <div>
                  <h3>{draft.name || (zh ? '新建数字员工' : 'New employee')}</h3>
                  {editorTarget.kind === 'employee' ? (
                    <div className="digital-employee-save-state">
                      <small role={error ? 'alert' : 'status'}>
                        {busy
                          ? lastAction === 'delete'
                            ? zh
                              ? '正在删除…'
                              : 'Deleting…'
                            : zh
                              ? '正在保存…'
                              : 'Saving…'
                          : error
                            ? zh
                              ? '操作未完成，请重试'
                              : 'Action failed. Retry.'
                            : savedName
                              ? zh
                                ? '已保存'
                                : 'Saved'
                              : zh
                                ? '修改后自动保存'
                                : 'Changes save automatically'}
                      </small>
                      {error ? (
                        <Button size="compact" disabled={busy} onClick={() => (lastAction === 'delete' ? setPendingDelete(editorTarget.record) : void saveEmployee())}>
                          {lastAction === 'delete' ? (zh ? '重试删除' : 'Retry delete') : zh ? '重试保存' : 'Retry save'}
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                  <details className="digital-employee-disclosure">
                    <summary>{zh ? '更换头像' : 'Change portrait'}</summary>
                    <EmployeeAvatarPicker
                      {...draft}
                      disabled={busy}
                      language={props.language}
                      onChange={(avatarId) => {
                        const next = { ...draft, avatarId };
                        setDraft(next);
                        setSavedName(null);
                        if (editorTarget.kind === 'employee') void saveEmployee(next);
                      }}
                    />
                  </details>
                </div>
                {editorTarget.kind === 'employee' ? (
                  <Button variant="danger" size="compact" busy={busy} disabled={loadState === 'loading'} style={{ marginLeft: 'auto' }} onClick={() => setPendingDelete(editorTarget.record)}>
                    {zh ? '删除员工' : 'Delete employee'}
                  </Button>
                ) : null}
              </div>
              <nav className="employee-settings-navigation" aria-label={zh ? '员工设置内容' : 'Employee settings sections'}>
                {(['work', 'memory', 'history'] as const).map((section) => (
                  <Button
                    key={section}
                    size="compact"
                    variant="secondary"
                    aria-pressed={editorSection === section}
                    disabled={section !== 'work' && editorTarget.kind === 'new'}
                    title={section !== 'work' && editorTarget.kind === 'new' ? (zh ? '请先创建员工' : 'Create the employee first') : undefined}
                    onClick={() => setEditorSection(section)}
                  >
                    {{ work: zh ? '工作设置' : 'Work settings', memory: zh ? '员工记忆' : 'Employee memory', history: zh ? '使用记录' : 'Usage history' }[section]}
                  </Button>
                ))}
              </nav>
              {editorSection === 'work' ? (
                <DigitalEmployeeProfileEditor
                  client={props.client}
                  skillClient={props.skillClient}
                  draft={draft}
                  language={props.language}
                  disabled={busy}
                  onCommit={() => {
                    if (editorTarget.kind === 'employee') void saveEmployee();
                  }}
                  onChange={(next, commit) => {
                    setDraft(next);
                    setSavedName(null);
                    if (commit && editorTarget.kind === 'employee') void saveEmployee(next);
                  }}
                />
              ) : null}
              {editorSection !== 'work' && editorTarget.kind === 'employee' && props.client ? (
                <EmployeeMemoryPanel key={editorTarget.record.id} client={props.client} employeeId={editorTarget.record.id} language={props.language} view={editorSection} />
              ) : null}
            </>
          )}
          {editorTarget?.kind === 'new' ? (
            <footer className="digital-employee-editor-actions">
              <span className="digital-employee-actions">
                <Button variant="secondary" size="compact" disabled={busy} onClick={cancelEditing}>
                  {zh ? '取消' : 'Cancel'}
                </Button>
                <Button variant="primary" size="compact" busy={busy} disabled={loadState === 'loading'} onClick={() => void saveEmployee()}>
                  {zh ? '创建数字员工' : 'Create digital employee'}
                </Button>
              </span>
            </footer>
          ) : null}
        </section>
      </div>
    </section>
  );
}

/** 数字员工身份与工作配置编辑器。 */
function DigitalEmployeeProfileEditor(props: {
  /** 共享能力目录客户端。 */
  client: DigitalEmployeeApiClient | null;
  /** 会话 Skill 目录。 */
  skillClient: Pick<NativeConversationAppClient, 'loadSkills'> | null;
  draft: DigitalEmployeeTemplateDraft;
  language: DigitalEmployeeLanguage;
  disabled: boolean;
  /** 字段结束编辑时提交。 */
  onCommit: () => void;
  onChange: (draft: DigitalEmployeeTemplateDraft, commit?: boolean) => void;
}) {
  /** 当前编辑器使用的文案语言。 */
  const zh = props.language === 'zh-CN';
  /** 合并局部配置；选择类字段立即保存，文本字段在离开输入框时保存。 */
  const patch = (value: Partial<DigitalEmployeeTemplateDraft>) => props.onChange({ ...props.draft, ...value }, !['name', 'role', 'domain', 'description', 'prompt'].some((key) => key in value));
  return (
    <div
      className="digital-employee-form"
      onBlurCapture={(event) => {
        if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) props.onCommit();
      }}
    >
      <div className="digital-employee-form-grid">
        <label>
          <span>{zh ? '名称' : 'Name'}</span>
          <input value={props.draft.name} onChange={(event) => patch({ name: event.currentTarget.value })} disabled={props.disabled} maxLength={120} />
        </label>
        <label>
          <span>{zh ? '岗位' : 'Role'}</span>
          <input value={props.draft.role} onChange={(event) => patch({ role: event.currentTarget.value })} disabled={props.disabled} maxLength={120} />
        </label>
      </div>
      <label>
        <span>{zh ? '提示词' : 'Prompt'}</span>
        <textarea value={props.draft.prompt} onChange={(event) => patch({ prompt: event.currentTarget.value })} disabled={props.disabled} rows={4} maxLength={20000} required />
      </label>
      <section aria-label={zh ? '默认执行配置' : 'Execution defaults'}>
        <h3>{zh ? '默认执行配置' : 'Execution defaults'}</h3>
        <EmployeeExecutionSettings value={props.draft.settings} client={props.client} skillClient={props.skillClient} language={props.language} disabled={props.disabled} onChange={(settings) => patch({ settings })} />
      </section>
      <section aria-label={zh ? '员工记忆' : 'Employee memory'}>
        {/* 隐藏的原生输入不占网格，视觉复选框与文案分别占据两列。 */}
        <div className="digital-employee-policy-grid">
          <label className="digital-employee-checkbox-row">
            <input type="checkbox" checked={props.draft.memoryEnabled !== false} disabled={props.disabled} onChange={(event) => patch({ memoryEnabled: event.currentTarget.checked })} />
            <span className="digital-employee-checkbox-visual" aria-hidden="true" />
            <span>{zh ? '读取员工记忆' : 'Read employee memory'}</span>
          </label>
        </div>
      </section>
      <div className="digital-employee-form-grid">
        <label title={zh ? '员工资料，不作为提示词发送' : 'Profile information, not sent as a prompt'}>
          <span>{zh ? '业务领域' : 'Domain'}</span>
          <input value={props.draft.domain} onChange={(event) => patch({ domain: event.currentTarget.value })} disabled={props.disabled} maxLength={120} />
        </label>
        <label title={zh ? '员工资料，不作为提示词发送' : 'Profile information, not sent as a prompt'}>
          <span>{zh ? '说明' : 'Description'}</span>
          <textarea value={props.draft.description} onChange={(event) => patch({ description: event.currentTarget.value })} disabled={props.disabled} rows={2} maxLength={1000} />
        </label>
      </div>
    </div>
  );
}
