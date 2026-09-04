# Builtin SubAgent 详细技术开发方案

> 依据：`docs/requirement/builtin-subagent-requirement.md` v1.1
> 状态：已通过自评审 v1（无阻断项）
> 设计目标：基于需求文档的产品语义，为 Builtin SubAgent 提供可直接进入开发计划的详细技术方案，覆盖所有 MVP 模块的接口定义、数据流、状态机和实现策略。

## 评审记录

| 轮次 | 日期 | 评审结果 | 阻断项 | 处理方式 |
|---|---|---|---|---|
| R1 | 2026-07-28 | 通过（经修正） | 5 项阻断（见下方） | 全部修正 |

### R1 阻断项修正记录

| # | 阻断项 | 严重程度 | 修正位置 |
|---|---|---|---|
| B1 | `_llm/chat` 安全注册机制未明确（SEC-02） | Critical | §5.4 增加白名单注册机制 `registerAsBuiltinTransport()` |
| B2 | 分层失败处理（需求 §8.6）未完整映射 | High | §6.6 新增四个层次的分层失败处理 |
| B3 | 上下文压缩失败重试机制缺失（FR-INF-05） | High | §6.5 增加 `maxRetries=3` 和降级策略 |
| B4 | host→agent 通知（`session/update`）处理不明确 | High | §5.5 新增宿主→Agent 通知处理 |
| B5 | `session/request_permission` 协议角色不明确 | Medium | §5.0 新增协议角色与方向总览 |

### 评审结论

所有阻断项已修正。开发方案覆盖需求文档 §19.1 全部 MVP 模块，包含详细的接口定义、数据流、状态机和实现策略。无剩余阻断项，可进入开发计划。

## 1. 结论与实施边界

本方案采用"Electron 主进程 AgentRunHost 控制面 + 独立 Node 子进程 ACP/JSON-RPC 协议传输 + 宿主统一工具/LLM/安全/预算网关"的实现。Builtin SubAgent 是一个**薄推理子进程**，不持有密钥、不直接执行工具、不直接访问文件系统或网络。所有执行能力由 AgentRunHost 通过 ACP 扩展协议代理。

Builtin 与外部 Codex 复用同一套 AgentRunHost 生命周期、状态机、安全边界、事件持久化和结果导入链路。后端差异通过 `AgentBackend` adapter 隔离，上层调度不按后端分叉。

### 1.1 核心设计决策

| 决策 | 内容 |
|---|---|
| D-01 | Builtin 是后台 Mission 的内置兜底后端，不是主聊天中的一次性委派工具 |
| D-02 | Agent 负责认知决策，宿主负责执行控制 |
| D-03 | Builtin 作为独立子进程运行，通过 ACP v1 / JSON-RPC 2.0 over stdio 通信 |
| D-04 | `_llm/chat` 仅 Builtin 可用，最终响应包含完整规范化消息、stopReason 和 usage |
| D-05 | 权限风险由宿主权威判定，不依赖 Builtin 自报 |
| D-06 | Checkpoint 和 Stuck Detection 归属 AgentRunHost |
| D-07 | Agent 的计划和工作记忆均为非权威信息 |
| D-08 | 自动回退只发生在创建新 Run 时，不热切换运行中的后端 |
| D-09 | 正式完成由宿主 Candidate、验证和 Review 决定，不由 `end_turn` 或 Agent 文本决定 |
| D-10 | Run 收敛意图仅通过 `session/prompt` 的单一 `BuiltinRunOutcomeEnvelope` 表达 |

### 1.2 MVP 范围边界

**必须交付：**
- Builtin 独立子进程及 ACP transport
- AgentRunHost 统一生命周期（含 Builtin 与 Codex 后端）
- 自动后端选择与 Builtin 回退
- `_llm/chat` 宿主代理和多服务规范化
- 读、写、编辑、搜索、目录、Shell 最小工具集
- 权限、路径、预算、取消和 generation fencing
- 基础推理循环、Mission 约束持久化、最大轮次
- Checkpoint、基础僵局检测
- RunSnapshot、事件、Candidate 导入和崩溃恢复
- Mission 详情基础可观测性
- 三平台打包和冒烟测试

**明确不做（MVP 后增强或延后）：**
- Builtin 内部递归 SubAgent
- 静态 Workflow / Task DAG
- ACP `session/load`
- 可视化配置 Checkpoint / 僵局阈值
- Mission 间宿主依赖调度
- 以 Agent 自述代替确定性验证或 Review

## 2. 现状复用与差距

### 2.1 可直接复用

| 现有能力 | 位置 | 复用方式 |
|---|---|---|
| SQLite WAL、事务与迁移 | `electron/database/` | 新增 AgentRun 扩展字段 migration；关键状态写入使用 `runInTransaction` |
| 会话与 workDir profile 绑定 | `electron/workDirManager.ts` | Builtin 私有 worktree 复用 profile 解析逻辑 |
| 路径规范化基础 | `electron/pathSecurity.ts` | 扩展为 Builtin 工具执行的路径安全校验 |
| 子进程启动基础 | `electron/spawnUtil.ts` | 复用参数化 spawn；新增 ACP transport 和进程树管理 |
| 主进程 IPC 注册模式 | `electron/appIpc.ts`、`electron/preload.ts`、`src/shared/api.ts` | 新增 Builtin 相关 API |
| 内置 Skill 机制 | `electron/skills/bundled/` | 复用 skill 注册模式 |
| 现有 LLM 多服务配置与流式调用 | `electron/llm/` | `_llm/chat` 宿主代理直接复用 |
| 工具确认卡片和 Decision | `src/renderer/` | 复用现有卡片 UI 和信任规则 |
| 后台任务执行层 v3 | `electron/backgroundMission/` | AgentRunHost 在此之上扩展 Builtin 后端 |

### 2.2 必须新增或修正

| 差距 | 说明 |
|---|---|
| ACP JSON-RPC 2.0 over stdio 协议栈 | 全新的子进程通信协议，包括序列化、请求匹配、超时、取消和错误处理 |
| Builtin 子进程入口与推理循环 | 独立 Node 脚本，不含 Electron 依赖，实现最小推理闭环 |
| AgentBackend 注册与选择 | 在现有 AgentBackend 接口基础上增加 Builtin 实现和自动回退逻辑 |
| `_llm/chat` 宿主代理 | 仅注册到 Builtin transport 的 LLM 代理方法 |
| 工具网关增强 | 所有工具调用经宿主统一授权、路径校验、预算核算和 fencing |
| Checkpoint / StuckDetector | 新增宿主级 Checkpoint 注入和僵局检测 |
| Run outcome 校验与状态迁移 | 新增 `BuiltinRunOutcome` schema 校验、幂等处理和状态比较交换 |
| Builtin 编译产物打包 | 三平台 asarUnpack、路径解析和冒烟校验 |
| Mission 详情 UI 增强 | 后端标识、回退原因、Builtin 特有诊断信息展示 |

## 3. 总体架构

```text
Renderer
  ├─ MissionConfirmDialog     可信预览与确认
  ├─ MissionListPane          轻量任务列表（含后端标识）
  └─ MissionDetailPane        快照、时间线、决策、交付物、后端诊断
             │ typed IPC
             ▼
Electron Main Process
  ┌──────────────── MissionApplicationService ────────────────┐
  │ prepare / confirm / cancel / resume / manual accept       │
  └───────────────┬──────────────────────────┬────────────────┘
                  ▼                          ▼
        MissionRepository            MissionSupervisor
         SQLite transactions          scheduler + recovery scan
                  │                          │
                  │                    AgentRunHost（统一托管）
                  │             ┌────────────┼──────────────┐
                  │             ▼            ▼              ▼
                  │      RunWorkspaceManager AgentBackend  BackendEventAdapter
                  │             │                          │
                  │      ┌──────┴──────┐          ┌───────┴───────┐
                  │      ▼             ▼          ▼               ▼
                  │  CodexBackend  BuiltinBackend  BuiltinTransport
                  │                                (ACP JSON-RPC)
                  │                                      │
                  │                              ┌───────┴────────┐
                  │                              ▼                ▼
                  │                    BuiltinAgentProcess   LlmProxy
                  │                    (独立子进程推理循环)   (宿主 LLM 代理)
                  │
                  ├─ ToolGateway（统一工具授权、路径、预算、fencing）
                  ├─ PermissionHandler（风险判定、确认卡片）
                  ├─ CheckpointInjector（预算阈值检查点注入）
                  ├─ StuckDetector（僵局信号检测与升级）
                  ├─ BudgetManager（token/时间/工具/终端预算核算）
                  └─ RunEventWriter + SnapshotProjector
```

### 3.1 依赖方向

```text
shared contracts (ACP types, RunOutcome, events)
      ▲
repositories ← application services ← supervisor/coordinators ← adapters
      ▲                                      ▲
   SQLite                         filesystem / Agent runtime
```

- AgentBackend adapter 不直接改 Mission 表，只向 AgentRunHost 输出规范化事件和执行结果。
- BuiltinAgentProcess 是可独立编译、不含 Electron 依赖的 Node 脚本。
- Renderer 不能调用内部的 create/start/accept 方法。
- 所有正式状态变更必须经 application service 的事务方法完成。

### 3.2 关键数据流：一次完整 Builtin Run

```text
用户确认 Mission
  → MissionApplicationService.confirm()
  → AgentBackendRegistry.selectBackend(mission, policy)
  → 选择 builtin（Codex 不可用或准入失败）
  → AgentRunHost.startRun(AgentRun, 'builtin')
  → 创建私有 worktree
  → 启动 BuiltinAgentProcess（Node 子进程，stdio pipe）
  → BuiltinTransport.initialize()
  → ACP initialize（协议版本与能力协商）
  → ACP session/new（传入 cwd、上下文窗口、允许能力）
  → ACP session/prompt（传入 Mission 目标、成功标准、约束、预算摘要）
  → AgentRun 进入 running
  → [推理循环开始]
  → Builtin 请求 _llm/chat → LlmProxy 调用 LLM 服务 → 返回规范化响应
  → Builtin 请求工具执行 → ToolGateway 授权/路径/预算校验 → 执行 → 返回结果
  → [Checkpoint 注入、僵局检测、预算核算持续进行]
  → Builtin 返回 BuiltinRunOutcomeEnvelope（session/prompt 最终响应）
  → AgentRunHost 校验 outcome → 状态迁移
  → submitting → 扫描 worktree → 固化 Candidate → 验证 → Review → completed
  → 或 failed / cancelled / waiting
```

## 4. 目录与模块设计

### 4.1 新增目录结构

