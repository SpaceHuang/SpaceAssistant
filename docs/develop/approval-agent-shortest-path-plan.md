# 安全审批 Agent 最短路径落地开发计划

> 状态：v2 修订（2026-09-17 评审阻断项 B1/B2 与非阻断项 N1–N8 已吸收；评审报告 `docs/review/approval-agent-shortest-path-plan-review.md`）
> 基线：工作区 HEAD（2026-09-17）
> 上游设计：`docs/develop/architect/confirmation-answerer-and-auto-approval-design.md`（块 2 方案，本计划承接其全部硬不变量 I1–I5 与变更清单）
> 理想态依据：`docs/develop/architect/product-architecture-design.md` §7「Safety：策略引擎与确认通道」、§7.2「多轮回答者的装配与发起」
> 一句话：把「未命中规则与缓存时向用户询问」的回答者位置打开，先堵住缓存与归因两道防线（行为等价），再把 automation lane 的无回答者兜底（RejectingChannel）升级为审批 Agent（AgentChannel），让安全策略的询问动作可以由 Agent 依据事实裁决。

---

## 1. 结论与定位

### 1.1 一句话结论

**最短路径不需要新架构，只需要三步**：堵住「Agent 裁决会被固化成用户信任」的缓存口子（I3）→ 把回答者从 lane 里拆出来做可解析（I1）→ 在 automation lane 上把 `RejectingChannel` 替换为 `AgentChannel`（本设计的核心增量）。管家最短路径计划（已合并）已经打通了 automation lane 的可达性、穿透与无回答者兜底，本计划是其债务移交清单第 4 条的兑现。

### 1.2 为什么这是最短路径

1. **回答者位置已经存在**。`ConfirmationChannel { request; cancel }` 接口（`src/shared/confirmation/types.ts:169`）本就是可插拔形状，`channelFor` 是唯一分派点（`electron/confirmation/channels.ts:107`）。接入 Agent 不改链路，只改分派依据与新增一个实现——这正是理想态 §2.3 推论「审批与 SubAgent 不新增链路」的落点。
2. **非窗口调用链已有先例**。管家 `butlerInvoker` 已示范完整形态：`createSession(ownership, visibility)` → `resolveTrustedTurnExecutionConfig(db, sessionId, lane)` → `runToolChatSession({ lane })`（`electron/butler/butlerInvoker.ts:116-245`）。审批 Agent 作为 Core 的另一次调用，直接复用该模式，**不等块 1 的完整 Invocation 契约**（会话归属两列 `ownership/visibility` 已随管家 P3 落地，`internal/hidden` 有现成落点）。
3. **安全语义已备齐一半**。`automation` lane 显式规则、`RejectingChannel` fail-closed、`ConfirmOutcome.rejected.reason='no-answerer'`、decision cache 按真实 lane 隔离——全部是管家 P2 的已验收产出。本计划在其上做「兜底升级」，而不是从零建安全模型。

### 1.3 选定与不选

| 决策点 | 选定 | 不选与理由 |
| --- | --- | --- |
| 审批 Agent 的调用形态 | 复用管家执行链模式（in-process `runToolChatSession`） | 不等块 1 Invocation：块 1 是「完整收敛路径」的公共前置，最短路径下管家已证明可直接驱动；块 1 落地后 AgentChannel 无需改动（它只见 `ConfirmOutcome`） |
| 递归终止条件（I5）的落法 | 引擎级递归守卫：执行链传内部标记，gate 把 require-confirm 改写为 `deny(cause=recursion-blocked)` | 不做成规则：进规则集就会被 `custom`/`loose` 改坏，收紧致自动审批静默停摆（方案 §4.4、理想态 §7.2 不可变集） |
| 先改哪条链路 | automation lane（无人值守） | 桌面自动审批档位是独立产品决策（默认关闭、需设置面），不进最短路径；wechat/feishu 本期不动（方案 §11） |
| 成本优化（priorVerdicts） | 推迟到 P2 之后按实测决定 | 先拿到端到端可用与审计数据，再决定优化形态（方案 §4.10 本就标注「除非另行决定」不做跳过式复用） |

## 2. 现状基线与证据（2026-09-17 摸排）

方案文档基线为 2026-09-12；管家最短路径计划已在此期间合并（分支 `butler-agent-shortest-path`）。逐项核对结果：

### 2.1 已就绪（管家计划新兑现，方案文档写作时尚不存在）

