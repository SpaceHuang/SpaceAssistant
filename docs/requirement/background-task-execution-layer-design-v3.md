# 后台任务执行层设计文档 v3

> 状态：讨论稿
> 日期：2026-07-21
> 核心方向：从“静态 DAG 工作流引擎”收敛为“受控的 Codex 自治任务托管层”

---

## 1. 概述

SpaceAssistant 需要支持长时间、可中断、可审计的后台任务：用户描述目标并确认执行边界后，可以离开当前会话；系统在后台持续推进，必要时请求用户决策，完成后将结果投递回发起会话。

本版本不再假设复杂目标能够在执行前被完整拆成稳定的原子 Task DAG，也不把 Codex 当成只负责执行预定义步骤的弱 Worker。对于软件开发、复杂调研和故障排查等开放任务，Codex 本身具备规划、探索、调整边界、验证和内部协作能力。宿主若试图预先理解并调度全部语义步骤，不仅会引入庞大的工作流状态机，还会降低 Codex 的有效能力。

因此，核心模型调整为：

> **Codex 拥有认知控制权，宿主拥有执行控制权。**

- Codex 决定如何完成目标：分析、规划、执行、调整路线、内部委派、验证和修订。
- SpaceAssistant 决定执行是否被授权、资源是否充足、副作用是否安全、结果是否耐崩溃、运行是否真正停止。
- 用户确认的是目标、成功标准、权限和预算，不是一张容易过期的完整执行图。
- Codex 的内部计划和子 Agent 结构不成为宿主的领域模型；宿主只观察结构化进展、资源、事件和结果。
- Codex 被视为几乎不可侵入的黑盒 CLI/会话；所有正确性要求必须由进程、私有 worktree、原生事件、结果导入和宿主事务保证，提示词约定只用于增强体验。

### 1.1 适用场景

| 场景 | 任务特征 | 推荐执行模型 |
|---|---|---|
| 软件开发 | 路线会随代码、测试和评审结果变化 | 自治 Mission |
| 复杂调研 | 需要动态扩展或收缩调查范围 | 自治 Mission |
| 故障排查 | 下一步依赖上一轮观察结果 | 自治 Mission |
| PDF 分页 OCR | 结构固定、大量同构工作单元 | 后续可选静态 Workflow |
| 固定格式转换 | 输入输出和步骤稳定 | 后续可选静态 Workflow |

MVP 只实现自治 Mission。静态 Workflow 是独立的后续能力，不要求自治任务退化成 DAG。

### 1.2 与旧方案的主要变化

| 旧方案 | v3 |
|---|---|
| 执行前生成完整 Task DAG | 只生成并确认 Mission 目标与边界 |
| Task 是计划、调度、权限和交付单位 | AgentRun 是执行生命周期；Mission 是授权与结果单位 |
| 宿主负责 DAG 就绪和失败传播 | Codex 自行决定下一步，宿主不理解语义依赖 |
| ReviewLoop 是特殊 Task 状态机 | Codex 自主修订；Review 只绑定不可变版本并给出裁定 |
| 每个 Task 一个内部 Session | 每个 AgentRun 一条统一事件时间线 |
| 子 Agent/动态 Task 进入持久化模型 | Codex 内部委派对宿主不透明 |
| Task 间通过 input binding 传递产物 | Mission 最终交付物和 Review 输入绑定不可变 revision |
| MVP builtin-only | MVP 目标后端为受控 Codex；未通过安全准入不得进入托管运行 |

### 1.3 不变的关键结论

本次收敛删除的是宿主的语义编排，不删除执行安全内核。以下原则继续成立：

- Agent 无权自行确认、创建或扩大 Mission 的执行作用域。
- 每次进入正式工作树、Artifact、Candidate、Review、外部系统或 Mission 状态的副作用都必须经过宿主授权、预算和 generation fencing；Codex 内部修改仅允许发生在私有 sandbox/worktree。
- Generation fencing 只承诺保护宿主正式状态；不假设可以在 Codex 内部每个文件操作或 Shell 命令前注入校验。
- 取消意图生效与执行资源真正停止是两个阶段。
- 正式交付物必须固化为不可变 revision，不能从工作树、路径列表或模型文本推断。
- 多文件代码评审必须绑定不可变 CodeChangeSet，不能评审可变工作树。
- 后台任务必须有独立可见 UI、事件回放和结果投递。

---

## 2. 产品闭环

MVP 的完整闭环为：

```text
用户描述目标
  → Mission Intake Skill 获取上下文并澄清关键歧义
  → 生成 Mission Brief 和结构化 MissionDraft
  → prepare_mission 生成预览
  → 用户确认目标、成功标准、权限、预算和交付合同
  → 宿主原子创建 Mission 并启动 Codex AgentRun
  → Codex 自主规划、执行、调整、内部委派和验证
  → 宿主持续维护 RunSnapshot，并记录可选 ProgressNote
  → Codex 退出，宿主扫描私有 worktree、验证并导入不可变 Candidate
  → 按策略执行独立 Review
  → Mission 完成或等待用户
  → 结果投递回原会话
```

用户无需：

- 逐个创建 Task；
- 手工绘制依赖边；
- 在执行前确认全部步骤；
- 关注 Codex 内部创建了多少子 Agent；
- 在每个普通工具调用前确认。

用户始终可以查看当前策略、最近进展、资源消耗、风险、交付物和评审结果，并可取消运行。

---

## 3. Mission Intake Skill：从简单输入到可靠委托

用户通常只会提供一句简短目标，例如“开发登录模块”或“把这份 PDF 导入知识库”。这类输入不足以直接授权一个可能持续数小时、修改大量文件并调用外部能力的后台 Run。在 `prepare_mission` 之前，系统需要一个受理与澄清环节，把模糊意图收敛成可确认、可验证、可授权的 `MissionDraft`。

MVP 使用 `background-mission-intake` Skill 承担该职责。它运行在发起会话的现有 Agent 中，不创建独立 PlannerRunner，不启动后台执行，也不生成完整 Task DAG。

### 3.1 使用流程

```text
用户简单输入
  → Mission Intake Skill 判断是否适合后台执行
  → 只读获取必要项目上下文
  → 区分事实、默认值、推断和真正缺失的信息
  → 只澄清会实质改变目标或边界的问题
  → 生成用户可读 Mission Brief + 结构化 MissionDraft
  → 调用 prepare_mission
  → 宿主规范化授权和预算并生成可信预览
  → 用户在确认 UI 中确认
```

Skill 的输出是“可靠的执行委托”，不是执行计划。它可以提供非绑定的初始策略摘要，帮助用户理解大致方向，但 Codex 在 AgentRun 中可以根据实际观察调整路线。

### 3.2 适用性判断

Skill 首先判断请求是否适合创建后台 Mission。

适合的典型特征：

- 执行时间较长或包含多轮探索、实现和验证；
- 用户不需要持续参与每一步；
- 存在可描述、可验证的最终结果；
- 所需能力可以被当前宿主安全授权；
- 即使执行路线改变，目标和边界仍然相对稳定。

不适合的典型特征：

- 简单问答或一次性小操作；
- 需要与用户持续结对决策；
- 核心产品取舍尚未确定，无法定义成功标准；
- 主要操作超出当前安全能力；
- 高风险、不可逆操作占任务主体；
- 用户只是要求分析、评审或诊断，没有授权实际修改。

不适合时，Skill 应解释原因并继续使用普通会话处理，不能为了进入后台模式而人为扩大任务。

### 3.3 只读上下文获取

澄清前，Skill 可以在发起会话已有的只读权限内获取必要上下文：

- 仓库结构、`AGENTS.md` 和项目说明；
- package scripts、测试、构建和类型检查方式；
- 相关需求、设计和现有实现；
- 工作目录和当前工作区状态；
- 已知安全配置和可用执行能力。

该阶段禁止写文件、执行会改变项目或外部系统状态的命令，以及启动 Mission。能够从可信项目上下文确定的信息不应再次询问用户。

### 3.4 澄清原则

Skill 不机械地固定询问 3–5 个问题，而是按照信息来源决定处理方式：

| 信息类型 | 处理方式 |
|---|---|
| 可从可信项目上下文确定 | 自动读取并记录来源 |
| 可使用安全、低影响默认值 | 写入预览，允许用户修改 |
| Agent 推断但存在不确定性 | 明确标注推断和置信度 |
| 会实质改变目标、权限、安全、成本或交付结果 | 必须向用户澄清 |

必须澄清的典型问题包括：

- 需求存在多个明显不同的合理解释；
- 是否包含 UI、后端、数据迁移或兼容性改造；
- 是否允许删除、覆盖或进行不可逆变更；
- 是否需要保持特定兼容性或明确排除某些范围；
- 成功标准涉及尚未决定的产品取舍；
- 可写目录或外部系统作用域无法安全推断；
- Shell、网络或浏览器能力会显著改变风险边界；
- 是否必须由独立 Reviewer 或用户验收。

问题应尽量一次聚合，但允许在用户回答后继续追问新暴露的关键歧义。简单、边界明确的请求可以零问题直接进入预览。

### 3.5 MissionDraft

Skill 生成的结构化草案建议为：

```ts
interface MissionDraft {
  name: string

  objective: {
    goal: string
    includedScope: string[]
    excludedScope: string[]
    assumptions: MissionAssumption[]
  }

  successCriteria: SuccessCriterion[]
  outputContract: MissionOutputContract
  reviewPolicy: ReviewPolicy

  requestedCapabilities: {
    readFiles: boolean
    writeFiles: boolean
    deleteFiles: boolean
    shell: boolean
    network: boolean
    browser: boolean
  }

  suggestedBudget: MissionResourceBudget
  initialStrategy?: {
    summary: string
    nonBinding: true
  }
  unresolvedIssues: MissionUnresolvedIssue[]
}

interface MissionAssumption {
  description: string
  source: 'user' | 'repository' | 'default' | 'agent_inference'
  confidence: 'high' | 'medium' | 'low'
  requiresConfirmation: boolean
}

interface MissionUnresolvedIssue {
  description: string
  impact: 'goal' | 'scope' | 'authorization' | 'safety' | 'cost' | 'delivery'
  blocking: boolean
}
```

`requestedCapabilities` 和 `suggestedBudget` 只是 Skill 的请求，不是有效授权。草案不得自行携带可信 actor、surface、workDir identity、安全配置版本或最终 execution scope。

### 3.6 Mission Brief 与预览一致性

Skill 同时生成面向用户的简洁 Mission Brief，至少展示：

- 目标；
- 包含与不包含的范围；
- 关键假设及其来源；
- 完成标准；
- 正式交付物和验证证据；
- 请求的高风险能力；
- Review 策略；
- 尚未解决的问题。

Mission Brief 必须从同一份规范化 MissionDraft 渲染，不能另写一份与结构化草案可能漂移的自然语言总结。最终确认 UI 展示的是宿主规范化后的执行边界，而不是未经校验的 Skill 请求。

### 3.7 退出条件

只有同时满足以下条件，Skill 才能调用 `prepare_mission`：

1. goal 不存在重大歧义；
2. included/excluded scope 足以约束执行；
3. required success criteria 可以验证；
4. required deliverable 和 evidence 已定义；
5. 高风险能力有明确、与目标相关的理由；
6. 不存在 blocking unresolved issue；
7. assumptions 已记录来源、置信度和是否需要确认；
8. 初始策略明确标记为非绑定。

如果条件不满足，Skill 必须继续澄清或说明当前不能安全创建后台 Mission，不能静默替用户补全关键产品决策。

### 3.8 安全边界

Mission Intake Skill 不是安全边界：

