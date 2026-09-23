# 安全审批 Agent：并发、配额与可观测性 — 问题清单

**版本：** 0.1
**日期：** 2026-09-21
**状态：** 问题清单，待评审
**关联文档：**
- [tool-confirmation-top-level-design-v2.md](./tool-confirmation-top-level-design-v2.md)（确认机制顶层设计）
- [../develop/approval-agent-shortest-path-plan.md](../develop/approval-agent-shortest-path-plan.md)（审批 Agent 落地计划）
- [../develop/desktop-auto-approval-plan.md](../develop/desktop-auto-approval-plan.md)（桌面自动审批档位）
- [../develop/architect/confirmation-answerer-and-auto-approval-design.md](../develop/architect/confirmation-answerer-and-auto-approval-design.md)（设计母本，硬不变量 I1–I5）

> **本文性质**：对当前 main 实现（安全审批 Agent 链路）的问题清点，只陈述「问题 / 表现 / 原因 / 危害」四要素与代码事实，**不含解决方案与改进建议**。文末「待决议题」为需求方提出的质疑，本文不给结论。

---

## 1. 范围与基线

### 1.1 覆盖的实现链路

| 环节 | 代码位置 |
| --- | --- |
| 回答者派生 | `src/shared/policy/policyEngine.ts`、`src/shared/policy/policyPackages.ts` |
| 门控与递归守卫 | `electron/confirmation/toolCallGate.ts` |
| 通道分发 | `electron/toolChatLoop.ts`、`electron/confirmation/channels.ts` |
| 审批执行链 | `electron/confirmation/approvalAgent.ts`、`electron/skills/bundled/securityApprovalSkill.ts` |
| 裁决通道 | `electron/confirmation/agentChannel.ts` |
| 调用准入 | `electron/runtime/callAdmission.ts`、`electron/runtime/callAdmissionGate.ts`、`electron/storage/callAdmissionStore.ts` |
| 卡片渲染 | `src/renderer/components/Chat/ToolCallCard.tsx`、`src/shared/assistantFactAggregator.ts` |

### 1.2 排除项（本次不计为问题）

| 项 | 排除理由（需求方判定） |
| --- | --- |
| 审批 Agent 无「拿不准就交还用户」第三态 | 远程链路与定时任务不一定有人可兜底，该第三态并非必然缺陷，本轮不计 |

---

## 2. 问题清单

编号 `P-n` 按主题分组：3.1 并发与准入、3.2 模型档位、3.3 界面与可观测。

### 3.1 并发与准入

#### P-1 审批为串行阻塞，且资源不足时以「拒绝」形式失败

**问题**：安全审批的等待是同步阻塞的，且拿不到准入资源时立即失败，而非等待。

**表现**：
- 一个审批会把同一条 assistant 消息里**后续所有工具调用**（包括纯只读工具）一起阻塞，直到该审批返回；
- 同一 turn 内不可能出现两个并行审批；
- 多会话并发、单回合多工具的场景下，审批成为关键路径上的单点；
- 拿不到准入资源时，审批立即失败，用户看到「安全审批服务暂不可用，已按拒绝处理」，并表现为工具调用被拒绝。

**原因**：
- 调用点是同步 `await`：`electron/toolChatLoop.ts:1623` 的 `for (const tu of toolUses)` 内逐个 `await`，`electron/toolChatLoop.ts:2163` `await channelFor({...}).request(confirmReq)`；无挂起/唤醒（parked/resume）机制，turn 与准入票据在等待期间被持续占用；
- 审批侧声明**不排队**：`electron/confirmation/agentChannel.ts:199` 准入请求携带 `disposition: 'reject'`；
- 准入判定中速率维度对审批**无豁免**：`electron/runtime/callAdmission.ts:judgeAdmission` 第 ① 层先判 `windowStarts >= globalHourlyStarts`（→ `rate-limit`）与 `laneWindowStarts[lane] >= laneHourlyStarts[lane]`（→ `lane-hourly-quota`）；`approvalReservedSlots` 只注入第 ② 层并发上界（全局 interactive 上界与 lane 并发上界）；
- `shortage()` 按 `disposition` 映射处置，`reject` 即立即返回拒绝，故 `queueLimit` 对审批路径实际不生效；
- 通道把「拿不到票」统一映射为 `cause='unavailable'`（`electron/confirmation/agentChannel.ts`），与「裁决为否」在类型上可区分，但在用户可见层不可区分（见 P-8）。

