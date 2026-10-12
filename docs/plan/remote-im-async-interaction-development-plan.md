# 远程 IM 异步交互：本机开发与测试计划

> 依据：[`docs/develop/remote-im-async-interaction-design.md`](../develop/remote-im-async-interaction-design.md) v0.2、其引用的 [`docs/requirement/remote-im-async-approval-security-requirement.md`](../requirement/remote-im-async-approval-security-requirement.md) v1.1，以及历轮设计/开发计划评审报告。
> 范围：只列可在本机工作区通过代码、SQLite 临时数据库、fake adapter/provider 和自动化测试完成的开发与验证；不包含真实飞书/微信账号联调、外部审批、发布、部署或人工 UX 验收。
> 日期：2026-10-08
> 计划状态：尚未开始。

## 执行约定（必须遵守）

- 本计划是本项工作的唯一执行清单。必须按编号和依赖顺序推进；不得跳项、并行执行后续项或执行计划外的开发、重构和测试。
- 每次只推进一个最小任务。开始前将该任务从 `- [ ]` 改为 `- [～]`，保存计划，再进行对应开发或测试；同一时刻最多一项为 `- [～]`。
- 任务达到其验收条件后，先将它改为 `- [x]`，在其下记录本机命令与结果/文件证据，保存计划后再开始下一项。
- 所有行为改动遵循 RED → GREEN → REFACTOR：先写一条能因目标行为缺失而失败的测试，再实现最小改动；重构不得改变行为。每个任务只承担一个可单独判断的行为。
- 测试失败若由语法、夹具、导入或本机环境导致，不得标记 RED 完成；修正测试/环境问题后重跑。实现或验证失败时保留 `- [～]`，记录首个错误和证据，不得越过该任务。
- 若发现任务需拆分，先只修改本计划，将拆分项插入当前任务之后并校正后续编号；不得先做计划外工作。
- 执行前记录 `git status --short`；只修改本计划任务明确列出的目标文件，不覆盖或清理已有工作区改动。发现目标文件存在未提交改动时，先记录并在其上做最小修改。
- 本计划中“本地测试”只使用 Vitest、临时 SQLite/文件、fake IM adapter 和 fake LLM/provider；不得调用真实 IM 服务、真实模型 API 或生产用户数据。

## 实施门槛（不是开发任务）

本计划以安全需求 v1.1 为实现基线；该需求已于 2026-10-08 通过需求复审，见第二轮复审报告。复审通过表示安全需求契约已获评审认可，不代表实现、测试或生产启用门禁已完成。v1.1 已明确 OQ-1（默认 24h、合法待办重启保留）、OQ-2（保留 pending、校验身份/epoch/TTL 后补发）、OQ-5（普通追认不写缓存，独立记忆选择默认关闭），这些不得再作为未决阻塞项或由实现者改写。安全基础实现可按已明确契约推进。

产品/需求决策 OQ-1–OQ-8 均已确认，不再有待用户决策的 OQ：待办默认 24h、重启保留；通知失败保留待办并在同身份下次入站重试、不续期；pending 不阻止切换 session、追认回 originSessionId；envelope 不加密但存于主进程受控隔离存储；首版不做“批准并记住”；通知逐条发送；用户以 `批准 <编号>` / `拒绝 <编号>` 回复，编号最多两位十进制数字，在身份范围内绑定 todo 与通知版本且永久不复用；当前版本不支持群聊。两位数字最多提供 100 个历史唯一编号/身份，耗尽后必须 fail closed，不得复用旧编号。剩余工作是计划中的实现、自动化验收和生产启用门禁；证据通过前不得开放异步审批。

## 0. 本机基线与需求追踪

### 0.1 工作区基线

- [ ] **0.1.1** 记录执行开始时分支、`git status --short` 和未跟踪文件；在本节任务证据中列出既有改动。
- [ ] **0.1.2** 记录 Node 与 npm 版本、依赖安装状态，以及 SQLite/Electron 构建可用性；只记录本机事实，不安装或升级依赖。
- [ ] **0.1.3** 核对目标文档和代码基线：develop v0.2、安全需求 v1.1、历轮设计/开发计划评审报告、队列数据库操作、IM router、remote agent、session lease、确认模块；记录文档修订日期、要求映射、实际文件路径与测试文件。

### 0.2 本机测试基线

