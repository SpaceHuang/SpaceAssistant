# 上下文注入重构方案（投影形态 · 三段式 · 渐进披露 Skill · 保留历史）

> 状态：方案（待评审，决策已全部敲定）
> 前置：Agent Loop 单路径重构（已合入）、消息事实落库归 Core（已合入）、会话记录事件流（开发分支中）
> 定位：从研发周期看，**本方案是「会话记录事件流」的后续项目**
>
> **一句话结论**：现在「这次请求送什么」由好几处各拼各的字符串组装，顺序写死、还散落在不同文件；且把**全部激活
> 技能的正文都塞进 system**，导致 system 庞大且随技能路由/恢复而变化（缓存前缀易碎、上下文预算被正文占死）。本次
> 改造为参考 deepseek-harness + codex 的做法：① 把「组装」抽成可插拔装配层、产出协议中立的 `PromptAssembly`，用纯函数
> `renderPrompt` 渲染；② 上下文占用做成一个**折叠会话事件流**的 `ContextMeter` 投影（真实 usage 锚点 + 增量），供 UI 与
> 「放得下吗」决策复用；③ **技能采用渐进披露**：system 只放**有预算的稳定目录**（名字+描述+定位），技能正文不进 system，
> 而是作为 **user 片段 + `skills.read` 工具** 注入。

---

## 0. 依赖链与研发周期

```
Agent Loop 单路径重构 → 消息事实落库归 Core → 会话记录事件流 → 本方案
```

| 前置项目 | 状态 | 给本方案提供什么 |
| --- | --- | --- |
| Agent Loop 单路径重构 | **已合入** | 统一工具循环；`NormalizedDelta`（[anthropicStreamDelta.ts](../../electron/anthropicStreamDelta.ts)） |
| 消息事实落库归 Core | **已合入** | `messageId` 归 Core；`loadAuthoritativeTurnContext`（[claudeStreamHandlers.ts](../../electron/claudeStreamHandlers.ts)）、`reduceAssistantFact`（[assistantFactAggregator.ts](../../src/shared/assistantFactAggregator.ts)）、`TurnIntent`/`TurnTerminal`；消息表由 Core 写 |
| 会话记录事件流 | **开发中（另一台机器，未提交；本地不可验证）** | `events.jsonl` + 事件（`turn/step`、`assistant_chunk`、`request_header`、`request_context`、`request_usage`）+ `computeSessionUsageFromEvents`；**本方案的事件流来源** |

> **前置项目顺序**：**消息事实落库归 Core → 会话记录事件流**；若前置文档表述与此不符，请在前置开发时一并修正。

> **门禁（Gate）——事件流本地不可验证**：本地仓库既无该分支也无相关符号（`SessionEvent` / `events.jsonl` / `computeSessionUsageFromEvents` / `request_*` 均不存在），按「前置在别处开发、尚未提交」处理：
> - **WP0–WP2 不依赖事件流**，可立即开工；
> - **WP3 通过 `ContextInput` 抽象与事件流解耦**（见 WP3）：先用「messages 表 + 现有 usage 路径」实现并验证，事件流落地后切换数据源；
> - **WP4 / WP5 中依赖事件流的部分**（`compaction/*` 事件、`request_context.contextUsage` 槽）**设为门禁项**，待接口可用再接入。
>
> **事件流须提供的接口（门禁清单）**：① `request_header`（system / tools）；② `request_context`（provider / model / contextWindow）；③ `request_usage`（真实 usage）；④ `compaction/start` / `compaction/summary` / `compaction/end`（或等价物）；⑤「模型面 = 事实经阴影投影」语义（用于区分「界面历史」与「模型面」）。

---

## 1. 这次要解决什么

### 1.1 现在的问题

**问题一：「这次送什么」是各拼各的字符串，顺序写死。**

- 基础 system（含记忆）来自 `buildSystemPrompt`（[projectMemory.ts](../../electron/projectMemory.ts)）；
- 图片附件提示 `buildImageAttachmentsSystemHint`（[llmSystemPrompt.ts](../../electron/llmSystemPrompt.ts)）；
- 工具调用约定提示 `buildToolConventionHint`（[llmSystemPrompt.ts](../../electron/llmSystemPrompt.ts)）；
- UI 语言提示 `appendUiLocaleSystemHint`（[llmLocalePrompt.ts](../../src/shared/llmLocalePrompt.ts)）；
- 工具可用性提示 `appendAvailableToolsHint`（[toolChatLoop.ts](../../electron/toolChatLoop.ts)）；
- 技能正文 `buildSystemPromptFromSkills`（[ChatView.tsx](../../src/renderer/components/Chat/ChatView.tsx)）。

它们最后被 `buildFinalSystemPrompt`（[llmSystemPrompt.ts](../../electron/llmSystemPrompt.ts)）用 `\n\n` 硬拼；
顺序、去留、条件全写死；加一段、调顺序、做裁剪都要进这个函数改，且每改一次都可能改变发给模型的文本。

**问题二：协议序列化跟“自己的消息拼装”缠在一起。**

`buildToolChatMessagesFromSource`（[chatMessageBuild.ts](../../electron/chatMessageBuild.ts)）→
`buildClaudeToolChatMessages`（[claudeToolHistory.ts](../../src/shared/claudeToolHistory.ts)）→
`trimClaudeToolChatMessages`（[claudeToolHistory.ts](../../src/shared/claudeToolHistory.ts)）负责把领域消息
映射成 Anthropic 请求块（图片 base64、超长 `tool_result` 压缩、`tool_use`/`tool_result` 配对、按条数裁剪）。
这些「决定送多少、怎么拼」混在协议相关的序列化里。

**问题三：上下文占用只有「事后近似」，没有「可持续 / 可重放的投影」。**

