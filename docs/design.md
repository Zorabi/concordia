# Concordia 系统设计

## 1. 目标

Concordia 以 local-first 方式协调 Codex 与 ZCode：Codex 负责形成方案、发布任务和验收成果，ZCode 负责实施并自主决定是否调用子代理。双方可以运行在同一台机器，也可以在无公网 IP 时通过 Redis relay 连接到 ZCode 执行主机上的协调器。

系统需要满足：

- 不依赖 GitHub Issue 或外部服务。
- Codex 和 ZCode 读取同一份可靠状态。
- ZCode 主代理自主选择子代理。
- 用户可以在 ZCode 内查询任务和执行情况。
- 应用或进程重启后能够恢复任务。
- 并发任务不会无意中覆盖彼此的代码。

## 2. 当前范围

包含：

- TypeScript 编写的本地 MCP Server。
- SQLite 任务、事件和交付物存储。
- Codex 与 ZCode 共用的 MCP 工具。
- ZCode 本地插件及 `/tasks`、`/task`、`/watch` 命令。
- 本地 Git branch/worktree 隔离。
- 任务租约、心跳、幂等和失败恢复。
- 单协调节点 Redis Streams relay coordinator。
- 独立 Codex/ZCode HMAC token 角色认证。
- 可选 Codex/ZCode 事件唤醒器、独立消费游标和持久会话映射。

暂不包含：

- 多用户身份、仓库级 ACL 和租户隔离。
- 多协调节点高可用。
- 多个独立执行机之间的路径映射和 Git 对象传输。
- Kafka、NATS 等其他消息中间件。
- 独立 Web Dashboard。
- 自动向远程 Git 服务推送。
- 强制规定 ZCode 使用哪些子代理。
- 将外部任务伪装为 ZCode 原生侧边栏任务。

## 3. 设计原则

1. **任务是契约**：目标、边界、验收条件和交付物必须结构化。
2. **事件是沟通**：问题、进度、完成和返工通过事件传递。
3. **代码是成果**：实现结果由本地 commit、diff 和测试证据表达。
4. **主代理负责汇总**：ZCode 子代理结果先回到 ZCode 主代理，再统一提交。
5. **local-first**：默认使用本机 stdio；只有显式设置 `CONCORDIA_TRANSPORT=redis` 才通过中转，SQLite 和 Git 始终留在执行主机。
6. **允许恢复**：状态变化持久化，消费者按事件序号继续读取。

## 4. 总体架构

```text
┌──────────────────────────── Local machine ────────────────────────────┐
│                                                                       │
│  Codex                                                                │
│  ├── 形成实施任务                                                     │
│  ├── create_task / send_event / review_task                           │
│  └── 审查本地 diff 与检查结果                                         │
│       ▲                                                               │
│       └── Codex App Server <── codex-waker（只在可操作事件启动 turn）  │
│                         │                                             │
│                         ▼                                             │
│  zcode-waker ──> ZCode CLI（只在可操作事件启动或恢复 build turn）       │
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

跨机器模式采用以下拓扑：

```text
Remote Codex relay client ──┐
                            ├── outbound TLS ──> Redis <── outbound ── Coordinator on ZCode host
Local ZCode relay client ───┘                                      ├── local SQLite
                                                                  └── local repository/worktrees
