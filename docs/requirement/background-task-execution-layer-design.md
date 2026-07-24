# 后台执行层设计文档

> 状态：讨论中（阶段小结 v14，2026-07-20 — 固化计划确认边界并收敛代码评审范围）
> 最后更新：2025-03-17（v3 基线）；2026-07-20（v4–v13）；2026-07-20（v14：宿主确认授权 + 文档型 ReviewLoop）

---

## 1. 概述

为 SpaceAssistant 新增一个**通用的后台任务执行层**，使用户可以提交一个需要长时间、多阶段执行的任务，在后台自动推进，用户无需持续关注。任务完成后，结果投递回发起会话。

与当前「前台同步」的 `runToolChatSession` 模型不同，后台执行层支持：任务规划的自动生成、多阶段依赖编排、独立会话上下文的并发 Task 执行、以及托管模式下的最小打扰原则。

### 1.1 三个典型场景（设计试金石）

| 场景 | 结构特征 | 执行时长 | 关键需求 |
|---|---|---|---|
| **软件开发** | 多阶段串行（需求→设计→编码→Review），阶段内可并行，关键交付物有动态评审循环 | 数小时~数天 | 一句话生成完整工作流、评审闭环、断点续传、Task 间文件引用 |
| **PDF 导入** | 单阶段、大量重复 Task（每页 OCR），线性可预测 | 数分钟~数十分钟 | 批量并发 + 限流、质量门 |
| **调研汇总** | 扇出→扇入（N 个子课题并发调研 → 汇总报告） | 数十分钟 | 子任务并发、结果汇总 |

软件开发仍是完整产品的核心试金石，但 MVP 对其做明确分层：自动生成并执行“需求评审→方案评审→详细开发方案评审→多文件实现→实现报告”主链；多文件代码的**版本化评审与接受**暂不宣称支持，必须等待 Phase 2+ 的不可变 CodeChangeSet/ArtifactBundle。核心场景用于牵引目标架构，不等于允许用不可靠的版本边界伪造 MVP 能力。

### 1.2 与历史决策的关联

SpaceAssistant 此前有过两次与「后台/自动执行」相关的尝试，均以移除告终。本设计不是在真空中提出的，需要正面回应这两次失败，说明为什么这次不同。

#### 1.2.1 前序决策回顾

**第一次：Plan 模式（2026-05-30 移除）**

Plan 模式（`electron/plan/`）引入了一套独立的子系统：Coordinator + Worker 双编排器、8 个 plan invoke IPC + 4 个 plan 事件、两阶段权限切换、审批闸门、独立设置 Tab。移除原因：

| 旧 Plan 模式的失败原因 | 细节 |
|---|---|
| 独立子系统 | 完整的 `electron/plan/` 目录 + Plan 组件群，与普通模式走不同代码路径 |
| 维护成本高 | 双路径编排（Coordinator vs 普通 Agent 循环）、Plan 专用 ACL、渠道分叉（桌面 Plan / 飞书远程 Plan / 普通模式三套行为） |
| 用户认知负担 | 模式选择器、审批闸门、步间「继续执行」——Plan 模式比普通模式更费神 |
| 判断被替代 | 核心结论：「普通模式 + Skills + 工具确认卡」已能覆盖"先规划再执行"的需求，不需要内置状态机 |

**第二次：Shell 后台任务（2026-05-31 移除）**

`run_shell` 工具实现了 `backgroundShellRegistry` 单例 + `run_in_background` 参数 + 自动转后台（15 秒阈值），在实现后立即被移除。移除原因：

| 旧 Shell 后台的失败原因 | 细节 |
|---|---|
| 前端 UI 从未落地 | 后端完整，渲染进程零展示，用户完全感知不到后台任务存在 |
| 代码复杂度高 | 增加 `runShellExecutor` 约 30% 的代码复杂度，最终净删除 ~230 行 |
| 没有真正解耦 Agent 循环 | 自动转后台只是把进程放后台，Agent 仍然要等进程结束才拿到 `ToolResult`，并未释放会话 |
| 生命周期不可控 | 注册到后台的进程即使 Agent 循环结束也继续运行，无自动清理 |
| 生态位被替代 | 核心结论：用户更倾向于调大 `timeout`，而非依赖无 UI 的后台机制 |

#### 1.2.2 本设计如何规避同样的失败

与 Plan 模式的对比——「不是独立子系统，是现有系统的扩展层」：

| 维度 | 旧 Plan 模式 | 本设计 |
|------|------------|--------|
| 执行路径 | Coordinator + Worker **双编排器**（独立于普通 Agent 循环） | 单调度器 → 多 Runner，每个 Task **复用 `runToolChatSession`**（或 Codex CLI） |
| 权限模型 | 独立 ACL 层（IPC 权限拦截） | 三层边界：工作目录（已有）+ Task 级授权范围（新增）+ 资源上限（新增），不新建独立权限系统 |
| IPC 通信 | 8 个 plan invoke IPC + 4 个 plan 事件 | 走现有 `toolChatLoop` IPC 通道（每 Task 独立 Session 天然隔离），仅少量新事件（`TaskProgressBus`） |
| UI 位置 | PlanPanel 侧栏（嵌入聊天视图内，与消息列表争空间） | 独立任务面板（Activity Bar 新图标，与聊天**并列**，不嵌入） |
| 设置 | 独立设置 Tab | 不新增设置 Tab（TaskAgentConfig 内嵌在 Task 级别配置） |
| 代码组织 | 独立 `electron/plan/` 目录 | 调度器落在 `electron/tools/` 内，UI 复用 `src/renderer/services/` 的 `chatRunnerService` 模型 |

与 Shell 后台的对比——「解耦是在 Agent 循环外面，不是里面」：

| 维度 | 旧 Shell 后台 | 本设计 |
|------|-------------|--------|
| 解耦方式 | 同一个 Agent 循环内标记 `run_in_background` — Agent 仍需同步等待 `ToolResult` | 调度器在 Agent 循环**外面**启动新的 Agent 循环（独立 Session），用户会话立即释放 |
| 用户感知 | **零 UI**，后台任务对用户透明 | 独立任务面板是**顶层需求**（§6），不是 Phase 2 |
| 生命周期 | 进程注册后脱离管控，无清理 | 调度器全程管理 Task 生命周期，资源上限兜底 |
| 能力范围 | 单 Shell 命令 | MVP 为受控文件工具 + 推理 + 浏览器；Shell / `run_script` 待真实沙箱后加入 |

#### 1.2.3 复杂度控制策略

| 策略 | 说明 |
|------|------|
| **复用 > 新建** | Agent 循环复用 `runToolChatSession`，产物追踪复用 `ArtifactRepository`，文件冲突复用 `toolWriteConflict.ts`，跨会话确认复用 `PendingConfirmBanner` |
| **单路径调度** | 所有 Task 走同一条路径（TaskDispatchService → TaskRunner），不区分"桌面路径"和"远程路径" |
| **UI 不可砍** | 独立任务面板作为 MVP 硬性交付项。如果任务面板未就绪，`TaskDispatchService` 虽然可以跑，但用户完全看不到进度——这是 Shell 后台的教训 |
| **MVP 区分** | 最简可交付集：目标到 Task DAG 的自动生成 + TaskPlan/Task 数据模型 + 内置后端调度 + 任务面板。Stage 运行时、独立 PlannerRunner、Codex 后端、IM 远程指令可在后续迭代中加入（详见 §1.2.4） |

#### 1.2.4 MVP 范围建议

**MVP 必须有的（不可砍）：**

| 项 | 说明 |
|---|------|
| WorkflowCompiler + 原子创建协议 | 用户只需描述目标；前台现有 Agent 生成 `TaskPlanDraft`，宿主 prepare 校验并预览，用户确认后原子物化完整 Task DAG。不得要求用户逐 Task 创建或手工连边 |
| TaskPlan → Task 数据模型 | MVP 不引入 Stage 运行时；Task 可带无调度语义的 `phaseKey/phaseName/phaseOrder` 供计划预览和任务面板分组 |
| TaskDispatchService + SlotManager | 直接按 Task DAG 调度；“阶段间串行”编译为跨 phase 的 Task 依赖边，阶段内并行编译为共享前置依赖 |
| ReviewLoop Task | 稳定外部依赖节点，内部按“产出→评审”动态展开，有限迭代直到 pass/上限 |
| builtin 后端 | 复用 `runToolChatSession` 核心逻辑，通过兼容 EventTarget 和独立 DecisionResolver 支持无窗口执行（§2.4.1）；MVP 后台工具集不含 Shell / `run_script` |
| 独立任务面板 | 至少 Task 列表 + Task 详情（只读对话时间线） |
| 结果投递回发起会话 | 完成/失败时在原会话插入系统消息 |
| 资源上限（防失控） | §8.4 |
| Task.output 耐崩溃发布 | 先由宿主安全固化 blob，再在同一数据库事务发布 summary、revision、deliverable、relation 和终态；崩溃时下游只看到完整产出，孤儿 blob 可 GC |
| 内部 Session 生命周期管理 | Session 标记（`visibility` 字段）/ 关联 / 清理（§2.3） |

**可以延后的（Phase 2+）：**

| 项 | 说明 |
|---|------|
| Stage 运行时 | 阶段自身的状态机、阶段级暂停/重跑、通用条件分支和非交付物型 reviewGate；MVP 的 phase 仅为展示元数据，调度只认 Task DAG |
| 独立 PlannerRunner | MVP 复用发起会话中的现有 Agent 生成结构化草案，不新增后台 Planner Runner、Planner Session 或第二套编排器 |
| Codex 后端 | 先用 builtin 验证调度模型，Codex 作为能力升级 |
| 多文件代码 ReviewLoop | 需要不可变 `CodeChangeSet/ArtifactBundle`、固定 base、文件增删改/重命名清单以及受控 apply/merge 协议；MVP 不以可变工作树或路径 manifest 冒充版本边界 |
| IM 远程指令 | `/进度`、`/通过` 等 |
| 崩溃恢复 / 断点续传 | 已完成 Task 的版本化交付物不丢失，未完成 Task 需重跑 |

> **按这个 MVP 范围，新设计的产品闭环是「描述目标 → 自动生成并预览工作流 → 一次确认 → 后台执行 → 结果投递」。** Stage 不作为运行时实体，但其串并行关系已经编译进 Task DAG，交付物评审门已经编译为 ReviewLoop。它不新增 Planner 编排器或步间审批状态机，有独立 UI，并复用现有 Agent 循环。

---

## 2. 核心机制

### 2.1 数据模型：目标三层结构与 MVP 投影

完整目标模型保留 Stage，但 **MVP 的持久化和调度投影只有 `TaskPlan → Task[]`**：不创建 Stage 记录、不运行 Stage 状态机。下图中的 Stage 属于 Phase 2+；MVP 由 WorkflowCompiler 把阶段串并行关系直接展开为 Task 依赖边，并把阶段名称降为 Task 的展示元数据。

