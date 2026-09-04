# 后台任务执行层设计 v2

> 状态：MVP 候选稿（整体剪枝 + 滚动窗口规划）
> 日期：2026-07-20
> 依据：从 `background-task-execution-layer-design.md` v14 反向裁剪

---

## 1. 文档目的

本文只定义 SpaceAssistant 后台任务执行层的**第一个可验证闭环**：

```text
用户描述目标
  → Agent 生成粗粒度路线图和首批 Task
  → 用户预览目标、授权信封和近期计划并确认一次
  → 后台执行当前批次
  → planner 根据已完成交付物渐进生成下一批 Task
  → 文档交付物可经过有限评审循环
  → 结果回到原会话
```

本版本不试图提前覆盖完整工作流平台。判断一个设计是否进入 MVP，只看它是否是上述闭环的必要条件，而不看它未来是否可能有用。

### 1.1 成功标准

MVP 成功需同时满足：

1. 用户不需要逐个创建 Task、手工连接依赖边或在开始时审查完整复杂 DAG。
2. 关闭任务面板不影响执行；重新打开后能查看已持久化进度。
3. Task 只能使用计划确认时授予的目录和工具能力。
4. 下游 Task 读取上游已提交的固定 revision，而不是可变路径。
5. 文档可以执行“产出→评审→修订”的有限循环。
6. 完成或失败后，原会话收到一条结果消息。

### 1.2 MVP 场景

| 场景 | MVP 覆盖 |
|---|---|
| 软件开发 | 首先生成粗路线图和需求阶段 Task；需求通过后再规划技术方案，方案通过后再规划实现，不要求首轮预见所有文件和依赖 |
| 调研汇总 | 先确定课题范围，再根据首轮发现追加补充调研或进入汇总；汇总绑定各报告 revision |
| 批量处理 | 首批样本验证处理方式后，再展开剩余同构 Task，避免一开始生成大量错误节点 |

软件开发是目标产品的核心场景，但 MVP 只验证后台编排和文档评审闭环。代码测试执行、不可变多文件 Code Review 和自动合并不在本版本承诺内。

---

## 2. 范围与非目标

### 2.1 MVP 必须包含

- 桌面聊天中的路线图、授权信封、首批 Task 预览和一次确认。
- 滚动窗口规划：每次只追加当前里程碑所需的少量 Task。
- `TaskPlan → Task[]` 平面增量 DAG；Task 带 milestone 展示字段。
- builtin Runner，复用 `runToolChatSession` 的核心循环。
- 独立内部 Session，不污染聊天会话列表。
- 固定并发槽位、依赖就绪判断和失败传播。
- 正式交付物、不可变 revision 和固定输入绑定。
- 仅面向单文档交付物的动态 ReviewLoop。
- 任务列表、Task 详情、取消和失败重试。
- 工作目录、工具 allowlist、写入量和执行时长限制。
- 完成/失败结果投递回原会话。

### 2.2 明确不做

以下能力不得以“留个字段”的方式进入 MVP 实现：

- Stage 运行时、Stage 状态机和通用 reviewGate。
- 独立 PlannerRunner；MVP 的 planner Task 仍复用 builtin Runner，只是使用只读工具集和专用提交协议。
- Codex Runner、Shell、`run_script` 和任意子进程工具。
- IM 创建、确认、暂停或控制后台计划。
- `interactive/supervised/dedicated` 多套托管模式；MVP 只有一种桌面托管策略。
- 运行中暂停/恢复。
- 人工强制接受未通过或迭代耗尽的 ReviewLoop。
- 已完成上游的任意重跑及下游级联失效。
- 取消流程的跨进程 drain 恢复。
- 通用 Artifact 关系图和通用工作流条件分支。
- 不可变多文件 `CodeChangeSet`、代码 ReviewLoop 和受控 merge。
- 自动清理仍被引用的历史 revision；MVP 只清理确定无引用的临时 blob。

这些能力只有在 MVP 数据证明有必要时，才单独立项设计。

---

## 3. 产品流程

### 3.1 生成与确认

1. 用户在现有聊天中描述长时目标。
2. 当前 Agent 读取项目上下文，生成 3～6 个粗粒度 milestone、授权信封和**仅首个 milestone** 的具体 Task。
3. Agent 调用 `prepare_task_plan(draft)`；此阶段不能写文件或启动后台执行。
4. 主进程展示路线图、首批 Task、自动扩展策略、授权范围和预算上限。
5. 用户可以要求 Agent 修改，或在原预览界面点击“确认并执行”。
6. 主进程原子创建 TaskPlan 和首批 Task，然后释放原聊天会话。

Agent 没有确认或创建计划的能力。Agent 输出“用户已确认”不产生任何授权效果。

### 3.2 后台执行

