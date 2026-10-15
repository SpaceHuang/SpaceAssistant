# 会话 d961cc51：工作目录边界、越界授权与沙箱-策略分层 — 问题清单

**版本：** 0.7
**日期：** 2026-09-23
**状态：** 问题清单，待评审
**关联文档：**

- [session-ced59b41-issue-inventory-requirement.md](./session-ced59b41-issue-inventory-requirement.md)（同批会话侧问题清单；体例一致，两份互不覆盖）
- [security-approval-concurrency-limits-and-observability-requirement.md](./security-approval-concurrency-limits-and-observability-requirement.md)（安全审批并发、配额与可观测性问题清单）
- [security-policy-single-entry-requirement.md](./security-policy-single-entry-requirement.md)（安全策略单一入口）
- [tool-confirmation-top-level-design-v2.md](./tool-confirmation-top-level-design-v2.md)（确认机制顶层设计）

> **本文性质**：对会话 `d961cc51-40e6-46d1-8d3b-31b3de451ea2` 实测数据的清点，只陈述「问题 / 表现 / 原因 / 危害」四要素与可复核证据，**不含解决方案与改进建议**。文末「待决议题」「待核实项」为需另行裁定的事项。

---

## 1. 范围、基线与数据来源

### 1.1 基线

| 项 | 值 |
| --- | --- |
| 会话 id | `d961cc51-40e6-46d1-8d3b-31b3de451ea2` |
| 会话名 | 分析指定会话中Agent工具使用与安全审核机制存在的问题 |
| 运行时刻 | 2026-09-23 17:00:24 – 19:10:42 CST |
| **代码基线** | **当前 HEAD**（晚于审批并发改进 `001665df`，即该改进**已生效**） |
| 工作目录 | 本仓库工作目录（本清单不记录绝对路径） |
| 触发场景 | 用户要求读取**工作目录之外**的另一同类产品源码仓库（下称「外部参照仓库」）的源码，用作同类产品对照素材 |

> **脱敏约定**：本文涉及本机文件系统的位置一律以占位符表述 —— 「工作目录」指本仓库工作目录，「外部参照仓库」（dsh）指被读取的、位于工作目录之外的同类产品源码仓库。原文证据中的绝对路径已替换为占位符，仅保留「位于工作目录之外」这一必要的技术事实。

**基线声明的作用**：本会话运行在审批并发改进**之后**，其审批链路本身未见异常（36/36 配对、0 `unavailable`、0 超时）。因此本文**不重复** `session-ced59b41-issue-inventory-requirement.md` 第 6 章已归档的并发类问题；本文记录的是**边界与分层**类问题，且所引代码状态即为当前 HEAD 状态（非历史版本问题）。

### 1.2 数据来源

| 来源 | 内容 |
| --- | --- |
| `.agent/logs/SecurityAudit-20260923.log` | 本会话 **331** 条审计记录（`policy.decision` 259、`confirm.request` 36、`confirm.outcome` 36；全日志 826 条） |
| `sessions/d961cc51-…-20260923/events.jsonl` | 60.5 MB 事件流；本文关键场景见第 183540 行 |
| `action.session.read`（产品能力） | 会话消息 46 条（sequence 0–45） |
| **动态复现（D-11）** | 会话 `1b31aaec-1701-4622-a250-056f25cf6978`：为该会话构造的越权/受限输入实测（调用输入全部落在工作目录内、无越界、无副作用），采集其 `policy.decision` 与 `tool_result` 双层记录 |
| 代码 | 按当前 HEAD 核对 |

### 1.3 证据强度标注约定

- **【实测】**：有会话事件流或审计日志直接支持。
- **【代码推理】**：由代码事实推得，会话数据不足以直接证明。

### 1.4 一处口径说明：审批链在本会话是正常工作的

本会话 36 次裁决**全部**为 `approved`（`cause: agent-approved`），`confirm.request` / `confirm.outcome` 一一配对，`answerer` 全空、`actor` 全为 `agent`，延迟 1087 – 7030 ms。

即：**本文所述问题不是「审批没有工作」，而是「审批正常工作，但拿不到它需要的输入，也无权处理它遇到的事实」。** 凡涉及裁决结果的判断，均不构成对审批机制本身的否定。

### 1.5 术语说明：「沙箱」在本文的所指

本文所称**「沙箱」**指**应用层路径边界校验**（`electron/pathSecurity.ts` 体系：包含关系、realpath、symlink、硬链接、原子写租约等），即「限制文件工具能触及的路径范围」这一机制；**不是** OS 级隔离（进程沙箱、容器、seccomp 之类）。据此，本产品的现状是：

| 通道 | 是否存在该边界校验 |
| --- | --- |
| 文件工具（`read_file` / `list_directory` / `grep` / `write_file` / `edit_file`） | **有**（越界即抛错） |
| `run_shell` | **无**（源码自述「Shell 不是文件沙箱」，见 `electron/shell/shellPathAnalysis.ts:242`） |

因此，若语境中的「本产品还没有沙箱」指**没有 OS 级隔离、或 shell 不受路径约束**，则与本文不矛盾 —— 本文 D-1、D-6 ~ D-9 讨论的正是这套**应用层**边界校验的归属与职责问题。反之，若认为「有路径校验即算沙箱」，则须注意它**只覆盖文件工具、不覆盖 shell**，这正是 D-1 的核心事实。

---

## 2. 会话事实摘要

### 2.1 触发场景

用户在会话中要求 Agent 参考另一同类产品（外部参照仓库，下文简称 dsh）的做法。该仓库**在工作目录之外**，因而同时触达三条互不相同、且互不知情的边界：文件工具的沙箱边界、`run_shell` 的无边界、以及审批 Agent 的裁量。

### 2.2 越界场景逐笔还原

| 时刻（ts） | 调用 | 通道 | 结果 |
| --- | --- | --- | --- |
| 1790161314676 | `list_directory <外部参照仓库>` | 文件工具 | **失败**：`路径超出工作目录范围: <外部参照仓库>`（`events.jsonl:183540`） |
| 1790161314683 | 策略判定 | — | `require-confirm`（`ruleId: shell-precheck-auto-allow`） |
| 1790161314686 | `ls -la <外部参照仓库> 2>&1 \| head -40` | `run_shell` | **approved**（`cause: agent-approved`，1621 ms） |
| 其后 | 16 次同类越界只读命令（`cd <外部参照仓库> && grep/sed/ls …`） | `run_shell` | **全部 approved**，直至任务完成 |

**三条关键实测事实**：

1. 失败的 `list_directory` 与随后 17 次 shell 读取**同属一个 `stepId` / `requestId`**（`a252f3fa-545e-4cf1-9a44-9bcdf8ae86ae`）—— 即 Agent 在**同一个工具步骤内、7 毫秒后**改换通道，不是「另起一次尝试」；
2. 该会话 8 条 `list_directory` 的 `policy.decision` **全为 `auto-allow`**（`ruleId: default-read-outbound-allow`）—— 越界失败**未产生任何策略拒绝记录**；
3. 17 次 `run_shell` 均 `riskLevel: high`、均经 `require-confirm`、均由审批 Agent 放行，且**线索包中不含任何路径字段**（见 D-2）。

### 2.3 由此确立的问题面

一句话概括：**同一目标（工作目录外的目录），换一个通道即从「终局拒绝」变为「逐次可批」；而审批 Agent 从未拿到「越界」这个事实，用户也从未获知该边界实际由哪一层守护。**

---

## 3. 问题一：工作目录边界由三层各自执行，彼此互不知情

### D-1 同一「工作目录之外」的边界，在三条通道上由三个不同的裁判执行【实测+代码推理】

**问题**：一条「工作目录之外」的边界，在三条通道上由**三个不同的判定者**执行，其判据、可申诉性与是否留痕各不相同；三者之间无任何事实传递。

**表现**：

| 通道 | 判定者 | 判据 | 结果 | 是否进入策略审计 |
| --- | --- | --- | --- | --- |
| `read_file` / `list_directory` / `grep` | **执行层沙箱** | `resolveSafeReadPath`（`electron/pathSecurity.ts:74`）抛错 | `success: false`，**终局** | ❌ 策略层此前已判 `auto-allow`，**无拒绝记录**【实测】 |
| `write_file` / `edit_file` | **策略快通道** | `evaluateFileToolAutoApproval` → `resolveSafePathReal` 抛错被 catch → `reasonCode: 'sensitive_path'`（`electron/tools/writeFileAutoApproval.ts:75-76`） | 转 `require-confirm`（**可申诉**） | ✅ 有 `autoApproveFallback`【代码推理】 |
| `run_shell` | **审批 Agent** | 模型读命令字符串（线索包无路径字段，见 D-2） | 视模型当次叙述而定 | ✅ 但**无越界事实**【实测】 |

