# Concordia 系统设计

## 1. 目标

Concordia 在一台本地计算机上协调 Codex 与 ZCode：Codex 负责形成方案、发布任务和验收成果，ZCode 负责实施并自主决定是否调用子代理。双方通过结构化任务与事件通信，避免用长篇文档传递实时状态。

系统需要满足：

- 不依赖 GitHub Issue 或外部服务。
- Codex 和 ZCode 读取同一份可靠状态。
- ZCode 主代理自主选择子代理。
- 用户可以在 ZCode 内查询任务和执行情况。
- 应用或进程重启后能够恢复任务。
- 并发任务不会无意中覆盖彼此的代码。

## 2. 第一版范围

包含：

- TypeScript 编写的本地 MCP Server。
- SQLite 任务、事件和交付物存储。
- Codex 与 ZCode 共用的 MCP 工具。
- ZCode 本地插件及 `/tasks`、`/task`、`/watch` 命令。
- 本地 Git branch/worktree 隔离。
- 任务租约、心跳、幂等和失败恢复。

暂不包含：

- 跨机器通信和多用户权限。
- Redis、NATS、Kafka 等消息中间件。
- 独立 Web Dashboard。
- 自动向远程 Git 服务推送。
- 强制规定 ZCode 使用哪些子代理。
- 将外部任务伪装为 ZCode 原生侧边栏任务。

## 3. 设计原则

1. **任务是契约**：目标、边界、验收条件和交付物必须结构化。
2. **事件是沟通**：问题、进度、完成和返工通过事件传递。
3. **代码是成果**：实现结果由本地 commit、diff 和测试证据表达。
4. **主代理负责汇总**：ZCode 子代理结果先回到 ZCode 主代理，再统一提交。
5. **单机优先**：使用 stdio MCP 和 SQLite，不开放网络端口。
6. **允许恢复**：状态变化持久化，消费者按事件序号继续读取。

## 4. 总体架构

```text
┌──────────────────────────── Local machine ────────────────────────────┐
│                                                                       │
│  Codex                                                                │
│  ├── 形成实施任务                                                     │
│  ├── create_task / send_event / review_task                           │
│  └── 审查本地 diff 与检查结果                                         │
│                         │                                             │
│                         ▼                                             │
│                    Concordia MCP Server                              │
│              ├── 任务状态机                                           │
│              ├── 事件追加、查询和等待                                 │
│              ├── 租约、心跳和幂等                                     │
│              └── SQLite: .concordia/state.db                         │
│                         ▲                                             │
│                         │                                             │
│  ZCode plugin / worker task                                           │
│  ├── claim_task                                                       │
│  ├── 自主计划和选择子代理                                             │
│  ├── send_event / submit_task                                         │
│  └── /tasks /task /watch                                              │
│                         │                                             │
│                         ▼                                             │
│  Local Git repository                                                 │
│  └── .worktrees/<task-id>-zcode-a<attempt>                            │
│                                                                       │
└───────────────────────────────────────────────────────────────────────┘
```

Codex 与 ZCode 可以各自启动一个 stdio MCP Server 进程。两个进程连接同一个 SQLite 文件，因此不需要共享 stdio 进程或监听 TCP 端口。

## 5. 角色与责任

### 5.1 Codex

- 理解用户目标和限制。
- 创建边界明确、可验证的任务。
- 指定允许修改的路径和基准提交。
- 回答 ZCode 提出的阻塞问题。
- 检查提交、diff、测试和风险。
- 发出 `CHANGES_REQUESTED` 或 `APPROVED`。

### 5.2 ZCode 主代理

- 原子领取待执行任务。
- 检查工作区和基准提交。
- 自主决定是否调用内置或自定义子代理。
- 管理子代理并汇总结论。
- 在关键阶段发布顶层进度。
- 提交 commit、变更清单、检查结果和已知风险。

### 5.3 ZCode 子代理

- 只处理主代理划定的子任务。
- 将结果返回主代理。
- 默认不直接与 Codex 通信。
- 仍受任务路径和安全约束。

根据当前 ZCode 文档，主代理可以自动选择子代理，但子代理不能继续创建下一层子代理。因此第一版只需要支持一层 ZCode 子代理。

### 5.4 Concordia

- 验证任务和事件输入。
- 执行合法状态转换。
- 保证同一任务只有一个有效租约持有者。
- 保存事件顺序和消费者游标。
- 提供状态查询，不解释或修改实施计划。

## 6. 子代理策略

任务只声明资源边界，不指定子代理名单：

