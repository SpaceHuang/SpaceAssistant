# Message Fact Persistence 生产链路：本机未完成任务清单

本文档基于当前工作树与
`docs/develop/message-fact-production-pipeline-refactor-plan.md` 的对照审计，
只列出计划范围内、可以在本机继续开发和验证、但当前尚未完成的任务。

状态约定：

- `[ ]` 尚未完成。
- `[~]` 已有部分实现，但未达到计划要求，或缺少完整链路验收。
- `[x]` 已完成；本清单原则上只保留未完成项，`[x]` 仅用于已具备但必须作为前置基线保持的能力。

## P3：桌面端整体切换到 Core / Projection

- [x] **完成桌面端旧事实写入调用点的分类与收口。**
  - 证据：生产代码中的非 turn mutation 已迁移为独立命名的
    `messageAppendNonTurn` / `messagePatchNonTurn`；旧 `chatAppendMessage`、`chatPatchMessage` 及
    `chat:append-message`、`chat:patch-message` 名称已从 `src/`、`electron/` 生产路径移除，归属扫描会阻止回归。
  - 验收：生产代码中的每个 `chatAppendMessage` / `chatPatchMessage` 调用点均有明确用途标签；
    新 turn 的用户消息、助手消息、工具消息、状态更新均不经过这两个 API；为允许保留的编辑、删除、导入、
    shell scrollback、skill hint、test-card 等非 turn mutation 各增加调用约束测试。

- [x] **完成新 turn 全入口的 Core 化。**
  - 范围：普通发送、重试回复、排队与 drain、取消、确认工具、无工具回复、有工具回复、失败后恢复。
  - 验收：为每个入口增加测试，证明入口只创建/复用 `TurnIntent` 并调用 Core；渲染进程没有直接创建
    user/assistant message fact、没有 queued→sent 的本地 patch；同一入口的事实写入均可在持久化 turn 与 projection 中找到。
  - 本轮补充：`messageMutationGateway.core.test.ts` 新增 reuse-user retry 与 queued drain fixture，证明失败回复重试和排队 drain
    都只调用 `chatPrepareTurn`，queued user 可由 Core 原子 claim 为 sent，不在 renderer 本地 patch/append user fact；cancel、
    confirm、工具/无工具和失败恢复已有独立 Core/Runtime/SQLite/ChatView 证据。
  - 本轮 RED→GREEN：新增 `turnProjectionConfirmLifecycle.test.ts` 参数化 projection fixture，覆盖 no-tools 与 tools+confirm
    的完整事件序列、连续 version、旧版本忽略、assistant message 投影与 pending confirm 建立/清理；renderer projection
    聚焦测试 3 项通过。仍缺少把真实 Electron Runtime 事件源与 ChatView 挂接在同一个进程中的端到端样本。
  - 本轮 RED→GREEN：修复 `tool-use` 未切断开放 Thinking segment 导致工具后的 Thinking 沿用旧时间戳、被排序到工具之前；
    `assistantFactAggregator` 现在仅在首次创建工具调用时关闭前置正文/Thinking，重复 `tool-use` 保持幂等；聚焦回归 3 个文件、21 项通过。
  - 本轮补充：`electron/appIpc.file.test.ts` 增加桌面 `chat:cancel-turn` IPC fixture，确认 cancel 只委托 Core
    Coordinator，不直接修改 renderer/message fact；20 项 appIpc 回归通过。
  - 本轮再补充：同一文件增加 `tool:confirm-response` fixture，确认桌面拒绝响应只解析 pending Core waiter，
    不直接发送或写入事实事件；21 项 appIpc 回归通过。
  - 本轮再补充：`electron/turnRuntime.test.ts` 增加统一桌面生命周期 fixture，覆盖普通发送、tool-use、confirm-requested、
    tool-confirmed、tool-result、source-completed 的事件顺序、连续 version、terminal projection 和 active turn 清理。
  - 本轮 RED→GREEN：发现并修复 `TurnRuntime.cancel/timeout` 直接调用 Coordinator、导致立即终态没有通知 projection 的缺陷；
    现在 cancel/timeout 会通过统一 Runtime listener 发出唯一 `source-cancelled/source-timeout` terminal fact，12 项 Runtime 测试通过。
  - 本轮再补充：覆盖 source 在途时 cancel 进入 finishing window 的路径；`execute/executeWithSource` 在 Coordinator 收敛
    cancelled/timed-out outcome 后补发唯一 control projection，13 项 Runtime 测试通过。

