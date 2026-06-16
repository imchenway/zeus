#!/usr/bin/env node
/* global console */
import { checkAiCliAdapter } from '../packages/ai-runtime/dist/index.js';

const requiredAdapters = ['codex', 'claude', 'gemini'];
const statuses = [];

for (const adapterId of requiredAdapters) {
  // 发布门禁只做非侵入式版本/登录状态探测：不启动真实任务，也不把未知状态伪装成已登录。
  const status = await checkAiCliAdapter(adapterId);
  statuses.push(status);
}

const summary = statuses
  .map((status) => {
    const state = status.authStatus === 'unauthenticated' ? 'unauthenticated' : status.available ? 'available' : 'unavailable';
    const version = status.version ? `@${status.version}` : '';
    return `${status.id}=${state}${version}`;
  })
  .join(';');

if (statuses.some((status) => status.authStatus === 'authenticated')) {
  throw new Error('Zeus AI CLI adapter probe must not fabricate authenticated state.');
}

console.log(`ai-cli-adapters=checked;${summary};authStatus=real-probe-or-unknown`);
