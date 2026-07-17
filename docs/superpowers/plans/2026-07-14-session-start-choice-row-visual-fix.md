# Zeus Session Start Choice Row Visual Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 本任务在当前工作区内执行，不派发 subagent，不执行 git commit。

**Goal:** 将会话开始模式中被全局 input 样式拉伸的 radio 修正为紧凑、可访问的 macOS source-list 选择行，同时保持创建、续接和引用的现有业务语义不变。

**Architecture:** 保留 `StartConversationSurface` 的原生 `fieldset/label/input[type=radio]` 结构，只为模式 radio 增加局部类名，并在 `.session-codex-parity-v1 .session-start-mode` 作用域内覆盖全局 input 规则。测试同时锁定 DOM 语义与 CSS 尺寸，防止全局 `inline-size: 100%` 再次污染 radio。

**Tech Stack:** React 19、TypeScript、CSS、Vitest、React DOM server rendering、Electron macOS package。

**Visual Evidence:** `docs/TASK_20260710_001_会话模式单选项样式污染故障排查.html` 记录现象、证据 E1-E6、根因 R1、修法 F1、验证 V1 与回滚 B1；当前已同步自动验证与打包结果，GUI 验收等待解锁 Mac。

## Global Constraints

- 只修改会话开始模式选择行，不修改 API、provider、迁移、数据库或创建流程。
- 有历史时继续要求显式选择 mode；无历史时继续按现有逻辑默认 create。
- 首条消息继续必填，点击“＋”不得创建空 provider thread。
- 保留原生 radio Name、Role、Value、互斥行为和完整 label 点击目标。
- 行高最小 42px；radio 视觉尺寸 14px；点击目标不低于 WCAG 2.2 的 24px。
- 深浅色只使用现有 `--session-*` token；不新增依赖、品牌色、卡片或装饰动效。
- 保留工作区全部既有未提交修改，不执行 git commit、push、merge、revert。

---

### Task 1: 用失败测试锁定局部 radio 语义与尺寸

**Files:**
- Modify: `apps/desktop/test/session-workspace.test.tsx`
- Reference: `apps/desktop/src/renderer/session/SessionWorkspace.tsx:881-918`
- Reference: `apps/desktop/src/renderer/session/session.css:1234-1263`

**Interfaces:**
- Consumes: `SessionWorkspace` 静态渲染、`NativeConversationChoice` fixture、`session.css` 文本。
- Produces: DOM 契约 `class="session-start-radio"`；CSS 契约为局部 radio 固定 14px、圆形、无 padding，选择行使用两列 grid。

- [x] **Step 1: 增加 DOM 失败测试**

在 `requires an explicit mode when history exists instead of silently defaulting to new` 附近新增测试，渲染 create、native resume、legacy reference 三种模式：

```tsx
it('renders session start modes as locally scoped native radio choices', () => {
  const html = renderToStaticMarkup(
    <SessionWorkspace
      language="en-US"
      state={null}
      conversation={null}
      task={{ id: 'task-1', projectId: 'project-1', title: 'App-server parity' }}
      choices={[conversation(), conversation({ id: 'legacy-1', transportKind: 'legacy_cli', resumable: false, readOnly: true })]}
    />,
  );

  expect(html.match(/type="radio"/g)).toHaveLength(3);
  expect(html.match(/class="session-start-radio"/g)).toHaveLength(3);
  expect(html).toContain('New conversation');
  expect(html).toContain('Resume this conversation');
  expect(html).toContain('Reference legacy conversation');
});
```

- [x] **Step 2: 增加 CSS 失败测试**

在同一测试文件现有 parity CSS 测试附近新增：

```ts
it('keeps session start radios compact instead of inheriting full-width text-input chrome', () => {
  const css = readFileSync(new URL('../src/renderer/session/session.css', import.meta.url), 'utf8');
  const radioRule = css.match(/\.session-codex-parity-v1 \.session-start-radio\s*\{([^}]*)\}/)?.[1] ?? '';
  const rowRule = css.match(/\.session-codex-parity-v1 \.session-start-mode > label\s*\{([^}]*)\}/)?.[1] ?? '';

  expect(rowRule).toContain('grid-template-columns: 18px minmax(0, 1fr)');
  expect(radioRule).toContain('appearance: none');
  expect(radioRule).toContain('inline-size: 14px');
  expect(radioRule).toContain('block-size: 14px');
  expect(radioRule).toContain('border-radius: 50%');
  expect(radioRule).toContain('padding: 0');
  expect(radioRule).not.toContain('inline-size: 100%');
});
```

