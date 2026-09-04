# `prepare_mission` 反复试错问题分析与改进方案

> 分析依据：`.agent/logs/Agent-20260728.log`  
> 对照版本：2026-07-28 本机 `/Applications/SpaceAssistant.app` 打包产物  
> 分析范围：Mission Intake、`prepare_mission` 工具契约、草稿校验、环境准备、相关大模型提示词  
> 修订状态：已响应三轮评审提出的 5 项阻断意见  
> 结论：当前问题不是“大模型偶尔填错字段”，而是 **Skill 未进入上下文、复杂领域模型直接暴露给模型、失败反馈只揭示局部 schema、非软件任务被强制走软件环境准备、GUI 运行时探测依赖 PATH，以及环境失败后允许模型擅自把“创建后台任务”降级为“当前会话直接执行”** 共同造成的系统性偏离。

## 1. 执行摘要

本次会话从 `2026-07-27T22:59:16.717Z` 到 `23:02:30.099Z` 共调用 `prepare_mission` **14 次**：

- 第 1～9 次：逐层猜测 `MissionDraft` 的结构；
- 第 10 次：结构校验已基本通过，但触发 `draft_evidence_unbound`；
- 第 11～13 次：继续猜测 `requiredEvidence` 及其 `source` discriminated union；
- 第 14 次：草稿终于通过格式及语义校验，却因 `which node` 失败返回 `runtime_unverified`；
- 总耗时约 193 秒，产生 13 次无效草稿提交，最终仍未创建 Mission。
- 随后模型没有停在“后台任务创建失败”的阻塞状态，而是自行改为在当前会话生成开发方案，改变了用户明确要求的执行方式。

日志还显示，本轮启动时内置 Skill 已被扫描到：

```text
skills.load skillNames=["background-mission-intake", ...]
```

但路由阶段实际是：

```text
skills.route.start skillCount=0
skills.route.done recommended=[] final=[]
```

最终 LLM system prompt 只列出了 `prepare_mission` 工具名称，没有注入 `background-mission-intake` 的完整说明。因此，已经编写好的最小合法示例、退出条件、字段规则和失败分类并未实际帮助本轮模型。

必须优先修复以下 P0：

1. `prepare_mission` 可用时，Mission Intake Skill 必须确定性注入，不能依赖语义路由碰运气。
2. 不再要求模型直接构造完整的内部 `MissionDraft` 领域对象；改为稳定、扁平、面向意图的工具输入，由宿主生成规范化 Draft。
3. 文档类 Mission 不得强制发布 Node/npm 软件环境。
4. Node/npm 探测不得依赖 Electron GUI 进程的 shell `PATH` 与 `which`。
5. Prepare 的数据库写入、环境发布和失败清理必须具备事务/补偿边界，禁止留下半完成记录。
6. 用户明确要求创建后台 Mission 时，Prepare 失败必须保持目标模式不变；除非用户再次授权，模型禁止切换为前台直接执行。

## 2. 日志复盘

### 2.1 调用时间线

| 轮次 | 时间（UTC） | 主要失败 | 暴露的问题 |
|---:|---|---|---|
| 3 | 22:59:16 | 使用 `title/description/successCriteria: string[]/outputPath` | 模型按常见任务 API 猜测，未掌握领域 schema |
| 4 | 22:59:37 | `objective`、`verification`、`outputContract` 结构错误 | 首次错误只暴露部分下一层结构 |
| 5 | 22:59:52 | assumption、verification kind、deliverable kind 错误 | 模型继续用自然语义字段猜测 |
| 6 | 23:00:08 | 把 scope 字符串改成对象，反而新增 31 处错误 | 局部反馈导致错误方向修正 |
| 7 | 23:00:23 | assumption 缺 source/confidence/confirmation | 深层必填字段此前不可见 |
| 8 | 23:00:36 | union 分支缺各自必填字段；deliverable 多余 path/description | discriminated union 对模型不友好 |
| 9 | 23:00:51 | 缺 validators/evidence；reviewPolicy 等字段形状错误 | 内部领域结构继续逐层泄露 |
| 10 | 23:01:05 | capabilities 和 budget 形状错误 | 模型自创授权和预算 DSL |
| 11 | 23:01:19 | budget 多余字段、缺 recovery、顶层 constraints 非法 | schema 猜测接近尾声 |
| 12 | 23:01:32 | `draft_evidence_unbound` | 格式合法不等于跨字段语义合法 |
| 13 | 23:01:47 | requiredEvidence 缺字段、kind 非法 | 再次进入深层 schema 猜测 |
| 14 | 23:02:01 | evidence source union 错误 | 错误信息继续充当 schema 分页器 |
| 15 | 23:02:15 | evidence source 分支缺必填字段且含非法 `detail` | union 分支仍靠错误反馈反推 |
| 16 | 23:02:30 | `runtime_unverified: failed to resolve node: ... which node` | 业务草稿已正确，环境准备仍阻断文档任务 |

注：表中“轮次”是 LLM tool loop round；round 3～16 共对应 14 次 `prepare_mission` 调用，前两轮用于读取需求和目录。

### 2.2 反复试错的典型模式

模型的 reasoning 多次出现“只剩下”“快了”“最后几步”，说明它把每次错误当作完整剩余问题。但错误格式化器最多只显示 8 条，并明确存在：

```text
…另有 31 处错误未列出
```

这形成了错误认知：

```text
提交猜测
  → 校验器仅返回前 8 条
  → 模型认为修完这 8 条即可
  → 下一层或被截断错误出现
  → 再次提交
```

当前错误返回虽然比原始 Zod dump 可读，但在缺少完整契约时，本质上变成了“交互式 schema 探测协议”。

### 2.3 Prepare 失败后的错误降级

`23:02:31.009Z`，工具返回：

```text
runtime_unverified: failed to resolve node: Command failed: which node
```

下一轮模型明确推断：

```text
既然 prepare_mission 因为环境原因无法正常工作……
我可以在当前对话中直接完成用户的需求。
```

并向用户输出：

```text
后台 Mission 功能因当前环境缺少 Node.js 运行时无法启动。
不过没关系，我可以在当前对话中直接完成这个任务。
```

随后它调用 `read_file` 继续读取参考设计，准备直接生成文档。这一行为有三个问题：

1. **改变了用户明确选择的执行模式。** 用户要求“创建一个后台任务”，交付内容和执行方式都是请求的一部分；前台代执行不是等价降级。
2. **绕过了 Mission 产品边界。** 后台 Mission 的确认、预算、生命周期、评审、取消、恢复和结果接收语义无法由当前聊天中的一次直接执行替代。
3. **把环境阻断误当成执行授权。** `runtime_unverified` 只说明当前创建链路失败，并不授予模型使用当前会话工具写文件或消耗长任务预算的权限。

模型没有恶意越权，而是在缺少“失败后的模式保持规则”时采用了通用助手常见的“尽量继续完成目标”策略。因此只修 Node 探测仍不充分：未来任何 `backend_unverified`、`feature_disabled`、确认 UI 不可用或预算阻断都可能触发同类前台降级。

### 2.4 为什么本次没有出现用户确认

