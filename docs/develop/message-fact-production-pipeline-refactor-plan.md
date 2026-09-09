# 消息事实生产链路统一开发方案

> 状态：实施中；Core、桌面主路径及微信/飞书远程适配已完成阶段性接入，桌面 create/reuse 与远程事实写入 fallback、旧事实事件协议已清理；最终验收仍待真实 Electron IPC/渲染性能采样及跨平台 CI 证据。
> 初稿日期：2026-09-05；本版修订及最终代码复核日期：2026-09-07。
> 评审输入：[开发方案评审](../review/message-fact-production-pipeline-refactor-plan-review.md)。两项阻断意见的设计处理见第 5、7.2、9、12 节；当前实现已取得局部与全量门禁证据，生产 owner 清理仍待复审。
> 需求：[生产链路前置重构需求](../requirement/message-fact-production-pipeline-refactor-requirement.md)。
> 代码基线：工作树 `/Users/space/Documents/Develop/SpaceAssistant/.worktrees/message-fact-persistence-core-refactor`，分支 `codex/message-fact-persistence-core-refactor`，当前 HEAD `679be46`，基于本地 `main` `1f6e794`，**包含未提交改动**。
> 优先级：新需求及本文的实施决策覆盖[旧 Core 方案](message-fact-persistence-core-refactor-plan.md)中的冲突部分；不在旧方案上继续叠加另一条事实写入路径。

## 1. 结论与实施边界

沿用现有 `runToolChatSession` 作为唯一生产执行循环，把它的事实输出从 WebContents/远程 hooks 改为规范化事件；由应用级唯一 `TurnCoordinator` 创建消息、聚合、checkpoint、终止和恢复。桌面、微信、飞书共享同一投影协议，渠道只保留输入、确认交互和出站展示。

不重写工具执行器，不重写权限系统，不引入事件数据库、通用事件总线、工作流引擎、跨进程锁或工具自动重放。现有 shared reducer、Coordinator 和 SQLite adapter 是可修改的雏形，不能直接视为已完成基础设施。

此次前置工作实际上已经覆盖旧 Core 方案的大部分消息所有权目标。完成后应核销旧工作包，不能再实施“流结束 append assistant”“renderer 保留事实 reducer”等相反设计。

## 2. 当前代码核对结果

下表引用路径均相对本工作树，以符号为定位依据，避免沿用旧文档已漂移的行号。

| 位置 / 符号 | 已存在的行为 | 对开发方案的影响 |
| --- | --- | --- |
| `electron/claudeStreamHandlers.ts::registerClaudeStreamHandlers` | 只注册 `claude-chat-create-with-tools` 和 cancel；接收 `sourceMessages/currentUserMessageId` 或旧 messages，然后调用工具循环 | 普通独立 IPC 流已不在此处；不要再造普通流 source |
| `electron/chatStreamService.ts` | 当前工作树不存在 | 需求清单中的历史路径改为调用点审计项，不新增同名空壳 |
| `electron/toolChatLoop.ts::runToolChatSession` | 同一循环管理模型轮次、确认、工具和 usage；新增 prepared shell / registered tool 分支；仍直接发事件、调远程 hooks、检查 WebContents 存活 | 保留执行算法，替换事件出口和生命周期控制 |
| `src/renderer/components/Chat/ChatView.tsx::sendInternal` | renderer 构建上下文、技能路由与 system；生成 assistant id、append、聚合正文/thinking、终态 patch | 不只是替换 IPC：上下文及事实相关技能处理必须移到主进程 |
| `messageMutationGateway.ts::prepareSendContext` | 创建 user id 并 append；reuse 返回 UI 侧上下文 | 新发送改交 TurnIntent；保留显式编辑/删除 gateway |
| `ChatView.tsx::enqueueChatMessage/drainQueueForSession` | renderer 创建 queued user，再把 queued patch 为 sent 后复用 | 排队创建与认领也必须归 Core，避免正常发送之外遗留 owner |
| `chatRunnerService.ts` | live/Redux/API overlay、多会话运行登记、rAF 合并、流式持久化混在一起 | 保留展示和运行索引；删除新 turn 的持久化计时器和 flush。当前所谓 2 秒节流实际反复重置 timer，属于 debounce，持续输出可能一直不落库 |
| `chatToolSessionService.ts::createToolChatController` | 在 renderer 维护 ToolCallRecord，确认按钮会乐观改事实；保存 raw/rawDelta、MCP、diff 等字段 | 字段迁入 reducer；仅保留确认按钮请求态和 UI 副作用 |
| `wechat/…CommandRouter.ts`、`feishu/remoteCommandRouter.ts` | append user/assistant；有窗口发 agent-done 交 UI 补写，无窗口自己 patch summary | 同一渠道存在两种事实结果，切换时两个分支必须一起删除 |
| `electron/remote/imRemoteAgent.ts` | 两个远程渠道已复用此执行服务；自行取历史、拼 API 消息、提取最后一轮 summary；无窗口伪造 sender | 应复用这个接入点，不再各建一套远程 source |
| `wechatRemoteStreamService.ts`、`feishuRemoteStreamService.ts` | 收 start 后先异步读 DB 再订阅 delta；done 拼终态并 patch | 首 delta 存在订阅竞态；改为应用级投影订阅，无事实补写 |
| `src/shared/assistantFactAggregator.ts` | 已有事件 union/reducer；字段较少，skill hint 通过 createId 生成，部分分段切换不闭合 | 补确定性事件与字段覆盖，不能只迁移当前简化实现 |
| `src/shared/turnCoordinator.ts` | 已有 prepare/execute/consume/cancel/recovery 雏形 | execute 仍接收 source 返回 Message，consume 每事件 checkpoint；必须收紧唯一事实入口 |
| `electron/turnCoordinatorStorage.ts` | findByRequestId 恒返回 undefined；消息批量 append 与 saveTurn 分开 | 持久幂等与完整 prepare 原子性尚未实现 |
| `electron/database/schema.ts` / `operations.ts` | 未提交 v5 turns 表已有 `(session_id, request_id)` 唯一键；没有 version、user 关联、outcome | 增量扩展现有表，不再创建第二张运行表 |
| `electron/appIpc.ts` / `main.ts` | IPC 注册时创建 Coordinator 并 recover；main 先做 legacy streaming cleanup；renderer 可调用 consume/recover，缺 execute/projection | 移到应用启动装配；删除生产 consume/recover IPC；只保留内部消费与启动恢复 |

### 2.1 rebase 增量与本次核对范围

对比上一版 HEAD 与当前 HEAD，新增 `004a906 feat(shell): optimize run shell execution lifecycle` 和合并提交 `1f6e794`，涉及 124 个文件。此次重新检查了相关 diff、工具执行/确认/取消/结果代码，以及排队、上下文、数据库、Coordinator 雏形；未把“文件存在”视为生产路径已全部接通。

- `toolChatLoop` 现在优先执行 `executePreparedShellExecution`；非 prepared 的 registered tool 走 `executeRegisteredTool`；其他执行器保留旧 execute 分支。source 必须包装这三条现有工具执行分支，不能用 registered tool 统一调用把 Shell 重新 plan 一次。
- `runShellPlan.ts`、`preparedShellExecution.ts` 已提供封存计划和 `PLAN_STALE` 检查；`toolInvocationCoordinator.ts` 管单次工具 invocation，**不等于消息级 TurnCoordinator**。两者生命周期嵌套，不合并职责。
- `runShellExecutor.ts` 已接进程树终止、有界输出、rawDelta 收尾及结构化 result.data；`shell/executionLifecycle.ts` 有自己的终止竞争规则。turn 终态不能覆盖或重新推导工具终态。
- `normalizeExternalToolName` 已在模型工具边界把 Bash 规范为 run_shell；确认 memoryTiers 改由 `recordUserAnswerFromDecision/FromMemoryTiers` 校验。新增的 `ConfirmationAuthorizationRegistry`、`projectPreparedShellExecution` 有实现/测试，但当前主 tool loop 不因此等同于已全部使用 permit/plan 投影的新链路；本方案不承担补齐另一轮 Shell 架构迁移。
- `package.json` 新增 `test:shell-lifecycle`，CI 新增 Windows/macOS Shell contract job，应纳入本次事件出口迁移的回归。
- 本轮 rebase 没有改写排队/上下文选择，也没有完成未提交的 Core 事务/幂等草稿；下节所列缺口经最新代码复核仍成立。

