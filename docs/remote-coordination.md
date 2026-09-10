# 使用 Redis 进行跨机器协调

Concordia 0.4 提供可选 Redis relay。它适用于 Codex 与 ZCode 不在同一台机器、双方都没有公网 IP，但都能主动访问同一个 Redis 服务的场景。

是否使用 Redis 由每个 MCP 客户端的 `CONCORDIA_TRANSPORT` 决定：

| 值 | 行为 | 适用场景 |
| --- | --- | --- |
| `stdio` | MCP 进程直接访问本机 SQLite 和 Git；默认值 | Codex 与 ZCode 同机，或 ZCode 在协调主机本机运行 |
| `redis` | MCP 进程只作为 Redis relay client，不打开 SQLite、不执行 Git | 跨机器 Codex；也可用于希望统一走 relay 的 ZCode |

Redis 不是数据库替代品。任务、事件和交付物仍以协调主机上的 SQLite 为准；Redis Streams 只传输经过 HMAC 签名的短期请求和响应。

## 1. 拓扑与路径规则

```text
Codex 机器                         Redis TLS 服务                         ZCode / Git 机器
┌──────────────┐       出站       ┌────────────────┐       出站       ┌─────────────────────┐
│ stdio MCP    ├─────────────────>│ request stream │<─────────────────┤ relay coordinator   │
│ transport=   │<─────────────────┤ response keys  │─────────────────>│ 本机 SQLite         │
│ redis        │                  └────────────────┘                  │ 本机 Git/worktrees  │
└──────────────┘                                                      └──────────┬──────────┘
                                                                               │
                                                                   ZCode MCP：redis 或 stdio
```

两台机器都只建立出站 Redis 连接，不需要端口映射、反向代理或公网 IP。

协调器必须运行在持有目标 Git 仓库的 ZCode 机器上，因为 `claim_task` 会在那里创建 worktree，`submit_task` 会在那里验证 HEAD、提交历史和变更范围。Codex 创建任务时，`workspace` 必须填写 **ZCode 机器上的绝对 Git 仓库路径**，而不是 Codex 机器上的路径。

不要把 `.concordia/state.db` 放到 NFS、SMB、NAS 或同步盘供多机共同打开。SQLite 只留在协调主机本地。

## 2. 准备 Redis

推荐 Redis 7+ 或兼容 Redis Streams、consumer groups、`XAUTOCLAIM` 的托管服务。跨网络必须使用 TLS URL：

```text
rediss://<username>:<password>@<host>:6379/0
```

建议为 Concordia 创建专用 Redis 用户、数据库或实例，并限制其只能访问一个命名空间。relay 使用以下键：

```text
<namespace>:requests
<namespace>:response:*
<namespace>:nonce:*
<namespace>:coordinator:lock
```

最低命令能力包括 `GET`、`SET`、`DEL`、`XADD`、`XGROUP`、`XREADGROUP`、`XACK`、`XAUTOCLAIM`、`EVAL`。生产环境还应启用 Redis ACL、TLS、连接数限制、持久化或托管服务备份，并避免把凭据写进仓库。

## 3. 生成角色令牌

在可信机器生成两个不同的随机值：

```sh
openssl rand -hex 32
openssl rand -hex 32
```

分别保存为 `CONCORDIA_RELAY_CODEX_TOKEN` 和 `CONCORDIA_RELAY_ZCODE_TOKEN`。每个令牌至少 32 字符且不能相同。Codex 机器只需 Codex token；ZCode relay client 只需 ZCode token；协调器需要两个 token。Redis 自身密码与角色令牌用途不同，两者都必须保密。

## 4. 在 ZCode / Git 机器启动协调器

先安装并构建 Concordia：

```sh
cd /opt/concordia
npm ci
npm run build
```

再启动唯一的协调器进程：

```sh
CONCORDIA_REDIS_URL='rediss://concordia-user:<redis-password>@redis.example.com:6379/0' \
CONCORDIA_RELAY_NAMESPACE='team-a' \
CONCORDIA_RELAY_CODEX_TOKEN='<codex-token>' \
CONCORDIA_RELAY_ZCODE_TOKEN='<zcode-token>' \
CONCORDIA_ROOTS='/srv/git/project-a,/srv/git/project-b' \
CONCORDIA_DB='/var/lib/concordia/state.db' \
npm run start:relay
```

