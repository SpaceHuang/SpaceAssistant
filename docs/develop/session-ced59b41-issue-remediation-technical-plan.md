# 会话 ced59b41 问题清单技术方案：run_shell 能力判据与环境配置 + 中止态记录

**版本：** 0.17
**日期：** 2026-09-24
**状态：** 技术方案；第 12 轮复评（第二版）提出 4 项阻断已全部响应（v0.17），此前十一轮评审意见均已响应（v0.2 ~ v0.11、v0.14），三轮自审清理已完成（v0.12 / v0.13 / v0.15，见 §0.6），待复核
**来源：** [../requirement/session-ced59b41-issue-inventory-requirement.md](../requirement/session-ced59b41-issue-inventory-requirement.md)（问题清单 v0.6）
**关联文档：**

- [../requirement/tool-confirmation-top-level-design-v2.md](../requirement/tool-confirmation-top-level-design-v2.md)
- [../requirement/shell-output-terminal-enhancement-requirement.md](../requirement/shell-output-terminal-enhancement-requirement.md)
- [../plan/run-shell-lifecycle-local-execution-todo.md](../plan/run-shell-lifecycle-local-execution-todo.md)
- [security-approval-experience-improvement-plan.md](./security-approval-experience-improvement-plan.md)
- [message-fact-persistence-core-refactor-plan.md](./message-fact-persistence-core-refactor-plan.md)
- [run-shell-command-failure-diagnosis-and-remediation-plan.md](./run-shell-command-failure-diagnosis-and-remediation-plan.md)
- [../review/session-ced59b41-issue-remediation-technical-plan-review.md](../review/session-ced59b41-issue-remediation-technical-plan-review.md)（评审第 1 轮，两项阻断问题已在 v0.2 响应）
- [../review/session-ced59b41-issue-remediation-technical-plan-review-v2.md](../review/session-ced59b41-issue-remediation-technical-plan-review-v2.md)（评审第 2 轮，三项阻断 + 两项实施门禁已在 v0.3 响应）
- [../review/session-ced59b41-issue-remediation-technical-plan-review-v3.md](../review/session-ced59b41-issue-remediation-technical-plan-review-v3.md)（评审第 3 轮，五项阻断问题已在 v0.4 响应）
- [../review/session-ced59b41-issue-remediation-technical-plan-review-v4.md](../review/session-ced59b41-issue-remediation-technical-plan-review-v4.md)（评审第 4 轮，三项阻断问题已在 v0.5 响应）
- [../review/session-ced59b41-issue-remediation-technical-plan-review-v5.md](../review/session-ced59b41-issue-remediation-technical-plan-review-v5.md)（评审第 5 轮，模块边界问题已在 v0.6 响应）
- [../review/session-ced59b41-issue-remediation-technical-plan-review-v6.md](../review/session-ced59b41-issue-remediation-technical-plan-review-v6.md)（评审第 6 轮，`recoverTurn` 覆盖 `cancelled` 的问题已在 v0.7 响应）
- [../review/session-ced59b41-issue-remediation-technical-plan-review-v7.md](../review/session-ced59b41-issue-remediation-technical-plan-review-v7.md)（评审第 7 轮，内存状态同步与活动工具调用清理已在 v0.8 响应）
- [../review/session-ced59b41-issue-remediation-technical-plan-review-v8.md](../review/session-ced59b41-issue-remediation-technical-plan-review-v8.md)（评审第 8 轮，降级语义不等价与展示层类型冲突已在 v0.9 响应）
- [../review/session-ced59b41-issue-remediation-technical-plan-review-v9.md](../review/session-ced59b41-issue-remediation-technical-plan-review-v9.md)（评审第 9 轮，`shellOutputMode`/`spawnStdio` 接口未贯通已在 v0.10 响应）
- [../review/session-ced59b41-issue-remediation-technical-plan-review-v10.md](../review/session-ced59b41-issue-remediation-technical-plan-review-v10.md)（评审第 10 轮，T1-7 与 revalidate 回填语义矛盾已在 v0.11 响应）
- [../review/session-ced59b41-issue-remediation-technical-plan-review-v11.md](../review/session-ced59b41-issue-remediation-technical-plan-review-v11.md)（评审第 11 轮，`readonly` 的 `spawnStdio` 与 `spawn` 类型不兼容已在 v0.14 响应）
- [../review/session-ced59b41-issue-remediation-technical-plan-review-v12.md](../review/session-ced59b41-issue-remediation-technical-plan-review-v12.md)（第 12 轮复评：**未发现新的确定性阻断，可进入实现**；两项维护性门禁已落入 v0.16，见 §0.5）

---

## 0. 范围与取定

### 0.1 本文覆盖的问题项

需求清单中**明确列为现存问题**的条目，共 6 项，全部纳入本方案：

| 编号 | 问题 | 归属层 | 本方案任务 |
| --- | --- | --- | --- |
| A-1 | `run_shell` 的 TUI 交互命令检测存在假阳性 | 能力判据层 | **T-2** |
| A-2 | 计划期能力拒绝的错误信息不足以让模型自查 | 结果契约层 | **T-3** |
| A-3 | Agent 把能力层拒绝表述为安全策略层拒绝 | 模型行为（诱因在宿主信息设计） | **T-3 + T-5** |
| A-4 | TUI 判定被重复计算，渲染层不消费权威结果 | 呈现层 | **T-4** |
| A-5 | 主执行链路未将 stdin 配置为非交互，读 stdin 的命令阻塞至超时 | 执行环境层 | **T-1** |
| C-1 | 用户中止在消息层不可区分 | 记录层 | **T-6** |

### 0.2 明确不在范围内

- 需求清单**第 4 章 B-0/B-1**、**第 6 章「已改进、待观察效果」**（审批并发、配额、可解释性、O-1~O-5）——已在 `001665df` 改动或属验收观察项，本方案不改动。
- 需求清单**第 7 章待决议题（D-1~D-7）**、**第 8 章待核实项（V-1~V-7）**：不作为待办交付物。但本方案必须对其中与 A-1/A-2/A-4/A-5/C-1 直接耦合的 6 项（D-1、D-2、D-3、D-4、D-6、D-7）给出**取定结论**（否则设计无法落地），取定见 §0.3，并在各任务内说明理由与回退方式；评审若推翻取定，仅需替换对应任务内的局部实现。
- 需求清单 §9 声明未覆盖的事项（A-1 之外的能力检测、审批 Agent 裁决质量等）。

### 0.3 取定表（对应待决议题的结论性意见）

| 议题 | 本方案取定 | 落实位置 |
| --- | --- | --- |
| D-1 能力/环境拒绝是否携带归因类别 | **携带**。`diagnostic.category='environment'`，且 `details` 携带结构化命中事实 | §4.3 |
| D-2 TUI 检测的匹配口径 | **按子命令的命令位（argv[0]）匹配**，不再对整条命令文本做词匹配；参数级规则（`npm init` / `git rebase -i`）限定在对应子命令内 | §4.2 |
| D-3 中止态是否进入消息状态模型 | **新增 `MessageStatus.cancelled`**（不新增并列的 `interrupted` 字段），并让读取接口透出 `status` | §4.6 |
| D-4 审批拒绝话术中「让用户在交互式会话中对确认卡片手动批准」是否保留 | **保留**（它是真实的获批途径），但在同段补一句边界说明，区分「审批侧结论」与「能力/环境限制」 | §4.5 |
| D-6 TUI 提示是否以工具结果为唯一判据 | **是**。渲染层不再从命令文本重算；判据为 `caseId`/错误码 | §4.4 |
| D-7 `run_shell` 是否将 stdin 配置为非交互 + 词表定位 | **配置为 `['ignore','pipe','pipe']`** 并叠加展示层环境压制；**词表保留**，定位为「运行契约 + 前置引导」（不只是引导）；判据改为命令位匹配，**解析不完整时 fail-closed**（v0.3 修订，见 §4.2.6） | §4.1 + §4.2 |

### 0.4 证据口径

- 本文所有「现状」均以**当前 HEAD `e8ad2755`** 的代码为准（已逐项核对，见 §1）。
- 标注约定：【实测】= 本次调研有直接代码/仓库证据；【设计预期】= 由代码事实推得、需在实现阶段实测确认（对应需求清单 V 系列）。

### 0.5 评审响应（v0.2 ~ v0.14）

#### 第 12 轮复评·第二版（v0.17）：4 项阻断

> 说明：`docs/review/…-review-v12.md` 被第二版覆盖写入，结论由「无新增阻断」变为「暂不通过，4 项阻断」。本节记录第二版的响应；下一节的初版内容保留为历史（其结论已被取代）。

| 评审项 | 采纳 | 落实位置 |
| --- | --- | --- |
| **B1. §4.6.5 断言复核表把 `turnCoordinator.test.ts:496` 归类反了** | 是 | 该行属于 **`cancel 会进入 finishing，窗口到期后才 finalize assistant`（483 起）**，断言恰是 `status: 'failed'`——正是要改成 `cancelled` 的那类；而「source 直接返回 terminal → `completed`」是 **477 行**（468 起）。§4.6.5 表格按「行号 + 归属测试 + 断言语义 + 处理」重列，并加注 v0.12 的错误来源（张冠李戴） |
| **B2. `execute()` 的 `.catch` 分支会覆盖 `cancelled`，且不在任何清单里** | 是 | `turnCoordinator.ts:219-232` 在 `pendingFinish` 为空时**无条件**写 `status:'failed'`（226 行）与 `turns.outcome='failed'`（231 行）。§4.6.3 表格新增该行并要求**终态保护**（已是终态则保留、仅补 `error`），关键点 1 改为「不存在把 `cancelled` 覆盖为 `failed` 的代码路径」并把终态写入点由 **7 处改为 8 处**；新增 **T6-20** 锚定（含「未 cancel 的 reject 仍为 `failed`」对照） |
| **B3. 正文围栏错配，§4.2.2 要点与 §4.2.3 被吞进代码块** | 是（已修） | 围栏已全部配对（0 缩进 74 个、偶数；无「闭栏带语言标记」、无未闭合）；并额外修正两处**结构缺陷**：① 列表内代码块缩进对齐（`TUI_PROGRAMS`）；② **同节两份 `resolveShellTuiNotice` 并存**（旧的无守卫版 + v8-B2 的守卫版）——已删除旧版，避免实施者照旧版实现使 v8-B2 形同虚设 |
| **B4. `partial` 的真实触发域远大于「解析不完整」** | 是（收窄判据） | `shellAnalyzer.ts` 对含 `>`/`<`/`(`/`)`/`$(…)`/`${…}`/反引号的段 push `segment:N:shell-control-flow`（第 80 行），使 `analysisCompleteness='partial'`——**但命令位仍可判定**。§4.2.2 第 1 点新增「成因 → 命令位是否可信」对照表并要求按**条目类别**判断（建议抽 `hasUnreliableCommandPosition`），明确「**`partial` 不能直接当作不可信判据**」；§4.2.6 判定表新增「段内含重定向/命令替换 → 按命令位判定，不进 undetectable」一行；§4.2.4 矩阵补 4 例（`git log > top.log`、`git add docs/vi-usage.md > /dev/null`、`cat htop-report.md > /tmp/x` 放行；`less README.md > out.txt` 仍拒绝）；§4.2.6 要点 2 的兜底域改为「四类命令位不可信路径」 |

**同时响应的 6 项非阻断项**：M1（三处 import：`shellTuiHintLines` 的 `ShellTuiMatch`、`resolveShellTuiNotice` 所在文件的 `ToolCallResultPersisted`、`electron/database/index.ts` 的桶 re-export）、M2（T1-1 与 T1-10 同夹具同断言 → 删除 T1-1，T1-10 为该命令唯一定义处）、M3（T1-8 误引「§4.6.1」→ 改为 §4.1.2（5）/§4.1.4）、M4（telemetry `diagnostic.category` 实际是**键被 delete**，断言按序列化口径）、M5（`shellTuiFallbackHintLines` 的删除范围与「保留」措辞更正）、M6（**复核后确认 0.14 行在当前版本已存在且表格完整**，该条已不成立）。

#### 第 12 轮复评·初版（v0.16）：无新增阻断 + 两项落地门禁

复评结论：**v0.15 未发现新的确定性阻断问题，可以进入实现阶段**。本节记录其提出、并由 v0.16 落成可编译/可核对约束的两项维护性门禁（均为「实现时须守住」，非方案缺口）。

| 门禁 | 内容 | 落实位置 |
| --- | --- | --- |
| **门禁 1. `caseIdForPlanError` 的 `default` 不得静默承载新增错误码** | 原稿的 `case 'SHELL_PLAN_INVALID': default:` 使「新增 `RunShellPlanErrorCode` 成员却忘记补映射」时 TS 不报错，会静默落入 `SHELL-PLAN-001`（错误 caseId 进审计与模型 payload）。**要求：保留逐项映射意图，并让新增成员的编译或测试门禁显式失败** | §4.3.2 改为**穷尽 switch + `default` 中 `never` 断言**（保留运行时兜底，同时把漏改变成编译错误）；同族 `diagnosticForPlanError` 的 `if` 判断补配套约束（新增「能力/环境」类 code 必须同时加入判据，由 T3-4 的逐项契约表覆盖） |
| **门禁 2. 两个 fingerprint 的职责边界** | `buildPlannedShellEnvironment` 返回的 `fingerprint` 是**源环境解析快照**；最终执行环境仍由 `PreparedShellExecution.environmentFingerprint` 对**完整环境**摘要负责。二者不得互换，也不得在 plan/revalidate 侧另行调用 `resolveShellEnvironment`，否则重新引入确认等待后的 `PLAN_STALE` 漂移 | §4.1.5 第 1 点新增「两个 fingerprint 的职责边界」表（来源 / 语义 / 用途 + 两条约束）；该风险既有 T1-5/T1-6 与 §7.6 同源门禁覆盖 |

**同时记录：三类「不应追加的要求」**（复评明确排除，避免后续评审反复）：

1. 不要求把 `run_script` 的同类 stdin 风险并入本任务（方案已列为可选附带项，§4.1.6）；
2. 不要求一次性搬迁全部 `SHELL_CASE_IDS` 到 shared（当前只搬迁跨层实际消费的契约，§4.4.2）；
3. 不要求为 telemetry 恢复 `diagnostic.category`（由稳定 `caseId` 承担区分职责，§4.3.5），也不要求强行合并两种工具调用降级策略（§4.6.3 4e）。

**通过建议（实现前后逐项留存）**：`npm run typecheck:shared`、`npm run typecheck:renderer`、`npx tsc -p tsconfig.electron.json --noEmit`，以及 §7.1~§7.4 所列回归——尤其 **T1-7/T1-7b、T1-8、T3-5、T6-7、T6-13/T6-14/T6-17/T6-19**。

#### 第 11 轮（v0.14）：一项阻断性编译缺口

| 评审项 | 采纳 | 落实位置 |
| --- | --- | --- |
| **B1. `readonly` 的 `SpawnStdio` 不能原样传给 `child_process.spawn`**：本仓库 `@types/node` 的 `type StdioOptions = IOType \| Array<IOType \| "ipc" \| Stream \| number \| null \| undefined>` 要求**单个 `IOType` 或可变数组**；`readonly ['ignore','pipe','pipe']` 两者都不满足 → §4.1.2（5）的 `spawn(..., { stdio: prepared.spawnStdio })` 必然编译失败，§7.6 要求的 Electron typecheck 无法通过。**附带**：因 `SpawnStdio` 只有一种合法取值，T1-7 中「构造不同的 `current.spawnStdio`」在正常类型下**不可表达** | 是（**保留 readonly 语义**，在唯一边界处做一次可变副本；T1-7 明确测试层级） | §4.1.2（1）新增「与 Node `spawn` 的类型边界」说明（为何保留 `readonly`、边界适配点的唯一位置）；§4.1.2（5）改为 `stdio: [...prepared.spawnStdio]`；§7.2 T1-7 拆为「`shellOutputMode` 正常类型构造 + `spawnStdio` 运行时边界构造（显式标注、**不得放宽生产类型**）」；§7.6 补 v11 证明要求；§0.6 模式二补判据「外部 API 签名兼容性」 |

**通过条件对应关系（评审 v11）**：① 修正 `spawn` 调用处的数组可变性 → §4.1.2（5）的 spread 与 §7.6 门禁（Electron typecheck 通过）；② T1-7 的 stdio 断言与单值生产类型一致 → §7.2 T1-7 的两层拆分（`spawnStdio` 分支标注为运行时边界测试，生产类型不放宽）。

#### 第 10 轮（v0.11）：一项阻断性矛盾

| 评审项 | 采纳 | 落实位置 |
| --- | --- | --- |
| **B1. T1-7 与 revalidate 的冻结语义互相冲突**：revalidate 内部恒以 `prepared.shellOutputMode` 回填 `current`，因此 `reasons` 永不可能含 `shellOutputMode`；而 T1-7 要求「以不同模式显式重验证 → `reasons` 含 `shellOutputMode`」——按正文实现则 T1-7 永远失败，为让它通过又会重新引入「实时配置与冻结计划分裂」 | 是（取报告**第一个选项**：只改测试口径，不扩大运行时设计） | **T1-7 拆为两级**：**T1-7（契约存在性 · 单元层）** 直接调用 `validatePreparedShellExecution`，构造不同的 `current.shellOutputMode`/`current.spawnStdio` 断言 `reasons` 含对应键；**T1-7b（回填不变量 · 集成层）** 断言 `revalidatePreparedShellExecution` **始终回填快照值、不产生该 reason**（§7.2）。§4.1.2 第 4 点注脚、§4.1.5 第 4 点、§6 P0-2、§7.6、§8 风险表同步改为两级表述 |

**取定理由**：`shellOutputMode` 是**冻结计划内部不变量**（§4.1.5 第 3 点已取定：确认期间模式变化不使计划失效）。因此「该字段参与重验证契约」应由 **`validatePreparedShellExecution` 的单元测试**证明（它能被以不同值调用），而 revalidate 的正确行为恰恰是**永不产生该 reason**——后者由 T1-7b 显式断言。原稿把两件事混在一条用例里，才出现「要求一个不可能发生的结果」的矛盾。

**通过条件对应关系（评审 v10）**：T1-7 与 revalidate 的职责边界统一 → §7.2 的两级拆分与 §4.1.2 第 4 点注脚一致；测试按取定语义落地 → T1-7（单元）+ T1-7b（集成），不动 revalidate 签名与回填行为。

#### 第 9 轮（v0.10）：一项阻断性实现缺口

| 评审项 | 采纳 | 落实位置 |
| --- | --- | --- |
| **B1. `shellOutputMode`/`spawnStdio` 未真正贯通 plan 快照与重验证接口**：正文只在散落处说「扩展为附加 `shellOutputMode`」，但三处权威片段未同步——`planRunShellExecution` 的 ctx Pick 缺该字段、`prepareShellExecution({...})` 调用未显式写入两字段、`validatePreparedShellExecution` 的 `current` Pick 不含两字段（却要求比较它们） | 是 | §4.1.2 重写为**唯一接口定义处**，一次给全四处：(1) `PreparedShellExecution`/`PreparedShellInput`（两字段**必填** + 必填理由）；(2) `validatePreparedShellExecution` 的 `current` Pick 扩展与两个比对项（去掉 `??` 兜底）；(3) `planRunShellExecution` 的 ctx 收窄 + `prepareShellExecution` 显式写入 + `SPAWN_STDIO_NON_INTERACTIVE` 常量；(4) revalidate 从快照回填。§4.1.4 改为**引用**该定义（消除两份声明），§4.1.5 第 2 点指向同一节；§7.6 新增 v9 证明要求（含 `typecheck:shared` + `tsc -p tsconfig.electron.json --noEmit`） |

**通过条件对应关系（评审 v9）**：接口/构造一致 → §4.1.2 四处片段同源 + §6 P0-1 的编译期锚定 + T1-5/T1-7b；实现片段、实施表与测试使用同一字段边界 → §6 P0-1/P0-2 与 §7.2 T1-5/T1-7/T1-7b 均引用 §4.1.2，不再各自表述（T1-7 的层级见第 10 轮响应）。

#### 第 8 轮（v0.9）：两项确定性阻断

| 评审项 | 采纳 | 落实位置 |
| --- | --- | --- |
| **B1. 共用工具调用降级函数会改变既有恢复行为**：`streamingCleanup.downgradeToolCall` 与 `recoverPersistedTurn` 的**内联**实现语义**不等价**（原稿声称「同一个降级函数」并据此提取，属事实错误） | 是（**只共享常量与判定，不共享策略函数**） | §4.6.3 4(e) 整段重写：逐条列出**四处差异**（已终态+无 result、进行中+有 result、`completedAt`、已终态+有 result）；`toolCallInterruption.ts` 只导出 `INTERRUPTED_TOOL_CALL_ERROR` 与 `isInterruptedToolCallStatus`；新增独立纯函数 **`degradeInterruptedToolCallsWithRecoverSemantics`**（在 `operations.ts` 内，按 `recoverPersistedTurn` 语义）；**`recoverPersistedTurn` 本轮不重构**（撤销原「内部提取」写法）；新增 **T6-19** 做对称对照 |
| **B2. 展示层直接展开普通字符串，与受限枚举类型冲突**：`ShellResultData.tuiUndetectable.reason` 是 `string`，`...spread` 进 `ShellTuiNotice`（受限联合类型）会使 `typecheck:renderer` 失败 | 是 | §4.4.3 新增「类型收窄」小节：给出**显式类型守卫**（reason 白名单来自 `SHELL_TUI_UNDETECTABLE_REASONS`，`programs` 逐项校验 + `slice(0, 8)`，`tuiMatch` 同理走 `SHELL_TUI_RULES`）；明确 `parseShellResultData` **不改动**（守卫生效前其字段仍是 `string`）；新增 **T4-1** 用例，并纳入 `typecheck:renderer` 门禁 |

**通过条件对应关系（评审 v8 两条）**：① 降级语义不变 → §4.6.3 4(e) 的四处差异表 + `recoverPersistedTurn` 不重构 + T6-19；② 展示层类型合法 → §4.4.3 类型守卫 + T4-1 + `typecheck:renderer` 通过。

#### 第 7 轮（v0.8）：两项阻断问题

| 评审项 | 采纳 | 落实位置 |
| --- | --- | --- |
| **B1. 分支① 只更新数据库，未同步协调器内存中的活动 turn**：`updateIfStreaming` 只改持久化消息；`this.turns` 里仍是 `streaming` 的 `TurnStarted` 未收敛，`listActive()` 仍会返回它，`cancel()`/`execute()` 仍视其为活动 | 是 | §4.6.3 关键点 4 新增 **(d) 内存状态同步**：抽出私有辅助 `convergeTurnToTerminal(turnId, outcome)`（统一更新 `this.turns` 的消息状态与 `persistedOutcome`、写入 `this.terminals` 索引），**第一阶段与分支① 共用同一辅助**；并明确 **`listActive()` 必须同批改为 `isTerminalMessageStatus`**（否则 `cancelled` 仍会被列为活动，B1 只是换了个表现）；T6-11b 改为「从真实活动内存 turn 开始」并断言 `listActive()` 不含它、重复 `cancel()` 返回 `false` |
| **B2. 分支① 绕过既有工具调用清理，可能遗留活动子任务**：`recoverPersistedTurn` 还会把 `calling`/`confirming`/`executing` 的 `toolCalls` 降级为中断失败；分支① 只调 `updateIfStreaming` 会留下「消息已 `cancelled`、工具调用仍 `executing`」的持久化状态 | 是 | §4.6.3 关键点 4 新增 **(e) 工具调用清理**：`TurnStorage` 新增可选端口 `finalizeResidueMessage?(messageId, targetStatus)`，由 electron 侧实现 **`finalizeResidueMessageKeepingOutcome`**——复用与 `recoverPersistedTurn` **同一个**降级纯函数（提取到 `electron/database/toolCallInterruption.ts`，两处共用，满足「同一语义不得两处声明」），且**完全不触碰 `turns` 行**；新增 **T6-17**（带 `executing` 工具调用的残留 → 补偿后消息 `cancelled`、`turns.outcome` 仍 `cancelled`、无活动工具调用） |

**通过条件对应关系（评审 v7 三条）**：① 分支① 的内存同步 → §4.6.3 4(d) + T6-11b；② 工具调用清理且不覆盖 outcome → §4.6.3 4(e) + T6-17；③ DB 与内存两侧断言 → T6-11b/T6-15/T6-17 的断言清单逐条覆盖两侧（§7.4、§7.6）。

#### 第 6 轮（v0.7）：阻断问题

| 评审项 | 采纳 | 落实位置 |
| --- | --- | --- |
| **`recover()` 的取消补偿在「有内存归属」分支仍写成 `failed`**：v0.5/v0.6 的残留循环在有内存归属时调用 `this.storage.recoverTurn(owned.turnId, message.id)`，而现有 `recoverPersistedTurn()` 固定写 `status:'failed'` 且把 `outcome` 覆盖为 `'recovered'` → `cancelled` 事实被抹掉、G6-b 失败 | 是（**协调器侧三分支分派，不改存储层契约**） | §4.6.3 关键点 4 新增 **(c)**：列出 `recoverPersistedTurn` 的三处冲突（含行号），给出分支 ①（有 outcome → 只改消息、**绝不调用 `recoverTurn`**）/ ②（无 outcome → 沿用既有语义）/ ③（turn 已 terminal 且 outcome 为 NULL → 兜底收敛为 `failed`）；T6-11 拆为「无内存归属 / 有内存归属」两变体，新增 **T6-15**（spy 断言 `recoverTurn` 未被调用 + `turns.outcome` 仍为 `cancelled`）与 **T6-16**（分支 ③） |

**附带核对到的一层（报告未列，但必须一并处理）**：`recoverPersistedTurn` 的 turn 查询限定 `state IN ('configuring','prepared','executing','waiting-confirm')`（`electron/database/operations.ts:729`）。当 turn 已经是 `terminal`（`finalizeFinishing` 已写 `outcome='cancelled'`，正是 checkpoint 失败后最可能的库状态）时该函数**返回 `false`**，消息既不变 `cancelled` 也不变 `failed`，而会**永久停留 `streaming`**。因此「仅给该函数加 `targetStatus` 参数」不足以闭合——必须由协调器按 outcome 分派（分支 ①/③ 均不经过该函数）。

#### 第 5 轮（v0.6）：模块边界问题（阻断）

| 评审项 | 采纳 | 落实位置 |
| --- | --- | --- |
| **`SHELL_TUI_UNDETECTABLE_REASONS` 定义层级与使用层级冲突**：v0.5 把它定义在新增的 `electron/shell/shellTuiDetection.ts`，却要求 `src/shared/processResultProjection.ts` 引用 → shared 层反向依赖 electron（连带 `shellCommandParser`/`shellAnalyzer`），破坏 shared/renderer 边界；若在 shared 另抄一份则回到白名单漂移 | 是（**常量与类型下移 shared 纯模块**） | 新增 **`src/shared/shellTuiContract.ts`**（仅常量与类型，零运行时依赖）：`SHELL_TUI_RULES`/`ShellTuiRule`、`SHELL_TUI_UNDETECTABLE_REASONS`/`ShellTuiUndetectableReason`、`ShellTuiMatch`。`electron/shell/shellTuiDetection.ts` 与 `src/shared/processResultProjection.ts`、`src/shared/shellToolDisplay.ts` **均从该模块引用**（§4.2.2 / §4.3.5 / §4.4.2）；仍未消除 `ShellTuiRule` 字面量在 shared 层重复书写的问题，本次一并收口 |

**为什么这条是阻断（本方案的机械证据）**：仓库已有现成门禁会直接拦下该错误依赖——`tsconfig.renderer.gate.json`（`npm run typecheck:shared`）只 `include: ["src/shared/**/*.ts"]` 且 `exclude: ["electron/**/*"]`，`tsconfig.renderer.json` 同样 `exclude: ["electron/**/*"]`。shared 若 import electron 模块，**两次类型检查都会失败**（模块不可解析）。当前 `src/shared/**` 对 `electron` 的导入数为 **0**，本方案不应成为第一个破坏者。

#### 第 4 轮（v0.5）：三项阻断问题

| 评审项 | 采纳 | 落实位置 |
| --- | --- | --- |
| **B1. 两个新增的 `undetectable` 原因被投影层丢弃**：v0.4 给 `ShellTuiVerdict.reason` 加了 `nested-command-unresolvable`/`recursion-depth-exceeded`，但 `projectTuiUndetectable` 的白名单仍是四值 → 整个 `tuiUndetectable` 分支被丢弃，G2/T3-3 的契约不成立 | 是（并消除同类漂移） | 原因枚举提取为 **`SHELL_TUI_UNDETECTABLE_REASONS` 单一事实来源**（§4.2.2，类型与投影校验共用）；`projectTuiUndetectable` 改为按该集合构造 Set 校验（§4.3.5）；新增 **T3-5**（六个合法值逐一保留 + 两个新增值的真实投影结果各一例）；§7.6 门禁补「合法值全量保留」要求 |
| **B2. 恢复补偿被 `recover()` 的提前返回跳过**：`turnCoordinator.ts:397` 的 `if (unfinished.length > 0) return recovered` 使「有未完成 turn」时残留分支不执行；且 `listRecoverableResidues?.() ?? []` 在方法缺失时得空数组，**未回退** `listStreaming()` | 是 | §4.6.3 关键点 4 改写：**移除该提前返回**（两阶段始终都跑，计数累加），并给出三档回退（新方法 → `listStreaming()` 映射 → 空数组）与 `recovered` 去重语义说明；新增 **T6-13**（同库同时存在「未完成 turn」与「已记 `cancelled` 的 streaming 残留」）与 **T6-14**（旧存储夹具：不提供新可选方法时必须回退 `listStreaming`） |
| **B3. P0 实施表仍要求从实时 ctx 读输出模式**：正文 §4.1.4 要求执行层从 `prepared.shellOutputMode` 读取（T1-8 也如此测试），但 P0-3 写的是 `isTerminalShellOutputMode(ctx.shellOutputMode)` —— 按实施表开发会重现「冻结环境 vs 实时 raw 判定」分裂 | 是 | §6 P0-3 改为 `isTerminalShellOutputMode(prepared.shellOutputMode)`；P0-2 措辞明确为「**plan 阶段读 ctx 一次并冻结**，执行层与 revalidate 一律读快照」；§7.6 门禁补「实施表与正文一致」的核对项 |

#### 第 3 轮（v0.4）：五项阻断问题

| 评审项 | 采纳 | 落实位置 |
| --- | --- | --- |
| **B1. 通用计划失败分支把所有错误标成 TUI 环境拒绝**：v0.3 的返回体示例让 `SHELL_PLAN_INVALID`/`SHELL_DIALECT_MISMATCH`/`SHELL_EXECUTABLE_UNAVAILABLE` 也落到 `SHELL-CAPABILITY-001` + `retryable:false` + `category:'environment'`，破坏方言错配的「可改写重试」语义与 G2/G3 归因 | 是 | §4.3.2 返回体改为**按 code 显式映射**：`data.caseId` 保留既有四分支 + 新增 `tuiUndetectable`；`diagnostic` **仅对两类 TUI 错误写入**，其余计划错误维持既有语义（不写 `diagnostic`）；§7.2 新增 **T3-4**（五种 code 逐项契约测试，两类 TUI 错误校验 `data.caseId === diagnostic.caseId`，其余校验**不出现** `diagnostic` 且 `retryCount`/`retryExhausted` 行为不回归） |
| **B2. 一层包装命令穿透不足以实现运行契约**：`env sudo vim f`、`command env less f`、`bash -c 'vim f'`、`eval 'top'` 都是可解析命令，穿透一层后返回 `clear`，绕过判据 | 是 | §4.2.2 第 2 点改为**有界递归穿透（深度上限）** + 新增第 5 点**二次解释边界**（shell 解释器 `-c`、`eval`、`sudo … sh -c`）：字面量则递归分析内部命令，含变量/命令替换且文本含词素则 `undetectable`，超出深度上限亦 `undetectable`；§4.2.4 矩阵补 6 例（含不误伤对照）；§4.2.5/§4.2.6 声明**保证范围**（深度上限内闭合，上限外 fail-closed）；§7.1 补该类矩阵 |
| **B3. telemetry 期望 JSON 与投影规则不符**：`STABLE_CODE_RE = /^[A-Z][A-Z0-9_.-]{2,127}$/` 不匹配小写 `environment`，telemetry 必丢 `category`，而 v0.3 的 ③ 却写它存在 | 是（取定：**telemetry 不保留 `category`**） | §4.3.5 增「diagnostic 在 telemetry 的实际投影」推导（`caseId` 保留、`category` 丢弃、`retryable` 因是 boolean 保留）并说明取定理由；§4.3.6 的 ③ 修正为**不含 `category`**；T3-3 改为「以真实 `projectTelemetryToolResult` 输出为基准的逐字段比对」；若未来需要，改为固定枚举白名单（§10 第 9 条） |
| **B4. checkpoint 最终失败与「重启后仍为已停止」互相冲突**：全部重试失败时 DB 不可能已持久化 `cancelled`；且残留消息会被 `recover()` 置回 `failed` | 是（新增**补偿路径**） | §4.6.3 新增 `recover()` 的按 outcome 修正（新增 storage 查询 `listRecoverableResidues`，以 `turns.outcome` 重建消息状态）；§7.4 拆为 **T6-7（成功/重试后成功 → 重启后 DB 为 `cancelled`）**、**T6-10（最终失败 → 置 `checkpointFailed`，不假装成功）**、**T6-11（最终失败 + `turns.outcome='cancelled'` 已落库 → 下次启动补偿为 `cancelled`）**；§9 G6 分 a/b/c 三级并**明确承认**「两处 DB 写都失败时无法保证」 |
| **B5. G5 仍含无法稳定验证的外部环境行为**：`psql`/`redis-cli`/`fzf` 受本机安装、配置、网络、tty 影响 | 是 | §2.1 G5 改为**可证明的 fd0 契约**（子进程读 stdin 立即 EOF）；§4.1.8 拆为「确定性契约表（纳入 G5）」与「外部环境观察表（不做承诺）」；§7.2 用 `/bin/sh -c 'read'`、`cat`、`python3`（可用时）作确定性用例；§9 G5 与 §4.1.8 使用**同一验收集合** |

#### 第 2 轮（v0.3）：三项阻断 + 两项实施门禁