- [ ] **0.2.1** 运行并记录队列/迁移基线：`npx vitest run --project electron electron/database/operations.test.ts electron/database/migrations.agentHistory.test.ts electron/ipc/agentProtocolIpc.updateQueuedMessage.test.ts`。
- [ ] **0.2.2** 运行并记录远程运行时基线：`npx vitest run --project electron electron/remote/remoteAgentRegistry.test.ts electron/remote/remoteTaskController.test.ts electron/remote/turnExecutionAdapter.test.ts electron/remote/imProcessedStore.test.ts electron/remote/imRemoteAgent.test.ts electron/remote/remoteAuthorizationRegistry.test.ts`。
- [ ] **0.2.3** 运行并记录安全确认基线：`npx vitest run --project electron electron/confirmation/approvalAgent.test.ts electron/confirmation/agentChannel.test.ts electron/confirmation/safetyRecheck.test.ts`。
- [ ] **0.2.4** 运行并记录飞书/微信路由基线：`npx vitest run --project electron electron/feishu/remoteCommandRouter.test.ts electron/wechat/weChatCommandRouter.test.ts`。
- [ ] **0.2.5** 运行并记录 Electron 编译基线：`npm run build:electron:incremental`。
- [ ] **0.2.6** 在本计划内建立“需求/评审验收项 → 后续测试文件/测试名 → 任务编号”追踪表；覆盖设计验收项、上游安全需求全部 OQ-1–OQ-8、P1-1…P1-7、G1–G4/F/G 条款及历轮开发计划评审，包含群聊拒绝、容量限制、通知内容安全、取消/修订派发线性化。

  | 需求/评审验收项 | 后续测试文件 / 测试场景 | 任务 |
  |---|---|---|
  | develop v0.2 §12：入站快速受理、准入后先持久化、重复回调幂等 | `electron/feishu/remoteCommandRouter.test.ts` / durably accepts an authenticated inbound before asynchronously dispatching its Loop；`electron/wechat/weChatCommandRouter.test.ts` / persists a repeated channel message once and schedules one asynchronous wake | 4.1.1–4.1.4、4.1.8–4.1.9 |
  | §12：session busy 时持久排队，同 session 不并发共享上下文 | `electron/remote/wakeEventDispatcher.test.ts` / persists an event arriving during a Loop without starting a concurrent Loop | 3.2.1–3.2.5、4.1.6–4.1.7 |
  | §12：计划确认绑定真实同会话入站；未确认不执行 | `electron/remote/imWorkflowSkillHarness.test.ts` / persists complex plans for confirmation, clarifies missing information, and revises changed goals | 4.2.1–4.2.6 |
  | §12：release/wait 不忙循环；不可用有界退避，新事件可重新唤起 | `electron/remote/wakeEventDispatcher.test.ts` / does not spin on a released pending Inbox message and wakes again only for a new event；`electron/remote/wakeEventRetryPolicy.test.ts` | 2.3.1–2.3.5、3.2.6–3.2.7 |
  | §12：只确认本 run eventId；交错入站/continuation、崩溃恢复不吞事件/不重复续接 | `electron/database/wakeEvents.test.ts` / keeps an inbound event appended during a run pending when that run finalizes；`electron/remote/wakeEventDispatcher.test.ts` / recovers a persisted pre-dispatch event after database reopen and retries continuation idempotently | 2.2.7–2.2.13、3.2.3–3.2.5 |
  | §12：IM 与 desktop queue 隔离、桌面原有顺序/UI/claim 保持 | `electron/database/operations.queueScope.test.ts`；`electron/database/operations.test.ts` | 1.3.1–1.3.7、4.1.5、4.1.10、7.2.2 |
  | §12：deferred 零副作用、保留 checkpoint 并释放槽；独立步骤可推进、依赖步骤阻塞 | `electron/confirmation/deferredApprovalAdapter.test.ts` / persists only eligible approve, returns deferred after persistence, and never dispatches；`electron/remote/imWorkflowSkillHarness.test.ts` / preserves independently completed work beside a deferred step | 6.5.1–6.5.6 |
  | §12：追认只走安全 ingress；精确原调用复检/恢复，不被普通消息误消费 | `electron/remote/deferredApprovalIngress.test.ts` / accepts only an exact current notification binding and passes trusted identifiers to idempotent resume；`electron/confirmation/deferredEnvelopeStore.test.ts` / binds canonical args, content versions, execution context, and format versions | 6.5.7–6.5.13、6.6.1–6.6.3 |
  | §12：单飞/全局额度；取消与修订的先后线性化 | `electron/remote/imTaskCancelDeferredDispatch.integration.test.ts` / cancellation commits first, invalidates todo/request, and keeps the final executor at zero calls；`electron/remote/imTaskReviseDeferredDispatch.integration.test.ts` / retains only an explicitly mapped unchanged step and dispatches its original envelope | 3.1.1–3.1.5、5.1.1–5.1.6、6.4.9–6.4.12、6.5.17–6.5.19 |
  | §12：创建/关联/派发/结果/outbox 崩溃恢复，未知副作用不重放 | `electron/confirmation/deferredResumeRequestStore.test.ts`；`electron/confirmation/deferredExecutionResultStore.test.ts`；`electron/remote/imWorkflowSkillHarness.test.ts` / restores a safely completed deferred result before continuing pending steps through a fresh safety gate | 6.2.1–6.2.6、7.1.3、7.2.3 |
  | §12：不发送 Thinking/token/tool logs/envelope；阶段通知节流、终态可查 | `electron/remote/deferredApprovalNotification.test.ts` / is self-contained, separates user delegation from untrusted material, and omits commands, paths and credentials | 7.1.1–7.1.3 |
  | §12：飞书/微信共用 contract；重启、出站失败、分类失败安全恢复 | `electron/confirmation/imChannel.test.ts`；`electron/remote/deferredApprovalNotificationDelivery.test.ts` / retains failed delivery as undelivered and retries only on the same authenticated scope with a rotated code/version；`electron/remote/deferredApprovalClose.integration.test.ts` / keeps the durable fence after a crash and reconciles it after reopen before fallback | 4.1.5、6.6.4–6.6.8、7.2.1–7.2.4 |
  | 安全需求 OQ-1：默认 24h、重启保留、按创建时刻过期 | `electron/confirmation/deferredTodoStore.test.ts` | 6.1.6 |
  | OQ-2：通知失败保留 pending；同身份下次入站复检后补发，不延 TTL | `electron/remote/deferredApprovalNotificationDelivery.test.ts` / does not retry after todo TTL and never extends its expiry | 6.6.6–6.6.8 |
  | OQ-3：pending 不阻止 session 切换；resume 回 originSessionId | `electron/remote/deferredResumeCoordinator.test.ts` / persists an authenticated resume request while the session lease is busy, leaving todo pending without dispatch | 5.2.1–5.2.6、6.5.7–6.5.9 |
  | OQ-4：envelope 不加密但主进程隔离存储、完整性失败拒绝执行 | `electron/confirmation/deferredEnvelopeStore.test.ts` / snapshots mutable inputs and rejects missing, damaged, unsupported, or tampered envelopes | 6.1.3–6.1.4 |
  | OQ-5：无“批准并记住”；普通追认永不写缓存 | `electron/confirmation/deferredApprovalCachePolicy.test.ts` / never grants long-term cache writes to ordinary todo outcomes | 6.3.9–6.3.10 |
  | OQ-6：逐待办发送自包含通知 | `electron/remote/deferredApprovalNotification.test.ts` / is self-contained, separates user delegation from untrusted material, and omits commands, paths and credentials | 6.6.4–6.6.6 |
  | OQ-7：1–2 位编号、身份/owner/todo/version 绑定、永久不复用、耗尽 fail closed | `electron/remote/deferredApprovalIngress.test.ts` / allocates monotonic non-reusable two-digit codes and fails closed when exhausted | 6.5.11–6.5.12、6.6.1–6.6.3 |
  | OQ-8：拒绝群聊 | `electron/feishu/remoteCommandRouter.test.ts` / routes approval replies to the safety ingress before Inbox or the Skill；`electron/wechat/weChatCommandRouter.test.ts` / routes approval replies to the safety ingress before Inbox or the Skill | 4.1.1–4.1.4、6.7.1 |
  | P1-1：持久 epoch、撤销跨重启/重绑级联，写失败阻断 | `electron/remote/remoteAuthorizationRegistry.test.ts`；`electron/remote/remoteAuthorizationRevocationCoordinator.test.ts` | 6.4.1–6.4.8 |
  | P1-2：完整不可变 envelope、正文/字节/附件/上下文变化失效，恢复无需模型 | `electron/confirmation/deferredEnvelopeStore.test.ts` / binds canonical args, content versions, execution context, and format versions | 6.1.3–6.1.4、6.5.1–6.5.6 |
  | P1-3：普通追认零 cache.write，outbound/模糊答复不升级 | `electron/confirmation/deferredApprovalCachePolicy.test.ts` / never grants long-term cache writes to ordinary todo outcomes | 6.3.9–6.3.10、6.3.11 |
  | P1-4：复检/消费/派发竞态、未知结果不重放、旧 lease owner 不能派发 | `electron/remote/imTaskCancelDeferredDispatch.integration.test.ts` / recovers a crash after cancel request commit but before todo invalidation without allowing old dispatch；`electron/remote/imTaskReviseDeferredDispatch.integration.test.ts` / invalidates the old invocation when the mapped step instruction changed | 3.1.5、6.2.5–6.2.6、6.5.17–6.5.19 |
  | P1-5：并行/乱序/旧通知/重复答复/同步卡/计划 Y 不错批 | `electron/remote/deferredApprovalIngress.test.ts` / rejects stale version, untrusted origin message, expired, duplicate and ambiguous parallel todo bindings | 6.5.11–6.5.12、6.6.1–6.6.3、6.6.7–6.6.8 |
  | P1-6：外流评级、材料攻击、长文本限制及逐次真人批准 | `electron/remote/deferredApprovalNotification.test.ts` / is self-contained, separates user delegation from untrusted material, and omits commands, paths and credentials | 6.3.11–6.3.12 |
  | P1-7：门禁证据、两级容量、关闭 fencing、通知脱敏 | `electron/confirmation/remoteAsyncApprovalGate.test.ts` / fails closed when the safety review is incomplete or any P1 control lacks evidence；`electron/confirmation/remoteAsyncApprovalGate.test.ts` / prevents old pending resume work from reaching dispatch once the durable gate is closing；`electron/confirmation/deferredTodoCapacity.test.ts`；`electron/remote/deferredApprovalNotification.test.ts` | 6.1.7–6.1.10、6.5.14–6.5.16、6.7.1–6.7.3 |
  | 安全需求 G1–G4、G5–G10：回答者/deferred/fallback、持久化、级联、审计、关闭记忆、通知脱敏、限额、委托相关授权分档及外流例外 | `electron/confirmation/imAsyncApproval.integration.test.ts` / wechat remains on the existing user answerer when rollout is off；`electron/remote/remoteAuthorizationRevocationCoordinator.test.ts`；`electron/confirmation/securityAuditLog.test.ts`；`electron/remote/deferredApprovalNotification.test.ts` | 6.3.1–6.3.12、6.4.1–6.4.12、6.6.9–6.6.10 |
  | 安全需求 §15.5 E2–E4：cause、脱敏、actor 归因 | `electron/confirmation/securityAuditLog.test.ts` | 6.6.9–6.6.10 |
  | §15.6 F1–F4：通知自包含、去绝对路径/完整命令、记忆授权边界 | `electron/remote/deferredApprovalNotification.test.ts` / is self-contained, separates user delegation from untrusted material, and omits commands, paths and credentials；`electron/confirmation/deferredApprovalCachePolicy.test.ts` / never grants long-term cache writes to ordinary todo outcomes | 6.3.9–6.3.10、6.6.4–6.6.8 |
  | §15.7 G1–G4：pending 超限、逐格 fallback、TTL=0、关闭后旧状态不可执行 | `electron/confirmation/deferredTodoCapacity.test.ts`；`electron/confirmation/imAsyncApproval.integration.test.ts` / undetermined from the real channel path follows the final gate disposition；`electron/confirmation/remoteAsyncApprovalGate.test.ts` / prevents old pending resume work from reaching dispatch once the durable gate is closing | 6.1.7–6.1.10、6.3.1–6.3.4、6.5.14–6.5.16 |
  | 历轮安全需求评审（2026-10-08 两轮）：P1 修订、v1.1/OQ 决议不得回退 | `electron/confirmation/remoteAsyncApprovalAcceptanceMatrix.test.ts` / maps every security acceptance row to an existing local test file and named case | 0.2.6、6.7.3、7.2.4 |
  | 历轮设计/开发计划评审：设计 §12 全覆盖、取消/修订派发线性化、容量限制与安全通知 | `electron/remote/imTaskControlWorkflow.e2e.test.ts` / does not execute an old deferred action after cancellation succeeds；`electron/remote/imEndToEndRecovery.test.ts` / persists a plan, waits with new inbox work, resumes the exact deferred call, and records completion once；`electron/remote/imTaskCancelDeferredDispatch.integration.test.ts` / dispatch begins first, then reports action_started while the real executor runs once；`electron/confirmation/remoteAsyncApprovalAcceptanceMatrix.test.ts` / maps every security acceptance row to an existing local test file and named case | 0.2.6、5.1.1–5.2.6、6.4.9–6.5.19、7.2.4 |

  > 表中尚不存在的文件和测试名是对应 RED/GREEN 任务的预定验收目标，必须在编号任务中实际创建并验证；不能仅凭本追踪表声称已通过。历史设计/开发计划评审报告未随当前基线提供，故以可见的两轮安全需求报告、design §12 与 requirement §15.8 作为可核验来源；发现报告后应在相应映射行补充其条款，而不改变既定执行顺序。

