import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import '../src/renderer/styles.css';
import '../src/renderer/session/session.css';
import './session-styles.css';
import { ActiveTurnReentryQaApp, ActivityCompletionQaApp, CompleteMessageQaApp, ConversationDefectApp, InteractionRecoveryQaApp, MotionApp, SessionStylesQaApp, TimeoutRetryQaApp, TranscriptScrollQaApp } from './session-core-qa.js';
import { MarkdownStreamingQaApp } from './markdown-streaming-qa.js';
import { PlanPreviewActiveQaApp, PlanPreviewHistoryQaApp } from './plan-preview-qa.js';
import { Zeus0388QaApp } from './session-recovery-qa.js';
import { SteeringQaApp } from './steering-qa.js';
import { SourcePreviewQaApp, TaskPushDecouplingApp } from './workspace-qa.js';

declare global {
  interface Window {
    __zeusSessionStylesRoot?: Root;
  }
}

const parameters = new URLSearchParams(window.location.search);
const qaRoot = window.__zeusSessionStylesRoot ?? createRoot(document.getElementById('root')!);
window.__zeusSessionStylesRoot = qaRoot;

const scenes = [
  ['markdown-stream', MarkdownStreamingQaApp],
  ['source-preview', SourcePreviewQaApp],
  ['task-push', TaskPushDecouplingApp],
  ['zeus0323', ConversationDefectApp],
  ['timeout-retry', TimeoutRetryQaApp],
  ['complete-message', CompleteMessageQaApp],
  ['activity-completion', ActivityCompletionQaApp],
  ['active-reentry', ActiveTurnReentryQaApp],
  ['interaction-recovery', InteractionRecoveryQaApp],
  ['plan-preview-active', PlanPreviewActiveQaApp],
  ['plan-preview-history', PlanPreviewHistoryQaApp],
  ['zeus0388', Zeus0388QaApp],
  ['zeus0413', TranscriptScrollQaApp],
  ['steering', SteeringQaApp],
  ['motion', MotionApp],
] as const;

const Scene = scenes.find(([query]) => parameters.has(query))?.[1] ?? SessionStylesQaApp;
qaRoot.render(<Scene />);