| 评审项 | 采纳 | 落实位置 |
| --- | --- | --- |
| **B1. TUI 解析失败 fail-open 会使能力拒绝边界失效**：解析不完整时静默放行，`vim`/`less` 包在无法解析的构造里即可绕过；且 `stdin=ignore` 不能替代能力判定 | 是（改为 **fail-closed 分层**） | §4.2.2 判定结果改为三态（`match` / `clear` / `undetectable`）；**§4.2.6 整节重写**：解析不完整时若命令文本出现 TUI 词素 → 抛新增 `SHELL_TUI_UNDETECTABLE`（不可执行、`category='environment'`、`retryable=false`），不静默放行；词表定位由「引导设施」上升为「运行契约 + 引导」（§4.2.5）；G1/G4、§7.1 矩阵、§8 风险表同步改写 |
| **B2. `ssh` 快速失败的验收承诺不可由环境变量保证**：`SSH_ASKPASS=''` ≠ `BatchMode=yes`，行为取决于版本/配置/网络/tty | 是（承诺拆分） | §4.1.3 更正 `SSH_ASKPASS` 的作用域（仅影响 GUI askpass 选择）；§4.1.8 把 `ssh` 拆为「**可控断言**（`ssh -o BatchMode=yes -o ConnectTimeout=2 -o StrictHostKeyChecking=no 127.0.0.1`，仅验证宿主不因 stdin 阻塞）」与「**移出 G5 的观察项**（裸 `ssh host` 不做承诺）」；§7.2 T1-9 为可控断言用例 |
| **B3. `tuiMatch` 的 telemetry 契约自相矛盾**：“不落自由文本”与“键仍在”不能同时成立 | 是（取唯一结论：**telemetry 完全丢弃**） | §4.3.5 明确 `projectTuiMatch` 在 telemetry 出口直接 `continue`（丢弃），telemetry 只保留既有 `caseId`；§4.3.6 给出 **agent / local_history / telemetry 三份精确期望 JSON**；T3-3 与 G2 的模糊断言替换为逐字段比对 |
| **门禁 4. 输出模式冻结必须由代码测试证明**：执行层仍在 `runShellExecutor.ts:217` 从 ctx 判定，可能与环境来源分裂 | 是 | §4.1.4 追加硬约束：执行层 `terminalMode` **必须从 `prepared.shellOutputMode` 读取，不得读 ctx**（从根上消除分裂）；T1-5/T1-6 补断言实际发送的 raw/plain progress（不只看 `PLAN_STALE`）；新增 T1-8（ctx 与快照不一致时以快照为准） |
| **门禁 5. `cancelled` 必须覆盖 checkpoint + 恢复 + 读取闭环**：只测内存 `getTerminal()` 不足以证明 G6 | 是 | §4.6.4 明确读取接口**两个分支**（含长消息截断分支）都必须返回 `status`；§7.4 的 T6-6/T6-7 扩展为「checkpoint 最终失败 → 重启 → 查 DB 实际值」；新增 T6-9（截断分支 `status`）；§7.6 门禁写明 `git diff --check` 与断言复核 |

#### 第 1 轮（v0.2）

评审结论为「需修改后实施」，两项阻断问题**全部采纳**，落实位置如下：

| 评审项 | 采纳 | 落实位置 |
| --- | --- | --- |
| **1. 输出模式未冻结**：仅新增 `spawnStdio`，模式既未进入 prepared 快照，`revalidate` 也无处取模式 → `terminal` 计划经确认后必然 `PLAN_STALE` | 是 | §4.1.4 改写为「有效输出模式进入 plan 冻结」（新增 `PreparedShellExecution.shellOutputMode`、`isTerminalShellOutputMode` 共享判定、缺省口径与执行层同源）；§4.1.5 明确 revalidate **从快照读模式**构造环境、`shellConfigRevision` 有意不含 `outputMode`、以及确认期间设置变化的取定行为；由 T1-5/T1-6/T1-7 三个用例锚定（§7.2） |
| **2. 中止态漏 `finishCheckpoint()`**：该函数只认 `completed`/`failed` 为终态，新增 `cancelled` 会绕过三次重试上限与 `checkpointFailed`，与 G6 的持久可识别目标冲突 | 是 | §4.6.3 新增该行并要求改用 `isTerminalMessageStatus`；§4.6.5 更新改动清单、检索命令与「既有断言复核」清单；§7.4 新增「取消后终态 checkpoint 连续失败」用例；§7.6 门禁补断言复核要求 |

评审未提出的两处口径问题，本版一并修正（属同一根因，不新增风险）：

- **缺省模式口径**：原稿写「缺省视为 `plain`（更保守的一侧）」但未说明它与 `resolveEffectiveShellOutputMode` 的缺省 `'terminal'` 关系。现明确：plan 与 `runShellExecutor.ts:217` 的 `terminalMode` **共用同一判定函数**，缺省（测试夹具/直调）一律 `plain`；真实链路（`toolChatLoop.ts:942`）总是传入已解析值，故两处不会打架。
- **`execute()` 的 `acceptedOutcome`**：原稿只改了 `status` 计算，未处理 `alreadyTerminal && status === 'completed' ? 'completed' : terminal.outcome` 这一处（在 `cancelled` 下会回退成 source 报告值）。现补 `outcomeForMessageStatus()` 映射（§4.6.3）。

---

### 0.6 自审清理（v0.12 / v0.13 / v0.15 / v0.17）

**动因**：两轮评审各暴露出一类**可复用的缺陷模式**（v10 是「断言要求不可能或不可达的结果」；v9 是「散文提了要求，但可编译的权威片段未同步或压根没给」）。评审报告只覆盖它恰好读到的那条，因此本节记录以这两类模式对全文的自查结果。**

#### 模式二：要求已写在散文里，但权威片段（可编译的接口/签名/定义）未同步或缺失

判据：**凡是文中出现「改造点/新增函数/扩展枚举/新增端口」，都必须能在同一份文档里指出它的权威定义片段，且该片段与调用点、测试一致。** 只写「同步扩展」「抽一个 X」而不给定义，等于把漂移留给实施者。

**v0.14 追加的一条（评审 v11 B1 的推广）**：**凡是要传给外部 API（Node/Electron/第三方类型）的值，必须核对目标签名的兼容性——包括只读/可变、字面量宽度、可选性。** 本方案中至少两处曾在此类边界出问题：① 受限枚举类型直接展开宽松解析字段（v8-B2，§4.4.3）；② `readonly` 元组直接传给要求可变数组的 `spawn`（v11-B1，§4.1.2）。**处理方式统一为「在唯一边界处适配，放宽生产类型或加断言都不允许」**，并由类型检查（`typecheck:shared` / `typecheck:renderer` / `tsc -p tsconfig.electron.json --noEmit`）作为机械门禁。

**v0.13 复查结果（5 处，均为「散文有要求、片段缺失或不一致」）**：

| # | 位置 | 问题 | 修正 |
| --- | --- | --- | --- |
| 1 | **`buildPlannedShellEnvironment`** | 只在 §4.1.5 写「抽 `buildPlannedShellEnvironment(command, mode)`」，**无定义**；且签名与两处调用所需输入不匹配（两处都需要 resolved env，plan 还需 `environmentFingerprint` 喂 `dependencySnapshot`）——按片段实施无法编译或必然漂移 | §4.1.5 第 1 点给出**完整定义**（`{ env, fingerprint }` 返回值 + 内部 resolve）、§4.1.2 plan/revalidate 片段改为解构使用；并说明签名为何是 `(command, mode)` |
| 2 | **`RunShellPlanErrorCode` 扩展** | §4.2.6 只写「`RunShellPlanErrorCode` 同步扩展」，**未给扩展后的定义**；§1.1 引用的是现有四成员版本 → §4.2.3 的 `throw` 与 `caseIdForPlanError` 均无法编译 | §4.3.2 给出**扩展后的完整定义（唯一一处）**含 `SHELL_TUI_UNDETECTABLE` |
| 3 | **读取接口两条 return 路径** | 散文要求「**两个分支都必须返回 `status`**」，但片段只有一行 `return`——按片段实施必漏截断分支（门禁 5 白写） | §4.6.4 给出**两条 return 路径的完整片段** |
| 4 | **electron 侧 `shellCaseIds.ts`** | §4.4.2 散文写「新增 `tuiUndetectable`，以 `import` 复用 shared 常量」，**无片段** | §4.4.2 补 electron 侧 delta 片段（含 `tuiRequiresTerminal` 改为引用 shared） |
| 5 | **`shellEnvOverrides.ts` 的文件归属** | §4.1.3 写「新增 `electron/shell/shellEnvOverrides.ts`（**或并入**既有 `shellSpawnEnv.ts`）」——「或」即定义位置不明，与 v9 的 `shellOutputMode` 未贯通同型 | §4.1 开头明确**唯一归属**（新文件；`shellSpawnEnv.ts` 不改动），删去「或并入」 |

#### 模式一：断言要求不可能或不可达的结果（v0.12）

11 处（含 T1-2 必失败、T1-8 入口不可达、T6-19 目标未导出、T6-12 分支前提不匹配、§4.6.5 复核表与实际代码不符等），逐条见 §11 修订记录 0.12 行。判据：

1. **可达性**：断言的对象函数是否**已导出**、可被测试直接调用？
2. **层匹配**：该断言落在**能引起该结果的那一层**吗？
3. **条件完备**：前置条件是否覆盖**全部**分支前提？
4. **清单与代码一致**：复核表的行号与期望值是否**逐条对照过实际测试代码**？
5. **不重复**：两条用例是否共享同一夹具与同一断言？

**同时明确**：两轮自审只改**测试口径、文档片段与表述**，不改变任何运行时设计（三条设计取定——`shellOutputMode` 冻结、三分支补偿、降级语义各自独立——均保持）。

#### 模式三：片段缺「编译所需的最小上下文」（v0.15）

**v11-B1（readonly 元组不能传给 `spawn`）是模式二的一个特例**：它不属于「要求没写成片段」，而属于**「片段本身写全了，但把那行代码单独放进真实文件后无法编译」**。据此对全文再做一轮，凡新增/改动的代码片段，逐个核对「该片段放进目标文件后，所需的 import、类型引用、命名是否齐备」：

| # | 位置 | 缺什么 | 修正 |
| --- | --- | --- | --- |
| 1 | `processResultProjection.ts` 的投影片段 | import 只有两个**值**（`SHELL_TUI_RULES`、`SHELL_TUI_UNDETECTABLE_REASONS`），但 `projectTuiMatch`/`projectTuiUndetectable` 的**签名**引用了 `ShellTuiRule`/`ShellTuiUndetectableReason` 两个类型 | §4.3.5 的 import 行补 `type ShellTuiRule, type ShellTuiUndetectableReason` |
| 2 | `src/shared/messageStatus.ts` 的 `messageStatusForTurnOutcome` | 入参**内联重写**了 `TurnOutcome` 联合，而该类型已由 `assistantFactAggregator.ts:4` 定义——违反 §4.4.2 自己确立的单一来源原则，且 `TurnOutcome` 扩展后失败点会落在调用方而非本函数 | §4.6.2 改为 `import type { TurnOutcome } from './assistantFactAggregator'`；并声明与 `UsageTurnOutcome`（多一个 `'interrupted'`）的边界 |
| 3 | `TurnStorage.finalizeResidueMessage` 与 `listRecoverableResidues` | 用到 `MessageStatus`，而 `turnCoordinator.ts` 现为 `import type { Message } from './domainTypes'` | §4.6.3 4(b) 注明该 import 需扩为 `{ Message, MessageStatus }` |
| 4 | `operations.ts` 的新降级函数 | 用到 `ToolCallRecord`，而该文件现从 domainTypes 只引入 `Message, MessageStatus, Session` | §4.6.3 4(e) 给出补齐后的 import 行 |
| 5 | `turnCoordinatorStorage.ts` 的端口绑定 | 需从 `./database` 引入新增的 `finalizeResidueMessageKeepingOutcome`（该文件以逐个具名方式导入） | §4.6.3 4(e) 第 5 点注明须加入既有具名 import 列表 |
| 6 | `shellTuiUndetectableHintLines` | §4.3.4 只给了 `shellTuiHintLines(match)` 的定义，`hints(undetectable)` 一路被引用却**无定义片段**，且其入参须与 `details.tuiUndetectable`（`{ reason: string; programs: string[] }`）匹配 | §4.3.4 补完整定义（六个 reason 分支 + 通用退化 + 3 条 ≤512 字符约束） |

#### 模式四：同一符号在文档内存在两份定义（v0.17）

**v12 的 B3/B4 之外，复核中另发现一处同类结构缺陷**：§4.4.3 同时存在**无类型守卫的旧版 `resolveShellTuiNotice`** 与 **v8-B2 新增的守卫版**——两份同名定义并存，实施者照旧版写即丢掉了 v8-B2 的修复。判据（与模式二/三互补）：

**同节内同名符号只允许一份定义**；若某轮以「新增片段」方式修订既有片段，必须**同时删除/标记旧片段**，而不是并列。自查方式：对每个新增/修订的函数或类型名，`grep` 该名称并确认「定义行」只有一处（引用行可多处）。

判据（与模式二互补）：**片段级**——把片段放进目标文件，import / 类型引用 / 命名是否齐备？**行级**——该行的值要传给什么签名，类型是否兼容（readonly/可变、字面量宽度、可选性）？两级都属于「文档可编译性」，验收手段都是三项类型检查。

---

## 1. 现状复核（HEAD `e8ad2755`）

### 1.1 逐项复核结果

| 编号 | 需求清单所述 | 当前 HEAD 核对 | 结论 |
| --- | --- | --- | --- |
| A-1 | `src/shared/shellInteractiveTui.ts` 全文匹配 11 条正则 | 文件自基线 `a6959a75` 起**逐字节未变**（`git diff a6959a75 HEAD -- src/shared/shellInteractiveTui.ts` 为空）；`INTERACTIVE_TUI_PATTERNS` 仍为整条命令文本 `re.test(t)` | **仍存在** |
| A-1 | 计划期在 spawn 前抛出 | `electron/tools/runShellPlan.ts:102-103` 仍在 `assertExecutableAvailable` 与方言检测之间抛出，`details` 缺省为空对象 | **仍存在** |
| A-2 | plan 失败分支无 `diagnostic`、`reason` 退化为错误码副本、`hints` 为无参静态模板 | `electron/tools/runShellExecutor.ts:104-112` 未变：`reason: message`（即错误码本身）、`...(planError?.details)` 为空、`hints: shellTuiFallbackHintLines()` 无参 | **仍存在** |
| A-2 | 渲染层 i18n 与模型侧文案双份且逐字相同 | `src/renderer/i18n/resources/zh-CN/chat.json:242-248` 与 `src/shared/shellInteractiveTui.ts:28-33` 的 `shellTuiFallbackHintLines()` 文案仍逐字相同；`SHELL_TUI_FALLBACK_TITLE`（`shellInteractiveTui.ts:26`）**全仓库仍零引用** | **仍存在** |
| A-4 | 三处独立计算 TUI 判定 | `runShellPlan.ts:102`（后端权威）、`ShellTuiFallbackHint.tsx:36`（`if (!isInteractiveShellTuiCommand(command)) return null`）、`ToolCallCard.tsx:163`（`const isInteractiveTui = shellCommand ? isInteractiveShellTuiCommand(shellCommand) : false`，用于第 170 行 `useTerminalUi` 与第 627 行 pending 提示）**全部仍在** | **仍存在** |
| A-5 | 主链路 spawn 未指定 `stdio` | `runShellExecutor.ts:322-328` 未变，参数仅 `cwd/env/windowsHide/shell/detached` → Node 默认 `['pipe','pipe','pipe']` | **仍存在** |
| A-5 | 同仓库已有正确对照 | `electron/spawnUtil.ts:93` 仍为 `stdio: ['ignore','pipe','pipe']`；`detachChildProcessStreams` 仍只在终止路径调用（`proc.stdin?.destroy()`） | 对照有效 |
| C-1 | `MessageStatus` 无中止取值 | `src/shared/domainTypes.ts:11` 仍为 `'sending' \| 'sent' \| 'queued' \| 'streaming' \| 'completed' \| 'failed'` | **仍存在** |
| C-1 | 中止事实只进用量统计 | `electron/toolChatLoop.ts:824-846` 仍只把 `cancelled` 写入 `recordTurnSummary`；`src/shared/assistantFactAggregator.ts:171-174` 仍把所有非 `source-completed` 的终态事件一律写成 `status='failed'` | **仍存在** |
| C-1 | 残留清理统一改写为 `failed` | `turnCoordinator.ts:389`、`406-407`、`460`（`makeTerminal` 强制 `status:'failed'`）仍在 | **仍存在** |
| C-1 | 读取接口裁掉状态 | `electron/capabilities/handlers/session.ts` 的 `readCapability` 仍只透出 `sequence/role/timestamp/content`（+`truncated/originalChars`） | **仍存在** |

### 1.2 复核中的新增事实（需求清单未记录）

以下为本次调研发现、直接影响方案设计的事实，编号 N-1~N-10。

| 编号 | 事实 | 影响 |
| --- | --- | --- |
| **N-1** | `SHELL_INTERACTIVE_TTY_REQUIRED` 在整个测试套件中**零覆盖**：全仓库该字符串仅出现在 `runShellPlan.ts`、`runShellExecutor.ts`、`shellInteractiveTui.ts` 与文档；`electron/tools/runShellExecutor.test.ts` 无 TUI 用例，`src/shared/shellInteractiveTui.test.ts` 仅 2 个 `it`（且只覆盖正例与「非交互替代」） | 印证 A-1「计划未识别的缺陷」；T-2 必须补回归矩阵（§7.1） |
| **N-2** | 仓库**已具备命令位解析能力**：`electron/shell/shellCommandParser.ts` 提供 `parseShellSegments`（引号内不拆、`&&`/`\|\|`/`\|`/`;` 分段、段数上限 50）、`tokenizeShellArgv`；`electron/shell/shellAnalyzer.ts` 的 `ShellFactAnalysis.operations` 已给出每段的 `{ verb, args, segmentIndex }`（POSIX 走 bash AST） | T-2 不需要新写解析器，且能与策略层同源解析 |
| **N-3** | `SHELL_CASE_IDS` 位于 `electron/shell/shellCaseIds.ts`（`tuiRequiresTerminal: 'SHELL-CAPABILITY-001'`），**渲染层不可引用**；而 `src/shared/shellToolDisplay.ts` 已定义 `ShellResultData.caseId` 与 `parseShellResultData` | T-4 需把 caseId 常量下移到 shared 才能实现「以结果为唯一判据」 |
| **N-4** | 渲染层已有「失败原因回填」通道：`chatSlice` 的 `turnFailures` / `setTurnFailure` / `mergeTurnFailures`（`src/renderer/store/chatSlice.ts:233-244`），重开页面时由主进程按 `assistantMessageId` 回填 | T-6 可复用该通道承载「已停止」事实，无需新链路 |
| **N-5** | 数据库 `messages.status` 为 `status TEXT NOT NULL`（`electron/database/schema.ts:51`），**无 CHECK 约束、无枚举校验**；读取侧直接 `row.status as MessageStatus`（`electron/database/operations.ts:1222`） | T-6 新增状态取值**不需要 DB 迁移、不需要升 `DB_SCHEMA_VERSION`** |
| **N-6** | `turns` 表已有 `outcome TEXT`（V6 迁移，`electron/database/schema.ts:166`），且 `updateTurnState` 会写入 `cancelled`/`timed-out` | T-6 的历史回填具备精确依据（可选任务 M4） |
| **N-7** | **同一事实在三个出口三种表述**：事件流写 `cancelled`（`turn_end`/`step_end`）；消息层写 `failed`；渲染层 `turnProjectionService.applyTerminalStatus`（`src/renderer/services/turnProjectionService.ts:15-19`）把 `source-cancelled` 归入 `completed`（只有 `source-failed`/`source-timeout` 才算 `error`） | C-1 的「跨层不一致」比清单描述更严重；T-6 需同时对齐三处语义并明确各自职责 |
| **N-8** | A-5 的 stdin 契约与 plan 冻结链路耦合：`environment` 参与 `environmentFingerprint` 与 `planDigest`（`electron/shell/preparedShellExecution.ts:56-72`），且确认等待结束后的 `revalidatePreparedShellExecution` 会**重算** environment 并比对（`runShellPlan.ts:150-176`） | T-1 新增的环境压制必须让 plan 与 revalidate **两处同源**，否则审批等待后会误判 `PLAN_STALE` |
| **N-9** | Windows 侧 profile 已带 `-NonInteractive`（`electron/shell/shellProfiles.ts:55-59`、`80-84`），POSIX 侧为 `/bin/bash --noprofile --norc -c`（无等价项） | A-5 的修复点只在 spawn 的 `stdio` 与环境，不改 profile；跨平台差异需在测试矩阵中体现 |
| **N-10** | `run_script` 的主链路 spawn（`electron/tools/builtinExecutors.ts:1368-1373`）同样**未指定 `stdio`** | 同族风险（`python3` 读 stdin 会阻塞）；列为 A-5 的附带项（§4.1.6） |

---

## 2. 目标与非目标

### 2.1 目标（可验收）

1. **G1（A-1）**：`git add`、`git commit -m "…top-level…"`、`git update-index` 等非交互命令不再被拒绝；需求清单 §A-1 误伤表的 10 例中，8 例由「拒绝」改为「放行」，2 例维持「放行」；其余正例（真 TUI 命令）维持「拒绝」。
2. **G2（A-2）**：`SHELL_INTERACTIVE_TTY_REQUIRED` 的模型可见 payload 同时具备：**归因类别**（`diagnostic.category`）、**命中事实**（命中程序名、命中规则、所在子命令序号）、**可执行建议**（非交互改写的具体方向）。模型不再需要「猜测原因」即可自查收敛。
3. **G3（A-3）**：模型侧提示文本内**不再出现**「下方按钮」等界面专属措辞，且显式声明「这是能力/环境限制，不是安全策略拒绝」「不要换途径重试」「不要绕过工具通道去聊天征求许可」；工具描述层同步补齐纪律。
4. **G4（A-4）**：TUI 提示的显示判据**唯一**来自工具结果（`caseId`/错误码），渲染层删除对命令文本的重算；同一事实在后端与界面不会因判据演进再次分叉。
5. **G5（A-5）**：**宿主 fd0 契约成立**——`run_shell` 的子进程读 stdin 时**立即得到 EOF**，不因等待输入而阻塞到超时（以 `/bin/sh -c 'read line; echo got:$line'`、`cat`（无参数）等**确定性命令**验证）；同时 terminal 输出模式下的着色能力不被破坏。依赖外部程序的安装/配置/网络/tty 的行为（`psql`、`redis-cli`、`fzf`、裸 `ssh host` 等）**列为观察项，不作为通过标准**（v0.4 收窄，见 §4.1.8）。
6. **G6（C-1）**：用户中止的回合在消息层可**唯一识别**为「已停止」，与真实故障、应用退出残留、启动清理**可区分**；`action.session.read` 能看到该状态。

### 2.2 非目标

- 不引入 PTY / `node-pty`（沿用 `shell-output-terminal-enhancement-requirement.md` OQ-3 既有决策）。
- 不改变策略与授权顺序：能力层仍在授权层之前判定，`require-confirm`/审批/deny 语义不变。
- 不评估/不修改审批 Agent 的裁决质量与审批通道（第 4/6 章范围）。
- 不追求「让 TUI 程序在应用内可用」（词表仍拒绝并引导外部终端，见 §4.2.5）。
- 不改变 `shellDefaultTimeoutSec` 默认值（300 s）；超时语义保持。
- 不新增用户可见配置开关（T-1 的环境压制是内部契约）。
- **不承诺依赖外部环境的程序行为**：`psql`/`redis-cli`/`fzf`/裸 `ssh` 等的退出码与耗时由本机安装、配置、网络与 tty 决定，本方案只保证宿主侧 fd0 契约（§4.1.8）。

### 2.3 不变量

1. **plan 冻结不变量**：确认等待结束后只重验证、不重解析；新增字段必须同时进入 plan 冻结与 revalidate 比对（N-8）。
2. **单一事实来源**：同一判定只有一个计算点，其余位置消费其结果。
3. **投影口径不变量**：新增字段必须经 `PROCESS_KEYS`/`DIAGNOSTIC_KEYS` 白名单与受控值校验，telemetry 出口不得落自由文本。
4. **fail-closed 不变量**：安全策略路径不回退；**能力判据同样 fail-closed** —— 解析不完整、**包装链/二次解释无法静态确认**、或**超出递归深度上限**时，只要命令文本出现 TUI 词素，一律进入「不可检测」分支（`SHELL_TUI_UNDETECTABLE`，§4.2.6），不得静默放行。TUI 词表是**运行契约**（该程序在应用内不可用），不是可放行的建议。
5. **归因不变量**：`diagnostic` 只表达「本次拒绝的归因类别」，**不得为无归因结论的错误补默认值**。计划期五种错误码的 `data.caseId` 与顶层 `diagnostic` 的对应关系是逐项显式映射（§4.3.2），禁止用三元表达式的兜底分支承载。

### 2.4 保证范围声明（避免验收口径漂移）

本方案对 T-2 的保证范围做**显式闭合声明**，防止「判据越精确、承诺越模糊」：

| 层 | 保证 | 不保证 |
| --- | --- | --- |
| 静态判据 | 在**递归深度上限内**（包装链 ≤4 层、二次解释 ≤3 层，§4.2.2）可静态到达的每一条子命令，其命令位都被检查；命中词表即拒绝 | 深度上限之外、或需要运行期求值（变量/命令替换/`eval` 拼接）才能确定的命令位 |
| 失败姿态 | 上述「无法确定」情形，只要文本出现 TUI 词素，一律 `SHELL_TUI_UNDETECTABLE`（fail-closed） | 不承诺「无词素时也不存在交互程序」（例如 `$SOMETHING` 运行期解析为 `vim`）——该情形无从静态判定，明确落在保证范围外 |
| 宿主环境 | fd0 为 `ignore`（读 stdin 立即 EOF）、分页器与凭据提示环境已压制 | 程序自身的 `/dev/tty` 访问、外部服务可用性、网络行为 |

上表同时是 G1/G5 的口径来源：G1 按「静态可达命令位」验收，G5 按「fd0 契约」验收。

---

## 3. 总体设计

### 3.1 分层归因

六项问题不是六个独立缺陷，而是同一条链路上的分层失效。按层归因后，修复点集中、互相不冲突：

```text
用户/模型发起 run_shell
        │
        │ ① 执行环境层（T-1）
        │    stdio / env：让「不可交互」成为运行环境事实，而不是预判
        ▼
  planRunShellExecution（唯一计划入口）
        │
        │ ② 能力判据层（T-2）
        │    命令位匹配取代全文匹配：判据正确性
        ▼
        │ ③ 结果契约层（T-3）
        │    diagnostic.category + 结构化命中事实 + 参数化 hints：可自查性
        ▼
  tool结果投影（agent / local_history / telemetry 三出口）
        │
        │ ④ 呈现层（T-4）
        │    以结果为唯一判据：单一事实来源
        ▼
  渲染层提示卡 / 终端视图        ── ⑤ 模型纪律（T-5）：能力拒绝 ≠ 策略拒绝
```

C-1 在第 ④ 层之后的**记录层**，与 A 系列无代码耦合，但共享同一条「事实必须按语义分层表达」的设计原则：`outcome`（精确原因）→ 消息状态（粗粒度、可区分）→ UI 展示。

### 3.2 依赖关系与并行度

| 任务 | 依赖 | 可并行 |
| --- | --- | --- |
| T-1 stdin/环境 | 无 | 与 T-2/T-3 并行 |
| T-2 命令位判据 | 无（复用 `shellCommandParser`） | 与 T-1 并行；T-3 依赖其产出结构 |
| T-3 错误契约 | T-2（命中结构） | — |
| T-4 单一判据 | T-3（结果字段） | — |
| T-5 模型纪律 | T-3（hints 文案） | 与 T-4 并行 |
| T-6 中止态 | 无 | 全程独立 |

### 3.3 任务的合并评估（回应 A-1 结尾的「三条目应合并评估」）

A-1、A-2、A-4、A-5 在需求清单中被显式要求合并评估，本方案的合并方式为：

- **A-5 先行**（T-1）：把「读 stdin 阻塞」这一底层成因从运行环境根除，词表因此不再承担「防阻塞」职责；
- **A-1 随之精确化**（T-2）：判据从「保守全文匹配」改为「命令位匹配」，把误伤面收敛到接近零；但**精确定位不等于放宽边界**——无法解析的复杂构造转入 fail-closed 的「不可检测」分支（§4.2.6），能力拒绝的边界不因判据精细化而开口；
- **A-2 补齐解释力**（T-3）：既然拒绝变成低频、精确事件，其拒绝理由必须携带命中事实，否则精确化收益不可见；
- **A-4 收口**（T-4）：界面不再复制判据，改为消费结果，避免判据演进后再次分叉。

即：单做 A-1（收紧判据）会保留 stdin 阻塞；单做 A-5 会让词表的误伤继续存在（本会话 5 次失败）；只做 A-2 会让错误信息解释一个错误的判据。四者必须按 T-1 → T-2 → T-3 → T-4 顺序落地。

---

## 4. 详细设计

### 4.1 T-1：stdin 与环境非交互化（A-5 / D-7）

> **文件归属（唯一，避免「或并入」式歧义）**：本任务的环境相关新增函数集中在**新建的 `electron/shell/shellEnvOverrides.ts`** 一个文件里——`applyNonInteractiveShellEnv`（§4.1.3）与 `buildPlannedShellEnvironment`（§4.1.5 第 1 点）同处该文件；既有 `electron/shell/shellSpawnEnv.ts` **不改动**。

#### 4.1.1 问题与目标

`runShellExecutor.ts:322` 未指定 `stdio`，子进程 fd 0 为父进程持有且从不写入/关闭的管道 → 读 stdin 的程序拿不到 EOF，直到 `shellDefaultTimeoutSec`（默认 300 s）超时被 SIGKILL。词表（`less`/`vim`/`top`）覆盖不到 `cat`、`python3`、`ssh`、`psql`、`fzf`、`redis-cli` 等。

目标：**让「非交互」成为执行环境事实**，由程序自行降级/快速失败，而不是由宿主预判命令是否交互。

#### 4.1.2 设计一：`stdio` 与输出模式进入同一个 plan 冻结契约（**接口唯一定义处**，评审 v9 B1）

> **本节是 `spawnStdio` 与 `shellOutputMode` 两个字段的唯一接口定义处**。§4.1.4 只说明模式的语义与取值口径、**不重复声明类型**。v0.9 前稿在 §4.1.2 与 §4.1.4 各写一份，且 ctx 签名、`prepareShellExecution` 调用、`validatePreparedShellExecution` 的 `current` 三处未同步——按片段实施会得到「字段无法构造 / 字段被当可选不进 digest / revalidate 无法比较」三种冲突结果，现合并为一份。

**（1）类型定义**——`electron/shell/preparedShellExecution.ts`：

```ts
import type { ShellOutputMode } from '../../src/shared/shellOutputMode'

/** 非交互 fd0 形态：唯一取值，用字面量元组类型表达「只能是它」。 */
export type SpawnStdio = readonly ['ignore', 'pipe', 'pipe']

/** 非交互 fd0 常量：plan 构造与 revalidate 回填共用同一值，避免两处字面量漂移。 */
export const SPAWN_STDIO_NON_INTERACTIVE: SpawnStdio = ['ignore', 'pipe', 'pipe']

export interface PreparedShellExecution {
  // ...既有字段（command / profile / spawnSpec / cwd / timeoutMs / ioMaxBytes / environment /
  //    environmentFingerprint / facts / configRevision / policyRevision / dependencySnapshot /
  //    pathSnapshot / planDigest）
  /** 子进程 fd0 形态：非交互执行契约的一部分，随 plan 冻结 */
  readonly spawnStdio: SpawnStdio
  /** 有效输出模式：环境压制（NO_COLOR/TERM）的唯一来源；随 plan 冻结，revalidate 只读该字段 */
  readonly shellOutputMode: ShellOutputMode
}

export interface PreparedShellInput {
  // ...既有字段（同上）
  spawnStdio: SpawnStdio
  shellOutputMode: ShellOutputMode
}
```

两个字段**均为必填**（非可选）：`prepareShellExecution` 内 `structuredClone(input)` 后 `{...snapshot}` 即为快照，必填才能在编译期阻止「忘记写入」——否则会出现「字段缺失但 digest 照算」的静默不一致（即评审 v9 B1 列出的第二种冲突结果）。

**与 Node `spawn` 的类型边界（评审 v11 B1）**：

`SpawnStdio` 用 `readonly` 元组表达「只能是这个值、且写入后不得被改写」，这与快照语义一致，**保留**。但它**不能直接**传给 `child_process.spawn`：本仓库 `node_modules/@types/node/child_process.d.ts` 的定义是

```ts
type IOType = "overlapped" | "pipe" | "ignore" | "inherit";
type StdioOptions = IOType | Array<IOType | "ipc" | Stream | number | null | undefined>;
```

即 `stdio` 接受**单个 `IOType` 或可变数组**；`readonly [...]` 不满足前者（不是单值），也不能赋给可变数组（TS 只允许可变→只读，不允许只读→可变）。因此：

- **边界适配点唯一**：只在 §4.1.2（5）的 `spawn` 调用处做一次可变副本（`[...prepared.spawnStdio]`），其余位置（快照、digest、比对、回填）**一律用 readonly 原值**；
- **不得**为了通过编译把 `SpawnStdio` 改成可变类型或加 `as SpawnStdio` 断言——前者放弃「写入后不可改写」的保护，后者把编译错误推迟到运行期；
- **不得**在多个调用点各自 spread（`spawnStdio` 的消费点应保持单一，见 §4.1.2（5）的说明）。

**（2）重验证的 `current` 类型**——`validatePreparedShellExecution`：

```ts
export function validatePreparedShellExecution(
  prepared: PreparedShellExecution,
  current: Pick<
    PreparedShellInput,
    | 'profile' | 'spawnSpec' | 'cwd' | 'timeoutMs' | 'environment'
    | 'configRevision' | 'policyRevision' | 'dependencySnapshot' | 'pathSnapshot'
    // 评审 v9 B1：两者必须进入 current 类型，否则下面的比对项无法编译
    | 'spawnStdio' | 'shellOutputMode'
  >
): { stale: boolean; reasons: string[] } {
  // ...既有比对项
  if (stable(prepared.spawnStdio) !== stable(current.spawnStdio)) reasons.push('spawnStdio')
  if (prepared.shellOutputMode !== current.shellOutputMode) reasons.push('shellOutputMode')
  return { stale: reasons.length > 0, reasons }
}
```

**（3）plan 侧接线**——ctx 收窄需含 `shellOutputMode`，并在 `prepareShellExecution({...})` 中**显式写入两字段**：

