# TASK_20260615_001 Zeus Codex App AI Native UI重构

## 任务背景

用户明确要求：Zeus 是 macOS App，不是 Web 后台；需要完全移除卡片布局，UI/UX 向 Codex App 对齐，并融合 Code Map 的空间化图谱工作台记忆点。允许合理使用 macOS App 动效，目标是高级、简约、使用简单、AI Native。

## 已确认方向

- 采用 A + C：Codex-native Thread Workbench + Spatial Graph Studio。
- 不按网页 Dashboard 思维设计；默认是本地 macOS AI 工作台。
- 不新增后端接口，不伪造项目、任务、图谱、Runtime、Git、Telegram 或 AI 输出。
- 优先复用现有 React/Electron Renderer 和真实 API 契约，不新增外部依赖。
- 所有按钮必须保留真实 handler 或真实禁用原因，不能出现“看起来可点但无效”的假入口。

## 受影响目录

- `/Users/david/hypha/zeus/apps/desktop/src/renderer/App.tsx`：主壳层、Dashboard、Projects、Tasks、Code Map、Runtime、Git Diff、Telegram、Settings 的工作区呈现方式。
- `/Users/david/hypha/zeus/apps/desktop/src/renderer/styles.css`：移除卡片视觉语言，改为 macOS App 侧栏、线程、Inspector、Graph Studio 和动效。
- `/Users/david/hypha/zeus/apps/desktop/test/renderer.test.tsx`：新增 UI/UX 契约测试，禁止卡片布局并要求 macOS-grade AI Native 壳层。
- `/Users/david/hypha/zeus/apps/desktop/test/app-code-map-rendering.test.tsx`：新增 Spatial Graph Studio 视图契约。
- `/Users/david/hypha/zeus/docs/superpowers/plans/2026-06-15-zeus-ai-native-macos-ui.md`：实现计划。

## 契约变更

### 前端 DOM / CSS 契约

- App 根节点必须体现 `macos-ai-app`、`codex-thread-workbench`、`spatial-graph-studio` 设计语义。
- 主区域从卡片网格转为：左 Sidebar、中 Thread/Workspace、右 Context Rail。
- Code Map 必须显示 Graph Studio 主舞台，不再只是普通数据卡片列表。
- 动效必须只服务状态变化：导航切换、线程进入、Inspector 展开、图谱舞台聚焦、按钮反馈。
- 必须支持 `prefers-reduced-motion`，降级时禁用非必要动画。

### API / 数据库 / 后端契约

- 不新增 API。
- 不新增数据库表或字段。
- 不改变 Local Server、安全、Git、Runtime、Graph、Telegram 业务语义。
- 不新增外部依赖。

## 测试矩阵

| 层级 | 用例 | 验收口径 |
|---|---|---|
| RED | Renderer 根壳层必须是 macOS AI App，不包含卡片布局类 | 先失败，再实现 |
| RED | Dashboard 必须渲染 Command Thread / Activity Timeline / Context Inspector | 先失败，再实现 |
| RED | Code Map 必须渲染 Spatial Graph Studio 舞台 | 先失败，再实现 |
| 回归 | 现有真实数据、空态、按钮禁用、外部等待项测试 | 保持通过 |
| 类型 | `pnpm typecheck` | 通过 |
| GUI | 通过真实 macOS App 点击主导航和关键按钮 | 截图证明，记录任何阻塞 |
| 发布门禁 | `pnpm verify:release` | 作为最终强验证，若 GUI 或环境阻塞则如实记录 |

## 实施顺序

1. 运行受影响 UI 测试建立 baseline。
2. 新增 RED 测试，锁定 macOS App、无卡片、Codex Thread、Spatial Graph Studio 和动效可降级。
3. 重构 `App.tsx` 壳层语义、Dashboard 入口、通用 DataPanel 呈现和 Code Map 舞台结构。
4. 重构 `styles.css`：移除卡片式外观，统一 macOS 原生侧栏、线程、列表、Inspector、图谱舞台和动效。
5. 跑聚焦测试与 typecheck。
6. 启动真实 macOS App，用 Computer Use 点击 Dashboard、Projects、Tasks、Code Map、Runtime、Git Diff、Telegram、Settings 和关键按钮，截图检查视觉与交互。
7. 跑最终验证门禁，更新本文件实施记录。

## 风险与回滚

- 风险：当前 Renderer 文件较大，UI 改动可能影响多个 SSR 测试快照；通过聚焦测试先收敛。
- 风险：真实按钮点击依赖本地服务和 Electron 启动；如果本机权限或端口阻塞，需要记录具体阻塞点，不能伪造点击成功。
- 风险：完全移除卡片视觉可能与部分测试历史文案冲突；保持业务文案和真实数据契约，必要时更新测试口径。
- 回滚：恢复 `App.tsx`、`styles.css` 和新增/调整的 UI 测试即可；后端、数据库、打包配置不受影响。

## 实施记录

- 2026-06-15：已确认 A + C 方向；baseline 聚焦 UI 测试通过：5 个测试文件、70 个测试。

## 2026-06-15 目标补充：功能可用性验证

用户补充要求：不仅要完成视觉和交互重构，还要验证所有功能都是可用状态。

本任务的“可用状态”口径定义如下：

1. 对当前环境已经具备前置条件的功能，必须能通过真实按钮点击触发真实 handler 或真实本地 API。
2. 对缺少外部凭据/本机工具的功能，例如 AI CLI 登录、Telegram Bot Token、Apple signing、Homebrew tap token，必须显示未配置/等待项，不能展示假成功。
3. 对高风险功能，例如删除、Git 写操作、Generic shell、远程触发 Runtime，必须能进入真实确认流程；最终破坏性动作遵守 Computer Use 安全确认策略，不在未确认时强行执行。
4. 对本地服务未连接时的按钮，必须禁用并显示真实原因；连接完成后应恢复可用。
5. GUI 验证需要真实启动 macOS App，逐项点击主导航与关键按钮，并保存截图或明确记录可见状态。

## 2026-06-15 目标补充：多窗口尺寸验证

用户补充要求：优先用全屏场景验证，再用其他竖屏和小屏分辨率验证布局。

验证口径：

1. 全屏：优先把 Zeus macOS App 切到全屏或最大可用窗口，逐项点击主导航和关键按钮，检查三栏工作台、Thread、Context Inspector、Spatial Graph Studio 的完整体验。
2. 竖屏：模拟窄而高窗口，检查 Sidebar、主工作区、Inspector 是否可滚动、是否出现不可控横向溢出。
3. 小屏：模拟接近最小窗口尺寸，检查关键导航、主操作、禁用原因、图谱舞台、设置表单仍可访问。
4. 若窗口尺寸受 Electron `minWidth/minHeight` 限制，记录真实限制，不绕过产品约束。

## 2026-06-15 最终实施记录与验收闭环

### 最终实现内容

1. **完全移除网页卡片感**
   - Dashboard、项目、任务、Code Map、Runtime、Git、Telegram、Settings 的主体视觉统一为 macOS 分栏、线程分隔线、Context Rail 和轻量输入控件。
   - 保留必要的按钮、输入框、表单和列表语义；旧 `.card/.data-card/.panel-card/.metric-card/.dashboard-card/.card-grid/.data-row` 在真实 App 验收中计数为 0。

