import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, extname, join, normalize, relative } from 'node:path';
import { nanoid } from 'nanoid';

export interface ScanProjectInput {
  rootPath: string;
  projectName: string;
  ignoreDirectories?: string[];
  additionalFiles?: Array<{
    absolutePath: string;
    relativePath: string;
  }>;
}

export interface ScannedFile {
  absolutePath: string;
  relativePath: string;
  extension: string;
  size: number;
  sourceHash: string;
}

interface ScannedFileCandidate {
  absolutePath: string;
  relativePath: string;
  extension: string;
  size: number;
}

interface ScannedFileWithContent {
  file: ScannedFile;
  content: string;
}

export interface CodeSymbolFact {
  id: string;
  symbolType: 'package' | 'function' | 'class' | 'interface' | 'type' | 'enum' | 'file' | 'heading' | 'table' | 'column' | 'api' | 'control_flow' | 'sql_call' | 'function_call' | 'import' | 'export' | 'config' | 'dependency';
  name: string;
  qualifiedName: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  language: string;
  sourceHash: string;
  metadata: Record<string, unknown>;
}

export interface ProjectScanResult {
  projectName: string;
  rootPath: string;
  files: ScannedFile[];
  symbols: CodeSymbolFact[];
}

const defaultIgnoredDirectories = ['.git', 'node_modules', 'dist', '.tmp', 'coverage', '.DS_Store', 'target', 'build', 'out', '.gradle', '.idea', '.vscode'];
const supportedExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.json', '.md', '.xml', '.sql', '.java', '.gradle', '.kts', '.yml', '.yaml', '.properties']);
const SCAN_FILE_READ_CONCURRENCY = 32;

interface ImportResolution {
  resolvedRelativePath?: string;
  resolutionKind: 'relative' | 'tsconfig_paths' | 'package_exports' | 'external';
  packageName?: string;
  runtimeEnvironment?: 'browser' | 'node' | 'default';
  matchedExportConditions?: string[];
  availableExportConditions?: string[];
}

type ImportTarget = {
  resolvedRelativePath: string;
  resolutionKind: 'tsconfig_paths' | 'package_exports';
  packageName?: string;
  runtimeEnvironment?: 'browser' | 'node' | 'default';
  matchedExportConditions?: string[];
  availableExportConditions?: string[];
};

type ImportTargetMap = Map<string, ImportTarget>;
type JavaImportTargetMap = Map<string, string>;
type JavaMethodMatch = {
  annotationsBlock: string;
  methodName: string;
  parameters: string;
  absoluteIndex: number;
  methodBodyOpenIndex: number;
};

/** 扫描真实项目目录，所有事实都带文件路径和源码 hash。 */
export async function scanProjectSource(input: ScanProjectInput): Promise<ProjectScanResult> {
  const fileCandidates = await listSourceFiles(input.rootPath, input.ignoreDirectories, input.additionalFiles);
  const fileContents = await readScannedFilesWithContent(fileCandidates);
  const files = fileContents.map(({ file }) => file);
  const contentByAbsolutePath = buildScannedFileContentMap(fileContents);
  const importTargets = await readImportTargets(input.rootPath, files, contentByAbsolutePath);
  const knownRelativePaths = buildKnownRelativePathSet(files);
  const javaImportTargets = buildJavaImportTargetMap(files);
  const symbols: CodeSymbolFact[] = [];
  for (const { file, content } of fileContents) {
    symbols.push(...extractSymbols(input.rootPath, file, content, knownRelativePaths, importTargets, javaImportTargets));
  }
  return {
    projectName: input.projectName,
    rootPath: input.rootPath,
    files,
    symbols,
  };
}

async function listSourceFiles(rootPath: string, ignoreDirectories: string[] = [], additionalFiles: ScanProjectInput['additionalFiles'] = []): Promise<ScannedFileCandidate[]> {
  const ignoredDirectories = new Set([...defaultIgnoredDirectories, ...ignoreDirectories.filter(isSafeIgnoredDirectoryName)]);
  const results: ScannedFileCandidate[] = [];
  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (ignoredDirectories.has(entry.name)) continue;
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const extension = extname(entry.name);
      if (!supportedExtensions.has(extension)) continue;
      const info = await stat(absolutePath);
      results.push({
        absolutePath,
        relativePath: relative(rootPath, absolutePath),
        extension,
        size: info.size,
      });
    }
  }
  await walk(rootPath);
  const seenAbsolutePaths = new Set(results.map((file) => file.absolutePath));
  for (const additionalFile of additionalFiles) {
    if (seenAbsolutePaths.has(additionalFile.absolutePath)) continue;
    const extension = extname(additionalFile.absolutePath);
    if (!supportedExtensions.has(extension)) continue;
    const info = await stat(additionalFile.absolutePath);
    if (!info.isFile()) continue;
    results.push({
      absolutePath: additionalFile.absolutePath,
      // 用户导入的 DDL 可能位于 src 扫描范围外；保留相对项目根的真实来源，避免显示 ../schema 这类实现细节。
      relativePath: normalize(additionalFile.relativePath),
      extension,
      size: info.size,
    });
    seenAbsolutePaths.add(additionalFile.absolutePath);
  }
  return results.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

/** 并发读取源码并一次性产出内容与 hash，避免大仓扫描在串行二次读文件时卡住主流程。 */
async function readScannedFilesWithContent(fileCandidates: ScannedFileCandidate[]): Promise<ScannedFileWithContent[]> {
  const results: ScannedFileWithContent[] = [];
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < fileCandidates.length) {
      const index = cursor;
      cursor += 1;
      const candidate = fileCandidates[index];
      if (!candidate) continue;
      const bytes = await readFile(candidate.absolutePath);
      const content = bytes.toString('utf8');
      results[index] = {
        file: {
          ...candidate,
          sourceHash: createHash('sha256').update(bytes).digest('hex'),
        },
        content,
      };
    }
  }

  const workerCount = Math.min(SCAN_FILE_READ_CONCURRENCY, fileCandidates.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results.filter((item): item is ScannedFileWithContent => Boolean(item));
}

function buildScannedFileContentMap(fileContents: ScannedFileWithContent[]): Map<string, string> {
  return new Map(fileContents.map(({ file, content }) => [file.absolutePath, content]));
}

function isSafeIgnoredDirectoryName(value: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(value) && !value.includes('..') && value.length <= 80;
}

/** 读取 tsconfig paths 作为 workspace 包解析依据，避免在扫描器里维护易漂移的硬编码入口表。 */
async function readImportTargets(rootPath: string, files: ScannedFile[], contentByAbsolutePath: Map<string, string>): Promise<ImportTargetMap> {
  return new Map([...(await readWorkspacePackageExportAliases(rootPath, files, contentByAbsolutePath)), ...(await readWorkspaceTsconfigPathAliases(rootPath, files)), ...(await readTsconfigPathAliases(rootPath))]);
}

async function readTsconfigPathAliases(rootPath: string): Promise<ImportTargetMap> {
  try {
    const content = await readFile(join(rootPath, 'tsconfig.base.json'), 'utf8');
    const parsed = parseJsonConfig(content) as {
      compilerOptions?: { paths?: Record<string, unknown> };
    };
    const entries = Object.entries(parsed.compilerOptions?.paths ?? {});
    return new Map(
      entries.flatMap(([specifier, targets]) => {
        if (!Array.isArray(targets) || typeof targets[0] !== 'string') return [];
        return [
          [
            specifier,
            {
              resolvedRelativePath: normalize(targets[0]),
              resolutionKind: 'tsconfig_paths' as const,
              packageName: packageNameForImportSource(specifier),
            },
          ],
        ];
      }),
    );
  } catch {
    // tsconfig 缺失或解析失败时仍允许扫描继续，未解析 import 会标记 external。
    return new Map();
  }
}

async function readWorkspaceTsconfigPathAliases(rootPath: string, files: ScannedFile[]): Promise<ImportTargetMap> {
  const aliases: ImportTargetMap = new Map();
  for (const file of files.filter((item) => item.relativePath.endsWith('tsconfig.json') && item.relativePath !== 'tsconfig.json')) {
    try {
      const parsed = await readMergedTsconfig(rootPath, file.relativePath);
      const tsconfigDirectory = dirname(file.relativePath);
      const baseUrl = parsed.compilerOptions?.baseUrl ? normalize(join(tsconfigDirectory, parsed.compilerOptions.baseUrl)) : tsconfigDirectory;
      for (const [specifier, targets] of Object.entries(parsed.compilerOptions?.paths ?? {})) {
        if (!Array.isArray(targets) || typeof targets[0] !== 'string') continue;
        const targetPattern = normalize(join(baseUrl, targets[0]));
        if (specifier.includes('*') && targetPattern.includes('*')) {
          const specifierPrefix = specifier.split('*')[0] ?? '';
          const specifierSuffix = specifier.split('*')[1] ?? '';
          const targetPrefix = targetPattern.split('*')[0] ?? '';
          const targetSuffix = targetPattern.split('*')[1] ?? '';
          for (const candidate of files) {
            if (!candidate.relativePath.startsWith(targetPrefix) || !candidate.relativePath.endsWith(targetSuffix)) continue;
            const matchedPart = candidate.relativePath.slice(targetPrefix.length, candidate.relativePath.length - targetSuffix.length);
            const aliasKey = `${specifierPrefix}${matchedPart}${specifierSuffix}`;
            const target = {
              resolvedRelativePath: candidate.relativePath,
              resolutionKind: 'tsconfig_paths' as const,
              packageName: packageNameForImportSource(specifier),
            };
            aliases.set(aliasKey, target);
            aliases.set(aliasKey.replace(/\.(?:ts|tsx|js|jsx)$/u, ''), target);
          }
          continue;
        }
        aliases.set(specifier, {
          resolvedRelativePath: targetPattern,
          resolutionKind: 'tsconfig_paths',
          packageName: packageNameForImportSource(specifier),
        });
      }
    } catch {
      // 子项目 tsconfig 缺失或解析失败时跳过该文件，不影响其余项目扫描。
    }
  }
  return aliases;
}

async function readMergedTsconfig(
  rootPath: string,
  relativePath: string,
  visited: Set<string> = new Set(),
): Promise<{
  compilerOptions?: { baseUrl?: string; paths?: Record<string, unknown> };
}> {
  const normalizedPath = normalize(relativePath);
  if (visited.has(normalizedPath)) return {};
  visited.add(normalizedPath);
  const content = await readFile(join(rootPath, normalizedPath), 'utf8');
  const parsed = parseJsonConfig(content) as {
    extends?: string;
    compilerOptions?: { baseUrl?: string; paths?: Record<string, unknown> };
  };
  const parentPath = await resolveTsconfigExtendsPath(rootPath, dirname(normalizedPath), parsed.extends);
  if (!parentPath) return parsed;
  const parent = await readMergedTsconfig(rootPath, parentPath, visited);
  const rebasedParent = rebaseParentTsconfig(parent, dirname(parentPath), dirname(normalizedPath));
  return {
    ...rebasedParent,
    ...parsed,
    compilerOptions: {
      ...(rebasedParent.compilerOptions ?? {}),
      ...(parsed.compilerOptions ?? {}),
      paths: {
        ...(rebasedParent.compilerOptions?.paths ?? {}),
        ...(parsed.compilerOptions?.paths ?? {}),
      },
    },
  };
}

/** 解析 tsconfig 常见 JSONC 语法：注释与尾逗号；避免把注释内 alias 当成真实配置。 */
function parseJsonConfig(content: string): unknown {
  return JSON.parse(stripJsonCommentsAndTrailingCommas(content));
}

function stripJsonCommentsAndTrailingCommas(content: string): string {
  let output = '';
  let inString = false;
  let escapeNext = false;
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index] ?? '';
    const next = content[index + 1] ?? '';
    if (inString) {
      output += char;
      if (escapeNext) {
        escapeNext = false;
      } else if (char === '\\') {
        escapeNext = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }
    if (char === '/' && next === '/') {
      while (index < content.length && content[index] !== '\n') index += 1;
      output += '\n';
      continue;
    }
    if (char === '/' && next === '*') {
      index += 2;
      while (index < content.length && !(content[index] === '*' && content[index + 1] === '/')) index += 1;
      index += 1;
      continue;
    }
    output += char;
  }
  return output.replace(/,\s*([}\]])/gu, '$1');
}

function rebaseParentTsconfig(
  config: {
    compilerOptions?: { baseUrl?: string; paths?: Record<string, unknown> };
  },
  parentDirectory: string,
  childDirectory: string,
): typeof config {
  if (!config.compilerOptions?.baseUrl) return config;
  const parentBaseUrlFromRoot = normalize(join(parentDirectory, config.compilerOptions.baseUrl));
  return {
    ...config,
    compilerOptions: {
      ...config.compilerOptions,
      // 父配置可能来自 node_modules；转成相对当前子配置目录的 baseUrl，避免 paths target 被错误拼接。
      baseUrl: relative(childDirectory, parentBaseUrlFromRoot) || '.',
    },
  };
}

async function resolveTsconfigExtendsPath(rootPath: string, tsconfigDirectory: string, extendsValue?: string): Promise<string | undefined> {
  if (!extendsValue) return undefined;
  if (extendsValue.startsWith('.')) {
    const withExtension = extendsValue.endsWith('.json') ? extendsValue : `${extendsValue}.json`;
    return normalize(join(tsconfigDirectory, withExtension));
  }
  return resolvePackageTsconfigExtendsPath(rootPath, extendsValue);
}

