# ZEUS-000030 Token 计量单位自动升级

## 当前阶段

已完成真实截图核对、代码链路定位、领域术语澄清、生产代码修改、静态检查、生产构建、正式包与隔离 Test 包打包，以及真实 Token 快照界面验收。本阶段交付为本地 Git 提交，提交标识由交付响应记录。

## 任务目标

把会话运行时详情中的长 Token 整数改为自动升级的紧凑显示，同时保持 Codex 上报、Reducer 状态和持久化快照中的精确整数不变。

本任务中的“自动升级”统一称为“Token 紧凑显示”，它是展示层派生规则，不是修改 Token 的计量语义或数据精度。

## 真实依据

### 用户现场

- 附件：`/Users/david/Library/Application Support/@zeus/desktop/task-attachments/1785490398563-6e8f3b08-f403-46f2-8bf7-b1ba2b07d4ff-pasted-task-screenshot-1785490398561.png`
- 文件事实：PNG，`560 × 122`，SHA-256 为 `76d7ea816a0173c4f1b1f7ea605202a590411017088f222f632c3f735a5e5dc3`。
- 可见现象：展开的“Token 用量”显示 `2726536 tokens · 2713857 in · 12679 out`，三个值都以未分组的完整整数渲染。

### 仓库与代码

- 任务工作区：`/Users/david/hypha/.zeus-worktrees/zeus-e2e-oBLuqT/ZEUS-000030/13231233d5278bc1`
- 分支：`zeus/ZEUS-000030-token-01`
- 取证提交：`c415206`
- 开始分析时 `git status --short` 无输出，工作区干净。
- `apps/desktop/src/renderer/session/SessionWorkspace.tsx` 的中英文 `tokens(count)` 都直接返回 ``${count} tokens``。
- 同一文件的运行时摘要直接渲染 `usage.totalTokens`，展开详情直接拼接 `usage.totalTokens / inputTokens / outputTokens`，因此截图中的长文本是 Renderer 展示规则造成的。
- `apps/desktop/src/renderer/session/sessionTypes.ts` 将三个值定义为 `number`；`sessionReducer.ts` 从真实事件载荷读取三个精确值。
- `packages/local-server/src/codexNativeConversationCoordinator.ts` 从 Codex `thread/tokenUsage/updated` 的 `tokenUsage.total` 归一化三个数，并持久化后广播。
- `packages/storage/src/index.ts` 要求三个值都是有限且非负的数字。展示层不需要猜测或修复负数、`NaN`、字符串等非法输入。
- 仓库搜索未发现可复用的紧凑 Token 格式化器；现有 `formatCount` 只用于系统通知并原样拼接整数与标签。
- 历史主任务文档 `docs/TASK_20260715_001_Codex会话设置与Token用量事件解析故障排查.html` 已确认 Token 用量来源是 Codex 事件、持久化快照与 Renderer 类型化事件。本任务不改该数据链路。

## 已确认规则

用户已逐项确认以下产品规则：

1. 使用 1000 进位的 `K / M / B`，中文和英文界面保持同一单位体系。
2. 紧凑值最多保留 3 位有效数字，并去掉无意义的尾零。
3. `< 1,000` 显示原整数；`≥ 1,000` 使用 K；`≥ 1,000,000` 使用 M；`≥ 1,000,000,000` 使用 B。
4. 舍入结果跨越下一阈值时继续升级，例如 `999,999` 显示为 `1M`，而不是 `1000K`。
5. 顶部运行时摘要与展开详情中的 total、in、out 全部使用同一紧凑规则。
6. 每个紧凑值通过悬停文本和辅助技术可访问名称保留带千分位的精确整数。
7. 精确整数继续作为状态、事件和持久化事实；格式化结果不回写数据层。

按现场数据，目标显示为：

```text
2.73M tokens · 2.71M in · 12.7K out
```

精确值入口仍应能读到：

```text
2,726,536 tokens · 2,713,857 in · 12,679 out
```

