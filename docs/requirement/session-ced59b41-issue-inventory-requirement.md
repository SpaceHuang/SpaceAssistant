# 会话 ced59b41：Agent 工具使用与安全审核机制 — 问题清单

**版本：** 0.1
**日期：** 2026-09-23
**状态：** 问题清单，待评审
**关联文档：**

- [security-approval-concurrency-limits-and-observability-requirement.md](./security-approval-concurrency-limits-and-observability-requirement.md)（安全审批并发、配额与可观测性问题清单；本清单为其会话侧实证补充，体例一致）
- [../develop/security-approval-experience-improvement-plan.md](../develop/security-approval-experience-improvement-plan.md)（审批链路体验改进方案）
- [../plan/run-shell-lifecycle-local-execution-todo.md](../plan/run-shell-lifecycle-local-execution-todo.md)（run_shell 生命周期计划）
- [tool-confirmation-top-level-design-v2.md](./tool-confirmation-top-level-design-v2.md)（确认机制顶层设计）

> **本文性质**：对会话 `ced59b41-7799-4b1f-b902-51f1c863fe53` 实测数据的清点，只陈述「问题 / 表现 / 原因 / 危害」四要素与可复核证据，**不含解决方案与改进建议**。文末「待决议题」「待核实项」为需另行裁定的事项。

---

## 1. 范围、基线与数据来源

### 1.1 基线

| 项 | 值 |
| --- | --- |
| 会话 id | `ced59b41-7799-4b1f-b902-51f1c863fe53` |
| 会话名 | 会话 4 |
| 模型 | `deepseek-v4-pro`；`maxTokens: 4096`；`temperature: 0.7` |
| 运行时刻 | 2026-09-23 07:35:23 – 07:43:28 CST（约 8 分钟，3 轮） |
| **代码基线** | **`a6959a75`**（`docs: 清理范围外文档中的本机路径与未入库目录引用`） |
| 与当前 HEAD 的差异 | 审批体验改进 `001665df`（`feat(security): improve approval concurrency and recovery`）于 **2026-09-23 16:16 CST** 合并（`2ef577bb`），**晚于本会话** |

**基线声明的作用**：本会话运行在审批并发改进上线**之前**，因此第 3、4、5 章记录的是旧实现下的行为；凡在 `001665df` 中已被改动的项，一律移入第 6 章「已改进、待观察效果」，不再计入当前问题。第 3 章另有若干项经核对在当前 HEAD **逐字节未变**，仍属现存问题（逐条标注）。

### 1.2 数据来源

| 来源 | 内容 |
| --- | --- |
| `sessions/ced59b41-7799-4b1f-b902-51f1c863fe53-20260922/events.jsonl` | 35391 行事件流：`assistant_chunk` 35141、`tool_call` 46、`tool_result` 46、`request_context` 86、`request_header` 30、`request_usage` 29、`turn_start`/`step_start`/`step_end`/`turn_end` 各 3、`request_retry` 1 |
| `.agent/logs/SecurityAudit-20260923.log` | 本会话 **64** 条安全审计记录（`policy.decision` / `confirm.request` / `confirm.outcome`） |
| `action.session.read`（产品能力） | 会话消息 6 条（sequence 0–5） |
| `sessions/.../messages.json` | 空 `messages` 数组（`exportedAt: 1790118036369`），仅为导出快照 |
| 代码 | 按 1.1 基线检出核对；另与当前 HEAD 对比 |

> 注：仓库根目录 `logs/` 为陈旧副本（最后写入 2026-09-04/21），**不含本会话**；真实日志目录为 `.agent/logs/`。

### 1.3 证据强度标注约定

- **【实测】**：有会话事件流或审计日志直接支持。
- **【代码推理】**：由代码事实推得，会话数据不足以直接证明。

### 1.4 一处口径说明

`events.jsonl` 中的 `tool_result` 记录为**精简形态**，不含 `data` 字段：

```json
{"result": {"success": false, "error": "SHELL_INTERACTIVE_TTY_REQUIRED"}}
```

它**不等于**模型实际可见的 `tool_result` 内容。模型可见内容以投影链（`serializeAgentToolResult` → `projectAgentToolResultForSink`）为准。凡涉及「模型看到了什么」的判断，均按【代码推理】标注。

---

## 2. 会话事实摘要

### 2.1 三轮概览

| 轮 | turnId | 开始 (CST) | 结束 (CST) | `turn_end.reason` |
| --- | --- | --- | --- | --- |
| 1 | `34673054-…-d3e28e4ca21e` | 07:35:25 | 07:37:04 | `error`（`error: "用户已中止"`） |
| 2 | `07553b73-…-b4f674b76196` | 07:37:35 | 07:39:13 | `completed` |
| 3 | `78c77e87-…-27d40eaea782` | 07:41:24 | 07:43:28 | `completed` |

第 1 轮由**用户主动中止**（`step_end {reason:"error"}` + `turn_end {reason:"error", error:"用户已中止"}`），非 Agent 输出失败。

### 2.2 安全审计流水（本会话 64 条，摘要）

| 事件 | 次数 | 备注 |
| --- | --- | --- |
| `policy.decision` = `require-confirm` | **14** | 9 次产生配对 `confirm.request`，5 次未产生（见 2.3） |
| `confirm.request` | **9** | 全部 `actor: "agent"` |
| `confirm.outcome` | **9** | 8 次 `approved`（`cause: agent-approved`）；1 次 `rejected`（`cause: agent-deny`） |
| `admission.*` | **0** | 无任何准入事件 |

审批延迟（`latencyMs`）：2134 / 3205 / 4217 / 6377 / 1922 / 1625 / 4490 / 1378（approved）、2092（rejected）。

> **结论性事实**：本会话中安全审核机制**按设计工作** —— 9 次裁决全部完成并成对落审计，唯一的拒绝（`run_script`）有明确裁决理由。会话**未出现并发审批**，故安全审核的并发能力问题（见第 6 章）在本会话**未被暴露**。

### 2.3 第 3 轮 6 次写操作尝试的结局

| # | 工具 | 命令要点 | 结果 |
| --- | --- | --- | --- |
| 1 | `run_shell` | `git add … && git diff --cached --stat && git commit -m "…top-level-design-v2.md…"` | `SHELL_INTERACTIVE_TTY_REQUIRED` |
| 2 | `run_shell` | `GIT_EDITOR=true GIT_TERMINAL_PROMPT=0 git commit --no-gpg-sign -m "…top-level-design-v2.md…"` | `SHELL_INTERACTIVE_TTY_REQUIRED` |
| 3 | `run_shell` | `script -q /dev/null git commit --no-gpg-sign -m "…top-level-design-v2.md…"` | `SHELL_INTERACTIVE_TTY_REQUIRED` |
| 4 | `run_script` | subprocess 调 `git commit` | **安全审批拒绝**（`agent-deny`，`notExecutedReason: agent_denied`） |
| 5 | `run_shell` | `git add .gitignore "docs/requirement/tool-confirmation-top-level-design-v2.md" && …` | `SHELL_INTERACTIVE_TTY_REQUIRED` |
| 6 | `run_shell` | `git update-index --add .gitignore "docs/requirement/tool-confirmation-top-level-design-v2.md" && …` | `SHELL_INTERACTIVE_TTY_REQUIRED` |

