# 后台管家 Agent 最短路径落地开发计划

> 状态：待评审（v3，按偏差整项推进；v3 已吸收评审 `docs/review/butler-agent-shortest-path-plan-review.md` 的 B1–B3 / N1–N3）｜ 基线：main `3e902766`（v0.1.8）｜ 摸排日期：2026-09-16（行号为摸排快照，开工时以 `rg` 重新盘点为准）
> 上游文档：`docs/develop/architect/product-architecture-design.md`（理想态与 23 条偏差）、`docs/develop/architect/agent-core-roadmap.md`（工作块划分，本文是其**块 4《无窗口运行与后台管家 Agent》的最短路径版**）
> 一句话：从偏差清单里**选定四个偏差项（1、21、22、7），每个整项做掉、干净关闭**（收尾即标「已解决」，不留「部分解决」；偏差 8、23 是记录在案的两个显式例外，见 §1.3），然后在这四条修好的路上做纯增量的管家业务；远程指令托管已在生产运行，本计划顺带修掉它的一个存量缺陷。

---

## 0. v2 修订说明（相对 v1 的思路变化）

v1 的阶段按「最小切片」切，会在偏差表里制造一批新的「部分解决」状态（如 9、11 现在的样子）——每条都剩一半，后续任何计划引用它们时都要先弄清「剩的那半是什么、归谁、会不会被别的改动破坏」，开发计划因此难做。

v2 改为：**偏差项是选择与推进的基本单元。选定了就按偏差表「应该往哪走」的完整语义做掉，验收即证据列的复现命令翻转；不选的就完全不碰，保持原状。**

由此带来的范围变化：

| 偏差项 | v1（切片） | v2（整项） |
| --- | --- | --- |
| 1 Core 依赖驱动源 | 仅 sender 可选化，桌面不动 | **sender 全链路移除、事件出口取代、窗口存活判定删除，桌面链路一并迁移** |
| 23 Runtime 准入 | 仅 automation 并发=1 + 小时上限 | v2 曾选整项（三入口一致）；**v3 降级为不选**（`butlerAdmission` 单入口替代，见 §1.3 第 3 点与 P4） |
| 8 投递散落 | 仅指定型 + run 表送达记录 | v2 曾选整项；**v3 降级为不选**（薄分发 `deliverTaskResult` 替代，见 §1.3 第 3 点与 P5） |
| 7 / 21 / 22 | 已接近整项 | 明确整项口径（见各阶段） |

总量从 15–24 升到 **16.5–28 人日**（量级估算，误差 ±50%；v3 因 P0 新增、P2 上调、P4 / P5 下调而变化），换来的是：计划收尾时偏差表上四条（1、7、21、22）全部翻转为「已解决 YYYYMMDD」，后续计划面对的是干净事实；8 与 23 保持原状，例外依据与剩余边界记录在 §1.3 / §11。

---

## 1. 结论与定位

### 1.1 管家 Agent 的业务定义（引自 roadmap §1.3，2026-09-12 对齐）

| 托管类型 | 输入 | 流程 | 产出 |
| --- | --- | --- | --- |
| 远程任务托管 | 飞书 / 微信的简单指令 | 意图识别 → 方案 → 向输入方请求确认 → 执行 → 回复 | 回复到原输入方 |
| 自动化任务托管 | 用户配置的定时触发 | 按配置执行任务 | 落库；按配置推送到桌面 / IM，或静默落盘 |

### 1.2 现状判断

- **远程任务托管已存在且在生产运行**：飞书 / 微信 → `imInboundGuard` → 命令路由 → `imRemoteAgent` → `runToolChatSession` → IM 回复，含确认往返。但有一个存量缺陷：主窗口关闭时回合会死（§4 证据 E3）——偏差 1 整项修复后此缺陷随之消失。
- **自动化任务托管完全不存在**：无定时驱动源、无 `automation` lane 的可达路径与规则、无任务存储、无管家会话归属、无结果投递。
- **backgroundMission 不在本线上**：`docs/develop/background-mission-phase0-architecture.md` 描述的模块不在 main 工作区（其 HEAD `3f297ba` 在本仓库不存在）；roadmap §6 已判其「目标保留、方案降级为参考」，与管家业务无交集。本计划不依赖它。

### 1.3 选定与不选（偏差清单口径）

**选定并整项做掉（三项）**：

| 偏差 | 完整验收语义（= 偏差表「应该往哪走」原文） | 为什么管家需要它 |
| --- | --- | --- |
| 1 | 事件出口取代 `sender`；调用存亡只由取消 / 超时 / 错误决定 | 无窗口运行是管家的存在前提 |
| 21 | lane 由驱动源层解析后随调用传入，四类驱动源各有可达 lane；`automation` 不能只在类型里占位 | 管家调用的策略 / 审计归属 |
| 22 | 无人类应答者的驱动源不得继承桌面豁免；规则集显式写出，兜底 fail-closed | 管家无人值守，安全标准必须显式 |
| 7 | 补归属与可见性维度；内部调用不落用户会话 | 管家会话要有独立分区与过滤 |

**不选（完全不碰，不产生新债务）**：2（loadContext/persist 端口）、3（规则随调用传入）、4、5、6、8、9、10、11、13–20、23。说明五点：