## 方案比较

| 方案 | 优点 | 缺点 | 结论 |
| --- | --- | --- | --- |
| 直接使用当前语言的 `Intl.NumberFormat` compact notation | 代码短，可自动本地化 | 中文环境可能产生“万/亿”，不能保证已确认的 K/M/B；跨平台输出细节也更难固定 | 不采用 |
| 在 JSX 中分别做除法和拼接 | 修改表面最小 | 摘要与详情容易漂移，跨级舍入和精确值入口会重复实现 | 不采用 |
| 单一纯格式化函数返回紧凑值与精确值 | 规则集中，摘要和详情一致，数据层不受影响 | 需要显式维护 K/M/B 阈值与跨级舍入 | 采用 |
| 把格式化值写入 Reducer 或持久化快照 | Renderer 可直接展示 | 丢失精确事实，污染协议与存储，后续计算可能读取近似值 | 禁止 |

采用方案的优点是变更局限于会话 Renderer、可逆且不触碰真实 Token 数据链路；缺点是 B 以上没有新单位，若未来真实会话达到万亿量级，需要另行确认是否引入 T，而不能本次自行扩展。

该决策是可逆的展示规则，不满足“难以回退”的条件，因此不创建 ADR。

## 实施计划

### 1. 增加单一 Token 展示格式化函数

在 `apps/desktop/src/renderer/session/SessionWorkspace.tsx` 内增加会话页私有纯函数，输入为已校验的非负 Token 整数，输出至少包含：

- `compact`：K/M/B 紧凑值，不包含 total、in、out 等语义标签；
- `exact`：按当前界面语言格式化的带千分位精确整数。

处理顺序：

1. 根据原始值选择初始单位。
2. 将缩放值舍入到最多 3 位有效数字。
3. 若舍入后达到 `1000` 且仍有下一单位，升级单位后重新计算。
4. 去除尾零并拼接单位；小于 1000 时保留原整数。
5. B 为本次确认的最高单位，不自行引入 T。

函数只做显示转换，不接收或返回会话状态对象，也不修改 `NativeTokenUsageSnapshot`。

### 2. 统一运行时摘要与详情

修改 `SessionRuntimeDetails` 的两个展示入口：

- 折叠摘要中的 total 使用 `compact + " tokens"`；
- 展开详情中的 total、input、output 分别使用相同函数，再拼接 `tokens / in / out`。

不要保留现有 `copy.tokens(count)` 的整数直出路径，避免摘要与详情再次分叉。中英文标签继续沿用既有文案，本任务不扩大翻译范围。

### 3. 保留精确值与可访问语义

每个可见紧凑值使用独立文本节点：

- `title` 提供对应的带千分位精确整数和语义标签；
- `aria-label` 同时表达紧凑值和精确值，避免屏幕阅读器只能获知近似读数；
- 分隔点 `·` 保持纯展示，不进入数值格式化函数。

该改动不新增颜色、尺寸、布局或动效，不需要新增 CSS token；仍需在窄窗口检查紧凑文本没有改变现有详情行层级。

### 4. 同步长期记录

- `CONTEXT.md` 记录“Token 用量”和“Token 紧凑显示”的边界。
- 本文继续记录实施结果、命令输出和真实界面证据；进入实现阶段后不另建重复任务文档。
- 不修改历史故障排查文档，因为其关于事件解析与精确快照的事实仍然成立。

## 预计修改文件

| 文件 | 修改点 |
| --- | --- |
| `apps/desktop/src/renderer/session/SessionWorkspace.tsx` | 新增 K/M/B 格式化函数，统一摘要与详情，并补精确值可访问入口 |
| `CONTEXT.md` | 记录 Token 精确事实与紧凑显示的领域边界 |
| `docs/ZEUS-000030_Token计量单位自动升级.md` | 记录真实依据、确认规则、计划和后续验收结果 |

