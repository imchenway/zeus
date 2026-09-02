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
