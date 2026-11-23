import { execFileSync } from 'node:child_process';
import { constants, createCipheriv, createDecipheriv, createPublicKey, generateKeyPairSync, privateDecrypt, publicEncrypt, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/** 故障机器人和诊断工作流共同使用的正式仓库与对象位置。 */
const repository = 'imchenway/zeus';
/** 故障报告服务的固定私有 OSS 存储空间。 */
const bucket = 'imchenway-zeus-diagnostics';
/** 正式诊断空间所属 OSS 地域。 */
const region = 'cn-hangzhou';
/** 限制整份追加式报告的读取大小，单位字节。 */
const reportLimit = 2 * 1024 * 1024;
/** Artifact 只收集这个文件，明文从不写入回传目录。 */
const sealedName = 'zeus-fault-report.sealed.json';
/** 使用 OAEP-SHA256 封装每份原包的随机 AES 密钥。 */
const keyOptions = { padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' };

/** 只接受上报服务使用的 UUID v4，避免输入改变对象前缀。 */
function requireReportId(value) {
  if (typeof value !== 'string' || !/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u.test(value)) throw new Error('无效的 Zeus 报告 ID。');
  return value;
}

/** 校验 JSONL 首行的报告身份，原始字节供维护者继续分析。 */
function verifyReport(report, reportId) {
  try {
    if (JSON.parse(report.toString('utf8').split('\n', 1)[0]).packet.reportId === reportId) return;
  } catch {
    /* 解析失败与身份不一致都不能作为目标 Issue 的原包。 */
  }
  throw new Error('OSS 原包无法解析或报告 ID 与 Issue 不一致。');
}

/** 在读取诊断或解密前检查文件大小，避免异常制品占用内存。 */
function readBounded(file, maximum) {
  if (statSync(file).size > maximum) throw new Error('诊断文件超出读取上限。');
  return readFileSync(file);
}

/** 复用现有 gh 登录，把等待上限交给各操作，单位毫秒。 */
function gh(args, input, timeout = 30_000) {
  return execFileSync('gh', args, { encoding: 'utf8', input, timeout, maxBuffer: reportLimit }).trim();
}

/** 派发后持续查询同一个运行直到结束，预算与运行器超时单位均为毫秒。 */
async function waitForRun(runId) {
  const deadline = Date.now() + 7 * 60_000;
  while (Date.now() < deadline) {
    let run;
    try {
      run = JSON.parse(gh(['api', '--hostname', 'github.com', `repos/${repository}/actions/runs/${runId}`, '--jq', '{status,conclusion}'], undefined, 10_000));
    } catch (error) {
      if (!error.stderr?.includes('HTTP 404')) throw error;
    }
    if (run?.status === 'completed') {
      if (run.conclusion !== 'success') throw new Error(`GitHub 诊断运行结束，结果为 ${run.conclusion}。`);
      return;
    }
    await delay(5_000);
  }
  throw new Error('GitHub 已接受派发，但该诊断运行在等待期限内未完成。');
}

/** 通过正式机器人标记与精确对象链接确认 Issue 对应的报告。 */
function issueReport(reference) {
  const issueNumber = reference?.match(/^#?(\d+)$/u)?.[1] ?? reference?.match(/^https:\/\/github\.com\/imchenway\/zeus\/issues\/(\d+)\/?(?:[?#].*)?$/u)?.[1];
  if (!issueNumber || !/^[1-9]\d*$/u.test(issueNumber)) throw new Error('请提供 imchenway/zeus 的 Issue 链接或编号。');
  const issue = JSON.parse(gh(['api', '--hostname', 'github.com', `repos/${repository}/issues/${issueNumber}`]));
  if (issue.user?.type !== 'Bot' || issue.user.login !== 'zeus-fault-reports-imchenway[bot]') throw new Error('该 Issue 不是 Zeus 故障机器人创建的报告。');
  const reportId = requireReportId(issue.body?.match(/^<!-- zeus-report:([\da-f-]+) -->/u)?.[1]);
  const link = `https://oss.console.aliyun.com/bucket/oss-${region}/${bucket}/object?path=${encodeURIComponent(`reports/${reportId}.jsonl`)}`;
  if (!issue.body.includes(`](${link})`)) throw new Error('Issue 中的 OSS 链接与报告 ID 不一致。');
  return reportId;
}

/** 只签名并发起单个 GetObject 请求，签名 URL 保留在内存。 */
async function getOssReport(reportId) {
  const key = `reports/${reportId}.jsonl`;
  const endpoint = `https://oss-${region}.aliyuncs.com`;
  let signed;
  try {
    signed = execFileSync('ossutil', ['presign', `oss://${bucket}/${key}`, '--region', region, '--endpoint', endpoint, '--mode', 'StsToken', '--expires-duration', '1m', '--loglevel', 'off'], {
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 16_384,
    });
  } catch {
    throw new Error('OSS 原包请求签名失败。');
  }
  const match = signed.match(/https:\/\/\S+/u)?.[0];
  const url = match ? new URL(match) : null;
  if (url?.origin !== `https://${bucket}.oss-${region}.aliyuncs.com` || decodeURIComponent(url.pathname) !== `/${key}` || !url.search) {
    throw new Error('OSS 签名没有指向预期报告。');
  }
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(60_000) }).catch(() => {
    throw new Error('OSS 原包请求失败。');
  });
  if (!response.ok) throw new Error(`OSS 原包读取失败（HTTP ${response.status}）。`);
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > reportLimit) throw new Error('OSS 原包超出读取上限。');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes);
}

