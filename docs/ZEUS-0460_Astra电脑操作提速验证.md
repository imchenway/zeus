# ZEUS-0460：Astra 电脑操作提速验证

## 目标与当前进度

最初确认范围是在同一 Astra 会话中，对比逐步调用与通过 `functions.exec` 顺序组合调用，先测量、不修改产品代码。实际入口超时后，用户明确要求“那么先修复这个问题”，当前范围因此调整为先修复基础调用故障，不新增依赖或验证体系。

当前阶段：已完成共享连接故障和设置开关即时保存两项修复；内部链路、六项错误与重连检查、十二次开关写盘及恢复检查、静态检查和最新 Test 打包均通过。共享连接修复阶段另已完成独立 Test 启动检查。当前正式控制端尚未包含修复，真实页面开关切换、会话输入、截图及性能预热与六次测量均未完成，不能计算提速幅度。前文保留历史证据，最新修复结果见末节。

## 环境与隔离

- 日期：2026-09-07。
- 工作区：`/Users/david/hypha/.zeus-worktrees/zeus-e2e-oBLuqT/b31a9a92d76fb0c3c1a9/ZEUS-0460`。
- 分支：`zeus/ZEUS-0460-gpt-astra-computer-use-zeus-01`；源码基线：`992703b3abfa353c49b8773cd40aa8150bdfe4ce`；开始时工作区干净。
- 控制端：当前用户已运行的 `/Applications/Zeus.app`，版本与构建号均为 `0.3.102`，身份 `dev.hypha.zeus`。实际操作仅通过当前会话的 `zeus_computer` 工具进入，不启动其他生产身份应用。
- 被测端：本任务构建的 `dist/test/mac-arm64/Zeus Test.app`，版本 `0.3.102`，身份 `dev.hypha.zeus.test`；独立数据目录为 `/tmp/zeus-0460-qa.AhLElM/user-data`，启动 PID 为 `68033`。未复制账户、正式数据库或其他任务数据。
- 控制端原生服务：`/Applications/Zeus.app/Contents/Helpers/Zeus Computer Service.app`，身份 `dev.hypha.zeus.helper.computer`，服务版本 `1.0`、构建号 `1`；二进制 SHA-256 为 `43153f315adcfd9b67ded1a96547de791e0fd34991a454f38182c0ae184a417c`。本轮拒绝发生在服务调用之前，这些是只读取得的安装信息，不代表原生服务实际执行了观察。
- 被测包 `app.asar` 的 SHA-256 为 `e4f1efff2e747d56c46df4c430614c793234e4c72bd494a2504de4afb32682b5`。
- 当前主屏为外接显示器 `3`；非主外接显示器为 `5`，逻辑边界 `(-1296,-490,1296,2304)`；启动使用 `ZEUS_TEST_DISPLAY_ID=5`，启动后核对实际落屏记录。
- 发现另一个任务 ZEUS-0456 的 Test 正在运行。当前代码按独立数据目录隔离单实例锁，工具支持绝对应用路径；本轮按本任务绝对路径和启动 PID 核对目标进程，不使用共用应用名或 bundle ID 定位，不停止其他任务实例。工具未通过入口预检，因此没有目标窗口观察结果。
- 临时证据目录：`/tmp/zeus-0460-qa.AhLElM`。
- 已通读项目全部 `AGENTS.md`；未发现 `PROJECT-STYLE.md`、`CODE-GUIDELINES.md`、`DESIGN.md`。

## 固定方法与计时口径

1. 定位同一个搜索框，在每次计时前恢复空值并重新观察，固定输入 `ZEUS-0460 中文提速验证`。
2. 对照组分别发起输入、观察两次工具调用；组合组在一次 `functions.exec` 内顺序发起相同两步。输入操作、观察参数与截图数量保持一致。
3. 预热一次，然后按对照、组合交替执行三组；全部在当前 Astra 会话中完成，不改变模型设置。
4. 从输入调用开始计时，到包含截图的观察结果返回为止；对照组计入两次调用之间的模型等待，组合组不返回模型再发起观察。恢复、证据保存与结果解读不进入计时。
5. 记录总耗时、各工具耗时和模型往返次数，复用现有审计及原生阶段日志；无法拆分的时间明确标为未分解。
6. 文本与截图均确认成功的样本才进入中位数、范围与速度比较；失败单独记录。遇到用户接管、权限阻断或结果未知时停止该次操作，不自动重放。

