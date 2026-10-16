# 远程 IM 异步交互：本机开发与测试计划

> 依据：[`docs/develop/remote-im-async-interaction-design.md`](../develop/im-remote/in-flight/remote-im-async-interaction-design.md) v0.2、其引用的 [`docs/requirement/remote-im-async-approval-security-requirement.md`](../requirement/archive/im-remote/remote-im-async-approval-security-requirement.md) v1.1，以及历轮设计/开发计划评审报告。
> 范围：只列可在本机工作区通过代码、SQLite 临时数据库、fake adapter/provider 和自动化测试完成的开发与验证；不包含真实飞书/微信账号联调、外部审批、发布、部署或人工 UX 验收。
> 日期：2026-10-08
> 计划状态：原 0–7 阶段完成；2026-10-09 阻断评审整改进行中。全量 `npm test` 原有 16 项基线失败（见 7.3.6）。
> 最新执行状态（2026-10-11）：本机实现与自动化验收持续推进；影子质量样本和成本来源审计门槛修订见 §9.2.13。正式语义续接仍保持关闭，14 天双渠道影子质量门槛尚未满足，故产品启用尚未完成。

## 执行约定（必须遵守）

- 本计划是本项工作的唯一执行清单。必须按编号和依赖顺序推进；不得跳项、并行执行后续项或执行计划外的开发、重构和测试。
- 每次只推进一个最小任务。开始前将该任务从 `- [ ]` 改为 `- [～]`，保存计划，再进行对应开发或测试；同一时刻最多一项为 `- [～]`。
- 任务达到其验收条件后，先将它改为 `- [x]`，在其下记录本机命令与结果/文件证据，保存计划后再开始下一项。
- 所有行为改动遵循 RED → GREEN → REFACTOR：先写一条能因目标行为缺失而失败的测试，再实现最小改动；重构不得改变行为。每个任务只承担一个可单独判断的行为。
- 测试失败若由语法、夹具、导入或本机环境导致，不得标记 RED 完成；修正测试/环境问题后重跑。实现或验证失败时保留 `- [～]`，记录首个错误和证据，不得越过该任务。
- 若发现任务需拆分，先只修改本计划，将拆分项插入当前任务之后并校正后续编号；不得先做计划外工作。
- 执行前记录 `git status --short`；只修改本计划任务明确列出的目标文件，不覆盖或清理已有工作区改动。发现目标文件存在未提交改动时，先记录并在其上做最小修改。
- 本计划中“本地测试”只使用 Vitest、临时 SQLite/文件、fake IM adapter 和 fake LLM/provider；不得调用真实 IM 服务、真实模型 API 或生产用户数据。

## 0. 当前安全审核改进契约覆盖（2026-10-12）

本文 0–7 阶段及历史 RED/GREEN 记录证明的是当时版本，不自动构成本次策略或启用证据。本段与 [IM 安全审核改进需求/计划](../requirement/2026-10-11-im-security-review-improvement-requirement.md) 及 `docs/plan/2026-10-11-im-security-review-improvement-todo.md` 同步；冲突时依下列新矩阵执行，并保持当前自动审批门禁关闭，直到本计划 11.1/11.2 完整验收。

- 策略按本次可信入口选择：desktop→desktop；wechat/feishu→共同 im。Track 只绑定任务，不是策略域。新指令跨入口重裁决；既有 todo/确认仍绑定原 channel、identity、originSession、Track、behaviorVersion 和精确动作。
- 桌面 IPC 不得消费 IM pending；IM 审批/fallback 只在原渠道。已有桌面 renderer 过滤仅是只读投影，不能替代主进程拒绝和真实入口端到端证据。
- `locked` 只锁定编辑：locked deny/critical 终局拒绝无 todo；locked ask/confirm-every-time 直接原 IM 精确人工 todo；Agent deny 终局拒绝无 todo；undetermined/timeout/暂时 unavailable 进原 IM todo；config/parse/recursion/hard-deny 失败关闭。
- standard 仅 auto-eligible 候选经 Agent approve 且最终检查通过后可免确认。strict 的同步码与异步待办编号空间分开，并分别绑定 Track + 精确调用/envelope。任何人工批准仅授权当前动作、没有长期 cache 写入。
- “全部 outbound 都需真人批准”只作为旧矩阵；当前增加受控 owner 任务回复的窄例外（当前任务、原 owner 单聊、可信冻结目的地、内容/附件检查和每次发送 final check 全部通过）。任意 recipient、第三方/群聊、敏感或批量本地导出仍按主动外发逐次人工或禁止。所有工具/system/media/retry/缓存/Agent 路径统一最终检查。
- R13/R14 真实入口来源与审批隔离、R15 standard 结果边界、R16 strict Track 精确确认，以及回复文案检查只以 `2026-10-11-im-security-review-improvement-todo.md` 中对应集成任务为实施/证据来源。不得把本计划已完成的 P1-1…P1-7 历史证据直接复用为新代码/策略版本的最终启用证据。

## 实施门槛（不是开发任务）

本计划以安全需求 v1.1 为实现基线；该需求已于 2026-10-08 通过需求复审，见第二轮复审报告。复审通过表示安全需求契约已获评审认可，不代表实现、测试或生产启用门禁已完成。v1.1 已明确 OQ-1（默认 24h、合法待办重启保留）、OQ-2（保留 pending、校验身份/epoch/TTL 后补发）、OQ-5（普通追认不写缓存，独立记忆选择默认关闭），这些不得再作为未决阻塞项或由实现者改写。安全基础实现可按已明确契约推进。

产品/需求决策 OQ-1–OQ-8 均已确认，不再有待用户决策的 OQ：待办默认 24h、重启保留；通知失败保留待办并在同身份下次入站重试、不续期；pending 不阻止切换 session、追认回 originSessionId；envelope 不加密但存于主进程受控隔离存储；首版不做“批准并记住”；通知逐条发送；用户以 `批准 <编号>` / `拒绝 <编号>` 回复，编号最多两位十进制数字，在身份范围内绑定 todo 与通知版本且永久不复用；当前版本不支持群聊。两位数字最多提供 100 个历史唯一编号/身份，耗尽后必须 fail closed，不得复用旧编号。剩余工作是计划中的实现、自动化验收和生产启用门禁；证据通过前不得开放异步审批。

## 0. 本机基线与需求追踪

### 0.1 工作区基线

- [x] **0.1.1** 记录执行开始时分支、`git status --short` 和未跟踪文件；在本节任务证据中列出既有改动。
  - 证据：分支 `codex/remote-im-async-interaction-tdd`，基点 `8e3c5d12`。开始时既有修改：`docs/develop/interface/{README.md,history.md,host-ports.md,lifecycle-capacity-scheduler.md,model-provider.md,safety-approval.md,turn-loop.md}`、`docs/develop/remote-im-async-interaction-design.md`、`docs/requirement/remote-im-async-approval-security-requirement.md`；既有未跟踪文件：`docs/develop/interface/context.md`、`docs/plan/remote-im-async-interaction-development-plan.md`。来源为主工作区原有状态，已按内容复制到隔离 worktree，未清理或覆盖主工作区。命令：`git status --short --branch`、`git ls-files --others --exclude-standard`。
- [x] **0.1.2** 记录 Node 与 npm 版本、依赖安装状态，以及 SQLite/Electron 构建可用性；只记录本机事实，不安装或升级依赖。
  - 证据：Node `v26.4.0`，npm `11.17.0`；worktree 无 `node_modules`，`npm ls better-sqlite3 electron --depth=0` 显示 `(empty)`；系统 `sqlite3` CLI 可用，但 better-sqlite3 原生绑定与 Electron 构建工具均不可用，因此当前不能运行基于项目依赖的 SQLite/Electron 构建。未安装依赖。命令：`node --version`、`npm --version`、`npm ls better-sqlite3 electron --depth=0`、`command -v sqlite3`。
- [x] **0.1.3** 核对目标文档和代码基线：develop v0.2、安全需求 v1.1、历轮设计/开发计划评审报告、队列数据库操作、IM router、remote agent、session lease、确认模块；记录文档修订日期、要求映射、实际文件路径与测试文件。
  - 文档基线：`docs/develop/remote-im-async-interaction-design.md` v0.2，日期 2026-10-08；`docs/requirement/remote-im-async-approval-security-requirement.md` v1.1，日期 2026-10-08。需求评审证据为 `docs/review/2026-10-08-remote-im-async-approval-security-requirement-review.md` 与 `...-v2.md`（均 2026-10-08）。设计/计划的历轮评审报告未在基线文件集中找到，后续追踪矩阵据计划要求逐项映射需求条款；未将缺失文件当成已核对证据。
  - 代码/测试基线：队列 `electron/database/operations.ts`、`operations.test.ts`、`operations.updateQueuedMessage.test.ts`；迁移 `electron/database/migrations.agentHistory.test.ts`；飞书 `electron/feishu/remoteCommandRouter.ts` / `.test.ts`；微信 `electron/wechat/weChatCommandRouter.ts` / `.test.ts`；远程执行与 session lease `electron/remote/remoteAgentRegistry.ts` / `.test.ts`、`remoteTaskController.ts` / `.test.ts`、`turnExecutionAdapter.ts` / `.test.ts`、`imProcessedStore.ts` / `.test.ts`、`imRemoteAgent.ts` / `.test.ts`、`remoteAuthorizationRegistry.ts` / `.test.ts`；确认链 `electron/confirmation/approvalAgent.ts` / `.test.ts`、`agentChannel.ts` / `.test.ts`、`agentSdkConfirmationPort.ts` / `.test.ts`、`safetyRecheck.ts` / `.test.ts`、`channels.ts` / `.test.ts`。要求主映射：develop v0.2 §12 与安全需求 §15.8 的 P1-1…P1-7、G1–G4/F/G → 0.2.6 追踪矩阵及阶段 1–7 测试；具体测试名将在对应 RED 任务中落地。
  - 命令/结果：`rg --files docs/review docs/develop docs/requirement electron` 确认上述文件；报告从原主工作区复制到本执行 worktree以满足文档相对链接，不修改主工作区。

### 0.2 本机测试基线

- [x] **0.2.1** 运行并记录队列/迁移基线：`npx vitest run --project electron electron/database/operations.test.ts electron/database/migrations.agentHistory.test.ts electron/ipc/agentProtocolIpc.updateQueuedMessage.test.ts`。
  - 结果：3 个测试文件通过，120 tests passed，耗时 4.83s。`npx` 可用缓存中的 Vitest 执行，无需写入依赖声明。
- [x] **0.2.2** 运行并记录远程运行时基线：`npx vitest run --project electron electron/remote/remoteAgentRegistry.test.ts electron/remote/remoteTaskController.test.ts electron/remote/turnExecutionAdapter.test.ts electron/remote/imProcessedStore.test.ts electron/remote/imRemoteAgent.test.ts electron/remote/remoteAuthorizationRegistry.test.ts`。
  - 结果：6 个测试文件通过，203 tests passed，耗时 9.04s。
- [x] **0.2.3** 运行并记录安全确认基线：`npx vitest run --project electron electron/confirmation/approvalAgent.test.ts electron/confirmation/agentChannel.test.ts electron/confirmation/safetyRecheck.test.ts`。
  - 结果：3 个测试文件通过，69 tests passed，耗时 2.22s。
- [x] **0.2.4** 运行并记录飞书/微信路由基线：`npx vitest run --project electron electron/feishu/remoteCommandRouter.test.ts electron/wechat/weChatCommandRouter.test.ts`。
  - 结果：2 个测试文件通过，24 tests passed，耗时 1.99s。
- [x] **0.2.5** 运行并记录 Electron 编译基线：`npm run build:electron:incremental`。
  - 首次结果：依赖缺失导致 `check:pi-ai-runtime-closure` 找不到 `api/anthropic-messages.js`、`utils/transcript.js`。按锁文件执行 `npm ci`（未改 package/lock），随后重跑通过：runtime closure 23 files/144703 bytes、session storage cleanup/boundary 检查通过（15 existing exceptions）、provider TypeScript build 与 Electron `tsc -p tsconfig.electron.json` 退出码 0。
- [x] **0.2.6** 在本计划内建立“需求/评审验收项 → 后续测试文件/测试名 → 任务编号”追踪表；覆盖设计验收项、上游安全需求全部 OQ-1–OQ-8、P1-1…P1-7、G1–G4/F/G 条款及历轮开发计划评审，包含群聊拒绝、容量限制、通知内容安全、取消/修订派发线性化。

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
  | P1-7：远程功能关闭时拒绝旧审批入口、容量限制、通知脱敏 | `electron/remote/deferredApprovalIngress.test.ts` / rejects directly at the ingress boundary while the durable gate is closed；`electron/confirmation/deferredTodoCapacity.test.ts` / enforces per-session and per-identity limits atomically and counts prepared reservations；`electron/feishu/remoteCommandRouter.test.ts` / routes an approval-shaped message as an ordinary inbound while the durable gate is closed；`electron/wechat/weChatCommandRouter.test.ts` / routes an approval-shaped message as an ordinary inbound while the durable gate is closed；`electron/remote/deferredApprovalNotification.test.ts` / is self-contained, separates user delegation from untrusted material, and omits commands, paths and credentials | 6.1.7–6.1.10、6.5.14–6.5.16、6.7.1–6.7.3 |
  | 安全需求 G1–G4、G5–G10：回答者/deferred/fallback、持久化、级联、审计、关闭记忆、通知脱敏、限额、委托相关授权分档及外流例外 | `electron/confirmation/imAsyncApproval.integration.test.ts` / wechat remains on the existing user answerer when rollout is off；`electron/remote/remoteAuthorizationRevocationCoordinator.test.ts`；`electron/confirmation/securityAuditLog.test.ts`；`electron/remote/deferredApprovalNotification.test.ts` | 6.3.1–6.3.12、6.4.1–6.4.12、6.6.9–6.6.10 |
  | 安全需求 §15.5 E2–E4：cause、脱敏、actor 归因 | `electron/confirmation/securityAuditLog.test.ts` | 6.6.9–6.6.10 |
  | §15.6 F1–F4：通知自包含、去绝对路径/完整命令、记忆授权边界 | `electron/remote/deferredApprovalNotification.test.ts` / is self-contained, separates user delegation from untrusted material, and omits commands, paths and credentials；`electron/confirmation/deferredApprovalCachePolicy.test.ts` / never grants long-term cache writes to ordinary todo outcomes | 6.3.9–6.3.10、6.6.4–6.6.8 |
  | §15.7 G1–G4：pending 超限、逐格 fallback、TTL=0、关闭后旧状态不可执行 | `electron/confirmation/deferredTodoCapacity.test.ts`；`electron/confirmation/imAsyncApproval.integration.test.ts` / undetermined from the real channel path follows the final gate disposition；`electron/remote/deferredApprovalIngress.test.ts` / rejects directly at the ingress boundary while the durable gate is closed；`electron/feishu/remoteCommandRouter.test.ts` / routes an approval-shaped message as an ordinary inbound while the durable gate is closed；`electron/wechat/weChatCommandRouter.test.ts` / routes an approval-shaped message as an ordinary inbound while the durable gate is closed | 6.1.7–6.1.10、6.3.1–6.3.4、6.5.14–6.5.16 |
  | 历轮安全需求评审（2026-10-08 两轮）：P1 修订、v1.1/OQ 决议不得回退 | `electron/confirmation/remoteAsyncApprovalAcceptanceMatrix.test.ts` / maps every security acceptance row to an existing local test file and named case | 0.2.6、6.7.3、7.2.4 |
  | 历轮设计/开发计划评审：设计 §12 全覆盖、取消/修订派发线性化、容量限制与安全通知 | `electron/remote/imTaskControlWorkflow.e2e.test.ts` / does not execute an old deferred action after cancellation succeeds；`electron/remote/imEndToEndRecovery.test.ts` / persists a plan, waits with new inbox work, resumes the exact deferred call, and records completion once；`electron/remote/imTaskCancelDeferredDispatch.integration.test.ts` / dispatch begins first, then reports action_started while the real executor runs once；`electron/confirmation/remoteAsyncApprovalAcceptanceMatrix.test.ts` / maps every security acceptance row to an existing local test file and named case | 0.2.6、5.1.1–5.2.6、6.4.9–6.5.19、7.2.4 |

  > 表中每个文件/测试名都必须在当前检出中存在并可执行；历史计划曾引用的 `remoteAsyncApprovalGate.test.ts` 已随 2026-10-15 `refactor(im-approval): remove obsolete release gate` 移除，当前关闭行为由入口与微信/飞书 router 的回归覆盖，不再声称存在独立 release-gate 证据。历史设计/开发计划评审报告未随当前基线提供，故以可见的两轮安全需求报告、design §12 与 requirement §15.8 作为可核验来源；发现报告后应在相应映射行补充其条款，而不改变既定执行顺序。

## 1. 队列作用域与 Inbox 持久化

### 1.1 `queueScope` 类型与规范化

- [x] **1.1.1** RED：新增类型测试，queue scope 只允许 desktop 与 feishu/wechat IM 形式，不允许空 session/channel。
  - RED 证据：新增 `src/shared/queueScope.type.test.ts`。`npx vitest run --project renderer src/shared/queueScope.type.test.ts`：1 file / 2 tests 通过（Vitest 不负责 TS 类型诊断）；类型 RED 命令 `npx tsc --noEmit --strict --skipLibCheck --target ES2022 --module ESNext --moduleResolution Bundler src/shared/queueScope.type.test.ts` 失败：TS2307 `Cannot find module './queueScope'`，并报告两个尚未生效的 `@ts-expect-error`（TS2578），证明目标类型定义缺失。先前使用 electron project 的过滤命令未收录 `src/shared`，已按 renderer 配置重跑，不作为 RED 证据。
- [x] **1.1.2** GREEN：定义并导出 queue scope 类型，使 1.1.1 通过。
  - GREEN 证据：`src/shared/queueScope.ts` 导出 desktop/IM 判别联合、`QueueScopeChannel` 与 branded `NonEmptyQueueScopeField`。针对 RED 文件运行定向 `tsc` 退出码 0；Vitest 1 file / 2 tests passed。
- [x] **1.1.3** RED：新增规范化单测，同一链路/session 生成稳定 scope，不同 channel 或 session 生成不同 scope。
  - RED 证据：新增 `src/shared/queueScope.test.ts`，`npx vitest run --project renderer src/shared/queueScope.test.ts` 的 2 个测试均因 `buildImQueueScope is not a function` 失败（预期目标行为缺失，非夹具/导入错误）。
- [x] **1.1.4** GREEN：实现纯函数 scope builder/parser；单测覆盖分隔符转义、非法字段和稳定序列化。
  - RED：扩展序列化测试后，`npx vitest run --project renderer src/shared/queueScope.test.ts` 中 3 项因 `serializeQueueScope is not a function` 失败，3 项 builder 测试通过。
  - GREEN：`src/shared/queueScope.ts` 实现受校验 builder、desktop/IM 纯序列化及严格 parser；renderer Vitest 2 files / 8 tests passed，定向 `tsc`（queueScope.test + type.test）退出码 0。

### 1.2 SQLite 迁移与兼容

- [x] **1.2.1** RED：新增迁移测试，旧版本 queued 桌面消息升级后仍归入 desktop scope，内容、顺序、receipt 和 turn 关联保持不变。
  - RED 证据：新增 `electron/database/migrations.queueScope.test.ts`。命令 `npx vitest run --project electron electron/database/migrations.queueScope.test.ts`：1 test 按预期失败，首错 `no such column: queue_scope`；旧消息/receipt/turn 夹具成功构造并执行迁移入口。
- [x] **1.2.2** RED：新增迁移失败回滚测试，DDL/backfill 失败时 schema version 不推进且旧数据可读。
  - RED 证据：在 `electron/database/migrations.queueScope.test.ts` 加入 backfill 中断注入。聚焦运行 2 tests 均失败在缺失实现：兼容测试 `no such column: queue_scope`；回滚测试因当前迁移没有触发 backfill而未抛注入错误（首个断言 `expected [Function] to throw`）。旧数据 fixture 在失败后仍可读取。
- [x] **1.2.3** RED：新增重复迁移测试，迁移可重复运行且不重复创建索引或破坏数据。
  - RED 证据：聚焦迁移文件现有 3 tests：旧消息回填与重复迁移均因目标列缺失 `queue_scope` 失败；回滚注入因迁移尚不存在而未抛错。失败点均是预期迁移行为缺失。
- [x] **1.2.4** GREEN：实现增量 schema migration，为共享队列记录与幂等 receipt 持久化 `queueScope`，确定性回填旧 queued 桌面消息，并建立 scope/status/order 复合索引。
  - 实现：`electron/database/schema.ts` v55 持久化 `messages.queue_scope` 与 `queue_input_requests.queue_scope`，按 legacy desktop 确定性回填并创建 scope/status/sequence 与 receipt scope 复合索引；`electron/database/migrations.ts` 在事务中提交迁移和 schema version。
  - GREEN：`npx vitest run --project electron electron/database/migrations.queueScope.test.ts`，1 file / 3 tests passed，覆盖内容/顺序/receipt/turn 保持、故障回滚和重复迁移。