排队评审中的一句代码假设需要修正：`ChatView` 在调用模型前 append streaming assistant，`appendMessage` 当时就分配 sequence，`updateMessageContent` 不改变 sequence。因此不是“A 完成时才取得更大的 sequence”。但 B、C 提前入队后，B 的 assistant 会晚于 C user 插入，物理顺序可以是 `A.user、A.assistant、B.user、C.user、B.assistant`。评审指出的**上下文边界与因果顺序缺口仍成立**，不能只修正文案而不改算法。`resolveRetryContext` 当前仍按 failed assistant 之前最近的 eligible user 回查，连续排队后也可能选错 user，这属于本次一起修正的关联缺口。

### 2.2 现有雏形必须先修正的具体问题

1. `appendMany` 的事务仅包含消息；之后 `saveTurn` 失败会遗留两行。必须将 user、assistant、turn、sequence 更新纳入同一事务。
2. `execute` 闭包持有 prepare 时的 `current`；consume 替换 Map 后，异常/无 Message 结果可能使用旧空正文终止。取消后 source resolve 仍可能把 terminal Map 覆盖成 completed，即使 DB 的 streaming 检查拒绝了写入。
3. `updateMessageContentIfStreaming` 是先读状态再调用通用 update，缺 expected version；checkpoint 回调也不检查提交结果。应使用事务内状态/version 条件写，而非仅添加函数名。
4. `recover()` 只改 Message，不同步 turns/outcome/version；随后仅 restore streaming 行通常已无对象可恢复。启动 cleanup 与 Coordinator recovery 重叠。
5. `consume()` 对无效事件仍递增 version/写库；重复文本事件没有序号去重；source 返回最终 Message 的兼容兜底已删除，剩余 consume 的事务/version 完整性仍需持续复核。
6. reducer 在 thinking→content、tool-use 边界没有完整闭合；缺 raw terminal scrollback、确认元数据、依赖恢复、拒绝状态等生产字段。

这些是静态阅读得出的实现缺口，本次文档任务未运行测试，不能据此宣称现有测试失败或通过。

## 3. 最小模块调整

| 模块 | 责任与做法 |
| --- | --- |
| 新增 `src/shared/turnTypes.ts` | 聚合公共 TurnIntent、snapshot、outcome 类型；移出 aggregator 内的 IPC 类型，消除 Record/unknown 占位 |
| 修改 `src/shared/assistantFactAggregator.ts` | 纯事件 reducer；只处理事实和工具状态，不接 IO/随机函数 |
| 修改 `src/shared/turnCoordinator.ts` | 保留可注入依赖的实现位置；只有主进程实例化。不要为“Core 在主进程”再复制一个类 |
| 新增 `electron/modelEventSource.ts` | 单一生产 adapter，包装现有 tool loop；输出规范化事件和 usage，接收 AbortSignal |
| 新增 `electron/turnContextBuilder.ts` | 按第 5 节的高水位和 turn 关联读取/排序上下文；复用附件、vision、技能/system；输出 source 配置。纯选择算法放 shared，作为现有 context helper 的小范围提取 |
| 修改 `electron/turnCoordinatorStorage.ts` | 强类型事务端口，替换可选 append/update 拼接方案 |
| 新增 `electron/turnRuntime.ts` | 装配一个 Coordinator、source、投影订阅和生命周期清理；注入 appIpc 与远程 router |
| 新增 `src/renderer/services/turnProjectionService.ts` | 应用级单次订阅、版本过滤、完整 snapshot 替换、重连校准；复用现有 Redux/display/live 路由 |

不新增按渠道命名的 Coordinator、普通聊天 Coordinator 或通用 Repository 框架。源内部仍可保留 `messagesForApi` 供多轮调用，这是模型协议上下文，不是消息事实。

## 4. 协议与事件设计

### 4.1 TurnIntent 和信任边界

沿用需求的 `create-user/reuse-user` union。`ChatInput` 至少包含 `text` 和现有 `ChatImageAttachment[]`；不能只保留文本。`TurnConfig` 使用显式字段：模型/service 选择、maxTokens、thinking、locale 和已有会话级选项。工具配置、权限、工作目录及 remote lane 来自主进程可信依赖，不能让 renderer 用 config 声称自己获得远程/本地权限。

- create：Core 生成 user/assistant/turn id。renderer 可以生成 requestId、附件上传请求 id，但不能生成权威 Message id。
- reuse：校验 user 存在、同 session、role=user、status=sent；重试使用新 requestId，复用 user，只新增 assistant。
- exclude：校验每个 id 属于该 session，不能排除 required current user；排除只作用于本次上下文，不删除数据库历史。
- `(sessionId, requestId)` 是持久幂等键。重复相同意图返回原 turn；相同键但输入、reuse 目标或执行配置不同，返回冲突，不默默执行另一份内容。保存规范化 intent 指纹以检查冲突，不记录 API key。
- source/renderer 不能提交 `sourceMessages`、最终 Message、assistant id 或 ToolCallRecord。
- prepare、execute、cancel、查询与确认均沿用并补全 session/request 的调用方归属校验；token 只是执行防重凭据，不能替代权限校验。

### 4.2 两阶段 API

```ts
// 示意签名；Message/Usage/附件复用仓库已有类型。
chatPrepareTurn(intent: TurnIntent): Promise<PrepareTurnResult>
chatExecuteTurn(args: { turnId: string; startToken: string }): Promise<ExecuteAck>
chatCancelTurn(args: { turnId: string }): Promise<TurnSnapshot>
chatGetTurnSnapshot(args: { turnId: string }): Promise<TurnSnapshot>
chatListActiveTurns(args: { sessionId?: string }): Promise<TurnSnapshot[]>
chatOnTurnProjection(listener: (event: TurnProjection) => void): () => void
```

PrepareTurnResult 用判别 union 区分 `{ kind: 'prepared'; prepared: PreparedTurn }`、`{ kind: 'existing'; snapshot: TurnSnapshot }` 和明确的拒绝原因；终态重试只返回 existing，不能为了满足返回类型签发可执行 token。PreparedTurn 带需求中的 ids、userMessage、assistantMessage、version、startToken，并补充两条消息的数据库 sequence，供现有 DisplayOrder/API baseline 对齐。snapshot 包含 state、完整 assistant Message、version、persistedVersion，terminal 额外带 outcome/error/最终 usage。startToken 仅返回给发起方，不随广播或远程出站发送。

执行顺序：先挂全局订阅 → prepare 事务提交并返回 → renderer 应用 prepared snapshot → execute → source 才启动。prepare 可广播 started；广播和 invoke 返回都按 id/version 做 upsert，不能追加两次。同步 fake source 在 execute 内发出的首 delta 也不得早于 prepare promise 已被调用方接收的阶段。

execute 立即返回运行接受状态，不占用一个贯穿整轮的长 IPC promise。最终 usage 的唯一主动分发位置是持久化成功后的 terminal projection；execute ack 不再携带最终 usage。terminal 查询是同一已保存结果的重取，不是第二次累计计费事件。

startToken 在内存中保存，建议初始有效期 60 秒，prepare 重试在有效期内返回同一 token；过期 prepared 统一 timeout，不创建新消息。首次 execute 原子标记已消费；同凭据重复执行返回当前运行/终态，不能再次启动 source。重启后旧 token 失效，不自动发新 token 重跑旧 turn。

### 4.3 规范化事件

采用同步 `emit(event)` 回调，不引入 EventEmitter 总线和异步迭代队列双轨。source 接收 Coordinator 提供的 turn 关联信息；适配器给事件分配单调 `eventSeq` 和时间，Coordinator 串行处理。

事件 envelope：`{ turnId, requestId, sessionId, eventSeq, at, ...payload }`。消息 id 不由 source 生成。skill hint 使用稳定 `hintKey`，Core 由 turnId/hintKey 生成 id，reducer 只接受确定值。

