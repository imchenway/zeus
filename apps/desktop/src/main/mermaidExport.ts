export interface DiagramSaveDialogResult {
  canceled: boolean;
  filePath?: string;
}

export interface DiagramSourceExportPayload {
  fileName: string;
  mimeType: string;
  content: string;
}

export interface DiagramSourceExportFormat {
  label: string;
  mimeType: string;
  extension: string;
  sourceMarker: string;
}

export interface ExportDiagramSourceToFileInput {
  payload: DiagramSourceExportPayload;
  format: DiagramSourceExportFormat;
  chooseFile: () => Promise<DiagramSaveDialogResult>;
  writeTextFile: (path: string, content: string) => Promise<void>;
}

export interface ExportDiagramSourceToFileResult {
  saved: boolean;
  filePath: string | null;
}

export type MermaidSaveDialogResult = DiagramSaveDialogResult;
export type MermaidDiagramExportPayload = DiagramSourceExportPayload;

export type ExportMermaidDiagramToFileInput = Omit<ExportDiagramSourceToFileInput, 'format'>;
export type ExportPlantUmlDiagramToFileInput = Omit<ExportDiagramSourceToFileInput, 'format'>;
export type ExportMermaidDiagramToFileResult = ExportDiagramSourceToFileResult;
export type ExportPlantUmlDiagramToFileResult = ExportDiagramSourceToFileResult;

const mermaidExportFormat: DiagramSourceExportFormat = {
  label: 'Mermaid',
  mimeType: 'text/vnd.mermaid',
  extension: '.mmd',
  sourceMarker: '%% Zeus Mermaid export',
};

const plantUmlExportFormat: DiagramSourceExportFormat = {
  label: 'PlantUML',
  mimeType: 'text/vnd.plantuml',
  extension: '.puml',
  sourceMarker: "' Zeus PlantUML export",
};

/** 按图谱格式校验并保存源码文件；只接受 Zeus 从真实图谱事实生成的带来源标记文本。 */
export async function exportDiagramSourceToFile(input: ExportDiagramSourceToFileInput): Promise<ExportDiagramSourceToFileResult> {
  if (input.payload.mimeType !== input.format.mimeType || !input.payload.fileName.endsWith(input.format.extension) || !input.payload.content.includes(input.format.sourceMarker)) {
    throw new Error(`Zeus ${input.format.label} export requires sourced ${input.format.mimeType} ${input.format.extension} payload`);
  }
  const target = await input.chooseFile();
  if (target.canceled || !target.filePath) return { saved: false, filePath: null };
  await input.writeTextFile(target.filePath, input.payload.content);
  return { saved: true, filePath: target.filePath };
}

/** 将由真实图谱来源生成的 Mermaid 文本保存为 .mmd 文件；不生成假节点或假边。 */
export async function exportMermaidDiagramToFile(input: ExportMermaidDiagramToFileInput): Promise<ExportMermaidDiagramToFileResult> {
  return exportDiagramSourceToFile({
    ...input,
    format: mermaidExportFormat,
  });
}

/** 将由真实图谱来源生成的 PlantUML 文本保存为 .puml 文件；用于交给成熟 UML 工具链继续处理。 */
export async function exportPlantUmlDiagramToFile(input: ExportPlantUmlDiagramToFileInput): Promise<ExportPlantUmlDiagramToFileResult> {
  return exportDiagramSourceToFile({
    ...input,
    format: plantUmlExportFormat,
  });
}
