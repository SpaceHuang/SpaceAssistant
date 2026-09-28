# grep 工具中止响应与降级接线方案

- 日期：2026-09-22
- 文件名说明：本文件创建时主题为「死代码清理」，后续判定反转为「修复并接线为降级」（§3.5），文件名未改以免引用断裂；**以标题与正文为准**。
- 范围：`electron/tools/builtinExecutors.ts`（grep 执行器）、`electron/tools/grepScope.ts`、`electron/tools/ripgrepBinary.ts`、`electron/toolChatLoop.ts`（信号装配）、`package.json`（dev 脚本）、`scripts/`（prepare 复用入口）、相关测试与文档
- 关联文档：
  - `docs/develop/ripgrep-integration-technical-design.md`（rg 集成基线，其 §0.1 第 18、21 条与本方案结论冲突，需同步）
  - `docs/develop/tool-invocation-reliability-improvement-technical-design.md`（R6/R7 定义了 `GrepScope`、`planGrepInvocation`、`normalizeGrepArgs`）
  - `docs/develop/grep-tool-large-file-fallback-optimization-plan.md`（针对 fallback 的大文件优化，本方案判定其前提已不存在）
  - `docs/develop/grep-tool-0.1.7-ripgrep-unavailable-investigation.md`（「开发态未准备 rg」的成因记录；本方案 §3.7 继续其未完成的收口）

> 行号说明：文中行号为撰写时快照（工作副本 HEAD）。实施时请以符号检索定位（`rg -n "<符号名>" <文件>`），不要依赖行号偏移。

## 一、问题陈述

本方案处理三件事，不改动 grep 的搜索语义（范围规划、参数归一、输出格式保持不变）：

1. **中止响应**：用户点「中止生成」后，grep 可能长时间不返回，甚至永不返回，导致整个 turn 卡死。
2. **降级接线**：`grepFallbackJs`（含其 `walk` 递归）当前无生产调用者，却携带「静默假阴性」等实现缺陷。**本方案修复它并接线为 rg 不可用时的自动降级**——只报错不兜底，等于把「可用性归零」当成方案。
3. **rg 不可用时的处置**：rg 不可用不是理论边界——它是开发态的**默认开局**，也是打包态的现实风险。当前「明确报错」这条路径本身也是坏的（文案指向无效动作、且无替代路径）；开发态 `npm run dev` 不准备 rg，导致每开一个 worktree 就复现一次。

三件事合在一份方案里，是因为它们同属「grep 的可用性与可控性」：① 决定「能不能停下来」，② 与 ③ 决定「能不能用起来」——② 是 ③ 的第一道出路（自动降级），③ 另含开发态准备与文案分层。① 的风险也曾被 ② 的旧语义掩盖——「有兜底」的错觉让人不去检查单点结算。

### 1.1 关键事实核查

| 编号 | 事实 | 证据 |
|---|---|---|
| F1 | grep 拿到的是**单工具取消信号**，不是聊天中止信号 | `toolChatLoop.ts:3196` `const signal = registerToolCancel(requestId, toolUseId)`；`toolConfirmRegistry.ts` `registerToolCancel` 为每个 `requestId\0toolUseId` 建独立 `AbortController` |
| F2 | 聊天中止信号和工具信号**已合成**，但只用于排队，**没有进 `ctx.signal`** | `toolChatLoop.ts:3253-3258` 构造 `executionSignal = AbortSignal.any([chatSignal, signal])`；`:3260` 用于 `toolExecutionSemaphore.acquire`；`:3276` 用于 `resourceLocks.acquire`；而 `:3330` 的 `executionContext.signal` 写的是 `signal` |
| F3 | 聊天中止能影响 grep，靠的是**间接联动** | `chatCancelRegistry.ts` 的 `signalChatCancel()` → `cancelToolsForRequest` → `toolConfirmRegistry.ts` `cancelAllToolsForRequest(requestId)` 按前缀 abort 所有工具取消控制器 |
| F4 | grep 的 Promise **在终止路径上只有 `proc.on('close')` / `proc.on('error')` 两个出口**（**限定**：另有 Windows 已打开文件分支的 `stableInputStream.on('error')` / `proc.stdin.on('error')` 两处条件结算，均为 `kind: 'failed'`，非终止兜底） | `grepWithRg` 内 `finish()` 的全部调用点；**终止路径无兜底出口**（本方案主张成立） |
| F5 | 终止只发一次 `SIGTERM`，**无强杀升级、无终止超时** | `grepWithRg` 内 `setTimeout`（`timeoutMs`）与 `onAbort` 都只做 `killed = true; proc.kill('SIGTERM')` |
| F6 | 终态判定靠 `killed` 布尔 + `signal.aborted` **事后推断** | `proc.on('close')` 分支内 `if (signal.aborted) ... else if (killed) ...` |
| F7 | grep 是文件类工具中**唯一**不用 `combineUserAbortAndTimeout` 的 | `read_file` / `list_directory` / `edit_file` / `write_file` 均调用它（`toolExecutionResource.ts`，`FILE_TOOL_TIMEOUT_MS = 30_000`）；grep 直接用裸 `ctx.signal` + 自己的 `grepTimeoutSec`（默认 60s） |
| F8 | `grepFallbackJs` 无生产调用者（**本方案将其接线为降级，接线后不再是死代码**） | 全仓引用仅两处：定义本身 `builtinExecutors.ts:1211` 与 `grepScopeExecutor.test.ts`（3 个用例） |
| F9 | `GrepScope.engine` 的 `'walk'` 取值当前不可达（**接线后可达**） | `planGrepInvocation` 内 `engine: opts.engine ?? 'ripgrep'`，而 `grepExecutor` 调用时不传 `engine`；生产写入点只有 `builtinExecutors.ts:1500` 的 `engine: 'ripgrep'` |
| F10 | 默认忽略清单存在**两份真相源** | `builtinExecutors.ts:133` `GREP_SKIP_DIRS`（由**降级路径**消费）与 `grepScope.ts` `GREP_DEFAULT_IGNORES`（同一份 7 成员）。→ 按 §3.2 改造 4 归并 |
| F11 | 既有静态守卫已锁「glob 只经 `planGrepInvocation`」 | `toolReliabilityGuards.test.ts` 断言 `not.toMatch(/for \(const d of GREP_SKIP_DIRS\) rgArgs\.push/)` + `toContain('planGrepInvocation')` |
| F12 | 仓库已有进程终止权威实现，且 grep 所在文件**已 import** | `electron/shell/processSupervisor.ts`（`ProcessSupervisor.terminate(deadlineMs)`，state 收敛为 `terminated` / `termination_failed`）、`electron/spawnUtil.ts` `processTreeKiller`（`killProcessTreeVerified`）；`builtinExecutors.ts` 顶部已 import 二者 |
| F13 | **Linux 必然不可用**，且检查先于打包分支 | `electron/tools/ripgrepBinary.ts:36` `supported = new Set(['darwin-x64','darwin-arm64','win32-x64'])`；命中失败即返回 `reason: 'unsupported'`，该分支在 `if (options.packaged)` **之前**。`scripts/ripgrep-manifest.json` targets 亦仅此三项 |
| F14 | **`pack:linux` 会静默产出无 rg 的包** | `package.json` `"pack:linux": "npm run build && electron-builder --linux"`（唯一不带 `prepare:rg` 的打包脚本）；`scripts/after-pack.cjs` `if (platform === 'win32' \|\| platform === 'darwin') copyBundledRipgrep(context)`——linux 直接跳过，**不抛错**。与 `ripgrep-integration-technical-design.md` §1「发布验证将 bundled rg 缺失视为完整性错误」不符 |
| F15 | **开发态 dev 链路完全不准备 rg** | `package.json`：`"predev": "npm run i18n:generate-types"`、`"dev": "concurrently -k \"npm:dev:renderer\" \"npm:dev:electron\""`；`resources/ripgrep/` 仅 `.gitkeep` 被跟踪。成因已记录于 `grep-tool-0.1.7-...md:13`（worktree 未跑 prepare），当前仓库根存在 `.worktrees/`，故反复复现 |
| F16 | `prepareTarget` **幂等**：命中哈希缓存即返回，不联网 | `scripts/prepare-ripgrep.mjs` 内 `prepareTarget` 首段 `const cached = await fs.readFile(destination); if (sha256(cached) === target.binarySha256) { ... return destination }` |
| F17 | 不带 `--target` 会准备**三个平台** | `prepare-ripgrep.mjs` 末：`const selected = targets.length ? targets : ['darwin-x64', 'darwin-arm64', 'win32-x64']`（这也是 `prepare:rg` 与 `prepare:rg:all` 同命令的原因） |
| F18 | rg 在打包产物里是**嵌套可执行文件**，靠 ad-hoc 签名 | `after-pack.cjs` 将 rg 落到 `Contents/Resources/bin/rg`；`adHocSignMacApp` 用 `codesign --deep` 做 ad-hoc 签名，其注释自承「从网络下载的包仍需用户执行 `xattr -cr` 去除隔离」。**边界**：README 的 `xattr -cr` 是**递归**的，会一并清除 bundle 内（含 rg）的隔离属性；故「app 已放行、但 rg 单独被拦」这一情形**未经实测确认**，只作为可能性登记（收益边界见 F22） |
| F19 | grep 是内置工具中**唯一**依赖随包原生二进制者 | `read_file` / `write_file` / `edit_file` / `list_directory` 为纯 Node；`run_shell` 走系统 shell；`browser` 走 playwright。故 rg 缺失时 grep **功能完全归零**，且不共享其他工具的可用性（单点故障） |
| F20 | **项目已有一条不依赖 rg 的内容搜索，且已在生产运行** | `electron/ipc/ipcShared.ts` `searchFilesUnder`：`fs.readdir` 递归（depth ≤ 4，跳过 `node_modules` / `.git`）+ 扩展名白名单（`.txt/.md/.ts/.tsx/.json/.js/.jsx/.css/.html/.yml/.yaml`）+ `fs.readFile(full,'utf8')` 后 `raw.toLowerCase().includes(query)` 内容匹配 + 返回 preview。被 `search:execute`（左侧搜索面板，`searchIpc.ts` → `searchFilesUnder`）使用。**纯 Node，不 spawn 任何二进制**。**架构上它是业务模块的实现**（产出 UI 语义的 `SearchResult[]`，参数为搜索面板设计）——见 F23，这决定它**不能**直接作为 Agent 降级 |
| F21 | 项目对「依赖缺失」已有成熟的恢复模式（browser 先例） | `electron/browser/browserDependencyRecovery.ts` `formatDependencyRecoveryToolContent`：工具失败时返回结构化 JSON（`dependencySetupRequired: true` + `errorCode` + `installCommand`），并加载恢复 Skill `browser-setup-guide`；`src/renderer/components/Browser/BrowserSetupGuide.tsx` 为共享引导 UI。`browser-setup-skill-requirement.md` 明确：杀毒 / Gatekeeper 类问题按平台给简短建议；打包态**不得**引导 `npm install`，应建议重装 |
| F22 | macOS 用 `codesign --deep` 做 ad-hoc 签名 | `scripts/after-pack.cjs` `adHocSignMacApp`：`codesign --force --deep --sign - <app>`。**订正一处早先在本方案中的表述错误**：Apple 对 `--deep` 的批评是它不按嵌套组件类型应用针对性参数（entitlements、硬化运行时等），推荐自内向外逐层显式签名——**而非「只签一层」**。**更要紧的是收益边界**：ad-hoc 签名本身不被 Gatekeeper 信任，故**逐层签名并不能解决「带隔离属性被拦」这一根因**，只是让内层签名结构更规整（E6 据此降级为可选改善） |
| F23 | **架构文档规定：业务模块与 Agent 主干正交，禁止反向依赖** | `docs/develop/architect/product-architecture-design.md` §2.4：业务功能「**不属于六块中的任何一块**……它们是桌面应用自身的业务功能」；§3.2 原则 2：「业务功能……是与 Agent 正交的『应用域』……它们与 Agent 只有两种关系：**共享底层能力**，或**被 Agent 当工具使用**」；§3.2 原则 1 给出共享的**正例**：「文件读取既服务『文件树界面』，也是 Core 的工具 —— **同一份底层能力，两个消费者**」；§3.1：「**Utils 可以被任何一层使用**，但不得持有语义」「Storage……**不反向依赖任何人**」。→ **允许的形态是「无业务语义的底层能力被多方各自包装」，不是「一个业务实现被另一方直接消费」** |

| F24 | **`grepExecutor` 的 rg 不可用有 3 个出口，且高频的两个在 `grepWithRg` 之前** | `:1472`（`resolveRipgrepBinary` 失败 → `unsupported`）、`:1480`（`inspectRipgrepBinary` 失败 → `not_found` / `not_file` / `permission_denied` / `spawn_failed`）、`:1531`（`grepWithRg` 返回 `unavailable`，仅 spawn 阶段分类）。`inspectRipgrepBinary` 的 `fs.stat` 对不存在路径抛 ENOENT → `not_found` → 在 `:1480` 返回，**到不了 `grepWithRg`**。故降级若只接 `:1531`，场景 B/D2 不会触发（评审 B1） |
| F25 | **macOS 树杀依赖「子进程 = 进程组组长」，而 grep 的 spawn 未设 `detached`** | `spawnUtil.ts:189-195`：`const groupPid = process.platform === 'darwin' ? -(pid) : undefined`；`if (groupPid) process.kill(groupPid, 'SIGTERM') else proc.kill('SIGTERM')`，**失败即 `catch { clearTimeout(timer); finish(false); return }`**。未 `detached` 的子进程不是组长 → `-pid` 无效 → ESRCH → **不发任何信号**。对照 `runShellExecutor.ts:330` 有 `detached: process.platform === 'darwin'`；`builtinExecutors.ts:1118` 的 grep spawn **没有**（评审 B-1） |
| F26 | **`processTreeKiller` 忽略 `deadlineMs`，底层强杀节奏不可注入** | `spawnUtil.ts:219-224`：`async terminate(proc)` 只取 `proc`（接口声明含 `deadlineMs` 但实现未用）；节奏为模块常量 `KILL_TREE_GRACE_MS = 250`（`:10`）、`KILL_TREE_TIMEOUT_MS = 3000`（`:9`），分别用于 `:155` 主定时器与 `:197` hardKillTimer。故「让 grace 可注入」控制不了它们（评审 B-2） |
| F27 | Windows 树杀实际走 `taskkill /PID /T /F`，非裸 `TerminateProcess` | `spawnUtil.ts:157-184`：win32 分支 spawn `taskkill` 带 `/T /F`；失败时兜底 `proc.kill()`。故「进程拒绝退出」fixture 在 Windows 上同样构造不出（结论不变，机制需订正，评审 P-1） |

## 二、问题一：中止信号的响应逻辑

