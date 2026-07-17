# TASK_20260701_010 Zeus Settings A 参考图细化稿

## 本轮输入

用户提供了一张设置页参考图，希望 Settings 页参考该结构继续设计。参考图已复制到：

`/Users/david/hypha/zeus/docs/artifacts/TASK_20260701_010_reference/reference-settings-page.png`

前一轮先更新设计稿和任务文档；用户确认后，本轮已继续把该结构落到 Zeus 应用源码。

## 转译原则

- 借鉴结构，不复制品牌：参考图的左侧设置分类、搜索、居中内容列、模式卡片、连续行组和滚动节奏可以转译到 Zeus。
- 不复制具体产品名、品牌资产、图标资产或不属于 Zeus 的功能。
- Zeus 保持本地优先、安全审计、真实配置状态和无假数据边界。

## 更新后的设计方向

Settings A 从上一版“项目 source-list + 设置分类栏”调整为“设置专属 shell”：

1. 左侧为设置专属侧栏：返回应用、搜索、分组导航。
2. 右侧为居中约 680px 内容列。
3. 首屏包含工作模式、权限、常规三个行组。
4. 集成、编码、维护分类保留 AI CLI / Runtime、Telegram、浏览器、电脑操控、代码图谱、Git、环境、工作树、缓存与数据等 Zeus 语义。
5. 设置行使用连续 group surface 和行分隔，不做独立卡片堆叠。
6. 脏状态保存条继续保留，说明只写入本机偏好。

## 状态与可访问性

- 必备状态：默认、loading、empty、error、permission denied、external wait。
- 设置分类使用 `role="tablist"`，分类项使用 `role="tab"`，内容区使用 `role="tabpanel"`。
- 采用 roving tabindex，当前项 `tabIndex=0`，其他项 `tabIndex=-1`。
- 桌面纵向分类支持 ↑/↓/Home/End；390px 窄屏折叠为顶部分类选择。
- 开关、分段和下拉必须有清晰名称、角色和值。
- 保存条使用 `role="status"` 和 `aria-live="polite"`。
- reduced-motion 下取消非必要动效。

## 实现建议与当前状态

1. Settings 独立 shell 与“返回应用”已进入源码。
2. 常规、权限、工作模式行组已进入源码。
3. 设置行继续沿用 `NativeSettingsPane` / `NativeControlRow`，避免重新引入卡片堆叠。
4. 设置搜索入口与键盘导航 UI 已落地；真实搜索过滤和完整焦点恢复可作为后续切片。
5. 已用测试反向固化旧 `settings-category-*`、卡片堆叠、dashboard 式 summary 等残留不回归。

## 交付文件

- HTML：`/Users/david/hypha/zeus/docs/TASK_20260701_010_ZeusSettingsA详细设计稿.html`
- Markdown：`/Users/david/hypha/zeus/docs/TASK_20260701_010_ZeusSettingsA详细设计稿.md`

## 2026-07-01 源码实现记录

用户确认“先改这个设置页”后，本轮已把 Settings A 参考图结构落到 Zeus 源码。

### 修改范围

- `apps/desktop/src/renderer/App.tsx`
  - 全局 Settings 页改为 `settings-reference-shell`：左侧设置专属栏 + 右侧居中内容列。
  - 左侧包含返回应用、设置搜索入口、个人/集成/编码/维护分组导航。
  - 设置分组导航使用 `role="tablist"`、纵向 `aria-orientation="vertical"`、`data-inline-rail-keyboard="vertical"` 与 roving tabindex。
  - 通用首屏新增工作模式与权限分组；沿用真实本机偏好，不伪造外部配置成功态。
- `apps/desktop/src/renderer/styles.css`
  - 新增 `Settings reference shell 最终覆盖`：左栏 210-236px，右侧内容列 680px，参考图式连续设置行与模式选择块。
  - 保持 Zeus macOS 产品 UI：克制中性色、低噪音 source-list、可访问 focus 与窄屏折叠。
- `apps/desktop/test/app-shell-layout.test.tsx`
  - 用测试固化 Settings 参考 shell、分组侧栏、居中内容列、纵向键盘导航和英文无中文泄漏。
- `docs/superpowers/plans/2026-07-01-settings-reference-shell.md`
  - 记录本轮 TDD 落地计划。

### 验证结果

