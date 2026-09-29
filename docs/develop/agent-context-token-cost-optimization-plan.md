# Agent 上下文与 Token 成本优化：实测分析与改进方案

> 文档日期：2026-09-20（最后修订：**v1.3** / 2026-09-21）
> 文档性质：问题分析与改进方案，本次不含代码实现
> 口径约定：`MB` 一律为 **10⁶ 字节**；体积论断必须标注「事件流面 / 模型面」（§2.4）
> 分析对象：会话 `b680b181-65ba-4816-af00-360ed7805e37`（**即本分析所在的会话本身**，属自指分析）
> 证据来源：
> - 会话事件流 `sessions/b680b181-65ba-4816-af00-360ed7805e37-20260920/events.jsonl`
> - 代码：`electron/toolChatLoop.ts`、`src/shared/agentToolResult.ts`、`src/shared/processResultProjection.ts`、`src/shared/requestContext.ts`、`src/shared/contextMeter.ts`、`src/shared/toolResultLimits.ts`、`src/shared/oversizedToolResult.ts`、`electron/claudeStreamHandlers.ts`
> - 外部对照：OpenAI Codex 官方仓库 `F:\Develop\codex`（`codex-rs/`）
> - 同目录相关文档：`edit-file-match-failure-diagnosis-and-improvement-plan.md`（编辑失败降级，**与本议题同源不同点**）、`message-fact-pipeline-prompt-cache-optimization-plan.md`、`run-shell-windows-host-init-failure-diagnosis-and-improvement-plan.md`
>
> 修订记录见文末 **§12**。

## 1. 结论摘要

### 1.1 核心结论

**本会话的 Token 成本由「上下文体积 × 请求轮数」主导，而不是由缓存命中率主导。**

提示缓存命中率已达 **98.16%**，接近天花板；进一步提命中率的空间有限。**真正可优化的浪费只有一处**：

1. **turn 边界反复破坏缓存前缀**——19 个 turn 首请求中共 16 次出现 `cache_read` 显著回退，按**实测口径**为 **438,640 tokens 未命中**（占全部未命中输入的 **54.2%**，占等效总成本约 **8.1%**）。<br>注：v1.1 曾用「环比降幅之和」给出 526,720 / 65.1% / 9.7%，该口径会把新增内容重复计入，**已按 N3 更正为上表实测值**（526,720 可视为上界估计）。<br>**成因未闭环**（§3.4），但 v1.1 提出的「断点随尾移动」候选**已被本轮数据排除**（§3.7），现存唯一候选是 **turn 边界 messages 前缀变化**（§3.4.5）。

而在「上下文体积」这一侧，v1.0 的结论已被推翻（§1.3 纠正 B1）：**模型面上下文的构成是正常的**——

| 模型面工具结果（累计） | ≈tokens | 占模型面工具结果 |
|---|---|---|
| `read_file` | **116,487** | **49.8%** |
| `run_script` | 49,197 | 21.0% |
| `grep` | 41,454 | 17.7% |
| `list_directory` | 17,705 | 7.6% |
| **`edit_file`** | **4,049** | **1.7%** |
| 其余（toolkit_* / run_shell / write_file） | 4,879 | 2.1% |
| **合计** | **233,771** | — |

**`edit_file` 在模型面只占 1.7%**——它在**事件流面**占 89.0%，两个面差 **484.9 倍**。故 `edit_file` 的 `diff` 字段既不是 token 成本项，也不在上下文里；它是**磁盘/备份体积**问题（§3.3、§5.3）。

**结论排序（v1.3）**：唯一具规模的 token 优化项是 **turn 边界缓存失效（≈438,640 eq，8.1%）**；其次是 **tools 前缀精简（≤3.3%）**；其余为防灾与磁盘治理。

**v1.2 的两处方向性修正**：① 候选 B（断点随尾移动）**已被排除**，P0-2 的重心移到候选 A（messages 前缀），并新增一个**可先于埋点执行**的代码级排查方向（§3.4.5）；② P1-3 的体积数字统一改为 **UTF-8 字节**口径，收益从 16.7 MB 更正为 **24.48 MB（20.45%）**（§3.3.2）。

**v1.3 的三处修正**（详见 §12 v1.3）：

1. **撤销 v1.2 对评审的「驳回」**——`tools` 正确值为 **57,117 字符 / 89,098 字节**（v1.2 的 59,674 系分析脚本的分隔符口径错误），由 `toolsTokens = 16,320` **精确印证**（§3.3.2）；
2. **§3.4.5 的静态比对输入前提不成立**——`messagesForApi` 不落盘，改为「测试内驱动一轮并前向捕获 `finalSurfaceMessages`」（§3.4.5 / §6 / §7.3）；
3. **§3.4.2 的 TTL 反证更换**——原论据（#49）恰好与 TTL 同向，改用 **#46（80.8s → 89,216）vs #49（7,331.5s → 11,264）**。

**三条均不影响结论方向**；修正后 P0-1 / P0-2 / P1-3 的优先级与收益量级不变。

### 1.2 按投入产出比排序

| 优先级 | 动作 | 章节 | 效果影响 | 预估收益（等效 tokens / 占比） | 置信度 |
|---|---|---|---|---|---|
| **P0-1** | **双面埋点**：messages 面（公共前缀 / 分歧位置）**+ wire 面（断点位置/数量）** | §5.2 | 无 | **定位 438,640 的前提**（无收益，但是其余项的前提） | 高 |
| **P0-2** | **turn 边界缓存失效的消除**（候选 A：messages 前缀；**候选 B 已排除**） | §5.3 | 无 | **≤438,640 eq（≈8.1%）** | 中 |
| P1-3 | **事件流体积治理**：`edit_file.diff` 死字段（**10.83 MB**）+ `request_header` 重复写入 `system`/`tools`（**13.65 MB**） | §5.1 | 无 | **≈24.48 MB/会话（20.45%，UTF-8 字节）**（磁盘/备份/IO，**非 token**） | 高 |
| P1-4 | 工具结果上限下调 + 中段截断 | §5.4 | 无 | 防灾（当前未触发） | 高 |
| P1-5 | `read_file` 重复读取去重 | §5.5 | 无 | ≈16,960 eq（**0.3%**） | 中 |
| P1-6 | tools 前缀懒加载 | §5.6 | 中风险 | ≤179,872 eq（**≤3.3%**） | 低 |
| **撤回** | 轮内批量 / 并发执行 | §5.7 | — | **不成立**（能力已具备） | — |

**建议执行顺序：静态比对（§3.4.5）→ P0-1 埋点 → P1-3 → P0-2 → P1-4/5 →（评估后）P1-6。**

**为什么 P0-1 排第一**：438,640 的成因尚未闭环（§3.4.4），且候选 B 排除后，**messages 面埋点成为唯一关键路径**（§3.4.5）。**先埋点、再改，避免第三次归因错误**（v1.0/v1.1 已因此各纠正一次，见 §1.3 纠正 1 与纠正 5）。

> **v1.2 补充**：候选 A 家族中存在一个**可先于埋点执行**的排查方向——「turn 首请求从 DB 重建历史 vs turn 内实时累积」的序列化差异（§3.4.5）。该方向可做**静态代码比对**，若能在埋点前定位，P0-1 可作为最终实证手段而非唯一手段；故 §6 已把它列为 **Phase 0 首项**。

**v1.0 排序为何失效**：v1.0 把「`edit_file` 瘦身」列为 P0-1，前提是它占模型上下文 89%。该前提已被推翻（§1.3 纠正 3）——真实占比 **1.7%**。故该项降级为 P1-3（磁盘口径），并把「定位 turn 边界失效」提为 P0-1。

### 1.3 五处自我纠正（重要）

本文的结论是在多轮取数中逐步逼近的，此前有**五处**结论被后续数据/代码核实推翻，在此显式记录，以免沿用。**其中纠正 3、4、5 由两轮评审的阻断项触发。**

| # | 前期结论 | 后续证据 | 修正后结论 |
|---|---|---|---|
| **纠正 1** | 526,720 tokens 的缓存失效源于 **turn 边界的压缩路径**（`planTurnBoundarySurfaceCompaction`） | ① 全量事件流**无任何 compaction / summary 类事件**（事件类型仅 10 种，见 §3.4.3）；② `bodyRatio` 峰值仅 **0.502**，远低于 `triggerRatio=0.9`；③ `shouldCompact()` 在 `claudeStreamHandlers.ts:466` 短路 | **归因未定**。v1.1 曾提出两个候选（messages 改写 / 断点随尾移动）；**后者已在 v1.2 被排除**（纠正 5），**现存唯一候选是 messages 前缀变化**（§3.4.5）。**这正是 P0-1 埋点被列为第一步的原因** |
| **纠正 2** | 工具循环是「串行执行、每轮一个工具」，故并发/批量是待建设能力 | 实测该会话**每轮平均 2.65 个工具调用**，最多一轮 12 个；127 个含工具调用的轮中，74 轮为多调用 | **轮内多调用早已支持**。批量能力已具备，无需新建；并发执行仅影响墙钟（占比 <1%），**§5.7 撤回** |
| **纠正 3（B1）** | `edit_file` 把整份文件 diff 注入**模型上下文**，占全部工具结果 **89%**（v1.0 §3.3 的核心论断） | ① 代码：`autoApprovedWrite` 只在 `toolChatLoop.ts:2688` 并入 `recordToolResult` 的**第二参数**（事实载荷），模型侧内容取自 `execResult`（`2615-2623`）；② 历史重建走**字段白名单**投影，`autoApprovedWrite` 被丢弃（`claudeToolHistory.ts:36-53`、`processResultProjection.ts:622-646`）；③ **实测双面**：`edit_file` 事件流面 6,872,645 字符 / **模型面仅 14,172 字符（倍差 484.9）**，模型面占比 **1.7%**（§3.3） | **口径面混淆**：v1.0 测的是**事件流面**，误当作模型上下文。`edit_file` 不是 token 成本项，而是**磁盘/备份体积**问题（P1-3）；**P0-1 原方案是 no-op**（目标状态即现状） |
| **纠正 4（B2）** | 「全仓生产代码 `cache_control` 零命中」，故缓存断点需从 0 开始建设 | `claudeToolLoopStreamParams.ts:34-41` 是活跃注入代码，`toolChatLoop.ts:1012` 传 `cacheControl: true` → **每个请求已注入 system + 尾部字符串消息两个断点** | **断点已存在**（该事实成立），P0-2 改为「盘点并重设计」而非从零建设。v1.1 曾据此进一步推断「断点随尾移动是 526,720 的最强候选成因」——**该推断已被纠正 5 推翻** |
| **纠正 5（R1，v1.2 新增）** | 「断点随尾移动」是 526,720 的**最强候选成因**，路径 B（断点重设计）由此成为 P0-2 主线 | 按 `round` 分组复测同一快照的 145 次 `request_usage`：**`round:2+`（126 次）无任何消息级断点、仅剩 system 断点**，却 `cache_read` 合计 **37,818,240**、未命中仅 **370,043**（命中率中位 **99.6%**）。若网关按 Anthropic 官方显式断点语义读取，这些请求至多命中 system+tools ≈ 17,444/次，未命中应 ≥ **35,990,339**——**与实测相差 97 倍** | **网关采用（至少等效于）隐式前缀缓存，对 `cache_control` 的位置不敏感**。断点位置变化**不可能**造成前缀失效 ⇒ **候选 B 排除，路径 B 大概率无效**（§3.7、§5.3）。P0-2 重心移到候选 A（§3.4.5） |

**v1.0 §3.5「净留存仅 19%」已被纠正 3 取代**：该 ratio 的**分母（2,206,122）按事件流字符估算，系统性高估 9.4 倍**；按模型面重算后 ratio = **1.78**（正常量级）。故 v1.0 提出的三个「替换/裁剪机制」候选假设**全部删除**（§3.5）。

## 2. 取数口径与方法

### 2.1 数据源

| 项 | 值 |
|---|---|
| 文件 | `sessions/b680b181-.../events.jsonl` |
| 快照字节 | 119,684,980 |
| 快照事件数 | 311,786 |
| 事件类型 | 仅 10 种（见 §3.4.3） |

**时效声明**：`b680b181` **是当前仍在运行的会话**（分析本身就在其中进行），事件流随每一次工具调用持续增长。本文所有数字均为**某一时点的快照**，非终值。跨轮次对比时须注意此点——例如 `edit_file` 调用数在分析过程中由 74 增至 101（会话在此期间继续运行）。

### 2.2 用量口径

用量取自 `request_usage` 事件（`source=api`）。**关键：`cacheSemantics=additive`**，因此：

```
总输入 tokens = input_tokens + cache_read_input_tokens + cache_creation_input_tokens
```

不可只用 `input_tokens`（那是「未命中、按全价计费」的部分）。

### 2.3 等效成本口径

由于缓存读取与未命中输入的单价不同，本文用「等效 tokens」做横向可比：

| 项 | 计价系数 | 依据 |
|---|---|---|
| `cache_read` | **× 0.1** | Anthropic 系缓存读取约按 10% 计价 |
| `input`（未命中） | × 1.0 | 全价 |
| `output` | × 1.0 | 全价 |

**该系数用于比较不同优化项的收益排序，不代表账单金额。**

### 2.4 工具结果体积口径：必须区分两个面（B1 核心）

**`tool_result` 事件里的 `payload.result` 与「模型实际收到」的内容，是同一个 `execResult` 的两个兄弟分支，不是上下游。**

````text
                      execResult（执行器原始结果）
                    ├────────────────┬────────────────┐
   ① 模型面 ────────┘                │                └──── ② 事实面
   formatToolResultPayload(execResult)                   factResult = projectAgentToolResult(
   = serializeAgentToolResult({success,data,error,userMessage})   ...)
     → projectAgentToolResultForSink → 字段白名单          + 显式并入 autoApprovedWrite /
       {success, error, userMessage, data, diagnostic}       displayData / dependencyRecovery
       （autoApprovedWrite 被精确剔除）                      （toolChatLoop.ts:2687-2693）
     → compactToolResultContentForApi（2 MiB 上限）              │
        │                                                        ▼
        ▼                                              recordToolResult(block, result)
   toolResultBlock                                          → emitSessionEvent({type:'tool_result',
   → messagesForApi → 发给模型                                 payload:{result}})
   ← 上下文体积                                               → DB / 会话备份
                                                             ▼
                                                       events.jsonl 的 payload.result
                                                       ← v1.0 的测量点（错标为「模型面」）
````

