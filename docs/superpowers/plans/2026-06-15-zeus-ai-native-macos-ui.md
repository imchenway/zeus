# Zeus AI Native macOS UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the Zeus Renderer as a macOS-native Codex-style AI workbench with a spatial Code Map studio and no card-grid dashboard language.

**Architecture:** Keep the existing Electron/React/API contracts. Change only Renderer structure, CSS, and UI tests: App stays data-backed by real snapshots, buttons keep existing handlers, and visual state moves from card panels to thread rows, inspectors, command surfaces, and graph stage regions.

**Tech Stack:** Electron 36, React 19, TypeScript, Vitest SSR renderer tests, existing CSS with OKLCH tokens, Computer Use for real macOS GUI verification.

---

### Task 1: Lock UI/UX contract with RED tests

**Files:**
- Modify: `/Users/david/hypha/zeus/apps/desktop/test/renderer.test.tsx`
- Modify: `/Users/david/hypha/zeus/apps/desktop/test/app-code-map-rendering.test.tsx`

- [ ] **Step 1: Add failing Renderer shell tests**

Add tests asserting the root shell contains `macos-ai-app`, `codex-thread-workbench`, no `status-panel`, no `data-panel`, no `dashboard-recent-grid`, and includes `Command Thread`, `Evidence Timeline`, `Context Inspector`, `Motion respects reduced motion`.

- [ ] **Step 2: Add failing Code Map Spatial Graph Studio test**

Add a test asserting Code Map renders `Spatial Graph Studio`, `Graph Stage`, `Node Focus`, `Source Trail`, and no card-grid framing.

- [ ] **Step 3: Run RED tests**

Run: `pnpm vitest run apps/desktop/test/renderer.test.tsx apps/desktop/test/app-code-map-rendering.test.tsx --reporter=verbose`
Expected: FAIL because the new shell and graph studio markers do not exist yet.

### Task 2: Restructure App shell and semantic regions

**Files:**
- Modify: `/Users/david/hypha/zeus/apps/desktop/src/renderer/App.tsx`

- [ ] **Step 1: Change root shell semantics**

Add root classes `macos-ai-app codex-thread-workbench spatial-graph-studio` and keep existing theme class. Preserve all API callbacks and local state.

- [ ] **Step 2: Rename workbench sections**

Rename dashboard Command Composer area to `Command Thread`, Activity Stream to `Evidence Timeline`, and Context Rail to `Context Inspector` while keeping existing button callbacks.

- [ ] **Step 3: Replace generic DataPanel card framing**

Change `DataPanel` class from `empty-state data-panel` to `thread-surface`, and split title/body/list/action into thread header, evidence body, and action row. Keep IDs and hidden behavior unchanged.

- [ ] **Step 4: Add Code Map studio wrapper**

Wrap Code Map content in semantic `spatial-graph-stage`, `graph-stage`, `node-focus`, and `source-trail` regions without changing graph data or actions.

### Task 3: Replace web-card styling with macOS app styling and motion

**Files:**
- Modify: `/Users/david/hypha/zeus/apps/desktop/src/renderer/styles.css`

- [ ] **Step 1: Add macOS app tokens and layout**

Define app-level background, sidebar, toolbar, thread surface, inspector, and graph stage visual language using tinted neutrals and restrained blue-purple accents.

- [ ] **Step 2: Neutralize legacy card classes**

Make `.status-panel`, `.data-panel`, `.dashboard-recent`, `.launch-readiness`, `.first-run-guide`, `.empty-state`, `.data-row`, `.graph-node`, `.graph-edge`, `.graph-detail` visually behave as flat thread/list/inspector surfaces rather than cards.

- [ ] **Step 3: Add purposeful motion**

Add entry/focus animations for shell, thread surface, sidebar nav, graph stage, buttons, and inspector. Add a `@media (prefers-reduced-motion: reduce)` block that disables transitions and animations.

- [ ] **Step 4: Preserve dark/system theme support**

Update dark selectors for new classes and ensure existing theme tests keep passing.

### Task 4: Verification and real macOS GUI interaction

**Files:**
- Modify: `/Users/david/hypha/zeus/docs/TASK_20260615_001_Zeus_Codex_App_AI_Native_UI重构.md`

- [ ] **Step 1: Run focused renderer tests**

Run: `pnpm vitest run apps/desktop/test/renderer.test.tsx apps/desktop/test/app-code-map-rendering.test.tsx apps/desktop/test/app-data-rendering.test.tsx apps/desktop/test/app-runtime-rendering.test.tsx apps/desktop/test/app-git-confirmation-rendering.test.tsx --reporter=verbose`
Expected: PASS.

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Build and launch the macOS app**

Run: `./script/build_and_run.sh --verify` or the closest supported existing script command.
Expected: Electron app launches and process exists.

- [ ] **Step 4: Use Computer Use to click real UI**

Click Dashboard, Projects, Tasks, Code Map, Runtime, Git Diff, Telegram, Settings, repository picker, scan graph, diff load, runtime refresh, and settings save where enabled. If a control is disabled because local client or external credential is unavailable, verify the visible disabled reason.

- [ ] **Step 5: Capture screenshots and update docs**

Save screenshots or reference the inspected UI state, then update the task doc with test evidence, GUI click evidence, blockers, and final checklist.

- [ ] **Step 6: Run final release gate**

Run: `pnpm verify:release`
Expected: PASS, or record the first concrete blocker.
