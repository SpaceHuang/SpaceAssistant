# AgentRunHost 详细设计

> 状态：草案
> 日期：2026-07-23
> 依赖：[builtin-subagent-design-conclusions.md](./builtin-subagent-design-conclusions.md)
> 协议：[ACP v1](https://agentclientprotocol.com)

---

## 1. 概述

AgentRunHost 是主进程侧组件，负责管理一个 AgentRun 的完整生命周期。它通过 ACP（JSON-RPC 2.0 over stdio）与 Agent 子进程（builtin / Codex）通信，对上层（Mission 调度器）暴露统一的 AgentRun 生命周期接口。

**核心原则：** AgentRunHost 不区分后端。builtin 和 Codex 走完全相同的代码路径。

---

## 2. 架构位置

```
Mission 调度器
    │
    ▼
AgentRunHost  ←── 本设计
    │
    ├── ACP Transport (JSON-RPC 2.0 over stdio)
    │       │
    │       ├── builtin-agent 子进程
    │       └── Codex CLI（薄适配到 ACP）
    │
    ├── LLMProxy           # 处理 _llm/chat 请求
    ├── ToolExecutor       # 处理 fs/* / terminal/* 请求
    ├── PermissionHandler  # 处理 session/request_permission
    ├── CheckpointInjector # 注入 checkpoint 提示
    ├── StuckDetector      # 僵局检测
    └── EventPersister     # 持久化 RunSnapshot / ProgressNote
```

---

## 3. 生命周期

### 3.1 状态机

```
queued → starting → running
                      ├→ waiting（用户决策）
                      │    ├→ running（宽限期内回复）
                      │    └→ parking → parked → running（新 AgentRun 恢复）
                      ├→ crashed → recovering（新 AgentRun）→ running
                      ├→ submitting → reviewing → completed
                      ├→ failed
                      └→ cancelling → cancelled
```

与 v3 §7.2 完全一致，无需修改。

### 3.2 启动流程

```
1. 调度器创建 AgentRun（status: queued, generation: N）
2. AgentRunHost.start(run)
   ├── 创建私有 worktree（WorktreeManager）
   ├── 生成输入文件（mission.md / context.json）
   ├── spawn Agent 子进程
   │   ├── builtin: fork(agentPath, [], { stdio: ['pipe','pipe','pipe'] })
   │   └── Codex: spawnCommand('codex', ['app-server', '--listen', 'stdio://'])
   ├── 建立 ACP 连接
   │   ├── 发送 initialize（protocolVersion: 1, clientCapabilities: {...}）
   │   ├── 接收 initialize 响应（agentCapabilities: {...}）
   │   ├── 发送 session/new（cwd: worktree 路径, contextWindow: 模型上下文窗口大小, mcpServers: []）
   │   └── 接收 session/new 响应（sessionId）
   ├── 发送 session/prompt（注入 Mission 目标 + 上下文）
   ├── AgentRun 状态 → running
   └── 进入事件循环
```

### 3.3 事件循环

```
while AgentRun 处于 running:
    ├── 收到 Agent 的 session/update notification
    │   ├── agent_message_chunk → 推送 UI，持久化 ProgressNote
    │   ├── tool_call（status: pending）→ 记录
    │   ├── tool_call_update（status: in_progress/completed/failed）→ 更新
    │   ├── plan → 记录（非权威）
    │   └── usage_update → 更新预算消耗
    │
    ├── 收到 Agent 的 Client 方法调用
    │   ├── _llm/chat → LLMProxy 处理
    │   ├── fs/read_text_file → ToolExecutor 处理
    │   ├── fs/write_text_file → ToolExecutor 处理
    │   ├── terminal/create → ToolExecutor 处理
    │   ├── terminal/kill → ToolExecutor 处理
    │   ├── terminal/output → ToolExecutor 处理
    │   └── session/request_permission → PermissionHandler 处理
    │
    ├── CheckpointInjector 检查是否需要注入
    ├── StuckDetector 检查僵局信号
    └── 预算超限检查
```

### 3.4 终止

```
session/prompt 收到响应（stopReason）:
    ├── end_turn → AgentRun → submitting → 扫描 worktree → Candidate
    ├── max_tokens / refusal → AgentRun → failed
    └── cancelled → AgentRun → cancelling → cancelled

取消流程:
    1. 宿主发送 session/cancel notification
    2. 宿主预标记所有 pending tool_call 为 cancelled
    3. 宿主响应所有 pending request_permission 为 cancelled
    4. 等待子进程退出（killProcessTree 兜底）
    5. AgentRun 标记 finishedAt + resourcesReleasedAt
    6. 状态 → cancelled
```

---

## 4. ACP Transport

### 4.1 职责

- 管理 stdin/stdout 管道
- 发送 JSON-RPC 请求/通知
- 接收 JSON-RPC 请求/通知/响应
- 分配请求 ID
- 匹配响应与请求

### 4.2 接口

```ts
interface AcpTransport {
  // 发送请求，返回 Promise<结果>
  request(method: string, params?: Record<string, unknown>): Promise<unknown>
  
  // 发送通知（无响应）
  notify(method: string, params?: Record<string, unknown>): void
  
  // 注册 Client 方法处理器（Agent 调用 Client 的方法）
  onRequest(method: string, handler: (params: unknown) => Promise<unknown>): void
  
  // 注册通知处理器（Agent 发来的通知）
  onNotification(method: string, handler: (params: unknown) => void): void
  
  // 关闭
  close(): void
}
```

### 4.3 实现

```ts
// electron/subagent/host/acpTransport.ts

export function createAcpTransport(
  stdin: NodeJS.ReadableStream,
  stdout: NodeJS.WritableStream
): AcpTransport {
  // 行分隔 JSON-RPC 2.0
  // 每行一个 JSON 对象：{ jsonrpc: "2.0", id?, method?, params?, result?, error? }
  
  const pendingRequests = new Map<number, { resolve, reject }>()
  let nextId = 1
  const requestHandlers = new Map<string, (params: unknown) => Promise<unknown>>()
  const notificationHandlers = new Map<string, (params: unknown) => void>()
  
  // 读取 stdout 行
  const rl = readline.createInterface({ input: stdin })
  rl.on('line', (line) => {
    const msg = JSON.parse(line)
    
    if ('method' in msg && 'id' in msg) {
      // Agent 发来的请求 → 调用注册的 handler
      const handler = requestHandlers.get(msg.method)
      if (!handler) {
        write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } })
        return
      }
      handler(msg.params).then(
        result => write({ jsonrpc: '2.0', id: msg.id, result }),
        error => write({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: error.message } })
      )
    } else if ('method' in msg) {
      // Agent 发来的通知
      const handler = notificationHandlers.get(msg.method)
      handler?.(msg.params)
    } else if ('id' in msg) {
      // 响应
      const pending = pendingRequests.get(msg.id)
      if (pending) {
        pendingRequests.delete(msg.id)
        if ('error' in msg) pending.reject(msg.error)
        else pending.resolve(msg.result)
      }
    }
  })
  
  function write(obj: unknown) {
    stdout.write(JSON.stringify(obj) + '\n')
  }
  
  return {
    request(method, params) {
      return new Promise((resolve, reject) => {
        const id = nextId++
        pendingRequests.set(id, { resolve, reject })
        write({ jsonrpc: '2.0', id, method, params })
      })
    },
    notify(method, params) {
      write({ jsonrpc: '2.0', method, params })
    },
    onRequest(method, handler) {
      requestHandlers.set(method, handler)
    },
    onNotification(method, handler) {
      notificationHandlers.set(method, handler)
    },
    close() {
      rl.close()
    }
  }
}
```

---

## 5. Client 能力宣告

### 5.1 initialize 请求

AgentRunHost 在启动时向 Agent 发送的 `initialize` 请求：

```json
{
  "jsonrpc": "2.0",
  "id": 0,
  "method": "initialize",
  "params": {
    "protocolVersion": 1,
    "clientCapabilities": {
      "fs": {
        "readTextFile": true,
        "writeTextFile": true
      },
      "terminal": true
    },
    "clientInfo": {
      "name": "spaceassistant",
      "title": "SpaceAssistant",
      "version": "1.0.0"
    },
    "_meta": {
      "spaceassistant.backend": "builtin"  // 或 "codex"
    }
  }
}
```

### 5.2 能力矩阵

| 能力 | builtin | Codex | 说明 |
|---|---|---|---|
| `fs.readTextFile` | ✅ | ✅ | 限定 worktree 内 |
| `fs.writeTextFile` | ✅ | ✅ | 限定 worktree 内 |
| `terminal` | ✅（沙箱化） | ✅（沙箱化） | 限定 worktree 内 |
| `_llm/chat` | ✅ | ❌ 不暴露 | 仅 builtin 可见 |
| `session/request_permission` | ✅ | ✅ | 复用确认卡片 |

### 5.3 后端身份门

`_llm/chat` 只对 builtin 后端注册。AgentRunHost 在 `start()` 时根据 `run.backend` 决定注册哪些 Client 方法：

```ts
// 所有后端通用
transport.onRequest('session/request_permission', handlePermission)
transport.onRequest('fs/read_text_file', handleReadFile)
transport.onRequest('fs/write_text_file', handleWriteFile)
transport.onRequest('terminal/create', handleTerminalCreate)
transport.onRequest('terminal/kill', handleTerminalKill)
transport.onRequest('terminal/output', handleTerminalOutput)

// 仅 builtin
if (run.backend === 'builtin') {
  transport.onRequest('_llm/chat', handleLlmChat)
}
```

---

## 6. LLMProxy（`_llm/chat` 处理）

### 6.1 职责

接收 builtin-agent 的 LLM 调用请求，用宿主持有的 API key 调用 Anthropic Messages API，流式返回结果。

### 6.2 请求格式

```ts
interface LlmChatRequest {
  sessionId: string
  model: string
  messages: AnthropicMessage[]
  system?: string
  tools?: AnthropicTool[]
  max_tokens: number
  thinking?: { type: 'enabled'; budget_tokens: number }
}
```

沿用 Anthropic Messages API 格式。宿主负责适配不同 LLM 后端。

### 6.3 响应方式

不通过 `_llm/chat` 的返回值返回。而是通过 `session/update` notification 流式推送，复用 ACP 已有语义：

```
Agent 发送: _llm/chat(request)
Host 开始流式推送:
  → session/update { sessionUpdate: "agent_message_chunk", messageId: "msg_001", content: { type: "text", text: "我来分析..." } }
  → session/update { sessionUpdate: "agent_message_chunk", messageId: "msg_001", content: { type: "text", text: "继续..." } }
  → session/update { sessionUpdate: "agent_message_chunk", messageId: "msg_001", content: { type: "tool_use", ... } }
  → ...（流式持续）
Host 响应: _llm/chat 的 result = { stopReason: "end_turn" }
```

**为什么用 notification 而不是返回值？** 因为 ACP 的返回值是一次性的，而 LLM 响应需要流式。`session/update` notification 是 ACP 的流式传输机制，语义匹配。

### 6.4 实现

```ts
async function handleLlmChat(params: LlmChatRequest): Promise<LlmChatResponse> {
  // 1. 校验：子进程存活、预算未超
  validateChildAlive()
  validateBudget()
  
  // 2. 调用 Anthropic API（复用现有 anthropicClientFactory）
  const stream = await anthropic.messages.stream({
    model: params.model || agentConfig.defaultModel,
    messages: params.messages,
    system: params.system,
    tools: params.tools,
    max_tokens: params.max_tokens,
    // thinking 按需启用
  })
  
  // 3. 流式推送
  let messageId = generateMessageId()
  for await (const event of stream) {
    if (event.type === 'content_block_delta') {
      transport.notify('session/update', {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId,
          content: {
            type: event.delta.type === 'text_delta' ? 'text' : 'tool_use',
            text: event.delta.text,
          }
        }
      })
    }
    // ... 其他事件类型
  }
  
  // 4. 返回最终结果
  const final = await stream.finalMessage()
  return {
    stopReason: final.stop_reason === 'end_turn' ? 'end_turn' : 'max_tokens',
    usage: { input: final.usage.input_tokens, output: final.usage.output_tokens }
  }
}
```

### 6.5 安全

| 检查项 | 实现 |
|---|---|
| 子进程存活 | `child.pid === expectedPid && !child.killed` |
| 预算未超 | `cumulativeUsage.toolCalls < maxToolCalls` |
| 预算更新 | 每次调用后更新 `RunUsage` |
| 取消信号 | 监听 `ctx.signal`，取消时 abort Anthropic 请求 |

---

## 7. ToolExecutor（`fs/*` / `terminal/*` 处理）

### 7.1 职责

接收 Agent 的工具执行请求，在私有 worktree 内执行，返回结果。

### 7.2 文件操作

```ts
// fs/read_text_file
async function handleReadFile(params: {
  sessionId: string
  path: string
  line?: number
  limit?: number
}): Promise<{ content: string }> {
  // 1. 路径校验：限定在 worktree 内
  const safePath = resolveSafePath(worktreePath, params.path)
  // 2. 读取文件
  const content = await fs.readFile(safePath, 'utf-8')
  // 3. 可选行范围截取
  return { content: applyLineRange(content, params.line, params.limit) }
}

// fs/write_text_file
async function handleWriteFile(params: {
  sessionId: string
  path: string
  content: string
}): Promise<null> {
  // 1. 路径校验
  const safePath = resolveSafePath(worktreePath, params.path)
  // 2. 写冲突校验
  await acquirePathLease(safePath)
  // 3. 写入文件
  await fs.writeFile(safePath, params.content, 'utf-8')
  // 4. 记录到 worktree 变更追踪
  trackWorktreeChange(safePath, 'write')
  return null
}
```

### 7.3 终端操作

```ts
// terminal/create
async function handleTerminalCreate(params: {
  sessionId: string
  command: string
  args?: string[]
  cwd?: string
}): Promise<{ terminalId: string }> {
  // 1. cwd 限定在 worktree 内
  const safeCwd = resolveSafePath(worktreePath, params.cwd || worktreePath)
  // 2. 创建终端
  const terminalId = generateTerminalId()
  const proc = spawnCommand(params.command, params.args, { cwd: safeCwd })
  terminals.set(terminalId, proc)
  return { terminalId }
}

// terminal/output
async function handleTerminalOutput(params: {
  sessionId: string
  terminalId: string
}): Promise<{ output: string; exitCode?: number }> {
  // 获取终端输出
}

// terminal/kill
async function handleTerminalKill(params: {
  sessionId: string
  terminalId: string
}): Promise<null> {
  const proc = terminals.get(params.terminalId)
  if (proc) await killProcessTree(proc)
  terminals.delete(params.terminalId)
  return null
}
```

### 7.4 安全边界

| 检查项 | 实现 |
|---|---|
| 路径限定 | `resolveSafePath(worktreePath, path)` — 拒绝 `..`、绝对路径逃逸、符号链接 |
| 保留根保护 | 拒绝写入 revision store、staging root、`.space-assistant/` 协议目录 |
| 写冲突 | 复用 `toolWriteConflict.ts` / `pathLeaseRegistry` |
| 终端沙箱 | 仅 worktree 内 `cwd`，不继承宿主环境变量中的敏感 key |
| 预算 | 每次读写计入 `RunUsage`，超限拒绝 |

---

## 8. PermissionHandler（`session/request_permission` 处理）

### 8.1 职责

接收 Agent 的工具授权请求，通过现有确认卡片机制获取用户决策，返回结果。

### 8.2 流程

```
Agent 发送: session/request_permission { toolCall: { toolCallId, title, kind }, options: [...] }
  → 宿主构造确认卡片 payload
  → 通过 toolConfirmRegistry 等待用户决策
  → 用户决策（allow_once / reject_once / allow_always / reject_always）
  → 宿主返回 { outcome: { outcome: "selected", optionId: "..." } }
  → 如需信任写入，更新 trust 列表
```

### 8.3 与现有确认机制的复用

```ts
async function handlePermission(params: PermissionRequest): Promise<PermissionResponse> {
  // 1. 构造确认请求
  const requestId = generateRequestId()
  const toolUseId = `${run.id}#sub:${params.toolCall.toolCallId}`
  
  // 2. 发送确认卡片（复用现有 IPC）
  sendConfirmRequest({
    requestId,
    toolUseId,
    toolName: params.toolCall.title,
    riskLevel: mapToolKindToRiskLevel(params.toolCall.kind),
    source: 'subagent',
    subagent: {
      dispatchId: run.id,
      agent: run.backend,
      kind: 'tool_approval'
    },
    options: params.options
  })
  
  // 3. 等待用户决策（复用 toolConfirmRegistry）
  const outcome = await waitForToolConfirm(requestId, toolUseId)
  
  // 4. 返回 ACP 格式
  if (outcome === 'timeout') {
    return { outcome: { outcome: 'cancelled' } }
  }
  return {
    outcome: {
      outcome: 'selected',
      optionId: outcome === 'approved' ? 'allow-once' : 'reject-once'
    }
  }
}
```

### 8.4 自动批准

当 `interactionMode === 'dedicated'` 或 Agent 配置为 `auto` 时，直接返回 `allow_once`，不弹确认卡片。但高危工具（`execute` 类 + 越界路径）仍强制确认。

---

## 9. CheckpointInjector

### 9.1 职责

按预算消耗向 Agent 注入 checkpoint 提示。这是一个宿主侧的主动行为，用于帮助 Agent 在长任务中保持方向感。

**注意：** 此机制对所有 Agent 后端（builtin / Codex）统一生效。Codex 默认关闭，可通过 `AgentRun.checkpointEnabled` 配置。

### 9.2 Mission 目标摘要（启动时）

在 `AgentRun` 启动时，宿主对 Mission 目标做一次轻量 LLM 摘要，将 goal + successCriteria + constraints + outputContract 压缩为 3-5 条可逐条对照的检查项，存入 `AgentRun.checkpointChecklist`：

```ts
// AgentRun 初始化时
run.checkpointChecklist = await summarizeMissionGoal(mission)
// 返回示例：
// [
//   "用户认证模块 + JWT 登录 — 是否完成？",
//   "单元测试覆盖率 > 80% — 是否达标？",
//   "API 文档更新 — 是否完成？"
// ]
```

摘要只做一次，后续每次 checkpoint 注入时直接引用，不重复调用 LLM。

### 9.3 触发条件

```ts
function shouldInjectCheckpoint(run: AgentRun): boolean {
  const usage = run.usage
  const checkpoints = run.checkpoints || []
  const lastCheckpoint = checkpoints[checkpoints.length - 1]
  
  // 工具调用比例：25%, 50%, 75%
  const toolCallRatio = usage.toolCalls / budget.maxToolCalls
  if (toolCallRatio >= 0.25 && !checkpoints.includes('tool_25')) return true
  if (toolCallRatio >= 0.50 && !checkpoints.includes('tool_50')) return true
  if (toolCallRatio >= 0.75 && !checkpoints.includes('tool_75')) return true
  
  // 时间比例：30%, 60%, 90%
  const elapsed = Date.now() - run.startedAt
  const timeRatio = elapsed / (budget.maxDurationMinutes * 60 * 1000)
  if (timeRatio >= 0.30 && !checkpoints.includes('time_30')) return true
  if (timeRatio >= 0.60 && !checkpoints.includes('time_60')) return true
  if (timeRatio >= 0.90 && !checkpoints.includes('time_90')) return true
  
  // 距上次 checkpoint 超过 30 分钟
  if (lastCheckpoint && Date.now() - lastCheckpoint.timestamp > 30 * 60 * 1000) return true
  
  return false
}
```

### 9.4 注入方式与内容

通过 `session/update` notification 注入，携带 Mission 目标检查清单：

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "sess_xxx",
    "update": {
      "sessionUpdate": "agent_message_chunk",
      "messageId": "sys_checkpoint_001",
      "content": {
        "type": "text",
        "text": "[系统提示] 进度检查点（此提示不需要使用工具回答）\n\n当前消耗：已用 52 次工具调用 / 18 分钟，占预算的 65%\n\n对照检查：\n1. 用户认证模块 + JWT 登录 — 是否完成？\n2. 单元测试覆盖率 > 80% — 是否达标？\n3. API 文档更新 — 是否完成？\n\n如有偏离请调整策略，如已阻塞请说明原因。"
      }
    }
  }
}
```