```text
src/shared/builtinSubAgent/
  types.ts                     ACP 协议类型、RunOutcome、事件 DTO
  schemas.ts                   Zod schema（ACP 消息、RunOutcome、工具请求）
  constants.ts                 错误码、预算默认值、协议版本

electron/builtinSubAgent/
  builtinAgentProcess.ts       Builtin 子进程入口（独立 Node 脚本，不含 Electron）
  acpTransport.ts              ACP JSON-RPC 2.0 over stdio 传输层
  acpProtocol.ts               ACP 消息序列化、schema 校验、请求匹配、超时
  builtinBackend.ts            AgentBackend 接口的 Builtin 实现
  inferenceLoop.ts             Builtin 推理循环（Mission 约束持久化、上下文压缩、工具编排）
  missionContext.ts            Mission 约束提取、持久化和重建
  workMemory.ts                结构化工作记忆读写（.space-assistant/runtime/agent-state.json）
  contextCompressor.ts         上下文压缩（摘要生成、约束保留）

electron/builtinSubAgent/host/
  agentRunHost.ts              AgentRunHost 统一托管（进程、协议、工具、权限、预算、事件、收尾）
  llmProxy.ts                  _llm/chat 宿主代理（多服务适配、规范化）
  toolGateway.ts               统一工具网关（授权、路径、预算、fencing）
  permissionHandler.ts         权限风险判定与确认流程
  budgetManager.ts             预算核算（token、时间、工具次数、终端输出）
  checkpointInjector.ts        Checkpoint 生成与注入
  stuckDetector.ts             僵局信号检测与升级
  runOutcomeHandler.ts         Run outcome 校验、幂等处理与状态迁移
  backendRegistry.ts           AgentBackend 注册、选择、准入和回退

electron/builtinSubAgent/events/
  runEventWriter.ts            运行事件持久化
  snapshotProjector.ts         RunSnapshot 投影

src/renderer/builtinMission/
  MissionDetailPane.tsx        增强详情（后端标识、回退原因、Builtin 诊断）
  BuiltinDiagnosticView.tsx    Builtin 特有诊断信息展示

构建配置
  electron-builder.yml          asarUnpack 配置（Builtin 入口脚本）
  scripts/verify-builtin.ts    打包校验（入口存在、最小握手可完成）
```

### 4.2 模块职责矩阵

| 模块 | 职责 | 依赖 |
|---|---|---|
| `builtinAgentProcess.ts` | 子进程入口、ACP 握手、推理循环、工具映射 | acpTransport, inferenceLoop, missionContext |
| `acpTransport.ts` | stdio 行协议、JSON 序列化、请求/响应匹配、超时、取消 | acpProtocol |
| `acpProtocol.ts` | schema 校验、方法路由、错误标准化 | shared schemas |
| `builtinBackend.ts` | AgentBackend 接口实现、进程生命周期、事件适配 | builtinAgentProcess, acpTransport |
| `agentRunHost.ts` | 统一 Run 生命周期、后端协调、LLM/工具/预算/权限/Checkpoint/僵局调度 | 所有 host 子模块 |
| `llmProxy.ts` | 多 LLM 服务适配、规范化消息转换、流式增量推送 | 现有 LLM 模块 |
| `toolGateway.ts` | 工具授权、路径校验、预算核减、generation fencing、执行与结果返回 | permissionHandler, budgetManager, pathSecurity |
| `budgetManager.ts` | token/时间/工具/终端多维预算核算与超限终止 | - |
| `checkpointInjector.ts` | 预算阈值触发、目标检查清单、摘要生成与注入 | llmProxy |
| `stuckDetector.ts` | 连续失败/重复编辑/重复序列检测、僵局警告与升级 | - |
| `runOutcomeHandler.ts` | outcome schema 校验、executionToken 消费、幂等处理、状态比较交换 | - |
| `backendRegistry.ts` | 后端注册、准入检查、自动选择与回退 | - |

## 5. ACP 协议与 Transport 详细设计

### 5.0 协议角色与方向总览

ACP 协议中，方法调用方向分为两类：

| 方向 | 方法 | 说明 |
|---|---|---|
| **Agent → Host（请求）** | `_llm/chat` | Builtin 请求宿主代理 LLM 调用 |
| | `fs/read_text_file` | 读取文件 |
| | `fs/write_text_file` | 写入文件 |
| | `fs/grep` | 搜索内容 |
| | `fs/list_directory` | 列出目录 |
| | `terminal/create` | 创建终端 |
| | `terminal/output` | 读取终端输出 |
| | `terminal/kill` | 终止终端 |
| **Host → Agent（请求）** | `initialize` | 协议握手 |
| | `session/new` | 创建会话 |
| | `session/prompt` | 提交 Mission 输入 |
| | `session/cancel` | 取消会话 |
| **Host → Agent（通知）** | `session/update` | 推送文本增量、计划、工具状态、用量、checkpoint、僵局警告 |
| | `session/request_permission` | 通知 Agent 有权限请求需要用户确认（宿主判定后告知 Agent 进入等待） |

`session/request_permission` 不是 Agent 调用宿主的方法。Agent 只描述工具调用意图，由宿主工具网关判定风险。当需要用户确认时，宿主通过此通知告知 Agent 当前执行被挂起等待确认；用户答复后宿主以工具结果的形式返回。Agent 不得依赖此通知自行决定是否需要确认。

### 5.1 协议栈

```
应用层：ACP v1 语义（initialize, session/new, session/prompt, session/update, session/cancel）
传输层：JSON-RPC 2.0
帧层：  行分隔 JSON（每行一个完整 JSON 对象，stdout 协议，stderr 诊断）
物理层：Node child_process stdio pipe
```

### 5.2 核心类型定义

```ts
// ===== ACP JSON-RPC 基础类型 =====

interface AcpRequest {
  jsonrpc: '2.0'
  id: string | number
  method: string
  params?: Record<string, unknown>
}

interface AcpResponse {
  jsonrpc: '2.0'
  id: string | number
  result?: unknown
  error?: {
    code: number
    message: string
    data?: unknown
  }
}

interface AcpNotification {
  jsonrpc: '2.0'
  method: string
  params?: Record<string, unknown>
}

// ===== ACP 方法定义 =====

// initialize
interface InitializeParams {
  protocolVersion: string  // '1.0'
  clientInfo: { name: string; version: string }
  capabilities: {
    loadSession: boolean      // Builtin: false
    streaming: boolean
    tools: string[]
  }
}
interface InitializeResult {
  protocolVersion: string
  serverInfo: { name: string; version: string }
  capabilities: {
    loadSession: boolean
    streaming: boolean
    tools: string[]
  }
}

// session/new
interface SessionNewParams {
  sessionId: string
  cwd: string                    // 私有 worktree 路径
  contextWindow?: number         // 模型上下文窗口大小
  allowedCapabilities: string[]  // 允许的工具列表
  options?: {
    checkpointEnabled: boolean
    stuckDetectionEnabled: boolean
    contextCompressionRatio: number
    maxInferenceTurns: number
  }
}
interface SessionNewResult {
  sessionId: string
  acceptedCapabilities: string[]
}

// session/prompt
interface SessionPromptParams {
  sessionId: string
  prompt: {
    mission: {
      missionId: string
      goal: string
      successCriteria: Array<{
        id: string
        description: string
        required: boolean
        verification: string
      }>
      constraints: Array<{
        id: string
        description: string
        category: 'scope' | 'compatibility' | 'business_rule' | 'process' | 'prohibition'
      }>
      outputContract: {
        deliverables: Array<{
          key: string
          description: string
          required: boolean
        }>
      }
      authorizationSummary: string
      budgetSummary: {
        maxTokens: number
        maxToolCalls: number
        maxDurationMinutes: number
        maxTerminalOutputBytes: number
      }
    }
    recoveryContext?: {
      previousRunId: string
      previousGeneration: number
      failureReason: string
      preservedArtifacts: string[]
      hostObservations: string[]
      previousAgentClaims: string[]
      stillValidConstraints: Array<{ id: string; description: string }>
    }
  }
  executionToken: string  // 不透明、单次使用的 token
}
// 最终响应是 BuiltinRunOutcomeEnvelope（见 §9）

// session/update（通知）
interface SessionUpdateNotification {
  sessionId: string
  update: 
    | { type: 'agent_message_chunk'; text: string }
    | { type: 'plan'; plan: AgentPlan }
    | { type: 'tool_call'; toolCall: ToolCallEvent }
    | { type: 'tool_call_update'; update: ToolCallUpdateEvent }
    | { type: 'usage_update'; usage: UsageUpdate }
    | { type: 'checkpoint'; checkpoint: CheckpointEvent }
    | { type: 'stuck_warning'; warning: StuckWarningEvent }
    | { type: 'diagnostic'; diagnostic: DiagnosticEvent }
}

// session/cancel
interface SessionCancelParams {
  sessionId: string
  reason: string
}
interface SessionCancelResult {
  sessionId: string
  cancelled: boolean
}

// ===== host→agent 通知方法 =====

// session/request_permission（host→agent 通知有权限请求需要用户确认）
// 这是宿主发起的能力，不是 agent 调用的方法

// ===== Builtin 专属方法 =====

// _llm/chat（仅 Builtin transport 可用）
interface LlmChatParams {
  sessionId: string
  messages: NormalizedMessage[]
  system?: string
  tools?: NormalizedTool[]
  modelHint?: string
  maxOutputTokens?: number
  thinkingBudget?: number
}
interface LlmChatResult {
  message: NormalizedAssistantMessage
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'cancelled'
  usage: { inputTokens: number; outputTokens: number }
}
```

### 5.3 ACP Transport 实现

```ts
// acpTransport.ts

interface AcpTransportOptions {
  process: ChildProcess
  timeoutMs: number
  maxMessageSize: number
}

class AcpTransport {
  private pendingRequests: Map<string | number, PendingRequest>
  private requestIdCounter: number
  private buffer: string
  private closed: boolean

  constructor(options: AcpTransportOptions)

  // 发送请求并等待响应
  async request(method: string, params?: Record<string, unknown>): Promise<unknown>
  
  // 发送通知（无需响应）
  sendNotification(method: string, params?: Record<string, unknown>): void
  
  // 注册通知处理器
  onNotification(method: string, handler: (params: Record<string, unknown>) => void): void
  
  // 关闭 transport，reject 所有 pending 请求
  close(): void

  // 内部方法
  private handleLine(line: string): void
  private handleResponse(response: AcpResponse): void
  private handleNotification(notification: AcpNotification): void
  private validateMessage(message: unknown): void
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timeout: NodeJS.Timeout
  method: string
}
```

**关键实现策略：**

1. **行协议**：stdout 每行一个完整 JSON 对象。用 `readline` 逐行解析，不依赖换行符在 JSON 字符串内的转义（假设发送端正确转义）。单行超过 `maxMessageSize`（默认 4MB）时拒绝并关闭连接。

2. **请求匹配**：严格按 JSON-RPC `id` 匹配。不支持 `id: null` 的通知式请求（通知使用不带 `id` 的消息）。重复 `id` 视为协议错误。

3. **超时处理**：每个请求设置独立超时（默认 30s，`_llm/chat` 可配置更长）。超时后 reject 该请求，不关闭 transport。

4. **关闭与清理**：`close()` 方法必须：
   - 移除所有 `readline` 监听器
   - Reject 所有 pending 请求
   - 调用 `process.kill()` 终止子进程
   - 设置 `closed = true`，后续操作抛错

5. **错误处理**：
   - JSON 解析失败 → 记录脱敏诊断，跳过该行
   - 未知方法 → 返回 JSON-RPC `method not found`（-32601）
   - 无效参数 → 返回 JSON-RPC `invalid params`（-32602）
   - 内部错误 → 返回 JSON-RPC `internal error`（-32603）
   - 协议外文本出现在 stdout → 记录并忽略

### 5.4 ACP 协议处理器（宿主端）