2. **Codex App 对齐的 AI Native 工作台**
   - 根壳层加入 `macos-ai-app`、`codex-thread-workbench`、`spatial-graph-studio` 语义。
   - Dashboard 转为 `Command Thread · Command Composer`、`Evidence Timeline · Activity Stream`、`Context Inspector · Context Rail`。
   - 主导航从网页长页面思维转为 AI 工作区切换；未激活的重型 Code Map WebGL 运行时不再后台挂载。

3. **Spatial Graph Studio**
   - Code Map 顶部改为 Graph Stage：Node Focus / Source Trail / 真实节点边统计。
   - Sigma WebGL、React Flow、Mermaid 继续消费真实图谱数据，不造示例节点。
   - 大型真实图谱的服务端全局坐标会压缩到 macOS 桌面画布内，避免 SVG/WebGL 撑出几万像素横向滚动。
   - Mermaid 源码预览限制在内部滚动区域，避免源码墙破坏简约体验。

4. **真实 macOS 包运行修复**
   - Electron preload 改为 CommonJS 可加载形态，避免 packaged app 空窗。
   - 运行脚本改为稳定启动 Electron app 目录。
   - macOS tray 图标改为真实 template PNG，并且托盘不可用时不阻断 Settings 保存和主窗口功能。
   - asar 健康检查修复 4 字节对齐读取，确保 packaged-health 检查真实读取 `package.json` 和 renderer asset。

5. **状态与交互可靠性**
   - Electron hydration 后同步真实 snapshot，避免首屏 connecting 空态锁死后续项目/任务。
   - 项目创建/配置/归档等本地失败路径会退出 `creating-project`，避免按钮一直显示“创建中”。
   - 窄窗口下隐藏 Inspector，Code Map 单列排列，表单、图谱、源码路径全部约束在可视宽度内。

### 受影响文件补充

- `/Users/david/hypha/zeus/apps/desktop/src/renderer/App.tsx`
  - macOS AI Native 壳层、Code Map active 挂载控制、超大图谱坐标压缩、hydration 同步、项目 action 失败态。
- `/Users/david/hypha/zeus/apps/desktop/src/renderer/styles.css`
  - Codex 无卡片覆盖层、macOS 动效、全屏/竖屏/小屏响应式、Code Map 溢出治理、Mermaid 源码限高。
- `/Users/david/hypha/zeus/apps/desktop/test/renderer.test.tsx`
  - Codex-like shell、无卡片、motion fallback、hydration、项目 action 失败态回归。
- `/Users/david/hypha/zeus/apps/desktop/test/app-code-map-rendering.test.tsx`
  - Spatial Graph Studio、WebGL 不后台挂载、超大布局压缩、窄屏无横向溢出、Mermaid 源码限高回归。
- `/Users/david/hypha/zeus/scripts/package-mac.test.ts`
  - tray 降级、preload CommonJS、asar 对齐读取、packaged health 回归。
- `/Users/david/hypha/zeus/scripts/verify-packaged-app-health.mjs`
  - asar payload 对齐读取。
- `/Users/david/hypha/zeus/apps/desktop/src/main/main.ts`
  - packaged app 激活、tray 安全降级、preload 路径。
- `/Users/david/hypha/zeus/apps/desktop/src/preload/index.cts`
  - packaged preload CommonJS 入口。
- `/Users/david/hypha/zeus/apps/desktop/electron-builder.yml`
  - assets 打包。
- `/Users/david/hypha/zeus/script/build_and_run.sh`
  - macOS app 启动入口。

### 最终验证命令

| 验证项 | 命令 / 证据 | 结果 |
|---|---|---|
| 聚焦 UI/打包回归 | `pnpm vitest run apps/desktop/test/renderer.test.tsx apps/desktop/test/app-code-map-rendering.test.tsx scripts/package-mac.test.ts --reporter=verbose` | 3 个测试文件、74 个测试通过 |
| 最终 release 门禁 | `pnpm verify:release` | 63 个测试文件、563 个测试通过；真实扫描、build、package、packaged-health 通过 |
| macOS packaged App 真实点击 | `/Users/david/hypha/zeus/.tmp/zeus-final-ui-smoke.json` | 17 个安全按钮/导航真实鼠标事件点击；异常 0；日志警告 0；横向溢出 0；旧卡片类 0 |
| 全屏截图 | `/Users/david/hypha/zeus/.tmp/screenshots/zeus-final-full-dashboard.png` | Dashboard 三栏工作台正常 |
| 全屏 Code Map | `/Users/david/hypha/zeus/.tmp/screenshots/zeus-final-full-code-map.png` | Spatial Graph Studio 正常，Sigma/React Flow 可见 |
| 竖屏 Code Map | `/Users/david/hypha/zeus/.tmp/screenshots/zeus-final-portrait-code-map.png` | Inspector 收起，单列布局，无横向溢出 |
| 小屏 Dashboard | `/Users/david/hypha/zeus/.tmp/screenshots/zeus-final-small-dashboard.png` | Sidebar + 主工作区可用，无横向溢出 |

### 真实点击覆盖

已通过 packaged app + CDP 鼠标事件真实点击以下安全入口：

- Dashboard：扫描图谱、审查 Diff。
- Code Map：Code Map 导航、模块图、搜索、生成 Mermaid 预览、隐藏节点、恢复全部节点、从节点创建任务。
- Runtime / Git / Settings / Telegram：主导航、刷新运行环境、保存通用设置、刷新轮询状态等可见安全按钮。

未执行的最终破坏性或外部副作用动作：

- 删除项目/任务、清理本地缓存、Git 写入最终确认、导入/导出文件保存面板、选择真实仓库的原生文件选择最终确认。
- Telegram 真实发送、Apple signing/notarization、登录项权限写入、外部 API Key / Bot Token 保存。

这些入口的产品口径是：显示真实等待项或进入真实确认流程，不伪造成功。

### Computer Use 验证限制

- Computer Use `list_apps` 能识别 `Zeus — /Users/david/hypha/zeus/dist/mac-arm64/Zeus.app/ — dev.hypha.zeus` 处于运行状态。
- 但本轮 `get_app_state` 针对 `Zeus`、完整 app 路径、`dev.hypha.zeus` 三种方式均在 120 秒工具超时。
- 已先用 CDP 将真实 App 切回 Dashboard 后重试，仍为工具读取超时；因此最终功能点击证据采用 packaged app + CDP 鼠标事件与截图报告，未把 Computer Use 读取伪装为成功。

### 风险与回滚更新

- 风险：当前构建仍是 unsigned DMG/ZIP；`verify:release` 明确输出 Apple signing certificate 未配置，只验证 unsigned artifacts。
- 风险：AI CLI/Telgram/Apple 相关外部配置按真实状态展示等待项，不能视为已完成外部账号配置。
- 风险：真实 Code Map 大图谱较重，已避免后台挂载和横向溢出；后续如果引入更复杂图谱交互，需要继续保持“不激活不挂载”。
- 回滚：回退上述前端、Electron main/preload、打包脚本、健康检查和对应测试文件；无数据库迁移，无后端 API 契约变化。

## 2026-06-15 返修实施记录：Codex 纯白 Apple 风格与设置收束

### 本轮新增目标