**危害**：
- 安全审批是**多会话、多工具调用的关键节点，天然要处理高并发**；当前「串行处理 + 拒绝服务」的组合不满足该并发特征；
- 并发或高频场景下的结果不是「稍慢」，而是安全裁决不可用 → 工具执行被拒；
- 被拒范围超出审批本身：同一 turn 后续不需要审批的调用也一并失败；
- 阻塞期间 turn 不推进、不落盘、无恢复机制，仅靠取消中断。

#### P-2 审批双计调用配额

**问题**：一次审批在配额维度被计入两次。

**表现**：桌面链路上，每个「包含审批的回合」消耗 2 个单位的小时配额。

**原因**：
- 外层受理计入一次：`electron/outbound/outboundAcceptor.ts:262` 对 `lane: 'desktop'` 取票，`applyAdmit` 会计入 `windowStarts` 与 `laneWindowStarts`；
- 审批内层再计入一次：`electron/confirmation/agentChannel.ts:199` 的嵌套准入 `lane` 继承等待方 lane，`applyAdmit` 同样计入；
- `applyRelease`（`electron/runtime/callAdmission.ts`）只回退 `activeInteractive` / `activeBackground` / `laneActive`，**不回退** `windowStarts` / `laneWindowStarts`。

**危害**：按默认值（`globalHourlyStarts=120`、`laneHourlyStarts.desktop=120`、`automation=30`）估算，标称 120/h 实际约支撑 60 个「带审批的回合」；automation lane 30/h 约支撑 15 次「带审批的管家任务」。

#### P-3 lane 级配额不可配置

**问题**：lane 维度的并发与小时配额无配置入口。

**表现**：`laneMaxConcurrent` / `laneHourlyStarts`（含 `automation: 30/h`）在代码中固定，无法通过配置调整。

**原因**：`electron/storage/callAdmissionStore.ts` 的 `POLICY_CONFIG_KEYS` 仅覆盖 5 个键——`globalMaxConcurrent`、`backgroundMaxConcurrent`、`globalHourlyStarts`、`queueLimit`、`approvalReservedSlots`；lane 级参数定义在 `electron/runtime/callAdmission.ts:DEFAULT_ADMISSION_POLICY`，无读取路径。

**危害**：无法通过配置缓解 P-1；配额相关故障缺少配置侧的回旋空间。

#### P-4 配额窗口的恢复语义依赖「下一次请求到达」

**问题**：小时窗口的重置由请求到达触发，而非到点自动重置。

**表现**：`windowStart` 在滚动时被置为当前时刻，窗口起点随之漂移；重启进程不会清零配额计数。

**原因**：`rollAdmissionWindow` 在 `electron/runtime/callAdmissionGate.ts` 的 `tryAdmit` / `wakeNext` 内被调用，仅在「距 `windowStart` ≥ 1h」时清零并把 `windowStart` 置为当前时刻；`resetActiveAdmissionOnStartup`（`electron/storage/callAdmissionStore.ts`）只清零活跃计数段，保留速率窗口与配额计数。

**危害**：实际可用配额略低于标称值；重启无法绕过限流（该项本身为设计意图，此处仅记录其恢复语义）。

### 3.2 模型档位

#### P-5 审批调用未使用快速模型与低思考强度

> **2026-09-22 需求调整：**审批默认暂时保留 `off`，不再要求本轮改为 `low`，优先控制延迟。下文关于「需求期望低档」的描述保留为原始问题记录，不再作为当前验收要求；独立快模型与模型配置问题仍需解决。参见[改进方案 §8、§16](../develop/security-approval-experience-improvement-plan.md)。

**问题**：审批调用的模型与思考档位未按审批场景收敛。

**表现**：
- 审批请求使用的模型等于**外层会话模型**，而非审批默认快模型；
- 思考强度为 `off`，与需求期望的「低」档不一致；
- 每次裁决新建 `internal`/`hidden` 内部会话并跑完整 Loop（≤3 轮侦查 + 收束轮），无会话复用与历史裁决复用。

**原因**：
- 模型被外层覆盖：`electron/confirmation/approvalAgent.ts` 定义 `DEFAULT_APPROVAL_MODEL = 'claude-haiku-4-5-20251001'`，但 `electron/toolChatLoop.ts:2196` 在装配时传入外层 `model`（该处注释亦记录「Profile 机制落地后按 `approvalProfileId` 解析独立快模型」）；
- 思考档位：`electron/confirmation/approvalAgent.ts:293` 传 `effort: 'off'`（注释为「子调用零成本档」），`AgentReasoningEffort` 取值为 `'off' | 'low' | 'medium' | 'high'`（`src/shared/agent/invocation.ts:85`），即现状低于需求期望的 `low`；
- 输出预算 `options: { maxTokens: 2048 }`（`electron/confirmation/approvalAgent.ts:307`）。

