# Claude Code 架构对照与借鉴（对照我们的产品架构理想态）

> 定位：本文是**参考研究**，不是方案，也不是我们的架构基线。它做三件事：把 Claude Code 的架构讲清楚、与我们 `docs/develop/architect/product-architecture-design.md` 的理想态逐维度对比、列出值得借鉴与不该照搬的部分。
> 对照对象：`E:/Develop/claude-code-main`（2026-03-31 泄漏的 Claude Code 源码归档，仅含 `src/`，无 `package.json` 与构建配置，**无法运行**）。约 1,900 个文件、51 万行。证据用 `src 内路径` 标注，均来自结构与关键注释的实际阅读，**未逐行审计实现**。
> 一个必须说明的取样偏差：`src/` 下约 20% 的 `.tsx`（395 个）是 React Compiler 的编译产物（含 `react/compiler-runtime` 与 `_c(n)` 记忆槽，例如 `state/AppState.tsx`）。**核心逻辑文件（`query.ts` / `Tool.ts` / `permissions/` / `AgentTool` 的非 UI 部分）是干净的原始 TypeScript**，本文的结论取自这部分；界面层结论只取类型与结构，不读编译正文。
> 上游：`docs/develop/architect/product-architecture-design.md`（我们的理想态）、`docs/develop/architect/agent-core-roadmap.md`（工作块）。
> 姊妹篇：`docs/develop/architect/codex-architecture-comparison-and-learnings.md`、`docs/develop/architect/dsh-architecture-comparison-and-learnings.md`。
> 状态：参考稿 ｜ 摸排日期：2026-09-12 ｜ 结论已按「是否影响我们正在写的方案」排序

**一句话**：Claude Code 是本文三篇对照里**离我们最近、也最痛的一篇** —— 它和我们一样是「一个进程里的 Agent 循环 + 一堆工具 + 一个界面」的形态，同样要处理确认、后台、子 Agent、会话归属。它的两个结论直接印证了我们已拍板的方向：**审批裁决不缓存（它每次动作都真的调一次分类器）、子 Agent 的会话归属物理分层（子 Agent 转录落在 `<sessionId>/subagents/` 子目录，列表天然看不见）**。它的三处代价则正好是我们正在拆掉的东西：**工具契约把「呈现」写进类型（`renderToolUseMessage` 是必填成员）、确认通道最终仍 import 界面类型、无界面时确认一律自动拒绝**。所以它对我们的价值不是「抄什么」，而是给了我们两样东西：一条被验证过的**审批器工程化清单**（成本遥测、失败语义、快慢两阶段、工具自述审批输入、拒绝计数回退），和一份**「共享一个执行器会给调用方带来什么」的反面教材**（`ToolUseContext` 约 50 个字段、逐字段手工隔离）。

---

## 1. Claude Code 架构全景

### 1.1 一个进程、一套循环、一群客户端

Claude Code 是 Bun 运行时上的单进程 TypeScript CLI，终端界面用 React + Ink。形态上有三层：

```text
客户端/驱动   终端 REPL（Ink）   ｜  print / SDK（headless）  ｜  Bridge（IDE、Web） ｜  Remote（CCR 容器） ｜  daemon
                                  └─ 全部最终都跑同一套循环
agent 循环     query()（async generator，query.ts）
                 └─ QueryEngine（一个会话一个实例、每回合一次 submitMessage）
工具层         tools/*（40 余个，每个自带 schema / prompt / 权限 / 执行 / 渲染）
安全层         useCanUseTool → permissions.ts → 三个回答者 handler（interactive / coordinator / swarmWorker）
                 └─ auto mode 分类器（yoloClassifier.ts，独立模型调用）
扩展层         27 个 Hook 事件 · 插件市场 · Skill · MCP · SDK
存储           <projectDir>/<sessionId>.jsonl（只追加）· <sessionId>/subagents/agent-<id>.jsonl · .meta.json
```

几个定义性的结构：

- **循环是 `query.ts` 的异步生成器 `query()`**，参数是 `QueryParams`（`query.ts:181`）；跨迭代可变状态收在一个 `State` 结构里，不可变快照收在 `QueryConfig`（`query/config.ts`，注释说明把它与逐迭代 State、可变 `ToolUseContext` 分开是「为了 future step() extraction 可行」）。I/O 依赖抽成 `QueryDeps`（`query/deps.ts`，只有 4 个），注释写明「scope is intentionally narrow (4 deps) to prove the pattern」。
- **`QueryEngine` 是循环的会话化外壳**：一个会话一个实例，`submitMessage()` 一次 = 一个回合，状态跨回合保留（`QueryEngine.ts:175-184`）。headless / SDK 走它，REPL 目前走自己的 `main.tsx` 路径。
- **工具是自包含模块**，用 `buildTool(def)` 构造（`Tool.ts:783`）。默认值刻意 fail-closed：`isConcurrencySafe → false`、`isReadOnly → false`、`toAutoClassifierInput → ''`（并要求安全相关工具必须覆盖）、`checkPermissions → allow`（交给通用权限系统）。
- **权限有模式栈与规则来源两个维度**：模式 `default / acceptEdits / bypassPermissions / dontAsk / plan`（外加内部 `auto`、`bubble`，`types/permissions.ts:16`）；规则来源 8 种（`userSettings / projectSettings / localSettings / flagSettings / policySettings / cliArg / command / session`）；规则值 `{ toolName, ruleContent }` 加行为 `allow / deny / ask`。
- **构建期有特性开关**（Bun 的 `feature('X')` 做死代码消除），运行期有远程开关（GrowthBook）。二者分工明确：前者决定「代码在不在产物里」，后者决定「行为开不开」。
- **27 个 Hook 事件**（`entrypoints/sdk/coreTypes.ts:23`）+ 插件市场（一个 manifest 可打包 commands / agents / skills / hooks / output-styles / MCP / LSP / settings）。

### 1.2 与我们六块的映射

