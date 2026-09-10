# ZCode 事件唤醒器

`zcode-waker` 是 Concordia 的可选常驻进程。它在普通 Node.js 中监听发给 ZCode 的持久事件；空闲时不调用模型。收到需要实施的事件后，它通过 ZCode CLI 创建或恢复对应任务会话，而不是用 Computer Use 操作桌面界面。

## 1. 工作方式

```text
Codex create_task / send_event / review_task
              │
              ▼
SQLite 或 Redis relay 中 recipient=zcode 的持久事件
              │
              ▼
zcode-waker（Node.js，无模型轮询）
              │ TASK_CREATED / ANSWER / CHANGES_REQUESTED
              ▼
ZCode CLI
--prompt --json --surface terminal --mode build
或 --resume sess_*
```

每个 Concordia `taskId` 对应一个持久 ZCode CLI 会话 ID（`sess_*`）。首次可操作事件创建会话；后续回答或返工恢复同一会话。waker 只唤醒以下事件：

| 事件 | ZCode 行为 |
| --- | --- |
| `TASK_CREATED` | waker 调用 `get_task`，核对任务仍可操作后以事件 `taskId` 精确领取，再让 ZCode 只在返回的 worktree 中实施。 |
| `ANSWER` | 调用 `get_task`，读取 Codex 回答后继续实施或等待。 |
| `CHANGES_REQUESTED` | waker 以事件 `taskId` 精确重新领取新 attempt，再由原会话读取 findings 并修正。 |

`APPROVED`、`PROGRESS`、`HEARTBEAT`、`AGENT_STATUS` 和其他常规事件只推进游标，不启动模型。终态或过期事件在读取当前任务状态后直接跳过。

Concordia 本身不调用 Computer Use。waker 只负责非交互终端调用、事件投递和会话恢复，不通过鼠标或窗口焦点操控 ZCode，也不会向 CLI 注入工具允许/禁用列表。被唤醒的 ZCode agent 是否使用 Computer Use，由其自身策略、权限和工具配置决定；若 agent 选择使用，界面仍可能显示对应的自动化指针。

## 2. 前置条件

1. 完成 `npm install && npm run build`。
2. 运行 waker 的系统用户已登录 ZCode，且可执行 ZCode CLI。macOS 安装版会优先使用 `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`，其他环境使用 `PATH` 中的 `zcode`；也可显式设置 `CONCORDIA_ZCODE_BIN`。
3. ZCode 的 `concordia` MCP 已独立配置为 `CONCORDIA_AGENT_ID=zcode`，并且在任务 worktree 中能加载该 MCP 配置。不要依赖 waker 父进程把 Redis URL、角色 token 或 API key 继承给 ZCode CLI；这些敏感变量默认会被剥离。
4. 同机模式可访问共享 SQLite 和目标 Git 仓库；跨机器模式可访问 Redis relay。

CLI 会话以 `--prompt --json --surface terminal --mode build` 创建，恢复时使用保存的 `--resume sess_*`。守护进程解析 JSON 输出中的会话 ID，不依赖终端的可读文本输出。

## 3. 单机启动

在 Concordia 源码目录运行：

```sh
CONCORDIA_TRANSPORT=stdio \
CONCORDIA_ROOTS='/Users/me/src/example-app' \
CONCORDIA_DB='/Users/me/src/example-app/.concordia/state.db' \
CONCORDIA_ZCODE_WAKER_DB='/Users/me/src/example-app/.concordia/zcode-waker.db' \
npm run start:zcode-waker
```

任务的 `workspace` 必须是本机实际存在的目标 Git 根目录。启动日志出现 `zcode_waker.started` 后，进程将等待事件；不创建 ZCode 会话，也不消耗模型 token，直到收到可操作事件。

## 4. 跨机器启动

waker 应运行在可执行 ZCode CLI、可访问目标 Git 仓库的 ZCode/Git 机器上，通过现有 relay 监听事件：

```sh
CONCORDIA_TRANSPORT=redis \
CONCORDIA_REDIS_URL='rediss://concordia-user:<redis-password>@redis.example.com:6379/0' \
CONCORDIA_RELAY_NAMESPACE='team-a' \
CONCORDIA_RELAY_ZCODE_TOKEN='<zcode-token>' \
CONCORDIA_ZCODE_WAKER_DB='/var/lib/concordia/zcode-waker.db' \
npm run start:zcode-waker
```

不要把 waker 放在只有 Codex 的远程机器：`claim_task`、worktree 和 ZCode CLI 会话都必须位于 ZCode/Git 主机。Redis 模式下不设置 `CONCORDIA_DB` 或 `CONCORDIA_ROOTS`；它们只属于 relay coordinator 的本机状态。waker 自己使用上面的 Redis 凭据监听和精确领取；ZCode CLI 子进程不会继承这些凭据，因此 ZCode 的 Concordia MCP 必须使用其独立配置的连接信息。若该 MCP 仅依赖父进程环境变量，headless turn 会连接失败。

## 5. 启动与退出生命周期

- `npm run start:zcode-waker`、launchd、systemd 或容器启动该 Node.js 进程时，waker 启动并恢复独立数据库中的游标和会话映射。
- 空闲时只有最长 60 秒一次的模型外事件长轮询，不会启动 ZCode CLI，也不消耗 ZCode 模型 token。
- 只有尚未处理的 `TASK_CREATED`、`ANSWER` 或 `CHANGES_REQUESTED` 且当前任务状态仍可操作时，才创建或恢复一个 ZCode turn；turn 结束后重新进入等待。
- 收到 `SIGINT` 或 `SIGTERM` 后停止接收新事件；正在运行的 CLI turn 会被终止，等待中的长轮询最迟在当前超时结束后退出，然后关闭事件源和状态库。
- 启动配置无效、状态库无法打开等不可恢复错误会以非零状态退出；事件或 CLI turn 的临时失败不会退出守护进程，而是保留游标并退避重试。