### 2.1 现状链路

```
用户点停止 (ChatView.tsx) → window.api.chatCancelTurn(turnId)
  → 主进程 chat:cancel-turn → turnRuntime.cancel(turnId)
      → coordinator.cancel → cancelHook → signalChatCancel(requestId)
          ├─ abort(chatSignal)
          ├─ cancelAllToolConfirmsForRequest(requestId)
          └─ cancelAllToolsForRequest(requestId)   ← grep 的中止唯一来源（间接）
  → turnCoordinator.beginFinishing（5s 收尾窗口）

grep 侧：
  registerToolCancel(requestId, toolUseId) → signal(工具级)
  executionContext.signal = signal             ← 不含 chatSignal
  grepWithRg(..., signal)
      onAbort → proc.kill('SIGTERM')           ← 单次，无升级
      Promise 结算只等 proc 'close'            ← 单点，无兜底
```

### 2.2 缺陷清单

| 编号 | 缺陷 | 后果 | 严重度 |
|---|---|---|---|
| **G1** | **结算单点依赖 `close`**：`finish()` 只在 `close` / `error` 触发，无强制结算兜底 | rg 若不退出（Unix 上不可中断 I/O：网络盘/共享盘、巨目录、被独占文件、`--multiline` 灾难性回溯），或进程已死但 stdio 仍被子进程持有导致 `close` 不触发 → **Promise 永不 settle**。tool loop 的取消检查点全在工具返回之后，turn 永久卡死，同时占着 `toolExecutionSemaphore` 与 `resourceLocks` 租约 | 高 |
| **G2** | 只有单次 `SIGTERM`，无强杀升级、无终止 deadline | `SIGTERM` 是可被忽略/延迟的信号。run_shell 走 `ProcessSupervisor.terminate()`（tree kill + verified + deadline race），grep 完全没有对应纪律 | 高 |
| **G3** | `ctx.signal` 不含 `chatSignal`（F2），聊天中止靠 `cancelAllToolsForRequest` 隐式联动 | 联动链任一环缺失（links 未注入 `cancelToolsForRequest`、注册/清理时序错开：`clearToolCancel` 之后或 `registerToolCancel` 之前）→ grep 收不到中止，只能等 60s 超时 | 中 |
| **G4** | `executionSignal` 的降级分支取 `executionSignals[0]`（即 `chatSignal`） | `AbortSignal.any` 不可用时，**工具级取消从排队路径上消失**（semaphore / resourceLocks 排队期间 `tool:cancel` 无法中止等待） | 中 |
| **G5** | 终态靠 `killed` + `signal.aborted` 事后推断（F6） | 「用户取消」与「搜索超时」在同一布尔里混装；abort 与 timeout 叠加时归属依赖时序 | 中 |
| **G6** | 取消被表达为 `{ success: false, error: '...[已取消]' }` | 工具层先记一条 failure，再在下一个检查点抛 `ChatCancelledError`；「用户主动中止」在工具结果里呈现为「失败」 | 低（见 §2.5） |

### 2.3 设计目标与非目标

**目标**

- T1：grep 的 Promise 结算存在**硬上界**——从中止信号触发到工具返回，不超过 `graceMs + slackMs`（建议 2 000 ms）。
- T2：grep **直接**感知聊天中止，不再依赖隐式联动链。
- T3：终止过程可观测：记录原因（abort / timeout）、是否走强制结算、实际耗时。
- T4：搜索语义零变化（范围规划、参数归一、输出格式、既有测试断言全部保持）。

**非目标**

- 不改 `finishingWindowMs`（5s 收尾窗口）与渲染层对账节奏——那是另一条链路的问题。
- 不统一 `grepTimeoutSec`(60s) 与 `FILE_TOOL_TIMEOUT_MS`(30s)（理由见 §2.6）。
- 不恢复 JS fallback（理由见 §3.5）。

### 2.4 D1：让 grep 直接感知聊天中止

把 `executionContext.signal` 从工具级信号改为合成信号：

```ts
// toolChatLoop.ts（位置：executionContext 构造处）
const executionContext = {
  ...,
  signal: executionSignal ?? signal,   // ← 原为 signal；`?? signal` 兜住 any 不可用/过滤空的情况
  ...
}
```

配套修掉 G4：`executionSignal` 的降级不能丢信号。建议不再依赖 `AbortSignal.any` 的存在性，改为本地合成：

```ts
function anySignal(signals: AbortSignal[]): AbortSignal {
  const available = signals.filter((s) => typeof AbortSignal !== 'undefined' && s instanceof AbortSignal)
  if (available.length === 0) throw new Error('no-usable-abort-signal')
  if (available.length === 1) return available[0]!
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(available)
  const ctrl = new AbortController()
  for (const s of available) {
    if (s.aborted) { ctrl.abort(s.reason); break }
    s.addEventListener('abort', () => ctrl.abort(s.reason), { once: true })
  }
  return ctrl
}
```

**收益**：grep（以及全体内置工具）在 `chatCancelTurn` 后立即收到 abort，不再依赖 `cancelAllToolsForRequest` 是否被正确注入与调用；同时修正排队阶段工具级取消失效的问题。

**前置核查（必须做）**：逐一确认 `ctx.signal` 的消费方在新语义下无副作用。已识别的消费方：

| 消费方 | 现状用法 | 换为合成信号后 |
|---|---|---|
| `read_file` / `list_directory` / `edit_file` / `write_file` | `combineUserAbortAndTimeout(ctx.signal)` | 语义不变（「用户取消」侧更灵敏，超时侧仍为 30s） |
| `grep` | 直接传 `grepWithRg` | 本方案目标 |
| `run_shell` | `ctx.signal.addEventListener('abort', onAbort)` → `supervisor.terminate()` | 提前感知聊天中止，是改善 |
| `browser` | `raceWithUserAbort` / `throwIfAborted` | 语义不变 |
| 其他注册工具 | 待逐一自查 | 需在实施时列出完整清单 |

**风险与对策**：若某消费方依赖「`ctx.signal` 只在工具级取消时 abort」的隐含假设（例如把 abort 一律解释为「用户点了该工具的取消」），换信号后会误判成因。对策：实施时检索全部 `ctx.signal` / `context.signal` 读取点，逐个确认；对确实需要区分成因的地方，改用 `outcomeFromFileToolSignal()` 式的显式判定，而不是猜信号来源。

### 2.5 D2：终止纪律（强杀升级 + 强制结算）

这是解决 G1/G2 的核心，也是本方案**唯一必须做**的部分。

**对齐既有权威实现**：复用 `ProcessSupervisor` + `processTreeKiller`（F12 已确认 `builtinExecutors.ts` 顶部已 import 二者，**无新增依赖**）。

> ⚠️ **但「无新增依赖」≠「零适配」**。评审 B-1/B-2 指出两处必须先做的适配，否则会出现「测试全绿但真机失效 / 用例写不出来」：
>
> **适配一：macOS 必须 `detached: true`（否则树杀静默失效）**
>
> `processTreeKiller` 的 macOS 分支走**进程组** kill（`spawnUtil.ts:189-195`）：`groupPid = -pid` → `process.kill(groupPid, 'SIGTERM')`。而**未设 `detached` 的子进程不是进程组组长**，`-pid` 不是有效 pgid → `process.kill` 抛 ESRCH → 落入 `:191-194` 的 `catch { finish(false) }` → **一个信号都没发出去**。此时方案的兜底结算仍会让工具在 2s 内返回，**T-A1/T-A2/AC1/AC2 全绿，但 rg 进程继续跑**（唯一间接清场是 `finish()` destroy 管道让 rg 写 stdout 撞 EPIPE，而 rg 若正处于计算阶段不写输出，就会跑到自然结束）。
>
> 对照先例：`run_shell` 的 spawn 显式带 `detached: process.platform === 'darwin'`（`runShellExecutor.ts:330`），正是为满足同一 killer 的进程组前提。**grep 的 spawn（`builtinExecutors.ts:1118`）没有该选项，必须补上。**
>
> **适配二：测试缝必须是 `ProcessKiller` 注入，而非「grace 可注入」**
>
> `processTreeKiller.terminate(proc)` **忽略传入的 `deadlineMs`**（`spawnUtil.ts:219-224`，接口声明了该参数但实现未使用）；底层升级节奏是**模块常量** `KILL_TREE_GRACE_MS = 250` / `KILL_TREE_TIMEOUT_MS = 3000`（`spawnUtil.ts:9-10`）。对「进程拒绝退出」fixture，这两个定时器会一直挂到 fixture 退出——而 fixture 的设计就是不退出。**故「让 grace 可注入」控制不了它们**。正确做法是给 `grepWithRg` 增加 `ProcessKiller` 注入 seam（与既有 `grepSpawnProcess` 同形态，`types.ts:78-83` 已有先例），生产默认 `processTreeKiller`，测试注入可控 stub。

```ts
const GREP_TERMINATE_GRACE_MS = 1_500   // supervisor 等待上界；底层强杀节奏固定为 250ms(SIGTERM→SIGKILL) / 3000ms(verified)，不受此值控制
const GREP_SETTLE_SLACK_MS = 500        // 兜底结算宽限

// 适配一：spawn 选项（与 runShellExecutor.ts:330 对齐）
const proc = spawnProcess(binaryPath, rgArgs, {
  cwd: workDir,
  windowsHide: true,
  detached: process.platform === 'darwin',   // macOS 树杀依赖「子进程 = 进程组组长」
  ...(stableFileOnWindows ? { stdio: ['pipe', 'pipe', 'pipe'] } : ...)
})

// 适配二：killer 作为 grepWithRg 的**可选参数**注入（生产缺省 processTreeKiller；测试注入 stub，使 fake timers 可控）
// 签名追加（在既有 spawnProcess 之后）：
//   killer: ProcessKiller = processTreeKiller,
// 便于 grepSpawnProcess 同形态的测试替换
export async function grepWithRg(
  ...,
  spawnProcess: (...) => ChildProcess = spawn,
  killer: ProcessKiller = processTreeKiller,
  openedFile?: { fileHandle: FileHandle; platform?: NodeJS.Platform }
): Promise<RipgrepRunResult> {
  // NOTE：不得用「模块常量 + 运行时改写」——模块常量无法按用例替换，
  // 会让 T-A2/T-A4 无法注入可控 killer（这正是适配二要求参数注入的原因）。

  // grepWithRg 内部（Promise 作用域）
  const supervisor = new ProcessSupervisor(proc, killer)
let terminationReason: 'abort' | 'timeout' | null = null
let settleTimer: ReturnType<typeof setTimeout> | undefined

const requestTermination = (reason: 'abort' | 'timeout'): void => {
  if (settled) return
  if (terminationReason === null) terminationReason = reason
  // 请求树杀：底层为 SIGTERM →(250ms)→ SIGKILL →(≤3000ms) verified（节奏为 spawnUtil 模块常量，不随入参变化）；
  // 传入的 graceMs 只决定 supervisor 何时放弃等待并报 termination_failed
  void supervisor.terminate(GREP_TERMINATE_GRACE_MS).then((result) => { terminationOutcome = result })
  // 强制结算兜底：到点仍未 close 也必须返回，绝不允许悬挂
  if (settleTimer === undefined) {
    settleTimer = setTimeout(() => {
      if (settled) return
      finish({
        kind: terminationReason === 'timeout' ? 'timeout' : 'cancelled',
        partialOutput: out.trimEnd(),
        terminated: 'forced'
      })
    }, GREP_TERMINATE_GRACE_MS + GREP_SETTLE_SLACK_MS)
  }
}

const onAbort = () => requestTermination('abort')
signal.addEventListener('abort', onAbort, { once: true })

const t = setTimeout(() => requestTermination('timeout'), timeoutMs)
```

`finish()` 补齐清理（现状只 `clearTimeout` + `removeEventListener` + `stableInputStream?.destroy()`）：

```ts
const finish = (result: RipgrepRunResult): void => {
  if (settled) return
  settled = true
  clearTimeout(t)
  if (settleTimer !== undefined) clearTimeout(settleTimer)
  signal.removeEventListener('abort', onAbort)
  // 兜底结算时进程可能还活着：必须断开所有管道，避免悬挂句柄与后续数据写进已 resolve 的闭包
  stableInputStream?.destroy()
  proc.stdin?.destroy()
  proc.stdout?.destroy()
  proc.stderr?.destroy()
  resolve(result)
}
```

**关键性质**：结算上界 = `min(进程自然退出, graceMs + slackMs)`。即无论 rg 是否响应终止，工具**必然**在约 2 秒内返回。

**⚠️ 但「工具返回」≠「进程已死」**——两者必须分开验收（评审 B-1）：

| 断言对象 | 由谁保证 | 测试 |
|---|---|---|
| 工具 Promise 按时 settle（有界） | 本方案的 `settleTimer` | T-A1 / T-A2 |
| **进程真实退出**（树杀生效） | `detached` + `ProcessKiller` 的 verified 结果 | **T-A6（新增，跨函数断言）** |

**时延预算（端到端）**（评审 P-3 订正）

原稿写「grep 返回 → 下一检查点：接近 0」，**不属实**：`toolChatLoop` 的 5 处 `throwIfChatCancelled(chatSignal)` 分别在主循环每轮 LLM 前（`:1194`）、流事件（`:1337`）、每个 tool_use 处理前（`:1975`）、确认后执行前（`:2936`）、拿到锁后（`:3279`）——**工具执行返回之后没有检查点**。取消要等同批剩余工具处理完、主循环回到 `:1194` 才抛出。

| 环节 | 上界 |
|---|---|
| 中止信号 → grep 返回 | 2 000 ms |
| 同批剩余工具串行执行（每个各走上表上界） | ≈ 2 000 ms × 同批剩余工具数 |
| 回到主循环检查点抛出 `ChatCancelledError` | ≈ 0（`toolChatLoop.ts:1194`） |
| coordinator 收尾窗口 | 5 000 ms |
| 渲染层对账轮询（兜底） | 5 000 ms |
| **合计（最坏，单工具批次）** | **约 7 s**（此前为「无限」） |

> **可选收紧**：在工具返回后补一个 `throwIfChatCancelled(chatSignal)`，可消除「等剩余工具」这一项。属顺手改良，非必须——但若做，需注意不得干扰同批工具的既有语义（如 `write_file` 与 `grep` 混批时的顺序保证）。

### 2.6 D3：终态契约与原因显式化

`RipgrepRunResult` 的两个终止态加可选字段（**可选**字段，保证既有断言 `toMatchObject({ kind: 'cancelled' })` 仍通过）：

```ts
| { kind: 'cancelled'; partialOutput: string; terminated?: 'graceful' | 'forced' }
| { kind: 'timeout';   partialOutput: string; terminated?: 'graceful' | 'forced' }
```

`close` 分支改用 `terminationReason` 判定，删除 `killed` 布尔：

