# ZEUS-0412 会话 Markdown 表格列宽手柄样式污染

## 当前阶段

- 状态：已完成修复及静态、构建验证；真实浏览器视觉与拖动交互尚未验收。
- 日期：2026-08-31。
- 分支：`zeus/ZEUS-0412-markdown-01`。

## 现象

两列 Markdown 表格的第一个表头分隔处出现一个无文字的白色圆角块，外观类似未勾选任务框。

## 诊断证据

1. 权威 Provider 对话文件为
   `/Users/david/.zeus/providers/codex/sessions/2026/08/31/rollout-2026-08-31T01-11-00-01a053a7-2e82-79a3-86f1-6809ebf842ed.jsonl`。
2. 该文件第 980、981 行保留的最终回答原文一致，表格源文是：

   ```md
   | 问题特征 | 触发类型 |
   | --- | --- |
   | 模块如何连接 | `architecture` |
   | 命令如何流转和分支 | `workflow` |
   | 组件按什么顺序通信 | `sequence` |
   | 数据如何逐步转换 | `dataflow` |
   | 状态如何变化 | `lifecycle` |
   ```

3. 原文不包含 `[ ]`、`- [ ]`、`<input>` 或其他任务框语法，因此异常不是模型输出的 checkbox。
4. `ConversationMarkdown.tsx` 把所有会话 Markdown 交给精确锁定的 `markstream-react@2.0.6`，并导入该包的 `index.css`。
5. `markstream-react@2.0.6` 的表格组件会在每两个相邻表头之间渲染一个无子内容的
   `<button class="table-node__resize-handle">`，用于拖动调整列宽。两列表格只会产生一个手柄，与截图位置一致。
6. 上游样式本意是一个位于列边界的透明 `8px` 宽按钮：

   ```css
   :where(.markstream-react) .table-node__resize-handle {
     position: absolute;
     top: 0;
     right: -4px;
     bottom: 0;
     width: 8px;
     padding: 0;
     border: 0;
     background: transparent;
   }
   ```

7. 会话工作区位于 `.workspace-detail-pane`；Zeus 的工作区通用控件规则对其中所有 `button` 施加了产品按钮外观：

   ```css
   .macos-ai-app
     :where(.workspace-detail-pane, .settings-detail-pane, .settings-section-nav, .workspace-drawer-content)
     :where(button, input, select, textarea, a) {
     border-radius: var(--zeus-control-radius, 7px);
     min-block-size: var(--zeus-control-height, 30px);
   }

   .macos-ai-app
     :where(.workspace-detail-pane, .settings-detail-pane, .settings-section-nav, .workspace-drawer-content)
     :where(button, a) {
     background: var(--zeus-control-bg);
     border: 1px solid var(--zeus-control-border);
     padding: 0 var(--zeus-space-4);
   }
   ```

8. 上游手柄和 Zeus 工作区规则都只由一个普通 class 贡献特异性，最终由应用样式顺序覆盖了手柄的透明背景、无边框和零内边距；绝对定位与列边界位置仍然保留，因此最终显示为表头分隔处的空白圆角按钮。
9. 诊断期间曾注意到 `session-v2-content` 的另一组通用按钮规则，但当前 TSX 已没有该 DOM class；实施前的反向核对确认，它不是当前截图现场的有效匹配路径。

## 根因

这不是 Markdown 语法、Provider 持久化或模型输出问题。根因是 **Zeus 工作区的过宽后代按钮样式污染了 `markstream-react` 内部的表格列宽拖动手柄**。

## 边界与后续取舍

- 采用最小修复：仅在会话 Markdown 作用域恢复 `.table-node__resize-handle` 的透明、无边框、零内边距、零最小高度和 `col-resize` 光标；上游的 `8px` 命中区、列边界定位、聚焦提示线和拖动逻辑保留。优点是改动小且不影响其他工作区按钮；缺点是仍需跟随上游 DOM/class 契约。
- 更彻底的方案是收紧会话 V2 通用按钮选择器，仅覆盖 Zeus 自有交互控件。优点是可避免类似第三方内部控件污染；缺点是影响面较大，需要反向盘点会话正文中现有按钮。
- 本任务不修改依赖或锁文件，也不执行 Git 历史或远端操作。

## 实施结果

在 `apps/desktop/src/renderer/session/session.css` 的会话 Markdown 作用域中，对
`.markstream-react .table-node__resize-handle` 恢复透明背景、无边框、零圆角、零阴影、零内边距、零最小高度和
`col-resize` 光标。

选择器包含会话容器和 Markstream 根节点，特异性高于工作区通用按钮的默认态、hover 和 focus-visible 规则，且不依赖 CSS
产物的加载顺序。未覆盖上游的宽度、绝对定位和伪元素，因此拖动命中区与 hover/focus-visible 提示线继续沿用上游实现。

## 验证结果

- `pnpm exec prettier --check`：通过。
- `git diff --check`：通过。
- `pnpm lint`：通过。
- `pnpm typecheck`：通过，架构治理检查同时通过。
- `pnpm build`：通过；编译产物已确认包含最终作用域选择器。构建仅保留既有的 Markstream PURE 注释和大 chunk 警告。
- 依赖使用 `pnpm install --frozen-lockfile --offline` 恢复，锁文件未变化；安装过程仅提示当时尚未生成的本地二进制链接，后续完整构建已生成对应包。
- 按项目规则未创建或运行 Vitest/单元测试。

真实浏览器验证使用 Zeus 内置浏览器打开任务自己的 Vite QA 页面。原端口 `4179` 被另一任务占用，因此改用 `4188`；页面能够加载，
但启动 `100KB` Markdown 流场景后计数停在 `0 / 100000`，后续浏览器检查也超时。未改用外部 Playwright，也未声称白块消失和列宽拖动已完成真实交互验收。
