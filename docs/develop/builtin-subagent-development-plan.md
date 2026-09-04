# Builtin SubAgent 详细开发方案

> 需求基线：`docs/requirement/builtin-subagent-requirement.md` v1.3
> 关联设计：`docs/develop/background-task-execution-layer-technical-design-v3.md`
> 准入基线：`docs/develop/background-mission-soft-gate-simplification-plan.md`
> 状态：待评审
> 更新日期：2026-08-09

## 1. 方案结论

Builtin SubAgent MVP0 采用“Mission-owned BuiltinBackend + 独立无密钥推理子进程 + 私有最小 JSON-RPC stdio + 宿主 LLM/工具代理”的实现。首版不建设通用 Invocation Runtime，也不宣称 ACP 兼容。

本方案不新增第二套 Mission 生命周期。Builtin 的进程协议实验可与 backgroundMission 并行；完整 Host 合同必须等 backgroundMission 至少提供可编译的窄接口和一个真实 backend 纵向路径后再冻结：

```text
MissionSupervisor → AgentRunHost → BuiltinBackend
                                      ├─ Builtin RPC / process / cancellation
                                      ├─ Host LLM / Tool / Permission ports
                                      └─ Builtin Node child process
                                           └─ inference loop（无密钥、无直接工具、无 Mission 类型）
```

本文对 Host 接口的描述只是接入预期。Phase 0 可以验证最小子进程协议，但不得用两个 fake 消费者推演并冻结完整 Host、预算、恢复或 UI 合同。接入方案以 backgroundMission 的首个真实 backend 纵向闭环为依据；真实接口未出现前只记录待决项，不把猜测固化成公共抽象。

Builtin 不能作为孤立功能直接叠加到现有聊天 `toolChatLoop`。现有 `toolChatLoop`、`pathSecurity`、Shell 权限、SQLite、IPC 和 LLM 配置可以提取能力或复用策略。backgroundMission 仍提供本期权威 Run 生命周期；宿主侧 `BuiltinBackend` 可以依赖 Mission/AgentRun，只有子进程推理内核和私有 RPC schema 不得依赖 Candidate/Recovery 等宿主持久化类型。

### 1.1 可复用性决策

- 需求 v1.3 的 MVP0 产品入口只是后台 Mission；本方案不提前交付界面交互 Agent 入口。
- 本期不定义 `SubAgentCallerKind`、interactive workspace 模式或 fake interactive adapter。
- 仅保持 Builtin 子进程推理内核不导入 Mission 类型，为以后提取共享代码留下可能性，而不是预先承诺公共 API。
- 未来交互 Agent 排期时，根据第二个真实用例的生命周期、权限和流式返回需求再决定是否提取 Invocation Host。

## 2. 实施边界与默认决策

### 2.1 Phase 0 开工条件与集成 Gate

Phase 0 是独立的前置设计与实验任务，不以 backgroundMission 完工为前提。开工只要求：

- 能识别 backgroundMission 当前代码或设计基线，并能列出已实现能力与未完成项；
- 双方明确模块所有权：Mission 生命周期、强制权限、预算、恢复、Candidate 和验证属于 backgroundMission，Builtin 不复制这些能力；
- 能明确最小进程协议实验的边界；fake 只验证 transport/进程可行性，不用于冻结完整 Host 合同。

以下条件不是 Phase 0 开工条件，而是重写并冻结 Builtin 实施接口、进入真实纵向开发前的集成 Gate：

- backgroundMission 至少有可编译的 AgentRunHost/Backend 窄接口和一个真实 backend 纵向闭环；
- 本次 MVP0 依赖的状态迁移、generation fencing、取消、文件工具、预算和 Candidate 验证接口具备可运行实现；
- `Capability`、`backend_trust`、`verified_admission` 和 Builtin authorization 的边界通过 contract/integration tests；
- 接入基线 commit、接口差异和未完成项可追溯。

Renderer、RecoveryBundle、Review、通用 Shell 和长任务能力不是 MVP0 的开工条件。未通过集成 Gate 时，只继续最小子进程/RPC 实验，不冻结推测性的 Runtime、预算、恢复、UI 或 interactive 合同，也不得在 SubAgent 内补一套临时控制面。

### 2.2 MVP0 范围

范围以需求 §19 的权威表为准。本方案只补充实现顺序：先接入一个真实 AgentRun/backend 纵向闭环，再做协议加固和内部 Alpha。

### 2.3 延后范围

需求 §19 中未列入 MVP0 的能力不进入 Phase 0～3 Gate。后文 GA 章节只记录候选接入点，不构成当前承诺。

### 2.4 对需求待评审项的实现默认值

| 待定项 | MVP 默认 |
|---|---|
| 后端选择 | MVP0 由 feature flag 或内部配置显式选择 Builtin，不自动从 Codex 回退；GA 再定义优先级和回退策略。Builtin authorization 始终拒绝 Codex authorization |
| LLM 支持 | MVP 只接入一个已验证 provider/profile；后续再扩展兼容性 |
| Builtin 信任模型 | Builtin 推理子进程是受信任应用组件；不提供或声明自身强 runtime sandbox，以依赖边界、无密钥环境和 Host RPC capability 保证产品能力只能经宿主调用 |
| 上下文 | persistent Mission block + 有界最近历史；达到上限返回 `CONTEXT_EXHAUSTED` |
| waiting 宽限期 | 属于 Long-running GA，MVP0 不进入 waiting/parked |
| 自动写入 | 只在 Mission 授权范围内；宿主风险策略仍可要求确认 |
| 最大轮次 | 由上下文窗口、token 预算和策略上下限共同推导，不写死 50 |

上述默认值应在 Phase 0 评审中冻结；如产品决策变化，只修改策略配置，不改变协议或状态机。

## 3. 新增文件与依赖接口

