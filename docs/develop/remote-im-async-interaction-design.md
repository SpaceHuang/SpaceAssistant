# 远程 IM 异步任务交互设计

> 版本：0.2（讨论稿，同步安全需求 v1.1）
> 日期：2026-10-08
> 状态：设计讨论
> 范围：飞书 / 微信远程 IM 的任务交互、入站路由、任务生命周期、进度反馈及安全待办与任务执行的衔接；安全判定与授权规则以上游需求为准。

## 1. 目的

远程 IM 不应复制桌面聊天的同步交互。IM 用户通常不能持续盯着执行过程，输入和回复成本更高，第三方接口也不适合承载 Thinking 与 token 级流式更新。本设计把 IM 输入视为可持久化任务：先理解并确认目标与计划，再后台执行，最终通知结果。

本稿承接已达成的讨论共识：

1. 用户发送请求后，Agent 先形成意图理解和执行计划；请求需要执行时，向用户呈现计划并等待确认。
2. 计划确认与工具安全确认是两个独立关口。
3. 新输入先进入待处理消息；Skill 在当前 Agent Loop 结束后判断它是当前任务的补充、独立请求还是需要澄清。
4. 计划确认等待期间不自动执行。
5. IM 进度按有意义的任务状态变化发送，不复刻 Thinking 流。
6. Skill 尽量描述任务理解、计划和领域工作流；系统代码保留可靠性、安全、任务状态及消息传输边界。
7. 执行中仍即时受理新输入；同一 IM session 默认最多一个 Agent Loop；新消息先留在待处理消息中，不启动共享 session 上下文的并发 Agent。

## 2. 现状与设计约束

当前飞书 / 微信路由最终会 `await executeRemoteTurn(...)` 完成整轮 Agent 执行。同一 session 已有运行占用；新消息遇到 `session_busy` 时会被拒绝。桌面端存在持久化 queued user message 和 turn queue，但 IM 入站尚未使用待处理消息队列。新设计复用桌面队列的持久化、幂等和原子领取基础设施；桌面与 IM 使用相互独立的队列作用域，彼此不混排、不互相消费，IM 的入站路由和唤起时机仍按 IM 工作流设计。远程执行器通过进度适配器发送 typing、心跳或阶段摘要，最终结果通常在执行结束后发送。

安全判定与授权规则以上游需求 [远程 IM 异步审批安全模型](../requirement/remote-im-async-approval-security-requirement.md) 为准。本稿补全该上游需求留给执行逻辑方案的部分：安全待办如何截断当前执行、如何呈现部分结果、用户追认如何精确恢复原动作，以及动作完成后如何恢复任务工作流。上游 v1.1 已通过 [第二轮需求复审](../review/2026-10-08-remote-im-async-approval-security-requirement-review-v2.md)，本文描述两份方案对齐后的目标实现；实施前决策与启用验收仍须按上游要求完成。

**计划确认不等于工具授权。** 用户确认计划只表示目标理解和步骤范围对齐，不能跳过安全审核。每个工具调用仍独立经过上游定义的审核。上游返回 `deferred` 时，当前调用尚未派发、没有副作用；本方案将其视为可恢复的安全等待边界，而不是让 Agent Loop 阻塞等待用户。

用户确认后的意图摘要与计划可作为**额外上下文证据**提供给现有安全审核 Agent，帮助它理解“用户实际委托了什么”，并与当前工具调用事实比对。应同时保留原始用户输入、确认的计划版本和当前动作事实，且标明计划来自用户确认。安全审核 Agent 仍按现有规则作出判断；计划文本不是 allowlist，不得扩大工具权限，也不得把未列入计划的动作自动视为安全或已授权。

## 3. 目标与非目标

### 3.1 目标

- 收到消息后迅速给出受理回执，不要求 IM webhook / SDK 入站调用等待整轮 Agent 执行。
- 计划确认、执行、等待安全确认、完成等状态可持久化、可恢复、可查询。
- 同一 IM 会话串行运行 Agent Loop；执行中的新输入会即时受理并持久化，当前 Loop 结束后再由 Skill 路由。
- 对当前任务的补充有明确归属；影响已确认范围的修改需重新确认计划。
- 通过 Skills 尽量承载可变的领域步骤与计划格式。
- 飞书和微信共用一致的任务语义、状态机和消息路由规则。

### 3.2 非目标

- 不改桌面端同步聊天体验或桌面消息队列。
- 当前版本不支持群聊，保留现有群聊拒绝行为；未来若支持，需另行重评威胁模型和授权规则。
- 不将 Thinking、模型 token 或内部推理发送到 IM。
- 不把计划确认当成安全授权；不在本方案重定义上游安全规则、裁决标准、待办校验或追认授权语义。
- 不承诺 IM 接口提供可靠送达；任务事件和待发送消息需要可重试、幂等。
- 不在本稿确定具体数据库表结构、IPC 名称或卡片 UI。

## 4. 交互主流程

```text
收到 IM 输入、安全待办追认事件或 Agent Loop 结束事件
  → runtime 做渠道身份校验、入站幂等与最小化持久化
  → runtime 组装并启动 Agent Loop，注入 IM 工作流 Skill 与基本工具
  → Skill 判断当前业务流程，并按需读取待处理消息、更新工作流状态或等待用户
  → runtime 执行工具调用并运行上游安全审核
      ├─ approved：按原流程派发
      ├─ rejected：不派发，Skill 收到明确失败结果并决定如何结束/汇报
      └─ deferred：不派发；安全待办持久化后结束当前 Loop，在安全等待边界暂停该任务
  → 用户追认后，上游安全层校验并消费待办，精确恢复同一动作
  → 动作完成后 runtime 唤起 IM Skill，继续任务并处理 Inbox
```

计划消息建议包含：任务标题、Agent 对目标的简短复述、有限且可理解的步骤、关键假设或缺失信息，以及明确的确认 / 修改 / 取消操作。计划不应直接暴露模型 Thinking。是否要生成计划、如何等待确认、何时读取待处理消息及后续如何安排工作，由 Skill 工作流决定；runtime 不管理独立的待执行任务队列。

简单问答也进入输入记录，但可由 Skill 判定为轻量答复。哪些请求需要计划、何时澄清、何时确认，均属于工作流策略，不在 runtime 写死。计划确认不影响既有工具安全审核。

## 5. 状态模型与术语

首版只定义一种队列类型：待处理消息 Inbox。桌面与 IM 共用队列实现和存储结构，以显式 `queueScope` 划分相互隔离的逻辑队列；记录和消费流程不混用。所有 list、claim、ack、release、去重和排序操作都必须限定在 `queueScope` 内。任务及其业务阶段由 Skill 保存在通用 workflow data，不创建 runtime 管理的待执行任务队列。

