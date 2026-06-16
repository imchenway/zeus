# Zeus macOS 本地优先 AI 研发工作台：完整开发设计与一次性目标模式执行说明

> 项目名称：**Zeus**  
> 工作目录：`/Users/david/hypha/zeus`  
> 目标平台：macOS  
> 分发目标：开源项目、Homebrew cask、DMG/ZIP 安装包  
> 目标执行方式：交给 Codex App 的 **Build macOS Apps** 插件，在目标模式下一次性完成可上线版本。  
> 设计要求：本文件是工程执行文档，不是概念说明。执行者必须以本文件为唯一产品与技术边界，持续完成到所有验收项通过。

---

## 0. 给执行代理的总指令

在 Codex App 中打开 `/Users/david/hypha/zeus`，启用 **Build macOS Apps** 插件，并使用目标模式执行下面的目标。

### 0.1 总目标

在 `/Users/david/hypha/zeus` 内从零或从现有空仓库开始，构建一个名为 **Zeus** 的本地优先 macOS AI 研发工作台。最终产物必须是一个可以本地运行、可以打包、可以测试、可以开源发布的 macOS 桌面应用，具备以下完整能力：

1. 项目管理：创建项目、选择本地代码库、维护项目配置、查看项目概览。
2. 任务管理：创建任务、执行任务、暂停/继续/取消/重试、任务模板、任务状态时间线、任务归档。
3. 本地 AI 执行：内置本地 app-server、PTY runtime、AI CLI adapter、实时终端日志、会话管理、执行结果保存。
4. Git 与 Diff：执行前快照、执行后 diff、变更审查、回滚、提交、分支、stash、patch。
5. 代码扫描与代码索引：扫描本地真实代码库，解析项目结构、Java/Spring/MyBatis/SQL、TypeScript/JavaScript 基础结构、数据库 schema。
6. 代码地图与图谱：系统架构图、模块图、表关系图、模块详情图、接口时序图、模块流程图、方法逻辑图。
7. 图交互与性能：大图 WebGL、局部图交互、搜索、过滤、聚合、后台布局、缓存、性能监控。
8. AI 与图谱联动：基于图谱上下文问答、从模块/接口/表/方法/调用链创建任务、任务结果回写图谱。
9. Telegram 远程入口：long polling、本机白名单、命令、通知、远程创建和控制任务。
10. 安全与权限：本地服务不暴露公网、API token、macOS Keychain、敏感日志脱敏、高风险操作二次确认。
11. 测试与质量：单元测试、集成测试、UI 测试、真实代码库扫描测试、打包测试。
12. 发布工程：README、开发文档、贡献指南、Electron Builder、DMG、ZIP、Homebrew cask 配置、GitHub Release 工作流。

### 0.2 不可违反的硬性约束

1. **项目命名统一为 Zeus / zeus**。所有包名、目录、窗口标题、数据库名称、README、文档、UI 文案必须使用 Zeus。不得出现历史项目代号、历史平台名或无关项目名。
2. **开发与测试过程禁止写入任何 mock 数据**。不得向 SQLite、配置文件、测试目录、示例目录、文档或 UI 写入虚假的项目、任务、会话、图谱节点、接口、表、SQL、终端输出或 AI 回复。
3. **不得使用假 demo 项目替代真实扫描**。若没有用户选择的外部项目，测试过程允许并且必须直接使用当前项目 `/Users/david/hypha/zeus` 的真实代码库生成图。
4. **没有真实数据时展示空状态**。不要用假数据填充界面；空项目、空任务、空图谱、空会话都必须以空状态组件呈现。
5. **外部 AI CLI 不存在时不得伪造执行结果**。必须显示“未检测到可用 CLI / 需要配置”，并提供设置入口。
6. **Telegram 未配置时不得伪造消息**。必须显示未启用状态。
7. **数据库测试必须使用临时真实数据库文件或当前项目真实数据导入**，不得 seed 虚假业务记录。
8. **代码图谱中的每个节点和边必须有来源**：文件路径、代码行、SQL 文件、DDL 文件、数据库 introspection、Git 信息或用户明确创建的真实记录。
9. **所有 shell/文件/Git 高风险操作默认需要确认**。远程入口触发高风险操作时必须进入等待确认状态。
10. **本地服务只允许监听 `127.0.0.1` 或 Unix Domain Socket**，不得默认监听 `0.0.0.0`。
11. **最终必须能执行真实构建命令、真实测试命令、真实打包命令**，不能仅生成静态页面或 README。

### 0.3 一次性目标模式执行要求

目标模式执行时不要只完成局部功能；必须持续推进到以下命令全部成功或给出明确阻塞原因：

```bash
cd /Users/david/hypha/zeus
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm test:real-scan
pnpm build
pnpm package:mac
```

如果某个外部工具或证书缺失，例如 Apple Developer 签名证书、Homebrew tap token、Telegram Bot Token、AI CLI 登录状态，必须实现功能和 UI，并在验收报告中标记为“等待用户配置”，不得伪造通过。

---

## 1. 产品定义

### 1.1 产品一句话

**Zeus 是一个本地优先的 macOS AI 研发工作台，集项目任务管理、代码地图、图谱问答、AI 编程执行、Git diff 审查和 Telegram 远程控制于一体。**

### 1.2 用户安装后的目标体验

用户通过 Homebrew cask 或 DMG 安装后：

1. 打开 Zeus。
2. 创建项目并选择本地代码库目录。
3. Zeus 扫描真实代码，生成系统架构图、表关系图、模块视图、接口时序图和方法逻辑图。
4. 用户可以在图中点击模块、接口、表、方法，进入更细层级。
5. 用户可以从任意节点创建任务，例如“分析库存预占接口的并发风险”。
6. 用户可以把任务交给本地 AI CLI 执行。
7. Zeus 展示实时终端、执行日志、任务状态、Git diff、AI 回复和结果。
8. 用户可以接受、回滚或提交变更。
9. 用户可以配置 Telegram Bot，在手机或其他电脑上远程查看项目、创建任务、查看状态、继续会话和接收通知。
10. 所有数据默认保存在本机，不需要云端服务，不需要云端数据库。

### 1.3 目标用户

1. 个人开发者：需要远程调度本机 AI 编程任务。
2. 技术负责人：需要快速理解陌生项目的系统结构、接口链路和表关系。
3. 开源维护者：需要本地任务管理、代码地图和 AI 执行闭环。
4. 后端开发者：尤其是 Java/Spring/MyBatis、TypeScript/Node 项目使用者。

### 1.4 非目标

第一版不做以下事情：

1. 不做云端 SaaS。
2. 不做多用户团队权限系统。
3. 不做远程云数据库。
4. 不替代 GitHub/GitLab 的代码托管。
5. 不替代完整 IDE。
6. 不默认上传用户代码。
7. 不在没有真实来源时生成看起来真实的图谱数据。

---

## 2. 技术选型

### 2.1 总体选型

| 层级 | 技术 | 说明 |
|---|---|---|
| 桌面应用 | Electron + React + TypeScript | 兼顾 macOS 桌面、Web 图谱、终端、Node 本地能力和跨平台潜力 |
| 本地服务 | Fastify + WebSocket | 本地 API、任务流、图谱查询、实时日志事件 |
| 桌面主进程 | Electron Main | 启动本地服务、管理窗口、权限、菜单、Keychain、进程生命周期 |
| UI | React + TypeScript + TanStack Router | 项目、任务、图谱、终端、设置等页面 |
| 状态管理 | Zustand + TanStack Query | UI 本地状态和服务端数据缓存 |
| 数据库 | SQLite + Drizzle ORM 或 Kysely | 本地持久化、迁移、类型安全查询 |
| 终端 | node-pty + xterm.js | AI CLI 交互式 PTY 与终端展示 |
| 代码扫描 | tree-sitter、ripgrep、fast-xml-parser、node-sql-parser | 多语言解析、Spring/MyBatis/SQL 抽取 |
| Git | simple-git + 原生 git 命令兜底 | 状态、diff、分支、提交、stash、patch |
| 图谱 | SQLite nodes/edges + graphology | 本地图谱事实层 |
| 大图渲染 | Sigma.js / WebGL | 系统总览、模块依赖、表关系大图 |
| 中小图交互 | React Flow | 接口调用链、模块流程、方法逻辑 |
| 布局 | elkjs / dagre / graphology layout | 后台计算视图布局并缓存 |
| 图文本渲染 | Mermaid | 时序图、流程图预览和导出 |
| 安全存储 | macOS Keychain via keytar | Token、API Key、敏感配置 |
| 打包 | electron-builder | DMG、ZIP、签名预留、notarization 预留 |
| 包管理 | pnpm workspace | Monorepo 管理 |
| 测试 | Vitest、Playwright、Electron smoke tests | 单测、集成、UI、真实扫描测试 |

### 2.2 为什么选择 Electron

Zeus 的核心 UI 包含复杂图谱、终端、diff review、Markdown、WebSocket 日志、多面板交互。Electron 可以直接复用成熟 Web 生态，并且 Node 主进程可以自然集成 PTY、SQLite、Git、文件扫描和 Telegram long polling。

