# Plan 模式执行期自动化 — 需求规格

> **状态：已废弃 — 见 [remove-plan-mode-requirement.md](./remove-plan-mode-requirement.md)**

**版本：** 1.0  
**日期：** 2026-05-26  
**状态：** 待评审  
**关联文档：** [通用Agent-Plan模式MVP产品需求文档.md](./通用Agent-Plan模式MVP产品需求文档.md)、[plan-detail-panel-requirement.md](./plan-detail-panel-requirement.md)、[plan-resume-button-state-requirement.md](./plan-resume-button-state-requirement.md)

**参考日志：** `logs/Agent-20260526.log`（会话 `ee58f112-58fc-4195-a602-53dd1c14f077`，7 步计划「创建高概念种子生成与筛选 Skill」）

---

## 1. 概述

### 1.1 背景

Plan 模式的设计意图是：**规划与对齐在前、批量执行在后**。用户已在探索期参与澄清、在审批闸门确认目标与步骤列表后，执行期应视为「已授权的一次性交付」，而非另一轮逐步点确认的交互。

当前桌面端实现与上述意图不一致，形成 **双重人工闸门**：

| 阶段 | 期望 | 现状 |
|------|------|------|
| 探索 / 澄清 | 用户参与、逐步确认 | ✅ 符合预期 |
| 计划审批 | 用户一次性批准方案与步骤 | ✅ 符合预期 |
| **执行期** | 批准后自动推进至完成或阻塞 | ❌ 每步需点「继续执行」 |
| **步骤内工具调用** | 计划级授权覆盖范围内操作 | ❌ 仍逐次 `WriteConfirmCard` 确认 |

飞书远程 Agent（`electron/feishu/feishuRemoteAgent.ts`）在计划确认后已采用 **多步自动循环**（`resumePlanExecution` 至多 20 次），与桌面端「单步 + 手动继续」形成产品体验割裂。

### 1.2 问题陈述

用户在目标明确、步骤列表已批准之后，仍被迫：

1. **步间**：每完成一步回到 PlanPanel 点「继续执行」（7 步计划 ≈ 7 次额外点击）；
2. **步内**：每个 `write_file` / `edit_file` / `run_script` 再弹确认卡，未在场则 5 分钟超时失败；
3. **恢复**：步间暂停导致长时间离开后会话闲置（日志中 Step 1 结束于 `01:50`，Step 2 始于 `13:36`，间隔约 12 小时）。

结果是：**Plan 模式比「普通模式 + 自己盯每一步」更费神**，审批闸门的价值被稀释。

### 1.3 目标

| # | 目标 |
|---|------|
| G1 | **批准后默认自动执行全部步骤**，用户无需步间重复点击 |
| G2 | **计划级授权向下传递**：执行期工具确认策略与「已批计划」对齐，避免逐步 + 逐工具双重点击 |
| G3 | **可观测、可中断**：自动执行期间进度实时可见，用户随时暂停/取消 |
| G4 | **阻塞可恢复**：失败/高风险/环境变更时暂停并明确告知，而非静默超时 |
| G5 | **与飞书远程行为一致**：同一套编排语义，避免渠道分叉 |
| G6 | **全局待办提示准确**：Plan 执行中不误报「待确认 / 待审批」；仅展示**当前需要用户决策**的条目 |
| G7 | **自生成脚本免确认**：Plan 执行期 Agent 当场编写或先写后跑的 `run_script` 默认自动批准；运行仓库既有脚本仍确认 |

### 1.4 非目标（本文不覆盖）

- Coordinator 澄清流程改造（见 [plan_mode_optimization_design.md](../develop/plan_mode_optimization_design.md)）
- 多 Worker 并行、步骤依赖图可视化
- 计划完成后自动 git 回滚
- 「继续执行」按钮 loading/disabled 细节（见 [plan-resume-button-state-requirement.md](./plan-resume-button-state-requirement.md)，本文改变的是按钮**主路径**而非样式）

---

## 2. 日志实证（2026-05-26）

以下摘自 `logs/Agent-20260526.log`，用于量化痛点。

### 2.1 会话概要

| 项 | 值 |
|----|-----|
| 计划 | 创建高概念种子生成与筛选 Skill |
| 步骤总数 | 7 |
| 探索 + 修订 | 约 01:27–01:29（Coordinator 多轮只读探索 + 用户修订路径） |
| 执行 Worker | requestId `4700af62…`（Step 1）、多 requestId 并发（Step 2） |

### 2.2 步间人工等待

| 步骤 | 首次 Worker 请求 | 下一步开始 | 间隔 / 现象 |
|------|------------------|------------|-------------|
| 1 | 01:30:24 | — | 步内 5 轮 LLM（工具确认超时） |
| 1→2 | 01:50:55（Step 1 结束） | 13:36:10 | **~11h46m** 步间暂停，需用户返回点继续 |
| 2→3 | 13:44 附近 | 14:38:04 | 仍有步间等待 |
| 3→4 | 14:38:04 | 14:38:20 | 16s（可能连续点击或重复触发） |

### 2.3 工具确认超时 / 拒绝（Step 1 典型）

```
01:35:29 tool.confirm run_script  → timeout
01:40:36 tool.confirm write_file  → timeout
01:45:42 tool.confirm edit_file   → timeout
01:50:48 tool.confirm edit_file   → timeout
```

Step 1 在**计划已批准**前提下，因用户未逐条确认写入操作，Worker 空转约 20 分钟后才 `end_turn` 结束该步——**计划级审批未转化为执行授权**。

### 2.4 重复触发（Step 2）

`13:36:10` 同一秒内出现 3 个不同 `requestId` 的 Step 2 Worker 请求（`c3ac4820`、`ade55520`、`17d5c336`），说明在「手动继续」模型下用户重复点击或缺少执行互斥，**自动执行方案必须内置单飞（single-flight）锁**。

### 2.5 全局待办提示误报（Session Attention Banner）

同一会话在 **Plan 已处于 `executing`**（例如 Step 2/7 运行中或步间暂停）时，左侧 `pending-confirm-banner` 区域仍可能出现：

