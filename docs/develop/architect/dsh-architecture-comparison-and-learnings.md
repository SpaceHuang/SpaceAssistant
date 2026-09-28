# DSH 架构对照与借鉴（对照我们的产品架构理想态）

> 定位：**外部实现的对照研究，不是基线**。本文只提供证据、对照与备选做法，不改变既有结论。
> 引用约定：本文内部小节写作「本文 §N.M」；其余不带前缀的引用（含「我们 §N」）一律指基线 `docs/develop/architect/product-architecture-design.md`；`roadmap §N.M` 指 `docs/develop/architect/agent-core-roadmap.md`。
> 对照对象：**DeepSeek Harness（`dsh`）**，DeepSeek 开源的 agent harness，TypeScript / pnpm 单仓，约 45 个包组 + 4 个应用（cli / desktop / desktop-host / web）。下文所有 `F:/Develop/deepseek-harness/...` 路径均为该仓库。
> 证据来源：该仓库的 `docs/`（`architecture.zh.md`、`subsystems/*.zh.md`、`event-producer-consumer.zh.md`、`tool-execution-pipeline.zh.md`、生成式目录）与 `packages/` 的目录结构和公开类型定义、注释的实际阅读。**未逐行审计实现，未运行该产品**，因此本文只做架构层面对照，不评价其实现质量与完成度。
> 姊妹篇：`docs/develop/architect/codex-architecture-comparison-and-learnings.md`（对照 Codex，Rust）、`docs/develop/architect/claude-code-architecture-comparison-and-learnings.md`（对照 Claude Code，TypeScript）。
> 状态：参考 ｜ 摸排日期：2026-09-12

**一句话**：Codex 与 DSH 是「可复用性」这道题的两个极端答案 —— Codex 用**分层 crate + 可枚举协议**，DSH 用**插件树 + 有序 patch 层 + 可替换 seam + 事件即扩展点**。两者的共同结论都支持我们的方向：Core 应当与驱动源、存储、界面解耦。DSH 额外给了我们三样当前缺的东西：**把「可收紧、不可放宽」变成类型事实的单调守卫**、**「确认权限由运行时所有权决定」这条可执行规则**、以及**用生成式目录加新鲜度校验对抗文档腐烂**。

**对我们的净影响**：方向不变，三处收紧（§7.1 的底线、§7.2 的确认权限、§6.2 的会话锚点表述），一条新机制建议（生成式扩展点目录），以及一条应当拍板的问题（安全审计落会话日志还是独立文件）。

---

## 1. DSH 架构全景

### 1.1 一切皆插件的组装形态

DSH 的底层是 Cordis 插件框架，五个概念（`docs/cordis-primer.zh.md`）：

- **插件**贡献服务；**上下文**（`ctx`）是服务容器，服务占一个稳定的 `ctx.<key>`（`ctx.tools`、`ctx.llm`、`ctx.sessions`、`ctx.approval`…）；其他插件按 key 查找，**不 import 具体实现**。
- **依赖用 `inject` 声明**：插件等待所需服务就绪才启动，加载顺序由依赖表达，不手工编排启动序列。
- **类型化事件**用于通信，且**分发模式是事件公开约定的一部分**（见本文 §2.9）。
- **注册是可逆的副作用**：提示词片段、工具 schema、适配器、提供方、监听器都通过 `ctx.effect()` / `ctx.on()` 安装，reload 与 teardown 时按预期撤销。

> 「不存在需要打补丁的特权内核：扩展 dsh 的方式是把插件挂载到其他插件旁边，而各项注册都是副作用，会在其插件卸载时撤销。」
> —— `docs/architecture.zh.md`

运行中的 `dsh` 是**一棵按序叠加出来的插件树**：profile 列出的组合包（bundle）→ profile 自己的 `cordis.patch.yml` → home 级 patch → 任意 `--patch` 覆盖层。一条 patch 按 id 定位条目并**替换其整个 config**，或插入新条目。随发行版交付的 profile：`web` / `headless` / `sdk` / `sdk-minimal` / `acp`；共享第一层是 `dsh-base`（模型适配器、工具、持久化、沙箱与审批策略、设置、凭据、遥测），之上按需叠加浏览器应用 / 一次性运行器 / SDK JSON-RPC 服务器 / 仅用于自动化的 ACP 服务器。

```text
启动层   profile（web / headless / sdk / sdk-minimal / acp）
           │  bundle 列表 → profile 的 cordis.patch.yml → home 级 patch → --patch 覆盖层
           ▼
条目列表 一条 patch 按 id 定位某个条目，替换其整个 config，或插入新条目
           │
插件树   dsh-base（模型适配器 · 工具 · 持久化 · 沙箱与审批策略 · 设置 · 凭据 · 遥测）
           ├─ dsh-web-app / dsh-headless / dsh-sdk-app / dsh-acp-app（按 profile 叠加）
           └─ 树外插件（与其它插件并列，而不是挂在某个内核之下）
           │
共享 ctx ctx.llm · ctx.tools · ctx.sessions · ctx.approval · ctx.sandbox · ctx.jobs · ctx.schedule · ctx.subagents …
```

`headless`、`sdk`、`sdk-minimal`、`acp` 只在启动时应用一次配置层，且文档明确解释了原因：「一次性应用或 stdio 应用拥有工作之后，替换其依赖会破坏该生命周期」。

这张图的关键读法：**组装是一等的，代码是二等的**。同一个 `dsh` 二进制，靠 profile 与 patch 就能变成 Web 应用、headless 一次性运行器或自动化服务器。

### 1.2 与我们六块的映射

| 我们的块 | DSH 的对应物 | 对应程度 |
| --- | --- | --- |
| Core | `packages/core/*`：`agent`、`agent-loop`、`agent-presets`；会话日志 `packages/session/session` | 高。同为「推理循环 + 工具回灌」，且同样坚持「日志是唯一真源、模型历史是派生物」 |
| Runtime | `ctx.tools` / `ctx.llm` / `ctx.skills` / `ctx.systemPrompt` + **agent preset**（按会话组装插件树） | 中。装配机制比我们重（挂载插件而非传数据），但解决的问题同一 |
| Safety | `packages/interaction/user-approval`（审批 seam）、`packages/sandbox/*`（进程沙箱）、`packages/interaction/permission-presets`、`packages/fs/fs-observation-policy` | 高，且拆得比我们细：**审批 / 沙箱 / 预设三件事三个 seam** |
| Driver | `apps/*`（cli / desktop / desktop-host / web）、`packages/acp`、`packages/webhook`、`packages/client/*` | 中。它的「驱动源」不是一层，而是若干「宿主 + 载体」组合 |
| Storage | `packages/session/session-persistence*`（会话日志）、`packages/session/session-projection`（派生投影）、`packages/storage/*`（通用域存储） | 高，且把三件事分开：**日志持久化 / 派生投影 / 通用键值** |
| Utils | `packages/util/*`（`brand` 等）、`packages/typert` | 我们所关注的点一致：util 刻意「不持有语义」 |
| 业务模块（应用域） | `packages/workspace`、`packages/fs`、`packages/skills`、`packages/settings`、`packages/lsp`、`packages/terminal`… | **DSH 没有「与 Agent 正交的业务模块」这一层概念**，能力包默认同时服务工具与界面 |
| 后台 / 定时 | `packages/jobs`、`packages/schedule`、`packages/webhook` | 有对应的管道，但**没有「管家 Agent」这个业务形态**（见本文 §2.7） |
| SubAgent | `packages/subagent/*`（一个 seam + 六个提供方）+ `packages/experimental/agent-team` | 比我们完整得多，是块 3 的最佳参照 |