```ts
proc.on('close', (code) => {
  ...
  if (terminationReason !== null) {
    finish({
      kind: terminationReason === 'timeout' ? 'timeout' : 'cancelled',
      partialOutput: out.trimEnd(),
      terminated: 'graceful'
    })
  } else if (code !== 0 && code !== 1) { /* failed */ }
  else { /* success / no_match */ }
})
```

**配套可观测性**（回应排查困难：当前 Agent 日志里**完全没有** cancel 事件）：

- 在 `requestTermination` 与 `finish` 处用 `logAgentEvent` 记录 `grep.terminate`：字段限 `{ requestId, sessionId, toolUseId, reason, terminated, elapsedMs }`，**不落 pattern、cwd、路径**（与既有 `createGrepRipgrepUnavailableDiagnostic` 的脱敏纪律一致）。
- 触发强制结算（`terminated: 'forced'`）时用 `warn` 级别——这是「进程不响应终止」的信号，值得单独可见。

### 2.7 D4：取消与失败的语义分离（可选，Phase 3 第 9 步）

现状：`grepExecutor` 把取消返回为 `{ success: false, error: '...[已取消]' }`（G6）。tool loop 会先记一条工具失败，再在检查点抛 `ChatCancelledError`。用户侧表现为「中止后气泡显示工具出错」。

建议（最小改动、不触契约）：executor 在取消时附加机器可读标记，让上层可选择不渲染为错误：

```ts
if (text.kind === 'cancelled') {
  return { success: false, error: `${text.partialOutput}\n[已取消]`, data: { cancelled: true }, duration: ... }
}
```

若后续要与 `run_shell` 的 `notExecutedReason` 体系对齐，可另立条目；本方案仅落 `data.cancelled` 标记。

### 2.8 为什么 grep 不并入 `FILE_TOOL_TIMEOUT_MS`

grep 面向的是「跨目录大范围搜索」，与单文件读写的耗时量级不同：30s 对仓库级搜索偏紧，会制造假超时。因此保留 `grepTimeoutSec`（默认 60s）作为**搜索超时**，而把「用户取消」交给 D1/D2 处理（取消路径不再受 60s 拖累）。两者职责不同，不合并。

## 三、问题二与问题三：fallback 降级接线 · rg 不可用处置

### 3.1 现状判定：不可达，但**应修而非删**

`grepFallbackJs`（`builtinExecutors.ts:1211`，约 213 行）在当前版本**不可达**：

- `grepExecutor.execute` 对 rg 结果只处理 `success` / `no_match` / `unavailable` / `cancelled` / `timeout` / `failed`，**没有任何分支跳到 `grepFallbackJs`**；rg 解析不到或校验失败时直接 `return { success: false, error: grepRipgrepUnavailableUserMessage(...) }`（明确报错，不降级）。
- 全仓引用只有定义本身 + `grepScopeExecutor.test.ts`（3 个用例）。
- 其产出的 `engine: 'walk'` 也无处可达（F9）。

**背景**：`ripgrep-integration-technical-design.md` §0.1 第 18 条以 `[x]` 标记「rg 缺失…时保留 `grepFallbackJs` 可观测降级，返回可用结果并标记 `degraded`」。实现已演化为「rg 独占」，文档仍写着「有兜底」——这正是本方案撰写前「以为 grep 会走递归慢路径」这一误判的来源。

**⚠️ 本方案早期版本据此判定「应整体删除」，该判定已撤回。** 两处错误：

1. **把「不可达」当作「无需求」**。不可达只证明**没有调用者**，不证明**没有需要兜底的场景**；而 rg 缺失在正常平台上是真实且高频的场景（§3.6 逐一盘点，其中场景 B 是开发态默认开局）。删除的前提本身是自造的。
2. **把「有缺陷的降级」与「无降级」比反了**。二者并排看：

   | | 用户能搜到 | 风险 |
   |---|---|---|
   | **无降级**（原方案） | **0**，100% 失败 | 100% 确定的损失 |
   | **有降级但会漏报大文件** | 大部分（<上限的文件） | 部分漏报，**且可被上报** |

   只要缺陷**可被感知、可被上报**，「有」就优于「无」。「静默假阴性」的病根是**静默**，而静默性恰恰可修（§3.2 改造 1）。原方案一面在 §3.5 列出「覆盖文件必须上报」的硬约束，一面用这个缺陷否决整条路径——逻辑不自洽。

**修正后的判定**：该函数**保留**，按 §3.2 改造后接线为降级路径。三条正面理由：

1. **归属层合规（决定性）**：它在 `electron/tools/builtinExecutors.ts`，属 Core 工具实现层，产出**无业务语义**的 grep 格式文本。这正是另一候选 `searchFilesUnder` 缺少的那一项（见 §3.6.2.2 与 F23）——后者是业务模块的实现，**不可修**；而 `grepFallbackJs` 的缺陷全在实现层面，**可修**。
2. **中止响应天然优于 rg**（§3.5.1）：它是我们自己的代码，检查点位置完全可控，且没有子进程可杀——不需要 §2.5 的强杀升级与强制结算兜底。
3. **修好后即非死代码**：接线后「无调用者」这一前提自然消失，`GrepScope.engine` 的 `'walk'` 取值也随之恢复意义（§3.4）。

**这不否定检索类清理**：`GREP_SKIP_DIRS` 与 `grepScope.ts` `GREP_DEFAULT_IGNORES` 重复这件事仍要处理（§3.2 改造 4），只是方式从「删除」改为「归并到单一真相源」。

### 3.2 改造清单（修复并接线）

`grepFallbackJs` **保留**，按下表改造后接线为降级路径。**六处**改造中，**第 1 处（超限上报）与第 5 处（读失败上报）是不可省的闸**——二者共同消除「静默假阴性」这一唯一致命项：第 1 处管**大小**边界的静默跳过，第 5 处管**读失败**的静默吞掉；缺任一处，静默漏报都会以另一种形态复活（评审 B3 即由此推出）。

| # | 问题 | 现状 | 改造 |
|---|---|---|---|
| **1** | **静默假阴性**（唯一致命项） | `if (buf.length > GREP_FILE_MAX) return` 静默跳过；若别无命中则返回 `No matches found` | 跳过**必须计数并上报**：返回值带 `partial: true` + `skippedFiles: [{ path, bytes, reason }]`（条数设上限）+ 结果摘要明写「已跳过 N 个超过上限的文件，其中可能包含匹配」。与 §2.6 的 `terminated` 字段同属「边界显式上报」 |
| **2** | **中止不收信号** | `fs.readFile(full)` 无 signal；扫描循环不查 `aborted` | `fs.readFile(full, { signal })`（**异步边界，真正有效**）；`walk` 保留条目级检查（`await` 之间事件循环有机会处理 abort）。**注意（评审 P2-1 订正）**：`scanContentLines` / `scanContentMultiline` / `countMatches` 是**同步**函数，abort 事件无法在同一宏任务内让 `signal.aborted` 变化，故「行循环内每 N 行检查 `aborted`」**永远不会命中**——不得写入这种死代码。有效中止边界只有三条：**walk 条目级 + `readFile` 的 signal + 单文件 2 MiB 的固有耗时上界**（§3.5.1 已给出取舍结论） |
| **3** | **大文件整读** | 先把整文件读进内存，再比大小 | 先 `fs.stat` 比大小，超限**直接计入跳过、不再读取**；上限内才读 |
| **4** | **清单第二份真相源** | 自带 `GREP_SKIP_DIRS`（与 `grepScope.ts` `GREP_DEFAULT_IGNORES` 重复，F10） | walk 路径改用 `GREP_DEFAULT_IGNORES`；删除 `GREP_SKIP_DIRS` |
| **5** | **读失败同样静默**（改造 1 的同类，评审 B3） | `scanFile` 的 `readFile` 失败 `catch { return }`、`walk` 的 `readdir` 失败 `catch { return }`——不计数、不上报。fd 耗尽（`resource_exhausted`）时降级路径同样失败，全部被吞 → 返回 `No matches found`，**比现状的显式报错更糟** | 读失败**必须计数并聚合上报**：`readErrors: [{ reason: 'read_error', count, sampledPaths }]`（**只报条数与前 N 个路径**，防 fd 耗尽时爆发式上报）+ 摘要明写「N 个文件读取失败，其中可能存在匹配」。**任何未来的静默 `return` 都必须先过这道闸** |
| **6** | **无时间预算**（评审未列，本方案独立补充） | `grepFallbackJs` 当前**没有任何总时长上界**；单线程 JS 遍历整个仓库可能远超 `grepTimeoutSec`（60s），期间无输出、用户干等 | 引入**总时长上界**（复用 `ctx.toolsConfig.grepTimeoutSec`，与 rg 同口径）与周期性中止检查（在每个 `await` 边界）；超时后**返回已得结果的 partial + 上报 `timedOut: true`**，并在摘要注明「搜索超时，结果可能不完整」——**不静默**。与 §2.6 同属「边界显式上报」的第三个维度（大小 / 读失败 / 时间） |

**返回形态必须变更**（评审 P2-2）：现状 `grepFallbackJs` 返回 `Promise<string>`，承载不了上述结构化字段。新形态建议：

```ts
type GrepFallbackResult = {
  output: string
  partial: boolean                       // 任一维度触发边界即为 true
  skippedFiles: Array<{ path: string; bytes?: number; reason: 'too_large' }>
  readErrors: Array<{ reason: 'read_error'; count: number; sampledPaths: string[] }>
  timedOut: boolean
  filesScanned: number
}
```

**与 `GrepScope.skipped` 是两个不同维度、两条通道**（极易混叠）：`GrepScope.skipped` 是**执行前**由 `planGrepInvocation` 规划出的「默认忽略目录」（`node_modules` / `.git` 等，`grepScope.ts:41-43`）；而 `skippedFiles` / `readErrors` 是**执行中**因大小 / 失败被跳过的**文件**。两者分别落入 `searchScope.skipped` 与结果摘要，**不得合并**。

**常量调整**：`GREP_FILE_MAX` 由 `1 MiB` 提高到 **`2 MiB`**。配合改造 3（先 `stat` 后读），超限文件不再读取，内存峰值 ≈ 2 MiB（串行 `await`，并发为 1），成本可接受；收益是漏报范围收窄。**注意：上限值不是核心机制，核心是改造 1 的「超限必须上报」**——只调值而不上报，等于把静默漏报的范围挪大一点，问题照旧。

**降级结果标识（不可省）**：降级产出必须让 Agent 知道「这不是 rg 的结果」。建议在输出前缀加一行明确标识，例如：

```
[降级搜索：内置 ripgrep 不可用，已用内置后备引擎完成；能力边界见末尾摘要]
```

**这与「开关」是两件不同的事**（§3.6.4 E5）：**不加开关**（不询问用户是否降级，自动切换即可），**但必须标注**——标注是给 Agent 的事实边界，不是给用户的选择题；缺了它，降级就退回成静默漏报。

**接线点（评审 B1 修订：原方案接错位置）**：

原方案把降级接在 `grepWithRg` 返回 `{ kind: 'unavailable' }` 处。**这是错的**——全仓核实：`grepWithRg` 的唯一生产调用者是 `grepExecutor`（`:1482`），而 `grepExecutor` 的 rg 不可用实际有**三个出口**，且**最高频的两个在 `grepWithRg` 之前**：

| 出口 | 位置 | 覆盖的 reason | 本方案的核心场景是否走到 |
|---|---|---|---|
| ① `resolveRipgrepBinary` 失败 | `:1472` | `unsupported` | 场景 A（Linux） |
| ② `inspectRipgrepBinary` 失败 | `:1480` | `not_found` / `not_file` / `permission_denied` / `spawn_failed` | **场景 B（开发态未准备）、D2（杀软删除 / 执行位丢失）** |
| ③ `grepWithRg` 返回 `unavailable` | `:1531` | spawn 阶段经 `classifyRipgrepSpawnError` 分类 | 仅 D3 部分（TOCTOU、ENOEXEC 等少数情形） |

**证据**：`inspectRipgrepBinary` 的 `fs.stat` 对不存在的路径抛 ENOENT → `not_found`（`ripgrepBinary.ts:25`）→ 在 `:1480` 直接返回错误，**永远到不了 `grepWithRg`**。若按原方案实施，AC12 的「移走 rg 手工验证」会返回分层文案而**无任何降级发生**，验收必然失败。

**修订后的接线设计**：不只把降级挪到三处，而是**把「rg 可用性判定」与「不可用如何处置」分离**，使判定点收敛为一处（抗回归）：

```ts
// 纯函数：只回答「用哪个引擎」，不做 I/O 外的决策
function resolveGrepEngine(ctx, resolved): { engine: 'ripgrep'; binaryPath: string } | { engine: 'walk'; reason: GrepUnavailableReason }
// executor 内只有一个降级判定点：
const engine = resolveGrepEngine(ctx, resolved)
if (engine.engine === 'walk') { /* 查 §3.8 降级矩阵 → 降级或报错 */ }
```

原 ① ② ③ 三处出口统一经该判定点收敛；**是否降级由 §3.8 矩阵按 reason 决定**，而不是「凡不可用皆降级」。

### 3.3 保留清单（防误删/误改）

| 符号 | 为什么保留 |
|---|---|
| **`grepFallbackJs` 及其全部内部符号** | **降级路径本体**（§3.1 判定已反转）。内部 `buildGlobMatcher` / `matchesGlob` / `scanFile` / `clampLine` / `pushContentLine` / `scanContentLines` / `scanContentMultiline` / `countMatches` / `limitReached` / `walk` 均随主函数保留，按 §3.2 改造 |
| **`GREP_FILE_MAX`** | 保留并**改值**（1 MiB → 2 MiB）；从「删除清单」移出。接线后它不再是死代码 |
| **`Dirent` import** | 保留：`walk` 的 `let entries: Dirent[]` 继续使用 |
| `isBinaryBuffer` | 由 `readFileStreaming.ts` 导出，`read_file`（`builtinExecutors.ts:368`）等在用；降级路径也是它的消费者之一 |
| `GREP_DEFAULT_IGNORES`（`grepScope.ts`） | **唯一**的默认忽略清单真相源（`GREP_SKIP_DIRS` 归并到此，§3.2 改造 4） |
| `grepSensitiveExcludes` / `planGrepInvocation` / `formatGrepNoMatchOutput` | R6 范围透明的主体，全部在生产路径上；降级路径**也要**复用（保持两引擎范围语义同源） |
| `GrepScope.skipped` / `skippedCount` / `truncated` | 生产写入并被 `formatGrepNoMatchOutput` 读取；降级路径需同样填充 |
| `GrepScope.engine` | **保留**（原判「删除」已撤回，§3.4）——降级接线后 `'ripgrep'` / `'walk'` 两取值都可达 |

