# IM 助理与执行 Agent 协同技术方案

> 日期：2026-11-03｜状态：方案草案，未实施；持久化格式与送达不确定性处置待评审。
> 需求：[IM 助理 Agent 与执行 Agent 协同需求](../../../requirement/im-remote/in-flight/im-assistant-execution-coordination-requirement.md)。
> 核查基线：`596104f9`；核查时工作区另有未提交改动，本文不依赖其中的数据库 schema 变更。代码事实与设计提案分别标注。

## 第 0 层：决策摘要【人必读】

**一句话：** 从“IM 请求直接交给执行者并转发过程”改成“助理统一理解、分派和沟通，执行者在后台并行工作”，用提示词和 Skill 承担协调判断，仅用少量宿主代码保障排队、计时、身份绑定与恢复。

**只有 3 分钟的话：** 阅读本节两个待批准事项，以及第 1 层的软硬分工、变更面和验收边界。

**已定范围：** 沿用需求中已确认的启动、收集、自然语言回复、查询和并行规则；普通问题 5 分钟或 5 项封批，全体受阻提前封批，紧急问题优先。不新增桌面界面、设置项或独立任务面板；桌面聊天不接入。安全审批仍逐操作校验，助理不代批。

### 需要批准的事项

**方案决定 T-01：保存协作过程，以便重启后继续。** 多任务、问题和发送进度需要在本机保存；否则重启后只能重新询问或重做。选 A：在已有工作流存储中增加一份有版本的协作记录，保留来源、任务、问题及交接状态；用户可继续查询和回答，但回退旧版本前需先停止新任务并处理未完成记录。选 B：增加专用数据库表，同样支持恢复且便于逐项查询，但需要额外的表结构迁移和读写接口维护。推荐 A，以减少本轮扩展面；已有存储支持版本和冲突检测，新增记录格式及跨重启行为尚未实现验证。不决定时仅交付本文，不开始格式迁移或实施。下钻：§2.3、§2.8，需求 AC-10。

**方案决定 T-02：渠道无法确认是否已送达时如何处理。** 现有发送方式存在“平台已收到、应用尚未记账就退出”的窗口。选 A：保留待核实状态，先用平台回执或幂等查询核对；无法核实时不自动重发，并在后续用户查询时说明送达未确认，避免再次打扰，但可能有消息实际未送达。选 B：直接重试，提高最终送达概率，但用户可能重复收到问题。推荐 A；本地代码已证实存在这个窗口，两渠道能否提供可靠核对能力仍待真实验证。该行为可通过后续升级调整，已发出的消息无法撤回。不决定时保留待核实，不宣称 AC-10 已满足；严格的跨崩溃“不重复发送”必须取得平台能力证据，不能靠提示词或本地标记承诺。下钻：§2.7、U-03。

**不需要你决定：** 内部文件拆分、事务、租约、标识生成、提示词版本管理、定向测试和故障注入由实现者负责。本轮不实施功能，不要求提供真实 IM 环境。

**本次评审范围：** 软硬分工、最小宿主扩展、上述保存格式和送达处置；不重新审批需求已确认的产品行为。本文提出的内部工具和存储字段均服务于既有需求，没有新增用户操作入口。

**最可能推翻方案的三处：**

1. 如果现有执行入口无法在独立会话内保留原用户授权上下文，后台执行方案必须调整，不能复制或放宽权限来赶进度。
2. 如果模型在自然语言部分回答、问题归并上持续误配，必须改进 Skill 和评测；安全授权继续保持原协议，不能以模型置信度代替用户确认。
3. 如果平台没有幂等发送或可核验回执，严格的跨崩溃不重复送达无法保证；需确认上述待核实处置是否满足验收，或另行收敛需求。

## 第 1 层：概要与评审包【人机共读】

### 1.1 软能力负责什么，代码为什么仍需存在

| 职责 | 承载位置 | 边界与对应验收 |
|---|---|---|
| 理解目标、拆任务、决定依赖和替代方案 | IM 助理 Skill | 遵守需求 D-01、D-04；AC-05、06 |
| 查上下文、归并问题、解释选项和影响 | IM 助理 Skill | 不得隐去对象、范围和成本；AC-02、03 |
| 解释自然语言、匹配部分回答 | IM 助理 Skill | 输出逐事项匹配及原文依据；歧义留待询问；AC-04 |
| 执行专业任务、报告事项和结果 | 执行 Skill | 不具备 IM 发信能力；AC-01、07、14 |
| 5 分钟/5 项、优先队列、全体受阻封批 | IM 宿主协调器 | 时钟和计数必须脱离模型运行；AC-08、09 |
| 持久化交接、并发隔离、恢复和去重 | IM 宿主协调器与存储 | 模型输出不是提交证明；AC-10 |
| 身份、策略、审批与执行前校验 | 既有安全链 | 不在 Skill 中重写策略；AC-13 |

