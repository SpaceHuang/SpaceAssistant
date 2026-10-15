# 驱动权路径重构计划（偏差 9 → 8、10、11、12）

> 对应架构文档：`docs/develop/architect/product-architecture-design.html`
> 路径定义（该文档 §12 依赖图注）：**调用契约路径** 1、2 → 3、4、5、6、8、16 已于 2026-09-19 收口（2/3/4/5/6/16 已解决、8 部分解决）；**驱动权路径** 1 → 9 → 8、10、11、12 为本轮目标。
> 文档核心论断：主进程必须是驱动权威，桌面只是它的一个客户端；「驱动权威不在主进程，另外三条都无从落地」；「渲染进程不做决定 —— 不发起 / 排队 / 重试 / 取消，不拼系统提示，不自己跑技能路由」。
>
> **修订记录**：
> v2（2026-09-19）按评审一（`driver-authority-refactor-plan-review.md`）修订——B1 基线重声明（合并已完成）、B2 偏差 8 IM 证据重勘察并改写 Phase 4.3、N1 local-command 定案、N2 删除显式例外出口、N3 全部行号以新基线复测。
> v3（2026-09-19）按评审二（`driver-authority-refactor-plan-review-v2.md`）修订——B1 §1a 改为「纯函数化改造 + 移动」两步（命令服务含 `import.meta.env.DEV` 与 `window.api` 耦合，非纯移动）；B2 `local-command` 改可判别联合、`contextIntent` 补全显式类型；B3 新增主进程排水器设计（排队「排水」驱动归属为偏差 9 核心漏项）并补 `chatRunnerService` 去向；P2 五项随轮落实（1c 验收补齐、视觉路由/占用预警去向、文件域版本单调性、消息列表 scope、投影竞态协议注释）。修订范围集中在 §1a/§1b/§1c 与 Phase 3 局部，按评审处置建议仅需对 Phase 1 相关小节定向复审。

## 0. 现状勘察（2026-09-19，基线 HEAD `3829424b`）

基线说明：`codex/desktop-auto-approval` 合并已完成于 `5b340c44`，其合并后回归修复为 `3829424b`——**含一处生产代码改动**：`invocationAssembler.ts:260` 起 lanePackage 来源支持材料级显式声明（`materials.policyLanePackage`）优先于 DB 读取（供无库宿主 / 测试收紧档位）；另有三个契约测试适配「自动」默认语义与测试侧 await 漏修。本计划全部行号已在 `3829424b` 上复测（原 dff15a69 基线的抽查行号零漂移）；合并波及文件的定向测试已补跑通过（policyRulesRuntime / toolCallGate / toolChatLoop.locale / toolChatLoop.memoryGuard / toolChatLoop.windowless / toolChatLoop.inMemoryPorts / toolChatLoop.invocation / capabilities-handlers-mcp，8 文件 66 用例全绿，2026-09-19）。

### 0.1 各偏差的剩余证据（复现口径）

