# ZEUS-0148 Zeus Test 多实例数据隔离

## 问题结论

多个任务 worktree 同时启动 `Zeus Test.app` 时，旧实现把所有测试包都写入同一个 `~/.zeus-test`。当分层目录版本与仍在运行的旧平铺目录版本同时写入该根目录，启动保护会发现：

```text
~/.zeus-test/data/zeus.db
~/.zeus-test/zeus.db
```

这两个数据库不能安全判断谁是权威数据源，因此报错停止启动是数据保护行为；真正的问题是测试包之间没有按 App 实例隔离数据根。

## 实施方案

- 显式设置 `ZEUS_USER_DATA_DIR` 时继续使用用户指定的完整数据根，不替用户猜测或合并两个数据源。
- 未设置覆盖目录的打包 `Zeus Test.app`，根据自身可执行文件路径生成稳定的短哈希，使用：

  ```text
  ~/.zeus-test/instance-<app-path-hash>/
  ```

- 同一个 App bundle 仍然复用自己的测试数据，重新打包到同一路径不会每次产生新库。
- 不同任务 worktree 的 App bundle 路径不同，因此可以各自持有数据库、执行宿主、Provider 目录和 Electron Profile。
- 目录准备增加同根进程间锁，迁移、初始化和完整性检查不会被两个启动进程同时执行；异常遗留锁在确认持有进程已退出后才会回收。

## 取舍

优点：多个任务可以并行启动测试包，不再因为共用 SQLite 或执行宿主而互相污染；显式测试目录仍保持完全可控；同一 App 的单实例语义不变。

代价：旧的共享 `~/.zeus-test` 不会被自动猜测迁移到某个实例。若其中同时存在分层库和平铺库，继续保留启动阻断，必须先由用户确认数据来源后再通过显式 `ZEUS_USER_DATA_DIR` 处理，避免静默丢数据。

## 验证边界

本任务不修改任何正式 `~/.zeus` 数据，也不停止现有 `Zeus Test.app` 或正式 `Zeus.app`。代码完成后执行 `pnpm lint`、`pnpm typecheck`、`pnpm build` 和独立测试包校验；若当前机器已有同身份测试包占用单实例或真实窗口，GUI 结果单独记录，不把静态检查和打包结果描述为完整桌面验收。

本轮已完成：

- `pnpm install --frozen-lockfile --offline`：通过；
- `pnpm lint`、`pnpm typecheck`、`pnpm build`：通过；
- 目录迁移并发探针：两个进程同时准备同一平铺根，最终一个返回 `migrated`、一个返回 `already-layered`，只存在 `data/zeus.db`；
- `pnpm package:mac`：通过，生成 `dist/test/mac-arm64/Zeus Test.app`，Bundle ID 为 `dev.hypha.zeus.test`，包健康检查和 `codesign --verify --deep --strict` 通过；
- 独立临时 `ZEUS_USER_DATA_DIR` 启动：`/health` 返回 HTTP 200，`ok=true`、数据库和 Runtime 均为 `ok`；同根第二个实例以代码 `0` 退出，未产生平铺数据库；
- 未执行完整 GUI 点击验收，未停止其他任务的测试进程，也未启动或修改正式 `Zeus.app`。