| 事件 | 需要覆盖的数据/规则 |
| --- | --- |
| content-delta / thinking-delta | text；SDK block 边界需要时转换成 content/thinking segment-closed，避免同类型相邻 block 被错误合并 |
| tool-use | toolUseId、规范化 toolName、已解析 input、riskLevel、MCP 元数据；Bash→run_shell 复用现有边界转换；originalToolName 仅诊断。不再让 renderer 推断风险 |
| confirm-requested | toolUseId、confirmId/类型及现有 diff、shellSecurityHints、autoApproveFallback、currentPageUrl、dangerInfo、sessionTrustedHint、MCP、实际 memoryTiers 信息；不透传 permit/执行计划凭据 |
| tool-confirmed | toolUseId、approved、decisionAt、结构化拒绝原因；批准不等于工具完成 |
| tool-progress | toolUseId、工具级 seq；保留 message、raw 替换、rawDelta 追加三种互斥语义 |
| tool-result | 完整现有 ToolCallResultPersisted；包含 dependencyRecovery、autoApprovedWrite、完整 Shell result.data（见第 6.4）；明确 completed/failed/rejected，不依赖中文错误字符串猜状态 |
| skill-hint | 稳定 id/key、text、shownAt；包括初始技能提示和运行中变更 |
| source-completed / failed / cancelled / timeout | outcome、结构化 error、最终 usage；只送事实 reducer/Coordinator，不附最终 Message |
| usage-progress | 现有 usage 类型及 projected 标记，只更新用量投影，不扩展 Message usage 字段 |

确认请求和已接受决策复用现有 `mapLegacyConfirmation`、pending memoryTiers 和受限记忆写入口。reducer 记录“确认了什么”，不能签发/消费 permit、调用记忆写入或将历史 snapshot 当作新授权。

依赖修复请求先保存在 tool-result 对应字段，再由 UI 展示指引；修复后是否重试沿用现有用户交互规则，不自动重复工具副作用。确认卡片订阅/发送仍走现有确认设施，但只有确认设施接受的决策才产生规范化确认事件。

### 4.4 reducer 规则

复用 `contentSegments.ts`、`thinkingSegments.ts`、`terminalScrollback.ts` 中的纯逻辑并显式传事件时间，不再调用 Date.now/randomUUID。维护 Message 与最少 reducer 元数据：lastEventSeq、工具进度 seq、已处理 hint key；不保存完整事件历史。

- content 关闭正在进行的 thinking；thinking 关闭正文；tool-use 关闭两者；terminal 关闭所有开放段。时间用 `undefined` 判断未关闭，不能把 0 当作未设置。
- 重复或倒退 eventSeq、工具 seq、重复 tool-use/result、unknown tool id、终态后事件诊断并忽略。忽略事件不得增加事实 version 或触发 checkpoint。对于 envelope 序号合法但 payload 因 unknown tool 等原因被忽略的事件，仍推进传输接收游标；usage-progress 和 finishing 期间被过滤的合法 envelope 也推进游标，避免下一条正文被误报缺口。重复/倒退 envelope 不推进。
- 文本事件序号出现缺口属于内部生产协议错误：停止该 source 并统一失败，不能悄悄丢正文。投影版本跳跃则合法，因为投影可以合并。
- 工具终态不再接受进度/确认覆盖。取消、超时先按第 6.4 节接收已在途工具的有界清理结果；只有没有真实终态结果的工具才标 failed/interrupted。恢复沿用 legacy 中断语义，但不伪造进程树已终止的结论。
- 统一清理确认展示字段，保留自动批准写入 diff 等现有结果语义；`duration/startedAt/completedAt/confirmedAt` 从事件确定。
- `Message.status` 继续使用 completed/failed；取消/超时/恢复的区别放 `TurnOutcome`，不向领域 Message 新增一套状态。
- 空成功输出保留空 content、completed；远程“任务已完成”是渠道展示兜底。异常保留 partial content，error 单独投影，不能把渠道错误提示写成模型正文。

## 5. 上下文与技能处理迁移

### 5.1 三种发起方式的上下文高水位

`context_boundary_sequence` 固定表示 **prepare/claim 事务中、插入本次 assistant 前，session 内已存在消息的最大 sequence（空库为 -1）**。它是候选历史上界，不是 current user sequence，也不是完成时间。重试同一 request 直接返回原 turn，不能重新取高水位。事务内先确认该 session 无其他活动 turn，因此前序 turn 已完成 finalize；queued 行虽然可能落在高水位以内，仍由资格过滤排除。

| 发起方式 | 记录边界的时刻 | required user 与历史规则 |
| --- | --- | --- |
| create-user | 原子插入 sent user 后、插入 assistant 前读取 H | required user 在 H 内；保留 H 内符合资格的历史，排除其他 queued 和本 assistant |
| prepareQueuedTurn | 等前序 turn 终态提交后，在认领事务内、插入 assistant 前读取 H | required user 是被认领项；读到前序 assistant 的最终内容，即使它在该 user 入队之后才完成；其余 queued 不参与 |
| reuse-user / retry | 校验既有 sent user 后、插入新 assistant 前读取 H | 保留 H 内符合资格的历史和显式 exclude 规则；不改成“截断到旧 user/失败 turn”，也不新增分支会话语义；required user 按下面的因果顺序恰好一次 |

本轮保留当前 retry 的“现有历史 + 显式排除失败 assistant”语义，**不擅自删除旧目标之后的已完成对话**。如果未来需要“回到旧节点重开分支”，应作为独立产品需求。对于 Core 管理的失败 assistant，`resolveRetryContext` 必须先通过 `turns.user_message_id` 找 user；不能继续用“sequence 最近的前一个 user”误选排队项。只有无 turn 关联的 legacy 消息才沿用既有回查规则，关联完整的新消息不得回退猜测。

### 5.2 候选筛选与因果排序（不修改消息的展示 sequence）

高水位只解决成员范围，不能解决 B、C 提前入队造成的交错。最小实现是复用本方案第 6.1 节已计划增加的 turns.user_message_id 关联，给 API 历史派生排序键，**不新增第二套持久化 sequence、历史快照表或消息重排 UPDATE**。

1. prepare/claim 事务内保存 H；之后 builder 在一次同步读取阶段取得 `sequence <= H` 的候选消息及所需 turn 关联，将选中的 Message 复制到本次执行内存。异步附件/技能调用在此后进行；不跨 await 持有 SQLite 事务。prepare 获得 session 执行权后，不允许另一个发起者抢占会话，读取期间仍为 queued 的消息不因之后认领而混入本次列表。
2. 复用 `isMessageEligibleForChatApi` 的角色/状态规则；排除本 assistant、所有其他 queued/streaming、明确 exclude 的消息。关联的 assistant 还须对应 terminal turn，防止读到草稿不一致状态。failed 历史仍按既有规则可参与，只有指定的失败重试目标被排除，不一刀切删除全部 failed。
3. 对 user 派生 API 排序 anchor：若存在有明确 user 关联的首次 turn，取该 turn assistant 的物理 sequence；否则回退 user 的物理 sequence。user 排序键为 `(anchor, 0)`；assistant 为 `(自身 sequence, 1)`，id 仅作稳定兜底。首次 turn 按最小 assistant sequence 确定，即使该 assistant 被 exclude 也不改变 user 的 anchor；重复 retry 不移动历史 user 的位置。
4. 这样队列 B 的 user 会与其第一次执行的 assistant 排在一起，提前排队的 C user 不会插进 B 的问答之间。普通 create/reuse 都使用同一派生排序，避免只修 C 执行时、后续普通发送又恢复物理乱序。排序只是 API 输入策略；UI 时间线、搜索分页和数据库 sequence 保持原有展示语义。
5. required user 从 DB 校验并去重，恰好出现一次；queued 首次执行时，其 anchor 是本次 assistant 的 sequence（大于 H），这是**仅排序时使用的关联**，不意味着把本 assistant 作为历史内容纳入。复用 user 沿用首次关联 anchor；不硬把重试旧 user 移至历史末尾。
6. 排序后复用既有 `trimClaudeToolChatMessages`、附件转换与 pairing 逻辑，裁剪前需取得完整候选顺序或等价的最近候选查询。当前 `getApiContextBaseline` 实际取“最早 500 条”，不能直接复用它作为完整基线并丢掉最近完成的 A/B。当前 `trimClaudeToolChatMessages` 仅保留尾部 N 条，不能保证位于旧历史中的 required user 不被裁掉：给该 helper 增加可选 requiredUserMessageId 参数，未传时保持原行为；传入时优先固定 required user 对应的 API user block，再以最近优先选择其余完整文本或 tool-use/result 组，按派生顺序输出并重新配对，丢弃最旧的非必需组直到符合上限。不得在裁剪结束后随意 append 旧 user 从而改变其顺序，也不能为容纳 required user 留下半个工具组；required block 自身超过 token/附件限制时明确报上下文构建失败。对长历史测试最终 SDK payload，而不只测裁剪前数组。

