import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';

/** CI 与 Release 正文使用的官方分发目录，与客户端可信来源保持一致。 */
export const releaseCdnBaseUrl = 'https://zeus-download.hyphatech.cn/zeus';

/** CDN 清单保留候选身份、摘要、签名和平台，只替换安装包的传输地址。 */
export function cdnReleaseManifest(manifest) {
  requiredVersion(manifest.version);
  return {
    ...manifest,
    artifacts: manifest.artifacts.map((artifact) => ({ ...artifact, downloadUrl: `${releaseCdnBaseUrl}/releases/${manifest.version}/${encodeURIComponent(artifact.fileName)}` })),
  };
}

/** 从公开固定版本地址回读小型清单，确认 CDN 实际提供的是本次候选。 */
export async function verifyPublicCdnManifest(manifest, fileName, request = fetch, latest = false) {
  /** GitHub 和 CDN 清单必须由同一候选生成，不能只比较版本号。 */
  const expected = `${JSON.stringify(cdnReleaseManifest(manifest), null, 2)}\n`;
  /** 发布验收同时读取稳定指针，避免只上传固定文件便误报更新已生效。 */
  const url = latest ? `${releaseCdnBaseUrl}/updates/${fileName}` : `${releaseCdnBaseUrl}/releases/${manifest.version}/${fileName}`;
  /** 限制连接与正文读取总时间，避免阻塞发布验收。 */
  const response = await request(url, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`CDN 公开清单不可用：HTTP ${response.status}，${fileName}`);
  /** 清单只能是小型 JSON，安装包不能误传到清单地址。 */
  const content = await response.text();
  if (content.length > 1024 * 1024 || sha256Text(content) !== sha256Text(expected)) throw new Error(`CDN 公开清单与固定候选不一致：${fileName}`);
}

/** 为正文增加当前正式支持平台的固定版本下载链接，重复执行不追加重复区块。 */
export function renderCdnReleaseNotes(markdown, version) {
  requiredVersion(version);
  /** 仅替换本函数拥有的生成区块，保留发布说明其余文字。 */
  const content = markdown.replace(/\r\n/gu, '\n').replace(/\n?<!-- zeus-cdn-downloads -->[\s\S]*?<!-- \/zeus-cdn-downloads -->\n?/u, '');
  /** 原有验收要求版本标题仍位于正文首行。 */
  const title = `# Zeus ${version} 更新内容`;
  if (!content.startsWith(`${title}\n`)) throw new Error('CDN 下载链接不能加入版本标题不匹配的 Release notes。');
  /** 三个名称对应主发布流程实际生成的 macOS 与 Windows 安装包。 */
  const downloads = [
    ['macOS Apple Silicon', `Zeus-${version}-arm64.dmg`],
    ['Windows x64', `Zeus-${version}-win32-x64.exe`],
    ['Windows ARM64', `Zeus-${version}-win32-arm64.exe`],
  ];
  /** 版本固定在 URL 路径中，长期缓存不会混用不同安装包。 */
  const links = downloads.map(([label, fileName]) => `- [${label}](${releaseCdnBaseUrl}/releases/${version}/${fileName})`).join('\n');
  return `${title}\n\n<!-- zeus-cdn-downloads -->\n## CDN 加速下载\n\n${links}\n<!-- /zeus-cdn-downloads -->\n\n${content.slice(title.length).trimStart()}`;
}
export function requiredVersion(rawValue, name = 'RELEASE_VERSION') {
  const version = rawValue?.trim() ?? '';
  if (!/^\d+\.\d+\.\d+$/u.test(version)) throw new Error(`${name} 为必填稳定版本号，例如 0.1.10。`);
  return version;
}

export function parseBoolean(name, rawValue, defaultValue) {
  if (rawValue === undefined || rawValue.trim() === '') return defaultValue;
  const normalized = rawValue.trim().toLocaleLowerCase();
  if (['1', 'true', 'yes'].includes(normalized)) return true;
  if (['0', 'false', 'no'].includes(normalized)) return false;
  throw new Error(`${name} 必须是布尔值；当前值为 ${rawValue}。`);
}

/** 只接受官方稳定标签，并要求目标版本递增。 */
export function assertVersionAfterTag(version, tag, suffix = '') {
  if (!/^v\d+\.\d+\.\d+$/u.test(tag)) throw new Error(`无效的 Zeus 稳定版本标签：${tag}`);
  const target = version.split('.').map(Number);
  const base = tag.slice(1).split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (target[index] > base[index]) return;
    if (target[index] < base[index]) break;
  }
  throw new Error(`目标版本 ${version} 必须高于最新稳定标签 ${tag}${suffix}`);
}

export function validateReleaseNotes(markdown, version) {
  const requiredTitle = `# Zeus ${version} 更新内容`;
  if (!markdown.startsWith(`${requiredTitle}\n`)) throw new Error(`Release notes 标题必须是：${requiredTitle}`);
  for (const heading of ['## 如何升级', '## 系统要求与已知限制', '## 发布验证']) {
    if (!markdown.includes(`\n${heading}\n`)) throw new Error(`Release notes 缺少必要章节：${heading}`);
  }
  if (!markdown.includes('brew upgrade --cask imchenway/tap/zeus')) throw new Error('Release notes 缺少 Homebrew 升级命令。');
  if (!markdown.includes(`Zeus-${version}-arm64.dmg`)) throw new Error(`Release notes 缺少版本化 DMG 名称：Zeus-${version}-arm64.dmg。`);
  if (/releases\/v[^\s]+\.md|TASK_\d+/u.test(markdown)) throw new Error('Release notes 泄漏内部任务或发布文档路径。');
  const leakedCommentary = markdown.match(/用户要求只返回|confidence\s*[=:：]|uncertainties\s*[=:：]|以下无其他字段|最终正文如上/iu)?.[0];
  if (leakedCommentary) throw new Error(`Release notes 混入生成过程说明“${leakedCommentary}”。`);
  const draftOnlyPublicationState = markdown.match(/本次发布前需完成以下验证流程|将由\s*(?:Release Workflow|发布流程)|发布流程将在草稿通过后执行|尚未发生/iu)?.[0];
  if (draftOnlyPublicationState) throw new Error(`Release notes 包含只在草稿阶段成立的表述“${draftOnlyPublicationState}”。`);
  if (/对\s*DMG\s*进行开发者签名和 Apple 公证/iu.test(markdown)) throw new Error('Release notes 无条件承诺 Developer ID 签名与 Apple 公证。');
}

export function validateReleaseNotesFile(path, version) {
  if (!existsSync(path) || statSync(path).size === 0) throw new Error(`缺少已审阅的 Release notes：${path}`);
  validateReleaseNotes(readFileSync(path, 'utf8'), version);
}

export function sha256Text(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function sha256File(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}