```ts
// electron/tools/runShellPlan.ts —— 常量与类型从定义处（preparedShellExecution.ts）import
import { SPAWN_STDIO_NON_INTERACTIVE, type SpawnStdio, type PreparedShellExecution } from '../shell/preparedShellExecution'

export async function planRunShellExecution(
  input: Record<string, unknown>,
  ctx: Pick<ToolExecutionContext,
    // 评审 v9 B1：原签名缺 shellOutputMode，「读出即冻结」无从实现
    'workDir' | 'userDataDir' | 'shellConfig' | 'policyRevision' | 'shellOutputMode'>
): Promise<PreparedShellExecution> {
  // ...既有前序逻辑（legacy config 迁移 / validateShellExecutionConfig / resolveSpec /
  //    assertExecutableAvailable / detectShellDialectMismatch / planShellExec）
  const shellOutputMode: ShellOutputMode = isTerminalShellOutputMode(ctx.shellOutputMode) ? 'terminal' : 'plain'
  // 环境构造唯一入口（定义见 §4.1.5 第 1 点）：env 与 fingerprint **同源产出**，禁止在此另起炉灶
  const { env, fingerprint } = buildPlannedShellEnvironment(command, shellOutputMode)
  return prepareShellExecution({
    // ...既有字段（command / profile / spawnSpec / cwd / timeoutMs / ioMaxBytes / facts /
    //    configRevision / policyRevision / pathSnapshot）
    environment: env,                                     // ← 必须来自上面的返回值
    dependencySnapshot: {                                 // ← fingerprint 必须来自上面的返回值
      platform: process.platform,
      profileId: profile.id,
      executable: spec.executable,
      environmentFingerprint: fingerprint
    },
    spawnStdio: SPAWN_STDIO_NON_INTERACTIVE,
    shellOutputMode                                                   // 冻结值，随快照进入 planDigest
  })
}
```

- `ctx.shellOutputMode` 在**全链路只被读这一次**；执行层与 revalidate 一律读 `prepared.shellOutputMode`（硬约束见 §4.1.4、实施步骤见 §6 P0-3）。
- `SPAWN_STDIO_NON_INTERACTIVE` 定义在 `preparedShellExecution.ts`（与 `SpawnStdio` 类型同处）并导出，plan、revalidate、执行层三处 import 同一常量，避免三份字面量。
- `prepareShellExecution` 回调**保持既有实现**（`structuredClone` + `environmentFingerprint` + `planDigest` 对全快照求摘要），仅因入参多两字段而自动纳入摘要——不需要为它新增特殊分支。

**（4）revalidate 侧接线**——签名与调用点**不变**（`runShellExecutor.ts:172` 仅传 `shellConfig`/`policyRevision`；`shellConfigRevision` 有意不含 `outputMode`，见 §4.1.5 第 3 点），内部**从快照读**两字段并回填 `current`：

```ts
export async function revalidatePreparedShellExecution(
  prepared: PreparedShellExecution,
  current: { shellConfig?: ShellConfig | null; policyRevision?: string } = {}
): Promise<void> {
  // ...既有前序逻辑
  // 环境构造走**同一个**入口（§4.1.5 第 1 点）；模式取自快照，不读实时 ctx
  const { env } = buildPlannedShellEnvironment(prepared.command, prepared.shellOutputMode)
  assertPreparedShellExecutionCurrent(prepared, {
    // ...既有字段（profile / spawnSpec / cwd / timeoutMs /
    //    configRevision / policyRevision / dependencySnapshot / pathSnapshot）
    environment: env,                            // ← 与 plan 同源产出，故 fingerprint 必然相等
    spawnStdio: prepared.spawnStdio,             // ← 回填冻结值
    shellOutputMode: prepared.shellOutputMode    // ← 回填冻结值
  })
}
```

> **为什么回填而非重新解析**：`revalidate` 的既有口径是「只重验证、不重解析」（函数注释原文）。两个字段属同一计划，重验证时应与快照**恒等**；把它们放进 `current` 是为了**让「以不同值调用校验函数」成为可观察的契约违例**，而不是让 revalidate 重新计算。
>
> **由此推出一条测试口径（评审 v10 B1）**：`revalidatePreparedShellExecution` 按设计**永远回填快照值**，所以它**不可能**产生 `shellOutputMode`/`spawnStdio` 的 stale reason。该契约的存在性因此由**直接调用 `validatePreparedShellExecution`** 的单元用例证明（T1-7），revalidate 侧则以集成用例证明「始终回填、不产生 stale」（T1-7b，§7.2）。原稿把两者混在一条用例里，导致「要求一个不可能发生的结果」。

**（5）执行层使用**——`electron/tools/runShellExecutor.ts:322`（**`SpawnStdio` 与 Node 类型的唯一边界适配点**，评审 v11 B1）：

```ts
proc = spawn(spec.executable, spec.args, {
  cwd: prepared.cwd,
  env,
  // readonly 元组不能直接赋给 Node 的 StdioOptions（要求可变数组或单个 IOType），
  // 故在唯一消费点做一次可变副本；语义与取值均不变（fd0 仍指向空设备）。
  stdio: [...prepared.spawnStdio],
  windowsHide: true,
  shell: false,
  detached: process.platform === 'darwin'
})
```

- **为什么用 spread 而不是改类型**：`readonly` 表达「快照写入后不得被改写」，是快照语义的一部分（§4.1.2（1））；spread 只在本行产生一个临时可变数组，不改变快照字段的类型，也不削弱任何保护。
- **为什么只有这一处**：`spawnStdio` 的其他消费点（`planDigest`、`validatePreparedShellExecution` 比对、revalidate 回填）都只做**相等性比较或原样传递**，不需要传给要求可变数组的外部 API；一旦别处也出现 spread，说明该字段被当成了「可任意拼装的值」，应回到本节核对契约。

副作用核查（【实测】代码事实）：

- `detachChildProcessStreams`（`spawnUtil.ts:109`）对 `proc.stdin` 使用 optional chaining；`stdio[0]='ignore'` 时 `proc.stdin === null`，终止路径不会因此报错。
- `proc.stdout`/`proc.stderr` 仍为流，输出采集与 `ProgressThrottle`、`OutputArtifactWriter` 逻辑不变。
- Windows 侧 profile 已带 `-NonInteractive`（N-9），`stdio` 改动对其是补充而非替代：`-NonInteractive` 约束 PowerShell 自身不弹提示，`stdio` 约束被调用的 native 程序。

#### 4.1.3 设计二：展示层环境压制

新增 `electron/shell/shellEnvOverrides.ts`（**唯一定位，不再提供「或并入 `shellSpawnEnv.ts`」的备选**；文件归属见本节开头的说明）：

```ts
import type { ShellOutputMode } from '../../src/shared/shellOutputMode'

/** 分页器与凭据提示：无论输出模式都必须压制（否则命令会把控制台交给交互程序）。 */
const ALWAYS_OVERRIDES = {
  PAGER: 'cat',
  GIT_PAGER: 'cat',
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: '',
  SSH_ASKPASS: ''
} as const

/** 纯文本输出模式：关闭颜色与终端能力协商，避免 CSI 序列污染摘要文本。 */
const PLAIN_MODE_OVERRIDES = {
  NO_COLOR: '1',
  TERM: 'dumb'
} as const

export function applyNonInteractiveShellEnv(
  env: Record<string, string | undefined>,
  mode: ShellOutputMode
): void {
  Object.assign(env, ALWAYS_OVERRIDES)
  if (mode === 'terminal') return
  Object.assign(env, PLAIN_MODE_OVERRIDES)
}
```

设计要点：

1. **压制对象分层**，理由逐条可辩：
   - `PAGER`/`GIT_PAGER=cat`：用户在 `git config core.pager` 或 `$PAGER` 中指向 `less -R` 时，即使 fd0 非 TTY，部分分页器仍会接管终端；显式压制消除与环境差异相关的不确定性。
   - `GIT_TERMINAL_PROMPT=0` + `GIT_ASKPASS/SSH_ASKPASS=''`：**作用必须精确表述**——`GIT_TERMINAL_PROMPT=0` 使 git 不向终端索取凭据；`GIT_ASKPASS`/`SSH_ASKPASS` 仅影响「由哪个外部程序弹凭据提示」，置空等价于「不提供 GUI askpass 通道」。**它不等于 `ssh -o BatchMode=yes`**：OpenSSH 是否尝试密码、keyboard-interactive、主机密钥确认，取决于版本、`ssh_config`、`known_hosts` 与是否存在可用 tty，宿主环境变量无法决定。因此本方案**不对裸 `ssh host` 承诺「快速失败」**（见 §4.1.8 拆分与 §7.2 T1-9）。
   - `NO_COLOR=1`/`TERM=dumb`：仅在 `plain` 模式设置。**关键权衡**：`terminal` 模式的产品价值是保留 ANSI 着色（xterm 渲染），若一律 `TERM=dumb` 会把彩色输出变成纯文本，等于用修复 A-5 的代价破坏既有终端增强能力。因此按 `shellOutputMode` 分流。
2. **压制优先级**：覆盖用户/宿主同名变量（在 `buildShellEnv` 之后执行）。这与 A-5 对照材料中 Codex/Claude Code 的既有做法一致（`NO_COLOR`/`TERM=dumb`/`PAGER=cat`/`GIT_PAGER=cat`）。
3. **不设置 `CI=1`**：`CI` 会改变 npm/测试运行器的输出与行为（例如关闭进度条、改变失败策略），超出「非交互化」的最小必要范围，可能引入不可预期的行为漂移。

#### 4.1.4 设计三：有效输出模式进入 plan 冻结（评审项 1）

**为什么必须冻结**：环境压制按模式分流（§4.1.3），而 environment 参与 `environmentFingerprint`、`planDigest`，并且 `revalidatePreparedShellExecution` 会**重算** environment 再比对（`preparedShellExecution.ts` 的 `environment` reason）。因此「模式」与 `spawnStdio` 同类，必须成为**计划快照的一部分**，并由重验证从快照读取。评审指出的缺陷正是这一点：只冻结 `spawnStdio` 而让 `revalidate` 用缺省模式构造环境，`terminal` 计划在确认后必然因环境指纹不同报 `PLAN_STALE`。

> **接口定义见 §4.1.2（唯一定义处，评审 v9 B1）**：`PreparedShellExecution`、`PreparedShellInput` 与 `validatePreparedShellExecution` 的 `current` Pick 均已包含本字段。本节**不重复声明类型**，只说明模式的语义、取值口径与使用约束。

判定函数下移 shared（plan 与执行层共用，消除「两处各判一次」）：

```ts
// src/shared/shellOutputMode.ts 追加
/** 有效输出模式是否为 terminal。plan 冻结与执行层 raw 增量判定共用此函数，禁止各自写字面量比较。 */
export function isTerminalShellOutputMode(mode?: ShellOutputMode | null): boolean {
  return mode === 'terminal'
}
```

模式取值与缺省口径：

- **ctx 收窄已含 `shellOutputMode`**（完整签名与显式写入见 §4.1.2 第 3 点）：`ToolExecutionContext.shellOutputMode?: 'plain' | 'terminal'`（`electron/tools/types.ts:79-80`）。调用方传入的是完整 ctx，`Pick` 收窄不影响调用点。
- 冻结值 = `isTerminalShellOutputMode(ctx.shellOutputMode) ? 'terminal' : 'plain'`，即**缺省（undefined）为 `plain`**。
  > **注意此处的 `ctx` 仅限 plan 阶段**（这是全链路唯一一次读 `ctx.shellOutputMode`，读出即冻结）。执行层与 revalidate **一律读 `prepared.shellOutputMode`**，见下方硬约束与 §6 P0-3。
- **执行层必须从快照读模式（评审门禁 4 的硬约束）**：`runShellExecutor.ts:217` 现为 `const terminalMode = ctx.shellOutputMode === 'terminal'`，必须改为

  ```ts
  const terminalMode = isTerminalShellOutputMode(prepared.shellOutputMode)
  ```

  即**不得读 ctx**。理由：环境由 `prepared` 快照构造（`prepared.environment`），若 raw/plain 增量判定读 ctx，则确认等待期间模式变化会再次产生「环境按一种模式、终端增量按另一种模式」的分裂——这正是评审指出的风险。改后 `ctx.shellOutputMode` 只在 **plan 阶段**被读一次（冻结），之后全链路只认快照，从根上消除分裂。
- **缺省口径为何是 plain 而不是 terminal**：`runShellExecutor.ts:217` 的 `terminalMode = ctx.shellOutputMode === 'terminal'` 决定是否发送 raw 终端增量，既有语义把缺省当非 terminal；plan 若取反，会出现「环境按 terminal 构造（不注入 `NO_COLOR`）而执行层按 plain 呈现」的错配。`resolveEffectiveShellOutputMode` 的缺省 `'terminal'`（`shellConfig?.outputMode ?? 'terminal'`）不冲突——真实链路（`toolChatLoop.ts:942`）总是把解析结果写入 `ctx.shellOutputMode`，缺省只出现在测试夹具与直调场景。
- 冻结后无需额外接线即进入 `planDigest`（`prepareShellExecution` 对全快照求摘要）。比对项及其 `current` 类型扩展见 §4.1.2 第 2 点——`current.shellOutputMode` 是**必填**字段，不再用 `?? prepared.shellOutputMode` 兜底（兜底会让「未传」与「取值相同」不可区分，从而掩饰契约未接通）。

#### 4.1.5 模式与 stdio 的同源要求（N-8、评审项 1）

1. **环境构造只有一个入口**——`buildPlannedShellEnvironment`（定义在 `electron/shell/shellEnvOverrides.ts`，与 `applyNonInteractiveShellEnv` 同文件），供 `planRunShellExecution` 与 `revalidatePreparedShellExecution` 共用；两处的 `mode` **都取自冻结值**（plan 侧刚冻结的值 / revalidate 侧的 `prepared.shellOutputMode`）：

   ```ts
   // electron/shell/shellEnvOverrides.ts —— 与 applyNonInteractiveShellEnv 同文件，无需自引用
   import { resolveShellEnvironment } from './environmentResolver'
   import { applyPlaywrightInstallShellEnv } from './shellSpawnEnv'
   import { buildShellEnv } from '../processOutputEncoding'

   /**
    * plan 与 revalidate 唯一共用的环境构造入口。
    * 三处输出（resolveShellEnvironment / buildShellEnv / 两类 apply*）必须同源，
    * 否则两次构造出的 environmentFingerprint 不等 → 必然 PLAN_STALE。
    * 返回值里的 fingerprint 是 plan 的 dependencySnapshot.environmentFingerprint 的唯一来源。
    */
   export function buildPlannedShellEnvironment(
     command: string,
     mode: ShellOutputMode
   ): { env: Record<string, string>; fingerprint: string } {
     const resolved = resolveShellEnvironment(process.env, [
       'DEBUG', 'PLAYWRIGHT_FORCE_TTY', 'APPDATA', 'ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA'
     ])
     const env = buildShellEnv(resolved.env)
     applyPlaywrightInstallShellEnv(env, command)
     applyNonInteractiveShellEnv(env, mode)          // ← 模式分流只在此处发生（§4.1.3）
     return {
       env: Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => typeof e[1] === 'string')),
       fingerprint: resolved.fingerprint             // ← plan 的 dependencySnapshot 取它
     }
   }
   ```

   **为什么签名是 `(command, mode)` 而不是 `(env, mode)`**：同一文件的 `planRunShellExecution` 与 `revalidatePreparedShellExecution` 在改造前都是「各自 `resolveShellEnvironment(process.env, [...])` → `buildShellEnv` → `applyPlaywrightInstallShellEnv`」三步各写一遍（即评审 N-8 指出的重复构造）。把 resolve 收进函数内部，才能保证**两次构造的 fingerprint 由同一段代码产出**；若把 `env` 作为入参传进来，调用方仍要自己 resolve，重复构造与漂移风险就还在。相应地，plan / revalidate 的调用片段（§4.1.2 第 3、4 点）都改为解构使用其返回值。

   **两个 fingerprint 的职责边界（评审 v12 门禁 2——实现时必须区分，不得互换）**：

   | 值 | 来源 | 语义 | 用途 |
   | --- | --- | --- | --- |
   | 本函数返回的 `fingerprint` | `resolveShellEnvironment(process.env, …).fingerprint` | **源环境**解析快照的指纹（与改造前 plan 里 `dependencySnapshot.environmentFingerprint` 取的是同一个值） | plan 的 `dependencySnapshot.environmentFingerprint` |
   | `PreparedShellExecution.environmentFingerprint` | `prepareShellExecution` 内部对**完整 `environment`** 求 digest | **最终执行环境**（含 `buildShellEnv` 过滤、Playwright 注入、`applyNonInteractiveShellEnv` 压制后的结果）的指纹 | revalidate 比对（`validatePreparedShellExecution` 的 `environment` reason） |

   两条约束：① **不得互换**——把源环境指纹当成最终环境指纹（或反之）会使 revalidate 的比对失去意义；② **不得在 plan / revalidate 侧另行调用 `resolveShellEnvironment`**，否则最终环境可能由两段不同代码产出，重新引入确认等待后的 `PLAN_STALE` 漂移（该风险由 T1-5/T1-6 与 §7.6 的同源门禁覆盖）。
2. **revalidate 从快照读模式，不读实时 ctx**：`revalidatePreparedShellExecution(prepared, current)` 的签名与调用点（`runShellExecutor.ts:172`，仅传 `shellConfig`/`policyRevision`）**保持不变**；函数内部以 `prepared.shellOutputMode` 构造环境，并在 `assertPreparedShellExecutionCurrent` 的 `current` 中回填 `spawnStdio`/`shellOutputMode`（完整片段见 §4.1.2 第 4 点）。这样「确认等待」不会产生环境指纹差异。
3. **确认期间外部设置变化时的预期行为（取定）**：模式冻结后，执行期间即使 `shellConfig.outputMode`、会话元数据或 remoteSource 发生变化，也**不使已确认计划失效**——命令按准备时刻的模式跑完；新的工具调用以新模式重新 plan。理由：① 与 revalidate 既有口径一致（该函数注释原文即为「只重验证运行时依赖，不重新解析用户输入或读取 shellConfig」）；② 输出模式是**展示偏好**而非安全语义（安全语义由策略层与审批承担），让它触发 `PLAN_STALE` 会把用户重新推回一轮审批，代价与收益不匹配。
   相应地，在 `shellConfigRevision`（`runShellPlan.ts:66-77`）处补注释说明 **`outputMode` 被有意排除**，防后续把「展示偏好变化」误纳入 revision 而与本节第 3 点冲突。
4. **测试口径（§7.2，评审 v10 B1 两级拆分）**：T1-5（`terminal` 计划经确认等待正常重验证，不 `PLAN_STALE`）、T1-6（确认期间设置改为 plain → 仍不失效，且环境不含 `NO_COLOR`）、**T1-7（单元层：直接调用 `validatePreparedShellExecution`，构造不同的 `current.shellOutputMode`/`current.spawnStdio` → `reasons` 含对应键）**、**T1-7b（集成层：revalidate 始终回填快照值，不产生 `shellOutputMode`/`spawnStdio` 的 stale）**。

#### 4.1.6 附带项：`run_script` 的同类风险（可选）

`electron/tools/builtinExecutors.ts:1368-1373` 的 `run_script` spawn 同样未设 `stdio`。`python3 -c "…input()…"` 会同样阻塞至超时。建议同批修复（`stdio: ['ignore','pipe','pipe']`），但需注意 `run_script` 的输入是否可能显式读取 stdin（当前设计为无 stdin 输入）。**本项不计入 G5 验收，需单独确认后再改**。

#### 4.1.7 可观测性

- `shell.exec.spawned` 日志（`runShellExecutor.ts:331-335`）增加 `stdioPolicy: 'ignore-pipe-pipe'`、`envOverrideKeys: ['PAGER','GIT_PAGER',…]`（只记键名，不记值）与 `shellOutputMode`（把「环境差异 / `PLAN_STALE`」与模式对应起来）。
- 超时诊断增强（可选、低成本）：当 `status==='timed_out'` 且 `stdoutBytes===0 && stderrBytes===0` 时，在 `data` 中补充提示「该命令在超时内没有任何输出，可能仍在等待标准输入或外界条件」。这类情形在 T-1 落地后应显著减少，留下的少数是真超时。

#### 4.1.8 验收与实测（对应 V-7）

**表 A：确定性 fd0 契约（纳入 G5）**——只依赖 POSIX 宿主自带能力，不依赖外部服务、网络或本机第三方程序：

| 命令 | 断言（确定性） | 说明 |
| --- | --- | --- |
| `/bin/sh -c 'read line; echo got:$line'` | 非超时退出（`terminationReason === 'process_exit'`），且输出含 `got:`（`read` 立即得 EOF、返回非 0） | 最直接的「fd0 = EOF」证据；POSIX 必有 |
| `cat`（无参数） | `status === 'succeeded'`，`durationMs` 远小于超时，无输出 | 读 stdin 立即 EOF |
| `sleep 400`（`timeout: 5`） | `status === 'timed_out'`（**不回归**） | 超时语义保持 |
| `git log --color=always`（terminal 模式） | 保留 ANSI（`TERM` 不被压制） | 着色能力不破坏 |
| `python3 -c 'input()'`（**可用时**） | 非超时退出、stderr 含 `EOFError` | 条件用例：`python3` 不存在时跳过并记录，不计入失败 |

**表 B：外部环境观察项（不做承诺，不纳入 G5）**——行为受本机安装、配置、网络、tty 影响：

| 命令 | 观察内容 | 备注 |
| --- | --- | --- |
| 裸 `ssh host` | 是否等待口令/主机密钥/网络 | 取决于 OpenSSH 版本、`ssh_config`、`known_hosts`、网络与 tty |
| `ssh -o BatchMode=yes -o ConnectTimeout=2 -o StrictHostKeyChecking=no 127.0.0.1` | 是否因 stdin 阻塞 | **回环下可作为附加证据**（§7.2 T1-9），但**不作为 G5 通过条件** |
| `psql` / `redis-cli` | 无 TTY 时的退出行为 | 取决于客户端版本与是否安装/配置 |
| `fzf` / `watch` | 无输入时是否立即退出 | 取决于版本与 tty |

实测要求：表 A 逐条执行并记录 `durationMs`、`terminationReason`、`status`、`caseId`；表 B 只记录观察结果，不写入通过标准。对照 `spawnUtil.ts:93` 的既有实现行为。**表 A 为 G5 的验收证据，必须留痕（V-7 结项材料）。**

---

### 4.2 T-2：TUI 判据改为命令位匹配（A-1 / D-2）

#### 4.2.1 缺陷机制

现行 `isInteractiveShellTuiCommand` 对**整条命令字符串**做 `\b` 词匹配（`src/shared/shellInteractiveTui.ts:5-23`）。`\b` 在连字符与字母之间成立，故 `top-level-design-v2.md` 中的 `top`、`docs/vi-usage` 中的 `vi`、`more cleanup` 中的 `more`、`nano-banana.png` 中的 `nano` 均命中。判定的**对象错位**（命令文本 vs 命令位）是唯一根因。

#### 4.2.2 新增模块：shared 契约 + 主进程判定（评审 v5 分层）

新增 `src/shared/shellTuiContract.ts`（**跨层契约：仅常量与类型，零运行时依赖**）：

```ts
// src/shared/shellTuiContract.ts
// 评审 v5：本模块被三类消费方同时引用——主进程判定（electron/shell/shellTuiDetection.ts）、
// 结果投影（src/shared/processResultProjection.ts）、渲染层（src/shared/shellToolDisplay.ts）。
// 因此必须定义在 shared 且**不得** import electron 侧任何模块（shellCommandParser / shellAnalyzer
// 等主进程解析依赖一律不引入）；否则 typecheck:shared 与 typecheck:renderer 都会失败。

export const SHELL_TUI_RULES = ['tui-program', 'npm-init-interactive', 'git-rebase-interactive'] as const
export type ShellTuiRule = (typeof SHELL_TUI_RULES)[number]

/**
 * 不可检测原因：**单一事实来源**。同时用于
 * ① `ShellTuiUndetectableReason` 类型；② 判定层赋值；③ 投影层 `projectTuiUndetectable` 的白名单校验。
 * 新增原因必须只改此数组——v0.4 的先例是两个新增值只加了判定与类型、
 * 漏加投影白名单，导致整个 `tuiUndetectable` 分支被静默丢弃。
 */
export const SHELL_TUI_UNDETECTABLE_REASONS = [
  'segments-overflow',
  'unbalanced-quote',
  'analysis-partial',
  'tokenize-failed',
  // 包装链递归 / 二次解释边界（评审 v3-B2）
  'nested-command-unresolvable',
  'recursion-depth-exceeded'
] as const
export type ShellTuiUndetectableReason = (typeof SHELL_TUI_UNDETECTABLE_REASONS)[number]

export interface ShellTuiMatch {
  /** 命中的命令位（basename，已剥离 env 前缀与包装命令） */
  readonly program: string
  readonly rule: ShellTuiRule
  /** 命中命令所在的子命令序号（0 起） */
  readonly segmentIndex: number
  /** 经包装链/二次解释穿透的路径（如 ['sudo','bash -lc']）；无穿透时缺省 */
  readonly via?: readonly string[]
}
```

主进程判定模块 `electron/shell/shellTuiDetection.ts`（**仅判定逻辑；契约从 shared 引用**）：

```ts
import { parseShellSegments, tokenizeShellArgv } from './shellCommandParser'
import type { ShellFactAnalysis } from './shellAnalyzer'
// 评审 v5：常量与类型来自 shared 纯模块，主进程不重复声明
import type { ShellTuiMatch, ShellTuiUndetectableReason } from '../../src/shared/shellTuiContract'

/** 判定结果三态（评审 B1）：明确未命中 / 明确命中 / 无法判定。 */
export type ShellTuiVerdict =
  | { kind: 'clear' }
  | { kind: 'matched'; match: ShellTuiMatch }
  /** 无法可信判定命令位，但文本中出现 TUI 词素 → 不可执行（fail-closed） */
  | {
      kind: 'undetectable'
      programs: readonly string[]
      /** 取值域见 SHELL_TUI_UNDETECTABLE_REASONS（与投影白名单同源，均来自 src/shared/shellTuiContract.ts） */
      reason: ShellTuiUndetectableReason
    }

/** 判定入口：返回三态（取值域与 §4.2.6 的判定表一一对应）；`facts` 由调用方传入时复用，避免重复解析。 */
export function detectShellTuiCommand(
  command: string,
  facts?: Pick<ShellFactAnalysis, 'operations' | 'analysisCompleteness' | 'unresolved'>
): ShellTuiVerdict
```

> 说明：`ShellTuiVerdict` 留在主进程（只有判定层产出它）；`ShellTuiMatch`/`ShellTuiRule`/原因枚举下移 shared（判定层、投影层、界面层三方共用）。下移范围**只含固定字符串数组与联合类型**，不移动任何判定逻辑，也不引入新的抽象层（评审 v5 要求）。

职责与实现要点：

1. **命令位来源优先级**：
   - 首选 `analyzeShellFacts(command, dialect).operations`（N-2）：POSIX 走 bash AST，能正确处理引号、`$(…)`、命令替换，且与策略层同源；
   - 回退：`parseShellSegments(command)` + `tokenizeShellArgv(segment)`（`shellCommandParser.ts` 已有，含 50 段上限保护）；
   - **判据是「命令位是否可信」，不是「是否 partial」（评审 v12 B4）**：`analyzeShellFacts` 的 `unresolved` 有两类成因，**只有第一类**意味着命令位不可信：

     | `unresolved` 条目 | 成因（`shellAnalyzer.ts`） | 命令位可信？ | 处置 |
     | --- | --- | --- | --- |
     | `parse:tree-error` | bash/PS 语法树解析失败（`treeFactsToAnalysis`，`f.ok === false`） | **不可信** | 进入 undetectable 分支 |
     | `segment:N:unparseable` | 该段 `tokenizeSimpleCommand` 失败（第 61 行，如引号不平衡） | **不可信** | 同上 |
     | `segment:N:shell-control-flow` | 段内含 `>`/`<`/`(`/`)`/`$(…)`/`${…}`/反引号（**第 80 行**） | **可信**（该段 verb 已在 `operations` 中） | **不**进入 undetectable，按 verb 比对词表 |

     另有两条回退路径同属「不可信」：`parseShellSegments` 抛错（段数 >50）与 `tokenizeShellArgv` 返回 `null`。
   - **因此 `analysisCompleteness === 'partial'` 不能直接当作不可信判据**：`git log > top.log`、`git add docs/vi-usage.md > /dev/null`、`cat htop-report.md > /tmp/x` 都因重定向触发 `shell-control-flow` 而变 `partial`，但其命令位（`git`/`cat`）完全可判定。v0.15 前稿把 `partial` 整体归入「无法解析」并 fail-closed，会让这些**可解析**命令被误拒为 `SHELL_TUI_UNDETECTABLE`——是 A-1 同族误伤在重定向形态上的残留。实现须按上表的**条目类别**判断，建议抽辅助函数 `hasUnreliableCommandPosition(unresolved: readonly string[]): boolean`（只认 `parse:tree-error` / `segment:*:unparseable`）。
   - **不可信**时的处置：若命令文本中出现 TUI 词素 → `{ kind: 'undetectable', programs }`（拒绝）；若未出现 → `{ kind: 'clear' }`（放行，且这是**可判定为无命中**而非「静默放行」）。
2. **包装命令穿透（递归，评审 B2）**：命令位若属于包装/间接层集合，则**继续向下解析真实命令位，直到得到非包装命令或达到深度上限**（`MAX_WRAPPER_DEPTH = 4`）。集合与各自的选项解析规则：

   | 包装命令 | 跳过的部分 |
   | --- | --- |
   | `env` | `-i`/`-0`/`-u NAME`/`--unset=NAME` 及其参数、所有 `KEY=VALUE` 赋值 |
   | `sudo` / `doas` | `-u USER`/`-g GROUP`/`-p PROMPT`/`-i`/`-s`/`-E`/`-n` 及其参数、`VAR=VAL` |
   | `command` | `-v`/`-V`/`-p`（`-v`/`-V` 是查询语义，命中即 `clear`） |
   | `nice` / `ionice` | `-n N` / `-c C` 及其参数 |
   | `nohup` / `time` / `exec` / `setsid` | 无参 |
   | `timeout` | `-k D`、首个时长参数（如 `5`、`5s`） |
   | `xargs` | `-0`/`-n N`/`-I {}`/`-P N` 及其参数 |
   | `stdbuf` / `script` | `-o`/`-e`/`-q`/`-c`（见第 5 点）及其参数 |

   - **深度上限**：`env sudo env less x`（4 层）在限内；超过 4 层 → 若文本含词素则 `{ kind: 'undetectable', reason: 'recursion-depth-exceeded' }`，否则 `clear`。
   - 递归对每层都做 `path.basename()` 归一，`/usr/bin/env` 与 `env` 等价。
   - **不做运行期求值**：遇到 `$VAR`、`$(…)`、反引号占位为「未知命令位」，按第 5 点与 §4.2.6 处理。
3. **程序名词表**（第一版：与现行词表等价，避免行为边界扩大）：

   ```ts
   const TUI_PROGRAMS = new Set([
     'less', 'more', 'top', 'htop', 'vim', 'vi', 'nano', 'emacs'
   ])
   ```

   - `program` 需 `path.basename()` 后比对，使 `/usr/bin/vim`、`./vim` 同样命中；
   - 新增程序的评审要求：必须随附「误伤面」评估（该程序名作为普通文件名/参数的概率），写入本文件注释。
4. **参数级规则**（限定在对应子命令内，不再全命令扫描）：

| 规则 | 条件 | 说明 |
| --- | --- | --- |
| `npm-init-interactive` | `program === 'npm'` 且首个子命令为 `init`，且 argv 中无 `-y`/`--yes` | 保留现行语义（`npm init -y` 放行） |
| `git-rebase-interactive` | `program === 'git'` 且子命令为 `rebase`，且 argv 含 `-i`/`--interactive` | 覆盖现行的两种写法（`git rebase -i …`、`git -i rebase` 中后者语义本就可疑，见下） |

   - 现行正则 `/\bgit\s+-i\s+rebase\b/i` 匹配的是**不合法 git 语法**（`-i` 不是 `git` 的全局选项），属冗余规则；替换后该形态不再被拒（放行后由 git 自身报错，比宿主误报更准确）。此项列为**行为变更点**，需在测试中显式锚定。
5. **二次解释边界（评审 B2）**：命令位若是**shell 解释器**（`sh`/`bash`/`zsh`/`dash`/`ksh`/`ash`，`path.basename` 后比对）且 argv 含 `-c`（含 `-lc`/`-ic` 等组合短选项），或命令位为 `eval` 时，其后**被解释的字符串是嵌套命令**，必须继续分析：

   | 情形 | 处理 |
   | --- | --- |
   | `-c`/`eval` 的参数是**纯字面量**（无 `$`/反引号/`${}`） | 以该字符串**递归调用自身**（`MAX_INTERPRET_DEPTH = 3`）：可能得到 `matched`（如 `bash -c 'vim f'`）、`clear` 或 `undetectable` |
   | 参数含变量/命令替换（`bash -c "$CMD"`、`eval "$x"`） | **无法静态确认**：文本含 TUI 词素 → `{ kind: 'undetectable', reason: 'nested-command-unresolvable' }`；不含词素 → `clear`（与 §4.2.6 同一「词素存在性」判据） |
   | 二者结合（字面量 + 变量拼接） | 按「未能静态闭合」处理，命中上一行规则 |
   | 递归层数超上限 | `{ kind: 'undetectable', reason: 'recursion-depth-exceeded' }`（含词素时） |

   - 说明：`stdbuf -o0 vim f` 这类**非解释器**的包装仍按第 2 点穿透（不涉二次解释）；`script -q /dev/null git commit …` 是会话基线中出现过的形态（需求清单 §2.3 #3），`script` 的 `-c` 参数同按本点处理——对 `git commit` 这类非 TUI 命令仍返回 `clear`（不误伤）。
   - **该项是对 v0.3「仅一层穿透」的直接修正**：v0.3 无法覆盖 `env sudo vim f`、`bash -c 'vim f'`、`eval 'top'` 等**可解析但内含交互程序**的绕过路径（评审 B2）。

#### 4.2.3 计划期接线

`electron/tools/runShellPlan.ts:102-103` 改为：

```ts
const facts = analyzeShellFacts(command, profile.dialect)
const verdict = detectShellTuiCommand(command, facts)
if (verdict.kind === 'matched') {
  throw new RunShellPlanError('SHELL_INTERACTIVE_TTY_REQUIRED', describeTuiRejection(verdict.match), { tuiMatch: verdict.match })
}
if (verdict.kind === 'undetectable') {
  throw new RunShellPlanError('SHELL_TUI_UNDETECTABLE', describeUndetectableRejection(verdict), {
    tuiUndetectable: { reason: verdict.reason, programs: verdict.programs }
  })
}
const mismatch = detectShellDialectMismatch(command, profile)
if (mismatch) throw new RunShellPlanError('SHELL_DIALECT_MISMATCH', 'SHELL_DIALECT_MISMATCH', { ...mismatch })
// ...后续复用同一 facts，避免重复解析
```

三点收益：① 判定顺序不变（能力层仍在授权层之前）；② `facts` 复用，**不新增解析开销**（原先 `analyzeShellFacts` 已在该函数内调用一次，位置下移即可）；③ 解析不完整时**不静默放行**，而是给出可区分的不可执行错误（评审 B1）。

#### 4.2.4 误伤回归矩阵（直接采用需求清单 §A-1 的实测 10 例）

