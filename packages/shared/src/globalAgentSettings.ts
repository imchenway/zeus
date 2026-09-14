/** 全局规则的磁盘身份；缺失文件的摘要为 null。 */
export interface GlobalAgentSettingsMetadata {
  /** 当前 Zeus 实际使用的固定文件路径。 */
  path: string;
  /** 文件是否已创建。 */
  exists: boolean;
  /** 原始 UTF-8 内容的 SHA-256 摘要。 */
  revision: string | null;
}

/** 读取返回正文，保存回执只保留元信息。 */
export interface GlobalAgentSettingsSnapshot extends GlobalAgentSettingsMetadata {
  /** 保留空白和换行的完整正文。 */
  content: string;
}

/** 手动保存携带读取基线，阻止覆盖外部修改。 */
export interface SaveGlobalAgentSettingsInput {
  /** 待保存正文，允许为空。 */
  content: string;
  /** 开始编辑时的摘要，未创建时为 null。 */
  baseRevision: string | null;
}