1. 整体视觉参考 Codex App：纯白内容区、浅灰侧栏、极简分隔线，不再使用灰蓝渐变或卡片化后台风格。
2. 左侧主导航只保留核心工作入口：项目、任务、本地 CLI 对话、设置；Code Map、Git Diff、Telegram 等能力不再占据左侧主菜单。
3. 左侧菜单、主工作区、右侧 Context Rail 必须独立滚动；点击左侧切换只更新工作区，不触发浏览器原生 hash 滚动。
4. 设置相关能力统一进入 Settings 分类页，参考 Codex App 的 Settings：左分类、右内容、分组 rows，不在首页或 Runtime 页面平铺设置卡片。
5. 全局按钮、下拉框、输入框、textarea 统一为 macOS/Codex 风格控件，覆盖 focus、disabled、hover 等状态。
6. “选择真实本地代码库”在当前 Zeus 仓库已存在时不再打开无意义原生选择器；首轮无项目时可直接使用 `/Users/david/hypha/zeus` 作为真实扫描路径。
7. 左侧极简后，扫描图谱和审查 Diff 仍必须可达，因此新增全局顶部快捷动作；打开 Code Map 会同步切换到探索工作区。

### 受影响目录

- `/Users/david/hypha/zeus/apps/desktop/src/renderer/App.tsx`
  - 左侧导航改为 Codex 风格核心入口。
  - 增加 `handleMainNavigate`，通过 `history.replaceState` 更新 hash，阻止原生锚点跳转。
  - `ai-workspace` 使用独立 scroll ref，导航切换仅滚动主工作区。
  - Settings 改为 `settings-workbench`，分区包含常规、个人、配置、集成、编码、Git、MCP 服务器、钩子、已归档。
  - Runtime 与 Settings 显示边界拆开，不再让设置项混在本地 CLI 对话页。
  - 全局顶部快捷动作暴露打开/扫描 Code Map、审查 Diff。
- `/Users/david/hypha/zeus/apps/desktop/src/renderer/styles.css`
  - 增加 Codex 纯白 Apple 风格覆盖层。
  - 增加三栏独立滚动、全局控件统一风格、Settings 分类页样式、顶部快捷动作样式。
- `/Users/david/hypha/zeus/apps/desktop/src/renderer/main.tsx`
  - `resolveProjectDirectoryForCreation`：无项目时回退当前真实 Zeus 仓库；当前仓库已存在时点击选择仓库只刷新 dashboard，不打开无意义选择器。
- `/Users/david/hypha/zeus/apps/desktop/test/renderer.test.tsx`
  - 新增 Codex 极简侧栏、独立滚动、纯白风格、Settings 分类、全局控件、选择仓库回退、Code Map 可达性测试。
- `/Users/david/hypha/zeus/apps/desktop/test/app-code-map-rendering.test.tsx`
  - 设置类断言移动到 Settings 页面口径。

### 契约变更

- 不新增后端 API。
- 不新增数据库表或字段。
- 不新增外部依赖。
- Renderer DOM 契约变化：Settings 页面以 `settings-workbench` 为主容器；左侧主导航只展示核心工作入口。
- 功能契约变化：无项目首轮“选择真实本地代码库”可使用当前真实 Zeus 仓库；当前仓库已存在时按钮不再制造原生选择器阻塞。

### 测试矩阵

| 层级 | 用例 | 结果 |
|---|---|---|
| RED/GREEN | 极简 Codex 左侧主导航 | 通过 |
| RED/GREEN | 左侧/主工作区/右侧独立滚动，禁止原生 hash 跳转 | 通过 |
| RED/GREEN | 纯白 Apple 风格，不再灰蓝渐变 | 通过 |
| RED/GREEN | Settings 分类页，禁止设置卡片平铺 | 通过 |
| RED/GREEN | 全局按钮、下拉、输入控件统一风格 | 通过 |
| RED/GREEN | 选择仓库取消/无项目时使用当前真实 Zeus 仓库 | 通过 |
| RED/GREEN | 左侧极简后 Code Map / Diff 仍可达 | 通过 |
| 回归 | Renderer + Code Map + package helper 聚焦测试 | 通过：3 个测试文件、81 个测试 |
| 类型 | `pnpm typecheck` | 通过 |
| 打包 | `pnpm package:mac` | 通过，生成 macOS app / DMG / ZIP |
| 包内健康 | `node scripts/verify-packaged-app-health.mjs dist/mac-arm64/Zeus.app` | 通过 |
| GUI | 打包 App + CDP 鼠标事件，全屏/竖屏/小屏截图 | 通过；Computer Use 仍超时，未伪装为成功 |

### 真实 App 点击与截图证据

- CDP 真实点击报告：`/Users/david/hypha/zeus/.tmp/zeus-codex-ui-smoke.json`
- 全屏初始：`/Users/david/hypha/zeus/.tmp/screenshots/zeus-codex-full-initial.png`
- 全屏 Settings：`/Users/david/hypha/zeus/.tmp/screenshots/zeus-codex-full-settings.png`
- 打开 Code Map 后：`/Users/david/hypha/zeus/.tmp/screenshots/zeus-codex-code-map-after-click.png`
- 竖屏：`/Users/david/hypha/zeus/.tmp/screenshots/zeus-codex-portrait.png`
- 小屏：`/Users/david/hypha/zeus/.tmp/screenshots/zeus-codex-small.png`

CDP 验证事实：

- body 背景 `rgb(255, 255, 255)`，侧栏 `rgb(247, 247, 248)`。
- 左侧导航仅：项目、任务、本地 CLI 对话、设置。
- 旧卡片类计数为 0。
- `ai-workspace`、`ai-sidebar`、`context-inspector` 的 `overflow-y` 均为 `auto`。
- Settings 分类包含：常规、个人、配置、集成、编码、Git、MCP 服务器、钩子、已归档。
- 全屏、竖屏、小屏横向溢出均为 0。
- “选择真实本地代码库”点击后未出现 `创建中/扫描中/刷新中` 卡死状态，本地错误为 false。
- “打开 Code Map”点击后进入“探索工作区”，Graph Stage 可见。

### 风险与回滚

- 风险：当前仍是 unsigned macOS 构建，Apple signing/notarization 继续作为外部等待项展示。
- 风险：Computer Use 对 Zeus 窗口读取仍 120 秒超时；功能点击证据来自 CDP 鼠标事件和截图。
- 风险：当前用户数据中已经存在多个 Zeus 项目记录，本轮未清理用户数据，避免误删真实本机记录；“选择仓库”首轮无项目路径由测试与源码契约保障。
- 回滚：恢复 `App.tsx`、`styles.css`、`main.tsx` 与对应测试即可；无数据库迁移，无后端 API 契约变化。

## 2026-06-16 目标模式最终返修记录

### 用户追加目标

1. 不要顶部 hero，不要卡片式布局，不要把所有内容铺在一个页面里。
2. UI/UX 继续对齐 Codex App：纯白工作区、浅灰侧栏、右侧 Context Rail 纯白，不做 Web 后台式页面。
3. 页面文案必须简短，只保留功能名称、状态值和真实可操作控件；移除解释性长描述。
4. 任务必须支持“推送到 CLI 对话”，交互参考 giraffe：任务推送后进入真实会话链路，不创建假会话、不用 mock/seed 数据。
5. 自行截图验证：优先全屏，再验证竖屏和小屏；按钮要真实点击验证。

### 参考 giraffe 后的契约落点

