# CLI Subagent 集成 - 技术设计方案

> 版本：v1.0
> 设计日期：2026-07-12
> 状态：草案 / 待评审
> 需求来源：[cli-subagent-integration-requirement.md](../requirement/cli-subagent-integration-requirement.md) v1.7
> 参考实现：[claude-codex-integration.md](../references/claude-codex-integration.md)（Multica 统一 Backend）
> 前置依赖：现有 `toolChatLoop` 工具循环、`toolConfirmRegistry` 确认机制、`spawnUtil` 子进程工具（均已就绪）

---

## 0. 设计总纲

### 0.1 范围（对齐需求 §3.1 / §17.1 D2）

| 交付项 | 本设计覆盖 |
|--------|-----------|
| `dispatch_subagent` 统一委派工具（参数选引擎） | ✅ |
| Claude Code 后端（stream-json 协议） | ✅ |
| Codex 后端（JSON-RPC 2.0 协议） | ✅ |
| Subagent 设置 Tab（CLI 检测 / 模型 / 思考级别 / 授权 / 超时） | ✅ |
| Subagent 执行卡片（嵌套展开文本/思考/子工具） | ✅ |
| 内部工具授权复用确认卡片（confirm / auto） | ✅ |
| 用户问询（Codex elicitation ✅；Claude 待验证，不通过则禁用） | ✅（分 CLI） |
| 结果回收（输出/状态/token/文件变更） | ✅ |
| 安全边界（cwd / 进程隔离 / 环境过滤 / 超时 / 并发上限） | ✅ |
| 跨平台（Windows 隐藏控制台 / Unix 进程组） | ✅ |
| `subagentLogger` 日志（复用 agentLogger） | ✅ |
| 持久化（摘要级，D11）+ token 统计 | ✅ |
| 多任务编排（Skill 承载，主进程不内置调度器） | ✅（Skill 内容交付） |
| 单轮内并行委派（无依赖并行） | ✅（toolChatLoop 定向增强） |
| 文件变更跳转 diff / 回滚（D14） | ❌ 后续迭代 |
| 用户手动委派入口（@codex / UI 按钮，D13） | ❌ 本期不做 |

### 0.2 核心原则

1. **主 Agent HTTP API 链路零改动**：`dispatch_subagent` 是新增的一类工具，复用现有 `toolChatLoop` / `ToolExecutor` / 确认卡片 / 配置读写模式，不替换主链路（D1）。
2. **统一抽象屏蔽协议差异**：参照 Multica `Backend` 接口，定义 `SubagentBackend` 抽象，Claude Code（stream-json）与 Codex（JSON-RPC）各一实现；上层 `SubagentRuntime` 与执行器对协议无感（D2 / N8）。
3. **Subagent 无状态**：每次委派为独立 CLI 调用，不续接线程；上下文由主 Agent 对话历史维护（D9）。Claude `session_id` / Codex `threadId` 仅入排障日志。
4. **不改 CLI**：所有解析、映射、确认、编排逻辑在主进程侧完成，CLI 仅被动输出事件流（N8）。
5. **最小侵入 + 最大复用**：子进程管理复用 `spawnUtil`；确认/问询复用 `tool:confirm-request/response` + `toolConfirmRegistry`（按 `(requestId, toolUseId)` 寻址，与工具类型解耦）；配置复用增量 key-value 存储；日志复用 `agentLogger`。
6. **信息分层**：运行期 UI 全量流式 / 日志结构化摘要 / 持久化摘要级；不存逐字文本与完整思考流（D11）。
7. **安全默认**：`dispatch_subagent` 登记为高危工具，启动前必经一次「启动闸门」确认；内部工具默认 `confirm`，高危强制确认无信任选项。

### 0.3 新增目录结构

```
electron/subagent/
├── subagentTypes.ts              # 运行期类型：SubagentEvent / SubagentRunOptions / 后端接口
├── subagentProcess.ts            # SubagentProcess：spawn / kill / 环境过滤 / stderr tail（复用 spawnUtil）
├── subagentBackend.ts            # SubagentBackend 抽象接口 + 事件汇 Sink
├── claudeCodeBackend.ts          # Claude Code stream-json 适配（args / stdin / 事件解析 / 授权回写）
├── codexBackend.ts               # Codex JSON-RPC 适配（initialize / thread/start / turn/start / 授权回写）
├── subagentRuntime.ts            # 编排：超时看门狗 / 并发信号量 / 交互暂停恢复 / 结果回收
├── subagentInteraction.ts        # 复用 toolConfirmRegistry 的子交互等待（合成 toolUseId）
├── subagentCliDetect.ts          # CLI 安装检测 + 版本校验 + 模型/思考级别发现（复用 larkCliRunner 模式）
├── subagentLogger.ts             # 仿 shellAgentLogger，预处理字段后调 logAgentEvent
├── subagentSecurity.ts           # CLI 工具风险等级映射 / 信任判定适配
└── subagentIpc.ts                # subagent:detect / subagent:discover-models IPC 注册

electron/tools/
└── dispatchSubagentExecutor.ts   # dispatch_subagent 执行器（ToolExecutor 适配层）

src/shared/
├── subagentTypes.ts              # 领域类型：SubagentProfile / SubagentDispatchRecord / SubagentEvent
└── subagentPrompts.ts            # 编排 Skill 内容 + 工具描述文案

src/renderer/components/Chat/
├── SubagentExecutionCard.tsx     # Subagent 执行卡片（嵌套展开）
├── SubagentToolConfirmCard.tsx   # 内部工具确认卡片（标注 Subagent 来源）
└── SubagentInquiryCard.tsx       # 用户问询卡片（选项 / 自定义输入）

src/renderer/components/Config/
└── SubagentSettingsTab.tsx       # 设置页 Subagent Tab（仿 FeishuSettingsTab）
```

---

## 1. 类型与数据模型

### 1.1 新增 `src/shared/subagentTypes.ts`（领域类型，对齐需求 §13）

```typescript
export type SubagentType = 'claude_code' | 'codex'
export type SubagentToolApproval = 'confirm' | 'auto'
export type SubagentInstallStatus = 'installed' | 'not_installed' | 'outdated' | 'unknown'

/** 单个 CLI Subagent 的配置（对应需求 §13.1 SubagentProfile） */
export interface SubagentProfile {
  type: SubagentType
  enabled: boolean
  executablePath: string            // 空 → 自动检测 PATH
  // 运行时探测回填（只读，由主进程检测后写入内存态，不进用户编辑草稿）
  detectedVersion?: string
  installStatus?: SubagentInstallStatus
  defaultModel?: string
  defaultThinkingLevel?: string
  toolApproval: SubagentToolApproval
  timeoutMinutes: number            // 默认 30
  inactivityTimeoutMinutes: number  // 默认 10
}

export type SubagentDispatchStatus =
  | 'queued' | 'running' | 'awaiting_confirm' | 'awaiting_inquiry'
  | 'completed' | 'failed' | 'timeout' | 'aborted'

/** 运行期流式事件（统一抽象，屏蔽 CLI 协议差异；运行期全量，不逐字持久化） */
export type SubagentEvent =
  | { kind: 'text'; seq: number; text: string }
  | { kind: 'thinking'; seq: number; text: string }
  | { kind: 'tool_call'; seq: number; callId: string; toolName: string; inputSummary: string }
  | { kind: 'tool_result'; seq: number; callId: string; status: 'ok' | 'error'; summary: string; truncated?: boolean }
  | { kind: 'usage'; input?: number; output?: number; cacheRead?: number }
  | { kind: 'files_changed'; files: string[] }
  | { kind: 'status'; status: SubagentDispatchStatus; detail?: string }

/** 内部工具授权确认请求（运行期，由 CLI approval 请求解析而来） */
export interface SubagentToolConfirmRequest {
  callId: string
  toolName: string                 // CLI 自带工具名：Bash/Edit/Write/shell/apply_patch…
  input: unknown
  riskLevel: ToolRiskLevel
  diff?: string                    // 仅当 CLI 给出变更结构（如 Codex applyPatch patch）
  shellSecurityHints?: ShellSecurityHints
}

/** 用户问询请求（Codex elicitation / Claude 待验证） */
export interface SubagentInquiryRequest {
  inquiryId: string
  question: string
  options?: string[]
  allowCustom: boolean
}

/** 委派执行记录（嵌入消息历史，摘要级持久化，D11） */
export interface SubagentDispatchRecord {
  agent: SubagentType
  task: string
  cwd: string
  model?: string
  thinkingLevel?: string
  toolApproval: SubagentToolApproval
  status: SubagentDispatchStatus
  // 摘要级：子工具清单（名/状态/结果摘要），不存逐字文本与完整思考流
  toolSummaries?: Array<{
    toolName: string
    status: 'ok' | 'error' | 'rejected'
    summary: string
  }>
  finalOutput?: string
  error?: string
  stderrTail?: string              // 仅 error 时附加，已脱敏
  tokenUsage?: { input?: number; output?: number; cacheRead?: number }
  filesChanged?: string[]
  durationMs?: number
}
```

> `ToolRiskLevel` / `ShellSecurityHints` 复用 `src/shared/domainTypes.ts:12` / `:168`。

### 1.2 扩展 `AppConfig`（`src/shared/domainTypes.ts:739-771`）