**关键共性【实测】**：5 次 `SHELL_INTERACTIVE_TTY_REQUIRED` 的失败命令，**5/5 均含字符串** `docs/requirement/tool-confirmation-top-level-design-v2.md`。

**审计配对对照【实测】**：5 次未产生 `confirm.request` 的 `require-confirm`，时间戳与上述 5 次失败逐一对应：

| `require-confirm` ts | 对应失败命令 |
| --- | --- |
| 1790120495700 | #1 `git add …` |
| 1790120506916 | #2 `GIT_EDITOR=true … git commit` |
| 1790120538617 | #3 `script -q … git commit` |
| 1790120574499 | #5 `git add …` |
| 1790120598026 | #6 `git update-index --add …` |

> 该对照说明：这 5 条命令**已通过策略判定进入 `require-confirm`**，随后在计划阶段被拒，未产生审批请求。此为能力层在授权层之前的**正常**先后关系（见 3.1 说明），**本身不是缺陷证据**；它只用于确认「命令确实止步于能力层」。

### 2.4 最终落库结果

会话结束后约 1.5 小时，提交 `08807968`（2026-09-23 09:04 CST）落地，内容与用户「只改这次的内容」的要求一致：11 个文档删除 + `.gitignore` 3 行 + `tool-confirmation-top-level-design-v2.md` 1 处改动。即**收尾工作由用户手工完成**（提交信息与 Agent 建议一致）。

---

## 3. 问题一：Agent 工具使用

### A-1 `run_shell` 的 TUI 交互命令检测存在假阳性【实测】

**问题**：交互式/TUI 命令检测器按**整条命令文本**做词边界匹配，导致普通命令被误判为「需要交互式终端」而拒绝执行。

**表现**：第 3 轮 6 次写操作尝试中 5 次失败，错误码均为 `SHELL_INTERACTIVE_TTY_REQUIRED`；其中包含 `git add`、`git commit`、`git update-index` 等**纯非交互**命令。两次 `git commit`（#2 `GIT_EDITOR=true`、#3 `script -q /dev/null`）之所以被拒，**仅因 commit message 正文提及文件名 `…top-level-design-v2.md`**。

**原因**：
- `src/shared/shellInteractiveTui.ts` 定义：

  ```ts
  const INTERACTIVE_TUI_PATTERNS: RegExp[] = [
    /\bless\b/i, /\bmore\b/i, /\btop\b/i, /\bhtop\b/i, /\bvim\b/i, /\bvi\b/i,
    /\bnano\b/i, /\bemacs\b/i,
    /\bnpm\s+init\b(?![^\n]*\s-y\b)/i, /\bgit\s+rebase\b[^\n]*-i\b/i, /\bgit\s+-i\s+rebase\b/i
  ]

  export function isInteractiveShellTuiCommand(command: string): boolean {
    const t = command.trim()
    if (!t) return false
    return INTERACTIVE_TUI_PATTERNS.some((re) => re.test(t))
  }
  ```

  判定对象是**整条命令字符串**，而非各子命令的**命令位（argv[0]）**。
- `\b` 在连字符与字母之间成立：`top-level` 中的 `top` 满足 `/\btop\b/i`。同一机理适用于 `less`/`more`/`vi`/`nano`/`emacs`/`htop` 等词出现在**路径、文件名或提交信息**中的情形。
- `electron/tools/runShellPlan.ts` 在 spawn 前抛出，`details` 为空：

  ```ts
  if (isInteractiveShellTuiCommand(command)) {
    throw new RunShellPlanError('SHELL_INTERACTIVE_TTY_REQUIRED', 'SHELL_INTERACTIVE_TTY_REQUIRED')
  }
  ```
- **版本核对**：`git diff a6959a75 HEAD -- src/shared/shellInteractiveTui.ts` 为空 —— **该检测器自会话基线以来逐字节未变**，属现存问题，非历史版本问题。

**误伤面（同一正则实测，2026-09-23）**：

| 命令 | 判定 | 命中 |
| --- | --- | --- |
| `git add … "docs/requirement/tool-confirmation-top-level-design-v2.md"` | 拒绝 | `\btop\b` |
| `git commit -m "chore(docs): 归档已废弃的后台 Mission 执行层设计文档"` | 放行 | — |
| `git commit -m "fix: more cleanup"` | **拒绝** | `\bmore\b` |
| `git commit -m "docs: update vi-usage guide"` | **拒绝** | `\bvi\b` |
| `git add docs/vi-usage.md` | **拒绝** | `\bvi\b` |
| `git add docs/nano-banana.png` | **拒绝** | `\bnano\b` |
| `cat docs/htop-report.md` | **拒绝** | `\bhtop\b` |
| `git add src/less-loader.config.js` | **拒绝** | `\bless\b` |
| `git commit -m "refactor: emacs-config 拆分"` | **拒绝** | `\bemacs\b` |
| `npm run build` | 放行 | — |

**界面层的同源影响【代码推理】**：`src/renderer/components/Chat/ShellTuiFallbackHint.tsx` 复用同一函数决定是否渲染提示：

```tsx
if (!isInteractiveShellTuiCommand(command)) return null
```

故同一误判会**同时**在后端拒绝执行、并在界面渲染「此命令需要交互式终端」与「打开终端」按钮。

**危害**：
- 常规非交互开发命令（暂存、提交、索引操作）无法在应用内执行，**任务无法闭环**，只能由用户在外部终端手工收尾（本会话即如此，见 2.4）；
- 误伤面覆盖任意含 `less`/`more`/`vi`/`nano`/`emacs`/`top`/`htop` 词素的路径、文件名与提交信息，**触发概率随仓库内容增长**；
- 失败信息指向「交互式终端」，与实际原因（文本误匹配）完全无关，用户与 Agent 均难以定位；
- 现有回归测试（`src/shared/shellInteractiveTui.test.ts`）未覆盖此类误伤，计划文档 `run-shell-lifecycle-local-execution-todo.md` 亦将该能力标为 `[x]` 已完成，属**计划未识别的缺陷**。

**关联**：词表机制的直接动机是避免交互式程序在应用内阻塞（见 A-5）。但该阻塞的底层成因（主执行链路 stdin 未配置为非交互）另有更轻的解法，且 `src/renderer/components/Chat/ShellTuiFallbackHint.tsx` 的界面判定与提示（见 A-4）均随之继承同一误判。三条目应合并评估。

### A-2 计划期能力拒绝的错误信息不足以让模型自查【实测+代码推理】