只提取 `apiContextService` 内可用的过滤/去重逻辑，并为新的 Core 因果排序增加纯函数；不原样搬走目前只按 DisplayOrder 排序的 `buildHistoryForApiFromEntries`。legacy 数据没有可证明的 turn 关联时保持物理顺序，不按 timestamp 推测历史问答关系。

固定示例（数字是不可变的物理 sequence）：

| 时刻 | 数据库事实 | 执行上下文应满足 |
| --- | --- | --- |
| A 运行中 | A.user=0，A.assistant=1 streaming；B.user=2 queued，C.user=3 queued | B/C 不进入 A 的已构建请求 |
| A 完成，认领 B | A.assistant 仍为 1，更新 completed；H_B=3；B.user→sent，B.assistant=4 streaming | B payload 严格为 A.user、A.assistant 最终正文、B.user；无 C、B.assistant |
| B 完成，认领 C | B.assistant=4 completed；H_C=4；C.user→sent，C.assistant=5 streaming | C payload 为 A.user、A.assistant、B.user、B.assistant、C.user；不会按物理 sequence 把 C 插在 B.assistant 前 |
| C 完成，普通发送 D | D.user=6，H_D=6；D.assistant=7 | D payload 仍为 A、B、C 三组完整历史再 D.user，验证排序不是一次性排队补丁 |

### 5.3 执行配置与副作用范围

整体顺序：校验 intent/session/reuse → prepare 原子写占位及 H → execute 读取并固定候选 → 按上述规则筛选/排序/裁剪/配对 → 附件与 vision 路由 → 技能/system/wiki 拼装 → source。构建失败进入原 assistant 的 failed terminal，不把 user 退回 queued 自动重跑。

桌面技能路由、system 拼装、wiki schema 和技能提示生成从 ChatView 迁入 builder 或其现有服务调用；复用策略，不重设推荐算法。纯 `/skill` 命令若不启动模型仍走原命令处理，system 提示消息作为非 turn mutation 单列审计。技能路由若自身需要模型调用，应位于 execute 的可取消阶段，不能在 prepare 之前启动后台模型。

保留现有附件文件权限/归属校验与大小限制。`attachments/imagesDeliveredToApi` 的原有读写语义列入 golden fixture；当前发送链没有明确赋值的字段不借此新增“已送达”推断。视觉模型最终选择由主进程确认，renderer 的估算仅用于提示。

同 session 同时最多一个 prepared/executing/waiting-confirm turn，由 Core 串行入口检查；并行上限沿用现有配置，不只依赖 UI `runningSessions`。不同 session 可并行，不扩展成通用任务调度。session 有未认领的队列项时，新 create 应入队而不是越过队首；显式 retry 返回 session busy/queue pending，由用户先处理队列，不隐式改变 FIFO。重复请求的查询应在 busy 检查之前进行，已存在请求不能因自己占用会话而被误拒。

## 6. 存储、checkpoint、终态与恢复

### 6.1 最小存储契约

把 `TurnStorage` 的可选 appendMany/updateIfStreaming/saveTurn 替换为必需业务事务操作：`prepareTurn`、`findTurnByRequestId`、`checkpointTurn`、`finalizeTurn`、`listUnfinishedTurns`、`getTurnSnapshot`，以及第 7.2 节的 enqueue/claim/cancelQueued 同步事务。继续使用现有 SQLite 连接、事务 helper、Message codec、sequence 和 db.save 行为。

在 v5 基础上增加 v6 migration（即使本地 v5 尚未提交，也应支持已运行 v5 的开发数据库）。扩充 turns：

- `user_message_id`：复用和重复 prepare 返回 user；历史 v5 允许空，不能按相邻 timestamp 猜绑定。
- `version`：最后持久化事实版本，初始 0。
- `outcome`、`error_json`、`terminal_usage_json`：查询/重启后可返回同一 terminal，usage 不加到 Message。
- `intent_fingerprint`、`context_boundary_sequence`：冲突检查及第 5.1 节定义的 H；历史记录可空。
- `queue_input_id TEXT UNIQUE REFERENCES queue_input_requests(id)`：只在首次 queued claim 时填写，一条入队请求最多对应一个首次 turn；显式 retry 留空，通过 user_message_id 复用 user。
- 为 user_message_id 建普通索引，用于因果排序与精确重试查找；不要建 user_message_id 唯一键，否则会禁止合法重试。
- state 限定 prepared/executing/waiting-confirm/terminal，复用 created_at/updated_at。

迁移先创建回执表，再给 turns 增加可空关联和索引；唯一约束需兼容多条 NULL（非队列 turn）。同一 v6 migration 创建第 7.2 节确定的 `queue_input_requests` 回执表；它只保留入队幂等/删除回执，不保存输出或调度任务。不存 SDK 对象、工具运行句柄、凭据或 startToken 明文，不为自动重跑保存完整执行配置。迁移须覆盖新库、v4→v6、已有 v5、重复迁移、事务失败及高版本拒绝。旧 v5 不完整记录启动后 recovered，不伪造缺失 user。升级时对仍 queued 的 legacy user 建立确定的 queue 回执（详见第 7.2），历史 sent 消息不反推入队身份。

### 6.2 原子 prepare

同一 SQLite 同步事务内执行幂等查询/冲突检查、占位插入、sequence 分配、H 记录及 turn 插入。`runInTransaction` 明确拒绝 Promise 回调，所有凭据/附件/模型调用在事务外；消息计数、preview 等现有更新也必须随事务回滚。create 恰好新增 user+assistant 两行；reuse 恰好新增 assistant 一行。唯一键冲突后读取既有 turn 并核对指纹，事务回滚不得留下孤立消息或消耗错误的顺序状态。

所有广播、备份调度、内存 registry 更新均在 commit 成功后发生。不可将会产生外部副作用的通知放入数据库事务。

### 6.3 version 与 checkpoint

区分三个数：Message 的会话排序 `sequence`、source 的 `eventSeq`、snapshot 的事实 `version`。后者每次有效事实变化递增；`persistedVersion` 是 DB 已提交版本，禁止把它当成 UI 版本。

- 文本/thinking 首次变脏后启动固定最长 2 秒 checkpoint timer；后续 delta 不重置。每次写当前完整快照，允许从 version 3 直接持久化到 120。
- 确认请求、工具结果等重要边界可立即 checkpoint；terminal 必须同步提交并清掉待写 timer。
- 事务内检查 turn 非 terminal、assistant id/session/status=streaming、DB version=expectedPersistedVersion，再更新 Message 与 turns.version/state。任一不匹配整体回滚，读取权威状态，不广播伪成功。
- 单 turn 一个串行消费/写入队列；不同 turn 不共享等待锁。snapshot 发出前复制或保持不可变，后续 reducer 不得改变已广播对象。
- 普通 progress 是 Core 的内存权威投影，可以高于 persistedVersion；崩溃时最多丢失尚未 checkpoint 的文本窗口。terminal 则保证与 DB 一致。本文不承诺逐 token 持久化。

### 6.4 单一 finalize

completed/error/cancel/timeout/recovery 共用一个 finalize 函数，但区分“停止新增执行”和“停止接收事实”，不能取消时立即屏蔽所有事件：

1. 首个 turn 终止意图进入 finishing 后，禁止新模型轮次、新 tool-use、新确认和普通文本生成；向现有模型/工具/确认等待传播 abort，冻结当时在途 toolUseId 集合。复用现有 chat/tool signal 注册与清理，不能再注册一组互不联动的 controller。
2. 在有界清理窗口内，**仍接受集合中工具的最后 rawDelta/progress 和唯一 tool-result**，经同一 reducer 更新事实，保留 `runShellExecutor` 的末段 flush、输出文件关闭/校验和、进程树终止证据。窗口内禁止新执行；source-completed 不能将已选择的 cancelled/timed-out 改成 completed。
3. source 完成清理或窗口到期后才封死事实入口，合成尚无真实结果工具的 interrupted 状态，并执行最终事务。清理预算初值 5 秒（覆盖当前 `ProcessSupervisor.terminate` 默认 3 秒并预留输出收尾），用 fake timer 验证；具体工具若已有更严格预算则沿用，不再无界等待。超时仅表明清理未确认，不能伪造真实 Shell result 或 treeKillVerified=true。
4. 同步 emit 在 finishing 期间按事件白名单过滤；避免把“等待 source 结束”放在阻塞其清理事件消费的同一 Promise 链头部。先设状态并释放串行处理，再等待清理，最后重新进入 finalize；否则可能自锁。