| 术语 | 含义 | 容器 / 所有者 |
|---|---|---|
| **待处理消息** | 已收到并持久化，但 Skill 尚未开始判断用途的入站消息 | Inbox；runtime 保证保存，Skill 决定何时读取和如何处理 |
| **待确认任务** | Skill 已从消息形成任务/计划，当前工作流正在等用户确认 | Skill 的 workflow data；不属于 runtime 队列 |
| **执行中任务** | Agent Loop 正在处理的当前工作 | 当前 Agent Loop / Skill workflow data |

一条待处理消息经 Skill 判断后，可以成为当前工作流的补充、形成待确认任务、直接回答或继续等待用户澄清。若 Skill 决定稍后再处理，仍保留为待处理消息；首版不将它转换成“等待执行资源”的待执行任务实体。

建议以一条用户输入为任务起点，任务可有关联补充输入。Runtime 只需要保存通用执行生命周期和关联数据；对用户展示的业务阶段属于 Skill 管理的 workflow data。turn 表示一次 Agent Loop 执行事实，不强制一一对应用户任务。

| Runtime 通用状态 | 含义 | 说明 |
|---|---|---|
| `accepted` | 入站事件已持久化 | Runtime 可以为该事件启动 Agent Loop |
| `active` | 有 Agent Loop 正在处理 | session 单飞是执行资源约束 |
| `terminal` | 本次任务/输入处理已结束 | Skill 可在后续事件中决定是否继续其他任务 |

诸如 `awaiting_plan_confirmation`、`needs_user_clarification`、`waiting_for_more_context` 等业务阶段，存入版本化 workflow data，不增加 runtime 状态枚举。Runtime 对该数据不解释含义，只负责保存；唤起由可执行事件/continuation 决定，不能仅因 Inbox 中仍有 pending 消息就在 Loop 结束后自动重启。

入站消息和任务数据需可恢复地持久化；具体可用 transaction + outbox 或等价机制，避免回执与入站记录不一致。每条 IM inbound 以渠道消息 ID 做幂等键。安全待办状态由上游安全机制管理；任务 workflow data 只保存关联 ID 与 checkpoint，不得篡改、替代或推断授权状态。

## 6. 入站消息路由与处理

### 6.1 必须先保存，再分类

所有通过现有渠道身份准入的输入，runtime 先以幂等方式保存可信入站记录，再由专用安全入口识别确认关联；普通业务输入进入**待处理消息**并登记新的唤起事件，安全答复进入隔离的确认入口，不同时作为普通 Inbox 指令处理。若同 session 已有 Loop 运行，runtime 不启动第二个 Loop；当前 Loop 结束后，仅当存在尚未领取的新事件或显式 continuation 时，才启动后续 Loop 处理 Inbox。分类失败、超时、重启或回复发送失败时，原始待处理消息仍可再次交给工作流处理，但恢复也遵循逐事件领取与有界退避规则。

安全追认回复由上游安全入口处理并校验，不交给 Skill 从普通文本推断授权。普通业务表达（例如“状态”“取消”“补充”“新任务”）由 Skill 解释；runtime 只提供相应的通用能力调用，不维护完整命令语法或业务别名表。

### 6.2 路由次序

当前任务关联、独立请求、澄清及处理顺序属于 Skill 策略，不由 runtime 排列固定决策树。Skill 可以根据消息正文、引用关系、workflow data 和待处理消息提出操作；runtime 提供 Inbox 与通用 workflow data 的最小工具并保证输入不会丢失。

### 6.3 补充与计划变更

补充是否适用于当前任务、是否需要修订计划、何时消费补充，均由 Skill 工作流决定。Runtime 将输入和 workflow data 持久化；Skill 通过结束当前 Loop 并在后续外部事件中继续工作流来表达等待/恢复，不要求 runtime 建立计划专用等待状态机。Runtime 不改写已接受 turn 的输入快照；Skill 若要应用新增指令，应通过后续 Agent Loop / continuation 输入来表达。Skill 判断用户取消意图；取消或移除已确认计划中的步骤时，必须调用下文安全待办撤销契约，不能只改 workflow data 后认为待办已取消。

### 6.4 待处理消息 Inbox 与 workflow data

Runtime 为 IM 提供持久化 Inbox，不提供独立的待执行任务队列。桌面和 IM 共用队列底层实现与存储结构，每条记录带显式 `queueScope`；桌面会话和 IM 会话映射到不同 scope。所有读取、领取、确认、释放、去重和排序查询都必须按 scope 过滤，原子认领更新也同时校验 scope 与当前状态，防止跨链路消费。数据库应为实际使用的 scope、状态和顺序字段建立复合索引。两条链路复用通用持久化和并发安全原语，但 IM 不创建桌面 UI 消息，也不走桌面 turn queue 的消费流程。

渠道入口在鉴权后自动 append；Skill 自行决定何时 list、claim、ack 或 release。Loop 运行期间到达的新消息保留在 IM Inbox；runtime 记录持久化待唤起事实。队列非空只是数据事实，不等同于存在可执行唤起原因；Runtime 不自行决定消息处理顺序，也不自动将消息转成任务。

| 工具 | 最小语义 |
|---|---|
| `inbox.list` | 列出当前已鉴权 IM session 中尚未处理且可领取的入站消息；不隐含消费，排序稳定 |
| `inbox.claim(messageId)` | Skill 指定开始处理的消息；runtime 从调用上下文绑定 scope，原子认领并阻止并发重复处理，设置有期限且可续租的租约 |
| `inbox.ack(messageId)` | Skill 确认该消息已完成路由/处理；runtime 校验 scope 与认领归属，重复调用幂等 |
| `inbox.release(messageId)` | Skill 暂缓处理时释放认领；runtime 校验 scope 与认领归属，消息仍保持待处理 |
| `inbox.renew(messageId)` | 处理仍在进行时续租；runtime 校验 scope 与认领归属 |
| `workflow.waitForEvent` | Skill 完成本轮后声明等待新外部事件；不接收模型提供的游标，由 Runtime 按本轮已领取事件集处理 |
| `workflow.continue(reasonKey)` | Skill 请求显式 continuation；Runtime 用稳定 reason key 幂等登记新的可执行事件 |
| `task.cancel(workflowId, taskId, expectedRevision)` | Skill 确认取消意图后请求取消；Runtime 通过可信任务控制记录和安全层使关联未派发待办失效，并返回取消与已派发动作的真实边界 |
| `task.revisePlan(workflowId, taskId, newRevision, stepMapping)` | Skill 提交已确认的新计划版本及步骤映射；Runtime/安全层只保留可证明未变化的步骤待办，其余旧 revision 待办先失效再允许新计划执行 |
| `workflow_state.get` | 读取当前会话、指定 workflow/version 的持久化业务状态 |
| `workflow_state.put` | 写入 Skill 定义的状态数据；带 expectedRevision 做并发/重试保护 |