关键代码（`electron/toolChatLoop.ts`，行号已按 N1 复核更正）：

````ts
// ① 模型面：取自 execResult，不含 autoApprovedWrite
const rawPayload = formatToolResultPayload(execResult, { workspaceRoot: workDir, processTool })  // :2615
let payload = compactToolResultContentForApi(rawPayload, { requestId, sessionId, toolUseId })    // :2619
toolResultBlock = { type: 'tool_result', tool_use_id: toolUseId, content: payload }              // :2631

// ② 事实面：autoApprovedWrite 只在此并入 recordToolResult 的第二参数
const factResult = projectAgentToolResult({ ... })                                               // :2682
await recordToolResult(toolResultBlock, {                                                        // :2688
  ...factResult,
  ...(execResult.success && fileAutoApproveMeta ? { autoApprovedWrite: fileAutoApproveMeta } : {})  // :2691
})
````

`recordToolResult`（定义于 `:1473`）：`block` → `toolResults`（`:1469`）→ `messagesForApi`（**进模型**，末尾于 `:2706` 追加）；`result` → 事件流 + 事实管道（**不进模型**）。

> **v1.1 的行号曾标错**（写为 2612/2616/2646/2687），v1.2 已逐条复核更正为 2615/2619/2631/2688。

**历史重建路径同样分离**：`src/shared/claudeToolHistory.ts:36-53`（`buildToolResultBlock`，**调用方**）→ `serializeAgentToolResult` → 白名单由**两处共同**实现：`src/shared/agentToolResult.ts:12-35`（`AgentToolResultInput` 入参类型收窄）+ `processResultProjection.ts:639-645`（`projectToolResultForSink` 内**显式构造**白名单对象），仅投影 `success / error / userMessage / diagnostic / data`，`autoApprovedWrite` 与 `displayData` **一律丢弃**。

> **归因更正（v1.3 / v1.4）**：v1.1–v1.2 把 `claudeToolHistory.ts:36-53` 直接标为「字段白名单」位置，**不准确**（该处只是调用方）；v1.3 改为 `processResultProjection.ts:622-646`（整个函数范围），v1.4 精确到 **`639-645`（白名单对象构造）** 并补 `agentToolResult.ts:12-35` 的类型收窄。结论方向始终成立。

**换算规则（本文全篇遵守，违反即为 v1.0 的错误）**：

| 面 | 定义 | 测量方法 | 对应成本 |
|---|---|---|---|
| **事件流面** | 落入 `events.jsonl` 的 `payload.result` | 直接取该 JSON 长度 | **磁盘 / 备份 / IO** |
| **模型面** | 模型实际收到的 `toolResultBlock.content` | 取 `payload.result` **剔除** `autoApprovedWrite` / `displayData` / `dependencyRecovery` 后的长度 | **上下文 / token** |

**实测倍差**（同一快照）：`edit_file` **484.9 倍**、`write_file` **195.6 倍**、其余工具 **1.0 倍**（无被剔字段）。详见 §3.3。

> **口径精度说明**：模型面与 `serializeAgentToolResult` 的实际输出间存在**唯一系统性差异**——键名映射（`success` → `ok`，每次 5 字符），336 次合计 < 2 KB（**0.2%**），不影响任何结论（本轮评审已确认）。

> **v1.0 的错误（纠正 3）**：v1.0 把 `payload.result` 当作模型面测量点，据此断言 `edit_file` 占模型上下文 89%。该管线方向不成立。

## 3. 发现

### 3.1 消费画像（时点快照）

| 指标 | 值 |
|---|---|
| API 请求（`request_header`） | **146** |
| 其中回报 usage 的（`request_usage`） | **145**（N4 更正；1 次请求无 usage） |
| turn | **19**（`turn_start`） |
| 工具调用 | **336** |
| 未命中输入 | **808,683** |
| 缓存读取 | **43,081,088** |
| 缓存写入 | **0**（全程恒为 0；**含义见 §3.7**——provider 计量语义，非「未打标」） |
| 输出 | **320,199** |
| 总输入 | **43,889,771** |
| **提示缓存命中率** | **98.16%** |
| 平均单请求输入 | **300,615** |
| 固定前缀 `prefixTokens` | **17,444**（system 1,124 + tools 16,320） |
| `messageTokens` 峰值 | **337,497** |
| `bodyRatio` 峰值 | **0.502**（触发线 `triggerRatio=0.9`） |
| 墙钟跨度 | **14.49 小时** |

### 3.2 成本结构：体积 × 轮数主导

| 项 | 等效 tokens | 占比 |
|---|---|---|
| `cache_read` 43,081,088 × 0.1 | ≈4,308,109 | **79%** |
| 未命中输入 808,683 × 1.0 | 808,683 | 15% |
| 输出 320,199 × 1.0 | 320,199 | 6% |
| **合计** | **≈5,436,991** | — |

**解读**：`cache_read` 以 79% 占比成为成本主体，而它的大小 = **上下文体积 × 请求次数**。因此优化杠杆有两个：**减小上下文体积**、**减少请求次数**。而命中率本身已 98.16%，继续优化的边际收益低于前两者。

> 注：`cache_read` 已按 0.1× 折算。若按未折算的原始 43.08M 与 0.81M 未命中相比，会得出「命中率是最主要问题」的错误直觉——实际上命中率的**剩余损失空间只有 1.84%**，而体积与轮数的压缩空间远大于此。

### 3.3 发现 A：两面的体积构成完全不同（B1 修正）

**同一份 `payload.result`，两个面的体积相差 9.4 倍**：

| 工具 | 调用 | **事件流面**字符 | 占比 | **模型面**字符 | 占比 | 倍差 |
|---|---|---|---|---|---|---|
| **`edit_file`** | 101 | **6,872,645** | **89.0%** | **14,172** | **1.7%** | **484.9** |
| `read_file` | 69 | 407,705 | 5.3% | 407,705 | **49.8%** | 1.0 |
| `run_script` | 58 | 172,190 | 2.2% | 172,190 | 21.0% | 1.0 |
| `grep` | 85 | 145,090 | 1.9% | 145,090 | 17.7% | 1.0 |
| `list_directory` | 11 | 61,966 | 0.8% | 61,966 | 7.6% | 1.0 |
| `write_file` | 2 | 44,985 | 0.6% | **230** | 0.0% | **195.6** |
| `toolkit_call` | 4 | 10,438 | 0.1% | 10,438 | 1.3% | 1.0 |
| `toolkit_find` | 4 | 3,415 | 0.0% | 3,415 | 0.4% | 1.0 |
| `run_shell` | 2 | 2,992 | 0.0% | 2,992 | 0.4% | 1.0 |
| **合计** | **336** | **7,721,426** | — | **818,198** | — | **9.4** |

**两个结论（方向相反，不可混用）**：

1. **模型面（token 成本侧）**：`read_file` 是最大贡献者（**49.8%**），其后是 `run_script`（21.0%）、`grep`（17.7%）。**`edit_file` 仅 1.7%——它不是 token 优化对象**。
2. **事件流面（磁盘侧）**：`edit_file` 独占 **89.0%**（单次最大 96,190 字符）——它是**磁盘/备份体积**优化对象（P1-3）。

模型面合计 818,198 字符 ≈ **233,771 tokens**（÷3.5），构成见 §1.1 表。

#### 3.3.1 根因：`diff` 只在事实面，且只写不读

`edit_file` 的 `payload.result`（**事件流面**）结构：

```jsonc
{
  "success": true,
  "data": { "path": "...", "bytesWritten": 34462 },   // ← 模型面仅此（模型侧 content ≈ 144 字符）
  "autoApprovedWrite": {                               // ← 只落事件流 / DB
    "path": "...", "added": 49, "removed": 8, "bytesWritten": 34462,
    "diff": { "oldContent": "<修改前完整文件>", "newContent": "<修改后完整文件>" }
  }
}
```

落点 `electron/toolChatLoop.ts:1900-1909`（行号按 N1 更正）：

```ts
const stats = diff ? computeDiffLineStats(diff.oldContent, diff.newContent) : { add: 0, remove: 0 }
fileAutoApproveMeta = {
  path: relPath, added: stats.add, removed: stats.remove, bytesWritten,
  ...(diff ? { diff } : {})      // ← 含 oldContent / newContent 全文；仅并入事实载荷（:2691）
}
```

**该字段目前是「只写不读」的死数据**：全仓 `autoApprovedWrite` 仅 5 处命中（`domainTypes.ts:553` 类型定义、`toolChatLoop.ts:2691` 写入、`toolChatLoop.fileAutoApprove.test.ts:153-162` 断言、文档），**渲染层零引用**——UI diff 卡片走的是 `confirmDiff`（confirm 链路，`WriteConfirmCard.tsx:23`、`WriteSuccessCard.tsx:14`），IM / 审计亦不读它。唯一去向是 **events.jsonl 落盘 + DB / 会话备份**。

实测：会话内含 102 条 `oldContent` 全文，`edit_file` 事件流面合计 **6,872,645 字符**（占 events.jsonl 总字节 **6.2%**）。

#### 3.3.2 同类问题：`request_header` 每次重复写入完整 `system` + `tools`

按事件类型统计 events.jsonl 体积（同一快照 311,786 行）：

| 事件类型 | 事件数 | 字符（含换行） | **UTF-8 字节** | 字节占比 | 放大 |
|---|---|---|---|---|---|
| `assistant_chunk` | 310,329 | 91,874,980 | 92,178,762 | 77.0% | 1.00 |
| **`request_header`** | **146** | 9,821,944 | **14,557,454** | **12.2%** | **1.48** |
| `tool_result` | 336 | 7,792,867 | **11,973,711** | **10.0%** | **1.54** |
| 其余 7 类 | 975 | 898,178 | 975,053 | 0.8% | 1.09 |
| **合计** | **311,786** | **110,387,970** | **119,684,980** | 100% | **1.08** |

> **口径更正（R2）**：v1.1 该表把**字符数**标为「字节」（占比 8.9% / 7.1%），v1.2 改为 UTF-8 字节。**中文内容的多字节放大 1.5 倍**，故 `request_header` / `tool_result` 的真实占比显著高于 v1.1 所写（12.2% / 10.0%）。
>
> 字节合计 119,684,980 与文件实际大小**逐字节吻合**，可作口径校验点。

`request_header` 在 `RequestHeaderPayload` 中携带**完整 `system`（3,934 字符 / 4,388 字节）与完整 `tools`（57,117 字符 / 89,098 字节）**（`src/shared/requestContext.ts:36-45`），**每个请求重复写一次**：

```
146 次 × 93,486 字节 ≈ 13.65 MB / 会话
```

而这两个值**全程恒定**（`systemFingerprint=26a5d805`、`toolsFingerprint=3acfbf90`，§3.7）。即与 `edit_file.diff` 同构的问题：**每次都写全量、且内容不变**。

> **`tools` 字符数的更正（v1.3）**：正确值为 **57,117 字符 / 89,098 字节**。v1.1–v1.2 写的「59,674」是**测量脚本的分隔符口径错误**——分析脚本用 Python `json.dumps` 的**默认分隔符**（`, ` / `: `，**带空格**）计得；生产代码用的是 **JS `JSON.stringify`**（紧凑，无空格）。
>
> **决定性印证**：`buildRequestHeaderPayload` 以 `estimateTokensFromUtf8Text(JSON.stringify(args.tools))` 计算 `toolsTokens`，而该函数为 `Math.ceil(text.length / 3.5)`（`src/shared/contextUsageEstimate.ts:80-82`）。实测 `surfaceSnapshot.toolsTokens = 16,320`：
>
> - `57,117 / 3.5 = 16,319.14 → 16,320` ✓ **精确吻合**
> - `59,674 / 3.5 = 17,049.71 → 17,050` ✗ 不吻合
>
> v1.2 曾判定「59,674 可复现、属格式差异」，**该判定错误**（§12 v1.3 记录）。字节口径的收益结论不受影响：(b) 项按 **89,098 字节/次** 计。

第三大字段是 **`toolExecutionCheckpoint`（平均 5,559 字符，最大 11,815；TS 紧凑口径）**——v1.1 未识别，详见 §5.1.4 与 §7.2。

> `assistant_chunk`（77.0% 字节）是流式增量，属固有成本，不在优化范围。故事件流面的**可优化总量 ≈ 12.2% + 10.0% ≈ 22.2%**，但按「死字段 / 恒定重复」实际可去除的部分为 **≈24.5 MB（20.5%）**（§5.1.5）。

### 3.4 发现 B：turn 边界缓存失效（成因未闭环，候选 B 已排除）

> v1.2 标题变更：v1.1 写「526,720 tokens（归因未定）」。按 N3，主口径改用**实测未命中** 438,640（§3.4.1）；且候选 B 已被排除（§3.7），故「归因未定」改为「成因未闭环」。

#### 3.4.1 测量（两种口径）

**口径 A（主口径：按 round 分组实测未命中）**——145 次 `request_usage`：

| 分组 | 请求数 | 消息级断点 | `cache_read` 合计 | **未命中合计** | 命中率 |
|---|---|---|---|---|---|
| `round:1`（turn 首请求） | **19** | 有（尾条为字符串） | 5,262,848 | **438,640** | 92.3% |
| `round:2+`（turn 内后续） | **126** | **无**（尾条为 `tool_result` 数组，仅剩 system 断点） | **37,818,240** | **370,043** | 合计 99.0% / 中位 **99.6%** |
| **合计** | **145** | — | 43,081,088 | **808,683** | **98.16%** |

- **438,640 / 808,683 = 54.2%**——即全部未命中输入中约**一半以上**来自 19 个 turn 首请求（占等效总成本 ≈ **8.1%**）；
- `round:2+` 的 126 次请求**没有任何消息级断点**，却仍有中位 **99.6%** 的命中率——**这一列是 R1 排除候选 B 的直接依据**（§3.7）。

**口径 B（辅助：相邻请求 `cache_read` 环比）**——出现 16 次大幅下降（降幅 > 3,000），**全部发生在 `round:1`**：

| 请求 # | round | 失效量（环比降幅） | 此后 msgTok |
|---|---|---|---|
| #18 | 1 | 46,208 | 31,406 |
| #36 | 1 | 96,640 | 95,755 |
| #40 | 1 | 17,280 | 104,935 |
| #46 | 1 | 89,216 | 171,004 |
| #49 | 1 | 11,264 | 178,021 |
| #54 | 1 | 28,672 | 195,586 |
| #57 | 1 | 13,696 | 208,213 |
| #78 | 1 | 45,312 | 228,850 |
| #82 | 1 | 4,352 | 230,911 |
| #90 | 1 | 11,520 | 237,574 |
| #95 | 1 | 20,992 | 250,496 |
| #109 | 1 | **94,720** | 287,396 |
| （另 4 次，明细省略） | 1 | 46,848 | — |
| **合计** | **16 次** | **526,720** | — |

