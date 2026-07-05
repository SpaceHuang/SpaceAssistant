# 工具调用 ID 配对防幻觉机制 — 产品需求文档

**版本：** 1.0  
**日期：** 2026-07-03  
**状态：** 待评审  
**关联文档：**
- [tool-use-id-pairing-analysis.md](../references/tool-use-id-pairing-analysis.md)（Claude Code `ensureToolResultPairing` 机制分析，本需求的理论参考）
- [tools-requirement.md](./tools-requirement.md)（工具体系基础需求）
- [shell-security-enhancement-requirement.md](./shell-security-enhancement-requirement.md)（安全防护层，与本机制共同构成防幻觉体系）

---

## 目录

1. [概述](#1-概述)
2. [参考机制与本项目的架构差异](#2-参考机制与本项目的架构差异)
3. [现状评估](#3-现状评估)
4. [风险缺口分析](#4-风险缺口分析)
5. [目标与非目标](#5-目标与非目标)
6. [用户故事](#6-用户故事)
7. [改进方案设计](#7-改进方案设计)
8. [数据模型变更](#8-数据模型变更)
9. [实现要点](#9-实现要点)
10. [测试计划](#10-测试计划)
11. [验收标准](#11-验收标准)
12. [相关文件](#12-相关文件)
13. [附录：典型修复场景](#13-附录典型修复场景)

---

## 1. 概述

### 1.1 背景

SpaceAssistant 通过工具循环（`claude-chat-create-with-tools`）让大模型调用 `read_file`、`edit_file`、`run_shell`、`browser` 等工具完成复杂任务。工具调用以 `tool_use` / `tool_result` block 的形式在模型上下文中流转，Anthropic Claude API 对二者的 ID 配对有严格要求：`tool_use_id` 必须唯一、每个 `tool_result` 必须有对应的 `tool_use`、角色必须交替、首条消息必须为 `user`，否则直接返回 400 拒绝。

更隐蔽的风险在于**幻觉**：当模型上下文中出现不匹配、孤立或伪造的工具结果时，模型可能基于这些失真数据编造推理链，导致后续工具调用基于错误前提执行（例如基于一个"无结果"占位符臆造文件内容）。

Claude Code 通过 `ensureToolResultPairing` 机制在每次 API 调用前验证并修复配对关系，是其防幻觉体系的基石。本项目当前**没有任何运行时配对验证**，完全依赖数据构造时的隐式约定和上游正确性。本需求旨在为本项目引入一套适配自身架构的 ID 配对验证与修复机制，作为发送给 API 前的最后一道安全网。

### 1.2 产品价值

| 价值 | 说明 |
|------|------|
| **阻断幻觉源头** | 防止模型基于失真/伪造的工具结果进行推理，避免错误推理链扩散 |
| **前置拦截 API 400** | 在发往 API 前发现并修复非法配对，避免整次请求被拒导致的会话卡死 |
| **崩溃恢复韧性** | 清理崩溃残留的 `streaming` 消息与半成品工具调用，保证重启后会话可继续 |
| **数据完整性兜底** | 对反序列化失败、迁移缺陷、并发竞态等数据异常提供降级而非崩溃 |
| **可观测性** | 配对异常被记录、可统计，使潜在的数据损坏问题可见可追溯 |

### 1.3 设计原则

| 原则 | 说明 |
|------|------|
| **适配而非照搬** | 本项目持久化模型与 Claude Code 不同（见第 2 节），验证逻辑须基于本项目的"同数组配对"架构设计，不机械移植跨消息追踪 |
| **默认修复、可选严格** | 默认模式下自动修复并继续（保持会话连续性）；调试/诊断场景可启用严格模式快速失败 |
| **占位符语义明确** | 合成占位 `tool_result` 必须带 `is_error: true` 并使用可识别标记，让模型知道这是失真数据而非真实结果 |
| **防御性安全网** | 验证函数作为最后一道防线，不替代上游正确性，但保证"无论上游如何，发往 API 的消息一定合法" |
| **不破坏现有配对** | 修复策略以"保留真实数据、丢弃失真数据"为优先级，绝不主动删除真实工具结果 |

---

## 2. 参考机制与本项目的架构差异

> **这是本需求最重要的章节。** Claude Code 的 `ensureToolResultPairing` 基于其消息存储模型设计，而本项目的存储模型与之根本不同。直接移植会导致验证逻辑错位、误报频发。本节阐明差异，为第 7 节的方案设计奠定基础。

### 2.1 Claude Code 的模型：tool_use 与 tool_result 是独立消息

Claude Code 把 `tool_use` 存在 assistant 消息里、把 `tool_result` 存在**下一条** user 消息里，二者在消息序列中物理分离。因此：

- 孤立的 `tool_result`（有 result 无前置 use）可能因会话恢复、消息重排而产生
- 孤立的 `tool_use`（有 use 无后续 result）可能因流中断、超时而产生
- 跨消息的重复 `tool_use_id` 可能因远程会话重推而产生（CC-1212 会话死锁）
- 验证必须**跨消息遍历**，用全局 `Set` 追踪所有已见 ID

### 2.2 本项目的模型：tool_use 与 tool_result 同源于一个 ToolCallRecord

本项目把工具调用记录 `ToolCallRecord` 存储在**同一条 assistant 消息的 `toolCalls` 数组**中（`src/shared/domainTypes.ts:562`）。重建 API messages 时，`buildClaudeToolChatMessages`（`src/shared/claudeToolHistory.ts:78`）对每条带 `toolCalls` 的 assistant 消息**两次遍历同一数组**，生成相邻的两条 API 消息：

```
持久化:  Message(role=assistant, toolCalls=[tc1, tc2])
                         ↓ buildClaudeToolChatMessages
API messages:
  [i]   assistant(content=[text, tool_use{id=tc1.id}, tool_use{id=tc2.id}])
  [i+1] user(content=[tool_result{tool_use_id=tc1.id}, tool_result{tool_use_id=tc2.id}])
```

`tool_use.id` 与 `tool_result.tool_use_id` **取自同一个 `tc.id`**，配对由构造隐式保证。这个 `tc.id` 又是当初 API 流式返回的 `tool_use` block id 全程透传而来（`toolChatLoop.ts:513` → `chatToolSessionService.ts:110` → 持久化 → `claudeToolHistory.ts:108/122`）。

### 2.3 差异带来的结论

| 维度 | Claude Code | 本项目 | 对验证设计的影响 |
|------|-------------|--------|------------------|
| 孤立 tool_result 风险 | 高（独立消息易失配） | **低**（同数组同源） | 不需重点防孤立 result，但仍需防御 `payload.messages` 直传分支与飞书远程代理 |
| 孤立 tool_use 风险 | 高 | **低**（status 过滤跳过未完成项） | 已有 status 过滤防线，验证为补充 |
| 跨消息重复 ID 风险 | 高（CC-1212） | **低**（API 保证唯一，但迁移/恢复可能引入） | 仍需全局去重校验作为安全网 |
| 真实高频风险 | 配对失配 | **半成品残留、占位符误导、反序列化静默失败、上下文超限** | 本需求重点针对这些本项目特有风险 |
| 验证对象 | 持久化的原始消息 | **重建后的 API messages 数组** | 验证函数应插在 `buildClaudeToolChatMessages` 之后、发往 API 之前 |

**核心结论**：本项目的配对在正常路径下天然自洽，真正风险来自**数据异常**（崩溃残留、反序列化失败、迁移缺陷、并发竞态、上下文超限切断）和**旁路入口**（`payload.messages` 直传、飞书远程代理丢弃 toolCalls）。因此本需求的验证函数定位为**防御性安全网 + 异常数据降级**，而非 Claude Code 那样的常规修复器。

---

## 3. 现状评估

### 3.1 已实现的防护机制

| # | 机制 | 位置 | 覆盖内容 | 状态 |
|---|------|------|----------|------|
| P1 | 进行中状态过滤 | `claudeToolHistory.ts:104,119` | 跳过 `calling`/`confirming`/`executing` 状态的 toolCalls，既不发 tool_use 也不发 tool_result | ✅ 关键防线 |
| P2 | streaming 消息跳过 | `claudeToolHistory.ts:87` | `streaming` 状态的 assistant 整条不入历史 | ✅ |
| P3 | queued 消息跳过 | `claudeToolHistory.ts:88` | `queued` 状态的 user 消息不入历史 | ✅ |
| P4 | 运行时循环配对 | `toolChatLoop.ts:685-1559` | 每个 tool_use 必产生一个 tool_result（成功/失败/拒绝/超时分支齐全） | ✅ 仅内存 |
| P5 | 截断头部清理 | `claudeToolHistory.ts:140-160` | 丢弃头部孤立 assistant 与 tool_result-only user | ⚠️ 仅超 10000 条时触发 |
| P6 | 单 block 结构校验 | `claudeStreamHandlers.ts:107-170` | tool_use 有 id/name/input；tool_result 有 tool_use_id/content | ⚠️ 不校验配对 |
| P7 | result 缺失占位 | `claudeToolHistory.ts:12-13` | `tc.result` 缺失时返回 `'(无结果)'` | ❌ 无 `is_error` 标记 |
| P8 | thinking 块剥离占位 | `stripThinkingFromApiMessages.ts` | 剥离 thinking 后空 assistant 用 `[{type:'text',text:' '}]` 占位 | ✅ |

### 3.2 机制评分

| 维度 | 评分 | 说明 |
|------|------|------|
| 正常路径配对完整性 | ⭐⭐⭐⭐⭐ | 同数组同源构造，天然自洽 |
| 进行中工具隔离 | ⭐⭐⭐⭐ | status 过滤有效，但残留仍持久化 |
| 异常数据防御 | ⭐ | 零配对验证，反序列化静默失败 |
| 崩溃恢复 | ⭐ | streaming 残留不清理，会话可能卡死 |
| 上下文超限保护 | ⭐ | 仅 10000 条硬截断，无 token 预算 |
| 占位符语义 | ⭐ | `'(无结果)'` 无 `is_error`，误导模型 |
| 可观测性 | ⭐ | 配对异常无日志、无统计 |

---

## 4. 风险缺口分析

### 4.1 配对验证类风险

| # | 风险 | 触发条件 | 后果 | 严重度 |
|---|------|----------|------|--------|
| R1 | **零运行时配对验证** | 任何数据异常（DB 损坏、迁移缺陷、并发竞态） | 非法 messages 直发 API，仅靠 400 暴露 | 高 |
| R2 | **重复 tool_use_id 无检测** | 两条 ToolCallRecord 同 id（迁移/恢复引入） | 两个同 id 的 use/result，API 400 | 中 |
| R3 | **混含 text+tool_result 的 user 消息绕过孤立检测** | `payload.messages` 直传分支（`claudeStreamHandlers.ts:260-261`）传入混含消息 | 截断后保留无主 tool_result，API 400 | 中 |
| R4 | **首条非 user 无防护（短会话）** | 异常数据导致首条为 assistant | API 400（trim 修正仅在 >10000 条时生效） | 中 |

### 4.2 幻觉诱导类风险

| # | 风险 | 位置 | 后果 | 严重度 |
|---|------|------|------|--------|
| R5 | **`'(无结果)'` 占位符误导** | `claudeToolHistory.ts:13` | 模型把占位符当真实结果，据此臆造内容并执行后续工具 | 高 |
| R6 | **占位符无 `is_error` 标记** | `claudeToolHistory.ts:13-18` | 模型无法区分失真数据与真实结果，不会主动重试或报告 | 高 |
| R7 | **截断丢弃真实 tool_result** | `claudeToolHistory.ts:147-158` | 已执行工具结果上下文丢失，模型可能重复已完成操作 | 中 |

### 4.3 崩溃恢复类风险

| # | 风险 | 位置 | 后果 | 严重度 |
|---|------|------|------|--------|
| R8 | **streaming 消息残留** | `ChatView.tsx:797`、`main.ts:416-447` | 崩溃后 DB 残留 streaming assistant，虽不入 API 但用户可见且会话卡住 | 高 |
| R9 | **退出时不 flush 渲染进程待持久化消息** | `chatRunnerService.ts:21`（2s 节流）、`main.ts:416-447` | 退出时 throttled `chatPatchMessage` 可能未执行，最终状态丢失 | 中 |
| R10 | **流式中断后 'calling' 状态 toolCalls 残留** | `ChatView.tsx:934-944` | UI 永远显示"调用中"工具卡片，持久化残留 | 中 |

### 4.4 数据完整性类风险

| # | 风险 | 位置 | 后果 | 严重度 |
|---|------|------|------|--------|
| R11 | **反序列化静默失败** | `messageCodec.ts:132-134` | `tool_calls` 列损坏时 toolCalls 整体丢弃，assistant 变纯文本，无报错无修复 | 中 |
| R12 | **备份不校验配对** | `sessionBackupManager.ts:22-37` | 损坏消息被备份，恢复时再次引入损坏 | 低 |
| R13 | **迁移不校验配对** | `migrateFromJson.ts:188-223` | `verifyCounts` 只校验数量，`sampleVerifyMessages` 只抽样前 3 条 content | 低 |

### 4.5 旁路入口类风险

| # | 风险 | 位置 | 后果 | 严重度 |
|---|------|------|------|--------|
| R14 | **飞书远程代理丢弃 toolCalls** | `feishuRemoteAgent.ts:52-55` | 只取 role/content，API 收到残缺历史（缺 tool_use/tool_result 块），可能导致 400 或模型行为异常 | 中 |
| R15 | **`payload.messages` 直传绕过重建** | `claudeStreamHandlers.ts:260-261` | 调用方可传入任意结构消息，不经 `buildClaudeToolChatMessages` 的同源配对保证 | 中 |

### 4.6 上下文管理类风险

| # | 风险 | 位置 | 后果 | 严重度 |
|---|------|------|------|--------|
| R16 | **无 token 级上下文保护** | `claudeToolHistory.ts:140`、`chatApiMessageLimits.ts:2` | 仅 10000 条硬截断，长会话可能静默超模型上下文窗口，无降级、无告警 | 中 |
| R17 | **截断以单条消息为单元** | `claudeToolHistory.ts:144` | `slice(-maxMessages)` 可能切断 use/result 对（虽有头部 trim 兜底，但非显式原子保护） | 低 |

---

## 5. 目标与非目标

### 5.1 目标

| # | 目标 | 覆盖风险 |
|---|------|----------|
| G1 | 在发往 API 前对重建后的 messages 做**双向 ID 配对验证**（每个 tool_use 有对应 tool_result、每个 tool_result 有对应 tool_use、ID 全局唯一） | R1, R2 |
| G2 | 默认模式下对检测到的异常做**自动修复**（注入合成错误占位、丢弃孤立块、去重），保持会话连续性 | R1, R3 |
| G3 | 规范化合成占位 `tool_result`：带 `is_error: true` + 可识别标记，替换现有 `'(无结果)'` | R5, R6 |
| G4 | 提供**严格模式**：调试/诊断场景下检测到配对异常立即抛错而非修复，便于定位上游问题 | R1 |
| G5 | 应用启动时**清理 streaming 残留消息**与半成品 toolCalls，使崩溃后会话可继续 | R8, R10 |
| G6 | 截断以 **use+result 对为原子单元**，避免切断配对 | R7, R17 |
| G7 | 对 `payload.messages` 直传与飞书远程代理等**旁路入口**统一接入验证管道 | R14, R15 |
| G8 | 反序列化失败时**降级为合成错误占位**而非静默丢弃，并记录告警 | R11 |
| G9 | 每次修复记录**诊断日志**（原始/修复后消息数、修复类型、消息结构摘要） | 可观测性 |
| G10 | 维护 API 要求的**消息结构**（首条 user、角色交替、空消息占位） | R4 |

### 5.2 非目标

| # | 非目标 | 说明 |
|---|--------|------|
| NG1 | 不改变"toolCalls 存于同一条 assistant 消息"的持久化模型 | 该架构天然自洽，是优势而非缺陷，无需重构 |
| NG2 | 不引入 token 级上下文压缩/摘要 | 上下文用量估算（`contextUsageEstimate.ts`）是独立主题，本需求仅保证截断不破坏配对，不做 token 预算压缩 |
| NG3 | 不为 HFI 训练数据收集设计纯净模式 | 本项目无训练数据收集场景，严格模式仅用于调试 |
| NG4 | 不在工具循环内存层（`toolChatLoop.ts`）引入配对验证 | 内存层已有控制流隐式保证（P4），验证聚焦于"持久化→API"边界 |
| NG5 | 不替换现有 status 过滤机制（P1） | status 过滤是第一道防线，验证函数在其之后作为补充 |
| NG6 | 不修改 Anthropic API 的 tool_use_id 生成方式 | 继续全程透传 API 返回的 id，不本地生成、不重写 |

---

## 6. 用户故事

### US-01：防范占位符诱导的幻觉

**作为** 用户，**当** 历史会话中存在因崩溃导致 result 缺失的工具调用时，**我希望** 系统在重发该会话时用一个明确标记为错误的占位结果替代，**以便** 模型知道该工具调用失败而非臆造结果继续推理。

### US-02：崩溃后会话可恢复

**作为** 用户，**当** 应用在工具执行过程中崩溃重启后，**我希望** 之前卡在"调用中"的半成品工具调用被自动清理，**以便** 我能正常继续对话而不会被残留的 streaming 消息卡死。

### US-03：API 400 不再卡死会话

**作为** 用户，**当** 会话历史因数据异常产生非法配对时，**我希望** 系统在发往 API 前自动修复，**以便** 请求正常发出，而不是整次被 API 拒绝导致无法继续。

### US-04：截断不破坏工具上下文

**作为** 用户，**当** 会话很长触发历史截断时，**我希望** 工具的 use 与 result 作为一个整体被保留或丢弃，**以便** 模型不会看到"有调用无结果"或"有结果无调用"的残缺上下文而困惑。

### US-05：异常可观测可追溯

**作为** 开发者，**当** 配对异常被修复时，**我希望** 在日志中看到完整的诊断信息，**以便** 定位上游数据损坏的根因。

### US-06：飞书远程会话历史完整

**作为** 用户，**当** 通过飞书远程代理继续一个含工具调用的会话时，**我希望** 历史中的 tool_use/tool_result 块被正确保留，**以便** 模型基于完整上下文响应而非残缺历史。

---

## 7. 改进方案设计

### 7.1 总体架构与集成点

在现有消息处理管道中插入一个**配对验证与修复**环节，位于"持久化消息重建为 API messages"之后、"发往 Claude API"之前：

```
┌──────────────────────────────────────────────────────────────────┐
│                    工具循环消息处理管道                            │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  持久化 Message[] (含 toolCalls)                                 │
│          ↓                                                       │
│  buildClaudeToolChatMessages()        ← 同数组配对重建            │
│          ↓                                                       │
│  normalizeAndValidateClaudeMessagesWithContentBlocks()             │
│    ├── assertValidClaudeContentBlocks()  ← 单 block 结构校验(P6) │
│    └── trimClaudeToolChatMessages()      ← 截断 + 头部清理(P5)   │
│          ↓                                                       │
│  ensureToolResultPairing()           ← 【新增】配对验证与修复     │
│          ↓                                                       │
│  stripThinkingBlocksFromAssistantMessages()  ← thinking 剥离(P8) │
│          ↓                                                       │
│  runToolChatSession() → 每轮 buildClaudeToolLoopStreamParams      │
│          ↓                                                       │
│  发送到 Claude API                                                │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

**集成点**：`electron/claudeStreamHandlers.ts` 的 `normalizeAndValidateClaudeMessagesWithContentBlocks`（约 `:172-192`）。该函数已是所有工具循环请求的必经之路，且已在做结构校验与截断，是插入配对验证的天然位置。

**关键设计决策**：验证函数作用于**重建后的 API messages 数组**（`Anthropic.MessageParam[]`），而非持久化的 `Message[]`。原因：
1. API 配对约束针对的是发送给它的 messages，验证应贴近发送边界
2. 重建后的数组已是 assistant(tool_use) → user(tool_result) 的标准形态，验证逻辑统一
3. 旁路入口（`payload.messages` 直传、飞书远程）最终也汇聚到此数组，一处验证覆盖所有入口

### 7.2 配对验证函数 `ensureToolResultPairing`

新增 `src/shared/toolResultPairing.ts`，导出核心函数与常量。

#### 7.2.1 常量定义

```typescript
// 合成占位符：明确标识为内部错误，配合 is_error 让模型理解这是失真数据
export const SYNTHETIC_TOOL_RESULT_PLACEHOLDER =
  '[Tool result missing due to internal error]'

// 孤立 tool_result 移除后的占位文本（防止 user 消息变空）
export const ORPHAN_REMOVED_MESSAGE =
  '[Orphaned tool result removed due to conversation resume]'

// 空消息占位
export const NO_CONTENT_MESSAGE = '[no content]'
```

#### 7.2.2 函数签名

```typescript
export interface PairingRepairReport {
  repaired: boolean
  /** 原始消息数 → 修复后消息数 */
  originalCount: number
  repairedCount: number
  /** 各类修复的发生次数 */
  fixes: {
    missingToolResult: number      // 注入合成占位
    orphanedToolResult: number     // 移除孤立 result
    duplicateToolUseId: number     // 去重 tool_use
    duplicateToolResultId: number  // 去重 tool_result
    leadingAssistantDropped: number// 丢弃首条 assistant
    roleAlternationFixed: number   // 修复角色不交替
    emptyMessageFilled: number     // 空消息占位
  }
  /** 消息结构摘要（用于诊断日志） */
  messageStructure: string[]
}

export function ensureToolResultPairing(
  messages: Anthropic.MessageParam[],
  opts?: { strict?: boolean }
): Anthropic.MessageParam[]
```

#### 7.2.3 验证与修复流程

```typescript
export function ensureToolResultPairing(messages, opts) {
  const strict = opts?.strict ?? getStrictToolResultPairing()
  const report: PairingRepairReport = { /* 初始化 */ }
  const allSeenToolUseIds = new Set<string>()  // 全局去重（防跨消息重复 ID，对应 R2/CC-1212）
  const result: Anthropic.MessageParam[] = []

  for (const msg of messages) {
    // 1. 收集本条消息的 tool_use id 与 tool_result id
    const content = Array.isArray(msg.content) ? msg.content : []
    const toolUseIds = new Set<string>()
    const toolResultIds = new Set<string>()
    for (const block of content) {
      if (block.type === 'tool_use') toolUseIds.add(block.id)
      if (block.type === 'tool_result') toolResultIds.add(block.tool_use_id)
    }

    // 2. 跨消息去重 tool_use（R2）
    const dedupedContent = content.filter(block => {
      if (block.type === 'tool_use') {
        if (allSeenToolUseIds.has(block.id)) {
          report.fixes.duplicateToolUseId++; report.repaired = true
          if (strict) throwPairingMismatch(report)
          return false
        }
        allSeenToolUseIds.add(block.id)
      }
      return true
    })

    // 3. tool_use / tool_result 配对验证（双向）
    if (msg.role === 'assistant') {
      // 正向：每个 tool_use 在后续 user 消息中应有对应 result
      //   （在本项目架构下，配对的 result 在紧邻的下一条 user 消息；
      //    采用"延迟一拍"校验：记录待匹配 use id，到下一条 user 消息核对）
    } else if (msg.role === 'user') {
      // 反向：每个 tool_result 应有对应 tool_use（孤立 result，R3）
      const orphaned = [...toolResultIds].filter(id => !allSeenToolUseIds.has(id))
      if (orphaned.length) {
        report.fixes.orphanedToolResult += orphaned.length; report.repaired = true
        if (strict) throwPairingMismatch(report)
        // 移除孤立 result block
      }
      // 重复 tool_result id 去重（R2 反向）
    }
    result.push({ ...msg, content: patchedContent })
  }

  // 4. 收尾：处理仍未匹配的 tool_use（缺失 result，R1）→ 注入合成占位
  // 5. 维护消息结构：首条 user、角色交替、空消息占位（R4）
  // 6. 记录诊断日志（G9）
  return result
}
```

> **注意**：上述为流程骨架，完整实现需处理"延迟一拍"的 use↔result 配对（因 result 在下一条 user 消息中）、空 content 数组、非数组 content（string 形式）等边界。实现时可参考 Claude Code `messages.ts:5133-5460` 的结构，但**配对判定逻辑须适配本项目"assistant(tool_use) 紧邻 user(tool_result)"的相邻配对模式**，而非 Claude Code 的全局任意位置匹配。

### 7.3 修复策略矩阵

| 问题类型 | 修复方式 | 严格模式行为 | 覆盖风险 |
|---------|---------|-------------|----------|
| **缺失的 tool_result**（有 use 无 result） | 在紧邻 user 消息注入 `{type:'tool_result', tool_use_id, content: SYNTHETIC_TOOL_RESULT_PLACEHOLDER, is_error:true}` | 抛错终止 | R1 |
| **孤立的 tool_result**（有 result 无 use） | 从 user 消息中移除该 block；若 user 消息变空则用 `ORPHAN_REMOVED_MESSAGE` 占位 | 抛错终止 | R3, R14 |
| **重复的 tool_use ID** | 保留第一个，移除后续重复（连同其对应 result） | 抛错终止 | R2 |
| **重复的 tool_result ID** | 保留第一个，移除后续重复 | 抛错终止 | R2 |
| **首条为 assistant** | 丢弃首条 assistant 直到遇到 user；全空则插入占位 user | 抛错终止 | R4 |
| **角色不交替**（连续同角色） | 合并连续同角色消息的 content；或插入占位消息恢复交替 | 抛错终止 | R4 |
| **空 content 消息** | 插入 `NO_CONTENT_MESSAGE` 文本块 | 抛错终止 | 结构 |
| **非数组 content**（string） | 保持原样（合法），跳过配对校验 | — | — |

**修复优先级**：保留真实数据 > 丢弃失真数据 > 注入合成占位。绝不主动删除看起来合法的真实 tool_result。

### 7.4 合成占位符规范化（覆盖 R5/R6）

#### 7.4.1 替换现有 `'(无结果)'` 占位

当前 `src/shared/claudeToolHistory.ts:12-13`：

```typescript
// 现状（有幻觉风险）
function toolResultContent(tc: ToolCallRecord): string {
  if (!tc.result) return '(无结果)'
  ...
}
```

改造为区分"真实结果"与"失真占位"，并在生成 tool_result block 时设置 `is_error`：

```typescript
interface ToolResultBlockBuild {
  content: string
  isError: boolean   // 新增：标识是否为失真占位
}

function buildToolResultBlock(tc: ToolCallRecord): ToolResultBlockBuild {
  if (!tc.result) {
    return { content: SYNTHETIC_TOOL_RESULT_PLACEHOLDER, isError: true }
  }
  if (tc.result.success === false) {
    return { content: tc.result.error || '失败', isError: true }
  }
  return { content: serializeToolResultData(tc.result.data), isError: false }
}
```

在 `buildClaudeToolChatMessages`（`claudeToolHistory.ts:117-126`）生成 tool_result 时：

```typescript
results.push({
  type: 'tool_result',
  tool_use_id: tc.id,
  content: block.content,
  is_error: block.isError   // 新增：失真/失败时为 true
})
```

#### 7.4.2 语义效果

| 场景 | 改造前 | 改造后 |
|------|--------|--------|
| result 缺失（崩溃/竞态） | `'(无结果)'`（模型可能臆造内容） | `'[Tool result missing due to internal error]'` + `is_error:true`（模型理解为失败，倾向重试或报告） |
| result 失败 | `error` 文本（无 is_error） | `error` 文本 + `is_error:true`（语义更准确） |
| result 成功 | `data` 文本 | `data` 文本（不变） |

> **API 兼容性**：Anthropic API 的 `tool_result` block 支持 `is_error` 字段。本改造仅新增字段，不破坏现有格式。

### 7.5 截断以 use+result 对为原子单元（覆盖 R7/R17）

当前 `trimClaudeToolChatMessages`（`claudeToolHistory.ts:140-160`）仅在消息数超 `MAX_CHAT_API_MESSAGES=10000` 时触发，且只做头部孤立清理。改进为**显式原子化截断**：

```typescript
export function trimClaudeToolChatMessages(messages, maxMessages) {
  if (messages.length <= maxMessages) return messages
  let trimmed = messages.slice(-maxMessages)
  // 原子化：切点若落在 use/result 对中间，丢弃头部的孤立部分
  while (trimmed.length > 0) {
    const first = trimmed[0]
    if (first.role === 'assistant') { trimmed = trimmed.slice(1); continue }
    if (isToolResultOnlyUserMessage(first)) { trimmed = trimmed.slice(1); continue }
    break
  }
  // 【新增】中间孤立检测：遍历确认无中间断裂（防御数据异常）
  //   若发现中间存在孤立 tool_result（无前置 use），交由 ensureToolResultPairing 修复
  return trimmed
}
```

**改进点**：
1. 保留现有头部清理逻辑（已正确）
2. 新增注释明确"配对原子性"为截断的不变式
3. 中间孤立不在 trim 内修复（避免职责过载），而是依赖下游 `ensureToolResultPairing` 兜底

> **降低截断阈值**（可选，独立决策）：当前 10000 条阈值过高，长会话会先触及模型上下文窗口而非此阈值。是否下调阈值或改用 token 估算驱动截断，属于上下文管理（NG2）范畴，本需求不强制，但建议作为后续议题。

### 7.6 启动时 streaming 残留清理（覆盖 R8/R10）

#### 7.6.1 问题

应用崩溃/异常退出时，DB 中残留 `status='streaming'` 的 assistant 消息，其 `toolCalls` 可能含 `calling`/`confirming`/`executing` 状态的半成品记录。虽然 `buildClaudeToolChatMessages` 会跳过 streaming 消息（P2）不致 API 报错，但：
- 用户在 UI 上看到永远"调用中"的卡片
- 该会话无法正常继续（streaming 消息阻塞后续逻辑）
- 退出时 2s 节流的 patch 可能未落盘，状态不一致

#### 7.6.2 方案：启动一次性修复

在主进程启动初始化阶段（`electron/main.ts` 的 `app.whenReady` 后，DB 初始化之后），执行一次性清理：

```typescript
// electron/database/streamingCleanup.ts（新增）
export function cleanupStreamingResiduesOnStartup(db: Database): number {
  // 1. 查找所有 status='streaming' 的 assistant 消息
  const rows = db.prepare(
    `SELECT id, session_id, tool_calls FROM messages WHERE role='assistant' AND status='streaming'`
  ).all()

  let fixed = 0
  for (const row of rows) {
    // 2. 将 streaming 降级为 failed（或 interrupted）
    // 3. 解析 tool_calls，把 calling/confirming/executing 状态降级为 failed
    //    并补全合成 result（is_error），避免下次重建时该 toolCall 既无 use 也无 result 的语义丢失
    // 4. 更新 DB
    fixed++
  }
  // 5. 记录启动修复日志
  logAgentEvent('info', 'startup.streaming_cleanup', { fixedCount: fixed })
  return fixed
}
```

**降级策略**：
| 字段 | 清理前 | 清理后 |
|------|--------|--------|
| `Message.status` | `streaming` | `failed` |
| `ToolCallRecord.status` | `calling`/`confirming`/`executing` | `failed` |
| `ToolCallRecord.result` | 缺失 | `{ success: false, error: '工具调用因应用退出中断' }` |
| `ToolCallRecord.completedAt` | 缺失 | 当前时间 |

**集成点**：`electron/main.ts` 中 `appDb` 初始化后调用，幂等可重复执行。

> **UI 提示**：清理后的消息状态为 `failed`，UI 应展示"该回复因应用异常退出中断"的提示，而非"调用中"。这属于 UI 层适配，不在本需求核心范围，但需协同。

### 7.7 持久化层加固（覆盖 R11）

#### 7.7.1 反序列化失败降级

当前 `electron/messageCodec.ts:132-134` 的 `deserializeToolCallsFromDb` 解析失败时返回 `undefined`，导致 assistant 消息静默丢失所有工具调用记录（变成纯文本），无告警。

改造为**降级为合成失败 toolCall** 而非丢弃：

```typescript
export function deserializeToolCallsFromDb(raw: string | null): ToolCallRecord[] | undefined {
  if (!raw) return undefined
  try {
    return JSON.parse(raw).map(deserializeToolCall)
  } catch (e) {
    // 【改造】不再静默返回 undefined，而是记录告警并返回标记为损坏的占位记录
    logAgentEvent('warn', 'db.tool_calls.deserialize_failed', { error: String(e) })
    // 返回 undefined 会让该消息变纯文本（丢失工具上下文）；
    // 更优做法是返回一个 is_corrupted 标记，由重建层生成合成错误占位。
    //   —— 但这需要扩展 ToolCallRecord 类型（见 8.1）
    return undefined  // 短期保持现状，长期引入 corrupted 标记
  }
}
```

#### 7.7.2 长期方案：引入 corrupted 标记（见 8.1）

新增 `ToolCallRecord.corrupted?: boolean` 字段。反序列化失败时返回单个 `{ id: 'corrupted-<uuid>', toolName: 'unknown', input: {}, status: 'failed', result: { success: false, error: '工具调用记录数据损坏' }, corrupted: true }`。`buildClaudeToolChatMessages` 对 `corrupted: true` 的记录生成合成错误占位 tool_use + tool_result，保持配对完整且语义明确。

#### 7.7.3 备份与迁移校验增强

| 文件 | 现状 | 改进 |
|------|------|------|
| `sessionBackupManager.ts:22-37` | 直接 stringify，不校验 | 备份前调用 `ensureToolResultPairing` 的**只读校验模式**（不修复，仅记录异常），异常时在备份元数据中标注 |
| `migrateFromJson.ts:188-223` | 只校验数量 + 抽样 3 条 content | 新增 toolCalls 配对完整性校验：对含 toolCalls 的消息，验证 `tc.id` 唯一性、`tc.result` 存在性，异常记录到迁移日志 |

### 7.8 旁路入口接入验证管道（覆盖 R14/R15）

#### 7.8.1 飞书远程代理补全 toolCalls

`electron/feishu/feishuRemoteAgent.ts:52-55` 当前只取 `role`/`content`，丢弃 `toolCalls`，导致 API 收到残缺历史。

```typescript
// 现状（R14）
const messages = getMessages(ctx.db, ctx.sessionId).map((m) => ({
  role: m.role as 'user' | 'assistant',
  content: m.content
}))

// 改造：复用 buildClaudeToolChatMessages 的重建逻辑
const messages = buildClaudeToolChatMessages(
  getMessages(ctx.db, ctx.sessionId),
  { /* 选项 */ }
)
// 再经 ensureToolResultPairing 验证
const safe = ensureToolResultPairing(messages)
```

**前提**：飞书远程代理的下游 API 是否支持 tool_use/tool_result block 需确认（若为非 Anthropic 兼容 API，可能需剥离工具块——这属于飞书集成的独立议题，本需求仅指出配对风险，具体实现由飞书模块决策）。

#### 7.8.2 payload.messages 直传分支

`claudeStreamHandlers.ts:260-261` 的 `payload.messages` 直传分支允许调用方传入任意结构消息，绕过 `buildClaudeToolChatMessages` 的同源配对保证。

**改造**：该分支也必须经过 `normalizeAndValidateClaudeMessagesWithContentBlocks`（含 `ensureToolResultPairing`），不得直接透传：

```typescript
// normalizeAndValidateClaudeMessagesWithContentBlocks 内部统一调用
const paired = ensureToolResultPairing(trimmed)
return paired
```

由于集成点已在 `normalizeAndValidateClaudeMessagesWithContentBlocks`（7.1），只要确保所有 API 出口都经过该函数即可覆盖此分支。需审查 `claudeStreamHandlers.ts` 确认无其他绕过路径。

### 7.9 诊断与日志（覆盖 G9）

#### 7.9.1 修复事件记录

每次 `ensureToolResultPairing` 触发修复时，通过现有 `electron/agentLogger` 记录诊断事件：

```typescript
import { logAgentEvent } from '../electron/agentLogger/agentLogger'

function logPairingRepair(report: PairingRepairReport, sessionId?: string) {
  logAgentEvent('warn', 'tool.result.pairing.repaired', {
    sessionId,
    originalCount: report.originalCount,
    repairedCount: report.repairedCount,
    fixes: report.fixes,
    messageStructure: report.messageStructure.join('; ')
  })
}
```

#### 7.9.2 消息结构摘要

诊断信息包含每条消息的索引、角色、tool_use/tool_result ID 列表，便于定位：

```typescript
const messageStructure = messages.map((m, idx) => {
  const content = Array.isArray(m.content) ? m.content : []
  const toolUses = content.filter(b => b.type === 'tool_use').map(b => b.id)
  const toolResults = content.filter(b => b.type === 'tool_result').map(b => b.tool_use_id)
  return `[${idx}] ${m.role}(use=[${toolUses}],result=[${toolResults}])`
})
```

#### 7.9.3 监控指标

| 指标 | 含义 | 告警阈值建议 |
|------|------|-------------|
| `pairing.repaired` 事件频率 | 单位时间内修复次数 | 单会话 >0 即值得关注 |
| `missingToolResult` 计数 | 合成占位注入次数 | 持续增长提示上游 result 落盘竞态 |
| `orphanedToolResult` 计数 | 孤立 result 移除次数 | >0 提示旁路入口或迁移缺陷 |
| `deserialize_failed` 计数 | 反序列化失败次数 | >0 提示 DB 数据损坏 |
| `startup.streaming_cleanup` 计数 | 启动清理的 streaming 消息数 | 持续增长提示崩溃频率高 |

> **脱敏**：诊断日志经 `sanitizeForLog`（`electron/logSanitize.ts`）处理，不落用户消息正文、不落工具结果敏感内容。仅记录 ID 与结构摘要。

### 7.10 严格模式（覆盖 G4）

#### 7.10.1 开关定义

新增全局状态 `strictToolResultPairing: boolean`，默认 `false`。可通过以下方式开启：
- 环境变量 `SPACEASSISTANT_STRICT_TOOL_PAIRING=1`（启动时读取）
- 设置页「调试模式」开关（后续迭代）

#### 7.10.2 行为差异

| 行为 | 默认模式（false） | 严格模式（true） |
|------|------------------|------------------|
| 缺失 tool_result | 注入合成占位并继续 | 抛 `ToolResultPairingError` 终止请求 |
| 孤立 tool_result | 移除并继续 | 抛错终止 |
| 重复 ID | 去重并继续 | 抛错终止 |
| 角色结构异常 | 修复并继续 | 抛错终止 |
| **使用场景** | 正常用户会话 | 开发调试、定位上游数据问题 |

#### 7.10.3 错误信息

```typescript
class ToolResultPairingError extends Error {
  constructor(report: PairingRepairReport) {
    super(
      `ensureToolResultPairing: 配对不匹配（严格模式），拒绝修复以避免向模型注入合成数据。` +
      `修复详情: ${JSON.stringify(report.fixes)}。` +
      `消息结构: ${report.messageStructure.join('; ')}`
    )
    this.name = 'ToolResultPairingError'
  }
}
```

> **与 Claude Code 严格模式的区别**：Claude Code 严格模式用于 HFI 训练数据纯净性；本项目严格模式仅用于调试，帮助开发者快速发现上游数据损坏，不涉及训练数据收集。

---

## 8. 数据模型变更

### 8.1 ToolCallRecord 扩展

```typescript
// src/shared/domainTypes.ts 扩展
export interface ToolCallRecord {
  id: string
  toolName: string
  input: Record<string, unknown>
  result?: ToolCallResultPersisted
  status: ToolCallStatus
  riskLevel: ToolRiskLevel
  // ... 现有字段 ...

  /** 【新增】该记录数据已损坏（反序列化失败等），重建时生成合成错误占位 */
  corrupted?: boolean
  /** 【新增】该工具调用因应用崩溃中断，由启动清理降级而来 */
  interrupted?: boolean
}
```

**向后兼容**：新增字段为可选，旧数据不受影响。`schemaVersion` 无需提升（JSON 序列化自动兼容新字段缺失）。

### 8.2 新增类型定义

```typescript
// src/shared/toolResultPairing.ts（新增文件）
export interface PairingRepairReport {
  repaired: boolean
  originalCount: number
  repairedCount: number
  fixes: {
    missingToolResult: number
    orphanedToolResult: number
    duplicateToolUseId: number
    duplicateToolResultId: number
    leadingAssistantDropped: number
    roleAlternationFixed: number
    emptyMessageFilled: number
  }
  messageStructure: string[]
}

export class ToolResultPairingError extends Error { /* 见 7.10.3 */ }
```

### 8.3 配置项扩展（可选）

若通过设置页暴露严格模式：

```typescript
// AppConfig 扩展（可选，若不暴露 UI 则仅环境变量）
export interface AppConfig {
  // ... 现有字段 ...
  /** 调试：工具配对严格模式，检测到异常立即失败而非修复 */
  debugStrictToolPairing?: boolean
}
```

> **建议**：初版仅支持环境变量开启严格模式，不暴露 UI 配置，避免普通用户误开导致会话频繁失败。

---

## 9. 实现要点

### 9.1 模块变更总览

| 模块 | 文件 | 变更类型 | 说明 |
|------|------|----------|------|
| 配对验证核心 | `src/shared/toolResultPairing.ts` | **新增** | `ensureToolResultPairing`、常量、`PairingRepairReport`、`ToolResultPairingError` |
| 占位符规范化 | `src/shared/claudeToolHistory.ts` | 修改 | `toolResultContent` → `buildToolResultBlock`（含 isError）；tool_result 生成加 `is_error` |
| 截断原子化 | `src/shared/claudeToolHistory.ts` | 修改 | `trimClaudeToolChatMessages` 增加原子性注释与中间孤立委托说明 |
| 集成点接入 | `electron/claudeStreamHandlers.ts` | 修改 | `normalizeAndValidateClaudeMessagesWithContentBlocks` 内调用 `ensureToolResultPairing` |
| 启动清理 | `electron/database/streamingCleanup.ts` | **新增** | `cleanupStreamingResiduesOnStartup` |
| 启动集成 | `electron/main.ts` | 修改 | `app.whenReady` 后调用启动清理 |
| 反序列化加固 | `electron/messageCodec.ts` | 修改 | `deserializeToolCallsFromDb` 失败时告警 + corrupted 标记 |
| 旁路入口修复 | `electron/feishu/feishuRemoteAgent.ts` | 修改 | 复用 `buildClaudeToolChatMessages` 重建历史 |
| 类型扩展 | `src/shared/domainTypes.ts` | 修改 | `ToolCallRecord` 新增 `corrupted?`/`interrupted?` |
| 备份校验 | `electron/sessionBackupManager.ts` | 修改 | 备份前只读校验 |
| 迁移校验 | `electron/database/migrateFromJson.ts` | 修改 | 新增 toolCalls 配对校验 |
| 严格模式状态 | `electron/claudeRequestGuards.ts` 或新文件 | 修改 | 读取环境变量，提供 `getStrictToolResultPairing()` |

### 9.2 实现优先级与分期

| 期次 | 内容 | 覆盖目标 | 风险等级 |
|------|------|----------|----------|
| **P0（必做）** | `ensureToolResultPairing` 核心函数 + 集成点接入 + 占位符规范化（`is_error`） | G1, G2, G3, G10 | 高价值低风险 |
| **P0（必做）** | 启动 streaming 残留清理 | G5 | 高价值，解决崩溃卡死 |
| **P1（应做）** | 反序列化失败告警 + corrupted 标记 | G8 | 中价值 |
| **P1（应做）** | 诊断日志 | G9 | 中价值，P0 即可顺带 |
| **P1（应做）** | 飞书远程代理补全 toolCalls | G7（R14） | 取决于飞书 API 兼容性 |
| **P2（可选）** | 严格模式 | G4 | 调试用，低优先 |
| **P2（可选）** | 备份/迁移校验增强 | R12, R13 | 防御性，低频 |
| **P2（可选）** | 截断阈值下调 / token 驱动 | R16 | 独立议题（NG2） |

### 9.3 执行流程（改造后）

```
用户发送消息
    → 渲染端 chatGetMessages + filterMessagesForChatApi
    → 主进程 claude-chat-create-with-tools handler
    → buildClaudeToolChatMessages（同数组配对重建 + is_error 占位）
    → normalizeAndValidateClaudeMessagesWithContentBlocks
        ├── assertValidClaudeContentBlocks（单 block 结构）
        ├── trimClaudeToolChatMessages（原子化截断）
        └── ensureToolResultPairing【新增】
              ├── 全局 ID 去重
              ├── 双向配对验证
              ├── 异常修复（默认）或抛错（严格）
              └── 记录诊断日志
    → stripThinkingBlocksFromAssistantMessages
    → runToolChatSession（每轮累积，内存层已有 P4 配对保证）
    → 发送到 Claude API（消息一定合法）
```

### 9.4 实现注意事项

1. **纯函数优先**：`ensureToolResultPairing` 应为纯函数（输入 messages，输出 messages + report），副作用仅限日志。便于测试与复用。
2. **共享层放置**：验证函数放 `src/shared/`（非 `electron/`），因渲染端测试与主进程均需访问，且不依赖 Node API。
3. **不引入新依赖**：仅用现有 `agentLogger`、`logSanitize`，不新增日志库。
4. ** Anthropic 类型复用**：使用项目已有的 Anthropic SDK 类型（`Anthropic.MessageParam`、`Anthropic.ToolResultBlockParam`），不重新定义。
5. **性能**：验证为 O(n) 单次遍历 + Set 查找，对万级消息无性能压力。`messageStructure` 摘要仅在 `repaired=true` 时构建，避免无修复时的开销。
6. **测试隔离**：新增 `src/shared/toolResultPairing.test.ts`，覆盖所有修复策略矩阵行（见 10.2）。

---

## 10. 测试计划

### 10.1 单元测试覆盖

| 测试文件 | 覆盖内容 |
|----------|----------|
| `src/shared/toolResultPairing.test.ts`（新增） | `ensureToolResultPairing` 所有修复策略、严格模式、边界 |
| `src/shared/claudeToolHistory.test.ts`（扩展） | `buildToolResultBlock` 的 `is_error` 标记、占位符内容 |
| `electron/database/streamingCleanup.test.ts`（新增） | 启动清理降级逻辑 |
| `electron/messageCodec.test.ts`（扩展） | 反序列化失败告警与 corrupted 标记 |
| `electron/claudeStreamHandlers.test.ts`（扩展） | 集成点：验证函数被调用、异常消息被修复 |

### 10.2 测试用例

| # | 用例 | 输入 | 预期 | 覆盖 |
|---|------|------|------|------|
| 1 | 正常配对不修复 | assistant(use=[a]) → user(result=[a]) | 原样返回，repaired=false | — |
| 2 | 缺失 tool_result | assistant(use=[a,b]) → user(result=[a]) | user 补入 b 的合成占位（is_error），repaired=true | R1 |
| 3 | 孤立 tool_result | user(result=[a]) → assistant(use=[b]) → user(result=[b]) | 首条 user 的孤立 a 被移除，用 ORPHAN 文本占位 | R3 |
| 4 | 重复 tool_use_id | assistant(use=[a]) → user(result=[a]) → assistant(use=[a]) | 第二个 a 被去重 | R2 |
| 5 | 重复 tool_result_id | user(result=[a,a]) | 第二个 a 被去重 | R2 |
| 6 | 首条为 assistant | assistant(use=[a]) → user(result=[a]) | 首条 assistant 被丢弃（严格模式抛错） | R4 |
| 7 | 连续同角色 | user → user → assistant | 合并或插入占位恢复交替 | R4 |
| 8 | 空 content 消息 | assistant(content=[]) | 插入 NO_CONTENT 占位 | 结构 |
| 9 | result 缺失占位规范化 | tc.result=undefined | tool_result.content=PLACEHOLDER, is_error=true | R5/R6 |
| 10 | result 失败 | tc.result.success=false | is_error=true | R6 |
| 11 | 严格模式缺失 result | 同用例 2 | 抛 ToolResultPairingError | G4 |
| 12 | 严格模式孤立 result | 同用例 3 | 抛错 | G4 |
| 13 | 反序列化失败 | tool_calls 列损坏 | 返回 corrupted 占位记录 + 告警日志 | R11 |
| 14 | 启动清理 streaming | DB 含 streaming assistant + calling toolCalls | 降级为 failed，toolCalls 补 interrupted result | R8/R10 |
| 15 | 截断切断 use/result 对 | 10001 条，切点在 use 后 | 头部孤立 result 被清理 | R7/R17 |
| 16 | 飞书远程补全 | 会话含 toolCalls | 重建后含 use/result 块 | R14 |
| 17 | 非数组 content（string） | user(content="文本") | 原样返回，跳过配对校验 | 边界 |
| 18 | 大消息集性能 | 10000 条合法消息 | 单次验证 < 50ms，repaired=false 时不建摘要 | 性能 |

### 10.3 集成测试

- **端到端**：构造含损坏 toolCalls 的会话（手动改 DB），发起请求，验证不触发 API 400 且日志有修复记录。
- **崩溃恢复**：模拟工具执行中崩溃（kill 进程），重启后验证 streaming 消息被清理、会话可继续。
- **飞书远程**：构造含工具调用的会话，通过飞书远程代理发起，验证历史完整。

---

## 11. 验收标准

### 11.1 功能验收

- [ ] `ensureToolResultPairing` 在 `normalizeAndValidateClaudeMessagesWithContentBlocks` 中被调用，位于 trim 之后、发送之前
- [ ] 缺失 tool_result 时自动注入合成占位（`is_error:true` + `SYNTHETIC_TOOL_RESULT_PLACEHOLDER`），请求继续
- [ ] 孤立 tool_result 被移除，请求继续
- [ ] 重复 tool_use_id / tool_result_id 被去重，请求继续
- [ ] 首条非 user 消息被修正（丢弃或占位）
- [ ] 角色不交替被修复
- [ ] `tc.result` 缺失时 tool_result 带 `is_error:true`，替换原 `'(无结果)'`
- [ ] `tc.result.success=false` 时 tool_result 带 `is_error:true`
- [ ] 严格模式下上述异常均抛 `ToolResultPairingError` 终止请求
- [ ] 应用启动时清理 streaming 残留消息，降级为 failed，toolCalls 补 interrupted result
- [ ] 反序列化失败时记录告警并降级为 corrupted 占位
- [ ] 飞书远程代理历史含 tool_use/tool_result 块
- [ ] 所有修复记录诊断日志（含修复类型计数与消息结构摘要）

### 11.2 防幻觉验收

- [ ] 模型不再收到无 `is_error` 标记的 `'(无结果)'` 占位（消除 R5/R6）
- [ ] 崩溃后重启，会话不卡死，半成品工具调用有明确的"中断"语义而非"调用中"（消除 R8/R10）
- [ ] 构造的非法配对消息不触发 API 400（被前置修复，消除 R1）
- [ ] 截断后不出现残缺的 use/result 对（消除 R7/R17）
- [ ] 诊断日志可定位上游数据损坏来源

### 11.3 测试验收

- [ ] `toolResultPairing.test.ts` 覆盖 10.2 全部 18 个用例
- [ ] 单元测试覆盖率 ≥ 90%（核心函数）
- [ ] 集成测试：崩溃恢复、损坏 DB、飞书远程三条链路通过
- [ ] 性能：10000 条消息验证 < 50ms

### 11.4 兼容性验收

- [ ] 旧 DB 数据（无 `corrupted`/`interrupted` 字段）正常加载，无破坏
- [ ] `schemaVersion` 无需提升，JSON 序列化向后兼容
- [ ] 现有正常会话行为无变化（repaired=false 时不产生副作用）

---

## 12. 相关文件

| 区域 | 文件 | 变更类型 |
|------|------|----------|
| 配对验证核心 | `src/shared/toolResultPairing.ts` | 新增 |
| 配对验证测试 | `src/shared/toolResultPairing.test.ts` | 新增 |
| 启动清理 | `electron/database/streamingCleanup.ts` | 新增 |
| 启动清理测试 | `electron/database/streamingCleanup.test.ts` | 新增 |
| 消息重建 | `src/shared/claudeToolHistory.ts` | 修改 |
| 消息重建测试 | `src/shared/claudeToolHistory.test.ts` | 修改 |
| IPC 验证集成 | `electron/claudeStreamHandlers.ts` | 修改 |
| 消息序列化 | `electron/messageCodec.ts` | 修改 |
| 飞书远程代理 | `electron/feishu/feishuRemoteAgent.ts` | 修改 |
| 领域类型 | `src/shared/domainTypes.ts` | 修改 |
| 启动入口 | `electron/main.ts` | 修改 |
| 备份管理 | `electron/sessionBackupManager.ts` | 修改 |
| JSON 迁移 | `electron/database/migrateFromJson.ts` | 修改 |
| 请求守卫 | `electron/claudeRequestGuards.ts` | 修改 |

---

## 13. 附录：典型修复场景

> 以下场景采用本项目的数据形态（assistant(tool_use) → user(tool_result) 相邻配对），区别于 Claude Code 的独立消息模型。

### 13.1 场景一：崩溃导致 result 缺失（R5/R8）

**持久化状态**：assistant 消息含 `tc={id:'toolu_a', status:'completed', result:undefined}`（result 因 2s 节流未落盘而缺失）。

**重建后（改造前）**：
```
[0] assistant(use=[toolu_a])
[1] user(result=[{tool_use_id:toolu_a, content:'(无结果)'}])  ← 无 is_error，模型可能臆造
```

**重建后（改造后）**：
```
[0] assistant(use=[toolu_a])
[1] user(result=[{tool_use_id:toolu_a, content:'[Tool result missing due to internal error]', is_error:true}])
```
模型理解为工具失败，倾向重试或报告，而非臆造内容。

### 13.2 场景二：启动清理 streaming 残留（R8/R10）

**持久化状态**（崩溃后）：`Message(status:'streaming', toolCalls:[{id:'toolu_b', status:'calling'}])`。

**启动清理后**：
```
Message(status:'failed', toolCalls:[{id:'toolu_b', status:'failed', result:{success:false, error:'工具调用因应用退出中断'}, interrupted:true, completedAt:<now>}])
```
UI 展示"该回复因应用异常退出中断"，下次重建时该 toolCall 生成合法的 use+result 对（is_error:true），不阻塞会话。

### 13.3 场景三：旁路入口传入孤立 tool_result（R3/R15）

**输入**（`payload.messages` 直传，不规范）：
```
[0] user(result=[toolu_x])  ← 无前置 assistant 的 use
[1] assistant(use=[toolu_y])
[2] user(result=[toolu_y])
```

**`ensureToolResultPairing` 修复后**：
```
[0] user(text='[Orphaned tool result removed due to conversation resume]')
[1] assistant(use=[toolu_y])
[2] user(result=[toolu_y])
```
请求正常发出，不触发 API 400。

### 13.4 场景四：重复 tool_use_id（R2，迁移缺陷引入）

**输入**（两条 assistant 历史含相同 id，迁移/恢复导致）：
```
[0] assistant(use=[toolu_z])
[1] user(result=[toolu_z])
[2] assistant(use=[toolu_z])  ← 重复 ID，API 会 400
[3] user(result=[toolu_z])
```

**修复后**：
```
[0] assistant(use=[toolu_z])
[1] user(result=[toolu_z])
[2] assistant(use=[])  ← 重复 use 去重；若空则占位
[3] user(result=[])    ← 重复 result 去重；若空则占位
```
日志记录 `duplicateToolUseId:1`，提示迁移缺陷。

### 13.5 场景五：反序列化失败（R11）

**持久化状态**：`messages.tool_calls` 列 JSON 损坏。

**改造前**：`deserializeToolCallsFromDb` 返回 `undefined`，assistant 变纯文本，工具上下文静默丢失，无告警。

**改造后**：返回 `[{id:'corrupted-<uuid>', toolName:'unknown', status:'failed', result:{success:false,error:'工具调用记录数据损坏'}, corrupted:true}]`，记录 `db.tool_calls.deserialize_failed` 告警。重建时生成合成错误占位 use+result，配对完整，模型知道该工具损坏。

---

**文档版本**: v1.0  
**创建日期**: 2026-07-03  
**参考来源**: [tool-use-id-pairing-analysis.md](../references/tool-use-id-pairing-analysis.md)（Claude Code `ensureToolResultPairing` 机制分析）  
**核心定位**: 本需求并非照搬 Claude Code 的跨消息配对追踪，而是基于本项目"toolCalls 同数组配对"架构，设计防御性验证管道，重点解决异常数据降级、崩溃恢复与占位符语义规范化。  
**适用范围**: SpaceAssistant — 工具调用 ID 配对防幻觉机制