## 1. 队列作用域与 Inbox 持久化

### 1.1 `queueScope` 类型与规范化

- [ ] **1.1.1** RED：新增类型测试，queue scope 只允许 desktop 与 feishu/wechat IM 形式，不允许空 session/channel。
- [ ] **1.1.2** GREEN：定义并导出 queue scope 类型，使 1.1.1 通过。
- [ ] **1.1.3** RED：新增规范化单测，同一链路/session 生成稳定 scope，不同 channel 或 session 生成不同 scope。
- [ ] **1.1.4** GREEN：实现纯函数 scope builder/parser；单测覆盖分隔符转义、非法字段和稳定序列化。

### 1.2 SQLite 迁移与兼容

- [ ] **1.2.1** RED：新增迁移测试，旧版本 queued 桌面消息升级后仍归入 desktop scope，内容、顺序、receipt 和 turn 关联保持不变。
- [ ] **1.2.2** RED：新增迁移失败回滚测试，DDL/backfill 失败时 schema version 不推进且旧数据可读。
- [ ] **1.2.3** RED：新增重复迁移测试，迁移可重复运行且不重复创建索引或破坏数据。
- [ ] **1.2.4** GREEN：实现增量 schema migration，为共享队列记录与幂等 receipt 持久化 `queueScope`，确定性回填旧 queued 桌面消息，并建立 scope/status/order 复合索引。
- [ ] **1.2.5** 运行迁移专测及数据库迁移回归，确认旧消息、receipt、turn 关联和 schema version 均符合测试断言。

### 1.3 scope 隔离的数据库操作

