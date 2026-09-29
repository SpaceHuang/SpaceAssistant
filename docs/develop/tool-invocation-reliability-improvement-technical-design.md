# Agent 工具调用可靠性与安全决策一致性 — 改进技术方案（R1–R8）

- 定位：**实施类技术方案**（需求 → 设计 → 改动清单 → 验收），上游为 `docs/requirement/tool-invocation-reliability-requirement.md`（v1.0）。
- 架构基线：`docs/develop/architect/product-architecture-design.html`（与 `product-architecture-design.md` 同源）§1 不变量、§2 六块主干与判据、§5 Runtime 端口、§6 Core 契约、§7 Safety 三条判据、§8 Storage 语义、§10 偏差清单。本文所有落点均按该基线判层，并在 §2.6 逐条对齐偏差编号。
- 基线：工作区 HEAD（摸排快照，行号仅作辅助，证据应由本方案附录 B 的命令复现）。
- 状态：**v1.4（已吸收评审 v1）** ｜ 范围：R1–R8 全部（含公共设施与门禁）。
- 评审：`docs/review/20260925-tool-invocation-reliability-improvement-plan-review-v1.md`（针对 v1.3：1 P0 + 2 P1 + 4 P2）。处置摘要见文末「修订记录」。

**一句话**：这八条问题的失效模式各不相同，但落点是同一个 —— **「事实」在系统里有多份副本**：工作目录基准有三份、审批载荷有两份（构造侧与会话信任侧）、结果语义有两份（执行事实与信封字段）、搜索结论有两份（搜过了 / 没搜）。本方案的做法不是逐条打补丁，而是给这四类事实各定**单一事实源 + 单一构造出口 + 可解释的诊断契约**，再让错误分类、参数校验、搜索范围透明成为它们的副产品。

---

## 0. 阅读指引

| 想回答的问题 | 看哪节 |
| --- | --- |
| 每个问题落在哪一层、改完后长什么样 | §1.2、§4 |
| 为什么这样改不违反架构承诺 | §2、§6 |
| 今天代码到底是什么形态（含复现命令） | §3、附录 B |
| 谁先做、依赖谁 | §6 |
| 怎么验收、CI 怎么拦 | §7 |
| 会不会把安全改松 | §2.4、§4.5、§8.2、§9 |

---

## 1. 结论

### 1.1 三条主轴

| 主轴 | 覆盖问题 | 一句话做法 |
| --- | --- | --- |
| **A. 单一事实源** | R1 | 会话工作目录在 **Runtime 装配期解析一次**成快照，环境自述、文件工具、Shell 执行器、安全审批**读同一份快照的同一个 revision**；不再各自计算、不再一方读「全局 active profile」 |
| **B. 可解释拒绝** | R2、R3、R8 | 拒绝与失败一律携带**结构化诊断**（命中规则、判定基准、解析后目标、建议动作、分类），文案由「键 + 参数」生成；载荷构造缺陷必须报「载荷不完整」，不得表述为「调用参数缺失」 |
| **C. 不撒谎的返回值** | R4、R5、R6、R7 | 结果信封**单一构造出口 + 不变量校验**；解析失败**降级为确认**而不是等价于危险；搜索「无匹配」必须同时说明实际搜索范围；参数校验与执行路径**同源**，等价默认值不报错 |

### 1.2 问题 → 主干层 → 修复形态

| # | 优先级 | 归属（六块） | 修复形态 | 新增共享件 | 前置 |
| --- | --- | --- | --- | --- | --- |
| R1 | P0 | Runtime（装配）+ Core / Safety（消费）+ Utils（规范化） | 工作目录快照进 `ports.workspace`，四消费点同源 | `WorkspaceSnapshot`、`workspacePathKey()` | — |
| R2 | P0 | Safety（诊断内容）+ Core（回传）+ Driver（渲染） | `SafetyDiagnostics` 随判定结果下发 | 诊断契约 + i18n 键表 | R1（基准要能写进诊断） |
| R3 | P0 | Safety（载荷）+ Runtime（工具声明装配） | MCP 事实信号补入参摘要与分类依据；载荷完整性校验与告警 | `mcp-invocation` 信号、`assertApprovalPayloadComplete()` | R2（同一诊断出口） |
| R4 | P0 | Core（信封构造）+ Storage（事件流）+ Utils（枚举） | 信封单一出口 + 不变量断言 + 五类失败码 + 历史全量扫描 | `toolResultContract.ts`、`TOOL_*` 码、扫描脚本 | — |
| R5 | P1 | Core（shell 事实）+ Safety（审批结论）+ 审批侧契约 | 解析失败从「拒绝」改为可区分结论（`unsupported`），**沿既有 ask 流程走审批；审批新增「判定不了」态 → 才回退人工** | `verdict: 'unsupported'`、`agent-undetermined` cause、审批第三态 | R2 |
| R6 | P1 | Core（工具实现）+ Runtime（说明注入） | 搜索范围透明 + 显式路径尊重调用方 + `include_ignored` 开关（**默认忽略可解除，不引入访问控制**） | `GrepScope`、`GREP_DEFAULT_IGNORES` | R7（同源参数归一） |
| R7 | P2 | Core（校验与执行同源） | `normalizeGrepArgs()` 单一入口，按「生效值冲突」判定 | — | — |
| R8 | P2 | Core（执行器）+ Utils（错误码）+ Driver（文案） | 目录错误四分类 + 建议动作 | `DirectoryErrorClass`、两个新错误码 | R2（键 + 参数形态） |

**依赖读法**：`R1` 与 `R4` 是公共前置（前者给诊断提供基准，后者给「未执行原因」提供闭合语义）；`R2 → R3 / R5 / R8` 是「诊断出口先定形状」；`R6 / R7` 成对（同一份参数归一）。除此之外，R5、R6、R7、R8 互不阻塞，可并行。

### 1.3 与需求验收标准的对应

| 需求条目 | 本方案落点 |
| --- | --- |
| R1 四环节一致性 100%（含隐藏目录、符号链接、相对/绝对、会话切换） | §4.1、§7.2 T-R1-* |
| R2 三类拒绝 + 补信息可重试 | §4.2、§7.2 T-R2-* |
| R3 载荷含入参、只读抓取不误判为写、载荷构造告警 | §4.3、§7.2 T-R3-* |
| R4 不变量、五类失败码、历史扫描为 0、界面一致 | §4.4、§7.2 T-R4-* |
| R5 三态解耦 + 降级确认 + ≥5 条控制结构用例 | §4.5、§7.2 T-R5-* |
| R6 范围透明 + 显式路径 + 显式开关 | §4.6、§7.2 T-R6-* |
| R7 等价默认值不报错 + 校验执行同源 | §4.7、§7.2 T-R7-* |
| R8 四类错误可区分 + 建议动作 | §4.8、§7.2 T-R8-* |

---

## 2. 架构约束（本文必须遵守的既有承诺）

### 2.1 每项改动放哪一层（按 §2.5 四条判据）

| 改动 | 放哪 | 判据 |
| --- | --- | --- |
| 工作目录快照的**解析**（读库、读 profile、realpath） | **Runtime 装配期**（唯一装配点） | 判据 3：它是「把宿主的东西装配成一次调用」 |
| 工作目录快照的**消费**（`cwd`、路径校验、`EnvFacts.workDir`） | **Core / Safety** | 判据 1：换了它执行语义与安全语义就变 |
| 路径规范化 / 比较键 | **Utils** | 判据 4：删掉只影响质量，不影响语义 |
| 诊断的**内容**（规则 ID、基准、目标、建议） | **Safety**（内容在外） | §7.1 第一问：它变了产品安全语义就变 |
| 诊断的**形状**与下发 | **Core 协议**（闭合字段，不可被配置替换） | §7.1 第二问：被调用方伪造会误导判定 |
| 结果信封的构造出口 | **Core**（`packages/agent-core` 内的纯数据契约） | 判据 1：信封是执行语义的对外表达 |
| 信封的历史扫描脚本 | **Utils / 工具链** | 判据 4 |
| 新增 i18n 文案 | **Driver（渲染端真源）+ 主进程只产键** | §2.4 规则 1：主进程不产出文案 |

### 2.2 本方案新增字段的归属判定（§6.2 元规则）

架构 §6.2 要求：每新增一个契约字段，先回答「嵌套调用里它怎么取值」。

| 新字段 | 维度 | 嵌套语义 | 理由 |
| --- | --- | --- | --- |
| `WorkspaceSnapshot`（含 `revision`） | **身份与归属** | **不继承**：子调用显式声明自己的 workDir（SubAgent 落父 turn 的目录也要显式传） | 「混进父的归属就是串扰」；且写授权按 profile/路径租约键控（`writeSafety/pathLeaseRegistry`） |
| `SafetyDiagnostics` | **授权（判定结果）** | **不继承**：每次判定各自产出，父的放行不构成子的授权 | §1.2 不变量 3 |
| `ToolResultEnvelope` | 执行结果（非授权、非成本） | 各自产出，父调用只在 `InvocationResult` 里回灌自己的 | 结果不是可继承属性 |
| `GrepScope` | 执行过程事实 | 各自产出 | 同上 |

### 2.3 扩展点四层：本方案只加「声明式数据」与「注入式端口」

- **加数据**：`WorkspaceSnapshot` 随装配携带；MCP 载荷字段由**工具声明**（§5.2「工具自述的审批可见输入」）决定要看哪些参数；grep 的 `include_ignored` 是工具入参。
- **加端口/字段**：`ports.workspace.snapshot()`、诊断随判定结果回传。
- **不开新回调、不开放改写**：不引入 `onToolCallStart → 改写参数` 之类；信封的失败码是**闭合枚举**，不接受插件扩展；诊断的文案是「键 + 参数」，不接受外部注入文案。
- **写死不动**：判定顺序（规则 → 缓存 → 回答者）、fail-closed 兜底、缓存写入准入、上下文装配顺序一律不动。

**一条判据：这是「默认值」还是「规则」？**（R6 修订中提炼，用于判断某个目标限制该放哪层）

| | 默认值（工具层，正确） | 规则（策略层，必须走 Safety） |
| --- | --- | --- |
| 判据 | **调用方的显式意图可以解除它** | **任何调用方都解除不了** |
| 例子 | grep 默认不搜 `node_modules`，显式路径或 `include_ignored` 一给就搜 | `automation-default-confirm`（`locked` 兜底 `ask`，`src/shared/policy/defaultRules.ts:304`）：任何工具入参都解除不了，且对该 lane 下全部工具一致生效 |
| 归属 | 工具实现（声明式数据：常量清单 + 入参） | Safety（规则内容在外、随 Invocation 传入、有 `ruleSource` 与 `policy.decision` 审计） |
| 跨工具一致性 | 不要求（各工具可有自己的默认） | **强制**（同一目标 / 动作在所有工具上的规则结论必须相同） |

**这条判据为什么必须写进架构约束**：因为「默认值」与「规则」最容易被混成一件东西 —— 把规则写进工具实现（R6 早期设计即如此），会同时踩三个坑：**不随调用传入**（无来源、不可覆盖）、**判定在门控之后**（Safety 看不见，等于绕开「判定不可绕」）、**跨工具不一致**（`read_file` 能读而 `grep` 不能读 —— 正是 R1 要消灭的「同一事实、多份结论」）。反过来说，把默认值升格成规则，等于**用一个工具的便利性设定，偷偷改了产品安全语义**。

> **现状缺口（评审 B3 修正；O8 定案后再次更新）**：早期版本在本表举例「敏感路径前缀：`read_file` / `grep` / `run_shell` 一致受限」——**该陈述与代码不符，已撤回**。核对 `isSensitivePath()` 的全部消费方：现状只有写入自动放行（`electron/tools/writeFileAutoApproval.ts:26-27`）与 shell 路径分析侧（`electron/shell/shellPathAnalysis.ts:124`、`bashSecurityRules.ts:127`、`psSecurityRules.ts:79`）；**`read_file` / `grep` / `list_directory` 现状均不受约束**（只走 `resolveSafeReadPath` 的越界防护）。
>
> **O8 定案（选项 3）后的新状态**：R6 落地后 **`grep` 开始消费该机制**（因 `--hidden` 必须同时护住敏感点文件），但**以「默认忽略」形态生效**（遍历排除、显式点名可解除）—— 这正是本表「默认值」一列的定义，因此它**不构成本表意义上的「规则」**。**`read_file` / `list_directory` 仍不受约束**，这一更早存在的缺口单列为独立待立项项（见 §9 非目标第 7 条），本方案不修、也不据此声称一致性。

### 2.4 Safety 的三条判据（证明本方案不放宽底线）

架构 §7.1 给出三条判据（可放宽性 / 可伪造性 / 被改坏后安全路径是否失效）：

| 判据 | 本方案的对应结论 |
| --- | --- |
| ① 它变了产品的安全语义吗 | **诊断字段、失败分类、搜索范围统计、参数校验的宽容化都不改变任何既有 allow / ask / deny 规则**：R5 的降级只发生在「解析不出来」这一技术性原因上（需求 §4 非目标明确「不降低任何既有安全规则」），危险命令仍按原规则 deny |
| ② 被调用方伪造会不会越权 | 工作目录快照由 Runtime 解析、由 Safety 读；**调用方（含渲染进程）无法提供基准**；新增 i18n 参数全部经 `sanitizeAgentText` 脱敏后才进文案与审计 |
| ③ 把它改坏（放宽**或**收紧）之后安全路径是否失效 | 本方案**不触碰**判定顺序、fail-closed、审计成对这三类不可变集内容；R5 把解析失败从 deny 改为确认时，desktop 走审批（判不了转人工）、**automation 由新增的 lane 限定 deny 规则收敛为拒绝**（O9）；把回答者换成审批 Agent 不改 Safety 一行（§7.2 结构含义） |

### 2.5 横切关注点

| 关注点 | 本方案要求 |
| --- | --- |
| i18n | 主进程只产 `messageKey + messageParams`；文案落在 `src/renderer/i18n/resources/zh-CN`（真源）+ `en-US`，`npm run i18n:check` 必须过 |
| 日志 | 新事件名（如 `tool.result.contract-violation`）必须进 `electron/agentLogger/types.ts` 的闭合联合与字段投影白名单，**不允许自由文案** |
| 审计 | 诊断字段进 `electron/confirmation/securityAuditLog.ts` 的字段白名单，并同步 `securityAuditReader.ts`；审计只追加、独立文件、保留期由 Storage 持有 |
| 脱敏 | 诊断中的目标路径经 `sanitizeAgentText`（主目录折叠 + 秘密脱敏）；审计与用户文案共享同一净化入口，不在各调用点「记得调用」 |

### 2.6 与 §10 偏差清单的对应（本方案推进哪些偏差）

| 偏差 | 本方案的关系 |
| --- | --- |
| 1（Core 依赖驱动源，已解决） | **复用**其成果：`emitFactEvent` / `emitSessionEvent` 已是端口，本方案的告警出口走同一形态 |
| 2（Core 依赖 Storage） | **按同方向收口**：工作目录快照、目录错误分类都不在 Core 里新增读库；`list_directory` 只做执行器内事实归类 |
| 3（Safety 依赖 Storage 与宿主配置） | **同方向**：R2/R3 只让 Safety 消费装配期传入的 facts 与快照，不新增读库点 |
| 4（`AutoEvaluator` 同步给结论） | **不触碰**：R3 只补事实（载荷字段），不给结论 |
| 7（归属与可见性，已解决） | **不触碰** |
| 11（视图更新契约，部分解决） | R8 的文案走既有 i18n 与事件流，不新开通知通道 |
| 15（档位能否调宽严） | **不触碰**：R5 的降级不涉及档位 |
| 16（子调用能力裁剪） | **相关**：R5 的 automation 收敛依赖「规则按 lane 匹配」，与 16（按调用裁剪能力）同源 |
| 21 / 22（automation lane，已解决） | **对齐且修正**：R5 对 automation 的降级路径**新增 lane 限定 deny 规则**（O9）—— 原稿声称「由既有 catch-all 收敛为拒绝」与引擎实现不符（automation 的 ask 回答者恒为审批 Agent）；见 §4.5.5 |
| 23（准入维度） | R4 的「未执行原因」新增类别不得与准入拒绝混淆（`confirm.outcome.cause` 已区分 `unavailable`） |
| 24（保留语义未归位） | 历史扫描脚本**只读**日志与会话台账，不新增保留策略 |

---

## 3. 现状盘点（代码级证据）

> 行号是当次摸排快照；每条结论都可由附录 B 的命令复现。**结论与需求文档的表述有几处偏差，以本节为准。**

### 3.1 R1 的真实形态：不是「审批另有一套配置」，而是「三方各取一处」

今天的工作目录解析链路已经收敛了一半，存在**三个取值点**：

```text
① env.workspace 能力（面向模型的环境自述）
     electron/capabilities/handlers/env.ts:198-219
     workDir = manager.getActiveWorkDir() || ctx.workDir      ← 优先「全局 active profile」

② 执行/审批（Core 循环内）
     electron/claudeStreamHandlers.ts:429  sessionWorkDir = deps.resolveWorkDirForSession(sessionId)   ← 回合起点解析一次
     electron/toolChatLoop.ts:457           workDir: sessionWorkDir
     electron/toolChatLoop.ts:1778          const workDir = resolveWorkDir ? resolveWorkDir() : initialWorkDir
                                            ← 桌面链路未注入 resolveWorkDir，故恒为回合起点值
     electron/toolChatLoop.ts:1970-1975     门控用同一个 workDir（此处已一致）

③ 文件写入自动放行
     electron/tools/writeFileAutoApproval.ts:60-66   resolveSafePathReal(args.workDir, rel)  ← 同一个 workDir
```

| 环节 | 今天读的是 | 与「会话绑定 profile」的关系 |
| --- | --- | --- |
| `env.workspace` 自述 | **全局 active profile**（`getActiveWorkDir()` 优先） | **可能不同**：会话绑定的是 profile A，而全局 active 是 profile B（另一端切换、另一窗口切换、IM 会话切换） |
| Shell 执行器 `cwd` | 回合起点解析的快照，且**未注入** `resolveWorkDir` | **可能过期**：回合内发生 workDir 切换后不跟随（需求 §5.1「切换后审批基准同步更新」当前不成立） |
| 文件类工具 / 写入自动放行 | 同上 | 同上 |
| 安全审批 `EnvFacts.workDir` | `electron/confirmation/toolCallGate.ts:302-306` 用门控入参 `args.workDir` | 与执行一致（这半边已是对的） |

**结论**：R1 的修复目标不是「让审批别再读另一份配置」，而是**把「会话工作目录」变成一个带 revision 的快照**，四处引用同一 revision，并让 `env.workspace` 不再走「全局 active」这条旁路。

### 3.2 R1–R8 逐条现状