---

## 2. 逐维度对比

### 2.1 可复用性的路线：我们的「数据定制」 vs DSH 的「插件树 + 可替换 seam」

我们 §5 的原则是：**能用数据定制的，不开放成 Hook**；扩展点分三类 —— 声明式数据（Profile / PolicyRule / Skill / 工具声明）、注入式端口（`events.*`、`factsProvider`、`answerer`、`ToolExecutor`、凭据解析、`persist`、`translate`、`limits/signal`）、明确不开放（§5.3）。

DSH 的路线相反：**一切皆插件，扩展就是挂载新插件**。但它的「开放」不是无约束的开放，有四种约束同时生效：

1. **seam 三件套**：一项可替换能力 = **Service Definition（声明接口）+ Service Provider（实现）+ Consumer（通常是面向模型的工具）**，文档明确要求「添加一项能力意味着把三者一并设计」。`capability-seams.zh.md` 给出的招牌例子是：文件系统与进程提供方共享同一个执行世界，因此把它们指向远程沙箱，就把 Bash、PTY 和 LSP 一并搬了过去，无需提供方专用 fork。
2. **分发模式分级**：观察用 `emit`、包装用 `waterfall`、按序决策用 `serial`、并行扇出用 `parallel`、首个命中即停用 `bail`，再加一个专门表达「不可放宽」的**单调 guard**。问题不是「开不开放」，而是「开放成哪种」。
3. **可逆性**：「每个注册都应有对应的 disposer」；卸载即撤销，「配套插件可以重载并再次注册同一名称，不留残余状态」。
4. **作用域**：注册项可以限定到单个 agent（用该 agent 的 `agent.ctx`），事件按 scope 过滤投递。

**各自的优劣**

- DSH 更强的地方：可替换性是**整个产品可换形态**级别的（同一二进制变 Web / headless / 自动化服务）；我们只能换实现，换不了形态。
- 我们更强的地方：**可推理性与可审计性**。「六块主干 + 三类扩展点」是可以背诵、可以一条条对照代码的；DSH 要回答「这次执行为什么会这样」得同时读代码、patch 层、profile、preset，它自己也要靠生成式目录（本文 §2.11）来缓解这个成本。
- **最关键的差异**：DSH 把「开放」做成了**若干种可枚举的开放方式**，而不是二元的开放 / 不开放。这正是我们 §5.3 缺的那一档 —— 我们也可以用「补事实 / 观察 / 追加上下文 / 不可放宽」这几种形状来描述「开放什么」，而不必只写「不开放」。

### 2.2 调用契约：我们的 Invocation vs DSH 的 Agent / Session / Turn

我们 §6.2 定义的 Invocation 有六项输入（session / messages / profile / events / limits / signal）与四项结果，并刻意让 `sender`、「必须先有一个活跃的用户回合」、「由谁回答确认」、`isWebContentsAlive` 都不出现。

**DSH 没有 Invocation 对象**。它把这件事拆成三个各自独立的生命周期：

- **Agent**（活对象 + 所有权）：`ctx.agents.create()` / `resume()` 返回 `AgentHandle { agent, dispose }`，**dispose 是一种能力** ——「among consumers, only the holder can tear this agent down」。`setup(agentCtx, agent)` 在两个 id 都未发布时运行；setup 拒绝、commit 抛出或所有者 dispose 都会**回滚事务，两个 id 都不发布**。
- **Session**（持久事实）：仅追加的类型化事件日志，**唯一真源**；LLM 消息历史由 `deriveMessages()` 从日志**派生**，不单独存储。**header 与日志分开存**：`version` / `id` / `createdAt` / `cwd` / `parentSession` / `isSeeded` / `origin` / `delegationDepth` / `agentPreset` —— 不可变，不进事件日志，也到不了 `deriveMessages()`。
- **Turn / Step**：一个**步骤** = 一次模型请求加它调用的工具；一个**轮次** = 零或多个步骤，「在领取首条输入之前打开，并在不再欠下任何工作时关闭」。终止原因是闭集：`completed` / `aborted` / `blocked` / `error` / `max-tokens` / `interrupted`（后者只在导入旧格式时出现）。

**异同与结论**

- **相同**：都拒绝「跑一次 Agent 等于跑一轮 UI 回合」，都把「谁发起、记在哪、给谁看」推到外面。
- **不同且值得修正我们**：**DSH 从不试图让会话可选**。`create` 必须给 `SessionId`，`resume` 必须给 `resumeSessionId`。它把「无窗口运行」解决在另外两个 seam 上：持久化（日志就是文件）与投递（宿主自己决定）。这提示我们：真正把回合绑死在窗口上的不是「有 session」，而是**session、窗口与回合的存活被绑在一起**。建议把 §6.2 的「不出现必填的 session / turn」改写为「**不要求窗口与 UI；可以携带一个可选的会话锚点（用于 resume / fork / 落盘）**」。（**这条最终被采纳并加强了**：落地为「会话必须有，但它不等于用户回合」—— 见 `product-architecture-design.md` §6.2 与 §1.2 不变量 1。）
- **DSH 多给两样我们没有的东西**：
  - **inbox 与 steering**：消息可以在 Agent 运行时投递（`agent/inbox/inserted` / `claimed` / `spliced` / `discarded`），running 的 Agent 在最近的步骤边界领取；`agent.inject()` 添加的模型可见上下文「会落到下一次获准的请求中」。这正是我们要的「确认回复到达 = 同会话新 Turn」，而且它还能做到更强的「轮次内插入」。
  - **冷恢复是一等公民**：`ctx.agents.resume()` 把持久会话恢复成活 Agent，且 header 里持久化 `agentPreset`，理由是「a resume that restored a different composition would replay history the model can no longer act on」。管家 Agent 的「被唤起 → 加载 Skill → 跑一个 Turn → Turn 结束」就是这个原语。

一句话：**我们的 Invocation 更轻、更适合「调用方就是自己产品」的场景；DSH 的三分更完整，尤其适合多宿主、可恢复、可嵌套。** 建议保留 Invocation 作为对外契约，但在内部承认 Agent 与 Session 是两个可分离的生命周期。

### 2.3 定制入口与模型选择：我们的 Profile vs DSH 的 agent preset

我们 §5.1 用四个**数据**扩展点表达「这次带什么」（Profile / PolicyRule / Skill / 工具声明），§5.4 进一步把模型与思维强度定成「档位是数据，服务与凭据是端口」，并规定 SubAgent 只能在 Profile 声明的档位集合内**降档不能提档**、审批 Agent 有模型能力**下限**。

