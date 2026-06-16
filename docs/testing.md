# 测试

## 命令

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:real-scan
pnpm build
pnpm package:mac
```

## 真实扫描

`pnpm test:real-scan` 扫描 `/Users/david/hypha/zeus`，写入 `.tmp/zeus-real-scan.db`，生成 `code_symbols`、`project_nodes`、`project_edges`、`graph_views` 并断言非空。

## 禁止项

测试不得写入假项目源码、假任务、假图谱、假 AI 输出或假 Telegram 消息。