```
TaskPlan（任务计划）
  ├─ id, sessionId（发起会话）, name, goal（需求简述）
  ├─ status: clarifying | planned | running | cancelling | paused | completed | failed | cancelled
  ├─ interactionMode: 'interactive' | 'supervised' | 'dedicated'
  ├─ tasks: Task[]                ← MVP 直接持久化和调度
  └─ stages?: Stage[]             ← Phase 2+ 运行时实体

Stage（阶段）
  ├─ id, name, type（sequential | parallel | conditional）
  ├─ status: pending | running | blocked | completed | skipped
  ├─ dependsOn: Stage.id[]   ← 前置阶段
  ├─ reviewGate?: {
  │     reviewer: 'user' | 'llm' | 'subagent',   // llm=执行Agent自评审，subagent=独立Agent交叉评审
  │     criteria: string,                         // 评审通过标准（自然语言描述）
  │     onReject: 'retry_stage' | 'rollback_prev' | 'pause'  // 不通过时：重试当前阶段 / 回退到上一阶段 / 暂停等用户
  │   }
  └─ tasks: Task[]

Task（任务，执行的基本调度单位）
  ├─ id, name, status: pending | queued | running | confirming | cancelling | completed | failed | cancelled | skipped
  ├─ kind: agent | review_loop
  ├─ dependsOn: Task.id[]       ← 基于稳定 ID 的显式调度边
  ├─ phaseKey?, phaseName?, phaseOrder?  ← MVP 仅用于预览/UI 分组，无就绪或状态语义
  ├─ agentType: 'builtin'（MVP）；'codex' | 'codex-required' | 'planner' | 'user'（Phase 2+）
  ├─ agentConfig?: { model?, thinkingLevel?, maxTokens?, toolAllowlist? }
  ├─ instruction: 给 Agent 的系统指令（含文件路径、技术参数等精确信息）
  ├─ description?: 给用户看的高层级任务描述（可选，未填时取 instruction 摘要）
  ├─ inputs?: TaskInputSpec[]     ← 声明消费哪些上游命名交付物
  ├─ outputContract: TaskOutputSpec[] ← 声明必须/可选交付物
  ├─ output?: TaskOutput          ← 结构化交付物，使用稳定 key / artifactId / revisionId
  ├─ sessionId?: 执行时创建的内部对话上下文 ID
  ├─ generation: number         ← 当前有效执行代次，创建时为 1
  ├─ currentAttemptId?: TaskAttempt.id
  ├─ retryPolicy: { maxRetries, backoffMs }
  ├─ reviewLoopConfig?: ReviewLoopConfig（kind=review_loop 时必填）
  ├─ parentReviewLoopTaskId?: Task.id（动态迭代子 Task）
  ├─ parentReviewLoopRunId?: ReviewLoopRun.id
  ├─ parentReviewLoopGeneration?: number
  ├─ reviewIteration?: number
  └─ retryCount

ReviewLoopConfig（动态“产出→评审→修订”控制器）
  ├─ initialProducerTemplate: TaskTemplate
  ├─ revisionProducerTemplate: TaskTemplate
  ├─ reviewerTemplate: TaskTemplate
  ├─ seedInputs: TaskInputSpec[]
  ├─ acceptedOutputKey: string
  ├─ maxIterations: number
  ├─ onExhausted: pause | fail
  └─ approvalPolicy: structured_verdict

TaskTemplate（每轮实例化模板，不直接入队）
  ├─ namePattern, instructionTemplate, description?
  ├─ agentType, agentConfig?, authorizationScope?
  ├─ inputs: TemplateInputSpec[]
  └─ outputContract: TaskOutputSpec[]

TemplateInputSpec（模板输入来源）
  ├─ name, required: true
  └─ source:
       seed:<seedInputName> |
       current_producer:<deliverableKey> |
       previous_producer:<deliverableKey> |
       previous_review:<deliverableKey>

ReviewLoopRun（ReviewLoop 的一次运行，持久化到 review_loop_runs 表）
  ├─ id, reviewLoopTaskId, reviewLoopGeneration
  ├─ status: running | passed | exhausted | failed | cancelled | superseded
  ├─ currentIteration: number
  └─ startedAt / completedAt?

ReviewIteration（持久化到 review_iterations 表）
  ├─ id, reviewLoopTaskId, reviewLoopRunId, reviewLoopGeneration
  ├─ iteration: number
  ├─ producerTaskId, reviewerTaskId
  ├─ status: producing | reviewing | acceptance_pending | passed | revision_requested | failed | cancelled | superseded
  ├─ producedArtifactId?, producedRevisionId?
  ├─ reviewArtifactId?, reviewRevisionId?
  ├─ verdict?: pass | revise
  └─ createdAt / completedAt?

TaskAttempt（一次执行尝试，持久化到 task_attempts 表）
  ├─ id, taskId, generation, attemptNo
  ├─ status: queued | running | confirming | cancelling | completed | failed | cancelled | superseded
  ├─ invalidatedAt? / invalidationReason?: rerun | plan_cancel
  ├─ cancelRequestedAt? / startedAt / finishedAt? / resourcesReleasedAt?
  └─ error? / outputSnapshot?

TaskOutput（一次有效 generation 的结构化输出）
  ├─ summary: string
  └─ deliverables: TaskDeliverable[]

TaskInputSpec / TaskOutputSpec（计划期合同）
  ├─ Input: { name, fromTaskId, deliverableKey, required: true }（MVP）
  └─ Output: {
       key, kind, documentType?, required,
       artifactPolicy: 'create' | 'revise_input' | 'alias_review_acceptance',
       reviseInputName?,
       allowedRelations?: { type, targetInputName }[]
     }

TaskDeliverable（下游可消费的交付物）
  ├─ key: string                 ← Task 内稳定业务名，如 design / review
  ├─ kind: document | code | data | media | other
  ├─ artifactId: Artifact.id     ← 稳定身份，不以路径或数组下标代替
  ├─ revisionId: ArtifactRevision.id ← 本次交付的不可变版本
  ├─ title, workingPathSnapshot?, mediaType?
  ├─ documentType?: requirement | design | review | report | other
  ├─ stage?: draft | final
  ├─ status: current | superseded
  ├─ producedBy: { taskId, attemptId, generation } ← 始终保留真实内容生产者
  └─ publishedByReviewLoop?: {
       reviewLoopTaskId, reviewLoopRunId, reviewLoopGeneration,
       iterationId, publicationId
     }

TaskInputBinding（Runner 实际消费的交付物快照）
  ├─ id, taskId, generation, name
  ├─ fromTaskId, deliverableKey
  └─ artifactId, revisionId

ArtifactRevision（Artifact 的不可变内容版本）
  ├─ id, artifactId, contentHash, byteSize
  ├─ contentLocator             ← 仅宿主可见的内容寻址位置，不进入 Agent/UI API
  ├─ canonicalPathSnapshot      ← 交付时用户工作路径，仅用于展示/溯源
  ├─ createdByTaskId, createdByAttemptId, generation
  └─ createdAt

ArtifactRelation（文档/产物血缘）
  ├─ sourceArtifactId, sourceRevisionId
  ├─ type: reviews | revises | derived_from | supersedes
  └─ targetArtifactId, targetRevisionId

AttemptArtifactWrite（当前 attempt 可提交的 Artifact 写入账本）
  ├─ attemptId, generation, artifactId, writeEventId
  ├─ workingPath, contentHash, byteSize
  └─ succeededAt

TaskOutputSubmission（结构化交付提交操作）
  ├─ id, taskId, attemptId, generation, envelopeHash
  ├─ status: staging | published | failed
  ├─ stagingBlobIds[] / error?
  └─ createdAt / publishedAt?

ReviewDecision（reviewer Task 提交时的结构化裁定）
  ├─ id, reviewLoopTaskId, reviewLoopRunId, reviewLoopGeneration, iteration
  ├─ verdict: pass | revise
  ├─ targetInputName: string
  ├─ targetArtifactId, targetRevisionId
  ├─ reviewDeliverableKey: string
  └─ summary / requiredChanges?: string[]

ReviewAcceptancePublication（父节点 accepted alias 发布记录）
  ├─ id, reviewLoopTaskId, reviewLoopRunId, reviewLoopGeneration
  ├─ iterationId, acceptedArtifactId, acceptedRevisionId
  ├─ trigger: verdict | manual_override
  ├─ reviewDecisionId? / overrideAuditId?
  ├─ status: published
  └─ createdAt

ReviewOverrideAudit（人工接受审计，持久化到 review_override_audits 表）
  ├─ id, reviewLoopTaskId, reviewLoopRunId, reviewLoopGeneration, iterationId
  ├─ actorId, reason, acceptedArtifactId, acceptedRevisionId
  ├─ status: pending | consumed | stale
  └─ createdAt / consumedAt?

PreparedTaskPlan（待确认计划快照，持久化到 prepared_task_plans 表）
  ├─ id, schemaVersion, normalizedDraft, draftHash
  ├─ originSessionId, actorId, originSurfaceId
  ├─ workDirIdentity, interactionMode, executionScopeSnapshot, executionScopeHash
  ├─ status: prepared | consumed | expired | revoked
  └─ createdAt, expiresAt, consumedAt? / revokeReason?

TaskPlanConfirmation（一次性创建授权，持久化到 task_plan_confirmations 表）
  ├─ id, preparedDraftId, draftHash
  ├─ actorId, originSessionId, originSurfaceId, executionScopeHash
  ├─ idempotencyKey, status: pending | consumed
  ├─ confirmedAt, consumedAt?, taskPlanId?
  └─ UNIQUE(preparedDraftId), UNIQUE(actorId, originSessionId, idempotencyKey)

TaskDrainOperation（失效与资源回收屏障，持久化到 task_drain_operations 表）
  ├─ id, taskPlanId, type: rerun | plan_cancel
  ├─ status: draining | timed_out | completed
  ├─ targetTaskIds: Task.id[] / expectedAttemptIds: TaskAttempt.id[]
  ├─ requestedAt / timeoutAt / completedAt?
  └─ errorCode?

Step（步骤，工具调用日志粒度，持久化到 task_steps 表）
  ├─ id, taskId, attemptId, generation, eventId, status
  ├─ result / error
  └─ startedAt / completedAt
```

#### 2.1.1 MVP WorkflowCompiler：从目标到可执行 DAG

MVP 把“生成草案”和“授权创建”拆成不同能力：`prepare_task_plan(draft)` 可以注册为发起会话 Agent 的宿主工具；`create_task_plan(...)` 是宿主内部服务，**不得注册为 Agent 工具、不得暴露为通用 Renderer IPC，也不得接受 Agent 文本中的“已确认”作为授权**。确认 UI 只能调用专用 `confirm-prepared-task-plan` IPC，由主进程根据可信 sender 上下文进入内部创建事务。

```ts
interface TaskPlanDraft {
  name: string
  goal: string
  phases: Array<{
    key: string
    name: string
    order: number
    tasks: Array<AgentTaskDraft | ReviewLoopTaskDraft>
  }>
}
```

prepare 不信任草案携带执行作用域。主进程必须从工具调用上下文派生并持久化 `PreparedTaskPlan`：

- 规范化后的 draft、`schemaVersion`、`draftHash`、`createdAt/expiresAt`；
- `originSessionId`、本地 `actorId` 和发起 `webContentsId`（或等价可信 surface identity）；
- 规范化 workDir identity（至少 realpath，平台可用时包含 device/inode）及其安全配置版本；
- `interactionMode`、逐 Task 的最终 `TaskAuthorizationScope`、工具 allowlist、资源上限及其整体 `executionScopeHash`。

`draftHash` 必须覆盖规范化 draft 与上述不可变 origin/execution scope 快照，而不只覆盖 Task JSON。草案中的 Task 使用计划内唯一 `draftKey` 相互引用；prepare 执行 §2.2.1 的 DAG、合同及 ReviewLoop 校验，保存短期只读快照并返回预览，但不创建 TaskPlan。调用方不能在确认时重传或扩大 workDir、权限、interactionMode、工具集和资源上限。

用户在原预览界面点击确认时，专用 IPC 只提交 `preparedDraftId + expectedHash + idempotencyKey`。主进程向窗口发送预览时还要在 `PendingPlanPreviewRegistry`（或等价宿主状态）登记 `(webContentsId, originSessionId, preparedDraftId, draftHash)`；会话切换、窗口销毁或新预览替换旧预览时立即撤销该绑定。确认处理器从 IPC sender 和主进程会话归属状态派生 actor/session/surface，不信任 Renderer 传入这些身份，并在**一个数据库事务**中：

1. 锁定 PreparedTaskPlan，校验未过期、未撤销、hash 匹配，且 sender 的 actor/origin session/surface 与快照及当前 PendingPlanPreviewRegistry 绑定全部一致。
2. 重新计算 workDir identity、安全配置版本和 `executionScopeHash`；任一变化都使草案失效，必须重新 prepare/预览，禁止静默缩权后执行或按旧授权扩权。
3. 创建一次性 `TaskPlanConfirmation`，绑定 preparedDraftId、draftHash、actor、originSession、surface、executionScopeHash、确认时间和 idempotencyKey；数据库约束保证每个 prepared draft 只能确认一次。
4. 内部 `create_task_plan(confirmationId)` 立即校验并消费该确认记录，分配稳定 Task ID，把 `dependsOnDraftKeys` 和 input 来源改写为 ID，创建 TaskPlan/全部 Task及根节点调度状态（agent 根节点创建 queued attempt；review_loop 根节点由 Controller 接管且不创建 attempt），并把 confirmation 标为 consumed。任一步失败则整笔回滚，不留下“已确认但未创建”或半份计划。

幂等键的唯一作用域为 `(actorId, originSessionId, idempotencyKey)`，并强绑定 `(preparedDraftId, draftHash)`：同 key 同请求返回原 TaskPlan；同 key 换草案或 hash 必须 `idempotency_conflict`。已成功消费的确认再次提交只能按该绑定返回原 TaskPlan，不能创建第二份；其他 actor、Session、窗口或过期页面的重放一律拒绝。窗口销毁、Session 归属变化、workDir/授权/安全配置变化会主动撤销尚未消费的 prepared draft。

创建交互固定为：用户描述目标 → 当前 Agent 必要时澄清 → 生成完整草案 → UI 展示阶段分组、依赖和交付物/评审循环 → 用户一次确认（或用自然语言要求调整后重新生成）→ 原子创建并启动。高级用户可以编辑 Task，但“逐个创建 Task、手工画 DAG 边”不得成为核心路径或完成软件开发场景的前置操作。

软件开发模板至少应能生成以下骨架，具体任务数量可由 Agent 按目标裁剪：

```text
目标
  → 需求 ReviewLoop
  → 技术方案 ReviewLoop
  → 详细开发方案 ReviewLoop
  → 实现 Task（可按模块并行拆分）
  → 实现汇总/报告 Task
  → 完成/汇总 Task
```

这里的每个箭头都会物化为稳定 Task ID 的 `dependsOn`，并通过 input/output contract 绑定上一步最终接受的 revision。MVP 的 ReviewLoop 只承诺可被单 Artifact revision 精确绑定的文档型交付物：需求、技术方案和详细开发方案。实现 Task 可以修改多个代码文件并交付逐文件产物及实现报告，但不得把路径列表、当前 git diff 或可变工作树包装成一个“已评审代码 revision”，也不得宣称存在版本化代码评审门。多文件代码 ReviewLoop 在 Phase 2+ 的不可变 CodeChangeSet 及受控 apply/merge 协议落地后再启用。

### 2.2 关键数据决策

| # | 决策 | 说明 |
|---|---|---|
| TaskPlan:Session | **1:N** | 每个 Task 拥有独立的内部 Session，不污染发起会话上下文 |
| 计划创建 | **Agent prepare + host-only confirm/create** | Agent 只能生成草案；宿主把 origin/workDir/授权纳入 hash，专用 UI 确认事务创建并消费一次性授权后才原子创建 DAG |
| MVP phase | **仅展示元数据** | `phaseKey/phaseName/phaseOrder` 不参与就绪判定；串并行和评审分别由 `dependsOn` 与 ReviewLoop 承担 |
| tasks.instruction | **给 Agent 的系统指令** | 含文件路径引用和精确技术参数；`tasks.description` 给用户看高层描述，两者独立 |
| tasks.dependsOn | **显式调度依赖** | 基于稳定 `Task.id` 的边；展示顺序、input binding 和血缘关系都不能替代依赖边 |
| tasks.output | **逻辑读取模型** | `{ summary, deliverables[] }`；summary 存于 tasks，deliverables 以 `task_deliverables` 为唯一事实源，读取时组装，避免 JSON 与关系表双写漂移 |
| 持久化 | 18 张新表 | 原 6 张表，在既有任务/attempt/step/drain 表外增加 `prepared_task_plans` / `task_plan_confirmations` / `review_loop_runs` / `review_iterations` / `review_acceptance_publications` / `review_override_audits` / `task_deliverables` / `task_input_bindings` / `artifact_revisions` / `artifact_relations` / `attempt_artifact_writes` / `task_output_submissions`；各创建/发布路径均有作用域化幂等键 |
| 任务间数据传递 | 输入绑定 + 只读读取工具 | 调度器在入队事务中把声明式 input 固化为 `TaskInputBinding`；Runner 通过 `read_task_input(name)` 读取绑定 revision，不向 Agent 暴露 revision store 路径 |
| 文档血缘 | 显式关系 | 评审、修订、派生和替代关系指向 artifact 的具体 revision，例如评审意见 `reviews(design@rev-1)` |

#### 2.2.1 Task DAG 校验与就绪条件（MVP）

TaskPlan 创建或更新必须在一个事务内完成以下校验，任一失败则整份变更不落库：

