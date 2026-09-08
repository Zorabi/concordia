# Concordia

> 面向 Codex 与 ZCode 的 local-first MCP 多代理协作控制面，支持单机 stdio 与可选的跨机器 Redis relay。

Concordia 以结构化任务、事件、租约和 Git worktree，将“规划与验收”与“实施”分开：**Codex** 创建任务、回答问题、审查交付；**ZCode** 原子领取任务、实施、按需使用其子代理，并提交可审查的 commit 与验证证据。状态保存在协调主机的本地 SQLite；双方既可在单机直接连接，也可在都没有公网 IP 时通过 Redis 中转。

它适合在一台机器或“远程 Codex + ZCode 执行主机”的两机拓扑中，可靠地协调一个或少量 Git 仓库，不依赖 GitHub Issue 或共享在线文档。

## 它解决什么问题

- **任务是契约**：目标、目标仓库、允许路径、约束、验收条件与交付项均为结构化字段。
- **事件是沟通**：进度、提问、回答、心跳、失败、返工和批准都是带序号的持久事件。
- **提交是证据**：ZCode 提交的 SHA、变更文件、检查结果和风险进入任务记录，供 Codex 审查。
- **租约防止双写**：过期重领后旧执行者会被围栏拒绝，不能继续写入事件或提交。
- **worktree 隔离写入**：每次领取使用独立 Git branch/worktree，避免并发任务互相污染。

## 边界与非目标

当前版本面向**单协调节点、同一可信用户或团队、少量并发任务**。已实现 SQLite 持久化、任务状态机、Git 隔离、幂等写入、租约恢复、ZCode 插件，以及基于 Redis Streams 和角色签名的跨机器 relay。尚不提供：

- 多用户身份、仓库级 ACL 或租户隔离；
- 多协调节点高可用或 PostgreSQL；
- 多个独立 ZCode 执行机之间的路径映射和 Git 对象传输；
- Web Dashboard 或推送订阅；
- 自动合并、推送远程 Git、发布制品或部署；
- 强制 ZCode 使用某个子代理，或替代理制订实现计划；
- 映射为 ZCode 原生侧边栏任务。

合并、推送、发布与生产操作须由用户或上层协调者明确执行。

## 架构

### 单机模式

```text
Codex ── stdio MCP ─┐
                    ├── Concordia ── SQLite（任务、事件、交付物）
ZCode ── stdio MCP ─┘        │
                              └── 目标 Git 仓库/.worktrees/<task>-zcode-a<attempt>
```

### 跨机器 Redis 模式

```text
Codex MCP relay client ──┐
                         ├── 出站 TLS ──> Redis Streams/response keys
ZCode MCP relay client ──┘                         │
                                                  │ 出站连接
                                      Concordia relay coordinator（ZCode/Git 主机）
                                                  ├── 本机 SQLite
                                                  └── 本机 Git 仓库与 worktrees
```

远程模式必须把协调器部署在持有目标 Git 仓库的执行主机上。两端只需主动连接同一 Redis，无需公网 IP 或入站端口；`claim_task` 和 `submit_task` 仍在协调主机执行本机 Git/worktree 强校验。详细部署、令牌、Codex/ZCode 配置和安全限制见 [跨机器协调指南](docs/remote-coordination.md)。

这里有两个不同的目录：

- **Concordia 源码目录**：本仓库，包含 `src/`、构建产物与 `zcode-plugin/`；例如 `/absolute/path/to/concordia`。
- **被管理的目标 Git 仓库**：代理真正修改的业务项目；例如 `/absolute/path/to/example-app`。任务 `workspace` 必须是它的 Git 根目录。worktree 创建在这个目标仓库内，而非 Concordia 源码目录。

单机模式下，Codex 与 ZCode 可运行各自的 stdio MCP 服务进程；只要两端的 `CONCORDIA_DB` 指向同一绝对 SQLite 路径，便可共享状态。跨机器模式下，SQLite 只保留在协调主机本地，远程客户端通过 Redis relay 访问，禁止多台机器直接打开网络共享目录中的 SQLite 文件。

### 状态生命周期

`DRAFT` 是协议中保留的类型；当前 `create_task` 会直接创建并发布为 `READY`。

```text
READY ── claim ──> CLAIMED ── progress ──> RUNNING ── submit ──> REVIEW
                                             │                       │
                                             ├─ question ─> WAITING_INPUT
                                             │               └─ answer ─> RUNNING
                                             ├─ failed ───> FAILED
                                             ├─ cancelled ─> CANCELLED
                                             └──────────────── request_changes ─> READY（重新领取）
                                                                approve ─────────> APPROVED
```