事务内更新 assistant 最终 Message、turn terminal/outcome/version/usage，commit 后再发布 terminal。重复 finalize 返回已提交结果；取消与 source 完成竞态以串行队列最先接受的终止原因为准，迟到事件仅诊断。对于不能及时退出的外部工具，终态后继续释放资源，但不再接收其事实，不宣称外部副作用已撤销。

DB 错误不能转换成一次“成功落库的 source-failed”广播。保留待提交快照，停止 source，以既有 busy_timeout 加少量有界重试处理暂态错误；仍失败返回结构化持久化错误并让 UI 进入不可继续发送的异常提示。数据库可用后重试同一事务，崩溃后从最后 checkpoint 恢复；不得新建 assistant 兜底。

Shell 的 `result.data` 原样经规范化、codec、snapshot 传递：`status/exitCode/signal/terminationReason/treeKillVerified/durationMs/stdoutBytes/stderrBytes/outputArtifactBytes/outputArtifactSha256/persistedOutputPath/outputPersistErrorCode/terminationErrorCode/caseId/terminalScrollback` 均纳入测试，其他既有 result.data 字段同样不得因重建对象丢失。进程终止原因以执行器返回为准；工具本身 timed_out/output_limited 不自动等于整个 turn timeout，是否继续模型解释结果沿用现有 loop 和 `shouldStopToolRetry`。TurnCoordinator 的 terminal 幂等不会替换 `ExecutionLifecycle` 的工具级竞争规则。

保留 `planRunShellExecution → executePreparedShellExecution` 及确认后 revalidation；source 不重新规划或绕过 `PLAN_STALE`。`toolInvocationCoordinator` 的 abort race 可能先结束外层 Promise，source 必须按实际执行句柄的清理完成确认结束，不能把 race 返回等同于进程已终止。只补必要的清理完成端口，不重做 registry/permit/policy 体系。

最终提交后调度原有 session 备份、用量更新及标题建议；沿用 `pickToolLoopReturnUsage` 最后一轮/最近有效轮次口径，不借迁移改成累计轮次。usage-progress 继续支持 projected，message_delta 的输出变化应补推；最终用量只由 terminal 消费一次。

### 6.5 启动与窗口生命周期

应用启动顺序：打开 DB/migrations → 创建 runtime → recovery → 开放 IPC/远程接入。将 `main.ts::cleanupStreamingResiduesOnStartup` 的规则收敛到 recovery，禁止两个服务先后改同一批数据。

对所有非 terminal turn，在单 turn 事务中保留最近 checkpoint 正文，关闭分段和在途工具，更新为 recovered terminal；旧 streaming assistant 无 turn 的残留由同一恢复服务兼容处理，不反向伪造 user/turn。terminal Message 对应非 terminal turn 的不一致记录也需修复元数据，不能只查 streaming 行。

“restore 可恢复 turn”在本方案解释为恢复可查询的 snapshot/terminal 身份，并非恢复模型或工具执行。prepared、executing、waiting-confirm 在进程重启后均不自动续跑；用户显式重试用 reuse-user 和新 requestId。

页面切换/ChatView 卸载只退订视图，不取消会话；主窗口 WebContents 真正销毁时，runtime 统一取消由它发起的桌面 turn。远程 turn 与窗口无关，继续运行和落库。正常退出尽力取消并提交，强杀靠下次 recovery。窗口存在性不再决定远程消息内容。

## 7. 渠道切换细节

### 7.1 桌面

1. 应用级启动 `turnProjectionService`，不再每次发送临时绑定事实事件。prepare 返回与 started 广播使用相同 upsert 逻辑，按 sequence 更新 display/API overlay/summary。
2. ChatView 只收集意图、输入附件和展示提示，发送后持有 Core 返回 ids。取消按钮调用 turn cancel，按钮 pending 可本地显示，不能把 Message 改 completed。
3. progress/terminal 用完整 Message 替换 live/Redux 快照。低于当前 version 的数据丢弃；相同 terminal 幂等；版本跳跃无需补 delta。普通 UI 更新保留 rAF 合并，terminal 立即刷新并清除旧排队 UI 更新。
4. `chatRunnerService` 删除新 turn 流式 DB persist/flush，保留多会话路由和 request→session UI 索引。这些展示索引不等于事实 owner，不为追求“零 Map”而删除必要状态。
5. `chatToolSessionService` 删除 records 数组和 applyConfirmOutcome 事实更新；确认发送状态、依赖修复弹窗、自动写文件展示副作用按 turn/tool/version 去重。
6. 重连先订阅再查询 active turns/full snapshot，查询结果也做版本过滤；迟到 DB baseline 不得覆盖更高内存 version。终态后的主动编辑从通用 mutation ack 更新展示，并清除该 turn 的旧 live 缓存，避免永久用旧 terminal 覆盖编辑。

### 7.2 排队消息

#### 7.2.1 固定存储契约：一个小型幂等回执表

仅把唯一键挂在 messages 上不足以处理现有“物理删除 queued user”后迟到的 enqueue 重试：删除行就丢失去重证据。故本版选择 **保留现有 messages 队列 + 一张 queue_input_requests 回执表**；不新增执行队列、调度器或重复存储输入正文。这是支持删除与可靠重试所需的最小持久状态，取代上一版未确定的“可选 messages 字段”。

v6 固定字段如下：

| 字段/约束 | 含义 |
| --- | --- |
| `id TEXT PRIMARY KEY` | Core 生成的入队回执 id，非 Message id |
| `session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE` | 生命周期归属；删除会话时一同清理 |
| `origin_scope TEXT NOT NULL` | 主进程从可信调用上下文生成；本期排队只支持 desktop，格式为 desktop 加稳定本地身份，不能使用随窗口变化的 WebContents id |
| `enqueue_request_id TEXT NOT NULL` | 客户端为一次入队动作生成的 UUID；重试复用，不能在 drain 时重新生成 |
| `user_message_id TEXT NOT NULL UNIQUE` | Core 创建的 queued user id；刻意不加 messages 删除级联外键，取消后的回执仍保留原 id |
| `input_fingerprint TEXT NOT NULL` | 校验同键异载荷，不存第二份文本/附件 |
| `state TEXT NOT NULL CHECK(state IN ('queued','claimed','cancelled'))` | 回执生命周期；claimed 后不再自动变 queued |
| `created_at INTEGER NOT NULL` | 诊断时间；排序/FIFO 使用 messages.sequence，不使用时间戳 |
| `UNIQUE(session_id, origin_scope, enqueue_request_id)` | 完整入队去重作用域；来源必须匹配且跨会话不能误复用 |

首次 queued turn 的 `requestId` 固定由 Core 派生为 `queue:<回执 id>`；与调用方 enqueueRequestId **分离**，通过 turns.queue_input_id 持久关联并唯一约束。普通 create/reuse 外部接口不得自填 queue: 保留前缀，远程入站 request 使用自己的来源命名空间。相同 user 的用户显式重试使用新的非 queue requestId，且不再次填写 queue_input_id。

fingerprint 使用带版本的 canonical JSON 后 SHA-256：`{ v: 1, text, attachments }`；text 按实际存储规则 trim，不折叠内部空白或擅自 Unicode 归一化；附件保留顺序、使用主进程校验过的完整附件引用（以当前 ChatImageAttachment 为准：id/stagingKey/fileName/mimeType/byteLength，以及存在时的 width/height），对象 key 排序，缺省附件统一为空数组。session/origin 不再重复进输入 hash，已由唯一键限定。未知输入字段拒绝；请求重试先做身份与格式校验，再查回执并比对 hash，已完成/已取消请求不因附件后来被清理而被误当成新请求。只有新请求或即将执行时才再次检查附件可访问性。若用户通过合法编辑修改了 queued Message，保留最初 enqueue fingerprint 用于请求身份核对，重复 enqueue 不覆盖编辑；claim 从 DB 读取当前已编辑内容并纳入 turn fingerprint。