```json
{
  "delegation": {
    "mode": "auto",
    "maxConcurrency": 3,
    "maxDepth": 1
  }
}
```

- `mode: auto`：ZCode 主代理自行判断是否需要子代理。
- `maxConcurrency`：任务允许的最大并发执行单元。
- `maxDepth: 1`：匹配当前 ZCode 的能力边界。

共享状态只强制要求顶层任务进度。若 ZCode 能稳定提供子代理生命周期事件，可以附加发布 `AGENT_STATUS`；该事件不参与顶层状态转换。

## 7. 任务状态机

```text
DRAFT
  ↓ publish
READY
  ↓ claim
CLAIMED
  ↓ start
RUNNING
  ├── question ──→ WAITING_INPUT ──→ RUNNING
  ├── failure  ──→ FAILED
  ├── cancel   ──→ CANCELLED
  └── submit   ──→ REVIEW
                       ├── request changes ──→ RUNNING
                       └── approve ──────────→ APPROVED
```

终态为 `APPROVED`、`FAILED`、`CANCELLED`。ZCode 提交后进入 `REVIEW`，只有 Codex 可以将任务变为 `APPROVED`。

## 8. 任务契约

```ts
export type TaskStatus =
  | "DRAFT"
  | "READY"
  | "CLAIMED"
  | "RUNNING"
  | "WAITING_INPUT"
  | "REVIEW"
  | "APPROVED"
  | "FAILED"
  | "CANCELLED";

export interface TaskSpec {
  id: string;
  objective: string;
  workspace: string;
  baseCommit?: string;
  ownedPaths: string[];
  excludedPaths?: string[];
  constraints: string[];
  acceptance: string[];
  deliverables: Array<"commit" | "changed_files" | "checks" | "risks">;
  delegation: {
    mode: "auto" | "disabled";
    maxConcurrency: number;
    maxDepth: 1;
  };
  timeoutSeconds: number;
}
```

约束：

- `objective` 描述可验证结果。
- `ownedPaths` 至少包含一个明确范围。
- `acceptance` 至少包含一条验收条件。
- 存在 `baseCommit` 时，领取任务前必须验证。
- 第一版拒绝 `maxDepth` 大于 1。

## 9. 事件协议

```ts
export type EventType =
  | "TASK_CREATED"
  | "TASK_CLAIMED"
  | "PROGRESS"
  | "QUESTION"
  | "ANSWER"
  | "AGENT_STATUS"
  | "HEARTBEAT"
  | "COMPLETED"
  | "CHANGES_REQUESTED"
  | "APPROVED"
  | "FAILED"
  | "CANCELLED";

export interface TaskEvent<T = unknown> {
  eventId: number;
  taskId: string;
  sender: "codex" | "zcode" | string;
  recipient?: "codex" | "zcode" | string;
  type: EventType;
  payload: T;
  idempotencyKey: string;
  createdAt: string;
}
```

示例：

```json
{
  "taskId": "T-1024",
  "sender": "zcode",
  "recipient": "codex",
  "type": "PROGRESS",
  "idempotencyKey": "T-1024-progress-testing-1",
  "payload": {
    "phase": "testing",
    "summary": "实现完成，正在运行并发测试",
    "changedFiles": 2
  }
}
```

进度不使用推测的百分比，优先展示阶段、已完成里程碑、当前动作和最近事件时间。

## 10. MCP 工具

| 工具 | 调用方 | 作用 |
| --- | --- | --- |
| `create_task` | Codex | 创建并发布任务 |
| `claim_task` | ZCode | 原子领取一个 READY 任务 |
| `get_task` | 双方 | 获取任务、状态和最近事件 |
| `list_tasks` | 双方 | 按状态、执行者或工作区筛选 |
| `send_event` | 双方 | 追加问题、回答、进度或失败事件 |
| `wait_events` | 双方 | 从指定事件序号等待新事件 |
| `submit_task` | ZCode | 提交 commit、检查结果和风险 |
| `review_task` | Codex | 批准或请求修改 |

`wait_events` 使用有界长轮询：默认最多等待 30 秒，每 500 毫秒查询一次。返回后由调用方决定是否继续等待，不创建永久后台线程。

## 11. SQLite 数据模型

```sql
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  assignee TEXT,
  objective TEXT NOT NULL,
  spec_json TEXT NOT NULL,
  workspace TEXT NOT NULL,
  base_commit TEXT,
  worktree_path TEXT,
  lease_owner TEXT,
  lease_until TEXT,
  lease_token TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  sender TEXT NOT NULL,
  recipient TEXT,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE INDEX events_task_cursor ON events(task_id, event_id);

CREATE TABLE artifacts (
  artifact_id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  kind TEXT NOT NULL,
  local_path TEXT NOT NULL,
  checksum TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
```