> **两种口径的关系（N3 更正）**：口径 B 的 526,720 是「`cache_read` 环比降幅之和」，会把**新增内容**重复计入，故属**上界估计**；口径 A 的 438,640 是**实际未命中**（`input_tokens + cache_creation`），本文以 A 为主口径。v1.1 曾用口径 B 推出「65.1% / 9.7%」，v1.2 更正为 **54.2% / 8.1%**。
>
> 注意 19 个 turn 首请求中，**只有 16 次**出现显著环比降幅——即**并非每个 turn 边界都失效**。

- #18 最典型：`cache_read` 从 71,424 回退到 **25,216**，而 turn1 的 `round:1` 恰为 **25,088**——**几乎精确回到「该 turn 起始时的前缀深度」**（机制解读见 §3.4.5）。

#### 3.4.2 排除 TTL 假说

**v1.3 更正论据**：v1.1–v1.2 用「#49（空闲 7,334s）失效仅 11,264」作反证，但该组**恰好与 TTL 假说同向**（空闲越长、失效越大），论据选择不当。改用下面的**反例组**——空闲最短的一次反而失效极大：

| 请求 # | 与上一请求的空闲间隔 | 失效量 | 与 TTL 假说的关系 |
|---|---|---|---|
| **#46** | **80.8 秒** | **89,216** | ✗ 空闲极短却失效极大 |
| #36 | 1,187.4 秒 | **96,640**（最大） | ✗ 失效最大一次，空闲仅约 20 分钟 |
| #49 | 7,331.5 秒 | 11,264 | ✗ 空闲 2 小时，失效反而很小 |
| #109 | 32,032.8 秒 | 94,720 | ✗ 空闲最长，量级与 #36 相近 |

**决定性对比**：**#46（80.8 秒 → 89,216）vs #49（7,331.5 秒 → 11,264）**——**空闲相差 90 倍，失效方向相反（短空闲反大 7.9 倍）**。

全部 16 次失效的「空闲 vs 失效量」相关系数仅 **0.449**（中等偏弱，由 #36 / #109 两个大值拉动得上偏），**不足以支持时间主导**；且 #46 是强反例。

**结论：TTL 不是主导机制**——同一次测量中，最短空闲产生最大级失效、最长空闲产生小失效，单凭时间无法解释。（TTL 作为**次要因素**仍不能完全排除，但不足以解释 438,640 的主体。）

#### 3.4.3 三个指纹全程恒定 → 变化在 messages 段（**但仅限计划面**）

| 指纹 | 全程取值 |
|---|---|
| `stablePrefixFingerprint` | `f630ff26`（恒定） |
| `systemFingerprint` | `26a5d805`（恒定） |
| `toolsFingerprint` | `3acfbf90`（恒定） |

`stablePrefixFingerprint = fingerprint(systemFingerprint + ":" + toolsFingerprint)`（`src/shared/requestContext.ts:80`），恒定说明 **system 与 tools 前缀极稳定**——这部分做得很好。

> **限定（B2 补注 → v1.2 更新）**：这三个指纹由 `request_header` 计算，而 `request_header` 记录的是**计划面**（`plannedMessages = wireMessages`，`toolChatLoop.ts:1016-1017`）。serializer 的 **wire 面改写不进指纹**——`buildClaudeToolLoopStreamParams` 会注入 `cache_control`，而 `systemFingerprint` 基于 `systemPrompt` 原串。
>
> v1.1 因此认为「指纹恒定 ⇒ 失效来自 messages 段」**只对计划面成立**，并把「wire 面断点变形」列为并列候选（候选 B）。**v1.2 已排除候选 B**（§3.7：`round:2+` 无消息级断点仍有中位 99.6% 命中）——故本结论恢复为**主结论**：**失效来自计划面 messages 段的前缀变化**。
>
> wire 面埋点（§5.2）因此从「区分 A/B 的必需项」降为「**实证排除 B + 兜底**」；**messages 面埋点是唯一关键路径**。`toolChatLoop.ts:1018` **已计算 `wireHeader`** 但**未落事件流**，可直接落盘（成本极低），用于对候选 B 做最终实证。

#### 3.4.4 成因未闭环：观测缺口

三条排除：

1. **不是压缩路径**。全量事件流仅 10 种类型，**不含任何 compaction / summary / shadow 事件**：
   ```
   turn_start / step_start / request_header / request_context / assistant_chunk
   / tool_call / request_usage / tool_result / step_end / turn_end
   ```
2. **未达压缩阈值**。`shouldCompact()` 要求 `projectedBodyTokens / bodyBudget ≥ triggerRatio`；实测 `bodyRatio` 峰值 **0.502**，全程未接近 0.9。
3. **压缩入口被短路**。`electron/claudeStreamHandlers.ts:466`：
   ```ts
   if (!eventWriter || !projection || !shouldCompact(projection, budget) || messages.length < 3) return
   ```

**而 `events.jsonl` 的 `request_header` 只记 `system`、`tools`、三个指纹与 token 计数，不记录 messages 数组**（已核实：`request_header` 的 10 个字段中无 messages，`request_context` 的 17 个字段中亦无）。因此**从现有日志无法定位到具体是哪个 message item 发生了变化**。

这是本次分析中唯一没能闭环的问题，也是 P0-1（messages 面埋点）的直接动因。

#### 3.4.5 候选 A 的具体方向：turn 边界的两条 messages 构建路径

排除候选 B 后，唯一剩余候选是 **turn 首请求的 messages 前缀与上一 turn 末轮不一致**。本轮补入一个**可先于埋点执行**的排查方向：

| 请求 | messages 来源 |
|---|---|
| `round:1`（turn 首请求） | `claudeStreamHandlers.ts:343` → `buildToolChatMessagesFromSource`（**从 DB `authoritative.messages` 重建**）→ `projectReplaySurfaceWithSources`（surfaceReplay 投影） |
| `round:2+`（turn 内后续） | `toolChatLoop.ts:829` 以 `initialMessages` 初始化 `messagesForApi`，之后**实时追加**（`:1314` assistant、`:1337/:1358/:1386` 恢复分支、`:2706` tool_results） |

两条路径对**同一段历史**的产出若在任何 item 上不同，前缀即从该点分歧，且**必然发生在 `round:1`**——与「16 次失效 100% 在 `round:1`」吻合。

**可产生差异的已知环节**（均需比对确认，属候选而非结论）：

| 环节 | 位置 | 可能的差异 |
|---|---|---|
| 文本归一 | `claudeToolHistory.ts:71-74` `ensureApiTextContent`（`trim()`，空则单空格 `' '`） | 重建路径会 `trim()`；实时路径直接落 `content` |
| tool_result 再投影 | `claudeToolHistory.ts:43-52` → `serializeAgentToolResult` | 重建走 **DB 反序列化的 `tc.result`**；实时走内存 `execResult` |
| 超长结果压缩 | `claudeToolHistory.ts:60` `compactOversizedToolResultContent`（日志 `source: 'history-rebuild'` 的**上报点**在 `chatMessageBuild.ts:35`）（v1.4 更正） | 重建路径**独立再次压缩** |
| `tool_use` 块过滤 | `toolChatLoop.ts:1306-1312` | 实时路径会丢弃**空/无效 id** 的 `tool_use` 块，重建路径不一定 |
| surfaceReplay 投影 | `projectReplaySurfaceWithSources`（`surfaceReplay.ts`） | 重建路径**额外经过** replay 投影层 |

**#18 的形态支持**：`round:1` 的 `cache_read` = 25,216，而 turn1 `round:1` = **25,088**——几乎精确回到「turn 起始的前缀深度」。若两个 turn 的 `round:1` 由同一重建函数产出、且产出只取决于「DB 中已固化的历史」，则该数值接近是**预期行为**；而 turn 内累积到 71,424 的前缀**未被复用**，说明**两条路径的产出确实不同**。

**建议验证顺序（可先于埋点）**：

1. **静态比对（成本最低、最可能直接定位）**：写一个**驱动完整两轮**的测试，**在第一轮结束时于测试内前向捕获** `runToolChatSession` 返回的 `finalSurfaceMessages`（`toolChatLoop.ts:543`），再把它与第二轮 `round:1` 经 `buildToolChatMessagesFromSource` 重建的产出**逐 item 比对（含 JSON 逐字节）**。

   > **输入前提更正（v1.3）**：**不能**写「用同一份 turn N 结束时的 `messagesForApi`」——`messagesForApi` 是 `runToolChatSession` 的**局部变量**，只在函数返回时以 `finalSurfaceMessages` 形式暴露（`claudeStreamHandlers.ts:566` 透传，**无落盘、无渲染层消费方**），历史时刻的值**不可事后复现**。因此该测试必须**前向驱动真实一轮**并即时捕获，不能用静态 fixture 拼接代替。

2. 若静态比对无差异，再做 P0-1 的 messages 面埋点（§5.2），定位**运行时**的实际分歧点。

> 该方向由 R1 评审提出。本文采纳，并补充「可产生差异的环节清单」、验证顺序与**输入捕获方式的更正**；上述环节均为候选，**未经逐条核实**。

### 3.5 发现 C：模型面净留存 ratio = **1.78**（v1.0 的「19%」已撤销）

按 turn 聚合「请求首末 `messageTokens` 之差」与工具结果字符量，**双口径对照**：

| turn | 请求数 | 净增长(msgTok) | 事件流面字符 | **模型面字符** | 模型面≈tokens | **ratio(模型面)** |
|---|---|---|---|---|---|---|
| 1 | 17 | 33,710 | 93,316 | 93,316 | 26,662 | 1.26 |
| 2 | 18 | 75,588 | 192,949 | 192,949 | 55,128 | 1.37 |
| 4 | 6 | 69,064 | 222,928 | 222,928 | 63,694 | 1.08 |
| **9** | 21 | 28,830 | 634,527 | **46,868** | 13,391 | 2.15 |
| **12** | 8 | 7,622 | 594,178 | **13,866** | 3,962 | 1.92 |
| **14** | 14 | 66,777 | 1,766,109 | **66,713** | 19,061 | 3.50 |
| **15** | 8 | 8,862 | 848,963 | **18,147** | 5,185 | 1.71 |
| **17** | 7 | 5,530 | 624,849 | **6,148** | 1,757 | 3.15 |
| **19** | 15 | 22,650 | 2,410,042 | **24,894** | 7,113 | 3.18 |
| **合计** | **146** | **416,172** | — | **818,198** | **233,771** | **1.78** |

> 表中省略部分 turn；ratio = 净增长 ÷ **模型面**工具结果 tokens。

**修正后的解读（与 v1.0 结论相反）**：

- **ratio = 1.78，量级正常，无异常**。累计输出 320,199 tokens + 模型面工具结果 233,771 tokens = 553,970，与实测累计净增长（416,172）加跨 turn 缩减（79,590）= 495,762 **同量级**。上下文增长由「模型输出 + 工具结果 + 用户输入」共同构成，**不需要引入任何隐藏的替换/裁剪机制**。
- **v1.0 的 ratio = 0.19 是纯测量偏差**：分母按**事件流面**字符估算（2,206,122 tokens），**高估 9.4 倍**；低 ratio 的 turn（9/12/14/15/17/19）恰是 `edit_file` 密集 turn。
- **v1.0 提出的三个候选机制（turn 边界投影替换 / 历史重建丢弃 / 重复读取替换）全部撤销**——偏差即可完全解释，无需额外假设。

**残留观察（无害）**：模型面 ratio 在 `edit_file` 密集 turn（14/17/19）反而**更高**（1.71–3.50），说明那些 turn 的上下文增长主要由**模型输出**主导（修订长文档产生大量文本），符合预期。

> **本节的教训已写入 §9**：「事件流面体积 ≠ 模型上下文体积」是本文最容易犯、且 v1.0 确实犯过的错误。

### 3.6 发现 D：轮内多调用早已支持（纠正「串行单工具」的错误前提）

| 指标 | 值 |
|---|---|
| 含工具调用的轮 | 127 |
| 工具调用总数 | 336 |
| **平均每轮** | **2.65** |
| 最多一轮 | 12 |

分布：

| 每轮工具数 | 轮数 |
|---|---|
| 1 | 53 |
| 2 | 27 |
| 3 | 12 |
| 4 | 16 |
| 5 | 7 |
| 6 | 6 |
| 7 / 9 | 各 1 |
| 10 | 3 |
| 12 | 1 |

**74 轮为多调用**（127 − 53）。实例：

```
[read_file × 5]
[grep × 6, read_file, grep × 3]
[edit_file × 5]
[grep × 6, read_file, grep × 3]
```

**结论**：批量能力（一轮内多工具）**已具备且被常态使用**，无需新建。此前「全仓 grep `parallel_tool_calls` 零命中」只能证明**未配置并行执行标记**，不能证明「一轮一个调用」——这是我前期把「轮内多调用」与「并发执行」混为一谈导致的误判。

### 3.7 发现 E：现有 `cache_control` 断点形态（B2 重写 → R1 排除候选 B）

**生产代码已注入断点**（v1.0 的「`cache_control` 零命中」为事实错误）：

```ts
// electron/claudeToolLoopStreamParams.ts:34-41
const cacheControl = { type: 'ephemeral' as const }
const messages = serializeProviderMessages(args.messages).map((message, index) => {
  const content = index === args.messages.length - 1 && typeof message.content === 'string'
    ? [{ type: 'text', text: message.content, cache_control: cacheControl }]   // ← 仅当末条为字符串
    : message.content
  return { role: message.role, content }
})
const system = args.cacheControl && hasSystem
  ? [{ type: 'text', text: args.system!.trim(), cache_control: cacheControl }]  // ← system 恒注入
  : args.system
```

调用点 `electron/toolChatLoop.ts:1012` 传 `cacheControl: true`。故**每个请求有两个断点**：

| 断点 | 位置 | 稳定性 |
|---|---|---|
| ① `system` | 固定 | **恒定**（`systemFingerprint` 全程不变） |
| ② 尾部字符串消息 | **随尾移动** | **不稳定** |
| — | 末条为 **tool_result 数组**时 | **断点消失** |

**断点 ② 的移动模式（关键）**：