config 不纳入 enqueue fingerprint：保持当前“出队时使用会话当前模型/配置”的行为。首次 claim 由主进程解析当前会话执行选项并冻结到 turn runtime/intent fingerprint；prepareQueuedTurn 不让调用方传一个新的 TurnConfig。重复 claim 先查既有 turn，不能因设置后来改变而冲突或重建 turn。崩溃后不会重新执行，因此无需为此持久化含凭据的完整配置。

#### 7.2.2 API、状态与重试结果

```ts
chatEnqueueUserInput(args: {
  enqueueRequestId: string; sessionId: string; input: ChatInput
}): Promise<QueueInputSnapshot>
chatPrepareQueuedTurn(args: {
  sessionId: string; queuedMessageId: string
}): Promise<PrepareTurnResult>
// 复用现有 queued 删除 IPC 名称，底层改为以下原子取消语义。
```

QueueInputSnapshot 是判别 union：queued 带 receiptId、enqueueRequestId、Core 派生 turn requestId、完整 user+sequence；claimed 带同一关联与现有 TurnSnapshot；cancelled 带 receiptId/userMessageId，不返回可发送消息或 token。首次 claim 和同进程 prepared 重试返回 prepared/token，executing/terminal 返回 existing snapshot；session busy、非队首、已取消、归属不符各用明确结果，不混成“重试创建”。

| 原状态与调用 | 原子操作与结果 |
| --- | --- |
| 无回执，enqueue | 检查 session/队列上限，事务内插入 queued user 与 queued 回执；commit 后返回。第二次插入失败两者都回滚 |
| 已有回执，相同键+相同 fingerprint，enqueue | 直接返回 queued/claimed/cancelled 当前状态；不新增消息，不将已认领 user 改回 queued；即使队列已满也应先命中幂等 |
| 已有回执，相同键+不同 fingerprint | `QUEUE_INPUT_CONFLICT`；原消息、回执、turn 完全不变 |
| queued，首次 prepareQueuedTurn | 同一事务确认无活动 turn、目标是 session 的最小 queued sequence；认领 queued→sent、记录 H、插入 assistant/turn 并关联回执，回执→claimed；任一步失败全部回滚 |
| claimed，重复 prepareQueuedTurn | 通过 queue_input_id 读取原 turn，返回其 prepared/executing/terminal 当前状态；不再要求 Message 仍是 queued，不重新取 H/配置 |
| queued，取消 | 同一事务回执→cancelled、物理删除 user、维护 session count/preview；不删除回执。同一取消再次提交成功幂等 |
| cancelled，enqueue 重试或 claim | enqueue 同载荷返回 cancelled；claim 返回 QUEUE_INPUT_CANCELLED；不复活消息。重新发送需要新 enqueueRequestId |
| claimed，取消 queued | 返回 MESSAGE_ALREADY_CLAIMED，并附已存在 turn 的关联供 UI 校准；不能在此删除 user。用户若要中止，显式调用 turn cancel |

数据库事务不能 await 配置/网络；异步配置准备若确有需要，先做无写预检，再回到同步事务重查幂等、队首与 busy。两次 claim 的竞争以事务+唯一 queue_input_id 为最终保证，不依赖 renderer 的 draining ref。队列容量使用现有 `MAX_CHAT_MESSAGE_QUEUE_SIZE`，在 Core 新增事务内检查。

#### 7.2.3 响应丢失、恢复及 legacy 数据

- enqueue commit 前失败：无消息/回执；同 key 可安全重试。commit 后响应丢失：同 key 返回原 queued；若期间已认领，返回 claimed/原 turn。窗口重开首先查询 DB 队列/active turn，不按编辑框残留自动再提交；未收到响应时客户端在该待提交项生命周期内保留原 enqueueRequestId，用户明确新发才换 key。不引入 renderer 持久消息日志。
- claim commit 前失败：user 仍 queued，assistant/turn 不存在；commit 后响应丢失：按 queuedMessageId 可命中回执和已创建 turn，不能只调用 getNextQueuedMessage 就假定上次未开始。
- 进程重启：queued 回执仍排队；claimed 对应未完成 turn 先由 recovery 标 recovered，再返回同一个 terminal，**不自动退回队列**；显式重试才创建新的 reuse turn。cancelled 回执继续阻止迟到重试。
- v6 迁移为每条 legacy queued user 创建 `id=legacy:<messageId>`、`enqueue_request_id=legacy:<messageId>`、受控 legacy origin_scope 的回执和 canonical input hash。reserved legacy 前缀不允许外部 enqueue 创建；主进程按真实 queuedMessageId 解析并允许本地 UI 认领。migration 和记录关联均幂等；不给历史 sent/failed 消息伪造不存在的 enqueue 请求。
- 回执与 Message/turn 的一致性由同步事务维护：queued 必须指向现存 queued user，claimed 必须能查到关联 turn；发现缺失关联只报存储一致性错误，不能自动再建 user/assistant。回执不包含正文，保留到所属 session 删除；不增加定时清理策略，否则会重新打开迟到重试复活窗口。显式导入只导入 Message 内容，不导入旧设备的回执/请求身份；导入 queued 行由主进程生成本地 legacy 回执后才进入 drain。

仍保留 UI drain 触发方式；窗口重开先 recovery/snapshot 对齐再按现有策略处理队列。通过上述规则保证安全，不增加无人值守自动续跑需求。prepareQueuedTurn 是 Core 内部 create/reuse 事务的薄变体；普通 reuse 仍要求 sent，不能为了出队放宽它的外部校验。

### 7.3 微信、飞书

router 保留入站认证、去重 claim、session 解析、工作目录、remoteContext 和接收回执。通过同一个 runtime prepare/execute，不再 append user/assistant；started/done 的兼容事件只能转发已提交 snapshot 的 ids 和展示信息。

复用 `imRemoteAgent.ts` 作为渠道配置适配器，移除其独立历史构建、最终正文提取和 noop WebContents。`weChatRemoteAgent.ts` 等包装只提供渠道 policy/出站依赖，不能新建事实。

remote progress adapter 订阅权威 snapshot：以已关闭正文段、tool 状态/seq 推进现有进度服务，保留节流和文本格式化；段索引/tool seq 仅用于出站去重，不重新拼 Message。source 中直接调用 remote facts hooks 的路径移除或改为执行设施所需的非事实通知。

owner session 永远是 originSessionId；switch_session 只影响原有 outboundSessionId/工作目录决策。库、桌面 start/progress/terminal 和确认归属使用 origin；发送目的地与 touch 沿用 outbound。执行失败与发送失败分离：远程发送失败不得把已完成 turn 改 failed。

远程 `requestId` 应与已验证的入站去重键稳定关联，可由来源/账号/入站消息 id 派生；不要每次重投递随机生成。processedStore 和 turns 不做分布式事务：崩溃在 prepare 与 claim 完成之间时，重投递查询原 turn，禁止重跑。跨重启出站恰好一次不在本次范围，保留现有发送去重/重试策略并测试不会影响事实。

## 8. 分阶段实施与单 owner 切换

