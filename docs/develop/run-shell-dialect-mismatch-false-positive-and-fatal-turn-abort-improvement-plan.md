# `run_shell` 方言错配误报与「计划期错误致命化」：诊断与改进计划

> **状态：v1.4 已按评审修订并定案 D-1 / D-7 / D-8，待重审（本文档不含代码实现）**
> **日期：2026-10-11（v1.1 按评审修订；v1.2 定案 D-1；v1.3 定案 D-7；v1.4 定案 D-8）**
> **评审报告：** `docs/review/run-shell-dialect-mismatch-false-positive-and-fatal-turn-abort-improvement-plan-review.md` —— 结论「有阻断（B-1/B-2/B-3）」。本版按处置建议修订 §2.1、§4.1、§4.3、§4.4、§5、§6、§7，并回写 M-1～M-6；§1、§3 与 §4.2 保持原文（评审已核实无误）。
> **修订记录（v1.1）：** ① §2.1 依赖图更正为生产真实链路（`invocationAssembler` 包装 → `registeredAgentTurnTools.prepareTool` → SDK），并标注 coordinator 为**测试专用入口**；② §4.1 落点由 coordinator 改为 `electron/runtime/invocationAssembler.ts:1274-1294`，原 A3（SDK 白名单）**取消**；③ §4.3 补「结构化 hints 通道不存在」前置阻塞；④ §4.4 补评审 B-3 三问（record 落点 / clear 时机 / `shouldStopToolRetry` 存废）；⑤ §5–§7 同步改写；⑥ 关闭 D-6、更正 D-2、新增 D-7/D-8；⑦ 更正评审报告中 `electron/tools/invocationAssembler.ts` 的路径笔误（真实路径在 `electron/runtime/`）。
> **修订记录（v1.2）：** 定案 D-1——采用**专用错误类型**（`PlanRejectedError`），不复用 `ToolDeniedError`；同步 §4.1.2（定案 + 三处 SDK 联动）、§4.1.3（A3 取消的理由收敛）、§5 阶段 1（改动文件加 `packages/agent-sdk/src/turn.ts`）、§8 D-1。明确本方案为「复用既有回传链路 + 一次宿主—中性类型族化」，**不是**零 SDK 改动。
> **修订记录（v1.3）：** 定案 D-7——**(c) 文本承载 + JSON 结构**；同步 §4.3（字段契约、单次序列化与台账复用、代价声明）、§5 阶段 3、§6 A-1、§7 T-6、§8 D-7。
> **修订记录（v1.4）：** 定案 D-8，并修正一处**性质判断**——`clear()` 缺失属**接线遗漏**而非「设计激进」（依据 `dialectRetryBreaker.test.ts` 首条用例「成功后可清除」）。据此定案（A+B 混合）：成功改写即 `clear` + 会话级作用域（TTL 可选）+ **后果降级为提示升级、不阻断**；同步 §4.4、§5 阶段 3、§6 A-2、§8 D-8。
> **关联问题：** 会话 `7e6ece79-0887-4ad1-af91-0690ba408165`（会话 41，2026-10-10）第 31 轮因 `SHELL_DIALECT_MISMATCH` 以 `turn_end.reason=failed` 结束，31 轮模型往返、44 次工具调用全部作废，用户只看到一句开场白。
> **复现：** 会话 `f659b1db-51f7-4f75-82b2-5fb90afef9a3`（2026-10-02）事件流末行同样为 `turn_end {reason:"failed", error:"SHELL_DIALECT_MISMATCH"}`。
> **关联文档：**
> - `tool-error-recovery-and-turn-continuity-plan.md` —— 已确立「工具错误首先是模型输入」「宿主抛错不应把可修正的工具结果提升为 Turn 级失败」的原则（阶段 A/B 已落地）。**本计划处理该原则在 planned tool 的 plan 阶段这一未覆盖分支。**
> - `shell-output-encoding-robustness-requirement.md` —— 已立项 `signals`/`hints` 转发（§10.3），但未覆盖 planned 路径与 fatal 语义。
> - `run-shell-command-failure-diagnosis-and-remediation-plan.md` —— §5.4「覆盖所有失败入口的 Agent payload」，本计划补 `SHELL_DIALECT_MISMATCH` 这一类。
> - `docs/develop/interface/turn-loop.md:207` —— 终态事件 `errorCode` 契约。
> - `session-ced59b41-issue-remediation-technical-plan.md:1082` —— 「方言错配的 `reason`/`retryCount`/`retryExhausted`/`dialectRetryBreaker` 语义保持不变」，本计划不得推翻该契约。**v1.1 补充**：本计划不改单键计数语义，但改变其作用域与可恢复性，需在该文档同步登记（§4.4）。
> - `docs/plan/run-shell-lifecycle-local-execution-todo.md:345` —— 该处称「`shouldStopToolRetry()` …… 主循环已接入」，与现状不符（该函数已无生产调用方，现行机制是 `REPEATED_SEMANTIC_CALL`），本计划 §4.4 登记更正。

---

## 0. 结论摘要

本次 turn 的失败不是「模型能力不足」，而是三个缺陷叠加后被一次误报点爆：

| 编号 | 问题 | 严重度 | 一句话 |
|---|---|---|---|
| **R1** | planned tool 的 **plan 阶段异常没有「降级为工具结果」的通道**，直接冒泡为致命拒绝并终止整轮 | **P0** | 一次可改写重试的方言错误 → 整轮失败 |
| **R2** | 方言检测在 PowerShell profile 下把**合法的 PowerShell 变量 `$p` 误判为 POSIX 变量写法** | **P0** | 拦对了命令、拦错了理由，`hints` 无指导价值 |
| **R3** | `dialectRetryBreaker` 只挂在 `runShellExecutor` 路径，**planned 路径上永不生效**；且 `clear()` 在生产代码中无调用 → 熔断后**进程内不可恢复**（v1.1 补，评审 B-3） | **P1** | 熔断器存在但不可达、且不可自愈 |
| **R4** | `signals`/`hints`/`caseId` 未随错误回传模型与台账，`turn_end` 只有裸错误码 | **P1** | 模型与人都无法归因 |

修复顺序建议：**R1 先做（收益最大、风险最低）→ R2（纠正误报）→ R3/R4（统一诊断与重试语义）**。R1 单独落地即可把本次事故从「整轮失败」降为「多消耗 1 轮模型往返」。

---

## 1. 事故证据（可复核）

### 1.1 会话事实

| 项 | 值 |
|---|---|
| 会话 | `7e6ece79-0887-4ad1-af91-0690ba408165`（会话 41） |
| turnId | `043ff8ac-66e7-4ee8-986b-d268b43fe74a` |
| 模型 | `deepseek-flash`（`session.json`） |
| 时长 | ~385 秒（`turn_start` 1791675965849 → `turn_end` 1791676350794） |
| 事件量 | 8215 条（`assistant_chunk` 7999、`request_header` 31、`tool_call`/`tool_result` 各 44） |
| 用户感知 | 中间区只有一句「我来查一下 fetch MCP 的配置信息。」（失败轮的 assistant 内容） |
| 原始提问 | 「我们的 fetch MCP，调用的是 Python 的哪个开源组件？」 |

44 次工具调用中 **11 次失败或未派发**：4 次 `FACTS_CHANGED`、1 次 grep 超时、1 次 run_script 被安全审核拒绝、1 次 `dir /b "%APPDATA%..."` 在 PowerShell 下解析失败、1 次 `python -c '...'` 单引号在 PowerShell 下解析失败等。也就是说模型在失败前已在同一方向空转多轮。

### 1.2 触发命令原文（`events.jsonl` seq=8212，`stepId: …:model:31`）