| 请求 | 末条消息形态 | 断点 ② 位置 |
|---|---|---|
| `round:1`（新用户消息） | 字符串 | **跳到新用户消息尾部**（位置突变） |
| `round:2+`（工具结果回灌） | 数组 | **消失**（仅剩 system 断点） |

**v1.2 更正：断点位置不参与前缀匹配，候选 B 已排除（R1）**

v1.1 曾据上表推断：`round:1` 是断点位置突变的唯一时刻，而 16 次失效 100% 发生在 `round:1`，故「断点随尾移动」是 526,720 的**最强候选机制**。

**该推断被本轮分组数据直接否定**：

| 分组 | 请求数 | 消息级断点 | `cache_read` 合计 | 未命中合计 |
|---|---|---|---|---|
| `round:1` | 19 | 有 | 5,262,848 | 438,640 |
| **`round:2+`** | **126** | **无** | **37,818,240** | **370,043** |

`round:2+` 的 126 次请求**完全没有消息级断点**（仅剩 system 断点）。若网关按 Anthropic 官方显式断点语义读取，这些请求至多命中 system+tools（17,444/次），未命中应 ≥ **35,990,339**；而**实测仅 370,043——相差 97 倍**。

⇒ **网关采用（至少等效于）隐式前缀缓存：对每次请求的全量内容无条件写入与匹配，`cache_control` 的位置不参与前缀复用。** 因此断点位置变化**在机制上不可能**造成前缀失效。

> 环比数据亦印证：`round:3` 的 `cache_read`（26,240）≈ `round:2` 的全量输入（26,114），`round:4`（28,416）≈ `round:3` 的全量输入——**写入同样不依赖断点**。
>
> **断点的剩余用途**：wire 面埋点（§5.2）保留，但作用从「区分 A/B」改为「对候选 B 做**最终实证** + 兜底」。若实测 `round:2+` 的 wire 面确无消息级断点而命中率仍高，则 B 正式结案。

**`cache_creation` 恒为 0 的正确解读（N3）**：它**不能**证明「未打标」——断点确已存在。它只能说明 **provider 侧的计量语义**（例如网关采用隐式前缀缓存、不回报写入量）。实测 291 处 `cache_creation_input_tokens` 全部为 0。

**做得好的部分（须守住）**：`stablePrefixFingerprint` / `systemFingerprint` / `toolsFingerprint` 全程恒定，是 98.16% 命中率的基础。注意 `canonicalizeSurfaceMessages()` 已在指纹计算中剥离 `cache_control`（`requestContext.ts:63-66`，注明「指纹比较的是模型可见语义，不把 serializer 的缓存控制元数据当成消息内容」）——这解释了为何注入了 `cache_control` 而指纹仍恒定。

**P0-2 的含义因此改变**：不是「新增 2–4 个断点」，也**不是**「重设计断点位置」（路径 B 已排除，§5.3），而是**治理计划面 messages 的前缀变化本身**（候选 A，§3.4.5）。**现有断点可保留不动**——它们对命中率无负面影响。

## 4. 外部对照：OpenAI Codex

对照仓库 `F:\Develop\codex`（`codex-rs/`，Rust）。逐条结论：

| 议题 | Codex 做法 | 证据 | 对本方案的启示 |
|---|---|---|---|
| **工具结果回执** | `apply_patch` 成功仅回 `Success. Updated the following files:` + `A/M/D <path>`，**无 diff、无 hunk** | `apply-patch/src/lib.rs` `print_summary()`；输出类型仅 `ApplyPatchToolOutput { text: String }` | **模型侧我们已同级**（`edit_file` 模型面 ≈144 字符）；差距在**事实 / 存储侧未分离**（§5.1）——Codex 的 UI 事件与模型回执本就分离 |
| **匹配失败处理** | `seek_sequence` 四级递减降级（精确 → `trim_end` → `trim` → Unicode 标点归一），失败文案极简 | `apply-patch/src/seek_sequence.rs` | 属**编辑层**议题，已在 `edit-file-match-failure-...md` 覆盖；本方案不重复 |
| **缓存前缀复用** | `get_incremental_items()` 严格校验「input 是上一请求的严格扩展」，失败时 `trace!` 记录原因 | `core/src/client.rs` | **P0-2 的模板**：三个 `trace!` 即「前缀在哪个 item 断了」的埋点 |
| **缓存路由键** | `prompt_cache_key = session_id`，跨 fork 共享 | `core/tests/suite/prompt_cache_key.rs` | 我们已有 `windowId`，语义等价 |
| **前缀项稳定性** | 用**内容哈希**生成前缀项 id（`Uuid::new_v5(namespace, serde_json::to_vec(&tools))`），内容不变则 id 不变 | `core/src/client.rs` | **P1-6 的关键**：不是「算好别动」，而是「内容寻址保证不动」 |
| **历史改写原则** | **绝不原地改写**，改为**追加通知**（`REPLACEMENT_NOTICE` / `REMOVAL_NOTICE`） | `core/src/context/world_state/context_window_guidance.rs` | **P0-2 路径 A 的主要手段**：append-notice 而非 rewrite |
| **窗口分歧可见性** | 每个快照显式标注 `input diverged at item NN`，并纳入回归 | `core/tests/suite/snapshots/all__suite__compact__*.snap` | **P0-2 的目标形态**：把「分歧位置」做成一等概念 + 快照回归 |
| **工具输出上限** | `tool_output_token_limit` 默认 **10,000 tokens ≈ 40 KB**，**中段截断保留头尾**（标记 `…N tokens truncated…`） | `core/src/config/mod.rs`；`utils/string/src/truncate.rs`；`utils/output-truncation/src/lib.rs` | **P1-4**：我们 2 MiB 上限高出约 52 倍，且超限后**全有或全无** |
| **工具懒加载** | `ToolExposure::Deferred` + BM25 `tool_search`；初始工具仅 8 个 | `tools/src/tool_executor.rs`；`core/src/tools/handlers/tool_search.rs` | **P1-6**：把 40 个工具的完整 schema 换为「一行摘要 + 按需加载」 |
| **并发工具** | 同一响应内多 `function_call` 真并行（barrier 测试证明） | `core/tests/suite/tool_parallelism.rs` | 我们**已具备轮内多调用**，仅未并行执行；收益仅在墙钟 |

### 4.1 不可直接移植的部分（重要）

Codex 能做到「只发增量」，依赖 **Responses API 的 `previous_response_id` + `store`**（服务端持有会话历史）。**Anthropic Messages API 没有该字段**，其等价物是**显式 `cache_control` 断点**。

| 类别 | 项目 |
|---|---|
| **可移植** | apply_patch 式回执、append-notice 原则、内容哈希稳定 id、中段截断、`ToolExposure` 懒加载、`input diverged at item N` 埋点 |
| **需等价替换** | `previous_response_id` → **`cache_control` 断点**（我们**已有** system + 尾部断点，但形态需重设计；见 §3.7、§5.3） |
| **不适用** | `seek_sequence` 的降级宽容——Codex 的工具格式是 patch 语法，自带 `@@ 上下文`消歧；我们的 `old_string` 是 `indexOf` + 唯一性约束，**痛点方向相反**（见 §9） |

## 5. 改进方案

### 5.1 P1-3：事件流 / 备份体积治理（原 P0-1，已降级 — B1）

> **口径修正（B1）**：v1.0 本节目标是「给**模型侧**瘦身」。该目标**不成立**——`autoApprovedWrite.diff` 从未进入模型上下文（§2.4），模型面 `edit_file` 仅占 **1.7%**（§3.3）。**目标状态就是现状**，故本节降级为**磁盘 / 备份体积**议题，并新增 `request_header` 一项。

#### 5.1.1 目标（修正后）

减少 `events.jsonl`、DB 与会话备份的**落盘体积**（**UTF-8 字节口径**，R2 更正），共三项：

| 项 | 现状 | UTF-8 字节收益 |
|---|---|---|
| **(a)** `edit_file` 的 `autoApprovedWrite.diff`（**只写不读**） | 6,870,438 字符 / **10,829,580 字节** / 含 102 条 `oldContent` 全文 | **10.83 MB（9.05%）** |
| **(b)** `request_header` 重复写入 `system` + `tools` | 146 × **93,486 字节**（system 4,388 + tools 89,098） | **13.65 MB（11.40%）** |
| **(c)** `request_header` 的 `toolExecutionCheckpoint`（**v1.2 新增识别**） | 146 × 5,559 字符（最大 11,815），随轮增长 | 0.81 MB（0.68%） |
| — | — | **(a)+(b) 合计 ≈ 24.48 MB（20.45%）** |

> **口径与 v1.1 的差异（R2）**：v1.1 把**字符数**标为字节，得出 16.7 MB（15.1%）。改为 UTF-8 字节后，因中文内容多字节放大约 1.5 倍，实际收益为 **24.48 MB（20.45%）**——**方向不变，收益比 v1.1 所写更大**。
>
> **单位约定（v1.3）**：本文 `MB` 一律为 **10⁶ 字节**（非 MiB = 2²⁰）。(a) 若按 MiB 读作 10.33，属不同单位，注意区分。

#### 5.1.2 现状与落点

**(a) `edit_file.diff`**——`electron/toolChatLoop.ts:1900-1909`：

```ts
const stats = diff ? computeDiffLineStats(diff.oldContent, diff.newContent) : { add: 0, remove: 0 }
fileAutoApproveMeta = {
  path: relPath, added: stats.add, removed: stats.remove, bytesWritten,
  ...(diff ? { diff } : {})          // ← 只并入事实载荷（:2691），且渲染层零引用
}
```

**(b) `request_header`**——`buildRequestHeaderPayload` 把完整 `system` 与 `tools` 写入事件流（`src/shared/requestContext.ts:36-45`），**每个请求一次**，而两者全程恒定（§3.7）。

#### 5.1.3 方案 (a)：直接删除 `diff` 字段（**无需载荷分离**）

v1.0 §5.1.3 提议「拆两份载荷」。**该架构已存在**，无需新建：

| 载荷 | 现状 | 消费方 |
|---|---|---|
| 模型侧 `toolResultBlock` | **已不含** `autoApprovedWrite` | 模型（不受影响） |
| 事实载荷（`recordToolResult` 第二参数） | 含 `autoApprovedWrite`（含 `diff`） | 事件流 / DB / 备份 |

**核实结论（评审代做；v1.0 §5.1.4 清单四项已全部回答）**：

| # | v1.0 待核实项 | 结论 |
|---|---|---|
| 1 | `autoApprovedWrite.diff` 被哪些消费方读取 | **渲染层零引用**；全仓仅类型定义 + 写入点 + 测试断言 |
| 2 | UI diff 卡片数据源 | 走 `confirmDiff`（confirm 链路，`WriteConfirmCard.tsx:23`、`WriteSuccessCard.tsx:14`），**与 `autoApprovedWrite.diff` 不同源** |
| 3 | 历史重建时 `tool_result` 内容取自哪里 | `claudeToolHistory.ts:36-53` → **字段白名单投影**，`autoApprovedWrite` 一律丢弃 |
| 4 | `sanitizeAgentText` 对 `oldContent` 的改写是否造成不一致 | **不构成风险**：该字段既不进模型也不进 UI |

**故实现**：不再写入 `diff`（保留 `path` / `added` / `removed` / `bytesWritten`），或整体移除 `autoApprovedWrite`。

**风险**：低。需确认 `toolChatLoop.fileAutoApprove.test.ts:153-162`（只断言 `path`）不受影响；若整体删字段，该测试需同步调整。

#### 5.1.4 方案 (b)：`request_header` 的 `system` / `tools` 去重

**现状**：146 次请求各自写入完整 `system`（3,934 字符 / 4,388 字节）与 `tools`（**57,117** 字符 / 89,098 字节），而两者**全程恒定**（§3.7）。

**候选做法（择一，需专门评估）**：

1. **首见全量 + 后续引用**：首个 `request_header` 写全量，后续只写两个指纹 + 引用；读取侧按指纹回填；
2. **独立落盘 + 引用**：把 `system` / `tools` 抽到每会话单独的存储（文件或表行），`request_header` 只存指纹与引用键；
3. **仅变化时全量**：指纹未变则省略字段。

**(c) `toolExecutionCheckpoint` 的额外考量**：该字段的 `completedToolUseIds` **随轮次单调增长**，是 `request_header` 中**唯一非恒定的大字段**（平均 **5,559** 字符、最大 **11,815**）。它无法用「首见全量 + 引用」处理，但可采用**增量编码**（仅写本轮新增的 toolUseId）。**若 (§b) 未同时处理它，`request_header` 去重后仍余约 5.9 KB，达不到 2 KB 以下**（§7.2）。

**约束（N5 更正，比 v1.1 所写更宽松）**：

- `request_header` 的读取方 **`computeContextPressureFromEvents`（`src/shared/contextMeter.ts:95-131`）只读 `requestId` + `surfaceSnapshot`**（≈250 字符）；**`budget` / `contextWindow` 来自 `request_context` 事件**。故去掉 `system` / `tools` 对 context meter **无影响**，本项可行性高于 v1.1 的判断；
- 仍需核实 `request_header.system` / `tools` 是否有**其他**读取方（若仅用于诊断，方案 2 最干净）；
- 若同时要落盘 §5.2 的 `wireHeader`，**必须与本节共享 `system` / `tools`**，否则体积翻倍。

#### 5.1.5 收益口径（UTF-8 字节，R2 更正）

- **(a)** **10.83 MB/会话**（占 events.jsonl **8.6%**）；**与 token 成本无关**（§2.4、§3.3）；
- **(b)+(c)** **≈14.5 MB/会话**（12.1%），前提是确认 `system` / `tools` 无强读取方或可回填；
- **合计 ≈ 24.5 MB/会话（20.5%）**。对 ~120 MB 量级的会话文件是显著改善，但**不改变 token 账单**。

> v1.0 §5.1.5 曾用「重发轮数 × 全价」估算 token 收益（约 589k 等效）。**该估算作废**——`diff` 从未进入上下文，无「重发」可言。

### 5.2 P0-1：messages 面 + **wire 面** 缓存埋点（观测先行）

#### 5.2.1 目标

让「缓存前缀在哪里断了」可被直接观测，终结 §3.4 的归因盲区，并**区分两个候选成因**：

| 候选 | 修法 | 区分方法 |
|---|---|---|
| **A. messages 段被改写** | 改 messages 生成逻辑 | 埋点看 `firstDivergedIndex` |
| **B. `cache_control` 断点随尾移动**（§3.7） | 调断点位置 | 埋点看**断点位置序列** |

