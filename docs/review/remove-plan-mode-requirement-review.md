# 移除 Plan 模式需求评审

**评审日期：** 2026-05-30
**评审人：** Claude Code
**文档版本：** remove-plan-mode-requirement.md v1.0

---

## 一、总体评价

本需求文档结构完整、逻辑清晰，覆盖了 UI、主进程、共享类型、配置、飞书远程等全部 Plan 相关层面。决策与原则（第2节）与移除范围（第3节）对应良好。分阶段实施建议（P0-P4）合理可行。

**主要风险点集中在以下三类问题：**
1. 代码引用链复杂，局部删除可能导致编译断裂
2. 部分描述与实际代码不完全吻合，需要实现时核实
3. 某些共享 helper 函数被多层调用，需谨慎处理

---

## 二、具体问题

### 2.1 代码路径/名称不匹配问题

| 需求文档描述 | 实际代码情况 | 建议 |
|-------------|-------------|------|
| 第9.1节：`src/renderer/services/chatToolSessionService.ts` | 实际不存在该文件；主进程工具循环在 `electron/toolChatLoop.ts` | 修正路径为 `electron/toolChatLoop.ts` |
| 第9.2节：`src/renderer/hooks/useActionablePendingConfirms.ts` 删除 Plan 分支 | 该文件存在，引用了 `getPlanMeta`、`getPlanExecutionMeta` | 确认移除该文件中的 Plan 相关逻辑 |
| 第8.2节：`FeishuConfirmManager` 中 `kind: 'plan_execute'` 分支 | `electron/feishu/feishuConfirmManager.ts:54,132,178` 确实存在该类型 | 确认可删除，不影响其他 confirm 类型 |
| 第6.5节：删除 `FileOverlay` 中 `getPendingPlanMeta` 依赖 | `src/renderer/components/DetailPanel/FileOverlay.tsx:5,21` 确实有使用 | 实现时确认即可 |
| 第6.5节：删除 `FileToolbar` 中 `plan-focus` 事件 | `FileToolbar.tsx` 中无 `plan-focus` 监听器（搜索结果为空） | 可能为笔误或该功能未实现；实现时以实际搜索为准 |

### 2.2 `planTypes.ts` 不能简单删除

**问题描述：**
需求文档第3.3节提到"删除 `planTypes.ts`"，但该文件包含大量被以下模块依赖的 helper 函数：

| 函数名 | 被引用位置 |
|--------|-----------|
| `getPlanMeta` | `electron/toolChatLoop.ts`, `electron/plan/planModeAcl.ts`, `electron/plan/planManager.ts`, `electron/plan/planOrchestrator.ts`, `src/renderer/components/Chat/ChatView.tsx`, `src/renderer/hooks/useActionablePendingConfirms.ts` |
| `getPendingPlanMeta` | `electron/plan/planManager.ts`, `electron/plan/planOrchestrator.ts`, `src/renderer/services/pendingPlanStore.ts`, `src/renderer/components/DetailPanel/FileOverlay.tsx` |
| `getDisplayPlans` | `electron/plan/planOrchestrator.ts` |
| `isPlanExplorationBlocked` | `electron/plan/planModeAcl.ts` |
| `isSessionPlanExplorationBlocked` | `electron/plan/planModeAcl.ts` |
| `derivePlanPanelMainState` | `src/renderer/components/Plan/planPanelState.ts` |
| `getPlanExecutionMeta` | `electron/toolChatLoop.ts`, `src/renderer/components/Chat/ChatView.tsx`, `src/renderer/hooks/useActionablePendingConfirms.ts` |

**影响评估：**
- `electron/plan/planOrchestrator.ts` 整个文件将被删除（已列入第9.1节），届时内部引用自然消失
- 但 `electron/toolChatLoop.ts`（主进程工具循环）和渲染进程 `ChatView.tsx`、`useActionablePendingConfirms.ts` 仍依赖 `getPlanMeta`、`getPlanExecutionMeta`

**建议方案：**
不删除 `planTypes.ts`，而是保留以下只读辅助函数（供数据清理使用）：
- `stripPlanFieldsFromSessionMetadata(metadata)` — 清理会话 metadata
- `stripPlanFieldsFromAppConfig(config)` — 清理应用配置
- `SESSION_META_PLAN`、`SESSION_META_PENDING_PLAN` 等常量 — 用于清理逻辑

