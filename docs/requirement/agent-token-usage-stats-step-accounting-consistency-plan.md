# Agent Token 用量统计 · 步数/Tokens 记账一致性修订方案

**版本：** 1.0（方案待评审，未实施）
**日期：** 2026-10-07
**状态：** 待用户评审 —— 本文只出方案，不改代码
**触发背景：** 观测到「过去 7 天 234 个 Turn / 4 亿 Tokens / 平均 6.9 步」，折算 **171 万 Tokens/Turn、24.8 万 Tokens/Step**，怀疑统计逻辑有误
**关联文档：**

- `docs/requirement/agent-token-usage-analytics-requirement.md`（口径基准，v1.19）
- `docs/develop/context-usage-accuracy-issues.md`（上下文占用准确性，非本文范围）

---

## 1. 结论摘要

先直接回答「是不是算错了」：

| 结论 | 说明 |
|------|------|
| **171 万/Turn、24.8 万/Step 这个数值本身是自洽的，不是算错** | 口径为「请求累计」：每步把当前完整上下文重算一次，其中 80%–95% 是 `cache_read`。这是需求 §2.2.1 明确定义的口径，长上下文单步 20 万–42 万有真实样本佐证（§2.6.4） |
| **但确实有两处记账缺陷会让 Tokens/Step 虚高** | ① 「步数」按 model round 计、「Tokens」按 provider attempt 计，口径错位；② 实时写入与历史回填的 `step_id` 生成规则不一致，会绕开唯一键造成 **Tokens 翻倍级** 重复计数 |
| **前者是量的偏差（通常几个百分点，取决于重试率）** | 重试 / 输出截断恢复越多的会话，偏差越大 |
| **后者是条件触发的高危缺陷（翻倍级）** | 仅在「回填与实时同时覆盖同一 Turn」时触发，触发条件是回填护栏元数据丢失（DB 还原 / 换机 / meta 清理） |
| **另外两处次要风险建议一并复核** | attempt 编号可能复用导致 step 行互相覆盖（低估）；`toolSkippedCount` 与 `toolCallCount` 的集合口径不一致 |

**一句话：数值没算错，是「请求累计口径」放大了它；需要修的是两处一致性问题，而不是重做统计。**

---

## 2. 先定性：171 万/Turn 为什么「看起来吓人但其实正常」

### 2.1 口径推导

需求 §2.2.1 规定（本项目 provider 实测全部走 `additive` 分支）：

```text
inputTokens = input_tokens + cache_read_input_tokens + cache_creation_input_tokens
totalTokens = Σ inputTokens + Σ outputTokens        （§2.3）
```

而 `UsageStepFact` 是**每次 provider 请求尝试写一行**（`recordStepUsage`），因此：

```text
每 Turn 的 Tokens ≈ 步数 × 该 Turn 的平均完整上下文长度
```

即：**Tokens 与「任务做了多少事、跑了多久」几乎无关，只与「上下文有多大 × 发了几轮请求」相关。**

代入用户的数字：

```text
4e8 / 234 Turn        ≈ 171 万 / Turn
171 万 / 6.9 Step     ≈ 24.8 万 / Step   ← 这就是「该 Turn 单次请求的完整上下文长度」
```

### 2.2 真实样本佐证（需求 §2.6.4，1281 条真实 `llm.response.usage`）

| 场景 | usage 原文 | 归一化输入 |
|------|-----------|-----------|
| DeepSeek 长上下文（命中接近满） | `{input: 443, cache_read: 427520, cache_creation: 0, output: 1662}` | **427963** |
| 同 Turn 第 3 轮 | `{input: 4364, cache_read: 46464, cache_creation: 0, output: 760}` | 50828 |
| 火山方舟 `kimi-k2.6` | `{input: 122, cache_read: 23812, output: 156}` | 23934 |