| 能力 | 位置 | 说明 |
| --- | --- | --- |
| lane 显式传入与穿透 | `electron/confirmation/toolCallGate.ts`（`ToolCallGateArgs.lane`） | `evaluateToolCallGate` 消费显式 lane；decision cache 按真实 lane 为键，automation 不命中桌面信任条目 |
| automation 显式规则 | `src/shared/policy/defaultRules.ts` | 只读 allow 显式规则 + catch-all `automation-default-confirm`（`defaultRules.ts:291-298`，`ask`+`locked`）——「写操作 confirm（无回答者 → 拒绝）」是它的落点效果而非逐条显式规则；`loose` 禁用 guard；「allow/auto-evaluator 规则必须有 lane 限定」lint 单测（`defaultRules.lint.test.ts:8-16`；desktop-only 目前是数据约定而非 lint 强制，由 P2-8 收紧） |
| 无回答者兜底 | `electron/confirmation/channels.ts:129`（`RejectingChannel`） | automation 未命中即拒绝，`reason: 'no-answerer'`（`ConfirmOutcome` 已扩展） |
| 非窗口执行链先例 | `electron/butler/butlerInvoker.ts:116-245` | createSession(ownership='automation') → resolveTrustedTurnExecutionConfig → runToolChatSession，含准入（`butlerAdmission`：并发=1 + 小时上限） |
| 会话归属两列 | sessions 表 `ownership`/`visibility` | `internal`/`hidden` 已有枚举与谓词，审批内部会话直接可用 |

### 2.2 仍存在的缺口（方案文档缺口 1–9 逐项复核，行号为今日实测）

| # | 缺口 | 今日证据 |
| --- | --- | --- |
| 1 | 通道按 lane 硬编码，无回答者解析 | `channelFor` 仍按 lane 分派（`channels.ts:107`）；`ConfirmAnswerer*`/`ApprovalVerdict`/`AgentChannel` 全仓库 0 命中 |
| 2 | `auto-evaluator` 同步三分支装不下 Agent | `toolCallGate.ts:339`（方案已判：不合并，Agent 挂回答者位置） |
| 3 | 拒绝理由无回传路径 | `rejectReason` 仍三值（`toolChatLoop.ts:1572`），文案硬编码 |
| 4 | 安全拒绝与执行失败共用连错计数 | `MAX_CONSECUTIVE_SAME_TOOL_ERROR = 3`（`toolChatLoop.ts:297`，按 `toolName\0error\0identity` 键控 `:346`）；拒绝文案硬编码使同类安全拒绝必然同键，凑满 3 次中止 Turn |
| 5 | 写缓存不看回答者 | `source: 'user-confirm'` 两处（`toolChatLoop.ts:1920`、`:1948`）只判 `outcome === 'approved'` |
| 6 | 记忆资格无回答者维度 | `deriveMemoryEligibility(facts, lane)`（`src/shared/policy/memoryEligibility.ts:14`），无第三参 |
| 7 | 审计 actor 无法表达 Agent | `actor: 'system'` 硬编码（`channels.ts:44`、`:189`、`auditedDecisionCache.ts:41/81/94`、`toolCallGate.ts` policy.decision）；注意后两类不是「回答者」事件，P0-4 据此收窄修复范围 |
| 8 | 超时硬编码 | `CONFIRM_MS = 5min`（`electron/toolConfirmRegistry.ts:16`），`ConfirmRequest.timeoutMs` 传 `null`（`toolChatLoop.ts:1702` 附近） |
| 9 | `loose` 是按宽严分化的旋钮（可配出「无人监督 + 自动放宽」组合） | 部分关闭：管家 P2 已加 automation lane 的 `loose` 禁用 guard；回答者维度的同一约束由本计划 P2-5 承接（`kind='agent'` 的 lane 不得 `loose` / `custom` 向下覆盖） |

结论：**方案文档 §5 变更清单全部仍然有效**；管家计划消除了其中「automation 无生产者」这一条的前置障碍，其余缺口原样待修。

## 3. 阶段计划总览

P0、P1 行为等价可独立交付（管家链路即时受益），P2 拨动 automation 回答者开关，P3 之后不在本次范围。

