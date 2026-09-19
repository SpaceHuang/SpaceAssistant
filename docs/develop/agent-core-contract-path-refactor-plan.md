# 调用契约路径重构计划（偏差 1、2 → 3、4、5、6、8、16）

> 定位：本文是**实施计划**，把 `docs/develop/architect/product-architecture-design.md` §10 偏差清单中**调用契约路径**上的七条偏差（1、2 → 3、4、5、6、8、16）落成可分阶段交付、可独立验收的工程排期。
> 上游（方向共识）：`architect/product-architecture-design.md`（下称「基线」，`§N` 指其小节）；`architect/agent-core-roadmap.md`（下称「roadmap」，块 1 = 本计划 P1 + P2 的完整版）。
> 左右邻：`butler-agent-shortest-path-plan.md` §11 债务移交清单（第 1、2、7 条由本计划认领）；`approval-agent-shortest-path-plan.md` §8（「块 1 收敛后 AgentChannel 装配点平移」由本计划落实）。
> 状态：**已实施（2026-09-19，偏差表回写见 §11）** ｜ 基线：工作区 HEAD `24f9b546` · v0.1.8（修订时工作区已前进至 `784d86b3`，本计划涉及的证据符号均未变化）｜ 摸排：2026-09-18 ｜ 预估总量：15 – 21 人日
> 修订记录：**v2（2026-09-18）**——按评审报告 `docs/review/agent-core-contract-path-refactor-plan-review.md` 修订：**B1** 采纳方案 a（门控入参端口化前移并入 P2，P3 缩为语义收口）；**B2** 补登 shell 预检 `touchTrustedCommand` 销号项；**N1** 声明 appDb 的 P1 过渡存放例外；**N2** 修正偏差 8 证据（死引用 / `notifyMainWindow`）并重定投递面盘点口径；**N3** 分立真相类 / 观察类端口失败语义；**N4** 销号基数改为开工实测、不钉死数字。
> 证据约定：与基线 §10 相同 —— 行号是摸排快照，会随代码演进失效；每条证据以 `rg -n '<符号>' <文件>` 复现，行号只作辅助。**摸排期间 HEAD 已自 `c725896e` 经 `24f9b546` 前进到 `784d86b3`**，每阶段开工必须重跑证据命令。

---

## 0. 结论与定位

**一句话**：偏差 1（事件出口取代 sender）已于 2026-09-17 解决，契约路径的公共前置只剩**偏差 2**——把 Invocation 契约立起来、把 Core 对 Storage 的依赖收口成 `loadContext()` / `persist()` 两个端口；这一对做完（P1 + P2），下游五条（3、4、5+6、8、16）即可并行铺开，本计划给出它们的阶段划分、接口形状、行为等价策略与验收标准。

**范围内**：偏差 2（Invocation 契约 + Core 端口）、3（规则随调用传入）、4（factsProvider / answerer 端口收口）、5（baseUrl 出契约）、6（思维强度分档）、8（投递入口的**机制面**）、16（按子调用裁剪工具集）。

**范围外**（各自有明确去处，见 §9、§10）：驱动权路径（9、10、11、12）、横切关注点（13、14、24）、SDK 复用面（17 – 20，但其 §6 三条硬约束中不花钱的两条随 P1 落实）、偏差 15 剩余部分（user lane 宽严档位，P3 之后解锁、独立排期）、块 3 SubAgent 派生工具的业务实现（本计划只交付裁剪**机制**）。

**三条关键判断**（与基线 2026-09-18 复核记录的差异点）：

1. **偏差 1 还有一处未收口**：§5.5 点名「`floatingNotificationManager` 这种直接把宿主对象递进来的写法，收回成出口实现」——今天它仍是 `RunToolChatSessionArgs` 的可选参数（`electron/toolChatLoop.ts`，字段清单见 §4 P1）。并入 P1 的 events 出口对象化一并完成，不单开阶段。
2. **偏差 2 在持续变重，且基数必须动态看待**：token 用量统计合入后，`toolChatLoop.ts` 新增 `recordTurnSummary` / `recordStepUsage`（`electron/usageStats/usageStatsRecorder.ts:101`、`:75`）两类用量落库；`rg -c 'appDb'` 的实测计数在摸排（31）与评审（35）两轮间已不一致——无论口径差异为何，结论一致：**销号基数以 P0 开工实测为准，不钉死数字**。这是新增耦合进入 Core 的活例，也是本计划把 P2 排在最前的直接理由。
3. **偏差 8 与偏差 9 的依赖要拆开对待**：基线偏差表记 8 的前置为 `1、2、9`。其中「统一投递入口 + 送达记录 + 有界补投」的**机制面**不依赖 9（它落在主进程驱动源层，桌面驱动源注册自己的 sink 即可）；依赖 9 的是**存量投递点收敛**（桌面终态发送通道 `notifyMainWindow` 与文件树 / 文件内容的直连点等——评审 N2 澄清：桌面终态实际走 `notifyMainWindow`（`claudeStreamHandlers.ts:51`），它属驱动源实现，P6 机制面要求**注册**、不要求**迁移**）。本计划 P6 只交付机制面 + butler/IM 首批迁移，存量收敛留在驱动权路径——与管家计划 v3 的显式例外决策一致。

---

## 1. 路径与现状（2026-09-18 摸排，HEAD `24f9b546`）

| 偏差 | 基线状态 | 现状证据（命令可复现） | 本计划认领 |
| --- | --- | --- | --- |
| 1 | 已解决（20260917） | `rg -n 'sender' electron/toolChatLoop.ts` → 0 行；`rg -n 'isWebContentsAlive' electron/toolChatLoop.ts` → 0 行 | 只收尾：`floatingNotificationManager` 出口化（P1） |
| 2 | 未解决 | `rg -c 'appDb' electron/toolChatLoop.ts` → **31**（修订时点 `784d86b3` 实测；评审时点 `24f9b546` 实测 35——时点与口径差异并存，**P0 以开工实测为准**）；`rg -n 'recordTurnSummary\|recordStepUsage' electron/toolChatLoop.ts`（20260918 新增）；入口签名 `RunToolChatSessionArgs.appDb?: AppDatabase` | **P1 + P2（关键前置）** |
| 3 | 未解决 | 门控消费 `args.appDb` 三处：`rg -n 'args.appDb' electron/confirmation/toolCallGate.ts` → `:194`（生效规则，静默回退 `DEFAULT_POLICY_RULES`）、`:332-338`（决策缓存，无库时静默回退 `EMPTY_CACHE`——**命中与写入全失且无审计**）、`:147`（shell 预检透传，见偏差 B2 销号项） | **P2（管道端口化）+ P3（底线与来源）** |
| 4 | 部分解决（20260917） | 双维回答者已落地（`ConfirmationChannel` / `AgentChannel` / `DenyChannel`）；余下：`rg -n 'AutoEvaluator' src/shared/confirmation/types.ts` → `:428`、`:441`（仍同步、按工具名写死）；事实仍由门控内部构造，无 `factsProvider` 端口 | P5 |
| 5 | 未解决 | `rg -n 'baseUrl' src/shared/assistantFactAggregator.ts` → `:12`（`TurnExecutionConfig.baseUrl?`） | P4 |
| 6 | 未解决 | `rg -n 'thinkingEnabled' src/shared/domainTypes.ts` → `:788`（全局布尔）；`rg -n 'supportsThinking\|capability' src/shared/domainTypes.ts` → 0 行（`ModelEntry` `:732` 无能力标记） | P4 |
| 8 | 未解决（显式例外） | 真实发送调用点盘点（评审 N2 修正口径）：`rg -n 'safeWebContentsSend\(' electron --glob '!*.test.ts'` → 仅 `fileContentWatcher.ts:25`、`fileTreeSyncNotify.ts:9`；`claudeStreamHandlers.ts:2` 为**死引用 import**（无任何调用，P6 顺手清除）；桌面终态实际走 `notifyMainWindow`（`claudeStreamHandlers.ts:51`）。butler 已有 `deliverTaskResult` 薄分发（未来统一入口的第一个迁移对象） | P6（机制面） |
| 16 | 部分解决（20260917） | 审批 Agent 已有按调用裁剪实例（`electron/confirmation/approvalAgent.ts` 的 `APPROVAL_READONLY_TOOLS`，白名单硬编码）；通用机制不存在：`electron/effectiveTools.ts` `computeEffectiveTools` 仍按会话与配置整体装配 | P7 |