- `Task.id` 在 TaskPlan 内唯一；每个 `dependsOn` 引用存在、属于同一 TaskPlan，且不能指向自身。
- 对显式依赖边执行 DAG 环检测；有环时拒绝创建/更新，并返回包含相关 Task ID 的可诊断错误。
- 每个 `TaskInputSpec.fromTaskId` 已列入 `dependsOn`，且 `deliverableKey` 存在于上游 `outputContract`；同一 Task 内 input name 和 output key 分别唯一。
- MVP 的 `TaskInputSpec.required` 必须为 `true`；可选输入需等待 Phase 2 条件边，不在 MVP 中制造空值就绪语义。
- `TaskOutputSpec.artifactPolicy='revise_input'` 时必须指定本 Task 的 `reviseInputName`；allowedRelations 的 targetInputName 必须引用已声明 input。
- ReviewLoop 创建时校验：`maxIterations` 在系统范围内；initial/revision producer 均输出 `acceptedOutputKey`；initial policy 为 create、revision policy 为 revise_input；reviewer 必须输出 review deliverable并允许 `reviews(current_producer)`；所有 TemplateInputSpec 来源可在对应轮次解析。
- ReviewLoop 父 Task 的 `outputContract` 必须且只能为 `acceptedOutputKey` 声明 required=true、`artifactPolicy='alias_review_acceptance'`；其 kind/documentType/mediaType 必须与 initial/revision producer 同 key 合同兼容。普通 agent Task 禁止使用该 policy。
- MVP ReviewLoop 的 `acceptedOutputKey.kind` 必须为 `document`，且 `documentType` 只能是 requirement/design/review/report/other；以 code、目录、路径 manifest、git diff 或工作树为 accepted output 的草案必须在 prepare 阶段拒绝为 `unsupported_code_review_loop`。Phase 2+ 引入 CodeChangeSet/ArtifactBundle 后再扩展合同类型。
- 只有 `dependsOn` 为空的 Task 才能在计划启动时直接进入 `queued`。

Task 从 `pending` 进入 `queued` 必须同时满足：所有显式依赖均为 `completed`，且所有 input spec 均能解析到上游当前有效 generation 的已发布 deliverable/revision。解析和 `TaskInputBinding` 写入发生在同一入队事务中；Runner prompt 注入 input name/title/type/revision 摘要，但不注入内部文件路径，Agent 通过 `read_task_input({ name })` 消费。解析失败时 Task 保持 `pending`，记录确定性错误，并将 TaskPlan 挂起为 P0。

#### 2.2.2 失败、取消、跳过与重跑传播

| 上游结果/操作 | 下游语义 |
|---|---|
| 自动重试中 | 下游保持 `pending`；仅最终 attempt 成功后才重新判断就绪 |
| 最终 `failed` | 所有直接或传递依赖者标记 `skipped`，原因记录为 `dependency_failed:<taskId>`；无关分支继续运行 |
| Task `cancelled` / `skipped` | 依赖者标记 `skipped`，原因分别为 `dependency_cancelled:<taskId>` / `dependency_skipped:<taskId>` |
| TaskPlan 取消 | 按 §2.2.3 的统一失效与 drain 协议处理全部非终态 Task 及 queued/running/confirming/cancelling attempt；资源释放完成前计划保持 `cancelling` |
| 手动重跑已完成/失败 Task | 按 §2.2.3 处理目标及传递下游；旧 output 保留但标记 superseded，drain 完成后按拓扑序重置为 `pending` |

手动“跳过”不是“继续执行依赖者”的后门。若任务需要一个可选依赖，应在 Phase 2 的条件边中显式建模；MVP 中依赖未成功即不执行下游。

当不存在 `queued` / `running` / `confirming` / `cancelling` Task 时，TaskPlan 按确定性规则收敛：全部 Task `completed` 才为 `completed`；存在任一 Task `failed`、单 Task `cancelled`、或因依赖失败/取消而 `skipped` 时为 `failed`；只有用户取消整个计划时才为 `cancelled`。因此“无关分支继续”不会掩盖关键分支失败。

#### 2.2.3 统一 execution invalidation、drain 与 generation fencing

重跑和取消都复用同一个持久化协议。它把“令牌立即失效”和“进程/资源最终停止”分开，不能用一次状态赋值代替：

**A. 原子失效事务**

1. 确定作用域：重跑为目标 Task 及其传递下游；取消 TaskPlan 为计划内全部非终态 Task，以及所有 `queued` / `running` / `confirming` / 已有 `cancelling` attempt。
2. 锁定作用域内 Task，停止该计划继续入队；为每个 Task 执行 `generation += 1`、清空 `currentAttemptId`。活动 Task/attempt 进入 `cancelling`，attempt 写入 `invalidatedAt`、`invalidationReason` 与 `cancelRequestedAt`。由此旧 execution token 在事务提交时立即失效。
3. 在事务中将作用域内持久化确认请求设为 `cancelled`；提交后立即关闭对应的内存 pending confirm registry。确认回复必须绑定 `(taskId, attemptId, generation, confirmId)` 并在消费时查询有效 generation；即使回复与内存清理竞态，延迟 allow/deny 也只会返回 stale，不得恢复 Runner 或启动工具。
4. 在同一事务创建 `TaskDrainOperation`，持久化目标 Task 和待 drain attempt 集合。重跑时旧 output/deliverables 标记 stale/superseded，传递下游的 `TaskInputBinding` 随其 generation 一并失效但保留审计；计划恢复为 `running`。整计划取消时 TaskPlan 进入 `cancelling`，此时 UI 必须显示“正在取消”，不得提前展示成功。若集合为空，则在该事务内直接执行对应的完成步骤。

**B. 取消与 drain**

5. 事务提交后，取消尚未启动的 queued attempt，并立即为其写入 `finishedAt` / `resourcesReleasedAt`；向 running/confirming/cancelling attempt 发送取消信号，Runner 在 `finally` 中释放 attempt 资源。
6. 调度器等待集合中每个 attempt 同时写入 `finishedAt` 和 `resourcesReleasedAt`；后者只能在 `releaseAttemptResources` 成功后写入。`status='cancelling'`、`superseded` 或 generation 已失效均不等于 Runner 已退出。
7. 在 drain 完成前，不得为受影响 Task 创建新 attempt；也不得将 TaskPlan 提交为 `cancelled`。这条屏障同时适用于恢复、重跑和自动重试。

**C. 完成或超时**

8. 重跑 drain 成功后，在一个事务中把旧 attempt 终态设为 `superseded`，按拓扑序将受影响 Task 重置为 `pending`；仅目标 Task 按正常就绪规则入队，下游等待新 output。
9. TaskPlan 取消 drain 成功后，在一个事务中把活动 attempt/非终态 Task 设为 `cancelled`，再将 TaskPlan 设为 `cancelled`。Session、Step 和 output 继续保留供审计。
10. 若超过 `attemptCancelTimeoutMs`，drain operation 置为 `timed_out`，TaskPlan 转为 `paused` 并记录 P0：重跑使用 `superseded_attempt_cancel_timeout`，整计划取消使用 `plan_cancel_timeout`。不得宣称取消成功，也不得恢复、重跑或创建新 attempt。UI 只提供“重试取消”和“保持暂停”；后者不解除 drain 屏障。后台守护器仍持续观察旧 attempt；若原取消意图仍有效，在其全部释放后自动执行对应完成事务。

`TaskDrainOperation` 是崩溃恢复依据：应用启动时扫描 `draining` / `timed_out` 操作，重新核对 expected attempts 的 `finishedAt` / `resourcesReleasedAt`，恢复取消信号和收尾，而不是把相关 Task 重置为普通 `pending`。

同一 TaskPlan 的失效操作串行化：数据库约束禁止两个未完成 drain operation。已有重跑 drain 时收到整计划取消，取消具有更高优先级，须在事务中把现有 operation 提升为 `plan_cancel`、扩展到计划全部非终态 Task/attempt 并再次提升新增作用域的 generation；不得另开并行 drain。已有 plan_cancel drain 时拒绝重跑或恢复。

**D. 强制栅栏**

每个 Runner 携带不可变的 `(taskId, attemptId, generation)` execution token。强制校验必须位于工具执行边界的装饰器/网关中，而不是依赖事件适配器：每次工具调用（包括读、写、删与浏览器）开始前校验；Task output/终态提交、确认回复消费、触发下游入队也必须校验。最终提交使用等价于 `UPDATE ... WHERE id = taskId AND generation = ? AND current_attempt_id = ?` 的条件更新；影响行数为 0 即为旧 attempt，必须丢弃更新。

旧 attempt 的晚到 Step 仅可由独立审计路径追加并标记 `superseded=true`，不得经过 BackgroundTaskEventTarget 的普通状态归并；晚到确认、工具调用、output、Task/Plan 终态和下游入队全部拒绝。取消信号只用于尽快停止，generation fencing 才是正确性边界。

受控文件工具的单次调用一旦越过“副作用前”栅栏就不可原子撤销，因此必须先 drain 旧 attempt，再允许恢复或启动新代次，避免失效执行与新执行同时产生副作用。

#### 2.2.4 交付物提交、版本与血缘

`TaskDeliverable` 是 Task 间合同，Artifact 是工作文件资产；正式交付只能通过宿主管理的 `submit_task_output` 协议发布，不能从最后写入文件、LLM 文本或文件名猜测。

##### A. revision store 的强制不可变边界

1. revision store 位于宿主管理的保留根目录，不属于 Agent 工作路径命名空间。其真实 `contentLocator` 仅在主进程 repository 内可见，绝不写入 prompt、Task API、工具结果或 UI。
2. 所有 Agent 可调用的写、编辑、删除、移动、重命名、复制目标和目录操作，在工具网关先做真实路径/祖先链校验并拒绝 revision root；同时拒绝以软链接、硬链接或路径别名修改 store 内 inode。保留根策略优先于 Task 的 `writeFiles/deleteFiles` 授权。
3. revision 内容只能通过 `read_task_input({ name, range? })` 读取。工具由 `(taskId, attemptId, generation, input name)` 查找 `TaskInputBinding`，读取前后校验 blob hash，返回内容/分页流或受控解析结果；不返回真实路径。并发 Task 只获得只读流，不能获得可变文件句柄。
4. 若后续格式必须使用路径型解析器，由宿主在 attempt 私有目录物化普通**输入副本**，记录 `materializedHash == revision.contentHash` 后再暴露副本路径。副本与 revision store 无硬链接、可被 Agent 修改，但永远不自动成为 output；输出仍须写到独立工作 Artifact 并显式提交。

##### B. 结构化交付提交协议

Runner 只有调用以下宿主工具并成功后才能完成 Task：

```ts
submit_task_output({
  submissionId: string,
  execution: { taskId: string, attemptId: string, generation: number },
  summary: string,
  deliverables: Array<{
    key: string,
    artifactId: string,
    expectedWorkingHash: string,
    title?: string,
    kind: 'document' | 'code' | 'data' | 'media' | 'other',
    documentType?: 'requirement' | 'design' | 'review' | 'report' | 'other',
    mediaType?: string,
    stage?: 'draft' | 'final',
    relations?: Array<{
      type: 'reviews' | 'revises' | 'derived_from' | 'supersedes',
      targetInputName: string
    }>
  }>,
  reviewDecision?: {
    verdict: 'pass' | 'revise',
    targetInputName: string,
    reviewDeliverableKey: string,
    summary: string,
    requiredChanges?: string[]
  }
})
```

5. 普通写工具成功后，以 execution token 把 `artifactId`、路径、hash、字节数和 write event 写入 `AttemptArtifactWrite`。提交服务只接受当前 attempt 成功写账本中的 Artifact；临时文件、候选稿和附件不会自动成为 deliverable。
6. 提交服务以 `outputContract` 为授权边界：拒绝未知/重复 key、缺失 required key、类型不匹配、非当前 attempt 写入、working hash 已变化以及 execution token 失效。一个 Task 写多个文件但只提交合同要求的文件是合法的。
7. `artifactPolicy='create'` 要求 artifact 首次由当前 attempt 创建，适用于 review；`artifactPolicy='revise_input'` 要求 artifactId 等于 `reviseInputName` 绑定的 artifactId，适用于 revised-design。Agent 不得临场选择创建/复用策略。
8. relation 只能使用合同 `allowedRelations` 中的 `(type, targetInputName)`，目标 revision 从该 Task 的 `TaskInputBinding` 解析，envelope 不接受任意 target artifact/revision ID。由此 `review reviews design@rev-1` 可验证确实评审了本次输入。reviewDecision envelope 也不接受 Agent 自报 loopTaskId/runId/generation/iteration；宿主必须从 reviewer Task 的持久化父关联派生这些字段并写入 ReviewDecision。

##### C. 耐崩溃发布与幂等性

9. 提交服务先持有源 Artifact 读租约，将内容复制到宿主 staging 文件，close/fsync 后计算 hash，再以内容 hash 原子 rename 到 revision store；禁止 Agent 直接写 store。随后数据库事务写 revision、deliverable、relations、summary，并以 generation/currentAttemptId 条件提交 Task completed。
10. 文件系统与数据库不假装同一事务：数据库提交失败时 blob 仍是未引用对象，submission 保持 `staging/failed`；GC 只清理超过安全宽限期、无 revision 引用且不属于活跃 submission 的 blob。数据库成功后才将 submission 置为 `published` 并对下游可见。
11. `submissionId` 在 attempt 内唯一，`envelopeHash` 固定请求内容；`UNIQUE(task_id, attempt_id, generation, output_key)` 是每个 key 的发布边界。同一 submission/envelope 重放返回同一 revision；同 ID 不同 envelope、或同 key 改绑其他 Artifact 明确失败，不生成第二份 revision/relation。
12. 提交校验或 staging 失败时 Task 保持 running/confirming，不进入 completed；同 attempt 可修正 working Artifact 后使用新的 submissionId 重试。失败 staging blob 由上述 GC 回收。

`read_task_input` 与 `submit_task_output` 是 agent Task Runner 的宿主系统工具：前者仅在 Task 有 inputs 时注册，后者始终注册且是 **agent Task** 进入 completed 的唯一入口；ReviewLoop 父 Task 只能走 §2.2.6。`toolAllowlist` 可以裁剪普通能力，但不能替换、伪造或绕过这些协议的 generation 校验。

##### D. 保留与清理

13. 删除当前 Artifact 仅把工作资产 tombstone/移出 UI，不删除 revision。TaskPlan/Session 删除也不能级联删除仍被 deliverable、input binding、relation 或审计记录引用的 revision。
14. revision blob 使用数据库可达性而非易漂移的手工引用计数判定保留：从有效/历史 deliverable、binding、relation 和活跃 submission 做 mark-and-sweep。历史清理是独立高风险操作，需显式授权并先展示影响范围。
15. revision store 计入独立的每计划与全局磁盘预算；按 contentHash 物理去重、按 revision 保留逻辑记录。超预算时拒绝新提交并 P1 上报，不得删除仍被引用的历史版本。

数据库至少施加以下约束：`UNIQUE(task_id, generation, key)`、`UNIQUE(task_id, generation, input_name)`、`UNIQUE(source_revision_id, type, target_revision_id)`、`UNIQUE(task_id, attempt_id, generation, output_key)`；deliverable/relation 中的 revision 必须属于声明 Artifact。`ArtifactRelation` 只表达内容血缘，不参与调度。

示例：

