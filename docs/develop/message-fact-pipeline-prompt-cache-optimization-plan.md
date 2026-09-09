# 消息事实链路 Prompt Cache 优化开发方案

> 状态：待实施，本文仅交付开发设计。基础方案：[消息事实生产链路统一开发方案](message-fact-production-pipeline-refactor-plan.md)（下称"基础方案"），本文**不改变**基础方案的消息所有权、事件协议、存储契约与阶段划分，只补齐基础方案未覆盖的缓存工程机制。
> 初稿日期：2026-09-07。
> 代码基线：工作树 `/Users/space/Documents/Develop/SpaceAssistant/.worktrees/message-fact-persistence-core-refactor`，分支 `codex/message-fact-persistence-core-refactor`，HEAD `1f6e7940`（含未提交改动），静态核对，未运行测试。

## 1. 结论与边界

基础方案通过"串行 turn + 终态不可变 + 确定性派生排序"保证了历史 payload **只追加、可复现**——这是 prompt cache 命中的必要条件，但基础方案没有任何主动缓存工程：无断点放置、无 system 稳定性约束、无命中率回归门禁。本文补齐三件事：

1. **断点放置策略**：system 尾部固定断点 + 请求级自动断点，随历史滚雪球；
2. **system / tools 稳定性整改**：消除当前每轮重拼 system 中的逐轮变化成分，否则断点形同虚设；
3. **观测与回归门禁**：把"前缀字节稳定"与"缓存命中增长"写成可执行断言，挂进基础方案的 golden fixture 与验收用例。

不引入缓存预热调度、不做跨会话缓存共享、不为命中率改变消息裁剪语义。裁剪（滑动窗口）与用户编辑历史导致的缓存失效是固有代价，不做补偿机制。

## 2. 现状核对结果

| 位置 / 符号 | 现状 | 对缓存的影响 |
| --- | --- | --- |
| `electron/claudeToolLoopStreamParams.ts::buildClaudeToolLoopStreamParams` | **主生产路径完全不支持 `cache_control`**；仅 `buildClaudeNarrativeCompletionParams`（旁路）透传 | 主链路每次 SDK 请求全价计算全部输入，零缓存收益 |
| `electron/toolChatLoop.ts` 循环体（约 578–603 行） | 每轮重拼 system：`getCachedMemoryContent()` + `appendAvailableToolsHint` + `buildFinalSystemPrompt` | system 渲染在 messages 之前，system 一变 tools+system+messages 缓存全部失效 |
| `buildFinalSystemPrompt` 的 `hasImageAttachments` 分支 | 仅当本轮带图时向 system 追加"图片附件"提示 | **逐轮开关量**：带图轮与纯文本轮的 system 不同 → 跨轮全量失效 |
| `recoverySkillSystemSuffix`（toolChatLoop.ts:569、1897 行） | 依赖修复技能激活时**循环中途**追加 system 后缀 | 同一 turn 内第 N 轮 SDK 请求的 system 与第 N+1 轮不同 → 该点之后全失效 |
| `getCachedMemoryContent()` | 进程内缓存的记忆内容 | 记忆更新后 system 变化；同一进程内多次调用结果一致，属于"慢变量" |
| `resolveRequestLocale` + locale 提示（`llmSystemPrompt.ts`） | locale 来自 payload/DB/系统检测，拼进 system 尾部 | 用户切换界面语言 → 全量失效；单会话内稳定 |
| `computeEffectiveTools`（effectiveTools.ts） | 每次调用构建 tools 数组 | 顺序确定性未验证：tools 渲染在 position 0，乱序即全失效 |
| `stripThinking(messagesForApi)` | 每轮对历史做 thinking 剥离 | 剥离本身确定性即可接受；**thinking 配置逐轮切换**才是失效项（工具循环内固定，暂无问题） |
| `ToolLoopUsage` / `contextUsageEstimate.ts` / `usageCacheSemantics.ts` | 已解析并透传 `cache_read_input_tokens` / `cache_creation_input_tokens` | 观测数据源已存在，只缺断言与门禁，不缺采集 |
| `logAgentEvent('llm.request', { system, messages, ... })` | 每轮落完整 payload | 天然的相邻请求 payload diff 数据源，可直接用于失效点定位 |