```text
where.exe python; where.exe python3; where.exe uv; where.exe uvx; where.exe pipx;
foreach($p in @("$env:LOCALAPPDATA\uv","$env:USERPROFILE\.local\bin","$env:APPDATA\Python",
"$env:LOCALAPPDATA\Programs\Python","$env:LOCALAPPDATA\pipx")){ if(Test-Path $p)
{ "== $p"; Get-ChildItem $p -Force | Select-Object -First 15 -ExpandProperty Name } }
```

这是一条 **cmd 风格与 PowerShell 风格混写**的命令：`where.exe a; where.exe b; …` 是 cmd 链式写法，而 `foreach(...){}` / `$env:` / `Get-ChildItem` / `Test-Path` / `Select-Object` 是 PowerShell。**命令确实该被拦**——但被命中的信号不是那条「正确理由」（见 §3.2）。

### 1.3 事件链（失败三连）

```text
seq=8212 tool_call   run_shell   （命令见 §1.2）
seq=8213 tool_result diagnosticType=tools.dispatch_failure_context
                     toolName=run_shell  reasonCode=RunShellPlanError
                     stepId=043ff8ac-…:turn:31   ← 无 result，工具未执行
seq=8214 step_end    reason=failed
seq=8215 turn_end    reason=failed  error=SHELL_DIALECT_MISMATCH
```

`seq=8213` 的 `stepId` 为 `…:turn:31`（而非 `…:model:31`）、且不带 `result`，说明它是 SDK 的**派发失败诊断事件**（`packages/agent-sdk/src/turn.ts:1785-1789` 的 `onToolDispatchFailureContext`），由 `electron/runtime/agentSdkDesktopObserver.ts:547-548` 投影为 `tool_result`。**本次工具从未 spawn。**

### 1.4 复现范围

` sessions/f659b1db-51f7-4f75-82b2-5fb90afef9a3-20261002/events.jsonl:103740` 末行同样是：

```
turn_end { reason: "failed", error: "SHELL_DIALECT_MISMATCH" }
```

即该失败模式至少在 9 天内复现两次，不是偶发。

---

## 2. 现状链路（代码级，逐跳可核）

### 2.1 本次失败链路

```text
[模型产出混方言命令]
   ↓  planned 注册（宿主装配层包装 → registered 适配 → SDK）
electron/tools/runShellRegisteredTool.ts:23-35        plan: → planRunShellExecution(input, runtime)
electron/tools/runShellPlan.ts:122                    detectShellDialectMismatch 命中（:119-120 为 TUI 两类抛出）→
                                                       throw new RunShellPlanError('SHELL_DIALECT_MISMATCH', 'SHELL_DIALECT_MISMATCH', {...mismatch})
   ↓  registered 适配层（beginPlanning；catch 只做清理后原样 rethrow）
electron/tools/registeredAgentTurnTools.ts:123        prepareTool: Promise<PermitBinding> → registeredTool.beginPlanning(call.input, …)
electron/tools/registeredAgentTurnTools.ts:149        handle = await planning.result        ← 抛出点
electron/tools/registeredAgentTurnTools.ts:154-161    catch：handle 存在则 fail/release，再 unregisterActiveCancellation + combined.dispose，最后 throw error
   ↓  SDK 派发准入（仅 ToolDeniedError 走「回模型」分支）
packages/agent-sdk/src/turn.ts:1548-1558              prepareTool 抛 ToolDeniedError → markNotDispatched → rethrow；
                                                       其余异常原样 rethrow（本次即此分支）
packages/agent-sdk/src/turn.ts:1770                   fatalRejection = settledTools.find(s => s.status==='rejected'
                                                                      && !(s.reason instanceof ToolDeniedError))
packages/agent-sdk/src/turn.ts:1848                   throw rejectedTool.reason         ← 整轮终止
   ↓  终态投影与落库
packages/agent-sdk/src/turn.ts:564                    { status:'failed', reason: error.message, errorCode: error.code }
electron/runtime/hostedTurnHandoff.ts:362             errorCode==='SHELL_DIALECT_MISMATCH' → throw HostedTurnFinalizedError(new Error(payload.reason))
electron/claudeStreamHandlers.ts:682                  catch → finalizeTurn(eventTurnId, 'failed', message)
electron/claudeStreamHandlers.ts:299                  turn_end { turnId, reason:'failed', error:'SHELL_DIALECT_MISMATCH' }
```

> **生产链路与测试入口的分叉（v1.1 修订，评审 B-1）**：上面这条链路**不经过** `electron/tools/toolInvocationCoordinator.ts`。该文件的 `executeRegisteredTool` / `executeConfirmedRegisteredTool` 在非测试代码中**没有任何调用方**（全仓引用只有自身、测试与文档），本次线上事故走的是 `invocationAssembler` 包装层 → `registeredAgentTurnTools.prepareTool`。
> plan 阶段在 coordinator 内确实是唯一「既无 catch 也无 `finally` 资源处置」的阶段（参考 M-2：gate/confirm/validate 的 catch 位于 `:79-90 / :94-105 / :113-121`，execute 阶段 `:131-140` 有 `finally { handle.release() }`），但那是**测试专用入口**的形态，**不得据此定位修复点**（详见 §4.1 落点说明）。

### 2.2 同一错误码的另一条路径：行为完全不同

`electron/tools/runShellExecutor.ts:91-113` 对同一 `RunShellPlanError` 的处理是：

```ts
const retry = code === 'SHELL_DIALECT_MISMATCH'
  ? dialectRetryBreaker.record(profileId, signals)      // ← 熔断计数只在这里
  : undefined
return { success: false, error: code,
         data: { code, reason, processResult: null, ...planError?.details,
                 ...(retry ? { retryCount, retryExhausted } : {}), caseId: SHELL_CASE_IDS.dialectMismatch } }
```

即：**返回结构化失败结果给模型**（模型可改写重试），并维护熔断计数。

| 维度 | `runShellExecutor` 路径 | planned 路径（本次实际走的） |
|---|---|---|
| 错误去向 | 工具失败结果（`success:false` + `data`） | `throw` → SDK fatal |
| 模型能否看到 `signals`/`hints` | 能（`data` 展开 `planError.details`） | 不能（整轮终止） |
| 熔断计数 | `dialectRetryBreaker.record`（`count>=2` 才 tripped） | 不经过，永不计数 |
| 后果 | 最多浪费一次模型往返 | **整轮失败** |

同样的错误码，两种命运。这就是 R1 的实质：**不是错误严重，而是错误走在了一条没有兜底的通道上。**

### 2.3 致命化判定点（SDK 契约的边界）

`packages/agent-sdk/src/turn.ts:19` 对该入口的契约注释是 *"Pure dispatch admission. Rejections are committed as not-dispatched and returned to the model."*，但 `:1770` 的实现只把 `ToolDeniedError` 视作「可回传模型」的拒绝，其余 reject 一律 fatal。

因此本计划**不主张改 SDK 的默认语义**（fatal-by-default 对真正的内部错误是必要的），而主张：**让「可改写重试」类计划错误在到达 SDK 之前，就已被宿主转换为「拒绝即回模型」的形态**（落点与形态见 §4.1）。

---

## 3. 根因分层

### 3.1 R1（P0）计划期异常缺少「可回传」通道

`definePlannedTool` 的契约里，`plan()` 的失败只能是「异常」，而异常在 `executeRegisteredTool` 中被当作不可恢复——**契约缺少「计划失败但仍作为工具结果回给模型」这一表达**。`runShellExecutor` 之所以安全，是因为它自行 try/catch 把 plan 错误转成了返回值；planned 路径没有等价物。

结论：这是**结构性缺口**，不是 shell 模块的局部 bug。任何 planned tool 的 plan 阶段抛错（不只 run_shell）都会整轮终止。

### 3.2 R2（P0）方言误报

`electron/shell/shellDialectMismatch.ts:21-26`，`windows-powershell` profile 只检查 POSIX/cmd 信号：

