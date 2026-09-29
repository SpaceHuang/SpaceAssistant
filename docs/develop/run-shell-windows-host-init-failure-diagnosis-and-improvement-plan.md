# `run_shell` 在 Windows 上「宿主进程初始化失败」（0xFFFF0000 / 0x8009001D）：诊断与改进方案

> 文档日期：2026-09-20
> 文档性质：问题分析与改进方案，本次不含代码实现
> 证据来源：
> - Shell 执行日志：`.agent/logs/Agent-*.log`、`logs/Agent-*.log`（全量 `shell.exec.finish` 共 95 条 = 本次补测前的 94 条 + §2.3.1 复测 1 条）
> - 会话事件流：`sessions/d05fe8a7-2790-4cb6-8fe6-b18ac1b49237-20260920/events.jsonl`、`sessions/b680b181-.../events.jsonl`
> - 安全审计：`.agent/logs/SecurityAudit-20260920.log`
> - 代码：`electron/shell/*`、`electron/tools/runShellExecutor.ts`、`electron/tools/runShellPlan.ts`、`electron/tools/toolchainResolver.ts`、`electron/processOutputEncoding.ts`、`electron/confirmation/*`
> - 本机实测：PowerShell 5.1 启动组合、令牌与特权、CAPI/CNG/Schannel、冷启动压力测试、Provider 枚举
> - 同目录既有对照文档：`run-shell-command-failure-diagnosis-and-remediation-plan.md`（`exitCode=0` 假失败与结果链路）、`bash-run-shell-current-state-and-optimization-review.md`（cmd → PowerShell 迁移决策）
>
> 修订记录：
> - **v1.0**（2026-09-20）：初版。区分「真因未定的环境故障」与「确证的产品缺陷」，后者给出可独立推进的改进方案。
>
> 待办（本文未决，需后续补）：
> - P2-F「无人档位下 high 风险的合法路径」需**产品决策**（安全策略，不预设结论）。
> - 环境层真因**尚未定位**；但已确认为**产品路径上的确定性失败（11/11）、可稳定复现**，因此**不需要"等下一次故障现场"**，而应在 Electron 主进程内做逐变量隔离（见 §2.3.2 的实验局限、§5.4.1 的方法；§5.4.3 进一步给出常态化埋点方案）。
> - 环境层真因**已确证**（§1.1 / §2.3.3）：产品自身的环境白名单大小写敏感缺陷，**修复见 §5.0（P0-0）**。原"需等下一次故障现场定性"的待办**已关闭**——根因已在本机单变量复现。
> - v1.3（2026-09-20）：**L0 根因确证并复现**。§1.1 由「真因未定」改为「根因已确证」；新增 **§5.0 P0-0 修复方案**、**§2.3.3 决定性实验**；§2.3.2 / §2.4 H1 / §2.5 / §3 / §4 同步收敛；§5.4 定位调整（不再需要"给真因定性"）。
> - v1.4（2026-09-20）：**更正三处**。
>   - §2.3.3 补全判定矩阵（缺键 / 空串 / `WINDIR` 不能替代 / 大小写变体并存时自报值），并写明"验证必须让目标进程自报"。
>   - §5.0(b)：`|| ''` 会**主动注入空串**，改为"仅在取到有效值时写入"；同时明确**这是纵深防御而非修复**（缺键与空串同样失败）。
>   - §5.0(a)：大小写归一化**限定 win32**（POSIX 键名大小写敏感，无条件归一化会改变白名单语义），并补 POSIX 回归测试。
>   - §5.4.3 静态比对表更正：两路径 `env` **并非同一基底**（`run_shell` 经白名单、`run_script` 不经），该差异**正是根因**；原"看代码已到尽头"为 v1.2 残留误判。
>   - §6 修正 Phase 编号跳号。
> - v1.2（2026-09-20）：新增 **§5.4.3 常态埋点与双路径对照**（含静态比对结论、`run_script` 执行期埋点缺口、6 组埋点、4 条约束与能力边界）；同步 §5.2 allowlist、§6 实施顺序、§7.1 单测、§8 代码落点。
> - v1.1（2026-09-20）依据评审 `docs/review/20260920-run-shell-windows-host-init-failure-plan-review.md` 修订：**撤销 v1.0 的「时间相关、间歇性」结论**，并修正 D5（详见各节「修订说明」）。

## 1. 结论摘要

本议题包含**四个层次**的问题，必须分开处理，否则会把「产品自身的确定性缺陷」和「结构性设计缺陷」混为一谈：

### 1.0 根因层（**最高优先**）：环境白名单大小写敏感

**这是本次故障的直接原因，且是产品自身缺陷**（不是宿主机问题）。修复后 `run_shell` 应恢复可用。详见 §1.1 与 §5.0。

### 1.1 执行环境层：**根因已确证并复现** —— 环境白名单大小写敏感剔除了 `SystemRoot`

`run_shell` 在 Windows 上报：

```
exitCode      = 4294901760 (0xFFFF0000)
exitCodeHint  = Windows 宿主进程初始化失败（0xFFFF0000）
semantics     = WINDOWS_HOST_INIT_FAILED
stderr        = Windows PowerShell 内部错误。加载托管的 Windows PowerShell 失败，返回错误 8009001d。
hresult       = 0x8009001D  (NTE_PROVIDER_DLL_FAIL：加密服务提供程序 DLL 加载或初始化失败)
```

**根因（产品自身缺陷，已本机单变量复现）**：

```
electron/shell/environmentResolver.ts:3-6
  BASE_KEYS 白名单写的是「大写」 'SYSTEMROOT' / 'COMSPEC'
  ↓
electron/shell/environmentResolver.ts:24
  allowed.has(key) 是 Set 精确匹配（大小写敏感）
  → Windows 真实键名 'SystemRoot' / 'ComSpec'（混合大小写）被剔除，进入 removedKeys
  ↓
electron/processOutputEncoding.ts:23,26
  env.SystemRoot = base.SystemRoot ?? ''   → 子进程拿到 SystemRoot = ''（空串）
  ↓
powershell.exe 以 SystemRoot='' 启动 → 托管宿主初始化失败（0x8009001D）→ exit = 0xFFFF0000
```

**决定性单变量实验**（§2.3.3 有完整矩阵）——唯一变量是 `SystemRoot` 的取值：

| 实验 | 结果 |
|---|---|
| `SystemRoot='C:\WINDOWS'` | ✅ `rc=0` |
| `SystemRoot=''`（空串） | ❌ `0xFFFF0000` + `8009001d` |
| 完全无 `SystemRoot` 键 | ❌ `0xFFFF0000` + `8009001d` |

**套用产品管线**（来自仅含混合大小写键的 Explorer 式源 env）：存活 9 键、`SystemRoot`/`ComSpec`/`windir` 被剔除、回填后子进程**唯一**的 systemroot 类键是空串 → ❌ 失败；而**改白名单为大小写不敏感** 或 **仅补回 `SystemRoot`** → 均 ✅ 成功。

**为什么此前一直查不到（关键）**：

| 场景 | 结果 | 解释 |
|---|---|---|
| 打包版（Explorer/快捷方式启动）→ `run_shell` | ❌ 11/11 | 源 env **只有混合大小写** `SystemRoot` → 被剔除 → **必现失败** |
| 开发模式（bash/终端启动）→ `run_shell` | ✅ | Git Bash / MSYS 的 env 键是**大写** `SYSTEMROOT`，恰好匹配白名单大写键而存活 ⇒ Windows 查找不区分大小写，实际生效 → **bug 被掩盖** |
| `run_script` → python → powershell | ✅ | `buildPythonScriptEnv` 走 `buildShellEnv(process.env)`，**不经过白名单**，`SystemRoot` 原样透传 |
| 终端 / 其他 Agent / 交互式 PowerShell | ✅ | 不经过本产品白名单 |

> **这也一并解释了 §2.3.2 全部"实验通过"的假象**：所有人工探针都从 bash/Python 继承环境，带着大写 `SYSTEMROOT`，因此永远复现不出来。根因不在"父进程/句柄/Job"，而在**源 env 的键名大小写**。

**性质**：这是产品路径上的**确定性失败**（11/11），不是「时间相关的间歇性阻断」。全量日志统计：

```
builtin-windows-powershell：11 次执行，exitCode=0 的 0 次（11/11 失败）
横跨 2026-09-11 ~ 2026-09-20（9 天、6 个会话、2 种 environmentFingerprint）
```

> **修订说明（v1.1，评审 R1 → v1.3 根因确证）**：
> - v1.0 曾把该故障描述为「宿主机层面、时间相关的间歇性阻断」，并以「同一实例约 40 分钟后实测正常」为据。**该结论错误，已撤销**：所谓「40 分钟后正常」的全部证据（`rc=0` 20+ 次、冷启动 40/40）**均经 `run_script` 的 Python 孙进程执行**，不是产品的 `run_shell` 路径；而当天 01:17 那次真正的产品 `run_shell` 在**审批层被 `agent-deny` 拒绝、从未执行**（详见 §2.3.1）。
> - v1.1 起，凡引用「PowerShell 正常」的证据，一律标注其执行路径。
> - **v1.3 起，§1.1 由「真因未定」改为「根因已确证」**：真因是产品自身实现缺陷，第 5 节新增 **P0-0（最高优先）** 对应修复。

**本文其余建议不依赖根因**——把「11/11 失败」放大成「`run_shell` 永久不可用」的，还有下面第 1.2、1.3 节的确证缺陷；且根因修复后，这些缺陷（无降级链、诊断字段被丢弃、错误的换工具建议）依然需要修复。

### 1.2 执行层：确证的三个产品缺陷（可独立修复）

1. **无宿主级降级链**。Windows 只有单一 profile（`powershell.exe`，且硬编码 5.1 语义的 `-EncodedCommand` 参数），文档明确写了「**不自动探测或回退到 `pwsh`/cmd/Git Bash/WSL**」。实测 `cmd.exe` 可用（且历史日志证明它长期可用），`pwsh` 未安装，WSL `bash` 不可用。即：**唯一的 shell 通道被锁死在最脆弱的一条实现上，一旦宿主初始化失败即整体报废、零降级路径**。
2. **关键诊断字段进不了日志**。`electron/shell/shellLogFields.ts` 的 `ALLOWED_KEYS` **不含 `hresult`、不含 `exitCodeAdvice`**。后果：全量日志里搜不到 `8009001d`；诊断「宿主为什么起不来」最关键的两个字段恰好被 allowlist 丢弃，只能回到 `sessions/*/events.jsonl` 才能找到。
3. **错误建议在教模型改用脚本**。`electron/shell/shellExitCodes.ts` 中 `0xFFFF0000` 的 `advice` 第一条是「**改用 run_script（Python subprocess）执行同一命令**」；`describeHresult` 的建议也有「仍失败则改用 run_script」。这直接导致 Agent 在 `run_shell` 失败一次后**永久改用 Python 包 shell**（详见 `edit-file` 案与 `run-shell-command-failure` 案，同一元问题）。

### 1.3 审批层：`run_shell` 在无人档位下**结构性**无法获批

`b680b181` 会话中一次 `run_shell` 被拒，审计链完整可查：

```
policy.decision: ruleId=shell-precheck-auto-allow, action=auto-evaluator,
                 decision=require-confirm, answerer=agent
confirm.request: actor=agent, actorRef={profileId:'approval-default'}
confirm.outcome: outcome=rejected, cause=agent-deny, latencyMs=2333
```

拒绝理由（原文）：*「…授权仅能为 unknown，按阈值矩阵 high 风险且授权不足应拒绝…」*