/** 由受限工作流读取单个对象，回传用请求方一次性公钥封装的密文。 */
async function sealReport() {
  const reportId = requireReportId(process.env.REPORT_ID);
  const encodedKey = process.env.REPORT_RECIPIENT_KEY;
  if (!encodedKey || encodedKey.length > 1024) throw new Error('无效的诊断接收公钥。');
  const recipient = createPublicKey({ key: Buffer.from(encodedKey, 'base64'), type: 'spki', format: 'der' });
  if (recipient.asymmetricKeyType !== 'rsa' || recipient.asymmetricKeyDetails.modulusLength !== 2048) throw new Error('诊断接收公钥须为 2048 位 RSA。');
  const report = await getOssReport(reportId);
  verifyReport(report, reportId);
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(reportId));
  const ciphertext = Buffer.concat([cipher.update(report), cipher.final()]);
  const wrappedKey = publicEncrypt({ ...keyOptions, key: recipient }, key);
  const envelope = { wrappedKey: wrappedKey.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
  writeFileSync(join(process.env.RUNNER_TEMP, sealedName), JSON.stringify(envelope), { flag: 'wx', mode: 0o600 });
}

/** 分析前按精确运行身份取回密文，在本机解包并保留原始 JSONL。 */
async function readReport(reference) {
  const reportId = issueReport(reference);
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const recipientKey = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const run = JSON.parse(
    gh(
      ['api', '--hostname', 'github.com', '-H', 'X-GitHub-Api-Version: 2026-03-10', '--method', 'POST', `repos/${repository}/actions/workflows/zeus-diagnostics.yml/dispatches`, '--input', '-'],
      JSON.stringify({ ref: 'main', inputs: { report_id: reportId, recipient_key: recipientKey } }),
    ),
  );
  const runId = run.workflow_run_id;
  if (!Number.isSafeInteger(runId) || runId <= 0) throw new Error('GitHub 没有返回可核对的诊断运行 ID。');
  const runUrl = `https://github.com/${repository}/actions/runs/${runId}`;
  console.error(`GitHub 诊断运行 ${runUrl}`);
  await waitForRun(runId);
  const directory = mkdtempSync(join(tmpdir(), 'zeus-fault-report-'));
  try {
    gh(['run', 'download', String(runId), '--repo', repository, '--name', 'zeus-fault-report', '--dir', directory], undefined, 90_000);
    const artifact = join(directory, sealedName);
    const { wrappedKey, iv, tag, ciphertext } = JSON.parse(readBounded(artifact, 2 * reportLimit));
    const key = privateDecrypt({ ...keyOptions, key: privateKey }, Buffer.from(wrappedKey, 'base64'));
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'), { authTagLength: 16 });
    decipher.setAAD(Buffer.from(reportId));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    const report = Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]);
    verifyReport(report, reportId);
    const path = join(directory, `${reportId}.jsonl`);
    writeFileSync(path, report, { flag: 'wx', mode: 0o600 });
    rmSync(artifact);
    console.log(JSON.stringify({ reportId, path, runUrl }));
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

try {
  if (process.argv[2] === '--seal') await sealReport();
  else await readReport(process.argv[2]);
} catch (error) {
  console.error(error.stderr?.trim() || error.message);
  process.exitCode = 1;
}