```ts
if (/\bexport\s+[A-Za-z_][A-Za-z0-9_]*=/.test(command)) signals.push('posix-export')
if (/(^|\s)\$[A-Za-z_][A-Za-z0-9_]*(?=\s|$|[;|])/.test(command)) signals.push('posix-variable')
if (command.includes('/dev/null')) signals.push('posix-dev-null')
if (/\brm\s+-[^\n]*\brf\b/.test(command)) signals.push('posix-rm-rf')
if (/(^|\s)%[A-Za-z_][A-Za-z0-9_]*%/.test(command)) signals.push('cmd-variable')
if (/(^|\s)([^\n]+)\s&&\s/.test(command)) signals.push('posix-operator')
```

> **证据等级说明：** 下列判定为**按上述源码正则对 §1.2 命令原文的人工复算**，非运行时实证。落地前须以该会话重建时的 `data.signals` 或一次真机复现为准（见 §7 的 T-1）。

- `posix-variable` **会命中**：命令中 `Get-ChildItem $p -Force` 形成 ` $p ` （前置空白 + 后置空白），满足正则。
- `posix-export` / `posix-dev-null` / `posix-rm-rf` / `cmd-variable` / `posix-operator` **均不命中**（无 `export`、无 `/dev/null`、无 `rm -rf`、无 `%VAR%`、无 `&&`）。

而 `$p` 是 **PowerShell 的合法变量**。也就是说：

1. 命中的信号是**误报**；
2. 真正该报的「cmd 方言混入 PowerShell」（`where.exe a; where.exe b; …` 链）**不在信号表里**——检测器对「cmd-in-PowerShell」这一类别只有 `cmd-variable`（`%VAR%`）一条，覆盖不到 `where.exe …;` 这类 cmd 内建/exe 链式调用；
3. `hints` 因此给出的是「使用 PowerShell 语法重写命令 / 环境变量使用 `$env:NAME`，空输出使用 `$null`」（`shellDialectMismatch.ts:31` 原文；引文已按评审 M-3 补全），对已含 `$env:`、`Get-ChildItem` 的命令**毫无指导价值**。

**风险提示：** 直接删除 `posix-variable` 会削弱对真实 POSIX 片段的拦截。修正必须同时收紧（去除 `$p` 类误报）与补齐（新增 cmd 方言信号），见 §4.2。

### 3.3 R3（P1）熔断器不可达 + 缺少「改写一次」窗口

`electron/shell/dialectRetryBreaker.ts` 的阈值语义是「同 profile + 同 signals 组合累计 ≥2 次才 tripped」，但：

- `record()` 只在 `runShellExecutor.ts:96` 调用 → planned 路径永不累计；
- 语义上，**第一次错配本应触发一次「交给模型改写」的机会**，第二次同款才熔断。当前 planned 路径连第一次机会都没有。

### 3.4 R4（P1）诊断信息不落地

- 模型侧：整轮终止，`signals`/`hints`/`caseId` 完全不可见（`shell-output-encoding-robustness-requirement.md:279-281` 已记录同族缺口）。
- 台账侧：`turn_end` 只有裸字符串 `error: "SHELL_DIALECT_MISMATCH"`；`agentLogProjection.ts:29` / `shellLogFields.ts:31` 虽已定义 `retryCount`/`retryExhausted`/`terminationCaseId` 等字段，但本次没有 `shell.exec.plan_failed` 事件携带它们（`runShellExecutor` 的日志分支未被走到）。
- 归因成本：排查者必须人工从 `events.jsonl` 反推命令与判定，正如本次所做。

---

## 4. 改进方案

### 4.1 P0-A：计划失败降级为「可回传的拒绝」（v1.1 按评审 B-1/B-2 重写落点）

**目标：** planned tool 的 plan 阶段失败，默认走「回模型继续」通道，仅白名单外的异常保持 fatal。

#### 4.1.1 落点：宿主装配层包装（**不是** coordinator，**不是** SDK）

**必须先排除的两个错误落点（评审 B-1）：**

| 候选落点 | 排除理由 |
|---|---|
| `electron/tools/toolInvocationCoordinator.ts:76`（初稿 A1） | 该文件的 `executeRegisteredTool` 在**非测试代码中无任何调用方**；在此加 try/catch 会让单测全绿而**线上路径完全不变** |
| `registeredAgentTurnTools.prepareTool` 内「直接返回工具失败结果」 | 该函数契约返回 `PermitBinding`，binding 需要 `handle.prepared.planDigest/factsDigest`（`registeredAgentTurnTools.ts:354-373`）；plan 失败时 handle 不存在，**无法构造合法 binding** |

**正确落点：** `electron/runtime/invocationAssembler.ts:1274-1294` 的 `registeredToolsForTurn.prepareTool` 包装层——即 FR12② 既有模式所在处（当前只把 `REGISTERED_TOOL_NOT_FOUND:` 映射为 `ToolDeniedError`，其余 `throw error`）。

> **路径纠正（v1.1）**：评审报告 B-1 写作 `electron/tools/invocationAssembler.ts`，实测该路径不存在；真实文件是 **`electron/runtime/invocationAssembler.ts`**。以本计划的路径为准。

#### 4.1.2 承载形态：复用「拒绝即回模型」通道

```ts
// electron/runtime/invocationAssembler.ts:1274 起的包装层（示意）
prepareTool: async (call, stage) => {
  try {
    return await registeredTools.prepareTool(call, stage)
  } catch (error) {
    // 既有 FR12② 分支（保持不动）
    if (error instanceof Error && error.message.startsWith('REGISTERED_TOOL_NOT_FOUND:')) { … }
    // 新增：可回写的计划失败
    if (error instanceof RunShellPlanError && RETURNABLE_PLAN_CODES.has(error.code)) {
      throw new PlanRejectedError(error.code, formatPlanHints(error))   // 形态见下方决策
    }
    throw error
  }
}
```

**既有回传链路（复用基础）**：`hostedAgentTurnHost.ts:179` 已开启 `returnDeniedToolsToModel: true`，`turn.ts:1548-1558` 对 `prepareTool` 抛出的 `ToolDeniedError` 先 `markNotDispatched` 落 History，随后 `turn.ts:1813-1836` 物化为 `is_error` 的 tool 消息回灌模型、**turn 继续**。按 D-1 定案采用专用类型后，SDK 侧需把该类型**并入同一条回传链路**（即上方三处联动），故本方案是「复用既有回传机制 + 一次中性的类型族化」，**不是**零 SDK 改动。整体与 FR12② 同构。

**已定案（D-1，v1.2）：采用 (b) 专用错误类型**（暂名 `PlanRejectedError`），**不复用** `ToolDeniedError`。要求：

- 该类型是**宿主—SDK 中性机制**：不含任何 `SHELL_*` 业务码字面量，由宿主决定哪些计划错误映射为它，SDK 只认「这是可回模型的拒绝」；
- SDK 需三处联动（`turn.ts`）：① `:1770` 的 `fatalRejection` 判定不再把它计入 fatal；② `:1828-1848` 的 `rejectedTools` 选择器将其排除（改由回传分支处理）；③ 回传物化（参照 `:1813-1836`）把它写成 `is_error` 的 tool 消息并 `markNotDispatched`；
- 与 §4.1.3 取消 A3 **不矛盾**：取消的是「SDK 内硬编码 `SHELL_*` 白名单」，保留的是「宿主—中性的拒绝族机制」；
- 审计与统计口径必须与「策略拒绝」分离，二者不得共用同一 reasonCode 域。

#### 4.1.3 不在本期做：SDK 白名单（原 A3，降级/取消）

初稿 A3「在 `turn.ts:1770` 的 `fatalRejection` 判定加入显式白名单」**不足以成立**（评审 B-2）：