机制上这是**数学必然**，不是判断失误：

| 维度 | 取值 | 来源 |
|---|---|---|
| risk | `high` | `security-approval` skill：探测凭据/身份类 → high 起 |
| authorization | `unknown` | skill 明文：无人自动化上下文只能 `unknown` / `low` |

而阈值矩阵（`src/shared/confirmation/approvalVerdict.ts`）要求 `risk=high` 时 `authorization ≥ medium` 才放行；同时代码侧 `APPROVAL_MAX_AUTHORIZATION = 'low'`（`electron/confirmation/approvalAgent.ts`）把授权维度**强制截断到 `low`**。

> **`low` < `medium`，且上限不可达上限之上 ⇒ 无人档位下只要 risk 判为 high，结论只能是 deny。**

同一 requestId 下的对比更能说明问题：`run_script` 走 `answerer=user`（真人点同意，全部 `approved`），`run_shell` 走 `answerer=agent`（机审，high 必拒）。**这是「Agent 学成用 Python 而非 shell」的又一条结构性成因**，与 1.2 的第 3 条叠加。

### 1.4 修复优先级（本文建议）

| 优先级 | 项 | 是否依赖真因定论 |
|---|---|---|
| **P0-0** | **根因修复：环境白名单大小写敏感（§5.0，两处）** | 否（**根因已确证**） |
| P0 | 修 `exitCodeAdvice` 措辞（不再教模型换工具） | 否 |
| P0 | 日志 allowlist 补 `hresult` / `exitCodeAdvice` | 否 |
| P0 | 宿主级降级链（`pwsh → cmd`，含方言预检重跑） | 否 |
| P2 | ~~主动最小复现~~ **（已于 §2.3.3 执行完毕，用于确证根因；保留为回归验收）** | — |
| P2 | 失败现场诊断包（模块清单 / provider 枚举 / 相关事件 / hresult 原文）——根因已定后**降级为可选**，见 §5.4.2 | 否 |
| P1 | `notExecutedReason` 增加 `agent_denied` | 否 |
| P1 | `factsSummary` 渲染修正、审批线索包取全部子命令 | 否 |
| P2 | 无人档位下 high 风险的合法路径（策略问题，需产品决策） | 否 |
| P2 | `toolchainResolver` 存在性检查、PATH 双写清理 | 否 |

## 2. 证据

### 2.1 启动链路：唯一的 spawn 与唯一的 profile

```
run_shell
  → planRunShellExecution()            electron/tools/runShellPlan.ts
      ├─ resolveSpec() / profileForPlatform('win32')
      │    → WINDOWS_POWERSHELL_PROFILE  electron/shell/shellProfiles.ts
      │        executable: 'powershell.exe'
      │        commandArgsTemplate: ['-NoLogo','-NoProfile','-NonInteractive',
      │                              '-ExecutionPolicy','Bypass',
      │                              '-EncodedCommand','{encodedCommand}']
      ├─ resolveShellEnvironment() → buildShellEnv()   electron/processOutputEncoding.ts
      └─ prepareShellExecution()（冻结 profile / spawnSpec / cwd / timeout / env / facts）
  → executePreparedShellExecution()
      → spawn(spec.executable, spec.args, { cwd, env, windowsHide: true, shell: false,
                                            detached: process.platform === 'darwin' })
                                          electron/tools/runShellExecutor.ts:294
```

关键点：

- **`profileForPlatform('win32')` 只有 `WINDOWS_POWERSHELL_PROFILE` 一个返回值**，没有探测、没有备选、没有降级分支。
- spawn 是普通 `child_process.spawn`，**不带任何进程属性/token 参数**。
- `detached` 在 Windows 恒为 `false`；`windowsHide: true` 即 `CREATE_NO_WINDOW`。

### 2.2 时间线：故障与迁移窗口完全重合

全量 `shell.exec.finish`（95 条）按 profile 分期：

| 时期 | profile | 结果 |
|---|---|---|
| 2026-05-31 ~ 07-18 | **`cmd`** | **38 次 `exitCode=0` 成功**；失败码为 1 / 2 / 3 / 128 / 255 这类真实命令退出码 |
| 2026-09-11 ~ 09-20 | `builtin-windows-powershell` | **11 次调用 100% 失败**，全部 `4294901760` / `WINDOWS_HOST_INIT_FAILED`（口径与 §2.3 一致） |

失败明细（11 次；每次都有正常 PID，存活 2.6–5.1 秒后自退）：

| 时刻 | 会话 | PID | durationMs | spawnToExitMs | env 指纹 |
|---|---|---|---|---|---|
| 2026-09-11T15:29:43Z | `52ee622a` | 36252 | 3072 | — | `ba1ccff7c42a` |
| 2026-09-11T15:29:48Z | `52ee622a` | 12848 | 3186 | — | `ba1ccff7c42a` |
| 2026-09-15T21:03:06Z | `15fa1830` | 39532 | 2740 | 2734 | `ba1ccff7c42a` |
| 2026-09-17T13:55:01Z | `2b517c69` | 7448 | 2660 | 2656 | `ba1ccff7c42a` |
| 2026-09-18T01:26:42Z | `47fba714` | 36148 | 2951 | 2943 | `ba1ccff7c42a` |
| 2026-09-18T15:19:02Z | `946c00d5` | 35468 | 5098 | 5090 | **`f8fdf76be245`** |
| 2026-09-19T05:31:55Z | `61627b42` | 32872 | 2761 | 2744 | `ba1ccff7c42a` |
| 2026-09-19T05:33:53Z | `61627b42` | 26464 | 2683 | 2674 | `ba1ccff7c42a` |
| 2026-09-19T08:00:49Z | `97be98c4` | 41344 | 2625 | 2619 | `ba1ccff7c42a` |
| **2026-09-20T00:37:42Z** | **`d05fe8a7`** | **30156** | **3045** | **3040** | `ba1ccff7c42a` |
| **2026-09-20T04:21:29Z** | **`b680b181`** | **39564** | **3053** | **3048** | `ba1ccff7c42a` |

> 末行即 §2.3.1 的复测（经**产品路径** `run_shell`，命令 `Write-Output ok`）。

三个要点：

1. **PID 正常产生 + `spawnToExitMs` 2.6–5.1 秒** ⇒ 进程创建成功，是 `powershell.exe` **自己**在初始化托管宿主时失败并打印该报错。**不是 spawn 失败，也不是命令行构造失败。**
2. **两种不同的 `environmentFingerprint` 都失败**（`ba1ccff7c42a` 10 次、`f8fdf76be245` 1 次）⇒ 与**用户环境漂移**无关。（注：两个指纹都是 `buildShellEnv` 产出的**产品 env**，故该对照只能排除"用户侧环境差异"这一项，**不能**排除"产品注入的某个 env 特征为共因"——后者由 `run_script` 同源 env 正常来间接排除，见 §2.4 H1 与 §2.3.2。）
3. 故障窗口与迁移完全重合：`docs/develop/bash-run-shell-current-state-and-optimization-review.md:729-730` 明确记载「移除 cmd profile」「Windows 固定使用系统内置 `powershell.exe`…**本阶段不自动探测或回退到 `pwsh`/cmd/Git Bash/WSL**」。

### 2.3 产品路径：11/11 失败，零成功

按 profile 分期的全量统计：

| 时期 | profile | 次数 | `exitCode=0` | 结果 |
|---|---|---|---|---|
| 2026-09-11 ~ 09-20 | `builtin-windows-powershell` | **11** | **0** | 全部 `4294901760` / `WINDOWS_HOST_INIT_FAILED` |
| 2026-05-31 ~ 07-18（迁移前） | `cmd` | 38 | 38 | 正常；失败码为 1 / 2 / 3 / 128 / 255 等**真实命令退出码** |

11 次全部见 §2.2 明细表（末行为 §2.3.1 的产品路径复测）。**这是确定性故障，不是间歇性抖动。**

### 2.3.1 撤销一处误判：所谓「40 分钟后完全正常」

v1.0 据此判断「间歇性」。核实后**该对照无效**，记录如下以免重犯：

| 项 | 事实 |
|---|---|
| 被引用的「正常」证据 | `b680b181` 中 `rc=0` 20+ 次、冷启动 40/40（events seq 42140 / 55993 / 86958） |
| **实际执行路径** | **全部经 `run_script` → `python.exe` → `powershell.exe`（Python 孙进程）** |
| 同日产品路径 | `b680b181` 中 `run_shell` **仅 1 次**（seq 56062），且在**审批层被 `agent-deny` 拒绝**（seq 56072），**从未执行** |
| 当日 `shell.exec.spawned` | `Agent-20260920.log` 全天仅记录 00:37:42 那次失败；01:17 无任何 spawn |
| 结论 | 「同实例」成立，但「同路径」不成立 → 原推理的前提不存在；「不复现」实为「未复测」 |

**本次补做复测（经产品路径）**：在 `b680b181` 中以低风险命令 `Write-Output ok` 走 `run_shell`（避开 `agent-deny`）：

```
exitCode      = 4294901760 (0xFFFF0000) / WINDOWS_HOST_INIT_FAILED
stderr        = Windows PowerShell 内部错误。加载托管的 Windows PowerShell 失败，返回错误 8009001d。
durationMs    = 3053    spawnToExitMs = 3048
```

**即：产品路径此刻仍然失败。** 失败统计更新为 **11/11**（含本次），`0x8009001D` 从未停止复现。

### 2.3.2 已尝试的变量隔离实验（及一处必须记录的实验局限）

为验证「是否由调用者 / 父进程身份导致」，在当前（故障可复现）状态下做过如下实验：

| 实验（同一时刻、同一台机） | 结果 |
|---|---|
| `run_shell`（产品路径：`SpaceAssistant.exe` → `powershell.exe`） | ❌ `0xFFFF0000` + `8009001d` |
| `run_script` → python → `powershell.exe` | ✅ `rc=0` |
| `CreateProcessW` + `PARENT_PROCESS = python(自身)` | ✅ `exitCode=0` |
| `CreateProcessW` + `PARENT_PROCESS = SpaceAssistant.exe` | ❌ `0xC0000142`（STATUS_DLL_INIT_FAILED） |
| `CreateProcessW` + `PARENT_PROCESS = explorer.exe` | ❌ `0xC0000142` |
| `CreateProcessW` + `PARENT_PROCESS = SpaceAssistant` + `CREATE_BREAKAWAY_FROM_JOB` | ❌ `0xC0000142`（排除 Job 归属） |
| `CreateProcessW` + `PARENT_PROCESS = SpaceAssistant`，target = `cmd.exe` | ❌ `0xC0000142`（排除 PowerShell 专有因素） |

**该实验不能用于归因产品真因**，两条理由必须记下，否则后续会误用：

1. **错误码不同**：实验产出 `0xC0000142`（进程**启动期** DLL 初始化失败），产品产出 `0xFFFF0000` + `8009001d`（宿主**已启动**、随后自身失败退出）。两者是不同层次的失败，不能互相解释。
2. **不是 `SpaceAssistant` 特有**：`explorer.exe` 作父进程同样失败，target 换成 `cmd.exe` 也失败 ⇒ 更像 `PROC_THREAD_ATTRIBUTE_PARENT_PROCESS` 机制本身的副作用。

**成因已定位**：`PARENT_PROCESS` 会让新进程继承**指定父进程**的 mitigation policies。实测：

