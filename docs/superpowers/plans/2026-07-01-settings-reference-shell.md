# Settings Reference Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Zeus 全局 Settings 页面改为参考图方向：设置专属侧栏、搜索、分组导航、居中内容列和连续设置行。

**Architecture:** 继续在 `apps/desktop/src/renderer/App.tsx` 内复用现有 Settings 状态、保存函数、`NativeSettingsPane`、`NativeControlRow` 与 `ZeusSelect`，只重排 Settings 外层壳层和通用页内容。CSS 在 `apps/desktop/src/renderer/styles.css` 增加 Settings reference shell 覆盖，不引入新依赖，不改后端存储契约。

**Tech Stack:** React SSR 渲染测试、Vitest、TypeScript、CSS。

---

## File Structure

- Modify: `apps/desktop/test/app-shell-layout.test.tsx`
  - 增加 Settings reference shell 结构测试。
  - 更新旧横向 tab/max-width 980 断言为设置专属侧栏与居中内容列。
- Modify: `apps/desktop/src/renderer/App.tsx`
  - 扩展 Settings copy 字段。
  - 添加 Settings 分组导航元数据。
  - 将横向 `settings-section-nav` 移入左侧 settings shell。
  - 通用页增加工作模式与权限行组。
- Modify: `apps/desktop/src/renderer/styles.css`
  - 增加 Settings reference shell CSS。
  - 保留 `settings-product-pane`、`settings-section-nav`、`native-settings-pane` 等既有语义，避免测试与旧契约断裂。
- Modify: `docs/TASK_20260701_010_ZeusSettingsA详细设计稿.md`
  - 记录本轮源码落地、验证命令与未覆盖项。
- Modify: `docs/TASK_20260701_010_ZeusSettingsA详细设计稿.html`
  - 更新交付验收区，说明已进入源码实现并列出验证结果。

---

### Task 1: RED, lock Settings reference shell markup

**Files:**
- Modify: `apps/desktop/test/app-shell-layout.test.tsx`

- [ ] **Step 1: Write the failing test**

Add this test near existing Settings layout tests:

```tsx
it('renders global settings as a reference-style settings shell with grouped sidebar and centered content', () => {
  const html = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="settings" />);
  const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

  expect(html).toContain('settings-reference-shell');
  expect(html).toContain('settings-sidebar-shell');
  expect(html).toContain('settings-search-control');
  expect(html).toContain('settings-content-column');
  expect(html).toContain('settings-mode-card');
  expect(html).toContain('settings-permission-pane');
  expect(html).toContain('role="tablist"');
  expect(html).toContain('aria-orientation="vertical"');
  expect(html).toContain('data-inline-rail-keyboard="vertical"');
  expect(html).toContain('返回应用');
  expect(html).toContain('工作模式');
  expect(html).toContain('权限');
  expect(css).toContain('Settings reference shell 最终覆盖');
  expect(css).toMatch(/\.macos-ai-app \.settings-reference-shell\s*\{[\s\S]*grid-template-columns:\s*minmax\(210px,\s*236px\) minmax\(0,\s*1fr\)/);
  expect(css).toMatch(/\.macos-ai-app \.settings-content-column\s*\{[\s\S]*max-inline-size:\s*680px/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm vitest run apps/desktop/test/app-shell-layout.test.tsx -t "reference-style settings shell"
```

Expected: FAIL because `settings-reference-shell` and related classes do not exist yet.

### Task 2: GREEN, implement Settings shell and CSS

**Files:**
- Modify: `apps/desktop/src/renderer/App.tsx`
- Modify: `apps/desktop/src/renderer/styles.css`

- [ ] **Step 1: Add Settings copy fields**

Add Chinese and English fields under `settingsWorkspace`:

```ts
returnToApp: '返回应用',
searchAria: '搜索设置',
searchPlaceholder: '搜索设置...',
sectionGroups: {
  personal: '个人',
  integrations: '集成',
  coding: '编码',
  maintenance: '维护',
},
workModeTitle: '工作模式',
workModeDescription: '选择 Zeus 默认展示多少技术细节',
engineeringModeTitle: '适用于工程',
engineeringModeDescription: '更多执行细节、证据和控制',
dailyModeTitle: '适用于日常工作',
dailyModeDescription: '同样强大，技术细节更少',
permissionsTitle: '权限',
defaultPermissionTitle: '默认权限',
defaultPermissionDescription: '默认只访问当前工作区；额外路径需要再次确认。',
autoReviewTitle: '自动审核',
autoReviewDescription: '低风险请求可自动审核；高风险动作仍需要确认。',
fullAccessTitle: '完全访问权限',
fullAccessDescription: '默认关闭；开启前必须说明风险并保留审计。',
readOnlyStatus: '受保护',
waitingStatus: '等待',
```

English equivalents must be added in the `en-US` copy object and the `settingsWorkspace` type.

- [ ] **Step 2: Replace Settings wrapper**