`workflow_state` 的 payload 由 Skill 定义，可保存当前任务摘要、计划版本、待确认/澄清状态等。Runtime 只按 workflow 标识和版本存取不透明数据，并执行大小、作用域和 revision 等通用校验；不解释字段。状态写入应自动附带当前已鉴权的 channel/session/inbound message 元数据，不能让模型自行填写确认人或伪造来源。Skill 负责解释用户回复的业务含义；Runtime 只保证被引用的来源消息真实存在且作用域匹配。入站记录按渠道消息 ID 唯一；Inbox claim 使用租约和稳定 message ID。

安全调用准备记录与任务关联字段属于 Runtime/安全层可信元数据，不属于 Skill 任意可写的 workflow payload。Skill 只能经 `task.cancel` / `task.revisePlan` 提交业务意图；Runtime 根据已鉴权 workflow、任务 revision、步骤映射和原始 invocation 关联执行边界校验。

租约只限制某次认领的有效期，不是消息保留期限。租约到期且消息未 ack 时，消息重新可领取；不因租约到期丢弃消息。处理较长时 Skill 可续租；暂缓处理则 release。等待用户计划确认、澄清或安全审核时，Skill 应先持久化 workflow data 并 ack 已完成路由的入站消息，避免等待期间长期占用 Inbox 租约；后续由新的入站或安全审核事件恢复工作流。若消息被 release，Runtime 不因它仍处于 pending 就立即重复启动 Loop；它只在新的可执行事件或 Skill 显式请求的 continuation 到达时重新唤起。崩溃后允许消息重新交给 Skill，因此业务副作用仍须使用现有 turn/request 幂等及恢复机制，不能承诺端到端严格“恰好一次”。

入站消息与待唤起事实应在同一事务写入，或通过等价 transactional outbox 保证一致。唤起采用**逐事件领取与确认**，不使用会吞掉并发事件的单一消费高水位。每条事件有稳定 `eventId`、幂等 `reasonKey`、session、事件类型/受控 payload 引用及 `pending / claimed / acked` 状态。Runtime 启动 Loop 前原子领取当时一组有限的 pending 事件，并将确切的 `eventId` 集合和 `runId` 持久化；Loop 结束只可 ack 这组已领取事件，且需校验 `runId`/认领租约。执行期间并发写入的新入站事件，以及 Skill 调用 `workflow.continue(reasonKey)` 新建的 continuation，均是不同的 pending 事件，不属于本轮领取集合，结束提交不得确认或删除它们。

新入站、安全恢复和显式 continuation 各自创建独立事件；同一 reasonKey 重复投递幂等。Inbox 消息确认与唤起事件确认是两个独立操作：Loop 可 ack 本轮唤起事件并 release 消息，然后等待新事件；消息仍 pending 不会自行触发 Loop。`workflow.waitForEvent` 不接受由模型指定的游标或事件代次，只将本轮已领取事件按 runId 确认/释放并让当前 run 结束。Runtime dispatcher 只要发现新的 pending 唤起事件就可启动后续 Loop。由此，本轮新建 continuation 只能由后续 Loop 领取，不能被当前 Loop 的结束逻辑提前消费。

模型/执行器临时不可用等基础设施失败使用 Runtime 有界退避（指数退避并加入抖动，设置最大尝试次数/时间窗）；达到上限后停止自动重试并记录可观测故障，等待新外部事件或运维恢复，不能每次失败立即自唤起。业务性 release/wait 由 Skill 选择等待条件，但 Runtime 只按逐事件状态和认领租约处理，不解释等待语义。Loop 崩溃时，已领取事件的租约到期后可重新领取；完成提交使用稳定 runId/eventId 幂等。恢复扫描/outbox 重试逐条处理事件，不会推进全局高水位或吞掉并发入站/continuation。启动的 Agent Loop 仍由 Skill 选择要 list/claim 的消息。

同一 session 内 Agent Loop 与安全层的精确追认派发共用同一个执行租约和应用级并发限制。Runtime 在普通 Loop 运行时不并发启动共享同一 session 历史、工作目录或工具状态的第二个 Loop，也不允许安全确认入口绕过该租约直接派发动作。Loop 运行期间新消息只写 Inbox 并登记新事件；当前 Loop 结束后，Runtime 根据已持久化的唤起原因竞争执行租约。安全恢复请求忙时保持 durable pending，不消费待办、不派发动作；获得 session 执行租约和应用级并发额度后，才执行最新授权/任务校验、原子消费待办并派发。顺序固定为“持久化恢复请求 → 领取 session + 全局执行额度 → 在租约保护下复检并消费待办 → 派发精确动作 → 持久化结果与完成事件 → 释放租约”。任何一步失败都保留可恢复事实；未消费前可因撤销而失效，消费后但派发状态不明时按安全层执行日志对账，不能盲目重放。

两个待办同时追认时，它们可以分别持久化恢复请求，但必须竞争待办 `originSessionId` 对应的同一个 session 单飞租约；跨 session 仍服从应用级并发额度。租约持有覆盖动作派发和结果持久化，以免另一个 Loop 在动作执行中修改共享工作目录或工具状态。应用重启后租约过期可恢复请求，但须先查询待办消费/派发日志确定是否已执行；原 session 已删除或授权上下文失效时按上游规则使待办失效，不迁移到新 session 执行。

## 7. Skill 与运行时代码的职责

### 7.1 职责边界原则

仓库现有 Skill 是模型可读取/注入的工作规范，不是可信的工作流引擎。它适合承载可变化的业务判断与步骤；不能保证消息持久化、只执行一次或在重启后恢复。因此采用以下最小分工：

- **Skill 负责业务编排。** 判断输入归属、复杂度、计划/澄清策略、何时从 Inbox 取消息、消息处理顺序、补充如何合入、何时等待或继续，以及如何汇报结果。
- **runtime 负责 Agent Loop 容器与通用可靠性。** 组装并启动 Agent Loop，注入选定的 IM 工作流 Skill、基本工具和必要上下文；在入站消息、Loop 结束等外部事件到达时唤起工作流；提供 Inbox、通用 workflow data 存取、安全审核和 IM 出站能力。
- **runtime 不解释工作流语义。** 它只校验调用者身份、工具参数形状、会话作用域、Inbox claim 和现有安全不变量；不判断一条消息是否复杂、是否为追加、是否需要计划确认，也不创建或调度业务任务队列。

