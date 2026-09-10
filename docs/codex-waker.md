# Codex 事件唤醒器

`codex-waker` 是 Concordia 的可选常驻进程。它使用普通 Node.js 代码监听发给 Codex 的持久事件，只有事件需要处理时才通过 Codex App Server 创建或恢复一个审查任务并启动新 turn。空闲轮询不会调用模型。

## 1. 工作方式

```text
ZCode submit_task / send_event
              │
              ▼
SQLite 或 Redis relay 中的持久事件
              │
              ▼
codex-waker（Node.js，无模型轮询）
              │ COMPLETED / QUESTION / FAILED
              ▼
Codex App Server
thread/start 或 thread/resume → turn/start → turn/completed
```

每个 Concordia `taskId` 对应一个持久 Codex 线程。首次可操作事件创建线程，后续返工、追问或失败事件恢复同一线程。waker 只唤醒以下事件：

| 事件 | Codex 行为 |
| --- | --- |
| `COMPLETED` | 调用 `get_task`，独立检查提交、diff、检查结果和风险，再调用 `review_task` |
| `QUESTION` | 调用 `get_task`，回答问题并以 `ANSWER` 事件回复 ZCode |
| `FAILED` | 检查失败证据，在 Codex 线程中留下故障报告 |

`PROGRESS`、`HEARTBEAT`、`AGENT_STATUS` 等事件只推进游标，不触发模型。

## 2. 前置条件

1. 完成 `npm install && npm run build`。
2. `codex` CLI 在 `PATH` 中，且运行 waker 的系统用户已经登录 Codex。
3. Codex 的 `concordia` MCP 已配置为 `CONCORDIA_AGENT_ID=codex`。建议将该 MCP 配成用户级服务器；如果使用项目级配置，waker 的 `cwd` 必须能加载该配置。
4. 同机模式可访问共享 SQLite 和目标 Git 仓库；跨机模式可访问 Redis relay。

Codex App Server 使用稳定的 `initialize`、`thread/start`、`thread/resume`、`turn/start` 和 `turn/completed` 接口。waker 使用 `approvalPolicy=never` 和只读 sandbox；模型不能修改实现文件，但仍可调用有权限的 Concordia MCP 工具完成回答或审查。

## 3. 单机启动

在 Concordia 源码目录运行：

```sh
CONCORDIA_TRANSPORT=stdio \
CONCORDIA_ROOTS='/Users/me/src/example-app' \
CONCORDIA_DB='/Users/me/src/example-app/.concordia/state.db' \
CONCORDIA_WAKER_DB='/Users/me/src/example-app/.concordia/waker.db' \
npm run start:waker
```

若任务的 worktree 在本机存在，waker 默认以 `task.worktreePath` 作为 Codex `cwd`；否则依次使用任务 workspace 和 waker 启动目录。可显式固定：

```sh
CONCORDIA_WAKER_CWD='/Users/me/src/example-app'
```

看到以下日志表示监听已启动：

```json
{"level":"info","event":"waker.started"}
```

## 4. 跨机器启动

waker 应运行在 Codex 机器，通过现有 relay 监听事件：

```sh
CONCORDIA_TRANSPORT=redis \
CONCORDIA_REDIS_URL='rediss://concordia-user:<redis-password>@redis.example.com:6379/0' \
CONCORDIA_RELAY_NAMESPACE='team-a' \
CONCORDIA_RELAY_CODEX_TOKEN='<codex-token>' \
CONCORDIA_WAKER_DB='/Users/me/.local/state/concordia/waker.db' \
CONCORDIA_WAKER_CWD='/Users/me/src/example-app' \
npm run start:waker
```

远程任务中的 `workspace` 和 `worktreePath` 是 ZCode/Git 主机路径，Codex 机器通常无法直接访问，因此跨机器时应设置 `CONCORDIA_WAKER_CWD`。如果 Codex 机器没有同步该提交的本地 Git 视图，Codex 只能审查 Concordia 中保存的提交 SHA、文件列表、检查和风险证据，不能独立读取完整 diff；需要强代码审查时，应先同步 Git 对象或在同机执行 waker。

