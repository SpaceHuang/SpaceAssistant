# 确认回答者与自动审批 技术设计

> 状态：待评审（设计，不含排期）
> 基线：工作区 HEAD（2026-09-12）
> 上游规划：`docs/develop/architect/agent-core-roadmap.md`（§1.1 自动审批 Agent、§5 工作块 2）
> 关联：`docs/develop/tool-confirmation-framework-implementation-plan.md`（v8，策略引擎与确认通道骨架）
> 一句话：把「未命中规则与缓存时**由谁回答确认**」从 lane 里拆出来做成可配置的回答者；`agent` 这一档由**审批 Agent**（Core 的另一次调用）承担，且它的裁决**永不进入决策缓存**。

---

## 1. 背景与目标

### 1.1 业务需求

1. **后台管家 Agent** 在无人值守下运行（远端指令 / 定时触发），不可能等用户确认，其安全策略必须全程自动决策。
2. **桌面交互**后续也要提供「自动审批」安全档位，走同一套机制。
3. 管家 Agent **不感知审批 Agent 的存在** —— 它看到的是「我请求一次工具调用，安全策略自动给出结论」。

### 1.2 设计目标

- 回答者（谁回答确认）与 lane（来源身份）解耦。
- 审批标准只有一套：一个 Skill、一份 Prompt，桌面与管家共用。
- 审批 Agent 的裁决不产生任何持久授权。
- 拒绝理由能回到模型，使无人值守链路可以继续工作而不是崩掉。
- 审计能回答「这次是谁批的、依据什么」。

### 1.3 非目标

- 不新增 `ExecutionLane` 取值（复用既有的 `automation`）。
- 不引入多审批 Agent 投票 / 分级会签。
- 不给审批 Agent 写能力或长期记忆。
- 不改造策略引擎的规则匹配算法（只做回答者解析与记忆准入）。

---

## 2. 现状（对齐代码事实）

### 2.1 已经就绪

| 能力 | 位置 | 说明 |
| --- | --- | --- |
| 通道可插拔接口 | `src/shared/confirmation/types.ts:169` | `ConfirmationChannel { request(req): Promise<ConfirmOutcome>; cancel(id) }` —— 本就是 async |
| 两个既有实现 | `electron/confirmation/channels.ts`、`electron/confirmation/imChannel.ts` | 桌面卡片 / IM 回复 |
| 「自动审批」动作位 | `src/shared/confirmation/types.ts:253` | `PolicyAction` 含 `'auto-evaluator'`，规则 `desktop-auto-approve` 默认即它 |
| 每链路套餐 | `src/shared/policy/policyPackages.ts:15` | `automation` lane 已在默认映射中（`standard`），仅缺生产者 |
| 记忆资格统一判定 | `src/shared/policy/memoryEligibility.ts:14` | `deriveMemoryEligibility(facts, lane)` → `none / session / persistent`；注释明确「缓存读取、确认 UI 档位和缓存写入必须共享这层结果」 |
| 记忆写入收窄 | `electron/confirmation/decisionCacheWriter.ts:60-78` | key 必须来自策略层本次给出的 `memoryTiers`，否则抛错 |
| 缓存来源枚举 | `src/shared/confirmation/types.ts:203` | `'user-confirm' \| 'settings' \| 'migration'` |
| 系统保护规则 | `src/shared/policy/policyPackages.test.ts:137-146` | `FAIL_CLOSED_IDS` 三条均 `locked`：`loose` 不得下调、`custom` 不得覆盖 |
| 设置中心装配 | `electron/confirmation/settingsSecurityModel.ts:26` | 套餐按四 lane 装配，渲染端只读 |

### 2.2 缺口与证据

缺口编号在本文件内定义并使用（原计划的缺口清单已由本文件承接）。

