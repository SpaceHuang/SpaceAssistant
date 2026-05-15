# 产品需求说明书（PRD）

## Claude Code 工具（Tools）功能支持

| 字段 | 内容 |
|------|------|
| 文档版本 | v1.0 |
| 状态 | 草稿 |
| 作者 | 产品团队 |
| 最后更新 | 2026-03-20 |

---

## 1. 背景与目标

### 1.1 背景

Claude Code 是 Anthropic 推出的面向开发者的命令行 AI 编码助手。其核心价值在于让 Claude 模型不仅能理解和生成代码，还能主动与开发者的工作环境、外部服务和数据源进行交互。**Tools（工具）功能**是实现这一目标的关键能力层——它决定了 Claude Code 能"触手可及"什么、能做什么、以及在什么约束下行事。

### 1.2 产品目标

- 让开发者能够将 Claude Code 连接到任意外部工具、数据库和 API
- 提供内置工具集覆盖核心编码场景（文件读写、Shell 执行、Web 检索等）
- 支持通过标准化协议（MCP）接入数百个第三方工具生态
- 提供细粒度的工具权限控制，保障安全边界
- 支持开发者通过 SDK 以编程方式定义和注册自定义工具

---

## 2. 用户角色与场景

### 2.1 主要用户角色

| 角色 | 描述 | 关键诉求 |
|------|------|---------|
| 个人开发者 | 在本地使用 Claude Code 辅助日常编码 | 快速连接常用工具，减少繁琐配置 |
| 平台工程师 | 在团队/企业环境中部署和管控 Claude Code | 统一配置、权限审计、工具白名单 |
| AI 应用开发者 | 通过 SDK 将 Claude Code 嵌入自研应用 | 以编程方式定义工具，精细控制工具调用行为 |
| 企业管理员 | 管理组织内 Claude Code 的工具接入策略 | 制定允许/禁止工具列表，防止数据泄露 |

### 2.2 典型使用场景

- **场景 A（个人开发者）**：开发者在终端中询问 Claude Code 将某个 JIRA Issue 的需求实现为代码并创建 PR，Claude Code 需要依次调用 JIRA MCP、GitHub MCP 和本地文件写入工具完成任务。
- **场景 B（平台工程师）**：在 CI/CD 流水线中集成 Claude Code，仅允许调用代码检查和测试相关工具，禁止访问生产数据库。
- **场景 C（AI 应用开发者）**：使用 Python/JS SDK 构建一个自动化法律文件审查 Agent，在同一进程中注册文件解析、数据库查询等自定义工具。
- **场景 D（企业管理员）**：通过企业策略文件统一下发允许连接的 MCP 服务器列表，员工无法在受管设备上擅自添加未授权工具。

---

## 3. 功能范围

### 3.1 功能模块总览

```
Claude Code Tools 功能
├── 3.2 内置工具集（Built-in Tools）
├── 3.3 MCP 外部工具接入
│   ├── 3.3.1 传输协议支持
│   ├── 3.3.2 配置管理
│   └── 3.3.3 工具搜索（Tool Search）
├── 3.4 SDK 自定义工具（Custom Tools）
├── 3.5 工具权限控制
└── 3.6 Hooks 机制
```

---

### 3.2 内置工具集（Built-in Tools）

Claude Code 应提供一组开箱即用的核心工具，覆盖日常编码场景，无需用户额外配置。

#### 核心内置工具

| 工具名称 | 描述 | 默认启用 |
|---------|------|--------|
| `Read` | 读取文件内容 | ✅ |
| `Write` | 写入/创建文件 | ✅（需确认）|
| `Edit` | 按 diff 格式编辑文件 | ✅（需确认）|
| `MultiEdit` | 批量编辑多个文件 | ✅（需确认）|
| `Bash` | 在 Shell 环境执行命令 | ✅（需确认）|
| `WebSearch` | 搜索互联网 | ✅ |
| `WebFetch` | 获取指定 URL 的网页内容 | ✅ |
| `TodoRead` | 读取任务列表 | ✅ |
| `TodoWrite` | 写入/更新任务列表 | ✅ |
| `Task` | 启动子 Agent 执行子任务 | ✅ |

**需求细节：**

