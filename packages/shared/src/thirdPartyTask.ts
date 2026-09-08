import { parseZentaoTaskUrl, type ZentaoTaskExtract } from './index.js';

/** 任务草稿目前可读取的第三方来源。 */
export type ThirdPartyTaskProvider = 'github' | 'jira' | 'zentao';

/** 已校验的详情链接；接口地址仅由链接结构推导，不接受页面提供的任意地址。 */
export type ThirdPartyTaskLink = { provider: 'github' | 'jira'; url: string; objectId: string; apiUrl: string } | { provider: 'zentao'; url: string; objectId: string };

/** 各来源共用草稿字段，禅道独有的对象类型留在其读取实现中。 */
export type ThirdPartyTaskExtract =
  | (Omit<Extract<ZentaoTaskExtract, { kind: 'ok' }>, 'zentaoKind'> & { provider: ThirdPartyTaskProvider })
  | { kind: 'login_required'; provider: ThirdPartyTaskProvider; sourceUrl: string }
  | Extract<ZentaoTaskExtract, { kind: 'unsupported' | 'failed' }>;

/** 识别 GitHub Issue、Jira 详情及禅道链接，并拒绝凭据、畸形编码和非网页协议。 */
export function parseThirdPartyTaskUrl(rawUrl: string): ThirdPartyTaskLink | null {
  try {
    /** 用户输入只能指向一个完整网页地址。 */
    const parsed = new URL(rawUrl.trim());
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || /\s/u.test(rawUrl.trim())) return null;
    /** 先验证编码，避免旧禅道解析器收到畸形路径时抛错。 */
    const pathname = decodeURIComponent(parsed.pathname);
    if (pathname !== parsed.pathname) return null;
    /** GitHub 只接受公开站点的 Issue 详情，PR 和列表不属于任务导入。 */
    const github = /^\/([\w.-]+)\/([\w.-]+)\/issues\/([1-9]\d*)\/?$/u.exec(pathname);
    if (parsed.hostname === 'github.com') {
      if (!github || parsed.port || parsed.protocol !== 'https:') return null;
      return { provider: 'github', url: `https://github.com/${github[1]}/${github[2]}/issues/${github[3]}`, objectId: github[3], apiUrl: `https://api.github.com/repos/${github[1]}/${github[2]}/issues/${github[3]}` };
    }
    /** Jira 自托管保留部署子目录；Cloud 看板选中的工作项还原成详情页。 */
    const jira = /^(.*?)\/browse\/([A-Z][A-Z0-9_]*-[1-9]\d*)\/?$/iu.exec(pathname);
    /** Cloud 看板分享链接通过 selectedIssue 指向具体工作项。 */
    const selectedIssue = parsed.searchParams.get('selectedIssue');
    /** Cloud 看板的路径不是部署子目录，接口始终位于站点根路径。 */
    const cloudIssue = parsed.hostname.endsWith('.atlassian.net') && /^\/jira\/(software|core|servicedesk)\//u.test(pathname) && selectedIssue && /^[A-Z][A-Z0-9_]*-[1-9]\d*$/iu.test(selectedIssue) ? selectedIssue : null;
    if (jira || cloudIssue) {
      /** 规范化工作项编号，避免大小写造成重复来源链接。 */
      const objectId = (jira?.[2] ?? cloudIssue!).toUpperCase();
      /** REST 接口沿用自托管上下文路径，同时支持 Cloud。 */
      const base = `${parsed.origin}${jira?.[1] ?? ''}`;
      return { provider: 'jira', url: `${base}/browse/${objectId}`, objectId, apiUrl: `${base}/rest/api/2/issue/${objectId}?fields=summary,description,issuetype,attachment` };
    }
    /** 原有禅道链接继续交给专用解析器处理。 */
    const zentao = parseZentaoTaskUrl(parsed.href);
    return zentao.kind === 'zentao' ? { provider: 'zentao', url: zentao.url, objectId: zentao.objectId } : null;
  } catch {
    return null;
  }
}

/** 仅对完整粘贴的详情链接触发自动读取。 */
export function extractThirdPartyTaskLink(text: string): string | null {
  return parseThirdPartyTaskUrl(text)?.url ?? null;
}
