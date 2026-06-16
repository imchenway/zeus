#!/usr/bin/env node
/* global process, console */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const designBookPath = resolve('docs/zeus_development_design.md');
const matrixPath = resolve('docs/zeus_acceptance_matrix.json');

/**
 * 从设计书第 25 章提取章节与勾选项数量；该脚本只读取真实设计书，避免人工矩阵漂移。
 */
export function parseDesignBookChapter25(markdown) {
  const sections = [];
  let current = null;
  let inChapter25 = false;

  const lines = markdown.split(/\r?\n/u);
  for (const [index, line] of lines.entries()) {
    if (line.startsWith('## 25. ')) {
      inChapter25 = true;
      continue;
    }
    if (inChapter25 && line.startsWith('## 26. ')) break;
    if (!inChapter25) continue;

    const sectionMatch = line.match(/^### (25\.\d+)\s+(.+)$/u);
    if (sectionMatch) {
      current = {
        id: sectionMatch[1],
        title: sectionMatch[2].trim(),
        itemCount: 0,
        items: [],
      };
      sections.push(current);
      continue;
    }

    if (current && line.startsWith('- [ ]')) {
      current.itemCount += 1;
      current.items.push({ line: index + 1, text: line.slice(6).trim() });
    }
  }

  return {
    source: 'docs/zeus_development_design.md#25',
    totalItems: sections.reduce((sum, section) => sum + section.itemCount, 0),
    sections,
  };
}

function loadJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function verifyMatrix() {
  const design = parseDesignBookChapter25(readFileSync(designBookPath, 'utf8'));
  const matrix = loadJson(matrixPath);
  const errors = [];

  if (matrix.source !== design.source) {
    errors.push(`矩阵来源不一致：${matrix.source} != ${design.source}`);
  }
  if (matrix.totalItems !== design.totalItems) {
    errors.push(`矩阵项数与设计书第 25 章不一致：${matrix.totalItems} != ${design.totalItems}`);
  }
  if (!Array.isArray(matrix.sections) || matrix.sections.length !== design.sections.length) {
    errors.push(`矩阵章节数与设计书第 25 章不一致：${matrix.sections?.length ?? 'missing'} != ${design.sections.length}`);
  }

  for (const expected of design.sections) {
    const actual = matrix.sections?.find((section) => section.id === expected.id);
    if (!actual) {
      errors.push(`矩阵缺少章节：${expected.id} ${expected.title}`);
      continue;
    }
    if (actual.title !== expected.title) {
      errors.push(`章节标题不一致：${expected.id} ${actual.title} != ${expected.title}`);
    }
    if (actual.itemCount !== expected.itemCount) {
      errors.push(`章节项数不一致：${expected.id} ${actual.itemCount} != ${expected.itemCount}`);
    }
    if (!Array.isArray(actual.evidence) || actual.evidence.length === 0) {
      errors.push(`章节缺少证据：${expected.id}`);
    }
    if (!Array.isArray(actual.blockers)) {
      errors.push(`章节阻塞项必须是数组：${expected.id}`);
    }
    if (!Array.isArray(actual.items) || actual.items.length !== expected.items.length) {
      errors.push(`章节逐项验收清单不一致：${expected.id} ${actual.items?.length ?? 'missing'} != ${expected.items.length}`);
    } else {
      for (const expectedItem of expected.items) {
        const actualItem = actual.items.find((item) => item.line === expectedItem.line);
        if (!actualItem || actualItem.text !== expectedItem.text) {
          errors.push(`验收项文本或行号不一致：${expected.id}:${expectedItem.line}`);
        }
        if (!actualItem?.status || typeof actualItem.status !== 'string') {
          errors.push(`验收项缺少状态：${expected.id}:${expectedItem.line}`);
        }
        if (actualItem?.status === 'verified_or_tracked') {
          errors.push(`验收项状态过于泛化：${expected.id}:${expectedItem.line}`);
        }
        if (['blocked_core_dependency', 'external_credential_wait', 'optional_connector_wait'].includes(actualItem?.status) && !actualItem?.blocker) {
          errors.push(`阻塞/等待验收项缺少原因：${expected.id}:${expectedItem.line}`);
        }
      }
    }
  }

  const blockerText = JSON.stringify(matrix.sections ?? []);
  const releaseDocumentation = `${readFileSync(resolve('docs/release.md'), 'utf8')}\n${readFileSync(resolve('docs/security.md'), 'utf8')}`;
  for (const required of ['Apple signing / notarization 未配置', 'unsigned DMG/ZIP']) {
    if (!releaseDocumentation.includes(required)) {
      errors.push(`发布文档缺少外部签名/公证等待说明：${required}`);
    }
  }

  const optionalConnectors = Array.isArray(matrix.optionalConnectors) ? matrix.optionalConnectors : [];
  const postgresMysqlConnector = optionalConnectors.find((connector) => connector.id === 'postgres-mysql-schema-introspection');
  if (!postgresMysqlConnector) {
    errors.push('矩阵缺少可选连接器：postgres-mysql-schema-introspection');
  } else {
    if (postgresMysqlConnector.requiredForLocalCore !== false) {
      errors.push('Postgres/MySQL 连接器不得标记为本地核心依赖');
    }
    const packages = Array.isArray(postgresMysqlConnector.packages) ? postgresMysqlConnector.packages : [];
    for (const pkg of ['pg', 'mysql2']) {
      if (!packages.includes(pkg)) errors.push(`Postgres/MySQL 可选连接器缺少包声明：${pkg}`);
    }
  }
  if (blockerText.includes('pg/mysql2 未批准') || blockerText.includes('Postgres/MySQL driver 未批准')) {
    errors.push('pg/mysql2 不得作为 Zeus 本地核心阻塞项；只能记录为可选连接器等待项');
  }

  if (errors.length > 0) {
    throw new Error(errors.join('\n'));
  }

  return design;
}

function writeDerivedSummary() {
  const design = parseDesignBookChapter25(readFileSync(designBookPath, 'utf8'));
  writeFileSync(process.stdout.fd, `${JSON.stringify(design, null, 2)}\n`);
}

if (process.argv.includes('--check')) {
  try {
    const result = verifyMatrix();
    console.log(`Zeus acceptance matrix verified: ${result.sections.length} sections / ${result.totalItems} items`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
} else {
  writeDerivedSummary();
}
