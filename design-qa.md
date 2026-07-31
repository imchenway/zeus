# Zeus 会话列表与审批样式设计验收

## 验收范围

- 参考图：`codex-clipboard-91fc3e9a-1603-48da-a580-f2092ba9d9d9.png`、
  `codex-clipboard-c2efa884-2975-4e7b-a6e4-0eacb4827ddd.png`、`codex-clipboard-f7c40e26-5276-4c78-aa00-386300113583.png`、
  `codex-clipboard-a4e8a229-5518-4829-ab0d-1dbe7d85e515.png`。
- 实现面：项目文件夹与新建入口、扁平会话标题、运行/等待批准/需要用户输入/完成未读状态、命令与文件审批面板。
- 视口：桌面 `1600 × 1200`、窄屏 `900 × 1200`，DPR 1。
- 验收载体：真实 React 组件和正式样式表；对照页只提供固定数据和同屏排版。

## 对照证据

- 同屏参考与实现：`docs/evidence/session-styles-comparison-final.png`
- 会话列表聚焦：`docs/evidence/session-conversation-list-implementation.png`
- 审批面板聚焦：`docs/evidence/session-approval-implementation.png`
- 窄屏回归：`docs/evidence/session-styles-responsive.png`

## 迭代记录

1. 初次浏览器验收发现审批菜单和任务菜单的 `hidden` 属性被组件 `display: grid` 样式覆盖，已为两类菜单补充
   `[hidden] { display: none; }`。
2. 初次窄屏验收发现对照壳层存在横向溢出，已收紧 QA 壳层的尺寸与单列布局；正式组件保持自适应。
3. 复验确认审批与任务菜单均可用 Escape 关闭并把焦点归还触发按钮，方向键可在授权项间移动，页面控制台无 error 或 warning。
4. 完成未读蓝点只在后台成功响应后显示；选中、运行中、失败和中断状态不会误显示。

## 结论与边界

- 参考图中的目录层级、标题密度、绿色/蓝色胶囊、旋转圆环、完成未读蓝点和紧凑审批菜单均已对齐。
- 组件级视觉与键盘交互验收通过；由于验收时 macOS 处于锁屏状态，本轮未补拍打包应用窗口截图，正式包构建结果单独由构建命令证明。
- 控制台 error：0；warning：0；桌面与窄屏横向溢出：0。

final result: passed

# 2026-07-30 应用菜单检查更新弹窗验收

## 对比目标

- 来源视觉：用户提供的 macOS Zeus 应用菜单截图，要求 `Check for Updates...` 直接检查并显示用户决策弹窗；
- 正式包：`/Users/david/hypha/zeus/dist/mac-arm64/Zeus.app`，版本 `0.1.2`；
- 结果截图：
  `/var/folders/2m/dswmfzbd7wx_39zxs4kvd3fc0000gn/T/com.openai.sky.CUAService/Zeus Screenshot 2026-07-30 at 3.51.35 PM.jpeg`。

## Findings

- [x] 菜单点击不再跳转设置页，真实显示“正在检查更新”；
- [x] 远端检查完成后原位切换为结果弹窗；
- [x] 结果弹窗显示当前版本 `0.1.2`、公开清单版本 `0.1.1` 和真实匹配 DMG；
- [x] `Command+U` 触发同一链路；
- [x] 主动作获得初始焦点，弹窗使用 `role=dialog`、`aria-modal=true`；
- [x] 正式包辅助功能树标记“已遵循减少动态效果”；
- [x] 验收载体为仓库 `dist/mac-arm64/Zeus.app`，不依赖 `/Applications/Zeus.app`；
- [ ] 当前公开清单没有更高版本，“发现更新 / 打开下载页”尚未完成真实远端验收；
- [ ] 深色模式和增强对比度尚未覆盖。

## 验收边界

- 现有公开产物未同时签名和公证，因此本轮没有执行自动替换 App；
- 下载和安装 API 仍会真实拒绝，弹窗会显示拒绝原因，不宣称自动升级已经可用；
- 完整静态与发布门禁结果以
  `docs/TASK_20260730_003_应用菜单检查更新弹窗.md` 为准。

final result: partially passed

# 2026-07-29 任务空状态与深色表头返修验收

## 问题与根因

- 用户指出“还没有任务”区域与任务页颜色不统一；原实现最后层覆盖把空态重新绘制成白色面板并加大阴影。
- 用户在深色主题继续指出任务表头呈红色。该颜色不是任务、错误或危险状态，而是
  `color-mix(in oklch, 中性灰, transparent)` 在 Chromium 中产生的透明端色相污染。

## 修复

- 空任务状态改为透明背景并移除阴影，直接透出任务页统一画布。
- 深色表头改为在 sRGB 中混合 `--zeus-product-panel-muted` 与 `--zeus-product-canvas` 两个不透明中性色。
- 顶部“新任务”继续是唯一主操作；真实零任务时不新增重复按钮或卡片。

