import { net, session } from 'electron';
import { parseZentaoTaskUrl, zentaoTaskType, type ZentaoInstanceRecord, type ZentaoLinkKind, type ZentaoTaskExtract } from '@zeus/shared';
import { browserPartition } from './browserHost.js';
import { attemptZentaoRestDetail } from './zentaoApi.js';

const ZENTAO_FETCH_TIMEOUT_MS = 12_000;
const ZENTAO_HTML_CHAR_LIMIT = 3 * 1024 * 1024;
const ZENTAO_TITLE_CHAR_LIMIT = 200;
const ZENTAO_BODY_CHAR_LIMIT = 8_000;
const ZENTAO_FIELD_CHAR_LIMIT = 4_000;

/** 详情页正文区常用字段标签；同时用作段落截断边界，避免把评论与历史记录写进任务草稿。 */
const ZENTAO_SECTION_LABELS = [
  '相关任务',
  '相关需求',
  '相关缺陷',
  '关联任务',
  '关联需求',
  '关联缺陷',
  '由谁创建',
  '创建时间',
  '抄送',
  '附件',
  '历史记录',
  '变更记录',
  '动态',
  '评论',
  '操作记录',
  '生命周期',
  '严重程度',
  '优先级',
  '缺陷类型',
  '类型',
  '状态',
  '指派给',
  '解决方案',
  '关键词',
  '版本',
  '计划',
  '模块',
  '影响版本',
  '所属项目',
  '所属产品',
  '重现步骤',
  '复现步骤',
  '期望结果',
  '预期结果',
  '缺陷现象',
  '缺陷摘要',
  'Bug描述',
  '缺陷描述',
  '需求描述',
  '任务描述',
  '验收标准',
  '描述',
  '禅道项目管理软件',
  'ZenTao',
] as const;

/** 正文尾部标签：只用于兜底正文截断，不参与字段定位。 */
const ZENTAO_TAIL_LABELS = [
  '历史记录',
  '变更记录',
  '动态',
  '评论',
  '操作记录',
  '生命周期',
  '附件',
  '禅道项目管理软件',
  'ZenTao',
  '相关任务',
  '相关需求',
  '相关缺陷',
  '关联任务',
  '关联需求',
  '关联缺陷',
  '抄送',
  '关键词',
  '由谁创建',
  '创建时间',
] as const;

type ZentaoPageFetch = { kind: 'page'; html: string; finalUrl: string } | { kind: 'error'; reason: string };

export interface ZentaoExtractServices {
  loadInstances?: () => Promise<ZentaoInstanceRecord[]>;
  readPassword?: (instanceId: string) => Promise<string | undefined>;
}

