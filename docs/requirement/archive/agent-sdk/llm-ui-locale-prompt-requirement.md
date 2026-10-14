# 大模型界面语言引导注入 — 需求规格

**版本：** 1.3  
**日期：** 2026-06-15  
**状态：** 待评审  
**关联文档：** [i18n-architecture-requirement.md](./i18n-architecture-requirement.md)、[session-auto-title-requirement.md](./session-auto-title-requirement.md)、[skill-llm-routing-requirement.md](./skill-llm-routing-requirement.md)、[feishu-integration-requirement.md](./feishu-integration-requirement.md)

**变更记录：**

| 版本 | 日期 | 说明 |
|------|------|------|
| 1.0 | 2026-06-15 | 初稿 |
| 1.1 | 2026-06-15 | 明确 locale 双轨解析与主进程统一注入；补充飞书/无窗口场景；修正 system 拼接顺序；合并发布阶段 |
| 1.2 | 2026-06-15 | 验收以自动化测试为主：原 §13.2 可测项下沉为单测/集成测规格，手工仅保留可选抽检 |
| 1.3 | 2026-06-15 | §15 五项 OQ 全部定稿（见已决事项） |

---

## 目录

1. [概述](#1-概述)
2. [现状与问题](#2-现状与问题)
3. [目标与非目标](#3-目标与非目标)
4. [用户故事](#4-用户故事)
5. [Locale 解析架构（核心）](#5-locale-解析架构核心)
6. [注入策略与模块边界](#6-注入策略与模块边界)
7. [引导文案规格](#7-引导文案规格)
8. [LLM 调用点覆盖表](#8-llm-调用点覆盖表)
9. [优先级与冲突处理](#9-优先级与冲突处理)
10. [System 字段拼接顺序](#10-system-字段拼接顺序)
11. [数据模型与 IPC](#11-数据模型与-ipc)
12. [非功能需求](#12-非功能需求)
13. [测试与验收](#13-测试与验收)
14. [发布计划](#14-发布计划)
15. [已决事项](#15-已决事项)
16. [相关文件](#16-相关文件)

---

## 1. 概述

### 1.1 背景

SpaceAssistant 界面已支持 `zh-CN` / `en-US`（`AppConfig.locale`），但 LLM 的 system 提示未与之联动，导致：

- 英文界面下，模型仍用中文回复或展示中文 thinking；
- 中文界面下，因 Skill / 工具描述等英文上下文，模型偏向英文回复；
- 会话自动标题固定中文 prompt，英文界面下标题语言不一致。

### 1.2 需求摘要

在每次 LLM 请求组装 `system` 时，根据**界面语言**注入 `<ui_locale_preference>` 引导段，要求模型在**可见回复**与 **thinking** 中使用与界面一致的自然语言。

### 1.3 范围

| 在范围内 | 不在范围内 |
|----------|------------|
| 桌面主聊天（流式 / 工具循环） | 工具 `description` 翻译（i18n §5.4，保持英文） |
| 飞书远程 Agent（主进程直调工具循环） | Skill 正文翻译 |
| 会话自动标题 LLM | `config:test-connection` 的 `ping` |
| 共享模块 `src/shared/llmLocalePrompt.ts` | 按用户消息语言自动检测 |
| 主进程统一注入 + 渲染 payload 可选传参 | 新增第三种界面语言（仅预留扩展点） |

---

## 2. 现状与问题

### 2.1 桌面聊天 system 链（有渲染进程）

```
ChatView
  → buildSystemPromptFromSkills / Wiki 附录
  → IPC payload.system

claudeStreamHandlers / toolChatLoop
  → appendAvailableToolsHint（工具循环）
  → buildSystemPrompt（追加 <project_memory>）
  → API
```

**缺口：** 无 locale；`buildSystemPrompt` 只做项目记忆拼接。

### 2.2 主进程直调 LLM（无渲染进程 payload）

| 路径 | 入口 | 特点 |
|------|------|------|
| 飞书远程 Agent | `remoteCommandRouter` → `runFeishuRemoteAgent` → `runToolChatSession` | **不经** `claude-chat-create-with-tools`；主窗口可关闭 |
| 会话标题摘要 | `toolChatLoop` / `session:backfill-auto-title-if-needed` → `sessionTitleSuggest` | 独立 LLM 调用，固定中文 prompt |
| Skill 路由 | `skillRouter.ts` | 输出 JSON，用户不可见（本期不注入） |

**关键结论：** 若仅在渲染进程 payload 传 `locale`，**飞书与标题摘要会漏注入**。必须在主进程**统一注入点**做 locale 解析。

### 2.3 与 i18n 的关系

[i18n-architecture-requirement.md](./i18n-architecture-requirement.md) 规定工具 description 不翻译。本需求只约束**模型输出语言**，不改动工具/Skill 原文。

---

## 3. 目标与非目标

| # | 目标 |
|---|------|
| G1 | `zh-CN` 界面 → 回复与 thinking 默认简体中文 |
| G2 | `en-US` 界面 → 回复与 thinking 默认英文 |
| G3 | 注入逻辑**单点、可测**，桌面与飞书共用同一代码路径 |
| G4 | 切换界面语言后，**下一条**新 LLM 请求生效；不重写历史、不中断进行中流式（§15 D-4） |
| G5 | 会话自动标题等辅助 LLM 产出与界面语言一致 |

**非目标：** 不检测用户消息语言（§15 D-3）；不提供回复语言独立开关（§15 D-1）；不翻译历史/Skill/记忆；不为引导文案建 i18n 资源；不翻译代码块与路径；飞书回复不跟消息语种（§15 D-5）。

---

## 4. 用户故事

### US-01 / US-02：界面语言与回复一致

界面为中文 / 英文时，发往 LLM 的 system 应分别注入中文 / 英文 `<ui_locale_preference>`（§13.2 I1–I2）；用户未显式指定其他语言时，不因消息语种改变注入内容（见 §9）。

### US-03：会话标题语言一致

自动标题的 system 与摘要角色标签随 `AppConfig.locale` 切换（§13.1 T1–T4）；长度仍 ≤15 Unicode 字符。

### US-04：切换语言即时生效

设置切换语言后，新 payload 携带新 `locale` 或 DB 更新后，下一次 `resolveRequestLocale` / `buildFinalSystemPrompt` 使用新值（§13.1 R8、§13.2 I11）。**不重写**历史消息，**不中断、不改写**进行中流式（§15 D-4）。

### US-05：飞书远程与桌面行为一致

> **作为** 启用飞书远程 Agent 的用户  
> **我希望** 飞书触发的 Agent 回复语言与桌面「界面语言」设置一致  
> **即使** 主窗口未打开或渲染进程未参与该次调用

**验收标准（自动化，见 §13.2 I8–I10）：**

- 飞书路径不传 payload.locale，`runToolChatSession` 使用的 system 含与 `readAppLocale(db)` 一致的 `<ui_locale_preference>`；
- 主窗口 `webContents` 为 `null` 时仍走同一注入链（I9）。

---

## 5. Locale 解析架构（核心）

### 5.1 权威来源

**唯一产品语义：** `AppConfig.locale`（`AppLocale = 'zh-CN' | 'en-US'`，`src/shared/locale.ts`）。

| 进程 | 读取方式 |
|------|----------|
| 渲染进程 | `i18n.language` / Redux `config.locale`（与 DB 双写同步） |
| 主进程 | `readAppLocale(db)`（`electron/appIpc.ts`） |

### 5.2 双轨输入、单点解析、统一注入

**禁止**只在 ChatView 拼 payload 时注入 locale——主进程直调路径会遗漏。

采用三层结构：

```
┌─────────────────────────────────────────────────────────────┐
│  输入层（二选一，可并存）                                      │
│  · 渲染 IPC payload.locale（桌面聊天，可选，减少读库）          │
│  · readAppLocale(db)（飞书、标题摘要、payload 缺失时的回退）    │
└──────────────────────────┬──────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  解析层（主进程，单函数）                                       │
│  resolveRequestLocale(payloadLocale, db): AppLocale          │
│    1. isAppLocale(payloadLocale) → 使用 payload              │
│    2. 否则 readAppLocale(db)                                   │
│    3. 仍非法 → detectLocaleFromSystem(app.getLocale())       │
└──────────────────────────┬──────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  注入层（主进程，单函数）                                       │
│  buildFinalSystemPrompt({ system, memory, memoryEnabled,     │
│                           locale })                          │
│    → buildSystemPrompt(...)                                  │
│    → appendUiLocaleSystemHint(result, locale)                │
└─────────────────────────────────────────────────────────────┘
```

### 5.3 各调用路径的 locale 来源

| 调用路径 | payload.locale | 实际生效来源 |
|----------|----------------|--------------|
| 桌面 · 工具循环 | 渲染进程传入（推荐） | payload 优先；缺省读 DB |
| 桌面 · 纯流式 | 同上 | 同上 |
| 飞书远程 Agent | **无** | **仅** `readAppLocale(db)` |
| 会话标题摘要 | **无** | **仅** `readAppLocale(db)` |
| 主窗口未打开 | 无 | **仅** `readAppLocale(db)` |

> **实现要点：** `buildFinalSystemPrompt` 在 `toolChatLoop.ts` 每轮 loop 内调用；`claudeStreamHandlers` 的 `runSendStream` 同样调用。飞书只需继续走 `runToolChatSession`，**无需**在 `feishuRemoteAgent` 单独维护一套注入逻辑——但必须保证 `runToolChatSession` 能拿到 `db` 并调用 `resolveRequestLocale`。

### 5.4 payload 传 locale 的价值（非必须，但推荐）

渲染进程传入 `locale` 的作用：

- 与用户当前 `i18n.language` 对齐，避免「刚改语言、DB 写入尚未完成」的极短窗口读库滞后（**此窗口内以 payload 为准**，§15 D-2）；
- 日志中可对比 payload 与 DB 是否一致，便于排障。

**不传 payload 时**行为仍须正确——主进程回退 DB 是硬性要求。 **同时存在合法 payload 与 DB 且不一致时，以 payload 为准**（§15 D-2）。

### 5.5 非法值

- 不阻断 LLM 调用；
- 非法 `payload.locale` 忽略，走 DB → 系统语言 → `'zh-CN'` 回退链。

---

## 6. 注入策略与模块边界

### 6.1 共享模块（`src/shared/llmLocalePrompt.ts`，新建）

```typescript
/** 生成 <ui_locale_preference> 段落 */
export function buildUiLocaleSystemHint(locale: AppLocale): string

/** 追加到已有 system；空 system 时仅返回引导段 */
export function appendUiLocaleSystemHint(
  system: string | undefined,
  locale: AppLocale
): string | undefined
```

- 使用 XML 包裹：`<ui_locale_preference>...</ui_locale_preference>`
- **不**走 i18n `t()`：内容为模型指令，非 UI 文案

### 6.2 主进程模块（`electron/llmSystemPrompt.ts`，新建，推荐）

```typescript
export function resolveRequestLocale(
  payloadLocale: unknown,
  db: AppDatabase
): AppLocale

export function buildFinalSystemPrompt(args: {
  system?: string
  memoryContent: string | null
  memoryEnabled: boolean
  locale: AppLocale
}): string | undefined
```

**调用方改造：**

| 文件 | 改动 |
|------|------|
| `electron/toolChatLoop.ts` | 每轮 `loopRound`：`locale = resolveRequestLocale(args.locale, appDb)` → `buildFinalSystemPrompt` |
| `electron/claudeStreamHandlers.ts` | `runSendStream` / `create-with-tools` 入口解析 locale 并下传 |
| `electron/sessionTitleSuggest.ts` | `locale = readAppLocale(db)`；标题 system / 角色标签按 locale 分支 |
| `electron/feishu/feishuRemoteAgent.ts` | **无需单独注入**；确保 `runToolChatSession` 收到 `appDb`（已有） |

### 6.3 渲染进程（薄层）

| 文件 | 改动 |
|------|------|
| `src/shared/api.ts` | payload 增加 `locale?: AppLocale` |
| `src/renderer/services/chatToolSessionService.ts` | `buildToolChatPayload` 填入 `i18n.language` |
| `src/renderer/components/Chat/ChatView.tsx` | 流式分支同样传 `locale` |

### 6.4 本期不注入

| 模块 | 原因 |
|------|------|
| Skill 路由 `skillRouter.ts` | 输出 JSON；P2 再评估 |
| `config:test-connection` | 无用户可见生成内容 |

---

## 7. 引导文案规格

### 7.1 主聊天 / Agent 循环

引导段**统一用英文撰写**（模型指令稳定性），按 locale 约束**输出语言**：

**`zh-CN`：**

```text
<ui_locale_preference>
The user's application interface language is Simplified Chinese (zh-CN).
You MUST write all user-visible assistant replies and all thinking/reasoning blocks in Simplified Chinese.
Keep code snippets, file paths, command lines, and proper nouns in their original form; do not translate them.
If the user explicitly asks you to use another language for the reply, follow the user's explicit instruction for that message.
</ui_locale_preference>
```

**`en-US`：**

```text
<ui_locale_preference>
The user's application interface language is English (en-US).
You MUST write all user-visible assistant replies and all thinking/reasoning blocks in English.
Keep code snippets, file paths, command lines, and proper nouns in their original form; do not translate them.
If the user explicitly asks you to use another language for the reply, follow the user's explicit instruction for that message.
</ui_locale_preference>
```

### 7.2 会话标题摘要

| locale | system 要点 |
|--------|-------------|
| `zh-CN` | 维持现有：≤15 Unicode 字符；只输出主题，无标点（见 `sessionTitleSuggest.ts` 现有文案） |
| `en-US` | `Summarize the conversation topic in at most 15 Unicode characters, in English. Output only the title text, no punctuation or explanation.` |

角色标签：

| locale | user | assistant |
|--------|------|-----------|
| `zh-CN` | `用户：` | `助手：` |
| `en-US` | `User: ` | `Assistant: ` |

---

## 8. LLM 调用点覆盖表

| 优先级 | 调用点 | 模块 | locale 来源 | 注入方式 |
|--------|--------|------|-------------|----------|
| P0 | 工具循环（含飞书） | `toolChatLoop.ts` | `resolveRequestLocale` | `buildFinalSystemPrompt` |
| P0 | 纯流式聊天 | `claudeStreamHandlers.ts` | 同上 | 同上 |
| P0 | 飞书远程 Agent | `feishuRemoteAgent.ts` | DB 回退（无 payload） | 经 `runToolChatSession` 统一注入 |
| P0 | 会话标题 | `sessionTitleSuggest.ts` | `readAppLocale(db)` | 独立标题 prompt 模板 |
| P1 | 渲染 payload | `chatToolSessionService.ts` / `ChatView.tsx` | `i18n.language` | 传入 IPC，供解析层优先使用 |
| — | Skill 路由 | `skillRouter.ts` | — | 本期不做 |
| — | 连接测试 | `appIpc.ts` | — | 不做 |

---

## 9. 优先级与冲突处理

| 优先级 | 规则 |
|--------|------|
| 1 | 用户在**当前消息**显式指定回复语言 → 以用户要求为准 |
| 2 | **界面语言**（`AppConfig.locale`；桌面聊天有 payload 时见 §5.2、`resolveRequestLocale`）→ 默认回复与 thinking 语言 |
| 3 | 用户消息语种（含第三语言）、历史对话语种、Skill 语言、飞书消息语种 → **不作为**自动检测依据 |

**默认语言（已定稿）：** 无论用户输入何种语言，只要未触发优先级 1，**始终**跟桌面界面语言（§15 D-3、D-5）。

**切换界面语言（已定稿）：** 不重写历史消息，不中断、不改写进行中的流式传输；仅切换**之后新发起**的 LLM 请求使用新 locale 引导（§15 D-4）。

**飞书（已定稿）：** 飞书远程 Agent 与桌面一致，**始终**以 `AppConfig.locale` 为准，不检测飞书消息语种（§15 D-5）。

**代码与技术内容：** 不翻译代码块、路径、命令行。

---

## 10. System 字段拼接顺序

### 10.1 桌面聊天 / 工具循环（含飞书经 `runToolChatSession`）

最终 API `system` 自上而下：

```
1. 渠道 / 业务 system 基底
     · 桌面：Skill 聚合 + Wiki 附录（渲染进程组装，经 payload.system 传入）
     · 飞书：buildFeishuRemoteSystemAppendix（主进程组装为 system 基底）
2. 可用工具名称提示（appendAvailableToolsHint，仅工具循环）
3. 恢复 Skill 后缀（recoverySkillSystemSuffix，仅异常恢复）
4. 项目记忆 <project_memory>...</project_memory>
5. 界面语言引导 <ui_locale_preference>...</ui_locale_preference>   ← 本需求，始终最后
```

**语言引导置末：** 靠近生成起点，强化输出约束；不干扰 Skill / 记忆等事实上下文。飞书附录在步骤 1，**不在** locale 引导之后。

### 10.2 会话标题摘要

独立请求，仅含 locale 化后的标题 system + user 摘要体，不参与主聊天拼接链。

---

## 11. 数据模型与 IPC

### 11.1 Payload 扩展

```typescript
// src/shared/api.ts
export type ClaudeChatSendStreamPayload = {
  // ...existing
  locale?: AppLocale
}

export type ClaudeChatCreateWithToolsPayload = {
  // ...existing
  locale?: AppLocale
}
```

### 11.2 `runToolChatSession` 参数扩展（内部）

```typescript
// 建议在下述 args 中增加可选 locale，供 resolveRequestLocale 使用
locale?: AppLocale  // 来自 IPC payload；飞书路径不传
```

### 11.3 日志

- `logAgentEvent('llm.request', ...)` 增加 `locale` 字段；
- `system` 已含 `<ui_locale_preference>`，脱敏策略不变。

### 11.4 配置项

- **不提供**「回复语言是否跟随界面」类设置开关；locale 引导**始终**注入，且始终与界面语言一致（§15 D-1）。
- **不新增** `AppConfig.llmFollowUiLocale` 或同类字段。

---

## 12. 非功能需求

| 项 | 要求 |
|----|------|
| Token | 单条引导约 80–120 tokens |
| 性能 | 字符串拼接 + 可选读库，无额外 IPC |
| 兼容性 | 旧 payload 无 `locale` 时回退 DB |
| 可测试性 | 见 §13；**禁止**以「需连真实 LLM 才可验收」作为合入条件 |
| 扩展性 | 新 `AppLocale` 仅在 `llmLocalePrompt.ts` 增分支 |

---

## 13. 测试与验收

**原则：** 本功能验收以 **`npm test` 自动化** 为准。不调用真实 LLM API；通过断言 **system 注入内容、locale 解析路径、payload 字段、拼接顺序** 证明行为正确。模型是否 100% 遵循 prompt 属模型能力，**不作为** CI 阻塞项。

**合入门槛：** §13.1 + §13.2 全部 P0 用例通过。

### 13.1 纯函数单测（P0）

#### `src/shared/llmLocalePrompt.test.ts`

| # | 用例 | 对应原手工项 |
|---|------|--------------|
| L1 | `buildUiLocaleSystemHint('zh-CN')` 含 `Simplified Chinese` 与 `<ui_locale_preference>` | — |
| L2 | `buildUiLocaleSystemHint('en-US')` 含 `English (en-US)` | — |
| L3 | 两种 locale 的 hint 均含显式语言覆盖例外句（`explicitly asks`） | 原 #3（指令层） |
| L4 | `appendUiLocaleSystemHint('base', locale)` → `base` 在前、`<ui_locale_preference>` 在后 | — |
| L5 | `appendUiLocaleSystemHint(undefined, locale)` 仅返回引导段 | — |

#### `electron/llmSystemPrompt.test.ts`

| # | 用例 | 对应原手工项 |
|---|------|--------------|
| R1 | `resolveRequestLocale('en-US', db)` → `'en-US'`（payload 优先） | 原 #2 |
| R2 | `resolveRequestLocale(undefined, db)` → `readAppLocale(db)` 返回值 | 原 #7 |
| R3 | `resolveRequestLocale('invalid', db)` → 回退 DB，不抛错 | — |
| R4 | DB 无合法 locale 时回退 `detectLocaleFromSystem` | — |
| R5 | `buildFinalSystemPrompt({ locale: 'zh-CN', memoryEnabled: false })` 含中文引导、无 `<project_memory>` | 原 #1（注入层） |
| R6 | `buildFinalSystemPrompt({ locale: 'en-US', memoryEnabled: true, memoryContent: '…' })` 顺序为 memory 块 **在前**、locale 引导 **在后** | §10 顺序 |
| R7 | `memoryEnabled: false` 时仍有 locale 引导 | 回归 |
| R8 | 连续两次调用、`locale` 从 `zh-CN` 改为 `en-US` → 第二次 hint 为英文 | 原 #4（解析层） |

#### `electron/sessionTitleSuggest.test.ts`（扩展）

| # | 用例 | 对应原手工项 |
|---|------|--------------|
| T1 | `getTitleSystemPrompt('zh-CN')` 与现有中文文案一致 | — |
| T2 | `getTitleSystemPrompt('en-US')` 含 `in English` 与 15 Unicode 字符限制 | 原 #5 |
| T3 | `buildTitleSuggestDialogueText(..., locale: 'en-US')` 使用 `User:` / `Assistant:` 前缀 | 原 #5 |
| T4 | `buildTitleSuggestDialogueText(..., locale: 'zh-CN')` 仍使用 `用户：` / `助手：` | — |

> 实现时将标题 system / 角色标签提取为按 `AppLocale` 分支的可测函数（如 `getTitleSystemPrompt`、`formatTitleDialogueLabel`），避免仅在内联常量中测不到。

### 13.2 集成 / 接线单测（P0，mock LLM）

以下测试 **mock** `client.messages.stream` / `messages.create`，捕获传入的 `system` 或 `logAgentEvent('llm.request')` 参数，**不发起网络请求**。

#### `electron/toolChatLoop.locale.test.ts`（新建）

| # | 用例 | 对应原手工项 |
|---|------|--------------|
| I1 | `runToolChatSession({ locale: 'zh-CN', ... })` → 发往 API 的 `system` 含 `<ui_locale_preference>` 且为中文约束 | 原 #1 |
| I2 | `runToolChatSession({ locale: 'en-US', ... })` → 同上，英文约束 | 原 #2 |
| I3 | `runToolChatSession` 未传 `locale`、`appDb` 中 `config.locale = 'zh-CN'` → system 含中文引导 | 原 #7 |
| I4 | 工具循环 `loopRound ≥ 2` 时，每轮请求的 `system` 均含 locale 引导（非仅首轮） | — |
| I5 | `projectMemoryEnabled: false` 时仍注入 locale | 回归 |

#### `electron/claudeStreamHandlers.locale.test.ts`（新建）

| # | 用例 | 对应原手工项 |
|---|------|--------------|
| I6 | `runSendStream` + payload `locale: 'en-US'` → stream 参数含英文引导 | 原 #2 |
| I7 | `claude-chat-create-with-tools` handler 将 payload.locale 传入 `runToolChatSession` | — |

#### `electron/feishu/feishuRemoteAgent.test.ts`（新建）

| # | 用例 | 对应原手工项 |
|---|------|--------------|
| I8 | mock `runToolChatSession`，`readAppLocale` 返回 `en-US`，**不传** payload locale → `runToolChatSession` 被调用且最终 `system`（经 mock 回调或 spy 拼接结果）含英文引导 | 原 #6 |
| I9 | `getMainWebContents()` 返回 `null` 时仍调用 `runToolChatSession` 且 locale 来自 DB（非渲染进程） | 原 #6 |
| I10 | 飞书 `buildFeishuRemoteSystemAppendix` 内容在 `<ui_locale_preference>` **之前** | 回归 / §10 |

#### `src/renderer/services/chatToolSessionService.test.ts`（扩展）

| # | 用例 | 对应原手工项 |
|---|------|--------------|
| I11 | `buildToolChatPayload({ locale: 'en-US', ... })` → payload.locale === `'en-US'` | 原 #4（payload 层） |
| I12 | 未显式传 `locale` 时，调用方（ChatView 集成点）从 `i18n.language` 填入 — 可在 `ChatView` 抽 `resolveChatLocale()` 后单测 | 原 #4 |

### 13.3 不在自动化范围内的行为

| 项 | 原因 | 处理 |
|----|------|------|
| 真实 LLM 回复/thinking 是否为目标语言 | 依赖模型与网关，非确定性 | **不做** CI 断言 |
| 用户说「请用英文回答」后模型是否改英文 | 同上；§13.1 L3 仅验证 prompt 含例外指令 | 可选发版前抽检 |
| 进行中流式不因切换语言而中断 | §15 D-4：本需求不改流式生命周期，属既有行为 | **无需**专项验收；D-4 写入 §9 作产品约束 |
| Skill / Wiki 渲染侧拼接 | 本需求不改其顺序 | 现有测试覆盖；§13.2 I10 覆盖飞书侧 |

### 13.4 可选手工抽检（非合入门槛）

发版前 **0–1 次**，连真实 API 快速目视（每项 ≤1 分钟，可跳过）：

1. 中文界面发一条消息，目视回复大致为中文  
2. （若当日改动了飞书路径）飞书触发一条远程 Agent，目视摘要语言与设置一致  

### 13.5 实现反模式（禁止）

| 反模式 | 后果 |
|--------|------|
| 仅在 `ChatView` / payload 层注入 locale | 飞书、标题摘要漏注入 |
| 在 `feishuRemoteAgent` 复制一份注入逻辑 | 双份维护，易不一致 |
| 仅依赖渲染进程 `i18n`、主进程不读 DB | 主窗口关闭时飞书无 locale |
| 把飞书附录放在 `<ui_locale_preference>` 之后 | 与现有飞书 system 语义冲突，削弱语言约束 |

---

## 14. 发布计划

| 阶段 | 内容 | 优先级 |
|------|------|--------|
| **Phase 1** | `llmLocalePrompt.ts` + `llmSystemPrompt.ts` + `buildFinalSystemPrompt` / `resolveRequestLocale` | P0 |
| **Phase 2** | `toolChatLoop` / `claudeStreamHandlers` 接入（**含飞书路径**，无需单独 Phase） | P0 |
| **Phase 3** | 渲染 payload 传 `locale` + `sessionTitleSuggest` locale 化 + §13 自动化测试 | P0 / P1 |
| **Phase 4** | Skill 路由 prompt 多语言（若需要） | P2 |

> 飞书与桌面共用 Phase 2 的 `runToolChatSession` 注入，**不应**拆到独立后期阶段。

---

## 15. 已决事项

以下原「待解决问题」已于 **2026-06-15** 定稿，实现与测试须遵循；若需变更须新开需求评审。

| ID | 问题 | **决定** |
|----|------|----------|
| D-1（原 OQ-1） | 设置中是否提供「回复语言跟随界面」开关 | **不提供**。始终注入 locale 引导，行为与界面语言绑定；不提供关闭或独立配置项。 |
| D-2（原 OQ-2） | `payload.locale` 与 DB 短暂不一致时以谁为准 | **`payload.locale` 优先**。合法 payload 值直接使用；缺失或非法时回退 `readAppLocale(db)`。飞书 / 标题摘要等无 payload 路径仅读 DB。 |
| D-3（原 OQ-3） | 用户消息为其他语言且未显式指定回复语言 | **始终默认跟界面语言**。不检测、不推断用户消息语种；仅 §9 优先级 1（单条消息显式指定）可覆盖。 |
| D-4（原 OQ-4） | 切换界面语言后对已有会话的影响 | **不重写**历史消息；**不中断、不改写**进行中的流式传输；仅切换**之后新产生**的 LLM 请求携带新 locale 引导。 |
| D-5（原 OQ-5） | 飞书消息语言 vs 桌面界面语言 | **始终以桌面界面语言**（`AppConfig.locale`）为准；不随飞书消息语种变化。 |

---

## 16. 相关文件

| 类型 | 路径 |
|------|------|
| Locale 类型 | `src/shared/locale.ts` |
| 引导文案（新建） | `src/shared/llmLocalePrompt.ts` |
| 解析与拼接（新建） | `electron/llmSystemPrompt.ts` |
| IPC 类型 | `src/shared/api.ts` |
| 渲染入口 | `src/renderer/components/Chat/ChatView.tsx` |
| Payload | `src/renderer/services/chatToolSessionService.ts` |
| 项目记忆 | `electron/projectMemory.ts` |
| 流式 / 工具 IPC | `electron/claudeStreamHandlers.ts` |
| 工具循环（**统一注入点**） | `electron/toolChatLoop.ts` |
| 标题摘要 | `electron/sessionTitleSuggest.ts` |
| 飞书远程 | `electron/feishu/remoteCommandRouter.ts`、`feishuRemoteAgent.ts` |
| Locale 读库 | `electron/appIpc.ts` → `readAppLocale` |
| 测试（新建/扩展） | §13.1–§13.2 所列 `*.test.ts` |
