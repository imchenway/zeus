import { useId } from 'react';
import { FolderOpenIcon as FolderOpen } from '@phosphor-icons/react/dist/csr/FolderOpen';
import { Button } from '../toolPageHost.js';

/** 插件和技能共用的安装来源草稿。 */
export type ExtensionSourceDraft = { kind: 'local' | 'git'; path: string; repositoryUrl: string; ref: string; subdirectory: string };

/** 每次重置创建独立草稿，避免跨弹窗保留已提交路径。 */
export function emptyExtensionSource(): ExtensionSourceDraft {
  return { kind: 'local', path: '', repositoryUrl: '', ref: '', subdirectory: '' };
}

/** 安装来源共用字段；仓库地址占整行，可选定位信息并列。 */
export function ExtensionSourceFields(props: { source: ExtensionSourceDraft; zh: boolean; busy: boolean; localLabel: string; onSource(value: ExtensionSourceDraft): void; onChoosePath?: () => Promise<void> }) {
  /** 目录标签只关联输入框，选择按钮独立参与键盘导航。 */
  const pathId = useId();
  return (
    <>
      <div className="extension-source-tabs" role="group" aria-label={props.zh ? '安装来源' : 'Install source'}>
        <button type="button" aria-pressed={props.source.kind === 'local'} disabled={props.busy} onClick={() => props.onSource({ ...props.source, kind: 'local' })}>
          {props.zh ? '本地目录' : 'Local directory'}
        </button>
        <button type="button" aria-pressed={props.source.kind === 'git'} disabled={props.busy} onClick={() => props.onSource({ ...props.source, kind: 'git' })}>
          {props.zh ? 'Git 仓库' : 'Git repository'}
        </button>
      </div>
      {props.source.kind === 'local' ? (
        <div className="extension-form-field">
          <label htmlFor={pathId}>{props.localLabel}</label>
          <div className="extension-path-control">
            <input id={pathId} value={props.source.path} onChange={(event) => props.onSource({ ...props.source, path: event.currentTarget.value })} placeholder="/absolute/path/to/folder" required />
            {props.onChoosePath ? (
              <Button onClick={() => void props.onChoosePath?.()} disabled={props.busy}>
                <FolderOpen aria-hidden="true" />
                {props.zh ? '选择' : 'Choose'}
              </Button>
            ) : null}
          </div>
        </div>
      ) : (
        <>
          <label>
            <span>{props.zh ? '仓库地址' : 'Repository URL'}</span>
            <input value={props.source.repositoryUrl} onChange={(event) => props.onSource({ ...props.source, repositoryUrl: event.currentTarget.value })} placeholder="https://github.com/org/repo" required />
          </label>
          <div className="extension-form-grid">
            <label>
              <span>{props.zh ? '分支或标签（可选）' : 'Branch or tag (optional)'}</span>
              <input value={props.source.ref} onChange={(event) => props.onSource({ ...props.source, ref: event.currentTarget.value })} placeholder={props.zh ? '默认分支' : 'Default branch'} />
            </label>
            <label>
              <span>{props.zh ? '子目录（可选）' : 'Subdirectory (optional)'}</span>
              <input value={props.source.subdirectory} onChange={(event) => props.onSource({ ...props.source, subdirectory: event.currentTarget.value })} placeholder="skills/my-skill" />
            </label>
          </div>
        </>
      )}
    </>
  );
}