/** 解析用户粘贴的禅道详情页链接，抓取页面并提取可填入 Zeus 任务表单的字段。 */
export async function extractZentaoTaskInfo(rawUrl: string, services?: ZentaoExtractServices): Promise<ZentaoTaskExtract> {
  const link = parseZentaoTaskUrl(rawUrl);
  if (link.kind !== 'zentao') return { kind: 'unsupported', sourceUrl: rawUrl };

  // REST 优先：按链接 origin 匹配已配置实例，账号密码齐备时走 /api.php/v1。
  const instance = await resolveZentaoInstance(link.url, services);
  let credentialAttempt: 'none' | 'missing' | 'failed' = 'none';
  if (instance?.account) {
    const password = services?.readPassword ? await services.readPassword(instance.id) : undefined;
    if (password) {
      const attempt = await attemptZentaoRestDetail({ host: instance.host, basePath: instance.basePath, account: instance.account, password }, link.zentaoKind, link.objectId);
      if (attempt.kind === 'ok') {
        const restExtract = buildZentaoRestExtract(link, attempt.payload);
        if (restExtract) return restExtract;
      } else if (attempt.kind === 'auth_failed') {
        credentialAttempt = 'failed';
      }
    } else {
      credentialAttempt = 'missing';
    }
  }

  // 回退现有 HTML 抓取；实例已配置但凭据缺失或失效时给出可区分的失败原因。
  let page = await fetchZentaoPage(link.url, 'default');
  if (page.kind === 'error') return { kind: 'failed', sourceUrl: link.url, reason: page.reason };
  if (isZentaoLoginPage(page)) {
    // 用户在 Zeus 内置浏览器登录过禅道时，复用该会话 cookie 再试一次。
    const browserSessionPage = await fetchZentaoPage(link.url, 'zeus-browser');
    if (browserSessionPage.kind === 'error') return { kind: 'failed', sourceUrl: link.url, reason: browserSessionPage.reason };
    if (isZentaoLoginPage(browserSessionPage)) {
      if (credentialAttempt === 'missing') return { kind: 'failed', sourceUrl: link.url, reason: 'credential_missing', cause: 'credential_missing' };
      if (credentialAttempt === 'failed') return { kind: 'failed', sourceUrl: link.url, reason: 'auth_failed', cause: 'auth_failed' };
      return { kind: 'login_required', zentaoKind: link.zentaoKind, objectId: link.objectId, sourceUrl: link.url };
    }
    page = browserSessionPage;
  }

  const title = normalizeZentaoTitle(readZentaoPageTitle(page.html), link.zentaoKind, link.objectId);
  const body = flattenZentaoPageText(page.html).slice(0, ZENTAO_BODY_CHAR_LIMIT);
  const mainContent = cutZentaoMainContent(body);

  if (link.zentaoKind === 'bug') {
    const currentState = firstNonEmpty(extractZentaoLabeledSection(body, ['缺陷现象', '缺陷摘要', 'Bug描述', '缺陷描述']));
    const reproductionSteps = firstNonEmpty(extractZentaoLabeledSection(body, ['重现步骤', '复现步骤']), currentState ? '' : mainContent);
    const expectedOutcome = extractZentaoLabeledSection(body, ['期望结果', '预期结果']);
    return {
      kind: 'ok',
      zentaoKind: 'bug',
      objectId: link.objectId,
      taskType: 'defect',
      title,
      description: '',
      currentState,
      reproductionSteps,
      expectedOutcome,
      sourceUrl: link.url,
    };
  }

  const description = firstNonEmpty(extractZentaoLabeledSection(body, link.zentaoKind === 'story' ? ['需求描述', '验收标准'] : ['任务描述']), extractZentaoLabeledSection(body, ['描述']), mainContent);
  return {
    kind: 'ok',
    zentaoKind: link.zentaoKind,
    objectId: link.objectId,
    taskType: zentaoTaskType(link.zentaoKind),
    title,
    description,
    currentState: '',
    reproductionSteps: '',
    expectedOutcome: '',
    sourceUrl: link.url,
  };
}

async function resolveZentaoInstance(rawUrl: string, services?: ZentaoExtractServices): Promise<ZentaoInstanceRecord | undefined> {
  if (!services?.loadInstances) return undefined;
  let origin: string;
  try {
    origin = new URL(rawUrl).origin;
  } catch {
    return undefined;
  }
  const instances = await services.loadInstances();
  return instances.find((candidate) => candidate.host.toLowerCase() === origin.toLowerCase());
}

