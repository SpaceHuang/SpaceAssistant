# 上下文注入重构方案（投影形态 · 三段式 · 渐进披露 Skill · 保留历史）

> 状态：方案（根据阻断性评审修订，待复审）
> 前置：Agent Loop 单路径重构（已合入）、消息事实落库归 Core（已合入）、会话记录事件流（基础实现已落地，需补本方案契约）
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
| 会话记录事件流 | **基础实现已落地；本地可验证，仍需扩展 schema** | [sessionEvents.ts](../../electron/sessionEvents.ts) 已提供 `events.jsonl`、`SessionEvent`、`request_header` / `request_context` / `request_usage` / `request_retry`、读取/恢复与 `computeSessionUsageFromEvents`；本方案补齐 request 关联、surface 快照、压缩事件和 schema 版本 |

> **前置项目顺序**：**消息事实落库归 Core → 会话记录事件流**；若前置文档表述与此不符，请在前置开发时一并修正。

> **基线与门禁（已按当前仓库重算）**：事件流不是待落地的临时数据源，而是 WP3 起的生产权威适配器。`ContextInput` 只作为协议中立 DTO 和纯函数测试夹具；生产路径必须从同一会话的 `events.jsonl`（并关联 messages 事实表）折叠得到，不新增「messages 表 + 现有 usage」的第二条生产路径。
> - **WP0–WP2** 可立即开工；WP2 的模型面描述需同步落进 `request_header`。
> - **WP3** 先补齐事件 schema，再实现 `computeContextPressureFromEvents(events)`；它构造 `ContextInput` 后调用同一个纯函数，不另写一套 meter。
> - **WP4 / WP5** 的 `compaction_*`、surface 阴影和 `request_context.contextUsage` 是本方案的实现门禁；在这些事件能写入并重放前，不宣称压缩恢复已完成。
>
> **事件流须提供的接口（门禁清单）**：① 同一 `requestId` 的 `request_header`（system / tools / surface 快照）与 `request_context`；② 同一 `requestId` 的 `request_usage`（真实 usage + cache 语义）；③ `compaction_start` / `compaction_summary` / `compaction_end`（或等价物），其中只有校验通过的 `end(status=committed)` 改变 surface；④ 可从事件 + messages 事实重建当前/锚点 surface；⑤ schema 版本、事件顺序和未知版本的降级规则；⑥「模型面 = 事实经阴影投影」语义（用于区分界面历史与模型面）。

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
- **保留历史 + 模型面替换（方案 A）**：事实（messages 表）一条不删；**模型面（surface）** = 「纪要 checkpoint + 必保的当前输入/工具状态 + 预算内历史用户消息 + 最近可见消息」的投影。
- **溢出 = 动作 + 规则表 + 引擎**：压缩机制拆成三个可插拔「动作」（① 精简 / ② 摘要 / ③ 重开），用「规则表」描述条件与顺序，引擎只按表执行；**调整只动规则表**；③ 靠 `history` 工具按需读回。
- `ContextMeter` 投影：折叠会话事件流，返回 `pressureTokens`（真实 usage 锚点）+ `projectedTokens`（增量）、`contextWindow`、
  `breakdown{systemTokens,toolsTokens,messageTokens}`；UI 环形图与「放得下吗」复用同一结果。
- 可插拔 `TokenEstimator`；默认零 IO 近似。

### 1.3 不变量与不可压缩边界

- **事实与模型面分离**：`messages` 事实表和事件流保留完整原文；surface 只保留满足预算的投影。②/③ 中的「保留真实用户消息」特指**最近且通过预算筛选的消息**，不是无界保留全部用户原文。
- **有界保留**：每次生成 surface 都先计算统一预算对象，再从最新消息向前选择**历史**用户消息；`maxRetainedUserMessages` 和 `retainedUserTokens` 只约束历史消息，不约束当前输入。初始默认值偏宽松：最多保留最近 **128 条**历史用户消息，历史用户消息预算为 `bodyBudget × 50%`（兼容字段写作 `inputBudget × 50%`）；两者均可配置，暂不设置更低的硬编码上限，后续根据运行数据调优。超出部分仅由 checkpoint 表示，并可由 `history` 读取。
- **当前输入必保**：`currentUserMessageId` 对应的正文和附件，以及本次请求必需的动态 fragment、工具执行状态，组成不可淘汰的 `requiredSurfaceSet`；先为它们预留空间，再应用历史用户消息配额。按 message id 去重，当前输入在 surface 中必须恰好出现一次，不能因超过 50% 历史配额被排除。
- **单条输入不可压缩**：若 `requiredSurfaceSet` 本身超过 `bodyBudget`（兼容字段 `inputBudget`），发送前返回明确的 `uncompressible_input`，不调用 API、不盲目重试；事实仍落库，UI 提示用户缩短/拆分输入。压缩动作返回 `uncompressible` 时同样停止引擎。
- **动作终止与发送出口**：压缩引擎每轮最多执行 `maxCompactionSteps` 个动作尝试；动作 `no-op` 或没有收益时只记录并跳过当前动作，继续尝试后续规则。动作结果与引擎结果分离：动作仍返回 `applied | no-op | uncompressible`，引擎另返回 `target_reached | fits_without_headroom | exhausted | uncompressible`。只要 `requiredSurfaceSet <= bodyBudget` 且最终完整 surface `<= totalInputBudget`，即使无法达到低于触发线的软停止目标，也必须以 `fits_without_headroom` 结束规划并正常发送；只有必要集合超过 body 硬预算，或最终 surface 仍无法与总输入硬预算 fit，才阻断发送。不得用 no-op 终止引擎，也不得循环重试同一决策。
- **工具恢复安全**：工具执行中的主动压缩只在工具结果已提交的安全边界执行；provider 超窗是更高优先级的应急原因，但重开必须携带当前输入和本轮已完成工具的状态/必要结果，provider 请求可以重试，已完成工具不得自动重跑。
- **锚点有效性**：只有 `request_header`、`request_context`、`request_usage` 通过同一 `requestId` 关联，且 current/anchor 的 provider/model、估算器版本、序列化计价版本和稳定前缀指纹一致时，才计算增量投影并触发自动压缩；否则结果标记为未锚定/失配。未锚定时仍用当前 surface 的保守估算执行独立硬预算检查，但不把近似值伪装成匹配锚点。
- **触发口径唯一**：定义 `rawInputWindow = max(0, providerWindow - outputReserveTokens)`、`effectiveWindow = rawInputWindow × 95%`、`bodyBudget = max(0, effectiveWindow - prefixTokens - safetyReserveTokens)`、`bodyTokens = max(0, projectedTokens - prefixTokens)`；唯一触发条件为 `bodyTokens / bodyBudget ≥ min(configRatio, 90%)`。`projectedTokens / effectiveWindow` 仅用于展示，不得作为另一条触发判据；`bodyBudget = 0` 时返回 `uncompressible_prefix`。
- **预算层级唯一**：`totalInputBudget = max(0, effectiveWindow - safetyReserveTokens)` 表示包含稳定前缀的完整输入上限；`bodyBudget = max(0, totalInputBudget - prefixTokens)` 表示扣除前缀后的 body 上限；现有字段 `inputBudget` 固定等于 `bodyBudget`（仅为兼容命名，不代表完整输入）。统一定义 `hardFit(surface, budget) = surfaceTokens <= totalInputBudget`、`bodyFit(body, budget) = bodyTokens <= bodyBudget`；`requiredTokens`、历史配额和 body 比较 `bodyBudget`（或兼容字段 `inputBudget`），完整 `surfaceTokens` 只能用 `hardFit` 比较 `totalInputBudget`。因此不得执行 `surfaceTokens <= inputBudget` 这种重复扣前缀的检查。
- **决策周期隔离**：每次主动触发、turn boundary、provider overflow 事件或用户显式命令创建一个稳定的 `decisionId`；同一周期内重复 measure/重放使用同一 id，provider overflow 和新命令必须创建新周期。去重策略输入至少包含 `decisionId`、`phase`、`reason`、`ruleVersion`、surface 指纹、预算和窗口配置；不得用主动压缩周期的终局结果抑制 overflow 恢复或显式重开。
- **压缩提交唯一**：每次压缩有唯一 `compactionId`；`compaction_start` 只声明意图，`compaction_summary` 只保存候选结果，只有校验通过且 `status=committed` 的 `compaction_end` 才改变 surface。压缩记录列表只由已提交的 end 折叠得到。
- **动态片段不可变**：已进入 request/surface 的技能正文和运行时快照必须随事件持久化，或引用内容寻址的不可变对象；不能在重放时重新读取可能已变化的 SKILL.md。指纹用于校验，不替代内容。

