# 上下文使用量展示器 — 预估占用口径修订

**版本：** 1.1（修订 `context-usage-ring-requirement.md` v1.0 的计算口径）
**日期：** 2026-05-24
**状态：** 已确认（2026-05-24）
**关联文档：**
- `docs/requirement/context-usage-ring-requirement.md`（v1.0 基础 UI / 数据流）
- `electron/anthropicUsageNormalize.ts`（usage 标准化）

---

## 目录

1. [修订动机](#1-修订动机)
2. [目标口径定义](#2-目标口径定义)
3. [计算公式](#3-计算公式)
4. [API 兼容性](#4-api-兼容性)
5. [环形与 Tooltip 规格变更](#5-环形与-tooltip-规格变更)
6. [输出预留修正](#6-输出预留修正)
7. [边界情况与已知误差](#7-边界情况与已知误差)
8. [实现方案](#8-实现方案)
9. [数据流（变更范围）](#9-数据流变更范围)
10. [验收标准](#10-验收标准)
11. [待确认项](#11-待确认项)
12. [相关文件](#12-相关文件)

---

## 1. 修订动机

v1.0 已实现环形 UI 与 Redux 数据流，但**展示数值系统性偏低**，与用户感知的实际上下文占用不符。经代码审查，主要原因如下。

### 1.1 v1.0 缺陷摘要

| # | 问题 | 影响 |
|---|------|------|
| D1 | 环形与汇总行仅使用 `input_tokens`，未合并 Anthropic 缓存字段 | 启用 prompt caching 或兼容网关拆字段时，**严重低估**（例如实际 100K+，显示仅数十 token） |
| D2 | 展示的是「上一轮 API 请求的输入」，不含本轮 assistant 已写入历史的输出 | 每轮对话稳定少算 `output_tokens` 量级 |
| D3 | 输出预留层使用 `config.maxTokens`，而非实际 API 使用的 `resolveEffectiveOutputMaxTokens` | 剩余空间偏大，整体显得「还很空」 |
| D4 | 分母 `maximumContext` 取自模型配置，可能与 API 真实上限不一致 | 占比偏低（例如配置 1M、实际 200K） |

### 1.2 本次修订范围

- **变更**：占用口径、环形比例计算、Tooltip 文案与汇总行、输出预留数据源。
- **不变**：组件位置（composer-footer 发送按钮左侧）、28×28px 三层环结构、Redux `lastUsage` 原始存储、数据更新触发时机（每次 API 成功返回后 dispatch）。
- **非目标**：历史趋势图、接近上限的颜色预警、本地 token 精确计数（tiktoken）、按会话持久化 `lastUsage`（见 [§11 待确认项](#11-待确认项)）。

---

## 2. 目标口径定义

### 2.1 用户心智模型

用户在输入框准备发送**下一条消息**时，关心的是：

> 「如果把当前会话原样再发一次 API，**大概已经占用了多少上下文窗口**？还剩多少空间给新输入 + 模型输出？」

这对应 **「含 assistant 回复、下轮发送前的预估占用」**，而非 v1.0 的「上一轮 API 返回的 `input_tokens`」。

### 2.2 术语

| 术语 | 符号 | 含义 |
|------|------|------|
| 原始 usage | `lastUsage` | Redux 中保留的最近一次 API 响应 usage（不变） |
| 上轮请求输入 | `totalRequestInput` | 单次 API 请求的**完整 prompt token 数**（含缓存读写，见 [§3.1](#31-上轮请求输入-totalrequestinput)） |
| 上轮输出 | `lastOutput` | 最近一次 API 响应的 `output_tokens`（缺省为 0） |
| **预估占用** | `estimatedOccupancy` | 下轮发送前估算的已占用上下文 = `totalRequestInput + lastOutput` |
| 输出预留 | `effectiveOutputMax` | 下一次 API 调用实际使用的 `max_tokens` 上限 |
| 上下文上限 | `maximumContext` | 当前模型 `ModelEntry.maximumContext` |
| 预估剩余 | `estimatedRemaining` | `max(0, maximumContext - estimatedOccupancy - effectiveOutputMax)` |

### 2.3 与 v1.0 的差异

| 项目 | v1.0 | v1.1（本修订） |
|------|------|----------------|
| 环形第一层（已用）分子 | `input_tokens` | `estimatedOccupancy` |
| 环形第二层（预留）分子 | `config.maxTokens` | `effectiveOutputMax` |
| Tooltip 汇总行分子 | `input_tokens` | `estimatedOccupancy` |
| Tooltip 主指标 | 无 | 「预估占用」 |
| 缓存字段 | 仅信息展示 | 仍仅信息展示，但参与 `totalRequestInput` 计算 |

---

## 3. 计算公式

### 3.1 上轮请求输入 `totalRequestInput`

API 供应商对 usage 有两种常见语义，**不可一律相加 cache 字段**。

#### 3.1.1 Anthropic 原生（可加性）

Anthropic 官方定义：

```text
totalRequestInput = input_tokens + cache_read_input_tokens + cache_creation_input_tokens
```

其中 `input_tokens` 仅表示**最后一个 cache breakpoint 之后**的非缓存 token；缓存读写为**附加**计数，非子集。

示例：

| input_tokens | cache_read | cache_create | totalRequestInput |
|-------------:|-----------:|-------------:|------------------:|
| 50 | 100,000 | 0 | 100,050 |
| 2,048 | 1,800 | 248 | 4,096 |

#### 3.1.2 OpenAI 兼容（子集性）

OpenAI 及多数 OpenAI 兼容网关：

```text
prompt_tokens（映射为 input_tokens）= 完整 prompt 总量
cached_tokens（映射为 cache_read_input_tokens）⊆ prompt_tokens
```

此时 **禁止** 再将 cache 加到 `input_tokens` 上，否则会重复计数。

#### 3.1.3 统一判定函数（建议实现）

新增共享函数 `computeTotalRequestInputTokens(usage)`，逻辑如下：

```typescript
function computeTotalRequestInputTokens(usage: LastUsage): number {
  if (!usage) return 0
  const input = usage.input_tokens ?? 0
  const cacheRead = usage.cache_read_input_tokens ?? 0
  const cacheCreate = usage.cache_creation_input_tokens ?? 0
  const cacheSum = cacheRead + cacheCreate

  if (cacheSum <= 0) return input

  // 子集性检测：若 input 已覆盖 cache 合计，视为 OpenAI 兼容总量口径
  if (input >= cacheSum) return input

  // 否则按 Anthropic 加性口径
  return input + cacheSum
}
```

**测试用例（须覆盖）：**

| 场景 | input | cache_read | cache_create | 期望 |
|------|------:|-----------:|-------------:|-----:|
| 无缓存 | 50,000 | 0 | 0 | 50,000 |
| Anthropic 缓存命中 | 50 | 100,000 | 0 | 100,050 |
| Anthropic 缓存写入 | 33 | 0 | 2,017 | 2,050 |
| OpenAI 兼容 | 100,000 | 80,000 | 0 | 100,000 |
| OpenAI 兼容（无 cache 字段） | 100,000 | — | — | 100,000 |

### 3.2 预估占用 `estimatedOccupancy`

```typescript
function computeEstimatedOccupancy(usage: LastUsage): number {
  if (!usage) return 0
  const totalRequestInput = computeTotalRequestInputTokens(usage)
  const lastOutput = usage.output_tokens ?? 0
  return totalRequestInput + lastOutput
}
```

**设计依据：**

1. 上一轮 API 请求结束时，assistant 的回复（文本、tool_use 块等）会追加到会话历史。
2. 用户发送下一条消息时，API 请求体 = 上一轮 prompt + 本轮 assistant 输出（+ 可能的 tool_result，已含在 `totalRequestInput` 的最后一轮输入中）。
3. 因此「下轮发送前」的占用 ≈ 上轮完整输入 + 上轮输出。

**图示：**

```text
  上轮 API 请求                         下轮 API 请求（用户尚未输入新消息）
 ┌─────────────────────┐              ┌──────────────────────────────────┐
 │ system + tools      │              │ system + tools                   │
 │ 历史 messages       │   + output   │ 历史 messages                    │
 │                     │ ──────────►  │ + assistant 回复（刚完成）        │
 │                     │              │                                  │
 └─────────────────────┘              └──────────────────────────────────┘
        ▲                                           ▲
 totalRequestInput                          estimatedOccupancy
                                            (= totalRequestInput + lastOutput)
```

### 3.3 环形三层比例

```typescript
const total = maximumContext
let usedRatio = estimatedOccupancy / total
let reservedRatio = effectiveOutputMax / total

if (usedRatio + reservedRatio > 1) {
  const scale = 1 / (usedRatio + reservedRatio)
  usedRatio *= scale
  reservedRatio *= scale
}

const freeRatio = Math.max(0, 1 - usedRatio - reservedRatio)
```

| 层 | 颜色 | 含义 | 比例 |
|----|------|------|------|
| 外层 | `var(--sa-primary)` | 预估占用 | `usedRatio` |
| 中层 | `#666` | 输出预留 | `reservedRatio` |
| 内层 | `#ddd` | 预估剩余 | `freeRatio` |

汇总行占比：

```text
X% = (estimatedOccupancy / maximumContext) × 100%   // 保留 1 位小数
```

---

## 4. API 兼容性

| 供应商 / 模式 | usage 来源 | totalRequestInput 口径 | estimatedOccupancy |
|---------------|-----------|-------------------------|-------------------|
| Anthropic 直连 | `normalizeAnthropicMessageUsage` | 加性（§3.1.1） | 适用 |
| OpenAI 兼容网关 | `prompt_tokens` → `input_tokens` | 子集检测（§3.1.3） | 适用 |
| 工具模式（多轮 loop） | 最后一轮 `finalMessage().usage` | 同上 | 适用；最后一轮 input 已含 tool_result |
| 普通流式（无工具） | `claude-chat-done.usage` | 同上 | 适用 |
| 无 usage 字段 | — | 无法计算 | 显示无数据状态 |

**说明：** 本修订不修改主进程 usage 采集逻辑，仅在渲染侧（或 shared 模块）做统一换算。

---

## 5. 环形与 Tooltip 规格变更

### 5.1 有数据时的 Tooltip 结构

按以下顺序展示，使用中文标签；数值使用 `toLocaleString('zh-CN')` 千分位。

```text
预估占用　　{estimatedOccupancy}
上轮输入　　{totalRequestInput}
上轮输出　　{lastOutput}                    // lastOutput > 0 时展示；为 0 时可省略
缓存命中　　{cache_read_input_tokens}       // > 0 时展示
缓存写入　　{cache_creation_input_tokens}   // > 0 时展示
输出预留　　{effectiveOutputMax}
─────────
总计 {estimatedOccupancy} / {maximumContext}（{pct}%）
```

**说明：**

- 「预估占用」为环形第一层对应的**主指标**，等于汇总行分子。
- 「上轮输入」「上轮输出」用于解释预估占用的构成，避免用户误以为 API 只返回了 `input_tokens`。
- v1.0 的「输入消耗」标签改为「上轮输入」，语义对齐 `totalRequestInput`；「输出消耗」改为「上轮输出」。
- 「输出预留」为新增行，与环形第二层一致，帮助用户理解剩余空间如何被切分。

### 5.2 无数据状态

与 v1.0 相同：仅浅灰底色环，Tooltip 显示「暂无上下文用量数据」。

触发条件（不变）：

- `lastUsage == null`
- 或 `maximumContext` 缺失 / ≤ 0

### 5.3 流式进行中

**v1.1 行为（与 v1.0 一致）：** 仍展示**上一轮已完成**请求的预估占用；当前流式轮次的 token 不计入，直至 `claude-chat-done` / 工具模式返回后更新。

Tooltip 可选追加一行灰色说明（实现阶段二选一，默认**不加**，见 [§11](#11-待确认项)）：

```text
（当前回复生成中，用量将在完成后更新）
```

---

## 6. 输出预留修正

### 6.1 问题

v1.0 使用 `config.maxTokens`（全局配置，常见值 4096），而实际 API 调用使用：

```typescript
resolveEffectiveOutputMaxTokens(cfg.model, cfg.models, cfg.maxTokens)
// 优先取 ModelEntry.maxTokens，例如 claude-sonnet-4-6 为 64,000
```

二者不一致会导致第二层「输出预留」偏 thin，第三层「剩余」偏 fat。

### 6.2 修正

`ContextUsageRing` 计算预留时使用与 `ChatView.sendInternal` 相同的函数：

```typescript
import { resolveEffectiveOutputMaxTokens } from '@/shared/llm/outputMaxTokens'

const effectiveOutputMax = resolveEffectiveOutputMaxTokens(
  config.model,
  config.models,
  config.maxTokens
)
```

---

## 7. 边界情况与已知误差

### 7.1 已知近似误差

| 场景 | 预估行为 | 误差方向 | 说明 |
|------|----------|----------|------|
| 关闭 thinking，模型仍产生 thinking block | `output_tokens` 含 thinking，但 `stripThinking` 会从下轮输入移除 thinking | **偏高** | 误差通常 ≤ 本轮 thinking token 数；可接受，偏保守 |
| 开启 thinking，thinking 保留在历史 | 下轮输入含 thinking block | 较准确 | — |
| 工具模式同一 invoke 多轮 loop | 使用最后一轮 usage | 较准确 | 最后一轮 input 已含全部 tool_result |
| 用户正在输入未发送的新消息 | 不计入 composer 草稿 | **偏低** | 符合「发送前」口径；草稿长度未知 |
| system prompt / skills 变更 | 仅在上次 API 返回后反映 | 滞后 | 换 skill 或改 system 后需下次请求才更新 |
| `maximumContext` 大于 API 真实上限 | 占比偏低 | **偏低** | 依赖模型配置准确性（见 [§11](#11-待确认项)） |

### 7.2 其他边界

| 情况 | 行为 |
|------|------|
| `estimatedOccupancy + effectiveOutputMax > maximumContext` | 第一层 + 第二层按比例压满整环（与 v1.0 相同） |
| `estimatedOccupancy > maximumContext` | 第一层占满可用比例，内层为 0 |
| 切换会话 | `lastUsage` 重置为 null，环恢复无数据（v1.0 行为，见待确认项） |
| API 失败 | 不更新 `lastUsage`，保留上次预估 |
| 模型切换 | `maximumContext` 与 `effectiveOutputMax` 随新模型立即重算；`lastUsage` 仍为旧模型下数据，直到下次 API 返回 |

---

## 8. 实现方案

### 8.1 方案对比

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| **A（推荐）** | 新增 `src/shared/contextUsageEstimate.ts` 纯函数；`ContextUsageRing` 调用 | 主/渲染可复用；易单测；Redux 仍存原始 usage | 组件内需读 config 算 `effectiveOutputMax` |
| B | 在 `setLastUsage` 时预计算并存 `estimatedOccupancy` | 组件更简单 | 冗余状态；换模型/改 maxTokens 需重算；丢失原始构成 |
| C | 主进程计算后随 usage 下发 | 渲染零逻辑 | 主进程需 config 上下文；IPC 类型变更 |

**推荐方案 A**：计算逻辑放 shared，Redux 继续存 API 原始 usage，展示层按需换算。模型或 maxTokens 变更时环自动正确，无需额外 action。

### 8.2 建议新增模块

**文件：** `src/shared/contextUsageEstimate.ts`

```typescript
import type { LastUsage } from '../renderer/store/chatSlice' // 或抽到 domainTypes

export function computeTotalRequestInputTokens(usage: NonNullable<LastUsage>): number
export function computeEstimatedOccupancy(usage: NonNullable<LastUsage>): number
export function computeContextUsageDisplay(usage: NonNullable<LastUsage>, maximumContext: number, effectiveOutputMax: number): {
  totalRequestInput: number
  lastOutput: number
  estimatedOccupancy: number
  effectiveOutputMax: number
  maximumContext: number
  usedRatio: number
  reservedRatio: number
  freeRatio: number
  percentUsed: number // 0–100, 1 decimal
}
```

> **类型注记：** 若避免 shared 依赖 renderer store，可将 `LastUsage` 类型下沉至 `src/shared/domainTypes.ts` 或 `src/shared/contextUsageTypes.ts`。

### 8.3 改动文件清单

| 文件 | 改动 |
|------|------|
| `src/shared/contextUsageEstimate.ts` | **新建**：计算函数 |
| `src/shared/contextUsageEstimate.test.ts` | **新建**：§3.1.3 全部用例 + 比例压满用例 |
| `src/renderer/components/Chat/ContextUsageRing.tsx` | **修改**：改用新口径与 Tooltip 文案 |
| `src/renderer/components/Chat/ContextUsageRing.test.tsx` | **修改**：断言新 Tooltip 文案与环比例 |
| `docs/requirement/context-usage-ring-requirement.md` | **可选**：文首追加「计算口径见 v1.1」链接 |

**不改动：** `chatSlice`、`ChatView` dispatch 逻辑、`anthropicUsageNormalize.ts`、主进程 IPC。

---

## 9. 数据流（变更范围）

```text
API 响应 (usage)                         ← 不变
    ↓
normalizeAnthropicMessageUsage()         ← 不变
    ↓
dispatch(setLastUsage(usage))            ← 不变，仍存原始字段
    ↓
ContextUsageRing                         ← 变更
  ├─ lastUsage (raw)
  ├─ maximumContext (current model)
  ├─ effectiveOutputMax = resolveEffectiveOutputMaxTokens(...)
  └─ computeContextUsageDisplay(...) → 环 + Tooltip
```

---

## 10. 验收标准

### 10.1 计算正确性

| # | 场景 | 期望 |
|---|------|------|
| T1 | Anthropic：`input=50, cache_read=100000` | 预估占用 = 100050 + output |
| T2 | OpenAI 兼容：`input=100000, cache_read=80000` | totalRequestInput = 100000（非 180000） |
| T3 | 普通对话：`input=80000, output=5000` | 预估占用 = 85000 |
| T4 | 模型 `maxTokens=64000`，全局 `maxTokens=4096` | 输出预留层按 64000 计算 |
| T5 | `estimatedOccupancy + effectiveOutputMax > maximumContext` | 环不外溢，两层压满 |

### 10.2 UI

| # | 期望 |
|---|------|
| U1 | Tooltip 首行显示「预估占用」 |
| U2 | 汇总行分子为 `estimatedOccupancy`，分母为 `maximumContext` |
| U3 | 缓存字段 > 0 时仍展示，但不重复计入汇总（已通过 totalRequestInput 内含） |
| U4 | 无 usage 时行为与 v1.0 一致 |

### 10.3 回归

| # | 期望 |
|---|------|
| R1 | 工具模式 / 流式模式 / Plan worker 完成后环仍正常更新 |
| R2 | 切换会话后重置为无数据 |
| R3 | 模型列表为空时不崩溃 |

---

## 11. 已确认决策（2026-05-24）

| 编号 | 决策 | 选项 |
|------|------|------|
| Q1 | `maximumContext` 数据源 | **A** — 维持 `ModelEntry.maximumContext`，与设置页一致 |
| Q2 | 切换会话后 usage 处理 | **A** — 切换会话清空 `lastUsage`，直至该会话再次 API 返回 |
| Q3 | 流式进行中 Tooltip | **A** — 不追加「生成中」说明，保持简洁 |
| Q4 | 汇总行是否展示预估剩余 | **A** — 仅展示「已用 / 上限（占比）」，剩余由内层灰环表达 |

---

## 12. 相关文件

| 路径 | 关系 |
|------|------|
| `docs/requirement/context-usage-ring-requirement.md` | v1.0 基础需求（UI 布局、数据流） |
| `src/renderer/components/Chat/ContextUsageRing.tsx` | 展示组件（主要改动） |
| `src/renderer/store/chatSlice.ts` | `LastUsage` 类型定义 |
| `electron/anthropicUsageNormalize.ts` | usage 字段标准化（只读参考） |
| `src/shared/llm/outputMaxTokens.ts` | `resolveEffectiveOutputMaxTokens` |
| `electron/toolChatLoop.ts` | `stripThinking`、工具 loop 最后一轮 usage |
| `src/shared/claudeToolHistory.ts` | 历史消息如何拼入下轮 API |

---

**文档修订记录：**

| 版本 | 日期 | 变更说明 |
|------|------|----------|
| 1.1 | 2026-05-24 | 新增「预估占用」口径；修正缓存加总、输出预留与 Tooltip 规格 |
| 1.1.1 | 2026-05-24 | Q1–Q4 全部确认选项 A；进入实现 |
