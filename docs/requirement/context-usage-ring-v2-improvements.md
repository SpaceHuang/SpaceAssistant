# 上下文使用量展示器 — 问题修复与改进需求

**版本：** 2.0
**日期：** 2026-06-07
**状态：** 已确认
**关联文档：**

- `docs/requirement/context-usage-ring-requirement.md`（v1.0 基础需求）
- `docs/requirement/context-usage-estimated-occupancy-requirement.md`（v1.1 预估占用口径修订）

---

## 目录

1. [概述](#1-概述)
2. [问题清单](#2-问题清单)
3. [改进需求](#3-改进需求)
4. [数据持久化方案](#4-数据持久化方案)
5. [实现方案](#5-实现方案)
6. [改动文件清单](#6-改动文件清单)
7. [验收标准](#7-验收标准)
8. [非目标](#8-非目标)
9. [已确认决策](#9-已确认决策)

---

## 1. 概述

### 1.1 背景

v1.0 实现了上下文使用量展示器的环形 UI 与 Redux 数据流，v1.1 修正了预估占用计算口径。但上线后用户反馈两个核心痛点：

1. **频繁显示"无法获取上下文，没有数据"**——切换会话、重启应用后环变灰，体验差
2. **随着对话推进，上下文占用数据基本不更新**——部分场景下 usage 数据丢失或计算有误，环长期显示旧值或不更新

经代码审查，定位到 6 个需要修复的问题。

### 1.2 变更范围

| 类别 | 说明 |
|------|------|
| **变更** | `lastUsage` 按会话持久化到数据库、缓存 token 启发式修复、工具模式 usage 兜底、Tooltip 国际化 |
| **不变** | 组件位置、28×28px 三层环结构、预估占用计算口径、Redux `lastUsage` 原始存储结构、数据更新触发时机 |

---

## 2. 问题清单

### 2.1 问题总览

| 编号 | 类别 | 问题 | 严重程度 | 状态 |
|------|------|------|----------|------|
| P1 | 🔴 无数据 | 切换会话后 `lastUsage` 立即清空，用户必须重发消息才能看到环 | 高 | 待修复 |
| P2 | 🔴 无数据 | 重启应用后所有 `lastUsage` 丢失 | 高 | 待修复 |
| P3 | 🔴 不更新 | 缓存 token 启发式判断有 bug，Anthropic 场景下可能少算 | 高 | 待修复 |
| P4 | 🟡 不更新 | 工具模式多轮 loop，最后一轮若无 usage 则整个调用链 usage 丢失 | 中 | 待修复 |
| P5 | 🟡 无数据 | 部分 API provider 的 usage 响应格式未被 `normalizeAnthropicMessageUsage` 覆盖 | 中 | 待修复 |
| P6 | 🟢 体验 | Tooltip 文案硬编码中文，未使用 `t()` 国际化 | 低 | 待修复 |

### 2.2 P1 — 切换会话后无数据

**根因：** `chatSlice.setSession` action 将 `lastUsage` 重置为 `null`。

```typescript
// src/renderer/store/chatSlice.ts:50-55
setSession(state, action: PayloadAction<string | null>) {
  state.currentSessionId = action.payload
  state.lastUsage = null  // ← 问题所在
}
```

**影响：** 用户在会话 A 中已有 80% 的上下文占用数据，切换到会话 B 再切回会话 A，环显示"暂无上下文用量数据"，必须重新发送消息等待 API 返回。

**数据流现状：**

```text
会话 A（已对话 10 轮） → 切换到会话 B → 切换回会话 A
  lastUsage = {...}        lastUsage = null      lastUsage = null（丢失！）
```

### 2.3 P2 — 重启后数据丢失

**根因：** `lastUsage` 仅存在于 Redux 内存中，未持久化到数据库。

**影响：** 重启应用后，所有会话的上下文占用数据全部丢失，用户无法一眼判断各会话的上下文使用情况。

### 2.4 P3 — 缓存 token 启发式 bug

**根因：** `computeTotalRequestInputTokens` 的供应商判断逻辑过于简单。

```typescript
// src/shared/contextUsageEstimate.ts
if (input >= cacheSum) return input  // 仅凭大小关系判断
```

当 Anthropic 场景下非缓存 token 数 ≥ 缓存 token 数时（例如 80000 新 token + 20000 缓存命中），`input_tokens(80000) >= cacheSum(20000)` 为 true，错误走 OpenAI 子集路径，**少算 20000 token**。

**触发条件：** Anthropic API + 新输入 token 数 ≥ 缓存命中 token 数。在实际使用中，随着对话轮次增加，新输入比例逐渐上升，此 bug 会间歇性触发。

**修复方案：** 保留启发式，增加保护条件——当 `cache_read_input_tokens > input_tokens * 0.5` 时，缓存命中占比极高，几乎可确定是 Anthropic 加性模式，强制走加性路径。

```typescript
function computeTotalRequestInputTokens(usage: LastUsage): number {
  if (!usage) return 0
  const input = usage.input_tokens ?? 0
  const cacheRead = usage.cache_read_input_tokens ?? 0
  const cacheCreate = usage.cache_creation_input_tokens ?? 0
  const cacheSum = cacheRead + cacheCreate

  if (cacheSum <= 0) return input

  // 子集性检测：若 input 已覆盖 cache 合计，视为 OpenAI 兼容总量口径
  if (input >= cacheSum) {
    // 保护条件：缓存占比超过 50%，几乎可确定是 Anthropic 加性模式
    if (cacheRead > input * 0.5) {
      return input + cacheSum
    }
    return input
  }

  // Anthropic 加性口径
  return input + cacheSum
}
```

### 2.5 P4 — 工具模式多轮 loop usage 丢失

**根因：** `toolChatLoop.ts` 仅在循环终止时（`toolUses.length === 0`）返回 usage，中间轮次的 usage 被丢弃。

```typescript
// electron/toolChatLoop.ts:564-565
if (toolUses.length === 0) {
  return { ok: true, content, stopReason: stopReason ?? 'end_turn', ...(usage && { usage }) }
}
```

若最后一轮因网络抖动导致 `usage` 为 `undefined`，而前几轮有正常的 usage 数据，整个调用链的 usage 丢失。

**修复方案：** 在循环中持续记录最近一个有效的 usage，最终返回时优先用最后一轮，若最后一轮无数据则回退到最近有效轮次。

```typescript
let lastValidUsage: ReturnType<typeof normalizeAnthropicMessageUsage> | undefined

// 在每轮 loop 结束后：
const usage = normalizeAnthropicMessageUsage(res)
if (usage) {
  lastValidUsage = usage
}

// 最终返回：
return { ok: true, content, stopReason: stopReason ?? 'end_turn', ...(lastValidUsage && { usage: lastValidUsage }) }
```

### 2.6 P5 — 部分 API provider usage 未被覆盖

**根因：** `normalizeAnthropicMessageUsage` 对非标 usage 格式可能返回 `undefined`。

当前 `pickInputTokensFromUsageObject` 按优先级尝试 `input_tokens → prompt_tokens → input → prompt`，但部分 OpenAI 兼容网关可能使用 `total_tokens` 或其他变体字段。

**修复方案：** 在 `pickInputTokensFromUsageObject` 中追加 `total_tokens` 作为兜底字段。此改动风险低——即使 `total_tokens` 包含输出 token，也比返回 `undefined`（完全无数据）更准确。

### 2.7 P6 — Tooltip 硬编码中文

**根因：** `ContextUsageRing.tsx` 的 tooltip 文案直接写死中文字符串，未使用项目 `t()` 国际化函数。

**修复方案：** 新增 `contextUsage` 翻译命名空间，将 Tooltip 文案迁移到 `t()` 调用。翻译 key 命名遵循项目规范 `contextUsage.tooltip.*`。

---

## 3. 改进需求

### 3.1 R1 — 按会话持久化 `lastUsage`

**目标：** 切换会话时自动恢复该会话最近一次 API 返回的 usage，重启后仍然可用。

**方案：** 数据库顶层新增 `sessionUsages: Record<string, LastUsage>` 键。

**数据流：**

```text
数据库 JSON 结构：
{
  "sessions": [...],
  "messages": {...},
  "config": {...},
  "secrets": {...},
  "sessionUsages": {          ← 新增
    "session-id-1": {
      "input_tokens": 50000,
      "output_tokens": 3000,
      "cache_read_input_tokens": 100000
    },
    "session-id-2": { ... }
  }
}
```

**行为规格：**

| 场景 | v1.1（现状） | v2.0（目标） |
|------|-------------|-------------|
| 切换会话 A → B | `lastUsage = null` | 读取 `sessionUsages[sessionB.id]`，有则展示 |
| 切回会话 A | `lastUsage = null` | 读取 `sessionUsages[sessionA.id]`，恢复之前的值 |
| API 返回后 | dispatch `setLastUsage` → 仅 Redux | dispatch → Redux + 异步写入 `sessionUsages` |
| 重启应用 | 所有数据丢失 | 从数据库恢复当前会话的 `lastUsage` |
| 会话被删除 | — | 同步清理 `sessionUsages[sessionId]` |

### 3.2 R2 — 缓存 token 启发式修复

见 [§2.4 P3](#24-p3--缓存-token-启发式-bug)。

### 3.3 R3 — 工具模式 usage 兜底

见 [§2.5 P4](#25-p4--工具模式多轮-loop-usage-丢失)。

### 3.4 R4 — usage 标准化增强

见 [§2.6 P5](#26-p5--部分-api-provider-usage-未被覆盖)。

### 3.5 R5 — Tooltip 国际化

见 [§2.7 P6](#27-p6--tooltip-硬编码中文)。

**翻译 key 设计：**

```json
// src/renderer/i18n/resources/zh-CN/contextUsage.json
{
  "tooltip": {
    "noData": "暂无上下文用量数据",
    "estimatedOccupancy": "预估占用",
    "lastRequestInput": "上轮输入",
    "lastOutput": "上轮输出",
    "cacheRead": "缓存命中",
    "cacheWrite": "缓存写入",
    "outputReserve": "输出预留",
    "separator": "─────────",
    "total": "总计",
    "legend": "图例",
    "legendUsed": "已用",
    "legendReserved": "输出预留",
    "legendFree": "剩余"
  },
  "aria": {
    "noData": "暂无上下文用量数据",
    "hasData": "上下文用量约 {percent}%"
  }
}
```

---

## 4. 数据持久化方案

### 4.1 方案选择

采用**方案 B：独立 key-value 存储**。数据库顶层新增 `sessionUsages: Record<string, LastUsage>` 键，与 Session 对象解耦。

**选择理由：**

1. **职责清晰**——`lastUsage` 是运行时衍生数据，不是会话属性。放在 Session 上污染领域模型
2. **更新独立**——usage 更新频繁，不需要走 Session 的完整读写路径
3. **实现简单**——不需要改 `Session` 类型和 CRUD 逻辑
4. **易清理**——删除会话时同步删除对应 key，无残留

### 4.2 数据库接口

在 `electron/database.ts` 中新增：

```typescript
// 读取
getSessionUsage(sessionId: string): LastUsage | undefined

// 写入（创建或更新）
setSessionUsage(sessionId: string, usage: LastUsage): void

// 删除（会话删除时调用）
deleteSessionUsage(sessionId: string): void

// 批量获取（启动时恢复）
getAllSessionUsages(): Record<string, LastUsage>
```

### 4.3 IPC 通道

新增以下 IPC 通道（仅在应用启动和切换会话时使用）：

| 通道 | 方向 | 用途 |
|------|------|------|
| `usage:set` | 渲染 → 主进程 | API 返回后持久化 usage |
| `usage:get` | 渲染 → 主进程 | 切换会话时获取 |
| `usage:delete` | 渲染 → 主进程 | 删除会话时清理 |

> **设计决策：** 切换会话时从数据库读取 usage 并 dispatch 到 Redux，而非在 `ContextUsageRing` 中直接读数据库。保持 Redux 为单一数据源。

### 4.4 数据流更新

```text
API 响应 (usage)
    ↓
normalizeAnthropicMessageUsage()
    ↓
dispatch(setLastUsage({ sessionId, usage }))        ← 变更：携带 sessionId
    ↓
Redux chatSlice.lastUsage 更新
    ↓
window.api.usageSet({ sessionId, usage })            ← 新增：异步持久化
    ↓
ContextUsageRing 读取 chat.lastUsage（不变）

应用启动 / 切换会话
    ↓
window.api.usageGet(sessionId)                       ← 新增：从 DB 读取
    ↓
dispatch(setLastUsage({ sessionId, usage }))         ← 恢复到 Redux
    ↓
ContextUsageRing 展示
```

---

## 5. 实现方案

### 5.1 Redux 层

`chatSlice.lastUsage` 类型保持不变（`LastUsage | null`），但 `setLastUsage` action 增加 `sessionId` 参数用于持久化。

```typescript
// 修改后的 action
setLastUsage(state, action: PayloadAction<{ sessionId: string; usage: LastUsage }>) {
  state.lastUsage = action.payload.usage
}

// 新增 action（从 DB 恢复时使用，不触发持久化）
restoreLastUsage(state, action: PayloadAction<LastUsage | null>) {
  state.lastUsage = action.payload
}
```

`setSession` 不再清空 `lastUsage`，改为异步读取 DB：

```typescript
setSession(state, action: PayloadAction<string | null>) {
  state.currentSessionId = action.payload
  // 不再 state.lastUsage = null
  // 由调用方异步读取 DB 后 dispatch restoreLastUsage
}
```

### 5.2 渲染进程

`ChatView` 中 `sendInternal` 的 dispatch 点增加持久化调用：

```typescript
// 工具模式成功
if (res.usage) {
  const usage = res.usage as LastUsage
  dispatch(setLastUsage({ sessionId: runSessionId, usage }))
  window.api.usageSet({ sessionId: runSessionId, usage }).catch(() => {})
}

// 流式模式 onDone
if (data?.usage) {
  const usage = data.usage as LastUsage
  dispatch(setLastUsage({ sessionId: runSessionId, usage }))
  window.api.usageSet({ sessionId: runSessionId, usage }).catch(() => {})
}
```

会话切换时恢复 usage（在 `ChatView` 或 session 管理 hook 中）：

```typescript
// 切换会话时
const handleSessionSwitch = async (newSessionId: string) => {
  dispatch(setSession(newSessionId))
  const cached = await window.api.usageGet(newSessionId)
  dispatch(restoreLastUsage(cached ?? null))
}
```

### 5.3 计算层

`src/shared/contextUsageEstimate.ts` 中 `computeTotalRequestInputTokens` 增加保护条件（见 §2.4）。

### 5.4 主进程

`electron/toolChatLoop.ts` 中增加 `lastValidUsage` 追踪（见 §2.5）。

`electron/anthropicUsageNormalize.ts` 中 `pickInputTokensFromUsageObject` 追加 `total_tokens` 兜底字段。

### 5.5 i18n

新建 `src/renderer/i18n/resources/zh-CN/contextUsage.json`，并在 `en/` 下建立对应的英文翻译。

`ContextUsageRing.tsx` 中所有硬编码中文替换为 `t('contextUsage.tooltip.*')` 调用。

---

## 6. 改动文件清单

| 文件 | 改动 |
|------|------|
| `electron/database.ts` | **修改**：新增 `sessionUsages` 读写接口 |
| `electron/appIpc.ts` | **修改**：注册 `usage:set/get/delete` IPC handler |
| `electron/preload.ts` | **修改**：暴露 `usageSet/usageGet/usageDelete` API |
| `src/shared/api.ts` | **修改**：新增 usage 持久化 API 类型 |
| `electron/toolChatLoop.ts` | **修改**：追踪 `lastValidUsage`，最终返回时兜底 |
| `electron/anthropicUsageNormalize.ts` | **修改**：`pickInputTokensFromUsageObject` 追加 `total_tokens` 兜底 |
| `src/shared/contextUsageEstimate.ts` | **修改**：`computeTotalRequestInputTokens` 增加保护条件 |
| `src/shared/contextUsageEstimate.test.ts` | **修改**：新增保护条件测试用例 |
| `src/renderer/store/chatSlice.ts` | **修改**：`setLastUsage` 携带 `sessionId`；`setSession` 不清空 `lastUsage`；新增 `restoreLastUsage` |
| `src/renderer/store/chatSlice.test.ts` | **修改**：更新测试用例 |
| `src/renderer/components/Chat/ChatView.tsx` | **修改**：dispatch 时携带 `sessionId` + 调用 `usageSet`；会话切换时恢复 usage |
| `src/renderer/components/Chat/ContextUsageRing.tsx` | **修改**：Tooltip 文案改用 `t()` |
| `src/renderer/components/Chat/ContextUsageRing.test.tsx` | **修改**：更新测试用例适配 i18n |
| `src/renderer/i18n/resources/zh-CN/contextUsage.json` | **新建**：中文翻译 |
| `src/renderer/i18n/resources/en/contextUsage.json` | **新建**：英文翻译 |
| `src/renderer/i18n/resources/zh-CN/index.ts` | **修改**：导入 contextUsage 命名空间 |
| `src/renderer/i18n/resources/en/index.ts` | **修改**：导入 contextUsage 命名空间 |

---

## 7. 验收标准

### 7.1 功能验收

| # | 场景 | 期望 |
|---|------|------|
| T1 | 会话 A 中 API 返回 usage 后切换到会话 B，再切回 A | 会话 A 的环立即恢复为之前的值，无需重新发送消息 |
| T2 | 重启应用后打开已有对话的会话 | 环显示该会话最后一次 API 返回的 usage（若存在） |
| T3 | 删除会话 | 对应的 `sessionUsages` 条目同步清理 |
| T4 | Anthropic 场景：新 token 80000，缓存命中 20000 | `totalRequestInput = 100000`（非 80000） |
| T5 | 工具模式：第 1 轮有 usage，第 2 轮（最终轮）usage 为 undefined | 最终返回第 1 轮的 usage |
| T6 | OpenAI 兼容网关返回 `total_tokens` 但无 `input_tokens` | 环能正常展示（使用 `total_tokens` 兜底） |
| T7 | Tooltip hover | 显示中文/英文标签（跟随语言设置），无硬编码文案 |

### 7.2 回归验证

| # | 场景 | 期望 |
|---|------|------|
| R1 | 工具模式 / 流式模式完成后环正常更新 | 行为与 v1.1 一致 |
| R2 | 新会话（从未发过消息） | 环显示"暂无上下文用量数据" |
| R3 | 预估占用 + 输出预留超过上下文上限 | 环不外溢，两层压满 |
| R4 | 模型列表为空 | 不崩溃 |

---

## 8. 非目标

以下内容**不在本需求范围内**：

- ❌ 历史趋势图 / 变化曲线
- ❌ 接近上限的颜色预警
- ❌ 本地 token 精确计数（tiktoken）
- ❌ 流式进行中的实时 token 估算
- ❌ 跨会话的用量对比
- ❌ 按会话导出/导入 usage 数据

---

## 9. 已确认决策

| 编号 | 决策点 | 选择 |
|------|--------|------|
| D1 | P3 缓存 token 启发式修复方式 | **C** — 保留启发式 + 保护阈值（`cacheRead > input * 0.5` 强制加性） |
| D2 | P1/P2 数据持久化范围 | **A** — 按会话持久化 |
| D3 | 持久化存储方案 | **B** — 数据库顶层独立 `sessionUsages` 字典 |
| D4 | P4 工具模式 usage 兜底 | **A** — 保留最后一轮，异常时回退到最近有效轮次 |
| D5 | 模型切换后 usage 处理 | **无需处理** — 旧 usage 仍是合理近似，仅分母变化是正确的行为 |
| D6 | 流式进行中是否需要实时更新 | **不需要** — 核心诉求是更新可靠性而非实时性 |

---

**文档修订记录：**

| 版本 | 日期 | 变更说明 |
|------|------|----------|
| 2.0 | 2026-06-07 | 初始版本：问题梳理 + 6 项改进需求 + 持久化方案 |

