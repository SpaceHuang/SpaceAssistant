# Message Fact Persistence 生产链路：本机验收记录

本报告记录当前 worktree 对生产链路重构计划 §10 的本机可重复证据。报告只记录已经执行的命令和
可由测试直接观察的结果；未覆盖的链路明确列为未完成，不以静态扫描代替生命周期验收。

## 已通过的门槛

| 维度 | 验证命令/fixture | 结果 |
| --- | --- | --- |
| 全量 Vitest | `npm test` | 506 个测试文件、3135 个测试通过，约 91.22 秒；包含 authoritative context、legacy IPC removal 与 process identity 回归 |
| shared 类型边界 | `npm run typecheck:shared` | 通过 |
| renderer 类型边界 | `npm run typecheck:renderer` | 通过 |
| Electron/renderer 构建 | `npm run build`（授权环境） | 通过；Vite 仅有既有 config/chunk size warning |
| i18n 检查 | `npm run i18n:check` | 通过；报告 1,040 个硬编码中文出现（401 source、639 tests），命令按项目规则返回成功 |
| message-fact owner scan | `npm run check:message-fact-ownership` | 通过；递归覆盖全部 `src/renderer` TS/TSX 与 remote adapter，禁止旧 listener/测试夹具、旧 chat mutation、事实型 IPC 直发及直接写 message fact |
| checkpoint 高频事件 | `src/shared/turnCoordinator.test.ts` 的 10,000 rawDelta fixture | 320,000 字符正文；固定 2 秒窗口内 checkpoint 1 次；version 单调 |
| SQLite 高频事件 | `electron/turnCoordinatorStorage.test.ts` 的真实 SQLite fixture | 10,000 事件合并后完整 snapshot 可读回；跨 version checkpoint 通过 |
| checkpoint 边界 | `src/shared/turnCoordinator.test.ts` | confirm、tool result、source terminal、cancel race、late timer、DB error/retry 通过 |
| 异步 checkpoint 串行化 | `src/shared/checkpointQueue.test.ts`、`src/shared/turnCoordinator.test.ts` | 同一 turn 异步写入最大并发 1、顺序保持；不同 turn 可并行；前一次 reject 不阻塞后续写入；late timer 失败不再安排终态后的旧 retry；Coordinator 集成通过 |
| IPC handler dispatch baseline | `electron/appIpc.file.test.ts` | 1,000 次 `chat:list-active-turns` handler dispatch：约 0.288ms 总耗时（约 0.000288ms/次）；这是主进程 handler 基线，不替代真实 Electron transport RTT |
| 真实 Electron transport RTT | `npm run probe:chat-ipc-transport`，真实 hidden `BrowserWindow` + `ipcRenderer.invoke`，1,000 samples | 最新本机环境通过：p50 0ms、p95 0.100ms、p99 0.200ms、max 0.400ms；这是 transport baseline，不替代业务 handler/renderer 统一采样 |
| 真实生产业务 IPC RTT | `npm run probe:chat-business-ipc`，加载编译后的 `registerAppIpcHandlers`、真实临时 SQLite、真实 `TurnRuntime` active snapshot、hidden `BrowserWindow` + `ipcRenderer.invoke('chat:list-active-turns')`，1,000 samples | 最新本机环境通过：p50 0ms、p95 0.100ms、p99 0.200ms、max 0.500ms；Runtime 已产生真实 active turn，证明业务 IPC 注册、数据库初始化和 snapshot 出站；同一探针还覆盖 projection/terminal/SQLite 收口，`projectionDispatchMs=[1,0]`、`projectionDomCommitMs=[6.8,6.5]`，并输出 event/checkpoint/event duration |
| 真实 Electron ChatView DOM | `npm run probe:chat-renderer-dom`，Playwright 启动真实 Electron 并加载 Vite renderer；通过真实 `chat:prepare-turn` 建立消息、reload 后重新读取 active snapshot，销毁并重建主窗口后再次读取 active snapshot，再发送连续 `chat:turn-projection` | 最新本机环境通过：窗口标题 `SpaceAssistant`，`reloadRecoveredActiveTurn=true`、`windowReconnectedActiveTurn=true`，assistant DOM 检出投影正文、`ThinkingData(isVisible=true)` 和展开后的工具结果，随后接收 version=4 的 `source-completed`；`messageCount=3`、composer/model selector 存在、`projectedContentVisible=true`、`thinkingVisible=true`、`toolResultVisible=true`、`terminalProjectionApplied=true`、`projectionToDomMs=275ms`；证明真实 Electron reload 与主窗口重连后 active snapshot 可恢复，并由 projection 驱动 ChatView DOM 退出执行态 |
| 真实 Runtime → projection 事件 | 同一探针驱动真实 Runtime `content-delta`，经 `chat:turn-projection` channel 发往 hidden BrowserWindow，并在 preload 记录发送到达耗时 | 最新本机环境通过：`projectionCount=2`、`projectionVersion=1`、`projectionDispatchMs=[5,0]`、`metricCount=3`；同一 active turn 同时可由业务 IPC 读取，并覆盖 terminal 后 checkpoint/SQLite 统一汇总 |
| 真实 Runtime terminal 收口 | 同一探针经真实 `executeWithSource/finalize` 消费 `source-completed`，读取 terminal projection、active snapshot 和 SQLite persisted snapshot | 本机权限环境通过：`projectionCount=2`、`terminalProjectionCount=1`、`activeAfterTerminal=0`、`metricCount=3`（event/checkpoint/event）、`persistedState=terminal`、`persistedVersion=2`、`persistedAssistantStatus=completed`；证明 terminal 后 active turn 消失、checkpoint 产生且终态正确落库 |
| Coordinator/renderer 指标关联 | `src/shared/turnCoordinator.test.ts`、`src/renderer/services/turnProjectionService.test.ts` | 共享 `turnId/version` 指标出口已通过：Coordinator 输出 event/checkpoint 处理与持久化耗时，renderer projection 输出处理耗时；仍需在统一 Electron 进程中汇总同一条生产 turn |
| Shell lifecycle regression | `npm run test:shell-lifecycle`、`npm run probe:chat-orphan-cleanup` | 40 个测试文件、307 个测试通过；包含真实 shell timeout/cancel/tree cleanup、ProcessSupervisor evidence 与 orphan cleanup；最新跨父进程探针 `verified=true` |
| 终态单一写入 | `src/shared/turnCoordinator.test.ts` | source completed/error finalize 只经 checkpoint 端口写入，不再先 direct update 再 checkpoint；54 项 coordinator/runtime/storage 回归通过 |
| 持久化 round-trip | `electron/turnCoordinatorStorage.test.ts` | close/reopen 后 snapshot、error、usage、outcome、version、startToken、intent fingerprint 可恢复 |
| 跨重启 recovery/retry | `electron/turnCoordinatorStorage.test.ts` | 真实 SQLite close/reopen 后 active 与 completed/failed/cancelled/timed-out terminal 均可重建 Runtime；recover 幂等，retry 不重新执行 source，并恢复 outcome/usage/error |
| 独立进程 SQLite recovery/cleanup | `npm run build:electron && npm run probe:chat-restart-recovery`，独立 writer/reader 进程共享临时 SQLite 文件，reader 重建 `TurnRuntime` 并调用 `recover()` | 最新本机环境通过：writer PID 32153、reader PID 32154；恢复 1 个 executing turn 后，turn=`terminal`/`recovered`、assistant=`failed`、run_shell=`failed`/`interrupted`、version=2；证明跨进程启动 recovery 能收敛未完成工具状态 |
| Shell process identity propagation | `runShellExecutor` spawn 后 progress payload → `toolChatLoop` `tool-progress` fact → `assistantFactAggregator` snapshot | 已通过类型检查与 executor/aggregator 回归：合法本机 PID 可进入 executing tool snapshot，非法 PID 被忽略；身份字段可随 turn snapshot 持久化并在 recovery 读回 |
| 跨父进程 orphan cleanup 探针 | `npm run probe:chat-orphan-cleanup`，writer 启动 detached 子进程后退出，reader 校验 owner token 后执行进程组终止 | 最新本机环境通过：reader 对真实 PID 4980 完成 owner 校验并返回 `verified=true`；证明跨父进程 cleanup 可行 |
| 生产 orphan cleanup 模块 | `electron/shell/orphanProcessCleanup.ts` + `orphanProcessCleanup.test.ts` + `electron/main.ts` 启动钩子 | 真实 detached 进程组测试通过：owner 匹配返回 `cleaned`，owner 不匹配返回 `not-owned` 且不终止目标；模块已接入数据库打开后、Runtime recovery 前的生产启动时序，并记录审计事件 |
| 生产启动 orphan cleanup 协调器 | `npm run build:electron && npm run probe:chat-startup-orphan-cleanup`，正式 TurnRuntime checkpoint + SQLite snapshot + detached shell | 最新本机环境通过：`cleaned=1`、audit=`cleaned`、`exited=true`；并已覆盖 shell process identity codec round-trip，证明启动扫描能从持久化 snapshot 读回 PID/owner token 并完成清理 |
| 真实 Electron 父进程终止/重启 | `npm run probe:chat-electron-parent-restart`，第一实例真实 Electron 主进程承载 Runtime/SQLite checkpoint，外部 `SIGKILL`，第二实例复用同一 userData | 最新本机环境通过：`parentKilled=true`、`startupCleanupVerified=true`；启动钩子实际终止第一实例遗留的 detached shell 子进程 |
| TurnStorage contract | `src/shared/turnCoordinator.test.ts`、`electron/turnRuntime.test.ts`、`electron/turnCoordinatorStorage.test.ts` | append/prepare/queue claim/checkpoint/state/recovery 等核心端口均为必需成员；64 项回归通过 |
| finalize/recovery lifecycle | `src/shared/turnCoordinator.test.ts`、`electron/turnCoordinatorStorage.test.ts`、`electron/database/streamingCleanup.test.ts` | completed/error/cancel/timeout/repeated terminal/late event 与 active-turn/streaming residue recovery 均有回归证据 |
| startup recovery ordering | `electron/main.ts`、`electron/appIpc.ts` 与 streaming/SQLite/appIpc 回归 | Runtime 创建后才处理无 turn 孤儿消息，再进入 IPC recovery；3 个测试文件、42 个测试通过 |
| cancel/timeout projection | `electron/turnRuntime.test.ts` | 无在途及 source 在途 finishing 两条路径均发出唯一 `source-cancelled/source-timeout` terminal projection；修复直接调用 Coordinator 时 renderer 无事件的问题 |
| Runtime 主链路 | `electron/turnRuntime.test.ts` | no-tools/tools 事件顺序、projection version、terminal 状态一致 |
| renderer projection 主链路 | `src/renderer/services/turnProjectionConfirmLifecycle.test.ts` | no-tools 与 tools+confirm 参数化事件序列、旧版本抑制、assistant 投影及 pending-confirm 建立/清理通过；3 项测试 |
| remote 终态契约 | `electron/remote/turnExecutionAdapter.test.ts` | completed/failed/throw 及 desktop/WeChat/Feishu 共享 terminal fixture 通过 |
| remote retry/recovery 幂等 | `electron/remote/turnExecutionAdapter.test.ts` | desktop/WeChat/Feishu 参数化 retry 与跨进程 recovery fixture 通过；已完成 terminal 不重复调用 provider，恢复 terminal 返回稳定 ok 契约 |
| remote cancel propagation | WeChat/Feishu router、remote agent、turn adapter 聚焦回归 | `ChatCancelledError` → `cancelled` outcome → `source-cancelled` 全链路通过；6 个测试文件、52 个测试通过，Electron build 通过 |
| legacy 协议删除 | tool loop、MCP、remote focused tests | tool fact、usage、confirm 均只进 Core sink；`sendLegacyFact` 已删除 |

