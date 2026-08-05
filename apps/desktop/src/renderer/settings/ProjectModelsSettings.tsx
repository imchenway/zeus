import { useEffect, useMemo, useState } from 'react';
import type { DashboardClient, ProjectModelSelection, SelectablePiModel } from '../apiClient.js';
import { ZeusSelect } from '../ZeusSelect.js';
import { Button } from '../ui/Button.js';

type ProjectModelsClient = Pick<DashboardClient, 'loadSelectablePiModels' | 'loadProjectModelSelection' | 'saveProjectModelSelection'>;

export function ProjectModelsSettings(props: { projectId: string; language: 'zh-CN' | 'en-US'; client: ProjectModelsClient | null }) {
  const zh = props.language === 'zh-CN';
  const [models, setModels] = useState<SelectablePiModel[]>([]);
  const [selection, setSelection] = useState<ProjectModelSelection>({ projectId: props.projectId, allowedModelRefs: [], defaultModelRef: null });
  const [status, setStatus] = useState<'loading' | 'ready' | 'saving'>('loading');
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setStatus('loading');
    setMessage(null);
    if (!props.client) {
      setModels([]);
      setSelection({ projectId: props.projectId, allowedModelRefs: [], defaultModelRef: null });
      setStatus('ready');
      return () => {
        active = false;
      };
    }
    void Promise.all([props.client.loadSelectablePiModels(), props.client.loadProjectModelSelection(props.projectId)])
      .then(([catalog, nextSelection]) => {
        if (!active) return;
        setModels(catalog);
        setSelection(nextSelection);
        setStatus('ready');
      })
      .catch((error: unknown) => {
        if (!active) return;
        setMessage(error instanceof Error ? error.message : String(error));
        setStatus('ready');
      });
    return () => {
      active = false;
    };
  }, [props.client, props.projectId]);

  const selectedModels = useMemo(() => models.filter((model) => selection.allowedModelRefs.includes(model.id)), [models, selection.allowedModelRefs]);
  const defaultModelRef = selection.defaultModelRef && selection.allowedModelRefs.includes(selection.defaultModelRef) ? selection.defaultModelRef : (selection.allowedModelRefs[0] ?? '');

  function toggleModel(modelRef: string, checked: boolean): void {
    setSelection((current) => {
      const allowedModelRefs = checked ? [...new Set([...current.allowedModelRefs, modelRef])] : current.allowedModelRefs.filter((item) => item !== modelRef);
      return {
        ...current,
        allowedModelRefs,
        defaultModelRef: current.defaultModelRef && allowedModelRefs.includes(current.defaultModelRef) ? current.defaultModelRef : (allowedModelRefs[0] ?? null),
      };
    });
  }

  async function save(): Promise<void> {
    if (!props.client || status !== 'ready') return;
    setStatus('saving');
    setMessage(null);
    try {
      const saved = await props.client.saveProjectModelSelection(props.projectId, selection);
      setSelection(saved);
      setMessage(zh ? '项目可用模型已保存。' : 'Project models saved.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setStatus('ready');
    }
  }

  return (
    <section className="project-model-settings" aria-label={zh ? '项目可用模型' : 'Project models'}>
      <span className="project-config-setting-copy">
        <strong>{zh ? '项目可用模型' : 'Project models'}</strong>
        <small>{zh ? '可同时选择多个 Pi 模型；默认模型只负责预选，推送任务和会话仍可逐次切换。' : 'Select multiple Pi models. The default only controls preselection; tasks and conversations can still switch per turn.'}</small>
      </span>
      <div className="project-model-settings-body">
        {status === 'loading' ? <small>{zh ? '正在读取模型…' : 'Loading models…'}</small> : null}
        {status !== 'loading' && models.length === 0 ? <small>{zh ? '请先在系统设置的“模型供应商”中添加连接和模型。' : 'Add a connection and models under Model providers in system settings first.'}</small> : null}
        <fieldset className="project-model-choice-list" disabled={status !== 'ready'}>
          {models.map((model) => (
            <label key={model.id}>
              <input type="checkbox" checked={selection.allowedModelRefs.includes(model.id)} onChange={(event) => toggleModel(model.id, event.currentTarget.checked)} />
              <span>
                <strong>{model.displayName}</strong>
                <small>
                  {model.sourceName} · {formatSpeed(model.speedLabel, zh)} · {model.available ? (zh ? '可运行' : 'Ready') : model.availabilityReason}
                </small>
              </span>
            </label>
          ))}
        </fieldset>
        {selectedModels.length > 0 ? (
          <label className="project-model-default-field">
            <span>{zh ? '默认预选模型' : 'Default preselected model'}</span>
            <ZeusSelect
              ariaLabel={zh ? '默认预选模型' : 'Default preselected model'}
              size="roomy"
              value={defaultModelRef}
              onChange={(value) => setSelection((current) => ({ ...current, defaultModelRef: value }))}
              options={selectedModels.map((model) => ({ value: model.id, label: `${model.sourceName} / ${model.displayName}` }))}
            />
          </label>
        ) : null}
        {message ? <small role="status">{message}</small> : null}
        <div className="project-config-command-rail">
          <Button variant="secondary" size="compact" onClick={() => void save()} disabled={!props.client || status !== 'ready'} busy={status === 'saving'}>
            {zh ? '保存可用模型' : 'Save project models'}
          </Button>
        </div>
      </div>
    </section>
  );
}

function formatSpeed(speed: SelectablePiModel['speedLabel'], zh: boolean): string {
  if (speed === 'standard') return zh ? '标准模型' : 'Standard model';
  if (speed === 'high_speed') return zh ? '高速模型' : 'High-speed model';
  if (speed === 'flash') return 'Flash';
  return 'Turbo';
}