1. **偏差 2 / 3 不选的连带影响**：管家调用沿用 `imRemoteAgent` 的现状模式（`appDb` 传入、门控读库解析规则）。这不是切片——是既有机制的原样使用，2 / 3 保持「未解决」原状，等块 1 收敛时一次性处理。
2. **偏差 8 从 v2 的「选定」降级为「不选」（v3 评审后修订）**：偏差 8 的完整语义（唯一投递入口、收敛存量投递点、送达记录）的受益人是后续调用方与复用面，对管家 v1 业务本身零贡献；收敛既有 IM 回复路径还有真实回归风险。与 1 / 21 / 22 不同（不做就有安全漏洞或功能不成立），8 不做管家功能完全成立。v3 记为整项推进规则的一个**显式例外**：只给管家做一个 `deliverTaskResult` 薄分发（几十行，三个目标：浮动通知 / IM / 落盘，见 P5），存量投递点不碰、偏差 8 保持「未解决」，其状态边界在 §11 债务清单描述清楚。
3. **偏差 23 同款降级（v3 评审后修订）**：准入的威胁模型是「无人值守的调用会自己堆积」——automation 是本计划唯一这样的 lane；桌面与远程都是人在环上的交互调用，今天没有跨调用堆积问题。把准入拦进 `chat:execute-turn` 与 `imRemoteAgent` 是给两条生产链路注入回归风险，去换一个当前不存在的威胁；「配额维度先落框架」则是纯架构兑现。v3 取例外：**只做 `butlerInvoker` 单入口准入（并发 = 1 + 每小时上限 + 拒绝落审计，见 P4）**，偏差 23 保持「未解决」，整项语义（三维度、三入口一致、交互式优先、嵌套准入）在 §11 移交。注意 21 / 22 与此不同：不做就有真实安全漏洞；23 的 automation 子集本身是安全机制，只是范围收窄为管家单入口。
4. **偏差 7 的整项口径说明**：偏差表原文还含「跨会话搜索只按 profile 过滤」的修全（内部调用不落用户会话、搜索排除 internal）——P3 已覆盖；「列表全表加载 → 轻量元数据两级读取」的理想态形态属于偏差 11 的视图契约面，P3 做到「列表可按谓词过滤、新增轻量查询函数」，全表加载的存量调用方迁移随 §11 偏差 11 认领。
5. **审批 Agent（块 2）不做**：automation lane 的回答者是 fail-closed 拒绝。**v1 能力边界（产品侧）**：自动化任务默认只读 / 汇报型（检查、总结、提醒、报表）；需要写文件、执行命令、发消息的任务会被策略拒绝并在结果中说明原因。这是刻意安全边界，等块 2 的审批 Agent 接入后放开。

---

## 2. v1 目标形态

### 2.1 用户视角

1. 设置弹窗新增「定时任务」Tab：新建任务（名称、触发方式、提示词、投递偏好）、启停、删除、立即运行。
2. 到点后主进程自动起一个管家会话回合：跑完落库，会话出现在会话列表的**「管家」分区**（不与日常会话混排）。
3. 结果按任务配置投递：桌面浮动通知、推送到飞书 / 微信、或只落盘；同任务新结果取代旧通知，过期通知不再弹出。
4. 应用重启后：错过的触发只补最近一次，更早的标记 skipped（有界补投，防风暴）。
5. 远程指令托管行为不变；所有链路（含桌面）窗口关闭后回合照常跑完、落盘，重开窗口可回看。
   **运行前提：托盘常驻启用**（见 §6 第 0 条）——未启用托盘时，`window-all-closed` 会 `app.quit()`（`main.ts:686-689`），关窗即进程退出，进行中回合随退出终止；该前提对管家定时触发（P6）同样成立。

### 2.2 架构落点（对照产品架构设计六块）

```text
定时驱动源(Driver,新增: butler/taskScheduler)
  → Runtime 准入(butlerAdmission: 并发=1 + 小时上限, 仅 automation 单入口) → 装配(butler/butlerInvoker)
  → Core(runToolChatSession, 无sender, lane由调用方显式传入并穿透全链路)
      工具调用 → Safety 门控(automation规则: 只读allow → 其余confirm(无回答者→拒绝))
  → 落盘(Storage: 管家会话 ownership=automation/visibility=section + task_runs)
  → 投递(deliverTaskResult 薄分发: 浮动通知/IM/落盘, 偏差8不在此关闭)
```

不新增链路形态：管家调用复用现有 `runToolChatSession` + `turnRuntime` 协调 + 现有安全门控与审计。

---

## 3. 阶段计划总览

每阶段独立交付、独立验收、收尾提交（遵守 AGENTS.md 测试纪律：开发过程只跑定向测试；全量 `npm test` 仅在阶段收尾验证时跑；`build:electron:incremental` 每阶段至多一次）。**每阶段收尾时，对应偏差项按架构文档 §12 复核约定改「状态」列并补复核记录，不删行。**

| 阶段 | 内容 | 关闭的偏差 | 依赖 | 预估（人日） |
| --- | --- | --- | --- | --- |
| P0 | 托盘常驻前提声明与保活策略拍板 | —（前置条件，评审 B3） | — | 0.5 – 1 |
| P1 | 事件出口取代 sender：无窗口运行全链路解绑 | **1** | P0 | 3 – 5 |
| P2 | automation lane 可达、穿透与显式规则 | **21、22** | P1 | 3 – 5 |
| P3 | 会话归属与可见性 | **7** | — | 2 – 3 |
| P4 | automation 单入口准入 + 管家执行链（含任务表、手动触发） | —（偏差 23 不关闭，见 §1.3） | P1 – P3 | 3 – 5 |
| P5 | 管家投递薄分发（偏差 8 不关闭，见 §1.3） | — | P4 | 1 – 2 |
| P6 | 定时调度器 + 任务管理 UI | —（纯增量业务） | P4、P5、P0 | 3 – 5 |
| P7 | 全量回归 + 偏差表集中回写 | — | P1 – P6 | 1 – 2 |

合计 **16.5 – 28 人日**（P2 因 B1 穿透面 + B2 规则收窄从 2–3 上调至 3–5；P0 为新增前置；P4 / P5 因偏差 23、8 降级分别下调）。顺序说明：P0 是 P1 验收与 P6 运行的前提，先行拍板；P1 → P2 是调用契约的必要前缀；P3 与 P1/P2 无依赖可并行；P4 把 automation 准入与管家执行链合体（准入只拦 butlerInvoker 一个入口，桌面与远程零改动）；P6 是纯增量业务开发，不欠任何架构债。

---

## 4. 现状基线与证据（摸排快照，行号会漂移，命令可复现）