```text
IM adapter → ingress/auth/idempotency → durable inbox
                                      ↓
runtime 组装 Agent Loop（IM Skill + 基本工具 + 当前上下文）
                                      ↓
Skill 选择业务分支并调用工具（Inbox、workflow data、IM 出站等）
                                      ↓
runtime 执行工具调用并经过上游安全审核
  approved → 派发
  deferred → 持久化待办关联；部分推进或等待，不阻塞 Loop
                                      ↓
新事件 / 显式 continuation → runtime 逐事件领取并在 session 租约下唤起
安全追认 → 持久化恢复请求 → 同一 session 租约 → 精确派发 → 结果 outbox → 恢复 Skill
```

### 7.2 适合放进 Skill 的工作流

- 如何澄清用户目标、整理假设和缺失信息。
- 新输入是否在语义上指向当前任务，还是独立请求；判断依据和不确定点是什么。
- 一条新指令是轻量直接答复、需要计划确认，还是缺少信息应先澄清。
- 当前任务的追加是否仍在用户已确认的目标和范围内，还是需要修订计划。
- 如何生成清楚、可审阅的计划，以及计划的表达模板。
- 特定领域任务的步骤、检查点、结果结构和失败后的建议。
- 哪些阶段值得向用户汇报，以及汇报内容应如何简洁表达。

建议有一个常驻的 `im-task-orchestration` Skill 负责通用分类/计划协议，领域 Skills 负责具体工作。Skill 应带版本或内容摘要；任务确认时记录采用的计划版本和 Skill 版本，确保执行时能审计“用户确认了什么”。

### 7.3 Runtime 保留的最小职责

- 组装并启动 Agent Loop，注入 IM 工作流 Skill、基本工具、必要会话上下文与消息收发适配器。
- 在准入 IM 入站、有效安全恢复事件和显式 continuation 到达时逐事件领取并唤起工作流；支持 `wait_for_event`，不因同一 pending 消息或无进展 Loop 结束自唤起；基础设施重试使用有界退避。
- 对准入身份、inbound 幂等键、Agent Loop 与安全精确派发共用的 session 单飞租约、应用级并发额度、执行记录、Inbox 与 workflow data 存取提供可靠实现。
- 入站时自动 append 到 Inbox，并提供 Inbox list/claim/ack/release/renew、事件等待/continuation、任务取消/计划修订及通用 workflow_state.get/put；校验作用域、revision、认领和稳定幂等键，不解释业务语义。
- 维护待办关联准备记录、checkpoint/outbox 补偿和可恢复执行结果；安全追认只有获得共享执行租约后才能消费及派发。
- 在实际工具调用边界调用上游安全审核；对接其 `approved` / `rejected` / `deferred` 结果、待办完成事件和执行前复核，但不实现另一套审批判定。
- 承担 IM 传输投递和投递事实记录；普通进度内容与业务发送时机由 Skill 决定，安全待办通知仅使用安全层审查的 DTO 和专用投递入口。任意工具外发不得伪装成通知。

Skill 可通过 Inbox 和 workflow data 工具请求业务动作；它不能伪造调用者身份、确认事实或安全授权。Runtime 不要求 Skill 使用固定业务状态枚举，但会拒绝越过通用执行边界或现有安全门的工具调用。

### 7.4 Skill 与工具的契约（建议）

业务编排不必每步都先输出固定 `route` / `complexity` 枚举再由 runtime 解释。Skill 可以使用自然语言决策并直接调用 runtime 注入的工具；需要跨 Loop 或重启保留的业务数据，通过 `workflow_state.get/put` 保存带 `workflowId` / `workflowVersion` 的 payload。Runtime 只按会话作用域和 revision 存取，不解释业务字段；Inbox 保留渠道入站消息的原始信封。

运行时通用拒绝仅报告机械原因（例如无此 message、session 不匹配、重复认领、权限不足、存储上限、revision 冲突、工具参数不合法）；Skill 再依据工作流决定重试、澄清或结束处理。业务性降级不由 runtime 固定成“必须澄清”。

### 7.5 逐场景责任矩阵

| 场景 | Skill 决策 | Runtime 提供 |
|---|---|---|
| 新输入含义 | 追加、独立、轻量回复或澄清 | 保存原始入站事件，启动带有 IM Skill 的 Agent Loop |
| 待处理消息 | 何时读取/认领哪条输入及如何路由 | 入站时持久化；提供 Inbox list/claim/ack/release |
| 当前任务与计划 | 是否形成计划、是否等待计划确认、状态如何演进 | 提供不透明 workflow data 的 get/put |
| 追加执行中任务 | 是否吸收、修订目标或暂缓处理 | 保持已接受 turn 输入不可变，支持后续 Loop/continuation |
| Loop 结束后处理 | 是否读待处理消息、发送阶段消息或继续工作 | 记录终止事实并在后续外部事件唤起工作流；不自动选择或调度业务任务 |
| 工具安全确认/追认 | 可用已确认意图作为上下文；处理完成事件后决定如何续接 | 上游安全审核独立裁决；deferred/replay 使用同一 session 租约并安全恢复，不由 Skill 跳过 |

## 8. 计划确认与执行期安全待办

### 8.1 计划确认协议

若某工作流需要计划确认，计划内容、revision 和用户回复均由 Skill 按 workflow data 关联保存；确认文本如何解释、何时视为同意、如何处理含糊回复由 Skill 定义。Runtime 只提供可信的入站身份/消息元数据与通用持久化能力，不能允许 Skill 伪造用户身份。计划 revision 绑定是本工作流采用的规则，不要求 runtime 增设计划专用确认 API。安全工具确认仍完全走现有安全通道。

计划修订建议保留版本历史和摘要，至少记录原始用户输入、Agent 生成版本、用户补充、确认者、确认时间和版本号。不要将完整私密附件或无关会话内容复制进确认协议。

### 8.2 安全待办与执行工作流的衔接

安全审批与待办语义由上游 [远程 IM 异步审批安全模型](../requirement/remote-im-async-approval-security-requirement.md) 定义。本节规定 IM 执行器如何消费其结果，不复制上游的裁决规则。

**核心原则：一次 `deferred` 只挂起被拦截的精确动作，不让 Agent Loop 同步等待用户，也不把待办动作重新交给模型生成。** 上游安全层是待办状态、身份/持久授权 epoch/完整调用绑定/策略事实/环境复检和一次性追认的权威来源；任务 workflow data 只保存与 `todoId` 的关联及任务进度，不能自行批准或重建待办。待办和续接必须先完成持久化关联，才能对用户可见、可追认或可派发。