| 阶段 | 主要改动 | 退出条件 | 生产事实 owner |
| --- | --- | --- | --- |
| P0：基线与字段清单 | 保存当前 diff 清单；整理正常发送/排队/重试/远程调用点；录制固定时钟 golden fixtures | 明确 Message/ToolCallRecord 全字段来源，列出合法 mutation；普通流历史路径核销 | 原路径；Core 雏形 IPC 不作为用户入口 |
| P1：事件与 source | 补事件协议、确定性 reducer；给现有 tool loop 三种执行分支注入 sink/signal；保留 prepared shell/确认记忆/清理结果 | 零工具、多工具及 Shell 清理 fixtures 通过；source 无消息写入、生产 SDK 路径只有一个 | 原路径 |
| P2：Core 完整闭环 | v6 turns+queue 回执事务、claim 幂等、H/因果排序、精确 retry、finalize/recovery/runtime；移除公开 consume/recover | 第 9.1 节 Q1–Q9 全部通过；真实 SQLite 失败竞态与明确差异的 shadow 比较通过 | 原路径；Core 只在测试运行 |
| P3：桌面整体切换 | 正常发送、重试、排队、cancel、确认展示一并切到 projection | 桌面 tools/no-tools 同一 Core；renderer 新 turn 零事实写；刷新/窗口销毁正确 | 桌面 Core；未迁移远程旧路径 |
| P4a：微信切换 | router/imRemoteAgent 微信接入及 renderer 微信 bridge 一起改 | 有/无窗口、claim 重试、confirm/cancel/session switch 对齐 | 桌面+微信 Core；飞书旧路径 |
| P4b：飞书切换 | 同上，保留飞书绑定/消歧/授权语义 | 对应飞书回归与四入口参数化通过 | 全部 Core |
| P5：删除旧协议并验收 | 删除旧事实 IPC/renderer reducer/remote 补写兼容层；owner 审计；全量门禁 | 无旧生产 owner，所有门禁有证据，更新两份方案状态 | 全部 Core |

P1 允许临时 sink 将事件转发为旧 UI 协议供原 owner 使用；测试中用固定事件喂旧结果与新 reducer 比较。分段闭合、因果顺序等已确认修复不能以旧结果为 golden，需独立期望值和变更理由；其余字段要求保持一致。**shadow 只在测试内运行，不启动第二次真实模型调用，不让 Core 写生产消息。**

P3/P4 每个入口开关必须同时覆盖发起、订阅、收尾三个位置，并在请求创建时固定 owner；旧远程 renderer bridge 不得接收新 Core turn 后再 patch。开发迁移可以按提交分阶段，发布前需全部通过 P5；不新增面向用户的双模式设置。

切换前等待旧请求结束或显式取消，重启/恢复之后再开新入口；绝不把一个正在执行的 turn 从 Core 中途退回旧 owner。回滚需要兼容 v6 的代码版本，不能直接启动拒绝高版本数据库的旧二进制；不降级删表或丢弃已生成事实。

## 9. 测试设计与验收

采用先失败测试、再实现的顺序；source 用可同步发事件、可抛错、可忽略 abort 后迟到回调的 fake。数据库用实际 `node:sqlite` 内存库与现有测试 helper，不能只依赖 Map mock 验证事务。

| 测试组 | 最低场景与断言 |
| --- | --- |
| reducer golden | content→thinking→content、多 block、多工具轮次；raw/rawDelta 截断；确认批准/拒绝；MCP/diff/security/dependency/skill 字段；固定时间逐字段相等；输入对象不被改写 |
| 协议防重 | 重复文本 eventSeq、倒退 progress seq、未知 tool id、重复 hint/result、terminal 后所有事件；无效事件 version 不增、无 DB 写 |
| prepare/storage | create 两行/reuse 一行；插入第 2 条消息、turn 插入和 sequence 更新各处故障回滚；重复与冲突 request；重启后幂等；跨 session/reuse 非 user 拒绝 |
| execute/生命周期 | prepared resolve 前零 source 调用；同步首 delta；重复 execute 一次启动；token 超时/错误调用者；同步 throw/Promise reject/零 delta/部分输出失败 |
| checkpoint/finalize | 持续 delta 不饿死 2 秒写入；expected version 冲突；cancel 与 done 顺序置换；旧 timer 迟到；DB 提交失败不发 terminal；清理不响应有界退出 |
| recovery/migration | v4/v5/v6；prepared/executing/confirming；message 与 turn 不一致；legacy 无 turn streaming；重复启动不重复变更；不调用工具 |
| 上下文 | required user 必须保留；排除指定 failed assistant；H 与派生因果顺序、长历史、配对、attachments/vision、技能/wiki；精确 retry user 关联 |
| 排队 | Q1–Q9：连续 B/C 队列、稳定回执/turn 关联、跨重启/响应丢失、同键冲突、删除墓碑、FIFO/容量、legacy migration |
| Shell 新基线 | prepared 计划不重复构建、PLAN_STALE、alias/风险/memoryTiers；取消时 final rawDelta/result.data 不丢；工具超时不误标 turn 超时 |
| renderer | 先订阅再 prepare/execute；started 重复；progress 版本跳跃/乱序；baseline 迟到；取消无 patch；重连恢复；手动编辑/删除继续可用 |
| 跨入口 | desktop-tools、desktop-no-tools、wechat、feishu 参数化；同一 fake 事件使 started/progress/terminal/DB 中 id/version/事实字段相同；渠道只比较投影本体，允许回复文案不同 |
| 远程生命周期 | 无 WebContents、执行中窗口关闭、确认中取消、授权撤销、session switch、重投递、出站发送失败；不新增/补写 assistant |

优先扩展现有 `assistantFactAggregator.test.ts`、`turnCoordinator.test.ts`、`turnCoordinatorStorage.test.ts`、`database/operations.test.ts`，新增 source/context/projection 与跨入口集成测试。保留 `toolChatLoop` 的 workdir、shell、MCP、dependencyRecovery、phase2RemoteConfirm、wechatOutboundConfirm、outboundBudget、usage 等回归，替换断言出口，不删除安全语义测试。

### 9.1 排队阻断项的可执行验收用例

这些用例作为 P2 退出门禁，不能只在 UI mock 中验证“required user 一次”。每个用例检查 messages 行数/内容/sequence、回执状态、turn 关联及最后传给 source/SDK 的上下文。

| 编号 | 场景 | 必须断言 |
| --- | --- | --- |
| Q1 | A streaming 时入队 B、C，A 输出由 partial 更新为 final，然后认领 B | H_B 包含 A 的原 assistant sequence；B payload 精确为 `[A.user, A.assistant(final), B.user]`，B 一次，无 C/B.assistant；A assistant sequence 未变 |
| Q2 | 接 Q1，B 完成→认领 C→C 完成→普通 D | C payload 为 `[A.user,A.assistant,B.user,B.assistant,C.user]`；D 保持 A/B/C 因果顺序；物理 messages sequence 不被改写 |
| Q3 | 重试 B 的 failed assistant，此时 C 已执行且物理 C.user 在 B.assistant 之前 | resolveRetryContext 返回 B.user 而非 C.user；同一 B.user 不重复，指定 failed assistant 被排除；H 内的 C 历史按现有 retry 语义保留 |
| Q4 | 同 key 重复 enqueue、附件 key 顺序不同/缺省空数组、文本或附件顺序不同、queued 编辑后原请求重试 | 等价规范化得到同一回执/user；异载荷明确冲突且零写入；合法编辑不被旧请求覆盖；不同 session/origin 不串请求 |
| Q5 | enqueue 成功但响应丢失；稍后 claim 成功也丢响应，重复 drain/重开窗口 | 总计一个 user、一个首次 assistant、一个回执、一个 queue 关联 turn；enqueue 可返回 claimed；claim 返回原 state/token 规则，不重取 H/config、不重复 execute |
| Q6 | 在 user 插入/回执插入、queued→sent、assistant 插入、turn 插入、回执→claimed 后分别注入事务错误；再用同 key 重试 | rollback 恢复正确行数、状态、preview/count；无半认领/孤立 assistant；唯一键冲突由读原记录解决，异载荷不能伪成功 |
| Q7 | queued 取消与 claim 竞争；取消成功后原 enqueue 迟到重试；重复取消 | 只有取消或认领之一成功；取消保留 cancelled 回执、消息不复活；若已 claimed，queued 删除拒绝，turn/user 不被删除 |
| Q8 | 新库、v4/v5→v6、重复迁移；分别重启在 queued、prepared、executing、terminal、cancelled | legacy queued 回执确定且唯一；claimed 未完成 turn 变同 id recovered；不返回 queued/不重跑；session 删除正确清理关联，无外键错误 |
| Q9 | 长历史超过 500 条、必需 user 处于上限之外、后到新消息、FIFO/容量竞争 | 最近 A/B 终态不被旧 baseline 截掉；最终 SDK payload 仍包含 required user 一次且工具配对有效；H 后消息不混入；非队首不能认领，幂等重试不占额外容量 |

现有 `apiContextQueueAndRetry.test.ts` 的图片 fixture 仍使用 relPath/byteSize，与当前 domainTypes 的 stagingKey/byteLength 不一致；新增 Q4/Q9 必须使用真实附件合同，不能照搬旧 fixture 证明附件去重正确。

