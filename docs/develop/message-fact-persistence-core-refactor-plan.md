# 消息事实落库归 Core 重构方案（第二场战役）

> 状态：v2，已吸收阻断性评审意见，待复审后实施
> 基线：`main` 当前代码；应在 Agent Loop 单路径重构后实施
> 评审输入：[message-fact-persistence-core-refactor-plan-review.md](../review/message-fact-persistence-core-refactor-plan-review.md)
>
> **结论**：新增独立于模型和渠道适配器的 `TurnCoordinator`。它在模型调用前原子创建/解析 user、创建
> assistant `streaming` 占位，再用同一领域聚合器消费普通流、工具流和远程 IM 的规范化事件，checkpoint 并统一
> 完成 success/error/cancel/recovery。渲染层和远程渠道只提交意图、消费权威投影，不再生成消息 id 或补写事实。

## 1. 目标、不变量与边界

当前所有权分裂：桌面生成 user/assistant id 并拼 `contentSegments`、`thinking`、`toolCalls`、`skillHints`；
`runToolChatSession` 只产生 API block/工具事件；`ToolCallRecord[]` 在 renderer 私有状态机中；微信、飞书又各自创建
user/streaming assistant；无工具桌面路径还绕过工具 loop。故不能简单在 `runToolChatSession` 结束时 append。

完成后必须满足：

1. 每个 turn 恰有一个权威 `userMessageId` 和 `assistantMessageId`；reuse-user 不复制 user。
2. assistant 在任何模型 delta 前已以 `streaming` 状态落库。
3. `content/thinking/contentSegments/toolCalls/skillHints/status` 只由 Core 聚合器产生。
4. 桌面工具/无工具、微信、飞书共享同一个 owner；模型执行器不直接写消息。
5. success/error/cancel/timeout/recovery 共用终止状态机；终态幂等且不被迟到事件改写。
6. UI 可即时展示，但 terminal 必须携带权威 `Message` 和版本，原子校准投影。
7. 每条消息仅 append 一次；checkpoint 只能 update 既有 assistant 行。

不改工具授权、确认、远程权限和工作目录决策；不实现通用事件溯源；不新增 message usage 字段；保留用户主动编辑、
删除所需的通用 patch IPC。

前置：优先完成 Agent Loop 单路径重构。若尚未完成，本方案须同时提供普通 stream 和 tool loop 两个
`ModelEventSource` 适配器，不能遗漏无工具路径。

## 2. 目标架构与所有权

```text
Desktop / WeChat / Feishu adapter
              │ TurnIntent
              ▼
        TurnCoordinator ───── checkpoint/finalize ───► messages table
              │
              ▼
       ModelEventSource
   (unified loop / temporary adapters)
              │ normalized events
              ▼
   AssistantFactAggregator
       ├──► DB checkpoint
       ├──► desktop projection
       └──► remote progress/reply
```

| 组件 | 负责 | 不负责 |
| --- | --- | --- |
| Coordinator | intent 校验、id/顺序、占位、串行事件、checkpoint、finalize、恢复 | 供应商 SSE、UI、IM 文案 |
| Aggregator | 纯规约完整 `Message`、版本和状态机 | IO、随机数、授权决策 |
| ModelEventSource | 把普通流/工具 loop 转为规范化事件 | id、append/patch 消息 |
| 渠道适配器 | 提交输入、呈现投影/终态 | 构造 ToolCallRecord、完成消息 |
| renderer | 订阅投影、发送确认/取消/编辑命令 | 发明 id、拼权威事实、流式写库 |

`runToolChatSession` 只是 ModelEventSource。微信/飞书进度钩子也消费同一投影，不能维护平行消息事实。

## 3. 启动契约与严格时序

### 3.1 TurnIntent

```ts
type TurnIntent =
  | { mode: 'create-user'; requestId: string; sessionId: string;
      input: { text: string; attachments?: ChatImageAttachment[] }; excludeMessageIds?: string[]; config: TurnConfig }
  | { mode: 'reuse-user'; requestId: string; sessionId: string;
      userMessageId: string; excludeMessageIds: string[]; config: TurnConfig }
```

