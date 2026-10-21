import { useEffect, useId, useState } from 'react';
import type { SettingsApiClient } from '../features/settings/settingsApiClient.js';
import { NativeControlRow, NativeSettingsPane } from '../features/workspace/workspaceSupport.js';
import { Button } from '../ui/Button.js';
import { VisibleApplicationError } from '../ui/ApplicationErrorDialog.js';
import { SettingsSaveStatus, useSettingsAutosave } from './useSettingsAutosave.js';
import type { CommandShell } from '@zeus/shared';
import { ZeusSelect } from '../ZeusSelect.js';

/** 启动命令需显式保存，避免编辑到一半的文本被新终端执行。 */
export function TerminalSettingsPane(props: { client: Pick<SettingsApiClient, 'loadRuntimeSettings' | 'saveRuntimeSettings'> | null; language: 'zh-CN' | 'en-US' }) {
  /** 文案与字段说明跟随应用语言。 */
  const zh = props.language === 'zh-CN';
  const helpId = useId();
  /** 未读取时禁用保存，空字符串是用户主动关闭启动命令。 */
  const [command, setCommand] = useState<string | null>(null);
  /** 脚本解释器与正文一起保存，不因切换系统而自动修改。 */
  const [scriptShell, setScriptShell] = useState<CommandShell>('sh');
  const [error, setError] = useState<unknown>(null);
  /** 读取失败可在原页面重试。 */
  const [revision, setRevision] = useState(0);
  /** 复用设置页的顺序保存与失败反馈。 */
  const saving = useSettingsAutosave();
  useEffect(() => {
    /** 离开页面后不让旧请求覆盖新草稿。 */
    let disposed = false;
    setError(null);
    void props.client
      ?.loadRuntimeSettings()
      .then((settings) => {
        if (!disposed) {
          setCommand(settings.terminalStartupCommand);
          setScriptShell(settings.terminalStartupShell ?? 'sh');
        }
      })
      .catch((failure: unknown) => {
        if (!disposed) setError(failure);
      });
    return () => {
      disposed = true;
    };
  }, [props.client, revision]);

  /** 保存前读取最新运行设置，只替换本页所属字段。 */
  async function save(): Promise<void> {
    if (!props.client || command === null) return;
    const client = props.client;
    const terminalStartupCommand = command;
    await saving.save(async () => {
      const current = await client.loadRuntimeSettings();
      await client.saveRuntimeSettings({ ...current, terminalStartupCommand, terminalStartupShell: scriptShell });
    });
  }

  return (
    <section className="settings-product-pane" aria-label={zh ? '终端' : 'Terminal'}>
      <header className="settings-page-heading">
        <h2 className="settings-page-title">{zh ? '终端' : 'Terminal'}</h2>
        <SettingsSaveStatus status={saving.status} language={props.language} />
      </header>
      <NativeSettingsPane label={zh ? '启动' : 'Startup'}>
        <NativeControlRow title={zh ? '启动命令解释器' : 'Startup command shell'} description={zh ? '必须与实际终端一致；切换不会自动转换已有脚本。' : 'Must match the terminal. Changing this does not convert the script.'}>
          <ZeusSelect<CommandShell>
            ariaLabel={zh ? '启动命令解释器' : 'Startup command shell'}
            size="regular"
            value={scriptShell}
            options={[
              { value: 'sh', label: 'Unix shell' },
              { value: 'zsh', label: 'zsh' },
              { value: 'powershell', label: 'PowerShell' },
              { value: 'cmd', label: 'cmd' },
            ]}
            onChange={(value) => {
              setScriptShell(value);
              saving.reset();
            }}
            disabled={command === null || saving.status === 'saving'}
          />
        </NativeControlRow>
        <NativeControlRow
          className="terminal-startup-row"
          title={zh ? '启动命令' : 'Startup command'}
          description={zh ? '每个新终端在当前项目目录执行一次。留空则不执行，保存后对新终端生效。' : 'Runs once in the current project directory for each new terminal. Leave blank to disable. Changes apply to new terminals after saving.'}
        >
          {/* 终端启动命令使用 Shell 的原始文本。 */}
          <textarea
            data-markdown-lists="off"
            aria-label={zh ? '启动命令' : 'Startup command'}
            aria-describedby={helpId}
            rows={5}
            maxLength={4_000}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            placeholder="pwd"
            value={command ?? ''}
            disabled={!props.client || command === null || saving.status === 'saving'}
            onChange={(event) => {
              setCommand(event.currentTarget.value);
              saving.reset();
            }}
          />
        </NativeControlRow>
      </NativeSettingsPane>
      <p id={helpId}>{zh ? '支持多行命令。切换标签、收起面板或重新连接不会重复执行。' : 'Supports multiple lines. Switching tabs, hiding the panel, or reconnecting does not run it again.'}</p>
      {error ? (
        <div role="status">
          <p>
            <VisibleApplicationError error={error} language={zh ? 'zh-CN' : 'en'} />
          </p>
          <Button onClick={() => setRevision((value) => value + 1)}>{zh ? '重新读取' : 'Retry loading'}</Button>
        </div>
      ) : (
        <Button disabled={!props.client || command === null || saving.status === 'saving'} onClick={() => void save()}>
          {saving.status === 'saving' ? (zh ? '保存中…' : 'Saving…') : zh ? '保存终端设置' : 'Save terminal settings'}
        </Button>
      )}
    </section>
  );
}