| 条类型 | 组件 | 典型文案 | 用户感知 |
|--------|------|----------|----------|
| 工具待确认 | `PendingConfirmBanner` | `N 项待确认` | 「我已经批过计划了，为什么还要确认？」 |
| 计划待审批 | `PendingPlanBanner` | `N 个计划待审批` | 「计划明明在执行，怎么还要审批？」 |

日志侧证：Step 1 执行期多次 `tool.confirm … outcome: timeout`（L45–L60），即使用户已批准计划，**写入类工具仍进入待确认队列**；步间暂停或切换会话后，banner 持续提示「待确认」，与「计划已授权、正在交付」的心智模型冲突。

**结论：** 当前 banner 按「Store 内有条目即展示」，未结合 Plan 执行态过滤**可行动待办**，属于对待办提示机制的误用。

---

## 3. 现状架构梳理

### 3.1 执行编排（桌面端）

```text
用户点「批准并执行」/「开始执行」/「继续执行」
  → ChatView.runPlanWorkerWithoutNewUser()
  → claudeChatCreateWithTools (chatMode: plan)
  → runPlanModeChat → runWorkerExecution（仅 1 步）
  → advancePlanStep → plan.status = executing，等待下一次手动 resume
```

关键代码：`runWorkerExecution` 每次调用只执行 `currentStepIndex` 对应的一步，完成后返回，**无步间循环**。

### 3.2 执行编排（飞书远程，已自动）

```text
计划确认 (Y) 后
  for i in 0..maxSteps:
    resumePlanExecution()
    if plan.status in (completed, cancelled): break
```

参考：`electron/feishu/feishuRemoteAgent.ts` L108–130。

### 3.3 工具确认（与 Plan 无关）

`toolChatLoop.ts` 中 `toolNeedsUserConfirmation` 对所有写操作一视同仁，**不区分**是否处于 `planToolPhase: 'implementation'` 且计划已 `approved/executing`。Plan 审批与 `WriteConfirmCard` 完全独立。

### 3.4 全局待办提示（现状）

左侧会话列表下方并列两个 Banner，**共用** `.pending-confirm-banner` 样式（见 [plan-detail-panel-requirement.md §9](./plan-detail-panel-requirement.md)）：

| 组件 | Store | 写入时机 | 清除时机 |
|------|-------|----------|----------|
| `PendingConfirmBanner` | `pendingConfirmStore` | 主进程 `tool:confirm-request` | `tool:result` / 用户 respond / `abortSessionRun` → `rejectAllForSession` |
| `PendingPlanBanner` | `pendingPlanStore` | `plan:approval-ready` / `plan:state-changed` → `planRead` | `pendingPlan` 非 `awaiting_approval` 时 `removeSession` |

**缺口：**

1. **`finishSessionRun` 不清除工具待确认**：Worker 单步结束只 `unregisterRunRequest`，未按 `requestId` 清理 `pendingConfirmStore`；若 `tool:result` 丢失或步间仍有残留条目，banner 继续显示。
2. **无 Plan 态感知**：`PendingConfirmBanner` 不区分「普通聊天写入」与「已批计划执行期写入」；后者在用户视角不应算独立待办。
3. **`pendingPlanStore` 与 Redux 会话 metadata 可能不同步**：`refreshFromSessions` 读本地 `session.metadata`，若批准/执行后列表未刷新，可能短暂（或持续）保留 `awaiting_approval` 条目。
4. **缺少「可行动性」校验**：条目在 Store 中 ≠ 用户此刻必须处理（可能是 orphan、已 timeout 但未收到 `tool:result`、或已 auto-approved 却仍留在 Store）。

### 3.5 与既有 PRD 的冲突

[通用Agent-Plan模式MVP产品需求文档.md §2.3](./通用Agent-Plan模式MVP产品需求文档.md) 写明：

> 获批后仍保留逐次确认（安全网不变）

该条在 **MVP 保守策略** 下合理，但与用户实际反馈（批准后仍逐步、逐工具确认）冲突。本文提议 **修订执行期策略**：保留安全网的可配置性与高风险兜底，**默认**在已批计划执行期降低确认摩擦。

---

## 4. 目标体验（用户故事）

### US-01：批准后一键跑完

**作为** 已批准 7 步计划的用户，  
**我希望** 点击「批准并执行」后 Agent 连续执行全部步骤，  
**以便** 我可以离开去做别的事，只在完成或出问题时回来看。

**验收要点：**

- 批准后无需再点「继续执行」即可跑完 Step 1…N（除非用户主动暂停或触发阻塞策略）。
- PlanPanel 实时显示「第 N/M 步 · 执行中…」。

### US-02：计划授权覆盖步内写入与自生成脚本

**作为** 已在审批卡片中确认步骤列表的用户，  
**我希望** 执行期不再对每个 `write_file` 重复确认，且 Agent 为完成步骤当场写的短脚本（如 `mkdir`）也不再弹确认，  
**以便** 不会出现「批了计划却还要守 5 分钟超时」的情况。

**验收要点：**

- 默认：Plan Worker 执行期内 `write_file` / `edit_file` 自动批准。
- 默认：`autoApproveAgentGeneratedScripts=true` 时，Agent 内联或先写后跑的 `run_script` 自动批准（§6.6）。
- Agent 原样运行仓库 **已有** `.py` 脚本时，**仍** 需确认。

### US-03：随时暂停与恢复

**作为** 旁观自动执行的用户，  
**我希望** 能一键「暂停」并在之后「从第 N 步继续」，  
**以便** 临时介入审查中间产物。

### US-04：失败时不 silently 卡死

**作为** 用户，  
**我希望** 某步失败或工具被拒后计划进入「已暂停」并说明原因，  
**以便** 我选择重试、修订计划或取消，而不是 Worker 空转超时。

### US-05：执行中不误报待办

**作为** 已批准计划并切到其他会话的用户，  
**我希望** 左侧不出现「待确认 / 待审批」banner（除非真有高风险工具或新计划待批），  
**以便** 不被错误的红色/黄色告警拉回，执行进度只在 PlanPanel / badge 中体现。

---

## 5. 执行模式设计

### 5.1 模式枚举