- [ ] **1.3.1** RED：新增 list/get-next 测试，desktop scope 只返回 desktop 消息。
- [ ] **1.3.2** GREEN：将 list/get-next 查询增加必需 scope 条件与稳定排序，使 1.3.1 通过。
- [ ] **1.3.3** RED：新增测试，IM scope 只返回本 channel/session 消息；同 session 的 desktop、feishu、wechat scope 互不可见。
- [ ] **1.3.4** RED：新增测试，错误 scope 执行 claim/ack/release/reorder 时失败且任何队列状态不变。
- [ ] **1.3.5** GREEN：将 enqueue receipt、原子 claim、ack/release、reorder 与去重查询全部限定 scope，使 1.3.3–1.3.4 通过。
- [ ] **1.3.6** RED：新增兼容测试，桌面旧 IPC/API 调用在缺省适配时仍明确绑定 desktop scope，并保持 enqueue/get-next/reorder/claim turn 行为。
- [ ] **1.3.7** GREEN：接入 desktop scope 兼容适配器，使 1.3.6 通过；不允许数据库层隐式使用无 scope 的通用查询。

### 1.4 Inbox 生命周期与租约

- [ ] **1.4.1** RED：新增幂等 append 测试，同一 `queueScope + channel + channelMessageId` 重试返回相同稳定 ID，不产生重复消息。
- [ ] **1.4.2** GREEN：实现 scoped Inbox append 与幂等 receipt，使 1.4.1 通过。
- [ ] **1.4.3** RED：新增 payload 冲突测试，同一幂等键对应不同 payload 时返回明确冲突且不覆盖原消息。
- [ ] **1.4.4** GREEN：实现 fingerprint 冲突校验，使 1.4.3 通过。
- [ ] **1.4.5** RED：新增原子 claim 测试，并发 claim 同一消息最多一个成功，且只领取 pending 消息。
- [ ] **1.4.6** GREEN：实现带 scope/state 条件的原子 claim，使 1.4.5 通过。
- [ ] **1.4.7** RED：新增租约测试，未过期租约阻止其他 owner，过期后允许重领，租约过期不丢消息。
- [ ] **1.4.8** GREEN：实现 claim owner、expiry 与过期重领，使 1.4.7 通过。
- [ ] **1.4.9** RED：新增 ack/release/renew 测试，重复 ack 幂等，非 owner 操作失败，release 保留 pending，renew 只允许 owner。
- [ ] **1.4.10** GREEN：实现 ack/release/renew 状态转换，使 1.4.9 通过。
- [ ] **1.4.11** 新增文件数据库重开测试，验证 pending 消息、receipt 与 claim lease 按规定恢复。

## 2. 逐事件唤起存储与恢复

### 2.1 唤起事件合同

- [ ] **2.1.1** RED：新增类型测试，唤起事件至少包含稳定 `eventId`、唯一 `reasonKey`、session、受控事件类型/payload 引用、状态及时间戳。
- [ ] **2.1.2** GREEN：定义事件类型与运行时可信字段；只接受准入 IM 入站、安全恢复、显式 continuation，不接受模型指定的 scope/归属/游标。
- [ ] **2.1.3** RED：新增测试，同一 `reasonKey` 重复 append 返回原 `eventId`，不创建第二条事件。
- [ ] **2.1.4** GREEN：实现 `reasonKey` 唯一约束/幂等 append，使 2.1.3 通过。
- [ ] **2.1.5** RED：新增测试，不同 session 的事件不能被其他 session 的 list/claim/ack 操作看见或消费。
- [ ] **2.1.6** GREEN：实现 session 作用域校验，使 2.1.5 通过。

### 2.2 事件持久化 API

- [ ] **2.2.1** RED：新增原子 claim 测试，一次启动只领取可用事件，并为领取集合绑定 `runId`。
- [ ] **2.2.2** GREEN：实现原子事件 claim 和 run 绑定，使 2.2.1 通过。
- [ ] **2.2.3** RED：新增 ack 归属测试，Loop 只能确认自己领取且租约仍有效的 eventId。
- [ ] **2.2.4** GREEN：实现逐 eventId、runId、lease owner 条件确认，使 2.2.3 通过。
- [ ] **2.2.5** RED：新增租约测试，claimed 事件租约过期后可重领，旧 run 不能确认新 run 的事件。
- [ ] **2.2.6** GREEN：实现租约到期回收/重领与 owner fencing，使 2.2.5 通过。
- [ ] **2.2.7** RED：新增交错事件测试，Loop 领取后新入站事件保持 pending，旧 run finalize 不得确认它。
- [ ] **2.2.8** RED：新增 continuation 测试，Loop 运行中创建的 continuation 不属于当前领取集合，当前 finalize 不得确认它。
- [ ] **2.2.9** GREEN：实现“仅确认本 run 初始 eventId 集合”的 finalize API，使 2.2.7–2.2.8 通过；禁止消费高水位。
- [ ] **2.2.10** RED：新增空 Inbox 测试，`workflow.continue(reasonKey)` 创建 pending 事件并可触发后续 Loop。
- [ ] **2.2.11** GREEN：实现幂等 continuation append/outbox，使 2.2.10 通过。
- [ ] **2.2.12** RED：新增入站与 wake event 原子性/恢复测试：注入 outbox 提交中断后可补发同一事件且不重复。
- [ ] **2.2.13** GREEN：实现同事务写入或等价 transactional outbox/recovery scan，使 2.2.12 通过。

### 2.3 等待与无进展抑制

- [ ] **2.3.1** RED：新增测试，Skill release 同一 Inbox 消息并返回 wait 后，队列非空本身不会再次启动 Loop。
- [ ] **2.3.2** RED：新增测试，`waitForEvent` API 不接受模型提供的游标/事件代次，且不会 ack 未领取事件。
- [ ] **2.3.3** 实现 `workflow.waitForEvent`：只完成/释放当前 run 已领取的事件并结束 Loop；后续只响应新 eventId。
- [ ] **2.3.4** 新增有界退避测试，模型/执行器连续不可用达到最大尝试次数后停止自动重启并保留故障事实。
- [ ] **2.3.5** 新增恢复测试，达到退避上限后收到新的入站/恢复事件仍能唤起，不被旧失败状态或已 ack 事件吞掉。

## 3. Runtime 单飞调度与 Agent Loop 入口

### 3.1 共用 session 执行槽