- 所有涉及文件写入、Shell 执行的工具，在默认模式下须弹出用户确认（Permission Prompt）后才可执行
- 支持通过 `--allowedTools` 参数或配置文件预批准特定工具，跳过逐次确认
- `Bash` 工具须支持超时配置，防止长时间挂起

---

### 3.3 MCP 外部工具接入

Claude Code 通过 **Model Context Protocol（MCP）** 这一开放标准与外部工具集成，使其能连接到数百个第三方服务（数据库、项目管理、设计工具、云服务等）。

#### 3.3.1 传输协议支持

系统须支持以下三种 MCP 传输方式：

| 传输类型 | 适用场景 | 配置关键字 |
|---------|---------|---------|
| **HTTP**（推荐） | 连接远程云端 MCP 服务（如 Notion、Asana） | `--transport http` |
| **stdio** | 连接本地进程型 MCP 服务（如 npx 启动的工具包） | `--transport stdio` |
| **SSE**（已废弃） | 旧版 Server-Sent Events 连接（向后兼容） | `--transport sse` |

> ⚠️ SSE 传输协议已废弃，新集成应优先使用 HTTP。系统须保留 SSE 支持以兼容存量部署，并在使用 SSE 时提示迁移建议。

#### 3.3.2 配置管理

**CLI 配置命令：**

系统须提供 `claude mcp` 子命令族，支持增删查改 MCP 服务器配置：

```bash
# 添加 HTTP 类型服务器
claude mcp add --transport http <name> <url>

# 添加 stdio 类型服务器（选项必须在 server name 之前，-- 之后为命令）
claude mcp add --transport stdio [--env KEY=VALUE] <name> -- <command> [args...]

# 列出已配置的服务器
claude mcp list

# 删除服务器
claude mcp remove <name>

# 查看服务器状态（Claude Code 内部命令）
/mcp
```

**配置文件：**

系统须支持通过配置文件管理 MCP 服务器，以支持版本控制和团队共享：

- **用户全局配置**：`~/.claude.json` → `mcpServers` 字段，跨项目生效
- **项目级配置**：`.mcp.json`（项目根目录），随代码库分发，与团队共享
- **企业管控配置**：`managed-mcp.json`（由管理员通过策略下发），用户不可修改

配置层级优先级：企业管控 > 用户全局 > 项目级。

**配置格式示例（`.mcp.json`）：**

```json
{
  "mcpServers": {
    "notion": {
      "type": "http",
      "url": "https://mcp.notion.com/mcp",
      "headers": {
        "Authorization": "Bearer <token>"
      }
    },
    "airtable": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "airtable-mcp-server"],
      "env": {
        "AIRTABLE_API_KEY": "<key>"
      }
    }
  }
}
```

**配置范围（Scope）：**

MCP 服务器配置须支持三种作用域：

| 范围 | 说明 |
|-----|-----|
| `local`（默认） | 仅当前项目生效，写入项目级 `.mcp.json` |
| `user` | 用户全局生效，写入 `~/.claude.json` |
| `project` | 同 local，但显式标记为项目范围供团队使用 |

#### 3.3.3 工具搜索（Tool Search）

当配置了大量 MCP 工具时，工具定义会占用大量 Context Window，影响模型效果。系统须提供**按需动态加载（Tool Search）**机制：

- 默认开启 `auto` 模式：当 MCP 工具定义超过 Context Window 的 10% 时自动触发工具搜索
- 支持 `defer_loading: true` 配置，将特定工具集设置为懒加载，仅在需要时拉取工具描述
- 支持正则或语义搜索方式检索可用工具

---

### 3.4 SDK 自定义工具（Custom Tools）

面向通过 Agent SDK 将 Claude Code 嵌入应用的开发者，系统须支持**以编程方式在进程内定义和注册自定义工具**，无需启动独立 MCP 服务器进程。

#### 核心 API

**Python SDK：**

```python
from claude_agent_sdk import tool, create_sdk_mcp_server

@tool("get_exchange_rate", "获取两种货币的实时汇率", {
    "base": str,
    "target": str
})
async def get_exchange_rate(args):
    # 实现逻辑
    return {"content": [{"type": "text", "text": f"1 {args['base']} = ..."}]}

server = create_sdk_mcp_server(
    name="finance-tools",
    version="1.0.0",
    tools=[get_exchange_rate]
)
```