**直接消费 `runToolChatSession` 的调用方**（P1 适配器改造面）：`rg -ln 'runToolChatSession' electron --glob '!*.test.ts'` →

- `electron/claudeStreamHandlers.ts`（桌面）
- `electron/remote/imRemoteAgent.ts`（远端）
- `electron/butler/butlerInvoker.ts`（管家）
- `electron/confirmation/approvalAgent.ts`（审批嵌套调用）
- `electron/butler/butlerSessionEvents.ts`（仅类型注释引用，无调用）

---

## 2. 目标形态（契约路径的终点）

### 2.1 Invocation 契约（基线 §6.2，P1 落形）

```text
AgentInvocation
  ├─ session       会话锚点：既有会话 id + 归属声明（新建会话时带 ownership/visibility）
  ├─ messages      本次新增输入（历史不经此传入——P2 起经 loadContext 装载）
  ├─ profile       模型档（含解析结果冻结快照）/ 工具能力集 / Skill 附加 / system / lane / locale
  ├─ events        事件出口对象：onFact / onSessionEvent / onFileTreeChanged / onTitleGenerated / notify
  │                （允许全 no-op；floatingNotificationManager 收回为 notify 的宿主实现）
  ├─ limits        单次调用内上界：maxToolRounds（现 maxToolLoopRounds）、时长、token、调用内并发
  ├─ signal        取消
  ├─ clientId      幂等键（跑道字段；本期只立字段，消费方随块 4 准入接入）
  ├─ additionalContext  可寻址附加材料（键值对）：task.digest、facts.history 等
  ├─ trace         请求追踪（requestId / turnId / windowId 归此）
  └─ safety        Safety 协议字段：internalConfirmExemption（递归守卫标记，代码写死，不可配置）

→ AgentInvocationResult
  ├─ status        completed | cancelled | failed | denied（现 ok/cancelled 布尔的四态化；本期先落形状）
  ├─ messages      本次调用产生的消息
  └─ usage         token 与成本
```

**字段映射元表**（P1 的完整对照，改动评审以此为准；`steering` 按基线明确预留、本期不实现）：

| 现有 `RunToolChatSessionArgs` 字段 | 去处 | 备注 |
| --- | --- | --- |
| `requestId` / `turnId` / `windowId` | `invocation.trace` | `windowId` 属宿主 UI 簿记，P2 后评估移出契约、由出口实现持有 |
| `sessionId` | `invocation.session` | 新建会话的归属声明随块 4 接入，本期只承载既有 id |
| `messages` / `currentUserMessageId` / `assistantMessageId` / `hasImageAttachments` | `invocation.messages`（含伴随元数据） | 语义不变；「历史经 loadContext」在 P2 收口 |
| `model` / `llmServiceId` / `contextWindow` / `system` / `options.maxTokens` / `locale` / `projectMemoryEnabled` / `skillFragments` | `invocation.profile`（解析结果冻结快照语义保留） | `options.enableThinking` → P4 换 `profile.reasoning.effort`；`baseUrl` → P4 移出契约 |
| `toolsConfig` + `browserConfig` / `shellConfig` / `wikiConfig` / `feishuConfig` / `wechatConfig` / `larkCliRunner` | `invocation.profile.tools`（宿主已解析的装配材料） | P7 改造为按调用的能力集裁剪 |
| `lane` | `invocation.profile.lane` | 已有，平移 |
| `remoteContext` | `invocation.driverContext` | 驱动源上下文（IM 来源等） |
| `maxToolLoopRounds` | `invocation.limits.maxToolRounds` | |
| `approvalTaskDigest` | `invocation.additionalContext['approval.taskDigest']` | P1 平移，键语义化在 P5 接线 |
| `historyFacts` | `invocation.additionalContext['facts.history']` | |
| `internalConfirmExemption` | `invocation.safety.recursionGuard` | 保留契约显式字段；取值 `'approval-agent'` 代码写死，不可配置（不可变集语义） |
| `workDir` / `workDirManager` / `resolveWorkDir` / `userDataDir` | `ports.workspace` | 宿主端口 |
| `getApiKey` | `ports.credentials.resolveApiKey(model)` | **接口方法，不是闭包**（SDK 决策 §6 硬约束 2） |
| `appDb` | P1 过渡：`ports.legacy.appDb`（**显式声明的过渡例外**，字段带 `@deprecated P2 删除` 注释）；P2 删除并切换为 `ports.storage` 系列端口 | 过渡例外是「端口一律接口」唯一声明的豁免期（评审 N1）；P1 的 rg 验收允许此一处命中，P2 验收标准 1 即其关闭时点 |
| `getBrowserDetectContext` | `ports.hostFacts` | P5 正式化为 `factsProvider` 的宿主实现之一 |
| `floatingNotificationManager` | **删除参数** → `events.notify` 的宿主实现 | §5.5 收口（偏差 1 尾巴） |
| `emitFactEvent` / `emitSessionEvent` / `onFileTreeChanged` / `onTitleGenerated` | `invocation.events`（分组出口对象） | 必填化语义保留，允许全 no-op |
| `appendCompactionTransaction` / `contextMeter` / `onTurnBoundary` | `ports.storage` / `ports.contextMeter` / `ports.turnBoundary` | 语义不变 |

### 2.2 Core 端口与装配点（基线 §5.2、§8，P2 落形）

- **`loadContext(invocation)`**：按会话锚点返回**原始材料**（已有历史、会话元数据、可寻址上下文）；只装载不装配，裁剪与注入留在 Core。
- **`persist(result | 中间产物)`（真相类）**：消息终态、会话元数据写、压缩事务、标题落库、shell trusted-command 安全记账写（`touchTrustedCommand`，评审 B2 补登）。真相类**不允许静默失败、不允许静默 no-op**：存储不可用 → 调用显式失败（fail-cancelled）+ 可区分错误码 + 审计（§2.4 验收标准 3）。
- **`ports.usage`（观察类）**：`recordStepUsage` / `recordTurnSummary` 用量落库。失败降级重试、**不得改变执行结论**，但不得静默——失败必须可观测（诊断计数落审计）。与真相类的失败语义相反，端口因此分立、不共用（评审 N3）。
- 其余宿主能力各自成端口：`ports.credentials` / `ports.tools`（MCP 连接管理器）/ `ports.decisionCache`（决策缓存视图）/ `ports.shellPrecheck`（trusted-command 记账读写，随预检材料端口化）/ `ports.diagnostics` / `ports.hostFacts` / `ports.contextMeter` / `ports.turnBoundary`。
- **门控入参随 P2 端口化**（评审 B1，采纳方案 a）：`evaluateToolCallGate` 改收**必填** `effectiveRules` + `decisionCache` 视图 + `shellPrecheck` 材料，由装配期解析注入；门控内三处 `args.appDb` 消费（`:194` / `:332-338` / `:147`）与两条静默回退（`DEFAULT_POLICY_RULES`、`EMPTY_CACHE`）同步消除。P2 与 P3 之间**不存在**「循环已脱库、门控仍持库」的窗口。
- **装配点唯一**：新增 `electron/runtime/invocationAssembler.ts`（名以实现为准），四个调用方的适配器都经它产出 Invocation 与 ports；它是 roadmap「Runtime 是唯一装配点」在主进程的落位，也是 P2 规则与预检材料解析、P4 Profile 解析、P6 sink 注册的宿主。