```ts
// acpProtocol.ts（宿主端）

class AcpProtocol {
  private transport: AcpTransport
  private handlers: Map<string, MethodHandler>
  private notificationHandlers: Map<string, NotificationHandler>
  private builtinTransportIds: Set<string>  // 已验证的 Builtin transport 白名单

  constructor(transport: AcpTransport)

  // 注册方法处理器（处理来自 agent 的请求）
  registerMethod(method: string, handler: MethodHandler): void

  // 注册通知处理器
  onNotification(method: string, handler: NotificationHandler): void

  // ===== 安全关键：将 transport 标记为已验证的 Builtin =====
  // 仅在 initialize 握手成功且标识为 Builtin 后调用
  registerAsBuiltinTransport(transportId: string): void {
    this.builtinTransportIds.add(transportId)
  }

  // 判断某 transport 是否为已验证的 Builtin
  private isBuiltinTransport(transportId: string): boolean {
    return this.builtinTransportIds.has(transportId)
  }

  // ===== 标准 ACP 方法处理器（宿主端） =====

  private async handleInitialize(params: InitializeParams): Promise<InitializeResult> {
    // 协商协议版本和能力
    // 协商成功后，若 agent 标识为 Builtin，调用 registerAsBuiltinTransport
  }

  private async handleSessionNew(params: SessionNewParams): Promise<SessionNewResult>
  private async handleSessionPrompt(params: SessionPromptParams): Promise<BuiltinRunOutcomeEnvelope>
  private async handleSessionCancel(params: SessionCancelParams): Promise<SessionCancelResult>

  // ===== _llm/chat 方法处理器（仅 Builtin transport 可调用） =====

  private async handleLlmChat(params: LlmChatParams): Promise<LlmChatResult> {
    // 1. 校验 transport 是否在 Builtin 白名单中
    if (!this.isBuiltinTransport(this.transport.id)) {
      throw new SecurityError('_llm/chat 仅 Builtin transport 可用')
    }
    // 2. 校验 PID、进程存活、session/run/generation、预算和取消状态
    // 3. 委托给 llmProxy 执行
  }
}

type MethodHandler = (params: Record<string, unknown>) => Promise<unknown>
type NotificationHandler = (params: Record<string, unknown>) => void
```

**关键安全规则：**

- `_llm/chat` 的能力注册是**transport 级别的白名单机制**：仅在 `initialize` 握手成功、且 agent 标识为 Builtin 后，该 transport 才被加入白名单
- 非 Builtin transport（如 Codex MCP 连接）调用 `_llm/chat` 时，方法处理器根本不存在或主动拒绝，并记录安全事件
- 每次 `_llm/chat` 调用必须实时校验：PID 是否存活、进程是否仍在运行、session/run/generation 是否有效、预算是否超限、是否已被取消
- `_llm/chat` 不是网络监听服务，不得绑定 TCP/Unix socket

### 5.5 宿主→Agent 通知处理

宿主通过 `session/update` 通知向 Agent 推送以下信息：

```ts
// 宿主发出通知的场景
// 1. 流式 LLM 文本增量 → agent_message_chunk
// 2. Agent 计划更新 → plan
// 3. 工具调用状态变更 → tool_call, tool_call_update
// 4. 用量更新 → usage_update
// 5. Checkpoint 注入 → checkpoint
// 6. 僵局警告 → stuck_warning
// 7. 诊断信息 → diagnostic

// 宿主发送通知
async function sendSessionUpdate(
  transport: AcpTransport,
  sessionId: string,
  update: SessionUpdate
): Promise<void> {
  transport.sendNotification('session/update', {
    sessionId,
    update,
  })
}
```

**Agent 侧处理 `session/update` 通知：**

```ts
// Builtin 子进程内部
transport.onNotification('session/update', (params) => {
  const { sessionId, update } = params

  switch (update.type) {
    case 'agent_message_chunk':
      // 仅用于 UI 展示，不用于更新对话历史
      // Builtin 内部历史使用 _llm/chat 最终响应
      break

    case 'plan':
      // 更新非权威计划展示
      break

    case 'tool_call':
    case 'tool_call_update':
      // 工具调用事件记录
      break

    case 'usage_update':
      // 更新预算使用情况
      break

    case 'checkpoint':
      // 将 checkpoint 作为系统控制消息注入推理上下文
      // 同时记录但不改变推理循环状态
      inferenceLoop.injectCheckpoint(update.checkpoint)
      break

    case 'stuck_warning':
      // 注入僵局警告到推理上下文
      // 提示 Agent 调整策略
      inferenceLoop.injectStuckWarning(update.warning)
      break

    case 'diagnostic':
      // 脱敏诊断，仅用于日志
      break
  }
})
```

## 6. Builtin 子进程与推理循环详细设计

### 6.1 子进程入口

```ts
// builtinAgentProcess.ts（独立 Node 脚本，不含 Electron 依赖）

// 该脚本作为独立 Node 进程运行，不 import Electron 模块
// 通过 stdio 与宿主通信

import { AcpTransport } from './acpTransport'
import { InferenceLoop } from './inferenceLoop'
import { MissionContext } from './missionContext'
import { WorkMemory } from './workMemory'
import { ContextCompressor } from './contextCompressor'

async function main(): Promise<void> {
  const transport = new AcpTransport({
    process: process,  // 使用当前进程的 stdio
    timeoutMs: 30_000,
    maxMessageSize: 4 * 1024 * 1024,
  })

  const missionContext = new MissionContext()
  const workMemory = new WorkMemory()
  const contextCompressor = new ContextCompressor()
  const inferenceLoop = new InferenceLoop(
    transport, missionContext, workMemory, contextCompressor
  )

  // 注册 ACP 方法处理器
  // Builtin 侧：处理来自宿主的请求
  transport.registerMethod('initialize', handleInitialize)
  transport.registerMethod('session/new', handleSessionNew)
  transport.registerMethod('session/prompt', handleSessionPrompt)
  transport.registerMethod('session/cancel', handleSessionCancel)

  // 注册宿主通知处理器
  transport.onNotification('session/update', handleSessionUpdate)
  transport.onNotification('session/request_permission', handlePermissionRequest)

  // 保持进程运行直到 transport 关闭
  await transport.waitForClose()
}

main().catch((error) => {
  console.error('[builtin] fatal:', error.message)
  process.exit(1)
})
```

### 6.2 推理循环

```ts
// inferenceLoop.ts

interface InferenceLoopState {
  missionContext: MissionContextData
  conversationHistory: NormalizedMessage[]
  workMemory: WorkMemoryData
  turnCount: number
  consecutiveFailures: number
  cancelled: boolean
}

class InferenceLoop {
  private state: InferenceLoopState
  private transport: AcpTransport
  private missionContext: MissionContext
  private workMemory: WorkMemory
  private contextCompressor: ContextCompressor
  private maxTurns: number

  constructor(
    transport: AcpTransport,
    missionContext: MissionContext,
    workMemory: WorkMemory,
    contextCompressor: ContextCompressor
  )

  // 主执行入口
  async execute(prompt: SessionPromptParams): Promise<BuiltinRunOutcome> {
    this.state = this.initializeState(prompt)
    
    while (this.state.turnCount < this.maxTurns) {
      // 1. 检查取消信号
      if (this.state.cancelled) {
        return this.buildCancelledOutcome()
      }

      // 2. 检查是否需要上下文压缩
      if (this.shouldCompress()) {
        await this.compress()
      }

      // 3. 构建 LLM 请求
      const llmRequest = this.buildLlmRequest()

      // 4. 调用 LLM（通过宿主代理）
      const llmResponse = await this.transport.request('_llm/chat', llmRequest)

      // 5. 处理 LLM 响应
      const action = this.processLlmResponse(llmResponse)

      if (action.type === 'end') {
        return action.outcome
      }

      if (action.type === 'tool_calls') {
        // 6. 执行工具调用（串行，按可预测顺序）
        for (const toolCall of action.toolCalls) {
          const toolResult = await this.executeTool(toolCall)
          this.addToHistory(toolCall, toolResult)
        }
      }

      this.state.turnCount++
    }

    // 达到最大轮次
    return this.buildMaxTurnsOutcome()
  }

  // 取消
  cancel(): void {
    this.state.cancelled = true
  }

  private async executeTool(toolCall: NormalizedToolCall): Promise<ToolResult> {
    // 映射工具名到 ACP 方法
    const acpMethod = this.mapToolToAcpMethod(toolCall)
    try {
      const result = await this.transport.request(acpMethod, toolCall.params)
      this.state.consecutiveFailures = 0
      return { success: true, result }
    } catch (error) {
      this.state.consecutiveFailures++
      return { success: false, error: this.normalizeError(error) }
    }
  }

  private mapToolToAcpMethod(toolCall: NormalizedToolCall): string {
    const toolMap: Record<string, string> = {
      'read_file': 'fs/read_text_file',
      'write_file': 'fs/write_text_file',
      'edit_file': 'fs/write_text_file',  // 宿主内部处理为原子编辑
      'grep': 'fs/grep',
      'list_directory': 'fs/list_directory',
      'run_shell': 'terminal/create',
    }
    return toolMap[toolCall.name] ?? toolCall.name
  }
}
```

### 6.3 Mission 约束持久化

```ts
// missionContext.ts

interface MissionConstraint {
  id: string
  description: string
  category: 'scope' | 'compatibility' | 'business_rule' | 'process' | 'prohibition'
}

interface MissionContextData {
  missionId: string
  goal: string
  successCriteria: Array<{
    id: string
    description: string
    required: boolean
    verification: string
  }>
  constraints: MissionConstraint[]
  outputContract: {
    deliverables: Array<{
      key: string
      description: string
      required: boolean
    }>
  }
  authorizationSummary: string
  budgetSummary: BudgetSummary
  recoveryContext?: RecoveryContextData
}

class MissionContext {
  private data: MissionContextData | null

  // 从宿主 session/prompt 参数中提取并保存
  extractFromPrompt(prompt: SessionPromptParams): MissionContextData

  // 每次上下文重建或压缩后重新注入
  injectToMessages(messages: NormalizedMessage[]): NormalizedMessage[]

  // 验证约束是否仍然满足（检查冲突）
  validateConstraints(): ConstraintValidationResult

  // 获取优先级规则（参见需求文档 §8.2）
  getPriorityRules(): PriorityRule[]
}
```

**Mission 约束优先级（需求文档 §8.2）：**
1. 当前 generation 的宿主强制安全策略与系统能力上限
2. 用户确认后由宿主规范化的 `authorizationScope` 和 `resourceBudget`
3. Mission 的 `goal`、`successCriteria`、`constraints`、`outputContract`
4. 当前 RecoveryContext 中由宿主标记为仍有效的约束和事实
5. Agent 的计划、工作记忆、历史摘要和 ProgressNote

### 6.4 结构化工作记忆

```ts
// workMemory.ts

interface BuiltinAgentWorkState {
  version: 1
  updatedAt: number
  currentPhase?: string
  phases: Array<{
    id: string
    status: 'pending' | 'in_progress' | 'done' | 'blocked'
  }>
  outputs: Record<string, string>  // key → worktree 路径
  notes: string[]
}

class WorkMemory {
  private basePath: string  // .space-assistant/runtime/

  constructor(basePath: string)

  // 读取工作记忆，损坏时降级返回空状态
  async load(): Promise<BuiltinAgentWorkState>

  // 保存工作记忆
  async save(state: BuiltinAgentWorkState): Promise<void>

  // 恢复时标注为"旧 Agent 自述"
  static annotateAsPreviousAgentClaims(state: BuiltinAgentWorkState): string[]
}
```

### 6.5 上下文压缩