- [x] **1.2.5** 运行迁移专测及数据库迁移回归，确认旧消息、receipt、turn 关联和 schema version 均符合测试断言；若回归暴露历史部分 schema 兼容缺陷，在本任务内修复迁移的表/列存在性处理并更新明确断言旧版本号的回归测试，然后重跑全组。
  - 首次失败证据：命令 `npx vitest run --project electron electron/database/migrations*.test.ts electron/database/operations.test.ts`：10 files，51 failed / 110 passed。首错 `no such table: messages`，`electron/database/migrations.ts` v55 migration 执行无条件 DDL；随后稀疏旧库暴露 `no such column: status`。另有 schema 最新版本断言仍期望 54。
  - 修复：v55 migration 对表/列做存在性检查，仅在列存在时执行 queued 回填与复合索引创建；receipt 回填/索引也按字段检查；更新显式断言最新 schema 版本为 55。
  - 重跑结果：同一命令通过，10 files / 161 tests passed，7.23s。新迁移专测仍为 1 file / 3 tests passed。

### 1.3 scope 隔离的数据库操作

- [x] **1.3.1** RED：新增 list/get-next 测试，desktop scope 只返回 desktop 消息。
  - RED 证据：新增 `electron/database/operations.queueScope.test.ts`，插入较早 IM scope queued 消息及 desktop 消息；`npx vitest run --project electron electron/database/operations.queueScope.test.ts` 失败：`listQueuedUserMessages is not a function`，符合 list scope API 缺失。
- [x] **1.3.2** GREEN：将 list/get-next 查询增加必需 scope 条件与稳定排序，使 1.3.1 通过。
  - 实现：`electron/database/operations.ts` 新增 scope 显式的 `listQueuedUserMessages`、`getNextQueuedMessageInScope`，按 scope/status/sequence/id 稳定排序；原 `getNextQueuedMessage` 当前委托 desktop scope。
  - GREEN：`npx vitest run --project electron electron/database/operations.queueScope.test.ts`，1 file / 1 test passed。
- [x] **1.3.3** RED：新增测试，IM scope 只返回本 channel/session 消息；同 session 的 desktop、feishu、wechat scope 互不可见。
  - RED/验证证据：新增 electron/database/operations.queueScope.test.ts 同 session 四种 scope（desktop、feishu 的两个 session、wechat）list/get-next 隔离用例。该行为已由 1.3.2 的通用序列化 scope 谓词覆盖，因此本项新增回归用例在当前实现下直接通过：1 file / 2 tests passed；实现前基线查询没有 queue_scope 条件，故该用例针对的行为缺失已由基线代码确认。
- [x] **1.3.4** RED：新增测试，错误 scope 执行 claim/ack/release/reorder 时失败且任何队列状态不变。
  - RED 证据：在 operations.queueScope.test.ts 增加错误 scope claim、receipt ack/release、跨 scope reorder 测试；聚焦运行 1 file / 6 tests 中 4 项按预期失败：claim 未抛错、ack/release 返回 true、reorder 返回 ok=true；失败前后状态断言用于验证不会修改队列。
- [x] **1.3.5** GREEN：将 enqueue receipt、原子 claim、ack/release、reorder 与去重查询全部限定 scope，使 1.3.3–1.3.4 通过；确保同一 session 下相同 requestId 可在不同 queueScope 独立幂等，必要时以增量迁移扩展 receipt 唯一键。
  - 实现：operations 所有队列读写/receipt 状态更新均带序列化 scope 条件；保留 desktop 旧调用包装。v56 migration 将 receipt 主键扩为 `(queue_scope,session_id,request_id)`。
  - RED：错误 scope claim、ack、release、reorder 共 4 个断言失败；相同 requestId 跨 scope 用例因旧主键报 `UNIQUE constraint failed: queue_input_requests.session_id, queue_input_requests.request_id`。
  - GREEN/回归：`npx vitest run --project electron electron/database/operations.queueScope.test.ts electron/database/operations.test.ts electron/database/migrations.queueScope.test.ts`：3 files / 104 tests passed；迁移 + 数据库回归 `npx vitest run --project electron electron/database/migrations*.test.ts electron/database/operations.test.ts`：10 files / 161 tests passed。
- [x] **1.3.6** RED：新增兼容测试，桌面旧 IPC/API 调用在缺省适配时仍明确绑定 desktop scope，并保持 enqueue/get-next/reorder/claim turn 行为。
  - 证据：新增 electron/database/desktopQueueCompatibility.test.ts，验证无 scope 的旧 enqueue/get-next/reorder/claim 调用只处理 desktop，并保持 turn/receipt 关联。命令 npx vitest run --project electron electron/database/desktopQueueCompatibility.test.ts：1 file / 1 test passed。当前旧调用在 1.3.5 临时包装中保持默认 desktop；1.3.7 将把这些路径收敛到显式 adapter。
- [x] **1.3.7** GREEN：接入 desktop scope 兼容适配器，使 1.3.6 通过；不允许数据库层隐式使用无 scope 的通用查询。
  - 实现：operations 内增加显式 desktopQueueCompatibility adapter；generic enqueue/claim/reorder/update/delete 与 receipt API 要求 QueueScope，旧桌面函数仅通过该 adapter 绑定 desktop；database/index.ts 导出 scoped API。
  - 结果：npx vitest run --project electron electron/database/operations.test.ts electron/database/operations.updateQueuedMessage.test.ts electron/database/desktopQueueCompatibility.test.ts electron/database/operations.queueScope.test.ts：4 files / 106 tests passed。

### 1.4 Inbox 生命周期与租约

- [x] **1.4.1** RED：新增幂等 append 测试，同一 `queueScope + channel + channelMessageId` 重试返回相同稳定 ID，不产生重复消息。
  - RED 证据：新增 electron/database/imInbox.test.ts；夹具使用真实临时 AppDatabase session。命令 npx vitest run --project electron electron/database/imInbox.test.ts 失败于目标模块缺失：Cannot find module ./imInbox；修正夹具 session 后同一首错，未出现环境/夹具失败。
- [x] **1.4.2** GREEN：实现 scoped Inbox append 与幂等 receipt，使 1.4.1 通过。
  - 实现：electron/database/imInbox.ts 将 channelMessageId 映射到 scope 内 requestId，校验 channel 与 IM scope 一致后委托 scope-aware queue enqueue；receipt 与消息在现有事务中幂等持久化；database/index.ts 导出 API。
  - GREEN：npx vitest run --project electron electron/database/imInbox.test.ts：1 file / 1 test passed。
- [x] **1.4.3** RED：新增 payload 冲突测试，同一幂等键对应不同 payload 时返回明确冲突且不覆盖原消息。
  - RED 证据：在 electron/database/imInbox.test.ts 增加相同 scope/channelMessageId 改变正文测试，要求专用 IM_INBOX_PAYLOAD_CONFLICT 且原消息不变。聚焦 Vitest 2 tests 中 1 项失败：实际错误为通用 QUEUE_REQUEST_FINGERPRINT_MISMATCH；原文/计数断言夹具正确。
- [x] **1.4.4** GREEN：实现 fingerprint 冲突校验，使 1.4.3 通过。
  - 实现：imInbox 将队列 fingerprint mismatch 映射为稳定的 IM_INBOX_PAYLOAD_CONFLICT 错误并保留 cause；原队列事务不覆盖首份消息。
  - GREEN：npx vitest run --project electron electron/database/imInbox.test.ts：1 file / 2 tests passed。
- [x] **1.4.5** RED：新增原子 claim 测试，并发 claim 同一消息最多一个成功，且只领取 pending 消息。
  - RED 证据：electron/database/imInbox.test.ts 并发提交 8 次 claim 并验证非 pending 被拒绝。npx vitest run --project electron electron/database/imInbox.test.ts：2 项既有测试通过，新 claim 用例因目标 API 缺失（claimImInboxMessage is not a function）失败。
- [x] **1.4.6** GREEN：实现带 scope/state 条件的原子 claim，使 1.4.5 通过。
  - 实现：v57 schema 增加 scope/owner/expiry 可扩展的 im_inbox_claims；claim 在事务内以 message id + queue_scope + pending status 条件更新消息状态并插入 owner claim，失败不改状态；database/index.ts 导出。
  - GREEN：electron/database/imInbox.test.ts 3 tests passed，覆盖 8 路竞争唯一成功、错误 scope 拒绝、非 pending 拒绝及持久 owner。迁移文件 electron/database/migrations.queueScope.test.ts 3 tests passed。
- [x] **1.4.7** RED：新增租约测试，未过期租约阻止其他 owner，过期后允许重领，租约过期不丢消息。
  - RED 证据：electron/database/imInbox.test.ts 新增 live lease 拒绝第二 owner、过期后重领并保留正文测试。聚焦运行 4 tests 中 1 项失败：过期后 reclaimed.ownerId 为 undefined（现有 API 仍返回 null）；其余 3 项通过。
- [x] **1.4.8** GREEN：实现 claim owner、expiry 与过期重领，使 1.4.7 通过。
  - 实现：claim 默认 30s 可配置租期，持久化 owner/claim 时间/expiry；有效租约阻止其他 owner，过期后仅一个新 owner 可条件更新并重领；expired message 保留原正文和 scope。
  - GREEN：npx vitest run --project electron electron/database/imInbox.test.ts electron/database/migrations.queueScope.test.ts：2 files / 7 tests passed。
- [x] **1.4.9** RED：新增 ack/release/renew 测试，重复 ack 幂等，非 owner 操作失败，release 保留 pending，renew 只允许 owner。
  - RED 证据：electron/database/imInbox.test.ts 新增全状态流转测试；运行 5 tests 中 1 项因 ack API 缺失失败（ackImInboxMessage is not a function），此前 4 项通过；release/renew 断言已在同一测试夹具中准备。
- [x] **1.4.10** GREEN：实现 ack/release/renew 状态转换，使 1.4.9 通过。
  - 实现：v58 为持久 inbox claim 添加 claimed/acked/released 状态；ack 仅 owner 且 lease 有效时完成，重复 ack 对同 owner 幂等；release 将消息退回 queued；renew 仅更新 owner 的有效租约。所有状态转换与 scope/message 状态同事务，竞态回滚不留半状态。
  - GREEN：npx vitest run --project electron electron/database/imInbox.test.ts electron/database/migrations.queueScope.test.ts：2 files / 8 tests passed。
- [x] **1.4.11** 新增文件数据库重开测试，验证 pending 消息、receipt 与 claim lease 按规定恢复。
  - 实现：在 `electron/database/imInbox.test.ts` 新增文件库关闭/重开覆盖：pending 消息正文和稳定 append receipt 保持可读/幂等，未过期 claim 的 owner 与 expiry 持久化，重开后其他 owner 仍不能抢占。
  - GREEN：`npx vitest run --project electron electron/database/imInbox.test.ts electron/database/migrations.queueScope.test.ts`：2 files / 9 tests passed。

## 2. 逐事件唤起存储与恢复

### 2.1 唤起事件合同

- [x] **2.1.1** RED：新增类型测试，唤起事件至少包含稳定 `eventId`、唯一 `reasonKey`、session、受控事件类型/payload 引用、状态及时间戳。
  - RED 证据：新增 `src/shared/wakeEvent.type.test.ts`；`npx tsc --noEmit --strict --skipLibCheck --target ES2022 --module commonjs --moduleResolution node --types node src/shared/wakeEvent.type.test.ts` 按预期失败：`./wakeEvent` 模块尚不存在，且受控事件类型的 `@ts-expect-error` 尚未生效。`src/shared` 类型测试被 renderer tsconfig 排除，因此用直接 tsc 验证。
- [x] **2.1.2** GREEN：定义事件类型与运行时可信字段；只接受准入 IM 入站、安全恢复、显式 continuation，不接受模型指定的 scope/归属/游标。
  - 实现：`src/shared/wakeEvent.ts` 定义 branded event/reason/session 身份、受控三类事件与匹配 payload 引用、pending/claimed/acked 状态；`createWakeEvent` 验证输入、由运行时生成 ID/时间/初始状态，并复制白名单 payload 引用，不接纳模型可控 scope、owner 或 cursor 字段。
  - GREEN：wakeEvent 类型合同直接 `tsc --noEmit --strict ... src/shared/wakeEvent.type.test.ts` 通过；`npm run typecheck:shared` 通过。
- [x] **2.1.3** RED：新增测试，同一 `reasonKey` 重复 append 返回原 `eventId`，不创建第二条事件。
  - RED 证据：`electron/database/wakeEvents.test.ts` 新增重复 append 测试；`npx vitest run --project electron electron/database/wakeEvents.test.ts` 失败：`./wakeEvents` 模块尚不存在。
- [x] **2.1.4** GREEN：实现 `reasonKey` 唯一约束/幂等 append，使 2.1.3 通过。
  - 实现：schema v59 新增 `wake_events`，以 `(session_id, reason_key)` 唯一；新增 `appendWakeEvent` / `readWakeEvent`，相同 key 与 payload 返回旧 eventId，payload/type 冲突报错，并从 database/index 导出。
  - GREEN：`npx vitest run --project electron electron/database/wakeEvents.test.ts electron/database/migrations.queueScope.test.ts electron/database/imInbox.test.ts`：3 files / 10 tests passed；wakeEvent 类型合同直接 tsc 通过。
- [x] **2.1.5** RED：新增测试，不同 session 的事件不能被其他 session 的 list/claim/ack 操作看见或消费。
  - RED 证据：`electron/database/wakeEvents.test.ts` 新增另一 session list/claim/ack 测试；聚焦运行 2 tests 中跨 session 用例因 `listWakeEvents is not a function` 失败。
- [x] **2.1.6** GREEN：实现 session 作用域校验，使 2.1.5 通过。
  - 实现：schema v60 持久化事件 claimed_by；新增 session 条件 list/claim/ack，claim 事务内只更新目标 session 的 pending event，ack 校验 session 与 owner。
  - GREEN：`npx vitest run --project electron electron/database/wakeEvents.test.ts electron/database/migrations.queueScope.test.ts`：2 files / 5 tests passed；随后加入正确 session/owner 完整流转断言后，同命令及 `npm run typecheck:shared` 通过。

### 2.2 事件持久化 API

- [x] **2.2.1** RED：新增原子 claim 测试，一次启动只领取可用事件，并为领取集合绑定 `runId`。
  - RED 证据：`electron/database/wakeEvents.test.ts` 新增 4 路并发批量 claim 测试；运行 3 tests 中该测试因 `claimWakeEvents is not a function` 失败。
- [x] **2.2.2** GREEN：实现原子事件 claim 和 run 绑定，使 2.2.1 通过。
  - 实现：v61 为 wake event 增加 run_id；`claimWakeEvents` 在事务内读取当前 session pending 集并条件更新整组状态、owner、runId，返回这次领取的 eventIds。
  - GREEN：`npx vitest run --project electron electron/database/wakeEvents.test.ts electron/database/migrations.queueScope.test.ts`：2 files / 6 tests passed。
- [x] **2.2.3** RED：新增 ack 归属测试，Loop 只能确认自己领取且租约仍有效的 eventId。
  - RED 证据：`electron/database/wakeEvents.test.ts` 新增不同 run 不能 ack、原 run 可 ack 测试；聚焦运行 4 tests 中该测试因 `ackWakeEventInRun is not a function` 失败。
- [x] **2.2.4** GREEN：实现逐 eventId、runId、lease owner 条件确认，使 2.2.3 通过。
  - 实现：`ackWakeEventInRun` 按 eventId + session + claimed 状态 + runId + claimed_by 条件 ack，逐事件更新，不接受其他 run/owner。
  - GREEN：`npx vitest run --project electron electron/database/wakeEvents.test.ts electron/database/migrations.queueScope.test.ts`：2 files / 7 tests passed；共享层 typecheck 通过。
- [x] **2.2.5** RED：新增租约测试，claimed 事件租约过期后可重领，旧 run 不能确认新 run 的事件。
  - RED 证据：新增过期 lease 重领及旧 run fencing 测试；聚焦运行 5 tests 中失败于 `no such column: lease_expires_at`。
- [x] **2.2.6** GREEN：实现租约到期回收/重领与 owner fencing，使 2.2.5 通过。
  - 实现：v62 增加 lease_expires_at；批量 claim 支持过期 claimed 事件回收并重新绑定 run/owner，ack 增加租约有效条件，旧 run/owner 被新 run fencing。
  - GREEN：`npx vitest run --project electron electron/database/wakeEvents.test.ts electron/database/migrations.queueScope.test.ts`：2 files / 8 tests passed。过期通过数据库时间设置验证，无 wall-clock sleep。
- [x] **2.2.7** RED：新增交错事件测试，Loop 领取后新入站事件保持 pending，旧 run finalize 不得确认它。
  - RED 证据：新增入站交错测试；`npx vitest run --project electron electron/database/wakeEvents.test.ts` 7 tests 中该项因 `finalizeWakeEvents is not a function` 失败。
- [x] **2.2.8** RED：新增 continuation 测试，Loop 运行中创建的 continuation 不属于当前领取集合，当前 finalize 不得确认它。
  - RED 证据：同一聚焦命令中 continuation 交错测试亦因缺少 `finalizeWakeEvents` 失败。
- [x] **2.2.9** GREEN：实现“仅确认本 run 初始 eventId 集合”的 finalize API，使 2.2.7–2.2.8 通过；禁止消费高水位。
  - 实现：`finalizeWakeEvents` 只循环调用方持有的 eventId 集合，并以 session/run/owner/lease 条件逐条 ack；不会按时间或 sequence 高水位扫描，运行中新增入站与 continuation 留为 pending。
  - GREEN：`npx vitest run --project electron electron/database/wakeEvents.test.ts electron/database/migrations.queueScope.test.ts`：2 files / 10 tests passed。
- [x] **2.2.10** RED：新增空 Inbox 测试，`workflow.continue(reasonKey)` 创建 pending 事件并可触发后续 Loop。
  - RED 证据：`electron/database/wakeEvents.test.ts` 在确认 Inbox 为空后新增 continuation 测试；运行 8 tests 中该用例因 `continueWorkflow is not a function` 失败。
- [x] **2.2.11** GREEN：实现幂等 continuation append/outbox，使 2.2.10 通过。
  - 实现：v63 新增 wake_event_outbox；`continueWorkflow` 在单事务中幂等追加 continuation event 与 pending outbox，稳定 reasonKey 重试返回原 eventId。
  - GREEN：`npx vitest run --project electron electron/database/wakeEvents.test.ts electron/database/migrations.queueScope.test.ts`：2 files / 11 tests passed；共享 typecheck 通过。
- [x] **2.2.12** RED：新增入站与 wake event 原子性/恢复测试：注入 outbox 提交中断后可补发同一事件且不重复。
  - RED 证据：在 `electron/database/imInbox.test.ts` 注入 outbox BEFORE INSERT 中断并验证 rollback/重试的测试；聚焦 7 tests 中失败于 `appendImInboxMessageWithWakeEvent is not a function`。
- [x] **2.2.13** GREEN：实现同事务写入或等价 transactional outbox/recovery scan，使 2.2.12 通过。
  - 实现：`appendImInboxMessageWithWakeEvent` 在单事务中写 Inbox 消息、wake event 与 outbox；提交错误后可用 channel message ID/reasonKey 重试恢复，message receipt 与 reasonKey 唯一约束消除重复。
  - GREEN：`npx vitest run --project electron electron/database/imInbox.test.ts electron/database/wakeEvents.test.ts electron/database/migrations.queueScope.test.ts`：3 files / 18 tests passed；故障注入验证 rollback 后重试及三类记录单行。

### 2.3 等待与无进展抑制

- [x] **2.3.1** RED：新增测试，Skill release 同一 Inbox 消息并返回 wait 后，队列非空本身不会再次启动 Loop。
  - 测试：`electron/database/imInbox.test.ts` 模拟释放消息后结束 run；Inbox 仍 queued，但 pending wake event 与下一轮 claim 集均为空，验证队列本身不构成调度信号。当前调度器尚待第 3 章实现。
- [x] **2.3.2** RED：新增测试，`waitForEvent` API 不接受模型提供的游标/事件代次，且不会 ack 未领取事件。
  - RED 证据：`electron/database/wakeEvents.test.ts` 新增 wait 边界测试，用 `@ts-expect-error` 禁止 cursor，并在当前 run claim 后 append 新事件；聚焦运行 9 tests 中失败于 `waitForEvent is not a function`。
- [x] **2.3.3** 实现 `workflow.waitForEvent`：只完成/释放当前 run 已领取的事件并结束 Loop；后续只响应新 eventId。
  - 实现：新增无 cursor/代次字段的 `WaitForEventInput` 与 `waitForEvent`；只 finalize 指定当前 run eventId 集合，并受 session/run/owner/lease 校验保护。
  - GREEN：wakeEvents/imInbox/migrations 聚焦 suite 3 files / 20 tests passed；直接 TypeScript 检查通过。
- [x] **2.3.4** 新增有界退避测试，模型/执行器连续不可用达到最大尝试次数后停止自动重启并保留故障事实。
  - RED 证据：`electron/remote/wakeEventRetryPolicy.test.ts` 新增 fake-time 最大尝试与最后失败事实测试；`npx vitest run --project electron electron/remote/wakeEventRetryPolicy.test.ts` 失败于缺少 `wakeEventRetryPolicy` 模块。实现按计划留到 3.2.7。
- [x] **2.3.5** 新增恢复测试，达到退避上限后收到新的入站/恢复事件仍能唤起，不被旧失败状态或已 ack 事件吞掉。
  - RED 证据：在 `electron/remote/wakeEventRetryPolicy.test.ts` 加入旧事件耗尽后新入站、新安全恢复均从独立初始状态启动测试；聚焦运行因 retry policy 模块尚不存在失败（实现按计划留到 3.2.7）。