- [ ] **3.1.1** RED：为 `remoteAgentRegistry` 新增测试，普通 Loop 和安全精确派发使用同一 session claim key 时互斥。
- [ ] **3.1.2** RED：新增并发测试，同 session 两个 continuation/两个安全恢复请求只能有一个持有槽；其他请求保持 durable pending。
- [ ] **3.1.3** RED：新增应用级额度测试，安全恢复派发与普通 Loop 共用 max-parallel 计数。
- [ ] **3.1.4** 实现或扩展执行租约入口，确保不改变现有桌面/远程调用的 owner-only release/cancel 规则。
- [ ] **3.1.5** 新增租约测试：取得槽失败不消费安全待办；租约释放、过期重领和旧 owner 迟到 release 均符合预期。

### 3.2 Loop dispatcher

- [ ] **3.2.1** RED：新增 dispatcher 测试，新入站事件到达空闲 session 时只启动一个 Loop。
- [ ] **3.2.2** RED：新增测试，Loop 运行期间新入站只落 Inbox/outbox，不启动共享上下文的并发 Loop。
- [ ] **3.2.3** RED：新增 finalize 测试，Loop 结束只 ack 本 run 已领取 eventId，执行中创建的事件保持 pending 并启动后续 run。
- [ ] **3.2.4** RED：新增 crash 测试，Loop 启动/完成提交前后重启不丢事件、不重复创建 continuation。
- [ ] **3.2.5** 实现 dispatcher：逐事件 claim、领取 run 记录、注入已领取事件引用、Loop finalize ack，以及完成后再次检查 pending 事件。
- [ ] **3.2.6** 新增 `waitForEvent` 的端到端 dispatcher 测试，pending Inbox 不会忙循环，新的 eventId 会唤起新 Loop。
- [ ] **3.2.7** 实现有界重试计数/退避调度的纯本机时钟接口，并新增 fake clock 测试覆盖最大尝试数、恢复和新事件重置策略。

## 4. IM 接入、入站幂等与 Skill 工作流

### 4.1 飞书/微信入站

- [ ] **4.1.1** RED：新增飞书路由测试，已鉴权入站先持久化到 IM queueScope 并创建幂等 wake event，再快速返回受理，不等待模型整轮完成。
- [ ] **4.1.2** GREEN：实现飞书 adapter/router 持久化受理与 dispatcher 接线；保留现有鉴权、群聊拒绝、owner 和限流检查顺序。
- [ ] **4.1.3** RED：新增微信路由等价测试，channel message ID 重复投递不重复 append/唤起。
- [ ] **4.1.4** GREEN：实现微信 adapter/router 同等接线；保留现有 owner-only、授权撤销和停止入口。
- [ ] **4.1.5** 回归：用真实数据操作层和 fake adapters 运行双渠道隔离测试，飞书、微信和桌面 scope 的 list/claim 互不可见。
- [ ] **4.1.6** RED：新增 session busy 测试，同 session 新消息不返回 `session_busy` 丢弃，而是持久化并等当前 Loop 结束；验收使用 fake dispatcher。
- [ ] **4.1.7** GREEN：调整 busy 分支为持久化受理并登记 wake event，使 4.1.6 通过。
- [ ] **4.1.8** RED：新增通道故障测试，消息持久化失败时不发“已受理”成功回执且不启动 Loop。
- [ ] **4.1.9** GREEN：实现入站提交失败的 fail-closed 路由结果，使 4.1.8 通过。
- [ ] **4.1.10** 回归：新增桌面测试，IM pending 入站不进入 desktop scope 消费、不作为额外 desktop transcript 消息显示；桌面 queued turn 的顺序、展示和 claim 行为保持不变。

### 4.2 Skill 注入与工具契约

- [ ] **4.2.1** RED：新增 invocation assembler 测试，IM Agent Loop 获得唯一 `im-task-orchestration` Skill 及 Inbox/workflow 工具，不改变桌面 Skill 选择。
- [ ] **4.2.9** 新增 fake-model Skill flow 测试：轻量问题直接答；复杂/重要假设生成计划并待确认；信息不足进入澄清；修改目标后更新计划 revision。
- [ ] **4.2.10** 新增等待确认测试：计划/澄清状态先持久化、输入消息 ack，然后 Loop 结束并释放 session 槽；回复到达后新 Loop 恢复 workflow。
- [ ] **4.2.11** 新增消息处理测试：当前 Loop 期间多条入站都持久化；下一 Loop 由 Skill 决定追加/新请求/澄清，runtime 不写死顺序语义。

## 5. 任务控制协调器（先对接 fake 安全待办端口）

本阶段只实现可信任务控制记录、revision/tombstone 与安全层 port；待办实际存储尚未在阶段 6 实现，因此本阶段测试使用 fake safety port。阶段 6 再接入真实待办 store。这样不要求越过编号顺序提前实现安全模块。

### 5.1 可信任务控制记录

- [ ] **5.1.1** RED：新增数据层测试，任务控制记录绑定 `workflowId/taskId/sessionId/planRevision`，workflow data 无法伪造可信字段。
- [ ] **5.1.2** 实现任务控制记录的版本化存取和 expectedRevision CAS；加入 scope/owner 校验测试。
- [ ] **5.1.3** RED：新增步骤映射测试，新 plan revision 只保留明确映射且未变化步骤，移除/替换步骤产生待失效集合。

### 5.2 取消/计划变更线性化

- [ ] **5.2.1** RED：新增 fake safety port 测试，task.cancel 在 dispatching 前调用关联待办失效端口，之后模拟追认不能进入派发。
- [ ] **5.2.2** RED：新增竞态测试，dispatching 已先开始时 cancel 返回动作已开始/不可撤回，不返回“全部停止”。
- [ ] **5.2.3** RED：新增 fake safety port 测试，task.revisePlan 移除/替换步骤后请求失效旧 revision 待办，保留步骤按映射处理。
- [ ] **5.2.4** RED：新增 crash/retry 测试，取消/修订 outbox 重复投递幂等；未完成撤销期间关联待办 fail closed。
- [ ] **5.2.5** GREEN：实现可信 `task.cancel` / `task.revisePlan` 工具边界及协调 outbox；Runtime 从 workflow 关联解析目标待办并调用安全层 port，使 5.2.1–5.2.4 通过。
- [ ] **5.2.6** 新增端到端 fake workflow 测试，取消成功后旧待办回复不会执行原动作。

阶段 5 的 fake safety port 任务只验证协调器合同。真实待办 adapter、恢复扫描和任务级线性化必须在阶段 6 完成，并在 6.6 的真实集成验收通过；不得将本阶段通过视为取消/修订安全已交付。

## 6. 上游安全待办与精确恢复（按子任务依赖决策与启用门禁）

### 6.1 安全待办数据与调用 envelope

