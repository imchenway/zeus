# ZEUS-0100 Zeus 独立用户目录与 Codex 配置导入

## 任务背景

用户发现通过 Pi 使用 DeepSeek 时，Codex 目录中的项目指令、技能和插件看起来没有生效。根因不是 DeepSeek 模型本身忽略配置，而是 Codex App Server 与 Pi 是两套独立运行内核：两者可以共享 Zeus 的产品会话，但不会天然共享 `CODEX_HOME`、Pi 配置目录或原生 JSONL。

## 已确认目标

Zeus 使用自己的 `~/.zeus` 根目录，统一管理应用数据、Codex 运行目录、Pi 运行目录、导入记录和原生会话。Codex App 的 `~/.codex` 只作为用户主动触发的一次性导入来源，不再作为 Zeus 运行时的共享目录。

导入方向固定为：

```text
Codex App ~/.codex -> Zeus ~/.zeus -> Codex App Server / Pi
```

不支持 Pi 反向写回 Codex App，也不使用双向同步。

## 领域边界

| 对象 | 权威来源 | 说明 |
| --- | --- | --- |
| Zeus 产品数据 | `~/.zeus` | 项目、任务、统一会话索引、设置、日志和附件 |
| Zeus 内的 Codex 原生数据 | `~/.zeus/agent-runtimes/codex` | 正式版专属 `CODEX_HOME`，保存 Codex 配置和 JSONL；测试与开发环境使用完全独立的根目录 |
| Zeus 内的 Pi 原生数据 | `~/.zeus/agent-runtimes/pi` | 正式版保存 Pi 配置、包和 JSONL；测试与开发环境使用完全独立的根目录 |
| Codex App 数据 | `~/.codex` | 仅作为导入来源，Zeus 不直接续写 |
| 模型密钥 | macOS 钥匙串 | 不写入 `.zeus` 的普通文件、数据库、日志或 JSONL |

正式版直接使用 `~/.zeus`；`Zeus Test.app` 使用 `~/.zeus-test`；开发环境使用 `~/.zeus-development`。三者必须拥有不同数据库、运行目录、会话和单实例锁，并且不互相嵌套。

## 建议目录布局

```text
~/.zeus/
  zeus.db
  zeus.config.json
  agent-runtimes/
    codex/
      config.toml
      AGENTS.md
      rules/
      skills/
      plugins/
      sessions/
    pi/
      config/
      packages/
      sessions/
  imports/
    codex/
  logs/
  attachments/
```

```text
~/.zeus-test/          Zeus Test.app
~/.zeus-development/   开发服务器
```

测试版和开发服务器不得读取或迁移正式版数据。

环境变量 `ZEUS_USER_DATA_DIR` 继续作为开发、验收和故障恢复时的显式覆盖。覆盖后不得回写默认正式目录。

## Codex 一键导入范围

默认导入以下可解释、可审计的配置：

- `config.toml` 中的模型、推理、服务档位、MCP 和普通偏好；
- 全局 `AGENTS.md`、`rules/` 和 `prompts/`；
- `skills/` 与 `plugins/`；
- 与配置相关但不包含明文密钥的元数据。

默认不导入：

- `auth.json`、OAuth 缓存、钥匙串导出和任何明文密钥；
- `sessions/`、`archived_sessions/`、历史索引和数据库；
- 临时文件、日志、缓存、锁文件、进程状态和工作区副本；
- Codex App 自身界面状态、浏览器登录态和设备绑定。

Codex 历史会话属于单独的“导入历史会话”能力，不与“导入配置”按钮混在一起。这样用户不会因为导入配置而意外复制大量 JSONL 或误以为手机端 Remote 已经接管 Zeus 会话。

## 导入行为

1. 导入前扫描来源，展示允许导入和被跳过的项目。
2. 首次导入默认复制到临时目录并完成校验，然后原子替换目标配置快照。
3. 再次导入会用 Codex 快照替换允许导入的同名 Zeus 配置，并在 `imports/codex` 下保留原配置备份；会话、认证和其他运行数据不参与替换。
4. 每次导入保存来源路径、时间、文件摘要、结果和失败原因，但不保存密钥正文。
5. `config.toml` 中明确指向来源 `~/.codex` 的绝对路径会改写为 Zeus 专属 Codex 目录，避免导入后继续暗中依赖 Codex App 数据。
6. 导入完成只影响新建会话；正在执行的 Codex 或 Pi 会话继续固定在原运行实例和原配置快照。
7. Pi 不直接读取 Codex 格式。Zeus 只把可翻译的通用内容投影给 Pi；无法安全翻译的 Codex 专属 MCP、插件钩子或审批语义标记为“不适用于 Pi”。