不建设通用工作流引擎；不增加 SDK 的 agent 角色、消息协议、历史事件种类或审批枚举。Runtime 不承载批次、问题分类、自然语言映射或执行依赖图。允许的唯一 Runtime 文件变更是装配器的提示词选择接缝：使用现有 `skillFragments` 显式内容时不再强制覆盖为默认 IM Skill；未显式提供时仍使用默认 Skill。这是材料装配，不参与协调决策。

**排除方案：** 纯提示词无法在进程退出后继续计时，也不能强制阻止执行者发信；逐工具调用增加 SDK 多 Agent 分支会扩张通用运行语义；用外部 CLI 子 Agent 则引入另一套授权与恢复问题。本期执行者复用本应用既有受控 Agent 调用链。

### 1.2 链路与状态写入者

```text
现状：
渠道路由器 → IM 远程调用入口 → 调用装配器 → 既有 Agent 执行链
                   ↑ IM 编排 Skill               ↓
渠道路由器 ← 执行摘要 / 进度 / 确认回调 ──────────┘

目标：
渠道路由器 → IM 助理协调器 → IM 远程调用入口 → 调用装配器
                  ↑    ↓         ↑                 ↓
                  │ 协作工具集 ← IM 编排 Skill ← 既有 Agent 执行链
                  │    ↓
                  │ 协作存储（协作记录唯一 writer）
                  │    ↓ durable dispatch
                  │ 后台执行适配器 → 调用装配器 → 既有 Agent 执行链
                  │       ↑ 执行 Skill                   ↓
                  └────── 运行中事项 / 问题 / 结果 ──────┘
                  ↓
         渠道出站适配（仅助理表达，目的地由宿主绑定）
```

助理会话单写串行，执行者各用独立执行会话并行；执行者的运行不能占住助理会话租约。对话事实仍由会话存储原 writer 提交，安全授权仍由既有安全链提交，图中的协作存储不写第二份消息历史或审批真相。

### 1.3 变更面表

以下是设计单元计数，不是已修改文件清单；新增文件名为提案。

| 单元 | 作用简述 | 改动类型 | 对应约束 | 跨边界 / 依赖方 |
|---|---|---|---|---|
| IM 编排 Skill：`electron/skills/bundled/imTaskOrchestrationSkill.ts` | 理解请求并协调沟通 | 改造 | INV-01、04 | IM 专属；修改先确认计划规则 |
| IM 远程调用入口：`electron/remote/imRemoteAgent.ts` | 组装远程 Agent 调用 | 改承重边界 | INV-01、02 | 协调器、两渠道 wrapper；注入工具和输出接收者 |
| 编排工具注册：`electron/remote/imOrchestrationTools.ts` | 注册 IM 协作能力 | 改承重边界 | INV-02、04 | IM 远程调用入口；分角色注册 |
| 飞书渠道路由器：`electron/feishu/remoteCommandRouter.ts` | 接入飞书请求和回复 | 改造 | INV-01、02 | 认证后接协调器；消除重复结果出口 |
| 微信渠道路由器：`electron/wechat/weChatCommandRouter.ts` | 接入微信请求和回复 | 改造 | INV-01、02 | 同上；保留平台格式适配 |
| 调用装配器：`electron/runtime/invocationAssembler.ts` | 装配调用材料和端口 | 改承重边界 | INV-01、07 | 现有调用者；只尊重显式 Skill 材料 |
| 工作流样例：`electron/remote/imWorkflowSkillHarness.ts` | 演示工作流状态处理 | 改造 | INV-01 | 对齐新 Skill 契约；不接成生产调度器 |
| IM 助理协调器：`electron/remote/imAssistantCoordinator.ts` | 排队并驱动协作处理 | 新建 | INV-03、05 | 两渠道及执行适配器；不被 SDK 反向依赖 |
| 协作工具集：`electron/remote/imCoordinationTools.ts` | 提供提交和读取能力 | 新建 | INV-02、04 | 助理和执行者；身份从宿主注入 |
| 协作存储：`electron/remote/imCoordinationStore.ts` | 保存版本化协作记录 | 新建 | INV-03、05、06 | 协调器和工具集；复用工作流存储 |
| 后台执行适配器：`electron/remote/imExecutionAgent.ts` | 驱动独立执行会话 | 新建 | INV-02、06、07 | 复用既有 turn 接纳与 Agent 执行链 |
| 执行 Skill：`electron/skills/bundled/imExecutionSkill.ts` | 执行任务并报告事项 | 新建 | INV-01、04 | 后台执行适配器装配 |
| 工作流存储：`electron/database/workflowState.ts` | 读写带版本工作流 | 复用不改 | INV-05 | 已支持 JSON、事务与 revision 比较 |
| 唤醒调度器：`electron/remote/wakeEventDispatcher.ts` | 认领并重试持久唤醒 | 复用不改 | INV-03 | 仅作为已有入站入口；不改成批处理器 |
| 会话租约：`electron/remote/remoteAgentRegistry.ts` | 限制同会话并发调用 | 复用不改 | INV-06 | 助理与执行者不同会话键 |
| 会话存储：`electron/sessionStorage/` | 提交会话与消息事实 | 复用不改（待验证） | INV-05、07 | 新调用者仍走公开端口；验证独立会话接纳 |
| 托管交接：`electron/runtime/hostedTurnHandoff.ts` | 接续既有托管执行 | 复用不改（待验证） | INV-04、07 | 验证执行者审批、挂起与恢复 |
| 任务控制：`electron/remote/imTaskControlCoordinator.ts` | 取消任务和修订计划 | 复用不改（待验证） | INV-04、06 | 执行关联由宿主绑定；验证级联撤销 |
| 渠道出站适配：`electron/remote/imRemoteOutbound.ts` | 校验并格式化 IM 输出 | 复用不改（待验证） | INV-02 | 复用校验和平台格式；不声称已有端到端幂等 |

