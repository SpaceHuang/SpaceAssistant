# 上下文占用准确性问题清单

> 本文聚焦当前上下文占用计算的**准确性**问题（区别于 `context-usage-realtime-improvement-design.md` 的实时性改进）。每条给出误差方向、量级、触发条件与改进方向。

## 问题 1：投影值污染 `lastValidUsage` 并持久化

### 现象

`electron/toolChatLoop.ts:1313-1316`：

```ts
const projected = projectUsageAfterToolResults(lastValidUsage, toolResults) // length/3.5 粗估
lastValidUsage = projected          // 估算值覆盖真实值
safeWebContentsSend(sender, 'claude-chat-usage', { requestId, sessionId, usage: projected })
```

`projectUsageAfterToolResults`（`src/shared/contextUsageEstimate.ts:100`）用 `estimateTokensFromUtf8Text`（`text.length / 3.5`）估算 tool_result 新增 token，加到 `input_tokens` 上。这个投影值随后：

1. 覆盖 `lastValidUsage`（本是真实 usage 的载体）
2. 经 `claude-chat-usage` 推送到渲染端
3. 渲染端 `applyContextUsageUpdate` 立即 `usageSet` 持久化（`database.ts:204` `usages[sessionId] = usage`，整体覆盖写入）

### 误差方向：不确定，多数偏低

- 取决于 `length/3.5` 与真实 tokenizer 的偏差。中英文混合场景下 `length/3.5` 通常**偏低**（CJK 字符按 UTF-8 占多字节，但真实 tokenizer 往往更碎）。
- 正常流程：下一轮 `message_start`/`finalMessage` 的真实 usage 会覆盖回来，最终值准确。
- 风险窗口：会话在下一轮真实 usage 到达前被中断（用户取消、`abortRepeatedToolError` 触发 `failToolLoopWithLastUsage`）时，落库与恢复的 `lastUsage` 即污染值，直到下次真实请求才覆盖。

### 量级

中等。仅在中断时机定格，且被下次真实请求覆盖。但污染值会落盘，重启后仍可见。

### 改进方向

投影值用独立通道/标记发送，**不写回 `lastValidUsage`**，落库时区分"真实 usage"与"投影 usage"。例如 `claude-chat-usage` 事件 payload 增加 `projected: boolean`，渲染端对 `projected: true` 仅更新 UI 不 `usageSet`，或在 UI 上标注"临时估算"。

### 失败回退放大

`pickToolLoopReturnUsage(usage, lastValidUsage)`（`toolChatLoop.ts:282`）在 `usage` 缺失时回退 `lastValidUsage`。若此时 `lastValidUsage` 已被投影污染，返回值同样污染。改进同上（投影不进 `lastValidUsage`）。

---

## 问题 2：cache 高命中时启发式误判，严重低估

### 现象

`src/shared/contextUsageEstimate.ts:12-29` 的 `computeTotalRequestInputTokens` 用数值启发式区分 Anthropic 加性口径与 OpenAI 子集性口径：

```ts
if (input >= cacheSum) {
  if (cacheRead < input * 0.5) return input + cacheSum   // 判定 Anthropic 加性
  return input                                           // 判定 OpenAI 子集性
}
return input + cacheSum                                  // input < cacheSum，加性
```

阈值 `cacheRead < input * 0.5` 是经验值。

### 误差方向：低估

对 **Anthropic 官方 API**，长会话 cache 命中率高时，非缓存 `input_tokens` 很小（仅本轮新增内容），而 `cache_read_input_tokens` 占大头。此时 `cacheRead > input * 0.5` 极易成立，被误判为"OpenAI 子集性"，返回 `input` 而非 `input + cacheSum`。

**漏掉的全部是 cache token**——这正是上下文占用的主体。

### 量级

严重。长会话中 cache token 可达数十万级，环形图却只显示非缓存的 `input_tokens`，与真实占用相差一个数量级。后果：用户在上下文已接近上限时仍看到"还很空"，错过清理/新建会话时机，最终触发 `context_length_exceeded` 报错。

### 触发条件

