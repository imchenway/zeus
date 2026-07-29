import {createHmac, timingSafeEqual} from 'node:crypto';
import {realpathSync} from 'node:fs';
import {isAbsolute} from 'node:path';

const grantPrefix = 'zeus-conversation-path-v1';

interface ConversationAttachmentGrantPayload {
  version: 1;
  path: string;
}

/**
 * 为用户在 Electron Main 中明确选择/粘贴/拖入的单一路径签发 capability。
 * Renderer 只持有签名后的 token，不能自行扩大 Local Server 的文件读取范围。
 */
export function createConversationAttachmentGrant(path: string, secret: string): string {
  if (!isAbsolute(path) || path.includes('\0')) throw new TypeError('Conversation attachment grant path must be absolute.');
  const canonicalPath = realpathSync(path);
  const payload = Buffer.from(
    JSON.stringify({version: 1, path: canonicalPath} satisfies ConversationAttachmentGrantPayload),
    'utf8',
  ).toString('base64url');
  return `${grantPrefix}.${payload}.${signPayload(payload, secret)}`;
}

/**
 * 验证 capability 并返回签发时的 canonical path。
 * 文件后来被移动/删除时仍返回旧路径，调用方必须在实际使用前重新 realpath/stat。
 */
export function resolveConversationAttachmentGrant(token: string, secret: string): string | null {
  if (!token || token.length > 32_768 || !secret) return null;
  const [prefix, payload, signature, ...rest] = token.split('.');
  if (prefix !== grantPrefix || !payload || !signature || rest.length > 0) return null;
  const expected = Buffer.from(signPayload(payload, secret), 'utf8');
  const actual = Buffer.from(signature, 'utf8');
  if (expected.byteLength !== actual.byteLength || !timingSafeEqual(expected, actual)) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Partial<ConversationAttachmentGrantPayload>;
    if (decoded.version !== 1 || typeof decoded.path !== 'string' || !isAbsolute(decoded.path) || decoded.path.includes('\0')) return null;
    return decoded.path;
  } catch {
    return null;
  }
}

function signPayload(payload: string, secret: string): string {
  if (!secret) throw new TypeError('Conversation attachment grant secret is required.');
  return createHmac('sha256', secret).update(`${grantPrefix}.${payload}`).digest('base64url');
}
