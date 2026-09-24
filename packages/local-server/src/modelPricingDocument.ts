import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';

/** 公开价格页面的读取上限，避免页面占用无限内存。 */
const maximumBytes = 2_000_000;
/** 公网抓取禁止连接本机、内网、组播、保留地址。 */
const excluded = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3],
] as const)
  excluded.addSubnet(address, prefix);
excluded.addSubnet('2001:db8::', 32, 'ipv6');

/** 配置只接受公开 HTTP 页面，不接受凭据、文件或其他协议。 */
export function normalizePricingUrl(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || value.length > 2048) throw new Error('价格页面必须是无凭据的 HTTP 或 HTTPS 地址。');
  return url.href;
}

/** 每次解析与重定向都校验，并固定本次实际连接地址以防 DNS 重绑定。 */
export async function readPricingDocument(value: string, signal?: AbortSignal, redirects = 0): Promise<string> {
  const url = new URL(normalizePricingUrl(value));
  const hostname = url.hostname.replace(/^\[|\]$/gu, '');
  const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await lookup(hostname, { all: true });
  if (!addresses.length || addresses.some(({ address, family }) => (family === 4 ? excluded.check(address) : !/^[23][0-9a-f]{3}:/iu.test(address) || excluded.check(address, 'ipv6')))) throw new Error('价格页面只能访问公网地址。');
  const address = addresses[0]!;
  const response = await new Promise<{ status: number; location?: string; text: string }>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      url,
      {
        family: address.family,
        headers: { Accept: 'application/json,text/html,text/plain', 'Accept-Encoding': 'identity' },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
        lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
      },
      (incoming) => {
        incoming.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > maximumBytes) request.destroy(new Error('价格页面超过读取上限。'));
          else chunks.push(chunk);
        });
        incoming.on('error', reject);
        incoming.on('end', () => resolve({ status: incoming.statusCode ?? 0, location: incoming.headers.location, text: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    request.on('error', reject);
    request.end();
  });
  if (response.status >= 300 && response.status < 400 && response.location && redirects < 3) return readPricingDocument(new URL(response.location, url).href, signal, redirects + 1);
  if (response.status !== 200) throw new Error(`价格页面读取失败（HTTP ${response.status}）。`);
  return response.text;
}
