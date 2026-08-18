# ZEUS-0332 Zeus 频繁重复申请权限

## 任务信息

- 类型：优化
- 用户现象：macOS 反复显示“Zeus 想访问‘文稿’文件夹中的文件”。
- 目标：保留用户主动选择项目、附件和导出位置时的真实目录访问，同时消除应用升级造成的重复系统授权。

## 根因

截图是 macOS“隐私与安全性 > 文件与文件夹”的系统授权，不是 Zeus 自绘弹窗。ZEUS-0123 已把内置浏览器默认下载位置迁入
Zeus 私有资料目录，并避免保存无关设置时创建系统“下载”目录；当前分支仍保留该实现，因此本次问题不是该修复被简单回滚。

Apple 的代码签名文档说明，macOS 使用代码签名中的指定要求识别升级前后的同一应用，并据此继承隐私保护资源的授权。ad-hoc 签名
的指定要求只绑定某一份具体代码，代码变化后系统无法可靠确认它仍是原应用，因而可能再次询问权限。

Zeus 当前公开发布链路默认允许 ad-hoc、未公证产物：`publish_release=true` 只有在操作者额外打开
`require_apple_distribution` 时才要求 Developer ID 与公证。这与用户看到的跨升级重复授权现象吻合，是本次修复的高置信工程根因；
仍需用两个连续签名版本完成真实升级验收。若同一份未变更的签名二进制在一次运行内反复弹窗，则属于另一条路径访问问题，需要结合当时
打开的项目、附件或 Agent 操作继续取证，不能由本结论掩盖。

参考资料：

- [Apple：Creating distribution-signed code for macOS](https://developer.apple.com/documentation/xcode/creating-distribution-signed-code-for-the-mac/)
- [Apple：TN3127 Inside Code Signing Requirements](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements)
- [Apple：控制 Mac 上文件和文件夹的访问权限](https://support.apple.com/guide/mac-help/control-access-to-files-and-folders-on-mac-mchld5a35146/mac)

## 实现

### 公开发布强制稳定身份

- `pnpm release` 和 `pnpm release:publish` 固定要求 Developer ID 签名与 Apple 公证，不允许通过环境变量关闭。
- Release Workflow 在公开发布前检查 Developer ID 证书、公证凭据和 Homebrew Tap 凭据；任一缺失都会在创建标签、Release 或更新
  Tap 前失败。
- 公开打包作业无条件启用可分发产物门禁；生成的 manifest 必须同时记录 `signed=true`、`notarized=true`。
- 发布后回验不再把 `signed=false` 或 `notarized=false` 的公开 manifest 视为成功。

### 保留本地候选能力

`publish_release=false` 时仍可生成 ad-hoc 的本地候选或 Actions artifact，用于包结构和非 GUI 检查。该产物不能创建公开 Release，
也不能更新 Homebrew Tap。

优点：不需要扩大文稿、下载或全盘访问 entitlement；后续升级沿用同一 Developer ID 时，macOS 可以稳定识别 Zeus 并继承用户授权。

代价：配置 Developer ID 与公证凭据前不能发布新公开版本；已有 ad-hoc 版本第一次升级到正式签名版本时，应用身份发生一次迁移，仍可能
需要用户重新授权一次，此后连续签名版本才应稳定继承。

## 不采用的方案

1. 增加文稿、下载或全盘访问 entitlement。
   - 优点：授权后访问范围直接。
   - 缺点：扩大应用能力，不能解决 ad-hoc 身份随版本变化的问题。
2. 捕获并忽略目录权限错误。
   - 优点：界面可能少一次错误反馈。
   - 缺点：项目、附件或导出会真实失败，只是把故障隐藏起来。
3. 禁止用户选择文稿等受保护目录。
   - 优点：不会触发对应访问。
   - 缺点：破坏开发者把真实仓库放在常用目录中的核心工作流。
4. 继续公开 ad-hoc 包，只在 Release notes 中提醒。
   - 优点：不等待 Apple 凭据即可发布。
   - 缺点：无法提供可跨版本验证的应用身份，重复授权根因继续存在。

## 验证边界

代码交付需要完成格式、lint、typecheck、build 和发布脚本静态检查。真实问题的最终验收必须在同一台隔离 Mac 上连续安装两个由同一
Developer ID 签名并已公证的 Zeus 版本：首版允许访问隔离的受保护测试目录，升级后再次访问时不应出现重复授权。

不得用 `Zeus Test.app` 的独立 bundle ID、ad-hoc 候选、单次 `codesign --verify` 或静态构建通过冒充这项跨版本 TCC 验收。验收也
不需要重置或修改用户正式 Zeus 的 TCC 记录。

## 验证记录

2026-08-18 已完成：

- 目标文件 Prettier 检查：通过。
- 两个发布脚本 `node --check`：通过。
- 显式设置 `REQUIRE_APPLE_DISTRIBUTION=false` 的发布门禁探针：在读取远端或执行写操作前按预期拒绝。
- `pnpm lint`：通过。
- `pnpm typecheck`：通过。
- `pnpm build`：通过，桌面端和全部 workspace 构建完成。
- `git diff --check`：通过。

本次未执行 `pnpm verify:release`、`pnpm package:mac` 或真实 GUI：前者会执行不属于本任务的外部 AI CLI 探针并生成生产候选，
后两者也无法代替连续两个 Developer ID 版本的 TCC 授权继承验收。当前结论只证明发布源码门禁已收紧，不声称系统弹窗已经在真实
升级现场消失。
