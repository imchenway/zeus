import { useCallback, useEffect, useRef, useState } from 'react';
import { DigitalEmployeeAvatar, EmployeeAvatarPicker } from './DigitalEmployeeAvatar.js';
import { SettingsSaveStatus } from '../../settings/useSettingsAutosave.js';
import { Button } from '../../ui/Button.js';
import { FormDialog } from '../../ui/FormDialog.js';
import type { NativeConversationAppClient } from '../workspace/workspaceSupport.js';
import type { DigitalEmployeeApiClient } from './digitalEmployeeApiClient.js';
import type { DigitalEmployeeTemplateRecord } from './digitalEmployeeContracts.js';
import { emptyTemplateDraft, errorMessage, templateDraft, templateInput, type DigitalEmployeeLanguage, type DigitalEmployeeTemplateDraft } from './digitalEmployeeUiSupport.js';
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

export function DigitalEmployeeTemplatesSettings(props: DigitalEmployeeTemplatesSettingsProps) {
  const zh = props.language === 'zh-CN';
  const [templates, setTemplates] = useState<DigitalEmployeeTemplateRecord[]>([]);
  const loadRevisionRef = useRef(0);
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle');
  const [busy, setBusy] = useState(false);
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
      setError(zh ? '名称、岗位和提示词不能为空。' : 'Name, role, and prompt are required.');
      return;
    }
    savingRef.current = true;
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

  /** 删除用户创建的数字员工，不影响已经添加到项目的独立副本。 */
  async function deleteEmployee(record: DigitalEmployeeTemplateRecord): Promise<void> {
    if (busy || loadState === 'loading' || !props.client || record.builtIn) return;
    const confirmed = window.confirm(zh ? `删除数字员工“${record.name}”？已添加到项目的员工配置不会被删除。` : `Delete digital employee “${record.name}”? Existing project employees will remain.`);
    if (!confirmed) return;
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
  /** 非内置记录就是用户已创建且可自由编辑的数字员工。 */
  const employees = templates.filter((template) => !template.builtIn);
  return (
    <section className="settings-product-pane digital-employee-settings-pane" aria-label={zh ? '数字员工' : 'Digital employees'}>
      <header className="digital-employee-page-heading">
        <span>
          <h2 className="settings-page-title">{zh ? '数字员工' : 'Digital employees'}</h2>
          <p>{zh ? '管理你创建的数字员工。新增时可以从模板开始或自己新建；创建后可以自由编辑。' : 'Manage the digital employees you create. Start from a template or create your own, then edit it freely.'}</p>
        </span>
        <span className="digital-employee-actions">
          <SettingsSaveStatus language={props.language} status={busy ? 'saving' : error ? 'failed' : savedName ? 'saved' : 'idle'} />
          {error && editorTarget?.kind === 'employee' ? (
            <Button size="compact" disabled={busy} onClick={() => void saveEmployee()}>
              {zh ? '重试保存' : 'Retry save'}
            </Button>
          ) : null}
          <Button variant="secondary" size="compact" busy={loadState === 'loading'} disabled={busy} onClick={() => void loadTemplates()}>
            {zh ? '刷新' : 'Refresh'}
          </Button>
          <Button variant="primary" size="compact" disabled={busy || loadState !== 'ready'} onClick={beginCreate}>
            {zh ? '新增' : 'Add'}
          </Button>
        </span>
      </header>

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
          {error}
        </p>
      ) : null}

      <div className="digital-employee-master-detail">
        <section className="digital-employee-list-pane" aria-label={zh ? '已创建的数字员工' : 'Created digital employees'}>
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
          {employees.map((employee) => (
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
                <small>
                  {employee.role} · {employee.domain || (zh ? '通用' : 'General')}
                </small>
              </span>
            </button>
          ))}
        </section>

        <section className="digital-employee-editor-pane" aria-label={zh ? '数字员工详情' : 'Digital employee details'}>
          {!editorTarget ? (
            <div className="digital-employee-empty-state">
              <strong>{employees.length === 0 ? (zh ? '还没有数字员工' : 'No digital employees yet') : zh ? '选择数字员工查看配置' : 'Select a digital employee to inspect'}</strong>
              <span>
                {employees.length === 0
                  ? zh
                    ? '点击右上角“新增”，从模板开始或自己新建。'
                    : 'Click Add to start from a template or create your own.'
                  : zh
                    ? '创建后的配置可以自由编辑，不会回写模板。'
                    : 'Created employees are freely editable and never write back to templates.'}
              </span>
            </div>
          ) : (
            <>
              <div className="employee-identity-heading">
                <DigitalEmployeeAvatar {...draft} />
                <div>
                  <h3>{draft.name || (zh ? '新建数字员工' : 'New employee')}</h3>
                  <span>{zh ? '选择预置头像' : 'Choose a portrait'}</span>
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
                </div>
              </div>
              <DigitalEmployeeProfileEditor
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
            </>
          )}
          {editorTarget ? (
            <footer className="digital-employee-editor-actions">
              <small>
                {zh
                  ? '员工独立于创建模板；项目未覆盖的配置随员工更新，已启动的工作保持原配置。'
                  : 'Employees are independent from their source templates. Projects inherit changes unless overridden; work already started keeps its original settings.'}
              </small>
              <span className="digital-employee-actions">
                <Button variant="secondary" size="compact" disabled={busy} onClick={cancelEditing}>
                  {editorTarget.kind === 'new' ? (zh ? '取消' : 'Cancel') : zh ? '完成编辑' : 'Done'}
                </Button>
                {editorTarget.kind === 'employee' ? (
                  <Button variant="danger" size="compact" busy={busy} disabled={loadState === 'loading'} onClick={() => void deleteEmployee(editorTarget.record)}>
                    {zh ? '删除' : 'Delete'}
                  </Button>
                ) : null}
                {editorTarget.kind === 'new' ? (
                  <Button variant="primary" size="compact" busy={busy} disabled={loadState === 'loading'} onClick={() => void saveEmployee()}>
                    {zh ? '创建数字员工' : 'Create digital employee'}
                  </Button>
                ) : null}
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
          <span>{zh ? '员工名称' : 'Employee name'}</span>
          <input value={props.draft.name} onChange={(event) => patch({ name: event.currentTarget.value })} disabled={props.disabled} maxLength={120} />
        </label>
        <label>
          <span>{zh ? '岗位' : 'Role'}</span>
          <input value={props.draft.role} onChange={(event) => patch({ role: event.currentTarget.value })} disabled={props.disabled} maxLength={120} />
        </label>
        <label>
          <span>{zh ? '业务领域' : 'Business domain'}</span>
          <input value={props.draft.domain} onChange={(event) => patch({ domain: event.currentTarget.value })} disabled={props.disabled} maxLength={120} placeholder={zh ? '例如 CSS、PIM' : 'For example CSS or PIM'} />
        </label>
      </div>
      <label>
        <span>{zh ? '说明' : 'Description'}</span>
        <textarea value={props.draft.description} onChange={(event) => patch({ description: event.currentTarget.value })} disabled={props.disabled} rows={2} maxLength={1000} />
      </label>
      <section className="digital-employee-form-section">
        <header>
          <strong>{zh ? '工作要求' : 'Instructions'}</strong>
          <small>{zh ? '提示词定义员工职责，模型与 Skills 使用统一执行默认。' : 'The prompt defines this employee’s responsibilities. Model and skills use the shared execution defaults.'}</small>
        </header>
        <label>
          <span>{zh ? '提示词' : 'Prompt'}</span>
          <textarea value={props.draft.prompt} onChange={(event) => patch({ prompt: event.currentTarget.value })} disabled={props.disabled} rows={8} maxLength={20000} required />
        </label>
      </section>
      <section className="digital-employee-form-section">
        <header>
          <strong>{zh ? '经验与记忆' : 'Experience and memory'}</strong>
          <small>{zh ? '新工作读取已确认且未过期的个人经验，项目可以单独调整。' : 'New work reads approved, current employee experience. Projects can override this preference.'}</small>
        </header>
        {/* 隐藏的原生输入不占网格，视觉复选框与文案分别占据两列。 */}
        <div className="digital-employee-policy-grid">
          <label className="digital-employee-checkbox-row">
            <input type="checkbox" checked={props.draft.memoryEnabled !== false} disabled={props.disabled} onChange={(event) => patch({ memoryEnabled: event.currentTarget.checked })} />
            <span className="digital-employee-checkbox-visual" aria-hidden="true" />
            <span>{zh ? '读取已确认员工经验' : 'Read approved employee memory'}</span>
          </label>
        </div>
      </section>
    </div>
  );
}