优点是无需产品改动，可以直接测量减少模型往返的收益；限制是样本少、仅一个本地场景，且同一会话存在上下文与服务负载波动，不能推广为 Astra 与其他模型的速度差异。

## 验证结果

| 项目 | 实际结果 | 证据 |
| --- | --- | --- |
| 依赖准备 | `pnpm install --frozen-lockfile --offline` 通过，未修改锁文件或增加依赖 | `install.log` |
| 静态检查 | `pnpm lint`、`pnpm typecheck` 通过，架构检查通过 | `lint.log`、`typecheck.log` |
| 构建与打包 | `pnpm package:mac` 通过，包含完整 `pnpm build`；只生成 Test 身份应用和 DMG | `package.log` |
| 签名与身份 | 打包流程的严格嵌套签名检查通过；最终 bundle ID 为 `dev.hypha.zeus.test` | `package.log`、`environment.json` |
| 独立启动 | 本任务绝对应用路径与 PID 对应，独立数据库 `PRAGMA quick_check` 为 `ok` | `startup-check.json` |
| 首次落屏 | `matchKind=first-launch`，`targetDisplayId=5`，`actualDisplayId=5`，`corrected=false`，窗口边界为 `(-1268,268,1240,820)` | `app.log` 第一行 |
| 当前会话工具预检 | `zeus_computer.list_apps` 被本轮能力门禁拒绝；尚未调用原生服务 | `preflight-tool.json` |
| 预热与测量 | 预热 0 次，对照组 0 次，组合组 0 次；有效样本 0，计时场景失败 0，工具预检拒绝 1 次 | 未产生可比较数据 |
| 截图与文本核验 | 未执行；不以启动日志、数据库或打包成功替代 GUI 证据 | 无截图证据 |

上表证据文件均位于 `/tmp/zeus-0460-qa.AhLElM`。构建中原有依赖脚本提示及前端打包警告不影响命令退出成功，不作为电脑操作已通过的依据。

### 实际阻断与第二项已确认限制

当前会话的真实工具返回：

```text
Zeus dynamic tool failed: Computer Use 仅在 Composer 为本轮明确启用后可调用。
```

当前源码 `packages/local-server/src/codexDynamicToolApplication.ts:201` 对应错误码为 `ZEUS_COMPUTER_NOT_REQUESTED`。检查发生在工具 Broker 调用之前，因此没有本次控件读取、截图或原生阶段耗时；工具拒绝返回的时间不计入速度样本。用户的任务授权已经明确，但产品仍要求本轮输入框的 Computer Use 能力开关，代理不能通过改数据库或其他调用通道代为打开。

另有独立限制：只读检查实际已安装的控制端 `app.asar`，确认它使用 `qaMode: isTestDistribution() && process.env.ZEUS_COMPUTER_QA_MODE === '1'`。当前控制端是正式 Zeus，因此验收模式为关闭。原生服务的 `rejectSelf` 只在显式验收模式中放行其他 Test 实例，普通模式拒绝所有 Zeus 目标，对应 `ZEUS_COMPUTER_ZEUS_CONTROL_BLOCKED`。

第二项由已安装控制端代码及当前原生源码确认，证据为 `controller-qa-guard.txt` 和 `apps/desktop/native/ComputerService.swift:369`；本轮因第一项先行拒绝，未实际执行到第二项原生错误。只在当前正式会话勾选 Computer Use，仍不足以完成原计划。

### 结论与续跑条件

本轮没有取得任何速度样本，不能声称组合调用已提速，也不能据此决定提高采集帧率或重做控件读取。现阶段继续优化本地采集缺少测量依据，应先让对照场景通过现有工具边界。