- [x] **替换 `toolChatLoop` 的事实型 legacy UI 双发。**
  - 当前进展：`electron/claudeStreamHandlers.ts`、`electron/toolChatLoop.ts` 及三个 remote agent 的事实事件
    均只通过 Core event sink 进入 reducer/projection；legacy fact 双发路径已删除。
  - 证据：预算阻断、shell 计划失败、工具拒绝/超时/确认等异常分支均有对应 Core fact；usage、MCP、tool loop、
    remote agent 聚焦回归通过，owner scan 阻止事实型 `safeWebContentsSend` 回归。
    Claude handler 的 legacy done/error 发送已删除；tool loop 的事实型兼容发送函数也已删除，非事实的
    `claude-chat-tools-activity` 通知保留为明确声明的 UI 状态通知。
  - 验收：文本、thinking、tool call/result、usage、terminal/error 等事实全部经 `TurnRuntime`/event sink
    进入 Core，再由 projection 输出；`toolChatLoop` 不再向 renderer 发送可被当作事实源的 legacy 事件；增加静态扫描
    或单元测试防止新增事实型 `safeWebContentsSend`。

  - 本轮补充：`TurnRuntime.executeWithSource` 在 source 抛错时也会先经统一 reducer/projection 消费
    `source-failed`，避免桌面 source 异常只更新数据库而不通知 projection；Runtime 与 remote adapter 回归测试通过。
  - 本轮再补充：legacy 事实协议已完成删除；生产路径保留的仅是非事实 UI activity 通知。
  - 本轮迁移测试：MCP confirm 测试不再读取 `safeWebContentsSend` 的 `tool:confirm-request`，改为断言
    `emitFactEvent` 的 `confirm-requested` 事实；该测试 5 项通过。仍有 tool loop 兼容 helper 和 usage
    迁移夹具待删除。
  - 本轮迁移 usage：`toolChatLoop` 的失败收尾、普通 usage 和 tool-result 后 projected usage 已只发送
    `usage-updated` Core fact，删除对应 `claude-chat-usage` legacy 双发；usage/MCP 聚焦测试 12 项通过。
  - 本轮迁移 delta：thinking/content delta 已删除 `claude-chat-thinking-delta` 与 `claude-chat-delta` 双发，
    仅保留 `thinking-delta`/`content-delta` Core fact；tool loop/Claude handler 聚焦测试 59 项通过。
  - 本轮再迁移：tool use 与 tool progress 已删除 `tool:use`/`tool:progress` legacy 双发，保留
    `tool-use`/`tool-progress` Core fact；tool loop/Claude handler 聚焦测试 59 项通过。
  - 本轮完成事实协议删除：tool result 各类失败、拒绝、超时和成功分支均删除 `tool:result` 双发；confirm
    请求也删除旧 `tool:confirm-request` 双发，保留 `confirm-requested` Core fact。`sendLegacyFact` helper、
    `legacyFactCompatibility` 参数及四个生产装配点的兼容配置均已删除；tool/remote 聚焦测试 75 项通过。

- [x] **迁移 legacy Claude renderer listeners。**
  - 当前进展：renderer 已从 `chatOnTurnProjection` 接收 `usage-updated`，App 不再初始化全局
    `claude-chat-usage` listener；`electron/preload.ts` 与 `src/shared/api.ts` 已删除
    `claudeChatOnDelta`、`claudeChatOnThinkingDelta`、`claudeChatOnDone`、`claudeChatOnUsage`、
    `claudeChatOnError` 暴露，旧 `contextUsageStreamService` 已删除。
  - 本轮清理：历史测试中的旧协议名称和 `safeWebContentsSend` channel 参数已迁移为 Core fact/通用通知语义；
    `rg` 扫描 `src`、`electron`、`scripts` 已无旧事实协议匹配，相关 3 个测试文件 13 项通过。剩余仅是完整
    桌面端到端验收边界，不再存在生产 legacy listener/发送调用。
  - 验收：renderer 只从 projection 或明确声明的非事实通知通道读取状态；完成迁移后删除无消费者的 preload/API
    暴露，并通过 `rg` 检查生产代码与测试中不再出现已删除协议。

