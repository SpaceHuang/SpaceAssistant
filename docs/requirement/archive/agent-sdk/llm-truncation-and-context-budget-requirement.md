# LLM 截断判定与上下文预算预警 — 需求规格

**版本：** 1.1
**日期：** 2026-09-16
**状态：** 待评审（D1–D3 需用户确认，见 §14；D4–D6 随 R4b / R5 降级为后续版本，V1 不做）
**关联文档：** [agent-token-usage-analytics-requirement.md](./agent-token-usage-analytics-requirement.md)、[context-usage-ring-v2-improvements.md](./context-usage-ring-v2-improvements.md)、[shell-output-encoding-robustness-requirement.md](./shell-output-encoding-robustness-requirement.md)

**变更记录：**

| 版本 | 日期 | 说明 |
|------|------|------|
| 1.0 | 2026-09-16 | 初稿。以会话 `15fa1830` 的「Turn 以 Thinking 结尾、无疾而终」为触发，系统化重建「截断 → 判定 → 续跑 / 失败」链路，并补齐输出预算与窗口余额预警；对 Codex（`F:/Develop/codex`，HEAD `2df0b747ba`）相关实现逐条比对 |
| 1.1 | 2026-09-16 | **范围裁剪（用户决定）**：R4 拆为 R4a（输出上限策略，V1 做）与 R4b（思考深度配置，**可选、V1 不做**）；R5（窗口余额预警）整体降级为**可选、V1 不做**。同步调整 §1、§4（新增 §4.3 版本范围划分）、§6、§10–§15 的范围标注 |

---

## 目录