| 进程 | DEP | **ExtPointDisable** | SideChannel |
|---|---|---|---|
| python（self / 新起） | `0x5` | **无** | `0x100` |
| `SpaceAssistant.exe` | `0x5` | **`0x1`** | `0x100` |
| `explorer.exe` | `0x1` | **`0x1`** | `0x100` |

父进程带 `ExtPointDisable` 的实验组**全部失败**，不带的两组**全部成功** —— 与上表完全吻合。

**并且，这恰好证明 `ExtPointDisable` 不能解释产品故障**：进程链实测为 `python ← SpaceAssistant ← explorer`，即 `python.exe` 是 `SpaceAssistant.exe` 的**直接子进程**，却**未**继承 `ExtPointDisable` ⇒ 该 policy **不通过正常 spawn 继承** ⇒ 产品路径（正常 spawn）的 `powershell.exe` 也不会带它。

**另两项实测事实（供后续排查）**：

- **子进程位于 Job Object 中**（`python` 与 `SpaceAssistant` 的 `IsProcessInJob` 均为 `True`）；`CREATE_BREAKAWAY_FROM_JOB` 不改变失败结果。
- `SpaceAssistant.exe` 与 `python.exe` 的**可见 mitigation 差异仅 `ExtPointDisable`**（DEP / SideChannel 相同），而该差异已被证明不参与产品故障。

**结论（v1.3 更新）**：本节全部实验**不能用于归因产品真因**，且其"成功/失败"差异**已由 §2.3.3 完全解释**——根因是**源 env 的键名大小写**（见 §1.1），与父进程/句柄/Job/mitigation **均无关**：

- 本节实验的 Python 侧 `CreateProcessW` 之所以多数失败，是 `PROC_THREAD_ATTRIBUTE_PARENT_PROCESS` 会继承**指定父进程**的 mitigation（`ExtPointDisable`），属**实验方法的副作用**；
- 而产品 `run_shell` 的失败与这些完全无关——它只需一个空 `SystemRoot` 就必然失败（§2.3.3 X1）。
- 「调用者 / 父进程身份」假设**已排除**（§2.5）。

**教训（写入文档以免重犯）**：**所有从 bash / Python 继承环境的探针都带大写 `SYSTEMROOT`，因此天然免疫该 bug、永远复现不出来。** 排查环境类缺陷时，必须**显式构造目标场景的 env**（本例：Explorer 式，仅混合大小写键），不能沿用宿主 shell 继承来的 env。

### 2.3.3 根因确证：环境白名单大小写敏感（**决定性实验**）

**单变量实验**（同一进程、同一时刻，仅改 `SystemRoot`/`WINDIR` 相关键；`powershell.exe` 走产品参数模板，并让子进程**自报**读到的值）：

| 实验 | 环境（相关键） | 结果 |
|---|---|---|
| E1 | 继承完整 env（含 `SYSTEMROOT=C:\WINDOWS`） | ✅ `rc=0`，自报 `SR=[C:\WINDOWS]` |
| E2 | 清空**全部大小写变体**后 `SystemRoot=''` | ❌ `0xFFFF0000` + `8009001d` |
| E3 | 清空全部变体后 `SystemRoot='C:\WINDOWS'` | ✅ `rc=0`，自报 `SR=[C:\WINDOWS]` |
| E4 | 清空全部变体（**完全无** `SystemRoot` 键） | ❌ `0xFFFF0000` + `8009001d` |
| E5 | 删全部 `SystemRoot` 变体、**保留** `WINDIR=C:\WINDOWS` | ❌ `0xFFFF0000` + `8009001d` |

**三条硬结论**（均由上表支持）：

1. **缺 `SystemRoot` 键 → 失败**（E4）——Windows **不会**为子进程自动填充该键；
2. **`SystemRoot` 为空串 → 失败**（E2）——与缺键同样致命；
3. **`WINDIR` 不能替代 `SystemRoot`**（E5）——即使 `WINDIR` 有正确值，只要 `SystemRoot` 缺失/为空就失败。

E2 与 E3 唯一差异即 `SystemRoot` 的值 ⇒ **因果成立**；stderr 与产品失败逐字一致。

> **实验设计要点（易错）**：必须**先清掉所有大小写变体**再设值。
> - 若进程里仍留着**大写** `SYSTEMROOT=C:\WINDOWS`（bash/终端启动即如此），Windows 大小写不敏感查找会命中它——此时即使再设一个小写 `SystemRoot=''`，子进程实际仍读到 `C:\WINDOWS` 而**正常启动**（PowerShell 自报 `SR=[C:\WINDOWS]` 可证）。这正是此前多轮排查"测不出来"的原因。
> - 反之，若用 **Python** 的 `os.environ` 去"看"这种情况，它会枚举出被覆盖后的 `SYSTEMROOT=''`，**与 Windows 实际取值不一致**——不能据此判定子进程拿到的值。**验证必须让目标进程自报，而不是让中间进程转述。**

**套用产品管线复刻**（源 env 为 Explorer 式：**只有混合大小写键**，无大写变体）：

```
白名单存活 9 键: APPDATA, LOCALAPPDATA, PATHEXT, Path, ProgramFiles,
                 ProgramFiles(x86), TEMP, TMP, USERPROFILE
被剔除: ['ComSpec', 'SystemRoot', 'windir']
buildShellEnv 回填后: SystemRoot=''   ComSpec='cmd.exe'
子进程 env 中 systemroot 类键: ['SystemRoot'] -> ['']     ← 唯一且为空
```

| 实验 | 内容 | 结果 |
|---|---|---|
| X1 | 产品管线原样 | ❌ `0xFFFF0000` + stderr「…返回错误 8009001d。」**与产品失败逐字一致** |
| X2 | 白名单改大小写不敏感 | ✅ `rc=0` |
| X3 | 仅补回 `SystemRoot='C:\WINDOWS'`（其余不动） | ✅ `rc=0` |

**存活键集合（9 键）与评审 `docs/review/20260920-l0-root-cause-environment-whitelist-case-sensitivity.md` 报告完全一致。**

> 说明：本机复算的 `fingerprint` 未命中失败现场的 `ba1ccff7c42a…`，因构造的 `Path` 等值与真实 Explorer 环境不同（评审用注册表重建了真实值）。**不影响机制结论**——存活键集合一致即证明剔除行为正确。

**因果链闭合**：

```
Explorer 下发混合大小写 SystemRoot
  → environmentResolver 白名单（大写）大小写敏感匹配失败 → 剔除
  → buildShellEnv 回填 SystemRoot = '' （且无其他变体）
  → powershell.exe 托管宿主初始化失败 0x8009001D
  → exit = 0xFFFF0000 / WINDOWS_HOST_INIT_FAILED
```

**为什么开发模式从未暴露**：Git Bash / MSYS 的 env 键是**大写** `SYSTEMROOT`，恰好命中白名单大写键而存活，救活了 PowerShell（§1.1 表）。

### 2.4 假设检验矩阵（逐条实测）

| # | 假设 | 检验方式 | 结论 |
|---|---|---|---|
| H1 | `buildShellEnv` 双写 `Path`/`PATH` 导致 PowerShell Env Provider 崩溃 | 源码确认**确实双写**（`electron/processOutputEncoding.ts`：win32 分支同时 `env.Path = …` 与 `env.PATH = …`）；但用 `GetEnvironmentStringsW` 直读子进程**原始环境块**：**58 条、大小写重复组数 0**（libuv 构造环境块时按大小写不敏感去重）；且最小干净环境也能启动 | **否证**（双写是代码异味，但到不了子进程） |
| H2 | 工具用 `DISABLE_MAX_PRIVILEGE`/`LUA_TOKEN` 构造受限令牌 | 全仓 grep：`CreateRestrictedToken`/`DISABLE_MAX_PRIVILEGE`/`LUA_TOKEN`/`WRITE_RESTRICTED`/`SaferToken`/`FilteredToken`/`TokenPrivileges` **0 命中**；spawn 无 token 参数 | **无此代码** |
| H3 | 启用特权集被削到只剩 `SeChangeNotifyPrivilege` → CSP 初始化失败 | 当前令牌实测 `TokenPrivileges` 5 条、启用者仅 `SeChangeNotifyPrivilege`（`TokenElevationType=3 Limited`、`TokenRestrictedSids=0`，成因是 UAC LUA 过滤令牌）；用 `runas /trustlevel:0x20000`（Safer Basic User，**特权仅 1 条**，比现状更受限）实测：**PowerShell 启动 + CAPI + CNG 全部成功** | **否证** |
| H4 | CNG 可用但旧 CryptoAPI（CSP）被阻 | 进程内已加载 `rsaenh.dll` / `CRYPTSP.dll` / `CRYPT32.dll` / `bcrypt.dll`，CLR = `4.0.30319.42000`；CAPI 专项全通：`RSACryptoServiceProvider`（ProviderType 1 / 24）、`UseMachineKeyStore`（真建容器）、`SHA1/SHA256/MD5 CryptoServiceProvider`、DPAPI、`certutil -csp <旧 provider> -key` rc=0、`MachineKeys` 目录可读写（owner `NT AUTHORITY\SYSTEM`） | **否证** |
| H5 | 加密栈整体不可用 | `SslStream`/Schannel **TLS 1.3 握手成功**（`Tls13 / Aes256 / Sha384`）；`X509Store` 可读（LM Root 287 张）；`Get-AuthenticodeSignature` = Valid；`RSA::Create(2048)` OK；冷启动 40/40 | **否证** |
| H6 | 启动组合本身有问题（参数/隐藏窗口/cwd） | 7 种组合实测全 rc=0：绝对路径、裸名、最小干净 env、**产品原样 `-EncodedCommand`**、`CREATE_NO_WINDOW`、`CREATE_NO_WINDOW + 产品参数`、`Popen stdio=pipe + CREATE_NO_WINDOW + cwd=workDir`（复刻 Node spawn 的**参数**形态） | **否证（参数维度）**，但**有局限**：该组实验全部经 `run_script` → python 执行，**未覆盖「调用者是 Electron 主进程」这一维度**；见 §2.3.2 |
| H7 | 系统策略/Safer 拦截 PowerShell | `Policies\Microsoft\Windows\PowerShell` **不存在**；`ExecutionPolicy=Unrestricted`；`Safer\CodeIdentifiers.authenticodeenabled=0`；`CryptSvc Start=2`（自动） | 环境干净 |
| H8 | EDR / 杀软拦截 | Defender 进程在运行（`MsMpEng.exe`）；09-20 Defender 日志仅信息级（id 1150/1151/2010/5007，**无任何拦截记录**）；CodeIntegrity 09-20 只有 Chrome 与 `WaaSMedicAgent` 的 id=3033，**无 powershell 相关条目**；`AppInit_DLLs` 因权限拒绝无法读取 | **无痕迹支持，但 Defender 不记录"放行"，不能排除** |

### 2.5 结论：根因已定位，候选全部收敛

**已确证（唯一根因）**：`environmentResolver` 白名单大小写敏感剔除 `SystemRoot`（§1.1、§2.3.3，D0）。

**已排除（含此前列为"开放假设"的项）**：

| 曾列为候选 | 状态 |
|---|---|
| 调用者 / 父进程维度 | **已排除**——根因在 env 键名大小写；§2.3.2 实验的差异是 `PARENT_PROCESS` 自身副作用 |
| 受限令牌 / 特权集（H2/H3） | 已否证 |
| CAPI / CNG / 加密栈（H4/H5） | 已否证 |
| PATH 双写（H1） | 见下 |
| `Microsoft Pluton Cryptographic Provider`「尚未实现」 | **与本故障无关**（其存在恒定，且 `SystemRoot=''` 已足以解释失败），仅作环境观察项保留 |