这里必须区分“聊天澄清”和“Mission 确认”：

- **聊天澄清**发生在 Prepare 前，只在目标、范围、授权、预算或交付合同存在重大歧义时需要；
- **Mission 确认**发生在 Prepare 成功后，由桌面确认页展示规范化 Brief、环境和 hash，用户确认后才允许创建 Mission/Run。

本次用户输入已经明确了目标、评审要求和输出目录，因此模型先做必要的只读探索并构造 Intake，不代表已经开始执行后台任务，也不必为了形式再进行一次聊天确认。真正缺失的是 Prepare 后的桌面确认。

日志中 14 次 `prepare_mission` 全部失败，最后一次为 `runtime_unverified`，没有任何成功的 tool result，也没有 `mission:prepared` 事件。因此本次确认页没有出现的直接原因是：

```text
Prepare 未成功
  → 没有 PreparedMission preview
  → 不发送 mission:prepared
  → 桌面确认页没有可展示对象
```

对打包实现的检查表明，成功路径已经存在：

```text
prepareMissionExecutor
  → service.prepareMission()
  → notifyPrepared(webContentsId, preview)
  → IPC mission:prepared
  → Renderer MissionConfirmDialog
  → mission:confirm
  → confirmPreparedMission()
```

所以不能把本次现象简单归为“确认功能未实现”。准确结论是：

1. **Skill 引用问题**：`background-mission-intake` 未注入，使模型没有按 Intake 规则区分澄清、Prepare、确认和失败退出；
2. **Prepare 前置缺陷**：文档任务被错误的 Node 环境准入阻断，导致确认对象始终无法生成；
3. **失败路径逻辑缺陷**：Prepare 失败后没有 host guard，模型擅自切换到前台执行；
4. **确认投递的潜在可靠性缺陷**：当前 `notifyPrepared` 使用一次性 IPC 通知，发送结果没有 Renderer ack，通知异常还会被吞掉。即使 Prepare 成功，窗口切换、监听器尚未挂载或发送失败时，也可能存在 PreparedMission 已创建但确认页未出现的风险。此项不是本日志的直接原因，但属于同一确认闭环需要修复的实现缺口。

## 3. 当前逻辑分析

### 3.1 工具契约

打包实现中：

- `prepareMissionTool.js` 将完整 `missionDraftSchema` 转换成 JSON Schema；
- description 中附带最小合法 Draft 示例；
- 工具参数只允许 `{ draft }`；
- Draft 使用大量 strict object、深层必填字段和 discriminated union。

单一事实源和 strict 校验方向正确，但 **内部持久化领域模型不适合作为 LLM 工具的直接写入协议**。当前 Draft 至少包含：

- objective 与结构化 assumptions；
- 四类 criterion verification union；
- deliverables、validators、requiredEvidence；
- requiredEvidence source 的第二层 union；
- review policy；
- capability flags 与 justification；
- budget；
- unresolved issues；
- 多组跨字段绑定规则。

JSON Schema 能表达这些约束，不代表模型能稳定一次生成。尤其当前模型为 OpenAI/Anthropic 兼容网关后的 `deepseek-v4-pro`，对深层 `anyOf + const + additionalProperties:false` 的实际遵循能力不能假定与 schema 完全一致。

### 3.2 Skill 路由

`background-mission-intake` Skill 已包含本次最需要的信息：

- 调用退出条件；
- A/B/C 澄清规则；
- 禁止字段；
- verification 结构说明；
- 文档任务最小形式；
- 完整合法示例；
- 失败类型与是否允许重试。

但日志表明它未被路由进入本轮。根因不应只归结为路由模型“推荐错了”：

- `prepare_mission` 是强领域工具，其正确调用依赖对应 Skill；
- 工具被暴露与 Skill 被注入目前是两个独立决定；
- 系统允许出现“工具可调用，但使用说明缺席”的非法组合；
- `skills.route.start skillCount=0` 还说明路由候选集本身为空，需要检查会话过滤、缓存或调用参数，而不只是触发词。

### 3.3 草稿校验与错误反馈

当前错误处理存在三个层面：

1. Zod 结构校验；
2. `assertMissionDraftPrepareReady` 跨字段语义校验；
3. backend/runtime/environment 准入。

问题在于三个层面的失败都只能通过真实调用 `prepare_mission` 才被发现。模型无法在本地完成无副作用预检，也没有 retry ceiling。

此外，Zod 错误最多展示 8 条。对用户展示时合理，对模型修复却信息不足；同一个字符串同时承担“用户友好错误”和“机器可修复反馈”，目标冲突。

### 3.4 环境准备

`prepareMissionExecutor.resolveSoftwareInputs()` 只要当前 workDir 同时有 `node_modules` 和 `package-lock.json`，就自动把请求标记成 software Mission。随后 `prepareMission()` 会发布依赖环境并探测 Node/npm。

这导致：

- Mission 是否属于软件任务不是由交付物、验证器或显式请求判断，而是由工作目录中恰好存在两个文件推断；
- 本次目标只是生成 Markdown 文档，仍被迫探测 Node/npm；
- “仓库是 Node 项目”被错误等价为“该 Mission 需要可执行 Node 环境”；
- Prepare 阶段承担昂贵且易失败的 dependency publication，与“生成确认预览”的职责耦合。

### 3.5 Node/npm 探测

`nodeRuntimeProbe.resolveWhich()` 在 macOS/Linux 上执行：

```ts
execFileSync('which', ['node'])
```

Electron 从 Finder 启动时通常不继承交互式 zsh 配置。本机终端中 `node` 实际位于 `/opt/homebrew/bin/node`，但 GUI 进程 PATH 未必包含 `/opt/homebrew/bin`，因此 `which node` 失败并不能证明 Node 不存在。

此外：

- `which` 是 shell 用户环境工具，不是可信运行时发现 API；
- 仅依赖 PATH 无法覆盖配置路径、内置 runtime、nvm/asdf/volta 路径；
- 错误只说 `which node` 失败，没有给出配置入口、已检查候选或“本任务其实不需要 Node”；
- Node 与 npm 被捆绑探测，而某些 Mission 或 validator 可能只需其中之一。

### 3.6 Prepare 原子性

`MissionApplicationService.prepareMission()` 的顺序是：

1. 校验 Draft 与 backend；
2. `INSERT prepared_missions`；
3. 若为 software，探测 runtime 并发布 environment；
4. 计算 confirmation hash；
5. `UPDATE prepared_missions`。

如果第 3 步失败，已插入的 `prepared_missions` 可能停留在 `pending`，且 `draft_hash` 仍为空。除非数据库层另有未见的补偿清理，该顺序存在半完成记录和容量资源泄漏风险。Prepare 的失败不应产生用户不可见、不可确认的残留事实。

## 4. 根因分级

### P0-1：工具与必需 Skill 未绑定

这是 13 次 schema 重试的首要诱因。工具 schema 即使完整，也不能替代领域使用说明、默认策略和跨字段示例。

### P0-2：LLM 工具协议直接复用了内部领域模型

`MissionDraft` 适合做规范化后的持久化模型，不适合做生成模型的输入协议。当前让模型承担了大量机械引用绑定：