- 参考文档：`/Users/david/hypha/giraffe/docs/TASK_20260424_001_任务推送后立即打开会话与会话列表可见.md`。
- 参考结论：用户感知会话以真实 `sessionId`/运行会话为核心；没有真实会话时不制造列表占位；再次推送应延续同一真实会话链路。
- Zeus 本轮落点：任务列表中的 ready 任务按钮从“启动 Runtime”改为“推送到 CLI 对话”，仍调用现有 `onRunTask` 真实任务控制 API，由后端写入 Runtime 会话和审计事件；前端只刷新真实 snapshot，不写死 mock 数据。

### 实际受影响目录

- `/Users/david/hypha/zeus/apps/desktop/src/renderer/App.tsx`
  - 删除顶部 `WorkspaceHeader` 与旧 `CommandComposer` 渲染入口。
  - Dashboard 只保留真实时间线、真实配置状态和底部 Codex 风格输入 dock。
  - 主工作区改为按当前入口条件渲染：项目、任务、Code Map、Git Diff、Runtime、Settings 不再同时铺在一个页面中。
  - `inferInitialMainNavTarget` 增加真实数据导向：Git Diff、Code Map、Runtime、Settings、任务事件分别进入对应工作区。
  - 任务 ready 操作改名为“推送到 CLI 对话”。
  - DataPanel / EmptyPrompt / InlineNotice / InspectorSection 移除长描述渲染。
- `/Users/david/hypha/zeus/apps/desktop/src/renderer/styles.css`
  - 增加最终 Codex/macOS 覆盖层：白色主工作区、白色右侧 Rail、无卡片背景、无大圆角卡片、无阴影卡片。
  - Settings 改为左分类 + 右侧线性 row 布局，移除大边框分类卡片。
  - 任务页改为线性列表，搜索、任务、按钮均用分隔线和 macOS 控件表达。
  - 全屏、竖屏、小屏响应式覆盖：Settings 在小屏自动单列，右侧 Rail 按既有窄屏规则收起。
- `/Users/david/hypha/zeus/apps/desktop/test/renderer.test.tsx`
  - 增加/调整无 hero、无 Command Composer、无卡片、纯白 Rail、真实工作区切换断言。
- `/Users/david/hypha/zeus/apps/desktop/test/app-data-rendering.test.tsx`
  - 更新旧“所有内容同页”断言为分工作区断言。
- `/Users/david/hypha/zeus/apps/desktop/test/app-task-controls-rendering.test.tsx`
  - 任务 ready 按钮断言改为“推送到 CLI 对话”。
- `/Users/david/hypha/zeus/apps/desktop/test/app-git-confirmation-rendering.test.tsx`、`app-task-events-rendering.test.tsx`、`app-snapshot.test.tsx`
  - 适配分工作区初始渲染口径。

### 契约变更

- API：不新增、不删除、不改后端 API。
- 数据库：不新增表/字段/索引，不迁移数据。
- 运行时：不新增外部依赖，不改 CI。
- UI 契约：
  - 左侧主导航只保留核心入口。
  - Code Map / Git Diff 作为工作区页面仍可通过 Dashboard 快捷动作和内部 hash 进入。
  - 任务推送入口文案统一为“推送到 CLI 对话”，但仍走真实 `onRunTask` 任务控制链路。

### 测试矩阵与结果

| 层级 | 命令/方式 | 结果 |
|---|---|---|
| 聚焦回归 | `pnpm vitest run apps/desktop/test/renderer.test.tsx apps/desktop/test/app-data-rendering.test.tsx apps/desktop/test/app-code-map-rendering.test.tsx apps/desktop/test/app-runtime-rendering.test.tsx apps/desktop/test/app-task-controls-rendering.test.tsx --reporter=dot` | 通过：5 files / 84 tests |
| Git/任务补充回归 | `pnpm vitest run apps/desktop/test/app-git-confirmation-rendering.test.tsx apps/desktop/test/app-snapshot.test.tsx apps/desktop/test/app-task-events-rendering.test.tsx` | 通过：3 files / 13 tests |
| 类型检查 | `npx tsc -p apps/desktop/tsconfig.json --noEmit --pretty false` | 通过 |
| 发布验收 | `pnpm verify:release` | 通过：63 files / 570 tests；real scan / build / package / packaged health 均通过 |
| macOS 打包 | `pnpm package:mac`（由 `verify:release` 再次执行） | 通过，生成 `/Users/david/hypha/zeus/dist/mac-arm64/Zeus.app`、DMG、ZIP |
| 真实 App 全屏点击 | 打包 App + CDP 鼠标点击 | 通过：项目、任务、本地 CLI 对话、设置、任务详情、推送到 CLI 对话、刷新会话、启动 Runtime 会话、打开 Code Map、审查 Diff 均真实点击 |
| 真实 App 布局截图 | 全屏、竖屏、小屏 | 通过：右侧 Rail `rgb(255,255,255)`，主工作区 `rgb(255,255,255)`，旧 header/composer 计数 0，卡片式容器计数 0 |

### 截图与点击证据

- CDP 点击与样式验证 JSON：`/Users/david/hypha/zeus/.tmp/screenshots/ui-verification.json`
- 全屏 Dashboard：`/Users/david/hypha/zeus/.tmp/screenshots/01-dashboard-full.png`
- 全屏项目：`/Users/david/hypha/zeus/.tmp/screenshots/nav-项目.png`
- 全屏任务：`/Users/david/hypha/zeus/.tmp/screenshots/nav-任务.png`
- 全屏本地 CLI 对话：`/Users/david/hypha/zeus/.tmp/screenshots/nav-本地 CLI 对话.png`
- 全屏设置：`/Users/david/hypha/zeus/.tmp/screenshots/nav-设置.png`
- 任务推送后：`/Users/david/hypha/zeus/.tmp/screenshots/task-cli-click.png`
- Runtime 点击后：`/Users/david/hypha/zeus/.tmp/screenshots/runtime-clicks.png`
- Code Map：`/Users/david/hypha/zeus/.tmp/screenshots/code-map-full.png`
- Git Diff：`/Users/david/hypha/zeus/.tmp/screenshots/git-diff-full.png`
- 竖屏：`/Users/david/hypha/zeus/.tmp/screenshots/portrait.png`
- 小屏：`/Users/david/hypha/zeus/.tmp/screenshots/small.png`

### 风险与回滚

- 风险：本机 Apple signing 证书仍未配置；`verify:release` 已验证 unsigned DMG/ZIP，但签名/公证仍是外部条件。
- 风险：Computer Use 对 Zeus 窗口仍存在超时历史，本轮真实点击以 Electron CDP 鼠标事件和打包 App 截图为证据。
- 风险：用户本机已有真实 Zeus E2E 数据，本轮不清空本地数据，避免误删真实任务/会话。
- 回滚：仅需恢复上述 renderer 与测试文件；无数据库迁移，无后端 API 变更，无新增依赖。

## 2026-06-16 返修实施记录：移除 macOS 原生顶部标题栏

### 用户反馈与根因

- 用户反馈：窗口顶部仍有一条 macOS 原生标题栏，居中显示 `Zeus`，Codex App 没有这条额外系统标题栏。
- 根因：Electron `BrowserWindow` 仍使用默认标题栏模式；Renderer 虽然已做 Codex 风格内容布局，但系统标题栏仍占据顶部视觉空间，导致窗口不像 Codex 的无标题栏沉浸式 App。

