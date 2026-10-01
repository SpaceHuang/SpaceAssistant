# Driver 与 Runtime 生命周期及结果送达改进方案

日期：2026-09-29  
基线：当前本地 `main`；参考 `../analyze/2026-09-29-invocation-lifecycle-review.md`。  
性质：设计方案，不表示已实施或所有风险已在生产复现。

## 1. 目标与范围

让一条用户指令从 Driver 接收、Runtime 执行、会话上下文提交到 Driver 送达结果，都有可追踪、可恢复的所有权和状态。以 turn 作为一条指令的唯一执行身份；SDK 仍可把本次运行称为 invocation，但不为它另造 ID 或独立业务生命周期。会话连续性由 session transcript 承担。覆盖桌面、飞书、微信、管家和内部审批入口；投递改造首先落在已经使用 `DeliveryHub` 的管家链路。

验收目标：

1. 任一入口都能凭固定身份追踪同一 turn；取消、失败、超时和重启恢复有唯一规范终态。
2. 下一轮只读取已提交的 session transcript 版本；前一轮异常不会靠临时扫描 History 决定是否能继续。
3. History 与 UI/session ledger 的跨存储提交失败有明确的“待对账”状态和幂等恢复路径。
4. 离线、降级、取代和重启后的送达决策确定且可审计；对不支持远端幂等或结果查询的 IM 渠道，不承诺外部恰好送达一次。

## 2. 已核实的问题与证据等级

| 编号 | 问题 | 证据等级 | 主要代码 |
| --- | --- | --- | --- |
| L1 | `requestId` 在桌面链路兼作 `invocationId`；部分远端、管家链路缺少 `turnId` 时回退 `sessionId`。跨层身份语义靠调用约定维持。 | 已确认结构现状 | `electron/toolChatLoop.ts`、`electron/runtime/invocationAssembler.ts`、`electron/remote/imRemoteAgent.ts`、`electron/butler/butlerInvoker.ts` |
| L2 | TurnCoordinator、canonical History、session JSONL 分别记终态；提交顺序与跨存储失败需要对账。永久分叉发生率未证实。 | 已确认结构风险 | `src/shared/turnCoordinator.ts`、`electron/toolChatLoop.ts`、`electron/runtime/sqliteAgentHistory.ts` |
| L3 | 下轮 handoff 扫描上一条 invocation History 并做 cutover；最新未完成/不可用流会阻断下轮，failed 流被跳过后若请求仍包含该轮内容也会匹配失败。 | 已确认条件路径；频率待测 | `electron/runtime/sqliteAgentHistory.ts`、`electron/runtime/sessionHistoryCutover.ts`、`electron/runtime/hostedTurnHandoff.ts` |
| L4 | SDK 取消 terminal 写 `payload.status = cancelled`；History 选择按该字段识别，handoff 终态却按可选的 `sessionLedger.reason` 识别。缺 ledger 时同一取消会映射为 interrupted。 | 已确认缺陷 | `packages/agent-sdk/src/turn.ts`、`electron/runtime/sqliteAgentHistory.ts`、`electron/runtime/hostedTurnHandoff.ts` |
| L5 | handoff 将不同 cutover/History 失败折叠为相同错误文本，诊断仅记简短 reason，缺前序 invocation、快照版本和阶段关联。 | 已确认可观测性缺口 | `electron/runtime/hostedTurnHandoff.ts` |
| D1 | `DeliveryHub` 的 deferred 队列仅存内存；生产调用处没有 `reportReachability`/`flushDeferred`，恢复可达后不会自动补投。 | 已确认缺陷 | `electron/driver/deliveryHub.ts`、`electron/butler/butlerDelivery.ts` |
| D2 | 管家 IM 投递返回 deferred 时立即降级桌面，但原消息仍待补投。若以后接上 flush，可能双渠道送达。 | 已确认条件路径 | `electron/butler/butlerDelivery.ts` |
| D3 | 管家每次投递重新注册所有 Driver，覆盖注册会清除同 ID 的旧 deferred 项；下一次无关任务可作废上一任务的积压。 | 已确认缺陷 | `electron/butler/butlerDelivery.ts`、`electron/driver/deliveryHub.ts` |
| D4 | 同一 `supersedeKey` 的多条 deferred 不互相取代；旧记录的 `outcome` 又会被事后改写，导致内存视图与已写日志不同。 | 已确认缺陷 | `electron/driver/deliveryHub.ts` |

近期路由重复注册、异步 transcript normalizer 未 await、当前用户消息 ID 绑定等问题已有修复和回归测试；本方案将它们保留为契约回归用例，不重复设计修复。invocation lease 目前在聊天主链路只见 acquire/release；park/resume 的实际用途需要单独核实，不作为已确认运行故障。

## 3. 目标契约

### 3.1 重新判断：合并 turn 与 invocation 的身份

当前 `TurnCoordinator.execute()` 按 `turnId` 单飞，同一已准备 turn 的重复请求复用既有记录；SDK History 拒绝已终结 invocation 再执行。provider 重试和模型轮次在一次 invocation 内处理。代码没有实现“同一 turn 下多个独立 invocation”的产品能力。因此不为假设中的未来重试保留一组长期并行的执行 ID。

目标规则是 **一个 accepted turn = 一次 Runtime invocation = 一个 canonical History stream**。新数据使用 `invocationId = turnId`；`invocationId` 是 SDK API 参数名，不再拥有独立生成、映射表或状态机。Runtime 的 lease、取消、工具授权与 History 均绑定该执行 ID。若未来确实需要对同一用户指令重新执行，应先定义可见的重新运行语义：默认创建新 turn，关联 `replayOfTurnId`；只有明确要求“同一 turn 的多 attempt”时，才引入局部 `attemptId`，不能提前把所有入口复杂化。

| ID | 唯一含义 | 生成/持有者 | 规则 |
| --- | --- | --- | --- |
| `sessionId` | 会话与 transcript 归属 | Driver/会话存储 | 可跨多个 turn，不作为执行 ID |
| `turnId` | 一条被接受的指令、Runtime 执行及 canonical History 流 | TurnCoordinator 或入口适配器 | 所有新入口必须提供；SDK `invocationId` 参数传同值 |
| `invocationId` | SDK 对执行作用域的参数名 | 不单独生成 | 新数据恒等于 `turnId`；旧数据按持久化映射读取 |
| `requestId` | Driver 入站请求的去重和传输关联 | Driver | 接受后持久关联 `turnId`；不作为新的 Runtime 主 ID |
| `modelRequestId` | invocation 内模型轮次/重试 | SDK | 不参与 turn 终态或会话版本选择 |
| `startToken` | 已准备 turn 的启动所有权 | TurnCoordinator | 启动、恢复、重试都校验 |
| `deliveryId` | 一次最终结果的投递意图 | 结果送达层 | 与 `runId`/`turnId` 关联，幂等且可持久化 |

引入不可变 `AcceptedTurn`（或等价现有类型扩展），包含 `turnId`、入站 `requestId`、`sessionId`、lane、冻结配置、当前 user message ID 和读取的 session transcript version。入口只构造该对象；Runtime 不再从 `driverContext: unknown` 或 `sessionId` 猜身份/渠道。取消和事件的外部 API 可继续接收 `requestId`，在 Driver 边界解析到 `turnId`。旧 History 的 `invocationId = requestId` 必须保留读取适配，不能仅改调用参数后失去历史数据。

### 3.2 规范终态

规范 outcome 使用 `completed | failed | cancelled | timed_out | interrupted | commit_uncertain`。`denied` 可作为失败原因，不另造无法映射的终态。SDK History terminal 的 `kind + payload.status/reason` 是执行事实；session ledger 和 UI 是投影。尤其 `cancelled` 必须由 terminal 自身字段识别，不能依赖可选的 session sidecar。

| 情形 | canonical outcome | 可进入下轮 transcript | Driver 可宣告最终结果 |
| --- | --- | --- | --- |
| 正常完成且提交成功 | completed | 是 | 是 |
| 模型/工具明确失败 | failed | 按明确的失败轮次保留规则 | 是 |
| 用户取消 | cancelled | 仅使用验证通过且已提交的部分内容 | 是 |
| 超时 | timed_out | 按失败/部分内容策略明确提交 | 是 |
| 进程重启时未终结 | interrupted | 不从开放流直接选取 | 恢复判定后 |
| 跨存储提交结果不明 | commit_uncertain | 不推进版本，待对账 | 不宣告成功 |

产品需在实现前固定失败/取消时的消息保留策略：至少明确 user message、部分 assistant、已完成工具结果各自是否进入后续上下文。该决策必须同时用于 UI 消息、session transcript 和 Hosted request，不能由 cutover 算法临时推断。

本轮固定的上下文规则：每个终态 checkpoint 都以该 turn 取得所有权时读取的已提交 transcript 为前缀；当前 accepted user message 追加到该前缀。只有 completed 且 History terminal 验证通过时，才追加当前轮 assistant 内容与已完成工具结果。failed、cancelled、timed_out、interrupted 保留前序已提交消息和当前 user，排除当前轮部分 assistant 与未完成/未确认工具输出。

### 3.3 Session transcript 提交