## 真实窗口证据

- 浅色最大窗口：`/tmp/zeus-task-empty-light-20260729.png`
- 深色表头修复后：`/tmp/zeus-task-empty-dark-fixed-20260729.png`
- 深色窄窗口：`/tmp/zeus-task-empty-dark-narrow-20260729.png`
- 浅色窄窗口：`/tmp/zeus-task-empty-light-narrow-20260729.png`
- 跟随系统窄窗口：`/tmp/zeus-task-empty-system-narrow-20260729.png`
- 搜索输入交互：`/tmp/zeus-task-empty-filtered-system-narrow-20260729.png`

真实 Electron 使用隔离数据目录 `/tmp/zeus-project-entry-qa.PH9WS5/user-data`。最大窗口与
`1060 × 820` 窄窗口均已检查；浅色、深色和跟随系统主题均无白色横条、暖红表头、重叠或裁切。
搜索框可以输入并清空，零任务事实保持不变。运行日志只有隔离环境设置登录项失败的既有权限提示，没有
Renderer 或本地服务错误。

## Findings

- 当前没有遗留的 `P0`、`P1` 或 `P2` 视觉问题。
- 窄窗口中任务表格按既有设计保留横向滚动，不属于本次空态视觉回归。

final result: passed

# 2026-07-23 项目配置右侧留白与任务搜索最终纠错验收

## 结论纠正

- 上一节“全宽输入、选择和文本域右侧留白正常”的结论已被用户提供的正式 App 截图推翻，不再作为当前验收结论。
- 本轮已从共享 `WorkspaceDrawer` 内容层的盒模型根因修复右侧裁切，并同步移除任务工具栏摘要、将收窄后的搜索框置于最左侧且文本居中。
- `pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm package:mac`、`git diff --check` 与正式包严格签名校验已经通过；这些结果只证明静态检查、构建和打包，不证明真实界面效果。
- macOS 当前仍处于锁屏状态，正式 App 无法启动并复验项目配置、任务创建、任务详情、设置、重命名及任务搜索布局；解锁并完成逐页截图验收前，状态保持阻塞。

final result: blocked

# 2026-07-29 新增项目入口与单目录创建最终验收

## 参考与实现证据

- 项目侧栏参考：
  `/var/folders/2m/dswmfzbd7wx_39zxs4kvd3fc0000gn/T/codex-clipboard-6f598b90-c994-470a-8111-01e443c04ed6.png`
- 创建项目参考：
  `/var/folders/2m/dswmfzbd7wx_39zxs4kvd3fc0000gn/T/codex-clipboard-18fc2c6f-ceff-4f13-9542-78cb9b58a6e6.png`
- 用户否定的旧侧栏空态：
  `/var/folders/2m/dswmfzbd7wx_39zxs4kvd3fc0000gn/T/codex-clipboard-1f6de17c-2a01-478e-b8b9-c88b51c23252.png`
- Zeus 零项目侧栏：
  `/var/folders/2m/dswmfzbd7wx_39zxs4kvd3fc0000gn/T/com.openai.sky.CUAService/Zeus Screenshot 2026-07-29 at 4.05.51 PM.jpeg`
- Zeus 空创建弹窗：
  `/var/folders/2m/dswmfzbd7wx_39zxs4kvd3fc0000gn/T/com.openai.sky.CUAService/Zeus Screenshot 2026-07-29 at 4.06.00 PM.jpeg`
- Zeus 已选目录弹窗：
  `/var/folders/2m/dswmfzbd7wx_39zxs4kvd3fc0000gn/T/com.openai.sky.CUAService/Zeus Screenshot 2026-07-29 at 4.10.06 PM.jpeg`
- Zeus 创建成功并自动切换：
  `/var/folders/2m/dswmfzbd7wx_39zxs4kvd3fc0000gn/T/com.openai.sky.CUAService/Zeus Screenshot 2026-07-29 at 4.10.16 PM.jpeg`

Codex 创建项目参考为 `1718 × 962`、`144dpi`，按高密度来源折算约为 `859 × 481` 逻辑像素；Zeus Computer Use 截图为 `1226 × 768`、`72dpi`，真实窗口恢复边界为 `1728 × 1083`，截图服务做了等比下采样。两者外围工作区并非同一产品页面，因此不以全窗口绝对坐标评价；同一比较输入中按弹窗内容区和侧栏分组做聚焦对照。Zeus 弹窗正式 CSS 宽度为 `540px`，输入框高度为 `44px`，未选目录区最小高度为 `112px`，与 Codex 高密度参考折算后的组件尺度接近。

## 状态与同屏比较

