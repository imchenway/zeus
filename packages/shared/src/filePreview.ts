/** 文件内容的展示方式，与模型附件上传能力独立。 */
export type FilePreviewKind = 'text' | 'image' | 'pdf' | 'audio' | 'video' | 'system' | 'unavailable';

/** 渲染层只提供业务身份，不允许自行指定仓库根或历史对象。 */
export type FilePreviewRequest =
  | { kind: 'source'; projectId: string; path: string }
  | { kind: 'task-git'; taskId: string; workspaceId: string; path: string; scope: 'working' | 'committed' }
  | { kind: 'project-git'; projectId: string; repositoryId: string; path: string; stage?: 'combined' | 'staged' | 'unstaged'; commitHash?: string; comparisonRef?: string; comparisonMode?: 'current' | 'working-tree' }
  | { kind: 'resource'; projectId: string; conversationId: string; resourceId: string }
  | { kind: 'turn'; projectId: string; conversationId: string; turnId: string; changeSetId: string; fileId: string }
  | { kind: 'attachment'; localPath?: string; uploadRef?: string };

/** 仅供受信主进程使用的读取授权，不向渲染层返回文件系统权限。 */
export interface FilePreviewSource {
  /** 展示名称保留原始扩展名。 */
  name: string;
  /** 明确区分工作区、索引与历史内容。 */
  label: string;
  /** 由业务身份解析出的授权根。 */
  root?: string;
  /** 根下文件或已验证的快照路径。 */
  path?: string;
  /** 历史 Git 内容只使用解析后的对象哈希。 */
  blob?: string;
  /** 轮次快照的内容摘要，读取时再次验证。 */
  sha256?: string;
  /** 已知不存在与历史缺失都明确说明。 */
  reason?: string;
}

/** 一次预览可包含当前文件或准确的变更前后两端。 */
export interface FilePreviewIntent {
  /** 读取来源由后端授权生成。 */
  sides: FilePreviewSource[];
}

/** 单个预览资源；令牌只能用于所属窗口且关闭后撤销。 */
export interface FilePreviewItem {
  /** 主进程生成的不可猜测资源身份。 */
  id: string;
  /** 原始文件名。 */
  name: string;
  /** 内容来源标签。 */
  label: string;
  /** 统一展示种类。 */
  kind: FilePreviewKind;
  /** 受限媒体类型。 */
  mime: string;
  /** 原文件字节数。 */
  byteLength: number;
  /** 短期、只读、受授权的资源地址。 */
  url?: string;
  /** 小文本及 SVG 源码；不包含任意二进制内容。 */
  content?: string;
  /** 可理解的失败原因。 */
  reason?: string;
}

/** 页内文本与图片沿用小内容限制，媒体使用流式读取。 */
export const filePreviewLimits = { text: 2 * 1024 * 1024, image: 16 * 1024 * 1024, historical: 512 * 1024 * 1024 } as const;

/** 浏览器原生支持的安全媒体类型；未知格式交由系统查看。 */
const previewMimeTypes: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
  gz: 'application/gzip',
  '7z': 'application/x-7z-compressed',
  rar: 'application/vnd.rar',
  icns: 'image/icns',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  ogv: 'video/ogg',
};

/** 扩展名仅决定候选解码器，文本仍需严格验证编码和二进制内容。 */
export function filePreviewMime(name: string): string {
  return previewMimeTypes[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';
}

/** 可视媒体优先于文本，SVG 不作为活动 HTML 文档执行。 */
export function filePreviewKind(mime: string): FilePreviewKind {
  return mime === 'image/icns' ? 'system' : mime.startsWith('image/') ? 'image' : mime === 'application/pdf' ? 'pdf' : mime.startsWith('audio/') ? 'audio' : mime.startsWith('video/') ? 'video' : 'system';
}