**关于 H1 的特别说明**：H1 排查的是 `buildShellEnv` 的 `Path`/`PATH` 双写，结论"否证"。但它**方向对了一半**——真凶同为「Windows 环境变量键名大小写」问题，只是落在**上游的 `environmentResolver` 白名单**，而非下游的 `buildShellEnv` 双写。这条记录保留，供后续处理同类问题时参考：**遇到 Windows 环境相关问题，优先怀疑键名大小写，并检查白名单/allowlist 的匹配是否做了归一化。**

Provider 枚举实测发现本机唯一实际观察到的 provider 级异常：

```
$ certutil -csplist
提供程序名称: Microsoft Pluton Cryptographic Provider
Microsoft Pluton Cryptographic Provider: 尚未实现
CertUtil: -csplist 失败: 0x80004001 (-2147467263 E_NOTIMPL)
```

即存在一个**已注册但"尚未实现"的 provider**。`NTE_PROVIDER_DLL_FAIL` 的语义正是「provider 找到了但初始化失败」，形态与之吻合。

**但不构成结论**：Pluton 的存在是恒定的，无法解释"为何只在某些时刻发生"。仅作为后续现场取证的重点观察项。

### 2.6 代码确证的产品缺陷清单

| # | 缺陷 | 落点 | 证据 |
|---|---|---|---|
| **D0** | **环境白名单大小写敏感 → 剔除 `SystemRoot`/`ComSpec` → 子进程 `SystemRoot=''`** | `electron/shell/environmentResolver.ts:3-6,24`；`electron/processOutputEncoding.ts:23,26` | **根因**：§2.3.3 单变量复现（X1 失败 / X2、X3 修复），失败现场 11/11 |
| D1 | 无宿主级降级链 | `electron/shell/shellProfiles.ts`；`docs/develop/bash-run-shell-current-state-and-optimization-review.md:730` | 只有单一 profile；文档明示不回退 |
| D2 | `hresult` / `exitCodeAdvice` 被日志 allowlist 丢弃 | `electron/shell/shellLogFields.ts`（`ALLOWED_KEYS`） | 全量日志 grep `8009001d` 0 命中；只能在 `events.jsonl` 找到 |
| D3 | 错误建议教模型改用 `run_script` | `electron/shell/shellExitCodes.ts`（`0xffff0000.advice[0]`、`describeHresult().advice[1]`） | 原文可查 |
| D4 | `agent-deny` 被错标为 `user_rejected` | `electron/toolChatLoop.ts:2370-2375` | 三分支硬编码；`notExecutedReason` 联合类型**无 `agent_denied`** |
| ~~D5~~ | ~~审批拒绝理由未回传调用方~~ **（已撤销，见 §5.6(a)）** | — | v1.0 判断有误：`toolChatLoop.ts:2360-2368` **已有**理由回传；seq 56072 的结果**含完整拒绝理由**。`Tool result missing due to internal error` 是 `toolResultPairing.ts:4` 的**配对层**合成占位符，属另一条链路，且本会话中从未作为结果出现 |
| D6 | `factsSummary` 渲染失真 | `electron/confirmation/extractors/commandSequenceExtractor.ts` | 子命令 signature 用 `' && '` 硬拼：`A; B \| Out-Null; C; whoami` → `A && B && Out-Null && CSP-OK && whoami`（管道段被拆成独立命令） |
| D7 | 审批线索包只取第一个子命令 | `electron/confirmation/agentChannel.ts`（`deriveClueExtras`，`s.commands[0]`） | 真正触发 high 的 `whoami` 未进 `[命令]` 字段 |
| D8 | 注入 3 个不存在的 nodejs 目录到 PATH 最前 | `electron/shell/toolchainResolver.ts` | 实测 `%ProgramFiles%\nodejs`、`%ProgramFiles(x86)%\nodejs`、`%LOCALAPPDATA%\Programs\nodejs` 均 `exists=False`（仅 `%APPDATA%\npm` 存在）；无条件 push、无存在性检查 |
| D9 | 无人档位下 high 风险结构性必拒 | `src/shared/confirmation/approvalVerdict.ts`；`electron/confirmation/approvalAgent.ts`（`APPROVAL_MAX_AUTHORIZATION='low'`）；`electron/skills/bundled/securityApprovalSkill.ts` | `cap='low'` < 矩阵要求 `medium` |

### 2.7 一处必须记录的假象（避免误判）

排查中曾观察到 `USERPROFILE='~'`、`APPDATA='~\AppData\Roaming'`、PATH 含 `~` 条目，一度被当作环境缺陷。经 ord 码核验：

```
USERPROFILE codes = [67,58,92,85,115,101,114,115,92,83,112,97,99,101]  →  "C:\Users\Space"
PATH 中含 '~' 的条目数 = 0
```

**`~` 是产品输出脱敏的缩写显示，不是真实值。** 记录此点有两个用途：(a) 避免后续排查重犯同一误判；(b) 提示一个真实约束——**模型看到的 `run_shell` 输出是脱敏过的**，据此判断宿主机环境会判错。

## 3. 根因分层

| 层 | 问题 | 状态 |
|---|---|---|
| L0 宿主层 | **已确证**：环境白名单大小写敏感剔除 `SystemRoot` → 子进程 `SystemRoot=''` → PowerShell 托管宿主初始化失败（`0x8009001D`） | **根因（D0）**，修复见 §5.0；修复后 L0 消失 |
| L1 通道层 | Windows 只有单一 profile、无探测无回退 ⇒ 单点失效即整体报废 | 确证（D1） |
| L2 诊断层 | 关键字段（`hresult`/`exitCodeAdvice`）进不了日志 ⇒ 故障隐形 | 确证（D2） |
| L3 指引层 | 错误建议引导模型改用脚本 ⇒ 引发工具选择漂移 | 确证（D3） |
| L4 归因层 | `agent-deny` 被标为 `user_rejected`（导致统计 / UI 误判为"用户拒绝"） | 确证（D4）。~~理由不回传~~ **已撤销**：理由本身**已回传**调用方，见 §2.6 与 §5.6(a) |
| L5 审批层 | 无人档位下 high 风险数学必拒 ⇒ `run_shell` 结构性不可用 | 确证（D9） |

**贯穿 L1→L5 的元问题**：**单次失败缺少可用诊断与恢复路径，模型只能换工具。** 这与 `edit_file` 案（`docs/develop/edit-file-match-failure-diagnosis-and-improvement-plan.md`）同源，但落点不同——**那里缺的是「编辑层的可诊断性」，这里缺的是「执行层的回退与归因」**。两份方案应独立推进，不要合并。

## 4. 影响

1. **能力丧失（自迁移起，根因已确证）**：**自迁移到 PowerShell profile 起，产品路径上的 `run_shell` 从未成功过一次（11/11 失败）**，跨 09-11 ~ 09-20（9 天、6 个会话）。**根因是产品自身缺陷**（环境白名单大小写敏感，D0），**修复后应恢复可用**。Agent 在此期间转向 `run_script` + Python `subprocess`（`d05fe8a7` 中 `run_script` 12 次 vs `run_shell` 1 次）。
2. **诊断失明**：因 D2，线上日志**查不到 `8009001d` 本身**。这不是理论问题——本次排查正是因此只能回到会话事件流取证，终端用户与后续排查者都拿不到证据。
3. **工具选择漂移**：D3 的错误建议 + D9 的审批必拒，共同把 Agent 训练成「能用 Python 就别用 shell」。同时 `run_script` 以子进程直接改文件/执行，**绕过 `edit_file` 的写保护四道护栏**（详见 edit_file 案 §2.7）。
4. **归因误导**：审批层「high 必拒」对用户表现为「工具莫名其妙不可用」；D4 又把 `agent-deny` 在统计 / UI 层标成「用户拒绝」，容易误判为 bug 而非策略。（~~D5~~ 已撤销：理由本身**已回传**，见 §2.6 缺陷表与 §5.6(a)。）

## 5. 改进方案

### 5.0 P0-0（最高优先）：根因修复 —— 环境白名单大小写敏感

**问题**（D0）：见 §1.1 与 §2.3.3。`environmentResolver` 的白名单大小写敏感，剔除了 Windows 真实键名 `SystemRoot`/`ComSpec`，导致子进程 `SystemRoot=''`，PowerShell 托管宿主初始化失败。

**修复（两处，均可独立生效，建议同时做——纵深防御）**：

**(a) `electron/shell/environmentResolver.ts`（根治）**

白名单匹配改为**大小写不敏感**（**仅 win32**）：

```ts
// POSIX 环境变量名大小写敏感（PATH 与 path 是不同的键），
// 无条件归一化会在 macOS/Linux 上改变白名单语义（意外放行 path/home 等小写变体）。
const normalize = process.platform === 'win32' ? (k: string) => k.toUpperCase() : (k: string) => k
const allowed = new Set([...BASE_KEYS, ...explicitKeys].map(normalize))
// ...
if (!allowed.has(normalize(key)) || SECRET_NAME.test(key)) { removedKeys.push(key); continue }
```

或等价做法：在 `BASE_KEYS` 中补入真实大小写键 `'SystemRoot'` / `'ComSpec'`。**推荐前者**——Windows 环境变量键名大小写不固定（不同启动源各异），逐键列举无法穷尽。

> **必须限定 win32**：POSIX 下 `path`/`home` 等小写键与白名单中的 `PATH`/`HOME` 是**不同变量**，若一并放行会改变 allowlist 语义（属安全面变化）。因此归一化只在 win32 生效，且需补一条 **POSIX 行为不变**的回归测试。

> 注意：`fingerprint` 的语义会随存活键集合变化（存活键变多），属**预期变化**；若有测试断言依赖旧指纹，需同步更新。

**(b) `electron/processOutputEncoding.ts:23,26`（纵深防御）**

现状 `env.SystemRoot = base.SystemRoot ?? ''` 会在上游过滤掉 `SystemRoot` 时**主动写入空串**。改为**仅在取到有效值时写入**，并按优先级兜底到进程环境：

```ts
// 取到有效值才写；避免"主动注入空值"（空值同样导致宿主初始化失败，见 §2.3.3）
const systemRoot = base.SystemRoot || process.env.SystemRoot
if (systemRoot) env.SystemRoot = systemRoot
const comSpec = base.ComSpec || process.env.ComSpec
env.ComSpec = comSpec || 'cmd.exe'
```

**必须澄清其性质**：本项是**纵深防御，不是修复**。§2.3.3 已实测——**缺键（E4）与空串（E2）同样失败**，所以"不写空串"并不能让 `run_shell` 恢复；真正的修复是 (a)。本项的价值在于：

1. 不再主动制造"看起来有值、实为空串"的假象，便于问题暴露与定位；
2. 当上游过滤**恰好只删掉其中一个变体**时，仍能从 `process.env` 拿回有效值（等效于把 (a) 的兜底做在下一层）。

> 注意：`?? ''` 的风险不只 `SystemRoot`——`USERPROFILE` / `LOCALAPPDATA` 同样用 `?? ''` 注入空串，建议一并按"有效值才写"处理。

**验收标准**：

