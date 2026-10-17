# 拒绝可诊断性与免确认写入审计事实 —— 优化计划

> **定位**：审核模块（权限闸门 / 确认审批 / 安全审计）的两处**表达与记录**缺陷 —— ① 拦下一次操作时，原因不回给模型，模型只能盲猜；② 「没问你、自动帮你改了文件」这件事的记录数字不可信，且存在记成「另一个文件」的分支。
> **状态**：草稿（**决策已定**：D1=C、D2=A、D3=B；未实施）｜**核对基线**：`main` `8c7dce0e`（2026-10-17）
> **范围**：本主题（`electron/confirmation/`、`electron/runtime/invocationAssembler.ts`、审计字段）内的**表达层与审计字段**。
> **非本计划范围**：`llm-wiki` 侧的路径映射、目录骨架、`grep`/`shell` 的词汇路径问题 —— 另立一份计划，本文不重复定义。
> **读者标记**：【人必读】= 只做取舍的决策界面；【机｜人工可跳过】= 规格与任务编排。
> **篇内路由**：只看要拍板什么 → §0；想知道凭什么这么改 → §1；实现与验收 → §2、§3；只看要跑什么 → §3.2、§4。

---

## 0. 【人必读】决策界面

**一句话**：系统现在拦下一次操作时，只说「被拒绝了」，不说为什么 —— AI 只能反复试探；另外「没问你、自动帮你改了文件」这条记录里的数字是错的（实际写了 3047 字节，记成 0 字节），而且如果工作目录里正好有个同名文件夹，它还会记成**另一个文件**的数字、看不出任何异常。这两件事的处置已定：**原因按「人话 + 粗类别」回给 AI**（D1=C），**那条记录按「修好」处理**（D2=A）—— 见下方决议。

**只有 3 分钟的话**：读 D1、D2，再看 §1.3 那张「上次这件事花了多少代价」的表。

### D1｜被拦下时，要不要告诉 AI「为什么被拦」

- **背景**：当系统不让某次操作执行时（越权路径、危险命令、禁止写入的区域、目标目录还不存在……），现在回给 AI 的只有一句固定话术「未执行（策略拒绝）」。AI 看不到具体是哪条规则、因为什么，也无法判断「我换个方式重试」还是「这条路根本不通」。
- **要决定什么**：
  - **A. 只说人话**：例如「目标文件的所在目录还不存在，无法创建」，不给任何内部规则名。
  - **B. 人话 + 内部规则号**：例如多带一个 `write-parent-directory-missing`。
  - **C. 人话 + 粗粒度原因类别**：例如带一个 `path-target-unavailable`（同类原因共用，细粒度仍只在审计日志里）。
- **每个选项的后果**：三个选项都**不改变**放行/拒绝的判断结果，只改回给 AI 的文本。A 最保守，AI 靠人话也能自助纠正，但线上排查「到底哪条规则拦的」时要另查日志；B 对 AI 最省事（能直接对照文档自查），代价是内部规则名会出现在对话记录里、外人也看得到，可能被用来试探边界（**无实测数据**）；C 折中：AI 拿到可操作提示，内部规则名仍留在审计面。
- **可逆性**：可逆 —— 只改回灌文本，判定逻辑不动，随时可调。
- **依据强度**：已证实「无原因 ⇒ 无效探索」（§1.3 实机）；「AI 会不会利用规则名试探边界」没有数据，属未验证假设。
- **✅ 决议（2026-10-17）**：**C**（人话 + 粗粒度原因类别）。
- **落地约束**：对外的原因码仍保持 SDK 枚举 `POLICY_DENY`（INV-2）；粗类别与人话一起放进「给模型看的话」，细粒度规则号不得进入对话文本（仍留在审计面）。

### D2｜「自动写」的记录怎么处理（✅ 决议：A —— 修好它）

- **背景**：文件写入在「免确认自动放行」时（你没被打断的那种），系统会记一条：写了哪个文件、加了几行、删了几行、多少字节。现在这条记录在共享知识库路径上是 `0 / 0 / 0`（实际写了 3047 字节）；更糟的是：**如果工作目录里正好有一个同名文件夹**（迁移残留、手工创建都可能），它会读到那个文件、算出看起来完全正常的数字，而真正被改的文件是谁，记录里看不出来。
- **候选方向**：
  - **A. 修好它**（采纳）：让记录始终指向本次调用**真实被写的那个目标**，并给出真实数字。
  - **B. 缩小范围 + 诚实标注**：只在「目标位于工作目录内」时记数字，其余场景显式标「不可用」。
  - **C. 删掉这个字段和它的日志**。
- **为什么否掉 B**（评审追问「为什么在工作目录内才能记录数字」，答案是：**没有理由**）：
  - 「工作目录内才统计」不是设计约束，而是旧实现的**副作用**：这条记录复用了确认卡片的差异计算（以工作目录为基准解析路径），而确认卡片当年只服务「工作目录内的桌面写」这一种场景。把副作用写成契约，等于把缺陷合法化。
  - 审计要回答的问题是「AI 未经确认改了文件 —— 改了哪个、改了多少」。映射 / 共享路径的写入同样要回答，不能因为「目标不在工作目录内」就失去数字。
  - 这条约束本身也不可判定：**同名目录存在时**，目标「看起来在工作目录内」，但实际对象是另一个文件 —— B 规则下它会照记不误，最危险的那一态反而被放过。
