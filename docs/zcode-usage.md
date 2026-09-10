# 在 ZCode 中使用 Concordia

本文说明 Concordia 插件安装完成后，如何在 ZCode 中查看待办、领取任务、监听事件和提交结果。

## 1. 使用前检查

在 ZCode 中打开被管理的目标 Git 仓库，然后确认：

1. **Settings → Plugins** 中的 `concordia` 插件已安装并启用。
2. **Settings → MCP Servers → Plugin MCP servers** 中的 `plugin:concordia:concordia` 已启用。
3. 单机模式下 ZCode 和 Codex 的 `CONCORDIA_DB` 指向同一个绝对路径；跨机器模式下两端 Redis URL 与 namespace 一致，并分别使用自己的角色 token。
4. 当前工作区是任务契约中的 Git 仓库根目录，而不是 Concordia 源码目录。

插件或配置变化只保证对新会话生效。检查完成后，建议新建一个 ZCode 会话再开始操作。

## 2. 查看待办列表

在 ZCode 输入框中执行：

```text
/tasks READY
```

该命令列出当前工作区内由 Codex 发布、尚未被领取的任务。典型输出为：

```text
ID             STATUS  ASSIGNEE  UPDATED  OBJECTIVE
docs-api-001   READY   -         14:30    补充 API 使用文档
fix-cache-002  READY   -         14:35    修复缓存失效问题
```

其他常用形式：

```text
/tasks
/tasks RUNNING
/tasks WAITING_INPUT
/tasks REVIEW
```

- `/tasks`：查看近期所有状态的任务。
- `/tasks READY`：查看待领取任务。
- `/tasks RUNNING`：查看正在实施的任务。
- `/tasks WAITING_INPUT`：查看等待 Codex 回答的问题。
- `/tasks REVIEW`：查看已经提交、等待 Codex 审查的任务。

Concordia 的任务列表显示在当前 ZCode 会话中，不会写入 ZCode 原生任务侧边栏。

## 3. 查看任务详情

使用：

```text
/task docs-api-001
```

详情包括：

- 目标与当前状态；
- 目标 Git 仓库；
- `ownedPaths` 与 `excludedPaths`；
- 约束和验收条件；
- 当前租约摘要；
- 提交、变更文件、检查和风险；
- 最近的任务事件。

`/task` 是只读命令，不会自动领取任务。

## 4. 领取并执行任务

可以在 ZCode 中直接输入：

```text
调用 Concordia 的 claim_task，agentId 使用 zcode，workspace 使用当前 Git 仓库根目录。领取后严格按照任务契约执行，只修改返回的 worktreePath，不要修改当前仓库的原始检出目录。保存 leaseToken，在后续进度、心跳和 submit_task 中继续使用。
```

领取成功后必须遵守：

1. 在 `claim_task` 返回的 `task.worktreePath` 中工作。
2. 不得修改 `ownedPaths` 之外或 `excludedPaths` 之内的文件。
3. 不要把 `leaseToken` 写入源码、日志或提交记录。
4. 长任务在租约到期前用 `HEARTBEAT` 续租。
5. 完成验证后先创建 Git commit，再调用 `submit_task`。
6. `changedFiles` 必须与 Git diff 完全一致。

典型状态变化：

```text
READY → CLAIMED → RUNNING → REVIEW → APPROVED
                      │          └→ READY（Codex 要求返工，需重新领取）
                      └→ WAITING_INPUT（ZCode 提问）
```

## 5. 监听新任务

### 5.1 手动刷新

最简单可靠的方式是按需运行：

```text
/tasks READY
```

发现任务后再调用 `claim_task`。从 `zcode-waker` 的事件启动时传入该事件的 `taskId`，以精确领取对应任务；手动领取时可省略 `taskId` 让服务按工作区选择最早待办。`claim_task` 是原子操作；多个执行者同时领取时，只有一个执行者会成功获得同一任务。

### 5.2 使用 `zcode-waker` 持续监听（推荐）

`zcode-waker` 是运行在 ZCode CLI 所在机器的外置 Node.js 守护进程。它监听发给 `zcode` 的持久事件，只在需要工作时调用 ZCode CLI：

