# ZEUS-0458 对话框选择 Skill 报错

## 当前阶段

2026-09-05：按已确认计划完成代码修复、调用文本检查、静态检查、构建和打包。真实桌面及模型执行验收因本轮未启用 Computer Use 暂未完成。任务分支为 `zeus/ZEUS-0458-skill-01`，实施前工作区干净。

## 现场与根因

- 只选择 `/ponytail/ponytail-review` 后发送，页面显示“消息尚未被 Zeus 接收”。
- 只读查询正式数据库确认，失败命令 `command_conversation_dispatch_635d5bd2-42a4-47f1-aeb0-55acc025b3e2` 的结果为 `failed_before_write`，错误码为 `ZEUS_INVALID_CONVERSATION_MESSAGE`，原因为消息正文、附件和浏览器评论均为空。
- `provider_write_started_at` 为空，对应时间窗口没有正式提交记录；失败发生在调用模型前。
- 共用输入框生成 `promptText` 时删除了所有结构化标签。只选 Skill 会变成空正文，选择 Plugin Skill 并附带正文时也会丢失本次明确调用的名称。

## 已确认语义与实现

- 只选择 Skill 也允许直接执行，由所选 Skill 根据当前对话理解任务；上下文不足时正常询问。
- 在 `StructuredComposerInput.tsx` 的标签中保留可选 `invocation`，生成正文时按标签原位置写回。
- 普通 Skill 和 Plugin Skill 使用目录已有的调用文本，例如 `$skill-name`、`@ponytail/ponytail-review`；Plugin 使用 `@插件名称`，不使用显示名称代替调用名称。
- 界面展示、正文顺序、结构化身份保持原语义。数字员工点名和 Computer Use 仍仅通过原结构化字段提交。
- 新建项目对话、新建任务对话、继续对话均使用共用组件；公开接口、数据库和服务端身份校验不变。
- 优点：单处修复同时覆盖空消息与调用意图丢失，不新增运行机制或依赖。限制：旧失败消息保存了原空请求，需要取消本地失败消息后重新选择发送，不改写旧请求或重试身份。

## 验证记录

- `pnpm install --frozen-lockfile --offline`：通过，复用本机缓存，未修改 lockfile。首次安装提示内部命令入口尚未构建，后续执行完整构建。
- 调用文本一次性检查：通过。直接读取并执行实际组件中的正文转换与标签编辑函数，8 组场景覆盖普通 Skill、Plugin Skill、Plugin 显示名称与调用名称不同、多选附带正文、删除单个标签、删除全部标签、普通正文，以及数字员工与 Computer Use 的独立结构化提交。
- `pnpm exec prettier --check apps/desktop/src/renderer/session/StructuredComposerInput.tsx`、`git diff --check`：通过。
- `pnpm lint`：通过。
- `pnpm typecheck`：通过，架构治理同时通过。
- 新建与继续对话代码链路核对：两处输入入口都使用 `StructuredComposerInput`；新建项目和任务使用 `structured.promptText`，继续对话经 `ConversationComposer` 和 `useSessionController` 将同一结果写入请求 `content`，展示文本及两类引用分别提交。此项为源码核对，不代表实际点击与发送验收。
- `pnpm build`：通过；存在既有 `markstream-react` 的 Rolldown 注解位置及大分块告警，退出码为 0。
- `pnpm package:mac`：通过。产物为本任务 `dist/test/mac-arm64/Zeus Test.app`；`CFBundleIdentifier` 与签名 Identifier 均为 `dev.hypha.zeus.test`，打包流程的深度严格签名检查通过，结果为 `valid on disk` 和 `satisfies its Designated Requirement`。完整日志保留于 `/private/tmp/zeus-0458-validation.4qXrpu/package-mac.log`。
- 未执行：本任务独立 `Zeus Test.app` 的启动、实际选择与发送验收。继续验收时使用独立 `ZEUS_USER_DATA_DIR`；当前非主外接屏 ID 为 `3`，启动前重新核对并通过现有 `ZEUS_TEST_DISPLAY_ID` 保证首窗从创建起位于该屏。
- Zeus Computer 的 `list_apps` 调用被拒绝，提示“Computer Use 仅在 Composer 为本轮明确启用后可调用。”已请求用户开启本轮能力，未尝试绕过工具限制。
- 尚无真实模型执行及重试去重验收结果，不将静态或构建结果视作实际运行完成。
- 最终工作区核对：仅修改共用输入组件并新增本任务文档；未修改公开接口、服务端、数据库、依赖清单或 lockfile。