> **`toToolUserError` import 的复核仍然要做**：`toolChatLoop.ts`、`browserExecutor.ts` 等在用；但需确认 `builtinExecutors.ts` 内除降级路径外是否还有其他使用者，避免留下未用 import（以 `tsc` 为准）。

### 3.4 连带清理（类型 / 注释 / 守卫 / 文档）

| 项 | 处理 |
|---|---|
| `GrepScope.engine` 字段 | **保留**（原判「删除」已撤回）。理由：降级接线后真有 `'ripgrep'` / `'walk'` 两个引擎，该字段恢复信息量。同步保留 `planGrepInvocation` 的 `opts.engine?: 'ripgrep' \| 'walk'` 参数与 `scope.engine: opts.engine ?? 'ripgrep'`。**降级路径须正确写入 `engine: 'walk'`** |
| `grepScope.ts` 头注释 | 「rg 与 walk 两条引擎路径共用本模块」→ **保留该表述**（它现在是事实：两条引擎都活，且共用同一份范围规划） |
| `GrepScope.limitReason` | `'timeout'` / `'output_limit'` 两个取值在生产不可达（executor 仅写 `'head_limit'`）。**次要项**：降级路径同样应写入 `limitReason`（超限跳过可考虑归入 `output_limit`）——本方案只登记，实施时视情况处理 |
| `toolReliabilityGuards.test.ts` 护栏 9 | 断言 `not.toMatch(/for \(const d of GREP_SKIP_DIRS\) rgArgs\.push/)` 继续通过（`GREP_SKIP_DIRS` 被删除）。**追加**断言「清单单一真相源」：`expect(exec).not.toContain('GREP_SKIP_DIRS')` + `expect(exec).toContain('GREP_DEFAULT_IGNORES')` |
| `toolReliabilityGuards.test.ts` **新增护栏（T-A7）** | **`detached` 静态门禁**：`expect(exec).toContain('detached: process.platform === \'darwin\'')`——把「macOS 树杀前提」从人工复核变成 CI 红绿。**理由（必须写进测试注释）**：T-A6 是行为断言，但 Windows 的 `taskkill /T /F` 对任何子进程都生效，**有无 `detached` 都会通过**，故行为断言无法覆盖适配一；竞态证明「静默失效」需要 macOS 环境。静态断言是本仓开发机（Windows）唯一可自动化的保障。**注意**：该断言锁定的是「grep 的 spawn 选项含 detached」这一事实，若未来该表达式形态变化（如抽成常量/辅助函数），护栏需同步更新——这是静态断言的固有代价，可接受 |
| `grepScopeExecutor.test.ts` | **保留** `describe('R6：walk 回退与 rg 同语义（T-R6-5）')` 整块的**语义断言**（隐藏条目、敏感路径、`include_ignored` 对称性——正是降级路径的行为保障），但**调用与断言需适配新返回形态**：三例现直接断言返回字符串（`:111`/`:125`/`:138`），须改为 `.output`（评审 P-2）。**追加**用例覆盖 §3.2 六处改造（超限上报、读失败上报、中止响应、先 stat 后读、清单同源、时间上界） |
| `grepScope.test.ts` | **不改**（`engine` 字段保留，`engine: 'walk'` 字面量仍有效）。可追加一例断言 `'walk'` 取值可达 |
| `ripgrep-integration-technical-design.md` §0.1 / §1 | 第 18 条的「保留 `grepFallbackJs` 可观测降级」**由空头承诺变为事实**——接线后应更新为「降级已接线，并在 `unavailable` 时自动切换；降级结果带边界上报与标识」。§1 第 3、5 条承诺「发布验证将 bundled rg 缺失视为完整性错误」**对 Linux 未兑现**（F14），仍需标注为已知缺口 |
| `tool-invocation-reliability-improvement-technical-design.md` | C4「walk 回退同样统计（`engine: 'walk'`）」**不再作废**——保留，并补上「降级路径须填充 `GrepScope` 全部字段」。§4.6.1 / 4.6.2 的「两引擎」表述保留为事实 |
| `grep-tool-large-file-fallback-optimization-plan.md` | **不再整体作废**：其中「1 MiB 静默跳过是假阴性」「应改为流式 + `StringDecoder`」「跳过原因必须进入统一 `recordSkip()`」「`partial=true` 必须带可见摘要」等要求，**正是本次 §3.2 改造的依据**。处置改为「部分采纳」：本轮采纳「超限上报 + 先 stat 后读 + `partial` 摘要」，流式改造（去掉大小上限）登记为后续可选 |

### 3.5 决策记录：修复 `grepFallbackJs` 并接线为降级

**决策**：**保留 `grepFallbackJs`，按 §3.2 改造后接线为 rg `unavailable` 时的自动降级路径。** 不删除，也不新建第二份实现。

**三次判定，逐次修正**（记录过程，避免同类误判复现）：

| 轮次 | 判定 | 错在哪 |
|---|---|---|
| 一 | 「零能力损失，因不可达 → 可删」 | 把「不可达」当「无需求」。不可达只证明无调用者，不证明无兜底场景（§3.1） |
| 二 | 「复用业务模块的 `searchFilesUnder` 作为降级」 | 方向错了：它是**业务模块实现**，接给 Agent 才是架构违规（F23）；而 `grepFallbackJs` 在 Core 工具层，**归属层本就合规** |
| **三（本版）** | **保留并修复接线** | —— |

**为什么「修」优于「删」**：三方案并排即清楚——

| 方案 | 用户能否搜到 | 归属层 | 缺陷可修性 |
|---|---|---|---|
| 删除，不设降级 | **0**，100% 失败 | —— | —— |
| 复用 `searchFilesUnder` | 能 | **违规**（业务模块被 Agent 消费，F23） | **不可修**（层错了） |
| **修复 `grepFallbackJs` 并接线** | 能 | **合规**（Core 工具层） | **可修**（§3.2 四处，全在实现层） |

「把有缺陷的降级和无降级并排，然后选无降级」是错的：只要缺陷**可感知、可上报**，「有」就优于「无」。而**静默性正是可修的**（§3.2 改造 1）。

#### 3.5.1 为什么降级路径的中止响应**优于** rg（修正一处方向性错误）

本方案早期版本称「它的中止纪律比 `grepWithRg` 更差，会变成中止黑洞」——**该论断方向错了**，必须订正。

**错因**：把「**当前这段代码**没写检查点」（事实）当成了「**这类实现**必然差」（错误推论）。

**正确对比**：

| 维度 | rg（外部进程） | 纯 JS（我们自己的代码） |
|---|---|---|
| 中止手段 | 只能发信号，**等它退出** | 直接在自身代码里查检查点 |
| 检查点位置 | **不可控**（在别人进程内部） | **完全可控**：每条目 / 每行 / 每 chunk |
| 慢操作可否中断 | 否（`SIGTERM` 对不可中断 I/O 无效） | `fs.readFile(p, { signal })` **原生支持中断** |
| 不响应时怎么办 | 需强杀升级 + **兜底结算**（放弃等 `close`） | **不存在此问题**——无进程可杀 |
| 中止延迟 | 秒级，且依赖 §2.5 的兜底机制 | **毫秒级且确定** |

**推论**：可控性完全在我们手中的实现，中止响应**天然优于**外部进程。由此两点结构收益：

1. **降级路径不需要 §2.5 那套机制**——无子进程，故无强杀升级、无 `terminated: 'forced'` 兜底结算；它的中止设计远比 `grepWithRg` 简单（只需检查点 + `readFile` 的 signal）。
2. **「中止纪律」不再是保留/删除的争点**，反而成为**选择保留的正面理由之一**（§3.1 理由 2）。

**仍要诚实标注的真实短板**（与中止无关）：

| 短板 | 说明 | 可否修 |
|---|---|---|
| **速度** | 单线程 JS 遍历/匹配，比 rg（Rust + 并行）慢，大仓库可能差一个数量级 | 否——降级本就是「能用」而非「一样好」 |
| **正则能力** | 自实现匹配，与 rg 正则语义不完全对齐 | 部分（可收敛到字面量 + 基础正则的清晰子集） |
| **忽略语义** | 需与 `GREP_DEFAULT_IGNORES` / `grepSensitiveExcludes` 保持同源 | 是（§3.2 改造 4） |

**因此降级结果必须带标识与边界摘要**（§3.2）——让 Agent 知道「这次搜得不全」，而不是「搜全了但没有」。

**一处必要的取舍（评审 P2-1 引申，本方案独立定案）**：既然同步扫描循环内无法感知 abort，「周期性让出事件循环」（每 N 行 `await setImmediate`）是否值得引入？

**结论：不引入。** 理由：① 单文件有 **2 MiB 上限**，同步扫描的固有耗时上界很短（毫秒级）；② 周期性让出会给每次扫描叠加调度开销，对「降级本就慢」的路径是雪上加霜；③ 收益仅在「超大文件 + 灾难性回溯正则」这一窄场景成立。

**代价与残余风险必须登记**：合法的长耗时只可能来自**灾难性回溯的正则**——此时同步扫描确实无法被中断，只能等它跑完。此为**已知残余风险**，缓解手段是 §3.2 改造 6 的**总时长上界**（在 `await` 边界检查，故对超长同步段无效）与 2 MiB 文件上限。若后续实测出现该场景，再评估正则复杂度护栏（另立条目，不在本轮）。

**降级触发条件**：**按 reason 逐一裁定，见 §3.8 降级矩阵**（原「仅 `unavailable`」的表述已废弃——它按 `grepWithRg` 的类型口径排除了 `unsupported` / `not_file`，而这两个恰恰只在 executor 层出现，导致口径悬空、Linux 场景被漏掉。评审 B2）。

**不再保留「若未来恢复降级」的假设备注**：那些约束（读盘带 signal、行循环查 `aborted`、覆盖必须上报、复用单一清单）**已成为本次改造要求本身**（§3.2 四处）。

**原「否决理由」的逐条重新定性**（这些理由仍然成立，但结论从「该删」变为「该修」）：

| 原理由 | 重新定性 |
|---|---|
| ①**静默假阴性**：>1 MiB 文件被静默跳过（`grep-tool-large-file-fallback-optimization-plan.md:19` 已研判为「假阴性」） | **成立，但它是「实现有缺陷」的证据，不是「路径不该存在」的证据**。病根在**静默**，而静默可修 → 移入 §3.2 改造 1（超限必须上报） |
| ②**中止纪律差** | **论断方向错误，已订正**（§3.5.1）。当前代码没写检查点 ≠ 这类实现必然差；修好后中止响应**优于** rg |
| ③**语义无法与 rg 对齐**：同一命令在不同机器结果不同 | **成立，且不可完全消除**——降级必须带标识与边界摘要，让 Agent 知道结果不完备（§3.2）。这是「降级可用性」的代价，不是「删除」的理由 |
| ④**携带第二份清单真相源**（`GREP_SKIP_DIRS` 与 `GREP_DEFAULT_IGNORES` 重复） | **成立** → 移入 §3.2 改造 4（归并到单一真相源，而非删除整条路径） |
| ⑤**它是文档漂移的来源**（`ripgrep-integration-technical-design.md` §0.1 第 18 条至今勾着「保留降级」） | **成立，但结论相反**：第 18 条说的本来就是「保留降级」——**接线后该文档反而变回正确**，不需要改口径 |

**与 §3.6 / E2 的关系**：降级落地后，E2 的两条路径（`list_directory`+`read_file`、`run_shell` 系统搜索）**降为「降级也失败」时的兜底**，不再是「rg 缺失时的唯一出路」。开发态缺口另见 §3.7（dev 默认准备）——两者互补：§3.7 让开发态 rg 就位，本节的降级覆盖打包态与异常场景。

**与 `searchFilesUnder` 的关系（一处已撤回的候选）**：本方案第二轮曾提议复用业务模块的 `searchFilesUnder`，该提议**已永久撤回**。理由与降级本体无关，而在归属层：它是 `search:execute` 业务 IPC 的实现，产出 **UI 语义**的 `SearchResult[]`（`id`/`title`/`preview`），把它接给 Agent 工具即构成「**Agent 主干反向依赖业务模块**」，违反架构 §2.4 / §3.2（F23），并会引发双向侵入（Agent 需求反向改业务函数签名 / 放宽其扩展名白名单 / 改其返回结构）。**这不是补 signal / 字节上限能修的——归属层错了。**

**本方案的降级本体因此定为「现有的、归属层合规的 `grepFallbackJs`」**：它在 Core 工具层、产出无业务语义的 grep 文本，**正好符合**架构认可的共享形态（F23「同一份底层能力，两个消费者」）；缺陷全在实现层，改造比重写便宜（§3.2）。

**两种形态各有一项致命项的落点**：`searchFilesUnder` 的致命项在**归属层**（不可修），`grepFallbackJs` 的致命项在**质量**（可修）——**所以选后者去修，而非前者去用，也不是两个都弃**。

**原「若未来恢复降级」的四条硬约束已转为本次改造要求本身**（§3.2）：读盘带 `{ signal }`、行循环查 `aborted`、覆盖必须上报、复用 `grepScope.ts` 单一清单。不再作为假设备注保留。

### 3.6 rg 不可用的真实场景与处置

#### 3.6.1 定位：grep 是内置工具中的单点故障

grep 是**唯一**依赖随包原生二进制的内置工具（F19）：`read_file` / `write_file` / `edit_file` / `list_directory` 是纯 Node，`run_shell` 走系统 shell，`browser` 走 playwright。因此 rg 不可用时，grep 的**主引擎能力**完全归零，且不与其他工具共享可用性。这决定了它不能按「理论上不该发生的异常」处理，而应作为一等故障状态对待——**也正因此必须有降级路径**（§3.2 / §3.5），只靠「报错 + 指引」不足够。

#### 3.6.2 场景盘点

| 场景 | 触发条件 | 概率 | 现有处置 | 问题 |
|---|---|---|---|---|
| **A. 平台不在支持面（Linux）** | `supported` 集合不含 linux，且该检查**先于**打包分支（F13） | 100%（若发布 Linux 包） | 文案「请重新安装应用后重试」 | 指引无效（重装无济于事）；`pack:linux` 缺 `prepare:rg`，`after-pack.cjs` 静默跳过（F14）→ 静默产出无 rg 的包。**登记为次要项**（CLAUDE.md 记 Linux 不在发布支持面），本方案不实施 |
| **B. 开发态未准备（本机 / 新 worktree）** | `predev` 不涉及 rg；`resources/ripgrep/*` 被 gitignore（F15） | **默认开局** | 文案提供 `prepare:rg` 指引（正确） | 指引只出现在 Agent 对话流里，开发者需自行发现；worktree 使其**反复复现**而非一次性 → §3.7 |
| **C. 打包链路异常** | `after-pack.cjs` 复制 + 双重 SHA-256 校验；`verify:rg:package` | 极低 | 打包失败 | 无（win/mac 有效；Linux 见 A） |
| **D. 二进制在但跑不起来** | 见 §3.6.2.1 的四类成因 | 现实概率 | 文案「请重新安装应用后重试」 | **指引错误且无替代路径**：重装／重试均无效，Agent 会反复撞同一面墙 |