```typescript
export interface AppConfig {
  // ...existing fields（locale / llmServices / tools / feishu / wechat / ... / workspaceLayout）
  subagents: SubagentProfile[]     // 新增：固定两条（claude_code / codex）
}

export const DEFAULT_SUBAGENT_PROFILES: SubagentProfile[] = [
  { type: 'claude_code', enabled: false, executablePath: '', toolApproval: 'confirm', timeoutMinutes: 30, inactivityTimeoutMinutes: 10 },
  { type: 'codex', enabled: false, executablePath: '', toolApproval: 'confirm', timeoutMinutes: 30, inactivityTimeoutMinutes: 10 },
]

export function mergeSubagentsConfig(partial?: SubagentProfile[] | null): SubagentProfile[] {
  if (!Array.isArray(partial)) return DEFAULT_SUBAGENT_PROFILES.map(p => ({ ...p }))
  // 以默认两条为底，按 type 合并用户值，补全缺失字段；多余/未知 type 丢弃
  return DEFAULT_SUBAGENT_PROFILES.map(base => {
    const user = partial.find(p => p?.type === base.type)
    return user ? { ...base, ...user, type: base.type } : { ...base }
  })
}
```

**全局参数**（`globalConcurrency` 默认 2、`firstProgressTimeoutSec` 默认 30）本期作为代码常量（`subagentRuntime.ts`），不进配置；后续若需可调再提升为配置项。需求 §11.4 / §5.5 明确为「默认上限」，不要求用户可配。

### 1.3 运行期类型 `electron/subagent/subagentTypes.ts`

```typescript
export interface SubagentRunOptions {
  agent: SubagentType
  task: string
  cwd: string
  model?: string
  thinkingLevel?: string
  toolApproval: SubagentToolApproval
  timeoutMs: number
  inactivityTimeoutMs: number
  firstProgressTimeoutMs: number
  maxTurns?: number
  // 回写 CLI 的能力开关
  inquiryEnabled: boolean          // Claude 待验证，false 时禁用问询
}

/** 后端向 Runtime 上报的事件流（含需用户交互的请求） */
export type SubagentBackendEmit =
  | { type: 'event'; event: SubagentEvent }
  | { type: 'tool_confirm'; req: SubagentToolConfirmRequest }
  | { type: 'inquiry'; req: SubagentInquiryRequest }
  | { type: 'done'; result: SubagentDispatchRecord }
  | { type: 'fatal'; error: string; stderrTail?: string }
```

---

## 2. 整体架构

### 2.1 分层

```
┌─────────────────────────────────────────────────────────────────┐
│  toolChatLoop（现有，最小增强）                                   │
│    · dispatch_subagent 登记为高危工具 → 启动闸门确认              │
│    · 单轮内多 dispatch_subagent → 并发批执行（§6.5）              │
└──────────────────────────┬──────────────────────────────────────┘
                           │ execute(input, ctx)
┌──────────────────────────▼──────────────────────────────────────┐
│  dispatchSubagentExecutor（ToolExecutor 适配层）                 │
│    · 校验（启用/安装/版本/cwd）· 合并参数 · 申请并发槽           │
│    · 创建 SubagentRuntime · await · 回收 ToolExecutorResult      │
└──────────────────────────┬──────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────┐
│  SubagentRuntime（编排，协议无关）                                │
│    · 超时看门狗（绝对/无活动/首轮无进度）                         │
│    · 交互暂停恢复（tool_confirm / inquiry → 等 UI → 回写后端）    │
│    · 事件 → ctx.sendProgress 推 UI · 结果汇总                     │
└────────────┬─────────────────────────────┬──────────────────────┘
             │                             │
┌────────────▼──────────────┐  ┌───────────▼──────────────────────┐
│  SubagentProcess（共享）    │  │  SubagentBackend（协议抽象）      │
│  · spawn（spawnUtil）       │  │  ┌─ ClaudeCodeBackend            │
│  · killProcessTree         │  │  │   stream-json：args/stdin/解析 │
│  · 环境变量过滤             │  │  └─ CodexBackend                 │
│  · stderr tail（2KB）       │  │      JSON-RPC：initialize/turn   │
└─────────────────────────────┘  └──────────────────────────────────┘
```

### 2.2 委派时序（对齐需求 §4.2 / §14 典型流程）

```
主 Agent 调 dispatch_subagent
  │
  ▼
[toolChatLoop] 高危确认（启动闸门）──tool:confirm-request──▶ 渲染：Subagent 启动确认卡
  │                                          ◀──tool:confirm-response（approved/rejected）
  │  rejected → 返 tool_result(is_error) 给主 Agent
  ▼ approved
[executor] 校验 + 申请并发槽（信号量 cap=2，超限排队）
  │
  ▼
[runtime] SubagentProcess.spawn(backend.buildArgs)
  │       backend.start → 写 stdin(handshake+task) → 读 stdout 事件流
  │
  ├── 事件 text/thinking/tool_call/tool_result/usage/files_changed
  │     → ctx.sendProgress('subagent', { event }) ──tool:progress──▶ UI 实时追加
  │
  ├── backend emit tool_confirm（CLI 请求工具授权）
  │     toolApproval='auto' 或命中信任 → backend.respondApproval(allow)，继续
  │     否则 → 合成 toolUseId，tool:confirm-request(source='subagent') ──▶ 渲染：内部工具确认卡
  │            ◀──tool:confirm-response（approved/rejected/trust）── 回写 backend
  │
  ├── backend emit inquiry（Codex elicitation）
  │     → 合成 toolUseId，tool:confirm-request(source='subagent',kind='inquiry') ──▶ 渲染：问询卡
  │       ◀──tool:confirm-response(answer/choice)── 回写 backend
  │
  ├── 超时/无活动/取消 → killProcessTree → 标记 timeout/aborted
  │
  ▼
[runtime] backend emit done → 汇总 SubagentDispatchRecord（摘要级）
  │
  ▼
[executor] 释放并发槽 → return ToolExecutorResult{ success, data: record }
  │
  ▼
[toolChatLoop] tool_result(finalOutput) 回主 Agent → 主 Agent 继续推理
```

### 2.3 与现有工具循环的集成点

| 集成点 | 现有位置 | 本设计动作 |
|--------|----------|-----------|
| 工具定义 | `src/shared/builtinToolDefinitions.ts:2-224` | 追加 `dispatch_subagent` 定义（`agent`/`task`/`cwd`/`model`/`thinkingLevel`/`toolApproval`/`timeoutMinutes`/`maxTurns`） |
| 执行器注册 | `electron/tools/builtinExecutors.ts:924-938` | registry 加入 `dispatchSubagentExecutor` |
| 工具过滤 | `electron/toolsConfigRuntime.ts:23-51` `filterBuiltinToolsForApi()` | **签名加 `subagentAvailable?` 参数**（仿 wechat/feishu 分支），仅当某 Subagent 启用+安装达标时注入 `dispatch_subagent`；调用方 `toolChatLoop` 传入 |
| 高危确认 | `src/shared/domainTypes.ts:535-543` `builtinToolNeedsConfirmation()` + `:514-533` `builtinToolRiskLevel()` | `dispatch_subagent` → 需确认、riskLevel='high' |
| 输入校验 | `electron/toolInputGuards.ts` `assertSafeToolInput()` | 新增 case：校验 `agent` 枚举、`task` 非空、`cwd` 合法、`toolApproval` 枚举 |
| 取消信号 | `electron/toolChatLoop.ts:1380` `registerToolCancel()` | 透传给 `ctx.signal`，runtime 监听并 `killProcessTree` |
| 进度推送 | `ctx.sendProgress(status, payload)`（`toolChatLoop.ts:1017-1055`） | 扩展 `ToolProgressPayload` 携带 `subagent` 字段（§7.1） |
| 结果回传 | `toolChatLoop.ts:1526-1559` `formatToolResultPayload()` | `finalOutput` 作为 `tool_result.content` 返主 Agent |

---

## 3. CLI 调用统一抽象

### 3.1 `SubagentProcess`（共享进程管理，复用 `spawnUtil`）

```typescript
// electron/subagent/subagentProcess.ts
export interface SubagentProcess {
  readonly pid: number | undefined
  readonly stdin: NodeJS.WritableStream | null
  readonly stdout: NodeJS.ReadableStream | null
  getStderrTail(): string              // 末尾 2KB，仅 error 时取
  kill(): Promise<void>                // killProcessTree（含孙进程）
}

export function createSubagentProcess(opts: {
  executablePath: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
}): SubagentProcess
```

实现要点：
- **spawn**：`spawnCommandSafe(executablePath, args, { cwd, env, windowsHide: true, shell: false })`（复用 `electron/spawnUtil.ts:109-119`）。Windows 上 `claude`/`codex` 多为 npm shim（`.cmd`），`spawnCommand` 已用 `cmd.exe /d /s /c` 包装避免 EINVAL（`spawnUtil.ts:91-107`）。
- **进程组**：Unix 下 `detached: true`（成为进程组 leader），终止用 `process.kill(-pid)`；Windows 下 `killProcessTree` 用 `taskkill /PID /T /F`（`spawnUtil.ts:26-88`）。**需增强** `spawnUtil` 的 Unix 分支显式 `Setpgid`（当前仅 SIGTERM+close），新增 `spawnSubagentProcess` 选项或在 `spawnCommand` 支持 `detached` 透传。
- **stderr tail**：环形缓冲 2KB（参考实现 `agentStderrTailBytes = 2048`），仅 `error` 时附加到 `SubagentDispatchRecord.stderrTail`。
- **管道死锁防护**：stdin 写入与 stdout 读取分离（stdin 写在 backend.start 内、stdout 读取在 backend 的 reader 循环），避免管道满阻塞。
- **scanner buffer**：stdout 按行解析，单行 buffer 上限 10MB（对齐参考实现 `10*1024*1024`），超长行截断。

### 3.2 `SubagentBackend`（协议抽象，仿 Multica `Backend`）

