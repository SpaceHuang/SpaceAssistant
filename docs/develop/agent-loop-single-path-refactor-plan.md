# Agent Loop 单路径重构计划

> 状态：已定稿，待实施
> 基线：`main` 当前代码
>
> **一句话结论**：现在聊天有两条路径——「带工具」和「不带工具」。本次把它们合并成一条：所有聊天都走
> 带工具这条路径；没有工具时，它能自动退化成"只聊天"。同时把「这次聊天能用哪些工具」的判定收敛到
> 主进程（后端），界面只读；并顺手修掉几个和它绑在一起的小坑。

---

## 1. 这次要解决什么

### 1.1 现在的两个问题

**问题一：聊天有两条路径，底层逻辑还重复。**

- 界面按「工具开没开」选路径：开了走 `claude-chat-create-with-tools`（完整 Agent 循环，会调工具）；
  没开走 `claude-chat-send-stream`（只聊天，不调工具）。
- 两条路径在「接收模型流式返回、拼装内容块」这一块几乎一样，但各写了一份
（[toolChatLoop.ts](../../electron/toolChatLoop.ts) 与 [runSendStream](../../electron/claudeStreamHandlers.ts#L382)）。
  将来改协议、改思考、改用量统计，得改两处、只测一处，容易漏。

**问题二：「能不能用什么工具」界面和主进程各管一半，还互相打架。**

- 真正决定「这次聊天调哪些工具」的是主进程，在请求开始时算一次
  （[toolChatLoop.ts:525](../../electron/toolChatLoop.ts#L525)，内侧 `filterBuiltinToolsForApi` + 外部 MCP 工具）。
- 界面也有一套「工具开没开」的判断（`useToolsApi`、`toolsEnabled`），而且它判断的跟主进程实际发的**未必一致**：
  界面那个清单（`exposureTools`）只算内置工具，主进程实际还会带外部 MCP 工具。
- 界面还拿这个「工具开没开」去管**两件不相干的事**：能不能发图、要不要显示确认卡。实际上发图该看"模型支不支持图片"，
  确认卡该看"现在有没有一条确认在等"——都不该受「工具开没开」影响。

### 1.2 目标

- 把两条聊天路径合并成一条，删除重复的流式处理逻辑。
- 工具管理收敛为主进程统一决定，界面只读，不再反向决定工具。
- 修掉几个相关的坑：发图不绑「工具开没开」、确认卡不因「工具看起来关了」而隐藏、关掉一个工具后正在进行
  的请求不该还卡着。

### 1.3 本次不做什么（留到以后）

- 会话记录事件流（审计 / 回放 / 崩溃补闭）。
- 上下文注入三段式 + 上下文占用估算。
- 渲染进程与主进程之间「工具执行状态机」的更大范围解耦。
- 把聊天通道改名为更通用的名字（本次沿用旧名 `claude-chat-create-with-tools`，改名记为后续时机）。

---

## 2. 核心设计决定

| 范围 | 决定 |
| --- | --- |
| 聊天路径 | 只保留 `claude-chat-create-with-tools` 作为唯一入口，删除 `claude-chat-send-stream`。 |
| 工具来源 | **主进程唯一决定**。一个函数 `computeEffectiveTools()` 根据「全局配置 + 链路 + 外部 MCP 工具」算出可用清单；渲染进程发送路径**不携带任何工具字段**。 |
| 无工具聊天 | 算出的清单为空时，同一条路径自动退化成「只聊天」。工具清单为空是主进程算出来的**结果**（配置关 / 链路全拒 / 只读 / 无外部工具），不是界面传的信号。 |
| 工具清单的"镜子" | 主进程把「当前能用哪些内置工具」下发给界面（只读）。界面拿它**只为了画界面**（决定要不要显示工具相关按钮 / 确认模式），绝不反向决定工具。 |
| 惰性接线 | 下面三件事只在「确实要用」时才做：读外部 MCP 工具清单、解析工作目录、创建外部工具连接管理器。 |
| 协议与流式聚合 | 抽取一个统一的「流接口」+ 一个纯函数，把两块重复的流式解析合并成一份。 |
| 发图 | 不再绑「工具开没开」，改为看「模型支不支持图片（多模态）」。 |
| 确认卡 | 只由「当前有没有一条正在等确认的工具」决定，不再受「工具看起来关了」影响。 |
| 关掉工具 | 关掉某工具时：立即拒绝它在等的确认，并在「真正执行前」拦截（即便点了同意也不执行）。 |
| 通道名 | 沿用 `claude-chat-create-with-tools`，本次不改名。 |

---

## 3. 改之前的一些事实

- `RunToolChatSessionArgs`（[toolChatLoop.ts:340](../../electron/toolChatLoop.ts#L340)）**没有** `tools` 入参；工具清单由
  `runToolChatSession`（[toolChatLoop.ts:404](../../electron/toolChatLoop.ts#L404)）在请求开始时自己算（`:525` + `:537`）。
- 界面上传的 `tools` 字段，在主进程 handler（[claudeStreamHandlers.ts:303](../../electron/claudeStreamHandlers.ts#L303)）里**校验后直接丢弃**，从没传给 `runToolChatSession`。
- 工具清单在请求**开始时就定死**（快照），中途关工具不影响正在跑的请求。
- 界面的「工具开没开」由 `cfg.tools.enabled` + 主进程下发的 `exposureTools` 得出；`exposureTools` 只含内置工具。
- **图片字节只有带工具那条路径会真正塞进请求**（[chatMessageBuild.ts](../../electron/chatMessageBuild.ts) 的 `buildToolChatMessagesFromSource`，只在 create-with-tools 里调用）；另一条路不发图。
- 一条工具确认自带 **5 分钟超时**（[toolConfirmRegistry.ts](../../electron/toolConfirmRegistry.ts#L13)），所以不会永久卡死，但会干等最久 5 分钟。
- 远端聊天（微信 / 飞书）已经走工具循环，不受本次影响。
- 「取消聊天」和「导出校验函数」在两路间共用，删除时不能误删。

---

## 4. 工作包

> 每个 WP 拆成能独立验证的提交。每阶段收尾跑定向测试 + `npm run build:electron:incremental`；
> 全量 `npm test` 只在阶段收尾 / 提交前跑（遵循 AGENTS.md 的会话成本纪律）。

### WP0：工具来源统一为主进程

**做什么**

1. 不给 `runToolChatSession` 加 `tools`/`disableTools` 入参——工具清单始终由主进程内部算。
2. 删掉渲染端发送路径的工具字段：`src/shared/api.ts` 删 `ClaudeChatCreateWithToolsPayload.tools`；
   `chatToolSessionService.buildToolChatPayload` 删掉 `filterBuiltinToolsForRenderer` / `sanitizeAnthropicToolsPayloadForStrictGateways` 及 `tools` 组装；
   handler（`claudeStreamHandlers.ts:303`）删掉对 `toolsRaw` 的校验与丢弃。
3. 把工具计算抽成单点纯函数 `computeEffectiveTools(args)`，**返回 `{ tools, toolNames }`**：
   - `tools` 给模型 / executor / 确认门装配；
   - `toolNames` 给「把可用工具名提示给模型」用（`appendAvailableToolsHint`）。
   - 输入集中传入 `toolsConfig / browserConfig / shellConfig / feishu / wechat / remoteContext / exposureRules / appDb`（都是主进程现有的输入）。
4. 界面的 `useToolsApi` / `toolsEnabled` 降为**纯界面开关**：只有「要不要显示工具相关按钮 / 确认模式」用它，
   不用它决定发什么、走哪条路。

**怎么验收**

- 发送载荷（`payload`）不再含 `tools`/`disableTools` 字段。
- 工具清单为空（配置关 / 链路全拒 / 只读）时，主进程拿到空清单，不读外部 MCP、不建确认门（与 WP5 配合断言）。
- `useToolsApi` 只驱动界面；`ChatView.tsx:722/:1225` 的「发图需要工具」拦截改为视觉模型判断，`:1578` 的 `_toolsEnabled` 死参数删除。
- 既有行为不变：不给 `tools` 时，主进程照旧按配置 + 外部 MCP 自算（回归现有 `toolChatLoop.*.test.ts`）。

### WP1：统一流式解析（一个流接口 + 一个纯函数）

**做什么**

1. 定义一个 `NormalizedDelta` 类型：`block_start` / `text_delta` / `reasoning_delta` / `tool_call_delta` / `block_end` / `usage` / `finish`。
2. 定义一个 `StreamClient.stream(params, cancel)`：返回 `AsyncIterable<NormalizedDelta>`。一个实现包 Anthropic SDK 的
   `client.messages.stream` 并做「事件 → Delta」映射；另给一个 `MockStreamClient` 用于测试。
3. 写纯函数 `aggregateDeltas(deltas)`：把两条路径重复的「把 Delta 拼成完整内容块」收成一份；工具路径在此基础上多收集 `tool_use`。
4. 让 `runToolChatSession` 与 `runSendStream`（WP4 删除前）都用这套。

**怎么验收**

- `aggregateDeltas` 表驱动单测：text / think / tool_use / usage 乱序与块边界。
- `MockStreamClient` 喂脚本化 Delta，断言聚合结果一致。
- 既有 `toolChatLoop.*.test.ts` 不接触真 SDK（改用 Mock）。

### WP2：用到才初始化（惰性接线）

**做什么**

下面三件事，现状是「每次请求都做」，实际只该在「确实要用」时做（判定信号来自 `computeEffectiveTools` 的结果）：

1. 读外部 MCP 工具清单（`buildSnapshotFromDb`，[toolChatLoop.ts:537](../../electron/toolChatLoop.ts#L537)）：这是廉价数据库读，
   只在「MCP 已启用」时才读；MCP 完全没配就跳过、返回空清单。
2. 解析工作目录（`resolveWorkDirForSession`，[claudeStreamHandlers.ts:313](../../electron/claudeStreamHandlers.ts#L313)）：只在工具清单非空（或确实需要工作目录）时才解析；纯聊天跳过。
3. 创建外部工具连接管理器（`McpConnectionManager`，[toolChatLoop.ts:406](../../electron/toolChatLoop.ts#L406)）：这是**每次请求都存在的固定开销**，
   改成**第一次真正要调用某个外部工具时才连接**（惰性）；本轮永远用不到就零创建、零关闭（`shutdown()` 也只在该建过时执行）。
4. 工具确认门、执行器调度表、工具事件订阅沿用同一「清单非空」信号接入。

**怎么验收**

- 空工具：单次请求、无 `tool_use`、无工具事件、无确认门、无外部工具连接、`stopReason='end_turn'`。
- 空工具 + 无外部工具：`buildSnapshotFromDb`、`new McpConnectionManager` 都不被调用（用 spy 断言）。
- 非空工具行为完全不变（回归 `toolChatLoop.*.test.ts`、`toolChatLoop.mcp.test.ts`）。

### WP3：界面合并成一个发送入口

**做什么**

1. 删掉 `claudeChatSendStream`，聊天统一走现有 `claude-chat-create-with-tools`（渲染端 `claudeChatCreateWithTools`）
   作为唯一交互通道；发送载荷不再带工具字段；是否带工具由主进程 `computeEffectiveTools` 决定。
   （**不改名**，沿用旧名记为后续时机，避免牵连 `preload.ts` / `api.ts` 及一批 mock 该通道的测试。）
2. 删掉 `runClaudeChatStream`（`chatStreamService`）和非工具分支；`ChatView` 只剩一套
   `claudeChatOnDelta/OnThinkingDelta/OnDone/OnError` 订阅。
3. `useToolsApi` 降为纯界面开关：`exposureTools=null`（启动空窗）与 `cfg.tools.enabled=false` 都**不再切换链路**，
   由主进程决定是否带空工具；界面只等「可用清单」从主进程到达再亮相关按钮，**启动空窗期也能发消息**。
4. **发图改为看模型多模态**：单路径后图片必然能送，原先 `ChatView.tsx:722/:1225` 的「发图需要工具」拦截改为
   `resolveVisionRouteForImageSend` / `requestNeedsVisionModel`（模型支不支持图片）；`:1578` 的 `_toolsEnabled`
   死参数删除。`enqueueChatMessage`（定义 `:521`、调用 `:1266`）不按 `useToolsApi` 切工具。
5. **确认卡不再受「工具开没开」门控**：删掉 `resolveMessageToolsInteractive.ts:126` 的
   `if (!sessionId || !toolsEnabled) return undefined`——确认卡是否显示只取决于「当前有没有一条待确认」
   （由主进程下发的待确认事实驱动），不再受「工具看起来关了」影响，避免「工具关掉后已存在的确认不显示 → 隐形卡死」。
6. **两条路径的行为差异要对齐**：
   - **usage 传递契约**：统一后 usage 权威来源 = `claude-chat-usage` 事件（流式实时，工具循环里发）+
     invoke 返回值的 `usage`（最终结算，[claudeStreamHandlers.ts:354](../../electron/claudeStreamHandlers.ts#L354)）。
     因此「完成」事件统一为 `{ requestId }`（[claudeStreamHandlers.ts:352](../../electron/claudeStreamHandlers.ts#L352)，**不携带 usage**）；
     界面以 `claude-chat-usage` 事件 + invoke 返回值为准，避免「done / usage 事件 / 返回值」三处都带 usage 造成双份或丢失。
     （原直出路径把 usage 塞进 done 的做法随直出路径废弃。）
   - **最少输出长度 / 思考模式**：原来不带工具路径用 `normalizeToolLoopMaxTokens`（无下限）+ 思考永远开启；
     带工具路径用 `resolveToolLoopModelOptions` + `effectiveMaxTokensForBuiltinToolLoop`（[toolChatLoop.ts:494](../../electron/toolChatLoop.ts#L494)，有下限）。
     合并后纯聊天也会用后者——**这个行为变化已确认接受**（纯聊天统一采用有下限的最少输出 + 跟随配置的思考模式）。
7. 边界守卫：单路径后每次发送都要有 `sessionId` 且首条是 user / 消息非空；**仅空白消息仍拒绝**
   （直出路径 `normalizeAndValidateClaudeMessages` 对空 content 报错，工具路径对空转 `' '`，统一后维持「空白即拒绝」）；
   确认没有「无会话就发消息」的入口被删（桌面 `runSessionId` 恒有，远端也用要 `sessionId` 的 `runToolChatSession`）。
8. 取消收尾：带工具路径收尾比原来不带工具路径多一个 `clearRequest`（[toolChatLoop.ts:421](../../electron/toolChatLoop.ts#L421)），
   合并后保留带工具的收尾形态即可，无需额外处理。

**怎么验收**

- 工具开 / 工具关两种情况都走同一发送函数；发送路径无 `tools`/`disableTools`。
- usage 契约：以 `claude-chat-usage` 事件 + invoke 返回值为权威；「完成」事件为 `{ requestId }`（不带 usage），界面不依赖 done 的 usage。
- 单路径后发图不再依赖工具：`ChatView.tsx:722/:1225` 的拦截改为视觉模型判断（能发 → 有视觉模型；不能发 → 提示不支持）；`:1578` 死参数已删。
- 确认卡渲染不受「工具开没开」门控：即便 `toolsEnabled=false` 且有待确认，仍返回可交互配置；无待确认才不返回。
- 最少输出长度 / 思考模式按已接受的变更核对（含 `toolLoopModelOptions` 相关测试）。

### WP4：删除不带工具那条路径

**为什么删除**：WP3 合并后，`claude-chat-send-stream` 成了死代码。

**做什么**

1. 删除 `claudeStreamHandlers.ts` 里的 `claude-chat-send-stream` handler 与 `runSendStream` 及它**专属**的辅助函数。
2. **必须保留**：
   - `claude-chat-cancel` handler（[claudeStreamHandlers.ts:375](../../electron/claudeStreamHandlers.ts#L375)，两路共用；必要时抽出独立注册）；
   - 导出函数 `normalizeAndValidateClaudeMessagesWithContentBlocks`（[`:191`](../../electron/claudeStreamHandlers.ts#L191)，被
     `claudeStreamHandlers.pairing.test.ts` 与 create-with-tools 使用）；该导出若仍被引用，需**迁到独立模块**
     （如 `chatMessageValidate.ts`）而非随整文件删除。
3. **可随删**：`normalizeAndValidateClaudeMessages`（`:92`）及其直接依赖（仅不带工具路径用）。
4. 删除 `src/renderer/services/chatStreamService.ts`；清理 `preload.ts` / `api.ts` 的 `claudeChatSendStream*` 桥接与类型；保留 `claude-chat-create-with-tools` 为唯一聊天通道。
5. 远端（`remote/`、`feishu/`、`wechat/`）已全部走工具循环，不受影响。

**怎么验收**（含测试迁移）

- 全仓 `rg` 无残留 `send-stream` / `runSendStream` / `runClaudeChatStream`（cancel handler 除外）。
- 以下直接测不带工具路径的测试要先迁移 / 改写：
  - `electron/claudeStreamHandlers.usage.test.ts`
  - `electron/claudeStreamHandlers.locale.test.ts`
  - `electron/claudeStreamHandlers.pairing.test.ts`（依赖被保留的导出，删除时确认已迁移到独立模块）
  - `src/renderer/services/chatStreamService.test.ts`
  - `ChatView.autoCreateSession.test.tsx`、`ChatView.scrollToLatest.test.tsx`（`tools.enabled:false` 用例）
- `npm run typecheck:renderer`、`npm run typecheck:shared` 通过；既有 `claudeStreamHandlers*.test.ts`、`toolChatLoop.*.test.ts` 全通过。

### WP5：保证「无工具聊天」不碰任何工具安全面

**做什么**

1. 回归测试：`computeEffectiveTools` 返回空清单时，确认门不触发、执行器不注册、不建外部工具连接、不做文件写入冲突追踪。
2. 清单为空时 `toolNames` 为空，系统提示里不出现「可用工具」实体提示。
3. 把「无工具 = 零工具安全面」当一等行为写进验收。

**怎么验收**

- 空工具全链路：无确认、无执行、无外部工具连接、无工具事件。
- 端到端：工具开（含一次真实工具调用）与工具关（纯文本）都走同一入口且行为正确。

### WP6：关闭工具时，处理正在进行中的确认

**为什么**：工具确认自带 5 分钟超时，但「关掉一个工具」并不会让它立刻解冻；而且正在进行的请求用的工具清单是
在开始时就定死的，关工具对它不生效（点了同意照样执行）。这两个都是坑。

**做什么**

1. 在主进程维护一个**实时「被禁用工具集合」** `getDisabledTools()`，由「工具可用性变更」回调更新（就在 `settings.tools` 保存 / `deniedTools` 变更处挂）。
2. 关掉某工具时：
   - `rejectPendingConfirmsForTool(toolName)`：把它所有在等的确认立刻置为「拒绝」（不再干等 5 分钟）；
   - **实时拦截点**：工具循环在「真正要执行某个工具」之前核对 `getDisabledTools()`——命中就返回
     「该工具已被禁用」的错误（`isError`）回喂给模型，**即便点了同意也不执行**。
     这个拦截点和请求开始时的清单快照**解耦**，循环不再只信启动时的清单。
3. `toolConfirmRegistry` 加 `rejectPendingConfirmsForTool(toolName)`；`waitForToolConfirm` 的记录里带上 `toolName`，以便按工具名批量拒绝。
4. 明确语义：关工具 = 立即拒绝它在等的确认 + 执行前按「被禁集合」拦截（在途和后续都不执行）；重开工具 = 只影响后续请求。

**怎么验收**

- 复现场景：会话 A 有确认 → 切到 B → 关该工具 → 切回 A：确认立刻「拒绝」（不等 5 分钟），A 继续、不卡死。
- 关闭的工具不会被执行：确认已 `rejected`；即便伪造「同意」，执行前命中 `getDisabledTools()` 仍返回 `isError`（不真正执行）。
- 未关闭工具的确认不受影响。
- 既有 `chatCancelRegistry.test.ts`、`toolChatLoop.*.test.ts` 不回归。

---

## 5. 测试策略

- 开发只跑定向：受影响文件用 `npm exec vitest run <file>`，改动面不明确用 `npm run test:related -- <file>`。
- 只改主进程：`npm run test:electron`；只改渲染端：`npm run test:renderer`。
- 构建验证：`npm run build:electron:incremental` + `npm run typecheck:renderer`，每阶段至多一次。
- 全量 `npm test` 只在 WP 阶段收尾与提交前跑。
- WP4 需先把那 5 个直测不带工具路径的测试迁移 / 改写。

---

## 6. 风险与残留

| 风险 / 残留 | 影响 | 怎么缓解 |
| --- | --- | --- |
| 空工具时误触工具链路 | 纯聊天被塞工具提示 / 触发确认 / 建外部工具连接 | `computeEffectiveTools` 空清单 + WP2 惰性接线 + WP5 回归 |
| 界面的工具清单只含内置工具，主进程可能还发外部 MCP 工具 | 界面亮起但与实际送出不一致 | WP0 明确主进程唯一权威 + 单向只读；如需对齐，让主进程下发的清单也涵盖外部工具（后续微调，非本次） |
| 空工具但存在外部 MCP 工具 | 主进程误发外部工具 | `computeEffectiveTools` 在清单为空时强制返回空；仅在确有 MCP 工具时才装配 |
| 合并后纯聊天行为变化（最少输出下限 / 思考模式 / 完成事件 usage） | 与旧直出路径不同 | WP3 已确认接受，写入验收，测试覆盖 |
| 删除带工具路径时误删共用物 | 「取消」/校验导出被删 | WP4 明确保留清单（cancel handler、`normalizeAndValidateClaudeMessagesWithContentBlocks`） |
| 该不加工具路径的调用方被漏掉 | 功能缺失 | `rg` 全仓清理 + 5 个测试迁移 + typecheck |
| 关掉工具对进行中请求不实时生效（确认最多卡 5 分钟、点了同意仍执行） | 感知「卡住」，被关工具仍可能运行 | WP6：关工具时拒绝其确认 + 执行前按「被禁集合」拦截 |
| 工具看似关了但已有待确认（确认卡被「工具开没开」门控隐藏） | 隐形卡死——确认在等但卡片不可见 | WP3：确认卡渲染只看「有没有待确认」，不再受门控 |

---

## 7. 后续阶段（不在本计划内）

本次落地后，为继续改善架构，建议随后依次推动（各自独立立项）：

1. **会话记录事件流**：新增只追加的审计 / 回放通道（turn 开始/结束、step 开始/结束、逐 token 内容、工具调用/结果、重试记录），
   消息表仍是唯一的「事实」读取源，事件流用于对账与崩溃补闭。
2. **上下文注入三段式**：`PromptAssembly` → `renderPrompt` 纯函数 → 序列化；把记忆 / 图片提示 / 工具约定 / 语言 / skill
   改成带 `order` 的 section，并在发请求前加「上下文占用估算」与可插拔的 tokenizer。
3. **渲染进程↔主进程领域状态解耦**：统一工具事件契约、把「工具调用状态机」收敛到主进程，界面只消费「已经拼好的消息 / 片段」事件。
