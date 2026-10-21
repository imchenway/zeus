/** 列表编辑只返回文字改动；原生输入框和 CodeMirror 各自管理撤销与事件。 */
export interface MarkdownListEdit {
  /** 旧文本中的替换范围。 */
  from: number;
  /** 替换范围的结束位置。 */
  to: number;
  /** 新写入的原始 Markdown 文本。 */
  insert: string;
  /** 改动后的选区起点。 */
  anchor: number;
  /** 改动后的选区终点。 */
  head: number;
}

/** 保留列表原有符号、空格及引用层级。 */
interface ListLine {
  /** 引用前缀不参与列表缩进。 */
  quote: string;
  /** 列表层级沿用空格或制表符。 */
  indent: string;
  /** 数字、字母或无序符号。 */
  marker: string;
  /** 有序列表保留点号或右括号。 */
  delimiter: string;
  /** 标记与正文之间的原始空白。 */
  spacing: string;
  /** 任务列表的新项总是未勾选。 */
  task: string;
  /** 正文不包含编号和复选框。 */
  content: string;
  /** 原行正文起点，用于避免改动编号中间的换行。 */
  contentOffset: number;
}

/** 列表新层级使用四个空格，已有制表符层级继续用制表符。 */
const listIndent = '    ';

/** 识别显式列表标记，不把普通句子、分隔线或缺少空格的路径视为列表。 */
function parseListLine(line: string): ListLine | null {
  if (/^\s*(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/u.test(line)) return null;
  /** 引用可包含多层，编号支持数字和大小写字母。 */
  const match = /^((?:[ \t]*>[ \t]?)*)([ \t]*)(?:(\d{1,9}|[a-z]{1,3}|[A-Z]{1,3})([.)])|([-+*]))([ \t]+)(?:\[([ xX])\]([ \t]+))?(.*)$/u.exec(line);
  if (!match) return null;
  return {
    quote: match[1]!,
    indent: match[2]!,
    marker: match[3] ?? match[5]!,
    delimiter: match[4] ?? '',
    spacing: match[6]!,
    task: match[7] === undefined ? '' : `[ ]${match[8]}`,
    content: match[9]!,
    contentOffset: line.length - match[9]!.length,
  };
}

/** 字母编号按 a 到 z、aa 的顺序进位，数字保留原有补零宽度。 */
function nextMarker(marker: string): string {
  if (/^\d+$/u.test(marker)) return String(Number(marker) + 1).padStart(marker.length, '0');
  if (!/^[a-z]+$/iu.test(marker)) return marker;
  /** 从末位进位，保持原大小写。 */
  const letters = [...marker];
  /** 当前字母序列的起点与终点。 */
  const first = marker === marker.toUpperCase() ? 'A' : 'a';
  const last = first === 'A' ? 'Z' : 'z';
  for (let index = letters.length - 1; index >= 0; index -= 1) {
    if (letters[index] !== last) {
      letters[index] = String.fromCharCode(letters[index]!.charCodeAt(0) + 1);
      return letters.join('');
    }
    letters[index] = first;
  }
  return first + letters.join('');
}

/** 新子列表从首项开始，保留无序符号和有序分隔符。 */
function firstMarker(marker: string): string {
  if (/^\d+$/u.test(marker)) return '1'.padStart(marker.length, '0');
  return /^[a-z]+$/u.test(marker) ? 'a' : /^[A-Z]+$/u.test(marker) ? 'A' : marker;
}

/** 制表符按四列计算，仅用于判断父子关系，不改写已有缩进。 */
function indentWidth(indent: string): number {
  return [...indent].reduce((width, char) => (char === '\t' ? width + 4 - (width % 4) : width + 1), 0);
}

/** 退出一层时优先回到已有父级，手工缩进也能保持原层级。 */
function parentIndent(text: string, before: number, current: ListLine): string {
  /** 从当前行向前查找最近的外层列表。 */
  const lines = text.slice(0, before).split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    /** 空行不影响列表父级；不同引用或普通段落结束查找。 */
    const line = lines[index]!;
    if (!line.trim()) continue;
    const previous = parseListLine(line);
    if (!previous || previous.quote !== current.quote) break;
    if (indentWidth(previous.indent) < indentWidth(current.indent)) return previous.indent;
  }
  return current.indent.endsWith('\t') ? current.indent.slice(0, -1) : current.indent.slice(0, Math.max(0, current.indent.length - listIndent.length));
}

/** 缩进后接续目标层级的同类编号，不重新编号用户未操作的其他段落。 */
function markerAtIndent(text: string, before: number, current: ListLine, indent: string): string {
  /** 查找最近同级项，遇到外层或普通段落即开始新列表。 */
  const lines = text.slice(0, before).split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    if (!line.trim()) continue;
    const previous = parseListLine(line);
    if (!previous || previous.quote !== current.quote || indentWidth(previous.indent) < indentWidth(indent)) break;
    if (previous.indent !== indent) continue;
    if (previous.delimiter === current.delimiter && /^\d+$/u.test(previous.marker) === /^\d+$/u.test(current.marker) && /^[a-z]+$/u.test(previous.marker) === /^[a-z]+$/u.test(current.marker)) return nextMarker(previous.marker);
    break;
  }
  return firstMarker(current.marker);
}