| # | 现状（符号级证据） | 与需求描述的差异 |
| --- | --- | --- |
| R1 | 见 §3.1。`resolveWorkDirForSession`（`electron/workDirManager.ts:95`）与 `buildResolveWorkDirCallback`（`:125`）已存在；`AgentWorkspacePorts`（`src/shared/agent/invocation.ts:164-170`）已含 `workDir` / `workDirManager?` / `resolveWorkDir?` | 需求说「审批使用另一个基准」；实为**自述走全局 active、执行/审批走回合起点快照**，审批与执行同源但会过期 |
| R2 | `Decision` 已有 `ruleId`（`src/shared/confirmation/types.ts:147-158`）；`ConfirmOutcomeCause` 已是闭合枚举（`:266-279`）；`ShellPathVerdict.violations[]` 已带 `code` / `path` / `severity`（`electron/shell/shellPathAnalysis.ts`）；**但缺**「判定基准目录、解析后绝对路径、建议动作、拒绝分类（严格禁止 / 条件不足 / 越界）」四类字段 | 一致 |
| R3 | MCP 事实只有 `{ kind: 'mcp-tool', serverId, toolName }`（`src/shared/confirmation/types.ts:118`）；门控 MCP 分支 `facts.actionClass = annotationsSafe ? 'read' : 'write'`，summary 仅 `MCP server/tool`（`electron/confirmation/toolCallGate.ts:322-352`）；**入参（url / path / 参数摘要）未进入事实与 `ApprovalCluePack`**（`types.ts:225-243` 的 `url` / `command` / `targetPath` 对 MCP 工具不填） | 一致 |
| R4 | `settle()` 已是单一出口，成功分支为 `{ success: true, data }`（`electron/tools/runShellExecutor.ts:646-700`），`data.status` 由退出码推导；校验器 `validateToolExecutorResult`（`electron/tools/types.ts:120-186`）在 `success && status === 'failed'` 时**把结果改写成失败**并回 `SHELL_RESULT_CONTRACT_VIOLATION`；`notExecuted` / `notExecutedReason` 已是闭合枚举（`src/shared/domainTypes.ts:557-565`） | 需求描述的「成功被标记失败」在当前分支**大部分已修**；**残留**：① 校验器方向是「矛盾就判失败」，缺「`exitCode === 0` 不得失败」的正向不变量与内部告警；② 失败码笼统（`SHELL_*`），未落五类细分；③ 无历史事件流全量扫描 |
| R5 | `analyzeShellCommand` 两条解析失败分支直接 `verdict: 'deny'`，文案 `'命令语法解析失败，无法进行安全分析'`（`electron/shell/analyzeShellCommand.ts:54-80`）；`commandHasShellMetasyntax` 对管道 / 通配符 / 换行一律不可信任（`electron/shell/shellCommandParser.ts:9-25`） | 一致 |
| R6 | `GREP_SKIP_DIRS` 常量（`electron/tools/builtinExecutors.ts:127`）+ 无条件 `--glob '!**/${d}/**'`（`:919`）；walk 回退同样 `continue` 跳过（`:1177`）；`no_match` 返回固定 `No matches found`（`:1267-1268`，既有测试断言见 `electron/tools/ripgrepExecutorProcess.test.ts:40`）；工具说明未公开排除行为（`src/shared/builtinToolDefinitions.ts:75-77`） | 一致 |
| R7 | `validateGrepInput`（`electron/tools/builtinExecutors.ts:861-869`）用 `hasOwnProperty` 判定「字段是否出现」，与执行路径 `args.context != null && args.context > 0`（`:915`）不一致 —— 正是需求指出的「校验按出现判定、执行为宽容」 | 一致（文案在代码中已简化为 `context、multiline、show_line_number 仅适用于 content 模式`） |
| R8 | `list_directory` 三个失败分支共用同一文案：`resolveSafeReadPath` 抛错 → `路径超出工作目录范围`；`fs.stat` 失败与非目录 → `不是目录或无法访问: ${rel}`；`readdir` 失败 → 抛错或超时（`electron/tools/builtinExecutors.ts:420-445`） | 一致；补充：超时已单独有 `fileToolAbortResult(op, '目录读取超时')`，但 `stat` 失败（含 EACCES / ENOENT）与「不是目录」仍共用一句 |

---

## 4. 目标设计

### 4.1 R1：会话工作目录单一事实源

#### 4.1.1 数据形状（Utils 层，纯数据）

新增 `src/shared/agent/workspace.ts`：

```ts
/** 会话工作目录的唯一事实源：装配期解析一次，随调用携带，只读。 */
export interface WorkspaceSnapshot {
  /** 绑定的 profile id；source='active-fallback' 时为全局 active profile id */
  profileId: string
  /** 规范化后的根路径：path.resolve → realpath（尽力，取不到时用词法路径）→ 去尾分隔符 */
  rootPath: string
  /** 平台化比较键：win32 走小写 + 正斜杠，posix 原样（复用 electron/writeSafety/pathIdentity.ts 的口径） */
  key: string
  /** 基准来源，必须可解释（R2 的诊断要引用它） */
  source: 'session-binding' | 'active-fallback'
  sensitive: boolean
  /** 每次绑定变更 +1；「同一 revision 内四个消费点结论必须一致」由它表达 */
  revision: number
}

export function workspacePathKey(p: string, platform?: NodeJS.Platform): string
export function normalizeWorkspaceRoot(p: string): string
```

#### 4.1.2 解析位置（Runtime 装配期，唯一装配点）

- 复用并包装既有 `resolveWorkDirForSession`（`electron/workDirManager.ts:95`），新增 `resolveWorkspaceSnapshot(db, sessionId, workDirManager, fallbackWorkDir): WorkspaceSnapshot`；
- `AgentWorkspacePorts`（`src/shared/agent/invocation.ts:164`）改为：

```ts
export interface AgentWorkspacePorts {
  /** 装配期解析后的快照；回合内取用不重算 */
  snapshot(): WorkspaceSnapshot
  workDirManager?: unknown
  /** 保留给「运行期绑定变更」场景：返回新快照（revision 必须 +1） */
  refresh(): WorkspaceSnapshot
  userDataDir: string
}
```

- 桌面链路在 `electron/claudeStreamHandlers.ts:429` 处把 `sessionWorkDir: string` 升级为快照，并**必须注入** `refresh`（今天 `resolveWorkDir` 未注入是 R1 过期问题的直接原因）；
- butler（`electron/butler/butlerInvoker.ts:300-304`）继续用 `buildResolveWorkDirCallback`，由它产出初始快照与 `refresh`；
- **不新增读库点**：解析需要读会话与 profile，因此放在装配期；Core 内只读快照（对齐偏差 2 / 3 的方向）。

#### 4.1.3 冻结语义（对齐 §5.4「发起时解析、调用内冻结」）

> **调用内冻结、调用间跟随**：一次工具调用的四个消费点读同一 `revision`；绑定在工作目录中途变更时，**只有下一次工具调用**能看到新 revision，并且变更必须落审计（`workspace.rebound`）。

这条同时满足需求的「切换后审批基准同步更新」与架构的「调用内冻结」纪律：同步发生在调用边界，不在一次判定中途。

**`refresh()` 的调用时机与成本（评审 B2 修正：原 O7 为「回合边界 + 绑定变更事件」，与本节的「下一次工具调用」自相矛盾，现统一为调用边界）**：

- **调用时机**：`toolChatLoop` 在**每次工具调用边界**调用 `refresh()`（替换现场 `resolveWorkDir ? resolveWorkDir() : initialWorkDir` 的取值方式）。不采用「回合边界 + 事件」的弱化方案，原因有二：① 它会让回合中途的绑定切换在**本回合全部后续工具调用**上继续使用旧目录，与本节承诺及需求 §5.1「审批基准同步更新」的验收冲突；② 它所依赖的「绑定变更事件」通路**今天并不存在**（`workDirManager` 无任何变更通知机制），引入它等于新建机制，不该藏在 R1 里顺手做。
- **内部实现**：① 重新解析绑定（复用既有 `resolveWorkDirForSession` 路径）；② 比较 `workspacePathKey` 与当前快照 —— **未变 → 返回原快照对象**（revision 不变、不落审计）；**变了 → 新快照 + `revision + 1` + 审计 `workspace.rebound`**。
- **成本（回应 O7 原本的顾虑）**：这次重解析是**两次配置读**，而且 **butler 链路今天已在每次工具调用做同样的事**（`electron/butler/butlerInvoker.ts:302-304` 注入 `resolveWorkDir`，`electron/toolChatLoop.ts:1778` 每次工具调用即调用它）。本方案把它统一成四条链路共用的形态 —— 桌面链路由「整回合冻结在起点」变为「调用间跟随」，**这是 R1 要修的正确性，不是新增开销**；相对一次模型往返（数百毫秒起），两次配置读可忽略。
- **可选后置优化（不改变本节语义）**：若日后压测显示确有影响，可在同一形态下加 `bindingEpoch` 计数器 —— 在 `electron/workDirManager.ts` 的两个底层写入口（`writeProfiles` / `writeActiveId`）与 `bindSessionWorkDir` 的 `updateSession` 处递增，`refresh()` 先比 epoch、未变则不做重解析（O(1)）。此优化**不进本轮范围**，列出仅为让后续实现者不必重新发现这些写入点。

#### 4.1.4 四个消费点改为同源

| 消费点 | 改法 |
| --- | --- |
| `env.workspace` 能力（`electron/capabilities/handlers/env.ts:189-219`） | `workDir` 取 `snapshot.rootPath`；**删除** `manager.getActiveWorkDir()` 优先分支；返回体加 `source`、`revision`、`profileId`；`profiles[].isBound` 按 `snapshot.profileId` 判定 |
| 文件类工具（`read_file` / `edit_file` / `write_file` / `list_directory` / `grep`） | `ToolExecutionContext.workDir` 由 `snapshot.rootPath` 填充（字段名不变，来源唯一化） |
| `run_shell` 执行器 | `planShellExec(command, cwd=snapshot.rootPath, spec)` 不变，只改入参来源 |
| 安全审批 `EnvFacts`（`electron/confirmation/toolCallGate.ts:302-306`） | `EnvFacts.workDir` 由快照注入；门控入参 `workDir` 换成 `workspace: WorkspaceSnapshot`（保留 `workDir: string` 过渡一版；两者不一致时**以快照为准并落审计**，见 §4.1.5 —— **不做 fail-loud 抛错**） |

#### 4.1.5 一致性护栏（需求 §5.2 要求）

```ts
/** 开发态断言 + 单测共用：四个消费点在同一 revision 内必须得到同一结论 */
export function assertWorkspaceBasisConsistent(input: {
  snapshot: WorkspaceSnapshot
  consumers: Array<{ name: 'env' | 'file' | 'shell' | 'safety'; workDir: string }>
}): { ok: true } | { ok: false; mismatches: Array<{ name: string; workDir: string }> }
```

- **任何模式**：不一致时**一律以快照为准**（安全侧优先）并写审计 `workspace.basis-mismatch` —— **不抛错**。理由（评审 P2-3）：把「基准分歧」升级成「整次工具调用失败」，恰恰是 R4 要消灭的不稳定语义 —— 分歧本身是内部实现缺陷，不该由调用方承担失败。
- **开发态额外**：同进程内加一条**断言**（`if (!ok) throw`），让回归在开发期立刻暴露。该断言只在开发构建启用，**不得进入生产路径**。

#### 4.1.6 验收要点（对应需求 §5.1 前三条）

工作目录根自身 / 根下新建目录 / 根下隐藏目录 / 同一目标的相对与绝对写法 / 含符号链接的路径 —— 五种边界下四个消费点结论一致；会话切换 profile 后**下一次**工具调用即生效，且 `env.workspace.revision` 与审批审计里的 `revision` 相等。

---

### 4.2 R2：拒绝与失败的结构化诊断

#### 4.2.1 诊断契约（Safety 产出、Core 回传、Driver 渲染）

新增 `src/shared/confirmation/diagnostics.ts`：

```ts
export type DenyClass = 'forbidden' | 'insufficient-info' | 'out-of-bounds'

export interface SafetyDiagnostics {
  /** 命中规则：policy rule id 或 shell validator id（两者同字段，避免两套口径） */
  ruleId: string
  ruleSource: 'builtin' | 'package' | 'user-override' | 'migration'
  denyClass: DenyClass
  /** 判定基准：working directory 快照（R1）+ 敏感路径集合的来源 */
  basis: {
    kind: 'workdir'
    workDir: string
    profileId: string
    revision: number
    source: WorkspaceSnapshot['source']
  }
  /** 解析后的目标（可多个：一条命令里的多个字面量） */
  targets: Array<{ raw: string; resolved: string; zone: PathZone }>
  /** 阈值 / 约束（超长、超量、超预算时） */
  threshold?: { name: string; value: string | number; limit: string | number }
  /** 建议动作：可枚举、可被模型直接执行 */
  suggestions: Array<{
    action: 'provide-path' | 'provide-purpose' | 'narrow-scope' | 'use-trusted-route' | 'ask-user'
    params?: Record<string, string>
  }>
  /** 规则拒绝一律落既有 `'rules-violated'`（评审 P2-2：不再引入与既有枚举重叠的第三套口径） */
  cause: ConfirmOutcomeCause
  /** 主进程只给键 + 参数（§2.4 规则 1） */
  messageKey: string
  messageParams: Record<string, string | number>
}
```

**三类拒绝的判定规则**（写进策略层，不靠文案区分）：

| denyClass | 何时 | 文案要点 | 重试路径 |
| --- | --- | --- | --- |
| `forbidden` | 无条件不允许的代码路径（提权、磁盘级破坏、locked 底线规则） | 说明「无论怎样都不允许」 | 无（不得引导绕行） |
| `insufficient-info` | 需补信息才能判（用途不明、目标不明、载荷不全） | 说明缺什么 | **补入参或说明即可通过**（需求验收项） |
| `out-of-bounds` | 目标超出基准范围 | **必须写出基准目录** | 改用基准内路径，或走受信通道 |

#### 4.2.2 产出点

1. **路径事实**：`pathClassifier.classifyPathWithSymlink` 已产 `zone`；`shellPathAnalysis.verifyPathsInWorkDir` 已产 `violations[].code` / `path` → 直接映射为 `targets`，无需重算；
2. **规则事实**：`Decision.deny.ruleId`（`types.ts:158`）→ `ruleId`；`ruleSource` 取装配期已存在的 `PolicyRule` 来源标注（`gatePolicy.policyOrigins`，`electron/toolChatLoop.ts:585`）；
3. **拒绝分类**：由规则内容决定 —— 规则表新增 `denyClass` 声明字段（属**策略内容**，放 `src/shared/policy/defaultRules.ts`），**全量标注**（O4 定案：现网 32 条规则中，25 条会产出 `ask` / `deny` / `confirm-every-time`，**这 25 条逐条标注**；7 条纯放行类不标，因它们不产生拒绝）。**遗漏兜底**：未标注或将来新增规则未标时，**缺省按 `forbidden`** 处理（宁可保守表述，也不误导模型去重试）。
4. **汇总出口**：`evaluateToolCallGate` 的返回体新增 `diagnostics?: SafetyDiagnostics`，与 `decision` **成对出现**（deny / timeout / unavailable 三类都必须有）。

#### 4.2.3 文案与审计

- 文案：`messageKey` 形如 `deny.outOfBounds.workdir`，参数含 `basisWorkDir` / `targetResolved` / `ruleId`；渲染端从 `src/renderer/i18n/resources/{zh-CN,en-US}/` 取真源；tool_result 面向模型的部分附**结构化摘要**（JSON 摘要，而非长文案），使模型可自纠。
- 审计：`confirm.outcome` 与 `policy.decision` 事件增加 `denyClass` / `ruleId` / `ruleSource` / `basis`（含 `revision`）/ `targetZone` 字段；**路径值经 `sanitizeAgentText` 净化**（主目录折叠），且不写主目录下凭据目录的展开结果（需求 §R2 硬要求）。
- 未执行原因：拒绝走 `notExecutedReasonForConfirmation`（`electron/toolChatLoop.ts:657`）时，`policy_denied` 之外补 `denyClass` 维度，保证「条件不足」与「严格禁止」在统计上可分。

---

### 4.3 R3：外部（MCP）工具审批载荷完整性

#### 4.3.1 事实信号补入参

`FactSignal`（`src/shared/confirmation/types.ts:100-123`）新增：

```ts
| {
    kind: 'mcp-invocation'
    serverId: string
    toolName: string                 // 原始名（信任键用）
    actionClass: ActionClass         // 与 facts.actionClass 同值，便于规则按信号匹配
    /** 目标：url 优先，其次 path（与 url/path 语义一致，不做字符串拼接） */
    targetUrl?: string
    targetPath?: string
    method?: string                  // 可判定时（http 类 MCP 工具）
    /** 参数摘要：键名清单 + 归一摘要（超长截断并标注） */
    argNames: string[]
    argsDigest: string
    argsTruncated: boolean
    /** 分类依据，审计可追溯（见 4.3.2） */
    classificationBasis: 'annotations-readonly' | 'schema-heuristic' | 'default-write'
  }
```

- 提取来源：门控入参 `toolInput`（执行器与门控拿到的是同一份 `inputObj`，`electron/toolChatLoop.ts:1784`），因此**零新增读取**；
- 截断：`argsDigest` 上限（建议 512 字符）与 `argNames` 上限（建议 20 项）走常量，超限置 `argsTruncated: true`；
- 脱敏：摘要经 `sanitizeAgentText`，secret 类键（`token` / `key` / `authorization`）只留键名不留值。

#### 4.3.2 类别映射修正（只修事实，不改宽严）

| 情况 | 今天 | 目标 |
| --- | --- | --- |
| server 声明 `readOnlyHint === true && destructiveHint !== true` | `actionClass = 'read'` | 不变（`classificationBasis: 'annotations-readonly'`） |
| 无注解，但 `inputSchema` 显示无副作用（无 write 类字段、method 为 GET） | `actionClass = 'write'`（推高风险） | 仍按 `write` 兜底**但标注** `schema-heuristic`，并在事实 `summary` 里写明「依据：schema 无写声明」；规则层可据此选择 ask 而非 deny |
| 其余 | `'write'` | 不变（`default-write`） |

**边界**：本项**只影响「写/读」分类与摘要**，不改变任何 ask / deny 结果；需求 §4「整体松紧不变」由此保证。

#### 4.3.3 载荷完整性校验

新增 `assertApprovalPayloadComplete()`（放 `electron/confirmation/extractors/`）：

```ts
/** 工具声明「审批可见输入」的必需字段（§5.2 前半区：工具契约） */
export interface ApprovalVisibleInputDecl {
  required: string[]                      // 例：['url'] / ['path'] / ['command']
  optional?: string[]
}
export function assertApprovalPayloadComplete(
  decl: ApprovalVisibleInputDecl | undefined,
  toolInput: Record<string, unknown>
): { ok: true } | { ok: false; missing: string[] }
```

- 声明来源：内置工具走既有 descriptor（`getBuiltinToolMetadata`）；MCP 工具由 **server 的 `inputSchema.required`** 推导（可用时），声明为空表示「本工具无安全相关性」，必须与「忘了声明」可区分（对齐 §5.2 硬要求）；
- 不完整时：产 `{ kind: 'payload-incomplete', toolName, missing }` 信号 + 审计 `confirm.payload-incomplete`；
- **表述纪律**：载荷不完整只能报「载荷构造不完整（缺字段 X）」，**禁止**表述为「调用参数缺失 / 未给出 URL」（需求 §R3 第 4 点根因）。

#### 4.3.4 线索包与审批 Agent

`ApprovalCluePack`（`types.ts:225-243`）对 MCP 工具填写 `url` / `targetPath` / `command`（三选一，按信号）+ `signals` 增加 `mcp-invocation` 标签；`factSources`（`:139-141`）标注该项来自 `tool-contract`（工具声明）还是 `host-environment`（宿主事实），保持「审批看到的是两半的并集，且标注来源」的既有语义。

**验收对齐**：只读、指向白名单内公开地址的抓取类调用，不再出现「参数缺失」拒绝；确需拒绝时理由必须指向真实规则（`ruleId` + `denyClass`）。

---

### 4.4 R4：结果信封的单一出口与不变量

#### 4.4.1 契约（`packages/agent-core/src/toolResultContract.ts`）

```ts
/** 五类细分失败码（闭合枚举，拒绝插件扩展） */
export type ToolErrorCode =
  | 'TOOL_EXEC_FAILED'          // 执行了但失败：非零退出码 / 进程被杀（有事实依据）
  | 'TOOL_EXECUTOR_ERROR'       // 执行器自身异常（spawn 失败、内部抛出、文件系统意外）
  | 'POLICY_NOT_EXECUTED'       // 被安全 / 授权 / 预算拦下（未执行）
  | 'TOOL_USER_CANCELLED'       // 用户取消 / 超时前的主动中断
  | 'TOOL_INVALID_INPUT'        // 参数非法（校验层拒绝，未执行）

export interface ToolResultEnvelope {
  success: boolean
  error?: ToolErrorCode
  userMessageKey?: string
  userMessageParams?: Record<string, string | number>
  notExecuted?: true
  notExecutedReason?: NotExecutedReason
  data?: unknown
}
```

#### 4.4.2 不变量（可执行断言，对齐需求 §R4 验收）

| ID | 不变量 |
| --- | --- |
| I1 | `success === true ⇒ error == null && notExecuted !== true` |
| I2 | `data.exitCode === 0 && data.terminationReason === 'process_exit' && !aborted ⇒ success === true`（**不得标记失败**） |
| I3 | `notExecuted === true ⇒ success === false && notExecutedReason != null`，且 `notExecutedReason` ∈ 既有闭合枚举（`src/shared/domainTypes.ts:561-565`） |
| I4 | `aborted === true \|\| timedOut === true \|\| exitCode !== 0 ⇒ success === false` |
| I5 | `error` 若存在必须 ∈ `ToolErrorCode`（今天 `run_shell` 用 `SHELL_*` 码；**映射表长期保留**，见附录 A.1 说明） |

`runShellExecutor` 现状已满足 I1（`settle` 成功分支不带 error，`electron/tools/runShellExecutor.ts:646-700`），本项的价值在**把既有正确做法变成契约**，并修掉校验器方向。

#### 4.4.3 校验器语义修正（今天的真问题）