- `deliverableKey` 必须引用 deliverable；
- `evidenceKey` 必须与 requiredEvidence 唯一映射；
- review/manual/validator source 各有不同字段；
- validator、criterion、evidence 之间需保持一致。

这些应由确定性代码生成和校验，而不是消耗 LLM 推理与重试预算。

### P0-3：任务类型与环境需求判断错误

从 workDir 文件存在性推断 software Mission，使所有 Node 仓库里的文档任务都被软件环境准入阻断。

### P0-4：GUI 运行时发现机制不可靠

`which node` 把“GUI PATH 中不可见”误报为“运行时不存在”。

### P0-5：Prepare 缺少明确的原子提交/补偿边界

环境发布失败发生在 prepared record 插入之后，可能留下半成品。

### P0-6：失败后没有执行模式保持与授权边界

系统没有把“用户要求创建后台任务”固化为不可由模型自行改写的 interaction contract，也没有给 `prepare_mission` 环境错误返回明确的 `fallbackAllowed: false`。结果是模型把“后台创建失败”解释为“可以自行换一种方式完成内容目标”。

这里必须区分：

- **目标降级**：减少交付范围或降低验收标准；
- **执行模式降级**：从后台 Mission 改为当前会话直接执行；
- **后端回退**：在 Mission 系统内部按既定策略从 Codex 切换到 Builtin；
- **修复引导**：保持后台意图，帮助用户修复环境后重试。

前三者都可能改变授权、预算、生命周期或产品语义。只有 Mission 内部预先授权的后端回退可自动进行；前台代执行必须再次获得用户明确同意。

### P1-1：错误反馈截断且无机器可修复结构

模型只看到错误分页，无法区分“本次已列全”与“后面还有更多层”。

### P1-2：没有同类失败重试上限

工具循环允许连续 13 次 `draft_invalid`。系统已有通用 tool error repeat tracker，但从结果看没有对“同工具 + 同错误类别 + 草稿差异很小”形成有效熔断。

### P1-3：Prepare 同时承担预检、环境发布和 UI 预览

确认页准备本应快速、可恢复；当前却在预览前执行后端硬准入、runtime hash、依赖发布等高成本动作。

### P1-4：review 语义由模型自行拼装，容易偏离用户意图

用户要求“方案评审直到无阻断项”，模型最终选择了：

```json
{"mode":"always","reviewer":"user"}
```

这与“后台自治评审并迭代”未必一致。当前 enum 只有 `independent_agent | user`，但提示词没有明确如何从用户语义映射；这应被识别为需澄清或使用产品默认，而不是由模型临场猜测。

## 5. 目标架构

建议将“LLM 输入”“规范化 Draft”“确认绑定”拆成三层：

```text
用户意图
  ↓
MissionIntent（LLM 友好、少字段、允许自然语言）
  ↓  normalize/build（宿主确定性生成 key、evidence、默认预算）
MissionDraft（严格领域模型）
  ↓  validate + 必要环境稳定扫描/不可变发布
PreparedMission / Confirmation Brief
  （draftHash 已绑定 environment identity/descriptor）
  ↓ 用户确认
原子转移已确认的 environment binding + Run 创建
```

核心原则：

- LLM 表达目标、边界、交付物、显式验证语义和需要的能力；
- 宿主负责生成稳定 ID、引用关系、evidence 映射和默认值；
- LLM 不生成 executable/argv 等任意命令，也不从自然语言猜测验证类型；validator 与人工确认策略只能引用宿主注册表；
- 需要软件环境时，Prepare 必须在确认前完成稳定扫描、容量 reservation 和不可变发布，并把完整 environment binding 纳入 confirmation hash；
- 不需要软件环境的文档类 Mission 跳过环境发布；
- 内部 `MissionDraft` schema 可继续保持 strict，不再直接作为主工具输入。
- 用户选择的执行模式作为权威请求约束保存；失败只能进入阻塞、修复或用户重新决策，不能由模型隐式降级。

## 6. 具体改进方案

### 6.1 P0：新增 LLM 友好的 `MissionIntent`

把 `prepare_mission` 输入改为：

```ts
interface PrepareMissionInput {
  intent: {
    name: string
    goal: string
    includedScope: string[]
    excludedScope: string[]
    deliverables: Array<{
      title: string
      kind: 'document' | 'code_change_set' | 'data' | 'media' | 'other'
      required?: boolean
    }>
    acceptance: MissionAcceptanceIntent[]
    review?: {
      required: boolean
      reviewer?: 'independent_agent' | 'user'
      iterateUntilNoBlocker?: boolean
    }
    capabilities?: Partial<RequestedCapabilities>
    budget?: Partial<SuggestedBudget>
    assumptions?: Array<{
      description: string
      source: 'user' | 'repository' | 'default' | 'agent_inference'
      requiresConfirmation?: boolean
    }>
    unresolvedIssues?: Array<{
      description: string
      impact: UnresolvedIssueImpact
      blocking: boolean
    }>
  }
}

type MissionAcceptanceIntent =
  | {
      description: string
      verifyBy: 'artifact'
      deliverableRef: number
    }
  | {
      description: string
      verifyBy: 'registered_validator'
      validatorProfileId: string
    }
  | {
      description: string
      verifyBy: 'review'
      deliverableRef: number
    }
  | {
      description: string
      verifyBy: 'manual'
      confirmationPolicyId: string
    }
```

上面的 TypeScript union 用于说明领域语义；实际给模型的 JSON Schema 使用单层对象：

```ts
interface MissionAcceptanceIntentWire {
  description: string
  verifyBy: 'artifact' | 'registered_validator' | 'review' | 'manual'
  deliverableRef?: number
  validatorProfileId?: string
  confirmationPolicyId?: string
}
```

宿主根据 `verifyBy` 严格检查对应字段“必有且仅有”，从而避免深层 `anyOf`，同时不丢失验证语义。

由 `MissionDraftBuilder` 确定性完成：

- slug/key 生成与去重；
- 按 acceptance 数组顺序生成稳定 criterion ID；
- `deliverableRef` 只允许引用 `deliverables` 数组中的有效索引，并转换为生成后的 deliverable key；
- `registered_validator` 只允许引用宿主 `ValidatorProfileRegistry` 中已启用的 profile，宿主从 profile 固化 executable、args、environment policy、timeout 和版本；
- `manual` 只允许引用宿主 `ConfirmationPolicyRegistry` 中已注册的 policy；
- 根据显式 `verifyBy` 生成 criterion verification；
- 为 command/review/manual criterion 生成唯一 evidence key、requiredEvidence 和对应 source；
- 默认 confidence；
- 默认 capabilities 全 false，再按任务需要开启；
- 默认 budget；
- `review.required && iterateUntilNoBlocker` 映射成明确的 review policy/strategy；
- 跨引用合法性。

“LLM 友好”的边界是隐藏机械 ID、内部 key 和重复的跨引用，不是删除 verification 语义。若用户目标不足以确定 `verifyBy` 或 manual confirmation policy，builder 返回 `clarification_required`。validator profile 的未知、禁用或版本失效属于宿主候选问题，不得要求用户解释内部 ID。禁止：

