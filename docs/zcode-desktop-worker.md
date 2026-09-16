# ZCode Desktop 原生工作器

Concordia 的 MCP server 负责工具、任务状态、事件、租约和 worktree；它不能主动要求一个空闲 MCP 客户端开始新的模型 turn。要让执行过程和结果持续显示在 ZCode Desktop，应使用插件提供的 `/worker` 命令，而不是外置 `zcode-waker`。

## 启动

1. 以 User scope 安装并启用 Concordia 插件。
2. 在 ZCode Desktop 新建或打开一个专门的任务，执行 `/worker`。
3. 使用 Full access 或适合项目风险的执行模式。
4. 保持 ZCode Desktop 运行；需要停止时，在该任务中要求暂停或清除 Goal。

`/worker` 会在当前可见任务中创建持久 Goal，先恢复已存在的可操作任务，再通过 `wait_events` 等待新的 `TASK_CREATED`、`ANSWER` 和 `CHANGES_REQUESTED`。它精确领取事件对应的任务，只在返回的 `worktreePath` 中修改，持续发送心跳，并把提交和验证证据送入 REVIEW。

ZCode Goal 会跨多轮继续，并在关闭再打开任务后保留状态。MCP 的 60 秒空事件返回属于正常情况，不代表任务完成；Goal 只有在用户暂停、额度耗尽或确实需要用户决策时才应停止。

## 多仓库

本机 stdio 模式默认使用 `~/.concordia/state.db`，也不要求 `CONCORDIA_ROOTS`。因此同一用户的 Codex 与 ZCode Desktop 只需各配置一次 Concordia MCP；之后任务可以指向任意本机可访问的 Git 根目录，无需为新增仓库修改两端配置或重启。

如需额外目录隔离，可选择设置 `CONCORDIA_CONFIG_FILE` 或 `CONCORDIA_ROOTS`。这是显式安全加固，不是默认运行前提。

## 与自动化和 CLI 的区别

- `/worker`：推荐。执行发生在当前 ZCode Desktop 任务中，进度、工具调用和结果都可见。
- ZCode Scheduled task：适合小时级兜底检查；原生计划任务当前最小重复单位为小时，不适合作为低延迟事件监听器。
- `zcode-waker`：仅保留给无界面/服务器兼容场景。它调用 ZCode CLI，不保证结果进入用户当前查看的 Desktop 任务。

ZCode Desktop 关闭或系统休眠时，Desktop 工作器不能继续执行。重新打开应用后，回到原任务并恢复 Goal 即可；Concordia 事件和游标都持久化，不会因界面关闭而丢失。

## 验证

1. 在 ZCode Desktop 的工作器任务中确认 Goal 为 active。
2. 在 Codex 创建一个指向此前未配置过的新 Git 仓库的任务。
3. ZCode 应直接领取任务，无 `WORKSPACE_DENIED`，且不需要修改任何 MCP 配置。
4. ZCode 的进度和最终 `submit_task` 结果应显示在同一 Desktop 任务中。
5. Codex 应从同一个用户级状态库看到任务进入 REVIEW。

ZCode 官方说明：[Goal Mode](https://zcode.z.ai/en/docs/goal)、[MCP](https://zcode.z.ai/en/docs/mcp-services)、[Automations](https://zcode.z.ai/en/docs/automations)。