| # | 事实 | 证据 |
| --- | --- | --- |
| E1 | `sender: WebContents` 是 `RunToolChatSessionArgs` 必填项 | `electron/toolChatLoop.ts:405` |
| E2 | 循环每轮检查窗口存活，销毁即以 `'Window closed'` 失败 | `electron/toolChatLoop.ts:752-754` |
| E3 | 远程链路无窗口时用 `noopSender = { send: () => undefined }` 顶替，**没有 `isDestroyed` 方法**——`isWebContentsAlive`（`electron/safeWebContentsSend.ts:5`，调用 `sender.isDestroyed()`）会抛 TypeError，回合以异常告终。即：远程托管今天事实上依赖主窗口存活 | `electron/remote/imRemoteAgent.ts:74-75` |
| E4 | lane 从 `remoteContext.source` 推导，仅 `'feishu' \| 'wechat'`，否则 `'desktop'`；`automation` 在 lane 联合类型里不存在 | `electron/toolChatLoop.ts:486-491`、`electron/confirmation/channels.ts:106-109` |
| E5 | `automation` 只在套餐档位键里出现（`policyPackages.ts:20`、`:33`），`defaultRules.ts` 没有任何以它为 lane 的规则 → 落通用兜底 | `rg -n 'automation' src/shared/policy/` 仅两处档位配置 |
| E6 | 门控自己读库解析生效规则 | `electron/confirmation/toolCallGate.ts:185`（`loadEffectivePolicyRules(args.appDb, lane)`） |
| E7 | `channelFor` 缺 IM 通道实例时兜底 `RejectingChannel`（fail-closed 通道已存在，可复用为 automation 默认回答者） | `electron/confirmation/channels.ts:128-131` |
| E8 | sessions 表无归属 / 可见性列；`listSessions` 全表查询 | `electron/database/schema.ts:17-31`、`electron/database/operations.ts:119-121` |
| E9 | 无全局调用准入：已有近亲是 `remoteAgentRegistry`（按 originSessionId 租约 + 全局 maxParallel，仅覆盖远程）与 `remoteTaskBudget`（单任务损害预算）；桌面 `chat:execute-turn` 入口无任何并发 / 速率约束 | `electron/remote/remoteAgentRegistry.ts:37-60`、`electron/appIpc.ts:995` |
| E10 | 无定时设施（无 cron 依赖、无调度器） | `package.json` 无 cron 类依赖 |
| E11 | 共享装配件已存在：`resolveTrustedTurnExecutionConfig`（受信模型 / 凭据解析，无凭据快照）；turn 协调走 `turnRuntime` + `turnExecutionAdapter` | `electron/turnExecutionConfig.ts:16`、`electron/remote/turnExecutionAdapter.ts` |
| E12 | 投递原料已存在：浮动通知 `FloatingNotificationManager`、IM 出站 `sendImOutbound` / `buildSimpleOutboundText`、IM 会话解析 `resolveImSession` | `electron/floatingNotificationManager.ts:45`、`electron/remote/imRemoteOutbound.ts:18,53`、`electron/remote/imSessionResolver.ts:21` |
| E13 | 内置工具清单（automation 规则矩阵的素材） | `src/shared/builtinToolDefinitions.ts:8-286`：read_file、edit_file、write_file、list_directory、grep、run_script、run_shell、run_lark_cli、read_feishu_attachment、browser、browser_detect、wechat_reply、wechat_send、list_work_dirs、switch_work_dir、switch_session、history.read、skills.read |
| E14 | sender 在 `toolChatLoop.ts` 内的使用点清单（P1 的改造面）：参数定义 `:405`、`failToolLoopWithLastUsage` 签名 `:467`、解构 `:523`、存活判定 `:752`、tools-activity 直发 `:955`、failToolLoop 调用 `:1009/:1022/:1079/:1097/:1175`、标题建议 `:1143`（`scheduleSessionTitleSuggestion({ sender, … })`，其内部 `sessionTitleSuggest.ts:178` 是**裸 `sender.send`**，未走 `safeWebContentsSend`，窗口销毁后抛异常被静默吞掉、标题事件丢失——出口化时一并处理；`scheduleSessionTitleOpenBackfillIfNeeded` 同样收 sender）、文件树通知 `:2298/:2300`；调用方：桌面 `claudeStreamHandlers.ts:389`、远程 `imRemoteAgent.ts:129` | `rg -n 'sender' electron/toolChatLoop.ts` |
| E15 | 事件出口已具雏形：`emitFactEvent`（UI 事实统一迁移端口）与 `emitSessionEvent`（台账写入口）已是 `RunToolChatSessionArgs` 的可选闭包参数——P1 的「出口化」是把 sender 的直发点收敛进这两个出口、并让出口必填化，不是从零发明 | `electron/toolChatLoop.ts:441-443` |
| E16 | **lane 在 Core 内部的推导点（评审 B1 盘点）**，automation 调用 `remoteContext === undefined` 时全部会落到 `'desktop'`：① `toolCallGate.ts:107-117` 的 `laneOf`（门控读 desktop 规则与 decision cache）；② `toolChatLoop.ts:626-641` 的 `exposureLane`（exposure 规则加载）与同段 `mcpSnapshot`（`remoteContext: Boolean(remoteContext)` 判定——automation 为 false，MCP 工具**会**注入）；③ `toolChatLoop.ts:1614-1618` 的 `confirmLane`（不穿透则 `channelFor` 永远收不到 automation）；④ `toolChatLoop.ts:1298/:1512/:1918/:1946` 等审计事件内联三元推导 | `rg -n "remoteContext \? \|remoteContext \?\?" electron/toolChatLoop.ts electron/confirmation/toolCallGate.ts` |
| E17 | **既有默认规则含无 lane 限定条目（评审 B2 盘点）**：`DEFAULT_POLICY_RULES` 共 29 条、仅 25 条带 `match.lane`。无 lane 限定的关键条目：`shell-precheck-auto-allow`（`defaultRules.ts:102`，auto-evaluator——automation 的 `run_shell` 命中预检信任命令时**跳过确认直接执行**）；`browser-act-danger-ask`（`:149`）、`mcp-tool-ask`（`:253`）等。desktop-auto-approve 的 auto-evaluator 动作同样无 lane 限定（门控内 `!args.remoteContext` 只挡远程，挡不住 automation） | `rg -n "match: \{ (?!.*lane)" src/shared/policy/defaultRules.ts`（PCRE） |
| E18 | `window-all-closed` 未启用托盘时（非 darwin）直接 `app.quit()`——进程退出会终止进行中回合（`cancelAllActiveChats`）；「关窗后回合继续」的前提是**托盘常驻启用**。关窗本身不触发聊天取消（`main.ts:212` 仅置空窗口引用） | `electron/main.ts:686-689`、`:212` |
| E19 | 确认超时语义可靠：`waitForToolConfirm` 固定 5 分钟超时 resolve `'timeout'`（fail-closed）；「重开窗口取回过程与结果」有现成协议基础（`turnDisplayProtocol.ts` + `turnDisplayReconciliation.ts`） | `electron/toolConfirmRegistry.ts:16,32-35`、`src/shared/turnDisplayProtocol.ts` |
| E20 | 结果投递点不在 `toolChatLoop.ts:419`（该处为类型定义字段，v2 引用有误导，评审 N2）：结果性投递的实际调用方是桌面 `claudeStreamHandlers`（终态经 webContents 直发）与 IM 出站上游（`sendImOutbound` 调用点）。v3 已把偏差 8 降级为不选，此清单仅作为 §11 债务移交时未来收敛盘点的底稿 | `rg -n "safeWebContentsSend.*claude-chat-done|claude-chat-error" electron/` |