```typescript
/** 计划执行驱动方式（会话级或全局配置，默认 auto） */
type PlanExecutionMode =
  | 'auto'           // 批准后自动连续执行全部步骤（推荐默认）
  | 'step_manual'    // 保留现有：每步完成后等待用户点「继续执行」
  | 'step_confirm'   // 每步完成后弹轻量确认「执行下一步？」（不推荐默认）
```

| 模式 | 适用场景 |
|------|----------|
| `auto` | 绝大多数：步骤已在审批中看清，用户要「交钥匙」 |
| `step_manual` | 强监管：每步产物必须人工 eyeball 后再继续 |
| `step_confirm` | 折中（可选）：自动跑完当前步，步间弹窗确认 |

**默认：** `auto`。设置入口见 §8.1。

### 5.2 自动执行状态机（`auto` 模式）

在现有 `PlanMeta.status` 基础上，增加 **执行子状态**（可存入 `Session.metadata.plan_execution` 或扩展 `PlanMeta`）：

```typescript
type PlanExecutionRunState =
  | 'idle'              // 未在跑
  | 'running'           // 自动/手动正在执行某步
  | 'paused_user'       // 用户点击暂停
  | 'paused_blocked'    // 步骤 failed/blocked 或策略触发暂停
  | 'paused_confirm'    // 等待步间确认（step_confirm 模式）
  | 'completed'
  | 'cancelled'
```

```text
approved / executing
  --[开始执行 run]--> running (stepIndex = k)
  --[step k 成功]--> running (stepIndex = k+1)   // auto：不经过 idle
  --[全部完成]--> completed
  --[用户暂停]--> paused_user
  --[blocked/failed 策略]--> paused_blocked
  --[用户取消]--> cancelled

paused_* --[继续/恢复]--> running
```

**不变量：**

- 同一 `sessionId` 同时最多 **一个** `running` 执行会话（修复日志中的三 requestId 并发）。
- `running` 期间禁止第二次 `plan:run` / `onPlanResume`（UI disabled + 主进程 reject）。

### 5.3 编排入口统一

新增主进程能力（名称可调整，语义如下）：

| IPC | 说明 |
|-----|------|
| `plan:run` | 启动或恢复自动执行循环（替代多次 `plan:resume-execution` 由渲染进程串联） |
| `plan:pause` | 请求优雅暂停（当前步完成后停，或 abort 当前 Worker） |
| `plan:resume-execution` | **保留**，单次推进一步（供 `step_manual` 与飞书兼容） |

**`plan:run` 伪代码：**

```typescript
async function runPlanUntilDone(args) {
  acquireSessionExecutionLock(sessionId)
  try {
    while (true) {
      if (await shouldPause(sessionId)) break
      const plan = getPlanMeta(...)
      if (!plan || plan.status === 'completed' || plan.status === 'cancelled') break
      const res = await runWorkerExecution({ ... }) // 现有单步
      if (!res.ok) { markPausedBlocked(...); break }
      if (plan.status === 'completed') break
      if (getExecutionMode() === 'step_manual') break
      if (getExecutionMode() === 'step_confirm' && !await askStepConfirm()) break
    }
  } finally {
    releaseSessionExecutionLock(sessionId)
  }
}
```

**渲染进程：** `handlePlanApprove` 在 `autoExecute` 时调用 `plan:run` 而非单次 `runPlanWorkerWithoutNewUser`；`handlePlanResume` 在 `auto` 模式下同样走 `plan:run`。

---

## 6. 工具确认策略（计划级授权）

### 6.1 原则

> **计划审批 = 对步骤列表所描述操作的批量授权。**  
> 执行期不应要求用户对每一步写入再次表达相同意图。

与 MVP 文档「操作级安全网」的关系：**安全网保留，但默认在 Plan 执行期降级为异常触发**，而非每调用一次触发一次。

### 6.2 策略枚举

```typescript
type PlanToolConfirmPolicy =
  | 'trust_plan'        // 默认：implementation 阶段写操作自动通过（run_script 除外见下）
  | 'trust_plan_all'    // 含 run_script 也自动（激进，需设置显式开启）
  | 'always_confirm'    // 与现网一致：逐步 + 逐工具确认
  | 'confirm_high_risk' // 仅 high risk 确认（推荐与 trust_plan 等价实现）
```

**默认：** `confirm_high_risk`（等价于 `trust_plan`：自动批准 `write_file` / `edit_file`；`run_script` 见 §6.6 来源判定；`run_lark_cli` 仍确认）。

### 6.3 判定规则（写操作 + 非自生成脚本）

在 `toolChatLoop.ts` 增加分支（在 `needsConfirm` 之后）：

```typescript
function shouldSkipToolConfirm(args: {
  planToolPhase: PlanToolPhaseArg
  planMeta: PlanMeta | null
  policy: PlanToolConfirmPolicy
  toolName: string
  toolInput: Record<string, unknown>
  provenance: RunScriptProvenanceContext
  planConfig: PlanConfig
}): boolean {
  if (args.planToolPhase !== 'implementation') return false
  if (!args.planMeta || !['executing', 'approved'].includes(args.planMeta.status)) return false

  switch (args.policy) {
    case 'always_confirm':
      return false
    case 'trust_plan_all':
      return true
    case 'trust_plan':
    case 'confirm_high_risk':
      if (args.toolName === 'run_lark_cli') return false
      if (args.toolName === 'run_script') {
        return (
          args.planConfig.autoApproveAgentGeneratedScripts &&
          isAgentGeneratedRunScript(args.toolInput.code, args.provenance)
        )
      }
      return args.toolName !== 'run_script' && args.toolName !== 'run_lark_cli'
  }
}
```

> **与 §6.6 关系：** 写操作仍无条件信任（在 `confirm_high_risk` 下）；`run_script` 是否跳过确认取决于 **开关 + 脚本来源判定**，而非一律拦截。

### 6.4 范围约束（P1，可选增强）

**P0** 可不做路径级校验（仅靠计划审批信任）。  
**P1** 可选：解析计划 `## 4. 执行步骤` / `## 5. 关键要素` 中的路径列表，若工具写入路径**明显超出**计划声明范围，仍弹确认并标记 `out_of_plan_scope`。

### 6.5 审计