/** 将 REST 详情映射为与 HTML 抓取一致的字段；内容不可用时返回 null 以便回退。 */
function buildZentaoRestExtract(link: Extract<ReturnType<typeof parseZentaoTaskUrl>, { kind: 'zentao' }>, payload: Record<string, unknown>): ZentaoTaskExtract | null {
  const readText = (key: string): string => (typeof payload[key] === 'string' ? payload[key] : '');
  const rawTitle = readText('title');
  const title = normalizeZentaoTitle(rawTitle, link.zentaoKind, link.objectId);
  const description = stripZentaoRichText(readText(link.zentaoKind === 'bug' ? '' : link.zentaoKind === 'story' ? 'spec' : 'desc'));
  const fallbackDescription = stripZentaoRichText(link.zentaoKind === 'story' ? readText('verify') : '');
  const mergedDescription = firstNonEmpty(description, fallbackDescription).slice(0, ZENTAO_BODY_CHAR_LIMIT);

  if (link.zentaoKind === 'bug') {
    const stepsBody = stripZentaoRichText(readText('steps')).slice(0, ZENTAO_BODY_CHAR_LIMIT);
    const sections = splitZentaoStepsSections(stepsBody);
    const reproductionSteps = (sections.steps || (!sections.result && !sections.expected ? stepsBody : '')).slice(0, ZENTAO_FIELD_CHAR_LIMIT);
    const currentState = sections.result.slice(0, ZENTAO_FIELD_CHAR_LIMIT);
    const expectedOutcome = sections.expected.slice(0, ZENTAO_FIELD_CHAR_LIMIT);
    if (!title && !reproductionSteps && !currentState && !expectedOutcome) return null;
    return {
      kind: 'ok',
      zentaoKind: 'bug',
      objectId: link.objectId,
      taskType: 'defect',
      title,
      description: '',
      currentState,
      reproductionSteps,
      expectedOutcome,
      sourceUrl: link.url,
    };
  }

  if (!title && !mergedDescription) return null;
  return {
    kind: 'ok',
    zentaoKind: link.zentaoKind,
    objectId: link.objectId,
    taskType: zentaoTaskType(link.zentaoKind),
    title,
    description: mergedDescription,
    currentState: '',
    reproductionSteps: '',
    expectedOutcome: '',
    sourceUrl: link.url,
  };
}

function stripZentaoRichText(value: string): string {
  if (!value) return '';
  return flattenZentaoPageText(value);
}

/** 缺陷 steps 形如 [步骤]...[结果]...[期望]；无标记时整体归入重现步骤。 */
function splitZentaoStepsSections(body: string): { steps: string; result: string; expected: string } {
  const markers = ['[步骤]', '[结果]', '[期望]', '[预期]'] as const;
  const positions: Array<{ index: number; contentStart: number; marker: string }> = [];
  for (const marker of markers) {
    const pattern = new RegExp(`(^|\\n)\\s*${escapeZentaoRegExp(marker)}\\s*[:：]?`, 'gu');
    for (const match of body.matchAll(pattern)) {
      const start = match.index ?? 0;
      if (positions.every((position) => position.index !== start)) positions.push({ index: start, contentStart: start + match[0].length, marker });
    }
  }
  positions.sort((left, right) => left.index - right.index);
  const sectionFor = (marker: string): string => {
    const current = positions.find((position) => position.marker === marker);
    if (!current) return '';
    const end = positions.find((position) => position.index > current.index)?.index ?? body.length;
    return body.slice(current.contentStart, end).trim();
  };
  return {
    steps: sectionFor('[步骤]'),
    result: sectionFor('[结果]'),
    expected: firstNonEmpty(sectionFor('[期望]'), sectionFor('[预期]')),
  };
}

async function fetchZentaoPage(url: string, mode: 'default' | 'zeus-browser'): Promise<ZentaoPageFetch> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ZENTAO_FETCH_TIMEOUT_MS);
  try {
    const requester: typeof net.fetch = mode === 'zeus-browser' ? (input, init) => session.fromPartition(browserPartition, { cache: true }).fetch(input, init) : (input, init) => net.fetch(input, init);
    const response = await requester(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Zeus/1.0 Safari/537.36',
      },
    });
    const finalUrl = response.url || url;
    // 401/403 页面仍可能是禅道登录页，交给登录检测统一判定；其余错误码直接失败。
    if (!response.ok && response.status !== 401 && response.status !== 403) {
      return { kind: 'error', reason: `http_${response.status}` };
    }
    const text = await response.text();
    return { kind: 'page', html: text.slice(0, ZENTAO_HTML_CHAR_LIMIT), finalUrl };
  } catch (error) {
    const reason = error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'fetch_failed';
    return { kind: 'error', reason };
  } finally {
    clearTimeout(timer);
  }
}

function isZentaoLoginPage(page: { html: string; finalUrl: string }): boolean {
  const normalizedUrl = page.finalUrl.toLowerCase();
  if (normalizedUrl.includes('user-login') || normalizedUrl.includes('m=user&f=login')) return true;
  const probe = page.html.slice(0, 200_000);
  if (probe.includes('id="userLogin"') || probe.includes("id='userLogin'")) return true;
  return probe.includes('name="account"') && probe.includes('name="password"') && /login|登录/iu.test(probe);
}