终态为 `APPROVED`、`FAILED`、`CANCELLED`。只有 Codex 能创建、审批或要求返工；只有 ZCode 能领取和提交任务。

## 前置条件

- Node.js **22.13+**（使用 `node:sqlite`）。
- Git，且每个目标工作区必须是可访问的 Git 仓库根目录。
- npm。
- 可使用 Codex 和/或 ZCode 的 MCP 功能。
- 跨机器模式额外需要 Redis 7+ 或兼容服务；单机模式不需要 Redis 服务。

```sh
node --version
git --version
npm --version
```

## 安装、构建与运行

在 **Concordia 源码目录**执行：

```sh
npm install
npm run build
npm test
```

构建产生：

- `dist/src/index.js`：本机 stdio MCP 服务；
- `dist/src/relay.js`：运行在 ZCode/Git 主机上的 Redis relay coordinator；
- `zcode-plugin/dist/index.mjs`：随 ZCode 本地插件分发的单文件 bundle。

服务使用 stdio，通常由 MCP 客户端启动。以下命令只用于验证进程可启动，随后会等待标准输入上的 MCP 客户端：

```sh
CONCORDIA_ROOTS=/absolute/path/to/example-app \
CONCORDIA_AGENT_ID=codex \
npm start
```

MCP 协议仅写 stdout；启动与错误日志写 stderr。默认数据库为启动目录的 `.concordia/state.db`。实际同时使用 Codex 和 ZCode 时，应配置同一个绝对 `CONCORDIA_DB`，避免不同 `cwd` 产生两个状态库。

跨机器协调器使用：

```sh
CONCORDIA_ROOTS=/absolute/path/to/repositories \
CONCORDIA_DB=/absolute/path/to/state.db \
CONCORDIA_REDIS_URL='rediss://user:password@redis.example.com:6379/0' \
CONCORDIA_RELAY_NAMESPACE='team-a' \
CONCORDIA_RELAY_CODEX_TOKEN='<至少 32 字符的随机 token>' \
CONCORDIA_RELAY_ZCODE_TOKEN='<另一个至少 32 字符的随机 token>' \
npm run start:relay
```

协调器不监听入站 HTTP 端口，只主动连接 Redis。跨网络使用 `rediss://`，完整配置见 [跨机器协调指南](docs/remote-coordination.md)。

## 配置

| 变量 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `CONCORDIA_TRANSPORT` | 否 | `stdio` | MCP 客户端传输模式：`stdio` 直接访问本机状态，`redis` 通过中转。 |
| `CONCORDIA_AGENT_ID` | 是 | 无 | 只允许 `codex` 或 `zcode`；角色不匹配的工具会被拒绝。 |
| `CONCORDIA_ROOTS` | stdio/协调器 | 无 | 允许的目标项目根目录；Redis client 不设置。 |
| `CONCORDIA_DB` | 否 | `<cwd>/.concordia/state.db` | stdio/协调器使用的本机 SQLite；Redis client 不设置，绝不能跨机器共享。 |
| `CONCORDIA_REDIS_URL` | Redis 模式 | 无 | Redis URL；远程默认要求 `rediss://`。 |
| `CONCORDIA_RELAY_NAMESPACE` | 否 | `concordia` | 隔离不同部署的 Redis 键，1–64 个安全字符。 |
| `CONCORDIA_RELAY_CODEX_TOKEN` | Codex relay/协调器 | 无 | Codex 请求 HMAC token，至少 32 字符。 |
| `CONCORDIA_RELAY_ZCODE_TOKEN` | ZCode relay/协调器 | 无 | ZCode 请求 HMAC token，至少 32 字符且与 Codex token 不同。 |

例如：

```sh
CONCORDIA_ROOTS=/Users/me/src/project-a,/Users/me/src/project-b
```

路径范围字段 `ownedPaths`、`excludedPaths`、`changedFiles` 必须使用相对工作区的 POSIX 路径，例如 `src/api`，不要使用反斜杠。

## 接入 Codex 与 ZCode

下面使用一组固定示例路径。配置时请把它们全部替换为你机器上的真实绝对路径：

| 含义 | 本节示例值 |
| --- | --- |
| Concordia 源码目录 | `/Users/me/tools/concordia` |
| 被管理的目标 Git 仓库 | `/Users/me/src/example-app` |
| 双端共享数据库 | `/Users/me/src/example-app/.concordia/state.db` |

先完成一次构建并确认两个入口文件存在：

