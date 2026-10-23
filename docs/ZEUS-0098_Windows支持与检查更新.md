# ZEUS-0098 Windows 支持与检查更新

## 需求与范围

- 用户要求全面支持 Windows，明确反馈 Windows 点击“检查更新”没有反应。
- 用户已明确补充：覆盖所有功能，查实的 Windows 缺口都需要修复。更新作为首个故障入口，审查范围已扩展至全部功能类别。
- 已通读当前项目的 PROJECT-STYLE.md；项目文件扫描未发现其他 AGENTS.md、CODE-GUIDELINES.md、DESIGN.md。遵守会话提供的全局规则。
- 不编写或执行测试；静态检查、编译结果与两端实际运行结果分开记录。

## 排查结论

1. 原生菜单 → MainCommandLedger → 更新控制器 → 原生窗口。账本在执行更新动作前要求目录 mode 严格等于 0700、文件 mode 等于 0600，并使用 POSIX 目录 fsync；未按 Windows ACL 语义处理。这是源码可确认的 Windows 阻断点，尚无用户设备日志证明其为现场唯一原因。
2. 菜单丢弃更新 Promise，没有展示失败原因；工作区更新提示入口也未处理拒绝结果。
3. 自动检查正在进行时，手动检查会合流到后台任务；该任务可能不创建窗口，因此点击后仍没有可见反馈。
4. 原生窗口宿主只等待进程 spawn，尚不能证明窗口消息循环已就绪。

## 方案与取舍

- 复用 storage 的 Windows 安全助手：ACL 校验、拒绝重解析路径、带写穿透的原子文件发布；保留 macOS 现有权限和目录同步流程。
- 优点：在共享账本修复，覆盖菜单、更新提示、下载、安装、恢复及 Git、资源、文件、浏览器、电脑操作等账本调用方；不绕过写入标记和未知结果保护。
- 代价：Windows 安全检查依赖随包提供的原生助手，并增加进程调用；使用异步请求避免账本安全操作阻塞主线程。
- 手动入口应立即展示当前状态，后台检查继续共用同一任务；失败应给出可见原因。继续复用现有 AppKit/WinForms 窗口，不另建更新界面。

## 已完成实现

- MainCommandLedger 的 Windows 目录改用异步原生 ACL 操作；文件以私有同目录暂存项写入，内容同步后通过既有原生写穿透移动发布。不可变记录禁止覆盖，状态记录允许原子替换；未知结果不会自动重试。
- Windows 文件读取继续有界，并复用真实句柄、路径身份和 ACL 检查；没有把“忽略 mode”当作权限验证。macOS 保留原有权限和目录同步。
- 自动检查保存当前窗口状态，用户点击后立即打开同一个任务；检查完成时按实时可见性刷新。自动调度不隐藏正在进行的手动操作。
- 菜单、工作区更新提示和系统通知共用系统错误提示；账本原有未知结果语义保留。
- AppKit 和 WinForms 原生助手在消息循环就绪后发送回执。宿主处理提前退出、启动错误和十秒超时；只终止本次未就绪的显示助手，不终止安装器或后台下载。
- 更新说明去掉只适用于 macOS 的 Homebrew 表述。
- 保留已准备更新重新检查版本及 SHA-256 的行为，不把“待重启”视为禁止检查新版本的状态。

## 入口与平台盘点

| 能力 | Windows 核对结果 | macOS 核对结果 | 当前边界 |
| --- | --- | --- | --- |
| 菜单检查、工作区更新提示、通知打开 | 共用更新控制器及失败提示，原生窗口为 WinForms | 共用控制器，原生窗口为 AppKit | 源码核对，未做实际点击 |
| 设置中的检查更新 | 走 release API 查询，手动检查时间走账本 | 同一查询入口 | 已查调用链；未做界面操作 |
| 发布清单和下载 | 按系统与 x64/ARM64 匹配 EXE，下载校验 SHA-256 | 匹配 DMG，已有 Homebrew 和直接下载路径 | 未联网查询发布、未下载 |
| 安装与恢复 | 已有独立 NSIS 接力、退出取消回执、安装完成记录、旧安装器恢复；签名门禁保留 | 已有 Homebrew/DMG 安装与精确路径重启 | 本次未改安装协议，未实际安装或恢复 |
| Git、项目源码、资源、文件预览、浏览器、电脑操作 | 已查 MainCommandLedger 的全部引用，共享本次 Windows 账本修复 | 同一账本，POSIX 路径保留 | 仅核对共享调用链，不代表每项功能已运行验收 |
| 命令执行与隔离 | 已有 PowerShell 和 Windows 原生隔离入口 | 已有 macOS 隔离入口 | 平台能力依赖各自助手和系统权限，未实际运行 |
| 浏览器桥与 Git 授权 | 已有 Windows Native Messaging 注册和签名助手入口 | 已有 macOS 对应助手 | 本次未改协议，未做真实授权操作 |
| 打包 | 现有发布工作流分别构建 Windows x64、ARM64 | 现有 macOS 工作流 | 本次仅编译改动涉及的原生项目，未构建安装包、未触发远程工作流 |

