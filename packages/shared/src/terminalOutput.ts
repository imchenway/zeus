/** 交互终端使用登记的 shell；精确匹配参数，避免混入普通脚本和 AI 会话。 */
export function isInteractiveShellSession(session: { command: string; args: readonly string[] }): boolean {
  /** 兼容系统登记的绝对路径，只把明确的交互启动参数当作终端。 */
  const shell = session.command.split(/[\\/]/u).at(-1);
  return ['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh'].includes(shell ?? '') && ((session.args.length === 1 && session.args[0] === '-i') || (session.args.length === 2 && session.args[0] === '-l' && session.args[1] === '-i'));
}

export function projectTerminalOutput(input: string): string {
  const completedLines: string[] = [];
  let currentLine = '';
  for (const character of input) {
    if (character === '\r') currentLine = '';
    else if (character === '\n') {
      completedLines.push(currentLine);
      currentLine = '';
    } else if (character === '\b') currentLine = currentLine.slice(0, -1);
    else currentLine += character;
  }
  return completedLines.length > 0 ? `${completedLines.join('\n')}\n${currentLine}` : currentLine;
}