> 场景 B 与 D 是本次讨论中被指出的一处低估：二者都不是理论可能性，B 是每个新克隆/新 worktree 的默认开局，D 在 mac/win 上均有现实成因。原稿「删除 fallback 后功能完全不可用——已存在的事实，非本改动引入」的表述掩盖了这一点（**该「删除」前提现已撤销，见 §3.5**）：**它确实是既有事实，但既有的「明确报错」路径本身也是坏的**（§3.6.3）。

#### 3.6.2.1 场景 D 的四类成因（出路各不相同）

「跑不起来」不是一个问题，而是四类，处置手段完全不同。当前实现把四类都归入同一句文案，因此**用户与 Agent 都无法据此选择正确动作**——这是 §3.6.3 的实质。

| 子类 | 症状（`reason`） | 典型成因 | 能否自愈 | 正确出路 |
|---|---|---|---|---|
| **D1 瞬时资源** | `resource_exhausted`（EMFILE / ENFILE） | 并发打开文件过多 | **能** | **不降级**（§3.8：降级同样耗 fd，会退化为静默假阴性）→ 显式报错 + 提示稍后重试；不给「重装」这类永久性指引 |
| **D2 文件缺失 / 权限** | `not_found`、`permission_denied` | 杀软**隔离删除** rg.exe；Unix 执行位丢失 | 否 | **先降级**（§3.8）；用户侧再引导检查安全软件隔离区 / 开发态指向 `prepare:rg` |
| **D3 启动被拦截** | `spawn_failed`、`exec_format` | Windows EDR/Defender 拦截随包 exe；macOS Gatekeeper 隔离（F18）——**未清隔离属性时被拦属预期行为** | 否 | **先降级**（§3.8）；再按平台给拦截处置（macOS `xattr -cr`；Windows 加白名单），**而非重装** |
| **D4 平台不支持** | `unsupported` | 见场景 A（Linux） | 否 | **先降级**（§3.8）——Linux 用户由此获得可用搜索；结构性收口另见 E4（纳入支持面 / `pack:linux` fail-loud） |

> D1 与 D2/D3 的区分有实际价值：D1 是**瞬时**故障，自动重试一次即可能恢复；把它与 D2/D3 混在一起，会让偶发失败被当成永久损坏。

#### 3.6.2.2 rg 缺失时的路径盘点（含本方案新增的降级本体）

rg 起不来时，任务并非只能放弃。下表为「rg 缺失时存在的路径」；**其中 D 行是本方案新增的降级本体**，接线后成为主路径。A 行列出仅为说明「为什么业务模块的实现不能直接拿来用」：

| 路径 | 实现 | 归属层 | 是否已生产 | 能力边界 | 代价 |
|---|---|---|---|---|---|
| **A. `searchFilesUnder`** | `electron/ipc/ipcShared.ts`（F20） | **业务模块**（产出 UI 语义 `SearchResult[]`） | **是**（`search:execute` 在用） | 仅字面量匹配（无正则）；depth ≤ 4；命中上限 40；11 种扩展名白名单；`fs.readFile` 无大小上限 | **不作降级本体**（归属层不合规，F23）；列出仅为说明「为什么不能直接拿来用」 |
| **B. `list_directory` + `read_file` 组合** | Agent 既有工具 | **Agent 侧** | 是 | 由 Agent 自行组织，语义精确 | 慢、耗 token |
| **C. `run_shell` 调系统搜索** | Windows `findstr` / `Select-String`；macOS 系统 `grep` / `mdfind` | **Agent 侧** | 是（`run_shell` 默认开启，`deniedTools: []`） | 由系统工具定义 | 需走审批；输出需自行解析 |
| **D. 修复后的 `grepFallbackJs`**（**本方案的降级本体**） | `electron/tools/builtinExecutors.ts`（Core 工具层） | **Agent 侧** | 当前否 → **本方案接线**（接在 `grepExecutor` 的不可用**汇聚判定点**，非 `grepWithRg` 返回值处——§3.2 接线点） | 按 §3.2 改造后：字面量/基础正则；**2 MiB 上限 + 读失败 + 时间三类边界都必须上报**；复用 `GREP_DEFAULT_IGNORES` 与 `grepSensitiveExcludes` | 慢于 rg（单线程）；但**中止响应优于 rg**（§3.5.1） |

> **A 为什么不能直接给 Agent**：它是**已实现的业务功能**，不是**被抽出的底层能力**——判据不是「在哪个目录」，而是「是否携带业务语义」。它返回 `SearchResult`（带 `title` / `preview` / `id: 'file:...'`），参数为搜索面板调优（40 条、depth 4、11 种扩展名）。架构文档允许的共享是「**同一份底层能力，两个消费者**」（「文件读取」即此形态），而 A 是「一个业务实现被第二个消费者直接消费」。详见下方对比表与 F23。

**路径 A 与 `grepFallbackJs` 的对比**（含决定性的归属层维度）：

| 维度 | `grepFallbackJs` | `searchFilesUnder` |
|---|---|---|
| **归属层（决定性）** | **Agent 侧**：`electron/tools/builtinExecutors.ts`，Core 工具实现层，产出无业务语义的 grep 格式文本 → **可作降级本体** | **业务模块**：`electron/ipc/ipcShared.ts`，`search:execute` 业务 IPC 的实现，产出 **UI 语义**的 `SearchResult[]` → **不可作降级本体**（F23） |
| 是否接线 | 当前**否**（F8）；**本方案将其接线** | **是**（`search:execute` 生产在用） |
| 假阴性风险 | **当前有**：>1 MiB 文件静默 `return` → **按 §3.2 改造 1 修复（超限必须上报）** | 无静默漏报；边界由参数显式约束 |
| 中止响应 | **自有代码，检查点可控**；改造后优于 rg（§3.5.1） | **自有代码，不涉及进程**——同属优势而非缺陷 |
| 语义 | 自实现，与 rg 有差异 → **靠降级标识 + 边界摘要处理** | 字面量匹配，语义直白可解释 |

**读法（本版结论）**：

- **降级本体 = 修复后的 `grepFallbackJs`**（Core 工具层，归属层合规；缺陷按 §3.2 修）。**不需要新建任何实现**——缺陷全在实现层，改造比重写便宜。
- **`searchFilesUnder` 不作为候选**（归属层不合规，F23；这一点不变）。
- **「中止粒度 / 未接 signal」一行须按 §3.5.1 订正理解**：**不涉及进程**是**优势**（自有代码，检查点可控），不是缺陷。
- **语义差异**（字面量 vs rg 正则）仍是真实短板，靠「降级标识 + 边界摘要」处理（§3.2），不构成否决理由。

#### 3.6.3 现有「明确报错」路径的缺陷

`grepRipgrepUnavailableUserMessage` 在打包态返回：`内置 ripgrep 不可用（${reason}）。请重新安装应用后重试。`，两处问题：

1. `${reason}` 是**面向开发者的诊断枚举**（`not_found` / `permission_denied` / `exec_format` / `resource_exhausted` / `spawn_failed`）直接拼进中文句子，用户与 Agent 均无法解读；
2. **「重新安装应用」在场景 D 下是错误动作指引**：EDR 拦截与隔离属性都与安装完整性无关，重装无效。Agent 收到该文案只会反复重试 grep，最终向用户输出「建议重装」。

#### 3.6.4 处置

| 编号 | 动作 | 说明 |
|---|---|---|
| **E1** | **错误文案按原因分层** | 按 §3.6.2.1 的四类给不同动作：D1（瞬时）→ 提示稍后重试，**不给永久性指引**；D2 → 引导检查安全软件隔离区 / 开发态跑 `prepare:rg`；D3 → 按平台给拦截处置（macOS `xattr -cr`、Windows 加白名单），**不得出现「重新安装应用」**；D4 → 如实告知平台不支持。文案经 i18n（`errors` 命名空间）承载，**不得拼接原始诊断枚举** |
| **E2** | **替代路径（降级不可用时的兜底）** | 依 §3.6.2.2，均为 **Agent 侧可达**：① `list_directory` + `read_file` 组合（语义精确但慢）；② `run_shell` 调系统搜索（Windows `findstr` / `Select-String`，macOS 系统 `grep` / `mdfind`；默认开启，需审批）。**优先级低于 E5 的自动降级**——E5 落地后，这两条是「降级也失败」时的最后出口 |
| **E3** | **把 rg 不可用登记为一等故障状态** | 现有 `grep-ripgrep-unavailable` 诊断已具备，需确保其能到达用户可见面（而非只落日志）；并配合 §2.6 的 `grep.terminate` 日志形成完整可观测面 |
| **E4** | **（次要）Linux 支持面收口** | 二选一：① 把 linux 纳入 `supported` + manifest + `after-pack.cjs`（约 4 处改动，远低于恢复 fallback 的成本）；② 显式标注「Linux 构建不含内置搜索」并使 `pack:linux` fail-loud，不再静默产出残缺包。**登记为独立待决项**，不在本方案实施。**注**：§3.8 矩阵令 `unsupported` 也走降级，故 Linux 用户在**能力层面**已获得可用搜索；但 F14（包内仍无 rg）未变，E4 仍应处理，仅紧迫性下降 |
| **E5** | **降级接线（定案）** | **接线修复后的 `grepFallbackJs`**（§3.2）作为 rg 不可用时的**自动降级**——**不询问用户、不设开关**（问「要不要降级」等于问「要不要干活」，无意义）。**接线位置**：`grepExecutor` 的不可用**汇聚判定点**（三出口收敛，§3.2）；**是否降级按 §3.8 矩阵逐 reason 裁定**。**降级结果必须带标识 + 边界摘要**（§3.2）——**开关与标注是两件事**：不加开关，但必须标注，否则退回静默漏报。原「复用 `searchFilesUnder`」与「另建一份 Node 实现」两个提法**均已撤回** |
| **E6** | **（优先级最低）pack 阶段逐层签名** | macOS：`after-pack.cjs` 改**自内向外逐层签名**（先 `Contents/Resources/bin/rg`，再 app），替换 `codesign --deep`。**收益边界必须讲明（F22）**：ad-hoc 签名本身不被 Gatekeeper 信任，故**逐层签名解决不了「带隔离属性被拦」这一根因**，只是让内层签名结构更规整。Windows：为 exe 签名可显著降低 Defender/SmartScreen 拦截。**真正的解只有 E9（开发者签名 + 公证）或结构性方向（不依赖原生二进制）** |
| **E7** | **照搬 browser 的依赖恢复模式** | 参照 F21：grep 失败时返回结构化 `dependencySetupRequired` + `errorCode`，并加载对应恢复 Skill（如 `grep-setup-guide`），由 Agent 口述分步引导，而非抛出一句不可解的错误。**这是项目内已验证的产品模式**，非新增发明 |
| **E8** | **（待验证，验证未过不得实施）由应用自我修复内层隔离属性** | 思路：app 启动后**自己**清除 bundle 内 rg 的 `com.apple.quarantine` 属性——前提天然满足（能启动 = app 已被放行），只需修复嵌套组件，**用户零操作、不需开发者证书**。**实施前必须验证三项**：① `/Applications` 下自身 bundle 内文件属性是否可写（权限与 SIP 约束）；② 是否触发 TCC 或安全软件告警；③ 是否会被视为规避 Gatekeeper（合规风险）。**另**：本方案曾提出的「应用内**检测 quarantine 并提示用户**执行 `xattr -cr`」**已撤回**——README 的 `xattr -cr` 是递归的（已一并清除 rg 的隔离属性），故该提示要么不触发、要么告知用户一件他已做过的事；且需要用户动手的唯一原因是我们没有开发者签名与公证，用提示掩盖成本决策比不做更糟 |
| **E9** | **（成本决策，非技术细节）为 macOS 投入 Developer ID 签名 + 公证** | 这是「下载后双击即可用」的**唯一**彻底解，也是消除 D3 与 README 中 `xattr -cr` 指引的唯一途径。**属成本决策，应显式拍板，不用提示语糊过去**（见 §8） |

> **关于「要不要有语义可信的降级」**：**要有，且本轮就有**——即修复后的 `grepFallbackJs`（§3.2、§3.5）。三处修正：
>
> - **不再用「第二套搜索引擎 vs 没有兜底」的对立框架**：降级本体就是 Node 实现；其短板（速度、正则能力）已如实标注（§3.5.1），而**中止响应优于 rg**。
> - **`searchFilesUnder` 不作为候选**（架构理由，F23），这一点不变。
> - **不需要新建任何东西**：现有 `grepFallbackJs` 归属层合规、缺陷可修，改造比重写便宜。
>
> 落地后「rg 缺失 = 完全无路可走」不再成立的范围以 **§3.8 矩阵**为准（6 个 reason 降级；`resource_exhausted` / `timeout` / `failed` / `invalid_request` / `cancelled` 不降级）；即使降级本身也失败，仍有 E2 两条 Agent 侧路径。

### 3.7 开发态默认准备 rg

#### 3.7.1 事实

- `package.json`：`"predev": "npm run i18n:generate-types"`，`"dev": "concurrently -k \"npm:dev:renderer\" \"npm:dev:electron\""`——两步均不涉及 rg（F15）。
- `resources/ripgrep/` 仅 `.gitkeep` 被跟踪，staging 目录被 gitignore；`npm install` 不产生它。
- `grep-tool-0.1.7-ripgrep-unavailable-investigation.md:13` 已记录该成因；当前仓库根存在 `.worktrees/`，故**每新增一个 worktree 即复现一次**。

结论：开发态默认开局 grep 不可用，且反复发生——这正是场景 B 值得工程化收口（而非依赖开发者记忆）的原因。

#### 3.7.2 方案：dev 前置「确保当前平台 rg 就绪」

新增薄入口 `scripts/ensure-dev-ripgrep.mjs`，**复用** `prepare-ripgrep.mjs` 导出的 `prepareTarget`（不重写下载与校验逻辑）：

1. 由 `process.platform` / `process.arch` 计算当前 target；
2. 在支持面内（`darwin-x64` / `darwin-arm64` / `win32-x64`）→ 调 `prepareTarget(targetKey)`；
3. 不在支持面（如 linux）→ 打印说明，**不报错**；
4. **任何失败仅告警 + 给出 `npm run prepare:rg` 指引，然后 `exit 0`**，绝不阻塞 `dev`。

接法：`"predev": "node scripts/ensure-dev-ripgrep.mjs && npm run i18n:generate-types"`。

#### 3.7.3 三条设计约束（均有具体成因）

