# 后台执行层设计文档

> 状态：讨论中（阶段小结 v4，2026-07-20 — 响应评审意见）
> 最后更新：2025-03-17（v3 基线）；2026-07-20（v4：解决 P0-1/P0-2/P1-1~P1-5/P2-1~P2-6）

---

## 1. 概述

为 SpaceAssistant 新增一个**通用的后台任务执行层**，使用户可以提交一个需要长时间、多阶段执行的任务，在后台自动推进，用户无需持续关注。任务完成后，结果投递回发起会话。

与当前「前台同步」的 `runToolChatSession` 模型不同，后台执行层支持：任务规划的自动生成、多阶段依赖编排、独立会话上下文的并发 Task 执行、以及托管模式下的最小打扰原则。

### 1.1 三个典型场景（设计试金石）

| 场景 | 结构特征 | 执行时长 | 关键需求 |
|---|---|---|---|
| **软件开发** | 多阶段串行（需求→设计→编码→Review），阶段内可并行，每阶段有评审门 | 数小时~数天 | 评审门、断点续传、Task 间文件引用 |
| **PDF 导入** | 单阶段、大量重复 Task（每页 OCR），线性可预测 | 数分钟~数十分钟 | 批量并发 + 限流、质量门 |
| **调研汇总** | 扇出→扇入（N 个子课题并发调研 → 汇总报告） | 数十分钟 | 子任务并发、结果汇总 |

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
| 能力范围 | 单 Shell 命令 | 完整 Agent 能力（读文件 + 推理 + 写文件 + Shell + 浏览器） |

#### 1.2.3 复杂度控制策略

| 策略 | 说明 |
|------|------|
| **复用 > 新建** | Agent 循环复用 `runToolChatSession`，产物追踪复用 `ArtifactRepository`，文件冲突复用 `toolWriteConflict.ts`，跨会话确认复用 `PendingConfirmBanner` |
| **单路径调度** | 所有 Task 走同一条路径（TaskDispatchService → TaskRunner），不区分"桌面路径"和"远程路径" |
| **UI 不可砍** | 独立任务面板作为 MVP 硬性交付项。如果任务面板未就绪，`TaskDispatchService` 虽然可以跑，但用户完全看不到进度——这是 Shell 后台的教训 |
| **MVP 区分** | 最简可交付集：TaskPlan + Task 数据模型 + 内置后端调度 + 任务面板。Stage 层、PlannerRunner、Codex 后端、IM 远程指令可在后续迭代中加入（详见 §1.2.4） |

#### 1.2.4 MVP 范围建议

**MVP 必须有的（不可砍）：**

| 项 | 说明 |
|---|------|
| TaskPlan → Task 数据模型 | 可先不引入 Stage，直接 TaskPlan → Task[] |
| TaskDispatchService + SlotManager | 单 Task 依赖图调度（先不做 Stage 间编排） |
| builtin 后端 | 复用 `runToolChatSession` 核心逻辑，通过 ProgressSink 抽象解耦 WebContents 依赖（§2.4.1） |
| 独立任务面板 | 至少 Task 列表 + Task 详情（只读对话时间线） |
| 结果投递回发起会话 | 完成/失败时在原会话插入系统消息 |
| 资源上限（防失控） | §8.4 |
| Task.output 即时持久化 | 每个 Task 完成时立即写入 `tasks` 表——即使崩溃，已完成 Task 的产出不丢失 |
| 内部 Session 生命周期管理 | Session 标记（`visibility` 字段）/ 关联 / 清理（§2.3） |

**可以延后的（Phase 2+）：**

| 项 | 说明 |
|---|------|
| Stage 层 | 评审门、条件分支、阶段间依赖 |
| PlannerRunner | MVP 用户手动创建 Task（或在聊天中描述需求后一次性生成 Task[]），不需要自动规划 Agent |
| Codex 后端 | 先用 builtin 验证调度模型，Codex 作为能力升级 |
| IM 远程指令 | `/进度`、`/通过` 等 |
| 崩溃恢复 / 断点续传 | 已完成 Task 不丢失（`Task.output` 即时持久化），未完成 Task 需重跑 |