## 3. Runtime 单飞调度与 Agent Loop 入口

### 3.1 共用 session 执行槽

- [x] **3.1.1** RED：为 `remoteAgentRegistry` 新增测试，普通 Loop 和安全精确派发使用同一 session claim key 时互斥。
  - 测试：`electron/remote/remoteAgentRegistry.test.ts` 增加 normal Loop 与 safety exact dispatch 同 session 竞争测试；聚焦 14 tests passed。现有 registry 已按 originSessionId 单键互斥。
- [x] **3.1.2** RED：新增并发测试，同 session 两个 continuation/两个安全恢复请求只能有一个持有槽；其他请求保持 durable pending。
  - 测试：`electron/remote/wakeEventSessionGate.test.ts` 同 session 两个并发请求竞争；一个拿槽、一个 `session_busy`，两个 durable wake event 均保持 pending。与 registry 聚焦 suite 2 files / 15 tests passed。
- [x] **3.1.3** RED：新增应用级额度测试，安全恢复派发与普通 Loop 共用 max-parallel 计数。
  - 测试：`remoteAgentRegistry.test.ts` 验证普通桌面 Loop 占满额度时 IM safety dispatch 收到 `parallel_full`，释放后安全派发成功；聚焦 2 files / 16 tests passed。
- [x] **3.1.4** 实现或扩展执行租约入口，确保不改变现有桌面/远程调用的 owner-only release/cancel 规则。
  - 实现检查：现有 `tryClaimRemoteSession` 已提供统一按 originSessionId 单飞入口与全局并行计数；`releaseRemoteSession` / `cancelRemoteSession` 均按 requestId owner 校验。无需新增并行租约入口，保持现有 owner-only 行为。
  - 验证：`electron/remote/remoteAgentRegistry.test.ts` 的 owner-only release/cancel、过期回收测试与本节共享槽测试均通过。
- [x] **3.1.5** 新增租约测试：取得槽失败不消费安全待办；租约释放、过期重领和旧 owner 迟到 release 均符合预期。
  - 测试：`electron/remote/wakeEventSessionGate.test.ts` 验证 slot busy 保持安全 event pending、释放后取得 slot、过期后新 owner takeover、旧 owner 迟到 release 不影响新 owner；与 registry suite 2 files / 17 tests passed。

### 3.2 Loop dispatcher

- [x] **3.2.1** RED：新增 dispatcher 测试，新入站事件到达空闲 session 时只启动一个 Loop。
  - RED 证据：`electron/remote/wakeEventDispatcher.test.ts` 验证空闲 session 收到事件只启动一个 Loop；聚焦测试失败于 dispatcher 模块不存在。
- [x] **3.2.2** RED：新增测试，Loop 运行期间新入站只落 Inbox/outbox，不启动共享上下文的并发 Loop。
  - RED 证据：`wakeEventDispatcher.test.ts` 新增 Loop 挂起期间追加事件，第二 dispatch 信号不并发启动且事件仍 pending；聚焦测试失败于 dispatcher 模块不存在。
- [x] **3.2.3** RED：新增 finalize 测试，Loop 结束只 ack 本 run 已领取 eventId，执行中创建的事件保持 pending 并启动后续 run。
  - RED 证据：`wakeEventDispatcher.test.ts` 新增执行中新 event 保持 pending、旧 run finalize 后第二 run 处理测试；聚焦 suite 因 dispatcher 模块缺失失败。
- [x] **3.2.4** RED：新增 crash 测试，Loop 启动/完成提交前后重启不丢事件、不重复创建 continuation。
  - RED 证据：`wakeEventDispatcher.test.ts` 新增文件库关闭重开后恢复 event/outbox，并以相同 reasonKey 重试 continuation 不重复创建的用例；聚焦 suite 因 dispatcher 模块缺失失败。
- [x] **3.2.5** 实现 dispatcher：逐事件 claim、领取 run 记录、注入已领取事件引用、Loop finalize ack，以及完成后再次检查 pending 事件。
  - 实现：`electron/remote/wakeEventDispatcher.ts` 先取共享 session execution slot，再原子 claim 事件集合并注入 eventId/event/runId/owner；Loop 结束后只 finalize 此集合，释放 slot 并重新扫描 pending，活跃 run 去重并行 dispatch 信号。
  - GREEN：wake dispatcher/registry/database 聚焦 suite 4 files / 31 tests passed，覆盖空闲唤起、交错事件、后续 run、文件库恢复及 session 并发锁。
- [x] **3.2.6** 新增 `waitForEvent` 的端到端 dispatcher 测试，pending Inbox 不会忙循环，新的 eventId 会唤起新 Loop。
  - 测试：`wakeEventDispatcher.test.ts` 真实 Inbox + outbox + dispatcher：release 后 queued 消息不会忙循环，新入站 eventId 到达后可启动下一 Loop。相关 suite 3 files / 22 tests passed。
- [x] **3.2.7** 实现有界重试计数/退避调度的纯本机时钟接口，并新增 fake clock 测试覆盖最大尝试数、恢复和新事件重置策略。
  - 实现：新增本机 clock 可注入的指数退避+jitter policy，按最大尝试数和最大时间窗限制；v64 持久化 per-event attempt、nextAttemptAt、自动重试开关与 lastFailure。dispatcher 按 retry due 时间过滤 claim、失败后释放事件回 pending 并安排重试，成功后清理旧失败状态；新 event 独立启动，不被耗尽事件阻挡。
  - GREEN：`npx vitest run --project electron electron/remote/wakeEventRetryPolicy.test.ts electron/remote/wakeEventDispatcher.test.ts electron/database/wakeEvents.test.ts electron/database/migrations.queueScope.test.ts electron/database/imInbox.test.ts`：5 files / 30 tests passed；dispatcher/retry 目标直接 tsc 通过。覆盖 fake clock、重启后保留失败事实、最大尝试、时间窗、jitter、新安全事件解除旧失败阻挡。

## 4. IM 接入、入站幂等与 Skill 工作流

### 4.1 飞书/微信入站

- [x] **4.1.1** RED：新增飞书路由测试，已鉴权入站先持久化到 IM queueScope 并创建幂等 wake event，再快速返回受理，不等待模型整轮完成。
  - RED 证据：`remoteCommandRouter.test.ts` 新增 dispatcher 接线、消息/事件持久化及未等待 Agent 完成测试；命令用例失败于 `returnedQuickly` 为 false，确认当前 router 仍等待整个模型回合。
- [x] **4.1.2** GREEN：实现飞书 adapter/router 持久化受理与 dispatcher 接线；保留现有鉴权、群聊拒绝、owner 和限流检查顺序。
  - 实现：飞书 router 增加可选 dispatcher 注入；已鉴权、限流及 session/workdir 解析后，将 IM queue scoped message、wake event 和 outbox 原子持久化，完成受理记录并 fire-and-forget dispatch，不等待 Agent 整轮。
  - GREEN：`npx vitest run --project electron electron/feishu/remoteCommandRouter.test.ts electron/database/imInbox.test.ts electron/remote/wakeEventDispatcher.test.ts`：3 files / 28 tests passed；router 测试直接 tsc 通过。
- [x] **4.1.3** RED：新增微信路由等价测试，channel message ID 重复投递不重复 append/唤起。
  - RED 证据：`electron/wechat/weChatCommandRouter.test.ts` 新增重复 channel message 的 scoped queue、wake event 与单次 dispatch 测试；聚焦用例因 Inbox queue 为空失败。
- [x] **4.1.4** GREEN：实现微信 adapter/router 同等接线；保留现有 owner-only、授权撤销和停止入口。
  - 实现：微信 router 增加异步 dispatcher 注入；准入后将内容与 wake/outbox 原子写入 wechat scope，按原 owner/auth 检查后返回受理并异步派发，消息 ID 重复投递不重复追加。
  - GREEN：`npx vitest run --project electron electron/wechat/weChatCommandRouter.test.ts electron/feishu/remoteCommandRouter.test.ts electron/database/imInbox.test.ts electron/remote/wakeEventDispatcher.test.ts`：4 files / 41 tests passed；Feishu/WeChat router 类型检查通过。
- [x] **4.1.5** 回归：用真实数据操作层和 fake adapters 运行双渠道隔离测试，飞书、微信和桌面 scope 的 list/claim 互不可见。
  - GREEN：`electron/database/imQueueIsolation.test.ts` 使用真实 SQLite 数据操作与 Feishu/WeChat fake adapter 输入，验证相同 provider ID 在不同 channel 分开，Feishu/WeChat/desktop list 与 claim 不互见。聚焦与 queueScope/inbox suite 3 files / 16 tests passed。
- [x] **4.1.6** RED：新增 session busy 测试，同 session 新消息不返回 `session_busy` 丢弃，而是持久化并等当前 Loop 结束；验收使用 fake dispatcher。
  - RED 证据：`remoteCommandRouter.test.ts` 使用真实数据库/fake dispatcher 预先占用同 session slot；用例失败于 queue 为空，现有 router 将消息以 busy 结果终止。
- [x] **4.1.7** GREEN：调整 busy 分支为持久化受理并登记 wake event，使 4.1.6 通过。
  - 实现：Feishu/WeChat session busy 分支在返回前使用事务性 inbound+event+outbox append，再完成 processed claim 并派发；不将忙状态当作丢弃结果。
  - GREEN：Feishu/WeChat router + inbox + dispatcher suite 4 files / 42 tests passed；双路由目标 tsc 通过。
- [x] **4.1.8** RED：新增通道故障测试，消息持久化失败时不发“已受理”成功回执且不启动 Loop。
  - 测试：Feishu router 注入 outbox INSERT 故障，验证消息/event 回滚、无成功回执/dispatch/Agent。用例当前通过既有事务与 router catch，聚焦测试 1 passed。
- [x] **4.1.9** GREEN：实现入站提交失败的 fail-closed 路由结果，使 4.1.8 通过。
  - 实现：Feishu/WeChat 持久化失败时返回 `persistence_failed`，释放 processed claim，不发送成功回执且不派发 Loop。
  - GREEN：双路由故障用例各 1 passed；相关 suite 4 files / 44 tests passed；路由测试 direct tsc 通过。
- [x] **4.1.10** 回归：新增桌面测试，IM pending 入站不进入 desktop scope 消费、不作为额外 desktop transcript 消息显示；桌面 queued turn 的顺序、展示和 claim 行为保持不变。
  - RED：desktop queue 已隔离，但 `getChatMessagePage()` 仍返回 IM pending 消息，回归用例失败。
  - GREEN：桌面 `getMessages`、`getMessageSkeletons`、`getMessagesPageWithSequence`、`getChatMessagePage` 增加 desktop scope 过滤；`npx vitest run --project electron electron/database/operations.queueScope.test.ts electron/database/desktopQueueCompatibility.test.ts electron/database/operations.test.ts`：3 files / 103 tests passed。

### 4.2 Skill 注入与工具契约

- [x] **4.2.1** RED：新增 invocation assembler 测试，IM Agent Loop 获得唯一 `im-task-orchestration` Skill 及 Inbox/workflow 工具，不改变桌面 Skill 选择。
  - RED 证据：`electron/runtime/invocationAssembler.test.ts` 验证 IM skill 唯一注入、desktop 不注入及 Hosted runtime 的 Inbox/workflow 工具注册；当前 assembler 用例失败：IM skill fragments 数量为 0。
- [x] **4.2.2** GREEN：接入 bundled IM orchestration Skill 与本地测试夹具；Skill 承载意图分类、计划/澄清和消息路由策略，不让 runtime 硬编码业务分支。
  - 实现：新增 parser-validated `im-task-orchestration` bundled Skill，并只对 Feishu/WeChat lane 注入；测试 fixture registry 供 assembler 合约验证，桌面不注入。
  - GREEN：Skill scanner + assembler focused tests 2 files / 3 passed；fixture 与 bundled skill strict tsc 通过。Assembler 历史测试文件整体 tsc 存在既有类型错误（旧 mock/调用签名），已保留失败上下文待综合验证处理。
- [x] **4.2.3** RED：新增工具上下文测试，Inbox scope/channel/session/owner 从已鉴权 Runtime 上下文绑定，模型参数不能伪造或切换 scope。
  - RED：assembler contract test 引用尚不存在的 `bindImInboxToolContext`，聚焦测试失败于模块缺失。
  - GREEN：新增 `imInboxToolContext` binder，校验 lane/source 一致且 owner 存在，只从 runtime context 构造 scope/session/owner，并丢弃模型输入。聚焦边界测试通过（1 passed）。
- [x] **4.2.4** GREEN：实现 Inbox list 工具，验证只读、不消费、当前 scope 过滤。
  - RED：数据层无 `listImInboxMessages` 时聚焦测试失败（not a function）。
  - GREEN：实现只读 scope-filtered Inbox query 与受 runtime context 约束的 `im_inbox_list` 工具；`npx vitest run --project electron electron/database/imInbox.test.ts electron/runtime/invocationAssembler.test.ts electron/skills/bundled/imTaskOrchestrationSkill.test.ts -t "IM Inbox persistence|IM task orchestration|injects the dedicated orchestration skill|imTaskOrchestrationSkill"`：3 files / 13 passed。
- [x] **4.2.5** RED：新增 claim/ack/release/renew 工具边界测试，模型无法操作其他 scope 或其他 claim owner 的消息。
  - RED 证据：Inbox mutation tool registry 尚不存在，focused test 失败于 `createImInboxMutationToolRegistry is not a function`。
- [x] **4.2.6** GREEN：实现 Inbox claim/ack/release/renew 工具并使用数据层租约/owner 校验。
  - 实现：新增四个 direct tool adapter，只从 runtime context 取 scope/owner，交由既有数据层执行 lease/owner/status 原子校验。
  - GREEN：`npx vitest run --project electron electron/database/imInbox.test.ts -t "exposes claim, ack, release, and renew tools"`：1 passed。
- [x] **4.2.7** RED：新增 workflow_state get/put 测试，expectedRevision 冲突不覆盖旧状态且返回可恢复冲突。
  - RED 证据：workflow state 测试导入 `electron/database/workflowState.ts` 时失败，数据层 API/表不存在。
- [x] **4.2.8** GREEN：实现 workflow_state get/put，数据按 session/workflow/version 作用域隔离。
  - 实现：`electron/database/workflowState.ts` 使用 `(session_id,workflow_id,version)` 主键保存 JSON 和 revision；expectedRevision 使用事务内 CAS，冲突返回当前状态而不覆盖；schema v65 fresh DDL 与 v64→v65 migration 对齐。
  - GREEN：`npx vitest run --project electron electron/database/imInbox.test.ts electron/database/migrations.agentHistory.test.ts electron/database/thinkingEffort.test.ts`：3 files / 55 tests passed，含旧库迁移与文件重开。
- [x] **4.2.9** 新增 fake-model Skill flow 测试：轻量问题直接答；复杂/重要假设生成计划并待确认；信息不足进入澄清；修改目标后更新计划 revision。
  - RED：新增 flow 用例发现计划→澄清→修订时 `planRevision` 被澄清状态覆盖，最终仍为 1。
  - GREEN：Harness 合并保留可信 workflow data 的 `planRevision`；`npx vitest run --project electron electron/remote/imWorkflowSkillHarness.test.ts electron/database/imInbox.test.ts -t "IM orchestration Skill flow|stores workflow state with revision CAS"`：2 files / 3 passed。
- [x] **4.2.10** 新增等待确认测试：计划/澄清状态先持久化、输入消息 ack，然后 Loop 结束并释放 session 槽；回复到达后新 Loop 恢复 workflow。
  - RED：fake-model flow 原先只验证 workflow 状态与 ack，未有入口负责单次入站的 claim、会话槽释放和恢复顺序；新测试在 `processImWorkflowInbound` 缺失时失败。
  - GREEN：新增入站入口，按 session owner 获取槽、claim Inbox、运行 Skill 决策（写 workflow）、ack 成功后返回，并在 `finally` 释放槽。测试确认返回时消息已 ack、槽可由后续 Loop 获取，且新入站恢复并递增 plan revision。
  - GREEN：`npx vitest run --project electron electron/remote/imWorkflowSkillHarness.test.ts`：1 file / 3 tests passed。
- [x] **4.2.11** 新增消息处理测试：当前 Loop 期间多条入站都持久化；下一 Loop 由 Skill 决定追加/新请求/澄清，runtime 不写死顺序语义。
  - RED：fake model 收到下一轮消息时没有 Inbox 集合；新增测试于 `inboxMessages` 缺失处失败。
  - GREEN：workflow flow 将同 scope 待处理 Inbox 集合连同当前消息和 workflow state 交给注入的 Skill/model；不对消息排序语义作 runtime 决策。测试暂停首轮模型，在其运行期间追加两条入站，验证三条均持久化；恢复后下一轮 Skill 收到两条待处理消息并决定进入澄清，单条 ack 后另一条仍留在 Inbox。
  - GREEN：`npx vitest run --project electron electron/remote/imWorkflowSkillHarness.test.ts electron/remote/wakeEventSessionGate.test.ts electron/database/imInbox.test.ts`：3 files / 17 tests passed；`npm run typecheck:shared` passed；`npx tsc -p tsconfig.electron.json --noEmit --pretty false` passed。为通过正式 Electron 类型检查，将 IM scope builder 返回类型收窄为 IM variant，并修正测试 fixture 对 execution context 的对象展开类型。

## 5. 任务控制协调器（先对接 fake 安全待办端口）

本阶段只实现可信任务控制记录、revision/tombstone 与安全层 port；待办实际存储尚未在阶段 6 实现，因此本阶段测试使用 fake safety port。阶段 6 再接入真实待办 store。这样不要求越过编号顺序提前实现安全模块。

### 5.1 可信任务控制记录

- [x] **5.1.1** RED：新增数据层测试，任务控制记录绑定 `workflowId/taskId/sessionId/planRevision`，workflow data 无法伪造可信字段。
  - RED：`npx vitest run --project electron electron/database/taskControl.test.ts` 失败于 `Cannot find module './taskControl'`；新数据层与可信记录 API 尚不存在。
- [x] **5.1.2** 实现任务控制记录的版本化存取和 expectedRevision CAS；加入 scope/owner 校验测试。
  - 实现：schema v66 增加 `im_task_control`，记录键包含 session/owner/workflow/task/version，可信 `planRevision` 与 workflow payload 分列；`putTaskControlRecord` 使用 expectedRevision CAS，冲突返回当前记录、不覆盖数据。
  - GREEN：`npx vitest run --project electron electron/database/taskControl.test.ts electron/database/migrations.agentHistory.test.ts electron/database/migrations.sessionContentCutover.test.ts electron/database/migrations.sourceTruthSpillGc.test.ts electron/database/usageStatsFacts.test.ts electron/database/thinkingEffort.test.ts electron/database/migrations.v11.test.ts`：7 files / 84 tests passed；单测还验证 v65→v66 migration、owner/version scope、CAS。`npx tsc -p tsconfig.electron.json --noEmit --pretty false` passed。
- [x] **5.1.3** RED：新增步骤映射测试，新 plan revision 只保留明确映射且未变化步骤，移除/替换步骤产生待失效集合。
  - RED：新增 `electron/database/taskControl.revision.test.ts`，只允许显式映射且 instruction 未变化的 `scope → scope-v2` 保留；替换的 research 与移除的 budget invocation 进入 invalidation set。`npx vitest run --project electron electron/database/taskControl.revision.test.ts` 因 `mapTaskPlanRevision is not a function` 失败，符合预期缺失行为；GREEN 落在后续协调器实现任务。
  - GREEN：5.2.5 在 `electron/database/taskControl.ts` 实现纯映射函数，同文件 focused test 现通过；替换/删除 invocation 仅进入失效集合。

### 5.2 取消/计划变更线性化

- [x] **5.2.1** RED：新增 fake safety port 测试，task.cancel 在 dispatching 前调用关联待办失效端口，之后模拟追认不能进入派发。
  - RED：`npx vitest run --project electron electron/remote/imTaskControlCoordinator.test.ts` 失败于 coordinator 模块缺失；用例断言取消会先调用 fake safety invalidation，后续 resume 返回 invalidated 且不触发 dispatch port。
- [x] **5.2.2** RED：新增竞态测试，dispatching 已先开始时 cancel 返回动作已开始/不可撤回，不返回“全部停止”。
  - RED：新增 dispatch gate 竞态用例，dispatch adapter 进入后并发 cancel；当前仍因 coordinator 模块缺失失败，缺少“动作已开始”的线性化结果，未有实现混淆错误。
- [x] **5.2.3** RED：新增 fake safety port 测试，task.revisePlan 移除/替换步骤后请求失效旧 revision 待办，保留步骤按映射处理。
  - RED：fake safety port 契约用例覆盖显式未变步骤保留、替换/移除 invocation 请求旧 revision 失效；当前因 coordinator 模块缺失失败，缺少协调器映射/失效行为。
- [x] **5.2.4** RED：新增 crash/retry 测试，取消/修订 outbox 重复投递幂等；未完成撤销期间关联待办 fail closed。
  - RED：增加 safety port 首次失败、后续重试及重复投递用例；当前在 coordinator 模块缺失处失败，目标覆盖协调 outbox 不存在导致不可重试且无撤销期间 fail-closed 的行为。