**基础方案已保证、本文直接依赖的前提**（引用基础方案章节）：

- 前序 turn finalize 提交后下一 turn 才 prepare（§5.1）→ 下一轮 payload 的前缀里是上一轮的**最终字节**，不存在"读到 partial 内容导致前缀错位"；
- 派生排序是确定性纯函数、anchor 首次关联后固定、物理 sequence 不重排（§5.2）→ 历史顺序逐字节可复现；
- reducer 禁止 `Date.now()`/`randomUUID`、skill hint 用稳定 `hintKey`（§4.4）→ 消息内容无逐请求随机量；
- 排队场景 B 紧跟 A 执行，天然落在 5 分钟 TTL 窗口内。

## 3. 断点放置策略

Anthropic prompt cache 为**严格前缀匹配**，渲染顺序 `tools → system → messages`，前缀中任意一个字节变化即从该点起全部失效。断点上限 4 个/请求，最短可缓存前缀随模型不同（512–4096 token，过短**静默不缓存**——不报错，仅 `cache_creation_input_tokens` 为 0）。应用允许用户配置模型，门禁断言不得假设具体模型的下限。

### 3.1 双断点组合（工具循环主链路）

对 `buildClaudeToolLoopStreamParams` 增加两个可选参数并默认启用：

```ts
// 示意签名；其余字段不变。
buildClaudeToolLoopStreamParams({
  ...,
  systemBreakpoint?: boolean,   // 默认 true：system 为字符串时按块包裹并标记
  autoCacheControl?: boolean    // 默认 true：请求级 cache_control: { type: 'ephemeral' }
})
```

1. **固定断点：system 尾部。** system 目前是纯字符串；改为 `[{ type: 'text', text, cache_control: { type: 'ephemeral' } }]` 单块。该断点锁住 `tools + system` 这个最贵、最稳定的前排——后续 messages 里发生任何意外（裁剪、编辑、thinking 剥离差异）都不影响前排命中。
2. **自动断点：请求顶层 `cache_control`。** 自动落在最后一个可缓存块上，随历史增长前移，无需手动维护标记位置。多轮对话的标准模式："读全部旧前缀，只写新增量"。
3. 两者各占 1 个断点额度，剩余 2 个留给长工具循环的中继断点（§3.3）。

**循环内语义**：工具循环每轮 SDK 请求 = 上一轮请求 + 新增的 `tool_use`/`tool_result`/正文，正是"只追加"形态。断点后的健康签名：`cache_read_input_tokens` 随轮单调增长，`cache_creation_input_tokens` 仅约等于上轮 assistant 输出 + 新增工具结果。此形态作为 §5 门禁断言。

**不建议**：把断点手工放在每条消息上逐个维护——自动断点已覆盖尾部，手工维护位置随裁剪/配对逻辑漂移，容易把断点夹进"每次都变的内容"后面（纯付 1.25 倍写入费，零读收益）。

### 3.2 断点不放置的位置

- **system 内部任何"逐轮变化"内容之后**——先做 §4 稳定性整改，否则断点放在变化点之后等于给废前缀付写入费；
- **required user 之前的裁剪边界上**——裁剪从头部丢弃最旧非必需组（基础方案 §5.2 第 6 条），断点位置随之抖动；裁剪只发生在超限会话，超限会话本来全量 miss，无需为其优化；
- **远程渠道出站内容**——断点只作用于 SDK 请求体，与 IM 出站无关。

### 3.3 长工具循环的中继断点（20 块回看窗口）