> **按这个 MVP 范围，新设计的本质是「多 Task 并发调度器 + 任务面板 UI」。** 它不做内置状态机（那是 Plan 模式的坑），它有 UI（那是 Shell 后台的坑），它复用现有 Agent 循环（两者都没做到）。

---

## 2. 核心机制

### 2.1 数据模型：三层结构

```
TaskPlan（任务计划）
  ├─ id, sessionId（发起会话）, name, goal（需求简述）
  ├─ status: clarifying | planned | running | paused | completed | failed | cancelled
  ├─ interactionMode: 'interactive' | 'supervised' | 'dedicated'
  └─ stages: Stage[]

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
  ├─ id, name, status: pending | queued | running | confirming | completed | failed | cancelled
  ├─ agentType: 'codex' | 'builtin' | 'planner' | 'user'
  ├─ agentConfig?: { model?, thinkingLevel?, maxTokens?, toolAllowlist? }
  ├─ instruction: 给 Agent 的系统指令（含文件路径、技术参数等精确信息）
  ├─ description?: 给用户看的高层级任务描述（可选，未填时取 instruction 摘要）
  ├─ output?: { summary: string, artifacts: string[] }  ← 结构化产出，artifact 路径供下游 Task 引用
  ├─ sessionId?: 执行时创建的内部对话上下文 ID
  ├─ retryPolicy: { maxRetries, backoffMs }
  └─ retryCount

Step（步骤，工具调用日志粒度，持久化到 task_steps 表）
  ├─ id, taskId, status
  ├─ result / error
  └─ startedAt / completedAt
```

### 2.2 关键数据决策

| # | 决策 | 说明 |
|---|---|---|
| TaskPlan:Session | **1:N** | 每个 Task 拥有独立的内部 Session，不污染发起会话上下文 |
| tasks.instruction | **给 Agent 的系统指令** | 含文件路径引用和精确技术参数；`tasks.description` 给用户看高层描述，两者独立 |
| tasks.output | **结构化产出** | `{ summary: string, artifacts: string[] }`，artifact 路径供下游 Task 通过 `{{task-N.output.artifacts[0]}}` 引用 |
| 持久化 | 4 张新表 | `task_plans` / `task_stages` / `tasks` / `task_steps` |
| 任务间数据传递 | 文件路径 + 模板引用 | MVP：Task 间通过工作目录文件传递产出，调度器在启动下游 Task 前将 `{{task-N.output.artifacts[...]}}` 模板解析为实际路径，注入到 `instruction` |

### 2.3 内部 Session 生命周期

每个后台 Task 在执行时创建独立的内部 Session。以下是完整生命周期定义：

| 阶段 | 行为 | 说明 |
|------|------|------|
| **创建** | `TaskDispatchService` 在 Task 从 `pending` → `running` 时调用 `createSession` | 创建前检查 `Task.sessionId`，若已存在（重试场景）则复用 |
| **标记** | `sessions` 表新增 `visibility` 字段：`'visible'`（默认，前台会话）/ `'internal'`（后台 Task 会话） | 或独立 `task_sessions` 表——技术设计阶段评估两个方案对现有查询的侵入性后决定 |
| **关联** | `tasks.sessionId` → `sessions.id` | Task ↔ Session 一对一 |
| **消息存储** | 走现有 `appendMessage` 路径 | 与前台会话共享存储机制，`task_steps` 是从 Session 消息中提取工具调用事件的**物化视图**，非独立存储 |
| **保留** | Task 完成后 Session **保留不删** | 用于 Task 详情的只读对话时间线回放 |
| **清理** | TaskPlan 取消/删除时**级联清理**所有关联的内部 Session | 防止僵尸 Session 堆积。已完成 TaskPlan 的 Session 保留（可追溯） |
| **不可见** | `visibility='internal'` 的 Session 不暴露在会话列表查询中 | 会话列表查询加 `WHERE visibility != 'internal'` 过滤 |
| **workDir** | 与发起会话的 `workDir` 相同 | 确保文件操作在同一项目上下文中 |

### 2.4 调度器：TaskDispatchService

核心组件：