async function resolvePackageTsconfigExtendsPath(rootPath: string, extendsValue: string): Promise<string | undefined> {
  const { packageName, subpath } = splitPackageExtendsValue(extendsValue);
  const packageDirectory = normalize(join('node_modules', packageName));
  if (subpath) {
    return normalize(join(packageDirectory, subpath.endsWith('.json') ? subpath : `${subpath}.json`));
  }
  try {
    const content = await readFile(join(rootPath, packageDirectory, 'package.json'), 'utf8');
    const parsed = parseJsonConfig(content) as {
      tsconfig?: string;
      main?: string;
    };
    const entry = parsed.tsconfig ?? parsed.main ?? 'tsconfig.json';
    return normalize(join(packageDirectory, entry.endsWith('.json') ? entry : `${entry}.json`));
  } catch {
    return normalize(join(packageDirectory, 'tsconfig.json'));
  }
}

function splitPackageExtendsValue(extendsValue: string): {
  packageName: string;
  subpath: string;
} {
  const parts = extendsValue.split('/');
  if (extendsValue.startsWith('@')) {
    return {
      packageName: `${parts[0]}/${parts[1]}`,
      subpath: parts.slice(2).join('/'),
    };
  }
  return {
    packageName: parts[0] ?? extendsValue,
    subpath: parts.slice(1).join('/'),
  };
}

