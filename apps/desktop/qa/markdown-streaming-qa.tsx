import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ConversationResource } from '@zeus/shared';
import { ConversationMarkdown } from '../src/renderer/session/ConversationMarkdown.js';
import { copyText as copyTranscriptText } from '../src/renderer/session/ThreadItemView.js';

type MarkdownQaScenario = '20kb' | '100kb';

interface MarkdownQaResult {
  scenario: MarkdownQaScenario;
  firstVisibleMs: number;
  settleMs: number;
  maxLongTaskMs: number;
  frameP95Ms: number;
  inputCommitMs: number;
  stableFirstNode: boolean;
  placeholderCount: number;
  unauthorizedRequests: number;
  unsafeClickableLinks: number;
  codeCopyAvailable: boolean;
  transcriptCopyMatches: boolean;
  sourceMatches: boolean;
  selectionOperable: boolean;
  scrollOperable: boolean;
  passed: boolean;
}

interface MarkdownQaRun {
  scenario: MarkdownQaScenario;
  fixture: string;
  startedAt: number;
  finalAt: number;
  firstVisibleAt: number | null;
  firstNode: Element | null;
  frameGaps: number[];
  maxLongTaskMs: number;
  inputRequestedAt: number | null;
  inputCommitMs: number;
  finished: boolean;
}

const unauthorizedMarkdownUrl = 'https://unauthorized.invalid/zeus-0367.png';
const markdownQaResources: ConversationResource[] = [
  {
    id: 'qa-markdown-authorized-link',
    projectId: 'project-zeus',
    conversationId: 'conversation-markdown-qa',
    turnId: 'turn-markdown-qa',
    itemId: 'item-markdown-qa',
    kind: 'website',
    presentation: 'inline',
    displayName: 'Zeus 已审计资源',
    url: 'https://docs.zeus.local/authorized',
    domain: 'docs.zeus.local',
    local: true,
    createdAt: '2026-08-28T00:00:00.000Z',
    updatedAt: '2026-08-28T00:00:00.000Z',
  },
  {
    id: 'qa-markdown-authorized-image',
    projectId: 'project-zeus',
    conversationId: 'conversation-markdown-qa',
    turnId: 'turn-markdown-qa',
    itemId: 'item-markdown-qa',
    kind: 'attachment',
    presentation: 'inline',
    displayName: '权威会话图片',
    attachmentRef: 'qa-authorized-image',
    mimeType: 'image/png',
    previewKind: 'image',
    iconKind: 'image',
    createdAt: '2026-08-28T00:00:00.000Z',
    updatedAt: '2026-08-28T00:00:00.000Z',
  },
];

const markdownFixture20kb = buildMarkdownQaFixture(20_000);
const markdownFixture100kb = buildMarkdownQaFixture(100_000);

function buildMarkdownQaFixture(targetLength: number): string {
  const featureBlock = [
    '# ZEUS-0367 增量渲染现场',
    '',
    '首段正文需要在首个输入后快速可见。Incremental rendering keeps stable prefixes mounted。',
    '',
    '- 第一层列表',
    '  - 第二层列表包含 **中文** 与 _English_',
    '    1. 有序子项 `streamId`',
    '    2. 最终原位收口',
    '',
    '| 场景 | 输入 | 预期 |',
    '| :--- | ---: | :--- |',
    '| 连续流 | 20 字符 / 30Hz | 稳定节点复用 |',
    '| 突发恢复 | 100KB | 分批挂载 |',
    '',
    '```ts',
    'const phase: "streaming" | "final" = "streaming";',
    'const safe = resources.some((resource) => resource.id === target);',
    '```',
    '',
    '[页内锚点](#qa-markdown-stream-end) · [Zeus 已审计资源](https://docs.zeus.local/authorized) · [未授权链接](https://unauthorized.invalid/blocked)',
    '',
    '![权威会话图片](attachment://qa-authorized-image)',
    '',
    `![未授权图片](${unauthorizedMarkdownUrl})`,
    '',
    '<img src="https://unauthorized.invalid/raw-html.png" onerror="alert(1)">',
    '',
  ].join('\n');
  const tail = '\n\n<span id="qa-markdown-stream-end"></span>\n\n[未闭合链接](https://unauthorized.invalid/incomplete';
  const filler = '稳定段落用于验证追加解析与节点复用。The renderer keeps interaction responsive while the cumulative Markdown buffer grows, and it must not replay complete content at a fixed typewriter speed. 0123456789 '.repeat(5).trim();
  let value = featureBlock;
  let index = 1;
  while (value.length + filler.length + tail.length + 16 < targetLength) {
    value += `\n\n${index}. ${filler}`;
    index += 1;
  }
  const remaining = targetLength - value.length - tail.length;
  if (remaining > 0) value += `\n\n${'中'.repeat(Math.max(0, remaining - 2))}`;
  return `${value}${tail}`.slice(0, targetLength);
}

