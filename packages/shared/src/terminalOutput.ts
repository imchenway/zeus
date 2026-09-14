/** 交互终端使用登记的 shell；精确匹配参数，避免混入普通脚本和 AI 会话。 */
export function isInteractiveShellSession(session: { command: string; args: readonly string[] }): boolean {
  return session.command === 'sh' && session.args.length === 1 && session.args[0] === '-i';
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