SubAgent 项目不枚举、复制或重建 backgroundMission 的 Mission、状态机、事件、恢复、Candidate、Review、IPC 和 Renderer 模块。最终文件名以同一 worktree 冻结基线中的真实结构为准；本项目预计只新增：

```text
src/shared/subagent/
  builtinRpcTypes.ts          私有 Builtin RPC 类型
  builtinRpcSchemas.ts        消息、工具和 result schema
  normalizedLlm.ts            provider-neutral message/tool/usage
  errors.ts                   稳定错误码

electron/subagent/
  transport/
    jsonRpcPeer.ts             双向 RPC、超时、关闭和大小限制
    ndjsonCodec.ts             每行一个 JSON 对象
  adapter/
    builtinBackend.ts          AgentRun backend、进程、RPC 和 result 映射
    builtinPathResolver.ts     开发/打包统一入口解析
    builtinCapabilityProbe.ts
    hostRpcBridge.ts           Builtin RPC 请求转接至既有 Host 能力
  builtin/
    main.ts                    子进程唯一入口
    server.ts                  Builtin RPC server
    session.ts                 单 session 状态
    inferenceLoop.ts
    contextManager.ts
    outcomeBuilder.ts

scripts/
  verify-builtin-subagent.mjs
```

backgroundMission 必须为 MVP0 提供以下窄接口；它们由 `BuiltinBackend` 消费，不得泄漏到子进程推理内核：

| 依赖接口 | Builtin 使用方式 |
|---|---|
| `AgentBackend` / registry | 选择 Builtin 后启动对应 AgentRun backend |
| `AgentRunHost` | 托管 Mission 状态、generation、Run outcome、取消和恢复 |
| Host ToolGateway / PermissionGateway | `hostRpcBridge` 转发文件、终端和授权请求 |
| Budget | 提供固定上限和权威计量，不另算权威状态 |
| Containment | 启动和正常回收 Builtin；MVP0 不依赖通用终端生命周期 |
| Event / Detail Query | 持久化最小状态、LLM/工具事件和协议错误 |
| Candidate / Validation | 根据 Host 已接受的 submit result 执行既有交付链路 |

严禁在 `electron/subagent/` 新建工具执行器、第二套权限策略或 Mission outcome 状态机。`BuiltinBackend` 只转发既有 ToolGateway、PermissionGateway、预算和事件能力。ResourcePulseController、StuckDetector、DrainService、Candidate importer 和 Review 仍属于 backgroundMission，且除 Candidate 最小提交链路外不属于 MVP0。

`electron/subagent/builtin/` 只能依赖 Node 标准库和 `src/shared/subagent/` 中无 Electron 副作用的合同。ESLint/脚本、TypeScript 依赖检查、代码审查和 contract tests 用于维持“产品能力只经 Host RPC 暴露”的架构约束，但不构成 OS 安全隔离，也不用于宣称 Builtin 进程无法直接访问本机资源。

## 4. BuiltinBackend 合同与 backgroundMission 接入

### 4.1 MVP0 最小合同

```ts
interface BuiltinRunRequest {
  runId: string
  generation: number
  sessionId: string
  executionToken: string
  mission: {
    goal: string
    successCriteria: string[]
    constraints: string[]
    outputContract?: unknown
  }
  workspace: WorkspaceCapability
  authorization: CapabilityGrant
  budget: FixedRunBudget
}

type BuiltinRunResult =
  | { kind: 'submit'; summary: string }
  | { kind: 'failed'; reasonCode: string; summary: string }

interface BuiltinBackendHandle {
  result: Promise<BuiltinRunResult>
  cancel(reason: string): Promise<void>
  close(): Promise<void>
}
```

该合同只服务真实 AgentRun，不定义 caller、父 invocation、无 workspace 或 interactive result。宿主侧 `BuiltinBackend` 负责 Run 映射，子进程只读取必要字段；权限仍由不可伪造的 `CapabilityGrant` 和 Host gateway 强制执行。

### 4.2 BuiltinBackend

BuiltinBackend 负责：

1. 读取 Mission 目标、成功标准、约束和交付合同。
2. 绑定私有 worktree、Run authorization、固定预算和 generation fencing。
3. 启动并托管 Builtin 子进程，转发 Host LLM 与文件工具。
4. 将 `submit/failed` 确定性映射为 AgentRun outcome。
5. 仅在 submit outcome 被事务接受后启动 Candidate 和确定性验证。

子进程推理内核不得导入 backgroundMission 类型；宿主侧 BuiltinBackend 不受此限制。

### 4.3 后端选择

backgroundMission 的 `AgentBackendSelector` 仅在创建新 Run 时执行；BuiltinBackend 不实现第二个 Mission selector。MVP0 由 feature flag 或内部配置显式选择 Builtin，自动 Codex 回退留到 Long-running GA：

1. MVP0 只探测被显式选定的 Builtin backend。
2. 必查入口完整性、协议版本、LLM profile、模型工具调用能力、worktree、最低预算、文件 ToolGateway 和 PermissionGateway。
3. 仅当本 Run 的 capability grant 开启宿主预定义验证命令时，才检查相应命令执行端口；纯文件型 Mission 不依赖 HostTerminalService。
4. GA 开启通用 Shell 时才检查完整 HostTerminalService。
5. Builtin authorization 不得接受或继承任何 Codex trust acknowledgement、authorization 或 admission profile。
6. 将 Builtin identity、authorization、capability snapshot 和拒绝原因固化到 AgentRun；不允许运行中替换 backend。

### 4.4 Host 必须维持的 Mission 状态迁移原则