- **采纳 A 的关键约束（不是「再加一层挂载感知」）**：本次调用**已经**冻结了权威目标 —— 探测层产出的写入目标事实（含真实目标路径、父目录真实路径与文件身份）随写入许可一路带到执行层；仓库既有纪律也要求「路径映射的唯一决策点」由同一处服务探测层、许可与执行层。因此修法是**删掉装配层这第二处私有解析**、改用该权威目标，并把字节数改为从**执行结果**回填（执行器已算出真实值）。这样同时消除「归零」与「错对象」两种形态。
- **可逆性**：可逆（改动集中在装配层的记录构造与差异计算调用点）。
- **依据强度**：「0/0/0」由实机事件流证实（§1.2）；「错对象」由代码路径推出（U-1，未实测）。
- **✅ 决议（2026-10-17）**：**A**。B 的「显式不可用」不作为常规分支，只保留为**异常兜底**：确实解析不到目标时不得写 `0`（见 AC-6）。

### D3｜原因文案只修一条，还是建一套

- **背景**：这次暴露的是「写入目标的父目录不存在」这一类**探测失败**。系统里同类探测失败还有多处（读目标、脚本路径、shell 效果分析……），它们回给 AI 的文案同样笼统（「事实探测失败，已阻止执行」）。
- **要决定什么**：
  - **A. 只修有实机证据的那一条**（写入类）。
  - **B. 建立「探测失败原因 → 可操作文案」的统一映射骨架**，文案先只填有证据的那一条，后续按需扩充。
- **每个选项的后果**：A 一次投入最小，但同类问题下次换个入口还会复发；B 一次把机制做对（新失败类型只需加一行映射），代价是多一处集中定义与它的回退行为、测试面略大。
- **可逆性**：可逆。
- **依据强度**：仅写入类有实机证据；其余为「推测同类」，尚无现场案例。
- **✅ 决议（2026-10-17）**：**B**（机制通用、文案按需）。

### 不需要你决定（Agent 负责；写出来是为了不占用你的时间）

- 修好后**不改变任何「放行 / 拒绝」的判定结果**，有逐条比对用例兜底（AC-4）。
- 本方案**不新增不可配置的系统约束**，因此**不登记**系统不变量登记表；只把字段语义变化登记到审计字段映射表（判据见 §2.3）。
- **不需要数据迁移**：历史审计事件与历史工具结果保持可读，旧记录不回填。
- `llm-wiki` 的目录骨架、词汇路径、`grep`/`shell` 行为**不在本计划内**。

---

## 1. 【人机共读】问题与实证

### 1.1 问题一：被拦下时，模型拿不到原因（断点在宿主）

| 环节 | 现状 | 证据 |
| --- | --- | --- |
| 闸门判定 | **本来有**具体规则号与原因（例：`write-parent-directory-missing` / 「写入目标事实探测失败」） | `rg -n 'ruleId: writePathProbeFailure.caseId' electron/confirmation/toolCallGate.ts` |
| 宿主策略端口 | 把两者**丢弃**，只回一个笼统枚举 `POLICY_DENY` | `rg -n "kind: 'deny'" electron/confirmation/agentSdkSafetyPolicy.ts` |
| SDK（当轮回灌） | **已支持**把「给模型看的话」随拒绝回灌当轮模型（`FR12②`） | `rg -n 'initialDecision.userMessage' packages/agent-sdk/src/turn.ts` |
| SDK（历史物化） | **未接通**：初次拒绝先按旧文本落历史，与当轮回灌文本不一致（F-13） | `rg -n 'markNotDispatched' packages/agent-sdk/src/turn.ts` |
| 模型 | 只收到 `Tool call was not dispatched (POLICY_DENY).` | §1.3 实机事件流 |

**性质**：缺口有**两处**，不是一处 —— ① 宿主在 deny 出口把具体原因丢掉，只回笼统枚举；② SDK 的**历史物化**路径也没带上「给模型看的话」：初次拒绝先按旧文本把「未派发」事件写进历史与 session ledger，随后才构造带文案的异常，于是**当轮模型看到新文案、持久化历史仍是旧文本**（F-13）。只补宿主一处，历史就与当轮不一致。

**附带损失**：拒绝结果里也没有 `decisionRuleId`（对比成功结果都有），所以 UI 与审计侧只能靠 `requestId` 反查 `policy.decision` 事件才能还原是哪条规则。

### 1.2 问题二：免确认写入的记录数字不可信（且有两种失败形态）

生成点：`electron/runtime/invocationAssembler.ts` 在「自动放行且工具是写文件类」时构造该记录，使用 `buildConfirmationDiff(args.workDir, …)`；而 `electron/confirmation/confirmDiff.ts` 内部用 `resolveSafePathReal(workDir, rel)` 解析路径 —— **完全不经过共享知识库的挂载解析**。