看到 `{"level":"info","event":"relay.started","namespace":"team-a"}` 表示已获得该 namespace 的协调器锁。同一 namespace 同时只允许一个协调器；第二个会拒绝启动。长期运行可用 systemd、launchd、Docker Compose 或进程管理器托管，但不要启两个活动副本。

## 5. Codex 跨机器配置

在 Codex 机器的 `~/.codex/config.toml` 添加：

```toml
[mcp_servers.concordia]
command = "node"
args = ["/opt/concordia/dist/src/index.js"]
enabled = true
startup_timeout_sec = 20
tool_timeout_sec = 80

[mcp_servers.concordia.env]
CONCORDIA_AGENT_ID = "codex"
CONCORDIA_TRANSPORT = "redis"
CONCORDIA_REDIS_URL = "rediss://concordia-user:<redis-password>@redis.example.com:6379/0"
CONCORDIA_RELAY_NAMESPACE = "team-a"
CONCORDIA_RELAY_CODEX_TOKEN = "<codex-token>"
CONCORDIA_RELAY_REQUEST_TIMEOUT_MS = "75000"
```

Redis 模式下不要在 Codex 机器配置 `CONCORDIA_DB` 或 `CONCORDIA_ROOTS`，因为它不会访问本地 SQLite 或 Git。保存后重启 MCP server，并调用 `list_tasks` 验证连接。

创建任务时必须使用协调主机路径，例如 `"workspace": "/srv/git/project-a"`，不能使用 Codex 机器上的检出路径。

## 6. ZCode 配置

ZCode 有两种选择。

### 选择 A：ZCode 也走 Redis

这是边界最清晰的方式：只有协调器打开 SQLite。将目标项目的 MCP 配置设为：

```json
{
  "mcp": {
    "servers": {
      "concordia": {
        "command": "node",
        "args": ["/opt/concordia/zcode-plugin/dist/index.mjs"],
        "cwd": "/srv/git/project-a",
        "env": {
          "CONCORDIA_AGENT_ID": "zcode",
          "CONCORDIA_TRANSPORT": "redis",
          "CONCORDIA_REDIS_URL": "rediss://concordia-user:<redis-password>@redis.example.com:6379/0",
          "CONCORDIA_RELAY_NAMESPACE": "team-a",
          "CONCORDIA_RELAY_ZCODE_TOKEN": "<zcode-token>",
          "CONCORDIA_RELAY_REQUEST_TIMEOUT_MS": "75000"
        },
        "enable": true
      }
    }
  }
}
```

在 ZCode 的 Full configuration 界面使用 `mcpServers` 外壳时，同一 server 内容保持不变，只把 `enable` 写成该界面支持的 `enabled`。

### 选择 B：ZCode 使用本机 stdio

如果 ZCode 与协调器在同一台机器，可继续使用插件默认配置：

```json
"CONCORDIA_TRANSPORT": "stdio",
"CONCORDIA_ROOTS": "/srv/git/project-a",
"CONCORDIA_DB": "/var/lib/concordia/state.db",
"CONCORDIA_AGENT_ID": "zcode"
```

这会让 ZCode MCP 与协调器在同一主机打开同一个 SQLite WAL，适合少量并发。不能把这种配置复制到另一台机器。

无论使用 A 还是 B，插件提供的 `/tasks READY`、`/task <id>` 和 `/watch <id>` 都可照常使用。传输方式不会改变待办列表和事件语义。

## 7. 联通验证

1. ZCode/Git 主机启动 relay coordinator。
2. Codex 重启 `concordia` MCP，调用 `list_tasks`，应返回数组而不是 relay timeout。
3. Codex 创建一个 `workspace` 为 ZCode 主机真实路径的测试任务。
4. ZCode 运行 `/tasks READY`，应看到该任务。
5. ZCode 领取后确认 `task.worktreePath` 存在于 ZCode 主机。
6. ZCode 提交任务，Codex 应能通过 `get_task` 看到 `REVIEW`。

若需要在新任务、回答或返工时按需恢复 ZCode，而不是让 ZCode 会话持续轮询，可在 ZCode/Git 机器额外启动：