export function MarkdownStreamingQaApp() {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const textRef = useRef('');
  const runRef = useRef<MarkdownQaRun | null>(null);
  const cleanupRef = useRef<() => void>(() => undefined);
  const [text, setText] = useState('');
  const [phase, setPhase] = useState<'streaming' | 'final'>('streaming');
  const [streamId, setStreamId] = useState('markdown-qa:idle');
  const [scenario, setScenario] = useState<MarkdownQaScenario | 'idle'>('idle');
  const [probeValue, setProbeValue] = useState('');
  const [openedResources, setOpenedResources] = useState(0);
  const [result, setResult] = useState<MarkdownQaResult | null>(null);
  textRef.current = text;

  useLayoutEffect(() => {
    const run = runRef.current;
    if (run?.inputRequestedAt !== null && run?.inputRequestedAt !== undefined && probeValue) {
      run.inputCommitMs = performance.now() - run.inputRequestedAt;
      run.inputRequestedAt = null;
    }
  }, [probeValue]);

  useEffect(() => () => cleanupRef.current(), []);

  const finishRun = useCallback(async () => {
    const run = runRef.current;
    const root = rootRef.current;
    const stage = stageRef.current;
    if (!run || !root || run.finished || !run.finalAt) return;
    run.finished = true;
    const currentFirstNode = root.querySelector('.node-slot');
    const placeholderCount = root.querySelectorAll('.node-placeholder').length;
    const frameP95Ms = percentile(run.frameGaps, 0.95);
    const unauthorizedRequests = performance.getEntriesByType('resource').filter((entry) => entry.name.startsWith('https://unauthorized.invalid/')).length;
    const unsafeClickableLinks = root.querySelectorAll('a[href*="unauthorized.invalid"]').length;
    const codeCopyAvailable = Boolean(root.querySelector('.session-code-block .session-copy-button'));
    let copiedTranscript = '';
    const transcriptCopySucceeded = await copyTranscriptText(run.fixture, {
      writeNative: async (value) => {
        copiedTranscript = value;
        return { written: true };
      },
    });
    const transcriptCopyMatches = transcriptCopySucceeded && copiedTranscript === run.fixture;
    const textRoot = root.querySelector('.text-node');
    const textWalker = textRoot ? document.createTreeWalker(textRoot, NodeFilter.SHOW_TEXT) : null;
    let textNode = textWalker?.nextNode() ?? null;
    while (textNode && !textNode.textContent?.trim()) textNode = textWalker?.nextNode() ?? null;
    let selectionOperable = false;
    if (textNode?.nodeType === Node.TEXT_NODE && textNode.textContent) {
      const range = document.createRange();
      range.setStart(textNode, 0);
      range.setEnd(textNode, Math.min(1, textNode.textContent.length));
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      selectionOperable = Boolean(selection?.toString());
      selection?.removeAllRanges();
    }
    let scrollOperable = false;
    if (stage) {
      stage.scrollTop = Math.max(1, stage.scrollHeight - stage.clientHeight);
      scrollOperable = stage.scrollTop > 0;
    }
    const firstVisibleMs = run.firstVisibleAt === null ? Number.POSITIVE_INFINITY : run.firstVisibleAt - run.startedAt;
    const settleMs = performance.now() - run.finalAt;
    const stableFirstNode = Boolean(run.firstNode && currentFirstNode === run.firstNode);
    const commonPassed =
      stableFirstNode && placeholderCount === 0 && unauthorizedRequests === 0 && unsafeClickableLinks === 0 && codeCopyAvailable && transcriptCopyMatches && textRef.current === run.fixture && selectionOperable && scrollOperable;
    const passed = commonPassed && (run.scenario === '20kb' ? firstVisibleMs <= 100 && settleMs <= 150 && run.maxLongTaskMs < 50 && frameP95Ms <= 32 : settleMs <= 2_000 && run.maxLongTaskMs < 100 && run.inputCommitMs <= 100);
    setResult({
      scenario: run.scenario,
      firstVisibleMs,
      settleMs,
      maxLongTaskMs: run.maxLongTaskMs,
      frameP95Ms,
      inputCommitMs: run.inputCommitMs,
      stableFirstNode,
      placeholderCount,
      unauthorizedRequests,
      unsafeClickableLinks,
      codeCopyAvailable,
      transcriptCopyMatches,
      sourceMatches: textRef.current === run.fixture,
      selectionOperable,
      scrollOperable,
      passed,
    });
    setScenario('idle');
    cleanupRef.current();
  }, []);

  const startScenario = useCallback((nextScenario: MarkdownQaScenario) => {
    cleanupRef.current();
    performance.clearResourceTimings();
    const fixture = nextScenario === '20kb' ? markdownFixture20kb : markdownFixture100kb;
    const nextStreamId = `markdown-qa:${nextScenario}:${Date.now()}`;
    setResult(null);
    setProbeValue('');
    setText('');
    setPhase('streaming');
    setStreamId(nextStreamId);
    setScenario(nextScenario);

    let interval = 0;
    let animationFrame = 0;
    let probeTimer = 0;
    let mutationObserver: MutationObserver | null = null;
    let longTaskObserver: PerformanceObserver | null = null;
    let cancelled = false;

    animationFrame = requestAnimationFrame(() => {
      if (cancelled) return;
      const startedAt = performance.now();
      const run: MarkdownQaRun = {
        scenario: nextScenario,
        fixture,
        startedAt,
        finalAt: 0,
        firstVisibleAt: null,
        firstNode: null,
        frameGaps: [],
        maxLongTaskMs: 0,
        inputRequestedAt: null,
        inputCommitMs: 0,
        finished: false,
      };
      runRef.current = run;

      mutationObserver = new MutationObserver(() => {
        const root = rootRef.current;
        const firstNode = root?.querySelector('.node-slot') ?? null;
        if (!run.firstNode && firstNode) run.firstNode = firstNode;
        if (run.firstVisibleAt === null && root?.textContent?.trim()) run.firstVisibleAt = performance.now();
      });
      if (rootRef.current)
        mutationObserver.observe(rootRef.current, {
          childList: true,
          characterData: true,
          subtree: true,
        });

      try {
        longTaskObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) run.maxLongTaskMs = Math.max(run.maxLongTaskMs, entry.duration);
        });
        longTaskObserver.observe({ type: 'longtask', buffered: false });
      } catch {
        longTaskObserver = null;
      }

      let previousFrame = startedAt;
      const sampleFrame = (now: number) => {
        run.frameGaps.push(now - previousFrame);
        previousFrame = now;
        if (!run.finished && !cancelled) animationFrame = requestAnimationFrame(sampleFrame);
      };
      animationFrame = requestAnimationFrame(sampleFrame);

      probeTimer = window.setTimeout(() => {
        run.inputRequestedAt = performance.now();
        setProbeValue(`输入响应-${nextScenario}`);
      }, 50);

      if (nextScenario === '20kb') {
        let cursor = 0;
        const pushChunk = () => {
          cursor = Math.min(fixture.length, cursor + 20);
          setText(fixture.slice(0, cursor));
          if (cursor < fixture.length) return;
          window.clearInterval(interval);
          run.finalAt = performance.now();
          setPhase('final');
        };
        pushChunk();
        interval = window.setInterval(pushChunk, 1_000 / 30);
      } else {
        animationFrame = requestAnimationFrame(() => {
          run.finalAt = performance.now();
          setText(fixture);
          setPhase('final');
        });
      }
    });

    cleanupRef.current = () => {
      cancelled = true;
      if (interval) window.clearInterval(interval);
      if (animationFrame) cancelAnimationFrame(animationFrame);
      if (probeTimer) window.clearTimeout(probeTimer);
      mutationObserver?.disconnect();
      longTaskObserver?.disconnect();
    };
  }, []);

  return (
    <main className="macos-ai-app zeus-shell session-codex-parity-v1 qa-page qa-markdown-stream-page" data-theme="light" data-testid="markdown-stream-fixture">
      <header className="qa-heading">
        <p>ZEUS-0367 · 确定性会话 Markdown 现场</p>
        <h1>增量与流式渲染</h1>
      </header>
      <section className="qa-markdown-stream-controls">
        <button type="button" disabled={scenario !== 'idle'} onClick={() => startScenario('20kb')}>
          运行 20KB · 20 字符 / 30Hz
        </button>
        <button type="button" disabled={scenario !== 'idle'} onClick={() => startScenario('100kb')}>
          运行 100KB 突发恢复
        </button>
        <label>
          输入响应探针
          <input value={probeValue} onChange={(event) => setProbeValue(event.currentTarget.value)} placeholder="运行期间仍可输入" />
        </label>
        <span role="status" data-testid="markdown-stream-status">
          {scenario === 'idle' ? '就绪' : scenario === '20kb' ? `${text.length} / ${markdownFixture20kb.length}` : `${text.length} / ${markdownFixture100kb.length}`}
        </span>
      </section>
      <section className="qa-markdown-stream-grid">
        <div ref={stageRef} className="qa-markdown-stream-stage" data-testid="markdown-stream-stage">
          <div ref={rootRef}>
            <ConversationMarkdown
              text={text}
              streamId={streamId}
              phase={phase}
              language="zh-CN"
              resources={markdownQaResources}
              onOpenResource={() => setOpenedResources((current) => current + 1)}
              onLoadResourcePreview={async (resource) => ({
                kind: 'image',
                resource: resource as Extract<ConversationResource, { kind: 'attachment' }>,
                mimeType: 'image/png',
                dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
                byteLength: 68,
              })}
              onRenderSettled={finishRun}
            />
          </div>
        </div>
        <aside className="qa-markdown-stream-results" data-testid="markdown-stream-results" data-pass={result?.passed ?? undefined}>
          <h2>现场指标</h2>
          {result ? (
            <dl>
              <dt>场景</dt>
              <dd>{result.scenario}</dd>
              <dt>首段可见</dt>
              <dd data-testid="markdown-first-visible-ms">{formatQaMetric(result.firstVisibleMs)} ms</dd>
              <dt>final 收口</dt>
              <dd data-testid="markdown-settle-ms">{formatQaMetric(result.settleMs)} ms</dd>
              <dt>最大长任务</dt>
              <dd>{formatQaMetric(result.maxLongTaskMs)} ms</dd>
              <dt>帧间隔 P95</dt>
              <dd>{formatQaMetric(result.frameP95Ms)} ms</dd>
              <dt>输入提交</dt>
              <dd>{formatQaMetric(result.inputCommitMs)} ms</dd>
              <dt>首节点身份</dt>
              <dd>{result.stableFirstNode ? '保持' : '变化'}</dd>
              <dt>占位节点</dt>
              <dd data-testid="markdown-placeholder-count">{result.placeholderCount}</dd>
              <dt>未授权请求</dt>
              <dd data-testid="markdown-unauthorized-requests">{result.unauthorizedRequests}</dd>
              <dt>未授权可点击链接</dt>
              <dd>{result.unsafeClickableLinks}</dd>
              <dt>代码复制按钮</dt>
              <dd>{result.codeCopyAvailable ? '可用' : '缺失'}</dd>
              <dt>正文复制</dt>
              <dd>{result.transcriptCopyMatches ? '与累计正文一致' : '不一致'}</dd>
              <dt>累计正文</dt>
              <dd>{result.sourceMatches ? '一致' : '不一致'}</dd>
              <dt>选择 / 滚动</dt>
              <dd>
                {result.selectionOperable ? '可选择' : '选择失败'} / {result.scrollOperable ? '可滚动' : '滚动失败'}
              </dd>
            </dl>
          ) : (
            <p>运行场景后显示确定性指标。</p>
          )}
          <small>已打开资源：{openedResources}</small>
        </aside>
      </section>
    </main>
  );
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0;
}

function formatQaMetric(value: number): string {
  return Number.isFinite(value) ? value.toFixed(1) : '∞';
}