为 session 建立单调递增的 transcript version/checkpoint。**同一 session 的执行所有权必须在模型或工具运行前取得**：持久化队列/claim 使任一时刻只有一个 turn 可以从已提交版本读取上下文并进入 Runtime。后续 turn 等前一 turn 完成提交或恢复对账后，再读取新版本。claim 带 owner、generation/fencing token 和状态；跨进程启动通过 SQLite 原子约束竞争，重启先将旧 owner 的执行和外部副作用状态判定/恢复，再移交所有权。租约时间到期本身不能让第二个执行器开始工具调用；旧执行器必须失去派发资格且未决副作用已对账。

Runtime 记录 base version 和当前 user ID。结束时对 canonical History 做校验，把按产品策略可保留的消息以 `(sessionId, turnId)` 为幂等键提交到下一版本。已有 session 消息存储可作载体；不要求一开始新增独立数据库。version CAS 是所有权错误的检测网，不是工具执行后的常规冲突处理：一旦模型/工具已执行，CAS 冲突必须标记 `commit_uncertain`、保留该 turn 的 History 和工具事实、停止同 session 后续执行并对账；**不得自动重新运行模型或工具，也不得只替换 base transcript 后照搬旧输出**。仅在进入 Runtime 前的排队阶段，才允许按新版本重新构造请求。

若 canonical History 与 session JSONL 无法做单事务：先写 canonical terminal，再提交 session checkpoint，最后更新 UI/turn 投影。任一步失败写入待对账记录；恢复程序按幂等键补齐，绝不根据“最近一个看似可用的 invocation”推进版本。迁移期保留 `resolveCanonicalRequestCutover` 作为旧会话读取适配器，记录命中率和失败原因，完成历史迁移后移除热路径依赖。

### 3.4 Driver 投递状态机

每个 `deliveryId + target` 有明确状态：`pending -> deferred | delivering -> delivered | failed | expired | superseded | delivery_uncertain`。在调用外部 IM 前持久写 `delivering`；只有收到可验证的发送确认并写入本地后才能标 `delivered`。进程在发送后、写确认前崩溃，或发送接口超时且无法判定远端是否接收时，恢复为 `delivery_uncertain`。现有 `sendFeishu(text, target)`/`sendWechat(text, target)` 没有幂等键或按键查询能力，因此不自动重试 uncertain 项，不宣称“重启后外部恰好一次”。本迭代不新增状态展示或重发操作；若既有路径展示结果，只能基于持久状态，不能把 uncertain 误报为已送达或确定失败。若渠道将来支持远端幂等键或按键查询，先扩展 Driver 契约传递 `deliveryId`，验证远端保证后才允许自动核验/重试。

降级是一个独立决策：对尚未派发的 pending/deferred 项，可先原子撤销原目标，再投桌面。对 `delivering`/`delivery_uncertain`，不能假定原目标未收到；默认不自动降级为另一条“最终结果”通知。本迭代只修复既有持久化、路由和状态投影，不新增送达状态页面、配置项、提示或重发操作；若既有界面展示该状态，必须避免将 uncertain 误报为已送达或确定失败。

Driver 注册只在应用装配期进行，Driver 实例不捕获某一次 task/run 的闭包；目标地址、run 元数据随不可变 payload 传入。可达性变更由 IM/桌面连接状态源调用 hub；定时扫描只作为漏报兜底。待投递项及状态写入持久存储，重启时按 TTL 和幂等键恢复。若当前版本不准备持久化，就删除“重启后补投”的承诺并把 `deferred` 明确视作本进程内暂存。

`supersedeKey` 应按目标作用域建立索引，入队新项时原子地标记并移除旧 pending 项。台账只追加状态转换事件，不修改已经输出的记录。多目标投递返回每目标结果，而非仅返回最后一个目标的记录。

## 4. 分阶段实施

### 阶段 0：契约与观测，独立小改动

1. 写出五类入口的 ID 生成/传递矩阵与终态矩阵；为 handoff 增加结构化诊断：当前及前序 turn ID、旧数据的 History stream ID、session ID、snapshot/version、失败阶段、原因码，不记录消息正文。
2. 修复 L4：共享一个 terminal outcome 解码函数，History 选择、handoff、恢复使用同一函数；补缺少 session ledger 的取消用例。
3. 为跨存储写入增加可查询的 `commit_uncertain` 诊断和对账指标。此阶段不改变 transcript 来源。

验收：取消在有/无 ledger 的入口映射相同；错误可以定位至读 History、选择快照、匹配当前消息或提交阶段。

### 阶段 1：执行上下文与 session checkpoint

1. 引入显式 `AcceptedTurn`，入口逐一接入。桌面保留现有 `requestId -> turnId` 接受/去重记录；远端、管家和审批入口在接受时生成稳定 `turnId`。新 History 使用同一值作为 SDK `invocationId`；移除新的 `turnId ?? sessionId` 使用，旧数据恢复保留受限适配器。
2. 定义失败/取消内容保留规则，建立 session transcript version 与幂等提交 API。
3. 增加跨进程持久的 session 执行 claim/排队：在任何模型/工具派发前取得所有权并读取固定 base version。旧会话走一次性兼容适配和校验。仅未执行的排队请求可按新版本构造；执行后 CAS 冲突进入对账，禁止自动重放。
4. 启动恢复先对账 terminal、checkpoint、工具副作用和 TurnCoordinator 投影，再释放该 session 的 claim、放行新 turn。

验收：completed、failed、cancelled、timeout、restart、History append 失败、checkpoint 失败各组合都有状态矩阵测试；跨 invocation 的下一轮输入与已提交 session 版本一致。两个同 session turn 并发到达时，第二个在首个 checkpoint 完成前不能派发模型/工具；故障注入使工具执行后 CAS 失败时，工具调用次数仍为一次，session 被阻断待对账。

### 阶段 2：Driver 送达

1. 将 Driver 注册移到 `main` 装配；接入可达性事件和受控 flush。
2. 按 `deliveryId` 管理持久 pending、TTL、取代及每目标状态；区分可安全撤销的 pending/deferred 与派发后结果未知的 `delivery_uncertain`。先决定降级是否安全，再执行降级。
3. 管家 run 存储引用 deliveryId 和最终送达状态；投递中的 run 不写成最终 `failed-degraded`。
4. 将日志改为追加状态转换；对重启、并发 flush、同键取代和多目标部分成功做回归测试。

验收：未派发的离线项恢复后可补投；降级后不再向原目标补发；无关新任务不会作废旧任务；同键仅最新待投递项送达；已确认送达不重试。模拟“远端已接受、本地确认前崩溃”后持久状态为 `delivery_uncertain`，不会自动重发或自动降级，台账及已有界面不得把它报告为确定送达或确定失败。本迭代不以新增界面、配置项、提示或重发操作作为验收项。

### 阶段 3：收缩旧路径

观测兼容 cutover 和旧 ID 回退已无生产命中后，移除热路径扫描上一 invocation、无意义的 invocation lease park/resume 接口（若确认没有消费者），以及重复终态映射。`invocationId` 仅留在 SDK 必需的 API 形状中，业务代码统一称 `turnId`。分 PR 删除，每步保留恢复旧数据所需的最小读取适配器。

## 5. 测试与上线门槛

- 单元测试：规范 terminal 解码、transcript 幂等提交/CAS、Driver 状态转换与 supersede。
- 集成测试：桌面、飞书、微信、管家、审批入口均覆盖接受、执行、取消、失败、恢复和送达；重点用真实 SQLite 与 session JSONL 组合验证故障注入后的对账。
- 故障注入点：session claim 前后、工具派发后但 checkpoint 前、History terminal 写入前后、checkpoint 写入前后、UI 投影前后、IM 远端接受后但本地确认前以及进程重启。
- 验收指标：无未解释的 History/turn/checkpoint 状态分叉；无自动重放已执行工具；已确认送达不重复自动发送，未确认送达在持久台账中保持 uncertain，既有投影不得误报为确定结果；cutover 拒绝原因可按阶段统计。
- 验证命令按改动范围执行聚焦 Vitest、`npm test`、`npm run typecheck:renderer`、`npm run typecheck:shared`；涉及 UI 文案再跑 i18n 检查。

## 6. 实施边界

本方案不要求把全部入口一次性迁移，也不把 Driver 投递纳入 SDK History。SDK 对执行事实负责，session checkpoint 对跨轮上下文负责，Driver 对结果送达负责。三者通过稳定 ID、幂等键和可恢复的状态转换连接；每阶段都应保持旧会话可读并可回滚。

## 7. 实施跟踪

本节记录当前工作区实现状态；设计目标与验收标准以上文为准，未列为完成的验收不可视为通过。