### 2.3 原生 macOS 集成范围

1. 应用菜单。
2. 文件夹选择器。
3. 系统通知。
4. Keychain。
5. Menu Bar 常驻。
6. 开机启动设置预留。
7. DMG/ZIP 打包。
8. 签名与 notarization 预留。

---

## 3. 仓库结构

在 `/Users/david/hypha/zeus` 创建以下结构：

```text
zeus/
├── apps/
│   └── desktop/
│       ├── src/
│       │   ├── main/                 # Electron Main
│       │   ├── preload/              # 安全 IPC bridge
│       │   └── renderer/             # React UI
│       ├── assets/
│       ├── electron-builder.yml
│       └── package.json
│
├── packages/
│   ├── shared/                       # DTO、事件、枚举、错误码、类型
│   ├── local-server/                 # Fastify API + WebSocket
│   ├── storage/                      # SQLite、migrations、repositories
│   ├── project-core/                 # 项目管理领域逻辑
│   ├── task-core/                    # 任务管理领域逻辑
│   ├── ai-runtime/                   # PTY、AI CLI adapters、session runtime
│   ├── terminal-core/                # terminal buffer、event stream
│   ├── git-core/                     # git status/diff/branch/commit/stash
│   ├── code-indexer/                 # 扫描器与语言抽取器
│   ├── graph-engine/                 # nodes/edges、视图生成、布局
│   ├── diagram-engine/               # Mermaid/React Flow/Sigma 数据转换
│   ├── telegram-adapter/             # Telegram long polling 与命令
│   ├── security-core/                # Keychain、token、权限、安全策略
│   └── release-core/                 # 版本、更新、发布辅助
│
├── scripts/
│   ├── dev.sh
│   ├── build.sh
│   ├── test-real-scan.sh
│   ├── package-mac.sh
│   └── verify-release.sh
│
├── docs/
│   ├── architecture.md
│   ├── local-first.md
│   ├── security.md
│   ├── code-map-engine.md
│   ├── ai-runtime.md
│   ├── telegram.md
│   ├── release.md
│   └── testing.md
│
├── .github/
│   ├── workflows/
│   │   ├── ci.yml
│   │   └── release.yml
│   ├── ISSUE_TEMPLATE/
│   └── pull_request_template.md
│
├── pnpm-workspace.yaml
├── package.json
├── tsconfig.base.json
├── eslint.config.js
├── prettier.config.js
├── README.md
├── CONTRIBUTING.md
├── LICENSE
└── ROADMAP.md
```

---

## 4. 应用架构

### 4.1 进程模型

```text
Zeus.app
├── Electron Main
│   ├── 启动 Local Server
│   ├── 管理窗口、菜单、托盘、通知
│   ├── 管理 app 生命周期
│   ├── 管理安全 IPC
│   └── 管理 Keychain 访问
│
├── Local Server
│   ├── HTTP API: 127.0.0.1 only
│   ├── WebSocket event bus
│   ├── SQLite repositories
│   ├── Task runner
│   ├── AI runtime manager
│   ├── Code indexer worker scheduler
│   └── Telegram adapter
│
├── Worker Processes
│   ├── Code scanning worker
│   ├── Graph layout worker
│   ├── AI session worker
│   └── Git diff worker
│
└── Renderer
    ├── Project UI
    ├── Task UI
    ├── Graph UI
    ├── Terminal UI
    ├── Diff UI
    └── Settings UI
```

### 4.2 本地服务启动流程

1. Electron Main 获取用户数据目录。
2. 初始化目录结构：

```text
~/Library/Application Support/Zeus/
├── zeus.db
├── logs/
├── sessions/
├── terminal/
├── graph-cache/
├── code-index/
├── exports/
└── config/
```

3. 初始化 SQLite。
4. 执行 migrations。
5. 生成或读取本地 API token。
6. 启动 Local Server，仅绑定 `127.0.0.1`。
7. 启动 WebSocket event bus。
8. 打开主窗口。
9. Renderer 通过 preload 获取本地服务端口和 token。
10. Renderer 调用 `/health`，进入应用。

### 4.3 事件总线

所有长任务通过事件总线统一推送：

```ts
type ZeusEvent =
  | ProjectEvent
  | TaskEvent
  | RuntimeEvent
  | TerminalEvent
  | GraphEvent
  | GitEvent
  | TelegramEvent
  | SecurityEvent;
```

事件必须写入 `event_log` 表，重要事件还要写入对应领域表。

---

## 5. 本地存储设计

### 5.1 数据库原则

1. SQLite 是唯一默认持久化数据库。
2. 不使用云端数据库。
3. 不写入任何虚假业务记录。
4. 所有数据有明确来源。
5. 所有迁移可重复执行。
6. 删除操作默认软删除，除非用户明确清理。

### 5.2 核心表

#### app_settings

```sql
CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  value_type TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

#### projects

```sql
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  local_path TEXT NOT NULL,
  git_root TEXT,
  project_type TEXT,
  primary_language TEXT,
  description TEXT,
  default_model TEXT,
  default_work_mode TEXT,
  scan_status TEXT NOT NULL DEFAULT 'not_scanned',
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
```

#### project_configs

```sql
CREATE TABLE project_configs (
  project_id TEXT PRIMARY KEY,
  ignore_rules_json TEXT NOT NULL,
  scan_scope_json TEXT NOT NULL,
  language_config_json TEXT NOT NULL,
  database_config_ref TEXT,
  telegram_alias TEXT,
  security_policy_json TEXT NOT NULL,
  default_prompt TEXT,
  updated_at TEXT NOT NULL
);
```

#### tasks

```sql
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal',
  tags_json TEXT NOT NULL,
  template_id TEXT,
  model TEXT,
  work_dir TEXT,
  allow_code_changes INTEGER NOT NULL DEFAULT 0,
  allow_tests INTEGER NOT NULL DEFAULT 0,
  allow_git_commit INTEGER NOT NULL DEFAULT 0,
  created_from TEXT NOT NULL,
  source_context_json TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  deleted_at TEXT
);
```

#### task_events

```sql
CREATE TABLE task_events (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  title TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

#### task_templates

```sql
CREATE TABLE task_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  prompt_template TEXT NOT NULL,
  default_options_json TEXT NOT NULL,
  project_id TEXT,
  built_in INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

内置模板不作为 mock 数据。它们是产品功能定义，允许迁移时写入，但必须被标记为 `built_in = 1`，且不得伪造项目、任务或执行结果。

#### runtime_sessions

```sql
CREATE TABLE runtime_sessions (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  project_id TEXT NOT NULL,
  adapter_type TEXT NOT NULL,
  status TEXT NOT NULL,
  pid INTEGER,
  cwd TEXT NOT NULL,
  command TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  exit_code INTEGER,
  metadata_json TEXT NOT NULL
);
```

#### terminal_events

```sql
CREATE TABLE terminal_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  task_id TEXT,
  seq INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  content TEXT NOT NULL,
  raw_chunk_path TEXT,
  created_at TEXT NOT NULL
);
```

#### conversations

```sql
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT,
  session_id TEXT,
  title TEXT NOT NULL,
  summary TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0
);
```

#### conversation_messages

```sql
CREATE TABLE conversation_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  source TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

#### git_snapshots

```sql
CREATE TABLE git_snapshots (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  snapshot_type TEXT NOT NULL,
  branch TEXT,
  head_sha TEXT,
  status_json TEXT NOT NULL,
  diff_text_path TEXT,
  created_at TEXT NOT NULL
);
```

#### git_changes