### 1.4 契约面六面与量级

| 契约面 | 结论 | 依据与验证 |
|---|---|---|
| ① agent-sdk | 不改 | 无新增端口、HistoryEvent、审批枚举或公开导出；SDK 不依赖 remote。实施运行 `npm run check:agent-sdk`、`npm run typecheck:agent-sdk` |
| ② 会话存储 | 接口、表和唯一 writer 不改；新增公开端口调用者 | 执行会话仍走原接纳、消息与历史端口；不写 messages SQL，不复制历史到工作流。实施运行两项 session-storage 边界及 message-fact-ownership 门禁；增加旧会话读写/备份兼容回归 |
| ③ IPC / preload | 不改 | 无新面板、通道或渲染进程能力 |
| ④ shared 类型 | 不改 | 协作协议为主进程私有，不重复定义已有领域类型；实施跑 `npm run typecheck:shared` |
| ⑤ 其他持久化 | 改 | 已有工作流 JSON 新增 `coordination` 根属性及内部版本协议；无新 SQL 表/列；见 T-01、§2.3、§2.8 |
| ⑥ 领域格式 | 改 | 5 个主进程模型工具、1 组内部失败分类；无新共享错误码、策略规则和配置开关；见 §2.4 |

**量级：** 改既有 7 个单元，新建 5 个，复用 7 个；既有单元中改承重边界 3 处、改对外契约 0 行。新增 SQL 字段 0；新增持久化根属性 1（`coordination`，内含 8 个顶层键，嵌套协议见 §2.3）；新增模型工具 5 个；内部稳定失败分类 6 个；新增共享错误码/设置项 0。实施划分 3 个阶段。

达到拆分门槛，仍保留一份方案：问题提交、分派和恢复必须使用同一协作记录及任务代次，否则两个方案可能分别确认互不兼容的协议。按三阶段交付，不把各渠道实现或 Runtime 改造另立为平台项目；若 U-01 证明必须修改 SDK 或会话存储接口，则停止本方案的对应实现，另出专项设计。

### 1.5 验收边界与需求外扩

本次交付为技术文档，可本地核对事实、链接、协议一致性和需求覆盖。实现阶段可自动验证计时、计数、并发、恢复、去重和安全拒绝；真实渠道验收另有 U-03、U-04，不能用 mock 替代。

新增单元、协作记录、运行状态和内部工具分别落实需求 D-06、AC-02/07/10；保存它们是需求允许技术方案确定的机制。对用户的变化是任务可并行、询问可合并、重启后仍可继续；没有新增 UI、IPC 或设置项。唯一需要补充明确的外部处置是送达待核实，已列 T-02，未获确认前不算需求验收通过。

## 第 2 层：实施规格【机｜人工可跳过】

### 2.1 不变量

| ID | 不可违反的性质 | 验证锚点 |
|---|---|---|
| INV-01 | 仅 IM 接入；目标清楚直接分派；协调判断由 Skill 承担 | A-01、A-05、A-12 |
| INV-02 | 执行者没有用户发信/选择目的地能力；宿主绑定原渠道、身份和任务 | A-01、A-13 |
| INV-03 | 封批只由持久化时刻、项数和任务阻塞事实触发；事项只属于一个普通批次 | A-08、A-09 |
| INV-04 | 业务回答不产生安全授权；未回答、歧义和过期授权均不执行对应操作 | A-04、A-13 |
| INV-05 | 协作写入以 revision 比较及事务提交为准，原消息和审批真相不迁移 | A-02、A-10 |
| INV-06 | 一个助理会话单飞；执行者独立会话；派发键和执行代次阻止旧执行者覆盖新结果 | A-06、A-07、A-10 |
| INV-07 | 不增加 SDK/Runtime 协调状态；每个执行 turn 仍经过原接纳、安全与事实提交链 | A-12、A-13 |
| INV-08 | 完成依据为执行终态和结果引用，不能凭模型总结变更任务终态 | A-11、A-14 |