- 任务面板展示计划状态、可运行 Task、当前活动 Task 和最近步骤。
- 调度器只根据已物化 Task 的依赖和并发槽位运行；milestone 只限定渐进规划 frontier，不作为通用 Stage 状态机。
- 每个 agent Task 使用一个内部 Session；ReviewLoop 父节点不启动 Agent。
- 当前 milestone 的顶层 Task 全部完成后，Controller 创建一个只读 planner Task。planner 读取目标、路线图和已接受交付物，决定追加下一批 Task 或完成计划。
- 用户离开或关闭任务面板后继续执行；窗口关闭时是否继续取决于应用是否仍驻留，应用进程退出则停止。

### 3.3 结束与回传

- 全部已物化顶层 Task 完成后不会自动结束；最终 planner 必须提交合法的 `complete_plan`，证明路线图目标已经由现有交付物覆盖，TaskPlan 才完成。
- 任一关键 Task 最终失败后，其依赖者跳过，TaskPlan 失败；无关的已运行分支可以完成。
- 计划终态写入后，在原会话追加系统消息，包含状态、耗时、交付物和“查看任务详情”入口。

---

## 4. 最小数据模型

MVP 新增 **12 张表**。现有 `sessions` 和 Artifact 基础表继续复用，只增加必要字段或索引。表数量不是目标；目标是每张表只保存不可从其他事实确定性推导的信息，并避免用宽表/JSON 隐藏互斥角色。

### 4.1 表清单

| 表 | 目的 |
|---|---|
| `prepared_task_plans` | 保存待确认草案、可信执行作用域、确认和幂等状态 |
| `task_plans` | 计划身份、来源会话、路线图、规划 frontier 和整体状态 |
| `tasks` | 所有 Task 共享的调度身份、状态、依赖、合同、里程碑和幂等来源 |
| `agent_task_details` | agent Task 的 instruction、授权、Session 和结构化结果 |
| `planner_task_details` | planner Task 的 roadmapVersion、分析预算、Session 和 expansion 结果 |
| `review_loop_task_details` | ReviewLoop 父 Task 的配置和 accepted 结果 |
| `review_loop_members` | producer/reviewer 子 Task 与父 loop generation/iteration/role 的关系 |
| `task_attempts` | 每次 agent/planner Task 执行尝试及 generation fencing |
| `task_steps` | 工具调用和进度回放 |
| `artifact_revisions` | 正式交付内容的不可变 revision |
| `task_deliverables` | Task output key 到 revision 的发布关系 |
| `task_input_bindings` | 下游实际读取的上游 revision 快照 |

不为未来查询便利预建额外实体。能从上述记录确定性派生的状态不单独建表。

### 4.2 PreparedTaskPlan

```ts
interface PreparedTaskPlan {
  id: string
  schemaVersion: 1
  normalizedDraft: TaskPlanDraft
  draftHash: string

  originSessionId: string
  actorId: string
  originWebContentsId: number
  workDirIdentity: string
  executionScope: PlanExecutionScope
  executionScopeHash: string

  status: 'prepared' | 'consumed' | 'expired' | 'revoked'
  expiresAt: string
  confirmedAt?: string
  consumedAt?: string
  idempotencyKey?: string
  taskPlanId?: string
}
```

确认事实直接记录在 `prepared_task_plans`，不另建 confirmation 表。数据库约束：

- `UNIQUE(actor_id, origin_session_id, idempotency_key)`，其中空 key 不参与唯一性。
- consumed 记录必须有 `confirmedAt`、`consumedAt` 和 `taskPlanId`。
- 同一幂等键重复提交相同 prepared plan 时返回原 TaskPlan；更换草案或 hash 时返回 `idempotency_conflict`。

### 4.3 TaskPlan 与 Task

