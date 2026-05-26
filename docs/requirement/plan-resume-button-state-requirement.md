# Plan 模式「继续执行」按钮状态 — 需求规格

**版本：** 1.0  
**日期：** 2026-05-26  
**状态：** 待评审  
**关联文档：** [plan-detail-panel-requirement.md](./plan-detail-panel-requirement.md)、[通用Agent-Plan模式MVP产品需求文档.md](./通用Agent-Plan模式MVP产品需求文档.md)

---

## 1. 概述

### 1.1 背景

Plan 模式执行期采用 **「单步执行 + 步间手动继续」** 模型：用户每点击一次「开始执行 / 继续执行」，Worker 仅推进 **一个** 计划步骤；步骤完成后会话任务结束，计划 metadata 保持 `executing`，等待用户再次点击以执行下一步。

该按钮位于右侧 **PlanPanel → 计划列表（状态 B）** 的计划卡片上（`PlanPlanCard`）。审批态（状态 C）使用独立的「批准」按钮，不在本文「继续执行」范围内，但与其共享部分 busy 信号。

### 1.2 问题陈述

当前「继续执行 / 开始执行」按钮在 Plan **正在执行某一步** 时仍可点击，缺少 loading / disabled 反馈；批准后的自动首步执行、步间进度展示等场景也存在状态不同步。用户容易重复触发执行，且无法从按钮上区分「正在跑步骤」与「步间暂停可继续」。

### 1.3 目标

| # | 目标 |
|---|------|
| G1 | 明确各业务场景下按钮的 **可见性、文案、可点击性、loading** 四类状态 |
| G2 | 梳理当前实现与期望的差距，形成可落地的改进方案 |
| G3 | 与 `runningSessions`、`planActionLoading`、Plan metadata 状态机对齐，避免重复触发 |

---

## 2. 业务模型（前提）

### 2.1 相关 Plan 状态

| `PlanMeta.status` / `PlanDisplayEntry.status` | 含义 |
|-----------------------------------------------|------|
| `awaiting_approval` | 待审批（出现在 `pending_plan`，非 display 列表主操作） |
| `approved` | 已批准，尚未开始 Worker |
| `executing` | 执行中（含 **步间暂停**：上一步已完成，等待用户点继续） |
| `completed` | 全部步骤完成 |
| `cancelled` | 用户取消 |

### 2.2 执行指针

- `Session.metadata.plan` 指向 **当前应执行** 的计划（`planId`）。
- `display_plans` 为面板展示列表；卡片操作应仅作用于 **与 `plan.planId` 匹配的活跃计划**，非活跃条目不应出现执行类按钮。

### 2.3 会话运行态

- 渲染进程通过 Redux `chat.runningSessions[sessionId]` 表示该会话是否有一次 **进行中的 LLM/工具任务**（含 Plan Worker 单步执行、Coordinator 探索、普通聊天等）。
- `isSessionRunning(sessionId)` 为上述状态的封装。

### 2.4 步进与 UI 刷新

- Worker 完成一步后，主进程更新 `plan.currentStepIndex` 并 `emit plan:state-changed`。
- 面板通过 `usePlanPanelState` 订阅 `plan:state-changed` / `plan:approval-ready` 后 `planRead` 刷新。
- **已知数据问题：** 步进完成后 `display_plans[].currentStepIndex` 未与 `plan` 同步，导致卡片「第 N/M 步」可能滞后（见 §5.3）。

---

## 3. 按钮所在位置

| 位置 | 组件 | 当前状态 |
|------|------|----------|
| PlanPanel 计划卡片 | `PlanPlanCard` | **主入口**；文案为「开始执行」或「继续执行」 |
| PlanPanel 审批区 | `PlanPanelApproval` | 「批准」按钮（非本文主体；共享 `planActionLoading`） |
| 聊天区顶部 | `PlanResumeBanner` | 组件仍存在，但按 [plan-detail-panel-requirement.md §10.1](./plan-detail-panel-requirement.md) 应已迁移至 PlanPanel；**不应再作为第二入口** |

本文仅规范 **PlanPlanCard** 上的「开始执行 / 继续执行」及同卡「取消」按钮。

---

## 4. 场景 × 期望状态（状态矩阵）

以下「会话运行中」指 `isSessionRunning(currentSessionId) === true`。

「Plan 执行 busy」指：当前会话正在跑 **Plan Worker 单步**（即用户点击继续/开始之后到该步结束）。实现上与会话运行态高度重合，但批准/取消 IPC 进行中也应视为 busy（见 §6）。

### 4.1 可见性与文案

