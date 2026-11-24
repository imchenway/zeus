import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { IntegrationApiClient } from './features/integrations/integrationApiClient.js';
import type { ModelConnectionAppearance } from './features/integrations/integrationContracts.js';
import { modelProviderAppearanceChangedEvent } from './features/integrations/modelCatalogEvents.js';
import { CachedQuery } from './cachedQuery.js';
import { loadWebsiteModelConnectionIcon, readCachedWebsiteModelConnectionIcon } from './settings/modelConnectionIcon.js';

/** 内置品牌图案已去除外围留白，彩色品牌保留素材原色。 */
const brands = new Map<string, { name: string; url: string; monochrome?: boolean }>([
  ['codex', { name: 'Codex', url: new URL('./assets/model-providers/openai-compact.svg', import.meta.url).href, monochrome: true }],
  ['copilot', { name: 'GitHub Copilot', url: new URL('./assets/model-providers/copilot.svg', import.meta.url).href, monochrome: true }],
  ['antigravity', { name: 'Google Antigravity', url: new URL('./assets/model-providers/antigravity.svg', import.meta.url).href }],
  ['deepseek', { name: 'DeepSeek', url: new URL('./assets/model-providers/deepseek-color.svg', import.meta.url).href }],
  ['bailian', { name: '阿里云百炼', url: new URL('./assets/model-providers/bailian-color.svg', import.meta.url).href }],
  ['kilo', { name: 'Kilo', url: new URL('./assets/model-providers/kilocode.svg', import.meta.url).href, monochrome: true }],
  ['kimi', { name: 'Kimi', url: new URL('./assets/model-providers/kimi-color.svg', import.meta.url).href }],
  ['zai', { name: 'Z.ai', url: new URL('./assets/model-providers/zai.svg', import.meta.url).href, monochrome: true }],
]);

/** 将就绪的网站图标并入外观，手动上传字段仍只代表用户的选择。 */
type ModelProviderAppearance = ModelConnectionAppearance & { websiteIconDataUrl?: string };
/** 连接外观按持久身份索引，供 HTML 和原生菜单共用。 */
type ModelProviderAppearances = ReadonlyMap<string, ModelProviderAppearance>;
/** 冷加载或独立窗口缺少目录时使用同一空视图。 */
const emptyAppearances: ModelProviderAppearances = new Map();
/** 原生菜单可等待同一在途读取，行内图标只消费已完成的值。 */
const appearances = createContext<{ items: ModelProviderAppearances; query: CachedQuery<ModelProviderAppearances> | null }>({ items: emptyAppearances, query: null });

/** 后台读取外观，配置保存或其他窗口修改后刷新；旧请求不能覆盖新配置。 */
export function ModelProviderAppearanceScope({ client, children }: { client: Pick<IntegrationApiClient, 'loadModelConnectionAppearances' | 'loadModelConnectionWebsiteIcon'>; children: ReactNode }) {
  /** 半分钟缓存合并首屏读取与原生菜单首次打开。 */
  const query = useMemo(() => new CachedQuery<ModelProviderAppearances>(async () => new Map((await client.loadModelConnectionAppearances()).map((item) => [item.id, item])), 30_000), [client]);
  const { value } = useSyncExternalStore(query.subscribe, query.getSnapshot, query.getSnapshot);
  /** 站点结果独立更新，获取网站图标时列表、选择器和原生菜单可以先显示。 */
  const [websiteIcons, setWebsiteIcons] = useState<ReadonlyMap<string, string>>(() => new Map());
  const items = useMemo(() => {
    if (!value || !websiteIcons.size) return value ?? emptyAppearances;
    return new Map(
      Array.from(value, ([id, item]) => {
        const websiteIconDataUrl = item.websiteIconOrigin && websiteIcons.get(item.websiteIconOrigin);
        return [id, websiteIconDataUrl ? { ...item, websiteIconDataUrl } : item] as const;
      }),
    );
  }, [value, websiteIcons]);
  const context = useMemo(() => ({ items, query }), [items, query]);
  useEffect(() => {
    if (!value) return;
    let active = true;
    for (const item of value.values()) {
      const origin = item.websiteIconOrigin;
      if (!origin) continue;
      void loadWebsiteModelConnectionIcon(origin, (faviconOnly) => client.loadModelConnectionWebsiteIcon(item.id, faviconOnly)).then((png) => {
        if (active && png) setWebsiteIcons((current) => (current.get(origin) === png ? current : new Map(current).set(origin, png)));
      });
    }
    return () => {
      active = false;
    };
  }, [client, value]);
  useEffect(() => {
    /** 外观只影响展示，读取失败时沿用上次成功状态。 */
    const refresh = () => {
      void query.load(true).catch(() => undefined);
    };
    /** 已保存的外观改动撤销旧请求的回写资格。 */
    const invalidate = () => {
      query.invalidate();
      refresh();
    };
    /** 跨窗口只刷新外观修订，避免响应无关的本机设置。 */
    const storageChanged = (event: StorageEvent) => {
      if (event.key === modelProviderAppearanceChangedEvent) invalidate();
    };
    refresh();
    window.addEventListener(modelProviderAppearanceChangedEvent, invalidate);
    window.addEventListener('storage', storageChanged);
    window.addEventListener('focus', refresh);
    return () => {
      window.removeEventListener(modelProviderAppearanceChangedEvent, invalidate);
      window.removeEventListener('storage', storageChanged);
      window.removeEventListener('focus', refresh);
    };
  }, [query]);
  return <appearances.Provider value={context}>{children}</appearances.Provider>;
}