| 命令 | 现判 | 新判 | 新判据 |
| --- | --- | --- | --- |
| `git add … "docs/requirement/tool-confirmation-top-level-design-v2.md"` | 拒绝 | **放行** | 命令位 `git`，`top` 在参数文本中 |
| `git commit -m "chore(docs): 归档已废弃的后台 Mission 执行层设计文档"` | 放行 | 放行 | — |
| `git commit -m "fix: more cleanup"` | 拒绝 | **放行** | `more` 在参数文本中 |
| `git commit -m "docs: update vi-usage guide"` | 拒绝 | **放行** | 同上 |
| `git add docs/vi-usage.md` | 拒绝 | **放行** | 同上 |
| `git add docs/nano-banana.png` | 拒绝 | **放行** | 同上 |
| `cat docs/htop-report.md` | 拒绝 | **放行** | 命令位 `cat` |
| `git add src/less-loader.config.js` | 拒绝 | **放行** | 同上 |
| `git commit -m "refactor: emacs-config 拆分"` | 拒绝 | **放行** | 同上 |
| `npm run build` | 放行 | 放行 | — |
| `less README.md` / `vim src/main.ts` / `top` / `npm init` / `git rebase -i HEAD~3` | 拒绝 | **拒绝**（保持） | 命令位命中 |
| `npm init -y` / `git --no-pager log -1` / `echo hello` | 放行 | 放行 | 保持 |
| `git commit -m "x" && less README.md` | 拒绝 | **拒绝**（保持） | 第 2 个子命令命令位命中 |
| `echo "$(less README.md)"` | 拒绝 | **拒绝**（bash AST 路径） | 命令替换内命令位命中 |
| `env FOO=1 less README.md` | 拒绝 | **拒绝** | 包装命令穿透 |
| `git log > top.log` | 拒绝 | **放行** | 命令位 `git`；重定向使分析 `partial`，但**命令位仍可判定**（评审 v12 B4） |
| `git add docs/vi-usage.md > /dev/null` | 拒绝 | **放行** | 同上（路径文本中的 `vi` 不参与命令位判定） |
| `cat htop-report.md > /tmp/x` | 拒绝 | **放行** | 命令位 `cat`；重定向目标名同样不参与判定 |
| `less README.md > out.txt` | 拒绝 | **拒绝** | 命令位 `less` 命中（**重定向不豁免真实 TUI 命令**） |
| `git -i rebase HEAD~3` | 拒绝 | **放行**（行为变更） | 非法语法，交由 git 报错 |
| `echo "unclosed $(less README.md)`（引号不平衡） | 拒绝 | **拒绝**（`SHELL_TUI_UNDETECTABLE`） | 解析失败 + 文本含 `less` → fail-closed（§4.2.6） |
| `for f in *; do vim "$f"; done`（50 段以上构造） | 拒绝 | **拒绝**（`SHELL_TUI_UNDETECTABLE`） | 分段超限 + 文本含 `vim` |
| 解析失败但**不含** TUI 词素（如 50+ 段的纯 `echo` 序列、引号不平衡的 `git status`） | 放行 | **放行** | `kind: 'clear'`（可判定为无命中，非静默放行） |

包装链与二次解释（评审 B2，v0.4 新增）：

| 命令 | 现判 | 新判 | 新判据 |
| --- | --- | --- | --- |
| `env sudo vim file` | 拒绝 | **拒绝** | 递归穿透两层 → 命令位 `vim` |
| `command env less file` | 拒绝 | **拒绝** | 递归穿透两层 → `less` |
| `sudo -u root bash -lc 'top'` | 拒绝 | **拒绝** | 穿透 `sudo` → 二次解释 `bash -lc` 内部命令位 `top` |
| `bash -c 'vim file'` | 拒绝 | **拒绝** | 二次解释内命令位命中 |
| `eval 'less README.md'` | 拒绝 | **拒绝** | `eval` 字面量参数按嵌套命令分析 |
| `script -q /dev/null git commit -m "x"` | 拒绝（命中文档名 `top` 时） | **放行** | `script -c` 内命令位为 `git`，非 TUI（不误伤） |
| `git commit -m "env sudo vim file"` | 拒绝 | **放行** | 命令位 `git`；包装词只出现在参数文本中（**不误伤对照**） |
| `bash -c "$CMD"`（含变量、文本无词素） | 放行 | **放行** | 无法静态确认但无词素 → `clear` |
| `bash -c "$CMD less 2>&1"`（含变量 + 词素 `less`） | 放行 | **拒绝**（`SHELL_TUI_UNDETECTABLE`） | `nested-command-unresolvable` + 词素存在 |
| `env env env env env less f`（>4 层） | 拒绝 | **拒绝**（`SHELL_TUI_UNDETECTABLE`） | `recursion-depth-exceeded` + 词素存在 |

#### 4.2.5 词表定位（D-7 后半问）

T-1 落地后，`top`/`vim`/`less` 在 `fd0=ignore` + `TERM=dumb`（plain 模式）下会快速退出而非挂起，「防阻塞」不再依赖词表。但**词表不只是引导设施**：

1. **运行契约（主定位）**：产品明确不支持在应用内承载全屏/键盘交互程序（`shell-output-terminal-enhancement-requirement.md` §9.1）。因此命中词表 = **不可执行**，而不是「建议改用其他方式」。交互式程序在受控环境下的行为不可预期（可能尝试打开 `/dev/tty`、读取终端设备、或产生难以审计的副作用），宿主的职责是**不启动它**，而不是启动后依赖 `stdin=ignore` 兜底——`stdio` 只保证宿主侧不会有「父进程持有且不关闭的 stdin 管道」，它并不剥夺程序访问 `/dev/tty` 的能力。
2. **前置引导**：把「请在外部终端运行」与界面「在工作目录打开终端」入口一并给出，避免模型无意义重试；
3. **避免无意义尝试**：交互式程序在非交互环境下的退出码与输出（如 `top: failed tty get`）对模型是噪声，前置拒绝比事后排错更省轮次。

因此词表定位 = **运行契约 + 前置引导**。这与 v0.2 稿「仅引导设施 / 因此可以 fail-open」的表述不同（评审 B1 修正）。

#### 4.2.6 解析不完整时的处理：fail-closed（评审 B1 修正）

v0.2 稿主张解析失败时放行（fail-open），论据是「词表不承担安全职责」。评审指出该论据不成立：**安全**由策略层负责，但**能力/运行契约**由词表负责，二者是不同的边界；`vim` 只要包在解析器无法处理的 shell 构造里（分段超限、引号不平衡、AST 失败、tokenize 失败），就能绕过能力拒绝——此时既无前置拒绝，也得不到任何引导，且不能排除程序访问 `/dev/tty` 或产生副作用。因此改为分层 fail-closed：

| 解析结果 | 文本是否含 TUI 词素 | 判定 | 错误码 |
| --- | --- | --- | --- |
| 完整可解析，命令位命中 | — | 拒绝 | `SHELL_INTERACTIVE_TTY_REQUIRED`（携带 `tuiMatch`） |
| 完整可解析，包装链/二次解释内命令位命中 | — | 拒绝 | `SHELL_INTERACTIVE_TTY_REQUIRED`（`tuiMatch.segmentIndex` 指向外层段，`match.via` 记录穿透路径） |
| 完整可解析，命令位未命中 | — | 放行 | —（判据精确，误伤已消除） |
| **命令位不可信**（`parse:tree-error` / `segment:N:unparseable` / 段数超限 / 引号不平衡） | **含** | **拒绝** | **`SHELL_TUI_UNDETECTABLE`**（`reason ∈ segments-overflow / unbalanced-quote / tokenize-failed / analysis-partial`） |
| **段内含重定向/命令替换**（`segment:N:shell-control-flow`，命令位仍可判定） | — | **按命令位判定**（**不**进入 undetectable） | —（评审 v12 B4：`git log > top.log` 的命令位是 `git`，放行；`git log > vim` 的目标名不参与判定） |
| **嵌套命令无法静态确认**（`-c "$VAR"`、`eval` 拼接） | **含** | **拒绝** | **`SHELL_TUI_UNDETECTABLE`**（`reason: 'nested-command-unresolvable'`） |
| **递归超出深度上限**（包装链 >4 / 解释 >3） | **含** | **拒绝** | **`SHELL_TUI_UNDETECTABLE`**（`reason: 'recursion-depth-exceeded'`） |
| 解析不完整 / 嵌套不可确认 / 超深度 | 不含 | 放行 | —（判定为 `clear`：无 TUI 词素，不存在被绕过的拒绝） |

要点：

1. **新增错误码 `SHELL_TUI_UNDETECTABLE`**（`SHELL_CASE_IDS.tuiUndetectable = 'SHELL-CAPABILITY-003'`，`RunShellPlanErrorCode` 同步扩展）：`diagnostic.category = 'environment'`、`retryable = false`；`hints` 说明「宿主无法解析/无法静态确认该命令，且其中出现交互式程序词素；请把命令拆分为单条简单命令（避免超长链式、引号不平衡、`-c "$VAR"` 这类间接构造）后重试」。
2. **兜底检测的宽松性有界**：兜底只做「词素出现」判断（复用现词表 + **整条命令文本**扫描），不做命令位判定——因此它可能误伤「命令位不可信 + 文本偶然含 `top`」。该触发域被严格限定为四类少数路径（**命令位不可信**：`parse:tree-error`、`segment:N:unparseable`、段数超限、引号不平衡），**不含**「段内含重定向/命令替换」（`shell-control-flow`，命令位仍可判定——评审 v12 B4）；`git add …top-level-design-v2.md`、`git log > top.log` 这类命令位明确的命令走精确路径，**不受兜底影响**（§4.2.4 已锚定，含重定向对照组）。
3. **不做静默放行**：`kind: 'clear'` 表示「已确认文本无 TUI 词素」，是**可解释的判定结果**并会落日志（`tuiUndetectableCleared`，含 `reason`），与 v0.2 的「返回 undefined 放行」在可观测性上不同。
4. **保证范围闭合（v0.4，回应评审 B2）**：递归穿透与二次解释把「可解析的绕过路径」纳入静态判据，深度上限（包装链 4 层、解释 3 层）之外一律 fail-closed。**明确不保证**的是「运行期才能确定命令位且文本无词素」的情形（如 `$SOMETHING` 运行期解析为 `vim`）——该情形写入 §2.4 保证范围声明的「不保证」列。
5. **验收更新**：G1 增列「解析不完整矩阵」与「包装链/二次解释矩阵」；G4 的「渲染层零调用旧判据」不变；非目标中「不追求让 TUI 程序在应用内可用」保持不变，但**不再**声明「允许未检测出的 TUI 执行」。

---

### 4.3 T-3：错误契约与可自查信息（A-2 / D-1）

#### 4.3.1 现状缺陷

`runShellExecutor.ts:104-112` 的 plan 失败分支：`details` 为空（TTY 分支不传）、`reason` 与 `error` 同字面、`hints` 由无参 `shellTuiFallbackHintLines()` 产生（所有 TUI 判定共用同一文案，且第二行含「下方按钮」的界面措辞）。同族对照：`SHELL_EXECUTABLE_UNAVAILABLE` 带 `{ executable }`、`SHELL_DIALECT_MISMATCH` 带 `{ signals, detectedSyntax, expectedDialect, shellProfileId }`。

#### 4.3.2 `details` 与 `diagnostic`

`RunShellPlanError` 构造（`runShellPlan.ts`）：

```ts
throw new RunShellPlanError('SHELL_INTERACTIVE_TTY_REQUIRED', describeTuiRejection(tuiMatch), { tuiMatch })
```

`runShellExecutor.ts` 的返回体补 `diagnostic`——**按 code 逐项显式映射（评审 B1）**，不用兜底分支承载 TUI 语义。

前提：`RunShellPlanErrorCode` 必须先扩展（**扩展后的完整定义，唯一一处**——`electron/tools/runShellPlan.ts`）：

```ts
export type RunShellPlanErrorCode =
  | 'SHELL_PLAN_INVALID'
  | 'SHELL_EXECUTABLE_UNAVAILABLE'
  | 'SHELL_INTERACTIVE_TTY_REQUIRED'
  | 'SHELL_TUI_UNDETECTABLE'          // ← 本次新增（§4.2.6）
  | 'SHELL_DIALECT_MISMATCH'
```

> v0.12 前稿只在 §4.2.6 写「`RunShellPlanErrorCode` 同步扩展」，未给扩展后的定义，且 §1.1 引用的是现有四成员版本——按片段实施时 §4.2.3 的 `throw new RunShellPlanError('SHELL_TUI_UNDETECTABLE', …)` 与下面的 `caseIdForPlanError` 都会编译失败。本处为唯一定义处。

映射函数：

```ts
/**
 * 计划期错误 → caseId。逐项显式登记。
 *
 * 评审 v12 门禁 1：**不用静默 `default` 承载新增 code**。若写成
 * `case 'SHELL_PLAN_INVALID': default: return SHELL_CASE_IDS.planInvalid`，
 * 将来给 `RunShellPlanErrorCode` 加成员却忘了补映射时，TS 不会报错，
 * 会静默把新错误码归到 SHELL-PLAN-001（错误的 caseId 会进审计与模型 payload）。
 * 因此保留 default 分支的**运行时兜底**（函数在任何输入下都有返回值），
 * 但在其中加 `never` 断言，使「新增成员未补映射」变成**编译错误**。
 */
function caseIdForPlanError(code: RunShellPlanErrorCode): string {
  switch (code) {
    case 'SHELL_INTERACTIVE_TTY_REQUIRED': return SHELL_CASE_IDS.tuiRequiresTerminal   // SHELL-CAPABILITY-001
    case 'SHELL_TUI_UNDETECTABLE':         return SHELL_CASE_IDS.tuiUndetectable       // SHELL-CAPABILITY-003
    case 'SHELL_EXECUTABLE_UNAVAILABLE':   return SHELL_CASE_IDS.executableUnavailable // SHELL-CAPABILITY-002
    case 'SHELL_DIALECT_MISMATCH':         return SHELL_CASE_IDS.dialectMismatch       // SHELL-DIALECT-001
    case 'SHELL_PLAN_INVALID':             return SHELL_CASE_IDS.planInvalid           // SHELL-PLAN-001
    default: {
      // 新增成员未补映射时，`code` 不再是 `never` → 本行编译失败（门禁生效）
      const exhaustive: never = code
      throw new Error(`unmapped RunShellPlanErrorCode: ${String(exhaustive)}`)
    }
  }
}

/**
 * diagnostic 只表达**真实归因**：仅两类 TUI 拒绝属于「能力/环境」。
 * 其余计划错误一律返回 undefined（维持既有语义），原因：
 * - 方言错配是**可改写重试**的（既有 dialectRetryBreaker 产出 retryCount/retryExhausted），
 *   标成 retryable:false + environment 会破坏该语义；
 * - 可执行文件缺失与计划非法今日亦无 diagnostic，本次不动。
 */
function diagnosticForPlanError(code: RunShellPlanErrorCode): ToolExecutorResult['diagnostic'] | undefined {
  if (code === 'SHELL_INTERACTIVE_TTY_REQUIRED' || code === 'SHELL_TUI_UNDETECTABLE') {
    return { caseId: caseIdForPlanError(code), retryable: false, category: 'environment' }
  }
  return undefined
}
```

同族的 `diagnosticForPlanError` 采用 `if` 判断（非 switch），对未知 code 返回 `undefined`——这对运行期是安全的（**不写 `diagnostic` 优于写错归因**，符合 §2.3 归因不变量），但同样存在「新增『能力/环境』类错误却忘记加进条件」的漏改可能（TS 不会强制）。因此配套约束（**评审 v12 门禁 1 的另一半**）：**新增任何属于「能力/环境」归因的 code，必须同时把它加入 `diagnosticForPlanError` 的判据，并在下面的逐项契约表中补一行**——T3-4 按该表逐行断言，漏行即漏测。

```ts
const tuiMatch = planError?.details.tuiMatch as ShellTuiMatch | undefined
const tuiUndetectable = planError?.details.tuiUndetectable as { reason: string; programs: string[] } | undefined
const diagnostic = diagnosticForPlanError(code)
return {
  success: false,
  error: code,
  data: {
    code,
    reason: message,                 // 可解释文本，不再是错误码副本
    processResult: null,
    ...planError?.details,           // { tuiMatch } / { tuiUndetectable } / { signals, … } / { executable }
    ...(retry ? { retryCount: retry.count, retryExhausted: retry.tripped } : {}),
    caseId: caseIdForPlanError(code),
    ...(code === 'SHELL_INTERACTIVE_TTY_REQUIRED' && tuiMatch ? { hints: shellTuiHintLines(tuiMatch) } : {}),
    ...(code === 'SHELL_TUI_UNDETECTABLE' && tuiUndetectable
      ? { hints: shellTuiUndetectableHintLines(tuiUndetectable) } : {})
  },
  ...(diagnostic ? { diagnostic } : {}),   // 非 TUI 错误**不出现**该键（与今日一致）
  duration: Date.now() - started
}
```

**逐项结果契约（T3-4 的基准，评审 B1 要求）**：

| `code` | `data.caseId` | 顶层 `diagnostic` | 可重试语义 |
| --- | --- | --- | --- |
| `SHELL_INTERACTIVE_TTY_REQUIRED` | `SHELL-CAPABILITY-001` | `{ caseId: 'SHELL-CAPABILITY-001', retryable: false, category: 'environment' }` | 不可重试（能力限制） |
| `SHELL_TUI_UNDETECTABLE` | `SHELL-CAPABILITY-003` | `{ caseId: 'SHELL-CAPABILITY-003', retryable: false, category: 'environment' }` | 不可重试（能力限制） |
| `SHELL_EXECUTABLE_UNAVAILABLE` | `SHELL-CAPABILITY-002` | **无该键** | 保持既有 |
| `SHELL_DIALECT_MISMATCH` | `SHELL-DIALECT-001` | **无该键** | **保持既有**（`retryCount`/`retryExhausted` + `dialectRetryBreaker`） |
| `SHELL_PLAN_INVALID`（含兜底） | `SHELL-PLAN-001` | **无该键** | 保持既有 |

两类 TUI 错误额外满足 `data.caseId === diagnostic.caseId`（唯一需要一致性的两行）；其余三行断言的是「**不出现** `diagnostic`」。

- `projectDiagnostic` 的 `DIAGNOSTIC_KEYS` 已含 `caseId`/`retryable`/`category`（`processResultProjection.ts:85`），故 `diagnostic` 会原样出现在模型 payload 顶层；`serializeAgentToolResult` 也已支持顶层 `diagnostic`（`src/shared/agentToolResult.ts:24`）。
- `category: 'environment'` 是**归因结论**：该拒绝与命令语义无关，是宿主执行环境不具备交互能力。
- 与策略拒绝的区别由此显式化：策略拒绝走审批通道（`notExecutedReason`/`ApprovalCause`），能力拒绝走 `diagnostic.category='environment'`。
- **归因不变量**（§2.3 第 5 条）：不得为无归因结论的错误补默认 `diagnostic`。`validateToolExecutorResult`（`electron/tools/types.ts`）仅在**结果契约违规**时补 `category:'executor'`，与本映射互补、不冲突。

#### 4.3.3 `reason`：可解释文本

新增 `describeTuiRejection(match)`（放 `electron/shell/shellTuiDetection.ts` 或 `src/shared/shellInteractiveTui.ts`）：

```ts
export function describeTuiRejection(match: ShellTuiMatch): string {
  const ruleText =
    match.rule === 'tui-program' ? `命令位为交互式全屏程序 ${match.program}`
    : match.rule === 'npm-init-interactive' ? 'npm init 为交互式向导（未带 -y）'
    : 'git rebase 为交互式（-i）'
  const via = match.via?.length ? `（经 ${match.via.join(' → ')} 穿透）` : ''
  return `SHELL_INTERACTIVE_TTY_REQUIRED: ${ruleText}${via}（第 ${match.segmentIndex + 1} 个子命令）。` +
    '这是执行环境限制，不是安全策略拒绝；请改写为非交互形式，或请用户在外部终端执行。'
}
```

- `via` 为可选字段（§4.2.2 第 2 点），仅在经过包装链/二次解释时有值；把穿透路径写进 `reason` 是评审 B2 的直接要求——否则用户看到 `env sudo vim f` 被拒时无法理解「命中的不是 `env`」。
- **方言错配不受影响（评审 B1）**：`SHELL_DIALECT_MISMATCH` 的 `reason`、`retryCount`、`retryExhausted` 与 `dialectRetryBreaker` 语义**全部保持**，本次只新增两类 TUI 错误的 `reason` 文案与 `diagnostic`。

- 投影层 `hasPlanDiagnosticMarker` 对 `code` 匹配 `^SHELL_[A-Z0-9_]{1,48}$` 者放行 `reason` 自由文本（`processResultProjection.ts:366-375`），通道已存在，本次是把内容填进去。
- `reason` 长度受 `sanitizeAdviceText` 约束（≤512 字符），文案需留余量。

**不可检测分支的文案**（同一模块，评审 B1）：

```ts
export function describeUndetectableRejection(v: { reason: string; programs: readonly string[] }): string {
  const why = v.reason === 'segments-overflow' ? '命令段数超出宿主解析上限'
    : v.reason === 'unbalanced-quote' ? '引号不平衡'
    : v.reason === 'tokenize-failed' ? '存在无法分词的命令段'
    : '命令分析结果不完整'
  return `SHELL_TUI_UNDETECTABLE: ${why}，宿主无法可信判断命令位；文本中出现 ${v.programs.join('、')}。` +
    '该程序在应用内不可用（执行环境限制，不是安全策略拒绝）。请把命令拆分为单条简单命令后重试。'
}
```

`hints` 对应三条：① 说明「无法解析 + 含交互式程序词素」；② 说明该程序在应用内不可用、**不要换途径重试**；③ 给出拆分建议（避免超长链式构造与省略闭合引号）。

#### 4.3.4 `hints`：参数化 + 模型/界面职责分离

```ts
// src/shared/shellInteractiveTui.ts
// 评审 v12 M1：ShellTuiMatch 此前未 import（片段无法编译）；该类型由 shared 契约模块提供
import type { ShellTuiMatch } from './shellTuiContract'

export function shellTuiHintLines(match: ShellTuiMatch): string[] {
  return [
    `run_shell 在 SpaceAssistant 内以非交互方式执行（标准输入已关闭、分页器已禁用），无法承载 ${match.program} 这类全屏或需要键盘输入的程序。`,
    '这属于「执行环境/能力限制」，不是安全策略拒绝；不要改用其他工具或换写法重复尝试同一交互程序。',
    '若该任务可用非交互命令完成（例如 git add/commit、git --no-pager log、npm init -y），请改写后重试；若必须交互执行，请把命令与用途告知用户，由用户在系统终端中运行。'
  ]
}

/**
 * 不可检测分支的模型侧提示（唯一一处定义，评审 v15 补）。
 * 参数类型与判定层的 `{ kind: 'undetectable', reason, programs }` 对应，
 * 由 electron/tools/runShellExecutor.ts 经 `planError.details.tuiUndetectable` 传入。
 */
export function shellTuiUndetectableHintLines(v: { reason: string; programs: readonly string[] }): string[] {
  const why =
    v.reason === 'segments-overflow' ? '命令段数超出宿主解析上限'
    : v.reason === 'unbalanced-quote' ? '引号不平衡'
    : v.reason === 'tokenize-failed' ? '存在无法分词的命令段'
    : v.reason === 'nested-command-unresolvable' ? '嵌套命令含变量/命令替换，无法静态确认'
    : v.reason === 'recursion-depth-exceeded' ? '命令嵌套层数超出宿主分析上限'
    : '命令分析结果不完整'
  const programs = v.programs.length > 0 ? v.programs.join('、') : '交互式程序'
  return [
    `宿主无法可信判断该命令的命令位（${why}），且文本中出现 ${programs}。`,
    '这属于「执行环境/能力限制」，不是安全策略拒绝；不要改用其他工具或换写法重复尝试同一交互程序。',
    '请把命令拆分为单条简单命令后重试；若必须交互执行，请把命令与用途告知用户，由用户在系统终端中运行。'
  ]
}
```

**两处提示的约束一致**（评审 v15 明确）：均返回 3 条、每条 ≤512 字符（`sanitizeAdviceList` 上限），且都**不含**界面专属措辞（如「下方按钮」）。`shellTuiUndetectableHintLines` 的 `reason` 分支覆盖 §4.2.2 的六个合法值（用 `string` 而非受限联合入参，因为调用点来自 `Record<string, unknown>` 的 details，判定层已保证取值合法；此处对未知值退化为通用文案而非抛错）。

要点：

1. **删除界面措辞**：不再出现「下方按钮」。界面侧由 i18n 独立表达（`shell.tuiTitle`/`shell.tuiLine1`/`shell.tuiLine2`/`shell.openTerminal` 保持不动）。
2. **「双份维护」的处理方式（D-4 相关）**：不再要求两处逐字相同，而是明确职责边界——
   - 模型侧（`shellTuiHintLines`）：事实 + 纪律，服务「模型下一步怎么做」；
   - 界面侧（i18n）：事实 + 用户操作入口，服务「用户点哪里」。
   两边都以 `tuiMatch` 的**同一事实**为输入，因此不会出现「说的不是同一件事」；任何一侧改动都不需要同步另一侧。为防回归，测试只锚定「两侧都包含命中程序名」（§7.3）。
3. **删除死代码**：`SHELL_TUI_FALLBACK_TITLE`（`shellInteractiveTui.ts:26`，全仓库零引用）删除；若担心外部引用，先在 `git grep` 确认（当前为零）。
4. `hints` 的投影约束：≤8 条、每条 ≤512 字符（`sanitizeAdviceList`，`processResultProjection.ts:282-290`），本方案 3 条、均在限内。

#### 4.3.5 投影白名单新增键 `tuiMatch`

`src/shared/processResultProjection.ts`：

```ts
// src/shared/processResultProjection.ts
// 评审 v5：从 shared 同层纯模块引用（**不是** electron 侧），保持 shared 对 electron 零依赖
// 评审 v15：类型也必须在同一 import 中引入——下面两个投影函数的签名引用了它们
import {
  SHELL_TUI_RULES,
  SHELL_TUI_UNDETECTABLE_REASONS,
  type ShellTuiRule,
  type ShellTuiUndetectableReason
} from './shellTuiContract'

// PROCESS_KEYS 追加
'tuiMatch', 'tuiUndetectable',

// projectProcessDataForSink 内新增显式分支（不依赖默认透传）
if (key === 'tuiMatch') {
  // 评审 B3：telemetry 完全丢弃本键——program 是命令位信息（可指纹化用户行为），
  // telemetry 出口只保留既有 caseId（SHELL-CAPABILITY-001）用于定位。
  if (sink === 'telemetry') continue
  const match = projectTuiMatch(entry)
  if (match) out[key] = match
  continue
}
if (key === 'tuiUndetectable') {
  if (sink === 'telemetry') continue
  const block = projectTuiUndetectable(entry)
  if (block) out[key] = block
  continue
}

function projectTuiMatch(value: unknown): { program: string; rule: ShellTuiRule; segmentIndex: number } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const { program, rule, segmentIndex } = value as Record<string, unknown>
  if (typeof program !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(program)) return undefined
  // 评审 v5：rule 白名单同样来自 shared 契约，禁止在投影层重复书写字面量联合
  if (typeof rule !== 'string' || !SAFE_TUI_RULES.has(rule)) return undefined
  if (typeof segmentIndex !== 'number' || !Number.isInteger(segmentIndex) || segmentIndex < 0 || segmentIndex > 49) return undefined
  return { program, rule: rule as ShellTuiRule, segmentIndex }
}

/** 不可检测分支：reason 走受控枚举，programs 逐项走 basename 形态校验，telemetry 由上面的分支丢弃整块。 */
const SAFE_TUI_RULES = new Set<string>(SHELL_TUI_RULES)
const SAFE_UNDETECTABLE_REASONS = new Set<string>(SHELL_TUI_UNDETECTABLE_REASONS)

function projectTuiUndetectable(value: unknown): { reason: ShellTuiUndetectableReason; programs: string[] } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const { reason, programs } = value as Record<string, unknown>
  // 评审 v4-B1：白名单必须与判定层的 SHELL_TUI_UNDETECTABLE_REASONS 同源，
  // 否则新增原因（如 nested-command-unresolvable）会被静默丢弃、结构化原因到不了模型。
  if (typeof reason !== 'string' || !SAFE_UNDETECTABLE_REASONS.has(reason)) return undefined
  if (!Array.isArray(programs)) return undefined
  const safePrograms = programs
    .filter((p): p is string => typeof p === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(p))
    .slice(0, 8)
  return { reason: reason as ShellTuiUndetectableReason, programs: safePrograms }
}
```

**投影层与判定层的同源约束（评审 v4-B1 / v5，防再次漂移与越界）**：

- `projectTuiUndetectable` 与 `projectTuiMatch` **不得**再写内联枚举；必须用 `new Set(SHELL_TUI_UNDETECTABLE_REASONS)` / `new Set(SHELL_TUI_RULES)`（或等价引用），且这两个数组只能从 `src/shared/shellTuiContract.ts`（**shared 同层**）导入。
- **边界约束（评审 v5）**：`src/shared/**` 不得 import `electron/**`；该约束由 `npm run typecheck:shared`（`tsconfig.renderer.gate.json` 只 include `src/shared/**`、exclude `electron/**`）与 `npm run typecheck:renderer` 机械保证——一旦越界，模块不可解析、检查直接失败。因此**不需要**新增 lint 规则或专门脚本。
- 建议加一条轻量回归：遍历 `SHELL_TUI_UNDETECTABLE_REASONS`，对每个值构造一次 payload 并断言 `projectTuiUndetectable` 保留（即 **T3-5**），这样将来新增原因若漏改投影会立即失败。

**telemetry 契约的唯一定义（评审 B3，替代 v0.2 的「键仍在」）**：

| 出口 | `tuiMatch` | `tuiUndetectable` | `caseId` | 说明 |
| --- | --- | --- | --- | --- |
| `agent`（模型可见） | 保留（program/rule/segmentIndex） | 保留（reason/programs） | 保留 | 模型需要命中事实才能自查 |
| `local_history` | 保留 | 保留 | 保留 | 与 agent 同源（既有不变量） |
| `telemetry` | **丢弃（不出现该键）** | **丢弃（不出现该键）** | 保留 | 不落命令位信息；定位能力由 `caseId` 提供 |

**`diagnostic` 在 telemetry 出口的实际投影（评审 B3 新增，必须按代码推导而非按意图写）**：

`projectDiagnostic`（`processResultProjection.ts:327-343`）的规则是：`code`/`caseId` 在 telemetry 需匹配 `STABLE_CODE_RE = /^[A-Z][A-Z0-9_.-]{2,127}$/`；其余键为字符串时，telemetry 下**必须以同一正则匹配**才保留，boolean/number/null 则无条件保留。由此逐字段推导：

| `diagnostic` 字段 | 值 | telemetry 结果 | 原因 |
| --- | --- | --- | --- |
| `caseId` | `'SHELL-CAPABILITY-001'` | **保留** | 大写 → 匹配 `STABLE_CODE_RE` |
| `retryable` | `false`（boolean） | **保留** | 非字符串，不受该正则约束 |
| `category` | `'environment'`（小写） | **丢弃** | 小写开头 → 不匹配 `^[A-Z]` |

**取定：telemetry 不保留 `category`**（不改动既有投影规则）。理由：① 最小改动，避免为单个字段在通用投影函数里开例外，影响其他工具的 diagnostic 投影；② telemetry 已能通过 `caseId`（`SHELL-CAPABILITY-001` / `-003`）区分归因，信息不缺失；③ `caseId` 属既有稳定码通道，语义等价且更强（区分两类能力拒绝）。若数据侧确需 `category`，正确做法是给它单独的**固定枚举白名单**（`SAFE_DIAGNOSTIC_CATEGORIES`），而不是放宽通用正则——列入 §10 第 9 条，本次不做。

> **断言的序列化口径（评审 v12 M4，实现时必须注意）**：`projectDiagnostic` 对 telemetry 的处理是**把该键置为 `undefined`**（`processResultProjection.ts:336-338` 的三元），随后 `for (const key of Object.keys(out)) if (out[key] === undefined) delete out[key]` 删除它。因此：
> - **对象层面**：`delete` 之后 `category` **不存在**于返回对象上（键不存在，而非「键在、值 undefined」）；
> - **若走 JSON 序列化**（`serializeAgentToolResult` / `JSON.stringify`）：`undefined` 值同样不会出现在 JSON 文本中；
> - **断言写法**：统一按「序列化后的 JSON 不含 `category`」断言（`expect(JSON.parse(serialized)…).not.toHaveProperty('category')`），**不要**写成「值为 `undefined`」——后者在对象层面会假通过（键已被 delete），在 JSON 层面又无法表达，属口径歧义。

若后续确需在 telemetry 中区分两类拒绝，**不得**复用自由字段，而应新增稳定枚举键（如 `tuiRule`）并纳入 `DIAGNOSTIC_KEYS` 白名单与 `SAFE_*` 枚举校验。

理由（为什么必须写显式分支而非依赖默认透传）：若仅把键加入 `PROCESS_KEYS` 而不加分支，会落到 `if (sink !== 'telemetry') out[key] = entry` 的默认透传（`processResultProjection.ts:585`），等于放弃值校验；显式分支保证 program/rule 走枚举形态校验、且 telemetry 出口有确定行为（丢弃而非「未定义」）。

#### 4.3.6 三出口精确期望 JSON（评审 B3 要求）

**输入（executor 返回体）**：

```ts
{ success: false, error: 'SHELL_INTERACTIVE_TTY_REQUIRED',
  data: { code: 'SHELL_INTERACTIVE_TTY_REQUIRED', caseId: 'SHELL-CAPABILITY-001',
          reason: 'SHELL_INTERACTIVE_TTY_REQUIRED: 命令位为交互式全屏程序 top（第 1 个子命令）。…',
          tuiMatch: { program: 'top', rule: 'tui-program', segmentIndex: 0 },
          processResult: null, hints: ['…','…','…'] },
  diagnostic: { caseId: 'SHELL-CAPABILITY-001', retryable: false, category: 'environment' } }
```

**① agent 出口**（`projectAgentToolResultForSink`，即 `serializeAgentToolResult` 的 payload）：

```json
{"ok":false,"error":"SHELL_INTERACTIVE_TTY_REQUIRED",
 "diagnostic":{"caseId":"SHELL-CAPABILITY-001","retryable":false,"category":"environment"},
 "data":{"code":"SHELL_INTERACTIVE_TTY_REQUIRED",
   "caseId":"SHELL-CAPABILITY-001",
   "reason":"SHELL_INTERACTIVE_TTY_REQUIRED: 命令位为交互式全屏程序 top（第 1 个子命令）。…",
   "tuiMatch":{"program":"top","rule":"tui-program","segmentIndex":0},
   "processResult":null,
   "hints":["…","…","…"]}}
```