| 场景 ID | 条件 | 是否显示按钮 | 按钮文案 | 同卡「取消」 |
|---------|------|-------------|----------|-------------|
| S1 | 卡片 `status === 'approved'` 且为活跃指针 | 显示 | **开始执行** | 不显示 |
| S2 | 卡片 `status === 'executing'` 且为活跃指针，步间暂停（会话未运行） | 显示 | **继续执行** | 显示 |
| S3 | 卡片 `status === 'executing'` 且为活跃指针，当前步 Worker 运行中 | 显示 | **继续执行**（或 **执行中…**，见 §6.2） | 显示（允许中止） |
| S4 | 卡片 `status === 'completed'` | 不显示 | — | 不显示 |
| S5 | 卡片 `status === 'cancelled'` | 不显示 | — | 不显示 |
| S6 | 卡片 `status === 'approved'` 但 **非** 活跃指针 | 不显示 | — | 不显示 |
| S7 | 卡片 `status === 'executing'` 但 **非** 活跃指针（异常/历史数据） | 不显示 | — | 不显示 |
| S8 | 主面板状态 C（`pending_approval`） | 列表不渲染可操作卡片；只读折叠区 `readonly` | — | — |
| S9 | 主面板 A/B + 叠加 `plan_drafting` | 若仍有旧计划卡片，按 S1–S7；**建议** 探索中禁用执行类按钮（见 §6.3） | — | — |

### 4.2 可点击性与 loading

| 场景 ID | 期望 `disabled` | 期望 `loading` | 说明 |
|---------|----------------|----------------|------|
| S1 | 否 | 点击后至 Worker 结束前应 loading | 首次启动执行 |
| S2 | 否 | 否 | 步间暂停，等待用户继续 |
| S3 | **是** | **是** | **核心修复点**：Worker 运行中禁止重复点击 |
| S4–S8 | — | — | 按钮不显示 |
| S9 | **是**（推荐） | 否 | 避免探索与执行并发 |

### 4.3 与会话其他任务的互斥

| 场景 | 期望行为 |
|------|----------|
| 会话运行中且 **非** Plan Worker（如用户发了普通聊天、Coordinator 探索） | 继续/开始：**disabled**；点击时若仍触发 handler，应提示「当前会话已有任务在执行」（现有 `runPlanWorkerWithoutNewUser` 已有 toast，但按钮应前置 disabled） |
| 批准后立即 `autoExecute` 首步 | 从首步开始到 Worker 结束，按钮 **loading + disabled**（与 S3 一致） |
| 点击「取消」且 Worker 运行中 | 取消按钮可点；应先 `abortSessionRun` 再 `planCancel`（现有 `handlePlanCancel` 已做） |

### 4.4 状态流转（单计划）

```text
approved + 活跃指针
  --[开始执行，S1→S3]--> executing + 会话运行中
  --[单步完成，S3→S2]--> executing + 步间暂停
  --[继续执行，S2→S3]--> executing + 会话运行中
  ... 重复至最后一步 ...
  --[最后一步完成]--> completed（按钮隐藏，S4）

executing + 活跃指针
  --[取消]--> cancelled（S5）
```

---

## 5. 当前实现梳理

### 5.1 显示条件（`PlanPlanCard`）

```43:46:src/renderer/components/Plan/PlanPlanCard.tsx
  const showControls =
    !readonly &&
    (entry.status === 'executing' ||
      (entry.status === 'approved' && (!activePlanId || isActivePointer)))
```

**现状：**

- `executing` 时 **不校验** `activePlanId`，任意 executing 条目都会显示按钮（违背 S7）。
- `approved` 仅在无指针或匹配指针时显示（符合 S1/S6）。

### 5.2 按钮交互（无 busy 绑定）

```110:124:src/renderer/components/Plan/PlanPlanCard.tsx
      {showControls ? (
        <div className="plan-panel-plan-card__actions">
          <Button
            type="primary"
            size="small"
            onClick={() => void actions?.onPlanResume()}
          >
            {entry.status === 'approved' ? '开始执行' : '继续执行'}
          </Button>
          {entry.status === 'executing' ? (
            <Button size="small" danger onClick={() => void actions?.onPlanCancel()}>
              取消
            </Button>
          ) : null}
```

**现状：**

- 未使用 `actions.planActionLoading`。
- 未订阅 `runningSessions` / `isSessionRunning`。
- 无 `disabled` / `loading` 属性 → **S3 失败**（用户反馈的问题）。

### 5.3 动作实现（`ChatView`）

**继续 / 开始执行：**

```837:839:src/renderer/components/Chat/ChatView.tsx
  const handlePlanResume = useCallback(async () => {
    await runPlanWorkerWithoutNewUser()
  }, [runPlanWorkerWithoutNewUser])
```

