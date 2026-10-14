# 产品需求规格：MCP 工具延迟加载（Deferred Tool Loading）

## 目录

1. [概述](#1-概述)
2. [现状分析](#2-现状分析)
3. [术语与概念](#3-术语与概念)
4. [外部参照](#4-外部参照)
5. [功能需求](#5-功能需求)
6. [技术方案](#6-技术方案)
7. [影响面与兼容](#7-影响面与兼容)
8. [边界与异常](#8-边界与异常)
9. [分阶段实施计划](#9-分阶段实施计划)
10. [验收标准](#10-验收标准)
11. [决策记录](#11-决策记录)
12. [风险与开放问题](#12-风险与开放问题)
13. [相关文件](#13-相关文件)
14. [附录 A：工具面限制体系全貌](#附录-a工具面限制体系全貌数值速查)
15. [变更记录](#变更记录)

---

## 1. 概述

### 1.1 需求原文

> MCP 协议有版本迭代吗？它有支持按需加载的机制吗？现在全加载的 MCP 上下文浪费比较严重。
>
> 基于当前 SpaceAssistant 的实现现状，帮我按 Claude Code 的 deferred 思路（上下文只放 name+description 索引、调用前再取 schema），设计一套完整的方案。

### 1.2 背景

MCP 协议本身没有把「工具按需加载」标准化：`tools/list` 只有游标分页，客户端通常仍会全量拉取并把每个工具的完整 `inputSchema` 注入模型请求。解决上下文浪费的主流做法在客户端侧，代表是 Claude Code 2.1.121+ 的 Tool Search（deferred tools）：上下文只注册工具名 + 描述作为可检索索引，模型决定使用某工具时才取全量 schema；社区实测单个 GitHub MCP 服务（90+ 工具）可占 50k+ token，延迟加载在 Claude Sonnet 上有约 56% 的成本节省（OpenReview：*Schema Discoverability, Not Locality, Drives MCP Cost Savings*）。

SpaceAssistant 已完整落地 MCP 客户端（`electron/mcp/`），MCP 工具与内置工具一样**每轮请求全量注入**（含完整 `input_schema`）。本需求按 Claude Code 的 deferred 思路，为 SpaceAssistant 设计一套 MCP 工具延迟加载机制，并复用仓库内已有的「按需披露」基础设施。

### 1.3 要解决的问题

1. **上下文占用浪费**：MCP 工具的完整 schema 全量进入每轮请求的 tools 数组，即使本次会话只会用到其中一两个工具。当前快照预算上限为 64 个工具 / 96 KiB（约 2.7 万 token），极端情况下工具定义可占输入上下文的相当比例。
2. **无差别注入**：内置工具（19 个，schema 小且高频使用）与外部 MCP 工具（schema 大、使用频率低）采用同一全量注入策略，没有按成本收益区分。
3. **预算裁剪即不可见**：超出快照预算的工具被直接裁掉（`budgetDropped`），模型完全不知道其存在，无法被发现或调用。
4. **缓存稳定性弱**：MCP 服务增删/重连会改变 tools 数组，使请求前缀（tools → system → messages）的 prompt cache 失效。

### 1.4 目标

1. MCP 工具支持**延迟加载模式**：上下文只保留「name + 描述」的轻量索引，完整 schema 在模型声明使用意图后（经 `tool_search` 元工具检索）再下发。
2. 提供 **auto / always / off** 三档全局策略与**按服务覆盖**（`alwaysLoad`，对齐 Claude Code 语义），auto 档按 schema 体量阈值自动取舍，小工具集不因延迟加载反而多花轮次。
3. 模型**跳过检索直接调用**延迟工具时透明兜底：主进程本地已有完整 schema（快照即执行注册表），直接执行并放行，不中断 tool loop。
4. 授权面与广告面解耦：延迟工具**不在 tools 数组出现**（不广告），但**保持可执行**（授权集合包含它们），安全审批链路（`McpConfirmCard` 等）完全不变。
5. 计量链路如实反映新模式：三源归因（system/tools/messages）中 tools 源缩小、新增延迟索引维度，可量化每轮节省。
6. 消除预算裁剪的静默失败：延迟路径上工具池全量准入（FR11），eager 残余裁剪双路告知（FR12），用户不再「装了工具却不知为何用不了」。

### 1.5 非目标

1. 不改 MCP 快照在 **eager 广告面**上的预算口径——既有 64 个 / 96 KiB 仍约束真正全量注入上下文的部分（§6.5）；延迟模式下快照准入放宽为偏执上限（512 个 / 1 MiB），预算职责迁移而非取消（§11 D6/D8）。
2. 不实现 Anthropic 原生 Tool Search Tool beta（`defer_loading` + 服务端检索），仅在 Phase 4 作为可选适配评估；本方案为客户端模拟，对所有 provider 生效。
3. 不支持远程 IM lane（remoteContext 会话）——与现有「MCP 仅桌面 lane 注入」约束（需求 §4.6、偏差 21）保持一致。
4. 不做跨会话/持久化的工具检索缓存，检索永远基于本次装配的快照。
5. 不改变内置工具的注入方式（保持全量，理由见 §11 决策记录 D3）。
6. 不新增**聊天链路** IPC 通道；所有变更收敛在主进程装配与 tool loop 内部，渲染端仅涉及展示与设置项（设置页诊断查询经既有 `mcp:list` 载荷扩展，FR12/评审 B3）。

---

## 2. 现状分析

### 2.1 工具注入链路（v1.6 按 9f753bc4 基线重写：tool loop 已迁移至 packages/agent-sdk hosted 架构）

当前「工具定义 → 注入请求 → 调用执行」数据流：

```
配置(AppConfig.tools / skills / mcp profiles)
  → 装配期 invocationAssembler（electron/runtime/invocationAssembler.ts，1,320 行）：
      mcpSnapshot = buildSnapshotFromDb(db)                  （L526-528：有 db 的 lane 均构建，非桌面带 remoteContext:true 标志；
                                                             「仅桌面注入」是广告面行为，effectiveTools.ts:41——O11.3）
      hostedMcpRegistry = createHostedMcpToolRegistry(...)   （L1123-1128：快照 entries 逐个
          resolveExecutor 注册为 outbound 直接工具——registeredMcpTool.ts；失败即 throw，见 R9）
  → toolChatLoop.ts（重构后为 1,079 行适配层）：
      computeEffectiveTools（L933-941，invoke 一次）
        = filterBuiltinToolsForApi(内置全量定义；toolsConfigRuntime.ts:28-109，effectiveTools 仅 import——O11.6)
        + snapshotEntriesToAnthropicTools(MCP 快照全量定义)    ← 含完整 input_schema
      systemPrompt = buildFinalSystemPrompt(...)（L976：base + 工具约定 hint + skill 目录）
      组装 PreparedModelCall = { request: { tools(全量), system, messages } }
  → turn 执行（packages/agent-sdk/src/turn.ts AgentTurnHost 循环）：
      capabilities.define(known = request.tools,
                          authorized = registeredTools ∩ authorizedToolNames)
          （hostedAgentTurnHost.ts:99-106——known/authorized 是分发门禁的字符串集合，不进 prompt）
      每轮模型请求（tools/system 原样重发）→ tool_use → capability 检查 → 注册表分发执行
      → 工具结果双面落账：wire 面 CanonicalModelMessage + 持久化/事件面
        ToolCallResultPersisted（AD10 惯例延续，经 afterToolResult / sessionLedger* ports）
      → tool_result 追加 messages → 下一轮
```

关键事实：

- **tools 每轮全量重发**。`computeEffectiveTools`（electron/effectiveTools.ts:19-80，**未随重构变更**）在交给 SDK turn 循环前只算一次，循环内每轮原样重发。唯一的收窄手段仍是配置开关、lane 过滤和 P7 `trim.allow/deny`（effectiveTools.ts:46-54）。
- **授权门从「逐调用校验」改为「turn 级能力登记」**：`routeVisibleToolNames`(request.tools) → 与注册表、`authorizedToolNames` 求交 → `capabilities.define(known, authorized)`（hostedAgentTurnHost.ts:99-106）；SDK 强制 **authorized ⊆ known**（capability.ts:14，违者 throw）。模型直调未登记工具时走结构化拒绝：`returnDeniedToolsToModel: true`（turn.ts:1415-1431）把 `ToolDeniedError.userMessage` 以 `is_error` 工具结果回给模型，并触发 `afterToolResult({ kind: 'safety-rejection' })` 观测钩子。
- **恒定前缀结构不变、实测锚点移除**：请求仍为 tools → system → messages 前缀、断点在 system 与末条消息；重构前的「恒定 ≈93 KB/请求」实测注释已随迁移删除，Phase 3 需在新架构下重新实测（§10.2.2/10.2.3）。
- **token 计量三源拆分存活**：`summarizeToolDeclarations`（usageAttribution.ts:194，调用方迁至 agentSdkDesktopObserver.ts）、`classifyToolSource`（L188）、三源 toolsTokens（usageAttribution.ts:295，O9）与 contextUsageEstimate.ts / usageAttribution.ts 计量链路均存活（行号移位）；常量前缀去重迁至 runtime/requestHeaderProjection.ts。

（行号基线：commit 9f753bc4。）

### 2.2 MCP 快照、预算常量与已知缺口

`buildSnapshotTools`（electron/mcp/mcpToolRegistry.ts:251-293）在装配期构建请求级快照：

- 远程 IM 会话一律不注入（`mayBuildMcpToolSnapshot`，L241-243）；
- 仅启用且白名单（`profile.enabledToolNames`）非空的服务注入，按配置顺序确定性排列；
- 预算常量族（src/shared/mcpTypes.ts:18-21）：**数量 64 个/轮**（`MCP_TOOLS_PER_ROUND_MAX`）、**聚合体积 96 KiB/轮**（`MCP_TOOLS_TOTAL_BYTES_MAX`）、**单工具 schema ≤16 KiB 且深度 ≤20**（`MCP_TOOL_SCHEMA_MAX_BYTES/_DEPTH`）。

裁剪算法 `trimMcpToolsForBudget`（mcpTypes.ts:613-637）：按「服务配置序 → 白名单序」的**跨服务全局队列**逐条累计 `JSON.stringify` 字符数——数量到 64 后硬截，体积超限则跳过但继续装更小的（贪心）；被裁者记入 `budgetDropped`（附 reason），且保持**三无：不广告、不授权、不可执行**（快照只收 kept）。

描述经历三级漏斗，逐层有界：

1. **发现期**：`validateMcpToolSchema` 截 4,000 字符后入缓存（mcpToolRegistry.ts:64）——快照内描述的最大长度；
2. **广告期**：进 tools 数组时再截 3,500 字符（L302，`snapshotEntriesToAnthropicTools`，含来源前缀）；
3. （方案新增）索引行截 120 字符，见 §6.2。

其中 3,500 与 96 KiB 均为**无文档记载的自设护栏值**（全仓唯一出处即代码；前者防「单条描述爆炸」≈1k token/条，后者防「聚合体积爆炸」，二者互补）。

**已知缺口（评审确认）：预算裁剪完全静默。** `budgetDropped` 的字段注释写着「供设置页展示」（L236-238），但全仓无任何消费方（渲染端 / preload / 设置页 0 引用；仅四处空初始化字面量：toolChatLoop.ts:932、invocationAssembler.ts:528、mcpToolRegistry.ts:256 与 :315——O11.1）——数据落地即弃。三个时机均无告知：安装/启用期不做预算预估；聊天期被裁工具直接不存在、无日志事件；调用被拒时归因缺失——旧实现的误导文案（`tool_not_authorized: MCP 工具已变更或服务不可用`）已随 hosted 架构重构移除，拒绝现经 SDK 结构化路径（`returnDeniedToolsToModel`，turn.ts:1415）返回，但**不区分「预算未注入」与「服务不可用」**（FR12② 交付项）。又因裁剪队列跨服务全局共享，「某服务 5 个工具被裁掉最后 3 个」乃至「排前的服务吃满 64 个名额、另一服务整体覆没」都可能出现，且结果随用户的服务排序变化。本方案以 FR11（准入放宽，延迟路径上不产生裁剪）与 FR12（eager 残余裁剪双路告知）处置。

**已知缺口二：工具缓存不自动跟随 server 变化（与缺口一同族，评审讨论追加核实）。** 快照的数据源 `McpToolCacheEntry` 全仓只有一个写入点——设置页「刷新工具」按钮（`mcp:refresh-tools` handler mcpIpc.ts:216-312、发现调用点 L241 → `discoverToolsFromSession` 重写缓存；连接测试的 listTools 仅返回预览不写缓存，mcpConnectionManager.ts:494）。MCP 协议的 `notifications/tools/list_changed` 处理**未接线**：`markToolsStale`（mcpToolRegistry.ts:164-168）全仓无生产调用方（仅测试引用），连接建立 / 断线重连也不重新发现工具。后果：server 加了新工具，用户不点刷新永远用不上；改了 schema，快照里是旧版、调用时参数对不上；删了工具，白名单留死名（buildSnapshotTools 构建时静默跳过，L266-269）。这是独立于本需求的既有缺口（`markToolsStale` 的注释表明原设计意图是接线的），但它决定了本方案 §12 R7 的形态：MCP 侧中途变化在当前实现里只能由用户操作触发，list_changed 一旦接线则需要模式冻结保护（R7）。

限制体系全貌见附录 A。

### 2.3 仓库内已有的「按需披露」先例

本方案不是引入新范式，而是把仓库已验证两次的模式推广到 MCP 工具：

1. **Skills 目录（最直接的样板）**：`buildSkillCatalogSection`（src/shared/skillPrompt.ts:5-22）只把「名称 + description + read 路径」一行条目放进 system prompt 的 `## Skills` 区块（`PromptSection` order 50，electron/llmSystemPrompt.ts:85），受 `skillCatalogBudget(contextWindow)` 预算截断，超出部分提示 "Additional skills are available through skills.read"；正文经路由命中的 user fragment（toolChatLoop.ts:901-907）或 `skills.read` 工具（上限 32,000 字符）按需取得。
2. **toolkit.find / toolkit.call 能力网关**：两段式「先按用途查询能力 → 再按能力 id 调用」，其调用约定提示已写入 `buildToolCapabilityConventionHint`（src/shared/skillPrompt.ts:107-118，L113）。`tool_search` 的约定提示将完全复用这个槽位与措辞风格。
3. **history.read 分窗读取压缩历史**：同样是「列表轻量、内容按需」。

### 2.4 计量与观测现状

- UI 占用环（src/shared/contextUsageEstimate.ts）基于 API 返回 usage + tool_result 投影，不含工具定义 token，无需改动。
- 请求面埋点（requestContext.ts、usageAttribution.ts、contextMeter.ts）已具备 `toolsTokens`、`toolsFingerprint`、按来源拆分的声明明细，随每 attempt 整表替换（已迁 agentSdkDesktopObserver.ts:169-189）；事件流落盘对恒定前缀去重（runtime/requestHeaderProjection.ts:9 + agentSdkDesktopObserver.ts:168）。

### 2.5 测试现状

- `electron/toolChatLoop.*.test.ts` 现存 12 个（hosted 架构迁移后大量用例迁至 `electron/runtime/` 的 agentRuntime / hostedTurn* / invocationAssembler 系列）；`electron/effectiveTools.{compatName,trim}.test.ts`、`src/shared/builtinToolDefinitions.test.ts`、`electron/mcp/` 23 个测试覆盖既有行为。
- **没有任何 deferred / 按需 schema 相关测试**（本需求需新建）。

---

## 3. 术语与概念

| 术语 | 定义 |
|---|---|
| **广告面（advertised）** | 随请求 tools 数组下发的工具集合。模型只能「看见」广告面内的工具定义。 |
| **授权面（authorized）** | `authorizedToolNames`，分发循环校验 tool_use 合法性的集合（effectiveTools.ts:77）。本方案把授权面从广告面中解耦：延迟工具在授权面、不在广告面。 |
| **Eager（全量注入）** | 现状行为：工具连 schema 一起进 tools 数组。 |
| **Deferred（延迟加载）** | 工具不进 tools 数组，仅以「name + 描述」条目进入索引；完整 schema 经 `tool_search` 检索后在下轮可见。 |
| **索引（index / catalog）** | system prompt 中的 `## MCP 工具索引` 区块，逐行列出延迟工具的 name（mappedName）、所属服务名、一句话描述。 |
| **元工具（meta-tool）** | `tool_search`，一个真实注册的内置工具：模型调用它检索延迟工具，返回结果携带匹配工具的完整 `input_schema`。 |
| **兜底执行（transparent fallback）** | 模型未检索而直接调用延迟工具时，主进程因授权面包含该工具而照常执行；仅做观测记录，不阻断。 |
| **快照（snapshot）** | `McpToolSnapshot`（装配期构建）。在本方案中语义升格为**执行注册表**：无论广告与否，工具的 schema 都以它为准。 |

---

## 4. 外部参照

### 4.1 Claude Code Tool Search（deferred tools）

Claude Code 2.1.121+ 引入 tool-search deferral：MCP 工具默认延迟——上下文只注册轻量索引，模型检索后 schema 才进入上下文；server 配置支持 `alwaysLoad: true` 让特定服务的工具跳过延迟、始终全量加载（agentpatterns.ai）。Docker 的 agent 文档同样把 deferred tool loading 作为「多 server / 数百工具膨胀启动上下文」的推荐解法。

### 4.2 Anthropic API 侧能力（本方案的 Phase 4 评估项）

Anthropic 的 Advanced Tool Use 系列（Tool Search Tool、Programmatic Tool Calling、Context Editing）把工具索引与检索下沉到 API 层：工具定义带 `defer_loading`，由服务端 `tool_search` 工具按需浮现。采用它可省去客户端模拟的一轮往返，但绑定 provider 且需要 beta header，故列为后续适配而非本期范围。

### 4.3 协议层现状

MCP 规范（最新正式版 2025-11-25，[官方 changelog](https://modelcontextprotocol.io/specification/2025-11-25/changelog)）没有工具按需加载条目；`tools/list` 分页、Resources/Prompts 的天然懒加载、elicitation 都不能替代客户端侧的 deferred 策略。2026-07-28 RC 的 Extensions 框架是未来标准化该能力的可能载体。

---

## 5. 功能需求

- **FR1（延迟加载模式）**：当延迟模式生效时，MCP 工具不再进入请求的 tools 数组；其「mappedName + 服务名 + 描述」以逐行条目形式进入 system prompt 的 `## MCP 工具索引` 区块。内置工具行为不变。
- **FR2（tool_search 元工具）**：新增内置工具 `tool_search`（仅桌面 lane 注册），模型可用它按关键词检索延迟工具；返回结果携带匹配工具的完整 `input_schema`（**schema 永不截断**——残缺 schema 无法调用），模型随后即可调用。检索召回三保障：query 空格分词后任一词命中即候选（跨语言召回）；**空 query 等价「分页列出全部」**，配合 limit 遍历是最终兜底；返回体总量 32 KiB 防护下**描述按快照原文返回（≤4,000 字符，信息量 ≥ 现状广告期 3,500，与现状对齐）**（§6.3 溢出响应与上限定价逻辑）。`tool_search` 属只读操作，自动放行，不进审批流。
- **FR3（授权面解耦，v1.6 按 hosted 架构修订，评审三轮 A 方案）**：延迟模式生效时，`computeEffectiveTools` 产出 `deferredToolNames`（延迟名集合）随 turn host 依赖传入；`capabilities.define` 时将延迟名**同时并入 known 与 authorized** 两栏——门禁簿记操作，零上下文成本（known/authorized 是分发的字符串集合，不进 prompt；SDK 约束 authorized ⊆ known 由「两栏都填」满足，capability.ts:14）。效果：模型直调延迟工具经 capability 检查（known-authorized）走正常分发路径执行，透明兜底语义保留（D2），tool loop 不中断。语义自洽：模型在索引区块中确实见过这些名字，「known（听说过）= 广告面 ∪ 索引面」贴合真实语义。实现期注意：确认 SDK 无其他消费方假设 known === request.tools（§7.2 断言）。
- **FR4（索引预算截断）**：`## MCP 工具索引` 区块受字符预算约束（复用 skillCatalogBudget 的模式，200k 窗口可列 ≈82 行）；头部注明「共 N 个工具，已列出前 K 个」，截断时尾部追加「更多工具请用 tool_search 检索」提示——索引是**截断视图**而非准入名单，被截断工具仍可被全文检索发现。
- **FR5（策略三档）**：`ToolsConfig` 新增 `mcpDeferredLoading: 'auto' | 'always' | 'off'`（**默认值灰度**：Phase 1–3 交付构建默认 `'off'`，10.2 真机验收通过后单独提交切 `'auto'`，见 §9 灰度计划）：
  - `off`：现状行为，全量注入（保留既有 64 / 96 KiB 裁剪）；
  - `always`：除显式覆盖外全部延迟；
  - `auto`：**eager ⇔（快照 schema 字节总量 ≤ `mcpDeferredSchemaBudgetBytes`（默认 16 KiB）且工具数量 ≤ 64）**，任一超出即整体转延迟——保证任何超出 eager 广告容量的配置自动进入延迟模式，从根上消除「超预算被静默裁剪」（§11 D8）。
- **FR6（按服务覆盖）**：`McpServerProfile` 新增 `alwaysLoad?: boolean`（对齐 Claude Code 语义）：`true` = 该服务工具始终全量注入、跳过延迟与索引；未设置 = 跟随全局档位。设置页 MCP 区域提供该开关。
- **FR7（约定提示）**：延迟模式生效时，`buildToolCapabilityConventionHint` 追加一行约定：MCP 工具的参数定义未随请求下发，调用前先用 `tool_search` 检索；`buildAvailableToolsHint` 的「仅可调用以下工具名称」清单须注明另有 N 个 MCP 工具经索引/检索可用，避免与 FR3 矛盾。措辞对齐既有 hint 的 compat 名口径（toolkit_find / toolkit_call，skillPrompt.ts:112-113，评审 S6 既定）；`tool_search` 无点号、compat 恒等映射（O11.4）。
- **FR8（计量如实）**：延迟模式下，turn 维度新增 `deferredToolCount` 与延迟索引字符数（换算 token）；`summarizeToolDeclarations` 的来源明细只含广告面工具；`tool_search` 调用本身计入 builtin 来源。节省量 = 「eager 等效 toolsTokens − 实际 toolsTokens − 索引 token」按轮落日志。未检索直调观测（`deferredUnsurfaced`，§6.4）参与节省归因，落持久化/事件面（AD10）。
- **FR9（调用展示）**：`tool_search` 调用在聊天流中以通用 ToolCallCard 展示，显示名「工具检索（MCP）」（toolCallDisplay.ts 映射），结果体预览显示命中工具名列表；延迟工具的执行展示与现有 MCP 确认卡链路完全一致。
- **FR10（配置持久化与 i18n）**：新增配置项走 `mergeToolsConfig` 合并、设置页可视化编辑，zh-CN / en-US 文案齐全，通过 `npm run i18n:check`。
- **FR11（快照准入放宽，不分池）**：延迟模式下快照准入不再执行 64 个 / 96 KiB 裁剪——白名单（`enabledToolNames`）成为唯一准入门槛，仅保留 **512 个 / 1 MiB 偏执上限**防病态 server（超限裁剪照记快照层 `budgetDropped`）。索引是截断视图而非准入名单（FR4），tool_search 检索域覆盖全部快照条目——「主池搜完再搜后备池」的两段式没有召回收益（substring 在百级工具上均为微秒级），不建池（§11 D6）。延迟模式下**快照层** `budgetDropped` 在偏执上限内恒空（广告面层 `eagerBudgetDropped` 按档位可能非空，FR12），静默裁剪问题从根上消解。
- **FR12（eager 溢出告知）**：仅 eager 广告面（off 档超限、auto-eager 超限、alwaysLoad 服务超限）可能发生预算裁剪。被裁工具保持现状「三无」语义，但必须双路告知：① 设置页渲染预算裁剪结果（数据通路见 §6.7：按需重算 + `mcp:list` 载荷扩展 `budgetDiagnostics`，快照层 `budgetDropped` 与广告面层 `eagerBudgetDropped` 双源合并、按 source 分组）——兑现 mcpToolRegistry.ts:236-238 既有注释意图（UI + i18n）；② 模型调用被裁 / 未授权工具时，拒绝结果经 SDK 结构化路径返回（`returnDeniedToolsToModel: true` → `ToolDeniedError.userMessage` 以 `is_error` 工具结果回模型，turn.ts:1415-1425，并触发 `afterToolResult({ kind: 'safety-rejection' })` 观测钩子）——hosted 架构已具备通道，**交付项是文案区分**：拒绝结果须区分「因本轮工具预算未注入」与「MCP 工具已变更或服务不可用」（旧实现的误导文案已随重构移除，归因区分仍缺失）。
- **FR13（注册失败快照层剔除，评审 B6 / R9 需求化；v1.8 扩为全档位）**：**装配期快照清洗，全档位一致（off / auto / always）**——建快照后、档位分支与 plan 计算前，对 entries 逐条试解析 executor，失败条目**快照层剔除**（坏条目不进快照 → 索引、deferredNames、授权面自然同步不含，无需额外簿记）；剔除事件记 `budgetDiagnostics`（source: 'executor'）+ agentLogger warn，invoke 正常完成。禁止「留在快照仅跳过注册」的弱剔除——那会让索引含一个注册表里没有的名字，模型直调落 `REGISTERED_TOOL_NOT_FOUND`。
  **对 off 档「现状逐字节一致」承诺的唯一有意偏离（显式声明）**：executor 解析 throw 的崩溃向量在注册表构建期、与档位无关（hostedMcpRegistry.ts:18-19 throw、调用点 invocationAssembler.ts:1130-1135 无包裹，v3 评审已核实）——off 档用户同样暴露。现状下坏条目使整 invoke 失败；本方案改为剔除 + 降级继续 + 可观测。不采用「off 档保留现状 throw」的替代项：同一坏缓存按档位产生两种失败形态不可解释，且崩溃没有请求体、不在逐字节可比范畴。10.1.1 的逐字节断言以**成功请求**为口径，不受此降级影响（坏条目输入在现状下本就不产生请求）。
- **FR14（FR6 持久化链路完整性，评审 B5）**：`alwaysLoad` 端到端可保存可读回——写入侧过 `McpServerWriteInputSchema`（mcpTypes.ts:341-371，`.strict()`，不加字段即抛错），读取侧过 `McpServerProfileSchema`（mcpTypes.ts:257，非 strict 默认 strip 未知键，不加字段即静默丢失），中间经 `writeInputToProfile`（mcpIpc.ts 白名单式拷贝）与渲染端 `mcpDrafts.ts` 草稿模型——五处（含类型定义）缺一即链路断，且 **typecheck 兜不住 zod 运行时校验**。

---

## 6. 技术方案

### 6.1 总体机制

```
装配期（invocationAssembler，每次 invoke 一次）：
  mcpSnapshot = buildSnapshotFromDb(db)        （延迟档准入放宽为偏执上限 512/1MiB；off 档走现状裁剪）
  deferredPlan = computeDeferredPlan(...)      （§6.5；模式按 contextWindow 冻结）
  hostedMcpRegistry = createHostedMcpToolRegistry({ snapshot, resolveExecutor })
      │  快照 entries 全量注册为 outbound 直接工具——延迟工具天然在册（FR11 不变量）
  effectiveTools = computeEffectiveTools({ ..., deferredPlan })
      │  deferred 时：tools 数组 = 内置 + tool_search + alwaysLoad 服务的 MCP 工具
      │  authorizedToolNames 含全部延迟名；新增产出 deferredToolNames（FR3 门禁簿记用）
      │  eager 广告面（off/auto-eager/alwaysLoad）仍按 64/96KiB 裁剪（FR12：结果落设置页 + 被拒文案区分）
  PreparedModelCall = { request: { tools(广告面), system(含「MCP 工具索引」区块), messages } }

turn 执行（packages/agent-sdk turn 循环）：
  capabilities.define(known = request.tools ∪ deferredNames,
                      authorized = 授权面 ∪ deferredNames)     ← FR3 门禁簿记，零上下文成本
  每轮模型请求（前缀原样重发）→ tool_use → capability 检查 → 注册表分发执行
  → tool_result 追加 messages → 下一轮
  兜底：模型直调延迟工具 → known-authorized → 正常分发（transparent fallback，D2）
  未登记工具名 / 被裁工具 → returnDeniedToolsToModel 结构化拒绝（FR12② 文案区分）
```

方案落点刻意收敛在 `computeEffectiveTools`（广告面 / 授权面 / `deferredToolNames` 产出）与 `invocationAssembler`、`hostedAgentTurnHost` 的能力登记两处；SDK turn 循环与分发、审批、执行、恢复、压缩台账（packages/agent-sdk 及既有 ports）**零改动**——授权面解耦由「computeEffectiveTools 产出 + capabilities.define 并入」两步完成（FR3）。

### 6.2 索引构建（system prompt 区块）

新增 `src/shared/toolCatalogPrompt.ts`（与 skillPrompt.ts 平行）：

```ts
export function buildMcpToolCatalogSection(
  entries: McpToolSnapshotEntry[], contextWindow: number
): PromptSection | null   // 无延迟工具时返回 null，不产生空区块
```

- 区块名 `mcp:catalog`，order 45（位于工具约定 hint 与 `## Skills`（order 50）之间，llmSystemPrompt.ts 的 section 列表加一项）。
- 行格式对齐 skills 目录：`- mcp_feishu_create_doc（飞书）：创建飞书文档`；描述取首行/前 120 字符。
- 预算复用 `skillCatalogBudget(contextWindow)` 口径，按行累加截断；截断时追加「（更多工具请用 tool_search 检索）」。
- `buildFinalSystemPrompt` 接收新参数 `mcpCatalog?: PromptSection`，拼装逻辑不变。

**缓存影响评估**：现状下 MCP 快照变化会使 tools 前缀失效；方案下变为 system 的 catalog 区块变化使 system 前缀失效——失效面相同（前缀是 tools→system→messages 顺序，tools 或 system 任一变化都使整条前缀缓存失效），无回归。且常态下 tools 数组（内置 + tool_search）比现状更稳定。

### 6.3 tool_search 元工具

定义加入 `src/shared/builtinToolDefinitions.ts` 的 push 区（与 `toolkit.find/call` 同段，L284-290 附近），并纳入 `ALL_BUILTIN_TOOL_NAMES`：

```jsonc
{
  "name": "tool_search",
  "description": "检索本会话可用但参数定义未随请求下发的 MCP 工具。返回匹配工具的完整参数 schema（input_schema），随后即可直接调用。当「MCP 工具索引」中的工具不确定参数时使用。",
  "input_schema": {
    "type": "object",
    "properties": {
      "query":  { "type": "string",  "description": "检索关键词，匹配工具名与描述，不区分大小写；缺省或空串 = 按快照顺序分页列出全部（遍历保底，评审 O10）", "maxLength": 256 },
      "server": { "type": "string",  "description": "可选：仅检索指定 MCP 服务（按名称或 id）" },
      "limit":  { "type": "integer", "description": "最多返回的完整定义数，默认 5，上限 10" }
    }
  }
}
```

执行器 `electron/tools/toolSearchTool.ts`（对齐 skillsReadTool.ts / historyTool.ts 的注册方式）：

- **匹配**：大小写不敏感的子串匹配（query 转义优先 `RegExp.escape`，运行时不可用则手写对非字母数字字符加反斜杠——ES2025 API，vitest 所在 Node 环境可用性实现时确认，评审 O6；不用裸正则，规避 ReDoS）；匹配域为 mappedName / originalName / 服务名 / 描述全文（快照里 ≤4,000 字符的原文，不受索引行 120 字符截断影响）；query 按空格分词后**任一词命中即候选、多词命中排前**（跨语言召回，如中文意图对英文描述）；权重：名字命中 > 描述命中，稳定排序。
- **遍历保底**：空 query 等价于「按快照顺序分页列出全部」，配合 `limit`（默认 5、上限 10）最多 ⌈N/10⌉ 次调用穷尽全池——只要工具在快照里就必然找得到，这是检索召回的最终兜底（§12 R3）。
- **返回**：`{ matches: [{ name, server, description, input_schema }], totalMatches, truncated, usage }`；`usage` 固定提示「上列工具的参数 schema 已下发，下一轮可直接调用；未列出的请继续检索」。**描述按快照原文返回（≤4,000 字符）**——信息量 ≥ 现状广告期口径（3,500 + 前缀），「找到即等同现状」；快照内存中即为原文，无需二次读取。体积策略为**溢出响应**而非固定截断：32 KiB 总预算内按匹配排名逐条装入；溢出时先收缩排名靠后条目的描述、仍不足则停止追加并置 `truncated`（模型可缩小 query / 指定 server 重试）；**`input_schema` 永不截断**；发生描述精简时在 `usage` 中注明。
- **上限定价逻辑（32 KiB）**：上限是**天花板而非填充物**——不触顶时（典型检索返回 5~15 KiB）上限取值逐字节无差别，基线代价为零；代价只在触顶场景出现，且相对更保守取值的收益带宽较窄（如 8 KiB 重条目下仅「恰好需要 4 个」时省一轮追加检索）。取 32 = 2 × 单 schema 上限（16 KiB）的自然步进：保证最坏单工具（16 KiB schema + 4 KiB 描述 = 20 KiB）完整返回且余量翻倍；三次满载检索累计 96 KiB 恰好触平 eager 广告基线，是可接受的上界。校准指标见 §10.2。
- **lane 与开关**：`filterBuiltinToolsForApi` 中比照 toolkit 的桌面 lane 门控（toolsConfigRuntime.ts:91-93）；`isToolEnabledByConfig` 因其进入 builtin 名单而自动获得 allowedTools/deniedTools 过滤。
- **审批**：actionClass `'read'`、无 resourceKeys，走只读自动放行（与 skills.read / history.read 同类）。

### 6.4 兜底执行与观测（v1.6 按 hosted 架构修订）

- 兜底执行：装配期 `computeEffectiveTools` 产出 `deferredToolNames`，随 turn host 依赖传入；`capabilities.define` 将延迟名并入 known + authorized（FR3）。模型直调延迟工具 → capability 检查为 known-authorized → 经每 turn 注册表（`createHostedMcpToolRegistry` 按快照 entries 注册，延迟工具天然在册）分发执行。SDK turn 循环与既有审批链路零改动。
- 观测：本 invoke 内维护 `surfacedNames: Set<string>`（每次 tool_search 成功后并入命中名）；延迟工具执行时若不在集合内，记 `deferredUnsurfaced: true`——**落点为持久化/事件面**：写入 `ToolCallResultPersisted` 与 `tool_result` 事件 payload（对齐仓库 AD10 惯例 `{ ...result, toolName, toolSource }`；落账主通道为 `afterToolResult`（toolChatLoop.ts:786 实现 / L1054 传入）与 `sessionLedgerForToolResult`（invocationAssembler.ts:1038）——`noteToolResultForStats` 现无生产调用方，不作为落点（O11.2）），**不进入发给 provider 的 wire 面工具结果块**（塞入自定义字段有被 provider 拒绝与污染模型上下文 / messageTokens 计量的双重风险）。仅记录，不注入任何纠错提示。
- 模型调用**完全不存在**于快照的工具名：经 SDK 结构化拒绝路径返回（`returnDeniedToolsToModel`，拒绝文案见 FR12②）。

### 6.5 策略计算（computeDeferredPlan）

新增纯函数（放 `electron/effectiveTools.ts` 同文件，便于同处测试）：

```ts
export type DeferredPlan =
  | { mode: 'eager' }
  | { mode: 'deferred'; deferredNames: ReadonlySet<string>; deferredEntries: McpToolSnapshotEntry[] }

export function computeDeferredPlan(args: {
  mcpSnapshot?: McpToolSnapshot
  profiles: McpServerProfile[]
  mode: 'auto' | 'always' | 'off'
  thresholdBytes: number
}): DeferredPlan
```

**准入时序**：装配器先读档位再建快照——`off` 档走现状路径（`buildSnapshotTools` 既有 64/96 KiB 裁剪，逐字节兼容）；`auto`/`always` 档按放宽上限（512 个 / 1 MiB，`buildSnapshotTools` 既有 `maxCount`/`maxTotalBytes` 参数直接传新值）建快照，再算 plan；`auto` 判为 eager 时，在 `computeEffectiveTools` 的广告面组装处执行既有裁剪——**对 descriptor 形态沿用 `trimMcpToolsForBudget`（与 off 档同函数同单位：`JSON.stringify(descriptor)` 口径，保住 10.1.1 逐字节可比；wire 转换 `snapshotEntriesToAnthropicTools` 在裁剪之后）**；预算结果随 `EffectiveTools` 暴露为 `eagerBudgetDropped`（与快照层 `budgetDropped` 命名区分，FR12 双源合并），供落设置页与被拒文案。

**模式冻结（R7 缓解）**：auto 档的 eager/deferred 判定结果按 `contextWindowId` 冻结——同窗口内后续 invoke 沿用首次判定，不因快照体量在阈值附近波动而翻转模式，避免 tools 与 system 同时变化打断前缀缓存；模式翻转只可能发生在新窗口（deferredNames 仍随当前快照重算，跟随工具集变化）。冻结的偏差方向安全：冻结 eager 而快照中途变大 → 走既有裁剪（正确、只是不最优）；冻结 deferred 而变小 → 白付索引 token（无害）。

规则（确定性、每 invoke 一次）：

1. `mode === 'off'` 或快照为空 / remoteContext → eager（现状路径，含既有裁剪与 budgetDropped）。
2. 按 profile 分组快照条目；`profile.alwaysLoad === true` 的服务永远 eager（其条目受 eager 广告预算约束）。
3. 剩余条目：
   - `always` 档：全部 deferred；
   - `auto` 档：**eager ⇔（非覆盖条目总字节 ≤ `thresholdBytes`（默认 16 KiB）且条目数 ≤ 64）**；任一超出 → 全部 deferred（不做单工具级拆分，保证索引/缓存面稳定）。
4. deferred 集合非空才算生效；生效时 tools 数组追加 `tool_search`（eager 时绝不追加，不占广告面）。

放宽准入的依据：进上下文的路径已由索引预算（2% 窗口）与检索返回体预算（32 KiB）接管，96 KiB / 64 个对「本地执行注册表」失去保护对象；白名单成为唯一准入门槛，偏执上限仅防病态 server（§11 D6）。装配开销上界可控：500 工具 ≈ 每次装配解析 ~10 MB JSON（几十毫秒级），快照每 invoke 构建一次、循环内复用（§12 R6）。**建快照后、算 plan 前，先按 FR13 对 entries 逐条试解析 executor 并快照层剔除坏条目**——保证索引、deferredNames、授权面与每 turn 注册表三者天然一致。

### 6.6 与既有机制的交互

| 机制 | 交互与处理 |
|---|---|
| P7 `trim.allow/deny`（effectiveTools.ts:46-54） | trim 语义是「裁剪落工具集」：deferred 条目同样受 trim 约束——deny 命中者从索引与授权面一并剔除；allow 为封闭集合时，仅 allow 内的延迟名保留。实现上把 trim 过滤提到 plan 之后、索引构建之前。**特例（评审 O4）：`tool_search` 自身被裁出广告面**（deniedTools 命中 / allowedTools 封闭集合不含 / trim 剔除）时，延迟计划整体失效、回退 eager 装配（否则索引与 FR7 约定提示指向一个不可调用的工具），经 `logAgentEvent` 记 warn 级事件 `mcp.deferredDegradedToEager`（agentLogger 文件日志，与既有 `tool.error` 同通道；不进 wire 面与会话事件流，评审 O8）。 |
| `buildAvailableToolsHint`（skillPrompt.ts:91-104） | FR7：延迟生效时清单尾部加「另有 N 个 MCP 工具未在此列出，见「MCP 工具索引」或用 tool_search 检索」，消除「仅可调用」与兜底可调用的表述矛盾。 |
| 归因与预算（contextUsageEstimate.ts:82（chars÷3.5 换算，O9）、usageAttribution.ts:194-218） | `toolsTokens` 随 tools 缩小**自动**下降；索引字符计入 systemTokens（三源守恒不破坏）。`summarizeToolDeclarations` 无需识别延迟工具（它们不在 tools 里），新增字段见 FR8。 |
| 事件流落盘去重（runtime/requestHeaderProjection.ts:9，O9） | 无需改动：tools 更稳定使指纹命中率更高；system 含 catalog，服务增减时指纹变化，走既有 elide 逻辑。 |
| 压缩/恢复（recoverBeforeSend 等） | 只作用于 messages 面，与 tools/system 无关，零改动。 |
| 设置页预算展示 | `budgetDropped` 语义不变（仍指执行注册表准入裁剪）；设置页 MCP 区域新增 alwaysLoad 开关（FR6）。 |
| OpenAI 兼容网关 sanitize | `sanitizeAnthropicToolsPayloadForStrictGateways` / compat 名映射只作用于 tools 数组；`tool_search` 无点号、无冲突；catalog 是纯文本不受影响。 |

### 6.7 配置与 UI

- `ToolsConfig`（src/shared/domainTypes.ts:18-30）新增：
  - `mcpDeferredLoading?: 'auto' | 'always' | 'off'`（**代码默认值灰度**：Phase 1–3 交付构建 `'off'`，真机验收通过后单独提交切 `'auto'`——§9 灰度计划；`DEFAULT_TOOLS_CONFIG` 同步）；
  - `mcpDeferredSchemaBudgetBytes?: number`（默认 `16 * 1024`；**auto 档 eager/deferred 判定阈值**——与既有单工具 schema 上限 `MCP_TOOL_SCHEMA_MAX_BYTES = 16 KiB`（mcpTypes.ts:20）数值撞车但含义无关：前者管「全部工具加起来多小就不值得延迟」，后者管「单个工具多大就拒绝」，评审讨论消歧）。
- `McpServerProfile`（src/shared/mcpTypes.ts）新增 `alwaysLoad?: boolean`（缺省跟随全局）。**持久化链路完整覆盖（FR14/评审 B5）**：`McpServerProfileSchema`（mcpTypes.ts:257）+ `McpServerWriteInputSchema`（mcpTypes.ts:341-371，strict）+ `writeInputToProfile`（mcpIpc.ts）+ 渲染端 `mcpDrafts.ts` 草稿模型同步加字段——四处 zod/拷贝层缺一即保存抛错或静默丢字段，typecheck 兜不住。
- 设置页：工具区新增「MCP 工具延迟加载」三档选择；MCP 服务列表每行新增「始终全量加载」开关。文案走 i18n（`config.mcp.deferred*`），zh-CN / en-US 同步；key 统一落 `config` 命名空间（两处开关与 budgetDiagnostics 文案均为 `config.mcp.*`，不复用既有 `mcp.*` 命名空间——评审 O12，i18n:check 查对齐不查归属）。
- **budgetDropped 诊断通路（FR12①，评审 B3）**：设置页打开 / MCP 区域刷新时**按需重算**——`buildSnapshotFromDb(db)` 纯配置 + 缓存、确定性输出、不依赖会话（用户从未发起聊天也有值）；经**扩展既有 `mcp:list` 载荷**新增 `budgetDiagnostics` 字段下发（不新增通道，非目标 6 措辞同步修订）。双源合并口径：`budgetDiagnostics: { source: 'snapshot' | 'eager' | 'executor', mappedName, reason }[]`——`snapshot` 源 = `buildSnapshotTools` 裁剪（off 档既有预算 / 延迟档偏执上限），`eager` 源 = `computeEffectiveTools` 广告面裁剪 `eagerBudgetDropped`（auto-eager / alwaysLoad），`executor` 源 = FR13 注册失败剔除；设置页按 source 分组呈现。

---

## 7. 影响面与兼容

### 7.1 代码改动清单

| 文件 | 改动 |
|---|---|
| `src/shared/builtinToolDefinitions.ts` | push 区新增 `tool_search` 定义；`ALL_BUILTIN_TOOL_NAMES` 收录 |
| `src/shared/domainTypes.ts` | `ToolsConfig` 新增 2 个可选字段 + 默认值 |
| `src/shared/mcpTypes.ts` | `McpServerProfile.alwaysLoad?` 类型 + `McpServerProfileSchema`（mcpTypes.ts:257）+ `McpServerWriteInputSchema`（mcpTypes.ts:341-371，strict）透传（FR14/B5） |
| `electron/mcp/mcpIpc.ts` + 渲染端 `mcpDrafts.ts` | `writeInputToProfile` 白名单拷贝加 `alwaysLoad`；草稿模型加字段（FR14/B5） |
| `src/shared/toolCatalogPrompt.ts`（新建） | `buildMcpToolCatalogSection`、预算截断 |
| `src/shared/promptAssembly.ts` | 无需改（复用 skillCatalogBudget）；llmSystemPrompt.ts 注册 order 45 区块、`buildFinalSystemPrompt` 加可选参数 |
| `src/shared/skillPrompt.ts` | `buildToolCapabilityConventionHint` / `buildAvailableToolsHint` 延迟分支文案 |
| `electron/effectiveTools.ts` | `computeDeferredPlan`、`computeEffectiveTools` 接受 plan 并分离广告面/授权面 |
| `electron/tools/toolSearchTool.ts`（新建） | 执行器 + 注册 |
| `electron/toolsConfigRuntime.ts` | tool_search 桌面 lane 门控（比照 toolkit，L91-93 处） |
| `electron/mcp/mcpToolRegistry.ts` | `buildSnapshotTools`/`buildSnapshotFromDb` 接受准入模式：延迟档传放宽上限（512/1MiB），off 档保持既有值；`budgetDropped` 经 `mcp:list` 载荷扩展的 `budgetDiagnostics` 下发（§6.7，FR12/评审 B3） |
| `electron/mcp/mcpIpc.ts` + `electron/preload.ts` + `src/shared/api.ts` | `mcp:list` 载荷扩展 `budgetDiagnostics` 字段的三个落点（handler / 桥 / 共享类型，FR12①/§6.7，评审 O7；typecheck 可兜住遗漏） |
| `electron/toolChatLoop.ts`（1,079 行适配层） | 装配处调用 `computeDeferredPlan`、产出 `deferredToolNames`、传入 catalog 与 plan；`surfacedNames`/`deferredUnsurfaced` 观测落账；FR8 字段落 turnUsageStats |
| `electron/runtime/hostedAgentTurnHost.ts` | **FR3 落点（评审三轮 A 方案）**：dependencies 增加延迟名入参，`capabilities.define` 并入 known + authorized |
| `electron/runtime/invocationAssembler.ts`（1,320 行） | mcpSnapshot 装配（L526-549）与 hosted 注册表构建（L1123-1128）接线；FR13 注册失败快照层剔除（剔除落 budgetDiagnostics source:'executor' + agentLogger warn） |
| `src/shared/usageAttribution.ts` | turn 维度新增 `deferredToolCount` / `deferredIndexChars`（加性字段） |
| 设置页（Config/） + i18n 资源 | FR6/FR10 的开关与文案；`budgetDiagnostics` 渲染（FR12/§6.7） |
| 渲染端 `toolCallDisplay.ts` | `tool_search` 显示名/图标映射 |

### 7.2 测试改动清单（定向测试，遵守仓库执行策略）

| 测试 | 覆盖 |
|---|---|
| `electron/effectiveTools.deferred.test.ts`（新建） | 三档策略、阈值双条件（字节 + 数量）边界、alwaysLoad 覆盖、授权面含延迟名而广告面不含、产出 `deferredToolNames`（FR3）、trim 交互、**compat 撞名守卫覆盖延迟集（广告面 ∪ 延迟集，O5）**、**off 档与 auto-eager 同输入同裁剪结果（O3）**、**tool_search 被裁出广告面时整体回退 eager（O4）** |
| `electron/tools/toolSearchTool.test.ts`（新建） | 匹配/分词 OR/排序/limit/server 过滤/query 超长/**空 query 分页遍历穷尽**/返回体 32 KiB 溢出响应（描述原文返回、低排名先收缩）/**schema 永不截断**/空结果文案 |
| `electron/toolChatLoop.deferred.test.ts`（新建） | 端到端（mock turn host / hostMcp）：检索→调用往返；跳过检索直接调用被放行且 `deferredUnsurfaced` 落持久化/事件面（AD10）、**发给 provider 的工具结果块不含自定义字段（B4）**；**延迟名 ∈ capabilities known+authorized 且 ∉ request.tools（FR3/A）**；幻觉工具名走 SDK 结构化拒绝；**延迟模式快照层 `budgetDropped` 在偏执上限内恒空（O2）**；**eager 裁剪被拒文案区分（FR12②）**；system 含索引区块（头部计数）与约定 hint；`summarizeToolDeclarations` 无 mcp 行 + deferred 字段正确 |
| `electron/mcp/mcpIpc.persist.test.ts`（并入既有 mcpIpc.test 或新建） | **FR14/B5**：`alwaysLoad` 保存→读回往返（strict 写 schema 放行、读 schema 不剥字段、`writeInputToProfile` 拷贝不丢） |
| `electron/runtime/invocationAssembler.deferred.test.ts`（新建） | **FR13/B6**：快照含 executor 不可解析条目时 invoke 正常完成、坏条目不出现在索引/deferredNames/授权面/注册表、剔除落 budgetDiagnostics('executor') 与 warn 日志——**三档一致（off 含降级偏离用例）** |
| `src/shared/toolCatalogPrompt.test.ts`（新建） | 行格式、预算截断、空集返回 null |
| 既有测试 | `effectiveTools.*`、`toolChatLoop.mcp.*`、`usageAttribution`、`toolsConfigRuntime` 全量保持绿（off 档 = 现状路径） |

### 7.3 兼容性

- **off 档与现状逐字节一致**（10.1.1 基准断言）；auto-eager（字节 ≤16 KiB 且数量 ≤64）行为与现状等价——同一裁剪函数同一 descriptor 口径（评审 O3）。
- **存量超阈值配置升级即翻转（显式声明，评审 B2）**：现状装了 >64 个工具或 >96 KiB 服务的用户（如 GitHub MCP 90+ 工具），今天的行为是「预算裁剪后部分注入、其余静默丢弃」；默认档位切到 auto 后升级即整体进入延迟模式——上下文从「部分工具全量 schema」变为「索引行 + tool_search 检索往返 + 兜底放行」，模型交互路径完全改变。这不是回归而是本方案的目标行为（静默裁剪 → 全池可发现，FR11/D8），但属于用户可见变化，须在发布说明与设置页提示。
- **回退路径**：用户设置 `mcpDeferredLoading: 'off'` 即逐字节回到现状路径（含既有裁剪语义），无需卸载或改 MCP 配置。
- **默认值生效门槛**：默认档位从 off 切 auto 是独立提交，前置条件为 §10.2.1（模型遵循度 ≥80%）与 §10.2.2（节省量化）真机验收通过——R1（模型忽视检索）是尚未真机验证的最大风险，验证前不翻转默认（§9 灰度计划）。
- 会话历史回放、压缩台账、审批审计不受影响（消息面未动）。
- 旧配置缺省字段由 `mergeToolsConfig` 补默认值（灰度期补 `'off'`），无迁移。

---

## 8. 边界与异常

1. **快照为空但延迟档生效**：无延迟条目 → 不生效（plan 为 eager），不注册 tool_search，无空索引区块。
2. **延迟名撞名防护**：mappedName 带 `mcp_` 前缀保证不与内置 / 元工具撞名；延迟名**互不**撞名由字符集 `[a-z0-9_]`（`slugifyMcpName` + hex hash + `deriveUniqueMappedToolName` 全局查重，mcpTypes.ts:437-514——O9）保证 compat 归一为恒等映射，两个保障缺一不可。FR3 改造后撞名守卫（effectiveTools.ts:57-66，构建期 throw）**必须遍历含延迟名的完整集合**（广告面 ∪ 延迟集），不得只查广告面后另行并入——两个延迟名归一为同一 compat 名时静默覆盖，回向解析（toolChatLoop.ts:1053 `resolveRegisteredToolName`——O9）会错工具。
3. **检索无命中**：返回 `matches: []` + 引导文案（建议换关键词或查看工具索引），不算工具失败（不触发 toolErrorRepeat 熔断计数）。
4. **query 超长 / limit 越界**：入参校验钳制（query 截 256，limit 钳到 [1,10]），不作为协议错误抛出。
5. **中途服务断连**：快照在装配期冻结，循环内不重建；断连只影响执行期（现状已有错误路径），索引不做中途增删。
6. **remoteContext / lane 穿透**：远程 IM 会话 plan 恒为 eager 且快照为空（与「偏差 21」一致）；无 tool_search 注入。
7. **事件流去重指纹**：catalog 进 system 后，system 指纹随服务集变化——与现状 tools 指纹变化同频，落盘去重逻辑无需感知。
8. **`alwaysLoad` 服务超过 eager 广告预算**：仍按 64 / 96 KiB 裁剪，被裁者保持现状「三无」语义（不广告/不授权/不可执行），但记入 `budgetDropped` 落设置页、调用被拒文案区分原因（FR12）。
9. **延迟模式下快照层 `budgetDropped` 在偏执上限内恒空**（白名单工具全部入库）——作为验收断言的不变量（10.1.12）；非空即触达偏执上限。广告面层 `eagerBudgetDropped` 按档位可非空（auto-eager / alwaysLoad），两字段命名不得混用（FR12 双源合并呈现）。
10. **tool_search 空 query**：合法语义为「分页列出全部」（FR2 遍历保底），不报错、不触发失败熔断。
11. **`tool_search` 自身被裁出广告面**（allowedTools 封闭集合不含 / deniedTools 命中 / P7 trim 剔除）：延迟计划整体失效、回退 eager 装配，索引区块与约定提示同步省略，记 warn 级日志事件 `mcp.deferredDegradedToEager`（agentLogger，落点见 §6.6，评审 O4/O8）——否则索引与 FR7 提示指向一个不可调用的工具。

---

## 9. 分阶段实施计划

每阶段独立可交付、收尾即提交；阶段内验证用定向测试（`npm exec vitest run <files>`），阶段收尾跑 `npm run build:electron:incremental`，全量 `npm test` 仅最终验收。

### Phase 1：核心机制（默认关闭，零行为变化）

`tool_search` 定义与执行器（含空 query 遍历、分词 OR、返回体溢出响应）、`computeDeferredPlan`（含快照准入放宽与偏执上限、auto 数量条件）、`computeEffectiveTools` 广告/授权面分离、`## MCP 工具索引` 区块（含头部计数）与约定 hint、循环装配接线、surfacedNames 观测。交付构建 `DEFAULT_TOOLS_CONFIG.mcpDeferredLoading = 'off'`（灰度计划起点，评审 B1），全部新测试绿 + 既有定向测试绿；10.1 的 auto/always 档用例以显式配置注入执行，不依赖默认值。

### Phase 2：策略与设置 UI（默认值维持 `off`）

`auto` 阈值计算（字节 + 数量双条件）、`alwaysLoad` 按服务覆盖、设置页两处开关 + `budgetDiagnostics` 渲染（按需重算 + `mcp:list` 载荷扩展 + UI + i18n，FR12/§6.7）、`mergeToolsConfig` 兼容。

### Phase 3：计量与观测

usageAttribution 加性字段、turn 维度落库、节省量日志（对齐 runtime/requestHeaderProjection.ts 的 `elideConstantHeaderFields` 恒定前缀去重风格）、`tool_search` 的 ToolCallCard 展示映射（显示名「工具检索（MCP）」）、调用被拒文案区分（FR12 的 loop 侧改动）、**检索返回体校准埋点**（`truncated` 触发率、因截断引发的追加检索次数、surface 后未调用条目占比——32 KiB 上限的校准依据，§6.3）。

**默认值切换（灰度收尾，评审 B1/B2）**：Phase 1–3 交付构建一律 `mcpDeferredLoading = 'off'`；本阶段收尾且 §10.2.1（模型遵循度 ≥80%）、§10.2.2（节省量化）真机验收通过后，**单独提交**将 `DEFAULT_TOOLS_CONFIG.mcpDeferredLoading` 切为 `'auto'`，发布说明声明存量超阈值配置的行为翻转与 off 回退路径（§7.3）。10.1.1 的逐字节兼容断言始终以 off 档为基准采集。

### Phase 4（可选，另行评审）：原生能力适配与扩展

- 评估 Anthropic Tool Search Tool beta（`defer_loading` + 服务端检索）作为 provider 专属快路径；
- 评估 remote lane 支持。

（原「预算裁剪工具可被索引发现」已随 FR11 提前至 Phase 1 落地；eager 广告面残余裁剪的告知见 FR12。）

---

## 10. 验收标准

### 10.1 可自动化验收（单测）

> auto / always 档用例均以**显式配置注入**执行，与交付构建默认值无关；10.1.1 的逐字节基准在 off 档采集（§9 灰度计划，评审 B1）。

1. `off` 档请求体与现状逐字节一致（序列化对比）。
2. `auto` 档阈值两侧行为正确（16 KiB 上/下各一例）；`always` + `alwaysLoad` 组合正确。
3. 延迟模式下：tools 数组不含任何延迟 mappedName；`authorizedToolNames` 含全部延迟名；`tool_search` 在 tools 数组中。
4. 检索→调用往返：第二次 tool_use 的 name 为延迟工具且执行成功。
5. 跳过检索直接调用：执行成功、`deferredUnsurfaced` 落持久化/事件面（AD10）且发给 provider 的工具结果块不含自定义字段。
6. 索引区块：预算截断生效、截断时有检索提示、空集无区块。
7. 约定 hint 与「仅可调用」清单在延迟模式下表述一致（FR7 断言文案内容）。
8. 归因：toolsTokens 下降、deferredToolCount/deferredIndexChars 正确、三源守恒断言不破。
9. `tool_search` 只读自动放行（无审批卡）；query/limit 钳制；返回体上限。
10. i18n key 对齐（`npm run i18n:check`）。
11. auto 档数量条件：启用工具 >64 个（即使字节 ≤16 KiB）自动转延迟；off 档与 alwaysLoad 路径仍走既有裁剪且裁剪结果正确产出（off 档入快照层 `budgetDropped`，alwaysLoad 入广告面层 `eagerBudgetDropped`，O2）。
12. 延迟模式下快照层 `budgetDropped` 在偏执上限内恒空（不变量断言，O2）；tool_search 空 query 分页遍历可穷尽全部延迟工具；返回体总量 ≤32 KiB 且描述按原文返回（溢出时自低排名收缩）、`input_schema` 永不截断。
13. 索引头部计数「共 N 个工具，已列出前 K 个」与实际截断一致。
14. eager 广告面裁剪导致的调用被拒，错误文案为「预算未注入」口径而非「服务不可用」（FR12）。
15. FR3 门禁簿记（A 方案）：延迟名 ∈ capabilities known 与 authorized、∉ request.tools；模型直调延迟工具走正常分发路径而非拒绝路径（hostedAgentTurnHost.ts capabilities.define）。
16. FR13/B6：快照混入 executor 不可解析条目时 invoke 正常完成（不 throw 穿透）、坏条目不出现在索引/deferredNames/授权面/注册表、剔除落 budgetDiagnostics('executor') 与 warn 日志——**三档一致**；off 档降级偏离的成功请求逐字节断言不受影响（见 FR13）。
17. FR14/B5：`alwaysLoad` 保存→读回往返不抛错、不丢字段（zod 读写两侧 + writeInputToProfile + mcpDrafts）。

### 10.2 需真机/人工验收

1. **模型遵循度**：真实 Claude 会话中，模型在索引存在时是否优先 tool_search、兜底触发率多少（需要真实模型行为，无法单测）——验收口径：≥80% 首选检索，兜底不造成失败会话。
2. **节省量化**：真实 MCP 服务（含大体量 server）下对比三档的每轮 toolsTokens 与会话总输入 token（读 usage 归因面板/日志）。
3. **缓存收益**：连续多轮请求中 cache read 命中率不劣化（事件流 request_header 指纹）。
4. 设置页两处开关的交互与持久化、聊天流中 tool_search 卡片显示、远程 IM 会话无回归。
5. 超预算大体量 server（>64 工具）的索引可读性与检索命中率。
6. **检索返回体校准**：`truncated` 触发率、因截断引发的追加检索次数、surface 后未调用条目占比——三项数据决定 32 KiB 上限是否维持（§6.3 上限定价逻辑；触发率低则维持，重 schema 服务器出现成串追加检索再评估上调）。

> 交付形态说明：Phase 1-3 全部内容可在本环境以单测 + 增量构建完成交付；10.2 各项需真机（真实 API Key、真实 MCP 服务）才能验收，建议 Phase 3 收尾后由用户实测一轮再决定是否进入 Phase 4。默认档位切换（off → auto）以本节第 1/2 项通过为门槛（§9 灰度计划）。

---

## 11. 决策记录

- **D1 索引放 system prompt 而非 tool_search 的 description**：与 skills 目录（order 50）、工具约定 hint 的既有装配方式同构，预算截断逻辑可直接复用；catalog 独立区块也便于指纹去重与计量。Claude Code 将索引放在检索工具描述里，属实现细节差异，机制等价。
- **D2 透明兜底而非强制检索**：授权面解耦后兜底零成本（分发循环无改动），且避免模型偶发跳过检索导致会话失败；Anthropic 原生机制会在未浮现时直接报错，我们选择更宽容的语义，以 `deferredUnsurfaced` 观测遵循度（持久化/事件面，AD10，落点见 §6.4），后续可按数据收紧。
- **D3 内置工具保持 eager**：19 个内置工具 schema 精炼、使用频率高、且 `buildToolCapabilityConventionHint` 等多处依赖 toolNames 精确性；延迟化它们只省约数千字符，却引入额外轮次与文案分支，收益为负。
- **D4 auto 阈值默认 16 KiB**：prompt cache 命中时 eager 的边际成本是 schema tokens × 0.1/请求，而 deferred 固定引入一轮检索往返（延迟 + 小额输入输出）；粗算 16 KiB（≈4.5k tokens）以下 eager 更划算，以上 deferred 显著占优。阈值为配置项，待真机数据校准。
- **D5 只延迟 MCP、不拆单工具粒度**：服务级（整服务 defer 或 not）保证索引与缓存面稳定，规则可解释；工具级混合策略留待观测数据支持后再评。
- **D6 预算职责迁移、不分池（v1.1 修订，替代原「budgetDropped 口径不动」决策）**：延迟模式下进上下文的路径已换成索引预算（2% 窗口）与检索返回体预算（32 KiB）两道新闸门，96 KiB / 64 个对「本地执行注册表」失去保护对象——本地 Map 装千级 schema 也是毫秒级。故快照准入放宽为偏执上限（512 个 / 1 MiB），白名单成唯一门槛，预算只保留在 eager 广告面；索引是截断视图、检索域覆盖全池，「主池/后备池」两段式搜索没有召回收益（substring 在百级工具上均为微秒级），不建池。被静默屏蔽工具的问题在延迟模式下从根上消解（FR11），eager 残余裁剪由 FR12 告知。
- **D7 tool_search 命名保留**：名字的首要读者是模型而非人——Claude 系模型对 tool_search（原生 `tool_search_tool_regex` 系）已有「延迟工具先检索」的行为先验，直接作用于最大风险 R1（遵循度）；域过宽的误解代价是软着陆（域外误调得到引导性空结果，只读、无副作用）。精确性放在四处而非名字里：description 首句限定 MCP 域并指路 toolkit_find、FR7 约定提示、空结果引导文案、UI 显示名「工具检索（MCP）」。
- **D8 auto 档加数量双条件**：仅字节阈值（≤16 KiB）会漏掉「工具多但 schema 小」的配置——64 个 250 字节的小 schema 合计 16 KiB，eager 注入后仍撞 64 个的数量上限发生裁剪。改为「字节与数量任一超出即延迟」后，任何超出 eager 广告容量的配置自动进入延迟模式，静默裁剪在延迟路径上不再产生（与 FR11/FR12 共同闭环）。

---

## 12. 风险与开放问题

| # | 风险/问题 | 缓解 |
|---|---|---|
| R1 | 模型忽视检索、大量走兜底：节省打折且多消耗输出 token | FR7 约定提示 + auto 档只在大快照时启用 + deferredUnsurfaced 观测；遵循度持续低于 80% 时收紧为「未浮现即拒绝并提示检索」（对齐 Anthropic 原生语义）——SDK `returnDeniedToolsToModel` 已具备结构化拒绝通道，收紧（切 B 挡）为小改动 |
| R2 | 检索增加一轮往返，短会话反而变慢 | auto 阈值挡住小快照场景；检索本身是廉价输出（通常一轮内完成） |
| R3 | 索引描述过弱导致检索 miss | 索引行保留服务名 + 描述首行；tool_search 匹配描述全文（≤4,000 原文）而非仅索引行；query 分词 OR 提升跨语言召回；空 query 分页遍历为最终保底（FR2）；观测 miss 率后校准 |
| R4 | 非 Anthropic provider 的 tools 兼容性 | deferred 改动收敛在 effectiveTools 出口与 system 文本，tools 数组仍走既有 sanitize/compat 链路，provider 无关 |
| R5 | 索引与快照不一致（构建时序） | 两者同源于同一装配期快照，纯函数派生，同一 invoke 内不可能漂移；单测断言一致性 |
| R6 | 快照准入放宽后的装配开销：500 工具 ≈ 每次装配解析 ~10 MB JSON（几十毫秒级） | 偏执上限（512 个 / 1 MiB）保持有界；快照每 invoke 构建一次、循环内复用；超上限工具落 `budgetDropped` 可见（FR12） |
| R7 | auto 阈值边缘震荡：快照体量贴着 16 KiB / 64 个阈值时，中途变化使模式在 eager ↔ deferred 间翻转，tools 与 system 同时变化、前缀缓存全灭（≈93 KB 级重写）。评审后核实现实触发面有限：工具缓存纯用户触发式刷新（§2.2 缺口二），无用户操作时 server 侧变化不传导 | **模式按 contextWindow 冻结**（§6.5）：同窗口内首次判定后沿用，翻转只可能发生在新会话；冻结偏差方向安全（冻结 eager 而变大 → 既有裁剪兜底；冻结 deferred 而变小 → 白付索引 token）。未来接线 list_changed 后自动获得保护 |
| R9 | hosted 注册表构建期 throw（v3 评审 B6 已核实为真）：`createHostedMcpToolRegistry`（hostedMcpRegistry.ts:18-19）对快照每个条目 resolveExecutor，失败即抛 `MCP_REGISTERED_EXECUTOR_UNAVAILABLE`，调用点（invocationAssembler.ts:1130-1135）**无 try/catch**——throw 穿透使整个 invoke 失败；延迟档准入 512 个放大暴露面 | 已需求化为 **FR13**：快照层剔除（坏条目不进快照，索引/deferredNames/授权面自然同步）+ budgetDiagnostics('executor') + agentLogger warn；验收断言见 §10.1.16 |
| OQ1 | `tool_search` 命名是否与未来 Anthropic 原生服务端检索工具冲突 | 原生工具由 API 侧注入，名称为 `tool_search_tool_regex` 系，不冲突；Phase 4 适配时再对齐 |
| OQ2 | 是否给检索结果附使用示例（few-shot） | v1 不做；若 R3 观测不佳，在 tool_search 返回的 usage 字段强化引导即可，无 schema 改动 |

---

## 13. 相关文件

- 现状锚点（9f753bc4 基线，v1.7 按 O9 对照表全量刷新）：`electron/effectiveTools.ts`（19-86，未随重构变更）、`electron/toolChatLoop.ts`（786 / 901-907 / 932-941 / 976 / 1053）、`electron/runtime/invocationAssembler.ts`（526-549 / 1038 / 1130-1135）、`electron/runtime/hostedAgentTurnHost.ts`（99-106）、`electron/runtime/requestHeaderProjection.ts`（9）、`electron/runtime/agentSdkDesktopObserver.ts`（168-189）、`packages/agent-sdk/src/turn.ts`（1415-1431 结构化拒绝）、`packages/agent-sdk/src/capability.ts`（12-15）、`electron/mcp/mcpToolRegistry.ts`（56-106 / 164-168 / 224-239：快照类型 / 251-293 / 302）、`electron/mcp/mcpIpc.ts`（216-312）、`src/shared/mcpTypes.ts`（18-21 / 257 / 341-371 / 609-637 / 437-514）、`src/shared/builtinToolDefinitions.ts`、`src/shared/skillPrompt.ts`（5-22 / 107-118）、`src/shared/domainTypes.ts`（18-44）、`src/shared/contextUsageEstimate.ts`（82：chars÷3.5）、`src/shared/usageAttribution.ts`（188-218 / 279-299）、`electron/toolsConfigRuntime.ts`（21-109）
- 关联需求/方案：`docs/requirement/mcp-integration-requirement.md`、`docs/requirement/agent-toolkit-capability-gateway-requirement.md`（toolkit.find/call 两段式先例）、`docs/requirement/context-usage-estimated-occupancy-requirement.md`、`docs/develop/agent-context-token-cost-optimization-plan.md`（P1-3 前缀去重实测来源）
- 外部参照：[MCP 2025-11-25 规范 changelog](https://modelcontextprotocol.io/specification/2025-11-25/changelog)、[2026-07-28 规范 RC 公告](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/)、Claude Code tool-search deferral 与 `alwaysLoad`（agentpatterns.ai）、OpenReview *Schema Discoverability, Not Locality, Drives MCP Cost Savings*

---

## 附录 A：工具面限制体系全貌（数值速查）

按 MCP 工具生命周期排列，标注方案落地后的终态口径（涉及现状的以「现状」注明）：

**① 发现与准入期**（server 返回 → 校验 → 进缓存）

| 约束对象 | 上限 | 超限行为 | 位置 |
|---|---|---|---|
| 原始工具名长度 | ≤256 字符 | 拒绝该工具 | mcpToolRegistry.ts:61 |
| 工具描述 | 截 4,000 字符 | 静默截断后入缓存 | mcpToolRegistry.ts:64 |
| 单工具 inputSchema | ≤16 KiB 且深度 ≤20 | 拒绝该工具 | mcpTypes.ts:20-21，mcpToolRegistry.ts:75-84 |

**② 快照准入期**

| 约束对象 | 现状 | 方案延迟模式 | 超限行为 |
|---|---|---|---|
| 工具数量 | 64 个/轮（mcpTypes.ts:18） | 512 个（偏执上限） | 现状：硬截并记 `budgetDropped`（无消费方，静默，§2.2）；方案：偏执上限裁剪落设置页（FR12） |
| 聚合体积 | 96 KiB/轮（mcpTypes.ts:19） | 1 MiB | 现状：跳过继续装（贪心）；方案：同左 |
| 准入门槛 | 白名单 + 预算 | **白名单唯一** | — |

**③ 广告期（进上下文）**

| 约束对象 | 现状（eager） | 方案延迟模式 |
|---|---|---|
| 描述 | 再截 3,500 字符（mcpToolRegistry.ts:302，无文档自设值 ≈1k token） | 索引行截 120 字符（行最坏 ≈170 字符） |
| 整体 | tools 全量 ≤96 KiB ≈28k token | 索引 ≤min(10k token, 2%×窗口)（200k 窗口可列 ≈82 行）；头部计数「共 N 列 K」 |

**④ 检索期（tool_search）**

| 约束对象 | 上限 | 超限行为 |
|---|---|---|
| query | ≤256 字符；空串 = 分页列出全部 | 钳制 / 合法遍历 |
| limit | 默认 5、上限 10 | 钳制 |
| 描述 | 按快照原文返回（≤4,000 字符，发现期截断为准） | 仅总量溢出时自低排名条目收缩描述，`usage` 注明 |
| 返回体总量 | ≤32 KiB（天花板非填充物：不触顶零代价；校准指标见 §10.2） | 停止追加条目 + `truncated` 标记；`input_schema` 永不截断 |

**⑤ 参照系（同仓库既有限制）**

| 约束对象 | 上限 | 位置 |
|---|---|---|
| skills 目录预算（索引公式来源） | min(10k token, 2%×窗口) | promptAssembly.ts:133-135 |
| skills.read 单次读取 | ≤32,000 字符 | skillsReadTool.ts |
| tools/call 调用参数 | ≤256 KiB、深度 ≤20 | mcpTypes.ts:642-651 |
| token 换算口径 | chars ÷ 3.5 | contextUsageEstimate.ts:82（O9） |

结构性事实：描述各级截断 4,000（发现期/快照/检索匹配/检索返回）→ 3,500（现状广告期）→ 120（索引行）——检索返回回到 4,000 原文，信息量不低于现状广告期；「单点 + 聚合」双层防爆模式贯穿每层（返回体总量兜底、单工具 schema + 快照聚合）；96 KiB、3,500、4,000、2%/10k 均为无文档经验拍板值，校准依赖 Phase 3 真机计量。

---

## 变更记录

| 版本 | 日期 | 说明 |
|---|---|---|
| 1.0 | 2026-10-01 | 初稿 |
| 1.1 | 2026-10-01 | 评审修订：预算职责迁移与快照准入放宽（FR11，替代原非目标 1 与 D6 的「口径不动」）；auto 档加字节+数量双条件（FR5/D8）；tool_search 命名决策（D7）与检索召回补强（分词 OR、空 query 遍历保底、返回体溢出响应——描述原文返回、schema 永不截断，FR2）；新增 FR12（eager 溢出告知：budgetDropped 设置页渲染 + 被拒文案区分）；现状分析补记 budgetDropped 静默缺口、描述三级漏斗与预算常量家族；Phase 1/2/3 范围同步、Phase 4 移除已提前项；新增附录 A 限制体系全貌 |
| 1.2 | 2026-10-01 | 检索返回体总量上限 24→32 KiB（=2× 单 schema 上限的自然步进，三次满载检索累计 96 KiB 触平 eager 基线）；§6.3 补记上限定价逻辑（天花板而非填充物、不触顶零代价、收益带宽分析）；Phase 3 与 §10.2 补校准指标（truncated 触发率、追加检索次数、未调用条目占比） |
| 1.3 | 2026-10-01 | 评审修复（docs/review/20261001-mcp-deferred-tool-loading-requirement-review.md，B1–B4 + O1–O6）：**B1** 默认值灰度计划——Phase 1–3 交付构建默认 off，10.2.1/10.2.2 真机验收通过后单独提交切 auto，10.1.1 以 off 档为基准（FR5/§6.7/§9/§10.1 同步）；**B2** §7.3 补存量超阈值配置升级翻转声明、off 回退路径与默认值生效门槛；**B3** FR12① 数据通路设计（设置页打开按需重算 + 扩展 mcp:list 载荷 budgetDiagnostics + 快照层/广告面层双源合并），非目标 6 修订为「不新增聊天链路 IPC 通道」；**B4** deferredUnsurfaced 落点定为持久化/事件面（AD10 惯例），不进 wire 面；**O1** 现状数字更正（内置工具 19、toolChatLoop 测试 29、mcp 测试 21）；**O2** 双源命名统一（快照层 budgetDropped / 广告面层 eagerBudgetDropped）与恒空不变量精确化；**O3** eager 裁剪沿用 trimMcpToolsForBudget 的 descriptor 口径；**O4** tool_search 被裁出广告面时整体回退 eager（deferredDegradedToEager）；**O5** 撞名守卫须遍历含延迟集、字符集论证补全；**O6** RegExp.escape 运行时可用性注记 |
| 1.4 | 2026-10-01 | 二轮评审观察项：**O7** §7.1 补 `mcp:list` 载荷扩展的三个落点文件（mcpIpc.ts / preload.ts / api.ts）；**O8** D2 残留「metadata」称谓更正为 deferredUnsurfaced（AD10 事件面，§6.4），deferredDegradedToEager 落点指定为 agentLogger warn 事件（`logAgentEvent`，与 `tool.error` 同通道，不进 wire 面与会话事件流） |
| 1.5 | 2026-10-01 | 缓存命中率评审讨论：§2.2 补记既有缺口二（工具缓存纯用户触发式刷新，markToolsStale/list_changed 未接线——server 侧变化不会自动传导）；新增 R7（auto 阈值边缘震荡，降级为预防性风险）与 §6.5 模式按 contextWindow 冻结缓解；§6.7 消歧两个 16 KiB（既有单工具 schema 上限 vs 新设 auto 阈值） |
| 1.6 | 2026-10-01 | 适配 main 架构迁移（tool loop 迁入 packages/agent-sdk hosted turn 模型，基线 9f753bc4；effectiveTools/mcpTypes/builtinToolDefinitions/skillPrompt/promptAssembly/toolsConfigRuntime 未变，机制层全部成立）：§2.1 数据流按新架构重写（invocationAssembler 装配 + SDK turn 循环 + 每 turn hosted 注册表）；**FR3 落点修订（A 方案）**——延迟名并入 capabilities known + authorized 门禁簿记（零上下文成本，authorized ⊆ known 由双栏填写满足），透明兜底语义保留（D2 不变）；FR12②/B4 落点更新（SDK returnDeniedToolsToModel 结构化拒绝 + ToolCallResultPersisted/sessionLedger ports）；新增 R9（hosted 注册表构建期 throw）；现状数字更新（toolChatLoop 测试 12、mcp 测试 23）；全部行号锚点按新基线刷新，§13 标注基线 commit |
| 1.7 | 2026-10-01 | 三轮评审修复（docs/review/20261001-mcp-deferred-tool-loading-requirement-review-v3.md，B5/B6 + O9–O13）：**B5→FR14** alwaysLoad 持久化链路需求化（McpServerProfileSchema:257 / McpServerWriteInputSchema:341-371 strict / writeInputToProfile / mcpDrafts.ts 五处覆盖 + 往返测试与 §10.1.17）；**B6→FR13** 注册失败快照层剔除需求化（hostedMcpRegistry.ts:18-19 throw、调用点无包裹已核实；剔除落 budgetDiagnostics source:'executor' + agentLogger warn，禁止弱剔除；§6.5 时序、§10.1.16 验收、R9 收敛）；**O9** 行号锚点按评审对照表全量刷新（含描述漏斗 L302、换算口径 contextUsageEstimate.ts:82 等表外顺修）；**O10** tool_search query 改可选（缺省/空串 = 分页遍历）；**O11** 六处事实修正（budgetDropped 四处初始化、afterToolResult/sessionLedger 落账主通道、快照构建 lane 措辞、hint compat 名口径、快照类型归属 mcpToolRegistry.ts:224-239、filterBuiltinToolsForApi 所属文件）；**O12** i18n key 统一 config 命名空间；O13 无需改动 |
| 1.8 | 2026-10-01 | 四轮随手收敛：FR12① 锚点刷新残留（230-231 → 236-238）；FR13 剔除从「延迟档」提升为**全档位装配期快照清洗**（崩溃向量与档位无关），显式声明这是 off 档「现状逐字节一致」承诺的唯一有意偏离（现状坏条目 → 整 invoke throw，改为剔除 + 降级继续 + 可观测；10.1.1 以成功请求为口径不受影响），并给出否决「off 档保留 throw」替代项的理由（同坏缓存双失败形态不可解释） |
