import { BrowserWindow, net, screen, session } from 'electron';
import { parseThirdPartyTaskUrl, type ThirdPartyTaskExtract, type ThirdPartyTaskLink } from '@zeus/shared';
import { browserPartition } from './browserHost.js';
import { readBoundedZentaoResponse } from './zentaoApi.js';
import { extractZentaoTaskInfo, type ZentaoExtractServices } from './zentaoTaskExtract.js';

/** 单次读取的时限与正文大小上限，避免第三方页面长时间阻塞草稿。 */
const fetchTimeoutMs = 12_000;
/** GitHub 页面含预加载数据，比接口正文更大；达到上限时整体报错而非截断任务。 */
const responseBytesLimit = 4 * 1024 * 1024;

/** 统一读取结果，保留状态码供权限、限流和内容错误分别展示。 */
type SourceResponse = { status: number; text: string; contentType: string };

/** 根据真实来源读取草稿；所有外部请求都是读取，不创建或回写第三方工作项。 */
export async function extractThirdPartyTaskInfo(rawUrl: string, services?: ZentaoExtractServices): Promise<ThirdPartyTaskExtract> {
  /** 读取前再次校验，不能信任渲染进程提交的来源地址。 */
  const link = parseThirdPartyTaskUrl(rawUrl);
  if (!link) return { kind: 'unsupported', sourceUrl: rawUrl };
  if (link.provider === 'zentao') {
    /** 禅道保留原来的凭据、字段拆分与附件下载逻辑。 */
    const result = await extractZentaoTaskInfo(link.url, services);
    if (result.kind === 'ok') {
      /** 禅道与新增来源一样保留详情地址，便于回看原始上下文。 */
      const field = result.taskType === 'defect' ? 'reproductionSteps' : 'description';
      return { ...result, provider: 'zentao', [field]: [result[field], `禅道: ${link.url}`].filter(Boolean).join('\n\n') };
    }
    return result.kind === 'login_required' ? { ...result, provider: 'zentao' } : result;
  }
  try {
    if (link.provider === 'github') return await extractGithubIssue(link);
    /** Jira 的接口和页面同源，可直接使用内置浏览器的登录会话。 */
    const response = await fetchSource(link.apiUrl, true);
    if (response.status !== 200) return sourceFailure(link, response.status);
    if (!response.contentType.includes('application/json')) return { kind: 'login_required', provider: 'jira', sourceUrl: link.url };
    /** 只有编号和标题匹配的详情对象才能进入任务草稿。 */
    const payload = asRecord(JSON.parse(response.text));
    /** Jira 各版本均把详情字段放在 fields 中。 */
    const fields = asRecord(payload.fields);
    if (payload.key !== link.objectId || typeof fields.summary !== 'string' || !fields.summary.trim() || !(typeof fields.description === 'string' || fields.description === null || asRecord(fields.description).type === 'doc'))
      return invalidSource(link);
    /** 仅识别明确的缺陷类型；自定义类型仍可在草稿里调整。 */
    const defect = /^(bug|defect|缺陷|故障)$/iu.test(String(asRecord(fields.issuetype).name ?? ''));
    /** 附件保留原始下载地址，避免把远程文件伪装成本地附件。 */
    const attachmentLinks = (Array.isArray(fields.attachment) ? fields.attachment : []).flatMap((value) => {
      /** 远程附件地址同样限制为网页协议且不得夹带账号密码。 */
      const attachment = asRecord(value);
      /** 无安全地址的附件仍可通过草稿中的来源详情页查看。 */
      const url = safeSourceUrl(attachment.content);
      return url ? [`${String(attachment.filename ?? '附件')}: ${url}`] : [];
    });
    return buildIssueDraft(link, fields.summary, [jiraDescription(fields.description), ...attachmentLinks].filter(Boolean).join('\n\n'), defect);
  } catch (error) {
    return { kind: 'failed', sourceUrl: link.url, reason: error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError') ? 'timeout' : 'read_failed' };
  }
}

/** GitHub 公共接口优先；私有 Issue 使用浏览器会话读取页面内同一工作项的预加载数据。 */
async function extractGithubIssue(link: Extract<ThirdPartyTaskLink, { apiUrl: string }>): Promise<ThirdPartyTaskExtract> {
  /** 匿名接口不携带浏览器凭据，也不会将 cookies 发送到 API 域名。 */
  const response = await fetchSource(link.apiUrl, false);
  if (response.status === 200) {
    /** GitHub 的 issues 接口也会返回 PR，因此必须显式排除。 */
    const payload = asRecord(JSON.parse(response.text));
    if (payload.pull_request) return { kind: 'unsupported', sourceUrl: link.url };
    if (
      String(payload.number) !== link.objectId ||
      safeSourceUrl(payload.html_url)?.toLowerCase() !== link.url.toLowerCase() ||
      typeof payload.title !== 'string' ||
      !payload.title.trim() ||
      !(typeof payload.body === 'string' || payload.body === null)
    )
      return invalidSource(link);
    return buildIssueDraft(link, payload.title, payload.body ?? '', githubDefect(payload.labels));
  }
  if (![401, 403, 404, 429].includes(response.status)) return sourceFailure(link, response.status);
  /** 网页会话只发送给用户指定的 github.com，不跟随任何重定向。 */
  const page = await fetchSource(link.url, true, 'text/html');
  if (page.status !== 200) return sourceFailure(link, response.status === 429 || (response.status === 403 && page.status === 403) ? 429 : page.status);
  // ponytail: 私有 Issue 依赖 GitHub 页面预加载结构；结构变动时明确失败，有正式 OAuth 接入需求再替换此读取路径。
  for (const match of page.text.matchAll(/<script\b[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/giu)) {
    try {
      /** 仅检查详情查询固定路径，不遍历评论或页面中的其他工作项。 */
      const queries = asRecord(asRecord(JSON.parse(match[1])).payload).preloadedQueries;
      if (!Array.isArray(queries)) continue;
      for (const query of queries) {
        /** 查询变量和详情地址必须同时指向输入的 Issue。 */
        const record = asRecord(query);
        /** 预加载数据中 repository.issue 是正文，timeline 中的内容不导入。 */
        const issue = asRecord(asRecord(asRecord(asRecord(record.result).data).repository).issue);
        if (String(issue.number) !== link.objectId || safeSourceUrl(issue.url)?.toLowerCase() !== link.url.toLowerCase() || typeof issue.title !== 'string' || !issue.title.trim() || typeof issue.body !== 'string') continue;
        /** 网页标签位于连接节点中，转为接口使用的标签数组。 */
        const edges = asRecord(issue.labels).edges;
        return buildIssueDraft(link, issue.title, issue.body, githubDefect(Array.isArray(edges) ? edges.map((edge) => asRecord(edge).node) : []));
      }
    } catch {
      // 页面可能包含其他无关的 JSON 区块，继续查找明确的详情数据。
    }
  }
  return invalidSource(link);
}

/** 共用现有有界响应读取，关闭重定向，登录页面不会被误当成工作项内容。 */
async function fetchSource(url: string, authenticated: boolean, accept = 'application/json'): Promise<SourceResponse> {
  /** cookies 仅由 Electron 对目标域名按会话规则发送。 */
  const requester = authenticated ? session.fromPartition(browserPartition, { cache: true }) : net;
  /** 每次请求只访问已推导的固定接口或原始详情地址。 */
  const response = await requester.fetch(url, { method: 'GET', redirect: 'manual', credentials: authenticated ? 'include' : 'omit', signal: AbortSignal.timeout(fetchTimeoutMs), headers: { Accept: accept } });
  if (response.status !== 200) {
    await response.body?.cancel();
    return { status: response.status, text: '', contentType: '' };
  }
  return { status: response.status, text: new TextDecoder().decode(await readBoundedZentaoResponse(response, responseBytesLimit)), contentType: response.headers.get('content-type') ?? '' };
}

/** 接口失败保持可区分原因；404 可能是隐藏的私有工作项，不能直接宣称不存在。 */
function sourceFailure(link: ThirdPartyTaskLink, status: number): ThirdPartyTaskExtract {
  if ([301, 302, 303, 307, 308, 401, 403].includes(status)) return { kind: 'login_required', provider: link.provider, sourceUrl: link.url };
  return { kind: 'failed', sourceUrl: link.url, reason: status === 404 ? 'not_found_or_no_access' : status === 429 ? 'rate_limited' : `http_${status}` };
}

/** 结构不匹配时不把登录页、错误页或评论填进任务。 */
function invalidSource(link: ThirdPartyTaskLink): ThirdPartyTaskExtract {
  return { kind: 'failed', sourceUrl: link.url, reason: 'invalid_response' };
}

/** 原始正文和来源链接一起进入当前任务类型的可见字段。 */
function buildIssueDraft(link: ThirdPartyTaskLink, title: string, body: string, defect: boolean): ThirdPartyTaskExtract {
  /** 来源链接必须持久保留，方便回看未下载的附件与原始讨论。 */
  const content = [body.trim(), `${link.provider === 'github' ? 'GitHub Issue' : 'Jira'}: ${link.url}`].filter(Boolean).join('\n\n');
  return {
    kind: 'ok',
    provider: link.provider,
    objectId: link.objectId,
    taskType: defect ? 'defect' : 'requirement',
    title: title.trim(),
    description: defect ? '' : content,
    currentState: defect ? content : '',
    reproductionSteps: '',
    expectedOutcome: '',
    sourceUrl: link.url,
    attachments: [],
    attachmentFailedCount: 0,
  };
}

/** 只把明确标为缺陷的 Issue 映射为缺陷，避免按正文猜测用户意图。 */
function githubDefect(labels: unknown): boolean {
  return Array.isArray(labels) && labels.some((label) => /^(bug|defect|缺陷)$/iu.test(String(typeof label === 'string' ? label : (asRecord(label).name ?? ''))));
}

/** 同时接受 Jira 文本描述与结构化富文本，保留段落、列表和链接。 */
function jiraDescription(value: unknown, depth = 0): string {
  if (typeof value === 'string') return value;
  if (depth > 40) throw new Error('Jira 正文嵌套过深。');
  /** 未知富文本容器也保留其子段落，避免自定义节点吞掉正文。 */
  const node = asRecord(value);
  /** 富文本节点的可见正文。 */
  const content = Array.isArray(node.content) ? node.content.map((child) => jiraDescription(child, depth + 1)).join('') : '';
  if (node.type === 'text') {
    /** 文本中的链接标记保留其目标地址。 */
    const link = Array.isArray(node.marks) ? node.marks.find((mark) => asRecord(mark).type === 'link') : undefined;
    /** 非网页链接只保留原始可见文字。 */
    const url = safeSourceUrl(asRecord(asRecord(link).attrs).href);
    return `${typeof node.text === 'string' ? node.text : ''}${url ? ` (${url})` : ''}`;
  }
  if (node.type === 'hardBreak') return '\n';
  if (node.type === 'mention') return String(asRecord(node.attrs).text ?? '');
  if (node.type === 'inlineCard' || node.type === 'blockCard') return safeSourceUrl(asRecord(node.attrs).url) ?? '';
  if (node.type === 'listItem') return `- ${content.trim()}\n`;
  return `${content}${['paragraph', 'heading', 'codeBlock', 'blockquote', 'tableRow'].includes(String(node.type)) ? '\n\n' : ''}`;
}

/** 不信任第三方 JSON 的字段类型。 */
function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** 保留可访问的网页链接，拒绝带凭据地址和脚本协议。 */
function safeSourceUrl(value: unknown): string | null {
  try {
    /** URL 构造器不能把非字符串字段当成正文。 */
    const url = new URL(typeof value === 'string' ? value : '');
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

/** 在独立、无预加载权限的 Zeus 登录窗口打开来源，复用内置浏览器会话。 */
export async function openThirdPartyTaskLogin(parent: BrowserWindow, rawUrl: string): Promise<boolean> {
  /** 登录入口与导入入口共用校验，不接受任意网页。 */
  const link = parseThirdPartyTaskUrl(rawUrl);
  if (!link) return false;
  /** 窗口从创建时即跟随任务窗口所在显示器。 */
  const bounds = screen.getDisplayMatching(parent.getBounds()).workArea;
  /** 登录窗口始终位于任务窗口所属显示器的可用区域。 */
  const width = Math.min(bounds.width, 1000);
  /** 使用独立滚动页面，窄屏也不越出显示器。 */
  const height = Math.min(bounds.height, 800);
  /** 第三方网页只能使用沙箱浏览器能力，不继承 Zeus 的预加载脚本。 */
  const login = new BrowserWindow({
    parent,
    show: false,
    x: Math.round(bounds.x + (bounds.width - width) / 2),
    y: Math.round(bounds.y + (bounds.height - height) / 2),
    width,
    height,
    title: new URL(link.url).host,
    webPreferences: { partition: browserPartition, sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  login.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  login.webContents.on('page-title-updated', (event) => {
    event.preventDefault();
  });
  login.webContents.on('did-navigate', (_event, url) => {
    if (safeSourceUrl(url)) login.setTitle(new URL(url).origin);
  });
  login.webContents.on('will-navigate', (event, url) => {
    if (!safeSourceUrl(url)) event.preventDefault();
  });
  login.webContents.on('will-redirect', (event, url) => {
    if (!safeSourceUrl(url)) event.preventDefault();
  });
  // 登录窗口尽早可见，让用户看到真实来源及加载状态；登录完成后回到草稿重试。
  login.show();
  try {
    await login.loadURL(link.url);
    return true;
  } catch {
    if (!login.isDestroyed()) login.close();
    return false;
  }
}