`validateToolExecutorResult`（`electron/tools/types.ts:120-186`）今天做两件事：结构校验 + **矛盾时把结果改写成失败**（`SHELL_RESULT_CONTRACT_VIOLATION` + `status: 'result_invalid'`）。风险有两条：

1. **方向反了**：`exitCode === 0` 的成功结果一旦触发矛盾，会被压成失败（正是 R4 要消灭的现象）；
2. **静默**：改写不留告警，审计上无法统计契约违规。

改为：

```ts
export function normalizeToolResultEnvelope(
  raw: unknown,
  facts: { exitCode?: number | null; terminationReason?: string; aborted?: boolean }
): { envelope: ToolResultEnvelope; violations: string[] }
```

- **事实优先归一**：`success` 由 `exitCode` / `terminationReason` / `aborted` 推导（I2 / I4），不由 `error` 字段存在性推导；
- **`facts` 的取源（评审 P2-4，必须写死）**：`exitCode` / `terminationReason` / `aborted` **一律取自同一信封的 `data`**（`data.exitCode` / `data.terminationReason` / `data.status`），与 `settle()` 第一参与 `data` 内字段的对应关系见 `electron/tools/runShellExecutor.ts:640-700`；**不得从别处取**（进程回调、外部状态、调用方传入），否则「归一依据」与「事实」会分叉，出现第二份副本；
- **I2 的保护范围要说清**：`output_limit` / `timeout` / `user_cancel` 三个分支的 `terminationReason` **不是 `'process_exit'`**，因此**不受 I2 保护** —— 即使 `exitCode === 0`（输出超限时可能如此）也不得被归一为成功。这正是 I2 条件里必须同时校验 `terminationReason === 'process_exit'` 的原因；
- 结构损坏（无 `success` 布尔）时返回 `TOOL_EXECUTOR_ERROR` + `violations`，并**同时**写 `agentLogger` 事件 `tool.result.contract-violation`（新事件名，须入 `electron/agentLogger/types.ts` 闭合联合与字段白名单）+ `ctx.recordDiagnostic`；
- 违规计数进 `toolChatLoop` 的 usage / 诊断统计，作为 CI 与本地方案回归的门槛指标。

#### 4.4.4 历史事件流全量扫描（需求 §5.2）

新增 `scripts/scan-tool-result-invariants.mjs`：

- 输入：`logs/*.jsonl`（开发态）与 `{workDir}/.agent/logs/**`（打包态），必要时再扫 `sessions/` 的会话台账 JSONL；
- 输出：`docs/develop/tool-result-invariants-scan-report.md`（矛盾组合清单：`sessionId` / `toolUseId` / 字段快照 / 命中不变量 ID）+ 退出码（有矛盾 → 非 0）；
- npm 脚本：`check:tool-result-invariants`；与 `test:electron` 并列进 CI，**修复后矛盾数必须为 0**（历史数据保留但需标注）。

#### 4.4.5 界面一致性

渲染端展示的成功 / 失败态只用两个来源：`success` 与 `data.status`；**禁止**用「`error` 字段是否存在」推导失败态（今天可能存在的第二推导路径要在实现时全量清理，落一条 grep 护栏断言）。

---

### 4.5 R5：解析失败降级为确认（新增 `unsupported` 一态）

#### 4.5.1 结论定义（把「无法分析」与「危险」解耦）

`ShellSecurityVerdict`（`electron/shell/shellTypes.ts:3`）**保持既有三值 `'allow' | 'ask' | 'deny'` 不变，只新增一个值 `'unsupported'`**（评审 B1：`allow → safe` / `deny → danger` 是纯改名、零收益，却波及 10+ 个消费文件 —— 已撤回）。新值**刻意不叫 `unparsable`**：该词已被审批侧「审批 Agent 输出无法解析」占用，而两者处置相反（一个交审批判定、一个保持 deny），同名会在审计与指标上直接混淆（见 §4.5.4 第 6 条）。

```ts
export type ShellSecurityVerdict =
  | 'allow'          // 既有：已分析且安全
  | 'ask'            // 既有：可分析但需确认（含 denyType='weak' 的弱升格 —— 判定仍留在分析层，不上移）
  | 'deny'           // 既有：已分析且危险
  | 'unsupported'    // 【唯一新增】无法分析：结构不受当前解析器支持
```

**子原因用独立字段承载，不扩枚举**：新增 `unsupportedStructures?: string[]`（如 `['conditional-block','pipe-to-format']`）与 `unsupportedReason?: 'structure' | 'too-many-segments'` —— 这样「段数过多」不必再占一个枚举值（评审 B1：枚举只加一个）。

映射到 Safety 门控（`electron/confirmation/toolCallGate.ts` 消费 shell 事实处）—— **`unsupported` 走普通 `ask`，门控层不加任何特例**：

| shell 结论 | 门控结论 | 回答者 | 审计 |
| --- | --- | --- | --- |
| `allow` | 既有（不变） | — | 既有 |
| `ask` | 既有 require-confirm（**不变** —— 现状 `ask` 即分析层结论，含弱升格，本方案不上移该判定） | 按 lane | 既有 |
| `deny` | 既有 deny（不变） | — | `rules-violated`（既有） |
| `unsupported`（新增） | **既有 require-confirm**（按既有规则走，`actionClass='execute'` → `default-write-execute-ask`；**该 ID 是引擎内置兜底，见 `policyEngine.ts:288-302` 的未命中分支，不在 `defaultRules.ts` 规则表内**） | **按 lane 派生**（desktop standard 档 → `auto-evaluator` → 审批 Agent；审批判定不了再回退人工，见 §4.5.3）。**automation 是例外**：由新增的 lane 限定 deny 规则收敛为**拒绝**（O9，见 §4.5.3 末） | `policy.decision`（既有结构） |
| 未知取值（防御） | **deny（fail-closed）** | — | `rules-violated` |

**关键设计（v1.5 修订，评审确认的方案 B）**：R5 **在门控层零特例** —— 它只把 shell 结论从 `deny` 改成 `unsupported`，后者照常进入引擎（`actionClass='execute'` → 命中既有 `default-write-execute-ask`）。于是 desktop / IM / 其他链路的语义**自动**正确，无需 lane 分支：

| lane / 档位 | 自动结果 |
| --- | --- |
| desktop standard | `ask → auto-evaluator` → **审批 Agent 先判**；它判不了才回退人工（§4.5.3） |
| desktop strict / loose / custom | 按对应档位生效（`ask` 仍按既有规则，本方案不动档位语义） |
| wechat / feishu | 按既有 IM 结论（含「远程只读」策略）；有回执则确认 |
| **automation** | **不由「既有 catch-all 收敛为拒绝」** —— 该 catch-all 会把回答者派生为审批 Agent（`askAnswererFor('automation') === 'agent'`），真实咨询并**可能放行**。R5 为它**新增一条 lane 限定的 locked `deny` 规则** → **拒绝**（O9，机制见 §4.5.3 末） |

**因此 R5 的实质改动不在门控、也不在"给 shell 开后门"，而是两处**：① shell 侧把「解析失败」从 `deny` 改为可区分的 `unsupported`（§4.5.2）；② **审批侧新增「判定不了」这一态**（§4.5.3）—— 后者才是让降级真正成立的支点。

#### 4.5.2 改动点（shell 侧）

1. `electron/shell/analyzeShellCommand.ts:54-80` 两处解析失败分支：`verdict: 'deny'` → `verdict: 'unsupported'`；保留 `warnings`，并补 `unsupportedStructures` / `unsupportedReason`（§4.5.1）。段数超限（`parseShellSegments`，`shellCommandParser.ts:15`）**同样走 `'unsupported'`**，子原因 `'too-many-segments'` —— 不新增第二个枚举值。
2. **消费点逐条审计（评审 B1 的连带项，必须做且必须配断言）**：新增枚举值后，凡把「非 `deny`」当作可信 / 可放行的判定都必须**显式排除 `unsupported`**。已核实至少三处：
   - `electron/shell/shellCommandTrust.ts:93`（`canShowShellTrustOption`）与 `:111`（`shouldSkipShellConfirmForTrust`）—— **漏排的后果最严重：一条无法分析的命令会变成可加入信任列表，此后被静默跳过确认**；
   - `electron/shell/shellToolLoopHelpers.ts:41`（预检的 deny 短路）；
   - `electron/shell/analyzeShellCommand.ts:318`。
   实现要求：① 保留 `shellSecurityHints.requiresRiskAck = true`（既表达「需确认」，又顺带关闭既有信任选项闸门），但**不得只依赖它**，逐条显式排除；② 补回归断言「`unsupported` 的命令不出现在信任选项中、不可被持久化」。
3. **门控侧**：`electron/shell/shellToolLoopHelpers.ts`（`precheckRunShellTool`）对 `unsupported` 不再产出 `shellPrecheckDeny`，改为把该事实随 analysis 下传；`electron/confirmation/toolCallGate.ts` 照常走 facts 提取 → 引擎（**不加特例、不加专用规则**）。门控映射表加 default → **未知取值 fail-closed**。
4. **事实要可区分（供审批与观测用）**：`unsupported` 时 facts 产一个独立信号（如 `{ kind: 'shell-unsupported-structure', structures: [...] }`），`actionClass='execute'`、`baseRiskLevel` 沿用既有；
   **注意（v1.9 修正）**：该信号**对 desktop 不派发任何专用规则** —— 引擎按 `default-write-execute-ask` 走，才可能被 desktop standard 档变换为 `auto-evaluator` 而进入审批（§4.5.1 关键设计）。若为 desktop 写一条 `locked` 规则反而会**挡住审批**，与方案 B 相悖。
   **但对 automation 必须派发一条 lane 限定的 locked `deny` 规则**（O9）—— 两者不矛盾：该规则的 `match.lane` 只含 `automation`，desktop 不受影响。**这条规则是安全决策，不是 shell 特性**：它表达的是「**事实链断裂 + 无人值守 → fail-closed**」，与 desktop「判不了 → 转人工」是同一条原则的两面（见 §4.5.3 末）。
5. **文案分开**（**不得共用同一句**，需求 §R5 硬要求）：
   - `shell.unsupportedStructure`（键 + 参数：`shell` / `structures`）—— 明确「结构不受支持」；
   - `shell.deniedByRule`（键 + 参数：`ruleId`）—— 明确「命中危险规则，不可执行」。
6. **观测两个独立指标**（不得混算，口径纪律同 `docs/develop/desktop-fail-open-to-user-plan.md` §5.4）：
   - **解析失败率** = `policy.decision` 中命中 `shell-unsupported-structure` 信号的计数 ÷ `run_shell` 预检总数 —— 衡量解析器覆盖度；
   - **判定不了率** = `confirm.outcome.cause='agent-undetermined'` 计数 ÷ `actor='agent'` 的 `confirm.outcome` 总数（§4.5.3）—— 衡量审批能力边界与「判不了是否被滥用」。
   **不得**用 `confirm.outcome.cause='unparsable'` 统计本项（该 cause 专属「审批输出无法解析」，处置相反）。

#### 4.5.3 审批侧新增「判定不了」态（方案 B 的支点）

**为什么必须有它**：`ApprovalVerdict` 今天只有两态 —— `src/shared/confirmation/types.ts:206-219` 的注释明写「**只有两态，无中间态**」，Skill 输出合同（`electron/skills/bundled/securityApprovalSkill.ts:136-139`）同样写「**只有两种输出，没有第三种**」。因此审批 Agent 面对「结构不支持」**只能输出 `deny`**；而 `desktop-fail-open-to-user-plan.md` §4.3 明令 **`agent-deny` 永不回退**。结果：「解析器读不懂」在审批层**进得去、出不来** —— R5 即使把 shell 结论改成 `unsupported`，命令仍会走到 `agent-deny` 被拒，降级**静默失效**。

**改法（六处，按数据流顺序）**：

| # | 位置 | 改动 |
| --- | --- | --- |
| 1 | `electron/skills/bundled/securityApprovalSkill.ts` | 输出合同加第三态 `{"kind":"undetermined","reason":{"summary":"<缺什么证据 / 为什么判不了>"}}`；并加**使用约束**（见下「滥用防线」） |
| 2 | `src/shared/confirmation/types.ts` | `ApprovalVerdict` 加 `{ kind: 'undetermined'; reason: ApprovalReason }`；**同步更新 `:206` 的「只有两态」注释** |
| 3 | `electron/confirmation/approvalAgent.ts` | `parseApprovalVerdict` 支持解析该态（沿用现有「取最后一个合法裁决」与非对称容错策略） |
| 4 | `src/shared/confirmation/types.ts` | `ConfirmOutcomeCause` 加 `'agent-undetermined'` —— 与 `agent-deny` 并列的**有效裁决**，不是失败 |
| 5 | `electron/confirmation/agentChannel.ts:304-323` | 由两分支三元表达式展开为三分支：`approve → agent-approved` / `deny → agent-deny` / **`undetermined → agent-undetermined`**（缺此分支会落到 `agent-deny`，静默退化为原行为） |
| **6** | `electron/toolChatLoop.ts:657-687`（`notExecutedReasonForConfirmation`） | **补 `case 'agent-undetermined'`**（评审 N2）：该 switch 现无此分支 → 落 `default: 'user_rejected'`，会把「机器判不了导致的 fail-closed 拒绝」错记成**用户拒绝**，直接污染 §4.5.2 第 6 条的「判定不了率」与 §4.2.3 的 cause 不压平纪律。落法：`notExecutedReason` 枚举新增 **`'agent_undetermined'`**（不并入 `agent_denied` —— 统计口径明确要求可分；渲染端 i18n 补一条兜底文案，见附录 A.1） |

**关键区分：它是「有效裁决」，不是「失败」**：

| cause | 性质 | 能否回退 |
| --- | --- | --- |
| `unparsable` / `unavailable` / `timeout` / `config-error` | **没拿到裁决**（输出无法解析 / 服务不可用 / 超时 / 配置坏） | 按 `desktop-fail-open-to-user-plan.md` §4 矩阵（`unavailable` / `timeout` 可回退） |
| `agent-deny` | 拿到裁决：**拒绝** | **永不回退**（§4.3，一个字不动） |
| **`agent-undetermined`（新）** | 拿到裁决：**判不了** | **可回退**（本次新增） |

它与 `agent-deny` 的关系正是「**信息不足 vs 明确拒绝**」—— 与需求 §R2 的三分类（越界 / 条件不足 / 严格禁止）同构。**回退的是「判不了」，不是「判不准」。**

**回退白名单加一格（唯一需要改动既有判定的地方）**：

```ts
// electron/confirmation/fallbackToUser.ts
export const FALLBACK_ELIGIBLE_CAUSES = ['unavailable', 'timeout', 'agent-undetermined'] as const
```

**该文件四维判定的其余三维一个字不动**（`lane === 'desktop'`、`answererKind === 'agent'`、两条中止守卫）。**必须同步 `docs/develop/desktop-fail-open-to-user-plan.md`**：§4 失败去向矩阵加一行、§4.4 判据表加一格、§6.3 用例补一条 —— 那份文档是这条机制的权威定义处，不能只在本方案改。

**滥用防线（本方案新增的主要风险）**：加一态等于给审批 Agent 一个「逃生门」—— 它可能用「判不了」逃避判断，把本该自动处理或本该拒绝的调用推给人。四道约束：

1. **提示词硬约束**：`undetermined` 仅在**事实链确实不完整**时可用（命令 / 目标 / 影响面无法确定），且必须在 `reason.summary` 写明**缺什么证据**；**不得**用于「风险高但我不确定是否越界」这类情形（那属 `deny`）。
2. **不得覆盖绝对拒绝情形**：命中 Skill 的「绝对拒绝情形」节必须 `deny`，不得降级为 `undetermined`。
3. **必须观测**：判定不了率 = `agent-undetermined` ÷ `actor='agent'` 的 `confirm.outcome`（§4.5.2 第 6 条）—— 这是判断它是否被滥用的唯一依据。
4. **阈值后置**：本轮只落审计（口径同 `desktop-fail-open-to-user-plan.md` §8.4），有实测数据后再定阈值与告警。

**配套：automation 的收敛规则（O9 · 用户决策 —— 不接受无人链路放行）**

> **决策记录（用户决策，2026-09-25）**：**用户明确拍板：不接受无人值守链路由审批 Agent 放行 `unsupported` 命令**（即采纳「新增 lane 限定 deny 规则」这一方案）。
>
> 决策背景：评审 v1.5 的 N1 揭示了本文档此前的**错误断言** —— automation 的 catch-all 并非「无回答者 → 拒绝」，而是**真实咨询审批 Agent 且 approve 可放行**（`askAnswererFor('automation')` 恒返回 `'agent'`）。**用户是在知悉该事实、以及「接受放行 / 收敛为拒绝」两侧代价之后，选择收敛。** 因此本条不是实现细节，而是**产品安全决策**，实施时不得以「简化」为由绕过。

为什么需要单独一条规则（而不是靠既有规则自然收敛）：automation 的 catch-all（`automation-default-confirm`，`action: 'ask'`）会把回答者派生为**审批 Agent**（`askAnswererFor('automation')` 恒返回 `'agent'`），审批 **approve 即放行执行** —— 这是相对现状（解析失败 = 预检 deny 短路）的**真实行为放宽**，必须显式收敛：

```ts
// src/shared/policy/defaultRules.ts（automation 段，**必须排在 automation-default-confirm 之前**
// —— 引擎按规则数组顺序匹配，catch-all 会拦截）
{
  id: 'automation-unsupported-deny',
  when: 'invocation',
  match: { lane: ['automation'], signals: ['shell-unsupported-structure'] },
  action: 'deny',
  locked: true,
  denyClass: 'forbidden',
  reason: '该命令使用了当前解析器不支持的结构，且当前为无人值守链路：无法分析即不可执行'
}
```

**判据（与 desktop 同源）**：常规命令解析器已提供**结构化事实**，审批 Agent 在事实基础上判断，质量有保障；`unsupported` 意味着**事实链完全缺失**，审批退化为「读文本猜危险」，而 automation **无人类兜底** → 只能 fail-closed。desktop 有人的兜底（判不了 → 转人工），automation 没有，这是同一条原则的两面。

**这条规则是安全决策，不是 shell 特性**：它表达的规则是「**事实链断裂 + 无人值守 → fail-closed**」。同一原则下还有一处**既有不一致**（`extraction-failed` 在 automation 下今天仍走审批 Agent，因 catch-all 拦在前）—— 已单列为 **P-2 跟进项**（§9.1），**不在 R5 范围**（避免顺手改动既有行为）。

**备选方案（已被用户否决，记录在案）**：若改判为「接受无人链路放行」，需回改三处 —— ① 本条规则删除，改述为「catch-all → ask → 审批 Agent 代理判定（approve 可放行）」；② §4.5.1 表的 automation 例外说明；③ T-R5-2 断言改为「approve 为合法放行且审计可查；deny / undetermined 均收敛为拒绝」。**该备选已于 2026-09-25 被用户明确否决**（见本节决策记录）；保留记录是为了让后续读者知道「这条规则不是遗漏，而是有意的安全选择」。**无论选哪个，上面第 6 处（`notExecutedReason`）都必须做。**

#### 4.5.4 三条通过形态（验收口径）

`unsupported` 的命令有**三种合法结果**，三者都算「不因解析器盲区被阻断」：

| # | 审批结论 | 结果 | 用户感知 |
| --- | --- | --- | --- |
| ① | 判安全 | 直接执行 | 无感（**这正是方案 B 优于「一律转人工」的地方**） |
| ② | 判危险 | 拒绝（`agent-deny`，不回退） | 合理拒绝 |
| ③ | **判不了** | **人工确认**（本次新增的通路） | 弹卡，说明"结构不受支持" |

**只有**走到「被拒绝、且原因是"结构不支持"」才算失败。需求 §5.3 的验收据此表述（需求文档 **v1.2** 已同步修订；v1.1 为 R5 口径修订、v1.2 新增 §7 P-1 待立项）。

> **适用范围（v1.9 补）**：本表描述的是**有人值守链路**（desktop / IM）。**automation 是例外**：它不进入上表任一形态，而由 §4.5.3 末的 lane 限定 `deny` 规则直接拒绝（O9）—— 该拒绝**不算 R5 失败**，而是「事实链断裂 + 无人值守」的有意收敛。

#### 4.5.5 边界（必须写清，避免被当作放宽）