- 主题：浅色、简体中文、正式打包 Electron。
- 空状态：零项目侧栏只保留“项目”标题和右侧加号，不再渲染重复文案卡片。
- 表单状态：空表单、已编辑项目名、已选单目录、创建成功均有真实窗口证据。
- 完整参考与实现已放入同一视觉比较输入；创建弹窗的名称输入、目录选择区和底部动作可清楚辨认，因此无需再做局部裁切。

## 迭代历史

1. 初始实现沿用了旧的零项目侧栏恢复卡片，形成“大边框卡片内再套同文案按钮”的重复层级。用户明确否定该视觉，按 `P2` 处理。
2. 修复删除侧栏恢复卡片；创建入口统一由“项目”标题右侧加号承担。复验截图确认边框套边框、重复标题和重复按钮全部消失。
3. 修复后重新执行打包与真实 Electron 交互；不存在遗留 `P0`、`P1` 或 `P2` 视觉问题。

## 必查视觉面

- 字体与排版：沿用 Zeus/macOS 系统字体；弹窗标题、字段标签、输入值和辅助路径形成四级层级，无异常换行或裁切。
- 间距与布局：标题、名称输入、目录区和底部动作保持单列节奏；侧栏加号与“项目”标题同一基线，零项目时不再出现抢占列表空间的卡片。
- 颜色与 token：表面、遮罩、边框、焦点和禁用态全部使用 Zeus 语义 token。主按钮保留 Zeus 蓝色动作语义，没有机械复制 Codex 黑色按钮。
- 图像与资产：本界面没有图片素材；文件夹、添加目录、关闭和加号均使用现有 Phosphor 图标库，没有手工 SVG、字符图标或占位图。
- 文案与内容：参考中的多目录文案按用户确认的单目录边界改为“项目目录”；项目名称默认取目录名但允许编辑，中英文文案完整。

## 交互与运行结果

1. 已有项目时加号仍可打开创建弹窗，证明不是零项目专用入口。
2. 弹窗首次打开后焦点位于项目名称；未选目录时创建按钮禁用。
3. 名称编辑为 `Parent Workspace` 后选择
   `/private/tmp/zeus-project-entry-qa.PH9WS5/SampleWorkspace`，名称保持不变，目录路径完整显示。
4. 创建后侧栏出现第二个项目并自动选中 `Parent Workspace`；隔离数据库中的名称和路径与界面一致。
5. `Shift+Tab` 焦点循环可到达底部取消按钮；`Escape` 关闭后焦点返回侧栏加号。
6. 交互期间应用进程没有 renderer 或本地服务错误；启动时的登录项权限提示来自隔离打包运行环境，不影响本次创建路径。

## Findings

- 当前没有可执行的 `P0`、`P1` 或 `P2` 差异。
- Codex 参考与 Zeus 的外围页面、主按钮品牌色和单/多目录语义不同，均属于明确的产品边界，不是未修复漂移。

## Open Questions

- 无阻塞问题。多目录能力不属于本次范围。

## Implementation Checklist

- [x] 删除重复侧栏空态。
- [x] 保留标题栏真实加号入口。
- [x] 完成单目录表单与真实目录选择。
- [x] 完成创建、刷新和自动切换。
- [x] 完成键盘焦点闭环。
- [x] 完成参考与正式包截图同屏复核。

## Follow-up Polish

- 当前无必须跟进的视觉修正；后续只有在引入多目录时才需要重做目录列表密度和排序交互。

final result: passed

# 2026-07-23 项目配置右侧留白纠错验收

## 纠错

- 上一节第 2 条把“控件自身使用 `border-box`”错误等同于“抽屉内容右侧留白正常”；用户提供的正式 App 截图已经证明项目配置整列控件仍贴住抽屉右边缘，该结论作废。
- 根因是共享 `.workspace-drawer-content` 以 `content-box` 计算 `inline-size: 100%`，项目抽屉的左右 padding 被叠加到 100% 之外，再由 `overflow-x: hidden` 裁掉右侧。

## 本轮实现与静态证据

- `WorkspaceDrawer` 内容滚动层及其直接业务内容已统一为 `border-box`，修复作用于项目设置、任务详情和其他共享抽屉，不对单个输入框逐项打补丁。
- 任务页已移除项目名、任务计数与全部状态摘要；搜索框移动到第一行最左侧，最大宽度 `280px`，占位文案水平居中。
- `pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm package:mac`、`git diff --check` 与严格签名校验通过。
- 正式包反向确认包含 `box-sizing:border-box`、`max-inline-size:280px`、居中搜索文本与新的三列工具区布局。

## 待补真实窗口

- 打包完成后 macOS 处于锁屏状态，Computer Use 无法启动正式 App；项目配置右侧留白、任务页搜索位置及其他表单页面尚未进行本轮真实窗口复验。
- 在用户解锁前，本轮不得把静态检查、打包或包内 CSS 反查描述成视觉验收通过。

