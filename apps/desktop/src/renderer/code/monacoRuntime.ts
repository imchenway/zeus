import * as monaco from 'monaco-editor';
import { initialize, getService } from '@codingame/monaco-vscode-api';
import getEditorServiceOverride from '@codingame/monaco-vscode-editor-service-override';
import getModelServiceOverride from '@codingame/monaco-vscode-model-service-override';
import getLanguagesServiceOverride from '@codingame/monaco-vscode-languages-service-override';
import getTextMateServiceOverride from '@codingame/monaco-vscode-textmate-service-override';
import getThemeServiceOverride from '@codingame/monaco-vscode-theme-service-override';
import { registerExtension, ExtensionHostKind } from '@codingame/monaco-vscode-api/extensions';
import { IExtensionService } from '@codingame/monaco-vscode-api/vscode/vs/workbench/services/extensions/common/extensions.service';
import { IWorkbenchThemeService } from '@codingame/monaco-vscode-api/vscode/vs/workbench/services/themes/common/workbenchThemeService.service';
import { ConfigurationTarget } from '@codingame/monaco-vscode-api/vscode/vs/platform/configuration/common/configuration';
import { ITextModelService } from '@codingame/monaco-vscode-api/vscode/vs/editor/common/services/resolverService.service';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker&inline';
import TextMateWorker from '@codingame/monaco-vscode-textmate-service-override/worker?worker&inline';
import '@codingame/monaco-vscode-javascript-default-extension';
import '@codingame/monaco-vscode-typescript-basics-default-extension';
import '@codingame/monaco-vscode-json-default-extension';
import '@codingame/monaco-vscode-css-default-extension';
import '@codingame/monaco-vscode-html-default-extension';
import '@codingame/monaco-vscode-python-default-extension';
import { sourceModels, sourceModelKey, sourceWorkspaces, trackSourceModel } from './sourceEditorState.js';
import './monacoEditor.css';

const themeExtension = registerExtension(
  {
    name: 'zeus-editor-themes',
    publisher: 'zeus',
    version: '1.0.0',
    engines: { vscode: '*' },
    contributes: {
      themes: [
        { id: 'zeus-dark', label: 'Zeus Dark', uiTheme: 'vs-dark', path: './themes/dark.json' },
        { id: 'zeus-light', label: 'Zeus Light', uiTheme: 'vs', path: './themes/light.json' },
      ],
    },
  },
  ExtensionHostKind.LocalProcess,
);
themeExtension.registerFileUrl('themes/dark.json', new URL('./themes/dark.json', import.meta.url).href);
themeExtension.registerFileUrl('themes/light.json', new URL('./themes/light.json', import.meta.url).href);
export { monaco };
let ready: Promise<void> | undefined;