**问题**：`SHELL_INTERACTIVE_TTY_REQUIRED` 返回给模型的信息**没有解释力** —— 既未说明命中了什么模式，也未说明该错误属于「能力/环境」而非「策略/授权」。

**表现**：Agent 连续 5 次撞同一原因，始终未能定位到「文件名里的 `top`」，最终转向绕过方案。

**原因**（模型可见 payload 由 `runShellExecutor` 返回体经投影链得到）：

```ts
// electron/tools/runShellExecutor.ts（plan 失败分支）
return {
  success: false,
  error: code,
  data: {
    code, reason: message, processResult: null,
    ...planError?.details,                    // ← TTY 分支为空对象
    caseId: SHELL_CASE_IDS.tuiRequiresTerminal,
    ...(code === 'SHELL_INTERACTIVE_TTY_REQUIRED' ? { hints: shellTuiFallbackHintLines() } : {})
  },
  duration: Date.now() - started
}
```

- **`details` 为空**：对比同族错误 `SHELL_EXECUTABLE_UNAVAILABLE` 带 `{ executable }`、`SHELL_DIALECT_MISMATCH` 带 `{ signals, detectedSyntax, expectedDialect, shellProfileId }`，TTY 分支**不携带任何命中信息**。
- **`reason` 退化为错误码副本**：构造时 `message` 即传入 `'SHELL_INTERACTIVE_TTY_REQUIRED'`，故 `reason` 与 `error` 字面相同。（投影层 `hasPlanDiagnosticMarker` 对 `code` 匹配 `^SHELL_[A-Z0-9_]{1,48}$` 者**放行** `reason` 自由文本，即**通道存在但无内容可放**。）
- **提示为静态模板**：`shellTuiFallbackHintLines()` 是**无参数**函数，所有 TUI 判定共用同一文案，与实际命令无因果关系：

  ```ts
  export function shellTuiFallbackHintLines(): string[] {
    return [
      'SpaceAssistant 内的 run_shell 为只读输出，无法承载 less、vim、top、交互式 npm init 等全屏或需输入的程序。',
      '请在外部系统终端中于工作目录下自行执行该命令；可使用下方按钮打开终端。'
    ]
  }
  ```

  第二行「可使用**下方按钮**打开终端」为**面向界面用户**的措辞（模型侧无「下方按钮」），却在模型通道中被复用。
- **文案双份维护且已分叉**：同一段提示在两处各存一份 —— 模型侧由 `shellTuiFallbackHintLines()` 硬编码中文；界面侧走 i18n（`shell.tuiTitle` / `shell.tuiLine1` / `shell.tuiLine2` / `shell.openTerminal`，见 `src/renderer/i18n/resources/zh-CN/chat.json`），且两处文字**逐字相同**。后果：①界面语言非中文时，模型仍收到中文提示；②文案任何改动需同时改两处，易漏；③`SHELL_TUI_FALLBACK_TITLE` 常量（`src/shared/shellInteractiveTui.ts:26`）已定义但全仓库无引用，其文字与 i18n 的 `shell.tuiTitle` 相同，属死代码。
- **缺少归因类别**：`ToolExecutorResult.diagnostic` 已具备该维度且会投影给模型：

  ```ts
  diagnostic?: { caseId: string; retryable: boolean;
                 category: 'command' | 'environment' | 'executor' | 'transport' | 'policy' }
  ```

  但 plan 失败返回体**未携带 `diagnostic`**；`validateToolExecutorResult`（`electron/tools/types.ts`）仅在**契约违规**时补 `category: 'executor'`，TTY 分支不触发。

  > 对照：DeepSeek Harness 以**文本标记 + 归因说明**替代类别字段 —— 被拒时回传 `[sandbox: file access denied under <mode> mode]` 并附「a policy denial, not a bug in the command」。见 A-5 对照段 ⑤。

**模型实际可见 payload【代码推理】**（依 `PROCESS_KEYS` 白名单：`hints`/`reason`/`caseId`/`code` 均在列，`hints` 经 `sanitizeAdviceList` 保留 ≤8 条、每条 ≤512 字符）：

```json
{"ok":false,"error":"SHELL_INTERACTIVE_TTY_REQUIRED","data":{
  "code":"SHELL_INTERACTIVE_TTY_REQUIRED",
  "caseId":"SHELL-CAPABILITY-001",
  "reason":"SHELL_INTERACTIVE_TTY_REQUIRED",
  "processResult":null,
  "hints":["SpaceAssistant 内的 run_shell 为只读输出，无法承载 less、vim、top、交互式 npm init 等全屏或需输入的程序。",
           "请在外部系统终端中于工作目录下自行执行该命令；可使用下方按钮打开终端。"]
}}
```

> 即：信息**已送达**模型，但**不构成可自查的解释** —— 无命中模式、无归因类别、提示与命令无关；5 次连续失败未产生任何可用于收敛的线索。

**危害**：
- 模型无法区分「能力/环境拒绝」与「策略/授权拒绝」，为 A-3 的直接诱因；
- 同一误判被反复重试（本会话 5 次），消耗轮次与 token，并将 Agent 推向替代执行通道的尝试（伪 TTY、换工具）；
- 排障困难：需人工比对正则与命令文本才能定位，审计与结果载荷均不含命中信息。

### A-3 把能力层拒绝表述为安全策略层拒绝【实测】

> 归属说明：本条为 **Agent 行为**问题，但其**诱因在宿主侧信息设计（A-2）**，两者需合并评估，不宜单独归咎于模型。

**问题**：Agent 在最终答复中将 `SHELL_INTERACTIVE_TTY_REQUIRED`（能力层错误码）解释为安全策略拦截，并给出了错误的机制描述。

**表现**（`sequence 5` 原文摘录）：

> 「`git add` 和 `git commit` 这两个操作**被本会话的安全策略拦下**（返回 `SHELL_INTERACTIVE_TTY_REQUIRED`，**要求交互式会话中人工确认**）。之前能执行的 `git mv`/`git rm --cached` 属于**可信任的文件移动/移除**，而「暂存/提交」被判定为**需要你本人确认的高风险操作**，我无法代替你批准。」

**原因【实测，两处真实信号被错误拼接】**：

1. **被误读的信号**：`SHELL_INTERACTIVE_TTY_REQUIRED`（能力层、无 `diagnostic`、提示不含策略语义，见 A-2）。
2. **被嫁接的信号**：同一轮 `run_script` 的审批拒绝理由中含有**审批侧话术**：

   > 「…本次为安全审批的机审拒绝…可用的获批途径：**让用户在交互式会话中对确认卡片手动批准**；将命令加入信任列表…；或把操作拆分为低风险只读步骤逐步完成。」

   `sequence 5` 的「要求交互式会话中人工确认」与该话术高度接近。
3. **事实核对**：审计显示 `git mv` 类操作（`set -e mkdir -p docs/废弃/…`、`git ls-files …` 等）**均经过 `require-confirm` 并由审批 Agent `agent-approved` 放行**，并非「可信任免审」。故「可信任 vs 高风险」的二分描述亦不成立。

