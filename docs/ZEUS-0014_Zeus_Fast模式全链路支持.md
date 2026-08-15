# ZEUS-0014 Zeus Fast 模式全链路支持

## 目标

Zeus 以 Codex app-server `model/list` 返回的 `serviceTiers[].id = "priority"` 作为 Fast 的唯一能力事实，把用户请求、实际下发和 Provider 实际采用的服务档位分开记录。用户的显式选择按项目和模型身份持久化；不支持 Fast 时会话继续按 Standard 运行，并在会话内留下明确、可恢复的系统提示。

Fast 不改变模型，也不改变 reasoning effort。Standard 固定下发 `serviceTier: null`，Fast 固定下发 `serviceTier: "priority"`。

## 当前差异

- 现有运行链路已经解析 `model/list.serviceTiers`，并在 `thread/start`、`turn/start`、Provider 设置与用量快照中携带 `serviceTier`。
- 现有界面仍会根据 `fast` ID 或显示名称猜测 Fast，未严格限定为 `priority`。
- 速度偏好混在按项目和会话类型划分的 `localStorage` 中，且 Standard 可能在用户未操作时被自动写入。
- 已知不支持的服务档位会被静默归一化为 Standard，没有可持久化的会话提示。
- 下一轮选择和 Provider 实际采用的档位尚未形成独立、完整的历史事实。

## 已确认决策

- 偏好粒度为项目和模型身份；同名模型使用模型来源 ID 区分。
- 偏好保存在后端项目配置中，只有用户显式选择 Standard 或 Fast 时才写入。
- 不迁移旧 `localStorage` 速度值；既有会话已经持久化的下一轮设置继续兼容。
- 自动降级不改写 Fast 偏好；每次实际降级都追加一条与提交绑定的持久系统提示。
- 新模型没有偏好时使用 Standard，但不因此产生偏好记录。
- 不新增数据库列，不新增或恢复单元测试体系。

## 实施记录

### 2026-08-15 需求与现状核对

- 本机 `codex-cli 0.147.0` 的生成协议包含 `model/list.serviceTiers`、`thread/start.serviceTier`、`turn/start.serviceTier`、线程恢复响应与设置通知中的 `serviceTier`。
- 隔离 `model/list` 探针显示当前支持 Fast 的 Codex 模型声明目录 ID `priority`，不支持模型的 `serviceTiers` 为空。
- 项目配置当前保存在本地服务端设置 JSON 中，适合扩展项目模型速度偏好，无需数据库迁移。

### 2026-08-15 实现

- 项目配置新增 `serviceTierPreferences`，记录模型来源 ID、模型 ID 与用户显式选择；专用接口按单模型原子覆盖并写入审计。普通项目配置保存主动忽略这张表，避免旧界面快照误覆盖。
- Renderer 的任务推送、项目会话、既有会话、冲突处理和代码审查统一读取项目模型偏好。旧 `localStorage` 速度值不再读取或写入，模型、推理强度、权限和工作模式等旧偏好继续兼容。
- 恢复会话时 Provider 原有设置只作为历史实际事实展示；没有项目偏好和旧下一轮速度记录时，下一轮固定回到 Standard，不会把上一轮实际 `priority` 反向当成用户意图。
- Fast 能力与下发只接受精确 `priority`；Standard 始终为 `null`。模型目录名称、`fast` 别名和其他速度字段不参与判断，服务档位不会修改模型或 reasoning effort。
- 提交输入 JSON 保存 `requestedServiceTier`，调度上下文保存实际下发的 `serviceTier`，Provider 设置与用量快照保存 app-server 实际档位；未新增数据库列。
- 明确的 service-tier 不支持错误只允许按同一提交、同一客户端消息和同一正文以 `null` 重试一次。超时、断线、进程退出和不明确错误不进入该分支。
- 已知不支持、app-server 明确拒绝、Provider 实际采用 Standard 三类降级都记录到提交 JSON，并在对应用户消息落库后追加系统提示。提示使用提交 ID 与原因生成稳定 Provider item ID，刷新和恢复时去重，不冒充智能体回答。
- 模型设置界面把下一轮意图与 Provider 实际档位、计费用量档位分开。已记住 Fast 但模型失去能力时显示“Fast（已记住，当前不可用）”，实际继续按 Standard，下层偏好不被自动改写。

## 验收记录

### 静态门禁与构建

- `pnpm install --frozen-lockfile --offline`：通过，未修改锁文件。
- `pnpm lint`、`pnpm typecheck`、`pnpm build`、本次变更文件 Prettier 检查和 `git diff --check`：通过。构建只有既有的大分块提示。
- 没有新增或恢复单元测试、组件测试、DOM/CSS 契约测试或测试依赖。

### 当前 app-server 协议探针

探针直接启动本机 `codex-cli 0.147.0` app-server，使用临时 cwd 与临时 thread：

- `model/list` 中 `gpt-5.6-sol` 精确声明 `serviceTiers=["priority"]`；`gpt-5.4-mini`、`gpt-5.3-codex-spark` 返回空列表。
- Standard 的 `thread/start` 与 `turn/start` 均存在 `serviceTier: null`，Provider 初始实际档位为 `default`。
- Fast 的 `thread/start` 与 `turn/start` 均为 `serviceTier: "priority"`，Provider 初始实际档位为 `priority`。
- 两轮都使用 `gpt-5.6-sol` 和 `medium` reasoning，没有通过换模型或降低 reasoning 冒充 Fast。