严格保留原定 Test 目标与 `zeus_computer` 通道，需要从另一个独立、开启 `ZEUS_COMPUTER_QA_MODE=1` 的 Test 控制端内发起 Astra 会话，并为该轮在输入框启用 Computer Use；控制端不能控制自身，必须与本任务被测窗口分属不同 PID 和独立数据目录。认证只能在该独立控制端正常完成，不复制正式凭据。

该续跑方式的优点是使用现有验收能力、不修改产品门禁；代价是更换会话控制端并准备独立认证环境，因此不在本轮擅自扩展为新测量架构。原计划把正式控制端直接操作 Test 目标视为可行，环境检查现已证明此前假设不成立。

### 收尾

本轮启动的 PID `68033` 已退出，本任务应用路径下无残留进程；退出后独立数据库 `PRAGMA quick_check` 仍为 `ok`。正式控制端 PID `49275` 与其他任务 Test PID `80765` 均仍运行，未受本轮清理影响。证据为 `cleanup-check.json`。

仓库只新增本文档；无产品代码、接口、依赖或 Git 历史变更。`git diff --check` 通过；新增文档已完整复读，未将工具拒绝、启动日志或旧任务截图表述为性能或 GUI 通过。

## 用户要求继续后的复查

2026-09-07 用户续发“继续”后，在新轮次对 `zeus_computer.list_apps` 做了一次入口检查，仍返回“Computer Use 仅在 Composer 为本轮明确启用后可调用”。记录为 `/tmp/zeus-0460-qa.AhLElM/resume-preflight-tool.json`。这是新轮次的只读预检，不是自动重放界面动作；累计入口拒绝两次，预热和速度样本仍为零。

同时确认正式控制端仍为 `0.3.102`；本任务 Test 包归档摘要与上轮完全一致，无需重复构建。没有重新启动应用或尝试其他控制通道。用户已经授权任务，但本轮产品能力开关仍未开启；需要在输入框实际启用 Computer Use，不能仅靠再次发送“继续”改变开关。原计划针对 Zeus Test 的控制端身份限制也仍适用。

## 调整 TextEdit 场景后的真实调用

### 已确认的范围调整

用户展示的设置截图确认 Computer Use 全局开关、辅助功能和录屏授权均已开启。早期拒绝只能说明执行端不认可相应轮次的启用标记，不能笼统归咎于用户未授予系统权限。设置说明“启用后，AI 可以按需操作其他应用”没有解释逐轮启用要求，存在说明与实际使用规则不一致的问题；本任务未修改该产品规则。

随后建议将目标改为 TextEdit 的新建纯文本文档，并继续使用当前会话的 `zeus_computer`，用户于 16:02 续发“继续”。据此，本轮采用普通应用输入与读取场景，不再要求 Test 控制端或操作 Zeus 窗口；Astra、逐步／组合调用、预热及三组对照的要求不变。优点是复用现有普通应用控制能力；限制是只验证工具组合收益，不验证 Zeus 页面。

### 本轮实际结果

本轮调用仍停留在 `list_apps` 入口预检，尚未启动 TextEdit、创建文档或输入文字，也没有通过其他通道完成替代操作。

| 证据项 | 实际记录 |
| --- | --- |
| 本轮提交 | `2026-09-07T08:02:01.061Z`，`computerUseRequested=true` |
| 当前模型及会话权限 | `gpt-6-astra`，`permission_mode=full-access` |
| 工具审计开始 | `2026-09-07T08:02:07.661Z`，`zeus_computer.list_apps` |
| 工具审计失败 | `2026-09-07T08:04:07.663Z`，`ZEUS_NATIVE_TOOL_TIMEOUT` |
| 审计工具耗时 | `120002 ms` |
| 外层调用观察耗时 | `120019 ms`，包含转发和返回开销；不作为成功测速样本 |
| 工具原文 | `Zeus dynamic tool failed: Zeus 原生工具调用超时：zeus_computer.list_apps` |
| 累计预检 | 早期启用标记拒绝 2 次，本轮超时 1 次；有效速度样本仍为 0 |