- [x] **5.2.5** GREEN：实现可信 `task.cancel` / `task.revisePlan` 工具边界及协调 outbox；Runtime 从 workflow 关联解析目标待办并调用安全层 port，使 5.2.1–5.2.4 通过。
  - 实现：v67 持久协调 outbox、可信 control state 与 dispatch claim 表；cancel/revise 原子写入 pending state/outbox，再调用 fake safety port 失效关联 invocation。失败转 `reconciliation_required` 并阻断 resume；retry 使用稳定 operation id。dispatch/cancel/revise 在事务内竞争同一任务状态，已开始派发返回 `action_started`；只有显式映射且 instruction 未变化的步骤及其 invocation 保留。
  - 实现工具边界：`task_cancel` / `task_revise_plan` direct adapters 只从已鉴权 IM runtime 上下文取 session/owner；模型输入 scope 字段在 parser 白名单处剥离。bundled Skill 与 fixture registry 已声明工具。
  - GREEN：`npx vitest run --project electron electron/database/taskControl.test.ts electron/database/taskControl.revision.test.ts electron/remote/imTaskControlCoordinator.test.ts electron/remote/imTaskControlTools.test.ts electron/remote/imWorkflowSkillHarness.test.ts electron/database/migrations.agentHistory.test.ts electron/database/migrations.sessionContentCutover.test.ts electron/database/migrations.sourceTruthSpillGc.test.ts electron/database/usageStatsFacts.test.ts electron/database/thinkingEffort.test.ts electron/database/migrations.v11.test.ts`：11 files / 95 tests passed；相关 Skill/assembler/task control focused suite 6 files / 50 tests passed；`npx tsc -p tsconfig.electron.json --noEmit --pretty false`、`npm run typecheck:shared`、`git diff --check` passed。
- [x] **5.2.6** 新增端到端 fake workflow 测试，取消成功后旧待办回复不会执行原动作。
  - 验收：`electron/remote/imTaskControlWorkflow.e2e.test.ts` 使用 fake model 从计划等待开始，写入可信 task control 关联，取消后模拟旧 todo 回复；resume 返回 invalidated，fake dispatch 次数为 0。`npx vitest run --project electron electron/remote/imTaskControlWorkflow.e2e.test.ts`：1 file / 1 test passed。

阶段 5 的 fake safety port 任务只验证协调器合同。真实待办 adapter、恢复扫描和任务级线性化必须在阶段 6 完成，并在 6.6 的真实集成验收通过；不得将本阶段通过视为取消/修订安全已交付。

## 6. 上游安全待办与精确恢复（按子任务依赖决策与启用门禁）

### 6.1 安全待办数据与调用 envelope

- [x] **6.1.1** RED：新增类型测试，待办绑定稳定 `invocationId/workflowId/taskId/stepId/planRevision/originSessionId`，并区分 pending/dispatching/consumed/invalidated/expired 等终态。
  - RED：`src/shared/confirmation/deferredTodo.type.test.ts` 锁定 invocation/workflow/task/step/plan/origin 绑定和 5 个闭合状态；`npx tsc --noEmit --strict --target ES2022 --moduleResolution bundler --module ESNext --skipLibCheck src/shared/confirmation/deferredTodo.type.test.ts` 在缺少 `./deferredTodo` 类型模块处失败，两个 `@ts-expect-error` 同时提示身份/状态校验尚无目标类型。
- [x] **6.1.2** RED：新增 store 测试，channel/identityKey/owner/持久 `authorizationEpoch`、策略 `{ruleId,factsHash}` 或完整调用绑定不匹配时 fail closed；拒绝将进程内 generation 当持久授权依据。
  - RED：`electron/confirmation/deferredTodoStore.test.ts` 覆盖 channel、identity、owner、epoch、rule/factsHash 不符均不可读取，及缺少 durable epoch 时拒绝创建（进程 generation 不能替代）；语法修正后 `npx vitest run --project electron electron/confirmation/deferredTodoStore.test.ts` 在缺少 `deferredTodoStore` 模块处失败。
- [x] **6.1.3** RED：新增不可变 envelope 测试，绑定 `canonicalArgsHash/contentVersions/executionContextHash`、规范化算法与 schema 版本；覆盖正文/写入字节/附件变更、可变引用快照、缺失损坏/不支持版本/摘要不符均禁止执行。
  - RED：`electron/confirmation/deferredEnvelopeStore.test.ts` 覆盖 canonical args/content/context 摘要与版本、可变对象快照、missing/corrupt/unsupported/tampered envelope；Vitest 在缺少 `deferredEnvelopeStore` 模块处失败。
- [x] **6.1.4** 实现主进程受控 envelope 持久化与版本化恢复；按已定决策不加密存储，落实访问隔离、完整性校验与恢复；真实参数不可裁剪改写，且不进入 Skill 可写 workflow data、通知或普通日志。
  - 实现：shared `DeferredTodo` 身份/状态类型；v68 新增主进程 SQLite `deferred_call_envelopes`。store 对 canonical JSON 稳定排序并快照输入，持久保存 schema/canonicalization 版本、原始参数、内容版本、执行上下文及 SHA-256 摘要；load 校验版本、摘要和完整性，损坏/缺失返回 null，verify 对参数/正文或附件版本/上下文变化 fail closed。envelope 不进入 workflow data 或日志。
  - GREEN：`npx vitest run --project electron electron/confirmation/deferredEnvelopeStore.test.ts electron/database/taskControl.test.ts electron/remote/imTaskControlCoordinator.test.ts electron/remote/imTaskControlTools.test.ts electron/remote/imTaskControlWorkflow.e2e.test.ts electron/database/migrations.agentHistory.test.ts electron/database/migrations.sessionContentCutover.test.ts electron/database/migrations.sourceTruthSpillGc.test.ts electron/database/usageStatsFacts.test.ts electron/database/thinkingEffort.test.ts electron/database/migrations.v11.test.ts`：11 files / 93 tests passed；deferred todo strict type test、Electron tsc、shared typecheck、`git diff --check` 均通过。
- [x] **6.1.5** RED：新增幂等测试，同一 invocationId 重复创建 deferred todo 返回同一 todoId，不生成重复用户通知/派发记录。
  - RED：在 `electron/confirmation/deferredTodoStore.test.ts` 重试同一 invocation，断言 todoId 相同且数据库唯一记录计数为 1；`npx vitest run --project electron electron/confirmation/deferredTodoStore.test.ts` 在缺少 store 模块处失败。
  - GREEN：store 按 invocationId 唯一约束和 immutable binding 比对返回原 todo，不重复插入；全 store suite 中幂等用例通过。
- [x] **6.1.6** 实现待办 store 状态转换与关联撤销 API；TTL 默认 24h、合法 pending 重启保留，按原始创建时间过期且重启/补发/resume 不延长 TTL；另测边界。
  - 实现：v69 `deferred_todos` 表持久身份/策略/TTL/状态；store 支持幂等创建、授权 scope 读取、pending→dispatching→consumed、pending→invalidated/expired，按 task/revision 关联失效并报告 dispatching。默认 24h TTL 固定由 createdAt 计算；文件数据库重开后 pending 仍在，过期边界由存储 expiresAt 判定。
  - GREEN：`npx vitest run --project electron electron/confirmation/deferredTodoStore.test.ts electron/confirmation/deferredEnvelopeStore.test.ts electron/database/taskControl.test.ts electron/database/migrations.agentHistory.test.ts electron/database/migrations.sessionContentCutover.test.ts electron/database/migrations.sourceTruthSpillGc.test.ts electron/database/usageStatsFacts.test.ts electron/database/thinkingEffort.test.ts electron/database/migrations.v11.test.ts`：9 files / 91 tests passed；Electron tsc、shared typecheck、DeferredTodo strict type test、`git diff --check` passed。
- [x] **6.1.7** RED：按安全需求配置新增单 session、单 identity pending todo 容量边界与并发创建测试；同 invocationId 幂等重试不重复占额，准备记录也计入预留。
  - RED：`electron/confirmation/deferredTodoCapacity.test.ts` 并发创建 20 个 prepared/pending reservation，要求 session=5、identity=10 双上限均生效；幂等 invocation 不重复计数，错误 invocation 不能释放他人预留。`npx vitest run --project electron electron/confirmation/deferredTodoCapacity.test.ts` 在缺失 capacity controller 模块处失败。
- [x] **6.1.8** GREEN：实现两级原子名额预留/释放和启动时过期及预留对账；使用需求已定的默认值（session=5、identity=10），配置值校验失败时 fail closed。
  - 实现：v70 增加持久 reservation 表；`deferredTodoCapacity` 以 SQLite transaction 原子检查 session/identity 两级用量并预留，prepared/pending 均占额；支持稳定 invocation 幂等、同 invocation owner 校验释放、prepared→pending、启动 reconcile 时按 expiry 与有效 invocation 集过期/释放；默认 5/10，limits 非正整数/超范围时构造失败，不降级。
  - GREEN：`npx vitest run --project electron electron/confirmation/deferredTodoCapacity.test.ts`：1 file / 4 tests passed；容量测试覆盖 20 个并发 prepared/pending 预留、幂等占额、owner-bound release、过期/孤儿 reconcile、非法限值和 v69→v70 迁移。迁移回归 7 files / 85 tests passed；Electron tsc、shared typecheck、`git diff --check` passed。
- [x] **6.1.9** RED：新增超限出口测试，不能创建新 todo、不能派发动作，审批层产生 `deny(no-answerer)` 及安全回执；并覆盖 TTL=0 不挂起。
  - RED：`electron/confirmation/deferredTodoAdmission.test.ts` 验证容量满时返回 deny(no-answerer) + receipt，且不创建 todo/不 dispatch；TTL=0 调用 normal fallback，不能 reserve/create。
  - RED 命令：`npx vitest run --project electron electron/confirmation/deferredTodoAdmission.test.ts` 在缺少 admission adapter 模块处失败。
- [x] **6.1.10** GREEN：接通待办容量拒绝与 TTL=0 到真实审批结果/fallback，验证并发下计数不超限、过期/失效/消费按定稿规则释放容量。
  - 实现：`createPersistentDeferredTodoAdmission` 将持久 capacity reservation、todo store 与审批出口连接；超限返回 `deny(no-answerer)` 并发送安全 receipt，不创建 todo/不派发；TTL=0 直接执行正常 fallback；todo 消费、过期、失效时通过 invocation 关联释放额度。
  - GREEN：`npx vitest run --project electron electron/confirmation/deferredTodoAdmission.test.ts electron/confirmation/deferredTodoCapacity.test.ts electron/confirmation/deferredTodoStore.test.ts electron/confirmation/deferredEnvelopeStore.test.ts electron/database/taskControl.test.ts electron/database/migrations.agentHistory.test.ts electron/database/migrations.sessionContentCutover.test.ts electron/database/migrations.sourceTruthSpillGc.test.ts electron/database/usageStatsFacts.test.ts electron/database/thinkingEffort.test.ts electron/database/migrations.v11.test.ts`：11 files / 99 tests passed；并发实际 admission 20 入站最多 10/identity 且共享 session 最多 5；Electron tsc、shared typecheck、DeferredTodo strict type test、`git diff --check` passed。
- [x] **6.2.1** RED：新增状态机测试，`security_action_intent` 按 `prepared → todo_linked → checkpoint_committed → notified` 前进，未 `checkpoint_committed` 不可通知、追认或派发。
  - RED：`electron/confirmation/securityActionIntentStore.test.ts` 覆盖四阶段持久状态机；`prepared`/`todo_linked` 时通知、resume、dispatch 均被拒绝，checkpoint commit 后才放行。`npx vitest run --project electron electron/confirmation/securityActionIntentStore.test.ts` 因 store 模块缺失失败。

### 6.2 checkpoint 准备、关联与补偿基础（先于真实审批接线）

- [x] **6.2.2** GREEN：实现稳定 `invocationId` 准备日志及状态转换；可用 fake safety port 驱动 store 边界，但 checkpoint 与准备日志必须落真实本地持久化层。
  - 实现：v71 `security_action_intents` 以 invocationId 唯一键保存可信 session/workflow/task/step/plan/envelope 绑定；状态机仅允许 prepared→todo_linked→checkpoint_committed→notified，转换幂等并校验绑定；通知/resume/dispatch 只能在 checkpoint_committed 后准入。记录和 checkpoint 标识均写 SQLite，可文件重开恢复。
  - GREEN：`npx vitest run --project electron electron/confirmation/securityActionIntentStore.test.ts electron/confirmation/deferredTodoCapacity.test.ts electron/database/taskControl.test.ts electron/database/migrations.agentHistory.test.ts electron/database/migrations.sessionContentCutover.test.ts electron/database/migrations.sourceTruthSpillGc.test.ts electron/database/usageStatsFacts.test.ts electron/database/thinkingEffort.test.ts electron/database/migrations.v11.test.ts`：9 files / 90 tests passed；security intent focused 1 file / 2 tests passed（重开与 v70→v71 migration）；Electron tsc、`git diff --check` passed。
- [x] **6.2.3** RED：分别注入待办落盘后、关联落盘前、checkpoint 提交前崩溃；恢复后唯一 todo 与唯一 workflow 归属可补齐或安全失效。
  - RED：`electron/confirmation/securityActionIntentRecovery.test.ts` 构造 prepared+已落盘 todo、todo_linked+checkpoint、以及无 checkpoint 孤儿三种重启状态；要求重复扫描幂等、唯一绑定可补齐，孤儿 todo 安全失效。首次运行因 recovery module 缺失失败。
- [x] **6.2.4** GREEN：实现按 `invocationId` 恢复扫描、todo 关联事务/outbox 与孤儿安全失效，使 6.2.3 通过。
  - 实现：v72 增加 `(invocationId, action)` 唯一 intent outbox；prepare、todo link、checkpoint commit 与 outbox 状态在 SQLite transaction 内更新。恢复扫描按 pending outbox 读取，按 invocationId 校验 todo 的完整 workflow/task/step/revision 归属，缺 checkpoint 或关联不符则失效 todo 并 discard pending recovery；有效 checkpoint 补齐 link/commit，重复恢复无重复通知/待办。
  - GREEN：`npx vitest run --project electron electron/confirmation/securityActionIntentRecovery.test.ts electron/confirmation/securityActionIntentStore.test.ts electron/confirmation/deferredTodoAdmission.test.ts electron/confirmation/deferredTodoCapacity.test.ts electron/confirmation/deferredTodoStore.test.ts electron/confirmation/deferredEnvelopeStore.test.ts electron/database/taskControl.test.ts electron/database/migrations.agentHistory.test.ts electron/database/migrations.sessionContentCutover.test.ts electron/database/migrations.sourceTruthSpillGc.test.ts electron/database/usageStatsFacts.test.ts electron/database/thinkingEffort.test.ts electron/database/migrations.v11.test.ts`：13 files / 102 tests passed；Electron tsc、shared typecheck、`git diff --check` passed。
- [x] **6.2.5** RED：新增执行结果恢复测试，派发后、结果落盘前、outbox 投递前崩溃时，可查询结果则补偿，无法判定副作用则进入 `outcome_unknown` 且禁止自动重放。
  - RED：`electron/confirmation/deferredExecutionResultStore.test.ts` 覆盖稳定 dispatch key 对账、无法判定结果禁止自动重放、结果/outbox 投递恢复。首次运行在结果 store 模块缺失处失败。
- [x] **6.2.6** GREEN：实现执行日志与结果 outbox，记录派发幂等键、真实结果/受控结果引用及完成事件，并以 todoId + invocationId 幂等，使 6.2.5 通过。
  - 实现：v73 `deferred_execution_results` + `deferred_completion_outbox` 持久 dispatching、dispatchKey、受控结果 JSON 与 completion event。todoId/invocationId/dispatchKey 唯一；stable key 对账找回结果后原子提交结果与 outbox；未知结果转 `outcome_unknown` 并禁止自动重放；通知成功前 outbox 保持 pending，投递登记幂等。
  - GREEN：`npx vitest run --project electron electron/confirmation/deferredExecutionResultStore.test.ts electron/confirmation/securityActionIntentRecovery.test.ts electron/confirmation/securityActionIntentStore.test.ts electron/database/taskControl.test.ts electron/confirmation/deferredTodoCapacity.test.ts electron/database/migrations.agentHistory.test.ts electron/database/migrations.sessionContentCutover.test.ts electron/database/migrations.sourceTruthSpillGc.test.ts electron/database/usageStatsFacts.test.ts electron/database/thinkingEffort.test.ts electron/database/migrations.v11.test.ts`：11 files / 96 tests passed；含文件库重开及 v72→v73 migration；Electron tsc、shared typecheck、`git diff --check` passed。
- [x] **6.3.1** RED：为共享确认结果契约新增测试，明确区分 approve、deny、undetermined、unavailable、timeout、unparsable 与 deferred；config-error、locked/critical、递归限制不得映射为 deferred。
  - RED：`npx vitest run --project renderer src/shared/confirmation/deferredApprovalResult.test.ts` 因目标 `deferredApprovalResult` 模块缺失而失败，确认测试先于实现。

### 6.3 真实审批入口到 `deferred` 的映射与接线

- [x] **6.3.1** RED：为共享确认结果契约新增测试，明确区分 approve、deny、undetermined、unavailable、timeout、unparsable 与 deferred；config-error、locked/critical、递归限制不得映射为 deferred。
- [x] **6.3.2** GREEN：实现共享确认结果契约及其序列化/类型边界；只在上游定稿允许异步待办的裁决出口使用 deferred。
  - 实现：新增 `deferredApprovalResult.ts`，以 eligibility 联合类型区分未请求异步、已获准异步及配置/安全 gate 阻断；共享序列化解析器只接受已声明的结果变体，deferred 必须带 todoId。只有 approve + eligible 映射 deferred。
  - GREEN：`npx vitest run --project renderer src/shared/confirmation/deferredApprovalResult.test.ts`：1 file / 2 tests passed；Electron tsc、`npm run typecheck:shared`、`git diff --check` passed。
- [x] **6.3.3** RED：使用 fake provider 经真实 `electron/confirmation/channels.ts`、`agentChannel.ts`、`agentSdkConfirmationPort.ts` 路径测试上述结果映射及现有 fallback，禁止直接注入预制 deferred 结果。
  - RED/特征验证：新增 SDK port 用例以 fake provider 驱动 `resolveConfirmChannel`→`AgentChannel`→SDK port，检查 undetermined 保留原因且不走 fallback；未注入预制 deferred。现有测试也覆盖 deny、transport failures、timeout 与 user fallback。
  - GREEN/验证：`npx vitest run --project electron electron/confirmation/agentSdkConfirmationPort.test.ts electron/confirmation/agentChannel.test.ts electron/confirmation/channels.test.ts`：3 files / 62 tests passed；Electron tsc、`git diff --check` passed。
- [x] **6.3.4** GREEN：实现审批 gate 到待办创建的内部 adapter 与安全结果映射，但保持生产 IM 回答者选择关闭；审批失败、不可判定或待办持久化失败时按上游定稿 fallback fail closed，不通知成功、不派发动作。
  - 实现：新增 `deferredApprovalAdapter`，只接受 approve+eligible 的资格映射，要求待办含稳定 invocation/reservation 绑定；只有 admission 明确返回 deferred 才返回 deferred，容量/TTL fallback 原样向上返回，持久化异常 fail closed。adapter 不执行派发。
  - RED：adapter 缺失时测试导入失败；GREEN：`npx vitest run --project electron electron/confirmation/deferredApprovalAdapter.test.ts`：1 file / 4 tests passed；覆盖不确定/失败、持久化失败、只在创建成功后 deferred、零 dispatch。Electron tsc、shared typecheck、`git diff --check` passed。
- [x] **6.3.5** RED：新增回答者选择测试，IM channel 按已定稿策略选择安全审核 Agent；desktop 与 automation 仍选择既有回答者且行为不变。
  - RED：`electron/confirmation/channels.test.ts` 新增回答者策略矩阵；首次运行因 `selectConfirmationAnswerer` 尚未导出而失败。
- [x] **6.3.6** GREEN：实现 `electron/confirmation/channels.ts`、`electron/confirmation/agentChannel.ts`、`electron/confirmation/agentSdkConfirmationPort.ts` 的关闭态接线与独立配置回退开关；生产 IM 回答者选择仍关闭，不提前改变默认路径。
  - 实现：`resolveConfirmChannel` 增加独立 `remoteAsyncApprovalEnabled` 可选开关；默认及关闭时仍按 user 路径，显式打开仅将 IM 默认回答者切至 Agent，desktop/automation 默认回答者不变。AgentChannel/SDK port 沿用既有可注入接线与 fallback 语义，选择器未接入生产装配配置，当前生产保持关闭。
  - GREEN：通道、AgentChannel、SDK port、adapter focused suites：4 files / 67 tests passed；Electron tsc、shared typecheck、`git diff --check` passed。