```
TaskDispatchService
  ├─ TaskQueue          ← 从 tasks 表加载 pending Task，按优先级排序
  ├─ SlotManager        ← 全局资源槽位（LLM / Browser / Shell），类似 RemoteTaskController 的 slot 模型
  ├─ TaskRunnerFactory  ← 根据 agentType 创建 Runner
  │   ├─ 'codex'    → CodexRunner（Codex CLI 子进程，JSON-RPC）
  │   ├─ 'builtin'  → ToolChatRunner（复用 runToolChatSession）
  │   ├─ 'planner'  → PlannerRunner（生成 TaskPlan 的 Stage/Task 结构）
  │   └─ 'user'     → UserTaskNotifier（发通知等人操作，P0/P1 上报）
  ├─ StageAdvancer     ← Task 完成后检查 Stage 推进 / 阻塞
  └─ TaskProgressBus   ← 事件总线，向各渠道同步进度
```

#### 2.4.1 核心架构决策：ProgressSink 抽象（解决 sender 依赖）

**问题**：当前 `runToolChatSession` 的签名依赖 `sender: WebContents` 进行 IPC 推送（流式文本、工具调用增量、token usage 等 20+ 处调用）。后台 Task 在以下场景没有可用的 `WebContents`：

| 场景 | sender 来源 | 问题 |
|------|------------|------|
| 前台聊天 | 用户交互窗口的 `WebContents` | ✅ 自然存在 |
| 后台 Task（窗口打开） | 可复用当前窗口的 `WebContents` | ⚠️ 哪个窗口？多个窗口时选哪个？ |
| 后台 Task（窗口关闭） | **无 `WebContents` 可用** | 🔴 Task 无法执行 |
| 后台 Task（IM 触发） | IM 消息没有 `WebContents` | 🔴 IM 远程任务无法创建 |

**需求**：`runToolChatSession` 的进度推送机制需要从依赖具体 `sender: WebContents` 改为依赖**可替换的进度接收器抽象**（ProgressSink）。这不是加一个 `onProgress` 回调就能解决的问题——它涉及 20+ 处 `safeWebContentsSend` 调用的重构。

**需求层面的抽象**：

```
ProgressSink 接口（需求定义，非代码接口）：
  - 接收流式文本增量 → 推送给 UI 或 TaskProgressBus
  - 接收工具调用事件 → 推送给 UI 或持久化到 task_steps
  - 接收 token usage → 更新 Task 统计
  - 接收工具确认请求 → 托管模式下按权限策略自动决策
  - 接收错误通知 → 路由到 Task 错误处理
```

| 场景 | ProgressSink 实现 | 说明 |
|------|-------------------|------|
| 前台聊天 | `WebContentsSink`（现有 `safeWebContentsSend` 逻辑） | 不变 |
| 后台 Task（窗口打开） | `WebContentsSink` → 同时桥接到 `TaskProgressBus` | 用户可实时看 UI |
| 后台 Task（窗口关闭/IM） | `TaskProgressBusSink`（不依赖渲染进程） | 进度写数据库，IM 拉取/UI 下次打开时回放 |

**关键需求**：
- 同一个 `runToolChatSession` 核心执行逻辑（`toolChatLoop.ts`）不感知 `WebContents`，只调用 `ProgressSink` 的方法
- 进度数据始终持久化到 `task_steps`（作为 Session 消息的物化视图），保证「窗口关闭 → 重开 → 回放进度」的可追溯性
- 需要评估对现有测试（`toolChatLoop.*.test.ts` 系列）的影响范围

### 2.5 进度同步：TaskProgressBus

事件类型：

| 事件 | 触发时机 | 频率 |
|---|---|---|
| `plan:statusChanged` | TaskPlan 状态变更 | 低频 |
| `stage:advanced` | Stage 推进/阻塞 | 低频 |
| `task:started` | Task 开始执行 | 低频 |
| `task:progress` | Task 执行中的进度更新 | 中频（描述性文本，有变更时） |
| `task:step` | Step 的创建/更新/完成 | 高频（工具调用粒度，50ms 防抖合并） |
| `task:confirming` | Task 需要用户确认 | 事件触发 |
| `task:completed` | Task 执行完成 | 低频 |
| `task:failed` | Task 执行失败 | 低频 |