```ts
// contextCompressor.ts

class ContextCompressor {
  private contextWindow: number | null
  private compressionRatio: number  // 默认 0.7
  private maxRetries: number = 3    // FR-INF-05: 有限重试次数

  // 判断是否需要压缩
  shouldCompress(estimatedTokens: number): boolean {
    if (!this.contextWindow) return false
    return estimatedTokens > this.contextWindow * this.compressionRatio
  }

  // 执行压缩：生成摘要，保留关键信息
  async compress(
    messages: NormalizedMessage[],
    missionContext: MissionContextData
  ): Promise<CompressionResult> {
    let lastError: Error | null = null

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        // 保留项（FR-INF-03）：
        // 1. Mission 硬约束（goal, successCriteria, constraints, outputContract, 预算摘要）
        // 2. 当前子任务上下文
        // 3. 最近 N 轮关键工具结果（保留最近 5 轮）
        // 4. 未决错误和状态
        // 5. 交付状态（哪些 deliverable 已完成/未完成）

        const preservedItems = this.extractPreservedItems(messages, missionContext)
        const toCompress = this.extractCompressibleItems(messages)

        // 通过 llmProxy 生成摘要（摘要调用计入 token 与时间预算）
        const summary = await this.generateSummary(toCompress, missionContext)

        return {
          success: true,
          summary,
          preservedItems,
          compressedCount: toCompress.length,
          estimatedTokensSaved: this.estimateTokens(toCompress) - this.estimateTokens([summary]),
        }
      } catch (error) {
        lastError = error as Error
        // FR-INF-05: 重试有限次
        if (attempt < this.maxRetries) {
          continue
        }
      }
    }

    // FR-INF-05: 所有重试失败 → 保留最近上下文并记录风险，不得无限调用
    return {
      success: false,
      error: lastError?.message ?? '压缩失败',
      fallbackMessages: this.keepRecentContext(messages),
      risk: '上下文未压缩，继续执行可能导致上下文溢出',
    }
  }

  // 摘要内容不得标记为宿主验证事实（FR-INF-06）
  private annotateSummary(summary: string): string {
    return `[Agent 生成的上下文摘要，非宿主验证事实]\n${summary}`
  }
}
```

### 6.6 分层失败处理

需求 §8.6 定义了四个层次的失败处理，Builtin 推理循环中按以下优先级级联：

```ts
// inferenceLoop.ts 中的分层失败处理

class InferenceLoop {
  private consecutiveFailures: number = 0
  private sameCategoryFailures: Map<string, number> = new Map()
  private stuckWarningReceived: boolean = false

  private async executeTool(toolCall: NormalizedToolCall): Promise<ToolResult> {
    try {
      const result = await this.transport.request(acpMethod, toolCall.params)
      // 成功 → 重置所有计数器
      this.consecutiveFailures = 0
      this.sameCategoryFailures.clear()
      this.stuckWarningReceived = false
      return { success: true, result }
    } catch (error) {
      // ===== 层次 1: 单次工具失败 =====
      // 将完整结构化错误返回 Agent，由 Agent 调整参数或方法
      const structuredError = this.normalizeError(error)
      this.consecutiveFailures++

      // 同类操作计数
      const category = this.getToolCategory(toolCall.name)
      const sameCategoryCount = (this.sameCategoryFailures.get(category) ?? 0) + 1
      this.sameCategoryFailures.set(category, sameCategoryCount)

      // ===== 层次 2: 同类操作连续失败达到策略阈值（默认 3 次） =====
      // 注入"更换策略"提示到上下文
      if (sameCategoryCount >= this.policy.sameCategoryFailureThreshold) {
        this.injectStrategyHint(category, sameCategoryCount)
      }

      return { success: false, error: structuredError }
    }
  }

  // 在 LLM 请求构建时注入策略提示
  private buildLlmRequest(): LlmChatParams {
    const messages = [...this.state.conversationHistory]

    // 层次 2: 同类操作连续失败 → 注入策略调整提示
    for (const [category, count] of this.state.sameCategoryFailures) {
      if (count >= this.policy.sameCategoryFailureThreshold) {
        messages.push({
          role: 'system',
          content: `[系统提示] ${category} 类操作已连续失败 ${count} 次。建议更换策略或方法。`,
        })
      }
    }

    // 层次 3: 宿主僵局警告已收到 → 在上下文中体现
    if (this.state.stuckWarningReceived) {
      messages.push({
        role: 'system',
        content: `[系统提示] 宿主检测到可能的执行僵局。请考虑从根本上改变当前策略，`
          + `或通过 wait_for_decision 请求用户决策。`,
      })
    }

    return { messages }
  }

  // 层次 4: 超时未改善 → 由宿主 StuckDetector 升级为 waiting
  // Builtin 内部不做 waiting 升级，由宿主僵局检测独立处理

  // 预算不足或任务不可完成 → 输出已完成内容和阻塞原因，不得伪报成功
  private async handleBudgetExceeded(): Promise<BuiltinRunOutcome> {
    return {
      kind: 'incomplete',
      reasonCode: 'RUN_BUDGET_EXCEEDED',
      summary: '预算已耗尽，无法完成全部任务',
      completedItems: this.state.completedItems,
      remainingItems: this.state.remainingItems,
      retryable: true,
    }
  }
}
```

**分层失败处理总结：**

| 层次 | 触发条件 | 处理方式 | 负责方 |
|---|---|---|---|
| 1 | 单次工具失败 | 将完整结构化错误返回 Agent，由 Agent 调整参数或方法 | Builtin 推理循环 |
| 2 | 同类操作连续失败达到策略阈值（默认 3 次） | 注入"更换策略"提示到 LLM 上下文 | Builtin 推理循环 |
| 3 | 达到宿主僵局阈值（连续失败 5 次/重复编辑 8 次/重复序列 3 轮） | 宿主发出僵局警告，Agent 收到后应改变策略 | AgentRunHost StuckDetector |
| 4 | 警告后仍无改善（5 分钟内再次触发） | AgentRun 进入 `waiting` 请求用户决策 | AgentRunHost StuckDetector |
| 5 | 预算不足或任务不可完成 | Agent 输出已完成内容、未完成项、阻塞原因和建议，不得伪报成功 | Builtin 推理循环 |
```

## 7. AgentRunHost 统一生命周期详细设计

### 7.1 状态机

```text
queued → starting → running
                      ├→ waiting → running
                      │     └→ parking → parked → recovering → running
                      ├→ crashed → recovering → running
                      ├→ submitting → reviewing → completed
                      ├→ failed
                      └→ cancelling → cancelled
```

### 7.2 AgentRunHost 核心接口

```ts
// agentRunHost.ts

class AgentRunHost {
  private backendRegistry: BackendRegistry
  private llmProxy: LlmProxy
  private toolGateway: ToolGateway
  private budgetManager: BudgetManager
  private checkpointInjector: CheckpointInjector
  private stuckDetector: StuckDetector
  private runOutcomeHandler: RunOutcomeHandler
  private eventWriter: RunEventWriter
  private snapshotProjector: SnapshotProjector

  // 启动一次 AgentRun
  async startRun(
    mission: Mission,
    run: AgentRun,
    backend: 'builtin' | 'codex'
  ): Promise<RunResult>

  // 取消运行中的 Run
  async cancelRun(runId: string, reason: string): Promise<void>

  // 从崩溃恢复
  async recoverRun(runId: string): Promise<RunResult>

  // 内部：Startup 阶段
  private async startupPhase(
    backend: BuiltinBackend,
    run: AgentRun,
    mission: Mission,
    recoveryContext?: RecoveryContext
  ): Promise<void> {
    // 1. 创建私有 worktree
    // 2. 启动 Builtin 子进程
    // 3. ACP initialize（超时：30s）
    // 4. ACP session/new（超时：30s）
    // 5. ACP session/prompt（超时：60s）
    // 任一步失败 → 关闭 transport、回收资源、记录结构化错误
  }

  // 内部：Running 阶段
  private async runningPhase(
    backend: BuiltinBackend,
    run: AgentRun
  ): Promise<BuiltinRunOutcomeEnvelope> {
    // 持续监控：
    // - LLM 请求通过 llmProxy 代理
    // - 工具请求通过 toolGateway 代理
    // - Checkpoint 按阈值注入
    // - 僵局检测持续运行
    // - 预算持续核算
    // - 取消信号随时可打断
    // 等待 session/prompt 最终响应（BuiltinRunOutcomeEnvelope）
  }

  // 内部：Completion 阶段
  private async completionPhase(
    outcome: BuiltinRunOutcomeEnvelope,
    run: AgentRun,
    mission: Mission
  ): Promise<void> {
    // 根据 outcome.kind 执行对应状态迁移
    // submit_candidate → submitting → scanning → Candidate → validation → review → completed
    // submit_partial_candidate → submitting → failed/waiting
    // wait_for_decision → waiting
    // incomplete → failed
    // failed → failed
  }
}
```

### 7.3 启动阶段详细流程

```ts
async function startupPhase(
  backend: BuiltinBackend,
  run: AgentRun,
  mission: Mission
): Promise<void> {
  const timeout = 30_000  // 启动总超时

  // Step 1: 创建私有 worktree
  const worktree = await workspaceManager.createPrivateWorktree(run.id)
  
  // Step 2: 启动 Builtin 子进程
  const childProcess = spawn('node', [builtinEntryPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: buildAllowlistEnv(),  // 不继承密钥
    windowsHide: true,         // Windows 不弹控制台
  })
  
  const transport = new AcpTransport({
    process: childProcess,
    timeoutMs: 30_000,
    maxMessageSize: 4 * 1024 * 1024,
  })

  // Step 3: ACP initialize
  const initResult = await transport.request('initialize', {
    protocolVersion: '1.0',
    clientInfo: { name: 'SpaceAssistant', version: appVersion },
    capabilities: {
      loadSession: false,
      streaming: true,
      tools: ['fs/read_text_file', 'fs/write_text_file', 'fs/grep', 
              'fs/list_directory', 'terminal/create', 'terminal/output', 
              'terminal/kill', '_llm/chat'],
    },
  })

  // 校验协议版本兼容
  if (!isCompatibleVersion(initResult.protocolVersion)) {
    throw new AcpError('ACP_VERSION_MISMATCH', '协议版本不兼容')
  }

  // Step 4: ACP session/new
  await transport.request('session/new', {
    sessionId: run.sessionId,
    cwd: worktree.path,
    contextWindow: modelContextWindow,
    allowedCapabilities: mission.authorizationScope.allowedTools,
    options: run.builtinOptions,
  })

  // Step 5: ACP session/prompt
  const executionToken = generateExecutionToken()
  await transport.request('session/prompt', {
    sessionId: run.sessionId,
    prompt: buildMissionPrompt(mission, run.recoveryContext),
    executionToken,
  })
  // 该请求的最终响应将是 BuiltinRunOutcomeEnvelope
  // 在此之前 Run 进入 running 状态
}

/**
 * SEC-01: 构造 Builtin 子进程的 allowlist 环境变量。
 * 不继承 LLM API Key、会话令牌、数据库凭据或外部集成密钥。
 */