---

## 5. 阶段详细设计

### P0（新增，前置）：托盘常驻前提（评审 B3）

**目标**：让「关窗后回合继续跑」在真实运行形态下成立——这是 P1 与 P6 的共同前提。

**改动点**：

1. **声明与校验**：管家功能（定时任务）启用时，主进程校验托盘开关（`tray.ts` 的 `isTrayEnabled`）；未启用托盘而用户创建定时任务时，设置页明确提示「需要启用托盘常驻，否则关窗即退出、后台任务会中断」——提示在 UI 层，不静默替用户开托盘。
2. **进程存活语义二选一**（开工前拍板，默认 a）：
   - **a. 保持现状 + 用户提示**：`window-all-closed` 语义不动（未启用托盘 → 退出是用户显式选择的运行形态）；管家任务的运行前提即「托盘启用」，文档与设置页写明。
   - **b. 保活策略**：存在进行中回合或启用定时任务时，即使未启用托盘也阻止 `app.quit()`（`window-all-closed` 里检查活跃回合计数与任务开关）。改动小但改变退出语义——用户关窗想退出却被留在托盘，需要配套「从任务栏 / 命令行退出」的说明。
3. 无论选哪版：`before-quit` 的取消与 run `interrupted` 标记（P6 已列）不变，保证「退出是显式且干净的」。

**验收**：托盘启用 → 关窗进程存活（冒烟）；未启用托盘时设置页提示出现；选 b 时单测覆盖「活跃回合存在 → 不退出」判定。

### P1 偏差 1 整项：事件出口取代 sender，无窗口运行全链路解绑

**目标**：`runToolChatSession` 不再认识任何窗口对象；所有调用方（桌面、远程、后续管家）经事件出口说话；调用存亡只由取消 / 超时 / 错误决定。**运行前提：托盘常驻启用（P0）。**

**改动点**：

1. **sender 直发点收敛进事件出口**（E14 清单逐点处理，开工时以 `rg` 重新盘点为准）：
   - `:955` tools-activity 等事实类直发 → 并入 `emitFactEvent` 事件 union（新增对应事件类型）。
   - `:2298/:2300` `notifyFileTreeChanged` → 文件树失效通知作为出口事件的一种（`emitFactEvent` 新增 `file-tree-changed` 类事件或独立出口回调，实现层由装配方决定投给谁）。
   - `:1143` `scheduleSessionTitleSuggestion({ sender, … })`（评审 N1）→ 标题生成完成的通知从「函数内部裸 `sender.send`」（`sessionTitleSuggest.ts:178`）改为完成回调 / 出口事件：标题建议逻辑本身不动（它是落库动作），只把「通知界面」这一步改为经调用方注入的出口回调发送，顺带消除窗口销毁后抛异常被静默吞掉的问题；`scheduleSessionTitleOpenBackfillIfNeeded` 同样处理。
   - `failToolLoopWithLastUsage` 的 sender 参数删除（它只是把 usage 事件经 `emitFactEvent` 补发）。
2. **存活判定删除**：`:752-754` 整块移除。`RunToolChatSessionArgs.sender` 字段删除。
3. **出口必填化**：`emitFactEvent` / `emitSessionEvent` 从可选改为必填（调用方必须显式声明过程往哪里说——这正是架构文档 §7 Runtime 第三问）。桌面装配方（`claudeStreamHandlers`）构造「绑定主窗口 webContents 的出口实现」；远程装配方传 IM 进度 adapter；无观察者时传 no-op（出口允许全 no-op 是契约的一部分）。
4. **调用方适配**：桌面 `claudeStreamHandlers.ts:389`、远程 `imRemoteAgent.ts:129`（`noopSender` hack 随之删除，E3 的 TypeError 消失）。
5. **行为变化（要写进变更说明，属于 C1 纯后台语义对桌面的延伸）**：
   - 桌面窗口关闭后回合照常跑完、台账照常落盘，重开窗口经 turn display 协议（`TurnDisplay` 带版本、按版本只回差量，E19）取回过程与结果。
   - 窗口关闭期间遇到需确认的工具调用：确认卡片无处显示，`waitForToolConfirm` 按现有 5 分钟超时语义 fail-closed（E19 已核实）——比现状（窗口销毁直接杀回合）是严格改进，且与架构文档「无回答者 fail-closed 兜底」一致。

**整项验收口径**（全部满足才关偏差 1）：
- `rg -n 'sender' electron/toolChatLoop.ts` → 0 行（或仅注释）；`RunToolChatSessionArgs` 无 sender 字段；`rg -n 'isWebContentsAlive' electron/toolChatLoop.ts` → 0 行。
- `electron/sessionTitleSuggest.ts` 不再持有 `WebContents` 类型（评审 N1 的出口化收尾）。
- 单测：mock provider 下跑完「一次工具调用回合」（无窗口概念）；确认超时路径 fail-closed；标题建议完成回调在出口 no-op 下不抛错。
- 手工冒烟（托盘启用）：桌面发起回合 → 立即关窗 → 回合完成落库 → 重开窗口可见结果；远程托管关窗后照常回复。

### P2 偏差 21 + 22 整项：automation lane 可达、穿透与显式规则

**目标**：lane 由驱动源层解析后随调用传入，并**穿透 Core 内部全部消费点**（评审 B1）；automation lane 类型可达、规则显式、通道 fail-closed、审计贯通。

**改动点**：