第一条里 `cache_read` 占归一化输入的 **99.9%**。命中率分布均值 82.3%、中位数 95.7%（§2.6.5）。**所以「24.8 万/步」绝大部分是同一段前缀被反复读取的 `cache_read`，不是 4 亿的新增内容或新输出。**

### 2.3 需要向用户澄清的一句话

> 「总 Tokens」是**请求累计口径**，不是「净新增内容量」。同一段 system + tools + 历史 messages，在一轮里被发 N 次，就计 N 次。它适合回答「我听了几次完整上下文」，不适合直接读成「成本」。

如果希望界面上有一眼能看懂的「去重口径」，那属于新增指标，见 §7 明确不做的部分。

---

## 3. 证据链（代码定位）

| 环节 | 位置 | 行为 |
|------|------|------|
| 口径归一化 | `src/shared/contextUsageEstimate.ts` → `computeTotalRequestInputTokens` | additive = `input + cacheRead + cacheCreation` |
| 汇总口径 | `electron/usageStats/usageStatsQueries.ts` → `queryUsageSummary` | `totalTokens = Σ input + Σ output`；`avgStepsPerTurn = Σ stepCount / turnCount` |
| Step 行写入 | `electron/usageStats/usageStatsRecorder.ts` → `recordStepUsage` → `insertUsageStepFact` | 每次 provider 请求尝试一行 |
| Step 表唯一键 | `electron/database/schema.ts`（v16）、`operations.ts` → `insertUsageStepFact` | `UNIQUE(session_id, turn_id, step_id)`，冲突 **DO UPDATE 覆盖** |
| **实时** step_id 生成 | `electron/runtime/agentSdkUsageRecorder.ts` → `createAgentSdkUsageRecorder` | `` `${requestId}:model:${modelTurn}:attempt:${attemptNumber}` `` |
| **台账** requestId 生成 | 同文件 → `createAgentSdkUsageSessionEvent` | `` `${requestId}:round:${modelTurn}${attempt>1?`:attempt:${n}`:''}` `` |
| **回填** step_id 取值 | `electron/usageStats/usageStatsBackfill.ts` | 直接取台账 `payload.requestId`（即上面的 `:round:` 形态） |
| 回填触发条件 | `electron/main.ts:684` | 仅当 `SCHEMA_META_KEYS.usageStatsBackfillAt` 不存在时执行一次 |
| stepCount 来源 | `electron/runtime/hostedTurnUsageSummary.ts` | `counts.stepCount += input.modelTurns`（**model turn，不含 attempt**） |
| modelTurns 传入 | `electron/runtime/hostedTurnHandoff.ts:353` | `Math.max(0, hosted.modelTurns - (initialResponse ? 1 : 0))` |
| 首轮不写 step 行 | `packages/agent-sdk/src/turn.ts:1006` | `if (!initialResponse) { ...projectModelAttemptUsage... }` |
| Turn 行落库 | `electron/toolChatLoop.ts:610/633/679` → `finalizeInvocationResult` → `recordTurnSummary` | `runToolChatSession` 的 `finally` 统一收口 |

---

## 4. 问题清单

### 4.1 P1-A：实时与回填的 `step_id` 生成规则不一致 → Tokens 重复计数（翻倍级）

**现状**

同一逻辑步骤，两条写入路径生成了**两个不同的 `step_id`**：

```
实时（invocationAssembler → createAgentSdkUsageRecorder）
  step_id = "{requestId}:model:{modelTurn}:attempt:{attemptNumber}"

台账事件 request_usage（createAgentSdkUsageSessionEvent）
  requestId = "{requestId}:round:{modelTurn}"            (attempt = 1)
  requestId = "{requestId}:round:{modelTurn}:attempt:{n}" (attempt > 1)

回填（usageStatsBackfill，直接复用台账 requestId）
  step_id = "{requestId}:round:{modelTurn}[:attempt:{n}]"
```