**危害**：每次裁决的延迟与成本与主模型同量级，放大 P-1、P-2 的并发与配额压力；与「审批是高频、延迟敏感的子调用」这一定位不符。

### 3.3 界面与可观测

#### P-6 裁决卡存在时间极短，且不承载可读内容

**问题**：审批裁决期间的卡片一闪而过，用户无法看清。

**表现**：用户观察到卡片出现后迅速被替换/消失，看不清内容。

**原因**：
- 卡片为**只读提示行**：`src/renderer/components/Chat/ToolCallCard.tsx:439-447` 为提前 `return`，仅渲染一行 `confirm.autoAnswering`（文案「正在由审批 Agent 自动裁决，无需手动确认」，`src/renderer/i18n/resources/zh-CN/chat.json:146`），无按钮、无「仅此一次」、无 memoryTier 选择器；
- 该行以 `sa-chat-inset-code`（代码块样式）渲染为独立元素，与随后的普通工具行不是同一视觉元素，两者互相替换；
- 不承载细节：diff 预览由 `electron/toolChatLoop.ts:2080` 的 `useDiff` 控制，仅当 `answerer === 'user'` 或存在 `autoApproveFallback` 时为真；浮动确认通知同样限定 `answerer === 'user'`（`electron/toolChatLoop.ts:2134`）；
- 存在时长等于审批耗时，审批毫秒级返回时该卡片可见时长趋近于 0。

**危害**：用户无法得知发生过什么、哪个工具被裁决；观感为「弹出一个卡又消失了」。

#### P-7 deny 的人话理由未到达实时渲染层

**问题**：审批拒绝的理由在实时渲染路径上不可见。

**表现**：被拒绝的工具卡片可能只显示「已拒绝」。

**原因**：
- 事件载荷仅带机器码：`electron/toolChatLoop.ts:2371` 的 `tool-confirmed` 携带 `reason`，其类型为 `LegacyConfirmationRejectReason`，取值为 `'user' | 'policy' | 'timeout'`（初值见 `electron/toolChatLoop.ts:1999`），非人话文案；
- 该值写入 `rejectionReason`（`src/shared/assistantFactAggregator.ts:146`），但渲染端**零消费**该字段；
- 卡片拒绝文案取自 `record.result`：`src/renderer/components/Chat/ToolCallCard.tsx:634-638` 取 `record.result?.userMessage ?? record.result?.error ?? t('tool.rejected')`；
- 而 `record.result` 在 rejected 时不会被写入：`tool-result` 分支带 `terminalTool(tool.status)` 守卫（`src/shared/assistantFactAggregator.ts:159`，`terminalTool` 含 `'rejected'`），且 `tool-confirmed(rejected)` 发出于 `electron/toolChatLoop.ts:2371`，`recordToolResult(...)` 在其后的 `:2519`；
- 真正的人话理由在 `electron/toolChatLoop.ts:2501-2507` 拼接（含 `agentDenyHowToApproveGuidance()`，见 `electron/toolChatLoop.ts:671`），该内容进入模型上下文与持久化，但未下发渲染层。

**危害**：拒绝不可解释、不可操作；「如何获批」的指引仅模型可见，用户看不到；与「拒绝必须可解释」的设计目标不符。

**待核实**：历史会话重建/切换会话后的恢复路径是否从持久化 result 还原出理由（重建投影白名单未逐项核实）。本文对「实时路径不可见」的判断为代码推理结论。

#### P-8 四种结束原因在 UI 层不可区分

**问题**：不同类型的安全拒绝在界面上呈现为同一状态。

**表现**：`agent-deny`（Agent 判定危险）、`unavailable`/`timeout`（**根本没拿到裁决**，含配额耗尽）、`policy_denied`、`user-denied` 全部显示为「已拒绝」。

**原因**：
- 渲染层只按 `record.status` 分支（`src/renderer/components/Chat/ToolCallCard.tsx:634-638`），不消费 cause；
- cause 仅落在持久化字段 `notExecutedReason`（`src/shared/domainTypes.ts:561-565`，取值含 `user_rejected` / `agent_denied` / `confirm_timeout` / `policy_denied`），该字段 UI 不展示。

**危害**：
- 「系统限流/服务不可用」被用户与统计口径感知为「审批判定危险」，安全指标与用户认知同时失真；
- 与设计母本的明确要求冲突：`cause` 是判定结果维度，「拿到裁决」与「没拿到裁决」不得共用表现（见 [confirmation-answerer-and-auto-approval-design.md](../develop/architect/confirmation-answerer-and-auto-approval-design.md) §7）。

#### P-9 审批路径下信任/记忆点击被静默丢弃