### 1.4 本次不做什么

- 不做完整多协议 Adapter / Transport——只做「分层职责」；不做可插拔多语言 / CLI Host 框架。
- 不把装配层做成中间件 / 插件市场。
- 不做「是否需要 gist 常驻」的**自动语义判断**；选型只走**确定性规则表 + 用户显式选择**（见 WP4）。
- 不重复实现事件流基础能力（前置项目已做），但**需要在其上补 request 关联、schema 版本、`compaction_*` 与 surface 阴影语义**。
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
| **surface（模型面）** | **事实（messages 表）全量保留 + 压缩记录 → 派生模型面**；模型面由初始上下文、checkpoint、`requiredSurfaceSet`（当前用户输入/必需 fragment/工具状态）和预算内历史消息组成。事实不删，未入 surface 的历史原文由 checkpoint + `history` 表示；当前输入不得被历史配额淘汰。 |
| **压缩记录（有序列表）** | `compaction` 记录是**已提交 end 的有序列表**，状态只能按 `absent → started → summarized → committed` 前进；三类事件共享 `compactionId`：`start{ inputSurfaceFingerprint, targetTokens }`、`summary{ candidate, summaryHash, outputSurfaceFingerprint }`、`end{ status: committed, startSeq, summarySeq, inputSurfaceFingerprint, outputSurfaceFingerprint, summaryHash }`。`summaryHash` 对候选结果的规范化序列化计算。只有 end 的所有引用、顺序、哈希和输入/输出指纹校验通过，surface 才依次应用该记录；`shadowedRanges` 为数组，支持 K=3 的多段/非连续阴影。 |
| **界面显示（方案 A）** | 界面读**事实**：全量历史全部可见；压缩发生时在会话里插入「**已压缩**」纪要气泡/分隔线，标注「以上内容已浓缩成此纪要」。 |
| **压缩策略结构** | **动作 + 规则表 + 引擎**：三个「动作」（① 精简 / ② 摘要 / ③ 重开）实现**同一契约**「模型面 + 上下文 → 新模型面 + 记录」，可任意组合 / 换序 / 跳过；「规则表」= 「什么条件 → 用哪个动作」的有序列表（命中后执行，`no-op` 继续后续规则）；「引擎」只按表执行、**不认识具体机制**。动作状态与引擎规划状态分离：硬 fit 但软目标不可达时返回 `fits_without_headroom`，继续发送。 |
| **改动隔离** | 规则表可以是**配置文件或代码**；唯一要求：**调整只动规则表**，引擎与动作都不动。 |
| **默认预设** | `adaptive`：主动阈值触发在工具循环中只 ①；provider 超窗优先于阶段规则，在工具结果提交的安全边界执行应急 ③；turn 边界同一 `windowId` 内② 已提交累计 K=3 且仍超时，优先走 ③，避免第四次摘要；否则先尝试 ①，`no-op` 仍继续 ②；**turn 边界中 ①/② 已尝试但仍未达到软停止目标时，③ 是默认终局兜底**，不要求 K=3。若必保集合已硬 fit 但软目标仍不可达，③/引擎以 `fits_without_headroom` 收束并正常发送。预设就是几份不同的规则表，**试验 = 换预设**。 |
| **触发阈值配置** | 设置项「**自动压缩触发比例**」，**默认空（→ 90%）**，按**百分比**填、**上限 90%**（只能提前、不能推迟）；比例的分母唯一是 `bodyBudget = max(0, effectiveWindow - prefixTokens - safetyReserveTokens)`。UI 的自动压缩提示也显示同一 `bodyRatio = bodyTokens / bodyBudget`。 |
| **BodyAfterPrefix 前缀定义** | `rawInputWindow = max(0, providerWindow - outputReserveTokens)`；`effectiveWindow = rawInputWindow × 95%`；`prefixTokens` = 稳定前缀（system + tools + 初始上下文）；`bodyTokens = max(0, projectedTokens - prefixTokens)`；唯一触发判据是 `bodyTokens / bodyBudget ≥ min(配置比例, 90%)`。 |
| **统一预算对象** | 请求准备层以实际生效的 `maxTokensEffective` 计算 `outputReserveTokens`；输入输出共享窗口时 `rawInputWindow = max(0, providerWindow - outputReserveTokens)`，否则 `outputReserveTokens = 0` 并记录 `outputAccounting=separate`。`effectiveWindow = rawInputWindow × 95%`；`safetyReserveTokens` 只表示估算余量，不包含 output reserve。完整输入预算为 `totalInputBudget = max(0, effectiveWindow - safetyReserveTokens)`；前缀之后的 `bodyBudget = max(0, totalInputBudget - prefixTokens)`，兼容字段 `inputBudget = bodyBudget`。`requiredTokens` 为当前输入/必需 fragment/工具状态；`historyBudget = max(0, bodyBudget - requiredTokens)`；历史用户配额初始为 `min(bodyBudget × 50%, historyBudget)`。压缩停止目标必须低于触发线，默认 `targetBodyRatio = max(0, triggerRatio - 10 个百分点)`；`triggerRatio`、`targetBodyRatio` 作为预算配置随请求固定。上述字段及最终 `planningStatus` / `decisionFingerprint` 写入 `request_context`。 |
| **①/②/③ 定义** | ① 精简：压缩超长 `tool_result`、丢最旧低价值内容（无损意图）；② 摘要：把最旧一段压成结构化纪要 checkpoint 替换（保留 `requiredSurfaceSet` + 预算内历史用户消息 + 最近尾巴）；③ 重开：模型面重置为「初始上下文 + `requiredSurfaceSet` + 预算内历史用户消息」，并携带 `ToolExecutionCheckpoint`（已完成 toolUseId、参数摘要、状态、必要结果、`replayForbidden=true`），其余由 `history` 读取。 |
| **③ 重开前提** | 开新窗口后旧明细不在模型上下文，**必须配 `history` 工具**（模型专用、只读、按窗口/条目/搜索读回旧消息），否则模型侧真丢。 |
| **选型信号（确定性，无语义判断）** | 只用确定性信号与优先级：**溢出报错**（优先于阶段，在工具结果提交的安全边界执行应急 ③）、**用户命令**（压缩=② / 开新=③，工具执行中排队至安全边界）；无上述高优先级信号时，active tool loop 只允许①，而 turn boundary 先检查同一 `windowId` 的②累计 **K=3**（仍超则③），否则按①→②→终局兜底执行。turn 边界的「①/② 无收益或仍高于软目标」由终局兜底处理，不以 K=3 作为必要条件。`mustShed`（需要丢多少）**只作可调旋钮**，不是判据。 |
| **可观测** | 每次决策记录：命中哪条规则 / 前后 token / 模型调用数 —— 供 A/B 对比。 |
| **溢出恢复** | API 返回超窗错误时不直接失败：按更高优先级的溢出规则，在安全边界执行一次应急压缩（默认 ③，保留 `requiredSurfaceSet` 与 `ToolExecutionCheckpoint`）后**只重试 provider 请求**（`maxOverflowRetries` 默认 1）；不重新执行已完成工具；若仍有 in-flight 工具则先暂停并等待其结果提交，不发送恢复请求。 |
| 缓存约束 | 稳定前缀（system+tools+断点前历史）必须**字节稳定**：section 提供器必须确定性（无 wall-clock / 随机）；技能正文、运行时快照等动态内容放尾部；`cache_control` 打在稳定历史边界。 |
| ① 与缓存前缀 | **中途 ① 只精简「缓存断点之后」的内容**（当前轮新增的 `tool_result` 等），不重写断点前的稳定前缀，避免破坏前缀缓存。 |
| 上下文占用投影 | `ContextMeter.measure(sessionId)` 返回 `{ pressureTokens: number \| null; projectedTokens: number \| null; anchorStatus; contextWindow; surfaceTokens; breakdown:{systemTokens;toolsTokens;messageTokens} }`；未锚定时保留当前 surface 组成，但不输出可触发自动决策的 projected 值。 |
| 投影口径 | `pressureTokens` = 最近一次真实 usage 的 prompt 总量（**按 provider 的 cache 语义 `subset` / `additive` 判定**：subset 取 input，additive 取 input + cache 读写；不含 output）；`projectedTokens` = `pressureTokens + (当前 surface 估值 − 锚点时刻 surface 估值)`；`breakdown` 用固定密度估算，仅作「组成」。 |
| **投影输入与锚点** | `ContextInput` 必须包含 `currentSurface` 与可选 `anchor`：`{ requestId, surfaceSnapshot, surfaceTokens, systemFingerprint, toolsFingerprint, contextWindow, realUsage }`。`anchor.realUsage` 只能来自同一 `requestId` 的 `request_usage`；`surfaceSnapshot` 至少包含 message/fragment id、每段估值、`surfaceTokens`、稳定前缀指纹和 `schemaVersion`，可由事件 + messages 事实重建。公式中的 `surfaceAtAnchor` 直接取 `anchor.surfaceTokens`，不得依赖未持久化的进程内检查点。 |
| **投影失配处理** | 无 anchor、`requestId` 不匹配、anchor 无 usage、schema 不支持、或 system/tools 稳定前缀指纹变化时，返回 `anchorStatus`（`missing` / `mismatch` / `prefix-changed` / `invalid`）和可选的当前 surface 近似；`projectedTokens` 置空，自动压缩不触发，直至下一次完整请求形成新锚点。 |
| surface 计价 | **协议中立面** + 复用现有估算原语（`estimateTokensFromImageAttachment`、tool_result 估算），不直接计价 Anthropic 块（避免耦合序列化）。 |
| tokenizer | `TokenEstimator` 接口 + 默认零 IO 近似；远程精确计数（如 Anthropic `count_tokens`）作为可注入插件、非默认。 |
| contextWindow | 读 `request_context.contextWindow`（配置 + provider 上限表），并加 `source` 标记（`config` / `adapter`）。 |
| 与用量统计关系 | usage = 事后事实（`session_usages` / `computeSessionUsageFromEvents`）；占用 = 发送前预判 / 可读投影；数据源、时机、形态不同。 |
| 与事件流关系 | `ContextMeter` 以当前仓库的 `sessionEvents.ts` 为权威适配器，折叠同一 `requestId` 的 `request_header` / `request_context` / `request_usage`、surface 快照和 `compaction_*` 事件；适配器只构造 `ContextInput`，投影仍由纯函数完成。`computeSessionUsageFromEvents` 继续只负责事后用量，不能替代占用投影。 |
| 命名 | 新增投影类型用 `ContextPressureProjection` / `ContextBreakdownProjection`，**避免与现有 `ContextUsageRaw` 撞名**。 |
| 与单路径锚点 | `system` / `tools` 由装配层产出，`request_header` 记录；`request_context.contextUsage` 接收投影结果；渲染端不参与。 |
| **事件契约** | `requestId` 按一次 provider 请求尝试定义；同一次尝试的 `request_header`、`request_context`、`request_usage` 必须使用同一值，重试使用新 `requestId` 并记录 `parentRequestId`。`request_header` 记录协议中立 surface 快照/指纹、`requiredSurfaceSet`、`ToolExecutionCheckpoint` 和 `schemaVersion`，动态 fragment 随快照持久化或引用不可变对象；`request_context` 记录 `contextWindow`、`contextUsage`、完整预算对象、`planningStatus`、`decisionId`、`phase`、`reason`、`ruleVersion` 和 `decisionFingerprint`，`request_usage` 记录真实 usage 与 cache 语义。压缩写入有序 `compaction_start|compaction_summary|compaction_end`，三者共享 `compactionId`；`end(status=committed)` 是唯一提交点，必须引用 start/summary 的 seq、输入/输出 surface 指纹和摘要哈希。`end` 作为 critical 事件单行提交；未完整落盘的 end 不存在，不得改变 surface。**只有最终规划和序列化 preflight 通过后，才能为本次 provider 尝试写 `request_header`；surface 发生变化必须使用新快照/新 `requestId`，不得复用旧 header。** |