- 所有迁移用数据库 compare-and-set：`WHERE id=? AND generation=? AND state IN (...)`。
- 先原子失效 generation，再启动取消 drain。
- `waiting` 期间 Run 可保留；进入 `parked` 后释放 Agent 和终端资源。
- `completed` 必须由 Candidate + required validators + Review policy 闭合驱动；MVP0 的 Review policy 固定为“不要求 Review”，因此 Validator 通过即可闭合，GA 再启用可选 Review。
- `_llm/chat.stopReason` 永不驱动 Run 状态。
- 只有事务接受的 `RunOutcomeEnvelope` 可驱动 `submitting`、`waiting` 或 `failed`。

这些原则属于 backgroundMission 的权威状态机。`BuiltinBackend` 负责调用 AgentRunHost 接口；Builtin 子进程和 RPC 层不执行 SQL、不直接迁移 Mission/Run。

## 5. 私有 Builtin RPC

### 5.1 Transport

`JsonRpcPeer` 同时支持宿主向子进程请求和子进程反向请求宿主：

- stdin/stdout 使用 UTF-8 NDJSON，每行一个 JSON-RPC 2.0 对象。
- stdout 发现非 JSON、超长行或非法 schema 时 fail closed；stderr 仅进入脱敏诊断。
- request ID 在单连接内唯一；重复响应、未知响应 ID 记录协议错误。
- pending RPC 按方法设置超时，transport close 时一次性 reject 并清理 timer/listener。
- 单消息、单行、pending 数、更新频率和 stderr 累计量均设上限。
- notification 不产生响应；未知 method 返回 `-32601`，非法参数返回 `-32602`。

### 5.2 握手

严格执行：

```text
spawn → initialize → session/new → session/prompt
```

- `initialize` 协商协议版本、方法和能力，拒绝不兼容版本。
- `session/new` 绑定 `runId/generation/sessionId`、worktree capability、模型上下文窗口、工具清单和预算摘要；不包含密钥。
- 每次 `session/prompt` 绑定新的 `executionToken`，由 AgentRunHost 签发和校验。
- 只有初始 prompt 被接受后 session 才进入 active；是否将 AgentRun 从 `starting` 迁移到 `running` 由 BuiltinBackend 调用 AgentRunHost 决定。
- 启动任一步超时或失败，关闭 transport、回收 containment，并写稳定错误码。

### 5.3 Builtin result 与 Run outcome

MVP0 子进程只返回 §4.1 的 `submit` 或 `failed`。`BuiltinBackend` 将其确定性映射为 `submit_candidate` 或失败 outcome。其他结果和 outcome 不在本方案中预定义。

`BuiltinBackend` 先校验 Run/generation/session/execution token 和 result schema，再生成 `RunOutcomeEnvelope`；既有 `OutcomeAcceptor` 在一个数据库事务中：

1. 匹配当前 `session/prompt` request ID。
2. 校验映射后的 Run outcome schema、协议版本和 `source === 'builtin'`。
3. 校验 Mission、Run、generation、session 和 execution token。
4. 校验当前 generation 和 Run 状态仍允许接受结果。
5. `submit_candidate` 校验 deliverable key，`failed` 校验错误码和字段大小。
6. 在当前 `agent_runs` 行上匹配 execution token hash，并要求 outcome 字段为空。
7. 同一 compare-and-set 写入 outcome 和新状态事件。

相同 result/outcome 重放返回原接受结果；同 token 的不同结果为协议冲突。无效、缺失、迟到 result 由 BuiltinBackend 拒绝并按 `BUILTIN_RUN_RESULT_INVALID` 收敛为失败；MVP0 不自动进入恢复流程。

并发优先级为：用户取消/宿主硬预算 > 已事务接受 outcome > transport 断开。换言之，取消先失效 generation；已被接受的 outcome 不因随后 EOF 改写为 crashed。

## 6. Builtin 子进程

### 6.1 启动与信任边界

Builtin 推理子进程是 SpaceAssistant 的受信任应用组件，不作为恶意代码隔离边界。MVP 不为其提供或声明 Host/OS 强制 runtime sandbox；“无密钥、无直接工具”表示产品实现不向其注入密钥，也不在该进程内实现文件、Shell、网络等副作用工具，所有产品暴露的副作用能力均通过受当前 invocation 身份与 `CapabilityGrant` 约束的 Host RPC 请求；Mission 场景由 adapter 额外绑定 Run/generation。若应用包被篡改、依赖供应链失陷或该进程发生任意代码执行，本方案不承诺依靠子进程边界阻止本机文件或网络访问。

- 使用 Electron 内置 Node runtime 启动编译后的独立 JS 入口，不依赖用户 Node。
- 子进程环境使用 allowlist 重建，只保留运行必需变量；显式移除 API key、代理凭据、云厂商凭据和应用内部 token。
- 不向子进程传递数据库路径、用户配置路径或宿主 IPC handle。
- session 中可提供 `WorkspaceCapability` 的逻辑 cwd 供 Host RPC 解析相对路径；无 workspace 调用不注册文件和终端工具。Builtin 实现不得用 `fs`、`child_process` 或网络 API 执行任务副作用，相应依赖由检查脚本、代码审查和测试阻断。
- 进程必须经 `ContainmentManager` gated launch，成功写入可恢复 identity 后才真正开始协议。
- Windows `windowsHide: true`；POSIX 使用进程组/containment。macOS 路径不得使用 Endpoint Security 或 ES Helper；正常运行期间必须验证取消与普通进程树回收，App 异常终止后的逃逸后代重识别与释放只作 best-effort。
- 不能只依赖当前 `killProcessTree()` 的内存 ChildProcess 引用恢复旧 Run；持久 identity 用于重启后的诊断和尽力清理，但在 macOS 上不得据此声称已获得 `verified` release proof。

lifecycle containment 只负责进程归属、正常取消和退出，以及能力范围内的崩溃重识别与释放；它不是文件、网络或 Shell 权限边界。macOS 非 ES 路径缺少异常崩溃后的强释放证明，不阻断后台任务，但无法确认旧资源释放时必须 fail closed。Builtin 是否可以请求某项产品能力，由 Host gateway 和 PermissionGateway 决定，而不是由子进程 sandbox profile 决定。

