# Agent Loop 单路径重构计划

> 状态：v2 复审意见已吸收，待下一轮复审后实施
> 基线：工作区 HEAD `eaaba37`（评审日期：2026-09-05）
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
| 工具来源 | **主进程唯一决定**。编排层先判定各来源是否允许，分别取得并过滤「内置工具」与「MCP 工具」，再合并成最终集合；渲染进程发送路径**不携带任何工具字段**。 |
| 执行授权 | 最终工具集合同时生成请求级执行白名单。任何模型返回的 `tool_use.name` 必须先属于初始白名单，再满足请求级未撤销，最后通过既有调用策略，才允许进入工具专属处理、确认或执行器解析。 |
| 开关语义 | 为保持现有行为，`tools.enabled / allowedTools / deniedTools` **只约束内置工具**，不是所有工具的总开关；MCP 继续由 MCP 服务启用状态、工具白名单、缓存与链路规则独立决定。本次不新增“关闭全部工具”的配置。 |
| 无工具聊天 | 只有合并后的最终工具集合为空时，同一条路径才退化成「只聊天」。不得把“内置集合为空”当作“最终集合为空”，也不得把远端只读等同于零工具。 |
| 工具清单的"镜子" | 主进程把「当前能用哪些内置工具」下发给界面（只读）。界面拿它**只为了画界面**（决定要不要显示工具相关按钮 / 确认模式），绝不反向决定工具。 |
| 惰性接线 | 下面三件事只在「确实要用」时才做：读外部 MCP 工具清单、解析工作目录、创建外部工具连接管理器。 |
| 协议与流式聚合 | 抽取一个统一的「流接口」+ 一个纯函数，把两块重复的流式解析合并成一份。 |
| 发图 | 不再绑「工具开没开」，改为看「模型支不支持图片（多模态）」。 |
| 确认卡 | 只由「当前有没有一条正在等确认的工具」决定，不再受「工具看起来关了」影响。 |
| 远端只读 | 沿用现有按动作限制的语义：允许可用的读取工具，拒绝本地写入及被禁止的出站动作；不在工具集合计算中将其清空。 |
| 关掉工具 | 为每个活动请求记录单调增加的撤销事实；关闭某工具时立即拒绝同作用域内已登记的确认，并在登记确认前、确认/异步准备结束后执行前再次拦截。重开只授权后续请求。 |
| 通道名 | 沿用 `claude-chat-create-with-tools`，本次不改名。 |

---

## 3. 改之前的一些事实