- 从验收描述关键词猜测 verification kind；
- 让模型自由填写 executable 或 argv；
- 把无法判定的 criterion 统一降级为 artifact/manual；
- 自动选择权限更大或验收强度更低的 profile。

#### Intent → Draft 完整映射

| Intent 分支 | Registry/引用校验 | `successCriteria[].verification` | `outputContract.requiredEvidence` |
|---|---|---|---|
| `artifact + deliverableRef` | 索引必须指向 required/optional deliverable | `{kind:'artifact', deliverableKey}` | 不生成 |
| `registered_validator + validatorProfileId` | profile 必须存在、启用且适配当前 Mission 类型 | `{kind:'command', validatorId, evidenceKey}` | `kind` 取 profile 声明的 `test_result/typecheck/build/other`，`source={kind:'validator', validatorId}` |
| `review + deliverableRef` | 索引必须指向目标 deliverable | `{kind:'review', targetKey, evidenceKey}` | `kind:'review'`，`source={kind:'review', targetKey}` |
| `manual + confirmationPolicyId` | policy 必须存在、允许当前 surface/风险等级 | `{kind:'manual', confirmationPolicyId, evidenceKey}` | `kind:'manual'`，`source={kind:'manual', confirmationPolicyId}` |

注册表最小契约：

```ts
interface ValidatorProfile {
  id: string
  version: string
  evidenceKind: 'test_result' | 'typecheck' | 'build' | 'other'
  validator: {
    kind: 'command'
    executable: string
    args: string[]
    cwd: 'candidate_worktree'
    environmentPolicyId: string
    timeoutSeconds: number
    passCondition: 'exit_code_zero'
  }
  supportedDeliverableKinds: DeliverableKind[]
}

interface ConfirmationPolicy {
  id: string
  version: string
  allowedSurfaces: Array<'desktop'>
  description: string
}
```

registry lookup、profile 版本和实际固化后的 validator contract 必须进入确认绑定；确认后注册表变化不能改变已确认 Mission 的验证器。

生产工具协议直接替换为 `{ intent }`。完整 `{ draft }` 仅保留为宿主内部类型，不再作为任何 LLM 可见工具入口，避免双协议、迁移分支和模型选择歧义。

#### Validator profile 发现与绑定

不新增 profile 查询工具。每轮 LLM 请求构建工具定义时，宿主从当前可信 workDir、启用配置和 capability policy 生成 `ValidatorProfileCatalogSnapshot`：

```ts
interface ValidatorProfileCatalogSnapshot {
  snapshotId: string
  requestId: string
  sessionId: string
  actorId: string
  surfaceId: string
  createdAt: number
  expiresAt: number
  profiles: Array<{
    id: string
    version: string
    contractHash: string
    displayName: string
    purpose: 'test' | 'typecheck' | 'build' | 'other'
    supportedDeliverableKinds: DeliverableKind[]
    requiredCapabilities: Array<'readFiles' | 'shell'>
  }>
  confirmationPolicies: Array<{
    id: string
    version: string
    contractHash: string
    description: string
    allowedSurfaces: Array<'desktop'>
  }>
  snapshotHash: string
}
```

宿主把 `profiles[].id` 生成 `validatorProfileId` 的动态 enum，并把每个候选的 `id、displayName、purpose、supportedDeliverableKinds、requiredCapabilities` 以紧凑表格注入同一轮 Intake 上下文。模型只能选择已展示的 enum 值，不需要也不允许猜测 registry ID。

`confirmationPolicyId` 采用同一机制：工具定义只暴露当前 surface 可用 policy 的动态 enum 和简短说明，避免 manual verification 再次退化成内部 ID 猜测。无需为此增加新的查询工具。

#### Catalog snapshot 的可信绑定

动态 enum 与实际工具调用必须绑定到同一份不可变快照，不能只靠模型回传 profile ID。

工具循环每次构建 LLM 请求时：

1. 从当前 registry 生成规范化 snapshot，包含 validator/policy 的 ID、version、语义摘要、适用范围、能力要求和完整 contract hash；
2. 生成随机不可猜测的 `snapshotId`，并计算 `snapshotHash`；
3. 将 snapshot 保存到进程内 `ToolContractBindingRegistry`；
4. 将 `snapshotId` 绑定到该次 API round 的可信 dispatch context；
5. 工具 schema 只暴露候选 enum，不暴露也不要求模型填写 snapshot ID。

当模型返回工具调用时，dispatcher 把该 round 的可信绑定加入 executor context：

```ts
interface PrepareMissionExecutionContext {
  requestId: string
  sessionId: string
  actorId: string
  surfaceId: string
  catalogSnapshotId: string
}

prepareMissionExecutor.execute(
  untrustedInput: PrepareMissionInput,
  trustedContext: PrepareMissionExecutionContext
)
```

`catalogSnapshotId` 不来自 tool input，模型无法替换。如果现有 dispatcher 暂时没有 round metadata，应直接扩展内部 executor context；不采用让模型回显普通 version 字符串的方案。

Prepare 时不能信任工具定义时的快照，必须重新读取 registry 并校验：

1. snapshot 存在、未过期，且 request/session/actor/surface 与 trusted context 完全一致；
2. intent 中选择的 profile/policy ID 存在于该 snapshot；
3. 当前 registry 中同 ID 候选仍存在且启用；
4. 当前 ID、version、contract hash、适用 deliverable/surface 和能力要求与 snapshot 完全一致；
5. 所需 capability 未超出用户将确认的授权；
6. 完全一致时才固化当前 validator/policy contract；
7. 选中候选的 snapshot identity、version、contract hash 和固化 contract 进入 confirmation binding 与 `draftHash`。

validator 目录在工具定义生成与 Prepare 之间发生变化时，返回：

```ts
{
  code: 'validator_catalog_stale',
  retryClass: 'refresh_tool_context',
  userClarificationRequired: false,
  staleProfileId: '...',
  availableProfiles: ['...']
}
```

confirmation policy 对应返回 `confirmation_policy_catalog_stale`。工具循环收到 catalog stale 后只允许刷新一次工具定义和候选目录，再让模型从新 enum 重新选择；不得把它转换为 `clarification_required`，不得要求用户提供内部 ID，也不得沿用旧 profile/policy 版本。

snapshot 生命周期采用请求级内存存储即可，不需要新增数据库表：

- 归属范围固定为 request + session + actor + surface；
- 默认有效期覆盖一次工具循环，最长不超过 10 分钟；
- 每个 request 最多保留当前和上一轮 2 份 snapshot；
- 工具循环结束、取消或超时后立即清理；
- 全局设置有界容量，超限时只淘汰已结束/过期请求；
- snapshot 缺失、过期或归属不匹配返回 `catalog_snapshot_invalid`，禁止回退为“读取当前 registry 并继续”。

恢复策略：

- 当前 request 的 snapshot 因过期/清理而缺失：`retryClass='refresh_tool_context'`，最多刷新一次；
- request/session/actor/surface 任一归属不匹配：按 `forbidden` 处理，不可重试；
- snapshot hash 校验失败：按内部完整性错误处理，不可重试；
- catalog stale：刷新工具定义一次；第二次仍变化则停止 Prepare，提示宿主配置持续变化。