```typescript
// electron/subagent/subagentBackend.ts
export interface SubagentBackend {
  readonly agent: SubagentType
  /** 构造 CLI 启动参数 */
  buildArgs(opts: SubagentRunOptions): string[]
  /** 启动握手 + 注入 task，开始读取 stdout 事件流；通过 emit 上报 */
  start(proc: SubagentProcess, opts: SubagentRunOptions, emit: SubagentBackendEmitSink): Promise<void>
  /** 回写工具授权决策（CLI 请求 → 用户决策 → 回写） */
  respondToolApproval(callId: string, approved: boolean, updatedInput?: unknown): Promise<void>
  /** 回写用户问询回答 */
  respondInquiry(inquiryId: string, resp: { action: 'accept' | 'reject'; content?: string; choice?: string }): Promise<void>
  /** 优雅关闭（关 stdin → 等待 reader 退出 → 超时强杀由 runtime 兜底） */
  shutdown(): Promise<void>
}
```

两个实现的关键差异（对齐参考实现 §13 总结）：

| 维度 | ClaudeCodeBackend | CodexBackend |
|------|-------------------|--------------|
| 协议 | stream-json（行分隔 JSON） | JSON-RPC 2.0 |
| 启动 args | `-p --output-format stream-json --input-format stream-json --verbose --strict-mcp-config` | `app-server --listen stdio://` |
| 注入 task | stdin 写一行 `{"type":"user","message":{"role":"user","content":[{"type":"text","text":task}]}}` | `initialize` → `thread/start` → `turn/start(input=task, effort)` |
| 事件来源 | stdout 逐行 JSON：`assistant`/`user`/`system`/`result`/`log`/`control_request` | JSON-RPC notification/item：`message`/`tool`/`turn/completed`/server request |
| 工具授权 | `control_request` → 回写 `control_response{behavior:allow/deny}` | server request `item/commandExecution/requestApproval` 等 → 回写 `{decision}` |
| 问询 | `AskUserQuestion` tool_use（**待验证**，TVQ-1） | `mcpServer/elicitation/request` → 回写 `{action,content,_meta}` |
| 模型发现 | 静态列表 + `--help` 解析 `--effort` | `codex debug models --bundled`（≥0.122.0），回退静态 |
| 思考级别 | `--effort <level>`（low/medium/high/xhigh/max，按模型过滤） | `turn/start` 的 `effort` 字段 |
| 权限模式 | `--permission-mode`：confirm 策略用 `default`（触发 control_request），auto 用 `bypassPermissions` | 由 server request 处理，auto 时主进程直接回 accept |

### 3.3 `SubagentRuntime`（编排，协议无关）

职责：
1. **生命周期**：`createSubagentProcess` → `backend.start` → 等待 `emit('done'|'fatal')` → `backend.shutdown` → 进程清理。
2. **超时看门狗**（三档，对齐需求 §5.5）：
   - `firstProgressTimeoutMs`（30s）：启动后未收到首个有效事件 → 快速失败（便于排障）。
   - `inactivityTimeoutMs`（10min）：无任何语义活动（文本/工具/状态）→ 判定卡死。
   - `timeoutMs`（30min）：绝对时限。
   - **问询/确认等待期间暂停无活动计时**（需求 §8.5.4：问询不计入无活动超时）。
3. **交互暂停恢复**：收到 `emit('tool_confirm'|'inquiry')` → 暂停 reader 推进（CLI 阻塞等待响应）→ 经 `subagentInteraction` 请求 UI → 拿到决策 → 调 `backend.respondToolApproval/respondInquiry` → 恢复。
4. **事件转发**：`emit('event')` → `ctx.sendProgress('subagent', { dispatchId, agent, event })`。
5. **取消**：`ctx.signal.addEventListener('abort', ...)` → `killProcessTree` → 标记 `aborted`。
6. **结果汇总**：`emit('done')` 的 `SubagentDispatchRecord` + 补充 `durationMs`/`stderrTail`/`toolSummaries`（从事件流归纳）。

### 3.4 `dispatchSubagentExecutor`（ToolExecutor 适配层）

```typescript
// electron/tools/dispatchSubagentExecutor.ts
export const dispatchSubagentExecutor: ToolExecutor = {
  name: 'dispatch_subagent',
  async execute(input, ctx): Promise<ToolExecutorResult> {
    const profile = resolveProfile(ctx, input.agent)         // 启用/安装/版本校验（§9.3）
    if (!profile.ok) return { success: false, error: profile.error }  // 中文错误
    const opts = mergeRunOptions(profile.value, input, ctx)  // 默认值 + 单次覆盖
    if (!validateCwd(ctx.workDir, opts.cwd)) return { success: false, error: '路径超出工作目录范围' }
    return await runWithConcurrencySlot(opts, async () => {  // 全局信号量 cap=2
      const runtime = new SubagentRuntime(opts, ctx)
      const record = await runtime.run()
      subagentLogger.logComplete(record)                      // 结构化日志
      return { success: record.status === 'completed', data: record, error: record.error, duration: record.durationMs }
    })
  }
}
```

---

## 4. Claude Code 后端（stream-json）

### 4.1 启动参数

```typescript
buildArgs(opts) {
  const args = ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json',
                '--verbose', '--strict-mcp-config']
  // V-CC-02 实测：-p 模式下 --permission-mode 不产生 control_request，工具自动执行（observe-only）。
  // Claude 无逐次确认；toolApproval 仅控制是否粗粒度禁用高危工具（见下 disallowed）。
  args.push('--permission-mode', opts.toolApproval === 'auto' ? 'bypassPermissions' : 'default')
  const disallowed: string[] = []
  if (opts.toolApproval === 'confirm') {
    const shellTool = process.platform === 'win32' ? 'PowerShell' : 'Bash'  // V-CC-10 实测 Windows 为 PowerShell
    disallowed.push(shellTool, 'Write', 'Edit')
  }
  if (!opts.inquiryEnabled) disallowed.push('AskUserQuestion')  // TVQ-1 / V-CC-13：不支持则禁用问询
  if (disallowed.length) args.push('--disallowedTools', ...disallowed)
  if (opts.model) args.push('--model', opts.model)
  if (opts.thinkingLevel) args.push('--effort', opts.thinkingLevel)
  // V-CC-05 实测：v2.1.207 无 --max-turns 旗标；maxTurns 对 Claude 为 no-op，靠绝对/无活动超时兜底
  return args
}
```

> **root/sudo 限制**：参考实现 `claudeRootSudoPreflight` 拒绝 root 下 `bypassPermissions`（参考 §5.1.2）。auto 模式在 Unix root 下需预检并回退为 `default` + 报错提示。

### 4.2 事件解析（stdout 逐行 JSON → `SubagentEvent`）

| Claude 消息 type | 映射 |
|------------------|------|
| `assistant`（content `text`） | `event:text` |
| `assistant`（content `thinking`） | `event:thinking` |
| `assistant`（content `tool_use`） | `event:tool_call`（toolName/inputSummary） |
| `user`（content `tool_result`） | `event:tool_result`（status/summary） |
| `result` | `event:usage`（取 usage）+ `done`（resultText → finalOutput；isError → failed） |
| `system` | 记 `session_id` 入日志（不入产品态） |
| `control_request` | **v2.1.207 `-p` 模式不触发**（V-CC-02 实测）；工具自动执行经 `user(tool_result)` 上报。保留解析以兼容未来版本 |
| `assistant` 含 `AskUserQuestion` tool_use | `inquiry`（**待 TVQ-1 验证回写路径**） |

### 4.3 授权回写（Claude：当前未用，保留兼容）

> **V-CC-02 实测**：`-p` 模式下 claude 不发 `control_request`，本方法当前不会被调用（Claude 走 observe-only，见 DD-8）。保留实现以兼容未来版本若恢复 control_request 机制。逐次授权回写实际只在 Codex 后端生效（§5.2）。

```typescript
respondToolApproval(callId, approved, updatedInput) {
  // stream-json control_response
  const resp = { type: 'control_response', response: {
    subtype: 'success', request_id: callId,
    response: { behavior: approved ? 'allow' : 'deny', updatedInput: updatedInput ?? null }
  }}
  await proc.stdin.write(JSON.stringify(resp) + '\n')
}
```

### 4.4 异步任务防护

参考实现检测 `status: "async_launched"` 标记为失败（参考 §7.3）。本后端在 `tool_result` 解析时同步检测，命中则 `emit('fatal', 'Claude Code 启动了异步后台任务，委派要求前台执行')`。

---

## 5. Codex 后端（JSON-RPC 2.0）

### 5.1 握手与轮次

```typescript
async start(proc, opts, emit) {
  this.rpc = new JsonRpcClient(proc.stdin, proc.stdout)   // 请求 id 分配 + 响应匹配 + notification 分发
  await this.rpc.request('initialize', { clientInfo: { name: 'SpaceAssistant', version: '1.0' }, capabilities: { experimentalApi: true } })
  this.rpc.notify('initialized')
  const thread = await this.rpc.request('thread/start', { cwd: opts.cwd, model: opts.model, config: { reasoning: { effort: opts.thinkingLevel } } })
  this.threadId = thread.threadId
  await this.rpc.request('turn/start', { threadId: this.threadId, input: [{ type: 'text', text: opts.task }] })
  this.rpc.onNotification(n => this.handleNotification(n, emit))   // item/message/tool/turn/completed
  this.rpc.onServerRequest(r => this.handleServerRequest(r, emit, opts))  // approval/elicitation
}
```

> **无状态**：每次委派 `thread/start` 新线程，不 `thread/resume`（D9）。`threadId` 仅入日志。

### 5.2 server request 处理（授权 + 问询）

| Codex method | 处理 |
|--------------|------|
| `item/commandExecution/requestApproval` / `execCommandApproval` | toolApproval='auto' → 直接回 `{decision:'accept'}`；confirm → `emit('tool_confirm')`，等用户后回 accept/deny |
| `item/fileChange/requestApproval` / `applyPatchApproval` | 同上；confirm 时携带 patch → `diff`（§7.2 文件变更来源） |
| `item/permissions/requestApproval` | 按参考实现 `codexPermissionsApprovalResponse` 回 `{permissions:{network,fileSystem}, scope:'turn'}` |
| `mcpServer/elicitation/request` | `emit('inquiry')`，等用户回答后回 `{action:'accept', content, _meta}` 或 `{action:'reject'}` |
| 其他 | 回 `-32601` 不支持，记日志 |