- **automation 的处理（v1.9 修正 —— 原表述有误；收敛决策为**用户决策**，见 §4.5.3 末）**：原稿写「automation 的回答者解析结果为 `deny`（不咨询审批 Agent），根本走不到 `undetermined`」——**与引擎实现不符，已撤回**。真实机制：`askAnswererFor('automation')` **恒返回 `'agent'`**（`src/shared/policy/policyEngine.ts:211-214`），且生产链路**无条件注入** `agentChannelFactory`（`electron/toolChatLoop.ts:2429`，并为 automation 专门设 `maxAuthorization: 'low'`，`:2462`）——即 automation 的 catch-all ask 会**真实咨询审批 Agent，approve 会放行执行**。误导来源是 `src/shared/policy/defaultRules.ts:301-302` 的一句**过时注释**（「RejectingChannel 使其实际效果为拒绝」，为回答者派生前（P3 收缩前）的表述），已在附录 E **B16** 列入修正项。
  → **因此 R5 显式加一条 lane 限定的 locked `deny` 规则**（**O9 用户决策**：不接受无人链路放行）：`automation` + `shell-unsupported-structure` 信号 → `deny`，理由「事实链断裂 + 无人值守 → fail-closed」。**放行与否的安全依据**：常规命令解析器已提供结构化事实，审批 Agent 在事实基础上判断质量有保障；`unsupported` 意味着**事实链完全缺失**，审批退化为「读文本猜危险」，而 automation 无人类兜底 —— 故只能拒绝（与 desktop「判不了 → 转人工」同源）。**这条规则必须排在 `automation-default-confirm` 之前**（引擎按规则数组顺序匹配，catch-all 会拦截）。
- **`agent-deny` 永不回退**（§4.3 一个字不动）：本方案只新增「判不了」一格，不碰「拒绝」；
- **判定顺序、fail-closed 兜底、缓存写入准入一律不动**（架构 §7.2 不可换的三件事）；
- **缓存：回退后的人工确认可写缓存，`undetermined` 本身不可写** —— 前者是真实人类确认（`desktop-fail-open-to-user-plan.md` §5.5），后者是机器结论，按 I3 不得进记忆；
- **信任列表不因降级而放宽**：`commandHasShellMetasyntax`（含管道 / 通配符 / 换行 / 变量）仍不可 persistable —— 这是「有意不信任」，与「解析失败」是两件事，文案也必须分开（§4.5.2 第 2 条另有强制排除）；
- **解析能力扩展是独立第二批**（条件块、管道到列目录/格式化命令、`;` 与 `&&`、变量拼接路径）：覆盖不到时**不得误判为危险**，落到 `unsupported` 即可。需求 §5.3 的 ≥5 条只读控制结构用例，验收目标是「**不因解析器盲区被拒**」（§4.5.4 三种形态皆可），不是「必须解析成功」、也不是「必须弹框」。

---

### 4.6 R6：文本搜索的范围透明

#### 4.6.1 默认忽略集（成员不变，语义归一）

今天 `GREP_SKIP_DIRS`（`electron/tools/builtinExecutors.ts:127`）是一份无类别常量，被无条件追加为 `--glob '!**/${d}/**'`（`:919`），且**无任何参数可解除**。本方案**不增不减成员**，只做两件事：① 更名为「默认忽略」，语义与 ripgrep 自身的 ignore 行为对齐；② 让每个成员都能被调用方的显式意图解除。

**一条总原则（本方案据此撤销早期设计）**：

> **默认忽略 ≠ 访问控制。** 默认忽略是**默认值** —— 必须能被调用方的显式意图解除（显式路径，或 `include_ignored: true`）。**任何不可解除的目标限制都是访问控制，属于 Safety** —— 按 §7.1：规则内容在 Core 外、随 Invocation 传入、有来源标注（`ruleSource`）与 `policy.decision` 审计，且判定发生在门控内（Core 内、不可绕）。**工具实现无权单方面宣布访问控制。**
>
> **这条判据纠正了本方案的一个早期错误**：曾把 `.git` / `.svn` 划为「安全类」并声明「永久排除、不受开关影响」。那样做的后果有三：① 让**一个工具实现**宣布了访问控制，不随调用传入、无来源标注、无策略审计；② 判定在门控**放行之后**才生效，Safety 全程看不见，等于绕开了「判定时机：Core 内、不可绕」；③ 制造「**只有 grep 遵守**」的规则 —— 今天 `read_file .git/config` 与 `run_shell cat .git/config` 都读得到，唯独 grep 读不到，这正是 R1 要消灭的「同一事实、各环节结论不一致」，只是换了个位置。

```ts
/**
 * 默认忽略目录（**只是默认值，不是访问控制**）：
 * 默认不搜索以免噪音与耗时；调用方显式指向其内部路径，或传 include_ignored: true，即可搜索。
 * 语义与 ripgrep 自身的 ignore 行为一致 —— 是「默认跳过」，不是「不允许访问」。
 */
export const GREP_DEFAULT_IGNORES: readonly string[] = [
  'node_modules', '.git', '.svn', '__pycache__', 'dist', 'dist-electron', '.cursor'
]
```

**逐项说明（按现网名单实证）**：现网 `GREP_SKIP_DIRS` 共 7 个成员，本次**全部归入同一份默认忽略清单、一律可解除** —— **解除方式统一为「显式点名其内部路径」**（命中隐藏目录时自动附 `--hidden`）；`include_ignored: true` 是「一并解除」的便捷开关，不是隐藏成员的必要条件（O8 定案后修正，机制见下「隐藏条目语义」）：

| 名单成员 | 实际是什么 | 默认忽略的理由（事实陈述，非安全结论） | 显式点名其内部路径时 |
| --- | --- | --- | --- |
| `node_modules` | 依赖安装目录 | 体量大、第三方内容噪音多 | **搜索**（需求 R6 原文场景：搜第三方包内的 `dist`） |
| `dist` | 构建产物目录 | 生成物，非源码 | **搜索**（需求 R6：「审阅构建产物」） |
| `dist-electron` | 构建产物目录 | 生成物，非源码 | **搜索** |
| `__pycache__` | Python 字节码缓存 | 二进制缓存，无文本收益 | **搜索** |
| `.cursor` | 编辑器缓存 | 工具缓存 | **搜索**（隐藏目录，点名即自动解除隐藏过滤） |
| `.git` | 版本库内部对象 | 内部对象多为压缩二进制，文本检索收益低 | **搜索**（同上；查历史内容建议改用 `git log -S` / `git grep`，见 §4.6.4） |
| `.svn` | 版本库内部对象 | 同上 | **搜索**（同上） |

**语义声明（O8 定案后修正）**：以上 7 项**统一为「默认忽略」，一律可解除、不引入任何访问控制** —— 解除方式是**显式点名**（含隐藏成员：点名即自动解除 rg 的隐藏过滤），`include_ignored: true` 则是「一并解除」的便捷开关（机制见下「隐藏条目语义」）。**R6 不引入任何访问控制**；`read_file` / `run_shell` 对同样目标的既有可访问性不由本方案改变。**唯一的行为收紧**是敏感路径（`.env` 等）在 grep 遍历中被排除 —— 这只影响「顺手搜到」，不构成访问控制（显式点名仍可搜），详见下「两者关系」。

> **修订记录（2026-09-25，评审确认回归纯工具行为）**：R6 **不引入任何访问控制** —— 7 个成员**统一为默认忽略、一律可解除**（显式点名即可；隐藏成员点名时自动解除 rg 的隐藏过滤，`include_ignored` 只是便捷开关），包括 `.git` / `.svn`。早期设计（同版本内已撤销）曾把这两个划为「安全类、永久排除、不受开关影响」，撤销理由见本节开头的总原则：那等于让工具实现单方面宣布访问控制，且制造「只有 grep 遵守」的规则。
>
> **若日后确需「Agent 不得读取版本库内部对象」**：那是一件**新政策**（今天是「`.git` 不可写」，见 `docs/requirement/confirmation-card-trust-requirement.md` C3；「不可读」是新语义），必须**走 Safety 且跨工具一致** —— 策略层升格为一类 zone（与 `customSensitivePrefixes` 同机制、可覆盖、有来源），路径分类器产事实（`path-target` + zone），策略规则决定 allow / ask / deny 并落 `policy.decision` 审计，`read_file` / `grep` / `run_shell` 路径分析全部消费同一 zone。**它不应挂在 R6 下**，见 §9 非目标第 4 条。

> **两者关系（O8 定案后更新）**：真正的凭据目录（`.ssh` / `.gnupg` / `.env` / `secrets`、`C:\Windows`、`~/Library`、`/etc`、`/System`、`userDataDir` 等）**不在**这份 grep 默认忽略名单里，它们由**另一套机制**判定 —— `getBuiltinSensitivePrefixes()` / `isSensitivePath()`（`electron/shell/shellSensitivePaths.ts:22`）。**O8 定案为「开隐藏、护敏感」后，grep 首次消费该机制**（因为一旦传 `--hidden`，就必须同时护住敏感点文件，否则等于工具层擅自放开读取面）。但**消费时的语义是「默认忽略」而非「访问控制」**（判据见 §2.3）：遍历时跳过、**显式点名该文件则搜索**。因此结论修正为：**同一份规则内容，在 grep 侧以「默认可解除」形态生效；它是否应在 `read_file` / `list_directory` 也一致生效，是另一个独立缺口**（见 §9.1 的 **P-1**，已同步登记进需求文档 §7）。

**隐藏条目语义（评审 B3 新增 —— 缺此定义，T-R6 的「可解除」断言在 rg 路径不可达）**

7 个成员里有 **3 个是隐藏目录**（`.git` / `.svn` / `.cursor`）。ripgrep **默认跳过隐藏条目**，且这与「名单排除」是**两套独立机制**：

| 机制 | rg 旗标 | 覆盖范围 |
| --- | --- | --- |
| ignore 规则（`.gitignore` 等） | `--no-ignore` | 受忽略规则约束的文件 |
| **隐藏条目（`.` 开头）** | `--hidden` | **全部点文件 / 点目录（含项目 `.env`）** |

因此「只做不追加名单 glob」**并不能让 `.git` 被搜到** —— rg 的隐藏过滤仍会跳过它；而一旦传 `--hidden`，曝光面就**远超 7 成员名单**（项目 `.env` 等点文件一并进入结果并回给模型）。§4.6.4 原稿「语义对齐 `--no-ignore`」据此修正为「对齐 `-uu` = `--no-ignore --hidden`」。

**`--hidden` 一开，同时打开两类性质不同的东西（这是 O8 的实质）** —— 不能混为一谈：

| 类别 | 成员 | `isSensitivePath` 怎么看 | 打开后的性质 |
| --- | --- | --- | --- |
| **版本库 / 缓存隐藏目录** | `.git` / `.svn` / `.cursor` | **不认为敏感**（只是噪音） | 可搜 —— 合理 |
| **敏感点文件 / 目录** | `.env`、`.env.*`、`secrets/`（规则见 `shellSensitivePaths.ts:60-61`） | **明确判定为敏感** | 打开即与产品既有声明冲突 |

**O8 定案：开隐藏、护敏感**（选项 3）—— 三形态 × 三类条目的完整语义表：

| 形态 | 非隐藏名单成员（`node_modules` / `dist` / `dist-electron` / `__pycache__`） | 隐藏名单成员（`.git` / `.svn` / `.cursor`）+ 普通隐藏条目（`.vscode/` 等） | **敏感点文件（`.env` / `.env.*` / `secrets/`）** |
| --- | --- | --- | --- |
| 默认（无 `path`、无开关） | 不搜（名单排除） | 不搜（rg 隐藏过滤；walk 侧**补对称规则**） | **不搜**（敏感路径排除；两引擎一致） |
| `path` 显式指向其内部（目录） | **搜**（解除名单排除） | **搜**（传 `--hidden`） | **不搜**（遍历仍跳过），返回范围提示 |
| **`path` 显式点名该敏感文件** | — | — | **搜**（尊重明确意图），返回体**明示「命中敏感路径」** |
| `include_ignored: true` | 搜 | **搜**（传 `--hidden`） | **仍不搜**，返回体明示（**批量开关不解除敏感路径**，见下） |

**为什么 `include_ignored` 不解除敏感路径，而显式点名解除**（对齐 §2.3 判据）：

| 调用形态 | 意图强度 | 应否解除敏感排除 |
| --- | --- | --- |
| `include_ignored: true` | **模糊**（「搜得广一点」） | **不解除** —— 否则一个批量开关会顺带把全部 `.env` 拉进上下文，等于「顺手读到密钥」 |
| `path: '.env.local'` | **明确**（「我要读这个文件」） | **解除** —— 尊重明确意图；且返回体明示，不静默 |

这与写入侧的既有口径一致：`read_file` / `write_file` 的敏感判定属「需确认」而非「硬拒绝」，本方案在 grep 侧取「默认可解除」形态，**既不新增硬限制、也不静默放行**。

**四条配套硬要求**：

1. **walk 回退补对称规则**：walk 今天只跳 `GREP_SKIP_DIRS`、**完全不跳隐藏条目**（`electron/tools/builtinExecutors.ts:1168-1181`）—— 即 `.env` 在 rg 不可用时**今天就能被搜到**，而 rg 路径搜不到。这是**既有的两引擎不一致**，本方案顺手修掉：walk 默认跳 `.` 开头条目 + **额外用 `isSensitivePath` 逐文件判定敏感路径**，否则 T-R6-5「回退不改变语义」无定义可依。**修的是 walk 的收紧，不是放宽。**
2. **两引擎的敏感排除必须同源**（关键实现约束）：rg 侧无法逐文件调用 `isSensitivePath`，只能用 `--glob` 模式近似 —— 因此需要**由同一份规则生成**敏感 glob 模式（如 `!**/.env`、`!**/.env.*`、`!**/secrets/**`），**不得在两个引擎里各写一份**（那会重演 R1 的「同一事实多份副本」）。建议新增 `grepSensitiveExcludes()`（放 `electron/tools/` 或与 `shellSensitivePaths` 同模块），两条路径共用。
3. **需求原文场景不受影响**：需求 R6 举的两个正当场景（搜第三方包内的 `dist`、搜依赖声明的版本要求）都落在 **`node_modules`（非隐藏）**，第二形态即可满足，**无需 `--hidden`**。
4. **明示义务**：任何因敏感路径被跳过的条目，都必须在返回体与 `searchScope` 中如实上报（不得表述为「无匹配」）—— 这是 R6 的核心承诺，对敏感条目同样适用。

#### 4.6.2 搜索范围事实

```ts
export interface GrepScope {
  root: string                                  // 实际搜索根（相对 workDir）
  engine: 'ripgrep' | 'walk'
  /** 被默认忽略清单跳过、且未命中调用方搜索范围的目录 —— 纯范围事实，不含安全语义。 */
  skipped: Array<{ name: string; explicit: boolean }>
  skippedCount: number
  truncated: boolean                            // head_limit / 超时截断
  limitReason?: 'head_limit' | 'timeout' | 'output_limit'
}
```

- `no_match` 输出改为**带范围的结论**：`No matches found (searched: <root>; skipped N directories: ...; skipped directories may contain matches)`；当 `skippedCount > 0` 时禁止只回一句 `No matches found`；
- 结果信封里同时给机器可读字段：`data.searchScope = GrepScope`，并把状态区分为 `status: 'no_match' | 'no_match_with_skips'`（不同取值，模型无需猜）；
- walk 回退（rg 不可用时，`:1174-1180`）同样统计并输出 `engine: 'walk'`。

#### 4.6.3 显式路径语义（需求核心）

**统一语义：默认忽略一律可被显式意图解除。** 不存在「点名也不给搜」的分支 —— 那是访问控制，归策略层（§4.6.1 总原则）。

| 调用形态 | 行为（完整语义含隐藏条目与敏感路径，见 §4.6.1 末两表） |
| --- | --- |
| 默认（无 `path`） | 应用默认忽略 + rg 隐藏过滤（walk 对称）+ **敏感路径排除**；`skipped` 全量上报 |
| `path` 或 `glob` 明确指向**非隐藏**成员内部（`node_modules` / `dist` / …） | **尊重调用方意图**：不追加该目录的忽略，正常搜索 |
| `path` 指向**隐藏**成员内部（`.git` / `.svn` / `.cursor`）或普通隐藏目录 | **尊重调用方意图**：不追加忽略，并传 `--hidden`，正常搜索 |
| **`path` 点名敏感文件**（`.env` / `.env.*` / `secrets/…`） | **搜索**（尊重明确意图），返回体**明示「命中敏感路径」** |
| 任意形态 + `include_ignored: true` | 解除默认忽略 + rg 隐藏过滤（含 `.git` / `.svn` / 普通点文件），语义对齐 ripgrep 的 `-uu`（`--no-ignore --hidden`）；**但敏感路径仍排除**（批量开关不解除，见 §4.6.1 意图强度表） |

> 三种形态都**不得**返回裸 `No matches found`：未解除时若确有跳过，必须回报范围（§4.6.2）；敏感路径被跳过同样计入 `skipped` 并标注原因。

#### 4.6.4 开关与说明

- 新参数 `include_ignored?: boolean`（默认 `false`）加入 `src/shared/builtinToolDefinitions.ts` 的 grep `input_schema` 与描述；语义写明「对齐 ripgrep 的 `-uu`：同时解除 ignore 规则**与隐藏条目过滤**（含 `.git` 等点目录）；**敏感文件（如 `.env`）仍不会被搜索**，如需搜索请直接指定该文件路径」；
- 工具描述中**公开两类排除及各自解除方式**（由常量生成，避免说明与实现两处漂移）—— **只列一份默认忽略清单、不做安全 / 性能分类**（该划分已撤销，§4.6.1 总原则）：
  - 「默认不搜索以下目录（依赖安装 / 构建产物 / 缓存 / 版本库内部对象）：`node_modules`、`.git`、`.svn`、`__pycache__`、`dist`、`dist-electron`、`.cursor`；**显式指定其内部路径即可搜索**（隐藏目录会自动解除隐藏过滤），或传 `include_ignored: true` 一并解除」；
  - 「**敏感文件 / 目录**（`.env`、`.env.*`、`secrets/`）在遍历中**始终排除**，`include_ignored: true` 也不解除；如需搜索请**直接指定该文件路径**，该方式会执行并在结果中标注」；
- **一条效率提示（不是安全通道）**：查版本库历史内容建议用 `run_shell` 的 `git log -S <pat>` / `git grep <pat>` / `git show` —— 因为 `.git` 内部多为压缩二进制，grep 即使搜到也基本是噪音。此提示属**工具说明**，不进 `suggestions`、不构成替代路径授权。
- 参数归一与校验走 §4.7 的单一入口。

#### 4.6.5 验收（需求 §5.3）

在排除目录内放置已知内容，分别以「默认搜索」「显式路径搜索」「`include_ignored: true`」三种方式搜索：断言三种语义、断言不存在「实际存在却返回无匹配」，且 `no_match` 一定伴随 `searchScope`。四组必测：① **非隐藏成员**（`node_modules` / `dist`）显式路径必须命中 —— 需求原文场景，且不依赖 `--hidden`；② **隐藏成员**（`.git`）默认不搜但返回范围提示，**显式路径命中**（自动解除隐藏过滤），`include_ignored` 下亦命中；③ **敏感文件**（`.env`）默认与 `include_ignored: true` **均不搜**（计入 `skipped` 并标注原因、不得表述为「无匹配」），**显式点名该文件则命中**且明示「命中敏感路径」；④ **两引擎同语义** —— 以上断言在 rg 与 walk 回退下都要过（含修掉「walk 原本能毫无阻碍地搜到 `.env`」这条既有不一致）。

---

### 4.7 R7：参数校验与执行路径同源

#### 4.7.1 单一入口

```ts
/** 唯一入口：产出「生效值」与校验结论；执行器与校验层都只用它 */
export function normalizeGrepArgs(input: Record<string, unknown>): {
  args: GrepExecArgs                 // 生效值（含默认值填充）
  effectful: string[]                // 真正产生效果的字段（用于错误文案）
  error?: { code: 'param-conflict'; field: string; mode: string; allowed: string }
}
```

- `validateGrepInput`（`electron/tools/builtinExecutors.ts:861`）改为 `normalizeGrepArgs` 的薄壳（或删除，保留兼容导出），**判定规则只有一份**；
- 执行器用 `args` 直接拼 rg 参数，不再各自读 `input.*`（今天 `:905-917` 读的是 `args`，请保持这个方向并让它成为唯一路径）。

#### 4.7.2 判定规则（按「生效值是否冲突」，不按「字段是否出现」）

| 组合 | 今天 | 目标 |
| --- | --- | --- |
| `output_mode: 'count'` + `context: 0` | 报错 | **通过**（`context = 0` 等价默认，无效果） |
| 非 content 模式 + `multiline: false` | 报错 | **通过**（等价默认） |
| 非 content 模式 + `show_line_number: true` | 报错 | **通过**（等价默认） |
| 非 content 模式 + `context > 0` | 报错 | 报错（有实际效果且冲突） |
| 非 content 模式 + `multiline: true` | 报错 | 报错 |
| 非 content 模式 + `show_line_number: false` | 报错 | **通过**（该模式下无效果；文案只在「有冲突」时出现） |

