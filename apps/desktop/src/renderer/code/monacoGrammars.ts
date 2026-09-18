import { registerExtension } from '@codingame/monaco-vscode-api/extensions';
import { RegisteredReadOnlyFile, registerExtensionFile } from '@codingame/monaco-vscode-files-service-override';
import { Uri } from 'monaco-editor';

const loaders = {
  c: () => import('@shikijs/langs/c'),
  cpp: () => import('@shikijs/langs/cpp'),
  cmake: () => import('@shikijs/langs/cmake'),
  diff: () => import('@shikijs/langs/diff'),
  dockerfile: () => import('@shikijs/langs/dockerfile'),
  go: () => import('@shikijs/langs/go'),
  java: () => import('@shikijs/langs/java'),
  kotlin: () => import('@shikijs/langs/kotlin'),
  markdown: () => import('@shikijs/langs/markdown'),
  php: () => import('@shikijs/langs/php'),
  properties: () => import('@shikijs/langs/properties'),
  ruby: () => import('@shikijs/langs/ruby'),
  rust: () => import('@shikijs/langs/rust'),
  sass: () => import('@shikijs/langs/sass'),
  scss: () => import('@shikijs/langs/scss'),
  shellscript: () => import('@shikijs/langs/shellscript'),
  sql: () => import('@shikijs/langs/sql'),
  swift: () => import('@shikijs/langs/swift'),
  toml: () => import('@shikijs/langs/toml'),
  xml: () => import('@shikijs/langs/xml'),
  yaml: () => import('@shikijs/langs/yaml'),
  vue: () => import('@shikijs/langs/vue'),
};
const loaded = new Map<string, Promise<void>>();
const builtin = new Set(['javascript', 'typescript', 'css', 'html', 'json', 'python']);
const scopes = new Set<string>();

/** 按打开的语言加载 TextMate 语法，注册内存文件，避免动态网络请求与重复打包全语言集。 */
export function loadEditorGrammar(language: string): Promise<void> {
  const load = loaders[language as keyof typeof loaders];
  if (!load) return Promise.resolve();
  let pending = loaded.get(language);
  if (!pending) {
    pending = (async () => {
      const definitions = (await load()).default;
      // 主语法可能使用别名，或已被另一种语言作为嵌入语法载入，仍需绑定语言 ID。
      const primary = definitions.at(-1);
      const grammars = definitions.filter((grammar) => grammar === primary || (!builtin.has(grammar.name) && !scopes.has(grammar.scopeName)));
      const name = 'source-grammars-' + language;
      const encoder = new TextEncoder();
      for (const grammar of grammars) {
        scopes.add(grammar.scopeName);
        const data = encoder.encode(JSON.stringify(grammar));
        registerExtensionFile(new RegisteredReadOnlyFile(Uri.from({ scheme: 'extension-file', authority: 'zeus.' + name, path: '/extension/' + grammar.scopeName + '.json' }), async () => data, data.length));
      }
      const extension = registerExtension({
        name,
        publisher: 'zeus',
        version: '1.0.0',
        engines: { vscode: '*' },
        contributes: {
          languages: [{ id: language, aliases: [language] }],
          grammars: grammars.map((grammar) => ({ scopeName: grammar.scopeName, path: './' + grammar.scopeName + '.json', ...(grammar === primary ? { language } : {}) })),
        },
      });
      await extension.whenReady();
    })();
    loaded.set(language, pending);
  }
  return pending;
}