两串字符串**永不相等**（`model:` vs `round:`，且 attempt=1 时一侧有后缀一侧没有）。而唯一键是 `(session_id, turn_id, step_id)`，`ON CONFLICT` 于是**不生效**：

```
同一 (session, turn) 被实时 + 回填各覆盖一次
  → usage_step_facts 里同一逻辑步骤存在 2 行
  → SUM(input_tokens) / SUM(output_tokens) 翻倍
  → 而 usage_turn_facts 的 turnCount / stepCount 不变
     （回填对 turn 行是「已存在则跳过」：`if (getUsageTurnFact(db, turnId)) continue`）
  → 净效果：Tokens/Step 直接翻倍，Turn 数与 Step 数看起来完全正常
```

> 这正是用户描述的症状形态：**分母（Turn / Step）正常，分子（Tokens）异常大。**

**为什么当前没爆**

`electron/usageStats/usageStatsBackfill.ts` 的注释声称「step 行按 UNIQUE 键覆盖 → 幂等」，这句话相对**回填自身重跑**成立（回填生成的 step_id 稳定），但**相对实时行不成立**。目前被 `main.ts` 的 `usageStatsBackfillAt` 一次性护栏挡住，正常升级路径不会重跑。

**触发条件（真实存在）**

- DB 被还原 / 换机 / 从备份恢复，导致 `schema_meta.usageStatsBackfillAt` 丢失；
- 台账目录尚存（回填能扫到），且该批 Turn 此前已被实时写入。

一旦触发，**该批会话的 Tokens 全部翻倍**，且不会自愈。

**严重度：** 高（翻倍级、不可自愈）。**触发概率：** 低（需 meta 丢失）。

---

### 4.2 P1-B：`stepCount` 按 model round 计，Tokens 按 attempt 计 → Tokens/Step 偏高

**现状**

| 量 | 粒度 | 代码 |
|----|------|------|
| Tokens（step 行） | **provider attempt** | 每个 attempt 写一行 `usage_step_facts` |
| stepCount | **model turn（round）** | `counts.stepCount += input.modelTurns` |

同一 round 内若发生 **provider 重试**（`request_retry`）或**输出截断恢复**（`model_output_token_limit` discarded attempt），Tokens 会多计一份，而 stepCount 仍是 1：

```text
tokens/step 被放大倍数 ≈ 1 + (重试/恢复的 attempt 数) / (总 round 数)
```

**与需求文档的口径张力（需要裁决）**

- §2.1 定义 Step = `toolChatLoop` 的 `loopRound`，台账里对应 `requestId` 形如 `:round:${n}` 的那条 → **round 粒度**；
- C9 决策：「步数口径 = **实际产生了 usage 记录的 Step 数**，不按 outcome 剔除」→ **usage 记录 = attempt 粒度**。

两者对「重试算几步」给出了不同答案。当前实现是「分子按 attempt、分母按 round」，**正好取了两种口径各自的分子/分母，是纯粹的错位**（既不是 A 也不是 B）。

**严重度：** 中（偏差随重试率放大，日常场景通常几个百分点；高重试会话可显著偏高）。**触发概率：** 高（有重试即触发，只是幅度小）。

---

### 4.3 P2-C：attempt 编号可能复用 → step 行互相覆盖（低估）

**现状**（`packages/agent-sdk/src/turn.ts`）

| 场景 | attempt 编号 |
|------|-------------|
| output recovery discarded | `recoveredAttempt ? 2 : 1` |
| accepted attempt | `acceptedAttemptNumber = recoveredAttempt ? 2 : 1` |
| provider retry | 固定 `2`（`collectProviderAttempt(..., modelTurns, 2)`） |
| output recovery 重试 | `recoveryAttempt = outputRecoveryAttempts + 1` |

同一 `modelTurn` 内，若「provider 重试成功后仍输出截断、再走 output recovery」，两条记录都可能落到 `:model:{N}:attempt:2` → **step_id 相同 → 后者覆盖前者 → Tokens 低估**。