### 2.3 各偏差终态一句话

| 偏差 | 终态 |
| --- | --- |
| 3 | 分两步收口——**P2（管道）**：门控不持有 `appDb`，改收装配期解析的必填 `effectiveRules` / `decisionCache` 视图 / `shellPrecheck` 材料，两条静默回退（`DEFAULT_POLICY_RULES`、`EMPTY_CACHE`）消除，缺料 = 调用失败并落审计；**P3（语义）**：入口校验「可收紧不可放宽」、嵌套取交集、规则来源标注 |
| 4 | 确认事实 = 工具声明 + `factsProvider`（宿主端口）的并集，逐项标注来源；结论只出自回答者位；`AutoEvaluator` 保留为**确定性预过滤**（有意决策，复核记录留痕），其条目改为数据声明（规则化 + lane 标注），不再是按工具名写死的代码分支 |
| 5 | `TurnExecutionConfig` 不含 `baseUrl`；网络目标与凭据留在宿主解析结果（`ports.credentials`），可声明层只有模型意图 |
| 6 | `profile.reasoning.effort: 'off' \| 'low' \| 'medium' \| 'high'`；`ModelEntry` 带能力标记；宿主校验 + 按定死规则降级并落审计；子调用默认 `off`（零成本档），模型默认继承（基线 §5.4 规则 3/5）；发起时解析、调用内冻结语义不变 |
| 8 | 驱动源层唯一投递入口 `deliver(preference, payload)`：驱动源注册 + 可达性、送达记录、TTL / 取代键 / 送达即止；butler `deliverTaskResult` 与 IM 回复通道迁入；桌面存量直发点**不迁**（驱动权路径认领） |
| 16 | `profile.tools` 支持按调用裁剪：封闭集合断言、只能收窄不能加宽（嵌套取交集）；裁剪落在工具集，不落提示词；审批 Agent 白名单平移为该机制的首个数据化实例 |

### 2.4 验收标准（判断这个切法是否成立，基线 §8 三条 + 一条总验收）

1. `rg -n 'appDb' electron/toolChatLoop.ts electron/confirmation/toolCallGate.ts` → **0 行**（循环与门控同步归零，B1 修订后无例外条款）；`rg -n "import .*database" electron/toolChatLoop.ts` → 0 行。
2. Core 能以内存端口实现跑单测：不启动 Electron、不碰 SQLite，完成「带工具调用的回合 + 一次确认 + 一次拒绝」（这也是 SDK 面 20 号偏差的预演，但其正式验收仍属 17 – 20）。
3. 存储不可用时 Core 的行为有明确约定并落审计（fail-cancelled + 可区分错误码），不再是未定义行为。
4. 换一种存储实现（内存 / JSONL 适配器）不改 Core 一行。

---

## 3. 阶段计划总览

| 阶段 | 关闭什么 | 前置 | 预估 | 收尾提交 |
| --- | --- | --- | --- | --- |
| P0 | 特征化测试基线（行为等价保险网） | — | 0.5 – 1 人日 | `test(agent): 契约路径特征化基线` |
| P1 | 偏差 2 前半：Invocation 契约落地 + events 对象化 + floatingNotificationManager 出口化 | P0 | 2 – 3 人日 | `refactor(agent): Invocation 契约落形` |
| P2 | 偏差 2 后半：Core 端口收口 **+ 门控入参端口化（B1 修订）**，摘除 appDb | P1 | 3.5 – 5.5 人日 | `refactor(agent): Core 脱库，loadContext/persist 端口与门控端口化` |
| P3 | 偏差 3 语义收口：底线校验 + 规则来源标注 | P2 | 1 – 1.5 人日 | `refactor(safety): 规则底线校验与来源标注` |
| P4 | 偏差 5 + 6：baseUrl 出契约 + effort 分档 | P2 | 2 – 3 人日 | `feat(profile): 模型档与思维强度分档` |
| P5 | 偏差 4：factsProvider 端口 + 裁决位收口 | P3 | 1 – 2 人日 | `refactor(confirmation): factsProvider 端口` |
| P6 | 偏差 8 机制面：统一投递入口 + 送达记录 | P2 | 2 – 3 人日 | `feat(driver): 驱动源层投递入口` |
| P7 | 偏差 16：按子调用裁剪工具集 | P4、P5 | 2 – 3 人日 | `feat(profile): 按调用裁剪工具集` |
| P8 | 全量回归 + 偏差表回写（md + html） | 全部 | 0.5 – 1 人日 | `docs: 偏差表回写（契约路径）` |

```text
P0 ──▶ P1 ──▶ P2 ──┬──▶ P3 ──▶ P5 ──┐
                   │                ├──▶ P7 ──▶ P8
                   └──▶ P4 ─────────┘
                   └──▶ P6（独立，可与 P3/P4/P5 并行）──▶ P8
```

**排序理由**：P1 / P2 是公共前置（基线 §10「先把这一对做完，下游才能并行铺开」）。P2 吸收了评审 B1 的门控入参端口化（原 P3 的管道半）——这是消除「P2 已脱库、P3 未动门控」静默回退窗口的唯一解，且 P2 → P3 串行、无并行方，不存在二次翻动；两阶段变更性质分离（P2 机械端口化、P3 语义新增），测试可分别验收。P5 排在 P3 后：它的 factsProvider 是门控入参的最后一次翻动，串行让每批测试的变更性质单一。P6 与 P3 – P5 无文件交集，可并行；P7 依赖 P4 的 profile 形状与 P5 的扩展点收口，是主线最后一环（基线：「16 是主线里最靠后的一条」）。P2 +0.5 人日与 P3 −0.5 人日相抵，总量估算不变。

**过程纪律**（AGENTS.md）：每阶段收尾必须提交；开发中只跑定向测试（`npm exec vitest run <文件>` 或 `npm run test:related -- <改动文件>`）；每阶段 `build:electron:incremental` 至多一次；全量 `npm test` / `npm run build` 只在 P8。

---

## 4. 阶段详细设计

### P0 特征化测试基线（0.5 – 1 人日）

**目标**：在动任何签名之前，把契约路径上的既有行为钉住，P1 – P7 的「行为等价」才有裁判。

**改动清单**（只加测试，不改产品代码）：

1. 门控裁决顺序特征化：规则命中 → 缓存命中 → 回答者 → fail-closed 的既有路径补齐缺口（现有测试盘点后补漏，不重写）。
2. `toolChatLoop` 四个调用方的入参 → 行为契约：桌面（`claudeStreamHandlers`）、远端（`imRemoteAgent`）、管家（`butlerInvoker`）、审批（`approvalAgent`）各至少一条「入参 X → 触发 Y」的定向用例，覆盖：lane 传递、事件出口回调被调用、`maxToolLoopRounds` 生效、`internalConfirmExemption` 的 recursion-blocked 结论。
3. Core 内 `appDb` 消费点的**符号级全量盘点表**落进本计划附录——**以开工时实测为准，不钉死基数**（摸排 31、评审 35，两轮已不一致），P2 逐项销号。

**验收**：`npm exec vitest run <新增文件>` 全绿；不跑全量。

### P1 Invocation 契约落地（偏差 2 前半，2 – 3 人日）

**目标**：新契约类型立起来、四个调用方改为经适配器构造 Invocation、事件出口对象化——**纯形状重构，行为零变化**。

**改动清单**：