会话 `d961cc51` 的对照【实测】：`list_directory <外部参照仓库>` 失败时，策略层**没有任何拒绝决策** —— 该会话 8 条 `list_directory` 的 `policy.decision` 全为 `auto-allow`。即越界事实**完全未进入策略视野**。

**原因**：

1. **`ShellConfig.confirmOutsideWorkDir` 字段名语义为「确认」（策略语义：可配置、可申诉），但无生产消费方**：全仓库仅测试 fixture 引用（`src/shared/visionModelRouting.test.ts:68`），实际生效的是 `resolveSafePath` 的 `throw`（沙箱语义：不可配置、不可申诉）。意图为策略、落地为沙箱，字段空留在原地。
2. **源码自述 shell 不受文件沙箱约束**：`electron/shell/shellPathAnalysis.ts:242` 的 violation 文案即「此命令可能访问工作目录外的文件；**Shell 不是文件沙箱**」。
3. **`resolveSafeReadPath` 的沙箱异常为终局**，不产生可申诉结果；而它承载的恰是「要不要授权」这类本应可裁决的判断。

**危害**：

- **同一目标换个通道即换待遇**，且用户无法从任何界面或数据获知该边界实际由哪一层守护；
- **read 通道上，策略层与用户均不知道越界发生过**：无策略记录，界面仅显示「列出目录失败」；
- 沙箱失败与策略拒绝在**错误码与措辞上不可区分**（见 D-3），用户与模型均无法分辨「换个做法可解决」与「必须授权」。

### D-2 越界事实既未进入策略层，也未进入审批线索包【实测+代码推理】

**问题**：shell 链路**已经算出**「命令可能访问工作目录外」，但该事实不进入 `ContentFacts.signals`，因此既不进入策略规则，也不进入审批线索包；审批 Agent 只能从线索包 `[命令]` 的**自由文本**里推断路径。

**表现**：

| 工具 | descriptor 声明 | 产出信号 |
| --- | --- | --- |
| `run_shell` | `extractors: ['command-sequence']`（`electron/confirmation/extractors/extractors.test.ts:163`、`policyIntegration.test.ts:13`） | 仅 `command-sequence`，**无 `path-target`** |
| `read_file` / `write_file` | `extractors: ['path-classifier']`（`extractors.test.ts:174`） | `path-target` + `zone`（含 `outside-workdir`） |

**原因**：

1. `electron/shell/shellPathAnalysis.ts:240-245` 已产出 `outsideWorkDirRisk = true` 与 `OUTSIDE_WORKDIR_RISK` violation，但其流向仅 **hints 与日志**：`electron/shell/shellToolLoopHelpers.ts:63`（取 `analysis.shellSecurityHints.outsideWorkDirRisk`）→ `electron/shell/shellAgentLogger.ts:33`（作为日志字段）。该事实**未回填 `ContentFacts.signals`**。
2. `electron/confirmation/extractors/runExtractors.ts` 的 `EXTRACTOR_IMPLEMENTATIONS` 中，路径事实仅由 `'path-classifier'` 产出，而 `run_shell` 的 descriptor 未声明它；`'command-sequence'` 实现（`electron/confirmation/extractors/commandSequenceExtractor.ts`）只产出子命令序列与连接符，**不导出路径 literal**。
3. `electron/confirmation/agentChannel.ts` 的 `deriveClueExtras` 从 `facts.signals` 提取线索，其 `targetPath` 分支只认 `kind === 'path-target'`；shell 无该信号，故线索包无路径字段，仅有 `command` 文本。
4. `buildPathSignal`（`electron/confirmation/extractors/pathClassifier.ts:74`）调用的是**非 symlink 版** `classifyPath`；已实现的 `classifyPathWithSymlink`（realpath 后再分类）未被该路径使用（见 V-3）。

**危害**：

- **裁决不可复现**：审批 Agent 对「是否越界」的判断只能依赖模型的文本理解。直接后果是同一目标、同一性质的命令在不同会话中得到相反结论 ——
  - 会话 `ab761758`（ts 1790117427015）**拒绝**：「命令引用了工作目录外的路径（某本机绝对路径），信息不足无法收窄，按信息不足拒绝」；
  - 会话 `d961cc51`（`a252f3fa` 组 17 次）**批准**：「命令序列仅执行 git log/date 等只读查看操作…与声明任务的只读分析需求相符」。
- **本可成为策略层一等事实的越界信号，却无法被任何规则消费**：`PathZone` 已定义 `'outside-workdir'`，`memoryEligibility` 亦已对其作出反应（返回 `eligibility: 'none'`），但 `run_shell` 通道根本不产出该信号。

### D-3 沙箱的「无法解析」被翻译为策略拒绝码，两类失败同形【代码推理】

**问题**：写通道把沙箱抛出的越界异常**无差别**翻译为策略码 `sensitive_path`，使「沙箱边界（换做法可解决）」与「策略敏感位置（必须授权）」在对外契约上不可区分。

**表现**：`evaluateFileToolAutoApproval` 的三种不同成因返回**同一** `reasonCode: 'sensitive_path'`：

| 成因 | 性质 |
| --- | --- |
| `resolveSafePathReal` 抛错（`writeFileAutoApproval.ts:75-76`） | **沙箱**（词法越界 / realpath 后越界） |
| `isSensitivePath(...)` 命中（`writeFileAutoApproval.ts:26-32`） | **策略**（敏感目录清单） |
| 缺少文件路径（`writeFileAutoApproval.ts:68`） | **参数错误** |

该字段经 `electron/confirmation/toolCallGate.ts:287` 进入 `result.autoApproveFallback.reasonCode`，进而进入确认卡与模型上下文。

**原因**：

- `electron/pathSecurity.ts` 抛的是通用 `Error('路径超出工作目录范围')`，**不携带机器可判的类别**；
- `electron/tools/writeFileAutoApproval.ts:75-76` 的 catch **不区分异常成因**，一律返回 `reasonCode: 'sensitive_path'`，而 `reason` 文案却是「路径超出工作目录范围」（沙箱语义）——码与文案彼此矛盾。

**危害**：

- 用户与模型**无法分辨**「换个做法可解决」与「必须授权」，二者被折叠为同一码；
- 该缺陷与 `session-ced59b41-issue-inventory-requirement.md` 的 **A-2**（能力层错误码无归因类别）属**同一类病在另一子系统的复现**：失败语义不可区分；
- 审计与统计层面无法据此区分「沙箱失败」与「策略拒判」，两类事件在数据上被合并。

---

## 4. 问题二：越界访问的授权无载体

### D-4 用户指令不构成授权凭据，审批侧无权据其放行【实测+代码推理】

**问题**：当用户指令本身要求访问工作目录之外的资源时，「这是用户要求」这一事实**没有任何结构化通路**可以成为授权凭据；审批侧的授权维度对其**在制度上不可用**。

**表现【实测，会话 d961cc51】**：`a252f3fa` 组 17 次越界只读访问**全部放行**，但放行理由均为「只读 / 与声明任务相关」，**无一条**援引「用户要求读取该目录」作为授权；且放行**不产生任何记忆**，其后同类访问仍需逐次裁决。

**原因**：

1. **审批 Skill 明文排除授权**（`electron/skills/bundled/securityApprovalSkill.ts`）：「本审查器运行在**无人自动化上下文**：真实人类不在场，authorization 只能输出 unknown 或 low」，且「『已声明的任务』只证明动作与任务相关，**不构成对 high / critical 动作的授权**」。装配侧 `electron/toolChatLoop.ts:2432` 亦按 `confirmLane === 'automation' ? 'low' : 'high'` 截断。
2. **同一 Skill 又规定越界不抬高风险**：「**工作目录之外**：路径或资源在工作目录之外本身**不抬高风险等级**，按敏感位置与动作实质判断。」→ 在现行裁决模型中，**「越界」不是风险维度，也不是授权维度**。
3. **裁决不产生记忆**：`src/shared/policy/memoryEligibility.ts` 对 `answererKind !== 'user'` 直接返回 `eligibility: 'none'`；对含 `path-target` 且 `zone ∈ {outside-workdir, system-dir, sensitive-file}` 的信号亦返回 `'none'`。
4. **承载「路径域授权」的载体已存在但不可达**：`src/shared/confirmation/types.ts:320` 已定义 `{ kind: 'path'; path: string; level: 'file' | 'directory' | 'zone' }` 缓存条目；受第 1、3 条约束，该形态在实践中**无法生成**。

**危害**：

