import type { Language, LanguageSupport, StreamParser } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import type { Parser } from '@lezer/common';
import { isSourceLanguageId, type SourceLanguageId } from '@zeus/shared';

export interface LoadedSourceLanguage {
  extension: Extension;
  parser: Parser;
}

const languagePromises = new Map<SourceLanguageId, Promise<LoadedSourceLanguage>>();

/** 编辑器和静态预览共用同一个语言实例，并只在真正打开对应文件时加载解析器。 */
export function loadSourceLanguage(language: string | null | undefined): Promise<LoadedSourceLanguage | null> {
  if (!isSourceLanguageId(language)) return Promise.resolve(null);
  const cached = languagePromises.get(language);
  if (cached) return cached;
  const request = loadKnownSourceLanguage(language);
  languagePromises.set(language, request);
  return request;
}

async function loadKnownSourceLanguage(language: SourceLanguageId): Promise<LoadedSourceLanguage> {
  switch (language) {
    case 'c':
    case 'cpp':
      return fromSupport((await import('@codemirror/lang-cpp')).cpp());
    case 'css':
      return fromSupport((await import('@codemirror/lang-css')).css());
    case 'sass':
      return fromSupport((await import('@codemirror/lang-sass')).sass({ indented: true }));
    case 'scss':
      return fromSupport((await import('@codemirror/lang-sass')).sass());
    case 'go':
      return fromSupport((await import('@codemirror/lang-go')).go());
    case 'html':
      return fromSupport((await import('@codemirror/lang-html')).html());
    case 'java':
      return fromSupport((await import('@codemirror/lang-java')).java());
    case 'javascript':
      return fromSupport((await import('@codemirror/lang-javascript')).javascript());
    case 'jsx':
      return fromSupport((await import('@codemirror/lang-javascript')).javascript({ jsx: true }));
    case 'json':
      return fromSupport((await import('@codemirror/lang-json')).json());
    case 'markdown':
      return fromSupport((await import('@codemirror/lang-markdown')).markdown());
    case 'php':
      return fromSupport((await import('@codemirror/lang-php')).php());
    case 'python':
      return fromSupport((await import('@codemirror/lang-python')).python());
    case 'rust':
      return fromSupport((await import('@codemirror/lang-rust')).rust());
    case 'sql':
      return fromSupport((await import('@codemirror/lang-sql')).sql());
    case 'tsx':
      return fromSupport((await import('@codemirror/lang-javascript')).javascript({ jsx: true, typescript: true }));
    case 'typescript':
      return fromSupport((await import('@codemirror/lang-javascript')).javascript({ typescript: true }));
    case 'xml':
      return fromSupport((await import('@codemirror/lang-xml')).xml());
    case 'yaml':
      return fromSupport((await import('@codemirror/lang-yaml')).yaml());
    case 'kotlin':
      return fromLegacy((await import('@codemirror/legacy-modes/mode/clike')).kotlin);
    case 'ruby':
      return fromLegacy((await import('@codemirror/legacy-modes/mode/ruby')).ruby);
    case 'shell':
      return fromLegacy((await import('@codemirror/legacy-modes/mode/shell')).shell);
    case 'swift':
      return fromLegacy((await import('@codemirror/legacy-modes/mode/swift')).swift);
    case 'dockerfile':
      return fromLegacy((await import('@codemirror/legacy-modes/mode/dockerfile')).dockerFile);
    case 'toml':
      return fromLegacy((await import('@codemirror/legacy-modes/mode/toml')).toml);
    case 'properties':
      return fromLegacy((await import('@codemirror/legacy-modes/mode/properties')).properties);
    case 'cmake':
      return fromLegacy((await import('@codemirror/legacy-modes/mode/cmake')).cmake);
    case 'diff':
      return fromLegacy((await import('@codemirror/legacy-modes/mode/diff')).diff);
  }
}

function fromSupport(support: LanguageSupport): LoadedSourceLanguage {
  return { extension: support.extension, parser: support.language.parser };
}

async function fromLegacy(parser: StreamParser<unknown>): Promise<LoadedSourceLanguage> {
  const { StreamLanguage } = await import('@codemirror/language');
  return fromLanguage(StreamLanguage.define(parser));
}

function fromLanguage(language: Language): LoadedSourceLanguage {
  return { extension: language.extension, parser: language.parser };
}