| 阶段 | 内容 | 依赖 | 交付判据 |
| --- | --- | --- | --- |
| P0 | 类型 + 缓存写入准入 + 审计归因（I3 收口） | 无 | 行为零变化；I3 回归用例转绿；审计可区分来源 |
| P1 | 回答者解析 + DenyChannel + 拒绝理由回传 + 计数口径分离 + 超时可配（I4 铺垫） | P0 | 现有行为逐项等价；管家被拒后 Turn 不中止且理由可读 |
| P2 | security-approval Skill + ApprovalProfile + 审批执行链 + AgentChannel + 递归守卫（I5）+ automation 回答者切换 + 准入死锁禁令 + desktop-only lint 收紧 | P1 | automation lane 端到端：只读放行、写操作 Agent 裁决、降级矩阵全 fail-closed |
| 后续 | 桌面自动审批档位、审计页 actor 筛选、priorVerdicts 成本优化、块 1 Invocation 收敛 | 另行计划 | 不在本文承诺 |

## 4. 阶段详细设计

### P0 缓存与归因防线（行为等价，先行独立交付）

**为什么最先做**：这是接入任何非人回答者的**前置安全条件**——缺口 5 意味着今天若直接接上 AgentChannel，「Agent 批的」会以 `source: 'user-confirm'` 固化进 decision cache，与 I3（一事一议）直接冲突。先堵口子再开闸门。

**改动点**（承接方案 §5，细化到可验收）：

1. **类型**（`src/shared/confirmation/types.ts`）：`ConfirmAnswererKind`（`'user' | 'agent' | 'deny'`）、`ConfirmAnswererPolicy`、`ConfirmAnswererMap`、`ApprovalReason`/`ApprovalVerdict`；`ConfirmOutcome` 各变体加可选 `reason?: ApprovalReason` 并新增**必填 `cause`**（`ConfirmOutcomeCause`：`user-approved / user-denied / agent-deny / unavailable / timeout / unparsable / config-error / recursion-blocked / no-answerer`）；`SecurityAuditEvent.actor` 加 `'agent'` + `actorRef?: { profileId; model?; invocationId? }`。
   - 必填 `cause` 的迁移策略：类型先行 + 落审计处逐点补齐；单测断言每条 `confirm.outcome` 事件 `cause` 非空。
2. **记忆资格**：`deriveMemoryEligibility(facts, lane, answererKind)`，`answererKind !== 'user' → 'none'`（理由 `non-human-answerer`）。回归断言：`answererKind='user'` 时输出与既有测试向量逐项一致。
3. **修两处写缓存**（`toolChatLoop.ts:1920`、`:1948`）：写入前断言本次回答者为 `user`；`recordUserAnswerFromMemoryTiers` 增加 `answererKind` 参数，非 `'user'` 直接抛错（三道闸：资格闸 / 档位闸既有 / 写入断言，方案 §4.7）。
4. **审计如实归因（范围收窄，评审 B1）**：只改「归因于回答动作」的事件——`confirm.request` / `confirm.outcome` 共用的 `eventBase`（`channels.ts:44`、`:189`）改为真实回答者（本阶段恒为 `'user'`，P2 的 AgentChannel 沿用同一口径落 `'agent'`）。**明确保留 `actor: 'system'` 的三类位置**：`cache.hit`（`auditedDecisionCache.ts:41`——命中是缓存系统在代答，本次没有回答者；若要表达代答的原始来源，另设字段引用源条目的 `source`，不占 actor）、`cache.generation-reset` / `cache.expire-dormant`（`:81`/`:94`，纯系统生命周期事件，actor 如实就是 system）、`policy.decision`（`toolCallGate.ts`，发生在询问之前，此刻不存在回答者）。照字面「替换全部」会把「谁批的」口径弄失真，与本计划 §5 审计五问直接冲突。

**验收口径**：
- 现有桌面 / IM / automation 三链路测试全绿、行为零变化（`user` 回答者路径逐项等价）。
- **I3 回归（验收锚点）**：构造「require-confirm + memoryTiers 非空 + 回答者为 agent + browser navigate」场景（mock channel 返回 approved），断言 decision_cache 无新增行、无 `cache.write` 审计——该用例在今日代码上**红**，修复后转绿。
- 审计事件可按 actor 过滤；单测断言与 P0-4 收窄范围一一对应：`confirm.*` 事件 actor 如实，缓存生命周期（`cache.hit` / `generation-reset` / `expire-dormant`）与 `policy.decision` 事件 actor 保持 `'system'` 不误伤。

### P1 回答者解析与拒绝理由回传（行为等价，管家链路即时受益）