1. **通道类型被 lane 硬编码**：`channelFor({ lane: 'desktop' | 'wechat' | 'feishu', ... })` 直接决定实现（`electron/confirmation/channels.ts:107`），`laneOf()` 也只从 `RemoteContext` 派生三值（`electron/confirmation/toolCallGate.ts:107`）。`automation` 没有任何生产者。
2. **`auto-evaluator` 装不下审批 Agent**：`autoEvaluator` 是**同步**函数，按工具名写死三分支（`run_shell` / `write_file`·`edit_file` / 其余返回「无评估器」），位于 `electron/confirmation/toolCallGate.ts:330-341`。
3. **拒绝理由无回传路径**：通道结果被压成三值（`electron/toolChatLoop.ts:1398-1402`）；`rejectReason` 只有 `'user' | 'remote_read_only' | 'authorization_revoked'`（`:1241`）；模型最终收到硬编码文案（`:1650-1653`）。
4. **该文案会中止 Turn**：`toolErrorRepeat.noteFailure` 连续 3 次同错即 `abortRepeatedToolError`（`electron/toolChatLoop.ts:284`、`:1668` 附近）。
5. **写缓存不看回答者**：`electron/toolChatLoop.ts:1580-1595`（browser navigate 的 domain 键）与 `:1607-1622`（act 的 domain 键）只检查 `outcome === 'approved'` + `gate.decision.type === 'require-confirm'`，随后以 `source: 'user-confirm'` 写入。
6. **`ConfirmOutcome.memory` 无消费方**：主循环只读 `kind`（`electron/toolChatLoop.ts:1398`），通道返回的 `memory` 实际未生效 —— 因此「让 Agent 通道不返回 memory」这层保护**不成立**，真正写缓存的是第 5 条那两处。
7. **审计 actor 无法表达 Agent 裁决**：`eventBase` 硬编码 `actor: 'system'`（`electron/confirmation/channels.ts:43`），`policy.decision` 同为 `'system'`（`electron/confirmation/toolCallGate.ts:368`）；类型只允许 `'user' | 'system' | 'migration'`（`src/shared/confirmation/types.ts:233`）。
8. **超时硬编码且不可配**：`CONFIRM_MS = 5 * 60 * 1000`（`electron/toolConfirmRegistry.ts:16`），而 `ConfirmRequest.timeoutMs` 被硬编码传 `null`（`electron/toolChatLoop.ts:1379`），无人消费。
9. **`loose` 是按宽严分化的旋钮**：定义为「非 locked 的 ask 条目下调为 allow」（`src/shared/policy/policyPackages.ts:7`、`:113`），且对任意 lane 生效（`:105-121`）→ 可配置出「无人监督 + 自动放宽」的组合。

---

## 3. 硬不变量

以下五条既是设计约束也是验收项，实现不得绕过。

- **I1 回答者与 lane 正交**：lane 只表达来源身份（审计 / 套餐 / 限权）；「未命中规则与缓存时谁来回答」由回答者配置决定。
- **I2 标准唯一**：审批 Agent 的裁决标准只有一份（一个 Skill、一份 Prompt），桌面自动审批档与管家共用；场景差异不得改变裁决标准。
- **I3 记忆只源于人类**：`decision_cache` 只能由人类确认或用户显式设置 / 迁移写入；审批 Agent 的裁决**永不**产生缓存条目；`DecisionCacheEntry['source']` 不新增 `'agent'`。
- **I4 未命中即 fail-closed**：回答者不可用、超时、输出不可解析时一律拒绝，**放行方向不可放宽**；且**无人值守上下文中不得回退为「询问用户」**——那里无人可问，回退等于挂死 5 分钟再超时。**有人值守上下文（桌面 / IM）的失败去向由该链路策略决定，不在本不变量约束内**（详见 `docs/develop/desktop-fail-open-to-user-plan.md`）。
- **I5 递归终止条件不可配置**：审批调用不再进入确认流程 —— 这条豁免是**递归终止条件**，不是授权，因此**不得进入用户可配置的规则集**：既不可放宽，也不可收紧。它**不属于 `locked` 底线集**（`locked` 只拦放宽，拦不住收紧），属于**不可变集**（基线 §7.1 第三条判据、§7.2 递归边界）。若因实现或配置缺陷仍触发了内层确认、或递归深度上界被触达，结论一律 **fail-closed**，并落 `confirm.outcome` + `cause=recursion-blocked`（与 `cause=agent-deny` 必须可区分）。

## 4. 设计

### 4.1 概念模型

```text
工具调用
  └─ 策略引擎：规则匹配 + 决策缓存读取              （既有：evaluateToolCallGate）
       ├─ allow / deny  → 直接结论
       └─ require-confirm
            └─ 回答者解析 resolveConfirmChannel({ lane, profile, config })
                 ├─ user  → DesktopChannel / ImChannel     （既有实现）
                 ├─ agent → AgentChannel → 审批 Agent 调用  （本设计新增）
                 └─ deny  → DenyChannel （fail-closed；配置不合法或无生产者时的兜底）
```

三层职责，互不替代：

| 层 | 取值 | 作用 |
| --- | --- | --- |
| lane（来源身份） | `desktop \| wechat \| feishu \| automation` | 审计、套餐、限权 |
| 回答者（answerer） | `user \| agent \| deny` | 未命中规则与缓存时由谁裁决 |
| 裁决标准 | 审批 Agent 的 Skill（唯一一份） | 怎么裁决 |

### 4.2 回答者配置