| 我们的块 | Claude Code 的对应物 | 对应程度与差异 |
| --- | --- | --- |
| **Core** | `query.ts` 的 `query()`、`QueryEngine.ts`、`Tool.ts` | 高。同为「模型 → 工具 → 回灌直到收敛」的循环。差异：它把「会话」做进了壳（QueryEngine），且循环参数里已经有模型、工具集、`canUseTool` 等装配结果，装配与内核界线模糊 |
| **Safety** | `utils/permissions/*`（含 `permissions.ts` 52KB、`permissionSetup.ts` 53KB）、`hooks/toolPermission/*` 三个 handler、`yoloClassifier.ts`、BashTool 的沙箱判定 | 高，且拆得比我们细：**规则 / 模式 / 回答者 / 分类器 / 沙箱**各自成模块。但底线可被配置放宽（`bypassPermissions`），靠企业策略与 killswitch 兜 |
| **Runtime** | 没有独立一层。装配数据散在 `utils/settings/*`、`tools/AgentTool/loadAgentsDir.ts`、`skills/loadSkillsDir.ts`、`utils/plugins/*` 四处，在调用点被拼起来 | 低。这印证我们把 Runtime 显式列为一层的价值：它的「装配」是隐式的、按入口分支的 |
| **Driver** | `main.tsx` + REPL、`cli/print.ts`、`entrypoints/sdk/*`、`bridge/*`（`replBridge.ts` 100KB、`bridgeMain.ts` 115KB）、`remote/*`、`server/*`、`--daemon-worker` | 中。**终端是唯一原生宿主，其余都是事后接上去的** —— 两个文件 215KB 就是这份代价的账单 |
| **Storage** | `utils/sessionStorage.ts`（180KB）、`types/logs.ts`、`utils/conversationRecovery.ts`、`history.ts` | 高。它是**只追加的事件日志**，条目是 20 种变体的联合类型；比我们的关系型三行更能容纳新事实 |
| **Utils** | `utils/`（564 个文件）、`services/`、`constants/`、`types/` | 一致（体积远比我们大）。注意它没有「业务模块」概念：文件、搜索、配置、MCP 都是工具或客户端功能 |
| **业务模块（应用域）** | 无对应层；文件系统、搜索、LSP、终端能力都作为工具存在 | 我们的「业务模块与 Agent 正交」在它这里得不到印证，但在 Codex 里得到了印证（见姊妹篇） |
| **后台 / 定时** | `tasks/*`（6 类任务状态联合）、`ScheduleCronTool`（durable cron）、`SleepTool`、`tools/MonitorMcpTask`、`--daemon-worker` | 有管道，**但没有「管家 Agent」这一业务形态**；无界面时它的答案是让确认自动失败（见 §2.6） |

---

## 2. 逐维度对比

### 2.1 调用契约：我们的 Invocation vs `QueryEngineConfig`

我们的 `Invocation`（§6.2）刻意只有六项：session / messages / profile / events / limits / signal，并明确四个「不出现」。

Claude Code 的对应物是 `QueryEngineConfig`（`QueryEngine.ts:130`）加 `ToolUseContext`（`Tool.ts:158`）：

| 维度 | 我们 | Claude Code |
| --- | --- | --- |
| 装配输入 | 一份声明式 Profile，随调用携带 | 约 20 个字段逐个传入（tools / commands / mcpClients / agents / canUseTool / getAppState / setAppState / readFileCache / thinkingConfig / …） |
| 执行态 | 不出现（Core 内部状态） | `ToolUseContext` 约 50 个字段的**可变大对象**，跨工具共享 |
| 会话 | 必须有（归属与落盘的载体），但**不等于用户回合** | `QueryEngine` 一实例一会话，`submitMessage` 一回合 |
| 会话状态归属 | 可选持久化后端 | AppState 全局读写回调（`getAppState` / `setAppState`） |

**值得注意的两处一致**：

1. **「一个会话一个执行器 + 每回合一次调用」**（`QueryEngine.ts:175-184`）与我们已拍板的「确认回复到达后同会话起新 Turn」是同一个形状。这不是巧合，而是这类系统绕不开的结构。
2. **窄依赖注入**（`query/deps.ts` 的 4 个依赖）是我们「注入式端口」的雏形，而且它刻意不铺开 —— 注释说先证明模式、后续 PR 再扩充。**我们应该照抄这份克制**：端口先窄后宽，不要一次开十个。

**它的反面教材是 `ToolUseContext`**。一个对象里同时装了五类东西：执行语义（`abortController`、`messages`、`fileReadingLimits`、`toolDecisions`）、安全（`localDenialTracking`、`requireCanUseTool`）、存储（`readFileState`、`contentReplacementState`）、遥测（`queryTracking`、`setResponseLength`）、**界面**（`setToolJSX`、`addNotification`、`setStreamMode`、`openMessageSelector`、`sendOSNotification`）。代价是注释里反复出现「这个字段只对 REPL 有效」「subagents 里是 undefined」「async agents 里是 no-op」。参数一多，**隔离就变成逐字段的手工维护**，而漏掉一项的后果是静默的（`utils/forkedAgent.ts` 里 `setAppStateForTasks` 这一项漏掉就是「后台 bash 任务永不注册、永不被杀，PPID=1 僵尸」）。

### 2.2 进程形态与驱动源：终端是唯一原生宿主

它支持的驱动源其实不少：REPL、`print`（一次性）、SDK（TypeScript / Python）、Bridge（IDE、Web）、Remote（CCR 容器）、`--daemon-worker`。差异全在**成本**：

- REPL 是原生宿主，其余全部是「接上去的」。`bridge/replBridge.ts`（100KB）与 `bridge/bridgeMain.ts`（115KB）合起来 215KB，处理的是「已有一个在终端里跑的会话，如何让远端客户端看见它、并能替它回答确认」。
- 「有没有界面」在它的代码里是一个**散落各处的布尔**：`isNonInteractiveSession` 既在 `ToolUseContext.options` 里，也通过 `getIsNonInteractiveSession()` 从全局读，还参与 `Tool.description()` 的分支和子 Agent 的 `isAsync` 推导。

