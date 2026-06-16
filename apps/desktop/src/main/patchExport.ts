export interface PatchSaveDialogResult {
  canceled: boolean;
  filePath?: string;
}

export interface PatchPayload {
  fileName: string;
  mimeType: string;
  patchText: string;
}

export interface ExportPatchToFileInput {
  patch: PatchPayload;
  chooseFile: () => Promise<PatchSaveDialogResult>;
  writeTextFile: (path: string, content: string) => Promise<void>;
}

export interface ExportPatchToFileResult {
  saved: boolean;
  filePath: string | null;
}

/** 将只读 Git diff patch 保存到用户选择的文件；不执行任何 git apply。 */
export async function exportPatchToFile(input: ExportPatchToFileInput): Promise<ExportPatchToFileResult> {
  if (input.patch.mimeType !== 'text/x-patch' || !input.patch.fileName.endsWith('.patch')) {
    throw new Error('Zeus patch export requires text/x-patch content');
  }
  const target = await input.chooseFile();
  if (target.canceled || !target.filePath) return { saved: false, filePath: null };
  await input.writeTextFile(target.filePath, input.patch.patchText);
  return { saved: true, filePath: target.filePath };
}