| 约束 | 成因 | 证据 |
|---|---|---|
| **必须幂等、常态零网络** | `prepareTarget` 命中缓存即返回，常态成本 = 读一次约 6 MB 文件 + 一次 sha256（几十毫秒）；只有首次才下载 | F16 |
| **必须只准备当前平台** | 不带 `--target` 时默认准备**三个**平台，在 Windows 上首次会连带下载两个 macOS 包（十几 MB 且本机无用） | F17 |
| **失败必须不阻塞** | npm 的 `pre*` 钩子失败会中断主命令；若准备因无网络 / 代理拦截失败而卡死 `npm run dev`，比现状（grep 报错但其他一切正常）更糟 | npm 生命周期语义 |

#### 3.7.4 与既有决策的关系（澄清一处误读）

`grep-tool-0.1.7-...md:125` 原文：

> 不要让开发态自动静默降级。自动下载会引入网络、供应链和启动延迟问题；应复用既有、受校验的 `prepare:rg` 显式流程。

它否决的是**另起一套静默降级**（例如自动切到 JS 引擎），而 `prepare:rg` 正是它点名要复用的那套流程。因此把 `prepare:rg` 接进 dev **不违背**该决策，反而是决策指的方向。三点顾虑在幂等缓存下亦基本不成立：

| 顾虑 | 幂等缓存后的实际 |
|---|---|
| 启动延迟 | 常态几十毫秒；仅首次有下载耗时 |
| 供应链 | 复用既有双重哈希校验流程，风险面不新增 |
| 网络 | **仅首次**（此点需确认，见 §3.7.5） |

#### 3.7.5 取舍与待确认

**唯一需要确认的点**：首次 `npm run dev` 会自动联网下载 rg（约 6 MB，来自 GitHub，经 `archiveSha256` + `binarySha256` 双重校验）。

- **接受** → 按 §3.7.2 实施；开发态开箱可用，worktree 摩擦一并消除。**本方案按此推进**（与「让开发态默认跑起 `prepare:rg`」的要求一致）。
- **不接受「dev 触发任何网络」** → §3.7.2 退化为「检测 + 明确指引」，不准备、只告警。仍优于现状，但未解决「每次开发都失败」的诉求。

> 该改动与 §3.5（fallback 删或留）**解耦**：先把开发态自动准备做掉，无论 fallback 最终处置如何，开发态体验都改善。

### 3.8 降级矩阵（按 reason / kind 逐一裁定）

**这是 §3.2 接线点的判定依据，也是 E5「触发条件」的正式口径**（取代原「仅 `unavailable`」的模糊表述——评审 B2 指出该表述按 `grepWithRg` 类型口径排除了 `unsupported` / `not_file`，而二者只在 executor 层出现，导致口径悬空）。

**裁定原则（三条）**：

1. **「rg 起不来」才降级；「rg 跑了但报错」不降级**——后者说明请求本身有问题（如非法正则），换引擎只会掩盖错误或给出不一致结果。
2. **根因在降级路径上同样存在的，不降级**——如 fd 耗尽（`resource_exhausted`）与超时，降级只会更差（与「`timeout` 不降级」同一逻辑）。
3. **其余「rg 不可用」一律降级**——这是本方案的核心主张：有结果（带边界标注）优于无结果。

| kind | reason | 降级？ | 理由 |
|---|---|---|---|
| `unavailable` | `not_found` | ✅ | 场景 B（开发态未准备）、D2（安全软件隔离删除）。**最高频** |
| `unavailable` | `permission_denied` | ✅ | D2（执行位丢失 / 权限变更） |
| `unavailable` | `spawn_failed` | ✅ | D3（EDR/Defender 拦截、加载失败） |
| `unavailable` | `exec_format` | ✅ | D3 变体（二进制损坏 / 架构不符） |
| `unavailable` | `unsupported` | ✅ | **场景 A（Linux）**。由 executor `:1472` 出口产生。**注意**：这使 Linux 出厂用户也获得可用搜索，**但不改变** F14（`pack:linux` 仍不含 rg）——E4 仍应处理（纳入支持面或 fail-loud），只是紧迫性下降 |
| `unavailable` | `not_file` | ✅ | 异常安装形态（路径存在但非普通文件）。降级无害且用户有结果 |
| `unavailable` | **`resource_exhausted`** | ❌ | **评审 B3**：根因是 fd 耗尽（EMFILE/ENFILE）。降级路径的 `readdir` / `readFile` **同样耗 fd**，会继续失败；若改造 5 的读失败上报未到位，将退化为静默 `No matches found`——**比现状的显式报错更糟**。处置：**显式报错 + 提示稍后重试**（D1 是瞬时故障） |
| `timeout` | —— | ❌ | rg 能跑只是慢；切到单线程 JS 更慢，无收益 |
| `cancelled` | —— | ❌ | 用户主动取消，不得复活为搜索 |
| `failed` | —— | ❌ | **rg 正常运行但退出码非 0/1**（如正则语法错误）。**这是「请求有问题」而非「引擎不可用」**，降级会掩盖错误或给出不同结果（本方案独立补充，评审未列） |
| `invalid_request` | —— | ❌ | 请求非法（同上） |
| `success` / `no_match` | —— | —— | 正常完成，无降级 |

**矩阵的工程落点**：`resource_exhausted` 的「不降级」由 §3.2 的 `resolveGrepEngine` 判定点实现；`failed` / `invalid_request` / `cancelled` / `timeout` 本就不经该判定点（它们是 `grepWithRg` 的执行结果，不是「引擎不可用」）。

**降级也失败时的兜底**：若降级路径整体异常（含 `resource_exhausted` 未降级的情形），回落到 §3.6.4 **E1 分层文案 + E2 两条 Agent 侧路径**——**绝不静默**。

**与既有宣称的一致性**：本矩阵落地后，「rg 缺失 = 完全无路可走」不再成立的范围是**除 `resource_exhausted` / `timeout` / `failed` / `invalid_request` / `cancelled` 外的全部不可用情形**（即 6 个 reason）。此表述取代 §3.6.4 原「落地后……不再成立」的无限定宣称。

## 四、实施计划

TDD 顺序：先加测试锁行为，再改实现。阶段按「独立可提交、可单独回滚」划分。

**建议执行顺序：Phase 0 → 1 → 3 → 4 → 2a（→ 2b 可选）**。理由：Phase 0（开发态准备）独立且立即见效；Phase 1（终止纪律）解决「卡死」；**Phase 3（降级接线）直接决定「有没有东西给用户用」，紧跟其后**；Phase 4（文案分层）是降级也失败时的最后出口；**Phase 2 已拆分**（评审 P1-1）——2a 收益窄且不阻塞，2b 需全局语义核查，二者均后置（详见 Phase 2 节）。

### Phase 0（独立，可先行）——开发态默认准备 rg

服务 §3.7，不依赖其他阶段。

1. 新增 `scripts/ensure-dev-ripgrep.mjs`：复用 `prepare-ripgrep.mjs` 导出的 `prepareTarget`，**只准备当前平台**，任何失败仅告警 + `exit 0`
2. `package.json`：`"predev": "node scripts/ensure-dev-ripgrep.mjs && npm run i18n:generate-types"`
3. 验证：
   - 删除 `resources/ripgrep/<当前平台>/rg` 后跑 `npm run dev` → 自动准备成功、grep 可用
   - 再次运行 → **零网络**（幂等；可断网复跑验证）
   - 断网且缓存缺失 → 告警 + 指引，但 `npm run dev` **正常启动**
   - Linux 等不在支持面 → 打印说明、不报错、不阻塞
4. **测试放置（评审 P1-3，必须定案）**：`vitest.config.mts` 是三个项目——`electron`（include 为 `electron/**/*.test.ts` **与** `packages/agent-core/**/*.test.ts`）、`renderer`（`src/**/*.test.{ts,tsx}`）、`renderer-perf`（`src/**/*.perf.*.test.tsx`）。**`scripts/**` 不在任何收集范围**，测试文件放脚本旁不会被跑；且被测脚本是 `.mjs`（ESM）。定案：
   - 测试置于 **`electron/tools/ensureDevRipgrep.test.ts`**（命中 electron 项目）；
   - 脚本把可测逻辑导出为**纯函数**（如 `resolveEnsureTarget(platform, arch)` / `decideEnsureOutcome(result)`），测试直接引用纯函数——**不为 `.mjs` 引入 `allowJs` 配置**；
   - 「失败不阻塞」不靠子进程 fixture，而是断言 `decideEnsureOutcome` 在失败输入下返回「告警 + 放行」的判定结果；
   - **如实标注已知代价**（评审瑕疵项）：`.ts` 测试 import `.mjs` 之所以不报错，是因为 `tsconfig.electron.json` 的 `exclude` 含 `electron/**/*.test.ts`（已核实）——即**该 import 完全没有类型检查**，`ensure-dev-ripgrep.mjs` 的导出签名变更不会被 `tsc` 捕获。代价可接受，但应知情（既有先例：`ripgrepPrepareSecurity.test.ts` 等）。

### Phase 1（核心，必须）——终止纪律

1. **RED**：新增 `electron/tools/grepAbortResponse.test.ts`
   - T-A1：abort 后进程正常退出 → `kind: 'cancelled'`、`terminated: 'graceful'`
   - T-A2：abort 后进程**拒绝退出** → 兜底到期强制结算 → `kind: 'cancelled'`、`terminated: 'forced'`，且**有界**
   - T-A3：abort 与 timeout 叠加 → 终态归属为 `cancelled`（先到者优先）
   - T-A4：结算后无残留——**用 fake timers 断言 `grepWithRg` 自身作用域的 `t` / `settleTimer` 已清空**（**前提：必须先落适配二**，注入可控 `ProcessKiller` stub；否则 `spawnUtil` 模块级的 250ms/3000ms 定时器不在可断言范围内，见 §2.5 适配二）
   - T-A5：既有回归（success / no_match / failed / unavailable / timeout）不破
   - **T-A6（新增，跨函数断言，评审 B-1）**：**断言进程真实退出**——不能只断言「工具 Promise 按时 settle」。做法：注入 stub killer 并断言其被调用且 `verified === true`；或（更强）在真实 fixture 上断言 supervisor 终态为 `terminated`。**这条是防「测试全绿但 macOS 上 rg 泄漏」的唯一手段**
   - **T-A7（新增，静态护栏，本方案自行补充）**：**跨平台可验证的 `detached` 断言**。原因：Windows 的 `taskkill /T /F` 对任何子进程都生效，**有无 `detached` 都会通过**——T-A6 在 Windows 开发机上无法红绿验证适配一。故补一条 `toolReliabilityGuards` 风格的源码静态断言（同该文件既有护栏手法：`read()` 源文件 + `toContain`），使 AC2b 的「代码复核」从人工动作变为 CI 门禁。详见 §3.4 新增护栏条目
2. **GREEN**：
   - **适配一**：grep 的 spawn 选项补 `detached: process.platform === 'darwin'`（对齐 `runShellExecutor.ts:330`）
   - **适配二**：新增 `ProcessKiller` 注入 seam（`types.ts` / `grepWithRg` 参数，生产默认 `processTreeKiller`）
   - `grepWithRg` 引入 `ProcessSupervisor` + `requestTermination` + 兜底 `finish`
3. 补 `grep.terminate` 日志（含 `terminated: 'forced'` 的 warn；**消费 `supervisor.terminate()` 的返回值**，记录 `termination_failed` 与 `treeKillVerified`）——出处：**第一轮评审 P2-4**（其编号体系统为 B1–B3 / P1-1–P1-3 / P2-1–P2-4；第二轮报告无 P2-4，其 P-4 指 Phase 2a 接线落点，二者不同，勿混）
4. 更新 `ripgrepExecutorProcess.test.ts` 的「超时和取消返回结构化状态」覆盖新字段

### Phase 2（已拆分，可后置）——信号来源修正

**评审 P1-1 收口**：原稿在此处三处自相矛盾——§2.4 正文与消费方核查表按**全局替换**展开，本阶段 GREEN 也写全局，而待拍板项 3 与 §7 风险表写「倾向先只在 grep 注入」。现拆为两个可独立提交的步骤，并**明确本阶段整体不阻塞后续**：

- **Phase 2a（优先，范围窄）**：仅让 grep 拿到合成信号——在 grep 路径注入 `AbortSignal.any([chatSignal, signal])`，**不改 `ctx.signal` 的全局语义**。它是 §3.2 改造 2 的前提（rg 路径与降级路径都受益）。
- **Phase 2b（全局，后置且可选）**：把 `executionContext.signal` 整体换成合成信号（并修 G4 的降级取值缺陷）。**前置条件**：逐个核查全部 `ctx.signal` 消费方（§2.4 表）确认无副作用。

**2a 的接线落点必须定案**（评审 P-4）：`executionContext`（`toolChatLoop.ts:3313-3344`）**只携带工具级 `signal`，`chatSignal` 不在上下文里**——「只给 grep 注入合成信号」在现有结构上**没有现成落点**。二选一：

| 方案 | 做法 | 评价 |
|---|---|---|
| **(a) ctx 增字段（建议）** | `ToolExecutionContext` 增加可选 `chatSignal?: AbortSignal`，由 `grepExecutor` 内部合成 | 更干净；且与 §3.2 改造 2 的降级路径**共用同一信号源**；不产生 toolChatLoop 侧的工具特例分支 |
| (b) toolChatLoop 侧特例穿线 | 在装配 `executionContext` 时对 grep 特判，直接传入合成信号 | 引入「按工具名特判」的分支，与既有装配风格不符 |

**⚠️ 两者都不得破坏既有区分逻辑**：`toolChatLoop.ts:3265` / `:3289` 现有「仅工具取消 vs 整聊取消」的判定依赖 `signal` 与 `chatSignal` **两个独立变量**（`signal.aborted && !chatSignal.aborted`）。2a/2b 只应**新增**合成信号来源，不得把这两个变量合并或改为同一个对象。

**为何可后置**：Phase 1 已把「rg 不响应终止」的等待上界压到约 2s，Phase 2 的增量收益只是「中止更灵敏」；它与降级接线（Phase 3）无依赖关系。

1. **前置核查**：列出全部 `ctx.signal` / `context.signal` 消费点，确认新语义无副作用（§2.4 表）
2. **RED**：2a → 断言 grep 收到的信号在 `chatSignal` abort 时即 abort；2b → 断言 `executionContext.signal` 整体 abort
3. **GREEN**：2a → grep 路径注入合成信号；2b → `executionContext.signal = executionSignal ?? signal`，并用本地 `anySignal` 取代 `AbortSignal.any` 的存在性判断（修 G4）
4. 回归：`read_file` / `list_directory` / `edit_file` / `write_file` / `run_shell` / `browser` 的取消相关测试

### Phase 3（核心）——降级改造与接线

