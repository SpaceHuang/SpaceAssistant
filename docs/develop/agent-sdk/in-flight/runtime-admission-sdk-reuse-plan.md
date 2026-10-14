# 第三批计划：准入补齐、SDK 复用面与横切收尾（偏差 23、17 – 20；15、13、14 + 24）

> 定位：本文是**实施计划**，把 `docs/develop/architect/product-architecture-design.html`（下称「基线」，`§N` 指其小节）§12 偏差清单中**两期关键路径收口后剩余的全部条目**落成可分阶段交付、可独立验收的工程排期：
> - **解锁线 B**：偏差 23（Runtime 准入补齐）——前置 1、2、9 由第一批 + 第二批解除（**v1.1 复测**：第二批已随 merge `5bb10766` 合入 main，受理端口 / 排水器 / `turnRuntime.listActive` 均在主线，见 §1「接入点依赖」）；
> - **主线 A**：偏差 17、18、19 并行 → 20 验收（SDK 复用面）——前置 1、2 由第一批解除，是「调用契约路径的第二张脸」，边际成本只剩基线 §13 的 P5；
> - **并行线 S**：偏差 15（user lane 宽严档位收口）、13（i18n 双机制）、14 + 24（保留语义归位）——无前置、不阻塞任何人。
>
> 上游（方向共识）：`architect/product-architecture-design.html`；`architect/agent-core-roadmap.md`（块 1、2 状态随第一、二批更新）。
> 左右邻：`agent-core-contract-path-refactor-plan.md`（第一批，已实施，其 §11 复核记录是本文 §1 的起点）；`driver-authority-refactor-plan.md`（第二批，本文的**前置**——偏差 23 的接线点 `chat:submit-outbound` 受理端口与主进程排水器由其 Phase 1 交付；**v1.1 复测：已随 merge `5bb10766` 合入 main**）。
> 状态：**待评审（v1.1，已处置评审 B1 / B2 与 N1 – N3）** ｜ 基线：第二批合入主线后的 main HEAD `5bb10766`（本文全部行号为该基线快照，开工必须复测）｜ 编制：2026-09-19 ｜ 修订：v1.1 ｜ 预估总量：15 – 25 人日（三线并行，关键路径为 A 线约 9 – 14 人日）
> 证据约定：与基线 §10 相同——行号是快照，会随代码演进失效；每条证据以 `rg -n '<符号>' <文件>` 复现，行号只作辅助。**每阶段开工必须重跑证据命令。**
> 证据纪律（v1.1 新增，评审 B1）：**凡证据命令出现「文件 / 路径不存在」级失败，即判定该条证据并非从声明快照实测——不止修正该行，必须触发整表复核**（落 P0 第 1 条）。

### 修订记录

| 版本 | 依据 | 处置 |
| --- | --- | --- |
| v1.0 | 编制（2026-09-19），基线 `3829424b` | 初版 |
| v1.1 | `docs/review/runtime-admission-sdk-reuse-plan-review.md`（评审时点 main `21431584`） | **B1**：修正两处引用路径，并按 v1.1 基线实测重写 §1 相关证据与 §4 A2 改动 / 验收命令；新增「路径不存在即整表复核」纪律。**B2**：复测后第二批已合入 main（merge `5bb10766`，含 Phase 1a / 1b / 1c / 2 / 3a–3c / 4 / 5），§0 / §1 表述与实测对齐，B1 的 0b 接线前置解除，门禁取「以 `5bb10766` 为前置基线」。**N1**：A3 验收命令改为 `npm query .workspace`。**N2**：B1 施加点口径统一为「四处发起入口（三处入口 + 一处嵌套）」，排水器不单列。**N3**：清理 §1 表格残留 HTML 标签。 |

> v1.1 说明：评审认定 v1.0 存在「引用文件在声明快照上不存在」级错误，说明部分证据并非从声明快照实测。本次修订不止于两行修正——凡 v1.1 触及的条目一律按 `5bb10766` 快照实测重写（表格中标「v1.1 实测」），其余条目以 P0 全表复测销号为准。另：B1 的路径修正与评审建议有一处差异，见 §4 A2 第 1 条括注（被引用文件是 `electron/mcp/mcpToolExecutor.ts`，`electron/mcp/semaphore.ts` 只是类定义所在文件）。

---

## 0. 结论与定位

**一句话**：第一批（调用契约路径）已交付、第二批（驱动权路径）**已合入主线**（merge `5bb10766`）后，24 条偏差的**全部关键路径前置清空**——剩下的是一条带业务 deadline 的解锁线（23 准入）、一条对外部复用者成立的主线（17 – 20 SDK 面）、一组纯收尾的并行小项（15、13、14 + 24）；本批完成后偏差清单整表闭环，下一批的议题从「修偏差」转为「建能力」（定时 / 事件驱动源落地、通用 SubAgent 派生、设置页 reasoning 档位选择器——均不在本文范围，见 §10）。

**范围内**：

| 线 | 偏差 | 内容一句话 | 前置 |
| --- | --- | --- | --- |
| B | 23 | Runtime 准入：并发 / 速率 / 配额、按调用施加、四类驱动源一致、渲染端不能绕过 | 1、2、9（第二批 Phase 1，已随 `5bb10766` 合入主线） |
| A | 17 | 契约里消掉函数与句柄：端口一律接口，物理边界上移 | 1、2（已解除） |
| A | 18 | 消掉四处模块级可变状态：状态随 runtime 实例走 | 1、2（已解除） |
| A | 19 | 包边界与依赖护栏：workspaces、exports、lint、CI 断言 | 1、2（已解除） |
| A | 20 | 验收闭环：`createAgentRuntime(deps)` 后不启动 Electron 跑完一个回合 | 17、18、19 |
| S | 15 | user lane 仍留 strict / loose 宽严档位，「档位只调范围不调宽严」收尾 | 3（第一批已解除） |
| S | 13 | i18n 双机制收敛：主进程只产出「键 + 参数」+ 注入 translate 端口 | — |
| S | 14 + 24 | 日志（14）与事件台账（24）的保留期 / 轮转 / 清理统一归位 Storage | — |