**危害**：
- 用户获得的是**错误的机制解释**，据此形成的认知（「安全策略禁止 git commit」）与实际（文本误匹配）完全不符，可能误导后续决策；
- 该解释会被写入会话历史，成为后续轮次与复盘的事实来源；
- 掩盖真实缺陷：A-1 的假阳性因此被表述为「设计如此的安全策略」，**缺陷被合理化**。

**同类产品对照**：DeepSeek Harness 的工具描述中明文规定「策略拒绝不得换途径重试」「不得绕过工具通道去聊天征求许可」，与会话中的行为相反。见 A-5 对照段 ⑤。

### A-4 TUI 判定被重复计算，渲染层不消费权威结果【代码推理】

**问题**：同一项「是否属交互式 TUI 命令」的判定，在后端与渲染层**各自独立计算**；渲染层不消费后端已产出的权威结论。

**表现（三处计算点）**：

| # | 位置 | 作用 |
| --- | --- | --- |
| 1 | `electron/tools/runShellPlan.ts:102` | **后端权威判定**：命中即 `throw`，不创建子进程；拒绝结果带 `caseId: 'SHELL-CAPABILITY-001'` |
| 2 | `src/renderer/components/Chat/ShellTuiFallbackHint.tsx:36` | 决定是否渲染提示卡：`if (!isInteractiveShellTuiCommand(command)) return null` |
| 3 | `src/renderer/components/Chat/ToolCallCard.tsx:163` | `const isInteractiveTui = …`，用于 `useTerminalUi`（含 `!isInteractiveTui`） |

三处输入均为**原始命令文本**（`record.input.command`），而非执行结果。

**原因**：

- 检测器放在 `src/shared/shellInteractiveTui.ts`，主进程与渲染层共用 —— 渲染层因此「能算」，但**能算不等于该算**；
- **权威事实本可取得**：`ShellResultData.caseId`（`src/shared/shellToolDisplay.ts:32`）已定义该字段，渲染层亦已有解析入口（`ToolCallCard` 导入 `parseShellResultData`），但提示判定未使用它；
- 提示卡挂载点 `ToolCallCard.tsx:632` 只判断 `shellCommand` 非空，判定完全下沉到卡片内部重算。

**危害**：

- **同一事实双重推导**：三处当前一致，靠的是「恰好调用同一个函数」，属**耦合**而非**契约**。任一侧判据改动（如后端将来精确到 `argv[0]`），立即出现两种失真 —— 后端拒了而提示卡不显示（用户只见失败、无引导无按钮），或未拒而显示「此命令需要交互式终端」；
- **放大 A-1 的假阳性观感**：本会话 5 次失败命令（见 2.3）在界面同时得到「执行失败」与「此命令需要交互式终端 · 无法承载 less、vim、top…」，而实际命令可能是 `git add`；两条信息叠加，把误判进一步坐实为「确实需要终端」。

**说明**：本条与 A-1 同属 TUI 判定机制，但性质不同 —— A-1 是**判据错误**（误伤非 TUI 命令），本条是**判据被重复计算**（缺单一事实来源）。

### A-5 主执行链路未将 stdin 配置为非交互，读 stdin 的命令阻塞至超时【代码推理】

**问题**：主执行链路 spawn 子进程时**未指定 `stdio`**，沿用 Node 默认的全管道形态（`['pipe','pipe','pipe']`）。子进程的 fd 0 是一个**父进程持有、且从不关闭**的管道，读 stdin 的程序因此无法取得 EOF，只能一直等待，直至 `shellDefaultTimeoutSec`（默认 300 秒）超时终止。

**表现（推断）**：

| 命令 | 非交互环境下应有的行为 | 当前行为 |
| --- | --- | --- |
| `cat`（无参数） | 读 stdin 得 EOF，立即退出 | 阻塞至超时 |
| `python3` / `node`（REPL） | 读到 EOF 后退出 | 阻塞至超时 |
| `ssh host` | 无法输入口令，报错退出 | 阻塞至超时 |
| `psql` / `mysql` / `redis-cli` | 进入交互客户端（本应不可用） | 阻塞至超时 |
| `fzf` / `watch` | 无 TTY，行为退化或报错 | 阻塞至超时 |

上表命令**均不在** TUI 词表（A-1）内，故既不被前置拦截，也不会得到任何引导提示。

**原因**：

1. **主链路 spawn 未设 `stdio`**（`electron/tools/runShellExecutor.ts:322`）：

   ```ts
   proc = spawn(spec.executable, spec.args, {
     cwd: prepared.cwd,
     env,
     windowsHide: true,
     shell: false,
     detached: process.platform === 'darwin'
   })                                  // ← 未指定 stdio
   ```

   Node 默认 `stdio: 'pipe'` = `['pipe','pipe','pipe']`。父进程持有 `proc.stdin` 写端，既不写入也不关闭；只要写端未关闭，子进程读 fd 0 就**不会得到 EOF**。

2. **同仓库已有正确做法可对照**（`electron/spawnUtil.ts:93`，`runCommandWithTimeout`）：

   ```ts
   child = spawn(executable, [...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
   ```

   `'ignore'` 使 fd 0 指向空设备，读操作**立即返回 EOF**。该函数服务于启动路径与探测路径（如 `shellTestExecutable` 经 `spawnCommandSafe`），因此探测类命令从不受此影响。

3. **stdin 仅在终止路径被关闭**：`detachChildProcessStreams`（`spawnUtil.ts:109`）会执行 `proc.stdin?.destroy()`，但只在 kill / 超时收敛时调用 —— 即**阻塞已经发生之后**。

**与同类产品的对照（背景，非本清单的建议）**

对照材料：① DeepSeek Harness（`dsh`，DeepSeek AI 开源的 agent harness，本地检出源码，**源码实证、未运行该产品**）；② [ACP（Agent Client Protocol）v2 RFD](../../ref/agent-client-protocol-main/docs/rfds/v2/terminal-output.mdx)（本地检出规范）；③ 本仓库既有架构决策。

**核心结论：同类产品不判断"命令是否交互"，而是把执行环境配置成非交互形态，由程序自行降级。**

