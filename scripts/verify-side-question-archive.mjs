/** 侧栏归档切换的内存自检：node --import tsx scripts/verify-side-question-archive.mjs。 */
import assert from 'node:assert/strict';
import { replaceArchivedSideQuestion } from '../apps/desktop/src/renderer/session/useSessionContextWorkspace.ts';

/** 尚未交给旧会话的引用与附件。 */
const pending = {
  id: 'old-draft',
  conversation: { id: 'archived-conversation', archived: true },
  draft: '',
  annotations: [{ id: 'new-quote' }],
  attachments: [{ localPath: '/pending.txt' }],
  settings: { model: 'selected-model' },
};
/** 旧会话输入框保留已编辑文字、已有引用和代码评论。 */
const draft = {
  draft: '尚未发送的问题',
  attachments: [{ localPath: '/existing.txt' }, { localPath: '/pending.txt' }],
  contextDraft: { responseAnnotations: [{ id: 'existing-quote' }, { id: 'new-quote' }], codeComments: [{ id: 'code-comment' }] },
};
/** 只替换匹配的旧会话，合并内容且不复用首发身份。 */
const next = replaceArchivedSideQuestion(pending, 'archived-conversation', draft);
assert.notEqual(next.id, pending.id);
assert.equal(next.conversation, null);
assert.equal(next.attempt, undefined);
assert.equal(next.draft, draft.draft);
assert.deepEqual(next.attachments, draft.attachments);
assert.deepEqual(next.annotations, draft.contextDraft.responseAnnotations);
assert.deepEqual(next.codeComments, draft.contextDraft.codeComments);
assert.equal(next.settings, pending.settings);
assert.equal(pending.conversation.id, 'archived-conversation');
assert.equal(replaceArchivedSideQuestion(next, 'archived-conversation', draft), next);
assert.equal(replaceArchivedSideQuestion(pending, 'unrelated-conversation', draft), pending);
assert.equal(replaceArchivedSideQuestion(null, 'archived-conversation', draft), null);
