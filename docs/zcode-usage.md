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

发现任务后再调用 `claim_task`。`claim_task` 是原子操作；多个执行者同时领取时，只有一个执行者会成功获得同一任务。

### 5.2 在当前会话持续监听

`create_task` 会生成发给 `zcode` 的 `TASK_CREATED` 事件。可在一个保持运行的 ZCode 会话中输入：

```text
使用 Concordia 持续监听 Codex 发给 zcode 的任务事件。

先调用 list_tasks，处理当前工作区已有的 READY 任务。然后反复调用 wait_events：
- recipient: "zcode"
- afterEventId: 使用上一次收到的最大 eventId，首次从 0 开始
- timeoutMs: 60000
- limit: 100

收到 TASK_CREATED 后，调用 get_task；任务仍为 READY 时调用 claim_task。
对历史事件或已经不处于 READY 的任务不要重复处理。
每次响应后更新 afterEventId。wait_events 正常超时返回空数组时继续等待，不要视为错误。
领取后只在返回的 worktreePath 中实施，并保存 leaseToken。
```

需要注意：

- `wait_events` 单次最长等待 60 秒，需要调用方用最新游标继续调用。
- 监听只在当前 ZCode 会话保持运行时有效。
- 关闭 ZCode、结束会话或电脑休眠后，不会继续监听。
- 当前插件没有常驻后台监听进程，也不会弹出操作系统通知。

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

截至 Concordia `0.2.0`：

- 可以通过 `/tasks` 在 ZCode 会话中查看同步后的 Concordia 任务。
- 不能把每个 Concordia 任务写入 ZCode 原生任务侧边栏。
- 不提供操作系统弹窗通知。
- 不提供 ZCode 关闭后的后台监听。

若需要实时桌面通知，应增加独立的 Concordia 后台监听器，由它读取 `TASK_CREATED` 事件并调用 macOS、Windows 或 Linux 的系统通知接口。该能力应与 ZCode 会话解耦；ZCode 插件继续负责 `/tasks`、任务详情和执行工作流。

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
| `claim_task` 返回 `task: null` | 当前没有可领取的 `READY` 任务，或任务不属于该工作区。 |
| 收到 `LEASE_CONFLICT` | 租约已过期或任务被重新领取；重新调用 `claim_task`，不要复用旧 token。 |
| 提交被路径校验拒绝 | 确认在返回的 worktree 中工作，并核对任务的允许与排除路径。 |