---

## 3. 改之前的一些事实（对齐当前代码）

- **消息事实已归 Core（已合入）**：`loadAuthoritativeTurnContext`（[claudeStreamHandlers.ts](../../electron/claudeStreamHandlers.ts)）
  加载权威 turn 上下文；`reduceAssistantFact`（[assistantFactAggregator.ts](../../src/shared/assistantFactAggregator.ts)）用
  `AssistantFactEvent` 组装 `Message`；`TurnIntent`/`TurnTerminal`/`TurnExecutionConfig`；`NormalizedDelta` 在 [anthropicStreamDelta.ts](../../electron/anthropicStreamDelta.ts)。
- **当前已有事件流基础实现，但没有 surface / 压缩阴影**：[sessionEvents.ts](../../electron/sessionEvents.ts) 已定义并持久化 `SessionEvent`，已有
  `request_header` / `request_context` / `request_usage` / `request_retry` 和 `computeSessionUsageFromEvents`；尚缺请求统一 `requestId`、模型面快照、压缩事件和 schema 版本。
  「发给模型的面」目前仍 = 事实（messages 表）序列化结果；序列化入口仍是 `buildClaudeToolChatMessages`（[claudeToolHistory.ts](../../src/shared/claudeToolHistory.ts)）。
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
- Plan「会话记录事件流」已落地的基础字段包括 `request_header` / `request_context` / `request_usage` / `assistant_chunk`；当前实现中
  `request_header` 尚未带 `requestId`，`request_context.contextWindow` 仍可能为空，且尚无 `contextUsage`、surface 快照、压缩事件和版本字段。
  本方案需与该计划同步扩展 schema，不另建事件写入器或第二事实源。
- 参考实现：
  - **deepseek-harness**（`F:\Develop\deepseek-harness`）：`PromptSection{name,order,text,complete}`、`renderPrompt`、
    `orderTools`+`toolOrder`+`TOOL_ORDER_REST`、contexts 快照；`packages/llm/token-meter`（固定密度估算、system/tools/messages 分项、
    `ContextPressureProjection` 真实 usage 锚点 + 增量）；`packages/core/agent-loop/src/agent.ts`（`system=renderPrompt(assembly)`、`tools=assembly.tools`）。
  - **codex**（`F:\Develop\codex`）：技能**渐进披露**——`ext/skills/src/catalog_prompt.rs`（`## Skills`/`### Available skills` 目录）、
    `render.rs`（`skill_metadata_budget`，默认上下文窗口 2%、上限 10000 token）、`fragments.rs`（目录 role=developer，
    选中正文 `SkillInstructions` role=user，`<skill>` 标签）、`host_prompt.rs` + `extension.rs`（选中技能正文自动注入 user 片段）、
    `tools/read.rs`/`list.rs`（`skills.read` 按需读）；`core/src/client.rs` 用稳定 `prompt_cache_key`（会话/线程 id）保证缓存前缀稳定。

### 3.1 事件流 gap analysis（以当前代码为基线）

| 能力 | 当前基线 | 本方案需要扩展 | 门禁/兼容要求 |
| --- | --- | --- | --- |
| 事件落盘与重放 | `SessionEventWriter`、`events.jsonl`、索引、尾部恢复已存在 | 无 | 保持 append-only、`seq` 单调；缓存只能是可重建索引 |
| 请求头与上下文 | `request_header` 已有 system/tools；`request_context` 已有 provider/model，但 `contextWindow` 可能为空 | 两者补 `schemaVersion`、同一 `requestId`；header 增加协议中立 `surfaceSnapshot`，context 填窗口与投影 | 三件套必须按 `requestId` 关联，禁止按时间取最近 usage |
| 请求用量 | `request_usage` 已有 requestId/usage/source；已有 cache 字段归一化 | 固定 cache 语义字段/版本校验 | 只把同一 request 的 usage 作为 anchor；保留现有用量重算语义 |
| 模型面重建 | 当前只能从 messages 表得到序列化面 | 保存 surface id、message/fragment ids、分段估值、稳定前缀指纹和 schema 版本 | 事件 + messages 必须能重放 current/anchor surface |
| 压缩阴影 | 尚无 `compaction_*` | 增加 `compaction_start` / `compaction_summary` / `compaction_end`，记录 `compactionId`、输入/输出 surface、shadowedRanges、checkpoint、目标/实际 token、摘要哈希和结果 | 仅校验通过的 `end(status=committed)` 生效；end 使用 critical 单行提交；缺失/截断/乱序/冲突组不生效且可诊断 |
| 进程恢复 | 已有事件尾部恢复和 turn/step 补闭 | 将压缩记录与 surface 投影纳入重放 | 重启前后投影一致；完整性降级时禁止自动压缩 |

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
   - **新增 `skills.read` 工具**（列出/读取技能正文），对齐 codex 的按需读取；在工具循环注册并接入 skill manager；只接受技能注册表标识，不接受任意路径，并限制单条/单次返回预算；
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