**为什么在 Agent 之前**：缺口 3/4 对今天的管家链路就是现行伤害——automation 拒绝文案进连错计数，管家「换方案」能力被压制成「Turn 中止」。这一阶段不接 Agent 也值得独立交付。

**改动点**：

1. **`resolveConfirmChannel`：二维解析模型（评审 B2）**（`channels.ts`）：维度一为**回答者种类**（`user / agent / deny`，由回答者配置解析，替代按 lane 硬编码），维度二为**传输通道**（desktop 窗口确认卡 / IM 出站消息，由 lane 与 remoteContext 派生）——现状 `channelFor` 的 lane 映射实为「user 之下的传输分叉」（desktop → `DesktopChannel`，wechat/feishu → `ImRequestChannel`），收敛为传输维度后不再与回答者种类混在一维里。`kind='user'` 按传输落实现：desktop 落窗口卡、wechat/feishu 落 IM 出站（现状等价）；`kind='agent'` 落 AgentChannel（P2）；新增 `DenyChannel`（fail-closed 兜底）。默认值表：desktop/wechat/feishu → `user`（行为不变），automation → 本阶段仍落 `deny`（保持现状拒绝语义，仅换实现路径），**P2 再切 `agent`**。fail-closed 逐格定义：配置损坏 / Profile 缺失 → `deny` + 告警审计，**绝不回退为 `user`**（I4：无人场景回退问用户 = 挂死 5 分钟）；`deny` 的用户可见形态按传输区分——桌面为静默拒绝（工具结果带理由），IM 为回一条拒绝说明（不静默吞掉远端用户的等待）。
2. **拒绝理由回传**：`rejectReason` 扩展为带来源形态（`'user' | 'policy' | 'agent' | 'timeout' | 'no-answerer' | …`）；模型可见文案由 `reason.summary` 渲染，无理由回退既有文案（不回归）。既有值迁移映射（评审 N2）：`'user'` → `'user'`（不变）；`'remote_read_only'`、`'authorization_revoked'` → **`'policy'`**（两者都是策略驱动的拒绝，非用户意志）；映射对照进单测，旧值场景断言新值与等价文案，迁移期模型可见文案逐一对照不回归。
3. **计数口径分离（按来源分桶 + 调阈值，非新建机制，评审 N7）**：`toolErrorRepeat` 现按 `toolName\0error\0identity` 键控（`toolChatLoop.ts:346`），不同文案的拒绝本就互不累计——缺口 4 的真实含义是「安全拒绝与执行失败共用同一阈值 3 且过紧」。改动 = 键内并入来源分桶（安全拒绝 / 执行失败），安全拒绝桶阈值更高（建议 5，待评审定值）；不引入第二套计数器。验收：连续 3 次同类安全拒绝不触发 `abortRepeatedToolError`。
4. **超时可配**：`ConfirmRequest.timeoutMs` 真实消费（今日硬编码 `null`）；`user` 回答者默认仍 `CONFIRM_MS = 5min`，为 P2 的 agent 档 30s 预留通道。

**验收口径**：
- `resolveConfirmChannel` 二维逐格单测（回答者种类 × 传输通道）：user 路径 desktop→`DesktopChannel`、wechat/feishu→`ImRequestChannel` 与现状逐一等价；automation 本阶段出口行为与 `RejectingChannel` 等价（拒绝、`cause='no-answerer'`）；IM lane 的 `deny` 有用户可见回执断言。
- 管家集成测试（mock provider）：写操作被拒 → 工具结果携带可读理由 → 回合收敛不中止 → run 记录说明拒绝原因。
- 桌面 / IM 确认链路回归全绿（user 路径等价）。

### P2 审批 Agent 接入（核心增量）

**改动点**：