- Task 进度使用**描述性文本**（statusText + completedSteps），不用硬百分比
- Step 事件实时推送 + 50ms 防抖合并（`step:started`/`step:progress` 合并，`step:done` 立即 flush）
- 进度更新通过 `ProgressSink`（§2.4.1）的对应方法推送，而非直接依赖 `sender: WebContents`。`ProgressSink` 在后台场景下由 `TaskProgressBus` 实现，同时负责将 Step 事件持久化到 `task_steps` 表（作为 Session 消息中工具调用的物化视图）

### 2.6 补充子题（标记，后续深化）

| # | 题目 | 状态 |
|---|---|---|
| #A | 暂停/恢复/取消的精细语义 | 留接口 |
| #B | 崩溃恢复 / 断点续传（crash 后 `running` → `pending`，从 `task_steps` 日志重建） | 留接口，但 MVP 至少保证每个 Task 完成时 `Task.output` 立即持久化到 `tasks` 表 |
| #C | Task 间结构化数据传递 | ✅ 已明确：`TaskOutput.artifacts` + `{{task-N.output.artifacts[...]}}` 模板引用（§2.2），调度器启动时解析 |

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
- **确认后**：创建 TaskPlan → 启动规划 Agent → 原会话插入"任务已提交"消息 → 会话恢复自由

**注意**：需求澄清不进入后台任务面板。TaskPlan 创建后，规划 Agent 生成的 Stage（如"需求文档"）才是任务面板的第一个 Stage。

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
| `/继续` | 恢复执行 |
| `/取消` | 取消整个 TaskPlan |
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
| ReviewGate | LLM 自评审为默认策略。用户评审仅在声明要求或 LLM 无法判断时触发 |
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

### 5.2 两种后端

| agentType | 后端 | 适用场景 | 可用性 |
|---|---|---|---|
| `codex` | Codex CLI 子进程（JSON-RPC） | 重度编码、复杂多步骤任务 | 需用户安装 Codex CLI |
| `builtin` | `runToolChatSession`（HTTP API） | 无 Codex 环境、轻量任务、调研汇总 | 始终可用 |

**自动 fallback**：Codex 不可用时，`codex` Task 自动降级为 `builtin`，记录降级日志，不影响 TaskPlan 整体执行。

#### 5.2.1 `agentType` 的 required vs preferred 语义

Task 创建时需区分用户/规划 Agent 对 Codex 的依赖强度：

| 语义 | 含义 | Codex 不可用时的行为 |
|------|------|---------------------|
| `agentType: 'codex'`（默认 = preferred） | 优先使用 Codex，但可用 builtin 替代 | 自动 fallback，记录日志 |
| `agentType: 'codex-required'` | 必须使用 Codex，不允许降级 | Task 标记为 `failed`，P1 通知用户：「需要 Codex CLI 但环境不可用」 |

`codex-required` 的典型场景：依赖 Codex 特有的工具链（如 Codex 沙箱中才能执行的重度重构），降级到 builtin 无法完成任务。用户在创建 Task 时可按需显式声明。

### 5.3 成本选项：TaskAgentConfig

每个 Task 可配置执行成本，匹配不同复杂度：

```ts
interface TaskAgentConfig {
  model?: string;              // 覆盖默认模型
  thinkingLevel?: 'low' | 'medium' | 'high';  // 推理强度
  maxTokens?: number;
  codexCliPath?: string;       // Codex CLI 路径（未安装时留空，fallback）
  toolAllowlist?: string[];    // builtin 专属：裁剪工具集
}
```

用户可在 TaskPlan 级别设定默认值，每个 Task 可覆盖。典型用法：调研 Task 用 `thinkingLevel: 'low'` + 便宜模型；编码 Task 用 `thinkingLevel: 'high'` + 强模型。

### 5.4 三个核心需求