**范围外**（见 §10）：定时 / 事件驱动源业务（23 是它的直接前置，但触发源编排本身属 Driver 业务，基线图 D 标「待建」，独立立项）；通用 SubAgent 派生业务（16 已交付裁剪**机制**，派生业务属 roadmap 块 3）；设置页 reasoning 档位选择器（偏差 6 复核时显式例外，随 Settings / Config 组件独立排期）；SDK 的 B / C 形态（独立服务、托管子进程——基线 §13 已拍板同进程库，升级信号未出现）。

**四条关键判断**：

1. **23 排在本批、且优先于 SDK 组**，是前置（等第二批 Phase 1 交付统一调用入口）与业务节奏（基线 §7：「没有它，管家 Agent 加定时与事件源一上线就会爆」——23 完成前，图 D 标「待建」的两个驱动源不应扩容上线）共同决定的。**v1.1 复测**：第二批 Phase 1 已合入 main（merge `5bb10766`），统一调用入口与排水器均在主线，0a / 0b 之间不再有外部等待；0a 仍先行的理由是解耦与回退缓冲（风险 #1），不是等前置。
2. **SDK 组的账已经付过大半**：基线 §13 估算 P1 – P4 合计 10 – 17 人日，随第一批落地；本批只剩 P5（包边界 + 护栏 + `createAgentRuntime` + 验收闭环）与 18 的四处模块级状态清理，合计约 9 – 14 人日。这不是新开战线，是契约路径的收尾。
3. **14 与 24 合并为一个工作项**（对基线 §12 原切分的唯一调整）：两者本质是同一件事——日志（14）与事件台账（24）的保留期 / 轮转 / 清理都没有归到 Storage，且 24 还要把 `main.ts` 硬编码的上限参数从 Driver 手里拿走。分开做会碰同一批 Storage 代码两次；合并后一次建立「保留语义归 Storage」的统一范式。
4. **偏差 17 的剩余面以开工复测为准**：基线 2026-09-19 复核时其证据位指向旧扁平入口 `RunToolChatSessionArgs` 的闭包参数；第一批 P1 已把签名改为 `AgentInvocation + AgentHostPorts` 且「端口一律接口」，该证据可能已部分失效。A1 的实际改造面以 §1 复测结果销号，**不得按本文件的预估直接排产**。

---

## 1. 路径与现状（快照已按评审修订：基线 HEAD `5bb10766`，开工必须复测）

| 偏差 | 基线状态 | 现状证据（命令可复现，开工重跑；标「v1.1 实测」者为按基线 `5bb10766` 的复测结果） | 本计划认领 |
| --- | --- | --- | --- |
| 23 | 未解决（管家计划显式例外） | `rg -n -e admission -e rateLimit -e quota src/shared electron --glob '!*.test.ts'` → 命中全在浏览器域与 IM 入口，无一处拦在调用入口上；唯一现成物：`electron/butler/butlerAdmission.ts`（并发 = 1 + 每小时上限，消费点 `electron/butler/butlerInvoker.ts:112`，仅拦 `butlerInvoker`）。**v1.1 实测**：第二批已提供统一受理入口（`electron/outbound/outboundAcceptor.ts:202` / `:379`、`electron/ipc/agentProtocolIpc.ts:532`），准入可直接挂在发起前 | B1 |
| 17 | 未解决（证据已漂移，v1.1 实测） | v1.0 引用的 `getApiKey` 已不存在（更名为 `resolveApiKey`）；**v1.1 实测**契约内仍有函数字面量：`rg -n -e resolveWorkDir -e resolveApiKey -e getBrowserDetectContext -e turnBoundary src/shared/agent/invocation.ts` → `:166` / `:172` / `:275` / `:280`；`AgentHostPorts` 接口自 `:250` 起（形态与改造面以 P0 复测销号为准） | A1 |
| 18 | 未解决 | **builtin executors registry**：`rg -n -e "const registry" -e TypedToolRegistry electron/tools/builtinExecutors.ts` → `:1303`（v1.1 实测；v1.0 的 `builtinExecutors` 符号与 `:1300` 均不准，消费口 `getToolExecutor` `:1330` / `getRegisteredTool` `:1334`）；**confirmation audit**：`rg -n "let singleton" electron/confirmation/audit.ts` → `:11`；**MCP semaphore 的模块级实例在 `electron/mcp/mcpToolExecutor.ts`**（`const globalSemaphore` `:31`、`const perServerSemaphores` `:41`；类定义 `electron/mcp/semaphore.ts:4`）——**v1.0 误写为 `electron/tools/mcp/mcpToolExecutor.ts`（该目录不存在），评审 B1**；**confirmId 空间**：`rg -n globalConfirmIds electron/remote/confirmId.ts` → `:6`；两个注册入口实际落 `electron/chatCancelRegistry.ts` / `electron/toolRevocationRegistry.ts` | A2 |
| 19 | 未解决（规模证据已漂移，v1.1 实测） | **v1.1 实测**：`electron/toolChatLoop.ts` 已无 `from 'electron'` 直接 import（0 命中；`^import ` 共 117 条），v1.0 的「368 个本地模块 / 26 个直接 import」为旧快照；`package.json` 仍无 workspaces；闭包规模与「SDK 入口展开可达 electron 模块数」以 P0 复测销号为准，CI 断言仍缺 | A3 |
| 20 | 未解决 | 全仓无「非 Electron 环境跑完一个回合」的 SDK 级验收；`npm run probe:sqlite` 仍必须在完整 Electron 主进程里跑。第一批已交付预演：`electron/toolChatLoop.inMemoryPorts.test.ts`（内存端口完整回合，但仍经 electron 项目的模块闭包） | A4 |
| 15 | 部分解决（20260917） | `rg -n -e strict -e loose src/shared/policy/policyPackages.ts` → user lane 仍按 `packages[lane]` 整体变换宽严；**v1.1 实测**：档位语义定义 `:6-7`、transforms `:72-80`、`availablePackages` `:85` / `:91` / `:97`（v1.0 的 `:139-142` guard 行号已漂移，以复测为准） | S1 |
| 13 | 未解决 | `src/shared/menuLabels.ts`（1067 B 手写字典，仍是与渲染端 i18next 并行的第二套机制，未走 translate 端口）；**v1.1 实测**消费方 `electron/menu.ts:3`（`getMenuLabels`，托盘 / 菜单）；盘点命令 `rg -n menuLabels src/shared electron --glob '!*.test.*'`（字典文件内不一定含该字面串，以消费方命中为准） | S2 |
| 14 | 未解决 | **路径修正（评审 B1）**：`rg -n -e retention -e rotate -e prune electron/agentLogger/agentLogPaths.ts electron/agentLogger/` → 0 行（日志只增不减）；`electron/agentLogger/agentLogPaths.ts:15` / `:25`（v1.1 实测一致：`:15` 开发态目录、`:25` 发布态 `.agent/logs`）；v1.0 误写为 `electron/utils/agentLogPaths.ts`（该路径不存在） | S3 |
| 24 | 未解决 | `rg -n enforceSessionEventRetention electron/sessionEvents.ts`（**v1.1 实测** `:635` / `:636` / `:639`；v1.0 的 `:622` / `:626` 已漂移——与事件流写入同文件，§2.4 该文件归 Core）；`rg -n enforceSessionEventRetentionDetailed electron/main.ts`（**v1.1 实测** `:443`，上限硬编码 100——归 Driver；v1.0 的 `:426` 已漂移） | S3 |