**现状缓解：** 失败 attempt（无 usage）不写行（`if (!collected.usage) throw`），所以实际碰撞需要「两次都成功收集到 usage」，概率较低但非零。

**严重度：** 低–中（低估，且难以察觉：无告警、无日志）。**性质：** 需实证复核（建议加断言/日志观测，见 §6.3）。

---

### 4.4 P2-D：`toolSkippedCount` 与 `toolCallCount` 的集合口径不一致

**现状**（`electron/runtime/hostedTurnUsageSummary.ts`）

```ts
counts.toolCallCount   += toolResults.length + notDispatchedOnly.length   // 用 notDispatchedOnly
counts.toolSkippedCount += notDispatched.size                            // 用 notDispatched（全集）
```

`notDispatchedOnly = notDispatched ∖ replayedToolIds`。两个集合口径不同：若某个 toolCallId **同时**出现在 `notDispatched` 与重放 `toolResults` 中，它会被**同时计入 toolCall 与 toolSkipped**。按三分类恒等式 `call = success + error + skipped` 反推，该条被记为「未执行」——语义上是可疑的（既然重放了，就不该是「未派发」）。

**严重度：** 低（不影响 Tokens，只影响工具计数与出错率；且需要特定 handoff 组合才触发）。**性质：** 需实证复核，建议统一为 `notDispatchedOnly`。

---

### 4.5 非问题（明确不改）

| 项 | 说明 |
|----|------|
| `inputTokens` 含 `cache_read` | 需求 §2.2.1 明确定义的「进入模型的全部输入 token」，**是设计不是缺陷** |
| `totalTokens = input + output` | 需求 §2.3 明确定义 |
| 命中率分母方案 B | 需求 §2.5 已裁决 |
| 单步 24.8 万看似巨大 | 请求累计口径的必然结果，见 §2 |

---

## 5. 修改方案

### 5.1 方案 A：统一 `step_id` 生成（修 P1-A）

**目标：** 同一逻辑步骤，无论实时还是回填，生成**同一个 `step_id`**，使 `UNIQUE(session_id, turn_id, step_id)` 真正发挥幂等作用。

**做法（推荐 A1）**

1. 新增纯函数（建议放 `src/shared/usageStepId.ts`，两侧同源引用）：

   ```ts
   /** 用量统计 step 行的稳定主键片段：一个 (round, attempt) 唯一对应一个 provider 请求。 */
   export function buildUsageStepId(input: {
     requestId: string
     modelTurn: number
     attempt: number
   }): string {
     return `${input.requestId}:model:${input.modelTurn}:attempt:${input.attempt}`
   }
   ```

2. **实时侧**（`agentSdkUsageRecorder.ts` → `createAgentSdkUsageRecorder`）改为调用 `buildUsageStepId`（行为不变，等价重构）。

3. **回填侧**（`usageStatsBackfill.ts`）不再直接使用台账 `payload.requestId`，改为**解析** `:round:` 形态后重组：

   ```ts
   // 台账形态：{base}:round:{modelTurn}[:attempt:{n}]
   // 目标形态：{base}:model:{modelTurn}:attempt:{n}   （attempt 缺省补 1）
   function parseLedgerUsageRequestId(ledgerRequestId: string):
     { base: string; modelTurn: number; attempt: number } | undefined
   ```

   解析失败（畸形行）时**跳过并计数**（沿用现有 `skippedMalformedFiles` 同级的告警日志，不静默丢）。

4. **台账事件本身不动**：`createAgentSdkUsageSessionEvent` 的 `requestId` 保持 `:round:` 形态，因为它是需求 §2.1 的 Step 定义载体、且属于台账对外契约（旧版本读新台账的兼容性问题）。**只统一「统计表主键」，不改台账契约。**

**备选方案**

