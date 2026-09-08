import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../../ui/Button.js';
import type { NativeConversationAppClient } from '../workspace/workspaceSupport.js';
import { AgentExecutionConfigFields } from './AgentExecutionConfigFields.js';
import type { DigitalEmployeeApiClient } from './digitalEmployeeApiClient.js';
import type { DigitalEmployeeCapabilitiesSnapshot, DigitalEmployeeTemplateRecord } from './digitalEmployeeContracts.js';
import { emptyTemplateDraft, errorMessage, templateDraft, templateInput, type DigitalEmployeeLanguage, type DigitalEmployeeTemplateDraft } from './digitalEmployeeUiSupport.js';
import './digitalEmployees.css';

export interface DigitalEmployeeTemplatesSettingsProps {
  client: DigitalEmployeeApiClient | null;
  skillClient: Pick<NativeConversationAppClient, 'loadSkills'> | null;
  language: DigitalEmployeeLanguage;
}

type EditorTarget = { kind: 'new' } | { kind: 'template'; record: DigitalEmployeeTemplateRecord } | null;

export function DigitalEmployeeTemplatesSettings(props: DigitalEmployeeTemplatesSettingsProps) {
  const zh = props.language === 'zh-CN';
  const [templates, setTemplates] = useState<DigitalEmployeeTemplateRecord[]>([]);
  const [capabilities, setCapabilities] = useState<DigitalEmployeeCapabilitiesSnapshot | null>(null);
  const loadRevisionRef = useRef(0);
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle');
  const [busy, setBusy] = useState(false);
  const [savedName, setSavedName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editorTarget, setEditorTarget] = useState<EditorTarget>(null);
  const draftsRef = useRef(new Map<string, { draft: DigitalEmployeeTemplateDraft; target: NonNullable<EditorTarget> }>());
  const [draft, setDraft] = useState<DigitalEmployeeTemplateDraft>({ ...emptyTemplateDraft });

  const loadTemplates = useCallback(async () => {
    if (!props.client) return;
    const revision = ++loadRevisionRef.current;
    setLoadState('loading');
    setError(null);
    setSavedName(null);
    try {
      const [nextTemplates, nextCapabilities] = await Promise.all([props.client.loadDigitalEmployeeTemplates(), props.client.loadDigitalEmployeeCapabilities()]);
      if (revision !== loadRevisionRef.current) return;
      setTemplates(nextTemplates);
      setCapabilities(nextCapabilities);
      setLoadState('ready');
    } catch (cause) {
      if (revision !== loadRevisionRef.current) return;
      setLoadState('failed');
      setError(errorMessage(cause, zh ? 'zh-CN' : 'en'));
    }
  }, [props.client, zh]);

  useEffect(() => {
    void loadTemplates();
    return () => { loadRevisionRef.current += 1; };
  }, [loadTemplates]);

  function rememberDraft(): void {
    if (!editorTarget || (editorTarget.kind === 'template' && editorTarget.record.builtIn)) return;
    const key = editorTarget.kind === 'new' ? 'new' : editorTarget.record.id;
    if (editorTarget.kind === 'template' && JSON.stringify(draft) === JSON.stringify(templateDraft(editorTarget.record))) {
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

  function beginCreate(): void {
    if (busy) return;
    rememberDraft();
    setEditorTarget({ kind: 'new' });
    setDraft(draftsRef.current.get('new')?.draft ?? { ...emptyTemplateDraft });
    setError(null);
    setSavedName(null);
  }

  function beginInspect(record: DigitalEmployeeTemplateRecord): void {
    if (busy) return;
    rememberDraft();
    const cached = draftsRef.current.get(record.id);
    setEditorTarget(cached?.target ?? { kind: 'template', record });
    setDraft(cached?.draft ?? templateDraft(record));
    setError(null);
    setSavedName(null);
  }

  async function saveTemplate(): Promise<void> {
    if (busy || loadState === 'loading' || !props.client || !editorTarget || (editorTarget.kind === 'template' && editorTarget.record.builtIn)) return;
    if (!draft.name.trim() || !draft.role.trim() || !draft.prompt.trim()) {
      setError(zh ? '名称、岗位和提示词不能为空。' : 'Name, role, and prompt are required.');
      return;
    }
    setBusy(true);
    setError(null);
    setSavedName(null);
    try {
      const record =
        editorTarget.kind === 'new' ? await props.client.createDigitalEmployeeTemplate(templateInput(draft)) : await props.client.updateDigitalEmployeeTemplate(editorTarget.record.id, editorTarget.record.revision, templateInput(draft));
      setTemplates((current) => {
        const exists = current.some((candidate) => candidate.id === record.id);
        return sortTemplates(exists ? current.map((candidate) => (candidate.id === record.id ? record : candidate)) : [...current, record]);
      });
      draftsRef.current.delete(editorTarget.kind === 'new' ? 'new' : editorTarget.record.id);
      setEditorTarget({ kind: 'template', record });
      setDraft(templateDraft(record));
      setSavedName(record.name);
    } catch (cause) {
      setError(errorMessage(cause, zh ? 'zh-CN' : 'en'));
    } finally {
      setBusy(false);
    }
  }

  async function deleteTemplate(record: DigitalEmployeeTemplateRecord): Promise<void> {
    if (busy || loadState === 'loading' || !props.client || record.builtIn) return;
    const confirmed = window.confirm(zh ? `删除自定义模板“${record.name}”？已分配到项目的员工配置不会被删除。` : `Delete custom template “${record.name}”? Existing project employees will remain.`);
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
      <section className="settings-product-pane digital-employee-settings-pane" aria-label={zh ? '数字员工模板' : 'Digital employee templates'}>
        <h2 className="settings-page-title">{zh ? '数字员工' : 'Digital employees'}</h2>
        <p className="digital-employee-empty">{zh ? '当前连接不支持数字员工配置。' : 'Digital employee configuration is unavailable on this connection.'}</p>
      </section>
    );
  }

  const readOnly = editorTarget?.kind === 'template' && editorTarget.record.builtIn;
  return (
    <section className="settings-product-pane digital-employee-settings-pane" aria-label={zh ? '数字员工模板' : 'Digital employee templates'}>
      <header className="digital-employee-page-heading">
        <span>
          <h2 className="settings-page-title">{zh ? '数字员工' : 'Digital employees'}</h2>
          <p>{zh ? '保存可重复使用的岗位和工作要求。将模板添加到项目后，再为该员工设置项目权限。' : 'Save reusable roles and work instructions. Add a template to a project, then configure that employee’s project permissions.'}</p>
        </span>
        <span className="digital-employee-actions">
          <Button variant="secondary" size="compact" busy={loadState === 'loading'} disabled={busy} onClick={() => void loadTemplates()}>
            {zh ? '刷新' : 'Refresh'}
          </Button>
          <Button variant="primary" size="compact" disabled={busy} onClick={beginCreate}>
            {zh ? '新建自定义模板' : 'New custom template'}
          </Button>
        </span>
      </header>

      {savedName && !error ? (
        <p className="digital-employee-feedback" role="status">
          {zh ? `已保存模板“${savedName}”。` : `Saved template “${savedName}”.`}
        </p>
      ) : null}
      {error ? (
        <p className="digital-employee-feedback is-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="digital-employee-master-detail">
        <section className="digital-employee-list-pane" aria-label={zh ? '模板列表' : 'Template list'}>
          {loadState === 'loading' && templates.length === 0 ? (
            <p className="digital-employee-empty" role="status">
              {zh ? '正在读取模板…' : 'Loading templates…'}
            </p>
          ) : null}
          {loadState === 'failed' && templates.length === 0 ? (
            <Button variant="secondary" size="compact" onClick={() => void loadTemplates()}>
              {zh ? '重试' : 'Retry'}
            </Button>
          ) : null}
          {templates.map((template) => (
            <button
              key={template.id}
              type="button"
              className={`digital-employee-list-row ${editorTarget?.kind === 'template' && editorTarget.record.id === template.id ? 'is-selected' : ''}`}
              aria-pressed={editorTarget?.kind === 'template' && editorTarget.record.id === template.id}
              disabled={busy}
              onClick={() => beginInspect(template)}
            >
              <span className="digital-employee-avatar" aria-hidden="true">
                {template.role.slice(0, 1)}
              </span>
              <span>
                <strong>{template.name}</strong>
                <small>
                  {template.role} · {template.domain || (zh ? '通用' : 'General')}
                </small>
              </span>
              <em>{template.builtIn ? (zh ? '内置' : 'Built-in') : zh ? '自定义' : 'Custom'}</em>
            </button>
          ))}
        </section>

        <section className="digital-employee-editor-pane" aria-label={zh ? '模板详情' : 'Template detail'}>
          {!editorTarget ? (
            <div className="digital-employee-empty-state">
              <strong>{zh ? '选择一个模板查看配置' : 'Select a template to inspect'}</strong>
              <span>{zh ? '也可以创建自己的岗位、业务领域、Skill 和提示词组合。' : 'Or create a custom combination of role, domain, skills, and prompt.'}</span>
            </div>
          ) : (
            <TemplateEditor draft={draft} models={capabilities?.models ?? []} skillClient={props.skillClient} language={props.language} readOnly={readOnly || busy} onChange={(next) => { setDraft(next); setSavedName(null); }} />
          )}
          {editorTarget ? (
            <footer className="digital-employee-editor-actions">
              <small>
                {readOnly
                  ? zh
                    ? '内置模板不能直接修改。添加到项目后，可以调整该员工的配置。'
                    : 'Built-in templates cannot be edited directly. Add one to a project to customize that employee’s settings.'
                  : zh
                    ? '更新模板不会改变已添加到项目的员工配置。'
                    : 'Updating a template does not change employees already added to projects.'}
              </small>
              <span className="digital-employee-actions">
                {!readOnly ? (
                  <Button variant="secondary" size="compact" disabled={busy} onClick={cancelEditing}>
                    {zh ? '取消编辑' : 'Cancel editing'}
                  </Button>
                ) : null}
                {editorTarget.kind === 'template' && !editorTarget.record.builtIn ? (
                  <Button variant="danger" size="compact" busy={busy} disabled={loadState === 'loading'} onClick={() => void deleteTemplate(editorTarget.record)}>
                    {zh ? '删除' : 'Delete'}
                  </Button>
                ) : null}
                {!readOnly ? (
                  <Button variant="primary" size="compact" busy={busy} disabled={loadState === 'loading'} onClick={() => void saveTemplate()}>
                    {zh ? '保存模板' : 'Save template'}
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

function TemplateEditor(props: {
  draft: DigitalEmployeeTemplateDraft;
  models: DigitalEmployeeCapabilitiesSnapshot['models'];
  skillClient: Pick<NativeConversationAppClient, 'loadSkills'> | null;
  language: DigitalEmployeeLanguage;
  readOnly: boolean;
  onChange: (draft: DigitalEmployeeTemplateDraft) => void;
}) {
  const zh = props.language === 'zh-CN';
  const patch = (value: Partial<DigitalEmployeeTemplateDraft>) => props.onChange({ ...props.draft, ...value });
  return (
    <div className="digital-employee-form">
      <div className="digital-employee-form-grid">
        <label>
          <span>{zh ? '模板名称' : 'Template name'}</span>
          <input value={props.draft.name} onChange={(event) => patch({ name: event.currentTarget.value })} disabled={props.readOnly} maxLength={120} />
        </label>
        <label>
          <span>{zh ? '岗位' : 'Role'}</span>
          <input value={props.draft.role} onChange={(event) => patch({ role: event.currentTarget.value })} disabled={props.readOnly} maxLength={120} />
        </label>
        <label>
          <span>{zh ? '业务领域' : 'Business domain'}</span>
          <input value={props.draft.domain} onChange={(event) => patch({ domain: event.currentTarget.value })} disabled={props.readOnly} maxLength={120} placeholder={zh ? '例如 CSS、PIM' : 'For example CSS or PIM'} />
        </label>
      </div>
      <label>
        <span>{zh ? '说明' : 'Description'}</span>
        <textarea value={props.draft.description} onChange={(event) => patch({ description: event.currentTarget.value })} disabled={props.readOnly} rows={2} maxLength={1000} />
      </label>
      <section className="digital-employee-form-section">
        <header>
          <strong>{zh ? 'AI 工作配置' : 'AI work settings'}</strong>
          <small>{zh ? '与项目数字员工和单次执行使用相同的模型、联动选项、Skill 与提示词字段。' : 'Uses the same model, linked options, skills, and prompt fields as project employees and individual runs.'}</small>
        </header>
        <AgentExecutionConfigFields value={props.draft} models={props.models} skillClient={props.skillClient} language={props.language} readOnly={props.readOnly} onChange={patch} />
      </section>
    </div>
  );
}

function sortTemplates(records: DigitalEmployeeTemplateRecord[]): DigitalEmployeeTemplateRecord[] {
  return [...records].sort((left, right) => Number(right.builtIn) - Number(left.builtIn) || left.name.localeCompare(right.name));
}
