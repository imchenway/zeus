import type { ModelConnectionWebsiteIcon } from '../features/integrations/integrationContracts.js';

/** 站点图标与用户手动上传的连接图标独立存储。 */
const websiteIconStoragePrefix = 'zeus.model-provider-website-icon:';
/** 同站点的请求与内存回退共用一份记录，失败后最早在 30 秒后重新尝试。 */
const websiteIconReads = new Map<string, { retryAt: number; value: Promise<string | null>; png?: string }>();

/** 原生菜单只读取已经就绪的 PNG，打开菜单时无需等待网站。 */
export function readCachedWebsiteModelConnectionIcon(origin: string | undefined): string | undefined {
  if (!origin) return undefined;
  const ready = websiteIconReads.get(origin)?.png;
  if (ready) return ready;
  try {
    const cached = window.localStorage.getItem(websiteIconStoragePrefix + origin);
    if (cached?.startsWith('data:image/png;base64,') && cached.length <= 33_000) return cached;
  } catch {
    // 存储不可用时由常规加载流程获取图标。
  }
  return undefined;
}

/** 已缓存的站点 PNG 只按协议、主机和端口复用。 */
export function loadWebsiteModelConnectionIcon(origin: string, download: (faviconOnly?: boolean) => Promise<ModelConnectionWebsiteIcon | null>): Promise<string | null> {
  const cached = readCachedWebsiteModelConnectionIcon(origin);
  if (cached) return Promise.resolve(cached);
  const existing = websiteIconReads.get(origin);
  if (existing && existing.retryAt > Date.now()) return existing.value;
  const value = Promise.resolve()
    .then(async () => {
      const result = await download();
      if (result?.origin !== origin || !result.dataUrl) return null;
      try {
        return await readWebsiteModelConnectionIcon(result.dataUrl);
      } catch {
        const fallback = await download(true);
        return fallback?.origin === origin && fallback.dataUrl ? readWebsiteModelConnectionIcon(fallback.dataUrl) : null;
      }
    })
    .then((png) => {
      if (png) {
        try {
          window.localStorage.setItem(websiteIconStoragePrefix + origin, png);
        } catch {
          // 图标已经解码，存储失败时仍可在本窗口显示。
        }
      }
      return png;
    })
    .catch(() => null)
    .then((png) => {
      if (png) entry.png = png;
      else entry.retryAt = Date.now() + 30_000;
      return png;
    });
  const entry: { retryAt: number; value: Promise<string | null>; png?: string } = { retryAt: Infinity, value };
  websiteIconReads.set(origin, entry);
  return value;
}

/** 本地上传仅接受设置页声明的图片格式。 */
export async function readModelConnectionIcon(file: File): Promise<string> {
  if (file.size > 1024 * 1024 || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('Unsupported provider icon');
  const image = await createImageBitmap(file);
  try {
    return renderIconPng(image, image.width, image.height);
  } finally {
    image.close();
  }
}

/** 使用浏览器的图片解码器处理 ICO、SVG 等网页标签图标。 */
async function readWebsiteModelConnectionIcon(dataUrl: string): Promise<string> {
  const image = new Image();
  image.src = dataUrl;
  await image.decode();
  return renderIconPng(image, image.naturalWidth, image.naturalHeight);
}

/** 裁去透明边缘，将解码后的图片统一为最长边不超过 64 像素的静态 PNG。 */
function renderIconPng(image: CanvasImageSource, imageWidth: number, imageHeight: number): string {
  const sample = document.createElement('canvas');
  // 统一采样尺寸，限制扫描透明像素的开销。
  const ratio = Math.min(1, 128 / Math.max(imageWidth, imageHeight));
  sample.width = Math.max(1, Math.round(imageWidth * ratio));
  sample.height = Math.max(1, Math.round(imageHeight * ratio));
  const context = sample.getContext('2d');
  if (!context) throw new Error('Provider icon canvas unavailable');
  context.drawImage(image, 0, 0, sample.width, sample.height);
  const { data } = context.getImageData(0, 0, sample.width, sample.height);
  let left = sample.width;
  let top = sample.height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < sample.height; y += 1) {
    for (let x = 0; x < sample.width; x += 1) {
      if (data[(y * sample.width + x) * 4 + 3]! < 16) continue;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  }
  if (right < 0) throw new Error('Empty provider icon');
  const width = right - left + 1;
  const height = bottom - top + 1;
  const scale = Math.min(1, 64 / Math.max(width, height));
  const output = document.createElement('canvas');
  output.width = Math.max(1, Math.round(width * scale));
  output.height = Math.max(1, Math.round(height * scale));
  const outputContext = output.getContext('2d');
  if (!outputContext) throw new Error('Provider icon canvas unavailable');
  outputContext.drawImage(sample, left, top, width, height, 0, 0, output.width, output.height);
  return output.toDataURL('image/png');
}