function readZentaoPageTitle(html: string): string {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/iu.exec(html);
  if (!match) return '';
  return decodeZentaoHtmlEntities(
    match[1]
      .replace(/<[^>]+>/gu, '')
      .replace(/\s+/gu, ' ')
      .trim(),
  );
}

function normalizeZentaoTitle(rawTitle: string, zentaoKind: ZentaoLinkKind, objectId: string): string {
  let title = rawTitle.trim();
  if (!title) return '';
  const siteTail = /\s*[-–—·]\s*[^-–—·]+\s*[-–—·]\s*(禅道|ZenTao|zentao|Zentao)\s*$/iu;
  const simpleTail = /\s*[-–—·]\s*(禅道|ZenTao|zentao|Zentao)\s*$/iu;
  if (siteTail.test(title)) title = title.replace(siteTail, '').trim();
  else if (simpleTail.test(title)) title = title.replace(simpleTail, '').trim();
  const marker = new RegExp(`^(BUG|STORY|TASK|缺陷|需求|任务)\\s*#?\\s*${escapeZentaoRegExp(objectId)}\\s*[:：\\s\\-–—]*`, 'iu');
  title = title.replace(marker, '').trim();
  return (title || rawTitle.trim()).slice(0, ZENTAO_TITLE_CHAR_LIMIT);
}

function flattenZentaoPageText(html: string): string {
  const withoutBlocks = html
    .replace(/<head[\s\S]*?<\/head>/giu, ' ')
    .replace(/<script[\s\S]*?<\/script>/giu, ' ')
    .replace(/<style[\s\S]*?<\/style>/giu, ' ')
    .replace(/<!--[\s\S]*?-->/gu, ' ')
    .replace(/<br\s*\/?>/giu, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table|section|ul|ol|pre|td|th)>/giu, '\n')
    .replace(/<[^>]+>/gu, ' ');
  return decodeZentaoHtmlEntities(withoutBlocks)
    .replace(/[ \t\u00a0]+/gu, ' ')
    .replace(/ *\n */gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

function extractZentaoLabeledSection(body: string, startLabels: readonly string[]): string {
  for (const label of startLabels) {
    const startPattern = new RegExp(`(^|\\n)\\s*${escapeZentaoRegExp(label)}\\s*[:：]?\\s*`, 'u');
    const startMatch = startPattern.exec(body);
    if (!startMatch) continue;
    const start = startMatch.index + startMatch[0].length;
    let end = body.length;
    for (const stopLabel of ZENTAO_SECTION_LABELS) {
      const stopPattern = new RegExp(`(^|\\n)\\s*${escapeZentaoRegExp(stopLabel)}\\s*[:：]?`, 'u');
      const stopMatch = stopPattern.exec(body.slice(start));
      if (stopMatch) end = Math.min(end, start + stopMatch.index);
    }
    const section = body.slice(start, end).trim();
    if (section) return section.slice(0, ZENTAO_FIELD_CHAR_LIMIT);
  }
  return '';
}

function cutZentaoMainContent(body: string): string {
  let end = body.length;
  for (const tailLabel of ZENTAO_TAIL_LABELS) {
    const tailPattern = new RegExp(`(^|\\n)\\s*${escapeZentaoRegExp(tailLabel)}\\s*[:：]?`, 'u');
    const tailMatch = tailPattern.exec(body);
    if (tailMatch) end = Math.min(end, tailMatch.index);
  }
  return body.slice(0, end).trim().slice(0, ZENTAO_FIELD_CHAR_LIMIT);
}

function firstNonEmpty(...values: string[]): string {
  for (const value of values) {
    if (value.trim()) return value;
  }
  return '';
}

function decodeZentaoHtmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/giu, (_match, hex: string) => zentaoCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/gu, (_match, dec: string) => zentaoCodePoint(Number.parseInt(dec, 10)))
    .replace(/&nbsp;/giu, ' ')
    .replace(/&amp;/giu, '&')
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/&quot;/giu, '"')
    .replace(/&apos;|&#39;/giu, "'");
}

function zentaoCodePoint(code: number): string {
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
}

function escapeZentaoRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