```sh
CONCORDIA_TRANSPORT=redis \
CONCORDIA_REDIS_URL='rediss://concordia-user:<redis-password>@redis.example.com:6379/0' \
CONCORDIA_RELAY_NAMESPACE='team-a' \
CONCORDIA_RELAY_ZCODE_TOKEN='<zcode-token>' \
CONCORDIA_ZCODE_WAKER_DB='/var/lib/concordia/zcode-waker.db' \
npm run start:zcode-waker
```

`zcode-waker` 必须和 ZCode CLI、目标 Git 工作区位于同一台机器。它先精确领取任务并绑定返回的 worktree，再通过 `--prompt --json --surface terminal --mode build` 创建会话，并用 `--resume sess_*` 恢复；空闲不调用模型。Concordia 不调用 Computer Use，也不覆盖 ZCode agent 的工具策略。CLI 子进程不会继承 waker 的 Redis URL、角色 token 或 API key，因此 ZCode 内的 Concordia MCP 需要独立连接配置。完整说明见 [ZCode 事件唤醒器指南](zcode-waker.md)。

若要在 ZCode 提交、提问或失败时按需启动 Codex，而不是让 Codex 会话持续轮询，可在 Codex 机器额外启动：

```sh
CONCORDIA_TRANSPORT=redis \
CONCORDIA_REDIS_URL='rediss://concordia-user:<redis-password>@redis.example.com:6379/0' \
CONCORDIA_RELAY_NAMESPACE='team-a' \
CONCORDIA_RELAY_CODEX_TOKEN='<codex-token>' \
CONCORDIA_WAKER_DB='/Users/me/.local/state/concordia/waker.db' \
CONCORDIA_WAKER_CWD='/Users/me/src/example-app' \
npm run start:waker
```

远程任务记录的是 ZCode 主机路径，所以 `CONCORDIA_WAKER_CWD` 必须指向 Codex 机器上实际存在的目录。若需要独立审查完整 diff，还必须把待审 Git commit 同步到该机器。完整说明见 [Codex 事件唤醒器指南](codex-waker.md)。

## 8. 安全与可靠性

- relay 请求和响应使用角色 token 做 HMAC-SHA256 签名；协调器再次校验角色与工具权限，不信任消息中自报的角色。
- 请求包含时间戳和 nonce；默认允许 60 秒时钟偏差，nonce 默认保留 300 秒以拒绝重放。两台机器应启用时间同步。
- 响应按 request/client ID 隔离并自动过期；默认请求超时 75 秒，覆盖 `wait_events` 的最长 60 秒等待。
- Redis Streams consumer group 保存未确认请求；协调器重启后会回收闲置 pending entry。所有写操作仍应使用稳定且唯一的 `idempotencyKey`。
- `claim_task` 本身没有业务幂等键；若领取调用超时，先用 `get_task` 或 `list_tasks` 对账，再决定是否再次领取。由 `zcode-waker` 处理事件时始终传入事件的 `taskId`，避免误领下一项任务。
- `rediss://` 是远程默认要求。只有可信开发网络可显式设置 `CONCORDIA_RELAY_ALLOW_INSECURE=true` 使用明文 `redis://`。
- 日志不会打印 Redis URL、角色令牌或任务 payload。仍应限制日志、进程环境和配置文件的读取权限。
- `request_changes` 会让任务回到 `READY` 并清除旧租约。ZCode 必须重新 `claim_task` 获取新 attempt 和新 token。

可复制的完整环境变量模板见仓库根目录的 `.env.relay.example`。

## 9. 故障排查

| 现象 | 排查 |
| --- | --- |
| `Remote Redis must use TLS` | 把远程 URL 改为 `rediss://`；不要在生产环境绕过。 |
| `Redis relay request timed out` | 检查协调器是否运行、namespace 是否一致、Redis ACL/网络是否允许 Streams 命令。 |
| 签名无效或一直超时 | 核对 Codex/ZCode token 是否与协调器对应，不能混用。 |
| `Another relay coordinator already holds this namespace` | 已有活动协调器；停止重复进程或使用另一个 namespace。 |
| `WORKSPACE_DENIED` | `workspace` 必须是 ZCode 主机上 `CONCORDIA_ROOTS` 内的真实 Git 根目录。 |
| ZCode 看不到 Codex 创建的任务 | 核对两端 `CONCORDIA_RELAY_NAMESPACE` 和 Redis DB 编号；再用 `list_tasks` 验证。 |
| `LEASE_CONFLICT` | 租约已过期、已提交、已返工或已重领；重新领取，不要复用旧 token。 |