- Skill 无权确认、创建或启动 Mission；
- Skill 无权授予 Shell、网络、浏览器、删除或目录外访问能力；
- Skill 无权扩大当前会话的只读澄清权限；
- Agent 文本中的“用户已经同意”不构成可信确认；
- Prompt injection、错误推断或草案遗漏不能绕过宿主校验。

主进程仍须从可信调用上下文派生 actor、Session、surface 和 workDir identity，应用系统能力上限，规范化授权和预算，将全部边界纳入 hash，并要求用户在专用 UI 中确认。

---

## 4. 职责边界

### 4.1 Codex 负责认知决策

Codex 在已确认的目标和授权范围内负责：

- 理解代码库和问题；
- 制定并滚动调整执行计划；
- 决定探索、实现、测试和修订顺序；
- 根据观察结果改变路线；
- 自主创建和管理内部子 Agent；
- 判断何时需要独立 Review 或用户决策；
- 可选调用宿主工具报告语义进展；
- 提交交付物、验证证据和完成说明。

Codex 的内部工作步骤、计划图和委派关系属于执行后端实现，不是 SpaceAssistant 的持久化业务实体。

### 4.2 宿主负责执行控制

SpaceAssistant 主进程负责：

- 用户确认与来源绑定；
- 工作目录、工具、网络和浏览器权限；
- 执行环境启动、监控、取消和资源回收；
- generation fencing 和旧运行隔离；
- 时间、Token、工具调用、并发预算，以及运行期 worktree 磁盘风险监测和交付导入限额；
- 路径安全、写冲突和保留根保护；
- 事件持久化、回压和重放；
- 根据可观察事实维护权威 RunSnapshot；
- 存储 Codex 主动报告或旁路摘要器生成的非权威 ProgressNote；
- Artifact revision、CodeChangeSet 和正式结果发布；
- 按 ReviewPolicy 固化 Assignment、启动 Reviewer AgentRun，并校验版本绑定和结构化裁定；
- 状态归并、任务面板和结果投递。

宿主不负责判断“下一步应该改哪个模块”，也不维护软件开发过程的全局 DAG。

### 4.3 决策归属表

| 决策 | 负责方 |
|---|---|
| 下一步做什么 | Codex |
| 是否改变计划 | Codex |
| 是否内部并行或委派 | Codex |
| 是否放弃某条路线 | Codex |
| 是否需要更多证据 | Codex / Reviewer |
| 能否调用某项工具 | 宿主 |
| 是否超出权限或预算 | 宿主 |
| 是否存在写冲突 | 宿主 |
| 是否接受高风险副作用 | 用户或已确认策略 |
| 运行是否真正结束 | 宿主 |
| 交付物是否不可变、可追溯 | 宿主 |
| 是否满足结构化交付合同 | 宿主 |
| required Review 是否触发 | 宿主按已确认 ReviewPolicy |
| 是否建议额外 Review | Executor Codex；宿主决定是否创建 Assignment |
| 内容质量是否通过 | 确定性验证器 / 独立 Reviewer |

### 4.4 Codex 黑盒兼容契约

SpaceAssistant 不修改 Codex 内部循环，也不要求 Codex 在每次工具或副作用前回调宿主。MVP 只能依赖经过适配测试验证的原生能力和宿主 Wrapper：

```ts
interface CodexBackendCapabilities {
  launch: boolean
  setWorkingDirectory: boolean
  configureSandbox: boolean
  configureApprovalMode: boolean
  streamNativeEvents: boolean
  terminateProcessTree: boolean
  detectExit: boolean

  resumeNativeSession: 'unsupported' | 'experimental' | 'verified'
  structuredOutput: 'unsupported' | 'best_effort' | 'verified'
  customTools: 'unsupported' | 'optional' | 'verified'
}
```

- `verified` 能力可以进入正确性路径。
- `experimental` 只能优化体验，必须有保守 fallback。
- `best_effort` 输出必须按不可信输入校验，缺失时不能自动成功。
- `unsupported` 能力不得成为 MVP 必需条件。

MVP 的最低兼容面为：启动进程、设置私有 cwd/worktree、配置原生沙箱/审批、读取原生输出和退出状态、终止进程树、扫描文件系统。自定义 MCP/工具、精确 Session 恢复和结构化输出即使可用，也只能作为可选增强，除非经过版本化兼容测试升级为 verified。

所有 Codex 交互分为三层：

| 层 | 示例 | 能否承担正确性 |
|---|---|---|
| Codex 原生且 verified | 进程退出、原生事件、沙箱、审批事件 | 可以 |
| 宿主 Wrapper | 私有 worktree、进程组、扫描、hash、验证、导入和数据库事务 | 可以 |
| 提示词/输出约定 | 进展说明、handoff JSON、review JSON | 不可以；必须校验并有缺失 fallback |

对应的宿主适配层保持薄而明确：

```text
CodexRunWrapper
  ├─ WorktreeManager       创建/封存/清理 Run 私有 worktree
  ├─ CodexProcessHost      启动、原生事件、退出和进程树终止
  ├─ NativeApprovalAdapter 可选；仅适配 verified 原生审批
  ├─ WorktreeObserver      diff、稳定点、hash 和 RecoveryBundle
  ├─ HandoffImporter       校验 best-effort 输出并生成 Candidate
  └─ FormalStatePublisher  generation 条件事务、Review 和 apply/merge
```

这些组件不解释 Codex 内部计划，也不要求其内部子 Agent 注册到 SpaceAssistant。

---

## 5. 核心数据模型

### 5.1 Mission

Mission 表示用户确认的一次后台执行委托，而不是执行步骤集合。

```ts
interface Mission {
  id: string
  originSessionId: string
  actorId: string
  originSurfaceId: string

  name: string
  goal: string
  successCriteria: SuccessCriterion[]
  constraints: string[]
  outputContract: MissionOutputContract
  reviewPolicy: ReviewPolicy

  interactionMode: 'interactive' | 'supervised' | 'dedicated'
  authorizationScope: MissionAuthorizationScope
  resourceBudget: MissionResourceBudget
  workDirIdentity: WorkDirIdentity

  status:
    | 'prepared'
    | 'queued'
    | 'running'
    | 'recovering'
    | 'waiting'
    | 'reviewing'
    | 'cancelling'
    | 'paused'
    | 'completed'
    | 'failed'
    | 'cancelled'

  generation: number
  activeRunId?: string
  result?: MissionResult
  createdAt: number
  updatedAt: number
}
```

### 5.2 成功标准与交付合同

```ts
interface SuccessCriterion {
  id: string
  description: string
  required: boolean
  verification:
    | { kind: 'command'; validatorId: string; evidenceKey: string }
    | { kind: 'artifact'; deliverableKey: string }
    | { kind: 'review'; targetKey: string; evidenceKey: string }
    | { kind: 'manual'; confirmationPolicyId: string; evidenceKey: string }
}

interface HostValidatorDefinition {
  id: string
  version: string
  kind: 'command'
  executable: string
  args: string[]
  cwd: 'candidate_worktree'
  environmentPolicyId: string
  timeoutSeconds: number
  passCondition: 'exit_code_zero'
}

interface MissionOutputContract {
  deliverables: Array<{
    key: string
    kind: 'document' | 'code_change_set' | 'data' | 'media' | 'other'
    required: boolean
    title?: string
    mediaType?: string
  }>
  validators: HostValidatorDefinition[]
  requiredEvidence: Array<{
    key: string
    kind: 'test_result' | 'typecheck' | 'build' | 'review' | 'manual' | 'other'
    required: boolean
    criterionIds: string[]
    source:
      | { kind: 'validator'; validatorId: string }
      | { kind: 'review'; targetKey: string }
      | { kind: 'manual'; confirmationPolicyId: string }
  }>
}
```

成功标准既约束 Codex，也构成宿主的完成判定输入。每个 required criterion 在确认前必须规范化为宿主可消费的验证定义：

- `command` 引用同一合同中的固定 `validatorId`。MVP 不引入通用验证 DSL，只支持固定 executable/argv、Candidate 隔离工作区、固定环境策略和超时，并以退出码 0 为通过；命令及策略必须符合已确认的 Shell 授权。
- `artifact` 引用固定 required deliverable key，由宿主检查当前 Candidate 中对应的不可变 revision。
- `review` 引用固定 target key 和 evidence key，由宿主按已确认 ReviewPolicy 创建绑定该 Candidate revision/hash 的 ReviewAssignment。
- `manual` 引用固定 confirmation policy 和 evidence key；只能由策略允许的可信用户针对明确 Candidate revision 确认，不能使用 Codex 文本或 handoff 代替。

`requiredEvidence.criterionIds` 建立 evidence 与 criterion 的显式对应，`source` 决定证据只能由哪个宿主验证器、Review 或人工确认产生。artifact criterion 直接以 `deliverableKey` 绑定交付物，不伪造额外 evidence。宿主校验证据来源、版本绑定和通过状态，不接受 Codex 声明的同名 evidence。required criterion 若没有唯一、闭合且可执行的 verification binding，以及在需要证据时没有对应的 evidence/source 映射，Prepare 必须拒绝。

### 5.3 PreparedMission 与确认

```ts
interface PreparedMission {
  id: string
  schemaVersion: number
  normalizedDraft: MissionDraft
  draftHash: string

  originSessionId: string
  actorId: string
  originSurfaceId: string
  workDirIdentity: WorkDirIdentity
  executionScopeSnapshot: ExecutionScopeSnapshot
  executionScopeHash: string

  status: 'prepared' | 'consumed' | 'expired' | 'revoked'
  createdAt: number
  expiresAt: number
  consumedAt?: number
}

interface MissionConfirmation {
  id: string
  preparedMissionId: string
  draftHash: string
  executionScopeHash: string
  actorId: string
  originSessionId: string
  originSurfaceId: string
  idempotencyKey: string
  status: 'pending' | 'consumed'
  missionId?: string
  confirmedAt: number
  consumedAt?: number
}
```

`draftHash` 必须覆盖规范化目标、成功标准、完整验证定义与 evidence 映射、约束、交付合同、Review 策略、workDir identity、interactionMode、授权范围、工具集、安全配置版本和资源预算。

### 5.4 AgentRun

AgentRun 表示 Mission 的一次自治执行生命周期。

```ts
interface AgentRun {
  id: string
  missionId: string
  generation: number
  attemptNo: number
  backend: 'codex'
  role:
    | { kind: 'executor' }
    | {
        kind: 'reviewer'
        candidateSubmissionId: string
        reviewAssignmentId: string
      }

  status:
    | 'queued'
    | 'starting'
    | 'running'
    | 'recovering'
    | 'waiting'
    | 'parking'
    | 'parked'
    | 'submitting'
    | 'reviewing'
    | 'cancelling'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'crashed'
    | 'superseded'

  executionEnvironmentId?: string
  privateWorktreeId?: string
  baseIdentity?: string
  startedAt?: number
  finishedAt?: number
  resourcesReleasedAt?: number
  invalidatedAt?: number
  invalidationReason?: 'rerun' | 'mission_cancel' | 'decision_park' | 'crash_recovery'
  error?: RunError
  usage: RunUsage
}
```

所有**宿主可控边界**——启动、事件归并、结果导入、Candidate/Review 发布、正式 worktree apply 和终态提交——必须携带不可变 execution token。该 token 不要求注入 Codex 内部的每次文件操作或 Shell 命令：

```ts
interface ExecutionToken {
  missionId: string
  runId: string
  generation: number
}
```

### 5.5 RunSnapshot 与 ProgressNote

SpaceAssistant 不能假设可以修改 Codex 内部代码，也不能要求 Codex 按固定周期可靠执行新的生命周期协议。因此，执行进展拆成两层：

