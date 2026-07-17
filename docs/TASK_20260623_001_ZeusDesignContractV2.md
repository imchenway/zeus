# TASK_20260623_001 Zeus Design Contract v2

## 1. 背景与目标

用户选择方案 A：保留 Zeus 当前 macOS 本地优先产品 UI 方向，借鉴外部 `design.md` 的机器可读结构，沉淀为 Zeus 自己的设计契约。

本任务只做设计文档契约落地，不做运行时代码重构，不新增依赖，不引入外部品牌资产。

目标：

- 让 `DESIGN.md` 同时服务人类评审和 AI 实现。
- 把 Zeus 已有冷中性 OKLCH token、macOS 控件密度、source-list、object-toolbar、composer、decision-rail、mode-rail、popover、drawer 等语义写成可执行契约。
- 明确外部设计系统只能作为结构参考，不能替换 Zeus 的产品气质、品牌色、字体、布局和安全边界。

## 2. 受影响目录

| 路径 | 影响 |
|---|---|
| `DESIGN.md` | 增加 `Zeus Design Contract v2` 机器可读 YAML 区块和使用规则。 |
| `docs/TASK_20260623_001_ZeusDesignContractV2.md` | 新增任务文档，记录契约变更、测试矩阵、实施顺序、风险与回滚。 |

## 3. 不修改范围与原因

| 范围 | 是否修改 | 原因 |
|---|---:|---|
| `apps/desktop/src/renderer` | 否 | 本任务只沉淀设计契约，不改 UI 源码。 |
| 后端、本地 app-server、SQLite、IPC | 否 | 无接口、数据或存储契约变化。 |
| 构建依赖、CI、package 配置 | 否 | 设计文档变更不需要新增依赖或改构建。 |
| 发布打包 | 否 | 未改运行时代码；后续若进入 UI 实现阶段，再执行完整 Zeus 发布门禁。 |

## 4. 契约变更

### 4.1 设计契约

`DESIGN.md` 新增 `Zeus Design Contract v2`，包含：

- `strategy`：浅色优先、跟随系统、克制冷中性、macOS 产品密度、本地优先、安全确认。
- `colors`：surface、text、line、accent、semantic、focus-ring 的 OKLCH 值。
- `typography`：系统 UI 字体、等宽字体、title、heading、body、label、metadata、code 尺寸。
- `spacing` / `radius` / `motion`：保留 4px 基础节奏、紧凑控件、短时状态动效。
- `components`：source-list、object-toolbar、controls、composer、decision-rail、mode-rail、graph-canvas、popover、drawer。
- `content`：中英双语、真实值不硬翻译、错误说明影响与下一步、空态指向第一步。
- `quality_gates`：loading、empty、error、permission denied、external wait、focus-visible、键盘导航、reduced motion，以及禁止项。

### 4.2 边界契约

- 外部设计系统只能作为“文档结构和 token 粒度”的参考。
- Zeus canonical token 必须继续使用 `--zeus-*` 语义命名。
- 不允许引入外部品牌字体、品牌色或 token 命名。
- 不允许因为文档 token 化，把 Zeus 拉回 Web SaaS 控制台、营销页或卡片堆。

## 5. 测试矩阵

| 验证 | 命令 | 预期 |
|---|---|---|
| 红灯：旧文档缺少 v2 契约 | `rg -n "Zeus Design Contract v2" DESIGN.md` | 修改前失败。 |
| 上下文加载 | `node /Users/david/.agents/skills/impeccable/scripts/load-context.mjs` | 能读取 `PRODUCT.md` 与更新后的 `DESIGN.md`。 |
| 核心组件语义 | `rg -n "source-list|object-toolbar|composer|decision-rail|mode-rail|popover|drawer" DESIGN.md` | 全部能在契约中找到。 |
| 禁用项检查 | 运行脚本动态拼接“外部品牌字体、外部灰阶 token、纯黑纯白色值”等禁用词后扫描 `DESIGN.md` 和本文档 | 无结果，避免外部品牌或纯黑纯白值进入 canonical 文档。 |
| 文档存在 | `test -f docs/TASK_20260623_001_ZeusDesignContractV2.md` | 文件存在。 |

## 6. 实施顺序

1. 读取根目录 `PRODUCT.md`、`DESIGN.md` 和最新 Zeus UI 任务文档，确认 Zeus 当前方向。
2. 运行红灯验证，确认旧 `DESIGN.md` 缺少 `Zeus Design Contract v2` 和完整组件语义契约。
3. 更新 `DESIGN.md`，追加机器可读 YAML 与使用规则。
4. 新增本任务文档，记录边界、契约、验证和风险。
5. 运行上下文加载与 `rg` 校验，确认设计契约可被后续 AI/Impeccable 读取。

## 7. 风险与回滚