```text
rg -n 'buildConfirmationDiff|autoApprovedWrite' electron/runtime/invocationAssembler.ts
rg -n 'resolveSafePathReal' electron/confirmation/confirmDiff.ts
rg -n 'bytesWritten' electron/tools/builtinExecutors.ts
```

| 形态 | 触发条件 | 表现 | 危害 |
| --- | --- | --- | --- |
| 归零 | 目标不在工作目录内（共享知识库词汇路径、任何挂载/映射路径） | 解析失败 → `added/removed/bytesWritten` 全 `0` | 审计数字假（实际 3047 字节记成 0）；同一字段的 `file.auto_approve` 日志同样为 0 |
| 错对象 | 工作目录内**恰好存在同名目录** | 解析成功 → 读出**另一个文件**并算出正常数字 | 更危险：数字看起来对，对象是错的，且没有任何迹象 |
| 假行数 | 目标能正确解析，但入参与文件在**换行 / 转义层**不一致（文件 CRLF、提交 LF；或走转义容差回退） | 预览用精确字符串匹配重演编辑，匹配失败即令「新内容 = 旧内容」 → 记录成「新增 0、删除 0」 | 数字假且不显眼：字节数可能是对的，行数恒 0；**路径修正后仍然存在**（评审 R-1） |

**口径不一致（同源缺陷）**：`write_file` 分支取「入参内容长度」，`edit_file` 分支取「预览计算出的新内容长度」，两者都不是「本次实际写入落盘的量」。执行器其实已经算出真实值：**编辑类**工具的结果里带 `data.bytesWritten`（写入后文件字节数），但这条记录没用它；**新建写入类**工具的结果里当前**没有**该字段（见 F-10），所以契约二的「从执行结果回填」在实施时必须先把这一侧补齐。

**重演语义 ≠ 执行语义（评审 R-1 的核心）**：预览用 `split`/`replace` 精确匹配，执行器则先做**换行归一**匹配、再在显式开启时做**转义层唯一变体回退**；同一份入参在两者眼里「会不会命中、命中哪一段」可以不同。因此**只把预览的路径解析换成权威目标是不够的**：行数必须由执行器基于**实际使用的写前内容与最终写入内容**产出（见 §2.2 契约二、B-02）。

### 1.3 实机代价（2026-10-16，会话 `9894c5f1-baa2-46db-a0fd-09b4c44661ce`）

证据：`sessions/9894c5f1-baa2-46db-a0fd-09b4c44661ce-20261016/events.jsonl`（`tool_call` / `tool_result` 事件）。

| 观测 | 数值 |
| --- | --- |
| 用户诉求 | 「在 wiki 里增加一种内容类型，并记一条待办」 |
| 工具调用总数 | 40 次（其中 33 次在理解阶段） |
| 模型请求数 | 26 次 |
| 墙钟耗时 | 413 秒 |
| 被拒调用 | 2 次（一次 `write_file`、一次 `edit_file`），返回文本完全相同：`Tool call was not dispatched (POLICY_DENY).` |
| 模型后续动作 | 5 次调用（grep / 读源码）试图找出「哪条规则拒绝了我」，搜的是 `POLICY_DENY` 这个名字 —— 而真实规则名是 `write-parent-directory-missing`，**注定搜不到** |
| 最终结果 | 放弃自助解决，改为请用户手工创建目录 |

**这条链路值得单独修的理由**：拒绝原因不可读，会把一次「换个路径就成功」的小失败，放大成一次跨模块的源码考古 + 人工介入。

---

## 2. 【机｜人工可跳过】规格层

### 2.1 事实卡