### 5.3 事件解析（notification → `SubagentEvent`）

| Codex 事件 | 映射 |
|------------|------|
| `item` type `message` | `event:text` |
| `item` type `reasoning` | `event:thinking` |
| `item` type `tool` / `function_call` | `event:tool_call` |
| `item` type `tool_result` / `function_call_output` | `event:tool_result` |
| `item` type `fileChange` / applyPatch | `event:files_changed` + 触发 `tool_confirm`（带 patch） |
| `turn/completed` | `event:usage` + `done`（取 finalOutput） |

### 5.4 优雅关闭

参考实现 `drainAndWait` 两阶段（关 stdin → 等 reader → 等 `cmd.Wait()`，各 10s）。本后端 `shutdown()`：关 stdin → 等 reader 退出（10s）→ 由 runtime `killProcessTree` 兜底。

---

## 6. 委派执行流与状态机

### 6.1 启动闸门确认（DD-1）

`dispatch_subagent` 登记为高危工具（`builtinToolRiskLevel` 返回 `'high'`，`builtinToolNeedsConfirmation` 返回 `true`），与 `run_shell`/`run_script` 一致。`toolChatLoop.ts:1145-1255` 现有确认流程在 `exec.execute` 之前触发一次「启动闸门」确认卡片，展示 `agent / task / cwd / model / toolApproval`：
- `toolApproval='auto'` 时，卡片显示**醒目无人值守提示**（需求 §8.4）。
- 用户拒绝 → 直接返 `tool_result(is_error)`，不启动子进程。

> **理由**：启动一个会自主修改本地文件/执行命令的 Agent 属高危操作，至少一次显式确认是安全底线。`auto` 模式下这一次闸门即「确认无人值守」，通过后内部工具不再逐个确认，满足 US-4（无人值守）与安全默认的平衡。这是对需求 §8（仅约束内部工具授权）的安全增强，不违背任何验收项。

### 6.2 运行态状态机（对齐需求 §13.2 / §7.2）

```
queued ──spawn──▶ running
                    │
            ├── tool_confirm（confirm 策略）──▶ awaiting_confirm ──回写──▶ running
            ├── inquiry                       ──▶ awaiting_inquiry ──回写──▶ running
            ├── done                           ──▶ completed
            ├── fatal / 鉴权失败               ──▶ failed
            ├── 超时 / 无活动                  ──▶ timeout
            └── 用户终止 / ctx.signal.abort    ──▶ aborted
```

状态经 `event:status` 推送 UI，卡片标题栏实时更新（需求 §7.3 / §16.3）。

### 6.3 异常与错误（对齐需求 §9.3）

| 场景 | 处理 |
|------|------|
| 未安装 / 版本过低 | executor 即返 `{success:false, error:'Subagent「Codex」未安装或版本过低，请在设置中配置'}` |
| `cwd` 越界 | `resolveSafePath(workDir, cwd)` 抛错 → 返路径安全错误 |
| 启动失败 | `spawnCommandSafe` 返 error → 返 stderr 摘要 |
| 超时 / 无活动 | `killProcessTree` + 标记 timeout，已产生事件保留展示 |
| 用户终止 | 标记 aborted，已执行操作不回滚 |
| CLI 内部错误（鉴权失败等） | `emit('fatal')` → 标记 failed，`stderrTail` 折叠展示（需求 §9.3 备注） |

所有错误中文可读 + 技术细节（stderr 摘要）默认折叠。

### 6.4 无状态与上下文（D9）

每次 `dispatch_subagent` 均为全新 CLI 调用（Claude 新 session / Codex 新 thread）。主 Agent 在对话历史（SQLite 持久化）中保留历次委派的 `task` 与 `finalOutput`；后续需续推时，由主 Agent 自行把相关摘要写入新 `task`（需求 §10.2）。**不存在** `resumeSubagentThreadId` 等续接参数与 UI（验收 §16.6）。

### 6.5 单轮内并行委派（DD-2，对齐需求 §6.4 / §16.2）

现状：`toolChatLoop.ts:692-1581` 以 `for (const tu of toolUses)` **顺序**执行工具。为支持「无依赖并行」，采用**方案 D（低风险改造，已核查可行）**：

**执行序列**：
1. 扫描一轮内的 `tool_uses`，对 `dispatch_subagent` 调用**立即启动但不 await**，收集 Promise。
2. **内置工具**（edit_file/run_script/…）按现有 `for` 循环**顺序执行**（逻辑完全不变，保留文件编辑安全与顺序语义）。
3. `await Promise.allSettled(dispatchPromises)`，结果按 `tool_use_id` 填充 `toolResults[]`（不依赖 push 顺序）。
4. 并发受全局信号量（cap=2）保护：超额 dispatch 在信号量处排队，不失控。

**共享状态并发安全（已核查 `toolChatLoop.ts`）**：

| 共享变量 | 并发安全 | 处理 |
|----------|----------|------|
| 确认注册表 / cancel 信号 / 进度推送 | ✅ 安全 | 按 `(requestId, toolUseId)` 寻址（`toolConfirmRegistry.ts:12-47`），天然支持并发，无需改造 |
| `pendingToolUseByIndex`（`:503`） | ✅ 不涉及 | 仅流式解析阶段用，执行循环前已完成 |
| `toolResults[]`（`:688`） | 🟠 需调整 | `.push()` 顺序非确定，但 API 按 `tool_use_id` 匹配，实际无害；改按 id/index 填充 |
| `toolErrorRepeat`（`:432`，定义 `:208-228`） | 🔴 不安全 | 闭包追踪器（连续 3 次同工具同错误 break），并发交错破坏连续性 -> **dispatch_subagent 豁免该追踪** |
| `abortRepeatedToolError`（`:690`） | 🔴 不安全 | 可变变量触发 break，并发下无法中断其他 dispatch -> **仅内置工具阶段触发，dispatch 阶段不 break** |
| `recoverySkillSystemSuffix`（`:433`） | 🟠 需隔离 | 只设一次的条件检查，并发下可能同时通过 -> dispatch 阶段隔离或加锁 |
| 写路径冲突（`electron/toolWriteConflict.ts`） | 🟡 低风险 | check-then-act 非原子，但 dispatch_subagent 不直接写文件 |

> **风险与缓解**：并发 dispatch 若改同一批文件可能冲突——这由编排 Skill 约束（提示 LLM 勿对重叠文件并行委派）。内置工具不并发，避免 edit_file 竞态。涉及 Claude+Codex 双引擎并发的正确性测试须在环境 B 就绪后补测（验证计划 §8.4）。此项为 toolChatLoop 改动中风险最高者，测试策略 §16 专项覆盖。

### 6.6 多任务编排 Skill（D10）

主进程**不内置调度器**。交付一个内置 Skill（`src/shared/subagentPrompts.ts` 中的编排方法论 + 现有 Skill 路由加载），描述：如何拆解任务、判断子任务依赖、决定串/并行、汇总结果。经现有 Skill 机制注入主 Agent system prompt，由 LLM 自行决策。用户可在 Skill 管理界面查看/禁用/自定义（验收 §16.2）。

---

## 7. 嵌套事件流与 UI 展示

### 7.1 `ToolProgressPayload` 扩展（核心，解决「一次性 await 无法表达嵌套」）

现有 `ctx.sendProgress(status, payload)` 的 payload 仅承载字符串/单层进度（`electron/tools/types.ts`）。扩展为可携带 Subagent 事件：

```typescript
// 扩展 ToolProgressPayload（domainTypes.ts 或 types.ts）
export interface ToolProgressPayload {
  // ...existing（message / raw / rawDelta / seq / shell 等）
  subagent?: SubagentProgressPayload   // 新增
}
export interface SubagentProgressPayload {
  dispatchId: string                   // = dispatch_subagent 的 toolUseId
  agent: SubagentType
  event: SubagentEvent                 // §1.1 的 discriminated union
}
```

`dispatchSubagentExecutor` 内 `ctx.sendProgress('subagent', { dispatchId, agent, event })`。渲染端 `chatToolSessionService.ts` 在 `onProgress` 分支识别 `payload.subagent`，把 `event` 追加到对应 `ToolCallRecord.events` 并按 `kind` 更新嵌套状态（如 `tool_confirm` 到达 → 卡片状态 `awaiting_confirm`）。

### 7.2 来源约束展示（对齐需求 §7.2 / N8）

展示「主进程能从 CLI 事件流解析出什么」而非「我们决定展示什么」：

| 信息项 | 来源 | 降级 |
|--------|------|------|
| 委派元信息 / 状态机 / 已用时间 | 主进程自有 | 无 |
| 文本 / 思考 | 解析 CLI 事件 | 粒度由 CLI 决定，按事件增量展示，不保证逐字；超长折叠 |
| 内部工具调用 | 解析 CLI 事件 | 字段结构取决于 CLI（Claude tool_use vs Codex tool item） |
| 授权确认 diff | CLI approval 请求 | 仅 CLI 给出变更结构（Codex patch）才有 diff，否则降级为参数展示 |
| token 用量 | CLI usage 事件 | 口径取决于 CLI，归一化展示；无则隐藏 |
| 文件变更 | CLI 变更事件或写入类工具推断 | 可能不完整，标注「推断」 |

缺失字段不阻断展示：对应区域隐藏或显示「无」，不报错（需求 §7.2）。

### 7.3 `SubagentExecutionCard`（对齐需求 §7.1）