证据为 `/tmp/zeus-0460-qa.AhLElM/textedit-preflight-tool.json` 和 `textedit-runtime-audit.json`。后者仅摘录当前任务的会话身份、启用标记与工具审计，没有保存消息正文或账户凭据。

### 只读定位与证据边界

- 超时由共享工具 Broker 的 120 秒保护返回，记录已证明当前轮次通过启用检查并进入实际原生工具调用链。因此不能再把本轮失败解释成未开启 Computer Use。
- 当前原生服务 PID 为 `79266`，父进程为正式 Zeus PID `49275`；服务于 15:57:06 启动。16:06:09 的一秒采样显示请求线程在 `readLine` 等待输入，主线程在 AppKit 事件循环。此采样发生在超时之后，只能说明采样时没有正在进行的控件遍历，不能证明两分钟前请求从未进入 Helper。
- 对正式 Zeus 主进程也取得一秒采样，作为事件循环诊断旁证；没有执行附加代码、修改内存或操纵窗口。
- 执行宿主只读健康接口返回 PID `49280`、版本 `0.3.102`、`uiLease.connected=true`，最近心跳为 `2026-09-07T08:06:57.640Z`。只保存去除凭据的状态摘要；这不能证明失败时每一段工具转发均正常。
- 当前服务端单次 Helper 请求有 35 秒保护，外层工具却走到 120 秒超时；应继续区分桌面转发、排队、调用发送与结果返回各段。现有审计没有分段记录，不能从本次现象直接断言是截图帧率、模型推理或某个确定的原生接口卡住。

对应证据为 `computer-service.sample.txt`、`controller-main.sample.txt`、`execution-host-health.json`。没有重启正式 Zeus、结束现有电脑服务、修改正式数据或重放该工具调用。

### 当前结论

本轮已经解除最初的启用标记阻断，但暴露了真实工具超时。当前没有成功输入或截图样本，不能给出中位数、范围或提速比例，也没有依据优先提高采集帧率。

继续推进需先排查并处理 Computer Use 超时。产品代码变更超出用户已确认的“先测量，不改产品代码”范围，本轮仅完成只读定位与证据记录，未擅自实施修复。

## 基础调用故障修复

### 范围与根因

用户明确要求先修复，允许修改本次故障涉及的产品代码；原先“先测量、不改产品代码”的限制在本阶段被该指令替代。此次只修改共享代理及设置说明，没有修改接口、依赖、原生采集、模型设置或授权规则。

现有调用链为：工具 Broker → 执行宿主内共享代理 → Electron 本地 HTTP 桥 → 浏览器宿主或 ComputerHost → 原生服务。浏览器和电脑工具使用同一份连接登记。检查了共享代理的全部引用和登记入口：连接登记由 `localServerRuntime.ts` 发起，`executionHost.ts` 在界面接入、断开或心跳过期时更新。

故障位于 `apps/desktop/src/main/browserAutomationBridge.ts`：一次浏览器调用抛错、HTTP 失败或响应无效时，旧代码清空共享登记并等待重新登记后重试。然而执行宿主的界面租约仍有效，正常心跳不会重新登记。因此后续浏览器和电脑工具都等待一个不会发生的重连，最终被外层 120 秒保护截断；如果期间真的重连，还可能重放已执行的浏览器动作。

现场旁证：当前正式进程启动后，浏览器工具在 `07:25:53.618Z` 的一次点击开始出现 120 秒超时，之后多个会话的浏览器读取也持续超时；本会话电脑枚举在 `08:02:07.661Z` 开始后同样超时，而之后健康接口仍显示界面租约已连接。证据为 `browser-audit-since-launch.json`、`computer-audit-since-launch.json` 和 `execution-host-health.json`。仅保存工具审计元数据，未保存其他会话正文。最初点击内部抛错的具体原因没有保留下来，因此不把该细节当作已证实事实；可控运行已确定复现上述共享状态故障。