| 偏差 | 内容 | 状态 | 剩余证据（本次实测） |
|---|---|---|---|
| **9** | 驱动权在渲染端 | 部分解决 | ① 出站分类：`ChatView.tsx:851` 调 `classifyOutboundMessage`（`src/renderer/services/chatOutboundClassifier.ts`），会话运行中时由**渲染端**决定「立即命令 / 排队」；② 发起编排：`ChatView.tsx:536` `sendInternal` 在渲染端串起 test-pop/test-cards/wiki/skill 命令解析、workDir 同步、**运行守卫**（`isSessionRunning`，读渲染端 Redux）、**并发上限守卫**（`countRunningSessions`）、**无会话则创建会话**（`window.api.sessionCreate`）、apiKey 检查，然后两步 IPC `chat:prepare-turn` → `chat:execute-turn`（`ChatView.tsx:793`、`messageMutationGateway.ts:128/182`）；③ **排队「排水」触发**：`drainQueueForSession`（`ChatView.tsx:496-534`）——渲染端 effect 监听 Redux `runningSessions` 变化，turn 结束后由渲染端拉 `chat:get-next-queued-message`（`appIpc.ts:877`，全仓库唯一消费方即 ChatView）并经 `sendInternalRef` 驱动下一回合，触发器依赖渲染端投影时序 + 本地 `drainingQueueRef` 守卫（主进程不可见，存在丢触发/重复触发竞态面）；④ 运行态登记枢纽：`chatRunnerService`（`registerSessionRun`/`finishSessionRun`/`routeAddMessage`）是 `isSessionRunning`/`countRunningSessions` 的数据源与排水触发、live 消息路由的枢纽 |
| **10** | IPC 面混杂两类东西 | 未解决 | `electron/appIpc.ts` 共 **2602 行**：Agent 驱动协议（`chat:prepare-turn:906`、`chat:execute-turn:1015`、`chat:cancel-turn:1035`、`chat:get-turn-displays:1070` 等）与桌面功能（`file:*:1960-2141`、`search:*:2141`、`config:get:1172`、`security:*:1328-1554`、`browser:*:666`、`shell:*:525`、`session:*:678-857`）同文件注册 |
| **11** | 视图更新没有契约 | 部分解决 | ① 会话列表仍拉全表：`session:list` → `database/operations.ts:listSessions` 全量，渲染端 `sessionSlice.setSessions` 全量替换，变更靠写后自刷；② 文件树/文件内容失效通知直连：`fileTreeSyncNotify.ts:9`、`fileContentWatcher.ts:25` 直接 `safeWebContentsSend`。已落地范式可复用：`src/shared/turnDisplayProtocol.ts`（TurnDisplay 版本差量） |
| **12** | 渲染端持有决定 | **已解决 20260916** | 仅回归验证，不另立改动 |
| **8** | 投递点散落 | 部分解决 | 已落地：`electron/driver/deliveryHub.ts`（`deliver(preference, payload)` 唯一入口 + 可达性 + 送达记录 + 有界补投），管家首批迁移（`butlerInvoker.ts:172` → `butlerDelivery.ts`）。剩余：① `claudeStreamHandlers.ts:2` 的 `safeWebContentsSend` 已是**死导入**（实际发送全走 `emitFactEvent`/`emitSessionEvent`，本次在 `3829424b` 复测确认）；② `fileTreeSyncNotify.ts:9` / `fileContentWatcher.ts:25` 两处直连（与偏差 11 共用证据，Phase 3 一并闭环）。**原证据③（IM 代理跳过 Runtime 装配）经复测已不成立**：`imRemoteAgent.ts:129` 自 `033beb8e` 起走 `assembleInvocation` 装配后才执行（`:164`），`feishuRemoteAgent.ts` / `weChatRemoteAgent.ts` 均委托共享入口 `runImRemoteAgent`，不直调 `runToolChatSession`——「Driver 不直接调 Core」的装配收敛已解决，架构文档该节的证据位（`feishuRemoteAgent.ts:46`、`weChatRemoteAgent.ts:48`）为陈旧引用，回写动作并入 Phase 5 |

### 0.2 可复用的已落地机制

- **`electron/turnRuntime.ts`**：主进程唯一 turn owner（prepare / bindRequest / execute / cancel / timeout / listActive + 事件投影）——偏差 9 的驱动权威落点。
- **`src/shared/turnDisplayProtocol.ts`**：版本化差量视图契约——偏差 11 的 scope+版本范式样板。
- **`electron/driver/deliveryHub.ts`**：`deliver(preference, payload)` 唯一投递入口——偏差 8 收尾的出口。
- **`electron/runtime/invocationAssembler.ts`** `assembleInvocation()`：Invocation 契约装配——偏差 9/8 中新链路统一走它。
- **事件出口** `emitFactEvent` / `emitSessionEvent`（偏差 1 成果）：主进程 → 渲染的既有通道，失效通知复用它。

### 0.3 验收边界（开工前对齐）