```ts
interface TaskPlan {
  id: string
  originSessionId: string
  name: string
  goal: string
  workDirIdentity: string
  executionScope: PlanExecutionScope
  roadmap: Milestone[]
  roadmapVersion: number
  currentMilestoneKey: string
  expansionCount: number
  planningPolicy: PlanningPolicy
  status: 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled'
  createdAt: string
  finishedAt?: string
}

interface TaskBase {
  id: string
  taskPlanId: string
  kind: 'agent' | 'planner' | 'review_loop'
  identityKey: string
  createdByTaskId?: string
  name: string
  description?: string
  status: 'pending' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'skipped'

  dependsOn: string[]
  inputSpecs: TaskInputSpec[]
  outputContract: TaskOutputSpec[]

  milestoneKey: string
  milestoneName: string
  milestoneOrder: number

  generation: number
  retryCount: number
  maxRetries: number
}

type Task = AgentTask | PlannerTask | ReviewLoopTask

interface AgentTask extends TaskBase {
  kind: 'agent'
  details: {
    instruction: string
    authorization: TaskAuthorizationScope
    sessionId?: string
    result?: AgentTaskResult
  }
}

interface PlannerTask extends TaskBase {
  kind: 'planner'
  details: {
    roadmapVersion: number
    budget: PlanningPolicy['plannerBudget']
    sessionId?: string
    result?: PlannerTaskResult
  }
}

interface ReviewLoopTask extends TaskBase {
  kind: 'review_loop'
  details: {
    config: ReviewLoopConfig
    result?: ReviewLoopTaskResult
  }
}

interface ReviewLoopMember {
  reviewLoopTaskId: string
  reviewLoopGeneration: number
  iteration: number
  role: 'producer' | 'reviewer'
  memberTaskId: string
}

interface Milestone {
  key: string
  name: string
  objective: string
  order: number
  status: 'pending' | 'current' | 'completed'
}

interface PlanningPolicy {
  maxExpansions: number
  maxTotalTasks: number
  maxTasksPerExpansion: number
  maxMilestones: number
  allowedTaskKinds: Array<'agent' | 'review_loop'>
  plannerBudget: {
    maxReadCallsPerExpansion: number
    maxReadBytesPerExpansion: number
    maxDurationMs: number
    maxModelTokens: number
    maxProtocolSubmitAttempts: number
  }
}

interface TaskInputSpec {
  name: string
  fromTaskId: string
  deliverableKey: string
  required: true
}

interface TaskOutputSpec {
  key: string
  kind: 'document' | 'code' | 'data' | 'media' | 'other'
  required: boolean
  documentType?: 'requirement' | 'design' | 'review' | 'report' | 'other'
}

interface ReviewLoopConfig {
  acceptedOutputKey: string
  maxIterations: number
  initialProducerTemplate: TaskTemplate
  revisionProducerTemplate: TaskTemplate
  reviewerTemplate: TaskTemplate
}

interface TaskTemplate {
  name: string
  instruction: string
  outputContract: TaskOutputSpec[]
  authorization: TaskAuthorizationScope
}

interface AgentTaskResult {
  summary: string
  reviewDecision?: {
    verdict: 'pass' | 'revise'
    targetRevisionId: string
    requiredChanges?: string[]
  }
}

interface PlannerTaskResult {
  summary: string
  planExpansion: PlanExpansionDraft
}

interface ReviewLoopTaskResult {
  summary: string
  acceptedArtifactId: string
  acceptedRevisionId: string
  acceptedProducerTaskId: string
}
```

数据库 `tasks` 只保存 `TaskBase` 公共列。角色详情分别存于 `agent_task_details`、`planner_task_details`、`review_loop_task_details`，以 `task_id` 作为 PK/FK；ReviewLoop producer/reviewer 关系存于 `review_loop_members`。普通列表、依赖和状态归并查询只读 `tasks`，不需要 kind 分支；角色执行通过一个共享 Repository 按 kind 连接且必须恰好找到对应详情行，返回上述判别联合。只有 `TaskKindDispatcher`、对应 Controller/Runner 和角色详情 UI 做一次穷尽 `switch(task.kind)`，禁止散落 `if (task.reviewLoopConfig)` 或检查 nullable 字段是否存在。

`roadmap`、`dependsOn`、计划期 input/output 合同和小型配置在 MVP 中存 JSON；不为 milestone、DAG edge、expansion、output spec、review decision 分别建表。创建和每次扩展时由宿主完整校验。

数据库至少保证：

- Task ID 全局唯一且属于同一 TaskPlan；`createdByTaskId` 非空时必须引用同计划 Task，用统一 provenance 表示由 planner 或 ReviewLoop Controller 动态创建。
- `UNIQUE(task_plan_id, identity_key)` 统一承担所有角色的幂等身份，不再为每种 kind 增加专属唯一列：初始节点为 `initial:<draftKey>`，planner 为 `planner:<roadmapVersion>`，渐进节点为 `expansion:<plannerId>:<expansionKey>:<draftKey>`，评审子节点为 `review:<loopId>:<generation>:<iteration>:<role>`。
- `review_loop_members` 使用 `UNIQUE(review_loop_task_id, review_loop_generation, iteration, role)` 和 `UNIQUE(member_task_id)`，并要求父/子属于同一 TaskPlan。
- 数据库 `CHECK kind IN ('agent','planner','review_loop')`；各详情表 INSERT/UPDATE trigger 校验关联 Task kind。Task 与详情必须由同一 Repository 在一个事务写入，事务提交前断言每个 Task 恰好存在一张匹配详情记录。
- `generation >= 1`。

### 4.4 Attempt 与 Step

```ts
interface TaskAttempt {
  id: string
  taskId: string
  generation: number
  attemptNo: number
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'superseded'
  startedAt?: string
  finishedAt?: string
  usage?: {
    readCalls: number
    readBytes: number
    mutationCalls: number
    protocolSubmitAttempts: number
  }
  error?: string
}

interface TaskStep {
  id: string
  taskId: string
  attemptId: string
  generation: number
  eventId: string
  kind: 'text' | 'tool' | 'artifact' | 'usage'
  status: 'running' | 'completed' | 'failed'
  summary?: string
  createdAt: string
  updatedAt: string
}
```

`UNIQUE(attempt_id, event_id)` 防止事件重放产生重复 Step。文本流必须聚合，不能每个 token 写一行。

### 4.5 Revision、Deliverable 与 InputBinding