1. **先扩展现有事件 schema，再接入 meter**：不创建临时事件源。对 [sessionEvents.ts](../../electron/sessionEvents.ts) 的既有事件补 `schemaVersion`；让 `request_header`、`request_context`、`request_usage` 共享 `requestId`；为 `request_header` 增加协议中立 `surfaceSnapshot`（含 `surfaceTokens`、message/fragment ids、分段估值、稳定前缀指纹），并持久化动态 fragment 内容或不可变内容寻址引用；为 `request_context` 填入真实 `contextWindow`、实际 `maxTokensEffective`、`outputReserveTokens`、`outputAccounting`、完整预算对象、`planningStatus`、`decisionId`、`phase`、`reason`、`ruleVersion`、`decisionFingerprint` 与 `contextUsage`。
2. **输入抽象 `ContextInput`**：纯函数 DTO 至少为：
   ```ts
   type ContextInput = {
     currentSurface: SurfaceSnapshot
     anchor?: {
       requestId: string
       surfaceTokens: number
       surfaceFingerprint: string
       systemFingerprint: string
       toolsFingerprint: string
       provider: string
       model: string
       estimatorVersion: string
       serializationVersion: string
       realUsage: ProviderUsage
       contextWindow: ContextWindow
     }
     budget: {
       totalInputBudget: number
       bodyBudget: number
       inputBudget: number
       prefixTokens: number
       requiredTokens: number
       outputReserveTokens: number
       safetyReserveTokens: number
       triggerRatio: number
       targetBodyRatio: number
       estimatorVersion: string
       serializationVersion: string
     }
     decision: {
       decisionId: string
       phase: 'tool_loop' | 'turn_boundary' | 'recovery'
       reason: 'proactive' | 'provider_overflow' | 'user_compact' | 'user_reset'
       ruleVersion: string
     }
     contextWindow: ContextWindow
   }
   ```
   `currentSurface` 与 `anchor` 均可从同一会话的事件 + messages 事实表重建；`anchor.surfaceTokens` 就是公式中的
   `surfaceAtAnchor`。不得依赖未持久化的进程内检查点，也不得用「最近一次 usage」猜测锚点。
3. `computeContextPressure(input)`、`computeContextBreakdown(input)` 纯函数：
   - current surface → `surfaceTokens` 及 `systemTokens` / `toolsTokens` / `messageTokens`；
   - anchor usage → `pressureTokens`；`projectedTokens = pressureTokens + (currentSurfaceTokens − anchor.surfaceTokens)`；
   - 预算输出同时包含 `totalInputBudget`、`bodyBudget`、`hardFit` 和 `bodyFit`；`hardFit` 只比较完整 `surfaceTokens` 与 `totalInputBudget`，`bodyFit` 只比较 body 与 `bodyBudget`；
   - 无 anchor、requestId/指纹/schema/provider/model/版本失配或窗口变化 → `anchorStatus` 非 `matched`、`projectedTokens: null`，不得用近似值触发自动压缩；但用当前 surface 保守估算执行独立硬预算检查，决定发送、压缩或暂停；
   - `pressureTokens` 按 provider cache 语义计算，不含 output；`contextWindow` 同时返回 `source`。
4. 实现唯一的生产适配器 `computeContextPressureFromEvents(events, messages)`：按 `seq` 折叠 request 事件、surface 快照和压缩记录，选取**同一 requestId** 的 header/context/usage 组成 anchor，再调用上述纯函数。进程重启后从 `events.jsonl` 重放应得到相同投影；动态 fragment 从事件中的不可变内容恢复并校验指纹；`computeSessionUsageFromEvents` 仍只服务事后用量统计。
5. 主进程 `ContextMeter` 服务只缓存可丢的加速索引；缓存失效、重启或事件完整性降级时重新重放，不能改变结果。读时可 O(surface) 重定价，但不产生第二事实源。
6. `TokenEstimator` 接口 + 默认零 IO 实现；保留远程精确计数注入点（非默认）。
7. **占用口径按 provider 的 cache 语义**：`subset` → 取 `input`；`additive` → 取 `input + cache_read + cache_creation`（复用 `usageCacheSemantics`）；**不盲目相加**，避免双重计数。

**怎么验收**

- 给定带 `anchorRequestId` 等价信息的 `ContextInput`，`pressureTokens` / `projectedTokens` / `breakdown` 正确；注入伪 `TokenEstimator` 断言走注入实现。
- 事件适配器与 DTO 纯函数给出相同结果；同一 `requestId` 的 header/context/usage 才能形成锚点，跨请求拼接必须返回 `mismatch`。
- 覆盖：无 anchor、usage 缺失、requestId 不一致、system/tools 在锚点后变化、provider/model 变化、估算器/序列化版本变化、未知 schema、事件尾部恢复、进程重启后完整重放；这些情况都不得用近似值错误触发自动压缩，但必须执行硬预算 fit 检查。
- 覆盖实际 `maxTokensEffective` 被抬高、非零初始上下文、必要集合刚好可容纳/差一个 token，以及达到压缩停止目标后不立即再次触发。
- 请求后修改/删除 SKILL.md，再重启重放，断言旧 request 的动态 fragment 内容、估值和 surface 不变。
- surface 缩小（按条数裁剪 / `tool_result` 压缩 / 技能 user 片段替换）后 `measure()` 立即反映。
- `subset` / `additive` 两种 provider 语义下 `pressureTokens` 都不双重计数。

### WP4：surface 与压缩策略（动作 + 规则表 + 引擎）

**做什么**

1. **surface 投影**：模型面 = 事实（messages 表全量）+ `compaction` 记录（**有序列表**） → 「初始上下文 + checkpoint + `requiredSurfaceSet` + 预算内历史用户消息 + 最近可见消息」。**不删任何事实。**每次投影先计算统一预算对象：`totalInputBudget = max(0, effectiveWindow - safetyReserveTokens)`、`bodyBudget = max(0, totalInputBudget - prefixTokens)`、兼容字段 `inputBudget = bodyBudget`，先放入 `requiredSurfaceSet`（`currentUserMessageId` 对应的正文/附件、必需 fragment、工具执行状态），剩余 `historyBudget = max(0, bodyBudget - requiredTokens)` 再从最新历史消息向前选择；历史初始默认最多保留最近 **128 条**、最多占 `bodyBudget × 50%`，实际受 token/N/剩余预算三者较小值限制。当前输入按 message id 去重且必须出现一次，未选中的历史原文只保留在 facts，并由 checkpoint/`history` 关联。
2. **三个「动作」（可插拔、同一契约）**：① 精简 / ② 摘要 / ③ 重开。每个实现同一契约 `transform(surface, ctx) → { surface, record, status }`，其中动作 `status` 为 `applied | no-op | uncompressible`，不把“是否已可发送”混入动作状态，因此可任意组合 / 换序 / 跳过：
   - ① 精简：prune 超长 `tool_result`、丢最旧低价值内容（免费）；**中途只作用于「缓存断点之后」的内容**，不重写稳定前缀（保护缓存）；
   - ② 摘要：把最旧一段压成结构化纪要 checkpoint 替换（保留 `requiredSurfaceSet` + 预算内历史用户消息 + 近期尾巴；要求「纪要更小」「不拆工具配对」「不重放工具」）；
   - ③ 重开：模型面重置为「初始上下文 + `requiredSurfaceSet` + 预算内历史用户消息」，并为被阴影的范围建立 `history` 索引；本轮已完成工具状态必须随 surface 一起保留，未完成工具则返回暂停状态，不发送可能导致重复执行的恢复请求。
   - 任一动作若发现 `requiredSurfaceSet` 本身超过 `bodyBudget`（兼容字段 `inputBudget`），返回 `uncompressible`，不再调用其他动作；`currentUserMessageId` 在其他必要内容可容纳时不受历史 50% 配额影响。
