# 远程 IM 异步审批安全模型 — 需求规格

> **版本：** v1.1
> **日期：** 2026-10-08
> **状态：** 需求复审通过（2026-10-08，见 [第二轮评审报告](../review/2026-10-08-remote-im-async-approval-security-requirement-review-v2.md)）；实施前决策与启用验收仍待完成
> **范围：** **仅安全侧**（包含与执行层共享的真实派发安全边界）。执行逻辑的变更（回合收尾策略、部分推进边界、待办重放时序、出站形态）另立方案，见 [附录 B](#附录-b与执行逻辑方案的分界)
> **承接：** `docs/develop/approval-agent-shortest-path-plan.md` §8「本计划不碰、移交后续」中的 **wechat/feishu 回答者改造**
> **上游依据：** `docs/develop/architect/confirmation-answerer-and-auto-approval-design.md`（不变量 I1–I5）、`docs/develop/architect/product-architecture-design.md` §7
> **关联需求：** [remote-session-context-awareness-requirement.md](./remote-session-context-awareness-requirement.md)、[remote-workdir-switch-guard-requirement.md](./remote-workdir-switch-guard-requirement.md)、[confirmation-card-trust-requirement.md](./confirmation-card-trust-requirement.md)、[tool-confirmation-top-level-design-v2.md](./tool-confirmation-top-level-design-v2.md)

---

## 目录

1. [概述](#1-概述)
2. [背景与现状](#2-背景与现状)
3. [目标与非目标](#3-目标与非目标)
4. [术语与不变量](#4-术语与不变量)
5. [功能需求 A：回答者解析与出口映射](#5-功能需求-a回答者解析与出口映射)
6. [功能需求 B：待办状态机与持久化](#6-功能需求-b待办状态机与持久化)
7. [功能需求 C：追认路径](#7-功能需求-c追认路径)
8. [功能需求 D：撤销与失效级联](#8-功能需求-d撤销与失效级联)
9. [功能需求 E：审计与跨回合归因](#9-功能需求-e审计与跨回合归因)
10. [功能需求 F：出站内容审查](#10-功能需求-f出站内容审查)
11. [功能需求 G：限额与降级矩阵](#11-功能需求-g限额与降级矩阵)
12. [异常与边界](#12-异常与边界)
13. [用户故事](#13-用户故事)
14. [配置项](#14-配置项)
15. [验收标准](#15-验收标准)
16. [分期建议](#16-分期建议)
17. [待决问题](#17-待决问题)
18. [附录 A：现网代码索引](#附录-a现网代码索引)
19. [附录 B：与执行逻辑方案的分界](#附录-b与执行逻辑方案的分界)

---

## 1. 概述

### 1.1 问题陈述

IM 链路（飞书 / 微信）当前**完整沿用桌面的同步确认模型**：

- 回答者恒为**真人**（`desktop / wechat / feishu = user`）；
- 询问发生在**回合内并阻塞**，超时 5 分钟视为**拒绝**；
- `agent-deny` 是**终局**，不交还用户。

而 IM 场景的基本事实是**用户不在场**：他不在屏幕前，无法实时参与安全决策，可能数小时后才看到消息。于是当前模型在 IM 上产生三个后果：

| # | 后果 | 说明 |
|---|------|------|
| 1 | **真人被迫实时参与** | 用户没看到 = 拒绝；被拒绝的动作连解释都没有 |
| 2 | **超时语义错误** | "没回答"被当成"拒绝"，而不是"未授权" |
| 3 | **审批 Agent 能力闲置** | automation lane 的审批 Agent 已建成，却只服务管家链路 |

### 1.2 改进方向

**沿用既有裁决标准，调整回答者与异步出口，并补齐持久授权、精确调用绑定及派发安全契约**：

| ID | 能力 | 一句话 |
|----|------|--------|
| **A** | 回答者切换 | IM 从 `user` 改为 **`agent` 优先 + `user` 兜底** |
| **B** | 新增 `deferred` 出口 | 待办成为一等持久状态，回合**不阻塞**等待 |
| **C** | 触发面扩展 | 不只"需授权"要问，**拒绝 / 判不准 / 裁决不可用**也交还用户 |

### 1.3 范围

| 项 | 是否纳入 |
|----|----------|
| 飞书 / 微信远程链路的确认与授权 | ✅ |
| automation lane（管家）现有行为 | ❌ 不改（本方案只对齐语义，不回归） |
| 桌面 lane 的自动审批档位 | ❌ 另立计划 |
| 执行时序 / 回合收尾 / 进度汇报 | ❌ **另立方案**（附录 B） |
| 裁决标准（`security-approval` Skill） | ❌ 不改（I2） |

---

## 2. 背景与现状

### 2.1 回答者维度已正交（I1 已落地）

```ts
// src/shared/confirmation/types.ts
export type ConfirmAnswererKind = 'user' | 'agent' | 'deny'
```

默认值表（同文件注释）：

| lane | 默认回答者 | 本次变更 |
|------|-----------|---------|
| `desktop` | `user` | 不变 |
| `wechat` | `user` | → **`agent`（+ deferred 兜底）** |
| `feishu` | `user` | → **`agent`（+ deferred 兜底）** |
| `automation` | `agent` | 不变 |

### 2.2 审批 Agent 已建成（仅服务 automation）

`electron/confirmation/approvalAgent.ts` 已落地：内部会话 `ownership:'internal', visibility:'hidden'`、**封闭只读工具集**（`APPROVAL_READONLY_TOOLS`，只能收窄）、侦查轮数上界 `APPROVAL_MAX_ROUNDS = 3`、超时 30s、递归豁免标记（I5）、默认快模型 `claude-haiku-4-5-20251001`。

裁决输出三态（`ApprovalVerdict`）：`approve | deny | undetermined`。

### 2.3 现状只有两种「无人应答」语义

| lane | 降级语义 | 表现 |
|------|---------|------|
| `desktop` | **fail-open-to-user** | `undetermined` / 失败 → 挂人工确认卡 |
| `automation` | **fail-closed** | 一律 `deny`，`cause` 可区分 |

**IM 两者都不适用**：用 desktop 的 = 挂死 5 分钟（无人应答）；用 automation 的 = 用户交办的事被莫名终局拒绝。

### 2.4 授权承载清单与生命周期（关键现状）

| 机制 | 位置 | 生命周期 | 授权粒度 |
|------|------|---------|---------|
| 入站授权快照 | `electron/remote/imInboundGuard.ts` | **单回合**（每次 await 后复检） | 身份代次 |
| 写授权租约 | `electron/remote/remoteWriteGrantRegistry.ts` | **内存态，重启即丢** | 会话级（30min / 500 ops / 50MiB） |
| 决策缓存 | `electron/confirmation/sqliteDecisionCache.ts` | 持久（SQLite） | **类型级**（"这类以后都放行"） |
| 运行租约 | `electron/remote/remoteAgentRegistry.ts` | 30min TTL | 会话单飞 |

> **注（重要历史教训）：** `remoteWriteGrantRegistry` 注释记载，其 `issue` / `reserve` **已无生产调用方**——远程写免确认改由 `decision_cache` 的 remote-write 会话键 + `recheckRemoteWriteAuthorization` 复核承载，并明确要求"如需恢复预算/次数语义，应优先在缓存键 TTL 与复核层补齐，**而非复活本模块**"。本方案不得引入第三套长期授权承载（见 **I6**）。

### 2.5 既有机制的复用边界

`factsHash` 是策略事实的 SHA-256 摘要，不是完整调用参数指纹；目标相同而正文、写入内容不同的调用可能具有相同事实摘要。`isSafetyRecheckAllowed` 对当前 `auto-allow` 可直接返回 true，不能单独作为异步精确动作校验。必须将策略事实复检与不可变调用完整性校验分开（§6.2、§7）。

`remoteAuthorizationRegistry` 的 `authorizationGeneration` 当前为进程内 Map，重启归零，不能代表跨重启授权身份。可复用撤销挂载模式，但必须增加持久、不可回退的授权 epoch 与恢复协议（§6.3、§8.3），禁止直接持久化该内存数字作为授权依据。

### 2.6 威胁模型前提：单聊与群聊的分界

本方案中所有"放宽"都建立在一个威胁模型判断上，必须显式记录，不得默认成立：

| 敌人 | 单聊（现状） | 群聊（现状不支持） |
|------|-------------|------------------|
| 误操作（手滑 / 表达不清 / 理解偏差） | 成立 | 成立 |
| **内容注入**（Agent 读到的内容中含指令） | **成立** | 成立 |
| **指令注入**（他人直接发指令诱导） | 不存在 | **成立** |
| **数据外流**（不可逆，通常是注入的终点） | **成立** | 成立 |

**结论：**

1. **单聊不存在"发指令的对手"**——把"处处设卡"当作对抗手段属**过度防御**，代价是体验，收益为零；
2. **但单聊不等于无攻击者**：攻击者不必发指令，只需把指令放进"用户会让 Agent 读的内容"里（网页、文件、**他人转发件**）。这属提示注入，单聊下完全成立；
3. 现状对群聊是**明确拒绝**的（飞书 `shouldAcceptInbound` → `group_disabled`，"仅支持私聊"；微信 owner-only），**这是本方案放松姿态的前提**。

**约束（I13）：** 未来若支持群聊，**必须重新评估整套姿态**，不得沿用单聊口径——彼时指令注入成为主防线。

---

## 3. 目标与非目标

### 3.1 目标

| ID | 目标 | 优先级 |
|----|------|--------|
| G1 | IM 回答者改为 `agent` 优先 + `user` 兜底（复用同一 Skill / Profile / 递归守卫） | P0 |
| G2 | 新增 `ConfirmOutcome` 的 **`deferred`** 出口，回合不阻塞等待 | P0 |
| G3 | 触发面扩展：`deny` / `undetermined` / 裁决失败四类均交还用户 | P0 |
| G4 | 待办持久化 + 完整性（跨回合、跨进程重启） | P0 |
| G5 | 撤销 / 换绑 / 配置变更**级联作废**待办 | P0 |
| G6 | 审计覆盖「挂起 → 追认 → 执行」跨回合链 | P0 |
| G7 | 独立、事前明确的“批准并记住”授权（默认关闭，普通追认不写缓存） | P1 |
| G8 | 待办出站内容的最小化与脱敏（启用门禁） | P0 |
| G9 | 待办限额，防授权疲劳 / 堆积（启用门禁） | P0 |
| G10 | IM 授权维度**按委托相关性分档**（不沿用 automation 的一刀切 `low`），外流例外（§5.5） | P0 |

### 3.2 非目标

| 项 | 说明 |
|----|------|
| 改判据轴与规则集 | `ActionClass` × `RiskLevel` × `signals` × `lane` 与三层结构完全沿用 |
| 改裁决标准 | I2：`security-approval` Skill 唯一，IM 不得另立更宽标准 |
| 桌面自动审批档位 | 另立计划 |
| 待办承载长期 / 类型级授权 | **禁止**（I6） |
| 执行时序变更 | 回合收尾、部分推进、重放时序属执行逻辑方案 |
| 待办卡 UI / 查询接口 | 属执行逻辑方案 |

---

## 4. 术语与不变量

### 4.1 术语

| 术语 | 定义 |
|------|------|
| **待办（deferred todo）** | 一次「已判定需要人的授权、但当前无人可答」的**实例级**授权请求记录 |
| **追认（acknowledge）** | 用户事后对待办的明确答复，等价于真人授权 |
| **指纹（fingerprint）** | 完整调用绑定（invocationId、规范化参数摘要、内容/附件版本、执行上下文）与策略事实 `{ ruleId, factsHash }`；两者分别校验 |
| **失效（invalidate）** | 因授权环境变化而**主动作废**待办（区别于过期） |

### 4.2 继承的不变量（不改）

| ID | 内容 |
|----|------|
| **I1** | 回答者与 lane **正交**（`user` / `agent` / `deny`） |
| **I2** | 标准唯一：一份 `security-approval` Skill，全链路共用 |
| **I3** | 记忆只源于人类：**非 `user` 回答者不得产生任何记忆写入** |
| **I4** | fail-closed 且不可静默：所有"没拿到裁决"的路径必须给出可区分的 `cause` |
| **I5** | 递归守卫：审批 Agent 内部不得再次触发确认（`recursion-blocked`） |

### 4.3 新增的不变量

| ID | 内容 | 动机 |
|----|------|------|
| **I6** | 待办**只承载实例级、一次性授权**，不得产生或升级任何类型级授权语义 | §2.4 历史教训：禁止第三套长期授权承载 |
| **I7** | 追认派发前**必须**通过不可变调用完整性、当前策略事实与持久授权 epoch 校验，并遵守撤销/派发 fencing | 防"批准的 A 被执行成 B"、防撤销后逃逸 |
| **I8** | 任何撤销 / 换绑 / 清 owner / 关渠道 / 白名单变更 / 敏感目录变更，**必须级联作废**该授权面下的全部待办 | 异步窗口远长于同步窗口 |
| **I9** | `deferred` **只允许发生在动作派发之前**，挂起动作保证**零副作用** | 保证"重放"语义成立（对齐现有派发前/派发后边界） |
| **I10** | 待办**不得由模型写入或修改**；只允许可信主进程 Runtime / 安全层写入 | 自证问题：被监管者不得编辑监管状态 |
| **I11** | `deferred` **仅适用于"授权是唯一障碍"**的情形；若执行能力或配置本身不可用，必须 fail-closed `deny` | 否则是对用户的**欺骗**（"你回一句就能办"其实办不了） |
| **I12** | `taskDigest` 只能取自用户原文中可证明的直接委托；引用、转发和待处理文本不具授权资格；不得由模型扩写或通过截断丢失限制条件 | §5.5 放宽授权的前提——否则攻击者可自行申请高授权，比一刀切更危险 |
| **I13** | 单聊姿态**不得**沿用于群聊；支持群聊前必须重新评估整套安全姿态（指令注入届时成为主防线） | §2.6 威胁模型前提 |

---

## 5. 功能需求 A：回答者解析与出口映射

### 5.1 二维解析模型（复用既有设计）

`resolveConfirmChannel` 已是二维：**维度一 = 回答者种类**（`user` / `agent` / `deny`），**维度二 = 传输通道**（桌面窗口卡 / IM 出站）。本方案只改维度一在 IM lane 的取值，不动维度二。

### 5.2 出口映射表（IM 与桌面/automation 对照）

| 裁决结果 | desktop 出口 | automation 出口 | **IM 出口（本方案）** |
|----------|-------------|----------------|---------------------|
| `approve` | 不适用（人答） | `approved(agent-approved)` | `approved(agent-approved)`（outbound 除外，§5.5） |
| `deny` | 不适用 | `rejected(agent-deny)` **终局** | **`deferred`**（cause `deferred-to-user`） |
| `undetermined` | 挂人工卡 | `rejected(agent-undetermined)` | **`deferred`** |
| `unavailable` | 挂人工卡 | `rejected(unavailable)` | **`deferred`** |
| `timeout` | 挂人工卡 | `rejected(timeout)` | **`deferred`** |
| `unparsable` | 挂人工卡 | `rejected(unparsable)` | **`deferred`** |
| `config-error` | 挂人工卡 | `rejected(config-error)` | **`rejected(config-error)`** ← 见 I11 |
| `recursion-blocked` | 不适用 | `rejected` | `rejected`（不可 defer） |
| 命中 `locked` 规则 / `critical` 风险 | 不适用 | `rejected` | **`rejected`（禁区，不给追认通道）** |

### 5.3 禁区优先于 deferred

策略 `locked: true` 规则命中（例：`remote-outside-write-deny`、`wiki-raw-write-deny`）与 `critical` 风险等级**先于**回答者解析生效：

- 不得进入 `deferred`；
- 不得因"用户追认"而放行——**有些事不是"等人说了就能做"，而是谁都不能做**。

### 5.4 新类型

```ts
// src/shared/confirmation/types.ts
export type ConfirmOutcomeCause =
  | ...  // 既有值不变
  | 'deferred-to-user'   // 新增

export type ConfirmOutcome =
  | ...  // 既有变体不变
  | {
      kind: 'deferred'
      todoId: string
      cause: ConfirmOutcomeCause
      reason?: ApprovalReason
      answererKind?: ConfirmAnswererKind
    }
```

**注意：** `ConfirmAnswererKind` **不新增取值**——`deferred` 是回答者的**出口形态**，不是第四种回答者。

### 5.5 授权维度与外流的确定出口

授权证据必须区分直接委托与引用、转发、代码块、附件及“处理下面文本”中的材料。来自 owner 的消息不意味着其中每段文本都是授权指令。可信 Runtime 保存原文受控引用、来源分区与限制条件；`taskDigest` 只是展示摘要，不能独立证明授权。无法可靠分区、无法读取完整证据或摘要截断丢失限制时，授权上限为 `unknown / low`，不得获得 `high`。模型判断“相似/相关”不足以证明动作已获授权。

| 条件 | 授权维度与最终出口 |
|------|------------------|
| 非 outbound，直接委托精确覆盖动作且完整限制条件可验证 | 可到 `high`；当前策略允许且 Agent approve 后才可 `agent-approved` |
| 动作来自材料、偏离委托或证据不完整 | `unknown / low`；需授权时必须 `deferred`，不得自主执行 |
| 任意 `ActionClass = 'outbound'` | 代码强制禁止 `agent-approved`、禁止长期缓存命中免确认、禁止写入长期外流授权；非禁区动作必须对精确目标、正文及附件逐次 `deferred` 后真人批准 |
| 当前策略 deny / locked / critical | `deny`，不提供追认绕过 |

外流约束先于 Agent approve、策略 auto-allow 与缓存快捷路径；Agent 可以评估风险，但不能替代逐次真人批准。审批通知仅可经 §10 的专用安全 DTO 投递给当前已鉴权 owner，不可将任意工具外发伪装为通知以绕过规则。

用户明确要求发送：委托证据可为 `high`，最终仍为 `deferred`。材料指定攻击者收件人或用户正文引用攻击指令：该段授权为 `unknown / low`，不得自动发送。原文第 500 字后含“不要发送/不要写入”等限制：必须保留限制并拒绝相冲突动作；无法验证完整原文时不得提权。

## 6. 功能需求 B：待办状态机与持久化

### 6.1 状态机

```
                    ┌──────────── approve（追认，一次性消费）──→ consumed
                    │
pending ────────────┼──────────── reject（用户明确拒绝）──────→ rejected
   │                │
   │                └──────────── expire（TTL 到期）──────────→ expired
   │
   └── invalidate（I8 级联：撤销/换绑/配置变更）───────────────→ invalidated
```

| 状态 | 含义 | 可否再追认 |
|------|------|-----------|
| `pending` | 等待用户答复 | ✅ |
| `consumed` | 已追认并**已消费**（防重放） | ❌ |
| `rejected` | 用户明确拒绝 | ❌ |
| `expired` | TTL 到期，**语义 = 未授权**（≠ 拒绝） | ❌ |
| `invalidated` | 授权环境变化导致作废 | ❌ |

**一次性消费（I6 的落地）：** `pending → consumed` 的转换必须是**原子**的，且追认被消费后立即不可再次消费；同一待办的重复答复为**幂等 no-op**（不重复执行、不报错）。

`consumed` 只表示授权已消费，不表示副作用已发生。独立执行状态至少为 `not_dispatched → dispatching → result_committed`，以及 `cancelled / outcome_unknown`；消费后未派发的动作仍受撤销阻断。恢复协议见 §7.2。

### 6.2 数据模型

```ts
// electron/remote/deferredTodoStore.ts（新建）
export type DeferredTodoStatus = 'pending' | 'consumed' | 'rejected' | 'expired' | 'invalidated'

export type DeferredTodo = {
  todoId: string
  channel: 'feishu' | 'wechat'
  /** 身份键：飞书 chatId / 微信 userId —— 不锚 sessionId（空闲续接可能已开新会话） */
  identityKey: string
  owner: string
  originSessionId: string
  workDirProfileId: string
  /** I7：追认时校验 */
  authorizationEpoch: string // 持久、不复用的授权版本；不得重启归零
  invocationId: string
  envelopeRef: string // 受控不可变调用引用
  canonicalArgsHash: string // 完整参数规范化摘要，包含正文/写入内容
  contentVersions: Array<{ ref: string; version: string; digest: string }>
  executionContextHash: string // cwd/profile、工具版本及必要执行上下文
  workflowId: string
  taskId: string
  stepId: string
  planRevision: string
  checkpointRef: string
  notificationVersion: string
  notificationBindings: Array<{ messageId: string; version: string }>
  executionState: 'not_dispatched' | 'dispatching' | 'result_committed' | 'cancelled' | 'outcome_unknown'
  createdAt: number
  expiresAt: number
  status: DeferredTodoStatus
  /** 挂起原因（审计五问之「到底拿没拿到裁决」） */
  reason: {
    cause: ConfirmOutcomeCause
    actionClass: ActionClass
    riskLevel: RiskLevel
    agentReason?: ApprovalReason
  }
  /** I7：策略事实（与完整调用绑定独立校验） */
  fingerprint: {
    ruleId: string
    factsHash: string
    toolName: string
    resourceKeys?: string[]
  }
  /** 仅直接委托的展示摘要（不是独立授权依据，按 §5.5 分区） */
  taskDigest?: string
  replyMessageId?: string
  consumedAt?: number
  consumedByRequestId?: string
}
```

规范化算法与 schema 版本必须明确，覆盖完整参数、正文、写入字节、附件快照/不可变版本及执行上下文；可变外部引用必须快照或拒绝创建。Runtime 按 `invocationId` 唯一创建准备记录，待办只能引用该原调用；重启后无需模型即可恢复。通知脱敏不能改变真实调用。待办/envelope 清理须等待恢复请求、执行日志与 checkpoint 对账完成，不得删除仍有执行关联的载荷。

### 6.3 持久化要求

| 项 | 要求 |
|----|------|
| 存储形态 | 对齐 `ImProcessedStore`：JSON + **原子替换 + fsync** + 单写者链 |
| 位置 | Electron `userData` 目录（`{channel}-deferred-todos.json`） |
| 跨重启 | **必须存活**（这是与写授权租约的根本差别，§2.4） |
| 写入方 | **仅可信主进程 Runtime / 安全层**（I10） |
| 完整性 | 验证完整调用摘要、内容版本、上下文和当前策略事实；缺失/损坏引用、非法结构或版本不支持均阻止执行并告警 |
| 敏感内容 | 通知 DTO 与真实 envelope 分离；仅展示字段可裁剪，真实参数不得脱敏改写；envelope 不加密存储，置于主进程受控存储并实施访问隔离，不进入模型可写 workflow data、通知或日志；读取或完整性校验失败均阻止执行并告警 |
| 清理 | 终态条目按保留期回收（建议 7 天，对齐 `imProcessedStore` 的 `RETENTION_MS`） |

---

**持久授权与恢复协议：** 授权 epoch、配置撤销事实及 tombstone 必须有持久协调记录，版本 schema 必须支持显式迁移；旧无 epoch/envelope 记录一律失效，不得猜测补值；先阻断该授权面的新派发，再持久提交撤销事实及新 epoch，随后幂等级联待办、恢复请求、缓存与消费未派发动作。跨文件原子替换不足以保证一致性，必须使用事务或可恢复日志/outbox。启动先恢复配置、epoch、撤销/取消事实并补做级联，再加载可执行待办及恢复请求。任一步配置写入、epoch 提交或级联失败均 fail closed，阻断该授权面派发且不宣称撤销处理完成。缺失/损坏 epoch 不得回退为 0；关闭后重开、同 owner 解绑再绑定必须产生新授权身份。

## 7. 功能需求 C：追认路径

### 7.1 追认入口与派发校验

入口必须同时验证身份及答复关联。引用通知或显式不可混淆 todo 标识必须绑定 `channel + identityKey + owner + todoId + notificationVersion`，消息 ID 从可信通道元数据取得；编号不得复用。仅允许对已提交 checkpoint 且已登记通知关联的待办追认。无引用的 Y/N、“同意”等含糊答复、普通业务文本、版本失配与过期通知均不消费，提示使用有效关联。补发须登记通知版本及 messageId，失效版本不可批准；多个有效投递引用只能指向同一 todo 的同一精确动作。

同步确认卡、安全待办与计划确认采用隔离的关联命名空间；计划确认的 Y、旧同步卡回复不得落入待办入口。语法呈现可另行设计，上述拒绝规则是启用前硬契约。

合法答复只持久化幂等 `resume_request`；Runtime 先取得 `originSessionId` 的 session 单飞租约及全局额度，再进行下列校验，取槽失败保持 pending：

| 校验 | 失败处置 |
|------|---------|
| 当前 channel、owner、identityKey 与通知关联有效 | 不消费、不派发；身份不匹配不向旧 owner 回执 |
| 持久 authorizationEpoch 一致，配置开启且无撤销/取消未完成记录 | 失效并阻止派发 |
| pending、未过期、checkpoint_committed、workflow/task/step/revision 映射有效 | no-op / expired / invalidated；不派发 |
| 原 envelope 可恢复，invocationId、完整参数摘要、内容/附件版本与执行上下文一致 | invalidated，要求重新发起 |
| 重新执行当前策略，环境、目录边界、敏感目标及策略事实有效 | 当前 deny/locked/critical 一律拒绝；仍 require-confirm 时 ruleId 与 factsHash 必须一致，否则失效 |

当前变为 auto-allow 不能跳过完整调用、epoch、环境及外流校验；它只能改变策略结果，不得扩大旧追认范围。不得直接用 `isSafetyRecheckAllowed` 代替本表。

### 7.2 消费、真实派发与恢复

原始调用恢复后以 `user-approved` 一次性执行；不得把待办描述交给模型重新生成调用。安全层与执行方案共用 session 租约、任务控制日志、revision/tombstone、准备记录和执行日志契约，见 [异步交互设计 §8.2](../develop/remote-im-async-interaction-design.md) 与 [开发计划阶段 6](../plan/remote-im-async-interaction-development-plan.md)。

最终复检、原子消费与真实 executor 派发必须通过与撤销/取消/修订共用的锁、事务或等价 permit fencing 协调。必须覆盖“最后复检到真实副作用开始”的窗口，不能仅凭两次检查或已写 dispatching 标记证明已派发。执行器在真实派发边界验证 permit；过期租约或旧 owner 不得派发。

- 撤销先提交：所有未真实派发动作（包括 consumed、resume_requested）不可执行。
- 真实派发先开始：撤销报告已开始/已完成及后续阻止情况，不声称撤回副作用。
- 消费后派发前崩溃：恢复先核对持久日志与 permit，仅能证明尚未派发且授权仍有效时，按同一 invocationId 续派发；不得回到 pending 或重新批准。
- 派发后结果未知：查询执行器幂等结果；无法证明是否产生副作用则置 outcome_unknown，报告需人工核对，禁止自动重放。

执行结果/受控引用和 completion outbox 必须可恢复且以 `todoId + invocationId` 幂等。审计分别记录批准、派发和结果，不能把 consumed 当作成功执行。

### 7.3 独立记忆授权（G7，可后置）

普通追认仅批准当前精确动作，**不得 cache.write**。I3 只规定记忆来源，不代表用户同意长期授权；I6 始终适用于待办本身。

如保留记忆能力，必须提供独立、事前明确的“批准并记住”选择，先成功展示具体适用范围、有效期和撤销方式，再记录用户对该范围的显式选择。记忆流程复用既有 decision_cache，受当前资格、档位与作用域限制，不建立第三套授权承载，也不得覆盖 outbound、deny/locked/critical。设置开关只能控制是否提供该选择，不能代替本次同意。

未选择记住、范围展示投递失败、答复含糊或范围变更时均不写缓存；成功写入仅限已展示并明确同意的范围，带 source=user-confirm 和独立 consent 记录。

## 8. 功能需求 D：撤销与失效级联

### 8.1 复用既有撤销模式

`remoteAuthorizationRegistry` 已有 `registerPendingCancel` / `registerCacheClearer` / `registerAuditAppender` 的联动模式。本方案新增一个等价挂载点：

```ts
// electron/remote/remoteAuthorizationRegistry.ts
remoteAuthorizationRegistry.registerTodoInvalidator({
  invalidateByChannel: (channel, reason) => count,
  invalidateByOriginSession: (originSessionId, reason) => count
})
```

### 8.2 触发点（必须级联）

| 触发 | 来源 | 语义 |
|------|------|------|
| 关闭渠道 / 关闭远程 | `persistFeishuConfig` / `persistWeChatConfig` | `invalidate(channel, 'channel_disabled' \| 'remote_disabled')` |
| 清 owner / 换绑 | `ownerCleared` / `allowlistChanged` | `invalidate(channel, 'owner_cleared' \| 'allowlist_changed')` |
| 白名单变更 | 同上 | 同上 |
| 工作目录绑定变更 | `bindSessionWorkDir` / `switch_work_dir` | `invalidateByOriginSession` |
| 敏感目录标记变更 | 配置 | `invalidateByOriginSession` |
| 关闭异步审批 | `remoteAsyncApprovalEnabled` | 持久 epoch 更新；失效待办/恢复请求/消费未派发动作；见 §14 |
| 任务取消 / 计划修订 | Runtime task-control | task/step tombstone 与 revision fencing；见 §7.2 |
| 会话删除 | `session:delete` | `invalidateByOriginSession` |

### 8.3 持久撤销与真实派发边界

撤销提交与真实派发按 §6.3、§7.2 使用同一 fencing 边界：撤销先提交阻止所有未派发动作；派发先开始则如实报告。级联须覆盖 pending、resume_request 和 consumed 但 not_dispatched 的执行记录，而非仅删除待办。

关闭异步审批、任务取消或计划修订也必须通过该边界。取消/修订先持久化 task-control 操作及 tombstone/outbox，再幂等失效关联 invocation；协调未完成期间 fail closed。无法证明保留步骤映射时，旧 revision 的未派发动作全部失效。启动恢复完成前禁止追认/派发。

## 9. 功能需求 E：审计与跨回合归因

### 9.1 新增事件族

写入现有安全审计（`SecurityAudit-*.log`，JSON Lines，脱敏）：

| 事件 | 时机 | 关键字段 |
|------|------|---------|
| `todo.deferred` | 待办创建 | `todoId`, `channel`, `identityKey`, `originSessionId`, `cause`, `actionClass`, `riskLevel`, `actor='agent'`, `actorRef`, `latencyMs` |
| `todo.approved` | 追认并消费 | `todoId`, `actor='user'`, `deferredAt`, `ackedAt`, `waitMs` |
| `todo.dispatched` | 真实派发开始 | `todoId`, `invocationId`, `authorizationEpoch`, `permitId` |
| `todo.result` | 结果持久提交或未知 | `todoId`, `invocationId`, `executionState`, 脱敏结果状态 |
| `todo.rejected` | 用户明确拒绝 | `todoId`, `actor='user'` |
| `todo.expired` | TTL 到期 | `todoId`, `ttlMs` |
| `todo.invalidated` | 级联作废 / 校验失败 | `todoId`, `reason`, `step`（校验第几步失败） |
| `todo.replay-rejected` | 消费后重复答复 | `todoId`, `actor` |

### 9.2 跨回合三问

在既有审计五问（谁批的 / 依据什么 / 哪个模型多久 / 有没有写记忆 / 到底拿没拿到裁决）之外，异步链路必须额外回答：

| 问 | 字段 |
|----|------|
| **谁挂起的、依据什么挂起** | `todo.deferred` 的 `actor` + `actorRef` + `cause` + `agentReason` |
| **谁追认的、隔了多久** | `todo.approved` 的 `actor` + `waitMs` |
| **其间环境变了没** | `todo.approved` 的指纹对账结果（`fingerprintMatched`）+ envelope 摘要匹配 + 持久 epoch 一致性 |

### 9.3 脱敏要求

- **不落用户消息正文**、不落完整命令与绝对路径（沿用既有安全审计字段规则 + `sanitizeForLog`）；
- 待办正文本身**不入审计**（只落 `todoId` 与结构化字段），理由同既有"审计记 id 不重复存完整正文"口径。

---

## 10. 功能需求 F：出站内容审查

### 10.1 问题

待办通知必然携带"要做什么 + 卡在哪"，而这些文本会**持久留在 IM 聊天记录里**（比日志更暴露：对端可见、云端留存、可被转发）。这是**新引入的外泄面**。

### 10.2 最小化原则

| 项 | 允许 | 禁止 |
|----|------|------|
| 动作描述 | "要写入 `report.md`" | 完整绝对路径 |
| 命令 | 用途（"运行构建命令"） | 完整命令行原文 |
| 任务 | `taskDigest`（用户自己的委托摘要） | 会话其他内容 |
| 敏感值 | — | **任何凭据 / 密钥 / token 片段** |

### 10.3 与可信证据分区保持一致

`ApprovalCluePack` 已确立"`taskDigest` 为可信证据、与不可信证据**分区渲染（围栏之外）**"。出站通知沿用同一分区：仅可验证的直接委托具有授权资格；用户原文中的引用/转发同样按不可信材料隔离，不得作为"用户的意思"呈现。初次通知与补发均只使用经审查的安全 DTO，禁止从 envelope 或工具日志临时拼接。

### 10.4 长期授权的事前展示义务

普通追认不得升级长期权限。独立“批准并记住”流程必须在批准前展示：具体动作类别及目标/会话范围、有效期、撤销入口；未成功投递展示不得写缓存。批准后回执可确认实际写入范围，但事后告知不能补足缺失的事前同意（§7.3）。

## 11. 功能需求 G：限额与降级矩阵

### 11.1 限额（防授权疲劳与堆积）

| 限额 | 建议默认 | 超限行为 |
|------|---------|---------|
| 单会话 `pending` 待办数 | 5 | **拒绝新建待办**，动作按 `deny(no-answerer)` 处置，回执说明（不静默丢弃） |
| 单身份键 `pending` 待办数 | 10 | 同上 |
| 待办 TTL | 24h（启用前配置为确定的有限正值） | 到期 → `expired` |

**安全理由：** 堆积会诱发"授权疲劳"——用户被淹没后倾向于全部同意，等价于把异步审批退化成自动放行。因此限额是**安全控制**而非体验优化。

限额检查与创建/预留必须原子执行，按 session 与 identity 两级同时计数；同 invocationId 幂等创建不重复占额。未提交的准备记录也需预留容量，失败时可恢复地释放。并发不得超额；启动先过期并对账预留。TTL 自原始创建时刻计算，重启、补发或恢复请求均不得延长。

### 11.2 降级矩阵（逐格 fail-deferred / fail-deny）

| 场景 | desktop | automation | **IM** |
|------|---------|-----------|--------|
| Agent 不可用 | 人工卡 | `deny(unavailable)` | `deferred(unavailable)` |
| 裁决超时 | 人工卡 | `deny(timeout)` | `deferred(timeout)` |
| 裁决不可解析 | 人工卡 | `deny(unparsable)` | `deferred(unparsable)` |
| Profile 缺失 / 配置损坏 | 人工卡 | `deny(config-error)` | **`deny(config-error)`**（I11） |
| 待办限额已满 | — | — | `deny(no-answerer)` |
| 命中 `locked` / `critical` | — | `deny` | **`deny`**（禁区） |
| 递归触顶 | — | `deny(recursion-blocked)` | `deny(recursion-blocked)` |

**I11 的落点：** `config-error` 与禁区不进 `deferred`——因为 `deferred` 的隐含承诺是"回一句就能办"，若该承诺不成立即为欺骗。

---

## 12. 异常与边界

| 场景 | 期望行为 | 关联 |
|------|----------|------|
| 同一待办被答复两次 | 幂等 no-op；记 `todo.replay-rejected` | B2 |
| 待办答复与撤销并发 | 按 §7.2 fencing：撤销先提交则阻止派发；派发先开始则如实报告 | D3 |
| 追认时动作已无意义（目标文件已删） | 指纹校验失败 → `invalidated` + 回执要求重新发起 | C5 |
| 待办指向的会话已删除 | `invalidateByOriginSession` → `invalidated` | D2 |
| 用户在追认前换绑 | 代次不一致 → `invalidated`，**不执行**、不回复旧 owner | C2 |
| 待办创建成功但出站失败 | 见 [OQ-2](#17-待决问题)（保留 `pending` + 标记未投递，在身份/epoch/TTL 复检后补发经审查 DTO；未登记有效通知关联前不接受追认） | — |
| 进程重启 | 待办**存活**；仅恢复对账完成且仍合法的 pending 可追认；consumed 按执行日志恢复，未知结果不重放；`expired` 判定按 `expiresAt` 重算 | B3 |
| 换绑后旧 owner 提交追认 | 身份校验失败 → 忽略 + 审计 | C1 |
| IM 消息内容诱导提前执行 | `deferred` 动作**不进入模型上下文作为指令**；追认只派发不可变原调用 | I7 / I9 |
| 待办存储条目结构损坏 | 按 `invalidated` 处理 + 告警，不尝试修复执行 | B4 |
| 渠道关闭时有 pending 待办 | 全部 `invalidated`，不回执（渠道已关） | D2 |

---

## 13. 用户故事

**US-IMAA01：不在场时交办**
作为 IM 远程用户，当我在通勤路上让 Agent 整理并写入报告，我希望它**先把能做的做完，把需要我批准的那一步留成一条留言**，而不是干等 5 分钟后告诉我失败。

**US-IMAA02：方便时追认**
作为 IM 远程用户，当我在两小时后看到那条留言，我希望引用对应通知或带明确待办标识回复，就能让它把剩下的做完，**而不用重新描述一遍任务**。

**US-IMAA03：撤销后不被逃逸**
作为管理员，当我在电脑上关闭微信远程，我希望**之前挂着的所有待办立即作废**，用户之后回 "Y" 也不能再触发执行。

**US-IMAA04：被拒绝的能覆议**
作为 IM 远程用户，当审批 Agent 判断某动作危险而拒绝，我希望**这个判断不是终局**——我应当能看到它的理由并有机会明确覆议。

**US-IMAA05：不会被自动升级权限**
作为 IM 远程用户，当我追认了某类动作，我希望普通追认**只批准这一次**；只有我事前看到范围、有效期和撤销方式并明确选择“批准并记住”，才形成长期授权。

**US-IMAA06：不会被堆积淹没**
作为 IM 远程用户，当积累的待办太多，我希望系统**停止继续堆**并告诉我为什么，而不是把十几条待办一起推给我、逼我随手全同意。

**US-IMAA07：动作变了就失效**
作为安全负责人，当挂起的是"写入 A 文件"、而用户追认时目标已变成"写入 B 文件"，我希望系统**拒绝执行并说明**，而不是拿旧授权做新动作。

---

## 14. 配置项

| 配置键 | 类型 | 建议默认 | UI 位置 | 说明 |
|--------|------|---------|---------|------|
| `remoteAsyncApprovalEnabled` | boolean | `false`（全部启用门禁通过后方可切默认） | 遥控 Tab · 安全审批 | 关闭经持久撤销/fencing 后回退 `user`；存量状态处理见下文 |
| `deferredTodoTtlMinutes` | number | 1440（24h） | 遥控 Tab · 安全审批 | 0 = 不挂起（动作按 `deny` 处置） |
| `maxPendingTodosPerIdentity` | number | 10 | 高级 · 安全审批 | 按 channel + identityKey 原子限额 |
| `maxPendingTodosPerSession` | number | 5 | 高级 · 安全审批 | 超限拒绝新建 |
| `deferredTodoRememberChoiceEnabled` | boolean | `false` | 高级 · 安全审批 | 仅提供独立“批准并记住”选择；普通追认永不写缓存 |

**关闭/回退协议：** 先阻断异步派发入口并持久提交关闭事实、新 epoch 与 tombstone，失效 pending、取消已提交 resume_request、撤销 consumed 未派发 permit，完成对账后回退 user。旧答复/恢复请求不能转成同步批准；派发已开始者按日志报告真实结果。失败或重启中断时保持 fail closed，恢复补做，不能只改默认回答者。已有合法、独立人类授权缓存按既有撤销范围处理，不能保留旧 pending 所衍生的越权记录。

**约束：** 本方案的配置**不得**与既有 `remoteConfirmPolicy` / 档位体系语义重叠或冲突；`kind='agent'` 的 lane 依旧不得 `loose`、不得 `custom` 向下覆盖（沿用既有套餐约束）。

---

## 15. 验收标准

### 15.1 回答者与出口（A）

| # | 场景 | 期望 |
|---|------|------|
| A1 | IM 非 outbound、未命中 `allow`，完整证据/当前策略有效且 Agent 裁决 `approve` | 执行；审计 `answererKind='agent'`、`cause='agent-approved'`；**无** `cache.write` |
| A2 | IM Agent 裁决 `deny` | **`deferred`**（非终局）；产生 `pending` 待办 |
| A3 | IM Agent 裁决 `undetermined` | **`deferred`** |
| A4 | IM Agent 不可用 / 超时 / 不可解析 | **`deferred`**，`cause` 分别可区分 |
| A5 | IM 配置损坏（Profile 缺失） | `deny(config-error)`，**不**产生待办（I11） |
| A6 | 命中 `locked` 规则 | `deny`，**不**产生待办 |
| A7 | 桌面链路 | 行为**逐项等价**，零变化（回归） |
| A8 | automation 链路 | 行为**逐项等价**，零变化（回归） |
| A9 | 非 outbound，完整直接委托及限制覆盖动作，Agent 裁决 `approve` | 可到 `high` 授权 → 执行；**不**产生待办 |
| A10 | 动作偏离 `taskDigest`、由被处理内容触发 | 授权 `unknown` / `low` → `deferred`（不自主执行） |
| A11 | `ActionClass = 'outbound'` 且用户明确要求 | 证据可 high，但最终必须 deferred；禁止 agent-approved 和缓存免确认 |
| A12 | 构造用例：被处理内容中含"用户已授权 X"的文本 | 断言该文本**未进入** `taskDigest` 分区，且 X 未获得 `high` 授权 |

### 15.2 待办状态机（B）

| # | 场景 | 期望 |
|---|------|------|
| B1 | 待办创建 | 落盘成功、`pending`、`expiresAt` 正确 |
| B2 | 同一待办答复两次 | 第二次幂等 no-op；仅一次执行；记 `todo.replay-rejected` |
| B3 | 进程重启后 | 待办仍可追认；已 `consumed` 的不可再追认 |
| B4 | 存储条目结构损坏 | 按 `invalidated` 处理 + 告警，不执行 |
| B5 | TTL 到期后答复 | `expired`，不执行；回执说明"已过期" |
| B6 | 挂起动作 | 断言**从未进入执行器**（零副作用，I9） |

### 15.3 追认校验（C）

| # | 场景 | 期望 |
|---|------|------|
| C1 | 非 owner 答复 | 忽略 + 审计，状态不变 |
| C2 | 代次不一致（换绑后） | `invalidated`，不执行 |
| C3 | `ruleId` 或 `factsHash` 不一致 | `invalidated`，回执要求重新发起 |
| C4 | 工作目录已变更 | `invalidated` |
| C5 | 追认成功 | `cause='user-approved'`、`answererKind='user'`、原子消费；执行**同一动作** |
| C6 | 普通追认 / 未选择记住 / 展示失败 / 含糊答复 | 均无 cache.write；独立“批准并记住”仅写已事前展示并明确同意的范围 |

### 15.4 撤销级联（D）

| # | 场景 | 期望 |
|---|------|------|
| D1 | 关闭渠道 | 该渠道全部 `pending` → `invalidated` |
| D2 | 换绑 / 清 owner | 全部 `invalidated` |
| D3 | 最终复检后、消费后、真实派发前插入撤销 | 撤销先提交均阻止派发；派发先开始时报告真实边界，不声称全部停止 |
| D4 | 撤销后旧 owner 答复 | 身份或代次校验失败，不执行 |

### 15.5 审计（E）

| # | 场景 | 期望 |
|---|------|------|
| E1 | 挂起 → 追认 → 执行 | 批准、派发、结果事件可串联（`todoId + invocationId`），且能算出 `waitMs` |
| E2 | 每条 `confirm.outcome` | `cause` 非空且可区分 |
| E3 | 审计脱敏 | 无用户消息正文、无完整命令、无绝对路径 |
| E4 | actor 归因 | 挂起为 `agent`（带 `actorRef`），追认为 `user` |

### 15.6 出站（F）

| # | 场景 | 期望 |
|---|------|------|
| F1 | 待办通知 | 自包含：做什么 / 为什么卡住 / 不定会怎样 |
| F2 | 含路径的动作 | 正文不含绝对路径 |
| F3 | 含命令的动作 | 正文不含完整命令行 |
| F4 | 独立记忆授权 | 批准前展示范围/有效期/撤销方式；失败不写缓存，事后告知不能替代同意 |

### 15.7 限额与降级（G）

| # | 场景 | 期望 |
|---|------|------|
| G1 | `pending` 达上限 | 拒绝新建，动作 `deny(no-answerer)`，回执说明 |
| G2 | 降级矩阵逐格 | 与 §11.2 表一致 |
| G3 | `deferredTodoTtlMinutes = 0` | 不挂起，动作按 `deny` 处置 |
| G4 | `remoteAsyncApprovalEnabled = false` | 完成持久关闭/fencing 后回退 user；旧 pending、resume_request、消费未派发动作均不可执行 |

### 15.8 P1 阻断专项验收与追踪

| 评审项 | 必须覆盖的故障/攻击用例 | 对应契约 |
|--------|--------------------------|----------|
| P1-1 跨重启撤销 | 非零 epoch 合法待办重启仍可追认；撤销已提交而级联未落盘即崩溃、关后重开、同 owner 重新绑定，旧待办均不可执行；配置/epoch/级联写失败均阻断 | §6.3、§8 |
| P1-2 精确动作 | 同目标换正文、同路径换写入内容、附件变更、auto-allow 后改参数均失效；重启恢复原调用无需模型；缺失 envelope 不执行 | §6.2、§7.1 |
| P1-3 长期升级 | 普通批准零 cache.write；未选择、投递失败、含糊答复均不升级；显式记忆范围不得扩大，outbound 不记忆 | §7.3、§10.4 |
| P1-4 派发竞态 | 最终复检/消费/派发前各注入撤销与取消，验证两种先后顺序；消费后崩溃与结果未知分别恢复，未知绝不自动重放；租约旧 owner 不派发 | §7.2、§8.3 |
| P1-5 追认绑定 | 两条并行待办、乱序/旧通知、重复答复、同步卡共存、计划确认 Y、无引用同意均不产生错批；补发版本关联可验证 | §7.1 |
| P1-6 外流/证据 | 明确发送为 high 但 deferred；材料收件人/引用攻击为 unknown/low 且不自动发；500 字后的禁止限制有效，截断不能 high；缓存/auto-allow/Agent approve 不能绕过 outbound | §5.5 |
| P1-7 启用门禁 | 任一控制未完成无法开启；并发创建不超两级额度；关闭后旧追认/恢复不能派发；通知初发/补发不泄露凭据、绝对路径、完整命令或材料指令 | §10、§11、§14、§16 |

### 15.9 回归

- 桌面确认链路、IM 同步确认链路、automation/管家链路既有测试全绿；
- I2 / I3 / I5 既有回归用例保持绿；
- `npm test` 通过。

---

## 16. 分期建议

| 阶段 | 内容 | 交付判据 |
|------|------|---------|
| **P0** | deferred 类型与出口映射，不切默认回答者 | 三链路行为不变 |
| **P1** | 持久 epoch/撤销恢复、不可变 envelope、准备记录/checkpoint 关联、待办持久化与限额原子预留 | 重启、故障注入、容量用例通过 |
| **P2** | 明确追认绑定、租约、消费/派发 fencing、取消/revision tombstone、执行日志/outbox、审计、通知最小化及可信证据分区 | §15 全部核心安全验收通过；原调用可恢复、未知结果不重放 |
| **P3** | 在门禁通过后切 IM 默认回答者、启用授权分档 | 端到端通过；关闭/回退存量状态验收通过 |
| **P4** | 可选独立“批准并记住”流程，默认关闭 | 事前同意、范围约束及撤销验收通过；不影响 P3 安全门禁 |

**P3 启用门禁（硬）：** P1/P2 全部完成；有限 TTL、追认绑定、完整证据校验、外流确定出口、通知初发/补发内容审查、两级原子限额、持久撤销、真实派发 fencing 及回退恢复均有通过证据。契约未定稿或能力缺失/配置损坏时禁止开启，维持旧 user 路径或按不可用状态 fail closed。不得用开关绕过门禁。

P3 单独提交并支持 §14 的完整回退协议，不能以一行默认值修改代替撤销异步授权路径。分期与 [异步交互开发计划阶段 6.7](../plan/remote-im-async-interaction-development-plan.md) 对齐。本次修订不代表门禁已实现或评审已通过。

## 17. 待决问题

本版已确定的安全结论保留原 OQ 编号供关联方案追踪；剩余存储实现及通道呈现需启用前定稿，不能改变既定安全边界。

| ID | 问题 | 本版结论 / 剩余决策 |
|----|------|------|
| **OQ-1** | 待办 TTL 取值；重启后 `pending` 是保留还是作废 | **已确认：** 默认 24h、合法 pending 重启保留；按 epoch/日志恢复；补发不延长 TTL |
| **OQ-2** | 待办创建成功但出站失败的处理 | **已确认：** 保留 pending + 未投递标记；同一身份下次入站时仅在身份/epoch/TTL 仍有效时补发审查 DTO 并登记关联；未登记通知关联前不接受追认，不延长 TTL |
| **OQ-3** | `pending` 待办是否算 `switch_session` 的 blocker | **已决定：不算**，pending 不占执行槽；追认后回到待办的 `originSessionId` 取得执行租约并恢复 |
| **OQ-4** | 待办落盘是否加密 | **已决定：不加密存储。** 真实 envelope 保存在主进程受控存储并实施访问隔离；读取或完整性校验失败时阻止执行并告警。该决策关闭 OQ-4，不要求引入 `safeStorage`、密钥管理或加解密恢复流程 |
| **OQ-5** | 追认是否默认写决策缓存 | **已确认：首版不实现独立“批准并记住”功能。** 普通追认只批准当前精确动作且永不写长期缓存；未来若添加需单独设计评审 |
| **OQ-6** | 同批多个待办的出站形态（一条聚合 vs 多条） | **已决定：逐条发送。** 每条通知只关联一个 todo，避免聚合答复歧义；通知仍需自包含 |
| **OQ-7** | 飞书/微信的追认入站语法 | **已决定：使用最多两位十进制数字的手动编号**，语法为 `批准 <编号>`（拒绝可用 `拒绝 <编号>`）；编号在同一 channel + identityKey 下唯一，并绑定 owner、todoId 和 notificationVersion。编号永不复用，补发生成新编号并使旧编号失效；因此每个 identity 最多有 100 个历史编号，耗尽后必须 fail closed 并明确告知，不能回收旧编号。编号只用于定位待办，仍须验证可信渠道身份及消息来源；裸 `Y/N` 或“同意”无效。 |
| **OQ-8** | 群聊支持的威胁模型重评估（I13） | **已确认：当前版本不支持群聊，维持现有拒绝行为。** 未来若考虑支持，必须重新评估整套姿态，不得沿用单聊口径 |

---

## 附录 A：现网代码索引

| 模块 | 路径 | 本方案关联 |
|------|------|-----------|
| 回答者类型与出口 | `src/shared/confirmation/types.ts` | §5 新增 `deferred` |
| 通道解析 | `electron/confirmation/channels.ts` | §5.1 二维解析 |
| IM 确认通道 | `electron/confirmation/imChannel.ts` | §5 / §10 待办通知载体 |
| 审批通道 | `electron/confirmation/agentChannel.ts` | §5.2 出口映射 |
| 审批执行链 | `electron/confirmation/approvalAgent.ts` | §5.2 复用，不改 |
| 审批工具集 | `electron/confirmation/approvalToolset.ts` | 只读集，不改 |
| 动作指纹 / 复检语义 | `electron/confirmation/safetyRecheck.ts` | §7.1 策略事实复检；不能替代完整调用校验 |
| 决策缓存 | `electron/confirmation/decisionCache.ts` / `sqliteDecisionCache.ts` | §7.3 记忆资格（I3） |
| 递归守卫 | `electron/confirmation/recursionGuard.ts` | I5，不改 |
| 安全审计 | `electron/confirmation/securityAuditLog.ts` / `audit.ts` | §9 事件族 |
| 入口来源分类 | `electron/confirmation/ingress.ts` | §10.3 可信分区 |
| 策略规则 | `src/shared/policy/defaultRules.ts` / `policyPackages.ts` | §5.3 禁区（`locked`） |
| 授权代次 / 撤销联动 | `electron/remote/remoteAuthorizationRegistry.ts` | I7 / I8 挂载点；须新增持久 epoch 协议 |
| 入站守卫 | `electron/remote/imInboundGuard.ts` | §7.1 第 1、2 步 |
| 消息幂等存储（形态参照） | `electron/remote/imProcessedStore.ts` | §6.3 持久化形态 |
| 待办持久化（**新建**） | `electron/remote/deferredTodoStore.ts` | §6 |
| 待办失效级联（**新建**，随 store 提供并经 `registerTodoInvalidator` 挂载） | `electron/remote/deferredTodoStore.ts` | §8 |
| 待办追认（**新建**） | `electron/remote/deferredTodoAck.ts` | §7 |
| 写授权租约（**反面参照**） | `electron/remote/remoteWriteGrantRegistry.ts` | §2.4 I6 的历史教训 |
| 确认策略 | `electron/remote/remoteConfirmPolicy.ts` | §14 配置不得冲突 |
| 远程入站路由 | `electron/feishu/remoteCommandRouter.ts` / `electron/wechat/weChatCommandRouter.ts` | 出站载体、追认入站分流 |
| 审批移交记录 | `docs/develop/approval-agent-shortest-path-plan.md` §8 | 本方案的上游来源 |

---

## 附录 B：与执行逻辑方案的分界

本方案**只解决"人不在场时的裁决与授权"**；下列内容归**执行逻辑方案**，两者在同一处交界（见末行）。

| 归本方案（安全） | 归执行逻辑方案 |
|-----------------|---------------|
| 回答者解析、四类裁决 → 出口映射 | 回合如何收尾、部分推进边界（就地收尾 vs 只读继续） |
| 待办状态机、持久化、完整性、指纹校验 | 待办如何重放、上下文如何重建 |
| 持久撤销、复检与真实派发 fencing 契约 | 跨会话续接、会话归属、`switch_session` 交互 |
| 追认路径的身份 / 代次 / 指纹 / 环境校验 | 满足安全绑定/拒绝规则的通道语法呈现、待办公告模板 |
| 审计事件族与跨回合归因 | 进度汇报、注意力预算与消息合并 |
| 待办限额、降级矩阵、出站内容审查规则 | 出站消息的形态、聚合方式与文案 |
| 独立记忆授权的资格/范围与**事前同意义务** | 告知文案的实际措辞与呈现 |

> **交界条款：** 「独立批准并记住」横跨两侧——**落不落、能否落、作用域**归本方案；**事前展示与选择的交互、文案形态**归执行逻辑方案。两方案必须互相引用，不得各自实现。


## 修订记录

- **v1.1（2026-10-08）：** 按 [安全评审报告](../review/2026-10-08-remote-im-async-approval-security-requirement-review.md) 的 7 项 P1 修订；§15.8 建立逐项验收映射。已通过 [第二轮需求复审](../review/2026-10-08-remote-im-async-approval-security-requirement-review-v2.md)，实施前决策与启用验收仍待完成。
- **实施决策（2026-10-08）：** OQ-1 默认 24h 且重启保留；OQ-2 通知失败时保留待办并在同身份下次入站重试；OQ-3 不阻止 session 切换且追认回 originSessionId；OQ-4 不加密存储；OQ-5 首版不实现“批准并记住”；OQ-6 逐条发送；OQ-7 使用最多两位十进制数字编号并绑定身份、待办及通知版本，失效编号不复用；OQ-8 当前版本不支持群聊。保留受控访问隔离、完整性校验及身份/关联校验要求。