服务 §3.2 / §3.5 / **§3.8 降级矩阵**。**这是本方案的第二个核心阶段**（第一个是 Phase 1 的终止纪律）。

1. **返回形态先改**（评审 P2-2）：`grepFallbackJs` 由 `Promise<string>` 改为 `GrepFallbackResult`（§3.2），承载 `partial` / `skippedFiles` / `readErrors` / `timedOut` / `filesScanned`
2. **RED**：新增/恢复用例（建议恢复 `builtinExecutors.grepFallback.test.ts` 作基线，见下方历史资产）
   - T-B1：**超限必须上报**——构造 >2 MiB 文件，断言 `partial: true` + `skippedFiles` 含该文件 + 摘要含可见说明（**不得**只回 `No matches found`）
   - T-B2：**读失败必须上报**（改造 5）——注入 `readFile` 抛 EACCES，断言 `readErrors` 计数 + 摘要可见
   - T-B3：**先 `stat` 后读**（改造 3）——超限文件**不被读取**（spy 断言 `readFile` 未被调用）
   - T-B4：**中止响应**（改造 2）——`readFile` 收到 signal；abort 后经 `await` 边界即时返回。**不得**断言「同步循环内检查点」——§3.2 改造 2 已说明其无效
   - T-B5：**时间上界**（改造 6）——注入慢遍历，断言到期返回 `timedOut: true` + partial，且不静默
   - T-B6：**清单同源**（改造 4）——walk 使用 `GREP_DEFAULT_IGNORES`，`GREP_SKIP_DIRS` 已不存在
   - T-B7：`engine: 'walk'` 正确写入；`GrepScope` 其余字段（`skipped` / `skippedCount` / `truncated` / `limitReason`）正确填充
   - T-B8：**既有 walk 用例（T-R6-5 三例）适配返回形态后语义断言不变**（评审 P-2）——现三例以 6 参位置调用并直接断言返回**字符串**（`grepScopeExecutor.test.ts:111` / `:125` / `:138`）；返回类型改为 `GrepFallbackResult` 后**不可能原样通过**，须改为读取 `.output` 后保持原有语义断言。**这属于本阶段 RED 的一部分，不是「不动的存量」**
   - T-B9：**降级标识**——降级产出带标识前缀与边界摘要（负面断言：无标识即失败）
3. **GREEN**：按 §3.2 **六处**改造；`GREP_FILE_MAX` 由 1 MiB 改为 **2 MiB**
4. **接线（§3.2 修订后，评审 B1）**：新增 `resolveGrepEngine()` 纯函数，把 executor 的不可用**三出口收敛为单一判定点**（`:1472` / `:1480` / `:1531`）；按 **§3.8 矩阵**决定降级或报错；降级输出加标识前缀
5. **矩阵实现**：`resource_exhausted` 走「不降级」分支（显式报错 + 提示稍后重试）；`failed` / `invalid_request` / `cancelled` / `timeout` 不经判定点
6. 删除 `GREP_SKIP_DIRS`，walk 改用 `GREP_DEFAULT_IGNORES`
7. 更新护栏 9（追加「清单单一真相源」断言）
8. 文档同步（§3.4 表）
9. `data.cancelled` 标记（可选）

> **历史测试资产（可直接复用，不必从零写）**：据评审复核，`builtinExecutors.grepFallback.test.ts`（**16 个 `it`**，287 行）与 `builtinExecutors.grepDispatch.test.ts` 曾在 `34e4a0a4` → `d7880719` 期间存在，最终随 `d7880719`（rg 独占化打包）删除，而该提交 message 仍写作 "bundle ripgrep with **observable fallback**"——正是 §3.1 所述「承诺/实现漂移」的实物证据。建议取回该文件作基线（例如 `git show <deleting-commit>^:<path>`），叠加上述 T-B 新断言。
>
> **核实状态**：本方案独立核实「`d7880719` 中已不含该文件」（与「在该提交删除」一致）；评审报告另经 `git log` 复核并给出更精确的数字——**实为 16 个 `it`**（删除 287 行），提交 message `feat(tools): bundle ripgrep with observable fallback` 属实。**「18 用例」系采信首轮评审记录、与复核不符，以 16 为准。** 相关 `git log` / `git show` 在本轮因 shell 安全分析器与审批档位限制未能由本方案直接执行，实施前请自行核对。

> **顺序约束**：降级接线（第 4 步）与 §3.7 开发态准备**都**落地后，「rg 缺失」才算有完整出路——两者覆盖不同场景（§3.7 覆盖开发态，本阶段覆盖打包态与异常）。

### Phase 4——rg 不可用的分层处置

服务 §3.6.4。**注意**：Phase 3 接线后 `unavailable` 会自动降级，故本阶段文案主要在**降级也失败**（或降级产出不可用）时才面向用户/Agent 呈现——但文案仍要分层，因为它是最后一道出口。

1. **E1（评审 P1-2 修订：必须分两层）**：
   - **Agent 侧文本（主进程产出）**：`grepRipgrepUnavailableUserMessage` 按 `source`（development / bundled）× `reason` 分层，含**动作指引**、不拼原始枚举。**这是主要消费面**——工具错误文本直接进入对话流供 LLM 读取，渲染端翻译覆盖不到。
   - **渲染端机器可读码**：`data` 附带 `reason` / `errorCode`，供 UI 走既有 **R8 模式**（`builtinExecutors.ts:420` 注释：机器可读 `data.errorClass`，文案由渲染端 errorTranslator 取 i18n；实现见 `src/renderer/utils/errorTranslator.ts`）。
   - **不引入主进程 i18n**：已核实 `electron/**` 无 i18next 引用。照原 E1 字面实施，要么超范围引入主进程 i18n 基建，要么把文案降级为纯 errorCode 导致 Agent 拿不到可读指引——两者都不可取。
2. **E2**：分层文案中加入替代路径（`list_directory` + `read_file`、`run_shell` 系统搜索）
3. **E3**：确认 `grep-ripgrep-unavailable` 诊断可到达用户可见面（而非只落日志）
4. **RED → GREEN**：表驱动用例覆盖「开发态 not_found」「打包态 permission_denied / spawn_failed / exec_format」「平台 unsupported」三类文案
5. 同步 `ripgrepExecutorProcess.test.ts` 中既有文案断言（现期望值含原始枚举与「重新安装」指引）

### 门禁

```
npm test                          # 全量
npx tsc -p tsconfig.electron.json --noEmit
npm run build
npm run i18n:check
git diff --check
```

## 五、测试计划（跨平台注意）

**T-A2 的跨平台陷阱**：Windows 上 `child.kill('SIGTERM')` 走 `TerminateProcess`，子进程**无法忽略**，因此「进程拒绝 SIGTERM」的 fixture 只在 Unix 生效。建议两种写法之一：

- 用 `it.skipIf(process.platform === 'win32')` 标注 Unix 专用用例（覆盖 G1 的 Unix 主因）；
- 或改用**跨平台**的等价构造：fixture 派生一个继承 stdio 且不退出的孙进程，使父进程退出后 `close` 不触发——这直接命中「结算单点依赖 close」的通用成因，两平台均可跑。

建议两者都留：前者验证强杀升级，后者验证强制结算。

**fake timers 与测试缝（评审 B-2 订正——原写法不成立）**：

原稿称「把 `GREP_TERMINATE_GRACE_MS` 做成可注入参数 + 测试 seam 即可」，**这不成立**：`processTreeKiller.terminate(proc)` 忽略入参 `deadlineMs`（F26），底层强杀节奏是 `spawnUtil` 的模块常量 `KILL_TREE_GRACE_MS = 250` / `KILL_TREE_TIMEOUT_MS = 3000`。对「进程拒绝退出」fixture，这两个定时器会一直挂着（fixture 的设计就是不退出），**既不受 grace 注入控制、也不会被清空**，T-A4 的「定时器无残留」按原写法必然失败。

**定案（二选一，取前者）**：

1. **给 `grepWithRg` 增加 `ProcessKiller` 注入 seam**（与既有 `grepSpawnProcess` 同形态；`types.ts:78-83` 已有该测试缝的先例与注释）。生产默认 `processTreeKiller`；测试注入「立即 resolve 的可控 stub」。这样定时器面完全收敛到 `grepWithRg` 自身作用域的 `t` / `settleTimer`，fake timers 断言成立。
2. 备选：T-A4 改用真实短定时器 + 注入假 killer，放弃对 supervisor 内部定时器的断言——但仍需 killer seam。

**结论**：**grace 注入解决不了底层 250ms/3000ms 常量，需要的是 killer 注入**。`spawnProcess` 缝保留（fixture 仍用它喂假 rg），**新增 killer 缝**。

**另（评审 P-1）**：原稿「Windows 上 `child.kill('SIGTERM')` 走 `TerminateProcess`」在**复用 `processTreeKiller` 之后不再准确**——Windows 实际路径是 `taskkill /PID /T /F`（F27）。结论（「拒绝退出」的 fixture 在 Windows 上同样构造不出）不变，机制表述需对齐。

**Phase 0（开发态准备）的测试重点在失败路径**——该脚本的价值即「失败不阻塞」：

- 注入不在支持面的 `platform` / `arch` → 成功返回且不抛错；
- mock `prepareTarget` 抛错（模拟断网 / 代理拦截）→ 脚本 `exit 0` 且告警含 `prepare:rg` 指引；
- 断言仅以**当前平台** target 调用 `prepareTarget`（防回归到「三平台全下」，F17）。

**T-A7 的定位（跨平台可验证性）**：Phase 1 的行为断言 T-A6 在 Unix 侧有效，但**在 Windows 开发机上恒绿**（`taskkill /T /F` 对任何子进程都生效）。因此 `detached` 这条前提必须由**静态护栏**兜底——与 §3.4 新增的护栏条目配套，写进 `electron/toolReliabilityGuards.test.ts`（沿用该文件既有的 `read()` + `toContain` 手法）。**这使 AC2b 的「代码复核」不再依赖人工动作。**

**Phase 4（文案分层）的测试**：以 `source × reason` 组合做表驱动断言，重点是**负面断言**——不含原始诊断枚举；对「环境拦截」类原因（`permission_denied` / `exec_format` / `resource_exhausted` / `spawn_failed`）不得出现「重新安装应用」。

**Phase 3（降级）的测试重点**（对应 T-B1~T-B9）：

- **超限上报是不可省的用例**——它锚定「静默假阴性」被消除（T-B1）。断言要同时覆盖**返回体**（`partial` / `skippedFiles`）与**用户可见摘要**（不得只回 `No matches found`）。**读失败上报（T-B2）同等重要**——它是评审 B3 的落地闸：任何静默 `return` 都必须先过它。
- **中止响应（T-B4）**：`readFile` 收到 signal；abort 后经 `await` 边界即时返回。**⚠️ 不得断言「同步循环内检查点命中」**——`scanContentLines` / `countMatches` 是同步函数，abort 事件无法在同一宏任务内改变 `signal.aborted`，该断言永远不可能通过（评审 P2-1）。与 Phase 1 的对照是：rg 侧需 grace + 兜底结算，降级侧靠 `await` 边界即时返回。
- **先 `stat` 后读（T-B3）** 用 spy 断言超限文件未被 `readFile`——防「改了上限值却没改读取时机」的回归。
- **时间上界（T-B5）** 断言到期返回 `timedOut: true` + partial，且摘要可见（不静默）。
- **降级标识（T-B9）** 做负面断言：不含标识前缀即视为失败（防标识被后续重构吞掉）。
- **矩阵（§3.8）用例**：`resource_exhausted` 走显式报错分支（**不降级**）；`failed` / `invalid_request` 不降级。

## 六、验收标准

| 编号 | 标准 | 验证方式 |
|---|---|---|
| AC1 | 中止信号触发后，grep 的工具 Promise 必在 `graceMs + slackMs` 内 settle | T-A1 / T-A2（含「拒绝退出」用例） |
| AC2 | 「进程不响应终止」不再是无限等待，而是强制结算 + `terminated: 'forced'` + warn 日志 | T-A2 + 日志断言 |
| AC2b | **进程真实退出**（树杀生效），非仅「工具按时返回」；macOS 上 `detached` 已设 | **T-A6**（跨函数行为断言，Unix 侧有效）+ **T-A7 静态护栏**（跨平台可跑，覆盖「有无 detached」） |
| AC3 | 聊天中止可**直接**到达 grep，不依赖 `cancelAllToolsForRequest` 联动 | Phase 2a 用例 + 手工验证（可临时摘除 links 注入复测） |
| AC4 | 搜索语义零变化 | 既有 grep 测试（`grepScope*`、`ripgrep*`、`builtinExecutors.pathAlias`、`readReadIntegration`）全绿 |
| AC5 | `GREP_SKIP_DIRS` 已删除；`grepFallbackJs` / `GREP_FILE_MAX` **保留**且被生产路径调用（不再是死代码） | 检索 + 接线断言 |
| AC6 | `GrepScope.engine` **保留**且 `'walk'` 取值可达（降级路径正确写入） | 类型检查 + T-B7 |
| AC7 | 文档与实现一致：`ripgrep-integration-technical-design.md` §0.1 第 18 条的「保留降级」不再是空头承诺 | 文档 diff 复核 |
| AC8 | 全量门禁通过 | §4 门禁命令 |
| AC9 | 开发态 `npm run dev` 在 rg 缺失时自动就绪；准备失败时**不阻塞**启动 | Phase 0 验证项 |
| AC10 | `prepare:rg` 接入后常态**零网络**（幂等缓存命中） | 断网复跑验证 |
| AC11 | rg 不可用文案按原因分层：不含原始诊断枚举，且不对环境拦截类原因给出「重新安装」指引 | Phase 4 表驱动用例 |
| AC12 | **三个不可用出口全部接线**（`:1472` / `:1480` / `:1531` 经单一判定点收敛）；**移走 rg 能触发降级**（场景 B/D2）；开发态准备（§3.7）亦已落地 | 三出口各一例 seam 注入 + 移走 rg 手工验证（**原「只验一个出口」的写法必然失败，见 §3.2 接线点**） |
| AC13 | **降级的边界上报有效**：超限跳过必须出现在返回体与用户可见摘要中；**不得**出现「无匹配」而无跳过说明 | T-B1 |
| AC14 | 降级为**自动切换**（无开关、无二次询问），且结果带降级标识前缀 | T-B9 + 手工验证 |
| AC15 | `GREP_FILE_MAX` = 2 MiB，且超限文件**不被读取**（先 `stat` 后读） | T-B3 |
| AC16 | **读失败必须上报**：`readFile` / `readdir` 失败进入 `readErrors` 计数并出现在摘要中；**不得**静默 `return` | T-B2 |
| AC17 | **降级有时间上界**：超时返回 `timedOut: true` + partial + 可见摘要（不静默） | T-B5 |
| AC18 | **按 §3.8 矩阵裁定**：`resource_exhausted` / `timeout` / `failed` / `invalid_request` / `cancelled` **不降级**；其余 6 个 reason 降级 | 矩阵表驱动用例 + 代码复核 |