- [x] **补齐桌面端刷新、窗口销毁和重连期间的 projection 一致性。**
  - 当前进展：`turnProjectionService` 已增加 dispose 代际保护；窗口销毁后，迟到的 `chatListActiveTurns()` snapshot
    不再写入 renderer，并有回归测试锁定该行为。
  - 本轮补充：新增重连 fixture，验证重新订阅时以 authoritative `chatListActiveTurns()` snapshot 重建，旧窗口 listener
    的迟到事件被丢弃，新 listener 事件按版本继续投影；ChatView 刷新后的确认卡片恢复也已有真实组件组合 fixture。
  - 本轮 RED→GREEN：发现并修复 projection bridge 先请求 active snapshot、后注册 listener 的同步竞态；现在先订阅再请求
    snapshot，并由 turn version 抑制较旧快照，新增测试覆盖 snapshot 调用期间同步到达的 projection event 不丢失。
  - 本轮补充：新增 projection-confirm lifecycle 集成式 fixture，验证 confirming assistant snapshot 能建立 pending confirm
    item，后续 terminal snapshot 会清理该 item；并新增 ChatView 组合渲染 fixture，验证刷新后确认卡片仍由 projection/pending
    store 恢复，而不是依赖旧 confirm IPC。
  - 本轮黑盒验收：`npm run probe:chat-renderer-dom` 已在真实 Electron + Playwright 中执行 `chat:prepare-turn`、页面
    `reload`、主窗口销毁/重建，并通过 `chat:list-active-turns` 校验同一 turn/assistant snapshot 在刷新和窗口重连后恢复；
    最新结果含 `reloadRecoveredActiveTurn=true`、`windowReconnectedActiveTurn=true`、Thinking/工具结果/terminal projection 可见。
  - 验收：在本机自动化测试中覆盖发送中刷新、窗口销毁、重新打开、重试、队列 drain、确认框未决等场景；
    恢复后 renderer 只根据持久化 snapshot/projection 重建列表，不能依赖进程内 legacy event 或补写。

## P4：远程入口统一使用同一生产运行时

- [x] **完成 WeChat/Feishu 出站适配器的 snapshot-only 收口。**
  - 当前进展：WeChat/Feishu 由 `prepare(create-user)` 原子创建 user/assistant/turn，均通过同一
    `executeRemoteTurn`、`emitFactEvent` 和 snapshot 出站链路；缺少 Runtime/prepared turn 时直接拒绝，
    不再存在无 Runtime 的 user fact append fallback。
  - 现状：共享 runtime/router 已存在，但完整远程出站链路仍缺少与桌面端等价的最终 snapshot、确认、terminal/error
    验收证据。
  - 本轮补充：`executeRemoteTurn` 的 source 异常路径现在也先消费 `source-failed` Core fact，再向 remote 调用方传播原异常；
    adapter、WeChat、Feishu 聚焦测试共 17 项通过。
  - 本轮再补充：删除 WeChat/Feishu router 在缺少 `turnRuntime` 时直接 `appendMessage` 写 user fact 的无效 fallback；
    两个 router 随后本就会因缺少 prepared turn 拒绝执行。远程 router 回归 19 项与 shared typecheck 通过。
  - 本轮补充：WeChat/Feishu router 新增非终态事实→Runtime、终态→统一 adapter 的参数化式回归；两条远程入口均断言
    `tool-use` 先于 `source-completed` 消费，远程 adapter/router 聚焦回归 30 项通过。
  - 本轮再补充：WeChat/Feishu 的 `confirm-requested` 事实均有 router 回归，确认事件进入 Runtime 且不会被 remote adapter
    过滤；Feishu pending-confirm 窗口通知由既有 origin-session fixture 覆盖，远程 router 回归 18 项通过。
  - 本轮再补充：remote adapter 增加跨进程 `cancelled` / `timed-out` outcome 参数化测试，验证三入口在无需重新执行
    provider 的情况下返回稳定的 `{ ok: false }` 契约；adapter 回归增至 16 项。
  - 本轮 RED→GREEN：发现远程 `ChatCancelledError` 原先只返回 `ok:false`，会被 adapter 错误收敛为 `source-failed`；现在
    `runToolChatSession` → `ImRemoteAgent` → `executeRemoteTurn` 保留 `cancelled` outcome，并统一消费 `source-cancelled`。
    remote adapter/tool loop 聚焦 22 项与 Electron build 均通过。
  - 本轮补充：`ImRemoteAgent` 新增 cancelled outcome 传递回归，确认 remote agent 不会吞掉 tool loop 的取消语义；adapter/agent
    聚焦回归 22 项通过。
  - 本轮验收：remote adapter、WeChat router、Feishu router 已覆盖普通文本、tool-use/tool-result、confirm-requested、
    source-failed、source-cancelled、source-timeout、retry 和跨进程 terminal recovery；所有事实均通过 Runtime/Projection
    入口消费，缺少 prepared turn 时拒绝执行。
  - 验收：远程适配器只消费 `TurnProjection`/authoritative snapshot；不直接写 messages 表、不补写 assistant fact、
    不消费 `toolChatLoop` 的 legacy delta；分别增加普通文本、工具调用、工具结果、确认、失败、取消的测试。

