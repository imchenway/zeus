import type { Parser, Tree } from '@lezer/common';
import { classHighlighter, highlightCode } from '@lezer/highlight';
import type { HighlightedLine, HighlightedToken } from './SyntaxHighlightedCode.js';
import { loadSourceLanguage } from './sourceLanguageRegistry.js';

const parseSliceMilliseconds = 8;

export async function highlightSourceSegments(input: { language: string; contents: readonly string[]; cancelled: () => boolean }): Promise<HighlightedLine[][] | null> {
  const loaded = await loadSourceLanguage(input.language);
  if (!loaded || input.cancelled()) return null;
  const highlighted: HighlightedLine[][] = [];
  for (const content of input.contents) {
    const normalized = normalizeLineEndings(content);
    const tree = await parseWithoutBlocking(loaded.parser, normalized, input.cancelled);
    if (!tree || input.cancelled()) return null;
    highlighted.push(tokensFromTree(normalized, tree));
  }
  return highlighted;
}

function parseWithoutBlocking(parser: Parser, content: string, cancelled: () => boolean): Promise<Tree | null> {
  const partial = parser.startParse(content);
  return new Promise((resolve) => {
    const advance = (): void => {
      if (cancelled()) {
        resolve(null);
        return;
      }
      const deadline = performance.now() + parseSliceMilliseconds;
      let tree: Tree | null = null;
      do {
        tree = partial.advance();
      } while (!tree && performance.now() < deadline);
      if (tree) {
        resolve(tree);
        return;
      }
      scheduleParseSlice(advance);
    };
    scheduleParseSlice(advance);
  });
}

function scheduleParseSlice(callback: () => void): void {
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(callback, { timeout: 50 });
    return;
  }
  window.setTimeout(callback, 0);
}

function tokensFromTree(content: string, tree: Tree): HighlightedLine[] {
  const lines: HighlightedLine[] = [[]];
  highlightCode(
    content,
    tree,
    classHighlighter,
    (text, classes) => {
      if (!text) return;
      const token: HighlightedToken = classes ? { text, classes } : { text };
      lines.at(-1)!.push(token);
    },
    () => lines.push([]),
  );
  if (content.endsWith('\n') && lines.length > 1) lines.pop();
  return lines;
}

function normalizeLineEndings(content: string): string {
  return content.replace(/\r\n?/gu, '\n');
}