- 用户的越界意图**无法表达为授权**，只能依赖裁决模型当次叙述 → 同一目标在不同会话得到相反结论（见 D-2 危害）；
- 用户与系统对「什么需要授权」的认知**不一致**：用户以为「工作目录」是安全边界，实则边界只存在于沙箱（且只管文件工具），系统从未告知此事；
- 对话层面表现为「产品无法接受『这次访问是我要求的』这一输入」——该输入在数据模型中无对应字段。

### D-5 同一目标可无限重试，审批准入退化为概率门【实测+代码推理】

**问题**：审批裁决**无记忆**，叠加「重试不受惩罚」的设计条款，使同一目标可被反复尝试并逐次独立裁量；单次裁决即使很少误判，多次重试后「最终通过」的概率趋近 1。

**表现【实测】**：

- 会话 `d961cc51`：`a252f3fa` 组 **17 次**同性质越界命令（`cd <外部参照仓库> && grep/sed/ls …`）逐次重新裁决、逐次通过，每次 1.2 – 7.0 s；
- 会话 `ab761758`：`git mv Users docs/develop/designs` 在 `16b4ec8d` 组（**3 次 `unavailable`**）与 `4c9ca8c6` 组（**1 次 `agent-deny`**）下共尝试 **4 次**，最终由替代路径推进。

**原因**：

1. **I3：裁决永不落缓存** —— `AgentChannel` 的返回值类型上即不含 memory（`electron/confirmation/agentChannel.ts` 头部注释「不产生 memory（I3：裁决永不落缓存，返回值类型上就不含 memory）」）；`memoryEligibility` 对非 `user` 回答者返回 `'none'`。
2. **Skill 明文规定重试不可疑**：securityApprovalSkill「防误拒」节 —— 「**重试不可疑**：沙箱或权限拒绝后的重试本身不可疑，评的是动作自身的内在风险」。该条款本意为避免误拒，但同时移除了对反复试探的**收敛压力**。
3. **通道等价性缺失**：`run_shell` 是当前唯一不设文件沙箱边界的通道（见 D-1），故它天然成为「换一条路再试」的出口。

**危害**：

- 审批准入的可预测性下降：**同一意图的最终结果取决于重试次数，而非风险本身**；
- 反复重试带来**可用性成本**：本会话仅审批等待即累计 75.5 s（36 次，均值 2.1 s），其中 `a252f3fa` 组 17 次几乎全部为同性质只读命令；
- 在此机制下，「越界」这类**用户本意即允许**的访问，其通过与否不取决于用户意图，而取决于模型当次如何叙述命令。

---

## 5. 问题三：沙箱与策略的职责混装（模块架构问题）

> **本节主旨**：`pathSecurity` 及其同源模块不是「沙箱 + 策略」的分层结构，而是**把策略写进了沙箱** —— 下面三节（D-6 / D-7 / D-8）是同一条架构问题的三个断面：
>
> - **D-6 混装**：沙箱原语内建了策略语义（额外信任根、读宽写严），并让沙箱替策略做了**终局裁决**；
> - **D-7 旁路**：挂在其名下的 `writeFileAutoApproval.ts` 实为策略，却以沙箱形态**绕过策略引擎**执行；
> - **D-8 错位**：沙箱的 22 项功能**全部挤在策略层之前**，导致策略层缺输入、执行层重复校验。
>
> 一句话定性：**沙箱只应回答「能不能安全解析到目标」，策略只应回答「这个目标要不要授权」；现状是两者混在同一层、同一函数、同一异常通道里。** 这才是「用代码写死策略」的准确形态 —— 不是启发式判定本身有问题，而是**判定站错了层**。

### D-6 `pathSecurity` 的判定点归属：沙箱本体干净，但内建了策略语义【代码推理】

**问题**：`electron/pathSecurity.ts` 的判定点绝大多数属沙箱语义（边界包含、链接、类型），但其中**混入了策略语义**（额外信任根、读宽写严），且策略部分与沙箱部分共用同一函数体与异常通道。

**表现（逐判定点归属）**：

| # | 判定 | 位置 | 性质 |
| --- | --- | --- | --- |
| 1 | 词法包含校验（防 `..`） | `pathSecurity.ts:15` | **沙箱** |
| 2 | realpath 后包含校验 | `pathSecurity.ts:22` | **沙箱** |
| 3 | 空路径 → 抛「路径超出工作目录范围」 | `pathSecurity.ts:52` | **语义污染**（参数错误伪装为越界） |
| 4 | 绝对路径包含校验 | `pathSecurity.ts:61` | **沙箱** |
| 5 | 绝对路径 realpath 复查 | `pathSecurity.ts:66-71` | **沙箱** |
| 6 | **`extraRoots` 机制** | `pathSecurity.ts:74` | **策略** ⚠️ |
| 7 | base 非符号链接、且为目录 | `pathSecurity.ts:126-131` | **沙箱** |
| 8 | 逐段 lstat、拒 symlink | `pathSecurity.ts:170` | **沙箱** |
| 9 | 目标须为普通文件 | `pathSecurity.ts:177` | **沙箱**（类型事实部分属前置） |
| 10 | 拒硬链接（`nlink > 1`） | `pathSecurity.ts:180` | **沙箱** |
| 11 | 路径组件不是目录 | `pathSecurity.ts:194` | **沙箱** |
| 12 | 「路径组件无法判定」/「工作目录不可用」 | `pathSecurity.ts:166, 128` | **环境错误**（非安全裁决） |

**比例口径（两种算法，结论一致 —— 混装）**：

| 口径 | 范围 | 沙箱的活 | 策略的活 |
| --- | --- | --- | --- |
| **狭义** | 仅 `pathSecurity.ts` 本体 | **约 10/12（~85%）** | 第 6 项 `extraRoots`（策略）+ 第 3 项（语义污染） |
| **广义** | 连同挂在其名下的 `writeFileAutoApproval.ts`（同源、互相 import、同属「路径安全」这套判定） | **约一半** | **约一半，且这一半全部绕过策略引擎** |

**关键不在比例，而在混装的方式**：策略部分不是「在沙箱旁边独立存在」，而是**长在沙箱函数体内、复用沙箱的异常、并且不经过策略引擎**（详见 D-7）。这也是为什么单独看 `pathSecurity.ts` 会得到「几乎全是沙箱」的印象，而把消费方算进来后，策略成分立刻占了一半 —— 因为策略被吸进了沙箱的调用面，而不是留在策略层。

**原因（混装的具体形态）**：

1. **`extraRoots` 是策略决策，却作为沙箱原语的参数**：其唯一实际取值硬编码于调用点 —— `[path.join(ctx.userDataDir, 'skills')]`（`electron/tools/builtinExecutors.ts:206 / 423 / 1228`）。沙箱原语因此**知道了「skills」这个概念**；且该参数意味着「读得到什么」取决于调用方，已超出「给定 base、判定是否逃逸」的纯函数形态。
2. **「读宽写严」的分级被内建为沙箱属性**：`resolveSafeReadPath` 的注释自述「读类工具允许的附加只读根；…**不影响写入路径策略**」——读/写风险分级属策略判断，现已成为沙箱的固有属性。
3. **策略不经策略引擎**：上述策略语义（额外信任根、体量阈值、敏感清单）**不产生 `policy.decision`、不进入规则集评估**，而是在引擎之外旁路执行（见 D-7）。

**危害**：

- 策略层无权决定「哪些根可读」，该决定固化为**代码常量**，用户不可配置、不可审计（无 `policy.decision` 记录）；
- 沙箱原语承载了业务概念（skills），使其难以复用于其他 base，也使「沙箱失败」与「策略拒绝」在同一出口混合。

### D-7 三处「策略穿着沙箱的衣服」【代码推理】

**问题**：有三处代码在形态上像沙箱、在职责上是策略，其中一处直接扮演策略引擎的快通道实现。

**表现**：

| # | 位置 | 表面形态 | 实际职责 |
| --- | --- | --- | --- |
| ① | `electron/tools/writeFileAutoApproval.ts`（`import { resolveSafePathReal } from '../pathSecurity'` + `import { isSensitivePath } from '../shell/shellSensitivePaths'`） | 依赖沙箱函数 | **策略快通道实现**：产出 `autoEvaluator` 的 `approve/reject` 结论 |
| ② | `writeFileAutoApproval.ts:75-76` 的 catch | 沙箱异常处理 | **沙箱失败被翻译为策略码** `sensitive_path` |
| ③ | `electron/shell/shellSensitivePaths.ts`（`getBuiltinSensitivePrefixes` / `isSensitivePath`） | 位于 shell 模块 | **策略清单真相源**，被三处独立消费且参数不一致 |