Change the `activeNavTarget === 'settings'` block to:

```tsx
<section className="workspace-view workspace-view-settings settings-reference-shell" aria-label={settingsWorkspaceCopy.viewAria}>
  <aside className="settings-sidebar-shell" aria-label={settingsWorkspaceCopy.categoryListAria}>
    <button type="button" className="settings-return-button" onClick={() => handleMainNavigate('projects')}>
      {settingsWorkspaceCopy.returnToApp}
    </button>
    <input className="settings-search-control" aria-label={settingsWorkspaceCopy.searchAria} placeholder={settingsWorkspaceCopy.searchPlaceholder} />
    <nav className="settings-section-nav settings-sidebar-nav" role="tablist" aria-orientation="vertical" data-inline-rail-keyboard="vertical" onKeyDown={handleInlineRailKeyboardNavigation}>
      ...group headings and tab buttons...
    </nav>
  </aside>
  <section className="settings-detail-pane" aria-label={settingsWorkspaceCopy.detailPaneAria}>
    <div className="settings-content-column">...existing category panes...</div>
  </section>
</section>
```

- [ ] **Step 3: Add general page rows**

Inside the general category before app language, add:

```tsx
<section className="settings-mode-row" aria-label={settingsWorkspaceCopy.workModeTitle}>
  <button type="button" className={`settings-mode-card ${appShellSettings.developerModeEnabled ? 'selected' : ''}`} aria-pressed={appShellSettings.developerModeEnabled} onClick={() => setAppShellSettings((current) => ({ ...current, developerModeEnabled: true }))}>...</button>
  <button type="button" className={`settings-mode-card ${!appShellSettings.developerModeEnabled ? 'selected' : ''}`} aria-pressed={!appShellSettings.developerModeEnabled} onClick={() => setAppShellSettings((current) => ({ ...current, developerModeEnabled: false }))}>...</button>
</section>
<NativeSettingsPane label={settingsWorkspaceCopy.permissionsTitle} className="settings-permission-pane">...permission rows...</NativeSettingsPane>
```

- [ ] **Step 4: Add CSS**

Add a `Settings reference shell 最终覆盖` CSS block that defines:

```css
.macos-ai-app .settings-reference-shell {
  grid-template-columns: minmax(210px, 236px) minmax(0, 1fr);
}
.macos-ai-app .settings-content-column {
  inline-size: min(680px, calc(100% - 48px));
  max-inline-size: 680px;
  margin-inline: auto;
}
```

Include sidebar search, group headings, vertical nav, mode cards, permission pane, and 860px/640px responsive rules.

- [ ] **Step 5: Run the focused test**

Run:

```bash
pnpm vitest run apps/desktop/test/app-shell-layout.test.tsx -t "reference-style settings shell"
```

Expected: PASS.

### Task 3: Update existing Settings tests and docs

**Files:**
- Modify: `apps/desktop/test/app-shell-layout.test.tsx`
- Modify: `docs/TASK_20260701_010_ZeusSettingsA详细设计稿.md`
- Modify: `docs/TASK_20260701_010_ZeusSettingsA详细设计稿.html`

- [ ] **Step 1: Update stale tests**

Change existing Settings layout tests so they expect `settings-reference-shell`, `settings-sidebar-shell`, `settings-content-column`, and vertical `settings-section-button selected`. Remove the old `max-inline-size: 980px` horizontal-pane expectation.

- [ ] **Step 2: Run Settings-related tests**

Run:

```bash
pnpm vitest run apps/desktop/test/app-shell-layout.test.tsx -t "settings|Settings|global general settings"
```

Expected: PASS for Settings scoped tests.

- [ ] **Step 3: Update docs**

Append implementation notes, changed files, test commands, and any remaining gaps to `docs/TASK_20260701_010_ZeusSettingsA详细设计稿.md`. Update the HTML delivery card to mention source implementation evidence.

### Task 4: Final verification

**Files:**
- Verify changed source, tests, docs.

- [ ] **Step 1: Run focused layout test**

```bash
pnpm vitest run apps/desktop/test/app-shell-layout.test.tsx -t "settings|Settings|global general settings"
```

Expected: PASS.

- [ ] **Step 2: Run typecheck or targeted full test if practical**

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 3: Run diff hygiene**

```bash
git diff --check -- apps/desktop/src/renderer/App.tsx apps/desktop/src/renderer/styles.css apps/desktop/test/app-shell-layout.test.tsx docs/TASK_20260701_010_ZeusSettingsA详细设计稿.md docs/TASK_20260701_010_ZeusSettingsA详细设计稿.html
```

Expected: no output, exit 0.

- [ ] **Step 4: If code changed, package gate**

Per Zeus memory gate, before final delivery exit any running Zeus app if present and run:

```bash
pnpm package:mac
```

Expected: PASS. If this is too slow or blocked by local state, report exact output and do not claim full package verification.