- 阶段 0：共享 terminal outcome 解码、结构化 handoff 诊断及五类入口契约矩阵已实现。新增 JSONL `history.cutover` 记录命中/拒绝/无历史路径、快照版本与原因码；`session.transcript.reconciliation` 记录 commit_uncertain 和启动恢复计数，日志字段 allowlist 测试确保不保留正文。本轮将 SQLite TurnCoordinator 启动恢复改为调用共享终态解码器，并以真实 SQLite 回归覆盖 canonical timeout 保持 `timed-out`（而非折叠成 `failed`）。生产部署后的指标聚合与零命中观察仍未完成。
- 阶段 1：Desktop、Feishu、WeChat、Butler、Approval 的新入口均构造 `AcceptedTurn` 并传到 AgentInvocation/Hosted handoff；新增 SQLite AcceptedTurn 台账，持久绑定 requestId、turnId、session 和冻结快照，duplicate acceptance 复用原快照，requestId 查 History 先解析为 canonical turn stream。远端及 Butler 快照源自持久 prepared turn，Approval 内部映射也写入同一台账；v26→v27 migration 已加回归。旧 requestId 读取适配保留；SQLite History 按 turnId 恢复终态，并以事务/FIFO 测试验证同 session 第二个 turn 在前一 checkpoint 前不派发。Hosted handoff 使用固定 transcript 版本，CAS 冲突只执行一次并阻断 session；执行后缺失/不可读的 History terminal 会保留 uncertain claim。启动时先修复 canonical History/sidecar，再恢复 TurnCoordinator 投影；恢复完成后，崩溃留下的未执行 claim 可释放，执行中 claim 转为 `commit_uncertain`，仅匹配现存 transcript entry 的 uncertain 记录自动收敛；History 修复错误或 TurnCoordinator 恢复异常时不释放 claim。claim、队列与 checkpoint 的跨表状态更新有 SQLite 故障注入回归，保证写入失败时事务回滚。本轮新增 canonical History 已完成但 checkpoint insert 失败的故障注入：仍持久保留 claim/queue 执行 fence，报告 `commit_uncertain`，重开真实 SQLite 数据库后，启动阶段由该 fence 修复缺失 checkpoint 并维持阻断；失败/取消/超时/重启终态矩阵验证只把已接受 user message 写入 transcript；completed 与失败 terminal 的 checkpoint 写入异常都转为 `commit_uncertain` 并保留 session fence；CAS 冲突、History terminal 缺失/不可读用例同时断言模拟工具副作用只发生一次，后续 turn 因 uncertain checkpoint 被拒绝。已有数据库级人工 transcript 对账原语支持 completed/failed/cancelled/timed_out/interrupted 终态；interrupted 只投影已接受输入且保留 `interrupted` outcome。本轮通过超时回归发现 FIFO 排队 turn 未取得 ownership 就离开时会残留队列首项；handoff 现在按 owner 精确清理该 queued 行，释放前序 owner 后下一 turn 可正常取得 claim。入口 assembler 现在从 `AcceptedTurn.turnId` 补全 `AgentInvocation.trace.turnId`，避免遗漏冗余参数时普通 History 与 Hosted handoff 使用不同 stream；新增 RED/GREEN 用例覆盖。远端入口终态 adapter 现显式绑定 requestId 到 prepared turn 并在执行后清理映射；真实 TurnRuntime 回归先复现 `unknown turn request`，修复后确认 canonical terminal 持久化且晚到事实因解绑而拒绝。入口级产品矩阵及计划列出的其余故障组合仍未完成。本轮修复 canonical timeout 和 interrupted 在 transcript 投影中被错误折叠为 failed 的问题。
- 阶段 2：Driver Hub 持久 journal、deliveryId、多目标结果、deferred 恢复、supersede 事件及 `delivery_uncertain` 状态已实现；状态快照与追加事件在 SQLite 同事务；远端发送后本地确认失败归 uncertain，不进入自动重试。飞书/微信可达性与发送端口已接入，管家调用链传递投递目标并记录投递状态；设置页仍保留原有任务执行完成提示，本轮不新增页面、配置项或送达状态提示，因此阶段 2 的既有投影不得误报 uncertain 属于状态正确性约束；新增界面验收不在本迭代范围。本轮新增多目标 TTL 过期记录保留实际 driverId 的回归修复、同 `supersedeKey` 新结果直接送达时持久取代旧 deferred 的 SQLite 重启回归、相同 `deliveryId` 携带不同 payload 时拒绝派发并保留首次持久意图，以及双 hub 直接派发原子 claim、事务内意图校验和过期 deliveryId 不可复活的回归修复。此前新增跨独立 hub 并发 flush 原子 claim；Butler adapter + SQLite 重启演练验证离线 deferred 可通过 reachability flush 恢复，已发生外部发送但本地确认失败则重启后不重发、不降级。本轮补上 journal 终态向 Butler run 投影的启动/可达性恢复同步，避免恢复投递后 run 永久停留 `pending`，并覆盖多目标混合状态归并。本轮真实 SQLite 回归又发现同步器在 pending 时提前写入 `delivered_at` 且重复更新未变化的 pending run；现在只有状态转为 delivered 才设置该时间，待投递状态不产生虚假时间戳或重复写入，部分目标 deferred 时保持 pending，全部送达后记录实际收敛时间。本轮另修复三项 supersede 生命周期问题：flush 在途期间新结果已送达、旧结果随后失败并重新 deferred 时，journal 重建会恢复每个 target/key 最新意图并抑制旧项；旧 `deliveryId` 在失败后被新结果取代，之后即使旧 dispatch 尚在重试，也会返回并持久记为 `superseded`，新意图在进入 dispatch 时就成为当前 supersede 状态；旧 deferred 重启遇到较新的 deferred/terminal 状态会抑制旧项并保留最新可恢复项。本轮还通过 RED/GREEN 修复 Hub 启动恢复的 TTL 边界：重启时即使目标仍离线，过期 deferred 也会先持久收敛为 `expired`、从补投队列移除，再同步 Butler run 为 `failed-degraded`，不伪记送达时间；若 journal 终态写入失败则暂留可恢复项。主进程启动顺序相应调整为先恢复 Hub、再同步 run 投影。生产 IM 服务真实重启、降级撤销的运维流程与外部接口现场不确定结果仍待部署后演练。
- 阶段 3：Runtime 层未被使用的 invocation lease `park/resume/resumeLease` 和 `canParkInvocation` 已按 RED/GREEN 删除；当前真实审批等待由独立且仍在使用的 `applicationAdmission` 承担，旧 History 的 `invocation-parked` 读取兼容保留。兼容 History 扫描和旧 ID 读取适配仍在用；移除它们必须等待可观测性证明生产零命中，当前没有生产数据可作为删除依据。

本地可自动验证范围的收尾审计（2026-09-30）：

| 计划项 | 本机自动化证据/结论 | 状态 |
| --- | --- | --- |
| 五类入口的稳定身份及失败终态 | `AcceptedTurn`、持久 requestId 映射、入口真实 Hosted + SQLite terminal 写入失败测试；provider 单次执行且 History 仅有一个失败 terminal | 完成 |
| claim/FIFO、执行后 checkpoint/CAS 冲突 | SQLite 并发与事务故障注入；Desktop、Feishu、WeChat、Butler、Approval 的真实工具副作用后 checkpoint 失败均断言不自动重跑 | 完成 |
| 重启恢复 | 文件 SQLite 覆盖未执行 claim 释放、执行中 fence 阻断、缺失 checkpoint 保持阻断、匹配 checkpoint 对账后恢复；IM lane 验证重启后不重复 provider/tool | 完成 |
| History terminal 写入前失败/提交后丢确认 | SQLite `runAgentTurn` 注入；另有五类入口 `invocation-completed` 写入失败回归 | 完成 |
| Driver journal/恢复/投影 | SQLite 覆盖多目标部分成功重启、deferred 恢复、TTL、supersede、并发 claim、远端接受后本地确认异常的 uncertain 语义及 Butler run 投影 | 完成 |
| 旧数据与兼容读取边界 | requestId 通过 AcceptedTurn 映射 canonical turn；无映射的旧流沿用受限 fallback；未知 session 归属的旧 History 不进入 transcript 索引；旧 `invocation-parked` 仅保留读取解码；canonical cutover 对当前消息/顺序/重复内容进行匹配并对不可用或不匹配 fail closed | 已分类并保留适配 |
| 生产 cutover 零命中观察、真实 IM 服务端故障演练 | 需要部署后遥测或实际 IM 服务/账号，不能由本机自动测试代替 | 不属于本轮本机必达目标；作为删除兼容路径/上线前置门槛继续保留 |

本轮对计划中“入口级完整故障组合”的解释限定为可本机自动执行的契约及故障边界，不要求把五个入口与每一种终态、每个 SQLite 故障时序做完整笛卡尔积。现有测试逐项覆盖适用的入口接线、terminal 持久化、工具副作用后 checkpoint 故障、重启阻断/对账和既有投影；Windows 专属自动任务同样不构成本机必达项。阶段 3 中已由本地证据证明无消费者的 Runtime lease 死接口已删除；兼容 History 扫描、requestId/旧数据读取适配继续保留，直到生产零命中证据成立。阶段 0–2 本地自动化验收已覆盖；生产指标汇总/零命中观察、真实 IM 服务现场演练及依赖它们的兼容路径删除属于部署/现场条件，本轮不作为本机必达项。

