import React from 'react';
import { ConversationMarkdown } from '../src/renderer/session/ConversationMarkdown.js';
import { SessionActivityGroup } from '../src/renderer/session/SessionActivity.js';
import type { NativeSessionItemBuffer } from '../src/renderer/session/sessionTypes.js';

interface QaScene {
  query: string;
  title: string;
  summary: string;
  answer: string;
  activities: Array<{ type: string; status: string; text?: string; payload?: Record<string, unknown> }>;
}

const scenes: QaScene[] = [
  {
    query: 'overview',
    title: '会话核心组件',
    summary: '一份数据同时驱动浅色和深色真实组件。',
    answer: '已收缩为一个场景表：\n\n- 正文使用 `ConversationMarkdown`\n- 活动使用 `SessionActivityGroup`\n- 样式直接来自生产 Renderer',
    activities: [
      { type: 'commandExecution', status: 'completed', payload: { command: ['pnpm', 'lint'] } },
      { type: 'fileChange', status: 'completed', payload: { path: 'apps/desktop/src/renderer/session/ConversationTranscript.tsx' } },
    ],
  },
  {
    query: 'motion',
    title: '进行中活动焦点',
    summary: '只保留会话动效的最小真实组件链。',
    answer: '正在收口最后一项工作。',
    activities: [
      { type: 'commandExecution', status: 'completed', payload: { command: ['pnpm', 'typecheck'] } },
      { type: 'webSearch', status: 'completed', payload: { query: 'Zeus 会话视觉验收' } },
      { type: 'commandExecution', status: 'in_progress', payload: { command: ['pnpm', 'build'] } },
    ],
  },
  {
    query: 'error',
    title: '失败态可读性',
    summary: '用一条真实失败活动核对文字、层级和对比度。',
    answer: '操作未完成，错误详情保持可见。',
    activities: [{ type: 'commandExecution', status: 'failed', payload: { command: ['pnpm', 'package:mac'], error: 'Package probe failed.' } }],
  },
];

function activity(scene: QaScene, index: number): NativeSessionItemBuffer {
  const source = scene.activities[index]!;
  const id = `${scene.query}-${index + 1}`;
  return {
    key: `qa:${id}`,
    conversationId: 'qa-conversation',
    threadId: 'qa-thread',
    turnId: 'qa-turn',
    itemId: id,
    type: source.type,
    status: source.status,
    phase: 'prework',
    text: source.text ?? '',
    payload: source.payload ?? {},
    resources: [],
    updatedAt: '2026-09-02T00:00:00.000Z',
  };
}

export function sceneFromSearch(search: string): QaScene {
  const parameters = new URLSearchParams(search);
  return scenes.find((scene) => parameters.has(scene.query)) ?? scenes[0]!;
}

export function SessionQaApp(props: { scene: QaScene }) {
  const items = props.scene.activities.map((_, index) => activity(props.scene, index));
  return (
    <main className="macos-ai-app zeus-shell qa-page">
      <header className="qa-heading">
        <p>2026-09-02 · 数据驱动视觉验收</p>
        <h1>{props.scene.title}</h1>
        <span>{props.scene.summary}</span>
      </header>
      <div className="qa-themes">
        {(['light', 'dark'] as const).map((theme) => (
          <section className={`qa-theme theme-${theme}`} data-theme={theme} key={theme}>
            <p className="qa-user-message">请检查当前会话状态。</p>
            <SessionActivityGroup items={items} language="zh-CN" category="mixed" motionActive />
            <article className="qa-answer">
              <ConversationMarkdown text={props.scene.answer} streamId={`qa:${props.scene.query}`} phase="final" language="zh-CN" />
            </article>
          </section>
        ))}
      </div>
      <nav className="qa-scenes" aria-label="QA 场景">
        {scenes.map((scene) => (
          <a href={`?${scene.query}`} aria-current={scene === props.scene ? 'page' : undefined} key={scene.query}>
            {scene.title}
          </a>
        ))}
      </nav>
    </main>
  );
}