1. **单元测试**：以混合大小写 `'SystemRoot'`/`'ComSpec'` 的源 env 走 `resolveShellEnvironment`，断言二者**存活**且值正确；
2. **单元测试（win32）**：源 env 仅含混合大小写 `'SystemRoot'`（且无其他变体）时，输出环境中的 `SystemRoot` **非空**；
3. **单元测试（POSIX 回归）**：非 win32 下，源 env 含小写 `'path'` 时断言其**不被**放行（白名单语义不变）；
4. **单元测试（不得注入空值）**：源 env 完全无 `SystemRoot` 时，输出环境**不包含**值为空串的 `SystemRoot` 键（`buildShellEnv` 侧）；
5. **集成验收（关键）**：**Explorer 启动打包版**后 `run_shell` 成功（本机对照见表 X1/X2，见 §2.3.3）；
6. **回归**：确认既有依赖 `removedKeys` / `fingerprint` 的断言同步更新后仍通过。

### 5.1 P0-A：修正 `exitCodeAdvice`（不再教模型换工具）

**问题**（D3）：`0xFFFF0000` 的 `advice[0]` 是「改用 run_script（Python subprocess）执行同一命令」。这是**产品自己给出的**工具切换指令，是「Agent 到处写 Python」的直接源头之一。

**改法**：`electron/shell/shellExitCodes.ts`

```
0xffff0000.advice:
  - "shell 宿主不可用，属宿主机环境问题，请勿改写命令或改用其他执行工具"
  - "稍后重试一次；若持续失败，按诊断字段上报（含 hresult 原文）"
  - "读取本次执行的原始字节 artifact，确认宿主自身写出的原始报错"

describeHresult('0x8009001D').advice:
  - "疑似宿主机安全/加密组件拦截；宿主级降级链会自动尝试其他 shell 宿主，无需改写命令"
  - "不要改用 run_script 包装同一命令——那会绕过 shell 策略与方言预检"

0xc0000142.advice（评审 R1 补充：v1.0 漏列，同为宿主初始化类错误，须一并清理）:
  - "宿主依赖 DLL 初始化失败，属宿主机环境问题，请勿改写命令或改用其他执行工具"
  - "宿主级降级链会尝试其他 shell 宿主；若持续失败，按诊断字段上报"
```

**要点**：建议必须**禁止**引导换工具，改为「重试 + 上报」；若已实现降级链（P0-C），应说明降级会自动发生。

### 5.2 P0-B：日志 allowlist 补 `hresult` / `exitCodeAdvice`

**问题**（D2）：`electron/shell/shellLogFields.ts` 的 `ALLOWED_KEYS` 缺这两个字段，导致故障隐形。

**改法**：将 `hresult`（结构化的 `{code,name,meaning}`）加入 `ALLOWED_KEYS`；`exitCodeAdvice` 加入 `ALLOWED_KEYS`（注意它是字符串数组，须确认 `projectShellAgentLogFields` 对数组的处理，必要时按既有 `violationCodes` 的先例处理）。

**同批需补**（详见 §5.4.3）：`degradedFrom`（P0-C）与 §5.4.3 组 2/组 4/组 5 的新字段一并加入 `ALLOWED_KEYS`；并同步 `electron/agentLogger/agentLogProjection.ts`（其事件表现在只列 shell 系，需加 `script.exec.*`）。

**验收断言**：一次 `WINDOWS_HOST_INIT_FAILED` 的 `shell.exec.finish` 日志中，**必须能 grep 到 `8009001d`**（或等价的 `hresult.code` 字段）。

### 5.3 P0-C：宿主级降级链（`pwsh → cmd`）

**问题**（D1）：单点失效即整体报废。

**设计**：

```
宿主选择顺序（Windows）：
  1. 已配置的 profile（若用户显式配置，尊重之，但失败后仍可降级）
  2. powershell.exe（内置 profile）
  3. pwsh.exe（若存在）—— 托管宿主实现不同，可能不受同一阻断影响
  4. cmd.exe

降级触发条件（仅这些，不做通用重试）：
  - spawn 成功但 exitCode === 0xFFFF0000（WINDOWS_HOST_INIT_FAILED）
  - exitCode === 0xC0000142（STATUS_DLL_INIT_FAILED）
  不包含：普通非零退出、超时、输出超限、方言错配（各有既有处理路径）
```

**三个必须遵守的约束**：

1. **降级后必须重跑方言预检**。`detectShellDialectMismatch(command, profile)` 的判定依赖目标 profile：把原本面向 PowerShell 的命令直接交给 `cmd.exe` 会连环报方言错配。降级前需重新计算 mismatch；若新 profile 不兼容该命令，应返回明确的**「宿主降级但命令方言不兼容」**结构化错误，而不是硬跑。
2. **参数模板必须重新生成**。`cmd` 用 `/d /s /c`，且**不能**沿用 `-EncodedCommand`（`shellExecPlan.buildSpawnArgs` 目前按 `shellId` 分支，需扩展）。
3. **结果必须显式标注实际宿主**。`data.shell` 与 `data.degradedFrom`（如 `degradedFrom: 'builtin-windows-powershell'`）须回传，且进入 UI/日志/历史（`projectShellAgentLogFields` 需放行 `degradedFrom`）。用户必须知道命令实际由谁执行——这既是透明度要求，也是安全要求（方言不同，语义可能不同）。

**注意**：`cmd` 的能力弱于 PowerShell（无 cmdlet、无 `$LASTEXITCODE` 语义、管道语义不同）。降级是**保底可用**，不是等价替代，因此标注不可省略。

### 5.4 P0-D：观测与取证能力（**根因已定后的定位调整**）

> **v1.3 定位调整**：根因已确证（D0，§2.3.3），本节**不再是"给真因定性的首选手段"**。三项的处置：
> - **5.4.1 主动最小复现** —— **已执行完毕**（即 §2.3.3 的实验）。保留作为**回归验收手段**（修复后重跑同一实验，应全部 `rc=0`）。
> - **5.4.2 失败现场诊断包** —— 降级为**可选**；但其中「模块清单 / provider 枚举」仍有独立价值（覆盖**未来其他**宿主初始化类故障）。
> - **5.4.3 常态埋点** —— 降级为**可选**；但**组 1（为 `run_script` 补执行期事件）建议保留**——该缺口独立于本案（"成功的路径没有执行期证据"本身就是可观测性缺陷）。

> **修订说明（v1.1，评审 R1）**：v1.0 把本项定位为「等下一次故障现场」的**被动**取证。但 §2.3 已确证故障是 **11/11 的确定性失败、可稳定复现**，因此定位改为**主动**取证，优先级提升到与 P0-A/B/C 同级。

**5.4.1 主动最小复现（已于 v1.3 执行完毕）**

> 本小节的方法已在 §2.3.3 实际执行并得出根因。**保留全文作为回归验收步骤**：P0-0 修复后重跑同一组实验，应全部 `rc=0`。

1. **直接重跑产品 `run_shell`**（低风险命令，避开 `agent-deny`）——本版已做，结果：仍失败（§2.3.1）。后续每次改动后应重跑同一命令，作为「是否改善」的基线。
2. **在 Electron 主进程内逐变量隔离**（需 dev-only 通道或临时调试开关），每次只改一个变量：
   - executable 用**绝对路径**（排除 libuv 的 PATH 搜索差异）；
   - `-Command` 替代 `-EncodedCommand`；
   - 去掉 prelude / 换 `cwd` / 去掉 `windowsHide`；
   - `execFile` 替代 `spawn`；
   - 对比 `process.env` 直传 vs `buildShellEnv` 过滤后环境。
3. **抓取失败子进程的死亡现场**：每次失败存活 2.6–5.1 秒，足以在 spawn 后立刻用进程快照抓取该 PID 的**模块清单**与命令行——即把 5.4.2 的 a/b/e 项**即时**落地，不必等字段回流。

> **不要用 `PROC_THREAD_ATTRIBUTE_PARENT_PROCESS` 从外部模拟产品调用者**：§2.3.2 已证明该手法会引入自身副作用（`0xC0000142`），产出的是实验方法的产物而非产品真因。

**5.4.2 失败现场诊断包（补充手段）**

**动机**：系统侧 `CAPI2/Operational` 未启用、`Crypto-NCrypt` 无对应事件、Defender/CodeIntegrity 无拦截留痕，事后翻日志挖不出更多；与 5.4.1 的现场抓取配合使用更有效。

**设计**：当 `exitCode === 0xFFFF0000` 时，除既有 artifact 外，额外抓取一个**诊断包**（有界、脱敏）：

| 项 | 内容 | 说明 |
|---|---|---|
| a | 子进程已加载模块清单（或至少筛选 `rsaenh\|cryptsp\|ncrypt\|bcrypt\|crypt32\|clrjit\|mscor*`） | 判断是"provider DLL 没加载"还是"加载了但初始化失败" |
| b | Provider 枚举结果（`-csplist` 等价） | 重点看是否存在"已注册但不可用"的 provider（如 Pluton） |
| c | 最近 `Crypto-NCrypt/Operational`、`CodeIntegrity/Operational`、`Windows Defender/Operational` 事件（窗口：故障 ±5 分钟） | 捕捉外部瞬时干扰痕迹 |
| d | `hresult` 原文（原始字节，未经解码替换） | 目前被 D2 丢弃；结合 P0-B 一并解决 |
| e | 当前进程令牌快照（`TokenElevationType` / `TokenRestrictedSids` / 启用特权列表） | 一次性排除/确认令牌侧假设（H2/H3） |

**约束**：诊断包必须**有界**（总量上限，参考既有 `ioMaxBytes` 口径）、**脱敏**（遵守 Agent 出口策略，主目录折叠 + 秘密脱敏）、**失败不影响主流程**（采集异常不得让 `run_shell` 的原有失败语义改变）。新增字段须加入日志 allowlist 与结果投影白名单。

该项与方法 5.4.1 配合，构成「主动复现 + 现场诊断包」的组合；根因已定后作为**可选**能力保留（覆盖未来其他宿主初始化类故障）。

**5.4.3 常态埋点与双路径对照（新增）**

**动机**：§5.4.1 的变量隔离需人工介入，且是一次性的；本项把它**常态化**——让每一次成功/失败的执行都留下可比对的证据，无需复现即可持续收敛。同时它正面回应 §2.3.2 的教训：**不要从外部模拟，要在真实路径上观测。**

**先做一次静态比对（零成本，已完成）**：两条路径的 `spawn` 选项**实质等价**——

| 项 | `run_shell`（失败） | `run_script`（成功） |
|---|---|---|
| 落点 | `runShellExecutor.ts:294-300` | `builtinExecutors.ts:1225-1230` |
| 可执行 | `powershell.exe` | `python.exe`（`-c code`） |
| `cwd` | `prepared.cwd` | `ctx.workDir` |
| `env` | `buildShellEnv()` | `buildPythonScriptEnv()`（= 前者 + `PYTHONUTF8` / `PYTHONIOENCODING`） |
| `windowsHide` | `true` | `true` |
| `shell` | `false` | `false` |
| `detached` | `false`（Windows 恒 false） | 未指定（默认 `false`） |
| `stdio` | 未指定（默认 pipe）+ 监听 stdout/stderr | 同 |

⇒ **选项等价，唯一硬差异是可执行文件本身**——**但此结论已被 v1.3 修正：两路径的 `env` 并非同一基底**。见下方更正。

> **v1.4 更正（原 v1.2 残留结论，评审指出）**：上表把 `run_shell` 与 `run_script` 的 `env` 都记为"同一基底"，**这是错的**：
> - `run_shell` 用的是 **`buildShellEnv(resolveShellEnvironment(process.env).env)`** —— 先经白名单过滤（`runShellPlan.ts:113`），再回填；
> - `run_script` 用的是 **`buildPythonScriptEnv(process.env)`**（`builtinExecutors.ts:1218`）—— **不经过白名单**。
>
> 因此 `env` 的差异**正是根因本身**（白名单大小写敏感剔除了 `SystemRoot`，见 §1.1 / §2.3.3），且**静态分析本来就能看出**——v1.2 当时说"看代码已到尽头"是误判。教训：**对比两条路径时，要逐层对比函数调用链，不能只看最内层 `spawn` 的选项表。**