```ts
interface ArtifactRevision {
  id: string
  artifactId: string
  contentHash: string
  contentLocator: string
  byteSize: number
  createdByTaskId: string
  createdByAttemptId: string
  createdAt: string
}

interface TaskDeliverable {
  id: string
  taskId: string
  generation: number
  key: string
  kind: 'document' | 'code' | 'data' | 'media' | 'other'
  artifactId: string
  revisionId: string
  producerTaskId: string
  producerAttemptId: string
  acceptedByReviewLoopTaskId?: string
  createdAt: string
}

interface TaskInputBinding {
  id: string
  taskId: string
  generation: number
  inputName: string
  fromTaskId: string
  deliverableKey: string
  artifactId: string
  revisionId: string
}
```

关键唯一键：

- `UNIQUE(task_id, generation, key)`
- `UNIQUE(task_id, generation, input_name)`
- `UNIQUE(artifact_id, content_hash)` 可复用相同内容，但 revision 读取始终通过 revision ID。

下游只通过 `read_task_input(inputName)` 读取 binding 指向的固定内容；Agent 不读取 revision store 路径。

---

## 5. 计划准备与原子创建

### 5.1 TaskPlanDraft

```ts
interface TaskPlanDraft {
  name: string
  goal: string
  roadmap: Array<{
    key: string
    name: string
    objective: string
    order: number
  }>
  initialTasks: TaskDraft[]
  planningPolicy: PlanningPolicy
  requestedExecutionEnvelope: TaskAuthorizationScope
}

interface TaskDraftBase {
  draftKey: string
  name: string
  description?: string
  milestoneKey: string
  dependsOn: TaskDraftRef[]
  inputs: TaskInputDraft[]
  outputs: TaskOutputSpec[]
}

type TaskDraft = AgentTaskDraft | ReviewLoopTaskDraft

interface AgentTaskDraft extends TaskDraftBase {
  kind: 'agent'
  instruction: string
  authorization: TaskAuthorizationScope
}

interface ReviewLoopTaskDraft extends TaskDraftBase {
  kind: 'review_loop'
  reviewLoopConfig: ReviewLoopConfig
}

type TaskDraftRef =
  | { draftKey: string }
  | { taskId: string }

interface TaskInputDraft {
  name: string
  from: TaskDraftRef
  deliverableKey: string
  required: true
}

interface PlanExecutionScope {
  maxTaskAuthorization: TaskAuthorizationScope
  initialTaskScopes: Record<string, TaskAuthorizationScope>
  maxConcurrentTasks: number
}

interface PlanExpansionDraft {
  expansionDraftKey: string
  basedOnRoadmapVersion: number
  action: 'append_tasks' | 'complete_plan'
  rationale: string
  tasks?: TaskDraft[]
  remainingRoadmap?: Array<{
    key: string
    name: string
    objective: string
    order: number
  }>
}

interface TaskAuthorizationScope {
  readFiles: boolean
  writeFiles: boolean
  deleteFiles: boolean
  browserNavigate: boolean
  maxToolCalls: number
  maxProtocolSubmitAttempts: number
  maxWriteCount: number
  maxWriteBytes: number
  maxDurationMs: number
}
```

roadmap 只表达用户能理解的粗粒度方向和当前规划 frontier，不预先展开完整 DAG。`initialTasks` 必须全部属于首个 milestone；调度语义始终来自已经物化的 Task 依赖边。

### 5.2 prepare_task_plan

`prepare_task_plan` 是 Agent 可调用的唯一计划工具。主进程必须：

1. 从当前工具调用上下文派生 actor、Session、WebContents 和 workDir，不接受草案提供这些值。
2. 校验 roadmap 有序且 key 唯一、首批 Task 只属于第一个 milestone，并校验 draft key、依赖、DAG、input 来源、output key 和 ReviewLoop 合同；初始草案不得使用尚不存在的稳定 taskId。
3. 校验 planningPolicy 有有限正上限；把 `requestedExecutionEnvelope` 限制在当前 Session 已有能力内，并要求首批及后续每个 Task 的授权都是该 envelope 的子集。
4. 规范化路线图、首批 Task、规划策略与执行作用域，计算覆盖全部内容的 `draftHash`。
5. 保存短期 PreparedTaskPlan，并向原窗口展示预览。

### 5.3 confirm-prepared-task-plan

专用确认 IPC 只接受：

```ts
{
  preparedTaskPlanId: string
  expectedHash: string
  idempotencyKey: string
}
```

主进程根据 IPC sender 和当前会话映射校验确认来源。Renderer 不能传 actor、Session、workDir 或授权范围。

在一个数据库事务中：

1. 锁定 prepared plan，校验状态、有效期、hash 和原窗口当前展示的预览。
2. 重新计算 workDir identity 和 execution scope；发生变化时撤销草案并要求重新预览。
3. 写入 `confirmedAt` 和幂等键。
4. 分配 Task ID，将首批 Task 的 draft key 引用改写为稳定 ID。
5. 创建 TaskPlan、路线图、首批 Task 和可运行根节点的初始状态。
6. 将 prepared plan 更新为 consumed 并写入 `taskPlanId/consumedAt`。

任一步失败整笔回滚。`create_task_plan` 只是上述事务内的宿主函数，不注册为工具或 Renderer API。

