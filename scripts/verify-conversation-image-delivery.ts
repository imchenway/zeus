import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { conversationMarkdownReferences } from '../packages/shared/src/index.js';
import { createZeusDatabase, ConversationRepository, ConversationResourceRepository, ConversationSnapshotV2Repository } from '../packages/storage/src/index.js';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ZeusConversationItemRecord } from '@zeus/storage';
import { ConversationProviderItemRepository } from '../packages/storage/src/conversationProviderItemStore.js';
import { syncConversationResources, normalizeConversationResources, toConversationResource, toConversationResourceOpenIntent } from '../packages/local-server/src/conversationResources.js';
import { readConversationResourcePreview } from '../packages/local-server/src/conversationResourcePreview.js';

/** 放在仓库内，避免系统临时目录的既有授权掩盖工作树边界错误。 */
const root = mkdtempSync(resolve('.zeus-worktree-image-check-'));
/** 独立仓库元数据不操作当前仓库，也不执行 Git 历史变更。 */
const project = join(root, 'project');
/** 当前会话根与图片所在的独立工作树不同。 */
const task = join(root, 'task');
/** 图片文件名包含空格，检查 Markdown 引用规范化。 */
const imageTree = join(root, 'preview tree');
/** 只使用一张有效 PNG，不依赖外部图片。 */
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jV9kAAAAASUVORK5CYII=', 'base64');
/** 稳定消息身份用于核对重复归档及原文件移除后的恢复。 */
const item: ZeusConversationItemRecord = {
  id: 'image-reply',
  conversationId: 'image-conversation',
  turnId: 'image-turn',
  providerThreadId: 'thread',
  providerTurnId: 'turn',
  providerItemId: 'reply',
  itemType: 'agentMessage',
  status: 'completed',
  phase: 'final_answer',
  payloadJson: '{}',
  textContent: '',
  startedAt: null,
  completedAt: '2026-10-14T00:00:00.000Z',
  updatedAt: '2026-10-14T00:00:00.000Z',
  agentKind: 'codex',
  nativeItemId: 'reply',
};

/** 按 Git 的双向指针登记隔离目录，不创建提交或真实工作树。 */
function registerTree(path: string, name: string): string {
  /** 每个登记使用独立管理目录。 */
  const admin = join(project, '.git', 'worktrees', name);
  mkdirSync(admin, { recursive: true });
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, '.git'), `gitdir: ${admin}\n`);
  writeFileSync(join(admin, 'commondir'), '../..\n');
  writeFileSync(join(admin, 'gitdir'), `${join(path, '.git')}\n`);
  return admin;
}

/** 所有检查都调用生产归档入口，资源正文和预览也使用原组件的数据契约。 */
function normalize(path: string, overrides: Partial<Parameters<typeof normalizeConversationResources>[0]> = {}) {
  return normalizeConversationResources({
    projectId: 'project',
    projectRoot: task,
    registeredProjectRoot: project,
    conversationId: item.conversationId,
    turnId: item.turnId,
    item,
    payload: {},
    text: `![通知截图](<${path}>)`,
    trustedAttachmentRoots: [],
    assistantImageArchiveRoot: join(root, 'archive'),
    now: item.updatedAt,
    ...overrides,
  });
}