自动批准的工具调用须写入 Agent 日志（已有 `tool.confirm` 事件可扩展）：

```json
{ "event": "tool.confirm", "outcome": "auto_approved", "reason": "plan_execution_trust" }
{ "event": "tool.confirm", "outcome": "auto_approved", "reason": "plan_agent_generated_script" }
```

### 6.6 Plan 执行期：`run_script` 来源判定与自动批准

#### 6.6.1 背景与动机

日志 `Agent-20260526.log` 中，Plan 已批准后 Worker 为创建目录调用 `run_script`（内联 Python：`os.makedirs(...)`），仍进入 5 分钟确认超时——这类 **Agent 当场编写、一次性、为完成当前计划步骤** 的脚本，与「运行仓库里已有脚本」风险画像不同。用户已批准计划，再要求逐步确认 inline 脚本，体验与 §6.1 原则冲突。

本需求在 **不放开 arbitrary 脚本** 的前提下，对 **Agent 自生成脚本** 单独自动批准；并通过 **设置开关** 允许用户关闭（默认 **开启**）。

#### 6.6.2 设置项

```typescript
interface PlanConfig {
  // ... §9.1 其他字段
  /**
   * Plan 执行期：对「Agent 自生成」的 run_script 自动批准，不弹 WriteConfirmCard / 不进 pendingConfirmStore。
   * 默认 true。仅 Plan implementation 阶段生效；普通模式不受影响。
   * toolConfirmPolicy === 'always_confirm' 时本开关无效（一律确认）。
   */
  autoApproveAgentGeneratedScripts: boolean
}

const DEFAULT_PLAN_CONFIG: PlanConfig = {
  // ...
  autoApproveAgentGeneratedScripts: true,
}
```

**设置 UI（设置 → Plan 模式）：**

| 控件 | 文案 | 默认 |
|------|------|------|
| Switch | **自动批准 Agent 生成的脚本** | 开 |
| 说明 | Plan 执行中，若 `run_script` 的代码由 Agent 在本步骤内编写（非直接运行仓库已有脚本），则不再单独确认。关闭后，所有 `run_script` 仍需确认。 | — |

**优先级（冲突时）：**

```text
always_confirm          → 全部 run_script 确认（忽略本开关）
trust_plan_all          → 全部 run_script 自动批准（含既有脚本，比本开关更激进）
autoApproveAgentGeneratedScripts === true  → 仅自生成脚本自动批准（默认）
autoApproveAgentGeneratedScripts === false → 全部 run_script 确认
```

#### 6.6.3 「Agent 自生成脚本」定义

**Agent 自生成脚本**：满足以下 **全部** 条件的 `run_script.code`：

| # | 条件 |
|---|------|
| C1 | 处于 Plan Worker 执行期（`planToolPhase === 'implementation'` 且计划 `approved` / `executing`） |
| C2 | `code` 归一化后 **不属于**「外部既有脚本」集合（见 §6.6.4） |
| C3 | `code` 属于以下 **任一** 来源： |
| C3a | **内联生成**：当前 `run_script` 由 Assistant 在本轮工具循环（同一 `requestId`）的 `tool_use` 直接提交（典型：`os.makedirs` 一次性脚本） |
| C3b | **先写后跑**：`code` 与本轮运行中 Agent 经 `write_file` / `edit_file` **新写入或修改** 的脚本文件内容一致（路径通常为 `*.py` 或计划步骤中声明的脚本路径） |

**不属于 Agent 自生成（仍需确认，即使开关开启）：**

| 场景 | 说明 |
|------|------|
| **既有脚本原样执行** | 本轮 `read_file` 读取工作区内 **执行前已存在** 的脚本文件，Agent 未改写即 `run_script` 同内容 |
| **用户提供的脚本** | `code` 与用户在本会话 Composer 中发送的 fenced code block **完全一致**（P1 实现；P0 可仅用 read_file 判定） |
| **跨步复用** | `code` 仅来自 **上一 Plan 步骤** 的 read，且本轮未 write（P1：Worker 每步新 `requestId`，默认不跨步继承 provenance） |
| **`run_lark_cli`** | 非 `run_script`，**不适用** 本开关，始终按高风险确认 |

#### 6.6.4 来源追踪（`RunScriptProvenanceContext`）

主进程在 **单次 Worker 运行**（一个 `requestId`）内维护 provenance，步进或 `finishSessionRun` 后销毁：

```typescript
/** 单次 Worker run 内 run_script 来源上下文 */
interface RunScriptProvenanceContext {
  requestId: string
  /** read_file 读到的外部文件内容 hash（归一化后 SHA256 前缀）→ 路径 */
  externalScriptHashes: Map<string, string>
  /** 本轮 Agent write_file/edit_file 写入/修改的脚本内容 hash → 路径 */
  agentScriptHashes: Set<string>
}

/** 归一化：统一换行符为 \n，去掉首尾空白，可选去掉 shebang 行后比较 */
function normalizeScriptBody(code: string): string

function hashScript(code: string): string
```

**追踪规则（同一 `requestId` 内）：**

| 事件 | 更新 provenance |
|------|-----------------|
| `read_file` 且路径匹配 `*.py` 或 MIME/内容像脚本 | 若文件在执行前已存在（非本轮刚创建），将其内容 hash 记入 `externalScriptHashes` |
| `write_file` / `edit_file` 写入 `*.py` 或计划步骤声明的脚本路径 | 内容 hash 记入 `agentScriptHashes`；若路径曾被标为 external，**移除** external 条目（Agent 已改写） |
| `run_script` 待确认前 | 调用 `isAgentGeneratedRunScript(code, ctx)` |

```typescript
function isAgentGeneratedRunScript(
  code: unknown,
  ctx: RunScriptProvenanceContext
): boolean {
  if (typeof code !== 'string' || !code.trim()) return false
  const h = hashScript(normalizeScriptBody(code))
  if (ctx.externalScriptHashes.has(h)) return false
  if (ctx.agentScriptHashes.has(h)) return true
  // 内联生成：不在 external 集合即视为 Agent 当场编写（C3a）
  return true
}
```

**设计说明：**

