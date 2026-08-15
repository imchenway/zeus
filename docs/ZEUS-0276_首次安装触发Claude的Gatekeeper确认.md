# ZEUS-0276 首次安装触发 Claude 的 Gatekeeper 确认

## 现象

首次打开 Zeus 时，macOS 显示“`claude` 是从互联网下载的 App，确定要打开它吗？”，来源显示为 `Homebrew Cask`。

## 结论

该弹窗不是 Zeus 自己的权限弹窗，也不是 Zeus 应用本体的首次打开确认。真正被 macOS 拦截的是外部 `claude` 可执行文件。

Zeus 首页初始化会读取 Dashboard；Dashboard 在组装 Runtime 状态时同时探测 Codex、Claude 和 Gemini。Claude 探测会解析用户环境中的 `claude` 路径，并直接执行一次 `claude --version`。如果该文件由 Homebrew Cask 下载且仍带有 macOS 隔离标记，这是它第一次被执行，Gatekeeper 就会显示截图中的系统确认框。

因此，即使用户没有选择 Claude，也可能在首次打开 Zeus 时看到 Claude 的确认框。

## 代码证据

- `packages/local-server/src/index.ts` 的 `/api/dashboard` 调用 `toRuntimeStatus(runtimeSettings)`。
- `toRuntimeStatus` 并行调用所有非 Generic Adapter 的 `checkAiCliAdapter`，包括 Claude。
- `packages/ai-runtime/src/index.ts` 的 Claude 默认命令为 `claude`，检测阶段调用版本探针。
- 版本探针使用 `nodeSpawn(commandPath, ['--version'], { shell: false })`，这会真实执行外部文件，不是只读检查文件是否存在。
- `packages/ai-runtime/src/cliSearchPath.ts` 主动补齐 `/opt/homebrew/bin`，所以从 Finder 启动的 Zeus 也能找到 Homebrew 安装的 Claude。
- Zeus 的 Homebrew Cask 只有 `Zeus.app`，没有声明 Claude 依赖；截图中的 `Homebrew Cask` 描述的是 Claude 文件自己的下载来源。

## 当前机器只读核对

当前开发机的 `claude` 已指向：

```text
/Users/david/.local/bin/claude
  -> /Users/david/.local/share/claude/versions/2.1.198
```

该文件当前由 Anthropic Developer ID 签名，当前路径没有读到隔离属性，并且 `brew info --cask claude-code` 显示当前并非 Homebrew 安装。因此本机当前状态不再等同于截图发生时的 Homebrew Cask 安装状态；截图文案仍能明确证明当时触发对象和下载来源。

## 影响

- 点击“打开”：只是在 macOS 层允许这份 Claude 可执行文件继续运行，Zeus 的版本探针随后完成；不代表已经登录 Claude，也不会自动创建 Claude 会话。
- 点击“取消”：Claude 探针会失败或被判定为不可用；只要 Codex 等其他运行内核正常，Zeus 主功能不应被阻断。
- 用户感知问题：用户明明只是在首次打开 Zeus，却看到另一个产品名，会误以为 Zeus 偷装或擅自启动 Claude。

## 后续处理方案

### 推荐：首页只做无执行发现，用户选择 Claude 后再运行探针

首页只检查候选路径是否存在、是否可执行，不启动 `claude --version`；用户在设置中主动检查 Claude，或真正选择 Claude 创建会话时，再执行版本和登录探针。

优点：首次启动不再无故唤起第三方 Gatekeeper；行为与用户意图一致；Dashboard 仍可展示“已发现 Claude”。

缺点：首次展示只能确认文件存在，不能提前确认版本兼容性和真实可运行状态。

### 次选：保留自动探针，但只探测用户已启用或配置的 Adapter

优点：已启用 Adapter 的状态仍然较准确；改动范围比拆分“发现”和“执行探针”更小。

缺点：仍可能在用户进入 Dashboard 时启动外部程序；首次默认 Adapter 或旧配置迁移仍需严格定义，否则弹窗只是减少而不是消失。

## 用户确认

用户明确要求 Zeus 不得在启动时探测这些外部工具。原因不只是弹窗体验异常，而是用户没有选择某个工具时，Zeus 擅自执行其二进制文件会越过隐私边界。

## 实现结果

- Dashboard 不再调用 Codex、Claude、Gemini 的版本探针，只根据已保存的默认 Adapter 返回“未主动检查”状态。
- 设置页和 Runtime 抽屉的普通状态刷新同样不扫描 PATH、不访问候选文件、不执行外部 CLI。
- 单个 Adapter 的真实版本和兼容性探针只保留在用户明确点击“检查”按钮后的专用请求中。
- 用户完成单个 Adapter 检查后，本次界面会使用该真实结果；切换并保存默认 Adapter 不会自动检查新目标。
- 发布门禁中的开发者显式探针不属于用户启动链路，仍保留用于构建发布核验。

## 隐私边界

被动状态读取只能使用 Zeus 自己已保存的设置和静态 Adapter 描述，禁止：

- 扫描用户 PATH 或常见安装目录；
- 对候选 CLI 执行 `realpath`、版本命令或登录探针；
- 因进入 Dashboard、设置页或点击普通“刷新”而启动第三方进程。

允许执行外部 CLI 的入口必须对应用户明确操作，例如点击单个 Adapter 的“检查”，或选择该运行内核后发起真实任务。

## 验证记录

- 变更文件 Prettier 格式化通过，`git diff --check` 通过。
- `pnpm lint` 通过。
- `pnpm typecheck` 通过。
- `pnpm build` 通过；Vite 只有既有的大分块体积提示，没有构建错误。
- `pnpm package:mac` 通过，生成测试身份 `dist/test/mac-arm64/Zeus Test.app` 和 `dist/test/Zeus-Test-0.3.11-arm64.dmg`；App 严格签名校验通过。本轮没有生成或启动生产身份 `Zeus.app`。
- 已全仓复核生产调用点：`checkAiCliAdapter` 在桌面运行时只保留于用户主动检查单个 Adapter，以及用户进入 Agent 能力选择链路后检查 Codex 的入口；Dashboard 和普通 Runtime 状态刷新均不再调用。
- 本轮没有启动 GUI；静态检查、构建和测试身份打包成功不能夸大为真实首次启动交互验收。
- 不新增或恢复单元测试、组件测试、DOM/CSS 契约测试。