| 事件 | 行为 |
| --- | --- |
| `TASK_CREATED` | waker 用事件的 `taskId` 精确领取仍可操作的任务，再创建 ZCode 会话实施。 |
| `ANSWER` | 恢复该任务会话，由 ZCode 读取回答并继续等待或实施。 |
| `CHANGES_REQUESTED` | waker 用事件的 `taskId` 精确重新领取新 attempt，再恢复该任务会话读取 findings 并修正。 |

启动后空闲阶段只有 Node.js 长轮询，不调用 ZCode 模型。waker 先精确领取并将 CLI 工作目录绑定到返回的 worktree；首次事件使用 ZCode CLI 的 `--prompt --json --surface terminal --mode build` 创建会话，同一任务后续事件使用保存的 `sess_*` ID 和 `--resume` 恢复。Concordia 自身不调用 Computer Use，也不向 CLI 注入工具允许或禁用列表；是否使用 Computer Use 由 ZCode agent 的自身策略和配置决定。CLI 子进程不会继承 waker 的 Redis/API 凭据。

```sh
CONCORDIA_TRANSPORT=stdio \
CONCORDIA_ROOTS=/absolute/path/to/example-app \
CONCORDIA_DB=/absolute/path/to/example-app/.concordia/state.db \
CONCORDIA_ZCODE_WAKER_DB=/absolute/path/to/example-app/.concordia/zcode-waker.db \
npm run start:zcode-waker
```

完整的单机/Redis 配置、可靠性语义和故障排查见 [ZCode 事件唤醒器指南](zcode-waker.md)。

### 5.3 在当前会话持续监听

`create_task` 会生成发给 `zcode` 的 `TASK_CREATED` 事件。可在一个保持运行的 ZCode 会话中输入：

```text
使用 Concordia 持续监听 Codex 发给 zcode 的任务事件。

先调用 list_tasks，处理当前工作区已有的 READY 任务。然后反复调用 wait_events：
- recipient: "zcode"
- afterEventId: 使用上一次收到的最大 eventId，首次从 0 开始
- timeoutMs: 60000
- limit: 100

收到 TASK_CREATED 后，调用 get_task；任务仍为 READY 时以该事件 taskId 调用 claim_task。
对历史事件或已经不处于 READY 的任务不要重复处理。
每次响应后更新 afterEventId。wait_events 正常超时返回空数组时继续等待，不要视为错误。
领取后只在返回的 worktreePath 中实施，并保存 leaseToken。
```

需要注意：

- `wait_events` 单次最长等待 60 秒，需要调用方用最新游标继续调用。
- 监听只在当前 ZCode 会话保持运行时有效。
- 关闭 ZCode、结束会话或电脑休眠后，不会继续监听。
- 插件本身没有常驻后台监听进程，也不会弹出操作系统通知；该职责由可选的外置 `zcode-waker` 承担。

这里的限制只针对交互式 ZCode 插件会话。部署 `zcode-waker` 后，新任务、回答和返工由模型外的守护进程监听并按需启动或恢复 ZCode turn；ZCode 提交、提问或失败后则可由 [Codex 事件唤醒器](codex-waker.md) 处理。两个 waker 都不通过 Computer Use 操控客户端界面；被唤醒的 agent 仍按自身工具策略工作。

## 6. 监听已知任务的进度

知道任务 ID 后使用：

```text
/watch docs-api-001
```

`/watch` 会从该任务当前事件游标开始等待新事件，适合观察进度、问题、提交和审核结果。它不能发现未知的新任务；发现新任务应使用 `/tasks READY` 或全局 `wait_events` 监听。

## 7. 向 Codex 提问

任务要求不明确时，要求 ZCode 使用 `send_event` 发送 `QUESTION`：

```text
针对当前任务向 Codex 发送 QUESTION，说明缺少的信息和可选方案。使用当前 leaseToken，然后等待 ANSWER；不要自行扩大任务范围。
```

任务进入 `WAITING_INPUT`。Codex 回复 `ANSWER` 后，任务恢复为 `RUNNING`。

## 8. 提交任务

完成修改、检查和 Git commit 后，可输入：