- `pnpm vitest run apps/desktop/test/app-shell-layout.test.tsx -t "reference-style settings shell"`：通过，1 passed / 170 skipped。
- `pnpm vitest run apps/desktop/test/app-shell-layout.test.tsx -t "settings|Settings|global general settings"`：通过，31 passed / 140 skipped。
- `pnpm vitest run apps/desktop/test/app-shell-layout.test.tsx`：通过，171 passed。
- `pnpm typecheck`：通过。
- 打包前检查 packaged Zeus.app 运行进程：未发现运行中的 `/dist/mac-arm64/Zeus.app/Contents/MacOS/Zeus` 或 `/dist/mac/Zeus.app/Contents/MacOS/Zeus`。
- `pnpm package:mac`：通过，生成并 ad-hoc codesign 验证 `/Users/david/hypha/zeus/dist/mac-arm64/Zeus.app`。

### 剩余建议

- 本轮实现全局 Settings 壳层与通用首屏；Runtime、Telegram、安全、Git、发布、缓存等深层子页仍可继续按同一结构做逐页细化。
- 设置搜索入口当前先作为 UI 入口落地；若要真正搜索过滤设置项，需要下一轮补索引、筛选结果和键盘焦点恢复测试。

## 2026-07-01 Settings 视觉回归修复记录

用户在 packaged Zeus.app 的 Settings 页目视验收时指出多个混乱问题，本轮按视觉回归处理。

### 现象

1. Settings 页仍与项目 source-list 同屏显示，形成“项目侧栏 + 设置侧栏”的双侧栏结构，偏离参考图的独立设置页。
2. Runtime、Telegram、安全、Git、缓存与数据等深层设置行的说明列被控件列挤压，中文标题出现竖排/断行。
3. 深层设置页内容密度过高，按钮组和输入框挤压首列，影响可读性。

### 根因

- `apps/desktop/src/renderer/App.tsx` 主壳层在 `activeNavTarget === 'settings'` 时仍无条件渲染 `SidebarNav`，导致 Settings 专属侧栏被嵌在项目 source-list 右侧。
- `apps/desktop/src/renderer/styles.css` 中深层设置行继承 `minmax(0, 1fr) minmax(220px, 380px) auto`，在有效宽度被双侧栏压缩后，首列可缩到接近 0，中文标题被挤成竖排。

### 本轮修改

- `apps/desktop/src/renderer/App.tsx`
  - Settings 目标页为 `<main>` 增加 `settings-dedicated-shell`。
  - 当 `activeNavTarget === 'settings'` 时不再渲染项目 `SidebarNav`，Settings 使用独立偏好页结构。
- `apps/desktop/src/renderer/styles.css`
  - 新增 `Settings dedicated shell 视觉回归修复`：独立 Settings 页根布局改为单列。
  - 新增 `Settings deep row readability 最终覆盖`：深层设置页内容列扩展到 780px，并为深层行固定说明列最小宽度，避免中文标题竖排。
  - 深层设置按钮 rail 固定为不换行，窄屏下再降级为单列可读布局。
- `apps/desktop/test/app-shell-layout.test.tsx`
  - 新增回归测试：Settings 页不再渲染 `project-first-sidebar`。
  - 新增回归测试：深层设置行必须具备可读列宽覆盖，不再允许说明列被挤压。

### 验证结果

- RED：`pnpm vitest run apps/desktop/test/app-shell-layout.test.tsx -t "dedicated preferences page|deep settings rows readable"` 先失败，证明确实缺少独立壳层和深层行可读覆盖。
- GREEN：同一 focused 测试通过，2 passed / 171 skipped。
- `pnpm vitest run apps/desktop/test/app-shell-layout.test.tsx -t "settings|Settings|global general settings"`：通过，33 passed / 140 skipped。
- `pnpm vitest run apps/desktop/test/app-shell-layout.test.tsx`：通过，173 passed。
- `pnpm typecheck`：通过。
- 打包前发现运行中的 packaged Zeus.app 进程并已退出；随后 `pnpm package:mac`：通过，`/Users/david/hypha/zeus/dist/mac-arm64/Zeus.app` 重新生成并通过本地签名校验。

### 待用户目视验收

请重新打开 packaged Zeus.app 的 Settings 页，重点看：

1. Settings 是否只显示设置专属侧栏，不再出现项目 source-list 双侧栏。
2. Runtime、Telegram、安全、Git、缓存与数据页标题是否恢复横向可读，不再竖排。
3. 780px 深层内容列是否比上一版更接近参考设置页的阅读节奏。

## 2026-07-01 Settings 全页控件视觉回归修复记录

用户继续目视验收 packaged Zeus.app 后指出所有 Settings 子页仍存在按钮、输入框、文案和按钮边线问题；本轮按全页控件视觉回归修复，而不是逐页单点微调。

### 用户反馈

