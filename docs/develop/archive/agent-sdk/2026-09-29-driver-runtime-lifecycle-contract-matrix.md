# Driver 与 Runtime 生命周期契约矩阵

更新：2026-09-29。本文记录本地代码核对结果，兼容路径明确标为 legacy；矩阵不是生产命中率报告。

## 入口身份矩阵（实现核对）

| 入口 | requestId 生成/持有 | turnId 当前来源 | Runtime History stream 当前 ID | 兼容/差距 |
| --- | --- | --- | --- | --- |
| Desktop | IPC requestId 与 TurnCoordinator 接受记录 | TurnCoordinator `prepare` | 新写入为 `turnId`；读时兼容旧 requestId stream | `AcceptedTurn` 已传入 AgentInvocation 与 Hosted handoff；assembler 从其 turnId 补全 trace，接受时固定 transcript version；旧 stream 继续按历史映射读取 |
| Feishu | 入站路由持有 requestId | TurnRuntime `prepare` | 新 router 路径为 `turnId` | Router 由已持久 prepared turn 构造 `AcceptedTurn` 并传入远端 Runtime。未装配 TurnRuntime 的旧调用仍兼容 requestId |
| WeChat | 入站路由持有 requestId | TurnRuntime `prepare` | 新 router 路径为 `turnId` | Router 由已持久 prepared turn 构造 `AcceptedTurn` 并传入远端 Runtime。未装配 TurnRuntime 的旧调用仍兼容 requestId |
| Butler | task run 持有 requestId | TurnRuntime `prepare` | 新数据为 `turnId` | 从持久 prepared turn 构造 `AcceptedTurn`，并传入 AgentInvocation 与 Hosted handoff |
| Approval | AgentChannel 创建 requestId | 当前 requestId 兼作内部 turnId | turnId；requestId 经 AcceptedTurn 台账解析 | 构造并传入 `AcceptedTurn`；v27 SQLite 台账持久保存 requestId/turnId/session/冻结快照 |

目标规则：接受后形成不可变 `AcceptedTurn`；新数据使用 `invocationId = turnId`。取消 API 可以继续以 requestId 入站，但必须经持久映射解析。旧 History stream id 按持久化映射读取，不通过猜测重命名。

## 规范终态矩阵

| 事实来源 | canonical outcome | 当前/目标投影规则 |
| --- | --- | --- |
| `invocation-completed` | `completed` | 只在 transcript checkpoint 提交成功后允许下轮读取 |
| `invocation-failed` | `failed`；明确 timeout 归 `timed_out` | sidecar/UI 是投影，不能覆盖 terminal 事实 |
| `invocation-interrupted` 且 `payload.status=cancelled` | `cancelled` | 不要求 session ledger；仅提交产品策略允许且验证过的内容 |
| `invocation-interrupted` 且重启原因 | `interrupted` | 开放/未验证 stream 不可读取为输入；终态确认后只将已接受 user message 写入 transcript，保留 `interrupted` 事实 |
| History 与 checkpoint CAS/存储结果不明 | `commit_uncertain` | 阻断该 session，保留事实并等待幂等对账，不重跑模型或工具；启动时只自动收敛已有匹配 checkpoint 的记录；数据库层已有按 turn/version 追加审计决策并提交已确认 checkpoint 的原语，尚未暴露为产品设置页或 IPC API |

