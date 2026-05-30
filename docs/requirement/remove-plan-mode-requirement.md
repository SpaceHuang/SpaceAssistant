# 移除 Plan 模式 — 产品需求规格

**版本：** 1.1  
**日期：** 2026-05-30  
**状态：** 待评审  
**变更说明（v1.1）：** 吸收 [remove-plan-mode-requirement-review.md](../review/remove-plan-mode-requirement-review.md) 评审意见；修正模块清单/CSS 路径/Feishu 字段描述；明确 metadata 持久化策略、`planTypes.ts` 分阶段删除、`toolChatLoop` 删除对照表及 P-1 准备阶段。  
**关联文档：**

- [通用Agent-Plan模式MVP产品需求文档.md](./通用Agent-Plan模式MVP产品需求文档.md)（将被本需求 supersede）
- [plan-detail-panel-requirement.md](./plan-detail-panel-requirement.md)
- [plan-auto-execution-requirement.md](./plan-auto-execution-requirement.md)
- [plan-resume-button-state-requirement.md](./plan-resume-button-state-requirement.md)
- [feishu-integration-requirement.md](./feishu-integration-requirement.md)
- [remove-plan-mode-requirement-review.md](../review/remove-plan-mode-requirement-review.md)

---

## 目录

1. [概述](#1-概述)
2. [决策与原则](#2-决策与原则)
3. [移除范围](#3-移除范围)
4. [移除后的产品行为](#4-移除后的产品行为)
5. [数据迁移与兼容](#5-数据迁移与兼容)
6. [界面变更规格](#6-界面变更规格)
7. [配置与 API 变更](#7-配置与-api-变更)
8. [飞书远程 Agent 变更](#8-飞书远程-agent-变更)
9. [代码模块清单（实现参考）](#9-代码模块清单实现参考)
10. [分阶段实施建议](#10-分阶段实施建议)
11. [非目标](#11-非目标)
12. [验收标准](#12-验收标准)
13. [关联文档处理](#13-关联文档处理)

---

## 1. 概述

### 1.1 背景

SpaceAssistant 当前提供两种聊天模式：

| 模式 | 行为 |
|------|------|
| **普通模式（normal）** | 用户发消息后 Agent 直接调用工具执行，写入/脚本等操作走现有确认卡流程 |
| **Plan 模式（plan）** | 先进入只读探索期 → 生成结构化计划 → 用户审批 → 按步骤执行，含独立编排、ACL、右侧面板与飞书远程分支 |

Plan 模式自 MVP 起陆续叠加：详情面板、自动执行、工具确认策略、步间暂停/恢复、全局待审批 Banner、飞书远程 Plan 分支等，形成 **独立子系统**（主进程 `electron/plan/`、渲染进程 `Plan/` 组件群、会话 metadata 多键、**8 个 plan invoke IPC + 4 个 plan 事件**、设置页独立 Tab）。

### 1.2 变更意图

**从产品路线中移除 Plan 模式**，统一为 **单一 Agent 工作流**（即现有「普通模式」行为），降低：

- 用户认知成本（模式选择、审批闸门、步间继续）
- 维护成本（双路径编排、Plan 专用 ACL、渠道分叉）
- 体验割裂（桌面端 Plan 执行 vs 飞书远程 Plan vs 普通模式）

移除后，用户仍可通过 **工具确认卡**、**Skills**（如 `writing-plans` / `executing-plans`）、**聊天中的 Markdown 计划** 等方式自行组织任务，但 **应用不再提供内置的 Plan 状态机与审批 UI**。

### 1.3 问题陈述

Plan 模式投入大量工程能力，但：

1. **双重闸门**问题长期存在：计划批准后仍可能逐步/逐工具确认，与「一次性授权」设计意图冲突（见 [plan-auto-execution-requirement.md](./plan-auto-execution-requirement.md)）。
2. **与普通模式能力重叠**：澄清、分步、只读探索可通过 System Prompt + Skills + 工具确认策略实现，无需独立模式。
3. **占用右侧栏核心区域**：`DetailPanel` 上半区固定为 `PlanPanel`，限制其他详情能力扩展。
4. **飞书与桌面分叉**：`feishuRemoteAgent` 独立 Plan 分支增加测试与行为对齐成本。

---

## 2. 决策与原则

### 2.1 核心决策

| # | 决策 |
|---|------|
| D1 | **完全移除** Plan 模式，不保留「隐藏开关」或「实验性入口」 |
| D2 | **彻底移除 `ChatMode` 类型**及所有 `chatMode` 传参；不存在「默认 normal」，只有唯一 Agent 路径 |
| D3 | **工具执行** 统一走 `toolChatLoop` 普通路径；删除 Plan 探索期 ACL、Plan 工具阶段过滤、Plan 专用确认策略 |
| D4 | **右侧详情栏** 移除 `PlanPanel`；上半区改为空态占位（见 4.2 最小规格） |
| D5 | **历史数据** 会话 metadata 中的 Plan 字段 **加载时 strip 并持久化**；磁盘计划文件 **保留不删** |
| D6 | **飞书远程** 移除 Plan 分支与相关配置；远程 Agent 与桌面 Agent 同一路径 |

### 2.2 设计原则

- **最小用户伤害**：进行中 Plan 会话降级为普通会话，不丢聊天记录与计划 Markdown 文件。
- **最小 diff 优先**：删除 Plan 专用模块，恢复被 Plan 分支改动的共享逻辑至「无 Plan 假设」状态。
- **分阶段删类型**：`planTypes.ts` 先增迁移函数、后删无引用内容，避免一次性删文件导致编译断裂（见 5.4、10 节）。
- **不迁移到 Skill**：本需求不要求把 Plan 编排改写为 Skill；仅移除内置能力。
- **文档同步**：实现完成后，关联 Plan 需求文档标记为「已废弃」，见第 13 节。

---

## 3. 移除范围

### 3.1 用户可见功能（必须移除）

| 区域 | 功能 | 说明 |
|------|------|------|
| 输入区 | 模式选择器 `composer-mode-select` | 「普通 / Plan」下拉 |
| 设置 → 通用 | 「默认聊天模式」表单项 | 字段 `defaultChatMode` 整项删除 |
| 设置 → Plan 模式 Tab | 整 Tab | 执行模式、工具确认策略、脚本自动批准、步进消息等 |
| 右侧栏 | `PlanPanel` 及子组件 | 审批卡、计划列表、执行进度、暂停/继续/取消 |
| 会话列表 | `PendingPlanBanner` | 「N 个计划待审批」全局提示 |
| 文件预览 | 待审批计划入口 | `FileOverlay` 中 `getPendingPlanMeta` + `plan-focus`；`FileToolbar` 中 `onPendingPlanClick` +「计划待审批」按钮 |
| 聊天区 | Plan 专用交互 | 修订反馈注入、自动执行流、Plan 审批 ready 聚焦 |
| 飞书设置 | 「远程 Plan 模式」 | `remotePlanMode`；`remotePlanKeywords` 无独立 UI 但需从类型与 merge 逻辑删除 |
| 飞书远程 | Plan 生成 + Y/N 确认 + `runPlanUntilDone` | 改为标准 tool chat |

### 3.2 主进程能力（必须移除）

| 能力 | 入口/模块 |
|------|-----------|
| Plan 编排 | `runPlanModeChat`、`runPlanningPhase`、Worker 执行循环 |
| Plan IPC | `plan:read/approve/reject/cancel/dismiss-abort/resume-execution/run/pause`（8 invoke） |
| Plan 事件 | `plan:state-changed`、`plan:step-completed`、`plan:step-started`、`plan:approval-ready`（4 event） |
| Plan ACL | `shouldBlockToolInPlanMode`、`filterBuiltinToolsForPlanPhase` |
| Plan 工具确认 | `shouldSkipToolConfirm`、`markPlanConfirmFailure`、`runScriptProvenance`（**整模块**，见 9.1） |
| Plan 文件管理 | `planManager`、`planParser`、`planPaths`（`.spaceassistant/plans/` **新写入**逻辑） |
| Plan 执行锁 | `planExecutionLock` |
| 流式路由分叉 | `claudeStreamHandlers` 中 `chatMode === 'plan'` 分支 |
| Plan 配置注入 | `main.ts` / `feishuIpc.ts` / `remoteCommandRouter.ts` 中的 `getPlanConfig` |

### 3.3 共享类型与配置（必须移除或收缩）

| 项 | 处理 |
|----|------|
| `ChatMode` | **删除类型**及所有引用；不再存在 mode 概念 |
| `PlanConfig`、`mergePlanConfig` 及 `AppConfig.plan` | 从配置模型与 `domainTypes.ts` 删除 |
| `planTypes.ts` | **分阶段处理**（见 5.4）：先增 strip 函数 → 删 Plan 模块后删无引用类型/helper → 最终可删文件或仅留迁移代码 |
| `planToolsFilter.ts` | 删除 |
| `PLAN_READONLY_BROWSER_ACTIONS` / `isPlanReadonlyBrowserAction` | 删除；browser 策略回归通用 `browserActionPolicy` |
| `electron/tools/types.ts` 中 `planToolPhase` | 从执行器上下文删除 |
| `preload.ts` / `api.ts` 中 Plan API | 删除 |
| `reconcilePlanExecutionOnLoad` | 随 Plan 子系统删除（当前代码库中 **未被调用**，属 dead code） |

### 3.4 `toolChatLoop.ts` 删除对照（实现必读）

| 删除项 | 保留项（普通 Agent 确认流程） |
|--------|------------------------------|
| 参数 `planToolPhase`、`planConfig` | `needsConfirm` / WriteConfirm 卡流程 |
| `shouldBlockToolInPlanMode` | 工具执行与超时逻辑 |
| `shouldSkipToolConfirm` / `toolConfirmSkipReason` | — |
| `markPlanConfirmFailure` | — |
| `getPlanMeta` / `getPlanExecutionMeta` 读取 | — |
| `./plan/runScriptProvenance` 全链路 | — |

实现前应用 IDE「Find All References」确认上述符号在 `toolChatLoop.ts` 外无残留引用（`planOrchestrator.ts` 删除后应仅剩本文件与渲染进程 hook）。

### 3.5 测试（必须更新）

- 删除 `electron/plan/*.test.ts`、`src/renderer/components/Plan/*.test.ts` 等 Plan 专用测试
- 更新 `browserExecutor.test.ts`、`useActionablePendingConfirms.test.ts`、`FeishuRemoteStatusBar.test.tsx`、`feishuRemoteDisplayStatus.test.ts` 等含 Plan 假设的测试
- 全量 `npm test` 通过

---

## 4. 移除后的产品行为

### 4.1 聊天主路径

```text
用户输入消息
    │
    ▼
claude-chat-create-with-tools（唯一路径）
    │
    ├── 工具调用（读写/脚本/browser/…）
    │       └── 现有 WriteConfirmCard / 超时 / 拒绝 流程（不变）
    │
    └── 流式文本 + 思考 + 工具卡片展示（不变）
```

- **无**探索期只读强制、**无**计划审批闸门、**无**步间「继续执行」。
- 用户若需要「先规划再动手」，依赖：自行在消息中要求 Agent 先输出计划、或使用 Superpowers 类 Skills。

### 4.2 右侧详情栏

移除 `PlanPanel` 后，`DetailPanel` 上半区（`detail-panel-top`）：

| 要求 | 说明 |
|------|------|
| 不显示 Plan 相关内容 | 无审批、无步骤条、无计划卡片 |
| 布局保持 | 仍与「引用文件」面板纵向分栏 + 拖拽分隔；飞书远程状态条保留 |
| **空态最小规格** | 文案「暂无详情」；容器 `role="region"` + `aria-label="详情面板"`；class `detail-panel-top detail-panel-top--empty` |

本需求 **不定义** 空态以外的上半区新产品功能。

### 4.3 工具确认

`useActionablePendingConfirms` 等逻辑 **移除 Plan 执行态特殊分支**（如 `planRunState === 'running'` 时隐藏待确认）。  
所有待确认工具调用 **统一** 按普通 Agent 规则展示 Banner / 确认卡。

### 4.4 Browser 工具

删除 Plan 探索期只读白名单后，`browser` 工具行为 **与普通 Agent 一致**：按 `browserActionPolicy` 的确认策略与配额执行。  
`browserExecutor.ts` 中 `planToolPhase === 'planning'` 分支整段删除（非 Plan 模式下该字段为 `null`，删除后不再出现「Plan 探索期不允许 navigate」类错误）。

---

## 5. 数据迁移与兼容

### 5.1 应用配置（`spaceassistant-data.json`）

| 字段 | 处理 |
|------|------|
| `config.defaultChatMode` | 读取时 strip；保存时不再写入 |
| `config.plan` | 读取时 strip；保存时不再写入 |
| `config.feishu.remotePlanMode` | 读取时 strip；`mergeFeishuConfig` / `DEFAULT_FEISHU_CONFIG` 同步删除 |
| `config.feishu.remotePlanKeywords` | 同上 |

**不要求** 对用户弹窗通知；静默迁移即可。

### 5.2 会话 metadata

以下键通过 **`stripPlanFieldsFromSessionMetadata`** 剥离：

| 键 | 常量 |
|----|------|
| `plan` | `SESSION_META_PLAN` |
| `pending_plan` | `SESSION_META_PENDING_PLAN` |
| `display_plans` | `SESSION_META_DISPLAY_PLANS` |
| `plan_drafting` | `SESSION_META_PLAN_DRAFTING` |
| `plan_versions` | `SESSION_META_PLAN_VERSIONS` |
| `plan_abort` | `SESSION_META_PLAN_ABORT` |
| `plan_abort_dismissed` | `SESSION_META_PLAN_ABORT_DISMISSED` |
| `plan_step_results` | `SESSION_META_PLAN_STEP_RESULTS` |
| `plan_execution` | `SESSION_META_PLAN_EXECUTION` |

**触发点与持久化（必须明确）：**

| 项 | 规格 |
|----|------|
| **何时 strip** | 主进程 `session:list` 与 `session:get` 返回前（统一入口，渲染进程不各自 strip） |
| **是否落盘** | 若 strip 后 metadata 有变化，**立即写回 DB**（同一次 IPC 内完成），避免仅内存清理、重启后 Plan 键复活 |
| **幂等** | 多次调用 `stripPlanFieldsFromSessionMetadata` 结果一致 |
| **飞书远程** | 远程 Agent 经同一 `session:get`/消息 append 路径读写 session，与桌面共用 strip 逻辑 |

**进行中 Plan 会话的处理：**

| 原状态 | 降级行为 |
|--------|----------|
| `drafting` / `awaiting_approval` | 会话可正常打开；metadata 清理并落盘后等同普通会话；聊天历史保留 |
| `executing` / `approved` | 不再自动续跑；metadata 清理并落盘；用户可手动继续对话 |
| 磁盘计划文件 | **保留** `{workDir}/.spaceassistant/plans/*.md`，用户可自行在文件树中查看 |

### 5.3 磁盘文件

| 路径 | 处理 |
|------|------|
| `{workDir}/.spaceassistant/plans/` | **不删除**；停止新写入 |
| 会话备份 | 不要求重写历史备份；新备份自然不含已 strip 的 metadata |

### 5.4 迁移函数与 `planTypes.ts` 策略

**Phase P-1（先于删 Plan 模块）** 新增：

```typescript
stripPlanFieldsFromSessionMetadata(metadata: Record<string, unknown>): Record<string, unknown>
stripPlanFieldsFromAppConfig(config: AppConfig): AppConfig  // 或 Partial<AppConfig> 就地清理
```

可放在 `src/shared/planTypes.ts`（过渡期）或 `src/shared/domainTypes.ts`；需导出 `SESSION_META_*` 常量供 strip 使用。

**`planTypes.ts` 删除顺序：**

1. P-1：添加上述 strip 函数 + 常量
2. P0–P2：删除 `electron/plan/`、Plan UI、`toolChatLoop` Plan 分支等
3. P3：TypeScript 无引用后，删除 `getPlanMeta`、`PlanMeta`、`ChatMode` 等全部 Plan 类型与 helper
4. 最终：`planTypes.ts` **删除文件**，或仅保留 strip 函数并迁至 `domainTypes.ts` / `sessionMigration.ts`

无需 DB 版本号迁移表。

---

## 6. 界面变更规格

### 6.1 消息输入区（`MessageInput`）

| 变更 | 详情 |
|------|------|
| 移除模式选择器 | 删除 `Select` / `composer-mode-select` 及「Plan 模式需先规划…」类 hint |
| 简化 Props | 删除 `chatMode`、`defaultChatMode`、`onChatModeChange`；`onSend(text)` 不再传 mode |
| `MessageInputHandle.setChatMode` | 删除 |
| 样式 | 删除 `src/renderer/theme/layout.css` 中 `.composer-mode-select` 相关规则 |

### 6.2 设置页（`ConfigModal`）

| 变更 | 详情 |
|------|------|
| 删除「默认聊天模式」表单项 | 整项删除（非改为固定 normal） |
| 删除「Plan 模式」Tab | 含 executionMode、toolConfirmPolicy 等全部控件 |
| 保存 payload | 不再包含 `defaultChatMode` 或 `plan` |

### 6.3 右侧栏（`DetailPanel`）

| 变更 | 详情 |
|------|------|
| 移除 `<PlanPanel />` | 上半区替换为空态容器（见 4.2） |
| 删除 Plan 样式 | 删除 `src/renderer/components/Plan/planPanel.css`；删除 `layout.css` 中 `.pending-confirm-banner--plan` |

### 6.4 会话列表

| 变更 | 详情 |
|------|------|
| 移除 `PendingPlanBanner` | `App.tsx` 不再挂载 |
| 删除 `pendingPlanStore` | 及 `planOnApprovalReady` / `planOnStateChanged` 订阅 |

### 6.5 聊天视图（`ChatView`）

移除以下 Plan 相关状态与副作用（非穷举，实现时以删除编译引用为准）：

- `chatMode` / `setChatMode` state
- `planActionLoading`、`planRevisionFeedback`
- `reloadPlanState`、`planOnStateChanged`、`planOnStepCompleted`、`planOnApprovalReady` 订阅
- `planPanelActionsStore` 注册、`PlanPanelActionsContext`、`derivePlanExecutionUiState`
- `beginPlanAutoExecutionStream` / `plan:run` / `plan:approve` 等调用
- `sendInternal` 中 `chatMode === 'plan'` 与 `planRevisionFeedback` 传参
- `window.dispatchEvent(new CustomEvent('plan-focus'))`

### 6.6 文件预览（`FileOverlay` / `FileToolbar`）

| 文件 | 变更 |
|------|------|
| `FileOverlay.tsx` | 删除 `getPendingPlanMeta`、`openPendingPlan`、`plan-focus` dispatch |
| `FileToolbar.tsx` | 删除 `onPendingPlanClick` prop 及「计划待审批」按钮（约 133–136 行） |

---

## 7. 配置与 API 变更

### 7.1 `AppConfig` / `FeishuConfig` 变更

```typescript
// AppConfig 移除
defaultChatMode: ChatMode
plan: PlanConfig

// FeishuConfig 移除
remotePlanMode: FeishuRemotePlanMode
remotePlanKeywords?: string[]

// FeishuHealthCheck 移除
pendingPlans: number

// FeishuPendingConfirm.kind 移除 'plan_execute'
kind: 'tool_write' | 'plan_execute'  →  kind: 'tool_write'
```

同步删除 `mergePlanConfig`、`mergeFeishuConfig` 中对上述字段的处理。

### 7.2 `config:get` / `config:set` 契约

| API | 变更 |
|-----|------|
| `config:get` 响应 | **不再包含** `defaultChatMode`、`plan`；Feishu 块不含 `remotePlanMode` / `remotePlanKeywords` |
| `config:set` payload | 忽略客户端传入的上述字段（向前兼容一轮）；服务端 save 前 strip |
| `appIpc.ts` | 删除 `readPlanConfig`、`CONFIG_KEYS.plan`、`CONFIG_KEYS.defaultChatMode` |

### 7.3 IPC / preload 删除清单

**invoke 通道（8 个）：**

- `plan:read`
- `plan:approve`
- `plan:reject`
- `plan:cancel`
- `plan:dismiss-abort`
- `plan:resume-execution`
- `plan:run`
- `plan:pause`

**事件通道（4 个）：**

- `plan:state-changed`
- `plan:step-completed`
- `plan:step-started`
- `plan:approval-ready`

**流式聊天：**

- payload 删除 `chatMode`、`planRevisionFeedback`
- 响应删除 `planState`（若有）

### 7.4 `window.api` 类型

从 `src/shared/api.ts` 删除所有 `plan*` 方法及 `PlanReadResult`、`PlanMeta`、`ChatMode`（Plan 语境）等专用类型。

---

## 8. 飞书远程 Agent 变更

### 8.1 配置 UI

`FeishuSettingsTab` 删除「远程 Plan 模式」（off / auto / always）。  
`remotePlanKeywords` 无独立 UI，但须从类型、默认值、`mergeFeishuConfig` 一并删除。

### 8.2 运行时

| 文件 | 移除内容 |
|------|----------|
| `feishuRemoteAgent.ts` | `shouldUseRemotePlan()` 分支；`runPlanModeChat` / `runPlanUntilDone`；`getPlanConfig` 依赖 |
| `feishuConfirmManager.ts` | `kind: 'plan_execute'` 分支 |
| `feishuIpc.ts` | `getPlanConfig`；`feishu:health-check` 中 `pendingPlans` 字段 |
| `remoteCommandRouter.ts` | `getPlanConfig` 注入 |

**统一行为：** 飞书消息 → 标准 tool chat loop → 必要时 `tool_write` 确认（与桌面一致）。

### 8.3 远程状态与健康检查

| 项 | 说明 |
|----|------|
| `FeishuHealthCheck.pendingPlans` | 从 `feishuTypes.ts` 删除 |
| `feishu:health-check` | 不再返回 `pendingPlans` |
| 相关测试 | 更新 `FeishuRemoteStatusBar.test.tsx`、`feishuRemoteDisplayStatus.test.ts` 等 mock |

`feishuRemoteDisplayStatus.ts` **本身不含** Plan 逻辑；无需修改业务逻辑，仅测试与 health 类型联动更新。

---

## 9. 代码模块清单（实现参考）

便于开发排期；**以实际 grep 结果为准**，下表为当前仓库快照（2026-05-30）。

### 9.1 建议整目录 / 整文件删除

| 路径 |
|------|
| `electron/plan/`（全部，含 `runScriptProvenance.ts`） |
| `src/renderer/components/Plan/`（全部，含 `planPanel.css`） |
| `src/shared/planToolsFilter.ts` |
| `src/renderer/services/pendingPlanStore.ts` |
| `src/renderer/services/planPanelActionsStore.ts` |
| `src/renderer/services/planAutoExecutionStreamService.ts`（及 `.test.ts`） |
| `src/renderer/components/SessionList/PendingPlanBanner.tsx` |

### 9.2 建议大幅修改

| 路径 | 变更要点 |
|------|----------|
| `electron/claudeStreamHandlers.ts` | 删除 Plan 分支，仅 `runToolChatSession` |
| `electron/toolChatLoop.ts` | 按 3.4 节对照表删除 Plan 逻辑 |
| `electron/appIpc.ts` | 删除 plan IPC；`readPlanConfig`；config get/set Plan 字段；session list/get 接入 strip |
| `electron/main.ts` | 删除 `getPlanConfig`、`PLAN_CONFIG_KEY`、`mergePlanConfig` 注入 |
| `electron/preload.ts` | 删除 plan API |
| `electron/feishu/feishuIpc.ts` | 删除 `getPlanConfig`、`pendingPlans` |
| `electron/feishu/feishuRemoteAgent.ts` | 删除 Plan 分支 |
| `electron/feishu/remoteCommandRouter.ts` | 删除 `getPlanConfig` |
| `electron/feishu/feishuConfirmManager.ts` | 删除 `plan_execute` |
| `electron/browser/browserActionPolicy.ts` | 删除 Plan 只读 action 列表 |
| `electron/tools/browserExecutor.ts` | 删除 `planToolPhase` / `isPlanReadonlyBrowserAction` 分支 |
| `electron/tools/types.ts` | 删除 `planToolPhase` |
| `src/shared/api.ts` | 删除 plan 类型与方法 |
| `src/shared/domainTypes.ts` | 删除 `PlanConfig`、`mergePlanConfig`、`defaultChatMode`、Plan re-export |
| `src/shared/feishuTypes.ts` | 删除 remote Plan 字段、`pendingPlans` |
| `src/shared/planTypes.ts` | 分阶段：先 strip → 后删无引用（见 5.4） |
| `src/renderer/services/chatToolSessionService.ts` | 删除 `filterBuiltinToolsForPlanPhase`、`ChatMode` 传参 |
| `src/renderer/components/Chat/ChatView.tsx` | 删除 Plan 状态机集成 |
| `src/renderer/components/Chat/MessageInput.tsx` | 删除模式选择 |
| `src/renderer/components/Config/ConfigModal.tsx` | 删除 Plan Tab 与默认模式 |
| `src/renderer/components/Config/FeishuSettingsTab.tsx` | 删除远程 Plan |
| `src/renderer/components/DetailPanel/index.tsx` | 移除 PlanPanel，接入空态 |
| `src/renderer/components/DetailPanel/FileOverlay.tsx` | 删除待审批计划入口 |
| `src/renderer/components/DetailPanel/FileToolbar.tsx` | 删除 `onPendingPlanClick` |
| `src/renderer/hooks/useActionablePendingConfirms.ts` | 删除 Plan 分支 |
| `src/renderer/App.tsx` | 移除 PendingPlanBanner |
| `src/renderer/theme/layout.css` | 删除 `.composer-mode-select`、`.pending-confirm-banner--plan` |

### 9.3 测试文件

删除或重写所有引用 Plan 的 `*.test.ts` / `*.test.tsx`（约 15+ 文件，含 `electron/plan/*.test.ts`）。

**实现前建议：** 对 `getPlanConfig`、`shouldUseRemotePlan`、`filterBuiltinToolsForPlanPhase`、`PlanPanel` 等符号做全项目 Find All References，将遗漏补入本节。

---

## 10. 分阶段实施建议

| 阶段 | 内容 | 可交付状态 |
|------|------|------------|
| **P-1** | 新增 `stripPlanFieldsFromSessionMetadata` / `stripPlanFieldsFromAppConfig`；`session:list`/`session:get` 接入 strip + 落盘 | 旧数据加载不报错，Plan 键开始从 DB 清除 |
| **P0** | 删除 `electron/plan/`；`claudeStreamHandlers` 去掉 Plan 分支；删除 plan IPC handlers | 无法再通过 API 驱动 Plan |
| **P1** | UI：输入区、设置、PlanPanel、Banner、FileToolbar 计划按钮 | 用户看不到 Plan |
| **P2** | `toolChatLoop` / browser / feishu 分支清理；`chatToolSessionService` | 行为与单一 Agent 一致 |
| **P3** | 删 `planTypes.ts` 无引用内容；删 `planToolsFilter`；测试 + build 全绿 | 可发布 |
| **P4** | 关联文档标记废弃、CHANGELOG | 完成 |

**建议顺序：** P-1 → P0 → P1 ∥ P2 → P3 → P4。  
P1 与 P2 可并行，但 **P-1 必须先于 P0**（避免删 orchestrator 后旧 session 仍带 Plan 键且无清理）。

---

## 11. 非目标

| # | 非目标 |
|---|--------|
| NG1 | 不实现 Plan 能力的 Skill 替代方案 |
| NG2 | 不删除用户磁盘上已有 `.spaceassistant/plans/` 文件 |
| NG3 | 不改变普通 Agent 下工具确认卡的默认策略（除非现有 bug 需顺带修复） |
| NG4 | 不在本需求中定义右侧栏上半区空态以外的新产品功能 |
| NG5 | 不修改 Superpowers 推荐 Skills 中的 `writing-plans` / `executing-plans`（外部 skill 名，非内置 Plan 模式） |
| NG6 | 不做 Plan 下线数据统计或应用内公告 UI |
| NG7 | **不 rewrite** 历史消息中的 `<plan-doc>` / 计划 Markdown 正文 |
| NG8 | **不删除** 聊天时间线里已有的 assistant 计划文本；仅移除交互式审批 UI 与状态机 |

---

## 12. 验收标准

### 12.1 功能

- [ ] 消息输入区 **无** 模式切换；发送消息始终走 tool chat 主路径
- [ ] 设置页 **无** Plan Tab；**无** 默认聊天模式表单项
- [ ] 右侧栏 **无** 计划审批、步骤进度、继续/暂停 Plan 按钮；上半区显示空态（4.2）
- [ ] 会话列表 **无**「计划待审批」Banner
- [ ] 文件预览工具栏 **无**「计划待审批」按钮
- [ ] 飞书设置 **无** 远程 Plan 模式；飞书远程 **不** 触发 Plan 生成与 Y/N 计划确认
- [ ] Browser / 写文件 / 脚本 **无**「Plan 探索期不允许…」类错误

### 12.2 数据

- [ ] 旧配置含 `defaultChatMode`、`config.plan`、`remotePlanMode` 时应用 **正常启动**，且 `config:get` **不含** 上述字段
- [ ] 旧会话 metadata 含 Plan 键：**首次** `session:list` 或 `session:get` 后 DB 中 **不再含** Plan 键（重启后仍保持）
- [ ] `{workDir}/.spaceassistant/plans/` 下既有文件 **仍存在**
- [ ] 历史聊天消息中的计划正文 **仍可正常阅读**

### 12.3 工程

- [ ] `npm test` 全通过
- [ ] `npm run build` 与 `npm run build:electron` 成功
- [ ] 生产代码 grep **无**命中（测试快照除外）：
  - `plan:approve|runPlanModeChat|PlanPanel|shouldUseRemotePlan|filterBuiltinToolsForPlanPhase|getPlanConfig|pendingPlans`
- [ ] TypeScript **无**残留 `ChatMode`、`PlanConfig`、`PlanMeta` 引用（strip 迁移 helper 与常量除外）
- [ ] grep **不能替代** tsc：以上与编译零错误同时满足

### 12.4 回归

- [ ] 流式聊天、工具调用、WriteConfirmCard、会话 CRUD、文件引用、飞书远程（标准 tool chat）均正常
- [ ] 多会话并行、Abort、Thinking 展示无回归
- [ ] `toolChatLoop` 普通工具确认流程无回归（无 Plan 时仍正常弹确认卡）

---

## 13. 关联文档处理

实现合并后，以下文档在文首增加 **「状态：已废弃 — 见 remove-plan-mode-requirement.md」** 说明，**不删除文件**（保留历史决策记录）：

| 文档 |
|------|
| [通用Agent-Plan模式MVP产品需求文档.md](./通用Agent-Plan模式MVP产品需求文档.md) |
| [plan-detail-panel-requirement.md](./plan-detail-panel-requirement.md) |
| [plan-auto-execution-requirement.md](./plan-auto-execution-requirement.md) |
| [plan-resume-button-state-requirement.md](./plan-resume-button-state-requirement.md) |

`docs/develop/plan_mode_optimization_design.md`、`docs/analysis/plan_mode_vs_superpowers_analysis.md` 同理标记废弃。

---

## 附录 A：移除前后对比

| 维度 | Plan 模式存在时 | 移除后 |
|------|----------------|--------|
| 用户模式选择 | 普通 / Plan | 无（单一 Agent） |
| 写入前审批 | 计划级闸门 + 工具确认 | 仅工具确认 |
| 右侧栏上半区 | PlanPanel | 空态 |
| 飞书复杂任务 | 可选先 Plan 再执行 | 直接 Agent 执行 |
| 代码体量 | `electron/plan/` + 16+ UI 组件 | 删除 |
| 会话 metadata | 9+ Plan 键 | strip 后无 |
| IPC | 8 invoke + 4 event | 0 |

## 附录 B：风险与缓解

| 风险 | 缓解 |
|------|------|
| 用户依赖 Plan 审批流 | Release Note 说明；可用 Skills / 聊天内计划文本 |
| 进行中 Plan 会话中断 | P-1 strip + 落盘；计划 md 仍在磁盘；聊天历史保留 |
| `planTypes.ts` 一次性删除导致编译失败 | 5.4 分阶段策略；P-1 先加 strip |
| `toolChatLoop` 误删普通确认逻辑 | 3.4 删除/保留对照表；12.4 回归确认卡 |
| 漏删引用 | 9.3 Find All References + 12.3 扩展 grep |
| metadata 仅内存 strip、重启复活 | 5.2 要求 strip 后立即写回 DB |
| 飞书远程行为变化 | 8.2 统一 tool chat；删除 `pendingPlans` / `plan_execute` |

---

**文档维护：** 实现过程中若发现额外 Plan 耦合点，应补充至第 9 节清单，并同步更新验收标准。