- `RunToolChatSessionArgs`（[toolChatLoop.ts:340](../../electron/toolChatLoop.ts#L340)）**没有** `tools` 入参；工具清单由
  `runToolChatSession`（[toolChatLoop.ts:404](../../electron/toolChatLoop.ts#L404)）在请求开始时自己算（`:525` + `:537`）。
- 界面上传的 `tools` 字段，在主进程 handler（[claudeStreamHandlers.ts:303](../../electron/claudeStreamHandlers.ts#L303)）里**校验后直接丢弃**，从没传给 `runToolChatSession`。
- 工具清单在请求**开始时就定死**（快照），中途关工具不影响正在跑的请求。
- 当前工具循环会按模型返回的名字直接查询全局内置执行器或 MCP 快照，没有先校验该名字是否属于本请求实际发给模型的最终工具集合；模型 schema 不能代替服务端执行授权。
- 界面的「工具开没开」由 `cfg.tools.enabled` + 主进程下发的 `exposureTools` 得出；`exposureTools` 只含内置工具。
- **图片字节只有带工具那条路径会真正塞进请求**（[chatMessageBuild.ts](../../electron/chatMessageBuild.ts) 的 `buildToolChatMessagesFromSource`，只在 create-with-tools 里调用）；另一条路不发图。
- 一条工具确认自带 **5 分钟超时**（[toolConfirmRegistry.ts](../../electron/toolConfirmRegistry.ts#L13)），所以不会永久卡死，但会干等最久 5 分钟。
- 远端聊天（微信 / 飞书）已经走工具循环；虽然不切换 IPC 入口，但共享循环会被本次修改，因此必须纳入回归，尤其是只读、写入和出站限制。
- 「取消聊天」和「导出校验函数」在两路间共用，删除时不能误删。

---

## 4. 工作包

> 每个 WP 拆成能独立验证的提交。每阶段收尾跑定向测试 + `npm run build:electron:incremental`；
> 全量 `npm test` 只在阶段收尾 / 提交前跑（遵循 AGENTS.md 的会话成本纪律）。

### WP0：工具来源与执行授权统一为主进程

**做什么**

1. 不给 `runToolChatSession` 加 `tools`/`disableTools` 入参——工具清单始终由主进程内部算。
2. 删掉渲染端发送路径的工具字段：`src/shared/api.ts` 删 `ClaudeChatCreateWithToolsPayload.tools`；
   `chatToolSessionService.buildToolChatPayload` 删掉 `filterBuiltinToolsForRenderer` / `sanitizeAnthropicToolsPayloadForStrictGateways` 及 `tools` 组装；
   handler（`claudeStreamHandlers.ts:303`）删掉对 `toolsRaw` 的校验与丢弃。
3. 将“读状态”和“纯计算”拆开，避免用最终结果决定是否读取它自己的输入：
   - 编排层先根据请求链路与现有配置做来源预检：内置来源始终可纯计算；MCP 仅桌面链路可能参与，远端链路明确不注入。
   - MCP 是否值得构建工具快照，由独立的轻量预检决定：先读取/复用服务配置元数据，判断是否存在启用且白名单非空的服务；只有可能产出候选时才读取工具缓存并构建快照。配置元数据读取与工具快照读取在接口和测试计数中分开，不得以“内置集合为空”作为跳过依据。
   - 对允许的来源取得候选：内置定义；以及同一次 `buildSnapshotFromDb` 得到的**请求级完整 MCP 快照**。
   - 纯函数 `computeEffectiveTools(args)` 只接收已取得的候选与配置/链路规则，分别过滤、合并并返回 `{ tools, toolNames, authorizedToolNames }`；最终集合为空的判断只发生在合并之后。
   - `tools` 是给模型的 schema；`toolNames` 用于 `appendAvailableToolsHint`；`authorizedToolNames` 是不可变的请求级执行白名单（建议 `ReadonlySet<string>`）。三者必须由同一份过滤后结果、使用同一套响应名称归一化规则生成，避免展示名、映射名与执行名漂移。
   - 编排层另外持有原始 `McpToolSnapshot`，沿执行链传递，不得试图从 schema 反推 `serverId / originalName / annotations`。原始快照只提供已授权 MCP 工具的执行元数据：即使快照仍有某条目，只要它不在 `authorizedToolNames` 中，就不得解析或执行。
4. 在消费每个完整 `tool_use` 块后，增加统一的初始授权守卫 `authorizeToolCall(toolName, authorizedToolNames)`。检查必须发生在 `getToolExecutor`、`resolveMcpExecutor`、工具专属输入/文件预处理、策略 gate 和确认登记**之前**，避免未授权调用产生文件读取、连接、确认或其他副作用；不得把最终集合重新复制成执行器内部的另一套配置判断。
5. 明确执行的三重前提及次序：`属于本请求初始授权集合` → `未被本请求撤销` → `通过既有调用策略`。初始白名单在请求生命周期内不可扩张；WP6 只负责收紧它，不能授予初始集合之外的工具。
6. 界面的 `useToolsApi` / `toolsEnabled` 降为**纯界面开关**：只有「要不要显示工具相关按钮 / 确认模式」用它，
   不用它决定发什么、走哪条路。

**怎么验收**

- 发送载荷（`payload`）不再含 `tools`/`disableTools` 字段。
- 只有最终集合为空时才按无工具路径装配；`tools.enabled=false` 仅使内置集合为空，若桌面存在可用 MCP 工具，最终集合仍非空。
- 远端只读不作为清空条件：读取工具仍可见；写入及被禁止的出站工具继续由既有 exposure / 确认 / 执行策略拒绝。
- 模型工具 schema、提示中的 `toolNames` 与 `authorizedToolNames` 来自同一最终集合；对模型返回名称的归一化结果逐个做白名单成员检查。
- 场景矩阵必须同时断言模型工具集合、`buildSnapshotFromDb` 调用次数、确认与执行可达性：
  - 内置为空、桌面 MCP 非空：读取一次快照，模型仅收到 MCP，且能按快照执行；
  - 内置非空、MCP 未配置或无启用服务：不读工具快照，模型仅收到内置；
  - `tools.enabled=false` 且桌面 MCP 已配置：内置为空但 MCP 保留（确认本次不改变现有语义）；
  - 远端且 MCP 已配置：不读 MCP 工具快照、不注入 MCP，内置工具仍按远端策略过滤。
- 初始执行授权矩阵：
  - `tools.enabled=false`、MCP 非空，响应返回内置 `read_file`：返回明确的 `tool_not_authorized` 工具错误，不查找执行器、不登记确认、不读取文件；
  - 最终集合非空，响应返回被 `allowedTools` 或 exposure 排除的内置工具：即使全局执行器存在且期间没有撤销，也返回 `tool_not_authorized`；
  - MCP 原始快照含某工具、但最终集合已过滤该工具：不解析 MCP 执行器、不创建连接、不调用外部服务；
  - 白名单内且未撤销、策略允许的内置与 MCP 工具：保持现有正常调用行为。
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

下面三件事按各自的前置条件惰性执行。注意：MCP 候选快照是最终集合的输入，不能依赖 `computeEffectiveTools` 的最终结果来决定是否读取：

1. 读外部 MCP 工具清单（`buildSnapshotFromDb`，[toolChatLoop.ts:537](../../electron/toolChatLoop.ts#L537)）：远端链路直接跳过；桌面链路通过与最终计算解耦的配置预检判定是否可能存在候选。无 MCP 配置、无启用服务或启用服务白名单为空时跳过；否则恰好读取一次并保留完整请求级快照。
2. 解析工作目录（`resolveWorkDirForSession`，[claudeStreamHandlers.ts:313](../../electron/claudeStreamHandlers.ts#L313)）：只在工具清单非空（或确实需要工作目录）时才解析；纯聊天跳过。
3. 创建外部工具连接管理器（`McpConnectionManager`，[toolChatLoop.ts:406](../../electron/toolChatLoop.ts#L406)）：这是**每次请求都存在的固定开销**，
   改成**第一次真正要调用某个外部工具时才连接**（惰性）；本轮永远用不到就零创建、零关闭（`shutdown()` 也只在该建过时执行）。
4. 工作目录、工具确认门、执行器调度表、工具事件订阅在**最终集合非空**时才接入；连接管理器进一步延迟到“调用名已通过请求级执行白名单，且确认为 MCP 工具”后创建。全局内置执行器注册表和原始 MCP 快照都不是授权来源。

**怎么验收**

- 空工具：单次请求、无 `tool_use`、无工具事件、无确认门、无外部工具连接、`stopReason='end_turn'`。
- 空工具 + 无 MCP 配置/无启用服务：`buildSnapshotFromDb`、`new McpConnectionManager` 都不被调用（用 spy 断言）。
- 内置为空 + MCP 非空：`buildSnapshotFromDb` 恰好调用一次，但模型返回纯文本时仍不创建 `McpConnectionManager`；实际 MCP 调用时才创建。
- 远端 + MCP 已配置：`buildSnapshotFromDb` 与 `McpConnectionManager` 均不调用。
- MCP 快照含有但执行白名单不含的工具调用：不创建 `McpConnectionManager`，也不做工具专属准备。
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
5. 远端（`remote/`、`feishu/`、`wechat/`）已全部走工具循环，不涉及入口删除，但共享循环行为必须回归，不能视为天然不受影响。

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
4. “无工具”只指最终合并集合为空；内置为空但 MCP 非空不是本 WP 的空工具场景。
5. 流式协议层仍要识别异常 `tool_use`，但识别不等于初始化工具链：
   - 最终集合非空但调用名不在白名单时，生成稳定、可审计的 `tool_not_authorized` 错误工具结果回喂模型，允许模型自行恢复；该调用不进入工具专属预处理、gate、确认或执行器解析。
   - 最终集合为空却收到 `tool_use` 时，没有合法工具结果协议可继续，立即受控终止本次 invoke，返回 `{ ok: false, error: 'unexpected_tool_call_with_no_tools' }`（最终字符串可本地化展示，但测试使用稳定错误码/分类）；发送正常错误收尾，不伪装成 `stopReason='end_turn'`，也不为该调用初始化任何工具设施。

**怎么验收**

- 空工具全链路：无确认、无执行、无外部工具连接、无工具事件。
- 空工具的正常文本响应仍以 `stopReason='end_turn'` 完成；异常 `tool_use` 则以 `unexpected_tool_call_with_no_tools` 失败收尾，二者必须区分。
- 端到端：工具开（含一次真实工具调用）与工具关（纯文本）都走同一入口且行为正确。
- 远端只读回归：允许的读取工具能执行；本地写入及被禁止的出站动作仍被拒绝；微信、飞书各覆盖共享循环的关键断言。

### WP6：关闭工具时，处理正在进行中的确认

**为什么**：工具确认自带 5 分钟超时，但「关掉一个工具」并不会让它立刻解冻；而且正在进行的请求用的工具清单是
在开始时就定死的，关工具对它不生效（点了同意照样执行）。这两个都是坑。

**做什么**

1. 区分“当前配置状态”和“请求生命周期内的撤销事实”：
   - 主进程维护按作用域递增的工具授权版本（或等价的禁用事件序号）；作用域至少包含 `lane + toolName`，若未来存在更细粒度配置，再扩展为配置主体/会话范围。
   - 每个请求开始时记录其授权基线，并维护单调增加、只增不减的 `revokedTools`（或通过版本判断“该请求开始后是否发生过撤销”）。工具重开只改变当前状态，**不能清除活动旧请求已经观察到的撤销事实**。
2. 工具可用性由允许变为拒绝时：
   - 给匹配作用域内的所有活动请求标记撤销；
   - `rejectPendingConfirmsForTool(scope, toolName)` 立即拒绝同作用域内已经登记的等待者，不影响其他 lane；
   - 当前没有等待者也必须保留撤销事实，以覆盖“关闭后模型才返回 tool_use”的时序。
   - 撤销事件至少覆盖 `tools.enabled / allowedTools / deniedTools` 导致的内置工具关闭，以及链路 exposure 从允许变为拒绝；MCP 服务或 MCP 工具关闭是否接入同一机制在实现前按现有设置事件确认，若接入也必须使用相同的请求级撤销和作用域规则。
3. `toolConfirmRegistry` 的等待记录增加 `toolName`、`lane`、`requestId`，批量拒绝按作用域精确匹配。工具循环在 WP0 的初始白名单守卫通过后，再设置两个 fail-closed 撤销检查点：
   - **任何工具专属预处理及登记确认前**检查请求级撤销；已撤销则不创建等待者，直接生成“该工具已被禁用”的 `isError` 工具结果；
   - **所有确认和异步准备完成后、调用执行器的最后入口**再次检查；即使确认同意与关闭交错，也不得启动执行。
4. “在途”边界明确为：已进入执行器之前的调用保证不启动；已进入执行器的调用本计划不承诺强制中止，因为可能已经产生不可逆副作用。若未来要求停止执行中操作，需另立取消信号、执行器协作及副作用补偿契约。
5. 请求结束时清理其撤销状态；配置重开后创建的新请求按新配置取得授权，旧请求仍保持撤销直至结束。
6. 新请求仍以“请求开始时的当前配置 + 请求级 MCP 快照”生成不可变初始执行白名单；当前配置已经禁用或过滤的工具既不会进入模型清单，也无法通过初始执行守卫。活动旧请求再由上述撤销机制补上快照之后的变化。

**怎么验收**

- 复现场景：会话 A 有确认 → 切到 B → 关该工具 → 切回 A：确认立刻「拒绝」（不等 5 分钟），A 继续、不卡死。
- 关闭的工具不会被执行：确认已 `rejected`；即便伪造“同意”，最终执行检查仍返回 `isError`（不真正执行）。
- 初始不在白名单的工具直接由 WP0 守卫拒绝，不能依赖 `revokedTools`；撤销守卫只处理初始授权之后发生的收紧。
- 关闭后模型才返回调用：登记确认前即被拦截，不创建等待者。
- 关闭后再重开：旧请求仍不可确认/执行，新请求可以重新取得该工具。
- 确认同意与关闭交错：最终执行入口再次命中撤销，不调用执行器。
- 未关闭工具及其他 lane 的同名工具确认不受影响。
- 既有 `chatCancelRegistry.test.ts`、`toolChatLoop.*.test.ts` 不回归。

---

## 5. 测试策略

- 开发只跑定向：受影响文件用 `npm exec vitest run <file>`，改动面不明确用 `npm run test:related -- <file>`。
- 只改主进程：`npm run test:electron`；只改渲染端：`npm run test:renderer`。
- 构建验证：`npm run build:electron:incremental` + `npm run typecheck:renderer`，每阶段至多一次。
- 全量 `npm test` 只在 WP 阶段收尾与提交前跑。
- WP4 需先把那 5 个直测不带工具路径的测试迁移 / 改写。
- WP0/WP2 的来源矩阵必须同时断言：模型工具名、MCP 快照读取次数、完整快照是否传到确认/执行链、执行器可达性。
- WP0/WP5 增加异常模型响应测试，直接注入未授权 `tool_use`，不依赖真实模型是否遵守 schema；分别覆盖 `tools.enabled`、`allowedTools`、exposure 与 MCP 过滤。
- 每个未授权测试同时 spy 断言：全局内置执行器查找、MCP 执行器解析、工具专属预处理、策略 gate、确认登记、文件读取、连接创建和实际执行均未发生。
- WP6 使用可控 Promise/屏障覆盖关闭、登记确认、同意、重开、执行入口之间的交错，不用时间延迟碰运气。
- 远端共享循环至少覆盖微信与飞书：只读读取成功、写入拒绝、禁止出站、MCP 不注入。

---

## 6. 风险与残留

| 风险 / 残留 | 影响 | 怎么缓解 |
| --- | --- | --- |
| 空工具时误触工具链路 | 纯聊天被塞工具提示 / 触发确认 / 建外部工具连接 | `computeEffectiveTools` 空清单 + WP2 惰性接线 + WP5 回归 |
| 界面的工具清单只含内置工具，主进程可能还发外部 MCP 工具 | 界面亮起但与实际送出不一致 | WP0 明确主进程唯一权威 + 单向只读；如需对齐，让主进程下发的清单也涵盖外部工具（后续微调，非本次） |
| 内置为空但存在外部 MCP 工具 | 把内置结果误当最终结果，丢失合法 MCP 能力 | 来源预检 → 请求级 MCP 快照 → 分别过滤合并 → 最终判空；矩阵测试断言读取次数与执行可达性 |
| 模型/兼容网关返回未提供的工具名 | 通过全局执行器注册表或原始 MCP 快照越过初始配置与 exposure | 最终集合生成请求级执行白名单；执行器解析和任何工具专属处理前先检查成员资格 |
| 空工具请求收到异常 `tool_use` | 为处理异常响应而反向初始化安全面，或伪装成正常完成 | 协议层识别后以稳定分类受控失败；无确认、执行、连接及工具事件，不返回正常 `end_turn` |
| 合并后纯聊天行为变化（最少输出下限 / 思考模式 / 完成事件 usage） | 与旧直出路径不同 | WP3 已确认接受，写入验收，测试覆盖 |
| 删除带工具路径时误删共用物 | 「取消」/校验导出被删 | WP4 明确保留清单（cancel handler、`normalizeAndValidateClaudeMessagesWithContentBlocks`） |
| 该不加工具路径的调用方被漏掉 | 功能缺失 | `rg` 全仓清理 + 5 个测试迁移 + typecheck |
| 关掉后重开使旧请求重新获权，或关闭后才登记确认 | 被撤销工具仍等待/执行 | WP6：作用域化版本或请求级单调撤销；确认登记前与最终执行前双检查；重开只影响新请求 |
| 按工具名全局拒绝确认 | 某一链路改配置误伤其他链路 | 撤销键和等待记录至少携带 `lane + toolName + requestId`，批量拒绝精确匹配 |
| 工具看似关了但已有待确认（确认卡被「工具开没开」门控隐藏） | 隐形卡死——确认在等但卡片不可见 | WP3：确认卡渲染只看「有没有待确认」，不再受门控 |

---

## 7. 后续阶段（不在本计划内）

本次落地后，为继续改善架构，建议随后依次推动（各自独立立项）：

1. **会话记录事件流**：新增只追加的审计 / 回放通道（turn 开始/结束、step 开始/结束、逐 token 内容、工具调用/结果、重试记录），
   消息表仍是唯一的「事实」读取源，事件流用于对账与崩溃补闭。
2. **上下文注入三段式**：`PromptAssembly` → `renderPrompt` 纯函数 → 序列化；把记忆 / 图片提示 / 工具约定 / 语言 / skill
   改成带 `order` 的 section，并在发请求前加「上下文占用估算」与可插拔的 tokenizer。
3. **渲染进程↔主进程领域状态解耦**：统一工具事件契约、把「工具调用状态机」收敛到主进程，界面只消费「已经拼好的消息 / 片段」事件。