1. **lane 显式传入（偏差 21 的目标形状）**：`RunToolChatSessionArgs` 新增可选 `lane` 入参（显式声明优先，回退 `remoteContext` 推导，最终回退 `desktop`）。
2. **lane 穿透 Core 内部全部推导点（评审 B1，E16 清单逐点替换）**——`remoteContext` 推导改为消费显式 lane，否则 automation 被当 desktop、读 desktop 规则与缓存、继承桌面豁免：
   - `toolCallGate.ts:107-117` `laneOf`：`ToolCallGateArgs` 新增 `lane`，`evaluateToolCallGate` 不再自行推导；`loadEffectivePolicyRules(appDb, lane)`（`:185`）与 decision cache 的 lane（`:328`）都消费穿透值——**decision cache 读写以真实 lane 为键，automation 不命中桌面用户的历史信任条目**。
   - `toolChatLoop.ts:626-641`：`exposureLane` 改用显式 lane；**MCP 快照注入判定同步改**——现状 `remoteContext: Boolean(remoteContext)` 语义是「仅桌面注入」，automation 调用为 false 时**会**注入 MCP 工具；改为按 lane 判定（`lane === 'desktop'` 才注入），保持「远程与 automation 无 MCP」语义。
   - `toolChatLoop.ts:1614-1618` `confirmLane`：改用显式 lane，否则 `channelFor` 永远收不到 `'automation'`，RejectingChannel 接不上。
   - `toolChatLoop.ts:1298/:1512/:1918/:1946` 等审计事件内联三元推导：全部收敛到一次解析的 lane 变量（审计归属正确是偏差 7 / 22 的验收面）。
3. **通道**：`channelFor` 对 `automation` 返回 `RejectingChannel`。`confirm.outcome` 审计带可区分原因（`cause: 'no-answerer'`，区别于用户拒绝）——现有 `ConfirmOutcome` 形状装不下则扩展 reason 字段并在落审计处透传。
4. **规则集（偏差 22）**，写入 `src/shared/policy/defaultRules.ts`，lane='automation'：

   | 动作 | 工具 | 理由 |
   | --- | --- | --- |
   | allow | `read_file`、`list_directory`、`grep`、`list_work_dirs`、`history.read`、`skills.read`、`read_feishu_attachment` | 只读，无外部副作用 |
   | confirm（无回答者 → 实际效果为拒绝） | `edit_file`、`write_file`、`run_script`、`run_shell`、`run_lark_cli`、`browser`、`browser_detect`、`wechat_send`、`wechat_reply`、`switch_work_dir`、`switch_session` 及**默认兜底** | v1 无回答者；默认落 confirm 而非 allow，新工具天然 fail-safe |
   | 禁止放宽 | `policyPackages.resolvePolicyRules` 加 guard：lane='automation' 不得套用 `loose` 档（偏差 15 的最小防护）；automation 不继承任何 desktop 专属豁免 | 无人类应答者的 lane 无豁免来源 |

5. **无 lane 限定规则的收窄（评审 B2，E17 清单逐条处理）**——不做这一步，上表的「confirm = 拒绝」是空的：
   - 逐条盘点 `DEFAULT_POLICY_RULES` 中无 `match.lane` 的条目（E17：共 4 条，含 `shell-precheck-auto-allow:102`、`browser-act-danger-ask:149`、`mcp-tool-ask:253`）。
   - `shell-precheck-auto-allow`（auto-evaluator，先于后段执行）：限定 `lane: ['desktop']`——automation 的 `run_shell` 即使命中预检信任命令也必须落 confirm。`desktop-auto-approve` 的 auto-evaluator 同理：门控内 `!args.remoteContext` 的远程挡板改为「非 desktop lane 一律不走 auto-evaluator」（否则 automation 命中时写操作免确认直接执行，是真实安全漏洞）。
   - `browser-act-danger-ask`、`mcp-tool-ask` 等其余条目：语义是收紧（ask）而非放宽，可保持无 lane 限定（对 automation 效果等价拒绝）；但盘点结论逐条写入 P2 提交说明，防止「恰好安全」依赖。
   - 原则写死：**凡是 `auto-evaluator` / `allow` 动作的规则必须带 lane 限定**——新增一条 lint 式单测（遍历 `DEFAULT_POLICY_RULES`，断言 `action ∈ {allow, auto-evaluator}` 的规则都有 `match.lane`），防以后漂移。

**整项验收口径**：
- 偏差 21（反向证据翻转）：`rg -n 'automation' electron/confirmation/channels.ts` → **返回行号**；`rg -n 'automation' src/shared/policy/defaultRules.ts` → 返回行号。
- 偏差 22：`rg -n 'automation' src/shared/policy/` 能找到以它为 lane 的规则（不再只有档位配置）。
- **运行时行为单测（评审 B1 的核心验收，rg 命令不够）**：
  - automation lane 的 `write_file` / `run_shell`（含预检信任命令桩）→ 门控结论 require-confirm → 无回答者 → 拒绝；**全程未命中任何 desktop 规则**。
  - decision cache 隔离：以 desktop lane 预写「记 N」缓存条目，automation 同签名调用**不命中**（缓存键含真实 lane）。
  - `desktop-auto-approve` 开启（`confirmMode=auto`）时 automation 的 `write_file` 仍被拒（auto-evaluator 不作用于非 desktop lane）。
  - MCP 工具不注入 automation 调用；审计事件 `lane='automation'`。
- 门控穿透回归：desktop / feishu / wechat 三 lane 现有 `toolCallGate` 测试全绿（显式 lane 传入与推导结果一致）。

### P3 偏差 7 整项：会话归属与可见性

**目标**：归属与可见性成为 sessions 的独立维度，先有谓词再有过滤；列表与搜索按谓词收敛；新会话创建强制声明归属。

**改动点**：

1. **迁移**（`DB_SCHEMA_VERSION` +1）：
   ```sql
   ALTER TABLE sessions ADD COLUMN ownership TEXT NOT NULL DEFAULT 'user';    -- user|remote|automation|internal
   ALTER TABLE sessions ADD COLUMN visibility TEXT NOT NULL DEFAULT 'primary'; -- primary|section|hidden
   ```
   现有行默认 `user`/`primary`，行为不变；存量远程会话（IM 创建）按创建特征回填 `remote`（回填脚本进迁移）。