- [ ] **6.1.1** RED：新增类型测试，待办绑定稳定 `invocationId/workflowId/taskId/stepId/planRevision/originSessionId`，并区分 pending/dispatching/consumed/invalidated/expired 等终态。
- [ ] **6.1.2** RED：新增 store 测试，channel/identityKey/owner/持久 `authorizationEpoch`、策略 `{ruleId,factsHash}` 或完整调用绑定不匹配时 fail closed；拒绝将进程内 generation 当持久授权依据。
- [ ] **6.1.3** RED：新增不可变 envelope 测试，绑定 `canonicalArgsHash/contentVersions/executionContextHash`、规范化算法与 schema 版本；覆盖正文/写入字节/附件变更、可变引用快照、缺失损坏/不支持版本/摘要不符均禁止执行。
- [ ] **6.1.4** 实现主进程受控 envelope 持久化与版本化恢复；按已定决策不加密存储，落实访问隔离、完整性校验与恢复；真实参数不可裁剪改写，且不进入 Skill 可写 workflow data、通知或普通日志。
- [ ] **6.1.5** RED：新增幂等测试，同一 invocationId 重复创建 deferred todo 返回同一 todoId，不生成重复用户通知/派发记录。
- [ ] **6.1.6** 实现待办 store 状态转换与关联撤销 API；TTL 默认 24h、合法 pending 重启保留，按原始创建时间过期且重启/补发/resume 不延长 TTL；另测边界。
- [ ] **6.1.7** RED：按安全需求配置新增单 session、单 identity pending todo 容量边界与并发创建测试；同 invocationId 幂等重试不重复占额，准备记录也计入预留。
- [ ] **6.1.8** GREEN：实现两级原子名额预留/释放和启动时过期及预留对账；使用需求已定的默认值（session=5、identity=10），配置值校验失败时 fail closed。
- [ ] **6.1.9** RED：新增超限出口测试，不能创建新 todo、不能派发动作，审批层产生 `deny(no-answerer)` 及安全回执；并覆盖 TTL=0 不挂起。
- [ ] **6.1.10** GREEN：接通待办容量拒绝与 TTL=0 到真实审批结果/fallback，验证并发下计数不超限、过期/失效/消费按定稿规则释放容量。

### 6.2 checkpoint 准备、关联与补偿基础（先于真实审批接线）

- [ ] **6.2.1** RED：新增状态机测试，`security_action_intent` 按 `prepared → todo_linked → checkpoint_committed → notified` 前进，未 `checkpoint_committed` 不可通知、追认或派发。
- [ ] **6.2.2** GREEN：实现稳定 `invocationId` 准备日志及状态转换；可用 fake safety port 驱动 store 边界，但 checkpoint 与准备日志必须落真实本地持久化层。
- [ ] **6.2.3** RED：分别注入待办落盘后、关联落盘前、checkpoint 提交前崩溃；恢复后唯一 todo 与唯一 workflow 归属可补齐或安全失效。
- [ ] **6.2.4** GREEN：实现按 `invocationId` 恢复扫描、todo 关联事务/outbox 与孤儿安全失效，使 6.2.3 通过。
- [ ] **6.2.5** RED：新增执行结果恢复测试，派发后、结果落盘前、outbox 投递前崩溃时，可查询结果则补偿，无法判定副作用则进入 `outcome_unknown` 且禁止自动重放。
- [ ] **6.2.6** GREEN：实现执行日志与结果 outbox，记录派发幂等键、真实结果/受控结果引用及完成事件，并以 todoId + invocationId 幂等，使 6.2.5 通过。

### 6.3 真实审批入口到 `deferred` 的映射与接线

- [ ] **6.3.1** RED：为共享确认结果契约新增测试，明确区分 approve、deny、undetermined、unavailable、timeout、unparsable 与 deferred；config-error、locked/critical、递归限制不得映射为 deferred。
- [ ] **6.3.2** GREEN：实现共享确认结果契约及其序列化/类型边界；只在上游定稿允许异步待办的裁决出口使用 deferred。
- [ ] **6.3.3** RED：使用 fake provider 经真实 `electron/confirmation/channels.ts`、`agentChannel.ts`、`agentSdkConfirmationPort.ts` 路径测试上述结果映射及现有 fallback，禁止直接注入预制 deferred 结果。
- [ ] **6.3.4** GREEN：实现审批 gate 到待办创建的内部 adapter 与安全结果映射，但保持生产 IM 回答者选择关闭；审批失败、不可判定或待办持久化失败时按上游定稿 fallback fail closed，不通知成功、不派发动作。
- [ ] **6.3.5** RED：新增回答者选择测试，IM channel 按已定稿策略选择安全审核 Agent；desktop 与 automation 仍选择既有回答者且行为不变。
- [ ] **6.3.6** GREEN：实现 `electron/confirmation/channels.ts`、`electron/confirmation/agentChannel.ts`、`electron/confirmation/agentSdkConfirmationPort.ts` 的关闭态接线与独立配置回退开关；生产 IM 回答者选择仍关闭，不提前改变默认路径。
- [ ] **6.3.7** RED：新增真实双渠道集成测试，从飞书/微信真实确认入口经 gate/adapter 到持久化待办；覆盖 approve、deny、undetermined、unavailable、timeout、unparsable，以及 config-error、locked/critical、递归限制不进入待办。
- [ ] **6.3.8** RED：新增飞书与微信入口集成测试，从真实确认调用链贯通至临时数据库待办；只验证关闭态/显式测试开关，不提前启用默认异步行为。
- [ ] **6.3.9** RED：新增缓存策略测试，普通待办追认永不 `cache.write`；验证拒绝/locked/critical/outbound 不进入记忆授权路径，desktop/automation 既有行为不变。
- [ ] **6.3.10** GREEN：首版不实现“批准并记住”；普通追认只授权当前动作且不得写长期缓存，本地测试验证没有任何待办追认路径产生长期授权写入。
- [ ] **6.3.11** RED：新增 G1–G4 与 A1–A12 裁决矩阵测试，覆盖批准/拒绝/无回答者/TTL=0/关闭开关、locked/critical、显式委托证据、材料诱导、截断限制及 outbound 必须逐次真人追认；关闭开关只测出口合同/fake port，不替代 6.5.16 的真实回退验收。
- [ ] **6.3.12** GREEN：完成裁决结果合同和关闭态回答者选择接线；默认保持 `remoteAsyncApprovalEnabled=false`，关闭态走既有 user 回答者；这里只验证出口合同，不声称已完成存量状态撤销/permit fencing；outbound 不可被 agent-approved、缓存或 auto-allow 绕过。

### 6.4 授权撤销级联接线