/** Worker 内联为 Blob，开发服务器与打包后的 file:// 使用同一初始化路径。 */
export function initializeSourceEditor(): Promise<void> {
  return (ready ??= (async () => {
    window.MonacoEnvironment = {
      getWorker: (_moduleId: string, label: string) => (label === 'TextMateWorker' ? new TextMateWorker() : new EditorWorker()),
    };
    await initialize({
      ...getEditorServiceOverride(async (reference, options) => {
        const identity = sourceIdentity(reference.object.textEditorModel.uri);
        if (!identity) return undefined;
        const selection = (options as { selection?: { startLineNumber: number; startColumn: number; endLineNumber?: number; endColumn?: number } } | undefined)?.selection;
        await sourceWorkspaces.get(identity.projectId)?.open(
          identity.path,
          selection
            ? {
                startLineNumber: selection.startLineNumber,
                startColumn: selection.startColumn,
                endLineNumber: selection.endLineNumber ?? selection.startLineNumber,
                endColumn: selection.endColumn ?? selection.startColumn,
              }
            : undefined,
        );
        return monaco.editor.getEditors().find((view) => view.getModel()?.uri.toString() === reference.object.textEditorModel.uri.toString());
      }),
      ...getModelServiceOverride(),
      ...getLanguagesServiceOverride(),
      ...getThemeServiceOverride(),
      ...getTextMateServiceOverride(),
    });
    const resolver = await getService(ITextModelService);
    resolver.registerTextModelContentProvider('zeus-source', {
      provideTextContent: async (uri: monaco.Uri) => {
        const identity = sourceIdentity(uri);
        return identity ? loadSourceModel(identity.projectId, identity.path) : null;
      },
    });
    await themeExtension.whenReady();
    await (await getService(IExtensionService)).whenInstalledExtensionsRegistered();
    const themeService = await getService(IWorkbenchThemeService);
    const themes = await themeService.getColorThemes();
    const applyTheme = async () => {
      const setting = document.documentElement.dataset.zeusTheme;
      const dark = setting === 'dark' || (setting !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
      const theme = themes.find((candidate) => candidate.settingsId === (dark ? 'zeus-dark' : 'zeus-light'));
      if (!theme) throw new Error('Zeus 编辑器主题尚未注册。');
      await themeService.setColorTheme(theme, ConfigurationTarget.MEMORY);
    };
    await applyTheme();
    const refreshTheme = () => {
      void applyTheme().catch((error: unknown) => {
        for (const workspace of sourceWorkspaces.values()) workspace.reportStatus('编辑器主题加载失败：' + (error instanceof Error ? error.message : String(error)));
      });
    };
    new MutationObserver(refreshTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-zeus-theme'] });
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', refreshTheme);
    const { installSourceLanguageProviders } = await import('./sourceLanguageProviders.js');
    installSourceLanguageProviders();
  })());
}

export function sourceUri(projectId: string, path: string): monaco.Uri {
  return monaco.Uri.from({ scheme: 'zeus-source', path: '/zeus/' + encodeURIComponent(projectId) + '/' + path });
}

export function sourceIdentity(uri: monaco.Uri): { projectId: string; path: string } | null {
  const match = /^\/zeus\/([^/]+)\/(.+)$/.exec(uri.path);
  return uri.scheme === 'zeus-source' && match ? { projectId: decodeURIComponent(match[1]!), path: match[2]! } : null;
}

export function editorLanguage(path: string, language?: string | null): string {
  if (/\.vue$/.test(path)) return 'vue';
  if (language === 'shell') return 'shellscript';
  if (language === 'tsx') return 'typescriptreact';
  if (language === 'jsx') return 'javascriptreact';
  if (/\.tsx$/.test(path)) return 'typescriptreact';
  if (/\.jsx$/.test(path)) return 'javascriptreact';
  if (/\.[cm]?tsx?$/.test(path)) return 'typescript';
  if (/\.[cm]?jsx?$/.test(path)) return 'javascript';
  return language === 'plain' || language === 'text' || !language ? 'plaintext' : language;
}

/** Peek 的临时引用由 VS Code 释放，源码标签另持有引用以保存撤销栈。 */
async function loadSourceModel(projectId: string, path: string, initial?: { content: string; language: string | null }): Promise<monaco.editor.ITextModel> {
  const key = sourceModelKey(projectId, path);
  const existing = sourceModels.get(key);
  if (existing) return existing.model;
  const document = initial ?? (await window.zeus!.readProjectSourceFile({ projectId, relativePath: path }));
  if ('editable' in document && !document.editable) throw new Error('目标文件不能作为代码打开。');
  const raced = sourceModels.get(key);
  if (raced) return raced.model;
  await (await import('./monacoGrammars.js')).loadEditorGrammar(editorLanguage(path, document.language));
  const loaded = sourceModels.get(key);
  if (loaded) return loaded.model;
  const model = monaco.editor.getModel(sourceUri(projectId, path)) ?? monaco.editor.createModel(document.content, editorLanguage(path, document.language), sourceUri(projectId, path));
  trackSourceModel({ projectId, path, model });
  return model;
}

export async function ensureSourceModel(projectId: string, path: string, initial?: { content: string; language: string | null }): Promise<monaco.editor.ITextModel> {
  const model = await loadSourceModel(projectId, path, initial);
  const entry = sourceModels.get(sourceModelKey(projectId, path));
  if (!entry || entry.model !== model || model.isDisposed()) throw new Error('文件已关闭，请重新打开。');
  entry.retained = true;
  entry.retaining ??= (async () => {
    const resolver = await getService(ITextModelService);
    const reference = await resolver.createModelReference(model.uri);
    if (model.isDisposed()) reference.dispose();
    else entry.reference = reference;
  })();
  await entry.retaining;
  if (model.isDisposed()) throw new Error('文件已关闭，请重新打开。');
  return model;
}

/** Monaco 默认隐藏装饰层；其中的评论输入和冲突按钮需要进入无障碍树。 */
export function exposeEditorControl(view: monaco.editor.IStandaloneCodeEditor, node: HTMLElement): void {
  // 装饰层的鼠标事件不能被编辑器接管，否则按钮会在 click 前丢失焦点。
  node.addEventListener('mousedown', (event) => event.stopPropagation());
  node.addEventListener('pointerdown', (event) => event.stopPropagation());
  const root = view.getDomNode();
  for (let parent = node.parentElement; parent && root?.contains(parent); parent = parent.parentElement) {
    if (parent.getAttribute('aria-hidden') === 'true') parent.removeAttribute('aria-hidden');
    if (parent === root) break;
  }
}

/** 临时审阅模型也持有引用，避免 VS Code 的撤销服务释放临时引用时销毁文档。 */
export async function createTransientSourceModel(content: string, language: string): Promise<{ model: monaco.editor.ITextModel; dispose(): void }> {
  const model = monaco.editor.createModel(content, language);
  try {
    const reference = await (await getService(ITextModelService)).createModelReference(model.uri);
    return {
      model,
      dispose() {
        reference.dispose();
        model.dispose();
      },
    };
  } catch (error) {
    model.dispose();
    throw error;
  }
}
