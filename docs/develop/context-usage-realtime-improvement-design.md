# 上下文占用实时性改进方案

## 背景

当前上下文占用环形图的 usage 更新存在两类实时性缺口：

1. **工具 loop 中间轮次空窗**：`message_start` 事件携带的 `input_tokens` / cache 字段未被采集。中间轮的 `message_delta.usage` 主要只有 `output_tokens`，缺 `input_tokens` 时 `normalizeAnthropicMessageUsage` 返回 `undefined` 被丢弃，导致环形图在 `finalMessage()` 到达前不更新。
2. **两条主聊天路径更新机制分叉**：工具路径走全局 `claude-chat-usage` 桥（`initContextUsageStreamBridge`），纯聊天路径靠 `ChatView.onDone` 手动 `applyContextUsageUpdate`。单轮纯聊天本身无中间 usage 需求，但分叉造成一致性差，且补齐第 1 点后纯聊天也能在流启动时反映 input 占用。

本方案将第 1、2 点合并处理，目标：**消除中间轮空窗 + 统一两条路径的 usage 推送机制**。

> 第 3 点（`countTokens` API）经评估代价（网络往返、兼容网关不支持 beta 端点、收益仅覆盖很快被覆盖的临时投影）大于收益，维持现状的 `length/3.5` 粗估，不在本方案范围。

## 现状梳理

### Claude SDK 给出 usage 的位置

Anthropic Messages API 的 `usage` 出现在：

| 位置 | 含 usage 字段 | 说明 |
|---|---|---|
| `message_start` 事件 `message.usage` | `input_tokens` + cache 字段 | 流开始即有，**当前未采集** |
| `message_delta` 事件 `usage` | `output_tokens` + cache 字段 | 累计输出 |
| `stream.finalMessage()` `res.usage` | 全部字段 | 完整，当前已采集 |

### 当前采集点

**工具 loop 路径**（`electron/toolChatLoop.ts`）：
- `:534-538` 监听 `message_delta` 取 partial usage（常因缺 `input_tokens` 丢弃）
- `:596-601` `finalMessage()` 取完整 usage，发 `claude-chat-usage`
- `:1313-1316` tool_result 拼入后 `projectUsageAfterToolResults` 投影并发 `claude-chat-usage`
- `:300-302` 失败回退 `lastValidUsage` 发 `claude-chat-usage`
- 渲染端 `App.tsx:155` 全局 `claudeChatOnUsage` → `applyContextUsageUpdate`

**纯聊天路径**（`electron/claudeStreamHandlers.ts` `runSendStream`）：
- `:455` `finalMessage()` 取 usage
- `:465` 随 `claude-chat-done` 携带 `{ usage: usage ?? null }`
- 渲染端 `ChatView.tsx:1023-1025` `onDone` 手动 `applyContextUsageUpdate`

## 改进方案

### 改动 1：采集 `message_start` usage

在两条路径的流事件循环中，新增对 `message_start` 的处理，提取 `message.usage` 并归一化。

#### 1.1 工具 loop 路径（`electron/toolChatLoop.ts`）

在 `for await (const evt of stream)` 循环内、`message_delta` 分支之前，新增：

```ts
if (evt?.type === 'message_start') {
  const startUsage = (evt as { message?: { usage?: unknown } }).message?.usage
  if (startUsage && typeof startUsage === 'object') {
    const partial = normalizeAnthropicMessageUsage({ usage: startUsage })
    if (partial) {
      // message_start 提供 input_tokens + cache；缺 output_tokens，沿用已有值
      usage = { ...partial, output_tokens: usage?.output_tokens }
      lastValidUsage = usage
      safeWebContentsSend(sender, 'claude-chat-usage', { requestId, sessionId, usage })
    }
  }
}
```

要点：
- `message_start.usage` 通常不含 `output_tokens`，需保留上一轮/本轮已有的 `output_tokens`，避免覆盖为 `undefined` 导致 `computeEstimatedOccupancy` 丢掉输出部分。
- 首轮请求 `lastValidUsage` 为空时，这一步让环形图在工具执行前就能反映 input 占用，消除"发送后到首次 finalMessage 之间"的空窗。
- 多轮 loop 中，每一轮 `message_start` 都会刷新 input 占用为该轮真实值，比 tool_result 粗估投影更准（投影值在下一轮 `message_start` 到达时被真实值覆盖，符合预期）。

#### 1.2 纯聊天路径（`electron/claudeStreamHandlers.ts` `runSendStream`）

在 `for await (const evt of stream)` 循环内新增 `message_start` 分支，发 `claude-chat-usage`：

```ts
if (evt?.type === 'message_start') {
  const startUsage = (evt as { message?: { usage?: unknown } }).message?.usage
  if (startUsage && typeof startUsage === 'object') {
    const partial = normalizeAnthropicMessageUsage({ usage: startUsage })
    if (partial) {
      safeWebContentsSend(sender, 'claude-chat-usage', {
        requestId,
        sessionId: payload?.sessionId ?? '',
        usage: partial
      })
    }
  }
}
```

