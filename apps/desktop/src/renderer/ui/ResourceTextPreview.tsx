import { useEffect, useState } from 'react';
import type { FilePreviewRequest } from '@zeus/shared';

/** 自动生成的文本附件直接显示内容；旧附件沿用受控文件预览读取摘要。 */
export function ResourceTextPreview(props: { text?: string; request?: FilePreviewRequest; characterCount?: number; pending?: boolean; language: 'zh-CN' | 'en-US' }) {
  /** 序列化身份避免父组件重绘时重复读取；请求仍由业务组件生成。 */
  const identity = props.request ? JSON.stringify(props.request) : null;
  /** 摘要与字符数只保存在当前界面，不改变附件持久化。 */
  const [preview, setPreview] = useState<{ text: string; characterCount: number } | null>(null);
  /** 读取失败保留打开入口，不无限等待摘要。 */
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    /** 卸载或更换附件后旧回执不能覆盖当前内容。 */
    let active = true;
    setPreview(null);
    setFailed(false);
    /** 现有文件预览统一验证附件引用，并限制文本大小。 */
    const bridge = window.zeus;
    if (props.text || props.pending || !identity || !bridge?.loadFilePreview) return;
    void bridge
      .loadFilePreview(JSON.parse(identity) as FilePreviewRequest)
      .then(async (items) => {
        try {
          /** 摘要按普通文本展示，不执行附件中的 HTML。 */
          const content = items.find((item) => item.kind === 'text')?.content;
          if (active) {
            setPreview(content === undefined ? null : { text: content.slice(0, 400), characterCount: content.length });
            setFailed(content === undefined);
          }
        } finally {
          // 摘要读取完成立即撤销所有预览令牌，取消读取也必须释放。
          await bridge.releaseFilePreview(items.map((item) => item.id));
        }
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [identity, props.text, props.pending]);

  /** 内容开头作为标题，剩余文字作为摘要，保留原始全文供点击阅读。 */
  const text = (props.text ?? preview?.text ?? '').trim();
  /** 第一行优先作为标题，长段落仅取开头，避免生成虚构标题。 */
  const firstLine = text.split(/\r?\n/u, 1)[0] ?? '';
  /** Markdown 标题只去掉开头标记，其余内容保持原样。 */
  const title = firstLine.slice(0, 72).replace(/^#{1,6}\s+/u, '');
  /** 单段长文本继续显示标题之后的内容，多行文本显示后续行。 */
  const excerpt = text.slice(Math.min(firstLine.length, 72)).trim();
  /** 优先使用附件记录的完整字数，摘要本身不能代表全文长度。 */
  const count = props.characterCount ?? preview?.characterCount;
  /** 没有读取能力和明确失败都结束摘要占位，打开仍可给出具体原因。 */
  const loading = !text && !preview && !failed && Boolean(identity && window.zeus?.loadFilePreview) && !props.pending;
  return (
    <span className="resource-text-preview" data-loading={loading || undefined}>
      <strong>{title || (loading ? '\u00a0' : props.language === 'zh-CN' ? '文本内容' : 'Text document')}</strong>
      <span className="resource-text-excerpt">
        {excerpt || (loading ? '\u00a0' : failed ? (props.language === 'zh-CN' ? '摘要暂不可用，点击查看全文' : 'Summary unavailable. Open to read.') : props.language === 'zh-CN' ? '点击查看完整内容' : 'Read the full document')}
      </span>
      <small>
        {count === undefined ? 'TXT' : `${count.toLocaleString()} ${props.language === 'zh-CN' ? '字' : 'chars'}`}
        <span>
          {props.pending ? (
            props.language === 'zh-CN' ? (
              '正在导入…'
            ) : (
              'Importing…'
            )
          ) : (
            <>
              {props.language === 'zh-CN' ? '查看全文' : 'Read more'}
              <span aria-hidden="true">↗</span>
            </>
          )}
        </span>
      </small>
    </span>
  );
}
