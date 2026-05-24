# Plan 详情面板 — 需求规格

**版本：** 1.1  
**日期：** 2026-05-20  
**状态：** 待评审（已吸收 [plan-detail-panel-requirement-review.md](../review/plan-detail-panel-requirement-review.md)）  
**关联文档：** [通用Agent-Plan模式MVP产品需求文档.md](./通用Agent-Plan模式MVP产品需求文档.md)、[referenced-files-requirement.md](./referenced-files-requirement.md)

---

## 目录

1. [概述](#1-概述)
2. [现状与问题](#2-现状与问题)
3. [面板位置与布局](#3-面板位置与布局)
4. [显示状态与优先级](#4-显示状态与优先级)
5. [各状态详细规格](#5-各状态详细规格)
6. [审批确认交互](#6-审批确认交互)
7. [多计划并存与替换规则](#7-多计划并存与替换规则)
8. [数据模型与状态机](#8-数据模型与状态机)
9. [全局待办提示（复用会话列表机制）](#9-全局待办提示复用会话列表机制)
10. [与聊天区的关系](#10-与聊天区的关系)
11. [非目标](#11-非目标)
12. [验收标准](#12-验收标准)
13. [附录](#13-附录)

---

## 1. 概述

### 1.1 功能定位

将 Plan 模式的**计划浏览**与**审批确认**从聊天消息列表顶部，迁移到右侧详情面板（`DetailPanel`）上半区的 **`detail-panel-placeholder`** 区域。

**重要澄清：** Plan 的持久化状态保存在 `Session.metadata` 与计划文件中；文件预览互斥仅影响**右侧 UI 可见性**，不会造成计划数据丢失。用户被文件预览「挡住」时，通过**左侧会话列表已有的全局提示机制**（见第 9 节）继续感知待审批项。

### 1.2 目标

| # | 目标 |
|---|------|
| G1 | 计划与审批固定在右侧栏，与聊天流解耦 |
| G2 | 在 PlanPanel 内完成看计划 → 批准/拒绝 → 跟踪步骤 |
| G3 | 支持多计划展示与明确的批准/拒绝合并规则 |
| G4 | 文件预览遮挡 PlanPanel 时，用户仍能通过**全局提示**发现并跳转审批 |
| G5 | **复用** `PendingConfirmBanner` / `pendingConfirmStore` 模式，避免另起一套通知体系 |

### 1.3 设计原则

- **审批优先**：`awaiting_approval` 时 PlanPanel 为状态 C；metadata 始终保留，不因 UI 切换而清空。
- **拒绝可回退**：`display_plans` 在审批期间冻结快照，拒绝后恢复。
- **批准有策略**：已完成计划折叠保留；未完成计划追加；执行中冲突须二次确认（见 7.3）。
- **交互闭环优先走聊天**：「修改计划」「拒绝反馈」默认聚焦聊天输入框（与工具确认「去会话处理」一致），降低手改 `.md` 风险。

---

## 2. 现状与问题

### 2.1 当前实现

| 项 | 现状 |
|----|------|
| 审批入口 | `ChatView` 顶部 `PlanApprovalCard` 等 |
| 右侧占位 | `detail-panel-placeholder`：「选择文件以预览内容」 |
| 全局提示 | 左侧 `PendingConfirmBanner` + `pendingConfirmStore`（工具写入待确认，跨会话） |
| 会话计划 | `Session.metadata.plan` 等 |

### 2.2 用户痛点

1. 聊天区顶部审批卡片易被新消息顶出视口。
2. 文件预览时若仅隐藏 PlanPanel，用户可能**忘记**还有待审批计划（v1.0 未覆盖）。
3. 占位区未承载计划信息，右侧栏利用率低。

---

## 3. 面板位置与布局

### 3.1 布局结构

```text
DetailPanel（selectedFile 为空时）
├── detail-panel-top → PlanPanel
├── ResizeHandle
└── detail-panel-bottom → ReferencedFilesPanel（不变）
```

> **关联文档修订：** [referenced-files-requirement.md](./referenced-files-requirement.md) 上半区由「仅占位符」改为「PlanPanel（无计划时为空态文案）」——见 [附录 B](#附录-b关联文档修订清单)。

### 3.2 与文件预览的互斥

| 条件 | 右侧栏 | Plan 数据 | 用户如何发现待审批 |
|------|--------|-----------|-------------------|
| `selectedFile` 为空 | 显示 PlanPanel | 不变 | PlanPanel 状态 C |
| `selectedFile` 非空 | 显示 FileOverlay，PlanPanel 不可见 | **不变** | **左侧全局提示**（第 9 节）+ 可选 FileToolbar 弱提示 |

关闭文件预览（`closeFile()`）后恢复 PlanPanel，状态与关闭前一致（从 `plan:read` / Redux 会话 metadata 恢复）。

### 3.3 区域高度（MVP）

| PlanPanel 主状态 | 建议默认 `referencedFilesHeight` | 说明 |
|------------------|----------------------------------|------|
| A 空态 | `0.75`（上 25% / 下 75%） | 空态仅占少量空间，引用文件区更大 |
| B 计划列表 | `0.5` | 与引用文件需求默认一致 |
| C 待审批 | `0.65`（上 65% / 下 35%） | 审批信息较多，上半区加大 |

用户仍可通过 `ResizeHandle` 手动调整；以上为**进入该状态时的一次性建议默认值**（非强制锁定）。

### 3.4 PlanPanel 首次展示

进入 `awaiting_approval` 且 PlanPanel 可见时：边框高亮动画 2～3 次（`plan-panel--highlight`），与全局提示并列，不替代全局提示。

---

## 4. 显示状态与优先级

### 4.1 主状态（互斥）

```text
pending_plan?.status === 'awaiting_approval'  →  C 待确认
else display_plans.length > 0               →  B 计划列表
else                                        →  A 空态
```

| 状态 | 代号 | 条件 |
|------|------|------|
| A | `empty` | 无 `pending_plan` 待审，且 `display_plans` 为空 |
| B | `plans` | 无待审，且 `display_plans.length > 0` |
| C | `pending_approval` | 存在 `pending_plan` 且 `status === 'awaiting_approval'` |

### 4.2 叠加态（Overlay，与主状态正交）

| 叠加态 | 条件 | 视觉 | 可与主状态组合 |
|--------|------|------|----------------|
| **探索中** | `plan_drafting === true` | 顶部细条 `Spin` +「正在探索并生成计划…」 | **仅 A、B**；**不与 C 叠加**（有 `awaiting_approval` 时以 C 为准，`plan_drafting` 应为 false） |
| **终止报告** | `plan_abort` 存在且未 dismiss | 见 5.4 | 覆盖在 A/B/C 内容区**顶部**（横幅），不替代主状态判定 |

**`plan_drafting` 与 `PlanMeta.status` 同步规则（主进程维护）：**

- 开始规划：`plan_drafting = true`；**不**写入含空 `planFilePath` 的 `plan`（避免 `normalizePlanMeta` 失败）。
- 进入 `awaiting_approval`：写入 `pending_plan`，`plan_drafting = false`。
- 规划失败/中止：清除 `plan_drafting`，写入 `plan_abort`。

### 4.3 特殊组合优先级

| 组合 | 判定 |
|------|------|
| `plan_abort`（未 dismiss）+ `awaiting_approval` | **C 优先**；abort 横幅折叠为顶部可关闭条，避免挡住审批按钮 |
| `plan_drafting` + 即将进入 C | 探索结束瞬间：先清 drafting，再切 C |

---

## 5. 各状态详细规格

### 5.1 状态 A — 空态

- 主文案：`还没有任何计划`
- 副文案（可选）：`在 Plan 模式下发送需求，将在此生成可审批的执行计划`
- 叠加「探索中」时：主文案可保留，顶部显示探索条。

### 5.2 状态 B — 计划列表

#### 5.2.1 单条计划卡片

| 区域 | 来源 |
|------|------|
| 标题 | `PlanDisplayEntry.title`（入列表时缓存，见 8.1） |
| 简介 | 缓存 `summaryOneLine` 或解析 `## 3. 推荐方案` 首行 |
| Todo | `## 4. 执行步骤` 的 `- [ ]` / `- [x]` |
| 徽标 + 进度 | `status`；`executing` 显示「第 N/M 步」 |

#### 5.2.2 多卡片排列与样式

- 顺序：`approvedAt` 升序（旧上、新下）。
- **视觉区分（必须）：**
  - `executing`：默认样式 + 进度
  - `completed`：弱化样式 + 完成图标；**默认折叠**为标题行（可展开 todo）
  - `cancelled`：弱化 + 取消图标

#### 5.2.3 执行中操作

「继续执行」「取消计划」在对应卡片上，不放在聊天区 `PlanResumeBanner`。

#### 5.2.4 次要操作

「在编辑器中打开」：打开 `.spaceassistant/plans/xxx.md`，标注「手改可能破坏结构，建议通过对话迭代」。

---

### 5.3 状态 C — 待确认

#### 5.3.1 审批信息（10 秒可决策）

与主文档 4.4 对齐：标题、方案摘要、步骤数、验收≤3、风险、占位符警告、可折叠步骤预览。

#### 5.3.2 旧计划上下文（必须）

审批区底部 **「当前计划影响」** 区块（非笼统合并规则文案）：

| `display_plans` 情况 | 展示示例 |
|---------------------|----------|
| 为空 | `批准后：将新增 1 个计划并等待您确认执行。` |
| 有 1 条 `executing` | `当前有 1 个执行中计划「{title}」（第 3/5 步）。批准后新计划将列在其下方，**不会自动开始执行**；旧计划保持执行中直至您取消或完成。` |
| 有 1 条 `completed` | `当前已完成计划「{title}」将折叠保留在列表底部，新计划显示在上方。` |
| 多条 | `当前列表有 N 个计划（含 M 个执行中）。批准后新计划将追加在列表最下方。` |

可选：「查看当前计划列表」折叠区，只读展示 `display_plans` 卡片（不显示审批按钮）。

#### 5.3.3 操作按钮（行为必须明确）

| 按钮 | MVP 行为 |
|------|----------|
| **批准并执行** | 若存在 `executing` 的旧计划 → 先弹出**二次确认**（见 7.3）；否则 `plan:approve` → 合并 `display_plans` → 触发执行 |
| **修改计划** | **不**跳转文件编辑。点击后：`setSession`（已在本会话则跳过）→ 聊天输入框 `focus` → 预填 `请描述你对计划的修改意见：` → 用户发送后走 Plan 修订流程 |
| **拒绝并反馈** | 与「修改计划」相同模式：聚焦聊天框，预填 `请说明拒绝原因或修改方向：` → 发送后调用 `plan:reject` 并触发修订（拒绝原因写入计划文件 `## 8. 审批反馈`） |

> **复用理由：** 与 `PendingConfirmBanner` 点击后 `setSession` + `setConfirmFocusToolUseId` 相同——**把用户送到会话内正确上下文**，而非在侧面板弹窗写长文。

「在编辑器中打开（高级）」：链接样式，附风险提示，非主按钮。

---

### 5.4 探索终止（plan_abort）

- 展示：PlanPanel 顶部 `Alert` 样式横幅（含 `report` 摘要）。
- **关闭 / 知道了：** 仅设置 `plan_abort_dismissed: true`，**不删除** `plan_abort` 原文（审计保留）。
- 关闭后主状态：按第 4.1 节重新判定（可有 B + 顶部无 abort 横幅）。

---

## 6. 审批确认交互

流程与第 7、8 节状态机一致；IPC 沿用现有 `plan:approve` / `plan:reject` / `plan:approval-ready`。

**即时刷新：** `plan:approval-ready`、`planState` 返回值、`plan:state-changed` 均驱动 PlanPanel 与 **全局提示 Store** 更新。

---

## 7. 多计划并存与替换规则

### 7.1 拒绝后

- 清空 `pending_plan`；`display_plans` 与 `plan` **保持审批前快照**。
- UI：有列表 → B；无 → A。

### 7.2 批准后合并（修订 v1.1）

| 旧计划（`display_plans` 最后一条或唯一 `executing`） | 行为 |
|---------------------------------------------------|------|
| 无 | 新计划入列表，`plan` 指向新计划 |
| `completed` | 新计划入列表**上方**（主展示）；旧 completed **折叠保留在底部**（**不**从列表删除） |
| 未完成且非 executing（如 `cancelled`） | 新计划**追加在下方** |
| **`executing`** | 见 7.3 |

### 7.3 执行中冲突（MVP 必须，方案 A）

批准时若存在 `status === 'executing'` 的旧计划：

1. 弹出确认框：  
   `当前计划「{title}」执行到第 N/M 步。批准新计划后，旧计划将标记为已取消，新计划加入列表且不会自动开始执行。是否继续？`
2. 用户确认：旧计划 → `cancelled`（保留 `currentStepIndex`）；`pending_plan` 合并入 `display_plans`；`plan` 指向新计划；**不自动**启动 Worker。
3. 用户取消：保持状态 C，不调用 approve。

（方案 B「批准按钮灰化」可作为设置项，MVP 不采用。）

---

## 8. 数据模型与状态机

### 8.1 字段（`Session.metadata`）

```typescript
interface PlanDisplayEntry {
  planId: string
  planFilePath: string
  title: string              // 入列表时解析缓存
  summaryOneLine?: string
  status: PlanStatus
  version: number
  createdAt: number
  approvedAt: number | null
  currentStepIndex: number
  stepsTotal: number
}

interface SessionPlanMetadata {
  /** 当前活跃计划（执行指针） */
  plan?: PlanMeta | null
  /** 待审批稿；仅 awaiting_approval */
  pending_plan?: PlanMeta | null
  /** 面板展示列表（已批准） */
  display_plans?: PlanDisplayEntry[]
  plan_drafting?: boolean
  plan_versions?: PlanVersionEntry[]
  plan_abort?: PlanAbortMeta | null
  plan_abort_dismissed?: boolean
  plan_step_results?: PlanStepResult[]
}
```

### 8.2 状态机（`pending_plan` / `plan` / `display_plans`）

```text
[无 plan 字段] --用户 Plan 模式发消息--> plan_drafting=true
plan_drafting --探索成功--> pending_plan=awaiting_approval, plan_drafting=false
              --plan_abort--> plan_abort 设置, plan_drafting=false

pending_plan(awaiting_approval):
  --批准--> 合并入 display_plans, pending_plan=null, plan=新计划
  --拒绝--> pending_plan=null, display_plans 与 plan 不变

plan(executing) --步骤完成--> executing / completed
```

**不变量：**

- `pending_plan` 与 `display_plans` 互斥展示语义：待审期间 `display_plans` 为**快照**，不写入待审稿。
- `plan` 始终指向「当前应执行」的计划；批准后立即切到新计划，但**执行**需用户点「继续执行」或批准流程末尾显式触发（与 7.3 一致）。

### 8.3 迁移

- 仅有 `metadata.plan` 的会话：首次 `plan:read` 时若 `status` 为 `executing|completed|cancelled`，生成 `display_plans[0]`（含 `title` 缓存）。

---

## 9. 全局待办提示（复用会话列表机制）

### 9.1 设计思路

复用现有 [`PendingConfirmBanner`](../src/renderer/components/SessionList/PendingConfirmBanner.tsx) + [`pendingConfirmStore`](../src/renderer/services/pendingConfirmStore.ts) 的架构，**不**在 FileOverlay 内再造一套重 UI。

| 机制 | 工具写入确认（已有） | 计划待审批（新增） |
|------|---------------------|-------------------|
| Store | `pendingConfirmStore` | **`pendingPlanStore`**（建议独立，避免与 toolUseId 混淆） |
| 数据来源 | `tool:confirm-request` | `plan:approval-ready` / `plan:state-changed` + `plan:read` |
| 展示位置 | 左侧会话列表搜索框下方 | **同位置**，紧挨工具确认条下方或合并为统一条 |
| 点击行为 | `setSession` + `setConfirmFocusToolUseId` | `setSession` + **`closeFile()`** + 可选 `planFocus=true` |

### 9.2 UI 规格：`PendingPlanBanner`（或扩展为 `SessionAttentionBanner`）

**展示条件：** 存在任一会话 `pending_plan.status === 'awaiting_approval'`（从 Store 聚合，支持多会话）。

**样式：** 复用 `.pending-confirm-banner` CSS 变量；颜色可用主色/蓝色系与工具确认（黄色）区分，或同一组件内分节标题。

**文案：**

- 单会话单计划：`1 个计划待审批 · {会话名} · {title}`
- 多会话：`{n} 个计划待审批`

**点击条目：**

1. `dispatch(setSession(sessionId))`
2. `closeFile()`（DetailPanelContext，清空 `selectedFile`）
3. 触发 PlanPanel 滚动至审批区（`planFocus` 事件，实现细节由前端约定）

### 9.3 FileToolbar 弱提示（可选，辅助）

当 `selectedFile` 非空且**当前会话**有待审批计划时，在 `FileToolbar` 右侧增加文字按钮：`计划待审批`，点击行为同 9.2。  
**不能替代** 9.2 左侧全局条（用户可能不看工具栏右侧）。

### 9.4 与 Plan 数据「丢失」的关系

| 误解 | 事实 |
|------|------|
| 打开文件后计划没了 | metadata / 文件仍在，仅 PlanPanel 隐藏 |
| 切走会话后审批消失 | 左侧全局条仍展示其他会话待审批项 |
| 重启后才看到审批 | v1.0 bug 已用 `plan:approval-ready` 修复；全局条监听同一事件 |

---

## 10. 与聊天区的关系

### 10.1 移除清单

| 组件 | 处理 |
|------|------|
| `PlanApprovalCard` | 从 `ChatView` **移除** |
| `PlanResumeBanner` | **移除** |
| `PlanAbortCard` | **移除**；可选保留一条 assistant 短消息：「探索已终止，详见右侧计划面板」 |

### 10.2 保留与展示

| 内容 | 策略 |
|------|------|
| 探索期只读工具调用 | **正常展示** `ToolCallCard` |
| 执行期写入工具 | 正常展示 + `WriteConfirmCard` + 左侧工具待确认条 |
| 计划结构化正文 | **不**在聊天流重复渲染 plan-doc 全文；助手消息可保留简短说明 + 右侧引导 |

### 10.3 修改/拒绝后的聊天引导

输入框预填文案（见 5.3.3），发送后由现有 Plan 修订 / reject IPC 处理。

---

## 11. 非目标

- PlanPanel 内嵌全文编辑器；手改 `.md` 仅高级链接。
- 跨会话计划聚合页。
- 与工具确认 Store 硬合并为同一队列（可同 UI 容器，保持 Store 分离）。

---

## 12. 验收标准

### 12.1 基础（v1.0 延续）

1. 未选文件时 Plan 在 `detail-panel-placeholder`，不在聊天顶部。
2. 空态文案正确；B 态展示标题、简介、todo、徽标。
3. C 态审批信息完整；拒绝回退；批准合并符合 7.2。
4. `plan:approval-ready` 后 PlanPanel 即时更新。

### 12.2 评审新增（v1.1）

5. **文件预览 + 待审批：** 打开文件预览时左侧出现「计划待审批」条；点击后关闭预览并显示 C 态。
6. **预览中进入待审批：** 用户正在看文件时规划完成，全局条**即时**出现（无需重启）。
7. **C 态旧计划上下文：** 底部「当前计划影响」含执行进度或 completed 说明。
8. **修改计划：** 聚焦聊天输入框 + 引导文案，不打开文件编辑器。
9. **拒绝反馈：** 同修改计划交互；`pending_plan` 清空且列表快照恢复。
10. **executing 冲突：** 批准时弹出二次确认；确认后旧计划 `cancelled`，新计划不自动执行。
11. **completed 批准新计划：** 旧计划折叠保留在底部，新计划在上方。
12. **plan_abort 关闭：** 仅 `plan_abort_dismissed`，主状态按 4.1 恢复。
13. **drafting：** 仅叠加 A/B；进入 C 时 drafting 条消失。
14. **多次拒绝再提交：** `pending_plan` 替换正确，被拒稿不入 `display_plans`。
15. **迁移：** 仅 `plan.completed` 无 `display_plans` 时首次读取自动填充列表。
16. **abort + awaiting 并存：** C 优先，abort 为可关闭顶栏。

---

## 13. 附录

### 附录 A：对主文档的修订建议

- 4.4 审批界面 → 右侧 PlanPanel + 左侧全局待办条。
- 4.7 恢复：`completed` 在 `display_plans` 折叠展示。
- 验收第 4 条 → 「右侧 PlanPanel 或左侧待审批条可发现」。

### 附录 B：关联文档修订清单

| 文档 | 修订 |
|------|------|
| [referenced-files-requirement.md](./referenced-files-requirement.md) | §3.3.1 上半区改为 PlanPanel / 空态 |
| [通用Agent-Plan模式MVP产品需求文档.md](./通用Agent-Plan模式MVP产品需求文档.md) | 4.4 界面形态、通知机制 |

### 附录 C：实现复用清单（开发参考）

| 已有 | 扩展 |
|------|------|
| `pendingConfirmStore` | 新建 `pendingPlanStore`，同样 `init/subscribe/IPC` |
| `PendingConfirmBanner` | 新增 `PendingPlanBanner` 或合并为 `SessionAttentionBanner` |
| `plan:approval-ready` | 写入 `pendingPlanStore` |
| `DetailPanelContext.closeFile` | 全局条点击时调用 |
| `layout.css` `.pending-confirm-banner` | Plan 条复用或扩展 modifier |
| `FileToolbar` | 可选「计划待审批」文字按钮 |

---

*文档结束*