### 受影响目录

- `/Users/david/hypha/zeus/apps/desktop/src/main/main.ts`
  - 在 `BrowserWindow` 上设置 `titleBarStyle: 'hiddenInset'`。
  - 设置 `trafficLightPosition: { x: 14, y: 16 }`，让红黄绿窗口按钮贴近 Codex 的左上角位置。
  - 保留 `title: 'Zeus'`，仅用于系统菜单、辅助功能与窗口识别，不再作为可见顶部标题栏展示。
- `/Users/david/hypha/zeus/apps/desktop/src/renderer/styles.css`
  - 增加 `.macos-ai-app .ai-sidebar { padding-top: 58px; }`，让侧栏内容避开隐藏标题栏后的红黄绿窗口按钮区域。
- `/Users/david/hypha/zeus/scripts/package-mac.test.ts`
  - 新增窗口契约测试，锁定 hidden titlebar 与 traffic light 位置。
- `/Users/david/hypha/zeus/apps/desktop/test/renderer.test.tsx`
  - 新增侧栏避让测试，防止后续 CSS 回退导致内容压到窗口按钮下方。

### 契约变更

- 不新增后端 API。
- 不新增数据库表、字段或迁移。
- 不新增第三方依赖。
- macOS 窗口契约变化：Zeus 使用隐藏标题栏窗口，视觉上不再出现顶部系统标题栏；窗口标题仅保留给系统级识别。
- UI 契约变化：左侧侧栏顶部固定预留 58px，适配隐藏标题栏后的 macOS traffic lights。

### TDD 与验证记录

| 阶段 | 命令 / 证据 | 结果 |
|---|---|---|
| RED | `pnpm vitest run apps/desktop/test/renderer.test.tsx scripts/package-mac.test.ts --reporter=verbose` | 新增 hidden titlebar / 侧栏避让测试先失败，证明测试能捕获默认标题栏问题 |
| GREEN 聚焦测试 | `pnpm vitest run apps/desktop/test/renderer.test.tsx scripts/package-mac.test.ts --reporter=verbose` | 2 个测试文件、64 个测试通过 |
| 类型与打包 | `npx tsc -p apps/desktop/tsconfig.json --noEmit --pretty false && pnpm package:mac` | TypeScript 与 macOS 打包通过，生成 `/Users/david/hypha/zeus/dist/mac-arm64/Zeus.app`、DMG、ZIP |
| Release 门禁 | `pnpm verify:release` | 63 个测试文件、572 个测试通过；真实扫描、build、package、packaged-health 通过；仍为 unsigned artifacts |
| 非侵入复核 | `pnpm vitest run apps/desktop/test/renderer.test.tsx scripts/package-mac.test.ts --reporter=verbose && node scripts/verify-packaged-app-health.mjs dist/mac-arm64/Zeus.app` | 2 个测试文件、64 个测试通过；`packaged-health=Zeus;rendererAssets=2;main=dist/main/main.js` |

### 真实 App 截图与功能证据

> 注：首次截图验证时曾将 Zeus 窗口拉到前台，已按用户反馈立即关闭。后续不再主动弹窗或激活 App；除非用户明确允许，后续验收只使用后台端口、构建产物和代码级验证。

- CDP 内容截图：`/Users/david/hypha/zeus/.tmp/screenshots/titlebar-hidden-final-cdp.png`
  - `appTop = 0`，内容区域从窗口顶部开始。
  - `.ai-sidebar` 计算样式 `padding-top = 58px`，避开左上角 traffic lights。
  - 可见核心入口：项目、任务、本地 CLI 对话、设置、选择真实本地代码库、打开 Code Map、审查 Diff。
- macOS 系统截图：`/Users/david/hypha/zeus/.tmp/screenshots/titlebar-hidden-final-macos.png`
  - 窗口顶部不再显示居中的 `Zeus` 系统标题栏。
  - 左上角仅保留红黄绿窗口按钮，内容贴近 Codex App 的无标题栏体验。
- 响应式后台验证：`fullscreen 2048x1326`、`portrait 900x1326`、`small 760x920` 三种尺寸下 `.ai-sidebar` 均保持 `padding-top = 58px`。

### 风险与回滚

- 风险：隐藏标题栏后，macOS 左上角 traffic lights 与侧栏内容的间距由 CSS 约束保障；若未来重构侧栏，需要保留对应避让测试。
- 风险：当前 release 仍未配置 Apple signing certificate，`verify:release` 只证明 unsigned DMG/ZIP 健康，不代表已签名/公证。
- 回滚：移除 `BrowserWindow` 的 `titleBarStyle`、`trafficLightPosition`，并删除侧栏 58px 避让覆盖和对应测试；无数据库或后端契约回滚。

### 非侵入验证约束更新

- 不再主动打开、激活或弹出 Zeus 窗口。
- 不再主动执行全屏系统截图。
- 后续若需真实 GUI 验证，必须先向用户确认；默认只做后台端口、DOM、样式、构建产物和测试验证。

## 2026-06-16 返修实施记录：隐藏标题栏后恢复顶部拖拽

### 用户反馈与根因

- 用户反馈：去掉 macOS 原生标题栏后，点击窗口顶部无法拖动窗口。
- 根因：Electron 隐藏标题栏后，Renderer 内容覆盖到窗口顶部；原生可拖拽标题栏不再占据可见区域，但 CSS 没有把新的顶部留白声明为窗口拖拽区。
- 设计口径：保持 Codex 式无标题栏视觉，不恢复系统标题栏；只把三栏顶部留白和非交互空白区设为拖拽区，并确保按钮、链接、输入框等控件仍可点击。

### 受影响目录

- `/Users/david/hypha/zeus/apps/desktop/src/renderer/styles.css`
  - 为 `.ai-sidebar`、`.ai-workspace`、`.context-inspector` 声明 `app-region/-webkit-app-region: drag`。
  - 对三栏直接内容和全局交互控件声明 `no-drag`，避免拖拽区吞掉导航、按钮、表单和图谱交互。
- `/Users/david/hypha/zeus/apps/desktop/test/renderer.test.tsx`
  - 新增隐藏标题栏拖拽区契约测试，锁定拖拽区与 no-drag 保护。

### 契约变更

- 不新增后端 API。
- 不新增数据库表、字段或迁移。
- 不新增第三方依赖。
- macOS 窗口交互契约变化：隐藏标题栏后，三栏顶部留白可拖动窗口；真实内容、按钮、链接、输入框、下拉、textarea、label、summary 均不参与窗口拖拽。

### 测试矩阵

| 层级 | 命令 / 证据 | 结果 |
|---|---|---|
| Baseline | `pnpm vitest run apps/desktop/test/renderer.test.tsx scripts/package-mac.test.ts --reporter=verbose` | 修改前 2 个测试文件、64 个测试通过 |
| RED | `pnpm vitest run apps/desktop/test/renderer.test.tsx -t "hidden-titlebar top gutters" --reporter=verbose` | 新增测试先失败，提示缺少 `Codex macOS 隐藏标题栏拖拽区` 契约 |
| GREEN 聚焦 | `pnpm vitest run apps/desktop/test/renderer.test.tsx -t "hidden-titlebar top gutters" --reporter=verbose` | 1 个测试通过 |
| 回归与类型 | `pnpm vitest run apps/desktop/test/renderer.test.tsx scripts/package-mac.test.ts --reporter=verbose && npx tsc -p apps/desktop/tsconfig.json --noEmit --pretty false` | 2 个测试文件、65 个测试通过；desktop TypeScript 检查通过 |