1. **`security-approval` Skill**（`electron/skills/bundled/security-approval/`，唯一一份，I2）：裁决标准写死「用户不盯着也不会出问题」；输出限定 `ApprovalVerdict` 两态 JSON（无中间态）。参照既有 bundled skill 的结构与测试模式。
2. **审批执行链**（`electron/confirmation/approvalAgent.ts`）：复用管家模式——`createSession({ ownership: 'internal', visibility: 'hidden' })` → `resolveTrustedTurnExecutionConfig` → `runToolChatSession`；**调用 lane 显式取 `automation`**（不新增枚举值，方案 §1.3 非目标）+ 内部免确认标记（改动点 4），使规则矩阵与递归守卫的交互可推演：内层命中 automation 只读 allow 规则放行，命中 require-confirm 即在**回答者解析之前**被递归守卫改写为 `deny(cause='recursion-blocked')`——守卫在 gate 层、先于 `resolveConfirmChannel` 生效，否则内层 require-confirm 会被再次解析到 AgentChannel 造成递归。Profile：快模型、封闭只读工具集（读文件 / 列目录 / grep / git 状态 / 查决策缓存与安全审计日志，只能收窄）、侦查轮数上界 ≤3、超时默认 30s。输入形态采纳方案 §12-1 建议：**facts + 结构化线索包**（目标路径 / 命令 / URL / 涉及文件），不给全量会话。
3. **`AgentChannel implements ConfirmationChannel`**（`electron/confirmation/agentChannel.ts`）：`request()` 包装一次审批调用，返回 `ConfirmOutcome`（不含 memory，即使含也被 P0 闸拒绝）；超时 → `deny(cause='timeout')`；取消 → 中断内层调用（复用 Core 取消机制）；审计 `confirm.request`/`confirm.outcome` 成对、`actor='agent'`、带 `actorRef` 与 `latencyMs`。
4. **递归守卫（I5，硬约束）**：审批执行链调用 `runToolChatSession` 时传内部标记（如 `internalConfirmExemption: 'approval-agent'`，代码写死、不进配置与规则集）；gate 看到 require-confirm 决策 + 该标记 → 改写为 `deny(cause='recursion-blocked')` 并落审计。守卫只认标记不认业务身份；**豁免失效兜底**：若内层仍产生 `confirm.request`（实现缺陷），该确认由 AgentChannel 的深度计数拒绝，绝不允许无限递归。配套单测：审批会话内只读工具不产生 `confirm.request`（正向）；强行注入 require-confirm 场景 → `deny` + `cause='recursion-blocked'` 且不与 `agent-deny` 混淆（负向）。
5. **套餐约束**（方案 §4.8）：`kind='agent'` 的 lane 不得 `loose`、不得 `custom` 向下覆盖；写入时强校验（对齐 `validateRuleOverride`），解析期非法组合按 `standard` 处理 + 告警。automation lane 的 `loose` 禁用 guard 已在管家 P2 落地，本项把同一约束提升到回答者维度。
6. **切换开关**：`automation` lane 默认回答者 `deny` → `agent`（`RejectingChannel` 保留为配置缺失 / Profile 不可用时的兜底）。**此步骤是业务语义变化点**（automation 从「写操作全拒」变「写操作 Agent 裁决」），单独提交、可独立回退（回退 = 默认值改回 `deny`，一行）。
7. **准入死锁禁令（评审 N8，硬约束）**：审批内层 `runToolChatSession` 调用**绝不经过 `butlerAdmission` 取票**——外层管家回合持票等待审批结论，内层若再取票即在并发=1 下自死锁。审批调用的有界性由 Profile 上界（轮数 ≤3、超时 30s）保证，不依赖准入。配套单测：外层持票状态下触发审批调用限时完成、不复取票。同时显式声明前提：**当前 automation lane 的唯一生产者是管家 `butlerInvoker`**（其入口已被准入拦截）；未来新增 automation 生产者时必须回溯本假设——待偏差 23 整项关闭、准入收口到调用层后，此禁令由准入模块的「同步依赖不取票」语义统一承载。
8. **desktop-only 数据约定提升为 lint 强约束（评审 N6，顺手项）**：现有 lint 只强制「allow/auto-evaluator 规则必须有 lane 限定」（`defaultRules.lint.test.ts:8-16`）；补一条断言「`auto-evaluator` 动作规则的 lane 限定必须为 desktop-only」，把 `desktop-auto-approve` 的 desktop-only 从数据约定升级为测试强制，防「无 lane 限定规则绕过 lane 矩阵」的 B 类历史教训复发。