### 5.4 渐进扩展协议

当前 milestone 的顶层 Task 全部 completed 后，Controller 为当前 `roadmapVersion` 创建唯一 planner Task。planner 仍复用 builtin Runner，但只能使用：

- `get_planning_context({ cursor? })`：批量返回目标、路线图、已物化 Task 摘要、accepted deliverable 摘要和预算余量，避免 planner 用大量细碎查询拼接上下文；宿主必须按剩余 readBytes 截断/分页并返回 cursor，不能单次超额返回后再记账；
- `read_task_input` 和只读项目文件工具，用于按需展开少量关键内容；
- 唯一写型宿主工具 `submit_plan_expansion(draft)`。

planner 不能写项目文件、调用浏览器、修改既有 Task、直接创建 TaskPlan，也不能提高授权或预算。

planner 不使用普通 Task 的 `maxToolCalls`，而使用 `planningPolicy.plannerBudget` 的每 expansion 独立预算：所有只读/查询工具调用（包括失败调用和分页请求）累计 `readCalls`，实际返回内容累计 `readBytes`，并同时限制时长和模型 token。缓存命中仍计调用次数，但按实际返回字节计量。预算在每个 planner attempt 创建时固定，重试不会继承上次已消耗额度，但仍受 retry 次数和全计划 expansion 上限约束。

`submit_plan_expansion` 是终态协议调用，不计入 `readCalls`，否则 planner 恰好用完分析额度后将无法安全提交；它单独计入 `protocolSubmitAttempts` 并受小额上限约束。读预算耗尽后，网关拒绝新的读取，但保留一次协议提交机会，planner 可以基于已取得上下文提交结果。超过协议尝试上限、时长或 token 上限时 attempt 以 `planner_analysis_budget_exceeded` 失败，不追加部分 Task。

`submit_plan_expansion` 在一个事务中：

1. 校验 planner attempt/generation 仍有效，`basedOnRoadmapVersion` 等于当前版本。
2. `complete_plan` 只在除当前 planner 外的所有已物化顶层 Task completed、当前 milestone 可完成且没有 pending milestone 时可接受；planner 不能跳过尚未处理的路线图后缀直接宣布完成。
3. `append_tasks` 只能追加到当前 frontier 或其后第一个 pending milestone；不得给已运行/完成 Task 增加依赖、替换 input binding 或修改已接受交付物。
4. 校验新批次 DAG、跨批依赖、input/output contract 和 ReviewLoop 合同；新 Task 只能依赖已有 Task或本批更早的 draft key。
5. planner 可以用 `remainingRoadmap` 替换**当前 milestone 之后尚未展开的路线图后缀**，以适应新信息；已完成/current milestone 的 key、目标和顺序不可改。替换前后内容、理由和版本保存在 planner Task result/Step 中供审计。
6. 校验 `maxExpansions`、`maxTotalTasks`、`maxTasksPerExpansion`、`maxMilestones`、allowedTaskKinds 及原 execution scope；任何扩权、扩预算或越过用户确认目标的请求均失败为 `planning_envelope_exceeded`。
7. 原子分配 Task ID、写入本批 Task、按目标 milestone 决定保持或推进 frontier、更新 roadmapVersion/expansionCount，并完成 planner Task。

相同 `(plannerTaskId, expansionDraftKey)` 重放返回原批次；同 key 不同内容明确冲突。旧 roadmapVersion 的晚到规划结果为 stale。

`maxTotalTasks` 统计计划内全部 Task 行，包括 planner 和 ReviewLoop 动态子 Task；ReviewLoop 在创建前必须预留其 `maxIterations` 对应的最坏任务额度，防止通过内部展开绕过规划预算。

“当前 milestone 顶层 Task 全部完成”指该 milestone 中不属于 ReviewLoop 内部子节点、也不是 planner 的已物化 Task 全部 completed。planner 若向当前 milestone 追加补充 Task，frontier 保持不变；只有向下一个 milestone 追加首批 Task 时，才把当前标记 completed、下一个标记 current。

MVP planner 只能返回 `append_tasks` 或 `complete_plan`。无法在授权信封内可靠决定下一步时，planner Task 和 TaskPlan 以 `planning_blocked` 失败并把原因投递给用户；不为此引入通用暂停、问答恢复或运行时扩权协议。

---

## 6. 调度与执行

### 6.1 就绪规则

Task 进入 queued 必须满足：

- 所有 `dependsOn` Task 均 completed。
- 每个 required input 都能解析到上游当前 generation 的 deliverable。
- 在同一事务创建全部 `TaskInputBinding` 和 queued attempt。

依赖失败、取消或跳过时，下游标记 skipped。无关分支不受影响。

只有已经物化的 Task 参与就绪查询。调度器不得因为 roadmap 中存在未来 milestone 就假造其 Task；当前批次完成后由 §5.4 的 planner 明确追加。

### 6.2 Runner

MVP 只有 builtin Runner：