**接入点依赖**（B 线，**v1.1 实测：前置已解除**）：`chat:submit-outbound` 受理端口、主进程排水器、`turnRuntime.listActive`——第二批 Phase 1 已随 merge `5bb10766` 合入 main：

```bash
git merge-base --is-ancestor 8eb9e200 main            # 成立：Phase 1b 受理端口在 main 祖先链上
rg -n submit-outbound electron                        # electron/ipc/agentProtocolIpc.ts:532、electron/preload.ts:40
rg -n createOutboundAcceptor electron                 # electron/outbound/outboundAcceptor.ts:202
rg -n listActive electron/ipc/agentProtocolIpc.ts     # :525（排水触发）/ :539 / :587
```

`deliveryHub`（第一批 P6）已注册桌面 sink；渲染端出站已收口为「只表达意图」（1c 已合入，`drainQueueForSession` 仅余注释，见 `electron/ipc/agentProtocolIpc.ts:535`）。**因此 B1 的 0a / 0b 可连续实施**；0a / 0b 解耦保留为回退缓冲（风险 #1）。

---

## 2. 目标形态

### 2.1 偏差 23：Runtime 准入（基线 §7）

**层次**（基线 §7 三层表的落位）：

```text
Invocation.limits        单次调用内上界（轮数 / 时长 / token / 调用内并发）—— Core 施加，随调用不持久（第一批已落形）
Runtime 准入             跨调用全局：并发数 / 速率 / lane 配额 —— 本批新增，按【调用】施加，四类驱动源一致
Driver 触发源编排        定时 / 事件 / 重试节奏 —— 触发归 Driver（图 D 待建项，不在本批）
```

- **准入状态在 Storage**（基线依赖纪律第 4 条：准入在 Runtime、配额状态在 Storage）：跨重启不丢；状态读写走 `runInTransaction`。
- **施加点唯一（口径统一，评审 N2）**：判定由 `invocationAssembler`（装配点，`electron/runtime/invocationAssembler.ts`）产出，发起方在调用前消费，**共四处，全部同权同准入**：
  1. **桌面发起入口** `chat:submit-outbound`（受理端口，`electron/ipc/agentProtocolIpc.ts:532`）；
  2. **远端发起入口** `runImRemoteAgent`（`electron/remote/imRemoteAgent.ts:43`）；
  3. **管家发起入口** `butlerInvoker`（`electron/butler/butlerInvoker.ts:112`）；
  4. **嵌套调用** `invokeApproval`（审批回答者，装配点 `electron/confirmation/agentChannel.ts:87`、调用 `:173`）。
  **主进程排水器不单列为第五处**：它复用桌面受理链路（`outboundAcceptor.drain` 内部经 `submitOutbound` 同源，`electron/outbound/outboundAcceptor.ts:379`），单列即重复计数。
  **同一准入，渲染端不能绕过**：渲染端出站已收口为意图（§1「接入点依赖」实测）。现有 `butlerAdmission` 收敛为该准入的 automation lane 配置数据，不再独立成机制。
- **四条硬要求**（基线 §7 原文，逐条落验收）：
  1. 准入不判定安全：只答「现在能不能跑」，不答「该不该放行」；
  2. 交互式优先于后台：优先级，不是先来先服务；
  3. 不静默丢弃：处置四选一（排队 / 延后 / 降级 / 拒绝）且由调用方声明；
  4. 可观测：排队与拒绝落审计或事件出口。