- **可单测验证**：出站分类矩阵、守卫/排队决定、IPC 拆分、失效通知 scope+版本语义、投递路由、渲染端决策消失的静态证据（rg 命令）。
- **需真机 / 外部系统**：飞书 / 微信端到端回合、托盘与浮动通知真实窗口、打包冒烟——列入移交清单由用户验收。

---

## Phase 0：基线确认（已完成于计划修订时，开工直接进 Phase 1）

原 Phase 0 前提已消失：`codex/desktop-auto-approval` 合并已完成于 `5b340c44`，合并后回归修复为 `3829424b`，无 MERGE_HEAD、无未解决冲突。本 Phase 的遗留动作已在计划修订时（2026-09-19）补执行：

1. ✅ **合并质量定向测试**：对合并波及文件补跑 `npm exec vitest run electron/confirmation/policyRulesRuntime.test.ts electron/confirmation/toolCallGate.test.ts electron/toolChatLoop.locale.test.ts electron/toolChatLoop.memoryGuard.test.ts electron/toolChatLoop.windowless.test.ts electron/toolChatLoop.inMemoryPorts.test.ts electron/toolChatLoop.invocation.test.ts electron/capabilities/handlers/mcp.test.ts` —— 8 文件 66 用例全绿。
2. ✅ **§0 全部证据行号以 `3829424b` 复测**：`ChatView.tsx:536/793/827/851`、`appIpc.ts:906/1015/1035/1070/1172/2029`、`claudeStreamHandlers.ts:2`、`fileTreeSyncNotify.ts:9`、`fileContentWatcher.ts:25`、`messageMutationGateway.ts:128/182` 全部命中零漂移；`ChatView.sendInternal`（:536-680）内部结构在合并后无语义漂移。
3. 保留约束：**此后每个 Phase 收尾各提交一次**，提交前跑该 Phase 定向测试。

---

## Phase 1：偏差 9 —— 回合发起与出站分类回主进程（路径核心）

目标形态（文档 §06/§07）：**主进程为驱动权威，桌面只是其中一个驱动源**；渲染进程只表达意图；「发起 / 排队 / 取消」全部回主进程。分三个子步，各自可独立提交、可回退。

### 1a. 出站命令解析纯函数化 + 下沉 `src/shared/`（两步，非纯移动）

> v3 修正：原「纯移动」前提不成立——实测 `testPopCommandService.ts:20` / `testCardsCommandService.ts:20` 使用 `import.meta.env.DEV`（主进程 `tsconfig.electron.json` 为 `"module": "CommonJS"`，CJS 输出下 `import.meta` 直接 TS1470 编译报错，构建破坏级）；`skillCommandService.ts:36/52/64` 调 `window.api.skillList/skillGet`、`wikiCommandService.ts:61/70/74/96` 调 `window.api.wikiInit/wikiStatus/wikiImportRaw`（`src/shared/` 定位是两端共享纯逻辑，不得出现 `window.api`）。

**第一步：纯函数化改造（行为保持，各服务原地改）**

| 服务 | 现有耦合 | 改造方式 |
|---|---|---|
| `testPopCommandService` / `testCardsCommandService` | `import.meta.env.DEV` 开发门禁（:20） | 改为注入参数 `deps: { isDev: boolean }`，由调用方传入 |
| `skillCommandService` | `window.api.skillList()` / `skillGet({name})`（:36/52/64） | 抽 IO 端口 `deps: { listSkills, getSkill }` 注入 |
| `wikiCommandService` | `window.api.wikiInit/wikiStatus/wikiImportRaw`（:61/70/74/96） | 同上注入 `deps: { wikiInit, wikiStatus, wikiImportRaw }` |
| `chatOutboundClassifier` | 组合以上四者 | 增加注入 `deps` 的签名，原无参签名包装保留（渲染端过渡期） |

- 渲染端调用方（ChatView 等）注入 IPC 实现，行为零变化；现有解析器测试全程护航（红绿基线先确认）。

**第二步：移动 + 双端接线**