| 维度 | 本产品（会话基线 `a6959a75`） | DeepSeek Harness |
| --- | --- | --- |
| **stdin** | **未指定 `stdio`** → Node 默认 `pipe` → 读 stdin 阻塞 | `stdin: spec.stdin !== undefined ? { data: spec.stdin } : 'ignore'`（**默认 `ignore`**） |
| **环境压制** | 无 | `ENV_OVERRIDES = { NO_COLOR: '1', TERM: 'dumb', PAGER: 'cat', GIT_PAGER: 'cat' }` |
| **交互式命令检测** | **11 条正则，全文匹配** | **无**（全量扫描 `isInteractive` / `interactiveCommand` / `requiresTty` / `needsTty` / `tuiCommand` / `blockInteractive` **零匹配**） |
| **真交互需求** | 词表拒绝 + 引导用户去外部终端 | 独立 PTY 工具（`terminal/*` 六个工具 + `tool-bash-persistent`），与无状态 bash 工具分离 |
| **输出清洗** | 编码契约与字节诊断 | `TerminalSanitizer` 流式剥离 CSI/OSC，注释「Full terminal emulation is deliberately deferred」 |
| **失败归因** | 错误码无类别（见 A-2） | 工具描述中逐条说明归因与处置纪律 |
| **默认超时** | 300 s，无上限参数 | 120 s，上限 600 s；`graceMs` 3 s（SIGTERM→SIGKILL 升级） |

**① stdin 默认 `ignore`（`packages/shell/bash-local/src/index.ts:188`）**

```ts
stdio: {
  stdin: spec.stdin !== undefined ? { data: spec.stdin } : 'ignore',
  stdout: collect(stdoutMaxBytes),
  stderr: collect(this.config.maxOutputBytes),
}
```

只有调用方显式传入 stdin 数据时才用管道。即本清单 A-5 建议的形态，在 dsh 中是**默认值**。

**② 环境变量压制 —— 注释直接点名了竞品做法（`bash-local/src/index.ts:21-31`）**

```ts
/**
 * Model-friendly environment overrides: disable colors, pagers, and
 * interactive terminal features that would garble tool output (the same set
 * Codex hardcodes; Claude Code achieves it via TERM=dumb). ...
 */
export const ENV_OVERRIDES = {
  NO_COLOR: '1',
  TERM: 'dumb',
  PAGER: 'cat',
  GIT_PAGER: 'cat',
} as const
```

「the same set Codex hardcodes; Claude Code achieves it via `TERM=dumb`」—— 即 Codex 硬编码同一组变量、Claude Code 用 `TERM=dumb` 达成同一目的。Windows 路径同理走参数层：`pwsh -NoLogo -NoProfile -NonInteractive -Command`（`pwsh-local/src/index.ts:220`）。

**③ 无交互式命令词表**

上述关键词在 `packages/`、`apps/` 全量扫描**零匹配**；命中的 `interactive` 全为 pwsh 的 `-NonInteractive` 参数、PTY 会话描述或测试注释。其 bash 工具描述反而把边界讲清：「Each call runs in a fresh shell: no state (cwd, variables, functions) persists between calls — **pass `workdir` instead of using `cd`**.」

**④ 需要交互时给 PTY，而非拒绝命令**

- `packages/terminal/tool-terminal/src/index.ts`：「Six model-facing persistent terminal tools」
- `packages/shell/tool-bash-persistent/src/index.ts`：「Model-facing persistent `bash` tool **over the owner-scoped PTY seam**」
- 输出经 `TerminalSanitizer`（`terminal-bash/src/sanitize.ts`）洗 CSI/OSC，注释：**「Full terminal emulation is deliberately deferred」** —— 与 ACP「decode + sanitize + render transcript」同源

**⑤ 失败归因的表述纪律（`tool-bash/src/index.ts:77-91`，与本清单 A-2/A-3 直接相关）**

> 「a blocked file operation is reported as `[sandbox: file access denied under <mode> mode]` — **a policy denial, not a bug in the command; do not retry another way.**」
>
> 「**Do not detour through chat to ask permission first** — the approval prompt raised by that retry is how the user consents.」

即：① 明确告知模型该标记是**策略拒绝而非命令缺陷**，且**不得换途径重试**；② 禁止绕过工具通道去聊天里征求许可。本会话中 Agent 恰做了这两件被明文禁止的事（把能力错误码说成策略拦截、建议用户去外部终端手工执行，见 A-2/A-3）。

**⑥ ACP 侧的两点**

- 方向转变：v2 移除了 Client 侧 terminal 执行面，理由是「many Agents are moving toward their own sandboxing and execution configuration instead」；
- 无需为展示型终端输出设能力开关：其安全兜底为「decode the bytes, sanitize control sequences, and render a transcript」，并指出 `PTY output is a byte stream`、可能含非法 UTF-8 或跨块切断的码点。

**⑦ 与本产品既有决策的关系（须区分两件事）**

本仓库已在 v1.2 明确否决引入 PTY（`shell-output-terminal-enhancement-requirement.md:17`：「PTY 不做，维持 pipe」；OQ-3 同），理由是免 `node-pty` / `electron-rebuild` / 三平台 prebuild。**该取舍本身合理**，但它与「用命令名词表代替环境配置」是**两件独立的事**：dsh 的一次性 bash 路径（`tool-bash` + `bash-local`）本身即为**纯 pipe、无 PTY**，其不挂起靠的是 ①②，而非 PTY。故「不引入 PTY」不构成保留词表的理由。

**危害**：

- **单次调用阻塞 300 秒**（默认超时），长时间占用轮次与并发容量；
- **词表覆盖不到**：`python3`、`ssh`、`psql`、`fzf` 等均不在 A-1 词表内，既无前置拦截也无事后引导，用户与模型只能观察到一次「无输出的超时失败」；
- **与 A-1 的因果关系**：A-1 词表在 spawn 前拦截，其动机正是避免此类阻塞；但词表同时引入误伤（实测 10 例中 8 例误拒），而**更轻的修法（把 stdin 置为非交互）在项目内已有先例却未用于主链路** —— 即词表在替代本该由运行环境配置解决的事；
- 失败信息不含「为何卡住」，排障需人工推断子进程 stdin 状态。

**说明**：本节为【代码推理】—— 依据代码事实（主链路无 `stdio`；对照实现为 `['ignore','pipe','pipe']`；`stdin` 仅在终止路径销毁），**未取得实测样本**：本会话 6 次写操作尝试均止步于 A-1 的前置拒绝，未触达执行阶段。见**待核实项 V-7**。

---

## 4. 问题二：安全审核机制（本会话未暴露功能问题）

### B-0 本会话的结论

**本会话未暴露安全审核机制的缺陷**，理由（均【实测】）：

1. 9 次审批全部完成并成对落审计（`confirm.request` / `confirm.outcome`），无中断、无超时、无 `unavailable`；
2. 唯一的拒绝（`run_script`，`cause: agent-deny`，2092 ms）理由明确（「证据中无可用脚本内容或目标路径可供侦查核实，信号与摘要均无法收窄实际风险，故拒绝」），属 fail-closed 的一致行为；
3. 无任何 `admission.*` 事件，无并发审批 —— 即**未触达**并发/配额相关路径。

因此，以下两点须明确区分：

- **会话中「安全审核」相关的表象问题（A-3）**，其实体是**能力层的假阳性被误述**（A-1/A-2），与审批机制无关；
- **审批机制已知的并发能力问题**，在会话基线（`a6959a75`）**确实存在**，但在本会话**未触发**，其影响**不能由本会话数据支持**（见第 6 章及「待核实项 V-3」）。

