import type { ModelConnectionRecord } from '@zeus/ai-runtime';
import { isKiloConnection } from './kiloAccountUsage.js';
import { readPublicHttpResource } from './modelPricingDocument.js';

/** 自定义连接按站点共用默认图标，Kilo 的品牌网站与 API 网关分离。 */
export function modelConnectionWebsiteIconOrigin(connection: ModelConnectionRecord): string | undefined {
  if (connection.templateId !== 'custom' || connection.iconDataUrl) return undefined;
  return isKiloConnection(connection) ? 'https://kilo.ai' : new URL(connection.baseUrl).origin;
}

/** 只读静态站点声明，跳过注释和脚本内容。 */
function declaredWebsiteIcons(html: string, page: URL): string[] {
  const tags = /<!--[\s\S]*?-->|<(script|style|title|template)\b[^>]*>[\s\S]*?<\/\1\s*>|<(link|base)\b((?:[^<>"']|"[^"]*"|'[^']*')*)>/giu;
  const attribute = /\s+([^\s"'<>/=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>]+))/gu;
  const hrefs: string[] = [];
  let base: URL | null = null;
  // 标签图标声明位于页面头部，正文不参与候选匹配。
  const head = html.split(/<\/head\s*>|<body[\s>]/iu, 1)[0] ?? '';
  for (const match of head.matchAll(tags)) {
    const tag = match[2]?.toLowerCase();
    if (!tag || !match[3]) continue;
    const attrs = Object.fromEntries(Array.from(match[3].matchAll(attribute), ([, key, doubleQuoted, singleQuoted, unquoted]) => [key!.toLowerCase(), doubleQuoted ?? singleQuoted ?? unquoted ?? '']));
    const href = attrs.href?.trim().replace(/&amp;/giu, '&');
    if (!href) continue;
    if (tag === 'base') base ??= URL.parse(href, page);
    if (tag === 'link' && attrs.rel?.toLowerCase().split(/\s+/u).includes('icon')) hrefs.push(href);
    // 常见站点会声明多个尺寸，最多探测前四个以限制每站请求。
    if (hrefs.length === 4) break;
  }
  return hrefs.flatMap((href) => {
    const url = URL.parse(href, base ?? page);
    if (url?.protocol !== 'http:' && url?.protocol !== 'https:') return [];
    url.hash = '';
    return [url.href];
  });
}

/** 部分服务器把 ICO 当作通用二进制发送，用文件头识别常见格式。 */
function websiteIconContentType(contentType: string, bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0]))) return 'image/x-icon';
  if (bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return 'image/png';
  return /^image\/(?:png|jpeg|webp|avif|gif|svg\+xml|x-icon|vnd\.microsoft\.icon|ico)$/u.test(contentType) ? contentType : undefined;
}

/** 无凭据地读取浏览器标签图标，返回有界的图片数据供桌面解码。 */
export async function readModelConnectionWebsiteIcon(origin: string, faviconOnly = false): Promise<string | null> {
  const signal = AbortSignal.timeout(6_000);
  const label = '供应商网站';
  const page = faviconOnly ? null : await readPublicHttpResource(origin, { signal, label, accept: 'text/html,application/xhtml+xml' }).catch(() => null);
  const links = page && /^(?:text\/html|application\/xhtml\+xml)$/u.test(page.contentType) ? declaredWebsiteIcons(page.body.toString('utf8'), page.url) : [];
  const candidates = new Set([...links, new URL('/favicon.ico', page?.url ?? origin).href, new URL('/favicon.ico', origin).href]);
  for (const url of candidates) {
    if (signal.aborted) break;
    const icon = await readPublicHttpResource(url, { signal, label, accept: 'image/*', maxBytes: 256_000 }).catch(() => null);
    if (!icon?.body.length) continue;
    const contentType = websiteIconContentType(icon.contentType, icon.body);
    if (contentType) return 'data:' + contentType + ';base64,' + icon.body.toString('base64');
  }
  return null;
}