- [x] **Step 3: 运行聚焦测试并确认 RED**

Run:

```bash
pnpm vitest run apps/desktop/test/session-workspace.test.tsx -t "session start modes|session start radios" --reporter=verbose
```

Expected: 两个新增测试失败；现有 JSX 没有 `session-start-radio`，现有 CSS 没有 radio 局部尺寸规则且 label 仍为 flex。

### Task 2: 实施紧凑选择行

**Files:**
- Modify: `apps/desktop/src/renderer/session/SessionWorkspace.tsx:883-910`
- Modify: `apps/desktop/src/renderer/session/session.css:1242-1263`
- Test: `apps/desktop/test/session-workspace.test.tsx`

**Interfaces:**
- Consumes: 现有 `mode`、`selectedChoiceId`、`controlsBlocked` 和 `--session-*` token。
- Produces: `session-start-radio` 局部样式钩子；create/resume/reference 的 state 与 payload 不变。

- [x] **Step 1: 为两个 JSX radio 分支增加局部类名**

在 create radio 和 choices map radio 上增加相同类名，不触碰 legacy checkbox：

```tsx
<input
  className="session-start-radio"
  type="radio"
  name="session-start-mode"
  checked={mode === 'create'}
  onChange={() => {
    setMode('create');
    setSelectedChoiceId(null);
    setLegacyMessageIds([]);
  }}
/>
```

choices map 中保持现有 `checked` 与 `onChange`，只增加 `className="session-start-radio"`。

- [x] **Step 2: 将选择行改为两列 grid**

把 `.session-start-mode > label` 改为：

```css
.session-codex-parity-v1 .session-start-mode > label {
  align-items: center;
  border-radius: 9px;
  cursor: pointer;
  display: grid;
  gap: 8px;
  grid-template-columns: 18px minmax(0, 1fr);
  min-block-size: 42px;
  padding: 6px 9px;
}
```

- [x] **Step 3: 增加局部 radio 默认与 checked 样式**

紧跟选择行规则增加：

```css
.session-codex-parity-v1 .session-start-radio {
  appearance: none;
  background: transparent;
  block-size: 14px;
  border: 1px solid var(--session-text-muted);
  border-radius: 50%;
  box-shadow: none;
  inline-size: 14px;
  margin: 0;
  min-block-size: 14px;
  min-inline-size: 14px;
  padding: 0;
}

.session-codex-parity-v1 .session-start-radio:checked {
  background: radial-gradient(circle, var(--session-accent) 0 3px, transparent 3.5px);
  border-color: var(--session-accent);
}
```

这里的 `radial-gradient` 只用于绘制原生 radio 的中心实心圆点，不作为装饰性页面渐变；未选中态仍为透明背景。

- [x] **Step 4: 增加整行焦点与 disabled 状态**

使用 label 状态，不增加新动画：

```css
.session-codex-parity-v1 .session-start-mode > label:has(.session-start-radio:focus-visible) {
  outline: 2px solid var(--session-focus-outline);
  outline-offset: 2px;
}

.session-codex-parity-v1 .session-start-radio:focus-visible {
  outline: none;
}

.session-codex-parity-v1 .session-start-mode:disabled > label {
  cursor: not-allowed;
}
```

保留现有 hover/checked 背景规则和全局 disabled opacity；不得修改 submit enable 条件。

- [x] **Step 5: 运行聚焦测试并确认 GREEN**

Run:

```bash
pnpm vitest run apps/desktop/test/session-workspace.test.tsx -t "session start modes|session start radios|explicit mode" --reporter=verbose
```

Expected: 新增 DOM/CSS 测试和显式历史选择测试全部通过。