```text
TaskDispatchService
  ├─ ReadyTaskQuery
  ├─ SlotManager
  ├─ PlanningFrontierController
  ├─ ReviewLoopController
  └─ BuiltinTaskRunner
       └─ runToolChatSession
```

每个 agent/planner Task 创建一个 `visibility='internal'` 的 Session。planner 复用同一 Runner，但注册独立的只读工具集。内部 Session 保留用于详情回放，但不出现在聊天侧栏。

### 6.3 EventTarget 兼容桥

不重写 `runToolChatSession` 的全部 IPC 发送点，只把 sender 收窄为结构接口：

```ts
interface ToolLoopEventTarget {
  isDestroyed(): boolean
  send(channel: string, ...args: unknown[]): void
  flush?(): Promise<void>
}
```

- 前台继续使用 `WebContents`。
- 后台使用 `BackgroundTaskEventTarget`，把已知 channel 聚合写入 Session/Step。
- 后台 `send()` 同步入有界队列；终态提交前必须 flush。
- 未知 channel 在开发/测试时报错，生产记录错误并使 attempt 失败，不能静默丢失。

### 6.4 托管决策

MVP 不实现多 interaction mode，也不持久化运行中确认。计划确认时已展示授权范围：

- 授权内的受控操作自动执行。
- 超出授权的工具调用直接失败为 `authorization_exceeded`。
- 用户若需要扩大权限，只能取消/等待当前计划结束后重新生成并确认新计划。

这样无需 `confirming`、pending confirmation 和暂停/恢复状态。

---

## 7. 正式交付协议

普通文件写入不等于正式交付。agent Task 只能通过宿主工具提交：

```ts
submit_task_output({
  attemptId,
  generation,
  summary,
  outputs: Array<{
    key,
    artifactId,
    expectedContentHash
  }>
})
```

宿主执行：

1. 校验 attempt 是 Task 当前 generation 的活动 attempt。
2. 校验 output key、kind 和必填项符合合同。
3. 在读租约内读取工作文件并核对 hash。
4. 将内容写入 content-addressed blob；同 hash 可复用。
5. 在一个数据库事务中写 ArtifactRevision、TaskDeliverable、Task result，并把 attempt/Task 标记 completed。

数据库事务失败时，未引用 blob 是可安全清理的孤儿；不为 staging/submission 单独建表。相同 Task/generation/key/hash 的重复提交返回原 deliverable，不同 hash 的重复提交明确冲突。

---

## 8. 文档 ReviewLoop

### 8.1 边界

MVP ReviewLoop 只接受 `kind='document'` 的单一 accepted output。代码、目录、路径列表、git diff 和可变工作树不能作为 accepted output。

### 8.2 运行方式

ReviewLoop 是顶层 DAG 中的稳定父 Task，外部下游只依赖父 Task ID。父 Task 当前 `generation` 同时作为本次 loop run 身份，不另建 run 表。

1. Controller 创建 iteration 1 producer 子 Task。
2. producer 提交文档 revision 后，创建绑定该 revision 的 reviewer 子 Task。
3. reviewer 必须提交 review 文档，并在 Task result 中返回：

```ts
{
  verdict: 'pass' | 'revise'
  targetRevisionId: string
  summary: string
  requiredChanges?: string[]
}
```

4. `pass` 时，Controller 在一个条件事务中为父 Task 写入 accepted deliverable；它指向 producer 的同一 revision，并保留真实 producer provenance，然后完成父 Task。
5. `revise` 时，Controller 创建 iteration N+1 producer，固定绑定上一版文档和本轮 review revision。
6. 达到 `maxIterations` 仍 revise 时，父 Task 失败；MVP 不支持人工强制接受。

动态子 Task 仍存于 `tasks` 表。唯一键保证同一父 generation、iteration、role 只创建一次。重复 Controller 事件不会产生重复子 Task或父 deliverable。

### 8.3 重试

- producer/reviewer 可以按普通 Task retryPolicy 重试。
- ReviewLoop 父 Task 失败后，用户可以重试整个父 Task；宿主提升父 generation，从 iteration 1 重新开始。
- 旧 generation 的子 Task和 deliverable 保留历史，但不能推进新 generation。

---

## 9. 取消、失败与崩溃

### 9.1 Generation fencing

每个 Runner 持有不可变 `(taskId, attemptId, generation)` token。以下入口都必须校验 token 仍是当前值：

- 每次工具副作用之前。
- `submit_task_output`。
- Attempt/Task 终态提交。
- ReviewLoop Controller 推进。

条件更新影响 0 行时，该执行已过期，不能继续提交。

### 9.2 取消

- 取消计划时，事务内将 TaskPlan 置为 cancelling，提升所有非终态 Task generation，并取消 queued attempt。
- running attempt 收到 AbortSignal；generation 提升会立即阻止其后续工具副作用和提交。
- 全部当前进程 Runner 退出并释放资源后，计划置为 cancelled。
- cancelling 期间禁止创建新 attempt 或重试。

MVP 不持久化 DrainOperation。受控 builtin 工具不会启动脱离主进程的子进程；若取消迟迟不能结束，UI 保持“正在取消”，用户可以退出应用。应用退出后旧 Runner 已不存在。