| 需求 | 实现 |
|---|---|
| 给定目标，交付结果 | Task.instruction → Agent 执行 → Task.output |
| 上下文隔离 | builtin：Task 独立 Session；codex：独立 CLI 子进程 |
| 可配置成本 | `agentConfig.model` + `agentConfig.thinkingLevel` |

### 5.5 与已有 CLI Subagent 设计的关系

已有 `cli-subagent-integration-design` 中的 `dispatch_subagent` 是**主 Agent 工具循环内**的一个工具（主 Agent 在对话中主动委派子任务）。后台 Task SubAgent 是在**调度器层**选择后端，不经过主 Agent 工具调用。

两者不冲突且可整合：后台 Task 的 `codex` 后端可复用已有设计中的 CLI 子进程管理层（`subagentProcess.ts`、`codexBackend.ts`），调用方从"主 Agent 工具执行器"变为"TaskDispatchService"。

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
| 2 | TaskPlan 详情（右侧主区域） | 所有 Stage + Task 概览，含状态图标、进度文本、产出文件链接 |
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
│  🔧 run_script npm test                    ⏳           │
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
| 产出摘要 | `Task.output` |
| 变更文件列表 | 从 `task_steps` 中提取 write_file / edit_file 调用 |
| 失败原因 + 重试状态 | failed 状态专属 |

**操作按钮**：

| 操作 | 出现条件 | 语义 |
|---|---|---|
| [重新执行] | completed / failed | **仅重跑当前这一个 Task**，不影响同 Stage 的其他 Task 和后续 Stage。使用相同的 `instruction` 和 `agentConfig`，`retryCount += 1` |
| [跳过此 Task] | failed | 将当前 Task 标记为 `cancelled`，调度器跳过该 Task 继续执行同 Stage 的后续 Task。**职责在用户**：如果下游 Task 依赖被跳过的 Task 的产出，用户需自行补缺口 |
| [暂停] | running | 暂停当前 TaskPlan（同 §2.6 #A，留接口） |
| [取消] | running | 取消整个 TaskPlan，终止所有 running Task，级联清理内部 Session |

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

托管模式下，Agent 自动执行写文件、Shell、浏览器操作。安全保障通过三层边界实现，且与现有 artifact 系统分工协作：

- **调度器层（新增）**：入口级能力授权——Task 能不能执行某类操作？
- **artifact 层（已有）**：精细归属决策——文件写哪里？属于什么容器？需不需要用户决策？

两层各管各的，不冲突。

**重要：三层安全边界的实际适用范围因后端而异。** 以下各节明确标注每条规则对 `builtin` 和 `codex` 是否有效。

### 8.2 第一层：工作目录边界（已有，不变）

现有 `pathSecurity.ts` 已在 `runToolChatSession` 中生效。后台 Task 和前台对话走同一机制——文件操作不可超出工作目录。这一层不因托管模式而放宽。

### 8.3 第二层：Task 级授权范围（新增）

每个 Task 在 `agentConfig` 中声明允许的操作。规划 Agent 生成 Task 时按 Stage 类型自动填入默认值。

> **适用范围标注**：🔵 = 对 `builtin` 和 `codex` 均有效 &nbsp;&nbsp;🟠 = 仅对 `builtin` 有效（Codex 在独立子进程中执行，SpaceAssistant 无法在工具级别拦截）

```ts
interface TaskAuthorizationScope {
  readFiles: boolean;           // 默认 true  🔵
  writeFiles: boolean;          // 默认 true  🔵（codex：cwd 限定 + 输出大小截断）
  deleteFiles: boolean;         // 默认 false 🔵
  shellCommands: {
    enabled: boolean;           // 默认 false 🟠 仅 builtin；codex 在自己的沙箱中执行，不受此白名单约束
    allowlist?: string[];       // 白名单命令前缀 🟠 仅 builtin
  };
  browser: {
    enabled: boolean;           // 默认 false 🔵
    allowedDomains?: string[];  // 允许访问的域名 🔵
    allowAct: boolean;          // 是否允许交互操作 🔵
  };
  maxFileWriteBytes: number;    // 单次写入上限 🔵
}
```

**Codex CLI 的实际安全边界**（与 builtin 的差异）：

