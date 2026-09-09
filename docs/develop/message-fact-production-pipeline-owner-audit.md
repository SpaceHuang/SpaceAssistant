# 消息事实生产链路 Owner 审计与验证记录

> 记录时间：2026-09-07
>
> 对应方案：[消息事实生产链路统一开发方案](./message-fact-production-pipeline-refactor-plan.md)
>
> 本文是当前工作树的阶段性证据；生产 owner 清理已完成，最终验收仍受真实 Electron IPC/渲染性能采样与跨平台 CI 证据约束。

> 2026-09-07 增量：上下文基线已改为取最新 500 条并恢复 sequence 升序；Claude SDK 裁剪支持 required user，重试目标不再因长历史被裁掉；`prepareSendContext` 已要求有效 Core prepare，不再回退 legacy append。对应数据库、历史裁剪、Claude handler 和 ChatView 回归均已通过。

> 同日增量：补充 required-user 裁剪的工具组完整性规则；裁剪窗口切断 `tool_use/tool_result` 时会同时移除孤立一侧。历史/上下文/Claude/数据库相关 5 个测试文件、57 个测试及类型门禁通过。

> 同日增量：新增 Q1/Q2 上下文回归，验证 A/B 完成历史保留、queued/streaming 占位排除，以及 A→B→C→D 的 API history 因果顺序；定向测试通过。

> 同日增量：新增独立 `prepareSendContext` Core 契约夹具，并将 ChatView 自动建会话夹具迁移到 execute-turn accepted 生命周期；create/reuse 均通过原子 `chatPrepareTurn` 返回 user/assistant/turn，生产路径不再回退 `chatAppendMessage`。

> 同日增量：补充 `chat:execute-turn` IPC 契约回归，验证 prepared turn 的 token 校验、accepted 即时响应与异步 `ctx.executeTurn(sender, payload)` 启动；appIpc.file 19/19 通过。

> 同日 rebase/收敛增量：当前分支已 rebase 到本地 `main` `1f6e794`，当前 HEAD `679be46`；工具 progress/confirm 事实在 legacy WebContents 事件之前发出。全量 Vitest 503/503 个测试文件、3048/3048 个测试通过，`npm run build` 通过。

> 同日 Core 收敛增量：删除 `TurnCoordinator.execute` 对 source 直接返回 Message 的兼容兜底，`ModelResult` 现在只允许 outcome/error/usage；source 必须通过 `consume` 产生权威 assistant 事实。Coordinator 19 个测试及 Electron/Renderer 类型检查通过。

> 同日 projection 增量：`turnProjectionService` 现在把完整 assistant snapshot 同步到 `pendingConfirmStore`，确认卡片可从 Core 的 `confirming` tool call 重建并保留 diff、风险和安全提示字段；新增 projection/确认回归 7 个测试通过。

> 同日 ChatView 收敛增量：ChatView 已删除旧 delta/thinking/tool listener、renderer ToolChatController 和终态 patch/flush 分支；`finishSessionRun` 不再触发 renderer DB flush，assistant 事实只由 Core projection/checkpoint 维护。ChatView、工具状态、projection 相关 5 个测试文件、26 个测试通过，Renderer 类型检查通过。

> 同日 P5 清理增量：删除 renderer `ToolChatController`、旧确认/结果订阅、request controller registry、流式 DB debounce/`routeStreamPatchMessage` 及其旧 UI batching 测试；保留投影更新和显式消息编辑/删除等合法 mutation。清理后相关回归、Renderer/shared 类型检查及 `git diff --check` 通过。

> 同日 remote fallback 收敛增量：为微信/飞书 router 测试补入可注入的 Core runtime fixture，先验证 prepare → execute → terminal 的真实适配路径，再删除 `executeRemoteTurn` 的无 runtime 兼容执行、router 的 assistant append/终态 patch fallback。remote execution/router 3 个测试文件、16 个测试通过，Electron typecheck 通过。

> 同日 remote projection 收敛增量：删除微信/飞书 `remote-agent-start`、`agent-done` renderer bridge、preload/shared API 暴露和 router 发送；remote 页面统一依赖应用级 `turnProjectionService`，出站 IM 回复与审计仍保留。相关 remote router/adapter 16 个测试、Renderer/Electron 类型检查和 `git diff --check` 通过。`rg` 已确认旧 remote 生命周期协议在生产代码中无残留。