DSH 的两件对应物：

- **agent preset**：按会话组装的一棵**插件子树**（standing mount），agent 的 scope key 挂到该 mount 之下；preset 里的服务行需要 `isolate` realm。因为 preset 决定该会话的**工具与提示词**，所以它**必须持久化进 header**（`agentPreset`）。
- **模型选择是三层**：`ctx.llm` 是可并存多个提供方的适配器注册表；`ctx.subagentModelSelection` 是「**在为一个会话组装委派工具时读取**的单例设置所有者」，返回 enabled 状态与**允许的路由集合**；`SubagentStartRequest` 还支持逐次 `model` / 推理强度 / token 覆盖，但必须匹配提供方的能力 flag，否则 `UNSUPPORTED_CAPABILITY` 明确拒绝。

**结论**

- 上一轮「subagent 能不能用便宜模型」这个问题，DSH 的答案是**三层**：部署级设置（哪些路由允许）→ 组装时读取（不实时）→ 逐次覆盖（父 Agent 可传，但受能力与白名单约束）。这**验证了我们「Profile 声明档位集合 + 父只能在集合内选」的方向**，并补上一条：**允许集合是「组装时读取」的部署侧设置，不是 Agent 自己的运行时判断**。这正是我们 §5.4 那句「谁付账、谁定档」的机制化表达。
- 分歧点在表达力：DSH 用「挂载插件」表达能力集，能换掉整套服务实现；我们用「传数据」，表达力覆盖当前需求（工具集 / 技能 / 模型档 / 规则），且**更好审计** —— 一份数据可以直接查、可以 diff、可以随 Invocation 存档。建议维持我们的路，但把「能力集」从「工具名列表」升级为**带声明的能力描述符**（本文 §4 第 6 条）。

### 2.4 安全：策略与沙箱

我们 §7.1 把「PolicyRule 该在里还是外」拆成四问（判定时机 / 判定引擎 / 规则内容 / 这次用哪套），并规定底线 `locked` 不能被下调、不能被覆盖。DSH 把同类问题拆成**三个独立的 seam**：

**(1) 工具流水线**（`docs/subsystems/tools.zh.md`、`docs/tool-execution-pipeline.zh.md`）

顺序是：`tools/pre-execute`（可重排的 **allow / deny / ask** waterfall）→ **已注册的单调 guard** → `tools/execute`（环绕包装，可替换 signal 但不可移除）→ `tools/post-execute`（accept / replace / block）→ `finalizeContent` → `tools/result`（冻结、只读）。

两个最值得抄的点：

- **单调 guard 的返回类型里根本没有 allow**：`ToolGuard = (execution) => string | undefined` —— 返回理由即拒绝，返回 `undefined` 即维持原判。文档写明：「Because guards have no allow result, listener ordering cannot turn a denial back into permission.」**顺序不再是安全属性**。
- **参数不可改写**，理由是「arguments are already logged and presented」，而「历史记录、审计、UI 和执行必须保持一致」。注意这条与我们 §5.3「不提供 `onToolCallStart → 改写参数` 这类回调」**结论一致**，且它给出的理由比我们写的更锋利（见本文 §4 第 4 条）。

**(2) 进程沙箱**（`docs/subsystems/sandbox.zh.md`）

- `SandboxMode = read-only | workspace-write | danger-full-access`，**只管文件系统效果**；文档明确「网络与进程可见性不在此处的定义范围内」。只有前两种会到达提供方，`danger-full-access` 的消费方**直接 spawn 原始 argv，不调用 `ctx.sandbox`**。
- **执行策略按每次调用解析并携带**（per-call，不固定在提供方上），所以「两个消费者可以在同一瞬间以不同策略约束」，也能让一次性提权重试走更宽的边界。策略对象里还带 `sessionId` 作为**调用身份**，供后端按会话维护私有状态（如 Windows ACL 后端给每个活跃会话 / 工作区对分配随机私有临时目录与 SID）。
- **强制执行完整性是后端报告的事实**：`SandboxEnforcement = full | partial`。`partial` 表示「活跃后端或较旧的内核 ABI 仅管控其中一个子集」，因此「**要求绝对保证的消费方必须拒绝或向上暴露这一区别**」。

**(3) 权限预设**（`docs/subsystems/permission-presets.zh.md`）

- 预设是**一组旋钮的具名组合**（审批策略 + 沙箱模式）。`permission/preset` 是**持久、仅记日志的用户意图**，不进模型 transcript；模型可见的后果由各旋钮自己的事件承担。它存在的意义很具体：两个预设共享同一组旋钮值时，「让 `current()` 仍能保住用户选择的究竟是哪一个预设」。
- 生效值是**会话日志里最后一条** `permission/preset` 事件，回退到服务配置；`set()` 是唯一写路径，所以「**回放能重建覆盖值**」。
- `custom` 只是**派生值**：「客户端可以把它显示为当前值，但它绝不是切换目标，也绝不出现在事件 payload 中」；旋钮值对不上任何预设时报 `custom`，**不报错**。

**结论**

- **单调守卫是 §7.1 最值得直接采用的机制**。我们写的是运行时检查（「若传入的规则集相对底线放宽了任何一条，Core 拒绝这次调用并落审计」）；DSH 把它变成类型事实。建议 §7.1 直接引用这个形状，并据此重写偏差 4 的目标形态。
- **`partial` 强制执行是一面镜子**。我们的 fail-closed 是「不确定就拒绝」；DSH 补了一句「后端必须如实上报它管不住的那部分」。我们应当把「平台能力不足」显式建模，而不是让「安全」这个布尔值假装成立。
- **三件事三个 seam 的分法值得抄**：审批（谁定夺）/ 沙箱（能碰什么）/ 预设（用户选了什么）。我们今天把策略规则、档位解析与审计放在同一个模块里，DSH 的分法让每一件的输入、输出与审计都能单独说清。
- **per-call 策略对象带调用身份**（`sessionId`）这一点，如果我们将来做进程沙箱，`SandboxExecutionPolicy` 是个好模板。

### 2.5 审批与自动决策：我们的审批 Agent vs DSH 的审批 seam

DSH 的 `ctx.approval`（`docs/subsystems/approval.zh.md`）回答一个问题：**这个具体操作是否可以继续**。

- **请求**：`ApprovalRequest` 带 agent、工具名、可选的 `callId`、`reason`（提问者写的人话解释）、`signal`（中止即撤回问题，迟到的回答被丢弃）。它**刻意省略工具参数** —— 应答者通过 `callId` 把提示挂到**已经流式输出的那个工具调用**上，「而非渲染另一份可能漂移的副本」。
- **结果闭集**：`allowed-once | rejected | cancelled | unavailable`。`allowed-once` 只授权被问的那一个操作；调用方对后三者**一律拒绝**。**缺少应答者、应答者不负责该请求、抛异常、不合规，统统产生 `unavailable` 而不是放行**。
- **按会话策略**：`ask` 委托给应答者链（链上没有应答者时落到 fail-closed 的 `unavailable`）；`never` 确定性拒绝、不分发任何应答者，且「**即使后来以 `prepend` 注册的应答者也无法绕过它**」。生效值 = 日志里最后一条 `approval/policy` 事件，唯一写路径是 `setApprovalPolicy`，「因此回放能重建覆盖值」。
- **审计**：每次请求获得**全新的** `ApprovalRequestId`，它把 `approval/asked` 与 `approval/decided` 配成一对，且因品牌化而**不与工具调用 id / agent / 会话 id 互换**。
- **分发**：应答者链是 waterfall（返回结果即认领，否则 `next()` 委托）；UI 通道的应答者「只为它拥有的 agent 回答问题」；**ACP 自动化桥接层为其拥有的 agent 提供一次性机器决策**。
- **前提**：`ctx.approval.request()` 要求发起请求的会话处于一个**尚未结束的轮次内**。