- **嵌套调用语义**（基线 §7 两行表）：
  - 审批回答者（`invokeApproval`）：优先级**继承等待方** + **有界等待**（超上界 = 「拿不到裁决」）+ 准入给同步依赖**保留位**（或让等待方让出已占位）——防 N 条互锁（自锁风险基线已点名，必须有回旋机制）；
  - SubAgent / 工具内派生：**同权排队**，被拒时把「资源不足」作为**工具结果**回灌父调用。
- **审计可区分**：`cause=unavailable`（拿不到裁决）与 `cause=agent-deny`（裁决为否）不得混计——准入拒绝永远不构成安全结论。

### 2.2 SDK 复用面（基线 §13，偏差 17 – 20）

- **17**：契约只放可序列化数据与消息；端口一律接口方法（第一批 P1 已立此约束），A1 把残存的闭包 / 函数字段清出契约；绑定层适配器是唯一例外且不进契约。
- **18**：四处模块级可变状态随 runtime 实例走：`createAgentRuntime(deps)` 返回持有全部可变状态的实例（executors registry `electron/tools/builtinExecutors.ts:1303`、audit `electron/confirmation/audit.ts:11`、MCP semaphore `electron/mcp/mcpToolExecutor.ts:31` / `:41`、confirmId `electron/remote/confirmId.ts:6`，以及 `electron/chatCancelRegistry.ts` / `electron/toolRevocationRegistry.ts` 两个注册入口），一个进程可多实例并存。落位目录 `electron/runtime/` 已存在（`invocationAssembler.ts` / `profileReasoning.test.ts`），新增 `createAgentRuntime` 与之同目录。
- **19**：包边界 + `exports` + `no-restricted-paths` lint + CI 断言；SDK 包不得依赖 `electron` 与 Electron 内嵌的 `node:sqlite`（存储实现走端口注入，桌面侧适配层绑 SQLite）。
- **20**：`createAgentRuntime(deps)` 之后**不启动 Electron** 跑完「带工具调用的回合 + 一次确认 + 一次拒绝」——SDK 级验收测试入 CI，同时是本组的闭环判据。第一批的 `inMemoryPorts.test.ts` 是预演（还在 electron 模块闭包内），A4 把入口上移到包级。

### 2.3 横切收尾终态（偏差 15、13、14 + 24）

- **15**：`resolvePolicyRules` 对**全部** lane 满足「档位只调范围不调宽严」——user lane 的 strict / loose 重定义为**范围档**（哪些域需要确认），宽严由底线（`policyFloor`，第一批 P3 已交付）钉死；底线不可放宽、无远程开关、`kind === 'agent'` 禁 loose 的既有 guard 不动。
- **13**：主进程不产出文案：`menuLabels.ts` 字典退役，托盘 / 菜单 / 系统通知改产出「键 + 参数」，直接显示处经注入的 `translate(key, params)` 端口（渲染端 i18n 资源成为唯一文案源，zh-CN 为真源）。
- **14 + 24**：保留期 / 轮转 / 清理归 Storage 统一保留语义：日志按日文件带保留期与轮转；`enforceSessionEventRetention*` 移出 `sessionEvents.ts`（Core 文件）归 Storage；`electron/main.ts:443`（v1.0 快照 `:426`）的硬编码上限改由 Storage 策略持有，Driver 只触发、不持参数；上限可配、删除留痕（审计）。

---

## 3. 阶段计划总览

| 阶段 | 关闭什么 | 前置 | 预估 | 收尾提交 |
| --- | --- | --- | --- | --- |
| P0 | 证据复测 + 状态盘点表（§1 全表开工重跑并销号；**任一条报「文件 / 路径不存在」即整表复核**） | — | 0.5 人日 | `docs: 第三批证据复测基线` |
| S1 | 偏差 15：user lane 档位改范围语义 | P0 | 0.5 – 1 人日 | `refactor(policy): lane 档位只调范围` |
| S2 | 偏差 13：i18n 收敛为键 + 参数 + translate 端口 | P0 | 1 – 2 人日 | `refactor(i18n): 主进程菜单文案键化` |
| S3 | 偏差 14 + 24：保留语义归位 Storage | P0 | 1.5 – 2.5 人日 | `refactor(storage): 日志与台账保留语义归位` |
| A1 | 偏差 17：契约函数 / 句柄清零 | P0 | 1 – 2 人日 | `refactor(sdk): 契约去函数化收口` |
| A2 | 偏差 18：模块级状态 → createAgentRuntime 实例 | A1 | 3 – 5 人日 | `refactor(sdk): runtime 多实例化` |
| A3 | 偏差 19：包边界 + exports + lint + CI 断言 | A2 | 2 – 3 人日 | `build(sdk): 包边界与依赖护栏` |
| A4 | 偏差 20：纯 node 回合验收闭环 | A3 | 1 – 2 人日 | `test(sdk): 纯 node 完整回合验收` |
| B1 | 偏差 23：准入补齐 | P0（0a 立即可开工；0b 前置「第二批 Phase 1」已随 `5bb10766` 满足） | 3 – 5 人日 | `feat(runtime): 调用级准入` |
| P8 | 全量回归 + 偏差表回写（md + html） | 全部 | 0.5 – 1 人日 | `docs: 偏差表回写（第三批）` |

```text
P0 ──┬──▶ S1 ────────────────────────────────────────┐
     ├──▶ S2 ────────────────────────────────────────┤
     ├──▶ S3 ────────────────────────────────────────┤
     ├──▶ B1（0a 先行；接线待第二批 Phase 1）──────────┼──▶ P8
     └──▶ A1 ──▶ A2 ──▶ A3 ──▶ A4（关键路径）─────────┘
```