- 四个服务 + `classifyOutbound` → `src/shared/outbound/`；渲染端原位置留 re-export（Phase 1c 删）。
- 主进程侧（1b 受理端口）注入主进程直连实现：技能列表/详情对应 `electron/skills/`，wiki 三操作对应 `electron/wiki/`（若某能力暂无主进程等价实现，单独评估补齐，不得经渲染端转发）。
- **验收**：
  - `rg -n "import\.meta|window\.api" src/shared/outbound/` → **0 行**
  - `npm run build:electron:incremental` 通过（**必跑**——vitest 逮不到 CJS 下 `import.meta` 编译错误）+ `npm run typecheck:renderer`
  - 测试：现有解析器测试随迁 + `npm run test:related -- src/shared/outbound`。

### 1b. 主进程出站受理端口（决定权回收）

新增 IPC `chat:submit-outbound`（命名与既有 `chat:` 域一致），渲染端只传意图：

```ts
// src/shared/ 侧协议（v3：contextIntent 显式落型；local-command 改可判别联合；投影为唯一事实源）
type OutboundContextIntent =
  | { kind: 'create-user'; text: string; attachments?: Message['attachments'] }
  | { kind: 'reuse-user';                                  // 重试（ChatView.tsx:885-893）与排水（:505-515）两个既有调用方都依赖
      currentUser: { message: Message; order: { kind: 'persisted'; sequence: number } }
      requestId?: string                                   // 排水必须透传队列里的原 requestId
      excludeMessageIds?: string[] }

type OutboundSubmitIntent = {
  sessionId?: string              // 无会话 = 请主进程创建（决定回主进程）
  text: string
  attachments?: Message['attachments']
  contextIntent?: OutboundContextIntent
}

type LocalCommandPayload =
  | { kind: 'test-pop-run' }      // 渲染端执行 window.api.testPopShow()（ChatView.tsx:551）
  | { kind: 'test-cards-run' }    // 渲染端执行 runTestCardsPreview（:589-598，需 dispatch/scrollBottom 等本地交互）
  | { kind: 'hint-only'; hint: string }   // 仅落提示消息（skillsState 变更已由主进程受理事务落库）

type OutboundSubmitResult =
  | { accepted: 'turn-started'; sessionId: string; turnId: string; assistantMessage: Message;
      warnings?: string[] /* 通过型警告（错误码）：如上下文占用≥80%——提示后照常发起，渲染端仅翻译展示 */ }
    // 协议注释：turn 投影（chatOnTurnProjection）是唯一事实源；本返回载荷仅供即时展示，
    // 渲染端按 turnId/messageId 幂等归并，不得据此双写状态（投影事件可能先于 invoke 返回到达）
  | { accepted: 'queued'; sessionId: string }
  | { accepted: 'local-command'; command: LocalCommandPayload }
  | { rejected: { reason: string /* 错误码 */; warnings?: string[] /* 拒绝附带警告（错误码）：如无视觉模型（P2-2） */ } }
```

主进程侧新增 `electron/outbound/outboundAcceptor.ts`（或挂 `turnRuntime` 旁），接管从 `ChatView.sendInternal`（:536-680）与 `:820-868` 搬来的全部决定：

| 渲染端今天做的决定 | 回收后主进程怎么判 |
|---|---|
| `parseTestPopCommand` 等命令解析 | 调 1a 下沉到 shared 的解析器 |
| `isSessionRunning`（Redux `runningSessions`） | `turnRuntime.listActive(sessionId)` |
| `countRunningSessions() >= maxParallel` | 同上，跨会话数 active turns（上限值从 config 读，主进程已是权威） |
| 无会话 `window.api.sessionCreate` | 主进程 `database.operations` 直接建 |
| 运行中 → `classifyOutboundMessage` → enqueue/send | 受理端口内分类：`local-command` / `queued`（`chat:enqueue-queued-message` 逻辑内聚）/ `turn-started` |
| `cfg.apiKeyPresent` 检查 | 主进程 `secureApiKey` 已有权威状态 |
| wiki run 模式的 `sessionUpdate`（skillsState/metadata） | 随受理事务在主进程完成 |
| 视觉模型切换预判、上下文占用 ≥80% 警告（`ChatView.tsx:698-745`，依赖渲染端 `historyForApi`） | 主进程 `turnExecutionConfig.ts:46` 已有权威视觉路由（`resolveVisionRouteForImageSend`）；两类用户可见提示改由受理端口承载（P2-2）：通过型警告走 `turn-started.warnings`（占用 ≥80%，提示后照常发起）、拒绝型走 `rejected.reason`（无视觉模型），渲染端仅翻译展示——避免静默 UX 回退 |