> 同日全量门禁增量：在允许 loopback/Unix pipe 的本机权限下，全量 Vitest 502/502 个测试文件、3042/3042 个测试通过；`npm run build` 完整通过。Q1/Q2 已由 `apiContextQueueAndRetry.test.ts` 覆盖，Q3–Q8 已由数据库 queue/retry/receipt/claim/recovery 测试覆盖，Q9 已由 500 条历史、required user、附件与 FIFO/活动 turn 测试覆盖；Shell 清理预算和 Core 性能基准已有测试证据。

> 同日性能证据增量：`turnCoordinator.test.ts` 新增 10000 条、每条 32 字符 content-delta 基准，断言最终 320000 字符、version/checkpoint 均为 10000，且单测内 reducer 耗时低于 2 秒；测试文件 20/20 通过。既有 Shell benchmark 同时覆盖 100MB bounded output、rawDelta/progress 限流和 lifecycle 幂等。该证据覆盖 Core/reducer 与工具输出边界；真实 IPC/渲染端耗时仍不在 Vitest 可证明范围，需在运行中的 Electron 窗口做一次手工采样后才可关闭性能项。

> 同日运行时采样尝试：`npm run dev` 成功启动 Vite (`http://127.0.0.1:9240/`) 并完成 Electron 增量编译，但 CUA 报告当前 macOS 处于锁屏状态，无法读取/操作 Electron 窗口；开发进程已正常停止。Electron 启动期间另记录到默认开发 workspace 目录不存在的 `file:list-directory ENOENT`，不影响编译/测试。真实 IPC/渲染采样仍需在解锁桌面后取得。

> 同日运行时复核：解锁后创建开发用户 `workspace` 目录，目标 worktree 的 Electron 窗口成功加载 `http://127.0.0.1:9240/`；通过真实 UI 创建本地会话后，渲染层显示“已创建会话”，主进程/renderer 启动与基本 IPC 链路可达。未触发模型请求，因此本次不宣称模型流式 IPC 的端到端耗时；Core 10000 条 delta 与 Shell 输出负载仍由自动化基准覆盖。

## 1. 审计结论

本轮增量已将桌面 Core turn 接入两阶段执行入口：`chat:execute-turn` 只返回 accepted，主进程复用已注册的 Claude 执行函数并通过 `TurnRuntime.executeWithSource` 收敛 source terminal；取消入口也向同一 request 的现有 `signalChatCancel` 传播。桌面 create/reuse 要求 Core prepare，远程入口也通过共享 runtime 消费事实，旧事实 owner 已从生产路径移除。

随后补入 Coordinator finishing 状态：活动 source 的取消/超时进入默认 5 秒有界清理窗口，窗口内仅接受已有文本、思考、tool progress/result，屏蔽新的 tool-use、确认和 source completed；source 返回或窗口到期后统一 finalize。19 个 Coordinator/Runtime 相关测试覆盖该状态机；仍需接入真实 Shell 清理完成信号并完成跨渠道终态回归。

桌面正常发送已经具备 Coordinator-owned assistant 的生产路径：

```text
ChatView.prepareSendContext
  → chatPrepareTurn(reuse-user)
  → main.ts 共享 TurnRuntime
  → SQLite assistant/turn 占位
  → Claude payload(turnId, turnStartToken)
  → requestId → turnId
  → tool loop emitFactEvent
  → TurnCoordinator.consume/checkpoint/finalize
```

P5 owner 清理已完成：生产代码中不再保留旧 remote 生命周期协议、renderer 事实 reducer、流式落库 debounce、done 补写或公开 consume/recover 入口；显式编辑、删除、导入等合法 mutation 仍保留。剩余最终验收项是运行中的 Electron IPC/渲染性能采样，以及跨平台 CI 对 Windows 行为的证据。

## 2. Owner 表