1. 只改 `:1770` 不够——白名单码仍留在 `settledTools` 中，会被 `:1828-1848` 的 `rejectedTools` 选择器挑中并在 `:1848` 照常 `throw`，整轮照样终止；必须同时从 `rejectedTools` 选择中排除并纳入物化，实质等于「在 SDK 内复制一套 drain + 回传机制」。
2. 把 `SHELL_*` 业务码硬编码进通用 SDK，破坏 `packages/agent-sdk` 对业务错误码零感知的分层。
3. §4.1.2 落点成立后，该目标已由宿主侧达成，A3 成为重复机制。

**结论：A3 取消**（不再列为必做兜底）。其唯一有价值的部分已并入 §4.1.2 的 D-1(b) 定案——SDK 侧仍需「fatalRejection + rejectedTool 选择 + 回传物化」三处联动，但触发者是**宿主注入的中性拒绝类型**，而非 SDK 内硬编码的 `SHELL_*` 白名单。

#### 4.1.4 契约连带面（随 A3 取消一并登记）

以下三处原本都是为「该码致命」设计的，改为非致命后需同步评估（保留以兼容旧 History，但不得成为新链路的隐性依赖）：

- `docs/develop/interface/turn-loop.md:207`：`SHELL_DIALECT_MISMATCH` 终态 `errorCode` 契约；
- `packages/agent-sdk/src/turn.ts:563-565`：该码的终态特判分支；
- `electron/runtime/hostedTurnHandoff.ts:362`：该码的恢复重构分支。

#### 4.1.5 A2（结构性备选，保留）

扩展 `PlannedToolSpec`，允许 `plan()` 返回显式的 `{ kind: 'plan-failed', result: ToolExecutorResult }` 分支。语义最干净，但改动面覆盖全部 planned tool 注册点（`readRegisteredTools`、`writeFileRegisteredTools`、`runScriptRegisteredTool`、`browserRegisteredTool` 等 10 余处），成本高，**不作为本期首选**。

#### 4.1.6 约束

- 本方案**不放松任何安全边界**——`ToolDeniedError` 承载的策略拒绝、`SHELL_SPAWN_ERROR`、`RunShellExecutionUncertainError`（副作用不确定）等必须保持既有 fatal/denied 语义不变。
- 顺带清理：`electron/toolChatLoop.ts:26` 的 `import { planRunShellExecution, RunShellPlanError }` 在文件内无使用点（评审 M-5），实施时一并核实清理。

### 4.2 P0-B：方言判定修正（收紧误报 + 补齐 cmd 信号）

1. **收紧 `posix-variable`**：在 `windows-powershell` profile 下，仅当出现 **PowerShell 无法解释**的 POSIX 变量形态时才计信号，例如 `$1`/`$@`/`$*`/`$?`（位置参数）、`$VAR=`（赋值）、`${VAR}` 展开、`"$VAR"` 字符串插值中的 bash 语义。**单纯的 `$name` 不再单独构成信号**（`$p`、`$env:`、`$null` 均为合法 PS 语法）。
2. **补齐 cmd 方言信号（新增）**：识别 cmd 内建链式与 cmd 专有写法，例如 `where.exe`、`dir /b`、`copy /y`、`del /q`、`set VAR=`、`%VAR%`（已有）、以及**以 `;` 串联的 cmd 内建调用**。该信号应指向 `detectedSyntax: 'windows-cmd'`，并在 `hints` 中给出 PowerShell 等价写法（`Get-Command`、`Get-ChildItem`、`Select-Object -First`…）。
3. **保持 `hints` 与 `detectedSyntax` 一致**：`detectedSyntax: 'posix-bash'` 却给「用 `$env:NAME`」的提示是自相矛盾的（本次现场就是如此），须按检测到的方言生成建议。

**验收红线：** 修正后 §1.2 那条命令**仍必须被拦**（它确实是混方言），但理由应变为 `windows-cmd` 类信号，`hints` 应能直接指导改写。

### 4.3 P1-A：`signals`/`hints`/`caseId` 全链路转发

按 `shell-output-encoding-robustness-requirement.md:807` 的既有要求补齐三条出口。

> **已定案（D-7，v1.3）：(c) 文本承载 + JSON 结构。** 背景（评审 B-2.2）：§4.1.2 走的「拒绝即回模型」通道**只回纯文本**（`turn.ts:1813-1836`；`markNotDispatched` 的 `replayContent` 同样是字符串），结构化 `signals`/`hints` 目前**只**存在于 legacy executor 路径的工具结果 `data` 里（`runShellExecutor.ts:110`）。定案做法：**载体仍是字符串（不升级 SDK 类型与 History 结构），但内容是稳定 JSON**，由宿主在转换点一次序列化：

```json
{"code":"SHELL_DIALECT_MISMATCH","caseId":"SHELL-DIALECT-001","detectedSyntax":"windows-cmd",
 "expectedDialect":"windows-powershell","shellProfileId":"<id>","signals":["cmd-operator"],
 "hints":["把 `where.exe a; where.exe b` 改写为 `Get-Command a; Get-Command b`","环境变量使用 $env:NAME"]}
```

要求：
- **字段名固定**为上例所列，可省略缺失字段但不得改名；`hints` 为有序字符串数组；
- **序列化只做一次**：宿主在转换点构造对象 → `JSON.stringify` 作为拒绝文本；**同一对象**同时写 `shell.exec.plan_failed` 台账，避免两处各自拼串导致口径漂移；
- 模型侧必须可解析：紧凑单行 JSON，**不加 Markdown 围栏**；T-6 断言该文本可 `JSON.parse`；
- 代价（显式声明）：其它消费者若需严格类型化字段仍需解析这段 JSON；将来若确需真结构化，再升级为 (a)（届时历史里已是 JSON 文本，迁移成本低）。

| 出口 | 目标 |
|---|---|
| 模型（实时） | 按 D-7 定案：**JSON 文本**（字段契约见上），承载于拒绝消息 / tool 消息的字符串 `content` |
| 模型（重启/会话恢复后的历史重建） | `src/shared/claudeToolHistory.ts` 的 `buildToolResultBlock()` 对 `success=false` 不得只序列化 `result.error`（同 `run-shell-command-failure-diagnosis-and-remediation-plan.md` §1.4 的既有结论） |
| 台账/日志 | `turn_end` 增补 `errorCode` 与 `caseId`（对齐 `interface/turn-loop.md:207`）；planned 路径须写 `shell.exec.plan_failed` 结构化日志（含 `signals`/`retryCount`/`retryExhausted`），当前该分支只存在于 `runShellExecutor` |

### 4.4 P1-B：重试/熔断语义统一到 planned 路径（v1.1 按评审 B-3 补三问）

**先补两条现状事实（v1.1 核实，初稿未掌握）：**

- `shouldStopToolRetry`（`electron/toolErrorRetryPolicy.ts:89-95`）除自身测试外**没有任何生产调用方**。现行「同一语义调用反复失败」拦截已由 `electron/toolChatLoop.ts:865-881` 的 `beforeToolDispatch` 钩子承担：返回 `{ kind: 'reject', reasonCode: 'REPEATED_SEMANTIC_CALL' }`（经 `SemanticToolRetryTracker` + `buildCommandRetryKey`），SDK 侧 `turn.ts:1543-1547` 将其 `markNotDispatched` 并把 `is_error` 消息回给模型、**turn 继续**。
  > 文档漂移提示：`docs/plan/run-shell-lifecycle-local-execution-todo.md:345` 仍写着「`shouldStopToolRetry()` …… 主循环已接入」，与现状不符，实施时一并更正。
- `dialectRetryBreaker.clear()` 在生产代码中**从未被调用**，而 `runShellExecutor.ts:40` 是**模块级单例** → 同键计数在进程生命周期内单调增长，一旦 `count>=2` 熔断便**永不可恢复**（直到进程重启）。
  > **v1.4 追加证据（性质更正）**：这很可能**不是设计本意，而是接线遗漏**——`electron/shell/dialectRetryBreaker.test.ts` 首条用例名即「连续两次相同 profile/signals mismatch 后熔断，**成功后可清除**」，说明「命令改写成功即 `clear`」原本就是设计的一部分。因此 §4.4(b) 的第一层工作是把漏掉的 `clear` 接线补上，而不是发明新语义。

