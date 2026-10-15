# agent-sdk 接口说明

`packages/agent-sdk`（包名 `@spaceassistant/agent-sdk`）是 SpaceAssistant 的 **SDK 面**：契约类型 + 端口接口 + 纯 runtime 核。本目录按模块梳理它对外暴露的接口，供宿主（electron 主进程）装配方与 SDK 维护者查阅。

> **基准**：本目录对齐 `main` 提交 `17236274`（2026-10-14 更新；原为 `8e3c5d12`）。核对窗口 `git log 8e3c5d12..17236274 -- packages/agent-sdk/src`。文档首版落在 `e5801089`；此后并入的第一批是 `c76c7aab`、`fa796649`（turn 超时语义（`AgentTurnTimedOutError` / `TURN_TIMED_OUT` / `REQUEST_TIMEOUT`）、审批获批后才激活应用运行槽、执行端口在派发声明之后的 abort 复检、`InvocationRuntime` 的 park 家族下线）与 `ae092513`（provider 取消结算：`CollectedModelStream` 的 cancelled 分支允许缺 `usage`、取消尝试先投影 usage 并写 `model-attempt-discarded` 再抛取消 / 超时、非 cancelled 尝试缺 usage 视为流非法）。
>
> 第二批（本次核对，基准从 `4e3d44fd` 推进到 `8e3c5d12`）主要集中在**会话存储重构**及其连带修复：
>
> - `25f8692f`、`c69b5873`、`413674a1`、`430b2dab`、`6d2a3f41`：新增**上下文端口**（[context.md](./context.md)）、`HistoryPort.appendBatch` 的 transcript 提交意图与 `appendAtVersion`、turn 循环的**单一上下文规划器** `planContextReplacement`（取代 `preflightModelRequest` / `turnBoundary` 两个钩子）、`invocation-parked` 并入终态集合。
> - `b0b09baf`、`7ffca482`、`f69db8a6`：用量归因与脚本信任恢复（observer 新增 `prepareUsageAttribution`）。
> - `eef6d571`：新增 `beforeToolDispatch` **纯派发准入**，工具错误在回合内可恢复（拒绝回灌模型而非终止回合）。
> - `c4511348`、`9d878b55`、`6706bdc8`：取消时结算审批、审批等待期间保留 turn 准入名额、准入策略与 turn 生命周期对齐。
> - `51193571`、`9a1a6e6d`：派发中止与 transcript 空洞安全（未派发槽位物化 `TURN_STOPPED_BEFORE_DISPATCH`、dispatch 诊断观察点）、终态消息段对账。
> - `defc6379`、`17a85453`：provider 流**空闲超时护栏**（`ModelStreamIdleTimeoutError` / `PROVIDER_STREAM_IDLE_TIMEOUT`）。
>
> 核对方式与宿主转发层的形状差异见文末「维护」。

## 定位与边界

- 入口 `packages/agent-sdk/src/index.ts`；`package.json` 的 `main` / `types` 直接指向 `src/index.ts`，`exports` 暴露 `.` 与 `./model` 两个入口。
- 对外只承诺 `createAgentRuntime`（runtime 工厂）与契约类型/接口；契约物理文件已收敛到 SDK 包内，宿主 `src/shared/agent` 只剩调用入参面的兼容转发（`invocation.ts`，已不再定义 `AgentHostPorts`）。
- 零 electron 依赖：SDK 与纯逻辑闭包必须可在纯 node 下运行（护栏 CI 锁定入口闭包）。
- 三条硬约束贯穿全部接口：
  1. 契约只放可序列化数据与消息，禁止函数句柄；
  2. 宿主能力一律经接口注入（`AgentHostPorts`）；
  3. 跨调用可变状态全部随 runtime 实例走（多实例，`AgentRuntime.instanceId`）。

## 入口与导出面

`package.json` 声明两个入口（`main` / `types` 指向 `src/index.ts`，源码直出，无构建产物）：