- **默认宽松（C3a）**：Plan 步骤里常见的 `os.makedirs`、短数据处理脚本，只要 **不是** 从已有 `.py` 原样复制，即视为自生成并自动批准。
- **默认保守（external）**：Agent 读取 `tools/migrate.py` 原样执行 → 仍要确认，防止计划批准后静默跑仓库未知脚本。
- **先写后跑（C3b）**：Agent 新建 `scripts/setup.py` 再 `run_script` 同内容 → 自动批准（与 write 已授权一致）。

#### 6.6.5 安全边界（自动批准仍须满足）

自动批准 **不绕过** 现有工具安全层：

| 层 | 行为 |
|----|------|
| `assertSafeToolInput` | 仍校验 timeout 等 |
| `planModeAcl` | 探索期仍禁止 `run_script` |
| 工作目录 / 子进程隔离 | 不变 |
| 输出限制、超时 kill | 不变 |
| 计划步骤验证（若已实施 command 验证） | 不变 |

**不在本需求范围：** 对 auto-approved 脚本做额外 AST 危险调用扫描（P2 可选）。

#### 6.6.6 与 Banner / UI 的关系

- 自生成脚本自动批准 → **不** 发送 `tool:confirm-request` → §8 无「待确认」误报。
- 既有脚本需确认 → 仍走 `WriteConfirmCard`，Banner 文案：`待确认 · 运行已有脚本`（与 §8.6 区分）。
- 聊天区 `ToolCallCard`：auto-approved 的 `run_script` 状态直接为 `completed`，可选展示「已按计划自动批准」标签（P2）。

#### 6.6.7 实现范围

| 优先级 | 任务 | 文件 |
|--------|------|------|
| P0 | `RunScriptProvenanceContext` + 追踪 read/write | `electron/toolChatLoop.ts` 或 `electron/plan/runScriptProvenance.ts` |
| P0 | `isAgentGeneratedRunScript` + 接入 `shouldSkipToolConfirm` | `electron/toolChatLoop.ts` |
| P0 | `PlanConfig.autoApproveAgentGeneratedScripts` 默认值 + 读取 | `src/shared/domainTypes.ts`、`electron/config` |
| P0 | 设置 Switch | `ConfigModal.tsx` |
| P0 | 单元测试：external / inline / write-then-run 三类 | `runScriptProvenance.test.ts` |
| P1 | 用户 fenced code block 匹配 | `toolChatLoop.ts` |
| P2 | ToolCallCard「自动批准」标签 | `ToolCallCard.tsx` |

#### 6.6.8 验收标准（`run_script` 专项）

1. **R1**：开关 **开** + Plan executing，Worker 内联 `os.makedirs(...)` → **不** 弹确认，日志 `reason: plan_agent_generated_script`。
2. **R2**：开关 **开**，Agent `read_file` 既有 `legacy.py` 后原样 `run_script` → **仍** 弹确认。
3. **R3**：开关 **开**，Agent `write_file` 新建 `setup.py` 后 `run_script` 同内容 → **不** 弹确认。
4. **R4**：开关 **关**，任意 `run_script` → **仍** 弹确认（回归现网）。
5. **R5**：`toolConfirmPolicy=always_confirm` → 开关开亦 **仍** 弹确认。
6. **R6**：普通（非 Plan）模式 `run_script` → **始终** 弹确认（开关不生效）。
7. **R7**：`run_lark_cli` → 不受开关影响，仍确认。

---

## 7. UI / 交互变更

### 7.1 审批区（状态 C）

| 控件 | 现文案 / 行为 | 新行为 |
|------|---------------|--------|
| 主按钮 | 「批准并执行」 | 保持；触发 `plan:approve` + `plan:run`（auto 模式） |
| 次按钮 | — | 可选「仅批准，稍后执行」→ 只 `plan:approve`，不 `plan:run` |

审批区底部提示文案修订：

- 现：`批准后：将新增 1 个计划并等待您确认执行。`
- 新（auto 默认）：`批准后：将按步骤列表自动执行；您可随时在 Plan 面板暂停或取消。`

### 7.2 计划卡片（状态 B · executing）

| 控件 | auto 模式 | step_manual 模式 |
|------|-----------|------------------|
| 主按钮 | **暂停执行**（running 时）/ **继续执行**（paused 时） | 保持「继续执行」 |
| 进度 | 「自动执行中 · 第 N/M 步」+ 步骤标题 | 「第 N/M 步 · 等待继续」 |
| 取消 | 保持 | 保持 |

running 时主按钮文案 **不再是**「继续执行」，避免与自动循环语义冲突（见 [plan-resume-button-state-requirement.md](./plan-resume-button-state-requirement.md) §4 需同步修订）。

### 7.3 聊天区

- 自动执行期间：每步完成插入 **简短进度消息**（可折叠），例如：`✓ 步骤 2/7 完成：已写入 SKILL.md frontmatter`。
- 阻塞/暂停：插入 `PlanBlockedBanner`（或复用 Alert），含「重试本步」「修订计划」「取消计划」。
- **不再** 在步间要求用户发送「继续」类消息。

### 7.4 全局提示（执行进度，非待办）

执行中离开会话时，会话列表 **信息性 badge**（非告警色）：`Plan 执行中 3/7`。  
详细规则见 **§8 全局待办提示**——执行进度与「待确认 / 待审批」必须分开展示，不得复用 `pending-confirm-banner` 的告警语义。

---

## 8. 全局待办提示（Session Attention Banner）优化

### 8.1 设计原则

> **Banner 只服务「可行动待办（Actionable Attention）」**——用户现在不做就会阻塞进度的事项。  
> **不是**运行状态指示器；Plan 自动执行中的进度用 badge / PlanPanel 表达，不用「待确认」恐吓用户。

三类信号分离：

| 信号类型 | 含义 | 展示载体 | 是否阻塞 |
|----------|------|----------|----------|
| **待审批** | 有计划等用户批准 | `PendingPlanBanner` | 是（探索期结束） |
| **待确认** | 有工具调用等用户逐条授权 | `PendingConfirmBanner` | 是（普通模式 / 高风险 / always_confirm） |
| **执行中** | 已批计划正在跑 | 会话 badge + PlanPanel | 否（除非 paused_blocked） |