`ToolCallCard.tsx:302-340` 现按 `record.toolName` 分派确认卡片。新增分支：

```typescript
if (record.toolName === 'dispatch_subagent') return <SubagentExecutionCard record={record} ... />
```

卡片结构（对齐需求 §7.1 示意）：
- **标题栏**：`🤖 Subagent · {agent} · {model} · {状态}` + 已用时间 / token / 改动文件数。
- **任务概要**：`task` 一行。
- **可展开执行过程**：遍历 `record.events`，按 `kind` 渲染：`text`（折叠文本）、`thinking`（折叠思考）、`tool_call`+`tool_result`（子工具卡片）、`files_changed`（文件列表，D14 仅展示不跳转）。
- **待处理高亮**：`status==='awaiting_confirm'|'awaiting_inquiry'` 时自动展开并高亮待处理项（需求 §7.3）。
- **默认收起**：进行中无待处理或完成态默认收起为摘要；历史回看为只读完成态。

### 7.4 折叠与降噪

- 进行中且有待确认/问询 → 自动展开高亮。
- 历史会话回看 → 只读完成态，可展开。
- 流式输出与结果摘要做长度截断（复用 `runShellExecutor` 的 `truncateIo` / `persistLargeOutput` 模式），避免超大输出撑爆 UI（需求 §11.4）。

---

## 8. 工具授权与用户问询

### 8.1 复用确认 IPC（核心复用，DD-3，Codex 适用；Claude 见 DD-8）

> **引擎适用范围（DD-8）**：本节确认/问询复用机制**仅 Codex 实际触发**（Codex 经 server-request 发起 tool approval / elicitation）。Claude Code 在 `-p` 模式下不发 control_request（V-CC-02），工具自动执行，**不触发本机制**（Claude 仅在问询 V-CC-13 验证通过时才走 inquiry 分支）。

现有 `tool:confirm-request` / `tool:confirm-response` + `toolConfirmRegistry`（`electron/toolConfirmRegistry.ts:16-36`）按 `${requestId}\0${toolUseId}` 寻址，**与工具类型完全解耦**。Subagent 内部工具确认与用户问询**直接复用**，仅扩展 payload + 合成 toolUseId：

```typescript
// 扩展 tool:confirm-request payload（preload.ts:161-174 / api.ts）
interface ToolConfirmRequestPayload {
  // existing: requestId, sessionId, toolUseId, toolName, input, riskLevel, diff?, shellSecurityHints?, ...
  source?: 'builtin' | 'subagent'             // 新增：来源标识
  subagent?: {                                 // 新增：仅 source='subagent' 时
    dispatchId: string
    agent: SubagentType
    kind: 'tool_approval' | 'inquiry'
    // tool_approval：
    cliToolName?: string                       // CLI 内部工具名（Bash/Edit/shell/apply_patch…）
    diff?: string
    shellSecurityHints?: ShellSecurityHints
    // inquiry：
    inquiryId?: string
    question?: string
    options?: string[]
    allowCustom?: boolean
  }
}

// 扩展 tool:confirm-response payload（api.ts:27-34）
interface ToolConfirmResponsePayload {
  // existing: requestId, toolUseId, approved, trustCommand?, trustDomain?, trustActDomain?
  inquiryAnswer?: string                       // 新增：问询自由输入
  inquiryChoice?: string                       // 新增：问询选项选择
}
```

**合成 toolUseId**：子项用 `${dispatchToolUseId}#sub:${callId|inquiryId}`，与 dispatch 本身的 toolUseId 不冲突。`submitToolConfirmResponse(requestId, syntheticToolUseId, approved)` 精确 resolve runtime 的等待 Promise。

> **布尔通道缺口（方案 A 中转）**：`toolConfirmRegistry.waitForToolConfirm` 只 resolve `'approved'|'rejected'|'timeout'`（`toolConfirmRegistry.ts:1,27-36`），**无法携带问询回答文本或信任命令字符串**。内置工具的信任写入在 `appIpc.ts` handler 内直接落 DB，执行器只需布尔；但 Subagent 问询需把**用户输入文本**回传 runtime -> 回写 CLI，布尔不够。解法：新建 `subagentInteractionRegistry`（Map，key 为合成 toolUseId）作中转--handler 收到 `source='subagent'` 响应时，先把**完整载荷**（`approved`/`trustCommand`/`inquiryAnswer`/`inquiryChoice`）存入该 registry，再调 `submitToolConfirmResponse` 解除布尔等待；runtime 醒来后从 registry 取走完整载荷。布尔负责「叫醒」，registry 负责「传话」，不新增 IPC 通道。

> **payload 全链路传播（已核查，须编码时落实）**：`source`/`subagent`/`inquiryAnswer`/`inquiryChoice` 须从 IPC 一路传到渲染端确认/问询卡片并回传--`PendingConfirmItem`（`pendingConfirmStore.ts:5-19`）、其 `toolOnConfirmRequest` 回调（`:34-54`，现仅提取固定字段会丢弃 subagent 上下文）、`respond()`（`:88-97`）与 `ToolConfirmOptions`（`src/shared/toolConfirm.ts`）均须扩展这些字段。否则渲染端拿不到 `kind`/`agent`/`cliToolName`/`inquiryId`/`question`/`options` 等无法渲染 Subagent 确认/问询卡片，也无法回传问询答案。

### 8.2 `subagentInteraction`（等待器 + 中转 registry，方案 A）

```typescript
// electron/subagent/subagentInteraction.ts

// 中转 registry：handler 存完整载荷，runtime 取走
const interactionPayloads = new Map<string, SubagentInteractionPayload>()

export interface SubagentInteractionPayload {
  approved: boolean
  trustCommand?: string
  inquiryAnswer?: string
  inquiryChoice?: string
}

// handler 侧（appIpc.ts tool:confirm-response 扩展分支）调用：
export function storeInteractionPayload(syntheticToolUseId: string, payload: SubagentInteractionPayload): void

// runtime 侧：先等布尔唤醒，再取完整载荷
export async function waitSubagentToolConfirm(ctx, dispatchId, req): Promise<{
  approved: boolean; trustCommand?: string
}> {
  const syntheticToolUseId = `${ctx.toolUseId}#sub:${req.callId}`
  const outcome = await waitForToolConfirm(ctx.requestId, syntheticToolUseId)  // 复用，5min 超时
  const payload = interactionPayloads.get(syntheticToolUseId)                  // 取走中转载荷
  interactionPayloads.delete(syntheticToolUseId)
  if (outcome === 'timeout') return { approved: false }
  return { approved: payload?.approved ?? false, trustCommand: payload?.trustCommand }
}