**排序理由**：A1 → A2 → A3 → A4 串行是**收敛顺序**而非形式依赖——A1 稳定契约形状后 A2 的 runtime 形态才不会翻动；A3 的护栏要锁住的是 A1 / A2 收敛后的边界（先立护栏会出现「护栏立完又被 A2 打破」的返工）；A4 是验收节点只能最后。S 线三条互不依赖、与 A / B 无文件交集，按容量穿插。B1 的 Storage 状态与端口设计（0a）不依赖第二批，接线（0b）依赖其 `chat:submit-outbound` / 排水器落地——**v1.1 复测：两者已随 merge `5bb10766` 在 main，前置解除**（0a / 0b 解耦保留为回退缓冲）。

**过程纪律**（AGENTS.md，同前两批）：每阶段收尾必须提交；开发中只跑定向测试；每阶段 `build:electron:incremental` 至多一次；全量 `npm test` / `npm run build` 只在 P8。

---

## 4. 阶段详细设计

### P0 证据复测与盘点（0.5 人日）

1. §1 表全部证据命令开工重跑，产出销号表（同第一批附录 A 范式）落本文附录，**以实测为准，不按本文件预估排产**。**纪律（v1.1 新增，评审 B1）**：任一条命令报「文件 / 路径不存在」级失败，即判定该条证据未实测，**整表复核**——单条修正不足以结案。
2. 17 号专项：扫描 `src/shared/agent/invocation.ts` 契约与 `AgentHostPorts` 接口内的全部函数字面量，区分「接口方法（合法）」与「闭包 / 匿名函数字段（待清）」。
3. 23 号专项：盘点全部「调用发起入口」（桌面 / 远端 / 管家 / 嵌套 `invokeApproval` / 工具内派生）与现有 `butlerAdmission` 消费点，产出接线清单。
4. 18 号专项：四处模块级状态 + 两个注册入口的全部消费方符号级盘点。

### S1 偏差 15 收口：user lane 档位改范围语义（0.5 – 1 人日）

**改动清单**：

1. `policyPackages.ts`：user lane 的 strict / loose 语义重定义为**范围档**——档位决定「哪些域落入确认范围」（如 shell 写 / 文件写的覆盖面），不改变任何单条规则的宽严判定；`resolvePolicyRules` 对 user lane 不再整体变换宽严，产出仍过 `validatePolicyRulesFloor`（第一批 P3 底线校验，天然挡住放宽方向的回归）。
2. 既有消费方（设置页档位选择、规则 lint 单测 `defaultRules.lint.test.ts`）语义平移：档位名与 UI 文案若需变化，仅改数据与文案键（依赖 S2 的键化成果则调整顺序，两阶段无硬依赖）。
3. `kind === 'agent'` 禁 loose、automation 禁 loose 的既有 guard（`:139-142` / `:100-113`）保持不动，补一条「全 lane 无宽严变换」的结构断言测试。

**验收**：`rg -n 'strict\|loose' src/shared/policy/policyPackages.ts` 命中处均不再表示宽严档；「底线之上任意档位组合，allow 判定集合相对 locked 底线不放宽」的属性测试入仓。

### S2 偏差 13 收口：i18n 键化（1 – 2 人日）

**改动清单**：

1. `translate(key, params)` 端口入契约宿主端口（`AgentHostPorts` 或装配器 deps），宿主实现委托渲染端 i18n 资源（经 IPC 或主进程加载同一份 zh-CN 真源，实现取简）。
2. `src/shared/menuLabels.ts` 字典退役：托盘 / 菜单构建改产出 `{ key, params }`，显示处经 translate 端口解析；系统通知（`deliveryHub` 桌面 sink 的通知文案）同批核对。
3. 渲染端 i18n 资源补齐菜单键（zh-CN 为真源），`npm run i18n:check` 收口。

**验收**：`rg -n 'menuLabels' src/shared electron --glob '!*.test.*'` → **0 行**；主进程产出的用户可见字符串不含硬编码文案（抽样断言 + 现有 i18n 检查）。

### S3 偏差 14 + 24 收口：保留语义归位 Storage（1.5 – 2.5 人日）

**改动清单**：

1. Storage 新增统一保留策略模块（名以实现为准）：策略参数（保留期、轮转阈值、上限）可配、带**显式默认**（缺配置 = 显式声明的默认，不是代码常量兜底——基线「不得为缺失的托管值静默默认」纪律）；删除动作留痕（审计事件：删了什么、多少条、依据哪条策略）。
2. 偏差 24：`enforceSessionEventRetention` / `enforceSessionEventRetentionDetailed` 移出 `sessionEvents.ts`（该文件归 Core，基线 §2.4），落 Storage 模块（该文件内现为 `:635` / `:636` / `:639`）；`electron/main.ts:443`（v1.0 快照 `:426`）的 `enforceSessionEventRetentionDetailed(workDirState, 100)` 改为 Driver 触发 Storage 执行——`100` 这类策略参数不再出现在启动流程。
3. 偏差 14：日志目录（`electron/agentLogger/agentLogPaths.ts`）增加保留期与按日轮转清理，挂接同一保留策略模块；保留期纳入会话台账同款保留语义风格。
4. 触发时机：随启动维护流程 + 写入路径节流触发（沿用现状节奏，只换归属，不改频率）。

**验收**：`rg -n 'enforceSessionEventRetention' electron/sessionEvents.ts` → **0 行**；`rg -n '100' electron/main.ts`（保留上限语境）→ 0 命中（以符号命令为准：`rg -n 'enforceSessionEventRetentionDetailed' electron/main.ts` → 0 行）；保留策略参数在 Storage 模块内可枚举、有显式默认、删除留痕测试入仓。