- `RunSnapshot`：宿主根据可观察事实持续维护的权威运行快照。
- `ProgressNote`：根据 Codex 原生输出或旁路摘要器生成的非权威语义说明。

#### 5.5.1 RunSnapshot

```ts
interface RunSnapshot {
  missionId: string
  runId: string
  generation: number

  status: AgentRun['status']
  statusText: string
  lastEventId?: string
  lastTool?: {
    name: string
    status: 'running' | 'completed' | 'failed'
    startedAt?: number
    completedAt?: number
  }
  changedFiles: string[]
  publishedDeliverables: DeliverableReference[]
  pendingDecisionIds: string[]
  usage: RunUsage
  updatedAt: number
}
```

RunSnapshot 的数据只能来自宿主可验证的数据源：

- Codex 已验证可用的原生 JSONL/JSON-RPC/终端事件；
- 进程启动、退出和原生审批状态；
- 私有 worktree 文件扫描、git diff 和稳定点 hash；
- Artifact/CodeChangeSet 提交；
- Review 和 Decision 记录；
- 进程、沙箱和资源监控。

即使 Codex 不提供结构化进展，RunSnapshot 也必须持续更新，并足以支持运行状态、资源、取消和审计 UI。原生事件不保证提供逐工具事实时，UI 只能展示已验证粒度，不能伪造精细状态。

#### 5.5.2 ProgressNote

```ts
interface ProgressNote {
  id: string
  missionId: string
  runId: string
  generation: number

  summary: string
  currentFocus?: string
  completedMilestones?: string[]
  planChanges?: Array<{
    change: string
    reason?: string
  }>
  blockers?: string[]
  nextActions?: string[]

  source: 'codex_output' | 'event_summarizer'
  sequence: number
  createdAt: number
}
```

宿主可以从 Codex 原生输出中提取 best-effort 进展说明，也可以将最近事件、进程状态、worktree 变化和上一条 ProgressNote 交给独立摘要器。两者都可能遗漏或误解意图，因此不能成为正确性前提。MVP 不要求 Codex 调用自定义进展工具。

ProgressNote 只用于解释执行进展，不参与：

- generation fencing；
- 权限或预算判断；
- 文件、测试和资源事实确认；
- 取消、恢复和终态提交；
- Artifact 发布和完成条件校验。

UI 必须明确区分“运行事实”和“语义摘要”。摘要缺失或错误不能影响 RunSnapshot 和 AgentRun 的正确性。

### 5.6 不建模 Delegation

Codex 内部可能创建子 Agent、并行探索或使用自己的协作协议。MVP 不创建 `Delegation`、子 Task 或委派树：

- 不持久化内部父子 Agent 关系；
- 不为子 Agent 建立业务状态机；
- 不在 UI 展示委派拓扑；
- 不要求内部 Agent 单独提交 Mission 交付物；
- 不让内部 Agent 身份成为权限或 provenance 的正确性边界。

宿主将整个 Codex 执行环境视为一个受控资源容器。内部进程和 Session 必须继承根 AgentRun 的授权、预算和取消边界。如果底层无法保证进程组取消、资源统一统计或权限不扩张，则该 Codex 后端不满足 MVP 准入条件。

---

## 6. Mission 创建与确认协议

### 6.1 Agent 能力边界

发起会话 Agent 可以调用：

```ts
prepare_mission({ draft: MissionDraft })
```

以下能力不得注册为 Agent 工具，也不得作为通用 Renderer IPC：

- `confirm_mission`
- `create_mission`
- `start_mission`
- 修改已确认授权或预算

Agent 文本中的“用户已同意”“可以直接开始”等内容不构成授权。

### 6.2 Prepare

主进程从可信调用上下文派生并固化：

- actor、origin Session 和 origin surface；
- workDir realpath identity；
- interactionMode；
- Codex 原生沙箱、审批模式和可用能力配置；
- 文件、浏览器、网络和命令权限；
- 资源预算；
- 安全配置版本；
- Review 策略；
- 交付合同。

Prepare 校验成功标准和交付合同，但不要求 Codex 提前提供完整执行步骤。对每个 required criterion，主进程必须解析并校验固定 deliverable/target/evidence key，解析 `validatorId` 或 `confirmationPolicyId`，验证适用的 evidence 映射唯一且来源匹配，并确认 command validator 的 executable/argv、固定 cwd、环境策略和超时均在当前授权内。任何引用缺失、重复、成环、不可执行或只能依赖自然语言推断的定义都必须拒绝。规范化后的验证合同与用户可读摘要一并进入预览和 `draftHash`；预览可包含非绑定的初始策略摘要，必须明确标注“执行中可调整”。

若 Mission 请求的浏览器、网络或外部写能力无法由当前 Codex 原生沙箱强制约束，prepare 必须拒绝或收窄并要求重新预览，不能仅靠提示词要求 Codex 自律。

### 6.3 用户确认与原子创建

确认 UI 只提交：

```text
preparedMissionId + expectedHash + idempotencyKey
```

主进程根据 IPC sender 派生 actor/session/surface，并在一个数据库事务中：

1. 锁定 PreparedMission，校验状态、有效期、hash 和当前预览绑定。
2. 重新计算 workDir identity、安全配置版本和 executionScopeHash。
3. 创建一次性 MissionConfirmation。
4. 创建 Mission，generation 初始化为 1。
5. 创建 queued AgentRun，并写入 `activeRunId`。
6. 消费 confirmation 和 prepared snapshot。

任一步失败整笔回滚。相同幂等键和相同请求返回原 Mission；相同键绑定不同草案或 hash 返回 `idempotency_conflict`。

---

## 7. 自治执行协议

### 7.1 Codex 启动输入

Runner 启动前从固定 base 创建 Run 专属私有 workspace/sandbox：Git 项目优先使用 worktree，非 Git 或 PDF/文档任务使用私有目录和只读输入副本。下文以“私有 worktree”统称该隔离工作空间。正式工作区挂载为不可写或完全不暴露，不同 generation 和 executor/reviewer Run 不共享可写目录。

宿主在 Run 私有 worktree 的只读 `.space-assistant/input/` 中生成 `mission.md`、`context.json` 等输入，预留可写 `.space-assistant/output/` 作为 best-effort handoff 目录，并通过普通启动提示让 Codex 接收稳定的 Mission 信息：

- goal；
- successCriteria；
- constraints；
- outputContract 及规范化验证合同；
- reviewPolicy；
- workDir；
- 允许使用的能力和预算摘要；
- 最终 handoff 输出约定；
- 私有 worktree 和沙箱限制。

execution token 只存在于宿主 Wrapper 和数据库，不要求 Codex 理解或回传。宿主不注入预定义 DAG；Codex 可以建立自己的滚动计划，并在执行中修订。

### 7.2 状态推进

宿主只维护粗粒度生命周期：

```text
queued → starting → running
                    ├→ waiting → running（宽限期内回复）
                    │          └→ parking → parked（继续等待用户）
                    ├→ crashed → recovering（新 Run）→ running
                    ├→ submitting → reviewing → completed
                    ├→ failed
                    └→ cancelling → cancelled
```

- `waiting`：存在必须由用户处理的 P0/P1 决策。只有 Codex 原生审批/暂停能力经验证时，容器才可短暂驻留；默认路径是结束或停放当前 Run，用户回复后创建新 Run。
- `parking/parked`：宽限期到期后正在停止或已经停止执行容器；Mission 仍为 waiting。
- `crashed/recovering`：旧执行环境异常终止；宿主正在封存可验证成果并以新 Run 恢复。
- `submitting`：Codex 已提交结果，宿主正在固化和验证。
- `reviewing`：存在必须完成的独立 Review。
- Mission 状态由当前有效 AgentRun 和 Review 状态确定，不聚合内部子 Agent。

### 7.3 重试与重新执行

MVP 支持两种方式：

1. **自动重试**：仅用于执行环境启动失败、临时网络错误等明确可重试的基础设施故障。
2. **重新执行 Mission**：旧 generation 失效并 drain 后，generation 加一，创建新的 AgentRun。

MVP 不承诺恢复 Codex 的进程内上下文、调用栈或精确内部步骤，但必须支持**工作成果级崩溃恢复**：宿主持久化成功写入、工具事实、验证记录和正式交付物；执行环境崩溃后封存 RecoveryBundle，并以新的 AgentRun 从当前可验证工作区状态继续。ProgressNote 不是恢复事实源，也不能通过复用旧进程内存或推测执行位置伪造精确断点续传。

已发布的历史 revision、RecoveryBundle、RunSnapshot、ProgressNote、Review 和事件保留审计；恢复 Run 自动获得宿主验证的恢复上下文，不要求用户从头开始。

### 7.4 从停放状态继续

Mission 可以长期 waiting，但 Codex 容器不得长期占用进程、并发槽位、浏览器句柄和路径租约。用户在 Run 已 parked 后回复时，宿主不能恢复旧进程或旧工具调用，而是：

1. 持久化用户对 MissionDecision 的回答。
2. 重新校验 actor、Mission 状态和当前工作区身份。
3. 对涉及授权扩张的回答走新的 scope revision 和可信确认，不能按普通决策消费。
4. 使用停放事务已经提升后的 generation 创建新的 AgentRun，不再次无意义递增。
5. 将 Mission、用户决策、上一 Run 的事实摘要、相关事件引用、已发布交付物和当前工作区状态渲染到新 Run 的只读输入文件。
6. 由新 Codex 重新验证现场并决定如何继续。

```ts
interface MissionResumeContext {
  missionId: string
  previousRunId: string
  previousRunSummary: {
    lastSnapshot: RunSnapshot
    latestProgressNote?: ProgressNote
    relevantEventRefs: string[]
  }
  resolvedDecision: MissionDecisionResolution
  publishedDeliverables: DeliverableReference[]
  currentWorkspaceIdentity: WorkspaceIdentity
  invalidatedAssumptions: string[]
}
```

ProgressNote 只能帮助解释历史，不能代替工作区、hash、测试、权限和资源状态的重新验证。

---

## 8. 取消、失效与 generation fencing

### 8.1 原子失效

取消或重新执行时，主进程在一个事务中：

1. 锁定 Mission 和当前 AgentRun。
2. 执行 `mission.generation += 1`，清空或替换 `activeRunId`。
3. 将旧 Run 标记为 `cancelling`，写入 invalidation 信息。
4. 取消持久化 pending decision。
5. 创建 `RunDrainOperation`。

事务提交后旧 execution token 立即失效。旧 Codex 在进程完全退出前仍可能继续修改其私有 worktree，但不能再被宿主接纳为正式状态；宿主立即终止进程树并进入 drain。

### 8.2 强制栅栏

由于 Codex 近乎黑盒，MVP 不承诺对其内部文件操作、Shell 或子 Agent逐次校验 token。强制栅栏位于宿主可控边界：

- 启动 Codex 进程和分配私有 worktree；
- 将原生事件归并为当前 RunSnapshot；
- 读取最终输出或 handoff；
- 扫描/封存 RecoveryBundle；
- 从私有 worktree 导入 Candidate/CodeChangeSet；
- 导入 ReviewResult；
- apply/merge 到正式工作树；
- 发布 Artifact、MissionDeliverable、Review 和 Mission 终态；
- 消费原生审批或 MissionDecision 回复。

最终更新使用条件写入；影响行数为 0 即视为 stale。旧 Run 的晚到事件只允许进入独立审计路径并标记 `superseded=true`。正式工作树、revision store 和用户外部系统不能作为 Codex 私有 worktree 的可写挂载。

### 8.3 Drain

```ts
interface RunDrainOperation {
  id: string
  missionId: string
  runId: string
  type: 'rerun' | 'mission_cancel' | 'decision_park' | 'crash_recovery'
  status: 'draining' | 'timed_out' | 'completed'
  requestedAt: number
  timeoutAt: number
  completedAt?: number
  errorCode?: string
}
```