- [x] **6.3.7** RED：新增真实双渠道集成测试，从飞书/微信真实确认入口经 gate/adapter 到持久化待办；覆盖 approve、deny、undetermined、unavailable、timeout、unparsable，以及 config-error、locked/critical、递归限制不进入待办。
  - 历史 RED：新增 `imAsyncApproval.integration.test.ts`，真实 `resolveConfirmChannel` / `AgentChannel` 与 persistent admission 首次暴露容量预留缺失 session/identity 绑定；旧版本裁决矩阵曾将 Agent deny/undetermined/服务失败统一映射为 deferred。当前规则以顶部覆盖和 IM 安全改进契约为准：Agent deny 终局拒绝；undetermined/暂时服务不可用进入原渠道待办；不可解析、配置错误与安全 gate 阻断失败关闭。
  - GREEN：`npx vitest run --project electron electron/confirmation/imAsyncApproval.integration.test.ts electron/confirmation/deferredApprovalAdapter.test.ts electron/confirmation/deferredTodoAdmission.test.ts electron/confirmation/deferredTodoStore.test.ts`：4 files / 24 tests passed；最终矩阵回归 9 Electron files / 156 tests passed；Electron tsc、shared typecheck、`git diff --check` passed。
- [x] **6.3.8** RED：新增飞书与微信入口集成测试，从真实确认调用链贯通至临时数据库待办；只验证关闭态/显式测试开关，不提前启用默认异步行为。
  - GREEN/特征验证：集成用例验证 wechat/feishu 显式测试开关开启时走 Agent 到真实临时 SQLite todo；开关关闭时保持原 IM 确认 waiter 且 Agent factory 未调用。`npx vitest run --project electron electron/confirmation/imAsyncApproval.integration.test.ts`：1 file / 14 tests passed；Electron tsc、`git diff --check` passed。
- [x] **6.3.9** RED：新增缓存策略测试，普通待办追认永不 `cache.write`；验证拒绝/locked/critical/outbound 不进入记忆授权路径，desktop/automation 既有行为不变。
  - RED：`deferredApprovalCachePolicy.test.ts` 首次运行因策略模块不存在失败；增加类型边界和各 lane/verdict/actionClass 无记忆资格矩阵。
  - GREEN/验证：`npx vitest run --project electron electron/confirmation/deferredApprovalCachePolicy.test.ts electron/confirmation/decisionCacheWriter.test.ts electron/confirmation/imAsyncApproval.integration.test.ts`：3 files / 24 tests passed；Electron tsc、shared typecheck、`git diff --check` passed。
- [x] **6.3.10** GREEN：首版不实现“批准并记住”；普通追认只授权当前动作且不得写长期缓存，本地测试验证没有任何待办追认路径产生长期授权写入。
  - 实现：DeferredApprovalResult 不含 memory/cache key，deferred adapter 无 cache writer/remember 接口；策略对全部 lane/verdict/actionClass 恒不给长期记忆资格。
  - GREEN：`npx vitest run --project electron electron/confirmation/deferredApprovalCachePolicy.test.ts`：1 file / 4 tests passed，含 spy 验证没有调用 `recordUserAnswerFromMemoryTiers`；不得增加独立“批准并记住”入口。
- [x] **6.3.11** RED（原异步计划历史契约，outbound 语义已由顶部 2026-10-12 覆盖替代）：新增 G1–G4 与 A1–A12 裁决矩阵测试，覆盖批准/拒绝/无回答者/TTL=0/关闭开关、locked/critical、显式委托证据、材料诱导、截断限制及当时的 outbound 真人追认矩阵；关闭开关只测出口合同/fake port，不替代 6.5.16 的真实回退验收。
  - 历史 RED：新增 `imAsyncApprovalPolicy.test.ts` 覆盖当时 A1–A12 及 G2–G4 出口合同；首跑在策略模块缺失处失败。随后新增 SDK outbound 防绕过与 memory eligibility 测试，证明旧路径曾允许 Agent approve 和 session memory。上述测试/实现证据不授权新受控回复例外，也不验证其 final check。
- [x] **6.3.12** GREEN（旧行为版本，当前出口见顶部覆盖）：完成当时裁决结果合同和关闭态回答者选择接线；默认保持 `remoteAsyncApprovalEnabled=false`，关闭态走既有 user 回答者；仅验证历史出口合同，不声称完成新策略迁移、入口冻结或 permit fencing。
  - 历史实现：旧版本对 outbound 一律 deferred、无 Agent approve/cache/auto-allow；当前契约仅要求主动外发人工/禁止，受控 owner 普通回复可在每次主进程 final check 后执行。`resolveConfirmChannel` 旧 rollout fence 默认关闭的证据不等于新策略门禁或本次自动审核启用。
  - GREEN：focused Electron 9 files / 156 tests passed；shared 2 files / 13 tests passed；Electron tsc、shared typecheck、`git diff --check` passed。

### 6.4 授权撤销级联接线

- [x] **6.4.1** RED：为 `electron/remote/remoteAuthorizationRegistry.ts` 的待办 invalidator 与持久 authorizationEpoch 新增测试；epoch 不复用、单调推进，缺失/损坏不得回退为 0。
  - RED：新增 `remoteAuthorizationEpoch.test.ts` 覆盖跨重开递增、row 缺失和损坏 fail closed（目标 store 缺失）；另在 deferredTodoStore 覆盖旧 epoch pending todo 失效、dispatching 保持 fencing（目标 API 缺失）。
- [x] **6.4.2** GREEN：实现持久 epoch、撤销协调记录和 schema migration；启动时先恢复配置/epoch/tombstone 并完成级联，之后才开放待办/恢复入口。
  - 实现：schema v74 持久化每 channel epoch 与 pending/completed revocation journal；store 对 epoch 作整数/正值校验，缺失/损坏直接报错。registry 先推进 epoch，再跑已注册待办 invalidator、pending cancel、write grant/cache 清理，完整成功后才完成 journal；失败保持 pending，恢复前 `getAuthorizationEpoch` 拒绝。Feishu/WeChat bundle 注册 todo invalidator；main 启动打开数据库后恢复 epoch，注册两路 invalidator 后先完成 pending cascade 再 auto-start ingress。
  - GREEN：`npx vitest run --project electron electron/remote/remoteAuthorizationEpoch.test.ts electron/remote/remoteAuthorizationRegistry.test.ts electron/confirmation/deferredTodoStore.test.ts electron/database/migrations.agentHistory.test.ts electron/database/migrations.sessionContentCutover.test.ts electron/database/migrations.sourceTruthSpillGc.test.ts electron/database/usageStatsFacts.test.ts electron/database/thinkingEffort.test.ts electron/database/migrations.v11.test.ts electron/database/taskControl.test.ts`：10 files / 100 tests passed；Electron tsc、shared typecheck、`git diff --check` passed。
- [x] **6.4.3** RED：新增提交失败测试，配置写入、epoch 提交或级联任一步失败时授权面派发 fail closed，不能报告撤销成功。
  - RED/GREEN：`remoteAuthorizationRevocationCoordinator.test.ts` 覆盖 config write、epoch advance、cascade、journal completion 失败；任何失败保持 channel fence 且不返回完成。Feishu 安全配置提交仅在两渠道 coordinator 完成后通知成功。
  - GREEN：`npx vitest run --project electron electron/remote/remoteAuthorizationRevocationCoordinator.test.ts electron/remote/remoteAuthorizationRegistry.test.ts electron/remote/remoteAuthorizationEpoch.test.ts electron/remote/remoteSecurityConfigDb.test.ts electron/remote/remoteWriteAuthorization.test.ts electron/remote/imInboundGuard.test.ts electron/feishu/remoteCommandRouter.test.ts electron/wechat/weChatCommandRouter.test.ts electron/feishu/feishuImChannel.test.ts electron/wechat/weChatImChannel.test.ts`：10 files / 76 tests passed；Electron tsc、shared typecheck、`git diff --check` passed。
- [x] **6.4.4** GREEN：实现 registry 到待办 store、resume_request、消费未派发 permit 及相关缓存的 invalidator 注册、注销和幂等级联。
  - 实现：registry 使用有键的 invalidator 注册表，支持替换与安全注销；Feishu/WeChat bundle 创建时替换同渠道 handler，shutdown 时注销。级联调用待办失效、可选 resume_request invalidator、可选未派发 permit revoker、共享渠道 permit 撤销及缓存清理。新增 `ConfirmationAuthorizationRegistry.revokeByChannel`，同时清理未消费 permit 与恢复窗口。
  - 现状边界：仓库尚未实现持久 `resume_request` store/dispatcher；registry 已提供可接入的 `invalidateResumeRequests` hook，实际持久请求接线留在 6.5 dispatcher 实现。permit 当前为内存态；渠道字段用于绑定待撤销授权，缺少渠道字段的历史/本地 permit 不受远程渠道撤销影响。
  - GREEN：授权 registry、epoch、todo、capacity、permit 与 schema 回归 8 files / 40 tests passed；补充 registry/permit 生命周期用例 2 files / 17 tests passed；Electron tsc、shared typecheck、`git diff --check` passed。
- [x] **6.4.5** RED：新增入口驱动测试：渠道关闭、owner/白名单变化、工作目录/敏感目录边界变化、session 删除分别触发关联待办级联失效。
  - RED：session 删除入口用例首先因 registry 未被调用失败；store origin-session invalidator 用例因 API 不存在失败。随后补齐按 session 选择性失效及 dispatching ids 报告，确保执行中记录不被误标终态。
  - GREEN：`npx vitest run --project electron electron/remote/remoteAuthorizationRevocationCoordinator.test.ts electron/remote/remoteAuthorizationRegistry.test.ts electron/remote/remoteAuthorizationEpoch.test.ts electron/remote/remoteSecurityConfigDb.test.ts electron/confirmation/deferredTodoStore.test.ts electron/confirmation/deferredTodoCapacity.test.ts electron/confirmation/confirmationAuthorizationRegistry.test.ts electron/confirmation/securityActionIntentStore.test.ts electron/confirmation/deferredExecutionResultStore.test.ts electron/configIpc.keyAtomicity.test.ts electron/appIpc.sessionUpdate.test.ts`：11 files / 65 tests passed；Electron tsc、shared typecheck、`git diff --check` passed。
- [x] **6.4.6** GREEN：将上述实际撤销/删除触发点逐一接到 registry；保留执行前授权复检，不能以复检替代持久化撤销事实。
  - 实现：渠道关闭、owner/allowlist 更新由 Feishu/WeChat config persist helper 通过同步 revocation coordinator 执行 fence→config write→epoch→cascade→journal complete；remote-security 双渠道更新共用同一 coordinator。workdir path/active profile/sensitive boundary 更新在 config IPC 成功保存后推进两路 durable epoch；session 删除前通过 `invalidateSession` 写入带 session scope 的 durable journal，级联该 session todo、pending waiter、write grant 与相关缓存后才继续删除。resume 和 permit hooks 保留扩展点，permit registry 按 channel 撤销。
  - 恢复：revocation journal 可带 session_id；启动恢复按 scope 选择性失效，失败保留 pending journal 和 dispatch fence。todo store 报告 dispatching ids 后拒绝完成撤销；工具原有执行前策略/epoch复检保留。
  - GREEN：入口及 coordinator 回归 11 files / 65 tests、router/channel 回归 7 files / 73 tests、授权/epoch/todo 相关回归 5 files / 40 tests 均通过；Electron tsc、shared typecheck、`git diff --check` passed。
- [x] **6.4.7** RED：新增恢复与竞态测试：授权关闭再开启、同 owner 解绑/重绑、配置改动后重启、撤销与 resume_request/消费并发时旧待办不得进入 executor。
  - RED：新增较早未完成 session tombstone 与新删除交错测试，首次因 registry 只处理新 session、并错误完成所有 pending rows 而失败。
  - GREEN：新撤销前先重放该 channel 所有旧 journal；session tombstone 的恢复与即时路径都保留精准 session scope，dispatching todo 导致 journal 保持 pending 与 channel fenced。加入关闭再开启的 epoch 单调测试、真实 SQLite reopen 恢复测试、撤销先于 claim/consume 时旧 todo 无法 claim，以及 dispatch 已开始时返回 started/fenced 的并发边界测试。
  - GREEN：`npx vitest run --project electron electron/remote/remoteAuthorizationRegistry.test.ts`：1 file / 16 tests passed；其中包含真实重开 SQLite 和真实 todo store；Electron tsc、shared typecheck、`git diff --check` passed。
- [x] **6.4.8** GREEN：完成跨重启 epoch 校验与撤销/消费线性化；使用真实授权/会话/配置入口和临时数据库验收，不预置 invalidated 终态或 fake safety port。
  - GREEN：配置 IPC 真实 `config:set` → Feishu persist helper → durable coordinator，以临时 DB、真实 epoch store/todo store 验证关闭→开启→owner allowlist 变化，epoch 依次保持 2、再推进 3，旧 todo 在新入口下不能 claim。SQLite reopen 用真实 registry/store 从 session tombstone 恢复，只失效被删 session，其他 session todo 保持 pending；撤销先完成后 claim/consume 旧 todo 返回拒绝。session 删除真实入口保留 registry 调用，registry 实际 cascade 覆盖 pending waiter、todo、permit 和缓存；dispatching 状态保持 fence。
  - 验证：`npx vitest run --project electron electron/configIpc.keyAtomicity.test.ts electron/appIpc.sessionUpdate.test.ts electron/remote/remoteAuthorizationRegistry.test.ts electron/remote/remoteAuthorizationEpoch.test.ts electron/confirmation/deferredTodoStore.test.ts electron/remote/remoteSecurityConfigDb.test.ts electron/remote/remoteAuthorizationRevocationCoordinator.test.ts`：7 files / 55 tests passed；Electron tsc、shared typecheck、`git diff --check` passed。
- [x] **6.4.9** RED：为阶段 5 task-control outbox 到真实 todo store 的 invalidation/dispatch guard adapter 新增测试；恢复扫描继续未完成的 cancel/revise 操作。
  - RED：新增 `deferredTodoTaskControlAdapter.test.ts`，首次因 task-control safety adapter 模块不存在而失败；合同覆盖真实 todo store 按 invocationId 失效、保留无关 todo 和 dispatching todo 阻断取消完成。
- [x] **6.4.10** GREEN：接通阶段 5 task-control/outbox 与真实 todo store 及恢复扫描；交付持久 tombstone、未完成操作 fail-closed 状态及幂等失效。该任务不包含尚未实现的 resume dispatcher/真实派发竞态验收。
  - 实现：`deferredTodoStore.invalidateByInvocations` 原子失效请求 invocation 并报告 dispatching IDs；`createDeferredTodoTaskControlSafetyPort` 接到真实 store。task-control coordinator 新增 pending operation recovery scan，按创建顺序重试 requested/reconciliation_required；startup 在开放 IM ingress 前恢复并 fail closed。revision 已持久提交但 operation 未完成时，恢复检测新 revision 并只完成 operation，不重复创建 revision。startup adapter 使用真实 todo capacity lifecycle。
  - GREEN：`npx vitest run --project electron electron/remote/deferredTodoTaskControlAdapter.test.ts electron/remote/imTaskControlCoordinator.test.ts electron/remote/imTaskControlWorkflow.e2e.test.ts electron/remote/imTaskControlTools.test.ts electron/database/taskControl.test.ts electron/database/taskControl.revision.test.ts`：6 files / 14 tests passed；Electron tsc、shared typecheck、`git diff --check` passed。
- [x] **6.4.11** RED：用真实 task-control/store 验证 cancel/revise requested 落盘后、级联前崩溃，重启恢复幂等完成待办失效；恢复期间 store dispatch guard 拒绝关联待办。
  - RED/GREEN：临时 SQLite 中真实 cancel/revise operation 持久化后注入安全级联故障并关闭 DB；重开后 coordinator recovery scan 联到真实 todo store，cancel 的旧 todo 失效，revision 仅失效移除步骤且保留映射步骤。恢复开始期间 todo 不可 claim；operation 未完成时 startup recovery 未返回成功并由 main 阻止 ingress。
  - GREEN：`npx vitest run --project electron electron/remote/deferredTodoTaskControlAdapter.test.ts electron/remote/imTaskControlCoordinator.test.ts electron/remote/imTaskControlWorkflow.e2e.test.ts electron/remote/imTaskControlTools.test.ts electron/database/taskControl.test.ts electron/database/taskControl.revision.test.ts`：6 files / 16 tests passed；Electron tsc、shared typecheck、`git diff --check` passed。
- [x] **6.4.12** GREEN：补齐 task-control 恢复扫描与 store 级 fail-closed dispatch guard，使 6.4.11 通过；真实 executor 派发边界验收留到 6.5 派发器完成后。
  - RED：真实重开测试增加断言：task-control operation 仍 requested/reconciliation_required、todo 仍 pending 时直接 claim 原会成功，说明 coordinator 恢复前缺少 store 级围栏。
  - GREEN：`claimForDispatch` 查询相同 session/owner/workflow/task 的未完成 operation；存在时拒绝关联 todo claim。cancel 与 revise 恢复用例验证恢复期间旧 todo（包括 revision 保留步骤）不可派发，operation 完成后只有未被撤销的映射步骤仍 pending。
  - 验证：`npx vitest run --project electron electron/remote/imTaskControlCoordinator.test.ts electron/confirmation/deferredTodoStore.test.ts electron/remote/deferredTodoTaskControlAdapter.test.ts`：3 files / 17 tests passed；Electron tsc、shared typecheck、`git diff --check` passed。

### 6.5 安全等待、追认与精确恢复

- [x] **6.5.1** RED：新增 tool gate 集成测试，经真实审批入口返回 deferred 时原工具 executor 调用次数为零，todo 已持久化关联且 checkpoint 已提交。
  - 实现/验收：`electron/tools/registeredAgentTurnTools.test.ts` 使用真实 SDK turn、SQLite deferred todo 与 intent store 验证 deferred gate；原 RegisteredTool executor 和 admission dispatch 均为零，intent=`checkpoint_committed`，todo 仍 pending。
- [x] **6.5.2** RED：新增故障注入测试，todo 创建、关联提交或 checkpoint 提交任一步失败/崩溃时，不得通知、接受追认或派发原动作。
  - 验收：`securityActionIntentStore.test.ts` 对 todo-link/checkpoint 更新注入 SQLite trigger 中断，intent 保持 prepared/todo_linked，notify/resume/dispatch 均不可授权；`deferredApprovalAdapter.test.ts` 对 admission/checkpoint 错误验证 fallback 且不派发。
- [x] **6.5.3** GREEN：实现 deferred 返回协议，将 `todoId + invocationId + checkpointRef` 交给 IM workflow，且不把可写 envelope 暴露给 Skill；仅在 checkpoint_committed 后允许通知/追认。
  - 实现：Agent SDK confirmation 增加 deferred outcome 与专用 `approval-deferred` History 事件；turn 验证 invocation/checkpoint 绑定并阻止工具 executor；adapter 按 prepare→todo link→checkpoint commit 顺序提交 intent，只有 `authorizeResume` 成立后才返回 deferred。SQLite History transition/reopen 与 provider replay 不合成执行结果。
- [x] **6.5.4** RED：新增部分推进测试，独立步骤经各自安全审核后可执行，依赖 deferred 动作的步骤不会越过依赖边。
  - 验收：IM workflow harness 对 completed step 的每条依赖强制要求 dependency completed；独立 completed step 可与 deferred step 并存并持久化。
- [x] **6.5.5** RED：新增测试，同一 deferred 动作不可通过模型改参、换工具或新 Loop 重建调用来绕过阻断。
  - 验收：task-control resume 仅接受 outstanding invocation 中登记的 todoId/step binding；envelope verify 绑定 toolName、canonical args、content versions 与 execution context，替换工具/参数失败关闭。
- [x] **6.5.6** GREEN：实现安全等待边界与调用身份绑定；若 Agent Loop 无法表达/持久化独立步骤 checkpoint，则实现设计文档约定的降级路径，使 6.5.1–6.5.5 通过。
  - 实现：SDK 在 deferred approval 后停止同批未领取 sibling、记录 `DEFERRED_APPROVAL_PARKED` 并以 `invocation-parked` 终态结束 turn，不继续模型循环；History 要求 parked terminal 绑定已提交 todo 且无 pending approval/tool。整轮 park 是无法证明 checkpoint 独立步骤安全时的保守降级。
- [x] **6.5.7** RED：新增追认入口测试，合法消息只持久化 resume_request；无 session lease 时 todo 保持 pending、不派发。
  - RED/GREEN：`deferredResumeCoordinator.test.ts` 验证 busy session 下请求落库、todo pending、dispatch 零调用；request store 测试覆盖 reopen 与 reasonKey 幂等。
- [x] **6.5.8** RED：新增普通 Loop/多个 resume request 并发测试，所有路径共用同一单飞租约，恢复请求不丢失。
  - RED/GREEN：普通 Loop 持有 shared session lease 时多个 resume request 均保持 pending；释放后调度器按序处理并发额度，未丢请求。
- [x] **6.5.9** GREEN：实现追认恢复调度，先取得 originSessionId session lease 与全局额度，再做最新撤销/授权复检、原子消费和原 envelope 派发，使 6.5.7–6.5.8 通过。
  - 实现：schema/migration v75 新增持久 request journal；协调器要求 checkpoint-committed intent，取得共享 lease 后复核授权及 todo/envelope 绑定，在事务内 claim/consume，再把持久化原 envelope 派发；dispatch 不确定时持久标记 outcome_unknown。
  - GREEN：7 files / 21 tests passed；`npx tsc -p tsconfig.electron.json --noEmit` 通过。