依据：main.ts、mainCommandLedger.ts、homebrewUpdateController.ts、automaticUpdateScheduler.ts、nativeUpdateProgress.ts、releaseUpdateService.ts、windowsReleaseInstaller.ts、releaseCore.ts、releaseUpdateApi.ts、conversationToolProcesses.ts、externalBrowserHost.ts、projectGitAuthentication.ts、build-windows-release.yml。

## 检查记录

2026-10-23，在当前 macOS 工作区完成：

- 安装锁定依赖时使用 `--frozen-lockfile --ignore-scripts`，未执行依赖安装脚本。
- 共享包、storage、AI runtime、Git core、local server 的 TypeScript 编译通过。
- 桌面 Main、Renderer 的 TypeScript 无输出类型检查通过。
- UpdateProgressPanel.swift 的 Swift 类型检查通过。
- WindowsSecurityHelper.csproj 按 win-x64 和 win-arm64 交叉编译通过，均为零警告、零错误。该项目包含实际修改的 WinForms 更新窗口；这是编译证据，不是 Windows 启动证据。
- 日志位于当前工作区 `.tmp/ZEUS-0098/`。未执行测试脚本，也未新增测试文件。

## 全功能扩展阶段

已扫描桌面 Main、Renderer、Preload 和 packages 中的平台判断、权限位、目录同步、进程调用、路径拼接与快捷键入口。首次扫描定位 50 份显式平台文件、86 份权限及文件操作文件、32 份路径相关文件；这些集合有重叠，数量不代表功能验收数。原始定位清单保留在 `.tmp/ZEUS-0098/`。

### 新确认并修复的缺口

| 功能 | 原因与修复 | macOS 影响 |
| --- | --- | --- |
| 会话显示缓存 | Windows mode 不符合 POSIX 严格值导致缓存始终不可读；改用 ACL 和真实句柄校验 | 原权限要求保留，缓存发布改用共享持久化方法 |
| 浏览器截图、导出、偏好保存 | 文件写入后同步目录在 Windows 失败；三处统一使用平台持久化发布 | 仍同步文件和目录，不改变业务入口 |
| 任务文件与目录附件 | 原 hard-link/目录 fsync 发布不适用于 Windows；文件使用不覆盖发布，目录使用同卷原生不覆盖移动；暂存树增加 ACL | 原目录 claim 机制保留 |
| 项目源码保存、新建、移动 | 修复文件已修改却在目录同步时报错；Windows 新建使用同目录候选并原生发布，移动禁止覆盖；写入前拒绝设备名、ADS、末尾折叠字符及 `.git` 大小写别名 | 原路径校验和目录同步保留；保存复用共享发布 |
| 任务事件文件投影 | Windows 目录 fsync 使 outbox 反复重试；重建使用平台发布，增量只同步已有文件；缺失文件先重建 | 初次缺失文件统一走完整重建，SQLite 仍为权威事实 |
| 错位 Codex 会话迁移 | 复制发布后目录同步失败；使用不覆盖的持久化发布并收紧 Windows 权限 | 保留身份、摘要、并发目标和源文件变化检查 |
| 项目数据导入 | 只接纳 `/` 开头导致 Windows 盘符目录被拒绝；使用当前平台绝对路径规则 | 仍要求路径存在且为目录 |
| 历史工具结果分页 | 用 `/` 拼接根目录边界导致 Windows 路径误拒绝；复用共享路径边界方法 | 保留哈希与会话归属检查 |
| Telegram 附件和长回复 | 四处根路径比较固定使用 `/`；改用服务已有的跨平台路径方法 | 继续验证真实路径和正文完整性 |
| Runtime 工作目录与命令风险提示 | 拒绝 Windows 跨盘越界；删除手写路径折叠；识别 PowerShell 明文及编码命令、cmd 参数及常见文件命令 | 复用系统路径语义；静态提示不是完整 shell 解析器，隔离与授权边界保留 |
| 全局规则、源码预览、文件预览读取 | Windows 不以 O_NOFOLLOW 标志本身作为保护，改用已有真实句柄与路径身份检查 | 保留 POSIX no-follow |
| 只读数据库验证入口 | Windows 数据库权限改用 ACL，保留文件身份、链接数、只读副本和摘要要求 | 原 0600 要求保留 |
| 非浏览器图片格式预览 | Windows 接入 Electron 系统缩略图解码器，不再因平台直接拒绝；限制输出大小并保持比例 | 原 sips 路径保留 |