处理顺序如下：

1. 在提交工具调用安全审核前，Runtime 先持久化一条 `security_action_intent` 准备记录：稳定 `invocationId`、`workflowId`、任务/计划 revision、步骤 ID、当前 checkpoint revision 和不可变调用 envelope 的受控引用。该记录可在 workflow data 写入失败时独立恢复，模型不可写。
2. 工具调用经过上游安全审核。若结果是 `approved`，按原工具链派发；若是 `rejected`，不派发，由 Skill 按失败结果处理；若是 `deferred`，工具调用尚未派发且必须为零副作用。上游待办以 `invocationId` 幂等创建并引用准备记录。
3. Runtime 将 `todoId` 与准备记录关联，并以幂等事务提交 workflow checkpoint/outbox。只有关联提交完成，待办才可通知、追认或派发。崩溃恢复扫描准备记录及上游待办：按 `invocationId` 查找并补齐关联；若无法补齐或 checkpoint 冲突，则阻止通知/追认/派发，并由安全层将孤立待办失效。未收到有效 `todoId` 或待办持久化失败时，按拒绝/失败安全收尾，不得继续派发原动作。
4. 关联完成后，Skill 可以继续执行与被阻塞动作**明确独立**、且各自通过安全审核的计划步骤；依赖该动作结果的步骤保持未完成。Skill 无法证明独立性时，停止该任务的后续执行。模型不得通过改写参数、拆分动作或换工具绕过同一个安全阻断。
5. 当前 Loop 到达安全等待边界后正常结束并释放 session 执行槽；向用户发送待办通知和已完成部分摘要。任务可处于“部分完成、等待安全追认”，但不持有 Agent Loop、Inbox claim 或运行租约。用户尚未答复时，同 session 的其他待处理消息仍可被后续 Loop 接收和处理。
6. 用户追认先由安全入口验证身份/语法，并持久化幂等 `resume_request`；此时待办仍为 pending，尚未消费。Runtime 取得 session 执行租约与全局执行额度后，安全层在租约内重新校验待办、关联 invocation、当前任务/计划 revision 及授权环境，再原子消费授权并通过与撤销共用的 permit fencing 派发精确动作。待办 status 的 consumed 与 executionState 的 not_dispatched/dispatching 分开记录，消费不表示副作用已经发生。安全入口不得绕过单飞直接派发。拒绝、过期、失效、取消或身份不匹配均不恢复该动作。
7. 动作结果、派发幂等键及可信完成事件先写入可恢复执行日志/outbox，再释放租约；事件投递可重试且以 `todoId + invocationId` 幂等。Skill 读取关联 workflow data 和已持久化动作结果，从 checkpoint 继续尚未完成且仍符合当前计划的步骤；若计划已过期或上下文有实质变化，先向用户更新计划并重新确认。恢复后的每个新工具调用仍经过完整安全审核。

**重放载体要求：** `factsHash` 仅代表策略事实，不是完整参数指纹，不能证明正文、写入内容或附件未变化。待办必须关联主进程受控、不可变且可跨重启恢复的原始调用 envelope，分别绑定 `invocationId`、`canonicalArgsHash`、`contentVersions`、`executionContextHash` 与 `{ ruleId, factsHash }`，并明确规范化算法和 schema 版本。可变外部引用必须快照或拒绝创建；缺失/损坏载荷、版本不支持或摘要不符均阻止执行并告警。真实参数不得通过通知脱敏改写，不进入模型可写 workflow data、通知或普通日志。按上游 OQ-4 决定，首版不加密存储 envelope；主进程受控存储访问隔离仍为必需。清理须等待恢复请求、执行日志与 checkpoint 对账完成。

**授权与当前策略复检：** 待办绑定持久、不复用的 `authorizationEpoch`，不能持久化进程内 `authorizationGeneration` 代替。租约内恢复原调用后重新执行当前策略与环境校验；当前 deny/locked/critical 均阻止派发，仍 require-confirm 时 `ruleId + factsHash` 必须一致。当前变为 auto-allow 也不能跳过完整调用、epoch、环境及外流约束；不能直接以 `isSafetyRecheckAllowed` 作为异步放行依据。

**部分推进边界：** 首版允许继续执行计划中可证明独立的步骤，避免一个待办冻结整项任务；不得跨越依赖边继续执行。若现有 Agent Loop/工具协议无法可靠标记安全等待结果、保存 checkpoint 并阻止被拦动作重试，则首版降级为“在首个 `deferred` 处结束当前 Loop，追认后由安全层执行精确动作，再恢复 Skill”，不允许用普通模型续写模拟动作重放。

**追认关联契约：** 每条待办单独发送通知（OQ-6 已决定不聚合），用户手动回复 `批准 <编号>` 或 `拒绝 <编号>`。编号最多两位十进制数字，在同一 `channel + identityKey` 下永久唯一且绑定 `owner + todoId + notificationVersion`；编号永不复用，补发生成新版本/新编号并立即使旧编号失效。两位数字最多提供 100 个历史编号/identity，耗尽后停止创建可追认待办并 fail closed，明确告知用户，不得回收编号。编号只用于定位待办，不代替渠道身份校验。仅 checkpoint 已提交且通知关联已登记的待办可追认；无编号的 Y/N、“同意”、普通业务文本、过期通知、旧补发版本及身份不匹配均不消费。安全待办、同步确认卡与计划确认使用隔离命名空间，计划确认的 Y 不能批准待办；解析采用严格命令语法，防止正文中偶然出现编号触发追认。

**一次性与独立记忆选择：** 普通追认只执行本次精确动作，不得写 decision_cache。可后置的“批准并记住”默认关闭，须通过独立流程，在批准前成功展示具体类别、目标/会话范围、有效期和撤销入口，并保存显式 consent；展示失败、答复含糊、未选择或范围改变均不写缓存。只复用既有缓存并遵守资格与作用域，不复活写授权租约或引入第三套长期授权；outbound、deny/locked/critical 不提供该选择。

**任务取消与计划修订的待办撤销契约：** 每个安全待办必须绑定不可变的 `workflowId + taskId + stepId + planRevision + invocationId`。Skill 判断取消任务或新计划移除了/替换了某一步时，通过可信 Runtime 工具请求 `task.cancel` 或 `task.revisePlan`；Runtime 从已鉴权上下文和已持久化 workflow 关联解析待办集合，调用上游安全层批量失效关联待办并写入任务/步骤 tombstone。Skill 不可直接编辑待办记录或自行标记已取消。