- [x] **6.5.10** 新增 workflow 恢复测试，安全完成事件到达后 Skill 读取持久化结果/checkpoint，继续未完成步骤且每个新工具调用重新过安全审核。
  - RED：`imWorkflowSkillHarness.test.ts` 初始测试因 current workflow state 无 `completedDeferredResults` 失败，证明 Skill 未读取 completion store。
  - 实现/GREEN：harness 在新 Skill 决策前从持久化 completion outbox/result store 对账 deferred step，将成功结果和 resultRef 写入 workflow state checkpoint 并标记步骤 completed；新工具调用通过本轮注入的 safetyGate，拒绝时不允许后续执行。3 files / 13 tests passed；Electron TypeScript 检查通过。
- [x] **6.5.11** RED：新增待办关联测试：channel、identityKey、owner、todoId、notificationVersion、可信 messageId 和最多两位十进制编号必须匹配；无编号 Y/N/同意、计划确认 Y、过期/旧版本/重复/并行待办答复均不得错批。
  - RED：新增 `deferredApprovalIngress.test.ts`，覆盖 scope/message/version/TTL/编号语法、重复与并行绑定；运行因目标入口尚不存在而失败（`Cannot find module './deferredApprovalIngress'`），符合 RED，下一项实现该入口。
- [x] **6.5.12** GREEN：实现专用安全 ingress 对 `批准 <编号>` / `拒绝 <编号>` 的严格解析和幂等消费；编号永久不复用并按通知版本轮换；编号耗尽时 fail closed，不把普通文本交给 Skill 猜测授权。
  - 实现：新增 deferred approval 专用 ingress parser/handler；校验 channel、identity、owner、唯一 todo、通知版本、可信回复引用、TTL 和 pending 状态；审批确认经 coordinator 幂等落库，重复入站持久拒绝。SQLite v76 新增 receipt journal 与单调 code counter，编号只增不回收，99 后 fail closed。
  - GREEN：`deferredApprovalIngress.test.ts` + migration 测试共 16 项通过；Electron TypeScript 检查通过。
- [x] **6.5.13** RED：新增策略复检测试：当前 deny/locked/critical 阻止；仍 require-confirm 时 ruleId/factsHash 必须匹配；auto-allow 不得跳过完整调用、epoch、环境与外流约束。
  - RED/GREEN：`safetyRecheck.test.ts` 的 6 个 auto-allow 旁路案例先按预期失败；实现后 deny/locked/critical fail closed，require-confirm 绑定保持，auto-allow 要求完整 facts/call/auth-version/environment/egress 摘要一致。Agent SDK adapter 传递新鲜 host gate 绑定。4 files / 109 tests passed。
- [x] **6.5.14** RED：对关闭协调器 port 新增单元/组件合同测试：必须按“阻断新派发→持久关闭事实/新 epoch/tombstone→失效 pending→取消 resume_request→撤销 consumed 未派发 permit→完成对账→回退 user”顺序执行；注入任一步失败均不得提前回退。
  - RED：新增 `deferredApprovalCloseCoordinator.test.ts`，验证 7 阶段严格顺序及每阶段故障都禁止后续阶段/用户回退；当前因 coordinator 不存在而失败，符合 RED。
- [x] **6.5.15** GREEN：实现关闭协调器、持久状态转换、恢复对账及 permit 撤销；该任务建立协议实现，但真实待办/派发器的存量状态集成验收仍在后续任务。
  - 实现：新增 v77 closure journal（epoch、tombstone、closing/reconciliation_required/closed），关闭协调器执行端口协议并持久保存失败阶段；`reconcilePending()` 可重启补做，回退 user 仅在对账后。
  - GREEN：关闭 coordinator 合同与迁移 9 tests passed；Electron TypeScript 检查通过。
- [x] **6.5.16** 回归验收：用真实 store、真实 resume dispatcher 和临时数据库（仅最终 executor 为 fake）验证关闭协议覆盖 pending、resume_request、consumed 未派发动作；关闭失败或重启中断时 fail closed，旧状态不可执行，成功对账后才回退 user。
  - 验收：`deferredApprovalClose.integration.test.ts` 使用临时 SQLite、真实 todo/request/envelope/intent store 和 coordinator，覆盖 pending+resume_request 清理、已消费 permit recovery 撤销、派发零调用、重启后 closure fence 保持并完成 reconciliation 后回退；fake 仅在最终 dispatch executor。3 files / 12 tests passed，Electron 类型检查通过。
- [x] **6.5.17** 回归验收：用真实 `task.cancel` 与真实派发器验证取消先提交则 todo 持久失效且 executor 调用为零；真实派发先开始则准确报告动作已开始。
  - 验收：新增 `imTaskCancelDeferredDispatch.integration.test.ts`，以真实 SQLite todo/intent/envelope/request store、resume coordinator、task-control coordinator 与安全 adapter 覆盖两种竞态；取消先提交后 todo/request 失效且 executor 0 次；派发先进入 executor 后 cancel 返回 `action_started`，executor 恰 1 次。相关 2 files / 11 tests passed，Electron 类型检查通过。
- [x] **6.5.18** 回归验收：用真实 `task.revisePlan` 与真实派发器验证只保留可证明未变化的映射步骤；移除/替换步骤失效，无法证明映射时旧 revision 下全部未派发动作失效。
  - 验收：新增 `imTaskReviseDeferredDispatch.integration.test.ts`，真实 task-control/todo/request/envelope/intent store 与 resume dispatcher 验证显式映射且 instruction 不变时保留并派发原 invocation；未映射和 instruction 替换均持久失效、executor 0 调用。相关 3 files / 5 tests passed，Electron 类型检查通过。
- [x] **6.5.19** 回归验收：在最终复检、原子消费、真实派发 permit 边界交错 cancel/revise，并在 requested 落盘后、store 失效前崩溃重启；撤销先提交则不派发，派发先开始则不回执“全部停止”，恢复期间 fail closed 且幂等补做失效。
  - 验收：cancel/revise 在最终 recheck barrier 期间均返回 `action_started`，复检放行后仅执行一次；取消请求落盘而 todo/request 尚未失效时重启，pending task operation 阻止旧 dispatch，resume request 先失效，恢复对账后 todo 失效，executor 两进程均 0 调用。`imTaskCancelDeferredDispatch.integration.test.ts` 与 revise integration 共 2 files / 7 tests passed，Electron 类型检查通过。
  - 6.5.13 GREEN：`isSafetyRecheckAllowed` 对 deny/locked/critical fail closed；require-confirm 仅允许已确认且 ruleId/factsHash 相同；auto-allow 需完整事实、调用、授权版本、环境及外流摘要均匹配。Agent SDK adapter 传递同一新鲜 host gate 的绑定摘要；4 files / 109 tests passed。

### 6.6 上游确认语法与渠道通知

- [x] **6.6.1** RED：新增飞书与微信短编号 parser 测试，`批准 <1至2位编号>` / `拒绝 <1至2位编号>` 与普通消息、计划确认回复互不误识别；耗尽后不复用历史编号。
  - 测试：飞书/微信都只接受专用短编号协议；Y/N、同意、计划确认和普通文本不走追认 parser；编号只增不回收、99 后耗尽 fail closed。23 ingress/resume 测试通过。
- [x] **6.6.2** 实现安全追认专用 ingress；追认回复不能作为普通 Inbox 指令供 Skill 猜测授权。
  - 实现：Feishu/WeChat router 在通过身份 guard 后、processed claim/Inbox/Skill 前，将“批准/拒绝”前缀保留给安全 ingress；无 handler 或 handler 错误同样短路，不回落普通消息。Router 与 parser 集成 52 tests passed，Electron 类型检查通过。
- [x] **6.6.3** 新增测试，身份不匹配、过期、已消费、已撤销或 plan revision 失配时不派发并返回正确安全结果。
  - 测试：覆盖 channel/identity/owner、过期/旧通知版本/重复/并行 todo、todo 非 pending 以及 coordinator 当前状态复检拒绝；拒绝时不创建 resume dispatch。相关 ingress/resume suites 通过。
- [x] **6.6.4** RED：从真实通知构建器到 fake 飞书/微信 adapter 验证通知自包含且正文不含绝对路径、完整命令、凭据/token；不可信材料与用户委托分区呈现，重试补发仍使用安全内容。
  - RED：新增 `deferredApprovalNotification.test.ts`，初始运行因通知 builder 不存在而失败。
- [x] **6.6.5** GREEN：实现待办通知摘要最小化与可信/不可信证据分区；通知只使用安全 DTO 和允许字段，出站重试复用已审查内容，不从 envelope、工具日志或原始材料临时拼接。
  - 实现/GREEN：builder 使用固定安全 DTO、信任分区和统一脱敏；原始不可信材料不进入正文，安全摘要限制长度并剔除路径、命令、凭据。fake adapter 同一 DTO 重试验证通过，3 tests passed，Electron 类型检查通过。
- [x] **6.6.6** 新增 fake adapter 测试，checkpoint_committed 后的待办通知/补发保留安全审计关联；出站失败不回滚任务且可重试。
  - RED/GREEN：`deferredApprovalNotificationSender.test.ts` 验证 checkpoint 前不通知、出站失败 todo 保持 pending、重试仍用同一安全 DTO，审计仅含 todoId/invocationId/version/state。2 notification files / 4 tests passed，Electron 类型检查通过。
- [x] **6.6.7** RED：新增通知投递对账测试，创建待办后先生成审查 DTO；投递成功登记 notificationVersion/messageId，失败保留 pending+undelivered，仅由同一身份的下一条已鉴权入站触发重试，并在 epoch/TTL 复检通过后补发、登记新版本；未登记通知不得追认，重试不延长 TTL。
  - RED：新增 `deferredApprovalNotificationDelivery.test.ts`，覆盖 durable review/send receipt、失败重试 scope/epoch/TTL、通知版本和短编号轮换及 messageId 登记；初始运行因 delivery coordinator 不存在而失败。
- [x] **6.6.8** GREEN：实现投递对账、版本化补发与稳定通知 DTO；每条待办单独发送，补发轮换短编号，不能改变 todo 关联、真实调用和授权范围。
  - 实现：SQLite v78 notification ledger 在出站前保存审查 DTO；每待办单独记录 undelivered/delivered/superseded/invalidated。只有同身份/owner/epoch 的 retry port 复检 pending todo、checkpoint intent 与原 TTL 后补发，版本递增、短码永久单调分配、成功 messageId 登记为可信 reply target。出站失败不更改真实调用或授权。
  - GREEN：通知构建器、sender、delivery ledger、Ingress 与迁移回归 14 files / 99 tests passed；Electron 与 shared typecheck 通过。
- [x] **6.6.9** RED：新增审计脱敏与 actor 归因测试，审计无用户正文、完整命令、绝对路径；挂起 actor 为 agent，追认 actor 为 user，批准/派发/结果可用 todoId+invocationId 串联且 consumed 不等于执行成功。
  - RED/GREEN 起始：新增 `deferredApprovalAudit.test.ts`，原先因事件 builder 不存在而失败；实现 builder 后 11 audit/securityAuditLog tests passed，验证敏感正文被排除、actor 归属及 consumed 不表示完成。
- [x] **6.6.10** GREEN：接通安全审计事件族、脱敏、因果字段及跨回合归因。
  - 实现：shared SecurityAuditEvent 增加 deferred approval 事件族、todoId/invocationId、notification/execution state；builder 仅输出批准/派发/结果事实并排除正文与结果内容。追认入口归因 user，待办/通知/派发/结果归因 agent；notification delivery、resume dispatch 与 execution result store 发出审计关联。`SecurityAuditLog` sink 复用既有写前脱敏。
  - GREEN：审计、结果、入口、通知和 dispatcher 定向测试共 5 files / 35 tests passed；Electron 与 shared typecheck 通过。

### 6.7 异步审批启用门禁

- [ ] **6.7.1** RED：新增启用门禁测试，安全需求复审未通过或 P1-1…P1-7 任一控制无证据时均不能开启；门禁证据必须包含 6.5.16–6.5.19 的真实集成回归，不接受 fake port 通过替代。已确认的 OQ-1–OQ-8 不得重新列为待用户决策；验收还须确认当前版本拒绝群聊。
  - 历史记录已过期：该验收曾由 `remoteAsyncApprovalGate.test.ts` 承载，但文件和 release gate 已在 2026-10-15 的 `725e4155 refactor(im-approval): remove obsolete release gate` 中删除。当前代码不再用独立发布 gate 汇总安全评审/P1 证据；本任务状态需按新架构重新核定，旧 RED 记录不作为当前证据。
- [ ] **6.7.2** GREEN：仅在安全需求复审通过、适用决策定稿、6.1–6.6 核心验收全部通过后开放 IM 异步审批；开关默认 false，切换前执行持久撤销/对账，保留可恢复回退且验证旧 pending/resume/consumed 未派发动作均不能执行。
  - 架构变更：同一提交删除 `remoteAsyncApprovalGate.ts`、schema v79 gate 状态与对应 release-gate tests；异步审批按当前 IM 策略及现有微信/飞书远程功能设置工作。当前关闭入口与旧审批恢复的证据改由 `deferredApprovalIngress.test.ts`、`feishu/remoteCommandRouter.test.ts`、`wechat/weChatCommandRouter.test.ts` 及 `deferredTodoCapacity.test.ts` 覆盖。此前“SQLite gate 默认 disabled / closing 可恢复”的描述不再适用于当前代码。
- [x] **6.7.3** RED：新增验收矩阵完整性检查，安全需求 OQ-1–OQ-8、§15.8 P1-1…P1-7、G1–G4/F/G、develop v0.2 §12 与历轮开发计划评审均逐项映射到本机测试名，缺项阻止门禁通过。
  - RED：`remoteAsyncApprovalAcceptanceMatrix.test.ts` 初始因检查器模块不存在而失败。
  - GREEN：新增检查器，从本计划 0.2.6 矩阵逐行解析测试文件和精确 `it/test` 名；文件不存在、名称不存在、无本地测试引用或必需 OQ/P1/G/F/§12/评审族缺映射都会返回 incomplete。首次检查发现的占位/不存在目标已映射到 worktree 中真实测试及准确测试名；“缺文件”负向用例确认门禁阻止。
  - 验证：`npx vitest run --project electron electron/confirmation/remoteAsyncApprovalAcceptanceMatrix.test.ts`：1 file / 2 tests passed。

## 7. 进度、恢复与完整端到端本地验证

### 7.1 用户可见状态

- [x] **7.1.1** RED：新增 IM 出站测试，入站受理、计划确认、部分完成等待追认、恢复执行、完成、失败各只发送设计规定的阶段消息。
  - RED：`imRemoteOutbound.test.ts` 新增六种生命周期阶段消息测试，初始因 `sendImLifecycleMessage` 未定义而失败。
  - GREEN：在 `imRemoteOutbound.ts` 新增仅接受固定六类阶段并要求非空文本的发送入口；回归确认逐阶段只发送给定用户可见文本。`npx vitest run --project electron electron/remote/imRemoteOutbound.test.ts`：1 file / 6 tests passed。
- [x] **7.1.2** 新增断言，不向 IM 发送 Thinking、token delta、内部工具日志或调用 envelope。
  - RED/GREEN：出站生命周期入口的类型只允许固定阶段；新增 Thinking、token-delta、tool-log、call-envelope 四个拒绝案例，均确认 reply 零调用。`npx vitest run --project electron electron/remote/imRemoteOutbound.test.ts`：1 file / 10 tests passed。
- [x] **7.1.3** 实现幂等出站 outbox/重试记录，并增加重复发送与发送失败单测。
  - RED：`imRemoteOutbound.test.ts` 增加 outbox 重试/幂等测试，初始因 `imLifecycleOutbox` 模块缺失而失败。
  - GREEN：新增 `im_lifecycle_outbox` 与 79→80 migration，以及持久 delivery coordinator；先落 pending 再发消息，失败可重试，同 eventId 不重发已 delivered 内容并检测事件内容冲突。
  - 验证：聚焦迁移/门禁/outbox 命令共 14 files / 120 tests passed；`npx tsc -p tsconfig.electron.json --noEmit` passed。

### 7.2 双渠道与全局回归

- [x] **7.2.1** 新增双渠道 contract suite，对同一 Inbox/event/workflow/safety fake contract 分别运行飞书与微信 adapter。
  - 实现/验收：新增 `imChannelContract.test.ts`，共享同一 contract 断言，逐个适配 Feishu/WeChat，并确认收到相同消息契约（入站持久一次、wake 一次、workflow 不抢占安全追认）。真实 adapter 的行为分别由 `remoteCommandRouter.test.ts` 的 Feishu 持久受理与 safety ingress 测试、`weChatCommandRouter.test.ts` 的重复入站持久化/wake 与 safety ingress 测试覆盖。
  - 验证：`npx vitest run --project electron electron/remote/imChannelContract.test.ts electron/feishu/remoteCommandRouter.test.ts electron/wechat/weChatCommandRouter.test.ts`：3 files / 34 tests passed。
- [x] **7.2.2** 新增桌面 queue 回归套件，验证 desktop queue 行为、UI 查询、turn claim/reorder 不受 IM scope 改动影响。
  - 实现/验收：新增 `desktopQueueCompatibility.test.ts`，通过 legacy desktop facade 与真实 SQLite 验证 FIFO、原子 claim、reorder、UI transcript 查询及 IM 输入隔离。
  - 验证：`npx vitest run --project electron electron/database/desktopQueueCompatibility.test.ts electron/database/operations.queueScope.test.ts`：2 files / 9 tests passed。
- [x] **7.2.3** 新增全链路恢复场景：计划等待、并发新消息、deferred、用户暂不在场、后续追认、精确派发、取消/修订竞态、容量拒绝、安全通知及最终通知。
  - 实现/验收：新增 `imEndToEndRecovery.test.ts`，用真实 SQLite workflow、deferred todo、intent/checkpoint、call envelope、approval ingress、resume journal 与 dispatcher 验证计划等待、用户暂不在场时不派发、追认后原调用精确派发与消费。通知失败重试、并发入站唤醒、容量拒绝、关闭恢复、取消/修订竞态由同次集成验证命令中的现有真实组件测试覆盖。
  - RED：首次因导入的 harness 导出名错误 (`createImWorkflowSkillFlow`) 失败，修正为实际导出 `runImWorkflowSkillFlow` 后重跑通过。
  - 验证：`npx vitest run --project electron electron/remote/imEndToEndRecovery.test.ts electron/remote/deferredApprovalNotificationDelivery.test.ts electron/confirmation/deferredTodoCapacity.test.ts electron/remote/imTaskCancelDeferredDispatch.integration.test.ts electron/remote/imTaskReviseDeferredDispatch.integration.test.ts electron/remote/deferredApprovalClose.integration.test.ts electron/remote/imWorkflowSkillHarness.test.ts electron/remote/wakeEventDispatcher.test.ts`：8 files / 33 tests passed；`npx tsc -p tsconfig.electron.json --noEmit` passed。
- [x] **7.2.4** 新增评审验收矩阵，将 develop v0.2 §12、上游安全需求 §15.8 P1-1…P1-7、G1–G4/F/G、历轮设计评审及开发计划评审的本机验收场景映射到自动化测试文件与测试名，并确保每项至少一个本地测试。
  - 验收：复用增强后的 0.2.6 精确追踪表与 `remoteAsyncApprovalAcceptanceMatrix.test.ts` 检查器，并将新全链路恢复用例加入历史设计/开发评审映射。`npx vitest run --project electron electron/confirmation/remoteAsyncApprovalAcceptanceMatrix.test.ts`：1 file / 2 tests passed。

### 7.3 本机验证门禁

- [x] **7.3.1** 运行本计划所有新增/修改的聚焦 Vitest 文件，记录通过文件数、测试数和耗时。
  - 验证：本阶段最终聚焦回归命令（gate/matrix/outbound/channel/e2e/queue/migrations/deferred security + cancellation/revision suites）28 files / 201 tests passed，耗时 20.30s。
- [x] **7.3.2** 运行队列、路由、remote agent、安全确认与数据库迁移相关完整回归：`npx vitest run --project electron electron/database electron/remote electron/confirmation electron/feishu/remoteCommandRouter.test.ts electron/wechat/weChatCommandRouter.test.ts`。
  - 验证：173 files / 1705 tests passed，156.20s。
- [x] **7.3.3** 运行 `npm run typecheck:shared`。
  - 验证：`npm run typecheck:shared` passed (`tsc -p tsconfig.renderer.gate.json --noEmit`)。
- [x] **7.3.4** 运行 `npm run typecheck:renderer`。
  - 验证：`npm run typecheck:renderer` passed (`tsc -p tsconfig.renderer.json --noEmit`)。
- [x] **7.3.5** 运行 `npm run build:electron:incremental`。
  - 验证：closure 23 files / 144703 bytes、storage boundary checks、provider TypeScript build、Electron TypeScript build 全部通过。
- [x] **7.3.6** 运行 `npm test` 全量本机测试；若失败，保留失败首因、栈、预期/实际与基线对比，不把基线失败归为本次通过。
  - 执行结果（未通过）：3 files failed / 957 passed / 1 skipped；16 failed / 8857 passed / 111 skipped，总计 8984 tests，358.33s。
  - 首要诊断：`src/shared/policy/policyEngine.test.ts:544` 预期远程 navigate `tiers.length > 0`，实际为 0；`electron/claudeStreamHandlers.hostedIntegration.test.ts:3643` 预期 `BROWSER_PREPARED_POLICY_CHANGED`，实际 `CONFIRMATION_DENIED`，另有 15s 测试超时及清理 `ENOTEMPTY`；`electron/toolChatLoop.lane.test.ts:222` 预期 history messages 首项为 `persist me`，实际在其前面包含 `im-task-orchestration` Skill system 指令。相关实现与测试文件相对基点 `8e3c5d12` 的 `git diff HEAD --` 为空；这些失败涉及本轮任务未改文件，保留为既有基线失败，不算通过。