共享取舍：复用 storage 平台边界，避免各入口单独吞掉错误。收益是权限、拒绝覆盖、持久化和路径隔离保持一致；代价是 Windows 需要本次同步更新的原生助手，安全操作有进程调用开销。新增原生移动仅处理同卷目录项，不执行脚本，也不允许覆盖目标。

### 其他功能类别核对

- 项目、任务、工作管理、数字员工、数字团队、自动化、记忆、技能、通知、Dashboard：检查 Renderer 功能目录和共享后端调用；相关文件写入受本次账本、路径、投影与资源修复覆盖。没有另建 Windows 业务模型。
- Codex、其他 AI Runtime、终端、命令中心：已有 Windows PowerShell、cmd、ConPTY/私有执行宿主、守护进程连接和环境变量大小写处理；保存的脚本仍按其声明解释器运行，不自动把 shell 脚本改写为另一种语言。
- Git、浏览器、电脑控制、集成、远程、Telegram：已有对应 Windows 助手或平台无关 API；本次修复其共享写入和路径问题，保留授权、未知结果与平台能力约束。
- 标题栏、快捷键、剪贴板、通知和托盘：已有 Windows 分支；Windows 使用 Ctrl 及系统标题栏。Quick Look 是 macOS 系统能力，Windows 使用应用内预览和系统打开入口。
- 未发现新问题的源码入口只记为“已静态核对”，不标为“实机通过”。已发现而无法用本机环境证明运行结果的项继续列在下方。

### 平台依据

- Windows 同卷目录移动使用系统支持的 [MoveFileEx 写穿透移动](https://learn.microsoft.com/en-us/windows/win32/fileio/moving-directories)。文件内容刷新要求具有写权限的句柄，见 [FlushFileBuffers](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers)。本实现沿用已有平台安全组件，不使用空目录 fsync 模拟持久化。
- Windows 图片缩略图接口及按宽度缩放行为见 [Electron nativeImage](https://www.electronjs.org/docs/latest/api/native-image)；[Electron Windows 实现](https://raw.githubusercontent.com/electron/electron/main/shell/common/api/electron_api_native_image_win.cc)使用系统缩略图缓存。具体格式仍取决于系统已安装的解码器，失败明确引导打开原文件，不生成通用图标冒充图片内容。

## 未完成与适用边界

- “全面支持 Windows”尚未整体运行验收。本轮已按全功能类别扩展审查并修复上述源码缺口；不能凭静态扫描断言不存在其他运行问题。
- 尚无用户设备日志，不能证明所修阻断点是现场唯一原因。
- Windows 未实际运行窗口、下载、安装、取消重启、恢复及安装后启动；macOS 同样未做窗口与更新运行验收。
- 两端收起、展开、选中、关闭、键盘焦点和窄窗口行为均未实际检查，无截图；类型检查和编译不代替界面验收。
- 未生成或分发新版安装包，用户已安装的 Windows 客户端尚未因此改变；修复需要进入后续正式安装包。
- Windows 原生安全助手缺失或无法执行时仍会拒绝操作；不会绕过 ACL、签名、安装事务或未知结果保护。
- Windows 安全文件操作沿用本机卷限制，不开放网络卷、设备路径或 ADS。数据导入能识别 UNC 目录并不表示原生安全组件允许在网络卷运行全部功能。
- Windows 的 HEIC/HEIF/ICNS 等格式取决于系统解码器，缺失解码器时只能明确提示打开原文件；本次没有安装第三方系统组件。
- 仓库 `scripts/package-windows.mjs` 明确要求在对应架构的原生 Windows 构建。当前会话只有 macOS 环境且没有可用的 Windows 远程执行入口，因此本轮不具备完整 Windows 安装包和实机交付条件。

## 扩展阶段复核

- 扩展修复后的 storage、local server TypeScript 编译通过；相关共享包在前阶段已编译通过。
- 修改后的 Windows 原生安全助手再次按 x64、ARM64 交叉编译通过，均为零警告、零错误。
- 桌面 Main 在全部扩展修改后无输出类型检查通过；Renderer 未新增交互结构，前阶段类型检查通过。差异空白检查通过，格式检查发现一处排版后已修正。
- 全部修改仍在当前工作区，未提交 Git、未推送、未发布。用户现有客户端需要后续包含这些修改的完整安装包。
