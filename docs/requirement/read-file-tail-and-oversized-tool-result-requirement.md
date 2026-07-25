# read_file 末尾读取与超长 tool_result 降级 — 产品需求文档

**版本：** 1.1  
**日期：** 2026-07-25  
**状态：** 待评审（已按 [评审意见](../review/read-file-tail-and-oversized-tool-result-requirement-review.md) 修订 P0-1）  

**关联文档：**
- [tools-requirement.md](./tools-requirement.md)（`read_file` 工具定义、输出限制）
- [tool-use-id-pairing-requirement.md](./tool-use-id-pairing-requirement.md)（`tool_result` 配对与占位语义）
- [read-file-tail-and-oversized-tool-result-requirement-review.md](../review/read-file-tail-and-oversized-tool-result-requirement-review.md)（需求评审）

**触发背景（2026-07-25 Agent 日志事故）：**
1. Agent 对 `.agent/logs/Agent-*.log` 调用 `read_file` 且未带分页参数，系统按「前 2MB 截断」返回全文前缀；该前缀含旧会话完整 `llm.request.messages`，模型将嵌套历史中的旧用户话语误判为当前问题（答非所问）。
2. 同一超长 `tool_result` 在下一轮被 `assertValidClaudeContentBlocks` 以 `tool_result content too long` 硬拒绝，后续会话直接失败。

本需求**仅覆盖**下列两项修复；日志脱敏、各执行器内部主动截断等不在本期范围（见 §3.2）。**工具循环出站压缩是验收硬项**（见 §5.4 闸 3）。

---

## 目录