final result: blocked

# 2026-07-26 Codex 内置浏览器右侧分栏与页面批注最终验收

## 验收范围

- 当前会话、输入框与右侧浏览器的默认空间关系；
- 浏览器普通导航、零草稿注释态、一条草稿完整注释栏三种状态；
- 元素目标轮廓、点击点、横向评论条和保存后的编号标记；
- 浏览器发送按钮与数量、展开/恢复、恢复默认宽度和关闭控制；
- 分隔条鼠标拖动、键盘调整与辅助功能语义；
- 正式 macOS 包、唯一 Zeus 实例，窗口视口 `1399 × 769`。

## 参考与同屏输入

- 当前 Codex App 会话/浏览器分栏：用户在本任务中提供的截图；
- Codex 批注录像：`/Users/david/Downloads/iShot_2026-07-25_16.34.44.mp4`；
- Codex 一条批注完整工具栏：`/tmp/codex-browser-reference-20260726/frame-020.jpg`；
- Zeus 正式包左右分栏：`/tmp/codex-parity-audit-20260726/zeus-side-by-side.jpeg`；
- Zeus 正式包一条批注展开态：`/tmp/codex-parity-audit-20260726/zeus-expanded-annotation.jpeg`；
- 浏览器 chrome 同屏比较：`/tmp/codex-parity-audit-20260726/annotation-chrome-comparison.png`。

参考录像为 `2634 × 2522`，正式 Zeus 窗口为 `1399 × 769`。同屏比较对“已保存一条批注”的顶部浏览器 chrome 做等宽归一化；页面正文不属于同一内容，未用正文缩放差异评价浏览器 chrome。

## 可观察结果

1. 正式包中会话记录和输入框持续位于左侧，浏览器位于右侧；辅助功能树同时存在四个对象，不再出现浏览器替换会话的 P0 偏差。
2. 浏览器标签、居中地址、浅蓝注释态、左侧退出/清空、右侧定位/列表、独立发送按钮和独立数量胶囊与 Codex 录像中的状态层级一致。
3. 零草稿时保留普通导航并只展开浅蓝 `正在批注` 胶囊；保存首条草稿后才进入完整浅蓝批注栏，状态切换顺序一致。
4. 元素轮廓保留目标圆角，评论条位于点击点附近，保存后的蓝色编号落在实际点击位置，不再使用元素中心近似。
5. 分隔条默认值为 `56`，键盘调整真实完成 `56 → 58 → 56`；正式包 DevTools 输入真实完成鼠标拖动 `56 → 66 → 56`。
6. 展开后浏览器占满当前会话详情区域，恢复后重新显示会话与输入框；项目导航与会话列表持续存在，符合本轮用户明确要求的会话内工作面边界。
7. 视觉复核未发现浏览器遮挡输入框、错误圆角、工具栏裁切、地址溢出、页面横向溢出或批注编号错位。
8. 验收结束时普通正式 Zeus 只有一个实例，调试端口关闭，界面保留在默认 `56%` 左右分栏。

## 边界

- “对齐”指当前 Codex App 版本能够从用户截图、参考录像和官方说明观察到的界面与交互状态，不宣称复制 Codex 未公开源码或内部私有协议。
- 窄于 `840px` 的会话内容区域主动切换为浏览器优先单面布局，这是避免双栏不可用的响应式回退，不适用于本轮桌面截图验收。

final result: passed

# 2026-07-23 项目菜单、表单与任务表格控制行设计验收

## 验收范围

- 项目“更多”菜单的位置、密度、图标、hover 语义，以及 Finder 定位和重命名入口。
- 重命名、任务创建、任务详情和设置表单的纯色表面、边缘留白与全宽控件盒模型。
- 重命名保存/取消、任务创建创建/取消的动作尺寸。
- 任务表格状态筛选与批量、列、更多动作的两行布局。
- 正式打包应用视口：`1226 × 768`。

## 参考与同屏对照