### 6.2 P0：工具和 Skill 确定性绑定

在构建最终 system prompt 时增加不变量：

```ts
if (toolNames.includes('prepare_mission')) {
  requireSkill('background-mission-intake')
}
```

推荐实现：

1. `prepare_mission` 工具定义增加 `requiredSkillNames` 元数据；
2. 工具过滤完成后，统一解析 required skills；
3. required skill 绕过推荐路由，直接注入；
4. 如果 Skill 加载失败，则不要暴露工具，并记录结构化诊断；
5. 日志记录 `toolSkillBindings`，例如：

```json
{
  "tool": "prepare_mission",
  "skill": "background-mission-intake",
  "source": "required_binding",
  "injected": true
}
```

同时修复 `skills.route.start skillCount=0`：增加候选集构建日志，至少包含 scanned、eligible、filtered 计数及过滤原因。

### 6.3 P0：显式判断环境需求

删除以下推断：

```ts
exists(node_modules) && exists(package-lock.json) => software Mission
```

改为由规范化 Draft 计算：

```ts
needsSoftwareEnvironment =
  outputContract.validators.some(v => v.kind === 'command') ||
  requestedCapabilities.shell ||
  deliverables.some(d => d.kind === 'code_change_set')
```

更稳妥的是引入显式字段：

```ts
executionEnvironment: 'none' | 'repository_node'
```

并由 builder 根据交付物/validator 推导，必要时在确认页展示。对于本次文档任务：

- `kind=document`
- 无 command validator
- `shell=false`

因此 `executionEnvironment='none'`，Prepare 不探测 Node、不发布 dependency layer。

### 6.4 P0：修复 Node/npm 发现

运行时解析顺序应为：

1. 应用配置中的显式绝对路径；
2. 已验证并缓存的 runtime identity；
3. 应用随包提供的受支持 runtime（若产品决定打包）；
4. `process.execPath` 仅在其被明确验证为可执行目标时使用；
5. 平台候选路径（macOS 至少覆盖 Homebrew Intel/ARM 常见位置）；
6. login shell 探测只作为用户授权后的诊断，不作为默认可信来源；
7. PATH 搜索使用 Node API/明确目录遍历，不调用 `which`/`where`。

Node 与 npm 分开解析，并输出结构化失败：

```json
{
  "code": "runtime_node_not_found",
  "requiredBy": ["validator:test"],
  "checkedSources": ["configured_path", "cached_identity", "known_locations", "process_path"],
  "action": "configure_runtime"
}
```

如果 Mission 不需要软件环境，则完全跳过此流程。

### 6.5 P0：Prepare 原子性与补偿

Prepare 必须在用户确认前完成必要环境的不可变发布，并把最终 environment identity、descriptor、revision hashes、容量 reservation 和 binding 纳入 `draftHash`。确认后再首次发布环境不是等价方案；除非未来修改需求基线并增加环境生成后的第二次确认，否则禁止采用。

Prepare 使用明确的双分支：

```text
validated
  ├─ environment=none
  │    → prepared_pending_confirmation
  │    → confirmed
  └─ environment=repository_node
       → scanning → reserved → publishing → published
       → prepared_pending_confirmation
       → confirmed/transferred

软件分支任一中间状态
  → settling → failed/recovered
```

共享前置步骤：

1. 规范化 Intent、构建并校验 Draft；
2. 重新校验并固化 backend snapshot、validator contract 与 workDir fingerprint；
3. 根据 Draft 明确计算是否需要软件环境。

随后分为两个互斥分支。

#### 非软件环境分支

在单一数据库事务中：

1. 使用 `environmentBinding: null` 计算覆盖 Draft、backend snapshot、validator contract 和 workDir fingerprint 的完整 `draftHash`；
2. 创建 `prepared_pending_confirmation` 的 PreparedMission；
3. 保存 confirmation binding。

该分支不创建 `prepare_operation`、reservation 或 environment，不执行 runtime probe、稳定扫描或 publisher。

#### 软件环境分支

1. 完成 runtime probe、源目录 identity fence 和稳定扫描；
2. 在短数据库事务中创建持久化 `prepare_operation` 与容量 reservation，记录 source identity、预计字节数、owner 和过期时间；
3. 使用 operation ID 幂等发布不可变 dependency environment；发布过程只能更新 operation，不创建可确认的 PreparedMission；
4. environment finalized 后，在单一数据库事务中：
   - 校验 operation 仍为当前 owner；
   - 校验 environment 已 finalized；
   - 创建包含完整 environment binding 的 PreparedMission；
   - 计算并保存覆盖 Draft、backend snapshot、validator contract、workDir fingerprint 和 environment binding 的 `draftHash`；
   - 将 operation 标记为 `prepared`，把 reservation 关联到 PreparedMission。

两个分支收敛后：

1. UI 只展示 `prepared_pending_confirmation`；
2. 非软件 Mission 的 Confirm 事务校验 hash/过期时间并创建 Mission，不处理 environment/reservation；
3. 软件 Mission 的 Confirm 事务额外把同一个 environment binding/reservation 原子转移给 Mission，禁止重新扫描或替换环境；
4. 软件分支任意失败进入 `settling`，幂等结算未消费 reservation；启动恢复器扫描超时 operation，完成回收或判定已发布对象的归属；
5. PreparedMission 过期或取消时，仅软件分支通过持久化 settlement 释放环境引用与 reservation。

关键不变量：

- 未 finalized 的 environment 不能进入 PreparedMission；
- PreparedMission 的 environment binding 与 `draftHash` 一一对应；
- `environmentBinding: null` 的 PreparedMission 不得关联 operation/reservation；
- Confirm 不执行环境发现、扫描或首次发布；
- Executor、Reviewer、Validator 只消费确认时绑定的同一不可变 environment；
- runtime/publication 失败不会留下 `pending + empty draft_hash`；
- 已发布但 PreparedMission 创建失败的对象必须由 operation/recovery 证明其归属并安全结算，不能依赖进程内 `catch`。

### 6.6 P1：增加无副作用的本地规范化/预检

把“无副作用规范化/校验”和“有持久化副作用的 Prepare operation”分开：

```ts
buildMissionDraft(intent): BuildResult
validateMissionDraft(draft): ValidationResult
prepareMission(validDraft): Promise<PreparedMissionResult>
```

前两个方法必须是纯函数或只读 registry lookup；第三个方法按 §6.5 分支执行：非软件 Mission 直接创建 PreparedMission，软件 Mission 才进入 operation/reservation/publication。LLM 工具入口只需调用一次 `prepare_mission(intent)`；executor 先 build + validate，再进入对应 Prepare 分支。若仍需模型修复，返回结构化结果：

```ts
interface RepairableMissionError {
  code: 'intent_invalid' | 'clarification_required'
  retryable: boolean
  complete: boolean
  issues: Array<{
    path: string
    code: string
    expected?: string
    received?: string
    suggestedPatch?: unknown
  }>
}
```

用户文案与模型反馈分离：

- `userMessage`：简洁、可操作；
- `modelRepair`：完整、不截断、结构化；
- 日志：保留 schemaVersion 与 validationStage，不记录敏感内容。

