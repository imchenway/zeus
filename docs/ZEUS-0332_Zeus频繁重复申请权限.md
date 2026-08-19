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

### 保留 ad-hoc 公开发布并稳定 TCC 身份

- 公开发布链路继续默认使用 `identity=-` 的 ad-hoc 签名，manifest 如实记录 `signed=false`、`notarized=false`；没有把发布方式改成
  Developer ID 或 Apple 公证。
- 生产身份 `Zeus.app` 在没有 Developer ID 凭据时额外使用 `assets/zeus-adhoc.requirement`。该 requirement 以稳定的 Zeus
  bundle 标识和嵌套 Electron 代码类型建立 designated requirement，不再让 macOS 只记录每一版具体的 `cdhash`。
- 只有 `ZEUS_PACKAGE_VARIANT=release` 的 ad-hoc 打包注入该 requirement；日常 `Zeus Test.app` 继续使用独立的
  `dev.hypha.zeus.test` 身份，不与正式 Zeus 共享 TCC 主体。
- 一旦配置 Developer ID 签名，打包继续走原有正式签名路径，不套用 ad-hoc requirement。

优点：不需要 Apple 账号、不扩大“文稿”、下载或全盘访问 entitlement，并且在保留 ad-hoc 公开发布的前提下，为后续版本提供稳定的
TCC designated requirement。

代价：ad-hoc 没有可验证的开发者证书，不能获得 Gatekeeper 信任或公证；稳定 requirement 只能改善同一 bundle 身份的权限继承，不能把
ad-hoc 产物描述成 Apple 已认证。已有旧版 `cdhash` 授权首次迁移到新 requirement 时，仍可能需要用户确认一次。

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
4. 强制把公开发布改成 Developer ID 签名与公证。
   - 优点：身份和分发信任最完整。
   - 缺点：超出当前 ad-hoc 发布约束，需要 Apple 凭据；不应作为本任务的实现前提。

## 验证边界

代码交付需要完成格式、lint、typecheck、build 和发布脚本静态检查。真实问题的最终验收应在同一台隔离 Mac 上连续安装两个由本改动生成的
ad-hoc 生产包：首版允许访问隔离的受保护测试目录，升级后再次访问时不应因为代码 hash 变化而重复授权。

不得用 `Zeus Test.app` 的独立 bundle ID、单次 `codesign --verify` 或静态构建通过冒充这项跨版本 TCC 验收。验收也不需要重置或修改
用户正式 Zeus 的 TCC 记录。

## 验证记录

2026-08-19 已完成：

- `pnpm exec prettier --check`：目标脚本、README 和发布文档通过。
- `pnpm lint`、`pnpm typecheck`：通过。
- `pnpm build`：通过，全部 workspace 和桌面端构建完成。
- `pnpm package:mac`：通过；生成的仅是 `dev.hypha.zeus.test`、ad-hoc 的 `Zeus Test.app`，并通过最终签名校验。
- `node --check scripts/package-mac.mjs`、`git diff --check`：通过。
- macOS `codesign` 探针：ad-hoc 签名在两份代码 hash 不同的二进制上保留相同的显式 requirement，且均通过 designated requirement 校验。
- 当前正式 `/Applications/Zeus.app` 只含 `cdhash` requirement 的只读检查：确认了本次问题的现状根因；没有修改或重签正式应用。
- 公开发布仍保留 ad-hoc 的源码路径；稳定 requirement 只在生产 ad-hoc 打包命令中注入，测试包路径不变。

尚未完成的部分：没有执行生产身份打包或真实 GUI/TCC 升级验收；按项目约束，本任务 worktree 不启动或登记生产身份 `Zeus.app`。因此当前
证据证明 requirement 注入和 ad-hoc 签名层的静态可行性，不声称 macOS 弹窗已经在真实连续升级现场消失。