### 2.2 作用域、角色和唯一 writer

- 助理作用域是已认证的渠道、owner、原始会话和授权代次的组合；不因为同一个人使用两渠道就自动合并会话。
- 助理每次调用可以读取多个任务和多个事项。原有逐事件 wake 入口只登记到协调器并请求 drain，不让每条 wake 都直接启动助理模型。协调器从持久记录选择一组事项后启动一次助理 turn，避免原调度器的逐条 launch 语义扩散。
- 协作存储是协作 JSON 唯一 writer；协调器和工具只能调用它的带 revision 命令，不允许 `im_workflow_state_put` 绕过它修改协调器保留的 workflowId。给模型的角色注册表中移除该保留记录的通用写入口。
- 执行适配器通过会话公开创建/接纳端口获得独立执行会话、turnId 和冻结配置；授权主体来自原请求，执行会话 ID 不是授权凭据。任务与原请求的关联保留在协作记录及可信宿主上下文，不伪造一条“用户批准”历史。
- 每个执行者使用独立 sessionId 取得既有运行租约；助理保留原会话租约。全局执行额度不得耗尽助理处理容量：协调器接纳后台执行时保留一个既有全局槽位供协调处理，额度不足时明确排队，不无限启动模型。
- 来源事实写入者：执行适配器提交真实 running/blocked/terminal 事件；模型可以提交问题和建议，不能自行声明进程已停止或操作已执行。
- 安全审批唯一 writer 维持既有审批/permit 链；发送状态唯一 writer 为协调器的发送提交动作。恢复唯一入口为协调器启动扫描，渠道重连只触发同一入口，不另建恢复算法。

### 2.3 协作记录契约

在既有 `im_workflow_state` 中，使用保留 workflowId `im-assistant-coordination` 和 `version=1`。`data` 只新增根属性 `coordination`，其 8 个顶层键固定如下；这 8 个键是逻辑 JSON 协议，不是数据库列。

```ts
coordination: {
  formatVersion: 1,
  scope: { channel, ownerId, originSessionId, authorizationEpoch },
  tasks: Record<TaskId, Task>,
  items: Record<ItemId, Item>,
  batches: Record<BatchId, Batch>,
  dispatches: Record<DispatchKey, Dispatch>,
  replies: Record<ReplyId, Reply>,
  deliveries: Record<DeliveryId, Delivery>
}
```

所有记录 ID 由宿主生成；模型只能引用返回过且属于当前 scope 的 ID。缺省：集合为空、nullable 字段为 null，必填键缺失拒绝写入。未知 formatVersion 不启动执行，保留原文交给版本恢复；不得当空状态覆盖。

| 记录 | 固定字段（所有时间为毫秒） | 状态定义 |
|---|---|---|
| Task | taskId、instruction、dependsOn、taskRevision、executionSessionId、state、resultRef | queued/running/blocked/completed/failed/cancelled/uncertain；resultRef 初始 null |
| Item | itemId、taskId、taskRevision、sourceEventId、kind、payload、deadlineAt、state、batchId、answerRef | kind=progress/information/decision/result/failure；state=pending/answered/closed；引用初始 null |
| Batch | batchId、itemIds、openedAt、sealAt、priority、state、claim | priority=urgent/normal；state=collecting/sealed/claimed/waiting-user/closed；claim 初始 null，认领后为 ownerRunId/leaseUntil |
| Dispatch | dispatchKey、taskId、taskRevision、executionId、state、leaseUntil | queued/claimed/running/settled/uncertain；executionId、leaseUntil 初始 null |
| Reply | replyId、sourceMessageId、matches、state | matches 为 itemId/answer/evidence 三元组数组；state=proposed/committed；evidence 为用户原文片段，非授权凭据 |
| Delivery | deliveryId、batchIds、itemIds、text、state、platformReceipt | prepared/sending/sent/uncertain；platformReceipt 初始 null；text 为已经助理整理且冻结的正文 |

`payload` 是有界的业务问题/进度/结果材料，不承载可信权限字段；附件和长结果保存既有材料引用。`instruction`、`payload`、`text` 允许落协作库，不写入日志。每个数组/文本在工具入口校验长度并分页读取；具体容量沿用现有工具结果预算，不新增用户配置。不得以裁剪方式删除问题对象或影响；过长时分为多条关联消息，发送记录按分片派生稳定 ID。

保留记录状态更新、后续派发意图与发送意图放在同一工作流 JSON revision 内，由现有 `runInTransaction` 同步提交。异步模型调用、网络请求一律在事务外。后台扫描未终结记录保证恢复，不以已完成 wake 标志代替协作状态。

### 2.4 五个协作工具与失败语义

全部通过主进程工具注册表装配；认证 scope、角色、taskRevision、executionId 从可信调用上下文绑定，不接受模型覆写。