#### 5.2.2 现状缺口（两个；缺口 2 由 B2 新增）

**缺口 1：不记 messages 数组**。`RequestHeaderPayload` 记录 `system`、`tools`、三个指纹与 token 计数，**唯独不记 messages**。故已知「变化在 messages 段」，但不知**哪个 item** 变了。

**缺口 2：不记 wire 面（B2 新增）**。`request_header` 记录的是**计划面**（`plannedMessages = wireMessages`，`toolChatLoop.ts:1016`）；serializer 注入的 `cache_control` 断点位置**完全不落盘**。而 §3.7 已确认断点②「随尾移动、工具循环中消失」——**这是当前最大的观测盲区**。

> `toolChatLoop.ts:1018` **已计算 `wireHeader`**（含 wire 面 messages），但仅用于 `preflight` 比较，**未落事件流**。直接落盘即缺口 2 的低成本解法。

#### 5.2.3 方案

**(1) messages 面前缀统计**（照抄 Codex 的 `input diverged at item N`）——在每个 `request_header` 中**追加**：

```jsonc
{
  "messagePrefixStats": {
    "itemCount": 42,
    "prevItemCount": 40,
    "commonPrefixItems": 37,
    "firstDivergedIndex": 37,           // ← Codex 的 "input diverged at item N"
    "divergedReason": "replaced",       // appended | replaced | truncated | reordered | unknown
    "prevItemDigest": "<前 8 位哈希>",
    "currItemDigest": "<前 8 位哈希>"
  }
}
```

**(2) wire 面断点观测（B2 新增，必做）**——同时记录：

```jsonc
{
  "cacheBreakpoints": {
    "count": 2,
    "positions": ["system", "msg:41"],      // 断点落在哪个 item
    "tailIsString": true,                   // 末条是否为字符串（决定断点②是否存在）
    "prevPositions": ["system", "msg:39"],  // 与上一请求对比
    "moved": true                           // ← 用于实证候选 B（§3.7 已排除，此处做最终结案）
  }
}
```

**实现要点**：

1. **messages 面的比较必须基于规范化消息**——复用 `canonicalizeSurfaceMessages()`（已剥离 `cache_control`），保证比较的是「模型可见语义」；
2. **wire 面单独记录，不得混入 messages 面比较**——否则每请求的断点注入都会制造假分歧；
3. **按 item 逐项比较、用内容哈希**，才能给出「第 N 个 item」定位；
4. **`divergedReason` 枚举须覆盖**：`appended`（缓存友好的正常情形）、`replaced`（缓存杀手）、`truncated`、`reordered`；
5. **保留前后 digest**——相同说明仅位置变化，不同说明内容被改写；
6. **内存开销可控**：只需保存**上一请求**的 item 哈希列表（≤ 数百个 8 字符哈希）；
7. **wire 面若落盘，须与 §5.1.4 共享 `system` / `tools`**，避免体积翻倍。

#### 5.2.4 收益

**本项不直接省 token，但它是定位 438,640 未命中的唯一关键路径**（v1.2：候选 B 已排除，wire 面降为实证手段）：

- 定位 turn 边界失效的来源（占未命中输入 **54.2%**，占等效成本约 **8.1%**）；
- **实证候选 B 是否真的无关**（落盘 `wireHeader` 即可判定，§5.3.4）；
- 为 P0-2 的修法提供依据——**候选 A 的具体环节**（§3.4.5）。

**同时建议补齐一项代码级审计**：确认 `planTurnBoundarySurfaceCompaction`（`src/shared/turnBoundaryCompaction.ts`）在无 compaction 事件的情况下是否真的从未被调用（§3.4.4 排除项 1 的复核）。

### 5.3 P0-2：turn 边界缓存失效的消除（候选 A：messages 前缀）

> **两轮修正**：v1.0 标题为「显式 `cache_control` 断点」（前提「零命中、从 0 建设」）→ **B2 更正**：断点已存在。v1.1 改为「盘点并重设计现有断点」，并把路径 B 设为最强候选 → **R1 更正**：**候选 B 已被用量数据排除**（§3.7）。故 v1.2 只剩候选 A。

#### 5.3.1 目标

消除 turn 首请求的 **438,640 tokens 未命中**（占全部未命中 **54.2%**，占等效成本约 **8.1%**）。方式为**治理计划面 messages 的前缀变化**。

#### 5.3.2 现有断点盘点（结论：无需改动）

| 断点 | 位置 | 稳定性 | 处置 |
|---|---|---|---|
| ① `system` | 固定 | 恒定 | **保留** |
| ② 尾部字符串消息 | 随尾移动 | 不稳定 | **保留**（R1 已证其不影响命中） |

R1 证据（§3.7）：`round:2+` 的 126 次请求**无消息级断点**，仍有中位 99.6% 命中 ⇒ **断点位置不参与前缀复用** ⇒ 调整断点位置**不会**改善命中率。

> **v1.1 的「路径 B：重设计断点位置」已删除**。若仍要调整断点，动机只能是「降低 API 侧写入成本」等**非本文议题**的目标。

#### 5.3.3 方案：治理 messages 前缀（候选 A）

**原则：turn 边界只追加、不原地改写**——照 Codex 的 append-notice 模式（§4.1）：需要变更时追加一条「替代声明」，而非修改已发送过的 item。

**落点取决于 §3.4.5 的定位结果**，两个层次：

1. **若静态比对即可定位（优先）**：修复 `buildToolChatMessagesFromSource`（重建路径）与实时追加路径的**产出差异**，使 `round:1` 的 messages 前缀与上一 turn 末轮**逐字节一致**。这是**最彻底**的解法——不仅减少未命中，还消除「同一历史两套表示」的隐患；
2. **若无法完全一致**：改为让 turn 边界**不改变已有 item**，新内容只追加，并把必要的变化（skill fragment、恢复消息等）改为**追加通知**。

**参考实现（Codex 已验证）**：

```rust
// codex-rs/core/src/context/world_state/context_window_guidance.rs
const REPLACEMENT_NOTICE: &str = "This context-window guidance replaces all previously provided context-window guidance.";
const REMOVAL_NOTICE: &str = "The previously provided context-window guidance no longer applies.";
// 状态变更 → 追加新 fragment，旧的不动
```

#### 5.3.4 候选 B 的最终实证（降为辅助）

虽已由用量数据排除（§3.7：97 倍矛盾），仍可**一次性结案**：落盘 `toolChatLoop.ts:1018` 已计算的 `wireHeader`（含 wire 面 messages），核对

- `round:2+` 的 wire 面是否确无消息级断点；
- `round:1` 的断点位置变化与 `cache_read` 是否**无相关性**。

若吻合，则 B 正式结案；若出现反例，需重新评估。

#### 5.3.5 验证顺序

本项的修复依赖 §5.2 埋点（messages 面）；而 §3.4.5 的**静态比对可先于埋点执行**。建议顺序：**静态比对 → 埋点 → 修复**。

### 5.4 P1-4：工具结果上限下调 + 中段截断

#### 5.4.1 现状

| | SpaceAssistant | Codex |
|---|---|---|
| 单次上限 | `MAX_TOOL_RESULT_CONTENT_CHARS = READ_FILE_MAX_CHARS = **2 MiB**` | `tool_output_token_limit` 默认 **10,000 tokens ≈ 40 KB** |
| 超限处理 | **全有或全无**：整段替换为 `[tool_result omitted: content exceeded limit; originalLength=N; maxChars=M]` | **中段截断**：保留头 + 尾 + 标记 `…N tokens truncated…` |

落点：`src/shared/toolResultLimits.ts`、`src/shared/oversizedToolResult.ts`（`compactOversizedToolResultContent`）、`electron/toolChatLoop.ts:322`（`compactToolResultContentForApi`；v1.3 行号更正，v1.1–v1.2 写 321）。

#### 5.4.2 两个问题

1. **上限过高**：2 MiB ≈ 572k tokens，实际等于**不设限**（实测单次最大 96,190 字符，从未触发）；
2. **超限即信息全失**：一旦超过 2 MiB，模型收到的是一个占位符——**比截断更糟**（截断至少保留头尾）。

#### 5.4.3 方案

1. **上限下调**至 10,000–15,000 tokens 量级（对齐 Codex 的默认值）；
2. **改为中段截断**，保留头 + 尾；标记形如 `…N tokens truncated…`；
3. **保留 `originalLength` / `originalTokenCount` / `totalLines`**，便于模型判断是否需要分段读取；
4. **保持与 `read_file` 的分段读取能力协同**——截断提示中明确「可用 `read_file` 带 offset/limit 读取指定区间」。

#### 5.4.4 影响面（N2 补充，实施前须一并评估）

`MAX_TOOL_RESULT_CONTENT_CHARS` **并非只被工具结果使用**：

| 共用点 | 位置 | 影响 |
|---|---|---|
| **历史重建的超大结果压缩** | `electron/claudeStreamHandlers.ts:138`（日志字段 `maxChars: MAX_TOOL_RESULT_CONTENT_CHARS`） | 该处是**超大 tool_result 压缩**的日志上报；改常量会影响历史重建路径的压缩阈值 |
| **IPC 消息文本上限** | `MAX_API_MESSAGE_TEXT_CHARS` —— `src/shared/toolResultLimits.ts:**11**`，**与本常量同源 2 MiB** | 下调需同步评估 IPC 校验 |
| `read_file` 执行器 | `READ_FILE_MAX_CHARS = 2 MiB`（`toolResultLimits.ts:2`） | 执行器单次仍可产出 2 MiB → **上限下调后，大文件读取将常态化中段截断** |

**结论**：本项不是「改一个常量」，须同时评估上述三处，并确认中段截断后模型仍能通过 `read_file` offset/limit 定位。

> **定性更正（v1.4）**：v1.1–v1.3 把 `claudeStreamHandlers.ts:138` 描述为「历史重建**配对校验**」并称其「使用该上限」，**不准确**——:138 是**压缩路径的日志字段**；配对校验由 `ensureToolResultPairing`（`src/shared/toolResultPairing.ts`，调用点 `claudeStreamHandlers.ts:187`）完成，**不使用**该上限。「需一并评估」的结论方向不变。

#### 5.4.5 收益

**日常收益小**（当前从未触发上限），主要价值是**防灾**：避免某次异常大的结果把整段信息抹掉。**低风险，但影响面（上表）须先评估。**

### 5.5 P1-5：重复读取去重

#### 5.5.1 测量

| 次数 | 路径 |
|---|---|
| **22×** | `docs/develop/run-shell-windows-host-init-failure-diagnosis-and-improvement-plan.md` |
| **7×** | `docs/develop/edit-file-match-failure-diagnosis-and-improvement-plan.md` |
| 2× | `electron/shell/environmentResolver.ts`、`electron/processOutputEncoding.ts`、`src/shared/processResultProjection.ts` |

`read_file` 共 69 次调用，39 个不同路径——**重复率约 43%**。

#### 5.5.2 方案

在工具层对「本次会话内已完整读取过且文件未变化」的路径做提示：

- 简要结果：`{ path, unchangedSince: <readId>, note: "该文件已在上下文中（本次会话第 N 次读取），如需特定区间请传 offset/limit" }`；
- **不直接拒绝**——模型可能确实需要重读（文件已变、或上下文已被压缩）。

#### 5.5.3 收益（按模型面重算）

`read_file` **模型面 = 事件流面**（倍差 1.0，§3.3），故可直接计算：

| 路径 | 读取次数 | 冗余字符（首读不计） |
|---|---|---|
| `docs/develop/run-shell-windows-host-init-...md` | 22 | 32,894 |
| `docs/develop/edit-file-match-failure-...md` | 7 | 20,099 |
| `electron/shell/environmentResolver.ts` | 2 | 1,372 |
| `electron/processOutputEncoding.ts` | 2 | 1,808 |
| `src/shared/processResultProjection.ts` | 2 | 3,187 |
| **合计** | — | **59,360 ≈ 16,960 tokens** |

占全部**模型面**工具结果 **7.3%**，占等效总成本 **0.3%**。**属零散收益，优先级低于 P0。**

### 5.6 P1-6：tools 前缀懒加载（评估后决定）

#### 5.6.1 现状

- `prefixTokens = 17,444`，其中 **tools 占 16,320**（system 仅 1,124）；
- 146 次请求共发送约 2.38M tokens 的 tools 前缀（含缓存命中）；
- 全量工具约 40 个（含 MCP），每个携带完整 JSON schema。

#### 5.6.2 Codex 方案

`ToolExposure::Deferred` + BM25 `tool_search`：

- 初始模型可见工具仅 8 个；
- 被延迟的工具**只以一行描述**出现在 developer 段的 `<tools>` 中（快照实证）；
- 需要时通过 `tool_search` 检索加载；
- **关键**：前缀项的 id 用**内容哈希**生成，且增删走 **append-only 的 `<tools>` 通知**，保证跨请求稳定。

#### 5.6.3 收益量化与风险

**收益在基数，不在命中率**——当前命中率已 98.16%：

```
前缀 17,444 tokens（其中 tools 16,320）× 146 请求 = 2,546,824 原始 tokens
全部命中缓存时等效 = 254,682
若把 tools 从 16,320 压到 4,000：省 12,320 × 146 × 0.1 = 179,872 等效（≤3.3%）
```

**风险**：

- 工具集变化会**改变 `toolsFingerprint`**（当前 `3acfbf90` 恒定）→ 破坏前缀稳定性；
- 若不采用内容哈希 + append-notice，动态增删工具会导致**每轮前缀失效**，反向恶化；
- MCP 工具是动态的，风险更高。

#### 5.6.4 建议

**暂缓**。若要做，必须同时落地 Codex 的两条保障（内容寻址 id + append-notice），并复用 `canonicalizeSurfaceMessages()` 的规范化口径。**优先级排在所有 P0/P1 之后，且需专项方案。**

### 5.7 撤回：轮内批量 / 并发执行

**原建议**：新增运行时并发能力 / `batch` 工具，以减少轮数。

**撤回依据**：

1. **轮内多调用已支持**（§3.6：平均 2.65/轮，74 轮为多调用）→ **协议改动为 0，收益已拿到**；
2. **通用 `batch` 工具复杂度高**，且会降级既有安全体系：

