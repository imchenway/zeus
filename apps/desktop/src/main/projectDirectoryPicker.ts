export interface DirectoryPickerResult {
  canceled: boolean;
  filePaths: string[];
}

export type DirectoryPicker = () => Promise<DirectoryPickerResult>;

/** 选择真实本地代码库目录；取消时返回 null，不制造默认项目路径。 */
export async function chooseProjectDirectory(picker: DirectoryPicker): Promise<string | null> {
  const result = await picker();
  if (result.canceled) return null;
  return result.filePaths[0] ?? null;
}