**三问与建议答案（实施前必须定案）：**

| 问 | 建议 | 理由 |
|---|---|---|
| (a) `record` 落点 | 与 §4.1.2 同层：`invocationAssembler` 包装层的「计划失败 → 拒绝」转换分支 | 只有该层能同时拿到 `RunShellPlanError.details.signals` / `shellProfileId` 与转换结果；`runShellPlan` 是纯函数层，不应持有跨调用状态 |
| (b) `clear()` 时机 | **已定案（v1.4）**：① 命令**改写成功执行后** `clear`（补回原设计意图）；② 键作用域化为 `sessionId + profileId + signals`，会话结束一并清理；③ 可选增强：TTL 滑动窗口（如 10 分钟）兜底 | 保留「进程级永不清理」会把可自愈问题升级成不可自愈的环境故障 |
| (c) `shouldStopToolRetry` 存废 | **按建议执行：不复活**（同一职责已由 `REPEATED_SEMANTIC_CALL` 承担，复活等于维护两套拦截语义）；A-2 验收据此改写（见 §6） | 若坚持「第二次升级为 turn 级终止」，须显式设计并同步 `turn.ts`，不在本期范围 |

**熔断后果（已定案 v1.4，A+B 混合）：不升级为任何形式的阻断。** 依据：方言错配是**执行前**的输入格式问题——无副作用、无安全含义、模型改写一条命令即可恢复（§3.2）。因此：

- 第 1 次同款错配 → 标准提示（§4.3 的 JSON 契约，含 `hints`）；
- 第 2 次同款错配 → **提示升级**（不再重复同一句，直接给出改写后的命令形态）；`retryCount`/`retryExhausted` 仍如实字段化，但**不阻断执行、不终止 turn**；
- 「反复撞墙」的兜底交给已有的通用机制 `REPEATED_SEMANTIC_CALL`（§4.4 首条事实），**不新建第二套惩罚语义**。

**与既有契约的关系（对 `session-ced59b41-issue-remediation-technical-plan.md:1082`）：** 本计划**不改** breaker 的单键计数语义（`count` 判定式与 `tripped = count >= 2` 不变），但：① 把它的作用从「熔断/停止重试」明确为「提示升级」；② 改变其作用域与可恢复性（进程级永不清理 → 会话级 + 成功即清 + 可选 TTL）。该契约文档 :1082 需**同步登记这两项变更**，不能以「语义保持不变」为由跳过评审。

- 熔断键沿用 `profileId + sorted(signals)`（作用域化后为 `sessionId + …`）；R2 修好后该键的区分度自然提升。
- **§4.4 定案汇总（v1.4）**：(a) 落点在转换层；(b) 成功即 `clear` + 会话级作用域（TTL 可选）；(c) 不复活 `shouldStopToolRetry`；后果为**提示升级**而非阻断。D-8 据此关闭。

### 4.5 P2：观察项（不在本期实现，登记待议）

1. **`FACTS_CHANGED` 未派发 4 次**：属工具派发/事实变更通道（见 `tool-dispatch-slot-abort-and-transcript-hole-improvement-plan.md`），本计划只登记现象：同轮内反复出现会显著拉长轮次，应评估是否给模型明确的可重试提示。
2. **「信息不在工作区」的早停**：本次模型连续多轮在同一方向空转（多次全仓 grep 无命中 → 转查用户数据目录 → 转查本机 Python 安装）。可评估在「连续 N 次无新增有效事实」时注入一次结构性提示（属上下文/成本优化范畴，勿与 `tool-error-recovery-and-turn-continuity-plan.md` 的计数语义冲突）。
3. **失败轮的已完成工作保全**：本次 31 轮工作全部作废。已由 `failed-turn-continuation-experience-plan.md` 覆盖，本计划不重复设计，仅要求 R1 修复后此类整轮失败本身不再由「一次可改写的工具错误」触发。

---

## 5. 分阶段实施

| 阶段 | 内容 | 主要改动文件 | 完成判据 |
|---|---|---|---|
| **阶段 1（P0）** | 计划失败降级为「可回传的拒绝」（§4.1）：宿主装配层包装 + **专用拒绝类型**（D-1 已定案） | `electron/runtime/invocationAssembler.ts`（`:1274-1294` 包装层）、`packages/agent-sdk/src/turn.ts`（三处联动：`:1770` / `:1828-1848` / `:1813-1836`） | 复现 §1.2 命令时 turn **继续**，模型收到拒绝与改写提示；`SHELL_DIALECT_MISMATCH` 不再出现在 `turn_end.error` |
| **阶段 2（P0）** | 方言判定修正（收紧 `$name`、新增 cmd 信号、`hints` 与 `detectedSyntax` 对齐，§4.2） | `electron/shell/shellDialectMismatch.ts` | §1.2 命令仍被拦，但 `signals` 为 cmd 类且 `hints` 可直接执行 |
| **阶段 3（P1）** | 诊断三出口（**JSON 文本口径**，D-7 已定案）+ breaker：**成功即 `clear` 接线 + 会话级作用域 + 后果降级为提示升级**（§4.3/§4.4） | `electron/runtime/invocationAssembler.ts`、`electron/shell/dialectRetryBreaker.ts` + `runShellExecutor.ts`（作用域化与 clear 接线）、`src/shared/claudeToolHistory.ts`、`electron/claudeStreamHandlers.ts` | 会话恢复后历史轮仍带提示；台账含 `errorCode`/`caseId`；同会话成功改写后计数归零（可恢复性断言）；第 2 次同款错配只升级提示、**不阻断** |
| **阶段 4（收尾）** | 会话级验收 + 文档同步回写 | 本文档、`docs/develop/interface/turn-loop.md`（:207 契约）、`session-ced59b41-issue-remediation-technical-plan.md`（:1082 变更登记）、`docs/plan/run-shell-lifecycle-local-execution-todo.md`（:345 漂移更正） | §6 验收全绿；四处文档同步，无「文档称已接入、代码无调用方」类漂移 |

**执行纪律（遵循 `AGENTS.md`）：** 每阶段收尾提交；开发期只跑定向测试（`npm exec vitest run <file>`），全量 `npm test` 仅在阶段收尾与提交前跑；`build:electron:incremental` 每阶段至多一次。

---

## 6. 验收标准

| 编号 | 场景 | 期望 |
|---|---|---|
| A-1 | 复现 §1.2 命令（**生产路径**：assembler 包装 → `registeredAgentTurnTools.prepareTool`） | 不终止 turn；模型收到拒绝与改写提示（按 D-7 定案为**可 `JSON.parse` 的 JSON 文本**）；turn 继续到下一次模型响应 |
| A-2 | 同一会话内第二次发出同款错配命令（§4.4 已定案） | 计数按 `sessionId + profileId + signals` 累计；第 2 次仅**升级提示**（给出改写形态示例），**不阻断执行、不终止 turn**；命令改写成功后计数**归零**；`retryCount`/`retryExhausted` 如实字段化。**不要求 `shouldStopToolRetry` 生效**（该函数无生产调用方） |
| A-3 | 非回传类错误（`SHELL_SPAWN_ERROR`、`RunShellExecutionUncertainError`、安全策略拒绝） | 语义**不变**：仍 fatal / denied；按 D-1 定案采用专用类型，须能在审计与统计口径上区分「策略拒绝」与「计划失败」，不得混淆 |
| A-4 | `$p`、`$env:NAME`、`$null` 单独出现于 PowerShell profile | **不再**产生 `posix-variable` 信号（`detectShellDialectMismatch` 返回 `undefined`，命令正常执行） |
| A-5 | 纯 PowerShell 命令（`Get-ChildItem $p -Force`）| 不再被拦（本次误报的最小复现） |
| A-6 | 纯 POSIX 命令（`export A=1`、`rm -rf x`、`/dev/null`、`&&`）在 PowerShell profile | **仍被拦**（防回归） |
| A-7 | 会话恢复后读取失败轮历史 | 与实时出口一致（结构化字段或约定文本在历史重建后不丢失） |
| A-8 | 台账与日志 | `turn_end` 含 `errorCode`/`caseId`；planned 路径落 `shell.exec.plan_failed`，含 `signals`/`retryCount`/`retryExhausted`；熔断计数在 clear 边界后归零（可恢复性断言） |
| A-9 | 契约与文档同步 | `interface/turn-loop.md:207`、`session-ced59b41-issue-remediation-technical-plan.md:1082`、`docs/plan/run-shell-lifecycle-local-execution-todo.md:345` 三处随实现更新，不残留「文档称已接入、代码无调用方」类漂移 |