### 可复跑的调用文本检查

从仓库根目录执行；只读取实际源码，不新增检查文件或依赖，不修改界面或数据库。

```sh
node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
// 直接读取实际组件中的正文转换与标签编辑函数。
const source = ts.createSourceFile('composer.tsx', readFileSync('apps/desktop/src/renderer/session/StructuredComposerInput.tsx', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
// 只执行没有界面依赖的现有函数，不复制实现。
const code = source.statements.filter((node) => ts.isFunctionDeclaration(node) && ['selectionFromTokens', 'reconcileTokens'].includes(node.name?.text)).map((node) => node.getText(source)).join('\n');
// 在隔离上下文中获得实际函数。
const { selectionFromTokens, reconcileTokens } = runInNewContext(ts.transpile(code + '\n({ selectionFromTokens, reconcileTokens });', { target: ts.ScriptTarget.ES2022 }));
// 根据界面标签建立具有原字符范围的检查输入。
function token(value, label, kind, stableId, invocation) {
  return { id: stableId, label, kind, stableId, start: value.indexOf(label), end: value.indexOf(label) + label.length, ...(invocation ? { invocation } : {}) };
}
// 同时检查展示文本、正文和两类身份，不把结果当作桌面验收。
function check(value, tokens, promptText, skillReferences = [], pluginReferences = []) {
  // 将隔离上下文的对象转为当前上下文的数据。
  const actual = JSON.parse(JSON.stringify(selectionFromTokens(value, tokens)));
  assert.equal(actual.displayText, value);
  assert.equal(actual.promptText, promptText);
  assert.deepEqual(actual.skillReferences, skillReferences);
  assert.deepEqual(actual.pluginReferences, pluginReferences);
  return actual;
}
// 普通 Skill、Plugin Skill 和插件的稳定身份。
const nativeId = 'a'.repeat(32), pluginId = 'plugin_ponytail', skillId = 'plugin:plugin_ponytail:skill:ponytail-review';
// 单选应有非空调用正文。
check('/review ', [token('/review ', '/review', 'skill', nativeId, '$review')], '$review', [{ id: nativeId }]);
check('/ponytail/ponytail-review ', [token('/ponytail/ponytail-review ', '/ponytail/ponytail-review', 'plugin-skill', skillId, '@ponytail/ponytail-review')], '@ponytail/ponytail-review', [], [{ kind: 'skill', id: skillId }]);
check('/显示名称 ', [token('/显示名称 ', '/显示名称', 'plugin', pluginId, '@ponytail')], '@ponytail', [], [{ kind: 'plugin', id: pluginId }]);
// 乱序输入仍按标签在正文中的位置生成调用。
const value = '请先 /review 再 /ponytail/ponytail-review\n检查改动。';
// 两类标签都从目录调用文本构造。
const native = token(value, '/review', 'skill', nativeId, '$review'), plugin = token(value, '/ponytail/ponytail-review', 'plugin-skill', skillId, '@ponytail/ponytail-review');
check(value, [plugin, native], '请先 $review 再 @ponytail/ponytail-review\n检查改动。', [{ id: nativeId }], [{ kind: 'skill', id: skillId }]);
// 删除普通 Skill 后，其调用和引用均消失，剩余标签位置随文字移动。
const deleted = value.replace('/review ', '');
check(deleted, reconcileTokens(value, deleted, [native, plugin]), '请先 再 @ponytail/ponytail-review\n检查改动。', [], [{ kind: 'skill', id: skillId }]);
check('', reconcileTokens(value, '', [native, plugin]), '');
check('普通正文', [], '普通正文');
// 数字员工和 Computer Use 仍只通过结构化字段提交。
const structured = '@员工 /Computer Use 执行';
const result = check(structured, [token(structured, '@员工', 'expert', 'employee_1'), token(structured, '/Computer Use', 'computer', 'computer-use')], '执行');
assert.deepEqual(result.expertMentions, [{ employeeId: 'employee_1' }]);
assert.equal(result.computerUseRequested, true);
console.info('调用文本检查通过：8 组场景；展示、顺序、删除及结构化身份正确。');
NODE
```

## 数据与交付边界

不修改正式数据，不执行 Git commit、push、merge、revert，不改写现有失败消息。