### 6.7 P1：重试熔断

对 `prepare_mission` 增加专用策略：

- 同一 tool loop 首次 `intent_invalid` 后最多允许修复重试 1 次；
- 修复后仍是 `intent_invalid`，禁止继续调用并转为澄清；
- `runtime_unverified`、`backend_unverified`、`feature_disabled` 一律不可通过改 Draft 重试；
- 计算错误指纹：`toolName + errorCode + normalizedIssueCodes`；
- 若错误集合未减少，立即熔断；
- 若错误数量增加，回滚到上一份候选并停止盲试；
- 熔断事件记录 `mission_intake.retry_exhausted`。

提示词中明确：

```text
环境类错误不是草稿错误。收到 runtime_* / backend_* 后禁止改写 draft 重试。
```

### 6.8 P1：简化 schema 与兼容性测试

即使改为 `MissionIntent`，工具 schema 也应遵循跨模型的保守子集：

- 尽量避免深层 `anyOf`；
- 使用单层 enum + optional fields，再由宿主做条件校验；
- 避免在 description 中塞入超长 JSON；
- 最小示例直接放入 system Skill；
- 给每个工具 schema 增加 `schemaVersion`；
- 建立真实 provider 契约测试，而不只验证 Zod → JSON Schema 的结构。

测试矩阵至少覆盖当前支持的每个模型/网关：

1. 用户明确请求文档后台任务；
2. 只给自然语言，不提供内部 key；
3. 首次工具调用能通过结构校验；
4. 文档任务不触发 runtime probe；
5. 代码任务能正确请求 shell/validator/environment；
6. 环境失败后模型不会重复改 intent。

### 6.9 P0：增加执行模式保持与显式 fallback 决策

在工具循环中建立本轮请求级状态：

```ts
interface ExecutionModeContract {
  requestedMode: 'background_mission' | 'foreground_chat'
  source: 'explicit_user' | 'inferred'
  foregroundFallbackAuthorized: boolean
}
```

当用户明确使用“创建后台任务”“后台执行”等表达时：

```ts
{
  requestedMode: 'background_mission',
  source: 'explicit_user',
  foregroundFallbackAuthorized: false
}
```

`prepare_mission` 的所有失败应返回机器可判定的恢复策略：

```ts
interface PrepareMissionFailure {
  code: string
  retryClass:
    | 'repair_intent'
    | 'refresh_tool_context'
    | 'fix_environment'
    | 'clarify_user'
    | 'not_retryable'
  missionCreated: false
  foregroundFallbackAllowed: false
  userActions: Array<{
    id: string
    label: string
  }>
}
```

工具循环收到 `foregroundFallbackAllowed: false` 后必须：

1. 禁止继续调用与任务正文执行相关的写入、Shell、浏览器或长链路工具；
2. 允许只读诊断，但只能用于解释和修复 Mission 创建条件；
3. 向用户明确说明“后台任务尚未创建”；
4. 提供可操作的修复或重试入口；
5. 如确实可前台完成，只能询问用户是否愿意改为当前会话执行，不能先执行后告知。

建议增加通用 guard，而不只依赖提示词：

```ts
if (
  mode.requestedMode === 'background_mission' &&
  !mode.foregroundFallbackAuthorized &&
  prepareState === 'failed'
) {
  blockForegroundTaskExecutionTools()
}
```

“任务正文执行工具”不能简单等于全部 read/write 工具。可以结合 Intake 阶段和工具用途：

- 允许：运行时探测、配置读取、Mission 诊断、重新 Prepare；
- 禁止：为完成 Mission 交付物而进行的文件写入、代码修改、长篇生成链；
- 对用途无法确定的调用，要求模型先获得用户确认。

UI 建议展示明确的阻塞卡片：

```text
后台任务尚未创建
原因：Node.js 运行时未通过验证

[配置运行时] [重新检测] [取消]

可选：[改为在当前对话中执行…]
```

最后一个选项必须由用户点击或明确回复后才能设置 `foregroundFallbackAuthorized=true`。

### 6.10 P0：把确认做成可恢复的宿主门禁

确认正确性不能依赖模型是否记得询问，也不能只依赖一次 `mission:prepared` IPC 通知。

保留现有确认页和 `confirmPreparedMission()`，但收敛为以下规则：

1. Prepare 成功只创建 `prepared_pending_confirmation`，不得自动创建 Mission/Run；
2. 只有 `mission:confirm` 携带匹配的 prepared ID、expected hash 和 trusted surface 时，宿主才原子创建 Mission/Run；
3. Renderer 挂载、窗口恢复或收到 `mission:prepared` 后，都调用 `mission:list-pending-prepared` 读取当前 surface/session 的待确认对象；
4. `mission:prepared` 只作为刷新提示，不作为确认页唯一数据来源；
5. Prepare 工具成功结果明确返回 `missionCreated:false`、`confirmationRequired:true`，模型只能提示用户查看确认页，不得宣称任务已创建或已开始；
6. Prepare 失败则不存在可确认对象，必须返回失败/修复动作，不能伪造聊天确认来绕过；
7. PreparedMission 过期、丢弃或已消费后从 pending 查询中消失。

不需要增加新的确认状态机；复用现有 `prepared_missions.status`，只补一个按 trusted surface/session 查询 pending preview 的窄 IPC，并让 UI 以持久化事实恢复弹窗。

必须明确：模型在 Prepare 前的思考和只读探索不是 Mission 执行；Mission 的文件写入、Shell、后台进程和预算消耗只能发生在宿主确认事务成功之后。

## 7. 提示词改进

### 7.1 系统级短提示

工具可用时，在 system prompt 中加入短而强的规则：

```text
<background_mission_intake>
当用户明确要求创建后台任务时：
1. 必须使用 background-mission-intake Skill。
2. prepare_mission 只接收 { intent }；不要构造内部 MissionDraft、evidence key 或 validator binding。
3. 仅在存在会改变目标、授权、预算或交付物的重大歧义时提问。
4. 工具返回 runtime_* / backend_* / feature_disabled 时停止重试，并向用户解释环境阻断。
5. 同一请求最多修复并重试一次 intent_invalid。
6. 用户要求后台任务时，任何失败都不授权你改为当前会话直接执行；只能说明未创建、提供修复方式，或询问用户是否愿意改变执行模式。
</background_mission_intake>
```

### 7.2 重写 Intake Skill 的核心调用指令

当前 Skill 的内容总体正确，但应从“教模型拼完整 Draft”改成“教模型表达 Intent”：

```text
你负责提取 MissionIntent，不负责生成内部 ID、evidenceKey、validatorId 或跨字段引用。

文档任务默认：
- deliverable.kind = document
- capabilities.readFiles/writeFiles 按目标开启
- shell/network/browser/deleteFiles = false
- 不请求软件执行环境

评审语义：
- 用户要求后台自行评审：reviewer = independent_agent
- 用户明确要求亲自验收：reviewer = user
- 无法判断且会改变完成条件时，先澄清

失败处理：
- intent_invalid：只允许根据完整 issues 修复一次
- clarification_required：向用户提问
- runtime_* / backend_*：停止 Mission 内容执行，解释环境条件
- 未得到用户明确同意，禁止把后台任务改成当前会话直接完成
```