| 生产入口/模块 | 当前 owner | 已验证证据 | 状态 |
| --- | --- | --- | --- |
| 桌面 create-user/reuse-user | `TurnRuntime`/`TurnCoordinator`（prepare 成功时） | `ChatView` 调 `chatPrepareTurn`；`appIpc` 使用共享 runtime；Coordinator storage 测试 | 阶段完成 |
| 桌面 assistant checkpoint | Coordinator storage | `checkpointTurnAtomically` expected version 测试；renderer owned fact 跳过节流 DB 写 | 阶段完成 |
| 桌面 terminal/recovery | Coordinator + SQLite | `recoverPersistedTurn` 测试覆盖 assistant/turn/receipt | 阶段完成 |
| 桌面 legacy fallback | Core prepare/TurnRuntime | create/reuse 已要求 prepare；ChatView fixture 已验证 execute-turn accepted | 已删除 |
| Claude/tool loop text/thinking | tool loop → `emitFactEvent` | model event source、tool loop 测试；旧事实事件扫描为空 | 已完成 |
| Claude/tool loop tool-use/progress/result | Coordinator event | reducer/projection/工具回归；旧 legacy owner 扫描为空 | 已完成 |
| 微信 stream | 应用级 `turnProjectionService` | remote router/adapter 回归；旧 bridge、debounce、补写扫描为空 | 已完成 |
| 飞书 stream | 应用级 `turnProjectionService` | remote router/adapter 回归；旧 bridge、debounce、补写扫描为空 | 已完成 |
| queue enqueue | SQLite receipt + queued message | `enqueueQueuedUserMessage`、fingerprint、唯一约束测试 | 阶段完成 |
| queue claim | SQLite atomic claim | `claimQueuedTurnAtomically` 测试 | 阶段完成 |
| queue recovery | SQLite recovered receipt/turn | `recoverPersistedTurn` 测试 | 阶段完成 |

## 3. 已执行验证

最近阶段性验证：

```text
Renderer ChatView/runner tests       12/12 passed
TurnRuntime/Claude handler tests      4/4 passed
tool loop/model event tests           6/6 passed
queue/database tests                 35/35 passed（分组执行）
Electron typecheck                    passed
Renderer/shared typecheck             passed
git diff --check                      passed
```

本轮集中回归实际结果：Core/数据库/Claude/远程适配器等测试通过；历史裁剪与 Claude handler 测试通过；ChatView auto-create 7 个测试全部通过；Electron 与 Renderer/shared 类型门禁均通过，`git diff --check` 通过。旧 renderer owner 清理后，全量 Vitest 为 502 个测试文件，其中 496 个测试文件、3021 个测试通过；20 个失败均因当前环境禁止监听 `127.0.0.1`（`listen EPERM`）而产生超时/连带错误。授权本机构建下 `npm run build` 完整通过。

最新全量 Vitest：502 个测试文件中 496 个通过，3024/3044 个测试通过；20 个失败全部来自 6 个需要监听 `127.0.0.1` 的 MCP/浏览器测试，原始错误为 `listen EPERM: operation not permitted 127.0.0.1`，并伴随 5 秒超时。该环境限制下无法取得这些 loopback 场景的有效业务验证，不能将全量套件标记为通过。

首次受限环境执行 `npm run build` 曾在 `i18n:generate-types` 阶段因 `tsx` 创建临时 IPC pipe 被环境拒绝（`listen EPERM ... /tmp/tsx-*/...pipe`）中止；该阻断已通过授权的本地构建复核解除。

> 后续在允许本地 loopback/Unix pipe 的权限下复核：`npm run build` 已完整通过；新增性能基准后全量 Vitest 502/502 个测试文件、3042/3042 个测试全部通过。前述环境阻断已解除；IPC/渲染端真实耗时仍需 Electron 运行时采样。

后续增量已补入事件游标：`ModelEventSource` 为事件分配单调 `eventSeq`，`TurnRuntime` 为仍未带序号的 legacy source 事件补序号，Coordinator 对重复/倒退事件幂等忽略、对序号缺口拒绝继续消费；queued turn claim 同时拒绝同一 session 的活动 turn。增量测试及类型门禁通过。

本轮又在 `prepareTurnAtomically` 与 queued claim 事务中固化 `context_boundary_sequence`：取 assistant 插入前的 session 最大 sequence，空 session 使用 `-1`；新增数据库测试覆盖该高水位不会随后续消息漂移。

TurnIntent 的 `create-user.input` 现已纳入 `ChatImageAttachment[]`，Coordinator 原子 prepare 会将附件引用随 user message 持久化；新增测试覆盖附件不会在 Core 边界丢失。

远程 renderer bridge 已删除事实 reducer、流式 DB debounce 和终态 `chatPatchMessage`；微信/飞书现在只在 remote start/done 生命周期点重新读取消息页，事实写入由主进程 TurnRuntime 完成。两侧类型门禁通过。