| 安全机制 | builtin | codex |
|----------|---------|-------|
| 工作目录限定（`cwd`） | ✅ `pathSecurity.ts` | ✅ 启动时指定 `cwd` |
| Shell 白名单 | ✅ 在工具执行前拦截 | ❌ Codex 在自己的进程中执行 Shell |
| 工具调用计数 / 文件写入计数 | ✅ SpaceAssistant 统计 | ❌ Codex 内部计数器独立 |
| 环境变量过滤 | N/A（走终端） | ✅ 启动前剔除敏感 token/secret |
| 超时看门狗 | ✅ `maxShellDurationSec` | ✅ 进程超时强制 kill |
| 输出大小截断 | ✅ | ✅ stdout 超上限截断 |

结论：Codex 的安全模型本质上是**「信任 Codex 在工作目录内做任何事」**——这与 builtin 的「入口级能力授权」不同。在 Task 创建时应让用户知情：选择 Codex 后端意味着 Agent 拥有更大的自主权。

不同场景的默认授权：

| 场景 | 读文件 | 写文件 | Shell | 浏览器 |
|---|---|---|---|---|
| 软件开发 | ✅ | ✅ | ✅（`npm`, `git`, `python`） | ❌ |
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

**Codex CLI 安全边界**：Codex 在自己的子进程中执行工具，SpaceAssistant 无法在工具级别拦截。安全策略变为启动前约束：

- `cwd` 限定为工作目录
- 环境变量过滤（剔除敏感 token、secret）
- 超时看门狗（进程超时强制 kill）
- 输出大小限制（stdout 超过上限截断）

与已有 CLI Subagent 设计中的安全边界一致（`subagentSecurity.ts`、`subagentProcess.ts`），直接复用。

### 8.4 第三层：资源上限（防失控）

> **数值状态**：初始估算值（以重度开发 Task 为基线 +30%），待 MVP 实测后校准。用户手动创建的 Task 可在创建时自定义上限。

以重度开发 Task 为基线 +30%，仅用于检测失控，不限制正常执行：

| 资源 | 重度基线 | 上限 | 适用范围 |
|---|---|---|---|
| `maxToolCalls` | 1500 | **2000** | 🟠 仅 builtin（Codex 工具调用由 CLI 内部计数，SpaceAssistant 无法统计） |
| `maxFileWriteCount` | 50 | **65** | 🟠 仅 builtin（同上） |
| `maxFileWriteBytes` | 50 MB | **65 MB** | 🔵 builtin + codex |
| `maxDurationMinutes` | 240 min | **300 min（5h）** | 🔵 builtin + codex |
| `maxShellDurationSec` | — | **300s**（单次，不按 Task 级缩放） | 🔵 builtin + codex |

> **注意**：对于 MVP（无 PlannerRunner，用户手动创建 Task），实际执行时长通常远低于 300min 上限。5h 上限仅为防失控兜底，不代表推荐执行时长。如果实际场景发现不够，调常量即可，不改变机制。

超限处理：

| 资源 | 超限行为 |
|---|---|
| 工具调用次数 | 强制终止 Task，P1 上报："任务可能陷入循环" |
| 磁盘写入 | 强制终止 Task，P1 上报："写入量已达上限" |
| 执行时间 | 强制终止 Task，P2 自动重试 1 次 |
| Shell 超时 | 杀 Shell 进程，Agent 可选择重试或报错 |

后续如果实际场景发现不够，调常量即可，不改变机制。

### 8.5 文件写入并发冲突（已有机制复用）

Task 并发执行时可能两个 Agent 同时编辑同一文件。现有 `toolWriteConflict.ts` 已按 `sessionId` 隔离并发写入，artifacts 系统的 `pathLeaseRegistry` 提供工具级文件路径租约。每个 Task 有独立 Session，这些机制直接生效——先写入者成功，后写入者检测到冲突时被告知"文件已被修改"。

---

## 9. 与 Artifact（产物）系统的整合

已有 artifact 系统（`electron/artifacts/`）负责文件产物的追踪、分类与展示。后台任务执行层不需要重建产物管理，而是**复用和聚合**：

