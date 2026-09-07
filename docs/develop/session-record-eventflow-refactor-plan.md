# 会话记录事件流重构方案

> 状态：方案（待评审）
> 基线：`main` 代码，但**在「消息事实落库归 Core」这一版本落地后的基线上推进**（作为其后续步；见下节"前置依赖与分工"）。
>
> **一句话结论**：现在每个会话只留下两样东西——消息表（内容事实）和每会话一行、会被覆盖写的用量快照。
> 出了事没法回放：不知道这条回复由哪些流式碎片拼成、这个 turn 为什么停、某次重试了几次、某条工具调用
> 有没有结果。本次在不改变「消息表是界面/搜索读取源」的前提下，补一条只追加的过程事件流，让审计、回放、
> 对账、崩溃补闭从此有真实依据，而不是靠"看残留状态猜"。

---

## 0. 前置依赖与分工

本方案**不改变消息事实的归属**——消息表仍由 Core 写、仍由 Core 管（这在"消息事实落库归 Core"那一版已定）。事件流只是
在这个已经归位的 Core 上，额外**加一本"生产台账"**：Core 在跑会话时顺手记录过程与边界，结果（消息表）照旧。

因为消息落库归 Core 已在别处单独推进，本方案作为**其后续的一版**独立推进，落地时必须对齐以下三点：

| 衔接点 | 依赖 | 分工（避免打架） |
| --- | --- | --- |
| `assistant_chunk` 的 delta | 依赖消息落库版（或 Agent Loop 单路径 WP1）已确定的结构化 `NormalizedDelta` | 本方案只"记"这个已有结构，不自造一套 delta 语义 |
| `messageId` 归属 | 依赖消息落库版已确定"`messageId` 由 Core 生成、随发送接口下发" | chunk 事件复用该 `messageId` 关联消息行，不另立映射 |
| 用量记录 | 依赖消息落库版已定"最终 usage 走发送接口返回、`message_delta` 增量广播" | 事件流的 `request_usage` 记**每次请求的事实**（审计/重算用），与展示用 `usage` 各自分工，不重复记同一份 token |

> 一句话：**消息落库归 Core 解决"结果归 Core"；本方案解决"过程也归 Core"。** 两者是同一个 Core 的两个动作，合起来
> 才是完整的"Core 记录层"。本方案作为独立一版，只在其后补"过程记录"这一半。

---

## 1. 这次要解决什么

### 1.1 现在的三个问题

**问题一：会话不可回放、不可对账。**