1. 新增 `src/shared/agent/invocation.ts`：`AgentInvocation` / `AgentInvocationResult` / `AgentEventSink`（events 出口接口）/ `AgentHostPorts`（宿主端口接口，§2.1 映射元表逐字段落位）。契约只放可序列化数据与消息；端口一律接口（SDK 决策 §6 硬约束 1、2，本期不取费的第三条「多实例」不做）。
2. `electron/toolChatLoop.ts`：`runToolChatSession` 签名改为 `(invocation: AgentInvocation, ports: AgentHostPorts)`；内部先做一次**适配层展开**（旧变量名逐个对应），循环体不动。
3. 四个调用方改为经 `invocationAssembler` 构造入参（装配点先立骨架，P2 起承接端口实现）。
4. `floatingNotificationManager` 参数删除：装配器把宿主实例包装成 `events.notify` 实现，循环内原有调用点改走出口（§5.5 收口）。
5. `butlerSessionEvents.ts` 的注释引用同步更新。

**行为等价性**：所有 P0 特征化用例不改断言通过；`emitFactEvent` / `emitSessionEvent` 必填语义、no-op 语义、出口异常不影响执行结论的语义逐条保留。`ports.legacy.appDb` 仅作容器平移（原样透传给循环体内既有取用路径），是「端口一律接口」唯一声明的过渡豁免，P2 关闭（评审 N1）。

**测试与验收**：`npm run test:related -- electron/toolChatLoop.ts electron/claudeStreamHandlers.ts electron/remote/imRemoteAgent.ts electron/butler/butlerInvoker.ts electron/confirmation/approvalAgent.ts`；`build:electron:incremental` + `typecheck:renderer`（shared 类型被改动）。

**回退**：单提交回滚即可（无 schema、无 IPC 协议变化）。

### P2 Core 端口收口 + 门控入参端口化（偏差 2 后半，3.5 – 5.5 人日）

**目标**：摘除 `appDb`——循环与门控都不再持有库句柄，Core 与 Safety 的接缝收敛为 §2.2 的端口；这是全计划的重心（含评审 B1 修订：门控入参端口化随本阶段完成，不留给 P3）。

**改动清单**（按消费类别，销号表以 P0 附录为准）：

| 类别 | 现消费点（符号级） | 去处 |
| --- | --- | --- |
| 会话元数据读 | `getSession(appDb, sessionId)?.metadata`（system 派生、`shellOutputMode`） | `loadContext` 返回的会话材料 |
| 会话元数据写 | `updateSession`（recovery skill fragment 等） | `persist` |
| 标题生成与落库 | 累计 assistant 阈值读会话 + 标题写库 | `persist` + 既有 `events.onTitleGenerated` |
| 暴露面规则 | `loadEffectivePolicyRules(appDb, exposureLane)` | **装配期解析**随 invocation 传入（与门控 `effectiveRules` 同机制） |
| MCP 快照与执行器 | `buildSnapshotFromDb(appDb, …)`、`resolveMcpExecutor(…, appDb)` | 快照装配期构建传入；连接管理器走 `ports.tools` |
| locale 回退 | `resolveRequestLocale(payloadLocale, appDb)` | 装配期解析定值，循环内不再查库 |
| 生效规则（门控） | 门控 `:194`：`args.appDb ? loadEffectivePolicyRules(args.appDb, lane) : DEFAULT_POLICY_RULES` | **必填** `effectiveRules`（装配期解析，显式默认在装配期留痕）；`DEFAULT_POLICY_RULES` 从门控文件移除 |
| 决策缓存（门控） | 门控 `:332-338`：`args.appDb ? new AuditedDecisionCache(…) : EMPTY_CACHE` | **必填** `decisionCache` 视图（装配期构造 `AuditedDecisionCache` 注入）；`EMPTY_CACHE` 静默回退删除——缺视图 = 调用失败并落审计 |
| shell 预检 trusted-command 记账 | 门控 `:147` 透传 → `shellToolLoopHelpers.ts:57-58` `touchTrustedCommand(args.appDb, args.command)`（**写操作**，`args.appDb &&` 短路即静默停写，评审 B2） | **必填** `shellPrecheck` 材料（`ports.shellPrecheck`：trusted-command 读 `matchesTrustedCommand` 与写 `touchTrustedCommand` 随预检材料端口注入）——真相类，不允许静默停写 |
| 回答者策略 | `resolveLaneAnswererPolicy(appDb, confirmLane)` | 装配期解析传入（P5 消费） |
| 用量落库（观察类） | `recordStepUsage` / `recordTurnSummary` | `ports.usage`（宿主实现；失败降级重试 + 失败可观测，不改执行结论） |
| 诊断 | `safeAppendDiagnostic(appDb, …)` | `ports.diagnostics`（观察类，可 no-op） |
| 压缩事务 | `appendCompactionTransaction` | `ports.storage` 系列方法 |

**实现约束**：

1. 端口实现集中在 `invocationAssembler` + `electron/database/` 适配层；事务一律走 `runInTransaction(conn, fn)`，业务代码不发事务边界语句（仓库既有硬规则）。
2. **不改任何查询时序**：快照仍是首循环前构建、locale 仍是请求优先——只换数据来源，不动节奏。
3. **门控入参端口化随本阶段完成**（评审 B1，采纳方案 a）：`evaluateToolCallGate` 入参改为必填 `effectiveRules` + `decisionCache` 视图 + `shellPrecheck` 材料，由装配器注入；循环内唯一调用点（`toolChatLoop.ts:1495` 一带，现透传 `appDb` 处）同步改传端口材料。这是 P2 唯一横跨 Core 与 Safety 的接缝，且是**纯机械变更**：门控判定逻辑不动，语义收口（底线校验、来源标注）留给 P3。不这样做只有两条路、条条撞墙——继续透传库句柄则 P2 验收标准 1 必然失守（或靠改符号名刷指标）；停止传则门控在 P2→P3 窗口内静默回退 `DEFAULT_POLICY_RULES` + `EMPTY_CACHE` + 预检停写，恰好引入本计划要消灭的偏差 3 缺陷本身，且违反 §5 的 fail-closed 纪律。

**测试与验收**：§2.4 四条全过（其中标准 1 的 rg 归零含门控文件：`rg -n 'appDb' electron/toolChatLoop.ts electron/confirmation/toolCallGate.ts` → **0 行**）；新增「内存端口跑完整回合」测试（`src/shared` 端口类型 + 内存实现放 `electron/toolChatLoop.test.ts` 或新文件）；门控缺料 fail-loud 用例（缺 `effectiveRules` / 缺 `decisionCache` 视图 / 缺预检材料 → 调用失败 + 审计，**不回退**）；P0 门控特征化用例不改断言通过（B1 机械变更的行为等价证明）。

**风险**：见 §7.2 / §7.3。

### P3 偏差 3 语义收口：底线校验与规则来源（1 – 1.5 人日）

> 管道半（必填入参、两条静默回退消除、`DEFAULT_POLICY_RULES` 引用清除）已按评审 B1 前移至 P2；本阶段只剩语义。

**改动清单**：

1. **入口底线校验**（基线 §7.1）：门控入口校验传入规则集相对 `locked` 底线「可收紧不可放宽」，嵌套调用相对父调用取交集；违规 → 拒绝本次调用 + 落审计（`cause=rules-violated`，与正常拒绝可区分）。
2. **规则来源标注**（基线 §7.1）：生效规则集携带来源维度（内置默认 / 套餐 / 用户覆盖 / 迁移），保留被遮蔽规则的痕迹（哪条被哪条盖住）；审计能回答「我设的 allow 为什么没生效」。
3. 装配期默认解析的显式化收尾：内置默认（`DEFAULT_POLICY_RULES`）只作为装配期的显式数据源、留痕；门控文件在 P2 已不 import 它，本阶段补装配侧测试钉住。
4. fail-loud 审计口径统一：P2 引入的「缺料失败」在审计里使用可区分 `cause`（与 `rules-violated`、正常拒绝互斥，不混计）。