修复前可控复现使用真实本地 HTTP 桥，只让第一个浏览器请求抛错：150 毫秒后共享登记变为 `null`，电脑枚举继续等待，服务端只收到 1 次请求；人为恢复诊断桥的登记收尾后，服务端累计收到 3 次请求，原浏览器请求被重放。证据为 `bridge-before-fix.json`。该人为恢复仅发生在隔离诊断桥，没有修改正式执行宿主或替用户重放真实动作。

### 实际改动与取舍

- 删除共享代理中的两次尝试循环及调用错误时的 `register(null)`；单次错误直接返回，后续工具仍使用当前有效登记。真正离线和重新连接继续复用既有界面租约生命周期。
- 浏览器与电脑动作均不由代理自动重放；保留电脑调用原有“动作结果未知”错误语义。控制权、逐轮启用、用户接管、敏感操作审批与系统权限检查保持原有边界。
- 设置页中英文说明补充：全局启用且授予 macOS 权限后，还需在发送消息前输入 `/` 并选择 Computer Use，为本轮启用。现有输入框菜单已经写明“仅为本轮启用”，无需新增入口。

优点是单次页面失败不再拖死其他会话的浏览器及电脑操作，原始错误可及时返回，并消除自动重放风险；删除错误恢复分支，复用现有连接生命周期，无需新的重连机制。代价是失败请求不会自动重试，调用方需要根据结果先检查状态，再决定是否发起新的调用。真正的界面离线仍沿用既有等待时限，本次没有据此缩短所有超时或调整本地采集。

### 修复验证

| 验证层 | 结果 | 证据 |
| --- | --- | --- |
| 真实本地 HTTP 桥、工具 Broker 与本任务签名原生服务 | 注入浏览器错误后，约 `16.07 ms` 返回原始错误；同一登记下原生 `list_apps` 约 `86.34 ms` 成功枚举 18 个应用，浏览器请求只送达 1 次 | `fix-native-probe/result.json` |
| 错误与重连边界 | 正常失败结果、无效响应、电脑异常均保留登记；旧连接迟到错误不清除新登记；真正离线后可重新登记；TCP 断开不自动重放，后续独立调用成功 | `fix-bridge-boundaries.json`，6 项通过 |
| 静态检查 | `pnpm lint`、`pnpm typecheck` 通过，架构检查通过 | `fix-lint.log`、`fix-typecheck.log` |
| 构建与打包 | `pnpm package:mac` 通过，包含完整 `pnpm build` 与签名检查 | `fix-package.log` |
| 打包内容 | Test 身份正确；归档内共享代理与本任务编译产物逐字节一致，已包含修复 | `fix-package-identity.json` |
| 独立启动与首次落屏 | 新独立目录 `fix-user-data`，PID `8423`；`first-launch`、目标屏与实际屏均为 `5`、`corrected=false`；数据库完整性检查通过 | `fix-launch.json`、`fix-startup-check.json`、`fix-app.log` |
| 收尾 | 仅退出本次启动的 PID `8423`，本任务应用路径下无残留进程，独立数据库完整性检查仍通过 | `fix-cleanup-check.json` |
| 文档运行命令 | 下方原样命令执行通过；改动文件格式检查及 `git diff --check` 通过 | `fix-documented-check.log` |

原生枚举检查采用隔离的 ComputerHost 设置和本任务签名 Helper；Node 导入时仅为未使用的 Electron UI 导出提供占位，未调用界面 API、未绕过正式会话的授权检查，也未触发其他应用操作。这是内部链路的真实 HTTP 与原生服务运行证据，不能替代当前会话动态工具、界面输入或截图验收。上述毫秒数不包含 Astra 模型往返，不能与之前的 120 秒失败组成提速结论。

### 可重复的最小运行检查

构建后在任务根目录运行以下命令。它只启动临时回环桥，使用现有 Broker 的两秒诊断时限，确认浏览器错误不会清空电脑工具所需的连接。旧实现会在错误断言处失败；没有新增检查文件、依赖或门禁。