**② local_history 出口**：与 ① **逐字段一致**（既有不变量「本地历史必须重放 Agent 实际看到的结果」），期望 JSON 相同。

**③ telemetry 出口**（`projectTelemetryToolResult`）：

```json
{"ok":false,"errorCode":"SHELL_INTERACTIVE_TTY_REQUIRED",
 "diagnostic":{"caseId":"SHELL-CAPABILITY-001","retryable":false},
 "data":{"code":"SHELL_INTERACTIVE_TTY_REQUIRED","caseId":"SHELL-CAPABILITY-001","processResult":null}}
```

要点（**逐字段，按 §4.3.5 的投影规则推导**）：

- `data` 中**不含** `tuiMatch`、**不含** `reason`、**不含** `hints`（`tuiMatch` 由显式分支丢弃；`reason` 已被 `hasPlanDiagnosticMarker` 的 telemetry 分支排除；`hints` 本就只在非 telemetry 出口）。
- `diagnostic` 中**不含 `category`**（小写值不匹配 `STABLE_CODE_RE`，被既有规则丢弃），`caseId` 与 `retryable` 保留。
- `errorCode` 走 `STABLE_CODE_RE` 保留（`error` 字段在 telemetry 出口被重命名为 `errorCode`）。

**不可检测分支（`SHELL_TUI_UNDETECTABLE`）的差异**：① ② 中为 `"tuiUndetectable":{"reason":"unbalanced-quote","programs":["less"]}`（无 `tuiMatch`），`caseId` 为 `SHELL-CAPABILITY-003`，`diagnostic.caseId` 同值；③ 中 `tuiUndetectable` 同样**完全丢弃**，`diagnostic` 为 `{"caseId":"SHELL-CAPABILITY-003","retryable":false}`（无 `category`）。

**测试口径（评审 B3 要求）**：三份 JSON 不写成手工期望字符串，而是以**真实投影函数的输出**为准做逐字段断言——即先断言「键集合与值」，再对 telemetry 断言「`data` 无 `tuiMatch`/`tuiUndetectable`/`reason`/`hints`，`diagnostic` 无 `category`」。这样不会因投影规则演进而产生「文档与实现不一致」的假通过。

对照修复前（需求清单 §A-2 的 payload）：新增 `diagnostic`（归因）、`tuiMatch`（命中事实）、`reason` 变为可解释文本、`hints` 与命中相关。模型由此可在 1 次失败内定位原因（G2 验收：不再出现同一原因连续 5 次重试）。

---

### 4.4 T-4：单一事实来源（A-4 / D-6）

#### 4.4.1 现状

三处独立计算（全部仍在，见 §1.1）：

| # | 位置 | 作用 |
| --- | --- | --- |
| 1 | `runShellPlan.ts:102` | 后端权威判定（T-2 将改为命令位判据） |
| 2 | `ShellTuiFallbackHint.tsx:36` | 是否渲染提示卡 |
| 3 | `ToolCallCard.tsx:163` | `useTerminalUi`（第 170 行）与 pending 提示（第 627 行） |

三处输入都是 `record.input.command`，不是执行结果。T-2 收紧判据后若不同步改渲染层，将立即出现「后端放行、界面仍显示『此命令需要交互式终端』」的失真。

#### 4.4.2 跨层契约常量与类型下移 shared（N-3；评审 v5 扩展）

**原则（v0.6 明确）**：**凡是被渲染层或 shared 投影层消费的字面量域与类型，必须定义在 `src/shared/`**，主进程侧一律 `import` 引用、不得重复声明。理由有二：① 渲染层无法引用 `electron/**`（`tsconfig.renderer.json` 的 include 不含 electron）；② 两份声明必然漂移（v0.4/v0.5 两次评审已各出现一次同类缺陷）。

本方案涉及两个下移，模式相同：

| 新增 shared 模块 | 内容 | 消费方 |
| --- | --- | --- |
| `src/shared/shellCaseIds.ts` | `SHELL_TUI_CASE_ID`（`SHELL-CAPABILITY-001`）、`SHELL_TUI_REJECTED_ERROR`、`SHELL_TUI_UNDETECTABLE_CASE_ID`（`SHELL-CAPABILITY-003`）、`SHELL_TUI_UNDETECTABLE_ERROR` | 渲染层 `resolveShellTuiNotice`；electron 侧 `shellCaseIds.ts` 以 `import` 复用（避免两处字面量） |
| `src/shared/shellTuiContract.ts` | `SHELL_TUI_RULES`/`ShellTuiRule`、`SHELL_TUI_UNDETECTABLE_REASONS`/`ShellTuiUndetectableReason`、`ShellTuiMatch` | 主进程判定层、shared 投影层（`processResultProjection.ts`）、shared 展示层（`shellToolDisplay.ts`） |

```ts
// src/shared/shellCaseIds.ts（新增；先只迁渲染层需要的两项，其余按需分步迁）
export const SHELL_TUI_CASE_ID = 'SHELL-CAPABILITY-001'
export const SHELL_TUI_REJECTED_ERROR = 'SHELL_INTERACTIVE_TTY_REQUIRED'
export const SHELL_TUI_UNDETECTABLE_CASE_ID = 'SHELL-CAPABILITY-003'
export const SHELL_TUI_UNDETECTABLE_ERROR = 'SHELL_TUI_UNDETECTABLE'
```

> 说明：全量搬迁 `SHELL_CASE_IDS` 会牵动大量 electron 文件；本任务只迁渲染层与投影层需要的两项（`shellTuiContract.ts` 见 §4.2.2）。**electron 侧的 delta 形态**（唯一一处，避免与 shared 两处字面量）：

```ts
// electron/shell/shellCaseIds.ts
import {
  SHELL_TUI_CASE_ID,
  SHELL_TUI_UNDETECTABLE_CASE_ID
} from '../../src/shared/shellCaseIds'

export const SHELL_CASE_IDS = {
  unboundedOutput: 'SHELL-OUTPUT-001',
  outputPersistFailed: 'SHELL-OUTPUT-002',
  progressFlood: 'SHELL-PROGRESS-001',
  tuiRequiresTerminal: SHELL_TUI_CASE_ID,              // ← 改为引用 shared（原为字面量）
  tuiUndetectable: SHELL_TUI_UNDETECTABLE_CASE_ID,     // ← 本次新增（SHELL-CAPABILITY-003）
  dialectMismatch: 'SHELL-DIALECT-001',
  terminationUnconfirmed: 'SHELL-LIFECYCLE-001',
  processTreeRecovery: 'SHELL-LIFECYCLE-002',
  spawnError: 'SHELL-LIFECYCLE-003',
  promiseConvergence: 'SHELL-LIFECYCLE-004',
  planInvalid: 'SHELL-PLAN-001',
  executableUnavailable: 'SHELL-CAPABILITY-002'
} as const
```

`SHELL_CASE_IDS` 仍是 `as const`，故新增项与既有项的用法完全一致（`caseIdForPlanError` 直接返回它）。

#### 4.4.3 共享判定函数（唯一判据）

`src/shared/shellToolDisplay.ts` 新增：**`ShellTuiNotice` 类型**（`resolveShellTuiNotice` 的完整实现见下方「类型收窄」小节——那里同时给出必需的 import 与类型守卫；本节不再重复给出无守卫的简化版，以免并行两份定义，评审 v12 结构复核）。

```ts
// src/shared/shellToolDisplay.ts
export type ShellTuiNotice =
  | { kind: 'tui'; program?: string; rule?: ShellTuiRule; segmentIndex?: number }
  | { kind: 'undetectable'; reason?: ShellTuiUndetectableReason; programs?: string[] }
```

- `ShellResultData` 增字段并按既有风格解析（`parseShellResultData`）：

```ts
tuiMatch?: { program: string; rule: string; segmentIndex: number }
tuiUndetectable?: { reason: string; programs?: string[] }
```

**类型收窄（评审 v8 B2，必须先做类型守卫再构造 `ShellTuiNotice`）**：`parseShellResultData` 是运行期宽松解析，其 `reason`/`programs` 的静态类型是 `string`/`string[]`，而 `ShellTuiNotice` 的 `reason` 是受限联合 `ShellTuiUndetectableReason`。若直接 `...spread`，`string` 不可赋值给受限联合 → **`npm run typecheck:renderer` 直接失败**。因此 `resolveShellTuiNotice` 必须显式校验：

```ts
// src/shared/shellToolDisplay.ts
// 评审 v12 M1：入参类型 ToolCallResultPersisted 此前未 import（原片段无法编译）
import type { ToolCallResultPersisted } from './domainTypes'
import { SHELL_TUI_CASE_ID, SHELL_TUI_REJECTED_ERROR, SHELL_TUI_UNDETECTABLE_CASE_ID, SHELL_TUI_UNDETECTABLE_ERROR } from './shellCaseIds'
import { SHELL_TUI_RULES, SHELL_TUI_UNDETECTABLE_REASONS, type ShellTuiRule, type ShellTuiUndetectableReason } from './shellTuiContract'

const TUI_RULE_SET = new Set<string>(SHELL_TUI_RULES)
const TUI_REASON_SET = new Set<string>(SHELL_TUI_UNDETECTABLE_REASONS)

function asTuiRule(value: unknown): ShellTuiRule | undefined {
  return typeof value === 'string' && TUI_RULE_SET.has(value) ? (value as ShellTuiRule) : undefined
}
function asTuiReason(value: unknown): ShellTuiUndetectableReason | undefined {
  return typeof value === 'string' && TUI_REASON_SET.has(value) ? (value as ShellTuiUndetectableReason) : undefined
}
/** 与投影层同口径：程序名逐项做 basename 形态校验并截断到 8 条。 */
function asProgramList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out = value.filter((p): p is string => typeof p === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(p)).slice(0, 8)
  return out.length ? out : undefined
}

export function resolveShellTuiNotice(result: ToolCallResultPersisted | undefined): ShellTuiNotice | undefined {
  if (!result || result.success === true) return undefined
  const data = parseShellResultData(result.data)
  if (result.error === SHELL_TUI_UNDETECTABLE_ERROR || data?.caseId === SHELL_TUI_UNDETECTABLE_CASE_ID) {
    const reason = asTuiReason(data?.tuiUndetectable?.reason)
    const programs = asProgramList(data?.tuiUndetectable?.programs)
    return { kind: 'undetectable', ...(reason ? { reason } : {}), ...(programs ? { programs } : {}) }
  }
  if (result.error === SHELL_TUI_REJECTED_ERROR || data?.caseId === SHELL_TUI_CASE_ID) {
    const rule = asTuiRule(data?.tuiMatch?.rule)
    const programs = asProgramList(data?.tuiMatch?.program ? [data.tuiMatch.program] : undefined)
    return {
      kind: 'tui',
      ...(programs?.length ? { program: programs[0] } : {}),
      ...(rule ? { rule } : {}),
      ...(typeof data?.tuiMatch?.segmentIndex === 'number' ? { segmentIndex: data.tuiMatch.segmentIndex } : {})
    }
  }
  return undefined
}
```

> `ShellResultData` 中新增的两个字段**保持宽松类型**（`string` / `string[]`）——它们描述的是「从 DB 读出的原始值」，收窄发生在 `resolveShellTuiNotice` 这一处消费点。
>
> **与「`parseShellResultData` 本次不改」的关系（澄清）**：本方案**确实要在 `parseShellResultData` 中新增这两个字段的解析**（与既有 30 余字段同风格、仍为宽松）；「不改」专指**不改变它的宽松解析策略**（即不采用评审 v8 备选方案「在该函数内用 shared 常量收窄 `rule`/`reason` 类型」）。两句话不矛盾，原稿措辞易被读成「连字段也不加」，特此明确。

- **历史消息兼容**：`result.error` 是持久化字段（事件流精简形态亦含），因此旧失败记录同样能命中判据；`tuiMatch` 缺失时返回 `{ kind: 'tui' }`，提示卡退化为**不带命中信息的通用文案**（仍保留「打开终端」入口）。这保证 T-4 不回退既有历史消息的可用性。
- **不可检测分支的界面引导**：也走同一卡片（避免「后端拒绝、界面零引导」的失真），但文案不同——`kind: 'undetectable'` 时用 `shell.tuiUndetectableLine`（说明「宿主无法解析该命令，请拆分为单条简单命令」），「打开终端」入口保留（用户可能确实要在外部终端跑）。
- 两个错误码都只影响**是否展示引导**，不影响任何安全判定（策略层与审批不受该函数影响）。

#### 4.4.4 渲染层改造

| 文件 | 改动 |
| --- | --- |
| `ShellTuiFallbackHint.tsx` | props 由 `{ command, workDir }` 改为 `{ notice, workDir }`；删除 `isInteractiveShellTuiCommand` 导入与判定；按 `notice.kind` 选择文案——`tui` 且含 `program` 时补 `shell.tuiMatchedProgram`（`{{program}}`），`undetectable` 时用 `shell.tuiUndetectableLine` |
| `ToolCallCard.tsx:157-170` | 新增 `const tuiNotice = shellCommand ? resolveShellTuiNotice(record.result) : undefined`；`!isInteractiveTui` → `!tuiNotice`；删除 `isInteractiveShellTuiCommand` 导入 |
| `ToolCallCard.tsx:632` | `<ShellTuiFallbackHint notice={tuiNotice} workDir={workDir} />`（渲染条件由组件内部判定改为 `tuiNotice ? … : null`） |
| `src/shared/shellInteractiveTui.ts` | **删除** `isInteractiveShellTuiCommand`、`SHELL_TUI_FALLBACK_TITLE` **与无参的 `shellTuiFallbackHintLines()`**（后者是本方案要替换的静态模板，§4.3.1）；**新增** `shellTuiHintLines(match: ShellTuiMatch)` 与 `shellTuiUndetectableHintLines(v)`（两者在当前代码中**并不存在**，属本次新增；v0.15 前稿误写为「保留」）。**`ShellTuiMatch`/`ShellTuiRule`/原因枚举改由 `src/shared/shellTuiContract.ts` 提供**（§4.2.2），本文件不再声明这些类型；`ShellTuiVerdict` 留在主进程判定模块 |
| i18n | 新增 `shell.tuiMatchedProgram`、`shell.tuiUndetectableLine`（zh/en 各一条） |

行为变化（需在测试中锚定）：

1. **`executing` 阶段不再渲染提示卡**（此前按命令文本即渲染）。这是**修正**：命中词表的命令在 plan 期即失败，不存在处于 `executing` 的命中命令；反之 `executing` 的命令必然已通过判据。
2. `executing` 阶段的 terminal 视图隐藏逻辑消失——由于第 1 点的同一理由，不影响实际呈现。

#### 4.4.5 界面/模型提示的一致性测试（防再次分叉）

`src/renderer/components/Chat/ShellTuiFallbackHint.test.tsx`（新增）与 `shellInteractiveTui.test.ts`：

- 给定同一 `tuiMatch.program='top'`，界面文案包含 `top`，模型 hints 首条包含 `top`；
- 给定同一不可检测判定（`programs: ['less']`），界面文案说明「拆分命令」，模型 hints 同样给出拆分建议；
- 把词表新增程序名时，两处同时失败 → 强制同批维护。

---

### 4.5 T-5：模型纪律与话术边界（A-3 / D-4）

#### 4.5.1 问题性质

A-3 是 **Agent 行为**问题：把 `SHELL_INTERACTIVE_TTY_REQUIRED`（能力层）说成安全策略拦截，并给出错误的机制描述。宿主侧无法通过对工具实现「拦截行为」，能做的是**降低诱因**（错误信息本身不再可被误读）+ **显式纪律**（工具描述层）。因此 T-5 **不承诺 100% 消除误述**，验收为「抽样观察，同一误述不再复现」。

#### 4.5.2 工具描述补纪律（对齐同类产品做法）

`electron/shell/terminalToolContract.ts:36-52` 的 `description` 数组追加一行（与既有中文描述同语言）：

```ts
'执行环境是非交互的：标准输入已关闭、分页器已禁用（PAGER/GIT_PAGER=cat）；不要调用全屏或需要键盘输入的程序。' +
'若工具返回 SHELL_INTERACTIVE_TTY_REQUIRED、SHELL_TUI_UNDETECTABLE 或 SHELL_EXECUTABLE_UNAVAILABLE，那是能力/环境限制，不是安全策略拒绝：' +
'不要改用其他工具或换写法重复尝试同一程序，也不要绕过工具通道去聊天里征求许可；应改写为非交互命令，或把命令与用途告知用户由其在系统终端执行。'
```

纪律三条与需求清单 §A-5 对照段 ⑤（DeepSeek Harness 工具描述）同源：① 说明标记性质；② 不得换途径重试；③ 不得绕过工具通道征求许可。

#### 4.5.3 审批拒绝话术的边界说明（D-4）

`electron/toolChatLoop.ts:691` 的「可用的获批途径：让用户在交互式会话中对确认卡片手动批准…」**保留**（真实获批途径），但建议在同段补一句：

```ts
'该结论来自安全审批通道，与命令本身是否可执行无关；若工具返回的是能力/环境类错误码（如 SHELL_INTERACTIVE_TTY_REQUIRED），请勿将其理解为审批结论。'
```

理由：本会话的误述正是把审批话术嫁接到能力错误码上（需求清单 §A-3 原因 2）。补一句显式边界的成本极低。

#### 4.5.4 验收方式（人工 + 可复核脚本）

- 用本会话第 3 轮的 6 条命令构造复现任务，观察 Agent 的最终答复是否仍出现「安全策略拦下 git commit」这类表述；
- 记录：失败次数、是否产生「换工具重试」、是否把能力错误码当策略拒绝。**结果留痕作为 A-3 的结项材料**（需求清单 V-5 提示该轮 thinking 无法提取，故以行为观察为准）。

---

### 4.6 T-6：中止态贯通（C-1 / D-3）

#### 4.6.1 现状的三种表述（N-7）

| 出口 | 用户中止的表达 | 位置 |
| --- | --- | --- |
| 事件流 | `turn_end {reason:'error', error:'用户已中止'}` / `source-cancelled` | `turnCoordinator` 消费 `source-cancelled` |
| 消息层 | `status:'failed'`（与真实故障、退出残留、启动清理同形） | `assistantFactAggregator.ts:171-174`、`turnCoordinator.ts:389/406-407/460` |
| 渲染 chat 状态 | `completed`（视为正常结束） | `turnProjectionService.ts:15-19` |
| 用量统计 | `cancelled`（唯一精确表达） | `toolChatLoop.ts:824-846` |

即：**同一事实在四个出口出现三种语义**。T-6 的目标是让「消息层」成为可区分的权威表达，并对齐其余出口的职责表述。

#### 4.6.2 状态模型

`src/shared/domainTypes.ts:11`：

```ts
export type MessageStatus = 'sending' | 'sent' | 'queued' | 'streaming' | 'completed' | 'failed' | 'cancelled'
```

新增 `src/shared/messageStatus.ts`：

```ts
// src/shared/messageStatus.ts
import type { MessageStatus } from './domainTypes'
// 评审 v15：**不重复声明** outcome 联合，直接复用既有单一来源（§4.4.2 的原则同样适用于本方案自己新增的类型）
import type { TurnOutcome } from './assistantFactAggregator'

/** 消息是否已到终态（不再接受事件写入）。新增终态值只改这里。 */
export function isTerminalMessageStatus(status: MessageStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

/** turn 终态 → 消息状态。timed-out 保持 failed（本轮不区分），cancelled 独立表达。 */
export function messageStatusForTurnOutcome(outcome: TurnOutcome): MessageStatus {
  if (outcome === 'completed') return 'completed'
  if (outcome === 'cancelled') return 'cancelled'
  return 'failed'
}

/** 消息终态 → turn outcome 的反向映射（`execute()` 收敛既有终态时用，见 §4.6.3）。 */
export function outcomeForMessageStatus(status: MessageStatus): 'completed' | 'failed' | 'cancelled' {
  if (status === 'completed') return 'completed'
  if (status === 'cancelled') return 'cancelled'
  return 'failed'
}
```

> **入参类型为何用 `TurnOutcome` 而不是内联联合（评审 v15）**：`TurnOutcome` 已由 `assistantFactAggregator.ts:4` 定义为 `'completed' | 'failed' | 'cancelled' | 'timed-out' | 'recovered'`，与本函数所需取值域**完全一致**。若在此内联重写一遍，日后 `TurnOutcome` 扩展时本文件不会报错，但调用点（`convergeTurnToTerminal` 等传入 `TurnOutcome`）会编译失败在**错误的位置**；直接引用则失败点就在本函数，语义更清楚。这也是 §4.4.2「跨层字面量域必须单一来源」对本方案自身代码的适用。
>
> **与 `UsageTurnOutcome` 的区别（不受本函数覆盖）**：`electron/usageStats/usageStatsRecorder.ts:42` 的用量侧类型多一个 `'interrupted'`，它**不属于** `TurnOutcome`、也不进入消息状态模型（§4.6.2 已取定消息状态不含该值）。本函数**不**接受 `UsageTurnOutcome`；若将来需要把用量 outcome 也映射到消息状态，必须显式处理 `'interrupted'` 并在此说明其归类，不得直接强转。

> 决策说明（对应 D-3 的两种候选）：选择**新增枚举值**而非并列的 `interrupted` 字段。理由：① `interrupted` 字段会使「是否是终态」出现两个真源（`status` 与 `interrupted`），与 T-4 的单一事实来源原则相悖；② 现有穷尽检查点集中在少量函数（见 §4.6.5），改用集中帮助函数后总成本可控；③ 未来 `timed-out` 若要区分，只需扩 `MessageStatus` 与 `messageStatusForTurnOutcome`，不引入第二个维度。
> `timed-out` 本轮保持 `failed`（需求清单只主张区分用户中止；超时已有 `terminationReason`/`usage outcome` 精确表达，避免一次性扩大改动面）。此点列为评审项。

#### 4.6.3 聚合器与协调器

`src/shared/assistantFactAggregator.ts`：

```ts
// 第 81 行：终态判定改集中帮助函数
const terminal = (status: Message['status']) => isTerminalMessageStatus(status)

// 第 171-174 行：按终态事件类型分流
} else {
  closeSegments(next, deps.now)
  next.status =
    event.type === 'source-completed' ? 'completed'
    : event.type === 'source-cancelled' ? 'cancelled'
    : 'failed'
}
```

> `source-timeout` 仍落 `failed`（同 4.6.2 说明）。

`src/shared/turnCoordinator.ts`：

| 位置 | 现状 | 改动 |
| --- | --- | --- |
| `execute()` 第 204-215 行 `alreadyTerminal`、`status` 与 `acceptedOutcome` | ①`alreadyTerminal` 只认 `completed`/`failed`；②`status = terminal.outcome === 'completed' ? 'completed' : 'failed'`；③`acceptedOutcome = acceptedTerminal?.outcome ?? (alreadyTerminal && latest.assistantMessage.status === 'completed' ? 'completed' : terminal.outcome)` | ①改用 `isTerminalMessageStatus`；②`status` 用 `messageStatusForTurnOutcome(terminal.outcome)`；③收敛分支改用 `outcomeForMessageStatus(latest.assistantMessage.status)`（否则既有 `cancelled` 终态会被回退成 source 报告的 outcome） |
| `cancel()` / `timeout()` 守卫（第 336、346 行） | 显式比对 `completed`/`failed` | 改用 `isTerminalMessageStatus` |
| `consume()` 第 246 行守卫 | 同上 | 同上 |
| `finalizeFinishing()` 第 369-378 行 | 走 `consume(source-cancelled)` 后 `makeTerminal` 把消息改写成 `failed` | `makeTerminal` 改为 `message: { ...turn.assistantMessage, status: messageStatusForTurnOutcome(outcome) }` |
| **`execute()` 的 `.catch` 分支（第 219-232 行）——评审 v12 B2** | **无条件**写 `const message = { ...latest.assistantMessage, status: 'failed' as const }`（226 行），并 `updateTurnState(..., { outcome: 'failed' })`（231 行）；**未受任何终态保护** | **加终态保护**：进入 catch 时若 `isTerminalMessageStatus(latest.assistantMessage.status)` 为真（含已收敛的 `cancelled`），则**保留该终态**——不改消息、不写 `turns.outcome`，仅把 `error` 补进 `this.terminals` 的既有项，然后抛出；否则维持既有 `failed` 语义 |
| **`finishCheckpoint()` 第 312-332 行（评审项 2）** | checkpoint 写入失败时，只有 `status==='completed' \|\| status==='failed'` 才走「最多 3 次受控重试 + 置 `checkpointFailed`」分支；其余状态落非终态分支 | 改用 `isTerminalMessageStatus(current.assistantMessage.status)`。**不改的后果**：中止消息的终态 checkpoint 失败会被当作「非终态」处理，绕过重试上限与失败标记（内存态显示「已停止」、重启后 DB 仍是旧值，与 G6 的持久可识别目标冲突） |
| `recover()` 第 380-411 行 | ①`listUnfinishedTurns` 路径一律置 `failed`；②残留路径（`listStreaming`）对无内存归属的消息一律 `updateIfStreaming(..., failed)`；③**第 397 行 `if (unfinished.length > 0) return recovered` 使两阶段互斥** | **改为按 turn outcome 修正（v0.4 新增补偿路径；v0.5 修正提前返回，评审 v4-B2）**：① 进行中 turn 无 outcome → 保持 `failed`（语义不变）；② 残留路径消费 `listRecoverableResidues()`（带 `turnOutcome`），**有 outcome 时用 `messageStatusForTurnOutcome(outcome)`**；③ **删除提前返回**，两阶段始终都跑（`recovered` 不再重置为 0），并新增三档回退（新方法 → `listStreaming()` → 空数组） |
| `listActive()` 第 455-457 行 | 显式比对两值（`!== 'completed' && !== 'failed'`） | 改用 `!isTerminalMessageStatus(...)`。**这是 §4.6.3 关键点 4(d) 的必要条件**：不改则该行的排除项不含 `cancelled`，补偿后的内存 turn 仍被列为活动 |
| `restoreTurn` 持久化 `outcome` | 保持 | 无变化（历史 turn 的 outcome 仍可读） |

关键点：

1. **不存在把 `cancelled` 覆盖为 `failed` 的代码路径**——这是 C-1 能否成立的判定条件，须由测试锚定。
   **评审 v12 B2 修正**：v0.11 前稿只声明了这一不变量、**漏掉了 `execute()` 的 `.catch` 分支**（第 219-232 行）。该分支在 `pendingFinish` 为空时**无条件**把消息写回 `failed`（226 行）并覆盖 `turns.outcome='failed'`（231 行）——一次同时破坏消息状态与 G6-b 的唯一事实来源。触发条件真实：`cancel()` 后 source 若在 finishing 窗口（`finishingWindowMs`，默认 5 s）**之外**才 reject，`this.finishing` 中已无该 turn，于是走该分支。
   因此：① 上表新增该行并要求**终态保护**；② 「终态写入点」由 **7 处改为 8 处**（`execute` 正常路径 / `execute` 的 catch 分支 / `consume` / `cancel` / `timeout` / `finalizeFinishing` / `finishCheckpoint` / `listActive`）；③ 由 **T6-2（不覆盖不变量）与新增 T6-20（catch 分支）** 锚定（§7.4）。
2. **终态判定共有 7 处**（`execute` / `consume` / `cancel` / `timeout` / `finalizeFinishing` / `finishCheckpoint` / `listActive`），本次全部收口到 `isTerminalMessageStatus`，今后新增终态值只需改 `messageStatus.ts` 一处。`finishCheckpoint` 是评审补出的一处，性质与其余各点不同：它不是「要不要写成 cancelled」的问题，而是**重试与失败标记的路径分叉**——遗漏它会造成「界面已停止、DB 未落终态」这一类最难排查的不一致，因此与状态映射同批实现、同批测试。
3. **两处 DB 写入是不同路径（评审 B4 的关键事实）**：
   - `finalizeFinishing` 写 **`turns`**：`storage.updateTurnState(turnId, 'terminal', { outcome })`；
   - checkpoint 写 **`messages`**：`storage.checkpoint(turnId, version, message)`。
   因此「checkpoint 三次重试全失败」**不等于**「outcome 丢失」：只要 `updateTurnState` 成功，`turns.outcome = 'cancelled'` 就是可用的事实来源。