2. **归属谓词纯函数**（`src/shared/`，闭合联合类型 + 一条纯谓词「该不该进用户主列表」）：`internal`/`hidden` → 不进主列表、不进跨会话搜索；`automation`/`section` → 不进主列表、进管家分区、进搜索与否跟随谓词配置（v1：进搜索，结果标注来源）。
3. **查询收敛**：`listSessions`（`operations.ts:119`）按谓词过滤（默认行为对现有调用方等价——现有调用方就是主列表视角）；跨会话搜索（`search:execute` 主进程侧）排除 `ownership='internal'`。
4. **创建强制**：`createSession` 增加 ownership/visibility 参数（默认 `user`/`primary`），不允许「忘了声明」——新调用方（管家、后续 SubAgent / 审批）创建会话即带归属。
5. **渲染端**：`SessionListPane` 按 `visibility` 分组渲染（`primary` 主列表 + `section: 管家`，本阶段先有数据通路，管家分区有内容要等 P4+）。

**整项验收口径**：
- 两列存在 + 谓词纯函数单测（四归属 × 三可见性矩阵）。
- 列表 / 搜索过滤单测：`internal` 会话搜不到、列表不显示。
- `createSession` 不带归属参数时默认值测试（防「忘了声明」）。
- 迁移前后数据一致性测试（复用既有迁移测试模式，含远程会话回填）。

### P4 automation 入口准入 + 管家执行链（偏差 23 不在此关闭）

> v3 修订：偏差 23 的整项语义（三维度补齐、桌面 / 远程 / automation 三入口一致施加）从本计划移除（§1.3 第 3 点的例外依据）。本阶段只做管家自己需要的准入。

**目标**：automation 调用入口有并发与速率约束，无人值守的触发不会堆积打满机器与配额；管家执行链完整可手动触发。

**改动点**：

1. **`electron/butler/butlerAdmission.ts`（管家单入口准入，几十行）**：
   - 只拦 `butlerInvoker` 一个入口：**并发 = 1**（同一时间至多一个 automation 回合在跑）+ **每小时触发上限**（默认 30，可配）。
   - 处置只有两种：排队（受控上限，超限拒绝）与拒绝；**拒绝必落审计**（`automation.admission.denied` 事件进 agent 日志白名单机制），可回答「我的定时任务为什么没跑」。
   - 不做：配额维度（token 预算框架）、桌面 `chat:execute-turn` 与远程 `imRemoteAgent` 接线、`remoteAgentRegistry` 职责上收、交互式优先与嵌套豁免形状预留——全部留给偏差 23 未来整项关闭时（§11）。桌面与远程链路零改动。
2. **管家执行链** `electron/butler/`：
   - `automation_tasks` / `automation_task_runs` 两表（随本阶段迁移加入，字段含：任务定义——名称 / schedule / prompt / 投递偏好 / 可选模型覆盖；运行记录——`client_id` 唯一幂等键 `${taskId}:${scheduledFor}`、status、session_id 血缘、result_summary、usage、delivery_status）。
   - `butlerInvoker.ts`：会话创建（`ownership='automation'`、`visibility='section'`；同一任务默认每次触发起新会话，控制上下文成本）→ `resolveTrustedTurnExecutionConfig(db, sessionId, 'automation', …)` → 全量内置工具集（门控已按 lane 挡，工具集裁剪留给偏差 16）→ `llmSystemPrompt` + 管家附录 → `runToolChatSession({ lane: 'automation', emitFactEvent: no-op, emitSessionEvent: 台账, … })`，外层经 `turnExecutionAdapter` 模式接入 `turnRuntime`。
   - `butlerSessionEvents.ts`：无窗口事件出口（UI 事实 no-op、台账照常落盘）。
   - IPC：`butler:run-task`（手动触发，开发期验收工具 + 后续「立即运行」按钮后端）。

**验收口径**：
- 单测：并发 = 1（第二个触发排队）、小时上限（超限拒绝 + 审计事件）、排队超限拒绝。
- 管家链集成（mock provider + 内存 DB）：手动触发 → 会话创建（归属正确）→ 回合完成 → run 记录 completed + usage 落库；提示词诱导写文件 → 被拒 → 回合收敛、run 记录说明拒绝原因。
- 桌面 / 远程链路回归面为零（本阶段不改 `appIpc.ts` 的 chat 通道与 `imRemoteAgent`）。

### P5 管家投递：`deliverTaskResult` 薄分发（偏差 8 不在此关闭）

> v3 修订：偏差 8 的整项修复（唯一投递入口 + 收敛存量投递点 + 独立送达记录）从本计划移除（§1.3 第 3 点的例外依据）。本阶段只做管家 v1 自己需要的最小投递。

**目标**：run 终态按任务配置送达三个目标之一：桌面浮动通知、IM 推送、仅落盘。

**改动点**：

1. **`electron/butler/butlerDelivery.ts`（一个几十行的纯分发函数）**：
   - 入参：任务投递偏好（`delivery_pref` / `delivery_target`）、run 结果摘要、会话 id。
   - `desktop`：`FloatingNotificationManager` 弹结果摘要（复用现有窗口状态语义：无窗口 / 失焦时静默或落待播）；`feishu` / `wechat`：`buildSimpleOutboundText` + `sendImOutbound`（E12），目标不可用或平台未启用 → **降级到桌面通知**并写 run 的 `delivery_status='failed-degraded'`（显式降级，不静默丢弃）；`none`：仅落盘。
   - 送达状态记在 `automation_task_runs.delivery_status / delivered_at`（P4 已建列，无新表）。
   - **有界性的最小实现**（业务正确性需要，不依赖偏差 8）：通知文本只取最新 run 的 result_summary——浮动通知本身天然「只送最新」；过期问题由调度侧保证（错过窗口的 run 是 `skipped`，不产生通知）。不做 TTL / 取代键 / 送达记录的通用机制。
2. **明确不做**：不动 `claudeStreamHandlers` / IM 回复等任何既有投递点；`safeWebContentsSend` 现状保留；无 `deliver(preference, payload)` 通用入口、无驱动源注册、无 `delivery_records` 表、无路由型预留。未来块 1 / 复用面做偏差 8 时，本函数是第一个迁移进统一入口的调用方。