```sql
CREATE TABLE git_changes (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  change_type TEXT NOT NULL,
  additions INTEGER NOT NULL DEFAULT 0,
  deletions INTEGER NOT NULL DEFAULT 0,
  diff_hunk_path TEXT,
  linked_graph_nodes_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

#### code_symbols

```sql
CREATE TABLE code_symbols (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  symbol_type TEXT NOT NULL,
  name TEXT NOT NULL,
  qualified_name TEXT,
  file_path TEXT NOT NULL,
  line_start INTEGER,
  line_end INTEGER,
  language TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

#### api_endpoints

```sql
CREATE TABLE api_endpoints (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  module_id TEXT,
  http_method TEXT NOT NULL,
  path TEXT NOT NULL,
  controller_symbol_id TEXT,
  handler_method_symbol_id TEXT,
  request_type TEXT,
  response_type TEXT,
  source_file TEXT NOT NULL,
  line_start INTEGER,
  line_end INTEGER,
  metadata_json TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

#### sql_statements

```sql
CREATE TABLE sql_statements (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  mapper_symbol_id TEXT,
  sql_id TEXT,
  sql_type TEXT NOT NULL,
  sql_text TEXT NOT NULL,
  source_file TEXT NOT NULL,
  line_start INTEGER,
  line_end INTEGER,
  tables_json TEXT NOT NULL,
  fields_json TEXT NOT NULL,
  parse_status TEXT NOT NULL,
  parse_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

#### db_tables

```sql
CREATE TABLE db_tables (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  schema_name TEXT,
  table_name TEXT NOT NULL,
  comment TEXT,
  source_type TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

#### db_columns

```sql
CREATE TABLE db_columns (
  id TEXT PRIMARY KEY,
  table_id TEXT NOT NULL,
  column_name TEXT NOT NULL,
  data_type TEXT,
  nullable INTEGER,
  primary_key INTEGER NOT NULL DEFAULT 0,
  indexed INTEGER NOT NULL DEFAULT 0,
  comment TEXT,
  metadata_json TEXT NOT NULL
);
```

#### project_nodes

```sql
CREATE TABLE project_nodes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  node_type TEXT NOT NULL,
  name TEXT NOT NULL,
  qualified_name TEXT,
  file_path TEXT,
  symbol_id TEXT,
  line_start INTEGER,
  line_end INTEGER,
  summary TEXT,
  metadata_json TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  source_type TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

#### project_edges

```sql
CREATE TABLE project_edges (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  source_node_id TEXT NOT NULL,
  target_node_id TEXT NOT NULL,
  edge_type TEXT NOT NULL,
  label TEXT,
  metadata_json TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  source_type TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

#### graph_views

```sql
CREATE TABLE graph_views (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  view_type TEXT NOT NULL,
  root_node_id TEXT,
  title TEXT NOT NULL,
  description TEXT,
  query_json TEXT NOT NULL,
  layout_json TEXT NOT NULL,
  stats_json TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  source_hash TEXT NOT NULL
);
```

#### telegram_settings

```sql
CREATE TABLE telegram_settings (
  id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  bot_token_keychain_ref TEXT,
  allowed_user_ids_json TEXT NOT NULL,
  command_policy_json TEXT NOT NULL,
  notification_policy_json TEXT NOT NULL,
  last_poll_offset INTEGER,
  updated_at TEXT NOT NULL
);
```

#### audit_logs

```sql
CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  actor_type TEXT NOT NULL,
  actor_ref TEXT,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

### 5.3 索引要求

必须创建以下索引：

1. `projects(slug)`
2. `tasks(project_id, status, updated_at)`
3. `task_events(task_id, created_at)`
4. `runtime_sessions(task_id, status)`
5. `terminal_events(session_id, seq)`
6. `code_symbols(project_id, symbol_type, qualified_name)`
7. `api_endpoints(project_id, http_method, path)`
8. `sql_statements(project_id, sql_type)`
9. `db_tables(project_id, table_name)`
10. `project_nodes(project_id, node_type, name)`
11. `project_edges(project_id, source_node_id, edge_type)`
12. `project_edges(project_id, target_node_id, edge_type)`
13. `graph_views(project_id, view_type, root_node_id)`

---

## 6. UI 信息架构

### 6.1 主导航

左侧主导航：

1. Dashboard
2. Projects
3. Tasks
4. Code Map
5. Sessions
6. Git Changes
7. Telegram
8. Settings

### 6.2 Dashboard

显示：

1. 项目总数。
2. 活跃任务。
3. 正在执行的 AI 会话。
4. 最近完成任务。
5. 最近扫描项目。
6. 最近代码变更。
7. Telegram 状态。
8. AI CLI 可用状态。
9. 本地服务状态。
10. 安全提醒。

没有数据时显示空状态，不写入任何虚假记录。

### 6.3 Projects 页面

功能：

1. 项目列表。
2. 创建项目。
3. 选择本地代码库。
4. 编辑项目。
5. 删除/归档项目。
6. 自动识别 Git root。
7. 自动识别 Maven/Gradle/Node 项目。
8. 项目配置。
9. 项目扫描按钮。
10. 项目概览卡片。

### 6.4 Project Detail 页面

Tabs：

1. Overview
2. Tasks
3. Code Map
4. APIs
5. Tables
6. Sessions
7. Git
8. Settings

### 6.5 Tasks 页面

功能：

1. Kanban 或列表视图。
2. 搜索、筛选、排序。
3. 标签。
4. 任务模板。
5. 任务详情。
6. 状态时间线。
7. 执行按钮。
8. 暂停/继续/取消/重试。
9. 关联会话。
10. 关联 Git diff。

### 6.6 Task Detail 页面

区域：

1. 任务目标。
2. 任务配置。
3. 状态时间线。
4. 实时终端。
5. AI 回复摘要。
6. Git diff。
7. 关联图谱节点。
8. 操作按钮。
9. 审计日志。
10. Telegram 通知记录。

### 6.7 Code Map 页面

全局 Code Map 包含：

1. 系统架构图。
2. 模块依赖图。
3. 表关系图。
4. API 列表。
5. 模块详情图。
6. 接口时序图。
7. 模块流程图。
8. 方法逻辑图。
9. 搜索。
10. 过滤。
11. 节点详情。
12. 从节点创建任务。
13. 图谱问答。
14. 导出。

### 6.8 Sessions 页面

功能：

1. 会话列表。
2. 会话详情。
3. 会话继续追问。
4. 会话摘要。
5. 会话收藏。
6. 会话搜索。
7. 会话归档。
8. 会话删除。
9. 会话绑定任务。
10. 会话绑定项目。

### 6.9 Git Changes 页面

功能：

1. 当前 Git 状态。
2. 当前分支。
3. 未提交变更。
4. 文件级 diff。
5. 行级 diff。
6. 接受/拒绝变更。
7. 回滚任务变更。
8. 创建分支。
9. 提交代码。
10. 生成 commit message。
11. stash。
12. patch 导出。

### 6.10 Telegram 页面

功能：

1. 配置 Bot Token。
2. 配置白名单 user id。
3. 启用/停用。
4. 查看连接状态。
5. 命令帮助。
6. 消息日志。
7. 通知策略。
8. 安全确认策略。
9. 测试连接。
10. 清理 token。

### 6.11 Settings 页面

Tabs：

1. General
2. AI Runtime
3. Security
4. Storage
5. Code Map
6. Git
7. Telegram
8. Developer
9. About

---

## 7. API 设计

Local Server 仅本地访问，所有请求都必须携带本地 API token。

### 7.1 Health

```http
GET /health
```

返回：

```json
{
  "status": "ok",
  "appName": "Zeus",
  "version": "0.1.0",
  "database": "ok",
  "runtime": "ok"
}
```

### 7.2 Projects

```http
GET /api/projects
POST /api/projects
GET /api/projects/:projectId
PATCH /api/projects/:projectId
DELETE /api/projects/:projectId
POST /api/projects/:projectId/archive
POST /api/projects/:projectId/scan
GET /api/projects/:projectId/scan-status
GET /api/projects/:projectId/overview
```

### 7.3 Tasks

```http
GET /api/tasks
POST /api/tasks
GET /api/tasks/:taskId
PATCH /api/tasks/:taskId
DELETE /api/tasks/:taskId
POST /api/tasks/:taskId/run
POST /api/tasks/:taskId/pause
POST /api/tasks/:taskId/continue
POST /api/tasks/:taskId/cancel
POST /api/tasks/:taskId/retry
POST /api/tasks/:taskId/archive
GET /api/tasks/:taskId/events
GET /api/tasks/:taskId/diff
```

### 7.4 Runtime

```http
GET /api/runtime/adapters
GET /api/runtime/adapters/:adapter/check
POST /api/runtime/sessions
GET /api/runtime/sessions
GET /api/runtime/sessions/:sessionId
POST /api/runtime/sessions/:sessionId/input
POST /api/runtime/sessions/:sessionId/interrupt
POST /api/runtime/sessions/:sessionId/resize
POST /api/runtime/sessions/:sessionId/stop
GET /api/runtime/sessions/:sessionId/terminal
```

### 7.5 Git

```http
GET /api/projects/:projectId/git/status
GET /api/projects/:projectId/git/diff
POST /api/projects/:projectId/git/snapshot
POST /api/projects/:projectId/git/branch
POST /api/projects/:projectId/git/checkout
POST /api/projects/:projectId/git/commit
POST /api/projects/:projectId/git/stash
POST /api/projects/:projectId/git/apply-stash
POST /api/projects/:projectId/git/patch
POST /api/tasks/:taskId/git/rollback
```

### 7.6 Code Map

```http
GET /api/projects/:projectId/graph/views
POST /api/projects/:projectId/graph/views/generate
GET /api/projects/:projectId/graph/views/:viewId
GET /api/projects/:projectId/graph/search
GET /api/projects/:projectId/graph/nodes/:nodeId
GET /api/projects/:projectId/graph/nodes/:nodeId/neighborhood
GET /api/projects/:projectId/apis
GET /api/projects/:projectId/apis/:apiId
GET /api/projects/:projectId/apis/:apiId/sequence
GET /api/projects/:projectId/modules
GET /api/projects/:projectId/modules/:moduleId
GET /api/projects/:projectId/modules/:moduleId/flow
GET /api/projects/:projectId/tables
GET /api/projects/:projectId/tables/:tableId
GET /api/projects/:projectId/tables/:tableId/impact
GET /api/projects/:projectId/methods/:methodId/logic
```

### 7.7 AI + Graph

```http
POST /api/projects/:projectId/ask
POST /api/projects/:projectId/graph/nodes/:nodeId/create-task
POST /api/projects/:projectId/graph/views/:viewId/create-task
POST /api/tasks/:taskId/link-graph-node
```

### 7.8 Telegram

```http
GET /api/telegram/status
PATCH /api/telegram/settings
POST /api/telegram/start
POST /api/telegram/stop
POST /api/telegram/test
GET /api/telegram/messages
```

### 7.9 WebSocket

```text
WS /api/events
```

事件类型：

```text
project.created
project.updated
project.scan.started
project.scan.progress
project.scan.completed
project.scan.failed

task.created
task.updated
task.started
task.waiting_confirmation
task.completed
task.failed
task.cancelled
task.retried

runtime.session.created
runtime.session.started
runtime.session.output
runtime.session.error
runtime.session.ended

git.snapshot.created
git.diff.updated

graph.view.generated
graph.scan.progress

telegram.started
telegram.message.received
telegram.command.executed
telegram.notification.sent

security.confirmation.required
security.confirmation.approved
security.confirmation.rejected
```

---

## 8. 项目管理实现

### 8.1 创建项目

输入：

1. 项目名称。
2. 本地路径。
3. 可选描述。
4. 默认 AI adapter。
5. 默认工作模式。

流程：

1. Electron 调用系统文件夹选择器。
2. 验证路径存在。
3. 验证路径可读。
4. 检测 Git root。
5. 检测项目类型。
6. 生成 slug。
7. 写入 `projects`。
8. 写入默认 `project_configs`。
9. 创建项目目录缓存。
10. 返回项目详情。

### 8.2 项目类型识别

识别规则：

1. `pom.xml`：Maven Java 项目。
2. `build.gradle` / `settings.gradle`：Gradle Java 项目。
3. `package.json`：Node/TypeScript 项目。
4. `tsconfig.json`：TypeScript 项目。
5. `src/main/java`：Spring/Java 项目。
6. `mapper/**/*.xml`：MyBatis 项目。
7. `.git` 或 Git root：Git 项目。

### 8.3 项目配置

支持：

1. ignore rules：默认忽略 `.git`、`node_modules`、`target`、`build`、`dist`、`.next`、`.idea`、`.gradle`。
2. scan scope：源码目录、配置目录、SQL/DDL 目录。
3. language config：Java、TypeScript、SQL、XML。
4. database config：本地 schema 导入、数据库连接引用。
5. security policy：远程任务权限、允许修改代码、允许执行命令。
6. default prompt：项目默认任务说明。

---

## 9. 任务管理实现

### 9.1 任务状态机

```text
DRAFT
  -> READY
  -> RUNNING
  -> WAITING_CONFIRMATION
  -> PAUSED
  -> COMPLETED
  -> FAILED
  -> CANCELLED
  -> ARCHIVED
```

允许转移：

1. READY -> RUNNING
2. RUNNING -> WAITING_CONFIRMATION
3. WAITING_CONFIRMATION -> RUNNING
4. RUNNING -> PAUSED
5. PAUSED -> RUNNING
6. RUNNING -> COMPLETED
7. RUNNING -> FAILED
8. RUNNING -> CANCELLED
9. FAILED -> READY
10. COMPLETED -> ARCHIVED
11. CANCELLED -> ARCHIVED

每次状态变化必须写入 `task_events`。

### 9.2 任务创建

来源：

1. 手动创建。
2. 从模块创建。
3. 从接口创建。
4. 从表创建。
5. 从方法创建。
6. 从调用链创建。
7. 从 Telegram 创建。
8. 从会话继续创建。

source_context 必须保存真实上下文来源：

```json
{
  "type": "graph_node",
  "projectId": "...",
  "nodeId": "...",
  "sourceFile": "src/main/java/...",
  "lineStart": 10,
  "lineEnd": 60
}
```

### 9.3 任务模板

内置模板：

1. 需求分析。
2. 代码实现。
3. Bug 修复。
4. 代码评审。
5. 单元测试。
6. 性能分析。
7. 架构分析。
8. SQL 优化。
9. 自定义模板。
10. 项目默认模板。

模板只是 prompt 模板，不是任务数据，不违反无虚假数据约束。

### 9.4 任务执行前检查

1. 项目存在。
2. 本地路径存在。
3. 工作目录在项目路径内。
4. Git 状态已读取。
5. 如果允许修改代码，创建执行前 Git 快照。
6. AI adapter 可用。
7. 任务 prompt 已生成。
8. 高风险策略已确认。

### 9.5 任务执行后处理

1. 保存终端日志。
2. 保存会话记录。
3. 读取 Git diff。
4. 生成变更摘要。
5. 更新任务状态。
6. 关联变更文件到图谱节点。
7. 发送通知。
8. 写入审计日志。

---

## 10. AI Runtime 设计

### 10.1 Adapter 接口

```ts
export interface AiCliAdapter {
  id: string;
  displayName: string;
  detect(): Promise<AdapterDetectionResult>;
  buildCommand(input: BuildCommandInput): Promise<RuntimeCommand>;
  buildPrompt(input: BuildPromptInput): Promise<string>;
  parseOutput(chunk: string, context: RuntimeParseContext): RuntimeParsedEvent[];
  detectWaitingForInput(buffer: TerminalBuffer): boolean;
  detectCompletion(buffer: TerminalBuffer): boolean;
  detectError(buffer: TerminalBuffer): RuntimeError | null;
}
```

### 10.2 必须实现的 adapters

1. OpenAI Codex CLI adapter。
2. Claude Code CLI adapter。
3. Gemini CLI adapter。
4. 通用 CLI adapter。

每个 adapter 必须支持：

1. 本机命令检测。
2. 版本检测。
3. 登录/认证状态检测。
4. 模型配置。
5. 工作目录配置。
6. prompt 输入。
7. 输出解析。
8. 等待输入状态识别。
9. 完成识别。
10. 错误识别。

如果 CLI 未安装，不得伪造可用状态。

### 10.3 PTY Session

```ts
export interface PtySession {
  id: string;
  projectId: string;
  taskId?: string;
  status: 'created' | 'running' | 'waiting' | 'ended' | 'failed';
  start(): Promise<void>;
  write(input: string): Promise<void>;
  interrupt(): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  stop(reason: string): Promise<void>;
  getSnapshot(): Promise<TerminalSnapshot>;
}
```

### 10.4 会话恢复

1. App 重启后读取 `runtime_sessions` 中未结束会话。
2. 检查 PID 是否仍存在。
3. 若 PID 存在，标记为 `orphan_detected`，允许用户重新附着或终止。
4. 若 PID 不存在，标记为 `lost`，保存已收集日志。
5. 不得伪造恢复成功。

### 10.5 并发控制

1. 默认每个项目最多 1 个运行中 AI 会话。
2. 全局默认最多 2 个运行中 AI 会话。
3. 用户可在设置中修改。
4. 超出限制的任务进入 READY。

### 10.6 prompt 生成

任务 prompt 必须包含：

1. 任务标题。
2. 任务描述。
3. 项目路径。
4. 允许/禁止事项。
5. 相关图谱上下文。
6. 相关源码路径和行号。
7. 相关 SQL/表。
8. Git 状态摘要。
9. 测试要求。
10. 安全要求。

不得包含虚假上下文。

---

## 11. 终端与会话实现

### 11.1 终端视图

使用 xterm.js：

1. 实时输出。
2. 自动滚动。
3. 搜索。
4. 复制。
5. 折叠。
6. 错误高亮。
7. 命令高亮。
8. AI 回复高亮。
9. 原始输出查看。
10. 导出。

### 11.2 日志保存

每个 session 目录：

```text
~/Library/Application Support/Zeus/sessions/<sessionId>/
├── terminal.raw.log
├── terminal.normalized.log
├── metadata.json
└── chunks/
```

SQLite 保存事件索引，文件保存大文本。

### 11.3 会话摘要

会话摘要必须由真实会话内容生成。如果没有可用 AI 或摘要失败，显示“未生成摘要”，不得写入伪摘要。

---

## 12. Git 与 Diff 实现

### 12.1 Git 状态

显示：

1. 当前分支。
2. HEAD SHA。
3. 是否 clean。
4. 新增文件。
5. 修改文件。
6. 删除文件。
7. 冲突文件。
8. stash 数量。
9. 远程分支。
10. 最近提交。

### 12.2 快照

执行任务前：

1. 保存 `git status --porcelain=v1`。
2. 保存 `git rev-parse HEAD`。
3. 保存 `git diff`。
4. 写入 `git_snapshots`。

执行任务后：

1. 保存新的 status。
2. 保存新的 diff。
3. 写入 `git_changes`。
4. 关联修改文件到图谱节点。

### 12.3 Diff Review

功能：

1. 文件级 diff。
2. 行级 diff。
3. 任务前后对比。
4. 接受变更。
5. 拒绝变更。
6. 回滚任务变更。
7. AI 总结变更。
8. 变更关联任务。
9. 变更关联代码地图节点。
10. patch 导出。

### 12.4 高风险 Git 操作

以下操作必须二次确认：

1. commit。
2. push。
3. checkout 会覆盖工作区时。
4. reset。
5. stash apply。
6. rollback。
7. 删除文件。

---

## 13. 代码扫描与索引

### 13.1 扫描原则

1. 只扫描真实文件。
2. 遵守 ignore rules。
3. 不跟踪 `.git`、`node_modules`、`target`、`build`、`dist`。
4. 计算文件 hash，支持增量扫描。
5. 所有节点和边必须有 source_ref。
6. 解析失败不能导致全局失败，必须记录 parse error。

### 13.2 扫描阶段

1. Project discovery。
2. File inventory。
3. Language detection。
4. Symbol extraction。
5. API extraction。
6. SQL extraction。
7. DB schema extraction。
8. Call relation extraction。
9. Module classification。
10. Graph build。
11. View generation。
12. Layout caching。

### 13.3 Java/Spring 解析

必须识别：

1. Java 类。
2. 方法。
3. 字段。
4. Controller。
5. RequestMapping/GetMapping/PostMapping/PutMapping/DeleteMapping/PatchMapping。
6. Service。
7. Component。
8. Repository。
9. Transactional。
10. Async。
11. Feign Client。
12. MQ listener。
13. Job 入口。
14. Mapper Interface。
15. 方法调用。

### 13.4 TypeScript/JavaScript 解析

为了当前项目自扫描，必须支持：

1. package.json。
2. tsconfig。
3. TypeScript 文件。
4. 函数声明。
5. 类声明。
6. interface/type。
7. imports/exports。
8. React components。
9. API route handler。
10. Electron main/preload/renderer 模块关系。

### 13.5 MyBatis/XML 解析

必须识别：

1. Mapper XML。
2. namespace。
3. select/insert/update/delete。
4. sql fragments。
5. resultMap。
6. include。
7. if/choose/foreach 动态 SQL 标签。
8. SQL id。
9. SQL 原文。
10. 源文件行号。

动态 SQL 不能完全还原时，必须尽力提取表和字段，并标注 confidence。

### 13.6 SQL 解析

必须识别：

1. SELECT。
2. INSERT。
3. UPDATE。
4. DELETE。
5. 表名。
6. 字段名。
7. JOIN。
8. WHERE 中字段。
9. ORDER/GROUP 字段。
10. 子查询中的表。

### 13.7 数据库 Schema

支持两种真实来源：

1. 用户导入 DDL 文件。
2. 用户配置数据库连接后读取 schema。

不得创建虚假 schema。

提取：

1. 表。
2. 字段。
3. 类型。
4. 主键。
5. 索引。
6. 外键。
7. 注释。
8. schema 名。
9. 关系。
10. 版本缓存。

---

## 14. 图谱模型

### 14.1 节点类型

```text
SYSTEM
MODULE
MAVEN_MODULE
GRADLE_MODULE
PACKAGE
DIRECTORY
FILE
CLASS
INTERFACE
METHOD
FIELD
API
SERVICE
CONTROLLER
MAPPER
SQL
TABLE
COLUMN
JOB
MQ_CONSUMER
MQ_PRODUCER
REMOTE_CLIENT
CONFIG
TASK
SESSION
GIT_CHANGE
```

### 14.2 边类型

```text
CONTAINS
DECLARES
IMPORTS
CALLS
IMPLEMENTS
EXTENDS
EXPOSES_API
HANDLES_API
READS_TABLE
WRITES_TABLE
JOINS_TABLE
USES_COLUMN
PUBLISHES_EVENT
CONSUMES_EVENT
CALLS_REMOTE
DEPENDS_ON
BELONGS_TO_MODULE
RELATED_TASK
RELATED_SESSION
CHANGED_BY
GENERATED_VIEW
```

### 14.3 来源类型

```text
SOURCE_FILE
AST
XML
SQL
DDL
DB_INTROSPECTION
GIT
USER_CREATED
TASK_EXECUTION
AI_SUMMARY
```

AI_SUMMARY 只能用于摘要、命名、解释，不能作为唯一事实来源创建结构边。

### 14.4 置信度

1. 1.0：源码 AST、数据库外键、明确注解、明确 SQL。
2. 0.8：XML namespace、Mapper 方法匹配。
3. 0.6：命名规则推断、JOIN 推断。
4. 0.4：AI 辅助归类。
5. 低于 0.5 的边默认隐藏，但可通过过滤器显示。

---

## 15. 视图生成

### 15.1 系统架构图

目标：查看项目整体结构。

数据：

1. Maven/Gradle/Node 模块。
2. 包结构。
3. 目录结构。
4. Controller/Service/Mapper。
5. 外部依赖。
6. 表关系。
7. 任务关联。

生成：

1. 模块作为第一层节点。
2. 依赖边基于 imports、calls、SQL 表共用、remote calls。
3. 节点显示接口数、表数、任务数、最近变更数。
4. 大图用 Sigma.js。
5. 点击进入模块详情。

### 15.2 表关系图

目标：查看数据库表与接口读写关系。

生成：

1. 表节点。
2. 外键边。
3. JOIN 推断边。
4. 命名推断边。
5. API 读写边。
6. SQL 读写边。
7. Mapper 读写边。

显示：

1. 实线：明确关系。
2. 虚线：推断关系。
3. 颜色区分读/写/读写。
4. 点击表查看字段、SQL、接口、影响分析。

### 15.3 模块详情图

点击模块后展示：

1. 模块接口列表。
2. Service 列表。
3. Mapper 列表。
4. 表列表。
5. 任务历史。
6. 最近变更。
7. 风险标签。
8. AI 摘要。
9. 模块调用关系图。
10. 创建任务按钮。

### 15.4 接口时序图

点击 API 后生成：

1. Client。
2. Controller。
3. Service。
4. Manager/Component。
5. Mapper。
6. DB。
7. Remote Client。
8. MQ。
9. Job/Async 边界。
10. 返回。

输出：

1. Mermaid sequence diagram。
2. React Flow interactive sequence。
3. 来源列表。
4. 可点击跳源码。

### 15.5 模块流程图

生成方式：

1. 找出模块下 API。
2. 按路径、方法名、表读写、调用链聚类。
3. 生成候选业务流程。
4. AI 只基于真实候选流程生成摘要。
5. 每个流程节点链接 API、方法、SQL、表。
6. 支持人工编辑和保存。

### 15.6 方法逻辑图

点击方法后：

1. 解析 if/else。
2. 解析 loop。
3. 解析 try/catch。
4. 解析 return。
5. 解析事务边界。
6. 解析异常分支。
7. 解析 SQL 调用。
8. 生成流程图。
9. 支持 AI 解释。
10. 支持源码行跳转。

---

## 16. 图交互与性能

### 16.1 渲染分层

| 场景 | 推荐渲染 |
|---|---|
| 系统总览大图 | Sigma.js / WebGL |
| 模块依赖图 | Sigma.js 或 Cytoscape |
| 表关系图 | Cytoscape 或 Sigma.js |
| 接口调用链 | React Flow |
| 方法逻辑图 | React Flow |
| Mermaid 预览 | Mermaid renderer |

### 16.2 性能规则

1. 不一次性渲染全量方法级图。
2. 默认只展示模块级聚合。
3. 节点详情按需加载。
4. 边默认聚合。
5. 低置信边默认隐藏。
6. 默认调用链深度 3。
7. getter/setter/log/util 默认过滤。
8. 布局后台计算。
9. 视图结果缓存。
10. 搜索定位优先于拖拽查找。

### 16.3 图搜索

支持搜索：

1. 模块名。
2. 类名。
3. 方法名。
4. API path。
5. 表名。
6. 字段名。
7. SQL id。
8. 文件路径。
9. 任务标题。
10. Git 变更文件。

### 16.4 节点操作

右键菜单：

1. 查看详情。
2. 跳转源码。
3. 生成时序图。
4. 生成流程图。
5. 查看影响分析。
6. 创建任务。
7. 提问。
8. 隐藏节点。
9. 展开一跳。
10. 展开二跳。

---

## 17. AI 与图谱联动

### 17.1 图谱问答

用户可针对：

1. 项目。
2. 模块。
3. 接口。
4. 表。
5. 方法。
6. 调用链。
7. Git diff。
8. 任务。

提问。

回答必须带来源：

1. 文件路径。
2. 行号。
3. SQL id。
4. 表名。
5. 图节点。
6. 任务记录。

如果没有足够来源，回答必须说明“不足以判断”。

### 17.2 从图创建任务

创建任务时自动填充：

1. 节点类型。
2. 节点名称。
3. 来源文件。
4. 行号。
5. 相关上游/下游。
6. 相关表。
7. 相关 SQL。
8. 相关 Git 变更。
9. 建议测试范围。
10. 风险提示。

### 17.3 任务完成后回写

1. 任务关联节点。
2. 变更文件关联节点。
3. 变更摘要关联模块。
4. 最近任务展示。
5. 风险标签更新。

---

## 18. Telegram 远程入口

### 18.1 接入方式

使用 Telegram Bot API long polling。本地 Zeus 主动轮询，不需要公网服务。

### 18.2 安全策略

1. 必须配置 Bot Token。
2. 必须配置 allowed user id。
3. 不在 UI 明文显示 token。
4. Token 存 Keychain。
5. 远程高风险操作二次确认。
6. 默认禁止远程执行 shell 命令。
7. 远程任务默认不允许自动提交 Git。
8. 所有命令写入审计日志。

### 18.3 命令

```text
/start
/help
/projects
/tasks
/run <project> <task>
/status <task>
/stop <task>
/continue <task>
/logs <task>
/diff <task>
/ask <project> <question>
```

### 18.4 通知

1. 任务开始。
2. 任务阶段变化。
3. 任务等待确认。
4. 任务完成。
5. 任务失败。
6. 代码变更摘要。
7. 测试失败。
8. 长任务阶段摘要。
9. 安全确认。
10. 静默模式。

### 18.5 Telegram 消息限制处理

1. 长日志自动截断。
2. 大 diff 只发摘要。
3. 支持用户请求完整日志导出。
4. 错误信息脱敏。
5. 不发送密钥、token、环境变量。

---

## 19. 安全设计

### 19.1 本地服务

1. 仅 `127.0.0.1`。
2. 使用随机端口。
3. 使用本地 API token。
4. Renderer 通过 preload 获取 token。
5. 禁用任意网页访问 API。
6. CORS 仅允许本地应用 origin。
7. 审计敏感操作。

### 19.2 执行目录限制

AI runtime、Git 操作、文件操作必须限制在项目路径内。任何路径跳出项目目录时必须拒绝或二次确认。

### 19.3 Keychain

存储：

1. Telegram Bot Token。
2. 外部 API Key。
3. 本地 API token。
4. 数据库连接密码。

### 19.4 高风险二次确认

触发条件：

1. 删除文件。
2. 修改大量文件。
3. 执行 shell 命令。
4. Git commit。
5. Git push。
6. Git reset。
7. 回滚变更。
8. 写入项目外目录。
9. 访问敏感目录。
10. 读取疑似密钥文件。

### 19.5 敏感日志脱敏

需要脱敏：

1. API key。
2. Bot token。
3. Authorization header。
4. Cookie。
5. SSH key。
6. 数据库密码。
7. `.env` 中敏感值。

---

## 20. 设置中心

### 20.1 通用设置

1. 应用语言。
2. 主题。
3. 数据目录。
4. 日志目录。
5. 缓存清理。
6. 默认项目。
7. 默认模型。
8. 默认任务模板。
9. 启动时自动运行。
10. 开发者模式。

### 20.2 AI 设置

1. CLI 路径。
2. 默认参数。
3. 默认模型。
4. 执行超时。
5. 并发数。
6. 自动确认策略。
7. 日志保留策略。
8. 终端环境变量。
9. Shell 配置。
10. 模型能力检测。

### 20.3 代码地图设置

1. 默认扫描范围。
2. 默认忽略目录。
3. 最大调用链深度。
4. 是否显示低置信边。
5. 布局算法。
6. 图缓存策略。
7. 表关系推断策略。
8. AI 摘要开关。
9. 增量扫描开关。
10. 性能监控开关。

---

## 21. 打包与发布

### 21.1 package scripts

根目录 `package.json` 必须提供：

```json
{
  "scripts": {
    "dev": "pnpm --filter @zeus/desktop dev",
    "lint": "pnpm -r lint",
    "typecheck": "pnpm -r typecheck",
    "test": "pnpm -r test",
    "test:real-scan": "bash scripts/test-real-scan.sh",
    "build": "pnpm -r build",
    "package:mac": "pnpm --filter @zeus/desktop package:mac",
    "verify:release": "bash scripts/verify-release.sh"
  }
}
```

### 21.2 Electron Builder

产物：

1. `Zeus.app`
2. `Zeus.dmg`
3. `Zeus-mac.zip`
4. Homebrew cask 文件。

### 21.3 签名与 notarization

如果本地没有证书：

1. unsigned build 必须成功。
2. CI 中保留签名环境变量。
3. release 文档说明签名流程。
4. 不伪造 notarization 成功。

### 21.4 Homebrew cask

生成 `dist/homebrew/zeus.rb`：

1. app 名称 Zeus。
2. URL 指向 GitHub Release。
3. sha256 占位由 release 脚本计算。
4. app 安装到 `/Applications/Zeus.app`。
5. uninstall 清理 launch agents 预留。
6. zap 清理 `~/Library/Application Support/Zeus` 需要用户确认。

---

## 22. 文档要求

必须生成：

1. `README.md`：产品介绍、安装、快速开始、截图占位说明、无云端说明。
2. `docs/architecture.md`：架构。
3. `docs/local-first.md`：本地优先说明。
4. `docs/security.md`：安全。
5. `docs/code-map-engine.md`：代码地图引擎。
6. `docs/ai-runtime.md`：AI runtime。
7. `docs/telegram.md`：Telegram。
8. `docs/release.md`：发布。
9. `docs/testing.md`：测试。
10. `CONTRIBUTING.md`。
11. `ROADMAP.md`。
12. `LICENSE`。
13. Issue 模板。
14. PR 模板。

文档不能包含虚假截图、虚假数据或虚假示例结果。

---

## 23. 测试设计

### 23.1 总原则

1. 测试不得写入任何 mock 数据。
2. 测试不得生成假项目、假接口、假表、假 SQL、假 AI 输出。
3. 允许使用临时 SQLite 文件，但其中只能写入测试执行过程中由真实操作产生的数据。
4. 允许直接使用 `/Users/david/hypha/zeus` 当前项目代码库生成图。
5. 如果测试环境没有外部 AI CLI，runtime 检测测试必须断言“不可用状态正确显示”，不得伪造执行。
6. 如果测试环境没有 Telegram token，Telegram 测试必须断言“未配置状态正确显示”。
7. 如果测试环境没有签名证书，打包测试必须断言 unsigned build 成功。

### 23.2 单元测试

覆盖：

1. storage migrations。
2. repositories。
3. ProjectService。
4. TaskService。
5. Task state machine。
6. Security policy。
7. Git command builder。
8. AI adapter detection。
9. Tree-sitter extractor。
10. SQL parser wrapper。
11. Graph builder。
12. View generator。
13. Telegram command parser。

单元测试可以构造纯函数输入，但不得将虚假业务记录写入持久化数据库作为产品数据。对数据库的测试必须使用临时数据库，并在测试结束删除。

### 23.3 集成测试

必须覆盖：

1. 创建真实项目记录，路径为 `/Users/david/hypha/zeus`。
2. 扫描当前项目真实文件。
3. 生成当前项目的真实 code symbols。
4. 生成当前项目的 project_nodes/project_edges。
5. 生成当前项目的系统视图。
6. 打开项目详情 API。
7. 创建真实任务记录。
8. 任务进入 READY。
9. 若 AI CLI 可用，执行真实 smoke prompt；若不可用，显示配置缺失。
10. 读取当前 Git 状态。
11. 生成当前 Git diff。
12. UI 渲染项目、任务、图谱空/非空状态。

### 23.4 真实扫描测试脚本

`scripts/test-real-scan.sh`：

```bash
#!/usr/bin/env bash
set -euo pipefail
ROOT="/Users/david/hypha/zeus"
cd "$ROOT"
pnpm build
node packages/code-indexer/dist/cli.js scan --path "$ROOT" --project-name Zeus --db "$ROOT/.tmp/zeus-real-scan.db"
node packages/graph-engine/dist/cli.js generate-views --db "$ROOT/.tmp/zeus-real-scan.db" --project Zeus
node packages/graph-engine/dist/cli.js assert-nonempty --db "$ROOT/.tmp/zeus-real-scan.db" --project Zeus
```

该脚本扫描当前项目真实代码，不创建假项目源码。

### 23.5 UI 测试

使用 Playwright：

1. 启动 app。
2. 验证 Dashboard。
3. 创建项目时选择当前工作目录。
4. 触发扫描。
5. 等待扫描完成或明确失败。
6. 打开 Code Map。
7. 搜索真实文件名或包名。
8. 打开 Tasks。
9. 创建任务。
10. 打开任务详情。
11. 检查终端区域。
12. 打开 Settings。

不得依赖假 seed 数据。

### 23.6 打包测试

1. `pnpm package:mac` 成功。
2. `dist/mac/Zeus.app` 存在。
3. DMG 存在。
4. ZIP 存在。
5. App 可启动。
6. App 启动后 `/health` 正常。
7. 数据目录创建正常。
8. 退出后本地服务关闭。

---

## 24. 目标模式执行顺序

虽然使用一次性目标模式，但执行代理必须按依赖顺序推进，不能先做 UI 假壳。

### 24.1 Bootstrap

1. 初始化 pnpm workspace。
2. 初始化 TypeScript、ESLint、Prettier、Vitest。
3. 初始化 Electron + React。
4. 初始化 local-server。
5. 初始化 SQLite migrations。
6. 初始化 shared types。
7. 初始化 scripts。
8. 初始化 CI。

验收：`pnpm install && pnpm typecheck && pnpm test` 通过。

### 24.2 App Shell

1. 主窗口。
2. 菜单栏。
3. 托盘。
4. 主题。
5. 路由。
6. Layout。
7. 空状态组件。
8. 错误边界。
9. API client。
10. WebSocket client。

验收：App 可启动，Dashboard 显示真实空状态。

### 24.3 Storage + Domain

1. 所有 migrations。
2. Repositories。
3. ProjectService。
4. TaskService。
5. RuntimeSessionService。
6. GitService。
7. GraphRepository。
8. SettingsService。
9. AuditService。
10. SecurityService。

验收：领域测试通过。

### 24.4 Project + Task UI

1. 项目列表。
2. 创建项目。
3. 文件夹选择器。
4. 项目详情。
5. 任务列表。
6. 创建任务。
7. 任务详情。
8. 状态时间线。
9. 模板。
10. 搜索/筛选/排序。

验收：可以选择 `/Users/david/hypha/zeus` 创建真实项目，创建真实任务。

### 24.5 AI Runtime

1. Adapter 接口。
2. OpenAI Codex CLI adapter。
3. Claude Code adapter。
4. Gemini adapter。
5. Generic adapter。
6. node-pty session。
7. 终端事件写库。
8. xterm.js UI。
9. interrupt/resize/stop。
10. 会话恢复。

验收：检测真实 CLI 状态；若可用可执行真实任务；若不可用 UI 明确提示。

### 24.6 Git + Diff

1. Git status。
2. Snapshot。
3. Diff。
4. Diff UI。
5. Rollback。
6. Branch。
7. Commit。
8. Stash。
9. Patch。
10. 变更关联图谱。

验收：读取当前 repo 真实 Git 状态。

### 24.7 Code Indexer

1. File inventory。
2. Project type detection。
3. TS/JS extractor。
4. Java extractor。
5. Spring extractor。
6. MyBatis XML extractor。
7. SQL extractor。
8. DDL/schema extractor。
9. Call relation extractor。
10. Incremental scan。

验收：扫描当前项目真实代码生成 symbols。

### 24.8 Graph Engine

1. Node/edge builder。
2. Module classifier。
3. Architecture view。
4. Table relation view。
5. Module detail view。
6. API sequence view。
7. Module flow view。
8. Method logic view。
9. Layout worker。
10. View cache。

验收：当前项目生成至少系统架构视图；Java/Spring/MyBatis 支持实现并通过解析器检测。

### 24.9 Graph UI

1. Sigma 大图。
2. Cytoscape/React Flow 局部图。
3. Mermaid 预览。
4. 搜索。
5. 过滤。
6. 节点详情。
7. 边详情。
8. 右键菜单。
9. 跳源码。
10. 创建任务。

验收：当前项目 Code Map 可打开并交互。

### 24.10 AI + Graph

1. 图谱问答。
2. 上下文构造。
3. 来源引用。
4. 从节点创建任务。
5. 从调用链创建任务。
6. 任务结果回写节点。
7. 变更文件回写节点。
8. 风险标签。
9. 模块摘要。
10. 接口摘要。

验收：没有 AI CLI 时显示配置缺失；有 AI CLI 时基于真实节点问答。

### 24.11 Telegram

1. 设置页。
2. Token Keychain。
3. 白名单。
4. long polling。
5. 命令解析。
6. 项目查询。
7. 任务查询。
8. 创建任务。
9. 任务控制。
10. 通知。

验收：未配置时状态正确；配置真实 token 后可手动测试。

### 24.12 Security + Release

1. API token。
2. Keychain。
3. 审计日志。
4. 高风险确认。
5. 敏感脱敏。
6. Electron Builder。
7. DMG/ZIP。
8. Homebrew cask。
9. GitHub Actions。
10. docs。

验收：打包成功，文档完整。

---

## 25. 完整功能验收清单

### 25.1 基础安装与应用框架

- [ ] Electron + React + TypeScript 桌面应用。
- [ ] macOS 菜单栏。
- [ ] Menu Bar 常驻。
- [ ] 启动页。
- [ ] 首次使用引导。
- [ ] 深色/浅色模式。
- [ ] 多窗口支持。
- [ ] WebView 调试开关。
- [ ] 自动更新预留。
- [ ] Homebrew cask 安装包支持。
- [ ] 内置本地 app-server。
- [ ] 本地服务仅监听 `127.0.0.1`。
- [ ] 本地 API 路由。
- [ ] WebSocket 实时事件。
- [ ] 健康检查。
- [ ] 服务异常自动重启。
- [ ] App 关闭清理进程。
- [ ] 后台运行模式。
- [ ] 本地日志目录。
- [ ] 本地错误面板。
- [ ] SQLite。
- [ ] 自动初始化。
- [ ] migrations。
- [ ] 本地配置文件。
- [ ] 任务日志文件。
- [ ] 会话日志文件。
- [ ] 代码索引缓存。
- [ ] 图谱缓存。
- [ ] 数据导入/导出。
- [ ] 缓存清理。

### 25.2 项目管理

- [ ] 创建/编辑/删除/列表/详情/归档项目。
- [ ] 选择本地代码库。
- [ ] 自动识别 Git 仓库。
- [ ] 自动识别项目类型。
- [ ] 项目备注。
- [ ] 默认 AI 模型。
- [ ] 默认工作模式。
- [ ] 默认任务提示词。
- [ ] 扫描忽略规则。
- [ ] 索引范围配置。
- [ ] 语言配置。
- [ ] 依赖配置。
- [ ] 数据库连接配置。
- [ ] Telegram 别名。
- [ ] 安全策略配置。
- [ ] Dashboard、最近任务、最近会话、最近变更、代码地图状态、接口/表/模块/风险/执行统计。

### 25.3 任务管理

- [ ] 创建/编辑/删除/列表/详情/搜索/筛选/排序/标签/归档。
- [ ] 待执行/执行中/等待确认/完成/失败/取消/暂停/重试/恢复/状态时间线。
- [ ] 选择项目、任务目标、模型、工作目录、是否允许改代码、是否运行测试、是否提交 Git、执行前确认、中断、继续。
- [ ] 需求分析、代码实现、Bug 修复、代码评审、单元测试、性能分析、架构分析、SQL 优化、自定义模板、项目默认模板。

### 25.4 AI Runtime

- [ ] node-pty 启动本地 AI CLI。
- [ ] PTY 会话管理。
- [ ] prompt 输入。
- [ ] 实时输出。
- [ ] Ctrl-C。
- [ ] resize。
- [ ] 输出缓存。
- [ ] 会话恢复。
- [ ] 任务和会话绑定。
- [ ] 多项目并发会话。
- [ ] AI CLI 安装检测、登录检测、版本检测、启动命令、模型配置、工作模式、输出解析、等待状态、完成状态、错误状态。
- [ ] Claude Code adapter。
- [ ] Gemini adapter。
- [ ] 通用 adapter。
- [ ] 模型切换、项目偏好、任务偏好、能力检测、配置页、执行日志、失败降级。

### 25.5 执行日志与会话

- [ ] 终端输出面板。
- [ ] 实时滚动。
- [ ] 搜索。
- [ ] 复制。
- [ ] 折叠。
- [ ] 错误高亮。
- [ ] 命令高亮。
- [ ] AI 回复高亮。
- [ ] 原始输出查看。
- [ ] 日志导出。
- [ ] 会话列表/详情/绑定任务/绑定项目/继续追问/摘要/收藏/搜索/归档/删除。

### 25.6 Git / Diff

- [ ] Git 状态、当前分支、未提交变更、新增/修改/删除文件、冲突、最近提交、远程分支、clean 状态。
- [ ] 执行前快照、执行后 diff、文件级 diff、行级 diff、接受变更、拒绝变更、回滚、AI 总结、关联任务、关联图谱节点。
- [ ] 创建分支、切换分支、提交、commit message、stash、恢复 stash、拉取、推送、patch、回滚到快照。

### 25.7 代码扫描与索引

- [ ] 扫描目录。
- [ ] Maven/Gradle/Spring Boot/多模块/源码目录/测试目录/配置文件/资源文件/忽略目录识别。
- [ ] Java 类/方法/字段/Controller/RequestMapping/Service/Component/Repository/Transactional/Async。
- [ ] 类依赖、方法调用、API 到 Controller、Controller 到 Service、Service 到 Mapper、Service 到 remote client、MQ consumer、Job、getter/setter/util/log 过滤、深度限制。
- [ ] Mapper Interface、MyBatis XML、SQL id、select/insert/update/delete、SQL 表、字段、JOIN。
- [ ] DDL 导入、数据库 schema、表、字段、索引、主键、外键、推断关系、字段搜索、版本缓存。

### 25.8 代码地图与图谱

- [ ] project_node/project_edge。
- [ ] 节点/边类型。
- [ ] metadata。
- [ ] 置信度。
- [ ] 来源追踪。
- [ ] 增量更新。
- [ ] 系统总览、模块识别、模块依赖、Maven 模块、包依赖、Controller/Service/Mapper 分层、外部依赖、模块关联表、模块关联接口、模块摘要。
- [ ] 表列表、字段详情、表关系、外键、JOIN 推断、命名推断、接口读写表、影响分析、可信度展示。
- [ ] 模块详情、接口列表、Service、Mapper、表、调用关系、任务历史、最近变更、风险标签、AI 摘要。
- [ ] 接口详情、路径、请求方法、Controller、Service、Mapper、SQL、表、remote call、MQ、时序图。
- [ ] 模块业务流程、接口聚合、调用链流程、AI 摘要、源码追溯、SQL 追溯、接口追溯、人工编辑、保存、导出。
- [ ] 方法逻辑图、if/else、loop、try/catch、return、事务、异常、SQL、流程图、AI 解释。

### 25.9 图交互与性能

- [ ] 大图 WebGL。
- [ ] 局部 React Flow。
- [ ] Mermaid 预览。
- [ ] 缩放、拖拽、搜索、点击、右键、详情面板。
- [ ] 按节点、边、模块、接口、表、任务、置信度过滤。
- [ ] 一跳/二跳。
- [ ] 隐藏低价值节点。
- [ ] 按需加载。
- [ ] 视图缓存。
- [ ] 后台布局。
- [ ] 节点聚合。
- [ ] 边聚合。
- [ ] 默认深度限制。
- [ ] 懒加载详情。
- [ ] 性能监控。

### 25.10 AI 与图谱联动

- [ ] 项目/模块/接口/表/调用链问答。
- [ ] 自动带入图谱上下文、源码片段、SQL 片段。
- [ ] 回答带来源。
- [ ] 从问答创建任务。
- [ ] 从模块/接口/表/方法/调用链创建任务。
- [ ] 自动生成任务上下文、源码位置、SQL、影响范围。
- [ ] 完成后回写图谱。

### 25.11 Telegram

- [ ] Bot Token。
- [ ] long polling。
- [ ] user id 绑定。
- [ ] 白名单。
- [ ] 启停。
- [ ] 状态。
- [ ] 命令帮助。
- [ ] 消息日志。
- [ ] 错误提示。
- [ ] 安全确认。
- [ ] `/projects`、`/tasks`、`/run`、`/status`、`/stop`、`/continue`、`/logs`、`/diff`、`/ask`、`/help`。
- [ ] 开始/完成/失败/等待确认/变更/测试失败/摘要/阶段性/静默通知。

### 25.12 安全与发布

- [ ] 本地服务不暴露公网。
- [ ] API token。
- [ ] Telegram 白名单。
- [ ] 高风险任务、删除文件、Git 提交、shell、目录限制、安全审计。
- [ ] Bot Token、API Key、Keychain、隐藏显示、日志脱敏、导出脱敏、清理密钥、重置安全、泄露风险、安全页。
- [ ] 单测、仓储测试、领域测试、解析器测试、图谱测试、runtime 测试、Telegram 测试、UI 测试。
- [ ] Electron Builder、DMG、ZIP、图标、签名预留、notarization 预留、Homebrew cask、GitHub Release、版本、更新日志。
- [ ] README、安装、使用、架构、开发、贡献、License、Issue、PR、Roadmap。

---

## 26. 最终上线定义

Zeus 可上线版本必须满足：

1. `pnpm install` 成功。
2. `pnpm lint` 成功。
3. `pnpm typecheck` 成功。
4. `pnpm test` 成功。
5. `pnpm test:real-scan` 成功，且扫描的是 `/Users/david/hypha/zeus` 真实代码库。
6. `pnpm build` 成功。
7. `pnpm package:mac` 成功。
8. App 可启动。
9. 本地服务健康检查成功。
10. 用户可以创建项目并选择真实本地代码库。
11. 用户可以扫描当前项目并生成真实图谱。
12. 用户可以创建任务。
13. 用户可以检测 AI CLI 可用性。
14. 若 AI CLI 可用，用户可以执行任务并看到真实终端输出。
15. 若 AI CLI 不可用，用户看到明确配置状态，不出现假输出。
16. 用户可以查看 Git 状态和 diff。
17. 用户可以打开系统架构图、表关系图、模块详情、接口时序图、方法逻辑图入口。
18. Telegram 未配置时显示未启用；配置真实 token 后可启用。
19. 所有敏感 token 存 Keychain。
20. App 不监听公网。
21. 数据库中没有任何 seed 的假项目、假任务、假图谱、假执行日志。
22. README 和文档完整。
23. DMG/ZIP/Homebrew cask 文件生成。
24. 最终执行报告列出完成项、真实测试结果、外部配置等待项。

---

## 27. 给目标模式的最终提示词

将以下提示词作为 Codex App 目标模式任务说明使用：

```text
在 /Users/david/hypha/zeus 中实现 Zeus macOS 本地优先 AI 研发工作台。

必须完整阅读并执行 docs 中的开发设计。项目名称统一为 Zeus/zeus。禁止出现历史项目代号、历史平台名或无关项目名。开发和测试过程禁止写入任何 mock 数据。没有真实数据时必须展示空状态。测试允许并且必须使用当前项目 /Users/david/hypha/zeus 的真实代码库生成代码图谱。

请启用 Build macOS Apps 插件，使用目标模式持续完成，直到以下命令全部通过或给出明确外部阻塞原因：

pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm test:real-scan
pnpm build
pnpm package:mac

必须实现：Electron + React + TypeScript macOS app、本地 app-server、SQLite、本地项目管理、任务管理、AI CLI PTY runtime、终端日志、会话、Git diff、代码扫描、代码图谱、系统架构图、表关系图、模块详情图、接口时序图、模块流程图、方法逻辑图、图谱问答、图上创建任务、Telegram long polling、安全策略、Keychain、DMG/ZIP/Homebrew cask、README 和完整文档。

如果 AI CLI、Telegram token、Apple 签名证书等外部条件缺失，不要伪造结果；实现检测、设置页和明确的等待配置状态。

最终给出执行报告：完成的功能、运行过的命令、真实测试结果、生成的安装包路径、仍需用户提供的外部配置。
```

---

## 28. 执行报告模板

最终执行代理必须输出：

```markdown
# Zeus 实现报告

## 完成摘要
- ...

## 运行命令
- pnpm install: pass/fail
- pnpm lint: pass/fail
- pnpm typecheck: pass/fail
- pnpm test: pass/fail
- pnpm test:real-scan: pass/fail
- pnpm build: pass/fail
- pnpm package:mac: pass/fail

## 真实代码扫描结果
- 扫描路径：/Users/david/hypha/zeus
- 文件数：
- symbol 数：
- node 数：
- edge 数：
- view 数：

## App 产物
- Zeus.app:
- DMG:
- ZIP:
- Homebrew cask:

## 外部配置等待项
- AI CLI:
- Telegram Bot Token:
- Apple signing:

## 风险与后续建议
- ...
```

---

## 29. 质量底线

如果时间不足，也不得牺牲以下底线：

1. 不得写入假数据。
2. 不得用静态假图替代真实图谱。
3. 不得用假终端输出替代 AI runtime。
4. 不得让本地服务暴露公网。
5. 不得把 token 明文写入数据库。
6. 不得只实现 UI 而没有真实本地服务。
7. 不得只写 README 而没有可运行应用。
8. 不得跳过真实扫描测试。
9. 不得把外部配置缺失伪造成成功。
10. 不得改变项目名称 Zeus。

---

## 30. 最小可接受降级策略

目标是全量完成。如果遇到外部不可控条件，只允许以下降级：

1. 无 Apple 签名证书：允许 unsigned DMG/ZIP，但必须保留签名配置。
2. 无 Telegram Token：允许 Telegram 功能处于未配置状态，但设置页、Keychain、long polling 代码必须完整。
3. 无 AI CLI：允许 runtime 显示不可用，但 adapter、PTY、终端、任务执行链路必须完整。
4. 当前项目没有 Java/Spring/MyBatis 文件：允许 Java/Spring/MyBatis 图谱为空，但 extractor 必须实现；当前项目 TypeScript/Electron 结构必须能生成真实图谱。
5. 无数据库连接：允许只通过 DDL 导入和 SQL 文件生成表关系；连接配置 UI 和安全存储必须完整。

除以上情况外，不允许以“后续实现”替代目标功能。

---

## 31. 开发完成后的人工验收路径

1. 打开 Zeus。
2. 查看 Dashboard 空状态。
3. 创建项目：选择 `/Users/david/hypha/zeus`。
4. 点击扫描。
5. 打开 Code Map。
6. 查看系统架构图。
7. 搜索 `desktop`、`local-server`、`graph-engine` 等真实包名。
8. 点击模块进入详情。
9. 查看模块关联文件和调用关系。
10. 创建任务：`分析当前项目的本地服务启动流程`。
11. 若 AI CLI 可用，执行任务。
12. 查看终端输出。
13. 查看 Git diff。
14. 打开 Telegram 设置，确认未配置时安全提示正常。
15. 打包并打开 DMG。

---

## 32. 结语

本设计要求 Zeus 成为完整的本地优先 macOS AI 研发工作台。执行时必须把“真实本地数据、真实代码扫描、真实任务状态、真实终端执行、真实 Git diff”作为工程底线。所有缺失的外部条件必须被明确检测和呈现，不能通过假数据掩盖。
