# Agent Token 用量统计 — 产品需求文档

**版本：** 1.19
**日期：** 2026-09-21
**状态：** 待评审（已按三轮评审报告修订 B1 / B2 / B1' 与 P1、P2 各项）
**主要变更（v1.1）：** 澄清「缓存写入」机制 —— 拆解「口径归一化」与「缓存写入计费」；`cache_creation` 降级为**兼容字段**；命中率分母确定为**方案 B**
**主要变更（v1.2）：** §4 查看维度编号由 `D1–D4` 改为 `DIM1–DIM4`，消除与 §12 决策编号（`D` 前缀）的撞号
**主要变更（v1.3）：** 全文叙述方式优化 —— 把生造说法与堆砌术语改回白话、给缺主语的句子补主语；补充 §2.5 中方案 A / 方案 B 的完整定义
**主要变更（v1.4）：** 按评审确认收缩第一版范围 —— ①图表库选定 `recharts`（方案 A，记为 C4）；②**某日会话明细表移出第一版**（记为 C5），连同「点击折线图下钻」、「按维度分组折线」一并列入新增的 [§10.2 后续迭代](#102-后续迭代第一版不含)，第一版折线图固定按天、四个维度仅作筛选
**主要变更（v1.5）：** 界面形态确定为 Drawer（记为 C6）
**主要变更（v1.6）：** 确定**执行一次性历史数据回填**（记为 C7），§7.4 由「可选」改为已确认；新增 §6.3 记录事件台账的保留策略现状（按会话数量、每 workDir 保留 100 个），并修正 §6.1 S3 中「保留期清理」的不准确表述
**主要变更（v1.7）：** 统计数据保留期确定为「**按天、可配置、删除留痕**」（记为 C8），§7.5 重写
**主要变更（v1.8）：** 「步数」口径确定为「**实际产生了 usage 记录的 Step 数，不按 outcome 剔除**」（记为 C9）；「只看成功 Turn」列入 §10.2 后续迭代，本版不做
**主要变更（v1.9）：** 工具调用确定为**三分类**（执行成功 / 执行失败 / 未执行），五类「未执行」不计入工具出错，新增 `tool_skipped_count`（记为 C10）；§2.4 重写为分类表 + 实现约束
**主要变更（v1.10）：** 新增附带改动：把确认结果落一笔台账事件（`tool_decision`，记为 C11），使今后的回填也能区分「未执行」与「执行失败」；新增 §7.6
**主要变更（v1.11）：** 修正迁移版本号 —— 代码基线已推进到 **v15**（v14 为 `sessions.ownership`/`visibility`，v15 为 butler 表），本需求应为 **v15 → v16**，§7.2 / §11.3 / §13 同步
**主要变更（v1.12）：** 决策项全部结清 —— 子 Agent / 远程渠道用量确定为**合并计入、按渠道拆分留后续**（记为 C12），时间粒度与会话跳转确定为第一版不做（记为 C13）；§12.2 清空并附「原 D1–D9 去向」对照；§1.2 G1 / §4 / §9.3 / §10.1 / §10.2 / §8.2 同步
**主要变更（v1.13）：** **provider 字段形态采样完成**（1281 条真实样本，记为 C14）—— §2.6 由「实施前置校验」固化为「字段形态基线」，含 provider 对照表、四条采样结论、真实样例与真实命中率分布；§2.2.1 / §7.4 / §11.1 同步
**主要变更（v1.14）：** 附带改动改按**方案 B** —— 由「新增 `tool_decision` 台账事件」改为「**在 `tool_result` 上标注「未执行」**」，不新增 SessionEvent 类型、无旧版本降级风险；§7.6 重写，§7.3 / §7.4 / §2.4.3 / §13 同步
**主要变更（v1.15）：** **按 2026-09-17 评审报告修订** —— 修 B1（§2.4.3「唯一入口」与 §7.6 六个出口矛盾）、B2（`budget_paused` 无归属、`break` 后剩余工具未定义）；修 P1-1（`usage_turn_facts` 写入点改到 `finalizeTurn`，新增 §7.3.1 传递通道与崩溃补齐）、P1-2（`source` 恒为 `api`，estimate 属后续）、P1-3（右轴裁决，新增 C15）、P1-4（`Filters` 形状 + SQL 加 `llm_service_id`）、P1-5（计数基准，新增 §2.4.0）；P2 各项（`is_error` 描述、文件归属、`stepId`→`requestId`、payload 引述、`en`→`en-US`）；新增 §2.4.4、T16、R6
**主要变更（v1.16）：** **按 v1.15 复审报告修订** —— 修 **B1'**（`finalizeTurn` 只覆盖桌面链路，远程 / butler 会缺失）：`usage_turn_facts` 改到 **`runToolChatSession` 统一收口**（新增 C16），删除跨模块累加器设计，声明远程台账盲区；修 P1-1（`interrupted` Turn 排除恒等式、synthetic 仅回填路径、按 `toolUseId` 归因）、P1-2（远程任务预算门控纳入「未执行」，来源增至七类，§7.6 改为 14 处出口穷举表）、P1-3（§9.3 修正远程不落台账的事实）；P2 各项（累加器内容、§7.3 冗余「流式路径」行、synthetic 归因、悬空引用、tsdoc 注释）
**主要变更（v1.17）：** **按 v1.16 复审报告修订** —— 修 P1-1（`runToolChatSession` 新增 `turnId` 入参，新增 C17；§7.3 加「前置改动」段，§13 补远程 / butler 四个文件）、P1-2（**第 15 个 `tool_result` 发出点**：绕过 `recordToolResult` 的输出截断路径纳入「未执行」，来源增至**八类**，§7.6 表扩为 15 处）、P1-3（butler 台账 `turnId` 是 `sessionId` 占位 → §7.4 声明局限与两种归因方向）、P1-4（穷举表边界已含第 15 点）；P2 各项（`outcome` 枚举改为实际取值、§2.4.1 判定原则统一、T16 措辞）
**主要变更（v1.19）：** **按 run-shell 宿主初始化故障案 P1-D 落地同步** —— `notExecutedReason` 新增 **`agent_denied`**：安全审批 Agent 机审拒绝（`cause = 'agent-deny'`）不再误标为 `user_rejected`（那会把「Agent 被拒」计入「用户拒绝」污染统计与归因）；「未执行」的**来源仍为八类**（机审拒绝本就属第 1 类「确认未批准」的子情形），仅枚举值细分；通道机器侧 fail-closed 拒绝（`recursion-blocked` / `unavailable` / `unparsable` / `config-error` 等）归类 `policy_denied`。§2.4.1 / §7.6 / §11.1 / C10 同步
**主要变更（v1.18）：** 清理 v1.17 的两处 P2 残留 —— ①§7.3.1 第 3 条的 `outcome` 取值 `success` → **`completed`**（与 §7.1 表 2 的枚举一致）；②§13 删除 `claudeStreamHandlers.ts` 的重复旧行（保留含 `turnId` 入参的新行）
**优先级：** P1
**关联文档：**

- `docs/requirement/context-usage-ring-requirement.md`（单会话上下文用量环，v1.0）
- `docs/requirement/context-usage-ring-v2-improvements.md`（上下文用量持久化与口径修订，v2.0）
- `docs/requirement/context-usage-estimated-occupancy-requirement.md`（预估占用口径）
- `docs/develop/session-record-eventflow-persistence-redesign-plan.md`（SessionEvent 台账设计）

---

## 目录

1. [概述](#1-概述)
2. [术语与指标口径](#2-术语与指标口径)
3. [指标需求](#3-指标需求)
4. [查看维度需求](#4-查看维度需求)
5. [界面需求](#5-界面需求)
6. [数据来源现状与差距分析](#6-数据来源现状与差距分析)
7. [数据采集与存储设计](#7-数据采集与存储设计)
8. [聚合与查询设计](#8-聚合与查询设计)
9. [边界、降级与一致性](#9-边界降级与一致性)
10. [非目标与后续迭代](#10-非目标与后续迭代)
11. [验收标准](#11-验收标准)
12. [决策记录](#12-决策记录)
13. [预估改动文件清单](#13-预估改动文件清单)
14. [文档修订记录](#14-文档修订记录)

---

## 1. 概述

### 1.1 背景

当前 SpaceAssistant 已具备**单会话粒度**的 token 视图（`ContextUsageRing` 上下文用量环），但它只回答「当前会话上一次请求的上下文占用是多少」，无法回答以下问题：

- 我在过去一个月里总共消耗了多少 token？
- 输入 token 里有多少是缓存命中的？缓存命中率随时间的变化趋势如何？
- 哪个会话 / 哪个模型最耗 token？
- 工具调用有多频繁？出错率多高？Agent 平均每个 Turn 要跑几步？

用户希望有一个**跨会话、跨时间、多维度的 Token 用量统计视图**，用来感知成本、复盘自己的使用习惯。

### 1.2 目标

| 编号 | 目标 |
|------|------|
| G1 | 提供「整个 Agent」级别的 Token 消耗汇总，按日期 / 会话 / 模型 / APP 版本号四个维度查看。**「整个 Agent」含远端渠道（飞书 / 微信）触发的回合** —— 它们同样由本 Agent 执行，消耗真实产生（见 C12） |
| G2 | 提供按天趋势折线图（主：输入 / 输出 token；次：输入缓存命中率），默认近 30 天，可筛选周期 |
| G3 | 支持下钻：选中某天 → 查看当天所有会话的统计明细（**第一版不含，列入 [§10.2 后续迭代](#102-后续迭代第一版不含)**） |
| G4 | 入口放在菜单「查看」（`View`）下，沿用现有的 Electron 菜单 + IPC 事件机制 |
| G5 | 数据在应用重启、会话删除、workDir 切换后依然稳定，不依赖那些会被定期清理的临时台账 |

### 1.3 范围

| 类别 | 说明 |
|------|------|
| **新增** | 统计用的数据表（SQLite）、把用量写进表的采集逻辑、汇总查询的 IPC 接口、统计界面、菜单入口、i18n 资源 |
| **复用** | 现有的用量归一化逻辑（`normalizeAnthropicMessageUsage`）与缓存字段语义判定（`cacheSemantics`）、SessionEvent 台账里已有的埋点、`turns` 表的 Turn 生命周期、`getSessionEventSink` |
| **不变** | `ContextUsageRing` 单会话视图、`turns` / `messages` 的现有结构与含义、会话备份机制 |

---

## 2. 术语与指标口径

> 本章是全文的**口径基准**。所有指标计算、图表与表格必须严格遵循此处定义，避免「同名不同义」。

### 2.1 基础术语

| 术语 | 定义 |
|------|------|
| **Turn（轮次）** | 一次用户消息触发的完整 Agent 执行单元，对应 `turns` 表一行（`turn_id`）。一个 Turn 可包含多步 LLM 调用与多轮工具调用。 |
| **Step（步）** | Turn 内的一次 LLM 请求。代码里对应 `toolChatLoop` 的 `loopRound`，台账里对应一对 `step_start` / `step_end` 事件，也对应 `request_usage` 事件中 `requestId` 形如 `${requestId}:round:${n}` 的那条记录（**字段名是 `requestId`，payload 里没有 `stepId` 字段**）。 |
| **Tool Call（工具调用）** | 一次具体工具执行，对应 `tool_call` 事件一条、`ToolUseData` 一条（以 `toolUseId` 唯一标识）。 |
| **缓存命中 Tokens** | provider 返回的 `cache_read_input_tokens`（OpenAI 兼容语义下为 `prompt_tokens_details.cached_tokens`）。**所有 provider 均有此概念。** |
| **缓存写入 Tokens** | provider 返回的 `cache_creation_input_tokens`。**仅「显式缓存」型 provider（Anthropic 原生、Gemini context caching）会产生；本项目主力 provider（DeepSeek / Kimi / GLM / MiniMax 等自动缓存）恒为 0。本需求仅作兼容字段，不作为统计指标。** 详见 [§2.2.2](#222-缓存写入与计费机制仅显式缓存-provider-相关)。 |

### 2.2 Token 口径归一化

> ⚠️ **先厘清一个常见误解**：「缓存写入」**不是**「提前把缓存放好、之后供其他请求命中」的独立步骤，而是**某一次真实请求在读取缓存的同一次调用中，顺便创建了缓存并为这次创建付费**。它属于**计费机制**，与「输入总量怎么算」是两件互不相干的事。下面 §2.2.1 讲前者，§2.2.2 讲后者。

#### 2.2.1 口径归一化（决定「输入总量」怎么算）

provider 返回的 usage 字段有两套不同的语义。判定逻辑分布在两处：`electron/anthropicUsageNormalize.ts` 负责**提取字段**并挂接语义，`src/shared/usageCacheSemantics.ts` 负责**判定语义**（`resolveUsageCacheSemanticsFromBaseUrl`，`:24`）；输入总量的计算在 `src/shared/contextUsageEstimate.ts`（`:22`）。本需求沿用这套判定方式：

| 语义 | 来源特征 | 输入总量计算 |
|------|----------|--------------|
| `additive`（加性，Anthropic 原生 / 兼容端点） | 存在 `cache_read_input_tokens` / `cache_creation_input_tokens`，且 `input_tokens` **不含**缓存部分 | `inputTokens = input_tokens + cache_read_input_tokens + cache_creation_input_tokens` |
| `subset`（子集，OpenAI 兼容） | `prompt_tokens` 已包含 `prompt_tokens_details.cached_tokens` | `inputTokens = prompt_tokens`（缓存命中为其中的子集） |

> ⚠️ **实测提示**：本项目**实际 provider 组合只会走 `additive` 分支**，`subset` 为纯兼容预留 —— 1281 条真实样本中**没有任何** OpenAI 风格字段（见 [§2.6.2](#262-采样结论四条均有数据支撑)）。实现时仍须保留 subset 分支，但不必为其单独准备测试数据。

**统一规约（本需求核心口径）：**

```text
输入 Tokens（inputTokens）  = 归一化后的「进入模型的全部输入 token」，含缓存命中与缓存写入
输出 Tokens（outputTokens） = provider 返回的 output_tokens
总 Tokens（totalTokens）    = inputTokens + outputTokens
缓存命中 Tokens             = cache_read_input_tokens（subset 语义下为 cached_tokens）
缓存写入 Tokens             = cache_creation_input_tokens（多数 provider 恒为 0，见 §2.2.2）
```

> ⚠️ 注意：`additive` **只是字段语义**，与「是否收取缓存写入费」**无关**。例如 DeepSeek 走 Anthropic 兼容端点时会被判为 `additive`，但它 `cache_creation_input_tokens` 恒为 0、也不收写入费。

#### 2.2.2 缓存写入与计费机制（仅「显式缓存」provider 相关）

prompt 缓存有两套机制，定价逻辑完全不同：

| 机制 | 代表 provider | 输入价格档位 | 是否有写入费 |
|------|---------------|--------------|--------------|
| **自动缓存**（implicit / automatic） | DeepSeek、OpenAI、Kimi、GLM、MiniMax、通义 | 命中 / 未命中（**2 档**） | ❌ 无 |
| **显式缓存**（explicit，需 `cache_control` 标记） | Anthropic 原生、Gemini context caching | 命中 / 未命中 / **写入**（**3 档**） | ✅ 有 |

「缓存写入」的准确语义是「**某次请求一边读一边建、并为创建付费**」：

- **不是「提前写」**：读取与写入发生在**同一次**请求；同一次响应里 `cache_read` 与 `cache_creation` 可同时非 0（如 100K 前缀中 80K 命中、20K 因刚延长而新建）；
- **不是免费**：写入约为普通输入的 1.25×～2×（视 TTL 而定），命中约为 0.1×（倍率以 provider 官方定价页为准），本质是**一笔有回收期的预付费**；如果这段前缀之后再也没有被复用，这笔写入成本就是净支出；
- **换取的不是「更早命中」**（自动缓存第二次请求即命中），而是 **TTL 与缓存边界的确定性**。

**本需求的处理约定：**

| 项 | 约定 |
|----|------|
| `cache_creation_tokens` | 存储层**保留字段**（兼容 Anthropic 原生等显式缓存 provider），但**不作为统计指标**；界面**仅在值 > 0 时条件展示** |
| DeepSeek / Kimi / GLM / MiniMax 等自动缓存 provider | 该字段恒为 0，界面**不出现空列 / 空卡片** |
| 费用估算 | 不在本需求范围（见 [§10.1](#101-明确不做长期非目标)）；如需实现，须基于三档分别定价 |

### 2.3 指标计算公式

| 指标 | 公式 |
|------|------|
| Tokens 总消耗量 | `Σ(totalTokens) = Σ(inputTokens) + Σ(outputTokens)` |
| 输入 Tokens 数量 | `Σ(inputTokens)`（含缓存命中与缓存写入） |
| 输出 Tokens 数量 | `Σ(outputTokens)` |
| 缓存命中 Tokens 数量 | `Σ(cacheReadTokens)` |
| **输入缓存命中率** | `Σ(cacheReadTokens) / (Σ(inputTokens) − Σ(cacheCreationTokens))`（**方案 B：分母不含缓存写入**，见 [§2.5](#25-缓存命中率口径已确认方案-b)）。分母为 0 时为 `N/A`，不显示 0% |
| 工具调用次数 | `Σ(toolCallCount)` |
| 工具出错次数 | `Σ(toolErrorCount)`（口径见 [§2.4](#24-工具调用分类与出错口径)） |
| Turn 总数 | `Σ(turnCount)`（含失败 / 取消的 Turn，见 [§9.3](#93-统计口径与去重)） |
| **平均每 Turn 步数** | `Σ(stepCount) / Σ(turnCount)`。分子分母**口径一致、都不过滤 outcome**（失败 / 取消的 Turn 与其 Step 一并计入，见 [§9.3](#93-统计口径与去重) 与 C9） |

### 2.4 工具调用分类与出错口径

> ✅ **已确认（C10）**：每次工具调用归入且仅归入以下三类之一，**三者之和 = 工具调用次数**。

| 分类 | 判定依据 | 计入哪个计数器 |
|------|----------|----------------|
| **执行成功** | 执行器返回 `success: true` | 不计数（由总数减出） |
| **执行失败** | 已通过授权 / 确认 / 策略 / 预算环节、**进入执行流程**后失败：输入校验不通过、写路径冲突、计划阶段抛错、执行器返回 `success: false`，或执行器抛错被转为错误结果（含依赖缺失、**执行超时**、权限不足） | `tool_error_count` |
| **未执行** | 工具在**授权 / 确认 / 策略 / 预算**环节被拦下，**从未进入执行流程**（执行流程 = 输入校验、写路径冲突检查、计划阶段、执行器） | `tool_skipped_count` |

#### 2.4.0 计数基准与恒等式

**恒等式（本需求的不变量）**：

```text
tool_call_count = 执行成功 + 执行失败 + 未执行
```

**计数基准：以 `tool_result` 终态为准。** `tool_call_count` = 该 Turn 内**落了 `tool_result` 的工具调用数**。

- **理由**：每个终态必然归入三类之一，恒等式**按构造成立**，不依赖实现者在每个退出点都记得补记。若改以 `tool_call` 事件数为基准，则「批次中断导致有 `tool_call` 却无 `tool_result`」的孤儿会让恒等式**静默破裂**（见 [§2.4.4](#244-边界情形批次中断与崩溃恢复)）。
- **孤儿不计入**：批次中断后未被处理的 `tool_call`（无 `tool_result`）**不计入** `tool_call_count`，也不进入任何计数器。
- **必须覆盖全部 `tool_result` 发出点，不只有 `recordToolResult`**：`toolChatLoop` 内还有**一处绕过 `recordToolResult`** 直接 `emitSessionEvent({ type: 'tool_result', ... })` 的路径（输出截断恢复，`electron/toolChatLoop.ts:1077`）。它同样产生终态，**统计侧必须一并累加**，否则实时计数会漏、恒等式在该路径下破裂。该路径的归类见 [§2.4.1](#241未执行的八种来源都不计入工具出错) 第 8 类。

**恒等式的作用域（重要）**：恒等式只对**正常收口**的 Turn 断言。`outcome = 'interrupted'` 的 Turn（进程崩溃后由启动补齐写出，见 [§7.3.1](#731-工具计数的持有与-turn-收口)）**工具计数不可知、按 0 写入**，因此**排除**在恒等式断言与工具出错率分母之外。这是有意的口径选择，不是遗漏。

**合成 `tool_result` 的归属（仅回填路径）**：

- **适用范围**：崩溃恢复时 `reconcileSessionEvents`（`electron/sessionEvents.ts`）会为孤儿 `tool_call` 合成一条带 `synthetic: true` 的 `tool_result`。它只存在于**台账**（JSONL）里，**实时统计侧永远看不到**（实时写入是 `runToolChatSession` 内的局部计数，直接落 SQLite）。所以「synthetic 计入未执行」**只对 [§7.4](#74-历史数据回填已确认执行) 的回填路径成立**。
- **归因方式**：合成事件本身的 payload 是 `{ toolUseId, synthetic: true, result }`，**不含 `turnId`**。但它带 `toolUseId`，可关联同会话的 `tool_call` 事件取到 `turnId` —— 按此归因，**不需要 seq 邻接**（[§7.4](#74-历史数据回填已确认执行) 的回填实现要点已补此项）。

#### 2.4.1「未执行」的八种来源（都不计入工具出错）

**判定原则**：只要工具**从未进入执行流程**（执行流程 = 输入校验、写路径冲突检查、计划阶段、执行器），就归「未执行」—— 不看拒绝理由的性质，只看「是否执行过」。下表是当前已知的 8 类。**实施时须以 `toolChatLoop` 内全部 `tool_result` 发出点为准逐一归类**（含**绕过 `recordToolResult`** 的那一处）：凡「未进入执行流程就直接落 `tool_result`」的分支都要一并归入，不能只按本表机械照做。

| # | 来源 | 代码依据 |
|---|------|----------|
| 1 | 确认未批准——**真人拒绝**（`user_rejected`）或**安全审批机审拒绝**（`agent_denied`，v1.19 起区分） | `outcome === 'rejected'`：无 `rejectReason` → `user_rejected`；确认通道 cause 为 `agent-deny` → `agent_denied`；机审 fail-closed（`recursion-blocked` / `unavailable` / `unparsable` / `config-error` 等）→ `policy_denied` |
| 2 | 确认超时（用户一直没响应） | `outcome === 'timeout'` |
| 3 | 远程只读策略拦截 | `rejectReason === 'remote_read_only'` |
| 4 | 远程授权已撤销 / 执行租约失效 | `rejectReason === 'authorization_revoked'` |
| 5 | 策略直接拒绝 | 门控返回 `deny`（`Decision.type === 'deny'`）；另含 shell 预检短路 `gate.shellPrecheckDeny` |
| 6 | 出站写预算耗尽（`gate.budgetPause`） | 非空即拦截 |
| 7 | **远程任务预算耗尽**（`checkRemoteTaskBudget(..., 'tool_call')` 失败） | `toolChatLoop.ts` 中 `if (remoteBudgetState)` 的预算门控分支，**无条件 `break`** |
| 8 | **模型输出截断**放弃工具调用（`model_output_token_limit`） | 输出截断恢复路径（`toolChatLoop.ts:1077`）—— 该处**绕过 `recordToolResult`**，直接 `emitSessionEvent`；同批次工具调用整体被放弃 |

> ⚠️ 注意区分两种「超时」：**确认超时**（用户没响应）归「未执行」；**执行器执行超时**（工具跑了但超时）归「执行失败」。

> ⚠️ 第 5、6、7 类共涉及**四个分支**（`gate.shellPrecheckDeny` / `gate.budgetPause` / `decision.type === 'deny'` / `remoteBudgetState` 预算门控），它们**都不进确认环节**；第 8 类是**整体放弃**（与单点拦截不同）。注意「来源」与「代码出口」**不是一一对应**：确认未批准是**一个**出口，却覆盖第 1、3、4 三类来源，详见 [§7.6](#76-附带改动-在-tool_result-上标注未执行)。

#### 2.4.2 为什么这么分

- **拒绝不算出错**：否则「用户越谨慎（多拒绝几次）→ 出错率越高」，这个结论显然不成立。拒绝恰恰说明安全机制在正常工作，是正反馈。
- **必须单列「未执行」**：被拒绝的调用同样会落 `tool_result`（只是标记为未执行），它们已被计入 `tool_call_count` 的分子。如果只在「出错」里扣除、不为这些调用单独计数，它们就会从统计里凭空消失，恒等式也对不上。

#### 2.4.3 实现约束（重要）

1. **必须用写入点处的内存变量判断分类** —— 即 `confirmationDecision.approved` / `outcome` / `rejectReason` / `gate.budgetPause`，**不能**靠解析 `tool_result` 的 `success` 字段。原因：台账里两者都表现为 `success: false`、且都带 `error` 文案，**没有字段能可靠区分** —— `is_error` 只存在于模型侧 block（`buildToolErrorResult`），落盘对象 `ToolCallResultPersisted` 并没有该字段；执行失败路径通常还带 `data` / `userMessage`，但不足以作为判据。见 [§7.3](#73-写入时机与写入口)。
2. **不要复用** `toolErrorRepeat`（「同一工具连续出错」的熔断计数器）：它在**拒绝路径上也会 `noteFailure`**（`toolChatLoop.ts` 中 `if (!confirmationDecision.approved)` 分支内、紧随 `recordToolResult` 之后），复用会把「拒绝」间接算成「错误」。统计侧独立判断。
3. **不改动现有 tool_result 形状与台账格式**，是纯增量改动：只在统计侧记一笔，不动 `buildToolErrorResult`、不动 `SessionEvent` 结构、不动熔断行为。
4. **统计侧与台账侧挂在同一批出口上**：`tool_skipped_count` 的累加点，与 [§7.6](#76-附带改动-在-tool_result-上标注未执行) 的 `notExecuted` 标记点必须落在**同一批出口**（按 [§2.4.1](#241未执行的八种来源都不计入工具出错) 的判定原则逐一核对）。**不要**只挂在确认未批准分支 `if (!confirmationDecision.approved)` 上 —— 那会漏掉全部不进确认环节的出口（策略拒绝、预算耗尽等），恒等式会静默破裂。
5. 同时把「未执行」的分类写进落盘的 `tool_result`（见 [§7.6](#76-附带改动-在-tool_result-上标注未执行)），使**将来**的回填也能区分「未执行」与「执行失败」。

#### 2.4.4 边界情形（批次中断与崩溃恢复）

| 情形 | 台账 | 计数 |
|------|------|------|
| 批次内某个工具触发 `break`（连续同错达阈值 / 出站写预算耗尽 / **远程任务预算耗尽** / 预检拒绝） | 触发者已有 `tool_result`；**同批次其余 `tool_use` 不落 `tool_result`**（`toolChatLoop` 直接跳出该批次的 `for` 循环，不补记） | 触发者计入「未执行」；其余为**孤儿**，不计入（见 [§2.4.0](#240-计数基准与恒等式)） |
| Turn 正常结束 | 全部 `tool_use` 均有 `tool_result` | 全部计入 |
| 应用崩溃后被恢复 | `reconcileSessionEvents` 为孤儿 `tool_call` 合成 `tool_result`（`synthetic: true`） | 合成结果**计入「未执行」** |
| Turn 被用户在流式中取消 | 视取消时机而定；未产生 `tool_result` 的即为孤儿 | 孤儿不计入 |

> **注意两类预算门控的 `break` 都是无条件的**（出站写预算 `gate.budgetPause` 与**远程任务预算** `remoteBudgetState` 两个分支都直接 `abortRepeatedToolError = pauseMsg; break`），与另两处「`noteFailure` 达阈值才 `break`、否则 `continue`」不同 —— 即预算耗尽**一定**中断同批次剩余工具。此外，**未授权工具**（`authorizeToolCall` 失败）与**未知工具名**两个分支**不做 `noteFailure`**，属「未执行」但不触发熔断。

### 2.5 缓存命中率口径（已确认：方案 B）

计算命中率时，分子固定是「缓存命中 Tokens」，分母有两种算法：

| 方案 | 分母 | 含义 |
|------|------|------|
| 方案 A | 输入 Tokens 总量（含缓存写入） | 把缓存写入也算作「可被命中的输入」 |
| **方案 B（已确认）** | 输入 Tokens 总量 − 缓存写入 | 写入不算，只看真正可能命中的那部分 |

**本需求采用方案 B：**

```text
命中率 = Σ(cacheReadTokens) / (Σ(inputTokens) − Σ(cacheCreationTokens))
```

即**分母 = 输入总量 − 缓存写入量**，按字段语义展开：

| 语义 | 分母展开 |
|------|----------|
| `additive` | `input_tokens + cache_read_input_tokens`（**不含** `cache_creation_input_tokens`） |
| `subset` | `prompt_tokens`（写入量恒为 0） |

**这样选的道理：**

- 「缓存写入」是**建立缓存的成本**，不是「可供命中的输入」。把它算进分母会压低命中率（Anthropic 首次新建缓存时尤其失真），不符合这个指标的本来含义；
- 在自动缓存 provider（DeepSeek / Kimi / GLM / MiniMax）上写入恒为 0，方案 A 与 B **完全等价**，所以这个选择不影响主力场景，只是把 Anthropic 原生场景的语义理顺了。

**其他展示约定：**

- 图表右轴（命中率）固定为 `0% ~ 100%`（**第一版裁决，见 C15**）；当某天没有数据、或分母为 0 时，该点直接断线（不要画成 0%）；
- 缓存写入若需要展示（仅值 > 0 时），放在各 token 指标之后，并标注为补充信息。

### 2.6 provider 字段形态基线（已采样 2026-09-13）

> ✅ **已采样完成。** 数据来源：本项目 `logs/Agent-*.log`（41 个文件，提取 1281 条 `llm.response.usage`）+ 项目内 `sessions/*/events.jsonl` 的 `request_usage` 事件。原本设计为「实施前置校验」，因样本充足，此处直接固化为基线。

#### 2.6.1 实际 provider 与字段形态

| provider | baseUrl | 出现的 model | usage 字段 | `cacheSemantics` |
|----------|---------|--------------|-----------|------------------|
| DeepSeek（Anthropic 兼容端点） | `https://api.deepseek.com/anthropic` | `deepseek-v4-pro`、`deepseek-v4-flash` | `input_tokens`、`output_tokens`、`cache_read_input_tokens`、`cache_creation_input_tokens` | `additive` |
| 火山方舟 | `https://ark.cn-beijing.volces.com/api/coding` | `kimi-k2.6`、`deepseek-v4-pro` | `input_tokens`、`output_tokens`、`cache_read_input_tokens`（**无** `cache_creation_input_tokens`） | 缺字段（见 2.6.3） |

样本量：DeepSeek **1166** 条、火山方舟 **115** 条。

#### 2.6.2 采样结论（四条，均有数据支撑）

| # | 结论 | 数据 |
|---|------|------|
| 1 | **`cache_creation_input_tokens` 恒为 0** —— 实证了 C1 把它定为「兼容字段」的判断 | 1166 个样本**全部为 `0`**；火山方舟干脆不返回该字段 |
| 2 | **`cache_read_input_tokens` 非零占 84.6%** —— 缓存命中是常态，这个指标有实际意义 | 1084 / 1281 条非零 |
| 3 | **`subset` 语义在实际 provider 组合中从未出现** —— [§2.2.1](#221-口径归一化决定输入总量怎么算) 的 subset 分支**是纯兼容预留** | `prompt_tokens` / `prompt_tokens_details` / `cached_tokens` / `total_tokens` 全部 **0 次命中** |
| 4 | **火山方舟确认是 `additive`** —— `input_tokens` **不含**缓存部分 | 样本 `{input_tokens: 122, cache_read_input_tokens: 23812}`：若为 subset，input 不可能远小于 cache_read |

#### 2.6.3 两条实现约束（采样暴露出来的）

1. **`cacheSemantics` 字段可能缺失**：仅 420 / 1281（32.8%）样本带此字段（该特性是后加的）。**新采集**的数据经 `normalizeAnthropicMessageUsage`（`electron/anthropicUsageNormalize.ts`）会补上；**回填**时若缺失，需 fallback 到 `resolveUsageCacheSemanticsFromBaseUrl(baseUrl)`（`src/shared/usageCacheSemantics.ts:24`）—— 而 baseUrl **不在** `request_usage` 事件里，须从 `turns.execution_config_json` 取（见 [§7.4](#74-历史数据回填已确认执行)）。
2. **模型名会演进**：样本里是 `deepseek-v4-pro` / `kimi-k2.6`，与 `res/resource/modes.md` 的登记值已不完全一致。**字段形态比模型名稳定** —— 归一化逻辑应依赖字段形态（`cacheSemantics`），不要按模型名硬编码。

#### 2.6.4 真实样本（可直接用作验收数据）

| 场景 | usage 原文 | 归一化输入 | 命中率（方案 B） |
|------|-----------|-----------|------------------|
| DeepSeek 一个 Turn 的**首轮**（尚无缓存可命中） | `{input: 14365, cache_read: 0, cache_creation: 0, output: 124}` | 14365 | **0%** |
| 同 Turn **第 3 轮**（缓存已建立） | `{input: 4364, cache_read: 46464, cache_creation: 0, output: 760}` | 50828 | **91.4%** |
| DeepSeek **长上下文**（命中接近满） | `{input: 443, cache_read: 427520, cache_creation: 0, output: 1662}` | 427963 | **99.90%** |
| **火山方舟**（`kimi-k2.6`） | `{input: 122, cache_read: 23812, output: 156}` | 23934 | **99.49%** |

#### 2.6.5 真实用量特征（供界面设计参考）

基于 1166 条 DeepSeek 样本的命中率分布：

| 区间 | 条数 |
|------|------|
| 0%（无缓存，通常是每个 Turn 的首轮） | 86 |
| 0.1% – 30% | 39 |
| 30% – 60% | 41 |
| 60% – 90% | 208 |
| ≥ 90% | 792 |

均值 **82.3%**、中位数 **95.7%**。

> **对折线图的直接影响**：真实数据高度集中在 60%–100% 区间。右轴若按 0–100% 均匀分刻，曲线会长期贴在图顶、看不出变化。**已裁决（C15）**：第一版**仍固定 0–100%**（与验收 T3 一致、读者最直观）；「60%–100% 加密刻度 / 自适应下界」列入 [§10.2](#102-后续迭代第一版不含)。

---

## 3. 指标需求

| 编号 | 指标 | 类型 | 精度 | 说明 |
|------|------|------|------|------|
| M1 | Tokens 总消耗量 | 计数器 | 整数 | `Σ(input + output)` |
| M2 | 输入 Tokens / 输出 Tokens | 双计数器 | 整数 | 同时展示绝对值与占比 |
| M3 | 缓存命中 Tokens | 计数器 | 整数 | `cache_read` |
| M3b | 缓存写入 Tokens（**兼容字段，非统计指标**） | 计数器 | 整数 | `cache_creation`。**仅在值 > 0 时条件展示**（Anthropic 原生等显式缓存 provider）；DeepSeek / Kimi / GLM / MiniMax 等恒为 0，界面不出现该列 |
| M4 | 输入缓存命中率 | 比率 | 0.1% | 缓存命中 Tokens ÷（输入 Tokens − 缓存写入 Tokens）（**方案 B**，见 [§2.5](#25-缓存命中率口径已确认方案-b)）；分母为 0 时显示 `—` |
| M5 | 工具调用次数 | 计数器 | 整数 | = 执行成功 + 执行失败 + 未执行；计数以 `tool_result` 终态为基准（见 [§2.4.0](#240-计数基准与恒等式)） |
| M5b | 工具出错次数 | 计数器 | 整数 | 仅计「**执行失败**」；不含拒绝 / 确认超时 / 策略拦截 / 预算耗尽 |
| M5c | 工具未执行次数（补充） | 计数器 | 整数 | **八类**来源：拒绝 + 确认超时 + 远程只读 + 授权撤销 + 策略拦截 + 出站写预算耗尽 + 远程任务预算耗尽 + **模型输出截断**（见 [§2.4.1](#241未执行的八种来源都不计入工具出错)）；保证「成功 + 失败 + 未执行 = 调用次数」（`interrupted` Turn 除外，见 [§2.4.0](#240-计数基准与恒等式)） |
| M5d | 工具出错率（补充） | 比率 | 0.1% | `工具出错 / 工具调用` |
| M6 | 平均每 Turn 步数 | 均值 | 0.01 | 同时展示 Turn 总数与 Step 总数作为佐证 |
| M7 | Turn 数 / Step 数（支撑指标） | 双计数器 | 整数 | M6 的分子分母，界面需可见以便核对 |

**展示要求：**

- 数值超过 100 万时用缩写展示（如 `1.28M`），鼠标悬停时显示精确值；
- 所有比率类指标保留 1 位小数；
- 计数类指标用千分位分隔。

---

## 4. 查看维度需求

> **编号说明：** 本节四个维度用 **`DIM`** 前缀编号，以区别于 [§12](#12-决策记录) 的决策编号（`D` 前缀），避免同一个「D3」既指模型维度、又指界面形态决策。

| 编号 | 维度 | 取值来源 | 说明 |
|------|------|----------|------|
| DIM1 | **日期** | 记录写入时的本地时间戳 → 本地自然日 `YYYY-MM-DD` | 默认聚合粒度；时区固定为系统本地时区 |
| DIM2 | **会话** | `session_id` + 会话标题（`sessions.name`；已删除会话显示「已删除会话」） | 支持点击会话跳转（可选，见 [§10.2](#102-后续迭代第一版不含)） |
| DIM3 | **模型** | `model` + `llm_service_id` | 同模型跨服务的用量**分开统计**，展示为 `{服务名} / {模型名}` |
| DIM4 | **APP 版本号** | 主进程 `app.getVersion()`（写入时快照） | 历史数据缺失版本号时归入「未知版本」 |

**维度能力要求：**

1. 四个维度都支持作为**筛选条件**（filter）。至于把它们作为**分组维度**（改变折线图的 X 轴、或拆成多条线），列入后续迭代，见 [§10.2](#102-后续迭代第一版不含)。
2. 日期维度额外支持**时间粒度切换**（按天 / 按周 / 按月，默认按天；见 [§10.2](#102-后续迭代第一版不含)）。
3. 按会话维度展示时，需要关联 `sessions` 表读取会话标题和工作目录；会话被删除后，统计记录**不删除**（保留历史），只是显示成「已删除会话」。

---

## 5. 界面需求

### 5.1 入口

| 项 | 要求 |
|----|------|
| 位置 | 菜单「查看」（`labels.view`）下，置于「开发者工具」之后、「设置」之前，中间用分隔线隔开 |
| 菜单项文案 | zh-CN：`Token 用量统计`；en-US：`Token Usage` |
| 实现方式 | 沿用 `electron/menu.ts` 的 `sendToRenderer('app:open-usage-stats')` 模式 |
| 渲染侧 | `preload.ts` 暴露 `onOpenUsageStats(cb)`；`App.tsx` 订阅后打开统计面板 |
| 快捷入口（可选） | 设置 → 「关于」或会话列表侧边栏底部，暂不纳入 MVP |

### 5.2 界面形态

本项目目前没有前端路由（未引入 react-router），窗口是固定的三栏布局。**已确认**把这个统计界面做成 **Ant Design 的 `Drawer`（宽 `86%`，从右侧滑出，`destroyOnClose`）**，理由：

- 和现有 `SettingsModal` / `AboutModal` 一样是弹层，交互习惯一致；
- 不用改动三栏布局和路由；
- 关闭后即可释放图表的渲染开销。

> ✅ **已确认（C6）**：采用 Drawer 形态。备选方案（全屏独立页面、独立 BrowserWindow）需要引入路由或新增渲染进程入口，投入与「看一眼用量」的诉求不成比例，不予采用。

### 5.3 布局与内容

统计面板从上到下分为两个部分：

```text
┌───────────────────────────────────────────────────────────────┐
│  Token 用量统计                                    [×]        │
├───────────────────────────────────────────────────────────────┤
│  时间范围: [近 7 天] [近 30 天*] [近 90 天] [自定义 ▾]         │
│  筛选: 模型▾  会话▾  版本▾                                     │
├───────────────────────────────────────────────────────────────┤
│  ┌─ KPI 卡片行 ────────────────────────────────────────────┐  │
│  │ 总 Tokens │ 输入 │ 输出 │ 缓存命中 │ 命中率 │ 工具调用 │  │
│  │  1.28M    │ 1.1M │ 180K │ 860K     │ 78.2%  │ 342/12   │  │
│  │           │ 平均每 Turn 步数: 3.42（Turn 128 / Step 438）│  │
│  └─────────────────────────────────────────────────────────┘  │
├───────────────────────────────────────────────────────────────┤
│  ┌─ 折线图（按天）────────────────────────────────────────┐   │
│  │ 左轴: Tokens (输入 / 输出)   右轴: 输入缓存命中率 (%)   │   │
│  │  [输入 ▬▬] [输出 ▬▬] [命中率 ▬▬]  图例可点击隐藏        │   │
│  └─────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────┘
```

#### 5.3.1 筛选区

| 控件 | 行为 |
|------|------|
| 时间范围 | 预设按钮组 + `DatePicker.RangePicker` 自定义；默认 **近 30 天**（含今天，即 `[today-29, today]`）；最大可选跨度 **365 天**（超出提示并截断） |
| 筛选条件 | 多选：模型（含服务名）、会话、APP 版本；筛选状态在面板会话内保持，关闭后重置为默认 |
| 时区提示 | 在时间范围旁展示当前时区标识（如 `UTC+8`），避免跨时区误读 |

#### 5.3.2 折线图

| 项 | 要求 |
|----|------|
| 图表类型 | 折线图（`line`），支持 hover 十字准线 + Tooltip 展示当日全部指标 |
| X 轴 | 日期（**第一版固定按天**；按维度分组拆线列入后续迭代，见 [§10.2](#102-后续迭代第一版不含)） |
| 主 Y 轴（左） | Tokens 数值；两条折线：**输入 Tokens**、**输出 Tokens**（不同色，带面积渐变可选） |
| 次 Y 轴（右） | **输入缓存命中率**，单独一条折线（虚线，区别于 token 折线）。第一版固定 `0%~100%`（见 C15） |
| 空数据 | 无数据的日期补 0（token 折线）；命中率**断线** |
| 交互 | 第一版**不做点击下钻**（明细表已移出第一版，见 [§10.2](#102-后续迭代第一版不含)）；当天的明细数据通过 hover Tooltip 查看 |
| 图例 | 可点击隐藏/显示各系列；隐藏状态不持久化 |
| 数据量保护 | 折线最多渲染 366 个点 |

### 5.4 i18n 要求

新增一个 `usageStats` 命名空间。所有文案（含图表轴标签、Tooltip、无数据提示、单位）都必须通过 `t()` 取，不能硬编码；同时维护 `zh-CN` 和 `en-US` 两份资源，并运行 `npm run i18n:generate-types` 与 `npm run i18n:check`。

### 5.5 图表实现方案

本项目目前**没有引入任何图表库**（`package.json` 里没有 echarts / recharts / antd-charts）。有三种选择：

| 方案 | 说明 | 优点 | 缺点 |
|------|------|------|------|
| A. 引入 `recharts`（**已选定**） | React 原生、声明式、体积中等、双 Y 轴开箱即用 | 与 React 18 契合，开发快 | 新增依赖（~100KB gzip） |
| B. 引入 `echarts` + `echarts-for-react` | 功能最全 | 交互与大数据量最佳 | 体积大（~300KB+），需按需引入 |
| C. 自绘 SVG | 复刻 `ContextUsageRing` 的自绘风格 | 零依赖 | 双 Y 轴 / Tooltip / 准线需自研，成本高 |

> ✅ **已确认（C4）**：采用方案 A —— 引入 `recharts`。

---

## 6. 数据来源现状与差距分析

### 6.1 现有可用数据源

| # | 数据源 | 位置 | 已有内容 | 局限 |
|---|--------|------|----------|------|
| S1 | `turns` 表 | SQLite `spaceassistant-data.db` | `turn_id` / `session_id` / `state` / `outcome` / `usage_json` / `terminal_usage_json` / `error_json` / `created_at` | ① 仅保存**最后一轮**的 usage（`COALESCE(terminal_usage_json, usage_json)`），非 Turn 内累计；② 无 `model` / `app_version` / 步数 / 工具计数 |
| S2 | `messages` 表 | 同上 | `tool_use` / `tool_calls` / `content_segments` | 需解析 JSON 才能得到工具计数，无法直接 SQL 聚合；工具失败状态需从结果体推断 |
| S3 | SessionEvent 台账 | `{workDir}/sessions/<id>-<date>/events.jsonl`（+ `events.index.json`） | 事件类型齐全：`turn_start` / `turn_end` / `step_start` / `step_end` / `assistant_chunk` / `tool_call` / `tool_result` / `request_header` / `request_context` / **`request_usage`** / `request_retry` / `session_end_seed` | ① 分散在多个 workDir（支持多工作目录）；② JSONL 文本，跨会话聚合需全量扫描；③ **按会话数量清理**（每个 workDir 只保留最近 100 个会话，清理时整个目录 `fs.rm`，见 [§6.3](#63-事件台账的保留策略现状)），历史数据可能已被删除；④ 不落 `model` / `app_version` |
| S4 | `sessions` 表 | SQLite | `model` / `llm_service_id` / `name` / `created_at` / `work_dir_profile_id` | 仅会话级静态信息，无用量 |

**关键发现：** `request_usage` 事件在**每次 LLM 调用**时都会产生，是做 Token 统计最理想的原始数据；`tool_call` / `tool_result` 事件则是工具计数最理想的来源。落盘后的 payload 形如 `{ schemaVersion: 1, requestId: '${requestId}:round:${loopRound}', usage, source: 'api', turnId }`（`turnId` 由上层包装层 `claudeStreamHandlers.ts` 注入，发出点本身不含）。但这些埋点目前只写进了会被定期清理的 JSONL 台账，没有进入能长期保留、支持汇总的存储。

### 6.2 结论：需要新增独立存储

要同时满足「跨会话、多维度、长期留存、快速汇总」四个要求，必须新增一套专用的统计数据存储：**边发生边写入、长期保留、支持按各维度用 SQL 汇总**。SQLite 库文件在 `userData/spaceassistant-data.db`，所有工作目录共用同一份，天然**跨 workDir 统一**，把它作为存储落点是合适的。

### 6.3 事件台账的保留策略（现状）

回填历史数据依赖事件台账能否留存，所以这里专门记一笔现状。

**规则**（`electron/sessionEvents.ts:626` `enforceSessionEventRetentionDetailed`，调用点 `electron/main.ts:426`）：

| 步骤 | 行为 |
|------|------|
| 1 | 扫描 `{workDir}/sessions/` 下的子目录 |
| 2 | 读每个目录的 `events.index.json`，取 `lastAt`（最后一条事件时间）；**没有该文件的目录直接跳过，不清理** |
| 3 | 按 `lastAt` 倒序，`slice(100)` 之后的全是待删 |
| 4 | `fs.rm(dir, { recursive: true, force: true })` —— **删除整个会话目录** |
| 5 | 触发时机：**每次应用启动时执行一次**，上限硬编码为 `100`，每个 workDir 独立计算 |

**三个要点**：

1. **按「会话个数」保留，不是按「天数」** —— 保留窗口的时间长度不可预测（重度使用可能只覆盖几天，轻度使用可能覆盖数月）；
2. **删的是整个目录**：`events.jsonl`（唯一副本）随之删除；同目录的 `session.json` / `messages.json` 是 SQLite 的冗余备份，删掉不影响消息完整性；
3. **该策略恰好只覆盖有事件流的会话** —— 无 `events.index.json` 的目录（如建了但从未发消息）不会被清理。

> 对本需求的影响：能回填的数据源，正好是被这条策略主动清理的对象。这是 [§7.4](#74-历史数据回填已确认执行) 必须在上线时执行回填的直接原因。

---

## 7. 数据采集与存储设计

### 7.1 存储结构（两张表）

用两张表分开存，避免一张表承担太多职责：

- `usage_step_facts`：**逐条明细**，每次 LLM 调用记一行；
- `usage_turn_facts`：**按 Turn 汇总**，每个 Turn 记一行，承载工具次数、步数等。

#### 表 1：`usage_step_facts`（每步 / 每次 LLM 调用一行）

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | INTEGER PK AUTOINCREMENT | 主键 |
| `session_id` | TEXT NOT NULL | 会话 ID |
| `turn_id` | TEXT NOT NULL | Turn ID |
| `step_id` | TEXT NOT NULL | 步 ID（`${requestId}:round:${n}`），与事件台账同源 |
| `created_at` | INTEGER NOT NULL | 写入时间戳（ms） |
| `day` | TEXT NOT NULL | 本地自然日 `YYYY-MM-DD`（额外存一份，方便按天建索引、快速汇总） |
| `model` | TEXT | 模型名 |
| `llm_service_id` | TEXT | LLM 服务 ID（区分同模型不同服务） |
| `app_version` | TEXT | 写入时的 APP 版本号 |
| `input_tokens` | INTEGER NOT NULL DEFAULT 0 | 统一口径后的输入总量（含缓存，见 §2.2） |
| `output_tokens` | INTEGER NOT NULL DEFAULT 0 | 输出 tokens |
| `cache_read_tokens` | INTEGER NOT NULL DEFAULT 0 | 缓存命中（**核心指标**） |
| `cache_creation_tokens` | INTEGER NOT NULL DEFAULT 0 | 缓存写入（**兼容字段**：多数 provider 恒为 0，保留供 Anthropic 原生等显式缓存 provider 使用；不纳入界面指标，仅值 > 0 时展示） |
| `cache_semantics` | TEXT | `additive` / `subset`（口径归一化依据，见 §2.2.1） |
| `source` | TEXT | 统计来源。**当前恒为 `api`**（`request_usage` 唯一发出点写死 `'api'`；`estimate` 尚未产生）。字段预留，供将来接入估算用量 |

唯一约束：`UNIQUE(session_id, turn_id, step_id)`（幂等，防重试/恢复重复写入）。
索引：`CREATE INDEX idx_usage_step_day ON usage_step_facts(day)`、`(session_id, day)`、`(model, day)`、`(app_version, day)`。

#### 表 2：`usage_turn_facts`（每 Turn 一行）

| 字段 | 类型 | 说明 |
|------|------|------|
| `turn_id` | TEXT PRIMARY KEY | Turn ID |
| `session_id` | TEXT NOT NULL | 会话 ID |
| `created_at` | INTEGER NOT NULL | 写入时间戳（ms） |
| `day` | TEXT NOT NULL | 本地自然日 |
| `model` | TEXT | 模型名 |
| `llm_service_id` | TEXT | LLM 服务 ID |
| `app_version` | TEXT | APP 版本号 |
| `step_count` | INTEGER NOT NULL DEFAULT 0 | 该 Turn 的步数（等于 `usage_step_facts` 中同一 Turn 的行数，额外存一份，算平均步数时不用再关联查询） |
| `tool_call_count` | INTEGER NOT NULL DEFAULT 0 | 工具调用次数（= 成功 + 失败 + 未执行）；计数基准见 [§2.4.0](#240-计数基准与恒等式) |
| `tool_error_count` | INTEGER NOT NULL DEFAULT 0 | 执行失败次数（口径见 [§2.4](#24-工具调用分类与出错口径)） |
| `tool_skipped_count` | INTEGER NOT NULL DEFAULT 0 | **未执行**次数（**八类**，见 [§2.4.1](#241未执行的八种来源都不计入工具出错)） |
| `outcome` | TEXT | 取值对齐 `src/shared/assistantFactAggregator.ts:4` 的 `TurnOutcome`：`completed` / `failed` / `cancelled` / `timed-out` / `recovered`；另有统计侧自造的 `interrupted`（崩溃补齐，见 [§7.3.1](#731-工具计数的持有与-turn-收口)）。注意**不要**写成 `success` / `failed` / `cancelled` —— 与 `turns.outcome` 的实际取值域不符 |

索引：`idx_usage_turn_day(day)`、`(session_id, day)`、`(model, day)`、`(app_version, day)`。

> **为什么把这些字段重复存一份？** 这样「平均每 Turn 步数」「按模型」「按版本」这三类汇总都能在同一张表里完成，不必跨表 JOIN，也不必解析 JSON。

### 7.2 数据库迁移

- 把 `DB_SCHEMA_VERSION` 从 `15` 升到 `16`。**注意：基线是 v15，不是 v10 之前** —— v14 已用于 `sessions.ownership` / `visibility`（偏差 7 的落地），v15 已用于 butler 表；**实施前请再核对一次当时的 `DB_SCHEMA_VERSION`**，不要照抄本节数字；
- 在 `electron/database/schema.ts` 新增 `MIGRATION_V16_USAGE_STATS_SQL`（用 `CREATE TABLE IF NOT EXISTS`，保证重复执行也不会报错）；
- 在现有迁移序列的末尾注册这个 v16 迁移，做法与 v4 建表一致。

### 7.3 写入时机与写入口

| 事实 | 触发点 | 说明 |
|------|--------|------|
| `usage_step_facts` | `toolChatLoop.ts` 的 `emitSessionEvent({ type: 'request_usage', ... })` 落点 | 每次 LLM 调用拿到 usage 后即时写入（异步、失败不阻断对话）。**三条链路（桌面 / 远程 / butler）的 LLM 调用都经过这里** |
| `usage_turn_facts` | **`toolChatLoop.ts` 的 `runToolChatSession` 统一收口** | 汇总 `step_count` / `tool_call_count` / `tool_error_count` / `tool_skipped_count` / `outcome`。**不能挂在 `finalizeTurn`**，原因见 [§7.3.1](#731-工具计数的持有与-turn-收口) |
| `tool_result` 的分类标记（**附带改动**） | `toolChatLoop.ts` 各「未执行」出口（判定原则与来源清单见 [§2.4.1](#241未执行的八种来源都不计入工具出错)） | 与统计写入解耦，见 [§7.6](#76-附带改动-在-tool_result-上标注未执行) |

**前置改动：`runToolChatSession` 必须新增 `turnId` 入参**（否则上面两处写入都缺主键）：

- `RunToolChatSessionArgs`（`electron/toolChatLoop.ts:401`）当前只有 `requestId` / `sessionId`，**没有 `turnId`**；
- 而 `usage_step_facts.turn_id` 与 `usage_turn_facts.turn_id` 都是 `NOT NULL`，`recordTurnSummary(turnId, ...)` 也要 `turnId`；
- 今天 loop 内发事件时用的是 **`turnId: sessionId` 占位**，桌面链路靠 `claudeStreamHandlers.ts:423` 的包装层覆写（`payload: { ...event.payload, turnId }`）**事后修正** —— 远程与 butler **没有这层覆写**；
- 因此需加 `turnId` 入参，由**三个调用方**各传自己的真实值（都是现成的）：

| 调用方 | `turnId` 来源 |
|--------|---------------|
| 桌面 | `claudeStreamHandlers.ts:391` 调用处 —— 闭包内已有 `turnId` 变量（`:301` 用于 `turn_start`） |
| 远程（飞书 / 微信） | `remoteCommandRouter.ts:662` / `weChatCommandRouter.ts:364` 的 `prepared.turnId`，需经 `runFeishuRemoteAgent` / `runWeChatRemoteAgent` → `runImRemoteAgent`（`electron/remote/imRemoteAgent.ts:124`）**逐层下传**（当前 args 无此字段） |
| butler | `butlerInvoker.ts:245` 调用处 —— 已有 `prepared.turnId`（`:140` 已用于 `bindRequest`） |

- 顺带把 loop 内的 `turnId: sessionId` 占位改为用入参 —— 这样 [§7.4](#74-历史数据回填已确认执行) 回填 butler 台账时才有真实 `turnId`（见该节的局限声明）。

**写入原则：**

1. **后台异步写入，不阻塞对话**：写入失败只记一条 `agentLogger` 告警，绝不影响正在进行的对话（与安全审计日志采用同样的容错方式）。
2. **重复写入不产生重复数据**：依靠 `UNIQUE(session_id, turn_id, step_id)` 唯一约束，配合 `INSERT OR REPLACE` / `INSERT ... ON CONFLICT DO UPDATE`。
3. **写入时记下模型与版本**：`model` / `llm_service_id` 取自 `execution_config_json`（`frozen.model` / `frozen.llmServiceId`）；`app_version` 取 `app.getVersion()`（在主进程里缓存一份）。
4. **写入入口统一封装**：新增 `electron/usageStats/usageStatsRecorder.ts`，对外暴露 `recordStepUsage(...)` / `recordTurnSummary(...)`。**计数本身在 `runToolChatSession` 内用局部变量累计**（见 [§7.3.1](#731-工具计数的持有与-turn-收口)），本模块只负责落库、幂等与容错。

#### 7.3.1 工具计数的持有与 Turn 收口

**为什么不能挂在 `finalizeTurn`**（v1.15 的选址经源码核实不成立）：`finalizeTurn`（`claudeStreamHandlers.ts`）**只服务桌面链路** —— 它是 `chat:execute-turn` IPC 的闭包内部函数，`turn_end` 台账事件也**只在这一处发出**。另两条链路都绕过它：

| 链路 | 入口 | 是否经 `finalizeTurn` | 是否落台账 |
|------|------|----------------------|-----------|
| 桌面 | `chat:execute-turn` → `claudeStreamHandlers` | ✅ | ✅ |
| 远程（飞书 / 微信） | `remoteCommandRouter` / `weChatCommandRouter` → `executeRemoteTurn` → `imRemoteAgent` → `runToolChatSession` | ❌ | ❌ `emitSessionEvent` 是 `async () => undefined`（no-op） |
| butler（自动化） | `butlerInvoker` → `executeRemoteTurn` → `runToolChatSession({ lane: 'automation' })` | ❌ | ✅ `createButlerSessionEvents` 会转发，但**不发 `turn_end`** |

若挂在 `finalizeTurn`，远程 / 自动化回合的 Turn 数、步数、工具计数会**全部缺失**（与 G1 / C12 的「含远端渠道」直接冲突），且会被启动补齐逻辑**误标为 `interrupted`**。

**做法：在 `runToolChatSession` 内用局部变量持有计数，返回时一次落库。** 它是三条链路**唯一共用**的执行函数：

0. **`turnId` 由入参提供**（见 [§7.3](#73-写入时机与写入口) 的前置改动）—— 收口写库与 `usage_step_facts` 都用它做 `NOT NULL` 主键；
1. **计数就近累计**：步数在 `request_usage` 落点 +1；工具三分类在各出口 +1（与 [§7.6](#76-附带改动-在-tool_result-上标注未执行) 的标记点同处）。全部用 `runToolChatSession` 作用域内的局部变量，**不引入跨模块的内存累加器**；
2. **收口写库**：`runToolChatSession` 返回前（各已收敛的返回点，或用一个 `try/finally` 统一收口）调 `recordTurnSummary(turnId, counts, outcome)` 写一行 `usage_turn_facts`；
3. **`outcome` 由返回结果直接得出**（`ok: true` → `completed`；`cancelled` → `cancelled`；其余失败 → `failed`），**不依赖 `turn_end`** —— 统计与台账本来就是两套系统。取值域见 [§7.1](#71-存储结构两张表) 表 2 的 `outcome`（**不要写成 `success`**）；
4. **与 `turn_end` 解耦**：`turn_end` 只有桌面链路会发，但 `usage_turn_facts` 三条链路都写。台账缺 `turn_end` 是既有的渠道差异，不影响统计。

> 这样三个问题一并消失：跨模块传递通道、累加器泄漏（不存在长期驻留的键）、渠道覆盖（三链路共用同一收口）。

**崩溃补齐**：进程崩溃时收口不会执行，该 Turn 会**只有 `usage_step_facts` 行、没有 `usage_turn_facts` 行**。做法是**启动时（与台账回收同批）补齐**：对「有 `usage_step_facts` 行、但缺 `usage_turn_facts` 行」的 Turn 补一行 —— `step_count` 由其 step 行数得出（可知），`outcome = 'interrupted'`，**工具计数记 `0`**（崩溃时不可知，不做推测）。因此 `interrupted` Turn 被排除在 [§2.4.0](#240-计数基准与恒等式) 的恒等式断言之外（见 [§11.3](#113-回归验证) R6）。

**远程回合的台账盲区（须声明）**：远程（飞书 / 微信）的 `emitSessionEvent` 是 no-op，**当前不落任何台账事件**。后果分两面：

- **实时统计不受影响** —— 收口在 `runToolChatSession` 内，远程回合照常写 `usage_turn_facts` / `usage_step_facts`；
- **回填对远程历史天然为零** —— 没有台账，就没有 `request_usage` / `tool_call` / `tool_result` 可扫（见 [§7.4](#74-历史数据回填已确认执行)）。本需求不做数据造假，仅声明此盲区。

### 7.4 历史数据回填（已确认执行）

> ✅ **已确认（C7）**：上线时执行一次回填。

| 策略 | 说明 |
|------|------|
| **一次性回填（已确认）** | 扫描各 workDir 的 `events.jsonl`（`request_usage` / `tool_call` / `tool_result`）和 `turns` 表，重建上面那两张表；`app_version` 统一标记为 `unknown`；`model` / `llm_service_id` 优先取 `turns.execution_config_json` 中冻存的值（比 `sessions.model` 准确，会话中途换过模型也能对上），缺失时回退到 `sessions.model` |

**为什么必须在上线时做**：事件台账按**会话数量**清理（每个 workDir 只保留最近 100 个，见 [§6.1](#61-现有可用数据源) S3），历史会随新会话产生持续被删。回填的机会**不可逆**，错过即永久丢失。

**回填的已知局限**（需在界面标注，不做数据造假）：

| 局限 | 表现 |
|------|------|
| 只覆盖「台账尚存的会话」 | 时间轴上是一段一段的，可能出现断层 |
| 无 `app_version` | 全部归入「未知版本」 |
| 已被清理的会话 | 永久丢失，无法恢复 |
| **无法区分「拒绝」与「执行失败」** | 台账里两者都表现为 `success: false` 且都带 `error` 文案，没有可区分字段（详见 [§2.4.3](#243-实现约束重要)），**既有**历史数据中的拒绝会被算作执行失败。**新采集的数据不受影响**（用内存变量判断），且本需求附加的分类标记（[§7.6](#76-附带改动-在-tool_result-上标注未执行)）让**今后的**回填也能区分 |

**回填实现要点**（2026-09-13 采样确认，见 [§2.6](#26-provider-字段形态基线已采样-2026-09-13)）—— `request_usage` 事件已携带大部分所需信息：

| 目标字段 | 从哪里取 |
|----------|----------|
| `session_id` | 从会话目录名解析：`sessions/{sessionId}-{YYYYMMDD}/` → 前 36 位是 UUID |
| `turn_id` | `payload.turnId`。**桌面链路是真实值**；但 **butler 链路的既有历史是 `sessionId` 占位**（loop 内写死 `turnId: sessionId`，且 `createButlerSessionEvents` 不做覆写），详见下方局限 |
| `step_id` | `payload.requestId`，形如 `{uuid}:round:{n}` |
| `model` / `llm_service_id` | `turns.execution_config_json` 的冻存值，缺失时回退 `sessions.model` |
| `cacheSemantics` | 优先取 usage 内自带字段；缺失时用 `resolveUsageCacheSemanticsFromBaseUrl(baseUrl)`，baseUrl 同样取自 `turns.execution_config_json` |
| `app_version` | 台账无此信息 → 统一标记 `unknown` |
| 合成 `tool_result`（`synthetic: true`）的归因 | 其 payload 为 `{ toolUseId, synthetic: true, result }`，**不含 `turnId`**；用 `toolUseId` 关联同会话 `tool_call` 事件取 `turnId`，归「未执行」（见 [§2.4.0](#240-计数基准与恒等式)） |

**回填的固有盲区（须声明）**：**远程（飞书 / 微信）回合当前不落台账**（`imRemoteAgent` 的 `emitSessionEvent` 是 no-op），因此回填对远程历史**天然为零** —— 没有 `request_usage` / `tool_call` / `tool_result` 可扫。butler 回落的台账**不完整**（无 `turn_end`，但有 `request_usage` / `tool_call` / `tool_result`），回填可覆盖其 Token 与工具计数。本需求不做数据造假，仅声明此差异。

**butler 历史的 `turnId` 是占位（须声明）**：butler 台账里 `request_usage` 的 `payload.turnId` 写的是**会话 ID 占位**（loop 内的 `turnId: sessionId`，且 `createButlerSessionEvents` 不注入真实 `turnId`），修复见 [§7.3](#73-写入时机与写入口) 的前置改动。对**修复前**产生的 butler 历史，回填若直接用 `payload.turnId` 会把**同一会话的多个回合错并成一个假 turn**。两个处理方向（实施时择一，并在界面标注）：

1. 按 `turns` 表的 `session_id` + 时间区间匹配归因（较准，但需要 `request_usage` 的时间戳与 `turns.created_at` 对齐）；
2. 接受该会话的 butler 回合合并统计（简单，但 Turn 数偏低）。

无论哪种，**不伪造 turnId**。

### 7.5 数据保留

> ✅ **已确认（C8）**：保留期**以「天」为单位**、**可配置**、**删除必须留痕**。

| 项 | 约定 |
|----|------|
| 单位 | **按天**（不是按会话个数、也不是按行数）—— 用户对「保留多久」的直觉就是时间 |
| 默认值 | **365 天** |
| 可选值 | 30 / 90 / 365 天，或「永久保留」 |
| 配置入口 | 设置页「用量统计保留期」 |
| 执行时机 | 应用启动时执行一次 |
| 删除范围 | 把 `usage_step_facts` 与 `usage_turn_facts` 中 `day` 超出保留期的行一起删除 |
| **删除留痕** | 每次清理必须记录**删了多少行、覆盖哪段日期区间**（写入 `agentLogger`），不允许静默删除 |

**为什么把「删除留痕」写进需求**：现有的事件台账清理（见 [§6.3](#63-事件台账的保留策略现状)）会删除整个会话目录，却**没有任何成功记录** —— 这正是它难以察觉、难以追溯的原因。统计数据的目标是长期保留，这条纪律必须反过来。相关的架构归属问题见 `docs/develop/architect/product-architecture-design.md` §10 偏差 24。

> 数据量很小（每次 LLM 调用才一行，每天约百行级），永久保留也完全撑得住；默认 365 天主要是给「不想无限增长」的人留一个开关。

### 7.6 附带改动 在 tool_result 上标注「未执行」

> ✅ **已确认（C11）**：作为本需求的附带改动一并完成，不单独立项。**采用方案 B（改落盘对象的分类字段），不新增 session event 类型。**

**要解决的问题**：`events.jsonl` 里 **「被拒绝」与「执行失败」的形状完全相同** —— 都是 `success: false` + `error: '用户拒绝执行此工具'`。**历史回填因此无法区分二者**，会把用户拒绝算成执行失败（见 [§7.4](#74-历史数据回填已确认执行)）。

**先厘清缺陷的真实位置**（核实于 2026-09-13）：**UI 层已经能区分** —— `ToolCallStatus` 本就含 `'rejected'`（`src/shared/domainTypes.ts:15`），`assistantFactAggregator` 经 `tool-confirmed` fact 把它置上（`src/shared/assistantFactAggregator.ts:136`），`ToolCallCard` 也在渲染。**缺的只有台账层**。所以这不是「状态缺失」，而是「状态没进落盘通道」。

**改法（方案 B）**：给 `ToolCallResultPersisted` 增加可选分类字段，在工具**未进入执行流程**的出口上标记。依据是 `recordToolResult`（`electron/toolChatLoop.ts`）的第二参数会**原样**进入 `tool_result` 事件的 `payload.result`，且 `parseSessionEvent` 只校验 `payload` 是对象、**不校验内部字段** —— 所以新字段会**自动落进台账**，无需新增事件类型。（`recordToolResult` 是主要出口，但**不是唯一**出口，见下表 #15。）

字段建议：

```ts
// src/shared/domainTypes.ts —— ToolCallResultPersisted
/** 工具未进入执行流程（被授权 / 确认 / 策略 / 预算拦下，或调用整体被放弃），区别于「执行了但失败」 */
notExecuted?: true
/** 未执行的原因码，便于聚合与界面区分 */
notExecutedReason?:
  | 'user_rejected' | 'agent_denied' | 'confirm_timeout' | 'remote_read_only'
  | 'authorization_revoked' | 'policy_denied' | 'budget_paused'
  | 'remote_budget_exhausted' | 'not_authorized' | 'unknown_tool'
  | 'model_output_truncated'
// agent_denied：安全审批 Agent 机审拒绝（v1.19）。与 user_rejected（真人拒绝）分列，
// 避免「Agent 被拒」被计成「用户拒绝」；两者同属「确认未批准」来源、都计入 tool_skipped_count。
```

**改动面（1 处类型定义 + 15 个 `tool_result` 发出点）**：

> 下表按**当前代码**逐一归类 `toolChatLoop` 内**全部 `tool_result` 发出点** —— **14 处经 `recordToolResult`，另 1 处（#15）绕过它直接 `emitSessionEvent`**。这正是 [§11.3](#113-回归验证) R6 不变量测试要守的边界。注意「来源」与「出口」**不是一一对应**：确认未批准是**一个**出口，却覆盖 3 类来源。

| # | `tool_result` 发出点（分支） | 归类 | 标记 / 计数 |
|---|----------------------------------|------|-------------|
| 1 | `authorizeToolCall` 失败（工具不在授权清单 / MCP 工具已变更） | 未执行 | `not_authorized` |
| 2 | `isToolRevoked`（工具撤销，执行前） | 未执行 | `authorization_revoked` |
| 3 | 未知工具名 / MCP 不可用（`getRegisteredTool` 与 executor 皆无） | 未执行 | `unknown_tool` |
| 4 | `assertSafeToolInput` 失败（参数校验不通过） | **执行失败** | `tool_error_count` |
| 5 | **远程任务预算耗尽**（`checkRemoteTaskBudget` 失败） | 未执行 | `remote_budget_exhausted` |
| 6 | `gate.shellPrecheckDeny`（shell 预检拒绝） | 未执行 | `policy_denied` |
| 7 | shell 计划错误（`RunShellPlanError`） | **执行失败** | `tool_error_count` |
| 8 | `gate.budgetPause`（出站写预算耗尽） | 未执行 | `budget_paused` |
| 9 | `gate.decision.type === 'deny'`（其余策略拒绝） | 未执行 | `policy_denied` |
| 10 | 确认超时（`outcome === 'timeout'`） | 未执行 | `confirm_timeout` |
| 11 | 确认未批准（`if (!confirmationDecision.approved)`），按确认通道 cause 映射（v1.19） | 未执行 | `user_rejected`（真人拒绝）/ **`agent_denied`（机审 `agent-deny`）** / `policy_denied`（机审 fail-closed）/ `confirm_timeout` / `remote_read_only` / `authorization_revoked` |
| 12 | 写路径冲突（`checkWritePathConflict`） | **执行失败** | `tool_error_count` |
| 13 | `isToolRevoked`（执行前二次复查） | 未执行 | `authorization_revoked` |
| 14 | 执行器返回失败（`execResult.success === false`） | **执行失败** | `tool_error_count` |
| 15 | **输出截断恢复**（`model_output_token_limit`，`toolChatLoop.ts:1077`）—— **绕过 `recordToolResult`**，直接 `emitSessionEvent` | 未执行 | `model_output_truncated` |

> 归类合计：**未执行 11 处**（#1、2、3、5、6、8、9、10、11、13、15），**执行失败 4 处**（#4、7、12、14）。判据见 [§2.4](#24-工具调用分类与出错口径)：**是否已进入执行流程**是唯一分界 —— 「参数校验失败」「写路径冲突」虽在工具真正运行之前，但已过授权与确认，归执行失败；#15 是调用**整体被放弃**（同批次工具一并作废），归未执行。

**为什么不能只改一个地方**：`tool-confirmed` fact **只在 `needsConfirm === true` 时发出**，覆盖不到「策略 / 预算拒绝」—— 后者走另外四个分支，压根不进确认环节：

| 出口 | 位置 | 是否发 `tool-confirmed` |
|------|------|------------------------|
| 用户拒绝 / 确认超时 / 远程只读 / 授权撤销 | `needsConfirm` 分支 | ✅ 发 |
| run_shell 预检拒绝 | `gate.shellPrecheckDeny` 分支 | ❌ 不发 |
| 出站写预算耗尽 | `gate.budgetPause` 分支 | ❌ 不发 |
| **远程任务预算耗尽** | `remoteBudgetState` 门控分支 | ❌ 不发 |
| 其余策略拒绝 | `gate.decision.type === 'deny'` 分支 | ❌ 不发 |

**为什么选方案 B，而不是「新增一个 `tool_decision` 事件」**（曾评估该备选，已放弃）：

| | ✅ 方案 B：结果自带分类字段 | ❌ 新增 `tool_decision` 事件 |
|---|---|---|
| 改动文件数 | 2 个 | 2 个 |
| 需动 `SessionEventType` / `EVENT_TYPES` | **不需要** | 需要（两处必须同步，否则 `parseSessionEvent` 抛错） |
| 旧版本读到新台账 | **无影响** | 抛 `Invalid session event`，该会话被标 degraded |
| 回填读取 | 读现有 `tool_result` 即可 | 要多读一个事件类型 |
| 信息落点 | **结果自身**（更本质） | 另开一条并行记录 |
| 与统计写入的关系 | 同源同出口 | 同一批出口上再记一遍，冗余 |

**不动 `buildToolErrorResult`**：它只生成**给模型看**的 `tool_result` 内容（`electron/toolChatLoop.ts` 中的 `buildToolErrorResult`）。本改动只碰**落盘对象**（`recordToolResult` 的第二参数），模型上下文完全不受影响。

**不改 UI**：三处策略拒绝（预检 / 预算 / deny）目前在界面显示为 `failed`。有了分类字段后**具备**了被正确识别的能力，但改 UI 属额外范围，本需求不做。

**不做改动的地方**：本次不新增事件类型，`reconcileSessionEvents`（`electron/sessionEvents.ts`）的配对修复**无需改动**。

---

## 8. 聚合与查询设计

### 8.1 IPC 通道

| 通道 | 请求参数 | 返回 |
|------|----------|------|
| `usage-stats:daily` | `{ from: string; to: string; dimensions?: Filters }` | 每日序列：`[{ day, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, hitRate, toolCallCount, toolErrorCount, toolSkippedCount, turnCount, stepCount, avgStepsPerTurn }]`。其中 `hitRate = cacheReadTokens / (inputTokens − cacheCreationTokens)`（**方案 B**）；`cacheCreationTokens` 为兼容字段，供值 > 0 时展示；`toolSkippedCount` 为「未执行」次数（见 [§2.4](#24-工具调用分类与出错口径)） |
| `usage-stats:summary` | 同上 | 区间汇总的 6 项核心指标 + 佐证指标 |
| `usage-stats:dimensions` | 无 | 可选筛选值枚举：`{ models, sessions, appVersions }`（用于筛选器下拉） |

> 按维度分组的明细查询（`usage-stats:breakdown`）随会话明细表一并列入后续迭代，见 [§10.2](#102-后续迭代第一版不含)。

通道命名沿用现有 `preload.ts` / `appIpc.ts` / `src/shared/api.ts` 里 `xxx:action` 的风格。

**筛选参数的形状**（`Filters`，定义在 `src/shared/usageStatsTypes.ts`）：

```ts
type Filters = {
  /** 模型维度：按「服务 + 模型」组合筛选，支持多选（DIM3 要求同模型跨服务分开统计） */
  models?: Array<{ model: string; llmServiceId?: string }>
  /** 会话维度：多选 */
  sessionIds?: string[]
  /** APP 版本维度：多选 */
  appVersions?: string[]
}
```

> 多项之间是「或」：SQL 侧按 `Filters` 展开 `IN` 列表；模型条件必须同时带上 `llm_service_id`，否则会跨服务混算（见 [§8.2](#82-聚合-sql-示例)）。

### 8.2 聚合 SQL 示例

```sql
-- 每日序列（按天）
SELECT
  s.day AS day,
  SUM(s.input_tokens)          AS inputTokens,
  SUM(s.output_tokens)         AS outputTokens,
  SUM(s.cache_read_tokens)     AS cacheReadTokens,
  SUM(s.cache_creation_tokens) AS cacheCreationTokens,
  -- 命中率方案 B：分母 = 归一化输入总量 − 缓存写入量
  CASE WHEN SUM(s.input_tokens) - SUM(s.cache_creation_tokens) > 0
       THEN CAST(SUM(s.cache_read_tokens) AS REAL)
            / (SUM(s.input_tokens) - SUM(s.cache_creation_tokens))
       ELSE NULL END           AS hitRate
FROM usage_step_facts s
WHERE s.day BETWEEN ? AND ?
  -- 模型筛选：按「服务 + 模型」组合（DIM3）；多选时展开为 IN 列表
  AND (? IS NULL OR (s.model = ? AND (? IS NULL OR s.llm_service_id = ?)))
  AND (? IS NULL OR s.session_id = ?)
  AND (? IS NULL OR s.app_version = ?)
GROUP BY s.day
ORDER BY s.day;

-- 工具与步数（按天，来自 turn 表）
SELECT day,
  SUM(tool_call_count)     AS toolCallCount,
  SUM(tool_error_count)    AS toolErrorCount,
  SUM(tool_skipped_count)  AS toolSkippedCount,
  COUNT(*)                 AS turnCount,
  SUM(step_count)          AS stepCount,
  CASE WHEN COUNT(*) > 0
       THEN CAST(SUM(step_count) AS REAL) / COUNT(*)
       ELSE NULL END    AS avgStepsPerTurn
FROM usage_turn_facts
WHERE day BETWEEN ? AND ?
GROUP BY day
ORDER BY day;
```

> 说明：Token 类指标查 `usage_step_facts`，Turn / 工具类指标查 `usage_turn_facts`，两者在同一时间与维度条件下按 `day` 对齐后合并返回，避免在 SQL 里做开销较大的 `JOIN`。
>
> 第一版不做按渠道拆分（C12）。若将来需要，用 `usage_step_facts.session_id` JOIN `sessions` 取 `ownership` 即可，**无需改表**。

### 8.3 性能要求

| 场景 | 目标 |
|------|------|
| 查 90 天、单个维度的汇总 | < 200 ms |
| 面板首次打开（汇总 + 每日序列一起查） | < 500 ms |
| 数据量上限（按 1 年、重度使用估算） | 约 20 万行以内，单表完全够用 |

---

## 9. 边界、降级与一致性

### 9.1 数据缺失降级

| 场景 | 表现 |
|------|------|
| provider 未返回缓存字段 | 命中率显示 `—`，缓存命中显示 `0`，不自造数据 |
| provider 用自动缓存（`cache_creation` 恒 0） | 界面不展示缓存写入卡片；此时「输入总量 − 写入量」就等于普通输入总量，命中率结果不变（与方案 A 一致） |
| 输入 tokens 为 0 | 命中率 `—`（不出现除零） |
| 历史数据无 `app_version` | 归入「未知版本」，在版本筛选下拉中可见 |
| 会话已删除 | 保留统计行，标题降级为「已删除会话」 |
| workDir 被移除 | 统计不受影响（数据在 userData 的 SQLite，不依赖 workDir） |
| 某天完全无数据 | 折线 token 补 0，命中率断线 |

### 9.2 写入失败与重试

- 写入放进统一事务（`runInTransaction`）里执行；
- 失败先重试 1 次，仍失败就用 `agentLogger` 记一条 `usageStats.write.failed`（带上 `turnId` / `stepId`），并**丢弃**这条数据，不阻塞对话；
- 不做额外的落盘队列（与安全审计的异步缓冲策略保持一致，从简处理），因为统计数据不在关键路径上。

### 9.3 统计口径与去重

| 议题 | 处理 |
|------|------|
| Turn 被取消 / 失败 | 全部**计入** Turn 总数与步数 —— 它们真实消耗了 token，剔除会与 KPI 里的 token 总量对不上。仅在 `usage_turn_facts.outcome` 标记结果，本版**不做**按 outcome 过滤（见 [§10.2](#102-后续迭代第一版不含)） |
| 流式重试（`request_retry`） | 只以最终 `request_usage` 为准，重试产生的中间请求不计入；若 provider 对失败请求也返回 usage，则以 `source` 字段区分 |
| 异常恢复时重建 Turn（`recovery`） | 依靠 `UNIQUE(session_id, turn_id, step_id)` 保证可重复写入，重复写入是覆盖、不会累加 |
| 子 Agent / 远程渠道（飞书 / 微信） | **合并计入总量**（C12）。**实时统计**：远程与自动化回合与桌面共用 `runToolChatSession`，Token 与 Turn / 工具计数**照常计入**（收口见 [§7.3.1](#731-工具计数的持有与-turn-收口)）。**回填**：远程回合当前**不落台账**（`imRemoteAgent` 的 `emitSessionEvent` 是 no-op），其历史回填天然为零；butler 台账无 `turn_end` 但可回填 Token 与工具计数（见 [§7.4](#74-历史数据回填已确认执行)）。子 Agent 目前不存在（架构偏差 16），将来产生时默认同样计入。按渠道（`sessions.ownership`）拆分列入 [§10.2](#102-后续迭代第一版不含) |
| 估算用量（`source: 'estimate'`） | **当前不存在** —— `request_usage` 的 `source` 恒为 `'api'`。字段已预留；将来引入时需同步补一个筛选控件（本版筛选区无此项），故「可筛选排除」列入 [§10.2](#102-后续迭代第一版不含) |

---

## 10. 非目标与后续迭代

### 10.1 明确不做（长期非目标）

以下内容**不在本需求范围内**：

- ❌ 费用 / 金额估算（需维护价格表，独立需求）
- ❌ 实时（流式进行中）用量展示
- ❌ 按工具名细分的调用统计与失败率
- ❌ 跨设备 / 云端汇总
- ❌ 报表导出（CSV / 图片）与定时推送
- ❌ 用量告警与配额限制（已有 `budget.exhausted` 机制，是另一套功能）
- ❌ 修改 `ContextUsageRing` 的单会话视图逻辑

### 10.2 后续迭代（第一版不含）

以下几项第一版不做，但采集与存储层已经能支撑，后续补上时**无需改动写入逻辑**：

| 项 | 说明 | 为什么现在能省 |
|----|------|----------------|
| **某日会话明细表** | 选中某天，查看当天每个会话的 Token / 工具 / 步数统计 | 两张表都记了 `session_id`，第一版照常采集；后续只需补一个查询通道 + 一个表格组件 |
| **折线图点击下钻** | 点击某天 → 明细表切换为该天数据 | 依赖上面的明细表 |
| **按维度分组折线** | 把模型 / 会话 / 版本作为分组维度，改变折线图 X 轴或拆成多条线 | 汇总查询稍作扩展即可，界面改动较大 |
| **时间粒度切换** | 支持按周 / 按月聚合（第一版只有按天） | 见 C13 |
| **按 outcome 过滤** | 只看成功的 Turn（含其 Step 与 Token） | 必须**分子分母同时过滤**：只筛步数不筛 Turn 会把「平均每 Turn 步数」算畸形。本版不做，见 C9 |
| **按渠道拆分用量** | 用 `sessions.ownership`（`user` / `remote` / `automation` / `internal`）区分来源，单独查看各渠道消耗 | `usage_step_facts` 已记 `session_id`、`sessions.ownership` 已存在（v14 迁移），查询时 JOIN 即可，**无需改表、无需重新采集**（C12） |
| **会话来源筛选** | 筛选区增加「会话来源」（桌面 / 远端）下拉 | 与上一行同源，一个 JOIN + 一个下拉 |
| **会话跳转** | 从统计结果跳到对应会话 | 见 C13 |
| **估算用量的筛选** | 将来若引入 `source: 'estimate'` 的估算用量，筛选区补一个「排除估算」开关 | 字段已预留（当前恒为 `api`），见 [§9.3](#93-统计口径与去重) |

> 其中「某日会话明细表」是 [§1.2](#12-目标) 目标 G3 的原始诉求，第一版暂不交付。

---

## 11. 验收标准

### 11.1 功能验收（第一版）

| # | 场景 | 期望 |
|---|------|------|
| T1 | 菜单「查看」→ 点击「Token 用量统计」 | 统计面板从右侧滑出，默认展示近 30 天数据 |
| T2 | 面板打开 | KPI 卡片展示 M1–M7 全部指标，且与数据库聚合结果一致 |
| T3 | 折线图渲染 | 左轴输入/输出两条折线，右轴命中率一条折线，**右轴固定 0–100%**（C15），X 轴为日期 |
| T4 | 切换时间范围为「近 7 天」 | 折线图与 KPI 同步刷新，数据点数量与天数匹配 |
| T5 | 鼠标悬停折线图某天 | Tooltip 展示当天的输入 / 输出 / 缓存命中 / 命中率 / 工具次数 / 步数 |
| T6 | 按模型 / 会话 / 版本筛选 | 折线图与 KPI 只统计筛选后的数据，X 轴仍为日期 |
| T7 | 一个 Turn 内 3 次 LLM 调用 + 2 次工具调用（均成功） | `step_count = 3`、`tool_call_count = 2`、`tool_error_count = 0`、`tool_skipped_count = 0`，Token 为 3 次调用之和 |
| T8 | 工具执行失败 1 次 | `tool_error_count = 1`，工具出错率正确 |
| T9 | 用户拒绝工具确认 | 不计入工具出错次数；计入「未执行」（`tool_skipped_count`），`notExecutedReason = 'user_rejected'` |
| T9b | **安全审批机审拒绝**（无人档位下高风险操作被 `agent-deny`） | 同样计入「未执行」，但 `notExecutedReason = 'agent_denied'`（**不得**误标 `user_rejected`）；不计入工具出错；拒绝理由含「如何获批」可操作指引 |
| T10 | **真实样本**：DeepSeek `deepseek-v4-pro`，同一 Turn 的首轮 vs 第 3 轮 | 首轮 `{input 14365, cache_read 0}` → 输入总量 14365、命中率 **0%**；第 3 轮 `{input 4364, cache_read 46464}` → 输入总量 50828、命中率 **91.4%**（方案 B） |
| T11 | **真实样本**：火山方舟 `kimi-k2.6` `{input 122, cache_read 23812, output 156}` | 输入总量 = 122 + 23812 = 23934；命中率 = 23812/23934 = **99.49%**；界面**不出现**缓存写入卡片（该 provider 不返回此字段） |
| T11b | **真实样本**：DeepSeek 长上下文 `{input 443, cache_read 427520, cache_creation 0}` | 输入总量 = 427963；分母 = 427963 − 0；命中率 = **99.90%** |
| T11c | 自动缓存 provider（`cache_creation` 恒 0）打开面板 | 不渲染缓存写入卡片；命中率与方案 A 结果一致（验证方案 B 在主力 provider 上无行为差异） |
| T12 | 重启应用后重新打开面板 | 历史统计完整保留（不依赖 workDir 与 JSONL 台账） |
| T13 | 删除某会话后查看历史统计 | 该会话历史数据仍可见（第一版无明细表，此处以 KPI 汇总值仍包含该会话历史数据为准） |
| T14 | 切换界面语言 | 面板与菜单文案跟随语言（无硬编码文案） |
| T15 | 无任何用量数据（全新安装） | 面板展示空态，不报错 |
| T16 | 三种「未执行」分别触发：用户拒绝、策略拒绝、**输出截断**（放弃工具调用） | 三者都计入 `tool_skipped_count`；`tool_error_count` 不因此增加；且 `tool_error_count + tool_skipped_count ≤ tool_call_count`（恒等式，见 [§2.4.0](#240-计数基准与恒等式)）。**不要**用「预算耗尽」设计同 Turn 用例 —— 它是**无条件 `break`**，只有恰为批次最后一个工具时才能与其它来源共存（见 [§2.4.4](#244-边界情形批次中断与崩溃恢复)） |

### 11.2 后续迭代验收（不在第一版范围，见 [§10.2](#102-后续迭代第一版不含)）

| # | 场景 | 期望 |
|---|------|------|
| F1 | 点击折线图某天 | 下方明细表切换为该天各会话统计 |
| F2 | 明细表列 | 含会话、模型、输入、输出、缓存命中、命中率、工具调用/出错、Turn/Step、平均步数 |
| F3 | 按模型 / 会话 / 版本维度切换分组 | 折线图按对应维度聚合，且遵循 Top 20 折叠规则 |

### 11.3 回归验证

| # | 场景 | 期望 |
|---|------|------|
| R1 | 正常对话（工具模式 / 流式模式） | 对话行为与主流程不受写入影响，无卡顿 |
| R2 | 统计写入失败（模拟 DB 异常） | 对话仍正常完成，仅日志告警 |
| R3 | 数据库迁移（v15 → v16） | 旧库升级后表结构正确，历史 `turns` / `messages` / `sessions` 数据不受影响 |
| R4 | `ContextUsageRing` 单会话视图 | 行为完全不变 |
| R5 | `npm test` / `npm run i18n:check` | 全部通过 |
| R6 | **三分类恒等式不变量**（纪律性测试） | 用随机操作序列（含多次拒绝、确认超时、策略拒绝、**出站写预算耗尽**、**远程任务预算耗尽**、**输出截断放弃工具调用**、连续同错中断、崩溃恢复）跑完后，断言每个**非 `interrupted`** Turn：`tool_call_count` 等于其终态 `tool_result` 数（**含绕过 `recordToolResult` 的第 15 处发出点**，见 [§7.6](#76-附带改动-在-tool_result-上标注未执行)），且 `tool_error_count + tool_skipped_count ≤ tool_call_count`。**必须同时覆盖三条链路**：桌面 IPC、远程（`imRemoteAgent`）、butler（`lane: 'automation'`）—— B1' 漏网正是因为只验证了桌面链路。`interrupted` Turn 因工具计数不可知而豁免（见 [§2.4.0](#240-计数基准与恒等式)） |

---

## 12. 决策记录

### 12.1 已确认

| 编号 | 决策点 | 结论 | 依据 |
|------|--------|------|------|
| C1 | `cache_creation`（缓存写入）的定位 | **兼容字段**：存储层保留，界面仅在值 > 0 时条件展示，**不作为统计指标**；DeepSeek / Kimi / GLM / MiniMax 等自动缓存 provider 恒为 0，界面不出现空卡片 | 该字段本质是显式缓存的**计费机制**（见 [§2.2.2](#222-缓存写入与计费机制仅显式缓存-provider-相关)），主力 provider 不产生 |
| C2 | 输入 Tokens 是否计入 `cache_creation` | **计入**（`inputTokens` 代表进入上下文的全部输入）。原先设的「要不要计入」这个问题本身把**口径**和**计费**混为一谈，已拆开：字段定位见 C1，口径怎么算见本条 | 见 [§2.2.1](#221-口径归一化决定输入总量怎么算) |
| C3 | 命中率分母口径 | **方案 B**：`cacheRead / (inputTokens − cacheCreationTokens)`，分母不含缓存写入 | [§2.5](#25-缓存命中率口径已确认方案-b)；在自动缓存 provider 上与方案 A 等价，仅修正 Anthropic 原生场景语义 |
| C4 | 图表实现方案 | **方案 A：引入 `recharts`** | 见 [§5.5](#55-图表实现方案)；React 原生、双 Y 轴开箱即用，与 React 18 契合 |
| C5 | 某日会话明细表是否进第一版 | **不进**，连同「点击折线图下钻」「按维度分组折线」一并列入 [§10.2 后续迭代](#102-后续迭代第一版不含)；数据层照常采集，后续补齐无需改动写入逻辑 | 第一版求简：省掉一个查询通道（`usage-stats:breakdown`）与一个表格组件 |
| C6 | 界面形态 | **Drawer**（宽 `86%`，从右侧滑出，`destroyOnClose`） | 见 [§5.2](#52-界面形态)；与现有 `SettingsModal` / `AboutModal` 一致，无需引入路由或新增渲染进程入口 |
| C7 | 是否回填历史数据 | **回填**（一次性脚本）。数据源：各 workDir 的 `events.jsonl`（`request_usage` / `tool_call` / `tool_result`）+ `turns` 表的 `execution_config_json`（取冻存的 `model` / `llmServiceId`）。回填数据的 `app_version` 标记为 `unknown` | 机会不可逆：台账按会话数量清理（见 [§6.1](#61-现有可用数据源) S3），历史会随新会话产生而持续被删，错过即永久丢失；数据质量瑕疵（版本缺失、时间断层）可通过界面标注消化 |
| C8 | 统计数据的保留期 | **按天为单位、可配置、删除留痕**：默认 365 天，可选 30 / 90 / 365 天或永久；启动时清理；每次清理记录删除行数与日期区间 | 见 [§7.5](#75-数据保留)；对齐事件台账「按会话个数、删了不记」的反面教训（§6.3） |
| C9 | 「步数」的口径 | **该 Turn 实际产生了 usage 记录的 Step 数，不按 outcome 剔除**（失败 / 取消的 Step 只要真的调用过模型就计入）；「只看成功 Turn」作为**后续可选视图**，且届时分子分母必须同时过滤 | 见 [§9.3](#93-统计口径与去重)；与 `step_count` = `usage_step_facts` 同 Turn 行数的定义天然一致，无需额外过滤逻辑；分子分母口径一致才不会把平均步数算畸形 |
| C10 | 工具调用的三分类与「未执行」 | 每次工具调用归入**执行成功 / 执行失败 / 未执行**之一，三者之和 = 调用次数（`interrupted` Turn 除外，见 [§2.4.0](#240-计数基准与恒等式)）。**八类「未执行」不计入工具出错**（确认未批准——含真人拒绝 `user_rejected` 与机审拒绝 `agent_denied`（v1.19 起分列）、确认超时、远程只读、授权撤销、策略 deny、出站写预算耗尽、**远程任务预算耗尽**、**模型输出截断**）；判别分界是**是否已进入执行流程**。计数以 `tool_result` 终态为基准（见 [§2.4.0](#240-计数基准与恒等式)），并新增 `tool_skipped_count` 承载。回填数据无法区分拒绝与失败，仅标注局限 | 见 [§2.4](#24-工具调用分类与出错口径)；拒绝若算出错会得出「越谨慎出错率越高」的荒谬结论；不单列「未执行」会让被拒绝的调用从总数里消失 |
| C11 | 附带改动：在 `tool_result` 上标注「未执行」 | 给 `ToolCallResultPersisted` 增加可选字段（`notExecuted` / `notExecutedReason`），在 `toolChatLoop` 内**全部 15 个 `tool_result` 发出点**按穷举表归类标记（14 处经 `recordToolResult` + 1 处绕过它；未执行 11 处、执行失败 4 处，见 [§7.6](#76-附带改动-在-tool_result-上标注未执行)），使今后的回填也能区分「未执行」与「执行失败」。**不新增 SessionEvent 类型**。不单独立项，随本需求完成 | 见 [§7.6](#76-附带改动-在-tool_result-上标注未执行)；缺陷只在**台账层**（UI 层 `ToolCallStatus` 已有 `'rejected'`）；相比「新增 `tool_decision` 事件」这一备选：不动 `SessionEventType`、无旧版本降级风险、信息落在结果自身 |
| C12 | 子 Agent / 远程渠道的用量是否单列 | **合并计入总量**（远端渠道触发的回合同样由本 Agent 执行，消耗真实）；**按渠道拆分留作后续**，数据层已天然支持（`usage_step_facts.session_id` + `sessions.ownership`，查询时 JOIN 即可，**无需改表、无需重新采集**）；「会话来源」筛选第一版不做 | 见 [§9.3](#93-统计口径与去重) 与 [§10.2](#102-后续迭代第一版不含)。用户诉求是「整个 Agent」的用量，远程回合属于其中；拆分能力零成本保留，不堵后续的路 |
| C13 | 时间粒度（周/月）与会话跳转 | **第一版不做**：折线图固定按天，不做会话跳转。两项均已列入 [§10.2 后续迭代](#102-后续迭代第一版不含) | 见 [§4](#4-查看维度需求)；第一版求简，与 C5 的收缩取向一致 |
| C14 | provider 字段形态基线 | **采样已完成**（1281 条真实样本）：实际 provider 组合**只走 `additive` 语义**；`cache_creation` **恒为 0**（火山方舟直接不返回该字段）；`subset` 语义**从未出现**；命中率中位数 **95.7%** | 见 [§2.6](#26-provider-字段形态基线已采样-2026-09-13)；据此确定归一化分支与验收样例，原「实施前置校验」已提前完成 |
| C15 | 折线图右轴（命中率）刻度 | **第一版固定 0–100%**（与验收 T3 一致）；「60%–100% 加密刻度 / 自适应下界」列入 [§10.2](#102-后续迭代第一版不含) | 见 [§2.6.5](#265-真实用量特征供界面设计参考)；真实数据虽集中在高区间，但固定量程读者最直观，也避免与验收标准冲突 |
| C16 | `usage_turn_facts` 的写入收口点 | **在 `runToolChatSession` 内用局部变量累计计数，返回前一次落库**。**不能挂在 `finalizeTurn`** —— 那只服务桌面链路，远程 / butler 会全部缺失（见 [§7.3.1](#731-工具计数的持有与-turn-收口)）。统计写入与 `turn_end` 台账事件**解耦**；崩溃 Turn 由启动补齐为 `interrupted` | B1'：`turn_end` 全局唯一发出点在桌面链路，而 G1 / C12 要求覆盖远端；收口点上移后，跨模块传递通道、累加器泄漏、渠道覆盖三个问题一并消失 |
| C17 | `runToolChatSession` 新增 `turnId` 入参 | 由三个调用方各传真实值：桌面（`claudeStreamHandlers` 闭包内已有）、远程（`remoteCommandRouter` / `weChatCommandRouter` 的 `prepared.turnId`，经 `imRemoteAgent` 下传）、butler（`butlerInvoker` 已有）。顺带把 loop 内 `turnId: sessionId` 占位改为用入参 | P1-1：`RunToolChatSessionArgs` 原本只有 `requestId` / `sessionId`，loop 内用 `sessionId` 占位、靠桌面包装层事后覆写（`claudeStreamHandlers.ts:423`），**远程 / butler 没有这层覆写**；而 `usage_step_facts.turn_id` / `usage_turn_facts.turn_id` 都是 `NOT NULL` |

### 12.2 待确认

**（无）** —— 原 D1–D9 已全部结清：

| 原编号 | 去向 |
|--------|------|
| D1 | **作废**：该问题把「口径」与「计费」混为一谈，已拆解为 C1（字段定位）+ C2（口径计算） |
| D2 图表实现 / D3 界面形态 | → C4 / C6 |
| D4 历史回填 / D7 保留期 | → C7 / C8 |
| D5 步数口径 / D6 工具出错口径 | → C9 / C10 |
| D8 时间粒度与会话跳转 / D9 子 Agent 与远程渠道 | → C13 / C12 |

---

## 13. 预估改动文件清单

> 清单为设计预估，实施时以实际代码为准。

| 文件 | 改动 |
|------|------|
| `electron/database/schema.ts` | **修改**：`DB_SCHEMA_VERSION` → **16**（基线为 15）；新增 `MIGRATION_V16_USAGE_STATS_SQL` |
| `electron/database/migrations.ts`（或既有迁移注册处） | **修改**：注册 v16 迁移 |
| `electron/database/operations.ts` | **修改**：新增 `insertUsageStepFact` / `upsertUsageTurnFact` / 各维度聚合查询函数 |
| `electron/usageStats/usageStatsRecorder.ts` | **新建**：统计写入封装（落库、幂等、容错）。提供 `recordStepUsage` / `recordTurnSummary`；**不持有跨模块累加器**（计数在 `runToolChatSession` 内局部累计，见 [§7.3.1](#731-工具计数的持有与-turn-收口)） |
| `electron/usageStats/usageStatsQueries.ts` | **新建**：聚合查询（daily / summary / dimensions） |
| `electron/toolChatLoop.ts` | **修改**：①`RunToolChatSessionArgs` 新增 `turnId` 入参，并把 loop 内 `turnId: sessionId` 占位改为用入参；②在 `request_usage` 落点调 `recordStepUsage` 写 `usage_step_facts`；③各「未执行」出口标记 `ToolCallResultPersisted` 分类（[§7.6](#76-附带改动-在-tool_result-上标注未执行)）；④在 `runToolChatSession` 返回前收口写 `usage_turn_facts`（计数用局部变量，见 [§7.3.1](#731-工具计数的持有与-turn-收口)） |
| `electron/remote/imRemoteAgent.ts` | **修改**：`runImRemoteAgent` 的 args 新增 `turnId` 并透传给 `runToolChatSession`（[§7.3](#73-写入时机与写入口) 前置改动） |
| `electron/feishu/remoteCommandRouter.ts`、`electron/wechat/weChatCommandRouter.ts` | **修改**：把 `prepared.turnId` 经 `runFeishuRemoteAgent` / `runWeChatRemoteAgent` 下传（[§7.3](#73-写入时机与写入口) 前置改动） |
| `electron/butler/butlerInvoker.ts` | **修改**：调用 `runToolChatSession` 时传入已有的 `prepared.turnId`（[§7.3](#73-写入时机与写入口) 前置改动） |
| `electron/claudeStreamHandlers.ts` | **修改**：调用 `runToolChatSession` 时传入闭包内已有的 `turnId`（**不改统计写入** —— LLM 执行体是 `runToolChatSession`，`request_usage` 与 Turn 收口都在 `toolChatLoop`；本文件的 `finalizeTurn` 只覆盖桌面链路，**不挂统计**） |
| `src/shared/domainTypes.ts` | **修改**：`ToolCallResultPersisted` 追加 `notExecuted` / `notExecutedReason` 可选字段（附带改动，[§7.6](#76-附带改动-在-tool_result-上标注未执行)） |
| `electron/menu.ts` | **修改**：「查看」菜单新增「Token 用量统计」项，`sendToRenderer('app:open-usage-stats')` |
| `src/shared/menuLabels.ts` | **修改**：新增 `usageStats` 菜单标签（zh-CN / en-US） |
| `electron/preload.ts` | **修改**：暴露 `onOpenUsageStats` 与 `usageStatsDaily/Summary/Dimensions` |
| `src/shared/api.ts` | **修改**：新增统计 API 与返回类型定义 |
| `src/shared/usageStatsTypes.ts` | **新建**：主进程与渲染进程共享的指标 / 维度类型定义（统一从这里引用） |
| `electron/appIpc.ts` | **修改**：注册 `usage-stats:*` IPC handler |
| `electron/main.ts` | **修改**：注入 `appVersion` 与统计查询依赖；启动时执行保留期清理（含删除行数与日期区间的留痕日志）与**崩溃 Turn 补齐**（[§7.3.1](#731-工具计数的持有与-turn-收口)） |
| `src/renderer/App.tsx` | **修改**：订阅 `onOpenUsageStats` → 打开面板 |
| `src/renderer/components/UsageStats/UsageStatsDrawer.tsx` | **新建**：面板容器 + 筛选区 |
| `src/renderer/components/UsageStats/UsageStatsKpiCards.tsx` | **新建**：KPI 卡片行 |
| `src/renderer/components/UsageStats/UsageTrendChart.tsx` | **新建**：双轴折线图（基于 `recharts`） |
| `src/renderer/store/usageStatsSlice.ts` | **新建**（可选）：面板开关与筛选状态 |
| `src/renderer/i18n/resources/zh-CN/usageStats.json` | **新建**：中文文案 |
| `src/renderer/i18n/resources/en-US/usageStats.json` | **新建**：英文文案 |
| `src/renderer/i18n/resources/{zh-CN,en-US}/index.ts` | **修改**：注册命名空间 |
| `electron/usageStats/*.test.ts`、`src/renderer/components/UsageStats/*.test.tsx` | **新建**：单元 / 组件测试 |
| `package.json` | **修改**：新增 `recharts` 依赖（已确认 C4） |

---

## 14. 文档修订记录

| 版本 | 日期 | 变更说明 |
|------|------|----------|
| 1.0 | 2026-09-13 | 初始版本：指标口径、查看维度、界面设计、采集与聚合方案、验收标准、待确认决策 |
| 1.1 | 2026-09-13 | 依据评审澄清「缓存写入」机制：①拆解「口径归一化」（§2.2.1）与「缓存写入计费」（§2.2.2），明确二者独立；②`cache_creation` 由统计指标（M3b）降级为**兼容字段**，仅值 > 0 时展示；③命中率分母确定为**方案 B**（`cacheRead / (inputTokens − cacheCreationTokens)`），同步更新 §2.3 / §2.5 / §8.1 / §8.2 / §9.1 / §11 公式与用例；④新增 §2.6 provider 字段形态采样（实施前置）；⑤新增验收用例 T11b / T11c；⑥§12 改为「决策记录」，新增已确认项 C1–C3 |
| 1.2 | 2026-09-13 | §4 查看维度编号由 `D1–D4` 改为 `DIM1–DIM4`，消除与 §12 决策编号（`D` 前缀）的撞号；§4 内「见 D8」改为显式章节路径「见 §12.2 D8」 |
| 1.3 | 2026-09-13 | 全文叙述方式优化：把生造说法（如「明细 + Turn 聚合」双表设计）与堆砌术语改回白话、为缺主语的句子补主语；补充 §2.5 中方案 A / 方案 B 的完整定义；不改动任何口径、编号与技术结论 |
| 1.4 | 2026-09-13 | 按评审确认收缩第一版范围：①图表库选定 `recharts`（新记为 C4）；②**某日会话明细表移出第一版**（新记为 C5），并连同「点击折线图下钻」「按维度分组折线」列入新增的 §10.2 后续迭代；③第一版折线图 X 轴固定按天，四个维度仅作筛选；④§8.1 移除 `usage-stats:breakdown`、§13 移除 `UsageSessionTable.tsx`；⑤§11 拆为「第一版功能验收 / 后续迭代验收 / 回归验证」；⑥§10 更名为「非目标与后续迭代」并拆为 10.1 / 10.2 |
| 1.5 | 2026-09-13 | 界面形态确定为 **Drawer**（新记为 C6），从 §12.2 待确认移入 §12.1 已确认；§5.2 的决策点标注改为已确认，并说明不采用全屏页面 / 独立窗口的理由 |
| 1.6 | 2026-09-13 | 确定**执行一次性历史数据回填**（新记为 C7），从 §12.2 待确认移入 §12.1；§7.4 由「可选」改为已确认，并补充取值来源（`turns.execution_config_json`）与回填局限；新增 §6.3 事件台账的保留策略现状；修正 §6.1 S3 中「保留期清理」为「按会话数量清理」 |
| 1.7 | 2026-09-13 | 统计数据保留期确定为「**按天、可配置、删除留痕**」（新记为 C8），从 §12.2 待确认移入 §12.1；§7.5 重写为约定表并补入删除留痕要求；§13 `main.ts` 一栏补充留痕日志 |
| 1.8 | 2026-09-13 | 「步数」口径确定为「**实际产生了 usage 记录的 Step 数，不按 outcome 剔除**」（新记为 C9），从 §12.2 移入 §12.1；§9.3 与 §2.3 的表述同步对齐（原先「计入…并可按 outcome 过滤」与 D5 存在重复记账）；「只看成功 Turn」列入 §10.2 后续迭代 |
| 1.9 | 2026-09-13 | 工具调用确定为**三分类**（执行成功 / 执行失败 / 未执行），五类「未执行」不计入工具出错（新记为 C10），从 §12.2 移入 §12.1；§2.4 重写为分类表 + 五类来源 + 实现约束；§3 新增 M5c 未执行次数；§7.1 表 2 新增 `tool_skipped_count` 列；§7.4 补充「回填无法区分拒绝与失败」局限；§8.1 / §8.2 / §11 同步 |
| 1.10 | 2026-09-13 | 新增**附带改动**：把工具确认结果落一笔台账事件（新记为 C11），使今后的回填也能区分「未执行」与「执行失败」；新增 §7.6（改动面 6 处、覆盖范围表、降级风险）；§2.4.3 加第 5 条；§7.3 表格与 §13 文件清单同步；§7.4 局限表述更新 |
| 1.11 | 2026-09-13 | **修正事实错误**：迁移版本号由「13 → 14」改为「**15 → 16**」（代码基线已推进：v14 = `sessions.ownership`/`visibility`，v15 = butler 表）；§7.2 / §11.3 R3 / §13 同步，并在 §7.2 注明「实施前再核对一次当时的版本号」 |
| 1.12 | 2026-09-13 | **决策项全部结清**：D9 子 Agent / 远程渠道用量 → **合并计入、按渠道拆分留后续**（新记为 C12）；D8 时间粒度与会话跳转 → **第一版不做**（新记为 C13）。§12.2 清空并附「原 D1–D9 去向」对照表；§1.2 G1 补充「含远端渠道」；§4 / §9.3 / §10.1 / §10.2 / §8.2 同步；§13 修正残留的「注册 v14 迁移」为 v16 |
| 1.13 | 2026-09-13 | **provider 字段形态采样完成**（新记为 C14）：基于 `logs/Agent-*.log` 41 个文件共 1281 条真实 `llm.response.usage` 与 `sessions/*/events.jsonl` 的 `request_usage`。§2.6 由「实施前置校验」改写为「字段形态基线」（provider 对照表 / 四条结论 / 两条实现约束 / 真实样例 / 命中率分布）；§2.2.1 标注 subset 分支实测未出现；§7.4 补「回填实现要点」；§11.1 的 T10–T11b 由虚构场景替换为**真实样本**；§12.1 新增 C14 |
| 1.14 | 2026-09-13 | 附带改动改按**方案 B**（C11 修订）：由「新增 `tool_decision` 台账事件」改为「**在 `ToolCallResultPersisted` 上加分类字段**，随现有 `tool_result` 事件落台账」。**不再修改 `sessionEvents.ts`**，消除旧版本读到新台账的 `Invalid session event` 降级风险。§7.6 重写（含方案对比与「缺陷仅在台账层」的核实结论）；§7.3 / §7.4 / §2.4.3 的引用同步；§13 用 `src/shared/domainTypes.ts` 替换 `electron/sessionEvents.ts` |
| 1.15 | 2026-09-17 | **按评审报告（`agent-token-usage-analytics-requirement-review.md`，本地过程产物，不入版本控制）修订**：见上「主要变更（v1.15）」 |
| 1.16 | 2026-09-17 | **按复审报告（`agent-token-usage-analytics-requirement-review-v1.15.md`，本地过程产物，不入版本控制）修订**：<br>**阻断项 B1'** —— `usage_turn_facts` 写入点由 `finalizeTurn` 改为 **`runToolChatSession` 统一收口**（新增 C16）：`finalizeTurn` 只服务桌面 IPC 链路，远程（`imRemoteAgent`，`emitSessionEvent` 为 no-op）与 butler（`butlerInvoker`）都绕过它，否则远程 / 自动化的 Turn 数与工具计数会全部缺失并被误标 `interrupted`。删除 §7.3.1 的跨模块内存累加器（改局部变量累计，泄漏与渠道覆盖问题一并消失）；声明**远程回合不落台账 → 回填天然为零**的盲区。<br>**P1** —— ①新增「恒等式作用域」：`interrupted` Turn 工具计数不可知、按 0 写入并**排除**在恒等式断言之外；synthetic `tool_result` 计入**仅限回填路径**，且按 `toolUseId` 关联 `tool_call` 归因；②**远程任务预算门控**（`checkRemoteTaskBudget` 失败）纳入「未执行」，来源由六类增至**七类**，§7.6 改动面改为 **`recordToolResult` 全部 14 个调用点**的穷举归类表（未执行 10 / 执行失败 4），§2.4 分类判据明确为「**是否已进入执行流程**」；③§9.3 修正「远程只要产生 `request_usage` 即计入」的不实表述。<br>**P2** —— 累加器内容（去 Token 四元组）、§7.3 冗余「流式路径」行、synthetic 归因方式、§9.3 悬空引用（§10.2 补「估算用量筛选」行）、§7.6 tsdoc 注释补预算耗尽、§13 文件清单（`claudeStreamHandlers` 改为「不改统计写入」，`usageStatsRecorder` 去累加器）。<br>R6 补「必须覆盖三条链路」与 `interrupted` 豁免。 |
| 1.17 | 2026-09-17 | **按 v1.16 复审报告修订**：<br>**P1-1（`turnId` 缺失）** —— `RunToolChatSessionArgs` 无 `turnId`，loop 内用 `sessionId` 占位、靠桌面包装层（`claudeStreamHandlers.ts:423`）事后覆写，**远程 / butler 没有这层覆写**，而 `usage_step_facts.turn_id` / `usage_turn_facts.turn_id` 都是 `NOT NULL`。新增 **C17**：给 `runToolChatSession` 加 `turnId` 入参，三个调用方各传真实值；§7.3 新增「前置改动」段；§13 补 `imRemoteAgent.ts` / 两个 router / `butlerInvoker.ts` / `claudeStreamHandlers.ts`。<br>**P1-2（第 15 个发出点）** —— `toolChatLoop.ts:1077` 的输出截断恢复路径**绕过 `recordToolResult`** 直接 `emitSessionEvent`，原「14 个调用点穷举」漏了它，恒等式在该路径下会破。§7.6 表扩为 **15 处**（未执行 11 / 执行失败 4），来源增至**八类**（新增 `model_output_truncated`），§2.4.0 补「必须覆盖全部 `tool_result` 发出点」纪律；M5c / §7.1 / C10 / C11 / R6 同步。<br>**P1-3（butler `turnId` 占位）** —— `createButlerSessionEvents` 不注入 `turnId`，既有 butler 台账的 `turnId` 实为会话 ID；§7.4 回填要点改写并新增「butler 历史的 `turnId` 是占位」局限（给时间匹配 / 接受合并两个方向，**不伪造 turnId**）。<br>**P1-4** —— 穷举表边界已含第 15 点（随 P1-2 解决）。<br>**P2** —— ①§7.1 `outcome` 枚举改为 `TurnOutcome` 实际取值（`completed` / `failed` / `cancelled` / `timed-out` / `recovered`，外加统计侧 `interrupted`），并注明原「与 `turns.outcome` 对齐」名实不符；②§2.4.1 判定原则由「从未进入执行器」统一为「从未进入执行流程」（与 §2.4 表一致）；③T16 改用「拒绝 + 策略拒绝 + 输出截断」，并注明预算耗尽是无条件 `break`、不宜设计同 Turn 用例。<br>另修正 v1.16 遗留的一处锚点断裂（§2.4.1 标题已改「七种」但部分引用仍写「六种」）。 |
| 1.18 | 2026-09-17 | 清理 v1.17 的两处 P2 残留：①§7.3.1 第 3 条 `outcome` 取值由 `success` 改为 **`completed`**（与 §7.1 表 2 的 `TurnOutcome` 枚举一致，并注明「不要写成 `success`」）；②§13 文件清单删除 `electron/claudeStreamHandlers.ts` 的**重复旧行**（「不改统计写入」那行），保留含 `turnId` 入参的新行。 |

---

**待办：** 无阻塞项 —— 决策项 **C1–C17** 已全部结清；[§2.6](#26-provider-字段形态基线已采样-2026-09-13) 的 provider 字段形态采样已完成；三轮评审（`-review.md` v1.14、`-review-v1.15.md`、v1.16 复审）的 **B1 / B2 / B1' 三个阻断项与全部 P1、P2 均已修订**（见 §14 v1.15 / v1.16 / v1.17 / v1.18）。可进入实现阶段。