### 实施顺序

1. 先确认隐藏标题栏实现仍为 `titleBarStyle: 'hiddenInset'`，问题不在 Main 窗口配置，而在 Renderer 未声明新拖拽区。
2. 新增 RED 测试，要求三栏顶部可拖拽，并要求交互控件 `no-drag`。
3. 在 CSS 尾部追加最终覆盖，利用三栏容器 padding 形成拖拽区，直接内容和交互控件退出拖拽区。
4. 运行聚焦测试、窗口/渲染回归测试与 desktop typecheck。

### 风险与回滚

- 风险：本次未主动打开或激活真实 Zeus 窗口，遵守当前非侵入验证约束；真实手感仍建议用户在现有窗口中点击顶部留白确认。
- 风险：Electron 窗口拖拽依赖 `-webkit-app-region` 运行时行为，自动化单元测试只能锁定 CSS 契约，不能替代真实 macOS 手势验证。
- 回滚：移除本轮 `styles.css` 的拖拽区覆盖和 `renderer.test.tsx` 的新增契约测试即可；无数据库、后端、打包配置或依赖回滚。

## 2026-06-16 返修实施记录：全局移除重复装饰标签与品牌上下文块

### 用户反馈与根因

- 用户反馈：全局去掉截图中类似的大写 eyebrow、重复上下文标题、左侧品牌块和分组标题，例如 `LIVE WORKSPACE`、`CONTEXT INSPECTOR · CONTEXT RAIL`、`Local AI Workbench`、`ZEUS WORKSPACES`、`PREFERENCES` 等。
- 根因：前一轮为了强调 AI Native / Codex 语义，保留了较多“设计说明型”文字；这些文字对真实任务操作没有必要，反而占据顶部和侧栏空间，形成视觉噪音。
- 同步修正：用户标红的顶部空白带仍无法拖动，说明仅给三栏容器设置拖拽区不够稳定；真实命中区域被滚动内容层覆盖，需要一个显式固定顶部拖拽层。

### 受影响目录

- `/Users/david/hypha/zeus/apps/desktop/src/renderer/App.tsx`
  - 移除 Sidebar 品牌块、当前上下文块、外部配置等待项块和分组可见标题。
  - 移除 Dashboard ActivityStream 顶部说明标题。
  - 移除 ContextRail 顶部说明标题，只保留事实行。
  - 移除 DataPanel 的 `Live Workspace / Waiting State` 与页面重复标题，只保留真实内容、表单、列表和操作。
  - 新增 `window-drag-strip` 顶部透明拖拽命中层。
- `/Users/david/hypha/zeus/apps/desktop/src/renderer/styles.css`
  - 顶部拖拽从三栏容器级 `drag` 改为显式固定透明层，避免滚动内容层抢走拖拽手势。
  - 保留交互控件 `no-drag`，避免按钮、链接、输入框、下拉、textarea、summary、label 失去点击能力。
- `/Users/david/hypha/zeus/apps/desktop/test/renderer.test.tsx`
  - 新增全局去噪契约测试，禁止上述装饰文案再次渲染。
  - 调整隐藏标题栏拖拽契约，要求存在显式 `window-drag-strip`，并禁止再用三栏容器级 drag 兜底。
  - 更新旧断言，避免继续要求保留 `Activity Stream` 这类装饰标题。

### 契约变更

- 不新增后端 API。
- 不新增数据库表、字段或迁移。
- 不新增第三方依赖。
- UI 契约变化：页面和侧栏不再显示重复的设计说明型标题；导航只保留真实入口名称；右侧上下文只保留事实行。
- 窗口交互契约变化：隐藏标题栏后，窗口顶部 56px 透明命中层负责拖动；真实交互控件继续 `no-drag`。

### 测试矩阵

| 层级 | 命令 / 证据 | 结果 |
|---|---|---|
| RED | `pnpm vitest run apps/desktop/test/renderer.test.tsx -t "hidden-titlebar top gutters\|decorative eyebrow" --reporter=verbose` | 2 个新增/调整测试先失败：缺少 `window-drag-strip`，且仍渲染 `Live Workspace` 等装饰文案 |
| GREEN 聚焦 | `pnpm vitest run apps/desktop/test/renderer.test.tsx -t "hidden-titlebar top gutters\|decorative eyebrow" --reporter=verbose` | 1 个测试文件、2 个目标测试通过 |
| 回归与类型 | `pnpm vitest run apps/desktop/test/renderer.test.tsx scripts/package-mac.test.ts --reporter=verbose && npx tsc -p apps/desktop/tsconfig.json --noEmit --pretty false` | 2 个测试文件、66 个测试通过；desktop TypeScript 检查通过 |
| 反向搜索 | `grep -RIn "Live Workspace\|Waiting State\|Context Inspector · Context Rail\|Local AI Workbench\|Zeus Workspaces\|Preferences\|当前上下文\|外部配置等待项" apps/desktop/src/renderer/App.tsx apps/desktop/src/renderer/styles.css` | 无生产源码残留 |

### 实施顺序

1. 先把用户截图里的视觉噪音收敛为明确清单：页面 eyebrow、右侧 Context 头、品牌块、当前上下文块、Sidebar 分组标题。
2. 先改测试，确认当前实现确实失败，避免只做 CSS 隐藏造成假修复。
3. 删除 Renderer 中对应可见结构，保留真实导航、事实行、表单和操作按钮。
4. 将窗口拖拽从三栏容器级 CSS 改为显式顶部透明层，保证用户标红整条区域可命中。
5. 运行聚焦测试、回归测试、类型检查和反向搜索。

### 风险与回滚

- 风险：本次仍未主动打开或激活真实 Zeus 窗口，遵守当前非侵入验证约束；拖拽真实手感需要用户在现有窗口中确认。
- 风险：显式顶部 56px 拖拽层会优先消费顶部空白带事件；若未来在顶部 56px 内放置真实按钮，需要单独放入 `no-drag` 命中区或降低拖拽层范围。
- 回滚：恢复 `App.tsx` 中被移除的标题块，恢复 `styles.css` 三栏容器拖拽规则，并回滚 `renderer.test.tsx` 的新增/调整测试；无后端、数据库、依赖或打包配置回滚。

## 2026-06-16 返工更正：源码通过但运行产物未更新

### 用户反馈与根因

- 用户反馈：实际窗口里仍然能看到被要求删除的 `LIVE WORKSPACE`、`CONTEXT INSPECTOR · CONTEXT RAIL`、`Local AI Workbench`、`ZEUS WORKSPACES`、`PREFERENCES` 等内容。
- 根因：上一轮只验证了源码渲染和测试，未同步更新 `apps/desktop/dist/renderer` 与 `dist/mac-arm64/Zeus.app`。用户正在看的窗口加载的是旧构建产物，因此源码修改没有体现在当前可见 App 中。
- 修正原则：UI 返修不能只交付源码级测试；涉及 Electron packaged app 时，必须同时验证源码、renderer 构建产物和 packaged app asar 产物。

### 本次补救动作