不预计修改 `sessionTypes.ts`、`sessionReducer.ts`、Local Server、Storage、数据库迁移或 CSS；若实现时发现必须触碰这些范围，应停止并以新证据重新评估，而不是扩大修改。

## 实际修改结果

- `SessionWorkspace.tsx` 新增模块级 K/M/B 单位表、三位有效数格式化器和中英文精确整数格式化器，避免每次 React 渲染重复创建 `Intl.NumberFormat`。
- `formatTokenCount` 只接收精确 Token 数并返回 `compact / exact` 两个派生字符串；没有写入会话状态、事件载荷或持久化对象。
- `TokenUsageValue` 统一渲染可见紧凑值，并用 `title` 与 `aria-label` 提供精确整数；辅助技术标签同时包含紧凑值和精确值。
- 折叠摘要和展开详情均改为复用 `TokenUsageValue`，total、input、output 不再直接插入原始长整数。
- 未修改 `sessionTypes.ts`、`sessionReducer.ts`、Local Server、Storage、数据库迁移或 CSS，实际范围与计划一致。

## 验证方式

### 静态与构建门禁

实现后依次执行：

```bash
pnpm lint
pnpm typecheck
pnpm build
git diff --check
pnpm package:mac
```

这些命令分别证明 lint、类型、构建、补丁格式和 macOS 打包阶段，不单独代表真实界面验收通过。项目已明确退役单元测试体系，因此不新增或运行 Vitest、组件测试、DOM/CSS 契约测试。

### 代码级复核

- 反向搜索旧模式，确认 `SessionWorkspace.tsx` 不再直接把 `usage.totalTokens / inputTokens / outputTokens` 插入可见文本。
- 核对格式化函数没有写入状态、事件或持久化对象。
- 核对 `999 / 1,000 / 999,999 / 1,000,000 / 999,999,999 / 1,000,000,000` 的规则与已确认阈值一致；这一步是实现审查证据，不能冒充正式包 GUI 证据。

### 真实运行验收

只使用本任务仓库生成的正式包或隔离副本，不使用 `/Applications/Zeus.app` 冒充本任务产物：

1. 打开具有真实 Token 快照的会话，展开运行时详情。
2. 使用现场同量级数据确认摘要与详情显示 `M / M / K`，并与截图中的精确总量对应。
3. 分别悬停 total、in、out，确认能读取带千分位的精确值。
4. 使用键盘和辅助技术检查紧凑值与精确值语义；检查中文、英文和窄窗口。
5. 重新连接或收到下一次真实 `thread/tokenUsage/updated` 后，确认紧凑值随精确快照更新，没有出现近似值回写。

如果当时没有达到 B 阈值的真实会话，只能把 B 记为代码级已复核、正式包 GUI 未覆盖，不能伪造十亿 Token 的运行证据。

## 当前验证结果

- 已完成：截图文件存在性、尺寸与 SHA-256 核对。
- 已完成：真实数据从 Codex 事件到 Renderer 的只读链路定位。
- 已完成：当前工作树、分支与提交核对。
- 已完成：用户对单位体系、显示精度、覆盖范围和精确值入口的逐项确认。
- 已完成：领域词汇、生产代码与本任务文档落盘。
- `pnpm lint`：exit 0。
- `pnpm typecheck`：exit 0。
- `pnpm format:check`：exit 1；报告 46 个仓库基线文件格式告警，均不在本任务修改范围内，不能写成全仓格式门禁通过。
- `pnpm exec prettier --check apps/desktop/src/renderer/session/SessionWorkspace.tsx`：exit 0，目标生产文件符合当前 Prettier 规则。
- `git diff --check`：exit 0。
- `pnpm build`：exit 0；15 个 workspace 项目的生产构建完成，Renderer 转换 788 个模块。
- 首次 `pnpm package:mac`：exit 1；真实错误为 worktree 缺少 `.tmp/codex-runtime/arm64/codex`，未误报成功。
- 主仓 Codex runtime 缓存与任务 worktree 的 `runtime.lock.json` SHA-256 均为 `cce2bf8292f337b7844036cc262388e15368de12ca0f4e9270b3216b6ab037e1`；缓存二进制 SHA-256 为 `8438787cf30b4f6ac6ff19d3a5b3a81cff5a3329a6be215fe04b834763384d4a`，版本为 `codex-cli 0.145.0-alpha.30`。复制到忽略目录后再次核验一致。
- 第二次 `pnpm package:mac`：exit 0；生成仓库内 `dist/mac-arm64/Zeus.app`、DMG 与 blockmap，包健康检查和 `codesign --verify --deep --strict` 通过。产物是 ad-hoc 签名且未公证。
- `pnpm package:mac:test`：exit 0；生成独立 `Zeus Test.app`、DMG 与 blockmap，包健康检查和严格签名检查通过。