`contextUsageEstimate.ts` 的 `computeContextUsageDisplay` / `projectUsageAfterToolResults` 本质是**事后投影**
（基于已发生 usage + 文本近似），服务 UI 环形图；没有「发送前、随时可读」的占用，不可重放，tokenizer 不可插拔。
只靠 `trimClaudeToolChatMessages` 按条数裁剪，无 token 预算——超窗只能等 API 报错 / 模型退化。

**问题四：技能正文全塞进 system，且随路由/恢复变化。**

- 现状把所有激活技能正文经 `buildSystemPromptFromSkills` 拼进 system，system 庞大、正文占死预算；
- `skillRoute` 每条消息重路由，技能集合一变 system 就变；浏览器依赖恢复（`resolveDependencyRecoverySkill`）还会在
  **循环中途改写 system**（`toolChatLoop`）——这些都是「缓存前缀破坏源」，且让 system 失去「稳定指令」的意义。

**问题五：没有「surface（模型面）」概念，也没有真正的溢出处理。**

- 现在「发给模型的面」**就是事实（messages 表）序列化后的结果**，两者是同一个东西；因此只能「删/截断历史」，
  无法做到「**保留用户历史 + 只压缩模型面**」；
- 溢出时不主动处理，只能等 API 报超窗。

### 1.2 目标

- 三段式：**装配（可插拔、可异步）→ 渲染（纯函数、协议无关）→ 序列化（协议相关）**。
- 每个 prompt 片段都是带 `name` + `order` +（可选）`complete` 的 section；加 / 调顺序 / 裁剪都无需改拼装函数。
- `renderPrompt` 确定性、可重建；`contexts` 与 `sections` 分离，动态运行时上下文渲染成**历史快照**（user-role），不进 system。
- **技能渐进披露**：system 只放**有预算的稳定目录**，技能正文进 **user 片段 + `skills.read` 工具** → 技能变化不碰 system 前缀、不占死预算。
- **缓存友好**：稳定前缀（system+tools+历史）字节稳定；序列化层打 `cache_control` 断点；动态内容（技能正文、运行时快照）放尾部快照。
- **保留历史 + 模型面替换（方案 A）**：事实（messages 表）一条不删；**模型面（surface）** = 「纪要 checkpoint + 真实用户消息 + 最近可见消息」的投影。
- **溢出 = 动作 + 规则表 + 引擎**：压缩机制拆成三个可插拔「动作」（① 精简 / ② 摘要 / ③ 重开），用「规则表」描述条件与顺序，引擎只按表执行；**调整只动规则表**；③ 靠 `history` 工具按需读回。
- `ContextMeter` 投影：折叠会话事件流，返回 `pressureTokens`（真实 usage 锚点）+ `projectedTokens`（增量）、`contextWindow`、
  `breakdown{systemTokens,toolsTokens,messageTokens}`；UI 环形图与「放得下吗」复用同一结果。
- 可插拔 `TokenEstimator`；默认零 IO 近似。

### 1.3 本次不做什么

- 不做完整多协议 Adapter / Transport——只做「分层职责」；不做可插拔多语言 / CLI Host 框架。
- 不把装配层做成中间件 / 插件市场。
- 不做「是否需要 gist 常驻」的**自动语义判断**；选型只走**确定性规则表 + 用户显式选择**（见 WP4）。
- 不重复实现事件流本体（前置项目已做），但**需要在其上补 `compaction/*` 与 surface 阴影语义**。
- 不改 messages 表结构去「删历史」——**事实保留是本方案的硬约束**。

---

## 2. 核心设计决定

