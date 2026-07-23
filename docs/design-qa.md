# Zeus 会话页 Codex 操作栏与上弹菜单设计 QA

## 对比目标

- 视觉真值：`docs/evidence/codex-assistant-message-actions-reference.png`、
  `docs/evidence/codex-user-message-actions-reference.png`
- 正式实现截图：`docs/evidence/zeus-message-actions-packaged-20260720.jpeg`、
  `docs/evidence/zeus-user-actions-packaged-20260720.jpeg`、`docs/evidence/zeus-composer-focus-packaged-20260720.jpeg`、
  `docs/evidence/zeus-model-dropdown-packaged-20260720.jpeg`
- 2026-07-21 最终包截图：`docs/evidence/zeus-session-message-actions-final.png`、
  `docs/evidence/zeus-session-inline-edit-final.png`、`docs/evidence/zeus-session-composer-autogrow-final.png`
- 聚焦区域同屏对比：`docs/evidence/zeus-assistant-actions-comparison-20260720.png`、
  `docs/evidence/zeus-user-actions-comparison-20260720.png`
- 视口：1162 × 768，macOS 正式 arm64 Zeus 包，浅色主题
- 状态：已有 native 会话空闲；消息操作栏可见；用户消息在原气泡内编辑；输入框展开为六行；模型菜单打开

## Findings

- 无 P0 / P1 / P2 遗留问题。
- [P3] Computer Use 截图会显示系统鼠标指针与光晕；它不是产品界面，不影响 action rail 的真实布局、图标与点击区判断。

## 五项保真检查

- 字体与排版：沿用 Zeus 既有系统字体栈；操作时间使用 13px 等宽数字，视觉密度与参考图归一化后相当。
- 间距与布局节奏：消息按钮为 28px 点击区、20px 图标、2px 组内间距；Codex 左对齐、用户右对齐；操作栏绝对定位，并由消息外部 18px
  尾部间距隔开下一条内容，不重新引入气泡内大块空白。
- 颜色与 token：操作图标使用独立中性灰 token；hover、focus、选中态沿用现有会话页 selected/control token；浅色与深色主题均有对应值。
- 图标与资产保真：消息复制、赞、踩、展开、编辑与勾选改为基于 Codex 参考图校准的 1.7px 圆角线性 SVG；下拉箭头保留
  Phosphor。消息操作栏未使用字符图标。
- 文案与内容：用户消息顺序为“时间、复制、编辑”；Codex 消息顺序为“复制、赞、踩、展开、时间”；中文可访问名与当前界面一致。

## 全屏对比证据

- `zeus-message-actions-packaged-20260720.jpeg`：正式包中 Codex 操作栏不抢正文层级，位于消息下方左侧；composer 保持 650px
  宽度与现有会话节奏。
- `zeus-user-actions-packaged-20260720.jpeg`：用户气泡下方右侧显示时间、复制、编辑，顺序和参考图一致。
- `zeus-composer-focus-packaged-20260720.jpeg`：输入框已聚焦，外框与未聚焦状态相同，不再出现黑色边线。
- `zeus-model-dropdown-packaged-20260720.jpeg`：模型列表完整显示在触发器上方，触发器及当前 `GPT-5.6-Sol` 仍在下方可见，没有被菜单覆盖。

## 聚焦区域对比证据

- `zeus-assistant-actions-comparison-20260720.png`：参考图与正式实现均为复制、赞、踩、对角展开、时间；线性图标重量和中性灰度一致。
- `zeus-user-actions-comparison-20260720.png`：参考图与正式实现均为时间、复制、编辑；正式截图里的鼠标指针覆盖属于采集层，不是界面资产。

## 交互验收