**①的详细事实**：`evaluateFileToolAutoApproval` 消费方为 `electron/confirmation/toolCallGate.ts:287`，产出 `fileAutoApprove` 布尔，喂入 `policyEngine` 的 `autoEvaluator` 闭包：

```
policyEngine 第 4 步：if (deps.autoEvaluator) { if (res.approve) return autoAllow(...) }
                                否则 → requireConfirm(answerer: 'agent')
```

其判定内容（`isSensitivePath` 命中、`contentBytes > autoApproveMaxBytes`、`editCharSpan > autoApproveMaxEditChars`）**全部为策略判断**，却：

- 不参与规则集评估（不走向 `resolvePolicyRules`）；
- 不产生 `policy.decision` 审计（仅以 `autoApproveFallback` 形式附加于结果）；
- 不产出 `path-target` 事实（其路径分类能力被 `catch` 吞掉）。

**③的详细事实（三处消费、参数不一致）**：

| 消费方 | 传入参数 | 位置 |
| --- | --- | --- |
| 策略层环境事实 | `getBuiltinSensitivePrefixes(args.userDataDir)` —— **未传** `customSensitivePrefixes` | `electron/confirmation/toolCallGate.ts`（`env.sensitivePaths`） |
| 写工具快通道 | `isSensitivePath(abs/rel, userDataDir, customSensitivePrefixes)` —— **传了** | `electron/tools/writeFileAutoApproval.ts` |
| shell 路径分析 | `customSensitivePrefixes` —— **传了** | `electron/shell/shellPathAnalysis.ts` |

即「用户自定义的敏感目录」在策略层的环境事实中**不可见**，仅在写工具快通道与 shell 分析中生效（口径不一致，见 V-4）。

**危害**：

- **策略引擎被旁路**：一份策略判断在执行链路中直接产生放行/不放行结论，绕过了规则集、审计与「单一入口」原则，使用者无法从 `policy.decision` 观察到它；
- **同一清单三处维护、参数不一**，改一处不改另一处即产生**静默不一致**；
- 沙箱失败与策略拒绝被折叠（见 D-3），依赖此码的上层无法区分处置方式（换做法 vs 申请授权）。

### D-8 沙箱功能的执行位置归属：哪些应在策略层之前、哪些应在之后【代码推理】

**问题**：`pathSecurity` 体系已实现的沙箱功能数量完整（22 项），但它们**全部挤在策略层之前**。其中一部分本应**前置**（产出事实供裁决），另一部分本应**后置**（约束已放行的执行）；混在一位导致策略层缺输入、执行层又重复校验。

**判据（两条）**：

- **前置 = 回答「这次要动的是什么」**：产出事实供裁决，可申诉、可配置，失败应表现为「越界/敏感」这类**事实**；
- **后置 = 回答「动的时候别出岔子」**：约束执行，机制故障，**不可授权、不可申诉**，失败应表现为竞态/技术错误。

**表现：应后置的现有实现（已具备，功能完整）**

| # | 功能 | 位置 |
| --- | --- | --- |
| 1 | 临时文件 + `O_EXCL` + `O_NOFOLLOW` | `electron/safeAtomicWrite.ts` |
| 2 | 完整写入 + `fsync` | `writeAllBytes` |
| 3 | 新建走 `link`、覆盖走 identity 校验后 `rename` | `safeAtomicWrite` |
| 4 | 提交后 identity + `nlink` 复验 | `safeAtomicWrite` |
| 5 | `mkdir` 后重验中间路径无 symlink | `assertNoSymlinkAlong` |
| 6 | 遗留临时文件清理 | `cleanupSafeWriteTemps` |
| 7 | Windows 瞬时锁有界重试 | `withTransientLockRetry` |
| 8 | 文件身份捕获/比对 | `captureFileIdentity` / `identitiesMatch` |
| 9 | 路径读写租约（读写互斥 / deleting 态） | `electron/writeSafety/pathLeaseRegistry.ts` |
| 10 | 多路径按序加锁（防死锁） | `acquireWrites` |
| 11 | 跨会话写冲突检测 | `electron/writeSafety/toolPathLease.ts` |
| 12 | 调度资源键（串行屏障） | `builtinExecutors.ts:553` `workspaceResourceKeys` |

**表现：应前置的现有实现（多数缺失）**

| 目标（前置产出） | 现状 |
| --- | --- |
| 路径解析与规范化 | ⚠️ 已做，但结果**不外露为事实** |
| 区域归属（`zone`） | ❌ 不存在于 `run_shell` 通道；文件工具虽产出，但沙箱的 `throw` 使其**不进策略**（见 D-2） |
| symlink 解析后的真实目标 | ⚠️ `classifyPathWithSymlink` 已实现，但 `buildPathSignal` 调的是**非 symlink 版** `classifyPath`（见 V-3） |
| 敏感路径匹配 | ⚠️ 已是 `env.sensitivePaths`，但**口径不一致**（见 D-7 ③、V-4） |
| 「允许访问的根集合」 | ❌ 硬编码为调用点常量（`[userDataDir/skills]`），非策略输出 |
| 对象类型（file / dir / missing / special） | ⚠️ 信息存在，但不作为事实外露 |

**表现：四处需拆开的灰区**

| 项 | 现状 | 归属冲突 |
| --- | --- | --- |
| 空路径 | `resolveSafeWorkDirPath:52` 抛「路径超出工作目录范围」 | 参数错误伪装为越界 → 应前置为「输入无效」事实，与安全裁决无关 |
| 目标须为普通文件 | `resolveSafeWriteTarget:177` 单一 `throw` | 应拆为：前置为**类型事实**，后置为**特殊文件拒绝** |
| 逐段 lstat 拒 symlink | `resolveSafeWriteTarget:170` 前置即 `throw`，不可申诉 | 应拆为：前置**解析真实目标（事实）**，后置**拒绝链接（防竞态）** |
| 敏感路径判据源 | 三方各自调用 `isSensitivePath`，参数不一致（见 D-7 ③） | 应由策略层**唯一持有**，向前置与后置分发 |

**原因（一条可直接观察的事实）**：`resolveSafeWriteTarget` 的全部检查都发生在**策略裁决之前**，但它返回 `targetPath` 到 `safeAtomicWrite` 真正落盘之间存在时间窗口；代码**自己承认**这一点 —— `safeAtomicWrite` 在 `mkdir` 之后**又**执行一次 `assertNoSymlinkAlong`，并额外以 `expectedIdentity` 比对身份。即：架构上已经知道需要两层，只是前置函数把后置该做的检查也做了一遍，造成职责重叠与双重校验。

**危害**：

- **策略层缺输入**：越界、敏感等事实在 `run_shell` 通道根本不存在，在文件工具通道也被 `throw` 吞掉，规则集无从消费（与 D-1、D-2 同源）；
- **执行层重复劳动**：同一形状的 symlink/身份校验在前置与后置各做一次，两处判据一旦分叉即出现「前置通过、后置拒绝」的不可解释失败；
- **失败性质不可辨**：后置层（TOCTOU、竞态、原子性）的失败本应表述为「机制/技术问题、可换做法重试」，现与策略拒绝**走同一错误通道**，用户只会看到「被拒绝」；
- **可配置性丢失**：凡落在前置 `throw` 上的判定（越界、类型、链接）均**不可配置、不可申诉**，而其中「越界要不要问用户」正是策略问题（对照 `ShellConfig.confirmOutsideWorkDir` 这一空置字段）。

---

## 6. 问题四：策略层缺输入，执行层越位代裁

> **本节主旨**：若「越界只读访问是否放行」这一判断应由**策略层**承担（Q-1 已给出该方向），则须满足两个前提，而现状**两个都不成立**：
>
> - **D-9 缺输入**：策略层拿不到「本次调用是否只读」（`run_shell` 的 `actionClass` 恒为 `execute`）与「本次调用是否越界」（D-2）这两个内容事实 → 本该由规则确定性完成的分级，被转移给审批模型作文本推断；
> - **D-10 越位代裁**：即便策略层**已作出判决**（`auto-allow`），**执行层仍可凭自身校验推翻它**，且该否决**不出现在策略记录中** → 策略层的判决权被分割，用户即便按 Q-1 方向改策略也无效。
>
> 二者是同一病灶的两面：**策略层因缺输入而判不动，执行层因握有校验而越权代裁。**

### D-9 策略层缺少「只读性」事实：`run_shell` 的 `actionClass` 恒为 `execute`【实测+代码推理】

**问题**：策略引擎**已内建**「只读即放行」规则（`default-read-outbound-allow`），但其判据是**工具静态声明的 `actionClass`**，而非本次调用的内容。`run_shell` 的 `actionClass` 恒为 `execute`，因此该规则对 shell 通道**永不适用**：`ls`、`git log`、`grep` 与 `rm -rf` 在策略层得到**完全相同**的处置。