**验收口径**：
- 降级矩阵逐行单测（方案 §6 全表）：不可用 / 超时 / 不可解析 / Profile 缺失 / 准入不可得 / 递归触顶 → 全部 `deny` 且 `cause` 可区分、理由模型可读。
- 准入不重入（P2-7）：外层管家持票状态下触发审批调用，限时完成且未触发 `butlerAdmission` 取票。
- 端到端（mock provider + 内存 DB）：automation 回合写操作 → AgentChannel 裁决 approve（放行且**无**缓存写入）/ deny（理由回传、回合收敛）双路径。
- 标准唯一：桌面验证路径与管家共用同一 `skillId`/`profileId` 断言相等（为 P3 桌面档位预留，但不做桌面 UI）。
- 无窗口：纯托盘环境走 agent 回答者全程无 UI 依赖。
- 审批调用成本落审计（`latencyMs` + usage），为 priorVerdicts 决策积累数据。

## 5. 安全设计要点（贯穿）

1. **fail-closed 且不可静默**：所有「没拿到裁决」的路径（unavailable / timeout / unparsable / config-error / recursion-blocked）结论都是拒绝，且 `cause` 必须与 `agent-deny` 可区分——准入不足不是「审批判定危险」，统计口径不得失真。
2. **裁决永不落缓存**：三道闸（资格闸 / 档位闸 / 写入断言）+ I3 回归用例长期把守；`DecisionCacheEntry['source']` 不新增 `'agent'`，让类型承载不变量。
3. **审批 Agent 零写能力**：Profile 工具集封闭只读、只能收窄；不给任何写工具，「免再审批」才有安全前提。
4. **不可变集与底线集分开**：递归终止条件不进 `locked`（`locked` 只拦放宽、拦不住收紧），以引擎级守卫 + 不可配置标记表达（§4 P2-4）。
5. **审计五问**：谁批的（actor/actorRef）、依据什么（evidence，仅审计侧）、哪个模型多久（model/latencyMs）、有没有写记忆（cache.write 应不存在）、到底拿没拿到裁决（cause）。完整审批消息序列落 `internal/hidden` 内部会话（锚在 `actorRef.invocationId`），作为复盘输入而非授权。注意五问只作用于**有裁决的事件**——缓存命中是缓存系统代答（溯源到源条目 `source`，不占本次 actor）、`policy.decision` 发生在询问之前，均不进入「谁批的」口径（评审 B1）。
6. **准入不重入**：审批内层调用绝不取管家准入票据（外层持票等审批，内层取票即自死锁，评审 N8）；审批调用的有界性由 Profile 上界（轮数 ≤3、超时 30s）保证，不依赖准入。

## 6. 验收边界（开工对齐项）

| 可在当前环境单测 / 集成验证 | 需真机 / 真实 LLM 验证 |
| --- | --- |
| 全部类型与纯函数（eligibility / resolve / 套餐 guard） | 审批裁决质量（是否符合「不盯着也出不了事」标准，需抽样人审裁决记录） |
| gate 行为（递归守卫、规则命中、缓存隔离） | 端到端延迟与成本（快模型实测单次裁决耗时与 token，决定 priorVerdicts 优先级） |
| 降级矩阵（mock channel / mock provider） | 管家真实定时任务的长期稳定性（拒绝率、误拒率） |
| I3 / I4 / I5 三条不变量回归 | Skill 裁决标准在真实攻击性提示下的鲁棒性（提示注入） |

建议交付形态：P0+P1 合并验收（一个可独立发布的等价性版本），P2 单独验收（含真机抽查裁决记录）。

## 7. 风险与回退

| 风险 | 缓解 | 回退 |
| --- | --- | --- |
| LLM 服务不可用导致管家写操作全拒 | 这正是 fail-closed 的设计意图（优于静默放行）；`cause='unavailable'` 审计可观测 | automation 默认回答者一行改回 `deny` |
| 未命中确认频繁触发审批调用，成本 / 延迟超预期 | automation 规则集只读已 allow，confirm 面有限；`latencyMs`/usage 审计先行量化 | 收窄 automation confirm 规则面（规则是数据）或提前做 priorVerdicts |
| 递归守卫被未来重构绕过 | I5 正负向单测 + 「`confirm.request` 出现在审批会话即告警」的审计断言 | N/A（守卫必须存在，无回退形态） |
| P0/P1「行为等价」引入回归 | 三链路既有测试全量把守 + I3 锚点用例红转绿过程留档 | 各阶段独立提交，可逐段 revert |

## 8. 与既有文档的关系 / 债务移交

