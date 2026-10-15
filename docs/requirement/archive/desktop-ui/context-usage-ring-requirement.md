# 上下文使用量展示器 — 需求规格

**版本：** 1.0
**日期：** 2026-05-24
**状态：** 待评审

---

## 目录

1. [概述](#1-概述)
2. [现状分析](#2-现状分析)
3. [功能需求](#3-功能需求)
4. [数据流设计](#4-数据流设计)
5. [组件规格](#5-组件规格)
6. [交互规格](#6-交互规格)
7. [验收标准](#7-验收标准)
8. [相关文件](#8-相关文件)

---

## 1. 概述

### 1.1 功能定位

「上下文使用量展示器」位于消息输入区域（composer-footer）的发送按钮左侧，以紧凑的三层环形图展示当前会话的上下文用量。用户在发送下一条消息前即可直观评估上下文窗口剩余空间，帮助判断是否需要精简历史或切换更大窗口的模型。

### 1.2 目标

| # | 目标 |
|---|------|
| G1 | 在输入区域提供上下文用量一目了然的可视化指示 |
| G2 | 区分输入消耗、输出预留和剩余空间三个维度 |
| G3 | hover 时以中文标签展示 API 返回的用量明细 |
| G4 | 数据以最新一次大模型返回的 usage 为准，每次返回自动更新 |

### 1.3 非目标

- 不提供历史用量趋势图
- 不支持手动输入/调整数值
- 不对接近用满状态做颜色预警（保持单一主题色）

---

## 2. 现状分析

### 2.1 可用数据

API 每次返回携带 `usage` 对象，经 `electron/anthropicUsageNormalize.ts` 标准化后包含：

| 字段 | 含义 | 本次使用 |
|------|------|----------|
| `input_tokens` | 输入消耗 token 数 | 环形第一层 |
| `output_tokens` | 输出消耗 token 数 | 信息展示 |
| `cache_read_input_tokens` | 缓存命中节省的输入 token | 信息展示 |
| `cache_creation_input_tokens` | 本次写入缓存的 token | 信息展示 |

### 2.2 数据传递现状

| 模式 | 现状 | 需要改动 |
|------|------|----------|
| 工具模式（`claudeChatCreateWithTools`） | usage 已包含在返回值中 | 将 usage dispatch 到 Redux |
| 普通流式模式（`claudeChatSendStream`） | `claude-chat-done` 事件仅发送 `{ requestId }`，usage 数据被丢弃 | 扩展 `claude-chat-done` 事件携带 usage |

### 2.3 模型上下文窗口

当前模型 `maximumContext` 存储在 `AppConfig.models[i].maximumContext`（`ModelEntry` 类型），在设置页的模型列表中有显示。

---

## 3. 功能需求

### 3.1 环形可视化

#### 3.1.1 整环含义

整环（360°）代表当前模型的**上下文窗口总大小**：`ModelEntry.maximumContext`。

#### 3.1.2 三层结构

环由外到内分为三层，使用 SVG `<circle>` + `stroke-dasharray` 实现：

| 层 | 颜色 | 含义 | 计算公式 |
|----|------|------|----------|
| 第一层（亮色/已用） | `var(--sa-primary)` | 输入消耗 | `input_tokens / maximumContext` |
| 第二层（深灰/预留） | `#666` | 输出预留 | `maxTokens / maximumContext` |
| 第三层（浅灰/剩余） | `#ddd` | 剩余空间 | `1 - (input_tokens + maxTokens) / maximumContext` |

三层线宽从外到内递减，形成嵌套环形效果。

#### 3.1.3 尺寸

- 整体尺寸：**28×28px**，与发送按钮（`.composer-send`）一致
- 环形线宽：外层较粗、中层适中、内层较细（具体数值开发阶段确定）
- 环形圆心：组件中心点

#### 3.1.4 边界情况

| 情况 | 行为 |
|------|------|
| 无 usage 数据（会话刚开始、未发送过消息） | 仅显示浅灰底色环，三层均不填充 |
| `input_tokens + maxTokens > maximumContext` | 第一层 + 第二层占满整环（100%），不溢出 |
| 切换会话 | 重置为无数据状态，直到新会话首次 API 返回 |

### 3.2 位置

环放置在 `composer-footer` 内，**紧挨在发送按钮左侧**，与发送按钮同行对齐：

```
┌──────────────────────────────────────────────────┐
│ [模式选择] [模型标签] [提示文字]    [环形] [发送] │
└──────────────────────────────────────────────────┘
```

### 3.3 Hover 信息展示

#### 3.3.1 触发方式

鼠标悬停在环形组件上时，通过 Ant Design Tooltip 展示用量明细。

#### 3.3.2 展示内容

使用中文标签，不直接显示 API 字段名：

| 标签 | 对应字段 | 示例 |
|------|----------|------|
| 输入消耗 | `input_tokens` | 12,345 |
| 输出消耗 | `output_tokens` | 4,567 |
| 缓存命中 | `cache_read_input_tokens` | 2,000 |
| 缓存写入 | `cache_creation_input_tokens` | 1,500 |

底部汇总行：**总计 N / M（占比 X%）**，其中：
- N = `input_tokens`
- M = 当前模型 `maximumContext`
- X% = N / M × 100%，保留 1 位小数

缓存相关字段仅在值 > 0 时展示。

#### 3.3.3 无数据状态

当无 usage 数据时，hover 显示 "暂无上下文用量数据"。

### 3.4 数据更新规则

- 每次大模型返回（`claudeChatCreateWithTools` 成功 / `claude-chat-done` 事件），取最新的 `usage` 更新 Redux
- 不累积、不历史记录，仅保留最近一次
- 切换会话时自动重置

---

## 4. 数据流设计

### 4.1 整体架构

```
API 响应 (usage)
    ↓
主进程：normalizeAnthropicMessageUsage()
    ↓
工具模式：返回值携带 usage → ChatView.sendInternal()
流式模式：claude-chat-done 事件扩展携带 usage → ChatView.onDone
    ↓
dispatch(setLastUsage(usage))  →  Redux chatSlice.lastUsage
    ↓
ContextUsageRing 组件：
  - useTypedSelector → chatSlice.lastUsage
  - useTypedSelector → configSlice.config.models (取当前模型 maximumContext)
  - useTypedSelector → configSlice.config.maxTokens
    ↓
渲染三层环形图
```

### 4.2 Redux 状态扩展

在 `chatSlice` 中新增 `lastUsage` 字段（与 `runningSessions` 同级）：

```typescript
interface ChatState {
  // ... 现有字段
  lastUsage: {
    input_tokens: number
    output_tokens?: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  } | null
}
```

Action：`setLastUsage(usage)` — 设置最新用量数据；传入 `null` 表示重置。

### 4.3 各模式改动点

#### 4.3.1 工具模式

`ChatView.sendInternal` 中，`createWithTools` 成功返回后：

```typescript
const res = await window.api.claudeChatCreateWithTools(payload)
if (res.ok && res.usage) {
  dispatch(setLastUsage(res.usage))
}
```

#### 4.3.2 Plan 模式（子 Worker）

`ChatView.runPlanWorkerWithoutNewUser` 中同样在成功分支 dispatch usage。

#### 4.3.3 普通流式模式

需改三处：

1. **`electron/claudeStreamHandlers.ts`** — `runSendStream` 中 `claude-chat-done` 事件追加 `usage`：
   ```typescript
   sender.send('claude-chat-done', { requestId, usage: usage ?? null })
   ```

2. **`electron/preload.ts`** — 更新监听器类型（自动推导，无需改动）。

3. **`src/shared/api.ts`** — `claudeChatOnDone` 回调类型：
   ```typescript
   claudeChatOnDone: (cb: (data: { requestId: string; usage?: unknown }) => void) => () => void
   ```

4. **`ChatView.sendInternal`** 中 `onDone` 回调 — 取 `data.usage` dispatch 到 Redux。

#### 4.3.4 会话切换重置

当 `sessionId` 变化或新会话创建时，dispatch `setLastUsage(null)`。

---

## 5. 组件规格

### 5.1 ContextUsageRing

| 项目 | 说明 |
|------|------|
| 文件路径 | `src/renderer/components/Chat/ContextUsageRing.tsx` |
| 类型 | 无 props，数据全部从 Redux 读取的函数组件 |
| 依赖 | `useTypedSelector`（读 `chatSlice.lastUsage`、`configSlice`）、Ant Design `Tooltip` |

### 5.2 渲染逻辑

```
没有 usage 数据？
  ├─ 是 → 仅渲染浅灰底色环 + "暂无上下文用量数据" tooltip
  └─ 否 → 计算三层比例
          ├─ 第一层（亮色）：input_tokens / maximumContext
          ├─ 第二层（深灰）：maxTokens / maximumContext
          └─ 第三层（浅灰）：剩余比例
          ↓
        渲染三层 SVG circle + 构建中文 tooltip 内容
```

### 5.3 使用位置

`MessageInput` 的 `composer-footer` 中，在发送按钮左侧插入：

```tsx
<div className="composer-footer">
  <div style={{ ... }}>
    {/* 现有左侧内容：模式选择、模型标签、提示文字 */}
  </div>
  <ContextUsageRing />
  <button className="composer-send" ... />
</div>
```

### 5.4 样式

- 组件外层容器与发送按钮同行，`display: inline-flex; align-items: center`
- 环形 SVG 尺寸 28×28px
- 与发送按钮间距约 8px（通过 `gap` 或 `margin` 控制）

---

## 6. 交互规格

### 6.1 更新时机

| 事件 | 行为 |
|------|------|
| 工具模式请求成功返回 | dispatch `setLastUsage(res.usage)`，环更新 |
| 普通流式请求 `claude-chat-done` | 从事件取 usage，dispatch 更新 |
| Plan worker 请求成功返回 | 同上 |
| 切换会话 | dispatch `setLastUsage(null)`，重置为无数据状态 |
| 请求失败 | 不更新 usage（保留上次数据） |

### 6.2 Tooltip 交互

| 阶段 | 行为 |
|------|------|
| hover 环形 | 展示用量明细 tooltip |
| 数据齐全时 | 显示输入消耗、输出消耗、缓存命中（如有）、缓存写入（如有），底部汇总行 |
| 无数据时 | 显示 "暂无上下文用量数据" |

### 6.3 百分比保护

当 `input_tokens + maxTokens > maximumContext` 时：
- 第一层（亮色）显示：`input_tokens / (input_tokens + maxTokens)` × 可用占比
- 第二层（深灰）显示：`maxTokens / (input_tokens + maxTokens)` × 可用占比
- 两层合计占满整环，第三层（浅灰）不显示

---

## 7. 验收标准

### 7.1 功能验收

| 功能 | 验收条件 |
|------|----------|
| 环形展示 | 发送按钮左侧出现 28×28px 三层环形图 |
| 数据驱动 | 首次发送消息并收到回复后，环更新为最新 usage 数据 |
| 三层区分 | 亮色→已用输入、深灰→输出预留、浅灰→剩余空间，三层可清晰区分 |
| 工具模式 | 工具模式下的请求完成后环正确更新 |
| 普通流式模式 | 普通流式模式下的请求完成后环正确更新 |
| Plan 模式 | Plan worker 请求完成后环正确更新 |
| 无数据状态 | 新会话/未发送消息时环仅显示浅灰底色 |
| 切换会话重置 | 切换会话后环重置为无数据状态 |
| Hover tooltip | 鼠标悬停展示中文用量明细和汇总行 |
| 缓存字段显示 | cache_read/cache_creation > 0 时才在 tooltip 中显示对应行 |
| 边界保护 | input_tokens + maxTokens 超过 maximumContext 不外溢 |

### 7.2 视觉验收

| 项目 | 标准 |
|------|------|
| 尺寸 | 28×28px，与发送按钮高度对齐 |
| 配色 | 亮色 = `var(--sa-primary)`，深灰 = `#666`，浅灰 = `#ddd` |
| 与发送按钮间距 | 约 8px，视觉舒适 |
| 浅色/深色主题 | 亮色随主题变量变化，深灰和浅灰不随主题变化 |

### 7.3 兼容性

| 项目 | 标准 |
|------|------|
| 模型切换 | 切换到不同 `maximumContext` 的模型后，分母自动更新 |
| 零模型 | 模型列表为空时，环仅显示浅灰底色（不崩溃） |

---

## 8. 相关文件

| 文件路径 | 改动说明 |
|----------|----------|
| `src/renderer/components/Chat/ContextUsageRing.tsx` | **新建**：环形组件，从 Redux 读数据，渲染 SVG 环 + Tooltip |
| `src/renderer/components/Chat/MessageInput.tsx` | **修改**：在发送按钮左侧嵌入 `ContextUsageRing` |
| `src/renderer/store/chatSlice.ts` | **修改**：新增 `lastUsage` 状态和 `setLastUsage` action |
| `src/renderer/components/Chat/ChatView.tsx` | **修改**：在 API 返回处 dispatch `setLastUsage`；会话切换时重置 |
| `electron/claudeStreamHandlers.ts` | **修改**：`claude-chat-done` 事件追加 `usage` 字段 |
| `src/shared/api.ts` | **修改**：`claudeChatOnDone` 回调类型追加 `usage` |
| `electron/preload.ts` | **可能修改**：如类型推导不足需微调（通常无需改动） |
| `src/shared/domainTypes.ts` | **参考**：`ModelEntry.maximumContext`、`AppConfig.maxTokens` |
| `electron/anthropicUsageNormalize.ts` | **参考**：usage 标准化逻辑 |

---

**文档修订记录：**

| 版本 | 日期 | 变更说明 |
|------|------|----------|
| 1.0 | 2026-05-24 | 初始版本 |