### A1 偏差 17：契约去函数化收口（1 – 2 人日）

**改动清单**（以 P0 复测为准）：

1. P0 扫描出的契约内函数 / 句柄字段逐个归宿主端口接口方法（第一批「端口一律接口」约束的存量清理）；绑定层适配器（本地绑定时把宿主对象塞进端口）是唯一允许的函数形态，且不出现在 `src/shared/agent/` 契约文件内。
2. 若复测发现第一批已清零：本阶段缩为「补一条契约形状 lint / 类型断言（契约文件禁函数字段类型），防退化」，并留痕偏差 17 可提前判「已解决」。

**验收**：`rg -nE '=>|\(\s*\)\s*:' src/shared/agent/invocation.ts` → 仅剩接口方法声明（白名单注释，如 `resolveApiKey()` / `getBrowserDetectContext?()`）；函数 / 句柄字段 0 行（v1.1 实测基线待清点：`:166` / `:275` / `:280`）；契约形状断言测试入仓。

### A2 偏差 18：runtime 多实例化（3 – 5 人日）

**改动清单**：

1. 新增 `createAgentRuntime(deps)`（落位 `electron/runtime/`，该目录已有 `invocationAssembler.ts`；导出面后续 A3 收进包边界）：返回 runtime 实例，持有——builtin executors registry（`electron/tools/builtinExecutors.ts:1303`）、confirmation audit（`electron/confirmation/audit.ts:11` singleton）、MCP semaphore（**`electron/mcp/mcpToolExecutor.ts:31`** `globalSemaphore` 与 **`:41`** `perServerSemaphores`；类定义 `electron/mcp/semaphore.ts:4`——**v1.0 误写为 `electron/tools/mcp/mcpToolExecutor.ts`，评审 B1，且被引用文件不是 `semaphore.ts`**）、confirmId 存储（`electron/remote/confirmId.ts:6`）、两个注册入口（`electron/chatCancelRegistry.ts` / `electron/toolRevocationRegistry.ts`）。
2. 模块级可变状态改为实例字段；原模块导出改为「接收 runtime 实例」的纯函数或随实例传递（消费方经装配器拿到实例，不经全局）。
3. 桌面宿主在 `main.ts` 创建单例 runtime（行为等价：今天本来就是一个进程一个 runtime）；注册入口的旧全局函数保留一个发布周期的兼容转发（显式 `@deprecated`，P8 时点评估删除）。
4. **回归重点**（基线 §13：成本主要在回归测试）：取消传播（cancel 注册表实例化后跨实例不可见必须显式）、审计文件写入（singleton → 实例后同进程多实例写同一审计文件的串行化）、MCP 并发闸语义、confirmId 一次性消费语义。P0 盘点表的每个消费方至少一条定向测试。

**验收**：`rg -n '^(let|const) ' electron/confirmation/audit.ts electron/remote/confirmId.ts electron/mcp/mcpToolExecutor.ts electron/tools/builtinExecutors.ts` 中残留的模块级可变状态（registry / singleton / semaphore 池 / confirmId 空间）→ 0（以 P0 销号表为准；注意 `builtinExecutors.ts` 的 registry 是 `const` 绑定 + 可变容器，只用 `let ` 口径会漏判）；新增「同进程两个 runtime 实例并存、互不串状态」测试（各跑一个回合 + 各自确认互不干扰）。

### A3 偏差 19：包边界与依赖护栏（2 – 3 人日）

**改动清单**：

1. `package.json` 引入 workspaces：`packages/agent-core`（SDK 面：契约、端口接口、runtime、Core 执行闭包）+ 宿主应用；宿主依赖迁移，`exports` 只暴露 `createAgentRuntime` 与契约类型。
2. Core 执行闭包切分（基线 §13：切开后核心内真正耦合宿主的只剩 4 文件 / `app` · `safeStorage` · `shell` 三能力）——这批依赖改走宿主端口或绑定层注入；35 – 45 文件 / 280 KB 量级的机械迁移（第一批 P4 未覆盖的宿主侧文件归此）。
3. 护栏：ESLint `no-restricted-paths`（SDK 包禁 `electron`）、CI 断言脚本（`rg -n "from 'electron'" packages/agent-core` → 0 行；`rg -n "node:sqlite" packages/agent-core` → 0 行——SQLite 走端口，桌面适配层在宿主侧绑定）、依赖闭包规模断言（从 SDK 入口展开可达 electron 模块数 = 0）。
4. **护栏随 A3 落，不提前**：A1 / A2 未收敛前立护栏必然反复打破（§3 排序理由）。

**验收**：workspaces 生效（`npm query .workspace` 列出工作区，等价物 `npm ls --workspaces`；**v1.0 写的 `npm workspaces ls` 不是 npm 子命令**，评审 N1）；CI 断言脚本入仓并在 CI 跑通；`typecheck` 双 tsconfig（SDK 包独立于 `tsconfig.electron.json`）。

### A4 偏差 20：纯 node 验收闭环（1 – 2 人日）

**改动清单**：

1. 新增 SDK 级验收测试（node 测试项目，不经 electron 闭包）：`createAgentRuntime(deps)` + 内存端口 → 跑完「带工具调用的回合 + 一次确认 + 一次拒绝」，断言审计 / 台账 / 结果四态。
2. `probe:sqlite` 的 Electron 依赖解除评估：SDK 面禁 `node:sqlite`（A3 护栏），probe 改为宿主侧脚本或以内存端口替代；若保留 SQLite 探针，落宿主适配层。
3. CI 接入：验收测试进流水线，作为 SDK 面的常驻回归。