**缺口（必须先补）**：`run_script` **完全没有执行期埋点**。`AgentLogEventName` 中 `script.*` 只有 4 个，全部属策略/确认阶段：

```
script.ask / script.allow.execute / script.auto_allow.execute / script.deny
```

日志实证吻合：`Agent-20260920.log` 中 `script.*` 只有 `script.ask`（`patterns:["A-fail"]`）；而 `shell.*` 有 `precheck / confirm / exec.start / exec.spawned / exec.finish` 完整链。`run_script` 的执行期只走 `ctx.sendProgress('script', ...)`（`builtinExecutors.ts:1235`）——**IPC 进度，不落盘**。

> **后果：当前"成功的那条路径"没有任何可事后分析的执行期证据，双路径对照的前提不存在。** 这是本项的第一优先级。

**埋点分组（按判别力 / 成本排序）**：

| 组 | 采集内容 | 判别力 | 成本 |
|---|---|---|---|
| **1（前提）** | 为 `run_script` 补执行期事件：`script.exec.start` / `script.exec.spawned`（含 pid、解析后可执行绝对路径）/ `script.exec.finish`（含 exitCode、durationMs），与 `shell.*` 字段对齐 | — | 低 |
| **2** | **进程创建上下文**（两条路径**同一位置**各记一份、字段对齐）：父进程 pid + exe 绝对路径；子进程 pid + **解析后的可执行绝对路径**（`spawn` 走 PATH 搜索，实测 PATH 中有 4 个大小写各异的 `powershell` 条目，必须记实际命中的那个）；`IsProcessInJob` + Job 名；mitigation 全量（`ExtPointDisable` / `DEP` / `CFG` 等）；token（`ElevationType` / `RestrictedSids` / `IntegrityLevel` / 启用特权）；spawn 选项（脱敏）；**inherited handles 计数** | **最高**（一次性判定两路径是否等价；其中 handles 是当前最可疑维度——Electron 主进程持有大量 IPC/GPU/证书句柄，python 中间层句柄集更小） | 中 |
| **3** | `hresult` / `exitCodeAdvice` 进 allowlist | 低（属 P0-B） | 零 |
| **4** | **宿主死亡现场：模块加载时序**——失败路径上 spawn 后按 ~200ms 轮询抓该 PID 已加载模块名快照，退出瞬间再抓一次 | 高（区分「provider DLL **没加载**」vs「加载了但**初始化失败**」，把 `0x8009001D` 细化到具体阶段） | 中 |
| **5** | **env 完整快照 + 双路径 diff**：完整 env 的**键集合 + 脱敏后逐键哈希**，两路径各一份自动 diff | 中（把"与用户环境漂移无关"升级为"两路径 env 是否逐键等价"） | 低 |
| **6** | **失败后同位置对照自检**：`run_shell` 失败时在同一 spawn 点起探针（如 `cmd /c echo probe`），记录成败 | 最高（等于把 §5.4.1 变量隔离常态化，无需人工二分「exe 相关 vs 位置相关」） | 中 + **需产品决策** |

**约束（必须遵守）**：

1. **采集器不得使用 PowerShell**——它是失败的那一方，会构成循环依赖。可用 `cmd`、`tasklist`（已实测可用）、或 Node FFI。
2. **采集失败不得影响主流程**——沿用 §5.4.2 约束：有界、脱敏、失败静默。
3. **新字段须同时进入两处白名单**：`electron/shell/shellLogFields.ts` 的 `ALLOWED_KEYS` 与 `electron/agentLogger/agentLogProjection.ts` 的事件/字段表（后者当前只列 shell 系事件，需扩 `script.exec.*`）。
4. **组 2 / 组 5 的采集代码与 §5.4.2 诊断包共用**，不得做成两套实现。

**能力边界（必须写清）**：埋点只能给出**候选维度与等价性判定**，**不能给出因果**。因果仍需「改一个变量、看结果变化」。但本案是 **11/11 稳定复现**，因此：
- 若组 2 发现差异 → 一次受控验证即可定论；
- 若判定等价 → **干净地排除**「父进程 / 句柄 / Job / mitigation」这一整类，把方向收敛到可执行文件的初始化需求（CLR + crypto，而 python 不需要 .NET Framework）——**这本身也是显著进展**。

### 5.5 P1-D：`notExecutedReason` 增加 `agent_denied`
**问题**（D4）：`agent-deny` 被硬编码归入 `'user_rejected'`，导致 token 统计、UI 文案、错误归因全部误判为"用户拒绝"。

**改法**：

1. `src/shared/domainTypes.ts` 的 `notExecutedReason` 联合类型增加 `'agent_denied'`（同时需更新 `docs/requirement/agent-token-usage-analytics-requirement.md` 中的枚举说明与 `electron/toolChatLoop.usageStatsInvariant.test.ts` 的 `NOT_EXECUTED_REASONS` 常量）。
2. `electron/toolChatLoop.ts` 的分支改为按 `confirmationDecision` 的 **cause**（`agent-deny` / `recursion-blocked` / `timeout` / `unavailable` / `unparsable` / `config-error`）而非仅 `errorCode` 归类；`agent-deny` → `'agent_denied'`，用户主动拒绝仍 → `'user_rejected'`。
3. 同步 `step_count` / `tool_error_count` 口径文档（避免「agent 拒绝」被计成「用户拒绝」或「执行失败」）。

### 5.6 P1-E：审批归因三处修正

**(a) 拒绝理由回传调用方 —— 已撤销，无须实施**（原 D5）

> **修订说明（v1.1，评审 R2）**：v1.0 判定「理由未回传」，**该判断有误，撤回**：
> - `electron/toolChatLoop.ts:2360-2368` **已存在**理由回传逻辑（注释标注「P1-2 拒绝理由回传：优先通道裁决的 reason.summary」）：`channelRejectSummary`（`:2110`）进入 `rejectedError`，经 `buildToolErrorResult` 写入工具结果。
> - `b680b181` 的 seq 56072 **实际包含完整的 `agent-deny` 拒绝理由原文**，调用方（模型）读到了理由。
> - `Tool result missing due to internal error` 是 `src/shared/toolResultPairing.ts:4` 的**配对层合成占位符**（`SYNTHETIC_TOOL_RESULT_PLACEHOLDER`），属**结果配对链路**，与审批回传无关；本会话中它**从未作为 `tool_result` 内容出现**（只出现在我读取/检索该字符串的记录里）。
>
> 因此本项**不立项**。若后续确实观察到该占位符出现在某次调用的结果里，应转查 pairing 层（当天日志有 `tool.result.pairing.repaired`），而非审批链路。

**(b) `factsSummary` 渲染修正**（D6）

现状：`commandSequenceExtractor` 用 `' && '` 硬拼子命令 signature，且不区分真实连接符——`A; B | Out-Null; C; whoami` 被渲染成 `A && B && Out-Null && CSP-OK && whoami`，**管道段被拆成独立命令**，审批者看到的比实际更可疑。

改法：按真实连接符渲染（`;` / `&&` / `||` / `|` 分别保留），或在摘要中明确标注"以下为子命令清单（连接符已规范化）"，避免制造不存在的命令。

**(c) 审批线索包取全部子命令**（D7）

现状：`agentChannel.deriveClueExtras` 取 `s.commands[0]` 作为 `[命令]` 字段，真正触发 high 风险的后续子命令（`whoami`）只留在摘要里。

改法：`[命令]` 字段覆盖全部子命令（有界，如最多前 N 条 + 总数标注），或改为列出"全部子命令"并保持与 `factsSummary` 一致的口径。

### 5.7 P2-F：无人档位下 high 风险的合法路径（**策略问题，需产品决策**）

**问题**（D9）：`risk=high` + `authorization` 上限 `low` ⇒ 无人档位下必然 deny。

**这不是 bug，而是安全设计的必然结果**，但它带来一个产品问题：**用户明确要求做的高风险操作，在无人档位下没有任何获批路径**。

可选方向（需产品决策，本文不预设结论）：

| 方向 | 说明 | 风险 |
|---|---|---|
| F1 桌面档位启用真人授权证据 | 已有设计：`approvalAgent` 的 `maxAuthorization` 在 **desktop 档位传 `'high'`**（注释原文：「desktop 档位启用真人授权证据（taskDigest）后允许到 'high'，缓解高风险动作误拒」）。确认该路径在目标场景下真的生效 | 需确认 `taskDigest` 的采信边界 |
| F2 高风险 + 有明确任务声明时，降级为「向用户确认」而非机审 | 即 `answerer` 从 `agent` 改回 `user` | 与「无人档位」的初衷冲突，需明确适用条件 |
| F3 保持现状，但把拒绝理由与「如何获批」明确告知用户 | 成本最低 | 不解决"无路径"本身 |

**当前建议**：至少落地 **F3**——拒绝必须可解释、可操作（拒绝理由回传已存在，见 §5.6(a)；此处要补的是**「如何获批」的指引**，而非理由回传本身）；F1/F2 属产品决策，建议单独立项。

### 5.8 P2-G：环境构造的两处清理

**(a) `toolchainResolver` 存在性检查**（D8）

`resolveNodeToolchainPath` 无条件把 3 个 nodejs 目录推到 PATH 最前，不做存在性检查。实测三者均不存在。建议：注入前 `fs.existsSync` 过滤；保留 `sources` 记录以便诊断。**注意**：这与历史上那个 PATH 双写假设无关（H1 已否证其因果），属独立清理。

**(b) `buildShellEnv` 双写清理**

`env.Path` 与 `env.PATH` 同时写入。当前靠 libuv 大小写不敏感去重「保命」，属实现细节依赖，且与 `docs/plan/run-shell-lifecycle-local-execution-todo.md:290-291`（声称"resolver 合并 `PATH`/`Path`/`path`，按出现顺序去重"）口径不符——真正做三键合并的是 `toolchainResolver`，不是 `environmentResolver`。建议：win32 分支只写一份（`Path`），并修正文档口径。

### 5.9 P2-H：需求与文档同步

- `docs/develop/bash-run-shell-current-state-and-optimization-review.md:730` 的「不自动探测或回退」需按 P0-C 更新（否则实现与文档冲突）。
- `docs/plan/run-shell-lifecycle-local-execution-todo.md` 的 PATH 合并口径需修正（5.8(b)）。
- `docs/requirement/` 的 `notExecutedReason` 枚举需补 `agent_denied`（5.5）。
- 新增「宿主降级」的 profile 与参数模板规格（`cmd` 的 `/d /s /c`、方言预检重跑规则）。

## 6. 实施顺序