- 正式包 AX 树暴露 `复制消息`、`好的回答`、`不好的回答`、`展开消息`、`复用并编辑`。
- 点击“好的回答”后 toggle 从 `Value: 0` 变为 `Value: 1`，再次点击恢复为 `Value: 0`。
- 模型菜单暴露真实 listbox，包含 GPT-5.6-Sol、GPT-5.6-Terra、GPT-5.6-Luna、GPT-5.5、GPT-5.3-Codex-Spark。
- 权限菜单暴露真实 listbox，包含只读、自动、完全访问；菜单同样向上展开。
- Escape 可关闭上弹列表；当前选择始终由下方 trigger 展示。
- 点击用户消息铅笔后，原气泡直接变为带“取消 / 发送编辑内容”的文本域；取消后原文无变化。
- 输入框填入六行内容后随 `scrollHeight` 增高；超过视口 34% 后才进入内部滚动。
- Command+A 将既有 `alpha beta gamma` 整段替换为 `ZEUS_SELECT_ALL_OK`；菜单栏同时暴露原生 Edit 菜单。
- 复制按钮只在 Electron Main 写入系统剪贴板并立即回读一致后切换为“已复制”。

## 对比历史

1. 初始 P1：消息底部只有粗糙复制按钮，缺少 Codex App 的赞、踩、展开、时间与用户编辑序列。修复：引入 Phosphor 图标并按角色拆分
   action rail。复验：两张聚焦区域同屏对比无 P0/P1/P2 差异。
2. 初始 P1：composer 聚焦时整框变为深色边线。修复：删除独立 focus-line token，聚焦态继续使用普通边框 token。复验：正式包聚焦截图无边框跳变。
3. 初始 P1：原生 select 菜单可能覆盖当前选项且无法固定上弹。修复：实现可键盘操作的自定义 listbox，固定
   `inset-block-end: calc(100% + 6px)`。复验：正式包模型与权限菜单均在触发器上方打开。
4. 2026-07-21 P1：绝对定位的消息操作栏未占布局，和下一条内容间距不足。修复：为有操作栏的消息增加外部尾部间距。复验：最终包正文、操作栏、下一条内容无重叠。
5. 2026-07-21 P1：file:// Renderer 仅调用 `navigator.clipboard`，复制可能无效。修复：增加 Preload IPC 与 Electron Main
   原生剪贴板写后回读。复验：最终包按钮进入“已复制”前已通过回读校验。
6. 2026-07-21 P1：编辑把历史文本送到底部 composer。修复：原用户气泡原位切换为编辑表单。复验：最终包 AX 和截图均显示编辑器位于原消息容器。
7. 2026-07-21 P1：composer 高度固定。修复：输入、草稿同步和窗口调整时按内容重新计算高度。复验：六行正式包截图通过。
8. 2026-07-21 P1：macOS 缺少 Edit 菜单，Command+A 无标准 role。修复：补齐 undo/redo/cut/copy/paste/selectAll。复验：正式包整段替换通过。

## Implementation Checklist

- [x] Codex 与用户消息操作栏顺序、图标、时间对齐参考图
- [x] 复制、反馈、展开、编辑语义与键盘焦点保留
- [x] composer 聚焦黑线移除
- [x] 模型、推理等级、权限上弹且不遮挡当前值
- [x] 正式 macOS 包重打包、重启、截图和 AX 交互验收
- [x] 消息操作栏与下一条内容保留独立间距
- [x] 系统剪贴板写后回读，失败不假报
- [x] 原气泡编辑、输入框自增高、Command+A 全选

## Follow-up Polish

- 无阻断项；后续若接入服务端反馈 API，可将当前本地赞/踩状态升级为可持久化反馈。

final result: passed

---

# 2026-07-21 Codex 运行过程事件分层设计 QA

## 对比目标与证据

- 参考：用户提供的四张 Codex App 截图，分别覆盖轮次耗时与计划进度、活动组展开、断线重试、已加载技能。
- 正式包现场：`docs/evidence/zeus-codex-process-activity-packaged-20260721.jpeg`。
- 四张参考图与正式包同屏输入：`docs/evidence/zeus-codex-process-activity-comparison-all-20260721.png`；未对参考像素或正式包像素做生成式改写。
- 正式包：`dist/mac-arm64/Zeus.app`，浅色主题，真实 `tc-app-core` 归档会话。
- 视口限制：参考图是不同尺寸的局部裁剪，正式包截图为 991 × 768 完整窗口，因此只能判断信息层级、密度、图标语义和折叠结构，不能宣称逐像素同视口复刻。