| 工具 | 角色 / 输入 | 输出和提交效果 |
|---|---|---|
| `im_coordination_read` | 助理：cursor；执行者：无参数 | 当前 scope 的任务/事项分页快照及 revision；执行者只见自己的任务与已回答事项 |
| `im_execution_dispatch` | 助理：instruction、dependsOn、expectedRevision | 宿主分配 taskId、dispatchKey；提交 queued 后立即返回，不等待执行完成；按当前调用工具身份去重 |
| `im_execution_report` | 执行者：kind、payload、deadlineAt、waitForAnswer | 持久化事项并返回 itemId；可在执行 turn 中调用，立即触发协调器调度检查 |
| `im_decision_apply` | 助理：逐项 itemId/answer/evidence、sourceMessageId、expectedRevision | 提交明确业务回答，返回已应用和仍待回答项；不接受 approve/permit/安全回执字段 |
| `im_assistant_publish` | 助理：text、itemIds、batchIds、expectedRevision | 冻结正文和发送意图，返回 deliveryId；成功入队与平台已送达分开报告 |

读取/报告/写意图不代表取得工具操作权限；既有工具安全链照常运行。宿主维护两类去重：工具重试使用 invocationId/toolCallId；助理 turn 重试使用其认领批次和已提交意图。模型不通过换一个自报 ID 来重复派发。

新增内部失败分类固定 6 个：`scope-mismatch`、`revision-conflict`、`stale-execution`、`invalid-transition`、`unsupported-format`、`delivery-uncertain`。它们是主进程工具结果分类，不新增 shared 错误码；用户文案由助理解释。冲突重读、不匹配拒绝、过期结果仅记录为过期不影响当前任务、格式不支持停止恢复、送达不确定按 T-02。

### 2.5 封批与助理调度算法

1. 执行事项先提交再返回。decision 项由执行者 Skill 按需求 D-04 分类；助理随后可查证并直接回答。安全审批不等待此分类完成。
2. 普通 decision 首项打开 collecting 批次，`openedAt=入库时刻`，`sealAt=openedAt+300000`。每个不同 itemId 计一项，重复上报不计；progress、information 不进入 5 项计数。
3. 每次入库及定时扫描均先封掉已到 sealAt 的批次，再加入新项；加入第 5 项立即封批。封批后 itemIds 冻结，后来事项开下一批。计时是宿主唤醒，不靠模型下一次调用或 setTimeout 单独维持。
4. 全体受阻判据：当前存在未终结任务，且无 running 或可接纳的 queued 任务，未终结任务的等待链均终止于未回答事项。达到则封掉普通收集批次；独立任务仍可推进时不提前封批。任务状态和依赖环校验由宿主保证，依赖选择由 Skill 负责。容量排队视为仍可继续，不冒充用户阻塞。
5. `deadlineAt-now<=300000` 的 decision，以及执行者报告“不及时回答会错过继续时机”的事项进入 urgent 单项封批，立即请求 drain。紧急性是协调调度提示，不产生安全授权；没有期限/理由的项按普通处理，助理可纠正后续优先级。
6. drain 顺序为 urgent → sealed normal → 可合并进度。一次助理 turn 可认领多个批次，normal 每批仍最多 5 项；已认领快照之后的新项留在 durable 队列，结束后再 drain。相同等级按 openedAt、batchId 排序。
7. 助理忙碌不取消模型、工具或已提交操作。首版安全交接点定义为当前助理 turn 结束、失败或既有 park 交回宿主之后；短助理 turn 通过立即返回的派发工具实现。执行者不等终态即可报告，协调器空闲即处理；无需扩展模型循环中断协议。
8. 没有用户决定的事实问题可立即唤醒助理处理，不启动普通决策窗口。助理先查已有事实，明确需要用户时保留为 decision；归并措辞由 Skill 完成，不写语义合并算法。
9. 应用关闭期间不发送；启动扫描已过 sealAt 的批次，重新封批并恢复 drain。时钟异常前跳只提前触发到期，后跳时按记录时刻保守等待；不将模型耗时计为窗口延长。计时边界用注入时钟测试。

### 2.6 执行与回答协议

**助理 Skill 固定职责：** 先读状态和未处理输入；目标明确即分派；查询只读取状态；事实优先查证；原目标内可逆细节自行选择；只把实质歧义和缺失用户信息交用户；一次处理多个事项；明确 waiting/partial/failed。删除现有“复杂任务统一先确认计划”规则，安全确认仍由既有链要求。

**执行 Skill 固定职责：** 读取任务和范围，完成范围内工作；不把普通实现细节交用户；通过报告工具上交问题、进度、结果。`waitForAnswer=true` 的报告使宿主记录 blocked；报告成功后本轮结束，不在内存中无限等待。回答提交后，以同 taskId/新 executionId 发起后续受控 turn，提供任务快照及回答引用，不重放已执行工具。安全挂起继续使用既有托管/异步审批接续机制。