### 6.2 推理循环

每个 session 同时只允许一个 prompt：

```text
读取可信 MissionInput
  → 构造 system context + persistent constraints
  → _llm/chat
  → 若有 tool calls，按响应顺序串行请求宿主
  → 将规范化 tool result 回填历史
  → fixed budget / context limit / cancellation 检查
  → 下一轮，或生成唯一 BuiltinRunResult
```

关键约束：

- 工具失败始终以结构化结果回填，不吞错。
- 模型输出的“完成”文本不能直接提交，必须由 result builder 生成有效结果。
- 达到最大轮次或剩余预算不足时进入有限收尾，不继续普通工具执行。
- 取消用 `AbortController` 贯穿 LLM、权限等待、终端等待和循环。
- MVP 工具串行；同一 assistant message 中的调用结果保持原顺序。
- Builtin 不调用 `spawn_agent`，也不启动任何新的 Agent 进程。

### 6.3 MVP0 上下文

`ContextManager` 将信息分成不可被普通历史覆盖的 persistent block 和有界 recent history：

- persistent：goal、success criteria、constraints、output contract、当前授权/预算摘要；
- observed facts：宿主工具结果、当前预算和 worktree 摘要；
- untrusted history：计划和 Agent 自述。

`constraints` 仅为 `string[]`。MVP0 不定义 constraint ID、category、`scope`、`business_rule`、`compatibility`、`process` 或 `prohibition` 等类型。ContextManager 只需完整保留 constraints，不对其重新分类或改写。

可强制的边界不从 constraints 推导：路径、工具、Shell、网络、权限和预算范围必须由 BuiltinBackend 编译到 `CapabilityGrant`、`WorkspaceCapability` 和宿主策略。宿主在 Mission 确认阶段拒绝可确定识别的冲突；MVP0 运行中发现自然语言语义冲突时返回 `failed(reasonCode: 'CONSTRAINT_CONFLICT')`，不得自行选择较宽松的解释。

MVP0 不调用 LLM 压缩上下文，也不写磁盘工作记忆。根据 provider 返回的真实 input tokens 预留下一轮空间；达到安全上限时返回 `failed(reasonCode: 'CONTEXT_EXHAUSTED')` 并保留 worktree 成果。压缩和结构化工作记忆必须由真实长任务数据证明收益后再设计。

## 7. 宿主 LLM 调用

### 7.1 MVP0 实现

不要直接让 Builtin 复用 `toolChatLoop`，也不建立 `LlmProxy + LlmProviderAdapter` 双层抽象。`BuiltinBackend` 直接持有一个 `chat(normalizedRequest, context) → normalizedResponse` 函数，内部调用 MVP0 唯一 provider/profile 的现有 SDK 能力，并完成以下工作：

- 将 Builtin RPC 的规范化请求转换成当前 provider 请求；
- 将文本增量发送到事件流；
- 将最终 message、stopReason 和 usage 转回规范化响应；
- 贯穿取消、超时和预算结算。

这个函数是 BuiltinBackend 的具体实现细节，不注册 provider 接口或工厂。第二个 provider 真正接入时，再从两个实际实现中提取公共接口。

### 7.2 安全与计量

- `_llm/chat` 只注册在通过 `BuiltinBackend` 创建并持有 capability token 的 peer 上。
- 请求中的 model 只是 hint；使用 AgentRun 固化的 profile。
- system prompt 和工具 schema 设总大小上限。
- 每次调用前通过 Host 预算接口申请预留，完成后把 provider usage 返回 Host 结算；BuiltinBackend 不维护独立账本。
- 缺少 usage 的 provider 在 MVP 不通过 Builtin 准入，避免估算成为权威计量。
- 文本 delta 只用于 UI/event；Builtin 历史只消费最终响应中的完整 message。
- prompt、文件内容和完整输出默认不进诊断日志。

## 8. Host 工具桥接、权限与路径

### 8.1 工具集合

MVP 通过 `hostRpcBridge` 映射 backgroundMission 已有宿主工具，不在 `electron/subagent/` 实现新的执行器：

| 工具 | 实现说明 |
|---|---|
| `fs/read_text_file` | 规范化路径、worktree 范围、symlink 和输出上限校验 |
| `fs/write_text_file` | 授权检查、保留目录规则、原子写 |
| `fs/edit_text_file` | 必带 expected hash/revision，冲突返回结构化错误 |
| `fs/list_directory` | 不跟随越界 symlink，结果分页 |
| `fs/search_text` | 受控 `rg` 或内建搜索，限制文件数/输出 |
| `terminal/*` | Long-running GA；MVP0 仅可选宿主预定义验证命令，Builtin 不直接 spawn |

Agent 请求参数中的 `risk` 或 `shouldRequestPermission` 不可信。既有 Host `PermissionGateway` 依据工具、规范化参数、当前 Run 的 `CapabilityGrant` 和宿主策略裁决 allow/ask/deny；bridge 只传递规范化请求和结果。Mission authorization 由 BuiltinBackend 编译为该 grant，子进程不解析 Mission scope。

### 8.2 路径安全依赖

- Host ToolGateway 在每次实际操作前执行一次统一路径校验：拒绝绝对路径、NUL 和 `..`，相对 Run 私有 worktree 解析，并拒绝解析链中的 symlink/reparse point 逃逸和保留目录访问。
- MVP0 不额外实现“字符串预检 + handle-relative”双层校验，也不承诺抵御本机恶意进程并发替换目录造成的 TOCTOU；若后续威胁模型扩大，再基于真实安全需求引入 handle-relative 操作。
- `edit` 的 expected content hash 用于避免正常并发修改被静默覆盖，不作为第二套路径安全机制。