- [x] **建立桌面、WeChat、Feishu 三入口的参数化行为测试。**
  - 当前进展：remote execution adapter 已增加 completed/failed/throw 终态契约参数化测试；新增 desktop/wechat/feishu
    三入口共享 `prepare/execute/terminal` fixture，断言同一 Runtime source 与 terminal fact 契约；WeChat、Feishu router
    聚焦回归与 adapter 契约共 22 项通过；本轮补充三入口 retry fixture，证明已完成 terminal 的 retry 不再调用 provider，
    且复用首次业务结果（11 项 adapter 测试通过）；本轮新增 desktop/wechat/feishu 跨进程恢复 terminal fixture，
    验证 persisted outcome 下不再调用 provider，并返回稳定的 ok 契约（14 项 adapter 测试通过）。
  - 验收：同一组测试覆盖 prepare/execute、事件顺序、版本号、terminal outcome、重试幂等和恢复；测试明确断言
    三个入口使用同一 Core source，并且没有入口绕过 Core 写入事实。
  - 本轮验收完成：`turnExecutionAdapter.test.ts` 的 desktop/wechat/feishu 参数化 fixture 已覆盖 completed、failed、
    throw、cancelled、timed-out、retry、recovery；入口 router 测试覆盖 confirm 与非终态事实顺序，聚焦与全量回归均通过。

## §6.3：checkpoint 策略与持久化版本

- [x] **把当前“每个有效事件立即 checkpoint”改为“首次变脏后固定最长 2 秒 timer”。**
  - 当前进展：`src/shared/turnCoordinator.ts` 已在首次普通事实事件后启动固定 2 秒 timer，后续 delta 不重置；
    `confirm-requested`、`tool-confirmed`、`tool-result` 及所有 source 终态会取消 timer 并立即提交最新 snapshot。
    `src/shared/turnCoordinator.test.ts` 已用 fake timers 覆盖 10000 个 rawDelta 只产生一次 checkpoint，以及三类工具边界。
  - 本项已完成；checkpoint 串行化、版本冲突与失败重试由下一项验收，长文本/transport 性能由独立性能门槛项验收。
  - 验收：使用 fake timers 证明首次 text/thinking dirty 启动一个 timer；后续 delta 不重置 timer；timer 到期只提交
    最新完整 snapshot；同一窗口内 checkpoint 次数与事件数量无关。

- [x] **实现重要边界的立即 checkpoint 与 terminal 同步提交。**
  - 范围：工具确认请求、工具结果、恢复边界、cancel、error、done/finalize。
  - 验收证据：`src/shared/turnCoordinator.test.ts` 已覆盖 confirm-requested/tool-confirmed/tool-result 的即时
    checkpoint、source error/completed、cancel race、timeout 及 finishing finalize；timer 尚未到期时的 cancel
    终态会先写入最新正文，随后不会被 late timer 重复覆盖。