| 范围 | 决定 |
| --- | --- |
| 三段式 | 装配（`buildPromptAssembly`，可插拔、可异步）→ 渲染（`renderPrompt`，纯函数、协议无关）→ 序列化（`serialize`，协议相关，留在 Anthropic 侧）。 |
| 装配产物 | 协议中立 `PromptAssembly { sections: PromptSection[]; contexts: ContextSection[]; tools: ToolSchema[]; skillFragments?: SkillFragment[]; variables: Record<string,string\|undefined> }`。 |
| section | `PromptSection { name; order; text: string \| (ctx)=>string; complete? }`；`name` 唯一、重复注册抛错；`complete` 表示整段替代整个 system，多个 active 则装配失败。 |
| 技能目录（system） | System 内一个**具名 section**（`skills:catalog`），内容 = `## Skills` + `### Available skills`（名字+描述+定位+使用规则），**带预算**：`min(配置上限, 上下文窗口 × 2%)`，上限 10000 token，超出截断描述 / 省略条目并给警告。 |
| 技能正文（不进 system） | 选中（本轮路由）技能正文作为 **user 片段**（`<skill>...</skill>`，`content_kind=skills.selected_skill_instructions`）注入**消息尾部**；未选中只留在目录；**新增 `skills.read` 工具**做按需读取（对齐 codex）。 |
| 技能变化 | 路由 / 恢复激活技能**只改尾部 user 片段**，**不重写 system**；`resolveDependencyRecoverySkill` 走「选中技能」user 片段、不写 system。 |
| **技能路由归属** | 技能路由 + 目录/正文组装**全部归 Core**；渲染端只发**原始输入**（用户消息、附件、locale、显式技能选择）；Core 路由后完成装配，路由结果可回传渲染端仅供展示。 |
| 动态上下文 | `contexts` 与 `sections` **分离**，渲染成「当前运行时上下文快照」放入**历史（user-role）**，带固定横幅「This snapshot supersedes earlier runtime-context snapshots.」，**不进 system**。 |
| 工具排序 | **本轮落地确定性默认排序**（字典序 / scope+name 稳定排序，code-unit 比较、locale 无关，保证每台机器一致）；`toolOrder` 配置 + `<unlisted-tools>`（rest 标记）作为后续可选；未知 / 重复名报错。 |
| 工具呈现 | **不在 system 里列表工具名**；能力事实来源仅 `tools` 数组；`run_shell`/`run_script` 区分与「禁用时 fallback」收进工具调用约定 hint。 |
| 渲染 | `renderPrompt(assembly)` 纯函数：插值 `{{variable}}`、丢弃空段、`\n\n` 连接；`renderContextSections` / `renderContextSnapshot` 处理 contexts 快照；`renderSkillFragments` 处理选中技能正文 user 片段。 |
| 装配降级 | 装配 / 渲染抛错时**回退到最小 system**（基础 + 工具约定）并记录日志，**不阻断请求**。 |
| 序列化 | 现有重灌/配对/裁剪收敛为序列化层；显式定义「模型可见面」边界供 meter 计价；**追加 `cache_control` 断点**（system + 最深稳定历史消息）。 |
| 裁剪 | **决定保留多少**归装配 / 规划（依赖 `ContextMeter` 投影）；**wire 格式头部孤儿清理**留序列化层（保证以用户文本开头）。 |
| **surface（模型面）** | **事实（messages 表）全量保留 + 压缩记录 → 派生模型面 = 纪要 checkpoint + 真实用户消息 + 最近可见消息**；事实不删。 |
| **压缩记录（有序列表）** | `compaction` 记录是**有序列表**，每条 `{ id, kind: prune\|summary\|reset, shadowedRange?, checkpointMessageId?, summary?, provider/model?, usage?, windowId? }`；surface = 事实**依次应用**这些记录得到。**支持 K=3 的多段 / 非连续阴影**（单区间表达不了多次摘要）。 |
| **界面显示（方案 A）** | 界面读**事实**：全量历史全部可见；压缩发生时在会话里插入「**已压缩**」纪要气泡/分隔线，标注「以上内容已浓缩成此纪要」。 |
| **压缩策略结构** | **动作 + 规则表 + 引擎**：三个「动作」（① 精简 / ② 摘要 / ③ 重开）实现**同一契约**「模型面 + 上下文 → 新模型面 + 记录」，可任意组合 / 换序 / 跳过；「规则表」= 「什么条件 → 用哪个动作」的有序列表（命中第一条即执行）；「引擎」只按表执行、**不认识具体机制**。 |
| **改动隔离** | 规则表可以是**配置文件或代码**；唯一要求：**调整只动规则表**，引擎与动作都不动。 |
| **默认预设** | `adaptive`：中途只 ①；turn 边界 ① → 按确定性信号选 ②/③。预设就是几份不同的规则表，**试验 = 换预设**。 |
| **触发阈值配置** | 设置项「**自动压缩触发比例**」，**默认空（→ 90%）**，按**百分比**填、**上限 90%**（只能提前、不能推迟）；内部换算：`triggerTokens = min(配置比例, 90%) × 有效窗口`。 |
| **BodyAfterPrefix 前缀定义** | 前缀 = **稳定前缀**（system + tools + 初始上下文）；触发量 = `activeTokens − prefixTokens`（只算前缀之后的新增）。 |
| **①/②/③ 定义** | ① 精简：压缩超长 `tool_result`、丢最旧低价值内容（无损意图）；② 摘要：把最旧一段压成结构化纪要 checkpoint 替换（保近期尾巴 + **真实用户消息**）；③ 重开：模型面重置为「初始上下文 + 精确保留的用户消息 + notes」。 |
| **③ 重开前提** | 开新窗口后旧明细不在模型上下文，**必须配 `history` 工具**（模型专用、只读、按窗口/条目/搜索读回旧消息），否则模型侧真丢。 |
| **选型信号（确定性，无语义判断）** | 只用确定性信号：**时机**（中途只 ①）、**次数**（② 已做 **K=3** 仍超 → ③）、**溢出报错**（→ ③）、**用户命令**（「压缩上下文」=② /「开新上下文」=③）。`mustShed`（需要丢多少）**只作可调旋钮**，不是判据。 |
| **可观测** | 每次决策记录：命中哪条规则 / 前后 token / 模型调用数 —— 供 A/B 对比。 |
| **溢出恢复** | API 返回超窗错误时不直接失败：按规则表压缩一次后**重试**（`maxOverflowRetries` 默认 1）。 |
| 缓存约束 | 稳定前缀（system+tools+断点前历史）必须**字节稳定**：section 提供器必须确定性（无 wall-clock / 随机）；技能正文、运行时快照等动态内容放尾部；`cache_control` 打在稳定历史边界。 |
| ① 与缓存前缀 | **中途 ① 只精简「缓存断点之后」的内容**（当前轮新增的 `tool_result` 等），不重写断点前的稳定前缀，避免破坏前缀缓存。 |
| 上下文占用投影 | `ContextMeter.measure(sessionId)` 返回 `{ pressureTokens; projectedTokens; contextWindow; surfaceTokens; breakdown:{systemTokens;toolsTokens;messageTokens} }`。 |
| 投影口径 | `pressureTokens` = 最近一次真实 usage 的 prompt 总量（**按 provider 的 cache 语义 `subset` / `additive` 判定**：subset 取 input，additive 取 input + cache 读写；不含 output）；`projectedTokens` = `pressureTokens + (当前 surface 估值 − 锚点时刻 surface 估值)`；`breakdown` 用固定密度估算，仅作「组成」。 |
| surface 计价 | **协议中立面** + 复用现有估算原语（`estimateTokensFromImageAttachment`、tool_result 估算），不直接计价 Anthropic 块（避免耦合序列化）。 |
| tokenizer | `TokenEstimator` 接口 + 默认零 IO 近似；远程精确计数（如 Anthropic `count_tokens`）作为可注入插件、非默认。 |
| contextWindow | 读 `request_context.contextWindow`（配置 + provider 上限表），并加 `source` 标记（`config` / `adapter`）。 |
| 与用量统计关系 | usage = 事后事实（`session_usages` / `computeSessionUsageFromEvents`）；占用 = 发送前预判 / 可读投影；数据源、时机、形态不同。 |
| 与事件流关系 | `ContextMeter` 折叠 Plan「会话记录事件流」的事件（`request_header` / `request_usage` / `assistant_chunk` / surface 事件），纯函数投影，mirror `computeSessionUsageFromEvents`；**本方案要求前置补 `compaction/*` 事件**，否则压缩后无法立即反映。 |
| 命名 | 新增投影类型用 `ContextPressureProjection` / `ContextBreakdownProjection`，**避免与现有 `ContextUsageRaw` 撞名**。 |
| 与单路径锚点 | `system` / `tools` 由装配层产出，`request_header` 记录；`request_context.contextUsage` 接收投影结果；渲染端不参与。 |

