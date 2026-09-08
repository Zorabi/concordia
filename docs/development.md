# Concordia 开发指南

## 1. 开发目标

实现一个 local-first TypeScript 工具，使 Codex 能发布结构化任务、ZCode 能领取并执行任务，双方能交换进度和审查事件，用户能在 ZCode 中查询执行状态；按需通过 Redis relay 跨机器连接。

第一版以可靠完成一条端到端任务为标准，不建设通用工作流平台。

## 2. 技术栈

- Node.js：22.13 或更高版本。
- TypeScript：启用严格类型检查。
- MCP：`@modelcontextprotocol/sdk`。
- SQLite：优先使用当前 Node 运行时稳定可用的 SQLite 能力；不满足时再增加一个驱动。
- 测试：Node 内置 `node:test`。
- Git：通过非交互式子进程调用协调主机本地 `git`。
- 跨机器：Redis Streams request queue 与短期 response key。

不引入 Web 框架、ORM、依赖注入容器或前端框架。Redis 是可选传输依赖，本机模式不要求运行 Redis 服务。

## 3. 预期目录

```text
concordia/
├── README.md
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts             # stdio MCP 入口
│   ├── protocol.ts          # 任务、事件和工具类型
│   ├── database.ts          # SQLite 初始化与事务
│   ├── tasks.ts             # 状态机和任务服务
│   ├── events.ts            # 事件追加、查询和等待
│   ├── workspace.ts         # Git/worktree 与路径验证
│   ├── relay-protocol.ts    # 签名信封与安全校验
│   ├── relay-client.ts      # Redis MCP relay client
│   └── relay.ts             # Redis relay coordinator
├── tests/
│   ├── concordia.test.ts    # 核心端到端协议测试
│   └── relay.test.ts        # relay 安全与分发测试
├── zcode-plugin/
│   ├── .zcode-plugin/
│   │   └── plugin.json
│   ├── .mcp.json
│   └── commands/
│       ├── tasks.md
│       ├── task.md
│       └── watch.md
└── docs/
    ├── design.md
    └── development.md
```

只有当单文件职责开始混杂时才继续拆分。

## 4. 配置

| 环境变量 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `CONCORDIA_TRANSPORT` | 否 | `stdio` | MCP 连接本机服务或 Redis relay |
| `CONCORDIA_DB` | 否 | `<cwd>/.concordia/state.db` | SQLite 路径 |
| `CONCORDIA_ROOTS` | stdio/协调器 | 无 | 允许的项目根目录列表 |
| `CONCORDIA_AGENT_ID` | 是 | 无 | `codex` 或 `zcode`；缺失时拒绝启动 |
| `CONCORDIA_REDIS_URL` | Redis | 无 | 远程使用 `rediss://` |
| `CONCORDIA_RELAY_NAMESPACE` | 否 | `concordia` | Redis 键命名空间 |
| `CONCORDIA_RELAY_CODEX_TOKEN` | Codex/协调器 | 无 | Codex HMAC token |
| `CONCORDIA_RELAY_ZCODE_TOKEN` | ZCode/协调器 | 无 | ZCode HMAC token |

不提供通用配置文件。允许执行的检查命令采用固定白名单 ID，不接受来自任务 payload 的任意 shell 字符串。完整 relay 调优变量见 `.env.relay.example`。

## 5. 开发阶段

### 阶段 1：协议与数据库

交付：

- `TaskSpec`、`TaskEvent`、`TaskSubmission` 类型。
- SQLite 初始化 migration。
- 状态转换函数。
- `createTask`、`claimTask`、`appendEvent`、`getTask`、`listTasks`。

验证：

- 重复 `idempotencyKey` 不产生重复事件。
- 两个并发领取操作只有一个成功。
- 非法状态转换被拒绝。
- 进程重启后任务和事件仍存在。

### 阶段 2：MCP 工具

交付：

- stdio MCP Server。
- 八个工具的输入和返回结构。
- 统一错误模型。
- `wait_events` 有界长轮询。

验证：

- 使用最小 MCP 客户端完成一次工具调用。
- stdout 只写 MCP 协议，日志写 stderr。
- 等待超时返回空事件集，不当作错误。