**结论**

- **我们的审批 Agent 在 DSH 里对应「一个应答者」**，而 DSH 已经证明：**提问方完全不需要知道应答者是人还是机器**。「管家 Agent 不感知审批 Agent 的存在」在 DSH 里是结构性成立的（调用方只调 `ctx.approval.request`），不需要额外约定 —— 这是对我们 §7.2 的强支持。
- **我们的「裁决永不写缓存、一事一议」与 DSH 的 `allowed-once` 完全同调**：DSH 在类型层面就拒绝了永久授权，结果里没有 `always`。
- **DSH 没有审批 Agent**。它的「自动审批」是靠**换一个应答者实现**达成的：一个拥有该 agent 的机器应答者，不做多轮推理、不读审计日志、没有成本与预算概念。**所以我们的审批 Agent 是增量而非重造，但可以白拿它三个词汇**：闭集结果、`unavailable` 即拒绝、审计成对且 id 品牌化。
- **一个应当吸收的细节**：`ApprovalRequest` 不带参数副本。如果我们的确认请求带上参数，就存在「Agent 看到的参数」与「用户 / 审批 Agent 看到的参数」漂移的可能。建议我们的确认请求**只带锚点与理由**，展示复用已经产出的事实。
- **一处需要我们自己回答**：DSH 的审批审计是**会话事件**（落在会话日志里），我们放在独立文件（`electron/confirmation/securityAuditLog.ts`）。取舍见本文 §2.8 与本文 §5 建议 5。

### 2.6 SubAgent：我们块 3 的最佳参照

DSH 的规模：一个 seam（`ctx.subagents`）+ **命名提供方注册表**（同一上下文可共存多个提供方，按名称注册 —— 它跟随 `ctx.llm` 的注册表模式，而不是单例的 `ctx.shell`）+ **六个提供方**（进程内 spawn、进程内 fork、ACP、Codex CLI、Claude Code、DSH SDK）+ 两个面向模型的消费方（按提供方委派的委派工具，以及可选的全局 `send_message` / `interrupt_agent` / `list_agents` 控制工具）。

关键机制：

1. **能力描述符 + 启动前校验**：`SubagentCapabilities { agentOptions, outputSchema, depthLimit, toolFilter, persona }` 是静态描述符，「服务会在单次 run 存在之前即行检查」；请求依赖提供方不具备的功能时，被 `SubagentError('UNSUPPORTED_CAPABILITY')` 明确拒绝，「**绝不会被接受后静默忽略**」（原文把这条叫 fail loud, no silent degradation）。
2. **单次 vs 可继续**：`start()` 是一次性委派；**可继续子 Agent** 由继续执行管理器自己组合，能力用「方法是否存在」表达（`prepareContinuable`），并用 TypeScript 类型收窄作为发现机制。
3. **委派深度是持久事实**：`SessionHeader.delegationDepth`（持久，所以「冷恢复无法降低深度」）+ 运行时可合并的 `AgentOptions.subagentDepth`。两者**都归该 seam 所有** —— 「循环既不设置也不读取它们」。
4. **fork 种子**：用父日志里**一段平衡的已完成轮次前缀**（父事件直到并包括其最后一个 `turn/end`）作为 `seed`，因此种子从 0 连续，「进行中的、未平衡的轮次被排除在外」。
5. **邻接规则**：`sendMessage` 只能发给直属父或直属可继续子；running 目标在最近的步骤边界领取，idle 目标起一个轮次，不在场的直属子从持久化**冷恢复**。
6. **发现是只读的**：`listChildren()` / `listDescendants()` 直接基于会话存储与可选的会话持久化，是**持久化枚举**，不是活跃注册表。
7. **subagent 是一种 job**：`JobKindMap.subagent`，取消、状态与输出统一由 `ctx.jobs` 管。

**对我们块 3 的意义**

- **「能力描述符 + 显式拒绝」应当直接进入我们的 Profile / 工具能力集**：我们需要一个「这个 Profile 支不支持模型覆盖 / 工具过滤 / 深度限制」的静态声明，而不是运行时 try 一下、失败就静默降级。
- **「深度归 seam 所有，循环既不设置也不读取」是「Core 不认识业务身份」最可操作的一种落法**：**持久字段的归属 = 该能力的 provider**，而不是「Core 里顺手加一个字段」。
- **「可继续子 Agent 的能力用方法存在表达」提醒我们分清两种东西**：一次性委派，与持续对话的子 Agent —— 后者才是 `list_agents` / `send_message` / `interrupt` 这类工具存在的理由。我们目前只有前者。
- **邻接规则值得抄**：允许模型给谁发消息是安全属性，不该是「任何 sessionId 都能发」。
- **只读发现可以直接用**：子 Agent 列表从会话存储枚举（配合 header 的 `origin: 'subagent'` 与 `delegationDepth`），不需要额外维护一份运行时注册表 —— 这一条同时服务于我们的 §4.4 与 §8。
- **一处我们不必学的**：把 Codex CLI / Claude Code 当 subagent 后端。DSH 证明它是一种合理选择，但代价是子进程、凭据和两套协议；这正是被否掉的 v3 后台任务方案的形态（见本文 §3）。

### 2.7 后台工作：jobs / schedule / webhook —— 有管道，没有我们要的形态

**(1) `ctx.jobs`（后台任务运行时，`docs/subsystems/jobs.zh.md`）**

- `JobId` 是品牌化 id，格式 `<kind>-N`；`JobKindMap` 可声明合并扩展，注册表把每个 kind 当不透明的 id 命名空间。`JobStatus = running | stopping | completed | killed | failed`。
- **职责切分很干净**：「生产方拥有执行资源；运行时拥有身份、访问权限和生命周期状态。」
- **预检先于注册**：`start(spec)` 先做访问、校验、owner 清理与实现自有准入，**再**调用 `run()`。「任何预检拒绝都不留下 job id 或执行资源；抛异常的 starter 什么都不注册；它返回之后注册不可能失败。」
- **访问按 owner 围栏**：`JobStart.owner` 是活跃 Agent，访问用它的 sessionId 围栏，**Agent 被 dispose 会取消并 await 该 job**；省略 owner 则创建「无主 job」，对任何调用方开放直到服务卸载。
- **接口形状**：`JobHooks { cancel(reason), done, readOutput? }`、`JobOutcome { status, detail?, output? }`、只读投影 `JobSnapshot`（每次调用新建，绝不暴露活的注册表状态）、effect-scoped 的 `onJobDone`、只通知「可见集合变了」的 `onJobsChanged`（「**所以观察者重新读取，而不是累积增量**」）、以及 `attachController(name)`。