---

## 3. 改之前的一些事实（对齐当前代码）

- **消息事实已归 Core（已合入）**：`loadAuthoritativeTurnContext`（[claudeStreamHandlers.ts](../../electron/claudeStreamHandlers.ts)）
  加载权威 turn 上下文；`reduceAssistantFact`（[assistantFactAggregator.ts](../../src/shared/assistantFactAggregator.ts)）用
  `AssistantFactEvent` 组装 `Message`；`TurnIntent`/`TurnTerminal`/`TurnExecutionConfig`；`NormalizedDelta` 在 [anthropicStreamDelta.ts](../../electron/anthropicStreamDelta.ts)。
- **当前没有 surface / 压缩阴影 / 事件流**：全库无 `SessionEvent`/`events.jsonl`/`compaction`/surface 实现（事件流在开发分支中）；
  「发给模型的面」目前 = 事实（messages 表）序列化结果；序列化入口仍是 `buildClaudeToolChatMessages`（[claudeToolHistory.ts](../../src/shared/claudeToolHistory.ts)）。
- **真实运行顺序**（跨两处拼装）：外部 `system`（含技能正文，来自 renderer `ChatView.tsx`）→（恢复技能后缀，
  `toolChatLoop`）→ `## 当前可用工具`（**在记忆之前**，`toolChatLoop`）→ `<project_memory>`（`projectMemory.ts`）
  → `## 图片附件`（带图时）→ `## 工具调用约定` → `<ui_locale_preference>`。
- **技能正文目前在 renderer 拼、进 system**（`ChatView.tsx` `buildSystemPromptFromSkills(activeSkills)`），是「组装事实在渲染层」的一例。
- **恢复技能**：`resolveDependencyRecoverySkill`（`src/shared/browserDependencyRecovery.ts`）把 `chromium_missing` 等错误码映射到
  `browser-setup-guide`，激活后 `toolChatLoop` 把正文拼进 system 后缀——**一次 invoke 内 system 改写一次**。
- 消息重灌 / 裁剪：`buildToolChatMessagesFromSource` → `buildClaudeToolChatMessages` → `trimClaudeToolChatMessages`
  （含 base64、超长 `tool_result` 压缩、`tool_use`/`tool_result` 配对、按条数裁剪）。
- 占用估算近似：`contextUsageEstimate.ts` 的 `estimateTokensFromUtf8Text`、`projectUsageAfterToolResults`、
  `computeContextUsageDisplay`、`resolveEffectiveMaximumContext`；usage 管线已能归一化 `cache_read`/`cache_creation`（`anthropicUsageNormalize.ts`）。
- `claudeToolLoopStreamParams.ts` 已支持 `cache_control`（Narrative 在用），但工具主循环 / 纯流式**未传**。
- Plan「会话记录事件流」（**开发分支中、尚未落地**）将提供 `request_header` / `request_context` / `request_usage` / `assistant_chunk` 与
  `computeSessionUsageFromEvents`，并预留 `request_context.contextUsage?` 槽。
- 参考实现：
  - **deepseek-harness**（`F:\Develop\deepseek-harness`）：`PromptSection{name,order,text,complete}`、`renderPrompt`、
    `orderTools`+`toolOrder`+`TOOL_ORDER_REST`、contexts 快照；`packages/llm/token-meter`（固定密度估算、system/tools/messages 分项、
    `ContextPressureProjection` 真实 usage 锚点 + 增量）；`packages/core/agent-loop/src/agent.ts`（`system=renderPrompt(assembly)`、`tools=assembly.tools`）。
  - **codex**（`F:\Develop\codex`）：技能**渐进披露**——`ext/skills/src/catalog_prompt.rs`（`## Skills`/`### Available skills` 目录）、
    `render.rs`（`skill_metadata_budget`，默认上下文窗口 2%、上限 10000 token）、`fragments.rs`（目录 role=developer，
    选中正文 `SkillInstructions` role=user，`<skill>` 标签）、`host_prompt.rs` + `extension.rs`（选中技能正文自动注入 user 片段）、
    `tools/read.rs`/`list.rs`（`skills.read` 按需读）；`core/src/client.rs` 用稳定 `prompt_cache_key`（会话/线程 id）保证缓存前缀稳定。

---

## 4. 工作包

> 每个 WP 拆成能独立验证的提交。每阶段收尾跑定向测试 + `npm run build:electron:incremental`；
> 全量 `npm test` 只在阶段收尾 / 提交前跑（遵循 AGENTS.md 的会话成本纪律）。

### WP0：定义装配层类型与纯函数渲染

**做什么**

1. 定义协议中立类型：`PromptSection{name;order;text;complete?}`、`PromptAssembly`、`TokenEstimator` 接口、
   `ContextPressureProjection`、`ContextBreakdownProjection`、`SkillFragment{name;contents;path}`。
2. 写 `renderPrompt(assembly)` 纯函数：插值 `{{variable}}`、丢弃空段、按 `order` 升序 `\n\n` 连接。
3. 写 `renderContextSections(assembly)` / `renderContextSnapshot(assembly)`（快照横幅 + body）。
4. 写 `renderSkillFragments(assembly)`：将选中技能正文渲染成 `<skill>` user 片段列表。
5. 写 `orderTools(tools, knownNames)`（默认确定性排序）；预留 `toolOrder` + `TOOL_ORDER_REST`（`<unlisted-tools>`）接口但本轮不暴露配置。
6. 写技能目录预算计算：`skillCatalogBudget(contextWindow, maxSkillTokens) = min(upper, window × 2%)`，上限 10000。