取消流程必须停止整个 Codex 执行容器，包括内部子 Agent、子进程、浏览器句柄、工具调用、路径租约和临时资源。只有 Run 同时具备 `finishedAt` 与 `resourcesReleasedAt` 后，drain 才能完成。

超时后 Mission 进入 `paused(cancel_timeout)`：

- 不显示“已取消”；
- 不允许恢复或启动新 Run；
- UI 提供“重试取消”；
- 后台继续观察旧执行环境；
- 所有资源释放后自动完成原取消或重跑意图。

应用重启时优先恢复未完成 drain，不得把相关 Mission 当作普通 queued/running 重新启动。

决策停放复用同一 drain 正确性边界，但完成语义不同：`decision_park` drain 成功后旧 Run 进入 `parked`，Mission 保持 `waiting`，对应 MissionDecision 进入 `pending_parked`。停放失败或超时进入 `paused(decision_park_timeout)`，不得在旧执行资源尚未释放时启动恢复 Run。

### 8.4 工作成果级崩溃恢复

崩溃恢复与精确进程续跑是不同能力。MVP 不恢复 Codex 内存和调用栈，但必须保留已经能够由宿主证明的工作成果，并让新的 Codex Run 在检查现状后继续。

#### 8.4.1 可恢复写入分类

宿主无法拦截 Codex 的每次写入，因此通过私有 worktree 的周期性稳定点扫描、git diff、文件 hash 和已验证原生事件建立恢复观察。恢复时不得把“文件发生过变化”误认为完整成果：

```ts
interface RecoveryFileEntry {
  path: string
  operation: 'create' | 'modify' | 'delete' | 'rename'
  previousPath?: string

  status: 'committed' | 'uncertain' | 'drifted'
  beforeHash?: string
  afterHash?: string
  recoveryRevisionId?: string
  observationId: string
}
```

- `committed`：文件在两个稳定点扫描间保持一致、hash 已计算并固化 recovery revision，且没有已知仍在写该文件的原生进程事件；它表示“恢复内容完整可读”，不表示业务实现完成。
- `uncertain`：崩溃时文件处于最近稳定点之后、关联命令仍在运行，或无法证明内容稳定；新 Run 必须检查，不能假设成功。
- `drifted`：当前文件与账本中的成功 hash 不一致，可能来自用户、并发进程或非原子写入；不得静默采用旧状态。

所有软件开发 Mission 必须在独立 worktree 中运行；正式工作树不向 Codex 可写。宿主按时间、原生事件和进程退出点扫描固定 base 与 worktree 差异，将稳定内容按 hash 固化。没有稳定完成证据的变化标记为 uncertain。若 Codex 原生事件不能证明单个命令边界，也不影响隔离正确性，只会降低恢复分类精度。

#### 8.4.2 RecoveryBundle

```ts
interface RecoveryBundle {
  id: string
  missionId: string
  runId: string
  generation: number
  status: 'open' | 'sealed' | 'consumed' | 'superseded'
  entries: RecoveryFileEntry[]
  relevantEventRefs: string[]
  validationRefs: string[]
  createdAt: number
  sealedAt?: number
}
```

RecoveryBundle 是内部恢复资产，不是正式 Deliverable：

- 自动维护，允许包含未验证的中间状态；
- 不表示 Mission 完成，也不对用户宣称质量；
- 复用 revision store 的内容寻址和物理去重；
- 只有符合 output contract 的显式提交才能成为正式交付物；
- 历史 bundle 保留审计，按引用可达性和保留策略 GC。

#### 8.4.3 MissionRecoveryContext

```ts
interface MissionRecoveryContext {
  missionId: string
  crashedRunId: string
  crashedGeneration: number
  recoveryAttempt: number

  lastSnapshot: RunSnapshot
  latestProgressNote?: ProgressNote
  recoveryBundleId: string
  successfulWrites: RecoveryFileEntry[]
  incompleteOperations: RecoveryOperation[]
  publishedDeliverables: DeliverableReference[]
  completedValidations: ValidationReference[]
  relevantEventRefs: string[]
  pendingDecisions: DecisionReference[]

  workspace: {
    workDirIdentity: WorkDirIdentity
    baseIdentity?: string
    currentIdentity: string
    driftDetected: boolean
  }
  invalidatedAssumptions: string[]
  instructions: {
    inspectExistingWorkFirst: true
    doNotAssumePreviousIntentCompleted: true
    revalidateBeforeSubmitting: true
  }
}
```

恢复 Run 必须先检查 committed/uncertain/drifted 文件，再决定继续、修正或回退。成功写入文件自动作为当前工作区成果和 RecoveryBundle 输入提供，不要求用户手工挑选；ProgressNote 只帮助理解意图。

#### 8.4.4 验证记录有效性

测试、构建和类型检查必须绑定执行时的 workspace identity 或 CodeChangeSet revision：

```ts
interface ValidationRecord {
  id: string
  runId: string
  missionId: string
  candidateSubmissionId?: string
  validatorId: string
  validatorVersion: string
  evidenceKey: string
  kind: 'test' | 'typecheck' | 'build'
  executable: string
  args: string[]
  environmentPolicyId: string
  passCondition: 'exit_code_zero'
  exitCode?: number
  status: 'passed' | 'failed' | 'interrupted' | 'stale'
  workspaceIdentity: string
  targetRevisionIds: string[]
  startedAt: number
  completedAt?: number
}
```

Executor 自行运行的测试可以作为进展事实，但不能自动满足 required evidence。required command evidence 只能由宿主使用确认并进入 hash 的 validator definition，在由固定 Candidate 构造的隔离工作区中执行并生成 `ValidationRecord`。记录必须同时绑定 validator version、Candidate、target revision 和 workspace identity。

恢复时 workspace identity、validator version 和 target revision 均未变化的已完成验证可作为历史事实；任一绑定变化后必须标记 stale 并重新执行。崩溃时未完成的验证标记 interrupted。

#### 8.4.5 崩溃检测与恢复事务

Codex 进程异常退出或应用启动扫描发现非终态 Run 时：

1. 检查旧执行容器是否仍存活；能够安全接管则继续监控，否则先取消并 drain。
2. 在事务中使旧 generation 失效，将旧 Run 标记 crashed，Mission 进入 recovering，并创建 `crash_recovery` drain。
3. flush 可用事件，关闭 pending live decision，释放浏览器、进程、路径租约和临时资源。
4. 只有旧 Run 同时具备 `finishedAt` 和 `resourcesReleasedAt` 后才能封存 RecoveryBundle。
5. 扫描当前工作区，分类 committed/uncertain/drifted，并校验 workDir/base identity。
6. 若满足自动恢复条件，使用新 generation 创建 recovering AgentRun，并把 MissionRecoveryContext 渲染为只读输入文件。
7. 新 Codex 检查已有工作后进入 running；旧 Run 永不恢复。

自动恢复要求：

- 崩溃不是用户取消或安全强制终止；
- 旧容器已确定停止且资源已释放；
- workDir identity 未发生不可解释变化；
- 没有 P0 安全事件或目录外未知副作用；
- 剩余预算足够且未超过 `maxRecoveryAttempts`。

不满足条件时 Mission 进入 `paused(recovery_requires_attention)`，UI 展示可恢复、uncertain 和 drifted 文件、累计预算及最后有效验证，允许用户选择“基于已有修改继续”“检查后继续”“放弃中间修改并重新执行”或“取消 Mission”。

`crash_recovery` drain 超时进入 `paused(recovery_drain_timeout)`；旧容器和新 Run 绝不能并发写同一工作区。

---

## 9. 权限、安全与 Codex 准入

### 9.1 Mission 授权范围

```ts
interface MissionAuthorizationScope {
  readFiles: boolean
  writeFiles: boolean
  deleteFiles: boolean
  shell: {
    enabled: boolean
    policyId?: string
  }
  network: {
    enabled: boolean
    allowedDomains?: string[]
  }
  browser: {
    enabled: boolean
    allowedDomains?: string[]
    allowAct: boolean
  }
}
```

AgentRun 继承 Mission 授权，不允许扩大。Codex 内部子 Agent、Shell 子进程和辅助程序必须继承相同或更窄的边界。

对黑盒 Codex，MVP 实际可授予范围进一步收窄为：私有 worktree 内读写、本地测试/构建和沙箱内子进程。浏览器控制、外部插件写入、消息发送、远程删除、支付、`git push`、创建 PR 和其他无法由 worktree 隔离的外部副作用一律禁用。网络默认禁用；只有 Codex 原生沙箱能强制域名/只读策略并通过测试后才可有限开放。

### 9.2 Codex 后端硬准入条件

v3 的价值建立在 Codex 自治能力上，因此 Codex 是目标 MVP 后端。但只有满足以下条件才可以进入 `supervised` 或 `dedicated` 后台运行：

1. 使用真实 OS/CLI 沙箱，写范围限定在确认的工作目录或隔离 worktree；`cwd` 不视为隔离。
2. 工作目录外的读取、写入、删除、网络、环境变量和子进程策略明确且可测试。
3. Codex 内部创建的所有子 Agent 和子进程无法突破根 Run 权限。
4. 根执行容器可被统一取消，且能证明后代进程和句柄已经释放。
5. 启动、事件归并、结果导入、apply/merge 和数据库发布等宿主边界执行 generation fencing。
6. 时间和进程数可由宿主/沙箱强制；worktree 磁盘只能由宿主周期性观测并在超过软阈值后终止，不能表述为逐写入精确配额；工具调用和 Token 仅在原生计量 verified 时强制。
7. 所有正式写入发生在隔离 worktree；只有宿主受控合并可以回写正式工作树。
8. 具有越界读写删除、软硬链接逃逸、子进程逃逸、取消、资源超限和并发覆盖的端到端测试。

若当前 Codex 接入未通过这些门槛，MVP 可以开发 UI、数据模型和受控实验路径，但不得对用户宣称具备无人值守的安全后台执行能力。

### 9.3 资源预算

```ts
interface MissionResourceBudget {
  maxDurationMinutes: number
  maxToolCalls: number
  maxTokenUsage?: number
  softMaxObservedWorktreeBytes: number
  maxCandidateImportFileCount: number
  maxCandidateImportSingleFileBytes: number
  maxCandidateImportBytes: number
  maxArtifactStoreBytes: number
  maxConcurrentProcesses: number
  maxRecoveryAttempts: number
  recoveryReserveTokens?: number
}

interface MissionBudgetUsage {
  cumulative: RunUsage
  currentRun: RunUsage
  recoveryAttempts: number
}
```

预算按 Mission 累计，而不是每个 AgentRun 重置；内部委派和崩溃恢复都不能获得无限新预算。进程时长、进程数和宿主可控的 Candidate/Artifact 导入量由 Wrapper 强制；Token 和工具调用只有 Codex 原生事件能够可靠提供时才作为强制计数，否则标记为估算，不能宣传精确配额。恢复 Run 继承累计消耗，可以使用明确预留的少量恢复预算。超过 `maxRecoveryAttempts` 或强制预算不足时进入 `paused(recovery_exhausted)`。

`softMaxObservedWorktreeBytes` 是风险缓解阈值，不是安全隔离或精确磁盘配额。黑盒 Codex 及其子进程可以通过普通写入、mmap、重命名替换或编译器批量输出直接改变私有 worktree，SpaceAssistant 无法在每次文件副作用前拦截。宿主只能按固定间隔扫描 worktree 的可观察占用；首次观测到超过软阈值后应立即停止 Run 并记录观测值。采样间隔内允许超出阈值，实际峰值也可能高于最后一次观测值。MVP 不为追求精确运行期配额引入文件系统代理、独立卷、容器或内核级拦截层；部署环境若另有经过验证的 OS 级硬配额，可以作为纵深防御，但不改变本设计的最低保证。