### 9.5 对 Codex 的处理

checkpoint 注入对 Codex 也可选启用。但 Codex 自我管理能力更强，默认关闭。可通过 `AgentRun.checkpointEnabled` 配置。

---

## 10. StuckDetector

### 10.1 职责

监控 Agent 的工具调用模式，检测僵局信号。只监控行为模式，不监控语义。

### 10.2 检测信号

```ts
interface StuckDetectorState {
  consecutiveFailures: number        // 连续工具调用失败次数
  fileEditCount: Map<string, number> // 每个路径的编辑次数
  recentToolSequence: string[]       // 最近 6 次工具调用名
  warnedAt?: number                  // 上次警告时间
}
```

| 信号 | 阈值 | 行为 |
|---|---|---|
| 连续工具调用失败 | ≥ 5 次 | 注入僵局警告 |
| 同一文件反复修改 | 同一路径 ≥ 8 次编辑 | 注入僵局警告 |
| 工具调用序列重复 | 相同 3 工具序列重复 ≥ 3 次 | 注入僵局警告 |
| 僵局警告后无改善 | 警告后 5 分钟内仍触发僵局 | AgentRun → waiting |

### 10.3 僵局警告

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "sess_xxx",
    "update": {
      "sessionUpdate": "agent_message_chunk",
      "messageId": "sys_stuck_001",
      "content": {
        "type": "text",
        "text": "[系统提示] 僵局警告\n\n检测到可能的执行僵局：连续 5 次工具调用失败\n\n请：\n1. 暂停当前操作，重新评估整体策略\n2. 如果当前路线不可行，请明确说明原因并尝试替代方案\n3. 如果无法自行解决，请请求用户决策"
      }
    }
  }
}
```

### 10.4 升级到 waiting

僵局警告后，5 分钟内仍有僵局信号 → AgentRun 进入 waiting。持久化 `MissionDecision`（kind: `missing_information`），通知用户。

---

## 11. EventPersister

### 11.1 职责

将 AgentRun 的执行过程持久化为 v3 的 `RunSnapshot` 和 `ProgressNote`。

### 11.2 RunSnapshot 更新

```ts
// 由事件消费者增量投影
function updateRunSnapshot(event: AcpEvent, snapshot: RunSnapshot): RunSnapshot {
  switch (event.type) {
    case 'tool_call':
      snapshot.lastTool = { name: event.title, status: 'running', startedAt: Date.now() }
      break
    case 'tool_call_update':
      if (event.status === 'completed') {
        snapshot.lastTool = { ...snapshot.lastTool, status: 'completed', completedAt: Date.now() }
      }
      break
    case 'usage_update':
      snapshot.usage = event.usage
      break
  }
  // worktree 变化由 WorktreeObserver 独立更新
  return snapshot
}
```

### 11.3 ProgressNote 生成

```ts
// 来源1：Codex 原生输出中的 best-effort 进展说明
// 来源2：事件摘要器（将最近事件 + worktree 变化 + 上一条 ProgressNote 交给摘要 LLM）
// 两者都标记 source 字段
function generateProgressNote(
  source: 'codex_output' | 'event_summarizer',
  events: AcpEvent[],
  previousNote?: ProgressNote
): ProgressNote {
  // ...
}
```

ProgressNote 不是正确性前提，缺失或错误不影响 AgentRun 状态。

---

## 12. AgentRun 完成与结果导入

### 12.1 正常完成

```
session/prompt 返回 stopReason: "end_turn"
  → AgentRun → submitting
  → 等待子进程退出
  → 扫描私有 worktree
  → 生成 CandidateSubmission
  → 执行确定性验证（command validators）
  → 按 ReviewPolicy 启动 Review
  → 完成