**(2) `schedule`（定时，`docs/subsystems/schedule.zh.md`）**

- **仅限 Session 内**。持久记录是 `schedule/change` 会话事件：create 存完整记录，delete 是**终结性且仅含 id** 的转换，一次性提醒的 dispatch 同样是终结性且仅含 id 的转换。
- v1 只有三种规则：正的安全整数 `after_seconds` 延时、显式绝对 `at`、`every_seconds`（**下限 5 分钟**，以创建时间为锚点）。**没有 cron、没有日历规则、没有共享冷却、没有跨记录准入门禁**。时区解释被显式建模（字符串必须带偏移量，或本地形式必须给 `time_zone`），「Schedule 绝不会读取浏览器、Session、进程或模型上下文」，创建后只存规范化后的 UTC 时点，「因此回放绝不依赖环境时区状态」。
- **交付模式是一个硬编码常量**：`ScheduleDeliveryMode = 'session-local'` —— 「原 Session 必须处于 live 状态：**不存在外部通知渠道或 cold Session scheduler**」；「cold Session 不执行任何工作」，重新打开后重建 timer，已经过去的目标进入 overdue。
- **不插队**：到期工作「会先等待 Agent 完全 idle 并认领 maintenance phase，再重新折叠状态、采样本次判断、将一个 `followup()` 排入队列」，且「**绝不会调用 `steer()`，也绝不会中断当前轮次**」。
- **诚实的交付边界**：「队列准入后、持久 dispatch 前的狭窄崩溃窗口可能使提醒内容在恢复后重复，因此该边界提供的是**尽力而为的至少一次交付，而非恰好一次交付**」；只读的活动目录「绝不表示交付成功」。

**(3) `webhook`（外部触发，`docs/subsystems/webhook.zh.md`）**

- **fire-and-forget**：「runtime 没有队列、重试、去重、执行状态、崩溃重放、Agent 状态监听器或完成结果。重复交付可能创建重复 Session。」交付 id「仅用于来源信息：runtime 既不存储也不对它去重」。
- 唯一内置动作是**创建一个会话**：`WebhookSessionRequest` 必须给绝对 `workspacePath`、标题、文本提示词、agent preset 与 permission preset；follow-up 是普通持久 user-role 消息，`source.kind: 'webhook'`。
- 注册 disposer「先移除规则，再中止并排空活动调用，因此后续交付无法进入正在卸载的代码」。

**对我们的结论（块 4 关键）**

- **DSH 有后台工作的全部管道，但明确没有我们要的那种「无人值守的定时 / 事件 Agent」**：schedule 声明「不存在外部通知渠道或 cold Session scheduler」，webhook 声明「不保留交付或完成状态」。这两条恰恰是管家 Agent 必须跨越的边界。
- 这不是疏漏而是**刻意的取舍**：把「投递」与「状态」都排除在 runtime 之外，runtime 才能无状态、可随时重启。给我们的启发是：**我们要做的那部分，复杂度必须落在 Driver（投递、补投、可达性）与 Storage（持久任务与交付记录）里，而不是落回 Core**。这与我们 §4.2「投递是驱动源路由」、§1.2 不变量 6「先持久化，再投递」完全一致 —— 现在我们知道它是一处**主动选择的差异**，不是我们没想到。
- **可以直接借的形状**：`JobStart` / `JobHooks` / `JobOutcome` / `JobSnapshot` 的职责切分，以及 `onJobsChanged` 那条「只通知可见集合变化、观察者重新读取」的语义（与我们 §4.4 的失效通知是同一个设计）。
- **两条应当照抄的规则**：①**定时唤醒不插队**（先等 idle，绝不 steer、绝不打断当前轮次）；②**在派发前就承认交付语义**（至少一次 vs 恰好一次），不要事后补丁。

### 2.8 存储、可见性与投影：DSH 拆成三层

我们 §8 是「协议在内、实现在外」的一层。DSH 把它拆成**三件互不相干的事**：

**(1) 日志持久化（`SessionPersistence` seam，`docs/subsystems/persistence.zh.md`）**

- **基于句柄**：`create` / `open` 返回逐会话的 `SessionHandle`（`read` / `append` / `flush` / `close`），「每一次日志读写都经由句柄流动，绝不经由按 id 寻址的服务方法：句柄是跨进程写租约把守的唯一入口」。
- **单写者所有权**：已有活跃持有者时第二次 `open(id, 'write')` 以 `SessionAlreadyOwnedError` 拒绝；读句柄上写是运行时的 `SessionReadOnlyError`，不是类型分裂。`flush` 是检查点。
- **崩溃恢复保留被中断的轮次**：resume 会为「最后一条轮次从未结束」的存储日志追加一个 `interrupted` 收尾事件；且明确「崩溃修复只关闭轮次 / 步骤 / 工具边界，而从不处理 `compaction/*`」，因为括号的词汇表归其所属插件。

**(2) 格式 generation 与迁移链**

- JSONL v0 = `session.jsonl[.zstd]`，v1 及以后 = `session.vN.jsonl[.zstd]`；**「已提交 generation 路径绝不重命名、替换或删除」**。
- **每个相邻迁移包只负责一个 `vN → vN+1` 步骤**；读 open **不发布**后继，写 open 先编码、校验、再**排他发布**最终版本命名的后继。
- **拒绝未来版本**：「即使仍有较旧的可读 generation，最高的未来 generation 仍会导致拒绝」；`stat` / `list` 只重扫目录取最高规范 generation，在不读或改变正文的前提下转换受支持的历史 header。

**(3) 派生投影（`ctx.sessionProjections`，`docs/subsystems/session-projection.zh.md`）**

- 领域为每个状态 key 注册一个**纯同步折叠单元**：`init(header, inheritedEventCount)` + `apply(state, event)`；**框架只订阅一次 `session/event`，把每个已提交事件折进每个单元**。「领域不持有任何订阅，客户端也从不折叠领域事件 —— 它们收到的是成品值。」
- 效率纪律：`apply` 对不感兴趣的事件**必须返回同一个引用**（`Object.is` 相同即产生零下游工作）；`view` 也必须复用引用以抑制内部变化引发的发布；**所有函数必须同步**，「异步单元会撕裂载体的连续性切面」；state 必须是纯 JSON。
- 可选 `wire`（客户端视图）+ `viewSchema`（出厂前校验）+ `stateVersion`（缓存失效版本，使「旧版本的持久化行被丢弃，而不是被前向应用成垃圾」）。
- Host 用 `stateOf()` 读单个类型化状态，载体用 `snapshot()` 批量取裁剪后的客户端视图。

**(4) 全量值事件规则**

「携带状态的日志事件携带的是**变更后的完整状态，绝不是裸增量** —— 这让每次状态转移始终足够廉价，也让每个被供给的值自描述（对消费方即 last-wins）。」