### B-1 会话基线存在的审批侧问题（已移入第 6 章）

会话基线存在、且已由 `001665df` 改动的审批侧项，统一见第 6 章，包括：

- 同一通道并发请求互相覆盖（单值 `inflightCancelId` / `inflightSettle`）；
- 超时路径绕过统一终结出口、准入票据不释放；
- 审批与任务共用小时配额（双计）；
- 审批声明不排队、资源不足即拒绝；
- 结论层不可区分（「没拿到裁决」与「裁决为否」同形）；
- 拒绝理由不下发渲染层；
- 审批调用使用外层模型、无独立快模型档位。

另有 P-9「审批路径信任点击静默丢弃」在本次改动中**未见结案证据**，见第 6 章 O-4。

---

## 5. 记录层：中止态不可见【实测】

### C-1 用户中止在消息层不可区分

**问题**：会话记录**知道**该轮被用户中止，但该事实**不体现在消息数据中**，导致中止、真实故障、应用退出残留、启动清理四种情况在消息层**完全同形**。

**表现【实测】**：

| 层 | 事实 | 证据 |
| --- | --- | --- |
| 事件流 | **明确记录中止** | `turn_end {reason:"error", error:"用户已中止"}`（ts 1790120224459）、`step_end {reason:"error"}` |
| 会话消息 | **不可见** | `action.session.read` 仅返回 `sequence/role/timestamp/content`；第 1 轮 assistant 消息 `content: ""`，无任何状态字段 |

即：该轮在记录中呈现为「一条空白的助手消息」，无法分辨「用户按了停止」还是「生成失败」。

**原因【实测+代码推理】**：

1. **消息状态模型无中止取值**：`src/shared/domainTypes.ts:11`

   ```ts
   export type MessageStatus = 'sending' | 'sent' | 'queued' | 'streaming' | 'completed' | 'failed'
   ```

   无 `cancelled` / `aborted`。**版本核对：该定义在当前 HEAD 仍未变**（`001665df` 仅给 `ToolCallResultPersisted.notExecutedReason` 增加了 `confirm_cancelled`/`confirm_unavailable`，**未涉及 `MessageStatus`**）。
2. **占位消息机制**：`src/shared/turnCoordinator.ts` 在发起回合时即写入占位 assistant 消息（`content: ''`、`status: 'streaming'`，见第 114 / 123 行）；用户中止后该占位未被 finalize，且 `sequence 0` 与 `sequence 1` 时间戳完全相同（`1790120123430`），即同一次写入的请求侧与占位侧。
3. **中止事实只进用量统计，不进消息**：
   - `electron/toolChatLoop.ts:827`：`turnOutcome = result.ok ? 'completed' : result.cancelled ? 'cancelled' : 'failed'`
   - `electron/usageStats/usageStatsRecorder.ts:42`：`UsageTurnOutcome = 'completed' | 'failed' | 'cancelled' | 'timed-out' | 'recovered' | 'interrupted'`
   - 该 `outcome` 仅写入用量事实（`recordTurnSummary`），消息态不受影响。
4. **残留清理统一改写为 `failed`**：`src/shared/turnCoordinator.ts:406-407` 对 `status === 'streaming'` 的残留消息（含真实故障、应用退出、下次启动清理）一律置为 `'failed'`，与用户中止**同形**。
5. **读取接口裁掉状态**：`messages` 表含 `status`、`thinking`、`tool_use`、`tool_calls`、`content_segments` 等字段，但 `action.session.read` 只透出 5 个字段。

**危害**：
- **误导复盘与审计**：本次分析过程即据此将第 1 轮误判为「Agent 首轮空回复故障」，经用户说明后才更正 —— 该缺陷已被实证会造成误判；
- 用户回看历史时无法确认「是我中止的」还是「出错了」，也无法区分应用异常退出与主动停止；
- **推测项**：后续轮次从历史读取时，仅能看到「上一轮我未输出任何内容」，看不到「上一轮被中止」，缺少纠错信号（本会话第 1 轮的错误理解即由此未被纠正）。
- 数据一致性：事件流与消息层对同一事实的表述不一致，跨层核对成本高。

---

## 6. 已改进、待观察效果（会话基线存在，当前 HEAD 已改动）

> **本章性质**：以下各项在会话基线 `a6959a75`**存在**，并已在 `001665df`（2026-09-23 16:16 CST 合并，晚于本会话）中改动。
> **本章证据以代码对比（`git diff a6959a75 001665df`）为主，属【代码推理】；端到端行为是否为**实测**，故列入「待观察改进效果」，不作为已结项。
> 本章**不计入当前问题清单**（第 3、4、5 章为现存问题）。

### 6.1 审批通道并发覆盖与票据释放

| # | 会话基线行为 | 已改动 |
| --- | --- | --- |
| 1 | `AgentChannel` 用**单值**字段持有进行中调用：`private inflightCancelId: string \| null`、`private inflightSettle: (...) \| null`，`finally` 中置 `null`。同一通道的并发请求会互相覆盖，`cancel` 会打断其他 attempt，结算丢失 | 改为 `private readonly inflight = new Map<string, { settle; cancel }>()`，每次 attempt 独立持有；`cancel` 遍历全部活动 attempt |
| 2 | 内层请求 ID 不唯一：`innerRequestId = \`${requestId}:approval\``，同一 requestId 的多次 attempt 共用，取消与审计关联串扰 | 追加 `${invocationId}` 后缀，逐次 attempt 唯一 |
| 3 | **超时路径绕过统一终结出口**：`timer` 直接 `settled = true; resolve({cause:'timeout'})`，不经 `finish`，故 `admissionTicket?.release()` 不执行，**准入票据不释放** | 超时改走 `finish({...})`，票据释放、审批队列取消、`approvalRelease` 统一在 `finish` 内完成 |
| 4 | 准入成功回调未检查 `settled`，迟到票据可能启动已结束的审批 | 新增 `if (settled) { admission.release(); return }` 守卫 |

### 6.2 独立审批资源域与配额口径

| # | 会话基线行为 | 已改动 |
| --- | --- | --- |
| 5 | 审批声明 `disposition: 'reject'`，拿不到准入位**立即失败**并表现为「审批拒绝」；`queueLimit` 对审批路径实际不生效 | 新增 `ApprovalAdmission`（`packages/agent-core/src/approval.ts`）：独立 `concurrency` / `queueLimit` / `maxInFlightPerParent` + 超时 + `cancel`，**有界排队** |
| 6 | 审批与任务**共用同一小时配额**：嵌套准入 `lane` 继承等待方，`applyAdmit` 再计一次，`applyRelease` 不回退 `windowStarts` → 双计（标称 120/h 实际约 60 个带审批回合） | 新增 `ApprovalAdmissionLike` 分支：存在时**不占用任务启动准入计数**；`CapacityLedger`（`capacity.ts`）把 application lease 与 approval candidate 分账 |
| 7 | 恢复已受理身份会重复计小时配额 | 新增 `judgeResumeAdmission` / `applyResume`（`electron/runtime/callAdmission.ts`），**不重复计入**小时启动次数 |
| 8 | 同 turn 工具逐个 `await`（`for (const tu of toolUses)`），一个审批阻塞后续所有工具（含只读） | 引入 `packages/agent-core/src/scheduler.ts`、`resourceLock.ts`、`semaphore.ts`；`toolChatLoop.ts` 改动 417 行接入 `activeApprovalChannels` / `approvalSemaphore` / `waitingApprovalNodes`；`plannedToolRegistry` 增加 `resourceKeys`（工具资源互斥声明） |