### 8.3 权限与 Decision

MVP0 只处理工具权限的 allow/deny/timeout，并把拒绝、超时或取消转换为结构化工具结果。Decision、waiting 和 parked 属于 GA；其协议和状态映射不在本方案中预定义。

### 8.4 Host Shell 执行与权限

通用 Shell 属于 Long-running GA。MVP0 默认不注册 `terminal/*`；若需要运行验证，只允许宿主预定义命令。任何阶段 Builtin 都不直接执行 Shell，也不在子进程中持有 `child_process` 执行入口。

- Builtin 请求中的 `risk`、`cwd`、环境变量和权限建议均不可信，Host 必须重新规范化和裁决；
- Shell cwd、环境 allowlist、网络策略、路径范围及可执行命令规则由 Host 当前产品策略决定，不固化为 Builtin backend admission；
- GA 接入 HostTerminalService 与 `terminal/create/output/kill`；Host 若具备更强的 terminal sandbox/profile，可以在执行时应用，但强 sandbox 不作为 Builtin backend 准入条件；
- Mission authorization 或宿主策略禁止 Shell 时，`terminal/*` 不向该 Run 注册或返回稳定的 denied 结果；权限拒绝不等于 HostTerminalService 缺失，Builtin 仍可使用其他获准的 Host 工具；
- Mission 的完成条件必须使用 Shell 而 Host 不允许时，Mission 进入等待授权或以可操作错误失败，不得由 Builtin 绕过 Host 直接执行；
- 正常取消必须回收当次可识别进程树；macOS 非 ES 路径在异常恢复时存在不确定残留，则进入 `release_pending` / `recovery_required`，不得自动在同一 worktree 启动冲突 Run。

## 9. 预算与 Long-running GA 控制信号

### 9.1 权威预算账本

MVP0 权威预算账本只包含三种累计量：

- token 消耗（input + output）；
- 工具调用次数；
- wall-clock runtime。

三者均由 Host 核算；Builtin 只使用 Host 下发的已用量和剩余额度调整策略。LLM 调用次数可以作为诊断指标，但不是独立预算维度。终端并发/高水位、输出字节和 context compression 次数不进入 MVP0 预算账本；未来只有对应能力上线且有真实限额需求时才增加。

硬预算命中后：

1. 原子标记 budget exhausted，拒绝新的普通 LLM/工具请求。
2. 中止在途可取消操作。
3. 宿主生成 `source: 'host'` 的收尾 outcome 或给 Builtin 一次受限收尾额度。
4. 封存部分成果；Agent outcome 不能覆盖已生效的宿主终止。

### 9.2 ResourcePulse

本节及 §9.3 属于 Long-running GA，不阻塞 MVP0。

既有 Host `ResourcePulseController` 根据 token、工具调用和时间软阈值触发 pulse。Builtin 只接收结构化事实，不在 adapter 内重算计量，不需要总结或回复。pulse 包含触发原因、elapsed/remaining time、token、工具调用次数和可选的最近结构化错误，同时写事件供 UI 展示。

ResourcePulse 不调用 LLM、不创建恢复点，不包含 success criteria 完成度、计划进度或交付缺口。success criteria 在 Validator/Review 前的宿主状态为 unknown；Agent 自测结论仅是非权威自述。

### 9.3 StuckDetector

既有 Host `StuckDetector` 维护有界滑动窗口，识别：

- 同稳定错误码连续失败；
- 同路径内容 hash 在两个值间反复编辑；
- 高相似工具序列重复且无新增成果；
- 持续消耗预算，但没有新的工具成功、结构化输出或文件 hash 变化（仅作组合信号）。

首次命中发策略调整警告；持续无改善创建 `stuck` Decision 并进入 waiting。Builtin 只消费提示并返回结构化 outcome，不创建 Decision 或迁移状态。

## 10. 最小持久化扩展

### 10.1 数据边界

Mission、AgentRun、事件、预算、permission、Decision、RecoveryBundle、Candidate、Validation 和 Review 的基础表及迁移全部由 backgroundMission 提供，本项目不重复规划。MVP0 不创建 `agent_run_execution_tokens` 或 `agent_run_outcomes` 表；一个 Run 只有一个 session、一个 execution token 和最多一个已接受 outcome，直接扩展 `agent_runs`：

- `backend`、`backend_version`、`capability_snapshot_json`
- `protocol_version`、`session_id`
- `model_profile_id`、`context_window`
- `execution_token_hash`
- `outcome_id`、`outcome_kind`、`outcome_json`、`outcome_accepted_at`

### 10.2 事务与约束

- 签发 token 时把 hash 写入当前 `agent_runs` 行；明文仅在当前内存上下文和子进程输入中短暂存在。
- 接受结果使用单条 compare-and-set：匹配 Run、generation、运行状态和 `execution_token_hash`，并要求 `outcome_json IS NULL`，随后同时写入 outcome 字段和新状态。
- `outcome_json IS NULL` 表示尚未接受结果；非空后不得被第二个结果覆盖。完全相同的重放返回已接受结果，不同内容按协议冲突拒绝。
- 协议错误写脱敏日志和 AgentRun 最小错误字段，不创建 `diagnostic` 事件或 Builtin 专属事件账本。

### 10.3 迁移策略

MVP0 只为上述 `agent_runs` 字段增加迁移，不建立独立 token、outcome 或 invocation 表。GA 若允许同一 Run 多次 prompt/waiting/resume，再把现有单值字段迁移到一对多子表；迁移前不预建该基数。

## 11. 取消、崩溃与恢复接入

### 11.1 取消 drain

以下是 backgroundMission 的取消顺序；`BuiltinBackend` 负责 execution token 失效、`session/cancel`、中止 LLM/RPC 和关闭子进程，其余步骤由 AgentRunHost 协调：