当前新增 `decodeTerminalOutcome` 已供 Hosted handoff、History 选择和 SQLite TurnCoordinator 启动恢复使用；canonical timeout 在调用方保持 `timed-out` 并在 transcript 存为 `timed_out`，真实 SQLite 重启测试覆盖恢复不折叠该 outcome。启动恢复只会把已有匹配 checkpoint 的 uncertain 记录收敛为 ready，不会推断或补造缺失提交。数据库级 transcript 对账原语要求调用方提供 canonical outcome 与经确认的 transcript 投影，并以 operator、理由、turn 和 version 为条件写入审计和 checkpoint；该原语仅存在于数据库层，不构成设置页、IPC 或 renderer 功能；interrupted outcome 也会保真记录，输入策略仍是只保留已接受 user message。v27 AcceptedTurn 台账支持 requestId 到 canonical turn History stream 映射，重复接受复用首次冻结的 config/version 快照。生产 JSONL 诊断记录 cutover stage/outcome/version 与恢复计数，不含消息正文。旧数据边界已按本地可验证的存储/读取规则分类：持久 AcceptedTurn 映射到 canonical turn；无映射 legacy stream 仅由旧 requestId 读取适配处理；session 归属未知的 History 不进入 transcript 索引；旧 `invocation-parked` 只保留解码；cutover 对顺序、当前 user、重复内容和工具调用/结果配对做校验。生产中各兼容分支的实际命中率仍须部署后观测，不能由本地分类测试推断。

启动 transcript 对账现在会直接检查 TurnCoordinator 持久投影：仍有非终态 turn 或 streaming assistant residue 时跳过 claim/checkpoint 收敛。turn restore/recovery 抛错也作为恢复未完成处理。该门槛覆盖 `recover()` 静默返回但投影没有终结的情况，避免仅凭无异常返回值就认定启动恢复完成。

## 上下文保留策略

- user message：无论 completed/failed/cancelled 均保留到规范 transcript（作为已接受指令事实）；终态提交时还必须保留该轮开始前 checkpoint 中所有已提交消息。
- completed assistant 与其已完成工具结果：仅验证成功且终态提交完成后提交。
- cancelled/failed/timed_out 的当前轮部分 assistant 内容、未完成工具调用及工具结果：不进入下一轮 transcript；此前已提交的 user/assistant/tool 消息继续保留，不能因当前轮失败而丢失。
- 已派发工具产生的副作用仍以工具 ledger 为事实；不能因消息未进入 transcript 而自动重放。

实现进度：SQLite checkpoint 原语已实现上述 CAS 与幂等键；Hosted handoff 对接 checkpoint，session claim 另有持久 FIFO admission queue。入口接受快照已贯通各新路由，Approval 映射也通过持久 AcceptedTurn 台账恢复；assembler 以 AcceptedTurn.turnId 为新入口的权威 stream ID，缺少重复 turnId 参数时也不会让普通 History 回退 requestId。数据库层的 transcript 对账原语只能由受信任的主进程调用，当前没有设置页、preload/IPC 或 renderer 入口。Butler 设置页仍使用原有任务执行完成提示；不确定送达的界面提示及新增界面均不属于本迭代范围。阶段 2 只核验持久台账及既有投影不误报确定结果。本地自动化已覆盖五类入口的稳定身份、执行/失败/取消路径，以及真实 SQLite History terminal 写入失败；五类入口的真实工具副作用后 checkpoint 故障均断言不重放。文件 SQLite 启动恢复测试另覆盖未执行 claim 释放、执行中 claim 阻断、缺失 checkpoint 保持阻断、匹配 checkpoint 对账后恢复；Feishu/WeChat 入口还把匹配/不匹配启动分支贯穿重启重试。Driver journal 有单独的多目标部分成功、deferred、TTL、supersede、并发派发和 uncertain 恢复覆盖。这些测试按契约边界组合，不构成每个入口 × 每种终态 × 每个存储故障时序的笛卡尔积；真实 IM 外部接受与本地确认之间的现场故障仍须部署演练。Windows 专属测试不在本机自动化覆盖范围，也不作为本轮本机必达项。

## 入口审计投影补充（2026-09-30）

SQLite canonical History terminal 的故障边界现在有真实适配器 + SDK 集成覆盖：终态插入前数据库拒绝时落单一 `invocation-failed` 且不报告 turn-finished；提交后确认丢失时从 SQLite 回读匹配 terminal，保持单一 `invocation-completed` 并正常返回。两种路径 provider 都只调用一次。