- [ ] **6.4.1** RED：为 `electron/remote/remoteAuthorizationRegistry.ts` 的待办 invalidator 与持久 authorizationEpoch 新增测试；epoch 不复用、单调推进，缺失/损坏不得回退为 0。
- [ ] **6.4.2** GREEN：实现持久 epoch、撤销协调记录和 schema migration；启动时先恢复配置/epoch/tombstone 并完成级联，之后才开放待办/恢复入口。
- [ ] **6.4.3** RED：新增提交失败测试，配置写入、epoch 提交或级联任一步失败时授权面派发 fail closed，不能报告撤销成功。
- [ ] **6.4.4** GREEN：实现 registry 到待办 store、resume_request、消费未派发 permit 及相关缓存的 invalidator 注册、注销和幂等级联。
- [ ] **6.4.5** RED：新增入口驱动测试：渠道关闭、owner/白名单变化、工作目录/敏感目录边界变化、session 删除分别触发关联待办级联失效。
- [ ] **6.4.6** GREEN：将上述实际撤销/删除触发点逐一接到 registry；保留执行前授权复检，不能以复检替代持久化撤销事实。
- [ ] **6.4.7** RED：新增恢复与竞态测试：授权关闭再开启、同 owner 解绑/重绑、配置改动后重启、撤销与 resume_request/消费并发时旧待办不得进入 executor。
- [ ] **6.4.8** GREEN：完成跨重启 epoch 校验与撤销/消费线性化；使用真实授权/会话/配置入口和临时数据库验收，不预置 invalidated 终态或 fake safety port。
- [ ] **6.4.9** RED：为阶段 5 task-control outbox 到真实 todo store 的 invalidation/dispatch guard adapter 新增测试；恢复扫描继续未完成的 cancel/revise 操作。
- [ ] **6.4.10** GREEN：接通阶段 5 task-control/outbox 与真实 todo store 及恢复扫描；交付持久 tombstone、未完成操作 fail-closed 状态及幂等失效。该任务不包含尚未实现的 resume dispatcher/真实派发竞态验收。
- [ ] **6.4.11** RED：用真实 task-control/store 验证 cancel/revise requested 落盘后、级联前崩溃，重启恢复幂等完成待办失效；恢复期间 store dispatch guard 拒绝关联待办。
- [ ] **6.4.12** GREEN：补齐 task-control 恢复扫描与 store 级 fail-closed dispatch guard，使 6.4.11 通过；真实 executor 派发边界验收留到 6.5 派发器完成后。

### 6.5 安全等待、追认与精确恢复

- [ ] **6.5.1** RED：新增 tool gate 集成测试，经真实审批入口返回 deferred 时原工具 executor 调用次数为零，todo 已持久化关联且 checkpoint 已提交。
- [ ] **6.5.2** RED：新增故障注入测试，todo 创建、关联提交或 checkpoint 提交任一步失败/崩溃时，不得通知、接受追认或派发原动作。
- [ ] **6.5.3** GREEN：实现 deferred 返回协议，将 `todoId + invocationId + checkpointRef` 交给 IM workflow，且不把可写 envelope 暴露给 Skill；仅在 checkpoint_committed 后允许通知/追认。
- [ ] **6.5.4** RED：新增部分推进测试，独立步骤经各自安全审核后可执行，依赖 deferred 动作的步骤不会越过依赖边。
- [ ] **6.5.5** RED：新增测试，同一 deferred 动作不可通过模型改参、换工具或新 Loop 重建调用来绕过阻断。
- [ ] **6.5.6** GREEN：实现安全等待边界与调用身份绑定；若 Agent Loop 无法表达/持久化独立步骤 checkpoint，则实现设计文档约定的降级路径，使 6.5.1–6.5.5 通过。
- [ ] **6.5.7** RED：新增追认入口测试，合法消息只持久化 resume_request；无 session lease 时 todo 保持 pending、不派发。
- [ ] **6.5.8** RED：新增普通 Loop/多个 resume request 并发测试，所有路径共用同一单飞租约，恢复请求不丢失。
- [ ] **6.5.9** GREEN：实现追认恢复调度，先取得 originSessionId session lease 与全局额度，再做最新撤销/授权复检、原子消费和原 envelope 派发，使 6.5.7–6.5.8 通过。
- [ ] **6.5.10** 新增 workflow 恢复测试，安全完成事件到达后 Skill 读取持久化结果/checkpoint，继续未完成步骤且每个新工具调用重新过安全审核。
- [ ] **6.5.11** RED：新增待办关联测试：channel、identityKey、owner、todoId、notificationVersion、可信 messageId 和最多两位十进制编号必须匹配；无编号 Y/N/同意、计划确认 Y、过期/旧版本/重复/并行待办答复均不得错批。
- [ ] **6.5.12** GREEN：实现专用安全 ingress 对 `批准 <编号>` / `拒绝 <编号>` 的严格解析和幂等消费；编号永久不复用并按通知版本轮换；编号耗尽时 fail closed，不把普通文本交给 Skill 猜测授权。
- [ ] **6.5.13** RED：新增策略复检测试：当前 deny/locked/critical 阻止；仍 require-confirm 时 ruleId/factsHash 必须匹配；auto-allow 不得跳过完整调用、epoch、环境与外流约束。
- [ ] **6.5.14** RED：对关闭协调器 port 新增单元/组件合同测试：必须按“阻断新派发→持久关闭事实/新 epoch/tombstone→失效 pending→取消 resume_request→撤销 consumed 未派发 permit→完成对账→回退 user”顺序执行；注入任一步失败均不得提前回退。
- [ ] **6.5.15** GREEN：实现关闭协调器、持久状态转换、恢复对账及 permit 撤销；该任务建立协议实现，但真实待办/派发器的存量状态集成验收仍在后续任务。
- [ ] **6.5.16** 回归验收：用真实 store、真实 resume dispatcher 和临时数据库（仅最终 executor 为 fake）验证关闭协议覆盖 pending、resume_request、consumed 未派发动作；关闭失败或重启中断时 fail closed，旧状态不可执行，成功对账后才回退 user。
- [ ] **6.5.17** 回归验收：用真实 `task.cancel` 与真实派发器验证取消先提交则 todo 持久失效且 executor 调用为零；真实派发先开始则准确报告动作已开始。
- [ ] **6.5.18** 回归验收：用真实 `task.revisePlan` 与真实派发器验证只保留可证明未变化的映射步骤；移除/替换步骤失效，无法证明映射时旧 revision 下全部未派发动作失效。
- [ ] **6.5.19** 回归验收：在最终复检、原子消费、真实派发 permit 边界交错 cancel/revise，并在 requested 落盘后、store 失效前崩溃重启；撤销先提交则不派发，派发先开始则不回执“全部停止”，恢复期间 fail closed 且幂等补做失效。