## 8. 实施拆分

### Phase 1：工具协议与 Intake 闭环

- 修复 tool → required Skill 确定性绑定；
- 修复路由候选集为 0 的原因与日志；
- 引入 `MissionIntentSchema` 和 `MissionDraftBuilder`；
- 引入版本化 `ValidatorProfileRegistry` 与 `ConfirmationPolicyRegistry`；
- 每轮动态生成可用 validator profile enum 与紧凑候选目录；
- 为每次 LLM API round 生成不可变 catalog snapshot，并通过可信 executor context 绑定到工具调用；
- 将 production `prepare_mission` 直接改为只接收 `{ intent }`；
- 移除 LLM 可见的完整 `{ draft }` 协议；
- 文档任务跳过 software environment；
- runtime/backend 错误禁止重试；
- runtime/backend 错误后禁止前台代执行；
- `intent_invalid` 最多修复重试 1 次；
- Prepare 成功结果明确标记 `missionCreated:false/confirmationRequired:true`；
- Renderer 通过 pending prepared 查询恢复确认页，IPC 事件只触发刷新；
- 错误结果增加 `complete` 标识，避免模型误以为只剩已展示问题。

验收标准：

- 重放本次用户输入，首次或最多第二次调用通过 Intent 与 Draft 校验；
- 不执行 Node/npm probe；
- 不出现连续 3 次 `prepare_mission`；
- 环境失败后只返回“Mission 未创建 + 修复动作”，不读取或写入交付物正文；
- Prepare 成功但用户未确认时不存在 Mission/Run，也不启动任何执行；
- 丢失 `mission:prepared` 事件或 Renderer 重载后，确认页仍能从 pending prepared 恢复；
- LLM 无需生成任何内部引用 key 或任意 executable/argv，但必须显式选择验证语义和注册表 profile/policy；
- builder 单测覆盖 artifact、registered validator、manual、review 四类无猜测映射；
- 用户未明确 verification 或 manual policy 时返回 `clarification_required`，不得自动降级；
- 未知、禁用或版本变化的 validator profile 返回 `validator_catalog_stale` 并自动刷新候选一次，不要求用户回答内部 ID；
- snapshot 与当前 registry 的 ID/version/contract hash/适用范围/能力要求完全一致时才允许固化；
- snapshot identity、固化后的 validator/profile 版本与 contract 进入 confirmation binding；
- supported model 契约测试首调成功率达到设定门槛，建议 ≥95%。

### Phase 2：Prepare 环境绑定与恢复

- 实现确认前环境稳定扫描、持久化 operation/reservation、幂等不可变发布和 settlement/recovery；
- PreparedMission 只在环境 finalized 后创建，完整 environment binding 必须进入 `draftHash`；
- Confirm 只原子转移已确认 binding，不重新扫描、发现或发布环境；
- runtime resolver 支持配置、缓存、已知路径和结构化诊断；
- Node/npm 按实际需要独立探测；
- 清理旧的半完成 prepared records。

验收标准：

- GUI PATH 不含 Homebrew 时，配置/已知路径仍可发现 runtime；
- 环境发布失败不遗留 `pending + empty draft_hash`；
- environment publication 成功但 PreparedMission 创建失败时，可由恢复器依据 operation/reservation 幂等结算；
- Confirm 后 Executor、Reviewer、Validator 使用的 environment identity 与确认哈希中的 binding 完全一致；
- 非软件 Mission 在未安装 Node/npm 时仍可 Prepare，且不创建 operation/reservation。

## 9. 测试方案

### 9.1 单元测试

- `MissionIntentSchema`：最小文档任务合法；
- `MissionDraftBuilder`：生成稳定 key、引用唯一、默认能力最小化；
- `MissionDraftBuilder`：四类 `verifyBy` 到 verification/evidence 的完整映射；
- 无效 deliverableRef 或用户未明确 manual policy 返回 `clarification_required`；
- 工具定义只向模型暴露当前 catalog 中的 validator profile、confirmation policy enum 和语义目录；
- 未知/禁用/版本变化的 profile/policy 分别归类为对应 catalog stale，不归类为用户澄清；
- snapshot ID 只通过可信 executor context 传递，tool input 中不存在可伪造字段；
- snapshot 过期、缺失、跨 request/session/actor/surface 复用均返回 `catalog_snapshot_invalid`；
- 同 ID 同 version 但 contract hash 改变时返回 catalog stale；
- builder 不从 description 关键词推断 verification，也不接受模型提供 executable/argv；
- validator profile 版本与固化 contract 进入 confirmation binding；
- review 语义映射：independent agent 与 user 分支；
- environment requirement：document/no-validator → none；
- environment requirement：code change/command validator → repository_node；
- runtime resolver：显式路径、缓存、Homebrew ARM/Intel、不可执行文件；
- error formatter：UI 截断与 model issues 完整分离；
- retry tracker：相同错误、错误增加、环境错误熔断。

### 9.2 集成测试

- Skill 扫描成功且 `prepare_mission` 暴露时，required Skill 必定进入最终 system prompt；
- Skill 注入失败时工具不暴露；
- Prepare 成功仅产生 pending PreparedMission，Confirm 前 Mission/Run 计数不变；
- `mission:prepared` IPC 丢失、监听器延迟挂载和 Renderer 重载三种情况下，pending 查询均能恢复同一确认页；
- 重复 Confirm 使用 idempotency key 返回同一结果，不重复创建 Mission/Run；
- Prepare 工具成功结果包含 `missionCreated:false` 与 `confirmationRequired:true`；
- 文档 Mission Prepare 不调用 `resolveRuntime`/`EnvironmentPublisher`；
- `document + no command validator + shell=false` 不创建 prepare operation/reservation，但能生成 `environmentBinding:null` 的完整 `draftHash` 和 confirmation preview；
- software Mission 才调用 runtime 和 dependency publication；
- runtime probe 失败不产生 pending prepared record；
- publication 失败会结算 reservation，启动恢复可回收超时 operation；
- confirmation hash 绑定规范化 Draft、backend snapshot、validator contract、workDir fingerprint 和完整 environment binding；
- Confirm 原子转移 Prepare 时的同一 environment binding，且不会重新扫描或发布；
- Executor、Reviewer、Validator 拒绝使用与确认 binding 不一致的环境；
- profile catalog 在工具定义后失效时，Prepare 返回结构化 stale 错误，工具上下文最多刷新一次并从新 enum 重新选择；
- 同 ID version 改变、同 ID 同 version 但 contract hash 改变、候选被禁用、适用能力改变时均返回 stale；
- 旧请求 snapshot 不能用于新会话、其他 actor/surface 或过期调用；
- snapshot 一致时，Prepare 固化 contract 与该 snapshot 中模型看到的候选完全一致；
- 工具循环结束/取消后 snapshot 被清理，容量上限不会淘汰活跃 request 的当前 snapshot；
- test/typecheck/build 场景均能从已展示目录选择有效 profile，无需猜测内部 ID；
- 明确后台模式下 Prepare 失败后，正文执行类工具被 guard 拒绝；
- 用户显式同意切换前台后，guard 才允许当前会话执行。