取消/修订与追认派发使用同一任务级线性化锁，并与 session 执行租约协调：尚未开始派发的待办先完成 tombstone/失效提交，之后追认校验必定失败；不能以已写 `dispatching` 标记判定取消已来不及：executor 在真实副作用开始边界验证 permit，最终复检、消费和真实派发之间的窗口与撤销/取消/修订共用锁、事务或等价 fencing。撤销先提交则包括 consumed 未派发动作在内均不可执行；真实派发先开始时，取消返回准确结果。过期租约或旧 owner 的 permit 不可派发。派发边界之前取消成功则动作不执行；派发已经开始或完成后不可声称已撤回，系统应返回“动作已开始/已完成，停止了后续步骤”等真实状态。计划修订只使被移除或替换的步骤及其 invocation 待办失效，保留且未变化的步骤按显式映射继续有效；无法证明映射时，旧 revision 下全部未派发动作失效。

workflow data 与上游安全待办不假定共享数据库事务。Runtime 的可信任务控制日志是取消/计划 revision 的协调记录，采用稳定操作 ID 和 outbox：先持久化 `cancel/revise requested`，上游安全层幂等处理 tombstone 与关联待办失效，再提交终态并发出结果事件。恢复扫描补做未完成操作；操作未完成时，安全层 fail closed，禁止关联待办进入 dispatching。已开始派发的结果通过执行日志对账后再完成取消响应。授权面撤销另需持久协调配置、epoch 与 tombstone；启动先恢复这些记录并补做级联，再开放待办与恢复请求。旧无 epoch/envelope 记录直接失效；缺失/损坏 epoch 不得回退为 0。关后重开或同 owner 重新绑定须产生新授权身份，任何提交/级联失败都阻断该授权面派发。

**待办与 checkpoint 补偿状态：** `security_action_intent` 先作为准备记录持久化，之后允许创建上游待办；记录状态至少为 `prepared → todo_linked → checkpoint_committed → notified`，并以 `invocationId` 唯一。checkpoint 与 `todo_linked` 关联通过 runtime 数据库事务/outbox 幂等提交。只有到达 `checkpoint_committed` 才能发送待办通知；安全入口在该状态前拒绝追认，安全派发器在该状态前拒绝消费。重启恢复按 `invocationId` 对账：缺少待办则重试幂等创建，待办存在而关联缺失则补链，revision 冲突则阻止派发并使待办失效。无法自动修复的记录进入可观测的 `reconciliation_required`，不静默丢弃或继续执行。

追认派发也采用可恢复状态：`resume_requested → slot_acquired → dispatching → result_committed → completion_outboxed`。`dispatching` 前先将稳定 `invocationId` 写入安全执行日志；工具/执行器应以该 ID 去重，结果或受控结果引用持久化后才产生完成 outbox。消费后、真实派发前崩溃，先核对持久日志与 permit，仅在证明未派发且授权仍有效时按原 invocationId 续派发，不回到 pending 或重新批准。派发后崩溃先查询执行器/工具的幂等结果并补写日志。审计分别记录 todo.approved、todo.dispatched 和 todo.result，不把 consumed 作为成功结果。若无法判断动作是否已产生外部副作用，则转为 `outcome_unknown`、阻止自动重放并向用户报告需人工核对；不能为了“保证继续”重复执行非幂等动作。

### 8.3 委托证据、外流与启用边界

可信 Runtime 保留原文受控引用、来源分区和完整限制条件。`taskDigest` 仅是可验证直接委托的展示摘要；用户消息内的引用、转发、代码块、附件及待处理文本均不是授权指令。无法可靠分区或读取完整证据、摘要截断丢失限制时，授权上限为 unknown/low；Skill 生成的计划、相关性判断与计划确认不能替代直接委托证据。原文第 500 字之后的“不要发送/不要写入”等限制仍须保留并约束执行。

任意 `ActionClass='outbound'` 的非禁区动作都必须对精确收件目标、正文和附件逐次 deferred 后由真人批准，即使用户明确要求发送、Agent approve、当前策略 auto-allow 或缓存命中也不能免确认；不得写入长期外流授权。当前策略 deny/locked/critical、递归阻断及执行能力/配置不可用均拒绝，不能提示“批准即可执行”。Agent deny/undetermined 或裁决 unavailable/timeout/unparsable 只有在授权是唯一障碍时才可 deferred。专用安全通知只能向当前已鉴权 owner 投递经审查 DTO，普通工具外发仍走完整审核。

待办限额检查与准备记录容量预留必须按 originSessionId 和 channel + identityKey 两级原子执行；建议分别 5 条和 10 条 pending，同 invocationId 不重复占额，失败预留可恢复释放。启动先过期并对账预留；TTL 默认 24h，自原始创建时刻计算，补发、重启和恢复请求不延长。超限或 TTL=0 不创建待办，拒绝动作并明确回执。

启用异步审批必须先完成上游 §16 门禁：持久撤销恢复、完整调用与委托证据校验、通知初发/补发审查和关联、有限 TTL、原子限额、外流确定出口、租约与真实派发 fencing、审计及回退均有验收证据。契约未定稿、能力缺失或配置损坏时禁止开启，保持旧 user 路径或 fail closed；本设计更新不表示功能已实现或评审通过。

关闭/回退先阻断异步派发入口，持久提交关闭事实、新 epoch 和 tombstone，再失效 pending、取消 resume_request、撤销 consumed 未派发 permit，对账完成后回退 user。失败或中断保持阻断并在重启后补做；旧答复不能转成同步批准，已真实派发者按日志报告结果。合法独立人类缓存按既有撤销范围处理。

## 9. IM 进度与通知建议

通知内容、阶段选择及心跳策略由 Skill 工作流定义。Runtime 提供出站投递、消息长度适配、幂等/重试等传输能力；安全通知内容与关联受上游安全契约约束。当前建议的工作流策略是“有用状态变化优先、阶段摘要其次、心跳兜底”：

| 时机 | 建议消息 |
|---|---|
| 入站已保存 | “已收到，正在整理目标和计划。”（应快速返回） |
| 需要计划确认 | 目标摘要 + 步骤计划 + 确认/修改/取消方式 |
| 用户确认后开始 | “计划已确认，开始执行。任务 #…” |
| 阶段变化 | 已完成阶段、当前阶段；只在有新信息时发送 |
| 等待安全追认 | 由上游安全待办通知负责，附带待办标识/追认方式及已完成部分；不得用普通进度消息替代 |
| 任务完成 | 结果摘要、产物位置/链接（若允许）、下一步入口 |
| 失败/暂停/取消 | 状态、已完成部分、失败原因摘要、可执行的恢复/重试动作 |

