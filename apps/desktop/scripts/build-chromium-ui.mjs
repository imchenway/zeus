#!/usr/bin/env node
import { build } from 'vite';
import { readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { readDesktopBridgeContract } from './desktop-bridge-contract.mjs';
import { browserOsUpstream } from '../browseros/upstream.mjs';

/** 桌面项目根目录；与当前工作目录无关。 */
const desktopRoot = resolve(import.meta.dirname, '..');
/** 独立的 WebUI 资源目录，不覆盖当前 Electron 安装产物。 */
const outputRoot = join(desktopRoot, 'dist', 'chromium-ui');
/** 隔离的临时构建目录，完整生成资源后才替换正式输出。 */
const stagingRoot = join(desktopRoot, 'dist', 'chromium-ui-staging');

// 复用现有 Vite 配置，在专用目录构建同一界面，避免混入 tsc 留下的声明和未打包模块。
await rm(stagingRoot, { recursive: true, force: true });
await build({
  configFile: join(desktopRoot, 'vite.config.ts'),
  root: desktopRoot,
  logLevel: 'warn',
  build: { outDir: stagingRoot, emptyOutDir: true },
});
/** 既有 HTML 的模块入口必须唯一，避免错误地省略或重复执行脚本。 */
const rendererHtml = await readFile(join(stagingRoot, 'index.html'), 'utf8');
/** Vite 生成的入口标签；资源路径只允许当前产物中的相对脚本。 */
const scriptTags = [...rendererHtml.matchAll(/<script\b[^>]*\btype="module"[^>]*>\s*<\/script>/gu)];
if (scriptTags.length !== 1) throw new Error('Chromium WebUI 构建要求现有界面只有一个模块入口。');
/** 保留原始入口以便在桥初始化后加载。 */
const scriptTag = scriptTags[0][0];
/** 构建产物的脚本地址，不接受 URL、绝对路径或目录穿越。 */
const rendererEntry = /\bsrc="(\.?\/assets\/[A-Za-z0-9_.-]+\.js)"/u.exec(scriptTag)?.[1];
if (!rendererEntry) throw new Error('无法确定 Chromium WebUI 对应的 Zeus 界面入口。');

await build({
  configFile: false,
  logLevel: 'warn',
  define: { __ZEUS_RENDERER_ENTRY__: JSON.stringify(rendererEntry.startsWith('./') ? rendererEntry : `.${rendererEntry}`) },
  build: {
    lib: { entry: join(desktopRoot, 'src', 'preload', 'chromium.ts'), formats: ['es'], fileName: () => 'chromium-desktop.js' },
    outDir: stagingRoot,
    emptyOutDir: false,
    target: 'es2022',
    minify: false,
    sourcemap: false,
    rolldownOptions: { external: ['chrome://resources/js/cr.js'] },
  },
});

/** WebUI 只额外允许 Chromium 自带的可信 JS 模块，不开放任意网络脚本。 */
const html = rendererHtml.replace(scriptTag, '<script type="module" src="./chromium-desktop.js"></script>').replace("script-src 'self';", "script-src 'self' chrome://resources;");
await writeFile(join(stagingRoot, 'index.html'), html);
// 该清单只声明当前界面使用哪些通道；原生宿主必须逐条实现，不能据此宣告能力可用。
/** 原生处理器与界面资源从同一份实际接口提取允许通道。 */
const desktopContract = await readDesktopBridgeContract(desktopRoot);
await writeFile(join(stagingRoot, 'desktop-bridge-contract.json'), `${JSON.stringify(desktopContract, null, 2)}\n`);
// 界面资源明确记录目标上游，原生构建不能混用另一修订的桥或资料格式。
await writeFile(join(stagingRoot, 'browseros-upstream.json'), `${JSON.stringify(browserOsUpstream, null, 2)}\n`);

/** 遍历本次产物，拒绝符号链接，保证资源清单只指向构建目录。 */
async function listResources(directory, prefix = '') {
  /** 当前层资源和子目录。 */
  const entries = await readdir(directory, { withFileTypes: true });
  /** 返回值始终使用 URL 风格的相对路径，Windows 与 macOS 一致。 */
  const paths = [];
  for (const entry of entries) {
    /** 当前资源相对于输出目录的地址。 */
    const path = `${prefix}${entry.name}`;
    if (entry.isDirectory()) paths.push(...(await listResources(join(directory, entry.name), `${path}/`)));
    else if (entry.isFile()) paths.push(path);
    else throw new Error(`WebUI 资源不是普通文件：${path}`);
  }
  return paths.sort();
}

/** 转义生成的 XML 属性，不把资源文件名当作标记。 */
function xmlAttribute(value) {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** 按路径排序，使同一输入得到相同资源清单和 GRIT 声明。 */
const paths = await listResources(stagingRoot);
/** 包含资源字节数及摘要的清单；只描述界面资源，不声明原生能力已具备。 */
const resources = [];
for (const path of paths) {
  /** 单个资源内容只用于计算交付完整性。 */
  const bytes = await readFile(join(stagingRoot, path));
  resources.push({ path, byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
}
/** 路径哈希用于生成稳定的 C++ 标识，不受目录遍历顺序影响。 */
const resourceId = (path) => `IDR_ZEUS_${createHash('sha256').update(path).digest('hex').slice(0, 24).toUpperCase()}`;
/** GRIT 可直接消费的资源描述，原生目标仍需显式声明资源 ID 分配。 */
const grd = `<?xml version="1.0" encoding="UTF-8"?>
<grit latest_public_release="0" current_release="1">
  <outputs>
    <output filename="grit/zeus_resources.h" type="rc_header" />
    <output filename="zeus_resources.pak" type="data_package" />
  </outputs>
  <release seq="1">
    <includes>
${paths.map((path) => `      <include name="${resourceId(path)}" file="${xmlAttribute(path)}" type="BINDATA" compress="gzip" />`).join('\n')}
    </includes>
  </release>
</grit>
`;
await writeFile(join(stagingRoot, 'zeus_resources.grd'), grd);
/** 原生 WebUIDataSource 可使用的路径映射；不包含任何业务凭据。 */
const mapping = `// 现有 Zeus 界面在 Chromium WebUI 内的静态资源映射。\n#pragma once\n#include "chrome/grit/zeus_resources.h"\n#include "ui/base/webui/resource_path.h"\n\n// 路径只来自本次完整构建产物。\ninline constexpr webui::ResourcePath kZeusResources[] = {\n${paths.map((path) => `  {${JSON.stringify(path)}, ${resourceId(path)}, std::nullopt},`).join('\n')}\n};\n\n// 默认页面与当前 React 构建入口保持一致。\ninline constexpr int kZeusDefaultResource = ${resourceId('index.html')};\n`;
await writeFile(join(stagingRoot, 'zeus_resources_map.h'), mapping);
/** 从真实通道表生成 C++ 白名单，不在原生实现中手抄第二份列表。 */
const channelHeader = `// 桌面通道来自共用 API 与启动报告器。\n#pragma once\n#include <string_view>\n\nnamespace zeus {\n${Object.entries(desktopContract.channels)
  .map(
    ([kind, channels]) =>
      `// ${kind === 'invoke' ? '有响应请求' : kind === 'send' ? '单向通知' : '业务事件'}允许的通道名称。\ninline constexpr std::string_view kZeus${kind[0].toUpperCase()}${kind.slice(1)}Channels[] = {\n${channels.map((channel) => `  ${JSON.stringify(channel)},`).join('\n')}\n};`,
  )
  .join('\n\n')}\n}  // namespace zeus\n`;
await writeFile(join(stagingRoot, 'zeus_desktop_contract.h'), channelHeader);
/** 原生响应头必须与页面 meta 使用同一份 CSP，不能只依赖 HTML 限制。 */
const cspValue = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/u.exec(html)?.[1];
if (!cspValue) throw new Error('Chromium WebUI 入口缺少明确的内容安全策略。');
/** 只接受当前界面使用的 CSP 指令；新增指令需要明确原生枚举映射。 */
const cspNames = {
  'default-src': 'DefaultSrc',
  'script-src': 'ScriptSrc',
  'style-src': 'StyleSrc',
  'img-src': 'ImgSrc',
  'media-src': 'MediaSrc',
  'frame-src': 'FrameSrc',
  'font-src': 'FontSrc',
  'connect-src': 'ConnectSrc',
  'object-src': 'ObjectSrc',
  'base-uri': 'BaseURI',
  'frame-ancestors': 'FrameAncestors',
};
/** 单一策略逐项转成原生头，保留所有已有来源限制。 */
const directives = cspValue
  .split(';')
  .map((value) => value.trim())
  .filter(Boolean)
  .map((value) => {
    /** 指令名用于匹配 Chromium CSP 枚举。 */
    const name = value.split(/\s+/u)[0];
    if (!Object.hasOwn(cspNames, name)) throw new Error(`尚未映射的原生 CSP 指令：${name}`);
    return `  {network::mojom::CSPDirectiveName::${cspNames[name]}, ${JSON.stringify(`${value};`)}},`;
  });
/** 页面策略只影响 Zeus 可信界面，不修改浏览器普通网页的策略。 */
const cspHeader = `// 从现有 Zeus 页面生成的原生内容安全策略。\n#pragma once\n#include "services/network/public/mojom/content_security_policy.mojom.h"\n\n// 一个 CSP 指令及其完整响应头值。\nstruct ZeusCspDirective {\n  // Chromium 原生指令身份。\n  network::mojom::CSPDirectiveName name;\n  // 包含指令名与分号的来源限制。\n  const char* value;\n};\n\n// 同一策略同时用于 HTML 和原生响应头。\ninline constexpr ZeusCspDirective kZeusContentSecurityPolicy[] = {\n${directives.join('\n')}\n};\n`;
await writeFile(join(stagingRoot, 'zeus_csp.h'), cspHeader);
await writeFile(join(stagingRoot, 'zeus_resource_files.gni'), `# 本次界面构建的资源输入，文件变化会触发 GRIT 重新编译。\nzeus_resource_files = [\n${paths.map((path) => `  ${JSON.stringify(`resources/${path}`)},`).join('\n')}\n]\n`);
/** 原生元数据与可见资源分别校验，C++ 头不作为网页资源暴露。 */
const nativeFiles = [];
for (const path of ['zeus_resources.grd', 'zeus_resources_map.h', 'zeus_desktop_contract.h', 'zeus_csp.h', 'zeus_resource_files.gni']) {
  /** 原生构建输入的实际字节及摘要。 */
  const bytes = await readFile(join(stagingRoot, path));
  nativeFiles.push({ path, byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
}
await writeFile(join(stagingRoot, 'resource-manifest.json'), `${JSON.stringify({ artifactKind: 'chromium-webui-resources', rendererEntry, resources, nativeFiles }, null, 2)}\n`);

// 只在完整资源清单生成后替换输出；这里不把资源包标记为可运行的 Chromium 产品。
await rm(outputRoot, { recursive: true, force: true });
await rename(stagingRoot, outputRoot);
console.log(`已生成 Chromium WebUI 资源：${resources.length} 个文件。原生宿主构建与能力验证单独执行。`);