- **不** 设置 `planActionLoading`（与 `handlePlanApprove` / `handlePlanCancel` 不一致）。
- 仅在入口处检查 `isSessionRunning` 并 `message.warning`，UI 无前置禁用。

**Worker 调用链：**

```721:727:src/renderer/components/Chat/ChatView.tsx
  const runPlanWorkerWithoutNewUser = useCallback(async () => {
    if (!sessionId || !cfg) return
    const runSessionId = sessionId
    if (isSessionRunning(runSessionId)) {
      message.warning('当前会话已有任务在执行')
      return
    }
```

- 注册 `runningSessions` 后同步 `invoke claudeChatCreateWithTools`；主进程 `runPlanModeChat` 在 `approved | executing` 时走 `runWorkerExecution`。
- 执行期间 `runningSessions[sessionId]` 为真，但 PlanPanel **未消费** 该信号。

**批准后自动执行：**

```782:803:src/renderer/components/Chat/ChatView.tsx
  const handlePlanApprove = useCallback(
    async (options?: { cancelExecuting?: boolean }) => {
      ...
      } finally {
        setPlanActionLoading(false)
      }
      if (autoExecute) {
        await runPlanWorkerWithoutNewUser()
      }
```

- `planActionLoading` 在 `autoExecute` **之前** 已置 false → 批准按钮与计划卡片在自动首步执行期间均无 loading（违背 §4.3）。

### 5.4 对比：审批按钮已正确使用 loading

```111:112:src/renderer/components/Plan/PlanPanelApproval.tsx
          <Button type="primary" size="small" loading={actions?.planActionLoading} onClick={handleApprove}>
            批准
```

`planActionLoading` 经 `planPanelActionsStore` 注入，但 **PlanPlanCard 未接入**。

### 5.5 步进进度展示不同步（关联问题）

`runWorkerExecution` 完成一步时只更新 `metadata.plan`，**未** 调用 `syncDisplayPlanStatus` 更新 `display_plans[].currentStepIndex`。卡片进度取自 `entry`（display 列表），因此步间刷新后面板「第 N/M 步」可能不变，直到计划完成/取消等少数 sync 时机。

---

## 6. 差距汇总

| # | 场景 | 期望 | 现状 | 严重度 |
|---|------|------|------|--------|
| D1 | S3 Worker 运行中 | disabled + loading | 可点击、无 loading | **P0** |
| D2 | 会话任意任务运行中 | disabled | 可点击，仅 toast | **P0** |
| D3 | 批准 autoExecute 首步 | 卡片 loading | loading 已结束 | **P1** |
| D4 | S7 非活跃 executing 卡片 | 隐藏按钮 | 仍显示 | **P1** |
| D5 | 步进后「第 N/M 步」 | 与 plan 同步 | display 条目可能滞后 | **P1** |
| D6 | S9 探索 drafting 叠加 | 建议禁用执行 | 仍可点 | **P2** |
| D7 | 取消按钮执行中 | 可点（中止） | 可点但未 disabled 自身 | 低（可接受） |

---

## 7. 改进方案

### 7.1 设计原则

1. **单一 busy 信号**：PlanPanel 只消费一个派生值，避免卡片内重复判断。
2. **先 UI 后 handler**：disabled/loading 与 handler 内 guard 双保险。
3. **活跃指针优先**：执行类按钮仅对 `entry.planId === planData.plan?.planId` 展示。
4. **最小侵入**：优先扩展 `planPanelActionsStore`，不新增全局 Redux slice。

### 7.2 新增派生状态 `planExecutionUiState`

在 `ChatView`（或独立 hook `usePlanExecutionUiState(sessionId)`）中计算，并通过 `planPanelActionsStore` 下发：

```typescript
type PlanExecutionUiState = {
  /** 会话级：LLM/工具任务进行中（含 Worker、探索、普通聊天） */
  sessionRunning: boolean
  /** Plan 专用：resume/cancel/approve 触发的 IPC 或 Worker 生命周期 */
  planActionLoading: boolean
  /** 合成：按钮应 busy */
  resumeButtonBusy: boolean
  /** 合成：按钮应 disabled（含 sessionRunning、drafting 等） */
  resumeButtonDisabled: boolean
  /** 活跃计划 id，供卡片比对 */
  activePlanId: string | null
  /** 是否 plan_drafting 叠加 */
  planDrafting: boolean
}

// 推荐派生规则
resumeButtonBusy =
  planActionLoading ||
  (sessionRunning && /* 可选：当前 plan 为 executing/approved */)

resumeButtonDisabled =
  resumeButtonBusy ||
  sessionRunning ||
  planDrafting
```

**`handlePlanResume` 调整：**