| 入口 | 文件 | 内容 |
| --- | --- | --- |
| `@spaceassistant/agent-sdk` | `src/index.ts` | runtime 工厂（`createAgentRuntime`、`NOOP_AUDIT`、`AgentRuntime` 等）+ 纯组件（`ConfirmIdSpace`、`ChatCancelRegistry`、`ToolRevocationRegistry`、`Semaphore` / `withSemaphore` / `McpConcurrencyGate`）+ 逐模块 `export *` |
| `@spaceassistant/agent-sdk/model` | `src/model.ts` | 窄入口：模型流与 canonical 消息契约（`StreamChunk`、`CanonicalModelMessage`、`collectModelAttempt`、`ModelProviderRegistry`、`prepareModelCall`、路由错误类）。供只需类型 / 流收集、不想引入 turn 闭环的调用方使用 |

`typesVersions` 为不支持 `exports` 的 TS 版本兜底 `model` 子路径。

`src/index.ts` 以 `export *` 转发的模块：`approval`、`capacity`、`scheduler`、`resourceLock`、`confirmationCommit`、`history`、`provider`、`lifecycle`、`model`、`safetyPermit`、`executionAdmission`、`capability`、`safetyGate`、`turn`、`toolExecutionPort`、`toolResultContract`、`invocation`（契约层由 SDK 定义，宿主 `src/shared/agent` 仅提供兼容转发）；`context` 为**逐符号 `export type`**（`JsonValue`、`ContextScope`、`ContextItem`、`ContextFrame`、`ContextFence`、`ContextSnapshot`、`ContextTransformationEvidence`、`ContextCandidate`、`ContextCommitReceipt`、`ContextCommitResult`、`ContextPort`），`ContextRegistrar` 与各适配器均为内部面；`contextIdentity` 不经包入口导出任何符号（详见 [context.md](./context.md)）。

注意：`turn.ts` 中大部分投影 / 恢复失败类是模块内部类型，**不经入口导出**；装配方只能按 `error.name` 判定（见 [turn-loop.md](./turn-loop.md) 的「错误类型」）。

宿主另有一份转发层 `src/shared/agent/invocation.ts`（electron / renderer 直接 import），只保留调用入参面（`AgentInvocation` / `AgentMessagesSection` / `AgentEventSink` / `AgentReasoningProfile` 等），**不再定义 `AgentHostPorts`**；与 SDK 包内契约面的剩余差异（`acceptedTurn`、`trace.turnId` 语义、`AgentReasoningEffort` 是否含 `max`）见 [host-ports.md](./host-ports.md) 第 4 节。

## 模块地图

| 文档 | 对应源码 | 职责 |
| --- | --- | --- |
| [runtime.md](./runtime.md) | `src/runtime/*.ts` | runtime 工厂与纯组件核：审计、确认 ID、聊天取消、工具撤权、信号量 / MCP 闸 |
| [model-provider.md](./model-provider.md) | `src/model.ts`、`src/provider.ts` | 模型流契约（`StreamChunk`）、canonical 消息、provider 路由注册表与校验 |
| [turn-loop.md](./turn-loop.md) | `src/turn.ts` | 单回合主循环：模型轮次、工具阶段、输出上限恢复、终态结算 |
| [safety-approval.md](./safety-approval.md) | `capability.ts`、`safetyPermit.ts`、`safetyGate.ts`、`executionAdmission.ts`、`toolExecutionPort.ts`、`approval.ts`、`confirmationCommit.ts` | 能力投影 → 策略决策 → 许可签发 → 执行准入 → 审批容量与提交状态机 |
| [history-port.md](./history-port.md) | `src/history.ts` | 调用级事件流：追加、校验、幂等、重启状态重建 |
| [context.md](./context.md) | `src/context.ts`、`src/contextIdentity.ts` | 会话 / 调用上下文端口：无损材料、fence / evidence 能力模型、单一 writer 提交 |
| [lifecycle-capacity-scheduler.md](./lifecycle-capacity-scheduler.md) | `lifecycle.ts`、`capacity.ts`、`scheduler.ts`、`resourceLock.ts` | 调用生命周期账本、容量共享账本、依赖调度器、资源互斥锁 |
| [host-ports.md](./host-ports.md) | `src/invocation.ts` | Agent 调用契约与宿主端口集合（装配方主入口） |
| [tool-result-contract.md](./tool-result-contract.md) | `src/toolResultContract.ts` | 工具结果信封：闭合失败码、不变量断言、事实优先归一 |