```ts
export type ConfirmAnswererKind = 'user' | 'agent' | 'deny'

export interface ConfirmAnswererPolicy {
  kind: ConfirmAnswererKind
  /** kind='agent' 时使用；缺省用全局唯一的审批 Profile。 */
  approvalProfileId?: string
  /** 覆盖默认超时；**不得为 null** —— 无人场景必须有上界。 */
  timeoutMs?: number
}

export type ConfirmAnswererMap = Partial<Record<ExecutionLane, ConfirmAnswererPolicy>>
```

默认值与允许范围：

| lane | 默认回答者 | 是否可配为 `agent` | 说明 |
| --- | --- | --- | --- |
| desktop | `user` | 是（即「自动审批」档位） | 默认行为与现状一致 |
| wechat | `user` | 否（本期） | 与现状一致 |
| feishu | `user` | 否（本期） | 与现状一致 |
| automation | **`agent`** | 否（强制） | 无人值守；不得配置为 `user` |

解析规则：

- 配置缺失 → 用上表默认值。
- 配置损坏、lane 未知、`kind='agent'` 但 Profile 不存在 → **`deny`**（I4），并落审计告警。
- 🔴 **无人值守上下文中绝不回退为 `user`**：那里「回退去问用户」等于挂死 5 分钟再超时。**有人值守链路（桌面 / IM）不适用本禁令**——其「失败 → 挂人工确认卡」属正常形态，按各自链路策略决定（见 `docs/develop/desktop-fail-open-to-user-plan.md`）。

### 4.3 `AgentChannel`

由 **Runtime 在装配期构造**（`profile` 与 `invokeApproval` 都是构造注入），实现既有的 `ConfirmationChannel` 接口，不改接口形状 —— 所以 Safety 只依赖端口，看不到 Runtime，也不知道回答者是人是 Agent（基线 §2.6、§7.2）：

```ts
export class AgentChannel implements ConfirmationChannel {
  constructor(private readonly deps: {
    requestId: string
    sessionId: string
    toolName: string
    lane: ExecutionLane
    profile: ApprovalProfile
    audit?: AuditSink
    invokeApproval: (req: ApprovalInvocation) => Promise<ApprovalVerdict>
    /** 本任务内已裁决摘要（§4.10）—— 不是缓存，不落库。 */
    priorVerdicts?: PriorVerdictSummary[]
  }) {}

  async request(req: ConfirmRequest): Promise<ConfirmOutcome> { /* … */ }
  cancel(requestId: string): void { /* 中断内层审批调用 */ }
}
```

要点：

- **不产生 `memory`**：返回值不含 `memoryKey`，且即使含也被准入闸拒绝（I3 / §4.7）。
- 超时取 `req.timeoutMs ?? profile.timeoutMs`，**必须有上界**（建议 30s 起，按 Profile 可调）。超时 → `rejected` + 理由「审批超时，已按拒绝处理」，**不是**挂 5 分钟。
- `cancel` 必须真正中断内层调用（复用 Core 的取消机制，见 `docs/develop/architect/agent-core-roadmap.md` 工作块 1 / 4）。
- 审计落 `confirm.request` / `confirm.outcome`，`actor: 'agent'`，带 Profile、模型、耗时。

### 4.4 审批 Agent 的 Profile

审批 Agent 同样是 **Core 的调用者**，用与管家 Agent 相同的 Profile 机制（见上游规划工作块 4）：

| 项 | 取值 | 理由 |
| --- | --- | --- |
| 模型 | 快档 | 每条未命中确认都要调用，延迟敏感 |
| 工具集 | **封闭只读集合**（只能收窄，不能加宽）；**免再审批**见 I5 —— 它是终止条件，不是可配置的授权 | 读文件、列目录、看 diff / git 状态、查决策缓存、读安全审计日志 |
| Skill | `security-approval`（唯一一份） | I2 |
| 输出 | 有界结构化（§4.5） | 不接受中间态 |
| 侦查轮数 | 有上界（建议 ≤ 3 轮） | 到顶必须给结论 |
| 会话域 | 独立，不与用户会话或管家会话共用 | 避免污染与串扰 |

🔴 **递归边界（I5）**：审批 Agent 自身的工具调用**不再进入确认流程**。原因是其工具集本就是封闭只读集合；再走一遍确认会造成「审批套审批」的无限递归。不能依赖「它不会调危险工具」的约定，但**也不能做成一条用户可覆盖的 allow 规则** —— 那条路有两个坏结局：被 `custom` / `loose` 收紧成 `ask` 时，审批调用再次进入确认、撞上 §4.4 的侦查轮数上界，**全线 fail-closed、自动审批静默停摆**；被放宽则毫无意义（它本来就是 allow）。**这里收紧破坏的不是权限，而是安全路径本身的可运行性。**

因此落法二选一，语义相同：