## 七、风险与回滚

| 风险 | 评估 | 对策 |
|---|---|---|
| 强杀 rg 影响输出完整性 | 有界代价：已返回的 stdout 仍作为 `partialOutput` 交付，用户看到 `[已取消]` / `[搜索超时，仅展示部分结果]` | 保持既有 partialOutput 语义；`terminated` 字段区分是否被强制 |
| **macOS 未设 `detached` → 树杀静默失效、rg 进程泄漏，而测试可全绿**（评审 B-1） | **高**：`-pid` 非有效 pgid → ESRCH → 不发信号；工具仍按时返回（兜底结算），故 AC1/AC2 不会暴露它 | **已识别并修正**：spawn 补 `detached: process.platform === 'darwin'`（§2.5 适配一），并新增**跨函数断言 T-A6**「进程真实退出」——不只断言工具返回有界 |
| **底层强杀定时器不可注入 → T-A4 写不出来**（评审 B-2） | **中**：`processTreeKiller` 忽略 `deadlineMs`，节奏为 `spawnUtil` 模块常量 250/3000ms | **已识别并修正**：测试缝改为 `ProcessKiller` 注入（§2.5 适配二、§五），grace 注入不作为解法 |
| 兜底结算时进程仍活、后续数据写入已 resolve 的闭包 | 真实风险（内存/句柄泄漏） | `finish` 内 destroy 全部管道（§2.5 代码） |
| 换 `ctx.signal` 语义影响其他工具 | 中：需逐点核查（§2.4） | Phase 2 前置核查 + 相关回归测试；必要时拆分为「先只给 grep 传合成信号」的保守版本 |
| 降级结果与 rg 结果不一致（速度慢、正则能力弱、忽略语义差异） | 真实且**不可完全消除**（§3.5.1）——降级本是「能用」而非「一样好」 | 降级结果带**标识 + 边界摘要**（§3.2）：让 Agent 知道结果不完备，而非误判「搜全了但没有」 |
| 降级路径也失败（如遍历中途整体失败） | 中 | 仍返回 E1 分层文案 + E2 两条 Agent 侧路径；**不静默** |
| 同步扫描段不可中断（灾难性回溯正则） | 低概率、有界：单文件 2 MiB 上限；总时长上界在 `await` 边界生效 | **已知残余风险**（§3.5.1）。同步循环内检查 `aborted` 无效，不得写入死代码（评审 P2-1） |
| **降级接线接错出口**（只在 `grepWithRg` 返回值处） | **已识别并修正**（评审 B1）：原方案如此，会导致场景 B/D2 **完全不触发降级**，AC12 验收必然失败 | 三出口收敛为单一判定点（§3.2）+ AC12 按出口逐个覆盖 |
| **降级路径无时间预算** → 用户长时间干等 | **已识别并修正**（本方案改造 6）：原 `grepFallbackJs` 无任何总时长上界，单线程遍历大仓库可能远超 60s | 复用 `grepTimeoutSec` + 超时返回 partial 并上报（§3.2 改造 6） |
| **`resource_exhausted` 降级反而劣化** | **已识别并排除**（评审 B3）：fd 耗尽的根因在降级路径同样存在，会退化为静默假阴性 | 排除出降级矩阵（§3.8）+ 改造 5 读失败上报作兜底闸 |
| 开发态 `predev` 准备失败阻塞 `npm run dev` | 真实风险：npm `pre*` 钩子失败会中断主命令，比现状更糟 | ensure 脚本捕获全部错误、仅告警并 `exit 0`（§3.7.2 约束 3） |
| 首次 dev 联网下载受企业网络/代理拦截 | 中 | 失败不阻塞；保留 `prepare:rg` 手动指引；幂等缓存使后续无需联网 |
| `AbortSignal.any` / `instanceof` 跨 realm 行为 | 低 | 本地 `anySignal` 兜底 + 类型检查 |

**回滚**：各阶段可独立提交、独立回滚。**Phase 1** 只动 `grepWithRg` 内部（终止纪律），回滚粒度最小且不影响其他工具。**Phase 3** 是降级改造与接线——若需回退，应连同接线一并回退（保留改造但断开接线亦可，此时 `grepFallbackJs` 退回「不可达」状态，不影响主路径）。**Phase 0/2/4** 各自独立，互不依赖。

## 八、待拍板项

1. ~~`GrepScope.engine` 删除还是收窄~~ → **已定：保留**。降级接线后 `'ripgrep'` / `'walk'` 两取值都可达（§3.1、§3.4）。
2. **`limitReason: 'timeout' | 'output_limit'`** 是收窄还是补上超时路径的 scope 上报？（本方案只登记，不处理）
3. ~~Phase 2 的落地形态~~ → **已定案（评审 P1-1 收口）**：拆为 **2a（仅 grep 注入合成信号，优先）** 与 **2b（全局替换 `executionContext.signal`，后置且可选，需先核查全部消费方）**。Phase 2 整体**不阻塞**其他阶段（§4 Phase 2）。
4. **Phase 3 的 `data.cancelled` 标记**是否本轮做（涉及渲染层对「已取消」的呈现口径）？
5. **首次 `npm run dev` 自动联网下载 rg（约 6 MB，GitHub，双重哈希校验）是否接受**？（§3.7.5）本方案按「接受」推进；若不接受，§3.7.2 退化为「检测 + 明确指引」，仍优于现状但未解决「每次开发都失败」。
6. **Linux 支持面**：把 linux 纳入 rg 支持面（`supported` + manifest + afterPack，约 4 处），还是让 `pack:linux` fail-loud 并标注「本构建不含内置搜索」？（§3.6.4 E4）次要项，可独立处理。
7. **E2（文案给出替代路径）是否本轮做**？零成本、直接改善场景 A/D 的「无路可走」，但会改变提供给 Agent 的自救路径。需定：给出几条、以什么措辞（建议至少「`list_directory`+`read_file`」与「`run_shell` 系统搜索」两条）。
8. ~~E5：是否复用 `searchFilesUnder` / 是否新建 Node 文本搜索 / 是否加降级开关~~ → **均已定案**：降级本体 = 修复后的 `grepFallbackJs`（归属层合规、缺陷可修，§3.1/§3.2）；**不加开关**，`unavailable` 时自动切换；**但必须带标识与边界摘要**（开关与标注是两件事，§3.2、§3.6.4 E5）。`GREP_FILE_MAX` 定为 **2 MiB**（§3.2）。
9. **E6：macOS 逐层签名是否做？**（F22）优先级已下调——**它解决不了根因**（ad-hoc 签名本身不被 Gatekeeper 信任）。建议**不做**，把资源投给 E9 或结构性方向。
10. **E7：grep 是否照搬 browser 的 `dependencyRecovery` + 恢复 Skill 模式？**（F21）照搬可复用品类成熟的引导体验，但需新增 Skill 文件与文案资产；若本轮不做，至少应保留结构化 `errorCode` 以便后续接入。
11. **E8：是否先验证「应用自我修复内层隔离属性」？**（§3.6.4 E8）验证成本低（只需查清「app 能否修改自身 bundle 内文件的 xattr」），若可行则用户**零操作**解决 D3。**建议先做验证，再决定是否实施**（验证未过不得实施）。
12. **E9（成本决策，需产品/成本方拍板）：是否为 macOS 投入 Developer ID 签名 + 公证？** 这是消除 D3 与 README `xattr -cr` 指引的**唯一彻底解**，也直接决定「下载后能否双击即用」。**不宜由工程侧自行决定**，也不应继续用应用内提示掩盖。

## 附录：证据索引

| 事实 | 位置 |
|---|---|
| grep 取工具级取消信号 | `electron/toolChatLoop.ts:3196` |
| 合成信号只用于排队 | `electron/toolChatLoop.ts:3253-3258`、`:3260`、`:3276` |
| `executionContext.signal` 写入 | `electron/toolChatLoop.ts:3313`（`signal,` 一行） |
| 内置工具执行调用点 | `electron/toolChatLoop.ts:3398` |
| `clearToolCancel` 清理点 | `electron/toolChatLoop.ts:3442`（finally） |
| 工具调用前检查点 | `electron/toolChatLoop.ts` 内 `throwIfChatCancelled(chatSignal)`（每轮 LLM 前 / 流事件 / 每次工具调用前） |
| 工具取消注册表 | `electron/toolConfirmRegistry.ts` 的 `registerToolCancel` / `signalToolCancel` / `clearToolCancel` / `cancelAllToolsForRequest` |
| 聊天取消联动 | `electron/chatCancelRegistry.ts` 的 `ChatCancelRegistry.signalChatCancel` |
| `grepWithRg` | `electron/tools/builtinExecutors.ts:1072` 起 |
| `grepFallbackJs` | `electron/tools/builtinExecutors.ts:1211` 起 |
| `grepExecutor` | `electron/tools/builtinExecutors.ts:1425` 起 |
| 取消/超时返回分支 | `electron/tools/builtinExecutors.ts` 内 `text.kind === 'cancelled'` / `'timeout'` |
| `GREP_FILE_MAX` / `GREP_SKIP_DIRS` | `electron/tools/builtinExecutors.ts:131` / `:133` |
| `RipgrepRunResult` | `electron/tools/builtinExecutors.ts:925` |
| `GrepScope` / `GREP_DEFAULT_IGNORES` | `electron/tools/grepScope.ts` |
| 进程终止权威实现 | `electron/shell/processSupervisor.ts`、`electron/spawnUtil.ts` 的 `processTreeKiller` |
| 文件工具超时合成 | `electron/tools/toolExecutionResource.ts`（`combineUserAbortAndTimeout`、`FILE_TOOL_TIMEOUT_MS`） |
| 既有静态守卫 | `electron/toolReliabilityGuards.test.ts` 护栏 9 |
| fallback 的既有用例（**保留**） | `electron/tools/grepScopeExecutor.test.ts` 的 walk `describe` 块（3 例）——降级接线后成为该路径的行为保障 |
| 平台支持面（不含 linux） | `electron/tools/ripgrepBinary.ts:36` `supported`；`scripts/ripgrep-manifest.json` `targets` |
| `pack:linux` 不含 prepare:rg | `package.json` `"pack:linux"` |
| afterPack 静默跳过 linux | `scripts/after-pack.cjs` `if (platform === 'win32' \|\| platform === 'darwin') copyBundledRipgrep(context)` |
| `prepareTarget` 幂等缓存 | `scripts/prepare-ripgrep.mjs` `prepareTarget` 首段（`sha256(cached) === target.binarySha256`） |
| 默认准备三平台 | `scripts/prepare-ripgrep.mjs` 末段 `selected` |
| dev 链路不准备 rg | `package.json` `"predev"` / `"dev"` |
| worktree 成因记录 | `docs/develop/grep-tool-0.1.7-ripgrep-unavailable-investigation.md:13`、`:125` |
| macOS ad-hoc 签名与隔离属性 | `scripts/after-pack.cjs` `adHocSignMacApp` |
| 分层文案出口 | `electron/tools/builtinExecutors.ts` `grepRipgrepUnavailableUserMessage` |
| **架构边界规定（F23）** | `docs/develop/architect/product-architecture-design.md` §2.4（业务功能「不属于六块中的任何一块」）、§3.2 原则 1/2（「同一份底层能力，两个消费者」）、§3.1（「Utils 可以被任何一层使用，但不得持有语义」「Storage…不反向依赖任何人」） |
| 业务实现的搜索（F20） | `electron/ipc/ipcShared.ts:33` `searchFilesUnder`；调用方 `electron/ipc/searchIpc.ts` 的 `search:execute`；返回类型 `SearchResult`（`src/shared/domainTypes.ts`） |
| **不可用三出口（F24）** | `electron/tools/builtinExecutors.ts` `:1472`（`resolveRipgrepBinary` 失败）、`:1480`（`inspectRipgrepBinary` 失败）、`:1531`（`grepWithRg` 返回 `unavailable`）；调用点 `:1482` |
| **macOS 树杀前提（F25）** | `electron/spawnUtil.ts:189-195`（`groupPid = -pid`，macOS 进程组 kill，失败即 `catch { finish(false) }`）；对照 `electron/tools/runShellExecutor.ts:330` 的 `detached: process.platform === 'darwin'`；`electron/tools/builtinExecutors.ts:1118` 的 grep spawn **缺**该项 |
| **killer 不可注入（F26）** | `electron/spawnUtil.ts:219-224`（`terminate(proc)` 忽略 `deadlineMs`）、`:9-10`（`KILL_TREE_TIMEOUT_MS = 3000` / `KILL_TREE_GRACE_MS = 250`）、`:155` / `:197`（两处定时器） |
| Windows 树杀路径（F27） | `electron/spawnUtil.ts:157-184`（`taskkill /PID /T /F`） |
| 测试缝先例 | `electron/tools/types.ts:78-83`（`grepSpawnProcess` 注释：「测试缝：grep 进程注入（同 grepWithRg 的 spawnProcess 参数形态）」） |
| typecheck 排除测试文件 | `tsconfig.electron.json` 的 `exclude` 含 `electron/**/*.test.ts`、`src/**/*.test.ts(x)`——故测试内 import `.mjs` 无类型检查 |
| `unavailable` 类型口径（B2） | `electron/tools/builtinExecutors.ts:928`（`Exclude<RipgrepUnavailableReason, 'unsupported' \| 'not_file'>`）；reason 全集见 `electron/tools/ripgrepBinary.ts:7-14` |
| 静默读失败（B3） | `electron/tools/builtinExecutors.ts` 内 `scanFile` 的 `catch { return }`、`walk` 的 `catch { return }` |
| **R8 模式与渲染端 i18n（P1-2）** | `electron/tools/builtinExecutors.ts:420`（机器可读 `data.errorClass`，文案由渲染端 errorTranslator 取 i18n）；`src/renderer/utils/errorTranslator.ts`；`electron/**` 无 i18next 引用 |
| **vitest 收集范围（P1-3）** | `vitest.config.mts` 三个项目：`electron`（include `electron/**/*.test.ts` **与** `packages/agent-core/**/*.test.ts`）、`renderer`（`src/**/*.test.{ts,tsx}`）、`renderer-perf`（`src/**/*.perf.*.test.tsx`）——**`scripts/**` 在任何项目都不被收集** |
| 历史测试资产 | 据评审复核：`builtinExecutors.grepFallback.test.ts`（**16 个 `it`**，删除 287 行）、`builtinExecutors.grepDispatch.test.ts`，随 `d7880719` 删除（message 含 `observable fallback`）。**首轮评审记为 18 用例，已订正为 16**；本方案独立核实的部分为「`d7880719` 中已不含该文件」 |
