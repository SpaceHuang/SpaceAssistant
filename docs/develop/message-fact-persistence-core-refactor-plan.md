# 消息事实落库归 Core 重构方案（第二场战役）

> 状态：方案（待评审）
> 基线：`main` 当前代码（建议在 Agent Loop 单路径重构、会话记录事件流之后实施）
>
> **一句话结论**：现在一条 assistant 消息的内容、思考、工具调用、分段，全是由渲染层订阅原始文本流后自己拼出来的，
> 再经 IPC `chatAppendMessage`/`chatPatchMessage` 写进 `messages` 表——组装事实、生成消息 id、落库都在渲染层，
> Core 只是个"发流/确认"的被动方，连"这条消息叫什么"（`messageId`）都不是 Core 说的算。
>
> 这场把它翻过来：**Core 是消息事实的唯一生产者**。Core 自己生成 `messageId`、组装完整消息、自己写库、自己推
> 增量流；渲染层**只订阅这份流做展示**，不发明 id、不回写库、不维护任何映射。

---

## 1. 这场要解决什么

### 1.1 病根：组装事实、生成 id、落库全在渲染层

一条 assistant 消息的生命周期，现在是这样走的：

1. Core 拿到模型返回，逐段发 `claude-chat-delta`（只有 `{ requestId, text }`）、
   `claude-chat-thinking-delta`（只有 `{ requestId, text }`）——**纯文本增量，不带结构、不带消息 id**。