---

## 7. 测试计划（定向）

**T-1（证据核实，先做）：** 用 §1.2 原文命令在开发环境触发一次 plan 失败，断言 `data.signals` 实际内容，替换本文档 §3.2 的「人工复算」结论（若与复算不符，以运行结果为准并回写本文档）。

**T-2（单测）** `electron/shell/shellDialectMismatch.test.ts`：
- 新增 `$p` / `$env:` / `$null` 用例 → 期望 `undefined`（A-4/A-5）；
- 新增 cmd 混写用例（`where.exe a; where.exe b`）→ 期望 `detectedSyntax: 'windows-cmd'`；
- 保留既有 POSIX 用例（A-6）不得转红。

**T-3（单测/集成，落点已按评审 B-1 迁移）** 真实生产路径：`electron/runtime/invocationAssembler.ts` 的 `prepareTool` 包装层 + `registeredAgentTurnTools.prepareTool`：
- `RunShellPlanError('SHELL_DIALECT_MISMATCH')` → 期望被转换为可回传拒绝（turn 继续），而非 fatal；
- 内部错误（如 `RUN_SHELL_RUNTIME_CONTEXT_REQUIRED`、白名单外的普通 `Error`）→ 期望原样 rethrow（fatal 不变）。
- **反假绿要求**：断言必须打在真实生产路径上；只让 `toolInvocationCoordinator.test.ts` 变绿**不构成证据**（评审 B-1 的缺陷形态正是「只改了测试专用入口」）。该文件既有用例保留为回归，但不得作为本项验收依据。

**T-4（SDK 单测）** `packages/agent-sdk/test/turn.test.ts`：
- A3 取消后，本项退化为**语义不变性保护**：非 `ToolDeniedError` rejection 仍 fatal（既有 `:2418` / `:2523` 用例继续保护）；
- 按 D-1 定案（专用错误类型）：新增「专用类型走回模型、其余仍 fatal」的正反用例（注意：现有用例**不会**自动变红，必须显式新增）；同时补一条「专用类型不得被 `rejectedTools` 选择器挑中」的断言（防范 §4.1.3 指出的 `:1828-1848` 漏改）。

**T-5（breakers + 可恢复性）** `electron/shell/dialectRetryBreaker.test.ts`（配合 `runShellExecutor` 用例）：按 §4.4 定案补作用域与 `clear` / TTL 用例，断言「熔断后经 clear 边界可恢复」；若 (c) 定案为不复活 `shouldStopToolRetry`，同步移除 A-2 中的相关表述（§6 已改写）。

**T-6（会话级验收）**：以 §1.2 命令构造一次真实 turn，断言 `events.jsonl` 中不出现 `turn_end.reason=failed + error=SHELL_DIALECT_MISMATCH`，且模型侧能读到改写提示（按 D-7：该文本须可 `JSON.parse` 且含 `signals`/`hints` 字段）。

**不变量要求（遵循 `AGENTS.md` 的队列/票据类不变量规则）**：`dialectRetryBreaker` 的计数需有「随机操作序列 + 计数守恒」不变量用例——任意交错 `record`/`clear` 序列后，同键计数等于 `record` 次数减去 `clear` 次数，且 `tripped` 当且仅当计数 ≥2。

---

## 8. 风险与待决事项

| 编号 | 风险 / 待决 | 倾向 |
|---|---|---|
| D-1 | 承载形态（评审 B-1 建议项） | **已定案（v1.2）：新增专用错误类型**（暂名 `PlanRejectedError`，宿主—SDK 中性、不含业务码），不复用 `ToolDeniedError`；SDK 三处联动见 §4.1.2。可回传码集仍取**白名单**（`SHELL_DIALECT_MISMATCH` / `SHELL_PLAN_INVALID` / `SHELL_INTERACTIVE_TTY_REQUIRED` / `SHELL_TUI_UNDETECTABLE`），不得全量降级——否则内部契约错误（如 `INVOCATION_*`）会污染模型上下文 |
| D-2 | 落点契约核对：`electron/runtime/invocationAssembler.ts:1274-1294` 包装层与 `registeredAgentTurnTools.mapSafeExecutionResult`（`:336`，读 `success`/`data`/`error`/`userMessage`/`decisionRuleId`/`autoApprovedWrite`/`diagnostic`）的字段契约需先冻结 | 先冻结字段契约再动实现（避免反向 TDD）。**v1.1 更正**：初稿所指「`toolChatLoop` registered 分支 / `createAgentSdkTurnDispatch`」是错误依赖图（评审 B-1/M-4），已废弃 |
| D-3 | 收紧 `$name` 可能放过真实 POSIX 片段（如 `for x in $list; do …`） | 用「组合信号」补偿：`$name` 不单独构成信号，但与 `/dev/null`、`&&`、`export`、`rm -rf` 同现时仍判 posix-bash；并以 T-2 用例锁住 |
| D-4 | 本次 turn 共 31 轮 + 4 次 `FACTS_CHANGED`，是否存在轮次/成本层面的独立缺陷？ | 属其他计划范围（§4.5），本计划只登记 |
| D-5 | 整轮失败后 31 轮工作全部丢失的用户体验 | `failed-turn-continuation-experience-plan.md` 已覆盖，本计划不重复 |
| D-6 | ~~plan 失败的资源释放~~ **已关闭（评审 M-1）** | plan 失败时 handle 尚未创建（`plannedToolRegistry.ts:307-313`：`makeHandle` 在 `spec.plan(...)` 成功后才执行），不存在可调用的 `handle.release()`；生产路径 catch（`registeredAgentTurnTools.ts:154-161`）已对 handle 存在/不存在两分支防御，并额外 `unregisterActiveCancellation` + `combined.dispose()`。无需列入实现细节 |
| D-7 | §4.3 实时出口形态 | **已定案（v1.3）：(c) 文本承载 + JSON 结构**——载体仍是字符串（不升级 SDK 类型与 History 结构），内容是固定字段名的紧凑 JSON；同一对象复用写台账。字段契约与代价见 §4.3 |
| D-8 | §4.4(b) 熔断作用域与后果 | **已定案（v1.4）**：键作用域化 `sessionId + profileId + signals`；成功改写即 `clear`、会话结束一并清（TTL 滑动窗口为可选增强）；后果降级为**提示升级**，不阻断、不终止 turn。**不保留**「进程级永不清理」 |

---

## 9. 附录：证据清单

**会话证据**

| 项 | 路径 / 值 |
|---|---|
| 会话事件流 | `sessions/7e6ece79-0887-4ad1-af91-0690ba408165-20261010/events.jsonl`（8215 行） |
| 事件索引 | 同目录 `events.index.json`（`seq: 8215`） |
| 会话元数据 | 同目录 `session.json`（`model: deepseek-flash`） |
| 关键事件 | seq 8212（tool_call）、8213（dispatch_failure_context）、8214（step_end）、8215（turn_end） |
| 复现会话 | `sessions/f659b1db-51f7-4f75-82b2-5fb90afef9a3-20261002/events.jsonl:103740` |