| 受影响机制 | 后果 |
|---|---|
| `policy.decision` / `auto-evaluator` / 审批 Agent | 只见外层一次调用；子调用审查被跳过或 `factsSummary` 失真——与 `run_shell` 案中「线索包只取 `commands[0]`」同类问题的放大 |
| `edit_file` 四道护栏 | `hasBeenRead`（批内读写有序）、`assertDiskMatchesReadCache`、`backupIfEnabled`、`safeAtomicWrite` 需逐子调用走，易漏 |
| `toolExecutionCheckpoint` | 整批单 `toolUseId` → 中断恢复只能全批重做，**写操作会重复执行** |
| 失败语义 | 3 个子调用第 2 个失败时的整体成败与重试**需重新定义** |

3. **并发执行仅省墙钟**：336 次调用即使每次 1–2 秒，合计约 6–11 分钟；并发可省约一半，占 14.49 小时跨度的 **<1%**（且跨度中大部分是 idle）。**不省 token，不改善命中率。**

**唯一保留的可做项**：在 prompt / 工具描述中引导模型把「已知清单式」的独立只读探查合并到一轮（如一次请求 5 个 `read_file`）。**零架构成本**，但收益有限（53 个单调用轮中大部分是真实依赖链：grep 定位 → 才知读哪个文件 → 才知改哪一行，无法合并）。

## 6. 实施顺序

| 阶段 | 内容 | 依赖 | 风险 |
|---|---|---|---|
| **Phase 0** | **静态比对**（§3.4.5）：**测试内驱动完整一轮并前向捕获 `finalSurfaceMessages`**，与次轮 `round:1` 的重建产出逐字节比对 | 无 | **低**（纯测试，不改生产代码） |
| **Phase 0** | **P0-1 双面埋点**：messages 前缀统计（§5.2.3-1）+ wire 面断点观测（§5.2.3-2；可直接落盘已有 `wireHeader`）。后者兼作**候选 B 的最终实证** | 无 | **低**（只增日志） |
| **Phase 0** | 核实 `request_header.system`/`tools` 的其他读取方（§5.1.4；**context meter 已确认不受影响**） | 无 | 低（调研） |
| **Phase 1** | **P1-3 事件流体积**：(a) 删 `edit_file.diff` 死字段；(b) `request_header` 去重；(c) `toolExecutionCheckpoint` 增量编码 | (a) 无；(b)(c) Phase 0 第 3 项 | 低；(b) 若需存储改造则中 |
| **Phase 1** | **P0-2 turn 边界失效消除**（候选 A，依 Phase 0 第 1/2 项结论） | **Phase 0** | 中 |
| **Phase 2** | P1-4 上限下调 + 中段截断（先评审 §5.4.4 影响面） | 无 | 中（三处共用点） |
| **Phase 2** | P1-5 重复读取去重 | 无 | 低 |
| **Phase 3（评估）** | P1-6 tools 前缀懒加载 | 专项方案 | 高 |
| **不做** | 轮内批量 / 并发 / `batch` 工具；**断点位置重设计**（R1 已排除） | — | — |

**顺序理由**：

- **静态比对（Phase 0 首项）成本最低、最可能直接定位**——无需任何生产代码改动，且 §3.4.5 已给出 5 个可能产生差异的环节清单；
- **P0-1 埋点仍是关键路径**：候选 B 排除后，messages 面埋点是**运行时的唯一取证手段**；wire 面埋点兼作 B 的结案证据；
- **P1-3 提到 Phase 1**：结论由代码确定、不依赖埋点，收益确定（**24.5 MB / 20.5%**）；
- **P0-2 依赖 Phase 0**，不能提前；
- P1-6 风险最高、收益最小，放最后。

## 7. 测试与验收

### 7.1 P0-1 埋点（双面）

**messages 面（1–7）**：

| # | 场景 | 断言 |
|---|---|---|
| 1 | 纯追加（新增一条消息） | `divergedReason='appended'`；`firstDivergedIndex === prevItemCount` |
| 2 | 原地替换（改写第 N 条） | `divergedReason='replaced'`；`firstDivergedIndex === N`；`prevItemDigest !== currItemDigest` |
| 3 | 截断 | `divergedReason='truncated'`；`commonPrefixItems < min(prevItemCount, itemCount)` |
| 4 | 仅位置变化（内容相同） | `prevItemDigest === currItemDigest` |
| 5 | **带 `cache_control` 的消息** | messages 面埋点**不受** `cache_control` 影响（复用 `canonicalizeSurfaceMessages` 口径） |
| 6 | 首请求（无上一请求） | 字段为 `null` / 缺省，不报错 |
| 7 | 回归 | `request_header` 既有 10 字段**逐字段不变**；新增字段为追加 |

**wire 面（8–10，B2 新增）**：

| # | 场景 | 断言 |
|---|---|---|
| 8 | `round:1`（末条为新用户消息） | `cacheBreakpoints.positions === ['system', 'msg:<末条>']`；`moved === true` |
| 9 | `round:2+`（末条为 tool_result 数组） | `tailIsString === false`；`count === 1`（**断点②消失**）；`moved === true` |
| 10 | wire 面与 messages 面互不污染 | messages 面 `firstDivergedIndex` **不因**断点注入而变化（两条统计独立） |

**验收**：对 `b680b181` 重放，能在 turn 边界失效处**同时给出 `firstDivergedIndex` 与 `cacheBreakpoints.moved`**，从而（a）定位候选 A 的**运行时**分歧点，（b）对候选 B **结案**。

### 7.2 P1-3 事件流体积

**(a) 删除 `edit_file.diff`**：

| # | 场景 | 断言 |
|---|---|---|
| 1 | `edit_file` 事件流 `payload.result` | **不含** `diff`；`path` / `added` / `removed` / `bytesWritten` 保留 |
| 2 | **模型侧不受影响（关键回归）** | 模型侧 `tool_result` content **与改动前逐字符相同**（本就无 `diff`） |
| 3 | 历史重建 | 与实时路径一致（`claudeToolHistory` 白名单本已丢弃该字段） |
| 4 | 回归：`file.auto_approve` 审计 | 事件仍产生；`toolChatLoop.fileAutoApprove.test.ts:153-162` 断言 `path` 通过（若整体删字段则同步调整） |
| 5 | 体积 | 含 diff 的行数为 **0**；`edit_file` 事件流面由 6,870,438 字符 / 10.83 MB 降至 **≈ 28 KB**（6,870,438 → **28,968** 字符；**保留** `autoApprovedWrite` 的 `path`/`added`/`removed`/`bytesWritten` 元数据，均值 287 字符/次） |

**(b) `request_header` 去重**：

| # | 场景 | 断言 |
|---|---|---|
| 6 | 读取侧回填 | 按指纹回填后，`contextMeter` / `requestContext` 得到的 `system` / `tools` 与去重前**等价** |
| 7 | 指纹未变 | 不写全量，仅写指纹 + 引用 |
| 8 | 指纹变化（如工具集变更） | 正常写全量；读取侧不跨会话串用 |
| 9 | 回归：usage anchor | `computeContextPressureFromEvents` 结果不变 |
| 10 | 体积 | `request_header` **完整行**平均由 **99,709 字节**降至 **≈6.2 KB**——注意 93,486 只是 `system`(4,388) + `tools`(89,098) 的字节和，**不是完整行**；去这两项后仍余 **6,165 字节**（其中 `toolExecutionCheckpoint` 5,559 + 其余约 600）；若对 checkpoint 同时增量编码，则降至 **≈0.6 KB**（v1.1 写「< 2 KB」不可实现；v1.3 改「≈5.9 KB」为字符口径混淆，v1.4 更正为字节口径） |

### 7.3 P0-2 turn 边界失效消除（候选 A）

| # | 场景 | 断言 |
|---|---|---|
| 1 | **静态比对（首要，§3.4.5）** | 测试内**前向捕获**的第一轮 `finalSurfaceMessages` 与第二轮 `round:1` 的重建产出 **逐字节相同**；若不同，输出**首个分歧 item 的下标与内容** |
| 1b | 输入捕获方式 | 断言测试**确实前向驱动了一轮**（而非静态 fixture 拼接）——否则无法获得 `finalSurfaceMessages` |
| 2 | **前缀连续性** | `round:1` 的 messages 相对上一 turn 末轮构成**严格前缀扩展**：`divergedReason === 'appended'`（无 `replaced`） |
| 3 | **失效量（关键指标）** | `round:1` 的未命中合计**显著低于**当前 **438,640** |
| 4 | 变更只追加 | turn 边界的 skill fragment / 恢复消息等改为**追加通知**（append-notice），不修改既有 item |
| 5 | **前缀稳定性（关键回归）** | 三个指纹跨请求恒定 |
| 6 | **断点保留** | 现有 system / 尾部断点**保留不动**（R1 已证其不影响命中） |
| 7 | 回归：无效果损失 | `edit_file` 成功率、重试率、`run_script` 写文件次数均不劣化 |
| 8 | 回归：历史一致性 | 两条路径产出一致后，历史重建的模型可见 surface 与实时路径仍等价 |
| 9 | 反例：候选 B（辅助） | 若 wire 面埋点显示 `round:2+` 确无消息级断点而命中率仍高 → **B 结案**；若出现反例（断点移动与失效强相关）→ 重新评估 |

**验收（本方案总验收）**：

1. **可观测（双面）**：任意请求都能回答 (a)「messages 在第几项分歧、是追加还是替换」**与** (b)「wire 面断点在第几项、是否移动」；
2. **归因闭环**：turn 边界失效有**确定机制解释**——候选 A 定位到具体环节（§3.4.5），候选 B **正式结案**；
3. **口径正确**：体积论断（a）标注「事件流面 / 模型面」，（b）启用 **UTF-8 字节**（非字符）；
4. **无效果损失**：`edit_file` 成功率、重试率、`run_script` 写文件次数**均不劣化**；
5. **前缀不退化**：三个指纹跨请求恒定（当前最大资产，不得回退）；
6. **命中率**：≥ 现状 98.16%；若 P0-2 消除边界失效，未命中输入应**显著低于** 808,683；
7. **磁盘**：events.jsonl 体积下降 **≈20.45%（24.48 MB）**，且无读取方受影响；
8. **零安全回退**：不修改 `sanitizeAgentText` / `projectGenericData` 的脱敏行为；不绕过写路径四道护栏。

## 8. 代码落点

| 文件 | 建议改动 | 阶段 |
|---|---|---|
| `src/shared/requestContext.ts` | `buildRequestHeaderPayload` 追加 `messagePrefixStats`（messages 面）+ `cacheBreakpoints`（wire 面）；messages 面复用 `canonicalizeSurfaceMessages()` | P0-1 |
| `electron/toolChatLoop.ts:1018` | **把已计算的 `wireHeader` 落事件流**（缺口 2 低成本解；须与 §5.1.4 共享 `system`/`tools`） | P0-1 |
| `electron/claudeToolLoopStreamParams.ts:34-41` | **不改**：断点注入保留原样（**R1 已排除**「断点移动致失效」，调整位置无收益） | — |
| **`electron/chatMessageBuild.ts` / `src/shared/claudeToolHistory.ts`** | **（P0-2 主落点）**修复重建路径与实时追加路径的**产出差异**，使 `round:1` 前缀与上一 turn 末轮逐字节一致；或改为 append-notice（§3.4.5、§5.3.3） | P0-2 |
| **新增测试**（建议 `electron/claudeStreamHandlers.rebuildParity.test.ts`） | **静态比对**：前向驱动一轮并捕获 `finalSurfaceMessages`，与次轮重建产出逐字节 diff（§3.4.5、§7.3 断言 1） | Phase 0 |
| `src/shared/requestContext.ts`（写入侧） | `request_header` 的 `toolExecutionCheckpoint` **增量编码**（仅写本轮新增 `toolUseId`） | P1-3(c) |
| `electron/toolChatLoop.ts:1900-1909` | `fileAutoApproveMeta` **不再写入 `diff`**（保留 `path`/`added`/`removed`/`bytesWritten`） | P1-3(a) |
| `src/shared/requestContext.ts`（写入侧）+ 事件读取侧 | `request_header` 的 `system`/`tools` 去重（首见全量 + 指纹引用） | P1-3(b) |
| `src/shared/toolResultLimits.ts` | 调整工具结果上限常量（tokens 口径）；**注意 `MAX_API_MESSAGE_TEXT_CHARS` 与之同源**（§5.4.4） | P1-4 |
| `src/shared/oversizedToolResult.ts` | `compactOversizedToolResultContent` 改为**中段截断**（保留头尾 + 标记） | P1-4 |
| `electron/tools/builtinExecutors.ts`（`read_file` 分支） | 已读路径提示（P1-5） | P1-5 |
| `src/shared/contextMeter.ts` | **不改**：`shouldCompact` 阈值与口径保持不变 | — |
| `src/shared/agentSafeText.ts` | **不改**：脱敏行为是本方案的保护对象 | — |
| `electron/tools/builtinExecutors.ts`（匹配 / 写路径） | **不改**：`countOccurrences` / `applyEdit` / `safeAtomicWrite` / `backupIfEnabled` | — |
| `electron/anthropicUsageNormalize.ts` | **不改**：仅读取 `cache_creation` 字段，与断点注入无关（v1.0 曾误列于此） | — |

## 9. 不建议的做法

- **把「事件流面体积」当作「模型上下文体积」**——这正是 v1.0 的核心错误（§1.3 纠正 3、§2.4）。两个面相差最多 **484.9 倍**（`edit_file`）。任何体积论断都必须标注面。
- **把「字符数」当作「UTF-8 字节数」**——v1.1 §3.3.2 因此把 P1-3 收益低估约 **47%**（R2）。中文内容多字节放大 1.5 倍，两者不可混用（§3.3.2、§5.1.5）。
- **据「断点位置在 `round:1` 突变」的时间相关就断定其为失效成因**——R1 已用 `round:2+`（126 次**无消息级断点**、命中率中位 **99.6%**）排除该机制（§3.7）。**时间相关 ≠ 因果**；在隐式前缀缓存网关下，`cache_control` 位置**不参与**前缀复用。
- **为压缩 tools 前缀而牺牲指纹稳定性**——`stablePrefixFingerprint` 全程恒定（`f630ff26`）是 98.16% 命中率的根基。任何让动态内容（当前时间、工作目录、skill 列表、MCP 工具增删）进入 system/tools 的改动都会摧毁它。**必须先确认 `toolsFingerprint` 仍恒定，才可考虑 P1-6。**
- **把通用 `batch` 工具当作省 token 的手段**——见 §5.7：复杂度高、安全体系退化，而轮内多调用已支持。
- **认为「并行执行」能省 token**——它只省墙钟（占跨度 <1%）。
- **为「保留 UI diff 卡片」而保留 `autoApprovedWrite.diff`**——v1.0 曾据此要求做载荷分离。**核实后不成立**：UI 卡片走 `confirmDiff`（不同源），该字段渲染层零引用，可直接删（§5.1.3）。
- **为放行工具结果而放宽 `sanitizeAgentText`**——同 `edit-file-match-failure-...md` §9：正确做法是抑制 / 裁剪，不是放松脱敏。
- **把本方案与 `edit-file-match-failure-...md` 混为一案**——那份处理的是「匹配失败后的降级」（失败路径），本方案处理的是「请求层缓存失效 + 存储体积」（成功路径与请求层）。**落点相邻但议题不同，合并会稀释各自的验收标准。**
- **在没有 messages 面埋点前，再次对 turn 边界失效做单一归因**——v1.0 / v1.1 已各纠正一次（§1.3 纠正 1、纠正 5），现存**唯一候选是候选 A**（§3.4.5）。