#### 4.7.3 错误文案

`grep.paramConflict`（键 + 参数：`conflictField` / `currentMode` / `allowedCombos` / `suggestedWrite`），例如「`context > 0` 仅在 `output_mode: 'content'` 下生效；当前为 `count`。可改为 `output_mode: 'content'`，或去掉 `context`」。

---

### 4.8 R8：目录列表错误分类

#### 4.8.1 分类模型

```ts
export type DirectoryErrorClass =
  | 'PATH_OUTSIDE_WORKDIR'   // 越界（复用既有路径安全结论）
  | 'PATH_NOT_FOUND'         // 不存在（ENOENT）
  | 'NOT_A_DIRECTORY'        // 指向文件（或非常规文件）
  | 'ACCESS_DENIED'          // EACCES / EPERM
  | 'READ_TIMEOUT'           // 用户取消 / 超时（可重试）
```

#### 4.8.2 落点

| 分支（`electron/tools/builtinExecutors.ts:420-445`） | 目标返回 |
| --- | --- |
| `resolveSafeReadPath` 抛错 | `{ success:false, error: ErrorCodes.FILE_PATH_TRAVERSAL, data:{ errorClass:'PATH_OUTSIDE_WORKDIR', path: rel } }` |
| `fs.stat` 抛 `ENOENT` | `error: ErrorCodes.FILE_NOT_FOUND`（已有码），`data.errorClass = 'PATH_NOT_FOUND'`，`suggestions: ['list-parent']` |
| `fs.stat` 抛 `EACCES` / `EPERM` | 新增码 `DIRECTORY_ACCESS_DENIED`，`errorClass = 'ACCESS_DENIED'` |
| `!st.isDirectory()` | `error: ErrorCodes.TARGET_NOT_DIRECTORY`（已有码），`errorClass = 'NOT_A_DIRECTORY'`，建议「改用 `read_file`」 |
| `readdir` 抛 `EACCES` / `EPERM` | 同 `ACCESS_DENIED` |
| 任一阶段命中 abort / 超时 | 新增码 `DIRECTORY_READ_TIMEOUT`，`errorClass = 'READ_TIMEOUT'`，`retryable: true` |

#### 4.8.3 文案与键

- 错误码 / 分类是机器可读字段（`data.errorClass` + `error`），文案由渲染端 `errorTranslator` 从 `src/renderer/i18n/resources/*/errors.json` 取（`FILE_NOT_FOUND` / `TARGET_NOT_DIRECTORY` 已有条目可复用）；
- 每条分类配**建议动作**（`suggestions`），至少覆盖：不存在 → 先列上级目录；不是目录 → 改用 `read_file`；无权限 → 换有权限路径；超时 → 可重试；
- **超时不得与其他错误共用文案**（需求 §R8 硬要求）。

---

### 4.9 本方案新增的公共设施（一次建、四处用）

| 设施 | 位置 | 谁用 |
| --- | --- | --- |
| `WorkspaceSnapshot` / `workspacePathKey` | `src/shared/agent/workspace.ts` + `electron/writeSafety/pathIdentity.ts` | R1、R2（诊断基准）、审计 |
| `SafetyDiagnostics` | `src/shared/confirmation/diagnostics.ts` | R2、R3、R5、R8（统一「键 + 参数 + 建议」） |
| `ToolResultEnvelope` / `ToolErrorCode` / 不变量 | `packages/agent-core/src/toolResultContract.ts` | R4、R5、R6、R8（所有失败都走同一出口） |
| `GrepScope` | `src/shared/grepScope.ts` | R6、R7 |
| `DirectoryErrorClass` | `src/shared/errorCodes.ts` 扩展 | R8 |

---

## 5. 改动清单（文件级）

### 5.1 R1 工作目录单源

| 文件 | 改动 | 层 |
| --- | --- | --- |
| `src/shared/agent/workspace.ts`（新） | `WorkspaceSnapshot`、`normalizeWorkspaceRoot`、`workspacePathKey`、`assertWorkspaceBasisConsistent` | Utils |
| `src/shared/agent/invocation.ts` | `AgentWorkspacePorts` 改为 `snapshot()` / `refresh()` | Core 协议 |
| `electron/workDirManager.ts` | 新增 `resolveWorkspaceSnapshot`（包装 `resolveWorkDirForSession`，产出 `revision`） | Runtime |
| `electron/runtime/invocationAssembler.ts` | `workspace` 端口装配改为快照 + `refresh` | Runtime |
| `electron/claudeStreamHandlers.ts` | 注入 `refresh`（不再只传 `workDir`） | Runtime |
| `electron/butler/butlerInvoker.ts` | 同上，统一产出快照 | Runtime |
| `electron/capabilities/handlers/env.ts` | 删除 `getActiveWorkDir()` 优先分支，改用快照 + 返回 `source` / `revision` | Core（能力） |
| `electron/toolChatLoop.ts` | 循环内 `workDir` 改为**调用边界 `refresh()`** 取值（替换 `resolveWorkDir ? … : initialWorkDir`，§4.1.3）；门控入参传快照；**全量清理 `initialWorkDir` 残留使用点**（如 `:3313` 的 `resourceKeys` 规划路径）并逐个分类 —— 执行期一律读快照，规划期须说明为何可接受 | Core |
| `electron/confirmation/toolCallGate.ts` | `EnvFacts.workDir` 由快照注入；入参兼容 `workDir` 字符串一版 | Safety |
| `electron/workDirManager.test.ts`、`electron/toolChatLoop.workdir.test.ts`、`electron/capabilities/*.test.ts` | 新增跨层一致性用例 | 测试 |

### 5.2 R2 诊断契约

| 文件 | 改动 |
| --- | --- |
| `src/shared/confirmation/diagnostics.ts`（新） | `SafetyDiagnostics`、`DenyClass` |
| `src/shared/confirmation/types.ts` | `Decision.deny` / `require-confirm` 结果携带 `diagnostics`；规则类型增 `denyClass` |
| `src/shared/policy/defaultRules.ts` | **全量标注** `denyClass`（O4 定案）—— 25 条会产 `ask` / `deny` / `confirm-every-time` 的规则逐条标（7 条纯放行类不标）；遗漏兜底 `forbidden`（内容在外） |
| `electron/confirmation/extractors/pathClassifier.ts`、`electron/shell/shellPathAnalysis.ts` | 目标 `raw / resolved / zone` 直接映射进诊断 |
| `electron/confirmation/toolCallGate.ts` | 汇总诊断并随结果返回；`ruleSource` 取 `policyOrigins` |
| `electron/toolChatLoop.ts` | 拒绝 / 未执行路径回传诊断，tool_result 附结构化摘要 |
| `electron/confirmation/securityAuditLog.ts`、`securityAuditReader.ts` | 审计字段白名单 + 读取端同步 |
| `src/renderer/i18n/resources/{zh-CN,en-US}/…` | 三类拒绝文案 + 参数 |

### 5.3 R3 MCP 载荷

| 文件 | 改动 |
| --- | --- |
| `src/shared/confirmation/types.ts` | 新增 `mcp-invocation` 信号与 `payload-incomplete` 信号；`ApprovalCluePack` 补 `argsDigest` |
| `electron/confirmation/toolCallGate.ts` | MCP 分支产 `mcp-invocation`（含 `classificationBasis`）、填线索包 |
| `electron/confirmation/extractors/mcpPayloadExtractor.ts`（新） | 入参摘要提取 + 截断 + 脱敏 |
| `electron/confirmation/extractors/approvalPayloadDecl.ts`（新） | `ApprovalVisibleInputDecl` 与 `assertApprovalPayloadComplete` |
| `electron/confirmation/agentChannel.ts` | 线索包渲染包含新字段（保持可信 / 不可信分区） |
| 审计 | 新事件 `confirm.payload-incomplete`（字段白名单） |

### 5.4 R4 结果信封

| 文件 | 改动 |
| --- | --- |
| `packages/agent-core/src/toolResultContract.ts`（新） | `ToolResultEnvelope`、`ToolErrorCode`、不变量表、`normalizeToolResultEnvelope` |
| `electron/tools/types.ts` | `validateToolExecutorResult*` 改为调用契约归一；保留兼容导出一版 |
| `src/shared/errorCodes.ts` | 新增 `TOOL_EXEC_FAILED` / `TOOL_EXECUTOR_ERROR` / `POLICY_NOT_EXECUTED` / `TOOL_USER_CANCELLED` / `TOOL_INVALID_INPUT` 与 `SHELL_*` → 新码的映射表（**长期保留，不设删除期限**，理由见附录 A.1） |
| `electron/tools/runShellExecutor.ts` | `settle` 各分支改用新码（行为不变，仅口径细分） |
| `electron/agentLogger/types.ts` | 新事件 `tool.result.contract-violation`（闭合联合 + 字段投影） |
| `scripts/scan-tool-result-invariants.mjs`（新） | 历史事件流全量扫描与报告 |
| `package.json` | 新增 `check:tool-result-invariants`、`test:tool-reliability` |
| `src/renderer/**`（展示层） | 成功 / 失败态只看 `success` + `data.status` |

### 5.5 R5–R8

| 文件 | 改动 | 问题 |
| --- | --- | --- |
| `electron/shell/analyzeShellCommand.ts` | 新增 `'unsupported'` 一值（**不改既有三值名**）、`unsupportedStructures` / `unsupportedReason` 子原因、段数超限并入 `unsupported`；逐条排除「非 deny 即可信」的消费点（§4.5.2 第 2 条） | R5 |
| `electron/shell/shellSecurity.ts` / `shellSecurityHelpers.ts` | deny 文案键化（键 + 参数） | R5 / R2 |
| `electron/shell/shellCommandTrust.ts` | **显式排除 `unsupported`**（`canShowShellTrustOption` / `shouldSkipShellConfirmForTrust`）+ 回归断言 | R5 |
| `electron/shell/shellToolLoopHelpers.ts`、`electron/confirmation/toolCallGate.ts` | 预检对 `unsupported` 不再 deny 而是下传事实；gate **照常走 facts 提取 → 引擎（不加特例、不加专用规则）**；映射表 default → fail-closed | R5 |
| `electron/skills/bundled/securityApprovalSkill.ts` | **输出合同加第三态 `undetermined`** + 使用约束（防滥用） | R5 |
| `src/shared/confirmation/types.ts` | `ApprovalVerdict` 加 `undetermined`；`ConfirmOutcomeCause` 加 `'agent-undetermined'`；同步「只有两态」注释 | R5 |
| `electron/confirmation/approvalAgent.ts` | `parseApprovalVerdict` 支持解析 `undetermined` | R5 |
| `electron/confirmation/agentChannel.ts` | 映射由两分支展开为三分支（`undetermined → agent-undetermined`） | R5 |
| `electron/confirmation/fallbackToUser.ts` | `FALLBACK_ELIGIBLE_CAUSES` 加 `'agent-undetermined'`（**其余三维不动**） | R5 |
| `docs/develop/desktop-fail-open-to-user-plan.md` | **同步该机制的权威定义**：§4 矩阵加一行、§4.4 判据表加一格、§6.3 用例补一条 | R5 |
| `electron/tools/builtinExecutors.ts` | ① 默认忽略清单归一（`GREP_DEFAULT_IGNORES`）；② `GrepScope` 统计与 `no_match` 文案；③ 显式路径语义；④ `normalizeGrepArgs`；⑤ `list_directory` 错误分类 | R6 / R7 / R8 |
| `src/shared/builtinToolDefinitions.ts` | grep 增 `include_ignored`；描述公开默认忽略清单 | R6 |
| `src/shared/grepScope.ts`（新） | `GrepScope` 类型与格式化 | R6 |
| `electron/tools/toolUserErrors.ts` | 目录错误分类的建议动作映射 | R8 |
| `src/renderer/i18n/resources/*/errors.json` | 新增目录错误文案 | R8 |

---

## 6. 落地顺序与门禁

### 6.1 三批推进

| 批次 | 内容 | 为什么这个顺序 | 门禁命令 |
| --- | --- | --- | --- |
| **批 A（公共前置）** | R1 快照单源；R4 信封契约 + 扫描脚本 | R2 的诊断必须能写出基准（依赖 R1）；R5/R6/R8 的失败都必须落同一信封（依赖 R4） | `npm run test:electron`、`npm run check:tool-result-invariants` |
| **批 B（决策可解释）** | R2 诊断契约；R3 MCP 载荷；R5 降级确认 | 三者共用诊断出口与 i18n 键；R3 与 R5 都要「补信息可重试」的验证通道 | `npm run test:electron`、`npm run i18n:check` |
| **批 C（工具层收敛）** | R6 搜索范围；R7 参数同源；R8 错误分类 | 与 A / B 无依赖，可并行；R6 依赖 R7 的归一入口 | `npm run test:electron`、`npm run test:shell-lifecycle` |

### 6.2 每批必做的三件事

1. **测试**：新增用例（§7.2），并让既有相关测试（`electron/shell/**`、`electron/tools/**`、`electron/capabilities/**`、`electron/toolChatLoop.*.test.ts`）全绿；
2. **门禁**：把该批的关键断言固化为「可 grep 的护栏」（例如「渲染端不得用 `error` 推导失败态」「`env.workspace` 不得再出现 `getActiveWorkDir`」），失败即 CI 红；
3. **证据留存**：批 A 的扫描报告、批 B 的「补信息重试即通过」会话证据、批 C 的三情形搜索证据，各留一份到 `docs/develop/`（沿用本仓既有验收证据文档的写法）。

### 6.3 与既有工作块的关系

- **不新增关键路径**：批 A 与架构偏差 1 / 2 / 3 的收口方向一致（Core 不新增读库、事件经端口），可与 SDK 契约工作并行；
- **与偏差 22（automation lane）对齐**：R5 的 automation 收敛规则必须显式落地（O9）—— 该 lane 的 catch-all **并非** fail-closed（回答者恒为审批 Agent，approve 即放行），**不能依赖「无回答者」自然兜底**；
- **与 block 2（审批 Agent）对齐**：R2 的诊断字段与 R3 的载荷字段都是审批 Agent 的输入质量来源，改动对回答者可插拔结构无侵入（Safety 仍只看到 `ConfirmationChannel`）。

---

## 7. 测试与验收

### 7.1 验收口径

- **功能验收**：逐条对齐需求 §5.1（§1.3 表已映射）；
- **一致性验收**：需求 §5.2 —— 信封矛盾数为 0；「实际存在却返回无匹配」用例数为 0；参数校验与执行同源；
- **测试验收**：需求 §5.3 —— 全部新增测试进 CI 并作为回归门禁。

### 7.2 用例清单（建议直接作为文件名与 `it()` 标题）

| ID | 用例 | 断言 |
| --- | --- | --- |
| T-R1-1 | 工作目录根下新建目录：Shell 与写入工具分别操作 | 四消费点同一 revision，结论一致（不得一处放行一处拒绝） |
| T-R1-2 | 隐藏目录（`.dir`）、符号链接目录、相对 / 绝对两种写法 | 一致性 100% |
| T-R1-3 | 会话切换 profile 后发起下一次工具调用 | `env.workspace.revision` == 审批审计 `basis.revision`，且为新目录 |
| T-R1-4 | 同一 revision 内制造基准分歧（测试注入） | 开发态 fail-loud；生产态写 `workspace.basis-mismatch` 审计 |
| T-R2-1 | `out-of-bounds` 拒绝 | 返回含 `basis.workDir` / `targets[].resolved` / `suggestions` |
| T-R2-2 | `insufficient-info` 拒绝 → 补入参重试 | 第二次调用通过（不依赖任何绕行方案） |
| T-R2-3 | 三类拒绝文案 | `forbidden` / `insufficient-info` / `out-of-bounds` 文案互不相同、键可分 |
| T-R2-4 | 审计字段 | 含 `ruleId` / `ruleSource` / `denyClass` / `basis`，且无主目录敏感展开 |
| T-R3-1 | 只读抓取（带 url + max_length） | 载荷含 `mcp-invocation.targetUrl`；不因「参数缺失」被拒 |
| T-R3-2 | 载荷构造缺字段（构造一份缺 url 的调用） | 返回 `payload-incomplete` 信号与审计，文案**不出现**「调用参数缺失」 |
| T-R3-3 | 类别映射 | `readOnlyHint` 声明 → `read` + `classificationBasis='annotations-readonly'`；ask / deny 结论不变 |
| T-R4-1 | 退出码 0 + 正常终止 | 信封无 `error`、`notExecuted` 不置位（I1 / I2） |
| T-R4-2 | 非零退出码 / 超时 / 用户取消 / 策略拒绝 / 参数非法 | 五类 `error` 码与 `notExecutedReason` 分别正确（I3 / I4 / I5） |
| T-R4-3 | 注入一条矛盾信封 | 归一为事实正确结果 + `tool.result.contract-violation` 告警（不得静默改写为失败） |
| T-R4-4 | 历史事件流扫描 | 报告矛盾数 0；脚本退出码 0 |
| T-R5-1 | ≥5 条只读控制结构命令（条件块、管道到格式化命令、`;` / `&&` 组合、变量拼接路径） | **不因解析器盲区被拒**：三种合法形态皆可（审批判安全→执行 / 判危险→拒绝 / 判不了→人工确认）；**唯一失败**是被拒绝且原因是「结构不支持」 |
| T-R5-2 | automation lane + `unsupported` | **由新增的 lane 限定 locked `deny` 规则拒绝**（`ruleId` 指向该规则）；**断言该路径不产生对审批 Agent 的请求**（无 agent 侧 `confirm.request` / `confirm.outcome`）—— 这是 O9 的锚定断言，防将来规则被删或顺序被挪回 catch-all 之后。**注**：原稿断言「由既有 catch-all 收敛为拒绝」与引擎实现矛盾（catch-all 会派生 agent 回答者），已随 O9 修正 |
| T-R5-3 | 危险命令 | 仍 deny（回归：不放宽） |
| T-R5-4 | 文案 | 「结构不受支持」与「命中危险规则（不可执行）」不同键 |
| T-R5-5 | `unsupported` 的命令在信任选项中不可见、不可持久化 | `canShowShellTrustOption` 与 `shouldSkipShellConfirmForTrust` **均为 false**（§4.5.2 第 2 条；缺失此断言即允许把无法分析的命令加入信任列表） |
| **T-R5-6** | **审批置为「判不了」→ 落到人工确认** | `confirm.outcome` 序列：`agent-undetermined`（`actor='agent'`）→ `confirm.answerer-fallback-to-user` → `DesktopChannel` 落 `user-approved` / `user-denied`；卡片可交互且显示「结构不受支持」 |
| **T-R5-7** | **`agent-deny` 仍永不回退**（回归锚定） | 审批判危险 → `agent-deny` → **不弹卡**（§4.5.3，防止新态把「拒绝」也带成可回退） |
| **T-R5-8** | **`undetermined` 不可写缓存** | 按 I3，机器结论不进 `decision_cache`；仅回退后的人工批准可写（§4.5.5） |
| **T-R5-9** | **`notExecutedReason` 映射正确**（评审 N2 锚定） | `cause='agent-undetermined'` → `notExecutedReason='agent_undetermined'`，**不得落 `user_rejected`**（覆盖 automation 与 desktop 回退被中止等未回退路径） |
| T-R6-1 | 排除目录内放置已知内容：默认搜索 | 不返回裸 `No matches found`；`searchScope.skipped` 非空 |
| T-R6-2 | **非隐藏**成员（`node_modules` / `dist`）：显式路径搜索 | **命中**（尊重调用方意图 —— 需求原文场景） |
| T-R6-3 | 同上 + `include_ignored: true` | 命中，且 `engine` / `scope` 字段正确 |
| T-R6-4 | **隐藏成员 `.git`**：默认 / 显式路径 / `include_ignored: true` | 默认**不搜**且返回范围提示（不得表述为「无匹配」）；**后两种均命中**（显式路径自动解除隐藏过滤，O8 定案选项 3） |
| T-R6-5 | rg 不可用降级 walk | 仍产出 `GrepScope`；隐藏条目与**敏感路径**的跳过行为与 rg **一致**（含修掉「walk 今天会搜到 `.env`」）；`include_ignored` 下非敏感隐藏条目两引擎均命中 |
| **T-R6-6** | **敏感文件 `.env`**：默认 / `include_ignored: true` / **显式点名该文件** | 前两种**均不搜**（计入 `skipped` 并标注原因，不得表述为「无匹配」）；第三种**命中**且返回体明示「命中敏感路径」；两引擎一致 |
| T-R7-1 | `count` + `context: 0`；`files_with_matches` + `show_line_number: true`；`multiline: false` | 全部通过 |
| T-R7-2 | `count` + `context: 3` | 报错，文案含冲突字段、当前模式、允许组合 |
| T-R7-3 | 校验与执行同源 | 同一输入下校验结论与执行生效值一致（单一实现断言） |
| T-R8-1 | 不存在路径 / 指向文件的路径 / 无权限路径 | 三种 `errorClass` 与文案各不相同 |
| T-R8-2 | 超时（注入 abort） | `READ_TIMEOUT` + `retryable: true`，文案区别于其他三类 |