**源码落点**

| 文件:行 | 作用 |
|---|---|
| `electron/tools/runShellRegisteredTool.ts:23-35` | planned 注册；`plan` → `planRunShellExecution` |
| `electron/tools/runShellPlan.ts:119-122` | TUI 两类抛出（`119-120`）与方言抛出（`122`） |
| `electron/tools/registeredAgentTurnTools.ts:123 / 149 / 154-161` | **生产** `prepareTool`（返回 `PermitBinding`）：`beginPlanning` → `await planning.result` → catch 清理后 rethrow |
| `electron/tools/registeredAgentTurnTools.ts:336 / 354-373` | `mapSafeExecutionResult`；`createBinding` 依赖 `handle.prepared.planDigest`（plan 失败时无 handle） |
| `electron/runtime/invocationAssembler.ts:1274-1294` | **A1 修订落点**：prepareTool 包装层（FR12② 当前只映射 `REGISTERED_TOOL_NOT_FOUND:`） |
| `packages/agent-sdk/src/turn.ts:1548-1558` | `ToolDeniedError` → `markNotDispatched` → rethrow（「回模型」分支） |
| `packages/agent-sdk/src/turn.ts:1813-1836` | `returnDeniedToolsToModel` 物化为 `is_error` tool 消息（**仅纯文本 `userMessage`**） |
| `electron/runtime/hostedAgentTurnHost.ts:179` | `returnDeniedToolsToModel: true`（桌面 lane 已开启） |
| `electron/tools/toolInvocationCoordinator.ts:75-76` | plan 阶段既无 catch 也无 `finally`（**测试专用入口，非生产链路**） |
| `electron/tools/plannedToolRegistry.ts:264-274` | `makePlanningHandle`：失败的 plan 仍是 rejected promise |
| `electron/tools/runShellExecutor.ts:91-113` | 同一错误的「可回传 + 熔断计数」对照实现 |
| `electron/shell/shellDialectMismatch.ts:18-53` | 方言信号正则与 hints（PowerShell 分支 21-26） |
| `electron/shell/dialectRetryBreaker.ts` | `count>=2` 熔断阈值 |
| `electron/toolErrorRetryPolicy.ts:89-95` | `shouldStopToolRetry`（**无生产调用方**，评审 B-3 核实） |
| `electron/toolChatLoop.ts:865-881` | 现行「重复语义调用」拦截 `REPEATED_SEMANTIC_CALL`（取代 `shouldStopToolRetry` 的职责） |
| `packages/agent-sdk/src/turn.ts:1770 / 1848 / 564` | fatalRejection → 整轮终止 → 终态 `errorCode` |
| `electron/runtime/hostedTurnHandoff.ts:362` | `SHELL_DIALECT_MISMATCH` → `HostedTurnFinalizedError` |
| `electron/claudeStreamHandlers.ts:682 / 299` | catch → `finalizeTurn` → `turn_end` 落库 |
| `electron/runtime/agentSdkDesktopObserver.ts:547-548` | 派发失败诊断 → `tool_result` 投影 |

**方法学声明**

- §1、§2 的所有链路结论均已按上表源码逐跳核对。
- §3.2 的 signals 命中原因为**按源码正则对命令原文人工复算**；v1.1 补充：该结论已由评审报告的 **node 实跑**独立证实（仅 `posix-variable` 命中 1 次，偏移 279，位于 `Get-ChildItem $p -Force` 的 ` $p `；其余 5 条正则均不命中）。运行时 `data.signals` 实证仍由 T-1 负责。
- **v1.1 的链路更正依据**：评审报告三线核查（plan 阶段链路 / SDK 致命化链路 / 方言检测与熔断器）与本计划独立复核结论一致——差异仅一处路径笔误（评审写 `electron/tools/invocationAssembler.ts`，真实为 `electron/runtime/invocationAssembler.ts`，已在本计划更正，后续引用以本计划为准）。
- 本文档为问题分析与方案，**未包含代码实现**；实施后请在本文件追加「实施记录」段（含实际改动文件、测试结果、与原方案的偏差），保持与 `tool-error-recovery-and-turn-continuity-plan.md`、`failed-turn-continuation-experience-plan.md` 相同的文档惯例。

---

## 10. 实施记录（2026-10-11，分支 `feat/run-shell-plan-rejection`，worktree `.worktrees/run-shell-plan-rejection`）

按 §5 分四阶段以 TDD（先红后绿）推进完成，每阶段收尾提交：

| 提交 | 阶段 | 内容 |
|---|---|---|
| `e69f9eb1` | 阶段 1（R1/P0-A） | `PlanRejectedError` 专用类型 + SDK 三处联动 + 宿主装配层转换 + D-7 JSON（提前落地定案形态） |
| `2ca72344` | 阶段 2（R2/P0-B） | 方言判定收紧 + cmd 信号补齐 + hints 口径对齐 |
| `8cb86e0b` | 阶段 3（R3/R4/P1） | breaker 会话级作用域 / 成功即 clear / 提示升级 + `shell.exec.plan_failed` 台账 + turn_end errorCode 透传 |
| `94fd758f` | 阶段 4（A-9） | 契约文档同步（turn-loop.md / ced59b41:1082 / lifecycle-todo:345） |

### 10.1 实际改动文件（与 §5 阶段表对照）

- **SDK**：`packages/agent-sdk/src/turn.ts`（新增 `PlanRejectedError`；联动点：prepareTool catch 的 `markNotDispatched`、`shouldDrain`、`fatalRejection`、回灌物化循环、`afterToolResult` source kind 扩展 `'plan-rejection'`——比原计划「三处」多出 `shouldDrain` 一处，否则首个 plan 拒绝会立即停摆其它 in-flight 工具）。
- **宿主**：`electron/runtime/invocationAssembler.ts`（`registeredToolsForTurn.prepareTool` 包装层转换，落点与 §4.1.1 一致）；新增 `electron/tools/planRejection.ts`（白名单 `RETURNABLE_RUN_SHELL_PLAN_CODES`、D-7 payload 构造、record/台账/升级，deps 可注入供测试）。
- **方言**：`electron/shell/shellDialectMismatch.ts`（`posix-variable` 收紧为位置参数 `$1/$@/$*` 与 bash 展开修饰符 `${VAR:…#…%…/…[…]…}`；新增 `cmd-operator`（评审 BLK-1 定夺后）；`detectedSyntax` 有 cmd 信号即 `windows-cmd`；新增 `escalatedDialectMismatchHints`）。
- **breaker**：`electron/shell/dialectRetryBreaker.ts`（键 `sessionId+profileId+signals`；`clearOnSuccess` / `forgetSession`；进程级共享单例导出）；接线：`runShellExecutor.ts`（record 3 参、成功 clear、tripped 升级 hints）、`planRejection.ts`（转换层 record）、`electron/ipc/sessionIpc.ts`（session:delete → `forgetSession`）。
- **诊断**：`runShellExecutor.ts` 成功 clear 挂 `executePreparedShellExecutionWithHostFallback`（覆盖 legacy / planned / 确认后重执行全部入口）；`shellLogFields.ts` 白名单补 `signals`；`electron/claudeStreamHandlers.ts`（`finalizeTurn` 增 `errorCode` 参 + cause 链提取 `resolveTurnEndErrorCode`）；`electron/runtime/hostedTurnHandoff.ts`（SHELL_DIALECT_MISMATCH 恢复分支附加 errorCode）；`electron/sessionEvents.ts`（`ensureTurnEndEvent` 修复协议把 `errorCode` 视为合法诊断字段——**实施中发现**：不补会导致旧会话恢复误报 `conflicting invocation terminal projection`，已由回归用例捕获并修复）。
- **历史**：`src/shared/claudeToolHistory.ts` 无需改动——`buildToolResultBlock` 对 `success=false` 已完整序列化 `data`，A-7 以锁定测试固化。