- [x] **增加 checkpoint 串行化、版本冲突与失败重试测试。**
  - 当前进展：`TurnCoordinator` 已对 checkpoint 返回 `false` 或抛出 DB error 的情况保留最新内存 snapshot，并以 100ms 间隔进行
    有限重试；`src/shared/turnCoordinator.test.ts` 已覆盖首次失败后成功、异常后成功、成功后不重复写入。
  - 当前进展：SQLite `checkpointTurnAtomically` 已有回归测试证明 version 单调推进，重复/旧 expectedVersion 不能覆盖新
    snapshot，且数据库 version 与消息内容保持一致；本轮修复并测试了固定 timer 从旧 version 直接合并推进到
    version 10000 的场景。
  - 当前进展：新增 fake-timer 测试覆盖 cancel race，证明普通 checkpoint timer 尚未到期时，finishing finalize 会提交包含最后正文的
    单个终态 snapshot，随后不会被 late timer 重复写入。
  - 本轮补充：source 直接返回 terminal（未先发 terminal fact）时，finalize 会立即 checkpoint 最新终态并取消普通 timer；
    新增 late-timer 回归测试，避免终态后旧 timer 再次落库。
  - 本轮再补充：source completed/error finalize 删除 direct `updateIfStreaming` 写入，统一由 checkpoint 端口提交
    最新终态 snapshot；相关 coordinator/runtime/storage 回归 54 项通过。
  - 本轮补充：新增连续 DB failure 达到有限重试上限的测试，确认不会无限调度且最新内存 snapshot 保留。
  - 本轮补充：新增 `CheckpointQueue`，同步 adapter 保持立即语义，异步 adapter 按 turn 排队；同一 turn 的异步 checkpoint 最大并发为 1，不同 turn 可并行；新增 reject 后队列继续执行，以及异步 timer 写入晚于 terminal 失败时不再安排旧 retry timer 的测试。Coordinator 集成测试覆盖 confirm/tool-result 连续边界、版本顺序、不重叠写入、late timer 与失败重试。
  - 验收：同一 turn 不会并发写入；`persistedVersion` 单调递增；旧版本不能覆盖新版本；写入失败不会丢失内存最新
    snapshot，并有可观测的重试/失败结果；覆盖 late timer、cancel race、DB error 和重复 terminal。

- [x] **按计划 §10 补齐长文本/rawDelta 的性能门槛。**
  - 当前进展：`src/shared/turnCoordinator.test.ts` 已固定 10,000 个 rawDelta fixture，断言 320,000 字符正文、
    单调 version、最长 2 秒内只触发 1 次 checkpoint，并输出事件处理耗时、checkpoint 次数和持久化回调耗时；
    `electron/turnCoordinatorStorage.test.ts` 已用真实 SQLite adapter 验证 10,000 个事件合并后能读回完整 snapshot，
    并覆盖跨版本 checkpoint；renderer 侧已有 20/500 消息 mount/DOM/stream commit 性能记录。
  - 本轮补充：`electron/appIpc.file.test.ts` 增加 1,000 次 `chat:list-active-turns` handler dispatch baseline，并写入验收报告；
    本轮新增 `scripts/probe-chat-ipc-transport.cjs`，在授权环境以真实 hidden BrowserWindow + `ipcRenderer.invoke` 完成
    1,000 次 transport RTT 采样（本次本机权限环境 p50 0ms、p95 0.100ms、p99 0.200ms、max 2.100ms）；另新增真实生产
    `registerAppIpcHandlers` + 临时 SQLite + hidden BrowserWindow 的 `chat:list-active-turns` 业务 IPC 探针，1,000 次采样
    p50 0ms、p95 0.100ms、p99 0.200ms、max 0.900ms；探针现在由真实 `TurnRuntime` + 临时 SQLite 产生 active
    snapshot，再经生产 `registerAppIpcHandlers` 和真实 BrowserWindow 读取；同一探针还驱动真实 Runtime
    `content-delta` 并继续消费 `source-completed`，收到 `projectionCount=2`、`terminalProjectionCount=1`、
    `activeAfterTerminal=0`、`metricCount=3`（event/checkpoint/event）；Coordinator 与 renderer projection 均有按
    `turnId/version` 关联的指标 sink 和回归测试；新增独立 writer/reader 进程共享 SQLite 的
    `probe:chat-restart-recovery`，已验证 executing turn、version、assistant/tool snapshot 跨进程读回。仍缺少完整
    renderer bridge 的 DOM commit 统一采样；最新 `npm run probe:chat-business-ipc` 输出
    `projectionDomCommitMs=[6.8,6.5]`，并在同一真实 Electron 业务探针中汇总 `event/checkpoint/event` metric、
    checkpoint duration、projection transport/DOM commit、terminal 后 SQLite `persistedState=terminal`、
    `persistedVersion=2` 与 `persistedAssistantStatus=completed`。
  - 验收：记录 IPC/renderer 处理耗时、snapshot 合并耗时、checkpoint 次数与持久化耗时；用固定长文本和高频
    rawDelta fixture 验证不会按 delta 数量线性触发完整落库；测试结果写入计划验收记录。

## Storage、API 与幂等契约

