import { parentPort, workerData } from 'node:worker_threads';
import { dirname, relative, resolve, sep, isAbsolute } from 'node:path';
import ts from 'typescript';
import type { SourceBuffer, SourceLanguageRequest, SourceLanguageResult, SourceRange } from '@zeus/shared';

const root = (workerData as { root: string }).root;
let buffers = new Map<string, SourceBuffer>();
let projectVersion = 0;
const rangeSources = new Map<string, ts.SourceFile>();
const projects = new Map<string, { service: ts.LanguageService; config: ts.ParsedCommandLine; stamp: string }>();

function inside(path: string): boolean {
  const name = relative(root, path);
  return !isAbsolute(name) && name !== '..' && !name.startsWith('..' + sep) && !name.split(sep).includes('.git');
}

function read(path: string): string | undefined {
  return buffers.get(path)?.content ?? ts.sys.readFile(path);
}

/** 最近的配置决定路径别名、JSX 和类型规则，不执行工作区插件或自定义编译器。 */
function configFor(path: string): string | null {
  let directory = dirname(path);
  while (inside(directory)) {
    for (const name of ['tsconfig.json', 'jsconfig.json']) {
      const candidate = resolve(directory, name);
      if (ts.sys.fileExists(candidate)) return candidate;
    }
    if (directory === root) break;
    directory = dirname(directory);
  }
  return null;
}

function project(path: string) {
  const configPath = configFor(path);
  const key = configPath ?? root;
  // 配置及 extends 文件在每批请求读取，TypeScript 负责解析；版本变化重建服务。
  const defaults: ts.CompilerOptions = {
    allowJs: true,
    checkJs: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    resolveJsonModule: true,
    allowSyntheticDefaultImports: true,
    noEmit: true,
  };
  const config = configPath
    ? ts.getParsedCommandLineOfConfigFile(configPath, { noEmit: true }, { ...ts.sys, onUnRecoverableConfigFileDiagnostic() {} })!
    : {
        options: defaults,
        fileNames: ts.sys.readDirectory(root, ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'], ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/.tmp/**'], undefined, 12).slice(0, 10_000),
        errors: [],
      };
  if (!config) throw new Error('无法解析项目 TypeScript 配置。');
  const stamp = JSON.stringify({ options: config.options, files: config.fileNames });
  let entry = projects.get(key);
  if (!entry || entry.stamp !== stamp) {
    entry?.service.dispose();
    const host: ts.LanguageServiceHost = {
      getCompilationSettings: () => config.options,
      getScriptFileNames: () => [...new Set([...config.fileNames, ...buffers.keys()].filter((file) => /\.[cm]?[jt]sx?$/.test(file)))],
      getScriptVersion: (file) => (buffers.has(file) ? 'draft:' + buffers.get(file)!.version : String(ts.sys.getModifiedTime?.(file)?.getTime() ?? 0)),
      getScriptSnapshot: (file) => {
        const text = read(file);
        return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
      },
      getCurrentDirectory: () => (configPath ? dirname(configPath) : root),
      getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
      getProjectVersion: () => String(projectVersion),
      fileExists: (file) => buffers.has(file) || ts.sys.fileExists(file),
      readFile: read,
      readDirectory: ts.sys.readDirectory,
      directoryExists: ts.sys.directoryExists,
      getDirectories: ts.sys.getDirectories,
      realpath: ts.sys.realpath,
      useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    };
    entry = { service: ts.createLanguageService(host), config, stamp };
    projects.set(key, entry);
    if (projects.size > 4) {
      const oldest = projects.keys().next().value!;
      if (oldest !== key) {
        projects.get(oldest)?.service.dispose();
        projects.delete(oldest);
      }
    }
  }
  return { ...entry, configPath: configPath ? relative(root, configPath) : null };
}

function range(file: string, span: ts.TextSpan): SourceRange {
  const text = read(file) ?? '';
  let source = rangeSources.get(file);
  if (!source) {
    source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest);
    rangeSources.set(file, source);
  }
  const start = source.getLineAndCharacterOfPosition(Math.min(span.start, text.length));
  const end = source.getLineAndCharacterOfPosition(Math.min(span.start + span.length, text.length));
  return { startLineNumber: start.line + 1, startColumn: start.character + 1, endLineNumber: end.line + 1, endColumn: end.character + 1 };
}

function location(item: { fileName: string; textSpan: ts.TextSpan }) {
  return { relativePath: relative(root, item.fileName).split(sep).join('/'), range: range(item.fileName, item.textSpan) };
}