**怎么验收**

- `renderPrompt` 表驱动单测：乱序 sections、空数组返回 `''`、`complete` 冲突抛错、`{{variable}}` 非法/未知抛错。
- `orderTools` 单测：默认确定性排序（同样输入两次一致）；`toolOrder` 预留接口单测；`TOOL_ORDER_REST` 保留名拒绝。
- `renderSkillFragments` 单测：选中技能输出 `<skill>` 列表；空输出返回空。
- 纯函数无副作用，同一输入两次输出一致。

### WP1：现有片段迁成 section 提供器 + 技能目录与正文分离 + `skills.read`

**做什么**

1. 把 记忆 / 图片 / 工具约定 / UI 语言 各自拆成 `buildXxxSection(args): PromptSection`，带唯一 `name` + 固定 `order`；
   **按实际顺序给 order**（工具提示在记忆前），先保语义再谈裁剪。
2. **技能改造**：
   - 新增 `buildSkillCatalogSection(skills, budget): PromptSection`：只含名字 + 描述 + 定位 + 使用规则，进 system（`skills:catalog`）；
   - **移除 `buildSystemPromptFromSkills(activeSkills)` 进 system 的路径**；选中技能正文改成 `skillFragments`（user 片段）注入尾部；
   - **新增 `skills.read` 工具**（列出/读取技能正文），对齐 codex 的按需读取；在工具循环注册并接入 skill manager；
   - 恢复技能不写 system 后缀：`resolveDependencyRecoverySkill` 激活后作为「选中技能」走 user 片段。
   - **路由归属**：`window.api.skillRoute`（现由 renderer 触发）改为**由 Core 在装配时调用**；渲染端只发「用户原始输入」；路由结果回传渲染端**仅供展示**（提示用了哪些技能），不参与装配。
3. **把 `## 当前可用工具` 纯文本列表从 system 拿掉**；`run_shell` / `run_script` 区分与「禁用时 fallback」并入工具调用约定 hint；
   工具能力仅由 `tools` 数组表达。
4. 保留原有导出名作兼容入口（如仍导出 `buildFinalSystemPrompt`），内部改走渲染层。

**怎么验收**

- 现有 `llmSystemPrompt.test.ts` 全部通过（语义不变，仅按 order 渲染 + 去工具纯列表）。
- 断言渲染后的 system **不含「## 当前可用工具」纯名字列表、不含激活技能正文**，但仍含 `run_shell`/`run_script` 约定与
  `### Available skills` 目录。
- 新增一个 section 只需加一个提供器，`renderPrompt` 零改动；技能路由 / 恢复激活只改变 `skillFragments`（user 片段）与 `skills.read`，不改 system。

### WP2：序列化层收敛 + 定义「模型可见面」+ 打 cache_control

**做什么**

1. 把 `buildToolChatMessagesFromSource` / `buildClaudeToolChatMessages` / `trimClaudeToolChatMessages` 标记为序列化层，
   明确职责为「领域消息 → Anthropic 请求块 / wire format」。
2. 抽出 `serializePromptAssembly(args)`：输入 `PromptAssembly` + 历史，输出请求消息数组（含把 `skillFragments` 作为 `<skill>` user 消息插入）。
3. 显式定义「**模型可见面**」边界（协议中立，供 meter 计价）：领域 `Message[]` 经过滤（streaming / queued / in-flight tool
   call）+ 配对后得到；图片用分辨率估算、`tool_result` 复用既有估算。
4. **在序列化层加 `cache_control` 断点**：system 打一个，最深稳定历史消息打一个；当前正在生成的轮次露在断点外。
5. **裁剪拆两层**：规划层从 `ContextMeter` 算「这次保留多少」（决定）；序列化层按阈值保留 + 做头部孤儿清理（机械）。

**怎么验收**

- `chatMessageBuild.test.ts` / `claudeToolHistory.test.ts` 全部通过，行为不变。
- 工具主循环 / 纯流式请求体含 `system` / 消息上 `cache_control` 断点；`buildClaudeToolLoopStreamParams.test.ts` 覆盖。
- 序列化层不直接耦合「决定送多少 / 怎么拼 fragments」；「模型可见面」导出供 meter 复用。

### WP3：`ContextMeter` 投影（核心）

**做什么**

1. **输入抽象 `ContextInput`**：`{ system, tools, messages, realUsage, contextWindow }`。`ContextMeter` 只吃它，**不直接依赖事件流**——先用现有数据源（messages 表 + 现有 usage 路径）实现并验证；事件流落地后，换成「折叠 `request_*` / `assistant_chunk` 事件」的实现（**切数据源、不改 meter 接口**）。
2. `computeContextPressure(input)`、`computeContextBreakdown(input)` 纯函数：
   - system / tools → `systemTokens` / `toolsTokens`；realUsage → `pressureTokens`；messages → `surfaceTokens`（协议中立面 + 既有估算）；
   - `projectedTokens = pressureTokens + (surfaceNow − surfaceAtAnchor)`；`contextWindow` + `source`。
   - 事件流落地后，等价的 `computeContextPressureFromEvents(events)` 作为**另一种输入适配器**（与上面同族）。
3. 主进程 `ContextMeter` 服务：按会话维护 O(1) 检查点（真实 usage 锚点 + 最近 surface 估值 + 信封指纹），读时 O(surface) 重定价。
4. `TokenEstimator` 接口 + 默认零 IO 实现；保留远程精确计数注入点（非默认）。
5. **占用口径按 provider 的 cache 语义**：`subset` → 取 `input`；`additive` → 取 `input + cache_read + cache_creation`（复用 `usageCacheSemantics`）；**不盲目相加**，避免双重计数。

**怎么验收**