- [x] **将 `TurnStorage` 的核心持久化能力收敛为必需端口。**
  - 本轮完成端口收紧：`appendMany`、`saveTurn`、`updateIfStreaming` 已从 `TurnStorage` 改为必需成员，
    `TurnCoordinator` 不再通过这三项的可选 fallback 工作；SQLite adapter、共享 coordinator/runtime fake
    均显式实现同一接口。相关 53 项 coordinator/runtime/storage 测试与 shared typecheck 通过。
  - 本轮再补充：`prepareAtomic` 也已改为必需端口，create-user 不再回退到分步 append；atomic prepare/queued
    claim 不重复调用 `saveTurn`，reuse-user 的非 queued 路径仍通过 `saveTurn` 建立 turn 记录。coordinator/runtime
    回归 43 项通过。
  - 本轮再补充：`checkpoint` 也已改为必需端口，默认 coordinator checkpoint 不再回退到消息 update；终态和
    timer checkpoint 测试改为断言统一 checkpoint 端口，coordinator/runtime/storage 回归 53 项通过。
  - 本轮再补充：`updateTurnState` 也已改为必需端口，executing、terminal、cancel/timeout finalize 不再静默跳过
    持久化状态更新；coordinator/runtime/storage 回归 53 项通过。
  - 本轮完成：`claimQueuedAtomic`、`listUnfinishedTurns`、`recoverTurn` 也已改为必需端口，Coordinator 删除对应可选 fallback；
    SQLite adapter、shared Coordinator fake、Runtime fake 均实现完整 storage contract，64 项 coordinator/runtime/storage 回归通过。
  - 验收：核心依赖不再通过可选 `appendMany`、`saveTurn`、`updateIfStreaming` 等 fallback 才能工作；缺失实现时
    类型检查直接失败；SQLite adapter、memory adapter 和测试 fake 均实现同一接口。

- [x] **补全 `findByRequestId` 的幂等恢复结果。**
  - 当前进展：SQLite adapter 已恢复 `userMessage`、持久化 `version`、`startToken`、terminal outcome 和 usage；turn schema 已升级到 v8，
    prepare、queued claim、普通 fallback save 三条创建路径均可写入 token，并由 `electron/turnCoordinatorStorage.test.ts`
    锁定恢复行为。
  - 当前进展：恢复到带 `persistedOutcome` 的终态 turn 后，`prepare` 会重新登记进程内 active map，重复 `execute`
    直接返回持久化 outcome/usage/error，不再调用 model source；completed、failed、cancelled、timed-out 四类终态均有
    `src/shared/turnCoordinator.test.ts` 覆盖；`restoreTurn` 也保留持久化 version/startToken/outcome/usage。
  - 本轮补充：新增进程内 terminal 后重复 `execute` 回归，确认同一 execution promise 被复用、source 只调用一次，
    并返回相同 outcome/usage。
  - 本轮补充：真实 SQLite close/reopen 后参数化覆盖 prepared/executing/waiting-confirm；重建 Runtime、restore active turn、recover 两次及同 requestId retry 均通过，source 不会重新执行。另新增 completed/failed/cancelled/timed-out 四类 terminal 的跨重启 retry，验证恢复 outcome/usage/error 且 source 不重复执行，17 项 storage 测试通过。
  - 验收：相同 requestId 的 prepare/execute/retry 返回同一 turn 与同一 message identity；已完成、失败、取消、确认中
    状态都能恢复完整 snapshot；重复调用不会新增事实或重复执行工具。

- [x] **补全持久化字段与 snapshot 的读回覆盖。**
  - 范围：`error_json`、`terminal_usage_json`、`intent_fingerprint`、context boundary、queue association、
    expected/persisted version 及恢复所需的 message identity。
  - 本轮补充：数据库 schema 升级到 v10，新增 `error_json`、`intent_fingerprint`、独立 `terminal_usage_json` migration；
    SQLite 查询、写入、读回及 round-trip 测试已覆盖错误对象、意图指纹、终态 usage、version、outcome、startToken。
    Coordinator 现在会为 create/reuse intent 生成 fingerprint，并在 source/cleanup terminal 路径写入结构化 error；
    queued claim 也已传递并持久化 fingerprint/startToken，相关原子 claim round-trip 测试已通过；新增真实 SQLite 文件
    close/reopen 测试，验证重启后 snapshot、error、usage、outcome、version、startToken 和 fingerprint 均可恢复。
    当前仍需将该恢复证据接入完整桌面/远程重试生命周期。
  - 验收：每个字段都有 migration、写入、读回、恢复和 round-trip 测试；数据库重启后 snapshot 与内存中完全一致。

## Finalize、恢复与生命周期