- [x] **Step 6: 运行完整会话组件测试**

Run:

```bash
pnpm vitest run apps/desktop/test/session-workspace.test.tsx apps/desktop/test/app-shell-layout.test.tsx --reporter=dot
```

Expected: 两个测试文件全部通过；无会话页布局或历史选择回归。

### Task 3: Review、静态门禁、真实打包验收与文档收口

**Files:**
- Review: `apps/desktop/src/renderer/session/SessionWorkspace.tsx`
- Review: `apps/desktop/src/renderer/session/session.css`
- Review: `apps/desktop/test/session-workspace.test.tsx`
- Modify: `docs/TASK_20260710_001_Zeus任务创建推送与AppServer连续对话全场景盘点.md`
- Modify: `docs/TASK_20260710_001_会话模式单选项样式污染故障排查.html`

**Interfaces:**
- Consumes: Task 2 的 JSX/CSS/test 变更。
- Produces: review 结论、静态验证、真实 packaged GUI 证据和回滚记录。

- [x] **Step 1: 执行需求反向审查**

逐项检查：

```bash
rg -n "session-start-radio|session-start-mode" \
  apps/desktop/src/renderer/session/SessionWorkspace.tsx \
  apps/desktop/src/renderer/session/session.css \
  apps/desktop/test/session-workspace.test.tsx
```

Expected: radio 类只出现在模式选择器；legacy checkbox 无该类；没有新增 `inline-size: 100%`、卡片边框、图标或行为分支。

- [x] **Step 2: 使用 `superpowers:requesting-code-review` 完成结构化 review**

Review 必须读取用户提供的 AGENTS 约束、本设计书、本计划和实际 diff，重点检查：全局 input 规则是否仍能覆盖 radio、checked/focus/disabled 是否可辨认、legacy checkbox 是否被误伤、显式选择与首条消息门禁是否未变。由于本轮禁止派发 subagent，在当前会话内完成结构化自审。

- [x] **Step 3: 运行静态门禁**

Run:

```bash
pnpm typecheck
pnpm lint
pnpm format:check
git diff --check
```

Expected: 四条命令退出码均为 0。若完整仓库存在与本次无关的失败，必须给出精确文件、断言和本次 diff 未触及证据，不得报告全绿。

- [x] **Step 4: 更新主任务文档**

在第 10.10 节与故障排查图中记录：根因、RED/GREEN 命令和数量、修改范围、review 结论、静态检查、打包时间、真实 GUI 状态、剩余失败和回滚边界。不得把未执行验证写成通过。

- [ ] **Step 5: 使用 `superpowers:verification-before-completion` 执行完成性核验**

回到原始截图逐项验收：没有横向空白输入框；三个模式是圆点加文本的紧凑行；点击行、checked、focus、disabled 可辨认；现有历史选择和首条消息规则未变。

- [x] **Step 6: 安全退出 Zeus 并打包**

先确认运行中的 `dist/mac-arm64/Zeus.app` 已正常退出，再执行：

```bash
pnpm package:mac
```

Expected: exit 0，生成新的 `dist/mac-arm64/Zeus.app`、DMG 和 ZIP；ad-hoc codesign 校验成功。

- [ ] **Step 7: 验证 packaged health 和真实 GUI**

Run:

```bash
codesign --verify --deep --strict dist/mac-arm64/Zeus.app
node scripts/verify-packaged-app-health.mjs dist/mac-arm64/Zeus.app
```

随后启动新包，在 `tc-app-core > 会话` 点击包含历史的任务“＋”，验收默认、hover、键盘 focus、selected、disabled 和窄窗口状态。不得发送诊断消息或创建额外 provider thread。

Expected: packaged health 通过，真实窗口不存在横向空白 radio 输入框；选择行紧凑且业务状态不变。

## Rollback

- 撤销 `SessionWorkspace.tsx` 的 `session-start-radio` 类名。
- 撤销 `session.css` 的局部 grid/radio/focus/disabled 规则。
- 撤销对应测试与第 10.10 后的实施证据。
- 不触碰历史迁移数据、native provider thread、legacy 归档或会话选择 API。