- 给定 `ContextInput`，`pressureTokens` / `projectedTokens` / `breakdown` 正确；注入伪 `TokenEstimator` 断言走注入实现。
- **不依赖事件流即可验收**（用现有数据源构造 `ContextInput`）；另给「事件流适配器」等价测试（门禁后接）。
- surface 缩小（按条数裁剪 / `tool_result` 压缩 / 技能 user 片段替换）后 `measure()` 立即反映。
- `subset` / `additive` 两种 provider 语义下 `pressureTokens` 都不双重计数。

### WP4：surface 与压缩策略（动作 + 规则表 + 引擎）

**做什么**

1. **surface 投影**：模型面 = 事实（messages 表全量）+ `compaction` 记录（**有序列表**） → 「纪要 checkpoint + **真实用户消息** + 最近可见消息」。**不删任何事实。**
2. **三个「动作」（可插拔、同一契约）**：① 精简 / ② 摘要 / ③ 重开。每个实现同一契约 `transform(模型面, ctx) → { 新模型面, 记录 }`，因此可任意组合 / 换序 / 跳过：
   - ① 精简：prune 超长 `tool_result`、丢最旧低价值内容（免费）；**中途只作用于「缓存断点之后」的内容**，不重写稳定前缀（保护缓存）；
   - ② 摘要：把最旧一段压成结构化纪要 checkpoint 替换（保近期尾巴 + 真实用户消息；要求「纪要更小」「不拆工具配对」「不重放工具」）；
   - ③ 重开：模型面重置为「初始上下文 + 精确保留的用户消息」。
3. **「规则表」（策略）**：有序规则列表，「条件 → 动作」，命中第一条即执行；引擎跑完后重新测量，未达标则继续往下。**唯一要求：调整只动这张表**（配置文件或代码皆可），引擎与动作不动。默认预设 `adaptive`：
   - 中途（工具循环）→ 只 ①；
   - 用户「开新上下文」→ ③；用户「压缩上下文」→ ②；
   - 溢出报错 / ② 已做 K=3 仍超 → ③；
   - 否则超阈值 → ②。
4. **引擎（稳定）**：只按规则表执行，直到达标或规则耗尽；**不认识具体机制**。
5. **预设**：内置若干规则表（`classic` / `reset-first` / `adaptive` …），默认装一份；**试验 = 换预设 / 改规则表**。
6. **触发**：`projectedTokens ≥ min(配置比例, 90%) × 有效窗口`，有效窗口 = `raw × 95%`；配置 = 设置项「自动压缩触发比例」（百分比、默认空→90%、上限 90%）；触发量只算前缀之后（BodyAfterPrefix）。
7. **`history` 工具（③ 的前提，必须同步做）**：模型专用、只读，按 **窗口 / 条目 / 搜索** 读回被压缩掉的旧消息（数据来自 messages 表 + 事件流）。
8. **溢出恢复**：作为规则表里的一条（溢出报错 → 按表压缩一次 + 重试，`maxOverflowRetries` 默认 1）。
9. **可观测**：每次决策记录「命中哪条规则 / 用了哪个动作 / 前后 token / 模型调用数」，供 A/B 对比。
10. **UI 与事件**：界面读事实，显示**全量历史** + 压缩处「**已压缩**」纪要标记；向前置事件流补 `compaction/start|summary|end`（或等价物），让 `ContextMeter` 立即反映。
11. **`notes`（可选、本轮不做）**：Codex 的 notes（跨窗口私有草稿）本轮不引入——③ 只依赖「初始上下文 + 保留下来的用户消息 + `history` 工具」；若要引入，作为**独立子项单列**，不塞进 ③ 的必选路径。

**怎么验收**

- **改动隔离**：新增/调整一条规则、或换一个预设，**只改规则表 / 预设数据**，引擎与动作零改动（测试锁定：换预设前后引擎代码与动作定义不变）。
- 构造超窗会话：事实一条不删；**中途只发生 ①（无模型调用）**；turn 边界超阈值按规则表执行；溢出报错走 ③ 并重试成功；③ 后 `history` 工具能读回被压缩的旧明细；界面仍可看全量历史。
- 断言**没有**「自动语义判断」分支（选型只由时机 / 次数 / 溢出 / 用户命令决定）。

### WP5：给 `request_context` 供数 + UI 收敛

**做什么**

1. 装配 / 投影结果填 `request_context.contextUsage`（本方案**不写 system/tools/usage 事件**，那是 Plan「会话记录事件流」的职责）。
2. UI 环形图读 `ContextMeter.measure()`；`contextUsageEstimate.ts` 离线近似删除或仅保留「输出预留」显示换算。
3. 渲染端只提供原始输入（用户消息、图片、locale、技能选择意图），不参与 tool / system / 技能目录组装决策。

**怎么验收**

- 发一次请求，`request_context` 含 `contextUsage` 与 `contextWindow.source`；环形图与 `measure()` 一致。
- 渲染端发送负载（`payload`）不含 `tools` / `system` / 技能正文等装配产物；`typecheck`（renderer + shared）通过。

---

## 5. 测试策略

- 纯函数表驱动 / 属性测试：`renderPrompt`、`orderTools`、`renderSkillFragments`、`skillCatalogBudget`、
  `computeContextPressure(input)`、`computeContextBreakdown(input)`、`skills.read` 工具。