try {
  registerTree(task, 'task');
  /** 图片目录具备与项目互相指认的登记。 */
  const imageAdmin = registerTree(imageTree, 'preview');
  /** 原始图片不在会话根内，但属于同一个仓库。 */
  const source = join(imageTree, '通知 截图.png');
  writeFileSync(source, png);
  /** 正式归档只产生一条内嵌附件，预览字节必须与原件一致。 */
  const records = normalize(source);
  assert.equal(records.length, 1);
  /** 资源转换沿用真实持久记录的字段。 */
  const record = { ...records[0]!, createdAt: item.updatedAt, updatedAt: item.updatedAt };
  /** 预览必须从受管归档读取，不能继续依赖工作树路径。 */
  const resource = toConversationResource(record);
  assert.ok(resource?.kind === 'attachment' && resource.previewKind === 'image');
  /** 正式预览入口验证归档授权并读取字节。 */
  const preview = readConversationResourcePreview(resource, toConversationResourceOpenIntent(record));
  assert.equal(preview.kind, 'image');
  assert.deepEqual(readFileSync(JSON.parse(record.targetJson).absolutePath), png);
  assert.equal(normalize(source)[0]?.id, record.id);
  assert.equal(normalize(encodeURI(source))[0]?.kind, 'attachment');
  assert.equal(normalize(source, { registeredProjectRoot: task })[0]?.kind, 'attachment');
  assert.equal(normalize(source, { text: `[普通文件](${source})` }).length, 0);
  /** 重新使用未归档路径，避免旧归档绕过拒绝条件。 */
  const rejected = join(imageTree, 'unregistered.png');
  writeFileSync(rejected, png);
  writeFileSync(join(imageAdmin, 'gitdir'), `${join(task, '.git')}\n`);
  assertUnavailable(rejected, 'FORBIDDEN');
  registerTree(imageTree, 'preview');
  /** 外部图片、外部符号链接以及伪造单向指针均不可获得授权。 */
  const outside = join(root, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'secret.png'), png);
  assertUnavailable(join(outside, 'secret.png'), 'FORBIDDEN');
  symlinkSync(join(outside, 'secret.png'), join(imageTree, 'escape.png'));
  assertUnavailable(join(imageTree, 'escape.png'), 'FORBIDDEN');
  symlinkSync(join(imageTree, '.git'), join(outside, '.git'));
  assertUnavailable(join(outside, 'secret.png'), 'FORBIDDEN');
  assert.equal(normalize(rejected, { item: { ...item, status: 'in_progress' } }).length, 0);
  assert.equal(normalize(rejected, { item: { ...item, itemType: 'userMessage' } }).length, 0);
  await verifyDeliveryLifecycle(source);
  rmSync(source);
  assert.equal(normalize(source)[0]?.id, record.id);
  console.log('PASS: 公共解析、精确图片归属、缺文件与归档失败重试、生成图归档、局部更新保留、持久分页重开、工作树和路径授权边界。');
} finally {
  rmSync(root, { recursive: true, force: true });
}

/** 失败引用仍须登记；读取时必须给出具体原因，且不得因此授予文件权限。 */
function assertUnavailable(path: string, code: string): void {
  const records = normalize(path);
  assert.equal(records.length, 1);
  assert.throws(() => toConversationResourceOpenIntent({ ...records[0]!, createdAt: item.updatedAt, updatedAt: item.updatedAt }), { code: `ZEUS_CONVERSATION_IMAGE_${code}` });
}