`TurnConfig` 含 model、llmServiceId、options、projectMemoryEnabled、locale 等现有请求配置。Core 从数据库和
`excludeMessageIds` 构建上下文；新契约不再接收 renderer 的 `sourceMessages`。

create-user 在 session 级串行事务中 append `sent` user，再 append 空 `streaming` assistant；reuse-user 要求目标属于同
session、role=user、status=sent 且未被排除，只 append assistant。两者返回数据库真实 sequence。

附件保留 staging 引用，由主进程水合；只有供应商请求确已接受图片 block 后才置 `imagesDeliveredToApi=true`。凭据或
上下文构建失败发生在 prepare 后时，user 保留、assistant 统一 finalize 为 failed；prepare 前的表单失败不产生消息。

### 3.2 桌面采用 prepare/execute 两阶段

当前长时 `invoke` 在所有 delta 后才 resolve，不可能提供首包 id。拆成：

```ts
chatPrepareTurn(intent): Promise<TurnStarted>
chatExecuteTurn({ turnId, startToken }): Promise<TurnTerminal>
```

`TurnStarted` 含 `{turnId, requestId, sessionId, userMessage, assistantMessage, version, startToken}`。`startToken` 一次性、短期
有效且绑定 turn；重复 execute 返回同一运行/终态，不启动第二次模型调用。

```text
Renderer               Core/DB                    Model source
  |--建立全部订阅-------->|                            |
  |--prepare------------>|--原子创建 user?/assistant-->| DB
  |<--TurnStarted--------|                            |
  |--按快照展示-----------|                            |
  |--execute------------>|--此时才启动---------------->|
  |<--progress(v+1)------|<--首个规范化事件-------------|
  |       ...            |--checkpoint--------------->| DB
  |<--terminal(vN,msg)---|--finalize------------------>| DB
  |<--execute resolve----|                            |
```

prepare resolve 前绝不启动模型，因此同步首 delta 也不会早于 id/占位。远程入口在主进程直接依次调用相同方法。
`requestId` 在 session 内幂等；相同 intent 返回原 turn，不同 intent 拒绝。prepare 后未 execute 的孤儿由短超时 finalizer
和启动恢复置 failed。startToken 不记录到日志或持久 UI 状态。

## 4. 运行协议与领域聚合

每个事件信封含 `{turnId, requestId, sessionId, assistantMessageId, version, occurredAt, event}`；version 单调递增。
renderer 不维护 requestId→messageId 映射，丢弃旧版本。progress 建议携带聚合后的 `message`；高频文本可另带 delta
优化，但快照/version 才是权威。版本跳跃或 terminal 时用快照校准。

```ts
type TurnTerminal = {
  turnId: string; requestId: string; assistantMessageId: string; version: number
  outcome: 'completed' | 'failed' | 'cancelled' | 'timed-out' | 'recovered'
  message: Message; usage?: SessionUsage; error?: { code: string; message: string }
}
```

现有 `MessageStatus` 无 cancelled/timed-out，数据库暂存 failed，terminal outcome 保留精确原因。最终 usage 只随 terminal/
execute 返回一次；实时 usage 仍可广播，但必须关联 turn/message id，保留 projected 语义。

### 4.1 聚合字段表

| 输入 | 字段 | 规则 |
| --- | --- | --- |
| text delta/segment-end | content、contentSegments | 工具/思考边界关闭当前段；多轮按发生顺序追加 |
| thinking delta/segment-end | thinking.content/segments | 跨工具轮保留分段；终止关闭开放段 |
| skill-hint | skillHints | Core 生成 id/shownAt；路由、恢复提示均走此事件 |
| tool-use | toolCalls | 首次出现顺序创建 calling，记录规范名/input/MCP/startedAt |
| confirm-requested | 对应 tool | confirming，写 risk、tiers、diff、安全/页面/危险信息 |
| tool-confirmed | 对应 tool | confirmedAt，转 executing |
| tool-progress | 对应 tool | 按 seq 去重，维护有界文本/raw 输出，转 executing |
| tool-result | 对应 tool | success→completed；拒绝/确认超时/取消→rejected；其余→failed；记录 result/时间/duration |
| dependency-recovery/file-auto-approved | tool、diff、hint | 统一并入 reducer，不由 renderer 回调补写 |
| source completed/failed/cancelled/timeout | 全消息 | 关闭开放段；降级活动工具；完成或 failed |