1. 事务中使当前 generation 失效并迁移 `cancelling`。
2. 拒绝新 LLM、工具、permission 和 outcome。
3. `session/cancel`。
4. Abort 在途 LLM 和权限等待。
5. 将 pending/in-progress 工具调用持久化为 cancelled/failed 终态。
6. 终止所有 terminal containment。
7. 宽限期后强杀 Agent containment。
8. 验证资源释放，写 `resourcesReleasedAt`，最后迁移 `cancelled`。

### 11.2 崩溃

MVP0 将子进程崩溃安全收敛为当前 Run 失败。以下 RecoveryBundle 和新 Run 恢复流程属于 Long-running GA：

以下均视为 crash：异常退出、协议 EOF、无法解析/冲突 outcome、心跳/握手超时、宿主重启发现未完成 Run。

恢复前由 Host drain 旧资源并封存 RecoveryBundle：

- 当前可信 Mission 和授权/预算策略；
- AgentRun 状态、backend/resource identity 和事件尾部；
- 预算账本的权威累计值；
- worktree revision/diff；
- 未决 permission/Decision；
- 最近结构化失败与 stuck 事实；
- 旧 Agent 执行摘要（明确标记为非权威自述）。

RecoveryBundle 直接在封存事务/流程中读取上述权威来源，不先经过 RunDetailDTO 或持久化快照。查询聚合与恢复封存冲突时，始终以原始权威表、事件和 workspace/resource 事实为准。

### 11.3 新 Run 恢复

- 旧 Run 进入 crashed/failed/parked 终态或可恢复状态。
- Mission generation 增加，创建新 AgentRun。
- 重新执行后端选择，因此新 Run 可从 Codex 切到 Builtin 或反向切换。
- 创建新子进程和 `session/new`，不调用 `session/load`。
- RecoveryContext 显式分区为可信约束、宿主事实、未验证成果和旧 Agent 自述。

## 12. Candidate、验证与 Review 接入

MVP0 的 `submit` 由 BuiltinBackend 映射为 `submit_candidate`，既有 Host 负责停止执行面并进入 Candidate 和确定性验证：

- `submit_candidate` 调用既有 Candidate 接口；
- `failed` 不创建 Candidate；
- 不可变 revision 和 required validators 仍由 backgroundMission 决定完成。

## 13. Renderer 与 IPC 增量

§13.1～13.2 的完整查询和界面内容属于 Phase 6。MVP0 Phase 3 只增加实际 backend、最小状态、token usage 和脱敏协议错误，不接入回退、Decision/Permission、恢复或完整多数据源 RunDetailDTO。

### 13.1 IPC

GA 不新增 Mission 创建、列表、取消、重试、Decision、Permission 或 Candidate IPC，只扩展既有详情查询和事件分页，提供回退原因及完整协议诊断。MVP0 只扩展 backend、最小状态、usage 和错误字段。

GA 的完整 Mission 详情通过 `RunDetailQueryService` 从 AgentRun、预算账本、最近事件、permission/Decision、workspace scan 和 resource/containment 事实按需组装 `RunDetailDTO`。任何阶段都不新建 `run_snapshots` 表、`SnapshotProjector` 或 `run:snapshotUpdated` 事件。DTO 可使用短时内存缓存，但缓存必须可丢弃、可重建且不得驱动任何正式状态。

### 13.2 界面

GA 复用既有 Mission 列表、详情、时间线、Decision/Permission、预算和恢复 UI，并增加：

- 实际 backend 和回退原因；
- Builtin 协议版本与健康状态；
- 模型 profile、token usage；
- 脱敏握手/协议错误及可操作建议。

不新建 Mission pane、Redux slice 或完整时间线。新增文案进入中英文 i18n，并沿用既有无障碍模式。

## 14. 构建与打包

### 14.1 编译

`tsconfig.electron.json` 当前将 Electron 代码编译到 `dist-electron`。新增 Builtin 入口后：

- 保持独立输出 `dist-electron/electron/subagent/builtin/main.js`。
- `builtinPathResolver` 在开发和 packaged 环境只提供一个解析入口。
- 入口及其依赖必须被 electron-builder `files` 收入。
- 如果执行入口位于 asar 内不能直接启动，则将 Builtin 目录加入精确 `asarUnpack`，不扩大到全部应用代码。

### 14.2 构建校验

`scripts/verify-builtin-subagent.mjs` 在 build/pack 阶段检查：

- 入口存在且 hash/manifest 匹配；
- 可由当前 Electron/Node runtime 启动；
- 完成 initialize/session-new/模拟 prompt；
- stdout 无协议外输出；
- 正常退出后无可识别残留进程，并输出平台对应的 release assurance。

MVP0 只要求首发目标平台开发态与 feature-flag 构建冒烟。macOS、Windows、Linux 安装产物、异常恢复和完整进程树验证属于 Long-running GA 发布 Gate。

## 15. 分阶段开发计划

本计划先做最小协议实验，再尽快交付真实纵向 Alpha。不会先横向完成通用 Host、完整协议、长任务系统和 UI 后才联调。Phase 0 结束时只冻结最小进程协议；Host 合同在 §2.1 集成 Gate 满足后，以真实 backend 为依据更新。

### Phase 0：真实依赖审计与最小进程实验

交付：

- 基于同一 worktree 的冻结基线建立“需求能力 → 真实模块/API/schema”映射，记录基线 commit SHA 并删除失效假设。
- 核对 AgentRunHost、真实 backend、文件工具、固定预算、取消和 Candidate 的最窄扩展点。
- 记录 backgroundMission 遗留缺口；明确归属 backgroundMission 补丁还是 SubAgent 接入改造。
- 只冻结 `initialize/session-new/session-prompt/cancel`、`_llm/chat` 和最小文件工具的 Builtin RPC schema，以及 `submit/failed` 结果。
- 验证双向 NDJSON RPC、Electron 内置 Node 启动、正常取消和 Host capability 端口。
- 选定一个已验证的 LLM provider/profile 作为 MVP 唯一适配目标。