3. **「规则表」（策略）**：有序规则列表，「条件 → 动作」，命中后执行；动作返回 `no-op` 或没有收益时跳过当前规则，继续往下；引擎重新测量，未达标则继续。**唯一要求：调整只动这张表**（配置文件或代码皆可），引擎与动作不动。默认预设 `adaptive` 固定为以下顺序；规则的 `phase=turn_boundary` 明确排除 active tool loop：

   | 优先级 | 阶段 / 原因 | 前置结果 / 条件 | 动作与终局 |
   | --- | --- | --- | --- |
   | 0 | 任意阶段 / `provider_overflow` | provider 报超窗；若有 in-flight 工具则等待结果提交 | 安全边界应急 ③；只重试 provider 请求 |
   | 1 | 任意阶段 / 用户“开新上下文” | 用户显式命令；工具执行中排队到安全边界 | ③ |
   | 2 | 任意阶段 / 用户“压缩上下文” | 用户显式命令；工具执行中排队到安全边界 | ② |
   | 3 | `tool_loop` / 主动 `shouldCompact` | 非溢出、无待处理用户命令 | 只尝试①；无论 ① 是否 `no-op`，本次 active loop 都不升级到②/③ |
   | 4 | `turn_boundary` / 摘要次数 | 同一 `windowId` 内② 已提交累计 K=3，且仍 `shouldCompact` | 优先③，避免第四次摘要 |
   | 5 | `turn_boundary` / 主动 `shouldCompact` | 本轮尚未尝试动作 | 先尝试①；达到软目标则 `target_reached` 并发送 |
   | 6 | `turn_boundary` / 继续压缩 | ① `no-op`/无收益，或①有收益但仍高于软停止目标 | 尝试②；达到软目标则 `target_reached` 并发送 |
   | 7 | `turn_boundary` / **终局兜底** | 本轮①/②均已尝试，或②有收益但仍高于软停止目标；不要求 K=3 | ③；若硬 fit 但软目标不可达，由引擎返回 `fits_without_headroom` 并发送 |
   | 8 | 其他 `shouldCompact` | 未命中上述更高优先级规则 | ② |

   `summaryCount` 只统计 committed end，按 `windowId` 持久化，新窗口重置。规则表的条件只使用阶段、溢出、用户命令、`shouldCompact`、动作结果和次数，不引入自动语义判断。
4. **引擎（稳定）**：只按规则表执行，**不认识具体机制**；每个动作在单次决策内最多尝试一次，`no-op`/无收益只推进规则指针并继续后续动作。每次动作后重新测量，并按以下顺序收束：
   - `requiredTokens > bodyBudget`（即兼容字段 `inputBudget`）→ `uncompressible` / `uncompressible_input`，阻断发送；
   - 当前 surface 已达到 `targetBodyRatio` → `target_reached`，正常发送；
   - 规则链仍可继续 → 继续尝试，不因 `no-op` 终止；
   - 规则耗尽、达到 `maxCompactionSteps` 或所有动作均无进展时，若当前完整 surface 已硬 fit（`surfaceTokens <= totalInputBudget`），即使 body 仍高于软停止目标也返回 `fits_without_headroom`，正常发送一次；若仍未硬 fit，才返回 `exhausted` 并阻断发送。
   动作 `status` 与上述引擎规划结果分离；`summaryCount` 以已提交的 `compaction_end` 为准，作用域为 `windowId`，新窗口重置。规则表、UI 和实际发送前检查都只能调用同一个纯函数 `shouldCompact(projection, config)`，不得各自重算阈值。为每个触发事件/显式命令/turn boundary 创建一次 `decisionId`，同周期的重复检查使用同一 id；`decisionFingerprint = hash(decisionId, phase, reason, ruleVersion, surfaceFingerprint, totalInputBudget, bodyBudget, triggerRatio, targetBodyRatio, windowId)`。已得出终局状态后只对同一完整策略输入去重；provider overflow 和新的显式命令必须使用新的 `decisionId`，不得复用主动压缩的终局结果。
5. **预设**：内置若干规则表（`classic` / `reset-first` / `adaptive` …），默认装一份；**试验 = 换预设 / 改规则表**。
6. **触发**：唯一函数 `shouldCompact` 使用 `rawInputWindow = max(0, providerWindow - outputReserveTokens)`、`effectiveWindow = rawInputWindow × 95%`、`bodyBudget = max(0, effectiveWindow - prefixTokens - safetyReserveTokens)`、`bodyTokens = max(0, projectedTokens - prefixTokens)`；当 `bodyBudget > 0` 且 `bodyTokens / bodyBudget ≥ min(configRatio, 90%)` 时触发。配置为设置项「自动压缩触发比例」（百分比、默认空→90%、上限 90%）；`projectedTokens / effectiveWindow` 仅用于 UI 总量展示，不参与规则匹配；`projectedTokens=null` 时不触发，但仍执行独立硬预算检查。
7. **`history` 工具（③ 的前提，必须同步做）**：模型专用、只读，绑定当前授权会话，按 **窗口 / 条目 / 搜索** 读回被压缩掉的旧消息（数据来自 messages 表 + 事件流）；条目 id 必须校验会话归属，分页、单条长度和单次返回 token 均有上限。
8. **溢出恢复**：溢出规则优先于“中途只①”；在工具结果已提交的安全边界，用③重建模型面，携带 `requiredSurfaceSet` 和已完成工具状态后只重试 provider 请求（`maxOverflowRetries` 默认 1），不重新执行已完成工具。
9. **可观测**：每次决策记录「命中哪条规则 / 用了哪个动作 / 前后 token / 模型调用数」，供 A/B 对比。
10. **UI 与事件**：界面读事实，显示**全量历史** + 压缩处「**已压缩**」纪要标记；向现有事件流补 `compaction_start|compaction_summary|compaction_end`（或等价物），让 `ContextMeter` 立即反映。三类事件共享 `compactionId`：`start` 记录输入 surface/目标预算，`summary` 记录包含 `requiredSurfaceSet`、`ToolExecutionCheckpoint`、候选 checkpoint、保留消息、shadowedRanges、输出 surface 和 `summaryHash`，`end` 以 `status=committed` 携带完整提交清单；只有 end 成功 append 并通过校验才改变 surface。终局为 `fits_without_headroom` 时也必须先完成同样的发送前 surface 校验，不得把“未达到软目标”当成压缩失败。
11. **压缩事件提交与恢复**：`compaction_end` 使用现有事件 sink 的 critical/flush 提交路径作为提交点；下一次 provider 请求必须在 end 提交成功后才允许发出。重放器只折叠拥有同一 `compactionId`、合法 `seq` 顺序、唯一 start/summary、匹配输入/输出指纹及摘要哈希的 committed end。缺 end、缺引用、重复冲突、乱序、未知 id、输入指纹过期、torn tail 或未知 schema 的事件组一律不生效并返回可诊断状态；重复的完全相同 committed end 幂等忽略，不再次调用摘要模型。
12. **最终发送前置校验**：所有正常发送出口（`target_reached`、`fits_without_headroom` 和无压缩直发）统一重新序列化并校验：`requiredSurfaceSet` 中每个 id 恰好一次；当前用户消息正文/附件完整；`tool_use` / `tool_result` 配对完整且顺序合法；实际发送 surface 的 fingerprint 与本次 `request_header` 快照一致；最终完整输入的统一估算 `estimatedTotalInputTokens` 不超过 `totalInputBudget`。内容完整性/指纹是精确校验；token 检查记录 `tokenCheckSource`（默认 `default_estimator`，可选 `exact_provider`），不能把默认近似估算宣称为精确计数。任一校验失败则回到规划层重新计算或返回可诊断的阻断状态，禁止带着缺失/重复状态发出请求；若近似检查通过但 provider 仍报超窗，继续走有限的 overflow 恢复。
13. **`notes`（可选、本轮不做）**：Codex 的 notes（跨窗口私有草稿）本轮不引入——③ 只依赖「初始上下文 + 保留下来的用户消息 + `history` 工具」；若要引入，作为**独立子项单列**，不塞进 ③ 的必选路径。

**怎么验收**