### 9.3 应用重启

启动时：

- queued attempt 可重新调度。
- 上次退出时 running 的 attempt 标记 interrupted，对应 Task 标记 failed。
- completed Task、revision、deliverable 和 input binding 保留。
- cancelling TaskPlan 收敛为 cancelled，因为旧进程 Runner 已不存在。

用户可以重试失败 Task，但 MVP 只允许以下安全重试：目标 Task 已是 failed，且没有任何下游 Task 曾进入 running/completed。其他重跑需求留到后续版本。

---

## 10. 安全与资源边界

### 10.1 工具范围

后台 builtin Task 使用显式 allowlist：

- 允许受控文件读取、写入、编辑和按需删除。
- 可选允许浏览器 navigate；MVP 默认不允许 act 和下载。
- 禁止 Shell、脚本、外部应用启动、插件工具和任意子进程。

planner Task 使用更窄的强制 allowlist：只读项目/交付物和 `submit_plan_expansion`；即使计划的普通 Task 写权限更大，也不能继承给 planner。

### 10.2 工作目录

- 所有文件工具在宿主侧验证规范化路径位于确认时的 workDir 内。
- 校验 realpath 和已有祖先，拒绝 `..`、绝对路径越界和符号链接逃逸。
- revision blob root 位于 Agent 不可见、不可写的宿主保留目录。
- 每个文件副作用前同时校验 authorization scope 和 generation token。

### 10.3 写冲突

复用现有路径冲突能力：

- 写入前获取规范化路径租约。
- 两个并发 Task 写同一路径时至少一个显式失败或等待，不能静默覆盖。
- Runner 的 `finally` 释放该 attempt 的全部路径租约。

### 10.4 资源上限

资源预算按 Task 类型分开，不能用一个 `maxToolCalls` 同时衡量分析型读取和有副作用执行。

**普通 agent Task** 至少限制：

- 普通工具调用次数，并区分只读与 mutation 计数供观测。
- 累计写入字节数。
- 累计写文件次数。
- attempt 执行时长。

**planner Task** 每个 expansion 独立限制：

- 只读/查询调用次数 `maxReadCallsPerExpansion`。
- 返回内容字节数 `maxReadBytesPerExpansion`。
- 模型 token 和 attempt 时长。
- `submit_plan_expansion` 协议尝试次数。

`submit_task_output` 和 `submit_plan_expansion` 都属于终态协议调用，不消耗普通分析/执行调用额度，但有各自的小额尝试上限、幂等键和 generation 校验。这样既保留最后一次安全提交能力，也不能通过反复调用协议绕开资源限制。

初始数值应通过小规模试运行确定，不在需求文档中提前承诺具体常量。任何预算都在用户首次预览的授权信封中展示；运行时不得自动扩大。超限使 Task 以明确错误失败，不产生部分交付或部分 DAG 扩展。

---

## 11. UI 最小范围

### 11.1 计划预览

必须展示：

- 目标、3～6 个 milestone 和当前规划 frontier。
- 首批 Task 的名称、依赖和预期交付物；明确标记后续 Task 将渐进生成，而非隐藏完整 DAG。
- 自动扩展策略：最大扩展轮数、总 Task 数、单批 Task 数、允许的 Task kind，以及每轮 planner 的读取、字节、token、时长和协议提交预算。
- 路线图是可审计的滚动路线图：planner 可修改尚未展开的后缀，但不能修改已完成/current milestone、目标或授权信封。
- ReviewLoop 的最大迭代次数。
- workDir、写入/删除/浏览器权限和资源限制。
- “确认并执行”和“返回聊天修改”操作。

### 11.2 任务面板

MVP 只做两层：

1. TaskPlan 列表：名称、状态、创建时间、活动 Task 数。
2. TaskPlan 详情：按 milestone 分组已物化的 Task DAG/列表，并区分“已规划”与“尚未展开”；点击 Task 展示内部 Session 时间线、Step、交付物和错误。

操作只包含：

- 取消运行中计划。
- 对符合 §9.3 条件的失败 Task 重试。
- 打开交付物。

不提供暂停、恢复、跳过、人工接受 ReviewLoop 或任意节点重跑。

---

## 12. MVP 验收矩阵