| §10 最终门槛复核 | `npm test`、`npm run typecheck:shared`、`npm run typecheck:renderer`、授权环境 `npm run build`、`npm run i18n:check`、`npm run check:message-fact-ownership`、`npm run probe:chat-business-ipc`、`npm run probe:chat-renderer-dom`、`npm run probe:chat-electron-parent-restart` | 全量 506 个测试文件、3135 项通过；类型检查、构建、i18n、owner scan 通过；业务 IPC/DOM/checkpoint 统一采样、ChatView reload/窗口重连和真实 Electron 父进程 SIGKILL/restart 均通过 |

## 最终结论

1. 当前 worktree 已成功启动真实 Electron 开发窗口，并通过 Playwright 以真实 `chat:prepare-turn`、reload、主窗口销毁/重建、active snapshot 恢复和连续 `chat:turn-projection` 驱动 assistant 正文、Thinking、展开后的工具结果和 terminal projection 进入 ChatView DOM；普通发送、重试、排队 drain、取消、确认和失败恢复已有 Core/Runtime/renderer projection 分层与组合 fixture。
2. checkpoint 长文本性能、真实 SQLite round-trip、业务 handler、projection transport、renderer DOM commit 与 checkpoint duration 已在同一业务 Electron 探针中采样；本项不再是未完成缺口。
3. Shell 真实子进程 timeout/cancel/tree cleanup、跨父进程 orphan 探针，以及真实 Electron 父进程 SIGKILL 后同一 userData 重启黑盒均已通过。
4. 计划 §10 的最终门槛命令集合已重新执行并固化在本报告中；本机范围内没有剩余未完成项。

因此，本报告证明计划范围内的本机开发、测试和生命周期验收已经完成。