## 典型装配顺序

SDK 只定义契约与循环，装配由宿主完成，大致为：

1. `createAgentRuntime(components)` 建 runtime（可逐项覆盖注入桌面能力：SQLite 审计、内置工具注册表等）。
2. `new ModelProviderRegistry({ supportedProtocols })` → `register(route, provider)` 注册模型路由。
3. 组装安全侧：`CapabilityRegistry`（调用级能力投影）+ `SafetyPermitStore`（许可台账）+ 策略实现 → `new SafetyGate({ capabilities, permitStore, policy | resolvePolicy })`。
4. 用 `createPermitBoundToolExecutionPort(deps)` 包装宿主执行器，得到带 consume → dispatch-claim 屏障的执行端口。
5. 装配上下文与历史：宿主实现 `HistoryPort`（`appendBatch(events, expectedVersion, transcriptCommit?)`）装入 `AgentHostPorts.history`；上下文侧用 `createSessionContextPort({ scope, registrar, capture, persist })`（或自建 `ContextPort`）承接会话级替换，turn 内的替换由 SDK 的 invocation 适配器走 `transcript-compacted`；`contextProjectionCommitter` 负责落库后的 UI / 索引投影（见 [context.md](./context.md)）。
6. 调 `runHostedAgentTurn({ host, ... })`（宿主只负责 `createPorts`）或直接 `runAgentTurn(input)` 跑循环。

## 约定速查

**路径 / 资源键前缀**（`resourceLock.ts`、`scheduler.ts`）

- `workspace:<path>`：文件系统键，目录读写与子路径操作互斥，但 `/src` 与 `/src2` 视为独立资源。
- `unknown:<id>`：无法证明影响范围的副作用（Shell / MCP 等），跨会话按全局屏障保守互斥（`resourceLock.ts`）。`scheduler.ts` 另有规则：**未声明** `resourceKeys` 的节点视为未知副作用，只能作为单节点串行屏障。

**审批状态流转**（`confirmationCommit.ts`）

`pending → committing → committed | rolled_back | reconciling`，`pending → cancelled`；`committing` 之后不允许直接 `cancelled`（写入已开始则必须落到 `rolled_back` 或 `reconciling`）。

**调用终态**（`lifecycle.ts` / `history.ts`）

`completed | cancelled | failed | denied | interrupted`。`interrupted` 覆盖：结果持久化不确定、执行已越过 dispatch 但结果未知、宿主响应 / 工具投影失败、上下文替换的投影或提交不确定（`commit-uncertain`；preflight、turn boundary、provider 恢复三处统一转成 `AgentTurnBoundaryProjectionError`）。

**错误码 / 错误类索引**