**验收**：`npm exec vitest run <sdk 验收文件>`（node 项目）全绿；测试文件及其 import 闭包 `rg -l "electron"` → 0 文件；CI 配置含该测试。

### B1 偏差 23：调用级准入（3 – 5 人日）

**0a（先行，不依赖第二批）——Storage 状态与端口设计**：

1. Storage 保留状态表 / 键：活跃调用计数、速率窗口、lane 配额余量（跨重启不丢，`runInTransaction`）；automation lane 的配额配置数据化（吸收 `butlerAdmission` 的并发 = 1 + 每小时上限为首批配置）。
2. 准入端口与判定纯函数：`admission.check({ lane, priority, cause, declared处置 }) → { admitted } | { queued } | { deferred } | { degraded } | { rejected(cause) }`——纯函数可单测，状态读写独立注入。

**0b（接线；前置——第二批 Phase 1 的受理端口 / 排水器——已随 merge `5bb10766` 合入 main，可直接接续 0a）**：

3. 施加点：**四处同一准入**（口径统一见 §2.1，评审 N2）——桌面受理端口 `chat:submit-outbound`（`electron/ipc/agentProtocolIpc.ts:532`）、`runImRemoteAgent`（`electron/remote/imRemoteAgent.ts:43`）、`butlerInvoker`（`electron/butler/butlerInvoker.ts:112`；改走统一准入，`butlerAdmission.ts` 退役或降为配置）、`invokeApproval` 嵌套调用（`electron/confirmation/agentChannel.ts:87` 装配 / `:173` 调用）。**主进程排水器不单列为第五处**：它复用受理链路（`electron/outbound/outboundAcceptor.ts:379`），单列即重复计数（v1.0 的「五处」）。
4. 优先级与嵌套语义：交互式（桌面 / 远端 user lane）> 后台（automation）；审批回答者继承等待方优先级 + 有界等待 + 保留位；SubAgent 同权排队、拒绝作为工具结果回灌父调用。
5. 处置与审计：四选一由调用方声明；`cause=unavailable` 与 `cause=agent-deny` 分立审计；排队 / 延后 / 拒绝全部落事件出口或审计（可回答「我的定时任务为什么没跑」）。
6. 渲染端不可绕过的验证：受理端口是桌面唯一发起通道——**v1.1 实测**第二批 1c 已合入（渲染端只调 `window.api.chatSubmitOutbound`，`src/renderer/components/Chat/ChatView.tsx:498` / `:503`；`drainQueueForSession` 仅余注释 `electron/ipc/agentProtocolIpc.ts:535`），准入检查在主进程受理内；仍补一条「渲染端 API 面无绕过通道」的结构断言（preload API 面盘点），作为防退化护栏。

**验收**：准入纯函数属性测试（并发上界不被突破、速率窗口语义、配额扣减守恒、保留位防自锁——N 条并发调用各等裁决时至少一条能拿到位）；`cause` 分立审计断言；`rg -n 'butlerAdmission' electron --glob '!*.test.*'` 收敛为配置数据消费（或 0 行）；真机验收项见 §6。

---

## 5. 安全设计要点（贯穿各阶段）

1. **准入不构成安全结论**：`unavailable ≠ agent-deny`，审计 `cause` 分立是硬验收，不是注释约定（§4 B1 第 5 条）。
2. **fail-closed 不静默**：准入拒绝落审计可区分；保留策略的默认值必须显式声明（S3）；档位改范围语义后底线校验全 lane 生效（S1）。
3. **护栏是安全语义的一部分**：A3 的 lint + CI 断言锁住「SDK 包不依赖 electron / node:sqlite」——没有护栏，17 / 18 收敛完会退化回去（基线 §13 原判断）。
4. **不新增模块级可变状态**：A2 的方向性约束——本批之后任何新机制的状态随实例 / 调用走；B1 的准入状态是唯一合法的跨调用全局态，且归 Storage。
5. **兼容窗口显式化**：A2 的旧注册函数兼容转发、A3 的宿主依赖迁移，均带 `@deprecated` 与 P8 删除评估点，不留永久双轨。

---

## 6. 验收边界（开工对齐项）

**当前环境可单测验证**：S1 属性测试、S2 键化静态证据、S3 归位与留痕、A1 契约断言、A2 多实例并存、A3 护栏 CI、A4 纯 node 回合、B1 准入纯函数与审计分立。

**需真机 / 外部系统验收**（各阶段收尾人工过一遍，不阻塞提交）：

- 桌面菜单 / 托盘 / 系统通知在 zh-CN 下文案正常（S2 改动面）；
- 日志与台账轮转在长会话 / 大量事件下触发正常、磁盘不无限增长（S3）；
- 准入：桌面高优先发起可抢占排队中的管家调用；定时任务被拒后通知 / 审计可见（B1，管家定时源已上线部分）；
- SDK 验收测试在 CI 干净环境通过（A3 / A4）。

---

## 7. 风险与回退