```

每个 MCP 进程仍通过 stdio 接入其宿主客户端；Redis 模式下，工具调用被封装为签名 request/response。协调器按 token 对应角色复核签名、时钟、nonce 和工具权限，再调用唯一的 `TaskService`。Git 操作仍在协调主机本地执行，因此不会降低现有提交校验强度。ZCode 若与协调器同机，也可保持 `stdio` 模式直接使用同一个本机 SQLite。

可选 `codex-waker` 在 Codex 主机运行。它复用相同的 stdio/Redis 事件源，但不经过模型轮询；`COMPLETED`、`QUESTION`、`FAILED` 才触发 Codex App Server turn。每个任务使用一个持久 Codex 线程，线程 ID、事件游标和投递状态保存在独立 `waker.db`，避免污染协调主机的任务协议数据库。

可选 `zcode-waker` 在 ZCode CLI 与 Git 工作区所在主机运行。它监听 `recipient=zcode`，且仅 `TASK_CREATED`、`ANSWER`、`CHANGES_REQUESTED` 触发 ZCode CLI turn；首次使用 `--prompt --json --surface terminal --mode build`，后续以保存的 `sess_*` 用 `--resume` 恢复。会话 ID、游标和投递状态保存于独立 `zcode-waker.db`。Concordia 自身不调用 Computer Use，也不依赖鼠标、桌面窗口或焦点；ZCode agent 是否使用该工具由其自身策略和配置决定。

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

### 5.5 Codex waker

- 使用普通 Node.js 进程按 `eventId` 监听 `recipient=codex` 的事件。
- 忽略进度和心跳，只对完成、问题和失败事件启动模型。
- 通过 Codex App Server 恢复每个任务对应的持久线程。
- 仅在 Codex turn 成功完成且任务离开对应等待状态，或事件已过期后推进消费游标。
- 对启动、MCP 或 turn 失败采用有上限的指数退避。
- 不把事件 payload 注入唤醒提示；Codex 通过 `get_task` 读取证据。
- 使用只读 sandbox，禁止自动审查线程修改实现文件。

### 5.6 ZCode waker

- 使用普通 Node.js 进程按 `eventId` 监听 `recipient=zcode` 的事件。
- 仅对新任务、Codex 回答和返工事件启动或恢复 ZCode CLI；批准和进度等常规事件只推进游标。
- 按任务保存一个 ZCode `sess_*` 会话；首次创建、后续使用 `--resume`。
- 收到新任务或返工后，由 waker 的受信任代码仅以事件的 `taskId` 调用 `claim_task`，不能回退为领取任意 READY 任务；CLI 从返回的 worktree 启动。
- CLI turn 成功完成且任务进入暂停/审查/终态，或事件已过期后才推进消费游标；CLI 崩溃或状态未改变时保留事件。
- 每个 waker 状态库使用 SQLite 单实例锁，避免同一事件被两个守护进程并发启动。
- 对 CLI 启动、JSON 解析或 turn 失败采用有上限的指数退避。
- 不把事件 payload 直接注入 prompt；ZCode 通过 `get_task` 读取证据并校验当前状态。
- Concordia 不调用 Computer Use 或操控 GUI，也不向 ZCode 注入允许/禁止工具列表；具体工具由 ZCode agent 自身策略决定。
- CLI 子进程采用环境 allowlist，不继承 waker 持有的 Redis URL、角色 token或 API key。

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
                       ├── request changes ──→ READY（新 attempt）
                       └── approve ──────────→ APPROVED
```

终态为 `APPROVED`、`FAILED`、`CANCELLED`。ZCode 提交后进入 `REVIEW` 并清除执行租约；Codex 要求返工时回到 `READY`，ZCode 必须重新领取并获得新的 fencing token。只有 Codex 可以将任务变为 `APPROVED`。

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
| `claim_task` | ZCode | 原子领取一个 READY 任务；可按 taskId 精确限定 |
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

未提供 `taskId` 时，`claim_task` 在一个事务中查找最早的 `READY` 任务；提供时只查找指定 ID 的 `READY` 任务。随后条件更新为 `CLAIMED`，写入租约并追加 `TASK_CLAIMED` 事件。条件更新影响零行时重新查询，避免重复领取。

### 租约和心跳

- 默认租约 60 秒。
- ZCode 每 20 秒发送心跳并延长租约。
- 租约过期后任务进入可恢复状态。
- 恢复前检查 worktree 和已有 commit，避免重复副作用。
- 每次领取生成新的 fencing token；ZCode 的事件和提交必须携带当前 token，旧执行者在重领后无法继续写入。
- 提交和返工都清除旧 token；返工从 `READY` 重新领取，禁止恢复已提交 attempt 的执行权。
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
- Codex 与 ZCode 使用不同 HMAC token，认证结果绑定角色。
- 远程 Redis 默认必须使用 `rediss://`；明文远程连接需要显式开发开关。
- 每个请求包含时间戳与一次性 nonce；响应和 nonce 自动过期。
- Redis 消息大小、并发数、时钟偏差和 pending 回收时间均受限制。
- 单协调器锁避免同一 namespace 出现两个活动 Git/SQLite 执行者。
- SQLite 必须保存在协调主机本地磁盘，禁止通过网络文件系统共享。

## 16. 关键决策

| 决策 | 选择 | 原因 |
| --- | --- | --- |
| 项目名 | Concordia | 表达多个代理在共同协议下协调 |
| 实现语言 | TypeScript | 与 MCP、JSON 和进程管理契合 |
| 传输 | stdio + 可选 Redis Streams relay | 默认保持本机低复杂度，无公网 IP 时双方只需出站连接 |
| 存储 | 协调主机本地 SQLite WAL | 支持事务、恢复和审计；不跨机器共享文件 |
| 通知 | durable event cursor + 有界长轮询 | 客户端断线后可从游标继续；是否弹窗由 ZCode 客户端决定 |
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