- 序列化层沿用现有 `chatMessageBuild` / `claudeToolHistory` 测试，不重写；`cache_control` 断点覆盖新增单测。
- `ContextMeter` **用 `ContextInput` 夹具（不依赖事件流）** 断言投影正确性；事件流适配器 `computeContextPressureFromEvents` **门禁后**补等价测试；`TokenEstimator` 可替换测试。
- **cache 语义**：`subset` / `additive` 两种 provider 下 `pressureTokens` 均不双重计数。
- 缓存约束：断言稳定前缀（system / tools / 历史）在「技能路由 / 恢复激活」前后字节一致（snapshot 锁定）；**① 中途只动断点之后内容，断点前前缀字节不变**。
- **装配降级**：注入一个会抛错的 section 提供器，断言装配回退到最小 system 且**请求不被阻断**。
- **压缩策略专项**：断言「事实不删 + surface 替换 + UI 全量可见」；断言**中途只发生 ①（无模型调用，且只动断点之后内容）**、turn 边界按规则表执行（默认预设下 ①→②、② 累计 K=3 后走 ③）；断言**多次摘要产生多条有序 `compaction` 记录、非连续阴影可表达**；断言 ③ 后 `history` 工具能读回旧明细；断言**无自动语义判断分支**；断言**换预设 / 改规则表只改数据、引擎与动作不变**；断言 API 报超窗时按规则表压缩 + 重试。
- 全量 `npm test` 仅在阶段收尾 / 提交前跑。

---

## 6. 风险与残留

| 风险 / 残留 | 影响 | 怎么缓解 |
| --- | --- | --- |
| 迁移 `buildFinalSystemPrompt` 改变提示文本 | 可能影响模型行为 | 步骤拆分、先保「实际顺序」；用现有 `llmSystemPrompt.test.ts` 与快照锁定 |
| 技能正文从 system 移到 user 片段 | 模型对技能的「服从度」可能变弱 | 用 `<skill>` 标记 + 选中技能近在眼前；`alwaysLoad` 技能可留在目录/稳定片段；观察实测 |
| 技能目录有预算 | 目录被截断/省略导致模型看不到某些技能 | 给警告；`maxSkillTokens` 可配置；目录只列名字+描述，量小 |
| `skills.read` 工具新增 | 行为面扩大、需回归 | 作为独立工具接入；单独回归测试（工具循环 skill 读取） |
| 移除「可用工具」纯文本列表 | 可能轻微增加「编造工具名 / 过早调用」 | 观察实测；如确需防呆，用一句极短「仅可调用上方 tools 定义的工具」 |
| `renderPrompt` 顺序与当前硬拼不一致 | 提示文本顺序变化 | WP1 按**实际运行顺序**给 order，先保一致再谈裁剪 |
| 缓存前缀字节不稳定（wall-clock / 随机 / 技能变化） | 缓存命中率下降 | SD「缓存约束」：section 提供器确定性；技能正文/运行时快照走尾部；`cache_control` 打在稳定边界 |
| **① 中途精简破坏缓存前缀** | 后续轮次前缀缓存失效 | ① 只作用于「缓存断点之后」的内容，**不动断点前的稳定前缀** |
| **additive 口径双重计数** | 占用虚高 / 误触发压缩 | 按 provider cache 语义：`subset` 取 `input`、`additive` 取 `input + cache`（复用 `usageCacheSemantics`） |
| **`BodyAfterPrefix` 前缀边界未定义** | 触发线口径不一致 | 定义：前缀 = 稳定前缀（system + tools + 初始上下文）；触发量 = `active − prefix` |
| **`notes` 无工作包归属** | 悬空引用 | 本轮不做；③ 只用「初始上下文 + 保留用户消息 + `history`」；要引入则单列子项 |
| **装配抛错无降级** | 单个 section 出错阻断整条请求 | 装配 / 渲染抛错回退到最小 system + 记录日志 |
| **事件流本地不可验证** | WP3–WP5 被卡住 | 门禁：WP0–WP2 先做；WP3 用 `ContextInput` 与事件流解耦；WP4/WP5 的事件部分按门禁清单接入 |
| **`compaction` 单区间记录装不下多次摘要** | 第二次摘要覆盖第一条 | 压缩记录改为**有序列表**，每条带自身 `kind` / 范围 / checkpoint |
| 投影与真实分块 token 有差 | 占用估算失真 | 明确为「近似」；固定密度 + 真实 usage 锚点已优于纯近似；预留精确 tokenizer |
| surface 计价口径偏离实际发送 | 图片/tool_result 与真实有差 | 用协议中立面 + 既有估算，标注为「组成」非总和 |
| **surface 与事实双轨** | 模型面 ≠ 界面面，可能不一致 | 明确「facts = 界面/搜索/备份；surface = 模型面」；用 `compaction` 记录显式关联 |
| **纪要替换是「有损」** | 旧细节在模型侧丢失 | 纪要结构化（意图/文件/错误/待办/下一步）；事实侧仍全量可查 |
| ② 摘要模型调用（**默认启用**） | 每次到阈值多一次 LLM 调用（延迟 + 花费） | 可配置独立便宜的 summarizer；触发量按 BodyAfterPrefix，减少误触发 |
| **③ 重开依赖 `history` 工具** | 没有 history 工具就真丢模型侧明细 | ③ 与 history 工具**绑定发布**，缺一不可 |
| **①/②/③ 选型无法靠语义判断** | 判断「要不要 gist 常驻」不可行 | 不追求语义判断；用**时机 / 次数(K=3) / 用户命令**三个确定性信号 |
| **规则表 / 引擎 / 动作边界没隔离好** | 想试不同组合仍要改模块 | 固定契约 + 引擎不认识机制；测试锁定「换预设 / 改规则表只改数据」 |
| 事件流需扩展 `compaction/*` | 前置方案未覆盖 | 本方案明确要求前置补上，否则 `ContextMeter` 无法在压缩后反映 |
| 装配层过度设计 | 引入无用抽象 | 只做「section 注册 + order + name + complete」，不做插件市场 / 多协议 |

---

## 7. 已确认（全部决策已敲定）