后台执行适配器必须保留 IM 来源及原主体安全材料，不能伪装成 desktop 绕过远程策略。执行者注册表排除 IM 发送、会话切换、面向用户的进度推送和助理分派工具；除隐藏模型定义外，宿主实际 dispatch 注册表也必须无对应能力。普通专业工具继续按原许可执行，不递归创建执行者。

用户自然语言输入先由既有认证与入站处理接纳，Skill 读取仍未答项并输出逐项匹配。每个 match 必须引用真实 sourceMessageId 与原文 evidence，宿主校验来源归属、事项未关闭、taskRevision 当前有效。不能可靠匹配时不调用 apply，直接针对剩余项追问；部分提交不阻止其他任务。原文引用只能证明来源，不能机械证明模型语义正确，必须用评测覆盖误配风险。

**授权隔离：** `im_decision_apply` 永远不调用审批批准接口。确需用户安全授权的操作保留原审批 ID、对象、范围和有效期；助理可在同一沟通中解释多项，但每个实际批准仍经现有明确授权协议。自然语言的“按你说的做”不能由助理转成多个 permit。既有审批到期、撤销与重新校验独立运行，不被 5 分钟收集窗口延后。

助理提示词的固定执行顺序为“读取输入与状态 → 查已有事实 → 分派可推进任务 → 处理多项待办 → 提交明确回答或整理用户问题 → 发布必要说明”。执行提示词的固定顺序为“核对任务范围 → 执行 → 需要协调时报告 → 受阻则交回宿主 → 提交结果材料”。提示词要求使用工具返回值核对已提交事实，不要求输出固定用户回复格式。Skill 版本随应用发布，运行记录通过既有 invocation 材料追溯；不新增在线提示词编辑开关。

### 2.7 崩溃、并发与发送窗口

| 窗口/场景 | 恢复或唯一动作 | 验证 |
|---|---|---|
| 事项提交前退出 | 执行重试同一工具身份；无记录则重新提交 | 注入提交前失败 |
| 已提交事项但未触发 drain | 启动/定时扫描非终态记录 | 取消内存定时器后重启 |
| 助理认领后模型失败 | 租约到期释放批次；重试读取已提交派发和发送意图 | 模型超时及 CAS 冲突 |
| queued 派发重复消费 | dispatchKey 及任务代次认领只接受一个 executionId | 两 worker 竞争 |
| 接纳执行 turn 后、派发记账前退出 | 以稳定请求键查询既有 turn 事实；已接纳则挂接原执行，不再新建 | 接纳窗口故障注入；U-01 门禁 |
| 工具可能执行但结果未提交 | 沿既有 uncertain/恢复事实处理；协作层不自动重跑副作用 | 执行异常与未知结果注入 |
| 用户回答与计划修订并发 | CAS + taskRevision 拒绝旧回答，明确仍需用户处理部分 | 两事务交错 |
| prepared 发送前退出 | 可恢复发送，正文冻结且目的地从 scope 重新校验 | 发送前退出 |
| 标记 sending 后无平台确认 | 进入 uncertain；有平台幂等键/回执则查询或安全重试，否则不盲重发 | 平台已接收后本地提交失败 |
| 已记 sent 重启 | 不再次发送；重复 publish 返回同 deliveryId | 重复入站、重复 wake |
| 取消/授权撤销期间旧执行返回 | 先撤销原任务操作资格，再使代次失效；旧结果不唤醒新执行 | 取消、撤销、迟到结果 |

本地 exactly-once 意图提交不等于网络 exactly-once 送达。现有 `imLifecycleOutbox` 先 send 后记 delivered，不能直接作为 AC-10 的充分证据。本方案发送意图存在协作记录，实际发送复用渠道校验/适配；平台能力未验证前 T-02 是显式交付限制。

锁与事务顺序：先协作记录 CAS 提交，再认领执行会话/助理会话，再启动异步调用；不在 SQLite 事务内获取或等待会话租约。释放必须匹配当前 ownerRunId；重试前读最新代次。协调记录内一次更新同时保存处理结果与后续意图，不跨两套状态声称原子提交。

### 2.8 兼容、迁移与回滚

- 不把旧 workflow 样例的 `awaiting-confirmation` 自动解释为已批准。保留原 workflowId 和版本；新保留记录首次真实 IM 请求时创建，初始化使用 expectedRevision=null，重复初始化返回原记录。
- 无 SQL schema 迁移；JSON 格式为新增记录，不回写旧数据。严格解析版本；未来升级先读取旧版、事务生成新版，再记录升级成功，不跳过错误后标完成。
- 助理和执行会话继续通过原会话存储导出与备份；工作流记录不是 `sessions/` 明文备份的附带保证，需验证应用完整数据库备份/恢复能保留它。仅从 sessions 导入时不虚构已恢复协作任务。
- 回滚前停止新分派，等待已接纳执行安全退出或经任务控制取消；保存数据库备份并冻结非终态协作记录。旧版本只处理旧链路，不消费保留记录；未完成任务向用户如实报告。不得靠切回旧 Skill 自动重做已派发任务。
- 回滚实体为本方案文件改动、两渠道入口接线和新增协作记录；不删除既有审批、消息或结果。重新升级时先核对旧 executionId 与 turn 事实，再恢复队列。