其他类型和 helper 函数（如 `getPlanMeta`、`getPendingPlanMeta`）在所有 Plan 相关模块删除后，由于无引用可被 TypeScript 编译自动标记为未使用，届时再清理。

### 2.3 `toolChatLoop.ts` 中的 Plan 引用需要仔细梳理

**问题描述：**
`electron/toolChatLoop.ts` 是主进程工具循环核心文件，需求文档第3.2节和第9.2节都提到要删除其中的 Plan 相关逻辑。实际代码审查发现：

```typescript
// 第 11 行
import { getPlanMeta, getPlanExecutionMeta } from '../src/shared/planTypes'
// 第 12-14 行
import { shouldSkipToolConfirm, toolConfirmSkipReason } from './plan/planToolConfirm'
import { markPlanConfirmFailure } from './plan/planConfirmFailure'
import { shouldBlockToolInPlanMode, type PlanToolPhaseArg } from './plan/planModeAcl'
// 第 681-684 行使用
const planMeta = sessionMeta ? getPlanMeta(sessionMeta) : null
```

**风险：**
删除这些引用时，需要确保：
1. `toolChatLoop.ts` 剩余逻辑不再需要 Plan 相关的 ACL 检查
2. `shouldSkipToolConfirm` 的删除不会影响普通模式的工具确认逻辑

**建议：**
实现前先用 IDE 的 "Find All References" 功能确认 `shouldSkipToolConfirm` 和 `shouldBlockToolInPlanMode` 在 `toolChatLoop.ts` 外部是否还有其他引用（预计只有 `planOrchestrator.ts`）。

### 2.4 `browserExecutor.ts` 中 `isPlanReadonlyBrowserAction` 的影响

**问题描述：**
`electron/tools/browserExecutor.ts:8,182` 引用了 `isPlanReadonlyBrowserAction`：

```typescript
if (ctx.planToolPhase === 'planning' && !isPlanReadonlyBrowserAction(action)) {
  return { ok: false, error: '...' }
}
```

这里的逻辑是：在 Plan 探索期，只读动作（observe/extract/screenshot/close）可以执行，其他动作被阻止。

**需求文档描述（第4.4节）：**
> 删除 Plan 探索期只读白名单后，`browser` 工具行为与普通模式一致

**风险评估：**
- `PLAN_READONLY_BROWSER_ACTIONS` 和 `isPlanReadonlyBrowserAction` 在 `browserActionPolicy.ts` 中定义
- `browserExecutor.ts` 中 `planToolPhase` 上下文需要确认来自哪里

**建议：**
确认 `browserExecutor.ts` 中的 `planToolPhase` 仅在 Plan 模式下传入（非 Plan 模式为 `null`），这样删除 Plan 相关逻辑后自然不会触发该分支。

### 2.5 `pendingPlanStore` 的订阅清理问题

**问题描述：**
`src/renderer/services/pendingPlanStore.ts` 订阅了多个 Plan 事件：
- `window.api.planOnApprovalReady`（第 29 行）
- `window.api.planOnStateChanged`（第 41 行）

需求文档第9.1节将其列入建议删除目录，但 `pendingPlanStore` 实例在 `App.tsx` 中被使用（第 69 行 `<PendingPlanBanner />`）。

**验证点：**
- `PendingPlanBanner` 组件本身在 `src/renderer/components/SessionList/PendingPlanBanner.tsx`
- `PendingPlanBanner` 是否使用了 `pendingPlanStore`？需要打开该文件确认

### 2.6 飞书设置页 `remotePlanKeywords` 遗漏问题

**问题描述：**
需求文档第8.1节和第3.1节提到移除 `remotePlanMode`，但 `feishuTypes.ts:34` 还有一个相关字段 `remotePlanKeywords`：

```typescript
remotePlanKeywords?: string[]
```

Feishu 配置界面（`FeishuSettingsTab.tsx`）目前只有 `remotePlanMode` 的选择器（第 292-300 行），没有单独的 `remotePlanKeywords` 配置 UI。但 `FeishuConfig` 类型和 `mergeFeishuConfig` 函数中都包含该字段。

**建议：**
在删除 `remotePlanMode` 时同步删除 `remotePlanKeywords` 字段及其在 `mergeFeishuConfig` 中的处理逻辑。

### 2.7 会话 metadata 清理时机需要明确

**问题描述：**
需求文档第5.2节描述：
> 以下键在**加载会话列表或打开会话时**从 metadata 中剥离（不写入新 save，内存中不再使用）