- [x] **7.3.7** 运行 `git diff --check`，确认本计划涉及变更无空白错误、无意外生成物及无计划外文件。
  - 验证：`git diff --check` exit 0；`git status` 未发现 `dist/`、`dist-electron/`、`release/` 或 `coverage/` 生成物；未发现计划外文件。
- [x] **7.3.8** 完成所有本地验收项到测试证据的追踪；未解决外部服务、跨平台/CI 或人工验收项不作为本机完成依据，也不得标记全计划完成。
  - 历史接线证据已由 2026-10-15 移除 release gate 的提交取代；当前入口关闭行为由 `electron/remote/deferredApprovalIngress.test.ts`、`electron/feishu/remoteCommandRouter.test.ts` 和 `electron/wechat/weChatCommandRouter.test.ts` 覆盖。旧的 `remoteAsyncApprovalGate.test.ts` 命令不能作为当前验证证据。
  - 完整性：本地追踪表由 `electron/confirmation/remoteAsyncApprovalAcceptanceMatrix.test.ts` 检查文件与测试名。全量 `npm test` 的 16 项失败保留为当时未通过结果；无真实 IM/外部审批/发布/跨平台 CI/人工 UX 项属于计划声明的范围外验证。

## 完成定义

- 所有适用的本机任务均为 `- [x]`，没有 `- [ ]` 或 `- [～]`；适用 OQ 决议与生产启用门槛均完成。上游安全需求复审已通过，但该事实本身不替代实现验收。
- 队列 scope、逐事件唤起、session 单飞、持久 authorizationEpoch、完整 envelope、真实任务取消/计划修订与派发线性化、安全待办容量与补偿、明确追认绑定、通知内容安全、审计与完成 outbox 均有本地自动化测试证据；真实审批入口映射、授权撤销级联及启用/回退门禁也有端到端本地证据。
- 聚焦测试、相关 Electron 回归、shared/renderer typecheck、Electron 增量编译及全量 `npm test` 均记录结果。
- 不把真实飞书/微信送达、用户交互质量、外部安全审批或 CI 平台结果冒充本机自动验证结果。

## 8. 2026-10-09 阻断评审整改（严格顺序）

- [x] **8.1.1** RED→GREEN：Feishu/WeChat router 在安全身份校验后读取持久审批 gate；关闭时跳过追认 ingress，并将文本按普通入站持久化和唤起。测试覆盖 gate 开/关分支。
  - RED：Feishu 关闭 gate 场景曾调用 approval handler 一次，未通过预期断言；普通文本入站夹具保持既有行为。
  - GREEN：两路 router 增加 `isRemoteAsyncApprovalEnabled` 门禁；IPC 生产 bundle 使用 SQLite `isRemoteAsyncApprovalGateEnabled(db)`。Feishu/WeChat 开启 gate 时只调用专用 ingress；关闭时 handler 调用为零、Inbox 保存“批准 07”原文并调用 wake dispatcher。
  - 验证：`npx vitest run --project electron electron/feishu/remoteCommandRouter.test.ts electron/wechat/weChatCommandRouter.test.ts -t 'approval replies|approval-shaped message'`：2 files / 4 tests passed；`npx tsc -p tsconfig.electron.json --noEmit`、`git diff --check` 通过。
- [x] **8.1.2.1** RED→GREEN：在 Feishu/WeChat IPC bundle 装配通知 delivery；仅在当前 router 入站身份校验通过后，按当前身份和权威 epoch 重试未送达通知。用真实 delivery store + router 测试。
  - 实现：两路 router 仅在 owner guard 与 revalidation 成功后触发认证通知重试；IPC bundle 使用真实 SQLite todo/intent/notification stores，并从 remote authorization registry 读取当前 epoch。飞书发送适配器要求平台返回 message id；微信发送适配器仅识别 SDK 返回的 message id，缺失时保持 undelivered。
  - 验证：`npx vitest run --project electron electron/feishu/feishuReply.test.ts electron/remote/deferredApprovalNotificationDelivery.test.ts electron/feishu/remoteCommandRouter.test.ts electron/wechat/weChatCommandRouter.test.ts`：4 files / 45 tests passed（含 Feishu、WeChat 真实 delivery store 经各自 router 认证后重试并旋转通知版本）；`npx tsc -p tsconfig.electron.json --noEmit`、`git diff --check` 通过。
- [x] **8.1.2.2.1** RED→GREEN：Feishu/WeChat IPC bundle 装配生产 `WakeEventDispatcher`；从持久事件/inbox 重建并重新校验渠道身份，使用原队列用户消息执行真实 IM turn，恢复成功后确认事件；覆盖 SQLite 重开恢复和 session 单飞。
  - RED：Feishu 与 WeChat 持久 inbox event 首次接入真实 TurnRuntime 时分别失败于 `TURN_REUSE_TARGET_NOT_USER`；补上共享 TurnIntent 的 IM scope 原子 claim 后，测试继续暴露旧代码未创建 wake turn queue receipt、成功 turn 后 ack 不接受 sent 状态、queue list 因同一消息双 receipt 重复返回的问题。
  - GREEN：入站消息、platform reply context、wake event/outbox 与按 event id 的 IM queue receipt 在同一 SQLite 事务提交；scope-aware `reuse-user` 原子领取原消息，不创建第二条 user message。Feishu 从 per-message context 恢复 platform message id；WeChat 为每条 Inbox 消息持久化 context token。turn completed 后 ack；sent 但未 ack 的 crash 窗口可在 claim 过期后恢复，重复 ack 幂等。
  - 生产接线：Feishu/WeChat IPC bundle 构造真实 `WakeEventDispatcher` 并连到 router；consumer 对持久 session 身份和当前 authorization generation 重新校验，turn 执行前再次 fencing。WeChat 多条 backlog 使用各自 context token。
  - SQLite schema 从 80 升至 81，新增 `im_inbox_message_context` 并覆盖旧库 migration。
  - 验证：5 个 Electron focused 文件 66 tests passed；coordinator IM scope test 1 passed；`npx tsc -p tsconfig.electron.json --noEmit` 与 `git diff --check` 通过。覆盖 SQLite reopen、真实 Feishu dispatcher 单飞、真实 WeChat dispatcher 双消息恢复及 ack。
- [x] **8.1.2.2.2** RED→GREEN：在两路 IPC bundle 装配专用审批 ingress 与 resume dispatcher；gate 开启合法追认原子落请求并唤起原 session，gate 关闭拒绝追认；通过真实 bundle 路径验证。
  - 两平台 router 只在 gate 开启时将审批候选交给 ingress；ingress 二次校验 gate。Feishu 保留平台 `parent_id`，WeChat 仅接受 wire `ref_msg.message_id`，不从引用文本推断通知身份。
  - 新增 IM deferred producer 并接入 agent confirmation callback：已认证请求建立 turn 级单步骤 task control；原始 invocation 身份、参数、路由和安全 receipt 绑定到 immutable envelope；todo 容量准入成功后写 envelope、CAS task checkpoint 和 intent，再交付安全通知。通知未送达会使 todo 失效并释放容量。
  - 两路 bundle 都装配共享 SQLite stores、producer、回复 ingress、epoch/owner/task dispatch fence 和直接 RegisteredTool executor；批准回复通过可信通知引用和短码恢复原 session，不启动模型回合。
  - RED→GREEN 暴露并修复了 reservation 缺 channel/owner、容量准入前遗留 prepared intent、WeChat turn context 接线位置错误等问题；加入真实 SQLite producer → 通知 → 批准回复 → task fence → origin-session dispatch 测试。
  - 验证：9 个 Electron focused 文件 / 216 tests passed；`npx tsc -p tsconfig.electron.json --noEmit` 与 `git diff --check` 通过。
  - 生产调用审计：当前确认 port 没有 deferred todo 创建回调，adapter 在生产代码无调用；缺少可信的 task/workflow step 与 checkpoint 绑定，因此仅接 runtime factory 仍无法形成生产审批请求。仍须先完成 producer/持久 envelope 链路和 IPC bundle 真实 dispatcher 装配。
- [x] **8.2** RED→GREEN：在同一 SQLite 事务中写入批准回复 receipt、resume request 与 todo/通知版本一次性消费意图；故障注入证明不存在无 receipt 的可派发请求。
  - RED：`deferredApprovalIngress.test.ts` 注入 receipt insert 失败，原实现先创建 resume request，断言暴露可派发请求没有 receipt。
  - GREEN：receipt callback 由 resume coordinator 在 SQLite 外层事务中同步调用，随后创建 pending resume request；任一插入错误回滚两者。resume request store 对 `(todo_id, notification_version)` 增加 active 唯一索引和消费检查，不同回复不可二次消费同一通知。
  - 迁移：schema v82 创建部分唯一索引；测试覆盖同 reason 幂等、异消息同版本拒绝、receipt/request 双向故障注入及升级 migration。
  - 验证：7 个 Electron focused 文件 / 38 tests passed；`npx tsc -p tsconfig.electron.json --noEmit` 与 `git diff --check` 通过。
- [x] **8.3** RED→GREEN：撤销启动恢复须在完成 journal 前幂等等级联持久 todos、resume requests、未派发 permits 与缓存；真实派发前验证权威 epoch。使用真实 SQLite 覆盖 epoch 推进后级联前崩溃并重开恢复。
  - 生产缺口与修复：Feishu/WeChat deferred todo invalidator 原先未实现 `invalidateResumeRequests`。新增 request store 的 epoch 级联接口并在两 bundle 接线；pending requests 在 epoch 提升后失效，dispatching request 保持 recovery journal pending/fence，拒绝伪完成。缓存、todo 与 permit 继续走注册 invalidator。
  - 启动顺序审计：main 在 bind 持久 epoch store 后，注册两路 bundle invalidator，调用 `recoverPendingRevocations()` 成功后才做 task-control recovery 和 auto-start；派发 fence 每次以持久 epoch 与 gate/owner/task 状态复检。
  - 验证：真实 epoch/request store + registry targeted suites 4 files / 45 tests passed；既有 SQLite reopen session-scoped cascade 测试确认只失效 journal 指定范围。Electron tsc、`git diff --check` 通过。
- [x] **8.4** RED→GREEN：关闭协调器必须通过共享 epoch store 单调推进授权 epoch，每次关闭有新 fencing 事实；接入主进程真实 dispatcher/permit 边界，覆盖重启、重复关闭与并发派发。
  - 实现：close coordinator 支持共享 `RemoteAuthorizationRegistry.advanceAuthorizationEpoch`，关闭前先推进持久 epoch、创建唯一 tombstone 并保存 durable closure；同一未完成 journal 的恢复重用 closure，新的 close 推进新 epoch 并创建新 tombstone。`createDeferredImBundleRuntime` 装配并暴露 close coordinator；真实 dispatch fence 在调用 executor 前读取 closure 和权威 epoch/gate/owner/task。
  - 并发：真实 resume coordinator 已 claim/consume todo 且 executor 挂起时发起 close，close 保持 `reconciliation_required`，不执行 revoke/fallback；dispatch 完成后 closure 仍不误报 closed。未进入 dispatch 的旧 todo 在 epoch 增长后无法通过 fence。
  - 验证：close coordinator/integration/bundle/dispatch/request focused 5 files / 41 tests passed；另含 registry cascade reopen 23 tests；Electron tsc 与 `git diff --check` 通过。

### 8.5 第二轮阻断评审整改（按报告顺序）

- [x] **8.5.1 P1 入站真实唤起** RED→GREEN：普通入站先持久化、释放自身 session lease 后启动 dispatcher；`session_busy` / `parallel_full` 使用按 session 合并的受控延迟重试。新增真实 registry + SQLite dispatcher 用例，证明占槽期间 wake 保持 pending，释放后自动启动并 ack；Feishu/WeChat router 先释放 inbound lease 再 dispatch。
- [x] **8.5.2 P1 原子审批收据生产透传** RED→GREEN：生产 `createDeferredApprovalRuntime` 将 `commitReceipt` 第二参数传给 resume coordinator。真实 runtime 测试查询 SQLite receipt 与 request；coordinator 故障注入确认两者同事务回滚。
- [x] **8.5.3 P1 WeChat wake adapter** RED→GREEN：恢复路径 remote context 增加可信 `turnId`，并调用生产 `createDeferredConfirmationAdapter`。WeChat 持久 Inbox replay 测试验证 adapter 工厂对每条恢复消息调用，context turnId 与上下文 token 保持原值。
- [x] **8.5.4 P1 生产 task cancel/revise registry** RED→GREEN：生产 IM orchestration registry 注册 `task_cancel` 与 `task_revise_plan`；两渠道 IPC 注入真实 deferred todo invalidator 与 pending resume dispatcher，沿可信 invocation runtime context 执行。生产 invocation 工具列表测试和安全上下文工具测试通过。
- [x] **8.5.5 P1 deferred 结果、completion outbox 与后续唤起** RED→GREEN：bundle dispatch 在派发前落 `dispatching` 日志，完成后保存真实结果/受控引用、completion outbox 与稳定 `safety-recovery` wake；异常标记 `outcome_unknown`，不自动重放。两路 router 验证安全完成事件重新执行原 session turn，完成后确认结果 outbox；失败对象保持 `failed` 并由 workflow reconcile 标为失败。completion 事件处理校验 todo channel/session/identity/owner 和原始消息引用。
- [x] **8.5.6 P1 pending resume 自动重试/启动恢复** RED→GREEN：resume coordinator 可枚举 pending session；runtime 对 session/global slot busy 安排去重延迟重试并暴露启动 `recoverPending()`。生产 runtime 测试占住 slot 后创建新 runtime 扫描持久 request，释放 slot 后无需新输入即完成派发。
- [x] **8.5.7 P1 通知失败保留 todo** RED→GREEN：producer 仅在 `not_ready` 时 rollback；渠道暂时 undelivered 时保留 pending todo、checkpoint 和容量预留并返回 deferred waiting。producer + 真实 SQLite delivery 测试在发送失败后通过下一次同身份认证重试获得 trusted message id。
- 验证：最终定向回归 `npx vitest run` 13 files / 224 tests passed；`npx tsc -p tsconfig.electron.json --noEmit` 与 `git diff --check` 通过。另行回归修改后的 startup resume recovery 用例：1 file / 1 test passed。
- 范围说明：本轮未重跑全量 `npm test`；7.3.6 中记录的全量失败仍是最近一次全量结果，不以本次定向通过替代。真实飞书/微信服务送达、CI/跨平台与人工交互仍需外部验收。

### 8.6 第三轮阻断评审整改（按报告顺序）

- [x] **8.6.1 P1 Hosted parked 等待终态**：Hosted handoff 接受 `invocation-parked` 并校验 todoId，返回带 parked 标记的等待结果，finalization 标为 interrupted 而非 completed/failed；IM agent 保留 pendingConfirm 语义。测试以已提交 parked History 断言 handoff 正常返回等待结果。
- [x] **8.6.2 P1 启动恢复渠道隔离**：pending request 查询、session 扫描及 coordinator 派发边界均按 owning channel 限定；异渠道请求不会进入 recheck/失效路径。main 在 session storage recovery 与 revocation/task-control 恢复完成后等待两渠道 runtime 扫描，再启动入口。测试覆盖共享 session 下飞书/微信 pending requests 独立可见。
- [x] **8.6.3 P1 completion continuation 结果与原任务绑定**：completion wake 将真实结果、dispatchKey、outputRef、todo/invocation/workflow/task/step/revision/checkpoint 及原工具调用信息交给专用 deferredContinuation；模型请求加入原工具调用和真实 tool result 规范消息对，并附“动作已执行”约束，避免把原用户文本单独重放。飞书/微信 router 测试检查 continuation 绑定，Agent 装配测试断言真实结果进入模型 messages。
- [x] **8.6.4 P1 崩溃后 completion 自动恢复**：runtime 按渠道枚举有结果/outbox 且 wake 可领取的 session；dispatching 执行日志启动时通过受控 query 对账，无法确认则落 outcome_unknown，不重放副作用；已提交结果只重新派发持久 wake。启动 recovery 等待 dispatcher 消费，wake claim 租约过期后可在重启扫描中重领。bundle 测试模拟新 runtime 启动后重新触发 completion wake。
  - 补充 RED：`electron/remote/startupWakeRecovery.test.ts` 原测试只验证调用已安排，没有等待 dispatch 完成。新增等待契约后，旧同步实现以 `scheduleStartupWakeRecovery(...).then is not a function` 与非 Promise 结果失败。
  - 补充 GREEN：恢复函数改为等待所有渠道 session dispatcher settled；逐 session 捕获并报告失败，不阻塞同批其他 session；Feishu/WeChat auto-start `await` 恢复结果后再完成启动路径。
  - 验证：`npx vitest run --project electron electron/remote/startupWakeRecovery.test.ts electron/remote/deferredImBundleRuntime.test.ts electron/feishu/remoteCommandRouter.test.ts electron/wechat/weChatCommandRouter.test.ts`：4 files / 74 tests passed；`npx tsc -p tsconfig.electron.json --noEmit` 与 `git diff --check` 通过。原 8.6.4 八文件 / 244 tests 的既有结果保留。
  - 复核：`npx vitest run --project electron electron/remote/deferredCompletionWakeRecovery.test.ts electron/remote/startupWakeRecovery.test.ts electron/remote/deferredImBundleRuntime.test.ts electron/remote/remoteTrackWorkRecovery.test.ts electron/database/remoteTrackStore.test.ts electron/database/clarificationStore.test.ts electron/wechat/weChatCommandRouter.test.ts electron/feishu/remoteCommandRouter.test.ts`：8 files / 118 tests passed；`git diff --check` 通过。
- 范围说明：未重跑全量 `npm test`；最近全量结果仍见 7.3.6。真实飞书/微信平台送达、真实进程强杀窗口和 CI/跨平台验证仍需外部验收。

## 9. 2026-10-11 Intent Track 方案差距收敛

- [x] **9.1 阶段 7 可观测性完整闭环**：按 `docs/develop/2026-10-11-remote-im-intent-track-development-plan.md` §13，提供归属误报、join 完整度、clarification 投递/延迟/stale 回复、work recovery、context 完整度、终态迁移拒绝等指标的只读聚合、missing reason 和可操作告警；复用现有 Track/clarification/outbox/turn 数据，不以 session/time 猜 join，不记录原始正文。
  - [x] **9.1.1** 为无现成持久来源的 clarification 控制结果新增脱敏诊断事实记录，并接入两渠道 parser/resolver；保留 messageId 幂等，不记录原始正文。
    - RED：新增 store contract test 首次失败于 `Cannot find module './remoteTrackDiagnosticStore'`。
    - GREEN：schema v92 新增仅含 channel/platform message id/闭合 event+reason code/time 的诊断表与唯一键；WeChat/Feishu consumed clarification control branch 写入 reason enum，测试确认正文/身份列不存在且消息不进入 Agent。
    - 验证：`npx vitest run --project electron electron/database/remoteTrackDiagnosticStore.test.ts electron/database/migrations.remoteTrack.test.ts electron/remote/clarificationInbound.test.ts electron/wechat/weChatCommandRouter.test.ts electron/feishu/remoteCommandRouter.test.ts`：5 files / 82 tests passed；`npx tsc -p tsconfig.electron.json --noEmit` passed。
  - [x] **9.1.2** 实现 §13 指标与 missing reason/alert 聚合、CLI report 命令和运行手册；用临时 SQLite 覆盖所有指标来源及窗口边界。
    - RED/GREEN：新增 `remoteTrackOperationalMetrics.test.ts` 覆盖半开窗口、聚合与 missing reason；在指标实现阶段依次暴露 wrong-attribution pause 信号、长期 pending clarification/resolved-without-work/processing Track 告警缺失，并逐项补齐。10 类指标均返回显式可用性和缺数原因；Track context 因 provider view snapshot 尚未持久化，明确报告 unavailable 与 event-reference proxy，不伪称真实 provider 输入完整度。
    - 运行时诊断：schema v93 新增闭合码诊断表；正式 execution 下缺失 TrackContext、owner/epoch scope mismatch、turn/todo Track link 写失败持久为 critical 告警来源。Clarification 非法控制语法会被消费而不进入 Agent，并在指标报告中告警。
    - 额外缺陷修复（TDD）：pending clarification 存在时，旧版裸数字选项 `1` 曾被 parser 判成 ordinary，可能进入 Agent。先加失败断言得到 `ordinary`/expected `control-like-invalid`，再增加 owner/epoch/TTL scoped pending 查询和旧格式保留；微信集成确认不启动 Agent、不消费 parked input；无 pending clarification 时数字仍是普通消息。
    - GREEN：定向复跑 10 files / 270 tests passed；`npm run build:electron:incremental` 通过（含 Electron TypeScript、PI AI runtime closure 与 session-storage 边界）；`git diff --check` 通过。CLI 用临时 SQLite 执行 `npm run remote-track:metrics -- <db> metrics 1 2`，10 个指标输出 missing reason 且无告警/异常。
    - 限制：context completeness 仍为不可用代理指标；其余产品启用门槛（14 天/500 条双渠道 shadow、错误率、成本、p95 与飞书线上结构化证据）不是本地代码测试，不应据此打开语义续接。
    - 全量回归复验：修复上述 schema、policy expectation 与 IPC push boundary 后运行 `npm test`：1003 files passed、1 skipped；本轮归属/confirmation 修复后再次全量运行通过，1003 files passed、1 skipped；9336 tests passed、111 skipped，总耗时 484.72s。运行中出现 Node `MaxListenersExceededWarning`（session:expired/error listeners）；Vitest 最终退出成功，当前没有失败用例。
    - 额外 TDD 修复：新增 `agent-undetermined` 宿主回退用例先红，确认 `agentSdkConfirmationPort` 未按 `FALLBACK_ELIGIBLE_CAUSES` 调用 fallback；改为复用 `isFallbackEligibleCause` 后转绿。Agent 明确拒绝仍不回退，桌面链路还受 lane/取消/恢复失败守卫限制，IM 的宿主 fallback 返回 undefined 后继续既有 defer/fail-closed 流程。确认端口、AgentChannel、回退策略与 R5 共 4 files / 74 tests 通过；Electron incremental build 通过。
    - 额外 TDD 修复：完成审计发现 `remoteTrackConfirmationLink` 已有配置键和前置校验，但生产 `buildImPending` 无视该开关，只要带 `TrackContext` 就始终写入 confirmation 关联，违反阶段 7“独立关闭接线”的要求。先新增 Hosted `assembleInvocation → ConfirmationPort → ImChannel` RED：gate 关闭仍观察到 `trackId`。GREEN：组装器仅在持久 feature gate 明确开启时向同步 confirmation 下发 `trackId + attributionEventId`；关闭时继续使用现有安全确认但不创建 Track child。补开/关双向契约，验证 Track child `pending → settled` 回调；7 个关联测试文件 / 296 tests、Electron incremental build、`git diff --check` 通过。