- **改动隔离**：新增/调整一条规则、或换一个预设，**只改规则表 / 预设数据**；用行为测试锁定同一引擎/动作契约仍能执行不同规则表，不把某个预设分支硬编码进引擎。
- 构造超窗会话：事实一条不删；**中途主动触发只发生 ①（无模型调用）**；turn 边界按唯一 `shouldCompact` 判据与规则表执行；provider 溢出即使发生在工具循环中也走高优先级应急 ③，并在安全边界重试成功；③ 后 `history` 工具能读回被压缩的旧明细；界面仍可看全量历史。
- 覆盖「当前输入分别占 body `inputBudget` 的 49% / 51% / 90% / 101%」：前三种在其余必要内容可容纳时，当前输入和附件均完整发送且恰好出现一次，不受历史 50% 配额影响；最后一种发送前返回 `uncompressible_input`。另覆盖「仅历史用户消息累计超过窗口」：按默认 **128 条 / `bodyBudget × 50%`** 双重上限保留历史消息，旧消息进入 checkpoint/history，最终 surface 达到目标预算。
- 覆盖① `no-op` 后②成功、①/②均无收益后③成功、全表 `no-op` 有限终止；覆盖 `summaryCount` 按 `windowId` 的递增、重置与重放恢复。结果必须是明确状态而不是死循环或静默丢消息。
- **覆盖硬预算与软目标分离**：构造 `requiredSurfaceSet` 占 body `inputBudget` 的 79% / 80% / 89% / 90% / 99% / 101%，并分别设置触发线 90%、软停止目标 80%；前五种即使无法达到软目标，也必须以 `fits_without_headroom`（或 `target_reached`）进入正常发送，101% 必须返回 `uncompressible_input` 且不调用 API。另测前缀占 `effectiveWindow` 30% 时 `prefixTokens=3000`、`requiredBodyTokens=6500`、`totalInputBudget=10000`、`bodyBudget=inputBudget=7000` 的反例：完整 surface 9500 应通过硬 fit，不得按 `9500 <= 7000` 误拒绝。另测①/②有收益但仍高于软目标时仍命中 turn boundary 的③兜底；active tool loop 不得匹配该兜底。
- **最终发送前置校验**：人为制造 required id 重复/缺失、tool 配对缺失、实际 surface 与 `request_header` 快照指纹不一致、最终序列化后的 `estimatedTotalInputTokens` 超 `totalInputBudget`，均不得发送；修正后只发送一次，且 required id 恰好出现一次。断言默认近似检查记录 `tokenCheckSource=default_estimator`，不要求默认路径调用远程精确 tokenizer。
- **决策去重边界**：同一 `decisionId` / phase / reason / ruleVersion / surface / 预算的重复 measure 或事件重放不得再次调用摘要模型；主动压缩以 `fits_without_headroom` 终结后，随后 provider overflow 必须创建新 `decisionId` 并命中应急③；用户随后显式“开新上下文”也必须创建新周期并生效，且 overflow 重试仍受 `maxOverflowRetries` 限制。
- 覆盖一个有副作用工具已成功、下一次 provider 请求超窗的场景：工具只执行一次，③ 的 `ToolExecutionCheckpoint` 可见已完成状态，恢复只重试 provider 请求，不重跑工具；in-flight 工具则暂停而不发送恢复请求。
- 覆盖前缀占有效窗口 **0% / 30% / 80%** 的边界：在 `safetyReserveTokens=0`、比例=90%的固定夹具中，body 触发量分别为有效窗口的 90% / 63% / 18%，总量触发量分别为 90% / 93% / 98%；UI 百分比、规则匹配和发送前触发必须调用同一 `shouldCompact` 结果，不允许出现第二套分母。另用合法较低触发比例（至少 10% 与 5%）验证 `targetBodyRatio=0` 等边界仍能在硬 fit 时走 `fits_without_headroom`，不会无限压缩。
- 对 `compaction_start`、`compaction_summary`、`compaction_end` 每个截断点重放；覆盖重复/冲突 end、未知 `compactionId`、输入指纹过期、torn tail，以及“已提交压缩但尚未发出下一次请求”，证明 surface 唯一且摘要模型不会被重复调用。
- 断言**没有**「自动语义判断」分支（选型只由时机 / 次数 / 溢出 / 用户命令决定）。

### WP5：给 `request_context` 供数 + UI 收敛

**做什么**

1. 复用现有事件 sink，不新增写入器：按「压缩提交/规划完成 → 最终序列化 preflight → 写本次尝试的 `request_header` → 写同一 `requestId` 的 `request_context` → provider 发送」顺序执行；`request_header` 带 `schemaVersion`、system/tools 和最终 surface 快照，随后写带同一 `requestId`、`contextWindow`、`maxTokensEffective`、`outputReserveTokens`、完整预算对象、`planningStatus`、`decisionId`、`phase`、`reason`、`ruleVersion`、`decisionFingerprint` 和 `contextUsage` 的 `request_context`；请求结束沿用既有 `request_usage`。压缩动作追加有序 `compaction_*` 事件，surface 变化后不得复用旧 request header。
2. UI 环形图读 `ContextMeter.measure()`；`contextUsageEstimate.ts` 离线近似删除或仅保留「输出预留」显示换算。
3. 渲染端只提供原始输入（用户消息、图片、locale、技能选择意图），不参与 tool / system / 技能目录组装决策。

**怎么验收**

- 发一次请求，三类 request 事件共享 `requestId`，`request_context` 含 `contextUsage`、`contextWindow.source`、实际 `maxTokensEffective` 和完整预算对象，重放事件得到的结果与环形图/`measure()` 一致。
- 渲染端发送负载（`payload`）不含 `tools` / `system` / 技能正文等装配产物；`typecheck`（renderer + shared）通过。

---

## 5. 测试策略

- 纯函数表驱动 / 属性测试：`renderPrompt`、`orderTools`、`renderSkillFragments`、`skillCatalogBudget`、
  `computeContextPressure(input)`、`computeContextBreakdown(input)`、`skills.read` 工具。