「事实」只有 `messages` 表（[schema.ts:34](../../electron/database/schema.ts#L34)）和每会话一行的
`session_usages` 快照（[schema.ts:58](../../electron/database/schema.ts#L58)）。想知道
「这次回复由哪些流式片段拼成」「这个 turn 是因为正常 / 截断 / 取消还是报错而结束」「某个工具请求重试了几次」——
都查不到，因为根本没记。

**问题二：崩溃后的补闭是"看状态猜"。**

启动时靠 `cleanupStreamingResiduesOnStartup`（[streamingCleanup.ts:31](../../electron/database/streamingCleanup.ts#L31)）
把还处于 `streaming` 态的消息降级。它拿不到「这个 turn 是否真的被打断」「哪个工具调用只有请求、没有结果」，
只能事后抹平，也无法区分"真崩溃"和"仍在进行中"。

**问题三：消息"分段落库"会在崩溃时留下半截消息（这个现象由消息落库归 Core 根除）。**

现状是流式输出逐段 append 写库，任一次崩溃都会在消息表里留一条 `status='streaming'` 的没头没尾消息；现有
补闭只是把它"降级成 completed"，不回答「这条算不算完整」。

> **这一步不是本方案负责的**——"消息一次性落库"（不再流式逐段写）由「消息事实落库归 Core」那一版解决，
> 现象在那之后自然消失。本方案面对的是它留下的**新缺口**：消息既然要"整体落库"，那崩溃时消息可能**还没进库**，
> 光看消息表就**完全不知道**这一轮是不是本来就是中断的、哪个工具调用了却没结果。事件流正是补这个"判断依据"。
>
> 也就是说：**消息落库归 Core 消除"半截消息"这个现象；事件流解决"现象消失后，怎么知道缺了什么"。**

### 1.2 目标

- 补一条只追加的过程事件流，逐条记录「这个会话里发生了什么」。
- 崩溃或异常后，能根据事件流**精确补闭**：补 `turn_end{reason:interrupted}`，给「有请求但没结果」的工具
  补一条 `synthetic error`，并且**绝不重新执行工具**（工具可能已有副作用，重放执行是危险的）。
- 让用量统计变得**可追溯、可重算**，而不再只是一个被反复覆盖的最终值。
- 消息表仍是界面、搜索、备份读取的唯一事实源；事件流不反向覆盖它、不成为新的"唯一真相源"。

### 1.3 本次不做什么

- 不做事件溯源（Event Sourcing）的激进迁移——不把事件流变成消息表的唯一真相源；消息表继续被界面、搜索、备份读取。
- 不把事件流塞进 SQLite 主库——事件流是**数据量大、检索不频繁**的只追加日志（逐 chunk 记录、长会话会很大；
  用途是审计 / 回放 / 扫尾，没有条件查询），不适合放进 `spaceassistant-data.db` 让它持续膨胀。
- 不做持久化 checkpoint——单会话规模可控，恢复时全量重放够用；将来变大再单独考虑。
- 不重放执行工具——崩溃补闭只为「没结果的工具请求」补一条 `synthetic error`，绝不重新调用。
- 不改消息表结构（本轮不加 usage 列，见 WP3 的说明）——避免牵一发而动全身，用量追溯用事件流承载。

---

## 2. 核心设计决定

| 范围 | 决定 |
| --- | --- |
| 事件落点 | **每会话一个 `events.jsonl`**（append-only，`sessions/<id>-<date>/events.jsonl`），逐行写一条事件；不占 SQLite 主库。 |
| 轻量索引 | **每会话一个 `events.index.json`**（最简：记 `{ seq, lastAt, eventCount, bytes }`），供启动/审计快速定位会话事件流；可做 **FIFO 限量**（保留最近 N 个会话，超出按旧删整目录）。 |
| 与备份的关系 | 事件流文件**与 `sessions/<id>-<date>/` 备份同目录、同生命周期**——删除会话时，`session.json` + `messages.json` + `events.jsonl` + `events.index.json` 一起删。 |
| 事件性质 | 只记 **log-only（过程 / 边界 / 审计）** 事件。消息内容**不**重复落事件流——那是消息表的事。两者通过 `messageId` 关联。 |
| 事实来源 | 消息表仍是界面、搜索、备份的唯一事实读取源；事件流只用于审计、回放、对账、崩溃补闭。 |
| 过程/事实分离 | `assistant_chunk`（过程）只用于回放与对账，不参与消息表的重建；消息表重建只以消息行（事实）为准。 |
| 崩溃补闭 | 加载时从事件流找「未闭合的 `turn`/`step`」，补 `turn_end{reason:interrupted}`；对「有 `tool_use` 但无 `tool_result`」补 synthetic error。绝不重新执行工具。 |
| 用量追溯 | 每次请求完成时把该次 `usage` 落为一条 `request_usage` 事件（带 `requestId`/`usage`/`source`）；`session_usages` 是「最新投影缓存」，可丢、可由事件流重算。 |
| 回放 | 重放 `assistant_chunk` 事件序列即可还原流式过程；`request_usage` 可还原每次请求的用量。 |
| 与上下文注入的衔接 | 请求装配结果（route / system / tools / 上下文占用估算）由上下文注入三级式产出，作为 `request_header` / `request_context` 事件写入，让"这次到底送了什么都可追溯"。 |

> 为什么用 JSONL 文件而不进 SQLite：事件流**数据量大、检索不频繁**——逐 chunk 记录会让单会话变成几千上万行，
> 塞进 `spaceassistant-data.db` 会让它持续膨胀；而它的用途是审计、按 `seq` 顺序回放、扫尾，没有条件查询，
> SQL 的索引能力用不上。JSONL 天然 append-only、可 `tail`、可独立分发，正好匹配。代价是失去与消息表的
> **同事务**——但过程记录是"尽力而为的日志"，丢几条 chunk 不影响会话完整；真正的事实（消息表）照旧走事务。

---

## 3. 改之前的一些事实

- 本方案在「消息事实落库归 Core」落地后的基线上推进；因此下列"事实"指**该基线之上的现状**（结果消息已归 Core 写，
  只是过程/边界还没记）。涉及的存储结构、事务与现有函数如下：

- `messages` 表（[schema.ts:34](../../electron/database/schema.ts#L34)）：`session_id` / `role` / `content` /
  `tool_use` / `tool_calls` / `thinking` / `content_segments` / `skill_hints` / `attachments` /
  `images_delivered_to_api` / `status` / `schema_version` / `timestamp` / `sequence`。
- `session_usages` 表（[schema.ts:58](../../electron/database/schema.ts#L58)）：每会话一行，`data` 为 JSON；
  `setSessionUsage`（[operations.ts:276](../../electron/database/operations.ts#L276)）用
  `INSERT OR REPLACE` 覆盖写，`getSessionUsage`（[operations.ts:267](../../electron/database/operations.ts#L267)）直接读该 JSON。
- `appendMessage`（[operations.ts:347](../../electron/database/operations.ts#L347)）写 `messages` 表并返回 `sequence` ack。
- 崩溃补闭现状：`cleanupStreamingResiduesOnStartup`（[streamingCleanup.ts:31](../../electron/database/streamingCleanup.ts#L31)），
  启动时把 `streaming` 态消息降级。
- 明文备份：`SessionBackupManager`（[sessionBackupManager.ts:38](../../electron/sessionBackupManager.ts#L38)）写
  `sessions/<id>-<date>/session.json` + `messages.json`，边读边写、分页流式。它属于「导出 / 备份」通道，
  本方案不动它的定位。
- 工具循环发起入口：`runToolChatSession`（[toolChatLoop.ts:404](../../electron/toolChatLoop.ts#L404)），
  流式聚合在 `StreamClient` / `aggregateDeltas`（Agent Loop 单路径 WP1 落地后）。

---

## 4. 工作包

> 每个 WP 拆成能独立验证的提交。每阶段收尾跑定向测试 + `npm run build:electron:incremental`；
> 全量 `npm test` 只在阶段收尾 / 提交前跑（遵循 AGENTS.md 的会话成本纪律）。

### WP0：事件流文件与事件类型

**做什么**

1. 事件流落盘为 **`sessions/<id>-<date>/events.jsonl`**（复用现有备份目录），每行一条事件：
   `{ seq, time, type, payload }`，`seq` 会话内单调递增。
2. 配套轻量索引 **`sessions/<id>-<date>/events.index.json`**：最简字段 `{ seq, lastAt, eventCount, bytes }`，
   供审计 / 启动快速定位该会话事件流；可做 FIFO 限量（见 WP0 第 4 步）。
3. 定义 `SessionEvent` union（放主进程侧，如 `electron/sessionEvents.ts`），全部为 **log-only**：
   - 边界：`turn_start{ turnId }` / `turn_end{ turnId, reason, error? }` / `step_start{ turnId, stepId }` /
     `step_end{ turnId, stepId }`。
   - 过程：`assistant_chunk{ turnId, stepId, messageId, delta }`（`delta` 为单路径规划里 `NormalizedDelta`）。
   - 工具：`tool_call{ turnId, stepId, toolUseId, name, args }`（在请求准备前落盘，记录"模型请求了什么"）。
   - 请求：`request_header{ route, system, tools }` / `request_context{ provider, model, contextWindow?, contextUsage? }`。
   - 用量：`request_usage{ requestId, usage, source }`。
   - 重试：`request_retry{ turnId, stepId, attempt, backoffMs, code }`（每次重试前先落盘，崩溃也不丢"重试了几次"）。
   - 收尾：`session_end_seed{ seedSeq }`（标记该会话历史/上下文种子来源）。
4. 索引 **FIFO 限量**：全局保留最近 N 个会话的事件流（N 可配置），超出时按 `lastAt` 淘汰最旧会话的整个目录
   （`events.jsonl` + `events.index.json`）。

**怎么验收**

- `events.jsonl` 可 append，`seq` 在会话内单调递增、无重复；每行是合法 JSON。
- `events.index.json` 随写入更新，能从它定位到会话事件流。
- 事件类型单测：每个事件都有对应的 `type` 解析函数与 payload 校验。

### WP1：事件写入点

**做什么**

1. 在 `runToolChatSession` 内按边界落 `turn_start` / `turn_end`，按 step 落 `step_start` / `step_end`。
2. 在流式聚合处对每个 `NormalizedDelta` 落 `assistant_chunk`（带 `messageId`，用于关联消息行）。
3. 在工具调度前落 `tool_call`（"模型请求了什么"），在请求准备前落 `request_header` / `request_context`。
4. 在每次重试前落 `request_retry`。
5. 事件写入是 **append 一行到 `events.jsonl` + 更新 `events.index.json`**，用现有"边读边写、不整读进内存"的
   流式写文件方式（参考 `arrayMessagePageReader` / `SessionBackupManager`）。**不与消息表同事务**——过程记录是
   尽力而为的日志，但 `events.index.json` 要在每批事件后原子更新（先写临时文件再 rename），避免索引撕裂。

**怎么验收**

- 一次完整带工具的 turn 结束后，事件流按序出现：
  `turn_start → step_start → (assistant_chunk)* → tool_call → ... → step_end → (回环) → turn_end`。
- 事件流每行合规、`seq` 单调；`events.index.json` 在写入中断后仍可读（原子更新保证）。

### WP2：崩溃补闭改为事件驱动

**做什么**

1. 写一个 `reconcileSessionEvents(events)` 纯函数：读某会话 `events.jsonl`（按 `seq` 顺序），找出——
   - 有 `turn_start` 但无 `turn_end` → 需补 `turn_end{ reason: 'interrupted' }`；
   - 有 `step_start` 但无 `step_end` → 需补 `step_end`；
   - 有 `tool_call`（事件流记录"模型请求了什么工具"）但无对应 `tool_result` → 为缺失的 `tool_use` 补一条
     `synthetic error` ToolResult。依据来自事件流里的 `tool_call`（脚本消息可能因整体落库而未进库，不能依赖"消息行"）。
2. 把 `cleanupStreamingResiduesOnStartup` 升级为「先读事件流判断、再精确补闭」，不再单纯按状态降级。
3. **绝不重新执行工具**。

**怎么验收**

- 构造「无 `turn_end`」「无 `step_end`」「`tool_use` 无 `tool_result`」三种事件流，断言补闭正确、且不重复调用工具。
- 与现有 `cleanupStreamingResiduesOnStartup` 的 `streamingCleanup.test.ts` 兼容。

### WP3：用量统计可追溯、可重算

**做什么**

1. 在每次请求完成、拿到 `usage` 后，追加一条 `request_usage{ requestId, usage, source }` 事件。
2. 写 `computeSessionUsageFromEvents(events)` 纯函数，把 `request_usage` 系列聚合回 `SessionUsage`。
3. `session_usages` 保留为「最新投影缓存」：读路径仍走它（不破坏现状），但明确它可丢、可由事件流重算。
4. **本轮不加消息表 `usage` 列**（避免改消息表结构）；用量事实从事件流读取。

**怎么验收**

- 给定一组 `request_usage` 事件，`computeSessionUsageFromEvents` 聚合结果与 `SessionUsage` 一致。
- 删掉 `session_usages` 一行、重算，得到的用量与删除前一致（可恢复）。

### WP4：回放审计（事件流本身即 JSONL）

**做什么**

1. 因为事件流本来就是 `events.jsonl`，**无需再导出**——直接 `tail` / 顺序读该文件即可审计。
2. 提供只读工具按会话打开 `events.jsonl`，按 `seq` 顺序输出（复用"边读边写、不整读进内存"思路，
   参考 `arrayMessagePageReader`）。
3. 与现有 `messages.json` 备份职责互补：备份是"内容快照"，`events.jsonl` 是"过程留痕"，二者同目录共同构成可审计会话。

**怎么验收**

- 能按会话只读打开 `events.jsonl`，按 `seq` 有序输出、无泄漏会话外数据。
- `events.jsonl` 可直接被 `tail`/文本编辑器查看。

### WP5：与上下文注入三级式的衔接

**做什么**

1. 上下文注入三级式产出 `request_header` / `request_context` 后，由本方案的事件写入点落盘（见 WP1 第 3 步）。
2. 让「这次请求到底送了 system / tools / 上下文占用估算」也可追溯。

**怎么验收**

- 发一次请求，事件流里有对应的 `request_header` / `request_context`，能还原出送出的 system 与 tools。

---

## 5. 测试策略

- 归到 `electron` 项目（node 环境，forks 单 worker）。
- 定向测试 `npm exec vitest run electron/sessionEvents*.test.ts`。
- 事件流文件逻辑用临时目录（`os.tmpdir()` 或 `mkdtemp`）验证：`events.jsonl` 可 append、`seq` 单调、每行合法 JSON；
  `events.index.json` 以"写临时文件再 rename"方式原子更新，中途中断后仍可读。
- 全部特性在「纯函数 + 表驱动」层面测：`reconcileSessionEvents`、`computeSessionUsageFromEvents`、事件 append 的
  `seq` 单调性。

---

## 6. 风险与残留

| 风险 / 残留 | 影响 | 怎么缓解 |
| --- | --- | --- |
| 事件流增长导致磁盘占用 | 每 chunk 一条 `assistant_chunk`，长回复会写很多行 | 事件流独立成文件、不进 SQLite 主库；配合 FIFO 限量（保留最近 N 个会话）；必要时可加采样 / 可选关闭 chunk 落盘 |
| `assistant_chunk` 与消息行 `messageId` 关联出错 | 对账错位 | 在 `aggregateDeltas` 聚合完成、生成 `messageId` 后，chunk 事件统一回填该 id |
| 事件写入拖慢主流程 | 每步多几次文件写 | 批量 append（攒一批再写）+ 索引原子更新；事件流不与消息表同事务，避免阻塞主事务 |
| FIFO 限量误删活跃会话 | 正在运行的会话事件流被淘汰 | 只在会话结束时标记可淘汰、或按 `lastAt` 淘汰且跳过"有未闭合 turn"的会话；N 值保守 |
| `session_usages` 退化本质 | 读路径仍走它，若被覆盖写、事件流缺失会不一致 | 明确「事件流是重算依据、缓存可丢」；`computeSessionUsageFromEvents` 作为恢复路径 |
| 保留了外部设计的 `tool_call` 落盘 | 增加事件量 | 它只落在「模型请求了什么」的准备前，量小；与工具执行成功与否无关，仅审计 |

---

## 7. 待确认项

1. **`assistant_chunk` 是否全量落盘**：逐 chunk 落是最完整、但量最大。是否只落关键边界（`block_start` /
   `block_end` / 每个有内容的 `text_delta`），或做成可配置开关？建议全量落、出问题时再裁。
2. **`session_usages` 本轮是否保留为"覆盖写缓存"**：保留最稳（读路径不动），但"覆盖写"本身仍是隐患。是否
   本轮就把读路径改为「事件流重算」，更快但改动面更大？建议本轮保留、下一轮再收敛。
3. **FIFO 限量阈值 N**：保留最近 N 个会话的事件流，N 取多少合适？建议先给一个保守值（如 200），
   依实际磁盘占用再调。
4. **测试目录放哪**：离线的 `events.jsonl`/`events.index.json` 单测落在 `os.tmpdir()`，
   还是复用 `sessions/` 下的测试专用子目录？建议临时目录，避免污染工作区。

---

> 参考：外部设计 `tech-design-v3.md` 第 4 节「事件流与存储」、第 7.5 节「流式聚合与 chunk 落盘」、
> 12.2「崩溃恢复」。本方案不整体引入该外部设计，只吸取其「过程/事实分离」「可追溯」「崩溃补闭不重放执行」三条不变量。