```sh
cd /Users/me/tools/concordia
npm install
npm run build

test -f /Users/me/tools/concordia/dist/src/index.js
test -f /Users/me/tools/concordia/zcode-plugin/dist/index.mjs
git -C /Users/me/src/example-app rev-parse --show-toplevel
```

最后一条命令应输出 `/Users/me/src/example-app`。如果输出的是其他目录，应把后续配置中的目标仓库路径改成实际 Git 根目录。

### 在 Codex 中配置

Codex 桌面应用、CLI 和 IDE 扩展在同一 Codex host 上共用 MCP 配置。配置文件可放在全局 `~/.codex/config.toml`，也可放在可信目标项目的 `.codex/config.toml`。以下方式任选一种，详见 [Codex MCP 官方文档](https://developers.openai.com/codex/mcp/)。

#### 方式 A：编辑 `config.toml`（推荐）

将以下内容追加到 `~/.codex/config.toml`。如果只想让服务器在一个项目中可用，则追加到 `/Users/me/src/example-app/.codex/config.toml`：

```toml
[mcp_servers.concordia]
command = "node"
args = ["/Users/me/tools/concordia/dist/src/index.js"]
cwd = "/Users/me/src/example-app"
enabled = true
startup_timeout_sec = 20
# wait_events 最长等待 60 秒，工具超时需略大于 60 秒。
tool_timeout_sec = 70

[mcp_servers.concordia.env]
CONCORDIA_TRANSPORT = "stdio"
CONCORDIA_ROOTS = "/Users/me/src/example-app"
CONCORDIA_DB = "/Users/me/src/example-app/.concordia/state.db"
CONCORDIA_AGENT_ID = "codex"
```

注意：

- `args` 指向 Concordia 源码构建出的 `dist/src/index.js`，不是目标项目中的文件。
- `cwd`、`CONCORDIA_ROOTS` 和 `CONCORDIA_DB` 指向被管理的目标项目。
- `CONCORDIA_AGENT_ID` 在 Codex 端必须是 `codex`。
- 管理多个仓库时，可用逗号或系统路径分隔符连接多个 `CONCORDIA_ROOTS`；每个任务的 `workspace` 仍必须是其中某个 Git 仓库的根目录。

保存后重启 Codex MCP server：桌面应用可进入 **Settings → MCP servers**，找到 `concordia` 后选择 **Restart**；CLI 或 IDE 扩展可重新启动会话。然后在 Codex 会话中输入 `/mcp`，应能看到 `concordia` 及其 8 个工具。

#### 方式 B：使用 Codex CLI 添加

如果本机安装了 Codex CLI，可以运行：

```sh
codex mcp add concordia \
  --env CONCORDIA_TRANSPORT=stdio \
  --env CONCORDIA_ROOTS=/Users/me/src/example-app \
  --env CONCORDIA_DB=/Users/me/src/example-app/.concordia/state.db \
  --env CONCORDIA_AGENT_ID=codex \
  -- node /Users/me/tools/concordia/dist/src/index.js

codex mcp list
```

CLI 写入的也是 Codex MCP 配置。该命令已经显式指定数据库和允许根目录，因此不依赖 MCP 进程从哪个目录启动。如需 `cwd`、超时等精细选项，再按方式 A 编辑生成的 `~/.codex/config.toml`。

#### Codex 端验证

在一个新的 Codex 会话中要求它“调用 Concordia 的 `list_tasks`”。若返回任务列表或空数组，说明连接成功。Codex 端具有读取权限，并可调用 `create_task`、以 `sender: "codex"` 发送 `ANSWER`/`CANCELLED`，以及调用 `review_task`；它不能领取或提交任务。

### 在 ZCode 中配置

推荐安装仓库内置插件，因为它会同时提供 Concordia MCP server 和 `/tasks`、`/task`、`/watch` 命令。也可以只手动添加 MCP server，但手动方式不会安装这些斜杠命令。参见 [ZCode Plugin 文档](https://zcode.z.ai/en/docs/plugin)和 [ZCode MCP 文档](https://zcode.z.ai/en/docs/mcp-services)。

插件安装后的待办查看、任务领取、事件监听和提交操作，详见 [ZCode 使用指南](docs/zcode-usage.md)。

#### 方式 A：安装 Concordia 插件（推荐）

本仓库根目录的 `marketplace.json` 已将 `zcode-plugin/` 声明为可安装插件。操作步骤：

1. 先按前文执行 `npm run build`，确保 `zcode-plugin/dist/index.mjs` 存在。
2. 在 ZCode 中打开**目标项目** `/Users/me/src/example-app`，不要把 Concordia 源码目录当作目标项目打开。
3. 打开 **Settings → Plugins**。如果页面提示先打开 workspace，请先完成上一步。
4. 点击右上角 **Create → Add marketplace**。
5. 本地开发时选择目录 `/Users/me/tools/concordia`；发布 GitHub 后也可以填写 Concordia 仓库 URL。
6. 在 **Personal** 区域找到 `concordia-local` marketplace，再找到 `concordia` 插件，点击 **Install** 并确认已启用。
7. 打开 **Settings → MCP Servers**，在 **Plugin MCP servers** 分组确认 `plugin:concordia:concordia` 已启用。
8. 新建一个 ZCode 会话，输入 `/tasks`。能够返回任务表或“没有匹配任务”即表示插件和 MCP 都已加载。

插件内置的 `zcode-plugin/.mcp.json` 为：

```json
{
  "mcpServers": {
    "concordia": {
      "type": "stdio",
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/dist/index.mjs"],
      "cwd": "${CLAUDE_PROJECT_DIR}",
      "env": {
        "CONCORDIA_TRANSPORT": "stdio",
        "CONCORDIA_ROOTS": "${CLAUDE_PROJECT_DIR}",
        "CONCORDIA_DB": "${CLAUDE_PROJECT_DIR}/.concordia/state.db",
        "CONCORDIA_AGENT_ID": "zcode"
      },
      "enabled": true,
      "timeoutMs": 70000
    }
  }
}
```

其中：

- `${CLAUDE_PLUGIN_ROOT}`（也可写成 `${ZCODE_PLUGIN_ROOT}`）由 ZCode 替换为已安装插件目录。
- `${CLAUDE_PROJECT_DIR}` 由 ZCode 替换为当前打开的目标项目根目录。
- `CONCORDIA_DB` 会展开为 `/Users/me/src/example-app/.concordia/state.db`；前面的 Codex 配置必须指向完全相同的文件。
- `timeoutMs` 略大于 `wait_events` 允许的最长 60 秒等待，避免正常长轮询被客户端提前中止。

修改 Concordia 或插件源码后，应重新运行 `npm run build`，然后在 ZCode 的 Marketplace sources 中刷新 `concordia-local`。如果插件已经被复制进 ZCode 缓存而非直接引用源码，刷新或重新安装后再开新会话。

#### 方式 B：只手动添加 MCP server

不需要斜杠命令时，可在 ZCode 中打开 **Settings → MCP Servers → New MCP Server**，选择 **Workspace** scope，切换到 **Full configuration**，粘贴以下 JSON：

```json
{
  "mcpServers": {
    "concordia": {
      "type": "stdio",
      "command": "node",
      "args": ["/Users/me/tools/concordia/zcode-plugin/dist/index.mjs"],
      "cwd": "/Users/me/src/example-app",
      "env": {
        "CONCORDIA_TRANSPORT": "stdio",
        "CONCORDIA_ROOTS": "/Users/me/src/example-app",
        "CONCORDIA_DB": "/Users/me/src/example-app/.concordia/state.db",
        "CONCORDIA_AGENT_ID": "zcode"
      },
      "enabled": true,
      "timeoutMs": 70000
    }
  }
}
```

也可以手动写入目标项目的 `/Users/me/src/example-app/.zcode/config.json`：

```json
{
  "mcp": {
    "servers": {
      "concordia": {
        "command": "node",
        "args": ["/Users/me/tools/concordia/zcode-plugin/dist/index.mjs"],
        "cwd": "/Users/me/src/example-app",
        "env": {
          "CONCORDIA_TRANSPORT": "stdio",
          "CONCORDIA_ROOTS": "/Users/me/src/example-app",
          "CONCORDIA_DB": "/Users/me/src/example-app/.concordia/state.db",
          "CONCORDIA_AGENT_ID": "zcode"
        },
        "enable": true
      }
    }
  }
}
```

ZCode 的用户级配置位于 `~/.zcode/cli/config.json`，项目级配置位于 `<project>/.zcode/config.json`。本工具建议使用项目级配置，以免一个固定 `cwd` 和数据库路径意外应用到所有项目。保存后在 MCP 列表确认服务器已启用，并新建会话测试 `list_tasks`。

#### 双端联通验证

1. 分别启动或重启 Codex 与 ZCode 中的 `concordia` MCP server。
2. 在 Codex 中调用 `create_task` 创建一个目标仓库为 `/Users/me/src/example-app` 的任务。
3. 在 ZCode 中运行 `/tasks`，或要求 ZCode 调用 `list_tasks`。
4. 如果 ZCode 能看到刚创建的任务，说明两端正在使用同一数据库。
5. 若看不到，优先核对两端 `CONCORDIA_DB` 的绝对路径是否逐字符一致，再检查两端 `CONCORDIA_ROOTS` 是否包含目标 Git 根目录。

插件提供的 `/tasks`、`/task <task-id>`、`/watch <task-id>` 是只读辅助命令；真正的领取、提交和审核仍由 MCP 工具完成。

### 切换为跨机器 Redis relay

只有需要跨设备时才设置 `CONCORDIA_TRANSPORT=redis`。远端 Codex 的最小配置为：

```toml
[mcp_servers.concordia]
command = "node"
args = ["/Users/me/tools/concordia/dist/src/index.js"]
enabled = true
startup_timeout_sec = 20
tool_timeout_sec = 80

[mcp_servers.concordia.env]
CONCORDIA_AGENT_ID = "codex"
CONCORDIA_TRANSPORT = "redis"
CONCORDIA_REDIS_URL = "rediss://user:password@redis.example.com:6379/0"
CONCORDIA_RELAY_NAMESPACE = "team-a"
CONCORDIA_RELAY_CODEX_TOKEN = "<至少 32 字符的 Codex token>"
```

ZCode/Git 机器需要另外运行 `npm run start:relay`。ZCode MCP 可设置同一个 Redis URL 与 namespace、使用独立的 `CONCORDIA_RELAY_ZCODE_TOKEN`；也可在协调主机继续用默认 `stdio`，直接连接协调器所用的本机 SQLite。Redis 模式下，任务 `workspace` 一律填写 ZCode/Git 机器上的绝对路径。

可直接复制的 ZCode JSON、协调器命令、Redis ACL/TLS 要求和联通步骤见 [跨机器协调指南](docs/remote-coordination.md)。

## MCP 工具

工具返回 JSON 内容及结构化结果。业务错误统一形如 `{ code, message, retryable, details? }`。每次写操作都需唯一 `idempotencyKey`（最长 256 字符）；完全相同的重试返回原结果，不重复写入。

| 工具 | 角色 | 作用与关键输入 |
| --- | --- | --- |
| `create_task` | Codex | 创建并发布 `READY` 任务。输入 `spec` 和 `idempotencyKey`。 |
| `claim_task` | ZCode | 原子领取最早匹配任务；可按 `workspace` 筛选，`leaseSeconds` 为 1–3600（默认 60）。无任务返回 `{ task: null }`；成功包含 `leaseToken`。 |
| `get_task` | 两者 | 获取任务契约、状态、租约摘要、交付物、提交记录与近期事件；`eventLimit` 默认 20、最大 100。 |
| `list_tasks` | 两者 | 以 `status`、`assignee`、`workspace`、`updatedAfter`、`limit` 筛选；默认 20、最大 100。 |
| `send_event` | 两者 | 追加授权事件；可带 `expectedVersion`。ZCode 的写入必须带当前 `leaseToken`。 |
| `wait_events` | 两者 | 查询 `afterEventId` 后的新事件，最长等待 60 秒（默认 30 秒）；超时返回空数组。 |
| `submit_task` | ZCode | 提交当前 attempt worktree 的 HEAD commit、精确变更列表、检查、风险和摘要，转入 `REVIEW`。 |
| `review_task` | Codex | 对 `REVIEW` 任务 `approve` 或 `request_changes`；返工至少需要一条 finding。 |

`send_event` 权限：

| 发送者 | 可发送事件 |
| --- | --- |
| Codex | `ANSWER`、`CANCELLED` |
| ZCode | `PROGRESS`、`QUESTION`、`AGENT_STATUS`、`HEARTBEAT`、`FAILED` |

`TASK_CREATED`、`TASK_CLAIMED`、`COMPLETED`、`CHANGES_REQUESTED`、`APPROVED` 由专用工具生成，不能经 `send_event` 伪造。

### 任务契约

```ts
{
  id: string;                 // 字母数字开头，最多 128 字符，可含 . _ -
  objective: string;
  workspace: string;          // 目标 Git 仓库根目录，不是 Concordia 源码目录
  baseCommit?: string;        // 省略时创建时解析为目标仓库 HEAD 的完整 SHA
  ownedPaths: string[];       // 至少一个相对路径
  excludedPaths?: string[];
  constraints: string[];
  acceptance: string[];       // 至少一项
  deliverables: ("commit" | "changed_files" | "checks" | "risks")[];
  delegation: { mode: "auto" | "disabled"; maxConcurrency: number; maxDepth: 1 };
  timeoutSeconds: number;
}
```

`baseCommit` 在创建时解析为完整 SHA。`timeoutSeconds`、`delegation.mode` 与 `maxConcurrency` 目前是被验证和保存的契约信息，不会由运行时自动杀死、调度或限流代理；`maxDepth` 必须为 `1`。

提交检查只接受以下 `commandId` 白名单：`build`、`format-check`、`git-diff-check`、`lint`、`npm-build`、`npm-lint`、`npm-test`、`npm-typecheck`、`test`、`typecheck`。Concordia 记录检查证据，不会执行 payload 中的 shell 命令。

## leaseToken、attempt 与 worktree

### 租约与 fencing token

`claim_task` 成功结果中的 `leaseToken` 是当前执行权的短期凭据。ZCode **必须**把它带入后续每个 `send_event`（包括 `HEARTBEAT`）及 `submit_task`。token 不会进入 `get_task`、事件、提交记录或日志；不要回显、提交或持久化它。

默认租约 60 秒。长任务应在到期前用 `HEARTBEAT` 续租，并可传 `leaseSeconds`（1–3600）。租约过期后另一个领取者可以接手，服务会颁发新 token；旧 token 被围栏拒绝。`expectedVersion` 是可选的乐观并发控制，适合读—改—写过程。

提交进入 `REVIEW` 时租约立即失效。Codex 要求返工后任务回到 `READY`；ZCode 必须再次调用 `claim_task`，在新 attempt worktree 中继续，并使用新 `leaseToken`。旧 token 永远不能恢复使用。

### 每个 attempt 的独立工作区

每次领取创建或复用该尝试专属路径：

```text
<目标 Git 仓库>/.worktrees/<task-id>-zcode-a<attempt>/
```

对应分支为 `concordia/<task-id>-zcode-a<attempt>`。首次从 `baseCommit` 建立；租约过期后的新 attempt 从上一次 worktree 的已提交 `HEAD` 快照恢复（没有可恢复 worktree 时从 base commit 开始）。旧 attempt 目录不会被新 attempt 重用。

**ZCode 必须修改 `claim_task` 返回的 `task.worktreePath`，而不是目标仓库的原始检出目录。** 提交时服务验证：

1. 目标仓库/worktree 均在允许根目录内，且不存在符号链接逃逸；
2. `baseCommit` 仍解析为原完整 SHA，提交历史从其演进；
3. 提交 SHA 是当前 attempt worktree 的完整、不可变 `HEAD`；
4. `changedFiles` 与 Git diff 精确一致；
5. 最终 diff、所有中间提交及未提交改动仅触及 `ownedPaths`，且不触及 `excludedPaths`。

## 端到端示例

假设目标仓库为 `/absolute/path/to/example-app`，两端均连接 `/absolute/path/to/example-app/.concordia/state.db`。以下 JSON 是 MCP 工具参数，不是 shell 命令。

1. Codex 获取目标仓库基准并调用 `create_task`：

   ```sh
   git -C /absolute/path/to/example-app rev-parse HEAD
   ```

   ```json
   {
     "spec": {
       "id": "docs-api-001",
       "objective": "为 API 客户端补充使用文档",
       "workspace": "/absolute/path/to/example-app",
       "baseCommit": "<完整 SHA>",
       "ownedPaths": ["docs", "README.md"],
       "excludedPaths": [".github"],
       "constraints": ["不要修改运行时代码"],
       "acceptance": ["文档包含安装与 API 示例", "npm test 通过"],
       "deliverables": ["commit", "changed_files", "checks", "risks"],
       "delegation": { "mode": "auto", "maxConcurrency": 1, "maxDepth": 1 },
       "timeoutSeconds": 1800
     },
     "idempotencyKey": "docs-api-001:create:v1"
   }
   ```

2. ZCode 领取并保存返回的 `task.worktreePath` 与 `leaseToken`：

   ```json
   { "agentId": "zcode", "workspace": "/absolute/path/to/example-app" }
   ```

3. 在返回的 attempt worktree 工作，并用 token 上报进度：

   ```json
   {
     "taskId": "docs-api-001",
     "sender": "zcode",
     "recipient": "codex",
     "type": "PROGRESS",
     "payload": { "phase": "writing", "summary": "正在编写 API 示例" },
     "idempotencyKey": "docs-api-001:progress:writing",
     "leaseToken": "<领取结果的 leaseToken>"
   }
   ```

   该事件将 `CLAIMED` 变为 `RUNNING`。需要澄清时发送 `QUESTION`；Codex 用 `ANSWER` 回复，任务从 `WAITING_INPUT` 返回 `RUNNING`。长任务发送 `HEARTBEAT` 续租。

4. 在 **返回的** worktree 中完成、验证、提交：

   ```sh
   cd /absolute/path/to/example-app/.worktrees/docs-api-001-zcode-a1
   npm test
   git add docs README.md
   git commit -m "docs: add API client guide"
   git rev-parse HEAD
   ```

5. ZCode 调用 `submit_task`。`commit` 为完整 SHA，`changedFiles` 必须与 `baseCommit..commit` diff 完全一致：

   ```json
   {
     "taskId": "docs-api-001",
     "leaseToken": "<领取结果的 leaseToken>",
     "commit": "<完整提交 SHA>",
     "changedFiles": ["README.md", "docs/api-client.md"],
     "checks": [{ "commandId": "npm-test", "exitCode": 0, "summary": "npm test passed" }],
     "risks": [],
     "summary": "补充 API 客户端安装、认证和调用示例。",
     "idempotencyKey": "docs-api-001:submit:1"
   }
   ```

6. Codex 用 `get_task` 读取交付证据并审查 diff，之后调用 `review_task`：

   ```json
   {
     "taskId": "docs-api-001",
     "decision": "approve",
     "summary": "文档内容和测试证据已核对。",
     "idempotencyKey": "docs-api-001:approve:1"
   }
   ```

   返工时使用 `decision: "request_changes"` 并给出至少一个 `{ path?, line?, severity, message }` finding。任务会回到 `READY`，ZCode 需要重新领取。批准只表示任务协议完成，**不会自动合并** worktree branch；后续合并、cherry-pick 或丢弃由用户或上层协调者决定。

## ZCode 命令

| 命令 | 用途 |
| --- | --- |
| `/tasks [status]` | 列出当前工作区近期任务；可按一个或多个状态过滤，显示 ID、状态、执行者、更新时间和目标。 |
| `/task <task-id>` | 显示任务契约、状态、路径范围、验收条件、租约摘要、交付证据与近期事件。 |
| `/watch <task-id>` | 读取当前事件游标后循环 `wait_events` 显示新事件；终态、用户中止或达到观察限制时停止。 |

这些都是查询/观察命令，不会领取、提交或审核任务。

## 安全模型

Concordia 的边界是“可信用户/团队 + 明确工作区白名单”，不是完整的多租户平台。已实现的约束包括：

- 必须显式声明 `codex` 或 `zcode`；工具和事件发送者均做角色校验；
- `CONCORDIA_ROOTS` 限制目标工作区，且工作区必须为该根内的 Git 仓库根；
- 路径范围拒绝绝对路径、`..`、反斜杠、Git/Concordia 控制目录和越界符号链接；
- worktree 及既有目录会解析真实路径，防止逃离目标仓库；
- SQLite 使用外键、WAL、事务和任务 version 乐观锁；事件 idempotency key 全局唯一；
- `leaseToken` 使用时序安全比较，轮换后旧领取者无法继续写入；
- Redis relay 使用分角色 HMAC-SHA256 签名、时间戳、nonce 防重放、响应 TTL 和单协调器锁；
- 远程 Redis 默认强制 `rediss://`，角色 token 与 Redis 凭据均不进入日志；
- `submit_task` 不执行任意命令；只记录白名单检查 ID 的结果；
- 业务错误不回显环境变量、凭据或完整命令输出。

任何能读写本地数据库、Git 工作区、Redis 数据或 MCP 配置的用户仍在同一信任域。跨机器生产部署应使用 Redis ACL 和 TLS。

## 测试与开发

```sh
npm run typecheck  # 严格 TypeScript 类型检查
npm run build      # 编译服务并打包 ZCode 插件
npm test           # build 后运行 Node 内置测试
```

若本机有测试 Redis，可额外执行真实 relay 往返测试：

```sh
CONCORDIA_TEST_REDIS_URL=redis://127.0.0.1:6379 npm test
```

测试覆盖完整领取—运行—提交—返工重领—批准流程、并发领取、幂等、租约恢复、fencing token、数据库重启持久化、事件等待、基准提交验证、worktree 恢复、relay 签名/权限/TLS 校验，以及路径/符号链接/提交历史范围校验。

详见：[系统设计](docs/design.md)、[开发指南](docs/development.md)与 [ZCode 使用指南](docs/zcode-usage.md)。

## 目录结构

```text
concordia/                         # Concordia 源码目录
├── src/
│   ├── index.ts                   # stdio MCP server 与 8 个工具
│   ├── protocol.ts                # 类型、验证、错误模型
│   ├── database.ts                # SQLite 初始化、迁移、事务
│   ├── events.ts                  # 事件追加、查询、有界等待
│   ├── tasks.ts                   # 状态机、租约、幂等、交付验证
│   ├── workspace.ts               # Git/worktree、路径范围
│   ├── relay-protocol.ts          # relay 签名信封与安全校验
│   ├── relay-client.ts            # Redis 模式 MCP client
│   └── relay.ts                   # Redis Streams coordinator
├── tests/                         # 核心与 relay 测试
├── marketplace.json               # ZCode 本地/GitHub marketplace 入口
├── zcode-plugin/                  # 可加载的 ZCode 本地插件
│   ├── .mcp.json
│   ├── .zcode-plugin/plugin.json
│   └── commands/                  # /tasks、/task、/watch
├── docs/
│   ├── zcode-usage.md            # ZCode 待办、监听与执行指南
│   ├── design.md
│   └── development.md
├── package.json
└── tsconfig.json

<目标 Git 仓库>/
└── .worktrees/<task>-zcode-a<attempt>/  # Concordia 运行时创建
```

本仓库 `.gitignore` 忽略 `node_modules/`、`dist/`、`.concordia/`、`.worktrees/` 和 TypeScript 构建缓存。

## 开源协议

Concordia 使用 [MIT License](LICENSE) 开源。你可以自由使用、复制、修改、合并、发布和分发本软件，但必须保留原始版权与许可声明。本软件按“原样”提供，不附带任何明示或默示担保。

## 故障排查

| 现象 | 处理 |
| --- | --- |
| `CONCORDIA_AGENT_ID is required` | 为 MCP server 设置 `CONCORDIA_AGENT_ID=codex` 或 `zcode`。 |
| `CONCORDIA_ROOTS must contain at least one allowed root` | 配置至少一个存在的目标项目根目录。 |
| `WORKSPACE_DENIED` | 确认 `workspace` 是位于 `CONCORDIA_ROOTS` 内的目标 Git 仓库根，而不是其子目录或 Concordia 源码目录；检查软链接。 |
| 两端看不到彼此任务 | 两端 `CONCORDIA_DB` 必须是同一个绝对文件。若 ZCode 使用默认值，Codex 应设为 `<目标仓库>/.concordia/state.db`。 |
| `Redis relay request timed out` | 确认协调器运行中，Redis URL、数据库编号和 namespace 一致，ACL 允许所需命令。 |
| 远程 `redis://` 被拒绝 | 生产环境改用 `rediss://`；只有可信开发网络才设置 `CONCORDIA_RELAY_ALLOW_INSECURE=true`。 |
| `claim_task` 返回 `task: null` | 没有匹配的 `READY` 任务，也没有过期可恢复任务；用 `list_tasks` 查看。 |
| `LEASE_CONFLICT` | token 不正确、租约过期或已被重领。重新领取，切勿复用旧 token。 |
| `STALE_VERSION` | 读取后任务被其他写操作改变；重新 `get_task` 后继续。 |
| `BASE_COMMIT_MISMATCH` | 基准 SHA 无法解析或尝试历史不从其演进；检查 Git 历史和任务 `baseCommit`。 |
| `PATH_SCOPE_VIOLATION` / 提交被拒绝 | 核对 `ownedPaths`/`excludedPaths`；最终 diff、中间提交与未提交改动必须全部在允许范围内。 |
| 提交不是当前 HEAD | 在当前 `task.worktreePath` 中提交，并传 `git rev-parse HEAD` 的完整 SHA。 |
| SQLite 初始化被锁定 | 稍后重试；初始化有有限重试。若持续发生，检查异常进程是否占用同一数据库。 |

## 当前限制

- 当前版本为 `0.2.0`，`package.json` 标为 `private: true`，尚未作为 npm 包发布。
- Node 的 `node:sqlite` 在部分 Node 22 发行版可能显示实验性 API 警告；采用前请按自身 Node 策略评估。
- Redis relay 当前只支持单活动协调器，不提供多协调器高可用、远程备份或自动清理旧 attempt worktree。
- `timeoutSeconds`、`delegation.maxConcurrency`、`delegation.mode` 不会被运行时强制调度或限流。
- `wait_events` 是最多 60 秒的轮询等待；调用方维护 `afterEventId` 并决定是否继续观察。
- 提交路径校验不替代人工/自动代码审查、CI、合并策略和发布流程。