### 阶段 3：工作区隔离

交付：

- 仓库和 `baseCommit` 验证。
- worktree 创建和查询。
- `ownedPaths` 校验。
- commit、diff 和检查结果登记。

验证：

- 拒绝逃逸允许项目根目录的路径。
- 拒绝修改 `ownedPaths` 之外的文件。
- 基准提交变化时返回明确冲突。

### 阶段 4：ZCode 插件

交付：

- 最小插件 manifest。
- `.mcp.json` stdio 配置。
- `/tasks`、`/task`、`/watch` 三个命令。
- 主代理协作提示：自主决定子代理，只汇报顶层结果。

验证：

- ZCode 成功连接 Concordia MCP Server。
- 新会话能够调用全部桥接工具。
- `/tasks` 能看到 Codex 发布的任务。
- `/watch` 能看到执行期间的新事件。

### 阶段 5：端到端验收

1. 在临时 Git 仓库创建一个简单变更任务。
2. Codex 发布任务。
3. ZCode 领取任务并创建 worktree。
4. ZCode 自主决定是否调用子代理。
5. ZCode 修改代码、执行检查并提交。
6. Codex 获取结果并审查 diff。
7. Codex 请求一次修改。
8. ZCode 重新领取新 attempt，修正并重新提交。
9. Codex 批准任务。
10. 重启 MCP Server，确认完整事件仍可查询。

### 阶段 6：Redis 跨机器 relay

- `CONCORDIA_TRANSPORT=stdio|redis` 显式切换；默认行为不变。
- 协调器独占 Redis namespace，持有本机 SQLite 和 Git 工作区。
- request/response 使用角色 token HMAC 签名、时间戳和 nonce 防重放。
- consumer group 保存未确认请求，协调器重启后回收 pending entry。
- 远程默认强制 TLS，限制消息大小、并发数和响应 TTL。

## 6. MCP 工具契约

### 6.1 `create_task`

输入完整 `TaskSpec` 和 `idempotencyKey`，返回：

```ts
interface CreateTaskResult {
  taskId: string;
  status: "READY";
  eventId: number;
  created: boolean;
}
```

### 6.2 `claim_task`

```ts
interface ClaimTaskInput {
  agentId: string;
  workspace?: string;
  leaseSeconds?: number;
}
```

领取成功时额外返回仅本次租约有效的 `leaseToken`；没有匹配任务时返回 `{ task: null }`，不返回错误。token 不进入任务详情或事件，重领时自动轮换。

### 6.3 `get_task`

返回任务契约、当前状态、租约摘要、交付物和最近事件。默认最多返回最近 20 条事件。

### 6.4 `list_tasks`

支持 `status[]`、`assignee`、`workspace`、`updatedAfter` 和 `limit`。`limit` 默认 20，最大 100。

### 6.5 `send_event`

只允许调用方发送其角色有权产生的事件。例如 ZCode 不能发送 `APPROVED`，Codex 不能代替 ZCode 发送 `COMPLETED`。ZCode 发送的事件必须携带当前 `leaseToken`，以拒绝租约过期后的旧执行者。

### 6.6 `wait_events`

```ts
interface WaitEventsInput {
  taskId?: string;
  recipient?: string;
  afterEventId: number;
  timeoutMs?: number;
  limit?: number;
}
```

`timeoutMs` 默认 30,000，最大 60,000。

### 6.7 `submit_task`

```ts
interface TaskSubmission {
  taskId: string;
  leaseToken: string;
  commit: string;
  changedFiles: string[];
  checks: Array<{
    commandId: string;
    exitCode: number;
    summary: string;
    logPath?: string;
  }>;
  risks: string[];
  summary: string;
  idempotencyKey: string;
}
```

成功后任务进入 `REVIEW`。

### 6.8 `review_task`

```ts
type ReviewTaskInput =
  | {
      taskId: string;
      decision: "approve";
      summary: string;
      idempotencyKey: string;
    }
  | {
      taskId: string;
      decision: "request_changes";
      findings: Array<{
        path?: string;
        line?: number;
        severity: "blocking" | "warning";
        message: string;
      }>;
      idempotencyKey: string;
    };
```

## 7. 错误模型