- [x] **统一 source completion/error/cancel/timeout/recovery 的 finalize 路径。**
  - 当前实现：`execute`、`updateTurnState`、恢复流程均以 Coordinator 最新 reducer snapshot 为权威，终态持久化经过统一 checkpoint/state contract。
  - 本轮修复：source 在已消费部分正文后抛错时，finalize 现在读取最新 reducer snapshot，不再用 execute 开始时的旧 assistant
    覆盖正文；终态 version、结构化 error 和持久化状态同步使用最新版本，并有回归测试。
  - 验收：所有终态都经过同一个持久化 finalize；终态只产生一次；终态后的 late event 被拒绝或幂等忽略；
    user/assistant/tool facts、usage、error、projection version 一致。

- [x] **完成“在途最后结果”与真实 Shell cleanup evidence 的收尾契约。**
  - 本轮补充：新增 `ProcessSupervisor` 回归测试，覆盖 tree-kill verified 才能进入 `terminated`、deadline 超时进入
    `termination_failed`、killer 异常、abort race（迟到 verified 结果不得覆盖失败终态）和重复 terminate 幂等；Shell cleanup
    现在新增真实子进程集成证据：实际 spawn 子进程并调用 `processTreeKiller`，退出确认后进入 `terminated`，重复 terminate
    复用同一结果；新增独立 writer/reader recovery 探针，reader 重建真实 `TurnRuntime` 并执行 `recover()`，验证 turn
    进入 `terminal/recovered`，assistant 进入 `failed`，未完成 `run_shell` 进入 `failed/interrupted`。仍缺父进程被终止后
    已补齐真实 spawn 后 PID 经 progress fact 写入 tool snapshot 的生产路径，并由类型/回归测试验证合法性；仍缺父进程
    被终止后，新增 `probe:chat-orphan-cleanup`：writer 启动 detached 子进程后退出，reader 校验 owner token 后对真实
    进程组执行终止并取得 `verified=true`；另新增生产 `orphanProcessCleanup` 模块，真实测试覆盖 owner 匹配的
    `cleaned` 与不匹配的 `not-owned`。当前模块、持久化进程身份和异步 cleanup 已接入 `electron/main.ts` 的数据库打开后、
    `TurnRuntime` recovery 前启动阶段，并记录 `shell.orphan_cleanup` 审计事件；剩余缺口是用真实应用父进程被终止的
    黑盒场景验证该启动钩子，而不是单独模块/单元测试。
  - 本轮补充：跨 SQLite 重启 recovery/retry fixture 现在携带真实 `run_shell` executing tool call，验证重启后工具快照保留、只恢复
    一次并幂等 retry，不会重复 finalize；`electron/turnCoordinatorStorage.test.ts` 17 项通过。
  - 本轮修复：`messageCodec` 反序列化补齐 `processPid`、`processGroupId`、`processOwnerToken`，避免重启后 shell 身份丢失；
    新增正式 checkpoint + SQLite + detached shell 的 `probe:chat-startup-orphan-cleanup`，最新结果为
    `cleaned=1`、audit=`cleaned`、`exited=true`。新增 `npm run probe:chat-electron-parent-restart`：第一实例的
    真实 Electron 主进程承载正式 TurnRuntime/SQLite checkpoint，外部 `SIGKILL` 后以同一 userData 启动第二实例，
    输出 `parentKilled=true`、`startupCleanupVerified=true`，证明启动钩子实际清理 detached shell 子进程。
  - 验收：finalize 前能消费已到达但尚未落库的最后一个结果；shell 任务只有拿到真实 cleanup evidence 才允许标记
    terminal；覆盖 abort race、5 秒 cleanup timeout、进程重启和重复 finalize。

- [x] **合并启动恢复与旧 streaming residue cleanup。**
  - 当前进展：`cleanupStreamingResiduesOnStartup` 现在只处理没有 `turns.assistant_message_id` 所有权的孤儿 streaming
    assistant；属于 persisted turn 的消息由 Runtime recovery 独占处理，新增回归测试防止双重恢复。
  - 本轮补充：真实 SQLite + `TurnRuntime.recover()` 参数化覆盖 `prepared`、`executing`、`waiting-confirm`，每个状态首次
    恢复一次、重复 recover 返回 0，并读回 `recovered/failed` terminal snapshot；新增 close/reopen 后重建 Runtime 并 retry 的
    fixture，确认 source 不重复执行。
  - 本轮再补充：移除 `main.ts` 在 Runtime 创建前的独立 cleanup 调用，改为 Runtime 实例建立后、IPC recovery 装配前执行，
    避免启动阶段先修改消息再创建 Runtime；相关 streaming cleanup、SQLite recovery 与 appIpc 回归通过。
  - 验收：启动时每个 active turn 只有一个恢复决策；prepared/executing/waiting-confirm/streaming/failed assistant
    的恢复结果均有测试；close/reopen 后 retry 不重复执行 source，恢复后不会再次出现 `SESSION_TURN_BUSY` 或重复 terminal。