**(5) 会话可见性 —— 我们的最小先行版本**

`SessionHeader.origin` **只有一个值** `'subagent'`，且被明确标注为「粗粒度产品分类…**展示用元数据**」，作用是「让产品导航能够隐藏重复的 child 行」。另有 `session-query` 的 `SessionRecord { header, live, persisted }`（live 是否存在于运行时 / persisted 后端是否列出），以及事件级的 `surface: current | shadowed | log-only` 分类。

**(6) 通用存储是另一件事**

`ctx.storage` 是通用枢纽（声明领域、打开领域、`domain/changed` 变更事件），与会话日志完全分开。

**对照结论**

- **`origin: 'subagent'` 是我们 §8「归属 × 可见性」的最小先行版本**：它证明了「隐藏内部会话行」是真实需求，也证明最省的落法是**在持久 header 上加一个粗粒度分类字段，然后在列表侧过滤**。我们的四维（用户 / 远端 / 自动化 / 内部）× 三档（primary / section / hidden）表达力更强，但要小心别把它做成「每个会话一行权限表」。**先有 header 字段，再有列表过滤，最后才是复杂策略。**
- **「投影」与「失效通知」是同一问题的两种解法，我们选了后者**：
  - DSH 投影：服务端增量折叠、客户端拿成品值。优点是客户端便宜、多客户端天然一致、跨视图聚合便宜；代价是每个域要有折叠单元，必须守住「全量值事件」与「引用不替换」两条纪律，缓存要版本化，且必须同步。
  - 我们失效通知：只广播 scope 加版本，消费方自己回 Storage 取。优点是真相只有一份、无服务端索引、无缓存失效问题；代价是每次变化后每个消费者都要重查，压力随消费者数量增长。
  - **结论**：当前规模下我们更省。但如果我们未来要做「会话列表 + 搜索 + 计划 + 用量 + 团队面板」这类**多视图聚合**，DSH 的投影 seam 是唯一能避免 N 个视图各查一遍库的形状。建议在 §8 记一条「投影是一种可选的出口形态」的伏笔，同时**无条件采纳它的一条子规则**：客户端从不自己折叠 —— 我们 §4.4 规则 1 已经这么写了，DSH 是独立佐证。
- **两条可以直接采纳的存储纪律**：①「已提交格式路径绝不重命名 / 替换 / 删除 + 相邻迁移一次一步 + 拒绝未来版本」（我们今天的 `migrateFromJson` 是一次性全量导入，没有版本世代概念）；②**恢复时「关闭未结束的边界」而不是猜测**（我们今天的遗留 turn 处理没有这条明确规则）。
- **一条需要我们自己回答的**：DSH 的审批审计是会话事件，和对话在同一个日志里 —— 好处是「回放能重建」、真相只有一份；代价是安全审计与对话共享保留期与访问路径。我们把它放在独立文件，好处是审计可独立保留与合规导出，代价是第二个真相，而且我们今天的日志还没有保留期（§10 偏差 14）。**建议把这条写进 `roadmap §8` 的待拍板问题。**

### 2.9 事件出口与扩展点分级

我们 §5.5 有四个出口（UI 事实 / 会话台账 / 安全审计 / 通知与进度），硬语义是「出口是接口，宿主给实现；**事件只观察，不改变判定**」。

DSH 的做法是**按事实的持久性与生命周期分三个事件域**（`docs/architecture.zh.md`）：

- **会话事件**：追加到日志并通过 `session/event` 广播的持久事实。「当某个事实必须在重新加载后仍然存在时，使用它。」
- **Agent 事件**（`agent/*`）：「携带活跃 Agent：inbox、步骤、状态、请求、验证、续跑。要观察或**拦截**进行中的工作时，使用它。」具体 13 个：`agent/created` / `agent/disposed` / `agent/error` / `agent/status` / `agent/assistant-stream` / `agent/session-start`、三个 inbox 事件（`inserted` / `claimed` / `discarded`、另加 `inbox/spliced` 派发点），以及四个 waterfall（`agent/pre-step`、`agent/request`、`agent/request-error`、`agent/turn-stopping`）。
- **能力事件**：`fs/*`、`tools/*`、`telemetry/*` 等，「无需 import 循环即可向某个 seam 附加策略和适配器」。

**分发模式是事件公开约定的一部分**（新事件用 `@mode` 标签记录，生成目录会把声明与派发调用点做交叉校验）：

| 模式 | 是否 await | 语义 |
| --- | --- | --- |
| `emit` | 否 | 监听器按注册顺序观察，无返回值 |
| `waterfall` | 否 | 环绕中间件，监听器必须 `next()` 才委托下去，可以短路 |
| `parallel` | 是 | 所有监听器并行观察 |
| `serial` | 是 | 按注册顺序执行，有返回值 |
| `bail` | 否 | 顺序观察，直到某个监听器返回 bail 值 |

**对照结论**

- 我们的四出口按**消费者**分（渲染端 / 回放 / 审计 / 通知），DSH 的三域按**事实的持久性与生命周期**分。两种切法不冲突，但 DSH 的切法回答了一个我们没明确回答的问题：**同一个事实如果需要「既落盘又能实时拦截」，它属于哪个出口？** 答案是：落盘的部分进会话事件，拦截的部分进 `agent/*` / `tools/*` 能力事件，**两者用同一个 id 关联**。
- **「事件是扩展点，选对事件域是大多数改动的第一个决定」** 这句值得抄进 §5.5 的开头。我们的四出口回答「信息往哪去」，DSH 的三域回答「这次改动该挂在哪」—— 后者对实现者更可操作。
- **`agent/turn-stopping` 是 serial（无 `next`）**：这是「轮次即将结束」的唯一终检点，语义是终止性的。我们在「回合结束」处目前没有等价的契约点。
- **我们没有 inbox 语义**。管家 Agent 要「确认回复到达 → 同会话新 Turn」，如果同时还有别的输入到达（比如用户在桌面又发了一句），**排队与认领的顺序就是安全相关的**。DSH 把 inbox 显式建模（inserted / claimed / discarded / spliced）。建议把认领语义写进我们 §6.2 的调用契约。

### 2.10 隔离与作用域

DSH 用**一个机制**同时解决三件事：**作用域（scope）**。`agent.ctx` 是该 agent 的子上下文；「将注册项限定到单个 agent → 使用该 agent 的 `agent.ctx`」；事件按 scope 过滤投递（「agent-scoped listeners receive only that agent」）；子 Agent「获得一个新的扁平作用域，而非继承父级注册」。

我们的对应物是 `lane` 加 Profile。差异：