- 序列化层沿用现有 `chatMessageBuild` / `claudeToolHistory` 测试，不重写；`cache_control` 断点覆盖新增单测。
- `ContextMeter` 用 `ContextInput` 夹具断言纯函数；生产适配器 `computeContextPressureFromEvents` 用真实事件夹具断言等价，不能以 messages/usage 直读路径替代；`TokenEstimator` 可替换测试。
- **cache 语义**：`subset` / `additive` 两种 provider 下 `pressureTokens` 均不双重计数。
- **锚点与重放**：同一 `requestId` 的 header/context/usage 才能计算 `projectedTokens`；无锚点、失配、前缀变化、schema 未知、事件尾部恢复和进程重启重放均有明确 `anchorStatus`，且不误触发压缩。
- **预算与当前输入**：覆盖当前输入占 body `inputBudget` 的 49% / 51% / 90% / 101%、实际输出预留变化、非零初始上下文、`requiredSurfaceSet` 刚好可容纳/差一个 token；当前输入完整且恰好出现一次。另覆盖 required set 为 79% / 80% / 89% / 90% / 99% / 101% 且软目标为 80% 的情况：前五种允许 `fits_without_headroom` 正常发送，101% 只返回 `uncompressible_input`；加入前缀 3000 + required body 6500 + total budget 10000 的完整 surface 9500 反例，必须正常通过。
- 缓存约束：断言稳定前缀（system / tools / 历史）在「技能路由 / 恢复激活」前后字节一致（snapshot 锁定）；**① 中途只动断点之后内容，断点前前缀字节不变**。
- **装配降级**：注入一个会抛错的 section 提供器，断言装配回退到最小 system 且**请求不被阻断**。
- **压缩策略专项**：断言「事实不删 + surface 替换 + UI 全量可见」；断言**主动中途只发生 ①（无模型调用，且只动断点之后内容）**、turn 边界按唯一 `shouldCompact` 判据与正式 `adaptive` 规则表执行（① `no-op` 后继续②、①/②均无收益或②仍高于软目标后走③，K=3 是 turn boundary 的跨决策优先规则但不是③终局兜底的必要条件）；断言**多次摘要产生多条按 committed end 折叠的有序 `compaction` 记录、非连续阴影可表达**；断言 ③ 后 `history` 工具能读回旧明细；断言**当前输入必保、历史消息受 token/N 双重上限约束**；断言「仅历史用户消息超窗」最终可达目标预算；断言「单条用户输入超预算」返回 `uncompressible_input` 且不调用 API；断言**硬 fit 但软目标不可达返回 `fits_without_headroom` 并正常发送**；断言无进展/规则耗尽在硬 fit 时发送、硬 overflow 时阻断；断言**无自动语义判断分支**；断言**换预设 / 改规则表只改数据，行为测试验证引擎与动作契约不变**；断言 API 报超窗时按规则表压缩 + 重试且不会无限重试。
- **工具恢复专项**：构造有副作用工具已成功、下一次 provider 请求超窗的场景，断言溢出规则优先于“中途只①”，③ 保留 `ToolExecutionCheckpoint`，工具只执行一次；provider 请求重试与工具重新执行必须是两个独立状态机；in-flight 工具只能暂停，不能自动重跑。
- **压缩事件专项**：对 `start` 后、`summary` 后、`end` 前和 `end` 已提交后分别截断 `events.jsonl` 重放；只有完整且校验通过的 `end(status=committed)` 改变 surface。覆盖重复/冲突 end、未知 `compactionId`、输入指纹过期、乱序和 torn tail；断言重放唯一、已提交压缩可在下一次请求前恢复、摘要模型不会被重复调用。
- **读取边界**：`history` 跨会话条目、分页、单条/单次返回超限均拒绝；`skills.read` 的任意路径、未注册标识和超预算返回均拒绝。
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
| **`BodyAfterPrefix` 前缀边界未定义** | 触发线口径不一致 | 唯一使用 `rawInputWindow = max(0, providerWindow - outputReserve)`、`effectiveWindow = rawInputWindow × 95%`、`bodyBudget = max(0, effectiveWindow - prefix - safetyReserve)`、`bodyRatio = max(0, projected - prefix) / bodyBudget`；UI、规则表和发送前检查共用 `shouldCompact` |
| **`notes` 无工作包归属** | 悬空引用 | 本轮不做；③ 只用「初始上下文 + 保留用户消息 + `history`」；要引入则单列子项 |
| **装配抛错无降级** | 单个 section 出错阻断整条请求 | 装配 / 渲染抛错回退到最小 system + 记录日志 |
| **事件流 schema 尚未覆盖 surface/压缩** | WP3–WP5 投影可能读到不完整事实 | 以现有 `sessionEvents.ts` 为唯一生产入口；先补 `requestId`、surface 快照、schema 版本和 `compaction_*`，再开放自动压缩；DTO 仅用于纯函数测试，不作为临时生产源 |
| **`compaction` 单区间记录装不下多次摘要** | 第二次摘要覆盖第一条 | 压缩记录改为**按 committed end 折叠的有序列表**，每条带自身 `compactionId` / `kind` / 范围 / checkpoint；start/summary 半成品不改变 surface |
| **`compaction_*` 非原子提交** | 崩溃后可能把候选摘要误当成已生效，或重复执行摘要 | 三阶段共享 `compactionId`；只有包含完整提交清单的 `end(status=committed)` 是提交点，使用 critical 单行落盘；重放校验引用、seq、哈希和指纹，半成品/冲突组不生效且幂等 |
| 投影与真实分块 token 有差 | 占用估算失真 | 明确为「近似」；固定密度 + 真实 usage 锚点已优于纯近似；预留精确 tokenizer |
| surface 计价口径偏离实际发送 | 图片/tool_result 与真实有差 | 用协议中立面 + 既有估算，标注为「组成」非总和 |
| **surface 与事实双轨** | 模型面 ≠ 界面面，可能不一致 | 明确「facts = 界面/搜索/备份；surface = 模型面」；用 `compaction` 记录显式关联 |
| **纪要替换是「有损」** | 旧细节在模型侧丢失 | 纪要结构化（意图/文件/错误/待办/下一步）；事实侧仍全量可查 |
| ② 摘要模型调用（**默认启用**） | 每次到阈值多一次 LLM 调用（延迟 + 花费） | 可配置独立便宜的 summarizer；唯一触发量按 `bodyRatio` 计算，减少口径漂移 |
| **③ 重开依赖 `history` 工具** | 没有 history 工具就真丢模型侧明细 | ③ 与 history 工具**绑定发布**，缺一不可 |
| **用户消息本身超过窗口** | ②/③ 无法释放足够空间，重试必然失败 | 当前输入属于不可淘汰的 `requiredSurfaceSet`，历史消息初始默认保留最近 128 条、最多占 `bodyBudget × 50%`（兼容字段 `inputBudget × 50%`），并允许后续按运行数据调优；单条输入预检失败返回 `uncompressible_input`，不调用 API、不重试，事实仍保留 |
| **必保输入硬 fit 但软目标不可达** | 若把“未达到软目标”误报为失败，会阻断本可发送的请求；若继续重复压缩，会造成死循环/额外调用 | 将动作状态与引擎规划状态分离；硬 fit 比较完整 surface 与 `totalInputBudget`，软目标只是 body 优化目标；规则耗尽或③无收益时返回 `fits_without_headroom`，按决策周期持久化 `decisionFingerprint`，同一策略输入不重复决策 |
| **①/②无收益后缺少③兜底** | turn 边界可能停在原 surface，摘要次数未达到 K=3 时无法重开 | `adaptive` 正式规则表增加 turn boundary 终局规则：①/②均已尝试或②仍高于软目标即执行③；该规则仅匹配 `turn_boundary`，不升级 active tool loop |
| **完整 surface 与 body 预算混用** | 完整 surface 被拿去和已扣前缀的 body 预算比较，重复扣除 prefix，误拒绝本可发送的请求 | 明确 `totalInputBudget`（含 prefix）与 `bodyBudget`（不含 prefix）；required/history 只和 body 比较，完整 surface 只和 total 比较；最终 preflight 使用同一 `hardFit` |
| **输入输出共享窗口/初始上下文/输出参数变化** | 压缩目标可能仍放不下实际请求，或刚压完立即再次触发 | 请求准备层以实际 `maxTokensEffective` 计算 `outputReserveTokens`；统一记录 `inputBudget`、`requiredTokens`、`safetyReserveTokens` 和低于触发线的停止目标；覆盖非零初始上下文与输出参数抬高 |
| **当前输入没有有效锚点** | 旧 usage 不可复用，可能误以为一定能发送或错误触发压缩 | `projectedTokens=null` 时不触发自动压缩，但用当前 surface 保守估算执行独立硬预算检查，决定发送、压缩或暂停 |
| **动态 fragment 被文件修改** | 重放时模型看到的技能/快照内容与原请求不一致 | 随事件持久化 fragment 内容或内容寻址不可变引用，指纹用于校验；重放不重新读取可变 SKILL.md |
| **锚点丢失或跨请求串联** | `projectedTokens` 错估，误触发/漏触发压缩 | request 三件套共享 `requestId`；持久化 surface 快照和前缀指纹；失配返回 `anchorStatus`，禁止自动决策；重启从事件重放 |
| **①/②/③ 选型无法靠语义判断** | 判断「要不要 gist 常驻」不可行 | 不追求语义判断；用**时机 / 次数(K=3) / 用户命令**三个确定性信号 |
| **规则表 / 引擎 / 动作边界没隔离好** | 想试不同组合仍要改模块 | 固定动作契约与独立引擎结果；引擎不认识机制，用同一引擎执行多套规则表做行为测试；`no-op` 只推进规则指针，不阻断后续动作；发送出口统一由硬 fit / 最终序列化校验决定 |
| **规划后的实际发送面发生漂移** | required id 重复/缺失、工具配对破坏或快照与 wire 不一致，导致恢复状态丢失或重复执行 | 所有发送出口执行最终 preflight：required set 恰好一次、当前输入完整、工具配对合法、surface fingerprint 与 `request_header` 一致；完整 surface 的 `estimatedTotalInputTokens` 与 `totalInputBudget` 比较并记录 `tokenCheckSource`；失败则回规划层或阻断，不发送 |
| **决策去重吞掉恢复/显式命令** | 主动压缩已终局后，provider overflow 或用户重开因复用相同指纹而不再执行 | `decisionId` 按触发事件/命令/turn boundary 创建且不随 measure 变化；指纹包含 `decisionId`、phase、reason、ruleVersion；overflow/新命令开启新周期，overflow 仍受 `maxOverflowRetries` 限制 |
| 事件流需扩展 surface 与 `compaction_*` | 前置基础实现尚未覆盖 | 与事件流计划同步扩展 `schemaVersion`、request 关联、surface 快照/阴影和 `compaction_*`；只认 committed end，其他阶段不改变 surface；在事件可重放前不宣称压缩后投影可用 |
| 装配层过度设计 | 引入无用抽象 | 只做「section 注册 + order + name + complete」，不做插件市场 / 多协议 |

---

## 7. 已确认（本次修订后的决策）

1. **surface 计价口径**：协议中立面 + 复用既有估算原语（`estimateTokensFromImageAttachment`、tool_result 估算），不直接计价 Anthropic 块。
2. **`request_context` 增加 `contextWindow.source` 标记**（`config` / `adapter`），保留将来接适配器实时播报的余地。
3. **UI 环形图收敛到 `ContextMeter.measure()`**，删除 `contextUsageEstimate.ts` 里的离线近似（或仅保留「输出预留」显示换算）。
4. **技能渐进披露（对齐 codex）**：system 只放有预算的技能目录；技能正文走 **user 片段 + `skills.read` 工具（本轮直接做）**；恢复技能不写 system。
5. **技能目录预算** = `min(配置上限, 上下文窗口 × 2%)`，上限 10000 token（对齐 codex）。
6. **工具排序**：本轮落地**确定性默认排序**（字典序 / scope+name 稳定排序）；`toolOrder` 配置留后续。
7. **裁剪**：**决定保留多少**归装配 / 规划；**wire 格式头部孤儿清理**留序列化层。
8. **缓存约束**：稳定前缀字节稳定；序列化层打 `cache_control` 断点；`ContextMeter` 占用**按 provider cache 语义（`subset` / `additive`）**，不盲目相加。