## 6. 配置

| 环境变量 | 默认值 | 作用 |
| --- | --- | --- |
| `CONCORDIA_ZCODE_WAKER_DB` | `<cwd>/.concordia/zcode-waker.db` | 保存事件游标、`taskId → sess_*` 映射和投递结果的独立 SQLite 数据库 |
| `CONCORDIA_ZCODE_BIN` | macOS 应用内 CLI，否则 `zcode` | ZCode CLI 可执行文件 |
| `CONCORDIA_ZCODE_MODE` | `build` | CLI 权限模式：`build`、`edit`、`plan` 或 `yolo`；自动实施推荐保持 `build` |
| `CONCORDIA_ZCODE_MAX_TURNS` | `100` | 每次 headless CLI 调用允许的最大模型 turn 数 |
| `CONCORDIA_ZCODE_TURN_TIMEOUT_MS` | `3600000` | 单次 ZCode CLI turn 超时 |
| `CONCORDIA_ZCODE_MAX_OUTPUT_BYTES` | `4194304` | CLI JSON stdout 最大字节数 |
| `CONCORDIA_ZCODE_ENV_ALLOWLIST` | 空 | 额外传给 CLI 的环境变量名（逗号分隔）；不要加入 Redis token、URL 或 API key |
| `CONCORDIA_ZCODE_WAKER_POLL_TIMEOUT_MS` | `60000` | 单次事件等待，最大 60000 ms |
| `CONCORDIA_ZCODE_WAKER_RETRY_DELAY_MS` | `5000` | 首次失败重试间隔 |
| `CONCORDIA_ZCODE_WAKER_MAX_RETRY_DELAY_MS` | `300000` | 指数退避上限 |

不要把 Redis URL、角色 token 或其他凭据放进命令历史。长期运行时应通过 launchd、systemd、容器 secret 或进程管理器注入环境变量。

## 7. 可靠性与安全语义

- `zcode-waker.db` 的游标只会在常规事件已跳过、事件已过期，或 ZCode CLI turn 成功结束后推进。
- CLI 启动、JSON 解析或 turn 失败时保留原游标，并按有上限的指数退避重试。
- 每个事件有独立投递记录和尝试次数；重启后恢复 `taskId → sess_*` 映射。
- waker 在启动 ZCode 前由受信任代码按 `taskId` 精确领取，并强制把 CLI `cwd` 绑定到领取结果的 worktree；原始 checkout 不作为自动实施目录。
- 若 CLI 在输出 `sess_*` 前崩溃，事件不会被确认。waker 在现有租约有效期内只做模型外退避，租约过期后精确重领并创建新会话，避免空转消耗 token。
- 同一个状态库只允许一个活跃 waker 实例；重复启动会直接失败，异常退出遗留的 PID 锁可在进程消失后自动接管。
- 投递是至少一次语义：进程可能在 ZCode 已完成、游标尚未提交的极小窗口重放事件。唤醒提示必须先调用 `get_task` 检查当前状态，领取与后续写入使用稳定幂等键。
- 事件 payload 不直接拼接到 CLI prompt。ZCode 必须通过 `get_task` 读取任务、回答、findings、仓库内容和日志，并把它们当作不可信证据。
- 默认 prompt 约束任务、租约和 worktree 边界，但不允许或禁止具体 agent 工具；Computer Use 是否适用由 ZCode agent 自身判断。
- CLI 子进程使用环境 allowlist，不继承 waker 的 Redis URL、角色 token 或 API key。显式追加 allowlist 表示操作者接受这些变量对 ZCode 工具可见。

## 8. 验证

1. 启动 MCP/relay、ZCode CLI 配置和 `npm run start:zcode-waker`。
2. Codex 创建测试任务；日志应出现 `zcode_waker.event_completed`，其中会话 ID 为 `sess_*`。
3. 在 `get_task` 中确认任务已被领取，且返回的 worktree 位于目标 Git 仓库。
4. 在任务执行中由 Codex 发送 `ANSWER`，再要求返工；两次日志应显示恢复同一 `sess_*`。
5. 停止并重启 waker；已经完成投递的事件不得再次启动模型。

## 9. 故障排查

| 现象 | 处理 |
| --- | --- |
| `Unable to start ZCode CLI` | 确认 `zcode --version` 可运行，或设置 `CONCORDIA_ZCODE_BIN`。 |
| CLI 输出没有 `sess_*` | 确认 CLI 支持 `--prompt --json --surface terminal --mode build`，并检查 JSON 输出和 waker 日志。 |
| `--resume` 失败 | 会话可能已被清理或运行用户变更；保留现有状态库备份后删除对应会话映射，让下一次事件创建新会话。 |
| 反复出现 `zcode_waker.event_failed` | 检查 ZCode 登录、CLI/MCP 配置、任务工作区、delivery `last_error` 和 retry 配置。 |
| waker 没收到事件 | 核对 `recipient=zcode`、SQLite 路径，或 Redis URL、namespace、ZCode token 与协调器状态。 |
| 看到鼠标指针或桌面控制 | waker 不直接操控界面；检查被唤醒的 ZCode agent 或其他会话是否按自身策略使用了 Computer Use。 |