断点向前查找上一条缓存最多回看 20 个"位置"（连续 `tool_use` 块算一个位置，连续 `tool_result` 块也算一个）。基础方案保留了多轮工具执行与 `shouldStopToolRetry` 长循环语义（§9.2），单 turn 内**串行**工具调用累计超过约 20 个位置时，自动断点可能够不到上一条缓存，表现为"字节完全相同却 miss"。处理规则：

- 当本次 turn 累计新增消息位置数超过 15 时，在最近一条完整 `tool_result` 消息末尾追加一个显式中继断点（占用 §3.1 预留额度，总数仍 ≤ 4）；
- 阈值按位置数而非轮数计数（连续并行工具块合并计 1），与 SDK 计数规则一致；
- 中继断点只在循环内生效，不影响 turn 间的前排断点。

### 3.4 TTL 策略

- 默认 5 分钟 TTL（`ephemeral` 无 `ttl` 字段）。桌面连续对话、排队消息（B 紧跟 A 执行）都在窗口内；1 小时 TTL 写入费翻倍（2×），仅"5–60 分钟间隔"才可能回本。
- 微信/飞书远程会话消息间隔常见超过 5 分钟，前缀已过期 → 冷 miss 属预期成本，**默认接受**。是否对远程渠道启用 1h TTL 留作后续按真实账单数据决策（观察 §5 的 usage 记录中远程会话的 miss 分布后再定），本期不做。
- 不做预热（`max_tokens: 0` 保活）：桌面应用没有"可预期流量来临前的空档"，预热只会增加成本。

## 4. system / tools 稳定性整改

断点策略生效的前提是前缀内容稳定。按"变化频率"重新归位三段内容（变化频率高的必须排到变化频率低的内容之后）：

### 4.1 图片附件提示移出 system（P1）

`hasImageAttachments` 是逐 turn 开关，当前拼在 system 尾部 → 带图轮与纯文本轮 system 不同，跨轮全量失效。整改：

- 提示文本随本轮 user 消息的 content 块下发（文本块排在图片块之后），不再进入 system；
- system 保持与是否带图无关。图片块本身属于 user 消息内容，位于前缀中该轮的位置，不破坏此前历史的前缀。

### 4.2 依赖修复技能后缀移出 system（P1）

`recoverySkillSystemSuffix` 在循环中途（toolChatLoop.ts:1897 行附近）追加到 system，使同一 turn 内前后 SDK 请求的 system 不同。整改：

- 改为追加到下一轮的 user 消息 content（工具循环内，`tool_result` 块之后追加一个 text 块）——位于 messages 尾部的追加，不触碰已缓存前缀；
- 该 text 块随历史持久化（由 reducer 按事件聚合，属于消息内容而非 system），后续轮次字节不变，命中不受影响。

### 4.3 记忆内容（P2，随 builder 迁移落地）

`memoryContent` 是慢变量（记忆更新才变），当前拼在 system 前段。两个可选处理，按成本递增：

1. **接受现状**：记忆更新本来就该让模型看到新内容，失效次数 = 记忆写入次数，频率低，可接受；
2. 若实测记忆更新频繁：将 memory 内容改为**首条 user 消息前的独立注入点**仍会失效，正确做法是随下一次新 user turn 以消息形式下发增量——作为独立小项另行评审，本期默认选 1 并在观测数据中记录失效次数。

### 4.4 tools 序列化确定性（P1）

- `computeEffectiveTools` 的输出顺序做一次性审计：确认 tools 数组顺序只由确定性输入（工具注册表顺序）决定，不含 Set 迭代、Map 遍历顺序依赖或按调用动态增删；
- tools 数组在**整个 turn 内冻结**（循环每轮传同一引用，现状即如此，测试固化），跨 turn 由 builder 一次性构建；
- `tool_choice` 逐轮恒为 `{ type: 'auto' }`（现状固定），不触发失效。

### 4.5 locale（P2）

locale 提示在 system 尾部，用户切换界面语言 → 全量失效，切换本身是显式用户动作且低频，**接受**。仅要求：同一 turn 的循环内 locale 解析结果缓存（`resolveRequestLocale` 每轮调用结果一致，避免 DB 读抖动），纳入 §5 断言。