### 6.3 结论可解释性

| # | 会话基线行为 | 已改动 |
| --- | --- | --- |
| 9 | 四种结束原因在 UI 同形为「已拒绝」：渲染端只按 `record.status` 分支，不消费 `cause`；`notExecutedReason` UI 不展示 | 新增 `src/shared/approvalPresentation.ts`：`ApprovalStatus` → 6 态 presentation（`waiting`/`evaluating`/`approved`/`denied`/`incomplete`/`cancelled`），**`denied` 与 `incomplete` 分立**（后者含 `unavailable`/`timed-out`）；`ToolCallCard` 消费 `record.approval` 并输出 `data-approval-status` |
| 10 | 拒绝理由不下发渲染层：`tool-confirmed` 仅带机器码 `'user' \| 'policy' \| 'timeout'`，渲染端零消费 `rejectionReason`，人话理由仅进模型上下文 | `ToolCallCard` 新增 `approvalPresentation.reason` 渲染（`tool-row-detail__message`）；`approval-updated` 事件带 `ApprovalRecord`，reducer 写入 `rejectionReason` |
| 11 | `notExecutedReason` 取值不足以区分「没拿到裁决」与「裁决为否」 | 新增封闭联合 `ApprovalCause`（`agent-approved`/`agent-deny`/`policy-denied`/`user-denied`/`approval-queue-full`/`approval-queue-timeout`/`provider-rate-limit`/`provider-unavailable`/`config-error`/`unparsable`/`evaluation-timeout`/`cancelled`/`interrupted`/`recursion-blocked`/`facts-changed`/`authorization-revoked`）；`domainTypes` 增加 `confirm_cancelled`/`confirm_unavailable`；`assistantFactAggregator` 新增 `approvalNotExecutedReason()` 映射 |
| 12 | 人工提交缺共同提交边界（`onMemory` 顺序、信任写入与批准结果分离等） | 新增 `persistentConfirmationCommit.ts`（274 行）、`confirmationCommit.ts`（151 行）、`confirmationAuthorizationRegistry.ts` |

### 6.4 待观察的改进效果

| # | 待观察点 |
| --- | --- |
| O-1 | 方案 `security-approval-experience-improvement-plan.md` §1 的**完成条件尚未验证**：「一个工具等待审批时同会话独立工具仍可推进」「一个会话全部等待审批时其他会话仍能取得应用运行槽」。`scheduler.test.ts` / `approvalRuntime.test.ts` 已存在，但缺端到端与压测证据 |
| O-2 | 6.2 #8 的调度能力是否**真正替换**了 `toolChatLoop` 的工具串行 `await`（接线完整性），需按方案 §17 逐项核对 |
| O-3 | 6.3 的可解释性契约依赖 `approval-updated` 事件，其**是否由执行链实际发出**、历史重建路径是否同源，需端到端复验 |
| O-4 | `security-approval-concurrency-limits-and-observability-requirement.md` 的 **P-9**（审批路径信任点击静默丢弃）自述「待核实」；本文核对 `electron/ipc/agentProtocolIpc.ts:131` 的 `tool.confirm.trust_rejected_no_pending` warn 分支**仍在**，UI 提示仍缺 —— 该项在本次改动中**未见结案证据** |
| O-5 | 工作区尚有未提交改动 `electron/confirmation/channels.ts`、`electron/runtime/callAdmissionGate.ts`，说明该线仍在推进 |

---

## 7. 待决议题

| # | 议题 | 相关事实 |
| --- | --- | --- |
| D-1 | **能力/环境拒绝是否应携带归因类别**（如 `diagnostic.category` 或 `details` 命中模式），使模型与用户可区分「能力限制」与「策略禁止」 | A-2：`ToolExecutorResult.diagnostic` 已定义 5 类且会投影给模型，但 plan 失败分支未使用；对照 `SHELL_DIALECT_MISMATCH` 携带 `signals` |
| D-2 | **TUI 检测的匹配口径**：按子命令分割并只匹配命令位（argv[0]），还是保留全文匹配的保守策略 | A-1：全文匹配的误伤面已在第 3 章实测列出（10 例中 8 例误拒）；保守策略的收益与代价需权衡 |
| D-3 | **中止态是否进入消息状态模型**（新增 `MessageStatus.cancelled`，或另加不破坏现有穷尽检查的 `interrupted` 字段），以及读取接口是否透出 `status` | C-1：事实在事件流存在、在消息层不可见；`MessageStatus` 至今无中止取值 |
| D-4 | **审批拒绝话术中「让用户在交互式会话中对确认卡片手动批准」是否保留** | A-3：该话术被 Agent 嫁接到能力错误码上，是误归因的直接来源之一；同时它也是真实的获批途径说明 |
| D-5 | **指令范围外的连带动改是否需要约束、以及由哪一层约束**（模型侧表述引导 / 工具层确认 / 不做机制约束）。本会话中 Agent 追加了两项指令外改动，其中一项使用户未要求的活跃文档被修改；考虑到该类连带动作常属合理推进、且用户事后接受并提交，是否值得引入 runtime 硬约束需权衡 | 原第 3 章「执行范围超出用户指令边界」（已移入本表）：两项追加改动均经 `policy.decision = auto-allow`（`edit_file`，`default-write-execute-ask`）直接放行，无确认环节 |
| D-6 | **TUI 提示的显示是否应以工具结果为唯一判据**（消费 `caseId: 'SHELL-CAPABILITY-001'`），不再由渲染层按命令文本重算 | A-4：同一判定目前在后端、提示卡、终端视图三处各自计算；当前一致依赖「调用同一函数」，非契约保证 |
| D-7 | **`run_shell` 是否应将子进程 stdin 配置为非交互形态**（如 `stdio: ['ignore','pipe','pipe']` 或等价形式）并辅以环境变量约定；**以及在此之后 TUI 词表检测是否仍需保留、以何定位存在**（前置拦截 / 退为兜底 / 取消） | A-5：主链路当前未设 `stdio`，读 stdin 的命令阻塞至超时；同仓库探测路径已用 `['ignore','pipe','pipe']`；DeepSeek Harness 的默认值即为 `'ignore'` 且不使用命令名词表（见 A-5 对照）。A-1：词表是当前唯一的前置防线，但误伤面与维护成本随程序种类增长 |