**表现【实测】**：

| 工具 | `actionClass`（descriptor 声明） | 策略层处置 | 本会话实测 |
| --- | --- | --- | --- |
| `read_file` / `list_directory` / `grep` | `read` | `auto-allow`（`ruleId: default-read-outbound-allow`） | 46 + 8 + 116 = **170 条全部 auto-allow** |
| `run_shell` | **`execute`（恒定）** | `require-confirm`（`ruleId: shell-precheck-auto-allow`） | **33 条全部 require-confirm** |

全日志口径：`run_shell` 共 **73** 次 `policy.decision`，`actionClass` **无一例外为 `execute`**（`read` 出现 0 次）。

**原因**：

1. 策略引擎的只读分支（`src/shared/policy/policyEngine.ts:279-281`）：

   ```ts
   if (facts.actionClass === 'read' || facts.actionClass === 'outbound') {
     return autoAllow('default-read-outbound-allow', facts)
   }
   ```

   其输入是 `facts.actionClass`，即 **descriptor 的静态声明**，不是内容判定。
2. `run_shell` 的 descriptor 为 `{ actionClass: 'execute', riskLevel: 'high', extractors: ['command-sequence'] }`（`electron/confirmation/extractors/extractors.test.ts:163`、`electron/confirmation/shellConfirmationAdapter.ts:59`），**无法表达「本次命令是只读的」**。
3. `command-sequence` 提取器（`electron/confirmation/extractors/commandSequenceExtractor.ts`）产出 `verb` / `args` / `signature` / `connector`，**不产出只读性**判定；全仓库无 `readOnly` / `isReadOnly` 之类的「命令只读性」事实。
4. 因此 shell 的只读性判断**事实转移给了审批 Agent**，而它只能从命令文本推断（与 D-2 同一病灶）。

**危害**：

- **无法实施「只读放行」**：`ls`、`git log`、`git status` 等纯只读侦察一律必须过审批（本会话 33/33）；
- **也无法实施「破坏性从严」的差异化**：`rm -rf` 与 `git log` 在策略层同档（均为 `execute`），策略无从分级；
- 该缺失使审批 Agent 实际承担了**本应由策略层承担的只读性判定**，而其判据是模型的文本理解 → 同一诉求在不同会话得到相反结论（见 D-2 危害）。

**同一诉求在两条通道上的镜像失效【实测+代码推理】**：

以「读取工作目录之外的只读内容」这一诉求为例：

| 通道 | 策略层处置 | 边界层处置 | 诉求是否达成 |
| --- | --- | --- | --- |
| 文件工具（`read_file` / `list_directory`） | **已放行**（`actionClass = 'read'` → `auto-allow`） | **边界校验抛错拦下**（终局，见 D-1） | ❌ **策略对了，边界层越权拒绝** |
| `run_shell` | **要求确认**（`actionClass = 'execute'`，无从识别只读） | 无边界校验 | ✅ 达成，但**靠审批模型裁量**（不可复现） |

即：同一诉求在两条通道上的**失效点恰好互换** —— 文件工具是「策略已放行、边界层越权」，shell 是「边界层缺位、策略无从识别只读」。这恰说明该判断**应落在策略层**（见 Q-1 方向），且策略层必须**同时**拿到「越界性」（D-2）与「只读性」（本节）两个事实。

**补充：敏感目录维度是三者中唯一已有输入的**。`env.sensitivePaths` 已作为策略环境事实存在（`electron/confirmation/toolCallGate.ts` 经 `getBuiltinSensitivePrefixes` 注入），故「不涉及敏感目录」这一半判断策略层**现在就能做**；缺的是「只读性」（本节）与「越界性」（D-2）。但该清单存在口径不一致问题，见 D-7 ③、V-4。

### D-10 执行层越过策略层否决其判决：「判决已放行、执行否决、且审计看不见」【实测+代码推理】

**问题**：文件工具链路上，**策略层与执行层各有一个判决权，且后者的否决优先**。执行层（`pathSecurity` 的边界校验）**不消费策略层的判决结果**，凭自身校验作出**终局否决**；该否决既不落入 `policy.decision`，也不可申诉。结果是：策略层说「放行」，执行层说「不行」，**以执行层为准，而策略层对此一无所知**。

**表现：同一次调用的双重判决【实测，毫秒级】。**

以会话 `d961cc51` 中那次越界 `list_directory` 为例，两层判决在**同一毫秒量级内相继发生、结论相反**：

| 时刻（ts） | 层 | 记录 | 判决 |
| --- | --- | --- | --- |
| 1790161314537 | 工具调用 | `list_directory <外部参照仓库>` 发起 | — |
| **1790161314675** | **策略层** | `policy.decision = auto-allow`，`ruleId: default-read-outbound-allow`，`riskLevel: low` | **放行** |
| **1790161314676** | **执行层** | `tool_result: { success: false, error: "路径超出工作目录范围: <外部参照仓库>" }`（`events.jsonl:183540`） | **否决** |

相隔 **1 毫秒**：策略层刚判定放行，执行层即以「越界」为由否决，**以执行层结论为最终结果**。

**关键实测事实**：这次否决**未产生任何拒绝类策略记录** —— 本会话 **8** 条 `list_directory` 的 `policy.decision` **全部**为 `auto-allow`（时间戳见下），**包括这一次（1790161314675）**：

```
ts=1790154042012  auto-allow   ts=1790154981368  auto-allow
ts=1790154993435  auto-allow   ts=1790155144902  auto-allow
ts=1790155144916  auto-allow   ts=1790155153902  auto-allow
ts=1790160800479  auto-allow   ts=1790161314675  auto-allow  ← 即被否决的那一次
```

即：**审计上，这次越界访问「被策略允许了」；事实上，它根本没执行。** 审计记录与真实结果**相反**，且没有任何一条记录说明它曾被否决。

**原因：策略判决与执行校验之间不存在契约关系。**

1. **策略判决不是执行层的输入约束**：`toolCallGate` / `policyEngine` 产出的 `decision`（`auto-allow` / `require-confirm` / `deny`）用于**决定是否放行进入执行**；一旦放行，执行层即独立行事，**判决结果不再传递给它**，也无「策略已放行则不得以策略事由否决」的约定。
2. **执行层自行再做一次判断**：`electron/tools/builtinExecutors.ts:206 / 423 / 1228` 在**执行体内**直接调用 `resolveSafeReadPath(...)`，其抛错被就地捕获并转为工具失败：

   ```ts
   try {
     abs = await resolveSafeReadPath(ctx.workDir, rel, [path.join(ctx.userDataDir, 'skills')])
   } catch (e) {
     return { success: false, error: `路径超出工作目录范围: ${rel}`, duration: Date.now() - started }
   }
   ```
3. **该否决是终局、且与策略拒绝同形**：错误文案「路径超出工作目录范围」未携带任何来源标记（不区分「策略不同意」与「执行层越权否决」），用户与模型无从分辨（与 D-3 同类）。
4. **根因**：`pathSecurity` 同时握有「事实产出」与「授权判断」两种能力（见 D-6），因此它**有能力也有机会**做出策略性的否决 —— 这是 D-6「职责混装」在行为层面的直接后果。

**与 D-8 的区别（两者并存、不重复）**：

| 条目 | 关注点 | 一句话 |
| --- | --- | --- |
| **D-8** | 检查的**时机**（前置 / 后置） | 沙箱的 22 项功能全挤在策略层之前，后置该做的事被提前做了 |
| **D-10** | 判决权的**归属**（谁说了算） | 执行层能否推翻策略层的判决 —— 能，且不留痕 |

**危害**：

- **判决权分裂**：同一调用有两个判决者，后者的否决优先，且**第二个判决不在策略视野内**。`policy.decision` 显示「已放行」，真实结果却是失败 —— 审计记录与事实**相反**，比 D-2 的「缺记录」更严重；
- **策略不可配置，且改策略无效**：这是 Q-1 方向的**决定性障碍** —— 若按 Q-1 让策略层放行越界只读访问，**只改策略层无任何效果**：策略层**现在就已是 `auto-allow`**，拦下它的是执行层。必须同时约束执行层，否则用户诉求照样落空；
- **用户与模型无法分辨**：错误文案读起来像边界声明，但无法得知这是「执行层越过策略层」还是「策略层不同意」，处置方式（换做法 / 申请授权 / 改配置）因此无从判断；
- **误导审计复盘**：任何基于 `policy.decision` 统计「越界访问是否被允许」的分析都会得出**相反结论**。本文第 2 章所据的那次失败，在审计中呈现为一次「获准的只读访问」。