验证记录（2026-09-30）：撤回未在计划中的设置页、IPC、renderer API 和审计 schema 扩展后，最新完整 `npm test -- --reporter=dot --bail=1 --pool=threads --maxWorkers=1` 通过：801 个文件通过、1 个跳过，6967 项通过、106 项跳过。`npm run build:electron`、`npm run typecheck:renderer`、`npm run typecheck:shared`、`npm run i18n:check` 与 `git diff --check` 通过。数据库级 transcript reconciliation 可保留 `interrupted` outcome，投影仍只含已接受 user message；故障注入覆盖执行 claim、队列、checkpoint 多表事务及 canonical History terminal 已成功但 checkpoint 写入失败；后者通过持久执行 fence 阻止 session，并在真实 SQLite 重启后由启动恢复修复缺失 checkpoint；Hosted 执行后 History terminal 缺失/不可读会阻断为 uncertain；启动恢复按顺序处理执行 claim、History 和 TurnCoordinator 投影，并统计安全释放、uncertain 标记、checkpoint 修复及匹配 checkpoint 收敛；失败/取消/超时/重启 transcript 终态矩阵确保未完成 assistant 内容不进入下一轮；completed 与 failed terminal 的 checkpoint 写入异常均验证转为 `commit_uncertain` 并持久保留 session fence；FIFO claim 等待超时后按 owner 删除未取得 ownership 的排队项，并验证后续 turn 可接管；CAS 冲突和 History terminal 缺失/不可读还验证模拟工具副作用单次与后续 turn 阻断；Driver Hub 多目标过期、直接派发并发 claim、直接送达取代旧 deferred、`deliveryId` 意图不可变性及 Butler run delivery 状态收敛的 RED/GREEN 回归通过。Butler/Driver 定向测试 42 项通过；最新 transcript/runtime/日志定向测试 45 项通过；Electron 构建通过。仍缺真实生产零命中观测与真实 IM 服务故障演练，故整份计划未完成。

本轮追加验证（2026-09-30）：`npx vitest run electron/turnCoordinatorStorage.test.ts electron/database/operations.test.ts --reporter=dot` 通过，83 项通过；其中新加的 SQLite 启动恢复 timeout 矩阵用例此前以 `failed` 对 `timed-out` 的断言差异 RED，修复后通过。完整入口级故障组合、生产零命中观测与真实 IM 服务故障演练仍未完成。

本轮追加验证（2026-09-30）：`npx vitest run electron/runtime/invocationAssembler.test.ts electron/toolChatLoop.invocation.test.ts --reporter=dot` 通过，55 项通过；AcceptedTurn 缺省独立 `turnId` 参数时 trace 丢失 canonical turn ID 的新用例先 RED 后 GREEN。完整入口级故障组合、生产零命中观测与真实 IM 服务故障演练仍未完成。

本轮追加验证（2026-09-30）：`npx vitest run electron/butler/taskStore.test.ts electron/butler/butlerDelivery.test.ts --reporter=dot` 通过，20 项通过；新增真实 SQLite 多目标部分送达/恢复测试先复现 pending 状态错误写入 `delivered_at`，修复后确认 pending 阶段无时间戳、无重复更新，最终 delivered 使用实际收敛时间。Electron TypeScript 编译与 `git diff --check` 通过。生产 IM 服务真实故障演练仍未完成。

本轮追加验证（2026-09-30）：`npx vitest run electron/driver/deliveryHub.test.ts electron/butler/butlerDelivery.test.ts electron/butler/taskStore.test.ts --reporter=dot` 通过，54 项通过；新增真实文件 SQLite 重启竞态测试先 RED 确认旧 deferred 被重发，修复后确认重启把旧项记为 superseded 且不再派发；新结果进入 dispatch 后重试旧 failed delivery 的并发回归也先 RED 确认旧项被再次派发，修复后返回并持久写成 superseded。追加最新 supersede 意图状态矩阵：重启后 latest 为 pending/deferred 时只恢复最新项；latest 为 failed、delivery-uncertain、expired、superseded、delivered 时均抑制旧 deferred，7 个用例通过。另验证较新意图 dispatch 中断后恢复为 uncertain 会压过旧 deferred，且即使 createdAt 时钟顺序相反仍按持久接受顺序恢复，两个真实 SQLite 回归通过。Electron TypeScript 编译与 `git diff --check` 通过。生产 IM 服务真实故障演练仍未完成。



本轮追加验证（2026-09-30）：新增 RED/GREEN 真实 SQLite 用例复现并修复“进程重启时目标仍离线、deferred 已过 TTL，却继续留在队列并使 Butler run 永久 pending”；Hub 初始化恢复现在先将此类项目录为 `expired`，然后 main 才同步 run 状态。Driver Hub 与 Butler run 组合回归验证 `expired -> failed-degraded` 且不写 deliveredAt。`npm test -- --reporter=dot --bail=1 --pool=threads --maxWorkers=1` 全量通过（801 个文件通过、1 个跳过；6958 项通过、106 项跳过）；Electron 构建、renderer/shared 类型检查、i18n 检查和 `git diff --check` 通过。真实生产零命中观测和 IM 服务故障演练仍未完成。



本轮追加验证（2026-09-30）：远端 Feishu/WeChat/Butler 共用的 `executeRemoteTurn` 曾依赖调用方预先 `bindRequest`，但 Feishu/WeChat 生产路由未绑定；真实 SQLite + TurnRuntime 的新用例先 RED 复现终态回写报 `unknown turn request`。adapter 现统一绑定并在成功/异常路径清理映射，避免终态漏写及终结后映射残留；补齐 router fake Runtime 契约后，adapter、Feishu、WeChat、Butler 定向回归 80 项通过。完整 `npm test -- --reporter=dot --bail=1 --pool=threads --maxWorkers=1` 通过（801 个文件通过、1 个跳过；6959 项通过、106 项跳过）；Electron TypeScript 检查与 `git diff --check` 通过。阶段 0–2 仍有入口完整故障组合缺口，生产零命中观测和真实 IM 演练未完成。

本轮追加验证（2026-09-30）：为 `executeRemoteTurn` 补充真实 SQLite + TurnRuntime 的 `completed`、`failed`、`cancelled`、`timed-out` 四种终态持久化矩阵，四个用例 RED/GREEN 后通过；`npx vitest run electron/remote/turnExecutionAdapter.test.ts --reporter=dot` 共 25 项通过。随后完整 `npm test -- --reporter=dot --bail=1 --pool=threads --maxWorkers=1` 通过（801 个文件通过、1 个跳过；6963 项通过、106 项跳过）；Electron TypeScript 检查、`git diff --check` 通过，针对先前撤回的未授权设置功能关键字检索无命中。阶段 0–2 入口故障组合、生产零命中观测和真实 IM 演练仍未完成。

本轮追加验证（2026-09-30）：为 handoff 观测契约补上真实 SQLite 回归：History 读取失败、最新 stream 不可用分别记录 `read-history` 与 `select-snapshot` 阶段、原因码及 stream/turn/version 关联，且不泄露消息正文；checkpoint 写入失败断言 reconciliation 的 `commit_uncertain`、`checkpoint-write-failed` 与版本字段。`npx vitest run electron/runtime/hostedTurnHandoff.test.ts electron/agentLogger/agentLogProjection.test.ts --reporter=dot` 通过，30 项通过；`git diff --check` 通过。当前代码已覆盖四个本地可判定诊断阶段的行为断言，但生产指标汇总及零命中观察、入口全故障矩阵和 IM 现场演练仍未完成。

本轮追加验证（2026-09-30）：远端 adapter 曾在 Runtime 接受 terminal event 前写入进程内成功结果缓存；终态持久化失败后，重试可能把持久失败结果错误返回为成功。新增用例先 RED 复现 `ok:true` 覆盖 `failed` terminal，随后将缓存写入移到终态事实成功消费之后。`npx vitest run electron/remote/turnExecutionAdapter.test.ts --reporter=dot` 26 项通过；handoff 与日志投影定向测试 30 项通过；Electron TypeScript 编译与 `git diff --check` 通过。最新全量 `npm test -- --reporter=dot --bail=1 --pool=threads --maxWorkers=1` 通过（801 个文件通过、1 个跳过；6966 项通过、106 项跳过）。阶段 0–2 剩余入口完整故障组合、生产零命中观测和真实 IM 演练仍未完成。

本轮追加验证（2026-09-30）：审批入口原本在本地 deadline 到期后调用通用 cancel，造成外层结果为 timeout、canonical History/transcript 却记为 `cancelled`。审批真实 Hosted + SQLite 回归先 RED（共享 decoder 得到 cancelled），修复后 deadline 通过 AbortSignal reason 明确传递；SDK 将该执行写为 `invocation-failed` 且 reason 为 `timeout`，共享 decoder 与 transcript outcome 均为 `timed_out`。新增 SDK Hosted timeout 测试验证此映射，现有普通 cancel 用例继续验证 `cancelled`。SDK turn、ChatCancelRegistry 与 Approval 全量定向测试 156 项通过；`npx tsc --noEmit --pretty false -p tsconfig.electron.json` 与 `git diff --check` 通过；完整 `npm test -- --reporter=dot --bail=1 --pool=threads --maxWorkers=1` 通过（801 个文件通过、1 个跳过；6967 项通过、106 项跳过）。入口故障组合、生产零命中观察和真实 IM 演练仍未完成。

本轮追加验证（2026-09-30）：`AcceptedTurn.currentUserMessageId` 现同时约束 assembler 与 Hosted handoff；Approval Hosted 测试夹具原先仍传入父请求的旧 message ID 或未传冻结 ID，导致新契约在 provider 前拒绝。将夹具改为传递 AcceptedTurn 冻结的 user message ID 后，Approval 40 项通过；assembler、handoff、tool chat、远端 adapter、Approval 五个入口/集成测试文件合计 258 项通过，Electron TypeScript 检查与 `git diff --check` 通过。管家现有运行结果提示回归 13 项通过，i18n 检查通过。当前仍未完成入口全故障矩阵、生产零命中观察与真实 IM 现场演练。