## Findings

- 无 P0 / P1 / P2 可见遗留问题。
- [P3] 正式包完整窗口的信息密度高于参考局部裁剪；这是参考范围不同，不是活动组内部出现卡片堆叠、边距错位或裁切。
- [Blocked / 证据状态] 当前选中的真实归档会话没有 `turn/plan/updated` 事件，无法在不伪造用户数据的前提下抓取正式包计划进度截图；计划的持久化、重连恢复与
  Renderer 投影已由自动化测试覆盖。
- [Blocked / 证据状态] 未主动制造网络故障，因此没有正式包断线截图；无限重试、5 秒封顶退避、立即重试和原始错误折叠展示已由自动化测试覆盖。

## 五项保真检查

- 字体与排版：沿用 Zeus 既有系统字体、正文行高和中性灰 token；活动摘要保持单行低层级，展开内容不与 assistant 正文争抢层级。
- 间距与布局节奏：连续 command / search / file / skill 事件形成一个 disclosure group；展开后使用紧凑纵向轨道，没有为每个事件重新制造独立卡片。
- 颜色与 token：完成态、运行态、失败态只使用既有会话 token；没有新增高饱和状态色或硬编码深色主题颜色。
- 图标与资产：活动、命令、搜索、文件、状态、重试使用 Phosphor 图标；不再使用 `>_`、Wi-Fi 字符画或手工 SVG 近似。
- 文案与内容：技能名仅从真实 `commandActions` 的 `SKILL.md` 路径提取；没有根据普通命令文本猜测“使用了某技能”。原始英文错误只在展开详情中保留，主层使用本地化恢复文案。

## 正式包交互与无障碍验收

- AX 树暴露 `工作活动` container 和 `已加载 2 个技能` disclosure triangle；点击后可见 `domain-modeling`、`grilling`
  、命令、读取技能和各自完成状态。
- disclosure 可由真实按钮展开/收起；展开后命令和技能读取按发生顺序呈现，不打断对应轮次正文。
- 轮次底部显示 `已处理 2m 20s`，与运行过程区分，不再把耗时混在工具标题中。
- 计划步骤、活动条目、重试和失败恢复均保留语义化状态与 `focus-visible`；`prefers-reduced-motion` 下停止旋转动画。
- 小视口下计划行回退为“状态图标 + 文案”两列，避免步骤文案被固定三列挤压。

## 结论

- 可观察真实状态的正式包视觉、折叠交互、AX 语义与信息层级：通过。
- 计划进度与断线态的源码、持久化和自动化契约：通过。
- 四种参考状态的同视口、同数据逐像素截图复验：受真实会话数据与故障注入边界限制，诚实标记为 blocked，不以 mock 或伪造数据库替代。

final result: passed for observable packaged state; exact four-state screenshot replay blocked

---

# 2026-07-22 PLAN 模式、计划产物与问答面板设计 QA

## 结论纠正

- 先前写入的“同视口对照”和“无 P0 / P1 / P2”结论无效：Codex 参考图是 Retina `@2x` 的局部组件截图，Zeus 证据是 `1162 × 768`
  整窗截图，二者没有处在同一像素密度、同一裁剪范围或同一界面状态。
- 本轮按用户要求只处理字体和组件尺寸，不调整项目导航、会话列表、消息区宽度和整体分栏。
- 当前只能声明“尺寸契约已校准并通过自动化测试”；不能声明 Zeus 已与 Codex App 完整视觉一致。

## 尺寸基准

Codex 参考图先按 `@2x -> 1x CSS` 归一化，得到以下实现基准：