9. **溢出处理 = 方案 A（保留历史 + 模型面替换）**：事实（messages 表）一条不删；模型面（surface）= 初始上下文 + checkpoint + **必保的当前输入/工具状态** + 预算内历史用户消息 + 最近可见消息；压缩记录为**有序列表**；UI 显示全量历史 + 「已压缩」标记。
10. **压缩 = 动作 + 规则表 + 引擎**：三个动作（① 精简 / ② 摘要 / ③ 重开）实现**同一契约**、可任意组合 / 换序 / 跳过；「规则表」描述「条件 → 动作」，`no-op` 只跳过当前规则并继续后续动作；**调整只动规则表**（配置或代码皆可），引擎与动作不动；默认预设 `adaptive` 采用正式阶段/原因/前置结果规则表：主动中途只①；turn 边界① `no-op` 或仍未达软目标后继续②；①/② 已尝试但仍未达软目标时③兜底（不要求 K=3）；溢出优先执行带工具状态保护的应急③。
11. **触发阈值唯一口径**：`rawInputWindow = max(0, providerWindow - outputReserveTokens)`；`effectiveWindow = rawInputWindow × 95%`；`bodyBudget = max(0, effectiveWindow - prefixTokens - safetyReserveTokens)`；`bodyTokens = max(0, projectedTokens - prefixTokens)`；唯一触发条件为 `bodyTokens / bodyBudget ≥ min(配置比例, 90%)`。配置为设置里可选的「自动压缩触发比例」（百分比、默认空→90%、上限 90%，只能提前不能推迟）；UI、规则表和发送前检查共用 `shouldCompact`，总量 `projectedTokens / effectiveWindow` 只展示不触发。
12. **选型只靠确定性信号**：优先级为溢出报错（安全边界应急 ③）→ 用户命令（压缩=② / 开新=③，工具执行中排队）；无上述信号时，active tool loop 只①，turn boundary 先检查同一 `windowId` 的②累计 **K=3**（仍超则③），否则按①→②→终局兜底；turn boundary 的 ①/②无收益或②仍高于软目标时，③终局兜底不以 K=3 为前提；**不做自动语义判断**；`mustShed` 仅作可调旋钮、非判据。
13. **用户显式命令**：「压缩上下文」= ②；「开新上下文」= ③。
14. **`history` 工具与 ③ 绑定**：③ 重开必须同步提供 `history` 工具（模型专用、只读，绑定当前授权会话，按窗口/条目/搜索分页读回旧明细，并限制单条/单次返回预算），否则模型侧真丢。
15. **surface 有界保留真实用户消息**：当前输入先进入不可淘汰的 `requiredSurfaceSet`；②/③ 初始默认原样保留最近 **128 条历史用户消息**、历史消息最多占 `bodyBudget × 50%`（兼容字段 `inputBudget × 50%`），实际取 token/N/剩余预算三重限制后的较小值；两项可配置，后续依据运行数据调优。其余原文留在 facts，由 checkpoint + `history` 表示。单条输入超过可用预算时返回 `uncompressible_input`，不盲目重试；required set 硬 fit 但无法达到软目标时返回 `fits_without_headroom` 并正常发送。
16. **研发周期定位**：本方案是「会话记录事件流」基础实现的后续扩展；事件流需补 request 关联、schema 版本、surface 快照/阴影与 `compaction_*`，并作为 WP3 的唯一生产适配器。
17. **可观测与预设**：内置若干规则表预设（`classic` / `reset-first` / `adaptive` …），默认一份；每次决策记录命中规则 / 动作 / 前后 token / 模型调用数，供 A/B 对比。
18. **事件流门禁**：当前 `electron/sessionEvents.ts` 已可用；**WP0–WP2 先做**，WP3 先补 schema 再从事件重放构造 `ContextInput`；不新增 messages/usage 的生产旁路。WP4/WP5 依赖 `compaction_*` 与 surface 阴影事件，事件未可重放前不开放自动压缩。
19. **技能路由归 Core**：`skillRoute` 与目录 / 正文组装全部归 Core；渲染端只发原始输入，路由结果回传**仅供展示**。
20. **压缩记录 = committed end 的有序列表**：每条记录由唯一 `compactionId` 标识，只有合法 `end(status=committed)` 才生效；start/summary 仅为候选/遥测，支持 K=3 的多段、非连续阴影，重复相同 end 幂等。
21. **`BodyAfterPrefix` 唯一触发定义 + ① 缓存安全**：`rawInputWindow = max(0, providerWindow - outputReserveTokens)`；`effectiveWindow = rawInputWindow × 95%`；`bodyBudget = max(0, effectiveWindow - prefixTokens - safetyReserveTokens)`；`bodyTokens = max(0, projectedTokens - prefixTokens)`；触发只看 `bodyTokens / bodyBudget`，中途 ① 只动「缓存断点之后」的内容。
22. **装配降级 + notes**：装配 / 渲染抛错回退到最小 system（不阻断请求）；`notes` 本轮不做（③ 只用「初始上下文 + 预算内保留用户消息 + `history`」）。
23. **当前输入必保**：`currentUserMessageId` 的正文/附件、必需 fragment 和本轮工具执行状态先组成 `requiredSurfaceSet`，不受历史用户消息的 128 条 / `bodyBudget × 50%`（兼容字段 `inputBudget × 50%`）配额影响；按 id 去重且在 surface 中恰好一次。
24. **统一请求预算**：以实际 `maxTokensEffective` 计算 `outputReserveTokens`，明确 `totalInputBudget`（含 prefix）、`bodyBudget` / 兼容字段 `inputBudget`（不含 prefix）、`requiredTokens`、`historyBudget` 和 `safetyReserveTokens`；无锚点时仍做保守硬预算检查，不用近似投影触发自动压缩；完整 surface 只与 `totalInputBudget` 比较，停止目标低于触发线。
25. **工具恢复隔离**：provider 溢出优先于“中途主动只①”，但只在已完成工具结果提交的安全边界执行应急③；保存 `ToolExecutionCheckpoint`，恢复只重试 provider 请求，已完成工具不得重跑，in-flight 工具则暂停。
26. **硬预算优先于软目标**：动作返回 `applied | no-op | uncompressible`，引擎规划返回 `target_reached | fits_without_headroom | exhausted | uncompressible`；硬 fit 是完整 surface 与 `totalInputBudget` 的比较，软停止目标只是 body 优化目标；去重指纹包含 `decisionId`、phase、reason、ruleVersion、surface/预算/配置和 `windowId`，只在同一决策周期内去重，overflow/显式命令不得复用主动压缩的终局。
27. **最终发送一致性门禁**：`target_reached`、`fits_without_headroom` 和无压缩直发都必须在发送前验证 required set 恰好一次、当前输入完整、工具配对合法、实际 surface 与 `request_header` 快照一致，并以 `estimatedTotalInputTokens <= totalInputBudget` 做统一 token 检查（记录估算来源）；失败则回规划或阻断，不发送。

**待复审**：事件 schema 扩展完成后，需复审 request 锚点、surface 重放和不可压缩结果的端到端验收；在此之前不进入 WP3–WP5 的实现门禁。

---

> 参考：外部设计 `tech-design-v3.md` §6（上下文装配与渲染）、§7.4 / §7.5（流式聚合与 chunk 落盘）、§12.2（崩溃恢复）。
> 同行实现 `F:\Develop\deepseek-harness`：`packages/core/system-prompt`（`PromptSection`/`renderPrompt`/`orderTools`/`toolOrder`/`TOOL_ORDER_REST`/contexts 快照）、
> `packages/llm/token-meter`（`estimate.ts`/`projection.ts`/`index.ts`）、`packages/core/agent-loop/src/agent.ts`（`system=renderPrompt(assembly)`、`tools=assembly.tools`）、
> `packages/compaction/compaction-basic`（`config.ts` `thresholdRatio=0.8`/`retainRatio=0.16`、`region.ts` `selectCompactableRange`、`summarizer.ts` 结构化纪要、`index.ts` 触发与溢出恢复）。
> `F:\Develop\codex`：`ext/skills/src/catalog_prompt.rs`（`## Skills` / `### Available skills` 目录）、`render.rs`（`skill_metadata_budget`，默认 2% 窗口、上限 10000 token）、
> `fragments.rs`（目录 role=developer，选中正文 `SkillInstructions` role=user）、`host_prompt.rs`（选中正文自动注入 user 片段）、
> `tools/read.rs`/`list.rs`（`skills.read` 按需读）、`core/src/client.rs`（稳定 `prompt_cache_key`）。
> 其压缩机制：`core/src/compact.rs`（摘要型：保留最近真实用户消息 + 纪要 + 初始上下文）、`core/src/compact_token_budget.rs`（③ 重开：开新窗口）、
> `core/src/session/context_window.rs`（90% 上限、有效窗口 95%、`BodyAfterPrefix`；本方案采用独立的 `bodyBudget` 唯一公式）、`ext/history-notes`（`history`/`notes` 工具按需读旧窗口明细）、
> `history/src/retained_context.rs`（用户原话有界保留）。