本轮追加验证（2026-09-30）：renderer 类型检查通过；完整 `npm test -- --reporter=dot --bail=1 --pool=threads --maxWorkers=1` 通过（801 个文件通过、1 个跳过；6971 项通过、106 项跳过）。现有 Butler 运行结果提示只区分 pending/uncertain/degraded，未增加接收对象设置项或运维页面；搜索确认 renderer 没有新增的运行时状态管理入口或文案。生产零命中观测、入口全故障组合与真实 IM 服务演练仍未完成。

本轮追加验证（2026-09-30）：远端 Hosted handoff 已提交 `cancelled`/`timed-out` canonical terminal 后抛出 `HostedTurnFinalizedError`，旧 adapter 将异常统一投影成 TurnRuntime `failed`；WeChat 的 `rethrowAsError` 还会丢失该终态类型。两个真实 SQLite + TurnRuntime 回归先 RED，修复后保留错误实例并把已提交 Hosted 取消/超时转换为稳定的远端失败结果和相应 TurnRuntime terminal（普通未分类异常仍记 failed）。定向 adapter/agent/router 测试 182 项通过；全量 `npm test -- --reporter=dot --bail=1 --pool=threads --maxWorkers=1` 通过（801 个文件通过、1 个跳过；6970 项通过、106 项跳过）；`npm run build:electron`、renderer/shared 类型检查、`npm run i18n:check`、Electron TypeScript 检查和 `git diff --check` 均通过。入口其余完整故障组合、生产零命中观察及真实 IM 演练仍未完成。

阶段 0–2 的入口级完整故障组合仍有列明的集成缺口；阶段 3 则明确依赖真实生产观测，不能由本地测试替代。生产零命中数据到位前，不得删除迁移兼容路径，也不能把整份计划标为完成。

本轮追加验证（2026-09-30）：启动 transcript 对账此前只依赖调用方传入的 TurnCoordinator recovery 成功布尔值，生产接线在 `recover()` 返回后无条件传 `true`；但 `recover()` 对无法匹配的投影可返回 0 并留下非终态 turn。现在启动接线把 turn restore 与 recovery 一起放入保护边界；对账还同时要求 coordinator 恢复无异常、并直接检查 SQLite 无非终态 turn/streaming assistant residue，任一不满足都跳过 stale-claim/checkpoint 收敛。恢复异常会被记录并按未完成处理，继续注册其余 IPC 而不释放 session fence。真实 SQLite 回归覆盖 `recover()` 返回 0 但 turn 仍 executing，以及 restore/recovery 抛错，确认 uncertain session 保持阻断；启动恢复与 Hosted handoff 定向测试 39 项通过，Electron TypeScript 检查和 `git diff --check` 通过。全量测试在新增恢复异常保护前的启动投影门槛代码状态通过（801 个文件、6973 项通过）；入口完整故障矩阵、生产零命中观察和 IM 现场演练仍未完成。

本轮追加全量验证（2026-09-30）：加入启动对账残留投影门槛后，`npm test -- --reporter=dot --bail=1 --pool=threads --maxWorkers=1` 通过（801 个文件通过、1 个跳过；6973 项通过、106 项跳过）。

本轮最新全量验证（2026-09-30）：Turn restore/recovery 统一进入异常保护后，`npm test -- --reporter=dot --bail=1 --pool=threads --maxWorkers=1` 通过（801 个文件通过、1 个跳过；6974 项通过、106 项跳过）。启动恢复/Hosted handoff 定向测试 39 项、Electron TypeScript 检查与 `git diff --check` 通过。阶段 0–2 其余入口完整故障组合、生产零命中观测与真实 IM 现场演练仍未完成。


本轮范围纠正（2026-09-30）：用户明确本迭代只做重构和问题修复，不接受新增产品功能。已撤回 ButlerTaskSettings 中依据 deliveryStatus 增加的三类 toast、对应测试及中英文文案/i18n 类型；当前设置页只保留原有任务完成提示。阶段 2 只验证持久台账状态及既有投影的正确性；新增界面、配置项、提示或重发操作不属于本迭代。

本轮追加验证（2026-09-30）：Feishu 入口回归先 RED 复现 Agent 返回 `ok:false` 且无 pending confirmation 时，TurnRuntime 已消费 `source-failed`，但 `agent_done` 审计错误记录 `success:true`。将成功条件修正为 `result.ok && !result.pendingConfirm` 后，`npx vitest run electron/feishu/remoteCommandRouter.test.ts electron/wechat/weChatCommandRouter.test.ts --reporter=dot --bail=1` 通过（2 个文件、22 项）；Electron TypeScript 检查与 `git diff --check` 通过。该修复只校正失败事实的审计投影，不增加产品功能。其余入口故障组合、阶段 2 新增界面验收（本迭代不在范围）、生产零命中观察和真实 IM 演练仍未完成。

本轮追加验证（2026-09-30）：Butler 真实 SQLite run 集成回归先 RED 复现 IM `delivery-uncertain` 时仍写入 `deliveredAt`。`butlerInvoker` 现只在投递状态明确为 `delivered` 时写该字段；新增 `delivery-uncertain`、`failed-degraded`、`pending`、`delivered` 四态回归，前三者不产生虚假时间戳，确认送达仍记录时间。Butler/Driver 定向测试 64 项通过；Electron TypeScript 检查与 `git diff --check` 通过。生产 IM 故障演练、阶段 2 新增界面验收（本迭代不在范围）和阶段 3 零命中观测仍未完成。

本轮追加验证（2026-09-30）：远端 `executeRemoteTurn` 遇到 Hosted canonical `interrupted` terminal 时，原先把已终结事实再次投影为 `source-failed`，导致 SQLite TurnRuntime 永久保存 `failed` 而非恢复语义 `recovered`。真实 SQLite 回归先 RED；adapter 现保留对外 `interrupted` 失败结果及 error 原因，把 Runtime terminal 记为 `recovered`，并在终态接受后缓存业务结果供同 request 重试，避免重跑 provider。四个调用方测试文件（adapter、Feishu、WeChat、Butler）93 项通过；Electron TypeScript 检查与 `git diff --check` 通过。入口故障矩阵、阶段 2 新增界面验收（本迭代不在范围）、生产零命中观察与真实 IM 演练仍未完成。

本轮追加验证（2026-09-30）：远端 Hosted interrupted 已能在当前进程保留 `interrupted` 结果，但 SQLite 新进程恢复的 `recovered` turn 原先只返回 `ok:false`，丢失 outcome/error。真实 SQLite + 两个 TurnRuntime 回归先 RED；适配器现在将持久 `recovered` 作为 `interrupted` 失败契约返回原错误，且不重新调用 provider。adapter、Feishu、WeChat、Butler 四个调用方测试文件 94 项通过，Electron TypeScript 检查及 `git diff --check` 通过。入口完整矩阵、阶段 2 新增界面验收（本迭代不在范围）、生产零命中观察和真实 IM 演练仍未完成。

本轮追加验证（2026-09-30）：重启恢复曾因 SQLite assistant tool checkpoint 保留 `executing` 状态而拒绝 canonical completed History；即使 History 有完整 tool-call-finished 与 completed terminal，turn 仍错误收敛为 `recovered`。真实 SQLite RED/GREEN 用例确认 canonical 完整工具快照可以覆盖陈旧 executing 投影；数据库原语仅在调用方提供已重建的完整工具快照时允许该覆盖，缺少快照时仍拒绝把挂起工具直接判成功。`electron/turnCoordinatorStorage.test.ts` 与 `electron/database/operations.test.ts` 定向测试 84 项通过，Electron TypeScript 检查与 `git diff --check` 通过。随后全量 `npm test -- --reporter=dot --bail=1 --pool=threads --maxWorkers=1` 通过：801 个文件通过、1 个跳过，6981 项通过、106 项跳过。生产零命中观察、真实 IM 演练、入口剩余组合与阶段 2 新增界面验收（本迭代不在范围）仍未完成。

本轮补充入口持久化断言（2026-09-30）：SessionEvent `tool_result` 投影失败后，除 canonical History 保留 `invocation-interrupted/tool-projection-failed` 外，还断言 Butler SQLite run 已终结为 `failed` 且保留同一错误原因；`npx vitest run electron/butler/butlerInvoker.test.ts --reporter=dot --bail=1` 通过（42 项）。该断言补齐现有故障修复的持久结果覆盖，不增加产品功能。完整测试套件此前在同一代码状态通过（801 个文件通过、1 个跳过；6981 项通过、106 项跳过）；本次仅增加断言，定向文件已复验。入口剩余完整故障组合、生产零命中观察、真实 IM 演练及阶段 2 新增界面验收（本迭代不在范围）仍未完成。