**明确不做**：偏差 15 剩余部分（user lane 的 strict/loose 宽严档位收口）——其前置 3 由 P2 + P3 共同解除，之后独立立项。

**测试**：底线违规拒绝 + 审计断言、嵌套交集用例、来源标注与被遮蔽痕迹断言、装配期默认解析留痕测试；`test:related` 门控与政策相关文件。

### P4 Profile 化：baseUrl 出契约 + effort 分档（偏差 5 + 6，2 – 3 人日）

**改动清单**：

1. **偏差 5**：开工先全量盘点 `rg -n 'baseUrl' src/shared electron --glob '!*.test.ts'`；随后从 `TurnExecutionConfig` 删除 `baseUrl`，网络目标移入宿主解析结果（`resolveTrustedTurnExecutionConfig` 的返回拆成「可声明快照」+「宿主绑定」两半，后者只经 `ports.credentials` 消费，不进可序列化契约）。
2. **偏差 6**：`src/shared/domainTypes.ts`：`ModelEntry` 增加能力标记（`supportsThinking?: boolean` 或 effort 档位上限）；新增 `profile.reasoning.effort`（`'off' | 'low' | 'medium' | 'high'`），`options.enableThinking` 布尔入口保留一个发布周期的兼容映射（`true → 'medium'`，显式注释迁移窗口）。
3. 宿主校验与降级：`invocationAssembler` 按 `ModelEntry` 能力校验 effort，不满足时按**定死规则**降级并落审计（`profile.reasoning.degraded`），fail-loud 不静默换档。
4. 子调用继承规则落地（基线 §5.4 规则 3/5 + §6.2 元规则）：模型默认继承父解析结果、effort 默认 `off`；审批 Profile 的 effort **下限**校验（安全属性）加进装配期断言。
5. 冻结语义不变：发起时解析、调用内冻结（既有测试不动）。

**范围说明**：设置页 UI 的 effort 档位选择器**不在本计划**（涉及 i18n、Config 组件，独立排期）；本阶段交付契约与主进程侧全部语义，全局配置的 `thinkingEnabled` 布尔继续作为默认值来源。

**测试**：能力校验 / 降级审计 / 继承与默认值 / 兼容映射的定向用例。

### P5 factsProvider 端口与裁决位收口（偏差 4，1 – 2 人日）

**改动清单**：

1. 抽取 `factsProvider` 端口（基线 §5.2）：门控内部构造事实的代码改为消费 `ports.hostFacts`（P1 已立接口位）；确认事实 = **工具声明的审批可见输入 ∪ factsProvider 补充**，逐项标注来源半区（工具契约 / 宿主环境），审计能回答「这个结论基于谁提供的事实」。声明为空与忘了声明必须可区分（基线 §5.2 的硬要求）。
2. `AutoEvaluator` 数据化：`autoEvaluator` 不再是按工具名写死的代码分支（`toolCallGate.ts:345` 一带），改为规则数据（`kind: 'auto-evaluator'` 条目 + lane 标注，沿用 20260917 已立的 lint 约束：allow / auto-evaluator 必须带 lane）；引擎把它执行为**确定性预过滤**，保留在回答者之前。**保留它的预过滤地位是有意决策**（审批计划已拍板），复核记录写清，避免被当成「没改完」。
3. `approvalTaskDigest` 从 `additionalContext` 正式接线为回答者线索包输入（审批计划既有语义平移）。

**测试**：既有 Skill v2 / 审批链测试不动断言通过；新增 factsProvider 注入与来源标注断言、auto-evaluator 规则化后的等价用例。

### P6 驱动源层统一投递入口（偏差 8 机制面，2 – 3 人日）

**改动清单**：

1. **投递面重盘点**（评审 N2，开工第一项）：以**实际发送调用点**为口径盘点，不限 `safeWebContentsSend` 一个符号。修订时点已核实：真实 `safeWebContentsSend(` 调用仅 `fileContentWatcher.ts:25`、`fileTreeSyncNotify.ts:9`；`claudeStreamHandlers.ts:2` 为死引用 import（本阶段顺手清除）；桌面终态实际通道是 `notifyMainWindow`（`claudeStreamHandlers.ts:51`）。盘点产出定性表：每个发送点归「投递入口机制面」还是「驱动权路径存量收敛」。
2. **`notifyMainWindow` 定性**（初判，盘点确认）：它是桌面驱动源自身的发送实现——P6 机制面只要求它**注册**为桌面 sink（可达性 + 投递实现），不改变其调用路径；把直发调用点改为走 `deliver` 属存量收敛，留驱动权路径。
3. 新增 `electron/driver/deliveryHub.ts`（名以实现为准）：`deliver(preference, payload)` 唯一入口；驱动源注册（桌面 sink、飞书、微信、butler 落盘）+ 可达性上报接口。
4. **送达记录**：哪条结果、投给哪个驱动源、何时、结果如何（Storage 落表，表名与保留期随实现定，沿用会话台账的保留语义风格）。
5. **有界补投三件套**：TTL（超期标「未送达且已过期」并落审计，不算失败）、取代键（新结果取代旧结果）、送达即止；三者由产生方声明，缺失按**显式声明的默认**（有限 TTL）——与 §7.1「不得静默默认」同一条纪律。
6. 首批迁移：butler `deliverTaskResult`（管家计划指定的第一个迁移对象）+ IM 回复型投递（`imRemoteOutbound` 的回复通道注册为 reply-to 目标）。
7. **不迁**：桌面终态发送通道（`notifyMainWindow` 路径）与 `fileTreeSyncNotify` / `fileContentWatcher` 直连点——仅要求注册，存量收敛随偏差 9/10/11 的驱动权路径处理（§9）。

**测试**：送达记录成对性（投递必有记录）、TTL 过期不补投、取代键命中即弃、单目标默认、多目标必须显式、可达性缺失时延后不丢弃（不变量风格用例，参照 `butlerAdmission.test.ts` 末组写法）。

### P7 按子调用裁剪工具集（偏差 16，2 – 3 人日）

**改动清单**：

1. `computeEffectiveTools` 增加按调用的裁剪输入：`profile.tools = { allow?: 闭集, deny?: 集合, capabilityClasses?: … }`，与既有 `exposureRules`、域配置合成；裁剪只落在**工具集**，不落提示词（§7.2 硬约束）。
2. **只能收窄不能加宽**：嵌套调用的工具集相对父调用取交集；装配期断言，违规拒绝并落审计。
3. 审批 Agent 的 `APPROVAL_READONLY_TOOLS` 平移为该机制的首个**数据化**实例（白名单内容不变，宿主从 profile 声明，不再硬编码在 `approvalAgent.ts`）；封闭集合断言（allow 列表外的名字一律无效且报错）。
4. MCP 工具同受裁剪（`mcpSnapshot` 在装配期已可过滤，与 builtin 合成后统一产出 `authorizedToolNames`）。

**测试**：交集语义（子 ⊆ 父）、封闭集违规报错、审批白名单等价平移、裁剪后 `compatToInternal` 一致性（B1 逆映射不破）、automation 封闭只读组合用例。

### P8 全量回归与偏差表回写（0.5 – 1 人日）

1. `npm test`（全量）+ `npm run build` + `typecheck:renderer` + `typecheck:shared` + `i18n:check`（若触及文案）。
2. 按基线 §10 复核记录的既有格式，回写 md 与 html 两份偏差表（§8 的预告表），每条附可复现证据命令与落地提交号。
3. 更新 `architect/README.md` 的文档索引（若其收录本计划）。

---

## 5. 安全设计要点（贯穿各阶段）