### 7.3 CI 门禁清单

| 门禁 | 内容 |
| --- | --- |
| `npm run test:electron` | 既有 + 新增单测 / 集成测试 |
| `npm run test:shell-lifecycle` | shell 生命周期回归（R5 涉及） |
| `npm run check:tool-result-invariants` | 历史事件流扫描，矛盾数必须 0 |
| `npm run i18n:check` | 新增键在 zh-CN / en-US 双份齐备、无硬编码文案 |
| 样式护栏（grep 断言） | ① 渲染端不得以 `error` 推导失败态；② `env.workspace` 不得再出现 `getActiveWorkDir`；③ `toolResultContract` 之外不得另建信封 |

---

## 8. 风险与缓解

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 快照 `refresh` 引入「回合中途基准变化」 | 同一次调用前后判定可能不同 | **调用内冻结、调用间跟随**（§4.1.3）+ 审计 `workspace.rebound`；只有下一次工具调用可见新 revision |
| 信封归一「事实优先」掩盖真实失败 | 把失败当成功 | 归一由 `exitCode` / `terminationReason` 推导（有事实依据），且违规必告警 + 计数 + 扫描；不允许无事实依据的「乐观成功」 |
| R5 降级被误当作放宽 | 安全评审阻塞 | 边界三写：`unsupported` 只针对技术性解析失败；**automation 由 lane 限定 deny 规则收敛**（O9）；**信任列表不放宽** —— `unsupported` 必须在信任选项与持久化处显式排除（§4.5.2 第 2 条、T-R5-5） |
| R6 的「显式可解除」被误当成放宽访问限制 | 安全评审阻塞 | R6 **不引入访问控制**：默认忽略是**工具默认值**，可被调用方解除（§4.6.1、§2.3 判据） |
| **`--hidden` 打开隐藏条目后，敏感点文件（`.env`）可能被搜进上下文** | **新增风险（评审 B3），已定案处置** | **O8 = 选项 3「开隐藏、护敏感」**：grep 首次消费敏感路径机制 —— 遍历时排除 `.env` / `.env.*` / `secrets/`（`include_ignored` 也不解除），**显式点名该文件才搜索**且明示；两引擎共用同一份由规则生成的排除模式；T-R6-6 断言 |
| 两引擎对隐藏条目 / 敏感路径语义不一致（walk 今天能毫无阻碍地搜到 `.env`、rg 不能） | 中（评审 B3 发现的既有缺陷） | 本方案顺手修：walk 默认跳 `.` 开头条目 + 用 `isSensitivePath` 逐文件判定（**收紧，非放宽**），T-R6-5 以「两引擎同语义」为验收 |
| **新增 verdict 值后，把「非 `deny`」当可信的消费点误放行** | **中高（评审 B1 连带项，本方案自查发现）** | `shellCommandTrust.ts:93` / `:111` 漏排会让**无法分析的命令可加入信任列表**；§4.5.2 第 2 条要求逐条显式排除 + 回归断言 |
| 审计字段新增导致读取端不一致 | 审计页 / 合规报表缺列 | 写入口与 `securityAuditReader` 同批改动；读取端对缺字段做前向兼容（缺省不下发） |
| 新失败码改动影响历史消息回显 | 旧消息展示回归 | **映射表长期保留**（仅约 5 个旧码，见附录 A.1）；渲染端对未知码回退到既有本地化兜底 |
| grep 语义变化冲击既有测试 | 既有断言（如 `No matches found` 精确匹配）失败 | 先改测试再改实现（T-R6 三情形先行），并在实现记录里标注口径变更 |
| **无人链路对 `unsupported` 命令的审批放行** | **高（评审 N1 发现；已由用户决策收敛）** | **用户决策（2026-09-25）**：**不接受** —— 新增 lane 限定 locked `deny` 规则（`automation` + `shell-unsupported-structure`），须排在 catch-all 之前；T-R5-2 锚定「该路径不产生对审批 Agent 的请求」。**依据**：事实链断裂 + 无人值守 → fail-closed（与 desktop「判不了 → 转人工」同源）。决策记录见 §4.5.3 末 |
| automation 下合法复合命令仍被拒（R5 收益不覆盖无人链路） | 低（有意的范围裁剪） | 记录为有意决策：无人兜底的链路不执行解析器无法分析的命令；需求 R5 的目标场景为交互链路 |
| `notExecutedReason` 新枚举值影响统计口径与渲染 | 低（评审 N2） | 新增 `'agent_undetermined'` 并按 §4.5.3 第 6 处同步渲染端 i18n 兜底文案；用量统计常量与文档同步（附录 A.1） |

---

## 9. 非目标（与需求 §4 一致，另补六条）

需求 §4 的非目标全部沿用：**写入类工具与 Shell 之间的策略对齐、安全策略整体松紧、模型侧提示工程、运营侧功能、外部工具鉴权**均不在本方案范围。本方案另明确六条：

1. **不新增层、不新增可改写 Hook**：本方案只加数据（快照 / 诊断 / 场景字段）与端口方法，扩展点层级不变（架构 §5.3）。
2. **不改判定顺序与 fail-closed 兜底**：R5 只改「末端回答者在解析失败时是否被咨询」，不改「规则 → 缓存 → 回答者」的顺序与兜底语义。
3. **不放宽既有安全规则、不动档位**：R6 只调整**工具默认值**（默认忽略可被显式解除），既不新增也不减少任何访问限制；R6 对敏感路径的唯一动作是**在遍历中排除**（显式点名仍可搜、`include_ignored` 不解除），不构成新的访问控制；R3 的类别修正只影响读写分类与摘要，不影响 ask / deny 结果。
4. **不新增路径访问控制**（R6 修订中明确）：本方案**不为任何目标新增「不可解除」的限制**。若产品日后需要「Agent 不得读取版本库内部对象」这类政策（今天是「`.git` 不可写」，见 `docs/requirement/confirmation-card-trust-requirement.md` C3；「不可读」是新语义），那是**独立需求**，须走 Safety 且跨工具一致（策略层升格 zone + 路径分类器产事实 + `read_file` / `grep` / `run_shell` 同源消费），**不在 R6 范围**。
5. **不修「敏感路径」的跨工具不一致**（评审 B3 揭示、O8 定案时再次确认的既有缺口）：`isSensitivePath()` 的消费方现状只有写入自动放行与 shell 路径分析；**R6 让 `grep` 开始消费它**（仅为护住 `--hidden` 打开后的敏感点文件），**但 `read_file` / `list_directory` 仍不受约束**。若产品要「敏感路径在所有读取工具上一致生效」，那是**独立 Safety 需求**（本方案不声称、也不实现该一致性）—— 已单列为 **P-1 待立项**（见 §9.1）。
6. **不改 grep 之外的读写默认策略**：`include_ignored` 只影响搜索工具本身；它不改变 `write_file` / `edit_file` 的自动放行判定，也不改变 shell 路径分析的敏感前缀结论。

### 9.1 独立待立项（不在本方案范围）

| 编号 | 待立项 | 现状证据 | 为什么独立 |
| --- | --- | --- | --- |
| **P-1** | **「敏感路径」的跨工具一致** —— `read_file` / `list_directory` 不受 `isSensitivePath()` 约束，而 `write_file` / `edit_file` / `run_shell` 受限 | `rg -n "isSensitivePath\(" electron --glob '!*.test.ts'` 只命中 `writeFileAutoApproval.ts:26-27`、`shellPathAnalysis.ts:124`、`bashSecurityRules.ts:127`、`psSecurityRules.ts:79`；`readFileExecutor` / `listDirectoryExecutor` 只走 `resolveSafeReadPath`（越界防护） | ① 它是**安全边界**议题（要不要读得到密钥文件），不是工具可靠性；② 产品已在 `shellSensitivePaths.ts:60-61` 声明「`.env` / `secrets/` 是敏感路径」，但该声明只对**部分**工具生效 —— **同一规则、不同环节结论不一致**，与 R1 同族且**更早存在**；③ 处置需要决定「读取侧应硬拒还是需确认」，属产品决策，不是本方案的实现细节 |

> **本方案与 P-1 的边界**：R6 只保证「grep 不再撒谎」+「不因开 `--hidden` 而擅自放开敏感文件」；**它不主张、也不实现「敏感路径在所有工具上一致」**。P-1 落地后若改为「读取侧也受限」，R6 的敏感排除语义需与该结论对齐（届时以 P-1 为准）。
| **P-2** | **「事实链断裂」在 automation 下的处理不一致** —— `extraction-failed`（畸形/对抗性输入）今天仍会走到审批 Agent | 评审 N1 连带发现：`policyEngine.ts:266-277` 的 `extraction-failed` 分支显式传 `'user'`（恒落人工），但其注释自承「automation 经 lane 规则**落 agent**，不会到达此兜底——automation-default-confirm 全量拦截」；即 automation 下该类输入**由审批 Agent 判定、可放行** | ① 它与 R5 新增的 `automation-unsupported-deny` 属**同一原则**（事实链断裂 + 无人值守 → fail-closed），却行为不同；② 但它是**既有行为**，改动面涉及 `run_script` 等多类信号，且需安全侧评估「automation 是否确需机审代劳畸形输入」；③ 故**不在 R5 范围**，单列跟进 —— 与 P-1 同属「同一规则在不同环节结论不一致」族 |

> **P-2 与本方案的边界**：R5 只为 `unsupported` 一条信号加了 automation 收敛规则；**它不改变 `extraction-failed` 的既有处理**。若 P-2 日后定案为「也应收敛」，两者应共用同一判据表述。

---

## 附录 A：字段与键字典

### A.1 新增错误码（`src/shared/errorCodes.ts`）

| 码 | 场景 | 分类 |
| --- | --- | --- |
| `TOOL_EXEC_FAILED` | 执行了但非零退出 / 被信号终止 | R4 |
| `TOOL_EXECUTOR_ERROR` | 执行器异常（spawn 失败、内部抛出） | R4 |
| `POLICY_NOT_EXECUTED` | 策略 / 授权 / 预算拦下 | R4 |
| `TOOL_USER_CANCELLED` | 用户取消 | R4 |
| `TOOL_INVALID_INPUT` | 参数非法（未执行） | R4 / R7 |
| `DIRECTORY_ACCESS_DENIED` | 目录 / 文件无访问权限 | R8 |
| `DIRECTORY_READ_TIMEOUT` | 目录读取超时（可重试） | R8 |

复用既有：`FILE_NOT_FOUND`、`TARGET_NOT_DIRECTORY`、`FILE_PATH_TRAVERSAL`。

**旧码映射表：长期保留，不设删除期限**（O6 定案）。理由基于实测规模 —— `run_shell` 现网仅产出 **5 个** `SHELL_*` 错误码：

| 旧码 | 新码 |
| --- | --- |
| `SHELL_PROCESS_EXIT` | `TOOL_EXEC_FAILED` |
| `SHELL_SPAWN_ERROR` | `TOOL_EXECUTOR_ERROR` |
| `SHELL_TIMEOUT` | `TOOL_EXEC_FAILED`（`terminationReason='timeout'` 区分） |
| `SHELL_CANCELLED` | `TOOL_USER_CANCELLED` |
| `SHELL_ARTIFACT_PATH_INVALID` | `TOOL_EXECUTOR_ERROR` |

即映射表约 **5 行**、只作用于**历史消息回显**这一类调用方 —— 删除它的收益接近零，删错（老会话显示异常）的代价却真实存在。**因此保留，且不必设期限。**

> **不得混淆的邻项**：`electron/shell/shellCaseIds.ts` 里的 `SHELL-OUTPUT-001` / `SHELL-PROGRESS-001` 等是**诊断 caseId**（下划线变连字符、语义为「哪条诊断规则命中」），**不是错误码**，绝不可并入同一张映射表。现有非 `SHELL_` 前缀的失败码（`PLAN_STALE`、`OUTPUT_LIMIT_REACHED`）另按同一原则处理。

**`notExecutedReason` 枚举扩展（评审 N2）**：`src/shared/domainTypes.ts:561-565` 的闭合枚举新增 **`'agent_undetermined'`**（与既有 `'agent_denied'` 并列）。理由：两者语义不同且统计诉求明确 —— `agent_denied` = 机审**判定拒绝**；`agent_undetermined` = 机审**判不了**（未获裁决）。并入前者会让 §4.5.2 第 6 条的「判定不了率」与 §4.2.3 的 cause 不压平纪律同时失真。

配套三处同步（缺一即口径断裂）：① `electron/toolChatLoop.ts:657-687` 的 switch 补 `case 'agent-undetermined'`；② `electron/toolChatLoop.usageStatsInvariant.test.ts` 的 `NOT_EXECUTED_REASONS` 常量；③ 渲染端 i18n 兜底文案（zh-CN / en-US 双份）；④ 用量统计需求文档的枚举说明。

### A.2 新增 i18n 键（主进程只发键 + 参数）

| 键 | 参数 | 用途 |
| --- | --- | --- |
| `deny.forbidden.*` / `deny.insufficientInfo.*` / `deny.outOfBounds.workdir` | `ruleId` / `basisWorkDir` / `targetResolved` / `suggestions` | R2 三类拒绝 |
| `confirm.payloadIncomplete` | `toolName` / `missingFields` | R3 载荷构造告警 |
| `shell.unsupportedStructure` | `shell` / `structures` | R5 降级确认 |
| `shell.deniedByRule` | `ruleId` | R5 危险拒绝 |
| `grep.paramConflict` | `conflictField` / `currentMode` / `allowedCombos` / `suggestedWrite` | R7 |
| `grep.scopeNotice` | `root` / `skippedCount` / `skippedNames` | R6 |
| `errors.FILE_NOT_FOUND` / `errors.TARGET_NOT_DIRECTORY` / `errors.DIRECTORY_ACCESS_DENIED` / `errors.DIRECTORY_READ_TIMEOUT` | `path` / `suggestion` | R8 |

### A.3 新增审计 / 日志事件名（闭合清单，禁自由文案）

| 名称 | 类型 | 关键字段 |
| --- | --- | --- |
| `workspace.rebound` | 审计 | `sessionId` / `fromProfileId` / `toProfileId` / `revision` |
| `workspace.basis-mismatch` | 审计 | `sessionId` / `consumers[]` / `revision` |
| `confirm.payload-incomplete` | 审计 | `toolName` / `missingFields` / `lane` |
| `tool.result.contract-violation` | 日志 | `toolUseId` / `violations[]` / `errorCode` |

---

## 附录 B：现状复现命令

> 与架构文档 §10 的证据约定一致：用命令复现事实，行号只作辅助。

```powershell
# R1：环境自述是否走「全局 active profile」（命中即证明存在旁路）
rg -n "getActiveWorkDir" electron/capabilities/handlers/env.ts
# R1：桌面链路是否注入 resolveWorkDir（0 行说明只传了回合起点快照）
rg -n "resolveWorkDir" electron/claudeStreamHandlers.ts
# R1：循环内 workDir 取值
rg -n "resolveWorkDir \? resolveWorkDir\(\) : initialWorkDir" electron/toolChatLoop.ts

# R2：诊断字段是否缺位
rg -n "denyClass|basis|suggestions" src/shared/confirmation/types.ts

# R3：MCP 事实是否含入参
rg -n "mcp-tool|mcp-readonly|mcp-invocation" src/shared/confirmation/types.ts

# R4：信封矛盾处理方向
rg -n "SHELL_RESULT_CONTRACT_VIOLATION" electron/tools/types.ts
# R4：成功分支是否带 error
rg -n "settle\('process_exit', \{ success: true" electron/tools/runShellExecutor.ts

# R5：解析失败是否直接 deny
rg -n "命令语法解析失败，无法进行安全分析" electron/shell/analyzeShellCommand.ts

# R6：排除目录与无条件 glob
rg -n "GREP_SKIP_DIRS|--glob" electron/tools/builtinExecutors.ts
# R6：no_match 文案
rg -n "No matches found" electron/tools/builtinExecutors.ts

# R7：校验按字段出现判定
rg -n "hasOwnProperty.call\(input" electron/tools/builtinExecutors.ts

# R8：目录错误共用文案
rg -n "不是目录或无法访问" electron/tools/builtinExecutors.ts
```

### B.2 评审 v1 三条阻断的证据（v1.4 新增；结论均已核实并写入正文）

```powershell
# ---- B1：R5 契约（现状是三值，不是方案早期写的「四态替换」）----
# verdict 现状：'allow' | 'deny' | 'ask'
rg -n "ShellSecurityVerdict = " electron/shell/shellTypes.ts
# 分析层直接产出 ask（含 denyType='weak' 的弱升格）
rg -n "verdict: 'ask'" electron/shell/analyzeShellCommand.ts
# 「非 deny 即可信」的消费点 —— 新增枚举值后必须逐条显式排除（漏排 = 无法分析的命令可加入信任列表）
rg -n "verdict === 'deny'" electron/shell/shellCommandTrust.ts electron/shell/shellToolLoopHelpers.ts electron/shell/analyzeShellCommand.ts

# ---- B2：R1 refresh 口径（workDirManager 无变更事件机制；butler 今天已是调用间跟随）----
# 期望 0 行：不存在事件通路，故原 O7「绑定变更事件触发」不可依赖
rg -n "EventEmitter|addListener|onChange" electron/workDirManager.ts
# butler 注入 resolveWorkDir，循环内每次工具调用都会调它（调用间跟随的现场）
rg -n "resolveWorkDir" electron/butler/butlerInvoker.ts electron/toolChatLoop.ts

# ---- B3：R6 隐藏条目语义 ----
# 期望 0 行：rgArgs 不含 --hidden，故 rg 默认跳过 .git / .svn / .cursor 与 .env
rg -n -- "--hidden" electron/tools/builtinExecutors.ts
# walk 回退只跳名单、不跳隐藏条目（即 .env 在 rg 不可用时今天就能被搜到 —— 既有两引擎不一致）
rg -n "GREP_SKIP_DIRS.has" electron/tools/builtinExecutors.ts
# isSensitivePath 的全部消费方（证明 read_file / grep / list_directory 现状不受敏感前缀约束）
rg -n "isSensitivePath\(" electron --glob '!*.test.ts'
```

---

## 附录 C：需求 §5 验收项逐条对照

> 口径：需求项 → 本方案落点 → **首个可验证信号**（能立刻跑出来、或能在审计 / 返回值里看到）。

### C.1 功能验收（需求 §5.1，16 条）

