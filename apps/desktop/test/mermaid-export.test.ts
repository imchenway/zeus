import { describe, expect, it } from 'vitest';
import { exportMermaidDiagramToFile } from '../src/main/mermaidExport.js';

describe('Electron Mermaid diagram export file bridge', () => {
  it('writes a source-backed Mermaid diagram to a user-selected .mmd file', async () => {
    const writes: Array<{ path: string; content: string }> = [];
    const result = await exportMermaidDiagramToFile({
      payload: {
        fileName: 'api_sequence-接口-时序图-2026-06-14T03-11-00-000Z.mmd',
        mimeType: 'text/vnd.mermaid',
        content: '%% Zeus Mermaid export\nsequenceDiagram\n  %% source: src/api.ts',
      },
      chooseFile: async () => ({
        canceled: false,
        filePath: '/Users/david/Desktop/api_sequence.mmd',
      }),
      writeTextFile: async (path, content) => {
        writes.push({ path, content });
      },
    });

    expect(result).toEqual({
      saved: true,
      filePath: '/Users/david/Desktop/api_sequence.mmd',
    });
    expect(writes).toEqual([
      {
        path: '/Users/david/Desktop/api_sequence.mmd',
        content: '%% Zeus Mermaid export\nsequenceDiagram\n  %% source: src/api.ts',
      },
    ]);
  });

  it('rejects non-Mermaid or unsourced payloads before writing files', async () => {
    await expect(
      exportMermaidDiagramToFile({
        payload: {
          fileName: 'unsafe.txt',
          mimeType: 'text/plain',
          content: 'flowchart LR',
        },
        chooseFile: async () => ({
          canceled: false,
          filePath: '/Users/david/Desktop/unsafe.txt',
        }),
        writeTextFile: async () => {},
      }),
    ).rejects.toThrow('Zeus Mermaid export requires sourced text/vnd.mermaid .mmd payload');
  });
});