1. **fail-closed 全程不松动**：规则缺失 = 拒绝并落审计（不是回退内置规则）；回答者策略解析不出 = fail-closed；能力校验不过 = 拒绝或按定死规则降级 + 审计。任何一步都不得出现「取不到就按宽松默认走」。
2. **底线校验前移到 Core / Safety 入口**（P3）：可收紧不可放宽 + 嵌套交集；`locked` 集合与「不可变集」（递归终止条件、fail-closed 兜底、审计成对）语义不合并——`internalConfirmExemption` 保持代码写死、不进规则数据、不可被 custom 覆盖（基线 §7.2 已决，P3/P5 不得挪动）。
3. **出口只观察 + 失败语义两档分立**（评审 N3）：观察类端口（`events`、`ports.usage`、`ports.diagnostics`）抛错或不可用不得改变工具执行结论（降级重试，沿用 `securityAuditLog` 语义），但失败必须可观测、不静默；真相类端口（`persist`、`ports.shellPrecheck` 的 trusted-command 记账）失败 = 调用显式失败 + 可区分错误码 + 审计，**不允许静默停写**——`touchTrustedCommand` 静默停写会隐式改变 legacy 自动放行资格，属安全行为变更（评审 B2）。反向影响流程的能力位本期不存在。
4. **决策缓存语义随端口保持**：一事一议、agent 裁决不写缓存（roadmap §8 已决）、写入准入不放宽；端口化只换实现宿主，不动语义。
5. **新端口不得新增模块级可变状态**（SDK 决策 §6 硬约束 3 的预防版）：状态随 invocation / 装配器实例走，不随进程走；四处既有模块级状态（`builtinExecutors` / `confirmation/audit` / `mcpToolExecutor` / `confirmId`）的消除归属偏差 18，不在本计划。
6. **审计成对**：每个新增拒绝/降级路径（规则违规、能力降级、投递过期、裁剪违规）都有 `cause` 可区分地落审计，不与正常拒绝混计。

---

## 6. 验收边界（开工对齐项）

**当前环境可单测验证**：P1 – P7 的全部行为等价与语义变更（定向 + related 测试）、§2.4 的内存端口回合测试、P6 的投递不变量（假 sink）、P3/P4/P5/P7 的纯函数断言。

**需真机 / 外部系统验收**（各阶段收尾时人工过一遍，问题记录不阻塞提交）：

- 桌面：`npm run dev` 起真实会话跑一轮带工具调用的对话；关窗后回合照常收敛（偏差 1 的既有行为不回退）；确认卡片真人批/拒。
- IM：飞书 / 微信远程托管一轮（真实收发 + 回执 + 审计文件落盘）。
- 桌面外设：浮动通知弹出（P1 改造点）、文件树刷新（`onFileTreeChanged` 出口）、托盘。
- 连通性：设置页 `test-connection` 对真实服务（P4 改动凭据解析路径后必测）。

---

## 7. 风险与回退

| # | 风险 | 缓解 / 回退 |
| --- | --- | --- |
| 1 | 签名重构波及 4 个调用方与既有测试 | P1 严格「形状先行、行为零变化」，适配层展开旧变量名；每阶段单提交，可独立 revert |
| 2 | P2 期间浮现隐藏耦合（事务边界、单连接假设、时序依赖） | 端口实现一律走 `runInTransaction`；发现新耦合记录进偏差 2 复核记录并销号，不私改范围；最坏回退 = 保留该消费点并在表内注明（目标仍是 0 处） |
| 3 | MCP 快照从循环内改装配期引入时序差异 | 不改时序：快照仍在首循环前构建（现状即如此），只换数据来源与持有者 |
| 4 | effort 分档触及 AppConfig schema 与设置面 | 契约先行（invocation 级可覆盖），全局 `thinkingEnabled` 布尔保留为默认来源 + 一个发布周期兼容映射；UI 独立排期 |
| 5 | `baseUrl` 有未知消费方（usage 快照、surface header 等） | P4 开工先全量盘点（§4 P4 改动清单第 1 条），消费方逐个迁移后再删字段；禁止先删后补 |
| 6 | 仓库并行演进（本计划摸排期间已发生一次 HEAD 前进，新增 2 类 appDb 消费） | 每阶段开工重跑 §1 证据命令；行号漂移不回填，符号可复现；若新消费点出现，先并入 P2 销号表再动工 |
| 7 | P6 与驱动权路径的边界被突破（顺手迁桌面直发点） | 显式不做清单（§10）+ 复核记录留痕；迁移请求一律转回偏差 9/10/11 的计划 |
| 8 | P2 横跨 Core 与 Safety 接缝（B1 修订引入） | 接缝限定为「门控入参机械端口化」：门控判定逻辑零改动；P0 特征化用例钉住门控行为，P2 验收行为等价、P3 验收语义新增，两批分开 |

---

## 8. 偏差表回写预告（P8 产出）

| 偏差 | 预期回写状态 | 依据 |
| --- | --- | --- |
| 1 | 已解决（20260917，不变） | — |
| 2 | **已解决** | `rg -n 'appDb' electron/toolChatLoop.ts` → 0 行；内存端口回合测试入仓 |
| 3 | **已解决**（P2 管道 + P3 语义） | `rg -n 'appDb\|DEFAULT_POLICY_RULES\|EMPTY_CACHE' electron/confirmation/toolCallGate.ts` → 0 行；底线校验 / 嵌套交集 / 来源标注测试入仓 |
| 4 | **已解决**（AutoEvaluator 保留为确定性预过滤属有意决策，复核记录注明） | factsProvider 端口 + 规则化条目 + 来源标注审计 |
| 5 | **已解决** | `rg -n 'baseUrl' src/shared/assistantFactAggregator.ts` → 0 行 |
| 6 | **已解决**（设置面 UI 例外注明，独立排期） | effort 分档 + ModelEntry 能力标记 + 降级审计 |
| 8 | **部分解决**（机制面收口 + butler/IM 首批迁移；存量直连点收敛随 9/10/11） | deliveryHub 入库 + 桌面 sink 注册（`notifyMainWindow` 定性入盘点表）；投递面盘点表入附录；`claudeStreamHandlers` 死引用清除 |
| 16 | **已解决**（通用裁剪机制；SubAgent 派生工具业务属块 3） | profile.tools 裁剪 + 交集断言 + 审批白名单平移 |

---

## 9. 与既有文档的关系 / 债务认领

| 文档 | 关系 |
| --- | --- |
| `architect/product-architecture-design.md` | 母本；本计划 = 其 §10 调用契约路径的工程化，接口形状全部引自 §5.2 / §6.2 / §7 / §8，不改写理想态 |
| `architect/agent-core-roadmap.md` | 块 1（Invocation）= P1 + P2 的完整版，本计划落地后块 1 状态可改「已交付（子调用准入等块 4 项除外）」；块 2 已由管家/审批两计划交付大半，P3/P5 收其尾；块 3 的前置（16）由 P7 解除 |
| `butler-agent-shortest-path-plan.md` §11 | 认领其债务第 1 条（偏差 2/3 端口与脱库）、第 2 条（偏差 8：`deliverTaskResult` 成统一入口第一个迁移对象）、第 7 条（偏差 16 机制、偏差 6 分档） |
| `approval-agent-shortest-path-plan.md` §8 | 认领其移交项「块 1 Invocation 收敛后 AgentChannel 装配点平移」（P2 装配点 + P5 线索包接线） |
| `architect/agent-sdk-shape-decision.md` §6 | 三条硬约束取费两条（契约禁函数句柄、端口一律接口）随 P1 落实；第三条（多实例）留偏差 17/18 |
| `architect/confirmation-answerer-and-auto-approval-design.md` | P5 承接其 facts / 线索包语义，不改已交付行为 |

---

## 10. 明确不做（非目标）