本轮 TDD 修复（2026-09-30）：Hosted handoff 已提交 `commit-uncertain` 后，远端 adapter 原先将异常走通用 `source-failed`；新增真实 SQLite + TurnRuntime 用例先 RED，修复后断言首次结果与新 Runtime 重启恢复均保留 `commit-uncertain`/原错误且不重跑 provider。扩展 TurnOutcome 持久化该状态；桌面 Hosted handler/main 传递独立 `commit-uncertain` source outcome，不写普通失败事实；既有聊天终态投影把此状态错误地当成功的问题一并修正，继续使用原有错误呈现和真实错误原因，不增加设置页/新页面。Renderer 投影、远端 adapter、Desktop Hosted 集成、Feishu/WeChat/Butler 定向共 170 项通过；Electron 与 renderer TypeScript 检查、`npm run build:electron` 通过；随后全量 `npm test -- --reporter=dot --bail=1 --pool=threads --maxWorkers=1` 通过（801 个文件通过、1 个跳过；6983 项通过、106 项跳过）。生产零命中观测、真实 IM 演练、入口剩余完整矩阵和用户明确排除的新增界面功能验收仍未完成。

本轮继续 TDD（2026-09-30）：新增投影监听器断言先 RED 复现 `commit-uncertain` 终结 TurnCoordinator 后没有 Runtime 投影，renderer 会卡在 streaming；增加内部 `source-uncertain` 终态事实，由 Runtime 发布现有失败态/原因投影，同时持久 TurnOutcome 继续保持 `commit-uncertain`。桌面执行适配和远端 adapter 共用该事实，request 映射正常终结清理。定向 runtime/renderer/Hosted 测试 205 项通过；Electron、renderer TypeScript 检查及 `npm run build:electron` 通过；最新全量 `npm test -- --reporter=dot --bail=1 --pool=threads --maxWorkers=1` 通过（801 个文件通过、1 个跳过；6984 项通过、106 项跳过），`git diff --check` 通过。生产零命中观测、真实 IM 演练和其余入口完整故障组合仍未完成。

本轮 Butler 投影 TDD（2026-09-30）：新增自动化入口真实 SQLite 测试先 RED 复现 Hosted checkpoint 提交不确定时 Butler run 被记为 `failed`；现在保留错误原因并用既有 `interrupted` run 状态表达待恢复。Butler/远端 adapter 定向 74 项通过；最新全量测试通过（801 个文件通过、1 个跳过；6985 项通过、106 项跳过），Electron 与 renderer 类型检查、`npm run build:electron`、`git diff --check` 通过。此处仅修复现有运行记录状态映射，没有增加 UI/配置能力。生产零命中观测、真实 IM 演练和其余入口完整故障组合仍未完成。

本轮补充端到端故障注入（2026-09-30）：在 Butler 真实模型执行过程中，仅对 transcript checkpoint 从 version 0 提交 version 1 注入 SQLite 失败，验证 provider 只调用一次、canonical History 已 completed、checkpoint 与 session claim 持久为 `commit_uncertain`、Butler run 持久为 `interrupted` 并留存根因。`npx vitest run electron/butler/butlerInvoker.test.ts --reporter=dot --bail=1` 44 项通过；最新完整 `npm test -- --reporter=dot --bail=1 --pool=threads --maxWorkers=1` 通过（801 个文件通过、1 个跳过；6986 项通过、106 项跳过）；Electron/renderer 类型检查与 `git diff --check` 通过。阶段 0–2 其他入口故障组合、生产零命中观测和真实 IM 演练仍未完成。

本轮恢复投影 TDD（2026-09-30）：新增 IPC 回归先 RED 复现重启后 TurnCoordinator `recovered` 被 `chat:get-turn-displays` 错误映射成 `completed`，导致已恢复的中断 assistant turn 向 renderer 报告成功。现改为保留 `interrupted` outcome，并由 renderer 复用已有错误态和 terminal 原因。`electron/appIpc.file.test.ts` 与 `turnProjectionService.test.ts` 定向测试 63 项通过；Electron/renderer 类型检查、`npm run build:electron` 和 `git diff --check` 通过。随后全量 `npm test -- --reporter=dot --bail=1 --pool=threads --maxWorkers=1` 通过（801 个文件通过、1 个跳过；6988 项通过、106 项跳过）。其余入口故障组合、生产零命中观察和真实 IM 演练仍未完成。

本轮阶段 3 TDD 清理（2026-09-30）：增加公开契约回归先 RED，确认 `InvocationRuntime` 仍暴露生产调用链无人使用的 `park/resume/resumeLease`；全仓搜索确认执行时实际使用的是 `acquireLease/release`，审批等待则使用独立 `applicationAdmission`。删除死接口、parked-turn 容量状态与无调用者的 `canParkInvocation`，收窄 Electron/shared host port，并保留旧 History `invocation-parked` 读取兼容。SDK scheduler/History 定向测试 46 项通过；Electron/renderer 类型检查、`npm run typecheck:shared`、`npm run build:electron` 通过；随后完整 `npm test -- --reporter=dot --bail=1 --pool=threads --maxWorkers=1` 通过（801 个文件通过、1 个跳过；6986 项通过、106 项跳过）。生产零命中数据仍未到位，故旧 History/ID 兼容路径暂不删除。

本轮补充 Approval 入口故障覆盖（2026-09-30）：新增真实 SQLite checkpoint 故障注入，trigger 仅拒绝 transcript version 增长写入；Hosted provider 已完成后断言只调用一次、canonical History 保持 completed、checkpoint 与执行 claim 同为 `commit_uncertain`。首次同文件运行发现测试复用了 Approval 共用 session DB 并污染后续 case；改用隔离 SQLite 后 `electron/confirmation/approvalAgent.test.ts` 全部 41 项通过。该入口故障不把结果伪装为成功，审批执行仍按现有 fail-closed `unavailable` 返回。随后全量 `npm test -- --reporter=dot --bail=1 --pool=threads --maxWorkers=1` 通过（801 个文件通过、1 个跳过；6987 项通过、106 项跳过）。

本轮补充 Feishu/WeChat 入口故障覆盖（2026-09-30）：对两种 remote lane 使用持久 prepared turn 和 AcceptedTurn，真实 Hosted provider 执行后注入 transcript checkpoint SQLite 写失败；两条 lane 均保留 `HostedTurnFinalizedError(commit-uncertain)`、只调用 provider 一次、canonical History completed、checkpoint/claim `commit_uncertain`。新增 lane 参数化回归通过，`electron/remote/imRemoteAgent.test.ts` 全文件 135 项通过。整体全量测试待该用例后复验。

本轮补充 Desktop 入口故障覆盖（2026-09-30）：在真实 `registerClaudeStreamHandlers` IPC 执行路径运行 Hosted provider 后，对 transcript version 增长注入 SQLite trigger 失败；Desktop handler 返回既有 `commit-uncertain` 结果，provider 只调用一次，History terminal 保持 completed，checkpoint 与 claim 均保留不确定 fence。`electron/claudeStreamHandlers.hostedIntegration.test.ts` 全文件 119 项通过。`main.ts` 的外层 executeTurn 再将该结果映射到 TurnRuntime `source-uncertain`；独立 Runtime 投影回归覆盖该终态事实。Desktop、Approval、Feishu、WeChat 新增入口回归后的完整 `npm test -- --reporter=dot --bail=1 --pool=threads --maxWorkers=1` 通过（801 个文件通过、1 个跳过；6990 项通过、106 项跳过）。

本轮范围与回归核对（2026-09-30）：按用户明确要求将阶段 2 的 uncertain 约束限定为持久台账和既有投影正确性，移除新增页面/提示/重发操作作为验收项；设置页继续保留原有任务完成提示。源代码检索未发现对应设置页入口或文案。`npx vitest run electron/driver/deliveryHub.test.ts electron/butler/butlerDelivery.test.ts electron/butler/butlerInvoker.test.ts electron/remote/turnExecutionAdapter.test.ts --reporter=dot --bail=1` 通过（4 个文件、123 项）；`git diff --check` 通过。当前继续追踪阶段 0–2 的入口故障组合、本地缺失测试和部署后观测门槛。

本轮补齐 SQLite History terminal 故障点（2026-09-30）：SDK 已有内存 History 覆盖终态写入前失败与提交后丢确认，但真实 SQLite 集成层此前未验证这两个边界。新增 `SqliteAgentHistory` + 真实 `runAgentTurn` 注入：终态插入前 SQLite trigger 中止写入，或提交后模拟 acknowledgement 丢失。两例均验证 provider 单次调用、canonical History 仅有一个终态；前者持久 `invocation-failed` 且不发布 turn-finished，后者确认已提交 `invocation-completed` 并正常结束。`npx vitest run electron/runtime/sqliteAgentHistory.test.ts --reporter=dot --bail=1` 通过（1 个文件、82 项）。该路径实现已满足契约，无生产代码变更；入口全故障组合、生产零命中观察和真实 IM 现场演练仍未完成。

本轮全量验证（2026-09-30）：加入真实 SQLite History terminal 写入前失败/提交后丢确认的两条回归后，`npm test -- --reporter=dot --bail=1 --pool=threads --maxWorkers=1` 通过（801 个文件通过、1 个跳过；6992 项通过、106 项跳过）；`npx tsc --noEmit --pretty false -p tsconfig.electron.json` 通过。入口完整故障矩阵和部署后验证门槛仍未完成。

本轮补齐 Desktop 入口 terminal 故障（2026-09-30）：真实 IPC Hosted 调用中用 SQLite trigger 拒绝 `invocation-completed` 写入，SDK 持久化单一 `invocation-failed`，Desktop 返回失败，provider 只执行一次，失败 transcript 只提交已接受的 user message。新增断言首次因把存储的 canonical message 误按 UI message 全字段比较而失败，按 transcript 实际 schema 校准断言后通过；非产品行为缺陷，无生产代码改动。`npx vitest run electron/claudeStreamHandlers.hostedIntegration.test.ts --reporter=dot --bail=1` 通过（120 项），Electron TypeScript 检查通过。远端、Butler、Approval 对应入口的终态持久化故障覆盖和部署后验证门槛仍需逐项核实。