### 真实 Local Server、真实 Provider 与持久化

使用本轮构建的 Local Server、真实 app-server、独立临时数据库与临时项目执行：

| 场景 | 结果 |
| --- | --- |
| 项目模型偏好 | 模型甲保存 Fast、模型乙保存 Standard；专用审计 2 条；未操作模型无记录；普通配置保存无法清空偏好表 |
| 重启恢复 | 关闭并用同一隔离数据库重建 Local Server 后，两条偏好原样恢复 |
| Fast | 正常回答；提交请求 `priority`、调度下发 `priority`、Provider 设置与用量均为 `priority` |
| Standard | 正常回答；提交请求 `null`、`turn/start` 下发 `null`、Provider 设置与用量均为 `default` |
| 已知不支持 | `gpt-5.4-mini` 请求 `priority`，`thread/start` 与 `turn/start` 均下发 `null`；正常回答；设置与用量均为 `default` |
| 降级提示顺序 | 真实不支持场景中持久顺序为用户消息、系统提示、智能体回答；系统提示时间严格晚于对应用户消息 1 毫秒 |
| 刷新去重 | 同一提交多次读取仍只有一条 `model_unsupported` 系统提示 |
| 模型与推理强度 | 三种真实场景均保持请求模型；Fast 与 Standard 均保持 `medium` reasoning |

SQLite 只读复核确认提交输入的三层事实：Fast 为请求 `priority`/下发 `priority`，Standard 为请求 `null`/下发 `null`，已知不支持为请求 `priority`/下发 `null`。

### 隔离拒绝与实际降档探针

这两种边界不能要求真实 Provider 稳定制造，因此使用实现同一 app-server Manager 契约的隔离假 Provider 驱动完整 Local Server、提交仓储和会话投影，不写测试文件：

- 明确拒绝：首次 `thread/start(priority)` 返回 `-32602` 且明确指出 service tier 不支持；Zeus 只追加一次 `thread/start(null)`，`turn/start` 只执行一次并为 `null`，客户端消息 ID 与原正文保持唯一，轮次正常完成。提示原因是 `app_server_rejected`，刷新后仍为一条。
- Provider 实际降档：`thread/start(priority)` 与 `turn/start(priority)` 均只执行一次，Provider 设置返回 `default`；Zeus 不重试，轮次正常完成，设置与用量均记录 `default`。提示原因是 `provider_reported_standard`，刷新后仍为一条。
- 两个场景的模型均为原模型、reasoning 均为 `medium`，没有发生替换或降低。

### 测试包与真实桌面边界

- 最终源码重新执行 `pnpm package:mac`：通过，只生成 `dist/test/mac-arm64/Zeus Test.app` 与测试 DMG；`CFBundleIdentifier=dev.hypha.zeus.test`。
- 包健康检查输出 `rendererAssets=19`、Main、两个 Preload、更新助手均存在；当前打包策略为 `codex=user-installed`。严格 codesign 校验通过，属于本机 ad-hoc 签名，不等于 Developer ID 或 Apple 公证。
- 在最终恢复默认与提示顺序收紧前，曾使用独立 `ZEUS_USER_DATA_DIR` 启动本任务测试包；首帧真实窗口边界为 `x=-1196, y=-269, 1100×820`，完整位于非主外接竖屏 ID 3。这条证据只证明隔离身份、独立资料目录和外接屏首帧，不作为最终源码的功能 GUI 证据。
- 启动后发现系统中同时运行其他任务的多个同 bundle ID `Zeus Test` 实例。为避免界面操作归属失真，已只关闭本任务 PID 46319，没有继续点击或截图。因此 Fast 控件、跨入口切换和应用重启后的真实 GUI 恢复未宣称通过。
- 最终源码测试包生成后再次确认仍有 3 个其他任务的同身份实例运行，因此没有启动最终包，也没有干扰这些实例。
- 新建测试资料目录没有可复用的 Zeus Test Provider 登录；正式包内的 Provider 实际采用链路未验。真实 Provider 设置与用量链路由前述隔离 Local Server 探针覆盖，不能替代打包应用身份验收。

### 正式候选校验

- `pnpm verify:release`：通过；发布前门禁、12 节 139 项验收矩阵、生产构建、临时正式候选结构、DMG、Homebrew cask、发布清单与包健康检查均完成。
- 当前环境没有配置 Developer ID，正式候选只完成本机 ad-hoc DMG 签名校验，没有 Apple 公证；这是校验脚本明确报告的发布环境限制。
- 临时正式候选没有启动，没有向 macOS 登记额外生产身份应用，也没有执行生产发布。

## 尚未完成的真实验收

- 需要在没有其他同 bundle ID 测试实例运行、并具备独立 Zeus Test Provider 登录的环境中，补做 Fast 控件真实点击、模型切换、不同会话入口、应用冷重启、会话恢复与打包身份下 Provider 实际档位检查。
- 该缺口不影响静态构建、真实 app-server 协议、真实 Local Server/Provider、持久化与降级重试结论，但本任务不因此宣称“测试包 GUI 全链路通过”。