```text
design-task.output.deliverables.design
  = design-artifact@rev-1

review-task.input.design
  = design-artifact@rev-1
review-task.output.deliverables.review
  = review-artifact@rev-1
  relation: reviews(design-artifact@rev-1)

revise-task.input.design
  = design-artifact@rev-1
revise-task.input.review
  = review-artifact@rev-1
revise-task.output.deliverables.revised-design
  = design-artifact@rev-2
  relations: revises(design-artifact@rev-1), derived_from(review-artifact@rev-1)
```

#### 2.2.5 动态评审循环（ReviewLoop）

动态评审不能在 Task DAG 中创建回边。`kind='review_loop'` 的 Task 是外部 DAG 中稳定、可依赖的控制节点；每轮 producer/reviewer 是其内部子 Task，按需要向前展开成有限的无环链。下游只依赖 ReviewLoop Task ID，不依赖尚未创建的某一轮 Task。

**创建与首轮：**

1. ReviewLoop Task 按普通 `dependsOn` 进入 `running`，但不启动 Agent Runner。`ReviewLoopController` 在事务中为父 Task 当前 generation 创建唯一 `ReviewLoopRun`，再创建该 run 的 iteration 1 和 producer 子 Task，复制 initialProducerTemplate，并将 loop 的 seedInputs 固化为 producer inputs；没有 seed Artifact 时可把不可变的 `TaskPlan.goal` 快照注入首轮 instruction。
2. producer 完成且通过 `submit_task_output` 发布目标交付物后，Controller 创建/入队同轮 reviewer 子 Task；reviewer 的 target input 精确绑定本轮 producer revision。
3. 动态子 Task 使用稳定 UUID，持久化 `parentReviewLoopTaskId + parentReviewLoopRunId + parentReviewLoopGeneration + reviewIteration`；创建事务仍执行 DAG、合同和 input 校验。子 Task 仅由 Controller 创建，Planner/Agent 不能任意追加节点。

内部子 Task 不参与顶层 PlanStatusReducer 的完成/失败计数，也不允许外部 Task 直接 dependsOn；它们的状态由 ReviewLoopController 汇总到稳定父 Task。UI 在父节点下按 iteration 嵌套展示，避免动态轮次改变顶层进度分母。

**结构化裁定：**

4. reviewer 必须在 `submit_task_output` 中同时提交 review 文档和 `reviewDecision`。宿主从 reviewer Task 的父关联派生 run/generation/iteration，校验它们仍是父 ReviewLoop 当前有效 run；target 与其 `TaskInputBinding` 完全一致，review deliverable 存在且具有 `reviews` relation；自然语言中的“通过”不改变状态。
5. reviewDecision 与 reviewer output 在同一发布事务中持久化且幂等。旧父 generation/run、旧子 generation、重复冲突裁定或评审错误 revision 一律拒绝。

**通过：**

6. `verdict='pass'` 时，iteration 进入 `acceptance_pending`；Controller 只能调用 §2.2.6 的 `publish_review_loop_acceptance` 发布父节点 accepted alias。协议成功后 iteration/run/父 Task 才分别进入 passed/passed/completed，下游随后绑定最终接受版本。

**要求修订：**

7. `verdict='revise'` 且尚未达到上限时，当前 iteration 置为 `revision_requested`，事务中用 revisionProducerTemplate 创建 iteration N+1 的 producer。新 producer 至少绑定“上一轮产出 revision”和“本轮 review revision”；其输出合同必须 `artifactPolicy='revise_input'`，从而生成同一主文档 Artifact 的新 revision。initialProducerTemplate 通常使用 `create`，两者不可混用。
8. N+1 producer 完成后再创建 N+1 reviewer，重复上述过程。运行时展开的是 `producer-1 → reviewer-1 → producer-2 → reviewer-2` 单向链，不存在环。

**上限、失败与人工介入：**

9. `maxIterations` 必须为有限正整数并受系统上限约束。达到上限仍为 revise 时：run 先置为 `exhausted`；`onExhausted='fail'` 再使父 loop Task failed 并按规则汇总计划失败；`pause` 保持父 Task running、使 TaskPlan 以该 run 为原因进入 paused 并 P1 上报。用户可提高上限后继续、接受当前版本或取消；提高上限时在同一条件事务把当前 run 恢复 running 并创建唯一下一轮。接受当前版本属于显式高风险 override，记录操作者、理由和被接受 revision。
10. producer/reviewer 的普通失败先按各自 retryPolicy 处理；最终失败使 ReviewLoop Task failed，并按既有依赖传播。不会因为评审 Agent 未返回 verdict 而默认通过。

**取消、重跑和恢复：**

11. 取消/重跑 ReviewLoop 时，§2.2.3 的事务先提升父 generation，并将旧 run 的 pending ReviewOverrideAudit 标记 stale，使旧 run/Controller/人工操作立即失效；drain 作用域包含旧 run 的所有子 Task/attempt 和 Controller 操作。drain 完成后，取消将旧 run/iterations 标记 cancelled，重跑标记 superseded；review/relation 保留审计。
12. ReviewLoop 重跑为新父 generation 创建新 ReviewLoopRun，并从该 run 的 iteration 1 展开；若未来支持“从第 N 轮继续”，必须把此前接受的 revision 作为显式新 seed，不得复用旧 run 的子 Task 状态。
13. 数据库使用 `UNIQUE(review_loop_task_id, review_loop_generation)` 和 `UNIQUE(review_loop_run_id, iteration)`；Controller 的推进/恢复查询必须同时携带父 taskId、runId、generation。应用重启时可以保留多代历史，但只恢复与父 Task 当前 generation 相等且 status=running 的 run；重复或旧代事件不得创建两个 N+1 producer或重复完成 loop。

对于“需求说明→评审→修订，直到通过”，可分别创建 `requirement-review-loop`、`technical-design-review-loop` 和 `development-plan-review-loop` 三个稳定 Task；技术方案 loop 依赖需求 loop，详细开发方案 loop 依赖技术方案 loop。每个 loop 的下游看到的都是最终 accepted revision。

MVP 不创建 `implementation-review-loop`。代码实现通常跨多个文件并包含新增、删除和重命名，而当前 `acceptedOutputKey` 只能精确接受一个 Artifact revision；让 reviewer 读取可变 workDir，或把路径清单/git diff 文本当作 revision，均不能证明 verdict 针对哪组代码内容。MVP 的实现 Task 只能交付逐文件 code Artifact 和文档型实现报告，后续汇总 Task 可以检查完成情况，但不得产出结构化“代码已通过版本评审”的结论。

Phase 2+ 若启用代码 ReviewLoop，必须先定义宿主管理的不可变 `CodeChangeSet/ArtifactBundle`：固定 base identity、每个文件的 blob/hash、增删改/重命名操作、整体 hash 和真实 producer provenance；`read_task_input` 按 bundle 读取固定内容，修订轮生成新整体 revision，accepted alias 指向整个 bundle。同时必须提供 bundle 到工作树的受控 apply/merge、冲突检测、generation fencing 与失败原子性。若使用 Codex worktree/commit 实现该边界，则 Codex 沙箱和并发准入也必须先通过 §8.6，不能只依赖 Runner 自身能力。

#### 2.2.6 父 ReviewLoop accepted alias 发布协议

ReviewLoop 父 Task 没有 Agent attempt，也不拥有 `AttemptArtifactWrite`。它不得调用/伪造 `submit_task_output`，而由 Controller 调用唯一的宿主内部服务：

```ts
publish_review_loop_acceptance({
  reviewLoopTaskId: string,
  expectedReviewLoopGeneration: number,
  reviewLoopRunId: string,
  iterationId: string,
  trigger:
    | { kind: 'verdict'; reviewDecisionId: string }
    | { kind: 'manual_override'; overrideAuditId: string }
})
```

该服务不暴露给 Agent/Renderer，必须在单个数据库事务中完成：

1. 条件锁定父 Task，校验 `kind='review_loop'`、Task status=`running`、`generation=expectedReviewLoopGeneration`，且该计划不存在未完成 drain operation。人工接受时额外要求 TaskPlan 因本 run exhausted 而处于 paused；Task 本身不引入 paused 状态。
2. 校验 ReviewLoopRun 属于父 Task 当前 generation 且尚未发布 acceptance；iteration 属于该 run，并且 producer deliverable 正是本轮记录的 `acceptedOutputKey` artifact/revision。
3. verdict 路径要求 iteration=`acceptance_pending`，当前 ReviewDecision 为 pass、属于同 run/iteration 且 target 精确匹配 producer revision；manual_override 路径要求 run=`exhausted`、TaskPlan 因该 run 而 paused，且存在未消费的人工审计记录，包含操作者、理由、时间和明确接受的 revision。
4. 校验父 `outputContract` 的 `alias_review_acceptance` key/type/documentType/mediaType 与 producer deliverable 兼容。alias 不创建 ArtifactRevision、不需要父写账本，只引用已经发布的 producer revision。
5. 幂等写入 `ReviewAcceptancePublication` 和父 `task_deliverables`。alias 的 `producedBy` 复制真实 producer provenance，`publishedByReviewLoop` 记录父 task/run/generation/iteration/publication；不得声称内容由 Controller 生成。
6. 在同一事务把 iteration/run/父 Task 更新为 passed/passed/completed，并消费 override（如有）。所有更新都带父 generation/run 条件；任一条件失败则整笔回滚，父 output、状态和下游均不可见。
7. 使用 `UNIQUE(review_loop_task_id, review_loop_generation)` 保证每代至多一个 publication。同参数重复调用返回既有 publication；不同 iteration/revision 的竞争请求明确失败。
8. 事务提交后才触发下游 ReadinessResolver。发布与取消/重跑并发时，谁先取得条件事务决定结果：若 generation 已提升或 drain 已建立，晚到 pass/override 返回 stale，绝不能重新完成父 Task。

数据库事务失败时没有文件 staging 需要清理，因为 alias 复用既有 revision；重试只重复上述条件发布。普通 Agent output 仍严格走 `submit_task_output`，两条协议共享 deliverable 读取模型，但授权来源和幂等键不同。

### 2.3 内部 Session 生命周期

每个 `kind='agent'` 的后台 Task 在执行时创建独立内部 Session；`review_loop` 父 Task 由 Controller 推进，不创建 Agent Session/TaskAttempt，其动态 producer/reviewer 子 Task 各自遵循以下生命周期：

| 阶段 | 行为 | 说明 |
|------|------|------|
| **创建** | agent Task 从 `pending` 入队时创建 `queued` attempt；Runner 领取后转为 `running`，首次运行时创建内部 Session | 创建 attempt 与设置 `tasks.currentAttemptId` 必须在同一入队事务中并带当前 generation；review_loop 入队不创建 attempt，由 Controller 使用 `(taskId, generation)` 条件推进 |
| **标记** | `sessions` 表新增 `visibility` 字段：`'visible'`（默认，前台会话）/ `'internal'`（后台 Task 会话） | 或独立 `task_sessions` 表——技术设计阶段评估两个方案对现有查询的侵入性后决定 |
| **关联** | `tasks.sessionId` → `sessions.id` | Task ↔ Session 一对一 |
| **消息存储** | 走现有 `appendMessage` 路径 | Session 消息是对话正文；后台 Step 由 BackgroundTaskEventTarget 的集中映射以 `(attemptId, eventId)` 幂等写入，消息回放不再二次生成 Step |
| **保留** | Task 完成后 Session **保留不删** | 用于 Task 详情的只读对话时间线回放 |
| **运行资源释放** | 每个 attempt 的 Runner 在 `finally` 中调用统一的 `releaseAttemptResources(attemptId, sessionId)` | 必须释放路径租约、浏览器信任/句柄、request/cancel 状态和临时资源；成功、失败、取消、超时和异常退出均执行。Session 是否复用不影响释放；Phase 2+ 若引入子进程也必须纳入 |
| **清理** | TaskPlan 删除先逻辑 tombstone 计划和内部 Session、从 UI 隐藏；仅当 Session Artifact/revision 已不再被 deliverable/binding/relation/审计引用时才物理级联 | 取消只停止执行并保留记录。不能让现有 `sessions → session_artifacts` 级联外键绕过 revision 保留策略；物理清理由引用安全 GC 协调 |
| **不可见** | `visibility='internal'` 的 Session 不暴露在会话列表查询中 | 会话列表查询加 `WHERE visibility != 'internal'` 过滤 |
| **workDir** | 与发起会话的 `workDir` 相同 | 确保文件操作在同一项目上下文中 |

### 2.4 调度器：TaskDispatchService

核心组件：

```
TaskDispatchService
  ├─ DagValidator       ← 创建/更新时校验稳定 ID、引用存在性和无环性
  ├─ ReadinessResolver  ← 仅将依赖成功且 input bindings 全部固化的 Task 入队
  ├─ TaskQueue          ← 加载 queued Task，按优先级和创建时间稳定排序
  ├─ SlotManager        ← 全局资源槽位（LLM / Browser），类似 RemoteTaskController 的 slot 模型
  ├─ TaskKindDispatcher ← 根据 kind 分派
  │   ├─ review_loop → ReviewLoopController（不启动 Agent）
  │   └─ agent → TaskRunnerFactory
  │       └─ 'builtin' → ToolChatRunner（MVP，复用 runToolChatSession）
  │           Phase 2+ 才增加 CodexRunner / PlannerRunner / UserTaskNotifier
  ├─ PlanStatusReducer ← 根据 Task 终态汇总 TaskPlan 状态
  │   Phase 2+ 引入 Stage 后再增加 StageAdvancer
  └─ TaskProgressBus   ← 事件总线，向各渠道同步进度
```

#### 2.4.1 核心架构决策：兼容 EventTarget + 独立 DecisionResolver

**问题边界**：当前 `toolChatLoop.ts` 有约 33 次 `safeWebContentsSend`，但只有约 13 种 channel，大量调用是重复的 `tool:result`。若为每个调用点重写 ProgressSink 方法，会同时改动前台 IPC、渲染状态机、远程 IM、确认流程和大量测试，超出 MVP 必要范围。真正需要拆开的只有两件事：无窗口时事件发到哪里，以及需要返回值的确认由谁决策。

**MVP 不拆现有 IPC 事件协议。** 将 `RunToolChatSessionArgs.sender` 的静态类型从 Electron `WebContents` 收窄为结构兼容接口，保留现有 channel、payload 和发送位置：

```ts
interface ToolLoopEventTarget {
  isDestroyed(): boolean
  send(channel: string, ...args: unknown[]): void
  flush?(): Promise<void>
}
```

Electron `WebContents` 天然满足该接口；`safeWebContentsSend` 仅把参数类型放宽为 `ToolLoopEventTarget | null | undefined`，实现和现有 33 个调用点不要求逐一改写。名称可在后续清理，MVP 不为重命名制造大范围 diff。