| 方案 | 做法 | 评价 |
|------|------|------|
| **A2** | 反向统一：实时侧也改成 `:round:` 形态 | ❌ 不推荐。会丢掉 `attempt` 维度，使同一 round 的多次尝试互相覆盖 → 直接引入 P2-C 那类低估 |
| **A3** | 唯一键改为 `(session_id, turn_id, source, step_id)`，让实时与回填各留一行 | ❌ 不推荐。问题从「重复计数」变成「结构上承认两份账」，SUM 依然翻倍，反而更难发现 |
| **A1（推荐）** | 抽出 `buildUsageStepId`，回填解析台账 id 后重组 | ✅ 改动集中、可单测、不触碰台账契约 |

**幂等性提升（附带收益）**

统一后，回填**重跑**会 UPDATE 覆盖实时行。但需注意：回填拿不到 `attribution_json` / `system_tokens` 等归因真列，覆盖会把实时写入的归因数据抹成 NULL。**因此必须同时收紧回填的覆盖语义**：

```
step 行写入策略由「无条件 UPSERT」改为：
  若该 (session_id, turn_id, step_id) 已存在 且 source = 'api' 且 attribution_json IS NOT NULL
    → 跳过（实时行优先，不覆盖归因数据）
  否则 → UPSERT
```

实现方式建议在 `insertUsageStepFact` 增加一个显式的 `preserveExistingRichRow?: boolean`（或在回填侧先 `SELECT` 判断），**不要**把策略塞进通用写入函数里隐式生效。

---

### 5.2 方案 B：`stepCount` 与 step 行对齐（修 P1-B）

**目标：** 让 `usage_turn_facts.step_count` 严格等于该 Turn 在 `usage_step_facts` 中的实际行数，使 `avgStepsPerTurn` 与 tokens/step 可解释。

**前置裁决（需用户确认）：** 「重试算不算一步？」

- **选项 B-α（推荐）：按 usage 记录数算（attempt 粒度）**
  - 理由：与 C9 原文「实际产生了 usage 记录的 Step 数」一致；与 Tokens 同源，tokens/step 才有意义；重试是真实发生的请求，理应可见。
  - 代价：需同步修订需求 §2.1 的 Step 定义（把「对应 `:round:` 的那条」改为「对应每条 `request_usage` 记录」）。
- **选项 B-β：按 round 算（model turn 粒度）**
  - 理由：与 §2.1 台账定义一致。
  - 代价：与 Tokens 分子不同源，`tokens/step` 仍会被重试放大（问题只解决一半），且需要把同 round 的多个 attempt 行在统计查询时按 round 归并。

**推荐实现：B-α + 以「实存 step 行数」为准（B1）**

在 `recordTurnSummary` 落库前，把传入的 `counts.stepCount` 替换为对 `usage_step_facts` 的实际计数：

```ts
// electron/usageStats/usageStatsRecorder.ts → recordTurnSummary
// stepCount 以该 (session_id, turn_id) 实存 step 行数为准（与 Tokens 同源、天然排除 initialResponse 轮）
const stepCount = countUsageStepFacts(db, input.sessionId, input.turnId)
```

- 复用 `usageStatsBackfill.ts` 里已有的 `countStepFacts`（建议提到 `database/operations.ts` 作为公共查询，避免两处重复实现）；
- `hostedTurnUsageSummary.mergeHostedTurnUsageSummary` 中的 `counts.stepCount += input.modelTurns` **保留但降级为交叉校验**（不再作为落库依据），这样 `hostedTurnUsageSummary.test.ts` 的现有断言不至于全面失效；
- `modelTurns` / `initialMessageCount` 的入参结构与校验保持不动。

**为什么天然一致**

| 轮次 | 是否写 step 行 | 是否计入 modelTurns |
|------|---------------|-------------------|
| `initialResponse` 首轮（host 已提交） | ❌ 不写（`turn.ts:1006`） | ❌ 已扣 1（`hostedTurnHandoff.ts:353`） |
| 其余 round × 每次 attempt | ✅ 每次一行 | ✅ 每 round 加 1 |

