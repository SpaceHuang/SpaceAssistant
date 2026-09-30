# agent-sdk 接口说明

`packages/agent-sdk`（包名 `@spaceassistant/agent-sdk`）是 SpaceAssistant 的 **SDK 面**：契约类型 + 端口接口 + 纯 runtime 核。本目录按模块梳理它对外暴露的接口，供宿主（electron 主进程）装配方与 SDK 维护者查阅。

## 定位与边界

- 入口 `packages/agent-sdk/src/index.ts`；`package.json` 的 `main` / `types` 直接指向 `src/index.ts`，`exports` 暴露 `.` 与 `./model` 两个入口。
- 对外只承诺 `createAgentRuntime`（runtime 工厂）与契约类型/接口；契约层物理文件暂留宿主树，经 `src/shared/agent` 门面转发。
- 零 electron 依赖：SDK 与纯逻辑闭包必须可在纯 node 下运行（护栏 CI 锁定入口闭包）。
- 三条硬约束贯穿全部接口：
  1. 契约只放可序列化数据与消息，禁止函数句柄；
  2. 宿主能力一律经接口注入（`AgentHostPorts`）；
  3. 跨调用可变状态全部随 runtime 实例走（多实例，`AgentRuntime.instanceId`）。

## 模块地图

| 文档 | 对应源码 | 职责 |
| --- | --- | --- |
| [runtime.md](./runtime.md) | `src/runtime/*.ts` | runtime 工厂与纯组件核：审计、确认 ID、聊天取消、工具撤权、信号量 / MCP 闸 |
| [model-provider.md](./model-provider.md) | `src/model.ts`、`src/provider.ts` | 模型流契约（`StreamChunk`）、canonical 消息、provider 路由注册表与校验 |
| [turn-loop.md](./turn-loop.md) | `src/turn.ts` | 单回合主循环：模型轮次、工具阶段、输出上限恢复、终态结算 |
| [safety-approval.md](./safety-approval.md) | `capability.ts`、`safetyPermit.ts`、`safetyGate.ts`、`executionAdmission.ts`、`toolExecutionPort.ts`、`approval.ts`、`confirmationCommit.ts` | 能力投影 → 策略决策 → 许可签发 → 执行准入 → 审批容量与提交状态机 |
| [history.md](./history.md) | `src/history.ts` | 调用级事件流：追加、校验、幂等、重启状态重建 |
| [lifecycle-capacity-scheduler.md](./lifecycle-capacity-scheduler.md) | `lifecycle.ts`、`capacity.ts`、`scheduler.ts`、`resourceLock.ts` | 调用生命周期账本、容量共享账本、依赖调度器、资源互斥锁 |
| [host-ports.md](./host-ports.md) | `src/invocation.ts` | Agent 调用契约与宿主端口集合（装配方主入口） |
| [tool-result-contract.md](./tool-result-contract.md) | `src/toolResultContract.ts` | 工具结果信封：闭合失败码、不变量断言、事实优先归一 |

## 典型装配顺序

SDK 只定义契约与循环，装配由宿主完成，大致为：

1. `createAgentRuntime(components)` 建 runtime（可逐项覆盖注入桌面能力：SQLite 审计、内置工具注册表等）。
2. `new ModelProviderRegistry({ supportedProtocols })` → `register(route, provider)` 注册模型路由。
3. 组装安全侧：`CapabilityRegistry`（调用级能力投影）+ `SafetyPermitStore`（许可台账）+ 策略实现 → `new SafetyGate({ capabilities, permitStore, policy | resolvePolicy })`。
4. 用 `createPermitBoundToolExecutionPort(deps)` 包装宿主执行器，得到带 consume → dispatch-claim 屏障的执行端口。
5. 调 `runHostedAgentTurn({ host, ... })`（宿主只负责 `createPorts`）或直接 `runAgentTurn(input)` 跑循环。

## 约定速查

**路径 / 资源键前缀**（`resourceLock.ts`、`scheduler.ts`）