4. **补偿路径（v0.4 新增；v0.5 修正提前返回，评审 v4-B2）**：新增 storage 查询

   ```ts
   // TurnStorage 可选方法（与 listStreaming 并列）
   // 评审 v15：新增 MessageStatus 用法 → turnCoordinator.ts 的 domainTypes import 需同步
   //   现为 `import type { Message } from './domainTypes'`，须改为 `{ Message, MessageStatus }`
   listRecoverableResidues?: () => Array<{ message: Message; turnOutcome?: string }>
   ```

   实现（`electron/turnCoordinatorStorage.ts`）：`listStreamingAssistantMessages(db)` 的结果 **LEFT JOIN `turns` ON turns.assistant_message_id = messages.id**，带出 `turns.outcome`。

   **两个必须修正的点（评审 v4-B2）**：

   - **(a) 移除提前返回**：现有 `recover()` 在处理完 `listUnfinishedTurns()` 后有 `if (unfinished.length > 0) return recovered`（`turnCoordinator.ts:397`）。它会让「库中同时存在未完成 turn 与已记 `cancelled` 的 streaming 残留」时**跳过残留阶段**，补偿永远不执行。改为**两阶段始终都跑，计数累加**：

     ```ts
     recover(): number {
       let recovered = 0
       for (const turn of this.storage.listUnfinishedTurns()) { /* …既有逻辑，recovered++… */ }
       // 不再 `if (unfinished.length > 0) return recovered`；继续处理残留（评审 v4-B2）
       for (const { message, turnOutcome } of this.listResidues()) { /* …见下… */ }
       return recovered
     }
     ```

     注意 `recovered` **不再重置为 0**（原代码在第 400 行重置，属「两阶段互斥」的产物），返回值语义变为「本次恢复的消息总数」，与调用方期望一致。

   - **(b) 三档回退**：`listRecoverableResidues?.() ?? []` 在方法缺失时**得到空数组、根本没有回退**（v0.4 稿的错误）。改为：

     ```ts
     private listResidues(): Array<{ message: Message; turnOutcome?: string }> {
       if (this.storage.listRecoverableResidues) return this.storage.listRecoverableResidues()
       // 旧存储夹具/未升级注入：回退既有 listStreaming，行为与原实现一致
       return (this.storage.listStreaming?.() ?? []).map((message) => ({ message }))
     }
     ```

   - **(c) 三分支分派：不得让「有内存归属」绕开按 outcome 的状态（评审 v6）**

     v0.5 稿在有内存归属时直接调用 `this.storage.recoverTurn(owned.turnId, message.id)`。现有实现 `recoverPersistedTurn()`（`electron/database/operations.ts:726-745`）有三处与目标直接冲突：

     | 现有行为 | 位置 | 与本方案的冲突 |
     | --- | --- | --- |
     | 固定写 `updateMessageContent(..., { status: 'failed' })` | 第 738 行 | 会把 `cancelled` 残留补写成 `failed`（G6-b 失败） |
     | 固定写 `outcome = 'recovered'` | 第 740 行 | **抹掉** `turns.outcome='cancelled'` 这一唯一事实来源 |
     | turn 查询限定未终止 state | 第 729 行 | turn 已 `terminal` 时返回 `false`，消息**永久停留 `streaming`** |

     因此**修正方式为在 coordinator 侧分派**：`recoverPersistedTurn` 的**签名、SQL 与内联降级一律保持原样、本轮完全不重构**（既有调用与既有测试零回归），新路径所需的降级另按 recover 语义独立实现（见 (e) 与评审 v8 B1 的修正说明）。

     ```ts
     for (const { message, turnOutcome } of this.listResidues()) {
       if (message.role !== 'assistant' || message.status !== 'streaming') continue
       if (this.recovered.has(message.id)) continue   // 与未完成 turn 阶段共用去重集合，避免重复修复
       const owned = [...this.turns.values()].find((t) => t.assistantMessage.id === message.id)
       let fixed = false
       if (turnOutcome) {
         const outcome = turnOutcome as TurnOutcome
         // ① 已有明确 outcome（含 cancelled）：
         //    - 只修正消息，绝不调用 recoverTurn（否则覆盖 turns.outcome 并把消息写成 failed，评审 v6）
         //    - 同时清理活动工具调用，且**不触碰 turns 行**（评审 v7 B2）
         const status = messageStatusForTurnOutcome(outcome)
         const updated = this.storage.finalizeResidueMessage?.(message.id, status)
           ?? this.storage.updateIfStreaming(message.id, { ...message, status })
         if (updated) {
           if (owned?.turnId) this.convergeTurnToTerminal(owned.turnId, outcome)   // ③ 内存同步（评审 v7 B1）
           fixed = true
         }
       } else if (owned?.turnId && this.storage.recoverTurn(owned.turnId, message.id)) {
         // ② 无 outcome（真实故障 / 应用退出残留）：沿用既有语义
         //    （终结 turn + 消息 failed + outcome='recovered'），本方案不改该函数
         if (owned) this.convergeTurnToTerminal(owned.turnId, 'recovered')
         fixed = true
       } else {
         // ③ 兜底：turn 已 terminal 但 outcome 为 NULL（第 740 行的 COALESCE 允许此组合），
         //    recoverTurn 会因 state 白名单返回 false；仍须把消息从 streaming 收敛，
         //    否则该消息会永久显示为「进行中」
         fixed = this.storage.updateIfStreaming(message.id, { ...message, status: 'failed' }) != null
       }
       if (fixed) { this.recovered.add(message.id); recovered++ }
     }
     ```

     - **分支 ① 是 G6-b 的唯一正确路径**：`cancelled` 事实来自 `turns.outcome`，消息只是补写，**完全不触碰 turn 行**（不覆盖 outcome、不写 `recovered`）。
     - **分支 ②** 保持 `recoverPersistedTurn` 的既有语义（含 `outcome='recovered'`），既有单测（`turnCoordinator.test.ts:617` 等）不受影响。
     - **分支 ③** 覆盖「turn 已 `terminal` 且 outcome 为 NULL」的边角组合，避免消息永久 `streaming`（这是评审 v6 未列出、但按第 729 行的 state 白名单必然存在的路径）。
     - 判定改为 `updateIfStreaming(...) != null` 而非仅看 `recoverTurn` 的布尔值，使「消息是否真的被修正」可判定。
     - **备选方案（不采用）**：给 `recoverPersistedTurn` 增加 `targetStatus` 参数并保留既有 outcome。本文不采用——它需要改 SQL、改存储层契约并同步既有测试；三分支分派 + 端口方法即可闭合同一目标（对应评审 v6「先更新消息再以不覆盖消息状态的方式结束 turn」与 v7「抽出可复用的纯清理操作」两条建议）。

   - **(d) 分支① 必须同步协调器内存状态（评审 v7 B1）**

     只调 `updateIfStreaming` 只改持久化消息：`this.turns` 中该 `TurnStarted` 的消息仍是 `streaming`，而 `listActive()` 的过滤条件是 `assistantMessage.status !== 'completed' && !== 'failed'`（`turnCoordinator.ts:456-457`）——**`cancelled` 不满足该条件的排除项**，于是 turn 仍被当作活动，`cancel()`/`execute()` 的守卫（当前同样只认两个值）也仍会放行。启动流程「先 restore 活动 turn、再 recover」时该窗口真实存在。

     抽出私有辅助，**第一阶段（未完成 turn）与分支① 共用**（消除两处重复的终态收敛写法）：

     ```ts
     /** 把内存 turn 收敛为终态：更新消息状态与 persistedOutcome，并写入 terminals 索引。 */
     private convergeTurnToTerminal(turnId: string, outcome: TurnOutcome): void {
       const inMemory = this.turns.get(turnId)
       if (!inMemory) return
       const message: Message = { ...inMemory.assistantMessage, status: messageStatusForTurnOutcome(outcome) }
       this.turns.set(turnId, { ...inMemory, assistantMessage: message, persistedOutcome: outcome })
       this.terminals.set(turnId, {
         turnId, requestId: inMemory.requestId, sessionId: inMemory.sessionId,
         assistantMessageId: message.id, version: inMemory.version, outcome, message
       })
     }
     ```

     **同批前置条件（B1 的真正闭合点）**：`listActive()`（第 456-457 行）与 `cancel()`/`timeout()`/`consume()`/`finishCheckpoint()` 的终态守卫**必须同时**改用 `isTerminalMessageStatus`（§4.6.3 表格已列，此处强调其为 B1 的必要条件——只做内存同步而不改守卫，`cancelled` 仍会被判为活动，缺陷只是换了个表现）。改后：
     - `listActive()` 不含该 turn；
     - 重复 `cancel(turnId)` 返回 `false`（已终态，`turnRuntime.test.ts:171` 的既有断言模式保持）；
     - 在途 `execute()` 的 source 完成时走 `alreadyTerminal` 分支（改用 `isTerminalMessageStatus`），**保留**已收敛的 `cancelled` 而不被覆盖（§4.6.3 关键点 1）。

   - **(e) 分支① 必须清理活动工具调用，且不改写 outcome（评审 v7 B2；v0.9 修正共用判断，评审 v8 B1）**

     `recoverPersistedTurn` 除更新消息外，还把 `toolCalls` 中 `calling`/`confirming`/`executing` 的条目降级为「中断失败」（`operations.ts:734-738`）。分支① 若只调 `updateIfStreaming`，会留下「消息已 `cancelled`、工具调用仍 `executing`/`confirming`」的持久化状态——误导 UI 与后续恢复扫描。

     **v0.8 稿的错误（评审 v8 B1）**：稿中把 `electron/database/streamingCleanup.ts` 的 `downgradeToolCall` 与 `recoverPersistedTurn` 的内联降级当作「同一个函数」并提取共用。核对后两者**语义不等价，共四处差异**：

     | 场景 | `streamingCleanup.downgradeToolCall`（启动清理） | `recoverPersistedTurn` 内联（启动恢复） |
     | --- | --- | --- |
     | 已终态（`completed`/`failed`/`rejected`）**且有 result** | 原样保留 | 原样保留 |
     | 已终态**且无 result** | **降级为 `failed` + `interrupted`** | **原样保留** |
     | 进行中（`calling`/`confirming`/`executing`）**且有 result** | **保留原 result**（`tc.result ?? 中断文案`） | **覆盖为中断文案** |
     | `completedAt` | `tc.completedAt ?? now` | **无条件 `Date.now()`** |

     若直接把 `downgradeToolCall` 提为共用并让 `recoverPersistedTurn` 调用，会改变后者的既有行为（属本任务范围外的行为变更）。因此**修正为「只共享常量与判定，不共享策略函数」**：

     1. `electron/database/toolCallInterruption.ts`（新增，纯函数、零 DB 依赖）只导出两样：

        ```ts
        /** 中断文案：两份实现的来源常量（取 streamingCleanup 的现有字面量）。 */
        export const INTERRUPTED_TOOL_CALL_ERROR = '工具调用因应用退出中断'
        /** 进行中状态判定：两处实现的「哪些算 in-progress」完全一致，可安全共享。 */
        export const INTERRUPTED_TOOL_CALL_STATUSES = ['calling', 'confirming', 'executing'] as const
        export function isInterruptedToolCallStatus(status: ToolCallStatus): boolean {
          return (INTERRUPTED_TOOL_CALL_STATUSES as readonly string[]).includes(status)
        }
        ```

        `streamingCleanup.ts` 与 `operations.ts` 均改为引用该常量/判定（**纯替换字面量，行为不变**）。

     2. **不提取**带策略的降级函数。`operations.ts` 内新增一个**按 recover 语义**实现的独立纯函数（导出以便测试对照）。**注意 import（评审 v15）**：`operations.ts` 现从 domainTypes 只引入 `Message, MessageStatus, Session`，本函数还需 `ToolCallRecord`：

        ```ts
        // electron/database/operations.ts —— 文件头 import 需补 ToolCallRecord
        import type { Message, MessageStatus, Session, ToolCallRecord } from '../../src/shared/domainTypes'
        ```

        ```ts
        /** 按 recoverPersistedTurn 的既有语义降级活动工具调用（≠ streamingCleanup 的启动清理语义）。 */
        export function degradeInterruptedToolCallsWithRecoverSemantics(
          toolCalls: ToolCallRecord[] | undefined,
          now: number
        ): ToolCallRecord[] | undefined {
          if (!toolCalls) return undefined
          return toolCalls.map((tool) => {
            // 已终态：原样保留（**不**像启动清理那样对「无 result」再降级）
            if (tool.status === 'completed' || tool.status === 'failed' || tool.status === 'rejected') return tool
            // 进行中：状态与 result 一律按中断收敛（**不**保留原 result）
            return {
              ...tool,
              status: 'failed' as const,
              interrupted: true,
              completedAt: now,                        // 无条件 now（≠ 启动清理的 `?? now`）
              result: { success: false, error: INTERRUPTED_TOOL_CALL_ERROR }
            }
          })
        }
        ```

     3. `operations.ts` 新增（沿用 v0.8 的端口实现，唯一改动是把降级替换为上函数）：

        ```ts
        /** 与 recoverPersistedTurn 相同的工具调用降级语义；状态由调用方指定，且不触碰 turns 行。 */
        export function finalizeResidueMessageKeepingOutcome(db: AppDatabase, messageId: string, status: MessageStatus): Message | null {
          const assistant = getMessage(db, messageId)
          if (!assistant) return null
          const degraded = degradeInterruptedToolCallsWithRecoverSemantics(assistant.toolCalls, Date.now())
          return updateMessageContentIfStreaming(db, messageId, {
            ...assistant, status, ...(degraded ? { toolCalls: degraded } : {})
          })?.message ?? null
        }
        ```

     4. **`recoverPersistedTurn` 本轮完全不重构（v0.9 修正）**：v0.8 稿要求把它第 734-738 行改为调用共用函数——撤销。它保持内联原样，因此**不存在改变既有恢复行为的途径**。`finalizeResidueMessageKeepingOutcome` 与它的一致性由 **T6-19** 的对称断言保证（而非靠共用同一函数保证）。

     5. `electron/turnCoordinatorStorage.ts` 绑定：`finalizeResidueMessage: (messageId, status) => finalizeResidueMessageKeepingOutcome(db, messageId, status)`。**该文件需在既有 `./database` 具名 import 列表中加入 `finalizeResidueMessageKeepingOutcome`**（评审 v15：该文件现以逐个具名方式从 `./database` 导入，新增函数必须一并加入，否则片段无法编译）。
        **并且 `electron/database/index.ts` 是逐个具名 re-export 的桶文件**（评审 v12 M1）：若新函数只在 `operations.ts` 里 `export`、未加入 `index.ts` 的 re-export 清单，则上面的 `from './database'` 会解析失败。因此**新函数必须在 `index.ts` 中与 `recoverPersistedTurn` 并列 re-export**（`export { finalizeResidueMessageKeepingOutcome, degradeInterruptedToolCallsWithRecoverSemantics } from './operations'` 或该文件既有的等价写法）。

     6. **回退**：端口方法缺失时分支① 退回 `updateIfStreaming`（旧夹具/未升级注入仍可编译与运行；此时不含工具调用清理，属**已声明降级**，由 T6-14 的同型回退测试覆盖）。

     **备选方案（不采用）**：保持单一共享函数、由调用方传参选择语义。它会要求改动 `recoverPersistedTurn`（或把它降级为包装），从而改变本任务范围外的既有恢复行为；两处语义的差异（尤其「已终态且无 result」）属既有设计取舍，不宜在本次顺手统一。

     三点约束：① 分支① **仍不调用 `recoverTurn`**（outcome 不被覆盖）；② 两处降级**语义各自独立**、共用常量与判定，一致性由测试对照保证；③ 分支②（无 outcome）行为**逐字节不变**。

   **去重语义**：`recovered: Set<string>` 存的是 `assistantMessageId`，两阶段共用——未完成 turn 阶段已 add 的 id 在残留阶段会被 `has` 跳过（同一消息不会被修两次）。这正是「两阶段都跑」能安全的依据。
5. `recover()` 语义的保留与收窄：主体语义（宿主无法确认结束原因 → `failed`）不变；**唯一新增**是「已确认原因为用户中止」的残留按 `cancelled` 修正。这不会把真实故障误标为中止（故障路径的 `turns.outcome` 是 `failed` 或无 outcome）。

#### 4.6.4 读取接口与渲染层

**读取接口**（`electron/capabilities/handlers/session.ts` 的 `readCapability`）——**两条 return 路径的完整片段**（截断分支常被漏写，故在此给出权威形态）：

```ts
return page.rows.map(({ message: m, sequence }) => {
  if (m.content.length > MESSAGE_MAX_CHARS) {
    return {
      sequence,
      role: m.role,
      timestamp: m.timestamp,
      content: `${m.content.slice(0, MESSAGE_MAX_CHARS)}…`,
      truncated: true,
      originalChars: m.content.length,
      status: m.status                      // ← 截断分支也必须带（门禁 5）
    }
  }
  return {
    sequence,
    role: m.role,
    timestamp: m.timestamp,
    content: m.content,
    status: m.status                        // ← 正常分支
  }
})
```

> v0.12 前稿此处只给了一行 `return { sequence, role, timestamp, content, status }`，与紧邻的「**两个分支都必须返回 `status`**」要求不一致——按那行片段实施会漏掉截断分支。现按实际控制流给出两条路径。

- **两个分支都必须返回 `status`**（评审门禁 5）：现实现有「超长截断」与「正常」两条 return 路径，缺任一条则长消息（>4000 字符）会丢失中止态，G6 在真实会话里会漏。
- `returnsDoc` 更新为 `{ messages: [{ sequence, role, timestamp, content, status, truncated?, originalChars? }], nextSequence, hasMore }`；
- `status` 让「中止」可被模型/用户侧识别（G6）；`notes` 补一句「status ∈ sending/sent/queued/streaming/completed/failed/cancelled」；
- 内部/hidden 会话的既有拒绝逻辑不变。

**渲染层**：

| 位置 | 改动 |
| --- | --- |
| `ChatBubble.tsx:244-247` | 新增 `const cancelled = message.status === 'cancelled'`；`cancelled` 时不展示 `failureReason`（那是失败原因），改为展示中性提示 |
| `ChatMessageList` / `canRetry` | 取定：`canRetry` 仍为 `status === 'failed'`（中止不提供「重试回复」）。**评审项**：若产品要求「中止后一键重新生成」，再扩为 `failed \|\| cancelled` 并改文案 |
| 状态标签（`message.failed` 同组） | 新增 i18n `message.cancelled`（zh：`已停止`；en：`Stopped`），与 `message.failed`/`message.queued` 并列展示 |
| 气泡文案 | 新增 i18n `bubble.stopped`（zh：`你已停止本轮生成。`；en：`You stopped this response.`），替代 `bubble.retryFailedMessage` 的失败语义 |
| `turnProjectionService.applyTerminalStatus` | **语义澄清**：`source-cancelled` 仍归入 `completed`（chat 状态只表达「是否仍有进行中的请求」），但补注释说明「消息终态由 `assistantMessage.status` 表达，两者职责不同」。**不改行为**，避免牵动 runningSessions 清理逻辑 |
| i18n 同步 | 按 `docs/develop/i18n-sync-guide.md` 同步 zh-CN / en-US（`types.ts` 的 key 联合类型需同步） |

**历史回填（可选，M4，需批准）**：与 §4.6.3 关键点 4 的**补偿路径同源**——补偿解决「本次中止未被 checkpoint 落库」，回填解决「历史会话中止未落库」。`turns.outcome` 已精确记录 `cancelled`（N-6），因此可用同一条 JOIN 条件做一次性幂等回填：

```sql
UPDATE messages SET status = 'cancelled'
WHERE status = 'failed'
  AND id IN (SELECT assistant_message_id FROM turns WHERE outcome = 'cancelled');
```

- 收益：本会话（以及所有历史会话）中「被中止」的空白助手消息从此可识别，立即改善复盘体验；
- 成本/风险：启动期写库；`turns` 行若已被级联删除则无法回填（不影响正确性，只是漏回填）；
- 建议形式：启动期幂等执行 + 记录回填计数日志（不升 `DB_SCHEMA_VERSION`，因为表结构未变，N-5）。

#### 4.6.5 影响面清单（穷尽检查点）

新增枚举值后必须逐处核对（给出检索命令便于评审复核）：

```bash
# 1) 正向两值比对（必须改为 isTerminalMessageStatus）
rg "status === '(completed|failed)'" src electron
# 2) 反向形态（!== / 否定组合，评审项 2 的 finishCheckpoint 即此形态，易漏）
rg "!== '(completed|failed)'" src electron
# 3) failed 作为「失败」语义展示（新增 cancelled 分支）
rg "status === 'failed'" src/renderer
# 4) 消息状态写入点（确认不误写）
rg "status: '(streaming|failed|completed)'" src/shared electron
# 5) 持久化/反序列化白名单（确认无枚举校验需扩展）
rg "as MessageStatus|MessageStatus\b" src/shared electron
```

已确认需要改动的清单：

| 位置 | 改动 |
| --- | --- |
| `assistantFactAggregator.ts`（81/171-174） | 终态判定与终态分流 |
| `turnCoordinator.ts`（204-215 含 `acceptedOutcome`、246、**312-332 `finishCheckpoint`**、336、346、369-378、380-411 `recover` 补偿、**455-457 `listActive`**、460；另新增私有辅助 `convergeTurnToTerminal`） | 终态判定收口 + 状态映射 + 按 outcome 的残留修正 + **内存终态收敛（§4.6.3 4d）** |
| `electron/turnCoordinatorStorage.ts`（新增 `listRecoverableResidues` 与 `finalizeResidueMessage`） | 残留消息带出 `turns.outcome`（LEFT JOIN）；终结残留消息时清理活动工具调用、**不触碰 `turns` 行** |
| `electron/database/toolCallInterruption.ts`（新增） | 只导出共享常量 `INTERRUPTED_TOOL_CALL_ERROR` 与判定 `isInterruptedToolCallStatus`（**不含策略函数**，两处降级语义不等价，见 §4.6.3 4e） |
| `electron/database/operations.ts` | 新增 `finalizeResidueMessageKeepingOutcome` + `degradeInterruptedToolCallsWithRecoverSemantics`；**`recoverPersistedTurn` 完全不重构**（内联逻辑保留，仅字面量改为引用共享常量） |
| `ChatBubble.tsx`（244-247） | `cancelled` 分支展示 |
| `chatSlice`（`canRetry` 消费方） | 中止不提供「重试回复」 |
| i18n（4 个 key ×2 语言） | 状态标签与气泡文案 |
| `capabilities/handlers/session.ts` | 读取接口透出 `status` |

**测试断言复核（不得只改实现）**：`turnCoordinator.test.ts` 中既有若干把 `failed` 当终态的断言，须逐条区分「中止」与「恢复/失败」两类再改：

| 既有行 | 归属测试（`it(...)` 起始行） | 断言语义 | 处理 |
| --- | --- | --- | --- |
| 296 | `忽略终态后的迟到事件，并使用 expectedVersion checkpoint`（288 起） | `status: 'completed'` | 保持 |
| 477 | `source 直接返回 terminal 时立即 checkpoint 最新终态并取消 late timer`（468 起） | `status: 'completed'` | 保持 |
| 441、451 | `source 抛错时统一 finalize assistant 为 failed…`（435 起）、`…使用最新 reducer snapshot…`（444 起） | `failed` | 保持 |
| **496** | **`cancel 会进入 finishing，窗口到期后才 finalize assistant`（483 起）** | `cancel()` 进入 finishing、窗口到期后 finalize 的终态 checkpoint，**当前断言 `failed`** | **改为 `cancelled`**（这正是 T-6 要改的那一类） |
| 525 | `timeout 会中止活动 source 并只 finalize 一次`（516 起） | `timed-out` 本轮保持 `failed`（§4.6.2 取定） | 保持 |
| 601-606 | `recover 会关闭孤儿 streaming turn，并重复执行保持幂等`（598 起） | `failed` | 保持 |
| 617 | `recover 同步收敛 coordinator 内存 turn…`（609 起） | `failed` + `outcome: 'recovered'`（无 outcome 分支） | 保持 |

> **评审 v12 B1 更正（此表此前改反了方向）**：v0.12 曾把 496 行写成「source 直接返回 terminal → `completed`」，那是把 **477 行**（`468` 起的测试）的内容错记到了 496 行上。按实际代码：477 = source 直接返回 terminal → `completed`（保持），**496 = cancel 测试 → `failed`（必须改为 `cancelled`）**。按原表实施会**漏改**——测试要么变红，要么为保绿而保留旧语义（G6-a 不成立）。
| 601-606 | streaming 残留修复 → `failed` | 保持 |
| 617 | `recover()`（进行中 turn，无 outcome）→ `failed` + `outcome='recovered'` | 保持 |

**不改变对外语义**：`database/operations.ts` 的 `messages.status` 仍是自由字符串（无 CHECK，N-5）；**`recoverPersistedTurn` 的签名、SQL、内联降级与写入值一律不变**（本轮不重构，仅在共享常量处改为引用；见 §4.6.3 关键点 4(c)/4(e)），本方案在协调器侧闭合，**不给该函数加 `targetStatus` 参数**。

**不改动**：`usageStatsRecorder`（已区分 outcome）、`toolChatLoop.ts` 的用量口径、`electron/database/streamingCleanup.ts` 的**对外行为**（v0.9 后仅把 `INTERRUPTED_TOOL_CALL_ERROR`/进行中状态判定改为引用共享常量，`downgradeToolCall` 仍是本地函数、**不并入** recover 语义；另按 T6-19 改为 `export` 以便测试对照，导出不改变行为）。

#### 4.6.6 与 A 系列的关系

T-6 与 T-1~T-5 无代码耦合，可独立交付（§3.2）。但两者共享同一设计原则：**事实按语义分层表达**——`outcome` 是精确事实，消息状态是可区分的粗粒度表达，UI 文案是面向用户的表达，三者不得互相替代。

---

## 5. 影响面矩阵

| 文件 | 任务 | 改动性质 | 风险 |
| --- | --- | --- | --- |
| `electron/shell/preparedShellExecution.ts` | T-1 | 类型 + 校验项 + digest（`spawnStdio`、`shellOutputMode`） | **中**：plan 冻结契约变更；两字段必须在**同一节**（§4.1.2）一致定义于 `PreparedShellExecution`/`PreparedShellInput`/`validatePreparedShellExecution` 的 `current`，并同步 plan 构造与 revalidate 回填（N-8 / 评审项 1 / 评审 v9 B1） |
| `src/shared/shellOutputMode.ts` | T-1 | 新增 `isTerminalShellOutputMode`（plan 与执行层同源判定） | 低 |
| `electron/shell/shellEnvOverrides.ts`（新增） | T-1 | 新增模块，含 `applyNonInteractiveShellEnv` 与 `buildPlannedShellEnvironment`（**唯一环境构造入口**） | 低；两函数同文件，禁止分散到 `shellSpawnEnv.ts`（§4.1 开头） |
| `electron/tools/runShellPlan.ts` | T-1/T-2/T-3 | stdio/env/判据（含 `SHELL_TUI_UNDETECTABLE`）/错误详情 | **中**：唯一计划入口，回归面广 |
| `electron/shell/shellCaseIds.ts` | T-2/T-4 | `SHELL_CASE_IDS` 新增 `tuiUndetectable`（`SHELL-CAPABILITY-003`）；常量值改为 import 自 `src/shared/shellCaseIds.ts` | 低 |
| `electron/tools/runShellExecutor.ts` | T-1/T-3 | spawn 参数 + 返回体；**含 `SpawnStdio` → Node `StdioOptions` 的唯一边界适配（`stdio: [...prepared.spawnStdio]`，§4.1.2（5））** | **中**：spawn 是热路径；边界适配只允许此一处 |
| `electron/shell/shellTuiDetection.ts`（新增） | T-2 | 新判据（递归穿透 + 二次解释边界）；**契约类型/枚举从 shared 引用** | 低（新增，旧调用点显式替换）；**注意深度上限常量集中定义**，便于测试与后续评审 |
| `src/shared/shellTuiContract.ts`（新增） | T-2 | 跨层契约：规则枚举、不可检测原因枚举、`ShellTuiMatch`（纯常量与类型，零依赖） | 低；**必须保持零 electron 导入**（§4.3.5 边界约束） |
| `electron/shell/shellCommandParser.ts` | T-2 | 只读复用 | 无（不改动） |
| `src/shared/shellInteractiveTui.ts` | T-2/T-3/T-4 | 删旧判据、保留模型侧文案；**类型域移交 `shellTuiContract.ts`** | **中**：删除导出，须确认零引用（已 grep 确认 3 处调用点） |
| `src/shared/shellCaseIds.ts`（新增） | T-4 | 常量下移（含 `SHELL-CAPABILITY-001/003` 与两个错误码） | 低 |
| `src/shared/shellToolDisplay.ts` | T-4 | 新增 `resolveShellTuiNotice`（判别 `tui`/`undetectable`）+ `tuiMatch`/`tuiUndetectable` 解析 | 低 |
| `src/shared/processResultProjection.ts` | T-3 | 白名单键 + 受控投影分支 | **中**：投影是安全边界，必须有正反用例 |
| `src/renderer/components/Chat/ShellTuiFallbackHint.tsx` | T-4 | 判据来源变更 | 低 |
| `src/renderer/components/Chat/ToolCallCard.tsx` | T-4 | 判据来源变更 | 低 |
| `electron/shell/terminalToolContract.ts` | T-5 | 描述追加纪律行 | 低（注意 token 成本，约 +120 字） |
| `electron/toolChatLoop.ts` | T-5 | 审批话术补边界说明 | 低 |
| `src/shared/domainTypes.ts` | T-6 | 枚举扩展 | **中**：穷尽检查面（§4.6.5） |
| `src/shared/messageStatus.ts`（新增） | T-6 | 集中判定 | 低 |
| `src/shared/assistantFactAggregator.ts` | T-6 | 终态分流 | **中**：所有工具链路共用 |
| `src/shared/turnCoordinator.ts` | T-6 | 终态映射与守卫（7 处，含 `finishCheckpoint` 重试路径与 `recover` 补偿） | **高**：会话生命周期核心，须全量回归 + 既有断言复核（§4.6.5） |
| `electron/turnCoordinatorStorage.ts` | T-6 | 新增 `listRecoverableResidues`（带 `turns.outcome`）与 `finalizeResidueMessage` | 中：SQL JOIN 变更，须允许缺 turns 行时回退 |
| `electron/database/toolCallInterruption.ts`（新增） | T-6 | 提取共享常量与判定（两处引用） | 低：常量迁移，行为不变 |
| `electron/database/operations.ts` | T-6 | 新增 `finalizeResidueMessageKeepingOutcome` + `degradeInterruptedToolCallsWithRecoverSemantics`；**`recoverPersistedTurn` 完全不重构**（仅把字面量改为引用共享常量） | **中**：既有恢复语义必须逐字节不变（T6-8/T6-12/T6-19 锚定） |
| `electron/capabilities/handlers/session.ts` | T-6 | 读取字段扩展（两条 return 路径都带 `status`） | 低 |
| `electron/database/streamingCleanup.ts` | T-6 | 常量化（引用 `toolCallInterruption.ts`）+ `downgradeToolCall` 改为导出（T6-19 对照用） | 低：**不改行为**，仅导出与常量引用 |
| `src/renderer/components/Chat/ChatBubble.tsx` + i18n（4 key ×2） | T-6 | 展示 | 低 |
| `docs/**`（本文 + 相关 requirement 交叉引用） | 全部 | 文档 | 低 |

---

## 6. 实施阶段与提交切分

每阶段独立可合并、独立可回滚；阶段内遵循「先 RED 测试再实现」（与仓库既有做法一致）。

### 阶段 P0：环境非交互化（T-1）

| 步骤 | 内容 | RED 测试 |
| --- | --- | --- |
| P0-1 | 按 §4.1.2 的**唯一接口定义**同时落地：`PreparedShellExecution`/`PreparedShellInput`（两字段**必填**）、`validatePreparedShellExecution` 的 `current` Pick 与两个比对项、`planRunShellExecution` 的 ctx 收窄与 `prepareShellExecution` 显式写入、revalidate 回填 | `preparedShellExecution` 契约测试：两字段缺失或取值不一致 → `PLAN_STALE` 且 reason 含对应键；**另加编译期锚定**（两字段为必填，遗漏写入即 typecheck 失败） |
| P0-2 | `isTerminalShellOutputMode` 下移 shared；`applyNonInteractiveShellEnv` + `buildPlannedShellEnvironment`；**plan 阶段读 `ctx.shellOutputMode` 一次并写入快照**，执行层与 revalidate 一律读 `prepared.shellOutputMode` | 单测：`plain` 注入 `NO_COLOR/TERM/PAGER/GIT_PAGER`；`terminal` 只注入 pagers 类；T1-5/T1-6/T1-7-i/T1-7-ii/T1-7b（§7.2；T1-7 为 `validatePreparedShellExecution` 单元层——`shellOutputMode` 正常构造、`spawnStdio` 运行时边界构造，T1-7b 为 revalidate 回填不变量） |
| P0-3 | `runShellExecutor` spawn 使用 **`[...prepared.spawnStdio]`**（**`SpawnStdio` 与 Node `StdioOptions` 的唯一边界适配点**，评审 v11 B1；禁止改类型或加断言）；`terminalMode` 判定改为 **`isTerminalShellOutputMode(prepared.shellOutputMode)`**（**禁止读 ctx**，评审 v4-B3） | 集成：`/bin/sh -c 'read'` 与 `cat` 不再阻塞（T1-10）；T1-11 条件用例；T1-8（ctx 与快照不一致时以快照为准）；`npx tsc -p tsconfig.electron.json --noEmit` 通过 |
| P0-4 | 日志补 `stdioPolicy`/`envOverrideKeys`/`shellOutputMode` | 日志断言 |
| P0-5 | `shellConfigRevision` 处补「有意不含 `outputMode`」注释（§4.1.5 第 3 点） | 无需测试，评审可见 |
| 可选 | `run_script` 同修（§4.1.6） | 同型集成用例 |

验收：G5-a（§4.1.8 表 A）；`sleep 400`（`timeout:5`）超时用例不回归；terminal 模式着色不回归；**terminal 计划经确认等待不 `PLAN_STALE`（评审项 1 结项）**。

### 阶段 P1：判据与契约（T-2 / T-3）

| 步骤 | 内容 | RED 测试 |
| --- | --- | --- |
| P1-1 | `src/shared/shellTuiContract.ts`（契约常量/类型）+ `shellTuiDetection` 三态判定（命令位 + 包装链递归 + 二次解释边界 + 不可检测兜底） | `shellTuiDetection.test.ts`（新增：误伤回归 / 解析不完整 / 包装链与二次解释 三类矩阵全量） |
| P1-2 | `runShellPlan` 接线 + `details.tuiMatch` / `details.tuiUndetectable` + 新错误码 | plan 单测：`git add …top-level…` 不再抛错；`less README.md` 抛错且 `details.tuiMatch.program==='less'`；引号不平衡 + 含 `less` → 抛 `SHELL_TUI_UNDETECTABLE`；`env sudo vim f` / `bash -c 'vim f'` → 抛 `SHELL_INTERACTIVE_TTY_REQUIRED` |
| P1-3 | `diagnostic` 逐项映射（仅两类 TUI 错误）+ `reason` 文本（含 `via`）+ `hints(match)` / `hints(undetectable)` | T3-4（五种 code 逐项契约）+ executor 单测：两类 TUI payload 含 `diagnostic.category==='environment'`、可解释 `reason`、对应 `hints`；其余三类**不出现** `diagnostic` |
| P1-4 | `PROCESS_KEYS` + 受控投影分支（telemetry 丢弃）；**`projectTuiMatch`/`projectTuiUndetectable` 白名单从 `src/shared/shellTuiContract.ts`（shared 同层）引用**（评审 v4-B1 + v5） | 投影单测：§4.3.6 以真实投影输出为基准逐字段比对（telemetry 的 `diagnostic` **不含 `category`**）；**T3-5：六个 reason 全量保留**；非法 `rule`/超长 `program`/越界 `segmentIndex`/枚举外 `reason` 被丢弃；`npm run typecheck:shared` 通过（证明 shared 未依赖 electron） |
| P1-5 | 删除 `SHELL_TUI_FALLBACK_TITLE` 与旧判据导出 | `git grep` 零引用断言（构建期 typecheck 兜底） |

验收：G1、G2（含 `SHELL_TUI_UNDETECTABLE` 的判据、契约与投影）。

### 阶段 P2：呈现与纪律（T-4 / T-5）

| 步骤 | 内容 | RED 测试 |
| --- | --- | --- |
| P2-1 | caseId 常量下移 + `resolveShellTuiNotice`（**含显式类型守卫**，评审 v8 B2） | shared 单测：`tui` 命中（`error` 码 / `caseId`）、`undetectable` 命中、两者皆无、`success=true` 四态；**T4-1：枚举外 `reason`/`rule` 被丢弃且类型合法** |
| P2-2 | 渲染层两处改造 | `ToolCallCard.test.tsx` 既有 TUI 用例改判据（第 468-479 行用例改造 + 新增 `executing` 阶段不渲染断言） |
| P2-3 | 历史消息兼容（无 `tuiMatch` 时通用文案 + 保留按钮） | 渲染测试：只有 `error` 码的历史记录仍渲染卡片 |
| P2-4 | 工具描述纪律 + 审批话术边界 | 描述快照测试（`terminalToolContract`） |
| P2-5 | 界面/模型一致性锚点测试 | §4.4.5 |

验收：G3（人工抽样，§4.5.4）、G4；V-1 可用本阶段复现（界面观察）。

### 阶段 P3：中止态（T-6）

| 步骤 | 内容 | RED 测试 |
| --- | --- | --- |
| P3-1 | `MessageStatus` + `messageStatus.ts` | 类型/帮助函数单测 |
| P3-2 | `assistantFactAggregator` 终态分流 | reducer 单测：`source-cancelled`→`cancelled`；`source-timeout`→`failed`；`cancelled` 后迟到事件不写入 |
| P3-3 | `turnCoordinator` 状态映射与 7 处终态判定收口（含 `finishCheckpoint`，评审项 2） | `turnCoordinator.test.ts`：T6-1~T6-5（`cancel()` 后终端消息为 `cancelled`；`recover()` 对进行中 turn 仍为 `failed`；`listActive` 排除 `cancelled`；`cancelled` 不被覆盖） |
| P3-3b | `finishCheckpoint` 重试路径 + 既有断言复核（§4.6.5 表） | T6-6（三次上限、`checkpointFailed`、成功路径 DB 落地；含原 T6-10 的「不承诺 DB / 不计入 G6-a」口径）+ T6-8（failed 路径不回归） |
| P3-3c（评审 B4） | `listRecoverableResidues` + `recover()` 按 outcome 修正残留；**删除提前返回、补三档回退**（评审 v4-B2）；**三分支分派、不改 `recoverPersistedTurn`**（评审 v6）；**内存终态收敛 `convergeTurnToTerminal` + `finalizeResidueMessage` 端口（含工具调用清理）**（评审 v7） | T6-11a/T6-11b（无/有内存归属）、T6-12（无 outcome 仍 `failed`）+ **T6-13（同库共存）** + **T6-14（旧存储回退）** + **T6-15（spy：`recoverTurn` 未被调用）** + **T6-16（分支 ③）** + **T6-17（活动工具调用被清理）** + **T6-18（`listActive` 不含补偿后的 turn、重复 `cancel` 为 false）** |
| P3-4 | 读取接口透出 `status` | `capabilities/handlers/session.test.ts`：含 `status` 字段 |
| P3-5 | 渲染层展示 + i18n | `ChatBubble` 测试：`cancelled` 不显示失败原因、显示「已停止」 |
| P3-6（可选，M4） | 历史回填 | 幂等性测试（重复执行不重复计数） |

验收：G6；V-3 口径不变（不涉及审批并发）。

### 提交建议（4 个提交，可独立回滚）

1. `fix(shell): pipe stdin as non-interactive and freeze non-interactive env`（P0；含输出模式的 plan 冻结）
2. `fix(shell): match TUI detection on command position and report the match`（P1）
3. `fix(chat): derive TUI hint from tool result and tighten model guidance`（P2）
4. `feat(session): distinguish user-cancelled turns in message status`（P3）

---

## 7. 测试与验证计划

### 7.1 判据回归（T-2）

- 新增 `electron/shell/shellTuiDetection.test.ts`：§4.2.4 矩阵**全部条目**落测（其中需求清单 §A-1 的 10 例原样复刻为数据驱动表）；再补：
  - 引号内含 `top`（`git commit -m "less is more"` 放行）、路径含 `vi`（`git add a/vi.md` 放行）、`command less x` 穿透命中、`xargs less` 穿透命中；
  - **解析不完整矩阵（评审 B1）**：50+ 段 + 含 `vim` → `undetectable`；引号不平衡 + 含 `less` → `undetectable`；`tokenizeShellArgv` 返回 `null` + 含 `top` → `undetectable`；解析不完整但**不含** TUI 词素 → `clear`；`analysisCompleteness === 'partial'` + 含 `nano` → `undetectable`。
  - **包装链与二次解释矩阵（评审 B2）**：§4.2.4 表格第二段全部条目落测，含 4 类通过型（`env sudo vim f`、`command env less f`、`sudo -u root bash -lc 'top'`、`bash -c 'vim f'`、`eval 'less README.md'`）、2 类 `undetectable`（`bash -c "$CMD less"`、5 层 `env` 超限）、3 类不误伤对照（`git commit -m "env sudo vim file"`、`script -q /dev/null git commit -m "x"`、`bash -c "echo hello"`）。
- 保留 `src/shared/shellInteractiveTui.test.ts` 的文案测试（改为 `shellTuiHintLines(match)` 与 `shellTuiUndetectableHintLines(...)`）。