Coordinator prepare 现在校验 `excludeMessageIds` 的 session 归属，并拒绝排除 reuse-user 的 required user；对应跨 session / required user 测试通过。

普通 create-user prepare 也已增加单 session 活动 turn 互斥：Coordinator 做快速拒绝，SQLite `prepareTurnAtomically` 在事务内再次检查 `prepared` / `executing` / `waiting-confirm`，避免并发 prepare 竞态。

删除了 renderer 可调用的 `chat:consume-turn-event` 与 `chat:recover-turns` IPC；事实消费和启动 recovery 现在只保留主进程 runtime / app 启动路径，preload 与 shared API 不再暴露这两个入口。

普通桌面 create-user 已接入 Core prepare：`prepareSendContext` 生产路径调用 `chatPrepareTurn(create-user)`，使用 Core 返回的 user/assistant 和持久化 sequence；renderer 仅建立展示 overlay。缺少新 API 的旧宿主才回退 legacy append。全量回归验证通过。

`TurnRuntime.bindRequest` 现在校验 transport requestId 必须与已 prepare turn 的 requestId 完全一致；未知 turn 或跨请求绑定会拒绝，避免 renderer 侧借用其他 turn 的执行凭据。

`TurnRuntime` 新增可退订的多 projection listener；只有 Coordinator 事实版本实际前进时才广播 snapshot，重复/倒退事件不会产生重复 projection。

已将 projection 接入应用边界：main runtime 通过 `chat:turn-projection` 广播完整 snapshot，preload 提供订阅，App 初始化 `turnProjectionService` 并按 turn version 过滤后更新展示层。对应版本单调测试通过。

新增 `chatListActiveTurns` Core/runtime/API 查询面，按 session 可选过滤，仅返回内存中的非 terminal turn，为页面重连和恢复校准提供统一入口。

`turnProjectionService` 启动时先调用 `chatListActiveTurns` 校准已有 snapshot，再订阅增量 projection；统一按 turn version 去重，覆盖订阅建立前的事件窗口。

这些验证证明的是局部行为和类型契约，不能替代完整生产链路验收。

## 4. 最终验收门槛

### P5 清理

- 删除桌面/remote 的事实 reducer、done 补写和 legacy `chatPatchMessage` 兼容层（已完成）。
- 完成 `rg` owner 审计，保留编辑、删除、导入等合法 mutation。
- 更新方案状态和需求状态（方案状态已更新；需求文档保留为前置需求说明，不改写为实施报告）。

### 全量证据

- Q1–Q9：排队因果、幂等、迁移、恢复、删除、重复事件。
- Shell cancel/abort race/5 秒清理预算回归。
- 长文本和大量 rawDelta 的 IPC/渲染耗时及 checkpoint 次数（Core/Shell 单测已覆盖；真实 Electron 端采样待解锁桌面）。
- Electron build 与全量 Vitest；记录已有 jsdom canvas 环境噪声及真实失败。
## 本机防回归扫描

运行 `npm run check:message-fact-ownership`，检查 preload/shared API 未重新暴露已删除的 legacy Claude
listener，并检查 Claude source/tool loop 未绕过 Core event sink 向 renderer 发送事实事件。

2026-09-08 复核：精确扫描 `src/` 与 `electron/` 后，生产路径中的旧事实 channel 仅剩
`toolChatLoop.sendLegacyFact` 兼容发送函数及其调用点；没有发现 `safeWebContentsSend` 绕过该门控直接发送事实事件，
也没有发现旧 `chat:*` mutation 或旧 Claude listener API 在生产 preload/shared API 中重新暴露。
当前已增加显式 `legacyFactCompatibility` 边界，Claude 的 Core-owned production handler 传入 `false`；
无 Core sink 的迁移/测试入口仍使用默认兼容。该兼容 sender 的最终删除仍需等待旧入口边界验收，不能据此提前宣称 P5 完成。

后续复核：上述 legacy sender 与兼容参数已删除；tool loop 的事实事件只进入 Core sink，保留的
`claude-chat-tools-activity` 仅是非事实 UI 通知。owner scan 现额外禁止 WeChat/Feishu remote router
直接调用 `appendMessage`/`updateMessageContent`，并持续禁止旧 Claude listener、旧 chat mutation 和事实型
`safeWebContentsSend`。