```sh
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { startDesktopBrowserAutomationBridge, createReconnectableBrowserAutomationProxy } from './apps/desktop/dist/main/browserAutomationBridge.js';
import { createZeusToolBroker } from './packages/local-server/dist/zeusToolRegistry.js';
// 记录请求送达次数，防止失败动作被重放。
let delivered = 0;
// 可控端仅让第一个请求失败，不操作真实应用。
const bridge = await startDesktopBrowserAutomationBridge({
  async invoke() {
    delivered += 1;
    if (delivered === 1) throw new Error('可控页面错误');
    return { success: true, contentItems: [] };
  },
});
// 运行现有代理和 Broker，不复制产品逻辑。
const proxy = createReconnectableBrowserAutomationProxy();
// 诊断超时防止旧实现等待完整的产品超时。
const broker = createZeusToolBroker(proxy, { timeoutMs: 2_000 });
// 临时连接只用于本命令。
const registration = { leaseId: 'diagnostic', baseUrl: bridge.baseUrl, token: bridge.token };
// 固定请求身份不引用用户会话。
const base = { conversationId: 'diagnostic', threadId: 'diagnostic', turnId: 'diagnostic', callId: 'diagnostic', arguments: {} };
proxy.register(registration);
try {
  await assert.rejects(broker.invoke({ ...base, namespace: 'zeus_browser', tool: 'click' }), /可控页面错误/);
  assert.equal(proxy.currentLeaseId(), registration.leaseId);
  assert.equal((await broker.invoke({ ...base, namespace: 'zeus_computer', tool: 'list_apps' })).success, true);
  assert.equal(delivered, 2);
  console.log('通过：错误直接返回，连接保留，动作没有重放。');
} finally {
  // 释放旧实现可能留下的等待者，仅用于诊断收尾。
  proxy.register(registration);
  await bridge.close();
}
JS
```

### 交付状态与后续测速边界

修复已写入当前任务分支，产品改动共两个文件，本文档保留全过程和可复查命令。新 Test 包的 `app.asar` SHA-256 为 `378901748aac6594c41d7f5b8d700ac0af981f069f320227d65296497897e5b5`，产物位于 `dist/test/mac-arm64/Zeus Test.app`；全部原始验证证据仍在 `/tmp/zeus-0460-qa.AhLElM`。没有提交、合并、推送或替换正式安装。

收尾时再次只读核对 `/Applications/Zeus.app`：正式主进程 `49275`、执行宿主 `49280` 仍运行，安装版本为 `0.3.102`，归档内仍有旧重试循环及调用失败时清空登记的代码，证据为 `fix-controller-boundary.json`。本任务 Test 包包含修复，不代表当前会话使用的正式控制端已经更新；后续真实会话复测需要确认执行宿主也已加载修复。

当前已完成故障修复及上述验证；尚未完成当前会话工具的界面输入、文本与截图核验，没有新增测速样本。预热、对照和组合组的有效样本均为 0，无法报告中位数、范围或速度收益。现阶段不值得先改本地采集实现，应在更新后的控制端跑通操作场景，再恢复已确认的 Astra 对照试跑。入口连通性检查的毫秒数据不作为性能优化收益。

## 设置开关切页后恢复关闭

### 新反馈与处理范围

用户补充设置截图并反馈：点击切换开关后，离开设置再回来，开关仍为关闭。该反馈属于已授权的基础使用问题修复范围，沿用本任务与文档。

检查确认 `BrowserSettingsPane.tsx` 的六个浏览器开关共用 `setBoolean`，旧逻辑只修改 React 页面临时状态，没有调用保存接口；只有页底“保存浏览器设置”按钮才提交。离开页面后草稿销毁，再进入就读取实际保存的旧值。这是显示状态与生效状态不一致的交互缺陷，不应要求用户靠猜测找到页底保存按钮。

同页 Computer Use 开关使用独立的 `setComputerEnabled`，已经调用 `updateComputerSettings` 并在主进程写入独立设置文件；代码没有发现相同的“只改页面临时值”路径。因此本次不能把浏览器开关的根因直接扩大为 Computer Use 系统权限保存失败。

### 修复方式与取舍