`send()` 保持同步语义，避免把 33 个调用点改成 `await`。`BackgroundTaskEventTarget.send()` 只做校验、生成确定性 `eventId` 并按 attempt 顺序写入**有界内存队列**；后台消费者再异步批量写 Session/`task_steps` 并推送 TaskProgressBus。队列接近上限时允许合并尚未持久化的文本/thinking delta 和同一 `toolUseId` 的 progress，但不得丢弃 `tool:use`、`tool:result`、usage、artifact/path 等离散事件；合并和溢出都记录计数。若不可合并事件仍无法入队，attempt 必须显式失败为 `event_delivery_overflow`，不能假装执行成功。

可选的 `flush()` 是后台适配器生命周期钩子，原生 `WebContents` 无需实现。Runner 在提交 Task 终态前等待事件队列 drain；在异常、取消和超时的 `finally` 中也应先执行带超时的 flush，再调用 `releaseAttemptResources`。flush 失败或超时必须进入审计并阻止成功终态，从而保证工具循环已经返回但最后一批 Step/usage 尚未落库时不会提前报告完成。

| 场景 | EventTarget | 行为 |
|---|---|---|
| 前台聊天 | 原生 `WebContents` | 完全沿用现有 IPC channel 和渲染处理 |
| IM/无窗口但不需任务持久化 | `NoopToolLoopEventTarget` | 替代当前临时强转的 noop WebContents；显式表达丢弃 UI 事件 |
| 后台 Task | `BackgroundTaskEventTarget` | 实现同一 `send()` 结构，将既有 channel 映射为 TaskProgressBus/持久化更新，不依赖窗口 |

`BackgroundTaskEventTarget` 是兼容桥，不是新的领域事件总线。它只维护约 13 种 channel 的集中映射：

- `claude-chat-delta` / thinking：按 attempt 缓冲并写 Session 消息，UI 推送可节流，不把每个 token 作为 Step 落库。
- `tool:use` / progress / result：按 `toolUseId + seq` 创建或更新 `task_steps`。
- usage：更新 TaskAttempt 统计，采用 upsert，不追加重复 Step。
- artifact summary / path-resolved：更新展示索引或 Artifact 关联。
- 未知 channel：开发/测试环境报错，生产记录审计警告；不能静默假装已持久化。

桥接层为缺少原生事件 ID 的事件生成确定性 `eventId`，至少包含 attemptId、channel、toolUseId/seq 或同类业务键；`UNIQUE(attempt_id, event_id)` 保证重放幂等。execution token 的副作用栅栏仍位于工具执行网关（§2.2.3 D），不能依赖 EventTarget。

**确认请求不是进度事件。** `tool:confirm-request`、`artifact:decision-request` 和 `file-write-dir:confirm-request` 发出后都需要返回值，因此从 EventTarget 职责中拆出：

```ts
interface ToolLoopDecisionResolver {
  resolveToolConfirmation(request: ToolConfirmationRequest): Promise<ToolDecision>
  resolveArtifactDecision(request: ArtifactDecisionRequest): Promise<ArtifactDecision>
  resolveWriteDirectory(request: WriteDirectoryRequest): Promise<WriteDirectoryDecision>
}
```

| 场景 | DecisionResolver | 行为 |
|---|---|---|
| 前台聊天 | `InteractiveDecisionResolver` | 复用现有 IPC request + pending registry + 用户回复 |
| 后台 Task | `ManagedTaskDecisionResolver` | 在 TaskAuthorizationScope 和 interactionMode 内自动决定；仅 P0/P1 持久化 pending confirmation 并挂起 |
| IM | `RemoteDecisionResolver` | 复用现有远程 decision owner/消息回复能力 |

DecisionResolver 的请求和回复必须绑定 `(taskId?, attemptId?, generation?, requestId/confirmId)`；后台取消/重跑按 §2.2.3 关闭 pending registry，晚到回复返回 stale。Resolver 只负责决策，不写 Step；EventTarget 只负责通知和进度，不返回决策。前台 Resolver 可以继续通过 EventTarget 发送现有确认 channel，从而保持渲染协议不变。

**MVP 改动边界：**

1. 新增两个小接口及各运行场景的薄适配实现，不改现有 channel/payload。
2. 放宽 `safeWebContentsSend` 和 `sender` 的类型；约 30 个非阻塞事件发送点保持原样。
3. 将三类等待确认的分支（包括其 request 发送）收进 DecisionResolver；这是需要行为重构的主要范围，避免 Resolver 与原调用点重复发请求。
4. 为 BackgroundTaskEventTarget 建立集中 channel 映射测试；不要求重写全部 `toolChatLoop.*.test.ts`。
5. 类型化领域事件和移除字符串 IPC 属于后续重构，不是后台执行层 MVP 前置条件。

### 2.5 进度同步：TaskProgressBus

事件类型：

| 事件 | 触发时机 | 频率 |
|---|---|---|
| `plan:statusChanged` | TaskPlan 状态变更 | 低频 |
| `stage:advanced` | Stage 推进/阻塞（Phase 2+，MVP 不注册） | 低频 |
| `task:started` | Task 开始执行 | 低频 |
| `task:progress` | Task 执行中的进度更新 | 中频（描述性文本，有变更时） |
| `task:step` | Step 的创建/更新/完成 | 高频（工具调用粒度，50ms 防抖合并） |
| `task:confirming` | Task 需要用户确认 | 事件触发 |
| `task:completed` | Task 执行完成 | 低频 |
| `task:failed` | Task 执行失败 | 低频 |
| `review:iterationStarted` | ReviewLoop 创建新一轮 producer | 低频 |
| `review:decision` | reviewer 发布 pass/revise 裁定 | 低频 |

- Task 进度使用**描述性文本**（statusText + completedSteps），不用硬百分比
- Step 事件实时推送 + 50ms 防抖合并（`step:started`/`step:progress` 合并，`step:done` 立即 flush）
- 前台继续使用现有 IPC；后台由 `BackgroundTaskEventTarget` 将相同 channel 映射到 TaskProgressBus，并作为 Step 事件写入 `task_steps` 的唯一入口

### 2.6 补充子题（标记，后续深化）

| # | 题目 | 状态 |
|---|---|---|
| #A | 暂停/恢复的精细语义 | 留接口；取消已在 §2.2.3 完整定义 |
| #B | 一般崩溃恢复 / 断点续传 | 留接口；MVP 保证版本化交付物原子持久化。存在 drain operation 时必须优先恢复 drain，禁止简单执行 `running` → `pending` |
| #C | Task 间结构化数据传递 | ✅ 已明确：显式 `dependsOn` + 命名 deliverable + artifact revision + 输入绑定（§2.2），入队时固化 |

---

## 3. 交互机制：三阶段模型

```
聊天/IM 界面                    后台任务面板                   聊天/IM 界面
┌──────────────┐     ┌───────────────────┐     ┌──────────────┐
│ 阶段 1        │     │ 阶段 2             │     │ 阶段 3        │
│ 需求输入与澄清 │ ──→ │ 执行进度           │ ──→ │ 结果投递      │
│              │     │                   │     │              │
│ 复用现有入口   │     │ 独立面板           │     │ 推回原会话     │
│ 当前对话中完成 │     │ 不污染会话列表      │     │ 一条完成消息   │
└──────────────┘     └───────────────────┘     └──────────────┘
```

### 3.1 阶段 1：需求输入与澄清（在聊天/IM 中完成）

- **入口**：复用现有聊天界面和 IM 界面，不新增 UI 入口
- **触发**：用户发送指令 → 系统判断是否为后台任务类请求（复用 Skill 路由机制，或显式 `/task` 指令）
- **澄清方式**：一次性列出 3-5 个关键澄清问题，用户补齐后输出**需求简述**，用户确认
- **澄清阶段限制**：LLM 可读文件（了解项目上下文），但禁止写入/执行
- **计划生成**：当前会话 Agent 调用 §2.1.1 的 WorkflowCompiler 生成完整 `TaskPlanDraft`；软件开发计划必须包含跨 phase 依赖、输入/输出合同及所需 ReviewLoop，不只输出需求简述
- **确认后**：用户必须在原计划预览 UI 点击确认；Agent 文本、工具调用和其他窗口不能代替。主进程按 §2.1.1 校验/消费一次性确认并原子创建 TaskPlan/Task DAG（不启动 PlannerRunner）→ 原会话插入“任务已提交”消息 → 会话恢复自由

**注意**：需求澄清不进入后台任务面板。MVP 的预览和执行视图可按 `phaseKey` 折叠展示 Task DAG，但 phase 没有独立状态；Phase 2+ 只有在确实需要阶段级暂停/重跑或通用条件门时，才把 Stage 升级为运行时实体。

### 3.2 阶段 2：执行进度（独立后台任务面板）

- **桌面**：Activity Bar 新增任务图标（有运行中任务时显示橙色圆点指示），点击后主区域切换为任务面板
- **IM**：远程指令（`/进度`、`/详情`、`/当前`）按需拉取
- **内部 Session 全部不暴露在聊天会话列表**（每个 TaskPlan 可能产生数十个内部 Session）

### 3.3 阶段 3：结果投递（推回原会话）

- **成功**：在发起会话中插入一条系统消息，列出产出物路径、耗时、阶段概况
- **失败**：同样推回，附错误原因 + 建议操作（如"重新执行失败阶段"）
- 消息包含 `[查看执行详情]` 链接，跳转到任务面板

**会话自动置顶**：通过 `appendMessage` 写入消息时，自动触发 `updateSession` 更新 `updated_at`，而会话列表按 `ORDER BY updated_at DESC` 排序，且有专用索引 `idx_sessions_updated_at`。即使任务执行了十几个小时、期间用户聊了多条其他会话，完成消息一插入，发起会话自动回到侧栏顶部。

### 3.4 IM 远程指令扩展

在现有 `imCommandRouterHelpers` 基础上扩展：

| 指令 | 行为 |
|---|---|
| `/进度` | 返回 TaskPlan 整体进度摘要 |
| `/详情 [N]` | 返回第 N 个 Stage 的 Task 列表（MVP 无 Stage 时返回第 N 个 Task 详情） |
| `/当前` | 返回当前正在执行 Task 的实时输出 |
| `/暂停` | 暂停整个 TaskPlan |
| `/继续` | 恢复执行；存在未完成 drain operation 时拒绝，并返回当前取消/回收状态 |
| `/取消` | 按 §2.2.3 取消整个 TaskPlan；重复调用幂等，复用现有 plan_cancel drain |
| `/通过 [taskId]` | 通过指定 Task 的确认请求（仅 `supervised` 模式下 P1 挂起的确认） |
| `/驳回 [taskId] [理由]` | 驳回确认请求并附带回退指令 |

> **参数说明**：`/详情 [N]` 中的 N 在 MVP 中为 Task 序号（TaskPlan 内的 Task 列表索引），Phase 2 引入 Stage 后改为 Stage 序号。`/通过` 和 `/驳回` 使用稳定的 `taskId` 而非序号，避免 Stage 重规划导致序号漂移。

---

## 4. 托管模式原则

> **默认托管，最小打扰。仅 P0/P1 级别阻断性问题才挂起并通知用户。**

### 4.1 严重程度分级

| 级别 | 描述 | 策略 | 打扰用户 |
|---|---|---|---|
| **P0 阻断** | Task 彻底卡死、关键依赖失败、数据丢失风险 | 挂起 TaskPlan，通知用户 | ✅ |
| **P1 决策** | LLM 无法自行判断的取舍、高风险操作无默认策略 | 挂起当前 Task，通知用户 | ✅ |
| **P2 异常** | 单 Task 失败但可重试、非关键依赖失败 | 自动重试/跳过，日志记录，汇总报告 | ❌ |
| **P3 常规** | 工具确认、小决策、文件写入 | 自动处理（Task 级一次性授权） | ❌ |

### 4.2 对确认机制的影响

| 机制 | 托管模式下的行为 |
|---|---|
| 工具确认 | Task 级一次性授权范围。中低风险自动处理，高风险仅在超出白名单时上报 |
| Stage ReviewGate（Phase 2+） | LLM 自评审为默认策略。MVP 的动态文档评审使用 §2.2.5 ReviewLoop，不依赖 Stage |
| `ask_user` 工具 | 降级为 P1 时才触发。触发前 Agent 必须已尝试自行解决（查文件/推理） |

### 4.3 interaction_mode 字段

| 模式 | 含义 | 典型场景 |
|---|---|---|
| `interactive` | 保留完整确认能力（当前前台模式） | 聊天界面实时协作 |
| `supervised` | 托管为主，关键决策通知用户 | 桌面后台任务 |
| `dedicated` | 几乎完全托管，仅 P0 上报 | IM 远程任务 |

**作用域**：`interaction_mode` 在 TaskPlan 级别设定，子级（Stage/Task）可以**收紧**（如开发 TaskPlan 中某个高风险 Task 升级为 `interactive`），但不能放宽。例如：`dedicated` TaskPlan 中的某个 Stage 可以设为 `supervised`，但 `interactive` TaskPlan 中的 Task 不能降为 `dedicated`。

**P0-P3 × interaction_mode 决策矩阵**：

| 严重级别 | `interactive` | `supervised` | `dedicated` |
|----------|--------------|-------------|------------|
| **P0 阻断** | ✅ 通知用户，挂起 TaskPlan | ✅ 通知用户，挂起 TaskPlan | ✅ 通知用户，挂起 TaskPlan |
| **P1 决策** | ✅ 通知用户，挂起当前 Task | ✅ 通知用户，挂起当前 Task | ⚠️ 降级为 P2 自动处理（`dedicated` 场景通常无人值守） |
| **P2 异常** | ⚠️ 通知但不挂起 | ❌ 自动重试/跳过，日志记录 | ❌ 自动重试/跳过，日志记录 |
| **P3 常规** | ❌ 自动处理 | ❌ 自动处理 | ❌ 自动处理 |

**关键原则**：
- P0 在任何模式下都上报——这是真正的阻断性故障，无人值守也不应被忽略
- P1 在 `dedicated` 下被降级处理——因为 IM 远程场景用户不可能实时响应，Agent 需自行做最佳决策
- P2/P3 在所有模式下都自动处理——这是"默认托管"的核心承诺

---

## 5. SubAgent：执行后端

### 5.1 定位

SubAgent 不是一个独立概念实体，而是 Task 的**执行后端选择**。调度器根据 `agentType` 选择后端，所有后端履行同一契约：**接收 Task.instruction，交付 Task.output**。上游调度器不感知后端差异。

### 5.2 后端范围与演进