| # | 需求验收项 | 本方案落点 | 首个可验证信号 |
| --- | --- | --- | --- |
| 1 | 四环节对同一路径的工作目录归属判定完全一致 | §4.1.4、T-R1-1/2 | `assertWorkspaceBasisConsistent` 返回 `ok: true` |
| 2 | 根下新建目录不再出现「自述在内、审批在外」 | §4.1.4 | 同一 `revision` 下四处 `workDir` 字面相等 |
| 3 | 切换工作目录后审批基准同步更新 | §4.1.3、T-R1-3 | `env.workspace.revision` == 审计 `basis.revision` |
| 4 | 每条拒绝含规则 ID / 基准 / 解析后目标 / 建议动作 | §4.2.1、T-R2-1 | `diagnostics` 四字段齐全（缺一即测试红） |
| 5 | 文案区分「严格禁止 / 条件不足 / 越界」 | §4.2.1、T-R2-3 | 三种 `denyClass` 的 `messageKey` 互不相同 |
| 6 | 外部工具拒绝理由与实际入参一致 | §4.3.1/4.3.3、T-R3-1/2 | 载荷含 `targetUrl`；不再出现「参数全部缺失」 |
| 7 | 只读抓取不再被归为写操作 | §4.3.2、T-R3-3 | `classificationBasis='annotations-readonly'` 且 `actionClass='read'` |
| 8 | `exitCode === 0` 不出失败标记 | §4.4.2 I2、T-R4-1 | 信封无 `error` 且 `notExecuted` 未置位 |
| 9 | 不再出现 `success: true` 与错误并存 | §4.4.2 I1、T-R4-1 | 契约归一后 `error` 为空 |
| 10 | 无法解析的命令不再直接拒绝；审批可判定时按其结论执行，降级时文案说明「结构不受支持」 | §4.5.1/4.5.2、T-R5-1/4 | verdict 为 `unsupported` 且**未被判为拒绝**（三种合法形态见 §4.5.4） |
| 11 | 审批判定不了时降级为人工确认，含条件块与管道的只读命令可通过用户确认执行 | §4.5.3、T-R5-1、T-R5-6 | 审批置「判不了」→ `agent-undetermined` → 回退人工 → 卡片可确认 |
| 12 | 「无匹配」时给出实际搜索范围与跳过情况 | §4.6.2、T-R6-1 | 返回体含 `searchScope`，`skippedCount` 显式 |
| 13 | 显式指定排除目录内路径不再返回「无匹配」 | §4.6.3、T-R6-2、T-R6-4 | **默认忽略成员**显式点名即命中（含隐藏成员 `.git`，自动解除隐藏过滤）；**敏感文件**（`.env`）遍历中不搜但**显式点名即搜索**并明示；**任何跳过都不得表述为「无匹配」** |
| 14 | 存在搜索默认排除目录的显式开关 | §4.6.4、T-R6-3、T-R6-6 | `include_ignored: true` 解除默认忽略与隐藏过滤（对齐 `-uu`）；**但不解除敏感路径**（`.env` 仍不搜）—— 工具说明公开这一差别与各自的替代方式 |
| 15 | 与默认值等价的显式参数不再报错 | §4.7.2、T-R7-1 | `count + context: 0` 等组合调用成功 |
| 16 | 目录错误可区分四类 | §4.8、T-R8-1/2 | 四种 `errorClass` 与四段文案各不相同 |

### C.2 一致性验收（需求 §5.2，3 条）

| 需求验收项 | 落点 | 信号 |
| --- | --- | --- |
| 历史事件流全量扫描：信封矛盾数为 0 | §4.4.4 | `npm run check:tool-result-invariants` 退出码 0 |
| 测试集中「实际存在却返回无匹配」为 0 | §4.6.5、T-R6-1 ~ T-R6-6 | 四组搜索用例全绿（非隐藏成员 / 隐藏成员 / **敏感文件** / 两引擎同语义）；且「无隐藏安全语义」回归断言通过（非隐藏成员与隐藏成员均可被显式路径解除；**敏感文件只在显式点名时解除**） |
| 参数校验规则与执行路径出自同一实现 | §4.7.1、T-R7-3 | `validateGrepInput` 与执行器共用 `normalizeGrepArgs`（单一实现断言） |
| 所有「未执行」结果带可枚举原因且互不重叠 | §4.4.2 I3、§4.2.3 | `notExecutedReason` ∈ 既有闭合枚举，`denyClass` 维度可分组统计 |

### C.3 测试验收（需求 §5.3，7 条）

| 需求验收项 | 对应用例 |
| --- | --- |
| R1 跨层一致性回归（相对/绝对、隐藏目录、符号链接） | T-R1-1 ~ T-R1-4 |
| R3 外部工具审批载荷完整性 | T-R3-1 ~ T-R3-3 |
| R4 信封不变量单测（成功/非零退出/超时/策略拒绝/用户取消） | T-R4-1 ~ T-R4-4 |
| R5 解析降级测试（≥5 条控制结构命令，断言不因解析器盲区被拒）+ 审批「判不了 → 人工确认」专项 + **automation 收敛锚定（不产生对审批 Agent 的请求）** + 信任列表不放宽 + `agent-deny` 不回退锚定 + **`notExecutedReason` 映射** | T-R5-1 ~ T-R5-9 |
| R6 搜索范围透明度（默认 / 显式路径 / 开启开关 / 可解除性回归 / **敏感文件与两引擎一致**） | T-R6-1 ~ T-R6-6 |
| R7、R8 参数与错误分类单测 | T-R7-1 ~ T-R7-3、T-R8-1 ~ T-R8-2 |
| 全部新增测试进 CI 并作为回归门禁 | §7.3 门禁清单 |

---

## 附录 D：关键改动示例

> 四段示例覆盖「单一事实源」的四种落法形态。示例只表达**形状与方向**，字段名以实现分支与类型检查为准。

### D.1 R1：`env.workspace` 去掉「全局 active profile」旁路

```ts
// electron/capabilities/handlers/env.ts
// 现状：workDir = manager.getActiveWorkDir() || ctx.workDir  ← 优先全局 active profile
// 目标：
handler: async (_params, ctx) => {
  const snapshot = ctx.workspace            // WorkspaceSnapshot：装配期解析，随调用携带
  const manager = ctx.workDirManager
  return {
    workDir: snapshot.rootPath,             // 唯一事实源
    profileId: snapshot.profileId,
    source: snapshot.source,                // 'session-binding' | 'active-fallback'
    revision: snapshot.revision,            // 与审批审计里的 revision 可比对
    ...(manager && typeof manager.listProfiles === 'function'
      ? {
          profiles: manager.listProfiles().map((p) => ({
            id: p.id,
            name: p.name,
            path: p.path,
            isBound: p.id === snapshot.profileId,   // 按快照判定，不再用 p.path === ctx.workDir 兜底
            isDefault: Boolean(p.isDefault)
          }))
        }
      : {})
  }
}
```

**要点**：`ctx.workspace` 不存在时**不得**回退到「全局 active profile」——那是本次要消灭的第三条基准。改为在装配期保证快照必存在（fail-loud）。

### D.2 R7：`normalizeGrepArgs` 成为唯一出口，执行器与校验层共用

```ts
// electron/tools/builtinExecutors.ts
export type GrepNormalizeResult =
  | { ok: true; args: GrepExecArgs; effectful: string[] }
  | { ok: false; error: { code: 'param-conflict'; field: string; mode: string; allowed: string; suggestedWrite: string } }

export function normalizeGrepArgs(input: Record<string, unknown>): GrepNormalizeResult {
  const outputMode = (typeof input.output_mode === 'string' ? input.output_mode : 'files_with_matches') as GrepMode
  if (!GREP_MODES.includes(outputMode)) return fail('output_mode', outputMode, 'files_with_matches | content | count', '去掉 output_mode 或改用三者之一')

  const contextRaw = typeof input.context === 'number' ? input.context : undefined
  if (contextRaw !== undefined && (!Number.isInteger(contextRaw) || contextRaw < 0 || contextRaw > 1000)) {
    return fail('context', outputMode, '0～1000 的整数', '去掉 context 或改为 0～1000')
  }

  // 判定依据：**生效值**（>0 / true），不是「字段是否出现」（口径以 §4.7.2 表格为准）
  const effectful: string[] = []
  if (contextRaw !== undefined && contextRaw > 0) effectful.push(`context=${contextRaw}`)
  if (input.multiline === true) effectful.push('multiline=true')
  // show_line_number **不计入冲突**（评审 P2-1）：它只在 content 模式下有效果，而 content 正是它
  // 适用的模式；「非 content 模式 + 任意取值」都属无效果或不适用 → 一律通过。

  if (outputMode !== 'content' && effectful.length > 0) {
    return fail(effectful[0]!, outputMode, '仅 output_mode=content 下生效', '改用 output_mode=content，或去掉该参数')
  }

  return {
    ok: true,
    effectful,
    args: {
      glob: typeof input.glob === 'string' ? input.glob : undefined,
      outputMode,
      ignoreCase: Boolean(input.ignore_case),
      // 生效值只在 content 模式有意义；非 content 模式一律归一为「无效果」
      showLineNumber: outputMode === 'content' && input.show_line_number !== false,
      context: outputMode === 'content' ? contextRaw : undefined,
      multiline: outputMode === 'content' && Boolean(input.multiline),
      headLimit: typeof input.head_limit === 'number' ? input.head_limit : 100,
      includeIgnored: Boolean(input.include_ignored)
    }
  }
}
```

**要点**：`count + context: 0` / `multiline: false` / `show_line_number: true` 三种等价默认值都落进「`effectful` 为空」，自然通过；执行器只读 `result.args`，不再各自读 `input.*` —— 两层判定同源。

### D.3 R4：校验器从「矛盾即改判失败」改为「按事实归一 + 告警」

```ts
// packages/agent-core/src/toolResultContract.ts
export function normalizeToolResultEnvelope(
  raw: unknown,
  facts: { exitCode?: number | null; terminationReason?: string; aborted?: boolean }
): { envelope: ToolResultEnvelope; violations: ToolViolation[] } {
  const violations: ToolViolation[] = []
  if (!raw || typeof raw !== 'object' || typeof (raw as { success?: unknown }).success !== 'boolean') {
    violations.push({ invariant: 'I0', detail: 'missing success boolean' })
    return { envelope: { success: false, error: 'TOOL_EXECUTOR_ERROR' }, violations }
  }
  let env = raw as ToolResultEnvelope

  const exitOk = facts.exitCode === 0 && facts.terminationReason === 'process_exit' && facts.aborted !== true

  // I2：有事实依据的成功不得被判失败（今天的病根：矛盾时把成功改判失败）
  if (exitOk && env.success !== true) {
    env = { ...env, success: true, error: undefined, notExecuted: undefined, notExecutedReason: undefined }
    violations.push({ invariant: 'I2', detail: 'exitCode=0 被判失败，已按事实归一' })
  }
  // I4：非零退出 / 中止不得被判成功
  if (!exitOk && facts.exitCode != null && facts.exitCode !== 0 && env.success === true) {
    env = { ...env, success: false, error: env.error ?? 'TOOL_EXEC_FAILED' }
    violations.push({ invariant: 'I4', detail: 'exitCode!=0 被判成功，已按事实归一' })
  }
  // I1：成功分支不得携带 error
  if (env.success === true && env.error) {
    env = { ...env, error: undefined }
    violations.push({ invariant: 'I1', detail: 'success 与 error 并存' })
  }
  // I3：未执行必须显式且带原因
  if (env.notExecuted === true && (env.success !== false || env.notExecutedReason == null)) {
    env = { ...env, success: false }
    violations.push({ invariant: 'I3', detail: 'notExecuted 语义不完整' })
  }
  return { envelope: env, violations }
}
```

调用方（`toolChatLoop`）拿到 `violations` 后**必须**落 `tool.result.contract-violation` 日志并计入诊断统计；**不允许**只归一不告警（否则契约违规变成静默）。

### D.4 R8：`list_directory` 错误分类分支

```ts
// electron/tools/builtinExecutors.ts
function classifyDirectoryError(e: unknown): DirectoryErrorClass | 'ABORTED' {
  if (isAbortError(e)) return 'ABORTED'
  const code = (e as NodeJS.ErrnoException | undefined)?.code
  if (code === 'ENOENT') return 'PATH_NOT_FOUND'
  if (code === 'EACCES' || code === 'EPERM') return 'ACCESS_DENIED'
  if (code === 'ENOTDIR') return 'NOT_A_DIRECTORY'
  return 'ACCESS_DENIED'            // 未知一律归最保守且可解释的一类，不新增第五种文案
}

// 三个分支改为各自成型：
// ① resolveSafeReadPath 抛错 → PATH_OUTSIDE_WORKDIR（FILE_PATH_TRAVERSAL，suggestions: ['provide-path']）
// ② fs.stat 抛错           → classifyDirectoryError(e)（ENOENT → FILE_NOT_FOUND + ['list-parent']）
// ③ !st.isDirectory()      → NOT_A_DIRECTORY（TARGET_NOT_DIRECTORY + ['use-read-file']）
// ④ abort / 超时           → READ_TIMEOUT（DIRECTORY_READ_TIMEOUT + retryable: true）
```

**要点**：`errorClass` 是机器可读字段（`data.errorClass`），文案由渲染端 `errorTranslator` 从 i18n 取；**超时绝不与其他三类共用文案**（需求 §R8 硬要求）。

---

## 附录 E：任务拆解（WBS）与待拍板项

### E.1 批次 A（公共前置，≈8.5 人日）

| 编号 | 任务 | 主要文件 | 依赖 |
| --- | --- | --- | --- |
| A1 | `WorkspaceSnapshot` 类型 + 规范化 + 比较键 + 一致性断言 | `src/shared/agent/workspace.ts`（新）、`electron/writeSafety/pathIdentity.ts` | — |
| A2 | `resolveWorkspaceSnapshot`（包装 `resolveWorkDirForSession`）+ `revision` 递增 | `electron/workDirManager.ts` | A1 |
| A3 | 端口与装配：`snapshot()` / `refresh()`；桌面与 butler 两条链路都注入 | `src/shared/agent/invocation.ts`、`electron/runtime/invocationAssembler.ts`、`electron/claudeStreamHandlers.ts`、`electron/butler/butlerInvoker.ts` | A1、A2 |
| A4 | 四个消费点改同源（env / 文件工具 / shell cwd / gate `EnvFacts`）+ **调用边界 `refresh()` 接线**（§4.1.3）+ `initialWorkDir` 残留清理 | `electron/capabilities/handlers/env.ts`、`electron/toolChatLoop.ts`、`electron/confirmation/toolCallGate.ts` | A3 |
| A5 | 一致性护栏 + `workspace.basis-mismatch` / `workspace.rebound` 审计 | 审计白名单与读取端 | A3、A4 |
| A6 | 跨层测试 T-R1-1 ~ T-R1-4 | 新增测试文件 | A4、A5 |
| A7 | 结果契约：`ToolResultEnvelope` / `ToolErrorCode` / 不变量 / `normalizeToolResultEnvelope` | `packages/agent-core/src/toolResultContract.ts`（新） | — |
| A8 | 校验器切换 + 兼容导出 + `SHELL_*` → 新码映射表 | `electron/tools/types.ts`、`src/shared/errorCodes.ts`、`electron/tools/runShellExecutor.ts` | A7 |
| A9 | 新日志事件 + 违规计数进诊断 | `electron/agentLogger/types.ts`、`electron/toolChatLoop.ts` | A7、A8 |
| A10 | 历史事件流扫描脚本 + npm 脚本 + CI 接入 | `scripts/scan-tool-result-invariants.mjs`（新）、`package.json` | A7 |
| A11 | 渲染端失败态单一推导路径清理 + grep 护栏断言 | `src/renderer/**`、护栏脚本 | A8 |
| A12 | 测试 T-R4-1 ~ T-R4-4 + 门禁跑通 | 新增测试文件 | A8 ~ A10 |

**批 A 交付门槛**：① `npm run test:electron` 全绿；② `check:tool-result-invariants` 矛盾数为 0；③ `env.workspace` 与审批审计的 `revision` 相等（人工会话验证一次）。

### E.2 批次 B（决策可解释，≈8 人日）

| 编号 | 任务 | 主要文件 |
| --- | --- | --- |
| B1 | `SafetyDiagnostics` / `DenyClass` 契约；规则增 `denyClass` 声明 | `src/shared/confirmation/diagnostics.ts`（新）、`src/shared/policy/defaultRules.ts` |
| B2 | 产出点接线（路径事实、规则来源、汇总出口） | `electron/confirmation/toolCallGate.ts`、`electron/confirmation/extractors/pathClassifier.ts`、`electron/shell/shellPathAnalysis.ts` |
| B3 | 审计字段 + 读取端同步 + 脱敏入口 | `electron/confirmation/securityAuditLog.ts`、`securityAuditReader.ts` |
| B4 | 三类拒绝文案（键 + 参数，zh-CN / en-US） | `src/renderer/i18n/resources/*/` |
| B5 | 测试 T-R2-1 ~ T-R2-4（含「补信息重试即通过」） | 新增测试文件 |
| B6 | `mcp-invocation` 信号 + 入参摘要提取（截断 + 脱敏） | `src/shared/confirmation/types.ts`、`electron/confirmation/extractors/mcpPayloadExtractor.ts`（新） |
| B7 | 载荷声明 + `assertApprovalPayloadComplete` + `payload-incomplete` | `electron/confirmation/extractors/approvalPayloadDecl.ts`（新） |
| B8 | 线索包与审批审计补字段 | `electron/confirmation/toolCallGate.ts`、`agentChannel.ts` |
| B9 | 测试 T-R3-1 ~ T-R3-3 | 新增测试文件 |
| B10 | `'unsupported'` 一值（不改既有三值名）+ 子原因字段 + 段数超限并入；消费点逐条排除（含 `shellCommandTrust.ts`） | `electron/shell/analyzeShellCommand.ts`、`shellCommandParser.ts`、`shellCommandTrust.ts`、`shellToolLoopHelpers.ts` |
| B11 | gate **不加特例**：`unsupported` 照常走 facts → 引擎（命中既有 `default-write-execute-ask`）；未知 verdict 取值 fail-closed | `electron/confirmation/toolCallGate.ts`（仅映射表兜底，无新规则） |
| B12 | 两段文案分键；**观测两个独立指标**（解析失败率 走 `policy.decision`；判定不了率 走 `agent-undetermined`） | `electron/shell/shellSecurity.ts`、`toolCallLoop` 侧审计装配 |
| B13 | 测试 T-R5-1 ~ T-R5-8（三形态 / automation / 信任列表 / 「判不了→人工」/ `agent-deny` 锚定 / 缓存） | 新增测试文件 |
| **B14** | **审批侧新增「判定不了」态**（方案 B 支点）：输出合同第三态 + `ApprovalVerdict` + `parseApprovalVerdict` + `ConfirmOutcomeCause` + `AgentChannel` 三分支映射 + **`notExecutedReasonForConfirmation` 补 `agent-undetermined` 分支（第六处，评审 N2）** + 回退白名单加一格 + 提示词防滥用约束 | `electron/skills/bundled/securityApprovalSkill.ts`、`src/shared/confirmation/types.ts`、`electron/confirmation/approvalAgent.ts`、`agentChannel.ts`、`fallbackToUser.ts`、`electron/toolChatLoop.ts` |
| **B16** | **automation 收敛（O9）+ 连带修正**：① 新增 lane 限定 locked `deny` 规则（`automation` + `shell-unsupported-structure`，**须排在 `automation-default-confirm` 之前**）；② `notExecutedReason` 枚举新增 `'agent_undetermined'` 并同步用量统计常量 / 渲染端 i18n / 需求文档枚举说明；③ **修正 `src/shared/policy/defaultRules.ts:301-302` 的过时注释**（「RejectingChannel 使其实际效果为拒绝」为回答者派生前表述，是本轮 N1 误判的误导源） | `src/shared/policy/defaultRules.ts`、`src/shared/domainTypes.ts`、`electron/toolChatLoop.ts`、`src/renderer/i18n/resources/*/`、`docs/requirement/agent-token-usage-analytics-requirement.md` |
| **B15** | **同步 `docs/develop/desktop-fail-open-to-user-plan.md`**（§4 矩阵 / §4.4 判据表 / §6.3 用例）—— 该机制的权威定义处 | 该文档 |

**批 B 交付门槛**：① 三类拒绝各有可查诊断与审计；② 「条件不足 → 补信息重试 → 通过」有一次真实会话证据；③ **automation 的 `unsupported` 由新规则拒绝，且该路径不产生对审批 Agent 的请求**（T-R5-2）；④ `unsupported` 的命令**不出现**在信任选项中（T-R5-5）；⑤ **审批「判不了 → 回退人工」端到端有一次证据**（T-R5-6），且 `agent-deny` 不回退锚定通过（T-R5-7）、`notExecutedReason` 映射正确（T-R5-9）。

### E.3 批次 C（工具层收敛，≈7.5 人日）