---

## 8. 待核实项

| # | 待核实内容 | 影响 | 建议方式 |
| --- | --- | --- | --- |
| V-1 | 界面层是否实际渲染了 TUI 提示（`ShellTuiFallbackHint`）与「打开终端」按钮；提示的触发是否确实来自命令文本重算 | A-1 / A-4 的界面侧影响目前为【代码推理】（失败行默认展开，故命中命令的提示卡应可见） | 复现同一命令，观察界面；或查界面侧日志 |
| V-2 | 模型实际可见的 `tool_result` 内容 | A-2 的 payload 为【代码推理】，`events.jsonl` 中 `tool_result` 为精简形态 | 抓取真实请求体，或对投影函数做单测比对 |
| V-3 | **审批并发/配额缺陷的实测样本（仍为零）**。本会话 64 条审计记录中 `admission.*` 为 0，全程单会话串行；`.agent/logs/SecurityAudit-20260904.log` 的 `confirm.outcome` 均为 `lane=desktop, actor=system`（人工卡路径），`SecurityAudit-20260921.log` 仅 1 条 `cache.generation-reset`。本会话是首个可观察到 `actor: agent` 自动裁决流水的样本（9 次），但仍无法覆盖并发场景 | 并发相关缺陷（票据泄漏、拒绝服务、配额双计）的严重度与触发条件只能停留在【代码推理】层面，难以排定优先级与验收标准（与 `security-approval-concurrency-limits-and-observability-requirement.md` §5「V-1」一致）；第 6 章 O-1 的完成条件亦无法验证 | 受控环境构造 1/4/8/16 会话与配额耗尽，采集 `admission.*` 原因、等待与成本 |
| V-4 | `001665df` 的可解释性契约是否端到端生效 | O-3 | 复现一次 `agent-deny`，比对实时、切会话、重启三份投影 |
| V-5 | 第 1 轮（被中止）的 thinking 内容 | 无法确认 A-3 所述的「首轮理解错误」具体内容 | 本次未能从 `events.jsonl` 提取 `delta.type === 'thinking'` 的增量（检索结果为空），需另定提取口径 |
| V-6 | `sessions/.../messages.json` 为空数组与 `action.session.read` 可读到 6 条消息的关系 | 数据源口径 | 确认 `messages.json` 的用途（导出快照 vs 真源）与刷新时机 |
| V-7 | 主执行链路 stdin 未配置的**实际后果**：`cat`、`python3`、`ssh host`、`psql` 等经 `run_shell` 是否确实阻塞至 `shellDefaultTimeoutSec`；阻塞期间的进程与并发状态如何收敛 | A-5 全部结论为【代码推理】，本会话无实测样本 | 受控环境逐条实测，记录耗时、`terminationReason` 与 `caseId`；并验证改为 `['ignore','pipe','pipe']` 后的行为差异 |

---

## 9. 附：本清单未覆盖的范围

- 未对 `docs/废弃/后台Mission执行层/` 的**业务内容**（文档是否确应废弃）作判断，该判断属用户决策；
- 未评估 A-1 之外的其他能力层检测（方言错配、可执行文件缺失等）；
- 未对审批 Agent 的**裁决质量**（`agent-approved` / `agent-deny` 是否正确）作独立评估；
- 未核实 `run_script` 路径的审批行为与 `run_shell` 的差异（本会话仅 1 例）。

---

## 10. 修订记录

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| 0.1 | 2026-09-23 | 首版 |
| 0.2 | 2026-09-23 | 按「只记机制缺陷与有实据的行为偏差；不记证据缺口，也不记与理想工作方式的差距」标准复核，撤回 4 项、降级 1 项：①「缺少计划级能力预检」——属执行范式偏好；②「未建立结果验证回环」——会话在用户于外部终端提交前已结束，时序上不可能复核；③「绕过尝试未向用户披露」——失败调用在工具卡片中默认展开（`ToolCallCard.defaultExpanded` 对 `failed`/`rejected` 返回 true），实际已对用户可见；④「并发缺陷缺实测样本」——属证据缺口，并入待核实项 V-3。另将「执行范围超出指令边界」降级重写（该项后经 0.3 移入待决议题 D-5）。待决议题相应由 D-6 收敛为 D-4 |
| 0.3 | 2026-09-23 | 将「执行范围超出用户指令边界」自第 3 章移入待决议题（D-5）——该类连带动改属合理推进范畴，是否约束、由哪一层约束（模型侧 / 工具层 / 不约束）宜先决议，不宜直接记为机制问题。第 3 章问题项收敛为 A-1 ~ A-3，待决议题为 D-1 ~ D-5 |
| 0.4 | 2026-09-23 | 增补 2 项：①新增 A-4「TUI 判定被重复计算，渲染层不消费权威结果」——同一判定在后端、提示卡、终端视图三处各自从命令文本计算，缺单一事实来源；②将「模型侧提示文案硬编码中文、与界面 i18n 双份维护且已分叉（含 `SHELL_TUI_FALLBACK_TITLE` 死代码）」并入 A-2。待决议题新增 D-6；V-1 的范围相应扩至 A-4。另修 D-5 中对已移出项的引用（原写作「A-4」，改为条目名，避免与新增 A-4 混淆） |
| 0.5 | 2026-09-23 | 新增 A-5「主执行链路未将 stdin 配置为非交互，读 stdin 的命令阻塞至超时」——`runShellExecutor.ts:322` 未指定 `stdio`，沿用 Node 默认全管道，子进程 fd 0 无 EOF；同仓库 `spawnUtil.ts:93` 的 `['ignore','pipe','pipe']` 为正确对照。A-5 为 A-1 词表机制的底层成因之一，故在 A-1 末尾补「关联」段落。待决议题新增 D-7（stdin 形态与词表定位）；待核实项新增 V-7（该阻塞后果缺实测样本） |
| 0.6 | 2026-09-23 | 扩充 A-5 的对照段：新纳入 DeepSeek Harness（`dsh`）**源码实证**与 ACP v2 RFD，形成同类产品对照表与七条细述。要点：① dsh 的 stdin 默认即 `'ignore'`；② 其 `ENV_OVERRIDES` 注释点名 Codex / Claude Code 的同类做法（`NO_COLOR`/`TERM=dumb`/`PAGER=cat`/`GIT_PAGER=cat`）；③ 全量扫描确认 dsh **无任何交互式命令词表**；④ 真交互需求由独立 PTY 工具承接，非拒绝命令；⑤ 其工具描述明确要求「策略拒绝不得换途径重试」「不得绕过工具通道去聊天征求许可」，与会话中 A-3 的行为相反；⑥ 并明确「不引入 PTY」与「用词表代替环境配置」是两件独立的事（dsh 无 PTY 的 bash 路径同样不依赖词表）。相应在 D-7 补入对照结论 |