| 名称 | 出处 | 语义 |
| --- | --- | --- |
| `InvalidModelStreamError` (`INVALID_MODEL_STREAM`) | `model.ts` | 模型流事件序列非法（cancelled finish 允许缺 `usage`；非 cancelled 流结束缺 `usage` 也算非法） |
| `ModelStreamIdleTimeoutError` (`PROVIDER_STREAM_IDLE_TIMEOUT`) | `model.ts` | provider 流相邻 chunk 间隔（含首字节）超过 `idleTimeoutMs`，缺省 120s；宿主恢复层据此重试 |
| `UnknownModelRouteError` (`UNKNOWN_MODEL_ROUTE`) | `model.ts` | 路由未注册 |
| `ModelRouteChangedError` (`MODEL_ROUTE_CHANGED`) | `model.ts` | 调用期间路由身份变化 |
| `UnsupportedReasoningError` (`unsupported-reasoning`) | `provider.ts` | provider 不支持请求的思维档 |
| `ToolSchedulerReservationError` (`tool-reservation-unavailable`) | `scheduler.ts` | 调度器无法在新节点启动前取到预留 |
| `HistoryVersionConflict` / `HistorySequenceConflict` / `HistoryIdempotencyConflict` / `HistoryBatchError` / `HistoryCorruptionError` | `history.ts` | 事件流版本、序号、幂等、批次、损坏冲突 |
| `ToolDeniedError` (`TOOL_DENIED`) | `turn.ts` | 工具未派发（准入拒绝 / 策略拒绝 / 确认未通过 / 绑定漂移）；可带模型可见 `userMessage` |
| `ModelTurnLimitError` (`MODEL_TURN_LIMIT`) | `turn.ts` | 触及 `maxModelTurns` |
| `ToolLoopRoundLimitError` (`TOOL_LOOP_MAX_ROUNDS_EXCEEDED`) | `turn.ts` | 触及 `maxToolRounds` |
| `ModelOutputTokenLimitError` (`MODEL_OUTPUT_TOKEN_LIMIT_EXHAUSTED`) | `turn.ts` | 输出上限恢复已耗尽 |
| `ModelPreflightRejectedError` (`MODEL_PREFLIGHT_REJECTED`) | `turn.ts` | 请求预算预检拒绝（`OVER_BUDGET`） |
| `AgentTurnCancelledError` (`TURN_CANCELLED`) / `AgentTurnTimedOutError` (`TURN_TIMED_OUT`) | `turn.ts` | 回合取消 / 超时 |
| `InvalidTurnBoundaryError` (`INVALID_TURN_BOUNDARY`) | `turn.ts` | 边界投影破坏了必需消息或待派发提案 |
| `ModelAttemptRecoveryRejectedError` (`MODEL_ATTEMPT_RECOVERY_REJECTED`) | `turn.ts` | provider 尝试恢复被拒绝 |
| `ToolExecutionRejectedError` (`TOOL_EXECUTION_REJECTED`) | `toolExecutionPort.ts` | 执行前被拒（未进入执行器） |
| `ToolExecutionAfterDispatchError` (`TOOL_EXECUTION_UNKNOWN_AFTER_DISPATCH`) | `toolExecutionPort.ts` | 已进入执行器，异常结果按 unknown 工具结果结算；宿主生命周期失效时仍终止 Invocation |
| `ChatCancelledError` (`CHAT_CANCELLED`) | `runtime/components.ts` | 聊天取消 |
| `AgentTurnHistoryAppendError`（未导出，按 name 判定） | `turn.ts` | history 追加失败；`kinds` 含 `tool-call-finished` 视为结果持久化不确定 |
| `AgentTurnHostProjectionError` / `AgentTurnToolProjectionError` / `AgentTurnBoundaryProjectionError`（均未导出） | `turn.ts` | critical 投影提交失败 / 上下文替换的投影与提交失败，回合结算 `interrupted` |
| `AgentTurnHistoryAlreadyTerminalError`（未导出） | `turn.ts` | history 已是终态，跳过重复终态写入 |
| `ToolSchedulerReservationErrorReason` | `scheduler.ts` | 预留失败原因联合类型（`no-progress-subscription` / `progress-timeout`） |

## 维护

文档只描述 `packages/agent-sdk/src` 的对外接口，需随 SDK 源码同步。核对方法：

1. **找差异**：`git log --oneline <基准提交>..HEAD -- packages/agent-sdk/src`，再看 `git diff <基准提交> HEAD -- packages/agent-sdk/src`。
2. **导出面自检**：比对 `src/**/*.ts` 的 `export` 与本文档正文，确认新增 / 删除的符号都已覆盖（易漏点：`turn.ts` 的未导出错误类与 `@internal` 的 `contextFrameFromMessages`、`context.ts` 的内部面（`ContextRegistrar` / 适配器 / `CONTEXT_*` 错误码）、`contextIdentity.ts` 的不经入口导出、`scheduler.ts` 的联合类型与已下线的 park 家族）。
3. **行为自检**：`turn.ts`（阶段顺序、`planContextReplacement` 的三个调用点与 reasonCode）、`context.ts`（登记表校验与 `committed` / `stale` / `no-op` / `commit-uncertain` 判定）、`toolExecutionPort.ts`（派发前后的边界判定）、`scheduler.ts`（并发 / 预留 / 资源冲突）、`history.ts`（事件 kind、transcript 提交意图与终态集合）最易与文档漂移。
4. 基准提交更新后，同步修改上方「基准」行。

## 主题定位与命名沿革

本目录是 `agent-sdk` 主题的入口（Agent SDK：内核、契约与模型接入）。它同时承载 SDK 接口说明与 runtime 设计：

