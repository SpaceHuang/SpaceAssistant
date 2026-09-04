# Builtin-Agent 子进程详细设计

> 状态：草案
> 日期：2026-07-23
> 依赖：[builtin-subagent-design-conclusions.md](./builtin-subagent-design-conclusions.md)
> 协议：[ACP v1](https://agentclientprotocol.com)

---

## 1. 概述

builtin-agent 是宿主主进程的**子进程**，通过 ACP（JSON-RPC 2.0 over stdio）与宿主通信。它是一个**薄推理循环**——只负责"思考→决定行动→观察结果"，不持有 API key，不执行任何工具，不访问文件系统。

**一句话：builtin-agent 是一个纯推理引擎，所有能力通过 RPC 向宿主借用。**

---

## 2. 架构位置

```
宿主主进程
    │
    ├── AgentRunHost
    │   ├── ACP Transport (stdin/stdout)
    │   │       │
    │   │       ▼
    │   │   builtin-agent 子进程  ←── 本设计
    │   │       │
    │   │       ├── acpTransport.ts   # JSON-RPC 2.0 Client 侧
    │   │       ├── agentLoop.ts      # 推理循环
    │   │       └── index.ts          # 入口
    │   │
    │   ├── LLMProxy
    │   ├── ToolExecutor
    │   └── ...
```

### 角色说明

在 ACP 协议中，Agent 和 Client 的**调用方向**是双向的：

| 方向 | builtin-agent 的角色 | 调用什么 |
|---|---|---|
| 宿主 → builtin | builtin 是 **Agent**（接收请求） | `initialize`、`session/new`、`session/prompt`、`session/cancel` |
| builtin → 宿主 | builtin 是 **Client**（发起请求） | `_llm/chat`、`fs/read_text_file`、`fs/write_text_file`、`terminal/*`、`session/request_permission` |
| builtin → 宿主 | builtin 是 **Agent**（发通知） | `session/update`（agent_message_chunk、tool_call、tool_call_update、plan、usage_update） |

**注意：builtin-agent 同时扮演 ACP 的 Agent 角色（接收宿主的 prompt）和 Client 角色（调用宿主的能力）。** 这是 ACP 协议设计的正常语义——Agent 调用 Client 提供的能力。

---

## 3. 目录结构

```
electron/subagent/builtin/
  index.ts              # 入口：初始化 ACP transport → 启动 agentLoop
  agentLoop.ts          # 推理循环：session/prompt → 推理 → 工具调用 → 循环
  acpTransport.ts       # JSON-RPC 2.0 Client 侧（调用宿主方法）
  agentTypes.ts         # 内部类型
```

**约束：** 这三个文件不 import 任何 Electron 模块，只依赖 Node.js 内置模块（`process`、`readline`、`fs/promises` 仅用于读取 worktree 路径配置）。

---

## 4. 入口（index.ts）

### 4.1 启动流程

```ts
// electron/subagent/builtin/index.ts

import { createAcpTransport } from './acpTransport'
import { startAgentLoop } from './agentLoop'

async function main() {
  // 1. 建立 ACP 连接（stdin/stdout）
  const transport = createAcpTransport(process.stdin, process.stdout)
  
  // 2. 等待宿主 initialize
  const initResult = await transport.waitForInitialize()
  
  // 3. 等待宿主 session/new
  const sessionResult = await transport.waitForSessionNew()
  
  // 4. 进入推理循环
  await startAgentLoop(transport, sessionResult.sessionId)
}

main().catch((err) => {
  console.error('Builtin agent fatal error:', err)
  process.exit(1)
})
```

### 4.2 不需要的内容

| 不需要 | 原因 |
|---|---|
| 配置文件读取 | 所有配置通过 `initialize` 和 `session/new` 传入 |
| API key 管理 | 通过 `_llm/chat` 借用宿主 |
| 工具注册 | 通过 `fs/*` / `terminal/*` 借用宿主 |
| 持久化 | 宿主负责 |
| 取消信号处理 | 宿主通过 `session/cancel` 通知，子进程接收后停止 |

---

## 5. ACP Transport（acpTransport.ts）

### 5.1 职责

- 管理 stdin/stdout 管道
- 发送 JSON-RPC 请求/通知给宿主
- 接收宿主的 JSON-RPC 请求/通知/响应
- 匹配响应与请求
- 等待 `initialize` 和 `session/new`

### 5.2 实现

```ts
// electron/subagent/builtin/acpTransport.ts

interface AcpClientTransport {
  // 发送请求给宿主（builtin 作为 Client 调用宿主能力）
  request(method: string, params?: Record<string, unknown>): Promise<unknown>
  
  // 发送通知给宿主（builtin 作为 Agent 推送进度）
  notify(method: string, params?: Record<string, unknown>): void
  
  // 等待宿主的请求（builtin 作为 Agent 接收宿主指令）
  // 返回 Promise，在收到指定 method 的请求时 resolve
  waitForRequest(method: string): Promise<{ id: number; params: unknown }>
  
  // 响应宿主请求
  respond(id: number, result: unknown): void
  respondError(id: number, code: number, message: string): void
  
  // 注册通知处理器
  onNotification(method: string, handler: (params: unknown) => void): void
  
  // 关闭
  close(): void
}

export function createAcpTransport(
  stdin: NodeJS.ReadableStream,
  stdout: NodeJS.WritableStream
): AcpClientTransport {
  const pendingRequests = new Map<number, { resolve, reject }>()
  const requestWaiters = new Map<string, Array<{ resolve, reject }>>()
  const notificationHandlers = new Map<string, (params: unknown) => void>()
  let nextId = 1
  
  const rl = readline.createInterface({ input: stdin })
  
  rl.on('line', (line: string) => {
    if (!line.trim()) return
    
    let msg: JsonRpcMessage
    try {
      msg = JSON.parse(line)
    } catch {
      return // 忽略无效 JSON
    }
    
    if ('method' in msg && 'id' in msg) {
      // 宿主发来的请求 → 检查是否有 waiter
      const waiters = requestWaiters.get(msg.method)
      if (waiters && waiters.length > 0) {
        const waiter = waiters.shift()!
        waiter.resolve({ id: msg.id, params: msg.params || {} })
      } else {
        // 没有 waiter，返回 method not found
        write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } })
      }
    } else if ('method' in msg) {
      // 宿主发来的通知
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
    const line = JSON.stringify(obj)
    stdout.write(line + '\n')
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
    
    waitForRequest(method) {
      return new Promise((resolve, reject) => {
        if (!requestWaiters.has(method)) {
          requestWaiters.set(method, [])
        }
        requestWaiters.get(method)!.push({ resolve, reject })
      })
    },
    
    respond(id, result) {
      write({ jsonrpc: '2.0', id, result })
    },
    
    respondError(id, code, message) {
      write({ jsonrpc: '2.0', id, error: { code, message } })
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

### 5.3 便捷方法

```ts
// 在 transport 上封装便捷方法

export async function waitForInitialize(transport: AcpClientTransport): Promise<{
  protocolVersion: number
  clientCapabilities: Record<string, unknown>
  clientInfo: { name: string; title: string; version: string }
}> {
  const req = await transport.waitForRequest('initialize')
  const result = req.params as any
  transport.respond(req.id, {
    protocolVersion: result.protocolVersion,
    agentCapabilities: {
      loadSession: false,
      promptCapabilities: {
        image: false,
        audio: false,
        embeddedContext: true
      },
      mcpCapabilities: {
        http: false,
        sse: false
      }
    },
    agentInfo: {
      name: 'builtin',
      title: 'SpaceAssistant Builtin Agent',
      version: '1.0.0'
    },
    authMethods: []
  })
  return result
}

export async function waitForSessionNew(transport: AcpClientTransport): Promise<{
  sessionId: string
  cwd: string
  contextWindow: number
}> {
  const req = await transport.waitForRequest('session/new')
  const params = req.params as any
  transport.respond(req.id, { sessionId: `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}` })
  return {
    sessionId: (req.params as any)?.sessionId || 'sess_default',
    cwd: params.cwd,
    contextWindow: params.contextWindow || 200000
  }
}
```

---

## 6. 推理循环（agentLoop.ts）

### 6.1 核心流程

这是 builtin-agent 的核心——一个纯粹的推理循环：

```
session/prompt 收到用户消息
  ↓
[1] 构建 messages 数组（system prompt + 历史 + 当前用户消息）
  ↓
[2] 调用 _llm/chat → 宿主代为调用 LLM → 流式推送 session/update
  ↓
[3] LLM 返回结果
  ├── 有 tool_calls → 执行工具（通过 fs/* / terminal/*）→ 回到 [1]
  └── 无 tool_calls → 响应 session/prompt（stopReason: end_turn）
```

### 6.2 实现

```ts
// electron/subagent/builtin/agentLoop.ts

import type { AcpClientTransport } from './acpTransport'
import { waitForInitialize, waitForSessionNew } from './acpTransport'

interface AgentLoopState {
  sessionId: string
  cwd: string
  contextWindow: number
  messages: AnthropicMessage[]
  systemPrompt: string
  model: string
  maxTokens: number
  thinkingBudget: number
  tools: AnthropicTool[]
  cancelled: boolean
  consecutiveFailures: number
  missionConstraints: string  // 全局约束持久化
}

export async function startAgentLoop(
  transport: AcpClientTransport,
  sessionId: string
): Promise<void> {
  const state: AgentLoopState = {
    sessionId,
    cwd: '',
    contextWindow: 200000,
    messages: [],
    systemPrompt: '',
    model: 'claude-sonnet-4-20250514',
    maxTokens: 16000,
    thinkingBudget: 4000,
    tools: [],
    cancelled: false,
    consecutiveFailures: 0,
    missionConstraints: ''
  }
  
  // 注册取消处理器
  transport.onNotification('session/cancel', () => {
    state.cancelled = true
  })
  
  // 主循环：等待 session/prompt
  while (!state.cancelled) {
    // 等待下一个 prompt
    const promptReq = await transport.waitForRequest('session/prompt')
    const promptParams = promptReq.params as any
    
    if (state.cancelled) {
      transport.respond(promptReq.id, { stopReason: 'cancelled' })
      break
    }
    
    // 提取 prompt 内容
    const promptBlocks = promptParams.prompt || []
    const userMessage = extractUserMessage(promptBlocks)
    
    // 处理可能的配置更新
    if (promptParams.model) state.model = promptParams.model
    if (promptParams.maxTokens) state.maxTokens = promptParams.maxTokens
    
    // 添加用户消息到历史
    state.messages.push({ role: 'user', content: userMessage })
    
    try {
      // 执行推理 → 工具调用循环
      await runInferenceLoop(transport, state, promptReq.id)
    } catch (err) {
      transport.respond(promptReq.id, {
        stopReason: 'refusal'
      })
    }
  }
}

async function runInferenceLoop(
  transport: AcpClientTransport,
  state: AgentLoopState,
  promptRequestId: number
): Promise<void> {
  let turnCount = 0
  const maxTurns = 50 // 防止无限循环
  
  while (turnCount < maxTurns && !state.cancelled) {
    turnCount++
    
    // 1. 调用 LLM
    const llmResponse = await callLlm(transport, state)
    
    if (state.cancelled) {
      transport.respond(promptRequestId, { stopReason: 'cancelled' })
      return
    }
    
    // 2. 检查是否有 tool_calls
    const toolCalls = extractToolCalls(llmResponse)
    
    if (toolCalls.length === 0) {
      // 没有工具调用 → 对话结束
      transport.respond(promptRequestId, { stopReason: 'end_turn' })
      return
    }
    
    // 3. 执行工具调用
    const toolResults = await executeTools(transport, state, toolCalls)
    
    if (state.cancelled) {
      transport.respond(promptRequestId, { stopReason: 'cancelled' })
      return
    }
    
    // 4. 将 assistant 消息和工具结果加入历史
    state.messages.push({
      role: 'assistant',
      content: toolCalls
    })
    state.messages.push({
      role: 'user',
      content: toolResults
    })
  }
  
  // 超过最大轮次
  transport.respond(promptRequestId, { stopReason: 'max_turn_requests' })
}
```

### 6.3 LLM 调用

```ts
async function callLlm(
  transport: AcpClientTransport,
  state: AgentLoopState
): Promise<AnthropicMessage> {
  // 通过 _llm/chat 借用宿主 LLM 能力
  const result = await transport.request('_llm/chat', {
    sessionId: state.sessionId,
    model: state.model,
    messages: state.messages,
    system: state.systemPrompt,
    tools: state.tools,
    max_tokens: state.maxTokens,
    ...(state.thinkingBudget > 0 ? {
      thinking: { type: 'enabled', budget_tokens: state.thinkingBudget }
    } : {})
  }) as LlmChatResponse
  
  return result.message
}
```

**注意：** `_llm/chat` 的响应由宿主通过 `session/update` notification 流式推送。builtin-agent 不需要额外处理流式推送——宿主已经做了。`_llm/chat` 的返回值只包含最终的 `message` 和 `stopReason`。

### 6.4 工具执行

```ts
interface PendingToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}

async function executeTools(
  transport: AcpClientTransport,
  state: AgentLoopState,
  toolCalls: PendingToolCall[]
): Promise<AnthropicToolResult[]> {
  const results: AnthropicToolResult[] = []
  
  for (const tc of toolCalls) {
    // 1. 通知宿主：tool_call pending
    transport.notify('session/update', {
      sessionId: state.sessionId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: tc.id,
        title: tc.name,
        kind: mapToolNameToKind(tc.name),
        status: 'pending',
        rawInput: tc.input
      }
    })
    
    // 2. 请求权限（如果需要）
    const permissionNeeded = shouldRequestPermission(tc.name, tc.input)
    if (permissionNeeded) {
      const permission = await transport.request('session/request_permission', {
        sessionId: state.sessionId,
        toolCall: {
          toolCallId: tc.id,
          title: tc.name,
          kind: mapToolNameToKind(tc.name)
        },
        options: [
          { optionId: 'allow-once', name: '允许一次', kind: 'allow_once' },
          { optionId: 'reject-once', name: '拒绝', kind: 'reject_once' }
        ]
      }) as PermissionResponse
      
      const outcome = permission.outcome as any
      if (outcome.outcome === 'cancelled' || outcome.optionId === 'reject-once') {
        // 权限被拒绝
        transport.notify('session/update', {
          sessionId: state.sessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: tc.id,
            status: 'failed'
          }
        })
        results.push({
          tool_use_id: tc.id,
          type: 'tool_result',
          content: '用户拒绝了此操作'
        })
        continue
      }
    }
    
    // 3. 执行工具
    transport.notify('session/update', {
      sessionId: state.sessionId,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: tc.id,
        status: 'in_progress'
      }
    })
    
    try {
      const result = await callToolOnHost(transport, state, tc)
      
      transport.notify('session/update', {
        sessionId: state.sessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: tc.id,
          status: 'completed',
          content: result
        }
      })
      
      results.push({
        tool_use_id: tc.id,
        type: 'tool_result',
        content: result
      })
    } catch (err) {
      transport.notify('session/update', {
        sessionId: state.sessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: tc.id,
          status: 'failed'
        }
      })
      
      results.push({
        tool_use_id: tc.id,
        type: 'tool_result',
        content: `工具执行失败: ${err instanceof Error ? err.message : String(err)}`,
        is_error: true
      })
    }
  }
  
  return results
}

async function callToolOnHost(
  transport: AcpClientTransport,
  state: AgentLoopState,
  tc: PendingToolCall
): Promise<string> {
  switch (tc.name) {
    // 文件操作
    case 'read_file':
    case 'read_text_file': {
      const result = await transport.request('fs/read_text_file', {
        sessionId: state.sessionId,
        path: tc.input.file_path || tc.input.path,
        ...(tc.input.offset ? { line: tc.input.offset } : {}),
        ...(tc.input.limit ? { limit: tc.input.limit } : {})
      }) as { content: string }
      return result.content
    }
    
    case 'write_file':
    case 'write_text_file': {
      await transport.request('fs/write_text_file', {
        sessionId: state.sessionId,
        path: tc.input.file_path || tc.input.path,
        content: tc.input.content
      })
      return '文件写入成功'
    }
    
    case 'edit_file': {
      // edit_file 需要先读取再写入
      const readResult = await transport.request('fs/read_text_file', {
        sessionId: state.sessionId,
        path: tc.input.file_path || tc.input.path
      }) as { content: string }
      
      const newContent = applyEdit(readResult.content, tc.input.old_string, tc.input.new_string)
      
      await transport.request('fs/write_text_file', {
        sessionId: state.sessionId,
        path: tc.input.file_path || tc.input.path,
        content: newContent
      })
      return '文件编辑成功'
    }
    
    // 终端操作
    case 'execute_command':
    case 'run_shell': {
      const termResult = await transport.request('terminal/create', {
        sessionId: state.sessionId,
        command: tc.input.command,
        args: tc.input.args || [],
        cwd: tc.input.cwd || state.cwd
      }) as { terminalId: string }
      
      const outputResult = await transport.request('terminal/output', {
        sessionId: state.sessionId,
        terminalId: termResult.terminalId
      }) as { output: string; exitCode?: number }
      
      await transport.request('terminal/kill', {
        sessionId: state.sessionId,
        terminalId: termResult.terminalId
      })
      
      return outputResult.output
    }
    
    // 搜索
    case 'search_content':
    case 'grep': {
      // 通过 terminal 执行 grep
      const termResult = await transport.request('terminal/create', {
        sessionId: state.sessionId,
        command: 'grep',
        args: ['-rn', tc.input.pattern, tc.input.directory || '.'],
        cwd: state.cwd
      }) as { terminalId: string }
      
      const outputResult = await transport.request('terminal/output', {
        sessionId: state.sessionId,
        terminalId: termResult.terminalId
      }) as { output: string }
      
      await transport.request('terminal/kill', {
        sessionId: state.sessionId,
        terminalId: termResult.terminalId
      })
      
      return outputResult.output
    }
    
    // 目录列表
    case 'list_directory':
    case 'list_files': {
      const termResult = await transport.request('terminal/create', {
        sessionId: state.sessionId,
        command: 'ls',
        args: ['-la', tc.input.path || '.'],
        cwd: tc.input.path ? state.cwd : state.cwd
      }) as { terminalId: string }
      
      const outputResult = await transport.request('terminal/output', {
        sessionId: state.sessionId,
        terminalId: termResult.terminalId
      }) as { output: string }
      
      await transport.request('terminal/kill', {
        sessionId: state.sessionId,
        terminalId: termResult.terminalId
      })
      
      return outputResult.output
    }
    
    default:
      throw new Error(`未知工具: ${tc.name}`)
  }
}
```

### 6.5 工具名称映射

builtin-agent 内部使用 SpaceAssistant 的**内置工具名**（`read_file`、`write_file`、`edit_file`、`grep`、`list_directory`、`run_shell` 等），在调用宿主时映射到 ACP 方法：

| 内置工具名 | ACP 方法 | 说明 |
|---|---|---|
| `read_file` | `fs/read_text_file` | 限定 worktree |
| `write_file` | `fs/write_text_file` | 限定 worktree |
| `edit_file` | `fs/read_text_file` + `fs/write_text_file` | 两次调用 |
| `grep` | `terminal/create` (grep) | 通过终端执行 |
| `list_directory` | `terminal/create` (ls) | 通过终端执行 |
| `run_shell` | `terminal/create` | 通过终端执行 |

### 6.6 权限判断

```ts
function shouldRequestPermission(toolName: string, input: Record<string, unknown>): boolean {
  // 写文件和终端操作需要权限
  switch (toolName) {
    case 'write_file':
    case 'edit_file':
    case 'run_shell':
    case 'execute_command':
      return true
    // 读文件和搜索不需要权限
    case 'read_file':
    case 'grep':
    case 'list_directory':
      return false
    default:
      return true // 未知工具默认需要权限
  }
}

function mapToolNameToKind(toolName: string): ToolKind {
  switch (toolName) {
    case 'read_file': return 'read'
    case 'write_file': return 'edit'
    case 'edit_file': return 'edit'
    case 'grep': return 'search'
    case 'list_directory': return 'read'
    case 'run_shell': return 'execute'
    default: return 'other'
  }
}
```

---

## 7. 增强机制

### 7.1 概述

builtin-agent 在推理循环中内置以下增强机制，用于应对长任务执行中的上下文膨胀、方向偏离和失败恢复。所有机制均在 agentLoop 内部实现，不依赖宿主的特殊配合。

| # | 机制 | 复杂度 | 说明 |
|---|---|---|---|
| 1 | 全局约束持久化 | 🟢 | 原始 Mission 约束存局部变量，每次构造上下文时注入 |
| 2 | 分层重试 + 主动放弃 | 🟢 | 局部重试 → 策略调整 → 主动结束保留成果 |
| 3 | 两阶段 Agent Loop | 🔴 | 规划阶段 → 复杂度判断 → 简单路径 / 隔离路径 |
| 4 | 结构化工作内存 | 🟡 | `state.json`，LLM 主动写 / 代码兜底读，子任务间信息通道 |
| 5 | 硬门禁（软门禁） | 🟢 | 仅 prompt 约束，不做代码拦截 |
| 6 | 上下文自动压缩 | 🟢 | 上一条 `_llm/chat` 的 `usage.input` > `contextWindow * 0.7` → 摘要压缩 |

### 7.2 全局约束持久化

每次 `session/prompt` 中携带的 Mission 约束（goal、successCriteria、constraints、outputContract）提取后存入 `state.missionConstraints`。无论上下文如何重置，每次构造 messages 时始终注入。

```ts
// 在 runInferenceLoop 中，每次构造 messages 时
function buildMessages(state: AgentLoopState, task?: Task): AnthropicMessage[] {
  const msgs: AnthropicMessage[] = [
    { role: 'user', content: state.systemPrompt }
  ]
  if (state.missionConstraints) {
    msgs.push({ role: 'user', content: `[Mission 约束]\n${state.missionConstraints}` })
  }
  if (task) {
    msgs.push({ role: 'user', content: `当前子任务: ${task.goal}` })
  }
  // ... 注入 state.json 摘要、硬门禁等
  return msgs
}
```

### 7.3 分层重试与主动放弃

在 agentLoop 中维护 `consecutiveFailures` 计数器，按梯度处理：

```
Level 1 - 局部重试：同一工具调用失败 → Agent 自行换参数重试
Level 2 - 策略调整：同一工具连续 3 次失败 → 注入提示「请换一种方法」
Level 3 - 主动放弃：连续失败 ≥ 5 次且步数 > 40 → 响应 stopReason: 'end_turn'，保留 worktree 已有成果
```

```ts
// agentLoop 内工具执行后
if (toolResult.is_error) {
  state.consecutiveFailures++
} else {
  state.consecutiveFailures = 0
}

if (state.consecutiveFailures >= 3 && state.consecutiveFailures < 5) {
  state.messages.push({
    role: 'user',
    content: '[系统] 连续 3 次工具调用失败。请换一种方法，不要重复相同的操作。'
  })
}

if (state.consecutiveFailures >= 5 && turnCount > 40) {
  transport.respond(promptRequestId, { stopReason: 'end_turn' })
  return
}
```

### 7.4 两阶段 Agent Loop

收到 `session/prompt` 后，agentLoop 分两阶段执行：

**阶段一：规划（Controller 角色）**

LLM 分析目标，产出 `plan.md`（通过 `write_file`），不执行任何子任务。代码读取 `plan.md` 解析子任务列表。

**阶段二：执行（Subagent 角色）**

代码判断复杂度：

- 子任务 ≤ 5 个 → **简单路径**：直接在当前上下文逐个执行，不清空上下文
- 子任务 > 5 个 → **隔离路径**：每个子任务重置上下文，只传入 `plan.md` 当前子任务描述 + `state.json` 全局状态 + 硬门禁

```ts
async function startAgentLoop(transport, sessionId) {
  // ... 初始化

  while (!state.cancelled) {
    const promptReq = await transport.waitForRequest('session/prompt')
    const promptParams = promptReq.params as any

    // 提取 Mission 约束，持久化
    state.missionConstraints = extractConstraints(promptParams.prompt)

    // 阶段一：规划
    await runPlanningPhase(transport, state)
    const planContent = await readFile(transport, state, 'plan.md')
    const tasks = parseTasks(planContent)

    // 复杂度判断
    if (tasks.length <= 5) {
      // 简单路径：直接执行
      await runSimplePath(transport, state, tasks, promptReq.id)
    } else {
      // 隔离路径：每个子任务重置上下文
      await runIsolatedPath(transport, state, tasks, promptReq.id)
    }
  }
}
```

**隔离路径中的子任务执行（软门禁）：**

```ts
async function runIsolatedPath(transport, state, tasks, promptRequestId) {
  let globalState = {}

  for (const task of tasks) {
    // 1. 读取 state.json（结构化工作内存）
    const stateJson = await readFile(transport, state, 'state.json')
    if (stateJson) globalState = JSON.parse(stateJson)

    // 2. 重置上下文
    state.messages = buildMessages(state, task)
    state.messages.push({
      role: 'user',
      content: `## Hard-Gate
- 你当前只能执行子任务: ${task.id} - ${task.goal}
- 验收标准: ${task.acceptanceCriteria}
- 严禁修改其他子任务涉及的文件
- 严禁偏离当前子任务目标
- 完成后输出 TASK_COMPLETE: ${task.id}，并更新 state.json`
    })

    // 3. 执行推理循环
    await runInferenceLoop(transport, state, promptRequestId)

    // 4. 检测 state.json 是否更新（代码兜底）
    const updatedState = await readFile(transport, state, 'state.json')
    if (updatedState === stateJson) {
      // LLM 忘记更新，注入提醒
      state.messages.push({
        role: 'user',
        content: '[系统] 请先更新 state.json 再结束当前子任务。'
      })
      // 给 LLM 一次机会补写
      await runInferenceLoop(transport, state, promptRequestId)
    }
  }

  transport.respond(promptRequestId, { stopReason: 'end_turn' })
}
```

### 7.5 结构化工作内存（含结果提取）

Agent 在 worktree 中维护 `state.json`，LLM 主动写，代码兜底读。子任务间的唯一信息通道。

**文件结构：**

```json
{
  "version": 1,
  "updated_at": 0,
  "current_phase": "模型训练",
  "phases": [
    { "id": "data_cleaning", "status": "done" },
    { "id": "feature_engineering", "status": "done" },
    { "id": "model_training", "status": "in_progress" },
    { "id": "evaluation", "status": "pending" }
  ],
  "outputs": {
    "clean_data": "data/clean.csv",
    "features": "data/features.csv",
    "config": "config.yaml"
  },
  "notes": [
    "clean.csv 包含 10,000 行，已通过 null_check",
    "features.csv 使用 StandardScaler 归一化"
  ]
}
```

**写入（LLM 负责）：** system prompt 引导 LLM 在子任务完成时和产出关键文件时更新 `state.json`。

**读取（代码负责）：** 每次构造推理上下文时，代码读取 `state.json` 并注入摘要。隔离路径中每个子任务启动前读取，完成后检测是否更新。

**Schema 设计原则：** 极简——`outputs`（子任务间传递的核心产出）、`phases`（进度账本，与 `plan.md` 对照）、`notes`（传递注意事项）。

### 7.6 硬门禁（软门禁）

仅做 prompt 约束，不做代码拦截。在隔离路径的每个子任务启动时，注入到上下文中的刚性指令：

```
## Hard-Gate

你正在执行子任务 T2：实现核心模块（src/core.ts）

允许的操作：
- 读取 src/core.ts, src/types.ts, package.json
- 写入 src/core.ts（如需要，也可写入 src/types.ts）
- 运行 npx tsc --noEmit 验证类型

禁止的操作：
- 修改任何其他文件
- 运行 npm install 或其他包管理命令
- 重新规划任务——你只需要执行，不需要重新设计

完成后：
- 运行验收命令 npx tsc --noEmit
- 输出 TASK_COMPLETE: T2，附验收结果
- 如果验收失败，修复后重新验收，最多 3 次
```

约束信息来自 `plan.md` 中 LLM 规划时写入的每个子任务的「允许写入」「允许读取」「验收命令」字段。不做代码层路径拦截——隔离模式的干净上下文本身已提供强约束，且写拦截性价比不高。

### 7.7 上下文自动压缩

仅在简单路径下生效（隔离路径每个子任务上下文干净，不会触发）。每次 `_llm/chat` 返回后，用返回的 `usage.input` 判断是否超过阈值：

```ts
// 每次 _llm/chat 返回后
const lastInputTokens = response.usage.input  // 当前 messages 的真实 token 数

if (lastInputTokens > state.contextWindow * 0.7) {
  // 压缩最早 30 条消息为摘要
  const earlyMessages = state.messages.slice(0, 30)
  const restMessages = state.messages.slice(30)

  const summary = await transport.request('_llm/chat', {
    sessionId: state.sessionId,
    model: state.model,
    messages: [
      ...earlyMessages,
      { role: 'user', content: '请将以上对话压缩为一段摘要，列出已完成的关键操作和产出。只输出摘要。' }
    ],
    max_tokens: 500
  })

  state.messages = [
    { role: 'user', content: `[早期对话摘要]\n${summary.message.content}` },
    ...restMessages
  ]
}
```

**触发条件：** `usage.input > contextWindow * COMPRESSION_RATIO`。`COMPRESSION_RATIO` 默认 0.7，可配置。

**上下文窗口来源：** 宿主在 `session/new` 时传入 `contextWindow`（如 200000 表示 200K 窗口），Agent 存入 `state.contextWindow`。不同模型有不同的窗口大小，压缩阈值自动适配。

---

## 8. System Prompt 构建

### 8.1 来源

builtin-agent 的 system prompt 由两部分组成：

1. **Mission 上下文**（宿主注入）：`session/prompt` 中携带的 goal、successCriteria、constraints、outputContract 等
2. **工具定义**（builtin 内置）：内置工具的 Anthropic tool use 格式定义

### 8.2 工具定义

```ts
const BUILTIN_TOOLS: AnthropicTool[] = [
  {
    name: 'read_file',
    description: '读取文件内容',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: '文件路径（相对于 worktree）' },
        offset: { type: 'integer', description: '起始行号（1-based）' },
        limit: { type: 'integer', description: '读取行数' }
      },
      required: ['file_path']
    }
  },
  {
    name: 'write_file',
    description: '创建或覆盖文件',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: '文件路径（相对于 worktree）' },
        content: { type: 'string', description: '文件内容' }
      },
      required: ['file_path', 'content']
    }
  },
  {
    name: 'edit_file',
    description: '通过精确字符串替换编辑文件',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: '文件路径' },
        old_string: { type: 'string', description: '待替换的字符串' },
        new_string: { type: 'string', description: '替换后的字符串' }
      },
      required: ['file_path', 'old_string', 'new_string']
    }
  },
  {
    name: 'grep',
    description: '在文件中搜索正则表达式',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '正则表达式' },
        path: { type: 'string', description: '搜索路径' },
        glob: { type: 'string', description: '文件 glob 过滤' }
      },
      required: ['pattern']
    }
  },
  {
    name: 'list_directory',
    description: '列出目录内容',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目录路径' }
      }
    }
  },
  {
    name: 'run_shell',
    description: '执行 Shell 命令',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令' },
        args: { type: 'array', items: { type: 'string' }, description: '命令参数' },
        cwd: { type: 'string', description: '工作目录' }
      },
      required: ['command']
    }
  }
]
```

### 8.3 System Prompt 模板

```
你是 SpaceAssistant 的内置 Agent，在一个隔离的工作目录中执行用户委托的任务。

## 任务目标
{goal}

## 成功标准
{successCriteria}

## 约束条件
{constraints}

## 交付合同
{outputContract}

## 工作环境
- 工作目录: {cwd}
- 你只能在工作目录内读写文件
- 文件写入前会请求用户确认

## 行为准则
1. 在执行任务前，先理解目标、制定计划
2. 使用工具完成任务，每次工具调用后观察结果再决定下一步
3. 如果遇到阻塞或偏离，请自行调整策略
4. 如果无法自行解决，请明确说明原因并请求用户决策
5. 完成后请确认所有成功标准是否满足

## 规划与状态管理
- 执行复杂任务前，先将任务拆解为子任务，写入 plan.md
- 每个子任务应包含：目标、允许写入的文件、验收命令
- 维护 state.json 记录当前进度和关键产出：
  - 子任务完成时，更新 phases 中的状态
  - 产出关键文件时，记录到 outputs 中
  - 有重要注意事项时，记录到 notes 中
- 收到系统进度检查提示（sys_checkpoint_ 消息）时，认真对照目标检查进度

## 子任务执行规范
- 每个子任务只做规定范围内的事，不修改其他子任务的文件
- 子任务完成后运行验收命令，确认通过后再进入下一个
- 验收失败时最多重试 3 次
- 连续 3 次工具调用失败时，换一种方法，不要重复相同操作
```

---

## 9. 与宿主 ACP 交互的完整时序

```
宿主（AgentRunHost）                    builtin-agent 子进程
    │                                       │
    │── initialize ──────────────────────→  │  ① 版本协商
    │←─ initialize 响应 ──────────────────  │
    │                                       │
    │── session/new ─────────────────────→  │  ② 创建会话
    │←─ session/new 响应 ─────────────────  │
    │                                       │
    │── session/prompt ──────────────────→  │  ③ 发送用户消息
    │                                       │
    │                                       │── _llm/chat ──→ 宿主  ④ 请求 LLM
    │←─ session/update (agent_message_chunk)  ⑤ 宿主流式推送
    │←─ session/update (agent_message_chunk)
    │←─ _llm/chat 响应 ──────────────────  │
    │                                       │
    │                                       │── session/update (tool_call) ──→ ⑥ 工具调用
    │                                       │── session/request_permission ──→ ⑦ 请求权限
    │←─ 权限响应 ──────────────────────────  │
    │                                       │── session/update (tool_call_update: in_progress)
    │                                       │── fs/write_text_file ──→ ⑧ 执行工具
    │←─ 工具结果 ──────────────────────────  │
    │                                       │── session/update (tool_call_update: completed)
    │                                       │
    │                                       │── _llm/chat ──→ ⑨ 继续推理
    │←─ session/update (agent_message_chunk)
    │←─ _llm/chat 响应 ──────────────────  │
    │                                       │
    │←─ session/prompt 响应 ───────────────  │  ⑩ 完成
    │   (stopReason: end_turn)              │
```

---

## 10. 错误处理

### 10.1 子进程级错误

```ts
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err.message)
  // 不退出，让宿主的 drain 机制处理
})

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason)
})
```

### 10.2 RPC 错误

| 场景 | 处理 |
|---|---|
| `_llm/chat` 超时 | 重试一次，仍失败则 `stopReason: 'refusal'` |
| `fs/read_text_file` 文件不存在 | 返回错误给 Agent，Agent 自行决定 |
| `fs/write_text_file` 权限拒绝 | 返回错误给 Agent |
| `terminal/create` 命令不存在 | 返回错误给 Agent |
| `session/request_permission` 超时 | 视为拒绝，Agent 自行调整 |

### 10.3 取消

宿主发送 `session/cancel` notification → builtin 设置 `state.cancelled = true` → 终止当前 LLM 调用和工具执行 → 响应 `session/prompt` 返回 `stopReason: 'cancelled'`

---

## 11. 测试策略

### 11.1 单元测试

| 测试项 | 说明 |
|---|---|
| `acpTransport.test.ts` | 消息序列化/反序列化、请求响应匹配、waitForRequest |
| `agentLoop.test.ts` | mock 宿主 transport，验证推理循环逻辑 |
| 工具映射测试 | 验证内置工具名 → ACP 方法映射正确 |

### 11.2 集成测试

| 测试项 | 说明 |
|---|---|
| 完整 ACP 握手 | `initialize` → `session/new` → `session/prompt` |
| 简单推理 | 无工具调用的问答 |
| 工具调用 | 读文件 → 思考 → 写文件 |
| 权限请求 | 写文件触发权限请求 |
| 取消 | 发送 `session/cancel` 后 Agent 停止 |
| 多轮推理 | 多次工具调用的复杂任务 |

### 11.3 测试方式

- 使用 mock 的 stdin/stdout（`stream.PassThrough`）
- 模拟宿主的 ACP 消息
- 验证 builtin 的响应和 notification

---

## 12. 文件清单

| 文件 | 说明 |
|---|---|
| `electron/subagent/builtin/index.ts` | 入口 |
| `electron/subagent/builtin/agentLoop.ts` | 推理循环 |
| `electron/subagent/builtin/acpTransport.ts` | ACP JSON-RPC 2.0 Client 侧 |
| `electron/subagent/builtin/agentTypes.ts` | 内部类型 |
| `electron/subagent/builtin/index.test.ts` | 集成测试 |
| `electron/subagent/builtin/agentLoop.test.ts` | 推理循环测试 |
| `electron/subagent/builtin/acpTransport.test.ts` | Transport 测试 |