### D-11 横向排查：越位代裁不是孤例，而是「边界校验散落在执行层」的系统性表现【实测+代码推理】

**排查判据**：沿用 D-10 —— **执行器内是否存在「安全性质的回退」**，即策略层已判 `auto-allow`（或已放行）后，执行器仍凭自身校验作出终局否决、且该否决不产生对应策略记录。

**排查范围**：`electron/tools/` 下全部执行器（15 个 `ToolExecutor` 实现）+ 各 lane 的通道。

**排查方法（两轮）**：

1. **静态排查**：逐执行器检索「安全性质回退」——即直接调用 `pathSecurity` 系列、或自读安全配置（`sensitive` / `wikiConfig`）后返回 `success: false` 的位置；
2. **动态复现**：对可触发的通道，构造调用并比对**同一次调用的双层记录**（`policy.decision` 与 `tool_result` 的毫秒级时序）。复现所用输入全部**落在工作目录内、无越界、无副作用**（详见下文「本轮实测」）。

> **方法论教训（记以备查）**：本轮曾先尝试在历史日志中搜索现成案例（检索 `路径包含符号链接` 等文案），但检索结果**全部是假阳性** —— 命中来自**执行检索的会话自身**读取源码时，文件内容中的字符串被写入其 `events.jsonl`。即：**"在日志里搜证据"在本仓库不可靠，因为分析会话自身的读取行为会污染检索结果。** 动态复现（主动构造 + 双向比对）是唯一可靠路径。

**结果：存在越位代裁的通道**

| # | 通道 | 策略层判决 | 执行层否决点 | 性质 |
| --- | --- | --- | --- | --- |
| 1 | `read_file` / `list_directory` / `grep` | `auto-allow`【实测】 | `resolveSafeReadPath` 抛错 → 「路径超出工作目录范围」（`builtinExecutors.ts:208 / 425 / 1233`） | **路径边界**（D-10 本体，已实测） |
| 2 | `write_file` / `edit_file` | `auto-allow`【实测】 | `resolveSafeWriteTarget` 抛错 → `writePathErrorMessage`（`builtinExecutors.ts:643 / 773`）：**路径含符号链接 / 硬链接目标 / 写入目标非普通文件 / 路径组件不是目录** | **路径边界**（实测覆盖 symlink 与"非普通文件"两分支；硬链接分支同函数未单独实测） |
| 3 | `write_file` / `edit_file` | （环境未启用，见下） | `wikiRawWriteBlocked` → `ERR_WIKI_RAW_READONLY`（`builtinExecutors.ts:592-599`，判断 `isUnderWikiRaw`） | **策略性只读保护写在执行层**（代码推理；本环境 `wikiConfig.enabled` 非 true，无法生效） |
| 4 | `switch_work_dir` | — | `targetProfile.sensitive === true` → `SENSITIVE_WORKDIR_ERROR`（`workDirExecutors.ts:105-107`） | **策略判断写在执行器**（代码推理；remote lane 专有工具，desktop 不可触发） |
| 5 | `read_feishu_attachment` | — | `路径超出 feishu-media 范围`（`readFeishuAttachmentExecutor.ts:19`） | **独立路径边界**（代码推理；feishu lane 专有工具，desktop 不可触发） |
| 6 | `write_file` / `edit_file` | `auto-allow`【实测】 | `ERR_FILE_NOT_READ_FOR_EDIT` / `ERR_FILE_NOT_READ_FOR_WRITE`（`builtinExecutors.ts:586-589`） | **流程门禁**（非安全性质，但同形态：执行层否决、策略层不知） |

**结果：无越位代裁的通道（裁决已上收策略层）**

| 通道 | 说明 |
| --- | --- |
| **`run_script`** | 裁决完全在策略层：`script-analysis` 提取器把 `analyzeScriptContent` 的 `verdict` 映射为 `signal: clean/suspicious/dangerous`（`scriptAnalysisExtractor.ts:52`，注释明确「**只产出事实，不做放行/拒绝判定**」），由规则 `script-clean-allow-desktop` 等消费。执行器（`builtinExecutors.ts:1329`）**只有 spawn 失败与超时**，**无任何安全性质的否决** ✅ **【实测】**：本轮构造含 `os.symlink` 的脚本，策略层给出 `decision: deny`、`ruleId: dangerous-signal`、`factsSummary: 脚本含危险模式，已拒绝` —— 拒绝**发生在策略层**（有 `policy.decision` 记录），执行器从未启动。对照组：同类 clean 脚本 20+ 次均为 `auto-allow`（`script-clean-allow-desktop`） |
| **`browser`** | 执行器内无 `dangerous` / `blocked` / `deny` 判定（grep 零命中）；高危判断走 `dangerAssessment` → 策略/审批 ✅ |
| **MCP 工具** | 注解安全 → `mcp-readonly-allow`；否则 → `mcp-tool-ask`（`toolCallGate.test.ts:325-384`）。判决在策略层，执行器仅转发 ✅（执行层是否有额外否决见 V-8） |
| **`toolkit.call`** | `toolkit-read-allow` / `toolkit-act-ask`，同 MCP ✅ |
| **`run_shell`** | 策略层**从不** `auto-allow`（本会话 33/33、全日志 73 次均 `require-confirm`），故**无「判决被推翻」的机会** —— 但这不是设计优势，而是 D-9（缺只读性事实）的副产品 |

**一项可操作的判据（本次排查的产出）**：

> 凡执行器内**直接调用 `pathSecurity` 系列函数**、或**自行读取安全配置**（如 `sensitive`、`wikiConfig`）并据此返回 `success: false` 的地方，都构成**第二个判决者**。反之，凡把事实交回策略层、执行器只做机制性动作的通道（`run_script` / `browser` / MCP / `toolkit`），均无此问题。

**附带发现：同一工具上「两类越界」的待遇并不一致**

`write_file` / `edit_file` 通道上，两种边界问题的处置路径**不同**：

| 越界类型 | 处置 | 可申诉性 |
| --- | --- | --- |
| 词法越界 / realpath 后越界 | 被**快通道** `evaluateWriteFileAutoApproval` 的 catch 拦下 → `reasonCode: 'sensitive_path'` → 转 `require-confirm` | **可申诉**（转确认） |
| symlink / 硬链接 / 非普通文件 | **不在**快通道检查范围内 → 策略 `auto-allow` 后由执行层否决 | **终局，不可申诉** |

即同一工具上，一类越界可走确认、另一类直接终局失败，而用户在界面上看到的都是「失败」。其中前者能拦下的原因，恰是快通道**复用了沙箱函数**（`resolveSafePathReal`，见 D-7 ①）—— 这反过来印证：**策略层与沙箱之间缺少稳定的分工契约，能拦下与否取决于某段代码「恰好」调用了什么。**

**本轮实测（动态复现，会话 `1b31aaec`）**

对第 2、6 条构造调用（输入全部在工作目录内、无越界、无副作用），比对**同一次调用的双层记录**：

| # | 工具调用 | 策略层记录（`policy.decision`） | 执行层结果（`tool_result`） | 间隔 |
| --- | --- | --- | --- | --- |
| 1 | `write_file` → `node_modules/.bin/asar`（工作目录内已有符号链接） | `ts 1790177333314` **`auto-allow`**（`ruleId: default-write-execute-ask`，`signals: ["path-target"]`） | `ts 1790177333317` `success: false`，`error: 路径包含符号链接，拒绝写入` | **3 ms** |
| 2 | `write_file` → `src`（目录） | `ts 1790177399906` **`auto-allow`**（同上） | `ts 1790177399908` `success: false`，`error: 写入目标必须是普通文件` | **2 ms** |
| 3 | `write_file` → `llm-wiki/raw`（目录） | `ts 1790177421354` **`auto-allow`**（同上） | `ts 1790177421356` `success: false`，`error: 写入目标必须是普通文件`（**非** `ERR_WIKI_RAW_READONLY`，见下） | **2 ms** |
| 4 | `edit_file` → `package.json`（本会话未读过） | `ts 1790177444859` **`auto-allow`**（同上） | `ts 1790177444862` `success: false`，`error: 文件尚未在本会话中通过 read_file 读取，请先读取后再编辑` | **3 ms** |

**结论**：4 次全部为「**策略层放行 → 执行层否决**」，间隔 2–3 ms，且**策略层无任何拒绝记录**（本会话 `write_file` 4 条、`edit_file` 55 条 `policy.decision` 全部为 `auto-allow`）。与 D-10 的 1 毫秒案例**完全同构**，故第 2、6 条由【代码推理】升为【实测】。