## `AGENTS.md` 生效规则

- 项目目录内的 `AGENTS.md` 继续由具体运行内核按当前工作目录读取；它不需要复制进 `.zeus`。
- Codex 全局 `AGENTS.md` 导入到 Zeus 专属 Codex 目录后，仅对 Zeus 启动的 Codex App Server 生效。
- Pi 的全局 `AGENTS.md` 指向 Zeus 专属 Codex 目录中的导入快照，同时仍按项目工作目录读取项目 `AGENTS.md`。
- Codex 的 `skills/`、`plugins/` 和 `config.toml` 不会冒充 Pi 原生资源；当前 Pi 继续关闭未经兼容验证的扩展、技能和提示模板。
- Zeus 必须记录指令来源，避免同一份项目说明既被运行内核自动读取，又被 Zeus 重复注入。

## 优缺点

### 优点

- Zeus 的配置、会话、备份和故障恢复边界清晰，不会被 Codex App 的升级或清理悄悄改变。
- Codex 与 Pi 保留各自原生 JSONL，可以安全恢复，不需要伪造或互转会话格式。
- 一键导入降低迁移成本，同时保留导入记录和冲突说明。
- 正式版与测试版可以在同一个 `.zeus` 根下保持物理隔离。

### 缺点

- Codex App 后续新增配置不会自动同步到 Zeus，需要用户再次导入。
- 配置、插件和技能会产生副本，占用额外空间，并需要处理升级与冲突。
- Codex 专属插件不保证能在 Pi 中运行；Zeus 只能复用兼容资源或提供明确降级。
- ChatGPT 手机端 Remote 不会自动识别 Zeus 或 Pi 的 JSONL；移动端远程控制仍需 Zeus 自己的远程入口。

## 实施阶段

1. 建立 `.zeus` 根目录、正式/测试 profile 与首次数据迁移。
2. 为 Codex App Server 注入 Zeus 专属 `CODEX_HOME`，为 Pi 指定独立配置和会话目录。
3. 增加 Codex 配置扫描、预览、导入、审计和失败回滚接口。
4. 在设置页提供“一键从 Codex 导入”，把配置导入与历史会话导入分开。
5. 使用静态检查、构建和 `Zeus Test.app` 真实运行检查验证目录隔离、导入结果与新会话生效情况。

## 当前事实

截至本次实现记录：

- 正式版已直接使用 `~/.zeus`，测试版和开发环境分别使用 `~/.zeus-test`、`~/.zeus-development`；显式 `ZEUS_USER_DATA_DIR` 仍优先；
- 首次迁移会保留旧 Electron 用户目录，只复制稳定数据，不复制执行宿主和 Chromium 单实例锁；旧执行宿主仍运行时延后迁移；
- 已为执行宿主注入 Zeus 专属 `CODEX_HOME`；
- Pi 配置与会话已收敛到 `agent-runtimes/pi`，旧 Pi 目录首次读取时复制迁移并保留原件；
- Pi 全局 `AGENTS.md` 已投影到同一份 Zeus 管理快照；Pi 内置工具保持关闭，Zeus broker 提供的受控工具不再被一起误关；
- 设置页已把“Codex 配置导入”和“历史会话导入”分开；
- 配置导入会预览允许项，拒绝外部软链接和明显包含密钥赋值的 `config.toml`，覆盖前保留备份，失败时回滚；
- 导入不会复制 `auth.json`。Zeus 专属 Codex 账号登录仍是独立步骤，本任务没有把认证文件伪装成普通配置。

## 验证记录

- `pnpm typecheck`：通过；
- `pnpm lint`：通过；
- `pnpm build`：通过；
- `pnpm package:mac`：已生成独立身份 `Zeus Test.app`；
- 使用显式临时 `ZEUS_USER_DATA_DIR` 启动最终打包应用：已真实生成 Codex 与 Pi 独立目录，Pi 全局 `AGENTS.md` 正确指向 `../../codex/AGENTS.md`，Local API 正确返回导入预览；
- 对本机 `~/.codex` 执行隔离导入探针：`config.toml`、`AGENTS.md`、`rules`、`prompts`、`skills`、`plugins` 均成功复制，6 处来源绝对路径均改写到临时 Zeus Codex 目录；
- 未点击设置页按钮完成 GUI 交互验收，未使用真实账号新建 Codex/Pi 会话，未验证 ChatGPT 手机端 Remote。

静态门禁、打包启动和隔离导入已经验证；真实账号、真实新会话和 GUI 点击仍需单独验收，不能与上述结果混为完整用户验收。