Candidate/Artifact 导入发生在 Codex 退出且资源释放后的宿主可控边界。Importer 必须在复制或发布前从稳定快照确定文件清单和大小，并确定性校验 `maxCandidateImportFileCount`、`maxCandidateImportSingleFileBytes`、`maxCandidateImportBytes` 和剩余 `maxArtifactStoreBytes`；任一超限都不得创建或部分发布 revision。导入限额按 Mission 累计，重复幂等导入不重复计费。

超限规则：

| 资源 | 行为 |
|---|---|
| 时长 | 达到硬上限时 Wrapper 强制停止 Run |
| 并发进程 | 在可控启动边界拒绝新增资源；无法可靠限制后代进程时后端不准入 |
| worktree 可观察占用 | 周期性扫描；首次观测超出软阈值后停止 Run，允许采样间隔内超出，不宣称精确配额 |
| 工具调用、Token | verified 原生计量时强制；否则仅估算和告警 |
| Candidate 导入文件数、单文件大小、总字节 | 在复制和发布前确定性拒绝；不得产生部分 revision |
| Artifact store | 在发布前拒绝正式提交，保留 Run 为 waiting，允许清理或提高预算后重试 |

### 9.4 路径和写冲突

- 所有路径先规范化并验证 realpath/祖先链。
- 拒绝 `..`、路径别名、软链接和硬链接逃逸。
- revision store、staging root 和宿主内部目录是不可覆盖的保留根。
- Codex 内部写操作不要求接入 SpaceAssistant 路径租约，但只能发生在 Run 私有 worktree/sandbox。
- 最终回写必须经过宿主受控 apply/merge，校验 token、固定 base、当前正式工作树 identity 和冲突；旧 Run drain 前不得合并或复用 worktree。

---

## 10. 事件、运行快照与 Decision

### 10.1 RunEventBus

后台执行事件至少包括：

| 事件 | 说明 |
|---|---|
| `run:statusChanged` | Run 粗粒度状态变化 |
| `run:textDelta` | Codex 文本输出，可节流合并 |
| `run:nativeEvent` | Codex 原生事件；具体粒度取决于 verified 能力 |
| `run:worktreeChanged` | 宿主扫描发现文件或 diff 变化 |
| `run:snapshotUpdated` | 宿主权威 RunSnapshot 更新 |
| `run:progressNote` | 新的非权威 ProgressNote |
| `run:decisionRequested` | 需要用户决策 |
| `run:crashed` | 执行环境异常终止 |
| `run:recoveryPrepared` | RecoveryBundle 已封存，可创建恢复 Run |
| `run:deliverablePublished` | 正式交付物发布 |
| `run:reviewPublished` | Review 裁定发布 |
| `run:usageUpdated` | 资源使用更新 |

事件使用 `(runId, eventId)` 唯一键幂等持久化。文本/thinking delta 可以合并，进程状态、worktree 快照、决策、交付物、Review 和 usage 等离散事件不得丢弃。只有 Codex 原生事件明确提供工具语义时，才展示工具开始/进度/完成。

事件适配器使用有界有序队列。队列无法容纳不可合并事件时，Run 以 `event_delivery_overflow` 显式失败。成功终态前必须 flush；取消和异常路径也必须在 `finally` 中限时 flush 后释放资源。

RunSnapshot 由事件消费者、进程监控、worktree 扫描和各宿主 repository 增量投影，不由 Codex 写入。`run:progressNote` 可以来自 Codex best-effort 输出或独立事件摘要器；两种来源都必须标记，且不得覆盖 RunSnapshot 中的事实字段。

### 10.2 原生审批适配与 Mission Decision

MVP 不注入自定义 DecisionResolver 到 Codex 内部。若 Codex 原生协议提供经过验证的审批事件，宿主可以通过薄适配器转成 MissionDecision；否则 Codex 遇到阻塞时应结束当前 Run，并在最终输出或 handoff 中 best-effort 描述问题，宿主解析、校验后创建持久化 Decision。

- 原生审批适配只使用 Codex 已有协议，不修改内部循环。
- 无法可靠解析的问题不能自动扩大授权或继续副作用；Run 结束/停放并等待用户。
- 授权范围内的普通行为由 Codex 原生沙箱和预配置审批模式处理。
- 扩权必须重新生成并确认 Mission scope revision。
- 取消/重跑关闭原生审批通道；晚到回复永远不能恢复失效 Run。

### 10.3 决策等待、停放与过期

决策生命周期必须区分三个时间边界：

1. **自动决策期限**：在既有授权和策略内是否仍可采用默认答案。P0 和无安全默认值的 P1 不得因超时自动放行。
2. **Run 驻留宽限期**：仅当 verified 原生审批支持时，Codex 容器可以原地等待用户多久；否则为 0。
3. **Mission 决策有效期**：用户最晚何时还能回答；它可以远长于容器驻留时间，也可以对依赖瞬时现场的请求设置很短期限。

建议初始驻留宽限期：

| interactionMode | 驻留宽限期 | 说明 |
|---|---:|---|
| `interactive` | 0；verified 原生审批可配置至 10 分钟 | 默认新 Run 恢复 |
| `supervised` | 0；verified 原生审批可配置至 5 分钟 | 默认释放后台资源 |
| `dedicated` | 0 | 有安全默认值则自动处理，否则停放 |

这些是可配置初始值，不是产品语义常量。Mission 不能仅因用户离线 8 小时而失败或取消。

#### 10.3.1 持久化模型

```ts
interface PendingMissionDecision {
  id: string
  missionId: string
  originRunId: string
  originGeneration: number

  kind:
    | 'product_choice'
    | 'scope_change'
    | 'authorization_change'
    | 'risk_acceptance'
    | 'missing_information'
    | 'tool_confirmation'

  question: string
  options?: DecisionOption[]
  contextSnapshot: DecisionContextSnapshot

  status:
    | 'pending_live'
    | 'pending_parked'
    | 'resolved'
    | 'expired'
    | 'cancelled'
    | 'superseded'

  liveRunResumableUntil: number
  expiresAt?: number
  resolvedAt?: number
  resolution?: DecisionAnswer
}

interface MissionDecisionResolution {
  decisionId: string
  missionId: string
  answer: DecisionAnswer
  actorId: string
  resolvedAt: number
  resumesWithNewRun: boolean
}
```

`contextSnapshot` 必须保存用户做决定所需的信息，不能依赖仍然存活的 Codex 进程或 Renderer 内存。

#### 10.3.2 宽限期内回复

只有 `resumeNativeSession='verified'` 且原生审批仍处于同一有效请求时，用户在 `liveRunResumableUntil` 前回复才可以恢复同一 AgentRun。宿主仍须校验 `(missionId, runId, generation, decisionId)` 和现场前置条件。其他情况一律停放并通过新 AgentRun 恢复。

#### 10.3.3 宽限期到期

宽限期到期后：

1. Decision 从 `pending_live` 转为 `pending_parked`。
2. 原子提升 Mission generation、清空 `activeRunId`，使旧 execution token 失效；该新 generation 预留给未来恢复 Run。
3. Run 进入 `parking`，创建 `decision_park` drain。
4. 停止整个 Codex 执行容器，flush 事件并释放全部资源。
5. drain 成功后 Run 进入 `parked`，Mission 继续保持 waiting。

用户晚到回复只能形成 MissionDecisionResolution 并触发 §7.4 的新 AgentRun，不能执行旧工具调用或把旧 Run 改回 running。

#### 10.3.4 不同决策的过期语义

- **产品选择、缺失信息**：通常可长期保持 `pending_parked`，用户回复后以新 Run 继续。
- **授权扩张**：不是普通回答；必须生成新的执行 scope、hash 和可信确认，新 Run 才能使用。
- **即时工具确认**：依赖文件 hash、页面状态或外部现场；Run 停放后旧请求应 `expired`。用户答案可作为意图输入，但新 Run 必须重新读取现场并在必要时重新确认。
- **P0 风险**：不得超时自动允许；尽快停放，恢复时重新验证。

系统可以在 24 小时、7 天等节点提醒用户，并将长期等待 Mission 标记为 stale；默认不得因为等待时间长而自动删除记录或虚构失败。归档策略属于产品保留设置。

---

## 11. 交付物、版本与验证证据

### 11.1 Mission 候选提交与正式接受

MVP 不要求 Executor Codex 调用自定义提交工具。宿主在私有 worktree 中提供 best-effort handoff 约定，例如 `.space-assistant/output/handoff.json`：

```ts
interface CodexHandoff {
  summary: string
  claimedDeliverables: Array<{
    key: string
    kind: 'document' | 'code_change_set' | 'data' | 'media' | 'other'
    paths?: string[]
  }>
  claimedEvidence: Array<{
    key: string
    kind: 'test_result' | 'typecheck' | 'build' | 'other'
    summary: string
  }>
  completionAssessment: {
    satisfiedCriteria: string[]
    unsatisfiedCriteria: string[]
    knownLimitations: string[]
  }
}
```

Handoff 和 Codex 最终文本都是不可信声明，可以缺失、格式错误或被截断。Codex 退出后，宿主 Wrapper 才执行真正的候选导入：

- execution token 当前有效；
- 旧进程已经退出并释放资源；
- 扫描私有 worktree，与固定 base 生成真实文件清单、hash 和 CodeChangeSet；
- 基于稳定快照在复制前校验 Candidate 文件数、单文件大小、总导入字节和 Artifact store 剩余额度；超限时整体拒绝，不创建部分 revision；
- 排除宿主保留的 `.space-assistant/input`、`output` 和临时目录，不把协议文件当成交付物；
- 对 handoff 做 schema 校验，但不相信其路径、测试或完成声明；
- 将 target 固化为不可变 Artifact revision 或 CodeChangeSet revision；
- 从已确认验证合同解析 required criterion；按固定 validator definition 在 Candidate 隔离工作区执行 command validation，并产生绑定 Candidate/revision/validator version 的证据；
- 按显式 criterion/evidence 映射校验 required deliverable、Review 和 manual confirmation；不得从 handoff、最终文本或当前仓库脚本猜测验证方式；
- 以 `(missionId, runId, generation, worktreeIdentity)` 作为幂等导入边界。

Command validator 使用由固定 Candidate 构造的临时隔离工作区；构建缓存和测试输出不得修改 Candidate revision，也不得自动进入交付物。Codex 的退出码、自然语言“已经完成”或 handoff 文件都不能直接改变 Mission 状态。即使 handoff 缺失，宿主仍可保留 RecoveryBundle，并从完整 worktree diff 生成代码 Candidate；文档等交付物若无法按 output contract 确定性映射，则进入 `waiting(candidate_mapping_required)`，不能猜测后自动成功。宿主先固化不可变 Candidate 并创建 `CandidateSubmission(status='validating')`，再针对该固定版本生成验证证据：command 或 artifact 校验失败时拒绝接受；required Review 进入 reviewing；required manual criterion 使 Candidate 进入 `awaiting_manual`，Mission 进入 `waiting(manual_acceptance_required)`。只有所有 required criterion 都具有来源正确、版本绑定且通过的验证结果时，才可接受 Candidate。

```ts
interface CandidateSubmission {
  id: string
  missionId: string
  producerRunId: string
  producerGeneration: number
  status:
    | 'submitted'
    | 'validating'
    | 'reviewing'
    | 'awaiting_manual'
    | 'accepted'
    | 'revision_requested'
    | 'rejected'
  deliverables: CandidateDeliverable[]
  evidence: EvidenceReference[]
  completionAssessment: CompletionAssessment
  createdAt: number
}
```