/** 多种产生原因在同一生产登记、预览和持久化链路中复验。 */
async function verifyDeliveryLifecycle(source: string): Promise<void> {
  /** 解析必须与正文语法一致，不能从代码块中建立假的图片引用。 */
  const text = '![同名](one.png) ![同名](two.png) ![](three(1).png "标题")\n\n![引用][image]\n\n[image]: <four name.png>\n\n```md\n![代码](ignored.png)\n```';
  const refs = conversationMarkdownReferences(text).filter((entry) => entry.image);
  assert.equal(refs.length, 4);
  assert.deepEqual(
    refs.map((entry) => decodeURIComponent(entry.href)),
    ['one.png', 'two.png', 'three(1).png', 'four name.png'],
  );
  /** 省略说明和相对路径仍产生受管图片，不能继续依赖工作树原文件。 */
  writeFileSync(join(task, 'relative.png'), png);
  const relativeRecords = normalize('relative.png', { text: '![](relative.png)' });
  assert.equal(relativeRecords[0]?.kind, 'attachment');
  assert.equal(JSON.parse(relativeRecords[0]!.displayJson).sourceReference, 'relative.png');
  /** 未知来源和格式持久保留引用，并返回明确失败，不再无限显示准备中。 */
  assertUnavailable('https://example.invalid/image.png', 'REFERENCE_UNSUPPORTED');
  writeFileSync(join(task, 'invalid.png'), 'not an image');
  assertUnavailable(join(task, 'invalid.png'), 'SOURCE_INVALID');
  /** 缺文件时先保存同一资源；之后只预览该记录即可重试成功。 */
  const latePath = join(task, 'late.png');
  const late = normalize(latePath)[0]!;
  const lateRecord = { ...late, createdAt: item.updatedAt, updatedAt: item.updatedAt };
  assert.throws(() => toConversationResourceOpenIntent(lateRecord), { code: 'ZEUS_CONVERSATION_IMAGE_SOURCE_MISSING' });
  /** 归档根暂时不可写使用普通文件模拟，不依赖当前进程是否有超级用户权限。 */
  const brokenRoot = join(root, 'blocked-archive');
  writeFileSync(brokenRoot, 'blocked');
  const blocked = normalize(source, { assistantImageArchiveRoot: brokenRoot })[0]!;
  const blockedRecord = { ...blocked, createdAt: item.updatedAt, updatedAt: item.updatedAt };
  assert.throws(() => toConversationResourceOpenIntent(blockedRecord));
  rmSync(brokenRoot);
  assert.equal(readConversationResourcePreview(toConversationResource(blockedRecord) as Exclude<ReturnType<typeof toConversationResource>, null | { kind: 'website' }>, toConversationResourceOpenIntent(blockedRecord)).kind, 'image');
  /** 生成工具交付也冻结到受管目录，原工具图片清除后仍可预览。 */
  const generatedRoot = join(root, 'generated');
  const generatedPath = join(generatedRoot, item.providerThreadId, 'generated.png');
  const generated = normalize('', { text: '', item: { ...item, itemType: 'imageGeneration' }, payload: { type: 'imageGeneration', savedPath: generatedPath }, generatedImageRoot: generatedRoot })[0]!;
  assert.ok(JSON.parse(generated.authorityJson).imageArchive);
  /** 生成文件连同会话目录均未落盘时，也必须持久登记；修复文件后重试同一身份。 */
  const generatedRecord = { ...generated, createdAt: item.updatedAt, updatedAt: item.updatedAt };
  assert.throws(() => toConversationResourceOpenIntent(generatedRecord), { code: 'ZEUS_CONVERSATION_IMAGE_SOURCE_MISSING' });
  mkdirSync(join(generatedRoot, item.providerThreadId), { recursive: true });
  symlinkSync(source, generatedPath);
  assert.throws(() => toConversationResourceOpenIntent(generatedRecord), { code: 'ZEUS_CONVERSATION_IMAGE_FORBIDDEN' });
  rmSync(generatedPath);
  writeFileSync(generatedPath, png);
  toConversationResourceOpenIntent(generatedRecord);
  rmSync(generatedPath);
  toConversationResourceOpenIntent(generatedRecord);
  /** 不完整的私有授权记录必须明确拒绝，不能绕过归档校验。 */
  assert.throws(() => toConversationResourceOpenIntent({ ...generatedRecord, authorityJson: JSON.stringify({ ...JSON.parse(generated.authorityJson), imageArchive: {} }) }), { code: 'ZEUS_CONVERSATION_IMAGE_ARCHIVE_INVALID' });
  /** 资源记录跨 SQLite 重开保留，局部更新不能移除先前的图片。 */
  const databasePath = join(root, 'delivery.db');
  let database = await createZeusDatabase(databasePath);
  try {
    new ConversationRepository(database).create({ id: item.conversationId, projectId: 'project', title: '图片交付' });
    /** 历史回填也须选中没有 final_answer 阶段的 Pi 引用式图片和生成图。 */
    const providerItems = new ConversationProviderItemRepository(database);
    providerItems.upsertCompleted({ ...item, providerItemId: 'pi-reference', phase: 'prework', agentKind: 'pi', payload: {}, textContent: '![图片][asset]\n\n[asset]: late.png' });
    providerItems.upsertCompleted({ ...item, providerItemId: 'generated', phase: 'prework', itemType: 'imageGeneration', payload: { savedPath: generatedPath }, textContent: '' });
    assert.deepEqual(
      providerItems
        .listCompletedItemsForResourceBackfill()
        .map((entry) => entry.providerItemId)
        .sort(),
      ['generated', 'pi-reference'],
    );
    let repository = new ConversationResourceRepository(database);
    /** 旧记录只指向原文件；升级为受管归档时保留原资源身份。 */
    repository.replaceForItem(item.id, [{ ...late, targetJson: JSON.stringify({ absolutePath: latePath }), authorityJson: JSON.stringify({ allowedRoot: task }), canonicalTargetDigest: 'before-archive' }], item.updatedAt);
    const input = {
      projectId: 'project',
      projectRoot: task,
      registeredProjectRoot: project,
      conversationId: item.conversationId,
      turnId: item.turnId,
      item,
      payload: {},
      text: '[链接](https://example.com)',
      trustedAttachmentRoots: [],
      assistantImageArchiveRoot: join(root, 'archive'),
      now: item.updatedAt,
    };
    syncConversationResources(input, repository);
    assert.equal(repository.listByItem(item.id).length, 2);
    /** 事件内顺序变化不能给同一图片创建新身份，也不能重复登记已有网址。 */
    syncConversationResources({ ...input, text: `[链接](https://example.com)\n\n![图片](${latePath})` }, repository);
    assert.equal(repository.listByItem(item.id).length, 2);
    assert.equal(repository.getById(late.id)?.sourceIndex, late.sourceIndex);
    await database.save();
    await database.close();
    database = await createZeusDatabase(databasePath);
    repository = new ConversationResourceRepository(database);
    const persisted = repository.getById(late.id)!;
    assert.equal(JSON.parse(persisted.authorityJson).imageArchive.sourcePath, latePath);
    writeFileSync(latePath, png);
    assert.equal(readConversationResourcePreview(toConversationResource(persisted) as Exclude<ReturnType<typeof toConversationResource>, null | { kind: 'website' }>, toConversationResourceOpenIntent(persisted)).kind, 'image');
    const page = new ConversationSnapshotV2Repository(database).listResourcePage({ conversationId: item.conversationId });
    assert.equal(page.items.find((entry) => entry.id === late.id)?.sourceReference, latePath);
    rmSync(latePath);
    toConversationResourceOpenIntent(persisted);
  } finally {
    await database.close();
  }
  /** 真实前端匹配函数验证同说明图片不串图，样式交给浏览器核对。 */
  registerHooks({
    load(url, context, nextLoad) {
      return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context);
    },
  });
  (globalThis as typeof globalThis & { React: typeof import('react') }).React = await import('react');
  const { matchingInlineResource, hasMissingMarkdownImages } = await import('../apps/desktop/src/renderer/session/ConversationMarkdown.js');
  const sameLabels = normalize('', { text: '![同名](relative.png) ![同名](late.png)' }).map((entry) => toConversationResource({ ...entry, createdAt: item.updatedAt, updatedAt: item.updatedAt })!);
  assert.equal(matchingInlineResource(sameLabels, '同名', 'late.png')?.id, sameLabels[1]?.id);
  assert.equal(matchingInlineResource(sameLabels, '同名', 'relative.png')?.id, sameLabels[0]?.id);
  assert.equal(hasMissingMarkdownImages('![同名](relative.png) ![同名](late.png)', sameLabels), false);
  assert.equal(hasMissingMarkdownImages('```md\n![代码](ignored.png)\n```', []), false);
}
