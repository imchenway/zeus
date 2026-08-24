import { memo, useDeferredValue, useEffect, useMemo, useState, type ReactNode } from 'react';
import { detectSourceLanguage, isSourceLanguageId } from '@zeus/shared';

export interface HighlightedToken {
  text: string;
  classes?: string;
}

export type HighlightedLine = HighlightedToken[];

interface HighlightState {
  contents: readonly string[];
  language: string;
  lines: HighlightedLine[][] | null;
}

export function useSyntaxHighlightedLines(path: string, content: string, language?: string | null): HighlightedLine[] {
  const contents = useMemo(() => [content], [content]);
  return useSyntaxHighlightedSegments(path, contents, language)[0] ?? [[]];
}

export function useDeferredSyntaxHighlightedLines(path: string, content: string, language?: string | null): HighlightedLine[] {
  const deferredContent = useDeferredValue(content);
  const deferredLines = useSyntaxHighlightedLines(path, deferredContent, language);
  const currentPlainLines = useMemo(() => plainSourceLines(content), [content]);
  return deferredContent === content ? deferredLines : currentPlainLines;
}

export function useSyntaxHighlightedSegments(path: string, contents: readonly string[], language?: string | null): HighlightedLine[][] {
  const resolvedLanguage = language === undefined ? detectSourceLanguage(path) : language;
  const plainLines = useMemo(() => contents.map(plainSourceLines), [contents]);
  const [highlighted, setHighlighted] = useState<HighlightState | null>(null);

  useEffect(() => {
    if (!isSourceLanguageId(resolvedLanguage)) return;
    let cancelled = false;
    void import('./syntaxHighlightRuntime.js')
      .then((runtime) => runtime.highlightSourceSegments({ language: resolvedLanguage, contents, cancelled: () => cancelled }))
      .then((lines) => {
        if (!cancelled) setHighlighted({ contents, language: resolvedLanguage, lines });
      })
      .catch(() => {
        if (!cancelled) setHighlighted({ contents, language: resolvedLanguage, lines: null });
      });
    return () => {
      cancelled = true;
    };
  }, [contents, resolvedLanguage]);

  if (highlighted?.contents !== contents || highlighted.language !== resolvedLanguage || !highlighted.lines) return plainLines;
  return highlighted.lines;
}

export const SyntaxHighlightedLine = memo(function SyntaxHighlightedLine(props: { line: HighlightedLine; empty?: ReactNode }) {
  if (props.line.length === 0) return props.empty ?? '\u00a0';
  return props.line.map((token, index) =>
    token.classes ? (
      <span key={`${index}:${token.text.length}`} className={token.classes}>
        {token.text}
      </span>
    ) : (
      token.text
    ),
  );
});

function plainSourceLines(content: string): HighlightedLine[] {
  const normalized = content.replace(/\r\n?/gu, '\n');
  if (normalized === '') return [[]];
  const lines = (normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized).split('\n');
  return lines.map((line) => (line ? [{ text: line }] : []));
}