本轮补齐各入口 History terminal 注入（2026-09-30）：在 Desktop IPC、Feishu、WeChat、Butler、Approval 的真实 Hosted + SQLite 执行路径中拒绝 `invocation-completed` 插入，验证每条路径均保留唯一 `invocation-failed`，provider 只调用一次，transcript 以 `failed` outcome 收敛已接受输入；各入口仍按既有契约返回失败/`unavailable`。Butler provider 异常用例另补 run 与 canonical History 持久化断言。入口四文件联合测试通过（344 项），Desktop + Butler 两文件通过（164 项）；Electron TypeScript 检查通过。没有生产代码或产品流程变化。各入口其他故障组合以及部署后零命中观测、真实 IM 演练仍待核验。

本轮入口矩阵全量验证（2026-09-30）：五类入口 terminal 写入故障覆盖加入后，完整 `npm test -- --reporter=dot --bail=1 --pool=threads --maxWorkers=1` 通过（801 个文件通过、1 个跳过；6997 项通过、106 项跳过）；`npx tsc --noEmit --pretty false -p tsconfig.electron.json` 与 `git diff --check` 通过。其他入口故障点、生产 cutover 零命中观测及 IM 现场演练尚未完成。

本轮补齐 Hosted pre-dispatch claim 清理故障（2026-09-30）：真实 SQLite + Hosted handoff 新用例先验证 runtime 组装失败后 session claim 归还、对应 FIFO queue 行清除，后续 turn 可取得所有权。测试中确认既有 finally 已释放 claim 并删除队列项；最初误把空闲 claim 容器行存在当成残留，按真实持久化语义校准断言后通过，无生产代码改动。`npx vitest run electron/runtime/hostedTurnHandoff.test.ts electron/database/sessionTranscript.test.ts --reporter=dot --bail=1` 通过（43 项），Electron TypeScript 检查及 `git diff --check` 通过。剩余入口故障组合、生产 cutover 零命中观测及 IM 现场演练仍未完成。

本轮远端 Runtime 恢复隔离 TDD（2026-09-30）：先以两个独立 SQLite 数据库复用相同 requestId，分别持久成功结果与失败 terminal；RED 证明模块级结果 Map 把第一库的 `ok:true` 缓存错误返回给第二个 Runtime。现将短期重复调用结果缓存按 `TurnRuntime` 实例隔离，并在新 Runtime 从持久化 `failed` terminal 恢复时显式返回 `outcome: failed`。同轮增加 failed/cancelled/timed-out 持久终态恢复且 provider 不重跑的回归；`npx vitest run electron/remote/turnExecutionAdapter.test.ts electron/remote/imRemoteAgent.test.ts electron/wechat/weChatRemoteAgent.test.ts --reporter=dot --bail=1` 通过（223 项），Electron TypeScript 检查及 `git diff --check` 通过。生产零命中观察、IM 现场故障演练和其余入口完整故障组合仍未完成。

本轮全量复验（2026-09-30）：上述缓存隔离与远端终态重启回归合入后，`npm test -- --reporter=dot --bail=1 --pool=threads --maxWorkers=1` 通过（801 个文件通过、1 个跳过；7003 项通过、106 项跳过）；`npx tsc --noEmit --pretty false -p tsconfig.electron.json` 与 `git diff --check` 通过。部署后零命中观测、真实 IM 服务现场故障演练和计划列出的其余入口 × 故障点组合仍未完成。

本轮 Driver 多目标端到端恢复补测（2026-09-30）：此前分别有 Hub 多目标恢复与 Butler run 部分状态映射测试，但缺少同一持久化场景贯穿二者的文件 SQLite 重启验证。新增集成回归先由真实 Hub 向一个目标成功、另一目标 deferred；重开 SQLite 后仅补发 deferred 目标、不重发已送达目标，最后再同步 Butler run 到 delivered 并记录实际收敛时间。`npx vitest run electron/butler/taskStore.test.ts --reporter=verbose --bail=1` 通过（10 项）；该缺口属于测试覆盖，不需生产代码修复。阶段 0–2 其他入口/故障组合以及生产零命中观测、IM 现场演练仍未全部闭环。

本轮启动恢复文件 SQLite 补测（2026-09-30）：新增进程关闭/重开真实 SQLite 的组合回归，按生产启动顺序恢复 TurnCoordinator 投影，再运行 session transcript 对账。未进入执行的旧 claim 安全释放，执行中过的 claim 转为 `commit_uncertain`；下一 turn 被阻断，另一次 SQLite reopen 后 fence 仍持久存在。`npx vitest run electron/runtime/sessionTranscriptStartup.test.ts --reporter=verbose --bail=1` 通过（11 项），`npx tsc --noEmit --pretty false -p tsconfig.electron.json` 与 `git diff --check` 通过；本地状态机通过，剩余计划门槛仍包括生产零命中观测、IM 现场演练及入口完整故障组合。

本轮 Butler 已执行工具后的 checkpoint 故障补测（2026-09-30）：新增真实 Butler Hosted `read_file` 工具执行后再注入 SQLite transcript checkpoint 失败，验证唯一 `tool-call-started`/`tool-call-finished` 与 canonical completed terminal；run 记为 interrupted、执行 claim 持久为 `commit_uncertain`。关闭并重开数据库后以同一 idempotency key 重试，入口拒绝重复触发，provider 与工具执行器调用次数均不增加。聚焦 RED/GREEN 覆盖缺口后，`npx vitest run electron/butler/butlerInvoker.test.ts --reporter=dot --bail=1` 通过（46 项），Electron TypeScript 检查及 `git diff --check` 通过。Desktop、Feishu、WeChat、Approval 对应真实工具副作用 × checkpoint 故障组合及部署/现场门槛尚需逐项完成。

本轮 Desktop 已执行工具后的 checkpoint 故障补测（2026-09-30）：新增真实 Desktop IPC + 文件 SQLite Hosted `write_file` 组合，注入 transcript checkpoint 失败并重启数据库后用原 request/turn 重试；断言文件内容存在且执行器仍仅调用一次、provider 仍仅两次，canonical 工具开始/完成各一条。新用例独立通过（1 项）；与 `request_usage` 用例合跑也通过（2 项），Electron TypeScript 检查和 `git diff --check` 通过。但包含全部用例时，该 `request_usage` 测试两次超时（先 15 秒、再 30 秒）；排除新用例后其余 120 项通过，表明全文件组合仍有待定位的交互/资源问题，不能视作通过。Feishu、WeChat、Approval 真实工具副作用 × checkpoint 故障组合，以及部署/现场门槛仍未完成。

本轮复查并隔离 Desktop 集成测试状态（2026-09-30）：真实工具 + 文件 SQLite 重启用例嵌入大型 Hosted 集成文件时与共享运行状态产生交互，曾使当前回归或后续 request_usage 用例在首次 IPC execute 等待超时；单独运行则通过。将回归移入独立 `claudeStreamHandlers.checkpointRestart.test.ts` 模块并为其独立初始化 Electron/Runtime/mock 夹具后，新用例 148ms 通过，原 `claudeStreamHandlers.hostedIntegration.test.ts` 全部 120 项通过；两文件联合复验也通过（121 项）。Electron TypeScript 检查、`git diff --check` 通过。此隔离消除了已观察的套件失败；不是生产行为修复。Feishu、WeChat、Approval 真实工具副作用 × checkpoint 故障组合，以及部署/现场门槛仍未完成。

本轮 Feishu/WeChat checkpoint 重启阻断复验（2026-09-30）：将两条 lane 的 checkpoint 故障用例改用文件 SQLite；首次 Hosted 执行后关闭/重开数据库、创建新 Runtime，再以相同 AcceptedTurn/requestId 重进。重试断言先 RED：恢复入口实际返回 `SESSION_TRANSCRIPT_RECONCILIATION_REQUIRED`，证明该 turn 在完成启动对账前必须 fail closed；调整断言后验证 provider 仍只调用一次、checkpoint 持续 `commit_uncertain`。`npx vitest run electron/remote/imRemoteAgent.test.ts --reporter=dot --bail=1` 全文件 137 项通过；Electron TypeScript 检查和 `git diff --check` 通过。此处验证的是重启后 fence 阻止重执行，启动对账完成后的恢复行为仍需另测；生产零命中观测和真实 IM 现场演练仍未完成。

本轮全量验证（2026-09-30）：Desktop checkpoint 重启用例隔离到单独测试模块、Feishu/WeChat 文件 SQLite 重启 fence 回归后，`npm test -- --reporter=dot --bail=1 --pool=threads --maxWorkers=1` 通过（802 个测试文件通过、1 个跳过；7007 项通过、106 项跳过，188.84 秒）。Electron TypeScript 检查与 `git diff --check` 通过。阶段 0 生产指标聚合/零命中观察、阶段 1 入口完整故障矩阵、阶段 2 IM 现场故障演练仍未闭环；无生产遥测或真实 IM 现场证据时，阶段 3 兼容读取路径不能删除。