- `workspace:<path>`：文件系统键，目录读写与子路径操作互斥，但 `/src` 与 `/src2` 视为独立资源。
- `unknown:<id>`：无法证明影响范围的副作用（Shell / MCP 等），跨会话按全局屏障保守互斥（`resourceLock.ts`）。`scheduler.ts` 另有规则：**未声明** `resourceKeys` 的节点视为未知副作用，只能作为单节点串行屏障。

**审批状态流转**（`confirmationCommit.ts`）

`pending → committing → committed | rolled_back | reconciling`，`pending → cancelled`；`committing` 之后不允许直接 `cancelled`（写入已开始则必须落到 `rolled_back` 或 `reconciling`）。

**调用终态**（`lifecycle.ts` / `history.ts`）

`completed | cancelled | failed | denied | interrupted`。`interrupted` 覆盖：结果持久化不确定、执行已越过 dispatch 但结果未知、宿主投影失败、turn boundary 投影失败。

**错误码 / 错误类索引**

| 名称 | 出处 | 语义 |
| --- | --- | --- |
| `InvalidModelStreamError` (`INVALID_MODEL_STREAM`) | `model.ts` | 模型流事件序列非法 |
| `UnknownModelRouteError` (`UNKNOWN_MODEL_ROUTE`) | `model.ts` | 路由未注册 |
| `ModelRouteChangedError` (`MODEL_ROUTE_CHANGED`) | `model.ts` | 调用期间路由身份变化 |
| `UnsupportedReasoningError` (`unsupported-reasoning`) | `provider.ts` | provider 不支持请求的思维档 |
| `ToolSchedulerReservationError` (`tool-reservation-unavailable`) | `scheduler.ts` | 调度器无法在新节点启动前取到预留 |
| `HistoryVersionConflict` / `HistorySequenceConflict` / `HistoryIdempotencyConflict` / `HistoryBatchError` / `HistoryCorruptionError` | `history.ts` | 事件流版本、序号、幂等、批次、损坏冲突 |
| `ToolDeniedError` (`TOOL_DENIED`) | `turn.ts` | 工具未派发（策略拒绝 / 确认未通过 / 绑定漂移） |
| `ModelTurnLimitError` (`MODEL_TURN_LIMIT`) | `turn.ts` | 触及 `maxModelTurns` |
| `ToolLoopRoundLimitError` (`TOOL_LOOP_MAX_ROUNDS_EXCEEDED`) | `turn.ts` | 触及 `maxToolRounds` |
| `ModelOutputTokenLimitError` (`MODEL_OUTPUT_TOKEN_LIMIT_EXHAUSTED`) | `turn.ts` | 输出上限恢复已耗尽 |
| `ModelPreflightRejectedError` (`MODEL_PREFLIGHT_REJECTED`) | `turn.ts` | 请求预算预检拒绝（`OVER_BUDGET`） |
| `AgentTurnCancelledError` (`TURN_CANCELLED`) / `AgentTurnTimedOutError` (`TURN_TIMED_OUT`) | `turn.ts` | 回合取消 / 超时 |
| `InvalidTurnBoundaryError` (`INVALID_TURN_BOUNDARY`) | `turn.ts` | 边界投影破坏了必需消息或待派发提案 |
| `ModelAttemptRecoveryRejectedError` (`MODEL_ATTEMPT_RECOVERY_REJECTED`) | `turn.ts` | provider 尝试恢复被拒绝 |
| `ToolExecutionRejectedError` (`TOOL_EXECUTION_REJECTED`) | `toolExecutionPort.ts` | 执行前被拒（未进入执行器） |
| `ToolExecutionAfterDispatchError` (`TOOL_EXECUTION_UNKNOWN_AFTER_DISPATCH`) | `toolExecutionPort.ts` | 已进入执行器，异常无法证明无副作用 |
| `ChatCancelledError` (`CHAT_CANCELLED`) | `runtime/components.ts` | 聊天取消 |