**MVP 只启用 `builtin`。** `agentType` 的 MVP 数据校验只接受 `builtin`，默认值也是 `builtin`；创建 API、调度器、权限 UI 和验收测试均不得暴露或自动选择 Codex。这样 MVP 的安全承诺全部由 SpaceAssistant 宿主侧执行和验证。

下表中的 Codex 是 Phase 2+ 候选能力，不属于 MVP：

| agentType | 后端 | 适用场景 | 可用性 |
|---|---|---|---|
| `builtin` | `runToolChatSession`（HTTP API） | MVP 全部任务 | MVP 唯一后端 |
| `codex` / `codex-required` | Codex CLI 子进程（JSON-RPC） | 重度编码、复杂多步骤任务 | Phase 2+；满足 §8.6 准入门槛后才可启用 |

MVP 不存在自动 fallback。Phase 2+ 即使启用 Codex，也不得由调度器默认选择或静默 fallback：后端变更会改变权限边界，必须在执行前形成可审计的显式选择。

#### 5.2.1 `agentType` 的 required vs preferred 语义

以下语义仅为 Phase 2+ 预留，且 `agentType` 联合类型必须同时包含两者：

| 语义 | 含义 | Codex 不可用时的行为 |
|------|------|---------------------|
| `agentType: 'codex'`（preferred） | 用户显式允许 Codex，也允许改用 builtin | Codex 不可用时挂起并请求用户确认是否改用 builtin，不静默降级 |
| `agentType: 'codex-required'` | 必须使用 Codex，不允许降级 | Task 标记为 `failed`，P1 通知用户：「需要 Codex CLI 但环境不可用」 |

`codex-required` 的典型场景：依赖 Codex 特有的工具链（如 Codex 沙箱中才能执行的重度重构），降级到 builtin 无法完成任务。用户在创建 Task 时可按需显式声明。

### 5.3 成本选项：TaskAgentConfig

每个 Task 可配置执行成本，匹配不同复杂度：

```ts
interface TaskAgentConfig {
  model?: string;              // 覆盖默认模型
  thinkingLevel?: 'low' | 'medium' | 'high';  // 推理强度
  maxTokens?: number;
  codexCliPath?: string;       // Phase 2+；MVP 不接受该字段
  toolAllowlist?: string[];    // builtin 专属：裁剪工具集；MVP 校验并拒绝 Shell/脚本/任意子进程工具
}
```

用户可在 TaskPlan 级别设定默认值，每个 Task 可覆盖。典型用法：调研 Task 用 `thinkingLevel: 'low'` + 便宜模型；编码 Task 用 `thinkingLevel: 'high'` + 强模型。

### 5.4 三个核心需求

| 需求 | 实现 |
|---|---|
| 给定目标，交付结果 | Task.instruction → Agent 执行 → Task.output |
| 上下文隔离 | MVP builtin：Task 独立 Session；Phase 2+ codex：独立 CLI 子进程及可验证沙箱 |
| 可配置成本 | `agentConfig.model` + `agentConfig.thinkingLevel` |

### 5.5 与已有 CLI Subagent 设计的关系

已有 `cli-subagent-integration-design` 中的 `dispatch_subagent` 是**主 Agent 工具循环内**的一个工具（主 Agent 在对话中主动委派子任务）。后台 Task SubAgent 是在**调度器层**选择后端，不经过主 Agent 工具调用。

两者不冲突且可整合，但复用进程管理层不等于满足安全准入。Phase 2+ 的 CodexRunner 只有通过 §8.6 的沙箱与并发验证后，才能从 TaskDispatchService 调用。

---

## 6. 执行进度的 UI 展现

### 6.1 总体布局

点击 Activity Bar 任务图标后，主区域切换为任务面板。左侧 328px 侧栏作为任务列表，右侧主区域展示任务详情。

```
Activity Bar   侧栏 (328px)     主区域（任务面板）
┌────┐ ┌──────────────────┐ ┌──────────────────────────────┐
│    │ │ 任务列表           │ │ TaskPlan 详情                │
│ 💬 │ │                  │ │                              │
│ 📖 │ │ 🔄 登录模块开发    │ │ ✅ 需求文档                  │
│ 📋 │ │   3/5 阶段        │ │ ✅ 技术设计                  │
│    │ │                  │ │ 🔄 代码实现 3/7              │
│ ⚙  │ │ ⏸️ 销售报告       │ │ ⏳ Code Review               │
└────┘ └──────────────────┘ └──────────────────────────────┘
```

Activity Bar 任务图标在存在运行中或暂停的 TaskPlan 时，显示橙色圆点指示。

### 6.2 三层视图

| 层 | 视图 | 内容 |
|---|---|---|
| 1 | 任务列表（左侧栏） | 所有 TaskPlan，按 `updated_at` 降序，显示名称、阶段进度、状态图标、时间 |
| 2 | TaskPlan 详情（右侧主区域） | 所有 Stage + Task 概览；ReviewLoop 作为单个稳定节点，内部展开迭代历史 |
| 3 | Task 详情（在右侧展开或替换） | 单个 Task 的完整信息（见 §6.3） |

**排序规则**：TaskPlan 列表按 `updated_at` 降序排列。`updated_at` 的更新触发条件包括：
- TaskPlan 自身的状态变更
- 任何下属 Task 的状态变更（`pending` → `running` → `completed`/`failed`）
- 阶段 3 的结果投递消息写入

这确保用户最关心的「最近有活动的 TaskPlan」始终排在列表顶部。

### 6.3 Task 详情信息架构

Task 详情合并三块信息：元信息、执行过程（= 只读对话时间线）、产出物。**执行过程即完整对话上下文，不做额外拆分。**

```
┌─ Task 详情：注册 API ───────────────────────────────────┐
│                                                          │
│  ═══════════ 元信息 ═══════════                           │
│  后端：Codex  ·  模型：gpt-5.6-sol  ·  推理：medium       │
│  状态：执行中  ·  已运行 4m 32s  ·  重试：0               │
│  输入：「根据 design/login.md 实现注册 API…」              │
│                                                          │
│  ═══════════ 执行过程（只读对话时间线）═══════════          │
│                                                          │
│  🤖 我来分析设计文档…                                     │
│  🔧 read_file design/login.md              ✅ 1.2s      │
│     [展开内容 ▸]                                         │
│  🤖 设计文档定义了三个端点…                                │
│  🔧 read_file req/login.md                 ✅ 0.8s      │
│  🤖 现在查看现有路由结构…                                 │
│  🔧 grep "router" src/                      ✅ 1.5s      │
│  🤖 开始编写 auth 路由文件…                               │
│  🔧 write_file src/routes/auth.ts           🔄           │
│     ┌──────────────────────────────────────┐            │
│     │ + import { Router } from 'express'  │            │
│     │ + const authRouter = Router()       │            │
│     │ [正在写入…]                         │            │
│     └──────────────────────────────────────┘            │
│  🔧 read_file src/routes/auth.test.ts       ✅ 0.6s      │
│                                                          │
│  ═══════════ 产出 + 操作 ═══════════                      │
│  产出摘要：「成功实现注册 API，所有测试通过。」              │
│  变更文件：src/routes/auth.ts (+86) …                     │
│  [重新执行]  [跳过]                                       │
└──────────────────────────────────────────────────────┘
```

**元信息字段**：

| 字段 | 来源 | 说明 |
|---|---|---|
| 后端类型 | `Task.agentType` | Codex / builtin |
| 模型 | `Task.agentConfig.model` | 实际使用的模型 |
| 推理强度 | `Task.agentConfig.thinkingLevel` | low / medium / high |
| 状态 | `Task.status` | 带状态图标 |
| 已运行时间 | `Task.startedAt` → now | 实时更新 |
| 重试次数 | `Task.retryCount / retryPolicy.maxRetries` | 失败后展示 |
| 任务描述 | `Task.description`（给用户看） | 高层描述；`Task.instruction` 给 Agent 的精确指令可在展开区查看 |

**执行过程**：LLM 文本与工具调用以只读时间线交错展示，类似聊天视图但无交互。工具调用卡片可折叠（复用 ToolCallCard 类似模式），LLM 长文本可折叠（类似 ThinkingBlock）。无独立的「查看对话上下文」入口——用户已经在看完整上下文。

**产出物区**（仅 completed / failed 状态展示）：

| 字段 | 来源 |
|---|---|
| 产出摘要 | `Task.output.summary` |
| 命名交付物 | `Task.output.deliverables`：显示 key、标题、类型、版本、当前/已失效状态和文件链接 |
| 输入来源 | `TaskInputBinding`：显示本 Task 实际消费的上游交付物及 revision |
| 文档关系 | `ArtifactRelation`：例如“评审 design.md rev-1”“基于 review.md rev-1 修订” |
| 变更文件列表 | 从 `task_steps` 中提取 write_file / edit_file 调用 |
| 失败原因 + 重试状态 | failed 状态专属 |

**操作按钮**：

| 操作 | 出现条件 | 语义 |
|---|---|---|
| [重新执行] | completed / failed | 重跑当前 Task；其所有传递下游结果失效并按拓扑序回到 `pending`，待新 output 成功后重新执行。操作前展示影响范围 |
| [跳过此 Task] | failed | 将当前 Task 标记为 `skipped`；依赖它的下游同步 `skipped`，无关分支继续执行 |
| [暂停] | running | 暂停当前 TaskPlan（同 §2.6 #A，留接口） |
| [取消] | running | 按 §2.2.3 原子失效 queued/running/confirming/cancelling attempt；进入“正在取消”，资源 drain 成功后才显示 `cancelled` |
| [重试取消] | 因 `plan_cancel_timeout` 暂停 | 重新发送取消并继续等待原 drain 集合；不降低 generation、不创建新 attempt |

#### 6.3.1 ReviewLoop 详情

ReviewLoop 节点默认查询父 Task 当前 generation 对应的 ReviewLoopRun，显示当前轮次、最大轮次、producer/reviewer 状态及每轮被评审 revision、review 文档和 verdict。重跑前的 run 按 generation 收入“历史运行”，只读保留且不得与当前 iteration 混排：

```text
需求说明评审循环（第 3/5 轮）
  1. requirement@rev-1 → review@rev-1 → revise
  2. requirement@rev-2 → review@rev-2 → revise
  3. requirement@rev-3 → review 进行中
```

达到上限且 `onExhausted='pause'` 时显示：[提高上限并继续]、[接受当前版本]、[取消计划]。接受当前版本必须二次确认并填写理由；操作生成审计记录，不能伪造 reviewer 的 pass verdict。

### 6.4 Step 更新的实时推送策略

```
主进程：                             渲染进程：

tool call 开始
  └→ IPC 'task:step-started'  ──→   防抖队列 (50ms)
tool progress 更新
  └→ IPC 'task:step-progress' ──→   防抖队列合并
tool call 完成
  └→ IPC 'task:step-done'     ──→   立即 flush
task:progress (statusText)
  └→ IPC 'task:progress'      ──→   50ms 防抖
```

与现有 `chatRunnerService.ts` 中 `scheduleUiFlush` + `pendingUiPatches` 的 rAF 合并模式一致。

---

## 7. 与聊天界面协同

### 7.1 发起

- 用户在聊天/IM 中触发需求澄清（阶段 1）
- 确认后，当前会话插入"任务已提交"系统消息
- 用户可继续在此会话中或自由切换到其他会话

### 7.2 关联

- "任务已提交"消息和"任务完成"消息均可点击跳转到任务面板
- 紧急通知（P0/P1）同时在原会话插入提示消息

### 7.3 会话排序保障

现有机制天然支持任务完成后发起会话自动置顶（已验证）：

1. `appendMessage(db, msg)` 写入完成消息 → 内部调用 `updateSession(db, sessionId, …)`
2. `updateSession` 设置 `updatedAt = Date.now()`
3. 会话列表查询 `SELECT * FROM sessions ORDER BY updated_at DESC`
4. 专用索引 `idx_sessions_updated_at ON sessions(updated_at DESC)`

→ 即使任务执行了十几个小时、期间用户聊了多条其他会话，完成消息一插入，发起会话自动回到侧栏顶部。

### 7.4 内部 Session 不可见

- 每个 Task 执行时创建的内部 Session 不暴露在会话列表
- 用户通过 Task 详情的只读对话时间线查看 Agent 执行过程

---

## 8. 权限与安全

### 8.1 核心原则

托管模式下，MVP Agent 可自动执行受控文件工具和获授权的浏览器操作；Shell、`run_shell`、`run_script` 及任何可启动任意子进程的工具一律不注册到后台工具集。安全保障通过三层边界实现，且与现有 artifact 系统分工协作：

- **调度器层（新增）**：入口级能力授权——Task 能不能执行某类操作？
- **artifact 层（已有）**：精细归属决策——文件写哪里？属于什么容器？需不需要用户决策？

两层各管各的，不冲突。

**MVP 的三层边界只对 builtin 作出承诺。** Codex 不在 MVP 数据模型和运行路径中；不能用 `cwd`、Agent 自律或 stdout 截断代替文件系统隔离。

### 8.2 第一层：工作目录边界（MVP：builtin）

现有 `pathSecurity.ts` 在 builtin 的受控文件工具入口生效。后台 Task 和前台对话走同一机制：路径需规范化后验证位于工作目录内，并拒绝通过 `..`、绝对路径或符号链接逃逸。这一边界必须由针对读、写、删除各工具的宿主侧测试证明；若某工具不能经过同一校验，则不得加入后台 Task allowlist。

revision store 及 submission staging root 位于应用数据目录中的**宿主保留根**，在 Task workDir 之外，因此普通文件工具的工作目录边界首先会拒绝它们，Agent 文件列表也不可见。作为纵深防御，所有写/编辑/删除/移动/重命名/复制和目录工具仍必须对目标真实路径、已有祖先 realpath 与 inode/link count 做统一 guard，拒绝保留根本体、后代及指向其中 inode 的软/硬链接。只有 `RevisionCommitService` 和 GC 持有宿主 capability，可以写入或清理这些根；普通 Task 授权不能覆盖该限制。

### 8.3 第二层：Task 级授权范围（新增）

每个 Task 在 `agentConfig` 中声明允许的操作。规划 Agent 生成 Task 时按 Stage 类型自动填入默认值。

```ts
interface TaskAuthorizationScope {
  readFiles: boolean;           // 默认 true
  writeFiles: boolean;          // 默认 true
  deleteFiles: boolean;         // 默认 false
  browser: {
    enabled: boolean;           // 默认 false
    allowedDomains?: string[];  // 允许访问的域名
    allowAct: boolean;          // 是否允许交互操作
  };
  maxFileWriteBytes: number;    // 单次写入上限
}
```