## P5：删除旧协议并完成最终验收

- [x] **删除旧 fact IPC、renderer reducer 与 remote 补写兼容层。**
  - 前置：P3/P4 所有消费者已迁移。
  - 当前进展：旧通用 chat mutation 已拆为明确的 `message:*-non-turn` API，生产消费者与回归测试已迁移；
    旧 fact listener、renderer fact reducer、流式补写和 tool loop/remote fact 双发兼容层已清理。
  - 验收：删除 `chat:append-message` / `chat:patch-message` 中不再需要的 turn 语义及对应 preload/shared API；
    保留的通用 mutation 必须有独立命名、用途说明和 active-turn 冲突检查；生产代码扫描不到旧 turn 写入路径。

- [x] **完成 owner audit 与防回归扫描。**
  - 当前进展：已更新 `docs/develop/message-fact-production-pipeline-owner-audit.md`，并新增可本机运行的
    `npm run check:message-fact-ownership`；当前扫描覆盖 preload/shared API 的 legacy listener 暴露、Claude
    source/tool loop 的事实 IPC 直发，扫描已通过。
  - 本轮完成：扫描递归覆盖全部 `src/renderer` TypeScript 源码，并覆盖 remote execution adapter；禁止旧 listener、旧
    chat mutation 以及 renderer/remote 直接写入 message fact 的调用名称，`npm run check:message-fact-ownership` 通过。
  - 验收：更新 owner audit 准确列出 P3/P4/P5 当前状态；增加可在本机运行的扫描命令，检查 renderer、tool loop、
    remote adapter 不得新增 assistant/user fact 直接写入、legacy fact event 双发或绕过 Core 的调用点。

- [x] **完成计划 §10 的最终本机验收门槛。**
  - 当前进展：本轮已重新执行全量 Vitest，默认 reporter 进程成功退出；新增的 projection dispose 回归与 SQLite checkpoint
    性能夹具均包含在内。`npm run typecheck:renderer`、`npm run typecheck:shared`、`npm run i18n:check`、
    `npm run build`（含 renderer 与 Electron 构建）和 owner scan 已通过。此前 MCP HTTP/SSE
    超时及沙箱内 tsx IPC pipe 的 `EPERM` 均已在本机权限下验证通过。
  - 本轮补充：`TurnRuntime` 新增 no-tools 与 tools 两条参数化主链路测试，断言事件顺序、版本单调和 terminal message
    状态一致；完整三入口报告仍待补齐。
  - 本轮补充：新增 `docs/develop/message-fact-production-pipeline-local-acceptance-report.md`，集中记录 506/3135
    全量测试、checkpoint/rawDelta、真实 SQLite round-trip、Runtime 主链路、remote terminal 和 owner scan 证据，
    并明确列出 IPC 采样、retry/recovery fixture、renderer 重连和异步 checkpoint 并发证据的缺口。
  - 本轮补充：真实 Electron 业务探针已将 IPC RTT、projection transport、renderer DOM commit、Runtime event/checkpoint
    duration、terminal projection 与 SQLite terminal snapshot 汇总到同一条执行结果；真实 Electron 父进程 SIGKILL/restart
    黑盒探针也已通过。最终复核已完成：全量 Vitest 506 个文件/3135 项通过，shared/renderer typecheck、授权环境
    `npm run build`、i18n、owner scan、真实 ChatView DOM reload/窗口重连与 Electron parent restart 均通过。
  - 验收：`npm test`、shared/renderer/electron typecheck、`npm run build`、i18n 检查、owner scan 及新增桌面/远程生命周期测试
    全部通过；报告包含 checkpoint 次数、恢复结果、事件顺序、幂等性与 no-tools/tools 两条主链路证据。

## 不纳入本清单

- Windows/macOS CI 矩阵、签名、公证和发布环境专属验证。
- 需要外部模型账号、远程 IM 账号或第三方服务真实凭证才能完成的联调；本机仍应使用 fake adapter/fixture 完成
  协议和状态机测试。
- 与本计划无关的 UI 重构、性能优化或生成构建产物。