**TypeScript/JavaScript SDK：**

```typescript
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const customServer = createSdkMcpServer({
  name: "my-tools",
  version: "1.0.0",
  tools: [
    tool(
      "calculate",
      "执行数学计算",
      { expression: z.string().describe("数学表达式") },
      async (args) => ({
        content: [{ type: "text", text: String(eval(args.expression)) }]
      })
    )
  ]
});
```

#### 功能需求

- 支持同时混用 SDK 内置工具服务器（in-process）和外部 MCP 服务器（subprocess）
- `@tool` 装饰器 / `tool()` 函数须支持使用 Zod（TS）或 Python 类型注解定义参数 Schema，自动生成 JSON Schema
- 工具函数须支持同步和异步两种实现方式
- 须提供标准化错误返回格式，错误信息应包含描述性文本，便于模型理解和重试
- 工具注册后对模型不可见，需通过 `allowedTools` 配置显式允许后方可被调用

---

### 3.5 工具权限控制

权限控制是 Tools 功能的安全核心，须提供从粗粒度到细粒度的多层控制机制。

#### 3.5.1 权限模式

| 模式 | 描述 | 适用场景 |
|-----|-----|---------|
| `default` | 危险操作逐次弹出确认提示 | 交互式终端使用 |
| `acceptEdits` | 自动批准文件读写操作，其余仍需确认 | 半自动化场景 |
| `bypassPermissions` | 绕过所有权限提示，全自动执行 | 受信任的 CI/CD 或沙箱环境 |

> ⚠️ `bypassPermissions` 模式须在安全隔离环境中使用，须配合沙箱或容器部署。系统须在启用此模式时输出明确警告。

#### 3.5.2 工具白名单（allowedTools）

- 支持通过 `--allowedTools` CLI 参数或 SDK `options.allowedTools` 字段指定允许调用的工具列表
- 工具名称格式为 `mcp__<server-name>__<tool-name>`（MCP 工具）或直接工具名（内置工具）
- 支持通配符匹配，例如 `mcp__github__*` 允许指定服务器的所有工具

#### 3.5.3 企业策略控制

企业管理员须能通过策略文件控制用户可接入的 MCP 服务器范围：

- **允许列表（allowlist）**：仅允许指定服务器、命令或 URL 模式
- **禁止列表（denylist）**：禁止特定服务器、命令或 URL 模式
- 每条策略条目须通过 `serverName`、`serverCommand` 或 `serverUrl`（支持通配符）三选一进行匹配
- 策略强制执行，用户无法在受管设备上覆盖

---

### 3.6 Hooks 机制

Hooks 是在工具调用生命周期的特定节点插入自定义逻辑的机制，由宿主应用（而非模型）触发执行，用于实现确定性的前置检查、审计日志、后置处理等需求。

#### 支持的 Hook 事件

| Hook 事件 | 触发时机 | 典型用途 |
|---------|---------|---------|
| `PreToolUse` | 工具调用执行前 | 命令合规性检查、敏感数据过滤、调用拦截 |
| `PostToolUse` | 工具调用执行后 | 结果审计、日志记录、结果后处理 |

#### 功能需求

- Hook 函数须能返回 `permissionDecision: "deny"` 阻止工具调用，并附带拒绝原因
- 支持通过 `HookMatcher` 指定 Hook 仅对特定工具生效
- Hook 函数须能访问工具名称、工具输入参数和上下文信息
- Hook 执行异常不应导致主流程崩溃，须有兜底错误处理

---

## 4. 非功能性需求

### 4.1 性能

| 指标 | 要求 |
|-----|-----|
| SDK 内置工具（in-process）调用延迟 | 较外部 MCP 进程通信延迟降低 ≥50% |
| MCP 服务器连接超时默认值 | 60 秒，可配置 |
| 工具搜索触发阈值 | Context Window 使用率超过 10% 时自动启用 |
| 并发工具调用 | 支持在一次 Agent Loop 中并行调用多个工具 |

### 4.2 安全性

- 所有通过 HTTP 传输的 MCP 连接须支持 Bearer Token 或自定义 Header 认证
- 企业管控策略须在客户端强制执行，不依赖服务端校验
- `bypassPermissions` 模式须有沙箱隔离建议，并在文档中注明风险
- 工具调用结果中不得自动回传敏感 Env 变量内容