| 类别 | 必须通过的场景 |
|---|---|
| 初始规划 | 用户描述目标后能得到粗路线图、授权信封和首批 Task；无需生成或审查完整 DAG，也无需手工创建 Task/连边 |
| 创建授权 | Agent 只能 prepare；直接调用 create、文本伪造确认、跨 Session/窗口确认均失败 |
| 作用域固定 | prepare 后 workDir、权限或安全配置变化时旧草案失效 |
| 创建原子性 | 草案无效或事务中途失败不留下半份计划；相同幂等请求只创建一次 |
| Task 角色完整性 | 每个 tasks 行恰好有一张与 kind 匹配的详情记录；缺失详情、重复详情或 kind/详情不匹配时事务失败，Repository 不返回半类型对象 |
| Task 类型消费 | 状态列表只依赖 TaskBase；KindDispatcher 对 agent/planner/review_loop 做编译期穷尽分派，新增 kind 会使类型测试失败，不允许按 nullable 字段猜角色 |
| Review 成员关系 | producer/reviewer 通过 review_loop_members 唯一绑定父 loop generation/iteration/role；同一成员不能属于两个位置，跨计划绑定被拒绝 |
| 首批 DAG | 首批串行、并行和扇出扇入正确；循环、缺失引用及引用未来未物化 Task 在 prepare 时被拒绝 |
| 渐进规划 | 当前 milestone 完成后只创建一个 planner；planner 能依据 accepted revision 原子追加下一批 Task，直到合法 complete_plan |
| 规划边界 | planner 不能改写既有 Task/binding/deliverable，不能写项目文件或扩大权限/预算；越界请求以 planning_envelope_exceeded 失败 |
| 扩展预算 | 达到 maxExpansions、maxTotalTasks 或 maxTasksPerExpansion 时不再追加 Task，并以明确错误结束，不进入无限规划循环 |
| 扩展并发与幂等 | 相同 planner/expansionDraftKey 重放不重复追加；旧 roadmapVersion 和并发规划结果不能改变当前 frontier |
| 路线图演进 | planner 只能替换尚未展开的 pending 后缀；已完成/current milestone 不可改，变更前后内容和理由可从 planner Task 回放 |
| 规划阻断 | planner 无法可靠决定下一步时以 planning_blocked 结束并回传原因，不擅自扩权、不进入通用暂停状态 |
| planner 读取预算 | planner 的大量只读分析只消耗本 expansion 的 readCalls/readBytes，不占普通执行 Task 的 maxToolCalls；批量 planning context 能减少细碎调用 |
| planner 安全收尾 | readCalls 恰好耗尽后拒绝继续读取，但仍允许受限的 submit_plan_expansion；提交不被误拒且不能无限重试 |
| planner 预算超限 | read bytes、模型 token、时长或协议尝试数超限时以 planner_analysis_budget_exceeded 失败，不追加部分 Task、不自动提高预算 |
| 后台执行 | 关闭任务面板后继续执行；重新打开能回放已持久化 Session/Step |
| 输入固定 | 上游工作文件在下游启动前变化时，下游仍读取 binding 的原 revision |
| 正式交付 | 普通文件写不产生 deliverable；合同完整的 submit 才能完成 Task |
| 提交幂等 | 同 output/hash 重试返回原 deliverable；同 key 不同 hash 明确冲突 |
| 文档 ReviewLoop | revise 至少运行两轮；reviewer 每轮绑定精确 revision；pass 后下游只看到 accepted revision |
| ReviewLoop 上限 | 达到 maxIterations 仍 revise 时父 Task 失败，不自动通过、不弹人工接受 |
| 代码评审边界 | code/目录/manifest/git diff 作为 ReviewLoop accepted output 时 prepare 失败 |
| 失败传播 | 关键 Task 失败后依赖者 skipped，无关分支可完成，计划最终 failed |
| 取消 fencing | 取消后旧 attempt 的工具副作用、output 和终态提交均被 generation 拒绝 |
| 崩溃恢复 | 重启后 running attempt 变 interrupted/failed；已完成交付物不丢失 |
| 安全 | 越界读写删除、符号链接逃逸、未授权工具和资源超限全部由宿主拒绝 |
| 并发写入 | 两个 Task 写同一路径不会静默覆盖，结束后租约全部释放 |
| 结果回传 | 计划完成/失败后原会话收到一条可跳转详情的系统消息 |

---

## 13. 实施顺序

按可运行闭环分五步实现，每一步都应能独立演示：

1. **单 Task 后台化**：TaskPlan/Task/Attempt/Step、内部 Session、任务面板和结果回传。
2. **首批 DAG 与计划确认**：PreparedTaskPlan、粗路线图、首批 Task、原子确认和依赖调度。
3. **正式交付物**：ArtifactRevision、TaskDeliverable、固定 input binding、`read_task_input`、`submit_task_output`。
4. **渐进规划**：PlanningFrontierController、只读 planner Task、原子扩展和规划预算。
5. **文档 ReviewLoop**：动态 producer/reviewer、有限迭代、accepted alias。

如果第 1 步不能证明后台执行和 UI 有实际价值，停止后续投入；不要先实现 ReviewLoop、通用工作流或远期后端。

---

## 14. 后续能力的准入原则

后续版本不是按原 v14 清单自动恢复功能。新增实体前必须回答：

1. 已有 12 张表为什么不能表达该需求？表数量不是拒绝新表的理由，但新表必须消除真实的语义混合或保存不可推导事实。
2. 是否已有 MVP 用户数据证明该能力必要？
3. 能否先用更窄的产品约束避免新状态机？
4. 新实体的唯一事实源是什么，删除它会损失哪项不可推导信息？

只有答案明确时，才考虑 Stage、持久化 Drain、人工 Review override、Artifact relation、CodeChangeSet、Codex 或 IM 控制面。