| 风险 | 影响 | 控制 | 回滚 |
|---|---|---|---|
| 文档过度 token 化，后续实现机械套值 | 页面可能忽略用户路径和信息架构 | 使用规则明确“先判断页面唯一核心目标” | 删除 `Zeus Design Contract v2` 区块，恢复旧 `DESIGN.md` 口径。 |
| 外部设计系统被误当成视觉源 | Zeus 变成 Web SaaS 控制台风格 | 禁止外部品牌字体、品牌色和 token 命名进入 canonical 文档 | 回滚本任务文档和 `DESIGN.md` 新增区块。 |
| token 与现有 CSS 有少量重复 | 后续维护可能不知道以哪份为准 | 契约只描述语义；运行时仍以 `--zeus-*` 实现 token 为准 | 后续 UI 实现时按 CSS 真实值校准契约。 |
| 文档变更未触发运行时测试 | 不能证明 UI 像素变化 | 本任务不改运行时代码；明确不声明 UI 已变化 | 如后续改 UI，必须重新走 TDD 与 package gate。 |

## 8. 验收标准

- `DESIGN.md` 存在 `Zeus Design Contract v2`。
- 契约覆盖 source-list、object-toolbar、controls、composer、decision-rail、mode-rail、graph-canvas、popover、drawer。
- 契约说明中英双语、真实值不硬翻译、安全脱敏、危险动作确认。
- 文档未引入外部品牌字体、品牌色或 token 命名作为 Zeus canonical 设计系统。
- 本任务文档记录受影响目录、契约变更、测试矩阵、实施顺序、风险与回滚。

## 9. 验证记录

| 命令 | 结果 |
|---|---|
| `rg -n "Zeus Design Contract v2" DESIGN.md && rg -n "source-list|object-toolbar|composer|decision-rail|mode-rail|popover|drawer" DESIGN.md && test -f docs/TASK_20260623_001_ZeusDesignContractV2.md`（修改前） | 失败，旧文档缺少 v2 契约与任务文档。 |
| `node /Users/david/.agents/skills/impeccable/scripts/load-context.mjs` | 通过，`PRODUCT.md` 与 `DESIGN.md` 可读取，且 `DESIGN.md` 包含 `Zeus Design Contract v2`。 |
| `rg -n "Zeus Design Contract v2" DESIGN.md` | 通过，命中 v2 契约标题和使用规则标题。 |
| 逐项扫描 `source-list`、`object-toolbar`、`composer`、`decision-rail`、`mode-rail`、`popover`、`drawer` | 通过，核心 Zeus 组件语义均存在于 `DESIGN.md`。 |
| 动态拼接禁用词扫描 `DESIGN.md` 与本文档 | 通过，未发现外部品牌字体、外部灰阶 token、纯黑纯白色值等禁用字面量。 |

## 10. 代码契约对齐

### 10.1 变更范围

| 路径 | 影响 |
|---|---|
| `apps/desktop/test/renderer.test.tsx` | 新增 `Zeus Design Contract v2` 到 renderer CSS token 的契约测试。 |

### 10.2 契约内容

新增测试会读取根目录 `DESIGN.md` 与 `apps/desktop/src/renderer/styles.css`，锁定：

- `DESIGN.md` 必须存在 `Zeus Design Contract v2` 和 `zeus-design-contract-v2` 版本标识。
- `DESIGN.md` 必须保留 `quality_gates` 与 `focus-visible`、`keyboard-navigation`、`aria-current-or-selected`、`reduced-motion` 可访问性底线。
- `source-list`、`object-toolbar`、`controls`、`composer`、`decision-rail`、`mode-rail`、`graph-canvas`、`popover`、`drawer` 的关键 `--zeus-*` token 必须同时出现在 `DESIGN.md` 与 renderer CSS 中。
- `DESIGN.md` 不允许出现外部品牌字体、外部灰阶 token 或纯黑纯白色值字面量。

### 10.3 代码对齐验证记录

| 命令 | 结果 |
|---|---|
| `pnpm vitest run apps/desktop/test/renderer.test.tsx -t "keeps Zeus Design Contract v2 component tokens aligned with renderer CSS tokens" --reporter=verbose`（红灯） | 失败，测试哨兵 `--zeus-contract-red-green-sentinel` 不存在，证明测试能捕获契约缺失。 |
| `pnpm vitest run apps/desktop/test/renderer.test.tsx -t "keeps Zeus Design Contract v2 component tokens aligned with renderer CSS tokens" --reporter=verbose`（绿灯） | 通过，1 test passed / 66 skipped。 |
| `pnpm vitest run apps/desktop/test/app-shell-layout.test.tsx apps/desktop/test/renderer.test.tsx --reporter=verbose` | 通过，2 files / 227 tests passed。 |
| `pnpm lint` | 通过，`eslint .` exit 0。 |
| `pnpm typecheck` | 通过，`tsc -b` exit 0。 |
| `pnpm format:check` | 通过，所有匹配文件符合 Prettier。 |
| `git diff --check -- DESIGN.md docs/TASK_20260623_001_ZeusDesignContractV2.md apps/desktop/test/renderer.test.tsx` | 通过，无空白错误。 |