### 2.9 安全阶段与旁路检查

本方案不新增风险裁决规则或不可配置系统约束，不借 INV 编号豁免策略审查。若实现发现新增系统约束，必须先登记 systemInvariantRegistry 并单独审查，不能由本文预授权。

| 阶段 | 调用位置及责任 | 边界验证 |
|---|---|---|
| facts | 执行报告只记录来源、任务与覆盖信息 | 伪造“已获批准”文本不产生许可 |
| policy | 既有工具策略继续裁决；不在助理中复制 | 原 rule ID 与 trace 保留 |
| final-check | 派发/恢复及发送前核验已绑定主体、任务代次与执行材料；不重算业务风险 | 失配时 dispatch/executor/send 未调用 |
| invariant | 沿用已有约束；本文无新登记项 | 实施跑 `npm run check:system-invariant-registry` |

旁路必须逐一核销：两渠道正常入站、忙碌入站、wake/replay、审批完成 continuation、超时失败通知、进度适配器、路由器最终摘要，以及执行工具内可发送 IM 的能力。AC-01 的“统一表达”覆盖普通进度和失败；身份拒绝、平台传输错误与原生安全审批保留确定性协议消息，不能等待助理模型才能安全拒绝。审批说明可由助理整理，授权材料仍由既有链生成。

### 2.10 验收映射与场景矩阵

A-* 为本方案拟实施测试场景，不表示已有测试通过。

| 场景 | 需求 AC | 不变量 | 可执行验证 |
|---|---|---|---|
| A-01 统一沟通 | 01 | 01、02 | 模型尝试执行者发信/选目的地；工具缺失且 dispatch 拒绝；两渠道仅助理出口产生正文 |
| A-02 多事项单次处理 | 02 | 05 | 一次助理调用读取并提交三个来源任务事项，不丢来源关联 |
| A-03 问题归并 | 03 | 04 | Skill 评测检查逐项对象/影响/选项；长消息分片不截断问题 |
| A-04 部分自然语言回答 | 04 | 04 | “第一个选便宜的，另一个再等等”等非编号表达；仅明确项应用，否定/引用/歧义不批准 |
| A-05 直接启动 | 05 | 01 | 明确目标立即分派；实质目标歧义才问；无统一计划确认 |
| A-06 并行 | 06 | 06 | 两执行者独立会话重叠运行，第三任务可登记，助理仍能处理 |
| A-07 运行中报告 | 07 | 06 | 执行者 A 报告后保持 turn 未结束，助理在 A 结束前读取并处理，B 不被停止 |
| A-08 普通封批 | 08 | 03 | 注入时钟覆盖 299999/300000ms、第 5/6 项、全体受阻/独立任务可运行 |
| A-09 忙碌紧急排队 | 09 | 03 | 助理工具未结束时不抢占；结束后 urgent 先于 normal，进度最后 |
| A-10 重启与去重 | 10 | 05、06 | §2.7 各崩溃窗口；重复/乱序事件；已派发不重复执行；发送不确定明确暴露而非虚报通过 |
| A-11 查询 | 11 | 08 | 已完成、等待用户、失败、未知结果均可对话查询，来源可追踪 |
| A-12 桌面隔离 | 12 | 01、07 | desktop 及未显式 Skill 的原调用装配回归；无协调器记录/工具泄露 |
| A-13 授权边界 | 13 | 02、04、07 | 跨 owner/渠道、过期 epoch、计划修订、伪造答案、撤销均不调用 executor |
| A-14 状态真实 | 14 | 08 | 部分成功、模型幻称完成、执行结果未知；业务终态不被文字覆盖 |

另须一条随机操作序列不变量测试：随机报告、封批、认领、回答、修订、取消、重复消费和重启，逐步断言事项不跨 scope、普通事项不跨批、当前任务至多一个有效 executionId、旧代次不能更新当前任务、sent 不回到 prepared。记录随机种子以复现。

语义评测使用固定中文样本集、冻结模型/Skill 版本，保存去敏后的判定结果而非生产消息正文；模型测试和宿主确定性测试分开报告。正常、并发、超时、取消、重启、重复、乱序、部分失败和旧数据场景均见上表及 §2.7/2.8，不以 happy-path 代替恢复验证。

### 2.11 实施阶段与出口

本节定义交付边界，不替代独立执行计划；本轮仅完成方案文档。