| 编号 | 任务 | 主要文件 |
| --- | --- | --- |
| C1 | 默认忽略清单归一为 `GREP_DEFAULT_IGNORES`（7 成员）；**隐藏条目语义**按 §4.6.1 实现（rg 侧 `--hidden` 仅在解除时传、walk 侧补对称跳过）；**敏感排除模式由规则生成**（`grepSensitiveExcludes()`，与 `shellSensitivePaths` 同源、两引擎共用） | `electron/tools/builtinExecutors.ts`、`src/shared/builtinToolDefinitions.ts` |
| C2 | `GrepScope` 统计 + `no_match` 文案与状态区分（含敏感条目跳过标注） | `src/shared/grepScope.ts`（新）、`builtinExecutors.ts` |
| C3 | 显式路径语义 + `include_ignored` 开关；**grep 首次消费 `isSensitivePath`**（遍历排除、显式点名解除、`include_ignored` 不解除） | 同上 |
| C4 | walk 回退同样统计（`engine: 'walk'`）+ 隐藏条目与敏感路径的对称判定（2026-09-29：已随降级接线落地可达；**降级路径须填充 `GrepScope` 全部字段**，见 grep-abort 方案 §3.4） | 同上 |
| C5 | 测试 T-R6-1 ~ T-R6-6（**先改测试再改实现**） | `electron/tools/ripgrepExecutorProcess.test.ts` 等 |
| C6 | `normalizeGrepArgs` 单一入口 + 执行器改用 | `electron/tools/builtinExecutors.ts` |
| C7 | 测试 T-R7-1 ~ T-R7-3 | 新增测试文件 |
| C8 | `DirectoryErrorClass` + 四个分支改造 + 两个新错误码 | `builtinExecutors.ts`、`src/shared/errorCodes.ts` |
| C9 | 文案与建议动作 i18n | `src/renderer/i18n/resources/*/errors.json` |
| C10 | 测试 T-R8-1 ~ T-R8-2 | 新增测试文件 |
| **C11** | **敏感排除的跨引擎一致性断言**：同一份模式在 rg（`--glob`）与 walk（`isSensitivePath` 逐文件）下产生**相同**的跳过集合（T-R6-6 的第二引擎分支） | 同上 |

**批 C 交付门槛**：① 四组搜索语义与断言一致（非隐藏 / 隐藏 / **敏感** / 两引擎），`no_match` 必带范围；② `no_match` 既有测试断言已完成口径迁移并全绿；③ 目录四类文案互不相同；④ **敏感文件在遍历中不被搜到、且显式点名可搜**（T-R6-6）；⑤ 两引擎跳过集合一致（C11）。

**合计 ≈ 26 人日**（设计已含在本方案，不含评审、返工与端到端人工验证）。批 B 与批 C 可与批 A 的 A7–A12 并行（不同文件面），但批 B 的 B1 建议等 A1/A5 落地（诊断要能写出基准的 `revision`）；**B14（审批侧新态）另有前置**：须先完成 B15 的文档同步口径确认（它是该机制的权威定义处）。

### E.4 待拍板项（评审需明确，影响实现细节）

| # | 待拍板 | 影响 | 建议默认 |
| --- | --- | --- | --- |
| O1 | ~~`.git` / `.svn` 是否归安全类~~ **（已作废）** | — | **作废**：方案 1 下 R6 不引入访问控制，7 个成员统一为默认忽略、一律可解除（解除方式有别，见 §4.6.1） |
| O2 | ~~安全类目录跳过时「明示已跳过」还是硬拒~~ **（已作废）** | — | **作废**：同上，不存在「安全类」分支。保留的硬要求：**任何**跳过（默认忽略未解除时）都必须回报范围，不得返回裸「无匹配」（§4.6.2） |
| O3a | ~~R5 是否按 lane 写分支（某 lane 降级、某 lane 不降）~~ **（已定案）** | — | **不写分支**：R5 在 gate 层零特例，`unsupported` 照常走既有 ask 流程，四条链路语义自动正确（desktop standard → 审批 → 判不了回退人工 / IM 按既有只读策略 / **automation 由新增的 lane 限定 deny 规则收敛为拒绝，O9**）。按 lane 写分支反而会重新引入「同一命令各链路结论不同」（架构 §7.2 规则 4 亦已禁「按 lane 硬编码回答者」） |
| O3b | ~~`unsupported` 的确认恒交人工、不经审批 Agent~~ **（已定案：方案 B）** | — | **改为：沿既有 ask 流程走审批；审批判定不了才回退人工**。做法 = shell 侧只把结论改成 `unsupported`（gate 层零特例）+ 审批侧新增「判定不了」态（`agent-undetermined`）+ 回退白名单加一格。**原「恒交人工」方案已撤销** —— 它会把审批 Agent **本可自行判定**的命令也推给用户（白打扰），且为 shell 单开特例通道。硬边界不变：`agent-deny` 仍**永不回退**。详见 §4.5.3 / §4.5.4 |
| O4 | ~~R2 `denyClass` 标注范围（全量规则 vs 仅高风险）~~ **（已定案）** | — | **全量标注**：会产 `ask` / `deny` / `confirm-every-time` 的 25 条规则逐条标（7 条纯放行类不标）。理由：部分标注会留下空洞 —— 未标的规则一旦拒绝，用户又看到「没讲依据」的老文案，恰是 R2 要消灭的；且 25 个字段的维护成本远低于「只标一部分」带来的长期不一致。遗漏兜底 `forbidden` |
| O5 | ~~R3 `argsDigest` 上限与 secret 键清单~~ **（已定案）** | — | **大字段（`content` / `code` / `body` 等本次调用新产生、审批别处查不到）先给全文**并按体量标注（选择「先观察成本」）；判断核心字段（`url` / `path` / `command`）原值、超长**保头部** + 标注截断；密钥类只留键名；兜底上限 8192 字符 / 20 项**仅防极端值**。配套 **§4.3.5 成本可观测**（审批输入 token 按归属统计 + 判据一致率评测）与**后退路径**（成本过高则改为「检测结论 + 体量」，复用 `scriptContentSecurity`，**不做简单截断**） |
| **O9** | ~~automation（无人值守）是否允许审批 Agent 放行 `unsupported` 命令~~ **（已定案 · 用户决策 2026-09-25：不接受放行）** | — | **不接受放行** —— **用户明确拍板**（知悉 N1 揭示的事实与两侧代价后选择收敛）。落法：新增 lane 限定 locked `deny` 规则（`automation` + `shell-unsupported-structure` → `deny`，须排在 catch-all 之前）。**依据**：常规命令具备结构化事实故机审可代劳；`unsupported` 事实链断裂、审批退化为猜测，而无人链路无人类兜底 → fail-closed（与 desktop「判不了 → 转人工」同源）。**同时撤回原稿三处错误断言**（automation 的回答者并非 `deny`、catch-all 会真实咨询并可能放行）。详见 §4.5.3 末「决策记录」；被否决的备选（接受放行）亦记录在案 |
| O6 | ~~R4 新旧错误码映射表保留时长~~ **（已定案）** | — | **长期保留、不设删除期限**。依据实测规模：旧码仅 5 个（映射表约 5 行），只作用于历史回显，删除收益≈0、删错代价真实。详见附录 A.1 |
| O7 | ~~R1 `refresh` 触发时机~~ **（已定案，评审 B2）** | — | **调用边界 `refresh()`**（每工具调用一次，`workspacePathKey` 未变则返回原快照、不落审计）。原「回合边界 + 绑定变更事件」建议**已撤销**：与 §4.1.3 自相矛盾，且所用事件通路今天不存在。详见 §4.1.3 |
| O8 | ~~`include_ignored: true` 是否允许包含点文件（如项目 `.env`）~~ **（已定案：选项 3「开隐藏、护敏感」）** | — | **`.git` / `.svn` / `.cursor` 等（非敏感）隐藏条目：可搜**（显式路径自动解除隐藏过滤，或 `include_ignored: true` 一并解除）；**敏感文件（`.env` / `.env.*` / `secrets/`）：遍历中始终排除**（`include_ignored` 也不解除），**显式点名该文件则搜索**并明示「命中敏感路径」。配套：rg 与 walk **共用同一份由规则生成的敏感排除模式**（不得各写一份）。详见 §4.6.1 末两表 |

---

**文档版本**：v1.10（O9 记为用户决策）
**v1.10 变更**（O9 用户决策记录）：
- **O9 由「本文档推荐」升格为「用户决策」**：**用户于 2026-09-25 明确拍板 —— 不接受无人值守链路（automation）由审批 Agent 放行 `unsupported` 命令**。落点四处标注：**§4.5.3 末**新增「决策记录（用户决策）」块（含决策背景：N1 揭示的错误断言 + 用户是在知悉事实与两侧代价后作出选择；并**把被否决的备选「接受放行」保留在案**，注明「这条规则不是遗漏，而是有意的安全选择」）、**O9 行**、**§8 风险行**、**§4.5.5** 引用处。
- 同步**需求文档升至 v1.3**：§3 R5 效果标准补一条「无人值守链路无人类兜底 → `unsupported` 维持拒绝；不交由审批 Agent 放行」，修订记录记入该用户决策 —— 使需求与设计的约束边界一致。
**v1.9 变更**（评审 v1.5：N1 / N2 处置）：
- **N1（P1）automation lane 现状认知更正 + O9 定案**：原稿断言「automation 的回答者解析为 `deny`、不咨询审批 Agent、`unsupported` 必然收敛为拒绝」——**与引擎实现不符，已撤回**。真实机制：`askAnswererFor('automation')` 恒返回 `'agent'`（`policyEngine.ts:211-214`），生产链路无条件注入 `agentChannelFactory`（`toolChatLoop.ts:2429`，并为 automation 专设 `maxAuthorization: 'low'`，`:2462`）→ catch-all 的 ask 会**真实咨询审批、approve 即放行**；误导源是 `defaultRules.ts:301-302` 的**过时注释**（回答者派生前表述）。落点：**§4.5.1** 表（automation 例外 + `default-write-execute-ask` 注明为引擎内置 ID，P3-2）、**§4.5.2 第 4 条**（「不派发专用规则」修正为「对 desktop 不派发、对 automation 必须派发 lane 限定规则」）、**§4.5.3 末**新增「automation 收敛规则」块（含规则草图、必须排在 catch-all 之前、判据、改判回改点）、**§4.5.5 第一条**、**T-R5-2**（改为锚定「该路径不产生对审批 Agent 的请求」）、**§2.6** 偏差 21/22 行、**§8** 风险三行、新增 **O9**（已定案：不接受无人链路放行）。
- **N2（P1）`notExecutedReason` 漏映射**：**§4.5.3** 改动表由五处补为**六处**（新增 `notExecutedReasonForConfirmation` 补 `case 'agent-undetermined'`）；**附录 A.1** 新增 `notExecutedReason` 枚举扩展说明（新增 `'agent_undetermined'` + 四处同步 + 为何不并入 `agent_denied`）；新增 **T-R5-9** 锚定。
- **P3 修订**：P3-1（§4.5.4 需求版本改为 **v1.2**，并注明 v1.1 / v1.2 各自内容）、P3-2（`default-write-execute-ask` 注明引擎内置出处，实施者按规则表找不到）。
- **新增 §9.1 P-2 待立项**：`extraction-failed` 在 automation 下仍走审批 Agent —— 与 R5 新增的收敛规则属同一原则却行为不同；系**既有行为**、改动面涉及多类信号且需安全评估，故不在 R5 范围。
- 附录 E：**B11** 去掉错误表述、**B14** 补第六处、新增 **B16**（收敛规则 + 枚举/统计/i18n 同步 + **修正误导性过时注释**）；批 B 交付门槛同步。
**v1.8 变更**（O5 定案）：R3 参数载荷承载方式 —— 大字段**先给全文**（选择「先观察成本」）、判断核心字段保头部截断、密钥只留键名、兜底上限仅防极端值；新增 **§4.3.5 成本可观测**（审批输入 token 归属统计 + 判据一致率评测）与**后退路径**（成本过高改「检测结论 + 体量」，复用 `scriptContentSecurity`，**不做简单截断**）。
**v1.7 变更**：
- **O4 定案（全量标注）**：R2 的 `denyClass` **全量标注** —— 现网 32 条规则中会产 `ask` / `deny` / `confirm-every-time` 的 **25 条逐条标**（7 条纯放行类不标，它们不产生拒绝）；遗漏兜底 `forbidden`。落点：§4.2.2 第 3 条、§5.2 改动清单、O4 行。**理由**：部分标注会留下空洞 —— 未标规则一旦拒绝，用户又看到「没讲依据」的老文案，恰是 R2 要消灭的。
- **O6 定案（长期保留）**：R4 的新旧错误码**映射表长期保留、不设删除期限**。依据实测：`run_shell` 现网仅产出 **5 个** `SHELL_*` 码（`SHELL_PROCESS_EXIT` / `SHELL_SPAWN_ERROR` / `SHELL_TIMEOUT` / `SHELL_CANCELLED` / `SHELL_ARTIFACT_PATH_INVALID`），映射表约 5 行、只作用于历史回显 —— 删除收益≈0、删错代价真实。落点：附录 A.1（新增完整映射表 + **`SHELL-*` 诊断 caseId 不得混淆**的警示）、§4.4.2 I5、§5.4 改动清单、§8 风险行、O6 行。
**v1.6 变更**（O8 定案 + 独立待立项）：
- **O8 定为选项 3「开隐藏、护敏感」**：`--hidden` 开（`.git` / `.svn` / `.cursor` 等非敏感隐藏条目可搜 —— 显式路径自动解除隐藏过滤，或 `include_ignored: true` 一并解除）；**敏感文件（`.env` / `.env.*` / `secrets/`）在遍历中始终排除**（`include_ignored` 也不解除），**显式点名该文件则搜索**并明示「命中敏感路径」。落点：§4.6.1 新增「两类隐藏条目性质表」+ 三形态 × 三类条目语义表 + **意图强度表**（为什么批量开关不解除、显式点名解除，对齐 §2.3 判据）；§4.6.3 / §4.6.4 / §4.6.5 同步；新增 **T-R6-6**（敏感文件三形态）与 C11（跨引擎一致性断言）。
- **关键实现约束**：rg 侧无法逐文件判定，只能用 `--glob` 近似 —— 故要求**由同一份规则生成**敏感排除模式（`grepSensitiveExcludes()`），rg 与 walk **共用**，**不得各写一份**（否则重演 R1 的「同一事实多份副本」）；walk 侧另有 `isSensitivePath` 逐文件判定，并要求两引擎**跳过集合一致**。
- **新增 §9.1 独立待立项**：**P-1「敏感路径的跨工具一致」** —— `read_file` / `list_directory` 不受 `isSensitivePath()` 约束（现状消费方只有写入自动放行与 shell 路径分析；R6 落地后 grep 加入，但仅为护住 `--hidden` 后的敏感点文件）。该缺口**比 R1 更早存在**、属**安全边界**议题、处置需产品决策，故单列待立项；同时补入需求文档 §7。
- 同步：§2.3 现状注（O8 后新状态）、§8 风险两行、§9.1、附录 C 第 13/14 行与 C.2/C.3、附录 E（C1–C5 更新、新增 C11、批 C ≈6 → ≈7.5 人日、合计 ≈24.5 → **≈26 人日**）。
- **工作量变化说明**：批 C 增量主要来自「grep 首次消费敏感路径机制」（跨引擎模式生成 + walk 逐文件判定 + 一组一致性断言）。
**v1.5 变更**（O3b 定案 + 需求同步）：
- **撤销「`unsupported` 恒交人工、不经审批 Agent」**，改为**沿既有 ask 流程走审批，审批判定不了才回退人工**。落点六处：① §4.5.1 映射表 —— `unsupported` 走既有 `default-write-execute-ask`、回答者**按 lane 派生**，gate 层**零特例**；② **新增 §4.5.3「审批侧新增『判定不了』态」**（方案 B 支点）：输出合同第三态 + `ApprovalVerdict` + `parseApprovalVerdict` + `ConfirmOutcomeCause.agent-undetermined` + `AgentChannel` 三分支映射 + `FALLBACK_ELIGIBLE_CAUSES` 加一格（四维判定其余三维不动）+ **四道防滥用约束**；③ **新增 §4.5.4「三条通过形态」**（验收口径）；④ 原「边界」节顺延为 §4.5.5，补「`agent-deny` 永不回退」「`undetermined` 不得进记忆」两条；⑤ 用例扩为 **T-R5-1 ~ T-R5-8**（新增「判不了→人工」「`agent-deny` 不弹卡锚定」「缓存不进记忆」）；⑥ 附录 E 新增 **B14**（审批侧新态）/ **B15**（同步 `desktop-fail-open-to-user-plan.md`），工作量 ≈22.5 → ≈24.5 人日。
- **需求文档同步修订**：`docs/requirement/tool-invocation-reliability-requirement.md` 升至 **v1.1**（后于 v1.4 B3 处置再升 **v1.2**，新增 §7 P-1 待立项）—— R5 问题根因补第 5 条（审批层两态 + 拒绝不可回退 → 「进得去、出不来」）、R5 效果标准重写（先审批、判不了转人工）、§5.1 两条、§5.3 一条、文末新增修订记录。
- **变更理由**：原方案把「解析器读不懂」一律绕过审批，会（a）把审批 Agent **本可自行判定**的命令也推给用户、白打扰；（b）为 shell 单开一条特例通道。方案 B 复用既有「拿不到裁决 → 交给人」的正向推广（「**判定不了** → 交给人」），不新增特例，且与架构 §7.2「回答者与 lane 正交」一致。
**v1.4 变更**（评审 v1 处置）：
- **B1（P0）R5 契约修正**：撤回 `'safe' | 'danger' | 'unparsable' | 'insufficient'` 四态替换 —— `ShellSecurityVerdict` 保持既有 `'allow' | 'ask' | 'deny'` 三值**不改名**，**只新增一个 `'unsupported'`**（子原因用独立字段承载，段数超限并入）；映射表补 `ask` 行（判定不上移）；新增「消费点逐条排除 `unsupported`」要求（含 `shellCommandTrust.ts:93`/`:111` 这条**本方案自查发现的连带风险**：漏排会让无法分析的命令可加入信任列表）。
- **B2（P1）R1 口径统一**：撤销原 O7「回合边界 + 绑定变更事件」，统一为**调用边界 `refresh()`**（`workspacePathKey` 未变则返回原快照）；并说明成本与 butler 现状一致、以及可选的 `bindingEpoch` 后置优化。
- **B3（P1）R6 隐藏条目语义**：新增语义表（三形态 × 两引擎）；修正 §4.6.4「对齐 `--no-ignore`」为「`-uu`（`--no-ignore --hidden`）」；补 walk 回退的对称启发（修掉「walk 能搜 `.env`、rg 不能」的既有不一致）；**撤回 §2.3 中「敏感路径前缀对 `read_file`/`grep`/`run_shell` 一致受限」这一与代码不符的陈述**；新增 **O8**（`--hidden` 曝光面需安全拍板）。
- **P2 全部修订**：P2-1（D.2 与 §4.7.2 表格的 `show_line_number` 矛盾）、P2-2（删除与 `'rules-violated'` 重叠的 `'rule-deny'`）、P2-3（基准分歧一律「以快照为准 + 审计」，fail-loud 限开发态断言）、P2-4（`normalizeToolResultEnvelope` 的 `facts` 取源写死为同信封 `data`，并说明 `output_limit` / `timeout` / `user_cancel` 不受 I2 保护）。
- 同步：§1.2 / §5.1 / §5.5 / §7.2（T-R6-2~T-R6-5 重写）/ §8 / §9（新增第 5、6 条非目标）/ 附录 C / 附录 E（O7 定案、新增 O8、B10–B12 与 A4、C1 更新）。
**v1.3 变更**：**撤销 v1.2 的「安全类 + 永久排除」设计**（回归纯工具行为）。① 新增架构判据「默认值 vs 规则」（§2.3）：凡**不可被调用方解除**的目标限制一律归 Safety，不得由工具实现；② §4.6 全段归一 —— `GREP_SAFETY_EXCLUDES` / `GREP_PERFORMANCE_EXCLUDES` 合并为单一 `GREP_DEFAULT_IGNORES`；`GrepScope.skipped` 去掉 `klass`（不再含安全语义）；③ 用例 T-R6-4 改为「无隐藏安全语义」回归断言；④ §8 风险行、§9 非目标（新增「不新增路径访问控制」）、附录 C/E、O1/O2 同步；⑤ 明确「若日后需禁止读取版本库内部对象」属**独立需求**、须走 Safety 且跨工具一致。（**注**：v1.3 当时写的「7 个成员一致对待、全部可被显式路径或 `include_ignored` 解除、对齐 `--no-ignore`」已在 v1.4 校正为「解除方式有别」并对齐 `-uu` —— 隐藏成员需 `include_ignored`、且 `--hidden` 会解除全部隐藏条目。）
**v1.2 变更（已被 v1.3 撤销）**：曾将 `.git` / `.svn` 划为「安全类且永久不搜索」。
**v1.1 变更**：补充附录 C（需求 §5 验收项逐条对照）、附录 D（四段关键改动示例）、附录 E（任务拆解 WBS、交付门槛、待拍板项）。
**v1.0 变更**：首版（§1–§9 + 附录 A/B）。

**适用范围**：SpaceAssistant — Agent 工具调用可靠性与安全决策一致性（R1–R8）
**上游**：`docs/requirement/tool-invocation-reliability-requirement.md`
**架构基线**：`docs/develop/architect/product-architecture-design.html` §1 / §2 / §5 / §6 / §7 / §8 / §10