```ts
interface ConcordiaError {
  code:
    | "INVALID_INPUT"
    | "TASK_NOT_FOUND"
    | "INVALID_TRANSITION"
    | "LEASE_CONFLICT"
    | "STALE_VERSION"
    | "WORKSPACE_DENIED"
    | "BASE_COMMIT_MISMATCH"
    | "PATH_SCOPE_VIOLATION"
    | "INTERNAL_ERROR";
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}
```

错误消息不得包含环境变量、凭据或完整命令输出。

## 8. ZCode 插件行为

### MCP 配置

插件通过 stdio 启动编译后的 Concordia Server。所有运行日志写 stderr，避免破坏 MCP JSON-RPC。

### 主代理说明

```text
从 Concordia 领取任务后，先验证目标、路径范围和验收条件。
你可以自主决定是否调用可用子代理。子代理用于边界明确、可以独立推进的工作。
你负责汇总子代理结果，并通过 Concordia 发布顶层进度、问题和最终提交。
不要让子代理批准任务，也不要修改 ownedPaths 以外的文件。
```

### 命令输出

`/tasks`：

```text
ID      STATUS         ASSIGNEE  UPDATED  OBJECTIVE
T-1024  RUNNING        zcode     14:39    实现 token 自动刷新
T-1025  WAITING_INPUT  zcode     14:35    更新缓存失效策略
```

`/task T-1024` 显示目标、阶段、租约、变更、检查、风险和最近事件。

`/watch T-1024` 按新事件更新，遇到 `APPROVED`、`FAILED`、`CANCELLED` 或用户中止时结束。

## 9. 测试策略

使用一个 `node:test` 文件覆盖关键路径，不为简单访问器创建独立测试。

必须覆盖：

- 创建、领取、提交、返工、批准的完整状态流。
- 并发领取。
- 事件幂等。
- 租约过期。
- 租约重领后旧 fencing token 失效。
- 乐观锁冲突。
- 数据库重开恢复。
- 路径逃逸拒绝。
- `ownedPaths` 越界拒绝。
- `wait_events` 返回新事件和正常超时。

端到端测试使用临时目录和临时 Git 仓库，不访问真实项目。

## 10. 日志与诊断

日志采用单行 JSON 并写入 stderr：

```json
{
  "level": "info",
  "event": "task.claimed",
  "taskId": "T-1024",
  "agentId": "zcode",
  "durationMs": 12
}
```

默认日志不记录任务完整 payload。调试模式可以记录字段名和摘要，但仍需删除密钥和环境变量值。

## 11. 第一版验收标准

- Codex 和 ZCode 能通过同一个 SQLite 数据库交换任务和事件。
- ZCode 能自主选择是否使用子代理。
- 用户能在 ZCode 中通过 `/tasks` 和 `/task` 查看状态。
- `/watch` 能看到执行期间的新事件。
- 并发领取不会重复执行任务。
- 进程重启后可恢复状态和事件游标。
- ZCode 不能提交 `ownedPaths` 以外的修改。
- ZCode 提交后必须由 Codex 明确批准。
- 自动化测试全部通过。

## 12. 暂缓项与升级条件

| 暂缓项 | 增加条件 |
| --- | --- |
| 本地 Web Dashboard | `/tasks` 和 `/watch` 无法满足观察需求 |
| Unix Domain Socket | 500ms 轮询产生可测性能问题 |
| PostgreSQL/Redis/NATS | 需要多协调节点、高可用或大量并发执行者 |
| ORM | migration 和查询复杂度显著增长 |
| 多用户权限 | Concordia 开始作为共享服务运行 |
| 子代理详细追踪 | ZCode 提供稳定生命周期事件且确有需求 |

## 13. 编码前验证

1. 确认本机 Node.js 版本及其 SQLite 可用性。
2. 验证 ZCode 加载本地 stdio MCP Server 的配置。
3. 验证新会话能够看到插件注册的三个命令。
4. 观察 ZCode 后台子代理有哪些状态能稳定回到主会话。
5. 确认 Codex 与 ZCode 使用同一项目路径和 Git 仓库视图。

这些验证不会改变协议设计，只影响启动命令和少量适配代码。