function buildAllowlistEnv(): Record<string, string | undefined> {
  const ALLOWED_ENV_KEYS = new Set([
    'PATH', 'HOME', 'USERPROFILE',
    'TMP', 'TEMP', 'TMPDIR',
    'LANG', 'LC_ALL',
    'NODE_ENV',
    'SYSTEMROOT',
  ])
  const env: Record<string, string | undefined> = {}
  for (const key of ALLOWED_ENV_KEYS) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key]
    }
  }
  return env
}
```

### 7.4 取消流程

```ts
async function cancelRun(runId: string, reason: string): Promise<void> {
  // 1. 原子失效当前 generation
  await missionRepository.invalidateGeneration(runId)
  
  // 2. 状态迁移 running → cancelling
  await missionRepository.updateRunStatus(runId, 'cancelling')
  
  // 3. 向 Agent 发送 session/cancel
  await transport.request('session/cancel', {
    sessionId: run.sessionId,
    reason,
  })
  
  // 4. 中止进行中的 LLM 请求
  llmProxy.abortForRun(runId)
  
  // 5. 取消未决权限请求
  permissionHandler.cancelPendingForRun(runId)
  
  // 6. 所有 pending/in-progress 工具调用收敛为终态
  await toolGateway.drainForRun(runId)
  
  // 7. 终止该 Run 创建的终端及进程树
  await terminalManager.killAllForRun(runId)
  
  // 8. 宽限期（默认 5s）后强制终止 Agent 子进程
  setTimeout(() => {
    transport.close()
    processTreeController.forceKill(runId)
  }, 5_000)
  
  // 9. 资源释放确认后迁移 cancelled
  // 记录 finishedAt 与 resourcesReleasedAt
  await missionRepository.updateRunStatus(runId, 'cancelled', {
    finishedAt: Date.now(),
    resourcesReleasedAt: Date.now(),
  })
}
```

### 7.5 崩溃恢复流程

```ts
async function handleCrash(run: AgentRun, reason: string): Promise<void> {
  // 1. 旧 Run 标记 crashed
  await missionRepository.updateRunStatus(run.id, 'crashed')
  
  // 2. 封存 RecoveryBundle
  const recoveryBundle: RecoveryBundle = {
    missionId: run.missionId,
    runId: run.id,
    generation: run.generation,
    crashedAt: Date.now(),
    crashReason: reason,
    constraints: mission.constraints,
    snapshot: await snapshotProjector.project(run.id),
    worktreePath: run.worktreePath,
    preservedArtifacts: await workspaceObserver.listArtifacts(run.worktreePath),
    recentEvents: await eventWriter.getRecent(run.id, 50),
    pendingDecisions: await decisionRepository.getPending(run.id),
    previousAgentClaims: workMemory.readPreviousClaims(),
    hostObservations: stuckDetector.getObservations(run.id),
  }
  
  await recoveryRepository.save(recoveryBundle)
  
  // 3. Drain 旧 Run 资源
  await drainService.drain(run.id)
  
  // 4. 用户可创建新 Run（新 generation）恢复
  // 新 Run 的 prompt 必须区分可信约束、宿主观测和旧 Agent 自述
}
```

## 8. 后端选择与准入详细设计

### 8.1 BackendRegistry

```ts
// backendRegistry.ts

interface AgentBackendInfo {
  id: AgentBackend
  name: string
  version: string
  capabilities: string[]
  isBuiltin: boolean
}

interface BackendSelectionResult {
  backend: AgentBackend
  reason: string
  isFallback: boolean
}

class BackendRegistry {
  private backends: Map<string, AgentBackendAdapter>

  register(backend: AgentBackendAdapter): void

  // 自动选择后端
  async selectBackend(mission: Mission): Promise<BackendSelectionResult> {
    // 1. 若 Mission 或组织策略明确锁定某一后端 → 检查准入
    if (mission.lockedBackend) {
      const check = await this.checkAdmission(mission.lockedBackend, mission)
      if (!check.passed) {
        throw new BackendUnavailableError(mission.lockedBackend, check.reason)
      }
      return { backend: mission.lockedBackend, reason: '策略锁定', isFallback: false }
    }

    // 2. 优先使用满足全部硬准入条件的首选外部 Agent
    const codexCheck = await this.checkAdmission('codex', mission)
    if (codexCheck.passed) {
      return { backend: 'codex', reason: '首选外部 Agent 可用', isFallback: false }
    }

    // 3. 外部 Agent 不可用 → 自动选择 builtin
    const builtinCheck = await this.checkAdmission('builtin', mission)
    if (builtinCheck.passed) {
      return {
        backend: 'builtin',
        reason: `Codex 不可用：${codexCheck.reason}；自动回退 Builtin`,
        isFallback: true,
      }
    }

    // 4. 所有后端均不可用
    throw new AllBackendsUnavailableError({
      codex: codexCheck.reason,
      builtin: builtinCheck.reason,
    })
  }

  // 准入检查
  async checkAdmission(backend: AgentBackend, mission: Mission): Promise<AdmissionCheck> {
    if (backend === 'builtin') {
      return this.checkBuiltinAdmission(mission)
    }
    return this.checkCodexAdmission()
  }

  private async checkBuiltinAdmission(mission: Mission): Promise<AdmissionCheck> {
    const checks: AdmissionCheck[] = []

    // 1. 内置子进程产物存在且校验通过
    checks.push(await this.verifyBuiltinArtifact())

    // 2. ACP 协议版本兼容
    checks.push(await this.verifyAcpVersion())

    // 3. 至少一个启用且健康的 LLM 服务及模型
    checks.push(await this.verifyLlmAvailability())

    // 4. 模型支持工具调用格式
    checks.push(await this.verifyToolCallSupport())

    // 5. Mission 私有 worktree 可创建
    checks.push(await this.verifyWorktreeCreatable(mission))

    // 6. 预算、路径和权限策略可初始化
    checks.push(await this.verifyPoliciesInitializable(mission))

    // 7. 子进程启动环境不包含宿主密钥
    checks.push(this.verifyNoKeyLeak())

    const failed = checks.find(c => !c.passed)
    return failed ?? { passed: true }
  }
}
```

### 8.2 回退行为

- 自动回退不需要二次确认（前提：Mission 目标、授权和预算未扩大）
- 回退原因写入 AgentRun 启动事件和诊断日志
- 不因后端变化扩大工具、网络、路径或外部系统授权
- 外部 Agent 运行中崩溃 → 不允许在同一 AgentRun 内热切换 Builtin
- 崩溃恢复必须结束旧 Run、增加 generation、按当前准入规则创建新 Run

## 9. `_llm/chat` 宿主代理详细设计

### 9.1 LlmProxy

```ts
// llmProxy.ts

class LlmProxy {
  private llmServices: Map<string, LlmServiceAdapter>

  // 执行 LLM 调用
  async chat(
    params: LlmChatParams,
    context: RunContext
  ): Promise<LlmChatResult> {
    // 1. 安全校验
    this.validateCaller(context)  // 校验 PID、进程存活、session/run/generation

    // 2. 预算预检
    await this.budgetManager.preCheckLlm(context.runId, params.maxOutputTokens)

    // 3. 模型选择（宿主最终裁决）
    const model = this.resolveModel(params.modelHint, context.run)

    // 4. 获取 LLM 服务适配器
    const service = this.getServiceForModel(model)

    // 5. 规范化消息转换
    const providerMessages = service.normalizeMessages(params.messages)
    const providerTools = params.tools ? service.normalizeTools(params.tools) : undefined

    // 6. 调用 LLM 服务
    const stream = await service.chat({
      model: model.id,
      messages: providerMessages,
      tools: providerTools,
      system: params.system,
      maxOutputTokens: params.maxOutputTokens,
      thinkingBudget: params.thinkingBudget,
    })

    // 7. 流式处理
    let fullMessage: NormalizedAssistantMessage | null = null
    for await (const chunk of stream) {
      // 检查取消
      if (context.isCancelled) {
        service.abort()
        return this.buildCancelledResponse()
      }
      
      // 文本增量 → session/update.agent_message_chunk
      if (chunk.type === 'text') {
        this.pushChunkToUI(context.runId, chunk.text)
      }
    }

    // 8. 获取完整响应
    fullMessage = await stream.finalize()

    // 9. 规范化响应
    const normalized = service.normalizeResponse(fullMessage)

    // 10. 预算核算
    await this.budgetManager.recordLlmUsage(context.runId, normalized.usage)

    return normalized
  }

  // 中止某 Run 的所有 LLM 请求
  abortForRun(runId: string): void

  // 安全校验
  private validateCaller(context: RunContext): void {
    // 1. 校验 transport 对应 PID 存活
    if (!isProcessAlive(context.pid)) {
      throw new AcpError('AGENT_PROCESS_CRASHED', '子进程已退出')
    }
    // 2. 校验 session/run/generation 绑定
    if (!context.isGenerationValid) {
      throw new AcpError('GENERATION_INVALID', 'generation 已失效')
    }
    // 3. 校验非 Builtin transport 不得调用
    if (context.backend !== 'builtin') {
      throw new SecurityError('_llm/chat 仅 Builtin 可用')
    }
    // 4. 校验预算未超限
    if (context.isBudgetExceeded) {
      throw new AcpError('RUN_BUDGET_EXCEEDED', '预算已耗尽')
    }
  }
}
```

### 9.2 LLM 服务适配

```ts
interface LlmServiceAdapter {
  // 将规范化消息转换为服务商格式
  normalizeMessages(messages: NormalizedMessage[]): ProviderMessage[]
  
  // 将规范化工具定义转换为服务商格式
  normalizeTools(tools: NormalizedTool[]): ProviderTool[]
  
  // 执行 LLM 调用
  chat(params: ProviderChatParams): Promise<ChatStream>
  
  // 将服务商响应转换为规范化格式
  normalizeResponse(response: ProviderResponse): NormalizedAssistantMessage
  
  // 中止请求
  abort(): void
}

// 规范化消息类型
interface NormalizedMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | NormalizedContentBlock[]
  toolCalls?: NormalizedToolCall[]
  toolCallId?: string
  name?: string
}

interface NormalizedAssistantMessage {
  role: 'assistant'
  content: string | NormalizedContentBlock[]
  toolCalls?: NormalizedToolCall[]
}

interface NormalizedToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

interface NormalizedTool {
  name: string
  description: string
  parameters: Record<string, unknown>  // JSON Schema
}
```

## 10. 工具执行与权限详细设计

### 10.1 ToolGateway

```ts
// toolGateway.ts

class ToolGateway {
  private permissionHandler: PermissionHandler
  private budgetManager: BudgetManager
  private pathSecurity: PathSecurity

  // 执行工具调用
  async executeTool(
    toolName: string,
    params: Record<string, unknown>,
    context: RunContext
  ): Promise<ToolResult> {
    // 1. Generation fencing 校验
    if (!context.isGenerationValid) {
      return { success: false, error: 'GENERATION_INVALID' }
    }

    // 2. 预算预检
    await this.budgetManager.preCheckTool(context.runId, toolName)

    // 3. 路径安全校验（如适用）
    if (this.requiresPathCheck(toolName)) {
      const pathCheck = await this.pathSecurity.validate(params.path, context.worktreePath)
      if (!pathCheck.allowed) {
        return { success: false, error: 'PATH_OUT_OF_SCOPE', reason: pathCheck.reason }
      }
    }

    // 4. 权限判定
    const permission = await this.permissionHandler.evaluate(toolName, params, context)
    if (permission === 'rejected') {
      return { success: false, error: 'TOOL_PERMISSION_REJECTED' }
    }
    if (permission === 'pending_confirmation') {
      // 等待用户确认（通过确认卡片）
      const userDecision = await this.permissionHandler.waitForConfirmation(context)
      if (userDecision !== 'approved') {
        return { success: false, error: 'TOOL_PERMISSION_REJECTED' }
      }
    }

    // 5. 执行工具
    const result = await this.dispatchTool(toolName, params, context)

    // 6. 预算核算
    await this.budgetManager.recordToolUsage(context.runId, toolName, result.usage)

    return result
  }

