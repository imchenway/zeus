import type { ConversationFileLocation } from './conversationResources.js';

/** 文件审阅沿用 Git 差异视图的行结构。 */
export interface FileReviewDiff {
  /** 变更前后的仓库相对路径。 */
  oldPath: string;
  newPath: string;
  /** Git 识别的变更种类与增删统计。 */
  changeType: 'added' | 'deleted' | 'modified' | 'renamed' | 'copied';
  addedLines: number;
  deletedLines: number;
  /** 原始行号与补丁片段，由受信后端解析。 */
  hunks: Array<{
    header: string;
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    lines: Array<{ type: 'context' | 'addition' | 'deletion' | 'metadata'; content: string; oldLineNumber: number | null; newLineNumber: number | null }>;
  }>;
}

/** 差异行的提交归属；零哈希表示尚未提交，不生成作者占位文案。 */
export interface FilePreviewBlameLine {
  /** 完整提交哈希。 */
  commitHash: string;
  /** 光标行详情使用的短提交号。 */
  shortHash: string;
  /** Git 记录的作者姓名。 */
  author: string;
  /** 作者时间，Unix 秒。 */
  authorTime: number;
  /** 光标行显示的提交说明。 */
  subject: string;
  /** 对应当前版本的原始行号。 */
  line: number;
}

/** 源码与通用文件审阅共用位置和当前 Git 状态。 */
export interface FileReview {
  /** 当前磁盘文件的真实状态；补丁新增不等于已暂存，忽略和未修改也不伪装为新增。 */
  status?: FileReviewDiff['changeType'] | 'untracked' | 'conflict' | 'other' | 'unchanged' | 'ignored';
  /** 会话引用的原始位置。 */
  location?: ConversationFileLocation;
  /** null 表示仓库内没有差异；非仓库或忽略文件不提供比较。 */
  diff?: FileReviewDiff | null;
  /** Git 读取失败仍允许阅读源码，并明确展示原因。 */
  error?: string;
}

/** 文件内容的展示方式，与模型附件上传能力独立。 */
export type FilePreviewKind = 'text' | 'image' | 'pdf' | 'audio' | 'video' | 'system' | 'unavailable';

/** 只读预览允许的编码；显式选择不改变原文件或编辑器保存编码。 */
export const filePreviewTextEncodings = ['utf-8', 'utf-16le', 'utf-16be', 'gb18030', 'windows-1252'] as const;
/** 编码名称直接交给平台文本解码器，不接受任意解码配置。 */
export type FilePreviewTextEncoding = (typeof filePreviewTextEncodings)[number];

/** 渲染层只提供业务身份，不允许自行指定仓库根或历史对象。 */
export type FilePreviewRequest = (
  | { kind: 'source'; projectId: string; path: string }
  | { kind: 'task-git'; taskId: string; workspaceId: string; path: string; scope: 'working' | 'committed' }
  | { kind: 'project-git'; projectId: string; repositoryId: string; path: string; stage?: 'combined' | 'staged' | 'unstaged'; commitHash?: string; comparisonRef?: string; comparisonMode?: 'current' | 'working-tree' }
  | { kind: 'resource'; projectId: string; conversationId: string; resourceId: string; comparison?: 'head' }
  | { kind: 'turn'; projectId: string; conversationId: string; turnId: string; changeSetId: string; fileId: string }
  | { kind: 'attachment'; localPath?: string; uploadRef?: string }
) & {
  /** 用户明确选择的只读解码方式；缺省仅识别 UTF BOM 与严格 UTF-8。 */
  textEncoding?: FilePreviewTextEncoding;
};

/** 仅供受信主进程使用的读取授权，不向渲染层返回文件系统权限。 */
export interface FilePreviewSource {
  /** 逐行归属绑定仓库路径和固定提交；无 ref 时以本次预览内容计算未提交行。 */
  git?: { root: string; path: string; ref?: string; baseRef?: string };
  /** 编辑目标由宿主解析；历史副本与快照目录不能成为编辑目标。 */
  edit?: { root: string; path: string };
  /** 确认不存在的一侧可作为空文件；其他读取失败不得冒充空文件。 */
  missing?: boolean;
  /** 会话文件的行定位与 Git 差异。 */
  review?: FileReview;
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
  /** 当前文本可按同次预览的旧侧恢复区块；历史副本和只读编码不提供此能力。 */
  canRevert?: boolean;
  /** 当前预览就是可写工作区正文，历史快照不授予此能力。 */
  canEditInline?: boolean;
  /** 与本次完整文本对应的逐行提交归属。 */
  blame?: FilePreviewBlameLine[];
  /** 归属读取失败不妨碍查看正文，但必须明确显示原因。 */
  blameError?: string;
  /** 对应工作区的当前文件已通过读取校验，可进入源码编辑。 */
  canEdit?: boolean;
  /** 确认不存在的一侧与普通读取错误分开处理。 */
  missing?: boolean;
  /** 随授权内容返回审阅信息，不扩大文件读取权限。 */
  review?: FileReview;
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
  /** 真实使用的只读解码方式，便于用户检查乱码。 */
  encoding?: FilePreviewTextEncoding;
  /** 大文件只读取前段，不将截断文本作为可编辑正文。 */
  truncated?: boolean;
  /** 可理解的失败原因。 */
  reason?: string;
}

/** 区块坐标使用两端原文件的零基行边界，不包含显示补位和折叠行。 */
export interface FilePreviewChangeRange {
  /** 旧侧起始行及行数；纯新增的旧侧行数为零。 */
  oldStart: number;
  oldLines: number;
  /** 当前侧起始行及行数；纯删除的当前侧行数为零。 */
  newStart: number;
  newLines: number;
}

/** 撤销只传窗口持有的版本令牌和区块边界，不接受路径或替换正文。 */
export interface FilePreviewRevertInput extends FilePreviewChangeRange {
  /** 同一次加载的旧版和工作区版本。 */
  beforeId: string;
  afterId: string;
}

/** 原生源码页只接收主进程固定的工作区身份，页面不能自行指定目录。 */
export interface FilePreviewSourceWorkspace {
  /** 业务项目保留导航身份，工作树目录另由临时作用域绑定。 */
  ownerProjectId: string;
  /** 临时作用域身份只在所属窗口内有效。 */
  project: { id: string; name: string; localPath: string };
  /** 第一次打开的工作区相对文件路径。 */
  relativePath: string;
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
  heic: 'image/heic',
  heif: 'image/heif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
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

/** 只读文本严格解码；UTF-16 仅按 BOM 或用户选择读取，不猜测二进制编码。 */
export function decodeFilePreviewText(bytes: Uint8Array, requested?: FilePreviewTextEncoding, truncated = false): { content: string; encoding: FilePreviewTextEncoding } {
  if (requested !== undefined && !filePreviewTextEncodings.includes(requested)) throw new Error('不支持的预览编码。');
  /** 未明确选择时，只将确定的 BOM 用于自动识别。 */
  const encoding = requested ?? (bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8');
  /** 片段末尾允许未读完的多字节字符；片段内部仍严格校验。 */
  const content = new TextDecoder(encoding, { fatal: true }).decode(bytes, { stream: truncated });
  if (content.includes('\0')) throw new Error('此文件包含二进制内容。');
  return { content, encoding };
}

/** 页内编辑仅提交授权令牌和完整正文，不能改变写入路径。 */
export interface FilePreviewSaveInput {
  /** 当前工作区预览的版本令牌。 */
  id: string;
  /** 完整 UTF-8 正文，换行和 BOM 由源码保存服务保留。 */
  content: string;
}