| 阶段 | 内容 | 依赖 | 风险 |
|---|---|---|---|
| **Phase 0** | **P0-0 根因修复**（§5.0：`environmentResolver` 白名单大小写不敏感（仅 win32） + `processOutputEncoding` 不再注入空值） | 无 | **低**（两处小改，且已有单变量复现可验收） |
| Phase 1 | P0-0 的回归验收（重跑 §2.3.3 实验组 + Explorer 启动打包版端到端） | Phase 0 | 低 |
| Phase 1 | P0-A 修正 `exitCodeAdvice` 措辞 | 无 | 低（纯文案） |
| Phase 1 | P0-B 日志 allowlist 补字段 | 无 | 低 |
| Phase 1 | P0-C 宿主降级链（含方言预检重跑 + 实际宿主标注） | 无 | **中**（改执行路径，须严格边界测试） |
| —（已执行完毕） | ~~P0-D1 主动最小复现~~ **已于 v1.3 执行完毕（见 §2.3.3），现作为 P0-0 的回归验收步骤并入 Phase 1** | — | — |
| Phase 2（可选） | P0-D3 常态埋点组 1：为 `run_script` 补执行期事件（独立缺口，建议保留） | 无 | 低 |
| Phase 2（可选） | P0-D3 组 2（进程创建上下文，双路径对齐） | 组 1 | 中（采集依赖，见 §5.4.3 约束 1） |
| Phase 2（可选） | P0-D2 失败现场诊断包 + 组 4（模块加载时序）+ 组 5（env 完整 diff） | 与 P0-B 同批（共用 allowlist 与投影白名单） | 中（采集有界性与脱敏） |
| Phase 2（可选） | P0-D3 组 6（失败后同位置对照自检） | **需产品决策** | 中 |
| Phase 3 | P1-D `agent_denied` + P1-E 审批归因三处 | 无 | 低-中（涉及统计口径与投影） |
| Phase 4 | P2-G 环境构造两处清理 | 无 | 低 |
| Phase 5 | P2-F 策略决策（F1/F2/F3） | **需产品决策** | 高（安全策略） |
| Phase 6 | P2-H 文档同步 | 随各阶段 | 低 |

建议理由：**根因修复（P0-0）成本最低、收益最大，且已有单变量复现可直接验收，因此置于 Phase 0 最前**；P0-A/B 为纯增量修复，可立即落地；P0-C 是收益最大但风险最高的一项（改执行路径），应配最严格的边界测试；P0-D 系列在根因已定后**降级为可选**（其中 D3 组 1 因属独立可观测性缺口而建议保留）；P2-F 涉及安全策略，必须产品决策，不应由实现者自行决定。

## 7. 测试方案与验收标准

### 7.1 单元测试

| # | 场景 | 断言 |
|---|---|---|
| **0** | **D0 根因：混合大小写源 env 走白名单**（§5.0a） | 源 env 含 `'SystemRoot'` / `'ComSpec'`（**混合大小写**）时，`resolveShellEnvironment` 后二者**存活**、值正确、**不在** `removedKeys` 中 |
| **0b** | **D0：`buildShellEnv` 取到有效值才写**（§5.0b） | 上游提供了有效 `SystemRoot` 时，输出**非空**；上游**未提供**时，输出**不得包含**值为空串的 `SystemRoot` 键（省略键是合法实现，见 §2.3.3 E4 与 §5.0b 的说明） |
| **0b2** | **POSIX 白名单语义不变**（§5.0a） | 非 win32 下，源 env 含小写 `'path'`/`'home'` 时**不被**放行 |
| **0c** | **D0 端到端回归**（P0-0 验收核心） | 以 Explorer 式源 env（**仅混合大小写键**）复刻产品管线后 spawn `powershell.exe` → **`rc=0`**；对照 §2.3.3 的 X1（修复前为 `0xFFFF0000`） |
| 1 | `describeExitCodeDetails(0xFFFF0000)` 的 `advice` | **不含** `run_script` 字样；含「不要改写命令/不要改用其他执行工具」语义 |
| 2 | `describeHresult('...8009001d...')` 的 `advice` | 同上（回归 D3） |
| 2b | `describeExitCodeDetails(0xC0000142)` 的 `advice` | **不含** `run_script` 字样（评审 R1 补充项） |
| 2c | **`run_script` 执行期事件**（§5.4.3 组 1） | 成功执行一次 `run_script` 后，日志中出现 `script.exec.start` / `script.exec.spawned` / `script.exec.finish`，字段与 `shell.exec.*` 对齐（含 pid、可执行绝对路径、exitCode、durationMs） |
| 2d | **双路径字段对齐**（§5.4.3 组 2） | 对同一次 `run_shell` 与 `run_script` 执行，组 2 字段集合一致（同一 schema），可直接 diff |
| 2e | **采集器不依赖 PowerShell**（§5.4.3 约束 1） | 在 PowerShell 不可用的前提下，采集器仍能产出组 2 字段（回归"循环依赖"） |
| 2f | **采集失败不影响主流程**（§5.4.3 约束 2） | 注入采集异常，断言 `run_shell` / `run_script` 的原有成败语义与结果字段不变 |
| 3 | `projectShellAgentLogFields` 处理含 `hresult` / `exitCodeAdvice` 的字段 | 二者**均被保留**（回归 D2）；`exitCodeAdvice` 数组形态正确 |
| 4 | 降级链选择逻辑（纯函数，注入"宿主探测结果"） | 顺序 `powershell.exe → pwsh → cmd`；`pwsh` 不存在时跳过 |
| 5 | 降级触发条件 | 仅 `0xFFFF0000` / `0xC0000142` 触发；普通非零退出、超时、输出超限、`SHELL_DIALECT_MISMATCH` **不触发** |
| 6 | 降级 + 方言不兼容 | 返回结构化「宿主降级但命令方言不兼容」错误，**不硬跑** |
| 7 | 降级后 `cmd` 参数构造 | 使用 `/d /s /c`，**不含** `-EncodedCommand` |
| 8 | `notExecutedReason` 归类 | `cause='agent-deny'` → `'agent_denied'`；用户主动拒绝 → `'user_rejected'`；`recursion-blocked`/`timeout`/`unavailable`/`unparsable` 各有明确映射 |
| 9 | `NOT_EXECUTED_REASONS` 常量 | 含 `'agent_denied'`（与联合类型同步） |
| 10 | `commandSequenceExtractor` 摘要渲染 | `A; B \| C; whoami` 保留真实连接符；**不得**把管道段渲染成 `&&` 拼接的独立命令（回归 D6） |
| 11 | `deriveClueExtras` 线索包 | 多子命令时 `[命令]` 覆盖全部（或前 N + 总数），而非仅 `commands[0]`（回归 D7） |
| 12 | `resolveNodeToolchainPath` | 不存在的 nodejs 目录**不进入** `pathEntries`（回归 D8） |
| 13 | `buildShellEnv`（win32） | 环境块中 PATH 类键**只出现一份**（回归 5.8(b)） |

### 7.2 集成测试

- **P0-0 根因验收（最高优先）**：**Explorer 启动打包版**，`run_shell` 端到端成功（对照修复前的 11/11 失败）；并重跑 §2.3.3 的实验组（X1/X2/X3 应全部 `rc=0`）。
- **降级链路端到端**：注入一个必定返回 `0xFFFF0000` 的伪宿主（或 mock spawn），断言：自动降级到下一宿主、结果标注 `degradedFrom`、且**未**向模型返回 `改用 run_script` 的建议。
- **诊断包产出**：在 `WINDOWS_HOST_INIT_FAILED` 场景下，断言诊断包包含模块清单 / provider 枚举 / 相关事件 / `hresult` 原文 / 令牌快照五类，且**总量有界、主目录已折叠、秘密已脱敏**。
- **日志可查性（D2 反例保护）**：断言该次失败的 `shell.exec.finish` 日志**可 grep 到 `8009001d`**。
- **审批归因端到端**：构造一次 `agent-deny`，断言 `notExecutedReason === 'agent_denied'`、统计口径归入"未执行"而非"执行失败"或"用户拒绝"。（拒绝理由回传**已存在**，作为**回归断言**保留，不属本次改动——见 §5.6(a)。）
- **审批必拒反例保护**：构造 `risk=high` + 无人档位，断言拒绝理由包含「如何获批」的可操作指引（F3 落地标志）。
- **回归**：`occ > 1` 类无关路径不受影响；`run_shell` 的正常成功/普通失败路径逐条回归；`shouldStopToolRetry` 对 `worksWithShell` 的既有行为不变。

### 7.3 验收标准

1. **根因修复生效（最高优先）**：**Explorer 启动打包版**后 `run_shell` 端到端成功（对照修复前的 11/11 失败）；混合大小写 `SystemRoot`/`ComSpec` 能在白名单中存活。
2. **不再引导换工具**：任何 `run_shell` 失败结果的 `advice` / `userMessage` / `hint` 中，**不出现**「改用 `run_script`」类文案。
3. **故障可查**：一次 `WINDOWS_HOST_INIT_FAILED` 后，**无需**回到 `sessions/*/events.jsonl`，仅凭 `.agent/logs` 即可取到 `hresult.code` 与 `exitCodeAdvice`。
4. **有降级路径**：宿主初始化失败时，若备用宿主可用且命令方言兼容，`run_shell` **仍能完成执行**，且结果显式标注实际宿主。
5. **降级不越界**：方言不兼容时**拒绝执行**并返回结构化错误，而非用错误方言硬跑。
6. **拒绝可解释**：审批 `agent-deny` 的 `notExecutedReason` 为 `agent_denied`，且拒绝理由对调用方可读、含可操作指引。
7. **环境构造干净**：PATH 不注入不存在的目录；win32 环境块中 PATH 类键唯一；**任何白名单/allowlist 对 Windows 键名均做大小写归一化**。
8. **兼容**：`exitCodeHint` / `userMessage` 等既有字段语义与展示不变；新增字段为**追加**，不破坏既有消费者（UI、历史重建、统计）。

## 8. 代码落点

| 文件 | 建议改动 |
|---|---|
| `electron/shell/environmentResolver.ts` | **P0-0(a) 根因修复**：白名单匹配改大小写不敏感（或补真实大小写键） |
| `electron/processOutputEncoding.ts` | **P0-0(b) 纵深防御**：`SystemRoot`/`ComSpec` 回填改为向上游/`process.env` 兜底 |
| `electron/shell/shellExitCodes.ts` | P0-A：修正 `0xffff0000.advice`、`0xc0000142.advice` 与 `describeHresult().advice`，移除「改用 run_script」 |
| `electron/shell/shellLogFields.ts` | P0-B：`ALLOWED_KEYS` 增加 `hresult`、`exitCodeAdvice`、`degradedFrom` |
| `electron/shell/shellProfiles.ts` | P0-C：新增 `WINDOWS_PWSH_PROFILE`（可选）与 `WINDOWS_CMD_PROFILE`（`/d /s /c`）；`profileForPlatform` 保持默认行为，降级由计划层决策 |
| `electron/shell/shellExecPlan.ts` | P0-C：`buildSpawnArgs` 支持 `cmd` 参数模板分支（当前按 `shellId === WINDOWS_POWERSHELL_PROFILE.id` 判定） |
| `electron/shell/shellDialectMismatch.ts` | P0-C：降级后可用新 profile 重新判定（须支持幂等重跑） |
| `electron/tools/runShellPlan.ts` / `runShellExecutor.ts` | P0-C：降级决策与执行；结果标注 `degradedFrom`；P0-D2：诊断包采集接入（`0xFFFF0000` 分支）；P0-D1：dev-only 变量隔离开关（临时） |
| `electron/shell/shellHostDiagnostics.ts`（新增） | P0-D：诊断包采集（模块清单 / provider 枚举 / 事件窗口 / hresult 原文 / 令牌快照），有界 + 脱敏 + 失败不影响主流程 |
| `src/shared/domainTypes.ts` | P1-D：`notExecutedReason` 增加 `'agent_denied'` |
| `electron/toolChatLoop.ts` | P1-D：按 `cause` 归类（`:2370-2375` 改为映射表） |
| `electron/confirmation/extractors/commandSequenceExtractor.ts` | P1-E(b)：摘要按真实连接符渲染 |
| `electron/confirmation/agentChannel.ts` | P1-E(c)：`deriveClueExtras` 取全部子命令（~~(a) 理由回传~~ **已存在，不属本次改动**，见 §5.6(a)） |
| `src/shared/processResultProjection.ts` | 投影白名单放行 `degradedFrom`、诊断包字段（仅结构化、有界） |
| `electron/agentLogger/types.ts` | P0-D3 组 1：新增 `script.exec.start` / `script.exec.spawned` / `script.exec.finish`（`AgentLogEventName`） |
| `electron/agentLogger/agentLogProjection.ts` | P0-D3：事件/字段表扩入 `script.exec.*` 及组 2/4/5 的新字段 |
| `electron/tools/builtinExecutors.ts` | P0-D3 组 1：`run_script` 执行期埋点（沿用 `:1225-1230` 的 spawn 点） |
| `electron/shell/shellHostDiagnostics.ts`（新增） | P0-D3 组 2/4/5：进程创建上下文、模块加载时序、env 完整 diff（与 §5.4.2 诊断包共用实现） |
| `electron/shell/toolchainResolver.ts` | P2-G(a)：存在性检查 |
| `electron/processOutputEncoding.ts` | P2-G(b)：win32 分支只写一份 PATH 键 |
| `electron/toolChatLoop.usageStatsInvariant.test.ts` | P1-D：`NOT_EXECUTED_REASONS` 补 `'agent_denied'` |
| `docs/develop/bash-run-shell-current-state-and-optimization-review.md` | P2-H：更新「不自动探测或回退」口径 |
| `docs/plan/run-shell-lifecycle-local-execution-todo.md` | P2-H：修正 PATH 合并口径（§290-291） |
| `docs/requirement/agent-token-usage-analytics-requirement.md` | P1-D/P2-H：`notExecutedReason` 枚举与统计口径 |

