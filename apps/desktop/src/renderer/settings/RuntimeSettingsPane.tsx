import { useEffect, useState } from 'react';
import type { AiRuntimeAdapterDescriptor, RuntimeSettings } from '../features/runtime/runtimeContracts.js';
import { formatRuntimeDefaultArgs, formatRuntimeTerminalEnv, parseRuntimeDefaultArgsText, parseRuntimeTerminalEnvText } from '../features/workspace/WorkspaceChrome.js';
import { ZeusSelect } from '../ZeusSelect.js';
import { SettingsSaveStatus, useSettingsAutosave, type SettingsSaveState } from './useSettingsAutosave.js';

/** 命令行参数保留实际生效的设置；会话的模型与权限仍在会话中选择。 */
export function RuntimeSettingsPane(props: {
  value: RuntimeSettings;
  language: 'zh-CN' | 'en-US';
  adapters: AiRuntimeAdapterDescriptor[];
  onChange: (value: RuntimeSettings) => void;
  onSave?: (value: RuntimeSettings) => Promise<RuntimeSettings>;
  /** 完整设置页将回执显示在页面右上角。 */
  onSaveStateChange?: (status: SettingsSaveState) => void;
}) {
  /** 文案与保存反馈跟随应用语言。 */
  const zh = props.language === 'zh-CN';
  /** 仅结束输入时解析，避免逐字解析吞掉空格和未完成的环境变量。 */
  const value = props.value;
  /** 当前编辑工具。 */
  const adapter = value.defaultAdapterId;
  /** 超时显示单位只影响编辑表示。 */
  const [unit, setUnit] = useState(value.executionTimeoutSeconds % 3600 === 0 ? 3600 : 1);
  /** 保存结果来自真实回执。 */
  const autosave = useSettingsAutosave(props.language);
  useEffect(() => props.onSaveStateChange?.(autosave.status), [autosave.status, props.onSaveStateChange]);
  /** 设置变更直接写入，失败保留当前值供重试。 */
  function save(next: RuntimeSettings): void {
    props.onChange(next);
    if (props.onSave)
      void autosave.save(async () => {
        /** 保存期间锁定编辑器，成功后展示服务端规范化的真实值。 */
        props.onChange(await props.onSave!(next));
      });
  }
  return (
    <section className="settings-product-section runtime-settings-section">
      <header className="settings-page-heading">
        <span>
          <h3>{zh ? '命令行运行' : 'Command-line runs'}</h3>
          <p>{zh ? '配置本机工具的路径、启动参数与运行环境。' : 'Configure local tool paths, launch arguments and environment.'}</p>
        </span>
        {!props.onSaveStateChange ? <SettingsSaveStatus status={autosave.status} language={props.language} /> : null}
      </header>
      <fieldset className="settings-form-grid" onInput={() => autosave.reset()} disabled={autosave.status === 'saving' || !props.onSave}>
        <label>
          <span>{zh ? '默认工具' : 'Default tool'}</span>
          <ZeusSelect
            size="regular"
            ariaLabel={zh ? '默认工具' : 'Default tool'}
            value={adapter}
            onChange={(defaultAdapterId) => save({ ...value, defaultAdapterId })}
            options={props.adapters.length ? props.adapters.map((item) => ({ value: item.id, label: item.displayName })) : [{ value: 'codex', label: 'Codex CLI' }]}
          />
        </label>
        <label key={`${adapter}-model`}>
          <span>{zh ? '默认模型' : 'Default model'}</span>
          <input
            defaultValue={value.adapterModels[adapter] ?? ''}
            onBlur={(event) => {
              if (event.currentTarget.value !== (value.adapterModels[adapter] ?? '')) save({ ...value, adapterModels: { ...value.adapterModels, [adapter]: event.currentTarget.value } });
            }}
          />
        </label>
        <label key={`${adapter}-path`}>
          <span>{zh ? '工具路径' : 'Tool path'}</span>
          <input
            placeholder={zh ? '留空自动查找' : 'Automatically locate'}
            defaultValue={value.adapterCliPaths[adapter] ?? ''}
            onBlur={(event) => {
              if (event.currentTarget.value !== (value.adapterCliPaths[adapter] ?? '')) save({ ...value, adapterCliPaths: { ...value.adapterCliPaths, [adapter]: event.currentTarget.value } });
            }}
          />
        </label>
        <label key={`${adapter}-args`}>
          <span>{zh ? '启动参数' : 'Launch arguments'}</span>
          <input
            defaultValue={formatRuntimeDefaultArgs(value.adapterDefaultArgs[adapter] ?? [])}
            onBlur={(event) => {
              if (event.currentTarget.value !== formatRuntimeDefaultArgs(value.adapterDefaultArgs[adapter] ?? []))
                save({ ...value, adapterDefaultArgs: { ...value.adapterDefaultArgs, [adapter]: parseRuntimeDefaultArgsText(event.currentTarget.value) } });
            }}
          />
        </label>
        <label>
          <span>{zh ? '最长运行时间' : 'Run time limit'}</span>
          <span className="settings-duration-field">
            <input
              type="number"
              min={1 / unit}
              step={1 / unit}
              max={315360000 / unit}
              key={`${unit}-${value.executionTimeoutSeconds}`}
              defaultValue={value.executionTimeoutSeconds / unit}
              onBlur={(event) => {
                if (event.currentTarget.validity.valid && event.currentTarget.valueAsNumber * unit !== value.executionTimeoutSeconds) save({ ...value, executionTimeoutSeconds: event.currentTarget.valueAsNumber * unit });
              }}
            />
            <ZeusSelect
              size="regular"
              ariaLabel={zh ? '时间单位' : 'Time unit'}
              value={String(unit)}
              onChange={(next) => setUnit(Number(next))}
              options={[
                { value: '1', label: zh ? '秒' : 'Seconds' },
                { value: '60', label: zh ? '分钟' : 'Minutes' },
                { value: '3600', label: zh ? '小时' : 'Hours' },
                { value: '86400', label: zh ? '天' : 'Days' },
              ]}
            />
          </span>
        </label>
        <label>
          <span>{zh ? 'Shell 路径' : 'Shell path'}</span>
          <input
            defaultValue={value.shell.path ?? ''}
            onBlur={(event) => {
              if (event.currentTarget.value !== (value.shell.path ?? '')) save({ ...value, shell: { ...value.shell, path: event.currentTarget.value || null } });
            }}
          />
        </label>
        <label className="settings-form-wide">
          <span>{zh ? '环境变量' : 'Environment variables'}</span>
          <textarea
            rows={3}
            placeholder="NAME=value"
            defaultValue={formatRuntimeTerminalEnv(value.terminalEnv)}
            onBlur={(event) => {
              if (event.currentTarget.value !== formatRuntimeTerminalEnv(value.terminalEnv)) save({ ...value, terminalEnv: parseRuntimeTerminalEnvText(event.currentTarget.value) });
            }}
          />
        </label>
      </fieldset>
      {autosave.status === 'failed' ? (
        <button type="button" onClick={() => save(value)}>
          {zh ? '重试保存' : 'Retry save'}
        </button>
      ) : null}
    </section>
  );
}