| # | 断言 | 复现命令 | 基线 |
| --- | --- | --- | --- |
| F-1 | 宿主策略端口的 deny 出口只传 `reasonCode`，不带 `userMessage` | `rg -n "kind: 'deny'" electron/confirmation/agentSdkSafetyPolicy.ts` | `8c7dce0e` |
| F-2 | SDK 在**当轮** deny 回灌时优先使用 `userMessage`（历史物化路径未接通，见 F-13） | `rg -n 'initialDecision.userMessage' packages/agent-sdk/src/turn.ts` | `8c7dce0e` |
| F-3 | 闸门 deny 携带具体 `ruleId` 与 `reason` | `rg -n 'reason: .写入目标事实探测失败' electron/confirmation/toolCallGate.ts` | `8c7dce0e` |
| F-4 | 父目录缺失在探测层有稳定 caseId | `rg -n 'write-parent-directory-missing' electron/confirmation/extractors/writePathFacts.ts` | `8c7dce0e` |
| F-5 | 免确认写入记录由装配层构造，diff 解析以工作目录为基准 | `rg -n 'buildConfirmationDiff|autoApprovedWrite' electron/runtime/invocationAssembler.ts` | `8c7dce0e` |
| F-6 | 该 diff 解析不认挂载（无共享库路径解析） | `rg -n 'resolveSafePathReal' electron/confirmation/confirmDiff.ts` | `8c7dce0e` |
| F-7 | **编辑类**工具（`edit_file`）的执行结果带真实写入量（写入后文件字节数） | `rg -n 'bytesWritten' electron/tools/builtinExecutors.ts` | `8c7dce0e` |
| F-8 | 该记录的消费方只有 `file.auto_approve` 日志 | `rg -n "file.auto_approve" electron/runtime/invocationAssembler.ts electron/agentLogger/types.ts` | `8c7dce0e` |
| F-9 | 模型面与遥测面已剔除该字段，仅事实面保留 | `rg -n 'autoApprovedWrite' src/shared/processResultProjection.ts src/shared/agentToolResult.ts` | `8c7dce0e` |
| F-10 | **新建写入类**工具（`write_file`）的执行结果**不含**写入量字段 → 「从执行结果回填」需先补齐该侧 | `rg -n 'bytesWritten' electron/tools/writeFileRegisteredTools.ts`（无命中）；全仓非测试命中仅在编辑分支 | `8c7dce0e` |
| F-11 | 写入许可与闸门结果里**已经**带权威目标（真实路径），装配层不必也不应自行解析 | `rg -n 'targetPath: prepared.permit' electron/tools/writeFileRegisteredTools.ts`、`rg -n 'writePathFact' electron/confirmation/toolCallGate.ts` | `8c7dce0e` |
| F-12 | 预览重演（精确匹配，失败退化为「新 = 旧」）与执行器（换行归一 + 可选转义层回退）语义不同 → 行数可能是假值 | `rg -n 'applyEditWithEolTolerance' electron/tools/builtinExecutors.ts`、`rg -n 'newContent = oldContent' electron/confirmation/confirmDiff.ts`、`rg -n 'CRLF' electron/tools/builtinExecutors.editDiagnosis.test.ts` | `8c7dce0e` |
| F-13 | 初次 deny 调 `markNotDispatched(tool, reasonCode)` 未传第三参数 `userMessage` → 历史 `replayContent` 与 session ledger 记旧文本，与当轮回灌不一致 | `rg -n 'markNotDispatched' packages/agent-sdk/src/turn.ts` | `8c7dce0e` |

> **复核基线（评审 2026-10-17）**：静态核查在 `1f22be0f` 上完成；F-12、F-13 在 `8c7dce0e` 下同样成立。依据：`docs/review/2026-10-17-denial-diagnosability-and-auto-approved-write-facts-improvement-plan-review.md`。

**未验证项（显式列出）**：
- U-1：「工作目录存在同名目录 ⇒ 记录到错对象」为代码路径推理，未实测（需构造同名目录现场）。
- U-2：`grep` / `shell` 等其它入口的同类探测失败文案是否同样笼统，只抽样确认了写入类。

### 2.2 不变量与契约

**不变量**

| ID | 内容 | 为什么 |
| --- | --- | --- |
| INV-1 | 模型可见的拒绝文本**只用于解释**，任何文本都不参与放行判定（单向：判定 → 文案） | 防止「改话术改出权限变化」 |
| INV-2 | 拒绝的**原因码分层**：原因码保持 SDK 侧枚举语义（如 `POLICY_DENY`），具体细节只放「给模型看的话」；不得把宿主规则号塞进原因码 | 避免 SDK 契约被宿主语义污染 |
| INV-3 | 审计事实字段的值**要么真实、要么显式「不可用」**；不得用 `0` / 空串兜底冒充正常值 | 本次缺陷的根因就是「用 0 冒充」 |
| INV-4 | 本方案**不改变**任何调用的 `decision.type` / `ruleId` | 可回归验证，见 AC-4 |

**契约一：拒绝原因 → 给模型看的话（D1 决议 = C：人话 + 粗类别）**

| 原因码（宿主，仅审计面） | 粗类别（模型可见） | 给模型看的话（中文，动作导向） |
| --- | --- | --- |
| `write-parent-directory-missing` | `path-target-unavailable` | 目标目录不存在，无法创建该文件；请改写到一个已存在的目录，或告知用户需要先建立该目录 |
| 其它探测失败（本期未逐条填写） | —（不产生粗类别） | 回退到现状文本：`Tool call was not dispatched (<原因码>).` |

- **文本格式契约**：`userMessage` = `[<粗类别>] <人话指引>`（例：`[path-target-unavailable] 目标目录不存在，…`）；`reasonCode` 保持不变（仍为 `POLICY_DENY`）。
- 回退行为是**契约的一部分**：未登记的原因码必须保持今天的文本，不允许出现「更差」的文本（例如空字符串、内部堆栈，或只给粗类别而没有人话）。
- 文案不得包含本机绝对路径、用户目录名，也不得包含细粒度规则号。
- **三处同源（评审 R-2）**：同一次拒绝的 ①当轮模型工具消息、②History 的 `tool-call-not-dispatched.payload.replayContent`、③session ledger 结果必须取**同一段文案**；SDK 初次拒绝分支必须把文案交给历史物化（现状只传原因码，见 F-13），不得出现「当轮是新文案、历史仍是旧文本」。

**契约二：免确认写入记录字段语义（D2 决议 = A：修好它）**