**验收**：
- 单测：分发矩阵（四种偏好 × 平台可用 / 不可用 → 降级记录）；`skipped` run 不产生通知。
- 回归面为零：本阶段不改任何既有文件（新增模块 + P4 执行链的一处接线），无存量路径回归风险。

### P6 纯增量业务：定时调度器 + 任务管理 UI

**目标**：Driver 层定时触发源 + 有界恢复 + 任务 CRUD 界面。本阶段不碰任何架构接缝。

**改动点**：

1. `electron/butler/taskScheduler.ts`：
   - 主进程 `setInterval` tick（默认 30s 可配）；扫描 `enabled=1` 且 `next_run_at <= now` 的任务。
   - 触发：计算 `clientId = taskId:scheduledFor` → `INSERT OR IGNORE` 抢占 run 行（幂等，防 tick 重入 / 双投递）→ 准入取票 → P4 执行链 → 更新 run 与 `last_run_at/next_run_at`。
   - **启动恢复**：`main.ts` app ready 后重算 `next_run_at`；停机错过的触发只补最近一次，更早写 `status='skipped'`（`error='missed-window'`）；崩溃遗留 `running` 的 run 标 `failed('interrupted')`。
   - **托盘前提（P0 联动）**：调度器启动前校验托盘开关（未启用则不启动 tick，日志记录 `automation.scheduler.disabled-no-tray`）；P0 选保活策略（b）时此处同步放开。
   - 退出：`before-quit` 停 tick；进行中回合走现有取消语义，run 标 `interrupted`。
2. 任务 CRUD IPC：`butler:list|create|update|delete|run-task`，注册进 `appIpc.ts` + `preload.ts`（新 `window.api.butler*` 面，按领域注册——呼应偏差 10 方向但不做 10 本身）。
3. 设置弹窗「定时任务」Tab（`src/renderer/components/Config/` 新目录）：列表、新建 / 编辑（名称、interval / daily、提示词、投递偏好）、启停、删除、立即运行。文案全走 `t()`，新增 key 后跑 `npm run i18n:generate-types` + `npm run i18n:check`。

**验收**：单测（fake clock，参照 `remoteTaskBudget` 的 clock 注入模式）：到点计算、两种 schedule、clientId 幂等、有界补跑（错过 3 次只补 1 次）、interrupted 标记；渲染端 jsdom 测试：Tab CRUD 交互。

### P7 全量回归 + 偏差表集中回写

1. 全量：`npm test` + `npm run typecheck:renderer` + `npm run typecheck:shared` + `npm run i18n:check` + `npm run build:electron:incremental`。
2. 按架构文档 §12 复核约定回写偏差表：**1、7 标「已解决 YYYYMMDD」（正向证据已翻转），21、22 标「已解决 YYYYMMDD」（反向证据翻转：命令返回了行号）**；每条补复核记录行（含落地提交与复现命令），不删行、不留「部分解决」。8 与 23 保持「未解决」原状（§1.3 已记录例外依据）。

---

## 6. 安全设计要点（贯穿各阶段）

0. **进程常驻前提**：「关窗后回合继续」与定时任务都以**托盘常驻启用**为前提（P0）。未启用托盘时 `window-all-closed` → `app.quit()`（`main.ts:686-689`）会终止一切进行中工作；设置页显式提示，不静默改用户退出语义。
1. **判定顺序不变**：automation 调用的每次工具调用照走 `规则 → 缓存 → 回答者`；回答者是 `RejectingChannel`（fail-closed），`cause='no-answerer'` 与用户拒绝在审计可区分。
2. **不放宽**：automation lane 禁 `loose` 档；新工具默认落 confirm（= 拒绝），fail-safe；automation 不继承桌面豁免——豁免继承的机械保证是 P2 的 lane 穿透（decision cache 按真实 lane 键控）+ 「allow / auto-evaluator 规则必须带 lane 限定」的 lint 式单测（评审 B1 / B2 的教训：类型与规则表写了不算数，判定路径到不了等于没写）。
3. **准入拒绝不构成安全结论**：`cause=unavailable`（拿不到配额）与 `cause=agent-deny` 在审计可区分（`butlerAdmission` 的拒绝与排队同样适用此口径）。
4. **幂等与有界**：`client_id` 唯一约束防双触发；补投只补最近一次；投递带 TTL 与取代键、送达记录命中即止。
5. **审计归属**：安全审计 `lane='automation'`；agent 日志新增事件名（`automation.task.triggered/completed/failed/skipped`、`automation.admission.denied`）走现有白名单 + `sanitizeForLog`，不落 prompt 原文（prompt 落 `automation_tasks` 表，日志只落任务 id 与摘要）。
6. **渲染进程不可信边界**：任务 CRUD、手动触发、准入、投递全在主进程；UI 只表达意图。

---

## 7. 验收边界（开工对齐项）

**可在当前环境单测 / 集成验证（vitest）**：P1 出口化回合与确认超时、标题建议出口回调；P2 策略矩阵、lane 穿透运行时行为（cache 隔离 / auto-evaluator 不命中 automation / MCP 不注入）与 guard；P3 迁移 / 谓词 / 过滤；P4 单入口准入（并发 / 排队 / 拒绝审计）+ 管家链（mock provider + 内存 DB）；P5 投递矩阵；P6 fake clock 调度与 UI。

**需真机 / 手工冒烟（无法自动化，清单；均以托盘启用为前提）**：
- 桌面 / 远程 / 管家三链路「关窗后回合继续、重开可回看」（P1 行为变化的验收核心）。
- 未启用托盘时关窗 → 进程退出 → run 落 `interrupted`（P0 语义 a 的负向冒烟）。
- 真实 24h 稳定性：interval 与 daily 任务各一，跨重启。
- 真实 IM 投递（飞书 / 微信各一）与目标不可用时的降级通知。
- 浮动通知视觉与过期不弹。

**外部依赖**：无新增第三方依赖（不引 cron 库，interval / daily 自实现）。

---

## 8. 风险与回退