### 7.2 计划与执行（T-1/T-3）

| 用例 | 断言 |
| --- | --- |
| T1-3 | `sleep 400`（`timeout: 5`）→ `status==='timed_out'`（不回归） |
| T1-4 | `plain` 模式断言 env 含 `NO_COLOR/TERM=dumb/PAGER/GIT_PAGER`；`terminal` 模式断言不含 `NO_COLOR/TERM` 但含 `PAGER/GIT_PAGER`（模式分流本身） |
| T1-5 | **plan → revalidate 同源（评审项 1 + 门禁 4）**：`terminal` 计划经确认等待后重执行**不出现** `PLAN_STALE`；**并断言执行时实际发送的 progress 形态**——terminal 计划必须发送 `rawDelta`（`sendProgress` 的第二参含 `rawDelta`），plain 计划**不得**发送任何 raw 形态。原稿「对 `environment`/`spawnStdio`/`shellOutputMode` 各一例」易被误读为「三例各产生 stale」——**澄清：三例均为「不 stale」的对照组**（分别覆盖环境重算、fd0 契约、模式三处同源）；「产生 stale」的证明只在 **T1-7**（单元层），因为 revalidate 按设计不会产生这三个 reason |
| T1-6 | **确认期间设置变化（取定行为）**：`terminal` 计划在等待期间把 `shellConfig.outputMode` 改为 `plain` → 重验证仍通过（不 `PLAN_STALE`），且**本次执行仍按冻结的 terminal 跑**（环境不含 `NO_COLOR`，progress 仍发 `rawDelta`） |
| T1-7 | **契约存在性（单元层，评审 v10 B1 + v11 B1）**：**直接调用 `validatePreparedShellExecution`**，断言两个比对项确实参与契约（而非通过 revalidate 触发——后者按设计恒回填快照值，见 T1-7b）。**分两层，因两个字段的可构造性不同**：<br>**T1-7-i（`shellOutputMode`，正常类型构造）**：`current.shellOutputMode` 取与 `prepared` 相反的值（`'plain'` vs `'terminal'`）→ 断言 `reasons` 含 `'shellOutputMode'`。<br>**T1-7-ii（`spawnStdio`，运行时边界构造）**：`SpawnStdio` 只有一种合法取值，**正常类型下无法构造差异值**（这是「唯一取值」设计的直接结果，见 §4.1.2（1））→ 本分支以**受控的运行时无效对象**传入（如 `['ignore','pipe','ignore'] as unknown as SpawnStdio`），断言 `reasons` 含 `'spawnStdio'`；**必须在用例内注明这是运行时边界/防御性测试**（防的是绕过类型的篡改与将来放宽类型时漏改比对），**且不得为让它「正常构造」而在生产代码里放宽 `SpawnStdio`** |
| T1-7b | **回填不变量（集成层，评审 v10 B1）**：调用 `revalidatePreparedShellExecution(prepared, { shellConfig: {...outputMode: 相反值} })` → 断言**不抛** `PLAN_STALE`，且以 spy 断言传给 `assertPreparedShellExecutionCurrent` 的 `current.shellOutputMode === prepared.shellOutputMode`（`spawnStdio` 同理），即「revalidate 从不以实时配置构造 current」；**该用例与 T1-6 的区别**：T1-6 断言执行结果仍按冻结模式跑，T1-7b 断言校验函数的入参来源 |
| T1-8 | **执行层不读 ctx（门禁 4）**：构造 `ctx.shellOutputMode = 'plain'` 但 `prepared.shellOutputMode = 'terminal'` 的组合 → 断言执行层的 raw 增量判定**以快照为准**（发 `rawDelta`），即执行层未读 ctx。**入口必须指明**：`runShellExecutor.execute(input, ctx)` **无法**构造该组合（它先调 `planRunShellExecution`，会用 `ctx` 冻结成同值），因此本用例**直接调用导出的 `executePreparedShellExecution(prepared, ctx, started, baseLog)`**（该函数为执行层的导出入口，见 §4.1.2（5）的边界适配点与 §4.1.4 的硬约束；评审 v12 M3 更正了此前误引的章节号） |
| T1-9 | **回环 ssh（附加证据，非 G5 通过条件，评审 B5）**：`ssh -o BatchMode=yes -o ConnectTimeout=2 -o StrictHostKeyChecking=no 127.0.0.1` → 若执行则记录 `terminationReason`；**不纳入 G5-a 判定**（依赖 OpenSSH 版本与本机配置） |
| T1-10 | **确定性 fd0 契约（评审 B5，G5-a 主体）**：`/bin/sh -c 'read line; echo got:$line'` → 非超时退出（`terminationReason==='process_exit'`）；`cat`（无参数）→ `succeeded` 且 `durationMs` 远小于超时；两者都断言「未因等待 stdin 而超时」。**`cat` 的唯一定义处**：v0.12 前的 T1-1 与本条同夹具同断言（违反 §0.6 判据 5「不重复」），已删除，断言全部由本条承担（评审 v12 M2） |
| T1-11 | **条件用例（`python3` 的唯一定义处）**：`python3 -c 'input()'` 在 `python3` 可用时断言非超时退出（`terminationReason==='process_exit'`）且 stderr 含 `EOFError`；**不可用时跳过并记录，不计入失败**。v0.11 前稿另有一条 T1-2 用同一命令却无跳过条件——在无 `python3` 的环境必然失败，已删除（本用例承担全部断言） |
| T3-4 | **五种计划错误码逐项契约（评审 B1）**：`SHELL_INTERACTIVE_TTY_REQUIRED`/`SHELL_TUI_UNDETECTABLE` 断言 `data.caseId === diagnostic.caseId` 且 `category==='environment'`、`retryable===false`；`SHELL_EXECUTABLE_UNAVAILABLE`/`SHELL_DIALECT_MISMATCH`/`SHELL_PLAN_INVALID` 断言**不出现** `diagnostic` 键，且方言错配的 `retryCount`/`retryExhausted` 行为与本改动前一致 |
| T3-5 | **不可检测原因全量保留（评审 v4-B1）**：遍历 `SHELL_TUI_UNDETECTABLE_REASONS` 六个值，逐个构造 `{ reason, programs: ['less'] }` 并经**真实 `projectToolResultForSink`（agent 出口）**断言原样保留；并各补一例端到端——`bash -c "$CMD less 2>&1"` → `nested-command-unresolvable`、`env env env env env less f` → `recursion-depth-exceeded`，断言模型 payload 的 `tuiUndetectable.reason` 为对应值（**非** `undefined`） |
| T3-1 | plan 失败 payload（`SHELL_INTERACTIVE_TTY_REQUIRED`）含 `tuiMatch` + `diagnostic.category==='environment'`；`SHELL_TUI_UNDETECTABLE` 含 `tuiUndetectable` + `caseId==='SHELL-CAPABILITY-003'` |
| T3-2 | 两类 `reason` 均不等于错误码；`hints` 含命中程序名/词素；`hints` 不含「下方按钮」 |
| T3-3 | **三出口精确 JSON（评审 B3）**：以真实投影函数输出为基准逐字段断言——agent 与 local_history 含 `tuiMatch`/`tuiUndetectable`/`reason`/`hints`，`diagnostic` 含 `category`；telemetry **不含** `tuiMatch`/`tuiUndetectable`/`reason`/`hints`，且 `diagnostic` **不含 `category`**（仅 `caseId`/`retryable`）；两类 TUI 错误各一例 |

### 7.3 呈现（T-4）

- **T4-1（类型守卫，评审 v8 B2）**：构造 `tuiUndetectable.reason` 为**枚举外字符串**（如 `'unknown-reason'`）与 `tuiMatch.rule` 为非枚举值的 `result.data` → 断言 `resolveShellTuiNotice` 返回 `{ kind: 'undetectable' }`（`reason` 为 `undefined`），且**不抛错**；`programs` 含非法项时被逐项过滤、超 8 条被截断。该用例同时是 `npm run typecheck:renderer` 的运行时补充（编译期已由受限类型锚定）。
- 实时：`record.result.error === 'SHELL_INTERACTIVE_TTY_REQUIRED'` → 卡片渲染 + 「打开终端」可用；
- 不可检测：`record.result.error === 'SHELL_TUI_UNDETECTABLE'` → 卡片渲染、文案为「请拆分为单条简单命令」（`kind: 'undetectable'`），「打开终端」入口保留；
- 历史（仅 `error` 码、无 `tuiMatch`）→ 卡片渲染、文案不含程序名；
- `executing` 且无结果 → 不渲染卡片；
- 界面与模型提示同含程序名（§4.4.5）。

### 7.4 中止态（T-6）

> **编号约定**：用例编号按**引入批次**保留（便于对照各轮评审意见），**不代表执行顺序**；实际执行按 §6 的 P3-3 / P3-3b / P3-3c 分组。编号断号（T6-10 已并入 T6-6）为合并遗留，非遗漏。

基础用例：

- **T6-1** reducer：四种终态事件 → 目标状态矩阵（`source-cancelled`→`cancelled`；`source-timeout`/`source-failed`→`failed`）。
- **T6-2** coordinator：`cancel()`/`timeout()`/`recover()`/窗口重开的终态消息；**并断言 `finalizeFinishing` 之后没有代码把 `cancelled` 覆盖成 `failed`**（§4.6.3 关键点 1，C-1 成立与否的判定条件）。
- **T6-3** 读取接口：`status` 字段存在且与 DB 一致。
- **T6-4** 端到端：中断一轮 → 切会话 → 重启，消息仍显示「已停止」。
- **T6-5** 用量口径不回归：`recordTurnSummary` 仍记 `cancelled`。

checkpoint 重试路径（评审项 2 + 门禁 5 + 第 3 轮 B4）：

- **T6-6** `cancel()` 后终态 checkpoint **连续返回 false** → 断言重试上限仍为 3 次（既有实现语义）、之后置 `checkpointFailed`、`getCheckpointStatus(turnId)` 返回 `'failed'`。修复前 `cancelled` 走非终态分支：既不受 3 次上限约束，也永不置失败标记。
  - **口径附带说明（原 T6-10，已合并）**：该场景下 `messages.status` **不承诺**已落 `cancelled`（checkpoint 全失败），且**不计入 G6-a**（G6-a 只要求「成功或 3 次内成功」的路径）；其可恢复性由 T6-11a/T6-11b 的补偿路径承担。原稿把同一夹具拆成 T6-6 与 T6-10 两条独立用例，属重复，现合并为本条的断言 + 口径。
- **T6-7（成功路径，必须查 DB）**：checkpoint 成功或**在 3 次重试内成功**时，`messages.status` 实际落 `cancelled`；重建 coordinator（模拟重启）后读取 DB 该行仍为 `cancelled`。断言对象是数据库实际值，`getTerminal()` 不构成证据。
- **T6-8** 对照用例：`source-failed` 路径的 checkpoint 失败行为与本改动前**逐字节一致**（防把既有失败语义一并改掉）。
- **T6-9** **截断分支（门禁 5）**：构造一条 `content.length > 4000` 的被中止消息 → `action.session.read` 返回的该条同时含 `truncated: true`、`originalChars` **与 `status: 'cancelled'`**（证明两条 return 路径都带状态）。

- **T6-11a（补偿路径 · 无内存归属，重启场景）**：构造「checkpoint 最终失败 + `turns.outcome='cancelled'` 已落库」的库状态 → **重建 coordinator**（`this.turns` 为空）调 `recover()` → 断言 `listRecoverableResidues` 返回该消息且 `turnOutcome==='cancelled'`；走**分支 ①**：`updateIfStreaming` 收到的 patch 为 `status: 'cancelled'`，且 `recoverTurn` **未被调用**；再断言 `messages.status === 'cancelled'`。
- **T6-11b（补偿路径 · 有内存归属，评审 v6/v7）**：同一份库状态，但**从真实的活动内存 turn 开始**（经 `restoreTurn` + 正常事件流使其处于 `streaming`，而非直接改夹具字段；`assistantMessage.id` 与残留消息一致）→ 断言走分支 ① 且**两侧都收敛**：
  - **DB 侧**：`messages.status === 'cancelled'`、`turns.outcome === 'cancelled'`（仍非 `'recovered'`）；
  - **内存侧**：`this.turns` 中该 turn 的 `assistantMessage.status === 'cancelled'`、`persistedOutcome === 'cancelled'`；`getTerminal(turnId)?.outcome === 'cancelled'` 且 `message.status === 'cancelled'`；
  - `recoverTurn` **未被调用**（T6-15 以 spy 断言）。

  **修复前该场景会调用 `recoverTurn` 并写成 `failed` + `outcome='recovered'`**（v6 缺陷）；**v0.7 稿则出现「DB 已 `cancelled`、内存仍 `streaming`」**（v7 缺陷，由本用例的内存侧断言捕获）。
- **T6-12（补偿边界，B4 承认条件）**：`listRecoverableResidues` 返回**无 outcome** 的残留（真实故障/退出残留）→ 仍落 `failed`（不误标中止）。**必须区分两个子情形**（原稿只写「走分支 ②」与期望值不匹配——分支 ② 的前提是存在内存归属）：
  - **T6-12a（有内存归属）**：走**分支 ②**（`owned?.turnId && recoverTurn(...)`）→ 消息 `failed`、`turns.outcome === 'recovered'`（既有语义保持）。
  - **T6-12b（无内存归属）**：`owned` 为 `undefined` → 走**分支 ③**（兜底）→ 消息 `failed`；**`turns.outcome` 不被写入**（该分支不触碰 `turns` 行，故既不是 `'recovered'` 也不是 `'cancelled'`）。
- **T6-17（活动工具调用清理，评审 v7 B2）**：构造带**至少一个 `executing`（或 `confirming`）tool call** 的残留消息，且 `turns.outcome='cancelled'` 已落库 → 调 `recover()` → 断言：
  - `messages.status === 'cancelled'`（**不是** `failed`）；
  - `turns.outcome === 'cancelled'`（未被覆盖为 `'recovered'`）；
  - 该消息的 `toolCalls` 中**不存在** `calling`/`confirming`/`executing`，且被降级的条目为 `status: 'failed'`、`interrupted: true`、`result.error === '工具调用因应用退出中断'`（与 `recoverPersistedTurn` 同源）；
  - 与既有 `recoverPersistedTurn` 的产出**逐字段一致**（该一致性由 T6-19 的对称对照断言保证；两处为各自独立实现，见 §4.6.3 4e）。
- **T6-18（内存活动集合，评审 v7 B1）**：在 T6-11b 的同一场景下追加断言——`recover()` 之后 `listActive()` **不含**该 turn；`cancel(turnId)` 返回 `false`（已终态，不重复执行）；`execute()` 若已在途，其 source 完成时**不覆盖** `cancelled`（走 `alreadyTerminal` 分支）。
- **T6-13（提前返回，评审 v4-B2）**：同一库中**同时**存在 ①一个未完成 turn（`state='executing'`）与 ②一条 `messages.status='streaming'` + `turns.outcome='cancelled'` 的终态残留 → 调一次 `recover()`，断言**两者都被修正**（①为 `failed`、②为 `cancelled`），且返回值等于 2（两阶段计数累加）。修复前 ② 会被第 397 行的提前返回跳过。
- **T6-14（回退，评审 v4-B2）**：使用**旧存储夹具**（不提供 `listRecoverableResidues`，仅提供 `listStreaming`）→ 断言 `recover()` **回退调用 `listStreaming`** 并把残留置为 `failed`（与原实现一致）；再断言若两者都不存在时不抛错、返回 0。
- **T6-15（不抹掉事实的机械证明，评审 v6）**：以 `vi.spyOn(storage, 'recoverTurn')` 包装，在 T6-11a/T6-11b 中断言**未被调用**；并直接断言 DB 中 `turns.outcome === 'cancelled'`（不是 `'recovered'`）。仅断言 `messages.status` 不构成证明。
- **T6-19（降级语义对照，评审 v8 B1）**：对同一组 `toolCalls` 输入，断言 `degradeInterruptedToolCallsWithRecoverSemantics` 与既有 `recoverPersistedTurn` 的实际产出**逐字段一致**（含两个易错场景：「已终态 + 无 result」应**原样保留**、「进行中 + 有 result」应**覆盖为中断文案**），并**同时**断言二者与 `streamingCleanup` 的启动清理语义在「已终态 + 无 result」上**有意不同**（证明两处语义各自独立、未被误合并）。
  - **可达性要求**：`streamingCleanup.downgradeToolCall` 目前是**非导出**函数（`electron/database/streamingCleanup.ts`），无法直接断言。本方案要求把它改为 **`export`**（纯函数、不改行为，仅供测试对照）——取值优先此路径，因其失败信息最易定位；**回退路径**为经 `cleanupStreamingResiduesOnStartup(db)` 间接断言，此时夹具须满足该函数的前置条件（`messages.role='assistant' AND status='streaming' AND turns.turn_id IS NULL`），否则它不会处理该行。
- **T6-20（`.catch` 分支不覆盖 `cancelled`，评审 v12 B2）**：构造「`cancel()` 已被接受并 `finalizeFinishing` 收敛为 `cancelled`」**之后**才让 source reject，且使该 reject 落在 finishing 窗口**之外**（`finishingWindowMs` 设小值或直接清空 `this.finishing`，确保 catch 分支命中 `pendingFinish === undefined`）→ 断言：
  - 内存消息仍为 `cancelled`（**不是** `failed`）、`this.turns` 的 `persistedOutcome` 仍为 `cancelled`；
  - **DB `turns.outcome` 仍为 `cancelled`**（未被 `updateTurnState(..., { outcome: 'failed' })` 覆盖；这是 G6-b 的唯一事实来源）；
  - `this.terminals` 的该 turn 仍为 `outcome: 'cancelled'`，仅 `error` 被补上（`source-failed`）；
  - source 的 reject **仍向上抛出**（既有语义：调用方需要感知失败）。
  对照组：**未发生过 `cancel()`** 的 turn 若 source reject → 仍走既有 `failed`（既有语义无回归，与 T6-8 同型）。
- **T6-16（分支 ③ 对照）**：构造「turn 已 `terminal` + `outcome` 为 NULL + 消息仍 `streaming`」→ 断言 `recover()` 把消息收敛为 `failed`（不抛错、不留 `streaming`），且**未**调用 `recoverTurn`（该函数在此组合下必然返回 `false`）。

### 7.5 需求清单待核实项的落地方式

| 项 | 本方案的验证动作 |
| --- | --- |
| V-1（界面是否真的渲染提示） | P2 完成后复现 `git add docs/vi-usage.md`（修复前拒绝），观察界面行为变化 |
| V-2（模型实际可见 payload） | T3-1/T3-3 的投影单测即为「真实投影」证据；如需请求体抓取，另做一次抓包对照 |
| V-7（stdin 阻塞实测） | §4.1.8 **表 A（确定性 fd0 契约）**逐条实测留痕；表 B 观察项单独记录、不参与判定 |
| V-3/V-4/V-5/V-6 | 不属本方案范围（审批并发/可解释性契约/thinking 提取/导出快照口径） |

### 7.6 回归与门禁

- 全量 `npm test` 必须全绿（重点：`turnCoordinator.test.ts`、`ToolCallCard.test.tsx`、`processResultProjection.test.ts`、`runShellExecutor`/`runShellPlan` 相关）；
- **既有断言逐条复核**（§4.6.5 表）：只把「中止」语义的断言改为 `cancelled`，「失败/恢复」语义保持 `failed`；不得为了让测试通过而改实现语义；
- **门禁 4 的证明**：T1-5/T1-6/T1-8 必须断言**实际发送的 progress 形态**（raw 增量是否存在），并断言执行层读的是 `prepared.shellOutputMode`——仅断言「无 `PLAN_STALE`」不构成证明；
- **门禁 5 的证明**：G6 的每一项都要有 DB 级或接口级证据（T6-7 重启后查 DB、T6-9 截断分支含 `status`）；只在内存断言 `getTerminal()` 不算通过；
- **评审 B1 的证明**：`shellTuiDetection.test.ts` 必须包含解析不完整矩阵与包装链/二次解释矩阵（含词素拒绝 / 不含词素放行），且断言两类拒绝走不同错误码；T3-4 覆盖五种 code 的逐项契约；
- **评审 B2 的证明**：包装链与二次解释矩阵必须包含 §4.2.4 的 4 类通过型与 3 类不误伤对照——只测 `env sudo vim f` 一类不构成证明；
- **评审 B3 的证明**：telemetry 断言必须写明「`diagnostic` 不含 `category`」，并以真实 `projectTelemetryToolResult` 输出为基准（不得手写期望字符串）；
- **评审 B4 的证明**：G6-a/G6-b 的差异必须在测试中显式区分（T6-7 成功路径 vs T6-11 补偿路径），并保留 T6-12 证明「无 outcome 仍 `failed`」；G6-c 的边界需在测试注释中写明；
- **评审 v4-B1 的证明**：T3-5 必须**遍历** `SHELL_TUI_UNDETECTABLE_REASONS` 全量验证投影保留，且包含两个新增原因的端到端用例；仅测「非法 reason 被丢弃」不构成证明；
- **评审 v4-B2 的证明**：T6-13 必须构造「未完成 turn + 已记 outcome 的残留」**同库共存**场景（这是提前返回的触发条件），T6-14 必须使用**不提供新可选方法**的夹具证明回退；
- **评审 v6 的证明**：**T6-11 必须同时有「无内存归属」与「有内存归属」两个变体**（后者是缺陷实际触发路径，只测前者不算证明）；**T6-15 必须以 spy 断言分支 ① 下 `recoverTurn` 未被调用**，并直接断言 `turns.outcome` 仍为 `cancelled`——仅断言 `messages.status` 不构成证明；T6-16 锚定分支 ③；
- **评审 v7 的证明**：① **T6-11b 必须从真实活动内存 turn 开始**（`restoreTurn` + 正常事件流，不得直接改夹具字段），并**同时断言 DB 与内存两侧**——仅断言 `turns.outcome` 不足以证明内存已同步；② **T6-18 必须以 `listActive()` 与重复 `cancel()` 的返回值证明守卫已收口**（因为 `cancelled` 不满足旧守卫的排除项）；③ **T6-17 必须断言工具调用被降级且与 `recoverPersistedTurn` 同源**——只断言 `messages.status` 不构成证明；
- **评审 v8 的证明**：① **不得以「两处都调用同一个函数」代替行为对照**——`recoverPersistedTurn` 保持内联、新函数独立实现，一致性由 **T6-19** 的对称断言证明（并显式断言两处与启动清理的**有意差异**）；② 展示层必须**先守卫再构造**受限类型，`T4-1` + `npm run typecheck:renderer` 同时通过；
- **评审 v9 的证明**：`spawnStdio`/`shellOutputMode` 的接口定义**只有 §4.1.2 一处**（§4.1.4 为引用），且四处签名一致——① `planRunShellExecution` 的 ctx Pick 含 `shellOutputMode`；② `prepareShellExecution` 入参显式写入两字段（必填，编译期可验）；③ `validatePreparedShellExecution` 的 `current` Pick 含两字段且比对项为**直接比较**（无 `??` 兜底）；④ revalidate 从 `prepared` 回填。验证：`npm run typecheck:shared` + `npx tsc -p tsconfig.electron.json --noEmit` 通过，T1-5/T1-7b 通过；
- **评审 v10 的证明**：`shellOutputMode`/`spawnStdio` 的「契约存在性」**必须由单元层用例证明**（T1-7 直接调用 `validatePreparedShellExecution`），**不得**写成「revalidate 产生该 stale」——后者按 §4.1.2 第 4 点的回填设计不可能发生；与之互补的 T1-7b 必须断言「revalidate 的 `current` 来自快照」而非实时配置。**若实现者发现 T1-7 在 revalidate 上失败，正确处置是修测试口径，而不是给 revalidate 增加实时模式参数**（那会重新引入确认期间的分裂）；
- **评审 v11 的证明**：① `SpawnStdio`（`readonly`）与 Node `StdioOptions` 的适配**只允许出现在 §4.1.2（5）的 `spawn` 调用处**，且形式为 `[...prepared.spawnStdio]`；验证方式为 `npx tsc -p tsconfig.electron.json --noEmit` 通过 + `git grep -n "prepared.spawnStdio"` 核对消费点数量（除该行与 §4.1.2（1）(2)(4) 的传递/比较外不应有新的展开）。**禁止**用 `as SpawnStdio` 或其他断言绕过该编译错误，也**禁止**把 `SpawnStdio` 改为可变类型；② T1-7-ii 必须在用例内标注为运行时边界测试，且生产类型中 `SpawnStdio` 仍为单一 readonly 元组（可用类型层断言锚定：`expectTypeOf<SpawnStdio>().toEqualTypeOf<readonly ['ignore','pipe','pipe']>()` 或不引入新依赖时以编译通过 + 用例注释代替）；
- **评审 v4-B3 的证明**：实现前核对 §6 的 P0-2/P0-3 与正文 §4.1.4 一致（执行层读 `prepared.shellOutputMode`），并由 T1-8 以「ctx 与快照不一致」锚定；**实施表与正文冲突时以正文为准**；
- **评审 v5 的证明（模块边界）**：`SHELL_TUI_RULES`/`ShellTuiRule`/`SHELL_TUI_UNDETECTABLE_REASONS`/`ShellTuiUndetectableReason`/`ShellTuiMatch` 的定义**只在** `src/shared/shellTuiContract.ts`；`electron/shell/shellTuiDetection.ts`、`src/shared/processResultProjection.ts`、`src/shared/shellToolDisplay.ts` 均为 import 引用。验证方式：① `npm run typecheck:shared` 与 `npm run typecheck:renderer` 通过（越界即模块不可解析、直接失败）；② `git grep -n "from '\.\./\.\./electron\|from 'electron" -- src/shared` 结果为空；
- **评审 v12 门禁的证明**：① `caseIdForPlanError` 必须保留 `never` 断言形式——验证方式为「临时给 `RunShellPlanErrorCode` 加一个成员，`npx tsc -p tsconfig.electron.json --noEmit` **应当失败**」（验证后回退该临时成员）；若实现者改用静默 `default`，该自检会通过、门禁失效；② `buildPlannedShellEnvironment` 的 `fingerprint` 与 `PreparedShellExecution.environmentFingerprint` 不得互用——由 T1-7 与 T1-5/T1-6 共同覆盖，并在实现时核对 plan/revalidate 两侧**没有**第二处 `resolveShellEnvironment` 调用（`git grep -n "resolveShellEnvironment" -- electron/tools/runShellPlan.ts` 应只命中经 `buildPlannedShellEnvironment` 间接使用的情形）；
- **评审 B5 的证明**：G5-a 只以 §4.1.8 表 A 的确定性用例判定；`psql`/`redis-cli`/`fzf`/裸 `ssh` 只出现在观察记录中，不得出现在任何通过条件里；
- `npm run typecheck:shared`、`typecheck:renderer`、`typecheck:agent-core` 全通过；electron 侧类型用 `npx tsc -p tsconfig.electron.json --noEmit` 校验（仓库无独立 script）；
- `git diff --check` 干净；
- Windows 侧行为无法在本机验证的部分（`-NonInteractive` 与 stdio 叠加、`taskkill` 路径）**明确标注为待 Windows 实机/CI 验收**，不在 macOS 结果上宣布完成（沿用仓库既有纪律）。

---

## 8. 风险与回退

| 风险 | 影响 | 缓解/回退 |
| --- | --- | --- |
| T-1 环境压制改变既有命令行为（如脚本依赖 `TERM`） | 中：可能影响脚本分支逻辑 | 仅压制展示类变量；不设 `CI`；`terminal` 模式保留颜色；异常时可只回退 `PLAIN_MODE_OVERRIDES` 两行 |
| T-1 模式未进入 plan 快照 → `terminal` 计划审批后 `PLAN_STALE`（评审项 1） | **高**：确认后的命令无法执行 | `shellOutputMode` 随 plan 冻结、revalidate 只读快照（§4.1.2/§4.1.5）；T1-5/T1-6/T1-7/T1-7b 锚定（T1-7 单元层证明契约存在，T1-7b 证明回填不变量） |
| 测试口径与 revalidate 回填语义冲突（v0.10 稿，评审 v10 B1） | **高**：T1-7 要求一个不可能发生的结果；实施者为让它通过会改回「读实时模式」，重新引入确认期间的分裂 | 已取定：`shellOutputMode` 是冻结计划内部不变量，契约存在性由**单元层** T1-7 证明、回填不变量由 T1-7b 证明（§4.1.2 第 4 点注脚 + §4.1.5 第 4 点 + §7.6）；revalidate 签名与回填行为不动 |
| T-1 确认期间模式变化被误判为配置变化 | 中：可能导致用户重新审批 | 取定「展示偏好变化不使计划失效」（§4.1.5 第 3 点）+ `shellConfigRevision` 注释显式排除 `outputMode`；T1-6 锚定 |
| T-1 `spawnStdio` 未同步 revalidate → 审批后 `PLAN_STALE` | 高：命令在确认后无法执行 | §4.1.5 共用构造函数 + T1-5 双用例 |
| T-2 解析不完整时静默放行（v0.2 稿的 fail-open） | **高**：`vim`/`less` 包在无法解析的构造里即可绕过能力拒绝，且无任何引导（评审 B1） | **已改 fail-closed**（§4.2.6）：解析不完整 + 含 TUI 词素 → `SHELL_TUI_UNDETECTABLE`；兜底域严格限定在「解析不完整」少数路径，可正常解析的命令不受影响（§4.2.4 锚定）；如需更宽容，可把兜底降级为 warning 事件（需重新定义 G1，不推荐） |
| T-2 包装链/二次解释绕过（v0.3 稿的「仅一层穿透」，评审 B2） | **高**：`env sudo vim f`、`bash -c 'vim f'`、`eval 'top'` 均可解析却穿透失败，运行契约名不副实 | 已改**有界递归**（包装链 ≤4、解释 ≤3）+ 二次解释边界，超限与不可静态确认均 fail-closed（§4.2.2 第 2/5 点）；保证范围写入 §2.4（含「运行期解析且无词素」明确不保证） |
| T-3 为无归因结论的错误补默认 `diagnostic`（v0.3 稿，评审 B1） | **高**：方言错配被标成不可重试的能力限制，破坏既有重试语义与 G2/G3 归因 | 已改**逐项显式映射**：仅两类 TUI 错误写 `diagnostic`（§4.3.2 契约表 + T3-4）；归因不变量写入 §2.3 第 5 条 |
| T-3 telemetry 期望与投影规则不符（v0.3 稿写 `category` 存在，评审 B3） | 中：T3-3 必然失败，且「文档与实现不一致」会掩盖真实回归 | 已按 `STABLE_CODE_RE` 推导并取定「telemetry 不保留 `category`」（§4.3.5 投影表 + ③ 修正），测试以真实投影输出为基准 |
| T-6 把「checkpoint 最终失败」与「重启后仍为已停止」混为一谈（v0.3 稿的 G6 单条，评审 B4） | **中高**：验收条件自相矛盾，实施者无法判断通过标准 | 已拆为 G6-a/b/c 三级（§9）+ T6-6（含原 T6-10 口径，两条已合并）/T6-7/T6-11a/T6-11b/T6-12a/T6-12b；新增 `listRecoverableResidues` 补偿路径（§4.6.3 关键点 4）；**明确承认**两处 DB 写均失败时无法保证 |
| T-1 G5 含 `psql`/`fzf` 等外部环境行为（v0.3 稿，评审 B5） | 中：验收不可复现 | G5 收窄为 fd0 契约（§2.1 G5 + §4.1.8 表 A），外部行为移入表 B 观察项并写入 §2.2 非目标 |
| T-3 投影白名单与判定枚举漂移（v0.4 稿：新增两个 reason 未加白名单，评审 v4-B1） | **高**：整个 `tuiUndetectable` 分支被静默丢弃，结构化原因与 `programs` 到不了模型，G2/T3-3 契约落空 | 枚举提取为 `SHELL_TUI_UNDETECTABLE_REASONS` 单一事实来源（§4.2.2），投影按它构造 Set 校验（§4.3.5）；T3-5 遍历全量值做真实投影断言 |
| T-6 启动补偿被提前返回跳过（v0.4 稿，评审 v4-B2） | **高**：只要库中存在任一未完成 turn，中止态残留永不补偿，G6-b 实际不成立 | 删除 `turnCoordinator.ts:397` 的提前返回、两阶段都跑且计数累加（§4.6.3 关键点 4a）；T6-13 以「同库共存」场景锚定 |
| T-6 断言复核表把 496 行归类反了（v0.12 稿，评审 v12-B1） | **中高**：按表实施会漏改（测试必红），或为保绿而保留旧语义（G6-a 不成立） | §4.6.5 表格按「行号 + 归属测试 + 断言语义 + 处理」重列；496（cancel 测试）→ `cancelled`，477（source 直接 terminal）→ `completed` 保持 |
| `execute()` 的 `.catch` 分支覆盖 `cancelled`（v0.16 前稿，评审 v12-B2） | **高**：一次同时破坏消息状态与 G6-b 的唯一事实来源（`turns.outcome`） | §4.6.3 新增该行 + 终态保护；终态写入点 7→8 处；T6-20 锚定（含未 cancel 对照） |
| `partial` 被整体当作「不可信」导致重定向误拒（v0.15 前稿，评审 v12-B4） | **中高**：A-1 同族误伤在重定向形态残留（`git log > top.log` 等被拒为 `SHELL_TUI_UNDETECTABLE`） | §4.2.2 按 `unresolved` 条目类别判断（`shell-control-flow` **不**触发 fail-closed）；§4.2.6/§4.2.4 同步；由矩阵 4 例锚定 |
| 同一符号在文档内出现两份定义（v0.17 前稿：`resolveShellTuiNotice` 旧版 + 守卫版并存） | **中**：实施者照旧版实现，使 v8-B2 的类型收窄修复形同虚设 | 删除旧版、保留唯一定义（§4.4.3）；§0.6 增列「模式四」判据（同一节内同名定义只允许一份） |
| T-6 新可选查询缺失时未回退（v0.4 稿 `?? []`，评审 v4-B2） | 中：旧存储夹具下残留不再置 `failed`，行为回归 | 三档回退并显式调用 `listStreaming()`（§4.6.3 关键点 4b）；T6-14 用不提供新方法的夹具锚定 |
| 文档内部指令冲突（v0.4 稿 P0-3 与正文 §4.1.4 相反，评审 v4-B3） | 中：实施者按表开发即重现状态分裂 | P0-3/P0-2 已对齐正文（执行层读快照）；§7.6 补「实施表与正文一致、冲突以正文为准」的核对项 |
| 跨层契约常量放在 electron 模块导致 shared 反向依赖（v0.5 稿，评审 v5） | **高**：`processResultProjection.ts` 会连带引入 `shellCommandParser`/`shellAnalyzer`，破坏 shared/renderer 边界；若另抄一份则白名单漂移回归 | 契约常量与类型统一下移 `src/shared/shellTuiContract.ts`（§4.2.2/§4.4.2）；边界由 `typecheck:shared`/`typecheck:renderer` 机械保证（§7.6 门禁） |
| 后续维护中把契约常量「顺手」加回 electron 侧 | 中：同类缺陷第 3 次复现 | §4.4.2 明确「凡被渲染层或 shared 投影层共享的字面量域必须定义在 shared」的一般原则；§7.6 提供 grep 核对命令 |
| 用 `recoverTurn` 终结 `cancelled` 残留（v0.5/v0.6 稿，评审 v6） | **高**：固定写 `failed` + 覆盖 `outcome='recovered'`，`cancelled` 事实被抹掉，G6-b 失败；且 turn 已 `terminal` 时该函数返回 `false`，消息永久停留 `streaming` | 协调器侧三分支分派（§4.6.3 关键点 4c）；**分支 ① 绝不调用 `recoverTurn`**；`recoverPersistedTurn` 的对外语义与写入值保持原样（仅内部提取工具调用降级纯函数），§4.6.5 显式标注 |
| 后续维护者「顺手」给 `recoverPersistedTurn` 加 `targetStatus` 参数 | 中：会再次触及 `outcome` 覆盖语义与既有测试 | §4.6.3 4(c) 写明备选方案**不采用**及原因；§4.6.5「不改变对外语义」行显式标注该函数 |
| 分支① 只改 DB 不同步内存（v0.7 稿，评审 v7 B1） | **高**：`listActive()`/`cancel()`/`execute()` 守卫只认 `completed`/`failed`，`cancelled` 不满足排除项 → 该 turn 仍被判为活动，运行时状态机被破坏 | §4.6.3 4(d) 抽出 `convergeTurnToTerminal` 并**与 `listActive` 等守卫收口同批实施**；T6-11b/T6-18 锚定两侧 |
| 分支① 留下活动工具调用（v0.7 稿，评审 v7 B2） | **中高**：出现「消息 `cancelled`、工具调用仍 `executing`」的持久化状态，误导 UI 与恢复扫描 | §4.6.3 4(e) 端口方法 `finalizeResidueMessage` + 按 recover 语义独立实现的降级函数；T6-17 与 `recoverPersistedTurn` 逐字段对照 |
| 工具调用降级逻辑出现第二份实现 | 中：两份语义漂移（同 v4~v6 的教训模式） | 只共享常量与判定（`toolCallInterruption.ts`）；策略函数各自实现，**一致性由 T6-19 的对称断言保证**而非靠共用 |
| 误把两处不等价的降级实现当作同一函数（v0.8 稿，评审 v8 B1） | **高**：直接共用会改变 `recoverPersistedTurn` 的既有行为（「已终态 + 无 result」由保留变为降级），属范围外行为变更 | §4.6.3 4(e) 列出**四处差异**表；`recoverPersistedTurn` **本轮不重构**；T6-19 逐字段对照 + 有意差异断言 |
| 展示层把宽松解析字段直接当受限枚举使用（v0.8 稿，评审 v8 B2） | **高**：`typecheck:renderer` 直接失败，方案无法按原样实施 | §4.4.3 类型守卫（白名单来自 shared 契约，`programs` 逐项校验 + 截断）；T4-1 锚定运行时行为 |
| T-1 把裸 `ssh`（及回环 `ssh`）的快速失败当验收承诺（v0.2/v0.3 稿） | 中：行为取决于 OpenSSH 版本、配置、网络与 tty，不可复现（评审 B2 + B5） | 已按第 3 轮进一步收窄：G5 只以 §4.1.8 **表 A（`sh -c 'read'`、`cat` 等确定性用例）**判定；回环 `ssh`（T1-9）降为**附加证据**，裸 `ssh`/`psql`/`redis-cli`/`fzf` 移入表 B 观察项 |
| T-3 新增 `details` 字段泄露命令文本 | 中：投影是安全边界 | `tuiMatch`/`tuiUndetectable` 只放程序名/规则/序号/枚举 reason，**不含命令原文与参数**；受控校验；**telemetry 完全丢弃这两个键**（§4.3.5 唯一定义 + §4.3.6 精确 JSON） |
| T-3 telemetry 契约含糊（v0.2 稿的「键仍在」） | 中：测试无法判定正确行为，且可能把命令位带入 telemetry（评审 B3） | 已取唯一结论：telemetry 丢弃 `tuiMatch`/`tuiUndetectable`，仅保留 `caseId`；三出口逐字段 JSON 作为测试基准 |
| T-3 telemetry 期望 JSON 与投影规则不符（v0.3 稿写 `category` 存在，评审 B3 第 3 轮） | 中：T3-3 必失败，掩盖真实回归 | 已按 `STABLE_CODE_RE` 推导：`category`（小写）在 telemetry 必被丢弃，期望 JSON 与测试基准同步修正（§4.3.5/§4.3.6） |
| T-6 `recover()` 补偿引入「把故障误标为中止」的风险（v0.4 新增路径） | 中：状态语义失真 | 补偿**只**消费 `turns.outcome`（故障路径为 `failed`/无 outcome → 保持 `failed`）；T6-12 锚定无 outcome 场景；`turns` 行缺失时回退既有 `listStreaming` 行为 |
| T-4 删除旧判据导出导致遗漏调用点 | 中：编译期可发现 | 类型检查兜底；已确认调用点仅 3 处 |
| T-6 枚举扩展遗漏穷尽检查（含 `finishCheckpoint` 的重试路径，评审项 2） | **中高**：可能出现「界面已停止、DB 未落终态」的不一致，且绕过 checkpoint 失败上限 | §4.6.5 检索清单（含反向形态 `!==`）+ 7 处判定收口到单一函数 + coordinator 全量回归 + T6-6/T6-7 锚定 |
| T-6 历史回填（可选） | 低：写库操作 | 默认不启用，需批准；幂等 + 计数日志 |
| T-5 纪律文案增加 token 成本 | 低 | 约 +120 字，常驻工具描述；如需压缩，只保留前两条纪律 |