| 整合点 | 方式 |
|---|---|
| Task 详情中的变更文件列表 | 查询该 Task 内部 Session 的 `ArtifactRepository.listBySession(sessionId)` |
| 阶段 3 投递消息中的产出清单 | 遍历所有 Task 的内部 Session，收集 `primary` + `supporting` artifact，聚合到发起会话的 `SessionArtifactsPanel` |
| 文件归属 | 后台 Task 默认走 `agent-default` 路径来源（见 §8.3），用户无需逐文件确认 |
| 资源统计 | `maxFileWriteCount` 通过 `ArtifactRepository` 实时查询写入文件数 |

---

## 10. 待解决事项追踪

| # | 问题 | 状态 |
|---|---|---|
| #1 | 后台 Session 不列在聊天侧栏，用户在哪查看？ | ✅ 已解决：独立任务面板 + 完成消息投递 + 会话自动置顶 |
| #2 | Task 详情的执行过程与对话上下文是否重复？ | ✅ 已解决：合并为只读对话时间线，同一信息源 |
| #3 | 权限与安全模型 | ✅ 已解决：三层边界 + 明确 builtin/codex 适用范围差异 + artifact 系统整合 |
| #4 | 资源上限怎么设？ | ✅ 已解决：重度基线 +30%，标注为初始估算值，区分 builtin/codex 适用范围 |
| #5 | 内部 Session 生命周期（创建/标记/关联/清理） | ✅ 已解决：完整生命周期定义（§2.3），sessions 表扩展方案待技术设计评估 |
| #6 | `sender: WebContents` 依赖与后台调度器架构冲突 | ✅ 已解决：ProgressSink 抽象（§2.4.1），需求层面定义，实现层面待技术设计 |
| #7 | Task 间结构化数据传递 | ✅ 已解决：`TaskOutput.artifacts` + `{{task-N.output.artifacts[...]}}` 模板引用（§2.2） |
| #8 | interaction_mode 与 P0-P3 的映射 | ✅ 已解决：4×3 决策矩阵（§4.3） |
| #A | 暂停/恢复/取消的精细语义 | 留接口，后续深化 |
| #B | 崩溃恢复 / 断点续传 | 留接口，但 MVP 至少保证 Task.output 即时持久化 |
| #D | 规划 Agent 产出是否需用户确认 | 桌面通知可查看，IM 默认接受 |

---

## 11. 讨论完成度总结

- [x] **核心机制**：三层数据模型（TaskPlan/Stage/Task）、TaskDispatchService 调度器、TaskProgressBus 事件总线
- [x] **交互机制**：三阶段模型（聊天澄清 → 任务面板执行 → 结果投递）、托管模式原则、IM 远程指令扩展
- [x] **SubAgent**：Codex CLI + builtin 两个后端、统一契约、required/preferred fallback 语义、可配置成本选项
- [x] **与聊天界面协同**：会话自动置顶、内部 Session 不可见、阶段 1/3 在聊天中完成
- [x] **执行进度 UI 展现**：Activity Bar 任务图标、任务面板三视图、Task 详情 = 只读对话时间线、操作按钮语义明确
- [x] **权限与安全**：三层边界（工作目录 + Task 授权 + 资源上限）、明确 builtin/codex 适用范围差异、artifact 系统整合
- [x] **Artifact 系统整合**：复用 `artifactRepository` 追踪产物、`SessionArtifactsPanel` 展示产出
- [x] **架构抽象**：ProgressSink 抽象解耦 `sender: WebContents` 依赖，支持窗口关闭和 IM 远程场景
- [x] **Session 生命周期**：内部 Session 创建/标记/关联/清理完整定义
- [x] **Task 间数据传递**：`TaskOutput.artifacts` + `{{task-N.output.artifacts[...]}}` 模板引用协议
- [x] **托管模式决策矩阵**：P0-P3 × interaction_mode 4×3 矩阵明确
- [x] **资源上限**：标注初始估算值，区分 builtin/codex 适用范围
- [x] **Task 模型**：拆分 `instruction`（给 Agent）和 `description`（给用户）
- [x] **reviewGate**：增加 `onReject` 行为定义