1. **判定引擎内的递归守卫**（推荐）：与 fail-closed 同级的引擎语义，按 lane 识别 —— 只认识 lane、不认识业务身份，符合基线 §6.1 的硬规则。
2. **规则表达 + 不可变集标记**：仍用规则形状，但把它标进**不可变集**（放宽、收紧都不允许），而不是 `locked` 底线集。

无论哪种落法，**必须能兜住「豁免失效」这一状态**：若检测到本次内层调用仍进入了确认流程（或递归深度触顶），结论为 **deny**，理由对模型可读（「安全策略无法完成裁决，已拒绝」），审计落 `confirm.outcome` + `cause=recursion-blocked`。这条同时是可观测性要求 —— 否则现象是「审批突然开始拒绝一切」，而没人看得出是配置把终止条件改坏了。

### 4.5 裁决输出（有界）

```ts
export type ApprovalVerdict =
  | { kind: 'approve'; reason: ApprovalReason }
  | { kind: 'deny'; reason: ApprovalReason }

export interface ApprovalReason {
  /** 给模型的可操作理由（会进入工具结果；不得泄露敏感信息）。 */
  summary: string
  /** 给审计的依据（路径 / 命令 / 结论要点）；不进入模型可见文本。 */
  evidence?: string[]
  confidence?: 'low' | 'medium' | 'high'
}
```

**只有两种输出，没有第三种。** 特别地：

- 不接受「需要更多信息 / 请补充」这类中间态 —— 那会让管家 Agent 无法推进（与 I4 同类的问题）。
- 输出不可解析、超时、模型不可用 → 一律 `deny`。

`ConfirmOutcome` 扩展（保持既有变体兼容，新增字段全部可选）：

```ts
export type ConfirmOutcome =
  | { kind: 'approved'; memory?: CacheKey; reason?: ApprovalReason }
  | { kind: 'rejected'; memory?: CacheKey; reason?: ApprovalReason }
  | { kind: 'timeout'; reason?: ApprovalReason }
  | { kind: 'approved-with-action'; action: 'continue' | 'back-to-desktop' | 'stop' }
```

### 4.6 拒绝理由回传（修缺口 3、4）

1. 模型可见文案由 `reason.summary` 渲染；无理由时回退到既有文案（保证不回归）。
2. `rejectReason` 从三值扩展为带来源的形态（`'user' | 'policy' | 'agent' | 'timeout' | …`）。
3. 🔴 **`toolErrorRepeat` 的计数口径必须区分「执行失败」与「安全拒绝」**：今天两者共用计数器，连续 3 次即中止 Turn（`electron/toolChatLoop.ts:284`、`:1668` 附近）。若沿用，管家 Agent 会因为「同类操作被拒 3 次」而整个 Turn 中止，而不是改方案。建议安全拒绝单独计数（更高阈值），或仅在「同一工具 + 同一拒绝理由」时计数。

### 4.7 缓存写入准入（修 I3 与缺口 5、6）

**建议把回答者身份并入既有的记忆资格判定**，而不是新增第四条路径 ——`deriveMemoryEligibility` 的设计意图就是「缓存读取、确认 UI 档位、缓存写入共享同一结果」（`src/shared/policy/memoryEligibility.ts:14`）：

```ts
deriveMemoryEligibility(facts, lane, answererKind)
// answererKind !== 'user' → eligibility = 'none'（理由：non-human-answerer）
```

于是三道闸变成：

1. **资格闸**：`deriveMemoryEligibility(...)` ≠ `none`（含新增的回答者维度）。
2. **档位闸**：key 必须出现在策略层本次给出的 `memoryTiers` 中（既有，`electron/confirmation/decisionCacheWriter.ts:60-78`）。
3. **写入断言（防御）**：`recordUserAnswerFromMemoryTiers` 增加 `answererKind` 参数，非 `'user'` 直接抛错；`source` 由回答者派生，不再硬编码。

配套修复：

- 改掉不看回答者就写缓存的两处：`electron/toolChatLoop.ts:1580-1595`、`:1607-1622`。
- `DecisionCacheEntry['source']` 保持 `'user-confirm' | 'settings' | 'migration'`，**不新增** `'agent'`（让类型承载 I3）。

### 4.8 无人回答者的套餐约束

`kind === 'agent'` 的 lane 不得使用 `loose` 套餐，也不得通过 `custom` 向下覆盖。

