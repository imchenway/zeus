import { useEffect, useMemo, useState } from 'react';
import type { DashboardClient, ProjectModelSelection, SelectablePiModel } from '../apiClient.js';
import { presentModelOptions } from '../modelOptionPresentation.js';
import { ZeusSelect } from '../ZeusSelect.js';
import { Button } from '../ui/Button.js';
import { formatVisibleApplicationError } from '../ui/ApplicationErrorDialog.js';

type ProjectModelsClient = Pick<DashboardClient, 'loadSelectablePiModels' | 'loadProjectModelSelection' | 'saveProjectModelSelection'>;

export function ProjectModelsSettings(props: { projectId: string; language: 'zh-CN' | 'en-US'; client: ProjectModelsClient | null }) {
  const zh = props.language === 'zh-CN';
  const [models, setModels] = useState<SelectablePiModel[]>([]);
  const [selection, setSelection] = useState<ProjectModelSelection>({ projectId: props.projectId, allowedModelRefs: [], defaultModelRef: null });
  const [status, setStatus] = useState<'loading' | 'ready' | 'saving'>('loading');
  const [message, setMessage] = useState<string | null>(null);
    const [searchQuery, setSearchQuery] = useState('');

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
        const availableRefs = new Set(catalog.filter((model) => model.available).map((model) => model.id));
        const allowedModelRefs = nextSelection.allowedModelRefs.filter((modelRef) => availableRefs.has(modelRef));
        setModels(catalog);
        setSelection({
          ...nextSelection,
          allowedModelRefs,
          defaultModelRef: nextSelection.defaultModelRef && allowedModelRefs.includes(nextSelection.defaultModelRef) ? nextSelection.defaultModelRef : (allowedModelRefs[0] ?? null),
        });
        setStatus('ready');
      })
      .catch((error: unknown) => {
        if (!active) return;
        setMessage(formatVisibleApplicationError(error, zh ? 'zh-CN' : 'en'));
        setStatus('ready');
      });
    return () => {
      active = false;
    };
  }, [props.client, props.projectId]);

  const presentation = useMemo(() => presentModelOptions(models, selection.defaultModelRef ?? selection.allowedModelRefs[0] ?? '', props.language), [models, props.language, selection.allowedModelRefs, selection.defaultModelRef]);
  const selectedModels = useMemo(() => presentation.models.filter((model) => selection.allowedModelRefs.includes(model.id)), [presentation.models, selection.allowedModelRefs]);
  const defaultModelRef = selection.defaultModelRef && selection.allowedModelRefs.includes(selection.defaultModelRef) ? selection.defaultModelRef : (selection.allowedModelRefs[0] ?? '');
  const defaultPresentation = useMemo(() => presentModelOptions(selectedModels, defaultModelRef, props.language), [defaultModelRef, props.language, selectedModels]);
    const optionsById = useMemo(() => new Map(presentation.options.map((option) => [option.value, option])), [presentation.options]);
    const normalizedSearchQuery = searchQuery.trim().toLocaleLowerCase(props.language);
    const filteredGroups = useMemo(
        () =>
            normalizedSearchQuery
                ? presentation.groups
                    .map((group) => ({
                        ...group,
                        models: group.models.filter((model) => `${optionsById.get(model.id)?.searchText ?? ''} ${model.id}`.toLocaleLowerCase(props.language).includes(normalizedSearchQuery)),
                    }))
                    .filter((group) => group.models.length > 0)
                : presentation.groups,
        [normalizedSearchQuery, optionsById, presentation.groups, props.language],
    );
    const filteredModelCount = filteredGroups.reduce((count, group) => count + group.models.length, 0);

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
      setMessage(formatVisibleApplicationError(error, zh ? 'zh-CN' : 'en'));
    } finally {
      setStatus('ready');
    }
  }

  return (
    <section className="project-model-settings" aria-label={zh ? '项目可用模型' : 'Project models'}>
        <header className="project-model-settings-heading">
            <h2>{zh ? '项目可用模型' : 'Project models'}</h2>
            <p>{zh ? '可同时选择多个 Pi 模型；默认模型只负责预选，推送任务和会话仍可逐次切换。' : 'Select multiple Pi models. The default only controls preselection; tasks and conversations can still switch per turn.'}</p>
        </header>
        <div className="project-model-settings-toolbar">
            <label className="project-model-search-field">
                <span className="sr-only">{zh ? '搜索供应商或模型' : 'Search providers or models'}</span>
                <input
                    type="search"
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.currentTarget.value)}
                    placeholder={zh ? '搜索供应商或模型' : 'Search providers or models'}
                    disabled={status === 'loading' || presentation.models.length === 0}
                />
            </label>
            <small aria-live="polite">
                {zh
                    ? `${normalizedSearchQuery ? `显示 ${filteredModelCount}` : `共 ${presentation.models.length}`} 个 · 已选 ${selection.allowedModelRefs.length} 个`
                    : `${normalizedSearchQuery ? `${filteredModelCount} shown` : `${presentation.models.length} total`} · ${selection.allowedModelRefs.length} selected`}
            </small>
        </div>
      <div className="project-model-settings-body">
        {status === 'loading' ? <small>{zh ? '正在读取模型…' : 'Loading models…'}</small> : null}
        {status !== 'loading' && presentation.models.length === 0 ? (
          <small>{zh ? '没有可运行模型，请到系统设置的“模型供应商”检查供应商、密钥和模型状态。' : 'No runnable models. Check the provider, key, and model status under Model providers in system settings.'}</small>
        ) : null}
          {status !== 'loading' && presentation.models.length > 0 && filteredGroups.length === 0 ? <small
              className="project-model-search-empty">{zh ? '没有匹配的供应商或模型。' : 'No matching provider or model.'}</small> : null}
        <fieldset className="project-model-choice-list" aria-label={zh ? '可运行模型' : 'Runnable models'} disabled={status !== 'ready'}>
            {filteredGroups.map((group) => (
            <section key={group.providerName} className="project-model-provider-group" aria-label={group.providerName}>
              {presentation.showProviderGroups ? <strong className="project-model-provider-heading">{group.providerName}</strong> : null}
              {group.models.map((model) => (
                <label key={model.id}>
                  <input type="checkbox" checked={selection.allowedModelRefs.includes(model.id)} onChange={(event) => toggleModel(model.id, event.currentTarget.checked)} />
                  <span>
                    <strong>{optionsById.get(model.id)?.label ?? model.displayName}</strong>
                  </span>
                </label>
              ))}
            </section>
          ))}
        </fieldset>
      </div>
        <footer className="project-model-settings-footer">
        <span className="project-model-settings-footer-main">
          {selectedModels.length > 0 ? (
              <label className="project-model-default-field">
                  <span>{zh ? '默认预选模型' : 'Default preselected model'}</span>
                  <ZeusSelect
                      ariaLabel={zh ? '默认预选模型' : 'Default preselected model'}
                      size="roomy"
                      value={defaultModelRef}
                      onChange={(value) => setSelection((current) => ({...current, defaultModelRef: value}))}
                      options={defaultPresentation.options}
                      triggerLabel={defaultPresentation.triggerLabel}
                      searchPlaceholder={zh ? '搜索供应商或模型' : 'Search providers or models'}
                      emptyLabel={zh ? '没有匹配模型' : 'No matching models'}
                  />
              </label>
          ) : (
              <small>{zh ? '当前未选择可用模型。' : 'No project model is selected.'}</small>
          )}
            {message ? <small role="status">{message}</small> : null}
        </span>
            <Button variant="primary" size="compact" onClick={() => void save()}
                    disabled={!props.client || status !== 'ready'} busy={status === 'saving'}>
                {zh ? '保存可用模型' : 'Save project models'}
            </Button>
        </footer>
    </section>
  );
}
