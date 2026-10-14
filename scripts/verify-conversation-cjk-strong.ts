import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { enableConversationCjkStrong } from '../packages/shared/src/conversationMarkdown.js';

/** 从实际渲染包解析依赖，核对当前安装的生产解析器。 */
const rendererPath = realpathSync(new URL('../apps/desktop/node_modules/markstream-react', import.meta.url));
const { getMarkdown, parseMarkdownToStructure } = await import(pathToFileURL(join(rendererPath, '..', 'stream-markdown-parser/dist/index.js')).href);
/** 同一实例重复配置不能叠加规则。 */
const parser = getMarkdown('cjk-strong-check');
/** 现场句子的原解析结果没有加粗节点。 */
const source = '1. **修正误判。**已有接收回执。\n2. **删除错误文案。**去掉错误提示。\n3. **保留现有重试流程。**用户点击后读取状态。';
assert.equal(countStrong(parseMarkdownToStructure(source, parser, { final: true })), 0);
enableConversationCjkStrong(parser);
enableConversationCjkStrong(parser);
assert.equal(countStrong(parseMarkdownToStructure(source, parser, { final: true })), 3);
/** 已闭合的中文边界在流式和最终阶段使用同一规则。 */
for (const final of [false, true]) {
  for (const text of ['**修正误判。**已有回执', '前文**“重点”**后文', '**重点：**下一步', '**重点。**next', '前文**（重点）**后文', '**𠀀。**𠀀', '***重点。***后文', '**[重点。](https://example.com)**后文']) {
    assert.equal(countStrong(parseMarkdownToStructure(text, parser, { final })), 1, `${final}: ${text}`);
  }
}
/** 英文规则、真实空白、转义星号和代码示例不能被当成待修正的加粗。 */
for (const text of ['**English.**next', '** 重点**后文', '**重点。 **后文', '\\*\\*重点。\\*\\*后文', '`**重点。**后文`', '```text\n**重点。**后文\n```']) {
  assert.equal(countStrong(parseMarkdownToStructure(text, parser, { final: true })), 0, text);
}
console.log('PASS: 原句 0→3 个加粗节点；中文标点、引号、嵌套、链接、流式和最终态通过；英文、空白、转义与代码保持原义。');

/** 统计真实解析树中的加粗节点，不依据显示文本或星号数量猜测结果。 */
function countStrong(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((sum, entry) => sum + countStrong(entry), 0);
  if (!value || typeof value !== 'object') return 0;
  /** 解析器的节点字段由公共树结构递归读取。 */
  const node = value as Record<string, unknown>;
  return (node.type === 'strong' ? 1 : 0) + Object.values(node).reduce<number>((sum, entry) => sum + countStrong(entry), 0);
}