初始化设置：

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
```

## 12. 一致性与恢复

### 原子领取

`claim_task` 在一个事务中查找最早的 `READY` 任务，条件更新为 `CLAIMED`，写入租约并追加 `TASK_CLAIMED` 事件。条件更新影响零行时重新查询，避免重复领取。

### 租约和心跳

- 默认租约 60 秒。
- ZCode 每 20 秒发送心跳并延长租约。
- 租约过期后任务进入可恢复状态。
- 恢复前检查 worktree 和已有 commit，避免重复副作用。
- 每次领取生成新的 fencing token；ZCode 的事件和提交必须携带当前 token，旧执行者在重领后无法继续写入。
- token 只随领取结果返回，不写入事件、任务详情、日志或提交记录。

### 幂等和并发

- 所有写操作携带 `idempotencyKey`。
- 重复 key 返回原结果，不重复写入。
- `tasks.version` 每次状态改变时递增。
- 更新使用 `WHERE id = ? AND version = ?`，防止旧客户端覆盖新状态。

## 13. 本地代码隔离

每个写任务使用独立 worktree：

```text
<repo>/.worktrees/<task-id>-zcode-a<attempt>/
```

规则：

- 从任务的 `baseCommit` 创建。
- 每次领取拥有独立的写 worktree；重领从上一次已提交的 HEAD 快照恢复，旧 attempt 的目录不再复用。
- ZCode 只能修改 `ownedPaths`。
- 提交结果必须包含 commit SHA。
- Codex 审查 commit 相对 `baseCommit` 的 diff。
- 合并动作由 Codex 或用户明确触发。

## 14. 在 ZCode 中查看状态

ZCode 插件包含 MCP 配置和三个命令：

- `/tasks`：显示任务 ID、状态、目标、执行者和更新时间。
- `/task <id>`：显示契约、阶段、事件、变更和检查结果。
- `/watch <id>`：持续调用 `wait_events`，直到终态、用户中止或达到观察时限。

建议在 ZCode 创建固定会话 `Concordia Worker`，由它领取和执行 Codex 发布的任务。ZCode 左侧任务列表可以显示这个会话的运行、未读和失败状态。

当前公开文档没有提供通过外部 MCP 创建原生 ZCode UI 任务的接口，因此跨代理任务列表由 `/tasks` 展示。子代理活动保留在执行会话内，Concordia 默认只展示汇总后的顶层阶段。

## 15. 安全边界

- SQLite、MCP 配置和日志只允许当前用户读取。
- 所有路径经过 `realpath` 后验证是否位于允许根目录。
- 任务 payload 不携带任意待执行 shell 字符串。
- 检查命令必须匹配项目白名单。
- `ownedPaths` 在修改前和提交前各验证一次。
- `baseCommit` 必须解析为本地 commit。
- 日志不得保存 API key、环境变量值或完整敏感输出。
- MCP Server 不监听公网端口。

## 16. 关键决策

| 决策 | 选择 | 原因 |
| --- | --- | --- |
| 项目名 | Concordia | 表达多个代理在共同协议下协调 |
| 实现语言 | TypeScript | 与 MCP、JSON 和进程管理契合 |
| 传输 | stdio MCP | 单机足够，不开放端口 |
| 存储 | SQLite WAL | 支持事务、恢复和审计 |
| 通知 | 有界长轮询 | 不引入 daemon 或消息队列 |
| 子代理策略 | ZCode 自主决定 | 执行代理掌握当前实现上下文 |
| 子代理深度 | 1 | 匹配当前 ZCode 能力边界 |
| 状态展示 | ZCode 命令 | 第一版不开发 Dashboard |
| 代码隔离 | Git worktree | 避免共享工作目录冲突 |

## 17. 参考资料

- [OpenAI Multi-agent](https://developers.openai.com/api/docs/guides/responses-multi-agent)
- [ZCode Subagents](https://zcode.z.ai/en/docs/subagents)
- [ZCode MCP](https://zcode.z.ai/en/docs/mcp-services)
- [ZCode Commands](https://zcode.z.ai/en/docs/commands)
- [ZCode Plugins](https://zcode.z.ai/en/docs/plugin)
- [ZCode ADE Tools](https://zcode.z.ai/en/docs/ADE-tools)