**主进程排水器（v3 新增，偏差 9 核心条目）**：现状「turn 结束后取队首驱动下一回合」由渲染端 effect（`drainQueueForSession`，`ChatView.tsx:496-534`）触发——「何时发起下一回合」这一驱动决定必须回主进程：

- `turnRuntime` 的 turn 进入终态（source-completed / failed / cancelled / timeout）后，由**主进程排水器**（挂在 turnRuntime 终态投影处，1b 与受理端口同体）对原会话取 `getNextQueuedMessage` 队首，复用受理端口以 `reuse-user` + 原 `requestId` 发起下一回合。
- 队空 / 会话已删 / 下一条非 queued 状态 → 不驱动；排水失败（准入拒绝）按受理端口既有处置落审计，不静默。
- `chatRunnerService` 去向：`registerSessionRun`/`finishSessionRun` 的登记改由 turn 投影事件喂入（主进程事实驱动），模块收缩为「投影驱动的展示态索引」，不再作为运行态的判定源头（1c 落实）。

实现要点：
- **`chat:prepare-turn` / `chat:execute-turn` 两步协议保留**：这是 turnCoordinator checkpoint 持久化语义，不动。变化是编排上移——受理端口内部 prepare 后**由主进程驱动 execute**（经 `turnRuntime.executeWithSource`），渲染端不再持有 execute 调用时机（1c 落实）。
- 受理结果走错误码 + `errors` i18n 命名空间（AGENTS.md 规范），渲染端拒绝提示只做展示。
- **测试（不变量优先）**：出站分类矩阵（命令×运行态×并发满）；随机操作序列用例——反复 submit / cancel / enqueue，断言「主进程 active turns 数与受理结果一致性」「排队条数守恒」（对齐 butlerAdmission 的不变量测试范式）；**排水不变量**（v3）——turn 终态后队列长度减一或不变（队空），断言「不并发双驱（同一会话同一时刻至多一个 active turn）」「排水后队列长度守恒」。无库/测试宿主需收紧安全档位时，用 `materials.policyLanePackage` 显式声明（`3829424b` 引入的材料级覆盖），无需读 DB 配置。

### 1c. 渲染端瘦身（意图表达）