| 字段 | 冻结后的语义 | 取值规则 |
| --- | --- | --- |
| `path` | 模型请求的目标路径（**入参原样**，便于与对话对齐） | 必填 |
| `bytesWritten` | 本次调用写入后目标文件的字节数 | **从执行结果回填**（编辑类已具备；新建写入类需补齐该字段，见 F-10），不由入参内容长度或预览差异推算 |
| `added` / `removed` | 相对**实际写前内容**的行数增减 | **唯一生产者是执行器**：写盘成功后，基于它实际使用的写前内容与最终写入内容产出（含换行归一与转义回退路径）；装配层只做关联与投影，**不得重演编辑**（F-12） |

- **统计的唯一起源与提交时点（评审 R-1）**：行数与字节数都由执行器在**写入成功后**产出、随执行结果返回；装配层不再自行计算差异，也不再调用 `buildConfirmationDiff` 承担本用途。理由：预览重演与执行器的匹配语义不同（F-12），任何「另外算一遍」的方案都无法保证与真实写入一致。
- **目标真源**：记录挂靠的目标是本次调用已经产出的写入目标事实（探测层产出、随写入许可带到执行层，F-11）；装配层**不自行解析路径** —— 用于消除「归零」与「同名目录错对象」。
- **统计失败不改变写盘结论**：统计缺失只允许把统计标为不可用，**不得**把已完成的写入转成拒绝，也不得丢失执行结果。
- **不可用只作兜底**：确实拿不到目标或差异时，字段整体标记不可用（`stats: 'unavailable'`），**不得写 `0`**；记录与 `file.auto_approve` 日志取同一值。
- 本字段仍只落事实面（事件流 / DB）；模型面与遥测面不出现（F-9）。

### 2.3 阶段归属与登记

| 项 | 归属 | 说明 |
| --- | --- | --- |
| 探测事实生产器（`extractors/*`） | **facts** | **本次不改**：仍只报告事实与稳定 caseId（`write-parent-directory-missing` 保持稳定，登记文案映射时以它为准） |
| 拒绝判定与规则 | **policy** | **本次不改判定**：不加规则、不动 floor、不动 package 档位；只在「拒绝结果的表达」上扩展 |
| 最终校验（final-check / permit 核验） | **final-check** | **本次不改** |
| 系统不变量登记（`src/shared/security/systemInvariantRegistry.ts`） | **不登记** | 判据：登记要求是「新增不可配置的系统约束」；本方案不新增此类约束，只改文案与审计字段。若后续把「拒绝必须可解释」升级为不可配置约束，则须另行登记（owner / 依据 / 范围 / 审计 / 测试） |
| 审计字段映射 | 登记到 `docs/develop/security-policy-audit-field-map.md` | 字段语义变化必须在该表更新（它是审计字段的真源） |
| 规则 ID | 不新增 | 复用既有 `caseId`；若需新增「拒绝可解释性」相关规则，须给稳定 rule ID 与 decision trace（本方案不涉及） |

**边界测试（安全改动要求）**：见 §3.2 各任务的完成判据，覆盖七个边界 ——「命中映射 / 未命中回退 / 挂载与非挂载 / 两类写工具 / 统计不可用 / **编辑语义差异（EOL 容差、转义回退）** / **拒绝解释三处同源**」。

### 2.4 场景矩阵

| 场景 | 期望 | 状态 |
| --- | --- | --- |
| 正常：写入被拒且原因码在映射表内 | 模型收到可操作文案 | 待实现 |
| 正常：原因码不在映射表内 | 回退到现状文本（不变差） | 待实现 |
| 挂载路径被拒（词汇路径 → 真实位置在工作目录外） | 与直接路径同等可解释 | 待实现 |
| 远程 lane（IM 来源）被拒 | 文案一致，不泄漏本机路径 | 待实现 |
| 审批 Agent 机审拒绝 | 走既有 `agent_denied` 口径，不被本次文案覆盖 | 待验证不回归 |
| 用户显式点「拒绝」 | 保持既有 `CONFIRMATION_DENIED` 文本 | 待验证不回归 |
| 免确认写入：目标在工作目录内 | 记录数字与执行器结果一致 | 待实现 |
| 免确认写入：目标为映射 / 共享路径 | 记真实目标与真实数字（与执行器结果一致） | 待实现 |
| 免确认写入：目标无法解析（含同名目录异对象） | 不得输出 0；不得读错对象 | 待实现 |
| 免确认写入：文件 CRLF / 入参 LF 多行替换（EOL 容差命中） | 行数与执行器实际写前 / 写后内容一致；不出现「新增 0、删除 0」假值 | 待实现 |
| 免确认写入：转义层唯一变体回退命中 | 同上；统计须覆盖回退路径 | 待实现 |
| 免确认写入：替换后内容与原文相同（真实无变化） | `added` / `removed` 为 0 **且这是真实值**；不得与「预览失败」的 0 混淆 | 待实现 |
| 免确认写入：写盘失败（未落盘） | 不生成成功写入事实（无统计、无 `file.auto_approve` 日志）；失败原因照常上报 | 待实现 |
| 并发：同一轮多个写入 | 各调用记录互不串（按 requestId/toolUseId 绑定） | 待验证不回归 |
| 取消 / 超时：写入未派发 | 不生成该记录 | 待验证不回归 |
| 重启后读历史事件 | 旧事件（含 0 值旧记录）可读、不报错 | 待验证 |
| 重复 / 乱序结果 | 投影层幂等，不产生第二条记录 | 待验证 |
| 旧数据 | 不回填、不迁移 | 不适用改动 |