值得注意的是这 4 次的目标性质：**符号链接、目录、wiki 只读源（`raw/`）、本会话未读过的文件** —— 四类"本不该写"的目标，策略层**一律无差别 `auto-allow`**，可见其对「写入目标是否合理」没有任何输入（与 D-9 同源：缺的正是内容侧事实）。

**第 3 条（wiki）的实测结果是否定的**：写 `llm-wiki/raw`（`DEFAULT_WIKI_ROOT = 'llm-wiki'`，该路径正是 `classifyWikiPath` 判为 `'raw'` 的形态）返回的是执行层的「写入目标必须是普通文件」，**未返回 `ERR_WIKI_RAW_READONLY`**。按 `isUnderWikiRaw` 实现（`wikiPaths.ts:35-37`：`wikiConfig.enabled && classifyWikiPath(...) === 'raw'`），可判定**本环境 `wikiConfig.enabled` 非 `true`**，该门禁未生效 → **本条仍为代码推理，需在 wiki 启用环境复验**（见 V-8）。

**第 4、5 条无法在 desktop lane 触发**：`switch_work_dir` 与 `read_feishu_attachment` 均为 remote / feishu lane 专有工具（前者执行器首行即 `if (!ctx.remoteContext) return REMOTE_ONLY_ERROR`），且受 exposure 规则过滤，desktop 会话中不可见 → 只能停留于代码推理（见 V-8）。

**另附一项审计粒度观察**：上表第 1 行的 `policy.decision` 中 `signals: ["path-target"]` —— 即**信号种类名入审计，但 `zone` 不入**（`outside-workdir` / `sensitive-file` 等分区值不落盘）。故即便某工具产出了越界事实，**审计也无法据以判断是否越界**（与 D-2、D-10 同向）。

**与 D-10 的关系**：D-10 证明该现象**存在且不留痕**（实测，会话 d961cc51）；本节证明它**不是单点，而是横跨 5 条通道的模式**，其中第 1、2、6 条已在本轮**独立复现**（会话 1b31aaec），第 3~5 条仍为代码推理。共同根因仍为 D-6（`pathSecurity` 同时握有事实产出与授权判断）、D-8（检查全挤在策略层之前）。

**危害（在 D-10 基础上的增量）**：

- **同一问题无法一次性修复**：D-10 若只针对读通道修，写出通道、wiki 通道、work-dir 切换通道仍会各自复活 —— 需按上述判据**逐通道清理**；
- **策略配置的效力不可预期**：用户在设置里调整策略规则，实际是否生效还取决于对应执行器里有没有一份独立的否决逻辑（例：`switch_work_dir` 的 `sensitive` 判定完全不经过策略引擎，无 `policy.decision`，故在设置界面上无法审计、也无法统一调整）；
- **`run_shell` 的「无越位」是假象**：它之所以没有判决被推翻，是因为它**从不放行**（D-9）；一旦补上只读性事实使其能 `auto-allow`，若不同时清理执行层，将立即出现同类问题。

---

## 7. 待决议题

| # | 议题 | 相关事实 |
| --- | --- | --- |
| Q-1 | **「工作目录之外的只读访问」是否需要用户授权？** —— **已给出决议方向（2026-09-23 讨论）**：该判断应**归属策略层**；在产品尚无 OS 级隔离（shell 亦无路径边界，见 1.5）的现状下，**只读、且不涉及敏感目录**的越界访问**应放行**。该方向的落地前提是策略层**同时**拿到「越界性」与「只读性」两个事实，而二者现均缺失（D-2、D-9）。**待确认细节**：①敏感目录清单的口径（Q-5）；②该放行结论是否需留痕（现策略层对文件工具的越界只读已 `auto-allow`，但无任何记录表明其曾越界）；③**执行层的边界校验是否需让位** —— 见 D-10：策略层现已放行，实际拦下的是执行层，**只改策略层无效**。若不同时约束执行层，本议题的结论无法落地 | D-4：审批侧的 authorization 维在制度上不可用于此；D-9：策略引擎已有「只读即放行」规则，但 `run_shell` 的 `actionClass` 恒为 `execute`，规则永不适用；D-1 / D-9：越界只读诉求在两条通道上互为镜像失效；D-10：执行层可推翻策略层判决且不留痕，构成该议题的落地障碍 |
| Q-2 | **`ShellConfig.confirmOutsideWorkDir` 是接线还是删除？** 其字段名为策略语义（确认），但实际生效的是沙箱 `throw` | D-1 原因 1：全仓库仅测试 fixture 引用，无生产消费方 |
| Q-3 | **审批裁决的「永不落缓存」（I3）是否需为「路径域」开例外？** 这是唯一能让「授权一次、后续免问」成立的改动点 | D-5：`memoryEligibility` 对非 user 回答者返回 `'none'`；`types.ts:320` 的 `{ kind: 'path', level: 'directory' \| 'zone' }` 载体已定义但不可达 |
| Q-4 | **前置/后置分层的判据是否确认为「前置产事实、后置守执行」？** 若是，D-8 所列四处灰区（空路径、类型、symlink、敏感清单）应逐项拆分 | D-8：现状是前置函数同时承担两层职责，`safeAtomicWrite` 又重复校验 |
| Q-5 | **敏感路径清单的真相源归谁？** 现为 `electron/shell/shellSensitivePaths.ts`，被策略层、写快通道、shell 分析三方各自消费且参数不一致 | D-7 ③、V-4 |
| Q-6 | **`extraRoots` 是否应改为策略层的输出（「允许访问的根集合」）**，而非沙箱原语参数与调用点常量 | D-6 原因 1：现硬编码 `[userDataDir/skills]`，沙箱原语承载了业务概念 |
| Q-7 | **沙箱/执行层失败是否应携带可区分类别**，使「换个做法可解决」与「必须授权」可分辨（与 `session-ced59b41-issue-inventory-requirement.md` D-1 同类） | D-3：写通道三种成因共用 `reasonCode: 'sensitive_path'`，且码与文案互相矛盾 |
| Q-8 | **文件工具与 `run_shell` 的边界是否应统一？** 若统一，方向是「shell 也设边界」还是「文件工具放开」；若维持不一致，是否需在交互上明示 | D-1：同一边界三种判据、三种可申诉性、三种留痕 |
| Q-9 | **执行器内的「安全性质否决」与「策略判断」是否应上收策略层** —— 即确立「策略层作唯一判决者、执行层只做机制性校验（且机制性失败不得表述为策略拒绝）」这一分工？（D-11 已给出可操作判据：凡执行器内直接调用 `pathSecurity` 或自行读取安全配置并据此返回失败者，均属待上收点） | D-11：5 条通道存在越位代裁；`run_script` / `browser` / MCP / `toolkit` 已实现该分工；`switch_work_dir` 的 `sensitive` 判定完全绕过策略引擎 |
| Q-10 | **同一工具上「可申诉越界」与「终局越界」是否应统一**：`write_file` 的 realpath 越界转确认（可申诉），symlink/硬链接越界则终局失败（不可申诉），二者在界面同形 | D-11 附带发现：前者可拦下是因其「恰好」复用了沙箱函数，非稳定契约 |

---

## 8. 待核实项