export async function waitSubagentInquiry(ctx, dispatchId, req): Promise<{
  action: 'accept' | 'reject'; content?: string; choice?: string
}> {
  const syntheticToolUseId = `${ctx.toolUseId}#sub:${req.inquiryId}`
  const outcome = await waitForToolConfirm(ctx.requestId, syntheticToolUseId)
  const payload = interactionPayloads.get(syntheticToolUseId)
  interactionPayloads.delete(syntheticToolUseId)
  if (outcome === 'timeout' || !payload?.approved) return { action: 'reject' }
  return { action: 'accept', content: payload.inquiryAnswer, choice: payload.inquiryChoice }
}
```

handler 侧扩展（`appIpc.ts:289-331`）：识别 `payload.source === 'subagent'` 时，先 `storeInteractionPayload(syntheticToolUseId, {approved, trustCommand, inquiryAnswer, inquiryChoice})`，再照常 `submitToolConfirmResponse(...)`；工具确认的信任写入（命令类 CLI 工具）复用现有 `addTrustedCommand`。问询超时按拒绝处理（需求 §8.5.2）。**问询等待不计入无活动超时**（runtime 在 `awaiting_inquiry` 时暂停看门狗）。

### 8.3 CLI 工具风险等级映射（DD-4）

现有 `builtinToolRiskLevel(name)`（`domainTypes.ts:514-533`）按内置工具名硬编码，**不改动**（保持内置工具行为不变）。新增独立映射：

```typescript
// electron/subagent/subagentSecurity.ts
export function cliToolRiskLevel(agent: SubagentType, cliToolName: string): ToolRiskLevel {
  // Claude Code: Read/Grep → low；Edit/Write → medium；Bash → high
  // Codex: read/search → low；apply_patch → medium；shell → high
  // 未知 → high（保守）
}
```

风险等级用于：确认卡片展示、是否提供信任选项（高危不提供，§8.4）、`auto` 模式下高危是否仍强制确认（见下）。

### 8.4 授权策略执行（对齐需求 §8.1，按引擎分流，DD-8）

> **V-CC-02 实测**：Claude Code `-p` 模式无 control_request、工具自动执行，**无逐次确认**（observe-only，见 §4.1/DD-8）。下表「confirm -> 弹卡 -> 回写」流程**仅适用于 Codex**；Claude Code 的 `confirm` 退化为「`--disallowedTools` 禁高危 + 观察」，`auto` 为纯观察。两引擎 confirm 语义须在设置页与启动闸门卡醒目区分（需求 §8.4）。

| 引擎 | 策略 | 行为 |
|------|------|------|
| **Codex** | `confirm` | CLI 工具调用 -> `emit('tool_confirm')` -> 弹内部工具确认卡 -> 用户决策 -> `respondToolApproval` 回写。高危强制确认、不提供信任选项（`shellCommandTrust.ts:24-31`） |
| **Codex** | `auto` | 后端直接回 accept，仅展示不拦截；高危命中强制 deny 仍拦截（`runShellSecurityValidators`） |
| **Claude** | `confirm` | observe-only + `--disallowedTools` 禁高危（PowerShell/Bash/Write/Edit）；允许的工具自动执行，无逐次确认 |
| **Claude** | `auto` | observe-only，全工具自动执行 |


### 8.5 信任机制复用

- **命令类工具**（Claude Bash / Codex shell）：直接复用 `ShellConfig.trustedCommands` + `matchesTrustedCommand`（`shellCommandTrust.ts:13-22`，前缀匹配）。用户在内部工具确认卡点「信任此命令」→ `tool:confirm-response` 携带 `trustCommand` → `appIpc.ts:289-331` handler 写入 `addTrustedCommand`（**需扩展 handler**：当 `source='subagent'` 且 `cliToolName` 为命令类时，从 `input` 提取命令文本写入信任）。
- **文件类工具**（apply_patch / Edit / Write）：复用 `writeFileAutoApproval.evaluate()` 模式或新增 CLI 文件操作自动放行评估。
- 信任跨会话生效（验收 §16.4）。

### 8.6 用户问询（对齐需求 §8.5）

- **Codex**：`mcpServer/elicitation/request` → `emit('inquiry')` → 问询卡（选项单选 + 自定义输入）→ `respondInquiry({action:'accept', content})`。✅ 落地。
- **Claude**：`AskUserQuestion` tool_use 的结构化触发与回写路径未明（TVQ-1）。**验证不通过则** `--disallowedTools AskUserQuestion` 禁用问询，不影响其他能力（需求 §8.5.4）。
- 问询卡 `SubagentInquiryCard`：展示问题、候选选项（单选）、自定义输入框、提交/跳过（跳过=reject）。来源标注「Subagent（Claude Code / Codex）」（需求 §8.5.2）。

### 8.7 自动批准安全提示

设置页开启「自动批准」时卡片醒目提示「Subagent 将无人值守执行本地文件与命令操作」（需求 §8.4）。启动闸门确认卡（§6.1）在 `toolApproval='auto'` 时同样提示。

### 8.8 用户干预

| 操作 | 行为 |
|------|------|
| 批准 | Subagent 继续该工具 |
| 拒绝 | 该工具被拒，回写 deny，Subagent 自主调整后续 |
| 信任 | 写信任列表，后续同类免确认 |
| 终止委派 | 复用 `tool:cancel` → `ctx.signal.abort` → `killProcessTree`，标记 aborted，已执行操作不回滚（需求 §8.3） |

---

## 9. 结果回收与主流程衔接

### 9.1 回收结构（对齐需求 §9.1）

`SubagentRuntime` 汇总 `SubagentDispatchRecord`（§1.1）：`status` / `finalOutput` / `error` / `stderrTail` / `tokenUsage` / `filesChanged` / `durationMs` / `toolSummaries`。

### 9.2 主 Agent 衔接

- `finalOutput` 经 `formatToolResultPayload()`（`toolChatLoop.ts:191`）序列化为 `tool_result.content`，`tool_use_id` 为 dispatch 的 id，注入主 Agent 上下文继续推理（需求 §9.2）。
- 单会话可多次委派（同/不同引擎），可与内置工具穿插。
- token 用量并入会话统计（§14）。

### 9.3 token 用量归一化

Claude `result.usage` 与 Codex `turn/completed` usage 字段名/口径不同（需求 §7.2）。后端各自归一化为 `{input?, output?, cacheRead?}`，缺失则省略。

---

## 10. 安全与边界

### 10.1 工作目录约束（对齐需求 §11.1）

- `cwd` 默认主会话工作目录，可指定为其**子目录**，不允许越界。
- 复用 `pathSecurity.resolveSafePathReal(workDir, cwd)`（`electron/pathSecurity.ts:21`，含 realpath 二次校验防符号链接逃逸）。越界在 executor 校验阶段即拒绝。
- Subagent CLI 的 `cwd` 设为校验后的绝对路径；CLI 内部工具的文件操作由「CLI 工作目录 + 确认机制 + 路径安全校验器（命令类复用 `runShellSecurityValidators`）」共同约束。

### 10.2 进程隔离与终止（对齐需求 §11.2）

- 每次委派独立子进程，进程级隔离。
- 终止复用 `killProcessTree`（Windows `taskkill /T /F`、Unix 进程组信号），可靠杀孙进程（bash/cmd 等）。
- 委派结束（完成/超时/终止/会话关闭）均触发清理；会话关闭时主进程遍历在途 runtime 调 `kill`。

### 10.3 环境变量（对齐需求 §11.3）

子进程环境过滤（参考实现 §6.3）：
- **过滤**：`CLAUDECODE`、`CLAUDE_CODE_ENTRYPOINT`、`CLAUDE_CODE_EXECPATH`、`CLAUDE_CODE_SESSION_ID`、`CLAUDE_CODE_SSE_PORT`、所有 `CLAUDECODE_*` 前缀——避免 Subagent 误判自身运行环境。
- **保留**：用户级配置（代理 `HTTP_PROXY`/`HTTPS_PROXY`、CLI 自定义路径、`CODEX_HOME` 等）。
- **鉴权隔离**：Subagent 鉴权由各 CLI 自行管理（Claude Code 登录态、Codex 配置），**不注入主 Agent HTTP API Key**（N7 / D5）。

### 10.4 超时与并发（对齐需求 §5.5 / §11.4）

| 项 | 默认 | 实现 |
|----|------|------|
| 执行超时 | 30 min | `timeoutMs` 绝对计时 |
| 无活动超时 | 10 min | `inactivityTimeoutMs`，每事件重置；问询/确认等待期间暂停 |
| 首轮无进度 | 30 s | `firstProgressTimeoutMs`，启动后未收首个有效事件快速失败 |
| 全局并发 | 2 | 模块级 Promise 信号量，跨会话合计，超额排队 |
| 单次最大轮次 | `maxTurns` 参数 | 透传 CLI（Claude `--max-turns` / Codex turn 限制） |
| 输出体量 | 截断 | 流式与摘要截断，超大输出落盘（复用 `persistLargeOutput`） |

### 10.5 日志（对齐需求 §11.5）

仿 `shellAgentLogger` 新建 `subagentLogger`，预处理字段后调 `logAgentEvent`，写入同一 `Agent-{YYYYmmdd}.log`（开发态 `logs/`、打包态 `{workDir}/.agent/logs/`，JSONL）。**日志由主进程在「解析 CLI 事件 / 做决策」环节记录，CLI 不参与**（N8）。

| event | 时机 | 字段（均 `sanitizeForLog`） |
|-------|------|------------------------------|
| `subagent.dispatch.start` | 启动 | agent、task 摘要（前 N 字 + 长度，不落全文）、cwd、model、thinkingLevel、toolApproval、timeout |
| `subagent.cli.launch` | 子进程启动 | execPath、args 摘要、pid |
| `subagent.tool.request` | 内部工具请求 | cliToolName、参数摘要、是否需确认 |
| `subagent.tool.decision` | 用户决策 | approved/rejected/trusted |
| `subagent.tool.result` | 工具结果 | 状态、长度、是否截断 |
| `subagent.inquiry.request` | 问询请求 | 问询摘要、是否有选项 |
| `subagent.inquiry.response` | 问询回答 | accept/reject、回答摘要 |
| `subagent.dispatch.complete` | 完成 | status、finalOutput 摘要、tokenUsage、filesChanged、durationMs |
| `subagent.dispatch.error` | 失败/超时/终止 | 错误类型、stderr tail 摘要 |

脱敏：敏感 key、`sk-ant-*`、`Bearer xxx`、长 base64 自动 redact；task 只记摘要；不记逐字文本/完整思考流；stderr tail 仅 error 时附加（需求 §11.5）。

### 10.6 自动批准安全提示

`toolApproval='auto'` 在设置页与启动闸门卡均醒目提示（§8.7）。建议仅在工作目录受控、用户充分信任的场景启用（需求 §8.4）。

---

## 11. 跨平台（对齐需求 §12）

| 平台 | 要求 | 实现 |
|------|------|------|
| **Windows** | 隐藏控制台、不弹黑窗；`Kill` 兜底 | `windowsHide:true` + `spawnCommand` 的 `cmd.exe /d /s /c` 包装 + `killProcessTree`（`taskkill /T /F`） |
| **macOS** | 进程组管理；Codex Desktop 包内 CLI 探测 | `detached:true`（Setpgid）+ `process.kill(-pid)`；探测 Codex Desktop `app.bundle` 内 CLI 路径 |
| **Linux** | 进程组管理；负 PID 信号终止整组 | 同 macOS 进程组方案 |

- CLI 路径解析兼容 nvm/fnm/volta：自动检测 PATH 失败时支持手动填绝对路径；`runWhich`（`where`/`which`）+ 登录 shell 解析兜底（参考实现 §12.4.2）。
- **`spawnUtil` 增强**：Unix 分支显式 `Setpgid`（当前 `killProcessTree` Unix 路径仅 SIGTERM+close，对孙进程不可靠）。新增 `spawnSubagentProcess` 或为 `spawnCommand` 增加 `detached` 选项。

---

## 12. CLI 安装检测与模型/思考级别发现

### 12.1 安装检测（复用 `larkCliRunner` 模式）

```typescript
// electron/subagent/subagentCliDetect.ts
export interface SubagentCliDetectResult {
  installed: boolean
  version?: string
  path?: string
  installStatus: SubagentInstallStatus
}
export async function detectSubagentCli(type: SubagentType, executablePath?: string): Promise<SubagentCliDetectResult>
```

- 执行 `<cli> --version`，`extractVersionLine` 提取版本（跳过 npm shim 的 `Active code page: 65001` 等无关行，参考实现 §11.1.2）。
- 超时 10s + `WaitDelay` 2s（防卡死 CLI 阻塞，参考实现 §11.1.1）。
- 最低版本：Claude Code ≥ 2.0.0；Codex ≥ 0.100.0（app-server stdio 所需）。版本过低 → `installStatus='outdated'`，禁用启用开关（需求 §5.2）。
- 路径解析：配置 `executablePath` 优先，否则 `runWhich`，再退登录 shell。

### 12.2 模型发现

| Subagent | 来源 | 缓存 |
|----------|------|------|
| Claude Code | 静态列表（claude-sonnet-5 / claude-opus-4-8 / claude-fable-5 / claude-haiku-4-5 等） | 无（静态） |
| Codex | `codex debug models --bundled`（≥0.122.0），失败/旧版回退静态 | 60s，空结果不缓存 |

缓存键 `(agent, execPath, cliVersion)`，CLI 升级后自动失效（参考实现 §11.4.4）。

### 12.3 思考级别发现

| Subagent | 来源 |
|----------|------|
| Claude Code | 解析 `claude --help` 的 `--effort` 行 → `[low,medium,high,xhigh,max]`；按模型过滤（`claudeModelEffortAllow` 等价表）；解析失败用静态超集；旧版无 `--effort` → 禁用下拉 |
| Codex | `codex debug models` 返回每模型支持级别；空模型失败关闭（参考实现 §10.3.1） |

缓存 10min，键含版本（参考实现 §10.4）。

---

## 13. 配置与 IPC

### 13.1 配置存储（复用增量 key-value，对齐需求 §13.3）

- `CONFIG_KEYS`（`appIpc.ts:118-143`）新增 `subagents: 'config.subagents'`。
- `readSubagentsConfig(db)`（仿 `readToolsConfig`，`appIpc.ts:200-218`）：缺值返回 `DEFAULT_SUBAGENT_PROFILES`，有值 `mergeSubagentsConfig`。
- `config:get`（`appIpc.ts:696-792`）组装时加入 `subagents`。
- `config:set`（`appIpc.ts:794-1058`）加分支：`payload.subagents !== undefined` → `mergeSubagentsConfig` 后 `setConfigValue`。
- `api.ts:243-278` `configSet` payload 类型加 `subagents: SubagentProfile[]`。
- **无 DDL 变更、无 schema migration**（`configs` 表 key-value 结构足够）。

### 13.2 独立 IPC（仿飞书 `feishu:detect-cli`）

| 通道 | 用途 | preload API |
|------|------|-------------|
| `subagent:detect` | 检测 CLI 安装 + 版本 | `subagentDetect(type, executablePath?)` |
| `subagent:discover-models` | 发现模型 + 思考级别 | `subagentDiscoverModels(type, executablePath?)` |

注册于 `subagentIpc.ts`（仿 `feishuIpc.ts:156-189`）。

### 13.3 设置页 Subagent Tab（仿 `FeishuSettingsTab`）

- `ConfigModal.tsx:91` `SETTINGS_SECTION_KEYS` 加 `'subagent'`；`:233-243` labels 加 `subagent`；`:821-979` `renderSectionContent` switch 加 `case 'subagent'`。
- 新建 `SubagentSettingsTab.tsx`：两张卡片（Claude Code / Codex），每张含：启用开关、安装状态（● 已安装 vN / ● 未安装 / ● 版本过低）、CLI 路径 + 自动检测、默认模型下拉、默认思考级别下拉、工具授权单选（确认后执行 / 自动批准）、执行超时 / 无活动超时。
- 进入 Tab 自动检测；「重新检测」按钮；版本过低禁用启用开关（需求 §5.1 / §5.2）。
- 模型/思考级别按 CLI 实际支持动态过滤；CLI 未安装时下拉空态（需求 §5.3）。
- 脏检查：`configModalSnapshot.ts:79` 快照 input 加入 subagent 草稿。
- 受控组件模式：父级 `useState` 持草稿，`onChange` 上抛，`handleSave` 打包 `configSet`（与现有 Tab 一致）。

---

## 14. 持久化与统计

### 14.1 委派记录持久化（对齐需求 §13.2 / §13.3 / D11）

- 委派作为一条工具调用记录嵌入消息历史，复用现有消息/工具调用表结构（无独立工具表，存于 `messages` 表 `tool_use` / `tool_calls` 两个 TEXT 列，`schema.ts:34-50`）。
- **运行期** `ToolCallRecord`（`domainTypes.ts:562-590`）携带全量 `events: SubagentEvent[]` 供 UI 实时展示。
- **持久化** `ToolUseData`（`domainTypes.ts:610-620`）扩展可选字段 `subagent?: SubagentDispatchRecord`，仅存摘要级（task + finalOutput + status + tokenUsage + filesChanged + toolSummaries + durationMs），**不存逐字文本与完整思考流**（D11）。
- **序列化/反序列化（已核查，🔴 须改造反序列化白名单）**：
  - 序列化 `serializeToolUseForDb`（`messageCodec.ts:6-20`）用 `...tool` spread，`subagent` 字段自动写入 DB。
  - 反序列化 `deserializeToolUseFromDb`（`messageCodec.ts:22-58`）为**字段白名单**逐一重建，**未列 `subagent` -> 加载时丢弃**。**必须**在返回对象显式加 `subagent: o.subagent`。`deserializeToolCallsFromDb`（`messageCodec.ts:108-140`）同为白名单（已故意排除若干运行期字段，`subagent` 摘要属需保留项）。
  - 其他 normalize（`cloneMessages` / `mergeDbAndLive`，`chatRunnerService.ts:33-60`）用 spread，保留字段，安全。
- **体量控制**：TEXT 列无硬限制，但每条消息加载都反序列化整个 `tool_use` JSON。`filesChanged` / `toolSummaries` 设上限 + 超出截断/落盘引用，控制 JSON 体量（上百 KB 有加载性能风险）。
- **备份**：`sessionBackupManager` 从 DB 加载后整体 `JSON.stringify`，无字段过滤 -> 修复反序列化后备份自动包含 `subagent`。往返测试：含 `subagent` 的 ToolUseData -> serialize -> deserialize -> 验证字段完整；备份/恢复往返。

### 14.2 配置迁移

现有配置无 `subagents` 字段时，`readSubagentsConfig` 返回 `DEFAULT_SUBAGENT_PROFILES`（两张默认禁用卡片），现有用户零影响（验收 §16.8）。

### 14.3 token 统计

Subagent 委派 `tokenUsage` 并入会话 token 用量统计与展示（复用现有 token 统计路径）。

---

## 15. i18n（对齐需求 §15）

- 新增 `subagent` 命名空间（设置页 Tab、配置项、卡片文案、状态、错误）；委派卡片聊天区文案放 `chat.subagent.*`。
- key 命名 `subagent.组件.语义`（camelCase，最多 4 层）。
- 状态/错误文案用 `errors` 命名空间 + `src/shared/errorCodes.ts` 错误码模式（未安装、版本过低、超时、终止失败、cwd 越界等）。
- `zh-CN` 为真实来源；新增 key 后 `npm run i18n:generate-types`；提交前 `npm run i18n:check`。

---

## 16. 测试策略

### 16.1 主进程（node 环境）

- `subagentProcess.test.ts`：spawn/kill（mock `spawnUtil`）、stderr tail、环境变量过滤（断言 `CLAUDECODE_*` 被剔除、代理变量保留）。
- `claudeCodeBackend.test.ts`：用伪造的 stdout 行流（stream-json 样例）喂后端，断言事件映射（assistant→text/thinking/tool_call、result→done、control_request→tool_confirm）、`respondToolApproval` 写出正确 `control_response`。
- `codexBackend.test.ts`：伪造 JSON-RPC 双向流，断言 initialize/thread/start/turn/start 顺序、server request 路由（approval/elicitation）、`respondInquiry` 回写。
- `subagentRuntime.test.ts`：三档超时（mock 时钟）、交互暂停恢复（mock `waitSubagentToolConfirm`）、取消（abort→kill）、结果汇总。
- `dispatchSubagentExecutor.test.ts`：未安装/版本过低/cwd 越界即返错；并发信号量排队；正常路径返回 `ToolExecutorResult`（mock runtime）。
- `subagentCliDetect.test.ts`：`--version` 输出解析（含 npm shim 噪声行）、最低版本判定、路径回退。
- `subagentSecurity.test.ts`：CLI 工具风险等级映射、信任判定适配。
- **不依赖真实 Claude Code / Codex CLI**；§17 手工验收作发布门禁。

### 16.2 渲染（jsdom 环境）

- `SubagentExecutionCard.test.tsx`：事件流渲染、折叠/展开、待处理高亮、完成态只读。
- `SubagentToolConfirmCard.test.tsx` / `SubagentInquiryCard.test.tsx`：来源标注、选项单选、自定义输入、提交/跳过。
- `SubagentSettingsTab.test.tsx`：检测状态展示、版本过低禁用开关、模型下拉动态过滤。
- `chatToolSessionService` 扩展：`tool:progress` 的 `subagent` payload → 嵌套事件追加与状态更新。

### 16.3 并行委派专项（DD-2 高风险）

- toolChatLoop 并发批：一轮内 2 个 dispatch_subagent（mock runtime 不同延迟）+ 1 个 edit_file，断言 edit_file 顺序执行、两个 dispatch 并发、结果按 id 顺序回填、信号量排队生效。

### 16.4 手工验收

按需求 §16 全量验收清单，重点：跨平台进程终止无泄漏、Windows 无黑窗、Codex elicitation 端到端、Claude 问询验证结论。

---

## 17. 分阶段实现

产品 Phase 1 须同时支持 Claude Code + Codex（D2）。内部按里程碑推进：

### 里程碑 A：基础底座 + Claude Code（可独立验证）
- 类型与配置（§1 / §13）、`SubagentProcess` / `SubagentBackend` 抽象（§3）、`SubagentRuntime` + executor（§3.3-3.4）、ClaudeCodeBackend（§4）、`ToolProgressPayload` 扩展 + `SubagentExecutionCard`（§7）、确认 IPC 复用 + CLI 风险映射（§8.1-8.5）、安全与日志（§10）、设置 Tab（§13.3）、检测/模型发现（§12）、持久化（§14）、测试（§16.1-16.2 的 Claude 部分）。
- 交付：Claude Code 端到端可委派、过程可见、内部工具可确认、结果回收。

### 里程碑 B：Codex + 问询 + 并行
- CodexBackend（§5）、Codex 模型动态发现（§12.2）、Codex elicitation 问询端到端（§8.6）、单轮内并行委派（§6.5）、`spawnUtil` Unix 进程组增强（§11）。
- 交付：Codex 端到端、双引擎可选、无依赖并行、跨平台进程组终止。

### 里程碑 C：增强与打磨（可顺延至后续迭代）
- Claude 问询（TVQ-1 验证通过则落地，否则维持禁用）、编排 Skill 内容打磨、自动批准 UX、`filesChanged` 跳转 diff/回滚（D14 后续）。

---

## 18. 已决设计事项与待验证

### 18.1 设计决策（DD）

| ID | 决定 | 理由 |
|----|------|------|
| **DD-1** | `dispatch_subagent` 登记为高危工具，启动前必经一次「启动闸门」确认 | 启动自主 Agent 属高危；与 run_shell 一致；auto 模式下此次闸门即「确认无人值守」，平衡 US-4 与安全 |
| **DD-2** | 单轮内多 `dispatch_subagent` 并发执行，内置工具仍顺序（方案 D：先启动 dispatch 不 await -> 顺序内置 -> `allSettled` 收集）；dispatch 豁免 `toolErrorRepeat`/`abortRepeatedToolError`，`recoverySkillSystemSuffix` 隔离 | 满足 §6.4/§16.2 并行；避免内置文件工具竞态；确认/cancel/进度按 id 寻址已核查并发安全；双引擎并发测试待环境 B |
| **DD-3** | 内部工具确认/问询复用 `tool:confirm-request/response` 通道 + `toolConfirmRegistry`（合成 toolUseId）；因 registry 仅回传布尔，新增 `subagentInteractionRegistry` 中转完整载荷（问询文本/信任命令） | IPC 通道零新增、与工具类型解耦；布尔等待负责唤醒、registry 负责传话；handler 加 `source='subagent'` 分支 |
| **DD-4** | CLI 工具风险等级用独立 `cliToolRiskLevel`，不改动 `builtinToolRiskLevel` | 保持内置工具行为不变；CLI 工具名与内置不同，需独立映射 |
| **DD-5** | `config.subagents` 存 `SubagentProfile[]`（对齐需求 §13.1），全局参数为代码常量 | 忠实需求；全局上限非用户可配项，避免过度设计 |
| **DD-6** | 持久化摘要级（`SubagentDispatchRecord` + `toolSummaries`），运行期全量 `events` 不逐字入库（D11）；**反序列化 `deserializeToolUseFromDb` 白名单须显式加 `subagent` 字段**（已核查），大列表设上限 | 信息分层控制持久化体量；序列化 spread 安全，反序列化白名单是唯一丢字段点；备份随之自动包含 |
| **DD-7** | Subagent 无状态，不续接线程；上下文由主 Agent 对话历史维护 | D9；Claude session_id/Codex threadId 仅入日志 |
| **DD-8** | Claude Code 授权降级为 observe-only：`-p` stream-json 模式无 control_request、工具自动执行（V-CC-02 实测），无逐次确认能力。`toolApproval='confirm'` 对 Claude 退化为「`--disallowedTools` 禁高危（PowerShell/Bash/Write/Edit）+ 观察」，`auto` 为纯观察；逐次确认（DD-3 机制）仅 Codex 支持 | 协议限制（v2.1.207）；不注入 MCP（N3）；设置页与闸门卡须区分两引擎 confirm 语义。待标准 Anthropic API 环境回归确认是否代理相关 |

### 18.2 待验证（TVQ）

| ID | 问题 | 验证方式 | 不通过的影响 |
|----|------|----------|--------------|
| **TVQ-1** ✅ 已验证·不通过 | Claude Code stream-json 下 `AskUserQuestion` 问询的结构化触发与回写路径 | 实测（2026-07-12，v2.1.207）：`-p` 模式 tools 列表不含 `AskUserQuestion`；要求调用时 claude 文字拒绝、无 tool_use 事件 | **已确认不通过**：Claude 侧禁用问询（`--disallowedTools AskUserQuestion` 防御性保留），里程碑 C Claude 问询不实现；Claude 纯 observe-only（DD-8）；Codex 问询不受影响（需求 §8.5.4 / D12） |
| **TVQ-2** | Codex `app-server` 在目标版本（≥0.100.0）的 JSON-RPC 方法名与字段稳定性 | 实测 `codex app-server --listen stdio://`，核对 initialize/thread/start/turn/start、approval/elicitation method | 字段差异由 CodexBackend 适配层吸收；method 不稳定则提高最低版本要求 |
| **TVQ-3** | `spawnUtil` Unix 进程组对孙进程（bash/cmd）的可靠终止 | 实测 Unix 下 Subagent 派生 bash 后 kill 是否清理干净 | 增强 `spawnUtil` 显式 `Setpgid` + `kill(-pid)`（§11） |