## 10. 附：证据索引

| 事实 | 出处 |
|---|---|
| 消费画像（146 请求 / 19 turn / 336 调用） | `sessions/b680b181-.../events.jsonl`（快照 119,684,980 字节 / 311,786 事件） |
| usage 汇总与命中率 98.16% | **145** 次 `request_usage`（`source=api`，`cacheSemantics=additive`）（N4 更正；`request_header` 为 146 次） |
| `cache_creation` 恒为 0 | 同上，全量取值均为 0（含义见 §3.7：provider 计量语义，**非「未打标」**） |
| 工具结果分工具统计（`edit_file` 事件流面 **89.0%** / 模型面 **1.7%**） | 336 次 `tool_result`：事件流面取 `payload.result` JSON 长度；模型面剔除 `autoApprovedWrite` / `displayData` / `dependencyRecovery` 后计长 |
| 最大单次工具结果 96,190 字符 | `edit_file` 的 `tool_result` 事件 |
| **turn 边界失效（两口径）** | 口径 A（主）：按 `round` 分组 `request_usage`——`round:1` 19 次未命中 **438,640**；`round:2+` 126 次 `cache_read` 37,818,240 / 未命中 **370,043**。口径 B（上界）：相邻请求 `cache_read` 环比，16 次降幅合计 **526,720**，全部位于 `round:1` |
| **候选 B 的排除证据（R1）** | `round:2+` **无消息级断点**却仍有中位 99.6% 命中；若按官方断点语义，未命中应 ≥35,990,339，实测 370,043（**差 97 倍**） |
| 三个指纹全程恒定 | 146 次 `request_header` 的 `stablePrefixFingerprint` / `surfaceSnapshot` |
| `bodyRatio` 峰值 0.502 | `request_context` 的 `contextUsage.bodyRatio` |
| 事件类型仅 10 种、无 compaction 事件 | 全量 `events.jsonl` 类型计数 |
| `shouldCompact` 阈值与短路 | `src/shared/contextMeter.ts`；`electron/claudeStreamHandlers.ts:466` |
| `request_header` 不含 messages | 其 10 个字段逐一核实（`requestContext.ts` 的 `RequestHeaderPayload`） |
| 轮内多调用（平均 2.65 / 最多 12） | 按 `requestId` 聚合 `tool_call` 事件；127 轮含调用、74 轮为多调用 |
| `edit_file` **事实载荷**含 `oldContent` 全文（**非模型面**，见 §2.4） | `electron/toolChatLoop.ts:1900-1909`（生成）、`:2691`（并入事实载荷）；`tool_result.payload.result.autoApprovedWrite.diff.oldContent` |
| **双面倍差实测**（`edit_file` 484.9 / `write_file` 195.6 / 其余 1.0） | 同一快照下 336 条 `tool_result` 的两口径计长 |
| **事件流体积按类型（UTF-8 字节，R2）** | `assistant_chunk` 92,178,762（77.0%）/ `request_header` **14,557,454（12.2%）** / `tool_result` **11,973,711（10.0%）**；合计 119,684,980 = **文件实际字节**（口径校验点） |
| **字符 vs 字节（R2）** | 字符合计 110,387,970 → UTF-8 字节 119,684,980（放大 1.08；`request_header` 1.48、`tool_result` 1.54、`edit_file` result 1.58） |
| `request_header` 字段构成（**TS 紧凑口径**） | `tools` **57,117** 字符 / 89,098 字节；**`toolExecutionCheckpoint` 5,559 字符（最大 11,815）**；`system` 原始字符串 **3,934** 字符 / 4,388 字节（序列化后 3,992 字符 / 4,446 字节）<br>**完整行**均 **99,709 字节**；去 system+tools 后余 **6,165 字节 / 5,912 字符**（§7.2 断言 10 的依据，注意字节与字符之别） |
| **`tools` 字符数的一致性印证** | `57,117 / 3.5 = 16,319.14 → ceil = 16,320` = `surfaceSnapshot.toolsTokens`；`estimateTokensFromUtf8Text = Math.ceil(len/3.5)`（`src/shared/contextUsageEstimate.ts:80-82`） |
| `edit_file` 不在 `PROCESS_TOOL_NAMES` | `src/shared/processResultProjection.ts:172`（仅 `run_shell` / `run_script` / `run_lark_cli`） |
| 序列化路径 | `src/shared/agentToolResult.ts`（`serializeAgentToolResult` → `projectAgentToolResultForSink`） |
| 2 MiB 上限与全有或全无 | `src/shared/toolResultLimits.ts`；`src/shared/oversizedToolResult.ts`；`electron/toolChatLoop.ts:322`（N1 更正） |
| `cache_control` 剥离逻辑 | `src/shared/requestContext.ts` 的 `canonicalizeSurfaceMessages()`（注释「不把 serializer 的缓存控制元数据当成消息内容」） |
| **生产代码已注入 `cache_control`**（B2 更正） | `electron/claudeToolLoopStreamParams.ts:34-41`（system + 尾部字符串消息）；调用点 `electron/toolChatLoop.ts:1012`（`cacheControl: true`） |
| 断点②「随尾移动 / 工具循环中消失」 | 同上，末条为数组时不注入 → `round:2+` 仅剩 system 断点 |
| `request_header` 记录的是**计划面** | `electron/toolChatLoop.ts:1016-1017`（`plannedMessages = wireMessages`）；`wireHeader` 于 `:1018` 计算但未落盘 |
| 双面口径与倍差 | §2.4、§3.3（本文全篇口径依据） |
| `read_file` 重复率 43% | 69 次调用 / 39 个不同路径；最高 22 次同路径 |
| Codex：`apply_patch` 回执格式 | `codex-rs/apply-patch/src/lib.rs`（`print_summary`）；`core/src/tools/context.rs`（`ApplyPatchToolOutput`） |
| Codex：增量请求校验与 trace | `codex-rs/core/src/client.rs`（`get_incremental_items` / `responses_request_properties_match`） |
| Codex：`prompt_cache_key` | `codex-rs/core/tests/suite/prompt_cache_key.rs` |
| Codex：内容哈希前缀 id | `codex-rs/core/src/client.rs`（`Uuid::new_v5`） |
| Codex：append-notice 不改写 | `codex-rs/core/src/context/world_state/context_window_guidance.rs`（`REPLACEMENT_NOTICE`） |
| Codex：`input diverged at item N` | `codex-rs/core/tests/suite/snapshots/all__suite__compact__*.snap` |
| Codex：中段截断 | `codex-rs/utils/string/src/truncate.rs`；`utils/output-truncation/src/lib.rs` |
| Codex：`tool_output_token_limit` 默认值 | `codex-rs/core/src/config/mod.rs` |
| Codex：`ToolExposure::Deferred` + BM25 | `codex-rs/tools/src/tool_executor.rs`；`core/src/tools/handlers/tool_search.rs` |
| Codex：并行工具测试 | `codex-rs/core/tests/suite/tool_parallelism.rs` |

## 11. 附：免复审清单

以下论断已由评审逐条对照源码 / 事件流复核成立，**后续修订不必重查**：

- v1.0 评审（`docs/review/20260920-agent-context-token-cost-optimization-plan-review.md` §三）：下列 1–10 项；
- v1.2 复审（`docs/review/20260921-agent-context-token-cost-optimization-plan-review-v1.1.md` §一）：前次 B1 / B2 的修复核验（§2.4 双面管线、§3.7 断点形态、§5.4.4 影响面、§3.7 缓存写入 0 的含义）**均通过**；
- **v1.2 评审**（`docs/review/20260921-agent-context-token-cost-optimization-plan-review-v1.2.md`）：**结论「无阻断性问题」**——三层独立验证（数据复算 / 代码复核 / 反方假说检验）通过，新增 **11–17 项**（见下表下半部分）。

**v1.0 评审清单（1–10）**

| # | 论断 | 出处 |
|---|---|---|
| 1 | 2 MiB 上限与「全有或全无」整体替换 | `src/shared/toolResultLimits.ts:2-8`、`src/shared/oversizedToolResult.ts:27-40` |
| 2 | `PROCESS_TOOL_NAMES` 仅含 `run_shell` / `run_script` / `run_lark_cli`；`edit_file` 走 `projectGenericData` | `src/shared/processResultProjection.ts:172` |
| 3 | `shouldCompact` 短路条件逐字一致 | `electron/claudeStreamHandlers.ts:466` |
| 4 | 事件类型恰 10 种、无任何 compaction / shadow 事件 | 全量 `events.jsonl` 类型计数 |
| 5 | `cache_creation_input_tokens` 全程为 0（291 处） | 事件流实测 |
| 6 | 证据文件存在且字节数与文档一致 | 119,684,980 |
| 7 | `canonicalizeSurfaceMessages` 剥离 `cache_control` | `src/shared/requestContext.ts:54-71` |
| 8 | `stablePrefixFingerprint = fingerprint(systemFingerprint + ':' + toolsFingerprint)` | `requestContext.ts:80` |
| 9 | `RequestHeaderPayload` 不含 messages 数组（P0-1 缺口诊断成立） | `requestContext.ts:36-45` |
| 10 | §5.7 撤回轮内批量的安全论证充分 | 本文 §5.7 |

**v1.2 评审新增结案（11–17）**

| # | 已结案论断 | 出处 |
|---|---|---|
| 11 | **候选 B 排除推理**（R1）——数据 + 代码 + 反方假说三重验证 | 评审 §一-R1；本文 §3.7 |
| 12 | 反方假说 **TTL / 容量驱逐**均被排除（#46 空闲 102s 却未命中 86,255；#109 空闲 8.9h 后仍命中 367,360） | 评审 §一（3） |
| 13 | §3.4.5 的 **5 个「可能差异环节」代码全部核实存在** | 评审 §三-2 |
| 14 | **N3 主口径选择**恰当（438,640 实测 / 526,720 上界） | 评审 §三-4 |
| 15 | R2 字节口径的**收益数字**（13.65 MB / 24.5 MB / 20.5%）精确复现 | 评审 §一-R2 |
| 16 | `autoApprovedWrite` 无任何撤销 / 审计 / IM 路径读取，**P1-3(a) 删除安全** | 评审 §五 |
| 17 | §5.6.3 收益上限 ≤179,872（≤3.3%）算术复核 | 评审 §五 |

**另**：§3.6（轮内多调用）数据未逐条复核，但与代码无矛盾（`toolResults` 数组式追加，`toolChatLoop.ts:2706`），结论方向成立；本轮评审已确认「与代码无矛盾」。

> **v1.1 新增数据的复审判定（已由 v1.1 评审完成）**：§2.4 / §3.3 / §3.5 的双面倍差与体积、§3.7 的断点形态，均已复核：
>
> 1. **模型面计长口径** —— ✅ 与 `serializeAgentToolResult` 一致（唯一差异为键名 `success`→`ok`，336 次合计 < 2 KB，**0.2%**）；
> 2. **`request_header` 量级** —— ✅ 数字稳定可复现；**但单位是字符非字节**（见 R2，v1.2 已更正）；
> 3. **断点②与 16 次失效的时间相关性** —— ❌ **无须做，且该机制已被排除**（见 R1，v1.2 已更正）。

> **v1.2 修正项的复审判定（已由 v1.2 复审完成）**：
>
> 1. **候选 B 的排除推理**（§3.7 / §1.3 纠正 5）—— ✅ **成立**（`round:2+` 126 次无消息级断点仍中位 99.6% 命中；与显式断点语义矛盾 97 倍）；
> 2. **§3.4.5 的 5 个「可能差异环节」** —— ✅ **代码存在性已由 v1.2 评审逐条核实**（见上表 #13）；「静态比对的输入前提」曾不成立，v1.3 已改为「测试内前向捕获」并经评审确认可行；各环节的**实际差异与否**仍待 Phase 0 的静态比对给出结论；
> 3. **~~R2 的字节口径（「`tools` 59,674 可复现」）~~** —— ❌ **该判定错误**。v1.3 已撤销：正确值为 **57,117 字符 / 89,098 字节**（见 §3.3.2 注、§12 v1.3 修正 1）；
> 4. **N3 的主口径选择**（438,640 替代 526,720）—— ✅ 维持。

> **v1.3 修正项的复审判定（已由 v1.2 评审完成）**：
>
> 1. **`tools` = 57,117 / 89,098** —— ✅ **成立**（`57,117/3.5 → ceil 16,320` 精确吻合，评审并额外指出 (59,674 字符, 89,098 字节) 这对组合本身自相矛盾，是有力旁证）；
> 2. **checkpoint 5,559 / 11,815** —— ✅ **成立**（评审独立复现同值；v1.2 的 5,718 / 13,341 为错误口径）；
> 3. **§3.4.2 的新 TTL 论据** —— ✅ **成立**（评审另用全量 19 点验证，TTL 结论正确；并将其列为更强论据）；
> 4. **§3.4.5 的「测试内前向捕获」** —— ✅ **可行**（`finalSurfaceMessages` 已在返回链路中，可做到不改生产代码）。

> **v1.4 修正项的复审判定**：以下由 v1.4 修订时更正，**尚未经独立评审**，建议下一轮优先抽查：
>
> 1. **§7.2 断言 5 的「≈28 KB」**（删 `diff` 后实测 28,968 字符；含保留的 `autoApprovedWrite` 元数据）；
> 2. **§7.2 断言 10 的「完整行 99,709 字节 / 剩余 6,165 字节」**（vs v1.3 的 93,486 / 5.9 KB 字符口径）；
> 3. **§10 的 `system` 双口径标注**（原始 3,934 字符 / 4,388 字节；序列化后 3,992 / 4,446）；
> 4. **§5.4.4 的共用点重定性**（:138 为压缩日志字段而非配对校验；配对校验在 `:187` 且不用该上限）。