Desktop IPC Hosted 入口也覆盖了 completed terminal 的真实 SQLite 拒绝：SDK 持久化唯一 `invocation-failed`，Hosted transcript 只包含已接受 user message，provider 不重跑。

相同 History terminal 插入故障已通过 Hosted + SQLite 执行路径覆盖五类入口：Desktop、Feishu、WeChat、Butler、Approval 均只持久化一个 `invocation-failed`，不重跑 provider，并按既有入口契约返回失败；非 completed transcript 不收敛当前轮未完成 assistant/tool 内容，并保留此前已提交 transcript 与当前 accepted user。

Feishu `agent_done.success` 现同时检查 Agent `ok` 与 pending-confirm 状态；回归测试覆盖 Agent 已失败但不待确认的路径，验证 Runtime 终态为 `source-failed` 且审计不报成功。该用例先在旧逻辑下失败，再通过修正成功条件通过。WeChat 原有实现已按 `result.ok && !result.pendingConfirm` 判断。

Butler run 写入 `deliveredAt` 的时机现由真实 SQLite 入口回归约束：只有 `delivered` 记录确认时间；`pending`、`failed-degraded`、`delivery-uncertain` 不伪记送达时间。

远端 adapter 对 Hosted canonical `interrupted` 的投影现在落为 TurnCoordinator `recovered`，业务层保留 `outcome: interrupted` 与 error 原因；真实 SQLite 测试验证首次执行及同 request 重试不重复执行 provider。

远端 adapter 的重复请求结果缓存现在按 `TurnRuntime` 实例隔离。此前模块级 requestId 缓存会让不同 SQLite/Runtime 实例复用相同 requestId 时串回另一实例的结果；真实双数据库回归先 RED，再验证恢复以本实例持久 terminal 为准。新 Runtime 对持久 `failed`、`cancelled`、`timed-out` terminal 返回稳定失败结果，不重新执行 provider。

重启后的 remote `recovered` terminal 现在向调用方返回稳定的 `interrupted` outcome；若持久 terminal 含 error 则原样返回，否则提供通用中断原因。真实 SQLite 重启测试确认 provider 不会重跑。

SQLite startup recovery now reconciles a stale `executing` assistant tool checkpoint from a completed canonical History only when History provides a complete, fully settled tool-call snapshot. The database recovery primitive still refuses to mark a pending tool call completed without that snapshot.

Butler Hosted projection failure persistence now has an entry-level SQLite assertion: when canonical History ends in `invocation-interrupted` with `tool-projection-failed`, the automation run also ends as `failed` and retains that cause. This verifies the persisted task result alongside the existing canonical ledger recovery checks.

Hosted `commit-uncertain` is preserved as a distinct persisted TurnOutcome across remote execution and process restart; it is not consumed as ordinary `source-failed`. The dedicated internal `source-uncertain` fact settles the assistant checkpoint and immediately notifies the existing chat projection with the canonical error cause. Desktop Hosted results carry that outcome from the handoff through TurnRuntime. The renderer ends its active state as an error rather than falsely completing it, while the main process retains the precise `commit-uncertain` terminal. Real SQLite + TurnRuntime RED/GREEN regressions verify restart recovery returns the same cause without rerunning the provider.

Butler run projection preserves a Hosted transcript `commit-uncertain` as the existing `interrupted` automation-run status, with the canonical error text. The entry-level SQLite regression first observed the old `failed` status, then passed with the corrected state mapping.

An end-to-end Butler fault injection now fails only the version-incrementing transcript checkpoint write after a real Hosted model execution. It asserts one provider call, canonical History `completed`, transcript checkpoint and execution claim `commit_uncertain`, and the Butler run `interrupted` with the SQLite failure cause.

Desktop reload projection preserves a recovered unfinished turn as `interrupted`/failed instead of mapping it to completed. The IPC regression first failed against the old mapping; the renderer reuses its existing error state and cause handling. Focused projection tests and the full Vitest suite pass.