当前工作流不发送 Thinking、token delta、内部工具日志或重复“仍在处理”。它可以定义阶段节流、去重与心跳阈值（5 分钟仅为初始实验值，不进入 runtime 固定逻辑）。外部 IM 投递失败不应回滚任务；runtime 记录投递事实并提供重试原语，由工作流决定是否重试或告知用户。

安全待办通知初发与补发只使用审查后的 DTO，不从 envelope、工具日志或模型正文临时拼接。可展示动作用途、脱敏目标和直接委托摘要，不展示绝对路径、完整命令、凭据/token 片段或无关会话内容；材料中的指令不得呈现为用户委托。通知应说明动作、挂起原因、有效期及有效追认方式。已完成部分摘要单独审查，不能混入未审查载荷。

投递失败保留 pending 与未投递标记；仅当前身份、epoch 和 TTL 仍有效时补发并登记通知版本/messageId，否则过期或失效。投递结果与通知关联可恢复对账前不接受该通知的追认。普通进度消息可按工作流策略聚合或裁剪；安全待办通知严格逐条发送，不能聚合多个 todo。任何展示裁剪都不改变真实调用、待办关联或授权范围。

## 10. 异常与恢复

- **Skill/模型不可用：** 原始入站事件保存在 inbox；runtime 以有界退避重试，达到上限后暂停自动尝试并记录可观测故障。是否在后续新事件中重试以及如何告知由工作流处理。
- **无进展等待 / 执行器失败：** release 的同一消息和 Loop 结束事件不构成新唤起原因；Skill 可返回 `workflow.waitForEvent`，等新入站、安全恢复或显式 continuation。模型/执行器故障由 Runtime 有界退避；达到配置上限后停止自动重试、告警并等待新事件/运维恢复。
- **消息投递失败：** runtime 保留投递结果和重试能力；是否重试或更换提示由工作流决定。
- **计划确认对象过期或失配：** Skill 对照 workflow data 中的计划 revision 处理；runtime 只提供可信来源消息元数据与带 revision 的状态存取，不实现计划专用确认状态机。现有工具安全确认仍由安全通道处理。
- **安全审核返回 deferred / 两存储间崩溃：** 先查 `security_action_intent` 与上游待办的 `invocationId` 关联，按补偿状态机补链；checkpoint 未提交前不通知、不允许追认和派发。遇到 revision 冲突或不可修复孤立记录时失效待办并告警。
- **追认与普通 Loop 并发：** 追认只创建 durable `resume_request`，与普通 Loop 竞争同一 session 执行租约及全局执行额度；取得租约前不消费待办、不派发。重启恢复请求并再次核验撤销状态。
- **追认已消费但动作执行/回执时崩溃：** 安全层执行日志按 `invocationId` 与执行器去重结果对账，再提交结果和完成 outbox。只有能证明未执行或可安全幂等重试时才恢复；无法判断时进入 `outcome_unknown` 并 fail closed，不能盲目重放。
- **等待安全追认时收到新 IM 消息：** 新消息进入 IM Inbox；等待中的任务不占 session Loop。新 Loop 可处理新消息，但不得把其正文当成待办追认，除非安全入口按已定稿语法识别并完成身份校验。
- **任务计划在追认期间变化：** 追认仅授权待办中精确动作；后续计划步骤由 Skill 基于最新 workflow data 决定，实质范围变化需重新走计划确认，且每一步仍需安全审核。
- **应用重启：** runtime 恢复 Inbox、workflow data、Agent Loop 执行事实和出站记录；由新启动的 Skill 工作流决定如何继续。执行器不得盲目重放不具幂等性的工具调用。
- **任务取消/计划移除步骤与追认并发：** Skill 发起可信 cancel/revise 操作；任务控制日志与安全层按同一任务锁和稳定操作 ID 使关联待办失效。撤销/取消先于真实派发提交时保证不派发（包括已 consumed 或标记 dispatching 但未真实派发）；若真实派发已先开始，则明确报告动作已开始/完成及后续步骤停止情况，不声称撤回。
- **通道关闭/身份撤销：** 遵守现有 remote authorization、紧急关闭与确认撤销链路；Inbox 或 workflow data 中的内容不能绕过撤销。
- **同一用户多 session：** 明确任务归属 session；切换 session 不迁移任务所有权，跨 session 追踪须显式命令并继续遵守现有授权。

## 11. 分阶段实施建议

### P0：协议与持久化基础

- 定义最小 runtime 工具契约：Agent Loop 启动/结束事件、按 scope 隔离的 Inbox 工具（含租约续期）、通用 workflow data 持久化和 IM 消息投递。
- 把飞书、微信入站改成“持久化受理 + runtime 组装并启动 Agent Loop”。
- 实现共享队列存储的 `queueScope` 隔离与索引、Inbox 持久化/幂等及 list/claim/ack/release/renew、workflow data get/put 和进程重启恢复。
- 暂不改现有工具安全确认逻辑。

### P1：Skill 工作流与计划确认

- 编写/接入 IM orchestration Skill，定义意图理解、轻量答复、计划确认、追加/独立判断及 Inbox 消息处理策略。
- Skill 使用 runtime 基本工具、Inbox 和 workflow data 编排确认、等待和继续。
- 计划确认协议与业务状态留在 Skill workflow data；runtime 仅提供可信入站元数据和通用存取能力。
- 新消息先持久化，Loop 结束后再由 Skill 路由；补充、独立、歧义的工作流结果可审计。

### P2：后台执行、补充输入与通知

- Runtime 根据外部事件启动 Agent Loop；Skill 决定 Inbox 消息处理、后续工作流和 continuation 时机。
- Skill 定义运行中补充的范围检查与计划修订流程。
- Skill 定义阶段进度与终态通知；Runtime 提供节流/去重/重试等投递工具。
- 接入上游 IM 异步审批安全模型：`deferred` 安全等待边界、待办通知、可独立步骤的部分推进、精确动作追认执行、`todoId` checkpoint 关联与 Skill 工作流恢复；安全判定和待办校验仍由上游安全模块负责。
- 实现逐事件领取/确认、`waitForEvent` / 幂等显式 continuation、无进展不自唤起与模型/执行器有界退避。
- 安全追认派发与普通 Loop 共用 session 单飞租约及全局执行额度；落地 resume request 持久化、取消/计划修订撤销关联待办、待办/checkpoint 补偿日志与执行结果 outbox。
- 按已确认决策实施：待办 TTL 24h 且重启保留，通知失败时同身份下次入站重试，不续期；pending 不阻止切换 session，追认回 originSessionId；envelope 不加密存储；普通追认不写缓存且首版不实现“批准并记住”；待办通知逐条发送，追认使用最多两位十进制数字，编号永久不复用（每 identity 最多 100 个历史编号，耗尽 fail closed）；当前版本不支持群聊。实现仍须满足持久 epoch、完整调用绑定、通知版本关联、外流确定出口、真实派发 fencing、两级原子限额及回退恢复。默认保持 remoteAsyncApprovalEnabled=false，不能以接入 deferred 代表允许切换 IM 默认回答者。