| 风险 | 缓解 |
| --- | --- |
| 偏差 1 整项改造面大（toolChatLoop 全部 sender 使用点 + 两个调用方 + sessionTitleSuggest） | E14 清单已盘点到行（含评审 N1 补的标题建议点）；事实通道事件化有 E15 的既有出口雏形承接；P1 单独成阶段，出问题可独立 revert；桌面行为变化（关窗不杀回合）在阶段内冒烟清单化验收 |
| lane 穿透遗漏（评审 B1 的教训：改动点在 Core 内部不止一处） | E16 清单 + P2 提交说明强制附「`rg -n 'remoteContext \? .*desktop' electron/` 复查为空」；单测直接测运行时行为（cache 隔离、auto-evaluator 不命中 automation），不依赖静态 rg |
| 规则表无 lane 条目未来漂移（评审 B2） | lint 式单测：`allow` / `auto-evaluator` 动作必须带 `match.lane`，进 CI |
| 托盘未启用导致关窗退出（评审 B3） | P0 显式拍板运行前提；调度器启动校验 + 设置页提示；退出路径始终干净落 `interrupted` |
| 准入误伤既有桌面 / 远程链路 | **已随偏差 23 降级消除**（v3）：`butlerAdmission` 只拦 butlerInvoker 单入口，桌面与远程链路零改动 |
| 投递收敛改动既有 IM 回复路径 | **已随偏差 8 降级消除**（v3）：P5 不碰任何存量投递点，新增模块 + 一处接线，回归面为零 |
| 定时任务 token 成本失控 | 速率 / 配额维度（P4）+ `usage_json` 落库对账（接既有用量统计面）|
| 与后续块 1 契约返工 | 四个偏差的修法全部取架构文档「应该往哪走」的目标形状（出口化、lane 显式传入并穿透、谓词、显式规则集），正是块 1 收敛要的形态——本计划是它的部分提前兑现，不是旁路；8、23 两个例外的剩余边界已在 §11 向块 1 移交 |

---

## 9. 偏差表回写预告（P7 产出）

| 偏差 | 回写后状态 | 复现命令翻转形态 |
| --- | --- | --- |
| 1 | 已解决 | `rg -n 'sender' electron/toolChatLoop.ts` → 0 行；`rg -n 'isWebContentsAlive' electron/toolChatLoop.ts` → 0 行；`rg -n 'WebContents' electron/sessionTitleSuggest.ts` → 0 行 |
| 7 | 已解决 | sessions 两列 + 谓词 + 过滤 + 创建强制归属（正向证据翻转） |
| 21 | 已解决 | `rg -n 'automation' electron/confirmation/channels.ts src/shared/policy/defaultRules.ts` → 返回行号（反向证据翻转） |
| 22 | 已解决 | `rg -n 'automation' src/shared/policy/` → 有以它为 lane 的规则；且运行时行为单测证明规则可达判定路径（B1 教训：静态翻转 + 行为测试双口径） |

偏差 8、23 不回写（保持「未解决」原状）——其证据在本计划前后不变：8 的「投递散落、无统一送达记录」，23 的「准入没有拦在调用入口上」（`butlerAdmission` 只拦 butlerInvoker 单入口，不触碰桌面 / 远程链路，整项语义未达成）。例外依据见 §1.3，剩余边界见 §11。

---

## 10. 与既有文档的关系

| 文档 | 关系 |
| --- | --- |
| `architect/product-architecture-design.md` | 理想态与偏差清单；本计划按其 §12 复核约定回写四条状态（8、23 保持原状，例外依据见 §1.3） |
| `architect/agent-core-roadmap.md` | 本计划 = 其块 4 的最短路径版，并提前兑现块 1 的偏差 1 / 21 / 22 / 7 四项；块 1 / 块 2 仍是完整收敛路径 |
| `architect/confirmation-answerer-and-auto-approval-design.md` | 块 2 方案；automation 回答者升级（fail-closed → 审批 Agent）时启用，届时放开写操作类任务 |
| `../review/butler-agent-shortest-path-plan-review.md` | 2026-09-24 评审；B1（lane 穿透）→ P2 改动点 2、B2（无 lane 规则收窄）→ P2 改动点 5、B3（托盘前提）→ P0、N1 → E14 / P1、N2 → E20 / P5；v3 已逐项吸收 |
| `background-task-execution-layer-technical-design-v3.md` | 已判「目标保留、方案降级为参考」（roadmap §6），无依赖 |
| `builtin-subagent-development-plan.md` | 子进程 SubAgent 路线，与管家正交 |

## 11. 债务移交清单（本计划不碰、块 1 / 块 2 收敛时认领）

1. 偏差 2 / 3：`loadContext` / `persist` 端口与 Core 脱库、规则随调用传入（管家沿用现状机制，不是切片）。
2. 偏差 8 整项：驱动源层唯一投递入口 `deliver(preference, payload)`、驱动源注册与可达性、独立送达记录、TTL / 取代键 / 路由型（最近可用入口）、**收敛存量结果投递点**（桌面 `claudeStreamHandlers` 终态直发与 IM 回复终态，盘点口径见 E20）。本计划的 `deliverTaskResult`（P5）是未来统一入口的第一个迁移对象；管家 v1 的有界性靠调度侧保证（skipped run 不产生通知、通知只取最新 run），通用机制不在此建。
3. 偏差 9 / 10 / 11 的剩余部分：驱动权、IPC 面拆分、列表失效通知契约（本计划不动）。
4. 审批 Agent 作为 automation lane 回答者（放开写操作类任务的前置）。
5. 事件源驱动源（文件变化 / webhook）与远程管家的 Profile 化（Skill / 专属工具集 / 模型档 / 会话域）。
6. 偏差 23 整项：准入维度补齐（并发 / 速率 / **配额**）与**三入口一致施加**（桌面 `chat:execute-turn` 全通道盘点、远程 `imRemoteAgent` 接线与 `remoteAgentRegistry` maxParallel 职责上收）、交互式优先级、嵌套调用准入（同步依赖继承等待者优先级 + 有界等待）。本计划的 `butlerAdmission`（P4）是未来统一准入在 automation 入口的先行实现，迁移时把桌面 / 远程入口接入同一模块。
7. 按 lane 裁剪工具集（偏差 16）；思维强度分档（偏差 6）；SDK 面（偏差 17–20）。
8. 管家会话延续（跨触发共享上下文）与任务级损害预算（现成 `remoteTaskBudget` 可迁）。