**对我们的启示**：我们把 Driver 列为一等主干、并坚持「驱动权在主进程、桌面只是其中一个驱动源」，方向是对的 —— 它的 215KB bridge 就是「驱动源事后接进来」的账单。**另一个更细的启示**：它有个 `querySource` 贯穿全链路（`constants/querySource.ts`），用来回答「这次调用是从哪个入口进来的」，并且这个值会**随调用冻结、能熬过 autocompact**（`toolChatLoop` 侧注意：`querySource` 参与 fork 的递归守卫）。我们做 Driver 时应该有一份等价的「调用来源标识」，而且它必须随 Invocation 携带、不能从全局环境读。

### 2.3 安全：我们的 Safety vs 权限模式栈加分类器

它比我们多两个我们今天没有的机制：

1. **`acceptEdits` 的快路径**：写 / 改类工具在当前工作目录内直接放行，目录外才送分类器（`utils/permissions/classifierDecision.ts` 的注释明确说明这条分工）。这是一个**「规则命中就短路、只对真正模糊的部分付推理成本」**的形状，省的是真金白银。
2. **拒绝计数回退**（`utils/permissions/denialTracking.ts`）：`DENIAL_LIMITS = { maxConsecutive: 3, maxTotal: 20 }`，连续或累计拒绝超阈值就 `shouldFallbackToPrompting()` 回退到问人。这是「自动通道自己发现自己搞不定，主动降级到更保守的通道」—— 与我们的 fail-closed 兜底互补，fail-closed 处理「通道不可用」，它处理「通道可用但连续说不」。

它的弱项也清楚：**底线可以被配置放宽**。`bypassPermissions` 是一个用户可开的模式，`tengu_iron_gate_closed`（分类器失败时是否 fail-closed 的开关，默认 `true`）是一个**远程可翻转的开关**（`permissions.ts:843-873` 附近）。它靠企业策略（`policySettings`、`policyLimits`）与 killswitch 兜住，而不是靠架构兜住。

**一个值得学、但不该抄的细节**：它的规则来源是 8 个显式枚举，并且专门写了「被遮蔽规则检测」（`utils/permissions/shadowedRuleDetection.ts`）。这说明**「这条规则从哪来」是刚需**，一旦规则可以有多个来源，用户一定会遇到「我明明设了 allow，为什么还是被拦」。我们的 `PolicyRule` 目前缺少显式来源维度，建议补上。

### 2.4 审批通道：可插拔已经做到什么程度

这是它最接近我们目标的一块，值得逐条看：

- **`CanUseToolFn` 是注入的**（`hooks/useCanUseTool.tsx:27` 定义类型），Core 不自己决定怎么问。
- **三个回答者 handler 并列且有显式短路顺序**（`hooks/toolPermission/handlers/`）：
  - `interactiveHandler`：推入界面确认队列，等用户点；
  - `coordinatorHandler`：**先把自动检查跑完**（权限 hook → 分类器 → bash 分类器），都解决不了才落到对话框；
  - `swarmWorkerHandler`：worker 自己不了，通过 mailbox **转发给 leader 请求裁决**，并注册回调等答复。
  这个「先自动、后人工；先本地、后转发」的顺序与我们 §7.1 的判定顺序（规则 → 缓存 → 回答者）同构，可以互相印证。
- **桥接层有一个带请求 ID 的问答端口**（`bridge/bridgePermissionCallbacks.ts`）：
  `sendRequest(requestId, toolName, input, toolUseId, description, permissionSuggestions?, blockedPath?)` / `sendResponse(requestId, response)` / `cancelRequest(requestId)` / `onResponse(requestId, handler)`。回答者可以是终端、IDE 或 Web —— **这正是我们说的「确认通道不绑界面」**，而且它已经把三件事做成了契约：**请求 ID**（问答可对应）、**显式取消**（要能通知对端把卡片撤掉）、**随请求送出建议**（`permissionSuggestions`，让回答者一次决定「这一次」还是「以后这一类」）。
- **但它只解耦了一半**：`hooks/toolPermission/PermissionContext.ts` 仍然 `import type { ToolUseConfirm } from '../../components/permissions/PermissionRequest.js'`，`PermissionQueueOps` 的签名用的是这个界面类型。也就是说：**通道是端口，但端口里流的载荷仍是界面形状**。我们 §9 说的「对外承诺与内部实现」要防的正是这个。

**三条可以直接落进我们 §7.2 的**：确认请求只带锚点与理由（它带的是 `toolUseId` + `description` + `blockedPath`，是锚点而非参数全集）；取消必须可通知对端；「这一次还是以后这一类」的建议要随请求一起送出，而不是让回答者猜。

### 2.5 自动审批：我们的审批 Agent vs `auto` 模式分类器

它把自动审批做成了**一次独立的模型调用**（不是 Agent、不带工具、不做多轮），实现在 `utils/permissions/yoloClassifier.ts`（52KB）。逐条对照：

