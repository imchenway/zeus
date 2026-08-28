import { type FormEvent, useState } from 'react';
import { XIcon as X } from '@phosphor-icons/react/dist/csr/X';
import type { SessionUiLanguage } from './ThreadItemView.js';
import { ConversationMarkdown } from './ConversationMarkdown.js';
import { useApplicationErrorDialog } from '../ui/ApplicationErrorDialog.js';

interface SideChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
}

export function SideChatWorkspace(props: { selectedText: string; language: SessionUiLanguage; onAsk: (question: string) => Promise<string>; onClose: () => void }) {
  const zh = props.language === 'zh-CN';
  const [draft, setDraft] = useState('');
  const [messages, setMessages] = useState<SideChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useApplicationErrorDialog(error, {
    language: zh ? 'zh-CN' : 'en',
  });

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const question = draft.trim();
    if (!question || busy) return;
    const history = messages.map((message) => `${message.role === 'user' ? '用户' : '助手'}：${message.text}`).join('\n\n');
    const providerQuestion = [history, `用户：${question}`].filter(Boolean).join('\n\n');
    const userMessage: SideChatMessage = { id: crypto.randomUUID(), role: 'user', text: question };
    setMessages((current) => [...current, userMessage]);
    setDraft('');
    setBusy(true);
    setError(null);
    try {
      const answer = await props.onAsk(providerQuestion);
      setMessages((current) => [...current, { id: crypto.randomUUID(), role: 'assistant', text: answer }]);
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="session-side-chat" aria-label={zh ? '侧边聊天' : 'Side chat'}>
      <header className="session-side-chat-header">
        <div>
          <strong>{zh ? '侧边聊天' : 'Side chat'}</strong>
          <small>{zh ? '临时聊天，关闭后消失' : 'Temporary chat; it disappears when closed'}</small>
        </div>
        <button type="button" aria-label={zh ? '关闭侧边聊天' : 'Close side chat'} onClick={props.onClose}>
          <X aria-hidden="true" />
        </button>
      </header>
      <div className="session-side-chat-messages">
        {messages.length === 0 ? (
          <div className="session-side-chat-empty">
            <span aria-hidden="true">＋</span>
            <strong>{zh ? '侧边聊天' : 'Side chat'}</strong>
            <small>{zh ? '围绕所选内容提问，不会写入主会话。' : 'Ask about the selection without adding it to the main chat.'}</small>
          </div>
        ) : (
          messages.map((message) => (
            <article key={message.id} data-role={message.role}>
              <ConversationMarkdown text={message.text} streamId={`side-chat:${message.id}`} phase="final" language={props.language} />
            </article>
          ))
        )}
        {busy ? <p className="session-side-chat-status">{zh ? '正在回答…' : 'Answering…'}</p> : null}
      </div>
      <form className="session-side-chat-composer" onSubmit={(event) => void submit(event)}>
        <span className="session-side-chat-selection" title={props.selectedText}>
          {zh ? '1 个已选文本片段' : '1 selected text snippet'}
        </span>
        <textarea autoFocus value={draft} placeholder={zh ? '随心输入' : 'Ask anything'} disabled={busy} onChange={(event) => setDraft(event.currentTarget.value)} />
        <button type="submit" aria-label={zh ? '发送' : 'Send'} disabled={busy || !draft.trim()}>
          ↑
        </button>
      </form>
    </section>
  );
}
