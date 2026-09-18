import type { SourceLanguageRequest, SourceLanguageResult } from '@zeus/shared';
import { monaco, sourceIdentity, sourceUri } from './monacoRuntime.js';
import { sourceBuffers, sourceWorkspaces, sourceModels, sourceModelKey } from './sourceEditorState.js';

const selector = ['typescript', 'typescriptreact', 'javascript', 'javascriptreact'];
export function hasProjectLanguage(model: monaco.editor.ITextModel): boolean {
  return Boolean(sourceIdentity(model.uri)) && selector.includes(model.getLanguageId());
}

/** 结果与请求时的模型版本绑定，迟到的分析不能覆盖用户后续输入。 */
async function request(model: monaco.editor.ITextModel, operation: SourceLanguageRequest['operation'], offset: number, token?: monaco.CancellationToken, extra?: Partial<SourceLanguageRequest>): Promise<SourceLanguageResult | null> {
  const identity = sourceIdentity(model.uri);
  if (!identity || !window.zeus || token?.isCancellationRequested || model.isDisposed()) return null;
  const version = model.getVersionId();
  try {
    const result = await window.zeus.requestProjectSourceLanguage({ projectId: identity.projectId, relativePath: identity.path, operation, offset, buffers: sourceBuffers(identity.projectId), ...extra });
    return token?.isCancellationRequested || model.isDisposed() || model.getVersionId() !== version ? null : result;
  } catch (error) {
    sourceWorkspaces.get(identity.projectId)?.reportStatus(error instanceof Error ? error.message : String(error));
    return null;
  }
}

export async function updateSourceDiagnostics(model: monaco.editor.ITextModel): Promise<string | null> {
  if (!hasProjectLanguage(model)) return null;
  const result = await request(model, 'diagnostics', 0);
  if (!result || model.isDisposed()) return null;
  monaco.editor.setModelMarkers(
    model,
    'zeus-typescript',
    (result.diagnostics ?? []).map((item) => ({
      ...item.range,
      message: item.message,
      code: String(item.code),
      source: 'TypeScript',
      severity: item.severity === 'error' ? monaco.MarkerSeverity.Error : item.severity === 'warning' ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Info,
    })),
  );
  const errors = result.diagnostics?.filter((item) => item.severity === 'error').length ?? 0;
  return (result.configPath ?? '默认项目配置') + ' · ' + errors + ' 个错误';
}

export function installSourceLanguageProviders(): void {
  monaco.languages.registerCompletionItemProvider(selector, {
    triggerCharacters: ['.', '"', "'", '/', '@'],
    async provideCompletionItems(model, position, _context, token) {
      const result = await request(model, 'completion', model.getOffsetAt(position), token);
      if (!result) return null;
      const word = model.getWordUntilPosition(position);
      const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
      return {
        suggestions: (result.completions ?? []).map((item) => ({
          label: item.label,
          insertText: item.insertText,
          sortText: item.sortText,
          range,
          kind: completionKind(item.kind),
        })),
      };
    },
  });
  monaco.languages.registerHoverProvider(selector, {
    async provideHover(model, position, token) {
      const info = (await request(model, 'hover', model.getOffsetAt(position), token))?.hover;
      const fence = String.fromCharCode(96).repeat(3);
      return info ? { range: info.range, contents: [{ value: fence + 'typescript\n' + info.text + '\n' + fence }, { value: info.documentation, isTrusted: false }] } : null;
    },
  });
  monaco.languages.registerDefinitionProvider(selector, {
    async provideDefinition(model, position, token) {
      const result = await request(model, 'definition', model.getOffsetAt(position), token);
      const identity = sourceIdentity(model.uri);
      return identity ? (result?.locations ?? []).map((item) => ({ uri: sourceUri(identity.projectId, item.relativePath), range: item.range })) : [];
    },
  });
  monaco.languages.registerReferenceProvider(selector, {
    async provideReferences(model, position, _context, token) {
      const result = await request(model, 'references', model.getOffsetAt(position), token);
      const identity = sourceIdentity(model.uri);
      return identity ? (result?.locations ?? []).map((item) => ({ uri: sourceUri(identity.projectId, item.relativePath), range: item.range })) : [];
    },
  });
  monaco.languages.registerRenameProvider(selector, {
    async resolveRenameLocation(model, position, token) {
      const result = await request(model, 'rename', model.getOffsetAt(position), token);
      if (!result || result.renameError) return { range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column), text: '', rejectReason: result?.renameError ?? '语言服务暂不可用。' };
      const range = result.locations?.[0]?.range;
      return range ? { range, text: model.getValueInRange(range) } : null;
    },
    async provideRenameEdits(model, position, newName, token) {
      const identity = sourceIdentity(model.uri);
      if (!identity) return null;
      const before = sourceBuffers(identity.projectId);
      const result = await request(model, 'rename', model.getOffsetAt(position), token, { newName });
      if (!result || result.renameError) return { edits: [], rejectReason: result?.renameError ?? '语言服务暂不可用。' };
      const after = sourceBuffers(identity.projectId);
      if (before.some((buffer) => !after.some((current) => current.relativePath === buffer.relativePath && current.version === buffer.version))) return { edits: [], rejectReason: '分析期间文件发生了变化，请重试。' };
      const workspace = sourceWorkspaces.get(identity.projectId);
      if (!workspace || token.isCancellationRequested) return null;
      try {
        await workspace.prepareEdits(result.edits ?? [], result.editContents ?? {});
        if (token.isCancellationRequested) return null;
        return {
          edits: (result.edits ?? []).map((item) => ({
            resource: sourceUri(identity.projectId, item.relativePath),
            versionId: sourceModels.get(sourceModelKey(identity.projectId, item.relativePath))?.model.getVersionId(),
            textEdit: { range: item.range, text: item.text },
          })),
        };
      } catch (error) {
        return { edits: [], rejectReason: error instanceof Error ? error.message : String(error) };
      }
    },
  });
  monaco.languages.registerDocumentFormattingEditProvider(selector, {
    displayName: 'Zeus TypeScript',
    async provideDocumentFormattingEdits(model, options, token) {
      const result = await request(model, 'format', 0, token, options);
      return result?.edits?.map((item) => ({ range: item.range, text: item.text })) ?? [];
    },
  });
}

function completionKind(kind: string): monaco.languages.CompletionItemKind {
  const types = monaco.languages.CompletionItemKind;
  if (['function', 'method', 'local function'].includes(kind)) return types.Function;
  if (['class', 'interface', 'type', 'enum'].includes(kind)) return types.Class;
  if (kind === 'keyword') return types.Keyword;
  if (kind === 'property' || kind === 'getter' || kind === 'setter') return types.Property;
  if (kind === 'module') return types.Module;
  return types.Variable;
}