1. **surface 计价口径**：协议中立面 + 复用既有估算原语（`estimateTokensFromImageAttachment`、tool_result 估算），不直接计价 Anthropic 块。
2. **`request_context` 增加 `contextWindow.source` 标记**（`config` / `adapter`），保留将来接适配器实时播报的余地。
3. **UI 环形图收敛到 `ContextMeter.measure()`**，删除 `contextUsageEstimate.ts` 里的离线近似（或仅保留「输出预留」显示换算）。
4. **技能渐进披露（对齐 codex）**：system 只放有预算的技能目录；技能正文走 **user 片段 + `skills.read` 工具（本轮直接做）**；恢复技能不写 system。
5. **技能目录预算** = `min(配置上限, 上下文窗口 × 2%)`，上限 10000 token（对齐 codex）。
6. **工具排序**：本轮落地**确定性默认排序**（字典序 / scope+name 稳定排序）；`toolOrder` 配置留后续。
7. **裁剪**：**决定保留多少**归装配 / 规划；**wire 格式头部孤儿清理**留序列化层。
8. **缓存约束**：稳定前缀字节稳定；序列化层打 `cache_control` 断点；`ContextMeter` 占用**按 provider cache 语义（`subset` / `additive`）**，不盲目相加。

9. **溢出处理 = 方案 A（保留历史 + 模型面替换）**：事实（messages 表）一条不删；模型面（surface）= 纪要 checkpoint + 真实用户消息 + 最近可见消息；压缩记录为**有序列表**；UI 显示全量历史 + 「已压缩」标记。
10. **压缩 = 动作 + 规则表 + 引擎**：三个动作（① 精简 / ② 摘要 / ③ 重开）实现**同一契约**、可任意组合 / 换序 / 跳过；「规则表」描述「条件 → 动作」；**调整只动规则表**（配置或代码皆可），引擎与动作不动；默认预设 `adaptive`（中途只 ①；边界 ① → 按信号选 ②/③）。
11. **触发阈值**：有效窗口 = `raw × 95%`；触发线 = `min(配置比例, 90%) × 有效窗口`；**配置 = 设置里可选的「自动压缩触发比例」（百分比、默认空→90%、上限 90%，只能提前不能推迟）**；触发量只算前缀之后（BodyAfterPrefix）。
12. **选型只靠确定性信号**：时机（中途只 ①）、次数（② 已做 **K=3** 仍超 → ③）、溢出报错（→ ③）、用户命令（压缩=② / 开新=③）；**不做自动语义判断**；`mustShed` 仅作可调旋钮、非判据。
13. **用户显式命令**：「压缩上下文」= ②；「开新上下文」= ③。
14. **`history` 工具与 ③ 绑定**：③ 重开必须同步提供 `history` 工具（模型专用、只读，按窗口/条目/搜索读回旧明细），否则模型侧真丢。
15. **surface 保留真实用户消息**：②/③ 的模型面都以「真实用户消息原样 + 纪要/初始上下文 + 最近可见消息」构成。
16. **研发周期定位**：本方案是「会话记录事件流」的后续项目；事件流方案需补 `compaction/*` 与 surface 阴影语义。
17. **可观测与预设**：内置若干规则表预设（`classic` / `reset-first` / `adaptive` …），默认一份；每次决策记录命中规则 / 动作 / 前后 token / 模型调用数，供 A/B 对比。
18. **事件流门禁**：事件流在别处开发、本地不可验证 → **WP0–WP2 先做**；**WP3 用 `ContextInput` 抽象与事件流解耦**（先用现有数据源实现 / 验收，落地后切数据源）；WP4/WP5 的事件部分按门禁清单接入。
19. **技能路由归 Core**：`skillRoute` 与目录 / 正文组装全部归 Core；渲染端只发原始输入，路由结果回传**仅供展示**。
20. **压缩记录 = 有序列表**：每条带自身 `kind`（prune / summary / reset）、范围、checkpoint；支持 K=3 的多段、非连续阴影。
21. **`BodyAfterPrefix` 定义 + ① 缓存安全**：前缀 = 稳定前缀（system + tools + 初始上下文），触发量 = `active − prefix`；中途 ① 只动「缓存断点之后」的内容。
22. **装配降级 + notes**：装配 / 渲染抛错回退到最小 system（不阻断请求）；`notes` 本轮不做（③ 只用「初始上下文 + 保留用户消息 + `history`」）。

**待确认**：无（本轮决策已全部敲定）。

---

> 参考：外部设计 `tech-design-v3.md` §6（上下文装配与渲染）、§7.4 / §7.5（流式聚合与 chunk 落盘）、§12.2（崩溃恢复）。
> 同行实现 `F:\Develop\deepseek-harness`：`packages/core/system-prompt`（`PromptSection`/`renderPrompt`/`orderTools`/`toolOrder`/`TOOL_ORDER_REST`/contexts 快照）、
> `packages/llm/token-meter`（`estimate.ts`/`projection.ts`/`index.ts`）、`packages/core/agent-loop/src/agent.ts`（`system=renderPrompt(assembly)`、`tools=assembly.tools`）、
> `packages/compaction/compaction-basic`（`config.ts` `thresholdRatio=0.8`/`retainRatio=0.16`、`region.ts` `selectCompactableRange`、`summarizer.ts` 结构化纪要、`index.ts` 触发与溢出恢复）。
> `F:\Develop\codex`：`ext/skills/src/catalog_prompt.rs`（`## Skills` / `### Available skills` 目录）、`render.rs`（`skill_metadata_budget`，默认 2% 窗口、上限 10000 token）、
> `fragments.rs`（目录 role=developer，选中正文 `SkillInstructions` role=user）、`host_prompt.rs`（选中正文自动注入 user 片段）、
> `tools/read.rs`/`list.rs`（`skills.read` 按需读）、`core/src/client.rs`（稳定 `prompt_cache_key`）。
> 其压缩机制：`core/src/compact.rs`（摘要型：保留最近真实用户消息 + 纪要 + 初始上下文）、`core/src/compact_token_budget.rs`（③ 重开：开新窗口）、
> `core/src/session/context_window.rs`（触发 `min(配置, 90%×window)`、有效窗口 95%、`BodyAfterPrefix`）、`ext/history-notes`（`history`/`notes` 工具按需读旧窗口明细）、
> `history/src/retained_context.rs`（用户原话有界保留）。