async function readWorkspacePackageExportAliases(rootPath: string, files: ScannedFile[], contentByAbsolutePath: Map<string, string>): Promise<ImportTargetMap> {
  const aliases: ImportTargetMap = new Map();
  for (const file of files.filter((item) => item.relativePath.endsWith('package.json'))) {
    try {
      const content = contentByAbsolutePath.get(file.absolutePath);
      if (!content) continue;
      const parsed = JSON.parse(content) as {
        name?: string;
        exports?: unknown;
        main?: string;
        types?: string;
      };
      if (!parsed.name) continue;
      const packageRoot = dirname(file.relativePath);
      for (const entry of packageExportEntries(parsed.exports, parsed.main, parsed.types)) {
        if (entry.subpath.includes('*')) {
          const subpathPrefix = entry.subpath.replace(/^\.\//u, '').split('*')[0] ?? '';
          const subpathSuffix = entry.subpath.split('*')[1] ?? '';
          for (const candidate of files) {
            const relativeToPackage = normalize(candidate.relativePath.slice(packageRoot.length + 1));
            for (const targetPattern of entry.targets.filter((target) => target.includes('*'))) {
              const targetPrefix = normalize(targetPattern.replace(/^\.\//u, '').split('*')[0] ?? '');
              const targetSuffix = targetPattern.split('*')[1] ?? '';
              if (!relativeToPackage.startsWith(targetPrefix) || !relativeToPackage.endsWith(targetSuffix)) continue;
              const matchedPart = relativeToPackage.slice(targetPrefix.length, relativeToPackage.length - targetSuffix.length);
              setPackageExportAlias(aliases, `${parsed.name}/${subpathPrefix}${matchedPart}${subpathSuffix}`, {
                resolvedRelativePath: normalize(join(packageRoot, relativeToPackage)),
                resolutionKind: 'package_exports',
                packageName: parsed.name,
                runtimeEnvironment: entry.runtimeEnvironment,
                matchedExportConditions: entry.matchedConditions,
                availableExportConditions: entry.availableConditions,
              });
            }
          }
          continue;
        }
        const target = entry.targets[0];
        if (!target) continue;
        const normalizedTarget = normalize(join(packageRoot, target.replace(/^\.\//u, '')));
        setPackageExportAlias(aliases, entry.subpath === '.' ? parsed.name : `${parsed.name}/${entry.subpath.replace(/^\.\//u, '')}`, {
          resolvedRelativePath: normalizedTarget,
          resolutionKind: 'package_exports',
          packageName: parsed.name,
          runtimeEnvironment: entry.runtimeEnvironment,
          matchedExportConditions: entry.matchedConditions,
          availableExportConditions: entry.availableConditions,
        });
      }
    } catch {
      // package.json 无法解析时不创建 package exports 事实，避免伪造模块入口。
    }
  }
  return aliases;
}

function setPackageExportAlias(aliases: ImportTargetMap, importSource: string, target: ImportTarget): void {
  aliases.set(importSource, target);
  // 只有真实 exports 条件才生成运行端专用别名；main/types fallback 需允许 tsconfig paths 覆盖到源码入口。
  if (target.runtimeEnvironment && !target.matchedExportConditions?.includes('main')) aliases.set(`${importSource}::${target.runtimeEnvironment}`, target);
}

type PackageExportEntry = {
  subpath: string;
  targets: string[];
  runtimeEnvironment: 'browser' | 'node' | 'default';
  matchedConditions: string[];
  availableConditions: string[];
};

const packageExportConditionProfiles: Array<{
  runtimeEnvironment: 'browser' | 'node' | 'default';
  conditions: string[];
}> = [
  {
    runtimeEnvironment: 'browser',
    conditions: ['browser', 'development', 'import', 'default', 'types', 'production', 'node', 'require'],
  },
  {
    runtimeEnvironment: 'node',
    conditions: ['node', 'development', 'import', 'default', 'types', 'production', 'browser', 'require'],
  },
  {
    runtimeEnvironment: 'default',
    conditions: ['browser', 'development', 'import', 'default', 'types', 'production', 'node', 'require'],
  },
];

function packageExportEntries(exportsValue: unknown, mainValue?: string, typesValue?: string): PackageExportEntry[] {
  if (!exportsValue) {
    const fallback = mainValue ?? typesValue;
    return fallback
      ? packageExportConditionProfiles.map((profile) => ({
          subpath: '.',
          targets: [fallback],
          runtimeEnvironment: profile.runtimeEnvironment,
          matchedConditions: ['main'],
          availableConditions: ['main'],
        }))
      : [];
  }
  if (typeof exportsValue === 'string') {
    return packageExportConditionProfiles.map((profile) => ({
      subpath: '.',
      targets: [exportsValue],
      runtimeEnvironment: profile.runtimeEnvironment,
      matchedConditions: ['exports'],
      availableConditions: ['exports'],
    }));
  }
  if (!exportsValue || typeof exportsValue !== 'object' || Array.isArray(exportsValue)) return [];
  if (isPackageExportConditionMap(exportsValue)) {
    return packageExportConditionProfiles.flatMap((profile) => {
      const resolved = resolvePackageExportTargets(exportsValue, profile.conditions);
      return resolved.targets.length > 0
        ? [
            {
              subpath: '.',
              targets: resolved.targets,
              runtimeEnvironment: profile.runtimeEnvironment,
              matchedConditions: resolved.matchedConditions,
              availableConditions: resolved.availableConditions,
            },
          ]
        : [];
    });
  }
  return Object.entries(exportsValue).flatMap(([subpath, target]) => {
    return packageExportConditionProfiles.flatMap((profile) => {
      const resolved = resolvePackageExportTargets(target, profile.conditions);
      return resolved.targets.length > 0
        ? [
            {
              subpath,
              targets: resolved.targets,
              runtimeEnvironment: profile.runtimeEnvironment,
              matchedConditions: resolved.matchedConditions,
              availableConditions: resolved.availableConditions,
            },
          ]
        : [];
    });
  });
}

function isPackageExportConditionMap(exportsValue: object): boolean {
  return Object.keys(exportsValue).every((key) => !key.startsWith('.'));
}

function resolvePackageExportTargets(
  target: unknown,
  conditions: string[],
  matchedConditions: string[] = [],
  availableConditions: string[] = [],
): {
  targets: string[];
  matchedConditions: string[];
  availableConditions: string[];
} {
  if (typeof target === 'string') return { targets: [target], matchedConditions, availableConditions };
  if (Array.isArray(target)) {
    const targets = target.flatMap((item) => resolvePackageExportTargets(item, conditions, matchedConditions, availableConditions).targets);
    return { targets, matchedConditions, availableConditions };
  }
  if (!target || typeof target !== 'object') return { targets: [], matchedConditions, availableConditions };
  const record = target as Record<string, unknown>;
  const nextAvailableConditions = uniqueStrings([...availableConditions, ...Object.keys(record).filter((key) => !key.startsWith('.'))]);
  for (const condition of conditions) {
    if (!(condition in record)) continue;
    const resolved = resolvePackageExportTargets(record[condition], conditions, [...matchedConditions, condition], nextAvailableConditions);
    if (resolved.targets.length > 0) return resolved;
  }
  return {
    targets: [],
    matchedConditions,
    availableConditions: nextAvailableConditions,
  };
}

function extractSymbols(rootPath: string, file: ScannedFile, content: string, knownRelativePaths: Set<string>, importTargets: ImportTargetMap, javaImportTargets: JavaImportTargetMap): CodeSymbolFact[] {
  const language = detectLanguage(file.extension);
  const symbols: CodeSymbolFact[] = [
    makeSymbol('file', file.relativePath, file.relativePath, file.absolutePath, 1, Math.max(1, content.split('\n').length), language, file.sourceHash, {
      relativePath: file.relativePath,
      size: file.size,
    }),
  ];
  if (file.relativePath.endsWith('package.json')) {
    try {
      const parsed = JSON.parse(content) as { name?: string };
      if (parsed.name) {
        symbols.push(makeSymbol('package', parsed.name, parsed.name, file.absolutePath, 1, 1, 'json', file.sourceHash, { rootPath }));
      }
    } catch {
      // package.json 解析失败时只保留 file fact，避免伪造包信息。
    }
  }
  symbols.push(...extractImportExportSymbols(file, content, language, knownRelativePaths, importTargets));
  symbols.push(...extractJavaImportSymbols(file, content, language, javaImportTargets));
  symbols.push(...extractSqlTableSymbols(file, content, language));
  symbols.push(...extractFastifyApiSymbols(file, content, language));
  symbols.push(...extractJavaSpringSymbols(file, content, language));
  symbols.push(...extractMyBatisXmlSymbols(file, content, language));
  symbols.push(...extractMavenBuildSymbols(file, content, language));
  symbols.push(...extractGradleBuildSymbols(file, content, language));
  symbols.push(...extractControlFlowSymbols(file, content, language));
  symbols.push(...extractSqlCallSymbols(file, content, language));
  symbols.push(...extractFunctionCallSymbols(file, content, language, importTargets));
  symbols.push(...extractClassMethodSymbols(file, content, language));
  const lines = content.split('\n');
  lines.forEach((line, index) => {
    const lineNo = index + 1;
    const codeMatch = line.match(/\b(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/u);
    if (codeMatch?.[1]) {
      const keyword = line.includes('class ') ? 'class' : line.includes('interface ') ? 'interface' : line.includes('type ') ? 'type' : line.includes('enum ') ? 'enum' : 'function';
      symbols.push(makeSymbol(keyword, codeMatch[1], `${file.relativePath}#${codeMatch[1]}`, file.absolutePath, lineNo, lineNo, language, file.sourceHash, {}));
    }
    const headingMatch = language === 'markdown' ? line.match(/^(#{1,6})\s+(.+)$/u) : undefined;
    if (headingMatch?.[2]) {
      symbols.push(makeSymbol('heading', headingMatch[2].trim(), `${file.relativePath}#L${lineNo}`, file.absolutePath, lineNo, lineNo, language, file.sourceHash, { level: headingMatch[1].length }));
    }
  });
  return symbols;
}

/** 从 TypeScript/JavaScript 源码行抽取方法逻辑图需要的真实控制流事实。 */
function extractControlFlowSymbols(file: ScannedFile, content: string, language: string): CodeSymbolFact[] {
  if (!['typescript', 'javascript'].includes(language)) return [];
  const symbols: CodeSymbolFact[] = [];
  const functionRanges = extractFunctionRanges(file, content);
  const controlPatterns: Array<{
    type: string;
    pattern: RegExp;
    metadata?: (line: string) => Record<string, unknown>;
  }> = [
    { type: 'try', pattern: /\btry\b/u },
    // Promise 链的 .catch(...) 是异步异常分支，不应误归类为语句级 catch。
    {
      type: 'promise_catch',
      pattern: /\.catch\s*\(/u,
      metadata: () => ({
        promiseChainHandler: 'catch',
        sourceKind: 'typescript_promise_chain_control_flow',
      }),
    },
    {
      type: 'promise_then',
      pattern: /\.then\s*\(/u,
      metadata: () => ({
        promiseChainHandler: 'then',
        sourceKind: 'typescript_promise_chain_control_flow',
      }),
    },
    { type: 'catch', pattern: /\bcatch(?:\s*\(|\s*\{)/u },
    // finally 是异常处理的真实收尾分支，方法逻辑图需要保留它以呈现资源释放路径。
    { type: 'finally', pattern: /\bfinally\s*\{/u },
    { type: 'if', pattern: /\bif\s*\(/u },
    { type: 'else', pattern: /\belse\b/u },
    {
      type: 'loop',
      pattern: /\b(?:for|while)\s*\(|\.forEach\s*\(/u,
      metadata: (line) => ({ loopKind: detectLoopKind(line) }),
    },
    { type: 'return', pattern: /\breturn\b/u },
    { type: 'throw', pattern: /\bthrow\b/u },
    // 仅匹配语句形式，避免把字符串字面量中的 continue/break 误识别为控制流。
    { type: 'continue', pattern: /(?:^\s*|[{};]\s*|\)\s*)continue\s*;/u },
    { type: 'break', pattern: /(?:^\s*|[{};]\s*|\)\s*)break\s*;/u },
  ];
  content.split('\n').forEach((line, index) => {
    const trimmedLine = line.trim();
    if (!trimmedLine || trimmedLine.startsWith('//')) return;
    const lineNo = index + 1;
    for (const control of controlPatterns) {
      if (!control.pattern.test(line)) continue;
      const ownerFunction = findInnermostFunctionRange(functionRanges, lineNo);
      symbols.push(
        makeSymbol('control_flow', `${control.type} L${lineNo}`, `${file.relativePath}#control:${control.type}:L${lineNo}`, file.absolutePath, lineNo, lineNo, language, file.sourceHash, {
          controlType: control.type,
          snippet: trimmedLine.slice(0, 160),
          sourceKind: 'typescript_control_flow',
          ...(control.metadata?.(line) ?? {}),
          ...(ownerFunction
            ? {
                ownerFunction: ownerFunction.name,
                ownerQualifiedName: ownerFunction.qualifiedName,
                ownerLineStart: ownerFunction.lineStart,
                ownerLineEnd: ownerFunction.lineEnd,
              }
            : {}),
        }),
      );
    }
  });
  return symbols;
}

/** 从源码中的 SQL 执行片段抽取方法逻辑图需要的真实 SQL 调用事实。 */
function extractSqlCallSymbols(file: ScannedFile, content: string, language: string): CodeSymbolFact[] {
  if (!['typescript', 'javascript', 'sql'].includes(language)) return [];
  const symbols: CodeSymbolFact[] = [];
  const functionRanges = extractFunctionRanges(file, content);
  const lines = content.split('\n');
  lines.forEach((line, index) => {
    const trimmedLine = line.trim();
    if (!trimmedLine || trimmedLine.startsWith('//') || /\bCREATE\s+TABLE\b/iu.test(line)) return;
    const operation = line.match(/\b(SELECT|INSERT|UPDATE|DELETE)\b/iu)?.[1]?.toUpperCase();
    if (!operation) return;
    const statement = collectSqlStatementSnippet(lines, index);
    const tableNames = extractSqlCallTableNames(statement.text, operation);
    if (tableNames.length === 0) return;
    const lineNo = index + 1;
    const ownerFunction = findInnermostFunctionRange(functionRanges, lineNo);
    symbols.push(
      makeSymbol('sql_call', `${operation} ${tableNames.join(', ')} L${lineNo}`, `${file.relativePath}#sql_call:${operation}:L${lineNo}`, file.absolutePath, lineNo, statement.lineEnd, language, file.sourceHash, {
        operation,
        tableNames,
        // 保留压缩后的真实 SQL 片段，避免多行模板字符串在图谱中断裂。
        tableQualifiedNames: tableNames.map((tableName) => `${file.relativePath}#table:${tableName}`),
        accessMode: operation === 'SELECT' ? 'read' : 'write',
        ...extractSqlFieldAccessMetadata(statement.text, operation),
        snippet: statement.text.replace(/\s+/gu, ' ').trim().slice(0, 180),
        sourceKind: language === 'sql' ? 'sql_file_call' : 'embedded_sql_call',
        ...(ownerFunction
          ? {
              ownerFunction: ownerFunction.name,
              ownerQualifiedName: ownerFunction.qualifiedName,
              ownerLineStart: ownerFunction.lineStart,
              ownerLineEnd: ownerFunction.lineEnd,
            }
          : {}),
      }),
    );
  });
  return symbols;
}

/** 抽取 Java/Spring 的真实类、方法、接口入口与同文件调用事实；无注解时不伪造 API。 */
function extractJavaSpringSymbols(file: ScannedFile, content: string, language: string): CodeSymbolFact[] {
  if (language !== 'java') return [];
  const symbols: CodeSymbolFact[] = [];
  const packageName = content.match(/\bpackage\s+([A-Za-z_$][\w$.]*)\s*;/u)?.[1] ?? '';
  const classMatches = [...content.matchAll(/((?:@\w+(?:\([^)]*\))?\s*)*)\b(public\s+)?(class|interface|enum)\s+([A-Za-z_$][\w$]*)/gu)];
  for (const match of classMatches) {
    const annotations = parseJavaAnnotations(match[1] ?? '');
    const classKind = match[3] === 'interface' ? 'interface' : match[3] === 'enum' ? 'enum' : 'class';
    const className = match[4] ?? '';
    const lineNo = lineNumberAt(content, match.index ?? 0);
    const qualifiedName = `${file.relativePath}#${className}`;
    const stereotype = javaStereotypeForAnnotations(annotations, classKind);
    symbols.push(
      makeSymbol(classKind, className, qualifiedName, file.absolutePath, lineNo, lineNo, language, file.sourceHash, {
        sourceKind: classKind === 'interface' ? 'java_interface' : 'java_class',
        packageName,
        className,
        annotations,
        ...(stereotype ? { stereotype } : {}),
        ...javaRemoteClientMetadata(annotations),
      }),
    );
  }

  for (const classMatch of classMatches) {
    const annotations = parseJavaAnnotations(classMatch[1] ?? '');
    const className = classMatch[4] ?? '';
    const classStart = classMatch.index ?? 0;
    const nextClassStart = classMatches.find((candidate) => (candidate.index ?? 0) > classStart)?.index ?? content.length;
    const classBody = content.slice(classStart, nextClassStart);
    const classBasePath = requestMappingPath(annotations);
    const classQualifiedName = `${file.relativePath}#${className}`;
    const methodMatches = extractJavaMethodMatches(classBody, classStart);
    for (const methodMatch of methodMatches) {
      const methodAnnotations = parseJavaAnnotations(methodMatch.annotationsBlock);
      const methodName = methodMatch.methodName;
      const absoluteIndex = methodMatch.absoluteIndex;
      const methodBodyOpenIndex = methodMatch.methodBodyOpenIndex;
      const lineNo = lineNumberAt(content, absoluteIndex);
      const methodQualifiedName = `${classQualifiedName}.${methodName}`;
      const methodEndLine = findJavaBlockEndLineFromOpenBrace(content, methodBodyOpenIndex);
      symbols.push(
        makeSymbol('function', methodName, methodQualifiedName, file.absolutePath, lineNo, methodEndLine, language, file.sourceHash, {
          sourceKind: 'java_method',
          packageName,
          className,
          methodName,
          parameters: methodMatch.parameters,
          annotations: methodAnnotations,
          // Spring 方法级事务与异步注解是设计书要求的真实代码图谱事实，显式结构化后方便视图和搜索过滤。
          ...javaMethodBehaviorForAnnotations(methodAnnotations),
          ...javaMethodEntryPointForAnnotations(methodAnnotations),
        }),
      );

      const route = javaRouteForAnnotations(classBasePath, methodAnnotations);
      if (route) {
        symbols.push(
          makeSymbol('api', `${route.method} ${route.path}`, `${file.relativePath}#api:${route.method}:${route.path}`, file.absolutePath, lineNo, lineNo, language, file.sourceHash, {
            sourceKind: 'spring_mapping',
            framework: 'spring',
            method: route.method,
            path: route.path,
            className,
            methodName,
            handlerQualifiedName: methodQualifiedName,
            handlerLineStart: lineNo,
            handlerLineEnd: methodEndLine,
          }),
        );
      }

      const methodBody = extractJavaBlockFromOpenBrace(content, methodBodyOpenIndex);
      for (const call of javaMethodCalls(methodBody.text)) {
        const callLine = lineNo + lineNumberAt(methodBody.text, call.index) - 1;
        symbols.push(
          makeSymbol('function_call', `${call.expression} L${callLine}`, `${file.relativePath}#call:${call.expression}:L${callLine}`, file.absolutePath, callLine, callLine, language, file.sourceHash, {
            sourceKind: 'java_function_call',
            calleeExpression: call.expression,
            targetHint: call.methodName,
            ownerFunction: methodName,
            ownerQualifiedName: methodQualifiedName,
            ownerLineStart: lineNo,
            ownerLineEnd: methodEndLine,
          }),
        );
      }
    }
  }
  return symbols;
}

interface ParsedJavaAnnotation {
  name: string;
  value?: string;
}

function extractJavaMethodMatches(classBody: string, classStart: number): JavaMethodMatch[] {
  const matches: JavaMethodMatch[] = [];
  const javaMethodSignaturePattern = /^\s*public\s+(?:[A-Za-z_$][\w$]*(?:<[^>\n]+>)?(?:\[\])?\s+)+([A-Za-z_$][\w$]*)\s*\(([^)\n]*)\)\s*\{/u;
  const lines = classBody.split('\n');
  let offset = 0;
  let annotationsBlock = '';
  let annotationsStartOffset = 0;

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (trimmedLine.startsWith('@')) {
      if (!annotationsBlock) annotationsStartOffset = offset;
      annotationsBlock += `${line}\n`;
      offset += line.length + 1;
      continue;
    }

    const signatureMatch = line.match(javaMethodSignaturePattern);
    if (signatureMatch?.[1]) {
      const methodBodyOpenIndex = line.indexOf('{');
      matches.push({
        annotationsBlock,
        methodName: signatureMatch[1],
        parameters: signatureMatch[2]?.trim() ?? '',
        absoluteIndex: classStart + (annotationsBlock ? annotationsStartOffset : offset),
        methodBodyOpenIndex: classStart + offset + methodBodyOpenIndex,
      });
    }

    if (trimmedLine && !trimmedLine.startsWith('//')) annotationsBlock = '';
    offset += line.length + 1;
  }

  return matches;
}

function parseJavaAnnotations(block: string): ParsedJavaAnnotation[] {
  return [...block.matchAll(/@([A-Za-z_$][\w$]*)(?:\(([^)]*)\))?/gu)].map((match) => ({
    name: match[1] ?? '',
    value: normalizeJavaAnnotationValue(match[2]),
  }));
}

function normalizeJavaAnnotationValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const pathMatch = value.match(/"([^"]*)"/u);
  return pathMatch?.[1] ?? value.trim();
}

function javaStereotypeForAnnotations(annotations: ParsedJavaAnnotation[], classKind: string): string | undefined {
  const names = new Set(annotations.map((annotation) => annotation.name));
  if (names.has('SpringBootApplication')) return 'spring_boot_application';
  if (names.has('FeignClient')) return 'remote_client';
  if (names.has('RestController') || names.has('Controller')) return 'controller';
  if (names.has('Service')) return 'service';
  if (names.has('Repository')) return 'repository';
  if (names.has('Mapper') && classKind === 'interface') return 'mybatis_mapper';
  if (names.has('Component')) return 'component';
  return undefined;
}

function javaRemoteClientMetadata(annotations: ParsedJavaAnnotation[]): {
  remoteClientName?: string;
} {
  const feignClient = annotations.find((annotation) => annotation.name === 'FeignClient');
  return feignClient?.value ? { remoteClientName: feignClient.value } : {};
}

function javaMethodBehaviorForAnnotations(annotations: ParsedJavaAnnotation[]): { transactional?: boolean; async?: boolean } {
  const names = new Set(annotations.map((annotation) => annotation.name));
  return {
    ...(names.has('Transactional') ? { transactional: true } : {}),
    ...(names.has('Async') ? { async: true } : {}),
  };
}

function javaMethodEntryPointForAnnotations(annotations: ParsedJavaAnnotation[]): {
  entryPoint?: 'mq_consumer' | 'job';
  topics?: string[];
  schedule?: string;
} {
  const kafkaListener = annotations.find((annotation) => annotation.name === 'KafkaListener');
  if (kafkaListener) {
    // MQ consumer 入口来自真实监听注解；仅输出注解里能读到的 topic，不根据类名猜测。
    return {
      entryPoint: 'mq_consumer',
      ...(kafkaListener.value ? { topics: [kafkaListener.value] } : {}),
    };
  }
  const scheduled = annotations.find((annotation) => annotation.name === 'Scheduled');
  if (scheduled) {
    // Job 入口来自真实调度注解；cron/fixedRate 等表达式按原始字符串保留给图谱展示。
    return {
      entryPoint: 'job',
      ...(scheduled.value ? { schedule: scheduled.value } : {}),
    };
  }
  return {};
}

function requestMappingPath(annotations: ParsedJavaAnnotation[]): string {
  return annotations.find((annotation) => annotation.name === 'RequestMapping')?.value ?? '';
}

function javaRouteForAnnotations(basePath: string, annotations: ParsedJavaAnnotation[]): { method: string; path: string } | undefined {
  const mapping = annotations.find((annotation) => ['GetMapping', 'PostMapping', 'PutMapping', 'PatchMapping', 'DeleteMapping', 'RequestMapping'].includes(annotation.name));
  if (!mapping) return undefined;
  const methodByAnnotation: Record<string, string> = {
    GetMapping: 'GET',
    PostMapping: 'POST',
    PutMapping: 'PUT',
    PatchMapping: 'PATCH',
    DeleteMapping: 'DELETE',
    RequestMapping: 'REQUEST',
  };
  return {
    method: methodByAnnotation[mapping.name] ?? 'REQUEST',
    path: joinUrlPath(basePath, mapping.value ?? ''),
  };
}

function joinUrlPath(left: string, right: string): string {
  const combined = `/${[left, right]
    .map((part) => part.trim().replace(/^\/+|\/+$/gu, ''))
    .filter(Boolean)
    .join('/')}`;
  return combined === '/' ? '/' : combined;
}

function javaMethodCalls(methodBody: string): Array<{ expression: string; methodName: string; index: number }> {
  const calls: Array<{
    expression: string;
    methodName: string;
    index: number;
  }> = [];
  for (const match of methodBody.matchAll(/\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\s*\(/gu)) {
    const expression = match[1] ?? '';
    const methodName = expression.split('.').at(-1) ?? expression;
    if (isLowValueJavaCall(expression, methodName)) continue;
    calls.push({ expression, methodName, index: match.index ?? 0 });
  }
  return calls;
}

function isLowValueJavaCall(expression: string, methodName: string): boolean {
  const receiver = expression.split('.')[0] ?? '';
  // Java 调用图默认过滤日志、getter/setter 和工具类调用，避免低价值节点淹没 Controller/Service/Mapper 主链路。
  if (['System.out.println', 'System.err.println'].includes(expression)) return true;
  if (/^(log|logger)$/iu.test(receiver)) return true;
  if (/^[A-Za-z_$][\w$]*Util$/u.test(receiver) || /^[A-Za-z_$][\w$]*Utils$/u.test(receiver)) return true;
  if (/^(get|set|is)[A-Z]/u.test(methodName)) return true;
  return false;
}

function extractJavaBlockFromOpenBrace(content: string, openIndex: number): { text: string; endIndex: number } {
  if (openIndex < 0) return { text: '', endIndex: 0 };
  let depth = 0;
  for (let index = openIndex; index < content.length; index += 1) {
    const char = content[index];
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (depth === 0) return { text: content.slice(openIndex + 1, index), endIndex: index };
  }
  return { text: content.slice(openIndex + 1), endIndex: content.length };
}

function findJavaBlockEndLineFromOpenBrace(content: string, openIndex: number): number {
  return lineNumberAt(content, extractJavaBlockFromOpenBrace(content, openIndex).endIndex);
}

/** 抽取 Maven pom.xml 中的模块、坐标和依赖事实，作为 Java 多模块/依赖图谱的真实来源。 */
function extractMavenBuildSymbols(file: ScannedFile, content: string, language: string): CodeSymbolFact[] {
  if (language !== 'xml' || !file.relativePath.endsWith('pom.xml')) return [];
  const symbols: CodeSymbolFact[] = [];
  const projectGroupId = firstXmlTagValue(content, 'groupId');
  const projectArtifactId = firstXmlTagValue(content, 'artifactId');
  const projectVersion = firstXmlTagValue(content, 'version');
  if (projectArtifactId) {
    symbols.push(
      makeSymbol('config', `Maven project ${projectArtifactId}`, `${file.relativePath}#maven:project:${projectArtifactId}`, file.absolutePath, 1, 1, language, file.sourceHash, {
        sourceKind: 'maven_project',
        groupId: projectGroupId,
        artifactId: projectArtifactId,
        version: projectVersion,
      }),
    );
  }
  const modulesBlock = content.match(/<modules>([\s\S]*?)<\/modules>/iu)?.[1] ?? '';
  for (const moduleMatch of modulesBlock.matchAll(/<module>\s*([^<]+?)\s*<\/module>/giu)) {
    const modulePath = moduleMatch[1]?.trim();
    if (!modulePath) continue;
    const lineNo = lineNumberAt(content, content.indexOf(moduleMatch[0]) >= 0 ? content.indexOf(moduleMatch[0]) : 0);
    symbols.push(
      makeSymbol('config', `Maven module ${modulePath}`, `${file.relativePath}#maven:module:${modulePath}`, file.absolutePath, lineNo, lineNo, language, file.sourceHash, {
        sourceKind: 'maven_module',
        modulePath,
        projectArtifactId,
      }),
    );
  }
  for (const dependencyMatch of content.matchAll(/<dependency>([\s\S]*?)<\/dependency>/giu)) {
    const block = dependencyMatch[1] ?? '';
    const groupId = firstXmlTagValue(block, 'groupId');
    const artifactId = firstXmlTagValue(block, 'artifactId');
    if (!groupId || !artifactId) continue;
    const version = firstXmlTagValue(block, 'version');
    const scope = firstXmlTagValue(block, 'scope') ?? 'compile';
    const lineNo = lineNumberAt(content, dependencyMatch.index ?? 0);
    symbols.push(
      makeSymbol('dependency', `${groupId}:${artifactId}`, `${file.relativePath}#maven:dependency:${groupId}:${artifactId}`, file.absolutePath, lineNo, lineNo, language, file.sourceHash, {
        sourceKind: 'maven_dependency',
        groupId,
        artifactId,
        version,
        scope,
      }),
    );
  }
  return symbols;
}

function firstXmlTagValue(content: string, tagName: string): string | undefined {
  const match = new RegExp(`<${tagName}>\\s*([^<]+?)\\s*</${tagName}>`, 'iu').exec(content);
  return match?.[1]?.trim();
}

/** 抽取 Gradle build.gradle / build.gradle.kts 中的插件和依赖事实。 */
function extractGradleBuildSymbols(file: ScannedFile, content: string, language: string): CodeSymbolFact[] {
  if (language !== 'gradle' || !/(^|\/)build\.gradle(?:\.kts)?$/u.test(file.relativePath)) return [];
  const symbols: CodeSymbolFact[] = [];
  for (const pluginMatch of content.matchAll(/\bid\s*(?:\(?\s*)['"]([^'"]+)['"](?:\s+version\s+['"]([^'"]+)['"])?/gu)) {
    const pluginId = pluginMatch[1] ?? '';
    if (!pluginId) continue;
    const lineNo = lineNumberAt(content, pluginMatch.index ?? 0);
    symbols.push(
      makeSymbol('config', `Gradle plugin ${pluginId}`, `${file.relativePath}#gradle:plugin:${pluginId}`, file.absolutePath, lineNo, lineNo, language, file.sourceHash, {
        sourceKind: 'gradle_plugin',
        pluginId,
        version: pluginMatch[2],
      }),
    );
  }
  for (const dependencyMatch of content.matchAll(/\b(implementation|api|compileOnly|runtimeOnly|testImplementation|testRuntimeOnly)\s*(?:\(?\s*)['"]([^:'"]+):([^:'"]+):([^'"]+)['"]/gu)) {
    const configuration = dependencyMatch[1] ?? '';
    const groupId = dependencyMatch[2] ?? '';
    const artifactId = dependencyMatch[3] ?? '';
    const version = dependencyMatch[4] ?? '';
    if (!configuration || !groupId || !artifactId) continue;
    const lineNo = lineNumberAt(content, dependencyMatch.index ?? 0);
    symbols.push(
      makeSymbol('dependency', `${groupId}:${artifactId}`, `${file.relativePath}#gradle:dependency:${configuration}:${groupId}:${artifactId}`, file.absolutePath, lineNo, lineNo, language, file.sourceHash, {
        sourceKind: 'gradle_dependency',
        configuration,
        groupId,
        artifactId,
        version,
      }),
    );
  }
  return symbols;
}

/** 抽取 MyBatis XML mapper 中的 SQL、表和字段事实，保留 mapper namespace 与 statement id。 */
function extractMyBatisXmlSymbols(file: ScannedFile, content: string, language: string): CodeSymbolFact[] {
  if (language !== 'xml' || !/<mapper\b/iu.test(content)) return [];
  const mapperNamespace = content.match(/<mapper\b[^>]*\bnamespace="([^"]+)"/iu)?.[1] ?? '';
  const symbols: CodeSymbolFact[] = [];
  const statementPattern = /<(select|insert|update|delete)\b([^>]*)>([\s\S]*?)<\/\1>/giu;
  const seenTables = new Set<string>();
  const seenColumns = new Set<string>();
  for (const match of content.matchAll(statementPattern)) {
    const tagName = (match[1] ?? '').toLowerCase();
    const attrs = parseXmlAttributes(match[2] ?? '');
    const body = decodeXmlText(match[3] ?? '');
    const operation = tagName.toUpperCase();
    const statementId = attrs.id ?? `${operation.toLowerCase()}_${lineNumberAt(content, match.index ?? 0)}`;
    const tableNames = extractSqlCallTableNames(body, operation);
    if (tableNames.length === 0) continue;
    const lineNo = lineNumberAt(content, match.index ?? 0);
    const fieldMetadata = extractSqlFieldAccessMetadata(body, operation);
    const columnAliasMetadata = sqlColumnAliasMetadata(fieldMetadata, operation);
    symbols.push(
      makeSymbol(
        'sql_call',
        `${operation} ${tableNames.join(', ')} L${lineNo}`,
        `${file.relativePath}#mybatis:${statementId}`,
        file.absolutePath,
        lineNo,
        lineNumberAt(content, (match.index ?? 0) + match[0].length),
        language,
        file.sourceHash,
        {
          sourceKind: 'mybatis_xml_statement',
          mapperNamespace,
          statementId,
          operation,
          tableNames,
          tableQualifiedNames: tableNames.map((tableName) => `${file.relativePath}#table:${tableName}`),
          accessMode: operation === 'SELECT' ? 'read' : 'write',
          resultMap: attrs.resultMap,
          parameterType: attrs.parameterType,
          ...fieldMetadata,
          ...columnAliasMetadata,
          snippet: body.replace(/\s+/gu, ' ').trim().slice(0, 180),
        },
      ),
    );
    for (const tableName of tableNames) {
      if (!seenTables.has(tableName)) {
        seenTables.add(tableName);
        symbols.push(
          makeSymbol('table', tableName, `${file.relativePath}#table:${tableName}`, file.absolutePath, lineNo, lineNo, language, file.sourceHash, {
            sourceKind: 'mybatis_xml_table',
            mapperNamespace,
            tableName,
            statementIds: [statementId],
            columns: [],
          }),
        );
      }
      for (const columnName of uniqueStrings(Object.values(fieldMetadata).flatMap((value) => metadataArrayOfStrings(value)))) {
        const columnKey = `${tableName}.${columnName}`;
        if (seenColumns.has(columnKey)) continue;
        seenColumns.add(columnKey);
        symbols.push(
          makeSymbol('column', columnKey, `${file.relativePath}#table:${tableName}#column:${columnName}`, file.absolutePath, lineNo, lineNo, language, file.sourceHash, {
            sourceKind: 'mybatis_xml_column',
            mapperNamespace,
            tableName,
            columnName,
            tableQualifiedName: `${file.relativePath}#table:${tableName}`,
          }),
        );
      }
    }
  }
  for (const resultMap of content.matchAll(/<resultMap\b([^>]*)>([\s\S]*?)<\/resultMap>/giu)) {
    const attrs = parseXmlAttributes(resultMap[1] ?? '');
    const lineNo = lineNumberAt(content, resultMap.index ?? 0);
    symbols.push(
      makeSymbol(
        'type',
        attrs.id ?? `resultMap L${lineNo}`,
        `${file.relativePath}#resultMap:${attrs.id ?? lineNo}`,
        file.absolutePath,
        lineNo,
        lineNumberAt(content, (resultMap.index ?? 0) + resultMap[0].length),
        language,
        file.sourceHash,
        {
          sourceKind: 'mybatis_result_map',
          mapperNamespace,
          resultMapId: attrs.id,
          resultType: attrs.type,
          columns: [...resultMap[0].matchAll(/\bcolumn="([^"]+)"/giu)].map((match) => match[1]).filter(Boolean),
        },
      ),
    );
  }
  return symbols;
}

function parseXmlAttributes(attributeText: string): Record<string, string> {
  return Object.fromEntries([...attributeText.matchAll(/([A-Za-z_:][\w:.-]*)="([^"]*)"/gu)].map((match) => [match[1] ?? '', match[2] ?? '']));
}

interface SqlJoinRelation {
  leftTable: string;
  leftColumn: string;
  rightTable: string;
  rightColumn: string;
}

function sqlColumnAliasMetadata(fieldMetadata: Record<string, string[] | SqlJoinRelation[]>, operation: string): Record<string, string[]> {
  return {
    readColumns: operation === 'SELECT' ? metadataArrayOfStrings(fieldMetadata.selectedFields) : [],
    writeColumns: operation === 'UPDATE' || operation === 'INSERT' ? metadataArrayOfStrings(fieldMetadata.writeFields) : [],
    whereColumns: metadataArrayOfStrings(fieldMetadata.whereFields),
    orderByColumns: metadataArrayOfStrings(fieldMetadata.orderByFields),
    groupByColumns: metadataArrayOfStrings(fieldMetadata.groupByFields),
    joinColumns: metadataArrayOfStrings(fieldMetadata.joinFields),
  };
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&amp;/gu, '&')
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'");
}

function lineNumberAt(content: string, offset: number): number {
  return content.slice(0, Math.max(0, offset)).split('\n').length;
}

function collectSqlStatementSnippet(lines: string[], startIndex: number): { text: string; lineEnd: number } {
  const collected: string[] = [];
  for (let index = startIndex; index < Math.min(lines.length, startIndex + 8); index += 1) {
    collected.push(lines[index] ?? '');
    const line = lines[index] ?? '';
    if (index > startIndex && /[`'"]\s*\)?[,;]?/u.test(line)) {
      break;
    }
    if (index > startIndex && /\)\s*[.;]?\s*$/u.test(line)) {
      break;
    }
  }
  return {
    text: collected.join('\n'),
    lineEnd: startIndex + collected.length,
  };
}

function extractSqlCallTableNames(statement: string, operation: string): string[] {
  const tablePatterns: Record<string, RegExp[]> = {
    SELECT: [/\bFROM\s+[`"[]?([A-Za-z_][\w]*)[`"\]]?/giu, /\bJOIN\s+[`"[]?([A-Za-z_][\w]*)[`"\]]?/giu],
    INSERT: [/\bINTO\s+[`"[]?([A-Za-z_][\w]*)[`"\]]?/giu],
    UPDATE: [/\bUPDATE\s+[`"[]?([A-Za-z_][\w]*)[`"\]]?/giu],
    DELETE: [/\bFROM\s+[`"[]?([A-Za-z_][\w]*)[`"\]]?/giu],
  };
  const tableNames = new Set<string>();
  for (const pattern of tablePatterns[operation] ?? []) {
    for (const match of statement.matchAll(pattern)) {
      if (match[1]) tableNames.add(match[1]);
    }
  }
  return Array.from(tableNames);
}

function extractSqlFieldAccessMetadata(statement: string, operation: string): Record<string, string[] | SqlJoinRelation[]> {
  const normalized = statement.replace(/\s+/gu, ' ').trim();
  return {
    selectedFields: operation === 'SELECT' ? extractSelectedFields(normalized) : [],
    writeFields: operation === 'UPDATE' || operation === 'INSERT' ? extractWriteFields(normalized, operation) : [],
    whereFields: extractClauseFields(normalized, 'WHERE', ['ORDER BY', 'GROUP BY', 'LIMIT', 'RETURNING']),
    orderByFields: extractFieldListClause(normalized, 'ORDER BY', ['GROUP BY', 'LIMIT', 'RETURNING']),
    groupByFields: extractFieldListClause(normalized, 'GROUP BY', ['ORDER BY', 'LIMIT', 'RETURNING']),
    joinFields: extractJoinFields(normalized),
    joinRelations: extractJoinRelations(normalized),
  };
}

function extractSelectedFields(statement: string): string[] {
  const match = statement.match(/\bSELECT\s+(.+?)\s+FROM\b/iu);
  if (!match?.[1]) return [];
  return uniqueStrings(
    match[1]
      .split(',')
      .map((field) => normalizeSqlFieldName(field))
      .filter((field): field is string => Boolean(field)),
  );
}

function extractWriteFields(statement: string, operation: string): string[] {
  if (operation === 'UPDATE') {
    const match = statement.match(/\bSET\s+(.+?)(?=\bWHERE\b|\bRETURNING\b|$)/iu);
    if (!match?.[1]) return [];
    return uniqueStrings(
      match[1]
        .split(',')
        .map((field) => normalizeSqlFieldName(field.split('=')[0] ?? ''))
        .filter((field): field is string => Boolean(field)),
    );
  }
  if (operation === 'INSERT') {
    const match = statement.match(/\bINSERT\s+INTO\s+[A-Za-z_][\w]*\s*\(([^)]+)\)/iu);
    if (!match?.[1]) return [];
    return uniqueStrings(
      match[1]
        .split(',')
        .map((field) => normalizeSqlFieldName(field))
        .filter((field): field is string => Boolean(field)),
    );
  }
  return [];
}

function extractClauseFields(statement: string, clause: string, terminators: string[]): string[] {
  const escapedClause = clause.replace(/\s+/gu, '\\s+');
  const terminatorPattern = terminators.map((item) => item.replace(/\s+/gu, '\\s+')).join('|');
  const pattern = new RegExp(`\\b${escapedClause}\\s+(.+?)(?=\\b(?:${terminatorPattern})\\b|[\`'"),]|$)`, 'iu');
  const match = statement.match(pattern);
  if (!match?.[1]) return [];
  return uniqueStrings(
    [...match[1].matchAll(/\b((?:[A-Za-z_][\w]*\.)?[A-Za-z_][\w]*)\s*(?:=|<>|!=|<|>|<=|>=|\bIS\b|\bIN\b|\bLIKE\b)/giu)]
      .map((item) => normalizeSqlFieldName(item[1] ?? ''))
      .filter((field): field is string => typeof field === 'string' && field.length > 0 && !isSqlKeyword(field)),
  );
}

function extractFieldListClause(statement: string, clause: string, terminators: string[]): string[] {
  const escapedClause = clause.replace(/\s+/gu, '\\s+');
  const terminatorPattern = terminators.map((item) => item.replace(/\s+/gu, '\\s+')).join('|');
  const pattern = new RegExp(`\\b${escapedClause}\\s+(.+?)(?=\\b(?:${terminatorPattern})\\b|[\`'"),]|$)`, 'iu');
  const match = statement.match(pattern);
  if (!match?.[1]) return [];
  return uniqueStrings(
    match[1]
      .split(',')
      .map((field) => normalizeSqlFieldName(field.replace(/\s+(ASC|DESC)\b/iu, '')))
      .filter((field): field is string => Boolean(field)),
  );
}

function extractJoinFields(statement: string): string[] {
  return uniqueStrings(
    [...statement.matchAll(/\bON\s+(.+?)(?=\b(?:JOIN|WHERE|ORDER\s+BY|GROUP\s+BY|LIMIT)\b|$)/giu)]
      .flatMap((match) => [...(match[1] ?? '').matchAll(/\b[A-Za-z_][\w]*\.([A-Za-z_][\w]*)\b/gu)].map((item) => item[1]))
      .filter((field): field is string => Boolean(field)),
  );
}

function extractJoinRelations(statement: string): SqlJoinRelation[] {
  const aliases = sqlTableAliases(statement);
  const relations: SqlJoinRelation[] = [];
  for (const match of statement.matchAll(/\bON\s+([A-Za-z_][\w]*)\.([A-Za-z_][\w]*)\s*=\s*([A-Za-z_][\w]*)\.([A-Za-z_][\w]*)/giu)) {
    const leftAlias = match[1] ?? '';
    const leftColumn = match[2] ?? '';
    const rightAlias = match[3] ?? '';
    const rightColumn = match[4] ?? '';
    const leftTable = aliases.get(leftAlias) ?? leftAlias;
    const rightTable = aliases.get(rightAlias) ?? rightAlias;
    if (!leftTable || !rightTable || !leftColumn || !rightColumn) continue;
    // JOIN 推断只记录 SQL 中真实出现的等值条件，供表关系图展示低置信度来源，不推断数据库外键。
    relations.push({ leftTable, leftColumn, rightTable, rightColumn });
  }
  return relations;
}

function sqlTableAliases(statement: string): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const match of statement.matchAll(/\b(?:FROM|JOIN)\s+[`"[]?([A-Za-z_][\w]*)[`"\]]?(?:\s+(?:AS\s+)?([A-Za-z_][\w]*))?/giu)) {
    const tableName = match[1] ?? '';
    const alias = match[2] ?? tableName;
    if (!tableName) continue;
    aliases.set(tableName, tableName);
    aliases.set(alias, tableName);
  }
  return aliases;
}

function metadataArrayOfStrings(value: string[] | SqlJoinRelation[] | undefined): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function normalizeSqlFieldName(field: string): string | undefined {
  const withoutAlias = field
    .trim()
    .replace(/\s+AS\s+[A-Za-z_][\w]*$/iu, '')
    .replace(/\s+[A-Za-z_][\w]*$/u, '');
  const match = withoutAlias.match(/(?:^|\.)([A-Za-z_][\w]*)$/u);
  if (!match?.[1] || isSqlKeyword(match[1])) return undefined;
  return match[1];
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function isSqlKeyword(value: string): boolean {
  return ['AND', 'OR', 'NOT', 'NULL', 'IS', 'IN', 'LIKE', 'BETWEEN', 'EXISTS'].includes(value.toUpperCase());
}

/** 抽取 TS/JS import/export 事实，模块依赖图只使用真实文件或 workspace 包映射。 */
function buildKnownRelativePathSet(files: ScannedFile[]): Set<string> {
  return new Set(files.map((item) => item.relativePath));
}

function extractImportExportSymbols(file: ScannedFile, content: string, language: string, knownRelativePaths: Set<string>, importTargets: ImportTargetMap): CodeSymbolFact[] {
  if (!['typescript', 'javascript'].includes(language)) return [];
  const symbols: CodeSymbolFact[] = [];
  const importPattern = /import\s+(?:type\s+)?(?:([^'";]+?)\s+from\s+)?['"]([^'"]+)['"]/gu;
  for (const match of content.matchAll(importPattern)) {
    const importSource = match[2];
    if (!importSource) continue;
    const lineNo = content.slice(0, match.index ?? 0).split('\n').length;
    const resolution = resolveImportPath(file, importSource, knownRelativePaths, importTargets);
    const importedNames = parseImportedNames(match[1]);
    symbols.push(
      makeSymbol('import', importSource, `${file.relativePath}#import:${sanitizeQualifiedName(importSource)}:L${lineNo}`, file.absolutePath, lineNo, lineNo, language, file.sourceHash, {
        importSource,
        importedNames,
        sourceKind: `${language}_import`,
        importKind: 'static',
        external: !resolution.resolvedRelativePath,
        resolutionKind: resolution.resolutionKind,
        ...(resolution.resolvedRelativePath ? { resolvedRelativePath: resolution.resolvedRelativePath } : {}),
        ...(resolution.packageName ? { packageName: resolution.packageName } : {}),
        ...packageExportResolutionMetadata(resolution),
      }),
    );
  }
  symbols.push(...extractReExportImportSymbols(file, content, language, knownRelativePaths, importTargets));
  symbols.push(...extractExportNamespaceImportSymbols(file, content, language, knownRelativePaths, importTargets));
  symbols.push(...extractExportStarImportSymbols(file, content, language, knownRelativePaths, importTargets));
  symbols.push(...extractDynamicImportSymbols(file, content, language, knownRelativePaths, importTargets));
  symbols.push(...extractTypeReferenceImportSymbols(file, content, language, knownRelativePaths, importTargets));
  symbols.push(...extractExportSymbols(file, content, language));
  return symbols;
}

/** 抽取 Java import 依赖事实，支撑包依赖/外部依赖图谱；只按真实 import 语句和仓库内 Java 文件路径解析。 */
function buildJavaImportTargetMap(files: ScannedFile[]): JavaImportTargetMap {
  const targets: JavaImportTargetMap = new Map();
  for (const file of files) {
    if (file.extension !== '.java') continue;
    const javaSourceIndex = file.relativePath.lastIndexOf('/java/');
    const packageRelativePath = javaSourceIndex >= 0 ? file.relativePath.slice(javaSourceIndex + '/java/'.length) : file.relativePath;
    if (!targets.has(packageRelativePath)) targets.set(packageRelativePath, file.relativePath);
  }
  return targets;
}

function extractJavaImportSymbols(file: ScannedFile, content: string, language: string, javaImportTargets: JavaImportTargetMap): CodeSymbolFact[] {
  if (language !== 'java') return [];
  const symbols: CodeSymbolFact[] = [];
  for (const match of content.matchAll(/\bimport\s+(static\s+)?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)(\.\*)?\s*;/gu)) {
    const importSource = match[2];
    if (!importSource) continue;
    const lineNo = content.slice(0, match.index ?? 0).split('\n').length;
    const resolvedRelativePath = resolveJavaImportPath(importSource, javaImportTargets);
    const importedName = match[3] ? '*' : (importSource.split('.').at(-1) ?? importSource);
    symbols.push(
      makeSymbol('import', importSource, `${file.relativePath}#java_import:${sanitizeQualifiedName(importSource)}:L${lineNo}`, file.absolutePath, lineNo, lineNo, language, file.sourceHash, {
        importSource,
        importedNames: [importedName],
        sourceKind: 'java_import',
        importKind: match[1] ? 'java_static' : 'static',
        external: !resolvedRelativePath,
        resolutionKind: resolvedRelativePath ? 'java_source_path' : 'external',
        ...(resolvedRelativePath ? { resolvedRelativePath } : {}),
        ...javaPackageDependencyMetadata(importSource),
      }),
    );
  }
  return symbols;
}

function resolveJavaImportPath(importSource: string, javaImportTargets: JavaImportTargetMap): string | undefined {
  const candidate = `${importSource.replace(/\./gu, '/')}.java`;
  return javaImportTargets.get(candidate);
}

function javaPackageDependencyMetadata(importSource: string): {
  packageName?: string;
} {
  const parts = importSource.split('.');
  if (parts.length < 2) return {};
  // Java 外部包依赖按常见 group 前缀归并，避免把具体类名误当成包名。
  if (parts[0] === 'org' || parts[0] === 'com' || parts[0] === 'net' || parts[0] === 'io') {
    return {
      packageName: parts.slice(0, Math.min(2, parts.length - 1)).join('.'),
    };
  }
  if (parts[0] === 'java' || parts[0] === 'javax')
    return {
      packageName: parts.slice(0, Math.min(2, parts.length - 1)).join('.'),
    };
  return { packageName: parts.slice(0, parts.length - 1).join('.') };
}

function extractReExportImportSymbols(file: ScannedFile, content: string, language: string, knownRelativePaths: Set<string>, importTargets: ImportTargetMap): CodeSymbolFact[] {
  const symbols: CodeSymbolFact[] = [];
  const reExportPattern = /\bexport\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/gu;
  for (const match of content.matchAll(reExportPattern)) {
    const importSource = match[2];
    if (!importSource) continue;
    const lineNo = content.slice(0, match.index ?? 0).split('\n').length;
    const resolution = resolveImportPath(file, importSource, knownRelativePaths, importTargets);
    symbols.push(
      makeSymbol('import', importSource, `${file.relativePath}#re_export:${sanitizeQualifiedName(importSource)}:L${lineNo}`, file.absolutePath, lineNo, lineNo, language, file.sourceHash, {
        importSource,
        importedNames: parseNamedExportList(match[1] ?? ''),
        sourceKind: `${language}_re_export`,
        importKind: 're_export',
        external: !resolution.resolvedRelativePath,
        resolutionKind: resolution.resolutionKind,
        ...(resolution.resolvedRelativePath ? { resolvedRelativePath: resolution.resolvedRelativePath } : {}),
        ...(resolution.packageName ? { packageName: resolution.packageName } : {}),
        ...packageExportResolutionMetadata(resolution),
      }),
    );
  }
  return symbols;
}

/** 抽取 `export * as Name from` 依赖；它既形成模块依赖，也声明命名空间导出。 */
function extractExportNamespaceImportSymbols(file: ScannedFile, content: string, language: string, knownRelativePaths: Set<string>, importTargets: ImportTargetMap): CodeSymbolFact[] {
  const symbols: CodeSymbolFact[] = [];
  const exportNamespacePattern = /\bexport\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+['"]([^'"]+)['"]/gu;
  for (const match of content.matchAll(exportNamespacePattern)) {
    const exportedName = match[1];
    const importSource = match[2];
    if (!exportedName || !importSource) continue;
    const lineNo = content.slice(0, match.index ?? 0).split('\n').length;
    const resolution = resolveImportPath(file, importSource, knownRelativePaths, importTargets);
    symbols.push(
      makeSymbol('import', importSource, `${file.relativePath}#export_namespace:${exportedName}:L${lineNo}`, file.absolutePath, lineNo, lineNo, language, file.sourceHash, {
        importSource,
        importedNames: [exportedName],
        sourceKind: `${language}_export_namespace`,
        importKind: 'export_namespace',
        external: !resolution.resolvedRelativePath,
        resolutionKind: resolution.resolutionKind,
        ...(resolution.resolvedRelativePath ? { resolvedRelativePath: resolution.resolvedRelativePath } : {}),
        ...(resolution.packageName ? { packageName: resolution.packageName } : {}),
        ...packageExportResolutionMetadata(resolution),
      }),
    );
  }
  return symbols;
}

/** 抽取 `export * from` 依赖；它不声明本地名称，但会形成真实模块依赖。 */
function extractExportStarImportSymbols(file: ScannedFile, content: string, language: string, knownRelativePaths: Set<string>, importTargets: ImportTargetMap): CodeSymbolFact[] {
  const symbols: CodeSymbolFact[] = [];
  const exportStarPattern = /\bexport\s+\*\s+from\s+['"]([^'"]+)['"]/gu;
  for (const match of content.matchAll(exportStarPattern)) {
    const importSource = match[1];
    if (!importSource) continue;
    const lineNo = content.slice(0, match.index ?? 0).split('\n').length;
    const resolution = resolveImportPath(file, importSource, knownRelativePaths, importTargets);
    symbols.push(
      makeSymbol('import', importSource, `${file.relativePath}#export_star:${sanitizeQualifiedName(importSource)}:L${lineNo}`, file.absolutePath, lineNo, lineNo, language, file.sourceHash, {
        importSource,
        importedNames: ['*'],
        sourceKind: `${language}_export_star`,
        importKind: 'export_star',
        external: !resolution.resolvedRelativePath,
        resolutionKind: resolution.resolutionKind,
        ...(resolution.resolvedRelativePath ? { resolvedRelativePath: resolution.resolvedRelativePath } : {}),
        ...(resolution.packageName ? { packageName: resolution.packageName } : {}),
        ...packageExportResolutionMetadata(resolution),
      }),
    );
  }
  return symbols;
}

/** 抽取运行时动态 import；与类型位置的 import('x') 区分，避免模块图丢失懒加载依赖。 */
function extractDynamicImportSymbols(file: ScannedFile, content: string, language: string, knownRelativePaths: Set<string>, importTargets: ImportTargetMap): CodeSymbolFact[] {
  const symbols: CodeSymbolFact[] = [];
  const dynamicImportPattern = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/gu;
  for (const match of content.matchAll(dynamicImportPattern)) {
    if (!isRuntimeDynamicImport(content, match.index ?? 0)) continue;
    const importSource = match[1];
    if (!importSource) continue;
    const lineNo = content.slice(0, match.index ?? 0).split('\n').length;
    const resolution = resolveImportPath(file, importSource, knownRelativePaths, importTargets);
    symbols.push(
      makeSymbol('import', importSource, `${file.relativePath}#dynamic_import:${sanitizeQualifiedName(importSource)}:L${lineNo}`, file.absolutePath, lineNo, lineNo, language, file.sourceHash, {
        importSource,
        importedNames: [],
        sourceKind: `${language}_dynamic_import`,
        importKind: 'dynamic',
        external: !resolution.resolvedRelativePath,
        resolutionKind: resolution.resolutionKind,
        ...(resolution.resolvedRelativePath ? { resolvedRelativePath: resolution.resolvedRelativePath } : {}),
        ...(resolution.packageName ? { packageName: resolution.packageName } : {}),
        ...packageExportResolutionMetadata(resolution),
      }),
    );
  }
  return symbols;
}

function extractTypeReferenceImportSymbols(file: ScannedFile, content: string, language: string, knownRelativePaths: Set<string>, importTargets: ImportTargetMap): CodeSymbolFact[] {
  const symbols: CodeSymbolFact[] = [];
  const typeReferenceImportPattern = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/gu;
  for (const match of content.matchAll(typeReferenceImportPattern)) {
    if (isRuntimeDynamicImport(content, match.index ?? 0)) continue;
    const importSource = match[1];
    if (!importSource) continue;
    const lineNo = content.slice(0, match.index ?? 0).split('\n').length;
    const resolution = resolveImportPath(file, importSource, knownRelativePaths, importTargets);
    symbols.push(
      makeSymbol('import', importSource, `${file.relativePath}#type_import:${sanitizeQualifiedName(importSource)}:L${lineNo}`, file.absolutePath, lineNo, lineNo, language, file.sourceHash, {
        importSource,
        importedNames: [],
        sourceKind: `${language}_type_reference_import`,
        importKind: 'type_reference',
        external: !resolution.resolvedRelativePath,
        resolutionKind: resolution.resolutionKind,
        ...(resolution.resolvedRelativePath ? { resolvedRelativePath: resolution.resolvedRelativePath } : {}),
        ...(resolution.packageName ? { packageName: resolution.packageName } : {}),
        ...packageExportResolutionMetadata(resolution),
      }),
    );
  }
  return symbols;
}

function isRuntimeDynamicImport(content: string, matchIndex: number): boolean {
  const linePrefix = content.slice(0, matchIndex).split('\n').pop() ?? '';
  if (/^\s*type\b/u.test(linePrefix)) return false;
  return /(?:\bawait\s+|\breturn\s+|=\s*|\(\s*|\[\s*|,\s*)$/u.test(linePrefix);
}

function parseImportedNames(importClause?: string): string[] {
  if (!importClause) return [];
  const names = new Set<string>();
  const namespaceMatch = importClause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/u);
  if (namespaceMatch?.[1]) names.add(namespaceMatch[1]);
  const namedMatch = importClause.match(/\{([^}]+)\}/u);
  if (namedMatch?.[1]) {
    for (const rawName of namedMatch[1].split(',')) {
      const name = rawName
        .trim()
        .replace(/^type\s+/u, '')
        .split(/\s+as\s+/u)[0]
        ?.trim();
      if (name) names.add(name);
    }
  }
  const defaultName = importClause.split(',')[0]?.trim();
  if (defaultName && !defaultName.startsWith('{') && !defaultName.startsWith('*')) names.add(defaultName);
  return Array.from(names);
}

function extractExportSymbols(file: ScannedFile, content: string, language: string): CodeSymbolFact[] {
  const symbols: CodeSymbolFact[] = [];
  const declarationPattern = /\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/gu;
  for (const match of content.matchAll(declarationPattern)) {
    if (!match[1]) continue;
    const lineNo = content.slice(0, match.index ?? 0).split('\n').length;
    symbols.push(
      makeSymbol('export', match[1], `${file.relativePath}#export:${match[1]}`, file.absolutePath, lineNo, lineNo, language, file.sourceHash, {
        exportKind: 'declaration',
        sourceKind: `${language}_export`,
      }),
    );
  }
  const namedExportPattern = /\bexport\s+(?:type\s+)?\{([^}]+)\}(?:\s+from\s+['"]([^'"]+)['"])?/gu;
  for (const match of content.matchAll(namedExportPattern)) {
    const lineNo = content.slice(0, match.index ?? 0).split('\n').length;
    const exportSource = match[2];
    for (const exportedName of parseNamedExportList(match[1] ?? '')) {
      symbols.push(
        makeSymbol('export', exportedName, `${file.relativePath}#export:${exportedName}`, file.absolutePath, lineNo, lineNo, language, file.sourceHash, {
          exportKind: exportSource ? 're_export' : 'named',
          sourceKind: `${language}_export`,
          ...(exportSource ? { exportSource } : {}),
        }),
      );
    }
  }
  const namespaceExportPattern = /\bexport\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+['"]([^'"]+)['"]/gu;
  for (const match of content.matchAll(namespaceExportPattern)) {
    const exportedName = match[1];
    const exportSource = match[2];
    if (!exportedName || !exportSource) continue;
    const lineNo = content.slice(0, match.index ?? 0).split('\n').length;
    symbols.push(
      makeSymbol('export', exportedName, `${file.relativePath}#export:${exportedName}`, file.absolutePath, lineNo, lineNo, language, file.sourceHash, {
        exportKind: 'namespace_re_export',
        sourceKind: `${language}_export`,
        exportSource,
      }),
    );
  }
  return dedupeSymbolsByQualifiedName(symbols);
}

function parseNamedExportList(rawList: string): string[] {
  return rawList
    .split(',')
    .map((rawName) =>
      rawName
        .trim()
        .replace(/^type\s+/u, '')
        .split(/\s+as\s+/u)
        .pop()
        ?.trim(),
    )
    .filter((name): name is string => Boolean(name));
}

function dedupeSymbolsByQualifiedName(symbols: CodeSymbolFact[]): CodeSymbolFact[] {
  const seen = new Set<string>();
  return symbols.filter((symbol) => {
    if (seen.has(symbol.qualifiedName)) return false;
    seen.add(symbol.qualifiedName);
    return true;
  });
}

function resolveImportPath(file: ScannedFile, importSource: string, knownRelativePaths: Set<string>, importTargets: ImportTargetMap): ImportResolution {
  if (!importSource.startsWith('.')) {
    const importTarget = importTargetForImportSpecifier(importSource, importTargets, inferRuntimeEnvironmentForFile(file.relativePath));
    return importTarget
      ? {
          resolvedRelativePath: importTarget.resolvedRelativePath,
          resolutionKind: importTarget.resolutionKind,
          packageName: importTarget.packageName,
          runtimeEnvironment: importTarget.runtimeEnvironment,
          matchedExportConditions: importTarget.matchedExportConditions,
          availableExportConditions: importTarget.availableExportConditions,
        }
      : { resolutionKind: 'external' };
  }
  const withoutExtension = importSource.replace(/\.(?:js|jsx|ts|tsx)$/u, '');
  const basePath = normalize(join(dirname(file.relativePath), withoutExtension));
  const candidates = [`${basePath}.ts`, `${basePath}.tsx`, `${basePath}.js`, `${basePath}.jsx`, normalize(join(basePath, 'index.ts')), normalize(join(basePath, 'index.tsx'))];
  const resolvedRelativePath = candidates.find((candidate) => knownRelativePaths.has(candidate));
  return resolvedRelativePath ? { resolvedRelativePath, resolutionKind: 'relative' } : { resolutionKind: 'external' };
}

function packageExportResolutionMetadata(resolution: ImportResolution): Record<string, unknown> {
  if (resolution.resolutionKind !== 'package_exports') return {};
  return {
    ...(resolution.runtimeEnvironment ? { runtimeEnvironment: resolution.runtimeEnvironment } : {}),
    ...(resolution.matchedExportConditions ? { matchedExportConditions: resolution.matchedExportConditions } : {}),
    ...(resolution.availableExportConditions ? { availableExportConditions: resolution.availableExportConditions } : {}),
  };
}

/** 根据导入发生的位置选择最贴近运行端的 package exports 条件集合。 */
function inferRuntimeEnvironmentForFile(relativePath: string): 'browser' | 'node' | 'default' {
  const normalizedPath = normalize(relativePath);
  if (normalizedPath.includes('/renderer/') || normalizedPath.endsWith('.tsx')) return 'browser';
  if (normalizedPath.includes('/main/') || normalizedPath.includes('/preload/') || normalizedPath.startsWith('packages/')) return 'node';
  return 'default';
}

function importTargetForImportSpecifier(importSource: string, importTargets: ImportTargetMap = new Map(), runtimeEnvironment: 'browser' | 'node' | 'default' = 'default'): ImportTarget | undefined {
  return importTargets.get(`${importSource}::${runtimeEnvironment}`) ?? importTargets.get(`${importSource}::default`) ?? importTargets.get(importSource);
}

function sourcePathForImportSpecifier(importSource: string, importTargets: ImportTargetMap = new Map()): string | undefined {
  return importTargetForImportSpecifier(importSource, importTargets)?.resolvedRelativePath;
}

function packageNameForImportSource(importSource: string): string | undefined {
  if (!importSource.startsWith('@')) return importSource.split('/')[0];
  const parts = importSource.split('/');
  return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : undefined;
}

function sanitizeQualifiedName(value: string): string {
  return value.replace(/[^A-Za-z0-9_$./-]/gu, '_');
}

/** 把 TypeScript/JavaScript class 方法也登记为函数节点，便于方法逻辑图从方法入口展开。 */
function extractClassMethodSymbols(file: ScannedFile, content: string, language: string): CodeSymbolFact[] {
  if (!['typescript', 'javascript'].includes(language)) return [];
  return extractFunctionRanges(file, content)
    .filter((range) => range.kind === 'class_method')
    .map((range) =>
      makeSymbol('function', range.name, range.qualifiedName, file.absolutePath, range.lineStart, range.lineEnd, language, file.sourceHash, {
        sourceKind: 'class_method',
        ownerClass: range.ownerClass,
      }),
    );
}

/** 抽取函数/handler 内部真实调用点，为 API 时序图和方法逻辑图提供调用链事实。 */
function extractFunctionCallSymbols(file: ScannedFile, content: string, language: string, importTargets: ImportTargetMap): CodeSymbolFact[] {
  if (!['typescript', 'javascript'].includes(language)) return [];
  const symbols: CodeSymbolFact[] = [];
  const functionRanges = extractFunctionRanges(file, content);
  const constructorVariableTypes = extractConstructorVariableTypes(content);
  const importSourceByClassName = extractImportSourceByClassName(content);
  const importSourceByFunctionName = extractImportSourceByFunctionName(content);
  const callPattern = /\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+|[A-Za-z_$][\w$]*)\s*\(/gu;
  content.split('\n').forEach((line, index) => {
    const trimmedLine = line.trim();
    if (!trimmedLine || trimmedLine.startsWith('//')) return;
    const lineNo = index + 1;
    const ownerFunction = findInnermostFunctionRange(functionRanges, lineNo);
    for (const match of line.matchAll(callPattern)) {
      const calleeExpression = match[1];
      if (!calleeExpression || shouldSkipFunctionCall(calleeExpression) || shouldSkipDirectFunctionCall(line, match.index ?? 0, calleeExpression)) continue;
      const targetMetadata = calleeExpression.includes('.')
        ? resolveConstructorBackedCallTarget(calleeExpression, constructorVariableTypes, importSourceByClassName, importTargets)
        : resolveBareFunctionCallTarget(calleeExpression, functionRanges, ownerFunction, importSourceByFunctionName, importTargets);
      if (!calleeExpression.includes('.') && !targetMetadata.targetQualifiedName) continue;
      const awaitMetadata = detectAwaitedCallMetadata(line, match.index ?? 0);
      const promiseChainMetadata = detectPromiseChainCallMetadata(line, match.index ?? 0, calleeExpression);
      symbols.push(
        makeSymbol('function_call', `${calleeExpression} L${lineNo}`, `${file.relativePath}#call:${calleeExpression}:L${lineNo}:${match.index ?? 0}`, file.absolutePath, lineNo, lineNo, language, file.sourceHash, {
          calleeExpression,
          snippet: trimmedLine.slice(0, 180),
          sourceKind: 'typescript_function_call',
          ...awaitMetadata,
          ...promiseChainMetadata,
          ...targetMetadata,
          ...(ownerFunction
            ? {
                ownerFunction: ownerFunction.name,
                ownerQualifiedName: ownerFunction.qualifiedName,
                ownerLineStart: ownerFunction.lineStart,
                ownerLineEnd: ownerFunction.lineEnd,
              }
            : {}),
        }),
      );
    }
  });
  return symbols;
}

/** 标记 await 调用点，方法逻辑图据此展示异步等待关系。 */
function detectAwaitedCallMetadata(line: string, matchIndex: number): Record<string, unknown> {
  const linePrefix = line.slice(0, matchIndex);
  if (/\bawait\s+$/u.test(linePrefix)) {
    return { isAwaited: true, awaitKind: 'direct_await' };
  }
  if (/\bawait\b/u.test(linePrefix)) {
    return { isAwaited: true, awaitKind: 'await_expression' };
  }
  return {};
}

/** 标记 `work().catch(...)` 这类 Promise 链根调用，方法逻辑图据此展示异步异常分支。 */
function detectPromiseChainCallMetadata(line: string, matchIndex: number, calleeExpression: string): Record<string, unknown> {
  const afterCallee = line.slice(matchIndex + calleeExpression.length);
  const match = afterCallee.match(/^\s*\([^)]*\)\s*\.\s*(catch|then|finally)\s*\(/u);
  if (!match?.[1]) return {};
  return {
    isPromiseChainRoot: true,
    promiseChainHandler: match[1],
  };
}

function resolveBareFunctionCallTarget(
  calleeExpression: string,
  functionRanges: FunctionRange[],
  ownerFunction: FunctionRange | undefined,
  importSourceByFunctionName: Map<string, string>,
  importTargets: ImportTargetMap,
): Record<string, unknown> {
  const sameFileTarget = resolveSameFileFunctionCallTarget(calleeExpression, functionRanges, ownerFunction);
  if (sameFileTarget.targetQualifiedName) return sameFileTarget;
  return resolveImportedFunctionCallTarget(calleeExpression, importSourceByFunctionName, importTargets);
}

function resolveSameFileFunctionCallTarget(calleeExpression: string, functionRanges: FunctionRange[], ownerFunction?: FunctionRange): Record<string, unknown> {
  const target = functionRanges.find((range) => range.name === calleeExpression && range.qualifiedName !== ownerFunction?.qualifiedName);
  if (!target) return {};
  return {
    targetFunction: target.name,
    targetQualifiedName: target.qualifiedName,
    targetResolutionKind: 'same_file_function',
  };
}

function resolveImportedFunctionCallTarget(calleeExpression: string, importSourceByFunctionName: Map<string, string>, importTargets: ImportTargetMap): Record<string, unknown> {
  const importSource = importSourceByFunctionName.get(calleeExpression);
  if (!importSource) return {};
  const sourcePath = sourcePathForImportSpecifier(importSource, importTargets);
  if (!sourcePath) return {};
  return {
    targetFunction: calleeExpression,
    targetQualifiedName: `${sourcePath}#${calleeExpression}`,
    targetResolutionKind: 'imported_function',
    targetImportSource: importSource,
  };
}

function extractConstructorVariableTypes(content: string): Map<string, string> {
  const variableTypes = new Map<string, string>();
  const constructorPattern = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+([A-Za-z_$][\w$]*)\s*\(/gu;
  for (const match of content.matchAll(constructorPattern)) {
    if (match[1] && match[2]) variableTypes.set(match[1], match[2]);
  }
  return variableTypes;
}

function extractImportSourceByClassName(content: string): Map<string, string> {
  const importSources = new Map<string, string>();
  const namedImportPattern = /import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/gu;
  for (const match of content.matchAll(namedImportPattern)) {
    const names = (match[1] ?? '')
      .split(',')
      .map((name) =>
        name
          .trim()
          .replace(/^type\s+/u, '')
          .split(/\s+as\s+/u)[0]
          ?.trim(),
      )
      .filter((name): name is string => Boolean(name));
    for (const name of names) {
      importSources.set(name, match[2] ?? '');
    }
  }
  return importSources;
}

function extractImportSourceByFunctionName(content: string): Map<string, string> {
  const importSources = new Map<string, string>();
  const namedImportPattern = /import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/gu;
  for (const match of content.matchAll(namedImportPattern)) {
    const names = (match[1] ?? '')
      .split(',')
      .map((name) =>
        name
          .trim()
          .replace(/^type\s+/u, '')
          .split(/\s+as\s+/u)[0]
          ?.trim(),
      )
      .filter((name): name is string => Boolean(name));
    for (const name of names) {
      if (/^[A-Z]/u.test(name)) continue;
      importSources.set(name, match[2] ?? '');
    }
  }
  return importSources;
}

function resolveConstructorBackedCallTarget(calleeExpression: string, constructorVariableTypes: Map<string, string>, importSourceByClassName: Map<string, string>, importTargets: ImportTargetMap): Record<string, unknown> {
  const [receiver, methodName] = calleeExpression.split('.');
  if (!receiver || !methodName || calleeExpression.split('.').length !== 2) return {};
  const className = constructorVariableTypes.get(receiver);
  if (!className) return {};
  const sourcePath = sourcePathForImportedClass(className, importSourceByClassName.get(className), importTargets);
  if (!sourcePath)
    return {
      targetClass: className,
      targetMethod: methodName,
      targetResolutionKind: 'constructor_variable',
    };
  return {
    targetClass: className,
    targetMethod: methodName,
    targetQualifiedName: `${sourcePath}#${className}.${methodName}`,
    targetResolutionKind: 'constructor_variable',
  };
}

function sourcePathForImportedClass(className: string, importSource: string | undefined, importTargets: ImportTargetMap): string | undefined {
  const sourcePath = importSource ? sourcePathForImportSpecifier(importSource, importTargets) : undefined;
  if (sourcePath) return sourcePath;
  if (!importSource && className.endsWith('Repository')) return 'packages/storage/src/index.ts';
  return undefined;
}

function shouldSkipFunctionCall(calleeExpression: string): boolean {
  return calleeExpression.startsWith('server.') || calleeExpression.startsWith('expect.') || calleeExpression.startsWith('describe.') || calleeExpression.startsWith('it.');
}

function shouldSkipDirectFunctionCall(line: string, matchIndex: number, calleeExpression: string): boolean {
  if (calleeExpression.includes('.')) return false;
  if (matchIndex > 0 && line[matchIndex - 1] === '.') return true;
  if (/\b(?:if|for|while|switch|catch|function|return|new|await|typeof|import)\b/u.test(calleeExpression)) return true;
  const beforeCall = line.slice(0, matchIndex);
  return new RegExp(`\\bfunction\\s+${calleeExpression}\\s*$`, 'u').test(beforeCall);
}

function detectLoopKind(line: string): string {
  if (/\bfor\s*\(/u.test(line)) return 'for';
  if (/\bwhile\s*\(/u.test(line)) return 'while';
  if (/\.forEach\s*\(/u.test(line)) return 'forEach';
  return 'loop';
}

interface FunctionRange {
  name: string;
  qualifiedName: string;
  lineStart: number;
  lineEnd: number;
  kind: 'function' | 'class_method' | 'route_handler';
  ownerClass?: string;
}

interface ClassRange {
  name: string;
  lineStart: number;
  lineEnd: number;
}

interface FastifyRouteDeclaration {
  method: string;
  path: string;
  lineStart: number;
  lineEnd: number;
  handlerKind: 'inline_async_handler' | 'inline_handler';
}

/** 用轻量括号范围识别函数边界，保证方法逻辑事实能归属到真实源码函数。 */
function extractFunctionRanges(file: ScannedFile, content: string): FunctionRange[] {
  const lines = content.split('\n');
  const ranges: FunctionRange[] = [];
  lines.forEach((line, index) => {
    const functionMatch = line.match(/\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/u);
    if (!functionMatch?.[1]) return;
    const lineStart = index + 1;
    ranges.push({
      name: functionMatch[1],
      qualifiedName: `${file.relativePath}#${functionMatch[1]}`,
      lineStart,
      lineEnd: findBraceRangeEnd(lines, index),
      kind: 'function',
    });
  });
  for (const handlerRange of extractFastifyRouteHandlerRanges(file, lines)) {
    ranges.push(handlerRange);
  }
  for (const classRange of extractClassRanges(lines)) {
    for (let index = classRange.lineStart; index < classRange.lineEnd; index += 1) {
      const line = lines[index];
      const methodMatch = line.match(/^\s*(?:(?:public|private|protected|static|async)\s+)*([A-Za-z_$][\w$]*)(?:<[^>]+>)?\s*\([^)]*\)\s*(?::[^{}]+)?\{/u);
      if (!methodMatch?.[1] || methodMatch[1] === 'constructor') continue;
      const methodName = `${classRange.name}.${methodMatch[1]}`;
      ranges.push({
        name: methodName,
        qualifiedName: `${file.relativePath}#${methodName}`,
        lineStart: index + 1,
        lineEnd: findBraceRangeEnd(lines, index),
        kind: 'class_method',
        ownerClass: classRange.name,
      });
    }
  }
  return ranges;
}

function extractFastifyRouteHandlerRanges(file: ScannedFile, lines: string[]): FunctionRange[] {
  return extractFastifyRouteDeclarations(lines.join('\n')).map((route) => {
    const method = route.method;
    const path = route.path;
    const name = `${method} ${path} handler`;
    return {
      name,
      qualifiedName: `${file.relativePath}#handler:${method}:${path}`,
      lineStart: route.lineStart,
      lineEnd: route.lineEnd,
      kind: 'route_handler',
    };
  });
}

function extractClassRanges(lines: string[]): ClassRange[] {
  const ranges: ClassRange[] = [];
  lines.forEach((line, index) => {
    const classMatch = line.match(/\b(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/u);
    if (!classMatch?.[1]) return;
    ranges.push({
      name: classMatch[1],
      lineStart: index + 1,
      lineEnd: findBraceRangeEnd(lines, index),
    });
  });
  return ranges;
}

function findBraceRangeEnd(lines: string[], startIndex: number): number {
  let depth = 0;
  let hasOpenedBody = false;
  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index];
    for (const char of line) {
      if (char === '{') {
        depth += 1;
        hasOpenedBody = true;
      }
      if (char === '}') depth -= 1;
    }
    if (hasOpenedBody && depth <= 0) return index + 1;
  }
  return startIndex + 1;
}

function findInnermostFunctionRange(ranges: FunctionRange[], lineNo: number): FunctionRange | undefined {
  return ranges.filter((range) => range.lineStart <= lineNo && lineNo <= range.lineEnd).sort((a, b) => a.lineEnd - a.lineStart - (b.lineEnd - b.lineStart))[0];
}

/** 从真实 SQL/源码中的 CREATE TABLE 语句抽取表事实，来源保持到文件和行号。 */
function extractSqlTableSymbols(file: ScannedFile, content: string, language: string): CodeSymbolFact[] {
  const symbols: CodeSymbolFact[] = [];
  const indexesByTableName = extractSqlIndexDefinitions(content);
  const createTablePattern = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:(?:[`"[]?([A-Za-z_][\w]*)[`"\]]?)\.)?[`"[]?([A-Za-z_][\w]*)[`"\]]?\s*\(([\s\S]*?)\)\s*;/giu;
  for (const match of content.matchAll(createTablePattern)) {
    const schemaName = match[1] ?? 'default';
    const tableName = match[2];
    const definition = match[3] ?? '';
    const index = match.index ?? 0;
    const lineStart = content.slice(0, index).split('\n').length;
    const lineEnd = lineStart + match[0].split('\n').length - 1;
    const columnDetails = extractSqlColumnDetails(definition);
    const foreignKeys = extractSqlForeignKeys(definition, schemaName, tableName);
    const tableQualifiedName = schemaName === 'default' ? `${file.relativePath}#table:${tableName}` : `${file.relativePath}#schema:${schemaName}#table:${tableName}`;
    symbols.push(
      makeSymbol('table', tableName, tableQualifiedName, file.absolutePath, lineStart, lineEnd, language, file.sourceHash, {
        columns: extractSqlColumnNames(definition),
        columnDetails,
        indexes: indexesByTableName.get(tableName) ?? [],
        foreignKeys,
        schemaName,
        schemaVersionCache: {
          sourceHash: file.sourceHash,
          lineStart,
          lineEnd,
        },
        sourceKind: tableSourceKind(file.relativePath, language, 'table'),
      }),
    );
    for (const column of columnDetails) {
      symbols.push(
        makeSymbol('column', `${tableName}.${column.name}`, `${tableQualifiedName}#column:${column.name}`, file.absolutePath, lineStart, lineEnd, language, file.sourceHash, {
          ...column,
          schemaName,
          tableName,
          columnName: column.name,
          tableQualifiedName,
          schemaVersionCache: {
            sourceHash: file.sourceHash,
            lineStart,
            lineEnd,
          },
          sourceKind: tableSourceKind(file.relativePath, language, 'column'),
        }),
      );
    }
  }
  return symbols;
}

function tableSourceKind(relativePath: string, language: string, kind: 'table' | 'column'): string {
  if (relativePath.startsWith('database-introspection/')) return 'database_introspection';
  if (language === 'sql') return kind === 'column' ? 'ddl_file_column' : 'ddl_file';
  return kind === 'column' ? 'embedded_sql_column' : 'embedded_sql';
}

interface SqlColumnDetail {
  name: string;
  dataType: string;
  notNull: boolean;
  primaryKey: boolean;
  unique: boolean;
  defaultValue?: string;
}

interface SqlIndexDefinition {
  name: string;
  tableName: string;
  columns: string[];
  unique: boolean;
}

interface SqlForeignKeyDefinition {
  name: string | null;
  columns: string[];
  referencedSchema: string;
  referencedTable: string;
  referencedColumns: string[];
}

function extractSqlColumnNames(definition: string): string[] {
  const structuralKeywords = new Set(['constraint', 'primary', 'foreign', 'unique', 'check', 'key']);
  return definition
    .split('\n')
    .map((line) => line.trim().replace(/,$/u, ''))
    .map((line) => line.match(/^[`"[]?([A-Za-z_][\w]*)[`"\]]?\s+/u)?.[1])
    .filter((name): name is string => typeof name === 'string' && !structuralKeywords.has(name.toLowerCase()));
}

function extractSqlColumnDetails(definition: string): SqlColumnDetail[] {
  const structuralKeywords = new Set(['constraint', 'primary', 'foreign', 'unique', 'check', 'key']);
  return definition
    .split('\n')
    .map((line) => line.trim().replace(/,$/u, ''))
    .flatMap((line) => {
      const match = line.match(/^[`"[]?([A-Za-z_][\w]*)[`"\]]?\s+([A-Za-z][\w()]*)(.*)$/u);
      if (!match?.[1] || !match[2] || structuralKeywords.has(match[1].toLowerCase())) return [];
      const constraints = match[3] ?? '';
      const defaultMatch = constraints.match(/\bDEFAULT\s+('(?:[^']*)'|"(?:[^"]*)"|[^\s,]+)/iu);
      return [
        {
          name: match[1],
          dataType: match[2].toUpperCase(),
          notNull: /\bNOT\s+NULL\b/iu.test(constraints),
          primaryKey: /\bPRIMARY\s+KEY\b/iu.test(constraints),
          unique: /\bUNIQUE\b/iu.test(constraints),
          ...(defaultMatch?.[1] ? { defaultValue: defaultMatch[1].replace(/^['"]|['"]$/gu, '') } : {}),
        },
      ];
    });
}

function extractSqlIndexDefinitions(content: string): Map<string, SqlIndexDefinition[]> {
  const indexesByTableName = new Map<string, SqlIndexDefinition[]>();
  const createIndexPattern = /CREATE\s+(UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"[]?([A-Za-z_][\w]*)[`"\]]?\s+ON\s+[`"[]?([A-Za-z_][\w]*)[`"\]]?\s*\(([^)]+)\)/giu;
  for (const match of content.matchAll(createIndexPattern)) {
    if (!match[2] || !match[3] || !match[4]) continue;
    const tableName = match[3];
    const indexDefinition: SqlIndexDefinition = {
      name: match[2],
      tableName,
      columns: match[4]
        .split(',')
        .map((column) => column.trim().replace(/[`"[\]]/gu, ''))
        .filter(Boolean),
      unique: Boolean(match[1]),
    };
    indexesByTableName.set(tableName, [...(indexesByTableName.get(tableName) ?? []), indexDefinition]);
  }
  return indexesByTableName;
}

function extractSqlForeignKeys(definition: string, schemaName: string, tableName: string): SqlForeignKeyDefinition[] {
  const foreignKeys: SqlForeignKeyDefinition[] = [];
  const tableLevelPattern = /(?:CONSTRAINT\s+[`"[]?([A-Za-z_][\w]*)[`"\]]?\s+)?FOREIGN\s+KEY\s*\(([^)]+)\)\s+REFERENCES\s+(?:(?:[`"[]?([A-Za-z_][\w]*)[`"\]]?)\.)?[`"[]?([A-Za-z_][\w]*)[`"\]]?\s*\(([^)]+)\)/giu;
  for (const match of definition.matchAll(tableLevelPattern)) {
    if (!match[2] || !match[4] || !match[5]) continue;
    foreignKeys.push({
      name: match[1] ?? null,
      columns: parseSqlIdentifierList(match[2]),
      referencedSchema: match[3] ?? schemaName,
      referencedTable: match[4],
      referencedColumns: parseSqlIdentifierList(match[5]),
    });
  }
  const knownKeys = new Set(foreignKeys.map((key) => `${key.columns.join(',')}->${key.referencedSchema}.${key.referencedTable}(${key.referencedColumns.join(',')})`));
  for (const line of definition.split('\n').map((item) => item.trim().replace(/,$/u, ''))) {
    const inlineMatch = line.match(/^[`"[]?([A-Za-z_][\w]*)[`"\]]?\s+[A-Za-z][\w()]*.*?\bREFERENCES\s+(?:(?:[`"[]?([A-Za-z_][\w]*)[`"\]]?)\.)?[`"[]?([A-Za-z_][\w]*)[`"\]]?\s*\(([^)]+)\)/iu);
    if (!inlineMatch?.[1] || !inlineMatch[3] || !inlineMatch[4]) continue;
    if (['constraint', 'foreign', 'primary', 'unique', 'check'].includes(inlineMatch[1].toLowerCase())) continue;
    const key: SqlForeignKeyDefinition = {
      // 内联 REFERENCES 通常没有显式约束名；生成稳定名称只用于展示来源，不代表数据库内真实命名。
      name: `inline_${tableName}_${inlineMatch[1]}_fk`,
      columns: [inlineMatch[1]],
      referencedSchema: inlineMatch[2] ?? schemaName,
      referencedTable: inlineMatch[3],
      referencedColumns: parseSqlIdentifierList(inlineMatch[4]),
    };
    const dedupeKey = `${key.columns.join(',')}->${key.referencedSchema}.${key.referencedTable}(${key.referencedColumns.join(',')})`;
    if (!knownKeys.has(dedupeKey)) foreignKeys.push(key);
  }
  return foreignKeys;
}

function parseSqlIdentifierList(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim().replace(/[`"[\]]/gu, ''))
    .filter(Boolean);
}

/** 从 Fastify server.get/post/... 调用抽取真实本地 API 路由事实。 */
function extractFastifyApiSymbols(file: ScannedFile, content: string, language: string): CodeSymbolFact[] {
  if (!['typescript', 'javascript'].includes(language)) return [];
  const symbols: CodeSymbolFact[] = [];
  for (const route of extractFastifyRouteDeclarations(content)) {
    const { method, path } = route;
    const lineNo = route.lineStart;
    const handlerQualifiedName = `${file.relativePath}#handler:${method}:${path}`;
    symbols.push(
      makeSymbol('api', `${method} ${path}`, `${file.relativePath}#api:${method}:${path}`, file.absolutePath, lineNo, lineNo, language, file.sourceHash, {
        method,
        path,
        framework: 'fastify',
        handlerKind: route.handlerKind,
        handlerQualifiedName,
        handlerLineStart: lineNo,
        handlerLineEnd: route.lineEnd,
      }),
    );
    symbols.push(
      makeSymbol('function', `${method} ${path} handler`, handlerQualifiedName, file.absolutePath, lineNo, route.lineEnd, language, file.sourceHash, {
        sourceKind: 'fastify_route_handler',
        method,
        path,
        framework: 'fastify',
      }),
    );
  }
  return symbols;
}

/** Fastify 路由在 Prettier 换行后仍应被识别，避免源码排版影响代码地图事实。 */
function extractFastifyRouteDeclarations(content: string): FastifyRouteDeclaration[] {
  const routes: FastifyRouteDeclaration[] = [];
  const routePattern = /\bserver\s*\.\s*(get|post|put|patch|delete)\s*\(\s*(['"`])([^'"`]+)\2/giu;
  for (const match of content.matchAll(routePattern)) {
    const method = match[1]?.toUpperCase();
    const path = match[3];
    if (!method || !path?.startsWith('/')) continue;
    const matchIndex = match.index ?? 0;
    const lineStart = content.slice(0, matchIndex).split('\n').length;
    const lineEnd = findFastifyRouteHandlerLineEnd(content, matchIndex, lineStart);
    const routeSnippet = content.slice(matchIndex, Math.min(content.length, matchIndex + 600));
    routes.push({
      method,
      path,
      lineStart,
      lineEnd,
      handlerKind: /\basync\b/u.test(routeSnippet) ? 'inline_async_handler' : 'inline_handler',
    });
  }
  return routes;
}

/** 定位 Fastify handler 的真实函数体结束行，避免把 TypeScript 泛型里的 `{}` 误判为路由体。 */
function findFastifyRouteHandlerLineEnd(content: string, routeStartIndex: number, fallbackLineStart: number): number {
  const arrowIndex = content.indexOf('=>', routeStartIndex);
  if (arrowIndex < 0) return fallbackLineStart;
  let bodyStart = arrowIndex + 2;
  while (bodyStart < content.length && /\s/u.test(content[bodyStart] ?? '')) bodyStart += 1;
  const opener = content[bodyStart];
  if (opener === '{') {
    return lineNumberAtIndex(content, findMatchingDelimiterIndex(content, bodyStart, '{', '}'));
  }
  if (opener === '(') {
    return lineNumberAtIndex(content, findMatchingDelimiterIndex(content, bodyStart, '(', ')'));
  }
  const routeCallEnd = content.indexOf(');', bodyStart);
  return lineNumberAtIndex(content, routeCallEnd >= 0 ? routeCallEnd : bodyStart);
}

function lineNumberAtIndex(content: string, index: number): number {
  const safeIndex = Math.max(0, Math.min(index, content.length));
  return content.slice(0, safeIndex).split('\n').length;
}

function findMatchingDelimiterIndex(content: string, openIndex: number, open: string, close: string): number {
  let depth = 0;
  let quote: '"' | "'" | '`' | null = null;
  let escaped = false;
  for (let index = openIndex; index < content.length; index += 1) {
    const char = content[index];
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === open) depth += 1;
    if (char === close) {
      depth -= 1;
      if (depth <= 0) return index;
    }
  }
  return openIndex;
}

function makeSymbol(
  symbolType: CodeSymbolFact['symbolType'],
  name: string,
  qualifiedName: string,
  filePath: string,
  lineStart: number,
  lineEnd: number,
  language: string,
  sourceHash: string,
  metadata: Record<string, unknown>,
): CodeSymbolFact {
  return {
    id: `symbol_${nanoid(12)}`,
    symbolType,
    name,
    qualifiedName,
    filePath,
    lineStart,
    lineEnd,
    language,
    sourceHash,
    metadata,
  };
}

function detectLanguage(extension: string): string {
  switch (extension) {
    case '.ts':
    case '.tsx':
      return 'typescript';
    case '.js':
    case '.jsx':
      return 'javascript';
    case '.json':
      return 'json';
    case '.md':
      return 'markdown';
    case '.java':
      return 'java';
    case '.xml':
      return 'xml';
    case '.sql':
      return 'sql';
    case '.gradle':
    case '.kts':
      return 'gradle';
    case '.yml':
    case '.yaml':
      return 'yaml';
    case '.properties':
      return 'properties';
    default:
      return 'unknown';
  }
}