聚合器放 `src/shared/`，是 `(state,event) => state` 的纯 reducer；时间、id、截断参数由 Coordinator 注入。未知 tool id、
倒退 seq、重复/终态后事件只记诊断并忽略。API content blocks 与领域 Message 分别从同一规范化事件派生，禁止强转。

状态只允许 `prepared → executing ↔ waiting-confirm → terminal`。取消先 abort 模型/工具/确认等待，再消费 cancelled 并
finalize。窗口销毁只停止投影投递，不能天然改变 Core turn。终态 DB 更新须带期望状态/version，迟到事件不得复活。

## 5. 持久化、失败与恢复

1. prepare：在事务/串行临界区完成 create/reuse 校验和占位；若 DB 封装无事务，先补事务 API。
2. checkpoint：只 update assistant；采用“最多每 100–250ms 一次 + 语义边界强制 flush”。边界包括分段关闭、确认请求/
   结果、工具结果、终止。阈值以测试和写入测量确定，禁止逐 token 写库。
3. finalize：强制 flush 全字段和 status，再写 usage/活动；DB 完成后才广播 terminal。所有 outcome 共用一个实现。

| 场景 | 权威结果 |
| --- | --- |
| 零 delta 失败 | user 保留，空 assistant failed |
| 部分文本/thinking 失败或取消 | 保留并关闭部分段，assistant failed，outcome 精确区分 |
| 确认中取消/退出 | tool rejected/interrupted，assistant failed，清理 registry |
| 工具结果后失败 | 已完成工具与部分正文保留，assistant failed |
| 窗口销毁 | Core 继续或按既有显式取消策略结束；重开从 DB 读投影 |
| 主进程崩溃 | 启动恢复关闭开放段、降级活动工具、assistant failed |

增强 `streamingCleanup` 并复用 recovery reducer/finalizer：关闭 content/thinking 段，清除不可持久 raw progress，给活动
工具补 completedAt/interrupted；重复清理不得再次改变行。

## 6. 全入口迁移矩阵

| 入口 | 迁移后 | 删除的旧所有权 |
| --- | --- | --- |
| 桌面工具 | prepare→execute→Coordinator→统一 source | ChatView ids、records、hints、流式 patch |
| 桌面无工具 | 单路径前置完成后同上；否则临时普通 source | `claudeChatSendStream` 的独立聚合/落库 |
| reuse/重试 | Core 校验 DB user/exclude 并构建上下文 | sourceMessages/currentUserMessageId 作为真相 |
| 微信 | router 提交 intent，IM adapter 消费投影/terminal | router 两次 append、agent-done 补写、外层 assistant id |
| 飞书 | 同微信 | 同微信 |

远程 start/done 若暂留兼容，id 必须来自 TurnStarted/Terminal，且只能更新内存投影。turn 永久绑定 origin session；仅出站
回复和 activity touch 跟随 outbound session。迁移清单至少覆盖 ChatView、messageMutationGateway、chatStreamService、
chatToolSessionService、claudeStreamHandlers、toolChatLoop、imRemoteAgent、微信/飞书 router 和 remote stream service。

## 7. 工作包（每个提交均可运行）

### WP0：契约、纯聚合器、基线（不切所有权）

- 定义 intent/started/events/projection/terminal；实现完整 reducer。
- 用当前普通流、工具 controller 行为建立 golden fixtures；固化全仓 append/patch 调用点计数。
- 验收：多轮工具、确认、进度、recovery、skill hint、重复/迟到事件测试通过，生产行为不变。

### WP1：Coordinator prepare 与持久化状态机

- 实现 session 串行化、requestId 幂等、create/reuse、事务占位、条件版本更新、recovery finalizer。
- 暂不替换旧发送入口，独立测试 prepare/checkpoint/finalize。
- 验收：create 要么两行全有要么全无；reuse 不复制；重复请求/execute 不新增；重启可恢复残留。