```typescript
const handlePlanResume = useCallback(async () => {
  if (!sessionId || isSessionRunning(sessionId)) return
  setPlanActionLoading(true)
  try {
    await runPlanWorkerWithoutNewUser()
  } finally {
    setPlanActionLoading(false)
  }
}, [...])
```

**`handlePlanApprove` 调整：**

- 将 `autoExecute` 的 `runPlanWorkerWithoutNewUser()` 移入 `try`，或在 autoExecute 完成前保持 `planActionLoading === true`。

### 7.3 `PlanPlanCard` 改造要点

```typescript
const isActivePointer = Boolean(activePlanId && entry.planId === activePlanId)
const showControls =
  !readonly &&
  isActivePointer &&
  (entry.status === 'executing' || entry.status === 'approved')

const busy = actions?.planExecutionUiState?.resumeButtonBusy
const disabled = actions?.planExecutionUiState?.resumeButtonDisabled

<Button
  type="primary"
  size="small"
  loading={busy}
  disabled={disabled}
  onClick={() => void actions?.onPlanResume()}
>
  {busy && entry.status === 'executing' ? '执行中…' : entry.status === 'approved' ? '开始执行' : '继续执行'}
</Button>
```

「取消」按钮：`loading={planActionLoading}`，`disabled={false}`（执行中仍可中止）。

### 7.4 主进程：`display_plans` 步进同步（D5）

在 `runWorkerExecution` 步进保存 metadata 时，同步 display 条目：

```typescript
displayPlans = syncDisplayPlanStatus(displayPlans, plan.planId, done ? 'completed' : 'executing', {
  currentStepIndex: nextIndex,
  stepsTotal
})
```

保证 `plan:state-changed` 后面板进度与 `plan` 指针一致。

### 7.5 可选增强（P2）

| 项 | 说明 |
|----|------|
| 探索期禁用 | `planDrafting && mainState !== 'pending_approval'` 时 `resumeButtonDisabled = true` |
| 重复点击防抖 | `onPlanResume` 内 300ms 锁（仅作兜底） |
| 删除 `PlanResumeBanner` | 若 ChatView 已无引用，移除 dead code，避免双入口回归 |
| 单元测试 | `PlanPlanCard.test.tsx`：覆盖 S1–S3、S6、S7 的 show/disabled/loading |

---

## 8. 验收标准

1. **S3**：Worker 执行当前步骤期间，活跃计划卡片上「继续执行」为 **loading + disabled**，不可重复触发。
2. **S2**：单步完成后、未点继续前，按钮 **可点、非 loading**，文案为「继续执行」。
3. **S1**：`approved` 活跃计划显示「开始执行」；点击后进入 S3，直至该步结束。
4. **S4/S5/S6/S7**：completed / cancelled / 非活跃卡片 **不显示** 执行按钮。
5. **会话互斥**：普通聊天或 Coordinator 探索运行中时，计划卡片执行按钮 **disabled**（不仅 toast）。
6. **autoExecute**：无 executing 冲突时批准后自动首步，卡片在首步完成前保持 **busy**。
7. **步进进度**：每步完成后 PlanPanel 卡片「第 N/M 步」**递增**（D5 修复后）。
8. **取消**：执行中点击「取消」可中止当前 Worker 并将计划标为 cancelled（保持现有行为）。

---

## 9. 实现范围建议

| 优先级 | 任务 | 文件 |
|--------|------|------|
| P0 | 派生 `planExecutionUiState` 并接入 store | `ChatView.tsx`、`PlanPanelActionsContext.tsx`、`planPanelActionsStore.ts` |
| P0 | `PlanPlanCard` loading/disabled + 活跃指针 showControls | `PlanPlanCard.tsx` |
| P0 | `handlePlanResume` / `handlePlanApprove` loading 生命周期 | `ChatView.tsx` |
| P1 | 步进 sync `display_plans` | `electron/plan/planOrchestrator.ts` 或 `planManager.ts` |
| P1 | 组件测试 | `PlanPlanCard.test.tsx`（新建） |
| P2 | drafting 禁用、移除 `PlanResumeBanner` | 按需 |

---

## 10. 附录：相关 IPC / 数据流

```text
用户点击「继续执行」
  → planPanelActionsStore.onPlanResume()
  → ChatView.runPlanWorkerWithoutNewUser()
  → registerSessionRun → runningSessions[sessionId] = true
  → ipc claudeChatCreateWithTools (chatMode: plan)
  → runPlanModeChat → runWorkerExecution (单步)
  → startPlanExecutionInSession (approved→executing，首步)
  → 步完成 → advancePlanStep → plan:state-changed
  → finishSessionRun → runningSessions 清除
  → reloadPlanState → PlanPanel 刷新
```

---

*文档结束*