改为「按行计数」后，`initialResponse` 的排除语义**自动保持**，无需额外分支。

**备选方案**

| 方案 | 做法 | 评价 |
|------|------|------|
| **B1（推荐）** | Turn 收口时查 DB 实际行数作为 `step_count` | ✅ 恒等式天然成立；无需改计数通道；与崩溃补齐（`reconcileUsageTurnFacts` 已用孤儿 step 计数）口径一致。代价：每 Turn 一次同步 COUNT |
| **B2** | 让 `recordStepUsage` 返回写入结果，由它驱动 `turnUsageStats.stepCount` | ⚠️ 更「事件驱动」，但需跨 `invocationAssembler → ports.usage → SDK observer` 新增回调通道；且 `safeWrite` 容错路径下「调用成功但写入失败」会造成新的不一致 |
| **B3** | 保持现状，仅在 UI 加「步数含重试」提示 | ❌ 不修口径，只加注释，`tokens/step` 仍不可解释 |

---

### 5.3 方案 C/D：次要风险的处置

| 项 | 建议 | 说明 |
|----|------|------|
| **P2-C** attempt 编号复用 | **先观测，不急于改** | 在 `createAgentSdkUsageRecorder` 内加一条 `usageStats.step.overwritten` 告警日志（写入前 `SELECT` 判断 `(session,turn,step)` 是否已存在，或由 `insertUsageStepFact` 返回 `changes` 判定）。观测一周确认是否真实发生，再决定是否引入 `attemptKey` 去重（如 `output-recovery` 与 `provider-retry` 使用不重叠的编号空间） |
| **P2-D** 集合口径不一致 | **改为 `notDispatchedOnly.size`** | 一行改动 + 一条单测；需先确认「同时出现在 notDispatched 与 replayed」是否真实可能，若不可能则应加**断言**而非静默改为一致 |

---

### 5.4 已有脏数据的校正（可选，需用户决策）

若确认本机数据已被 P1-A 污染，修复需两步，**顺序不可颠倒**：

**第 1 步：去重（只删回填格式行）**

```sql
-- 仅当同一 (session_id, turn_id) 同时存在实时格式行时，才删除回填格式行
DELETE FROM usage_step_facts
WHERE step_id LIKE '%:round:%'
  AND EXISTS (
    SELECT 1 FROM usage_step_facts AS live
    WHERE live.session_id = usage_step_facts.session_id
      AND live.turn_id   = usage_step_facts.turn_id
      AND live.step_id LIKE '%:model:%'
  );
```

- 保留纯回填的历史 Turn（那些 Turn 没有实时行，是唯一数据源，不能删）；
- 执行前后打印行数与日期区间（沿用 C8 的「删除留痕」纪律），**必须做成显式的一次性维护脚本 + 用户确认**，不要塞进启动流程。

**第 2 步：重算 `step_count`**

```sql
UPDATE usage_turn_facts
SET step_count = (
  SELECT COUNT(*) FROM usage_step_facts s
  WHERE s.session_id = usage_turn_facts.session_id
    AND s.turn_id    = usage_turn_facts.turn_id
)
WHERE EXISTS (
  SELECT 1 FROM usage_step_facts s
  WHERE s.session_id = usage_turn_facts.session_id
    AND s.turn_id    = usage_turn_facts.turn_id
);
```

（`interrupted` Turn 的工具计数按 0 写入的定义不变，本步只动 `step_count`。）

> ⚠️ 该校正会**改动历史统计数值**，属破坏性操作。建议：先备份 DB；在 UI 上明确告知「历史数据已按新口径重算」。

---

## 6. 自查与验收

### 6.1 用户可先自行执行的诊断 SQL（只读，不改数据）

打开应用的 SQLite 库（`userData` 目录下）执行：