- 现状无此约束：`resolvePolicyRules` 对任意 lane 按 `packages[lane]` 变换（`src/shared/policy/policyPackages.ts:105-121`）。
- 落地：主进程在写入配置时强校验（强制度对齐 `validateRuleOverride`，`policyPackages.ts:58`）；解析期遇到非法组合按 `standard` 处理并落审计告警。
- 先例：`FAIL_CLOSED_IDS` 三条 `locked` 规则（`src/shared/policy/policyPackages.test.ts:137-146`）已是「不许被放宽」的既有形态；本条把同一思路从「某些规则」扩展到「某些配置组合」。

### 4.9 与 `auto-evaluator` 的关系（不合并）

保留 `auto-evaluator` 作为**确定性、无 LLM 的预过滤**（现实现 `electron/confirmation/toolCallGate.ts:330-341`）；审批 Agent 作为**未命中后的兜底**。二者不同层：

- `auto-evaluator` 便宜，可在 gate 内同步完成；
- 审批 Agent 昂贵（一次 Core 调用），必须只在规则与缓存都未命中时触发。

因此本设计**不把审批 Agent 塞进 `autoEvaluator` 钩子**，而是挂在回答者位置。`auto-evaluator` 的既有实现本期保持不动；把它的三分支逻辑下沉为规则属独立议题。

### 4.10 成本控制：裁决摘要作为输入，而不是缓存

管家任务中同类工具调用可能达数十次。按 I3 不能缓存，改用：

- `AgentChannel` 接收 `priorVerdicts`：**本任务内**已裁决过的摘要（工具、目标、结论、理由要点、时间）。
- 审批 Agent 据此快速判断「事实未变 → 维持结论」，但**仍然逐条给出裁决与理由**。
- 生命周期随 Turn 结束消失，不落库、不跨会话、不跨任务。
- 审计：每条裁决照常独立记录；引用前次结论时在 `evidence` 中标注。

**明确不做**（除非另行决定）：按「相同事实摘要」跳过调用直接复用前次裁决。风险是前序工具调用可能已改变磁盘状态，「同样参数」未必仍然安全。

---

## 5. 变更清单

| 文件 | 变更 | 类别 |
| --- | --- | --- |
| `src/shared/confirmation/types.ts` | 新增 `ConfirmAnswererKind` / `ConfirmAnswererPolicy` / `ConfirmAnswererMap` / `ApprovalReason` / `ApprovalVerdict` / `ConfirmOutcomeCause`；`ConfirmOutcome` 增加可选 `reason` 与**必填 `cause`**；`SecurityAuditEvent.actor` 扩展 `'agent'` 并新增 `actorRef` | 类型 |
| `src/shared/policy/memoryEligibility.ts` | `deriveMemoryEligibility(facts, lane, answererKind)`；非人类回答者 → `none` | 纯函数 |
| `src/shared/policy/policyPackages.ts` | 新增「`agent` 回答者的 lane 不得 `loose`、不得 `custom` 向下覆盖「的校验与 fail-closed 解析；定义**不可变集**并保证递归终止条件不在可配置规则集内（I5） | 纯函数 + 校验 |
| `electron/confirmation/channels.ts` | `channelFor` 改为按**回答者**选择实现（不再按 lane 硬编码）；新增 `DenyChannel` | 主进程 |
| `electron/confirmation/agentChannel.ts` | 新增：审批调用包装、超时、取消、审计、`priorVerdicts` | 主进程（新） |
| `electron/confirmation/toolCallGate.ts` | 产出回答者解析所需上下文；`policy.decision` 的 `actor` 如实填写；**递归守卫**与「豁免失效」检测，失配时产出 `cause=recursion-blocked`（I5） | 主进程 |
| `electron/confirmation/decisionCacheWriter.ts` | `recordUserAnswerFromMemoryTiers` 增加 `answererKind` 断言；`source` 由回答者派生 | 主进程 |
| `electron/toolChatLoop.ts` | `channelFor` 调用点改回答者解析；`:1580-1595` / `:1607-1622` 写入前校验回答者；拒绝文案改由 `reason` 渲染；`toolErrorRepeat` 计数口径区分安全拒绝与执行失败 | 主进程 |
| `electron/confirmation/settingsSecurityModel.ts`、`src/shared/confirmation/settingsCenter.ts` | 设置载荷增加 `answerers` | 主进程 + 共享 |
| `electron/skills/bundled/security-approval/` | 新增审批 Skill（唯一一份，I2） | 资源 |
| 渲染端设置页 / 审计页 | 档位选择；审计支持按「由 Agent 裁决」筛选 | 渲染 |

---

## 6. 失败与降级矩阵

全部路径一律 fail-closed（I4），且理由必须对模型可读，使管家 Agent 能改方案或放弃。

