/** 网页翻译的单次正文上限，单位为 UTF-16 字符；控制延迟和服务用量。 */
export const browserTranslationBatchCharacters = 10_000;
/** 单次最多翻译的片段数，长段落可由页面拆分后重组。 */
export const browserTranslationBatchSize = 12;
/** 各服务共用的单片段上限，单位为 UTF-16 字符；适配公共翻译接口。 */
export const browserTranslationFragmentCharacters = 4000;
/** 免费服务身份不占用 Codex 或自定义模型的目录命名空间。 */
export type FreeBrowserTranslationService = 'free:google' | 'free:microsoft';
/** 未选择服务时直接使用免账号的微软翻译。 */
export const defaultBrowserTranslationService: FreeBrowserTranslationService = 'free:microsoft';

/** 只有已实现的公共接口可以进入免凭据调用路径。 */
export function isFreeBrowserTranslationService(value: string): value is FreeBrowserTranslationService {
  return value === 'free:google' || value === 'free:microsoft';
}

/** 原文与译文使用相同身份，模型不能改变网页定位。 */
export interface BrowserTranslationSegment {
  /** 当前文档内的片段身份，不包含网址或页面选择器。 */
  id: string;
  /** 只发送可阅读正文，返回值也只能按纯文本显示。 */
  text: string;
}

/** 翻译模型只公开目录身份和显示名称，凭据留在 Core。 */
export interface BrowserTranslationModel {
  /** 沿用现有模型目录的完整身份。 */
  id: string;
  /** 供应商和模型的组合名称。 */
  label: string;
  /** 供应商的显示名称，用于模型分组。 */
  sourceName: string;
  /** 模型原始名称，用于搜索和稳定排序。 */
  model: string;
  /** 模型的显示名称。 */
  displayName: string;
}

/** 网页宿主与 Core 共用片段校验，避免无界正文或重复身份。 */
export function validBrowserTranslationSegments(value: unknown): value is BrowserTranslationSegment[] {
  if (!Array.isArray(value) || !value.length || value.length > browserTranslationBatchSize) return false;
  /** 累计实际字符串长度，而不是依赖页面提供的统计。 */
  let characters = 0;
  /** 重复身份无法可靠地把译文放回原段落。 */
  const ids = new Set<string>();
  return value.every((entry) => {
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/u.test(entry.id) || ids.has(entry.id)) return false;
    if (typeof entry.text !== 'string' || !entry.text.trim() || entry.text.length > browserTranslationFragmentCharacters) return false;
    ids.add(entry.id);
    characters += entry.text.length;
    return characters <= browserTranslationBatchCharacters;
  });
}