**问题**：审批路径的确认响应中，信任与记忆写入被丢弃且无任何反馈。

**表现**：用户点击「信任并允许」类操作后无任何反馈；信任不生效。

**原因**：
- `electron/ipc/agentProtocolIpc.ts:106` 取得 `pendingConfirm = isPendingConfirm(payload.requestId, payload.toolUseId)`；
- 四个信任分支（`trustCommand` / `trustDomain` / `trustActDomain` / `trustMcp*`）均以 `pendingConfirm` 为前提（`electron/ipc/agentProtocolIpc.ts:118-190`）；
- 当 `approved && !pendingConfirm` 且携带信任字段时，仅落一条 `tool.confirm.trust_rejected_no_pending` 的 warn 日志，**UI 无提示**；
- 审批路径不注册 waiter（`AgentChannel.request` 不经过 `electron/toolConfirmRegistry.ts`），故其请求必然无 pending；`submitToolConfirmResponse` 在无 waiter 时直接 return，无副作用；
- 纵深防御的前提是审批路径本不渲染交互按钮（`src/renderer/components/Chat/ToolCallCard.tsx:439`）。

**危害**：失败被静默处理，用户可能误以为已获得信任；同时该设计会掩盖「卡片归属异常」类问题。

**待核实**：实际观察到的卡片归属（审批只读卡 / 人工交互卡 / pending 被取消的残留卡）尚未确认。

#### P-10 「没拿到裁决」的归因需跨两个日志文件

**问题**：判断一次审批失败的真实原因需要关联两个独立日志。

**表现**：无法从单一位置直接区分「配额耗尽」与「服务故障」。

**原因**：
- 准入拒绝走 Agent 日志：`electron/runtime/callAdmissionGate.ts` 的 `auditEvent` 经 `logAgentEvent` 落 `admission.rejected`（含 `cause`）/ `admission.queued` / `admission.deferred` / `admission.degraded`；
- 裁决结果走安全审计日志：`electron/confirmation/agentChannel.ts` 落 `confirm.outcome`（`cause='unavailable'`），写入独立文件 `SecurityAudit-{YYYYMMDD}.log`；
- 两者需通过 `requestId` 的 `:approval` 后缀（`agentChannel.ts` 中的 `innerRequestId`）手工关联。

**危害**：排障与指标统计成本高；「配额不足」易被误读为「审批判定危险」。

---

## 4. 待决议题（需求方提出，本文不结论）

| # | 议题 | 相关事实 |
| --- | --- | --- |
| Q-1 | **安全审批为什么需要计入调用配额？** 该问题需要重新审视 | 审批与普通调用共用同一 `AdmissionPolicy` 与同一状态；`judgeAdmission` 的速率维度对 `role='approval-answerer'` 无豁免；审批同样计入 `windowStarts` / `laneWindowStarts`（见 P-1、P-2） |
| Q-2 | **安全审批是否应当受配额约束？** 这是本组问题的核心 | 配额耗尽的后果直接表现为安全裁决不可用、工具执行被拒（见 P-1、P-4、P-8） |

---

## 5. 待核实项汇总

| # | 待核实内容 | 影响 |
| --- | --- | --- |
| V-1 | 配额/准入问题缺少实测样本：本机 `logs/` 无任何 `admission.*` 事件；`logs/SecurityAudit-20260904.log` 中的 `confirm.outcome` 均为 `lane=desktop, actor=system` 的人工卡路径 | P-1、P-2 目前为代码推理结论；是否实际影响体验待数据验证 |
| V-2 | 拒绝理由在会话重建/切回后是否可见（重建投影白名单未逐项核实） | P-7 的「不可见」范围 |
| V-3 | 实际观察到的卡片归属：审批只读卡 / 人工交互卡 / pending 被取消的残留卡 | P-6、P-9 的结论归属 |

---

## 6. 背景补充（非问题，用于界定上述表现的范围）

- 桌面 `standard` 档将「询问」升级为「自动」：`ask → auto-evaluator`（`src/shared/policy/policyPackages.ts` 的 `DESKTOP_TRANSFORMS`）；
- 仍走人工确认卡的仅三类：`locked` 的 ask 规则（`toolkit-act-ask`、`lark-high-impact-ask`、`lark-unknown-ask`）、`locked confirm-every-time`、`extraction-failed` 兜底；
- IM 链路（wechat / feishu）`standard` 为恒等映射，`ask` 仍为 `answerer='user'`；
- automation 的回答者恒为 `agent`（`src/shared/policy/policyEngine.ts:askAnswererFor`）；
- 因此「工具调用不再询问用户」当前是桌面与 automation 链路的现象，并非全局行为。