本轮补齐 Approval 工具派发后的 checkpoint 故障（2026-09-30）：在 Approval 真实 Hosted handoff 中让 provider 调用 `read_file`，通过真实 executor 读取证据后触发 SQLite transcript checkpoint 写入失败；断言 executor 一次、provider 两轮、canonical `invocation-completed` 与 uncertain checkpoint，并验证文件 SQLite 重启后同 request 重进不再调用 provider/executor，继续按既有审批契约返回 `unavailable`。Approval 全文件 43 项通过，Electron TypeScript 检查和 `git diff --check` 通过。当前本地 checkpoint 后工具路径已覆盖 Desktop、Butler、Feishu/WeChat（入口 fence 重启）和 Approval；各入口启动对账完成后的恢复联测、剩余终态/投影故障组合、生产零命中观测和 IM 现场演练仍未完成。

本轮补充真实重启对账回归（2026-09-30）：此前 matching checkpoint 的启动释放用例使用内存数据库，而进程重启用例覆盖的是缺失 entry 时保持阻断。新增文件 SQLite 用例模拟 checkpoint entry 已提交、后续确认丢失并遗留 uncertain fence；重开数据库并完成启动对账后，entry 仍匹配、checkpoint 收敛为 `ready`，下一 turn 可取得 session claim。`npx vitest run electron/runtime/sessionTranscriptStartup.test.ts --reporter=verbose --bail=1` 通过（12 项）。这是既有启动恢复契约的重启覆盖，不引入产品行为；入口级完整故障矩阵、部署后生产零命中观察与真实 IM 演练仍未完成。

本轮补齐 Feishu/WeChat 已派发工具后的 checkpoint 故障重启断言（2026-09-30）：扩展两条 lane 的文件 SQLite Hosted 用例，在 checkpoint 失败前由 provider 真实调用 `read_file` executor 并取得工具结果，再完成第二轮模型响应；重启后相同 request/turn 继续被 uncertain fence 拒绝，provider 共两次、读取 executor 一次，canonical History 有唯一工具完成事实。与启动对账测试合计 149 项通过，Electron TypeScript 检查和 `git diff --check` 通过。随后完整 `npm test -- --reporter=dot --bail=1 --pool=threads --maxWorkers=1` 通过（802 个文件通过、1 个跳过；7009 项通过、106 项跳过，188.60 秒）。此项只补验证现有“不自动重放”约束；入口其余故障组合、生产部署后的 cutover 零命中观察及真实 IM 演练仍未完成。

本轮续补 IM 启动对账分支（2026-09-30）：Feishu/WeChat 文件 SQLite Hosted checkpoint 故障回归现在分别覆盖缺失 entry 与“entry 已提交但进程遗留 uncertain fence”。第二种按生产启动顺序恢复持久 TurnCoordinator 投影，再调用 transcript 对账；仅匹配 entry 分支释放 fence，并确认下一 turn 可取得 claim；两种分支都断言原 provider 和真实 `read_file` executor 不会重复执行。首次联测因夹具未执行 persisted-turn restore 而由启动未完成门槛正确拒绝，补齐生产恢复顺序后四个用例通过；`electron/remote/imRemoteAgent.test.ts` 与启动恢复文件合计 151 项通过，Electron TypeScript 检查及 `git diff --check` 通过。没有生产代码或产品行为改动。

本轮本地自动化范围全量复验（2026-09-30）：最新完整 `npm test -- --reporter=dot --bail=1 --pool=threads --maxWorkers=1` 通过（802 个测试文件通过、1 个跳过；7011 项通过、106 项跳过，200.80 秒）；Electron、renderer、shared TypeScript 检查及 `npm run build:electron` 通过。旧数据分类与本机可自动验证的入口故障边界已逐项审计；Windows 专属执行、生产零命中观察和真实 IM 服务现场演练依用户范围说明不作为本轮必达项。生产零命中仍是删除兼容 History/旧 ID 读取路径的必要门槛，故保留这些适配，阶段 3 的生产条件性收缩待后续观测完成。

本轮 v5 跨会话阻断修复（2026-09-30）：会话绑定 History 现拒绝 owner 不匹配的 exact `turnId` 流；远端完成结果改按规范 `turnId` 缓存；同一 Runtime 的 requestId 映射可容纳多个活动 turn，含糊路由 fail closed，生产事实回调均带规范 turnId。新增 SQLite exact stream 隔离、同 Runtime 共享 requestId 并发事实路由及 A/B 顺序重试回归，先复现串流与串结果，再验证隔离。History、remote adapter、TurnRuntime、Feishu、WeChat、Butler、Desktop Hosted 相关 8 个文件共 208 项通过；Electron TypeScript 检查和 `git diff --check` 通过。

本轮文档一致性与定向复验（2026-09-30）：将契约矩阵中过期的“旧数据分类未完成”和“入口覆盖尚未齐备”更新为当前本地证据支持的范围；明确本地验收按契约边界验证，不声称覆盖全笛卡尔积。`npx vitest run electron/runtime/sessionTranscriptStartup.test.ts electron/runtime/sessionHistoryCutover.test.ts electron/runtime/sqliteAgentHistory.test.ts electron/claudeStreamHandlers.checkpointRestart.test.ts electron/remote/imRemoteAgent.test.ts electron/butler/butlerInvoker.test.ts electron/confirmation/approvalAgent.test.ts electron/driver/deliveryHub.test.ts electron/butler/taskStore.test.ts --reporter=dot --bail=1` 通过（9 个文件、373 项）；Electron、renderer、shared 类型检查及 `git diff --check` 通过。业务源码未改动。Windows 专属自动任务、生产部署观察/零命中证明、真实 IM 外部服务演练和以生产证明为前提的兼容路径删除仍按用户范围排除本轮必达；兼容路径保持不变。

本轮阻断评审修复（2026-09-30）：评审报告指出失败轮会用单独的当前 user 覆盖已有 checkpoint。新增 `success -> failure -> next turn` 回归先 RED，确认版本 2 checkpoint 丢失前一轮 user/assistant；随后失败终态提交改为保留执行前 checkpoint 消息并追加当前 accepted user，不带入失败轮部分 assistant 或工具输出。`npx vitest run electron/runtime/hostedTurnHandoff.test.ts electron/database/sessionTranscript.test.ts electron/runtime/sessionHistoryCutover.test.ts --reporter=dot --bail=1` 通过（3 个文件、49 项）；Electron TypeScript 检查、`npm run build:electron` 与 `git diff --check` 通过。契约矩阵同步记录策略与回归证据。

本轮 v6 跨会话执行身份修复（2026-09-30）：新增两个会话共享 `requestId`、不同 `turnId` 的并发 Hosted 回归；旧实现先 RED，第二个会话在 `InvocationRuntime.acquireLease` 抛出 `invocation already leased`。执行 lease 与聊天取消信号注册/清理改用规范 `turnId`（旧调用缺省回退 `requestId`），主进程 TurnRuntime 取消回调及 Approval 超时取消均传该 turn 身份。取消注册表回归确认取消 B 不会 abort A。首次全量运行还发现 Desktop Hosted 与 Butler 两条旧集成测试仍用 requestId 模拟取消；切换为 turnId 后对应全文件分别 120、46 项通过。聚焦测试 4 个文件 70 项通过，`npx tsc -p tsconfig.electron.json --noEmit` 通过；最终 `npm test -- --reporter=dot --bail=1 --pool=threads --maxWorkers=1` 通过（802 个文件通过、1 个跳过；7017 项通过、106 项跳过，189.61 秒），`git diff --check` 通过。Windows 专属、生产观察和真实 IM 现场验证按本轮范围排除。

本轮 v7 跨会话状态隔离修复（2026-09-30）：工具撤权登记原先仅按外部 `requestId` 键控，两个会话共享 ID 时后登记会覆盖先登记；现在保留外部 ID 作为校验/展示关联，撤权状态、事件订阅及清理由规范执行 `turnId` 隔离。远端会话切换守卫清理也从按 requestId 清除全部会话改为精确清除 `(sessionId, requestId)`。两条报告复现分别先 RED，再通过定向回归；工具执行/撤权及守卫相关 6 个测试文件 88 项通过，Electron TypeScript 与 agent-sdk typecheck 通过。未加入产品功能；Windows 专属验证仍不作为本机必达项。

本轮 v9 阻断修复（2026-09-30）：成功 transcript checkpoint 统一剔除 system 消息；旧 checkpoint 读取时同样先去除 system，再只将本轮 system 指令组装进 Hosted 请求。失败终态使用本次 invocation 最新的 canonical `transcript-compacted` 消息投影，并确认保留当前 accepted user；若投影无效则将执行标记为 `commit_uncertain`，保持 session 栅栏，不以压缩前请求恢复旧 transcript。兼容撤权转发测试补传规范 execution `turnId`。三轮 system 指令轮换及“压缩后 provider 失败、后续轮读取压缩 checkpoint”回归已覆盖；system 持久化与压缩恢复用例分别在对应旧逻辑下 RED，再 GREEN。定向测试 47 项、完整 npm test（802 个文件通过、1 个跳过；7026 项通过、106 项跳过）、Electron/Agent SDK 类型检查、Electron 构建及 `git diff --check` 均通过。生产零命中观察、真实 IM 演练与入口故障矩阵剩余组合仍未完成；Windows-only 测试不作为本机必达项。