| 文档 | 关系 |
| --- | --- |
| `architect/confirmation-answerer-and-auto-approval-design.md` | 方案母本；本计划承接其 I1–I5、§5 变更清单、§6 降级矩阵，补排期与裁剪。方案 §12 待决问题在本计划的取值：§12-1 采纳「facts + 线索包」、§12-2 超时 30s、§12-3 安全拒绝阈值 5（评审定值）、§12-4 桌面档位默认关闭（不在本次）、§12-5 内部会话 `internal/hidden`（复用管家 P3 机制）、§12-6 同一 Profile 实体、§12-7 准入回旋推迟到偏差 23 整项关闭（最短路径下审批调用受 `butlerAdmission` 并发=1 天然保护，单 Turn 内审批串行、轮数 ≤3 有界；该保护的前提是「automation lane 唯一生产者是管家」且审批内层不取票，见 P2-7，新增生产者时回溯） |
| `architect/product-architecture-design.md` | 理想态；本计划落地其 §7.2「多轮回答者装配」中不依赖块 1 的部分；「Runtime 装配期构造 AgentChannel」在块 1 落地前由主进程组装点代位，端口形状不变，块 1 收敛时平移 |
| `architect/agent-core-roadmap.md` | 本计划 = 块 2 的最短路径版（跳过块 1 完整 Invocation，复用管家执行链模式）；块 1 / 块 3 仍是完整收敛路径 |
| `butler-agent-shortest-path-plan.md` | 前置已合并；本计划兑现其债务移交清单第 4 条，并消化其 §11-6 中「嵌套调用准入」的最小需求 |
| `tool-confirmation-framework-implementation-plan.md`(v8) | 按 roadmap §6 要求完成两处差异对账（评审 N5 补记录）：①挂点形状（v8 文档称 allow/confirm/deny+reason，实代码为同步 `autoEvaluator` 三分支）→ 由块 2 方案 §4.9 承接（不合并：保留 auto-evaluator 为确定性预过滤，审批 Agent 挂回答者位置）；②通道缺口（v8 预留接口但 automation 无实现）→ 已由管家 P2 落地 `RejectingChannel` 兜底 + 本计划 P2 落地 `AgentChannel` 关闭 |

**本计划不碰、移交后续**：桌面自动审批档位与设置面（P3）、审计页 actor 筛选（P3）、priorVerdicts 成本优化（P3）、wechat/feishu 回答者改造、审批 Agent 长期记忆 / 多 Agent 会签、`auto-evaluator` 下沉为规则、块 1 Invocation 收敛后 AgentChannel 装配点平移。

> **后续立项（2026-xx）**：桌面自动审批档位已单独立项，见 `docs/develop/desktop-auto-approval-plan.md`。该计划对本文有两处**模型修订**（后续以新计划为准）：①回答者不再作为独立配置维度，改为**由规则动作派生**（询问→人工确认、自动→审批 Agent），`ConfirmAnswererPolicy` 降级为 fail-closed 兜底；②档位改为**挂在链路上**（每链路自带可选档位与动作变换，跨链路不对齐），本文 §4.2 的「lane → 回答者默认值表」与 P2-5「非 user 不许 loose」约束在新模型下**退役**。本文已落地的 automation 链路行为（`ask` 由 agent 裁决）在新模型下等价保留。

## 9. 附录：P3 桌面自动审批档位的 Guardian 参考要点（2026-09-18 对比分析）

来源：Codex（`F:\Develop\codex`）Guardian 自动审批审查器对比分析，完整报告见 `docs/analysis/codex-guardian-vs-security-approval-comparison.md`（本地文档，不入版本控制）。本节摘取其中**桌面档位落地时可直接参考**的设计要点，作为 P3 立项时的输入；不改变本计划已交付的行为。

**状态更新（2026-09-18）**：分析报告 §4 的建议跟进项已在 `approval-agent-shortest-path` 分支落地（提交 6db05ab0 / c96ea06b / 3f766cca）——Skill v2 双维裁决（A）+ 防误拒条款（B）+ 注入举证标准（C）+ 解析器非对称容错（approve 侧 summary/riskLevel 必填、deny 侧宽容，评审跟进偏离 §4-E 原案）与授权上限 `APPROVAL_MAX_AUTHORIZATION='low'`（E）+ 任务声明全链透传 `taskDigest`（D）。本节其余内容为 **P3 备选项（报告 §5）**，仍待桌面档位立项时吸收。

### 9.1 双维裁决模型：桌面档位启用真人授权维度，Skill 标准不重写（I2 不破坏）