六个浏览器开关统一在点击后调用现有 `updateBrowserSettings({ [key]: value })`，只提交本次字段；接口确认保存后才用返回值更新开关显示。保存期间复用已有忙碌状态禁止重复切换，失败走现有错误提示；网站全开放和完整 CDP 的开启确认仍保留。状态更新使用当前页面值，只覆盖本次开关，避免覆盖或顺带提交尚未保存的下载目录等输入。

页面中英文说明明确“开关修改后立即保存，其他设置点击保存浏览器设置”，开关成功提示只说“开关设置已保存”。优点是开关显示与保存确认一致、切页后可读取已保存状态；代价是开关会等待保存返回才变化，其他编辑项仍使用原有保存按钮。没有扩展为全页面自动保存，没有新增保存服务或依赖。

### 实际验证结果

| 项目 | 结果 | 证据 |
| --- | --- | --- |
| 六个开关分别开启与关闭 | 12 次局部更新均通过；保存返回、重新读取、磁盘文件与重新实例化恢复均保留对应值 | `switch-persistence/result.json` |
| 其他字段与站点授权 | 每次返回值与旧设置仅有当前开关不同；下载目录保持原值，允许所有站点的持久授权规则随开关一致变化 | 同上 |
| 静态检查 | `pnpm lint`、`pnpm typecheck`、改动文件格式检查及 `git diff --check` 通过 | `switch-lint.log`、`switch-typecheck.log` |
| 最新构建与打包 | `pnpm package:mac` 通过，包含完整构建与严格签名检查；仅生成 Test 身份产物 | `switch-package.log` |
| 打包内容 | 归档内共享代理仍与修复后的编译产物一致，包含新的开关保存提示 | `switch-package-identity.json` |
| 当前正式设置只读核对 | Computer Use 的已保存值为 `enabled=true`；允许所有网站也已保存为开启，完整 CDP、Chrome、Edge 与询问保存位置为关闭 | `switch-installed-state.json` |

开关写盘检查调用真实 BrowserHost 设置处理器、文件落盘与恢复实现；Electron 窗口、IPC 传输与命令账本为隔离诊断占位，外部浏览器配置器未启用。它确认现有局部保存接口可用，**不代表已执行真实设置页点击、切页、保存失败提示或 Chrome/Edge 扩展连接验收**。前端各分支与六个调用入口已逐项核对；没有运行新的浏览器通道替代当前被阻断的 GUI 工具。

新增改动仅在已有 `BrowserSettingsPane.tsx` 中，继续保留前一阶段共享连接修复。最新 Test 包的 `app.asar` SHA-256 为 `561b73db5662518a0dbb65fa2fd128911927d4238816386fdb762610f9d307dc`，替代前阶段同路径的包；此阶段没有重新启动 GUI，上一阶段首次落屏记录只对应当时的包。

更新正式控制端后，实际页面验收应逐个切换六个开关，等待保存完成，再切换页面返回；同时验证两个权限确认取消时不保存、下载目录草稿不随开关提交，以及保存失败时不显示成功状态。Computer Use 已采用独立即时保存，本次未发现同一缺陷，也没有修改其授权与保存代码。当前修复尚未合并、发布或替换用户正式应用，原 Astra 提速试跑仍待真实工具链复测后进行。

### 交付一致性核对

用户续发“开始修复”后，再次核对当前工作区，确认上述两项修复已经实际写入产品文件。最新 Test 包内共享代理与当前编译文件一致，全部 65 个页面产物也逐字节一致；归档摘要仍为 `561b73db5662518a0dbb65fa2fd128911927d4238816386fdb762610f9d307dc`。证据为 `delivery-check.json`，`git diff --check` 通过。代码未再变化，因此复用已经通过的静态、构建和运行检查，没有重复生成无新增信息的验证结果。

正式主进程 `49275` 与执行宿主 `49280` 仍是原先运行的实例，安装版本仍为 `0.3.102`。当前交付是已修复代码和对应 Test 包；正式应用生效需要后续明确的合入与更新操作。代码修复、安装生效、真实 GUI 通过和 Astra 测速四个状态分别记录，不能相互替代。
