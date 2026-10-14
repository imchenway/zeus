import MarkdownIt, { type Token } from 'markdown-it-ts';
import { enableConversationCjkStrong } from './conversationMarkdown.js';

/** 与正文使用相同的 Markdown 解析内核；仅提取引用，不渲染 HTML 或授予文件权限。 */
const referenceParser = enableConversationCjkStrong(new MarkdownIt({ html: false, linkify: false }));
/** 无效协议也保留为可诊断引用，实际访问仍由资源服务校验。 */
referenceParser.validateLink = () => true;

/** 服务端登记与前端缺失检测共用引用解析，排除代码示例并支持空说明和引用式图片。 */
export function conversationMarkdownReferences(text: string): Array<{ label: string; href: string; image: boolean }> {
  /** 与资源单条消息上限一致，避免巨大正文生成无界资源列表。 */
  const links: Array<{ label: string; href: string; image: boolean }> = [];
  /** 按正文顺序读取真实图片、链接及内联子节点。 */
  function visit(tokens: Token[]): void {
    for (let index = 0; index < tokens.length && links.length < 128; index += 1) {
      /** 同一解析结果同时提供图片目标与说明，避免正则规则互相偏离。 */
      const token = tokens[index]!;
      if (token.type === 'image') links.push({ label: token.content.trim(), href: token.attrGet('src') ?? '', image: true });
      else if (token.type === 'link_open') {
        /** 链接说明仅用于显示，不用来授予权限或匹配资源身份。 */
        const end = tokens.findIndex((candidate, offset) => offset > index && candidate.type === 'link_close');
        links.push({
          label: tokens
            .slice(index + 1, end < 0 ? index + 1 : end)
            .map((candidate) => candidate.content)
            .join('')
            .trim(),
          href: token.attrGet('href') ?? '',
          image: false,
        });
      }
      if (token.type !== 'image' && token.children) visit(token.children);
    }
  }
  visit(referenceParser.parse(text, {}));
  return links.filter((link) => link.href);
}

/** 仅消除解析器的路径编码差异；保留目录和协议，不按文件名或说明猜测。 */
export function normalizeConversationResourceReference(reference: string): string {
  try {
    return decodeURIComponent(reference.trim());
  } catch {
    return reference.trim();
  }
}