### 4.3 可用性与可观测性

- 须提供 `/mcp` 命令实时查看所有 MCP 服务器的连接状态
- MCP 服务器启动失败须给出明确错误信息（包含失败原因和排查建议）
- SDK 须提供工具调用的 token 消耗统计接口
- 支持通过 Claude Code Analytics API 获取工具调用的聚合数据

### 4.4 兼容性

- 支持 macOS、Linux、Windows（WSL）平台
- Python SDK 须与 Python 3.8+ 兼容
- Node.js SDK 须与 Node.js 18+ 兼容
- 向后兼容 SSE 传输协议（保留至下一个主版本）

---

## 5. 配置与部署架构

```
┌─────────────────────────────────────────────────────┐
│                   Claude Code CLI / SDK              │
│                                                     │
│  ┌─────────────┐  ┌───────────────┐  ┌───────────┐ │
│  │ Built-in    │  │  SDK Custom   │  │  Hooks    │ │
│  │ Tools       │  │  Tools        │  │  Engine   │ │
│  │ (Read/Write │  │  (in-process  │  │ (Pre/Post │ │
│  │  Bash/Web…) │  │   MCP Server) │  │  ToolUse) │ │
│  └─────────────┘  └───────────────┘  └───────────┘ │
│                          │                          │
│              ┌───────────▼───────────┐              │
│              │   MCP Client Layer    │              │
│              │  (Tool Search / ACL)  │              │
│              └───────────┬───────────┘              │
└──────────────────────────┼──────────────────────────┘
                           │
        ┌──────────────────┼──────────────────┐
        │                  │                  │
   ┌────▼─────┐    ┌───────▼──────┐   ┌──────▼──────┐
   │ HTTP MCP │    │  stdio MCP   │   │  SSE MCP    │
   │ Server   │    │  Server      │   │  Server     │
   │(Notion,  │    │(Local Tools, │   │(Legacy)     │
   │ Asana…)  │    │ GitHub CLI…) │   │             │
   └──────────┘    └──────────────┘   └─────────────┘
```

---

## 6. 开放问题与待决策项

| 编号 | 问题描述 | 优先级 | 负责人 |
|-----|---------|-------|-------|
| Q1 | SDK MCP Server 是否支持跨进程共享（多个 Agent 实例复用同一工具服务器）？ | 高 | 架构组 |
| Q2 | 工具调用失败时，模型的重试策略是否需要产品层面配置？（当前为模型自主决策） | 中 | PM + 模型团队 |
| Q3 | 企业策略文件的下发和同步机制是否需要与 MDM/企业配置管理平台集成？ | 高 | 企业产品 |
| Q4 | Tool Search 的语义搜索实现是否需要本地 Embedding 模型支持，还是调用 API？ | 中 | 工程 |
| Q5 | SSE 传输协议的弃用时间线和用户迁移通知策略 | 低 | PM |

---

## 7. 成功指标（Metrics）

| 指标 | 定义 | 目标值 |
|-----|-----|-------|
| MCP 工具连接成功率 | 配置后首次连接成功的比例 | ≥ 95% |
| 工具调用延迟 P95 | 从模型决策调用到工具返回结果的端到端耗时 | ≤ 2s（in-process），≤ 5s（external） |
| 权限拒绝率 | 因权限控制被拦截的工具调用比例 | 监控基线，不设硬指标 |
| 开发者工具配置完成率 | 开始配置 MCP 服务器后成功完成配置的用户比例 | ≥ 80% |
| SDK 自定义工具采用率 | 使用 SDK 注册自定义工具的 API 开发者占比 | 季度增长 ≥ 20% |

---

## 8. 参考资料

- [Claude Code MCP 文档](https://code.claude.com/docs/en/mcp)
- [Claude Agent SDK Custom Tools 指南](https://platform.claude.com/docs/en/agent-sdk/custom-tools)
- [MCP 官方规范](https://modelcontextprotocol.io)
- [claude-agent-sdk-python GitHub](https://github.com/anthropics/claude-agent-sdk-python)
- [Claude Code Analytics API](https://docs.claude.com)
