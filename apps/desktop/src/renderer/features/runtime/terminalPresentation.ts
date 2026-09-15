import type { ITerminalOptions, Terminal } from '@xterm/xterm';
import './terminal.css';

/** 两个交互终端沿用命令入口的字体、光标和字符配色，运行与缓冲区选项由入口负责。 */
export const terminalDisplayOptions: ITerminalOptions = {
  cursorBlink: true,
  cursorStyle: 'block',
  fontFamily: '"Sarasa Term SC", "MesloLGS Nerd Font", "SFMono-Regular", monospace',
  fontSize: 15,
  lineHeight: 1,
  minimumContrastRatio: 4.5,
  theme: {
    black: '#1d1f21',
    red: '#cc6666',
    green: '#b5bd68',
    yellow: '#f0c674',
    blue: '#81a2be',
    magenta: '#b294bb',
    cyan: '#8abeb7',
    white: '#c5c8c6',
    brightBlack: '#666666',
    brightRed: '#d54e53',
    brightGreen: '#b9ca4a',
    brightYellow: '#e7c547',
    brightBlue: '#7aa6da',
    brightMagenta: '#c397d8',
    brightCyan: '#70c0b1',
    brightWhite: '#eaeaea',
  },
};

/** 从实际容器读取应用主题；仅更新显示颜色，返回监听清理函数，不重建终端。 */
export function observeTerminalTheme(terminal: Terminal, host: HTMLElement): () => void {
  /** 系统变化与显式主题切换使用同一个更新入口。 */
  const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
  /** 背景、文字及光标直接采用共享终端容器的计算颜色。 */
  function applyTheme(): void {
    /** 读取 CSS 已解析的颜色，避免维护另一套明暗判定。 */
    const colors = getComputedStyle(host);
    terminal.options.theme = { ...terminalDisplayOptions.theme, background: colors.backgroundColor, foreground: colors.color, cursor: colors.color, cursorAccent: colors.backgroundColor };
  }
  /** 根节点和工作台的主题标记都可能变化。 */
  const observer = new MutationObserver(applyTheme);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-zeus-theme'] });
  /** 终端位于真实工作台内部，主题类从最近的工作台读取。 */
  const shell = host.closest('.zeus-shell');
  if (shell) observer.observe(shell, { attributes: true, attributeFilter: ['class'] });
  systemTheme.addEventListener('change', applyTheme);
  applyTheme();
  return () => {
    observer.disconnect();
    systemTheme.removeEventListener('change', applyTheme);
  };
}