MVP schema 不接受 `shellCommands` 配置，避免 `enabled: false` 被误解为可按 Task 开启。命令前缀分析/白名单不是文件系统隔离：`npm` lifecycle、Python/Node、`git -C` 和子进程都能绕开受控文件工具。因此 Shell/脚本只能在 Phase 2+ 获得 OS 级沙箱并通过 §8.6 等价准入测试后加入。后台工具注册采用显式 allowlist；浏览器下载、外部应用启动、插件工具等任何可能间接写盘或启动进程的能力，未接入相同授权、配额和 generation 校验前同样禁用。

不同场景的默认授权：

| 场景 | 读文件 | 写文件 | Shell / 脚本 | 浏览器 |
|---|---|---|---|---|
| 软件开发 | ✅ | ✅ | ❌（MVP 硬禁用） | ❌ |
| PDF 导入 | ✅ | ✅ | ❌ | ❌ |
| 调研汇总 | ✅ | ✅ | ❌ | ✅（允许 navigate，不容许 act） |

**越权处理**：

| 级别 | 行为 |
|---|---|
| P3（授权范围内但需确认的操作） | 自动放行 |
| P1（超出授权范围但可补救） | 挂起当前 Task，通知用户 |
| P0（超出授权范围且危险） | 立即拒绝，挂起 TaskPlan，P0 上报 |

**托管模式下的 artifact 决策适配**：

| 决策点 | 托管模式行为 |
|---|---|
| 路径决策 | LLM 自行决定路径 → 走 `agent-default` 来源，不问；仅路径歧义影响安全时才上报 |
| 归属决策 | 规划 Agent 预填容器归属：开发 Task → `project`，调研/报告 Task → `package`，临时文件 → `scratch` |
| 覆盖已有文件 | 允许覆盖（Task 描述明确要求修改时） |


### 8.4 第三层：资源上限（防失控）

> **数值状态**：初始估算值（以重度开发 Task 为基线 +30%），待 MVP 实测后校准。计划预览中的高级设置可按 Task 自定义上限。

以重度开发 Task 为基线 +30%，仅用于检测失控，不限制正常执行：

| 资源 | 重度基线 | 上限 | 适用范围 |
|---|---|---|---|
| `maxToolCalls` | 1500 | **2000** | MVP builtin，宿主计数 |
| `maxFileWriteCount` | 50 | **65** | MVP builtin，按成功的写工具事件计数；同一路径重复写入重复计数 |
| `maxFileWriteBytes` | 50 MB | **65 MB** | MVP builtin，宿主按实际写入字节累计 |
| `maxRevisionStoreBytesPerPlan` | — | **1 GB（初始值）** | 计划保留的去重 blob 物理占用；提交前检查 |
| `maxRevisionStoreBytesGlobal` | — | **10 GB（初始值）** | 全局高水位；只触发 GC/拒绝新提交，不删除可达 revision |
| `maxDurationMinutes` | 240 min | **300 min（5h）** | MVP builtin，attempt 看门狗 |

> **注意**：MVP 无独立 PlannerRunner，但 WorkflowCompiler 可以一次生成多个长时 Task；5h 是单 attempt 的防失控兜底，不是整份计划上限，也不代表推荐执行时长。实测后可调整常量而不改变机制。

超限处理：

| 资源 | 超限行为 |
|---|---|
| 工具调用次数 | 强制终止 Task，P1 上报："任务可能陷入循环" |
| 磁盘写入 | 强制终止 Task，P1 上报："写入量已达上限" |
| revision store 预算 | 拒绝 `submit_task_output`，Task 保持未完成并 P1 上报；用户清理无引用历史或提高预算后重试 |
| 执行时间 | 强制终止 Task，P2 自动重试 1 次 |

后续如果实际场景发现不够，调常量即可，不改变机制。

### 8.5 文件写入并发与 attempt 资源租约

MVP 的 builtin 写工具统一接入 `toolWriteConflict.ts` / `pathLeaseRegistry`。路径租约是 **attempt 级运行资源**，不是 Session 记录的一部分：

1. 写操作前以规范化路径 acquire；冲突时显式失败或等待，不允许静默覆盖。
2. 单次工具调用结束可释放该路径；无论采用短租约还是 attempt 内持有，Runner 都必须在 attempt 的 `finally` 中调用 `releaseAllWritePathsForSession(sessionId)` 兜底。
3. Session 完成后继续保留消息记录，不得因此继续持有任何写租约。
4. 重试复用 Session 时仍建立新的 attempt 资源作用域；取消、超时、异常退出与正常完成执行同一释放流程。

依赖边可以避免已知的先后写冲突，但不能替代租约；没有依赖关系的并发 Task 仍可能写同一路径，必须被检测而非最后写入者静默覆盖。提交服务读取 working Artifact 时同样持有读租约，避免 `expectedWorkingHash` 校验与复制内容之间发生 TOCTOU。

### 8.6 高权限后端与工具的 Phase 2+ 准入门槛

CodexRunner、Shell、`run_shell`、`run_script` 或其他可启动任意子进程的工具，只有同时满足以下可自动化验证的条件才可用于后台 Task：

- 使用 OS/CLI 提供的真实沙箱，将可写范围限定为声明的工作目录；明确工作目录外只读/不可见目录、网络、子进程和环境变量策略。仅设置 `cwd` 不合格。
- `readFiles`、`writeFiles`、`deleteFiles` 和磁盘写入上限能由宿主或沙箱强制执行；stdout 截断、静态命令分析和命令前缀白名单均不视为隔离或磁盘配额。
- 接入与 builtin 等价的写冲突协议。若无法接入路径租约，则每个写 Task 必须使用隔离 worktree，并通过受控、冲突可见的合并步骤回写；在此之前禁止 Codex 与任何可能写同一工作树的 Task 并发。
- 有越界读写/删除、符号链接逃逸、资源超限、并发覆盖、取消与异常退出清理的端到端测试。

未达到上述门槛时，Codex 和 Shell/脚本不得进入 `supervised` / `dedicated` 后台运行；Codex 不得作为默认后端或 fallback。它们可保留在独立的前台高权限实验入口，但不属于本文后台执行层承诺。

---

## 9. 与 Artifact（产物）系统的整合

已有 artifact 系统（`electron/artifacts/`）负责文件产物的稳定 ID、路径、分类与展示。后台任务执行层复用它，但现有 `session_artifacts` 只有当前路径和 draft/final 状态，没有不可变 revision 与跨 Task 语义关系，因此需增加 §2.1 定义的版本和关系表，而不是继续用路径数组模拟交付：

| 整合点 | 方式 |
|---|---|
| Task 详情中的变更文件列表 | 查询该 Task 内部 Session 的 `ArtifactRepository.listBySession(sessionId)`；这是“写过的文件”，不等同于正式交付物 |
| Task 正式交付物 | 查询 `task_deliverables` 并关联 `artifact_revisions`；只有完成事务中声明的 deliverable 才能被下游消费 |
| 正式交付入口 | 仅 `submit_task_output` 可发布；普通文件写事件只进入 attempt 写账本，不能自动映射 output key |
| 阶段 3 投递消息中的产出清单 | 聚合当前 generation 的 `task_deliverables`，按 key/类型展示；superseded revision 仅在历史视图中显示 |
| 文件归属 | 后台 Task 默认走 `agent-default` 路径来源（见 §8.3），用户无需逐文件确认 |
| 资源统计 | `maxFileWriteCount` 由 BackgroundTaskEventTarget 对成功的写工具结果累计；ArtifactRepository 只用于产物展示，不作为写次数计数器 |
| 版本 | 每次正式交付由宿主 staging/原子发布创建不可变 revision；`session_artifacts` 继续指向当前活动工作路径，内部 contentLocator 不对 Agent/UI 暴露 |
| 下游读取 | 只允许 `read_task_input(name)` 按 binding 读取并校验 hash；路径型解析器使用无硬链接的 attempt 私有副本 |
| 跨 Task 血缘 | 使用 `artifact_relations`，不复用要求同 Session 的 `packageId`；关系两端都固定到 revision |
| 删除与 GC | Artifact/Session/TaskPlan 删除只 tombstone 当前对象；revision 按数据库可达性保留，GC 只回收宽限期后无引用 blob |

兼容现有 Artifact 字段：`artifactId`、title、container、role、stage 和 canonicalPath 继续复用。`documentType`、`mediaType` 属于交付物语义；现有仅用于写入路由的 `materialKind` 不作为持久化文档类型来源。

---

## 10. MVP 验收标准与测试矩阵

以下为进入实现验收的硬门槛，不能降级为“技术设计阶段评估”：

| 领域 | 必须通过的验收用例 |
|---|---|
| DAG 创建校验 | 拒绝不存在/跨计划/自依赖引用与环；input 的上游必须在 dependsOn，MVP 拒绝 optional input |
| 调度就绪 | 根 Task 可入队；下游仅在所有依赖 completed 且 required input bindings 固化后入队；普通依赖即使不消费 artifact 也生效 |
| 交付物契约 | 拒绝重复/未知/缺失 required key、类型不匹配、无效 Artifact、非当前 attempt 写入和违反 create/revise_input 策略的交付 |
| 显式映射 | 一个 Task 写多个文件但只提交一个时，仅 envelope 指定 Artifact 映射 output key；不按最后写入、文件名或 LLM 文本猜测 |
| Relation 授权 | reviews/revises/derived_from 只能指向 outputContract 允许的 targetInputName；指向未绑定或任意 revision 的关系被拒绝 |
| 原子完成 | revision、deliverable、relation、summary 和 Task completed 要么同事务全部提交，要么全部不可见；下游不能读取部分 output |
| 提交幂等 | 同 submissionId/envelope 和同 output key 重放返回原 revision；同 ID 不同内容、同 key 改绑另一 Artifact 明确失败 |
| 提交失败恢复 | staging/数据库中途失败时 Task 不 completed；同 attempt 修正后可重试，未引用 blob 经宽限期安全 GC |
| 版本稳定性 | 上游在同一路径重写文档会产生新 revision；已入队下游仍绑定原 revision，不会静默读取新内容或 hash 不匹配内容 |
| 文档血缘 | “方案 → 评审意见 → 修订方案”分别产生 `reviews`、`revises`、`derived_from` 关系，并精确指向 revision；关系不触发隐式调度 |
| revision root 防写 | Agent 对 store 执行写/编辑/删除/移动/重命名/复制目标均被工具网关拒绝；软链接、硬链接和路径别名逃逸也失败 |
| 安全读取与并发 | Agent 看不到 contentLocator；两个 Task 并发 `read_task_input` 只能读取相同 hash 的只读流，不能获得可变句柄 |
| 输入物化 | 路径型解析使用无硬链接的 attempt 副本；副本 hash 等于 binding revision，修改副本不改变 revision 且不会自动成为 output |
| 路径与删除 | 当前 Artifact 移动、覆盖或 tombstone 后，已绑定 revision 仍可读；删除 TaskPlan/Session 不级联破坏被引用历史 |
| GC 安全 | 数据库提交失败的孤儿 blob 可回收；deliverable/binding/relation/活跃 submission 可达的 blob 永不被 GC |
| 重跑交付物 | 上游重跑将旧 deliverable 标记 superseded、下游旧 binding 随 generation 失效；新下游绑定新 revision，历史链仍可审计 |
| ReviewLoop 首轮 | 稳定 loop Task 启动后只创建一个 iteration-1 producer；producer 发布后只创建一个绑定其 revision 的 reviewer |
| ReviewLoop revise | reviewer 提交 review 文档 + revise 后，原子创建唯一 N+1 producer；其 inputs 固定上一版和本轮 review，输出复用主 Artifact 生成新 revision |
| ReviewLoop pass | pass 必须来自当前 run 的结构化 reviewDecision 且目标匹配 binding；父 loop 通过专用 acceptance 协议原子发布 alias 后 completed |
| ReviewLoop 无环 | 多轮运行始终展开为单向子 Task 链；外部 Task 只能依赖稳定父 loop，不能依赖内部动态 Task |
| ReviewLoop 幂等 | reviewer 完成事件/Controller 恢复重复投递不会创建两个 N+1 producer、两个 iteration 或重复 acceptance publication |
| ReviewLoop 上限 | 达到 maxIterations 仍 revise 时严格执行 fail/pause；不会创建超限轮次，人工接受记录 override 而不改写 verdict |
| ReviewLoop 异常 | 缺失 verdict、自然语言“通过”、错误 target revision、旧 generation decision 均不能推进；producer/reviewer 最终失败传播到父 loop |
| ReviewLoop 多代重跑 | completed/failed/exhausted loop 重跑后，新 generation/run 可从 iteration 1 开始；旧 run/iterations 全量保留且 superseded，唯一键不冲突 |
| ReviewLoop 旧代隔离 | 旧 reviewer decision、旧 Controller 事件和旧人工接受在父 generation 提升后全部 stale，不能推进或发布当前 run |
| ReviewLoop 取消重跑 | 取消/重跑作用域包含旧 run 全部子 Task 和 Controller；drain 前不展开新轮，新 run 只在 drain 后创建 |
| ReviewLoop 多代恢复 | 重启时同时存在多代 iteration，只恢复父当前 generation 对应的 running run；producer/reviewer/N+1 边界不重号漏轮 |
| 父 alias 合同 | 父 outputContract 缺失 accepted key、policy 非 alias_review_acceptance 或类型与 producer 不兼容时拒绝创建计划/发布 |
| 父 alias provenance | alias 引用本轮 producer revision，保留真实 producedBy 并记录 publishedByReviewLoop；不创建伪造父 attempt/revision |
| 父 alias 并发 | pass 与取消/重跑并发、父 generation 失效后晚到发布时，只有条件事务胜者可见；失败方不改父 output/status/下游 |
| 父 alias 幂等 | pass 重复投递和人工接受重复提交返回同一 publication；竞争绑定其他 iteration/revision 明确失败 |
| 父 alias 事务失败 | publication/deliverable/iteration/run/父状态任一步数据库失败均整笔回滚，下游不入队；重试后只产生一份 alias |
| 人工接受 | 仅耗尽暂停状态可用；pending override 必须匹配当前 run/revision，并与 alias/父 completed 同事务转为 consumed；失败不消费、不产生部分 output |
| 传播 | 上游重试时下游等待；最终失败、取消、跳过使全部传递依赖者 `skipped`，无关分支继续 |
| 手动重跑 | B 为 `running` / `confirming` 时重跑其上游 A：闭包内 generation 原子提升、旧 B 收到取消且释放资源后才可启动新代次；取消超时则计划暂停 |
| 晚到 attempt fencing | 旧 attempt 忽略取消并晚到 Step/output/终态时，仅审计 Step 可保留且标记 superseded；条件更新失败，不得改 Task output/status、触发下游或执行新副作用 |
| 新旧代次并发 | 新旧 attempt 竞争同一路径时，新代次不会在旧代次终止前启动；不存在跨 generation 静默覆盖 |
| 安全边界 | builtin 受控工具对越界读、写、删除及符号链接逃逸均拒绝；`readFiles` / `writeFiles` / `deleteFiles` / Browser 授权和写入量上限由宿主强制执行 |
| Shell/脚本禁用 | 创建配置和 `toolAllowlist` 拒绝 `run_shell` / `run_script` 及任意子进程工具；Python/Node 绝对路径与 `../` 写入、符号链接逃逸、npm lifecycle、目录外删除和大量写盘在进程启动前即被拒绝，而非仅警告 |
| attempt 清理 | Task A 写文件完成且 Session 保留后，Task B 能写同一路径；Task A 失败、取消、超时或抛异常后结果相同 |
| 并发写入 | 两个无依赖的 builtin Task 并发写同一路径时至少一个收到显式冲突，不发生静默覆盖 |
| 持久化一致性 | 重复投递同一 `(attemptId, eventId)` 不产生重复 Step；窗口关闭期间执行、重开后可完整回放 |
| 软件开发主路径 | 用户只输入“开发登录模块”并完成必要澄清，即可预览并一次创建需求 ReviewLoop→技术方案 ReviewLoop→详细开发方案 ReviewLoop→实现→实现报告/汇总的完整工作流；无需逐 Task 创建或手工连边 |
| 无 Stage 语义等价 | 预览中的 phase 串行关系全部物化为 Task `dependsOn`，阶段内并行节点共享正确前置；删除/更改 phase 展示字段不改变调度结果 |
| 文档评审门等价 | 需求、技术方案和详细开发方案评审均编译为 ReviewLoop；未取得当前 revision 的 pass/accepted alias 时后续 phase 的 Task 不可入队 |
| Agent 能力隔离 | Agent 工具表只包含 prepare，不包含 create/confirm；Agent 直接调用内部 create、发送“用户已确认”文本或伪造确认参数均被拒绝且不创建/启动计划 |
| 确认来源绑定 | 无确认、跨 actor/Session/窗口确认、过期页面确认均不能创建；确认 IPC 的 origin 从主进程 sender 派生，不能由 Renderer 参数指定 |
| 确认作用域绑定 | prepare 后 workDir realpath/identity、Session 归属、interactionMode、授权范围、工具集、资源上限或安全配置版本任一变化，旧草案失效并要求重新预览 |
| 确认消费与重放 | confirmation 与计划创建/根入队同事务；失败不留下部分记录。成功后的相同请求只返回原计划；其他来源重放或二次消费不能创建第二份 |
| 幂等冲突 | `(actorId, originSessionId, idempotencyKey)` 下同 key 同 preparedDraft/hash 返回原计划；同 key 更换草案/hash 明确返回 idempotency_conflict |
| 草案原子性 | draftKey、依赖、input/output contract 或 ReviewLoop 配置任一无效时整份 prepare/create 失败，不残留部分 TaskPlan/Task |
| MVP 代码评审边界 | 包含 code/目录/manifest/git diff accepted output 的 ReviewLoop 草案以 unsupported_code_review_loop 拒绝；普通多文件实现可运行并逐文件交付，但 UI/结果不得标记“代码版本已评审通过” |
| 前台事件兼容 | 原生 WebContents 通过 ToolLoopEventTarget 类型检查；所有既有 channel/payload 和渲染行为保持不变；约 30 个非阻塞发送点不改，3 类确认请求迁入 Resolver 后仍发送相同协议 |
| 无窗口执行 | BackgroundTaskEventTarget 在无 WebContents 时完整执行；已知 channel 被集中映射，窗口重开后可回放 |
| 后台事件映射 | 约 13 类 channel 均有显式映射测试；未知 channel 在测试失败、生产审计告警，不静默丢成“已持久化” |
| 流式写入控制 | 文本/thinking delta 被节流聚合到 Session 消息，不逐 token 创建 Step；tool use/progress/result 按 toolUseId/seq 幂等更新 |
| 后台事件收尾 | 同步 send 经有界有序队列异步持久化；正常完成前 flush，取消/异常 finally 中限时 flush；最后一批事件未落库时不得报告成功 |
| 后台事件回压 | 队列高水位仅合并 delta/同工具 progress；离散事件不丢弃，无法入队时 attempt 以 event_delivery_overflow 显式失败并留审计 |
| DecisionResolver 等价性 | 前台三类确认继续走现有 IPC/registry，IM 继续走 remote owner，后台按 TaskAuthorizationScope/interactionMode 决策 |
| 后台确认挂起 | 后台 P0/P1 确认持久化并使 Task confirming；回复绑定 execution token，批准后恢复同一 attempt |
| 确认取消竞态 | confirming 时取消/重跑会关闭 Resolver pending；晚到 allow/deny 返回 stale，不启动工具、不修改 Task 状态 |
| 取消混合状态 | 同时存在 queued + running + confirming 时取消：原子提升 generation、关闭确认注册表并覆盖全部 attempt；延迟 allow/deny 返回 stale |
| 取消提交隔离 | running attempt 忽略 AbortSignal 并晚到 Step/output/终态：仅审计 Step 可保留，其他提交均被条件更新拒绝 |
| 取消完成时机 | 仅全部 attempt 写入 `finishedAt` + `resourcesReleasedAt` 后显示 `cancelled`；此前保持 `cancelling`，Session、Step、output 保留 |
| 取消超时 | 超时进入带 `plan_cancel_timeout` 的 `paused`，不显示成功且禁止恢复/重跑/新 attempt；重试取消复用原 drain 屏障 |
| 取消与重跑串行化 | 重跑 drain 期间取消计划会把同一 operation 提升为 plan_cancel 并扩展作用域；plan_cancel 期间重跑/恢复被拒绝，不产生并行 drain |
| 取消崩溃恢复 | 应用在 `cancelling` / `paused(plan_cancel_timeout)` 中退出并重启后，从持久化 drain 集合恢复等待与收尾，不把 Task 重新入队 |
| MVP 后端边界 | 创建 API 拒绝非 `builtin` agentType；UI 无 Codex 默认/fallback；相关测试不依赖 Codex CLI |