- `ChatView.tsx` 的 `sendInternal` 收敛为 `submitOutbound`：构造意图 → `window.api.chatSubmitOutbound` → 按 `accepted` 结果同步展示状态（`local-command` 按 `command.kind` 路由：`test-pop-run` → `testPopShow()`、`test-cards-run` → `runTestCardsPreview`、`hint-only` → 落提示消息——渲染端**不重新解析文本**）；`ChatView.tsx:843-858` 的运行中分类分支整段删除。
- **排水触发器删除**（v3）：`drainQueueForSession` effect（`ChatView.tsx:496-534`）与 `drainingQueueRef` 守卫整段移除——排水已由主进程排水器驱动（1b），渲染端仅通过投影/失效通知观察队列变化。
- `messageMutationGateway.ts` 的 `prepareSendContext` 乐观更新逻辑保留但退化为**投影响应**：以 `chatOnTurnProjection`（既有事件出口）的 turn-started/事实流驱动 live/display 状态建立，`ackApiContextMessagePersisted` 等序列确认逻辑随 prepare 内聚到主进程受理后由投影携带。
- **`chatRunnerService` 收缩**（v3）：`registerSessionRun`/`finishSessionRun` 改由 turn 投影事件喂入，模块退化为「投影驱动的展示态索引」；`isSessionRunning`/`countRunningSessions` 的全部**决策用途**移除（仅展示态保留）。
- 删除渲染端对 `classifyOutboundMessage`、发送路径内 `sessionCreate` 的引用；1a 的 re-export 与渲染端注入包装一并清理。
- `chat:get-next-queued-message`（`appIpc.ts:877`）与 `chat:prepare-turn` / `chat:execute-turn` 对渲染端退役：通道随 Phase 2 收进 `agentProtocolIpc.ts` 后，仅主进程排水器/受理端口内部使用，`preload.ts` 对应 API 面删除。
- 验收（可复现命令）：
  - `rg -n "classifyOutbound" src/renderer --glob '!*.test.*'` → **0 行**
  - `rg -n "sessionCreate" src/renderer/components/Chat/ChatView.tsx` → **0 行**
  - `rg -n "chatExecuteTurn|chatPrepareTurn" src/renderer --glob '!*.test.*'` → **0 行**（发起编排已上移，P2-1）
  - `rg -n "chatGetNextQueuedMessage|drainQueue" src/renderer --glob '!*.test.*'` → **0 行**（排水已上移，B3）
  - 渲染端 `isSessionRunning` / `countRunningSessions` 仅剩展示态用法。

---

## Phase 2：偏差 10 —— IPC 面按领域拆分（依赖 9）

目标形态（文档 §05）：「IPC 面按领域切，不按实现方便堆在一起。驱动协议属驱动源实现，桌面功能单列」。

- `electron/appIpc.ts`（2602 行）拆为 `electron/ipc/` 下按领域文件，通道名**全部不变**（`preload.ts` 与渲染端零改动，风险最低）：

| 新文件 | 通道域 | 说明 |
|---|---|---|
| `electron/ipc/agentProtocolIpc.ts` | `chat:*`（turn/queued/display/confirmation）、`tool:*`、Codex 事件订阅 | Agent 驱动协议 = 桌面驱动源的协议面，Phase 1 的 `chat:submit-outbound` 落这里 |
| `electron/ipc/sessionIpc.ts` | `session:*`、`usage:*` | 会话真相查询（Storage 面） |
| `electron/ipc/fileIpc.ts` | `file:*` | 桌面功能 |
| `electron/ipc/searchIpc.ts` | `search:*` | 桌面功能 |
| `electron/ipc/configIpc.ts` | `config:*`、`llm:*` | 桌面功能 |
| `electron/ipc/securityIpc.ts` | `security:*`、`shell:manage-trusted-commands` | Safety 面 |
| `electron/ipc/desktopIpc.ts` | `app:*`、`browser:*`、test-pop 等杂项 | Electron 外壳与桌面功能 |
| `appIpc.ts` 保留 | — | 仅 `registerAllIpc(ctx)` 组合器 + IpcContext 类型 |

- `IpcContext` 按域拆接口（`AgentProtocolContext` / `FileContext` / …），各领域文件只声明自己需要的依赖——顺带把「一个 ctx 装一切」的隐式耦合切开。
- `mcpIpc.ts` 已单独成文件，对齐新目录结构（可选迁移 `electron/ipc/`，不强制）。
- 验收：`rg -c "ipcMain\.(handle|on)" electron/appIpc.ts` → **0**；`npm run typecheck:shared` + `npm run typecheck:renderer`；定向测试 `appIpc.securityRules.test.ts`、`appIpc.confirmTrust.test.ts` 等。
- 注意：本 Phase 是**纯移动**，不做行为改动；与 Phase 1 的通道新增解耦（1b 先落 appIpc.ts 内，Phase 2 搬走）。

---

## Phase 3：偏差 11 —— 失效通知契约收尾（依赖 9；顺带闭环偏差 8 两处直连）