- Anthropic 官方 API（或正确实现加性 cache 口径的网关）
- 会话累积到 cache 命中率高（长 history + 启用 prompt caching）

### 改进方向

根因是用 token 比例猜 provider 口径，而项目实际有 provider 信息（`llmModelConfig.ts` / `serviceId` / `baseUrl`）。更稳的做法：

- 在归一化阶段（`normalizeAnthropicMessageUsage`）按 provider 标注口径，`usage` 对象携带 `cacheSemantics: 'additive' | 'subset'` 字段。
- `computeTotalRequestInputTokens` 改为读该字段，不再用比例启发式。
- 对未知 provider 保留保守加性（避免低估，宁可略高估）。

这是本清单中**最该优先修**的一项——方向是低估，且后果（悄悄爆 context）最严重。

---

## 问题 3：thinking token 计入占用致虚高

### 现象

`src/shared/contextUsageEstimate.ts:32-34`：

```ts
export function computeEstimatedOccupancy(usage: ContextUsageRaw): number {
  return computeTotalRequestInputTokens(usage) + (usage.output_tokens ?? 0)
}
```

Anthropic 的 `output_tokens` 在开启 extended thinking 时**包含 thinking tokens**。

### 误差方向：高估

thinking 在**当前轮**不占 context 上限——它不回填到本轮 prompt。`estimatedOccupancy` 却把它加进当前占用，使环形图偏高。thinking 真正计入占用是在**下一轮**（进入 input），而那时它已包含在下一轮的 `input_tokens` 里，由 input 部分正确反映。

即：thinking token 被算了两遍的"时间错位"——本轮多算一次（output 里），下一轮又算一次（input 里），而它实际只该在下一轮占空间。

### 量级

看推理长度。短思考可忽略；长思考（开启深度推理、复杂任务）可多算几千到上万 token，环形图明显虚高，让用户误以为快满了。

### 触发条件

- 启用 extended thinking 的模型（项目 `runSendStream` 默认 `thinking: { type: 'adaptive' }`，`claudeStreamHandlers.ts:395`）

### 改进方向

- **理想**：Anthropic usage 在 interleaved thinking 下不单独拆分 thinking token，无法精确扣除。若未来 API 提供 thinking token 拆分字段，则扣除。
- **当前可行近似**：
  - 在 thinking 模型上对 `output_tokens` 部分降权或加注"含思考"，避免与 input 部分直接相加产生误导。
  - 或在 tooltip 标注"输出含思考 token，未全部占用当前上下文"。
  - 折中：`estimatedOccupancy = totalRequestInput + min(output_tokens, 某上限)`，限制 output 贡献，但会引入新的失真，需谨慎。

---

## 汇总

| # | 问题 | 误差方向 | 量级 | 优先级 |
|---|---|---|---|---|
| 2 | cache 高命中启发式误判 | 低估 | 严重（差一个数量级） | **最高** |
| 3 | thinking token 计入占用 | 高估 | 中（看推理长度） | 中 |
| 1 | 投影值污染并持久化 | 不确定（多偏低） | 中（仅中断时刻） | 中 |

- 低估风险（#2）比高估风险（#3）更危险：低估让用户在快爆时仍以为有空，错过处理窗口。
- #1 与 `context-usage-realtime-improvement-design.md` 的实时性改进有交集（投影通道设计可一并解决），建议两份文档的改动协同实施。

## 设计取舍（已知失真，非 bug，不在本文修复范围）

- **图片 token 不入环但进 tooltip**（`ContextUsageRing.tsx`）：`pendingImageTokens`/`historyImageTokens` 只拼进 tooltip 文本，不传入 `computeContextUsageDisplay`。环形图 `usedRatio` 不含图片 → **环偏低**；tooltip 又列出图片 → 两处口径不一致。`estimateTokensFromImageAttachment`（`blocks*400`）本身粗估不准，是有意不入环。建议在 tooltip 明确标注"图片为额外估算，未计入环形"。
- **投影只抬 `input_tokens` 不动 cache 字段**：投影假设 tool_result 全量重发，忽略下轮可能的 cache 命中 → 轻微**高估**，可接受。