- 项目菜单参考：`/var/folders/2m/dswmfzbd7wx_39zxs4kvd3fc0000gn/T/codex-clipboard-e594738d-c74f-4a75-ba0f-d1484f61ed28.png`。
- 重命名表单参考：`/var/folders/2m/dswmfzbd7wx_39zxs4kvd3fc0000gn/T/codex-clipboard-366468a7-a48e-432f-90cf-febdf2bec989.png`。
- 任务表格控制参考：`/var/folders/2m/dswmfzbd7wx_39zxs4kvd3fc0000gn/T/codex-clipboard-0140177a-ba2e-4e68-8aff-3589c0e0176b.png`。
- 正式包任务列表：`/var/folders/2m/dswmfzbd7wx_39zxs4kvd3fc0000gn/T/com.openai.sky.CUAService/Zeus Screenshot 2026-07-23 at 5.53.19 PM.jpeg`。
- 正式包任务创建：`/var/folders/2m/dswmfzbd7wx_39zxs4kvd3fc0000gn/T/com.openai.sky.CUAService/Zeus Screenshot 2026-07-23 at 5.53.37 PM.jpeg`。
- 正式包项目菜单：`/var/folders/2m/dswmfzbd7wx_39zxs4kvd3fc0000gn/T/com.openai.sky.CUAService/Zeus Screenshot 2026-07-23 at 5.53.59 PM.jpeg`。
- 正式包重命名：`/var/folders/2m/dswmfzbd7wx_39zxs4kvd3fc0000gn/T/com.openai.sky.CUAService/Zeus Screenshot 2026-07-23 at 5.54.22 PM.jpeg`。
- 正式包任务详情：`/var/folders/2m/dswmfzbd7wx_39zxs4kvd3fc0000gn/T/com.openai.sky.CUAService/Zeus Screenshot 2026-07-23 at 5.54.54 PM.jpeg`。
- 正式包全局设置：`/var/folders/2m/dswmfzbd7wx_39zxs4kvd3fc0000gn/T/com.openai.sky.CUAService/Zeus Screenshot 2026-07-23 at 5.55.09 PM.jpeg`。
- 重命名参考和正式包、任务控制参考和正式包分别在同一视觉比较输入中复核。

## 验收结果

1. 项目菜单提升到应用壳层后位于“更多”按钮右侧并顶部对齐，没有被侧栏裁剪；`208px` 宽、`12px` 圆角、`6px` 内边距和 `32px` 行高与当前侧栏密度协调。
2. 重命名、任务创建、任务详情与设置中的全宽输入、选择和文本域均由 `border-box` 包含自身 padding 与 border，右侧留白没有再被控件宽度吃掉。
3. 表单底部保存、创建和取消为 `32px` 高、`13px` 字号与 `14px` 水平内边距；关闭按钮保持紧凑，没有造成弹窗整体膨胀。
4. 任务表格第一行保留上下文、搜索和新任务；第二行紧邻列头，状态快捷筛选贴左，批量、列和更多贴右，左右分组明确。
5. 创建任务、重命名、任务详情和设置均完成真实打开/取消或返回；未产生测试任务、未修改项目名称、未改变项目路径。
6. 正式包签名有效；控制台无可见错误，任务列表和详情没有横向溢出。

final result: passed

# 2026-07-23 项目配置与任务搜索当前验收状态

- 用户最新正式 App 截图已推翻上一节第 2、4、6 条中涉及右侧留白和当前任务工具栏的结论；这些历史结论不再有效。
- 共享抽屉盒模型和任务搜索布局的代码修复、静态检查、构建、打包与签名校验已经完成。
- macOS 当前锁屏，尚未对新正式包完成逐页真实窗口复验；解锁并核对项目配置、任务创建、任务详情、设置、重命名和任务搜索前，不得标记视觉验收通过。

final result: blocked

# 当前任务最终结论：Codex 内置浏览器右侧分栏

本文件中较早任务的 `blocked` 只描述各自历史验收状态。当前任务以“2026-07-26 Codex 内置浏览器右侧分栏与页面批注最终验收”一节为准，正式包的左右分栏、批注状态和分隔条指针/键盘交互均已通过。

final result: passed

# 2026-07-27 Codex 浏览器开合动效与标签关闭悬停验收

## 参考参数

- 当前 Codex App：`26.721.41059 (5848)`；
- 右侧面板：宽度与透明度共用 spring 显隐进度，`duration: 0.5`、`bounce: 0.1`，归零后卸载；
- 减少动态效果：立即切换；
- 标签关闭反馈：内部 `16 × 16px` 圆形表面、三级文字色 `20%` 混色、`12 × 12px` 图标。

## 正式 Zeus 证据

- 打开中间帧：`/tmp/zeus-motion-qa-20260727/zeus-browser-opening-100ms.png`；
- 完整打开态：`/tmp/zeus-motion-qa-20260727/zeus-browser-open-final.png`；
- 关闭中间帧：`/tmp/zeus-motion-qa-20260727/zeus-browser-closing-100ms.png`；
- 最终 hover 与竞态修复态：`/tmp/zeus-motion-qa-20260727/zeus-tab-close-hover-race-fixed.png`。

## 验收结果