/** 围栏中的代码示例保持字面输入，不执行 Markdown 列表操作。 */
function insideCodeFence(text: string, before: number): boolean {
  /** 围栏只由相同符号且不少于开始长度的结束行关闭。 */
  let fence: string | null = null;
  for (const line of text.slice(0, before).split('\n')) {
    /** 列表项中的代码围栏同样不继续编号。 */
    const body = parseListLine(line)?.content ?? line.replace(/^(?:[ \t]*>[ \t]?)*[ \t]*/u, '');
    const match = /^(`{3,}|~{3,})(.*)$/u.exec(body);
    if (!match) continue;
    if (!fence) fence = match[1]!;
    else if (match[1]![0] === fence[0] && match[1]!.length >= fence.length && !match[2]!.trim()) fence = null;
  }
  return fence !== null;
}

/** 换行继承当前层级，数字与字母递增；空项先退出子层级，再退出列表。 */
export function continueMarkdownList(text: string, start: number, end: number): MarkdownListEdit | null {
  /** 只读取选区起始行，选区正文由一次编辑整体替换。 */
  const from = start === 0 ? 0 : text.lastIndexOf('\n', start - 1) + 1;
  const newline = text.indexOf('\n', start);
  const lineEnd = newline < 0 ? text.length : newline;
  const current = parseListLine(text.slice(from, lineEnd));
  if (!current || start < from + current.contentOffset || insideCodeFence(text, from)) return null;
  if (start === end && !current.content.trim()) {
    /** 子列表的空项退回上一层；顶层空项移除编号，不产生另一条空列表。 */
    const indent = parentIndent(text, from, current);
    const insert = current.indent ? `${current.quote}${indent}${markerAtIndent(text, from, current, indent)}${current.delimiter}${current.spacing}${current.task}` : current.quote;
    return { from, to: lineEnd, insert, anchor: from + insert.length, head: from + insert.length };
  }
  /** 新项继承空白格式，已勾选任务转为未勾选。 */
  const insert = `\n${current.quote}${current.indent}${nextMarker(current.marker)}${current.delimiter}${current.spacing}${current.task}`;
  return { from: start, to: end, insert, anchor: start + insert.length, head: start + insert.length };
}

/** Tab 只在列表中调整层级；普通文本继续使用原有焦点导航。 */
export function indentMarkdownList(text: string, start: number, end: number, outdent: boolean): MarkdownListEdit | null {
  /** 选区末尾位于下一行行首时，不把下一行纳入缩进。 */
  const from = start === 0 ? 0 : text.lastIndexOf('\n', start - 1) + 1;
  const last = end > start && text[end - 1] === '\n' ? end - 1 : end;
  const newline = text.indexOf('\n', last);
  const to = newline < 0 ? text.length : newline;
  if (insideCodeFence(text, from)) return null;
  /** 多行操作只接受完整列表行，避免把普通段落变成列表。 */
  const lines = text.slice(from, to).split('\n');
  const entries = lines.map(parseListLine);
  if (entries.some((entry) => !entry)) return null;
  if (outdent && entries.every((entry) => !entry!.indent)) return null;
  /** 分别记录选区两端的位移，保留原来的正文选区。 */
  let anchor = start;
  let head = end;
  let oldOffset = from;
  let newOffset = from;
  let insert = '';
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const current = entries[index]!;
    const indent = outdent ? parentIndent(text, oldOffset, current) : current.indent + (current.indent.includes('\t') ? '\t' : listIndent);
    const marker = markerAtIndent(text.slice(0, from) + insert, newOffset, current, indent);
    /** 原正文与复选状态保持不变，只修改缩进和编号。 */
    const prefix = `${current.quote}${indent}${marker}${current.delimiter}${current.spacing}`;
    const oldPrefixLength = current.quote.length + current.indent.length + current.marker.length + current.delimiter.length + current.spacing.length;
    const replacement = prefix + line.slice(oldPrefixLength);
    if (start >= oldOffset && start <= oldOffset + line.length) anchor = newOffset + Math.max(prefix.length, start - oldOffset + prefix.length - oldPrefixLength);
    if (end >= oldOffset && end <= oldOffset + line.length) head = newOffset + Math.max(prefix.length, end - oldOffset + prefix.length - oldPrefixLength);
    insert += (index ? '\n' : '') + replacement;
    oldOffset += line.length + 1;
    newOffset += replacement.length + 1;
  }
  if (end > start && text[end - 1] === '\n') head = from + insert.length + 1;
  return { from, to, insert, anchor, head };
}
