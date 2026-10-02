# 远程 IM 异步审批安全模型 — 需求规格

> **版本：** v1.0
> **日期：** 2026-10-01
> **状态：** 待评审
> **范围：** **仅安全侧**。执行逻辑的变更（回合收尾策略、部分推进边界、待办重放时序、出站形态）另立方案，见 [附录 B](#附录-b与执行逻辑方案的分界)
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

**判定逻辑一行不改，只改「谁答」和「在哪答」**：

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

### 2.5 两个可直接复用的既有机制

**（1）动作指纹已存在，名为 `factsHash`。** `electron/confirmation/safetyRecheck.ts`：

```ts
isSafetyRecheckAllowed({ initialRuleId, initialFactsHash, latestDecision, latestFactsHash, previouslyConfirmed })
// 语义：仅当「仍是同一条 require-confirm 规则 且 factsHash 完全一致 且 此前已真人确认」才允许放行
```

这正是追认所需的"动作指纹校验"，**无需新造**。

**（2）授权代次已存在，名为 `authorizationGeneration`。** 已绑定在入站快照与写授权对象上，`remoteAuthorizationRegistry.getGeneration(channel)` 可取，`invalidate(channel, reason)` 可在撤销时递增。

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
| G7 | 追认（`user-approved`）的记忆资格开放（可落决策缓存，I3 允许） | P1 |
| G8 | 待办出站内容的最小化与脱敏 | P1 |
| G9 | 待办限额，防授权疲劳 / 堆积 | P1 |
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
| **指纹（fingerprint）** | `{ ruleId, factsHash }` + 动作标识；用于保证"追认的动作 == 挂起的动作" |
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
| **I7** | 追认执行前**必须**同时通过 `factsHash` 一致性与 `authorizationGeneration` 一致性的双重校验 | 防"批准的 A 被执行成 B"、防撤销后逃逸 |
| **I8** | 任何撤销 / 换绑 / 清 owner / 关渠道 / 白名单变更 / 敏感目录变更，**必须级联作废**该授权面下的全部待办 | 异步窗口远长于同步窗口 |
| **I9** | `deferred` **只允许发生在动作派发之前**，挂起动作保证**零副作用** | 保证"重放"语义成立（对齐现有派发前/派发后边界） |
| **I10** | 待办**不得由模型写入或修改**；只允许主进程策略层写入 | 自证问题：被监管者不得编辑监管状态 |
| **I11** | `deferred` **仅适用于"授权是唯一障碍"**的情形；若执行能力或配置本身不可用，必须 fail-closed `deny` | 否则是对用户的**欺骗**（"你回一句就能办"其实办不了） |
| **I12** | `taskDigest` **只能取自用户消息原文**，不得由模型生成、扩展或改写；被处理内容的文本不得进入该可信分区 | §5.5 放宽授权的前提——否则攻击者可自行申请高授权，比一刀切更危险 |
| **I13** | 单聊姿态**不得**沿用于群聊；支持群聊前必须重新评估整套安全姿态（指令注入届时成为主防线） | §2.6 威胁模型前提 |

---

## 5. 功能需求 A：回答者解析与出口映射

### 5.1 二维解析模型（复用既有设计）

`resolveConfirmChannel` 已是二维：**维度一 = 回答者种类**（`user` / `agent` / `deny`），**维度二 = 传输通道**（桌面窗口卡 / IM 出站）。本方案只改维度一在 IM lane 的取值，不动维度二。

### 5.2 出口映射表（IM 与桌面/automation 对照）

| 裁决结果 | desktop 出口 | automation 出口 | **IM 出口（本方案）** |
|----------|-------------|----------------|---------------------|
| `approve` | 不适用（人答） | `approved(agent-approved)` | `approved(agent-approved)` |
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

### 5.5 授权维度策略：按委托相关性分档（不采用一刀切）

`approve` 的门槛取决于授权维度（`ApprovalAuthorizationDimension`）。现状 automation 无人场景由代码侧强制封顶 `low`（`ApprovalAgentDeps.maxAuthorization`）；**IM 不得沿用该一刀切**——那会导致"用户明确委托的动作仍被要求确认"，即 §2.6 所指的过度防御。

| 动作来源 | 授权维度 | 姿态 |
|---------|---------|------|
| 与 `taskDigest`（用户明确委托）一致 | 可到 `high` | 可自主执行，或最多轻确认 |
| 偏离委托、或由被处理内容"说服"而产生 | `unknown` / `low` | **必须确认**（走 `deferred`） |
| **数据外流**（`ActionClass = 'outbound'`） | **无论授权证据多强，一律按最严处置** | 不因"用户明确要求"免检 |

**为什么外流是例外：** 用户要求的"把报表发我邮箱"与攻击者要的"发到 `evil.com`"在动作类上**是同一个**。外流不可逆，且通常是内容注入的终点——因此"用户明确说了"不构成外流的免检理由。

**前提（I12）：** 本策略的安全性**完全压在 `taskDigest` 的可信性上**。若 `taskDigest` 可被内容污染，则等价于"攻击者可自行申请高授权"，**比一刀切 `low` 更危险**。

**连带效应：** 明确委托的动作更容易通过 `approve` → 产生的 `deferred` 更少。这是**有意放宽**，仅在 I12 成立且外流例外生效的前提下自洽。

---

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

**一次性消费（I6 的落地）：** `pending → consumed` 的转换必须是**原子**的，且追认被消费后立即不可再见；同一待办的重复答复为**幂等 no-op**（不重复执行、不报错）。

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
  authorizationGeneration: number
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
  /** I7：动作指纹（复用 safetyRecheck 语义） */
  fingerprint: {
    ruleId: string
    factsHash: string
    toolName: string
    resourceKeys?: string[]
  }
  /** 用户原始委托摘要（可信证据，分区渲染） */
  taskDigest?: string
  replyMessageId?: string
  consumedAt?: number
  consumedByRequestId?: string
}
```

### 6.3 持久化要求

| 项 | 要求 |
|----|------|
| 存储形态 | 对齐 `ImProcessedStore`：JSON + **原子替换 + fsync** + 单写者链 |
| 位置 | Electron `userData` 目录（`{channel}-deferred-todos.json`） |
| 跨重启 | **必须存活**（这是与写授权租约的根本差别，§2.4） |
| 写入方 | **仅主进程**（I10） |
| 完整性 | 追认时以 **指纹重算** 为准（不信任存储中的动作描述）；结构非法条目一律按 `invalidated` 处理并告警 |
| 敏感内容 | 待办含路径 / 资源键 → 落盘前按最小化原则裁剪（见 §10）；是否加密见 [OQ-4](#17-待决问题) |
| 清理 | 终态条目按保留期回收（建议 7 天，对齐 `imProcessedStore` 的 `RETENTION_MS`） |

---

## 7. 功能需求 C：追认路径

### 7.1 五步校验（全部通过才可执行）

| 步 | 校验 | 失败处置 |
|----|------|---------|
| 1 | **身份**：答复者 == 待办 `owner`，且 `identityKey` 匹配 | 忽略（不回复、不改状态），记审计 |
| 2 | **代次**：`authorizationGeneration` 与当前一致（`remoteAuthorizationRegistry.getGeneration`） | `invalidated` + 回执说明 |
| 3 | **存活**：`status === 'pending'` 且 `now < expiresAt` | 幂等 no-op / `expired` + 回执 |
| 4 | **指纹**：重算 `ruleId` + `factsHash`，与待办记录**完全一致**（复用 `isSafetyRecheckAllowed` 语义） | `invalidated` + 回执「动作已变化，需重新发起」 |
| 5 | **环境**：`workDirProfileId` 未变、目标路径仍非敏感、仍在工作目录边界内 | `invalidated` + 回执 |

### 7.2 执行语义

```
校验通过 → 原子消费（pending → consumed，记 consumedAt / consumedByRequestId）
        → 在新回合内以 user-approved 身份执行指纹对应的动作
        → 审计 todo.approved + confirm.outcome(cause='user-approved', answererKind='user')