### 2.5 验收清单（AC）

> 本文件同时承载规格与编排；AC 的真源在此，任务只引用 ID，不另造验收。

| ID | 验收（可观测） | 对应不变量 | 用例落点 |
| --- | --- | --- | --- |
| AC-1 | 对映射表内的原因码，被拒调用的**模型可见文本**包含：可操作说明 + 按 D1 选定粒度的标识；且不含本机绝对路径 | INV-1/INV-2 | `packages/agent-sdk/test/turn.test.ts`（回灌路径）+ 宿主侧新增断言 |
| AC-2 | 对**未登记**的原因码，回灌文本与改动前逐字一致（回退契约） | INV-2 | `electron/confirmation/agentSdkSafetyPolicy.test.ts` |
| AC-3 | 拒绝结果的审计关联不退化：可通过 `requestId`/`toolUseId` 关联到 `policy.decision` 的具体 `ruleId` | INV-1 | `electron/confirmation/toolCallGate.test.ts` 的审计断言 |
| AC-4 | **决策矩阵不变**：对既有等价输入集合，`decision.type` 与 `ruleId` 与改动前逐条一致 | INV-4 | `electron/confirmation/toolDecisionMatrix.test.ts`、`src/shared/policy/defaultRules.contract.test.ts` |
| AC-5 | 免确认写入记录：`bytesWritten` 与 `added`/`removed` **均取自执行结果**，且对成功结果可复算 —— 用执行器实际使用的写前内容与最终写入内容重算，与记录逐值相等 | INV-3 | `electron/runtime/invocationAssembler.test.ts` |
| AC-6 | 映射 / 共享路径场景：记录挂靠**真实被写目标**（权威目标）且数字可复算；仅当确实取不到目标或统计时才标不可用 —— **任何情况下不得用 `0` 冒充正常值** | INV-3 | 新增用例（映射解析桩 + 同名目录现场）+ `electron/claudeStreamHandlers.hostedIntegration.test.ts` |
| AC-7 | `file.auto_approve` 日志的字节数与记录一致；不可用场景日志显式标注 | INV-3 | 同上（日志断言） |
| AC-8 | 历史事件兼容：旧记录（含 0 值）读取不报错、不被改写 | INV-3 | `electron/messageCodec.test.ts` 等既有 round-trip 用例 |
| AC-9 | **行数覆盖编辑语义差异（评审 R-1）**：文件 CRLF / 入参 LF 的多行替换、转义层唯一变体回退命中、新建空文件、真实无变化四种成功场景，记录行数与执行器实际写前 / 写后内容可复算一致 | INV-3 | `electron/tools/builtinExecutors.editDiagnosis.test.ts`（CRLF 与字面换行回退用例组）+ 新增断言 |
| AC-10 | **失败不产生成功事实**：写盘失败（或未落盘）时不生成带统计的成功写入记录，也不产生对应 `file.auto_approve` 日志；失败原因照常上报 | INV-3 | `electron/runtime/invocationAssembler.test.ts` + 既有失败路径用例 |
| AC-11 | **拒绝解释三处同源（评审 R-2）**：同一次拒绝的当轮模型工具消息、History `tool-call-not-dispatched.payload.replayContent`、session ledger 结果三处文本逐字一致；未映射原因码三处都保持旧文本；该调用只物化一次且未进入执行器 | INV-1/INV-2 | `packages/agent-sdk/test/turn.test.ts` + `electron/claudeStreamHandlers.hostedIntegration.test.ts` |

### 2.6 迁移与回滚

- **无数据迁移**：不改 schema、不回填历史事件；新增字段一律可选。
- **回滚**：改动集中在**四处**（宿主策略端口的 deny 出口、文案映射定义、SDK 初次拒绝的历史物化、执行器统计与装配层投影）。回滚 = 还原这四处；旧事件读取路径不依赖新字段。
- **兼容窗口**：文案映射新增原因码属纯增量；删除原因码映射需保留回退文本，避免「拒绝对话文本消失」。

### 2.7 非目标

- 不改任何放行/拒绝判定，不新增规则、不动档位与 floor。
- 不引入「给模型看的话」的自动生成（不调模型生成解释）。
- 不处理 `llm-wiki` 目录骨架与词汇路径问题（另一份计划）。
- 不追求把全部历史 0 值记录修正（只保证新记录可信）。

---

## 3. 执行计划

### 3.1 依赖表

```text
A-01 → A-02 → A-03 → A-04 → A-05
B-01 → B-02 → B-03 → B-04 → B-05 → B-06
A-05 ─┐
B-06 ─┴→ C-01 → C-02(外部)
```

