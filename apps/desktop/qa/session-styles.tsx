import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import '../src/renderer/styles.css';
import '../src/renderer/session/session.css';
import './session-styles.css';
import { ActiveTurnReentryQaApp, CompleteMessageQaApp, ConversationDefectApp, InteractionRecoveryQaApp, MotionApp, SessionStylesQaApp, TimeoutRetryQaApp, TranscriptScrollQaApp } from './session-core-qa.js';
import { MarkdownStreamingQaApp } from './markdown-streaming-qa.js';
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
qaRoot.render(
  parameters.has('markdown-stream') ? (
    <MarkdownStreamingQaApp />
  ) : parameters.has('source-preview') ? (
    <SourcePreviewQaApp />
  ) : parameters.has('task-push') ? (
    <TaskPushDecouplingApp />
  ) : parameters.has('zeus0323') ? (
    <ConversationDefectApp />
  ) : parameters.has('timeout-retry') ? (
    <TimeoutRetryQaApp />
  ) : parameters.has('complete-message') ? (
    <CompleteMessageQaApp />
  ) : parameters.has('active-reentry') ? (
    <ActiveTurnReentryQaApp />
  ) : parameters.has('interaction-recovery') ? (
    <InteractionRecoveryQaApp />
  ) : parameters.has('zeus0388') ? (
    <Zeus0388QaApp />
  ) : parameters.has('zeus0413') ? (
    <TranscriptScrollQaApp />
  ) : parameters.has('steering') ? (
    <SteeringQaApp />
  ) : parameters.has('motion') ? (
    <MotionApp />
  ) : (
    <SessionStylesQaApp />
  ),
);