## 12. 附：修订记录

### v1.4（2026-09-21）

依据 v1.2 评审 `docs/review/20260921-agent-context-token-cost-optimization-plan-review-v1.2.md`（**结论：无阻断性问题**）的建议修正项修订。**该评审的「须修正 2 项」已在 v1.3 处理**（评审报告针对 v1.2 撰写），本版处理其剩余的**建议修正项**。

**§三-3（须修正）的确认**：评审对「59,674」**翻案成立**——判定 v1.1 评审的 57,117 正确、v1.2 的驳回错误。评审另补一条独立旁证：**(59,674 字符, 89,098 字节) 这对组合自相矛盾**（89,098 字节对应 57,117 字符的紧凑形；带空格形应为 91,655 字节）。v1.3 已更正，本版确认结案。

**§四-2（须修正）的确认**：静态比对输入前提的更正（→「测试内前向捕获 `finalSurfaceMessages`」）经评审确认**可行且无须改生产代码**，v1.3 已处理，本版确认结案。

**本轮处理其余建议修正项（6 处）**：

| # | 位置 | v1.3 及以前 | v1.4 更正 |
|---|---|---|---|
| 1 | §7.2 断言 5 | `edit_file` 降至 ≈14 KB | **≈28 KB**（实测 6,870,438 → **28,968** 字符；保留 `autoApprovedWrite` 元数据 287 字符/次） |
| 2 | §7.2 断言 10 | 「由 93,486 字节降至 ≈5.9 KB」 | **完整行 99,709 字节**（93,486 仅 system+tools）；去两项后余 **6,165 字节**；增量编码后 ≈0.6 KB（**字节/字符口径曾混用**） |
| 3 | §10 字段构成 | `system` 3,992（未标口径） | 标注双口径：原始 **3,934 字符 / 4,388 字节**；序列化 3,992 / 4,446；并补「完整行 99,709 字节 / 去 system+tools 后 6,165 字节」 |
| 4 | §5.4.4 共用点 1 | 「历史重建**配对校验** `:138`，使用该上限」 | **定性更正**：`:138` 是**超大 tool_result 压缩的日志字段**；配对校验在 `claudeStreamHandlers.ts:187`（`ensureToolResultPairing`），**不使用**该上限 |
| 5 | §5.4.4 共用点 2 | `MAX_API_MESSAGE_TEXT_CHARS`（`:2-8`） | 行号更正为 **`toolResultLimits.ts:11`** |
| 6 | §3.4.5 环节 3 | `source: 'history-rebuild'` 在 `claudeToolHistory.ts:60` | 压缩调用在 `claudeToolHistory.ts:60`，**日志上报点在 `chatMessageBuild.ts:35`** |

**§2.4 白名单归因再精确（v1.3 → v1.4）**：`processResultProjection.ts:622-646`（整函数）→ **`639-645`（显式构造白名单对象）**，并补 `agentToolResult.ts:12-35`（`AgentToolResultInput` 入参类型收窄）——两处共同实现白名单。

**§11 免复审清单更新**：按评审 §六-4 建议，并入本轮结案的 **7 项**（编号 11–17），含候选 B 排除推理、反方假说检验、5 个差异环节的代码存在性、N3 口径、R2 收益数字、`autoApprovedWrite` 删除安全性、P1-6 收益上限算术。

**评审 §四-7（per-tool 双面表的 0.1%–7% 小差）**：属**计长细节口径差异**（深/浅剔除、是否含 `result` 键名），类型级总量逐字节吻合，**所有方向性结论不受影响**，故保留本文口径并在 §10 注明「两口径计长」。

### v1.3（2026-09-21）

依据 v1.2 复审的「须修正项（非阻断，2 项）」+ 建议修正项 修订。**两项须修正项均独立复算成立；其中修正 1 推翻了 v1.2 的自我辩护。**

**修正 1：`tools` 字符数应为 57,117（v1.2 的「59,674 可复现」判定错误）**

- v1.2 曾判定「59,674 可精确复现、属格式口径差异」，**该判定错误**。原因：分析脚本用 Python `json.dumps` 的**默认分隔符**（`, ` / `: `，带空格），而生产代码用 JS `JSON.stringify`（紧凑）；
- **决定性印证**：`toolsTokens = 16,320` 实测值，而 `57,117 / 3.5 = 16,319.14 → ceil 16,320` ✓；`59,674 / 3.5 → 17,050` ✗；
- 更正位置：§3.3.2（注重写 + 表格）、§5.1.4、§10、§11（**撤销原「保留分歧」段，改为明确更正**）；
- **字节收益不受影响**：(b) 项按 **89,098 字节/次** 计（该值与评审一致）。

**修正 2：静态比对的输入前提不成立（§3.4.5 / §6 / §7.3）**

- v1.2 写「用同一份 turn N 结束时的 `messagesForApi`」，但 `messagesForApi` 是 `runToolChatSession` 的**局部变量**，只在返回时以 `finalSurfaceMessages` 暴露（`toolChatLoop.ts:543`、`claudeStreamHandlers.ts:566`），**无落盘、无渲染层消费方** → 历史时刻的值**不可事后复现**；
- §3.4.5 改为「**测试内驱动完整一轮并前向捕获** `finalSurfaceMessages`」；§6 Phase 0 与 §7.3 断言 1 同步改写，§8 新增测试文件落点。

**建议修正项（一并处理）**

- **§3.4.2 的 TTL 论据更换**：原用 #49（空闲 7,331.5s → 失效仅 11,264）作反证，但该组**与 TTL 假说同向**，论据不当。改用 **#46（80.8 秒 → 89,216）vs #49（7,331.5 秒 → 11,264）**——空闲相差 90 倍、失效方向相反；并补全 16 次失效的空闲/失效对照与**相关系数 0.449**；
- **行号更正**：`recordToolResult` 定义 `:1472` → **`:1473`**（§2.4）；`compactToolResultContentForApi` 的 `:321` → **`:322`**（§5.4.1）；
- **归因更正（§2.4）**：`claudeToolHistory.ts:36-53` 是 `buildToolResultBlock`（**调用方**），**白名单实现位于** `processResultProjection.ts:622-646` 的 `projectToolResultForSink`——v1.2 把前者直接标为「白名单位置」，不准确；
- **checkpoint 数字更正**：均值 5,718 → **5,559**，最大 13,341 → **11,815**（TS 紧凑口径；§3.3.2、§5.1.1、§5.1.4、§7.2、§10）；
- **`request_header` 去重后剩余**：6,086 → **5,912** 字符（§7.2 断言 10 改为「≈5.9 KB」）；
- **单位统一（v1.3 约定）**：本文 `MB` 一律为 **10⁶ 字节**。(a) 项 10.83 MB（9.05%）、(b) 项 13.65 MB（11.40%）、合计 **24.48 MB（20.45%）**；并修正 (a) 项原写的占比 8.6% → **9.05%**。

### v1.2（2026-09-21）

依据复审 `docs/review/20260921-agent-context-token-cost-optimization-plan-review-v1.1.md` 修订。**两项阻断项（R1、R2）均已独立复算成立**；~~其中 R2 有一处评审自身的复算偏差，本文已注明（§3.3.2、§11）。~~

> **【v1.3 更正】上述「评审自身的复算偏差」是 v1.2 的误判** —— 评审的 **57,117** 正确，v1.2 的 59,674 系分析脚本的分隔符口径错误。详见 **§12 v1.3 修正 1**。

**R1（阻断）：候选 B「断点随尾移动」已被本文自己的用量数据排除**

- 按 `round` 分组复测 145 次 `request_usage`：`round:2+`（126 次）**无消息级断点**，`cache_read` 37,818,240 / 未命中仅 **370,043**（中位命中 **99.6%**）。若按 Anthropic 官方断点语义，未命中应 ≥ **35,990,339**——**差 97 倍**；
- ⇒ **网关为（至少等效于）隐式前缀缓存，断点位置不参与前缀复用**；
- 撤下候选 B 的「最强候选」定位：§1.1、§1.3（**新增纠正 5**）、§3.7（改为排除论证）、§5.3（删除「路径 B」，只剩候选 A）、§7.3（重心改候选 A）；
- **新增 §3.4.5**：候选 A 的具体方向—— turn 首请求经 `buildToolChatMessagesFromSource` 从 DB 重建 vs 实时累积 `messagesForApi` 的序列化差异；含 5 个「可能产生差异的环节」与**可先于埋点执行的静态比对**方案；
- §6 新增 **Phase 0 首项（静态比对）**；§5.2.4 的价值表述从「区分 A/B」改为「定位 A + 结案 B」；§9 新增「时间相关 ≠ 因果」条。

**R2（阻断）：§3.3.2 的「字节」实为「字符」，P1-3 收益被低估约 47%**

- 逐项复算：字符合计 110,387,970 → **UTF-8 字节 119,684,980**（= 文件实际大小）；`request_header` 放大 **1.48**、`tool_result` **1.54**、`edit_file` result **1.58**；
- §3.3.2 表改为**字符 + UTF-8 字节双列**：`request_header` 占比 **8.9% → 12.2%**、`tool_result` **7.1% → 10.0%**；
- P1-3 收益 **16.7 MB（15.1%）→ 24.5 MB（20.5%）**（§1.2、§5.1.1、§5.1.5、§6、总验收第 7 条）；
- §7.2 断言 10「降至 < 2 KB」**改为 ≈6 KB**（v1.3 微调为 **≈5.9 KB**），并**新增识别第三大字段 `toolExecutionCheckpoint`**（5,718 字符/次，最大 13,341；v1.3 更正为 5,559 / 11,815）——§5.1.4 新增 (c) 项与增量编码方案；
- 更正「其余 6 类 410 事件」（实为 **975 事件 / 7 类**）。

**其他（N1–N5）**：

- **N1**：§2.4 行号更正为 **2615 / 2619 / 2631 / 2688**（v1.1 误标 2612/2616/2646/2687）；`recordToolResult` 定义在 `:1473`（v1.3 再更正，v1.2 写 1472）；
- **N2**：§2.4 补「模型面计长口径已由评审确认（唯一差异为键名 `success`→`ok`，336 次合计 < 2 KB / 0.2%）」；
- **N3**：turn 边界失效改为**双口径**——主口径为 `round:1` 实测未命中 **438,640**（54.2% / 8.1%），口径 B 的 526,720 标注为**上界估计**；
- **N4**：`request_usage` 更正为 **145** 次（`request_header` 146）；
- **N5**：§5.1.4 约束更正——`computeContextPressureFromEvents` 只读 `requestId` + `surfaceSnapshot`，**去掉 `system`/`tools` 对 context meter 无影响**（比 v1.1 所写更宽松，本项更可行）。

**保留的分歧（~~已写入 §11~~）**：~~评审 R2 称「`tools` 59,674 无法复现」，本文复算**可精确复现**（按 `JSON.stringify` 默认格式；评审用紧凑格式得 57,117）——属口径差异，**非数据错误**。~~

> **【v1.3 更正】本段判定已被推翻**：v1.2 对评审的「驳回」是**错误的**——分析脚本误用 Python `json.dumps` 默认分隔符（带空格），生产代码为 JS `JSON.stringify`（紧凑）。正确值为 **57,117 字符 / 89,098 字节**（`57,117/3.5 → 16,320` = `toolsTokens` 精确吻合）。详见 §3.3.2 注与 §12 v1.3 修正 1。

### v1.1（2026-09-20）

依据评审 `docs/review/20260920-agent-context-token-cost-optimization-plan-review.md` 修订。**两项阻断项均在代码中独立复核成立，且实测影响大于评审估算（分母高估 9.4 倍）。**

**B1（阻断）**：§2.4 的换算管线**方向画反**。`autoApprovedWrite.diff` **从未进入模型上下文**——它与模型侧内容是 `execResult` 的两个**兄弟分支**，不是上下游。据此：

- **重写 §2.4**（双面口径）：所有体积论断必须标注「事件流面 / 模型面」；新增 **§3.3.2** 记录 `request_header` 同一问题；
- §3.3 重写为双面表：`edit_file` 事件流面占 89.0%，**模型面仅 1.7%**（倍差 484.9）；
- §3.5 重算：净留存 ratio **0.19 → 1.78**（分母高估 9.4 倍），三个「替换机制」候选**全部删除**；
- §5.1（原 P0-1）**重新定位**：从「token 瘦身」改为「事件流 / 备份死数据清理」，并降级为 **P1-3**；
- 新增 **P1-3「事件流体积治理」**：除 `edit_file.diff`（6.87 MB）外，**`request_header` 每次重复写入完整 `system` + `tools`（146 次 × 67 KB = 9.82 MB，占 8.9%）**。

**B2（阻断）**：原 §3.7「生产代码 `cache_control` 零命中」**为事实错误**。`electron/claudeToolLoopStreamParams.ts:34-41` + `electron/toolChatLoop.ts:1012`（`cacheControl: true`）已在**每个**工具循环请求注入断点（system + 尾部字符串消息）。据此：

- §3.7 重写为「现有断点形态」；
- §5.3（原 P0-3）改为「**盘点并重设计现有断点**」，不再假定从零开始；
- §3.4.3 的推理链补注：`request_header` 记录**计划面**，wire 面的断点注入不进指纹；
- §5.2（P0-1）**补充 wire 面埋点要求**。

**其他**：

- **N1**：行号 / 计数更正（§5.1.2、§5.1.4、§10）；
- **N2**：§5.4 补 `MAX_TOOL_RESULT_CONTENT_CHARS` 的两个共用点（历史重建配对校验、IPC 文本上限）；
- **N3**：§3.1 对「缓存写入 0」的含义重述（provider 计量语义，非「未打标」）；
- **编号变更**：原 P0-1（`edit_file` 瘦身）降为 **P1-3**；原 P0-2（埋点）升为 **P0-1**；原 P0-3（断点）改为 **P0-2**（内容重写）；
- **新增 §11「免复审清单」**：引用评审已逐条复核成立的论断，后续修订不再重查。

### v1.0（2026-09-20）

初版。汇总本会话对 `b680b181` 的多轮取数分析与 Codex 对照结论，形成 6 项改进 + 1 项撤回；含两处对前期口头结论的自我纠正（v1.1 扩充为 §1.3 的「四处」）。