- 我们用 `lane` 解决「策略与预算归属」，用 Profile 解决「这次带什么」。**DSH 只用一个 scope 同时解决「我看见哪些事件」「我拿到哪些服务」「我的注册对谁生效」**。我们 §7.1 已经写明「lane 是策略的输入维度，不是策略本身」，语义比 scope 窄。
- 值得学的是**一条规则**而不是机制：**「不得为缺失的托管值静默提供默认值」**（投影贡献方「可以保留 `ctx.inject([...])` 注册，但不能为缺失的 host 值静默提供默认值」），以及「host 读取方要么在激活时要求该服务，要么在注册表或必需 key 缺席时明确失败」。这比「fail-closed」更具体：**缺失就是失败，不是「用默认值继续」**。我们今天的 `args.appDb ? loadEffectivePolicyRules(args.appDb, lane) : DEFAULT_POLICY_RULES`（`electron/confirmation/toolCallGate.ts:185`）正是一个「缺失就静默用默认」的例子 —— 它在测试里很方便，在生产里意味着**配置缺失会静默降级成默认策略**。建议作为 §7.1 的一条硬规则。
- 不建议照搬 scope 机制本身：它依赖 Cordis 的上下文树，自建成本高，而收益（多租户、第三方插件）我们现在没有。

### 2.11 自证机制：不变量与生成式文档（我们差距最大、最容易补的一块）

**(1) 运行时不变式注册表**（`packages/runtime-diagnostics/invariants`，`docs/subsystems/invariants.zh.md`）

- 注册表是「面向**包自有**运行时不变式检查的可配置注册表服务」；每个工作区包以**自己确切的 npm 包名**注册检查。服务拥有选择逻辑（`enabled` + allowlist / blocklist 正则）、名称保留、子 fiber 生命周期，以及**归因到包的失败**（`InvariantError` 带稳定 code `INVARIANT` 与 `packageName`，消息前缀是 `invariant violated by "<package>": …`）。
- 检查时机在专属子 fiber 中；安装器失败会**原子地 dispose 子 fiber 并释放名称保留**，所以配套插件可以重载并再次注册同一名称，不留残余状态。
- **最值得抄的一条约定**：检查「可以断言什么」是明确的 —— **权威事件流或可变数据，「绝不是服务或方法是否存在」**。

**(2) 穷尽式配套**

- 每个包都有一个 `./invariant` 配套插件；**没有可检查项时也必须导出一个空安装器，并在起始注释以 `No runtime invariant:` 开头、针对该包具体解释为什么没有**。
- `pnpm run verify-package-invariants` **机械地拒绝**：生成文件标记、无解释的空安装器、遗漏或忽略报告器的非空安装器、错误的注册名称，以及不完整的导出 / 发布 / 依赖 / 打包接线。

**(3) 生成式文档 + 新鲜度校验**

- `config-catalog`、`tool-catalog`、`module-graph`、`persistence-catalog`、`event-producer-consumer`、各子系统页的 `Cordis API` 区块都是**从源码生成**的，并在 doc-sync 里校验新鲜（「verified fresh by `pnpm run verify-cordis-catalog`」）；文档里的类型片段用 `ts type-equiv` / `ts cordis-catalog` 围栏，**与源码保持等价**，而不是人手抄一遍。
- **事件生产方 / 消费方矩阵**每个事件一行：模式、声明位置（文件加行号）、派发方、监听方，并覆盖「有意绕过 `ctx.emit` 的内含派发位置」。

**对我们的意义（可直接落地，杠杆最高）**

- 我们 §10 的偏差清单用**行号**作证据（`electron/toolChatLoop.ts:389` 等 20 余处）。行号会腐烂：任何一次重构都会让这份清单从「证据」变成「传说」。DSH 的答案是**让证据可复现**：把可枚举的事实（工具清单、事件清单、IPC 通道、扩展点、会话事件类型）做成生成物，并在 CI 校验新鲜度。
- **「不变量只能断言事实，不能断言形状」** 是一条可以直接采用的判据，用来审查我们六条不变量的可执行化：例如「先持久化，再投递」（限于终态与结果，不含过程性事实流）应当断言**日志里该结果落盘的 seq 早于投递动作**（事实），而不是断言「存在一个 `DeliveryService`」（形状）。
- **「没有可检查项也必须解释」** 正好可以约束我们的「六块主干」：每一块都应该能回答「这块有没有可被运行时断言的事实；没有，为什么」。
- **代价要说清**：生成式目录 + 双语配对 + i18n yaml 的成本极高（DSH 的 `docs/` 体积比我们大一个量级，仅 `config-catalog.zh.md` 就 156KB，还有 `module-graph` 102KB、`tool-catalog` 91KB）。**我们只取「生成 + 校验新鲜」这一点，不取双语配对与全量目录。**
---

## 3. 我们不必照搬的

1. **Cordis 与「一切皆插件」**。我们没有插件市场、没有第三方扩展诉求。动态加载、可逆副作用、HMR、realm 隔离的复杂度换不来收益。学它的**机制**（seam、事件域、单调守卫、作用域规则），不搬它的**框架**。
2. **patch 层能替换任何条目（包括核心）**。「不存在需要打补丁的特权内核」这件事很漂亮，但它与我们 §7.1「底线不可放宽」直接冲突：DSH 的安全底线靠代码 seam 表达，而沙箱模式理论上可以被一条 patch 换成 `danger-full-access`。我们「规则内容可配、判定引擎与底线不可配」是更好的取舍。
3. **把外部 CLI 当 subagent 后端**（Codex / Claude Code 提供方）。这正是被否掉的 v3 后台任务方案的形态。DSH 说明它是一种合理选择，但代价是子进程、凭据、两套协议、两套审计 —— 我们的产品不需要。
4. **webhook 的 fire-and-forget**。与「先持久化，再投递」冲突，不采纳；但记住它的理由（runtime 保持无状态、可随时重启），这解释了为什么我们的复杂度必须落在 Driver 与 Storage。
5. **`session-local` 的定时**。正是我们要避免的形态：DSH 明确声明「不存在外部通知渠道或 cold Session scheduler」，而我们的管家 Agent 必须能在用户不在、窗口关闭、会话非活跃时工作。
6. **极致的包切分与文档工程**（45 个包组、生成目录、双语配对、i18n yaml）。以我们的团队规模与迭代速度承担不起；我们取「六块主干 + 三类扩展点」的可背诵性。
7. **底层 waterfall 的全开放**（如 `llm/stream`）。我们的替换需求是「换提供方」，不是「重写流式协议解析」。开放这一层带来的推理成本远大于收益。

---

## 4. 值得学习的地方（按对我们的紧迫度排序）

### 第一优先：直接影响正在写的方案