1. 打开约 `100ms` 时右侧浏览器处于半宽、半透明状态，会话同步收窄；关闭约 `100ms` 时方向相反，不再瞬间消失。
2. 关闭动画完成前 BrowserWorkspace 保持挂载，完成后才卸载；会话工作面连续恢复到完整宽度。
3. 标签 `X` 的完整命中热区为 `28 × 28px`，内部悬停表面严格为 `16 × 16px`，图标为 `12 × 12px`，悬停背景清晰可见且不改变标签布局。
4. 最后一个标签通过真实鼠标关闭后，浏览器退场、标签归零；再次打开创建一个 `New tab`，既有关闭语义没有回归。
5. 退场期间不再向 Main 上报已删除标签的布局，最终运行日志没有浏览器标签归属错误。
6. 正式包、DMG、ZIP、包内健康门禁、签名、静态检查与单实例恢复均通过。

final result: passed

# 2026-07-27 浏览器分栏边界、主题即时切换与中性焦点最终验收

## 本轮复核范围

- 会话右侧浏览器是否保持 Codex 式独立工作面，并具有持续可见的中性分隔边界；
- 设置页切换深色/浅色/跟随系统时，当前页面是否原位即时重绘；
- 普通鼠标状态是否移除无语义的蓝色线框，同时为键盘保留克制且清晰的中性焦点；
- 验收载体为重新构建、签名并启动的正式 `/Users/david/hypha/zeus/dist/mac-arm64/Zeus.app`，不是 QA 页面或开发服务器。

## 参考与视觉输入

- 用户提供的当前 Codex App 分栏参考：
  `/var/folders/2m/dswmfzbd7wx_39zxs4kvd3fc0000gn/T/codex-clipboard-96f27725-6238-4b06-9fee-e117345606fc.png`；
- Zeus 最终浏览器分栏：`/tmp/zeus-final-browser-split-neutral.jpg`；
- Zeus 分隔条键盘焦点：`/tmp/zeus-final-browser-divider-keyboard-focus.jpg`；
- Zeus 设置页即时深色与中性选中态：`/tmp/zeus-final-settings-dark-neutral.jpg`；
- Codex / Zeus 同屏比较：`/tmp/zeus-codex-browser-split-comparison.png`。

Codex 参考为 `4090 × 2250`，Zeus 正式窗口为 `1226 × 768`。同屏输入按工作面高度归一化，只比较导航、会话、浏览器三层信息关系及分隔边界；不同设备下的绝对像素坐标不作为对齐依据。

## 正式包可观察结果

1. 会话记录与输入框持续位于左侧，浏览器持续位于右侧；两者之间存在清晰的中性一像素空闲边界，不再视觉融入会话正文。
2. separator 的辅助功能值为 `56`；真实键盘调整完成 `56 → 58 → 56`，焦点态为中性加粗线。分栏行为代码未变，此前正式包鼠标拖动 `56 → 66 → 56` 的运行证据仍有效。
3. 设置页从原有“跟随系统”切换为“深色”后，当前设置表面、文字、输入框和模式卡在原位立即重绘，无需返回设置或切换路由。
4. “工作模式”选中卡、radio、输入框及普通按钮不再显示蓝色轮廓；键盘 `:focus-visible` 仍清晰可辨。启用开关和主操作按钮保留语义明确的填充蓝色。
5. 验收结束前已恢复“跟随系统”，未保存临时深色选择；浏览器恢复默认 `56%` 分栏，正式 Zeus 保持单实例运行。
6. `forced-colors: active` 继续使用系统 `Highlight`。本轮没有冒充 macOS“增强对比度”真实系统验收；该全量矩阵行仍单独待验。

## 构建与包门禁

- `pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm package:mac`：通过；
- 正式包健康检查：通过，`codex=0.145.0-alpha.30`、`arch=aarch64-apple-darwin`；
- `codesign --verify --deep --strict --verbose=2`：通过；
- `git diff --check`：通过。

上述静态、构建与签名结果只证明包门禁；本节结论还基于同一正式包的真实窗口操作和截图。本轮三项用户复核问题均通过，全量高对比度系统行不在本节通过范围内。

final result: passed

# 2026-07-27 会话耗时、主题菜单与深色边缘最终验收

## 本轮复核范围

- 会话轮次耗时两侧的横线是否有功能必要，以及移除后信息层级是否仍清楚；
- Select portal 是否实时继承浅色、深色与跟随系统主题；
- 深色模式普通按钮、选择框和菜单是否移除不必要的亮边，同时保留键盘可见焦点；
- Return、Home、End、Escape、Tab 是否形成完整键盘闭环。

## 同屏视觉输入

- 修复前深色会话：`/tmp/zeus-theme-audit-20260727/05-conversation-dark.png`；
- 修复后最终正式包深色会话：`/tmp/zeus-theme-fix-final-20260727/16-final-package-conversation-dark.png`；
- 修复前深色设置页白色菜单：`/tmp/zeus-theme-audit-20260727/04-theme-dropdown-dark.png`；
- 修复后最终正式包深色菜单：`/tmp/zeus-theme-fix-final-20260727/15-final-package-theme-menu-dark.png`；
- 上述四态同屏比较：`/tmp/zeus-theme-fix-final-20260727/17-before-after-comparison.png`。