| 维度 | Claude Code 的做法 | 对我们审批 Agent 的意义 |
| --- | --- | --- |
| 输入 | 会话转录 + 当前动作的紧凑表示（`buildTranscriptEntries` / `formatActionForClassifier`） | 与我们「只补事实、不补结论」一致 |
| 工具侧自述 | **`Tool.toAutoClassifierInput(input)`**：工具自己声明「给审批看什么」，返回 `''` 表示无安全相关性（`Tool.ts` 注释：`Return '' to skip this tool in the classifier transcript`） | **我们缺这一层**。我们的 `factsProvider` 只有宿主能补事实，工具自己最有资格说「审批需要看哪几个字段」 |
| 规则 | 系统提示模板 + 用户可改三段：`allow` / `soft_deny` / `environment`（`AutoModeRules`） | 与我们「引擎在内、内容在外」一致；`soft_deny` 这个名字值得注意 —— 它区分了硬底线与软倾向 |
| 跳过集 | `SAFE_YOLO_ALLOWLISTED_TOOLS`（只读、搜索、任务元数据、UI 类工具等） | 与我们「规则命中就短路」一致 |
| 分阶段 | `resolveTwoStageClassifier()` 返回 `false / 'fast' / 'thinking'`，支持快慢两阶段 | **我们没有**。审批 Agent 也可以先快筛（只读、低风险）再深思 |
| 模型选择 | `getClassifierModel()` = ant env → 远程配置 `config.model` → 主循环模型 | 印证我们「模型档位是调用方声明」；它也承认「默认回落到主循环模型」是一个可接受策略 |
| 失败语义 | 结果带 `unavailable?: boolean`；`tengu_iron_gate_closed` 默认 `true` → **拒绝并提示可重试（fail-closed）**；为 `false` 时降级回落正常权限处理；`transcriptTooLong` → 回退人工审批 | **我们必须显式化这一段**，而且必须去掉远程开关（见 §4 第一优先） |
| 缓存 | **没有裁决缓存。** 每个进入分类流程的动作都真的调一次（只有白名单工具与「无安全相关性」的动作被提前跳过） | **直接印证我们已拍板的「裁决永不写缓存、一事一议」** |
| 成本 | 每次记录 model / usage / durationMs / prompt 组成长度 / 阶段用量，并算成 USD | **必须抄**。审批 Agent 的成本与延迟是一等指标，否则无法决定「值不值得自动审批」 |
| 缺证据时 | 提示里含 `CLAUDE.md` 内容（`buildClaudeMdMessage`） | 与它 `memdir` 的记忆体系呼应；我们的对应物是 Profile 加 Skill |

**一个必须明确的取舍**：它的审批者是**无工具的单次调用**，因为它只需要「看一眼动作，判是或否」。我们的审批 Agent 若要支持「自己去查一下这个路径是不是真的在项目里」，就需要工具和多轮，成本与延迟会明显上升。**这个取舍属审批 Agent 的详细设计（块 2），我们已选了带工具那条路**：封闭只读工具集、侦查轮数 ≤3（`docs/develop/architect/confirmation-answerer-and-auto-approval-design.md` §4.4），因为它要在「这个路径是不是真在项目里」这类问题上自己查证据。架构层要留下的只有一条形状约束：**确认通道不能被设计成单次同步问答**，否则将来换成多轮就要重做端口。

### 2.6 后台与无人值守：它的答案是「确认自动失败」

这一节是全文对我们最有价值的部分，因为它的答案和我们的目标正好相反。