1. **单调守卫：把「可收紧、不可放宽」变成类型事实。** `ToolGuard` 的返回类型里没有 allow，所以「监听器顺序」不再是安全属性。用于重写 §7.1 与偏差 4（当前 `AutoEvaluator` 是「外部直接给结论」的形状）。
2. **审批词汇的闭集化。** `allowed-once | rejected | cancelled | unavailable`，调用方对后三者一律拒绝；缺应答者、不负责、抛异常、不合规 → `unavailable`，而不是放行。我们 `confirmation-answerer-and-auto-approval-design.md` 里的 answerer 结论应当直接对齐这套词汇。
3. **确认请求只带锚点与理由，不带参数副本。** 复用已经产出的事实（`callId` 指向已经流式输出的工具调用），避免「Agent 看到的」与「审批方看到的」参数漂移。
4. **确认权限由运行时所有权决定，而不是会话谱系。** DSH 的规则原话是：「人类交互只对**精确的 live runtime root** 有效……被拥有的 child 没有人类应答者，否则会永远阻塞」。这条直接决定 SubAgent 与管家 Agent 的确认行为，比我们的「谁回答确认可插拔」更具操作性，也给出了 fail-closed 的具体触发条件。
5. **「不开放可改写 Hook」的理由要换掉。** 我们现在写的是「行为定制必须落在可枚举、可审计的地方」；DSH 的理由是「arguments are already logged and presented … 历史记录、审计、UI 和执行必须保持一致」。建议采纳后者，并把结论精确化为：**不是「不开放 Hook」，而是「不开放能放宽判定、或改写已记录事实的 Hook」**。这一条同时化解了与 Codex 对照文档里那处「PreToolUse 可改写参数」的分歧 —— 我们保持不改写，但补上 DSH 给的理由。

### 第二优先：影响块 3 / 块 4 的方案

6. **能力描述符 + 启动前校验 + 显式拒绝。** provider 声明能力 flag，服务在 run 存在之前校验，不支持就 `UNSUPPORTED_CAPABILITY`；「绝不接受后静默忽略」。用于 SubAgent 的模型档 / 工具过滤 / 深度限制，以及我们的工具能力集。
7. **seam 三件套（Definition / Provider / Consumer）。**「添加一项能力意味着把三者一并设计」—— 这是审查我们 §5.2 那八个注入端口的现成尺子：每个端口是否都有明确的接口、实现者与消费者？
8. **持久字段归所属能力所有。** `delegationDepth` 与 `subagentDepth` 归 subagent seam，「循环既不设置也不读取它们」。这是「Core 不认识业务身份」最可操作的落法。
9. **`resume` 是一等公民，且组合必须持久化。** `agentPreset` 写进 header，理由是「恢复了不同组合就会重放模型无法作用的历史」。管家 Agent「被唤起 → 跑一个 Turn → 结束」就是这个原语；我们目前只有「活跃会话」这一种形态。
10. **inbox 认领语义 + 定时不插队。** 前者决定「多个输入同时到达时的排队与认领顺序」（安全相关）；后者是一条现成规则：先等 Agent 完全 idle 再排 followup，绝不 steer、绝不打断当前轮次。
11. **Job 的接口形状与预检纪律。**「生产方拥有执行资源，运行时拥有身份与生命周期」；「预检在注册之前，注册之后不可能失败」；`onJobsChanged` 只通知可见集合变化、观察者重新读取。

### 第三优先：架构卫生

12. **生成式扩展点目录 + 新鲜度校验。** 把 §10 偏差清单里的「行号证据」换成「可复现命令产出的清单」，并在构建里校验新鲜。这是唯一能阻止我们文档腐烂的机制。
13. **不变量只断言事实，不断言形状；没有可检查项也必须解释。** 用这条重审我们六条不变量的可执行化方式，并约束六块主干各自回答「有没有可断言的事实」。
14. **全量值事件规则。** 携带状态的事件带「变更后的完整状态」，而不是裸增量 —— 让每个被供给的值自描述（last-wins），也让折叠始终廉价。
15. **品牌化 ID。** 跨包 / 跨进程传递的 id 结构是字符串但类型不可互换（不能把 `SessionId` 传到需要 `ToolCallId` 的位置）。低成本高收益；我们主进程里的 `sessionId` / `turnId` / `confirmId` 今天全是裸 string。
16. **会话格式的 generation 纪律。** 已提交 generation 路径绝不重命名 / 替换 / 删除；相邻迁移包一次只走一步；读 open 不发布、写 open 排他发布；拒绝未来版本。

---

## 5. 对现有文档的修订建议

1. **§5.3「明确不开放」→「分层开放」。** 保留「判定顺序 / 底线 / fail-closed 不可替换」与「参数不可改写」，但把「不开放 Hook」的上位表述换掉：DSH 给出了第三条路 —— 开放，但**可逆**（卸载即撤销）、**可枚举**（事件域 + 声明式模式标签）、**可替换**（seam 三件套）、**不可放宽**（单调守卫）。与 Codex 对照文档的建议一致，DSH 提供了机制化的落法。
2. **§6.2 Invocation 的会话表述。** 把「不出现必填的 session / turn」改写为「**不要求窗口与 UI；可以携带一个可选的会话锚点**（用于 resume / fork / 落盘）」，并在契约里补 **inbox 认领语义**。理由：管家 Agent 要 resume、SubAgent 要 fork，都需要「会话是可寻址的持久标识」；真正的病根是 session 与窗口 / 回合的存活被绑死，而不是 session 本身存在。**落地结果**：§6.2 的会话表述已按此改写，并把「可选锚点」进一步加强为「会话必须有、但不等于用户回合」（同时改了 §1.2 不变量 1 与 `roadmap §4.1` 的问题框定）；inbox 认领语义也已补入。
3. **§7.1**：把「可收紧、不可放宽」落到**接口形状**（单调守卫）；把底线的三条（fail-closed 兜底、`locked` 不可下调、审计成对）与 DSH 的词汇对齐；新增硬规则「**不得为缺失的托管值静默提供默认值**」，并据此标记 `toolCallGate.ts:185` 那处静默回退。
4. **§7.2**：补一条「**确认权限来自运行时所有权**」，并明确 SubAgent 与其它内部调用**没有人类应答者**，必须走自动决策或 fail-closed；确认请求只带锚点与理由。
5. **§8**：补四件事 —— ①header 与日志的分离（不可变元数据 vs 事件日志）；②格式 generation 与相邻迁移链；③「归属 × 可见性」的最小可落形态（先 header 字段，再列表过滤）；④**「安全审计落会话日志还是独立文件」的取舍小节**，并作为待拍板问题。
6. **§4.4**：与 DSH 投影 seam 做一次明确对比，写下我们选「失效通知 + 重取」的理由（消费方少、真相在 Storage），同时保留 DSH 同样坚持的那条：**客户端从不自己折叠**。并在 §8 预留「投影是一种可选出口形态」的伏笔。
7. **§10**：证据从「行号」升级为「可复现命令」（生成式清单），行号只作为当次摸排的快照。
8. **`roadmap §8` 新增一条待拍板**：安全审计与审批记录**落会话日志还是独立文件**（涉及真相唯一性、保留期、合规导出的取舍）。

---

## 6. 一句话总结

**DSH 证明了我们方向正确，但把「开放什么」这件事做得比我们精细三级：不是开放 / 不开放的二元选择，而是「可逆的开放、可枚举的开放、可替换的开放、以及类型上不可放宽的开放」。** 我们不需要它的插件框架、patch 层与外部 CLI 后端；我们需要的是它的四样**机制**（单调守卫、能力描述符、seam 三件套、生成式目录与不变量），两条**规则**（确认权限由运行时所有权决定；缺失即失败而非默认），以及一处**刻意的分歧**（它的后台工作是会话内、无投递保证的，我们的管家 Agent 必须反过来做，且复杂度应落在 Driver 与 Storage）。