  // 工具调度
  private async dispatchTool(
    toolName: string,
    params: Record<string, unknown>,
    context: RunContext
  ): Promise<ToolResult> {
    switch (toolName) {
      case 'fs/read_text_file':
        return this.readFile(params.path, context.worktreePath)
      case 'fs/write_text_file':
        return this.writeFile(params.path, params.content, context.worktreePath)
      case 'fs/grep':
        return this.grep(params.pattern, params.path, context.worktreePath)
      case 'fs/list_directory':
        return this.listDirectory(params.path, context.worktreePath)
      case 'terminal/create':
        return this.terminalManager.create(params.command, params.args, params.cwd, context)
      case 'terminal/output':
        return this.terminalManager.readOutput(params.terminalId, params.offset, params.limit)
      case 'terminal/kill':
        return this.terminalManager.kill(params.terminalId)
      default:
        return { success: false, error: 'UNKNOWN_TOOL' }
    }
  }

  // Drain 某 Run 的所有工具调用
  async drainForRun(runId: string): Promise<void> {
    // 所有 pending/in-progress 工具调用收敛为终态
    // 取消等待中的确认
    this.permissionHandler.cancelPendingForRun(runId)
    // 终止所有终端
    await this.terminalManager.killAllForRun(runId)
  }
}
```

### 10.2 工具→模型工具映射

```ts
// Builtin 内部映射（在 inferenceLoop 中）
const MODEL_TOOL_TO_ACP: Record<string, string> = {
  'read_file': 'fs/read_text_file',
  'write_file': 'fs/write_text_file',
  'edit_file': 'fs/write_text_file',  // 宿主内部处理为原子编辑
  'grep': 'fs/grep',
  'list_directory': 'fs/list_directory',
  'run_shell': 'terminal/create',
}

// 工具 schema 由宿主能力协商结果动态生成
// 禁止向模型声明实际不可用的工具
function buildModelTools(allowedCapabilities: string[]): NormalizedTool[] {
  const tools: NormalizedTool[] = []
  for (const cap of allowedCapabilities) {
    switch (cap) {
      case 'fs/read_text_file':
        tools.push({
          name: 'read_file',
          description: '读取指定文件内容',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: '文件路径（相对于 worktree）' },
              offset: { type: 'number', description: '起始行号（1-based）' },
              limit: { type: 'number', description: '最多读取行数' },
            },
            required: ['path'],
          },
        })
        break
      // ... 其他工具
    }
  }
  return tools
}
```

### 10.3 权限处理

```ts
// permissionHandler.ts

class PermissionHandler {
  // 评估工具调用风险
  async evaluate(
    toolName: string,
    params: Record<string, unknown>,
    context: RunContext
  ): Promise<'auto_approved' | 'pending_confirmation' | 'rejected'> {
    // 1. 检查是否在 Mission 授权范围内
    if (!context.authorizationScope.allowedTools.includes(toolName)) {
      return 'rejected'
    }

    // 2. 根据工具类型和参数判定风险
    const risk = this.assessRisk(toolName, params)

    // 3. 低风险 + 自动模式 → 自动放行
    if (risk === 'low' && context.interactionMode === 'auto') {
      return 'auto_approved'
    }

    // 4. 高风险或越界 → 需要确认或拒绝
    if (risk === 'high') {
      if (this.isWithinScope(toolName, params, context.authorizationScope)) {
        return 'pending_confirmation'
      }
      return 'rejected'
    }

    // 5. 中风险 → 需要确认
    return 'pending_confirmation'
  }

  // 评估风险
  private assessRisk(toolName: string, params: Record<string, unknown>): 'low' | 'medium' | 'high' {
    switch (toolName) {
      case 'fs/read_text_file':
      case 'fs/grep':
      case 'fs/list_directory':
        return 'low'
      case 'fs/write_text_file':
        return 'medium'
      case 'terminal/create':
        return this.assessCommandRisk(params.command as string)
      default:
        return 'high'  // 未知工具默认高风险
    }
  }

  // 取消某 Run 的未决确认
  cancelPendingForRun(runId: string): void
}
```

### 10.4 路径安全

```ts
// 路径安全校验（复用并扩展 electron/pathSecurity.ts）

class PathSecurity {
  async validate(
    rawPath: string,
    worktreePath: string,
    authorizationScope: AuthorizationScope
  ): Promise<PathCheckResult> {
    // 1. 相对 worktree 解析
    const resolvedPath = path.resolve(worktreePath, rawPath)

    // 2. 真实路径检查（解析符号链接）
    const realPath = await fs.realpath(resolvedPath)

    // 3. 检查是否在 worktree 内
    if (!realPath.startsWith(worktreePath)) {
      return { allowed: false, reason: 'PATH_OUT_OF_SCOPE: 路径越界' }
    }

    // 4. 检查是否在更窄的授权范围内
    if (authorizationScope.pathAllowlist) {
      const inAllowlist = authorizationScope.pathAllowlist.some(
        allowed => realPath.startsWith(path.join(worktreePath, allowed))
      )
      if (!inAllowlist) {
        return { allowed: false, reason: 'PATH_OUT_OF_SCOPE: 不在授权路径范围内' }
      }
    }

    // 5. 检查保留目录
    if (this.isReservedPath(realPath, worktreePath)) {
      return { allowed: false, reason: 'PATH_OUT_OF_SCOPE: 保留目录不可写' }
    }

    // 6. 写冲突检测（对于写操作）
    // 7. 路径 lease 检测

    return { allowed: true }
  }

  private isReservedPath(realPath: string, worktreePath: string): boolean {
    const reservedDirs = [
      '.space-assistant',
      '.git',
      'node_modules',
    ]
    const relativePath = path.relative(worktreePath, realPath)
    return reservedDirs.some(dir => relativePath.startsWith(dir))
  }
}
```

## 11. Checkpoint、僵局与预算详细设计

### 11.1 CheckpointInjector

```ts
// checkpointInjector.ts

interface CheckpointThreshold {
  type: 'tool_call_count' | 'duration' | 'interval'
  ratios: number[]  // 例如 [0.25, 0.5, 0.75]
  firedForRun: Set<string>  // 已触发集合（每个阈值每个 Run 只触发一次）
}

class CheckpointInjector {
  private thresholds: CheckpointThreshold[]

  constructor() {
    this.thresholds = [
      { type: 'tool_call_count', ratios: [0.25, 0.5, 0.75], firedForRun: new Set() },
      { type: 'duration', ratios: [0.3, 0.6, 0.9], firedForRun: new Set() },
    ]
  }

  // 每次工具调用/时间推进后检查
  async checkAndInject(
    runId: string,
    currentUsage: BudgetUsage,
    missionGoal: string,
    successCriteria: SuccessCriterion[]
  ): Promise<CheckpointEvent | null> {
    for (const threshold of this.thresholds) {
      const currentValue = this.getCurrentValue(threshold.type, currentUsage)
      const maxValue = this.getMaxValue(threshold.type, currentUsage)
      if (maxValue === 0) continue

      const ratio = currentValue / maxValue
      for (const triggerRatio of threshold.ratios) {
        const key = `${runId}:${threshold.type}:${triggerRatio}`
        if (ratio >= triggerRatio && !threshold.firedForRun.has(key)) {
          threshold.firedForRun.add(key)

          // 生成目标检查清单
          const checklist = this.buildChecklist(missionGoal, successCriteria)

          // 生成 Checkpoint 事件
          const checkpoint: CheckpointEvent = {
            runId,
            type: 'checkpoint',
            ratio,
            currentValue,
            maxValue,
            threshold: threshold.type,
            checklist,
            timestamp: Date.now(),
          }

          return checkpoint
        }
      }
    }

    // 距上次 checkpoint 超过 30 分钟
    const lastCheckpoint = this.getLastCheckpointTime(runId)
    if (Date.now() - lastCheckpoint > 30 * 60 * 1000) {
      return this.generateIntervalCheckpoint(runId, currentUsage)
    }

    return null
  }

  private buildChecklist(goal: string, criteria: SuccessCriterion[]): string[] {
    // 摘要失败时直接使用原始成功标准
    try {
      return criteria.map(c => `[${c.required ? '*' : ' '}] ${c.description}`)
    } catch {
      return criteria.map(c => c.description)
    }
  }
}
```

### 11.2 StuckDetector

```ts
// stuckDetector.ts

interface StuckSignal {
  type: 'consecutive_tool_failure' | 'repeated_file_edit' | 'repeated_tool_sequence'
  threshold: number
  window: StuckWindow
}

interface StuckWindow {
  failures: number
  edits: Map<string, number>  // path → edit count
  sequences: Array<{ tools: string[]; rounds: number }>
  lastReset: number
}

class StuckDetector {
  private signals: StuckSignal[]
  private windows: Map<string, StuckWindow>  // runId → window
  private warningHistory: Map<string, number>  // runId → last warning time

  constructor() {
    this.signals = [
      { type: 'consecutive_tool_failure', threshold: 5, window: defaultWindow },
      { type: 'repeated_file_edit', threshold: 8, window: defaultWindow },
      { type: 'repeated_tool_sequence', threshold: 3, window: defaultWindow },
    ]
  }

  // 每次工具调用后检查
  recordToolCall(runId: string, toolName: string, params: Record<string, unknown>, result: ToolResult): StuckDetectionResult {
    const window = this.getOrCreateWindow(runId)

    // 更新窗口
    if (result.success) {
      window.failures = 0
    } else {
      window.failures++
    }

    if (toolName === 'edit_file' || toolName === 'write_file') {
      const path = params.path as string
      window.edits.set(path, (window.edits.get(path) ?? 0) + 1)
    }

    // 更新序列
    this.updateSequences(window, toolName)

    // 检测
    for (const signal of this.signals) {
      if (this.isSignalTriggered(signal, window)) {
        return this.handleStuckDetection(runId, signal, window)
      }
    }

    return { stuck: false }
  }

  private handleStuckDetection(runId: string, signal: StuckSignal, window: StuckWindow): StuckDetectionResult {
    const lastWarning = this.warningHistory.get(runId) ?? 0
    const now = Date.now()

    // 首次触发 → 僵局警告
    if (lastWarning === 0) {
      this.warningHistory.set(runId, now)
      return {
        stuck: true,
        level: 'warning',
        signal: signal.type,
        message: `检测到可能的僵局：${signal.type}`,
      }
    }

    // 5 分钟内再次触发 → 升级
    if (now - lastWarning < 5 * 60 * 1000) {
      this.warningHistory.set(runId, now)
      return {
        stuck: true,
        level: 'escalation',
        signal: signal.type,
        message: `僵局持续：${signal.type}，建议进入 waiting`,
      }
    }

    // 重置窗口
    this.resetWindow(runId)
    return { stuck: false }
  }

  // 成功执行不同策略或完成关键进展时重置
  resetWindow(runId: string): void {
    this.windows.delete(runId)
    this.warningHistory.delete(runId)
  }
}
```

### 11.3 BudgetManager

```ts
// budgetManager.ts

interface BudgetLimit {
  maxTokens: number
  maxToolCalls: number
  maxDurationMinutes: number
  maxTerminalOutputBytes: number
  maxConcurrentTerminals: number
}

interface BudgetUsage {
  tokens: { input: number; output: number }
  toolCalls: number
  durationMs: number
  terminalOutputBytes: number
  activeTerminals: number
}

class BudgetManager {
  private limits: Map<string, BudgetLimit>  // runId → limits
  private usage: Map<string, BudgetUsage>   // runId → current usage
  private softThresholds: { [K in keyof BudgetUsage]?: number }  // 软阈值比例