### 6.6 上游确认语法与渠道通知

- [ ] **6.6.1** RED：新增飞书与微信短编号 parser 测试，`批准 <1至2位编号>` / `拒绝 <1至2位编号>` 与普通消息、计划确认回复互不误识别；耗尽后不复用历史编号。
- [ ] **6.6.2** 实现安全追认专用 ingress；追认回复不能作为普通 Inbox 指令供 Skill 猜测授权。
- [ ] **6.6.3** 新增测试，身份不匹配、过期、已消费、已撤销或 plan revision 失配时不派发并返回正确安全结果。
- [ ] **6.6.4** RED：从真实通知构建器到 fake 飞书/微信 adapter 验证通知自包含且正文不含绝对路径、完整命令、凭据/token；不可信材料与用户委托分区呈现，重试补发仍使用安全内容。
- [ ] **6.6.5** GREEN：实现待办通知摘要最小化与可信/不可信证据分区；通知只使用安全 DTO 和允许字段，出站重试复用已审查内容，不从 envelope、工具日志或原始材料临时拼接。
- [ ] **6.6.6** 新增 fake adapter 测试，checkpoint_committed 后的待办通知/补发保留安全审计关联；出站失败不回滚任务且可重试。
- [ ] **6.6.7** RED：新增通知投递对账测试，创建待办后先生成审查 DTO；投递成功登记 notificationVersion/messageId，失败保留 pending+undelivered，仅由同一身份的下一条已鉴权入站触发重试，并在 epoch/TTL 复检通过后补发、登记新版本；未登记通知不得追认，重试不延长 TTL。
- [ ] **6.6.8** GREEN：实现投递对账、版本化补发与稳定通知 DTO；每条待办单独发送，补发轮换短编号，不能改变 todo 关联、真实调用和授权范围。
- [ ] **6.6.9** RED：新增审计脱敏与 actor 归因测试，审计无用户正文、完整命令、绝对路径；挂起 actor 为 agent，追认 actor 为 user，批准/派发/结果可用 todoId+invocationId 串联且 consumed 不等于执行成功。
- [ ] **6.6.10** GREEN：接通安全审计事件族、脱敏、因果字段及跨回合归因。

### 6.7 异步审批启用门禁

- [ ] **6.7.1** RED：新增启用门禁测试，安全需求复审未通过或 P1-1…P1-7 任一控制无证据时均不能开启；门禁证据必须包含 6.5.16–6.5.19 的真实集成回归，不接受 fake port 通过替代。已确认的 OQ-1–OQ-8 不得重新列为待用户决策；验收还须确认当前版本拒绝群聊。
- [ ] **6.7.2** GREEN：仅在安全需求复审通过、适用决策定稿、6.1–6.6 核心验收全部通过后开放 IM 异步审批；开关默认 false，切换前执行持久撤销/对账，保留可恢复回退且验证旧 pending/resume/consumed 未派发动作均不能执行。
- [ ] **6.7.3** RED：新增验收矩阵完整性检查，安全需求 OQ-1–OQ-8、§15.8 P1-1…P1-7、G1–G4/F/G、develop v0.2 §12 与历轮开发计划评审均逐项映射到本机测试名，缺项阻止门禁通过。

## 7. 进度、恢复与完整端到端本地验证

### 7.1 用户可见状态

- [ ] **7.1.1** RED：新增 IM 出站测试，入站受理、计划确认、部分完成等待追认、恢复执行、完成、失败各只发送设计规定的阶段消息。
- [ ] **7.1.2** 新增断言，不向 IM 发送 Thinking、token delta、内部工具日志或调用 envelope。
- [ ] **7.1.3** 实现幂等出站 outbox/重试记录，并增加重复发送与发送失败单测。

### 7.2 双渠道与全局回归

- [ ] **7.2.1** 新增双渠道 contract suite，对同一 Inbox/event/workflow/safety fake contract 分别运行飞书与微信 adapter。
- [ ] **7.2.2** 新增桌面 queue 回归套件，验证 desktop queue 行为、UI 查询、turn claim/reorder 不受 IM scope 改动影响。
- [ ] **7.2.3** 新增全链路恢复场景：计划等待、并发新消息、deferred、用户暂不在场、后续追认、精确派发、取消/修订竞态、容量拒绝、安全通知及最终通知。
- [ ] **7.2.4** 新增评审验收矩阵，将 develop v0.2 §12、上游安全需求 §15.8 P1-1…P1-7、G1–G4/F/G、历轮设计评审及开发计划评审的本机验收场景映射到自动化测试文件与测试名，并确保每项至少一个本地测试。

### 7.3 本机验证门禁

- [ ] **7.3.1** 运行本计划所有新增/修改的聚焦 Vitest 文件，记录通过文件数、测试数和耗时。
- [ ] **7.3.2** 运行队列、路由、remote agent、安全确认与数据库迁移相关完整回归：`npx vitest run --project electron electron/database electron/remote electron/confirmation electron/feishu/remoteCommandRouter.test.ts electron/wechat/weChatCommandRouter.test.ts`。
- [ ] **7.3.3** 运行 `npm run typecheck:shared`。
- [ ] **7.3.4** 运行 `npm run typecheck:renderer`。
- [ ] **7.3.5** 运行 `npm run build:electron:incremental`。
- [ ] **7.3.6** 运行 `npm test` 全量本机测试；若失败，保留失败首因、栈、预期/实际与基线对比，不把基线失败归为本次通过。
- [ ] **7.3.7** 运行 `git diff --check`，确认本计划涉及变更无空白错误、无意外生成物及无计划外文件。
- [ ] **7.3.8** 完成所有本地验收项到测试证据的追踪；未解决外部服务、跨平台/CI 或人工验收项不作为本机完成依据，也不得标记全计划完成。

## 完成定义

- 所有适用的本机任务均为 `- [x]`，没有 `- [ ]` 或 `- [～]`；适用 OQ 决议与生产启用门槛均完成。上游安全需求复审已通过，但该事实本身不替代实现验收。
- 队列 scope、逐事件唤起、session 单飞、持久 authorizationEpoch、完整 envelope、真实任务取消/计划修订与派发线性化、安全待办容量与补偿、明确追认绑定、通知内容安全、审计与完成 outbox 均有本地自动化测试证据；真实审批入口映射、授权撤销级联及启用/回退门禁也有端到端本地证据。
- 聚焦测试、相关 Electron 回归、shared/renderer typecheck、Electron 增量编译及全量 `npm test` 均记录结果。
- 不把真实飞书/微信送达、用户交互质量、外部安全审批或 CI 平台结果冒充本机自动验证结果。