### WP2：统一模型事件源，完整事实迁入 Core

- 将统一 loop（或两个过渡 adapter）改为只发规范化事件。
- 迁移 renderer 的 tool use/confirm/progress/result、skill hint、content/thinking 规约。
- Coordinator 驱动 checkpoint/finalize/usage/投影。
- 验收：source 不访问消息表；快照字段完整；同步首 delta 不丢；每种失败有同 id 终态。

### WP3：桌面切换 prepare/execute，只消费投影

- preload/API 增加两阶段 IPC；prepare 前订阅，started 后展示，再 execute。
- 删除新发送路径的 user/assistant id、sourceMessages、事实 reducer 和流式 DB patch。
- overlay 消费 Core sequence；terminal 按 version 原子替换。保留主动编辑/删除。
- 验收：工具/无工具、create/reuse、附件、exclude、发送前失败、取消通过；renderer 新发送不写消息。

### WP4：迁移微信、飞书和其他调用方

- router 提交 intent，删除 user/assistant append 和有/无窗口两套 final patch。
- imRemoteAgent 仅负责配置/远程呈现；start/done id 来自 Coordinator。
- 验收：每入口每 turn 一 user/一 assistant；有无 WebContents、确认、取消、session switch、失败/恢复均不重复。

### WP5：删除旧协议与所有权

- 删除旧普通入口（若已统一）、长时 create 契约、renderer ToolCallRecord controller、远程补写服务。
- 收紧 append/patch IPC，保留导入/编辑/删除明确用途。
- 验收：新 turn id 只在 Coordinator 生成；所有入口共用 reducer/finalizer；全量测试/typecheck/i18n/build 通过。

## 8. 测试与最终门禁

- 时序：订阅→prepare resolve→execute→首 delta→terminal→execute resolve；fake source 同步发首 delta。
- 幂等：重复 prepare/execute/event/finalize、迟到 tool result 不新增行、不覆写终态。
- 聚合：文本/thinking 多段、多轮工具全状态全字段、skill/recovery hint、progress seq。
- 故障：零 delta、部分输出、thinking 取消、确认中退出、工具后失败、prepared 未执行、启动恢复。
- 跨入口参数化 desktop-tools/no-tools/wechat/feishu：id 在 started/progress/terminal/DB/远程事件一致；create-user
  append 恰两次、reuse 恰一次，之后只 update；有无 WebContents 结果一致。
- terminal 测试故意漏一个 progress，验证最终 Message 能校准 renderer。

每阶段先跑定向 Vitest，再跑相关 `typecheck:shared`、`typecheck:renderer`、`i18n:check`、
`build:electron:incremental`；阶段收尾和提交前跑 `npm test`。最终以明确白名单审查 randomUUID、append/chatAppend、
update/chatPatch 调用点，不能粗暴要求字符串为零（导入、编辑、删除仍合法）。

## 9. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| prepare 后未 execute | startToken、幂等 execute、短超时、启动恢复 |
| checkpoint 过密/过疏 | 节流 + 阶段边界 flush，以写入计数和故障注入定阈值 |
| 完整 progress 快照偏大 | 高频文本允许 delta 优化；边界/terminal 带快照；先测量后优化 |
| 迁移期双写 | 按入口切换且单入口只能有一个 owner；DB 幂等/条件更新兜底 |
| API history 与 Message 漂移 | 消费同一规范化事件但分别建模，以多轮工具 golden fixture 对照 |
| origin/outbound 混淆 | turn 固定 origin；仅回复/touch 使用 outbound，专门回归 |
| status 无取消/超时 | DB 暂记 failed，terminal outcome/error code 精确保留，schema 后续独立演进 |

## 10. 复审通过标准

复审须能明确回答：首 delta 前 id 如何可靠可见；完整工具/提示事实由谁规约；create/reuse/exclude/附件语义如何保留；
四类入口怎样进入同一 owner；各失败/恢复留下什么；哪些测试证明每 turn 只有一对 id、一次创建、一个不可逆权威终态。
任一项未由实现计划和测试闭合，不得删除 renderer/remote 旧写路径。