Candidate 已不可变但尚未成为最终 MissionDeliverable。只有宿主依据 ReviewPolicy 和确定性验证执行 `accept_candidate_submission` 后，才能在单个事务中发布 MissionDeliverable、保留真实 producer provenance 并将 Mission 标记 completed。

#### 11.1.1 人工验证与统一接受事务

```ts
interface ManualAcceptanceRecord {
  id: string
  missionId: string
  candidateSubmissionId: string
  targetRevisionIds: string[]
  criterionId: string
  evidenceKey: string
  confirmationPolicyId: string
  actorId: string
  decision: 'pass' | 'fail'
  comment?: string
  createdAt: number
}
```

人工确认 UI 必须展示 Candidate revision/hash、criterion、待确认交付物和已有验证证据。主进程从可信 UI 调用上下文派生 actor，校验 `confirmationPolicyId`、Mission、Candidate、criterion/evidence 映射和 target revision；确认记录不可复用于新 Candidate。`pass` 只生成 manual evidence，不直接完成 Mission；`fail` 保留审计并使 Candidate 进入 `revision_requested` 或等待用户选择。所有 required evidence 到齐后，`accept_candidate_submission` 在同一个事务中重新校验 execution generation、Candidate/revision identity、每条 required criterion 的 evidence 来源与状态、required Review verdict 和 manual actor policy，然后发布 MissionDeliverable 并完成 Mission。

### 11.2 Revision store

继续采用宿主管理的不可变 revision store：

1. Codex 只能写工作区，不能看到或写入真实 `contentLocator`。
2. 提交服务持有源文件读租约，复制到 staging，close/fsync 后计算 hash。
3. 以 content hash 原子移动到 revision store。
4. 数据库事务先发布 ArtifactRevision、CandidateDeliverable、relation 和 submission；Candidate 接受事务再发布 MissionDeliverable alias。
5. 数据库失败留下的孤儿 blob 由宽限期 GC 清理。
6. deliverable、Review、relation、审计或活跃 submission 可达的 revision 不得删除。

### 11.3 CodeChangeSet

软件开发 Mission 的正式代码交付使用不可变 CodeChangeSet：

```ts
interface CodeChangeSetRevision {
  id: string
  codeChangeSetId: string
  baseIdentity: string
  entries: Array<{
    path: string
    operation: 'add' | 'modify' | 'delete' | 'rename'
    previousPath?: string
    beforeHash?: string
    afterHash?: string
    contentRevisionId?: string
  }>
  overallHash: string
  producedBy: {
    missionId: string
    runId: string
    generation: number
  }
  createdAt: number
}
```

CodeChangeSet 必须固定 base identity、文件操作、每个文件内容 hash 和整体 hash。Reviewer 读取固定 bundle，不读取可变工作树。若需要将 bundle 回写用户工作树，必须使用受控 apply/merge，并处理 base 漂移、冲突、失败原子性和 generation fencing。

在 CodeChangeSet 和受控 apply/merge 未完成前，MVP 可以展示代码修改和测试结果，但不能标记“该代码版本已被结构化评审通过”。

---

## 12. 独立 Review

独立 Review 复用 AgentRun 的 Codex 启动、Session、事件、预算、取消、drain、崩溃重试和资源释放机制。宿主不实现第二套 Review 执行引擎，只为 AgentRun 配置 `role.kind='reviewer'`、独立上下文、只读权限和专用输出合同。

强制 Review 由宿主根据已确认的 ReviewPolicy 发起，不能依赖 Executor Codex 主动调用。Executor 可以请求额外 Review，但不能跳过 required Review、选择更宽松的 Rubric 或自行发布最终结果。

### 12.1 ReviewAssignment

主 Run 提交 Candidate 后，宿主先执行确定性校验，再为固定 target 创建 ReviewAssignment：

```ts
interface ReviewAssignment {
  id: string
  missionId: string
  candidateSubmissionId: string
  target:
    | {
        kind: 'artifact_revision'
        artifactId: string
        revisionId: string
        contentHash: string
      }
    | {
        kind: 'code_change_set_revision'
        codeChangeSetId: string
        revisionId: string
        contentHash: string
      }

  missionBrief: {
    goal: string
    includedScope: string[]
    excludedScope: string[]
    successCriteria: SuccessCriterion[]
  }
  rubricSnapshot: ReviewRubric
  evidence: EvidenceReference[]
  repositoryPolicies: PolicyReference[]
  outputContract: ReviewOutputContract
  status: 'prepared' | 'running' | 'completed' | 'failed' | 'cancelled'
  createdAt: number
}
```

Assignment 必须冻结 target、Rubric、证据和仓库规范。宿主把它渲染为 Review worktree 中的 `review-assignment.md/json`。Reviewer 不读取 Producer 的完整对话、思维过程或可变工作树，避免继承执行者的自我解释。必要代码通过不可变 revision 或由宿主从固定 base + CodeChangeSet 构造的隔离 Review worktree 提供。

### 12.2 Reviewer AgentRun

宿主创建新的独立 Codex Session：

```ts
AgentRun.role = {
  kind: 'reviewer',
  candidateSubmissionId,
  reviewAssignmentId
}
```

Reviewer Run 与 Executor Run 复用相同基础设施，但权限模板不同：

| 能力 | Executor | Reviewer |
|---|---:|---:|
| 读取 Mission 目标 | 是 | 是 |
| 读取固定候选 revision | 是 | 是 |
| 修改 Producer worktree | 按授权 | 否 |
| 写正式项目文件 | 按授权 | 否 |
| 提交 Candidate | 是 | 否 |
| 提交 Review | 否 | 是 |
| 运行验证 | 是 | 可在隔离临时环境中运行 |
| 发布最终 Mission 结果 | 否 | 否 |

MVP 不注入 Reviewer 自定义工具。宿主通过 Codex 原生沙箱配置使 Candidate 源内容只读，并提供可丢弃的临时测试/构建目录。Reviewer 可以使用 Codex 自带的读、搜索和 Shell 能力，但不能写 Producer worktree、正式工作树或 Candidate revision；临时缓存和修改在 Run 结束后清理。

### 12.3 ReviewRubric 与触发策略

```ts
interface ReviewPolicy {
  mode: 'none' | 'required' | 'on_risk'
  targets?: string[]
  reviewer: 'independent_codex' | 'user'
  maxReviewRounds: number
  maxReviewAttempts: number
  onExhausted: 'wait_user' | 'fail'
}

interface ReviewRubric {
  criteria: Array<{
    id: string
    description: string
    severity: 'blocking' | 'important' | 'advisory'
    source:
      | 'success_criterion'
      | 'repository_policy'
      | 'security_policy'
      | 'default_quality'
      | 'user'
  }>
  requiredChecks: string[]
  passPolicy: {
    allowBlockingFindings: false
    maxImportantFindings: number
  }
}
```

Rubric 在 Mission prepare/confirm 阶段进入 hash，Reviewer 不能自行降低标准。`on_risk` 由宿主根据 Mission 风险、路径策略、CodeChangeSet 规模、删除/迁移/公共接口变化、验证结果和 Codex 风险信号确定性归并；Codex 可以增加 Review，不能通过不报告风险来取消 Review。

宿主在启动 LLM Reviewer 前先执行确定性检查，包括 target/hash 完整性、required deliverable、测试/typecheck/build、excluded scope、CodeChangeSet 文件清单和证据 identity。确定性门失败可直接形成 revise 结果，不必消耗 Reviewer Token。

### 12.4 结构化 Review 提交

MVP 不要求 Reviewer 调用自定义提交工具。启动提示要求其在 Review worktree 的 `.space-assistant/output/review-result.json` 中输出结果，或使用经过验证的 Codex 原生结构化输出：

```ts
interface CodexReviewResult {
  assignmentId: string,
  targetRevisionId: string,
  expectedHash: string,
  verdict: 'pass' | 'revise',
  criterionResults: Array<{
    criterionId: string
    status: 'pass' | 'fail' | 'not_applicable'
    explanation: string
    evidenceRefs?: string[]
  }>,
  findings: Array<{
    severity: 'blocking' | 'important' | 'advisory'
    title: string
    description: string
    filePath?: string
    line?: number
    evidenceRefs?: string[]
  }>,
  summary: string,
  requiredChanges: string[]
}
```

结果文件和最终文本均为不可信输入。Reviewer 退出且资源释放后，宿主校验 execution token、Assignment、target revision/hash、JSON schema、required criteria、finding/verdict 一致性和导入幂等。`pass` 时不得存在 blocking finding，也不得违反 Rubric passPolicy。结果文件缺失或无效视为 Review 失败；普通自然语言“通过”不改变状态。

```ts
interface Review {
  id: string
  missionId: string
  assignmentId: string
  candidateSubmissionId: string
  reviewerRunId: string
  targetRevisionId: string
  targetHash: string
  verdict: 'pass' | 'revise'
  criterionResults: ReviewCriterionResult[]
  findings: ReviewFinding[]
  summary: string
  requiredChanges: string[]
  createdAt: number
}
```

### 12.5 Pass、Revise 与多轮修订

`pass` 后由宿主调用内部 `accept_candidate_submission`。该事务除校验 Candidate、Review target 和验证 identity 外，还必须重新检查全部 required criterion 的 evidence；若仍缺少 required manual 或其他 evidence，Mission 转入对应 waiting 状态而不能完成。证据闭合后，事务发布 MissionDeliverable、保留真实 Producer provenance、将 Candidate 标记 accepted，并完成 Mission。Reviewer 不生产或发布被评审内容。

`revise` 后宿主：

1. 将 Candidate 标记 `revision_requested`。
2. 保留 Candidate revision 和 Review 审计。
3. 提升 Mission generation，创建新的 Executor AgentRun。
4. 把固定 Candidate、Review.requiredChanges、当前工作区 identity 和已发布成果渲染到新 Run 的只读输入。
5. 由新 Executor 自行决定如何修订，再提交新的 Candidate。

这是一系列 AgentRun、Candidate 和 Review revision，不是 ReviewLoop Controller。宿主不创建 iteration Task，也不理解修订步骤。达到 `maxReviewRounds` 时按 ReviewPolicy 等待用户或失败；人工接受必须记录 actor、理由和明确 target revision，不能改写 Reviewer verdict。

### 12.6 Reviewer 失败与崩溃

Reviewer 输入完全不可变且没有正式项目写入成果，因此 Reviewer 崩溃后不需要 Executor 的 RecoveryBundle 语义，可以使用同一 ReviewAssignment 创建新的 reviewer AgentRun：

- 基础设施临时失败按 `maxReviewAttempts` 自动重试；
- 缺失结构化 verdict 可重试一次或计入 attempt；
- 超限后 Mission 进入 `paused(review_failed)`；
- 用户可以重试 Review、改用人工 Review、显式 override 或取消 Mission；
- Review 失败和超时永远不能默认视为 pass。

Reviewer AgentRun 仍复用 generation fencing、事件 flush、取消/drain、预算和资源释放。Review 预算计入 Mission 累计预算，但可以设置独立子上限。

### 12.7 独立性的边界

“独立”指新的 Codex Session、不共享 Producer 对话、不共享可变工作树、只读固定 target、独立 Rubric 和结构化输出。如果 Producer 与 Reviewer 使用相同模型，仍可能存在共同盲点；确定性验证、安全扫描、不同模型或多 Reviewer 可以在后续增强，但不改变 MVP 的隔离边界。

---

## 13. UI 与交互

### 13.1 三阶段体验