### 真实界面验收结果

Browser 插件返回 `No browser is available`，Computer Use 返回原生管道启动失败，因此未把这两个工具写成成功。最终使用 Test 包的独立 Chromium 调试端口和本机已有 Playwright CLI 回退完成真实渲染验收，没有安装新依赖。

- 隔离数据来源：从当前 Zeus 数据库读取真实 `ZEUS-000030` 会话，并通过项目自身 `sql.js` 完整加载、查询、`export()` 与 `PRAGMA quick_check` 后写入临时 userData。普通复制曾因源库落盘窗口产生 malformed 副本，该副本未用于验收。
- 真实交互路径：打开会话页 → 选择 `ZEUS-000030：token 的计量单位需要自动升级` → 点击运行时摘要 → `details.open` 从未设置变为已设置。
- 首轮实际快照：摘要显示 `12.4M tokens`；详情显示 `12.4M tokens · 12.4M in · 39K out`。
- 首轮精确值：DOM 的 `title / aria-label` 分别保留 `12,411,456 tokens`、`12,372,443 in`、`39,013 out`。
- 动态事实：隔离运行时继续读取到真实累计快照，第二轮数值增长为 `17M tokens · 17M in · 46.5K out`；显示单位随精确快照更新，没有近似值回写证据。
- 键盘：焦点元素为原生 `SUMMARY`，按 Enter 后详情展开。
- 深色与 reduced-motion：系统主题下模拟深色且 `prefers-reduced-motion: reduce` 生效，紧凑值可读。
- 窄窗口：`760 × 700` 视口下 `scrollWidth = clientWidth = 760`，没有页面级横向溢出，运行时详情仍显示三个紧凑值。
- Console：目标交互期间没有 warning 或 error。独立 Test 包启动日志只有隔离环境无法设置登录项的权限错误，以及 Chromium 对 meta CSP `frame-ancestors` 的信息提示，均未影响目标界面。
- 隔离 Test 包验收结束后已退出，未留下与 `Zeus Test.app`、临时 userData 或 9229 调试端口相关的进程；包含真实数据库副本与临时 runtime 的 533MB userData 目录已经删除。
- B 阈值没有真实十亿 Token 会话，因此仅完成代码级规则复核，未伪造正式包 B 量级 GUI 证据。

## 实施阶段完成条件

以下完成条件的当前结论：

1. 已满足：生产代码只改变展示派生逻辑，精确 Token 数据链路未变化。
2. 已满足：摘要与详情对真实快照展示一致的 M/K 紧凑值；B 规则已代码复核但 GUI 未覆盖。
3. 已满足：精确值可通过悬停与辅助技术标签读取。
4. 已满足：lint、类型检查、生产构建、正式包与 Test 包打包分别有真实 exit 0 输出。
5. 已满足并保留缺口：仓库生成的隔离 Test 包完成真实会话验收；正式分发包通过包健康与签名检查，因当前正式 Zeus 单实例正在承载本会话而未启动第二个正式窗口；B 阈值仍明确标记为 GUI 未覆盖。