| 场景 | 行为 | 对模型可见 | 审计 |
| --- | --- | --- | --- |
| 审批 Agent 不可用（服务 / 模型缺失） | deny | 「安全策略不可用，已拒绝执行」 | `confirm.outcome`，`cause=unavailable` |
| 审批超时 | deny | 「审批超时，已按拒绝处理」 | `cause=timeout` |
| 裁决输出不可解析 | deny | 「安全策略未给出有效结论，已拒绝」 | `cause=unparsable` |
| Profile 缺失 / 配置损坏 | deny | 同「不可用」 | `cause=config-error` + 告警 |
| `agent` 回答者 + `loose` 套餐 | 按 `standard` 解析 + 告警 | 正常裁决 | `policy.config-rejected` |
| 内层调用被取消（Turn 取消 / 应用退出） | 不产出裁决 | 工具调用被中断 | `confirm.cancelled` |
| 未命中且回答者为 `deny` | deny | 「按安全策略拒绝执行此工具」 | `policy.decision` |
| **嵌套调用拿不到准入配额**（基线 §5 嵌套调用准入） | deny | 「系统繁忙，安全裁决暂不可用，已拒绝」 | `confirm.outcome`，`cause=unavailable` |
| **递归豁免失效 / 深度上界触顶**（I5） | deny | 「安全策略无法完成裁决，已拒绝」 | `confirm.outcome`，`cause=recursion-blocked` |

---

## 7. 审计设计

目标：任何一条自动裁决都能回答五个问题。

| 问题 | 由什么回答 |
| --- | --- |
| 这次是谁批的？ | `actor` + `actorRef` |
| 依据什么？ | `reason.evidence`（仅审计侧，不进模型可见文本） |
| 用哪个模型、花了多久？ | `actorRef.model` + `latencyMs` |
| 有没有被写进记忆？ | 是否存在对应的 `cache.write` 事件（I3 下不应存在） |
| **这次到底有没有拿到裁决**？ | `cause` —— `agent-deny` 是裁决，`unavailable` / `recursion-blocked` / `config-error` 是**没拿到裁决**，两者不得共用取值 |

变更：

- `SecurityAuditEvent.actor` 从 `'user' | 'system' | 'migration'` 扩展为加入 `'agent'`（`src/shared/confirmation/types.ts:233`）。
- 新增 `actorRef?: { profileId: string; model?: string; invocationId?: string }`。
- `confirm.request` / `confirm.outcome` 增加 `answerer: ConfirmAnswererKind`、`reasonSummary`、`evidenceCount`、`latencyMs`；**`confirm.outcome` 增加必填的 `cause`**，取值集合：`user-approved` / `user-denied` / `agent-deny` / `unavailable` / `timeout` / `unparsable` / `config-error` / `recursion-blocked`。
- **`cause` 是判定结果维度，不是装饰**：`agent-deny`（审批 Agent 裁决为否）与 `unavailable` / `recursion-blocked`（**根本没拿到裁决**）必须分开，否则「配额不足」或「终止条件被改坏」会被统计成「审批判定危险」，安全指标与审计口径同时失真（基线 §5 准入、§7.2 递归边界）。
- **轨迹层落盘**：审批调用的完整消息序列（Profile 提示、侦查工具调用与观察结果、最终裁决）落为归属 `internal`、可见性 `hidden` 的内部会话（即「内部调用记录」），锚在触发它的确认请求上（`actorRef.invocationId`），与审计同为只追加。该记录可作为后续裁决的输入（§4.10 的 `priorVerdicts`），但**不得跳过裁决**。详见 `docs/develop/architect/agent-core-roadmap.md` §1.5。
- 替换 `eventBase` 中硬编码的 `actor: 'system'`（`electron/confirmation/channels.ts:43`）与 `policy.decision` 的 `actor: 'system'`（`electron/confirmation/toolCallGate.ts:368`）。

---

## 8. 时序（两条主要路径）

### 8.1 桌面 · 自动审批档位

```text
工具调用 → gate：规则未命中、缓存未命中 → require-confirm
  → resolveConfirmChannel：lane=desktop，answerer=agent
  → AgentChannel.request(ConfirmRequest)
      → 审批 Agent（独立调用域，快模型，只读工具，≤3 轮侦查）
      → ApprovalVerdict{ approve|deny, reason }
  → ConfirmOutcome（不含 memory）
  → 记忆准入：answererKind='agent' → eligibility=none → 不写缓存
  → 记录审计（actor=agent, actorRef, evidence）
```

### 8.2 管家 Agent（无人）被拒后继续

```text
管家 Turn 内工具调用 → 未命中 → AgentChannel → deny(reason)
  → 工具结果携带 reason.summary 回到模型
  → 管家 Agent 依 Skill 决定改方案 / 换路径 / 收尾
  → 若同类操作被连续拒绝，按 §4.6 的独立计数规则处理（不误中止 Turn）
```

---