function analyze(input: SourceLanguageRequest): SourceLanguageResult {
  buffers = new Map(input.buffers.map((buffer) => [resolve(root, buffer.relativePath), buffer]));
  projectVersion++;
  rangeSources.clear();
  const path = resolve(root, input.relativePath);
  const content = read(path) ?? '';
  const offset = Math.min(input.offset, content.length);
  const { service, configPath, config } = project(path);
  const result: SourceLanguageResult = { configPath };
  switch (input.operation) {
    case 'completion':
      result.completions =
        service
          .getCompletionsAtPosition(path, offset, { includeCompletionsForModuleExports: false, includeCompletionsWithInsertText: true })
          ?.entries.slice(0, 500)
          .map((item) => ({ label: item.name, kind: item.kind, sortText: item.sortText, insertText: item.insertText ?? item.name })) ?? [];
      break;
    case 'hover': {
      const info = service.getQuickInfoAtPosition(path, offset);
      if (info) result.hover = { range: range(path, info.textSpan), text: ts.displayPartsToString(info.displayParts), documentation: ts.displayPartsToString(info.documentation) };
      break;
    }
    case 'definition':
      result.locations = (service.getDefinitionAtPosition(path, offset) ?? []).filter((item) => inside(item.fileName)).map(location);
      break;
    case 'references':
      result.locations = (service.getReferencesAtPosition(path, offset) ?? []).filter((item) => inside(item.fileName)).map(location);
      break;
    case 'rename': {
      const info = service.getRenameInfo(path, offset, { allowRenameOfImportPath: false });
      if (!info.canRename) {
        result.renameError = info.localizedErrorMessage;
        break;
      }
      if (!input.newName) {
        result.locations = [{ relativePath: input.relativePath, range: range(path, info.triggerSpan) }];
        break;
      }
      const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, input.newName);
      if (scanner.scan() !== ts.SyntaxKind.Identifier || scanner.scan() !== ts.SyntaxKind.EndOfFileToken) {
        result.renameError = '请输入有效的符号名称。';
        break;
      }
      const locations = service.findRenameLocations(path, offset, false, false, { providePrefixAndSuffixTextForRename: true }) ?? [];
      if (locations.some((item) => !inside(item.fileName))) {
        result.renameError = '此次重命名涉及项目外部文件，请在完整工作区中操作。';
        break;
      }
      const files = [...new Set(locations.map((item) => item.fileName))];
      if (files.length > 20 || locations.length > 10_000) {
        result.renameError = '此次重命名范围超过编辑器的 20 文件上限，请缩小范围。';
        break;
      }
      result.editContents = Object.fromEntries(files.map((file) => [relative(root, file).split(sep).join('/'), read(file) ?? '']));
      if (Object.values(result.editContents).reduce((sum, text) => sum + text.length, 0) > 8 * 1024 * 1024) {
        result.renameError = '此次重命名内容过大。';
        delete result.editContents;
        break;
      }
      result.edits = locations.map((item) => ({ ...location(item), text: (item.prefixText ?? '') + input.newName + (item.suffixText ?? '') }));
      break;
    }
    case 'diagnostics':
      result.diagnostics = [...config.errors, ...service.getSyntacticDiagnostics(path), ...service.getSemanticDiagnostics(path), ...service.getSuggestionDiagnostics(path)].slice(0, 300).map((item) => ({
        range: item.file?.fileName === path ? range(path, { start: item.start ?? 0, length: item.length ?? 1 }) : range(path, { start: 0, length: 0 }),
        message: ts.flattenDiagnosticMessageText(item.messageText, '\n'),
        code: item.code,
        severity: item.category === ts.DiagnosticCategory.Error ? 'error' : item.category === ts.DiagnosticCategory.Warning ? 'warning' : 'info',
      }));
      break;
    case 'format':
      result.edits = service
        .getFormattingEditsForDocument(path, {
          tabSize: input.tabSize ?? 2,
          indentSize: input.tabSize ?? 2,
          convertTabsToSpaces: input.insertSpaces ?? true,
          newLineCharacter: content.includes('\r\n') ? '\r\n' : '\n',
          insertSpaceAfterCommaDelimiter: true,
          insertSpaceAfterSemicolonInForStatements: true,
          insertSpaceBeforeAndAfterBinaryOperators: true,
        })
        .map((item) => ({ relativePath: input.relativePath, range: range(path, item.span), text: item.newText }));
      break;
  }
  return result;
}

parentPort!.on('message', ({ id, input }: { id: number; input: SourceLanguageRequest }) => {
  try {
    parentPort!.postMessage({ id, result: analyze(input) });
  } catch (error) {
    parentPort!.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
});