| 对象            | Codex 归一化基准           | Zeus 源码契约                                           |
|---------------|-----------------------|-----------------------------------------------------|
| 问答 / 实施面板最大宽度 | `736px`               | `46rem`                                             |
| 面板圆角          | 参考截图约 `18px`          | `18px`                                              |
| 问题标题          | 参考截图约 `15px / 20px`   | `15px / 20px`                                       |
| 选项行最小高度       | 参考截图约 `40px`          | `40px`                                              |
| 编号圆           | 参考截图约 `28 × 28px`     | `28 × 28px`                                         |
| 选项标题          | 参考截图约 `14px`          | `14px`                                              |
| 选项说明          | 参考截图约 `12px / 18px`   | `12px / 18px`                                       |
| 跳过按钮高度        | 参考截图约 `28px`          | `28px`                                              |
| 状态行到面板间距      | 参考截图约 `24px`          | `24px`                                              |
| 普通问答纵向位置      | 消息不足一屏时位于 composer 上方 | transcript 内 `margin-block-start: auto`，内容溢出时仍随消息滚动 |
| 内联计划正文        | `15px / 24px`         | `15px / 24px`                                       |
| 内联计划一级标题      | `24px`                | `24px / 31px`                                       |
| 右侧计划工作区正文     | `15px`                | `15px / 25px`                                       |
| 右侧计划工作区一级标题   | `28px`                | `28px / 36px`                                       |

## 当前证据

- 归一化 Codex 参考：`docs/evidence/plan-alignment/codex-request-user-input-reference-1x.png`、
  `codex-implementation-reference-1x.png`。
- 第一轮隔离源码构建：`docs/evidence/plan-alignment/request-user-input-size-aligned.jpeg`、
  `implementation-size-aligned.jpeg`；用户复核后确认仍偏大，已降级为失败历史证据。
- 证据说明：`docs/evidence/plan-alignment/SIZE_ALIGNMENT.md`。
- 隔离资料路径为 `/tmp/zeus-plan-qa.vfRzlm`；本轮没有覆盖用户正在使用的 `dist/mac-arm64/Zeus.app`。

## Findings

- [P1] Zeus 会话主内容区比 Codex 参考局部画布窄，面板实际展开宽度受父布局约束，说明整体分栏和内容宽度仍未对齐；这是用户要求“先不动整体布局”的后续项。
- [P1] 右侧计划工作区尚未在解锁后的同尺寸、同状态窗口重新截图复验；当前只完成其字体和标题尺寸契约。
- [P2] 窄内容区会使问答说明提前换行，导致面板总高度高于 Codex 参考；需要在下一阶段调整整体可用宽度后复验，不能通过继续压小字体掩盖。
- 普通问答面板已从“紧跟早期消息、下方留下大片空白”改为 transcript 内底部对齐；没有使用 fixed、悬浮窗或脱离消息流的 modal。
- [P3] 领域词继续使用“计划”，不复制参考截图中的“套餐”误译。

## 自动化与构建验证

- 第二轮 CSS 尺寸和位置契约先以失败测试锁定第一轮偏大值，再更新为上述紧凑基准；聚焦
  `session-workspace + pending-request-surface` 为 `95 passed`。
- `pnpm typecheck` 通过。
- 相关文件 Prettier 与 ESLint 通过。
- `pnpm --filter @zeus/desktop build` 通过，仅保留既有的单 chunk 超过 `500 kB` warning。
- macOS 仍处于锁屏状态，Computer Use 无法读取第二轮紧凑实现；因此不补写不存在的实机通过证据。
- 退出旧正式 Zeus 后执行 `pnpm package:mac` 成功；新 `Zeus.app` 通过 `codesign --verify --deep --strict`，ZIP 解压测试和
  DMG 校验和验证通过，`app.asar` 已检出 `session-request-user-input-surface`。正式 App 已重新启动，但锁屏状态下仍不把“进程已启动”冒充视觉通过。

## 后续验收边界

- 下一阶段才处理整体会话分栏、内容宽度、计划工作区比例和同状态对比。
- 完成后必须将 Codex 参考和 Zeus 截图统一到相同像素密度、相同组件裁剪与相同状态，再重新判定 P0–P2。
- 在此之前，原 `compare-request-user-input.png`、`compare-implementation-request.png`、`compare-plan-workspace.png`
  不作为通过证据。

final result: blocked — compact size and position contract passed; current-window capture, layout parity and same-state
visual QA remain