## 5. 观测与回归门禁

### 5.1 usage 断言（挂进现有测试）

`ToolLoopUsage` 已携带缓存字段，在以下测试组追加断言，不新建测试工程：

| 测试组 | 追加断言 |
| --- | --- |
| 工具循环 golden fixture（基础方案 §9 reducer/协议组） | 逐轮记录 fake source 的 SDK 请求体：相邻请求的**重叠前缀字节相等**（diff 时剥离 `cache_control` 标记本身——标记位置移动不是失效项）；断言 system/ tools 数组引用与序列化字节全程不变 |
| 上下文组（Q1/Q2/Q9） | 除数组内容外，断言"上一 turn 的最终 SDK payload 是下一 turn 首轮请求的前 N 条消息的逐字节前缀"（序列化后比较） |
| 多轮工具循环（现有 toolChatLoop 回归） | 模拟 usage 返回：第 k 轮断言 `cache_read_input_tokens` ≈ 前 k-1 轮累计输入，`cache_creation_input_tokens` 仅覆盖上轮增量；thinking/effort 配置逐轮不变 |
| 跨入口组（desktop/wechat/feishu 参数化） | 同一 fake 事件序列下三个入口的 SDK 请求体字节相等（渠道回复文案允许不同） |

### 5.2 失效点定位手段（开发期，非门禁）

- 相邻请求 payload diff：`logAgentEvent('llm.request', { system, messages })` 已落完整请求体，开发期取相邻两条日志 diff 重叠区，首个分歧点即失效点（先剥离 `cache_control` 标记）；
- 命中率巡检：`usageCacheSemantics` 已区分缓存语义，在用量统计中按会话记录 `cache_read / (input + cache_read + cache_creation)` 比值，异常下跌（如某版本后整体命中率腰斩）作为人工巡检信号，不自动告警。

### 5.3 明确不做的观测项

不做缓存预热监控、不做跨会话命中率对比、不引入 Anthropic cache diagnostics beta 依赖（该能力随平台/版本变化，门禁以本地 payload 字节断言为准）。

## 6. 与基础方案的阶段映射

| 基础方案阶段 | 本文增量 | 备注 |
| --- | --- | --- |
| P1（事件与 source） | §4.1、§4.2 的 system 整改 + §3.1 双断点接入 `buildClaudeToolLoopStreamParams`；§4.4 tools 确定性审计 | system 拼装迁移到 builder 时一并实施，避免迁完再改两遍 |
| P2（Core 闭环） | §5.1 的 Q1/Q2/Q9 字节前缀断言；§4.5 locale 循环内缓存 | 挂进既有门禁，不加新阶段 |
| P3–P4（渠道切换） | 跨入口 SDK 请求体字节相等断言（§5.1 最后一行） | 防渠道接入时各自重拼历史引入抖动 |
| P5（验收） | owner 审计表中追加一行：`buildClaudeToolLoopStreamParams` 断点参数与 system 稳定性说明 | 性能验证记录中增加长会话下的命中率样本 |

## 7. 验收清单

1. 主链路连续 3 轮请求（同 turn 工具循环）：`cache_read_input_tokens` 单调增长，`cache_creation_input_tokens` 每轮仅覆盖增量（fake usage 驱动的单测证据）；
2. 带图轮与后续纯文本轮相邻：system 字节相等（图片提示已不在 system）；
3. 依赖修复技能激活的循环：激活前后 system 字节相等，追加内容位于 user 消息 content 尾部；
4. Q1/Q2 场景：B/C/D 各自首轮 SDK 请求的前缀与前一 turn 最终请求逐字节相等（含裁剪前）；
5. 超长工具循环（模拟 25 个位置）：自动断点 miss 时中继断点命中，命中率不低于无中继断点的对照组；
6. 上述全部以测试证据交付，与基础方案门禁命令一并执行，不新增独立命令。