---

## 9. 验收判据（可勾选）

- [x] **G1**：§4.2.4 矩阵全部条目判定符合预期（**含重定向对照组**：`git log > top.log`、`git add docs/vi-usage.md > /dev/null`、`cat htop-report.md > /tmp/x` 放行；`less README.md > out.txt` 拒绝——评审 v12 B4）；`shellTuiDetection.test.ts` 覆盖**三类矩阵**——误伤回归、命令位不可信（含词素 → `SHELL_TUI_UNDETECTABLE`；不含 → `clear`）、包装链与二次解释（4 类通过型 + 2 类 `undetectable` + 3 类不误伤对照）；`SHELL_INTERACTIVE_TTY_REQUIRED` 首次拥有回归测试（N-1 结项）。**能力拒绝边界不因解析失败、包装链或二次解释而开口（评审 B1/B2 结项）**。
- [x] **G2**：两类能力拒绝的 `agent`/`local_history` payload 含 `diagnostic.category='environment'`、`tuiMatch`/`tuiUndetectable`（**六种 `reason` 全部可送达**，评审 v4-B1）、可解释 `reason`（含穿透路径 `via`）、含命中信息的 `hints`；**其余三种计划错误不出现 `diagnostic`，方言错配的可重试语义不回归（T3-4，评审 B1 结项）**；`telemetry` payload **不含** `tuiMatch`/`tuiUndetectable`/`reason`/`hints`，且 `diagnostic` **不含 `category`**（评审 B3 结项）；**契约常量/类型的定义唯一位于 `src/shared/shellTuiContract.ts`，shared 层零 electron 依赖（评审 v5 结项）**。
- [x] **G3**：模型侧 `hints`/`reason`/工具描述不再出现界面专属措辞；描述含「能力拒绝 ≠ 策略拒绝」「不得换途径重试」「不得绕过通道征求许可」；复现任务中不再出现「安全策略拦下 git commit」类表述（人工留痕）。证据：`docs/develop/session-ced59b41-g3-manual-evidence.md`。
- [x] **G4**：渲染层零调用旧判据（`git grep isInteractiveShellTuiCommand` 为空）；提示判据唯一来自工具结果（`resolveShellTuiNotice`，覆盖 `tui`/`undetectable` 两态）；历史消息（仅 `error` 码）仍能显示入口。
- [x] **G5**：**§4.1.8 表 A（确定性 fd0 契约）**全部通过并留痕——含 `/bin/sh -c 'read'`、`cat`、`sleep` 超时不回归、terminal 着色不回归、`python3`（可用时）；**表 B（`psql`/`redis-cli`/`fzf`/裸 `ssh`）仅作观察记录，不参与判定（评审 B5 结项）**；plan↔revalidate 同源（T1-5/T1-6/T1-8）通过，且断言到实际 progress 形态（raw 增量），`terminal` 计划经确认等待不出现 `PLAN_STALE` 且执行层不读 ctx（评审项 1 + 门禁 4 结项）。
- [x] **G6**：中断一轮后消息 `status==='cancelled'`，与故障/残留可区分；`action.session.read` 的**两条返回路径（含长消息截断）**都返回 `status`；用量口径不回归。**分三级验收（v0.4，评审 B4 拆分）**：
  - **G6-a（必须）**：checkpoint 成功或 3 次重试内成功 → 重启后 DB 中 `messages.status === 'cancelled'`（T6-7）。
  - **G6-b（补偿）**：checkpoint 最终失败但 `turns.outcome='cancelled'` 已落库 → **下次启动**由 `recover()` 按 outcome 修正为 `cancelled`（T6-11a **与 T6-11b**：有无内存归属两条路径结果一致，且全程**不调用 `recoverTurn`**、`turns.outcome` 保持 `cancelled`，T6-15 以 spy 断言）；**DB 与内存两侧都收敛**——内存 turn 消息为 `cancelled`、`listActive()` 不再返回它、重复 `cancel()` 为 `false`（T6-18，评审 v7 B1）；**活动工具调用被降级为中断失败，语义与 `recoverPersistedTurn` 逐字段一致、并与启动清理的有意差异一并断言**（T6-17/T6-19，评审 v7 B2 + v8 B1）；**且该补偿不受库中存在其他未完成 turn 的影响，并在旧存储夹具下回退 `listStreaming`（T6-13/T6-14，评审 v4-B2 结项）**；turn 已 terminal 且无 outcome 时消息收敛为 `failed`（T6-16，评审 v6 结项）。
  - **G6-c（明确承认的边界）**：`messages` 与 `turns` 两处写入**均失败**（DB 不可写）时，**无法保证**重启后仍显示「已停止」；此时按既有 `recover()` 语义显示 `failed`。**该项不作为失败判据，但必须在文档与测试注释中写明**。
  - **G6-d（不覆盖不变量，评审 v12 B2）**：**不存在把 `cancelled` 覆盖为 `failed` 的代码路径**——含 `execute()` 的 `.catch` 分支（T6-20：finishing 窗口外 reject 后消息与 `turns.outcome` 仍为 `cancelled`，且 reject 仍向上抛出；未 cancel 的 reject 仍为 `failed`）。
    - 措辞澄清：此处「可观测」**仅指进程内状态可查询**（`getCheckpointStatus(turnId) === 'failed'`，由 T6-6 断言），**不含**面向用户的提示——后者属独立体验项，见 §10 第 8 条（两者不矛盾）。
  - `recover()` 对「无 outcome 的进行中 turn 与残留」仍为 `failed`（T6-12a 有内存归属 → `outcome='recovered'`；T6-12b 无内存归属 → 不写 `turns`）。
- [x] 全量测试、三项 typecheck、`git diff --check` 通过；Windows 待验项已标注。

---

## 10. 未覆盖项与后续

1. **需求清单第 4/6 章（审批并发、配额、可解释性、O-1~O-5）**：本方案不触碰。其中 O-1/O-3/V-4 的端到端验证与本方案无关，需另行排期。
2. **待决议题中被本文取定但不属「明确问题」的部分**：D-4（审批话术是否保留）本文取「保留 + 补边界」；D-7 的词表定位经第 2 轮评审修正为**「运行契约 + 引导」**（不再是「可 fail-open 的引导设施」）。若评审要求更宽容的解析兜底，影响面为 `shellTuiDetection` 的 `undetectable` 分支返回值与 G1 矩阵，需重新定义验收口径。
3. **`run_script` 的 stdin 同族风险**（N-10）：建议单独立项评估（§4.1.6），本文只记录事实。
4. **`SHELL_CASE_IDS` 的其他项是否下移 shared**：本文已下移**两项**（`shellCaseIds.ts` 的 TUI case id 与错误码、`shellTuiContract.ts` 的规则/原因枚举与 `ShellTuiMatch`）。若后续渲染层或 shared 投影层需要消费更多 case id 或字面量域，按同一原则（§4.4.2）逐步下移，不做一次性搬迁。
5. **A-3 的行为层根治**：宿主只能降低诱因（§4.5）。若后续发现同类「把能力错误码误述为策略拒绝」在其它工具上复现，宜在工具结果契约层统一补 `diagnostic.category`（本文只在 `run_shell` 补齐），该项列为观察项。
6. **超时（`timed-out`）是否独立表达**：本文保留 `failed`（§4.6.2），若用户侧需要区分「超时」与「失败」，只需扩 `MessageStatus` 与映射函数。
7. **输出模式是否应参与 `configRevision`（使已确认计划失效）**：本文取「不参与」（§4.1.5 第 3 点，理由：展示偏好非安全语义）。若产品认为「用户改设置后旧计划必须重走审批」，改动点为 `shellConfigRevision` 增加 `outputMode`，并需同步调整 T1-6 的预期；该决定不影响本方案的其他部分。
8. **`checkpointFailed` 的可观测性**：本文只保证 `finishCheckpoint` 的路径语义与既有实现一致（T6-6/T6-8）。若需要把「终态 checkpoint 最终失败」暴露给用户（例如气泡旁提示「状态可能未保存」），属独立的体验项，不在本次范围。
9. **telemetry 是否需要区分两类能力拒绝**：本文取「telemetry 只保留 `caseId`（`SHELL-CAPABILITY-001`/`-003`），`tuiMatch`/`tuiUndetectable` 整块丢弃，且 `diagnostic.category` 按既有规则被丢弃」（§4.3.5）。若数据侧需要更细维度或 `category`，应新增稳定枚举键（如 `tuiRule`）或给 `category` 单独的固定枚举白名单（`SAFE_DIAGNOSTIC_CATEGORIES`），**不得**放宽通用大写正则；该变更只影响投影白名单，不影响本方案其余部分。
10. **解析/穿透兜底（`undetectable`）的长期归属**：本文把它作为 T-2 的一部分实现，包含 `segments-overflow`/`unbalanced-quote`/`analysis-partial`/`tokenize-failed`/`nested-command-unresolvable`/`recursion-depth-exceeded` 六类原因。若后续统计（`tuiUndetectableCleared` 日志）显示某类占比极低，可考虑细化处置（例如仅对 `segments-overflow`/`nested-command-unresolvable` 拒绝、对纯语法错误交给 shell 自报），但**任何放宽都必须保持「含词素即拒绝」这一底线**。
11. **递归/二次解释深度上限是否可配置**：本文固定为包装链 4 层、解释 3 层（常量集中在 `shellTuiDetection.ts`）。若实测发现更深链路（如企业封装的 `sudo` 脚本链）常态存在，可提升上限，但需同步评估判定耗时与「词素存在性兜底」的误伤面。

---

## 11. 修订记录

> 排列说明：0.1 ~ 0.8 为升序；**0.8 之后八条（0.16 → 0.15 → 0.14 → 0.13 → 0.12 → 0.11 → 0.10 → 0.9）按补录倒序排列**——0.16 为第 12 轮复评落地的两项门禁、0.14 为第 11 轮评审响应、0.15/0.13/0.12 为三轮自审清理、0.11/0.10/0.9 为第 10/9/8 轮评审响应，编号本身不受排列影响。

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| 0.1 | 2026-09-24 | 首版。基于 HEAD `e8ad2755` 复核需求清单 A-1~A-5、C-1 六项（均仍在），新增 10 条调研事实（N-1~N-10）；给出 T-1~T-6 设计、P0~P3 阶段切分、测试与验收判据；对 D-1/D-2/D-3/D-4/D-6/D-7 给出取定结论。 |
| 0.2 | 2026-09-24 | 响应评审（第 1 轮，§0.5）。①评审项 1：`shellOutputMode` 进入 plan 冻结并定义 `isTerminalShellOutputMode` 同源判定与缺省口径；revalidate 改为从 `prepared.shellOutputMode` 构造环境（签名不变）；`validatePreparedShellExecution` 新增 `shellOutputMode` 比对项；明确「确认期间设置变化不使计划失效」的取定行为与 `shellConfigRevision` 注释；T1-4~T1-7 覆盖。②评审项 2：`finishCheckpoint()` 改用 `isTerminalMessageStatus`，补 T6-3/T6-4/T6-5 与 §4.6.5 的改动清单、检索命令（含反向形态）、既有断言复核表；`execute()` 补 `outcomeForMessageStatus` 收敛。③同步更新 §5/§6/§8/§9/§10 与 G5/G6 验收判据。 |
| 0.3 | 2026-09-24 | 响应评审第 2 轮（三项阻断 + 两项门禁，§0.5）。①**B1**：TUI 判定改三态，解析不完整时 fail-closed（新增 `SHELL_TUI_UNDETECTABLE` + `SHELL-CAPABILITY-003`），§4.2.5 词表定位升为「运行契约 + 引导」，§4.2.6 整节重写，§4.2.4/§7.1/§8/§9 同步改写，§2.3 不变量第 4 条改为「能力判据同样 fail-closed」。②**B2**：更正 `SSH_ASKPASS` 作用域，§4.1.8 将 `ssh` 拆为可控断言（T1-9）与观察项，G5 只纳入前者。③**B3**：`tuiMatch`/`tuiUndetectable` 在 telemetry 出口**完全丢弃**，§4.3.5 给出唯一契约表，§4.3.6 给出三出口精确期望 JSON，T3-3/G2 改为逐字段比对（删除「键仍在」）。④**门禁 4**：执行层 `terminalMode` 改为从 `prepared.shellOutputMode` 读取（禁止读 ctx），T1-5/T1-6 补 raw progress 断言，新增 T1-8。⑤**门禁 5**：读取接口两个分支都必须带 `status`，T6-7 改为重启后查 DB，新增 T6-9（截断分支），§7.6 补三项门禁的证明要求。 |
| 0.4 | 2026-09-24 | 响应评审第 3 轮（五项阻断，§0.5）。①**B1**：计划失败返回体改为**逐项显式映射**（`caseIdForPlanError`/`diagnosticForPlanError`），`diagnostic` 仅对两类 TUI 错误写入，方言错配保留可重试语义；新增 §4.3.2 契约表、T3-4 与 §2.3 归因不变量。②**B2**：包装命令穿透改为**有界递归**（≤4 层、选项解析表）并新增**二次解释边界**（shell `-c`/`eval`，字面量递归、含变量则不可确认、超限即 fail-closed）；`ShellTuiMatch.via` 记录穿透路径并写入 `reason`；§4.2.4 补 10 例矩阵（含 3 例不误伤对照）、§7.1 补该类矩阵、新增 §2.4 保证范围声明。③**B3**：按 `STABLE_CODE_RE` 推导 telemetry 中 `diagnostic` 的各字段去留，**取定 telemetry 不保留 `category`**，修正 ③ 的期望 JSON 并把测试基准改为真实投影输出。④**B4**：拆分「checkpoint 最终失败」与「重启后仍为已停止」——新增 `listRecoverableResidues` + `recover()` 按 `turns.outcome` 修正的补偿路径，G6 分 a/b/c 三级并明确承认两处 DB 写均失败时的边界，新增 T6-10/T6-11/T6-12。⑤**B5**：G5 收窄为可证明的 fd0 契约（§2.1 G5 + §4.1.8 表 A），外部环境行为移入表 B 观察项与 §2.2 非目标，新增 T1-10/T1-11。 |
| 0.5 | 2026-09-24 | 响应评审第 4 轮（三项阻断，§0.5）。①**v4-B1**：`undetectable` 原因提取为 `SHELL_TUI_UNDETECTABLE_REASONS` **单一事实来源**（类型、判定、投影白名单同源），修正 `projectTuiUndetectable` 内联四值枚举导致两个新增原因被静默丢弃的问题；新增 T3-5（六值全量投影保留 + 两例端到端）。②**v4-B2**：`recover()` **删除** `if (unfinished.length > 0) return recovered` 提前返回（两阶段始终执行、`recovered` 不再重置为 0），并补三档回退（新方法 → `listStreaming()` → 空数组）修正 `?? []` 无回退的问题；新增 T6-13（未完成 turn 与残留同库共存）与 T6-14（旧存储夹具回退）。③**v4-B3**：P0-2/P0-3 与正文对齐——执行层 `terminalMode` 读 `prepared.shellOutputMode`（禁止读 ctx），plan 只在冻结时读一次 ctx；§7.6 补「实施表与正文冲突以正文为准」的核对项。 |
| 0.6 | 2026-09-24 | 响应评审第 5 轮（模块边界，§0.5）。**v5**：`SHELL_TUI_UNDETECTABLE_REASONS` 不再定义在 `electron/shell/shellTuiDetection.ts`（否则 `src/shared/processResultProjection.ts` 引用它会形成 shared→electron 反向依赖，连带引入 `shellCommandParser`/`shellAnalyzer`）；新增 **`src/shared/shellTuiContract.ts`** 承载 `SHELL_TUI_RULES`/`ShellTuiRule`、`SHELL_TUI_UNDETECTABLE_REASONS`/`ShellTuiUndetectableReason`、`ShellTuiMatch`，判定层、投影层、展示层**三方均 import 引用**（`ShellTuiVerdict` 仅判定层产出，留在 electron）。§4.4.2 升格为「跨层契约常量与类型必须定义在 shared」的一般原则（与 `shellCaseIds.ts` 下移并列）；§7.6 新增边界证明方式（`typecheck:shared`/`typecheck:renderer` + grep 核对）；§5/§6 P1-1/P1-4/§8/§9 G2 同步。 |
| 0.7 | 2026-09-24 | 响应评审第 6 轮（一项阻断，§0.5）。**v6**：撤销「有内存归属时调用 `recoverTurn`」的写法——`recoverPersistedTurn` 固定写 `status:'failed'` 并把 `outcome` 覆盖为 `'recovered'`，会抹掉 `cancelled` 事实致 G6-b 失败；且其 turn 查询限定未终止 state，turn 已 `terminal` 时返回 `false`、消息永久停留 `streaming`。§4.6.3 关键点 4 新增 **(c) 三分支分派**（①有 outcome → 只改消息、绝不调用 `recoverTurn`；②无 outcome → 沿用既有语义；③turn 已 terminal 且无 outcome → 兜底收敛为 `failed`），不改存储层对外语义并写明备选方案不采用的理由。T6-11 拆为「无内存归属 (a) / 有内存归属 (b)」两变体，新增 T6-15（spy 断言 + `turns.outcome` 保持 `cancelled`）与 T6-16（分支 ③）；§4.6.5/§7.6/§8/§9 G6-b/§6 P3-3c 同步。 |
| 0.8 | 2026-09-24 | 响应评审第 7 轮（两项阻断，§0.5）。①**v7-B1**：§4.6.3 关键点 4 新增 **(d) 内存状态同步**——抽出 `convergeTurnToTerminal(turnId, outcome)`（更新 `this.turns` 的消息状态与 `persistedOutcome`、写入 `this.terminals` 索引），第一阶段与分支① 共用；并明确 `listActive()` 改用 `isTerminalMessageStatus` 是**该修复的必要条件**（`cancelled` 不满足旧守卫的排除项）；T6-11b 改为从真实活动内存 turn 开始并两侧断言，新增 T6-18。②**v7-B2**：新增 **(e) 工具调用清理**——`TurnStorage` 增加可选端口 `finalizeResidueMessage?(messageId, targetStatus)`，electron 侧实现 `finalizeResidueMessageKeepingOutcome`；新增 T6-17。§5/§6 P3-3c/§7.4/§7.6/§8/§9 G6-b 同步。 |
| 0.17 | 2026-09-24 | **响应第 12 轮复评·第二版（4 项阻断）**：①**B1** 更正 §4.6.5 断言复核表——`turnCoordinator.test.ts:496` 属 **`cancel 会进入 finishing…`（483 起）**、断言 `failed`，**改为 `cancelled`**；`completed` 那条是 **477 行**（468 起）。v0.12 的「更正」方向改反，已加注来源。②**B2** `execute()` 的 `.catch` 分支（219-232）在 `pendingFinish` 为空时无条件写 `failed` + `turns.outcome='failed'` —— §4.6.3 新增该行并要求**终态保护**，终态写入点 7 处→**8 处**，新增 **T6-20**（含未 cancel 对照）。③**B3** 围栏失衡已修（0 缩进 74 偶数、无异常），并修正列表内代码块缩进与**同节两份 `resolveShellTuiNotice` 并存**的重复定义。④**B4** `shell-control-flow` 使 `partial` 但不影响命令位 —— §4.2.2 改为「按 `unresolved` 条目类别判断命令位是否可信」（新增对照表 + `hasUnreliableCommandPosition`）、§4.2.6 判定表新增重定向行、§4.2.4 补 4 例重定向矩阵、兜底域由「三类」改为「四类命令位不可信路径」。另响应 M1~M5（三处 import / T1-1 去重 / T1-8 章节引用 / telemetry delete 口径 / 删除范围措辞），M6 复核后已不成立。 |：复评结论为「v0.15 未发现新的确定性阻断问题，可进入实现阶段」。本版落地其两项维护性门禁：① §4.3.2 的 `caseIdForPlanError` 由「`case 'SHELL_PLAN_INVALID': default:` 静默兜底」改为**穷尽 switch + `default` 中 `never` 断言**——保留运行时兜底的同时，使「新增 `RunShellPlanErrorCode` 成员却忘记补映射」成为编译错误；同族 `diagnosticForPlanError`（`if` 形式）补配套约束与 T3-4 覆盖说明。② §4.1.5 第 1 点新增「两个 fingerprint 的职责边界」表——区分 `buildPlannedShellEnvironment` 返回的**源环境**指纹（→ `dependencySnapshot.environmentFingerprint`）与 `PreparedShellExecution.environmentFingerprint`（→ revalidate 比对），明确不得互换、不得在 plan/revalidate 侧另行 `resolveShellEnvironment`。另记录复评明确排除的三类「不应追加的要求」，§7.6 补两项门禁的证明方式，§0.5 新增第 12 轮小节。 |
| 0.15 | 2026-09-24 | **自审清理（第三轮，非评审提出）**：按 **v11-B1 揭示的第三种模式**（「片段写全了，但单独放进真实文件后无法编译」——缺 import / 类型引用 / 名称定义）全文复查，修正 6 处：① §4.3.5 投影 import 补 `type ShellTuiRule, type ShellTuiUndetectableReason`（两个函数签名引用它们）；② §4.6.2 `messageStatusForTurnOutcome` 入参改为引用既有 `TurnOutcome`（`assistantFactAggregator.ts:4`），不再内联重写，并写明与 `UsageTurnOutcome`（多 `'interrupted'`）的边界；③ §4.6.3 4(b) 注明 `turnCoordinator.ts` 的 domainTypes import 需补 `MessageStatus`；④ §4.6.3 4(e) 给出 `operations.ts` 补齐 `ToolCallRecord` 的 import 行；⑤ §4.6.3 4(e) 第 5 点注明 `turnCoordinatorStorage.ts` 的具名 import 需加入新函数；⑥ §4.3.4 补 `shellTuiUndetectableHintLines` 的完整定义（此前只被引用、无定义）。§0.6 增列「模式三：片段缺编译所需的最小上下文」及其判据。 |
| 0.14 | 2026-09-24 | 响应评审第 11 轮（一项阻断性编译缺口，§0.5）。**v11-B1**：`SpawnStdio = readonly ['ignore','pipe','pipe']` 不能原样传给 `child_process.spawn`——本仓库 `@types/node` 的 `StdioOptions = IOType \| Array<IOType \| "ipc" \| Stream \| number \| null \| undefined>` 只接受单个 `IOType` 或**可变**数组，`readonly` 元组两者都不满足，§4.1.2（5）的 `spawn` 调用必然编译失败、Electron typecheck 无法通过。**保留 readonly 语义**，只在唯一边界处适配：§4.1.2（5）改为 `stdio: [...prepared.spawnStdio]`，并新增「与 Node `spawn` 的类型边界」说明（为何保留 readonly、为何**不得**改类型或加断言、为何不得多点 spread）。**附带修正**：`SpawnStdio` 只有一种合法取值，T1-7 中「构造不同 `current.spawnStdio`」不可在正常类型下表达——§7.2 T1-7 拆为 T1-7-i（`shellOutputMode`，正常类型构造）与 T1-7-ii（`spawnStdio`，运行时边界构造 + 用例内标注，生产类型不放宽）。§7.6 补 v11 证明要求（typecheck + 消费点核对 + 禁止断言绕过），§0.6 模式二补「外部 API 签名兼容性」判据，§5 影响面矩阵标注唯一边界适配点。 |
| 0.13 | 2026-09-24 | **自审清理（第二轮，非评审提出）**：按 **v9-B1 的缺陷模式**（「散文提了要求，但可编译的权威片段未同步或压根没给」）全文复查，修正 5 处：① `buildPlannedShellEnvironment` 此前只有散文要求、**无定义**且签名与两处调用所需输入不匹配——§4.1.5 第 1 点补完整定义（`{ env, fingerprint }`，内部 `resolveShellEnvironment`），§4.1.2 plan/revalidate 片段改为解构使用并显式接 `environment`/`dependencySnapshot.environmentFingerprint`；② `RunShellPlanErrorCode` 扩展无权威定义——§4.3.2 补扩展后完整定义（含 `SHELL_TUI_UNDETECTABLE`）；③ §4.6.4 读取接口只给一行 `return`，与「两个分支都必须返回 `status`」不一致——补两条 return 路径完整片段；④ §4.4.2 补 electron 侧 `shellCaseIds.ts` 的 delta 片段；⑤ §4.1.3「或并入既有 `shellSpawnEnv.ts`」属定义位置不明——§4.1 开头明确唯一归属为新文件。§0.6 扩写为两轮自审（两类模式 + 各自判据）；§5 影响面矩阵同步该文件描述。 |
| 0.12 | 2026-09-24 | **自审清理（非评审提出）**：按 v10-B1 的缺陷模式（「断言要求不可能或不可达的结果」「复核清单与实际不符」）全文复查，修正 11 处同类问题：① 删除 T1-2（与 T1-11 同命令但无「python3 不可用则跳过」，在无 python3 环境必失败）；② T1-5 澄清「三例均为**不 stale** 对照组」；③ T1-8 指明必须直接调用 `executePreparedShellExecution`（`runShellExecutor.execute` 无法构造该组合）；④ T1-7b 与 T1-6 的分工保留；⑤ T6-6 与原 T6-10 合并（同夹具同断言，避免「一条通过一条失败」）；⑥ T6-12 拆为 T6-12a（有内存归属 → 分支 ②、`outcome='recovered'`）/T6-12b（无内存归属 → 分支 ③、不写 `turns`），原稿「走分支 ②」与期望值不匹配；⑦ T6-19 补可达性要求（`downgradeToolCall` 目前非导出，需改为 `export`，并给经 `cleanupStreamingResiduesOnStartup` 的回退路径）；⑧ §4.6.5 复核表更正 496 行归类（实际为 source 直接返回 terminal → `completed`，前稿误记为 `failed`）；⑨ §4.6.5「不改动」行与 §4.6.3 4(e) 对齐（仅常量引用，不并入 recover 语义）；⑩ §4.4.3 澄清「`parseShellResultData` 本次不改」专指不加类型收窄、字段解析仍要新增；⑪ §10.4 更正为已下移**两项**契约模块；§9 G6-c 明确「可观测」仅指进程内状态可查询（与 §10.8 不矛盾）；§5 影响面矩阵补 `streamingCleanup.ts` 行。 |
| 0.11 | 2026-09-24 | 响应评审第 10 轮（一项阻断性矛盾，§0.5）。**v10-B1**：T1-7 要求 revalidate 产生 `shellOutputMode` stale，但 revalidate 按设计恒以 `prepared` 回填 `current`，该 reason 永不可能出现——原稿把「契约存在性」与「回填不变量」混在一条用例里。取定**报告第一个选项（只改测试口径，不扩大运行时设计）**：T1-7 改为**单元层**直接调用 `validatePreparedShellExecution`（构造不同的 `current.shellOutputMode`/`current.spawnStdio`，断言 `reasons` 含对应键）；新增 **T1-7b**（集成层）断言 revalidate 始终回填快照值、不产生该 reason。§4.1.2 第 4 点注脚、§4.1.5 第 4 点、§6 P0-2、§7.6、§8 风险表同步为两级表述；revalidate 签名与回填行为**不变**。 |
| 0.10 | 2026-09-24 | 响应评审第 9 轮（一项阻断性实现缺口，§0.5）。**v9-B1**：`shellOutputMode`/`spawnStdio` 此前只在文字上要求冻结，三处权威接口片段未同步（ctx Pick 缺字段、`prepareShellExecution` 未显式写入、`validatePreparedShellExecution` 的 `current` 不含两字段却要求比较）。§4.1.2 重写为**唯一接口定义处**并一次给全四处——类型定义（两字段必填 + 必填理由）、`current` Pick 与两个比对项（去掉 `??` 兜底）、plan 侧 ctx 收窄与显式写入（含 `SPAWN_STDIO_NON_INTERACTIVE` 常量）、revalidate 从快照回填；§4.1.4 改为引用（消除两份声明），§4.1.5 第 2 点指向同一节；§6 P0-1/P0-2 增加编译期锚定，§7.6 新增 v9 证明要求（`typecheck:shared` + `npx tsc -p tsconfig.electron.json --noEmit`）。 |
| 0.9 | 2026-09-24 | 响应评审第 8 轮（两项确定性阻断，§0.5）。①**v8-B1**：撤销「提取共用降级函数」——核对确认 `streamingCleanup.downgradeToolCall` 与 `recoverPersistedTurn` 内联实现**四处语义不等价**（已终态+无 result、进行中+有 result、`completedAt`、已终态+有 result）；改为**只共享常量与判定**（`toolCallInterruption.ts` 导出 `INTERRUPTED_TOOL_CALL_ERROR`/`isInterruptedToolCallStatus`），策略函数在 `operations.ts` 内按 recover 语义独立实现（`degradeInterruptedToolCallsWithRecoverSemantics`），**`recoverPersistedTurn` 本轮完全不重构**；新增 T6-19 对称对照（含与启动清理的有意差异断言）。②**v8-B2**：§4.4.3 新增类型收窄小节——`resolveShellTuiNotice` 用显式类型守卫（白名单来自 shared 契约、`programs` 逐项校验 + 截断）构造受限类型，避免 `string` 直接展开进 `ShellTuiNotice` 导致 `typecheck:renderer` 失败；新增 T4-1；§5/§6 P2-1/§7.3/§7.6/§8/§9 G2/G6-b 同步。 |
