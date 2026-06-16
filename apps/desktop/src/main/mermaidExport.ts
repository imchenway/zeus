export interface MermaidSaveDialogResult {
  canceled: boolean;
  filePath?: string;
}

export interface MermaidDiagramExportPayload {
  fileName: string;
  mimeType: string;
  content: string;
}

export interface ExportMermaidDiagramToFileInput {
  payload: MermaidDiagramExportPayload;
  chooseFile: () => Promise<MermaidSaveDialogResult>;
  writeTextFile: (path: string, content: string) => Promise<void>;
}

export interface ExportMermaidDiagramToFileResult {
  saved: boolean;
  filePath: string | null;
}

/** 将由真实图谱来源生成的 Mermaid 文本保存为 .mmd 文件；不生成假节点或假边。 */
export async function exportMermaidDiagramToFile(input: ExportMermaidDiagramToFileInput): Promise<ExportMermaidDiagramToFileResult> {
  if (input.payload.mimeType !== 'text/vnd.mermaid' || !input.payload.fileName.endsWith('.mmd') || !input.payload.content.includes('%% Zeus Mermaid export')) {
    throw new Error('Zeus Mermaid export requires sourced text/vnd.mermaid .mmd payload');
  }
  const target = await input.chooseFile();
  if (target.canceled || !target.filePath) return { saved: false, filePath: null };
  await input.writeTextFile(target.filePath, input.payload.content);
  return { saved: true, filePath: target.filePath };
}