## 5. 配置

| 环境变量 | 默认值 | 作用 |
| --- | --- | --- |
| `CONCORDIA_WAKER_DB` | `<cwd>/.concordia/waker.db` | 独立保存事件游标、任务线程映射和投递结果 |
| `CONCORDIA_WAKER_CWD` | worktree、workspace 或启动目录 | Codex 审查线程的工作目录，必须为存在的绝对路径 |
| `CONCORDIA_CODEX_BIN` | `codex` | Codex CLI 可执行文件 |
| `CONCORDIA_WAKER_MODEL` | Codex 默认模型 | 可选模型覆盖 |
| `CONCORDIA_WAKER_EFFORT` | 模型默认值 | 可选 reasoning effort 覆盖 |
| `CONCORDIA_WAKER_POLL_TIMEOUT_MS` | `60000` | 单次事件等待，最大 60000 ms |
| `CONCORDIA_WAKER_REQUEST_TIMEOUT_MS` | `30000` | App Server RPC 超时 |
| `CONCORDIA_WAKER_TURN_TIMEOUT_MS` | `1800000` | 单次 Codex turn 超时 |
| `CONCORDIA_WAKER_RETRY_DELAY_MS` | `5000` | 首次失败重试间隔 |
| `CONCORDIA_WAKER_MAX_RETRY_DELAY_MS` | `300000` | 指数退避上限 |

不要把 Redis URL、角色 token 或其他凭据放进命令历史。长期运行时应通过 launchd、systemd、容器 secret 或进程管理器注入环境变量。

## 6. 可靠性语义

- `waker.db` 的事件游标只会在非操作事件已跳过、事件已过期，或 Codex turn 成功完成且任务状态已离开对应等待态后推进；`COMPLETED` 必须离开 `REVIEW`，`QUESTION` 必须离开 `WAITING_INPUT`。
- App Server 启动、MCP 初始化或 turn 失败时保留原游标并指数退避重试。
- 每个事件有独立投递记录和尝试次数；重启后会恢复任务到 Codex 线程的映射。
- 一个 `waker.db` 同时只允许一个活跃 waker；重复启动会直接失败，异常退出后的 PID 锁在进程消失后可接管。
- 投递采用至少一次语义。进程可能在 Codex 已完成、游标尚未提交的极小窗口内重放事件。唤醒提示会先检查当前任务状态，`ANSWER` 和 `review_task` 使用由 `eventId` 派生的稳定幂等键。
- 事件 payload 不直接复制进唤醒提示。Codex 必须通过 `get_task` 读取并把仓库、日志、摘要和事件内容视作不可信证据。

## 7. 验证

1. 启动 MCP/relay、ZCode 和 `npm run start:waker`。
2. Codex 创建测试任务，ZCode 领取并提交。
3. waker 日志应依次出现 `waker.thread_created` 和 `waker.event_completed`。
4. `get_task` 应显示任务从 `REVIEW` 进入 `APPROVED`，或返回 `READY` 并包含 `CHANGES_REQUESTED`。
5. 停止并重启 waker，已完成事件不应再次触发模型。

## 8. 故障排查

| 现象 | 处理 |
| --- | --- |
| `Unable to start Codex App Server` | 确认 `codex --version` 可运行，或设置 `CONCORDIA_CODEX_BIN` |
| App Server 初始化失败 | 先单独运行 `codex app-server --stdio`；检查 Codex 登录状态和配置 |
| `thread/resume` 失败 | 检查运行用户和 `CODEX_HOME` 是否变化；需要重新建线程时备份后删除对应 `waker_threads` 记录 |
| 反复出现 `waker.event_failed` | 检查该任务的 delivery `last_error`、Codex MCP 是否连接，以及审批策略是否被管理员配置拒绝 |
| 跨机审查找不到仓库 | 设置本机存在的 `CONCORDIA_WAKER_CWD`，并同步待审提交 |
| waker 没收到事件 | 核对 `recipient=codex`、SQLite 路径，或 Redis URL、namespace、Codex token 与协调器状态 |

Codex App Server 协议参考：[官方文档](https://learn.chatgpt.com/docs/app-server)。