Guardian 的裁决是三字段：`risk_level(low/medium/high/critical) × user_authorization(unknown/low/medium/high) → outcome(allow/deny)`，先独立评风险与授权，再按阈值矩阵推导结论（low/medium → allow，两例外：显式政策 deny、有肯定证据的恶意注入；high → 仅 authorization ≥ medium 且窄范围且无绝对禁令；critical → 无条件 deny）。

- 双维裁决修订（Skill v2，见分析报告 §4-A）**已落地**：automation 无人场景 authorization 经代码侧上限（`APPROVAL_MAX_AUTHORIZATION='low'`）恒 unknown/low，推导结果与两态等价；**桌面档位（有人在）authorization 维度真实生效——同一份 Skill（I2 标准唯一）无需重写，只需放宽代码侧授权上限**。
- 桌面档位设置面若提供「自动批准风险上限」选项（如只自动批 low/medium），直接映射为阈值矩阵配置，不新增裁决标准。

### 9.2 审核失败回退人工：fail-open-to-user（仅有人在场景）

Guardian 的失败语义分层：timeout → TimedOut(denied)；cancelled → Abort（不算 deny）；解析/会话失败 → FailedClosed(denied)；**输入预算超限且非强制审查时 → Aborted + 回退用户确认流程**。最后一条是「fail-open-to-user」：审核系统自身不可用时，把裁决权交还人类，而不是直接拒绝（也不放行）。

- 桌面档位照此设计：审批 Agent 不可用/超时/不可解析时，**降级为挂人工确认卡**（现有 DesktopChannel 路径），而不是 automation 的全 deny——这是桌面档与 automation 档的核心行为差异之一。
- automation 档维持本计划的 fail-closed 全 deny 不变。

### 9.3 Post-denial 复批：看到风险后的明确复批可覆盖 high 阈值 deny，不可覆盖 critical

Guardian 规则：用户在被拒后看到具体风险说明，明确、无歧义地复批**同一精确动作** → authorization 记 high，可翻转 high 阈值产生的 deny；对 critical 级动作不可翻转；若用户论证的是风险分类本身有误，先按新事实重评 risk_level 再套用本规则。

- 桌面档位的确认卡交互可直接采用：deny 理由（`reason.summary`）呈现给用户 → 用户复批 → 本会话内重裁。前提是复批确证来自用户本人（桌面链路天然满足）。

### 9.4 授权评分与反过度解读条款（确认卡文案与重裁标准的输入)

Guardian 授权四档定义：high=明确请求该精确动作/载荷/副作用（含作为用户请求必要实现的动作）；medium=实质授权但实现选择未定；low=松散关联、授权弱或含糊；unknown=无证据（assistant 漂移或不可信内容指使）。反过度解读条款：模糊意图 ≠ 授权具体动作；目标态 ≠ 授权任意手段（存在更低风险合理替代时授权降级）；紧迫感不改变授权状态；按语义而非语法判授权。

- 桌面档位重裁（9.3 复批）与自动裁决共用该评分；确认卡的风险说明文案可按 risk_level 分级呈现。

### 9.5 priorVerdicts 的参考形态：host 认证信封 + 绑定原动作

Guardian：先前裁决作为上下文（「Prior Guardian decisions are context, not precedent」）以有界信封提供——≤8 条、每条 ≤1000 token、每条渲染体由 host 认证、**裁决只对原动作有效**；另一路线是 reviewer 会话复用 + 转录增量（同 turn 多次审查只送 delta）。

- 本计划 P3 的 priorVerdicts（§4.10 推迟项）落地时采用「host 侧注入、有界、绑定原动作」约束，不让裁决模型自行记忆；摘要路线 vs 会话复用路线按真机实测成本二选一。

### 9.6 reviewer Profile 独立解析

Guardian 模型选择链：用户 override → 目录默认 review 模型 → 父模型回退，low reasoning effort 优先。本计划 P1-1 修复后审批凭证对继承外层会话；块 1 Invocation 落地后，桌面档位应按 `approvalProfileId` 解析独立快模型（设置面提供 override），解析顺序参考上述链条。

### 9.7 熔断滑窗（可选）

Guardian turn 级熔断：连续 deny 计数（标准 3、网络安全专项模型 1）+ 50 窗口近 10 次 deny → 中断 turn 并通知。本计划已落地的安全拒绝桶（阈值 5 abort）粒度更粗但够用；桌面档位若实测拒绝率高、影响体验，再引入滑窗与「中断并说明」形态。