1. 不动驱动权：偏差 9（回合发起与出站分类回主进程）、10（IPC 面拆分）、11 剩余（列表失效通知契约）、12 —— 渲染端只做 P1 签名适配（若有），不迁任何决定。
2. 不迁桌面存量投递点（终态发送通道 `notifyMainWindow` 路径、文件树 / 文件内容直连）——P6 仅要求注册为桌面 sink，迁移随驱动权路径（9/10/11）收敛（评审 N2 澄清后的口径）。
3. 不做 SubAgent 派生工具与嵌套执行域（块 3 业务）——P7 只交付裁剪机制。
4. 不做偏差 15 剩余（user lane 宽严档位改制）——P3 解除其前置后独立立项。
5. 不做 SDK 复用面（偏差 17 – 20 的打包边界、依赖护栏、验收测试），只遵守「契约可序列化、端口接口化」两条免费约束。
6. 不动横切项：i18n 双机制（13）、日志保留期（14）、台账保留语义归位（24）。
7. 不重写工具框架与 registry、不动存储 schema 主干（沿用 v14+ 迁移线）、不把事件出口总线化、不引入 Run 层（roadmap §7 同款约束）。

---

## 附录 A：Core 内 appDb 消费点销号表（P0 开工实测，2026-09-18，HEAD `784d86b3`）

> 实测基数：`rg -c 'appDb' electron/toolChatLoop.ts` → **31**（与 §1 摸排一致；评审时点 35 为时点差异）。
> 销号口径：P2 完成后 `rg -n 'appDb' electron/toolChatLoop.ts electron/confirmation/toolCallGate.ts` → 0 行。
> 门控侧 3 处（`toolCallGate.ts:147/:194/:332-338`）随 P2 门控入参端口化一并销号（B1）。

| # | 位置（toolChatLoop.ts 行号，开工实测） | 符号 / 消费 | P2 去处 |
| --- | --- | --- | --- |
| 1 | `:452` | `appDb?: AppDatabase` 字段声明 | 签名删除（P1 过渡 `ports.legacy.appDb`） |
| 2 | `:545` | `safeAppendDiagnostic(args.appDb, serverId, entry)` | `ports.diagnostics`（观察类） |
| 3 | `:567` | `recordTurnSummary(args.appDb, …)` | `ports.usage`（观察类） |
| 4 | `:609` | 内部上下文结构平移（`appDb` 传入内部对象） | 随其他条目消除 |
| 5 | `:638` | `getSession(appDb, sessionId)?.metadata`（system 派生、shellOutputMode） | `loadContext` 会话材料 |
| 6 | `:702` | `loadEffectivePolicyRules(appDb, exposureLane)`（暴露面规则） | 装配期解析随 invocation 传入 |
| 7 | `:704-705` | `buildSnapshotFromDb(appDb, …)`（MCP 快照） | 装配期构建传入 |
| 8 | `:831` | `resolveRequestLocale(payloadLocale, appDb)` | 装配期定值 |
| 9 | `:1041` | `recordStepUsage(appDb, …)` | `ports.usage`（观察类） |
| 10 | `:1223-1229` | `scheduleSessionTitleSuggestion({ db: appDb, … })` | `persist` + `events.onTitleGenerated` |
| 11 | `:1336` | `resolveMcpExecutor(…, appDb)` | `ports.tools`（连接管理器） |
| 12 | `:1508` | `evaluateToolCallGate({ appDb, … })` | 门控入参端口化（effectiveRules / decisionCache / shellPrecheck） |
| 13 | `:1799` | `getSession(appDb, sessionId)`（浮动通知会话名） | `loadContext` 会话材料 |
| 14 | `:1821` | `resolveLaneAnswererPolicy(appDb, confirmLane)` | 装配期解析传入（P5 消费） |
| 15 | `:1839` | 回答者装配 `db: appDb as AppDatabase` | 回答者端口（P5） |
| 16 | `:2067-2074` | browser navigate 信任双写 `recordUserAnswerFromDecision({ db: appDb })` | `ports.decisionCache` 写通道（真相类） |
| 17 | `:2109-2116` | browser act 信任双写 `recordUserAnswerFromDecision({ db: appDb })` | 同上 |
| 18 | `:2274` | 工具执行上下文 `appDatabase: appDb`（browserExecutor 凭据 / remoteSession / workDir 执行器消费） | 工具执行上下文随 `ports.tools` / 装配期材料重构 |
| 19 | `:2422-2425` | `updateSession(appDb, sessionId, …)`（recovery skill fragment 写） | `persist` |
| 20 | `:2529-2542` | `resolveMcpExecutor` 辅助：`listProfiles` / `createMcpOAuthClientProvider` / `getSecret` / `getDiagnostics` | `ports.tools` |

门控侧（`electron/confirmation/toolCallGate.ts`）：

| # | 位置 | 符号 / 消费 | P2 去处 |
| --- | --- | --- | --- |
| G1 | `:147` | 预检透传 `appDb: args.appDb` → `shellToolLoopHelpers.ts:57-58` `touchTrustedCommand`（写） | `ports.shellPrecheck`（真相类，不允许静默停写） |
| G2 | `:194` | `args.appDb ? loadEffectivePolicyRules(…) : DEFAULT_POLICY_RULES`（静默回退） | 必填 `effectiveRules`（装配期解析留痕） |
| G3 | `:332-338` | `args.appDb ? new AuditedDecisionCache(…) : EMPTY_CACHE`（静默回退） | 必填 `decisionCache` 视图（装配期构造注入） |

P0 特征化测试基线（本阶段新增文件）：

- `electron/confirmation/toolCallGate.dbFallback.test.ts` —— 双静默回退 + trusted-command 停写 + 裁决顺序（deny 覆盖落 ask 后缓存可放行）钉住；P2 后改写为 fail-loud 断言。
- `electron/toolChatLoop.maxRounds.test.ts` —— `maxToolLoopRounds` 真跑封顶（`TOOL_LOOP_MAX_ROUNDS_EXCEEDED(n)`）。
- `electron/claudeStreamHandlers.callerContract.test.ts` —— 桌面调用方出口接线 / 会话锚点 / appDb 注入 / lane 缺省。
- `electron/remote/imRemoteAgent.test.ts`（追加 describe）—— 远端 remoteContext / 出口接线透传。
- 既有覆盖确认：审批调用方四维度（lane / exemption / rounds / 封闭工具集）已在 `approvalAgent.test.ts:246-272`；事件出口 Core 级行为已在 `toolChatLoop.windowless.test.ts`；递归守卫 gate 级已在 `recursionGuard.test.ts`；管家 lane 行为（automation 写拒绝）已在 `butlerInvoker.test.ts`。

---

## 11. 偏差表回写（P8 实际产出，2026-09-19）

> 实施基线：worktree 分支 `agent-core-contract-path`（自 `784d86b3` 起），阶段提交 P0 `8ad19d6f` → P1 `033beb8e` → P2 `fefd5646` → P3 `b36c95cf` → P4 `ce08d1ff` → P5 `22a8a2f7` → P6 `591c110b` → P7 `22a9fa9b`。
> 每条附可复现证据命令（行号会漂移，以符号为准）。