```text
核对当前 attempt worktree 的 HEAD、baseCommit..HEAD 的精确 changedFiles、检查结果和风险，然后调用 Concordia submit_task。使用当前 leaseToken 和新的 idempotencyKey，不要执行合并或推送。
```

提交成功后任务进入 `REVIEW`，当前租约立即失效。Codex 可以批准或要求返工；返工后任务回到 `READY`，必须重新领取新的 attempt 和 `leaseToken`。批准不会自动合并、cherry-pick 或推送分支。

## 9. ZCode 端权限

| 能力 | ZCode 是否可以执行 |
| --- | --- |
| 查看任务和事件 | 可以 |
| 领取任务 | 可以 |
| 发送进度、问题、心跳和失败事件 | 可以，需有效 `leaseToken` |
| 提交 commit 和验证证据 | 可以，需有效 `leaseToken` |
| 创建任务 | 不可以，仅 Codex 可创建 |
| 批准或要求返工 | 不可以，仅 Codex 可审查 |
| 自动合并或推送 | 不会执行 |

## 10. 原生待办同步与通知

截至 Concordia `0.4.0`：

- 可以通过 `/tasks` 在 ZCode 会话中查看同步后的 Concordia 任务。
- 不能把每个 Concordia 任务写入 ZCode 原生任务侧边栏。
- 不提供操作系统弹窗通知。
- 可选 `zcode-waker` 可在 ZCode 交互界面关闭后继续监听，并在需要时使用 ZCode CLI 创建或恢复任务会话。

`zcode-waker` 默认不显示操作系统通知，也不写入 ZCode 原生任务侧边栏；它负责可靠地恢复实施会话。若还需要桌面提醒，可在它之外接入 macOS、Windows 或 Linux 系统通知接口，插件仍只负责 `/tasks`、任务详情和交互式工作流。

## 11. 跨机器 Redis 模式

跨机器时，`/tasks`、`/task` 和 `/watch` 的用法完全不变，差别只在 MCP server 环境变量：

```json
{
  "CONCORDIA_AGENT_ID": "zcode",
  "CONCORDIA_TRANSPORT": "redis",
  "CONCORDIA_REDIS_URL": "rediss://user:password@redis.example.com:6379/0",
  "CONCORDIA_RELAY_NAMESPACE": "team-a",
  "CONCORDIA_RELAY_ZCODE_TOKEN": "<zcode-token>"
}
```

协调器仍须运行在这台 ZCode/Git 机器上。若 ZCode 与协调器同机，也可以保留 `CONCORDIA_TRANSPORT=stdio` 并共享协调器本机的 SQLite。具体完整 JSON 和启动命令见 [跨机器协调指南](remote-coordination.md)。

## 12. 常见问题

| 现象 | 处理方式 |
| --- | --- |
| `/tasks READY` 没有结果 | 确认 Codex 已创建任务，任务 `workspace` 是当前 Git 根目录，并核对双方数据库路径。 |
| ZCode 看不到 Codex 刚创建的任务 | 单机核对 `CONCORDIA_DB`；跨机核对 Redis URL、数据库编号、namespace 和协调器状态。 |
| 找不到 `/tasks` | 确认安装的是完整插件而不是仅手动配置 MCP，并在新会话中重试。 |
| `/watch` 看不到新任务 | `/watch` 只观察已知任务；使用 `/tasks READY` 或全局 `wait_events`。 |
| `zcode-waker` 无法创建会话 | 确认 `zcode --version` 可运行、运行用户已登录 ZCode，并检查 CLI 是否支持 `--prompt --json --surface terminal --mode build`。 |
| `zcode-waker` 重复处理事件 | 检查 `CONCORDIA_ZCODE_WAKER_DB` 是否为稳定的本机绝对路径；删除前先停止 waker 并确认无待处理投递。 |
| `claim_task` 返回 `task: null` | 当前没有可领取的 `READY` 任务，或任务不属于该工作区。 |
| 收到 `LEASE_CONFLICT` | 租约已过期或任务被重新领取；重新调用 `claim_task`，不要复用旧 token。 |
| 提交被路径校验拒绝 | 确认在返回的 worktree 中工作，并核对任务的允许与排除路径。 |