```text
聊天/IM                    后台任务面板                  原会话
目标澄清与确认  ───────→  自治执行与可观察进展  ─────→  结果投递
```

需求澄清和 Mission 预览仍在发起会话完成；执行在独立任务面板展示；完成、失败或 P0/P1 等待消息投递回原会话。

### 13.2 任务列表

Activity Bar 增加后台任务图标。列表按 `updated_at` 降序显示：

- Mission 名称；
- running/recovering/waiting/parking/parked/reviewing/cancelling 等状态；
- RunSnapshot 中的最近活动和资源状态；
- 最近 ProgressNote（存在时明确标记来源）；
- 运行时间和资源高水位；
- 是否需要用户处理。

### 13.3 Mission 详情

详情页包含：

1. **目标与边界**：goal、成功标准、约束、授权、预算、ReviewPolicy。
2. **运行事实**：RunSnapshot 中的状态、当前工具、文件变化、pending decision 和资源使用。
3. **进展摘要**：最近 ProgressNote 中的关注点、里程碑、计划变化、阻塞和下一步；不存在时不影响其他信息展示。
4. **执行时间线**：Codex 原生输出、可验证的命令/工具事件、worktree 变化、ProgressNote、决策和状态变化。
5. **资源使用**：时间、进程、worktree 最近观测值/高水位及软阈值、Candidate 导入量、Artifact store；Token/工具调用在原生计量可用时展示，否则标记估算或不可用。worktree 指标必须标明采样时间和“非精确配额”。
6. **交付物**：正式 revision、CodeChangeSet、验证证据和 Review。
7. **操作**：取消、重试取消、重新执行、处理决策、查看历史 Run。

Mission reviewing 时，Candidate 下嵌显示 ReviewAssignment、Reviewer AgentRun 时间线、Rubric、确定性检查、criterion results 和 findings，并明确标注 Executor/Reviewer 角色。Reviewer 的临时测试文件和内部事件不进入正式交付物列表。

Mission recovering 或 `paused(recovery_requires_attention)` 时额外展示：

- 崩溃 Run、异常时间和错误；
- committed、uncertain、drifted 文件清单；
- RecoveryBundle 和当前工作区 identity；
- 最后有效、stale 和 interrupted 验证；
- Mission 累计预算及恢复次数；
- 自动恢复状态，或“基于已有修改继续”“检查后继续”“放弃中间修改并重新执行”“取消 Mission”操作。

Mission waiting 时，UI 必须区分：

- **在线等待**：仅在 verified 原生审批能力下显示；否则不会承诺原地继续；
- **正在停放**：正在停止 Codex 容器并释放资源；
- **已停放等待**：执行资源已释放，用户回复后会创建新 AgentRun；
- **决策已过期**：现场相关确认需要重新检查或重新提问；
- **需要重新授权**：回答会扩大 scope，必须进入新的可信确认流程。

UI 不展示固定任务总数、阶段完成百分比、DAG 或内部委派树。可使用描述性状态，例如“正在验证数据库迁移兼容性”，而不是不可靠的“完成 67%”。

### 13.4 结果投递

Mission 终态后在原会话插入系统消息：

- 成功或失败摘要；
- 交付物及版本链接；
- 测试、构建和 Review 证据；
- 已知限制；
- 耗时和资源概况；
- `[查看执行详情]` 链接。

写入消息时更新原 Session 的 `updated_at`，使会话自动回到列表顶部。

---

## 14. 持久化建议

MVP 核心表建议为：

| 表 | 用途 |
|---|---|
| `prepared_missions` | 待确认 Mission 快照 |
| `mission_confirmations` | 一次性创建授权 |
| `missions` | 目标、边界、generation 和状态 |
| `agent_runs` | 自治执行生命周期 |
| `run_drain_operations` | 取消和重跑资源屏障 |
| `run_events` | 幂等事件时间线 |
| `run_snapshots` | 宿主根据可验证事实维护的当前运行投影 |
| `run_progress_notes` | Codex best-effort 输出或事件摘要器生成的非权威进展说明 |
| `recovery_bundles` | 每个 Run 的内部工作成果恢复集合 |
| `recovery_file_entries` | committed/uncertain/drifted 文件及恢复 revision |
| `validation_records` | 绑定 workspace identity 的测试、构建和类型检查结果 |
| `manual_acceptance_records` | 可信用户针对固定 Candidate revision 的人工验证证据 |
| `mission_decisions` | live/parked/expired/resolved 的持久化 Mission 决策 |
| `mission_decision_resolutions` | 用户回答、actor、时间和新 Run 恢复语义 |
| `run_resource_usage` | 聚合预算使用 |
| `mission_budget_usage` | 跨 Run 累计预算和恢复次数 |
| `run_worktree_snapshots` | 私有 worktree 稳定点、diff、hash 和恢复来源 |
| `artifact_revisions` | 不可变内容版本 |
| `artifact_relations` | revision 血缘 |
| `candidate_output_submissions` | Executor 候选提交的 staging、幂等和发布状态 |
| `candidate_submissions` | Executor 提交的不可变候选结果及 review/acceptance 状态 |
| `mission_deliverables` | Mission 正式交付物 |
| `mission_evidence` | 验证证据 |
| `review_assignments` | 固定 target、Rubric、证据和输出合同 |
| `reviews` | 对固定 revision 的裁定 |
| `review_override_audits` | 人工接受审计 |
| `code_change_sets` | 多文件代码变更稳定身份 |
| `code_change_set_revisions` | 不可变 bundle 版本 |
| `code_change_set_entries` | 文件级操作和 blob 引用 |

不再需要：

- `tasks`
- `task_attempts`
- `task_steps`（由 `run_events` 替代）
- `task_input_bindings`
- `task_deliverables`
- `review_loop_runs`
- `review_iterations`
- `review_acceptance_publications`
- Stage 相关表
- Delegation 或子 Agent 相关表

---

## 15. MVP 范围

### 15.1 必须交付

1. `background-mission-intake` Skill：适用性判断、只读上下文获取、必要澄清、Mission Brief 和 MissionDraft。
2. `prepare_mission` 与可信 UI 确认。
3. Mission/AgentRun 数据模型和原子创建。
4. 通过安全准入的 Codex 自治执行容器。
5. Run 级 generation fencing。
6. 取消、drain、超时暂停和工作成果级崩溃恢复。
7. Mission 级权限与可强制资源预算、运行期 worktree 软阈值监测，以及 Candidate/Artifact 导入硬限额。
8. 后台事件持久化、回压、flush 和回放。
9. 宿主根据可观察事实持续维护 RunSnapshot。
10. 基于 Codex 原生输出和旁路摘要器的非权威 ProgressNote；其缺失不得影响正确性。
11. Decision 的在线宽限期、Run 停放、长期等待、过期与新 Run 恢复。
12. RecoveryBundle、写入状态分类、MissionRecoveryContext、启动扫描和自动恢复策略。
13. 独立任务面板。
14. Artifact revision 与 Mission 级正式提交。
15. 成功标准、验证证据和确定性完成校验。
16. 复用 AgentRun 的独立 Reviewer Session、ReviewAssignment、只读权限和结构化裁定。
17. 结果投递回原会话。
18. 软件开发场景的 CodeChangeSet；若无法在首版交付，必须显式降低“代码评审”产品承诺。
19. CodexBackendCapabilities 兼容性探测与版本化适配测试；unsupported/experimental 能力不得进入正确性路径。

### 15.2 可以延后

- 静态 Workflow/DAG 批处理模式；
- 恢复 Codex 进程内上下文、调用栈或精确内部步骤；
- Mission 执行中的授权范围增量变更；
- 多 Mission 之间的依赖；
- 通用条件分支；
- 跨设备恢复；
- IM 创建和修改 Mission；
- 高级资源调度和优先级；
- 面向用户的内部 Codex 诊断拓扑；
- 多种执行后端和自动 fallback。

### 15.3 明确不做

- 执行前生成完整软件开发 DAG；
- 要求用户逐 Task 确认；
- 宿主根据语义步骤决定下一步；
- 持久化 Codex 内部 Delegation；
- 修改 Codex 内部循环或要求其逐工具回调 SpaceAssistant；
- 依赖 Codex 必须调用自定义 MCP/提交/进展工具；
- 让 Codex 直接写正式工作树或执行外部不可逆副作用；
- 以路径列表、当前 git diff 或可变工作树冒充不可变代码版本；
- 仅凭 Codex 自述将 Mission 标记完成；
- 仅用 `cwd`、命令前缀或 Agent 自律作为沙箱。

---

## 16. MVP 验收标准

### 16.1 Mission Intake、创建与授权

- 明确、简单的请求可以零问题生成 MissionDraft；Skill 不机械询问固定数量的问题。
- 能从可信项目上下文确定的信息不再次询问用户，澄清阶段不产生写入或外部副作用。
- 会实质改变目标、范围、权限、安全、成本或交付结果的歧义必须澄清。
- MissionDraft 区分用户输入、仓库事实、默认值和 Agent 推断，并记录 assumption 来源与置信度。
- 存在 blocking unresolved issue、不可验证的 required criterion 或未定义的 required deliverable 时不能 prepare。
- 每个 required criterion 在 Prepare 时都解析为固定 command validator、deliverable key、Review target 或 manual confirmation policy；需要 evidence 的类型还必须具有唯一的 criterion/evidence/source 映射。缺失、重复或需运行后猜测的定义不能 prepare。
- command validator 的 executable/argv、Candidate cwd、环境策略、超时和退出码 0 通过规则进入规范化草案与 `draftHash`；确认后不能从 Codex handoff 或漂移的仓库脚本替换。
- Mission Brief 与结构化 MissionDraft 来自同一规范化数据，展示内容与提交内容不漂移。
- Skill 生成的 capability 和 budget 只是请求，不能直接成为执行授权。
- Agent 只能 prepare，不能 confirm/create/start。
- 无确认、过期确认、跨 actor/Session/surface 确认均不能启动。
- workDir、权限、工具、安全配置或预算变化后旧预览失效。
- confirmation 与 Mission/AgentRun 创建同事务完成。
- 幂等重放返回原 Mission，冲突请求明确失败。

### 16.2 Codex 自治与不透明委派

- Codex 被当作黑盒进程；MVP 只依赖经过 verified 的启动、cwd、沙箱、原生事件、退出检测和进程树终止能力。
- customTools、结构化输出和原生 Session 恢复为 unsupported/experimental 时，主闭环仍能保守运行。
- Codex 可以在不修改宿主领域状态机的情况下调整内部计划。
- Codex 创建内部子 Agent 不会创建 Task/Delegation 业务记录。
- 内部子 Agent 无法扩大权限或获得额外预算。
- 根 Run 取消能够停止全部内部执行资源。
- UI 不依赖内部委派协议也能展示完整进展和结果。

### 16.3 Fencing 与取消

- 旧 generation 的事件归并、handoff 导入、Candidate/Review 导入、正式 apply/merge、交付和终态全部被拒绝。
- Token 失效后旧 Codex 即使短暂继续运行也只能修改其私有 worktree，不能修改正式工作树或 revision store。
- 旧 Run 晚到事件只能进入 superseded 审计路径。
- `finishedAt + resourcesReleasedAt` 之前 Mission 保持 cancelling。
- 取消超时进入 paused，不显示已取消，也不启动新 Run。
- 重启后恢复未完成 drain，不错误重启旧 Run。

### 16.4 工作成果级崩溃恢复