  // 预检 LLM 调用
  async preCheckLlm(runId: string, estimatedTokens: number): Promise<void> {
    const limit = this.limits.get(runId)
    const usage = this.usage.get(runId)
    if (!limit || !usage) return

    if (usage.tokens.input + usage.tokens.output + estimatedTokens > limit.maxTokens) {
      // 硬阈值：拒绝
      throw new BudgetExceededError('RUN_BUDGET_EXCEEDED', 'token', limit.maxTokens)
    }

    // 软阈值：注入 checkpoint
    const ratio = (usage.tokens.input + usage.tokens.output) / limit.maxTokens
    if (ratio >= (this.softThresholds.tokens ?? 0.8)) {
      this.emitSoftThresholdWarning(runId, 'tokens', ratio)
    }
  }

  // 预检工具调用
  async preCheckTool(runId: string, toolName: string): Promise<void> {
    const limit = this.limits.get(runId)
    const usage = this.usage.get(runId)
    if (!limit || !usage) return

    if (usage.toolCalls >= limit.maxToolCalls) {
      throw new BudgetExceededError('RUN_BUDGET_EXCEEDED', 'tool_calls', limit.maxToolCalls)
    }
  }

  // 记录 LLM 用量
  async recordLlmUsage(runId: string, usage: { inputTokens: number; outputTokens: number }): Promise<void>

  // 记录工具用量
  async recordToolUsage(runId: string, toolName: string, usage: ToolUsage): Promise<void>

  // 硬预算超限：为 Agent 保留有限收尾额度
  async reserveWindDownBudget(runId: string): Promise<BudgetLimit> {
    // 收尾额度：仅允许少量 token 用于总结，禁止高成本工具
    return {
      maxTokens: 2000,
      maxToolCalls: 0,
      maxDurationMinutes: 1,
      maxTerminalOutputBytes: 0,
      maxConcurrentTerminals: 0,
    }
  }
}
```

## 12. Run 级结构化结束协议详细设计

### 12.1 BuiltinRunOutcome 类型

```ts
// 公共信封
interface BuiltinRunOutcomeEnvelope {
  protocolVersion: 1
  source: 'builtin' | 'host'
  missionId: string
  runId: string
  generation: number
  sessionId: string
  executionToken: string
  outcomeId: string
  outcome: BuiltinRunOutcome
}

type BuiltinRunOutcome =
  | SubmitCandidateOutcome
  | SubmitPartialCandidateOutcome
  | WaitForDecisionOutcome
  | IncompleteOutcome
  | FailedOutcome

interface SubmitCandidateOutcome {
  kind: 'submit_candidate'
  summary: string
  claimedDeliverableKeys: string[]
}

interface SubmitPartialCandidateOutcome {
  kind: 'submit_partial_candidate'
  summary: string
  completedItems: string[]
  remainingItems: string[]
  claimedDeliverableKeys: string[]
  reasonCode: string
}

interface WaitForDecisionOutcome {
  kind: 'wait_for_decision'
  summary: string
  decision: {
    kind: 'missing_information' | 'stuck'
    question: string
    reason: string
    options?: Array<{ id: string; label: string }>
    allowFreeText: boolean
  }
}

interface IncompleteOutcome {
  kind: 'incomplete'
  reasonCode: string
  summary: string
  completedItems: string[]
  remainingItems: string[]
  retryable: boolean
}

interface FailedOutcome {
  kind: 'failed'
  errorCode: string
  summary: string
  retryable: boolean
}
```

### 12.2 RunOutcomeHandler

```ts
// runOutcomeHandler.ts

class RunOutcomeHandler {
  // 接收并校验 outcome
  async acceptOutcome(
    envelope: BuiltinRunOutcomeEnvelope,
    context: RunContext
  ): Promise<OutcomeAcceptanceResult> {
    // 1. JSON-RPC 响应对应当前未决 session/prompt request ID
    // （由 transport 层保证）

    // 2. Schema 校验
    const schemaResult = this.validateSchema(envelope)
    if (!schemaResult.valid) {
      return { accepted: false, error: 'ACP_RUN_OUTCOME_INVALID', reason: schemaResult.reason }
    }

    // 3. Identity 校验
    const identityCheck = this.validateIdentity(envelope, context)
    if (!identityCheck.passed) {
      return { accepted: false, error: 'ACP_RUN_OUTCOME_INVALID', reason: identityCheck.reason }
    }

    // 4. executionToken 校验
    const tokenCheck = await this.validateAndConsumeToken(envelope.executionToken, context)
    if (!tokenCheck.valid) {
      return { accepted: false, error: 'ACP_RUN_OUTCOME_INVALID', reason: tokenCheck.reason }
    }

    // 5. Generation 有效性
    if (!context.isGenerationValid) {
      return { accepted: false, error: 'GENERATION_INVALID' }
    }

    // 6. Run 状态允许接受 outcome
    if (!this.canAcceptOutcome(context.runStatus)) {
      return { accepted: false, error: 'RUN_STATUS_INVALID', reason: `当前状态 ${context.runStatus} 不接受 outcome` }
    }

    // 7. 字段约束校验
    const fieldCheck = this.validateFields(envelope.outcome, context)
    if (!fieldCheck.passed) {
      return { accepted: false, error: 'ACP_RUN_OUTCOME_INVALID', reason: fieldCheck.reason }
    }

    // 8. 幂等处理（事务）
    const existing = await this.findExistingOutcome(context.runId, context.generation, envelope.executionToken)
    if (existing) {
      if (this.isIdenticalOutcome(existing, envelope)) {
        return { accepted: true, alreadyAccepted: true, outcome: existing }
      }
      return { accepted: false, error: 'ACP_RUN_OUTCOME_INVALID', reason: '协议冲突：相同 token 不同内容' }
    }

    // 9. 事务化持久化 + 状态比较交换
    const result = await this.persistAndTransition(envelope, context)
    return result
  }

  private validateIdentity(envelope: BuiltinRunOutcomeEnvelope, context: RunContext): CheckResult {
    if (envelope.missionId !== context.missionId) return { passed: false, reason: 'missionId 不匹配' }
    if (envelope.runId !== context.runId) return { passed: false, reason: 'runId 不匹配' }
    if (envelope.generation !== context.generation) return { passed: false, reason: 'generation 不匹配' }
    if (envelope.sessionId !== context.sessionId) return { passed: false, reason: 'sessionId 不匹配' }
    if (envelope.source !== 'builtin') return { passed: false, reason: 'source 必须为 builtin' }
    return { passed: true }
  }

  private canAcceptOutcome(status: AgentRunStatus): boolean {
    // cancelling、cancelled、crashed、completed、failed 等终态不接受
    return status === 'running' || status === 'waiting'
  }

  // 终态竞争优先级（参见需求文档 §9.5.4）
  // 1. generation 已失效或用户取消已提交 → 取消获胜
  // 2. 宿主已确认硬预算耗尽 → 宿主 source:'host' 收尾
  // 3. 已成功事务化接受的有效 outcome → 不被后续覆盖
  // 4. outcome 尚未被接受时 transport 断开 → 按崩溃处理
  // 5. 同时到达的多个候选 → 只有首次 CAS 成功者被接受
}
```

### 12.3 Outcome 与状态迁移

| Outcome | AgentRunHost 行为 | 状态迁移 |
|---|---|---|
| `submit_candidate` | 停止接收新工具调用，回收执行资源，扫描 worktree，固化 Candidate，执行验证与 Review | `running → submitting → reviewing? → completed/failed/waiting` |
| `submit_partial_candidate` | 生成明确标记为 incomplete 的 Candidate，固化现有成果并执行验证 | `running → submitting → failed`（或 waiting 等待用户决定） |
| `wait_for_decision` | 校验 Decision 草案，创建权威 MissionDecision；宽限期内保留 Run，超时后 park | `running → waiting → running`，或 `waiting → parking → parked` |
| `incomplete` | 不生成 Candidate；封存 RecoveryBundle 和工作区成果 | `running → failed` |
| `failed` | 不生成 Candidate；封存诊断与可恢复成果 | `running → failed` |

## 13. 数据持久化详细设计

### 13.1 AgentRun 扩展

```sql
-- 在现有 AgentRun 表基础上扩展
ALTER TABLE agent_run ADD COLUMN backend TEXT NOT NULL DEFAULT 'codex';
ALTER TABLE agent_run ADD COLUMN backend_selection_reason TEXT;
ALTER TABLE agent_run ADD COLUMN backend_capabilities TEXT;  -- JSON
ALTER TABLE agent_run ADD COLUMN builtin_options TEXT;       -- JSON, AgentRunBuiltinOptions

-- 新增 Run Outcome 表
CREATE TABLE run_outcome (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  execution_token TEXT NOT NULL,
  outcome_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('builtin', 'host')),
  kind TEXT NOT NULL,
  envelope TEXT NOT NULL,  -- JSON: BuiltinRunOutcomeEnvelope
  accepted_at INTEGER NOT NULL,
  UNIQUE(run_id, generation, execution_token)
);

-- 新增 Checkpoint 事件表
CREATE TABLE checkpoint_event (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  type TEXT NOT NULL,
  ratio REAL,
  checklist TEXT,  -- JSON
  timestamp INTEGER NOT NULL
);

-- 新增僵局事件表
CREATE TABLE stuck_event (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('warning', 'escalation')),
  signal TEXT NOT NULL,
  message TEXT NOT NULL,
  timestamp INTEGER NOT NULL
);
```

### 13.2 RunSnapshot 投影

```ts
interface RunSnapshot {
  runId: string
  missionId: string
  status: AgentRunStatus
  phase: string
  backend: AgentBackend
  generation: number
  latestProgress: string | null
  recentTools: Array<{
    toolCallId: string
    toolName: string
    status: ToolCallStatus
    timestamp: number
  }>
  planSummary: string | null  // 非权威
  budget: {
    tokens: { input: number; output: number; limit: number }
    toolCalls: { used: number; limit: number }
    durationMs: { elapsed: number; limit: number }
    terminalOutputBytes: { used: number; limit: number }
  }
  worktreeChanges: {
    filesAdded: number
    filesModified: number
    filesDeleted: number
  }
  latestCheckpoint: CheckpointEvent | null
  latestStuckWarning: StuckEvent | null
  pendingPermissions: number
  pendingDecisions: number
  processAlive: boolean
  updatedAt: number
}
```

### 13.3 事件持久化

事件类型至少包括：
- `agent_message_chunk`：Agent 文本增量
- `plan`：非权威计划及步骤状态
- `tool_call`：工具调用创建
- `tool_call_update`：工具状态变更
- `usage_update`：累计用量
- `checkpoint`：宿主检查点
- `stuck_warning`：僵局警告
- `diagnostic`：脱敏诊断

## 14. 用户界面设计

### 14.1 Mission 创建

- Mission 预览展示目标、成功标准、权限、预算和交付合同
- 不要求用户选择 Builtin 或理解 ACP
- 若所有后端均不可用，确认前显示阻塞原因
- 若只能使用 Builtin，提示"将使用内置执行引擎"，不制造能力贬损暗示

### 14.2 Mission 列表

每项显示：
- Mission 标题
- 当前状态
- 进度摘要
- 运行时长和预算占用
- waiting / 权限 / 用户决策提醒
- 完成、失败、取消或恢复状态

后端标识作为次要诊断信息。

### 14.3 Mission 详情

至少包含：
- 目标、成功标准和授权边界
- 实际后端及选择/回退原因
- 当前计划摘要和近期 ProgressNote
- 工具调用时间线及终态
- token、工具次数、时长和预算
- checkpoint、僵局警告与用户 Decision
- worktree 变更和 Candidate / Review 状态
- 取消操作
- 失败时的错误、已保留成果和恢复入口

### 14.4 权限与 Decision

- 有待确认操作时明显提示并聚焦到对应卡片
- 卡片显示该操作来自后台 Mission
- 用户离开详情页后通过全局通知提示
- 历史事件只读，不允许对旧 generation 的卡片再次作答
- parked 后用户作答触发"创建恢复 Run"

### 14.5 i18n

所有新增文案使用 i18n key，禁止硬编码。状态不得只用颜色区分。工具、预算和警告时间线支持键盘访问。屏幕阅读器能读出 Mission、风险、待确认动作和按钮结果。

## 15. 打包与跨平台详细设计

### 15.1 Builtin 编译产物

Builtin 子进程脚本使用独立 Node 入口，不依赖 Electron 运行时的模块。在 electron-builder 中配置 `asarUnpack`：

```yaml
# electron-builder.yml
asarUnpack:
  - "dist-electron/builtinSubAgent/**"
  - "node_modules/zod/**"
  - "node_modules/@anthropic-ai/**"