The invocation runtime now exposes only the lease acquisition/release path used by production. Repository search found no caller for its park/resume methods; approval waiting continues through the separate `applicationAdmission` port. The dead methods and capacity state were removed with a RED/GREEN contract test, while legacy `invocation-parked` History decoding remains available for old streams.

All five entry paths have real SQLite Hosted checkpoint-failure coverage. Desktop IPC returns the finalized `commit-uncertain` result for the main-process executeTurn adapter; Approval asserts its existing fail-closed `unavailable` result; both IM lanes retain the finalized error cause; Butler asserts its persisted run state. For each path, provider execution remains single and the checkpoint/execution fence is durable. The Desktop, Butler, and Approval tests also execute a real tool before the checkpoint fault and verify no replay after reopen; both IM lanes cover that boundary with file SQLite and additionally verify matching-checkpoint recovery versus missing-entry blocking. This is contract-boundary coverage rather than the full Cartesian product of every entry, terminal, and persistence fault.

Blocking review regression (2026-09-30): a successful turn followed by a failed turn used to replace the session checkpoint with only the failed turn's accepted user message. The failure path now builds its checkpoint from the immutable pre-turn checkpoint plus the current accepted user message, excluding the failed turn's partial assistant/tool output. A RED/GREEN `success -> failure -> next turn` test verifies both stored transcript contents and the exact next Hosted request history.

Approval additionally exercises its real Hosted `read_file` executor before checkpoint failure. After file SQLite restart, the same request remains fail-closed and does not call provider or executor again; the complete Approval test file passes with this assertion.

跨会话隔离回归：session-bound History 对 exact `turnId` 流校验 owner；同一 Runtime 中共享 requestId 的活动 turn 按规范 turnId 路由事实，缺少 turnId 且存在歧义时拒绝处理；远端终态结果缓存按 turnId 隔离。并发 A/B 事实投影和 A 重试由真实 SQLite + 单 Runtime 用例覆盖。

同一 Runtime 中两个 session 共用 requestId、各自 turnId 不同的并发 Hosted 执行现以真实 `InvocationRuntime` 回归覆盖：租约使用规范 turnId，两个请求均可完成。聊天取消注册/清理及主进程 TurnRuntime 取消回调同样按 turnId 关联；取消 turn B 的回归断言 turn A 的 AbortSignal 保持未中止。Approval 超时取消使用 accepted turnId。

## 跨会话状态隔离补充（2026-09-30）

工具撤权 registry 以规范执行 `turnId` 作为内部 key，事件同时携带外部 `requestId` 与 `executionId`；Hosted 查询、撤权订阅与清理由 turn 精确匹配。同一 `requestId` 可登记不同 turn/lane，清理一方后另一方仍可撤权。远端 session-switch 运行守卫按 `(sessionId, requestId)` 精确清理，不再遍历删除共享 requestId 的其他会话状态。v7 两条报告复现均以 RED/GREEN 覆盖；定向测试 6 文件 88 项、Electron typecheck 与 agent-sdk typecheck 通过。撤权登记必须显式提供 executionId；旧查询/清理转发仍可省略 executionId，但共享 requestId 存在多项时清理会拒绝歧义，避免误删其他活动 turn。

v9 checkpoint 修复：持久 session transcript 不保存 system 指令；既有 checkpoint 读取时剔除 system，当前 system 只加入当前 Hosted 请求。失败路径读取当前 invocation 已提交的最新压缩 transcript，并验证其包含 accepted user；投影无效时保留 uncertain fence，不覆盖压缩前状态。工具撤权 registration 的 `executionId` 为必填；兼容转发测试显式提供 `turnId`。三轮 system 变化与压缩失败续轮回归覆盖，完整测试、Electron/Agent SDK 类型检查及 Electron 构建通过。