## 正式包可观察结果

1. “已处理 Ns”耗时仍位于轮次间的中央元数据位置，两侧不再出现贯穿内容区的装饰横线；没有移除耗时数据或交互。
2. 设置页从“跟随系统”切到“深色”时当前页面原位立即重绘；重新打开主题菜单后，菜单表面、文字、选中态和边缘均与深色页面一致，不再出现白色 portal。
3. Select 触发器、普通按钮和菜单边缘使用低对比度中性 token；键盘焦点仍可见，没有用去除全部 outline 的方式掩盖问题。
4. Return 打开后焦点进入当前选项；Home / End 可跳到首尾；Escape 关闭并恢复到触发器；Tab 关闭并进入下一项“桌面通知”。
5. 验收结束前恢复“跟随系统”，未保存临时深色状态；正式 Zeus 仅保留一个主进程。

## 构建与包门禁

- `pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm package:mac`：通过；
- 正式包健康检查：通过，`codex=0.145.0-alpha.30`、`arch=aarch64-apple-darwin`；
- `codesign --verify --deep --strict --verbose=2`：通过；
- `git diff --check`：通过。

本节结论来自最终重新打包的正式 Zeus 窗口，不使用 QA 页面或开发服务器代替。macOS“增强对比度”真实系统状态仍属于单独的全量矩阵待验项。

final result: passed

# 2026-07-28 新建任务与会话输入待提交资源统一

## 参考与验收状态

- 参考图：`/var/folders/2m/dswmfzbd7wx_39zxs4kvd3fc0000gn/T/codex-clipboard-0c5a42c6-ded0-4944-b007-19c40d06a856.png`
- 参考像素：`1378 × 342`，高密度截图；文件卡约为 `450 × 106` 物理像素，对应约 `225 × 53` 逻辑像素。
- Zeus 正式包截图：`/tmp/zeus-session-pending-resources-accepted-final.png`
- Zeus 窗口像素：`1226 × 768`；浅色、简体中文、已有项目会话、单个 XLSX 待提交资源。
- 聚焦同屏输入：`/tmp/codex-zeus-attachment-card-comparison.png`
- 全态同屏输入：`/tmp/codex-zeus-composer-full-comparison.png`
- 新建任务正式包证据：`/tmp/zeus-task-pending-resources.png`，包含普通文件、XLSX 和目录。

本轮目标是匹配 Codex 的资源卡视觉语法，并让新建任务与会话输入共享同一组件和交互能力；不要求把 Zeus 的 composer 最大宽度、模型控制项或任务弹窗结构改造成 Codex App。

## 同屏比较与迭代

1. 初始 Zeus 会话资源条位于输入框外，移除圆点比例偏大；新建任务仍使用旧 filmstrip，且 picker 只覆盖文件。
2. 抽取共享资源卡后，文件卡固定为 `224 × 54px`，图片卡为 `54 × 54px`，图标底板为 `40 × 40px`，标题 `14px / 18px`，摘要 `12px / 16px`。
3. 移除动作调整为 `24 × 24px` 可点击区包裹 `18 × 18px` 可见圆点，聚焦比较中与 Codex 参考的圆点占比一致。
4. 会话卡移动到 composer 外壳内部；聚焦对照确认文件卡宽高、圆角、图标与文字层级接近参考。
5. 全态对照发现 textarea 仍表现为独立的第二层圆角框。最终代码已为 textarea 增加透明、无边框强覆盖，并将外壳边界切换到产品中性 token。
6. 新建任务和会话均使用同一共享卡；任务选择器已真实接受 XLSX 和目录，长文本已真实生成并恢复。

## 构建与运行证据

- `pnpm typecheck`：通过；
- `pnpm lint`：通过；
- `pnpm build`：通过；
- `pnpm package:mac`：通过；
- `git diff --check`：通过；
- 最终包健康门禁：通过，`codex=0.145.0-alpha.30`、`arch=aarch64-apple-darwin`；
- 最后一次可视操作前的正式包中，任务 XLSX、目录、`6660` 字符长文本及恢复动作均成功；会话 XLSX 卡成功；
- 没有创建任务、发送消息或触发 Provider；验收副本已移入废纸篓，可恢复。

## 阻塞与未覆盖

最后一次全态比较之后又修正了 textarea 第二层边框，并重新生成了正式包。随后 macOS 锁屏，Computer Use 无法取得该最终包的新截图。因此当前有代码、静态检查、构建、签名和健康门禁证据，也有修正前一版正式包的真实交互证据，但缺少最后一个 CSS 修正后的正式窗口视觉证据。

此外，本轮尚未在新建任务中真实执行截图剪贴板粘贴和跨 Finder drag/drop，也未完成深色、窄窗口与键盘焦点矩阵。

final result: blocked