### 8.2 问题场景 × 根因 × 策略

| 场景 ID | 现象 | 根因 | 优化策略 |
|---------|------|------|----------|
| A1 | Plan `executing`，仍显示「N 项待确认」（write/edit） | 计划级审批未传递到工具层；Store 仍收录 | §6 `trust_plan`：**不发送** `tool:confirm-request`（首选），Store 无条目 → Banner 不显示 |
| A2 | 步间暂停 / 单步结束，Banner 仍显示上一轮的待确认 | `finishSessionRun` 未按 `requestId` 清理 Store | §8.4 生命周期：`removeAllForRequest(requestId)` |
| A3 | 双击继续产生多个 `requestId`，Banner 累积 orphan | 执行无单飞锁 | §5.2 单飞 + §8.4 清理非 activeRun 的条目 |
| A4 | Plan `executing`，仍显示「计划待审批」 | `pendingPlanStore` 与 metadata 不同步 | §8.5 准入条件 + 批准/执行时强制 `removeSession` |
| A5 | 工具已 timeout，Banner 仍显示直至 5min | 正常；但 step 已结束应提前清除 | step 结束 / pause 时 reconcile（§8.4） |
| A6 | 执行中需确认 `run_script`（既有脚本） | 真实待办 | **保留** Banner，文案：`待确认 · 运行已有脚本`（§8.6） |
| A7 | Agent 内联 `run_script`（如 mkdir） | 误报待确认 | §6.6 自动批准 + 开关默认开 |

### 8.3 准入条件（展示前必须满足）

#### 8.3.1 `PendingPlanBanner`

```typescript
function shouldShowPendingPlan(sessionId: string, planState: PlanReadResult): boolean {
  return planState.pendingPlan?.status === 'awaiting_approval'
  // 注意：plan.status === 'executing' 且 pendingPlan === null → false
  // 注意：display_plans 有 executing 条目 ≠ 待审批
}
```

**禁止展示的情况：**

- 仅 `plan.status === 'executing' | 'completed' | 'cancelled'` 且无 `pending_plan`
- `plan_drafting === true`（探索中，审批区尚未就绪——由 PlanPanel 表达，非全局条）
- 同一 session 的 `pending_plan.planId` 已出现在 `display_plans` 且状态非 `awaiting_approval`（数据不一致 → 以 `planRead` 为准并修正 Store）

**多计划并存：** 旧计划 `executing` + 新 `pending_plan` **同时存在**时，Banner **只**展示新计划待审批（正确行为，保留）。

#### 8.3.2 `PendingConfirmBanner`

```typescript
function shouldShowToolConfirm(item: PendingConfirmItem, ctx: AttentionContext): boolean {
  // 1. 必须仍属活跃 request（正在运行的 Worker / 工具循环未结束）
  if (!ctx.activeRequestIds.has(item.requestId)) return false

  // 2. Plan 执行期 + 信任策略 + 非高风险 → 不应在 Store 中（防御性过滤）
  if (ctx.planRunState === 'running' && ctx.toolConfirmPolicy !== 'always_confirm') {
    if (item.toolName === 'run_lark_cli') return false // 仍可能需确认，见 activeRequest
    if (item.toolName === 'run_script') {
      // 已在主进程 auto-approve 的不会进 Store；此处过滤 orphan
      return false
    }
    if (item.toolName !== 'run_script' && item.toolName !== 'run_lark_cli') return false
  }

  // 3. Plan 步间暂停且 session 无活跃 run → 上一 run 的 confirm 一律无效
  if (ctx.planStatus === 'executing' && ctx.planRunState !== 'running') {
    return false // 步间不应遗留工具待确认；若需确认应在下一步 run 内重新发起
  }

  return true
}
```

**普通聊天模式**（非 Plan 执行期）：维持现有逻辑，不受影响。

### 8.4 Store 生命周期与同步

#### 8.4.1 `pendingConfirmStore` 扩展

```typescript
// 新增 API
removeAllForRequest(requestId: string): void
reconcileForSession(sessionId: string, activeRequestIds: Set<string>): void
```

**调用时机：**

| 事件 | 动作 |
|------|------|
| `finishSessionRun(sessionId, requestId)` | `removeAllForRequest(requestId)` |
| `abortSessionRun` | 保持现有 `rejectAllForSession` |
| `plan:state-changed` → `executing` 步进 | `reconcileForSession`：移除非 `activeRunRequestId` 的条目 |
| `plan:pause` / `paused_blocked` | `removeAllForRequest(activeRunRequestId)`；必要时 `reject` 仍在等待的主进程 confirm |
| 主进程 `shouldSkipToolConfirm === true` | **不**发送 `tool:confirm-request`（源头避免） |

#### 8.4.2 `pendingPlanStore` 扩展

| 事件 | 动作 |
|------|------|
| `plan:approve` 成功 | 立即 `removeSession(sessionId)`（不等待异步 `planRead`） |
| `plan:state-changed` | 保持 `refresh`；若 `planRead` 返回无 `awaiting_approval`，`removeSession` |
| Redux `session.list` 更新 metadata | `refreshFromSessions` 前优先用 `planRead` 校正 executing 会话 |

**渲染进程：** `ChatView.handlePlanApprove` 在 `planApprove` 成功后同步调用 `pendingPlanStore.removeSession(sessionId)`（需导出 package 级 API）。

#### 8.4.3 主进程配合

Worker / 工具循环结束或 `plan:run` 步间边界时：

```typescript
sender.send('tool:confirm-reconcile', { sessionId, activeRequestId })
// 或复用 plan:state-changed 携带 { clearStaleToolConfirms: true }
```

渲染进程收到后执行 `reconcileForSession`。

### 8.5 UI 规格修订

#### 8.5.1 文案与 aria 分离

| 组件 | 现 aria / 标题 | 修订 |
|------|----------------|------|
| `PendingConfirmBanner` | `待确认工具` / `N 项待确认` | 保持；**仅**在 §8.3.2 通过后展示 |
| `PendingPlanBanner` | `计划待审批` | 保持；**仅**在 §8.3.1 通过后展示 |
| （新增，P1）`PlanExecutingHint` | — | 可选窄条：`Plan 执行中 · 第 N/M 步`，**非** banner 告警样式，点击跳转 PlanPanel |