Q1/Q2 补充“旧入库顺序中的 A.assistant.sequence 大于 B.user.sequence”人工 fixture，验证兼容输入时 H 和派生排序也可工作；但不能将此人工 fixture 写成当前正常生产时序。

### 9.2 rebase 后必须保留的 Shell 回归

- 实际 tool loop prepared Shell 分支只 plan 一次；确认之后 stale 拒绝不 spawn；不能为了统一 source 改走另一套重新 planning 的 registry 入口。
- `Bash` 边界规范化、gate 风险、memoryTiers 可记忆范围、授权撤销维持新基线；新增 projection 不产生缓存写入。保留 `appIpc.confirmResponse`、decisionCacheWriter、IM channel 对应测试。
- Shell cancel 触发 abort 后，执行器 flush 最后 rawDelta，返回含 treeKillVerified/outputArtifactSha256/terminalScrollback 的结果；在 5 秒清理预算内，DB/terminal 完整保存该结果。模拟外层 abort race 先返回、真实清理后完成，不能提前 finalize；模拟超预算，turn 只终止一次、迟到结果不改 DB，且不伪造已终止证据。
- Shell 的 timed_out/output_limited/transport failure 和整体 turn 的 cancelled/timed-out 区分测试；保留 `ExecutionLifecycle` 和 `shouldStopToolRetry` 现有行为，不只检查 success 布尔值。

当前 `vitest.config.ts` 将 shared 测试放 renderer/jsdom 项目，Electron 项目为 node 单 worker；`typeTests/` 当前不存在。公共契约的编译时断言可放 `src/shared/turnContracts.typecheck.ts`，由现有 shared gate 覆盖，不必为一个协议新增独立测试工程。测试 mocks/preload/api/store 必须随协议迁移。

各阶段先运行修改范围的定向测试，再按仓库要求运行全量测试与相关类型检查。最终执行以下已在 package.json 中核实存在的命令：

```sh
npm run test:shell-lifecycle
npm test
npm run typecheck:shared
npm run typecheck:renderer
npm run i18n:check
npm run build:electron:incremental
npm run build
```

rebase 后 CI 已有 Windows/macOS 的 shell-contract job，应继续提供这些平台结果；本地 macOS 测试不能代替 Windows 进程树/编码/计划行为证据。

新环境按仓库要求先 `npm install`，使用满足项目 engines 的 Node；当前 package.json 没有 postinstall 脚本，SQLite 实际使用 `node:sqlite`，不能照搬旧指南宣称安装会编译 native SQLite binding。不要为了文档任务改 lockfile。

若 jsdom/xterm 环境阻断全量测试，记录原始命令、环境、准确失败用例和复现方法，优先修复环境；如必须白名单隔离，限定具体已证实环境用例，补充独立验证及恢复条件，不能排除整个 renderer 项目，更不能以几项 Core 单测宣布最终通过。

实现阶段每个阶段收尾按仓库 code-review-and-quality 技能审查，合并前完成必要审查；本文不提前宣称代码审查或构建通过。

## 10. owner 审计与交付清单

静态检索是导航，最终按生产调用链审查，不使用“全仓不能出现 append”这种误伤编辑/导入的规则。

```sh
rg -n 'chatAppendMessage|chatPatchMessage|appendMessage|updateMessageContent|randomUUID' src/renderer electron
rg -n 'routeStreamPatchMessage|flushStreamPersist|createToolChatController|createContentState|createThinkingState' src/renderer
rg -n 'claude-chat-|tool:use|tool:progress|tool:result|agent-done|consume-turn-event|recover-turns' electron src
```

| 调用点 | 最终允许内容 |
| --- | --- |
| ChatView/send、prepareSendContext | TurnIntent；无 user/assistant id/append/事实 patch |
| ChatView/enqueue/drain | Core 入队/原子 queued prepare；无本地 Message id、queued→sent patch；重试复用 enqueueRequestId，不给 drain 随机生成 turn request |
| ChatView 测试卡片、纯技能 system 提示 | 可保留明确非 turn 用途，注明入口/环境限制，不复用运行 assistant |
| messageMutationGateway | 显式编辑、删除及合法导入；对活动 turn 所属消息的编辑需 Core 检查/冲突返回，不能抢写 streaming |
| chatRunner/toolSession/远程 renderer bridge | snapshot 消费、确认意图与展示；无落库 timer、ToolCallRecord registry 或 done 补写 |
| 微信/飞书 router | session/权限/claim/出站；消息事实通过 runtime |
| toolChatLoop/source | 允许工具配置、会话策略等必要 DB 读和既有非消息副作用；禁止 messages 表读写、append/patch assistant；历史由 builder 提供 |
| appIpc/preload/shared API | prepare/execute/cancel/query/projection；无生产 consume/recover 入口；通用 mutation 保留明确用途 |
| main/recovery | runtime 统一恢复；旧 cleanup 不再独立运行；claimed 队列不自动退回 queued |
| Shell/source/确认 | 保留 prepared plan、受限 memoryTiers 写入和真实 cleanup 结果；两个 Coordinator 不互相替代，snapshot 不构成授权 |

交付时在 `docs/develop` 补 owner 审计表与验证记录，逐项记录保留调用的符号、用途及测试证据；更新本方案和需求状态。性能验证至少记录长文本和大量 shell rawDelta 下 IPC 负载/渲染耗时、checkpoint 次数，先用约 50ms 合并完整 progress snapshot，terminal/确认边界立即发；没有数据证明必要前不增加 patch/replay 协议。沿用 scrollback 限长，不在本轮重建内容存储。

## 11. 与旧 Core 工作包的映射

| 旧工作包 | 新阶段 | 处理结果 |
| --- | --- | --- |
| WP0 Core 生成/聚合/落库 | P1–P2 | 改为原子占位、checkpoint、条件 finalize，废弃结束 append |
| WP1 结构化 delta/usage | P1–P3 | 内部规范化事件，外部权威完整 snapshot；final usage 只在 terminal |
| WP2 renderer 只消费 | P3 | 删除事实 reducer，保留纯展示缓存，废弃“本地聚合即事实” |
| WP3 user 归 Core | P2–P4 | 与 assistant 同一次入口切换，包含 queued user，不拆成生产半迁移 |
| WP4 清理与收敛 | P5 | 保留合法 mutation/UI 索引；删除旧事实兼容协议 |

本次完成定义：四个入口共享同一个主进程 runtime/Coordinator 和 source 协议；任何 started assistant 已在 DB 存在；所有正常与异常终态只更新该行；renderer/远程不生成或补写消息事实；恢复不重跑工具；全量门禁与 owner 审计均有明确证据。满足后才将需求标记完成，并在旧方案中核销对应工作包。


## 12. 本轮评审处理与范围控制

| 输入 | 独立判断 | 本版处理与验证位置 |
| --- | --- | --- |
| P0：排队上下文边界不清 | 采纳问题；校正“assistant 完成才分配 sequence”的事实描述。仅补高水位还不能解决连续 B/C 队列的排序及重试 user 误配 | 第 5 节明确三种边界、统一因果排序和按 turn 关联找 retry user；Q1/Q2/Q3/Q9 验证 |
| P0：enqueue 持久幂等契约未定 | 采纳；messages 唯一列会随物理删除丢失去重证据，故选小型回执表 | 第 7.2 节固定 DDL、作用域、canonical hash、请求关联、重试返回、删除和恢复；Q4–Q8 验证 |
| rebase：Shell 生命周期已有优化 | 必须更新基线；不能按旧代码重建工具框架，也不能假定新增工具基础设施已全部接入生产 | 第 2.1、4.3、6.4、9.2 节保留实际调用链和结果字段，修正取消时过早屏蔽工具结果的问题 |
| 控制设计复杂度 | 必需的持久状态只为幂等/查询/恢复；排序可从已有计划中的关联派生 | 不加新消息排序列、事件日志、输入正文副本、后台队列调度或工具重放；只增加一张支持删除墓碑的小型入队回执表 |

本轮只修改开发方案，未修改评审原文、需求或实现代码。依据为目标工作树最新 HEAD 与未提交代码的静态核对；文档校验不能替代 Q1–Q9、Shell 回归或全量门禁，也不代表已经取得复审通过结论。