```

### 15.2 路径解析

```ts
// 统一的 Builtin 入口路径解析
function resolveBuiltinEntryPath(): string {
  if (app.isPackaged) {
    // 打包环境：从 asarUnpack 目录获取
    return path.join(process.resourcesPath, 'app.asar.unpacked', 'dist-electron', 'builtinSubAgent', 'builtinAgentProcess.js')
  }
  // 开发环境
  return path.join(__dirname, '..', 'builtinSubAgent', 'builtinAgentProcess.js')
}
```

### 15.3 平台适配

| 平台 | 要点 |
|---|---|
| Windows | `windowsHide: true` 避免弹控制台；使用 `taskkill /T /PID` 终止进程树 |
| macOS | 使用进程组 ID (`setpgid`) 回收孙进程；`kill(-pgid, SIGTERM)` |
| Linux | 同 macOS 进程组机制 |

### 15.4 打包校验脚本

```ts
// scripts/verify-builtin.ts
async function verifyBuiltin(): Promise<void> {
  // 1. 检查入口文件存在
  const entryPath = resolveBuiltinEntryPath()
  if (!fs.existsSync(entryPath)) {
    throw new Error('BUILTIN_ARTIFACT_MISSING: 入口文件不存在')
  }

  // 2. 启动子进程并完成最小握手
  const child = spawn('node', [entryPath], { stdio: ['pipe', 'pipe', 'pipe'] })
  const transport = new AcpTransport({ process: child, timeoutMs: 10_000, maxMessageSize: 4 * 1024 * 1024 })

  const result = await transport.request('initialize', {
    protocolVersion: '1.0',
    clientInfo: { name: 'VerifyScript', version: '1.0' },
    capabilities: { loadSession: false, streaming: true, tools: [] },
  })

  if (result.protocolVersion !== '1.0') {
    throw new Error('ACP_VERSION_MISMATCH')
  }

  transport.close()
  console.log('Builtin 校验通过')
}
```

## 16. 错误处理规范

### 16.1 稳定错误码

| 错误码 | 场景 | 用户行为 |
|---|---|---|
| `BUILTIN_ARTIFACT_MISSING` | 内置产物缺失或损坏 | 重新安装/修复应用 |
| `ACP_VERSION_MISMATCH` | 协议版本不兼容 | 更新应用 |
| `ACP_HANDSHAKE_TIMEOUT` | 握手超时 | 重试并查看诊断 |
| `LLM_PROFILE_UNAVAILABLE` | 无可用 LLM 服务或模型 | 前往模型设置 |
| `LLM_PROXY_TIMEOUT` | 模型调用超时 | 自动有限重试或恢复 |
| `RUN_BUDGET_EXCEEDED` | 达到硬预算 | 查看部分成果并调整预算重试 |
| `WORKTREE_CREATE_FAILED` | 私有工作树创建失败 | 检查仓库和磁盘 |
| `PATH_OUT_OF_SCOPE` | 工具路径越界 | Agent 调整方案或用户修改授权 |
| `TOOL_PERMISSION_REJECTED` | 用户或策略拒绝 | Agent 调整方案 |
| `TERMINAL_PROCESS_FAILED` | 命令启动或运行失败 | 查看脱敏 stderr |
| `AGENT_PROCESS_CRASHED` | Builtin 子进程异常退出 | 创建恢复 Run |
| `ACP_RUN_OUTCOME_INVALID` | Run outcome 缺失/格式错误/冲突 | 拒绝结果并按崩溃恢复 |
| `AGENT_STUCK` | 僵局升级 | 用户提供决策或结束 |
| `RUN_CANCELLED` | 用户取消 | 查看已保留但未导入成果 |

### 16.2 错误结构

```ts
interface StructuredError {
  code: string                 // 稳定错误码
  userMessage: string          // 面向用户的本地化摘要
  technicalReason: string      // 脱敏技术原因
  missionId: string
  runId: string
  generation: number
  retryable: boolean
  recommendedAction: string    // 推荐下一步
  resourcesCleanedUp: boolean  // 已创建资源是否清理完成
}
```

## 17. 测试策略

### 17.1 单元测试

| 测试范围 | 覆盖内容 |
|---|---|
| ACP 协议 | 序列化、schema 校验、请求匹配、超时、关闭、错误响应、未知方法、无效参数 |
| Builtin 推理循环 | 工具结果回填、取消、最大轮次、Mission 约束持久化 |
| LLM 适配 | 服务商格式到规范化协议的双向转换 |
| 工具网关 | 风险判定、路径安全、符号链接、写冲突、终端预算 |
| Checkpoint | 去重、阈值触发 |
| 僵局检测 | 各信号、恢复窗口、waiting 升级 |
| 上下文压缩 | Mission 约束保留、损坏工作记忆降级 |
| Generation fencing | 所有正式动作的 generation 校验 |
| RunOutcome | schema 校验、identity 绑定、幂等、冲突、迟到 |

### 17.2 集成测试

| 场景 | 验证点 |
|---|---|
| 无工具问答 | 正常 LLM 调用 → submit_candidate |
| 读文件 → 编辑 → 运行验证 → 正常提交 | 完整闭环 |
| 权限允许 | 自动放行 |
| 权限拒绝 | 结构化错误返回 Agent |
| 权限超时 | 按拒绝处理 |
| LLM 调用中取消 | 取消生效，无泄漏 |
| 长命令中取消 | 孙进程回收 |
| 子进程崩溃后恢复 | RecoveryBundle 生成 + 新 Run 恢复 |
| 五种 Run outcome | schema、身份绑定、状态迁移 |
| outcome 重放、冲突、缺失 | 幂等/拒绝 |
| 与取消/预算/transport 断开的竞态 | 取消优先/宿主收尾 |
| 达到预算 | 硬拒绝 + 收尾额度 |
| Candidate 扫描、验证、Review | 完整流程 |
| Codex 准入失败 → 自动回退 Builtin | 回退且不扩大授权 |

### 17.3 打包冒烟测试

每个平台安装包：
1. 定位并启动 Builtin
2. 完成 ACP 握手
3. 读取 worktree 内测试文件
4. 触发一次模拟 LLM 响应
5. 正常结束并确认无残留进程

## 18. 风险与缓解

| 风险 | 等级 | 缓解措施 |
|---|---|---|
| LLM 服务商工具调用格式不兼容 | High | MVP 复用已验证的服务与模型；在 LlmProxy 中做适配层 |
| 子进程僵尸/资源泄漏 | High | 进程树管理、宽限期强制回收、资源释放证明 |
| 上下文压缩丢失关键信息 | Medium | 约束持久化保证、压缩失败降级、不标记为验证事实 |
| Windows 进程树回收不完整 | Medium | 使用 `taskkill /T` 和目标作业对象 |
| 大文件传输阻塞 stdio | Low | 消息大小限制 4MB；大文件通过 worktree 路径传递 |
| 模型 stop reason 与 Run outcome 混淆 | Medium | Builtin 严格分离两者；宿主不推断 |
| 多个 LLM 服务并发调用 | Low | MVP 串行；后续可扩展 |
| asar 打包路径问题 | Medium | 明确 asarUnpack 配置；打包校验 |

## 19. 实施分期建议

### Phase 0：基础设施（预计 2-3 周）
- ACP Transport 和协议栈
- Builtin 子进程入口和最小推理循环
- AgentBackend 注册与准入
- AgentRun 数据模型扩展

### Phase 1：核心闭环（预计 3-4 周）
- AgentRunHost 统一生命周期
- `_llm/chat` 宿主代理
- 最小工具集（读、写、编辑、搜索、目录、Shell）
- 工具网关（权限、路径、预算、fencing）
- 后端自动选择与回退

### Phase 2：质量保障（预计 2-3 周）
- Checkpoint 注入
- 僵局检测
- Mission 约束持久化
- 上下文压缩
- 结构化工作记忆

### Phase 3：完成与恢复（预计 2-3 周）
- Run outcome 校验与状态迁移
- Candidate 扫描、验证、Review
- 崩溃恢复与 RecoveryBundle
- 事件持久化与 RunSnapshot

### Phase 4：UI 与打包（预计 2 周）
- Mission 详情增强（后端标识、诊断）
- 权限与 Decision 卡片
- 三平台打包配置
- 打包冒烟测试
- i18n 文案

### Phase 5：测试与验收（预计 1-2 周）
- 单元测试覆盖
- 集成测试覆盖
- 冒烟测试
- 验收标准检查

## 20. 附录

### 20.1 与既有 CLI Subagent 的区别

| 维度 | Builtin SubAgent | 既有 CLI Subagent |
|---|---|---|
| 产品入口 | 后台 Mission | 主聊天中的 `dispatch_subagent` |
| 控制单位 | Mission / AgentRun | 单次 Dispatch |
| 编排者 | 当前 AgentRun 自治执行 | 主聊天 Agent 拆解并委派 |
| 执行环境 | 私有 worktree | 会话授权工作目录 |
| 生命周期 | 完整状态机 | 单次子进程调用 |
| 结果 | Candidate / Review / Deliverable | tool result 返回主 Agent |

两个机制可以共存，但不得复用含义不同的数据模型。

### 20.2 关键接口索引

| 接口 | 位置 | 说明 |
|---|---|---|
| `AcpTransport` | `electron/builtinSubAgent/acpTransport.ts` | ACP 传输层 |
| `AcpProtocol` | `electron/builtinSubAgent/acpProtocol.ts` | ACP 协议处理器 |
| `InferenceLoop` | `electron/builtinSubAgent/inferenceLoop.ts` | Builtin 推理循环 |
| `AgentRunHost` | `electron/builtinSubAgent/host/agentRunHost.ts` | 统一托管 |
| `LlmProxy` | `electron/builtinSubAgent/host/llmProxy.ts` | LLM 代理 |
| `ToolGateway` | `electron/builtinSubAgent/host/toolGateway.ts` | 工具网关 |
| `BudgetManager` | `electron/builtinSubAgent/host/budgetManager.ts` | 预算管理 |
| `CheckpointInjector` | `electron/builtinSubAgent/host/checkpointInjector.ts` | Checkpoint |
| `StuckDetector` | `electron/builtinSubAgent/host/stuckDetector.ts` | 僵局检测 |
| `RunOutcomeHandler` | `electron/builtinSubAgent/host/runOutcomeHandler.ts` | Outcome 处理 |
| `BackendRegistry` | `electron/builtinSubAgent/host/backendRegistry.ts` | 后端注册 |
| `PathSecurity` | `electron/pathSecurity.ts` | 路径安全 |
| `PermissionHandler` | `electron/builtinSubAgent/host/permissionHandler.ts` | 权限处理 |