```

**关键约束：**

- **按指纹重放，不重新解释。** 不得把待办的文字描述重新交给模型理解后生成一次新调用——那等于第二次不可控决策，且破坏归责链（I7）。
- **执行前再复检一次**（对齐 `safetyRecheck` 精神）：消费与执行之间仍存在窗口，撤销可能插入。
- **不新增授权承载**（I6）：追认是"一次性放行"，不写任何会话级 / 长期授权对象。

### 7.3 记忆资格（G7）

追认属**真人明确授权某个精确动作**，按授权评分定义达 `high` 级证据，因此：

| 项 | 规则 |
|----|------|
| 可否落决策缓存 | ✅ **可以**（I3 只禁止非 `user` 回答者） |
| 归属 | `source: 'user-confirm'`，`answererKind: 'user'` |
| 作用域 | 仍受既有档位 / 资格 / 作用域三道闸约束，不得因"来自追认"而放宽 |
| **告知义务** | 落缓存 = 隐式升级为"以后同类不再问" → **出站必须显式告知**（见 §10.4） |

---

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
| 会话删除 | `session:delete` | `invalidateByOriginSession` |

### 8.3 线性化要求（异步下的新增难点）

同步语义下"撤销 → 立即生效"是自然的；异步语义下必须显式保证：

> **撤销必须在线性化上先于追认执行**——即"撤销完成后，任何未消费的待办都不可能再被执行"。

落地方式 = 两道把关：**级联作废**（撤销时）+ **执行前复检**（§7.2）。二者缺一不可：只有级联会输给竞态窗口，只有复检会漏掉"用户答复与撤销并发"。

---

## 9. 功能需求 E：审计与跨回合归因

### 9.1 新增事件族

写入现有安全审计（`SecurityAudit-*.log`，JSON Lines，脱敏）：

| 事件 | 时机 | 关键字段 |
|------|------|---------|
| `todo.deferred` | 待办创建 | `todoId`, `channel`, `identityKey`, `originSessionId`, `cause`, `actionClass`, `riskLevel`, `actor='agent'`, `actorRef`, `latencyMs` |
| `todo.approved` | 追认并消费 | `todoId`, `actor='user'`, `deferredAt`, `ackedAt`, `waitMs` |
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
| **其间环境变了没** | `todo.approved` 的指纹对账结果（`fingerprintMatched`）+ 代次一致性 |

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

`ApprovalCluePack` 已确立"`taskDigest` 为可信证据、与不可信证据**分区渲染（围栏之外）**"。出站通知沿用同一分区：用户委托原文可信，被处理内容中的文本**不得**作为"用户的意思"呈现。

### 10.4 隐式升级的告知义务

若追认触发决策缓存写入（§7.3），出站**必须**明示该后果，例如语义要求（具体文案属执行逻辑方案）：

> 本次已批准；**今后同类动作将不再询问**（可在设置中撤销）。

理由：异步场景下用户看不到"一次追认 → 长期授权"的升级过程，不告知即构成**未获授权的权限扩张**。

---

## 11. 功能需求 G：限额与降级矩阵

### 11.1 限额（防授权疲劳与堆积）

| 限额 | 建议默认 | 超限行为 |
|------|---------|---------|
| 单会话 `pending` 待办数 | 5 | **拒绝新建待办**，动作按 `deny(no-answerer)` 处置，回执说明（不静默丢弃） |
| 单身份键 `pending` 待办数 | 10 | 同上 |
| 待办 TTL | 待决（[OQ-1](#17-待决问题)） | 到期 → `expired` |

**安全理由：** 堆积会诱发"授权疲劳"——用户被淹没后倾向于全部同意，等价于把异步审批退化成自动放行。因此限额是**安全控制**而非体验优化。

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
| 待办答复与撤销并发 | 执行前复检兜住；宁可 `invalidated` 不可错执行 | D3 |
| 追认时动作已无意义（目标文件已删） | 指纹校验失败 → `invalidated` + 回执要求重新发起 | C5 |
| 待办指向的会话已删除 | `invalidateByOriginSession` → `invalidated` | D2 |
| 用户在追认前换绑 | 代次不一致 → `invalidated`，**不执行**、不回复旧 owner | C2 |
| 待办创建成功但出站失败 | 见 [OQ-2](#17-待决问题)（建议：保留 `pending` + 标记未投递，下次入站时补发） | — |
| 进程重启 | 待办**存活**；`consumed` 前均可追认；`expired` 判定按 `expiresAt` 重算 | B3 |
| 换绑后旧 owner 提交追认 | 身份校验失败 → 忽略 + 审计 | C1 |
| IM 消息内容诱导提前执行 | `deferred` 动作**不进入模型上下文作为指令**；追认只走指纹重放 | I7 / I9 |
| 待办存储条目结构损坏 | 按 `invalidated` 处理 + 告警，不尝试修复执行 | B4 |
| 渠道关闭时有 pending 待办 | 全部 `invalidated`，不回执（渠道已关） | D2 |

---

## 13. 用户故事

**US-IMAA01：不在场时交办**
作为 IM 远程用户，当我在通勤路上让 Agent 整理并写入报告，我希望它**先把能做的做完，把需要我批准的那一步留成一条留言**，而不是干等 5 分钟后告诉我失败。

**US-IMAA02：方便时追认**
作为 IM 远程用户，当我在两小时后看到那条留言，我希望回一句话就能让它把剩下的做完，**而不用重新描述一遍任务**。

**US-IMAA03：撤销后不被逃逸**
作为管理员，当我在电脑上关闭微信远程，我希望**之前挂着的所有待办立即作废**，用户之后回 "Y" 也不能再触发执行。

**US-IMAA04：被拒绝的能覆议**
作为 IM 远程用户，当审批 Agent 判断某动作危险而拒绝，我希望**这个判断不是终局**——我应当能看到它的理由并有机会明确覆议。

**US-IMAA05：不会被自动升级权限**
作为 IM 远程用户，当我追认了某类动作，我希望系统**明确告诉我"以后同类不再询问"**，并且我能在设置里收回这个授权。

**US-IMAA06：不会被堆积淹没**
作为 IM 远程用户，当积累的待办太多，我希望系统**停止继续堆**并告诉我为什么，而不是把十几条待办一起推给我、逼我随手全同意。

**US-IMAA07：动作变了就失效**
作为安全负责人，当挂起的是"写入 A 文件"、而用户追认时目标已变成"写入 B 文件"，我希望系统**拒绝执行并说明**，而不是拿旧授权做新动作。

---

## 14. 配置项

| 配置键 | 类型 | 建议默认 | UI 位置 | 说明 |
|--------|------|---------|---------|------|
| `remoteAsyncApprovalEnabled` | boolean | `true`（IM 链路） | 遥控 Tab · 安全审批 | 关闭 = 回退到 `user` 回答者（旧行为） |
| `deferredTodoTtlMinutes` | number | 待决（[OQ-1](#17-待决问题)） | 遥控 Tab · 安全审批 | 0 = 不挂起（动作按 `deny` 处置） |
| `maxPendingTodosPerSession` | number | 5 | 高级 · 安全审批 | 超限拒绝新建 |
| `deferredTodoCacheOnAck` | boolean | 待决（[OQ-5](#17-待决问题)） | 高级 · 安全审批 | 追认是否写决策缓存（开启时必须告知，§10.4） |

**约束：** 本方案的配置**不得**与既有 `remoteConfirmPolicy` / 档位体系语义重叠或冲突；`kind='agent'` 的 lane 依旧不得 `loose`、不得 `custom` 向下覆盖（沿用既有套餐约束）。

---

## 15. 验收标准

### 15.1 回答者与出口（A）

| # | 场景 | 期望 |
|---|------|------|
| A1 | IM 未命中 `allow`，Agent 裁决 `approve` | 执行；审计 `answererKind='agent'`、`cause='agent-approved'`；**无** `cache.write` |
| A2 | IM Agent 裁决 `deny` | **`deferred`**（非终局）；产生 `pending` 待办 |
| A3 | IM Agent 裁决 `undetermined` | **`deferred`** |
| A4 | IM Agent 不可用 / 超时 / 不可解析 | **`deferred`**，`cause` 分别可区分 |
| A5 | IM 配置损坏（Profile 缺失） | `deny(config-error)`，**不**产生待办（I11） |
| A6 | 命中 `locked` 规则 | `deny`，**不**产生待办 |
| A7 | 桌面链路 | 行为**逐项等价**，零变化（回归） |
| A8 | automation 链路 | 行为**逐项等价**，零变化（回归） |
| A9 | 用户明确委托（`taskDigest` 含该动作），Agent 裁决 `approve` | 可到 `high` 授权 → 执行；**不**产生待办 |
| A10 | 动作偏离 `taskDigest`、由被处理内容触发 | 授权 `unknown` / `low` → `deferred`（不自主执行） |
| A11 | `ActionClass = 'outbound'` 且用户明确要求 | **仍按最严处置**；不因授权证据而免检 |
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
| C6 | 追认 + 开启缓存 | 产生 `cache.write`，且出站包含隐式升级告知（F4） |

### 15.4 撤销级联（D）

| # | 场景 | 期望 |
|---|------|------|
| D1 | 关闭渠道 | 该渠道全部 `pending` → `invalidated` |
| D2 | 换绑 / 清 owner | 全部 `invalidated` |
| D3 | 撤销与答复并发 | **绝不**执行；宁可失效 |
| D4 | 撤销后旧 owner 答复 | 身份或代次校验失败，不执行 |

### 15.5 审计（E）

| # | 场景 | 期望 |
|---|------|------|
| E1 | 挂起 → 追认 → 执行 | 三事件可串联（`todoId`），且能算出 `waitMs` |
| E2 | 每条 `confirm.outcome` | `cause` 非空且可区分 |
| E3 | 审计脱敏 | 无用户消息正文、无完整命令、无绝对路径 |
| E4 | actor 归因 | 挂起为 `agent`（带 `actorRef`），追认为 `user` |

### 15.6 出站（F）

| # | 场景 | 期望 |
|---|------|------|
| F1 | 待办通知 | 自包含：做什么 / 为什么卡住 / 不定会怎样 |
| F2 | 含路径的动作 | 正文不含绝对路径 |
| F3 | 含命令的动作 | 正文不含完整命令行 |
| F4 | 追认触发缓存 | 正文含"同类不再询问"的明确告知 |

### 15.7 限额与降级（G）

| # | 场景 | 期望 |
|---|------|------|
| G1 | `pending` 达上限 | 拒绝新建，动作 `deny(no-answerer)`，回执说明 |
| G2 | 降级矩阵逐格 | 与 §11.2 表一致 |
| G3 | `deferredTodoTtlMinutes = 0` | 不挂起，动作按 `deny` 处置 |
| G4 | `remoteAsyncApprovalEnabled = false` | 完全回退旧行为（回答者 `user`） |

### 15.8 回归

- 桌面确认链路、IM 同步确认链路、automation/管家链路既有测试全绿；
- I2 / I3 / I5 既有回归用例保持绿；
- `npm test` 通过。

---

## 16. 分期建议

| 阶段 | 内容 | 交付判据 |
|------|------|---------|
| **P0** | 类型（`deferred` 变体 + `deferred-to-user` cause）+ 出口映射表（**不切默认回答者**） | 行为**零变化**；桌面/IM/automation 三链路回归全绿 |
| **P1** | 待办持久化（`deferredTodoStore`）+ 撤销级联（`registerTodoInvalidator`） | I8 用例转绿；重启存活用例转绿 |
| **P2** | 追认路径（五步校验 + 指纹重放）+ 审计事件族 | I7 用例转绿；E1 跨回合串联可验证 |
| **P3** | **切默认回答者**（IM `user` → `agent` + deferred 兜底）+ **授权维度分档生效**（§5.5） | 端到端：拒 → 挂起 → 追认 → 执行；明确委托可自主（A9）；**可一行回退** |
| **P4** | 出站内容审查 + 限额 + 记忆资格与告知 | F / G 用例转绿 |

**P3 是业务语义变化点**，必须单独提交、可独立回退（回退 = 默认值改回 `user`）。

**顺序约束（硬）：** **P1 必须先于 P3**。否则 P3 一生效，IM 立即退化为 automation 的 fail-closed 全 deny——技术上正确，产品上灾难。

---

## 17. 待决问题

| ID | 问题 | 建议 |
|----|------|------|
| **OQ-1** | 待办 TTL 取值；重启后 `pending` 是保留还是作废 | 建议 24h 且**重启保留**（用户可能次日才回来）；作废会让异步体验断裂 |
| **OQ-2** | 待办创建成功但出站失败的处理 | 建议保留 `pending` + 标记未投递，下次该身份入站时补发；不作为 `invalidated` |
| **OQ-3** | `pending` 待办是否算 `switch_session` 的 blocker | 建议**不算**（不占执行槽），但追认后需把用户带回 `originSessionId` |
| **OQ-4** | 待办落盘是否加密 | 建议至少对含路径 / 资源键的字段做最小化；是否用 `safeStorage` 加密待评估（MAC 侧已有先例） |
| **OQ-5** | 追认是否默认写决策缓存 | 建议**默认开启但强告知**（§10.4）；若评估认为风险偏高，可默认关闭 + 设置项开启 |
| **OQ-6** | 同批多个待办的出站形态（一条聚合 vs 多条） | 建议一条聚合（属执行逻辑方案，此处仅约束"必须自包含"） |
| **OQ-7** | 微信侧"追认"的入站语法（回复原文 / 编号 / 引用） | 需与现有 `imChannel` 的 Y/N 卡解析共存，避免歧义；属执行逻辑 + 安全交界，需共同定 |
| **OQ-8** | 群聊支持的威胁模型重评估（I13） | 现状拒绝群聊；未来若支持，必须重新评估整套姿态（指令注入届时成为主防线），不得沿用单聊口径 |

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
| 动作指纹 / 复检语义 | `electron/confirmation/safetyRecheck.ts` | §7.1 第 4 步、§7.2 复检 |
| 决策缓存 | `electron/confirmation/decisionCache.ts` / `sqliteDecisionCache.ts` | §7.3 记忆资格（I3） |
| 递归守卫 | `electron/confirmation/recursionGuard.ts` | I5，不改 |
| 安全审计 | `electron/confirmation/securityAuditLog.ts` / `audit.ts` | §9 事件族 |
| 入口来源分类 | `electron/confirmation/ingress.ts` | §10.3 可信分区 |
| 策略规则 | `src/shared/policy/defaultRules.ts` / `policyPackages.ts` | §5.3 禁区（`locked`） |
| 授权代次 / 撤销联动 | `electron/remote/remoteAuthorizationRegistry.ts` | I7 / I8 挂载点 |
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
| 撤销级联与执行前复检 | 跨会话续接、会话归属、`switch_session` 交互 |
| 追认路径的身份 / 代次 / 指纹 / 环境校验 | 追认的入站语法与交互、待办公告的模板 |
| 审计事件族与跨回合归因 | 进度汇报、注意力预算与消息合并 |
| 待办限额、降级矩阵、出站内容审查规则 | 出站消息的形态、聚合方式与文案 |
| 记忆资格（可落缓存）与**告知义务** | 告知文案的实际措辞与呈现 |

> **交界条款：** 「追认落决策缓存」横跨两侧——**落不落、能否落、作用域**归本方案；**如何告知、文案形态**归执行逻辑方案。两方案必须互相引用，不得各自实现。