```

### 12.2 崩溃恢复

```
子进程异常退出
  → 检查旧容器是否存活 → 能接管则继续监控，否则 drain
  → 旧 Run 标记 crashed
  → 封存 RecoveryBundle
  → 创建新 AgentRun + MissionRecoveryContext
  → 启动恢复 Run
```

与 v3 §8.4 完全一致。

---

## 13. 与 v3 的集成点

| v3 组件 | AgentRunHost 集成方式 |
|---|---|
| `WorktreeManager` | AgentRunHost.start() 时创建私有 worktree |
| `CodexProcessHost` | 复用 `spawnUtil` 启动子进程 |
| `WorktreeObserver` | 周期性扫描 worktree 差异，更新 RunSnapshot |
| `HandoffImporter` | AgentRun 完成后扫描 handoff 目录，生成 Candidate |
| `FormalStatePublisher` | 执行 generation fencing 条件事务，发布 Candidate/Review/Deliverable |
| `RecoveryBundle` | 崩溃时封存，恢复时提供 MissionRecoveryContext |
| `RunSnapshot` | 由 EventPersister 增量维护 |
| `ProgressNote` | 由 EventPersister 生成 |
| `MissionDecision` | PermissionHandler 升级时创建 |

---

## 14. 文件清单

| 文件 | 说明 |
|---|---|
| `electron/subagent/host/agentRunHost.ts` | AgentRun 生命周期管理、事件循环 |
| `electron/subagent/host/acpTransport.ts` | JSON-RPC 2.0 over stdio 实现 |
| `electron/subagent/host/llmProxy.ts` | `_llm/chat` 处理 |
| `electron/subagent/host/toolExecutor.ts` | `fs/*` / `terminal/*` 处理 |
| `electron/subagent/host/permissionHandler.ts` | `session/request_permission` 处理 |
| `electron/subagent/host/checkpointInjector.ts` | Checkpoint 注入 |
| `electron/subagent/host/stuckDetector.ts` | 僵局检测 |
| `electron/subagent/host/eventPersister.ts` | RunSnapshot / ProgressNote 持久化 |
| `electron/subagent/acpTypes.ts` | ACP 协议类型定义 |

---

## 15. 测试策略

| 测试项 | 说明 |
|---|---|
| `acpTransport.test.ts` | 消息序列化/反序列化、请求响应匹配、method not found |
| `llmProxy.test.ts` | mock Anthropic 流式响应、流式推送、取消 |
| `toolExecutor.test.ts` | 路径校验、worktree 约束、写冲突 |
| `permissionHandler.test.ts` | 确认卡片流转、auto 模式、超时 |
| `checkpointInjector.test.ts` | 触发条件、注入格式 |
| `stuckDetector.test.ts` | 僵局信号检测、警告注入、升级到 waiting |
| `agentRunHost.test.ts` | 完整生命周期：启动 → 运行 → 完成 / 取消 / 崩溃 |