- A 段（可诊断性）与 B 段（审计事实）**互不依赖**，可并行；两段都完成后才做 C 段收尾。
- A 段顺序：宿主填文案（A-02）→ SDK 历史物化同源（A-03）→ 三处一致性断言（A-04）→ 决策矩阵不变（A-05）。**A-03 是实现改动**（评审 R-2 明确：不能只加 SDK 测试而排除实现修改）。
- B 段顺序：**执行层**先按真实写前 / 写后内容产出统计（B-02），**装配层**才能投影（B-03）；顺序不可颠倒，否则 B-03 无值可取。
- **收尾唯一入口（评审 R-3）**：C-01 只依赖 `A-05`、`B-06`；从 C-01 反向遍历必须经过 `A-04 → A-03`（SDK 修复及其三处一致性验收）—— 与 §3.2 的 A 段串行依赖逐项一致。**A-04 未完成时 C-01 不得启动**；不存在「A-02 完成即可收尾」的并行解读。
- 无跨阶段环；C-02 为外部验收，不阻塞 A/B。

### 3.2 阶段与任务

> 状态标记：`- [ ]` 未开始｜`- [～]` 进行中｜`- [x]` 完成（须有证据）

#### 阶段 A：拒绝原因可诊断（对应 D1、D3）

| ID | 动作 | 依赖 | 目标文件 / 模块 | 产物 | 完成判据 | 验证命令 | 环境 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A-01 | 建立「拒绝原因 → 模型可见文案」映射骨架（含未命中回退） | — | `src/shared/confirmation/`（新增集中定义，落点实现时可调） | 映射表 + 类型 + 单测 | 命中/未命中/非法输入三类用例通过；映射项不含绝对路径 | `npm exec vitest run <新增测试文件>` | 本机 |
| A-02 | 宿主策略端口的 deny 出口携带模型可见文案（保持原因码枚举不变） | A-01 | `electron/confirmation/agentSdkSafetyPolicy.ts` | 代码 + 单测 | AC-1、AC-2 通过；未登记原因码文本逐字不变 | `npm exec vitest run electron/confirmation/agentSdkSafetyPolicy.test.ts` | 本机 |
| A-03 | **SDK 初次拒绝的历史物化带上文案**：把同一段文案一并交给 `markNotDispatched`，使历史与当轮取同一文本 | A-02 | `packages/agent-sdk/src/turn.ts`（初次 deny 分支及其 `markNotDispatched` 调用点） | 代码 + 用例 | AC-11 通过（三处文本一致）；未映射原因码保持旧文本 | `npm exec vitest run packages/agent-sdk/test/turn.test.ts` | 本机 |
| A-04 | 三处一致性端到端断言（真实 SafetyGate → turn 拒绝链路） | A-03 | `packages/agent-sdk/test/turn.test.ts`、`electron/claudeStreamHandlers.hostedIntegration.test.ts` | 用例 | AC-1、AC-2、AC-11 通过；历史只物化一次；执行器未进入（`executorEntry: 'not-entered'`） | `npm exec vitest run packages/agent-sdk/test/turn.test.ts electron/claudeStreamHandlers.hostedIntegration.test.ts` | 本机 |
| A-05 | 决策矩阵不变回归 | A-04 | 既有等价性用例 | 回归记录 | AC-4 逐条一致 | `npm exec vitest run electron/confirmation/toolDecisionMatrix.test.ts src/shared/policy/defaultRules.contract.test.ts` | 本机 |

#### 阶段 B：免确认写入记录可信（对应 D2）

| ID | 动作 | 依赖 | 目标文件 / 模块 | 产物 | 完成判据 | 验证命令 | 环境 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| B-01 | 冻结字段语义（`path` / `bytesWritten` / `added` / `removed`）并同步审计字段映射表 | — | `src/shared/domainTypes.ts`（字段注释）、`docs/develop/security-policy-audit-field-map.md` | 类型注释 + 文档一行 | 两处表述一致；不可用态有明确表达方式 | 人工核对 + `rg -n 'autoApprovedWrite\|bytesWritten' src/shared/domainTypes.ts docs/develop/security-policy-audit-field-map.md` | 本机 |
| B-02 | **执行层**：两类写工具在写盘成功后，基于**实际使用的写前内容与最终写入内容**产出统计（`bytesWritten` / `added` / `removed`），随执行结果返回；覆盖换行归一与转义回退路径 | B-01 | `electron/tools/builtinExecutors.ts`（写盘实现）、`electron/tools/writeFileRegisteredTools.ts`（如需透出字段） | 代码 + 单测 | AC-9 通过；两类工具口径同一（写入后文件字节数 + 相对实际写前内容的行数增减）；F-10 不再成立 | `npm exec vitest run electron/tools/builtinExecutors.editDiagnosis.test.ts electron/tools/builtinExecutors.fileState.test.ts` | 本机 |
| B-03 | **装配层**：记录只做关联与投影 —— 挂靠本次调用已冻结的权威写入目标、直接取执行结果里的统计；**删除**自行重演编辑与自行解析路径 | B-02 | `electron/runtime/invocationAssembler.ts`（记录构造点）、`electron/confirmation/confirmDiff.ts`（本用途调用退役） | 代码 | AC-5、AC-6 通过（含「同名目录」现场不得读错对象） | `npm exec vitest run electron/runtime/invocationAssembler.test.ts` | 本机 |
| B-04 | **兜底与失败隔离**：取不到权威目标或统计时标记不可用（**不写 0**）；写盘失败不生成成功写入事实 | B-03 | 同 B-03 | 代码 + 用例 | AC-6 不可用分支、AC-10 通过 | `npm exec vitest run electron/runtime/invocationAssembler.test.ts` + 新增用例 | 本机 |
| B-05 | `file.auto_approve` 日志与记录同源，不可用场景显式标注 | B-04 | `electron/runtime/invocationAssembler.ts`、`electron/agentLogger/types.ts`（如需新增字段值） | 代码 + 日志断言 | AC-7 通过 | `npm exec vitest run electron/claudeStreamHandlers.hostedIntegration.test.ts` | 本机 |
| B-06 | 历史事件兼容与投影回归 | B-05 | `electron/messageCodec.ts` 相关用例、`src/shared/processResultProjection.ts` 投影用例 | 回归记录 | AC-8 通过；模型面/遥测面仍不出现该字段 | `npm exec vitest run electron/messageCodec.test.ts src/shared/processResultProjection.test.ts` | 本机 |