# 当前任务最终结论：新增项目入口与单目录创建

本文件中较早任务的 `blocked` 只描述各自历史验收状态。当前任务以“2026-07-29 新增项目入口与单目录创建最终验收”一节为准；重复侧栏空态已删除，单目录创建、自动切换、键盘焦点闭环和正式包视觉对照均已通过。

final result: passed

# 2026-07-30 过程态与底部交互坞验收

## 对比目标

- 来源视觉：用户提供的六张 Codex App 截图，完整路径记录在
  `docs/TASK_20260730_001_Codex过程态与底部交互坞对齐.md`。
- 来源像素尺寸：`1606 × 488`、`1596 × 784`、`1666 × 1126`、`1604 × 540`、
  `1608 × 250`、`1582 × 1696`。
- 目标状态：过程 reasoning、实时工具活动、活动展开、阻塞提问替换 composer。
- 最终正式包实现截图：
  `/var/folders/2m/dswmfzbd7wx_39zxs4kvd3fc0000gn/T/com.openai.sky.CUAService/Zeus Screenshot 2026-07-30 at 3.22.09 PM.jpeg`。
- 实现截图为 `864 × 768` 窄窗口；应用辅助功能树明确标记已遵循减少动态效果。

## Findings

- 未发现阻断本任务交付的 P1/P2 问题。
- 首轮运行验收发现 readable reasoning 仍为空，根因是 Zeus 只处理 delta、却未在
  `turn/start` 请求 summary；补充 `summary: "auto"` 并重新打包后，正式包真实显示四组分段摘要，
  数据库 `text_content` 长度分别为 `83`、`88`、`51`、`99`。
- 首轮还发现 provider 可能以新 item ID 完成已经流出的消息前缀；turn 完成归一化已补齐，
  最终两个回归 turn 均为 `in_progress_items=0`。

## Open Questions

- 深色模式与 macOS“增强对比度”仍未覆盖；不影响本任务已验收的浅色、窄窗口和减少动态效果路径。

## Implementation Checklist

- [x] `pnpm lint`
- [x] `pnpm typecheck`
- [x] `pnpm build`
- [x] `git diff --check`
- [x] `pnpm verify:release`：格式、lint、类型、构建、139 项验收矩阵、CLI 探针、打包、发布清单、
      健康检查与严格 codesign 校验通过。
- [x] `hdiutil verify`：最终 DMG 校验有效。
- [x] 正式包 Plan、普通模式、`864 × 768` 窄窗口与减少动态效果验收。
- [x] 初始思考、回答后恢复思考、实时最新活动行、阶段结束活动汇总。
- [x] Plan 阻塞提问替换 composer；提交后恢复 composer。
- [x] 运行库复核完成事件保留可读摘要，最终 turn 无遗留 `in_progress` item。
- [x] 运行验收使用仓库 `dist/mac-arm64/Zeus.app`；用户的 `/Applications/Zeus.app` 已恢复为验收前原始副本。

## Follow-up Polish

- 可后续补充深色模式、增强对比度，以及命令/文件/权限/MCP 超长审批卡的独立滚动截图矩阵。

## 比较历史

- 首轮：源码实现、静态检查和构建完成；缺少重新打包后的正式窗口截图，视觉验收保持阻塞。
- 第二轮：用户授权发布更新后完成正式包 UI 验收；发现 summary 未请求及遗留流式 item 两个运行缺口。
- 最终轮：补充 `summary: "auto"` 与 turn 完成收口后重新打包；Plan/普通模式、窄窗口、
  减少动态效果、活动行、交互坞、回答后思考及数据库持久化均通过；正式发布门禁和本机应用更新完成。

final result: passed

# Zeus 代码图谱设计验收

- 参考图：`/Users/david/.codex/generated_images/019fb595-c8b9-7283-9fe4-88bb255af184/call_FQjUgnMdIVLMFcgtQIvbCARc.png`
- 实现：`/Users/david/hypha/zeus/dist/test/mac-arm64/Zeus Test.app`
- 对比视口：864 × 768
- 对比输入：参考图缩放到 864 × 768 后，与同视口的测试包系统架构图并排检查

## 检查结果

- 项目侧栏、顶部视图切换、搜索、状态与工具区的层级和密度一致。
- 系统架构图保持项目边界、业务服务、共享契约、公共基础三层结构。
- 6 个业务工作负载、2 个共享模块、1 个公共基础模块及 3 条真实依赖均正确显示。
- 节点卡片、层级容器、蓝色依赖箭头、画布控制与底部状态栏没有裁切、重叠或错误留白。
- 单击架构节点可进入节点关系图；返回路径、一跳/两跳切换及二级详情抽屉均在真实测试包中可用。
- 界面默认使用简体中文，真实源码名称、模块名和路径保留原文。

final result: passed