Gate：

- 已完成接口盘点、所有权划分和差距清单；未实现能力均有负责人、目标合同和集成阶段。
- §2.1 集成 Gate 所需的真实 backend 窄接口已存在；否则 Phase 0 只产出实验结论和待决清单，不进入实施合同冻结。
- 不存在要求 SubAgent 重建 Mission 生命周期或临时控制面的设计。
- §6.1 信任模型、§8 capability 边界和对应准入错误已冻结。
- 协议 contract tests 可运行。
- 最小子进程/RPC 实验通过，不包含 fake interactive adapter 或三平台发布承诺。
- 产品确认 §2.4 默认决策。

### Phase 1：Builtin MVP0 纵向 Alpha

交付：

- 实现 `BuiltinBackend`、Builtin 子进程、最小 RPC、单 provider `_llm/chat` 和 registry 注册。
- 接入真实 AgentRunHost、私有 worktree以及读/写/编辑文件工具。
- 实现固定预算、取消、generation fencing、`submit/failed` 与 Candidate 确定性验证。
- 以 feature flag 在首发目标平台跑通一个真实 Mission。

Gate：

- 真实 AgentRun → Builtin → Host LLM/文件工具 → submit → Candidate/Validator 闭环通过。
- cancel、硬预算、上下文耗尽和 failed 均安全收敛。
- 子进程无密钥、无直接工具依赖；推理内核不导入 backgroundMission 类型。
- feature flag 关闭可完整回滚，不影响既有 backend。

### Phase 2：MVP0 协议与安全加固

交付：

- Phase 1 已包含最小 peer、入口、握手、单 session 和 inference loop；本阶段不重复实现这些组件。
- 围绕已跑通的真实纵向链路补齐严格 schema 校验、消息/输出/pending 限制、per-method 超时、重放、迟到结果、协议 fuzz 和进程清理。

Gate：

- malformed JSON、未知方法、重复 ID、超大消息、EOF、pending cleanup 全覆盖。
- outcome 身份、幂等、冲突和竞态测试通过。

### Phase 3：MVP0 内部 Alpha

交付：

- 增加最小运行详情、诊断、指标和内部用户开关。
- 使用真实 Mission 数据验证成功率、成本、取消和 Candidate 验证结果。
- 根据数据决定是否进入 Long-running GA，不在本阶段预建工作记忆或通用 Runtime。

Gate：

- 至少一组内部真实 Mission 完成，失败可诊断且可回滚。
- MVP0 指标达到产品设定阈值，或明确停止扩展并记录原因。

### Phase 4：Long-running GA（另行立项）

交付：

- 基于 MVP0 数据选择性实现上下文压缩或工作记忆，不默认两者都做。
- 接入 ResourcePulse、stuck、waiting/parking/Decision 事件。
- 消费 Host token/tool/time/output/terminal 预算和有限收尾信号。

Gate：

- 压缩前后硬约束不丢失。
- constraints 作为原始自然语言列表保留，不依赖 ID/category 也不被摘要、恢复上下文或工作记忆改写。
- ResourcePulse 只包含宿主硬数字，不调用 LLM、不要求回复，不投影 success criteria 状态。
- 连续失败和重复工具序列可升级 waiting。
- 每类在途状态均可取消且无悬挂。

### Phase 5：Long-running GA Outcome、交付与恢复映射

交付：

- 根据 MVP0 运行数据和届时的真实需求，另行定义非 MVP0 result/outcome schema 与 Candidate/Decision/Recovery 映射。
- 验证 crash/park 后既有 Host 创建新 generation、新 Run 并重新选择 backend。

Gate：

- 新增 outcome 的状态映射全部集成覆盖。
- 已接受 outcome 后 transport 断开不被改写。
- 恢复 prompt 的信任分区有快照测试。

### Phase 6：Long-running GA UI 与可观测性

交付：

- 在既有 Mission 详情追加 backend、回退原因、模型 usage 和协议错误。
- 为 Builtin 特有失败增加可操作建议、中英文 i18n 和无障碍信息。

Gate：

- 增量 DTO、投影和详情组件测试通过；既有 Mission 交互无回归。
- `npm run i18n:check:strict` 通过。

### Phase 7：Long-running GA 打包、兼容与发布

交付：

- 开发/打包路径统一、asar 配置、构建校验。
- macOS x64/arm64、Windows x64、Linux AppImage 冒烟。
- feature flag、诊断导出、回滚说明和用户文档。

Gate：

- 安装包无需 Node/Codex 可运行 Builtin 冒烟 Mission。
- 安装产物通过 §6.1 对应的 lifecycle 与平台边界验证。
- 全量测试、shared/renderer typecheck、build 通过。

## 16. 测试矩阵

### 16.1 MVP0 单元测试

- Builtin capability probe 与既有 Backend 合同适配。
- Builtin RPC/Zod schema、execution token/result 请求构造。
- inference loop、工具顺序、取消和最大轮次。
- 当前唯一 provider 与 Builtin RPC 格式的双向转换及 usage。
- `hostRpcBridge` 参数、错误和取消映射。
- Run/generation/session identity、capability 与 `submit/failed` result schema。
- constraints `string[]` 的 persistent block 保留，以及推理内核不存在 category/includedScope/excludedScope 分支。
- BuiltinBackend 的 result → Run outcome 映射。
- MVP0 最小详情 DTO：backend、状态、token usage 和协议错误。
- 有界历史和 `CONTEXT_EXHAUSTED` 收敛。

### 16.2 MVP0 集成测试

