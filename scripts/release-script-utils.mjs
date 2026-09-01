import {createHash} from 'node:crypto';
import {createReadStream, existsSync, readFileSync, statSync} from 'node:fs';

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

export function assertVersionAfterTag(version, tag, suffix = '') {
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
    if (/docs\/releases\/v[^\s]+\.md|TASK_\d+/u.test(markdown)) throw new Error('Release notes 泄漏内部任务或发布文档路径。');
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