**① 是否存在「实时 + 回填」双格式并存的 Turn（P1-A 证据）**

```sql
SELECT session_id, turn_id,
       COUNT(*)                          AS step_rows,
       SUM(step_id LIKE '%:model:%')     AS live_fmt_rows,
       SUM(step_id LIKE '%:round:%')     AS backfill_fmt_rows
FROM usage_step_facts
GROUP BY session_id, turn_id
HAVING live_fmt_rows > 0 AND backfill_fmt_rows > 0
ORDER BY step_rows DESC
LIMIT 50;
```

**有结果 ⇒ 该批 Turn 的 Tokens 已被重复计数（翻倍级）。**

**② step 行总数 vs 声明步数（P1-B 证据）**

```sql
SELECT (SELECT COUNT(*) FROM usage_step_facts)      AS actual_step_rows,
       (SELECT SUM(step_count) FROM usage_turn_facts) AS declared_steps,
       (SELECT COUNT(*) FROM usage_turn_facts)        AS turn_count;
```

`actual_step_rows > declared_steps` 的差值 = **被 Tokens 计了、但步数没计的次数**（即重试/恢复次数）。

**③ Tokens/Step 实算（对齐用户看到的 KPI）**

```sql
SELECT ROUND(1.0 * SUM(t) / SUM(s.steps)) AS tokens_per_step
FROM (SELECT turn_id, SUM(input_tokens + output_tokens) AS t
      FROM usage_step_facts GROUP BY turn_id) x
JOIN (SELECT turn_id, step_count AS steps FROM usage_turn_facts) s
  ON s.turn_id = x.turn_id;
```

**④ 输入构成拆分（判断「是不是缓存重复计数」）**

```sql
SELECT SUM(input_tokens) AS input_total,
       SUM(cache_read_tokens) AS cache_read_total,
       ROUND(1.0 * SUM(cache_read_tokens) / NULLIF(SUM(input_tokens),0), 4) AS cache_share
FROM usage_step_facts;
```

`cache_share` 若在 0.8–0.95 → 属正常口径放大（§2），不是缺陷。

### 6.2 单测与验收用例

| 编号 | 用例 | 断言 |
|------|------|------|
| T1 | `buildUsageStepId` 纯函数 | 同一 (requestId, modelTurn, attempt) 恒定输出；不同 attempt 输出不同 |
| T2 | 台账 id 解析 | `:round:3` → `{modelTurn:3, attempt:1}`；`:round:3:attempt:2` → attempt 2；畸形 id 返回 undefined |
| T3 | **幂等（核心）** | 同一 Turn 先走实时写入、再走回填 → `usage_step_facts` 行数**不变**，`SUM(input_tokens)` **不变** |
| T4 | 归因保护 | 实时行含 `attribution_json`，回填覆盖时该行**不被抹成 NULL** |
| T5 | stepCount 恒等式 | 任意 Turn：`usage_turn_facts.step_count == COUNT(usage_step_facts 同键行)` |
| T6 | `initialResponse` 排除 | 含首轮的 Turn：`step_count` == 总 round 数 − 1，且 == 实存 step 行数 |
| T7 | 重试不丢 | 同 round 两个 attempt（1 成功 + 1 recovery）→ step 行 2 行（在 P2-C 未修前的现状断言，用于锁定观测） |
| T8 | 回归 | `usageStatsQueries` 的 daily/summary 在 T3 场景下 `totalTokens` 不翻倍 |

### 6.3 观测（用于 P2-C 定性）

在 `insertUsageStepFact` 返回值（`changes`）或写入前 `SELECT` 判定，命中「同键已存在」时打一条：

```
usageStats.step.overwritten  { sessionId, turnId, stepId, previousInputTokens, newInputTokens }
```

若一周内无该告警 ⇒ P2-C 不成立，可关闭；若有 ⇒ 升级为 P1 处理。

---

## 7. 明确不做（本次范围外）