## 9.2 2026-10-11 归属策略缺少“新意图”闭环

- [x] **9.2.1** RED：覆盖“已有候选但全部低于 continuation 阈值”的普通消息，要求创建新 Track；旧实现会返回 ambiguous，使没有任何合理匹配的消息也只能被澄清为某个旧 Track，用户无法开始第二个独立意图。
- [x] **9.2.2** GREEN：按方案 §4.2 “没有合理候选则走新 Track”落实判定：最高分低于 0.85 表示没有合理 continuation 候选，创建 new Track；至少一个候选达到阈值但与次高分差小于 0.15 时才进入 ambiguous/Clarification；分类器不可用、超时或输出无效仍保守澄清/拒绝，不猜新意图。规则不改变高分唯一续接门槛。
- 验证：先观察 `ambiguous/confidence-below-threshold` 与预期 `new-track/no-reasonable-continuation-candidate` 不符；修复后归属算法、持久化 service、微信和飞书 router 共 4 files / 89 tests passed；confirmation-link 开关开/关集成 2 tests passed；`git diff --check` 通过。
- [x] **9.2.3** RED→GREEN：新增真实持久化 service 回归，Track execution 开启、semantic continuation 关闭时，影子模式仍实际调用分类器并记录决定、分数和 token/成本；高分续接只进入 shadow observation，正式路由仍 ambiguous，不写入当前消息映射；低分新意图则创建独立 Track。首次因 `classifier.classify` 零调用失败；修复后 `trackAttribution` + attribution service 22 tests passed。运维手册说明无候选的旧路由影子样本不能满足性能门槛，需在 semantic continuation 关闭的单通道 Track canary 中采集完整 14 天证据。
- [x] **9.2.4** 全量验收：相关归属/路由/feature gate/指标/装配回归 147/147 通过；Electron/shared/renderer typechecks、i18n 检查、增量 Electron build、`git diff --check` 通过；随后 `npm test` 全量通过（1003 files passed、1 skipped；9336 tests passed、111 skipped）。
- 外部启用门槛复核：用独立临时 SQLite 执行 `scripts/remote-track-shadow-review.ts <db> report`，返回 `ready=false`，阻断项为样本不足、微信/飞书各自样本不足、14 天覆盖不足、p95 不可用及成本不可用；因此语义续接保持关闭，需按 runbook 运行 canary 并收集真实 14 天双渠道证据后才能完成产品启用。
- [x] **9.2.5** RED→GREEN：会话删除此前直接把活动 Track 标成 `failed`，并将所有非终态 child 投影写成 `invalidated`，可能抹掉 `tool-dispatch/outcome-unknown` 的待核对事实。先加删除场景测试并观察到 `failed`/expected `reconciliation-blocked`；随后改为保留 dispatching、outcome-unknown、needs-reconciliation 的派发投影，并在同一删除事务读取 turn、assistant tool-call、todo、clarification、execution-work 权威来源，通过 reducer 聚合决定 Track 状态；queued/claimed work 因会话删除转为 `needs-reconciliation`，Track 保持 `reconciliation-blocked`，不伪报失败或结算。测试使用持久 turn 和 assistant `tool_calls`，不依赖单独 mock child 投影。`operations.test.ts` 删除生命周期组 5/5 通过；operations、remoteTrackStore、trackReducer、deferredTodoStore、imRemoteAgent 共 5 files / 289 tests passed；Electron incremental build、shared/renderer typecheck、`git diff --check` passed。
- [x] **9.2.6** RED→GREEN：审计阶段 3/5 的跨 session 承接验收时发现，视图允许显式 ledgered 的 origin-session 消息，但 `imRemoteAgent` 把 allowlist 中所有 messageId 都用当前 session 查询，合法 continuation 在 provider 调用前失败 `TRACK_MODEL_INPUT_MESSAGE_MISSING`。新增跨 session Agent 端到端用例先复现该错误；随后 `TrackModelInputViewRef` 增加并冻结 `messageSessionMap`，builder 从 ledger 事件对应消息保存来源 session，Agent 按该映射读取，provider filter 校验映射覆盖完整且不超出 includedSessionIds，且重建视图时逐项比对映射。origin 输入、原助手结果与当前 continuation 均进入 provider messages；外部 session 内容仍被排除。`imRemoteAgent`、view filter/store 共 3 files / 177 tests passed；Electron incremental build、shared/renderer typecheck、`git diff --check` passed。
    - Hosted 浏览器集成夹具修正为符合真实安全协议：Agent 先给 `undetermined`，再由 mock 桌面用户确认。配置漂移 4 项、派发前失效 3 项、late-result 的 act 3 项通过。late-result 的 navigate 暴露了确认副作用与二次安全重检的协议缺口：用户批准当前 browser navigate 后，会话信任缓存使同一请求的 gate 从 `browser-navigate-ask-desktop` 收敛为 `cache-hit`，facts、目标和授权版本保持不变，但 Hosted policy 因要求 ruleId 恒定而错误拒绝，随后模型重试。RED→GREEN：新增 SafetyPolicy 回归先以 `FACTS_CHANGED` 失败；实现仅允许“原始 require-confirm 已获批准 + fresh facts/目标/授权版本全部相同 + 新规则恰为 cache-hit”的收敛，其他规则漂移及任何事实变化仍拒绝。`agentSdkSafetyPolicy.test.ts` 26/26、late navigate 3/3、相邻 Hosted browser/cancel/recheck 40/40 通过；Electron incremental build 与 `git diff --check` 通过。此前浏览器筛选组修复后无需再按原失败假设处理；其余 Hosted/browser 全矩阵仍需完整复跑。
- 上述较早记录中的“全量回归尚未重跑/有失败”已由本轮结果更新：当前代码在跨 session provider 输入修复后，全量 `npm test` 通过，见 9.2.7。context completeness 仍明确标记为不可用代理指标；语义续接保持关闭，直到双渠道 shadow 与质量门槛满足。
- [x] **9.2.7** 最终本机回归：跨 session view contract 和 provider 读取修复后再次运行 `npm test`：1003 files passed、1 skipped；9342 tests passed、111 skipped，退出码 0。同步运行 Electron incremental build、shared/renderer typecheck 与 `git diff --check` 均通过；i18n 检查以 `node --import tsx/esm scripts/i18n-check.ts` 执行通过（1252 处中文均在测试目录，源码 0 处）。全量测试出现 Node `MaxListenersExceededWarning`（`session:expired`/`error` listeners），但无失败测试。`npm run i18n:check` 在当前 sandbox 因 tsx IPC socket `listen EPERM` 无法启动，直接 loader 命令成功运行同一检查脚本。
- [x] **9.2.8** 按 runbook 增加 Track rollout channel scope，避免全局布尔门误开启未参与 canary 的 IM 渠道：`remoteTrackRolloutChannels` 允许显式配置 `wechat`/`feishu`，路由及 runtime 按真实渠道读取；非法/重复渠道 fail closed；shadow review CLI 提供 `channels` 子命令；runbook 与 feature gate matrix 同步说明。RED：新增 gate 单测先失败，证明全局 execution 开启且名单为 `['wechat']` 时 Feishu 仍错误得到 `execution=true`；GREEN：渠道过滤后 WeChat 保持开启、Feishu 的 Track 路由开关均关闭，空名单关闭全部路由，非法/重复名单拒绝。另加 Feishu router 集成，证明微信 canary scope 不启动 Feishu Track 或 shadow attribution。
  - 验证：gate/router/runtime/agent 相关 6 suites / 290 tests 通过；包含继续意图与 session storage 的 7 suites / 374 tests 通过。一次并行回归出现 `CONTINUATION_SOURCE_SESSION_ID_REQUIRED`，当时由同名 `inspect` 方法被 Chai 当作打印钩子调用，遮蔽了实际断言差异；实际差异和修复见 §9.2.9。该项此前代码版本的 `npm test` 通过 1003 files、9345 tests；后续回归结果见 §9.2.9。`npm run build:electron:incremental`、`npm run typecheck:shared`、`npm run typecheck:renderer`、`node --import tsx/esm scripts/i18n-check.ts`、`git diff --check` 均通过。临时 SQLite CLI 验证 `channels '["wechat"]'` 写入成功。
  - 发布边界：此项只提供按渠道安全灰度能力；尚无 14 天、500 条且双渠道各 200 条的影子样本与人工复核，因此 `remoteTrackSemanticContinuation` 继续关闭。该运行数据门槛不由本机自动化测试替代。
- [x] **9.2.9** TDD 复核空白 session 和微信澄清回归：新增 outbound 测试先以 `CONTINUATION_SOURCE_SESSION_ID_REQUIRED` 失败，随后要求继续意图路由前 `sessionId.trim()` 非空；空白 session 不再进入来源检查，既有 sessionStorage 严格校验保持不变。继续来源查询端口方法从 `inspect` 改为 `read`，避免 Chai 将领域方法误认作对象自定义 inspect hook 并掩盖断言差异。诊断揭示微信澄清用例实际断言错误：夹具用两次动态 `Date.now()` 创建 Track，却假定选项 1 固定命中 `clarify-track-a`；候选按 `updated_at DESC` 排序，后创建的 B 可合法排在 A 前。为该用例设定显式更新时间（A=2、B=1），固定“选项 1 选择 A”的前置条件，不改变生产候选排序或澄清协议。
  - 验证：首次 RED 收到 `CONTINUATION_SOURCE_SESSION_ID_REQUIRED`，GREEN 后 8 个相关 suites / 380 tests passed；最终 `npm test` 通过 1003 files、1 skipped，9346 tests passed、111 skipped，退出码 0。`npm run build:electron:incremental`、`npm run typecheck:shared`、`npm run typecheck:renderer`、`node --import tsx/esm scripts/i18n-check.ts` 和 `git diff --check` 均通过。全量测试仍输出 Node `MaxListenersExceededWarning`，但无失败。
- [x] **9.2.10** 代码评审：按正确性、可读性、架构、安全、性能五个维度复核渠道 gate parser/router/CLI、`ContinuationSourceQueries.read` 合约、空白 session 拒绝路径及澄清排序回归。未发现需要阻断的新增问题：名单外渠道只保留全局 persist 事实而关闭所有路由能力；坏名单 fail closed；继续意图拒绝空白 session；澄清选项仍由持久化版本快照决定，测试时间确定。评审范围限本轮新增/修改代码及对应调用点，不覆盖工作树中更早的其他改动。沿用 §9.2.9 全量测试、Electron build、类型/i18n 与 diff 检查结果；未做合并或发布。
- [x] **9.2.11** TDD 收紧影子质量 gate 的有效样本口径：先新增 500 条观测仅 2 条 `classifier_invoked=true` 的回归，旧 gate 错误返回 `ready: true`（RED）。GREEN 后 `observations`/`channelObservations` 仍报告所有脱敏观察；新增 `evaluatedObservations` 与 `evaluatedChannelObservations`，500 总量、每通道 200 条及 14 天连续覆盖只统计实际 provider 分类器调用（`classifier_invoked=1 AND provider_call_made=1`），避免只调用分类器函数但因缺少 provider 配置未发出 API 请求的记录稀释样本或 p95。p95/成本只基于实际 provider 调用；全部观察仍须独立复核，任何观察（含未调用分类器的确定性样本）标记 wrong 都会关闭 gate。保持 §4.3 的 500/200 数值不变，明确零候选的 `classifier_invoked=false` 观察只作基线。
  - 验证：RED 旧行为在 500 条、仅 2 次实际 provider 调用样本下错误得到 `ready:true`；新增 RED 覆盖 500 次分类器函数调用但仅 1 次 provider 请求、且该请求耗时 3000ms 的场景，旧实现会错误地计数并低估 p95。GREEN 后评估量/渠道量/覆盖 blockers 与 provider 调用 p95 均符合预期。shadow gate、feature gate、observation store 与 operational metrics 4 suites / 18 tests passed；Electron incremental build、shared/renderer typechecks、i18n、`git diff --check` passed。最终全量 `npm test`：1003 files passed、1 skipped；9348 tests passed、111 skipped，exit 0。Node `MaxListenersExceededWarning` 仍出现但没有失败用例。
  - 启用边界：gate 的质量口径已本机修正；实际 14 天双渠道分类器调用样本、人工标签、p95 和价格证据仍不存在，语义续接保持关闭。
- [x] **9.2.12** TDD 收紧成本门槛的费率证据：RED 新增费率卡解析回归，证明旧实现接受无来源/生效日/核验人的费率并返回非空配置；GREEN 要求每个 opaque classifier version 有对应 HTTPS 来源、生效日、核验日和核验人，并拒绝无效日期、非 HTTPS、URL 凭据/查询参数及费率/证据映射不一致。模型计价器把证据随 provider metering 传递，观测 store 将来源快照与每条成本估算一起持久化；schema v94 为历史记录增加 nullable 来源字段，旧观测不会被新费率卡追认。gate 对每条实际 provider 请求核验行级来源证据，任何一条成本数值缺证据即计为 unpriced 并阻断。
  - 验证：RED 结果为旧 parser 将无证据费率卡接受；GREEN 后 pricing/model metering、observation store、shadow gate、Track migrations 与既有 schema version 消费者 14 suites / 121 tests passed；Electron incremental build、shared/renderer typechecks、i18n（1252 中文，源码 0）、`git diff --check` passed。更新 4 个旧迁移版本断言后，复核 10 suites / 48 tests passed。最终 `npm test`：1003 files passed、1 skipped；9350 tests passed、111 skipped，exit 0，耗时 515.51s。Node `MaxListenersExceededWarning`（`session:expired`/`error`）出现但无失败测试。
  - 计价语义：成本仍是 provider 完整 token usage 乘以已核验费率卡得到的估算值，不伪称 invoice 对账。来源与生效日随观测留档；价格/模型端点更新后新旧样本按各自费率快照核验。完整全量回归尚待本轮代码结束后执行。
- [x] **9.2.13** 代码复核后修正费率证据 schema 演进：RED 证明 parser 会接受证据字段已变化但仍标 `version:1` 的新结构，且仍从旧 V1 配置键读取该费率；GREEN 将 config version 和 key 一并升至 V2，旧键不再参与成本估算。抽出 `src/shared/remoteTrackPricingEvidence.ts`，由配置 parser、attributor validator、观测 store 和 shadow gate 共用同一 HTTPS/有效日期/无凭据 URL 判定，移除四处重复校验，避免入站接受、持久化和启用 gate 的口径漂移。
  - 验证：RED 两项失败分别收到“v1 新格式不应被接受”和“legacy v1 key 不应被读取”的断言；GREEN 后 pricing/model metering/attribution/store/gate/migration 6 suites / 32 tests passed，shared pricing evidence 1 suite / 9 tests passed；Electron incremental build、shared/renderer typechecks、i18n（1252 中文，源码 0）、`git diff --check` passed。最终 `npm test`：1004 files passed、1 skipped；9361 tests passed、111 skipped，exit 0，耗时 512.65s。Node `MaxListenersExceededWarning`（`session:expired`/`error`）出现但无失败测试。
- **9.2.14** 只读核查本机现有应用数据库，确认历史会话数据不能代替新 Track 分类器影子质量样本：正式库 `spaceassistant-data.db` 的 schema version 为 82，开发库同名数据库的 schema version 为 46；两者均没有 `remote_track_*` 表，因此当前没有可供 gate 评估的 Track attribution observation。核查仅读取 SQLite schema 与版本元数据，未读取消息正文、身份字段或修改数据库。现行工作树迁移已到 schema version 94；两份本机数据库都不是已启用 Track 观测的运行实例。历史日志可继续作为既有平台协议/消息字段证据，但不能提供 `classifier_invoked=1 AND provider_call_made=1` 的分类质量、独立标签、实际 p95 或有凭证费率成本样本。正式语义续接保持关闭；需在部署当前迁移和影子观测实现后采集规定窗口数据。
- **9.2.15** 修正开发完成与语义续接启用门槛混写：开发方案 §12/§14 现明确 14 天样本仅是部署并启用影子采集后的语义自动续接门槛，不阻止代码开发交付、评审、合并或打包。`git diff --check`、`npm run build:electron:incremental` 与 `npm run typecheck:renderer` 通过。普通受限 shell 中 Electron 44 执行 `--version` 收到 signal 6，Launch Services 启动 node_modules 内 Electron.app 返回 `kLSNoExecutableErr`；随后在独立 `/private/tmp` userData 下以获批启动权限运行当前 worktree 主进程成功，startup 日志显示数据库迁移、recovery、窗口 ready、renderer 首屏和首次绘制均完成，Electron 44.1.1 / Node 24.19.0 / SQLite 3.53.3。可访问性树确认窗口加载 `127.0.0.1:9240/` 并渲染空白新用户界面；只读检查临时数据库为 schema 94、8 张 Track 表、0 条 attribution observation、无 Track 配置（默认关闭）。应用随后正常 SIGINT 退出；正式库和既有开发库未修改。独立 shadow CLI smoke 同样在全新临时库返回 0 样本及预期 activation blockers。
- **9.2.16** 补齐现有 `remote-track:shadow` 运维命令缺少 feature-gate 配置入口的问题（不新增模块）：RED 在 `remoteTrackFeatureGates.test.ts` 首次以 `parseRemoteTrackGateConfiguration is not a function` / `applyRemoteTrackGateConfiguration is not a function` 失败。GREEN 增加严格 version-1 完整配置解析、闭合布尔字段/渠道校验、事务原子写入及语义开关写入前影子 gate 检查；现有脚本新增 `gates` 子命令，并在运维手册提供 baseline/canary profile。临时数据库 CLI smoke 成功配置单渠道 canary；空样本下再请求 semantic=true 被拒绝，既有配置保持 semantic=false，确认失败路径无部分写入。聚焦 gate/shadow 测试 2 files / 15 tests passed；`npm run build:electron:incremental` 和 `git diff --check` 通过。随后完整 `npm test` 通过 1004 files（1 skipped）、9364 tests（111 skipped），退出码 0；仅有既存 Node `MaxListenersExceededWarning`。使用 electron-builder 单独输出到 `/private/tmp/spaceassistant-track-package-out` 成功构建 arm64 DMG 与 `.app`；`.app` 深度签名校验、DMG checksum 校验通过。隔离启动打包应用后 startup 日志显示迁移、recovery、窗口与 renderer 首屏成功；只读数据库检查 schema 94、8 张 Track 表，微信远程关闭且没有 Track 配置，随后正常退出。未调用分类 provider、未连接真实 IM/MCP、未更改正式/开发数据库或仓库 `release/` 产物。
- **9.2.17** 多轴代码复核发现 Track work 在 `waiting-confirm` 恢复路径只检测 `deferred_todos.state='pending'`，遗漏仍由既有审批恢复器管理的 `dispatching` todo，可能把合法恢复工作错误结算为 interrupted。先添加 DB 级回归用例，RED 精确失败：dispatching 场景实际为 `terminalize-interrupted`，预期 `delegate-async-recovery`；再将检测收敛为 `state IN ('pending','dispatching')`。Track work recovery、deferred resume coordinator、completion wake recovery 3 files / 27 tests passed；Electron 增量构建、Renderer typecheck、`git diff --check` 通过。修复后完整 `npm test` 通过 1004 files、9366 tests，跳过 1 file / 111 tests；仅有既存 Node `MaxListenersExceededWarning`。重新打包 arm64 DMG 至 `/private/tmp/spaceassistant-track-package-out`，应用深度签名与 DMG checksum 验证通过；独立用户目录启动时迁移/recovery/renderer 首屏成功，未连接外部 IM/MCP。
