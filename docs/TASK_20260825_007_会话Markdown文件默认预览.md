# TASK_20260825_007 会话 Markdown 文件默认预览

## 任务目标

- 从会话正文点击 Markdown 文件后，在右侧上下文工作面默认显示渲染预览。
- 保留“预览 / 源码”切换，用户主动切换后仍可查看带行号源码。
- 普通代码文件和轮次变更文件继续默认显示源码，不改变现有评论与精确行定位能力。

## 根因

会话资源已经正确进入统一的 `SourceWorkspace`，但该工作面只实现了图片和带行号源码两种渲染路径。Markdown 虽然已被资源层识别为 `iconKind=markdown`，打开后仍只能落入通用源码分支。

## 实施决策

- 由 `SessionWorkspace` 保存右侧源码工作面的受控显示模式，避免不同资源入口各自维护隐式状态。
- 会话资源每次打开时按资源类型重新计算默认模式：Markdown 为预览，其他文本为源码。
- 轮次变更入口固定为源码，保留代码审查语义。
- `SourceWorkspace` 复用会话正文的 `SafeMarkdown`，不复制第二套 Markdown 解析和安全规则。

## 方案取舍

优点：

- Markdown 首次打开直接可读，同时保留源码检查入口。
- 用户切换模式时不重新读取文件；受影响文件刷新后保留当前选择。
- 预览继续使用现有安全 Markdown 渲染，不放宽本地文件或外链权限。

代价：

- 预览中的普通相对链接若没有对应受信 `ConversationResource`，仍按不可打开文本展示。
- 大型 Markdown 仍受现有资源预览截断上限约束；界面会保留“预览已截断”提示。

## 当前阶段

- 2026-08-25：完成现有资源打开链、右侧工作面与 Markdown 渲染器核对。
- 2026-08-25：完成 Markdown 默认预览、预览/源码切换及普通代码文件默认源码实现。
- 2026-08-25：补充复用真实 `SourceWorkspace` 的浏览器验收场景，覆盖 Markdown、TypeScript 与模式切换。
- 2026-08-25：真实组件交互验收通过：Markdown 首次打开为渲染预览；切到源码后显示带行号文本；TypeScript 默认源码且不显示 Markdown 模式按钮；再次打开 Markdown 恢复预览。页面无 Vite 错误遮罩、无运行时异常、无横向溢出。
- 2026-08-25：`git diff --check`、变更文件 Prettier、`pnpm lint`、`pnpm typecheck`、`pnpm build` 全部通过。
- 2026-08-25：`pnpm package:mac` 通过，仅生成 `dev.hypha.zeus.test` 的 `Zeus Test.app`；`codesign --verify --deep --strict` 与 DMG `hdiutil verify` 通过。测试包为临时签名且未公证，不构成正式发布证据。
- 2026-08-25：完成真实 Electron 验收。使用打包后的 `Zeus Test.app`、独立用户数据目录和独立 SQLite 数据创建真实项目、会话、轮次、模型历史与会话资源，未触碰正式 Zeus 数据。测试身份为 `dev.hypha.zeus.test`，版本为 `0.3.60`。
- 2026-08-25：在真实会话正文点击 Markdown 资源后，右侧工作面默认进入“预览”；切换到“源码”后显示带行号源码；关闭工作面并再次点击同一资源后重新默认进入“预览”。两次模式切换均无页面异常、控制台错误或失败请求，文档与右侧工作面横向溢出均为 0。
- 2026-08-25：首次启动测试包失败的原因是验收终端继承了 `ELECTRON_RUN_AS_NODE` 和 `ZEUS_EXECUTION_HOST_BOOTSTRAP_PATH`，并非应用启动缺陷；清除这两个外部变量后，测试包和 execution-host 正常启动并完成上述验收。
- 2026-08-26：修复提交 `bbce34e0f3d2f9b5706b2c30c51d03bc2a177431` 已进入 `main`；正式发布提交与标签为 `292aacf9d526c8bceb7c0f12d9391a3efb5a2e97` / `v0.3.61`。
- 2026-08-26：Release Workflow `32875024087` 的 `preflight`、`typecheck`、`package-mac`、`publish` 全部成功；GitHub Release 非草稿、非预发布。
- 2026-08-26：公开 DMG 为 112348120 字节，SHA-256 `fe90958a076c0c0f7f0287473813867806f54b4465d9bf9751a1f40d7ac22d38`，完整回下载后通过 `hdiutil verify`；manifest 与 Homebrew Cask 的版本和摘要一致。
- 2026-08-26：公开 manifest 明确为 `signed=false`、`notarized=false`；本轮没有启动或覆盖正式 `/Applications/Zeus.app`，不把发布成功表述为 Apple 签名、公证或正式安装版 GUI 验收。
- 当前结论：源码实现、真实 React 组件交互、测试身份打包、真实 Electron 会话端到端交互和 `v0.3.61` 正式公开发布均已完成。