| 项 | 理由 |
|----|------|
| 改口径为「去重 / 摊销」的净新增 token 指标 | 属新增指标，不是修 bug。可作为后续需求（例如「净新增输入 = input − cache_read」的辅助卡片） |
| 费用估算 | 需求 §10.1 已明确不做 |
| 改台账 `request_usage.requestId` 形态 | 台账对外契约，改它是破坏性的；本方案只统一统计表主键 |
| 改 `insertUsageStepFact` 的 UNIQUE 键结构 | 键结构正确，问题在生成规则不一致，改键是治错方向 |
| 修改 §2.6.4 的真实样本与命中率分布 | 这些是事实基线，不动 |

---

## 8. 影响面与风险

| 文件 | 改动 | 风险 |
|------|------|------|
| `src/shared/usageStepId.ts` | **新建**：`buildUsageStepId` + 台账 id 解析 | 低（纯函数） |
| `electron/runtime/agentSdkUsageRecorder.ts` | 改用 `buildUsageStepId`；加覆盖告警日志 | 低（等价重构 + 观测） |
| `electron/usageStats/usageStatsBackfill.ts` | 解析台账 id 重组 step_id；加「实时行优先」跳过逻辑；计数畸形行 | **中**（回填策略变化，需 T3/T4 覆盖） |
| `electron/database/operations.ts` | 提公共 `countUsageStepFacts`；`insertUsageStepFact` 增可选「保留既有富行」语义 | 中（写入函数语义变更，需逐个调用点核对） |
| `electron/usageStats/usageStatsRecorder.ts` | `recordTurnSummary` 的 `stepCount` 改为 DB 实存行数为准 | 中（Turn 行语义变更） |
| `electron/runtime/hostedTurnUsageSummary.ts` | `stepCount` 降级为交叉校验；`toolSkippedCount` 改用 `notDispatchedOnly` | 低–中（影响既有单测） |
| `docs/requirement/agent-token-usage-analytics-requirement.md` | 按 §5.2 裁决同步 §2.1 Step 定义与 §2.3 `avgStepsPerTurn` 口径 | 低（文档） |
| 一次性维护脚本（去重 + 重算） | **新建**，需用户显式确认后执行 | **高**（破坏性，需备份） |

**回滚策略：** 代码改动均可通过 revert 回退；但 §5.4 的数据校正**不可自动回滚**，执行前必须备份 DB 文件。

---

## 9. 待用户决策项

| # | 决策项 | 选项 | 建议 |
|---|--------|------|------|
| D1 | 本次实施范围 | ①只修 P1-A；②只修 P1-B；③A+B 一起；④A+B+C+D 全修 | **③**（A 是翻倍级；B 是持续偏差；C/D 先观测） |
| D2 | 「重试算不算一步」（§5.2） | B-α attempt 粒度 / B-β round 粒度 | **B-α**，并同步修订需求 §2.1 |
| D3 | 是否执行已有脏数据校正（§5.4） | 是 / 否（先只止血、不动历史） | 建议：**先跑 §6.1 诊断 SQL**，若确认有污染再决定；执行前备份 |
| D4 | P2-C 是否先观测再定 | 观测一周 / 立即修 | **先观测**（§6.3） |
| D5 | 是否新增「净新增 token」指标卡 | 加 / 不加 | 属后续需求，本次不加 |

---

## 10. 修订记录

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0 | 2026-10-07 | 初始版本：定性 171 万/Turn 的口径归因；定位 P1-A（step_id 不一致致 token 重复计数）、P1-B（stepCount 与 tokens 粒度错位）、P2-C（attempt 编号复用）、P2-D（工具计数集合口径）；给出 A/B 两套修改方案与备选对比、诊断 SQL、验收用例与决策项 |

---

**说明：** 本文仅为方案，**未修改任何代码与数据**。请先评审 §9 决策项，确认后再进入实施。