| # | 风险 | 缓解 / 回退 |
| --- | --- | --- |
| 1 | 第二批进度不及预期，B1 接线悬空 | **v1.1 降级**：第二批已合入 main（merge `5bb10766`），前置解除；0a / 0b 两步解耦保留为回退缓冲——Storage 状态与纯函数先行，接线若遇回退仍可等受理端口；不抢第二批的改动面（渲染端发起路径归其 1c，已合入） |
| 2 | A2 触及取消 / 审计 / MCP 并发等隐性全局假设 | P0 消费方全量盘点 + 每消费方定向测试；兼容转发一个发布周期；单提交可回退 |
| 3 | workspaces 迁移破坏构建链（两条构建管线、tsconfig 三份） | A3 内先迁**一个**最小闭环（契约文件）验证管线，再切执行闭包；`build:electron:incremental` 每步必跑；最坏回退 = 保留 workspaces 声明、暂不切 exports（护栏仍可先上） |
| 4 | 17 号预估改造面失准（第一批可能已清零） | P0 复测销号，A1 缩为防退化断言即提前关闭该偏差，工时释放回 A2 |
| 5 | S1 档位语义变化引起用户可感知行为差异（原本 loose 下放行的调用开始确认） | 变化只允许发生在「超出 locked 底线的放宽档」——而底线校验（第一批 P3）本就挡了放宽；上线前跑一遍 strict / loose 两档的判定集合 diff 并留档 |
| 6 | S2 主进程读 i18n 资源的方式（IPC vs 直接加载）带来启动时序问题 | 实现取简优先（主进程直接加载 zh-CN 真源），失败时菜单退化显示键名并落审计，不阻塞启动 |
| 7 | 仓库并行演进（前两批摸排期间均发生 HEAD 前进） | 每阶段开工重跑 §1 证据命令；新耦合出现先入销号表再动工 |

---

## 8. 偏差表回写预告（P8 产出）

| 偏差 | 预期回写状态 | 依据 |
| --- | --- | --- |
| 15 | **已解决** | user lane 档位范围化 + 全 lane 无宽严变换结构断言 + 底线校验属性测试 |
| 13 | **已解决** | `rg -n 'menuLabels' …` → 0 行；translate 端口入契约；i18n:check 通过 |
| 14 | **已解决** | 日志保留期 / 轮转入 Storage 策略模块；`rg` 证据归零 |
| 24 | **已解决** | `enforceSessionEventRetention*` 移出 Core 文件；`main.ts` 硬编码上限清除；删除留痕测试 |
| 17 | **已解决** | 契约函数字段 0 行 + 形状断言防退化 |
| 18 | **已解决** | 四处模块级状态归实例 + 多实例并存测试 |
| 19 | **已解决** | workspaces + exports + lint + CI 断言入仓且流水线通过 |
| 20 | **已解决** | 纯 node 完整回合验收测试入 CI |
| 23 | **已解决** | 四处发起入口（三入口 + 一处嵌套，口径见 §2.1）统一准入 + 四维处置 + cause 分立审计 + 渲染端无绕过断言；`butlerAdmission` 退役。**回写依据已具备**：第二批 1b / 1c 已合入 main（`5bb10766`），受理端口与渲染端收口在主线可验证 |

本批完成后 §12 偏差清单 **24 条全部闭环**——基线文档的「下一批议题」应从偏差面切到能力面（定时 / 事件驱动源、SubAgent 派生业务、reasoning 档位设置面），回写时建议在 §12 追加一行收束说明。

---

## 9. 与既有文档的关系 / 债务认领

| 文档 | 关系 |
| --- | --- |
| `architect/product-architecture-design.html` | 母本；23 的设计全部引自 §7（四条硬要求、嵌套语义、cause 分立、自锁回旋），17 – 20 引自 §12 清单与 §13（P5 边际成本、三条硬约束、同进程库拍板），13 / 14 / 24 / 15 引自 §12 与 §3 横切表 |
| `driver-authority-refactor-plan.md`（第二批） | **前置（v1.1 已满足）**：B1 接线依赖其 Phase 1（受理端口 + 排水器）——已随 merge `5bb10766` 合入 main；A 线无依赖可先行。其 Phase 5 架构文档回写（`4ce0cf4e`）若与本批 P8 重叠，合并为一次复核记录 |
| `agent-core-contract-path-refactor-plan.md`（第一批） | 认领其遗留：`inMemoryPorts.test.ts` 是 A4 的预演基座；`deliveryHub` 桌面 sink 文案键化随 S2；第一批 P1「端口一律接口」约束的存量清理归 A1 |
| `butler-agent-shortest-path-plan.md` §11 | 认领债务移交清单中偏差 23 的整项关闭（`butlerAdmission` 显式例外 → 统一准入） |
| `approval-agent-shortest-path-plan.md` §8 | B1 的审批嵌套语义（继承优先级 + 有界等待）承接其 `invokeApproval` 装配点现状 |
| `architect/agent-sdk-shape-decision.md` §6 | 三条硬约束的第三条（多实例 / `instanceId`）在本批 A2 取费兑现 |

---

## 10. 明确不做（非目标）

1. **不做定时 / 事件驱动源业务**：23 是它的前置，不是它本身；触发时刻编排（调度、重试节奏）归 Driver，图 D「待建」两项在 B1 关闭后独立立项。
2. **不做通用 SubAgent 派生业务**：16 的 `profile.tools.trim` 机制已交付，派生执行域、结果回灌业务属 roadmap 块 3。
3. **不做设置页 reasoning 档位选择器**：偏差 6 复核显式例外，随 Settings / Config 组件独立排期（若 S2 的键化先落，其文案键可顺手备好，但不做组件）。
4. **不做 SDK 的 B / C 形态**（独立服务、托管子进程）：基线 §13 已拍板同进程库，升级信号（不可信宿主 / 多语言 / 进程层底线）一个未出现。
5. **不动会话列表差量化**：偏差 11 的验收口径是「通知驱动重取 + 真相只从 Storage 取」（第二批 Phase 3），列表差量化属后续可选深化。
6. **不重写工具框架、不动存储 schema 主干**（S3 的保留策略若需新表走 v14+ 迁移线，不建旁路存储）；不把事件出口总线化；不引入 Run 层。