1. [概述](#1-概述)
2. [现状与问题](#2-现状与问题)
3. [目标与非目标](#3-目标与非目标)
4. [需求 A：read_file 增加 tail 与大文件默认行为](#4-需求-aread_file-增加-tail-与大文件默认行为)
5. [需求 B：超长 tool_result 出站压缩降级](#5-需求-b超长-tool_result-出站压缩降级)
6. [常量与契约](#6-常量与契约)
7. [实现落点](#7-实现落点)
8. [测试计划](#8-测试计划)
9. [验收标准](#9-验收标准)
10. [相关文件](#10-相关文件)
11. [附录：事故复现要点](#11-附录事故复现要点)
12. [修订记录](#12-修订记录)

---

## 1. 概述

### 1.1 背景

`read_file` 当前支持 `offset` / `limit` 按行分页，但：

- **无法高效读文件末尾**（日志分析的高频场景）；
- **大文件无分页参数时**仍会读入并截断前 `READ_FILE_MAX_CHARS`（2MB）返回，既浪费上下文，又把「旧日志前缀」误当成「最新问题现场」；
- **字符截断发生在按行切片之前**，导致分页语义在超大文件上失真（只能在前 2MB 内分页）。

同时，发往 LLM 的 `tool_result.content` 若超过 `MAX_TOOL_RESULT_CONTENT_CHARS`，校验层直接抛错，整轮请求失败。更关键的是：同一次工具循环内新产生的超长结果会直接进入内存中的 `messagesForApi` 并在下一轮 `stream`，**不会**再走 IPC 入口校验——仅修历史路径仍会出现「本轮成功、下轮必炸」。

### 1.2 产品价值

| 价值 | 说明 |
|------|------|
| 日志可读 | Agent 可用 `tail` 稳定取「最近 N 行」，按时间正序返回，符合排障习惯 |
| 防上下文污染 | 大文件禁止静默塞入前 2MB，迫使模型显式分页或 `tail` |
| 会话可续 | 历史中已存在的超长 `tool_result` 不再整会话报错，改为可识别的省略标记 |
| 语义正确 | 先定位行范围，再做字符截断，分页与末尾读取行为可预期 |

---

## 2. 现状与问题

### 2.1 read_file

| # | 现状 | 问题 |
|---|------|------|
| R1 | 仅有 `offset`（1-based）+ `limit` | 读末尾需先知道总行数，或反复猜 offset；大日志几乎不可用 |
| R2 | 全文读入内存后 `slice(0, READ_MAX)`，再做行切片 | 超大文件内存峰值高；分页只能覆盖文件前缀 |
| R3 | 无范围参数时返回截断后的前 2MB | Agent 常误以为已读「最新日志」，实际是旧内容；易引发答非所问 |
| R4 | 工具描述鼓励大文件用 offset/limit，但执行器仍允许无参大读 | 描述与行为不一致，模型易走错路径 |

### 2.2 超长 tool_result

| # | 现状 | 问题 |
|---|------|------|
| T1 | `buildToolResultBlock` 将 `tc.result.data` 原样 `JSON.stringify` | 历史成功结果可远超 API 块上限 |
| T2 | `assertValidClaudeContentBlocks` 对超长 `tool_result` **throw** | 用户继续对话即失败（`tool_result content too long`） |
| T3 | 校验发生在发往 API 前，无降级路径 | 与「配对修复默认继续」原则不一致：本可省略内容，却选择整轮失败 |

---

## 3. 目标与非目标

### 3.1 目标

| # | 目标 |
|---|------|
| O-01 | `read_file` 新增 `tail`：返回文件**末尾**至多 N 行，内容按文件内原有顺序（时间正序）排列 |
| O-02 | `tail` 与 `offset` / `limit` **互斥**；`offset` **禁止负数** |
| O-03 | 单次行窗口最大 `READ_FILE_MAX_LINE_LIMIT`（2000）；选中内容仍受字符上限约束 |
| O-04 | `tail` 从文件末尾**分块**读取，禁止为取末尾而整文件载入内存 |
| O-05 | 大文件且未提供 `offset` / `limit` / `tail` 时，**不**返回前 2MB 正文，改为返回体积等元数据 + 引导文案 |
| O-06 | 所有带范围读取：先定位行范围，再对范围内文本做字符截断 |
| O-07 | 凡发往 LLM API 的 `tool_result.content`（含**历史重建、IPC 旁路、同一次工具循环内新产生的结果**），超限时一律压缩为省略标记；**不抛错、不阻断会话** |

### 3.2 非目标（本期不做）

| 项 | 说明 |
|----|------|
| Agent 日志字段瘦身 | 不改 `llm.request` / `tool.result` 全量落盘策略（可另开需求） |
| 各执行器内部主动截断 | **不要求**每个工具执行器各自截断输出；统一在工具循环 / 历史重建 / 出站校验三处做压缩即可（见 §5.4） |
| 负 offset 语义 | 不采用「offset=-N 表示从末尾」；末尾读取统一用 `tail` |
| 按字节的 `tailBytes` | 本期仅按行 |
| 修改库内已持久化的 `ToolCallRecord.result` | 降级仅作用于**出站 API messages**；DB / UI 侧可保留原始大结果（便于展示与导出） |
| 上下文总 token 预算 / 自动摘要整段对话 | 超出本需求范围 |

---

## 4. 需求 A：read_file 增加 tail 与大文件默认行为

### 4.1 工具参数契约

在现有 `path` / `offset` / `limit` 上增加：

| 参数 | 类型 | 必填 | 约束 | 语义 |
|------|------|------|------|------|
| `path` | string | 是 | 相对工作目录 | 不变 |
| `offset` | integer | 否 | **≥ 1** 的整数；上限与现有 `toolInputGuards` 一致 | 1-based 起始行（含） |
| `limit` | integer | 否 | 1～`READ_FILE_MAX_LINE_LIMIT` | 最多读取行数 |
| `tail` | integer | 否 | 1～`READ_FILE_MAX_LINE_LIMIT` | 取文件**最后** N 行 |

**互斥规则（入参校验，失败则工具返回 `success: false`）：**

1. 若同时出现 `tail` 与（`offset` 或 `limit`）→ 错误：`"tail 不能与 offset/limit 同时使用"`。
2. 若 `offset` 为负数或非正整数 → 错误（沿用/收紧现有 guard：禁止负数，不得静默取模）。
3. `tail` / `limit` 超出 `READ_FILE_MAX_LINE_LIMIT` → 错误。

**工具 description 文案（须更新）：**

- 明确大文件应使用 `offset`+`limit` 或 `tail`；
- 明确无分页参数时，超过字符上限的文件**不会**返回正文前缀，只会返回元数据提示；
- 明确 `tail` 返回末尾行且顺序为正序。

### 4.2 三种读取模式

```
输入
 ├─ 有 tail                    → Tail 模式（§4.3）
 ├─ 有 offset 或 limit         → Range 模式（§4.4）
 └─ 皆无
      ├─ 文件字符数 ≤ READ_FILE_MAX_CHARS → Full 模式（全文）
      └─ 否则                              → Meta 模式（§4.5，不返回正文）
```

> **判定「文件字符数」**：以 UTF-8 解码后的字符长度为准（与现有 `READ_FILE_MAX_CHARS` 语义一致）。实现上可用 `stat.size` 做**快速上界预判**（`size > READ_FILE_MAX_CHARS` 字节则一定超限），边界附近再按需解码确认；不得为 Meta 判定而整文件解码进内存。

### 4.3 Tail 模式

#### 4.3.1 行为

1. 从文件末尾向前以固定块大小读取（建议 64KiB～256KiB，实现可选常量），累计换行直至凑满 `tail` 行，或到达文件开头。
2. 将收集到的行按文件内顺序拼接（**正序**，不是倒序输出）。
3. 保留源文件主换行风格（`\n` / `\r\n`），与现有 `detectTextEol` / `sliceFileLines` 策略一致。
4. 对拼接后的 `content` 再施加字符上限：若超出 `READ_FILE_MAX_CHARS`，截断并设 `truncated: true`（截断策略见 §4.6）。

#### 4.3.2 成功返回 `data` 字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `path` | string | 相对路径 |
| `content` | string | 末尾窗口正文（正序） |
| `encoding` | `"utf8"` | 与现网一致 |
| `linesReturned` | number | 实际返回行数（≤ `tail`） |
| `hasMoreBefore` | boolean | 文件开头方向是否还有未返回内容（未读到文件头，或因字符截断丢掉窗口前部时为 true） |
| `truncated` | boolean | 是否因字符上限截断 |
| `note` | string? | 截断或未读满时的提示（可选但推荐） |
| `startLine` / `endLine` / `totalLines` | number? | **可选**。若实现未扫描全文，**不得**捏造 `totalLines`；可省略，或仅在小文件/已扫描时提供 |

> **明确禁止**：为填充 `totalLines` 而对多 GB 日志做全文件行扫描。

#### 4.3.3 与 fileStateCache

与现有「带 range 的 read」一致：标记为 range/partial 视图（`isRangeView` / `isPartial`），不得用 tail 窗口覆盖此前完整读取缓存内容（沿用 `recordReadFileCache` 已有策略）。

### 4.4 Range 模式（offset / limit）修复

**必须调整执行顺序：**

```
错误（现状）:
  readAll → charTruncate(READ_MAX) → sliceLines(offset, limit)

正确（本期）:
  定位行窗口（流式或按行索引，见下）→ 得到窗口文本
  → 若窗口文本长度 > READ_FILE_MAX_CHARS → 截断并 truncated=true
```

实现要求：

- **不得**先把整文件截成前 2MB 再分页（否则无法读到文件后半段）。
- 允许实现选择：
  - **小文件**（`stat.size` 明显安全）：一次读入后 `sliceFileLines`；
  - **大文件**：流式/分块按行跳过至 `offset`，再读 `limit` 行（推荐与 tail 共用行缓冲工具）。
- 现有返回字段 `totalLines` / `startLine` / `endLine` / `hasMore` 保持兼容；大文件若无法廉价得到精确 `totalLines`，允许：
  - 优先保证窗口正确；
  - `totalLines` 在未能全量计数时省略，或文档化为「仅小文件保证」——**须在实现与测试中二选一并写进偏差表**。本期推荐：**大文件 Range 可不返回精确 `totalLines`，但必须返回 `hasMore`（是否还有后续行）与 `startLine`/`endLine`（窗口内相对/绝对行号策略与现网一致时优先绝对 1-based）**。

### 4.5 Meta 模式（大文件无范围参数）

当判定文件超过 `READ_FILE_MAX_CHARS` 且未提供 `offset`/`limit`/`tail`：

- `success: true`（这是合法、可操作的结果，不是路径错误）
- `data` **不含**大段 `content`（`content` 为空字符串或不返回正文；推荐 `content: ""` 以保持字段稳定）
- 至少包含：

| 字段 | 说明 |
|------|------|
| `path` | 相对路径 |
| `encoding` | `utf8` |
| `byteSize` | `stat.size` |
| `exceedsReadLimit` | `true` |
| `maxChars` | `READ_FILE_MAX_CHARS` |
| `note` | 明确提示使用 `tail` 或 `offset`+`limit` 分段读取（中文，可含示例） |

示例 `note`：

```text
文件超过 read_file 单次字符上限（2097152），未返回正文。请使用 tail（如 tail=200 读末尾）或 offset+limit 分段读取。
```

### 4.6 字符截断规则（所有模式共用）

1. 截断对象是**已选定窗口**的文本，不是「整文件前缀再切片」。
2. 截断后必须 `truncated: true`，并在 `note` 中说明已截断。
3. Tail 模式下因字符截断丢掉窗口前部时：`hasMoreBefore` 必须为 `true`（即使物理上已凑满 `tail` 行）。
4. 二进制检测、目录路径错误、工作目录越界等行为不变。

### 4.7 入参校验落点

- `electron/toolInputGuards.ts`：`tail` 校验、互斥、禁止负 `offset`。
- `src/shared/builtinToolDefinitions.ts`：schema + description。
- 共享行读取辅助（建议扩展 `src/shared/readFileRange.ts` 或新增 `readFileTail.ts`）：纯函数可单测的「从文本尾部取 N 行」；**文件流式尾读**放在 `electron/tools/builtinExecutors.ts`（或同目录新模块）。

---

## 5. 需求 B：超长 tool_result 出站压缩降级

### 5.1 问题定义

「超长」指：即将发给 LLM 的某个 `tool_result` block 的 `content`（string）长度 **> `MAX_TOOL_RESULT_CONTENT_CHARS`**。

典型来源：

- DB 中已持久化的巨大 `ToolCallRecord.result.data`（例如曾成功返回近 2MB 的 `read_file`）；
- `payload.messages` 直传旁路；
- 配对修复之后仍保留的超长真实 result；
- **同一次工具循环内** `formatToolResultPayload` 刚写入 `messagesForApi`、下一轮直接 `client.messages.stream` 的超长结果（**不会**再走 IPC 入口的 `normalizeAndValidateClaudeMessagesWithContentBlocks`）。

### 5.2 目标行为

| 场景 | 行为 |
|------|------|
| 超长 `tool_result` | **压缩替换**为省略标记，保留 `tool_use_id` 与块结构 |
| 会话连续性 | **不抛** `tool_result content too long`；请求可继续 |
| 可观测性 | 记录 warn 级日志（含 sessionId、tool_use_id、originalLength、替换后长度；实时循环路径至少含 requestId/sessionId/toolUseId） |
| 持久化 | **默认不改写** SQLite 中的原始 `result`（UI 仍可展示完整结果，若 UI 另有长度限制则沿用 UI 侧逻辑） |
| 实时循环 | 本轮工具产出超限内容时，**写入 `toolResults` / 追加进 `messagesForApi` 之前**即已压缩，保证下一轮 `stream` 收到的 content 合规 |

### 5.3 省略标记格式

引入明确、模型可识别的占位（常量名建议 `OVERSIZED_TOOL_RESULT_PLACEHOLDER` 或带长度元数据的模板）：

```text
[tool_result omitted: content exceeded limit; originalLength={n}; maxChars={MAX_TOOL_RESULT_CONTENT_CHARS}]
```

约束：

1. 占位串本身长度必须 **远小于** `MAX_TOOL_RESULT_CONTENT_CHARS`。
2. 与 `SYNTHETIC_TOOL_RESULT_PLACEHOLDER`（缺失结果）语义区分：本占位表示「曾有真实结果但因过长省略」，**不是**配对失败。
3. `is_error`：**建议对原成功结果保持 `false`**（省略是出站预算策略）。若原 block / 错误结果已是 `is_error: true`，保持 `true`，仅替换 `content`。
4. 不得删除整个 `tool_result` block（避免破坏 pairing）。

可选增强（非必须）：保留头部预览（如前 2KB）+ 占位尾注。本期 **MVP 允许整段替换为占位**，以降低实现复杂度；若做预览，总长仍须 ≤ 上限。

### 5.4 插入点（三道闸，缺一不可）

提取共享 helper（建议命名 `compactOversizedToolResultContent(content, context?)`），三处复用同一实现与同一占位文案：

```
【路径甲：会话续聊 / IPC 入口】
持久化 ToolCallRecord
        │
        ▼
buildToolResultBlock / buildClaudeToolChatMessages   ← 闸 1：生成 content 时若超限则产出占位
        │
        ▼
ensureToolResultPairing（既有）
        │
        ▼
normalizeAndValidateClaudeMessagesWithContentBlocks
  └─ assertValidClaudeContentBlocks                 ← 闸 2：发现超长则原地压缩，禁止 throw
        │
        ▼
发往 LLM API


【路径乙：同一次工具循环内】
工具执行器返回 execResult
        │
        ▼
formatToolResultPayload(execResult)
        │
        ▼
compactOversizedToolResultContent(...)              ← 闸 3：写入 toolResults 之前压缩（验收硬项）
        │
        ▼
toolResults → 追加 messagesForApi
        │
        ▼
下一轮 client.messages.stream(messagesForApi)       ← 不再经过闸 2，故闸 3 不可省
```

| 闸 | 覆盖 | 说明 |
|----|------|------|
| 闸 1 | 历史重建 | `buildToolResultBlock` |
| 闸 2 | IPC 旁路 / 入口校验 | 将现状 `throw` 改为压缩；兜底一切直传 messages |
| 闸 3 | **实时工具循环出站** | `toolChatLoop` 在把成功或错误结果加入 `toolResults` 前调用；否则「本轮成功、下轮必炸」 |

> **架构事实（评审 P0）：** `toolChatLoop` 各轮次直接复用内存中的 `messagesForApi` 调用 `client.messages.stream`，**不会**在每轮工具结果后重新进入 `normalizeAndValidateClaudeMessagesWithContentBlocks`。因此仅靠闸 1+2 **无法**保护循环内新产生的超长结果。

### 5.5 与既有校验的关系

修改 `electron/claudeStreamHandlers.ts` 中：

```ts
// 现状
if (content.length > MAX_TOOL_RESULT_CONTENT_CHARS) {
  throw new Error('tool_result content too long')
}

// 目标
if (content.length > MAX_TOOL_RESULT_CONTENT_CHARS) {
  // 原地替换为省略标记；打 warn 日志；继续
}
```

文本块、thinking、image 等其它上限策略**不变**（本期只改 `tool_result`）。

### 5.6 运行中新产生的超长结果（验收硬项）

1. **不要求**每个执行器在内部截断（见 §3.2）。
2. **必须**在 `toolChatLoop` 将 `formatToolResultPayload`（及错误路径的等价 content）写入 `toolResults` 之前调用共享压缩函数，使当轮追加进 `messagesForApi` 的 content 已合规。
3. 成功与失败（`is_error: true`）两条写入路径均须覆盖。
4. 压缩后下一轮 `client.messages.stream` 收到的对应 `tool_result`：content 为省略标记、长度 ≤ 上限、`tool_use_id` 不变、`is_error` 语义符合 §5.3。

---

## 6. 常量与契约

沿用 `src/shared/toolResultLimits.ts`：

| 常量 | 现值 | 本期用法 |
|------|------|----------|
| `READ_FILE_MAX_CHARS` | 2×1024×1024 | 单次返回正文硬上限；Meta 模式判定阈值 |
| `READ_FILE_MAX_LINE_LIMIT` | 2000 | `limit` / `tail` 上限 |
| `MAX_TOOL_RESULT_CONTENT_CHARS` | 同 `READ_FILE_MAX_CHARS` | `tool_result` 出站硬上限 |
| `MAX_API_MESSAGE_TEXT_CHARS` | 同左 | 非本期变更 |

新增建议：

| 常量 / 函数 | 建议位置 | 用途 |
|------|----------|------|
| `compactOversizedToolResultContent`（及占位模板） | `src/shared/`（如 `toolResultLimits.ts` 旁或独立小模块） | 三道闸共用；须可被 electron / shared 同时 import |
| `READ_FILE_TAIL_CHUNK_BYTES` | electron 执行器侧 | 尾读分块大小（实现细节，可不上共享包） |

---

## 7. 实现落点

| 模块 | 变更要点 |
|------|----------|
| `src/shared/builtinToolDefinitions.ts` | `tail` 参数；更新 description |
| `electron/toolInputGuards.ts` | 互斥、范围、禁止负 offset |
| `src/shared/readFileRange.ts`（或新文件） | 纯函数：从完整字符串取尾 N 行（供单测）；可选导出类型 |
| `electron/tools/builtinExecutors.ts`（+ 可选 `readFileTail.ts`） | Tail 分块读；Range 先窗口后截断；Meta 模式 |
| `electron/tools/readFileRange.test.ts` 等 | 覆盖 §8.1 |
| `src/shared/` 压缩 helper | `compactOversizedToolResultContent` 单测 |
| `src/shared/claudeToolHistory.ts` | 闸 1：`buildToolResultBlock` 出站压缩 |
| `electron/claudeStreamHandlers.ts` | 闸 2：超长 `tool_result` 压缩替代 throw |
| `electron/toolChatLoop.ts` | 闸 3：写入 `toolResults` 前压缩（成功/失败路径） |
| `src/shared/claudeToolHistory.test.ts` / pairing / toolChatLoop 相关测试 | 超长降级不破坏 pairing；覆盖 §8.2 B7 |
| `docs/requirement/tools-requirement.md` | 实现后在偏差表或 read_file 小节回写摘要（可选，与实现 PR 一并） |

---

## 8. 测试计划

### 8.1 read_file / tail

| # | 用例 | 期望 |
|---|------|------|
| A1 | 小文件 `tail=3`，文件 10 行 | 返回最后 3 行正序；`linesReturned=3`；`hasMoreBefore=true` |
| A2 | `tail` 大于总行数 | 返回全文；`hasMoreBefore=false` |
| A3 | `tail` + `offset` 同时传 | `success:false`，互斥错误 |
| A4 | `tail` + `limit` 同时传 | 同上 |
| A5 | `offset: -1` | 入参校验失败 |
| A6 | `tail: 2001` | 校验失败 |
| A7 | 构造 >2MB 且远超内存友好的临时文件，仅 `tail=50` | 成功返回末 50 行；过程中不得 `readFile` 整文件进 Buffer（可用 spy/分块读断言或文件足够大导致若整读会 OOM/超时的方式做回归说明） |
| A8 | 同大文件无参数 | Meta：无正文，有 `byteSize`/`note`/`exceedsReadLimit` |
| A9 | 大文件 `offset` 指向后半段 | 能读到后半内容（证明已修复「先截前 2MB」） |
| A10 | Tail 窗口本身超字符上限 | `truncated:true`，`hasMoreBefore:true`，content 长度 ≤ 上限 |
| A11 | CRLF 文件 tail | 换行风格保持 |

### 8.2 超长 tool_result

| # | 用例 | 期望 |
|---|------|------|
| B1 | `buildToolResultBlock` 输入 `data` 字符串长度 > 上限 | content 为省略标记，长度合规 |
| B2 | `normalizeAndValidate...` 输入已含超长 tool_result | 不抛错；输出已压缩；配对仍完整 |
| B3 | 压缩后再次校验 | 幂等（已是占位则不再误伤） |
| B4 | 原 `is_error: true` 的超长错误内容 | 压缩后仍 `is_error: true` |
| B5 | 回归：正常短 tool_result | 行为不变 |
| B6 | 与 `ensureToolResultPairing` 联调 | 修复后再压缩或压缩后再修复均不产生非法空 user |
| B7 | **工具循环 E2E**：本轮工具产出超限成功 content，断言下一次 `client.messages.stream`（或等价出站 messages）中对应 `tool_result.content` 为省略标记、长度合规，且保留原 `tool_use_id` 与 `is_error` | 证明闸 3 生效；不得依赖闸 2 |

---

## 9. 验收标准

### 9.1 需求 A

- [ ] 工具 schema 与 description 含 `tail`，并写明与 `offset`/`limit` 互斥及大文件 Meta 行为
- [ ] `tail` 返回末尾行且正序；元数据含 `linesReturned`、`hasMoreBefore`、`truncated`（在适用时）
- [ ] 大文件无范围参数时不返回前 2MB 正文
- [ ] 大文件可通过 `offset`+`limit` 读到前缀之外的内容
- [ ] Tail 路径对超大文件不整文件载入内存
- [ ] 相关单测通过

### 9.2 需求 B

- [ ] 含超长历史 `tool_result` 的会话可继续发送，不再出现 `tool_result content too long`
- [ ] IPC 旁路超长 `tool_result` 被压缩而非抛错（闸 2）
- [ ] **同一次工具循环内**新产生的超长结果在写入 `toolResults` 前已压缩；下一轮 stream 收到合规 content（闸 3；对应用例 B7）
- [ ] 发往 API 的对应 content 为省略标记且 ≤ `MAX_TOOL_RESULT_CONTENT_CHARS`
- [ ] `tool_use` / `tool_result` 配对不被破坏；`is_error` 语义符合 §5.3
- [ ] 有 warn 日志便于排查
- [ ] 相关单测通过（含 B7）

---

## 10. 相关文件

| 路径 | 角色 |
|------|------|
| `src/shared/builtinToolDefinitions.ts` | 工具定义 |
| `src/shared/toolResultLimits.ts` | 上限常量 / 建议放置压缩 helper |
| `src/shared/readFileRange.ts` | 行切片 |
| `src/shared/claudeToolHistory.ts` | 闸 1：历史 → API tool_result |
| `src/shared/toolResultPairing.ts` | 配对与合成占位 |
| `electron/toolInputGuards.ts` | 入参校验 |
| `electron/tools/builtinExecutors.ts` | `readFileExecutor` |
| `electron/claudeStreamHandlers.ts` | 闸 2：出站校验压缩 |
| `electron/toolChatLoop.ts` | 闸 3：`formatToolResultPayload` 后、写入 `toolResults` 前压缩 |

---

## 11. 附录：事故复现要点

1. 会话 A 长时间工具循环，Agent 日志膨胀至十余 MB，且 `llm.request` 含完整 messages。  
2. 会话 B：`read_file` 无参读取当日 `Agent-*.log` → 得到前 2MB（含会话 A 的用户原文）。  
3. 模型在 thinking 中引用嵌套日志里的旧用户句（如「聊了」）并回答旧话题。  
4. 用户继续提问 → 校验抛出 `tool_result content too long` → 会话中断。

本期 A+B 分别切断「误读前缀」与「超长即死」两条因果链；完整根治还需后续日志瘦身与更广义上下文预算（非本期）。

---

## 12. 修订记录

| 版本 | 日期 | 说明 |
|------|------|------|
| 1.0 | 2026-07-25 | 初稿 |
| 1.1 | 2026-07-25 | 按评审 P0-1：将工具循环出站压缩升为验收硬项（闸 3）；收窄 §3.2 非目标；增补用例 B7 与验收项 |)