**不建议改动**：**在完成 §2.3.2 / §5.4.1 的变量隔离前，不要盲改 `spawn` 形态**——H1–H7 只否证了**参数与 env** 维度，**未覆盖「调用者是 Electron 主进程」这一维度**，而后者正是当前唯一未被排除的主要方向；加密栈相关（无证据支持任何加密层改动）；`shellCommandTrust` / 路径分析 / 权限体系（与本案无关）。

## 9. 不建议的修复方式

- **把 `run_shell` 默认换成 `cmd`**——会丢 PowerShell 能力（cmdlet、`$LASTEXITCODE` 语义、既有认证过的信任命令口径），且必然引发大面积方言错配。降级是**保底**，不是替换。
- **只加「失败自动重试一次」**——重试同一宿主无意义（产品路径 **11/11** 失败，且 `61627b42` 中连续两次失败）。重试必须**换宿主**才有意义。
- **为让命令跑起来而放宽方言预检**——直接用另一种方言执行语义不同的命令，属安全回退（可能执行出与用户意图不同的结果）。
- **信任"重复错误熔断"就够了**——`shouldStopToolRetry` 会中止循环，但**中止不等于给出路径**；模型随后仍会在下一轮换工具。必须补诊断与降级。
- **把本案与 `edit_file` 案合并处理**——同源（单次失败无诊断）但落点不同（执行层回退 vs 编辑层可诊断性），合并会互相稀释验收标准。
- **根因已确证后仍盲改加密栈**——H4/H5 已否证，且根因（D0）与加密栈无关；无证据的改动会引入新变量。
- **只修 `buildShellEnv` 而不修白名单**——(b) 是**纵深防御、不构成修复**（§2.3.3 已证缺键与空串同样失败）；**根治必须做 (a)**。
- **把 `|| ''` 改成"不写该键"就以为修好了**——缺键（E4）与空串（E2）**同样失败**；该改动只让语义更诚实、便于定位，**不能恢复 `run_shell`**。
- **用中间进程（如 Python `os.environ`）转述子进程的环境变量值**——大小写变体并存时，Python 枚举出的值与 Windows 实际取值**可能不一致**（§2.3.3 实验设计要点）；**验证必须让目标进程自报**。
- **在 `BASE_KEYS` 里逐键添加 `'SystemRoot'`/`'ComSpec'` 后就此了事**——Windows 键名大小写随启动源而异（bash 大写、Explorer 混合），逐键列举无法穷尽；应做**归一化匹配**。
- **用 `PROC_THREAD_ATTRIBUTE_PARENT_PROCESS` 从外部"复现"产品故障**——该手法会引入自身副作用（§2.3.2 实测 `0xC0000142`，与产品的 `0xFFFF0000` 不同类），得到的是实验方法的产物，会误导归因。
- **从 bash / Python 继承 env 去做环境类复现实验**——这类探针带大写 `SYSTEMROOT`，**天然免疫本 bug**，必然"测不出问题"（§2.3.2 的教训、§2.3.3 的实验设计要点）。
- **把「40 分钟后正常」当作"已恢复"的依据**——该对照全部经 Python 孙进程，非产品路径（§2.3.1）；产品路径此刻仍失败。
- **把 `agent-deny` 继续留在 `user_rejected`**——会污染 token 统计与错误归因，且掩盖 D9 这一结构性事实。

## 10. 附：证据索引

| 事实 | 出处 |
|---|---|
| **D0 根因（白名单大小写）** | `electron/shell/environmentResolver.ts:3-6`（`BASE_KEYS` 大写 `'SYSTEMROOT'`/`'COMSPEC'`）、`:24`（`allowed.has(key)` 大小写敏感）；`electron/processOutputEncoding.ts:23,26`（`?? ''` 回填） |
| **D0 单变量复现** | §2.3.3：E1–E5（`SystemRoot` 取值 / 缺键 / `WINDIR` 替代性对照）+ X1/X2/X3（产品管线复刻）；本机实测 |
| **D0 判定矩阵（更正后）** | 缺键 ❌ / 空串 ❌ / `WINDIR` 有值但无 `SystemRoot` ❌ / `SystemRoot` 有值 ✅（§2.3.3 三条硬结论） |
| **同根因的其他受害者** | 同一空/缺 `SystemRoot` 下 `python.exe` 亦失败（`_Py_HashRandomization_Init: failed to get random numbers`）——说明该键对各类运行时的加密/RNG 初始化均为必需 |
| D0 评审记录 | `docs/review/20260920-l0-root-cause-environment-whitelist-case-sensitivity.md` |
| 启动链路与唯一 spawn | `electron/tools/runShellPlan.ts`、`electron/tools/runShellExecutor.ts:294`、`electron/shell/shellExecPlan.ts` |
| 单一 Windows profile | `electron/shell/shellProfiles.ts`（`WINDOWS_POWERSHELL_PROFILE`） |
| 「不自动探测或回退」 | `docs/develop/bash-run-shell-current-state-and-optimization-review.md:729-730` |
| 故障 10 次明细与 env 指纹 | `.agent/logs/Agent-202609{11,16,17,18,19,20}.log` 的 `shell.exec.finish` |
| cmd 时期 38 次成功 | `logs/Agent-2026{05,06,07}*.log` 的 `shell.exec.finish` |
| `d05fe8a7` 失败详情 | `sessions/d05fe8a7-…/events.jsonl`（seq 1411 / 1459）、`SecurityAudit-20260920.log` |
| ~~40 分钟后正常（同实例）~~ **（已撤销）** | 该证据全部经 `run_script` → python 孙进程：`sessions/b680b181-…/events.jsonl` seq 42140 / 55993 / 86958；同日产品 `run_shell` 仅 1 次且被 `agent-deny` 拒绝（seq 56062 / 56072）——见 §2.3.1 |
| 产品路径复测仍失败（本次） | `b680b181` 的 `run_shell`（`Write-Output ok`）→ `0xFFFF0000` / `8009001d`；`.agent/logs/Agent-20260920.log` 新增 `shell.exec.finish`（04:21:29Z） |
| 11/11 统计 | 9 月全部 `shell.exec.finish`：`builtin-windows-powershell` 11 条、`exitCode=0` 0 条 |
| 变量隔离实验与 mitigation 对照 | §2.3.2（`PROC_THREAD_ATTRIBUTE_PARENT_PROCESS`、`ExtPointDisable`、`IsProcessInJob`、`0xC0000142`） |
| `run_script` 无执行期埋点 | `electron/agentLogger/types.ts`（`script.*` 仅 4 个，全属策略/确认期）；`electron/tools/builtinExecutors.ts:1235`（仅 `ctx.sendProgress`，不落盘）；`Agent-20260920.log`（`script.*` 只有 `script.ask`） |
| 两路径 spawn 选项本质等价 | `electron/tools/runShellExecutor.ts:294-300` vs `electron/tools/builtinExecutors.ts:1225-1230`；`electron/processOutputEncoding.ts`（`buildPythonScriptEnv` = `buildShellEnv` + 2 变量） |
| 事件投影白名单仅含 shell 系 | `electron/agentLogger/agentLogProjection.ts:9-12` |
| 采集器依赖约束（不用 PowerShell） | PowerShell 为故障方；`tasklist` 实测可用；既有脚本用 `wmic`：`scripts/probe-chat-orphan-cleanup.cjs:17` |
| D5 撤销依据 | `electron/toolChatLoop.ts:2360-2368`（理由回传已存在）、`:2110`；`src/shared/toolResultPairing.ts:4`（配对层占位符）；b680b181 seq 56072（含完整理由） |
| `advice` 教用 `run_script` | `electron/shell/shellExitCodes.ts`（D3） |
| `hresult` 被日志丢弃 | `electron/shell/shellLogFields.ts`（`ALLOWED_KEYS`，D2） |
| PATH 双写 | `electron/processOutputEncoding.ts`（`buildShellEnv`） |
| PATH 注入不存在目录 | `electron/shell/toolchainResolver.ts`（D8） |
| 令牌与特权实测 | 本机 `TokenElevationType=3` / `TokenRestrictedSids=0` / 5 条特权仅 1 条启用；`runas /trustlevel:0x20000` 对照 |
| 无受限令牌构造代码 | 全仓 grep `CreateRestrictedToken` / `DISABLE_MAX_PRIVILEGE` / `LUA_TOKEN` 等 0 命中 |
| CAPI / CNG / Schannel 实测 | `RSACryptoServiceProvider`(1/24)、`XxxCryptoServiceProvider`、DPAPI、`certutil -csp`、`SslStream` TLS1.3 |
| 冷启动 40/40 | 本机压力测试（16.9s，退出码分布 `{0: 40}`） |
| Pluton provider「尚未实现」 | `certutil -csplist` rc=`0x80004001`（候选，非结论） |
| 审批拒绝链 | `.agent/logs/SecurityAudit-20260920.log`（`policy.decision` / `confirm.request` / `confirm.outcome`） |
| 审批矩阵与授权上限 | `src/shared/confirmation/approvalVerdict.ts`、`electron/confirmation/approvalAgent.ts`（`APPROVAL_MAX_AUTHORIZATION`）、`electron/skills/bundled/securityApprovalSkill.ts` |
| `notExecutedReason` 误标 | `electron/toolChatLoop.ts:2370-2375`（D4） |
| `factsSummary` 失真 | `electron/confirmation/extractors/commandSequenceExtractor.ts`（D6） |
| 线索包只取 `commands[0]` | `electron/confirmation/agentChannel.ts`（D7） |
| 脱敏缩写假象 | §2.7（ord 码核验） |
