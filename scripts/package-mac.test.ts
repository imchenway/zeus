import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('package-mac script helpers', () => {
  it('builds deterministic Electron cache names for macOS packaging', async () => {
    const { electronDistDirName, electronZipFileName } = await import('./package-mac.mjs');

    expect(electronZipFileName('36.9.5', 'arm64')).toBe('electron-v36.9.5-darwin-arm64.zip');
    expect(electronDistDirName('36.9.5', 'arm64')).toBe('electron-v36.9.5-darwin-arm64');
  });

  it('refuses to overwrite the packaged Zeus app while that app is still running', async () => {
    const { findRunningPackagedAppProcesses, formatRunningPackagedAppError } = await import('./package-mac.mjs');
    const appPath = '/Users/david/hypha/zeus/dist/mac-arm64/Zeus.app';
    const psOutput = [`36562 ${appPath}/Contents/MacOS/Zeus`, `36564 ${appPath}/Contents/Frameworks/Zeus Helper.app/Contents/MacOS/Zeus Helper --type=gpu-process`, '40000 /Applications/Other.app/Contents/MacOS/Other'].join('\n');

    const running = findRunningPackagedAppProcesses(psOutput, appPath);

    expect(running).toHaveLength(1);
    expect(running[0]).toContain('/Contents/MacOS/Zeus');
    expect(formatRunningPackagedAppError(appPath, running)).toContain('先退出当前 Zeus');
  });

  it('does not mistake the packaging shell command for a running Zeus app process', async () => {
    const { findRunningPackagedAppProcesses } = await import('./package-mac.mjs');
    const appPath = '/Users/david/hypha/zeus/dist/mac-arm64/Zeus.app';
    const psOutput = `56928 /bin/zsh -c pkill -f '${appPath}/Contents/MacOS/Zeus' || true; pnpm package:mac`;

    expect(findRunningPackagedAppProcesses(psOutput, appPath)).toHaveLength(0);
  });

  it('uses Zeus branded macOS icon assets instead of the default Electron icon', () => {
    const config = readFileSync(join(process.cwd(), 'apps', 'desktop', 'electron-builder.yml'), 'utf8');
    const trayIcon = readFileSync(join(process.cwd(), 'apps', 'desktop', 'assets', 'trayTemplate.png'));
    const trayIconWidth = trayIcon.readUInt32BE(16);
    const trayIconHeight = trayIcon.readUInt32BE(20);

    expect(config).toContain('icon: assets/icon.icns');
    expect(config).toContain('assets/**');
    expect(existsSync(join(process.cwd(), 'apps', 'desktop', 'assets', 'icon.icns'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'apps', 'desktop', 'assets', 'icon.svg'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'apps', 'desktop', 'assets', 'trayTemplate.png'))).toBe(true);
    expect(trayIconWidth).toBeGreaterThanOrEqual(16);
    expect(trayIconHeight).toBeGreaterThanOrEqual(16);
  });

  it('keeps optional macOS tray failures from blocking settings saves in packaged app', () => {
    const mainSource = readFileSync(join(process.cwd(), 'apps', 'desktop', 'src', 'main', 'main.ts'), 'utf8');

    expect(mainSource).toContain('function setupTraySafely(): void');
    expect(mainSource).toContain('nativeImage.createFromBuffer(readFileSync(trayIconPath))');
    expect(mainSource).toContain('托盘图标缺失或 macOS 拒绝创建 Tray 时，不阻断设置保存和主窗口功能。');
    expect(mainSource).toMatch(/ipcMain\.handle\('zeus:app-shell-settings-changed'[\s\S]*setupTraySafely\(\);[\s\S]*return \{ applied: true \};/);
    expect(mainSource).toMatch(/app\.whenReady\(\)\.then\(async \(\) => \{[\s\S]*setupTraySafely\(\);[\s\S]*await createWindow\(\);/);
  });

  it('uses a hidden macOS titlebar so Zeus content reaches the window top like Codex', () => {
    const mainSource = readFileSync(join(process.cwd(), 'apps', 'desktop', 'src', 'main', 'main.ts'), 'utf8');

    expect(mainSource).toContain("titleBarStyle: 'hiddenInset'");
    expect(mainSource).toContain('trafficLightPosition: { x: 14, y: 16 }');
    expect(mainSource).not.toContain("titleBarStyle: 'default'");
  });

  it('shows the packaged macOS main window even if ready-to-show is missed', () => {
    const mainSource = readFileSync(join(process.cwd(), 'apps', 'desktop', 'src', 'main', 'main.ts'), 'utf8');

    expect(mainSource).toContain('function revealMainWindow');
    expect(mainSource).toContain('revealMainWindowOnce');
    expect(mainSource).toContain('setTimeout(revealMainWindowOnce, 1200)');
  });

  it('keeps design-book development entrypoints wired to the macOS run script', () => {
    const rootPackage = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    const desktopPackage = JSON.parse(readFileSync(join(process.cwd(), 'apps', 'desktop', 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    const devScript = readFileSync(join(process.cwd(), 'scripts', 'dev.sh'), 'utf8');

    expect(rootPackage.scripts.dev).toBe('pnpm --filter @zeus/desktop dev');
    expect(desktopPackage.scripts.dev).toBe('../../script/build_and_run.sh');
    expect(devScript).toContain('pnpm --filter @zeus/desktop dev');
    expect(devScript).not.toContain('pnpm --filter @zeus/desktop build');
  });

  it('keeps the Codex Run button and macOS run script aligned with project-local logs', () => {
    const runScript = readFileSync(join(process.cwd(), 'script', 'build_and_run.sh'), 'utf8');
    const environment = readFileSync(join(process.cwd(), '.codex', 'environments', 'environment.toml'), 'utf8');

    expect(environment).toContain('name = "Run"');
    expect(environment).toContain('command = "./script/build_and_run.sh"');
    expect(runScript).toContain('LOG_FILE="$ROOT_DIR/.tmp/zeus-electron.log"');
    expect(runScript).toContain('mkdir -p "$(dirname "$LOG_FILE")"');
    expect(runScript).toContain('--verify|verify)');
    expect(runScript).toContain('ELECTRON_BIN="$(node -p "require(\'electron\')")"');
    expect(runScript).toContain('"$ELECTRON_BIN" "$DESKTOP_DIR"');
    expect(runScript).not.toContain('electron "$MAIN_ENTRY"');
    expect(runScript).not.toContain('/tmp/zeus-electron.log');
  });

  it('builds renderer assets with file-url safe relative paths for the packaged macOS app', () => {
    const viteConfig = readFileSync(join(process.cwd(), 'apps', 'desktop', 'vite.config.ts'), 'utf8');

    expect(viteConfig).toContain("base: './'");
  });

  it('checks packaged asar renderer entrypoint assets instead of trusting a blank window', () => {
    const healthScript = readFileSync(join(process.cwd(), 'scripts', 'verify-packaged-app-health.mjs'), 'utf8');

    expect(healthScript).toContain('readAsarTextFile');
    expect(healthScript).toContain('assertPackagedRendererEntrypoint');
    expect(healthScript).toContain('root-relative asset URL');
  });

  it('loads Electron preload as a CommonJS bridge in packaged macOS builds', () => {
    const mainSource = readFileSync(join(process.cwd(), 'apps', 'desktop', 'src', 'main', 'main.ts'), 'utf8');
    const preloadConfig = readFileSync(join(process.cwd(), 'apps', 'desktop', 'tsconfig.preload.json'), 'utf8');

    expect(mainSource).toContain("join(desktopRoot(), 'dist/preload/index.cjs')");
    expect(mainSource).toContain("window.once('ready-to-show'");
    expect(mainSource).toContain('app.focus({ steal: true })');
    expect(preloadConfig).toContain('"src/preload/**/*.cts"');
    expect(existsSync(join(process.cwd(), 'apps', 'desktop', 'src', 'preload', 'index.cts'))).toBe(true);
  });

  it('provides a manual macOS window drag bridge when app-region drag is ignored', () => {
    const mainSource = readFileSync(join(process.cwd(), 'apps', 'desktop', 'src', 'main', 'main.ts'), 'utf8');
    const preloadSource = readFileSync(join(process.cwd(), 'apps', 'desktop', 'src', 'preload', 'index.cts'), 'utf8');
    const globalTypes = readFileSync(join(process.cwd(), 'apps', 'desktop', 'src', 'renderer', 'global.d.ts'), 'utf8');

    expect(mainSource).toContain("ipcMain.handle('zeus:window-drag-start'");
    expect(mainSource).toContain("ipcMain.handle('zeus:window-drag-move'");
    expect(mainSource).toContain("ipcMain.handle('zeus:window-drag-end'");
    expect(mainSource).toContain('setPosition(nextX, nextY');
    expect(preloadSource).toContain('beginWindowDrag');
    expect(preloadSource).toContain('moveWindowDrag');
    expect(preloadSource).toContain('endWindowDrag');
    expect(globalTypes).toContain('beginWindowDrag');
  });

  it('keeps acceptance matrix verification wired to the design book source', () => {
    const rootPackage = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    const scriptPath = join(process.cwd(), 'scripts', 'verify-acceptance-matrix.mjs');
    expect(rootPackage.scripts['verify:acceptance-matrix']).toBe('node scripts/verify-acceptance-matrix.mjs --check');
    expect(existsSync(scriptPath)).toBe(true);

    const verifier = readFileSync(scriptPath, 'utf8');
    expect(verifier).toContain('docs/zeus_development_design.md');
    expect(verifier).toContain('docs/zeus_acceptance_matrix.json');
    expect(verifier).toContain('parseDesignBookChapter25');
    expect(verifier).toContain('矩阵项数与设计书第 25 章不一致');
  });

  it('treats Postgres and MySQL drivers as optional connectors instead of local-core blockers', () => {
    const matrix = JSON.parse(readFileSync(join(process.cwd(), 'docs', 'zeus_acceptance_matrix.json'), 'utf8')) as {
      optionalConnectors?: Array<{
        id: string;
        packages: string[];
        requiredForLocalCore: boolean;
        status: string;
      }>;
      sections: Array<{ id: string; blockers: string[] }>;
    };

    expect(matrix.optionalConnectors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'postgres-mysql-schema-introspection',
          packages: ['pg', 'mysql2'],
          requiredForLocalCore: false,
          status: 'waiting_user_project_configuration',
        }),
      ]),
    );
    const coreBlockerText = matrix.sections.flatMap((section) => section.blockers).join('\n');
    expect(coreBlockerText).not.toContain('pg/mysql2 未批准');
    expect(coreBlockerText).not.toContain('Postgres/MySQL driver 未批准');
  });

  it('classifies chapter 25 acceptance items by real completion state instead of a generic bucket', () => {
    const matrix = JSON.parse(readFileSync(join(process.cwd(), 'docs', 'zeus_acceptance_matrix.json'), 'utf8')) as {
      sections: Array<{
        items?: Array<{
          line: number;
          text: string;
          status: string;
          blocker?: string;
        }>;
      }>;
    };
    const allItems = matrix.sections.flatMap((section) => section.items ?? []);
    const itemByText = new Map(allItems.map((item) => [item.text, item]));

    expect(itemByText.get('node-pty 启动本地 AI CLI。')).toEqual(expect.objectContaining({ status: 'verified' }));
    expect(itemByText.get('大图 WebGL。')).toEqual(expect.objectContaining({ status: 'verified' }));
    expect(itemByText.get('局部 React Flow。')).toEqual(expect.objectContaining({ status: 'verified' }));
    expect(itemByText.get('Bot Token。')).toEqual(expect.objectContaining({ status: 'verified' }));
    expect(itemByText.get('本地服务不暴露公网。')).toEqual(expect.objectContaining({ status: 'verified' }));
    expect(allItems.some((item) => item.status === 'verified_or_tracked')).toBe(false);
  });

  it('keeps Telegram credential capabilities verified without requiring real user secrets in chapter 25', () => {
    const matrix = JSON.parse(readFileSync(join(process.cwd(), 'docs', 'zeus_acceptance_matrix.json'), 'utf8')) as {
      sections: Array<{
        items?: Array<{
          line: number;
          text: string;
          status: string;
          blocker?: string;
        }>;
      }>;
    };
    const externalWaitItems = matrix.sections.flatMap((section) => section.items ?? []).filter((item) => item.status === 'external_credential_wait');

    expect(externalWaitItems).toEqual([]);
  });

  it('keeps optional database connectors outside chapter 25 core item wait states', () => {
    const matrix = JSON.parse(readFileSync(join(process.cwd(), 'docs', 'zeus_acceptance_matrix.json'), 'utf8')) as {
      optionalConnectors?: Array<{
        id: string;
        packages: string[];
        requiredForLocalCore: boolean;
      }>;
      sections: Array<{
        items?: Array<{
          line: number;
          text: string;
          status: string;
          blocker?: string;
        }>;
      }>;
    };
    const optionalWaitItems = matrix.sections.flatMap((section) => section.items ?? []).filter((item) => item.status === 'optional_connector_wait');

    expect(optionalWaitItems).toEqual([]);
    expect(matrix.optionalConnectors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'postgres-mysql-schema-introspection',
          packages: ['pg', 'mysql2'],
          requiredForLocalCore: false,
        }),
      ]),
    );
  });

  it('promotes implemented local-core chapter 25 items from tracked to verified evidence states', () => {
    const matrix = JSON.parse(readFileSync(join(process.cwd(), 'docs', 'zeus_acceptance_matrix.json'), 'utf8')) as {
      sections: Array<{
        items?: Array<{
          line: number;
          text: string;
          status: string;
          blocker?: string;
        }>;
      }>;
    };
    const allowedTrackedLines = new Set<number>();
    const remainingTrackedItems = matrix.sections.flatMap((section) => section.items ?? []).filter((item) => item.status === 'tracked' && !allowedTrackedLines.has(item.line));

    expect(remainingTrackedItems).toEqual([]);
  });

  it('keeps every chapter 25 acceptance item traceable by line number and text', () => {
    const matrix = JSON.parse(readFileSync(join(process.cwd(), 'docs', 'zeus_acceptance_matrix.json'), 'utf8')) as {
      sections: Array<{
        id: string;
        items?: Array<{ line: number; text: string; status: string }>;
      }>;
    };
    const allItems = matrix.sections.flatMap((section) => section.items ?? []);

    expect(allItems).toHaveLength(139);
    expect(matrix.sections.every((section) => Array.isArray(section.items) && section.items.length > 0)).toBe(true);
    expect(allItems).toContainEqual(
      expect.objectContaining({
        line: 2410,
        text: 'node-pty 启动本地 AI CLI。',
      }),
    );
    expect(allItems).toContainEqual(expect.objectContaining({ line: 2472, text: '大图 WebGL。' }));
    expect(allItems).toContainEqual(expect.objectContaining({ line: 2515, text: '本地服务不暴露公网。' }));
    expect(allItems.every((item) => typeof item.status === 'string' && item.status.length > 0)).toBe(true);
  });

  it('keeps a machine-readable design-book acceptance matrix for all chapter 25 items', () => {
    const matrixPath = join(process.cwd(), 'docs', 'zeus_acceptance_matrix.json');
    expect(existsSync(matrixPath)).toBe(true);
    const matrix = JSON.parse(readFileSync(matrixPath, 'utf8')) as {
      source: string;
      totalItems: number;
      sections: Array<{
        id: string;
        title: string;
        itemCount: number;
        status: string;
        blockers: string[];
      }>;
    };

    expect(matrix.source).toBe('docs/zeus_development_design.md#25');
    expect(matrix.totalItems).toBe(139);
    expect(matrix.sections).toHaveLength(12);
    expect(matrix.sections.map((section) => section.itemCount).reduce((sum, count) => sum + count, 0)).toBe(139);
    expect(matrix.sections.find((section) => section.id === '25.4')?.blockers).not.toContain('node-pty/xterm 未批准，真实 PTY、resize、xterm.js 终端未完成');
    expect(matrix.sections.find((section) => section.id === '25.9')?.blockers).not.toContain('Sigma/WebGL 与 React Flow 未批准，真实大图/局部图运行时未完成');
    expect(matrix.sections.find((section) => section.id === '25.12')?.blockers).toEqual([]);
  });

  it('declares approved PTY terminal runtime dependencies without adding optional database drivers', () => {
    const rootPackage = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const aiRuntimePackage = JSON.parse(readFileSync(join(process.cwd(), 'packages', 'ai-runtime', 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
    const desktopPackage = JSON.parse(readFileSync(join(process.cwd(), 'apps', 'desktop', 'package.json'), 'utf8')) as { dependencies: Record<string, string> };

    expect(aiRuntimePackage.dependencies).toHaveProperty('node-pty');
    expect(desktopPackage.dependencies).toHaveProperty('@xterm/xterm');
    for (const dependencies of [rootPackage.dependencies, rootPackage.devDependencies, aiRuntimePackage.dependencies, desktopPackage.dependencies]) {
      expect(dependencies).not.toHaveProperty('pg');
      expect(dependencies).not.toHaveProperty('mysql2');
    }
  });

  it('declares approved graph runtime dependencies without adding optional database drivers', () => {
    const desktopPackage = JSON.parse(readFileSync(join(process.cwd(), 'apps', 'desktop', 'package.json'), 'utf8')) as { dependencies: Record<string, string> };

    expect(desktopPackage.dependencies).toHaveProperty('@xyflow/react');
    expect(desktopPackage.dependencies).toHaveProperty('sigma');
    expect(desktopPackage.dependencies).toHaveProperty('graphology');
    expect(desktopPackage.dependencies).not.toHaveProperty('pg');
    expect(desktopPackage.dependencies).not.toHaveProperty('mysql2');
  });

  it('passes macOS SDK C++ include paths to electron rebuild for native PTY packaging', () => {
    const packageScript = readFileSync(join(process.cwd(), 'scripts', 'package-mac.mjs'), 'utf8');

    expect(packageScript).toContain('buildMacNativeDependencyEnv');
    expect(packageScript).toContain('CPLUS_INCLUDE_PATH');
    expect(packageScript).toContain("execFileSync('xcrun', ['--show-sdk-path']");
  });

  it('keeps release verification and Homebrew cask cleanup contracts aligned with the design book', () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    const cask = readFileSync(join(process.cwd(), 'Casks', 'zeus.rb'), 'utf8');
    const verifyRelease = readFileSync(join(process.cwd(), 'scripts', 'verify-release.sh'), 'utf8');
    const packagedHealthScript = join(process.cwd(), 'scripts', 'verify-packaged-app-health.mjs');
    const javaSpringFixtureScript = join(process.cwd(), 'scripts', 'verify-java-spring-fixture.mjs');

    expect(packageJson.scripts['verify:release']).toBe('bash scripts/verify-release.sh');
    expect(existsSync(packagedHealthScript)).toBe(true);
    expect(existsSync(javaSpringFixtureScript)).toBe(true);
    expect(cask).toContain('app "Zeus.app"');
    expect(cask).toContain('uninstall');
    expect(cask).toContain('launchctl: "dev.hypha.zeus"');
    expect(cask).toContain('zap trash:');
    expect(cask).toContain('~/Library/Application Support/Zeus');
    expect(cask).not.toContain('sha256 :no_check');
    expect(verifyRelease).toContain('dist/Zeus-${version}-${package_arch}.dmg');
    expect(verifyRelease).toContain('dist/Zeus-${version}-${package_arch}.zip');
    expect(verifyRelease).toContain('Casks/zeus.rb');
    expect(verifyRelease).toContain('node scripts/generate-homebrew-cask.mjs');
    expect(verifyRelease).toContain('dist/homebrew/zeus.rb');
    expect(verifyRelease).toContain('pnpm verify:acceptance-matrix');
    expect(verifyRelease).toContain('scripts/verify-packaged-app-health.mjs "$app"');
    expect(verifyRelease).toContain('node scripts/verify-java-spring-fixture.mjs');
  });

  it('keeps AI CLI adapter probing in the release gate without fabricating login state', () => {
    const verifyRelease = readFileSync(join(process.cwd(), 'scripts', 'verify-release.sh'), 'utf8');
    const probePath = join(process.cwd(), 'scripts', 'verify-ai-cli-adapters.mjs');

    expect(existsSync(probePath)).toBe(true);
    const probe = readFileSync(probePath, 'utf8');

    expect(verifyRelease).toContain('node scripts/verify-ai-cli-adapters.mjs');
    expect(probe).toContain('checkAiCliAdapter');
    expect(probe).toContain("'codex'");
    expect(probe).toContain("'claude'");
    expect(probe).toContain("'gemini'");
    expect(probe).toContain('ai-cli-adapters=checked');
    expect(probe).toContain('authStatus');
    expect(probe).not.toContain("authStatus: 'authenticated'");
  });

  it('verifies Java Spring MyBatis scanner support with a source-backed local fixture', () => {
    const probe = readFileSync(join(process.cwd(), 'scripts', 'verify-java-spring-fixture.mjs'), 'utf8');

    expect(probe).toContain('scanProjectSource');
    expect(probe).toContain('@RestController');
    expect(probe).toContain('@Transactional');
    expect(probe).toContain('@Mapper');
    expect(probe).toContain('<mapper namespace=');
    expect(probe).toContain('java-spring-fixture=');
  });

  it('verifies packaged app renderer and main entry health without opening a GUI window', () => {
    const probe = readFileSync(join(process.cwd(), 'scripts', 'verify-packaged-app-health.mjs'), 'utf8');

    expect(probe).toContain('Contents/Resources/app.asar');
    expect(probe).toContain('assertPackagedRendererEntrypoint');
    expect(probe).toContain('process.noAsar');
    expect(probe).toContain('dist/renderer/index.html');
    expect(probe).toContain('dist/main/main.js');
    expect(probe).toContain('root-relative asset URL');
    expect(probe).not.toContain('open -n');
    expect(probe).not.toContain('BrowserWindow');
  });

  it('reads padded asar file contents from the aligned payload boundary', async () => {
    const { alignAsarContentOffset, readAsarTextFile } = await import('./verify-packaged-app-health.mjs');
    const dir = await mkdtemp(join(tmpdir(), 'zeus-asar-padding-'));
    try {
      const asarPath = join(dir, 'app.asar');
      const content = '{\n  "name": "@zeus/desktop"\n}';
      const header = Buffer.from(
        JSON.stringify({
          files: {
            'package.json': {
              size: Buffer.byteLength(content),
              offset: '0',
            },
          },
        }),
        'utf8',
      );
      const contentStart = alignAsarContentOffset(16, header.length);
      const archive = Buffer.concat([Buffer.from(new Uint32Array([4, contentStart - 8, header.length + 6, header.length]).buffer), header, Buffer.alloc(contentStart - 16 - header.length), Buffer.from(content, 'utf8')]);
      await writeFile(asarPath, archive);

      expect(readAsarTextFile(asarPath, 'package.json')).toBe(content);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('generates a release Homebrew cask with the real DMG sha256 instead of no_check', async () => {
    const { generateHomebrewCask } = await import('./generate-homebrew-cask.mjs');
    const dir = await mkdtemp(join(tmpdir(), 'zeus-homebrew-cask-'));
    try {
      const dmgPath = join(dir, 'Zeus-0.1.0-arm64.dmg');
      const outputPath = join(dir, 'homebrew', 'zeus.rb');
      await writeFile(dmgPath, '真实 Zeus DMG bytes');

      const result = await generateHomebrewCask({
        version: '0.1.0',
        arch: 'arm64',
        dmgPath,
        outputPath,
      });
      const cask = readFileSync(outputPath, 'utf8');

      expect(result.sha256).toBe('ead1bfa76f108739a445d3fb0a3831a1ebcdf66831332218b543a2ce229f202e');
      expect(cask).toContain('version "0.1.0"');
      expect(cask).toContain('sha256 "ead1bfa76f108739a445d3fb0a3831a1ebcdf66831332218b543a2ce229f202e"');
      expect(cask).toContain('url "https://github.com/imchenway/zeus/releases/download/v#{version}/Zeus-#{version}-arm64.dmg"');
      expect(cask).toContain('app "Zeus.app"');
      expect(cask).not.toContain('sha256 :no_check');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('declares public open-source package metadata and quality scripts for new contributors', () => {
    const rootPackage = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      packageManager?: string;
      engines?: Record<string, string>;
      license?: string;
      repository?: { type: string; url: string };
      bugs?: { url: string };
      homepage?: string;
      scripts: Record<string, string>;
    };

    expect(rootPackage.packageManager).toMatch(/^pnpm@/u);
    expect(rootPackage.engines).toMatchObject({
      node: expect.stringContaining('>=24'),
      pnpm: expect.stringContaining('>=10'),
    });
    expect(rootPackage.license).toBe('MIT');
    expect(rootPackage.repository).toEqual({
      type: 'git',
      url: 'git+https://github.com/imchenway/zeus.git',
    });
    expect(rootPackage.bugs).toEqual({
      url: 'https://github.com/imchenway/zeus/issues',
    });
    expect(rootPackage.homepage).toBe('https://github.com/imchenway/zeus#readme');
    expect(rootPackage.scripts).toMatchObject({
      format: expect.stringContaining('prettier --write'),
      'format:check': expect.stringContaining('prettier --check'),
      'security:audit': 'pnpm audit --audit-level=moderate',
      'verify:quick': expect.stringContaining('pnpm security:audit'),
    });
  });

  it('generates install.sh and update manifest artifacts for GitHub Releases', async () => {
    const { renderInstallScript } = await import('./generate-install-script.mjs');
    const { renderReleaseManifest } = await import('./generate-release-manifest.mjs');
    const installScript = renderInstallScript({
      repository: 'imchenway/zeus',
      channel: 'stable',
    });
    const manifest = renderReleaseManifest({
      version: '0.2.0',
      channel: 'stable',
      repository: 'imchenway/zeus',
      signed: false,
      notarized: false,
      artifacts: [
        {
          arch: 'arm64',
          kind: 'dmg',
          fileName: 'Zeus-0.2.0-arm64.dmg',
          sha256: 'arm-dmg-sha',
        },
      ],
    });

    expect(installScript).toContain('ZEUS_CHANNEL');
    expect(installScript).toContain('ZEUS_INSTALL_DIR');
    expect(installScript).toContain('ZEUS_NON_INTERACTIVE');
    expect(installScript).toContain('uname -m');
    expect(installScript).toContain('SHA256SUMS');
    expect(installScript).toContain('hdiutil attach');
    expect(installScript).toContain('github.com/imchenway/zeus');
    expect(installScript).not.toContain('github.com/hypha/zeus');
    expect(JSON.parse(manifest)).toMatchObject({
      app: 'Zeus',
      version: '0.2.0',
      repository: 'imchenway/zeus',
      installScriptUrl: 'https://github.com/imchenway/zeus/releases/latest/download/install.sh',
    });
  });

  it('extends verify-release with sha sums, install script, and update manifest checks', () => {
    const verifyRelease = readFileSync(join(process.cwd(), 'scripts', 'verify-release.sh'), 'utf8');

    expect(verifyRelease).toContain('dist/SHA256SUMS');
    expect(verifyRelease).toContain('node scripts/generate-release-manifest.mjs');
    expect(verifyRelease).toContain('dist/zeus-release-manifest.json');
    expect(verifyRelease).toContain('node scripts/generate-install-script.mjs');
    expect(verifyRelease).toContain('dist/install.sh');
  });

  it('hardens the Electron shell with sandbox, navigation, permission, and CSP contracts', () => {
    const mainSource = readFileSync(join(process.cwd(), 'apps', 'desktop', 'src', 'main', 'main.ts'), 'utf8');
    const rendererHtml = readFileSync(join(process.cwd(), 'apps', 'desktop', 'index.html'), 'utf8');

    expect(mainSource).toContain('sandbox: true');
    expect(mainSource).toContain('setWindowOpenHandler');
    expect(mainSource).toContain("return { action: 'deny' }");
    expect(mainSource).toContain("webContents.on('will-navigate'");
    expect(mainSource).toContain('setPermissionRequestHandler');
    expect(rendererHtml).toContain('Content-Security-Policy');
    expect(rendererHtml).toContain("object-src 'none'");
    expect(rendererHtml).toContain("frame-ancestors 'none'");
  });

  it('keeps production runtime code portable without hard-coded local checkout paths', () => {
    const productionFiles = [join(process.cwd(), 'apps', 'desktop', 'src', 'renderer', 'main.tsx'), join(process.cwd(), 'packages', 'local-server', 'src', 'index.ts'), join(process.cwd(), 'scripts', 'test-real-scan.sh')];

    for (const file of productionFiles) {
      expect(readFileSync(file, 'utf8')).not.toContain('/Users/david/hypha/zeus');
    }
  });

  it('keeps release documentation aligned with package scripts, artifacts, verification gate, signing waits, and Homebrew cask contracts', () => {
    const releasePath = join(process.cwd(), 'docs', 'release.md');
    expect(existsSync(releasePath)).toBe(true);
    const release = readFileSync(releasePath, 'utf8');

    expect(release).toContain('## 发布脚本');
    expect(release).toContain('pnpm dev、pnpm lint、pnpm typecheck、pnpm test、pnpm test:real-scan、pnpm build、pnpm package:mac、pnpm verify:release');
    expect(release).toContain('## 产物');
    expect(release).toContain('Zeus.app、Zeus-0.1.0-arm64.dmg、Zeus-0.1.0-arm64.zip、dist/homebrew/zeus.rb');
    expect(release).toContain('## 发布门禁');
    expect(release).toContain(
      'acceptance matrix、lint、typecheck、64 test files / 575 tests、真实扫描 174 files / 17036 nodes / 32848 edges / 7 views、Java/Spring/MyBatis fixture、AI CLI adapter 探针、build、package:mac、包内 Electron 加载',
    );
    expect(release).toContain('Java/Spring/MyBatis fixture：`java-spring-fixture=verified;files=6;symbols=42`');
    expect(release).toContain('AI CLI adapter 探针：`ai-cli-adapters=checked;');
    expect(release).toContain('包内 renderer/main 非 GUI 健康检查');
    expect(release).toContain('## 签名与 notarization');
    expect(release).toContain('Apple signing / notarization 未配置时，只能声明 unsigned DMG/ZIP，不伪造 notarization 成功');
    expect(release).toContain('## Homebrew cask');
    expect(release).toContain('sha256 由 release 脚本从真实 DMG 计算，不允许 sha256 :no_check');
    expect(release).toContain('## 外部等待项');
    expect(release).toContain('Apple Developer 证书、notarization 凭据、Homebrew tap token');
  });

  it('keeps Telegram documentation aligned with long polling, whitelist, command, notification, log, and degradation contracts', () => {
    const telegramPath = join(process.cwd(), 'docs', 'telegram.md');
    expect(existsSync(telegramPath)).toBe(true);
    const telegram = readFileSync(telegramPath, 'utf8');

    expect(telegram).toContain('## 接入方式');
    expect(telegram).toContain('Telegram Bot API long polling，本地 Zeus 主动轮询，不需要公网服务');
    expect(telegram).toContain('## 安全策略');
    expect(telegram).toContain('Bot Token 存 Keychain、allowed user id 白名单、不在 UI 明文显示 token、远程高风险操作二次确认');
    expect(telegram).toContain('## 命令集合');
    expect(telegram).toContain('/start、/help、/projects、/tasks、/run、/status、/stop、/continue、/logs、/diff、/ask');
    expect(telegram).toContain('## 通知与静默模式');
    expect(telegram).toContain('任务开始、阶段变化、等待确认、完成、失败、代码变更摘要、测试失败、安全确认');
    expect(telegram).toContain('## 消息限制与脱敏');
    expect(telegram).toContain('长日志自动截断、大 diff 只发摘要、完整日志导出为本机文件、不发送密钥、token、环境变量');
    expect(telegram).toContain('## 降级与等待项');
    expect(telegram).toContain('Telegram Bot Token 未配置');
    expect(telegram).toContain('不生成假 Telegram 消息或假远程命令结果');
  });

  it('keeps Code Map documentation aligned with scan, graph model, views, interaction, and AI graph contracts', () => {
    const codeMapPath = join(process.cwd(), 'docs', 'code-map-engine.md');
    expect(existsSync(codeMapPath)).toBe(true);
    const codeMap = readFileSync(codeMapPath, 'utf8');

    expect(codeMap).toContain('## 扫描阶段');
    expect(codeMap).toContain('目录发现、语言/构建识别、源码解析、SQL/DDL 解析、图谱 facts 写入、视图生成');
    expect(codeMap).toContain('## 图谱模型');
    expect(codeMap).toContain('project_node、project_edge、metadata、sourceRef、confidence');
    expect(codeMap).toContain('## 视图类型');
    expect(codeMap).toContain('系统架构图、表关系图、模块图、模块详情图、接口时序图、模块流程图、方法逻辑图');
    expect(codeMap).toContain('## 交互与性能');
    expect(codeMap).toContain('搜索、过滤、节点详情、边详情、一跳/二跳、视图缓存、后台布局、节点聚合、边聚合');
    expect(codeMap).toContain('## AI 与图谱联动');
    expect(codeMap).toContain('回答必须带来源，从图谱节点/问答创建任务，任务完成后回写图谱');
    expect(codeMap).toContain('## 等待项与禁止项');
    expect(codeMap).toContain('React Flow / Sigma 已作为设计书指定的大图/局部图渲染依赖接入');
    expect(codeMap).toContain('不生成无来源节点、无来源边、假图表或假 AI 摘要');
  });

  it('keeps AI Runtime documentation aligned with adapter, session, prompt, log, and degradation contracts', () => {
    const runtimePath = join(process.cwd(), 'docs', 'ai-runtime.md');
    expect(existsSync(runtimePath)).toBe(true);
    const runtime = readFileSync(runtimePath, 'utf8');

    expect(runtime).toContain('## Adapter 契约');
    expect(runtime).toContain('Codex、Claude Code、Gemini、Generic CLI');
    expect(runtime).toContain('本机命令检测、版本检测、登录/认证状态检测、模型配置、工作目录配置、prompt 输入、输出解析');
    expect(runtime).toContain('## 会话生命周期');
    expect(runtime).toContain('created、running、waiting、ended、failed、orphan_detected、lost');
    expect(runtime).toContain('## Prompt 生成');
    expect(runtime).toContain('任务标题、任务描述、项目路径、图谱上下文、源码路径和行号、SQL/表、Git 状态摘要、测试要求、安全要求');
    expect(runtime).toContain('## 日志与导出');
    expect(runtime).toContain('terminal.raw.log、terminal.normalized.log、metadata.json、chunks/');
    expect(runtime).toContain('## 降级与等待项');
    expect(runtime).toContain('node-pty / xterm.js 已接入');
    expect(runtime).toContain('AI CLI adapter 探针已纳入 `pnpm verify:release`');
    expect(runtime).toContain('AI CLI 未安装、未登录或不可用时，不生成假终端输出、假 AI 回复或伪摘要');
  });

  it('keeps security documentation aligned with local API, Keychain, confirmation, redaction, and release wait contracts', () => {
    const securityPath = join(process.cwd(), 'docs', 'security.md');
    expect(existsSync(securityPath)).toBe(true);
    const security = readFileSync(securityPath, 'utf8');

    expect(security).toContain('## 本地 API 边界');
    expect(security).toContain('127.0.0.1、随机端口、Bearer token、preload token bridge、CORS');
    expect(security).toContain('## Keychain 与密钥状态');
    expect(security).toContain('Telegram Bot Token、外部 API Key、本地 API token、数据库连接密码');
    expect(security).toContain('## 执行目录限制');
    expect(security).toContain('AI Runtime、Git 操作、文件操作必须限制在项目路径内');
    expect(security).toContain('## 高风险二次确认');
    expect(security).toContain('删除文件、执行 shell 命令、Git commit、Git push、Git reset、写入项目外目录、读取疑似密钥文件');
    expect(security).toContain('## 敏感日志脱敏');
    expect(security).toContain('API key、Bot token、Authorization header、Cookie、SSH key、数据库密码、.env 中敏感值');
    expect(security).toContain('## 远程入口与发布等待项');
    expect(security).toContain('Telegram 白名单、Apple signing / notarization、Homebrew tap token');
  });

  it('keeps local-first documentation aligned with real data, cache, import/export, and wait-state contracts', () => {
    const localFirstPath = join(process.cwd(), 'docs', 'local-first.md');
    expect(existsSync(localFirstPath)).toBe(true);
    const localFirst = readFileSync(localFirstPath, 'utf8');

    expect(localFirst).toContain('## 本机事实源');
    expect(localFirst).toContain('真实本地目录、SQLite、Git diff、Runtime 会话、Telegram update、Keychain、DMG/ZIP 产物');
    expect(localFirst).toContain('## 可重建缓存');
    expect(localFirst).toContain('代码索引、图谱视图、布局缓存');
    expect(localFirst).toContain('## 导入导出边界');
    expect(localFirst).toContain('导出设置和业务数据必须脱敏');
    expect(localFirst).toContain('## 外部等待项');
    expect(localFirst).toContain('AI CLI、Telegram、Apple signing、notarization、Homebrew tap 是外部等待项；Postgres/MySQL driver 是可选连接器等待项');
    expect(localFirst).toContain('## 禁止项');
    expect(localFirst).toContain('不上传源码、终端日志、Git diff、SQLite 数据或 Telegram 消息');
    expect(localFirst).toContain('不使用 mock 数据、假项目、假任务、假终端输出、假 AI 回复或无来源图谱节点');
  });

  it('keeps architecture documentation aligned with the current local-first implementation chain', () => {
    const architecturePath = join(process.cwd(), 'docs', 'architecture.md');
    expect(existsSync(architecturePath)).toBe(true);
    const architecture = readFileSync(architecturePath, 'utf8');

    expect(architecture).toContain('## 当前真实进程模型');
    expect(architecture).toContain('Electron Main、Preload、Renderer、Local Server、SQLite/sql.js、CLI 脚本');
    expect(architecture).toContain('## 数据流与事实源');
    expect(architecture).toContain('真实本地目录、SQLite、Git diff、Runtime 会话、Telegram update、Keychain、DMG/ZIP 产物');
    expect(architecture).toContain('## API 与事件边界');
    expect(architecture).toContain('/health、项目/任务、Runtime、Git、Code Map、AI + Graph、Telegram、WebSocket');
    expect(architecture).toContain('## 模块边界');
    expect(architecture).toContain('@zeus/code-indexer、@zeus/graph-engine、@zeus/local-server、@zeus/ai-runtime、@zeus/storage');
    expect(architecture).toContain('## 安全与发布边界');
    expect(architecture).toContain('127.0.0.1、Bearer token、Keychain、高风险二次确认、unsigned DMG/ZIP、Homebrew cask');
    expect(architecture).toContain('## 外部等待项');
    expect(architecture).toContain('React Flow / Sigma 与 node-pty / xterm.js 已接入本地核心');
    expect(architecture).toContain('AI CLI 登录、Telegram Token、Apple signing / notarization 仍依赖用户提供真实外部凭据');
    expect(architecture).toContain('pg / mysql2 仅作为可选数据库连接器，不属于 Zeus 本地核心依赖');
  });

  it('keeps design context aligned with design-book UI states, security, and degradation rules', () => {
    const designPath = join(process.cwd(), 'DESIGN.md');
    expect(existsSync(designPath)).toBe(true);
    const design = readFileSync(designPath, 'utf8');

    expect(design).toContain('## 信息架构');
    expect(design).toContain('Dashboard、Projects、Tasks、Code Map、Sessions、Git Changes、Telegram、Settings');
    expect(design).toContain('## 页面状态');
    expect(design).toContain('loading、empty、error、permission denied、external wait');
    expect(design).toContain('## 安全与敏感信息');
    expect(design).toContain('不得展示明文 token、API Key、数据库密码、Bot Token 或完整密钥输出');
    expect(design).toContain('## 最小可接受降级');
    expect(design).toContain('没有真实来源时展示空态、未配置态或等待项');
    expect(design).toContain('不使用假图表、假任务、假终端输出、假 AI 回复或无来源图谱节点');
    expect(design).toContain('## 质量底线');
    expect(design).toContain('hover、focus、disabled、loading、empty、error');
  });

  it('keeps product context aligned with verified local-first boundaries and non-goals', () => {
    const productPath = join(process.cwd(), 'PRODUCT.md');
    expect(existsSync(productPath)).toBe(true);
    const product = readFileSync(productPath, 'utf8');

    expect(product).toContain('## 当前已验证边界');
    expect(product).toContain('真实代码扫描、代码图谱、图谱问答、Sigma/WebGL 大图、React Flow 局部图、任务管理、AI Runtime（node-pty + xterm.js）、Git Diff、Telegram long polling、安全与发布打包');
    expect(product).toContain('## 非目标');
    expect(product).toContain('不是云端 SaaS，不默认上传源码、终端日志、Git diff、SQLite 数据或 Telegram 消息');
    expect(product).toContain('不使用 mock 数据、假项目、假任务、假终端输出、假 AI 回复或无来源图谱节点');
    expect(product).toContain('## 外部配置等待项');
    expect(product).toContain('AI CLI 登录状态');
    expect(product).toContain('Telegram Bot Token / whitelist');
    expect(product).toContain('Apple signing / notarization');
    expect(product).not.toContain('AI Runtime（node-pty + xterm.js）：等待用户确认新增依赖');
    expect(product).not.toContain('React Flow / Sigma：等待用户确认新增依赖');
    expect(product).toContain('Postgres / MySQL driver：可选连接器，不属于 Zeus 本地核心依赖');
  });

  it('documents installation, usage, external configuration waits, and final report evidence in README', () => {
    const readme = readFileSync(join(process.cwd(), 'README.md'), 'utf8');

    expect(readme).toContain('## 安装');
    expect(readme).toContain('brew install --cask ./Casks/zeus.rb');
    expect(readme).toContain('dist/Zeus-0.1.0-arm64.dmg');
    expect(readme).toContain('dist/Zeus-0.1.0-arm64.zip');
    expect(readme).toContain('## 使用流程');
    expect(readme).toContain('选择真实本地代码库');
    expect(readme).toContain('扫描真实代码并生成系统架构图、表关系图、模块详情图、接口时序图、模块流程图、方法逻辑图');
    expect(readme).toContain('## 外部配置等待项');
    expect(readme).toContain('Apple signing certificate');
    expect(readme).toContain('Telegram Bot Token');
    expect(readme).toContain('AI CLI 登录状态');
    expect(readme).toContain('## 更新日志');
    expect(readme).toContain('CHANGELOG.md');
    expect(readme).toContain('## 最终执行报告');
    expect(readme).toContain('pnpm verify:release');
    expect(readme).toContain('unsigned DMG/ZIP');
  });

  it('keeps the roadmap aligned with current verified state and explicit external waits', () => {
    const roadmapPath = join(process.cwd(), 'ROADMAP.md');
    expect(existsSync(roadmapPath)).toBe(true);
    const roadmap = readFileSync(roadmapPath, 'utf8');

    expect(roadmap).toContain('## 当前已验证能力');
    expect(roadmap).toContain('pnpm verify:release');
    expect(roadmap).toContain('63 test files / 548 tests passed');
    expect(roadmap).toContain('163 files / 16327 nodes / 32021 edges / 7 views');
    expect(roadmap).toContain('## 外部配置等待项');
    expect(roadmap).not.toContain('node-pty / xterm.js：等待用户确认新增依赖');
    expect(roadmap).not.toContain('React Flow / Sigma：等待用户确认新增依赖');
    expect(roadmap).toContain('大图 Sigma/WebGL 与局部 React Flow 已接入');
    expect(roadmap).toContain('Postgres / MySQL driver：可选连接器，不属于 Zeus 本地核心依赖');
    expect(roadmap).toContain('Apple signing / notarization');
    expect(roadmap).toContain('## 不做的降级');
    expect(roadmap).toContain('不使用 mock 数据、假项目、假任务、假终端输出、假 AI 回复或无来源图谱节点');
  });

  it('keeps a release changelog with verified artifacts and explicit external waits', () => {
    const changelogPath = join(process.cwd(), 'CHANGELOG.md');
    expect(existsSync(changelogPath)).toBe(true);
    const changelog = readFileSync(changelogPath, 'utf8');

    expect(changelog).toContain('# Changelog');
    expect(changelog).toContain('## 0.1.0 - 2026-06-15');
    expect(changelog).toContain('pnpm verify:release');
    expect(changelog).toContain('63 test files / 548 tests passed');
    expect(changelog).toContain('163 files / 16327 nodes / 32021 edges / 7 views');
    expect(changelog).toContain('unsigned DMG/ZIP');
    expect(changelog).toContain('Homebrew cask sha256');
    expect(changelog).toContain('AI CLI adapter 探针');
    expect(changelog).toContain('Apple signing certificate：等待用户配置');
    expect(changelog).toContain('notarization：等待用户配置');
    expect(changelog).not.toContain('notarization：已完成');
  });

  it('keeps complete contribution guidelines and templates for real-data Zeus changes', () => {
    const contributing = readFileSync(join(process.cwd(), 'CONTRIBUTING.md'), 'utf8');
    const bugReport = readFileSync(join(process.cwd(), '.github', 'ISSUE_TEMPLATE', 'bug_report.md'), 'utf8');
    const featureRequestPath = join(process.cwd(), '.github', 'ISSUE_TEMPLATE', 'feature_request.md');
    const pullRequestPath = join(process.cwd(), '.github', 'pull_request_template.md');
    expect(existsSync(featureRequestPath)).toBe(true);
    expect(existsSync(pullRequestPath)).toBe(true);
    const featureRequest = readFileSync(featureRequestPath, 'utf8');
    const pullRequest = readFileSync(pullRequestPath, 'utf8');

    expect(contributing).toContain('## 真实数据原则');
    expect(contributing).toContain('不得提交 mock 数据、假项目、假任务、假终端输出、假 AI 回复或无来源图谱节点');
    expect(contributing).toContain('pnpm verify:release');
    expect(contributing).toContain('外部配置等待项');
    expect(contributing).toContain('Apple signing / notarization');
    expect(contributing).toContain('CHANGELOG.md');
    expect(contributing).toContain('.github/pull_request_template.md');
    expect(contributing).toContain('回滚方式');
    expect(bugReport).toContain('name: Bug report');
    expect(bugReport).toContain('## 复现步骤');
    expect(bugReport).toContain('## 真实数据来源');
    expect(bugReport).toContain('不得粘贴明文 token、API Key、数据库密码或完整终端密钥输出');
    expect(bugReport).toContain('## 回归验证');
    expect(bugReport).toContain('pnpm verify:release');
    expect(featureRequest).toContain('name: Feature request');
    expect(featureRequest).toContain('## 业务目标');
    expect(featureRequest).toContain('## 真实数据来源');
    expect(featureRequest).toContain('不得使用 mock 数据');
    expect(featureRequest).toContain('## 验收标准');
    expect(pullRequest).toContain('## 真实数据来源');
    expect(pullRequest).toContain('不得使用 mock 数据、假项目、假任务、假终端输出、假 AI 回复或无来源图谱节点');
    expect(pullRequest).toContain('pnpm verify:release');
    expect(pullRequest).toContain('Apple signing / notarization');
    expect(pullRequest).toContain('外部配置等待项');
    expect(pullRequest).toContain('安全与权限');
    expect(pullRequest).toContain('回滚方式');
  });

  it('keeps a concrete final implementation report with real verification evidence', () => {
    const reportPath = join(process.cwd(), 'docs', 'Zeus实现报告.md');
    expect(existsSync(reportPath)).toBe(true);
    const report = readFileSync(reportPath, 'utf8');

    expect(report).toContain('# Zeus 实现报告');
    expect(report).toContain('## 完成摘要');
    expect(report).toContain('## 运行命令');
    expect(report).toContain('pnpm verify:release');
    expect(report).toContain('63 test files / 548 tests passed');
    expect(report).toContain('扫描路径：/Users/david/hypha/zeus');
    expect(report).toContain('文件数：163');
    expect(report).toContain('symbol 数：16327');
    expect(report).toContain('node 数：16327');
    expect(report).toContain('edge 数：32021');
    expect(report).toContain('view 数：7');
    expect(report).toContain('dist/Zeus-0.1.0-arm64.dmg');
    expect(report).toContain('dist/Zeus-0.1.0-arm64.zip');
    expect(report).toContain('ZEUS_DATABASE_CONNECTION_SECRET_IN_URI');
    expect(report).toContain('Apple signing certificate：等待用户配置');
    expect(report).toContain('unsigned DMG/ZIP');
    expect(report).toContain('Homebrew cask sha256：`0610d3b917feb0db9e285efd51d4b3dfc602669776152f0252b4993ff9465c4d`');
  });

  it('verifies the packaged macOS app executable can be loaded before accepting release artifacts', () => {
    const verifyRelease = readFileSync(join(process.cwd(), 'scripts', 'verify-release.sh'), 'utf8');

    expect(verifyRelease).toContain('app_executable="$app/Contents/MacOS/Zeus"');
    expect(verifyRelease).toContain('ELECTRON_RUN_AS_NODE=1 "$app_executable" -e');
    expect(verifyRelease).toContain('process.versions.electron');
    expect(verifyRelease).toContain('Zeus verify-release: packaged app executable failed to load');
  });

  it('reserves macOS signing and notarization inputs in the release workflow without claiming they exist', () => {
    const workflow = readFileSync(join(process.cwd(), '.github', 'workflows', 'release.yml'), 'utf8');

    expect(workflow).toContain('CSC_LINK: ${{ secrets.MACOS_CERTIFICATE }}');
    expect(workflow).toContain('CSC_KEY_PASSWORD: ${{ secrets.MACOS_CERTIFICATE_PASSWORD }}');
    expect(workflow).toContain('APPLE_ID: ${{ secrets.APPLE_ID }}');
    expect(workflow).toContain('APPLE_APP_SPECIFIC_PASSWORD: ${{ secrets.APPLE_APP_SPECIFIC_PASSWORD }}');
    expect(workflow).toContain('APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}');
    expect(workflow).toContain('HOMEBREW_TAP_TOKEN: ${{ secrets.HOMEBREW_TAP_TOKEN }}');
    expect(workflow).toContain('permissions:');
    expect(workflow).toContain('contents: write');
    expect(workflow).toContain('tag:');
    expect(workflow).toContain('description: Existing tag to publish as a GitHub Release');
    expect(workflow).toContain('pnpm verify:release');
    expect(workflow).toContain('gh release create "${{ inputs.tag }}"');
    expect(workflow).toContain('dist/Zeus-*.dmg');
    expect(workflow).toContain('dist/Zeus-*.zip');
    expect(workflow).toContain('dist/homebrew/zeus.rb');
    expect(workflow).toContain("if: ${{ inputs.tag != '' }}");
  });
});