| # | 待核实内容 | 影响 | 建议方式 |
| --- | --- | --- | --- |
| V-1 | `outsideWorkDirRisk` 除 hints/日志外，是否还有**其他回流路径**进入 `ContentFacts` 或策略层 | D-2 结论基于 `grep` 结果（仅 `shellToolLoopHelpers.ts:63` → `shellAgentLogger.ts:33`） | 全仓库追踪该字段的读写点，并做一次端到端插桩 |
| V-2 | `confirmOutsideWorkDir` 是否确实**零生产消费方**（含配置迁移、schema 序列化等间接引用） | D-1 原因 1、Q-2 的前提 | 全仓库检索字段名（含字符串形式与配置迁移脚本） |
| V-3 | `classifyPathWithSymlink` 是否在任何**生产路径**被调用（现仅见测试引用） | D-8「symlink 解析未用于事实产出」 | 检索调用点；必要时对 `buildPathSignal` 做插桩对比 |
| V-4 | 策略层 `env.sensitivePaths` 未含 `customSensitivePrefixes` 的**实际影响面**：用户自定义敏感目录在策略规则与审批中是否完全不生效 | D-7 ③、Q-5 | 构造含自定义敏感前缀的用例，观察是否产生 `policy.decision = require-confirm` |
| V-5 | `a252f3fa` 组 17 次裁决中审批 Agent 是否实际执行了**只读侦查**（审计 `evidenceCount` 均为 2，其含义待确认） | D-4、D-5 的时延成本归因 | 对照 `confirm.outcome` 的 `evidenceCount` 与审批内部会话（`automation` lane）记录 |
| V-6 | `autoApproveFallback`（含 `reasonCode`）是否在界面可见、是否落入审计 | D-3、D-7 ①「策略旁路不可观测」的严重度 | 触发一次快通道拒绝，检查界面与 `.agent/logs/` |
| V-7 | **并发/配额路径**在本会话仍未触达（本会话无并发审批、无 `admission.*` 事件） | 与 `session-ced59b41-issue-inventory-requirement.md` V-3 同源，本文不重复归档 | 受控压测（1/4/8/16 会话） |
| V-8 | D-11 所列越位代裁通道中，**仍未实测**的部分：①`wikiRawWriteBlocked`（本环境 `wikiConfig.enabled` 非 true，门禁不生效 —— 需在 wiki 启用环境复验）；②`resolveSafeWriteTarget` 的**硬链接分支**（环境内未找到 `nlink > 1` 的普通文件；库内 `os.link` 另被策略层 `dangerous-signal` 拒绝，无法自助构造）；③`switch_work_dir` 的 `sensitive` 否决（remote lane 专有，desktop 不可触发）；④`read_feishu_attachment` 的 `feishu-media` 边界（feishu lane 专有） | 上列各项仍为【代码推理】。已实测坐实的是第 1、2（symlink 与"非普通文件"两分支）、6 条，见 D-11「本轮实测」 | ③④ 需在对应 lane 的会话中构造输入；①② 需相应配置/文件系统条件 |
| V-9 | MCP 与 `toolkit.call` 通道的执行器是否存在**额外安全否决**（本次检索未发现，但其执行器分散在 MCP 代理层，未逐一核对；本环境亦无 MCP 服务可实测） | D-11「干净通道」结论的完整性 | 检索 MCP 工具调用链的执行体，确认其仅转发策略判决；或在已接入 MCP 的环境中复现 |

---

## 9. 附：本清单未覆盖的范围

- **未评估审批 Agent 的裁决质量本身**：按现行 Skill 条款，放行会话 d961cc51 中那些**只读**的越界命令**并不构成判错**（Skill 明文「工作目录之外本身不抬高风险等级」）。本文记录的是「事实缺失导致裁决不可复现」，而非「该次裁决错误」。
- **未评估 shell 沙箱化的可行性与代价**：本文只记录「shell 不受文件沙箱约束」这一事实与其后果，不含改造方案（含性能、兼容、跨平台影响）。
- **未覆盖平台差异**：本文所引判定点均以 macOS 行为为准，未核对 Windows/POSIX 分支的实际表现差异。
- **未覆盖其他工具的越界行为**：`grep`、`run_script`、`browser` 等在同一场景下的边界表现未逐一核对。

---

## 10. 修订记录

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| 0.1 | 2026-09-23 | 首版。基于会话 `d961cc51` 的实测数据（审计 331 条、事件流 60.5 MB）与当前 HEAD 代码，收录 D-1 ~ D-8 共 8 项，待决议题 Q-1 ~ Q-8，待核实项 V-1 ~ V-7。与 `session-ced59b41-issue-inventory-requirement.md` 为并列关系，本文不重复其第 6 章已归档的并发类问题 |
| 0.2 | 2026-09-23 | **脱敏**：移除全部本机绝对路径。正文中 7 处原为本机绝对路径的位置（1.1 的「工作目录」「触发场景」、2.1、2.2 表格、D-1、D-2、D-5），一律改为占位符（「本仓库工作目录」/「外部参照仓库」）；1.1 末尾补「脱敏约定」段说明该口径。文中保留「位于工作目录之外」这一必要的技术事实，D-1 ~ D-8 的结论与证据强度标注均不受影响 |
| 0.3 | 2026-09-23 | 强化第 5 章（沙箱与策略职责混装）的架构定性：①章首补「本节主旨」段，明确 D-6（混装）/ D-7（旁路）/ D-8（错位）是同一条架构问题的三个断面，并给出「沙箱只答能否安全解析、策略只答要不要授权」的判据；②D-6 补充**比例口径对照表**（狭义：`pathSecurity.ts` 本体约 85% 为沙箱；广义：连同 `writeFileAutoApproval.ts` 约各占一半，且策略那一半全部绕过策略引擎），并说明两口径差异的成因 |
| 0.7 | 2026-09-23 | 执行 **V-8 的动态复现**，D-11 由【代码推理】部分升为【实测】：①构造 4 次 write_file/edit_file 调用（输入全在工作目录内、无副作用），全部呈现「**策略层 `auto-allow` → 执行层否决**」，间隔 2–3 ms、策略层无拒绝记录 —— 与 D-10 的 1 ms 案例同构，**第 2、6 条坐实**（含 symlink 分支与"非普通文件"分支）；②取得 `run_script` 的**正面样本**：含 `os.symlink` 的脚本被策略层以 `ruleId: dangerous-signal` 拒判（有 `policy.decision`，执行器未启动），印证「裁决在策略层」；③wiki 条实测为**否定结果** —— 写 `llm-wiki/raw` 返回执行层文案而非 `ERR_WIKI_RAW_READONLY`，判定本环境 `wikiConfig.enabled` 非 true，该条保留为代码推理；④`switch_work_dir` / `read_feishu_attachment` 为 remote/feishu lane 专有、desktop 不可触发，保留为代码推理。另记录两项：**审计粒度** —— `policy.decision` 记 `signals: ["path-target"]` 但 `zone` 不落盘，故审计无法据以判断越界；**方法论教训** —— 历史日志检索在本仓库不可靠（命中的是分析会话自身读取源码时写入的字符串，全为假阳性），须以动态复现为准。V-8 相应收敛为「仍未实测的部分」，1.2 数据来源补入动态复现来源 |（第 6 章末）。判据为「执行器内是否存在安全性质的回退」。结果：**5 条通道存在越位代裁** —— ①读通道（D-10 本体，实测）；②写通道 `resolveSafeWriteTarget` 的 symlink/硬链接/非普通文件否决；③`wikiRawWriteBlocked`（策略性只读保护写在执行层）；④`switch_work_dir` 的 `sensitive` 否决（策略判断写在执行器，且绕过策略引擎、无 `policy.decision`）；⑤`read_feishu_attachment` 的 `feishu-media` 边界。**4 条通道无此问题**（裁决已上收）：`run_script`（提取器注释明确「只产出事实，不做放行/拒绝判定」）、`browser`、MCP、`toolkit`；`run_shell` 的「无越位」实为 D-9 的副产品（从不放行，故无判决可被推翻）。附带发现：`write_file` 上「realpath 越界 → 转确认（可申诉）」与「symlink 越界 → 终局失败（不可申诉）」待遇不一致，前者能拦下仅因快通道「恰好」复用了沙箱函数。相应：新增 Q-9（执行器内安全否决/策略判断是否上收）、Q-10（可申诉与终局越界是否统一）、V-8（4 条通道待实测）、V-9（MCP/toolkit 执行器待核对） |。核心实证为同一工具调用的**双判决时序** —— `1790161314675` 策略层记 `auto-allow`（放行）→ `1790161314676` 执行层返回「路径超出工作目录范围」（否决），**相隔 1 毫秒、以执行层为准，且该否决未产生任何策略记录**（本会话 8 条 `list_directory` 的 `policy.decision` 全为 `auto-allow`，含被否决的那一次），即**审计记录与真实结果相反**。附 D-8（检查时机）与 D-10（判决权归属）的分工说明。相应：①第 6 章标题与主旨扩为「策略层缺输入，执行层越位代裁」；②Q-1 增列待确认细节 ③——执行层边界校验是否需让位（**只改策略层则议题无法落地**）。另：D-9 的「只读性」实证同步修正为全日志 73 次 `run_shell` 决策 `actionClass` 无例外为 `execute` |
| 0.4 | 2026-09-23 | 新增第 6 章「问题四：策略层缺少判定所需的输入事实」及 **D-9**：策略引擎已内建「只读即放行」规则（`default-read-outbound-allow`），但其判据是 descriptor 静态声明的 `actionClass`，而 `run_shell` 恒为 `execute`（全日志 73 次无一例外），故该规则对 shell 通道永不适用 —— 即**除「越界性」（D-2）外，还缺「只读性」事实**。附「同一诉求在两条通道上的镜像失效」对照（文件工具：策略已放行、边界层越权拒绝；shell：边界层缺位、策略无从识别只读）。相应：①新增 1.5「术语说明」界定本文「沙箱」指应用层路径边界校验（非 OS 级隔离），并说明文件工具有、shell 无；②**Q-1 记入决议方向**（归属策略层；只读且非敏感应放行）并列出其落地前提与待确认细节；③原第 6~9 章顺延为第 7~10 章 |