**禁止：** Plan `executing` 且无 `awaiting_approval`、且无 actionable tool confirm 时，左侧不出现任何 `.pending-confirm-banner` 条目。

#### 8.5.2 点击行为（不变）

- 工具待确认 → `setSession` + `setConfirmFocusToolUseId`
- 计划待审批 → `setSession` + `closeFile` + `plan-focus`

#### 8.5.3 与 §6 工具信任的关系

| `toolConfirmPolicy` | Plan 执行期 Banner 预期 |
|---------------------|-------------------------|
| `confirm_high_risk`（默认） | 大多数步骤 **零**「待确认」；仅 **既有脚本** `run_script` / `run_lark_cli` 出现 |
| `autoApproveAgentGeneratedScripts` 关 | 所有 `run_script` 均可能出现「待确认」 |
| `always_confirm` | 每写入仍显示（用户显式选择，保留） |
| `trust_plan_all` | 全程零「待确认」（激进） |

### 8.6 高风险 / 既有脚本待办（保留 Banner 时的体验）

当 Plan 执行中 **仍需确认** 的工具调用：

| 工具 | 场景 | Banner / 卡片 |
|------|------|---------------|
| `run_script` | **既有脚本**（§6.6.3 非自生成） | `待确认 · 运行已有脚本` |
| `run_lark_cli` | 任意 | `待确认 · 飞书 CLI` |
| 任意 | `always_confirm` 或开关关闭 | 现有文案 |

- 确认后若 `plan:run` 仍在进行，不额外要求步间「继续执行」
- 拒绝 / timeout → 触发 §10.1 `paused_blocked`，Banner 转为 PlanPanel 阻塞提示，**不**保留 orphan 工具条

### 8.7 实现范围

| 优先级 | 任务 | 文件 |
|--------|------|------|
| P0 | 工具 trust 时不发 `tool:confirm-request` | `electron/toolChatLoop.ts` |
| P0 | `finishSessionRun` → `removeAllForRequest` | `chatRunnerService.ts`、`pendingConfirmStore.ts` |
| P0 | `PendingConfirmBanner` 展示前 `shouldShowToolConfirm` 过滤 | `PendingConfirmBanner.tsx` + 小 hook |
| P0 | 批准后立刻 `pendingPlanStore.removeSession` | `ChatView.tsx`、`pendingPlanStore.ts` |
| P1 | `reconcileForSession` + `plan:state-changed` 联动 | 主进程 + `pendingConfirmStore.ts` |
| P1 | `PendingPlanBanner` 展示前二次校验 `planRead` | `pendingPlanStore.ts` |
| P2 | 可选 `PlanExecutingHint` 信息条 | `App.tsx`、样式 |

### 8.8 验收标准（Banner 专项）

1. **B1**：Plan `executing` + 默认 `confirm_high_risk`，无 `pending_plan` 时，**不显示** `PendingPlanBanner`。
2. **B2**：同上条件，Worker 写入文件时 **不显示** `PendingConfirmBanner`。
3. **B3**：Plan 执行中 **既有脚本** `run_script` 需确认时，**仅 1 条** actionable 工具待确认；Agent 内联自生成脚本 **不出现** Banner。
4. **B4**：Worker 单步结束 / 步间暂停后，**无 orphan** 工具待确认条目（Store 为空或仅含 active run）。
5. **B5**：批准计划瞬间，`PendingPlanBanner` **立即**消失（不依赖异步 `planRead` 回调）。
6. **B6**：普通（非 Plan）聊天写入待确认行为 **回归不变**。

---

## 9. 配置项

### 9.1 AppConfig 扩展（建议）

```typescript
interface PlanConfig {
  /** 默认 auto */
  executionMode: PlanExecutionMode
  /** 默认 confirm_high_risk */
  toolConfirmPolicy: PlanToolConfirmPolicy
  /**
   * Plan 执行期：Agent 自生成 run_script 自动批准。默认 true。见 §6.6。
   */
  autoApproveAgentGeneratedScripts: boolean
  /** 单步 Worker 最大 LLM 轮次，默认沿用现网 */
  maxWorkerRoundsPerStep?: number
  /** 自动执行时单步完成后是否插入聊天进度消息，默认 true */
  emitStepProgressMessages: boolean
}
```

设置 UI 位置：**设置 → Plan 模式** 分组（可与默认聊天模式并列）。`autoApproveAgentGeneratedScripts` 控件规格见 §6.6.2。

### 9.2 会话级覆盖（P2）

发送 Plan 消息前，模式选择器旁增加「执行方式」折叠项，单次覆盖全局 `executionMode`（默认继承全局）。

---

## 10. 异常、暂停与恢复

### 10.1 触发 paused_blocked 的条件

| 条件 | 行为 |
|------|------|
| Worker 返回 `ok: false` | 暂停，展示错误摘要 |
| 步骤标记 `failed` / `blocked` | 暂停（与 [plan_mode_optimization_design.md](../develop/plan_mode_optimization_design.md) 验证逻辑对齐） |
| 用户拒绝工具确认（既有脚本 run_script / run_lark_cli / always_confirm） | 暂停，提示「本步脚本/命令未批准」 |
| 工具确认 timeout | 暂停，提示「确认超时，已暂停；请返回后重试本步」 |
| `git HEAD` 相对 `envSnapshot` 变更 | 暂停，提示「环境已变更，建议重新规划或确认继续」 |
| 用户 abort / 点暂停 | `paused_user` |

### 10.2 恢复选项

暂停态 PlanPanel 提供：

1. **从当前步重试** — 不增加 `currentStepIndex`，再次 `runWorkerExecution`
2. **跳过本步**（P2，需显式确认）— 标记 `warning` 并 index+1
3. **修订计划** — 聚焦 Composer，走 Coordinator 修订
4. **取消计划** — 现有 `plan:cancel`

### 10.3 应用重启

`executing` + `plan_execution.runState === running` 的会话，启动后视为 `paused_blocked`，提示「执行已中断，是否继续？」——**不**在后台 silently 续跑（避免无人值守写入）。

