import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import '../src/renderer/styles.css';
import '../src/renderer/session/session.css';
import './session-styles.css';
import { sceneFromSearch, SessionQaApp } from './session-core-qa.js';

declare global {
  interface Window {
    __zeusSessionStylesRoot?: Root;
  }
}

const qaRoot = window.__zeusSessionStylesRoot ?? createRoot(document.getElementById('root')!);
window.__zeusSessionStylesRoot = qaRoot;
qaRoot.render(<SessionQaApp scene={sceneFromSearch(window.location.search)} />);