## 11. 待解决事项追踪

| # | 问题 | 状态 |
|---|---|---|
| #1 | 后台 Session 不列在聊天侧栏，用户在哪查看？ | ✅ 已解决：独立任务面板 + 完成消息投递 + 会话自动置顶 |
| #2 | Task 详情的执行过程与对话上下文是否重复？ | ✅ 已解决：合并为只读对话时间线，同一信息源 |
| #3 | 权限与安全模型 | ✅ MVP 已解决：builtin 三层边界；Codex 需通过 Phase 2+ 沙箱准入门槛 |
| #4 | 资源上限怎么设？ | ✅ MVP 已解决：重度基线 +30%，标注为初始估算值，由 builtin 宿主侧统计与强制执行 |
| #5 | 内部 Session 生命周期（创建/标记/关联/清理） | ✅ 已解决：完整生命周期定义（§2.3），sessions 表扩展方案待技术设计评估 |
| #6 | `sender: WebContents` 依赖与后台调度器架构冲突 | ✅ 已解决：结构兼容 ToolLoopEventTarget + BackgroundTaskEventTarget，不重写现有 IPC 发送层 |
| #7 | Task 间结构化数据传递 | ✅ 已解决：命名 deliverable、稳定 artifactId、不可变 revision、输入绑定与文档血缘（§2.2） |
| #8 | interaction_mode 与 P0-P3 的映射 | ✅ 已解决：4×3 决策矩阵（§4.3） |
| #9 | Task attempt 与 Session 生命周期冲突 | ✅ 已解决：记录长期保留，运行资源在每个 attempt 的 `finally` 释放 |
| #10 | 跨后端并发写入 | ✅ MVP 已规避：builtin-only；Codex 启用前须接入租约或隔离 worktree |
| #11 | Shell/脚本绕过文件边界与配额 | ✅ MVP 已规避：后台工具集与配置 schema 硬禁用；真实 OS 沙箱后再启用 |
| #12 | 重跑与旧 attempt 竞态 | ✅ 已解决：generation fencing、条件提交、取消等待和超时暂停 |
| #13 | TaskPlan 取消晚到副作用 | ✅ 已解决：统一 invalidation/drain、confirm 失效、资源释放后提交取消及超时恢复 |
| #14 | 文档型交付物链路 | ✅ 已解决：方案/评审/修订均作为版本化交付物，并记录精确消费与关系 |
| #15 | revision store 可被 Agent 修改 | ✅ 已解决：宿主保留根、工具网关 inode/realpath guard、只读输入工具与无硬链接物化副本 |
| #16 | output key 缺少正式提交协议 | ✅ 已解决：`submit_task_output`、attempt 写账本、合同/关系校验、幂等 staging 发布 |
| #17 | 动态评审循环 | ✅ 已解决：稳定 ReviewLoop Task、有限无环展开、结构化 verdict、上限/恢复/取消语义 |
| #18 | ReviewLoop 重跑轮次身份冲突 | ✅ 已解决：独立 ReviewLoopRun、父 generation 贯穿子 Task/decision/recovery、多代历史隔离 |
| #19 | 父 accepted output 绕过提交协议 | ✅ 已解决：专用 acceptance publication、alias policy/provenance、原子 fencing 与幂等发布 |
| #20 | ProgressSink 重构范围过大 | ✅ 已解决：MVP 保留既有 channel 和约 30 个非阻塞发送点，仅集中桥接事件；只重构 3 类阻塞确认分支 |
| #21 | 无 Stage 的 MVP 软件开发体验不可用 | ✅ 已解决：WorkflowCompiler 自动生成完整 DAG；phase 仅展示，跨阶段依赖编译为 Task 边，交付物评审编译为 ReviewLoop，用户只需一次确认 |
| #22 | WorkflowCompiler 确认可被 Agent/跨作用域绕过 | ✅ 已解决：Agent-only prepare、host-only confirm/create；一次性确认绑定 actor/session/surface/workDir/授权/hash，并与计划创建同事务消费 |
| #23 | MVP 代码 ReviewLoop 缺少不可变多文件版本 | ✅ 已收敛：MVP ReviewLoop 限文档 Artifact；代码评审降至 Phase 2+ CodeChangeSet/ArtifactBundle + 受控 apply/merge 后启用 |
| #A | 暂停/恢复的精细语义 | 留接口；取消语义已完成 |
| #B | 一般崩溃恢复 / 断点续传 | 留接口；drain operation 的崩溃恢复已纳入 MVP |
| #D | 规划 Agent 产出是否需用户确认 | ✅ MVP 已解决：桌面必须由原 actor/session/surface 显式确认绑定执行作用域的固定 hash；Agent 无创建能力。IM 创建计划属于 Phase 2+，届时另定授权策略 |

---

## 12. 讨论完成度总结

- [x] **核心机制**：MVP 以 TaskPlan/Task DAG 运行，Stage 保留为 Phase 2+ 目标模型；TaskDispatchService 调度器、TaskProgressBus 事件总线
- [x] **自动工作流生成**：当前会话 Agent 只能 prepare TaskPlanDraft；宿主专用确认事务绑定 origin/execution scope 并原子物化，软件开发主路径不要求用户手工建 Task 或连边
- [x] **交互机制**：三阶段模型（聊天澄清 → 任务面板执行 → 结果投递）、托管模式原则、IM 远程指令扩展
- [x] **SubAgent**：MVP 收敛为 builtin-only；Codex required/preferred 语义和可验证准入门槛留待 Phase 2+
- [x] **与聊天界面协同**：会话自动置顶、内部 Session 不可见、阶段 1/3 在聊天中完成
- [x] **执行进度 UI 展现**：Activity Bar 任务图标、任务面板三视图、Task 详情 = 只读对话时间线、操作按钮语义明确
- [x] **权限与安全**：MVP builtin 三层边界（工作目录 + Task 授权 + 资源上限），Codex 不以 `cwd` 冒充沙箱
- [x] **Artifact 系统整合**：复用稳定 artifactId/路径能力，新增不可变 revision、正式交付物与跨 Task 血缘
- [x] **事件兼容适配**：WebContents 收窄为结构 EventTarget，前台 IPC 不变，后台集中映射约 13 种 channel
- [x] **确认决策分离**：ToolLoopDecisionResolver 独立处理前台、后台与 IM 的阻塞式确认
- [x] **Session 生命周期**：内部 Session 创建/标记/关联/清理完整定义
- [x] **Task DAG 与数据传递**：稳定 ID `dependsOn`、命名 deliverable、输入 revision 绑定、失败传播与重跑失效
- [x] **文档交付链**：方案、评审意见、修订方案通过 reviews/revises/derived_from 关系精确关联版本
- [x] **Revision 不可变性**：内部路径不暴露、Agent 写能力强制拒绝、只读 input 工具、可达性 GC
- [x] **结构化提交**：outputContract 决定 Artifact 创建/复用与 relation 授权，提交可重放且耐崩溃
- [x] **动态评审循环**：producer/reviewer 按轮展开，外部依赖稳定父节点，直到 pass 或有限上限
- [x] **MVP 评审范围**：ReviewLoop 仅接受文档 revision；多文件代码评审等待不可变 bundle 与受控 apply/merge，不以可变工作树冒充通过版本
- [x] **ReviewLoop 多代运行**：每个父 generation 对应独立 run，重跑从 iteration 1 开始且旧历史可审计
- [x] **父 accepted alias**：Controller 专用原子发布协议，不伪造 Agent attempt，保留真实 producer provenance
- [x] **Attempt 资源生命周期**：所有退出路径在 `finally` 释放租约等运行资源，独立于 Session 记录保留
- [x] **重跑隔离**：传递下游 generation 提升、旧 attempt 取消等待、条件提交与晚到回调 fencing
- [x] **TaskPlan 取消**：覆盖 queued/running/confirming/cancelling，令牌原子失效，drain 完成后才提交 cancelled
- [x] **Drain 持久化**：单计划串行 operation、取消优先级、超时与崩溃恢复
- [x] **持久化一致性**：BackgroundTaskEventTarget 是后台 Step 唯一写入入口，使用 `(attemptId, eventId)` 幂等键
- [x] **托管模式决策矩阵**：P0-P3 × interaction_mode 4×3 矩阵明确
- [x] **资源上限**：标注初始估算值，MVP 由 builtin 宿主侧统计和强制执行
- [x] **Shell/脚本边界**：MVP 后台硬禁用，命令分析与前缀白名单不作为安全隔离
- [x] **Task 模型**：拆分 `instruction`（给 Agent）和 `description`（给用户）
- [x] **reviewGate**：增加 `onReject` 行为定义
