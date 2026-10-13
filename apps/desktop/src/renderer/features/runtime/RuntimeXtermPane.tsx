import { useEffect, useRef } from 'react';
import type { AiRuntimeLogEntry } from './runtimeContracts.js';
import { observeTerminalTheme, terminalDisplayOptions } from './terminalPresentation.js';

/** 只展示已采集的运行日志，离开时释放终端。 */
export function RuntimeXtermPane(props: { logs: AiRuntimeLogEntry[]; enabled: boolean; ariaLabel: string }) {
  const terminalRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!props.enabled || !terminalRef.current || typeof window === 'undefined') return;
    let disposed = false;
    let terminal: import('@xterm/xterm').Terminal | undefined;
    /** 日志终端与交互终端共用主题，退出时释放同一组监听。 */
    let disposeTheme: (() => void) | undefined;
    void import('@xterm/xterm').then(({ Terminal }) => {
      if (disposed || !terminalRef.current) return;
      // xterm 只负责渲染已采集的真实 Runtime 日志；输入、resize、Ctrl-C 仍走后端受控 API。
      terminal = new Terminal({
        ...terminalDisplayOptions,
        convertEol: true,
        cursorBlink: false,
        disableStdin: true,
        rows: 10,
        cols: 120,
      });
      terminal.open(terminalRef.current);
      disposeTheme = observeTerminalTheme(terminal, terminalRef.current);
      for (const entry of props.logs.slice(-80)) {
        if (entry.stream === 'system') terminal.write(`\r\n${entry.text}\r\n`);
        else terminal.write(entry.text.replace(/\n/gu, '\r\n'));
      }
    });
    return () => {
      disposed = true;
      disposeTheme?.();
      terminal?.dispose();
    };
  }, [props.enabled, props.logs]);

  if (!props.enabled) return null;
  return <div className="xterm-runtime-pane" aria-label={props.ariaLabel} ref={terminalRef} />;
}
