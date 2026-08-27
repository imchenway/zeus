import { useCallback, useEffect, useState } from 'react';
import { Button } from '../../ui/Button.js';
import { ZeusSelect } from '../../ZeusSelect.js';
import { SkillSelector } from '../skills/SkillSelector.js';
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

type EditorTarget = { kind: 'new' } | { kind: 'template'; record: DigitalEmployeeTemplateRecord } | null;

export function DigitalEmployeeTemplatesSettings(props: DigitalEmployeeTemplatesSettingsProps) {
  const zh = props.language === 'zh-CN';
  const [templates, setTemplates] = useState<DigitalEmployeeTemplateRecord[]>([]);
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editorTarget, setEditorTarget] = useState<EditorTarget>(null);
  const [draft, setDraft] = useState<DigitalEmployeeTemplateDraft>({ ...emptyTemplateDraft });

  const loadTemplates = useCallback(async () => {
    if (!props.client) return;
    setLoadState('loading');
    setError(null);
    try {
      setTemplates(await props.client.loadDigitalEmployeeTemplates());
      setLoadState('ready');
    } catch (cause) {
      setLoadState('failed');
      setError(errorMessage(cause, zh ? '无法读取数字员工模板。' : 'Could not load digital employee templates.'));
    }
  }, [props.client, zh]);

  useEffect(() => {
    void loadTemplates();
  }, [loadTemplates]);

  function beginCreate(): void {
    setEditorTarget({ kind: 'new' });
    setDraft({ ...emptyTemplateDraft });
    setError(null);
  }

  function beginInspect(record: DigitalEmployeeTemplateRecord): void {
    setEditorTarget({ kind: 'template', record });
    setDraft(templateDraft(record));
    setError(null);
  }

  async function saveTemplate(): Promise<void> {
    if (!props.client || !editorTarget || (editorTarget.kind === 'template' && editorTarget.record.builtIn)) return;
    if (!draft.name.trim() || !draft.role.trim() || !draft.prompt.trim()) {
      setError(zh ? '名称、岗位和提示词不能为空。' : 'Name, role, and prompt are required.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const record =
        editorTarget.kind === 'new' ? await props.client.createDigitalEmployeeTemplate(templateInput(draft)) : await props.client.updateDigitalEmployeeTemplate(editorTarget.record.id, editorTarget.record.revision, templateInput(draft));
      setTemplates((current) => {
        const exists = current.some((candidate) => candidate.id === record.id);
        return sortTemplates(exists ? current.map((candidate) => (candidate.id === record.id ? record : candidate)) : [...current, record]);
      });
      setEditorTarget({ kind: 'template', record });
      setDraft(templateDraft(record));
    } catch (cause) {
      setError(errorMessage(cause, zh ? '保存数字员工模板失败。' : 'Could not save the digital employee template.'));
    } finally {
      setBusy(false);
    }
  }

  async function deleteTemplate(record: DigitalEmployeeTemplateRecord): Promise<void> {
    if (!props.client || record.builtIn) return;
    const confirmed = window.confirm(zh ? `删除自定义模板“${record.name}”？已分配到项目的员工配置不会被删除。` : `Delete custom template “${record.name}”? Existing project employees will remain.`);
    if (!confirmed) return;
    setBusy(true);
    setError(null);
    try {
      await props.client.deleteDigitalEmployeeTemplate(record.id, record.revision);
      setTemplates((current) => current.filter((candidate) => candidate.id !== record.id));
      setEditorTarget(null);
      setDraft({ ...emptyTemplateDraft });
    } catch (cause) {
      setError(errorMessage(cause, zh ? '删除数字员工模板失败。' : 'Could not delete the digital employee template.'));
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
          <p>{zh ? '维护可复用的岗位基线。模板不会获得任何项目访问权；分配到项目后才形成独立员工配置。' : 'Maintain reusable role baselines. Templates gain no project access until assigned as a project employee.'}</p>
        </span>
        <span className="digital-employee-actions">
          <Button variant="secondary" size="compact" busy={loadState === 'loading'} onClick={() => void loadTemplates()}>
            {zh ? '刷新' : 'Refresh'}
          </Button>
          <Button variant="primary" size="compact" onClick={beginCreate}>
            {zh ? '新建自定义模板' : 'New custom template'}
          </Button>
        </span>
      </header>

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
            <TemplateEditor draft={draft} skillClient={props.skillClient} language={props.language} readOnly={readOnly} onChange={setDraft} />
          )}
          {editorTarget ? (
            <footer className="digital-employee-editor-actions">
              <small>
                {readOnly
                  ? zh
                    ? '内置模板是只读基线；可将它分配到项目后覆盖。'
                    : 'Built-in templates are read-only baselines. Override them after project assignment.'
                  : zh
                    ? '模板更新不会静默覆盖现有项目员工。'
                    : 'Template changes never silently overwrite existing project employees.'}
              </small>
              <span className="digital-employee-actions">
                {editorTarget.kind === 'template' && !editorTarget.record.builtIn ? (
                  <Button variant="danger" size="compact" busy={busy} onClick={() => void deleteTemplate(editorTarget.record)}>
                    {zh ? '删除' : 'Delete'}
                  </Button>
                ) : null}
                {!readOnly ? (
                  <Button variant="primary" size="compact" busy={busy} onClick={() => void saveTemplate()}>
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
        <label>
          <span>{zh ? '运行时' : 'Runtime'}</span>
          <ZeusSelect
            size="regular"
            ariaLabel={zh ? '选择运行时' : 'Choose runtime'}
            value={props.draft.agentKind}
            onChange={(agentKind) => patch({ agentKind })}
            disabled={props.readOnly}
            searchable={false}
            options={[
              { value: 'codex', label: 'Codex' },
              { value: 'pi', label: 'Pi' },
            ]}
          />
        </label>
        <label>
          <span>{zh ? '权限模式' : 'Permission mode'}</span>
          <ZeusSelect
            size="regular"
            ariaLabel={zh ? '选择权限模式' : 'Choose permission mode'}
            value={props.draft.permissionMode}
            onChange={(permissionMode) => patch({ permissionMode })}
            disabled={props.readOnly}
            searchable={false}
            options={[
              { value: 'read-only', label: zh ? '只读' : 'Read-only' },
              { value: 'auto', label: zh ? '自动' : 'Auto' },
              { value: 'full-access', label: zh ? '完全访问' : 'Full access' },
            ]}
          />
        </label>
        <label>
          <span>{zh ? '工作模式' : 'Work mode'}</span>
          <ZeusSelect
            size="regular"
            ariaLabel={zh ? '选择工作模式' : 'Choose work mode'}
            value={props.draft.workMode}
            onChange={(workMode) => patch({ workMode })}
            disabled={props.readOnly}
            searchable={false}
            options={[
              { value: 'default', label: zh ? '默认' : 'Default' },
              { value: 'plan', label: zh ? '规划' : 'Plan' },
            ]}
          />
        </label>
        <label>
          <span>{zh ? '模型（可选）' : 'Model (optional)'}</span>
          <input value={props.draft.model} onChange={(event) => patch({ model: event.currentTarget.value })} disabled={props.readOnly} maxLength={256} />
        </label>
        <label>
          <span>{zh ? '推理强度（可选）' : 'Reasoning effort (optional)'}</span>
          <input value={props.draft.reasoningEffort} onChange={(event) => patch({ reasoningEffort: event.currentTarget.value })} disabled={props.readOnly} maxLength={64} />
        </label>
        <label>
          <span>{zh ? '服务层级（可选）' : 'Service tier (optional)'}</span>
          <input value={props.draft.serviceTier} onChange={(event) => patch({ serviceTier: event.currentTarget.value })} disabled={props.readOnly} maxLength={64} />
        </label>
      </div>
      <label>
        <span>{zh ? '说明' : 'Description'}</span>
        <textarea value={props.draft.description} onChange={(event) => patch({ description: event.currentTarget.value })} disabled={props.readOnly} rows={2} maxLength={1000} />
      </label>
      <label>
        <span>{zh ? '默认 Skill（可选）' : 'Default skill (optional)'}</span>
        <SkillSelector
          client={props.skillClient}
          value={props.draft.skillId}
          onChange={(skillId) => patch({ skillId })}
          language={props.language}
          disabled={props.readOnly}
          ariaLabel={zh ? '选择模板默认 Skill' : 'Choose template default skill'}
        />
        <small>{zh ? '只绑定 Zeus Skill 目录中的稳定身份；不会授予工具、凭据或交付权限。' : 'Binds a stable Zeus Skill identity without granting tools, credentials, or delivery permissions.'}</small>
      </label>
      <label>
        <span>{zh ? '员工提示词' : 'Employee prompt'}</span>
        <textarea value={props.draft.prompt} onChange={(event) => patch({ prompt: event.currentTarget.value })} disabled={props.readOnly} rows={7} maxLength={20000} />
      </label>
    </div>
  );
}

function sortTemplates(records: DigitalEmployeeTemplateRecord[]): DigitalEmployeeTemplateRecord[] {
  return [...records].sort((left, right) => Number(right.builtIn) - Number(left.builtIn) || left.name.localeCompare(right.name));
}