/** 图标旁的提示和独立用量窗口可复用当前供应商名称与本地图片。 */
export function useModelProviderAppearances(): ModelProviderAppearances {
  return useContext(appearances).items;
}

/** 原生菜单打开时复用应用的供应商目录读取。 */
export function useModelProviderAppearanceQuery(): CachedQuery<ModelProviderAppearances> | null {
  return useContext(appearances).query;
}

/** 内置订阅没有连接配置时，仍可展示它的完整来源名称。 */
export function builtinModelProviderName(sourceId: string | null | undefined): string | undefined {
  return brands.get(sourceId ?? '')?.name;
}

/** 同一外观也可以直接来自设置草稿或原生用量载荷。 */
type ModelProviderBadgeProps = { sourceId?: string | null; sourceName?: string | null; templateId?: string; iconDataUrl?: string | null };

/** 上传、内置品牌、站点及字母回退的顺序由原生菜单和行内组件共用。 */
function modelProviderVisual(props: ModelProviderBadgeProps, appearance?: ModelProviderAppearance) {
  const template = props.templateId ?? appearance?.templateId;
  const brandId = template ?? props.sourceId ?? '';
  const brand = brands.get(brandId);
  const custom = props.iconDataUrl === undefined ? appearance?.iconDataUrl : props.iconDataUrl;
  const images = [custom, brand?.url, template === 'custom' ? appearance?.websiteIconDataUrl : undefined];
  const name = props.sourceName?.trim() || appearance?.name || brand?.name || '';
  const initial = name.match(/[\p{L}\p{N}]/u)?.[0]?.toLocaleUpperCase() ?? '·';
  return { brandId, brand, images, initial };
}

/** 安装源与自定义连接以 sourceId 识别，模板只决定它的默认品牌图标。 */
export function ModelProviderBadge(props: ModelProviderBadgeProps) {
  const appearance = useModelProviderAppearances().get(props.sourceId ?? '');
  const [failedImages, setFailedImages] = useState<ReadonlySet<string>>(() => new Set());
  const { brandId, brand, images, initial } = modelProviderVisual(props, appearance);
  const image = images.find((candidate) => candidate && !failedImages.has(candidate));
  return (
    <span
      className="model-provider-badge"
      data-initial={image ? undefined : true}
      data-brand={image && image === brand?.url ? brandId : undefined}
      data-monochrome={image && image === brand?.url && brand?.monochrome ? true : undefined}
      aria-hidden="true"
    >
      {image ? <img src={image} alt="" draggable={false} onError={() => setFailedImages((failed) => new Set(failed).add(image))} /> : initial}
    </span>
  );
}

/** 原生菜单使用 16 点图标，交换时用 2 倍的 PNG 保持高清。 */
const menuIconPixels = 32;

/** 在可信应用 Renderer 中绘制 PNG，网页标签始终无法接触本地供应商外观。 */
export async function modelProviderMenuIcons(items: ModelProviderAppearances): Promise<Record<string, string>> {
  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const style = getComputedStyle(document.querySelector('.macos-ai-app') ?? document.documentElement);
  const primary = style.getPropertyValue('--zeus-brand-primary').trim() || '#6155d8';
  const text = style.getPropertyValue('--zeus-brand-text').trim() || primary;
  const sources = new Map<string, ModelProviderAppearance | undefined>([['codex', undefined], ...items]);
  const icons = await Promise.all(
    [...sources].map(async ([sourceId, appearance]) => {
      const visual = modelProviderVisual({ sourceId }, appearance && { ...appearance, websiteIconDataUrl: readCachedWebsiteModelConnectionIcon(appearance.websiteIconOrigin) });
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = menuIconPixels;
      const context = canvas.getContext('2d');
      if (!context) return null;
      for (const url of visual.images) {
        if (!url) continue;
        try {
          const image = new Image();
          image.src = url;
          await image.decode();
          const ratio = menuIconPixels / Math.max(image.naturalWidth, image.naturalHeight);
          const width = image.naturalWidth * ratio;
          const height = image.naturalHeight * ratio;
          if (dark && url === visual.brand?.url && visual.brand?.monochrome) context.filter = 'invert(1)';
          context.drawImage(image, (menuIconPixels - width) / 2, (menuIconPixels - height) / 2, width, height);
          return [sourceId, canvas.toDataURL('image/png')] as const;
        } catch {
          // 清除无效内容和颜色滤镜，继续尝试下一个图标。
          canvas.width = menuIconPixels;
        }
      }
      /** 字母底色用品牌色透明度匹配系统菜单表面。 */
      const center = menuIconPixels / 2;
      context.globalAlpha = 0.14;
      context.fillStyle = primary;
      context.beginPath();
      context.arc(center, center, center, 0, Math.PI * 2);
      context.fill();
      context.globalAlpha = 1;
      context.fillStyle = text;
      context.font = `620 ${menuIconPixels * 0.67}px system-ui`;
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillText(visual.initial, center, center, menuIconPixels - 4);
      return [sourceId, canvas.toDataURL('image/png')] as const;
    }),
  );
  return Object.fromEntries(icons.filter((icon) => icon !== null));
}