- Codex 进程异常退出或应用重启发现非终态 Run 时，不直接把 Mission 标记失败或从头执行。
- 启动扫描先确认旧容器死亡或完成 `crash_recovery` drain；旧资源未释放前不启动恢复 Run。
- 私有 worktree 通过周期性稳定点、diff 和 hash 固化恢复 revision，重复内容通过 content hash 去重。
- 崩溃时文件被分类为 committed、uncertain 或 drifted；最近稳定点后的变化不能伪装成 committed。
- RecoveryBundle 封存失败时不启动自动恢复，并进入可诊断暂停状态。
- 恢复 Run 自动获得 MissionRecoveryContext 和已有成功文件，不要求用户手工重新选择输入。
- 新 Codex 先检查已有修改和不确定操作，再继续、修正或回退；不能假设上一 Run 的意图已经完成。
- 验证记录绑定 workspace identity；工作区变化后旧测试标记 stale，崩溃中的测试标记 interrupted。
- Mission 的强制预算跨 Run 累计；Token/工具调用只有 verified 原生计量存在时才作为精确预算，恢复不能重置任何已记录消耗。
- 超过恢复次数或预算上限进入 `paused(recovery_exhausted)`，不会形成无限崩溃循环。
- workDir/base 漂移、P0 事件或未知目录外副作用会进入 `paused(recovery_requires_attention)`，不自动恢复。
- 旧 Run 晚到事件和副作用受 generation fencing 拒绝，旧容器与恢复 Run 不会并发写同一工作区。

### 16.5 安全

- 越界读写删除、绝对路径、`..`、软硬链接和路径别名逃逸均失败。
- Codex 内部子进程无法绕过工作目录和保留根限制。
- 网络、浏览器和 Shell 能力严格匹配确认 scope。
- 时间和并发进程等可控预算由宿主或沙箱强制执行；Token/工具调用仅在 verified 原生计量下作为硬预算。
- 宿主周期性统计私有 worktree 可观察占用，首次观测超过软阈值后终止 Run；测试必须证明 UI 和审计明确披露采样间隔内可能超出，且不把该机制表述为逐写入拦截、精确配额或安全隔离。
- Candidate/Artifact 导入在复制和发布前确定性限制文件数、单文件大小、总导入字节和 Artifact store 剩余额度；超限不会产生部分 revision 或正式交付物。
- 并发写同一路径显式冲突，或通过隔离 worktree 和受控 merge 处理。
- 取消、超时和异常退出均释放进程、浏览器和路径租约。

### 16.6 事件、RunSnapshot 与 ProgressNote

- 无窗口时 Codex 可以持续运行并持久化事件。
- `(runId, eventId)` 重放不产生重复记录。
- 文本 delta 可合并，离散工具/决策/交付事件不丢失。
- 完成前 flush；最后事件未落库时不能报告成功。
- RunSnapshot 只由 verified 原生事件、进程状态、worktree 扫描、repository 和资源监控投影产生。
- 即使 Codex 不输出结构化进展，RunSnapshot 仍能展示进程状态、worktree 变化、决策和强制资源使用；当前工具仅在 verified 原生事件存在时展示。
- ProgressNote 能表达当前关注点、里程碑、计划变化、阻塞和下一步，并标记 `codex_output` 或 `event_summarizer` 来源。
- ProgressNote 缺失、延迟或内容错误不影响权限、预算、取消、完成或交付校验。
- Codex 改变计划不会破坏宿主状态。

### 16.7 决策等待与 Run 停放

- P0/P1 决策进入 waiting 后存在明确、可配置的 Run 驻留宽限期。
- 默认驻留宽限期为 0；只有 verified 原生审批/Session 恢复能力存在，且 token、decisionId 和现场前置条件仍有效时才能恢复同一 Run。
- 宽限期到期后 Mission generation 提升，旧 Run 进入 parking，并通过 `decision_park` drain 释放全部资源。
- `finishedAt + resourcesReleasedAt` 前不能显示 parked，也不能启动恢复 Run。
- Run parked 后 Mission 继续 waiting，不因用户离线 8 小时自动失败或取消。
- 晚到回复不能恢复旧进程、旧调用栈或执行旧工具确认，只能触发携带 MissionResumeContext 的新 AgentRun。
- 即时工具确认在现场变化或 Run 停放后过期；新 Run 必须重新读取 hash/页面/外部状态。
- 授权扩张必须走新的 scope revision、hash 和可信确认，不能作为普通 Decision 应用。
- P0 决策永不因超时自动允许。
- 应用重启后恢复 parking/drain 和 pending_parked 状态，不错误唤醒旧 Run。

### 16.8 交付与 Review

- 缺失 required deliverable/evidence 时 Mission 不能完成。
- required command evidence 只能由宿主按已确认 validator definition 针对固定 Candidate 执行产生，并绑定 validator version、Candidate/revision 和 workspace identity；Codex 自述或自行运行的同名测试不能替代。
- required evidence 显式引用其 criterion 和可信来源；Importer 不从 handoff、自然语言或当前仓库脚本推断验证命令与通过条件。
- manual criterion 只能由策略允许的可信用户针对明确 Candidate revision 确认；确认记录不能复用于修订后的 Candidate，且必须与其他 required evidence 一同经过接受事务校验。
- Codex 文本声明“完成”不会直接修改终态。
- Executor 退出后由宿主扫描私有 worktree并导入 Candidate；handoff/最终文本只是非可信声明，required Review 未通过前不能发布 MissionDeliverable。
- 正式交付物以不可变 revision 发布，working hash 变化时拒绝提交。
- 提交 staging/数据库失败时没有部分可见结果。
- 相同 submission 重放幂等，冲突 envelope 明确失败。
- Reviewer 只能针对固定 Artifact revision 或 CodeChangeSet revision 裁定。
- required Review 由宿主按 ReviewPolicy 发起，Executor 遗漏或拒绝请求 Review 都不能绕过。
- Reviewer 使用独立 Codex Session 和 `role.kind='reviewer'`，复用 AgentRun 生命周期但不共享 Producer 对话或可变工作树。
- ReviewAssignment 固定 target/hash、Mission Brief、Rubric、证据和仓库规则，运行后不可被 Producer 修改。
- Reviewer 不依赖自定义工具；Codex 原生沙箱使 Candidate 只读，测试只在隔离临时环境运行且不回写候选。
- 自然语言“通过”不能代替结构化 verdict。
- `review-result.json`/原生结构化输出缺失 required criterion、target/hash 不匹配、pass 中存在 blocking finding或违反 passPolicy 时必须拒绝；缺失结果永不默认 pass。
- pass 通过宿主事务接受 Candidate，并保留真实 Producer provenance；Reviewer 不成为内容生产者。
- revise 创建新的 Executor AgentRun，并通过只读输入文件提供固定 Candidate 与 requiredChanges，不建立 ReviewLoop Task。
- Reviewer 崩溃使用同一 ReviewAssignment 新建 Reviewer AgentRun；超过 maxReviewAttempts 进入 paused，永不默认 pass。
- 人工 override 保留操作者、理由和明确 target revision。
- CodeChangeSet 固定 base、文件操作、内容 hash 和整体 hash。
- 可变工作树不能显示为“已评审代码版本”。

### 16.9 产品闭环

- 用户只需描述目标并确认 Mission 边界即可启动软件开发任务。
- 任务面板始终可见 running/recovering/waiting/parking/parked/reviewing/cancelling 状态。
- 用户可以看到宿主权威运行事实、可选语义摘要、工具时间线、资源和交付物。
- 完成、失败和等待决策均投递回原会话。
- 完成消息使原会话自动置顶。

---

## 17. 风险与待验证事项

### 17.1 Codex 沙箱是否足够强

这是 v3 的首要技术风险。新模型有意利用 Codex 的自治和内部委派能力，因此必须证明整个执行容器可以继承并强制 Mission 边界。若只能设置 `cwd` 或依赖 Codex 自律，方案不能进入无人值守 MVP。

### 17.2 长时自治漂移

取消静态 DAG 后，风险从“错误计划图”转为“Agent 长时执行偏离目标”。缓解措施包括：

- 明确且可验证的 successCriteria；
- 宿主持续维护的 RunSnapshot；
- 可选 ProgressNote 和旁路事件摘要；
- 预算高水位反思；
- 必需的测试、构建和 Review 证据；
- 独立 Reviewer；
- 用户随时可见并可取消。

### 17.3 ProgressNote 的可信度

ProgressNote 是解释辅助信息，不是安全事实源或恢复点。宿主不能仅凭 ProgressNote 判断文件已写入、测试已通过或资源已释放；这些事实必须来自 RunSnapshot 的底层事件、工具结果、Artifact、验证器和执行环境。旁路摘要器生成的内容必须明确标记，避免用户误认为是 Codex 的直接陈述。

### 17.4 CodeChangeSet 与工作树回写

多文件不可变版本和用户工作树之间需要明确的 apply/merge 协议。必须处理 base 漂移、部分失败、重命名、删除、冲突和取消竞态。这是软件开发结果可信性的关键边界。

### 17.5 Review 的独立性

独立 Reviewer 需要隔离上下文和写权限，避免执行者用自身结论替代评审。仍需在技术设计中确定 Reviewer Run 的最小输入、模型配置、预算和失败策略。

### 17.6 Mission Intake 的错误推断

Skill 可能误读仓库、遗漏边界或把模型推断表述成用户事实。MissionDraft 必须保留信息来源和置信度，关键歧义必须由用户回答；宿主对权限、预算和 workDir 独立规范化，确认 UI 必须展示最终生效边界。Skill 的正确性影响 Mission 质量，但不能影响安全边界。

### 17.7 停放期间的现场漂移

Mission 可能等待数小时或数天，期间用户工作树、外部页面、依赖版本和授权配置都会变化。MissionResumeContext 必须包含当前工作区身份和失效假设；新 Run 必须重新读取现场，旧工具确认和旧 hash 不能复用。若漂移使原目标或执行边界失效，应重新澄清或重新确认，而不是强行续跑。

### 17.8 崩溃中间状态的归属和完整性

Shell、编译器和子进程可能一次修改大量文件，崩溃时无法仅靠原生事件判断哪些内容完整。独立 worktree、稳定点扫描、文件 hash 和 RecoveryBundle 是 MVP 的主要缓解措施。任何缺少稳定证据的变化都必须标记 uncertain；恢复的目标是避免丢失已有工作，而不是把不完整工作包装成可靠结果。

---

## 18. 总结

v3 先由 Mission Intake Skill 把用户的简单输入收敛为可靠委托，再由宿主确认边界并托管自治 Codex；它不再建设一个试图提前理解复杂工作的通用 DAG 编排器：

```text
Mission
  └─ AgentRun
       ├─ RunEvent*
       ├─ RunSnapshot
       ├─ ProgressNote*
       ├─ RecoveryBundle*
       ├─ Decision*
       ├─ Deliverable*
       ├─ Evidence*
       └─ Review*
```

Codex 可以自由规划、修订和内部委派；SpaceAssistant 把它视为运行在私有 worktree/sandbox 中的黑盒进程，不关注其认知拓扑，也不修改内部工具循环。宿主只在进程、文件系统、结果导入、正式 apply/merge 和数据库发布边界强制目标授权、资源预算、取消隔离、可观察性和结果可信性。

这一收敛删除了 WorkflowCompiler、Task DAG、Stage、ReadinessResolver、失败传播、ReviewLoop Controller、TaskInputBinding 和 Delegation 等大量编排复杂度，也不依赖 Codex 自定义提交/进展工具或逐副作用回调。同时保留并强化真正不可替代的宿主能力：可信确认、真实沙箱、私有 worktree、进程 drain、generation 导入栅栏、不可变 revision、CodeChangeSet、独立 Review 和后台 UI。

最终产品承诺从“系统提前规划好所有步骤并逐个调度”调整为：

> **用户确认目标和边界，Codex 自主完成工作，宿主确保整个过程安全、可见、可停、可审计，且结果可以被验证。**