### 10.2 与原方案的偏差

1. **D-7 JSON 提前到阶段 1 落地**（定案已明确，避免阶段 3 返工改断言）；阶段 3 只补 record/台账/升级。
2. **`$?` 不计入 posix-variable**（§4.2.1 原文把它列为位置参数——它实为退出码特殊参数，且 PowerShell 中合法常用；`$$` 同理不计，PowerShell 中为进程 PID）。`$VAR=` 赋值形态未计信号（PowerShell 中 `$x=5` 为合法赋值，避免二次误报），由 D-3 组合信号补偿。
3. **`ensureTurnEndEvent` 修复协议扩展**（§4.3 未预见）：turn_end 新增 `errorCode` 字段后，恢复修复的字段白名单需同步纳入，见 10.1。
4. **`toPlanRejectedError` 保留为阶段 1 契约**（不含计数/台账的轻量入口）；生产包装层走 `planRejectionFromRunShellPlan`。
5. **TTL 滑动窗口未实现**（§4.4 标注「可选增强」）；会话级清理由 `forgetSession`（session:delete）承担。

### 10.3 测试结果

- **定向（TDD 红→绿）**：`turn.test.ts` 130/130（新增 PlanRejectedError 三用例：回传回模型 / drain 语义 / 关闭开关仍 fatal）；`invocationAssembler.test.ts` 46/46（T-3 生产包装层断言 + A-2 升级断言）；`shellDialectMismatch.test.ts` 12/12（A-4/A-5/A-6 + §1.2 红线 + 口径一致）；`dialectRetryBreaker.test.ts` 5/5（含随机序列不变量）；`planRejection.test.ts` 6/6；`runShellExecutor.test.ts` 47/47（含成功清除可恢复性真实 spawn 用例）；`claudeToolHistory.test.ts` 27/27（A-7 锁定）；`sessionEvents.test.ts` 新增 errorCode 用例通过。
- **类型检查**：`tsc -p tsconfig.electron.json --noEmit` 通过（每阶段）。
- **全量 `npm test`**（两次）：9174 passed / 61 failed 与 9169 passed / 66 failed（全量串行 + 真实 spawn 下有 ±几个的 flaky 波动）。失败经与 main 基线（`main@9c34f7a4` 临时 worktree 同批对比）逐一甄别，全部为**本机环境既有失败**，无本次改动引入的回归——① `claudeStreamHandlers.hostedIntegration`（17~20 个波动）：重型链路 15s 超时、`EBUSY` 临时目录清理，基线同败；② `sessionEvents` 8 个 symlink/路径别名用例：Windows 非管理员环境限制，基线同败；③ `toolCallGate` 8 个：main 基线同败；④ 其余 ~30 个（confirmation/storage/mcp 等）：main 基线同批对比 28=28 一致（与分支改动无关，均为全量负载下的波动失败）。实施中发现并修复的 1 处回归（`ensureTurnEndEvent` 的 errorCode 冲突，见 10.1/10.2-3）由 hostedTurnHandoff 对比法捕获。

### 10.4 评审处置记录（2026-10-11 评审，报告：`docs/review/2026-10-11-run-shell-plan-rejection-review.md`）

- **BLK-1（定夺：采纳「收紧放行」）**：撤销 `cmd-exe-chain`（`;` 串联 exe）信号。评审指出的技术前提成立——cmd 的串联符是 `&`（无条件串联），`;` 恰是 PowerShell 的合法语句分隔符，`where.exe a; where.exe b` 本身就是可正常执行的合法 PowerShell；§1.2 的「cmd 链式写法」定性是本计划 §1.2/§4.2.2 的事实性错误，其真实问题是 posix-variable 误报 `$p`（已由 R2 修复）。`exe a; exe b` 继续拦截会把 `git.exe fetch; git.exe log` 一类合法命令拦下，且 `where.exe → Get-Command` 的 hints 对一般 exe 是错误指导——拦截合法命令违背本计划消除误报的初衷。**补偿**：新增 `cmd-operator`（「词 & 词」的 `&` 无条件串联——该写法在 PowerShell 5.1 中是语法错误，是真正的 cmd 证据；要求 `&` 前为词字符，避免误伤 `{ & cmd }`、`; & cmd` 等合法调用运算符用法；`&&` 仍由 posix-operator 覆盖）。真实 cmd 混写检测力不降（`dir /b`、`copy /y`、`del /q`、`set VAR=`、`%VAR%`、`&` 串联）；§1.2 命令修复后**放行正常执行**（验收红线语义相应更正）。
- **P2（已修）**：`markDialectCounterRecoveredOnSuccess` 的清除键由 `prepared.spawnSpec.shellId` 改为 `prepared.dependencySnapshot.profileId`（与 record 侧 detect 写入 `shellProfileId` 完全同源）；自定义 shell 配置（shellId = 可执行文件 basename）下成功改写后计数正确归零，新增对齐测试。
- **P3（已修）**：① `toolChatLoop` 的 `tool.result` 日志 `dispatched` 字段排除 `plan-rejection`（与 `safety-rejection` 同为未派发即拒绝）；② `shellDialectMismatch.ts` 注释更正——PowerShell 的 `$$` 自动变量是「上一行最后一个 token」而非进程 PID（bash 的 `$$` 才是 PID），排除理由更正、排除结果不变（`$$` 在 PS 合法，不计信号）；③ 本计划源文档已入库（此前未提交导致 D-x/A-x 锚点悬空）。
- 评审核实的非问题（recheck 双计数、双路径重复记录、旧 History 兼容等）维持原实现。
- **二轮残留处置（同日）**：① 升级提示 `escalatedDialectMismatchHints` 的 windows-cmd 分支同步去除 `where.exe → Get-Command` 示例（首轮漏改），改写示例改为 `&` 串联 → `;` 分隔、`dir /b` → `Get-ChildItem`，`planRejection.test` / `invocationAssembler.test` 的文案锁定断言随之更新（并显式断言不再含 `Get-Command`）；② `claudeToolHistory.test` 夹具的信号名由已撤销的 `cmd-exe-chain` 更新为 `cmd-operator`（profileId 顺带更正为真实内置 id `builtin-windows-powershell`）。
- **登记观察项（评审二轮，暂不处理）**：`cmd-operator` 模式（`\w\s&\s`）与检测器整体启发式一致地**引号无感**——`echo "Tom & Jerry"` 会误报一次 `cmd-operator`；后果仅为一次可恢复拒绝（模型按 hints 改写即可），与既有 posix/cmd 信号（`%VAR%`、`&&` 等同样引号无感）口径一致。若日后需要，可在正则前增加「`&` 不落在成对引号内」的预处理；本期不引入以免复杂化启发式。

### 10.5 验收对照（§6）

- **A-1 ✓**（T-3 生产包装层 + SDK 完整 turn 用例；T-6 会话级真机验收需真机，未在本环境执行）
- **A-2 ✓**（assembler 第 2 次错配 retryCount=2 + 升级 hints；executor 成功清除后 retryCount 归 1；`shouldStopToolRetry` 未复活）
- **A-3 ✓**（白名单外原样 rethrow；`plan-rejection` 与 `safety-rejection` 审计口径分离；`SHELL_EXECUTABLE_UNAVAILABLE` 不在白名单）
- **A-4 / A-5 / A-6 ✓**（§10.3 方言测试组；§1.2 命令修复后放行，见 §10.4 BLK-1 定夺）
- **A-7 ✓**（历史重建锁定测试）
- **A-8 ✓**（plan_failed 台账字段断言；turn_end errorCode 透传；breaker clear 边界归零断言）
- **A-9 ✓**（三处契约文档同步，见提交 `94fd758f`）