### 9.3 日志回放测试

将本次用户输入固化为回归夹具，断言：

- `prepare_mission` 调用次数 ≤ 2；
- 无 `draft_invalid` 链式分页；
- 无 `which node`；
- reviewer 与“后台评审直到无 blocker”语义一致；
- 最终返回 confirmation preview，而不是回退到前台直接执行。
- 注入 `runtime_unverified` 时，模型不得输出“我可以直接完成”并继续读取/写入交付物；
- 返回内容必须明确 `missionCreated=false`，且给出配置运行时、重试或取消选项。

### 9.4 真实模型契约测试

对每个正式支持的 provider/model 执行固定语料：

- 文档任务；
- 代码任务；
- 含重大歧义需澄清；
- 高风险能力需 justification；
- backend/runtime 故障。

指标：

- 首次结构成功率；
- 平均工具调用次数；
- 不可重试错误后的额外调用数；
- 意图保真率；
- capability 过度申请率。

## 10. 可观测性指标

新增事件与指标：

| 指标 | 目的 |
|---|---|
| `mission_intake.skill_binding` | 证明工具与 Skill 是否一致注入 |
| `mission_intake.prepare_attempt_count` | 统计单次会话 Prepare 次数 |
| `mission_intake.validation_stage` | 区分 intent/draft/semantic/backend/runtime/environment |
| `mission_intake.validation_issue_count` | 观察 schema 复杂度与模型适配 |
| `mission_intake.retry_exhausted` | 识别熔断 |
| `mission_intake.environment_required_reason` | 解释为何需要软件环境 |
| `mission_intake.runtime_resolution_source` | 判断 GUI PATH 类问题 |
| `mission_intake.prepare_orphan_recovered` | 监控半完成记录 |
| `mission_intake.mode_fallback_requested` | 记录模型/用户是否提出切换前台 |
| `mission_intake.mode_fallback_authorized` | 证明执行模式变更来自用户授权 |
| `mission_intake.foreground_execution_blocked` | 监控 guard 阻止的隐式前台代执行 |
| `mission_intake.confirmation_preview_recovered` | 监控通过 pending 查询恢复的确认页 |
| `mission_intake.prepared_without_visible_confirmation` | 发现 PreparedMission 长时间未被任何 Renderer 展示 |
| `mission_intake.catalog_snapshot_invalid` | 区分过期、缺失、归属不匹配和 hash 失败 |
| `mission_intake.catalog_stale_refresh` | 监控动态候选变化与单次刷新结果 |

建议设置告警/质量门槛：

- 单会话 `prepare_mission` > 2 次；
- `draft_invalid` 连续出现 2 次；
- 文档 deliverable 触发 software environment；
- Prepare 失败后存在 pending prepared record；
- required Skill 未注入但工具已暴露。
- 明确后台请求在未授权时进入前台执行。
- PreparedMission 已创建但确认页未展示或无法恢复。

## 11. 最终建议

本问题的正确修复方向不是继续扩充 Zod 错误文案，也不是要求模型“更认真阅读 JSON Schema”。两者只能降低部分失败率，无法消除结构性脆弱。

推荐最终决策：

1. **保留严格 `MissionDraft` 作为内部权威模型；**
2. **新增浅层且显式保留验证语义的 `MissionIntent` 作为唯一 LLM 工具协议；**
3. **由宿主 builder 生成所有机械字段与跨引用，并用请求级可信 catalog snapshot 绑定模型看到的候选合同；**
4. **工具与 Intake Skill 强绑定；**
5. **按 Mission 实际能力决定环境，而非按仓库文件猜测；**
6. **需要软件环境时，在确认前以持久化 operation/reservation 完成不可变发布并纳入确认哈希；**
7. **运行时发现脱离 GUI PATH/`which`；**
8. **用结构化错误和最多一次修复重试终止盲目试错；**
9. **把“后台执行模式”作为用户授权合同，失败后禁止隐式前台代执行；**
10. **把 PreparedMission 确认作为可恢复的宿主门禁，IPC 只通知刷新，持久化 pending 查询负责恢复确认页。**

完成这些改造后，本次 14 次调用应收敛为：

```text
读取需求（可选）
  → 一次 prepare_mission(intent)
  → 宿主生成并校验 Draft
  → 展示确认页
```

若存在真正的产品歧义，则应是“一次澄清 + 一次 Prepare”，而不是让校验器与模型共同猜测内部数据结构。

若存在环境阻断，则应收敛为：

```text
一次 Prepare
  → 结构化环境错误
  → 展示“Mission 未创建”与修复动作
  → 等待用户修复、取消或明确授权切换执行模式
```

系统不能把“尽量替用户完成内容”置于“遵守用户明确指定的后台执行方式”之上。

## 12. 评审阻断项闭环

| 评审阻断项 | 修订结论 | 对应章节 | 闭环证据 |
|---|---|---|---|
| `MissionIntent` 丢失四类 verification，builder 无法确定性映射 | 已修正 | §6.1、§8 Phase 1、§9.1 | acceptance 改为显式浅层 verification intent；validator/profile 和 manual policy 只引用宿主注册表；提供四类完整映射表、拒绝自然语言猜测及对应测试 |
| “确认后发布环境”破坏 environment binding 与 `draftHash` | 已修正 | §5、§6.5、§8 Phase 2、§9.2、§11 | 删除 A/B 可选路线；采用确认前稳定扫描、持久化 operation/reservation、不可变发布、PreparedMission 原子创建；Confirm 只转移已绑定环境 |
| 非软件 Mission 进入必需 operation/reservation 的事务 | 已修正 | §6.5、§8 Phase 2、§9.2 | 拆成两个互斥分支；非软件分支直接以 `environmentBinding:null` 创建 PreparedMission，明确禁止创建 operation/reservation 或调用 publisher |
| `validatorProfileId` 对模型不可发现，仍会猜内部 ID | 已修正 | §6.1、§8 Phase 1、§9.1～9.2 | 每轮动态生成受控 enum 和候选语义目录；Prepare 重新校验并固化 profile/version/contract；失效返回 `validator_catalog_stale` 并刷新一次，不要求用户澄清内部 ID |
| 动态 catalog 未可信绑定到工具调用，无法检测同 ID 换合同 | 已修正 | §6.1、§8 Phase 1、§9.1～9.2 | 每个 API round 生成不可变 snapshot；snapshot ID 通过可信 executor context 传递；Prepare 比较 ID/version/contract hash/适用范围/能力要求；定义请求归属、TTL、容量和清理规则 |

本次修订后不再保留以下冲突设计：

- 不再使用 `acceptance: string[]` 让宿主猜 verification；
- 不允许模型自由提供 validator executable/argv；
- 不再推荐或允许把环境首次发布推迟到确认后；
- 不允许 Confirm 阶段重新扫描、替换或首次生成用户已确认的环境；
- 非软件 Mission 不再创建虚假的 environment operation/reservation；
- 模型不再凭常识猜 validator profile ID；
- Prepare 不再把“当前 registry 中同名候选”冒充为模型选择时看到的候选。