| 阶段 | 输入 → 输出 | 出口证据 / 回退实体 |
|---|---|---|
| P1 角色与执行接缝验证 | 当前 IM 链 → 隔离助理/执行者、异步报告原型 | A-01/05/06/07/12/13；U-01/02 必须通过；回退角色材料与原型接线，不向真实用户启用 |
| P2 协作存储和调度 | P1、T-01 获批 → 批次、回答、恢复完整宿主链 | A-02/04/08/09/10/11/14 和随机不变量测试；回退入口并冻结新记录，恢复步骤见 §2.8 |
| P3 Skill 与双渠道验收 | P2、T-02 处置确认 → 飞书/微信真实闭环 | A-03 与固定样本集、真实平台故障窗口、审批回归；不能核验项逐条保留，不报全量通过；回退双渠道入口及 Skill 版本 |

开发中只合并运行定向测试；每阶段最多一次增量构建。阶段收尾及最终验收按仓库规则运行全量测试，提交阶段成果；涉及安全时补对应边界测试与 invariant registry 门禁。agent-sdk、会话存储、共享类型门禁使用 §1.4 的真实脚本名；本文未执行功能测试，未改生产代码。

## 附录：事实、未验证项与一致性核对【机｜人工可跳过】

### F：代码事实卡

核查基线均为 `596104f9`，日期 2026-11-03；命令可在仓库根目录复现。

| ID | 已核对事实 | 复现命令 |
|---|---|---|
| F-01 | 两渠道 wrapper 均调用共享远程 Agent | `rg -n 'runImRemoteAgent' electron/feishu/feishuRemoteAgent.ts electron/wechat/weChatRemoteAgent.ts` |
| F-02 | 共享入口装配 IM 编排工具和托管确认；不等于已有后台助理 | `rg -n 'createImOrchestrationToolRegistry|createHostedTurnHandoff|assembleInvocation' electron/remote/imRemoteAgent.ts` |
| F-03 | 内置 Skill 现要求复杂任务先确认；与本需求 D-01 不一致 | `cat electron/skills/bundled/imTaskOrchestrationSkill.ts` |
| F-04 | 装配器向 IM 强制注入内置 Skill，过滤同名显式片段 | `sed -n '485,493p' electron/runtime/invocationAssembler.ts` |
| F-05 | workflowState 已有版本、revision、JSON 与事务封装 | `cat electron/database/workflowState.ts` |
| F-06 | wake 调度器循环逐 eventId launch，不能据此声称批处理已具备 | `rg -n 'for \(const eventId|launchLoop|tryClaimRemoteSession' electron/remote/wakeEventDispatcher.ts` |
| F-07 | 会话租约按 originSessionId 单飞，并有全局上限 | `cat electron/remote/remoteAgentRegistry.ts` |
| F-08 | outbox 在 send 后才记 delivered，存在回执窗口 | `cat electron/remote/imLifecycleOutbox.ts` |
| F-09 | workflow harness 的 plan 写 awaiting-confirmation，不宜直接作为生产协调器 | `rg -n 'awaiting-confirmation|decision.kind' electron/remote/imWorkflowSkillHarness.ts` |

现有 CLI 子 Agent 设计文档不是本方案可直接复用的已实现能力证据，本方案不依赖它。另一个在途 runtime trigger 方案也不是本期前置依赖；本期唤醒只在 IM 协调器内处理，不扩张为统一触发平台。

### U：实施前与外部验收门禁

| ID | 未验证项 | 责任 / 通过条件 |
|---|---|---|
| U-01 | 原接纳/任务控制链能否支持独立执行会话与原授权主体 | 实现者 P1 做集成验证：稳定请求键查询、两会话并行、取消级联、旧审批不扩权；不通过则重设计，不直接改 SDK |
| U-02 | 执行者提示词、工具、进度及审批接续是否能完整隔离 | 实现者 P1 测试全部出站旁路和原托管恢复；不通过不进入 P2 |
| U-03 | 双渠道发送幂等/回执查询能力 | 渠道集成负责人 P3 在真实平台验证已接收未记账窗口；负责人确认 T-02 处置；严格 AC-10 未证明前保留缺口 |
| U-04 | 模型语义和实际 IM 体验 | 实现者跑固定评测，用户在真实微信/飞书验收简短回复、合并问题、等待/部分失败表达及重启恢复 |

### 人层与机层一致性

- 软能力分工 → INV-01/04、A-03/04/05；当前是设计承诺，证据出口为 Skill 评测与集成测试。
- 并行与运行中协调 → INV-06、A-06/07、U-01；不宣称当前已支持。
- 批次与恢复 → INV-03/05、A-08/09/10；平台不确定窗口由 T-02/U-03 单独披露。
- 数量核对：7 改造单元、5 新建单元、7 复用单元；3 承重边界；1 持久化根属性/8 内键；5 工具/6 内部失败分类；0 新 SQL 字段/共享错误码/配置；3 阶段/4 未验证项，与 §1.3/1.4 对齐。
- 业务词对应：助理=IM assistant invocation；执行者=execution invocation；待处理事项=Item；决策批次=Batch；协作记录=coordination；送达待核实=Delivery.uncertain。协作记录不代表审批授权。
