---
status: accepted
---

# 检查更新采用 Homebrew 托管与 AppKit 进度窗口

Zeus 发现公开稳定版后，不再把打开下载页作为主路径，也不在运行中提前替换 App。Zeus 先通过 Homebrew 预取并校验 Cask 产物，用包内 AppKit 辅助程序显示不阻断主窗口的真实原生进度；只在用户点击“立即重启”后执行已缓存的 Homebrew Cask 安装，禁止 Homebrew 自动退出和重开，再由 Zeus 完成升级切换。这一选择保留 Homebrew 的版本登记和回滚语义，避免旧进程长时间混用新 App 资源；代价是发布包新增需一起构建与签名的 macOS 原生辅助程序，且 Homebrew 不可用时必须明确失败，不回退到下载页或内置替换。