| 偏差 | 回写状态 | 依据（证据命令 + 落地提交） |
| --- | --- | --- |
| 1 | 已解决（20260917 主体；P1 收尾） | `rg -n 'floatingNotificationManager' electron/toolChatLoop.ts` → 仅注释（参数已删除，经 `events.notify` 出口，宿主实例由装配器包装）；P1 `033beb8e` |
| 2 | **已解决** | `rg -n 'appDb' electron/toolChatLoop.ts electron/confirmation/toolCallGate.ts` → 0 行；`rg -n "import .*database" electron/toolChatLoop.ts` → 0 行；内存端口完整回合测试入仓（`electron/toolChatLoop.inMemoryPorts.test.ts`：带工具调用 + 一次批准 + 一次拒绝，不启动 Electron、不碰 SQLite）；§2.4 标准 3（persist 失败可观测 + rethrow）与标准 4（端口接口化，内存/SQLite 双实现不改 Core）同步达成；P2 `fefd5646` |
| 3 | **已解决**（P2 管道 + P3 语义） | `rg -n 'appDb\|DEFAULT_POLICY_RULES\|EMPTY_CACHE' electron/confirmation/toolCallGate.ts` → 0 行（门控不再持库、无静默回退）；底线校验（`validatePolicyRulesFloor`，违规 → deny(rules-violated) + cause 审计）、嵌套交集（`intersectPolicyRulesWithFloor`，子 allow ⊆ 父 allow + deny 继承）、来源标注（`resolveEffectivePolicyRulesWithOrigin` + 审计 ruleOrigin）测试入仓（`electron/confirmation/policyFloor.test.ts`）；缺料 fail-loud（`TOOL_GATE_MATERIALS_MISSING` + cause 可区分审计）；P2 `fefd5646` + P3 `b36c95cf` |
| 4 | **已解决**（AutoEvaluator 保留为确定性预过滤属有意决策） | factsProvider 端口（`ToolCallGateArgs.factsProvider`）+ 事实来源半区标注（`ContentFacts.factSources`：tool-contract / host-environment）+「声明为空 vs 忘了声明」可区分（`factsProviderDeclared`）+ 审计 factSources；AutoEvaluator 数据化（预过滤器路由由 auto-evaluator 规则的 match.toolName + lane 驱动，非代码分支）；`approvalTaskDigest` 接线（additionalContext → 展开层 → AgentChannel 线索包，两端测试钉住）；测试 `electron/confirmation/factsProvider.test.ts`；P5 `22a8a2f7` |
| 5 | **已解决** | `rg -n 'baseUrl' src/shared/assistantFactAggregator.ts` → 0 行（TurnExecutionConfig 无 baseUrl）；网络目标归 `ports.credentials.networkTarget`（宿主绑定，不进可序列化契约）；桌面 frozen.baseUrl 伪造路径同步移除；P4 `ce08d1ff` |
| 6 | **已解决**（设置面 UI 例外注明，独立排期） | `profile.reasoning.effort`（off/low/medium/high）+ `ModelEntry.supportsThinking` 能力标记 + 宿主校验降级（不支持 → off + `degraded` 留痕 + `agent.profile.reasoning_degraded` 日志，fail-loud）；`enableThinking` 布尔保留一个发布周期兼容映射（true→medium）；子调用默认 off（审批显式 effort:'off'）；冻结语义不变；测试 `electron/runtime/profileReasoning.test.ts`；设置页 effort 档位选择器不在本计划（i18n/Config 组件独立排期）；P4 `ce08d1ff` |
| 8 | **部分解决**（机制面收口 + butler 首批迁移；存量直连点收敛随 9/10/11） | `electron/driver/deliveryHub.ts` 入库：deliver(preference, payload) 唯一入口 + 驱动源注册/可达性 + 送达记录（成对性，agentLogger 台账 + 内存窗口）+ 有界补投三件套（TTL 缺省 10min 显式 / 取代键 superseded / 送达即止 already-delivered）+ 延后不丢弃（deferred + flush）；butler `deliverTaskResult` 迁入（`deliveryRecords` 随结果返回，降级语义保持）；main.ts 装配共享 hub 并注册桌面 sink（系统通知）；`claudeStreamHandlers.ts` 死引用 import 清除（P6 盘点确认，本分支上该 import 已不存在）；桌面 `notifyMainWindow` 路径与 fileTreeSyncNotify / fileContentWatcher 直连点**未迁**（驱动权路径认领）；测试 `electron/driver/deliveryHub.test.ts`（不变量风格 7 条）；P6 `591c110b` |
| 16 | **已解决**（通用裁剪机制；SubAgent 派生工具业务属块 3） | `profile.tools.trim`（allow 封闭集 / deny 收窄）→ `computeEffectiveTools` 在 builtin+MCP 合成层统一过滤（MCP 同受裁剪，authorizedToolNames 同步）；嵌套交集装配期断言（子 allow ⊄ 父 allow → `TOOLS_TRIM_WIDEN_DENIED` + `agent.tools.trim_widen_denied` 日志）；审批白名单数据化平移（`electron/confirmation/approvalToolset.ts`，首个实例，白名单内容不变，re-export 兼容）；测试 `electron/effectiveTools.trim.test.ts`；P7 `22a9fa9b` |

### 实施备注（复核记录）

1. **B1 落地确认**：门控入参端口化随 P2 完成（P2/P3 之间无「循环已脱库、门控仍持库」窗口）；P0 的 dbFallback 特征化测试在 P2 改写为 fail-loud 断言（`toolCallGate.ports.test.ts`）后删除。
2. **N1 关闭确认**：`ports.legacy.appDb` 过渡豁免已随 P2 删除（`rg -n 'legacy' electron/toolChatLoop.ts` → 仅注释）。
3. **N3 落地**：真相类（persist / shellPrecheck 记账）/ 观察类（usage / diagnostics / events）失败语义分立——真相类失败落 `agent.persist.failed` + rethrow；观察类降级不改执行结论。
4. **裁决顺序澄清**（P0 特征化发现）：custom deny 覆盖 auto-evaluator 条目时，readonly 放行失效落 ask 兜底；ask 分支查询决策缓存，既有会话信任仍可放行（cache-hit）。该行为已在 `toolCallGate.ports.test.ts` 钉住。
5. **P6 送达记录实现取舍**：按「沿用会话台账的保留语义风格」落 agentLogger JSON Lines + 内存窗口（不动 SQLite schema 主干，规避 v14+ 迁移线变更）；跨进程持久化送达台账留待驱动权路径或后续阶段评估。
6. **存量测试失败清零（P8 后追加）**：P8 期间基线（`784d86b3`）即红的 11 条平台性失败已修复——ripgrep 系测试期望改为与实现同构的 `path.resolve`；`safeJoin` 修 base 未归一化的盘符前缀误判真 bug（`scripts/prepare-ripgrep.mjs`，Windows 上原本无法安全解压）；symlink 特权用例改 junction 或条件跳过（POSIX 宿主覆盖）；`safeAtomicWrite` 新增 `withTransientLockRetry`（Windows 杀软/索引器瞬时锁）并覆盖全部 9 处 rename/link 提交点（含 `imProcessedStore` 等裸 rename 写点，属产品健壮性修复）；vitest 两项目 `testTimeout` 5s→15s、两处性能界限断言去时长耦合。最终连续两轮 `npm test` 全绿（630 文件 / 4206 通过 / 0 失败）。
7. **评审修复（2026-09-19，评审报告 docs/review/agent-core-contract-path-code-review-v1.md）**：P0-1 origins/policyOrigins 键名失配（装配器写入与门控消费键名不一致，as 强转掩盖，ruleOrigin 审计在生产链路为死代码）——键名统一 + 契约补声明 + 端到端回归断言；P0-2 deliveryHub deferred 按 id 重查驱动源的错投隐患——改为入队快照 driver 引用、覆盖注册清积压落 superseded、队列有界、移除 main.ts 死代码注册；P1-1 底线校验补 when + match 条件比对（防 locked 条目条件掏空）。提交 7dc0f767。
8. **待真机/外部系统人工验收**（§6 清单，不阻塞提交）：桌面 dev 真实会话带工具回合、关窗收敛、确认卡片真人批/拒；飞书/微信远程托管收发+审计落盘；浮动通知弹出（P1 改造点）；设置页 test-connection（P4 凭据路径改动后必测）。
8. **worktree 依赖变化**：实施中段主仓库 `node_modules` 被外部清空，worktree 已改为独立 `npm ci`（junction 解除），后续在该 worktree 工作无需依赖主仓库。