#### 阶段 C：收尾

| ID | 动作 | 依赖 | 目标文件 / 模块 | 产物 | 完成判据 | 验证命令 | 环境 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| C-01 | 更新现状文档与在途登记 | A-05、B-06 | `docs/develop/safety-approval/确认与审批-现状.md`、主题 `README.md`、`history.md` | 文档 | 现状文档新增可复现命令的结论；README 在途项状态更新 | 人工核对（`rg -n '拒绝可诊断\|autoApprovedWrite' docs/develop/safety-approval`） | 本机 |
| C-02 | 实机复跑原场景（见 §4） | C-01 | — | 验收记录 | 见 §4 | — | **外部** |

### 3.3 门禁与环境说明

- 本机可执行门禁：上表全部 `npm exec vitest run …` 命令（开发阶段按 `AGENTS.md` 用**定向测试**，不跑全量）。
- 阶段收尾：`npm run typecheck:renderer`（若触及共享类型）、`npm run build:electron:incremental`（每阶段至多一次）。
- 外部（不阻塞开发）：§4 的实机复跑。
- 提交纪律：文档改动与代码改动**分开提交**（沿用仓库既有纪律）。

---

## 4. 外部验收（不阻塞源码关闭）

| ID | 场景 | 通过判据 | 为什么必须在真机 |
| --- | --- | --- | --- |
| E-1 | 在真实应用中触发一次「写入目标目录不存在」的拒绝，观察 AI 收到的文本，并重新打开该会话 | 当轮文本含可操作说明与按 D1 选定的标识；**重新加载后历史里那条拒绝的解释与当轮逐字一致**；AI 不再盲搜规则名 | 需要真实运行的应用 + 真实模型回合 + 会话重载 |
| E-2 | 在真实应用中确认一次「免确认自动写入」的审计记录 | 记录数字与文件实际变化一致；`file.auto_approve` 日志一致 | 需要真实用户目录与真实写入 |
| E-3 | 构造「工作目录内存在同名目录」现场，触发自动写入 | 记录指向真实被写目标且数字与文件实际变化一致；仅当权威目标确实缺失时才标不可用 | 需要真实工作目录布局 |

---

## 5. 交付前自检

1. 裁决条目（D1–D3）六要素齐全，可单独摘出裁决：✅（背景 / 选项 / 后果 / 可逆性 / 依据强度 / 推荐与默认）。
2. 裁决条目无代码标识符与内部编号（编号仅出现在「下钻」处）：✅。
3. §0 已写「不需要你决定」的边界，且未把事实问题包装成决策：✅（U-1 列为未验证假设，不要求裁决）。
4. 事实断言均带复现命令与基线提交 `8c7dce0e`（另标评审复核基线 `1f22be0f`）：✅（§2.1，含 F-12 / F-13）。
5. 承诺配对：本方案**不主张**原子性 / 实时性 / 幂等性等强断言，无需配对机制。D2 已定为 A，其落地机制**不是**再叠一层「挂载感知解析」，而是 ① 删除装配层的重复解析、改用已冻结的权威目标（F-11）；② **统计的唯一起源移到执行器**（评审 R-1：预览重演与执行语义不同，只有执行器掌握真实写前 / 写后内容），装配层只做关联与投影（B-02 / B-03、AC-5 / AC-6 / AC-9 验证）。
6. 未验证项已显式列出（U-1、U-2）并标明由谁拍板（U-1 属实现期验证，不需人拍板）：✅。
7. AC 全部可观测、有落点用例，且任务只引用 AC 未新造验收：✅（§2.5 ↔ §3.2；AC-11 由评审 R-2 追加，A-03 / A-04 直接引用）。
8. 门禁全部在本机可执行；实机项已单列 §4：✅。
9. 评审闭环（2026-10-17）：**R-1**（假行数：预览重演 ≠ 执行语义）落到 F-12、契约二、场景矩阵、AC-9、B-02；**R-2**（历史丢解释）落到 F-13、「三处同源」契约、AC-11、A-03 / A-04；两条的关闭证据均可在本机执行，不依赖外部验收。