**建议明确以下问题：**
1. "加载会话列表时清理"和"打开会话时清理"是两次操作还是互斥的？
2. 如果用户在桌面端打开一个旧 Plan 会话，metadata 在打开时被清理；但如果用户在飞书远程中打开同一个会话（假设支持），是否也会清理？
3. 清理函数 `stripPlanFieldsFromSessionMetadata` 需要是幂等的（idempotent），即多次调用结果一致

### 2.8 验收标准中 grep 命令的局限性

**问题描述：**
第12.4节验收标准：
> `grep -r "plan:approve\|runPlanModeChat\|PlanPanel" src electron` **无**生产代码命中

**局限性：**
- `grep` 无法检测到编译后仍然存在的类型引用（如 TypeScript 类型残留）
- 无法检测到字符串字面量中的引用（如日志、错误消息）

**建议补充：**
- TypeScript 编译无错误（`tsc --noEmit`）
- `npm run build` 成功
- IDE 中无类型错误警告

---

## 三、逻辑正确性确认

以下逻辑经代码审查确认**正确**：

| 需求描述 | 验证结果 |
|---------|---------|
| `electron/feishu/feishuRemoteAgent.ts` 存在 `shouldUseRemotePlan` 函数和 `runPlanModeChat`/`runPlanUntilDone` 调用 | ✅ 确认存在（第 18 行 import，第 71-119 行使用） |
| `electron/claudeStreamHandlers.ts` 中 `chatMode === 'plan'` 分支 | ✅ 确认存在（第 207-217 行） |
| `electron/appIpc.ts` 中 8 个 plan IPC handlers | ✅ 确认存在（第 937-1080 行） |
| `electron/preload.ts` 中 plan API 定义 | ✅ 确认存在（第 142-169 行） |
| `src/shared/domainTypes.ts` 中 `AppConfig` 包含 `defaultChatMode` 和 `plan` | ✅ 确认存在（第 492, 499 行） |
| `src/shared/api.ts` 中 `claudeChatCreateWithToolsPayload` 包含 `chatMode` 和 `planRevisionFeedback` | ✅ 确认存在（第 83, 84 行） |
| `FeishuConfig` 包含 `remotePlanMode` | ✅ 确认存在（`feishuTypes.ts:33`） |
| `PendingPlanBanner` 在 `App.tsx` 中使用 | ✅ 确认存在（第 22, 69 行） |
| `PlanPanel` 在 `DetailPanel/index.tsx` 中使用 | ✅ 确认存在（第 6, 31 行） |

---

## 四、实现建议

### 4.1 删除顺序建议

1. **P-1（准备阶段）**：在 `planTypes.ts` 中添加 `stripPlanFieldsFromSessionMetadata` 和 `stripPlanFieldsFromAppConfig` 清理函数
2. **P0（主路径）**：删除 `electron/plan/` 整个目录 → `claudeStreamHandlers.ts` 中的 Plan 分支自然断裂
3. **P1（UI 清理）**：删除渲染进程 Plan 组件 → `pendingPlanStore` → `PendingPlanBanner`
4. **P2（共享逻辑）**：处理 `toolChatLoop.ts` 中残留的 Plan 引用、`planTypes.ts` 剩余 helper
5. **P3（配置清理）**：删除 `planTypes.ts` 中无引用的函数和类型

### 4.2 关键风险缓解

| 风险 | 缓解措施 |
|------|---------|
| `planTypes.ts` 简单删除导致编译错误 | 先添加清理函数，保留文件，逐步删除无引用函数 |
| `toolChatLoop.ts` 中 ACL 逻辑删除影响普通模式 | 确认 `shouldBlockToolInPlanMode` 仅被 `planOrchestrator.ts` 调用 |
| `browserExecutor.ts` 中 Plan 探索期逻辑残留 | 确认 `planToolPhase` 在非 Plan 模式下为 `null` |

---

## 五、总结

本需求文档整体方案可行，但以下三点需要特别注意：

1. **`planTypes.ts` 的删除策略需调整**：不应直接删除文件，应保留清理函数后逐步删除无引用内容
2. **`electron/toolChatLoop.ts` 需要仔细处理**：该文件与 Plan 模块有交叉引用，删除时需分步验证
3. **飞书 `remotePlanKeywords` 字段需同步删除**：需求文档遗漏了该字段的清理

建议在实现前，用 IDE 的 "Find All References" 功能对每个 Plan 相关函数/类型进行全项目扫描，确保无遗漏引用链。