> `runSendStream` 当前签名未透传 `sessionId`，需确认其可用性。若该路径无 `sessionId`，则保留 done 兜底，`message_start` 分支按可获取 sessionId 的前提下启用；见改动 2 的统一处理。

### 改动 2：统一两条路径的 usage 推送机制

目标：纯聊天路径也走全局 `claude-chat-usage` 桥，`ChatView.onDone` 不再手动 `applyContextUsageUpdate`，两条路径一致。

#### 2.1 主进程

- `runSendStream` 在 `message_start`（改动 1.2）与 `finalMessage()`（现有 `:455`）两处均发 `claude-chat-usage`，`claude-chat-done` 可保留 usage 字段用于日志/兜底，但渲染端不再依赖它驱动环形图。
- 需保证 `runSendStream` 能拿到 `sessionId`。当前 `runSendStream` 入参 `args` 无 `sessionId`，调用方 `claude-chat-send-stream` handler（`:343` 上方）持有 `payload.sessionId`，需将其传入 `args`。

#### 2.2 渲染端

- `ChatView.tsx:1022-1025` `onDone` 中删除 `if (data?.usage) applyContextUsageUpdate(...)` 分支，改由全局桥接收。
- `App.tsx:155` 的 `initContextUsageStreamBridge` 已全局订阅 `claudeChatOnUsage`，无需改动，自动覆盖纯聊天路径。
- `chatStreamService.ts` 的 `onDone` 仍透传 `usage`（保持类型兼容），但渲染端不再消费它驱动占用环；保留以避免破坏现有接口契约与测试。
- `claude-chat-done` 仍带 `usage` 字段，作为最终态兜底（若 `message_start`/`finalMessage` 的 `claude-chat-usage` 因异常未送达，done 兜底）。可选择在桥内对 done 也做一次 apply，但为避免重复，建议桥只认 `claude-chat-usage`，done 不重复 apply。

#### 2.3 取消/错误路径

- 工具 loop 已有 `failToolLoopWithLastUsage` 发 `claude-chat-usage`（`:300`），保持。
- 纯聊天路径 `catch`（`:466`）不发 usage，保持现状（出错时不更新占用环合理）。

## 影响范围

| 文件 | 改动 |
|---|---|
| `electron/toolChatLoop.ts` | 新增 `message_start` usage 采集分支 |
| `electron/claudeStreamHandlers.ts` | `runSendStream` 新增 `message_start` 分支发 `claude-chat-usage`；入参补 `sessionId`；调用方透传 |
| `src/renderer/components/Chat/ChatView.tsx` | `onDone` 移除手动 `applyContextUsageUpdate` |
| `src/shared/contextUsageEstimate.ts` | 无改动（投影逻辑保留，作为 `message_start` 到达前的临时值） |
| `src/renderer/services/contextUsageStreamService.ts` | 无改动（已全局订阅） |
| `electron/preload.ts` / `src/shared/api.ts` | 无改动（`claude-chat-usage` 通道已存在） |

## 风险与权衡

- **`message_start.usage` 字段缺失兼容**：少数兼容网关可能不在 `message_start` 携带 usage。`normalizeAnthropicMessageUsage` 返回 `undefined` 时静默跳过，回退到现有 `finalMessage()` 兜底，行为不劣于现状。
- **重复推送**：`message_start` → `message_delta`（partial）→ `finalMessage` 三处都可能发 `claude-chat-usage`，渲染端 `setLastUsage` 为覆盖语义，最后一次生效，无累积错误。需确认 `applyContextUsageUpdate` 的 `usageSet` 落库为整体覆盖而非累加（当前 `usage:set` 应为覆盖写入，需复核 `database.ts`）。
- **output_tokens 覆盖**：`message_start` 无 `output_tokens`，改动 1.1 已显式保留旧值；纯聊天单轮首轮无旧值，`output_tokens` 为 `undefined`，`computeEstimatedOccupancy` 取 `?? 0`，环形图在流期间仅反映 input，回复完成后 `finalMessage` 补齐 output——可接受。
- **纯聊天 sessionId 透传**：需改 `runSendStream` 签名与调用方，属小范围重构，注意 `runSendStream` 现有调用点（仅 `claude-chat-send-stream` handler）。

## 验证

- `electron/toolChatLoop.usage.test.ts`：新增用例——mock 流首发 `message_start`（含 `input_tokens` + cache），断言发出 `claude-chat-usage` 且 `lastValidUsage` 含 input。
- `electron/claudeStreamHandlers` 相关测试：断言纯聊天路径 `message_start` 触发 `claude-chat-usage`，`sessionId` 正确。
- `src/renderer/services/chatStreamService.test.ts`：维持 `onDone` 透传 usage 的契约。
- 手动验证：工具 loop 多轮场景下，环形图在每轮 `message_start` 即更新；纯聊天发送后 input 占用即时上涨，回复完成补齐 output。