## 9. 测试方案

### 9.1 纯函数与契约

- `deriveMemoryEligibility`：新增回答者维度 —— `answererKind='agent'` → `none`；`'user'` 时输出与既有向量逐项一致（回归）。
- `resolveConfirmChannel`：默认值表逐 lane 断言；配置损坏 / Profile 缺失 → `deny`；`automation` 配 `user` 被拒。
- `resolvePolicyRules`：`agent` 回答者的 lane 配 `loose` → 解析为 `standard` 且落告警；`custom` 向下覆盖被拒。

### 9.2 不变量回归（最重要的两条）

- **I3 回归（验收锚点）**：构造「gate 返回 `require-confirm` + `memoryTiers` 非空 + 回答者为 `agent` + 工具为 `browser` navigate「的场景，断言 `decision_cache` **无新增行**、无 `cache.write` 审计。该用例在今天的代码上**会失败**（缺口 5），修复后转绿即是本设计的验收锚点。
- **I4 回归**：审批通道超时 / 抛错 / 返回不可解析 → 断言结论为 `deny`，且不产生长时间挂起（不是 5 分钟超时路径）。
- **递归边界（I5）**：审批 Agent 的只读工具调用不产生 `confirm.request`。
- **递归兜底（I5 负向）**：把免再审批的豁免强行覆盖为 `ask`，断言结论为 `deny`、审计为 `cause=recursion-blocked`、且**不出现无限递归**（侦查轮数上界生效）；同一用例断言它**不会**被记成 `cause=agent-deny`。
- **准入失败可区分**：模拟嵌套审批调用被准入拒绝，断言工具调用为 `deny`、审计 `cause=unavailable`，且与 `cause=agent-deny` 不同 —— 管家链路据此能给出「稍后重试」而不是「换个方案」。

### 9.3 集成

- `AgentChannel` × 真实 gate：`requestId` 关联正确、`confirm.request` / `confirm.outcome` 成对、`actor='agent'`、`latencyMs` 落库。
- 取消：Turn 取消 / 应用退出时内层审批调用被中断，无残留。
- 拒绝理由回传：模型侧拿到 `reason.summary`；连续 3 次同类**安全拒绝**不触发 `abortRepeatedToolError`。
- 标准唯一：桌面自动审批档与管家链路使用同一 `skillId` / `profileId`（断言相等）。

### 9.4 边界与负向

- 仅托盘 / 无窗口下走 `agent` 回答者全程无 UI 依赖（与上游规划工作块 4 的无窗口测试合并）。
- `automation` lane 首次有生产者后，套餐、审计、缓存按该 lane 正确归属。
- 审计按 `actor='agent'` 过滤可用。

---

## 10. 分期实施

### P0：类型与不变量（行为等价，可独立交付）

1. 类型：回答者、`ApprovalReason`、`ConfirmOutcome.reason`、`actor` 扩展。
2. `deriveMemoryEligibility` 回答者维度 + 写入断言 + 修掉两处不看回答者的写入（I3）。
3. `resolveConfirmChannel` + `DenyChannel`（默认全部回落 `user`，行为不变）。
4. 审计 `actor` 如实填写（替换两处硬编码 `'system'`）。

**退出标准**：现有行为零变化（快路径与现状逐项等价）；I3 回归用例转绿；审计可区分来源。

### P1：审批 Agent 接入

5. `AgentChannel` + 审批 Profile + `security-approval` Skill + 降级矩阵（I4）。
6. 拒绝理由回传 + `toolErrorRepeat` 计数口径（§4.6）。
7. 套餐约束（§4.8）。

**退出标准**：`automation` lane 端到端可跑；不可用 / 超时 / 输出不可解析全部 fail-closed 且理由可读。

### P2：桌面档位与体验

8. 设置页档位 + 载荷 `answerers`。
9. 审计页按 `actor` 筛选。
10. 成本优化（§4.10 的 `priorVerdicts`）。

**退出标准**：桌面可切换自动审批档位；同类调用的重复裁决不造成明显延迟。

---

## 11. 边界（不做）

- 不做审批 Agent 的长期记忆或跨任务学习。
- 不做多 Agent 投票 / 会签。
- 不给审批 Agent 任何写能力。
- 不改 `auto-evaluator` 的既有实现（§4.9）。
- 本期不把 wechat / feishu 改为 `agent` 回答者。
- 不做「相同事实摘要即复用裁决」的跳过式优化（§4.10）。

---

## 12. 待决问题