### P3：可靠性与体验收敛

- 飞书/微信协议和用户文案一致性。
- Inbox 保留期、workflow data 清理策略、并发限制及运维可观测性。
- 对意图误分类、重复 webhook、进程崩溃、出站失败、过期确认和并发取消做故障注入验证。

## 12. 验收标准

- IM 入站在 Agent 长任务执行期间仍快速返回受理状态，不等待整轮完成。
- 执行期间的新输入可被持久化为待处理消息，并在当前 Loop 结束后交给新 Agent Loop；同 session 不并发启动共享上下文的 Agent。
- 每条准入消息都先持久化并且幂等；重复回调不创建重复任务。
- IM orchestration Skill 对需要计划确认的请求先呈现计划；未确认前不按该工作流执行任务。
- 工作流若使用计划确认，确认状态与计划 revision 保存在 workflow data，并关联到真实、同会话的用户入站消息。
- 执行期间的新输入不会因 `session_busy` 丢失；它们先留在 Inbox，当前 Loop 结束后由 Skill 决定追加、独立处理或澄清。
- 同一消息被连续 release 且没有新事件时，不会启动无限 Loop；执行器不可用时按有界退避停止自动重试；新入站/安全恢复事件可独立领取并唤起，不受其他事件确认影响。
- Inbox 已空且没有新 IM 输入时，当前 Loop 登记的 continuation 仍保持 pending，并能唤起后续处理；当前 Loop 结束只能确认它启动时实际领取的 eventId 集合。
- 新 IM 入站与 continuation 在同一 Loop 执行期间交错登记时，二者都保持可领取；没有单一高水位确认可以吞掉其中任一事件。
- continuation/outbox 写入与 Loop 结束提交前后发生崩溃，或同一 `reasonKey` 被重复投递时，恢复会继续投递同一事件，不提前消费，也不重复创建续接。
- Runtime 不创建独立的待执行任务队列。
- 模糊补充按当前 Skill 策略处理；runtime 不自行改写已确认计划或把输入注入已接受 turn。
- 计划确认不会绕过现有安全审核；需要安全确认的动作仍由现有机制阻止直至符合其放行条件。
- 安全审核返回 `deferred` 后，待办动作未派发且零副作用；当前 Agent Loop 不同步等待用户，任务保存 `todoId` 与 checkpoint 并释放 session 执行槽。
- 只有与待办动作明确独立且单独通过安全审核的步骤可继续；依赖步骤保持暂停，不得改写或绕过被拦动作。
- 有效追认只由安全入口解析；安全层复检并执行与待办绑定的同一不可变调用，Runtime 再按 `todoId` 唤起 Skill 恢复任务；重启/重复事件不会重复派发动作。
- 追认等待期间的普通 IM 消息仍进入 Inbox 并可处理，不会意外授权或消费安全待办。
- 普通 Loop 运行期间收到追认只会持久化 `resume_request`，不并发派发；多个待办和多个 Loop 共用同一 session 单飞及应用并发限制。租约获取前撤销有效，租约内的消费/派发遵循线性化次序。
- 任务取消完成或计划移除/替换步骤后，其关联待办不可追认执行；若取消晚于已开始派发，回执准确说明动作已开始/完成及后续停止情况。
- 在待办创建、待办关联 checkpoint、动作派发、动作结果落盘和完成 outbox 投递各崩溃点恢复后，待办关联唯一；动作不重复派发，任务可读取真实结果续接，或明确进入不可自动恢复状态。
- IM 不发送 Thinking/token 流；进度消息在同阶段节流、去重，任务终态可查询且有投递记录。
- 应用重启、出站失败、重复确认、取消竞态和分类器不可用均不会导致消息丢失或未经确认执行。
- 飞书和微信共享相同 IM adapter/tool contract；业务语义可由同一 Skill 定义，但不要求 runtime 内置固定状态枚举。

安全联调还必须覆盖上游 §15.8 的七项阻断用例：

- **跨重启撤销：** 合法非零 epoch 待办恢复有效；撤销提交后级联前崩溃、关后重开、同 owner 重绑及配置/epoch 写失败，旧动作均不可派发。
- **完整调用：** 同目标改正文、同路径改写入内容、附件变更或 auto-allow 后参数变化均阻止执行；缺失 envelope 不执行，恢复原调用无需模型。
- **独立记忆：** 普通追认零 cache.write；未选择、展示投递失败或含糊答复不升级，显式范围不扩大，outbound 不记忆。
- **真实派发竞态：** 最后复检后、消费后和真实派发前注入撤销/取消，验证两种先后次序；旧租约 owner 不派发，结果未知不自动重放。
- **追认关联：** 并行待办、乱序/旧通知、重复回复、同步卡共存、计划确认 Y 和无引用同意均不产生错批；补发版本可对账。
- **外流与证据：** 明确发送仍 deferred；材料收件人/引用攻击不获高授权，长原文限制不丢失，Agent/缓存/auto-allow 不绕过逐次批准。
- **启用门禁：** 任一必需控制缺失不可开启；并发准备/创建不超两级额度；关闭后旧恢复请求不可派发；通知初发及补发不泄露敏感载荷。

## 13. 实施前需单独定稿的参数

以下参数应由 IM 工作流 Skill 选择默认值；只有涉及通用资源保护的部分进入 runtime 配置，不应为了调整业务行为修改 runtime 主流程：

1. 轻量答复、计划确认、澄清、追加和独立任务的业务判定标准。
2. 多条待处理消息的业务处理顺序，以及用户可用的状态/取消表达。
3. Inbox 保留期和 workflow data 大小/清理上限等 runtime 通用资源保护参数。
4. 计划确认等待多久提醒、是否过期，以及澄清等待期间怎样继续其他任务。
5. 阶段进度的最小发送间隔、心跳起始阈值和消息合并策略。
6. 首版部分推进能力及编号在各渠道的命令呈现/解析细节；OQ-6 逐条发送、OQ-7 最多两位十进制数字的绑定契约已定，envelope 按 OQ-4 不加密存储。上游 v1.1 已确定的绑定、拒绝、恢复与派发边界不可作为可选参数调整。