1. [概述](#1-概述)
2. [触发事故与证据链](#2-触发事故与证据链)
3. [现状分析](#3-现状分析)
4. [目标与非目标](#4-目标与非目标)
5. [与 Codex 的机制对照](#5-与-codex-的机制对照)
6. [设计总览](#6-设计总览)
7. [R1 截断必须成为显式状态](#7-r1-截断必须成为显式状态)
8. [R2 截断后的续跑语义](#8-r2-截断后的续跑语义)
9. [R3 重试边界与副作用防重放](#9-r3-重试边界与副作用防重放)
10. [R4 输出预算与思考深度解耦](#10-r4-输出预算与思考深度解耦)
11. [R5 窗口口径余额预警](#11-r5-窗口口径余额预警)
12. [测试基线](#12-测试基线)
13. [实施阶段与验收标准](#13-实施阶段与验收标准)
14. [决策点](#14-决策点)
15. [风险与回滚](#15-风险与回滚)
16. [相关文件](#16-相关文件)
17. [附录 A：事故回放素材](#附录-a事故回放素材)

---

## 1. 概述

### 1.1 问题一句话

当模型一轮输出被输出上限截断（`stop_reason = max_tokens`）时，工具循环**不做任何判定**：只要这一轮没产生 `tool_use`，就一路以「成功」收尾。若这轮内容恰好只有一个被切断的 thinking 块，用户看到的界面就以一段没写完的思考结尾，Turn 静默结束，既没有错误、也没有续写。

这不是显示问题，而是**链路缺少「未完成」这一状态**：截断事实（`stopReason`）虽然被算出来、被透传，却没有任何一处消费它。

### 1.2 本需求要解决的五件事（V1 范围见 §4.3）

| # | 问题 | 解决方向 |
|---|------|----------|
| R1 | 截断不产生任何状态变化，Turn 被判 `completed` | 把「截断 / 未完成」建成显式状态，落到返回类型、事件终态与消息持久化 |
| R2 | 截断后既不续写也不报错，思考白烧 | 截断后按内容分型：可续跑的续跑（含 thinking 块原样回传），不可续跑的显式失败 |
| R3 | 重试边界不清，可能重复副作用 | 只对传输类错误重试；副作用以 checkPoint 为准，禁止重放 |
| R4a | `max_tokens` 被当成思考预算的闸门 | 输出上限贴近模型能力、不再承担思考闸门职责（**V1 做**） |
| R4b | 思考花费不可控、只有一个开关 | 思考深度可配（**可选能力，V1 不做**） |
| R5 | 上下文窗口将满时模型无感知 | 窗口口径的余额预警，按刻度注入（**可选能力，V1 不做**） |

### 1.3 本需求对「彻底」的判据

1. 任何一轮被截断的输出，都必须能回答三个问题：**是否被截断、截断在哪、接下来发生什么**（续跑 / 失败 / 用户可见提示）。
2. 「只有 thinking、没有正文」不再是一种可以静默收尾的状态。
3. 续跑只增加采样轮次，**不重复执行任何已执行的工具调用**。
4. 打开思考能力时，思考预算与输出上限的关系在参数构建处**被校验**，而不是靠用户猜数字。
5. 窗口余额下降跨过刻度时，模型在**请求上下文中**看得到，且该提示不会每轮重复膨胀（有节流、有去重键）。

> 判据 4、5 对应**可选能力**（R4b / R5），**V1 不实现**；V1 的判据为 1–3。

---

## 2. 触发事故与证据链

### 2.1 事故时间线

会话 `15fa1830-4e2a-4d38-92e2-090077ab6818`（明文备份 `sessions/15fa1830-…-20260915/`，事件流 `events.jsonl`；主进程日志 `.agent/logs/Agent-20260916.log`）。

| # | 位置 | 事件 | 关键字段 |
|---|------|------|----------|
| 1 | 第 7 轮 `llm.request` | 带内置工具的工具循环请求 | 冻结配置 `maxTokens` 经下限抬升后为 `16384` |
| 2 | 第 7 轮 `llm.response` | 模型返回 | `stop_reason: "max_tokens"`、`output_tokens: 16384` |
| 3 | 同事件的 content | **只有一个 thinking 块**，49,931 字符 | 无 `text`、无 `tool_use`；文本在 `…centre 348; Agent ` 处被切断 |
| 4 | `toolChatLoop.ts:1036` | 判定分支 | `toolUses.length === 0` → 直接进入成功返回 |
| 5 | `toolChatLoop.ts:1042` | 返回值 | `{ ok: true, content, stopReason: 'max_tokens' }` |
| 6 | `claudeStreamHandlers.ts:531` | 终态写入 | `finalizeTurn(turnId, 'completed')` —— 未读 `stopReason` |
| 7 | `turn_end` 事件 | 落库 | `reason: "completed"` |
| 8 | UI | 渲染结果 | 停在 thinking 块输出上，无错误提示、无续写 |

由此可读出三点事实：

1. **截断事实全程可见但无人消费**：`stopReason` 在 `toolChatLoop.ts:948` 被规范化、在 `:1042` 返回、在 `claudeStreamHandlers.ts:545` 继续透传，此后不再有任何分支读取它。
2. **判定缺失发生在最早的收口点**：`toolChatLoop.ts:1036-1042` 是决定「Turn 是否完成」的唯一分岔，它只看有没有工具调用。
3. **现象容易被放大**：同一 prompt 更早的一次会话（`1bc38fc3`，前缀）因请求侧 thinking 块回传不完整被 API 400 拒绝、未落库，使这次成为用户可见的首个失败样本（该条实施前需用 `logs/Agent-*.log` 二次确认）。

### 2.2 为什么「没有正文」比「正文被截断」更严重

同一机制下有两种截断形态，代价不同：

| 形态 | 现象 | 当前后果 |
|------|------|----------|
| 正文被截断 | 有 `text`，但句子没写完 | 已被 `electron/toolChatLoop.ts:219-239` 的 `augmentToolInputValidationError` 部分覆盖（仅在工具参数校验失败时提示） |
| 只有 thinking、无任何 text/tool_use | 整轮预算被思考吃光 | **完全无覆盖**，静默收尾 → 本次事故 |

第二种形态的成因是结构性的：思考与正文**共享**同一个输出预算（Anthropic 语义，SpaceAssistant 已在 `src/shared/requestContext.ts:24` 用 `outputAccounting: 'shared' | 'separate'` 建模），而 `src/shared/llm/toolLoopMaxTokens.ts:13` 把「带内置工具」的下限钉在 `16384`——恰好是这次被吃光的额度。

### 2.3 事故性质判定

- 不是 provider 偶发故障：`stop_reason` 是正常协议字段，模型行为合法。
- 不是显示层 bug：UI 忠实展示了它收到的思考增量。
- 是**状态机缺状态**：链路里不存在「这一轮没说完」这个中间态，于是被归入「完成」。

---

## 3. 现状分析

### 3.1 判定链：唯一的收口点不看 stopReason

```
toolChatLoop.ts:948   stopReason = normalizeStopReason(res.stop_reason)
toolChatLoop.ts:1036  if (toolUses.length === 0) {          // 只看工具调用
toolChatLoop.ts:1042      return { ok: true, stopReason: ... }   // 无条件成功
claudeStreamHandlers.ts:531  finalizeTurn(turnId, 'completed')   // 无条件完成
```

`stopReason` 的类型已经具备区分能力（`electron/stopReason.ts:1`：`'max_tokens' | 'end_turn' | 'tool_use' | 'other'`），但它在链路上是纯数据，不参与控制。

### 3.2 「thinking 提升为正文」的补偿逻辑是死代码，且本就排除截断

`src/shared/assistantContentReconcile.ts:31-48` 的 `shouldPromoteFinalThinkingToContent`：

```ts
if (stopReason && stopReason !== 'end_turn') return false   // :38
```

它在 `max_tokens` 时**明确返回 false**，因此不是本次事故的成因；且全仓只有测试引用（唯一活跃导出是 `extractAssistantTextFromApiContent`，由 `src/renderer/services/chatToolSessionService.ts:17` 再导出）。结论：可以清理，但清理它不改变本次行为。

> 清理时必须保留「thinking 块原样回传」这一协议要求（见 §8.3），两者不是同一件事。

### 3.3 截断感知目前只覆盖一条窄路径

`electron/toolChatLoop.ts:219-239` 会在「工具参数校验失败且 `stopReason === 'max_tokens'`」时追加提示文案（`write_file` / `edit_file` / `run_script`）。也就是说「截断」这个概念已经被工程上承认，只是覆盖范围仅限工具参数未闭合。

### 3.4 输出上限与思考深度耦合

| 位置 | 现状 |
|------|------|
| `src/shared/llm/toolLoopMaxTokens.ts:3` | `DEFAULT_TOOL_LOOP_MAX_TOKENS = 32768` |
| `src/shared/llm/toolLoopMaxTokens.ts:5-7` | 归一化区间 `256 ~ 1_000_000` |
| `src/shared/llm/toolLoopMaxTokens.ts:13` | 带内置工具下限 `16384` |
| `src/shared/llm/toolLoopMaxTokens.ts:23-25` | `effectiveMaxTokensForBuiltinToolLoop = max(归一化值, 16384)` |
| `electron/toolChatLoop.ts:585` | 工具循环实际取值点 |
| `electron/claudeToolLoopStreamParams.ts:17` | `max_tokens: number`（**必填**，Anthropic Messages API 约束） |
| `electron/toolLoopModelOptions.ts:3-13` | 思考只有 `enableThinking: boolean` 开关，**没有深度/预算维度** |

即：用户唯一能调的旋钮是 `maxTokens`，而它同时充当「正文长度上限」「工具参数长度上限」「思考花费上限」三种角色。事故里模型把 16384 全部花在思考上，用户从配置上无法表达「请少想一点、把额度留给正文」。

### 3.5 缺口径的余额预警

`src/shared/requestContext.ts:16-34` 已经算出窗口口径的预算与占用：

```
rawInputWindow  = contextWindow - maxTokensEffective          // :100
totalInputBudget = floor(rawInputWindow * 0.95)               // :101
bodyBudget      = totalInputBudget - prefixTokens             // :102
contextUsage    = { pressureTokens, projectedTokens, surfaceTokens, hardFit, bodyFit }  // :27
```

这些数据已经通过 `onTurnBoundary`（`electron/toolChatLoop.ts:443`）在轮边界可用，但**只用于轮边界规划与 UI 环形图**，从未作为提示词片段回灌给模型。模型因此不知道自己正在逼近窗口上限。

### 3.6 重试能力现状

`src/shared/overflowRecovery.ts:13-40` 已实现「上游超窗错误」的识别与恢复决策（`isProviderContextOverflow` / `decideOverflowRecovery`，含 `maxRetries`、`in_flight` 保护）。但：

- 它只覆盖「上游报错」这一种失败形态，覆盖不到「本轮被静默截断」。
- 除它之外没有统一的「哪些错误可重试」白名单，截断/工具失败/网络抖动混在同一层处理。

---

## 4. 目标与非目标

### 4.1 目标

1. 截断（`stop_reason = max_tokens`）成为一等状态：可判定、可持久化、可展示、可续跑（R1、R2）。
2. 续跑不产生副作用重放，重试有明确白名单与退避上限（R3）。
3. 输出上限不再承担思考闸门职责，且不超过模型/服务声明的最大输出（R4a）。
4. 上述行为全部有回归测试钉死，事故 SSE 序列成为 fixture。

### 4.2 非目标

- **不引入** Codex 式的「会话累计加权预算」（`rollout_budget`）。本需求只做窗口口径余额；累计预算涉及计费口径与配额策略，另案。
- **不改** thinking 块的协议回传（`electron/toolChatLoop.ts:1017` 原样回传 API content 块的行为必须保持）。
- **不实现**自动压缩（auto-compact）本身，只做预警与复用既有溢出恢复；压缩另案。
- **不新增**用户级「截断后是否续跑」以外的编码/重试类旋钮（延续「不给用户出选择题」的既有决策风格）。
- **V1 不实现思考深度配置**（R4b）：涉及设置页、模型条目与参数构建三处改动，属独立能力，另案排期。
- **V1 不实现窗口余额预警**（R5）：属软引导，不改变 V1 的判定正确性；V1 只在 §11.1 钉死口径定义，供后续版本复用。

### 4.3 版本范围划分（V1 / 后续）

| 范围 | 内容 | 说明 |
|------|------|------|
| **V1 必做** | R1、R2、R3、R4a | 直接消除「截断被静默判 completed」与「重试重复副作用」两类正确性问题 |
| **可选（V1 不做）** | R4b（思考深度配置）、R5（窗口余额预警） | 成本优化与行为引导类能力；V1 只保留接口位置与口径定义，不实现逻辑 |

> 说明：V1 交付后，若「思考吃光输出预算」仍频繁发生，再启动 R4b；若长会话普遍逼近窗口上限，再启动 R5。

---

## 5. 与 Codex 的机制对照

参照 `F:/Develop/codex`（HEAD `2df0b747ba`）核实，逐条对照如下。

| 维度 | Codex 的做法 | SpaceAssistant 现状 | 本需求 |
|------|--------------|---------------------|--------|
| 输出上限 | 请求体**不含** `max_output_tokens`（`codex-rs/codex-api/src/common.rs`、`codex-rs/core/src/client.rs` 中均无该字段），只由服务端按模型能力决定 | `max_tokens` 必填（`electron/claudeToolLoopStreamParams.ts:17`），带内置工具时下限 16384 | R4：上限贴近模型能力，思考预算独立配置并校验 |
| 截断 | `response.incomplete` → `ApiError::Stream("Incomplete response returned, reason: {reason}")`（`codex-rs/codex-api/src/sse/responses.rs:472-482`） | 无判定 | R1 |
| 未说完 | `ResponseEvent::Completed { end_turn: Some(false) }` → `needs_follow_up = true`（`codex-rs/core/src/session/turn.rs:2790-2792`），由外层循环继续采样 | 无 | R2 |
| 流异常 | 流结束未收到 completed 即报错（`codex-rs/codex-api/src/sse/responses.rs`） | `electron/anthropicStreamDelta.ts:25` 只取增量，不做完整性判定 | R1/R3 |
| 重试 | 有可重试白名单与退避，耗尽后发 `EventMsg::Error` 结束 Turn（`codex-rs/core/src/responses_retry.rs`、`codex-rs/protocol/src/error.rs`） | 仅 `src/shared/overflowRecovery.ts` 覆盖超窗 | R3 |
| 副作用防重放 | 已执行工具调用记账，重试只从 prompt 侧 attach（`codex-rs/core/src/session/turn.rs:1535,1549-1551`） | 已有 `toolExecutionCheckpoint: { completedToolUseIds, replayForbidden }`（`src/shared/requestContext.ts:44`），但未被重试路径消费 | R3 |
| 思考花费 | `reasoning.effort` 控制深度，不靠输出上限 | 仅 `enableThinking` 开关 | R4 |
| 余额提醒 | 两套：窗口口径 `token_budget`（单一阈值 + 每窗口一次）、会话口径 `rollout_budget`（刻度表 + 每刻度一次） | 无提醒，仅 UI 环形图 | R5（只做窗口口径） |

**关键差异**：Codex 能用「不传输出上限」消解问题，是因为 Responses API 允许省略；Anthropic Messages API 要求 `max_tokens` 必填，**因此不能照搬**。SpaceAssistant 的可行路径是「上限给足 + 思考预算显式配置」，这正是 R4 的由来。

---

## 6. 设计总览

### 6.1 五条改动链路

```
        ┌─ R1 判定 ─────────────┐
采集 ──►│ stopReason → 轮次终态 │──► 事件终态 / 消息持久化 / UI 提示
        └───────────────────────┘
                 │
                 ├─ R2 续跑 ──► 追加续写指令，不带新用户消息，再采一轮
                 │
                 └─ R3 重试 ──► 仅可重试错误；副作用按 checkpoint 跳过

R4a 参数构建：max_tokens 上限夹取（V1 做）
R4b 参数构建：thinkingBudgetTokens 与 max_tokens 联动校验（可选，V1 不做）
R5  提示注入：窗口余额跨刻度 → developer 片段，按 (会话, 窗口号) 去重（可选，V1 不做）
```

### 6.2 四条不可违反的实现原则

1. **截断不能是 `completed`**：只要 `stopReason === 'max_tokens'`，Turn 终态只能是「已续跑」「显式失败」或「部分完成（用户可见提示）」，不能是静默完成。
2. **续跑只加采样，不加副作用**：续跑轮不得重新执行任何已执行工具。
3. **thinking 块必须原样回传**：任何清理都不得动 `electron/toolChatLoop.ts:1017` 的行为。
4. **提示片段有节流**（仅当 R5 启用）：余额预警每窗口按刻度最多各投一次，避免提示自身反复进 history。

---

## 7. R1 截断必须成为显式状态

### 7.1 判定规则（唯一真值）

在 `electron/toolChatLoop.ts:1036` 之前引入分型函数（建议落在 `src/shared/llm/` 下，两端可复用、可单测）：

| stopReason | 本轮内容 | 分型 | 后续 |
|---|---|---|---|
| `max_tokens` | 含 `tool_use`（参数完整） | `truncated_after_tools` | 正常执行工具，下一轮注入截断提示（沿用 `:219-239` 风格） |
| `max_tokens` | 含 `tool_use`（参数**不完整**） | `truncated_tool_args` | 不执行该工具，回灌错误让模型重发（现有 `augmentToolInputValidationError` 路径扩展到全部工具） |
| `max_tokens` | 有 `text`、无 `tool_use` | `truncated_text` | 续跑（§8.2） |
| `max_tokens` | **只有 thinking** | `truncated_thinking_only` | 续跑（§8.2），并在续写指令中显式说明额度被思考占满 |
| `end_turn` | 任意 | `complete` | 现状不变 |
| `tool_use` | 含 `tool_use` | `complete_tool_turn` | 现状不变 |
| `other` / `undefined` | 无 `tool_use` | `incomplete_unknown` | 按未完成处理（保守失败，不静默完成） |

### 7.2 返回类型扩展

`electron/toolChatLoop.ts:456-458` 的 `RunToolChatSessionResult` 增加截断维度（向后兼容，新增可选字段）：

```ts
| { ok: true; content: unknown[]; stopReason: string;
    truncation?: { kind: TruncationKind; rounds: number; recovered: boolean };
    usage?: ToolLoopUsage; ... }
```

### 7.3 事件终态扩展

`finalizeTurn`（`electron/claudeStreamHandlers.ts:254-282`）当前签名 `(turnId, reason, error?, finalSurfaceSnapshot?)`，`turn_end` payload 中增加：

- `reason`：新增取值（与 `Message.status` 对齐，见 §7.4）
- `truncation: { kind, rounds, outputTokens, maxTokensEffective }`

要求：`step_end` / `turn_end` 的既有字段语义不变（沿用既有「不改既有字段语义」的兼容纪律）。

### 7.4 消息持久化

`src/shared/domainTypes.ts:693-716` 的 `Message` 增加可选字段（不破坏现有数据，`schemaVersion` 递增并在读侧做兼容）：

```ts
  /** 本轮被输出上限截断；kind 见 §7.1 */
  truncation?: { kind: TruncationKind; rounds: number; maxTokensEffective: number }
```

`MessageStatus` 是否需要新态由 D3 决定：倾向**不新增状态**，用 `status: 'completed'` + `truncation` 字段表达「完成但被截断」，避免所有消费 `MessageStatus` 的分支被牵连。

### 7.5 UI 展示

- 气泡底部展示可折叠提示（i18n key 落在 `chat` 命名空间），文案需说明「本轮达到输出上限」与「已自动续写 N 次 / 未自动续写」。
- `src/renderer/services/turnFailureDisplay.ts:10-16` 只处理 `status === 'failed'`；新增截断提示不要塞进失败原因通道，避免语义混淆。
- 错误码：新增 `errors` 命名空间条目 + `src/shared/errorCodes.ts` 码值（如 `LLM_OUTPUT_TRUNCATED_UNRECOVERED`）。

---

## 8. R2 截断后的续跑语义

### 8.1 续跑与重试的区别（必须先分清）

| | 续跑（continuation） | 重试（retry） |
|---|---|---|
| 触发 | 模型没说完 | 请求没成功 |
| 做法 | 保留本轮 assistant 输出，再采一轮 | 重发同一请求 |
| 新增采样轮次 | 是 | 是 |
| 是否可能重复副作用 | 否（无新工具调用即无副作用） | 需靠 checkpoint 保证 |
| 上限 | 连续续跑次数上限（D2） | 退避次数上限 |

### 8.2 续跑实现

在 `electron/toolChatLoop.ts` 的工具循环内，将 `truncated_text` / `truncated_thinking_only` 视为「继续循环」而不是「返回」：

1. 保留本轮 assistant 消息（含 thinking 块，见 §8.3）进入 `messagesForApi`。
2. 追加一条续写指令（role 采用现有 `user` 通道时需避免污染历史渲染；建议走 developer/system 风格片段，与 §11 的片段机制复用同一注入点）。
3. 不追加任何新的用户输入。
4. 连续续跑次数计入 `truncation.rounds`，超过 D2 设定的上限（建议 2）后转为显式失败。
5. 续跑轮同样受 `maxTokens` 约束；若续跑仍以 `max_tokens` 结束，则如实累计计数，不静默。

续写指令需要包含的要素（供模型自我纠正）：

- 上一轮因输出上限被截断，**尽量不要重复已经写过的内容**；
- 若正文尚未产出，请**优先直接给出正文**，不要继续长时间思考；
- 若任务确实无法在本轮完成，请给出明确结论与下一步。

### 8.3 thinking 块回传契约（不可回退项）

`electron/toolChatLoop.ts:1017` 把 API 原始 `content` 块整体追加进 `messagesForApi`，这是 Anthropic 的要求：带 `tool_use` 的轮次若缺 thinking 块会直接 400（对应 §2.1 的 `1bc38fc3` 现象）。因此：

- 续跑轮必须包含上一轮完整 content（含 thinking / redacted_thinking）。
- 清理 `src/shared/assistantContentReconcile.ts` 时**只删展示层提升逻辑**，保留 `extractAssistantTextFromApiContent`（`src/renderer/services/chatToolSessionService.ts:17` 有消费方）。

### 8.4 不可续跑的情形

| 情形 | 处理 |
|---|---|
| 连续续跑达到上限仍被截断 | `status: 'failed'` + `LLM_OUTPUT_TRUNCATED_UNRECOVERED`，UI 给出「提高输出上限或拆分任务」的可操作提示 |
| 截断发生在工具参数未闭合 | 不执行工具，回灌错误（§7.1 第 2 行） |
| 截断来自「只有 thinking 且 thinking 本身超限」 | 若 `thinkingBudgetTokens` 已配置，提示模型降低思考量；同时建议用户在设置中下调思考深度（D6） |

---

## 9. R3 重试边界与副作用防重放

### 9.1 重试白名单

明确只对下列错误重试（其余一律不重试）：

| 类别 | 例子 | 可重试 |
|---|---|---|
| 传输/限流 | 网络中断、5xx、429（按既有退避） | 是 |
| 超窗 | 上游 `context_length` 类错误 | 是（复用 `src/shared/overflowRecovery.ts:35-40`） |
| 供应商内部错误 | 无正文的空响应、流中断未收尾 | 是，上限 1 次 |
| 截断 | `stop_reason = max_tokens` | **否**（走续跑，不走重试） |
| 工具执行失败 | 工具自身错误 | 否（回灌给模型） |
| 预算耗尽类 | 如未来的会话预算 | 否 |

> 事故里如果对截断做指数退避重试，只会得到几乎相同的结果并成倍消耗额度，因此本需求明确禁止。

### 9.2 退避与上限

- 指数退避 + 抖动，次数上限沿用既有配置（建议默认 3，写入 `RequestContextPayload.decision.ruleVersion` 便于回溯）。
- 每次重试必须复用同一 `decisionFingerprint`（`src/shared/requestContext.ts:105`），使得「同一决策的重复请求」在日志里可识别。

### 9.3 副作用防重放

现有抓手：`src/shared/requestContext.ts:44` 的 `toolExecutionCheckpoint: { completedToolUseIds: string[]; replayForbidden: boolean }`，由 `electron/toolChatLoop.ts:443` 的 `onTurnBoundary` 传递。

要求：

1. 重试路径读取 checkpoint，`completedToolUseIds` 中的 `tool_use` 一律**不重新执行**，只从 prompt 侧 attach（对齐 Codex 的 `executed_tool_calls` 思路，`codex-rs/core/src/session/turn.rs:1535,1549-1551`）。
2. `replayForbidden: true` 时，重试前必须确认待重发的轮次不含任何未记账的副作用调用；否则转为显式失败。
3. 新增测试：模拟「工具已执行 → 流中断 → 重试」序列，断言工具执行计数为 1。

---

## 10. R4a 输出上限策略（V1）与 R4b 思考深度配置（可选，V1 不做）

### 10.1 上限策略

| 项 | 现状 | 目标 |
|---|---|---|
| 默认 `maxTokens` | `32768`（`src/shared/llm/toolLoopMaxTokens.ts:3`） | 保持，但不再承担思考闸门职责 |
| 带内置工具下限 | `16384`（`:13`） | 保留（防工具参数截断有效），但**当开启思考时**应显式与思考预算联动校验 |
| 上限 | `1_000_000`（`:7`） | 增加「不超过模型/服务声明的最大输出」的夹取（`ModelEntry.maxTokens`，`src/shared/domainTypes.ts:722`） |

### 10.2 思考深度配置（可选能力 R4b，**V1 不做**；D6）

新增会话级/模型级配置项 `thinkingBudgetTokens?: number`（承载层级由 D6 决定），语义：

- 未配置：保持现状（由 `enableThinking` 开关决定是否思考）。
- 配置后：作为 `thinking.budget_tokens` 传入；必须在参数构建处校验 `1024 <= thinkingBudgetTokens < max_tokens`（Anthropic 硬约束），非法值降级为该模型的默认并在日志中记录 `llm.thinking_budget_downgraded`。
- 与 `maxTokens` 联动：`maxTokens` 不足时自动抬高到 `thinkingBudgetTokens + 正文预留`，或直接拒绝该组合并提示用户——由 D4 决定。

### 10.3 参数构建点

`electron/claudeToolLoopStreamParams.ts` 是唯一出口（测试 `electron/claudeToolLoopStreamParams.test.ts` 已断言 key 顺序 `['model','max_tokens','system','messages','tools','tool_choice','thinking']`）。所有校验与降级逻辑集中在此处或其上游的 `resolveToolLoopModelOptions`（`electron/toolLoopModelOptions.ts:3-13`）。

---

## 11. R5 窗口口径余额预警（可选能力，**V1 不做**）

### 11.1 口径定义（必须先钉死）

**余额 = 输入预算 − 当前占用**，其中：

```
totalInputBudget = floor((contextWindow − maxTokensEffective) × 0.95)   // src/shared/requestContext.ts:100-101
bodyBudget      = totalInputBudget − prefixTokens                        // :102
余额             = totalInputBudget − surfaceTokens                      // 或使用 projectedTokens（含本轮规划）
```

要点：

- 这是**窗口口径**（auto-compact 类机制的重置口径），与「会话累计消耗」无关；本需求不做后者。
- 判据使用 `contextUsage.pressureTokens / projectedTokens`（`:27`），优先 `projectedTokens`，缺失时回退 `surfaceTokens`。
- 当 `hardFit === false` 时，说明本轮已超输入预算，属于 overflow 路径（`src/shared/overflowRecovery.ts`），不走预警。

### 11.2 刻度与节流

- 刻度配置 `contextReminderAtRemainingTokens: number[]`（默认建议 `[40000, 20000, 8000]`，按模型窗口比例换算更佳）。
- 计数语义与 Codex `rollout_budget` 一致：`reminderIndex = count(threshold >= remaining)`，**只增不减**。
- 去重键 `(sessionId, windowId)`：同一窗口内同一 index 只投一次；`windowId` 变化（压缩/新窗口）后重置并重播一次当前余额。
- 首次（该 `(sessionId, windowId)` 无投递记录）**无条件播报一次**当前余额——与 Codex 行为一致，便于模型尽早建立尺度感（可用配置关闭）。

### 11.3 注入点与片段格式

复用 `onTurnBoundary`（`electron/toolChatLoop.ts:443`）已携带的 `budget` / `contextUsage`，在轮边界注入 developer 片段：

```
<context_budget>
You have {remaining} tokens left in this context window.
</context_budget>
```

- 位置：与既有 `requestContext` 规划产物同批注入，保证「同一决策同一指纹」。
- 不新增独立注入管线；预警片段进入 history 后，其自身占用也计入下一轮余额。

### 11.4 与「节约上下文」的引导模板

片段正文可由配置覆盖（对齐 Codex 的 `reminder_message_template` 思路），默认文案需包含：

- 剩余额度；
- 建议行为：避免重复读同一文件、避免重述已确认结论、长任务及时落盘到文件而不是全部留在上下文。

### 11.5 明确不做的事

- 不做「每个 Step 都提醒」（会自我膨胀）。
- 不做强制压缩（另案）。
- 不做会话累计预算与配额（非目标）。

---

## 12. 测试基线

| # | 目标 | 测试位置（新增/扩展） |
|---|------|----------------------|
| T1 | 分型函数全表覆盖（§7.1 七行） | 新增 `src/shared/llm/truncation.test.ts` |
| T2 | `stop_reason=max_tokens` 且只有 thinking → 不再返回 `ok: true` 静默完成 | 扩展 `electron/toolChatLoop.usage.test.ts` 或新增 `toolChatLoop.truncation.test.ts` |
| T3 | 续跑轮包含上一轮完整 content（含 thinking 块） | 扩展 `electron/claudeStreamHandlers.pairing.test.ts` |
| T4 | 连续续跑达上限 → `turn_end.reason = error` 且错误码正确 | 扩展 `electron/claudeStreamHandlers.context.test.ts` |
| T5 | 重试不重放副作用（工具执行计数 = 1） | 扩展 `electron/toolChatLoop.dependencyRecovery.test.ts` |
| T6 | 截断不做退避重试（调用次数断言） | 新增 `electron/toolChatLoop.retryPolicy.test.ts` |
| T7a | `maxTokens` 上限夹取不超过模型/服务声明的最大输出 | 扩展 `src/shared/llm/toolLoopMaxTokens.test.ts` |
| T7b | *(可选，V1 不做)* `thinkingBudgetTokens` 与 `max_tokens` 联动校验/降级 | 扩展 `electron/claudeToolLoopStreamParams.test.ts`、`src/shared/llm/toolLoopMaxTokens.test.ts` |
| T8 | *(可选，V1 不做)* 余额跨刻度注入一次、同刻度不重复、换窗口重播 | 新增 `src/shared/contextReminder.test.ts` |
| T9 | 事故回放 fixture（§附录 A）端到端不再判 completed | 新增 `electron/toolChatLoop.incidentReplay.test.ts` |
| T10 | 渲染层截断提示与失败原因不串（i18n key 对齐） | 扩展 `src/renderer/services/turnFailureDisplay` 相关测试 + `npm run i18n:check` |

测试纪律沿用 AGENTS.md：开发期只跑定向用例；`npm exec vitest run <file...>` 合并执行；每阶段收尾跑一次全量。

---

## 13. 实施阶段与验收标准

### Phase 0 — 基线固化（不改行为）

- 把事故 SSE/响应序列做成 fixture（只有 thinking 的 `max_tokens` 轮次 + 前后两轮），并写一个当前行为的「特征测试」记录「被判 completed」（明确这是待修复行为）。
- 产出：`docs/analysis/` 下一份事故复盘（含事件片段与行号），与本文档互链。
- **验收**：fixture 能在本地离线复现事故判定路径，测试可在无网络下运行。

### Phase 1 — R1 判定与状态（不含续跑）

- 新增分型函数与单测（T1），扩展返回类型（§7.2）、事件终态（§7.3）、消息字段（§7.4）、UI 提示（§7.5）。
- 行为：截断时 `turn_end.reason` 不再是 `completed`；UI 出现提示；仍不自动续跑。
- **验收**：T1、T2、T9（允许 T9 断言为「不再 completed」）；`npm run typecheck:renderer` + `npm run build:electron:incremental` 通过；i18n key 对齐。

### Phase 2 — R2 续跑

- 实现续跑（§8.2）与 thinking 回传契约测试（T3）；上限与失败语义（T4）。
- **验收**：T3、T4 通过；人工复现「只有 thinking」的会话能自动产出正文或给出明确失败。

### Phase 3 — R3 重试边界与副作用

- 重试白名单（§9.1）、退避上限（§9.2）、checkpoint 消费（§9.3）。
- **验收**：T5、T6 通过；日志中可查 `decisionFingerprint` 与重试次数。

### Phase 4 — R4a 输出上限策略（V1）

- 上限夹取：`maxTokens` 不超过模型/服务声明的最大输出（§10.1），不再承担思考闸门职责。
- **验收**：T7a 通过；既有「工具参数被截断」提示行为不回归。

### Phase 4b — R4b 思考深度配置（**可选，V1 不做**）

- 新增 `thinkingBudgetTokens` 与参数校验/降级（§10.2、§10.3）。
- **验收**：T7b 通过；非法组合被降级且留日志；`npm run i18n:check`（设置页文案）通过。

### Phase 5 — R5 余额预警（**可选，V1 不做**）

- 刻度判定与节流（§11.2）、片段注入（§11.3）、模板（§11.4）。
- **验收**：T8 通过；一次长会话中可观察到「按刻度各提醒一次、同刻度不重复、换窗口重播」。

> Phase 4b 与 Phase 5 属后续版本，**不阻塞 V1 验收**；V1 的收尾为 Phase 0–4 + Phase 6。

### Phase 6 — 清理与收尾

- 删除 `src/shared/assistantContentReconcile.ts` 中的 promote 系列死代码（保留 `extractAssistantTextFromApiContent` 与其测试）。
- 更新 `docs/` 中与 `max_tokens` / thinking 相关的既有说明。
- **验收**：全量 `npm test` 通过；无未使用导出残留（可加 lint 规则或人工核对）。

---

## 14. 决策点

| # | 决策 | 建议 | 影响 |
|---|------|------|------|
| D1 | 截断后默认「自动续跑」还是「立即失败上报」 | 自动续跑（上限内），失败仅在上限耗尽后 | 用户体验与额度消耗 |
| D2 | 连续续跑次数上限 | 2 次 | 防止无限续跑烧额度 |
| D3 | 是否新增 `MessageStatus` 取值 | 否，用 `Message.status = 'completed'` + `truncation` 字段 | 避免全量消费方改动 |
| D4 | *(后续版本)* `maxTokens` 与 `thinkingBudgetTokens` 冲突时 | 自动抬高 `maxTokens`，并在日志记录 | 与 §10.2 校验策略绑定 |
| D5 | *(后续版本)* 余额预警刻度与是否首次无条件播报 | 采用 `[40000, 20000, 8000]`，首次播报默认开启 | 提示密度 |
| D6 | *(后续版本)* 思考深度配置层级 | 会话级（可被模型条目覆盖） | 设置页改动范围 |
| D7 | 是否引入会话累计加权预算 | 本需求不做 | 范围控制 |

---

## 15. 风险与回滚

| # | 风险 | 缓解 | 回滚 |
|---|------|------|------|
| K1 | 续跑改变正常会话的采样轮次与费用 | 默认上限 2；仅在 `max_tokens` 触发；日志记录 `rounds` | 关闭续跑开关（D1）即回到 Phase 1 行为 |
| K2 | 新增 `truncation` 字段导致消息读取兼容问题 | 可选字段 + `schemaVersion` 递增；读侧容错 | 字段为可选，不读即无效 |
| K3 | 误判 `stop_reason` 为截断（如 `other` 被当未完成） | 分型表将 `other/undefined` 定义为保守失败而非续跑；单测覆盖 | 调整分型表优先级 |
| K4 | 提高 `maxTokens` 上限导致单轮费用上升 | 不提高默认值，只做上限夹取 | 恢复旧默认 |
| K5 | *(后续版本)* 余额提示片段自身占用造成上下文增长 | 刻度节流 + 首次播报可关 | 关闭提醒配置 |
| K6 | 清理死代码时误删 thinking 回传相关逻辑 | 清理前先补 T3 断言 | 误删会被 T3 立即捕获 |

---

## 16. 相关文件

**主进程**

- `electron/toolChatLoop.ts`（判定点 `:1036-1042`、参数点 `:585`、截断提示 `:219-239`、assistant 回传 `:1017`）
- `electron/claudeStreamHandlers.ts`（`finalizeTurn` `:254-282`、终态判定 `:520-549`）
- `electron/stopReason.ts`、`electron/toolLoopModelOptions.ts`、`electron/claudeToolLoopStreamParams.ts`
- `electron/anthropicStreamDelta.ts`

**共享层**

- `src/shared/llm/toolLoopMaxTokens.ts`、`src/shared/requestContext.ts`、`src/shared/overflowRecovery.ts`
- `src/shared/contextUsageEstimate.ts`、`src/shared/contextMeter.ts`
- `src/shared/domainTypes.ts`（`Message` `:693-716`、`ModelEntry` `:718-728`）
- `src/shared/assistantContentReconcile.ts`（待清理）

**渲染层**

- `src/renderer/services/turnFailureDisplay.ts`、`src/renderer/components/Chat/ContextUsageRing.tsx`

**参照实现（只读）**

- `F:/Develop/codex`：`codex-rs/codex-api/src/sse/responses.rs:472-482`、`codex-rs/core/src/session/turn.rs:2790-2792`、`codex-rs/core/src/rollout_budget.rs`、`codex-rs/core/src/session/context_window.rs:88-94`、`codex-rs/core/src/session/token_budget.rs:161-224`

---

## 附录 A：事故回放素材

### A.1 判定路径（用现有代码行号串起来）

```
toolChatLoop.ts:1013-1015   content 中筛出 tool_use
toolChatLoop.ts:1017        assistant content 原样入 messagesForApi（thinking 回传点）
toolChatLoop.ts:1036        toolUses.length === 0 → 分支
toolChatLoop.ts:1042        return { ok: true, stopReason: 'max_tokens' }
claudeStreamHandlers.ts:531 finalizeTurn(turnId, 'completed')
```

### A.2 事故轮次的关键字段（供 fixture 使用）

| 字段 | 值 |
|---|---|
| `stop_reason` | `max_tokens` |
| `output_tokens` | `16384` |
| content 结构 | 单个 `thinking` 块，49,931 字符 |
| 是否存在 `text` 块 | 否 |
| 是否存在 `tool_use` 块 | 否 |
| 截断位置示例 | `…centre 348; Agent ` |
| 生效的 `maxTokens` | `16384`（来自带内置工具下限，`src/shared/llm/toolLoopMaxTokens.ts:13`） |

### A.3 期望的修复后行为

| 场景 | Phase 1 后 | Phase 2 后 |
|---|---|---|
| 只有 thinking 的 `max_tokens` 轮次 | 不再 `completed`；UI 提示「本轮达到输出上限」 | 自动续跑，优先产出正文；续跑计数超限则显式失败 |
| 有正文但被截断 | 提示 + 记录 `truncation.kind = truncated_text` | 续跑补齐 |
| 工具参数被截断 | 不执行工具，回灌错误（现有路径扩展到全部工具） | 同左 |