---

## 11. 数据模型变更

### 11.1 Session.metadata 扩展

```typescript
interface PlanExecutionMeta {
  runState: PlanExecutionRunState
  executionMode: PlanExecutionMode      // 本计划生效的模式（批准时快照）
  toolConfirmPolicy: PlanToolConfirmPolicy
  startedAt: number | null
  pausedAt: number | null
  pauseReason?: string
  lastStepCompletedAt?: number
  /** 主进程 execution lock 持有者 requestId，防并发 */
  activeRunRequestId?: string | null
}
```

批准时写入 `executionMode` / `toolConfirmPolicy` 快照，避免执行中途改设置导致行为漂移。

### 11.2 与 display_plans 同步

自动执行步进时，继续要求 `display_plans[].currentStepIndex` 与 `plan` 同步（[plan-resume-button-state-requirement.md §7.4](./plan-resume-button-state-requirement.md)）。

---

## 12. 与现有文档的关系

| 文档 | 变更 |
|------|------|
| [通用Agent-Plan模式MVP产品需求文档.md §2.3](./通用Agent-Plan模式MVP产品需求文档.md) | 修订「获批后仍保留逐次确认」为「默认计划级信任 + 高风险例外，可配置 always_confirm」 |
| [plan-detail-panel-requirement.md §5.2.3 / §9](./plan-detail-panel-requirement.md) | 「继续执行」改为条件显示；§9 全局条增加 Plan 执行期准入条件与误报修复 |
| [plan-resume-button-state-requirement.md](./plan-resume-button-state-requirement.md) | 状态矩阵增加 auto / paused；S2「步间暂停可继续」在 auto 默认下 **不应** 出现 |
| [tools-requirement.md §6.2](./tools-requirement.md) | Plan 执行期 Agent 自生成 `run_script` 可跳过确认（§6.6）；普通模式仍「执行前须确认」 |
| 飞书集成 | 复用 `plan:run` 循环；provenance 逻辑与桌面端共用 |

---

## 13. 验收标准

### 13.1 功能

1. **F1**：`executionMode=auto` 时，用户仅在「批准并执行」点击一次，7 步计划可连续跑完（日志同类场景无需 6 次「继续执行」）。
2. **F2**：`toolConfirmPolicy=confirm_high_risk` 时，Plan Worker 内 `write_file`/`edit_file` 不再弹出 `WriteConfirmCard`；Agent **自生成** `run_script`（§6.6）默认不弹；**既有脚本** `run_script` 仍弹。
3. **F3**：自动执行中 PlanPanel 显示「自动执行中 · 第 N/M 步」，且 N 逐步递增。
4. **F4**：用户点「暂停」后，当前步结束后不再进入下一步，`runState=paused_user`。
5. **F5**：工具确认 timeout 后进入 `paused_blocked`，**不** silently 进入下一步。
6. **F6**：同一 session 快速双击「批准并执行」仅产生 **一个** 执行循环（无三 requestId 并发）。
7. **F7**：`executionMode=step_manual` 时行为与现网一致（回归）。
8. **F8**：**R1–R7**（§6.6.8）全部满足，含 `autoApproveAgentGeneratedScripts` 开关默认开/关与 `always_confirm`  override。

### 13.2 体验

9. **E1**：批准后 7 步计划的总人工点击次数 ≤ **1（批准）+ K（K = 需确认的既有脚本 / run_lark_cli 次数）**，而非 7 + 写入次数 + 每步 inline 脚本。
10. **E2**：执行完成或暂停时，会话列表 badge 正确更新/清除。

### 13.3 全局待办提示

11. **B1–B6**：满足 §8.8 全部 Banner 专项验收。

### 13.4 测试

12. **T1**：`planOrchestrator` 集成测试：`runPlanUntilDone` 三步计划 auto 模式一次跑完。
13. **T2**：`toolChatLoop` 测试：implementation + executing 时 write 自动批准 + 自生成 run_script 自动批准。
14. **T3**：`PlanPlanCard` 测试：auto + running 显示「暂停」而非「继续执行」。
15. **T4**：`pendingConfirmStore.test.ts`：`finishSessionRun` 后 `removeAllForRequest` 无 orphan。
16. **T5**：`PendingConfirmBanner` / `pendingPlanStore`：Plan executing 时过滤展示（组件或 hook 测试）。
17. **T6**：`runScriptProvenance.test.ts`：external / inline / write-then-run 三类（§6.6.8 R1–R3）。

---

## 14. 实施分期建议

| 阶段 | 范围 | 优先级 |
|------|------|--------|
| **Phase 1** | `plan:run` 自动步间循环 + 执行锁 + UI 暂停/进度 | **P0** |
| **Phase 2** | `PlanToolConfirmPolicy` + 写操作自动批准 + §6.6 脚本 provenance + 设置开关 + timeout→paused | **P0** |
| **Phase 2b** | Banner 准入过滤 + Store 生命周期（§8.4–8.5）+ 批准后立刻清 Plan 条 | **P0** |
| **Phase 3** | 设置页、`step_manual` 回归、飞书统一编排 | **P1** |
| **Phase 4** | 环境变更暂停、out_of_plan_scope 校验、步间 step_confirm、`PlanExecutingHint` | **P2** |

**预估：** Phase 1–2 + 2b 主进程 ~220–320 行，渲染进程 ~140–200 行（含设置项，不含测试）。

---

## 15. 附录：理想时序（auto + confirm_high_risk + 自生成脚本）

```text
用户: [Plan 模式] 请创建 xxx Skill
  → Coordinator 探索 + 生成 plan-doc
  → PlanPanel 状态 C：用户阅读步骤列表
用户: 点击「批准并执行」
  → plan:approve + plan:run
  → Step 1..7 自动循环
      write/edit 自动批准
      run_script（Agent 内联 os.makedirs 等）自动批准（§6.6，开关默认开）
      run_script（read 既有 legacy.py 原样执行）→ 弹一次确认
  → plan.status = completed
  → PlanPanel 折叠完成态 + 聊天区摘要
  → 左侧无 pending-confirm-banner（无待办）
```

---

*文档结束*