- **没有界面就没法确认**。`ToolPermissionContext.shouldAvoidPermissionPrompts` 的注释原文是「When true, permission prompts are auto-denied (e.g., background agents that can't show UI)」（`Tool.ts:132`）。在 `createSubagentContext` 里，这个标志甚至**由「有没有共享 abortController（即是否是可交互 Agent）」推导出来**（`utils/forkedAgent.ts:356`）。
- 异步子 Agent 的 `isNonInteractiveSession` 被设为 `true`（`tools/AgentTool/runAgent.ts:668`）。
- `--daemon-worker` / `daemon` 子命令存在，而全仓只有 3 处引用（`entrypoints/cli.tsx:100`、`:165`，加 `commands.ts:77`）—— **后台不是一等形态，是绕过**。
- 定时做的相对成熟：`CronCreate` 带 `durable: false / true` 两档，`durable: true` 写入 `.claude/scheduled_tasks.json`，**重启后自动恢复，且在 REPL 关闭期间错过的 one-shot 任务会被显式 surface 出来做补跑**（`tools/ScheduleCronTool/prompt.ts`）。

**结论**：它**支持「跑在后台」**（有 durable 定时、有 daemon、有后台任务类型），但**放弃了「在后台还能安全地做决定」** —— 后台遇到需要确认的操作就是直接失败。这恰好证明我们的目标（安全策略模块独立、确认通道与界面正交、审批 Agent 作为回答者之一）不是过度设计，而是它这里空着的那个格子。

我们能补的两件事：**durable 的 catch-up 语义**（错过的任务要显式补跑，而不是静默丢弃），和**任务类型可扩展**的形状（`tasks/types.ts` 的 `TaskState` 是一个联合类型，`isBackgroundTask(task)` 是一条纯谓词，决定「这个任务进不进后台指示器」）。后者正是我们「归属 × 可见性最小可落形态」的现成参考：**先把归属做成一个带谓词的联合类型，再谈列表过滤**。

### 2.7 SubAgent：定义即配置、上下文逐字段隔离、模型解析链

这是它做的最完整的一块，四件事都值得我们逐条吸收。

**(1) 子 Agent 的定义就是一份配置**（`tools/AgentTool/loadAgentsDir.ts:73-155`）。字段清单：`tools` / `disallowedTools` / `skills` / `mcpServers` / `hooks` / `model` / `effort` / `permissionMode` / `maxTurns` / `memory` / `background` / `isolation: 'worktree' | 'remote'` / `omitClaudeMd` / `initialPrompt` / `criticalSystemReminder`。三个来源：内置、用户 / 项目 / 策略设置、插件。**它没有「子 Agent 类型」这种代码概念，子 Agent 就是一个 `AgentDefinition` 数据。**

**(2) 工具集裁剪是默认继承加两层减法，而且裁剪落在工具集上、不落在提示词上**（`tools/AgentTool/agentToolUtils.ts:122` 的 `resolveAgentTools`）：

- 全局 `ALL_AGENT_DISALLOWED_TOOLS`：子 Agent 不能用 `TaskOutput`、不能进出 Plan 模式、**不能 `AskUserQuestion`**，非内部构建还不能再派生 Agent（`constants/tools.ts:36`）；
- 异步子 Agent 另有一份白名单 `ASYNC_AGENT_ALLOWED_TOOLS`；
- 再按 `AgentDefinition.disallowedTools` 减、按 `tools`（支持 `'*'`）取交集。

**「不能问人的 Agent 不给问人的工具」这条最值得学** —— 它会直接落进我们 §7.2「确认权限由运行时所有权决定」：这不是文档里的一句话，而是一次**工具集裁剪**。反过来说，一个 Agent 只要拿到了 `AskUserQuestion`，它就有了人类应答者；这个授权必须在装配时给，而不是在运行时判断。

顺带一个反例：内置 Explore Agent 用的是**减法**（`disallowedTools` 列 5 个）而不是加法，因为它的工具集要从主 Agent 继承。这提示我们的 Profile「工具能力集」需要有**继承加增量**的表达，而不只是全量清单。

**(3) 上下文隔离是逐字段 opt-in**（`utils/forkedAgent.ts:345` 的 `createSubagentContext`）。默认：`readFileState` 克隆、`abortController` 建子控制器（父取消能传播）、`getAppState` 包一层加 `shouldAvoidPermissionPrompts`、所有 mutation 回调 no-op、集合重建。需要共享的必须显式点名（`shareSetAppState` / `shareAbortController` / `shareSetResponseLength`），**界面回调直接置 `undefined`**（注释：`UI callbacks - undefined for subagents (can't control parent UI)`）。有两处细节值得记住：`setAppStateForTasks` 故意直通根 store（否则后台任务永远注册不上），以及 `localDenialTracking` 是给「`setAppState` 是 no-op 的异步子 Agent」补的本地拒绝计数（否则回退阈值永远到不了）。

**(4) 模型解析是一条 4 层链**（`utils/model/agent.ts` 的 `getAgentModel(agentModel, parentModel, toolSpecifiedModel, permissionMode)`）：

1. `CLAUDE_CODE_SUBAGENT_MODEL` 环境变量（最高优先）；
2. 工具调用现场指定的模型；
3. `AgentDefinition.model`；
4. 默认 **`inherit`**（`getDefaultSubagentModel()` 就返回 `'inherit'`）。

外加两条防坑规则：**`aliasMatchesParentTier`**（`model: opus` 在父模型已经是 Opus 时**直接沿用父模型的完整字符串**，避免被解析成第三方默认版本造成意外降级）；**Bedrock 区域前缀继承**（IAM 按区域授权时子 Agent 必须同区域，但用户显式写了别的区域就尊重用户）。

思维强度上有个反差：**fork 型子 Agent 继承父的 thinkingConfig（为了 API 请求前缀逐字节一致、保住 prompt cache），普通子 Agent 一律 `{ type: 'disabled' }`（控成本）**（`runAgent.ts:679-685`）。也就是说「思维强度」在子 Agent 上的默认是**关**。

**(5) 递归与血缘**：`queryTracking.depth` 逐层加一；fork 有递归守卫（`options.querySource === 'agent:builtin:fork'`），并且考虑到「autocompact 会重写消息、但不会改 `context.options`」，所以守卫读的是 options 而不是消息（`runAgent.ts` 注释）。

### 2.8 存储与可见性：会话是可扩展的事件日志，子 Agent 物理分文件

**它就是我们的 Storage 那一节想要的答案，而且是现成的。**

- 会话 = `<projectDir>/<sessionId>.jsonl`，**只追加，一行一个 `Entry`**（`utils/sessionStorage.ts:198`、`types/logs.ts:297`）。
- `Entry` 是一个**20 种变体的联合类型**：消息、摘要、自定义标题、AI 标题、最后提示、任务摘要、标签、Agent 名 / 颜色 / 设置、PR 链接、文件历史快照、归因快照、队列操作、worktree 状态、内容替换记录、上下文折叠提交与快照、模式记录。
- 子 Agent = `<projectDir>/<sessionId>/subagents/agent-<agentId>.jsonl` 加一份 `.meta.json`；workflow 还能再分组到 `subagents/workflows/<runId>/`（`utils/sessionStorage.ts:247`）。
- 子 Agent 的第一条消息通过 `startingParentUuid` **挂到父链上**（`recordSidechainTranscript`）—— 即**物理分文件、逻辑同链**。
- 会话列表只扫顶层目录（`fetchLogs()` → `getSessionFilesLite(getProjectDir(originalCwd))`），所以**子 Agent 天然进不了列表，不靠过滤**。
- 两级读取：列表用 lite 元数据（不载消息），要内容才全量读；`MAX_TRANSCRIPT_READ_BYTES = 50MB` 是硬上限（注释说会话 JSONL 能涨到几个 GB）。

**建议直接采纳三条**：①**归属靠物理分层**（我们的「内部调用不落用户会话行」应该落成目录 / 表空间，而不是查询时的过滤条件）；②**会话事实是可扩展的条目联合**（我们的会话 / 消息是固定三行，加「标签、摘要、PR 链接、文件历史」这类事实都要动 schema）；③**两级读取加读上限**。

它弱于我们的地方：**审计没有独立地位**。它的安全相关记录散在 analytics 事件与转录里，没有「不可改写、独立物理隔离、有保留期」的审计承诺。我们 §8 的 `Safety 持有审计语义` 这一条比它硬。

### 2.9 扩展点：27 个事件与「三合一」的工具契约

**Hook 事件清单**（`entrypoints/sdk/coreTypes.ts:23`，27 个）：`PreToolUse`、`PostToolUse`、`PostToolUseFailure`、`Notification`、`UserPromptSubmit`、`SessionStart`、`SessionEnd`、`Stop`、`StopFailure`、`SubagentStart`、`SubagentStop`、`PreCompact`、`PostCompact`、`PermissionRequest`、`PermissionDenied`、`Setup`、`TeammateIdle`、`TaskCreated`、`TaskCompleted`、`Elicitation`、`ElicitationResult`、`ConfigChange`、`WorktreeCreate`、`WorktreeRemove`、`InstructionsLoaded`、`CwdChanged`、`FileChanged`。

执行模型是**进程外的命令 hook**：在 settings 里配 `matcher` + `command`，JSON 走 stdin / stdout，返回体有 `continue` / `stopReason` / `decision` / `systemMessage` / `hookSpecificOutput`，支持 `async: true`，也可以是进程内回调（`HookCallback`）。`PreToolUse` 能返回 `permissionDecision`（`allow / deny / ask / passthrough`）、`updatedInput` 和 `additionalContext`。

**两个借鉴点，一个警告**：

- ✅ **事件清单值得拿来做一次缺项对照**。我们有而它没有的：审批裁决的独立事件（它的 `PermissionRequest` / `PermissionDenied` 偏交互，不是裁决审计）。它有而我们没有的：`SessionStart` / `SessionEnd`、`PreCompact` / `PostCompact`、`ConfigChange`、`InstructionsLoaded`、`SubagentStart` / `SubagentStop`、`CwdChanged` / `FileChanged`。其中**压缩前后**、**配置变更**、**指令加载**三个对我们正在写的方案是有用的（压缩会影响上下文审计口径；配置变更要进审计；指令加载影响「这次是谁改的」）。
- ✅ **`additionalContext` 是一种安全的扩展形状**：「只补上下文、不改行为」。它和我们的 `factsProvider` 是同一个设计原则。
- ⚠️ **`updatedInput`（hook 可以改写工具参数）我们不该抄**。我们 §5.3 的理由（行为定制必须落在可枚举、可审计的地方）比它更硬，而它自己也承认这块的复杂度：`Tool.backfillObservableInput` 的注释专门区分「API 侧原始输入永不改写（保 prompt cache）」「hook / 权限返回新的 `updatedInput` 时不再重放 backfill，因为它自己拥有形状」。**这是「多个改写者共享一个输入对象」的典型代价。**

顺带一个可抄的形状：**插件 manifest 一个包声明多类扩展**（commands / agents / skills / hooks / output-styles / MCP / LSP / settings）。对应我们的块 1，**Profile 可以不是「一份配置」而是「一个可发布的包」**，这样「管家 Agent 的 Profile」就是一个能版本化、能分发的东西。

### 2.10 上下文与记忆：压缩三档、可重放的替换决策、目录驱动的指令

- **压缩不是一件事，是三件**：`microCompact`（微压缩）、`autoCompact`（自动压缩，带阈值与压缩警告 hook）、`sessionMemoryCompact`；另有 `snipProjection`（headless 下按 snip 边界截断历史，注释说 REPL 不截断是为了保住滚动回看的完整历史）。
- **一条我们该吸收的语义**：`contentReplacementState` 会**记录哪些工具结果被替换过**，理由写在 `createSubagentContext` 的注释里 —— 缓存共享的 fork 会处理父级的 `tool_use_id`，如果替换决策不一致，线前缀就会不同、prompt cache 就 miss。**即「同样的历史必须产生同样的上下文」。** 我们的 `docs/develop/context-injection-refactor-plan.md` 应该把这条写成不变量（可重放）。
- **记忆**：`CLAUDE.md` 层级记忆（目录驱动、自动加载、有 `InstructionsLoaded` 事件）加 `memdir`（自动抽取记忆、有类型与「什么不该存」的规则段）加 `autoDream`（后台整理记忆，**有对应的 `DreamTask` 任务类型**）加团队记忆同步。
- **一个现成的后台 Agent 用例**：`DreamTask` 就是「定时 / 后台起来、读一批历史、整理成记忆、落盘」的样板 —— 它的形状与我们要做的「自动化任务托管」几乎同构，可以直接作为管家 Agent 的第一个样板任务来对照。

### 2.11 后台投递与任务：命令队列而不是轮询

这一节直接回答我们「确认回复到达后同会话起新 Turn、不然要轮询」那条决定。

它的机制是**进程级命令队列 + 逐 Agent 寻址 + 在循环迭代顶部 drain**（`query.ts:1545-1650`）：

- 队列里有 `mode: 'prompt' | 'task-notification' | 'orphaned-permission'` 三类命令；
- 每个循环迭代开始时会 drain，并按寻址过滤：主线程只取 `agentId === undefined` 的，子 Agent **只取 `mode === 'task-notification'` 且 `agentId` 等于自己的**（注释：子 Agent 永远看不到用户提示流）；
- 优先级有 `'next'` 与 `'later'` 两档，`'later'` 由 `Sleep` 工具触发 flush（`Sleep` 的提示词明确说「每次唤醒要花一次 API 调用，但 prompt cache 五分钟不活动就过期，自己权衡」）；
- 命令有生命周期通知（`notifyCommandLifecycle(uuid, 'started' | 'completed')`），幂等地从队列移除。

**这就是「不轮询」的现成形状**：外部事件（子 Agent 完成、确认答复到达）作为一条**带寻址的命令**入队，循环在下次迭代时自己取走；如果 Agent 处于 `Sleep`，则用一次明确的唤醒 flush 它。我们做管家 Agent 时应该照这个形状设计（`enqueue(target, command)` 加「循环迭代顶部 drain」加「睡眠语义」），而不是让调用方去 poll。

### 2.12 界面与 Core 的耦合：类型层面的证据

我们的问题「渲染功能的逻辑和 Agent 是不是强耦合」，在这里有一个答案明确的样本。

- **`Tool.renderToolUseMessage` 是 `Tool` 接口的必填成员**（`Tool.ts:605`），另有 8 个可选渲染方法，以及一批为界面服务的查询方法：`userFacingName`、`getActivityDescription`（转圈提示文案）、`isSearchOrReadCommand`（决定 UI 是否折叠）、`isResultTruncated`（决定点击展开）、`extractSearchText`（转录搜索索引的文本）、`renderGroupedToolUse`。
- **40 余个工具里 28 个有独立 `UI.tsx`**；`BashTool.tsx`（160KB）直接 `import { renderToolUseMessage, ... } from './UI.js'`；`GrepTool.ts` 也 import 渲染函数。**没有「无 UI 版工具」这种存在。**
- `AgentTool.tsx` 233KB 加 `AgentTool/UI.tsx` 125KB。
- **最锋利的一处**：远端模式（工具其实在容器里跑、本地根本没有渲染端）需要造一个假工具，`remote/remotePermissionBridge.ts` 的 `createToolStub()` 也不得不实现 `renderToolUseMessage` —— **在明确没有渲染端的场景里，类型系统仍然要求它提供渲染函数。**
- 代价还体现在别处：`ToolUseContext` 里为界面留了一组回调，在子 Agent 里只能写成 `undefined`；而 `AgentTool` 的**实现**会直接调用父级的 `toolUseContext.setToolJSX(...)` 推送进度面板（`tools/AgentTool/AgentTool.tsx:873`、`:1152`）—— 也就是说，工具实现里可以直接操作界面。

**结论**：渲染逻辑与 Agent **不是**必然耦合，但**把「呈现」放进工具契约就一定会耦合**。我们的方向（工具 = 能力 + 权限；呈现归 Driver 与渲染进程；工具只产出结构化事实）是对的，而且可以用它这里的痛处作为论据。

---

## 3. 我们不必照搬的

1. **单进程 + 终端为宿主**。它是 CLI，界面天然可有可无；我们是桌面产品，界面是主体。它的「无界面 = 确认自动失败」正是因为它只需要保证 CLI 场景。
2. **工具契约里的渲染方法**。见 §2.12。
3. **`ToolUseContext` 式的上帝上下文对象**。约 50 个字段、五类关注点混装、隔离靠逐字段手工维护。
4. **`updatedInput` 式可改写 Hook**。见 §2.9。
5. **远程开关能翻转安全底线**（`tengu_iron_gate_closed`、`bypassPermissions`）。我们的底线不接受配置替换；远程开关的能力应该只用于「非安全的能力开关与 kill switch」。
6. **`sideQuery` 直连模型**跑内部分类器（绕开统一的模型服务解析）。我们的审批 Agent 必须走 `resolveModel` 端口，否则成本、凭据、审计三件事都会分裂。
7. **27 个 Hook 事件全铺开**。它的配置驱动形态决定了「事件越多越好」；我们是架构决定扩展点，**只开放能对应到明确 owner、且能被审计的事件**。
8. **编译期 `feature()` 与运行期开关混用表达同一件事**。它的分工本身清晰（一个管产物、一个管行为），但落到我们身上，安全相关的行为不应该有运行期开关。

---

## 4. 值得学习的地方（按对我们的紧迫度排序）

### 第一优先：直接影响正在写的方案

1. **审批裁决不缓存、且每次带成本与证据遥测** —— 它每个需要判定的动作都真的调一次分类器（无裁决缓存），并记录 model / usage / durationMs / prompt 组成长度 / 阶段用量 / 折算成本（`yoloClassifier.ts` 的 `YoloClassifierResult`）。我们的审批 Agent 必须把「一次裁决」当成一等可观测对象，否则无法回答「自动审批值不值」。
2. **失败语义显式化且不可被远程翻转**：它的 `unavailable` 分支默认 fail-closed 并附带重试指引，`transcriptTooLong` 则回退人工审批。**但它的 fail-closed 是由远程开关（`tengu_iron_gate_closed`）决定的 —— 这一点我们必须反着做**：默认 fail-closed，且**没有开关**。
3. **「给审批看什么」由工具自己声明**（`toAutoClassifierInput`，返回 `''` 表示无安全相关性）。我们的 `factsProvider` 应该拆成两半：**工具自述的审批可见输入**（装配期声明）加**宿主补充的事实**（运行期注入）。
4. **无人类应答者的 Agent 不给问人的工具**（`ALL_AGENT_DISALLOWED_TOOLS` 含 `AskUserQuestion`；子 Agent 的界面回调置 `undefined`；`shouldAvoidPermissionPrompts` 自动拒绝）。我们 §7.2 的「确认权限由运行时所有权决定」应该落成**能力裁剪（工具集与 Profile）**，而不是运行时判断。
5. **父级审批不泄漏到子 Agent**：`AgentTool` 的 `allowedTools` 语义是「**替换**全部 allow 规则，子 Agent 只有显式列出的」（注释原文：`parent approvals don't leak through`）。这条要写进我们 §7.1，作为「底线不可放宽」的一个具体形状。
6. **子 Agent 的模型解析链**（4 层，默认 `inherit`，同档位别名不静默外降，能力与区域随父继承）。我们的 §5.4 建议再补两条硬规则：**默认必须是 inherit**；**解析失败必须 fail loud**，不允许静默换成某个默认模型。
7. **子 Agent 的会话归属 = 物理分文件 + 父链锚定**（`<sessionId>/subagents/agent-<id>.jsonl`，首条挂 `startingParentUuid`），列表只扫顶层。直接落到 §8 的「归属与可见性最小可落形态」。
8. **确认答复的到达 = 命令队列 + 逐 Agent 寻址**（`query.ts:1545-1650`），配合 `Sleep` 的显式唤醒，而不是轮询。这是我们「同会话起新 Turn」的现成机制形状。
9. **durable 定时任务的两档语义与 catch-up**：会话内（进程死即消失）vs 落盘（重启恢复、错过的 one-shot 显式补跑）。块 5 可以直接对照。

### 第二优先：影响块 3 / 块 4 的方案

10. **窄依赖注入先证明模式再扩充**（`query/deps.ts` 只有 4 个依赖，注释明说 scope intentionally narrow）。我们开端口时应该先窄后宽。
11. **拒绝计数回退**（连续 3 / 累计 20 → 回退到更保守的通道，`denialTracking.ts`）。我们的审批 Agent 也需要「连续被拒 N 次就换通道」的兜底，而且异步场景下这个计数要能本地累加（`localDenialTracking` 的教训）。
12. **快路径省钱**（`acceptEdits`：目录内免分类、目录外才送分类器）。
13. **分阶段裁决**（`false / 'fast' / 'thinking'`）：低风险动作快筛、模糊动作深思。直接决定审批 Agent 的成本曲线。
14. **权限规则要有显式来源维度**（8 种 source）与**被遮蔽规则检测**。我们的 `PolicyRule` 缺来源，用户一定会问「我设的 allow 为什么没生效」。
15. **工具结果的落盘阈值**（`maxResultSizeChars`：超限写文件、模型只看到预览，`Infinity` 表示永不落盘）。我们的工具结果契约应补这一维。
16. **工具 schema 的延迟加载**（`shouldDefer` / `alwaysLoad` / `ToolSearch`）：工具多起来之后，上下文预算必须能按需加载，且要有「第 1 轮必须可见」的例外标记。
17. **`querySource` 式的「调用来源标识」**：随调用冻结、能熬过压缩、参与递归守卫。我们做 Driver 时要有等价物，且不能从全局环境读。

### 第三优先：架构卫生

18. **「派生索引文本必须等于实际渲染文本」**：`extractSearchText` 的注释规定它必须返回转录里真实可见的文本，并为此写了一个 fidelity 测试来抓「索引了但没渲染」与「渲染了但没索引」。这与我们「客户端从不自己折叠」同源，可以补一条：**派生视图不能声称它没显示的东西**。
19. **两级读取加硬上限**（lite 元数据 / 全量消息；50MB 读上限）。
20. **`enum` 化的模式与行为联合**，而不是布尔开关堆叠。
21. **fork 的递归守卫要读「不会被压缩重写」的位置**（它读 `options.querySource` 而不是扫描消息，因为 autocompact 会重写消息）。我们有 SubAgent 后一定会踩到。
22. **可扩展的任务类型**（`TaskState` 联合 + `isBackgroundTask()` 纯谓词），对应我们的「归属 × 可见性」。

---

## 5. 对现有文档的修订建议

对照 `docs/develop/architect/product-architecture-design.md` 的具体落点：

1. **§1.2 不变量 3**：增补一条具体形状 —— 「父级审批不泄漏到子 Agent」（子 Agent 的 allow 集合是**替换**而非继承）。
2. **§5.2 端口表**：`factsProvider` 拆成两半 —— **工具自述的审批可见输入**（装配期、随工具声明）与**宿主补充的事实**（运行期注入）。前者直接对应 `toAutoClassifierInput`。
3. **§5.4 模型与思维强度**：补两条硬规则 —— 默认必须是 `inherit`（不是「默认某个档位」）；解析失败必须 fail loud，且同一档位的别名不得被静默解析成别的具体模型。
4. **§5.4**：补一条默认值语义 —— 子 Agent 的思维强度默认**关闭**（它是成本项，不是能力项），只有明确声明才打开。
5. **§5.5 事件出口**：用本文 §2.9 的 27 事件清单做一次缺项对照；建议至少补 `SessionStart` / `SessionEnd`、`PreCompact` / `PostCompact`、`ConfigChange`、`InstructionsLoaded`、`SubagentStart` / `SubagentStop`。**按「每个事件有明确 owner」筛选，不做全铺。**
6. **§7.1 策略规则**：补两个维度 —— **规则来源**（谁设的）、**拒绝计数与回退阈值**（连续 / 累计两个计数，超阈回退到更保守通道）。并保留我们比它硬的那条：判定顺序与 fail-closed 兜底**不接受配置替换，也不接受远程开关**。
7. **§7.2 确认通道**：补三点 —— ①确认请求带「建议」（这一次 vs 以后这一类，对应 `permissionSuggestions`）；②取消必须能通知回答者对端撤销（对应 `cancelRequest`）；③回答者的尝试顺序与短路必须显式且可测（对应三个 handler 的排列）。
8. **§6.2 Invocation**：明确会话锚点的形状 —— **一个会话一个执行器实例、每回合一次调用**（`QueryEngine` 已印证），且答复到达走**队列加寻址**而非轮询。
9. **§8 Storage**：补四件事 —— ①会话事实是**可扩展的条目联合**，不是固定三行；②**归属靠物理分层**（子 Agent / 内部调用落子目录或独立表空间），列表只扫顶层；③**两级读取**（lite 元数据 + 全量消息）与读上限；④**「同样的历史必须产生同样的上下文」**（替换决策要可重放，对应 `contentReplacementState`）。
10. **§10 偏差清单**：新增两条以「可复现命令式证据」表述的偏差 —— ①**安全裁决是否可能被配置放宽**（对照它的 `tengu_iron_gate_closed` 与 `bypassPermissions`，我们必须是「不可放宽且无开关」）；②**子 Agent 的能力裁剪是否落在工具集**（对照 `ALL_AGENT_DISALLOWED_TOOLS`，我们不能只写在文档或提示词里）。
11. **归入块 2 方案文档，不进 `roadmap §8`**：审批者是否需要工具、它的轮数与预算，是审批 Agent 的详细设计取舍，且 `docs/develop/architect/confirmation-answerer-and-auto-approval-design.md` §4.4 已给出答案（封闭只读工具集、≤3 轮侦查）。架构层只需补一条形状约束：**确认通道不预设为单次同步问答**（回答者内部也可以是一次 Core 调用），并记下排期依赖 —— 采用多轮后，块 2 依赖调用级隔离（与块 3 同源）。

---

## 6. 一句话总结

Claude Code 给我们的不是新方向，而是三样具体的东西：**一份审批器的工程化清单**（不缓存、每次带成本遥测、工具自述审批输入、快慢两阶段、拒绝计数回退、失败语义显式化）、**一份子 Agent 的现成设计**（定义即配置、工具集裁剪承载权限、上下文逐字段 opt-in、模型解析链、归属物理分层）、**一份「把所有关注点塞进一个上下文对象」的反面教材**。而它空着的那个格子 —— **在后台还能安全地做决定** —— 恰好就是我们要建的东西。