目标形态（文档 §06 视图更新）：「失效通知是广播，只带 scope 与版本（如 `session-list`、`session:<id>`）；Driver 收到后自己去 Storage 取。真相只有一份」「Driver 侧的动作是版本比较：通知版本更高就重取，否则忽略」。范式抄 `turnDisplayProtocol`。

### 3a. Storage 版本号（scope 版本的权威源）
- `electron/database/` 会话写路径（create/update/delete/rename 等）在**同一事务内**递增 `session-list` 版本（新表或 config 键，走 `runInTransaction`，满足「Storage 在事务内递增」）。
- 文件域版本（v3 改）：**统一单调计数器**——主进程内存原子自增 + 启动时以 Storage/文件系统现状为基准初始化；**不用 mtime 作版本**（目录 mtime 不反映子孙变化、同 tick 多次写入可取同值 → 版本不变 → 渲染端按「版本比较」跳过重取，违反本 Phase 不变量「渲染端最终状态 = Storage 真相」）；mtime 仅可作冷启动种子。

### 3b. 失效通知（会话列表 + 消息列表 + 文件域）
- scope 清单（v3 补消息列表）：`session-list`（列表增删改）、`session:<id>`（会话元数据）、`session:<id>:messages`（消息列表——飞书/微信入站消息现走 `feishuOnInboundMessage` → 渲染端 `reloadSessionMessagesFromDb` 整页重取（`ChatView.tsx:355-358`），改为通知触发重取）、`file-tree`、`file:<path>`。主进程在对应写路径提交后经 `emitSessionEvent`（事件出口）广播 `{ type: 'invalidation', scope, version }`。
- 会话/消息列表的重取协议：渲染端收到更高版本 → 版本比较通过后重取（`session:list` / 既有 `chat:get-messages`，首期重取仍可全量——偏差 11 的验收口径是「通知驱动重取 + 真相只从 Storage 取」，列表差量化是后续可选深化）；删除「渲染端写后自刷」路径（`upsertSession` / 入站消息整页重取的调用方收敛为「通知触发重取 + 本地乐观更新」两类）。
- 防抖：多条通知合并为一次重取（版本比较天然幂等）。

### 3c. 文件树 / 文件内容失效通知（同时闭环偏差 8 两处直连）
- `fileTreeSyncNotify.ts`：`safeWebContentsSend(sender, 'file:tree-changed', event)` → 经统一事件出口发 `{ scope: 'file-tree', version }`（不再携带树内容或携带内容由渲染端重取决定——原 event 若即真相，改为渲染端收到后 `file:list-directory` 重取）。
- `fileContentWatcher.ts`：同理改 `{ scope: 'file:<path>', version }`，渲染端重取 `file:read-file`。
- 验收（可复现命令，对齐架构文档证据约定）：
  - `rg -n "safeWebContentsSend" electron/ --glob '!*.test.*'` → 仅 `safeWebContentsSend.ts` 自身（及 `deliveryHub` 的 desktop driver 实现处）
  - 失效通知载荷单测断言**不含真相**（无消息内容/列表/文件内容字段）。
- 测试：版本单调性（同事务并发写）、通知合并重取、丢通知后下一条版本更高必重取（不变量：渲染端最终状态 = Storage 真相）。

---

## Phase 4：偏差 8 收尾 —— 投递出口归一（依赖 9）