- 无工具问答和正常提交。
- 文件读写编辑；可选的宿主预定义验证命令。
- permission allow/deny/timeout。
- LLM 和文件工具各阶段取消；permission 只覆盖当前 allow/deny/timeout 请求。
- `submit/failed` 状态迁移。
- outcome 重放、冲突、迟到、缺失，以及与 cancel/budget/EOF 竞态。
- feature flag 显式选择 Builtin 并完成真实 Mission；自动 Codex 回退留到 GA。
- submit 到既有 Candidate/Validator 的映射。

### 16.3 安全测试

- 子进程 env 和 argv 无 API key/token。
- 依赖检查确认 `electron/subagent/builtin/` 不导入项目文件执行器、数据库、Electron IPC、凭据模块、Shell runner 或网络客户端。
- contract tests 确认 Builtin 的产品工具调用只能经注册的 Host RPC method 发出，且绑定 run/generation/session/execution token。
- 非预期 peer 无 `_llm/chat` capability。
- Host ToolGateway 拒绝 `..`、symlink 逃逸、保留目录和未授权绝对路径。
- 若 MVP0 开启预定义验证命令，其 allow/deny 与取消均由 Host 决定；未启用 Shell 时不得影响文件型 Mission 准入。
- stdout 注入、超大消息、JSON bomb、stderr 洪泛。
- generation/outcome/session/token 伪造。
- correlation 伪造不得改变 capability；跨 Run/generation/session grant 复用必须被拒绝。
- 取消后的迟到工具结果和 Candidate。

### 16.4 Long-running GA 候选测试

以下测试只在 Phase 4～7 对应能力进入实现后成为 Gate，不得用于阻塞 MVP0：

- Codex 自动回退及 authorization 隔离；
- ResourcePulse、Stuck Detection 和 success-criteria unknown 语义；
- waiting/parking/Decision、permission 等待期间取消和恢复；
- RecoveryBundle、新 generation、新 Run 恢复及届时新增的 outcome 映射；
- Review policy、完整 RunDetailDTO、多数据源查询、事件游标和恢复 UI；
- 通用 Shell、终端生命周期、进程树回收和三平台安装包。

### 16.5 验证命令

迭代时先跑 focused tests，阶段 Gate 至少执行：

```bash
npx vitest run <phase-related-tests>
npm test
npm run typecheck:shared
npm run typecheck:renderer
npm run i18n:check:strict
npm run build
node scripts/verify-builtin-subagent.mjs
```

打包阶段追加对应平台 `npm run pack:*` 和安装产物冒烟。

## 17. 发布、观测与回滚

- 以 `builtinSubagentEnabled` feature flag 分阶段开启：开发 → 内部用户 → 小比例 → 默认开启。
- MVP0 关键指标：启动/握手成功率、`submit/failed` 分布、取消耗时、固定预算超限率、Candidate 验证通过率。
- GA 启用对应能力后再增加 fallback、recovery、stuck、Review 和终端生命周期指标。
- 日志统一带 mission/run/generation/session/backend；只记录摘要、错误码和计量，不记录隐藏思考、完整 prompt、文件或终端内容。
- Builtin probe 失败时 fail closed 并保留 Codex 路径；不能因 feature flag 关闭而破坏已有 Mission 历史查看和旧 Run drain。
- 数据库迁移不可回滚时，应用代码回滚必须保持只读兼容或明确拒绝打开高版本库，禁止降级写入。

## 18. 主要风险与缓解

| 风险 | 缓解 |
|---|---|
| backgroundMission worktree 的真实接口与本文预期不一致或持续漂移 | Phase 0 基于带 commit SHA 的冻结基线做接入审计；后续 backgroundMission 补丁与 SubAgent 改动均形成可追溯提交，接口变化先更新映射和方案再实施 |
| backgroundMission 遗留缺口被带入 SubAgent 项目 | Phase 0 记录缺口、所有者和目标合同；真实后台接入以 §2.1 集成 Gate 拦截，不复制临时控制面 |
| `toolChatLoop` 与后台 Run 耦合导致状态/密钥泄漏 | BuiltinBackend 直接调用当前 provider 的底层 SDK 能力，不复用聊天循环；第二个 provider 出现后再提取接口 |
| 子进程推理内核混入 Mission/AgentRun 持久化细节 | 依赖规则只禁止子进程内核导入 backgroundMission；宿主侧 BuiltinBackend 允许理解 AgentRun，避免为假想调用方提前泛化 |
| correlation ID 被当作授权依据 | 调用方元数据仅用于观测；产品能力只来自宿主签发且不可扩权的 `CapabilityGrant` |
| macOS 非 ES 路径在 App 崩溃后无法完整重识别逃逸后代 | 接受 best-effort 产品边界；持久 identity 用于诊断和尽力清理，无法确认释放时进入 `release_pending` / `recovery_required`、阻止冲突 Run，并明确不得标记为 `verified` release proof |
| JSON-RPC 双向调用死锁或泄漏 | 有界 pending、per-method timeout、close 全量 reject、协议 fuzz |
| provider usage 不一致破坏预算 | 不提供权威 usage 的模型不通过 MVP 准入 |
| 上下文耗尽导致任务无法收尾 | persistent block 独立保留，预留收尾空间；MVP0 明确返回 `CONTEXT_EXHAUSTED`，有数据后再决定压缩方案 |
| 打包后入口不可执行 | 单一路径解析、精确 asarUnpack、安装包握手冒烟 |
| 增量诊断污染既有 Mission UI | 只扩展既有详情查询 DTO 和事件分页，不新建列表、时间线或 Redux slice |

## 19. 完成定义

Phase 1～3 Gate、§16 MVP0 测试以及需求 §17 中标注为 MVP0 的验收项全部通过后，Builtin SubAgent MVP0 即完成；GA 候选项不参与该判定。