2. 渲染层在 [ChatView.tsx:973](../../src/renderer/components/Chat/ChatView.tsx#L973) 订阅这些事件，用
   `createContentState`/`createThinkingState` 把碎片自己拼成一条消息。
3. 渲染层自己发明 `assistantId = crypto.randomUUID()`（[ChatView.tsx:888](../../src/renderer/components/Chat/ChatView.tsx#L888)），
   组装 `assistantMsg`（[:892](../../src/renderer/components/Chat/ChatView.tsx#L892)），在
   [:907](../../src/renderer/components/Chat/ChatView.tsx#L907) 调 `chatAppendMessage` 落库，再由
   `chatPatchMessage`（[:946](../../src/renderer/components/Chat/ChatView.tsx#L946)、[:1050](../../src/renderer/components/Chat/ChatView.tsx#L1050)、
   [:1085](../../src/renderer/components/Chat/ChatView.tsx#L1085)、[:1172](../../src/renderer/components/Chat/ChatView.tsx#L1172) 等）
   在流式过程中反复更新 `content`/`thinking`/`contentSegments`/`toolCalls`/`status`。
4. 而 Core 侧（[toolChatLoop.ts:785](../../electron/toolChatLoop.ts#L785)）**根本不构造 `Message`**——
   它只把 API 返回的内容块重新塞回 `messagesForApi` 供下一轮调用，`messages` 表对它而言是"渲染层的领地"。

结果：**"这条消息的事实"的权威在渲染层，连 `messageId` 的归属也在渲染层。** 这带来一连串连锁：

- Core 明明知道 usage（`stream.finalMessage().usage`，[claudeStreamHandlers.ts:504](../../electron/claudeStreamHandlers.ts#L504)），
  却没法把它挂到某条消息上——它不知道那条消息的 id（那是渲染层生成的）。这正是上一份事件流方案里
  `request_usage` 事件只能带 `requestId`、不带 `messageId` 的根本原因。
- 流式期间对 `messages` 表做几十上百次 `chatPatchMessage`（每次一个 IPC + 一次 UPDATE），写库频繁、且写库由
  渲染层异步驱动，Core 无法判断"何时算完整"。
- 渲染层自己 `createContentState` 拼消息，等于把 Core 已经做过的聚合再重演一遍，状态机分散在 UI 侧。
- `messageId` 由渲染层发明，Core 只是被动接受去落库——"这条消息是谁"的权威在渲染层，与"事实归 Core"相悖。

### 1.2 目标

- **`messageId` 归 Core**：Core 生成、随发送接口下发给渲染层；渲染层从不发明 id。
- **组装事实归 Core**：Core 在流式聚合完成后自己构造 `Message`（`content`/`thinking`/`toolCalls`/
  `contentSegments`/`status`），自己写 `messages` 表。
- **落库归 Core**：渲染层移除对 assistant / user 消息的 `chatAppendMessage`/`chatPatchMessage` 调用。
- **渲染层只消费**：渲染层订阅 Core 推的结构化消息流做展示，不发明 id、不拼事实、不回写库、不维护映射。
- 之前因为"消息归渲染层"而被迫做的映射（`requestId → messageId`）**不存在**——因为 `messageId` 由 Core 在发送
  时就给到渲染层了，两者天然对应。

> 这里有个硬约束：**对话可重建的前提是"事实完整"。** user 是对话链的起点，assistant 是模型输出，二者任一
> 缺失都无法重建一个会话。所以"user 归 Core、assistant 归 Core"必须一起做，没有"只收 assistant、user 留在
> 渲染层"这种管一半的做法。

### 1.3 本次不改的

- 不改 `runToolChatSession` / 工具循环 / 确认机制本身的决策逻辑——只改"消息事实由谁组装落库"。
- 不改上下文注入三段式（那是第三块，见另一份方案），但要确认它产出的 `system`/`tools` 是 Core 在组装请求时
  就确定的，渲染层不参与。
- 不新建独立的"事件流"重放语义——本场用的"增量 delta + 最终事实"与外部设计的 ASCII 事件溯源字面不同，
  但精神一致（delta 过程 + message 事实分离）。

---

## 2. 核心设计决定

| 范围 | 决定 |
| --- | --- |
| 消息事实来源 | 只有 Core。Core 在流式聚合完成后构造完整 `Message`，自己写 `messages` 表。 |
| `messageId` 归属 | **Core 生成**，在发送接口（`claudeChatCreateWithTools` 返回）时带 `{ requestId, messageId }` 下发给渲染层；渲染层从不发明 id。 |
| 渲染层消费的流 | 核心不变的仍是 **Core↔大模型同一份** `NormalizedDelta`——它不是新协议，是同一个流式业务模型两侧（Core↔LLM 与 Core↔渲染层）的镜像。 |
| 增量流粒度 | **保留现状（逐 token）**：Core 每接到一个文本/思考/工具增量就推一条增量事件，渲染层保持"打字机"展示。本机 IPC 每条极小，不因此改粗。 |
| 事件契约 | 发送接口返回 `{ requestId, messageId, usage? }`（`usage` 为最终口径）；流中推增量 delta；流结束推 `done{ requestId, messageId }`。**不新增完整消息推送事件。** |
| 为什么 `done` 带 `messageId` | `messageId` 只是几十字节的 UUID，不肥。带着它，渲染层收到 `done` 直接就定位到那条消息，不需要任何 requestId↔messageId 关联。现状渲染层是在闭包里显式持有 `assistantId`（`finishSessionRun(sessionId, requestId, assistantMessageId)`），并非建表查表——本方案延续这个"显式持有"、但把 id 来源改为 Core。 |
| usage 分发 | **三层分工**：① `claude-chat-usage` 事件负责**中间态实时更新**——`message_start`（输入权）与新的 `message_delta` 增量（thinking 期间输出 token 增长）；② 复用 `projected: true` 事件做工具后估算；③ **最终口径走发送接口返回的 `usage`**，不再经 `claude-chat-usage` 的 `final` 分支重复发。 |
| `done` 不带 `usage` | 现状 `done` 携带 `usage` 但渲染层从不消费（`onDone` 不读 `d.usage`，见 [ChatView.tsx:1161](../../src/renderer/components/Chat/ChatView.tsx#L1161)）——是死负载。改为只带 `{ requestId, messageId }`。 |
| 消息写入 | Core 在流结束时一次 `appendMessage`；若 `usage`/`toolCalls` 在聚合完成后才确定，则补一次 `updateMessageContent`。不再有流式期间几十上百次 patch。 |
| usage 归属 | Core 在写行时天然持有 usage（现场聚合），无需跨进程映射。用量留在会话级用量表（`session_usages`）作展示与可追溯数据源；是否在消息行加 usage 列留到后续按需评估，本场不做。 |
| 修复 thinking 期间环形图卡住 | 现状 `message_delta`（[toolChatLoop.ts:682](../../electron/toolChatLoop.ts#L682)）只更新本地 `usage` 变量、**不广播**，导致模型长时间思考时环形图在"输入权"上僵住。本次把 `message_delta` 的增量 usage 也推给渲染层，让环形图随输出 token 增长实时刷新。 |
| 渲染层状态 | 渲染层保留 `createContentState` 作**即时展示**用（订阅增量流），但**不再回写库**；`done` 带 `messageId`，渲染层直接按 id 收尾。 |
| user 消息 | 也归 Core。渲染层只发原始输入，Core 生成 user 消息、落库、推送展示。 |

---

## 3. 改之前的一些事实

- Core 现在发的流式事件（[claudeStreamHandlers.ts](../../electron/claudeStreamHandlers.ts) +
  [toolChatLoop.ts](../../electron/toolChatLoop.ts)）：
  - `claude-chat-delta` { requestId, text } —— 纯文本增量；
  - `claude-chat-thinking-delta` { requestId, text } —— 纯文本思考增量；
  - `claude-chat-usage` { requestId, sessionId, usage, projected? } —— 现状只在 `message_start`（输入权）、`final`（最终权）、
    工具后 `projected` 时发；`message_delta` 虽捕获 usage 增量但**不发送**；
  - `claude-chat-done` { requestId, usage? } —— 现状带 `usage` 但渲染层不消费（死负载）；
  - `claude-chat-error` { requestId, message }。
- 渲染层订阅入口（[ChatView.tsx:973](../../src/renderer/components/Chat/ChatView.tsx#L973)）用
  `window.api.claudeChatOnDelta` 等，收到的是**原始文本**，靠 `createContentState`/`createThinkingState` 拼接。
- assistant 消息 id 由渲染层发明（[ChatView.tsx:888](../../src/renderer/components/Chat/ChatView.tsx#L888)
  `assistantId = crypto.randomUUID()`），落库（[:892](../../src/renderer/components/Chat/ChatView.tsx#L892)、
  `chatAppendMessage` [:907](../../src/renderer/components/Chat/ChatView.tsx#L907)）→ 主进程
  `chat:append-message`/`chat:patch-message`（[appIpc.ts:772](../../electron/appIpc.ts#L772)、[:781](../../electron/appIpc.ts#L781)）→
  `appendMessage`/`updateMessageContent`（[operations.ts:347](../../electron/database/operations.ts#L347)、[:668](../../electron/database/operations.ts#L668)）。
- user 消息落库：渲染层 `prepareSendContext` → `chatAppendMessage(userMsg)`
  （[messageMutationGateway.ts:149](../../src/renderer/services/messageMutationGateway.ts#L149)）、
  [ChatView.tsx:544](../../src/renderer/components/Chat/ChatView.tsx#L544)。
- Core 侧不构造 `Message`（[toolChatLoop.ts:785](../../electron/toolChatLoop.ts#L785)）。
- `Message` 领域类型（[domainTypes.ts:646](../../src/shared/domainTypes.ts#L646)）含
  `content`/`toolUse`/`toolCalls`/`thinking`/`contentSegments`/`skillHints`/`attachments`/`imagesDeliveredToApi`/`status`/`schemaVersion`。

---

## 4. 工作包

> 每个 WP 拆成能独立验证的提交。每阶段收尾跑定向测试 + `npm run build:electron:incremental`；
> 全量 `npm test` 只在阶段收尾 / 提交前跑（遵循 AGENTS.md 的会话成本纪律）。

### WP0：消息事实归 Core —— 生成 id、组装、落库

**做什么**

1. 在 `runToolChatSession`（或流式聚合 `aggregateDeltas` 收尾处）构造完整 `Message`：`messageId` 由 Core 生成，
   `content`/`thinking`/`toolCalls`/`contentSegments`/`status` 从聚合结果填。
2. 发送入口返回 `{ requestId, messageId }`，让渲染层从一开始就知道这条消息的 id。
3. 流结束时一次 `appendMessage`；`usage` 在聚合完成时随行写入或补一次 `updateMessageContent`。

**怎么验收**

- `runToolChatSession` 结束后 `messages` 表里已有完整 assistant 消息，`messageId` 由 Core 生成。
- 一次模型调用只 `appendMessage` 一次 + 至多一次补 `usage` 的 `updateMessageContent`，不再有几十次 patch。

### WP1：统一流式事件为结构化 delta + done 带 messageId

**做什么**

1. 在 `src/shared/` 定义 `NormalizedDelta`（复用 Agent Loop WP1 的 `StreamClient` 产物），把 `claude-chat-delta`/
   `claude-chat-thinking-delta` 的负载从 `{ requestId, text }` 升级为结构化 delta（必要时向后兼容或改签名）。
2. 把 `claude-chat-done` 负载改为 `{ requestId, messageId }`（去掉无人消费的 `usage`）。
3. 给 `message_delta` 补上 usage 增量广播：把 [toolChatLoop.ts:682](../../electron/toolChatLoop.ts#L682) 捕获的
   `message_delta.usage` 也经 `claude-chat-usage` 推给渲染层（现状只更新本地 `usage`、不发送），
   让 thinking 期间环形图随输出 token 增长实时刷新。
4. `claude-chat-usage` 的 `final` 分支（[toolChatLoop.ts:754](../../electron/toolChatLoop.ts#L754) /
   [claudeStreamHandlers.ts:514](../../electron/claudeStreamHandlers.ts#L514)）不再重复发最终 usage——
   该最终口径由发送接口返回负载承担，避免与 invoke 返回值双份。

**怎么验收**

- 渲染层能拿到结构化 delta；`done` 带 `messageId`，渲染层直接按 id 收尾；`done` 不再带 `usage`。
- `claude-chat-done` 单测：负载为 `{ requestId, messageId }`。
- 大模型长时间 thinking 期间，`message_delta` 触发多次 `claude-chat-usage` 事件，环形图随输出 token 增长实时刷新。
- 最终 usage 只经发送接口返回给到渲染层一次；`claude-chat-usage` 不再在 `final` 时重复发。

### WP2：渲染层改为只消费

**做什么**

1. 渲染层保留订阅增量流（`claudeChatOnDelta`）做即时展示，但 `createContentState` 只维护**内存展示态**，
   不再回写库。
2. 移除渲染层对 assistant 消息的 `chatAppendMessage`/`chatPatchMessage` 调用（[ChatView.tsx:907](../../src/renderer/components/Chat/ChatView.tsx#L907)、
   [:946](../../src/renderer/components/Chat/ChatView.tsx#L946)、[:1050](../../src/renderer/components/Chat/ChatView.tsx#L1050)、
   [:1085](../../src/renderer/components/Chat/ChatView.tsx#L1085)、[:1172](../../src/renderer/components/Chat/ChatView.tsx#L1172) 等）。
3. 删除渲染层 `assistantId = crypto.randomUUID()`（[:888](../../src/renderer/components/Chat/ChatView.tsx#L888)），改用发送接口返回的 `messageId`。
4. 在 `done` 处理里用 Core 带来的 `messageId` 收尾，不再自己生成。

**怎么验收**

- 渲染层不再向 `messages` 表写消息（user / assistant 都归 Core）；渲染层只订阅做展示。
- UI 流式展示不变：增量流驱动即时显示，`done` 到达后按 `messageId` 收尾。

### WP3：user 消息写库也归 Core

**做什么**

1. 把 user 消息落库从渲染层 `prepareSendContext`（[messageMutationGateway.ts:149](../../src/renderer/services/messageMutationGateway.ts#L149)）
   的 `chatAppendMessage(userMsg)` 移到 Core：Core 在收到发送请求时落库 user 消息 + 广播。
2. 渲染层不再 `chatAppendMessage(userMsg)`（[ChatView.tsx:544](../../src/renderer/components/Chat/ChatView.tsx#L544)），
   只负责把用户原始输入发给 Core（经 `claudeChatCreateWithTools`），由 Core 生成 user 消息、写库、再推送展示。

**怎么验收**

- user / assistant 消息的落库入口一致（都在 Core），渲染层只订阅做展示。
- 一次对话从 user 到 assistant 的完整事实链都能在 `messages` 表中还原，无需渲染层参与。

### WP4：收敛完结——确认无映射、清理多余 IPC

**做什么**

1. **确认无 requestId↔messageId 映射**：现状渲染层是在闭包里显式持有 `assistantId`（`finishSessionRun(sessionId, requestId, assistantMessageId)`），
   并未建表查表；messageId 归 Core 后，渲染层改为持有 Core 下发的 id，仍显式传递，无需新增映射。
2. 清理 `chat:patch-message` 中用于流式更新 assistant 消息的路径（保留用户编辑/删除所需的 patch）。
3. 迁移受影响测试（直测 `chatStreamService`、`ChatView` 里 patch assistant 消息的用例）。

**怎么验收**

- `rg` 全仓无残留的"渲染层补写 assistant 消息"调用；`registerSessionRun`/`finishSessionRun` 的 `assistantMessageId`
  参数来源改为 Core 下发值；typecheck/定向测试通过。

---

## 5. 测试策略

- 共享层（`NormalizedDelta`/聚合）归 `src/shared` 纯函数测试。
- 主进程（Core 生成 id / 组装 / 落库消息）归 `electron` 项目，定向 `npm exec vitest run ...`。
- 渲染层「只消费、不回写」验证：`ChatView` 测试断言不再调用 `chatAppendMessage`/`chatPatchMessage`（assistant 消息），
  且使用发送接口返回的 `messageId`。
- 全量 `npm test` 仅在 WP 阶段收尾与提交前跑。

---

## 6. 风险与残留

| 风险 / 残留 | 影响 | 怎么缓解 |
| --- | --- | --- |
| 渲染层展示态与库中事实短暂不一致 | 流式中途 UI 与最终落库有差 | 明确"展示走增量、落库走最终态"；渲染层无需用 Core 的完整 Message 校准，本地 `createContentState` 即事实 |
| 移除渲染层回写后，用户手动编辑/删除 assistant 消息受影响 | 编辑/删除可能仍走 patch | 保留 `chat:patch-message` 的编辑/删除路径，仅移除"流式自动 patch" |
| Core 落库时机晚于展示 | 崩溃时可能"展示了但没落库" | 加大 `appendMessage` 的原子性；配合事件流补闭（见会话记录方案） |
| 渲染层仍保留 `createContentState` | 双份状态（内存 + 库） | 明确其仅作即时展示，属"投影"而非事实；收敛到非持久 |
| 增量流升级为结构化 delta 的兼容性 | 渲染层既有调用方可能失效 | 向后兼容或分段改签名，配套迁移测试 |

---

## 7. 待确认项

1. **`message_delta` 增量广播的频率**：thinking 期间 token 增长快，`message_delta` 可能高频触发。是否做节流/合并，
   避免环形图刷新过密。建议按现 `usage` 事件频率抛出即可（本机 IPC，代价极小），如刷屏再考虑节流。

---

> 参考：外部设计 `tech-design-v3.md` 第 7.4「流式聚合与 chunk 落盘」、第 11「壳（Host）」、第 3.1「ID」。
> 核心立场是**组装事实 + 落盘 + 生成 id 都归 Loop（Core），视图只是订阅事实的普通消费者**；且渲染层消费的是
> Core↔LLM 同一份 `NormalizedDelta` 流，两者是同一个流式业务模型的两个侧面。