1. 按钮和字体仍没有设计稿里的 macOS 设置页质感。
2. 按钮和输入框高度没对齐，部分控件仍互相覆盖。
3. 文案仍存在覆盖或挤压。
4. 按钮顶部边缘线仍有不完整展示。

### 根因

- `apps/desktop/src/renderer/App.tsx` 的 `NativeControlRow` 已提供标题与说明结构，但 `apps/desktop/src/renderer/styles.css` 没有在 Settings 作用域内把 `.native-control-copy` 固化成两行 grid，标题和说明仍可能按内联文本节奏挤压。
- `apps/desktop/src/renderer/styles.css` 中 `.settings-row-field .zeus-select-trigger` 的旧高度为 38px，而输入框和按钮使用 28px 左右的紧凑控件高度，导致同一行内控件高度不一致。
- 深层行里的 `.settings-row-action-rail` / `.release-update-command-rail` 仍保留父级边框和 padding，按钮外再包一层 rail 边框，行分割线容易贴到按钮上缘，视觉上像按钮顶部边线被裁切。
- 发布更新的三条嵌套行没有完全继承上一轮 deep row 的三列可读布局，部分行仍可能压缩说明列或动作列。

### 本轮修改

- `apps/desktop/src/renderer/styles.css`
  - 新增 `Settings row control polish 最终覆盖`：Settings 作用域统一 28px 控件高度、12/13px SF 字级、标题/说明两行 grid 和 `box-sizing: border-box`。
  - 新增 Settings 专属按钮质感：按钮、链接式按钮和保存按钮统一线性浅灰面、1px 完整边框、内高光和低噪音阴影；危险按钮保留红色风险语义。
  - 新增 `Settings release row polish 最终覆盖`：Git、Runtime、发布、缓存等动作 rail 去掉父级边框/padding，把按钮从行分割线上“抬起”，避免顶部边线被压住。
  - 发布更新三行统一三列布局：说明列、状态/字段列、动作列，避免发布页控件重新挤压文案。
  - 补齐 Settings reference shell 使用到的产品 token，并修正多行 Settings 选择器，避免 renderer CSS 反回归测试误判为 dangling selector。
- `apps/desktop/test/app-shell-layout.test.tsx`
  - 新增/更新回归测试：控件统一 28px、高度对齐、标题说明防覆盖、按钮边线不被 rail/行分割线压住。
- `apps/desktop/test/renderer.test.tsx`
  - 更新 Settings 导航测试为当前已确认的“设置专属侧栏 + 垂直 tablist”口径。
  - 保持全局 CSS token 完整性和无 dangling Settings selector 门禁。

### 验证结果

- RED：`pnpm vitest run apps/desktop/test/app-shell-layout.test.tsx -t "polished settings control vocabulary"` 先失败，确认缺少 Settings 专属按钮质感覆盖。
- GREEN：`pnpm vitest run apps/desktop/test/app-shell-layout.test.tsx -t "polished settings control vocabulary|release update and deep settings action rows|deep settings rows readable"`：通过，3 passed / 172 skipped。
- `pnpm vitest run apps/desktop/test/app-shell-layout.test.tsx -t "settings|Settings|global Release|global Git|global Security|global runtime|global Data"`：通过，35 passed / 140 skipped。
- `pnpm vitest run apps/desktop/test/app-shell-layout.test.tsx`：通过，175 passed。
- `pnpm vitest run apps/desktop/test/renderer.test.tsx -t "global settings section navigation|defines every product CSS token|removes rgba and dangling"`：通过，3 passed / 68 skipped。
- `pnpm test`：通过，66 files / 1000 tests passed。
- `pnpm typecheck`：通过。
- 打包前检查 packaged Zeus.app 运行进程：未发现运行中的 `/dist/mac-arm64/Zeus.app/Contents/MacOS/Zeus` 或 `/dist/mac/Zeus.app/Contents/MacOS/Zeus`。
- `pnpm package:mac`：通过，`/Users/david/hypha/zeus/dist/mac-arm64/Zeus.app` 已重新生成，本地签名校验通过。

### 待用户目视验收

请重新打开 `/Users/david/hypha/zeus/dist/mac-arm64/Zeus.app` 的 Settings 页，重点看：

1. 通用 / 安全 / Runtime / Telegram / Git / 发布 / 缓存页的按钮是否统一为更轻的 macOS 设置页质感。
2. 输入框、下拉框、按钮是否同高对齐，不再互相覆盖。
3. 标题与说明是否稳定两行显示，不再叠字或被控件挤压。
4. 按钮顶部边缘线是否完整可见，不再被父级 rail 或行分割线压住。