1. 删除 `claudeStreamHandlers.ts:2` 的 `safeWebContentsSend` 死导入（终态已全走 `emitFactEvent`/`emitSessionEvent`，`3829424b` 复测确认无用点）。
2. 复核桌面终态投递链路是否全部经 `deliveryHub` 或事件出口（管家已迁移；聊天主链路 Phase 1 后受理端口统一发起，无独立直发点）。
3. **IM 装配收敛：确认已解决，转为架构文档回写**（原整改项经 2026-09-19 复测不成立）：`imRemoteAgent.ts:129` 自 `033beb8e` 起已经 `assembleInvocation` 装配后才执行，`feishuRemoteAgent.ts` / `weChatRemoteAgent.ts` 均委托共享入口 `runImRemoteAgent`——架构文档「Driver 不直接调 Core」一节引用的证据位（`feishuRemoteAgent.ts:46`、`weChatRemoteAgent.ts:48` 直调）是 `033beb8e` 之前的陈旧快照。本 Phase 只需把该陈旧证据的修正并入 Phase 5 的架构文档回写（改为指向 `imRemoteAgent.ts` 的共享装配入口现状）；**不再有代码整改动作，无显式例外出口**。备注：IM 回合不经 `turnRuntime`（回合显示所有权）属另一维度，未列入偏差 8/9 的证据与验收口径，若未来要统一回合所有权威应另立偏差条目，本轮不开整改。
   - 验收：本文档 §0.1 偏差 8 行与架构文档回写内容一致；`rg -n "assembleInvocation" electron/remote/imRemoteAgent.ts` 命中装配调用（现状保持）。

---

## Phase 5：回归验收与架构文档回写

1. **偏差 12 回归确认**（已解决，防退化）：`rg -n "parseSkillCommand|buildSystemPrompt" src/renderer --glob '!*.test.*'` → 仅意图表达引用，无路由/拼装逻辑。
2. 全量验收（AGENTS.md 规定时点）：`npm test` + `npm run build` + `npm run i18n:check`。
3. **架构文档回写**（仓库惯例）：`product-architecture-design.html` §12 偏差表状态列翻转（9 → 已解决、10 → 已解决、11 → 已解决、8 → 已解决/部分），追加 2026-09 复核记录（基线 HEAD、各条证据命令与翻转结果）。**另含两处陈旧证据修正**：「Driver 不直接调 Core」一节引用的 `feishuRemoteAgent.ts:46` / `weChatRemoteAgent.ts:48` 直调快照（已随 `033beb8e` 失效，改为指向 `imRemoteAgent.ts` 共享装配入口现状）；偏差 8 状态行中「存量直连点」的剩余项按本轮收尾结果改写。
4. 分阶段提交节奏：1a-纯函数化 / 1a-移动 / 1b / 1c / 2 / 3a+3b / 3c / 4 / 5 各一次提交（Phase 0 基线确认已于计划修订时完成，无需提交），每步 `build:electron:incremental` + 定向测试通过后提交。

## 风险与对策

| 风险 | 对策 |
|---|---|
| 1a 纯函数化是行为保持重构，但触碰四个解析器的签名 | 拆「纯函数化」「移动」两步各自提交；现有解析器测试全程护航（先跑红绿基线），纯函数化完成即验收 `import.meta`/`window.api` 归零 |
| 1c execute 编排上移牵动渲染端展示同步链路（turnProjection 事件时序） | 拆成 1b（决定回收）/ 1c（编排上移）两步，各自可回退；1b 完成即已满足偏差 9 验收口径的最低要求 |
| 主进程排水器与渲染端残留触发并存期的双驱竞态 | 1b 落排水器时先保留渲染端触发、1c 删（顺序不可反）；排水不变量测试卡「同一会话同一时刻至多一个 active turn」 |
| 渲染端本地即时反馈（警告/提示）变慢 | 受理端口同步返回拒绝原因（错误码），渲染端仅翻译展示；不引入可感知延迟 |
| test-pop / test-cards 等测试命令归属 | **已定案（N1）**：命令**分类**回主进程；渲染端按 `local-command.command.kind` 判别联合路由执行（`test-pop-run` / `test-cards-run` / `hint-only`），不重新解析文本 |
| 会话列表首次加载 | 失效通知只驱动「重取时机」，首次仍全量拉取，语义不变 |
| 后续基线漂移 | 行号证据仅为辅助，验收一律以各 Phase 列出的 `rg` 符号级命令复现（架构文档证据约定） |

## 交付形态确认（AGENTS.md 验收边界要求）

- 本计划全部代码改动均可单测验收（vitest electron + renderer 双项目）。
- 需真机/外部系统验收项（移交用户）：飞书/微信真实回合、托盘/浮动通知真实窗口行为、打包冒烟。