- 执行 `/Users/david/hypha/zeus/apps/desktop` 构建：`pnpm --filter @zeus/desktop build`。
- 执行 macOS 打包：`pnpm package:mac`，更新 `/Users/david/hypha/zeus/dist/mac-arm64/Zeus.app`、DMG、ZIP。
- 对源码、构建产物、packaged app 进行反向搜索，确认被点名文案不再作为 UI 文案残留。
- 执行 packaged health 检查，确认新的 packaged app renderer/main 入口可读取。

### 补救验证记录

| 层级 | 命令 / 证据 | 结果 |
|---|---|---|
| Renderer build | `pnpm --filter @zeus/desktop build` | 通过，生成新的 renderer assets：`index-D2A27mrz.css`、`index-L75oZVsb.js` 等 |
| macOS package | `pnpm package:mac` | 通过，更新 `/Users/david/hypha/zeus/dist/mac-arm64/Zeus.app`、`Zeus-0.1.0-arm64.dmg`、`Zeus-0.1.0-arm64.zip` |
| 源码反向搜索 | `grep -RIn "Live Workspace\|Waiting State\|Context Inspector · Context Rail\|Local AI Workbench\|Zeus Workspaces\|Preferences\|当前上下文\|外部配置等待项" apps/desktop/src/renderer/App.tsx apps/desktop/src/renderer/styles.css` | 无残留 |
| 构建产物反向搜索 | 同关键字搜索 `apps/desktop/dist/renderer` | 无目标 UI 文案残留 |
| packaged app 反向搜索 | 同关键字搜索 `dist/mac-arm64/Zeus.app/Contents/Resources/app.asar` 字符串 | 无目标 UI 文案残留；`Preferences` 仅作为 `webPreferences/projectPreferences` 代码标识片段出现，不是 UI 文案 |
| packaged health | `node scripts/verify-packaged-app-health.mjs dist/mac-arm64/Zeus.app` | `packaged-health=Zeus;rendererAssets=2;main=dist/main/main.js` |

### 风险与回滚

- 风险：如果用户当前仍打开旧 Zeus 进程，必须退出并重新打开 `/Users/david/hypha/zeus/dist/mac-arm64/Zeus.app` 才会加载新 bundle。
- 风险：本轮仍未主动激活 GUI，未做真实鼠标拖拽手感验证；但已保证当前源码、构建产物和 packaged app 都不再含目标 UI 文案。
- 回滚：恢复本轮源码改动并重新执行 `pnpm package:mac`，否则 packaged app 会继续保留当前新 UI。

## 2026-06-16 返修实施记录：修正顶部拖拽层被整列 no-drag 抵消

### 用户反馈与根因

- 用户反馈：重新去掉标题栏后，窗口顶部仍然无法拖动。
- 直接根因：上一轮虽然新增了 `window-drag-strip` 顶部透明拖拽层，但同时给 `.ai-sidebar`、`.ai-workspace`、`.context-inspector` 三个整列容器设置了 `-webkit-app-region: no-drag`。Electron 的命中区域合成会把这些大矩形从拖拽区域中扣掉，导致顶部透明层在三栏范围内被抵消。
- 运行态补充：当前仍有一个旧 Zeus 进程在运行，启动时间为 `2026-06-16 11:18:47 CST`；最新打包产物更新时间为 `2026-06-16 11:23:18 CST`。用户需要退出旧进程并重新打开最新 `/Users/david/hypha/zeus/dist/mac-arm64/Zeus.app` 才会加载新 CSS。

### 受影响目录

- `/Users/david/hypha/zeus/apps/desktop/src/renderer/styles.css`
  - 删除三栏整列级 `no-drag` 覆盖。
  - 保留 `.window-drag-strip` 的 `position: fixed; height: 56px; -webkit-app-region: drag`。
  - 仅对真实交互控件 `button/a/input/select/textarea/summary/label` 设置 `no-drag`，避免按钮、链接、表单被拖拽层吞掉。
- `/Users/david/hypha/zeus/apps/desktop/test/renderer.test.tsx`
  - 补强隐藏标题栏拖拽契约测试：禁止三栏整列级 `drag` 和 `no-drag` 同时回归，锁定“顶部透明层负责拖拽、控件单独退出拖拽”的结构。

### 契约变更

- 不新增后端 API。
- 不新增数据库表、字段、索引或迁移。
- 不新增第三方依赖。
- macOS 窗口交互契约：隐藏标题栏下，顶部 56px 透明区域是窗口拖拽区；整列内容容器不再声明 `no-drag`，只保护真实控件点击。

### 测试矩阵

| 层级 | 命令 / 证据 | 结果 |
|---|---|---|
| RED | `pnpm vitest run apps/desktop/test/renderer.test.tsx -t "hidden-titlebar top gutters" --reporter=verbose` | 先失败，命中三栏整列级 `-webkit-app-region: no-drag` 回归风险 |
| GREEN 聚焦 | `pnpm vitest run apps/desktop/test/renderer.test.tsx -t "hidden-titlebar top gutters" --reporter=verbose` | 1 个目标测试通过 |
| 回归与类型 | `pnpm vitest run apps/desktop/test/renderer.test.tsx scripts/package-mac.test.ts --reporter=verbose && npx tsc -p apps/desktop/tsconfig.json --noEmit --pretty false` | 2 个测试文件、66 个测试通过；desktop TypeScript 检查通过 |
| Renderer build | `pnpm --filter @zeus/desktop build` | 通过，生成 `apps/desktop/dist/renderer/assets/index-C2xKDCky.css` 等新产物 |
| macOS package | `pnpm package:mac` | 通过，更新 `/Users/david/hypha/zeus/dist/mac-arm64/Zeus.app`、DMG、ZIP |
| 反向搜索 | 源码、renderer dist、packaged asar 搜索被点名装饰文案 | 源码和 renderer dist 无残留；asar 中 `Preferences` 仅为 `webPreferences/projectPreferences` 代码标识，不是 UI 文案 |
| 打包健康 | `node scripts/verify-packaged-app-health.mjs dist/mac-arm64/Zeus.app` | `packaged-health=Zeus;rendererAssets=2;main=dist/main/main.js` |
| 运行进程检查 | `ps -p 36562 -o lstart=,etime=,args=` | 发现旧进程启动早于最新打包产物，必须重启 App 才能验收最新拖拽修复 |

### 实施顺序

1. 将“顶部仍无法拖动”拆成 Electron 命中区问题，而不是继续堆叠新的拖拽层。
2. 先补失败测试，证明三栏整列级 `no-drag` 会被测试捕获。
3. 删除整列 `no-drag`，只保留控件级 `no-drag`。
4. 运行聚焦测试、回归测试、类型检查。
5. 重新构建 renderer 并重新打包 macOS App，避免用户继续看到旧 bundle。
6. 检查当前运行中的 Zeus 进程启动时间，确认仍需退出旧进程再打开新产物。

### 风险与回滚

- 风险：本轮未强制关闭用户当前正在看的旧 Zeus 窗口，避免直接打断用户操作；因此最终真实拖拽手感需要在重新打开最新 App 后验收。
- 风险：Electron `-webkit-app-region` 的真实拖拽行为属于 macOS 窗口系统命中测试，自动化单元测试只能锁定 CSS/DOM 契约，不能完全替代人工鼠标拖动。
- 回滚：恢复三栏整列级 `no-drag` 或移除 `window-drag-strip` 会重新导致顶部拖拽不可用；若必须回滚，应同时恢复原生标题栏，否则窗口无可靠拖拽区。