1. 🔴 **审批 Agent 的侦查输入形态**：只给 `ConfirmRequest.facts`（脱敏摘要），还是额外给结构化线索包（目标路径 / 命令 / URL / 涉及文件），或允许它读当前任务上下文？建议「facts + 线索包」，不给全量会话（成本与泄露双重考虑）。
2. 审批超时默认值（建议 30s）以及是否按风险分级（high risk 给更长）。
3. `toolErrorRepeat` 的安全拒绝阈值取值。
4. 桌面「自动审批」档位是否默认关闭（建议默认关闭，由用户显式开启）。
5. 审批 Profile 的调用域形态：审批调用不落用户会话，而是落为归属 `internal`、可见性 `hidden` 的内部会话（即「内部调用记录」，上游规划 §1.5、基线 §6.2）；与管家 Agent 的专用会话域不是同一机制。
6. 本设计与上游 §1.1「自动审批 Agent」的关系：**本设计假设二者是同一实体**（同一 Profile、同一 Skill）。若产品上要区分（例如桌面档位与管家用不同 Profile），需要重新审视 I2。
7. **嵌套调用的准入回旋机制取哪一种**（基线 §5）：给同步依赖留**保留位**，还是让调用在等待裁决期间**让出**已占配额位。语义已定（不豁免、优先级继承等待方、有界等待），但实现形态需要一个归属方与上界取值。附带待定：`cause` 枚举的最终取值集合。

---

## 13. 附录：证据索引

### 13.1 类型与接口

- `src/shared/confirmation/types.ts:18`（`ExecutionLane`，`automation` 注释「本期仅定义、不实现」）
- `src/shared/confirmation/types.ts:160`（`ConfirmRequest.timeoutMs` 声明）
- `src/shared/confirmation/types.ts:163`（`ConfirmOutcome` 四态）
- `src/shared/confirmation/types.ts:169`（`ConfirmationChannel` 接口）
- `src/shared/confirmation/types.ts:203`（`DecisionCacheEntry.source`）
- `src/shared/confirmation/types.ts:233`（`SecurityAuditEvent.actor`）
- `src/shared/confirmation/types.ts:253`（`PolicyAction` 含 `auto-evaluator` / `confirm-every-time`）
- `src/shared/confirmation/types.ts:267`（`PolicyRule`，含 `locked` / 门控字段）

### 13.2 策略层与套餐

- `src/shared/policy/policyPackages.ts:15`（默认套餐映射，`automation` 已在其中）
- `src/shared/policy/policyPackages.ts:7`、`:113`（`loose` = 非 locked 的 ask 下调为 allow）
- `src/shared/policy/policyPackages.ts:105-121`（`resolvePolicyRules` 按 lane 变换）
- `src/shared/policy/policyPackages.ts:48`、`:50`、`:58`（可编辑动作集与 `validateRuleOverride`）
- `src/shared/policy/policyPackages.test.ts:137-146`（`FAIL_CLOSED_IDS` 三条均 `locked`）
- `src/shared/policy/memoryEligibility.ts:14`（`deriveMemoryEligibility`）
- `electron/confirmation/policyRulesRuntime.ts:76`（`loadEffectivePolicyRules`）

### 13.3 门控与通道

- `electron/confirmation/toolCallGate.ts:107`（`laneOf` 仅三值）
- `electron/confirmation/toolCallGate.ts:330-341`（同步 `autoEvaluator` 三分支）
- `electron/confirmation/toolCallGate.ts:368`（`policy.decision` 的 `actor: 'system'`）
- `electron/confirmation/channels.ts:43`（`eventBase` 硬编码 `actor`）
- `electron/confirmation/channels.ts:107`（`channelFor` 按 lane 硬编码实现）
- `electron/confirmation/imChannel.ts:61`、`:213`（IM 通道 outcome 与 memoryTier 标签）

### 13.4 执行链路与缓存写入

- `electron/toolChatLoop.ts:1241`（`rejectReason` 三值）
- `electron/toolChatLoop.ts:1379`（`timeoutMs: null` 硬编码）
- `electron/toolChatLoop.ts:1398-1402`（通道结果压成三值）
- `electron/toolChatLoop.ts:1580-1595`、`:1607-1622`（不看回答者就写缓存）
- `electron/toolChatLoop.ts:1650-1653`（硬编码拒绝文案）
- `electron/toolChatLoop.ts:284`、`:1668`（`MAX_CONSECUTIVE_SAME_TOOL_ERROR = 3` 与中止）
- `electron/confirmation/decisionCacheWriter.ts:60-78`（`memoryTiers` 准入）
- `electron/confirmation/decisionCacheWriter.ts:15-18`、`:30`（TTL 与作用域推导）

### 13.5 设置面

- `electron/confirmation/settingsSecurityModel.ts:26`（按四 lane 装配套餐）
- `src/shared/confirmation/settingsCenter.ts`（`SecuritySettingsModelPayload` 五区）