- **命名沿革**：**Agent Core / Core / agent-core 是 Agent SDK（`packages/agent-sdk`）的早期称呼**。新增与改写文档一律用现役术语；历史文件名保留原名。核验：`rg -n 'agentCore|agent-core' electron/` 无匹配。
- **主要代码域**：`packages/agent-sdk/src/*`、`electron/toolChatLoop.ts`、`electron/driver/`、`electron/butler/`、`electron/llmServiceResolver.ts`、`electron/usageStats/`。
- 本目录另有 [`runtime/`](./runtime/)（01–10 + README，**原地不动**）：Runtime 形状与契约的设计系列（设计稿，未实施），迁移路径骨架见第八篇 §5。

## 本主题现状与设计文档（汇总）

| 文档 | 类型 |
| --- | --- |
| [agent-sdk-architecture-development-plan.md](./agent-sdk-architecture-development-plan.md) | 方案（实施中，724 KB；架构落地主线） |
| [agent-sdk-architecture-migration-baseline.md](./agent-sdk-architecture-migration-baseline.md) | 迁移前形态冻结基线 |
| [agents-md-workdir-instructions-behavior.md](./agents-md-workdir-instructions-behavior.md) | 行为说明（**merge main 补入**）—— 工作目录 `AGENTS.md` 的加载与生效行为 |
| [agents-md-workdir-instructions-runtime-baseline.md](./agents-md-workdir-instructions-runtime-baseline.md) | 运行时基线（**merge main 补入**）—— 入口与逻辑请求边界（阶段 0 代码核查，不改运行时行为） |
| [runtime/](./runtime/)（11 篇） | **草稿（未实施）**：核验独有符号 0 命中 |
| 本 README + 10 篇接口说明 | SDK 接口现状 |

## 在途 / 草稿箱（in-flight）

`in-flight/` 目录**不再为空**（2026-10-15 新增一篇），另有一个按 §2.2 约定**原地保留**的未开工大规划：

- [agent-long-task-stability-improvement-plan.md](./in-flight/agent-long-task-stability-improvement-plan.md) —— **草稿（未实施）**：长程任务稳定性改进方案（2026-10-15，`main` 新增）；自述「当前实现分析与分阶段改造方案；首批不改运行时代码」。

- [runtime/](./runtime/)（01–10 + README，11 篇）—— **草稿（未实施）**：Runtime 目标形态设计与实施计划。核验（2026-10-14）：独有符号 `wake_one`、`bWaitAll`、`namedQuota`、`quotaLease`、`callStateMachine` **全部 0 命中**，无实现提交 → 真正在途。

> **2026-10-14 两轮核验更正（原判 C 有误，均已移入 `../archive/agent-sdk/`，共 18 件）**
> 第一批（用户点名 `context-injection-refactor-plan` 后复核）：`context-injection-refactor-plan.md`（`9dfc46d1`、`91e939ef`、`d96bd70b`、`b5eaada1`）、`runtime-admission-sdk-reuse-plan.md`（`22ea8d88`）、`butler-agent-shortest-path-plan.md`（`4b6f81c4`）、`b344321-current-code-refactor-plan.md`（`7a9b5c05`）。
> 第二批（按「最后更新早于 7 天则须复核」规则）：`agent-loop-single-path-refactor-plan.md`（`958f93c8` merge）、`tool-dispatch-slot-abort-and-transcript-hole-improvement-plan.md`（`51193571`）。

## 归档

已完成迭代原件见 [`../archive/agent-sdk/`](../archive/agent-sdk/)（16 件），含生命周期改进与契约矩阵、上下文 token 成本优化、`agent-core-contract-path-refactor-plan.md`（旧称，文件名保留）、驱动权限重构、失败 turn 续跑、工具错误恢复与 turn 连续性、`batch3-p0-evidence-audit.md`。映射见 [`../archive/INDEX.md`](../archive/INDEX.md)。

## 核验记录

- [baseline-check-2026-10-14.md](./baseline-check-2026-10-14.md) —— 基线 `17236274`；断言逐条带可复现命令，含「矛盾与时间线检查」「无法核验项」「抽样复核建议」。

## 迭代历史

见 [history.md](./history.md)。