---

## 19. 涉及文件清单

| 文件 / 模块 | 变更类型 |
|-------------|----------|
| `src/shared/subagentTypes.ts` | 新增：`SubagentProfile` / `SubagentDispatchRecord` / `SubagentEvent` 等领域类型 |
| `src/shared/domainTypes.ts` | 修改：`AppConfig` 加 `subagents`；`ToolProgressPayload` 加 `subagent` 字段；`ToolUseData` 加 `subagent?` |
| `src/shared/builtinToolDefinitions.ts` | 修改：追加 `dispatch_subagent` 定义 |
| `src/shared/api.ts` | 修改：`configSet` payload 加 `subagents`；扩展 `ToolConfirmRequest/ResponsePayload`；新增 subagent detect/discover API 类型 |
| `electron/subagent/`（新建目录） | 新增：`subagentProcess` / `subagentBackend` / `claudeCodeBackend` / `codexBackend` / `subagentRuntime` / `subagentInteraction` / `subagentCliDetect` / `subagentLogger` / `subagentSecurity` / `subagentTypes` / `subagentIpc` |
| `electron/tools/dispatchSubagentExecutor.ts` | 新增：`dispatch_subagent` 执行器 |
| `electron/tools/builtinExecutors.ts` | 修改：registry 注册 `dispatchSubagentExecutor` |
| `electron/toolChatLoop.ts` | 修改：单轮内 `dispatch_subagent` 并发批执行（§6.5） |
| `electron/toolsConfigRuntime.ts` | 修改：`filterBuiltinToolsForApi` 按启用且安装达标的 profile 注入 `dispatch_subagent` |
| `electron/toolInputGuards.ts` | 修改：`assertSafeToolInput` 加 `dispatch_subagent` case |
| `electron/appIpc.ts` | 修改：`CONFIG_KEYS.subagents`、`config:get/set` 处理 subagents；`tool:confirm-response` handler 扩展（subagent 来源 + 信任写入 + 问询回答路由） |
| `electron/preload.ts` | 修改：暴露 `subagentDetect` / `subagentDiscoverModels`；扩展 tool confirm payload 类型 |
| `electron/spawnUtil.ts` | 修改：Unix 进程组 `Setpgid` + `detached` 支持（TVQ-3） |
| `electron/pathSecurity.ts` | 复用（无改动）：`resolveSafePathReal` 校验 cwd |
| `electron/shell/shellCommandTrust.ts` | 复用（可能微调）：信任判定适配 CLI 命令类工具 |
| `src/shared/subagentPrompts.ts` | 新增：编排 Skill 内容 + 工具描述文案 |
| `src/renderer/components/Config/SubagentSettingsTab.tsx` | 新增：设置页 Subagent Tab |
| `src/renderer/components/Config/ConfigModal.tsx` | 修改：`SETTINGS_SECTION_KEYS` / labels / `renderSectionContent` 加 subagent |
| `src/renderer/components/Config/configModalSnapshot.ts` | 修改：脏检查快照加 subagent 草稿 |
| `src/renderer/components/Chat/SubagentExecutionCard.tsx` | 新增：Subagent 执行卡片 |
| `src/renderer/components/Chat/SubagentToolConfirmCard.tsx` | 新增：内部工具确认卡片 |
| `src/renderer/components/Chat/SubagentInquiryCard.tsx` | 新增：用户问询卡片 |
| `src/renderer/components/Chat/ToolCallCard.tsx` | 修改：`dispatch_subagent` 分派到 `SubagentExecutionCard` |
| `src/renderer/services/chatToolSessionService.ts` | 修改：`tool:progress` 的 `subagent` payload → 嵌套事件与状态 |
| `src/renderer/i18n/resources/{zh-CN,en-US}/` | 新增：`subagent.json` + `chat.subagent.*` + errors |
| `electron/database/` | 复用（无 DDL）：`configs` key-value 存 subagents；消息/工具调用表存委派记录摘要 |
| `electron/messageCodec.ts` | 修改：`deserializeToolUseFromDb` 白名单显式加 `subagent` 字段（DD-6，已核查丢字段点） |
| 测试 | 新增：`electron/subagent/*.test.ts`、`dispatchSubagentExecutor.test.ts`、渲染端组件测试、toolChatLoop 并发批测试 |

---

*文档结束*

**备注：** 本设计聚焦技术实现决策（Backend 抽象、协议适配、嵌套事件流、确认/问询复用、安全边界、分阶段实现）。产品需求与验收以 [cli-subagent-integration-requirement.md](../requirement/cli-subagent-integration-requirement.md) v1.7 为准。TVQ-1/2/3 须在里程碑 A/B 启动前完成验证。