## 2026-06-16 返修实施记录：运行中覆盖 asar 与手动拖窗兜底

### 用户反馈与根因

- 用户反馈：窗口仍然无法拖动；同时窗口显示了 `initial-scale=1.0`、`package.json` 等源码/包内容片段。
- 根因 1：打包时旧 Zeus 进程仍在运行，`app.asar` 被新包覆盖。运行中的 Electron 保留旧 asar 索引，却读取了新的 asar 内容，导致 renderer 入口被错位读取，窗口展示源码片段，CSS/JS 都无法可靠生效。
- 根因 2：即使 renderer 正常后，`-webkit-app-region: drag` 在当前 hiddenInset + file:// asar 运行形态下没有移动窗口；真实命中元素虽是 `.window-drag-strip`，但系统级坐标未变化。因此不能继续依赖 Electron 原生 app-region。
- 根因 3：`show:false` 只等待 `ready-to-show` 不够稳，某些 packaged 启动时窗口已可通过 CDP 访问但系统窗口未显示，需要 Main 进程显示兜底。

### 受影响目录

- `/Users/david/hypha/zeus/scripts/package-mac.mjs`
  - 新增运行中 `Zeus.app` 进程检查，防止打包时覆盖正在被旧进程使用的 `app.asar`。
  - 匹配逻辑只认真正以 `/Contents/MacOS/Zeus` 开头的进程，避免把 shell 命令文本误判为 Zeus 进程。
- `/Users/david/hypha/zeus/apps/desktop/src/main/main.ts`
  - 新增 `revealMainWindow` 与 `setTimeout(revealMainWindowOnce, 1200)`，避免 `ready-to-show` 未触发时主窗口隐藏。
  - 新增 `zeus:window-drag-start / move / end` IPC，Main 进程根据 renderer 传入的真实屏幕坐标执行 `BrowserWindow.setPosition(...)`。
- `/Users/david/hypha/zeus/apps/desktop/src/preload/index.cts`
  - 暴露 `beginWindowDrag / moveWindowDrag / endWindowDrag` 受控桥。
- `/Users/david/hypha/zeus/apps/desktop/src/renderer/App.tsx`
  - 顶部 `.window-drag-strip` 接管 `onPointerDown`，监听 pointermove/pointerup，并通过 preload 桥驱动 Main 移动窗口。
- `/Users/david/hypha/zeus/apps/desktop/src/renderer/styles.css`
  - 顶部条不再声明 `-webkit-app-region: drag`，避免吞掉 DOM pointer 事件；该区域改为手动拖窗命中层。
- `/Users/david/hypha/zeus/apps/desktop/src/renderer/global.d.ts`
  - 补充窗口拖拽桥类型。
- `/Users/david/hypha/zeus/apps/desktop/test/renderer.test.tsx`、`/Users/david/hypha/zeus/scripts/package-mac.test.ts`
  - 补充运行中打包保护、ready-to-show 兜底、手动拖窗桥、顶部条事件契约测试。

### 契约变更

- 不新增后端 API。
- 不新增数据库表、字段、索引或迁移。
- 不新增第三方依赖。
- Electron Main/Renderer 本地桥契约新增：只允许 renderer 发送当前鼠标屏幕坐标给 Main 进程移动当前窗口；不暴露任意窗口管理能力。
- macOS 打包契约新增：打包前必须没有当前 `dist/mac-arm64/Zeus.app` 的运行进程，否则中止并提示先退出，避免生成“源码片段窗口”。

### 测试矩阵

| 层级 | 命令 / 证据 | 结果 |
|---|---|---|
| RED：运行中打包保护 | `pnpm vitest run scripts/package-mac.test.ts -t "refuses to overwrite" --reporter=verbose` | 先失败，缺少运行中 App 检查 |
| RED：窗口显示兜底 | `pnpm vitest run scripts/package-mac.test.ts -t "shows the packaged macOS main window" --reporter=verbose` | 先失败，缺少 `revealMainWindow` 与兜底显示 |
| RED：手动拖窗桥 | `pnpm vitest run apps/desktop/test/renderer.test.tsx scripts/package-mac.test.ts -t "hidden-titlebar top gutters\|manual macOS window drag bridge" --reporter=verbose` | 先失败，缺少 Renderer pointer 事件和 Main/preload 拖窗 IPC |
| GREEN 聚焦 | 同上聚焦测试 | 通过 |
| 回归与类型 | `pnpm vitest run apps/desktop/test/renderer.test.tsx scripts/package-mac.test.ts --reporter=verbose && npx tsc -p apps/desktop/tsconfig.json --noEmit --pretty false` | 2 个测试文件、70 个测试通过；desktop TypeScript 检查通过 |
| macOS package | `pnpm package:mac` | 通过，更新 `/Users/david/hypha/zeus/dist/mac-arm64/Zeus.app`、DMG、ZIP |
| 打包健康 | `node scripts/verify-packaged-app-health.mjs dist/mac-arm64/Zeus.app` | `packaged-health=Zeus;rendererAssets=2;main=dist/main/main.js` |
| 正常渲染 | CDP 读取新包 DOM | `shell=true`，body text 为真实 Zeus UI，不再是源码/包内容片段 |
| 顶部命中 | CDP `elementFromPoint(360,24)` | 命中 `.window-drag-strip`，`pointer-events=auto`，`app-region=none` |
| 拖窗链路 | CDP `Input.dispatchMouseEvent` 从顶部条拖动 | 窗口坐标从 `532,182` 移动到 `652,252`，证明 Main/preload/Renderer 手动拖窗链路可移动窗口 |
| 普通实例 | 退出调试端口实例后 `open -n /Users/david/hypha/zeus/dist/mac-arm64/Zeus.app` | 普通实例 PID `58665`，窗口 on-screen，bounds `532,182,1240,820` |

### 实施顺序

1. 先确认源码片段窗口不是 UI 问题，而是运行中覆盖 `app.asar` 导致旧索引读新包。
2. 给打包脚本加运行中 App 防护，并修复 shell 命令误判。
3. 给 Main 窗口显示增加 `ready-to-show` 兜底，避免只剩后台进程。
4. 验证 native app-region 实际不移动窗口后，改为 Renderer pointer 事件 + preload IPC + Main `setPosition` 手动拖窗。
5. 重新构建和打包，使用 CDP 与 CoreGraphics 窗口坐标验证真实 UI 与窗口移动。
6. 关闭带调试端口实例，重新打开普通 Zeus 实例供用户继续验收。

### 风险与回滚

- 风险：终端发出的 Swift/CGEvent 系统鼠标事件在当前环境未移动窗口，疑似缺少辅助功能鼠标控制权限；因此最终拖窗验证使用 CDP 输入事件触发真实 renderer pointer 链路，并用 CoreGraphics 坐标确认窗口移动。
- 风险：手动拖窗依赖 renderer 能收到 pointer 事件；因此顶部条不再使用 `-webkit-app-region: drag`，避免吞事件。
- 回滚：若回滚手动拖窗 IPC，必须恢复可靠原生标题栏或其他可拖区域；否则 hidden titlebar 下会再次无法拖动。
