# `bash` / `run_shell` 现状与优化方案评审

> 评审日期：2026-09-04  
> 评审范围：内置 `run_shell` 从模型工具定义、输入校验、策略门禁、命令分析、Shell 选择、进程执行、取消/超时、输出传输到跨平台测试的完整链路  
> 评审性质：现状审查与改造建议，不包含代码实现  
> 主要依据：当前工作区源码与 `docs/requirement/shell-command-tool-requirement.md`

## 1. 结论摘要

当前 `run_shell` 已具备可用的基础闭环：默认关闭、执行前门禁、命令与路径启发式分析、用户确认/信任、敏感环境变量过滤、超时与取消、流式输出、大输出落盘，以及 Windows `cmd.exe` 与 macOS `/bin/bash` 的基本分支。

但它仍是“由若干平台补丁串起来的命令字符串执行器”，还不是一个边界清晰、行为可验证的跨平台终端服务。运行问题较多的根因不是某一个 Bash 参数，而是以下六类问题叠加：

1. **分析语义与执行语义不统一**：前置检查使用自制、平台混合的简化解析器，真正执行则交给 Bash/cmd/自定义 Shell；同一字符串在两侧可能被不同地理解。
2. **Shell 配置没有类型化**：只有 `executable + argsPrefix + shellId basename`，无法可靠区分 Bash、zsh、cmd、PowerShell、Git Bash 等 dialect，默认参数也不一定适用。
3. **进程生命周期没有真正托管进程树**：Windows 使用 `taskkill /T /F`，macOS 所走的非 Windows 分支只向直接子进程发 `SIGTERM`；孙进程可能继续存活，且没有 TERM→KILL 的升级闭环。
4. **输出处理表面有上限，内存实际无上限**：`fullStdout/fullStderr` 始终累计完整输出，日志也写入完整内容；高输出命令会同时放大主进程内存、IPC 压力、日志体积和最终落盘成本。
5. **目标平台验证不足**：完整 Vitest 目前只在 Linux CI runner 执行；Windows/macOS 矩阵只跑 SQLite 探针。Linux runner 不是产品目标平台，不能替代 Windows 与 macOS 的真实验证。
6. **Agent 可见工具契约与真实执行环境脱节**：工具提示是静态、泛化的 Shell 描述，没有动态绑定当前 dialect；Agent 容易在 Windows 当前的 cmd 执行路径中持续生成 Bash 语法，并在通用错误反馈下重复无效重试。

建议将优化目标定义为：**在通用工具调用框架中引入可选的 `plan()`、必选的 `execute()` 生命周期，由 Tool Gate 统一编排 `plan → policy → confirm → execute`；`run_shell` 作为首个完整实现，以“类型化 Shell Adapter + 事实执行计划 + 可控 Process Supervisor + 有界 Output Pipeline”提供真实执行事实，并通过薄适配器接入项目既有 `ContentFacts`、`decide()`、确认通道、缓存和审计闭环。**

## 2. 当前实现链路

```text
模型生成 run_shell(command, timeout, description)
  → assertSafeToolInput
      命令/描述长度、timeout 1～86400
  → evaluateToolCallGate
  → precheckRunShellTool
      parseShellSegments
      → analyzeSegmentPaths
      → evaluateShellPermission
      → shellSecurity validators
      → trust / allow rule 是否可跳过确认
      → deny 时在统一 policy engine 前短路
  → runExtractors → ContentFacts
  → decide(ContentFacts, ExecutionContext, rules, deps)
      → auto-allow / require-confirm / deny
  → require-confirm 时经 ConfirmationChannel 等待桌面或 IM 结果
  → runShellExecutor
      重新接收原始 inputObj + shellConfig
      resolveShellSpawnSpec
      → planShellExec
      → buildShellEnv
      → spawn(shell: false)
      → stdout/stderr 解码与进度 IPC
      → timeout / AbortSignal → killProcessTree
      → 截断、完整输出落盘、日志、ToolResult
```

### 2.1 已有能力与评价

| 能力 | 当前实现 | 评价 |
|---|---|---|
| 默认关闭 | `DEFAULT_SHELL_CONFIG.enabled=false`，同步进 `deniedTools` | 合理，应保留 |
| 输入校验 | command 最大 8192 字符；timeout 1～86400；拒绝 NUL | 基础完整，但执行器自身不防御性复核 |
| 策略门禁 | Shell 预检接入统一 policy gate，并支持审计 | 方向正确 |
| 静态检查 | 提权、pipe-to-shell、后台 `&`、磁盘擦除、危险 Git、publish 等 | 有价值，但依赖正则和简化 tokenization |
| 路径分析 | 检查显式路径、`cd`、敏感路径和已存在 symlink | 只能作为风险提示，不能当沙箱 |
| 信任 | 仅简单、无 metasyntax 命令可持久化；按 argv token 匹配 | 相比字符串前缀更安全 |
| 默认执行 | Windows `cmd.exe /d /c`；macOS `/bin/bash -lc` | 能覆盖基础场景，但平台体验不一致 |
| 环境过滤 | 清除 API key、OpenAI/Anthropic/Electron 变量和大部分 NODE_OPTIONS | 有效的深度防御，但仍是 denylist |
| 输出 | stdout/stderr 流式回传；终端模式传 base64 raw delta | 功能可用，缺少节流和背压 |
| 大输出 | inline 截断，完整输出写入 userData | 产品体验完整，但实现会先无限占内存 |
| 取消/超时 | AbortSignal/定时器调用 `killProcessTree` | Windows 较强，macOS 所走的非 Windows 分支不是真正的 tree kill |
| TUI | UI 识别常见交互命令并提示外部终端 | 只是展示提示，执行前并未统一拒绝 |

### 2.2 当前安全策略与确认机制的代码事实

当前项目已经存在完整的通用确认框架，`run_shell` 不是直接自己弹确认框：

1. `BUILTIN_TOOL_METADATA.run_shell` 将工具登记为 `actionClass='execute'`、`riskLevel='high'`，并声明 `command-sequence/path-classifier/network-egress` 提取器。
2. `evaluateToolCallGate()` 组装 `ExecutionContext` 和 `ContentFacts`，调用纯函数 `decide()`；策略顺序是硬拒绝、缓存、能力声明、自动审批器、默认规则。
3. `Decision` 只有 `auto-allow / require-confirm / deny`；`require-confirm` 携带现有 `riskLevel`、事实摘要、记忆档位和超时。
4. `ConfirmationChannel` 已统一桌面与 IM 确认；远程链路另有 owner、租约与 `authorizationGeneration` 复核。
5. `command-sequence.persistable` 仅允许单分段、无 Shell 元语法的命令派生 `shell-command exact` 缓存键；复合命令不会因其中某个分段已信任而整体跳过确认。

同时存在一个需要兼容处理的双层事实：`evaluateToolCallGate()` 在通用事实提取和 `decide()` 之前先调用 `precheckRunShellTool()`；后者当前同时做解析、路径判断、内置/用户规则、危险命令判断和旧 Shell 信任，并可直接 deny 或通过 `shell-precheck-auto-allow` 跳过确认。也就是说，现状并非完全由通用策略层裁决，Shell 预检仍包含历史安全决策职责。

通用事实提取对 `run_shell` 的覆盖也有三个代码可证的限制：`commandSequenceExtractor` 丢失真实连接符，并把所有后续分段统一写成 `pipesInto`；`path-classifier` 只读取 `toolInput.path`，而 `run_shell` 输入只有 `command`，因此不会提取命令内路径；metadata 声明了 `network-egress`，但 `runExtractors` 当前没有对应实现，声明本身不会产生网络事实。现有确认卡上的路径/危险提示主要仍来自 Shell 专用预检，而不是通用 `ContentFacts`。

此外，确认 UI 和 `ConfirmRequest` 对 `run_shell` 的风险等级仍在 `toolChatLoop.ts` 中硬编码为 `high`，而不是读取 `gate.decision.riskLevel`；执行阶段又把原始 `inputObj + shellConfig` 交给 `runShellExecutor` 重新解析 Shell 启动参数。当前确认通过的是工具调用及其事实摘要，还没有一个可被原样交给执行器的 Shell 事实计划。

## 3. 主要问题与风险

### 3.1 P0：输出无界累计可能拖垮 Electron 主进程

`runShellExecutor.ts:118-121` 同时维护 inline 字符串和 `fullStdout/fullStderr`；每个 data chunk 都继续拼接完整文本（153-167），直到进程退出后才截断（211-213）和落盘（215-224）。此外完成日志再次记录完整 stdout/stderr（243-244）。

影响：

- `yes`、详细构建、递归日志等命令可持续推高主进程内存；字符串反复拼接还可能产生额外复制。
- “最大 inline 输出”不是资源上限，只是最终返回上限。
- 每个 chunk 都同步触发进度 IPC；高频输出可能阻塞 renderer 和消息持久化链路。
- 完整输出进入 Agent 日志，可能造成磁盘放大，也扩大敏感信息暴露面。
- `persistLargeOutput()` 失败时，`close` 回调中的异步 IIFE 没有 catch，外层 Promise 可能永久不 resolve，并产生 unhandled rejection。

建议：执行期间直接采用有界流水线，而非退出后再处理。

- 内存只保留首段、尾段和终端 scrollback ring buffer。
- 超过阈值后立即切换到文件流，继续增量写入，不保存完整字符串。
- IPC 按 50～100ms 或 16～64KB 合并发送，增加每秒事件和字节预算。
- 日志只记录摘要、字节数、截断标志、hash 和持久化路径，不记录完整输出。
- 输出落盘失败必须返回结构化 `OUTPUT_PERSIST_FAILED`，但仍保证进程结果 Promise 收敛。
- 增加每任务最大输出文件体积、保留周期和清理策略。

### 3.2 P0：macOS 取消/超时无法保证清理子进程树

`spawnUtil.ts:71-86` 在非 Windows 平台只执行 `proc.kill('SIGTERM')`。Shell 启动的子命令可能再派生进程，直接子 Shell 退出不等于整棵树退出。当前实现也没有：

- 创建独立 process group/session；
- 对负 PID 发送组信号；
- grace period 后升级 `SIGKILL`；
- 验证目标进程确实退出；
- 区分“已请求终止”与“已确认回收”。

这会造成超时已返回但编译器、测试服务或下载进程仍在后台运行，继续占端口、写文件或耗资源。

建议引入 `ProcessSupervisor`：

- macOS 启动使用独立进程组，并记录 group id；取消时先 `SIGTERM` 整组，短暂等待后 `SIGKILL` 整组。
- Windows 继续使用 `taskkill /T /F` 作为短期方案；中期评估 Job Object，以便宿主异常退出时也能回收。
- 状态至少区分 `running → terminating → terminated | termination_failed`。
- ToolResult 增加 `terminationReason`、`signal`、`treeKillVerified`（不能验证时为 false，而不是默认成功）。
- 复用该 supervisor 给 `run_script`、CLI subagent 等所有子进程能力，避免继续分叉。

### 3.3 P0：解析器与真实 Shell dialect 不一致，安全结论存在盲区

`parseShellSegments` 只理解单/双引号和 `&&`、`||`、`|`、`;`，没有完整处理 escape、here-doc、括号、PowerShell 语法、cmd caret、变量展开等。路径 tokenization 又有另一份实现；危险 `rm` 提取还有第三份 tokenizer。最终执行却由真实 Shell 解释。

具体表现：

- 分析、权限规则、信任和执行并非基于同一个规范化结果。
- 正则可能在引号/注释/转义内误报，也可能被 Shell 特有转义绕过。
- `shellSecurity.ts:60` 明确已移除 multiline、command substitution、redirection validator，但需求文档 §7.1 仍把三者标记为 P0 已实现，文档与代码冲突。
- 安全检查使用进程平台，却没有使用所选 Shell 的 dialect；Windows 配 Git Bash、macOS 配 PowerShell 时尤其明显。
- 路径分析使用 Node 当前平台的 `path` 语义。例如在非 Windows 主机上单测 Windows 字符串，和真实 Windows 的路径解析并不等价。

建议：

1. `ShellProfile` 明确声明 `dialect: 'posix-bash' | 'windows-powershell'`；目标态不维护 cmd dialect。
2. 一个 `CommandAnalyzer` 产出唯一的 `CommandAnalysis`，供安全、规则、确认 UI、信任和执行计划共同消费。
3. 信任只允许 analyzer 能完整证明为“单一直接程序调用”的命令；其他命令每次确认。
4. 不再声称路径分析是隔离机制；对于无法可靠分析的结构，标记 `analysisCompleteness='partial'` 并强制风险确认。
5. 若短期无法为某 dialect 提供合格 analyzer，就不开放该自定义 Shell，而不是套用 POSIX 正则。

### 3.4 P0：Shell 自定义配置过于宽松，且默认参数推断可能直接错误

`resolveShellSpawnSpec()` 对任何自定义 executable 在未配置 `argsPrefix` 时都默认 `['-lc']`。这适合 Bash/zsh 一类 POSIX Shell，却不适合 `pwsh.exe`、`powershell.exe`、`cmd.exe` 等。`shellId` 只是 basename，`shellExecPlan` 又通过 `shellId === 'cmd'/'bash'` 判断是否为默认 Shell。

典型问题：

- 配置 `powershell.exe` 但未配前缀，会传入 `-lc`。
- 配置完整路径 `C:\Windows\System32\cmd.exe` 时 basename 是 `cmd.exe`，不会命中 `shellId === 'cmd'` 的特判。
- 自定义 `/usr/local/bin/bash` 的 shellId 是 `bash`，会被当作非自定义默认 Bash；语义判断依赖名字碰巧相同。
- `buildSpawnArgs` 只寻找 `-lc` 或 `-c` 插槽，其他参数模型只能把 command 追加到末尾，无法表达 PowerShell 的 `-Command` 或明确占位符。
- 设置页的“测试 Shell”只验证 `echo ok`，不能验证编码、cwd、退出码、复合命令、取消和输出行为。

建议用显式 profile 代替隐式推断：

```ts
type ShellProfile = {
  id: string
  dialect: 'posix-bash' | 'windows-powershell'
  executable: string
  commandArgsTemplate: string[] // 必须且仅有一个 {command} 或 {encodedCommand}
  loginMode: 'none' | 'login'
  encoding: 'utf8' | 'gbk' | 'oem' | 'auto'
  source: 'builtin' | 'user'
}
```

目标态只提供两个内置 profile：macOS 使用系统 Bash，Windows 使用系统内置 Windows PowerShell。Windows profile 固定使用 `powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand {encodedCommand}`；`encodedCommand` 是“UTF-8 输出初始化 prelude + Agent 原始命令”的 UTF-16LE Base64，避免 Windows native argv 对引号、多行和特殊字符再次解释。`Bypass` 仅作用于本次子进程，不修改用户或机器级策略，同时避免 npm 安装的 `.ps1` shim 被本机脚本策略意外阻断。本阶段不把 `cmd.exe`、PowerShell 7 的 `pwsh`、Git Bash 或 WSL 作为可选 profile。Windows 自定义 executable 若不能验证为同一 Windows PowerShell 方言则拒绝保存或迁移为“需用户重新选择”，避免从设置入口重新引入第二套解析与提示逻辑。

### 3.5 P0：Agent 工具提示与真实 Shell dialect 脱节，导致跨平台语法误用

当前工具描述写的是“Windows: cmd，Unix: bash”，但模型和上层 Skill 经常生成 `rm`、`cp`、`export`、单引号、`$(...)`、`/dev/null` 等 POSIX 命令。目标态将 Windows 统一为 PowerShell，但 Bash 与 PowerShell 在变量、命令替换、错误传播、管道对象语义和内建命令上仍不兼容，因此动态 dialect 合同仍然必要。

当前 `shellExecPlan` 只修补了开头 `cd /d "path" && ...` 这一种场景。这解决了 Playwright 安装命令中的特定引用问题，但不是完整跨平台抽象。

这也是一个独立的 **Agent 工具交付契约问题**，不能只靠执行器兼容解决：

- 工具虽然名为 `run_shell`，但对 Agent 暴露时常被统称为 Bash/Shell；模型容易把“Bash 工具”理解成“输入 Bash 语法”。
- `BUILTIN_TOOL_DEFINITIONS` 中的描述是静态文本，只笼统写着“Windows: cmd，Unix: bash”，没有把本次会话的真实 executable、dialect 和关键语法禁忌突出为硬约束。
- `buildAvailableToolsHint()` 只告诉 Agent “run_shell 可在工作目录执行 shell 命令”，没有携带平台或 dialect。
- 用户当前可以在运行时配置自定义 executable；目标态必须收紧该入口，避免实际 Shell 从 Windows PowerShell 漂移到 cmd、`pwsh`、Git Bash 或其他未知方言。
- 错误返回只有通用退出码和 stderr，缺少 `SHELL_DIALECT_MISMATCH` 之类可让 Agent 立即纠正的结构化信号。模型收到多轮“命令不存在/语法错误”后，仍可能在同一错误方言上反复试错。

因此，面向 Agent 的工具定义必须由“静态通用说明”升级为“按本次请求解析出的真实 Shell Profile 动态生成”。建议产品协议不要让模型猜平台。

#### 3.5.1 动态工具提示

在组装本轮 LLM tools 时，根据已经解析并验证的 `ShellProfile` 重写 `run_shell.description`，而不是直接复用全局静态对象。至少明确：

- 当前 OS；
- 当前 dialect；
- 实际 executable；
- 当前工作目录；
- 允许使用的变量、引号、路径和复合命令语法；
- 明确禁止混用的其他方言代表语法；
- 1～2 个当前平台正确示例；
- 应优先使用已有专用工具的场景，避免用 Shell 重复实现文件搜索、读写或飞书操作。

Windows PowerShell 示例提示可采用：

```text
在 Windows PowerShell 5.1 中执行命令。当前 shell dialect=windows-powershell，不是 Bash 或 cmd.exe。
环境变量使用 $env:NAME，空输出使用 $null，删除目录使用 Remove-Item -Recurse -Force。
不要使用 export、%NAME%、/dev/null、rm -rf 或 cmd 专属开关；Windows PowerShell 5.1 不支持 PowerShell 7 的 &&/||。
当前工作目录：{cwd}。示例：npm test；if (Test-Path dist) { Remove-Item -Recurse -Force dist }。
```

POSIX Bash 示例提示可采用：

```text
在 POSIX Bash 中执行命令。当前 shell dialect=posix-bash，不是 Windows PowerShell。
使用 $NAME、单/双引号和 /dev/null；禁止使用 $env:NAME、$null 或 PowerShell cmdlet。
当前工作目录：{cwd}。示例：npm test；rm -rf -- dist。
```

#### 3.5.2 额外注入短小、结构化的运行环境块

工具 description 容易被长上下文稀释，建议同时在 system prompt 的“当前可用工具”区域注入稳定、靠后的能力块：

```text
<terminal_environment>
os: windows
shell_profile_id: builtin-windows-powershell
dialect: windows-powershell
executable: powershell.exe
cwd: D:\workspace\project
path_separator: \
supports_posix_syntax: false
</terminal_environment>
```

这里的信息必须和最终 `PreparedShellExecution` 来自同一个 profile snapshot，不能分别读取配置，否则提示和执行仍会漂移。字段保持短小，不注入整份环境变量；路径等内容按不可信数据进行定界，避免工作目录名称影响系统指令。

#### 3.5.3 命令提交前的 dialect mismatch 检查

仅依赖提示不能完全阻止模型犯错。`CommandAnalyzer` 应增加高置信方言错配信号：

| 当前 dialect | 典型错配信号 | 建议行为 |
|---|---|---|
| Windows PowerShell 5.1 | `export X=...`、`$VAR` 作为环境变量、`/dev/null`、`rm -rf`、裸 `&&/||`、`%VAR%` | spawn 前拒绝，返回 PowerShell 改写提示 |
| POSIX Bash | `$env:VAR`、`$null`、`Remove-Item/Get-ChildItem`、PowerShell script block | spawn 前拒绝或强提示 |

该检查只能拦高置信特征，不能把跨平台同名程序一概拒绝。例如用户可能确实在 Windows PATH 中安装了 `rm.exe`。因此错误中应包含命中的 signal 和当前 profile，必要时允许用户确认继续，而不是堆更多脆弱正则作为绝对安全边界。

推荐错误合同：

```ts
{
  code: 'SHELL_DIALECT_MISMATCH',
  detectedSyntax: 'posix',
  expectedDialect: 'windows-powershell',
  shellProfileId: 'builtin-windows-powershell',
  executable: 'powershell.exe',
  hints: ['使用 $env:NAME 代替 export NAME=...', '使用 $null 代替 /dev/null']
}
```

Agent 收到此错误后，工具结果应明确要求：**不要原样重试；按 `expectedDialect` 重写一次，若仍失败则先查询/复述 terminal capability，而不是继续猜测。** 主循环还应识别连续两次相同 mismatch，停止自动重试并向用户报告。

#### 3.5.4 命名与工具拆分

- **正式工具合同只向 Agent 暴露一个中性名称 `run_shell`**；产品 UI 可以继续显示“命令执行”，但内置 tools、Skills、system prompt 和示例中不得再把该能力命名或泛称为 `bash`。
- `run_shell` 是稳定的工具能力标识，不代表固定 Shell 方言。目标态只存在 macOS Bash 与 Windows PowerShell 两种平台 profile，必须由本轮冻结的 `ShellProfile` 决定，并通过 `terminal_environment` 和动态工具描述明确交付给 Agent。
- 如果外部 Agent 协议固定把工具叫 `Bash`，只允许在协议适配层做 `Bash → run_shell` 的入站名称映射，并在其 system/tool prompt 中明确声明：“Bash 是协议工具名，不代表 Bash 方言；实际 dialect 见 terminal_environment”。兼容名称不得进入内部领域模型和执行计划。
- 禁止在同一 Agent 工具集中同时暴露 `bash` 与 `run_shell` 两个指向同一执行器的别名；这会强化错误心智模型，也使权限、审计、限流和信任分裂。
- 权限确认、持久信任、审计日志、调用指标和重试熔断统一以规范化后的 `run_shell` tool id 记录。外部协议原始名称只作为诊断元数据保留，不参与授权键或策略匹配。
- 迁移期遇到旧版内部 `bash` 调用时，应由边界兼容层规范化为 `run_shell` 并记录弃用指标；新生成的工具定义和 Agent 提示不得继续产生 `bash` 调用。达到预定兼容窗口后删除该内部别名。

该决策的验收边界是：**对任意一次 Agent 请求，公开工具集中至多存在一个 Shell 字符串执行入口，其规范名称必须是 `run_shell`；无论请求从哪个协议名称进入，最终必须落到同一份工具合同、权限策略、审计记录与 HostTerminalService 执行路径。**

#### 3.5.5 提示交付链路

建议由单一函数生成 Agent 可见合同：

```ts
buildTerminalToolContract(profileSnapshot, workDir) => {
  toolDefinition,
  systemCapabilityBlock,
  analyzerDialect,
  executionPlanDefaults
}
```

同一返回值分别供 LLM tools、system prompt、预检 analyzer 和执行计划使用。不要在 `builtinToolDefinitions.ts`、`skillPrompt.ts`、执行器和错误映射中各维护一份平台判断。

落地后的完整防线是：

- 每轮工具上下文暴露结构化 `terminal_capabilities`：OS、dialect、可执行文件、cwd、path separator、是否支持 ANSI/TTY。
- 工具描述动态生成与当前 profile 对齐的简短说明和示例。
- 提交前识别高置信 dialect mismatch，避免把显然错误的命令交给 Shell 后才报错。
- 失败结果携带 expected dialect 和定向纠错建议，限制同类无效重试。
- npm、git、构建、测试等 CLI 与管道、重定向、复合语法统一通过 `run_shell` 执行；简单命令与复杂命令使用同一 Profile、Analyzer、确认适配和 ProcessSupervisor 链路。
- 文件搜索、文件读写、飞书等已有专用能力继续优先使用专用工具，避免扩大 Shell 承担的业务范围。

### 3.6 P1：`bash -lc` 带来启动环境不稳定与副作用

macOS 当前固定 `/bin/bash -lc`。登录 Shell 会读取 profile 文件，可能：

- 改写 PATH、alias、函数、locale 和工具链版本；
- 输出额外文本，污染 stdout；
- 执行用户 profile 中具有副作用或耗时的代码；
- 造成“系统终端能运行、App 里不能运行”或相反的差异；
- macOS 自带 Bash 版本老旧，且用户日常 Shell 往往是 zsh。

建议默认使用非登录、非交互模式（如 Bash `--noprofile --norc -c` 或经验证的 `-c`），运行环境由宿主显式构造。若确实需要版本管理器环境，应通过一次可观察、可缓存的 Environment Resolver 获取路径，不应让每条命令隐式执行用户 profile。登录模式可保留为高级兼容选项，并在 UI 显示副作用提示。

### 3.7 P1：环境变量过滤是 denylist，跨平台一致性不足

`buildShellEnv()` 过滤 `API_KEY`、`ANTHROPIC_*`、`OPENAI_*`、`ELECTRON_*` 和 NODE_OPTIONS，但仍会继承大量宿主环境变量。潜在凭据可能使用 `TOKEN`、`SECRET`、`PASSWORD`、云厂商专用名称或应用自定义名称。

同时：

- Windows PATH 增强仅添加少数 npm/node 常见目录，无法覆盖 nvm/fnm/Volta 等安装方式。
- macOS 不增强 GUI App 常缺失的 PATH，却通过 `bash -l` 间接补偿，形成平台不同的环境来源。
- Windows 同时设置 `Path` 和 `PATH`，子进程/库对大小写合并行为可能不同。
- locale/编码策略和 Shell profile 没有绑定。

建议改为“最小 allowlist + 显式扩展”：基础 OS 变量、HOME/USERPROFILE、TMP、PATH、locale、证书相关变量；项目所需额外变量由用户或任务授权明确加入。工具链发现统一由 Environment Resolver 提供，并记录 `environmentFingerprint` 便于复现。

### 3.8 P1：编码探测可能在流式过程中反复改判

`createProcessOutputStreamDecoder()` 每次收到 chunk 都重新拼接全部 Buffer，并分别按 UTF-8/GBK 解码，再通过是否包含 CJK/U+FFFD 决定编码。问题包括：

- 总解码成本随输出增长趋近 O(n²)。
- 早期 chunk 可能判 UTF-8，后续出现 GBK 中文后改判，`text.slice(lastText.length)` 无法正确表达“前文编码发生变化”，导致丢字或重复。
- Windows 控制台实际还可能使用 OEM code page，而非 GBK。
- terminal raw delta 与最终文本解码路径不同，用户看到的实时结果与最终结果可能不一致。

建议在进程启动时确定编码：Windows PowerShell profile 通过统一启动 prelude 固定控制台与管道输出编码，macOS Bash profile 固定 locale/UTF-8；无法确定时仅在有限前导缓冲区内探测一次，然后锁定增量 decoder。不要每个 chunk 重解历史。Windows 目标态不再保留 cmd code page 分支。

### 3.9 P1：取消、超时和退出结果缺少严格竞态模型

当前定时器与 AbortSignal 都异步调用 kill，但不 await；结果由 `close` 事件统一决定。存在以下模糊点：

- 超时和用户取消几乎同时发生时，由布尔赋值时序决定文案。
- 终止失败仍可能在 3 秒后被 `killProcessTree` 当作已处理，但 run_shell 仍等待 `close`，可能永不返回。
- spawn error 和 close 可能都触发后续逻辑，虽 Promise 只接受第一次 resolve，但日志/落盘仍可能重复。
- `exitCode=null` 没有返回 signal；用户无法区分正常退出、被信号杀死和宿主失联。

建议定义原子终态优先级，例如：`user_cancel > timeout > output_limit > process_exit > transport_error`，由单一 finalize 函数负责资源清理和恰好一次结算。终止超过 deadline 后返回 `TERMINATION_UNCONFIRMED`，不能无限等待 close。

### 3.10 P1：安全规则存在误报、漏报与文档漂移

当前 validator 多数基于全字符串正则。例如引号中的 `sudo` 也可能误报；`pipe_to_shell` 不要求左侧一定是网络下载；危险 Git 正则对参数顺序、短参数组合和子 Shell 的覆盖有限。`dangerous_rm` 只识别少数 `-rf/-r -f` 组合和直接字面量目标。

更重要的是，需求文档仍宣称重定向、命令替换、多行属于硬 deny，而测试明确验证它们“不再 deny”。这会让评审、测试和用户界面基于错误安全承诺。

建议：

- 先做行为基线表，明确每类语法是 deny、ask 还是 allow，不再让注释和旧需求各说一套。
- `run_shell` Analyzer 只输出命令节点、操作、路径、控制流、解析完整性等事实，不再产生 `verdict/denyType/requiresRiskAck/skipConfirm`。
- 现有 Shell 强/弱 validator 先等价映射为新增的 Shell 事实信号，并由 `DEFAULT_POLICY_RULES + decide()` 保持当前 deny/ask 行为；只为“必须逐次确认”增加缓存前 `confirm-every-time` 阶段，不重写其余策略算法。
- 硬 deny 规则仍由安全策略拥有，只消费能够高置信提取的事实；不可完整分析的复杂命令使用现有 `extraction-failed`/新增 Shell incomplete 事实进入默认确认，且不派生记忆档位。
- 用户配置中的 `ShellRule` 和旧 `trustedCommands` 在迁移期由确认层兼容适配，不进入事实 `PreparedShellExecution`；新代码不得继续从 Analyzer 返回 allow/deny。
- 对“已确认仍允许越界”与“绝对禁止”使用不同错误码和 UI 状态。

### 3.11 P1：信任授权范围仍可能过宽

结构化信任已经避免了旧版 `startsWith` 前缀问题，但 `trailingArgv='plain-tokens'` 会允许已确认前缀之后出现任意无 metasyntax token。若用户信任的是过短命令（例如只有 `npm`、`git`、`node` 或 `cat`），后续不同子命令或目标可能跳过确认。当前信任项也没有绑定 Shell profile、workDir、环境指纹或执行 lane。

这不是字符串注入，但属于授权范围膨胀：同一个 executable 在不同参数下可能从只读变成发布、联网、删除或执行任意代码。后续静态 validator 可以拦住部分已知危险模式，却不能证明所有 trailing argv 都保持同一风险等级。

建议：

- 默认信任使用 exact argv；只有具备专门参数策略的命令才允许 trailing argv。
- 为 git/npm 等建立 action-aware scope，至少固定到子命令，并区分 read/write/network/publish。
- 拒绝持久化过短前缀和通用解释器入口（`node`、`python`、Shell 本身）。
- 不扩展通用 `CacheKey` 联合类型来承载 ShellProfile；由 Shell 确认适配器把稳定的 profile/dialect 标识加入现有 `command-sequence` 规范化签名，使既有 `shell-command exact` 缓存、确认通道和审计无需改协议即可自然隔离不同方言。旧签名按 fail-safe 方式不再命中并重新确认。
- 每次命中信任仍重新执行完整风险分析；分析不完整时不得跳过确认。

### 3.12 P1：审计日志可能记录命令与输出中的敏感信息

启动日志记录原始 command，完成日志记录完整 stdout/stderr。即使环境变量已过滤，命令行仍可能含 token、带密码 URL、header、数据库连接串；输出也可能打印凭据或私有数据。`sanitizeToolOutputText()` 只用于返回数据，日志调用发生在它之前。

建议日志采用字段级脱敏与安全默认值：原始 command/output 不进入常规日志；记录规范化摘要、hash、长度、退出状态和受控尾部。需要诊断原文时，写入权限收紧、带 TTL 的独立 artifact，并由用户显式导出。

### 3.13 P2：执行结果和可观测性不足

当前结果缺少 `signal`、实际 executable、规范化执行计划、输出字节数、输出编码、终止原因、进程树回收状态。`shell` 字段只返回 basename，排障价值有限。

建议增加稳定的结果合同：

```ts
type TerminalResult = {
  status: 'exited' | 'cancelled' | 'timed_out' | 'spawn_failed' | 'termination_unconfirmed'
  exitCode: number | null
  signal: string | null
  shellProfileId: string
  dialect: 'posix-bash' | 'windows-powershell'
  cwd: string
  durationMs: number
  stdoutBytes: number
  stderrBytes: number
  inlineTruncated: boolean
  outputArtifact?: { path: string; bytes: number; sha256: string }
  treeKillVerified?: boolean
}
```

错误使用机器可判定 code，用户文案在 renderer i18n 映射，避免主进程散落中文字符串。

## 4. 当前跨平台差异矩阵与目标收敛

| 维度 | Windows / cmd | macOS / bash | 当前主要问题 |
|---|---|---|---|
| 默认入口 | `%ComSpec% /d /c` | `/bin/bash -lc` | 默认 dialect 不同，模型命令不可直接移植 |
| 引号 | `"`、caret、`%VAR%` | POSIX quote/escape | 自制 parser 未完整覆盖任何一套 |
| 路径 | drive、UNC、反斜杠 | POSIX、大小写通常不敏感 | 分析逻辑依赖当前 Node 平台 |
| 编码 | UTF-8/GBK/OEM 混合 | 通常 UTF-8 | 当前 GBK 启发式会反复改判 |
| 进程树 | `taskkill /T /F` | 仅直接 PID SIGTERM | macOS 孙进程可能泄漏 |
| npm shim | `.cmd`/`.ps1` | 可执行脚本 | cmd 通常能跑，切 PowerShell/Git Bash 后又变 |
| 环境发现 | 手工补 npm/node 常见路径 | 依赖 login profile | 来源不同、不可复现 |
| CI | 不跑完整测试 | 不跑完整测试 | Linux runner 上的完整测试不能替代产品目标平台验证 |

该表只描述 Windows 与 macOS 两个产品目标平台的当前代码事实。目标态收敛为：Windows 只保留 Windows PowerShell 5.1 Adapter/Analyzer/Profile，macOS 只保留系统 Bash Profile；删除 cmd 的执行、提示、分析和目标测试分支。`.cmd` 程序仍可由 PowerShell 按 Windows `PATHEXT` 规则启动，但这不等于保留 cmd Shell 方言支持。Linux 可以继续作为通用单元测试 runner，但不属于产品支持矩阵、发布验证或“两平台行为一致性”验收口径。

## 5. 推荐目标架构

```text
Agent → ToolCall(toolName, input)
  → ToolInvocationCoordinator / Tool Gate
      ├─ 工具实现了 plan()
      │    → tool.plan(input, context)                    无业务副作用
      │    → PreparedToolPlan + ContentFacts 投影
      ├─ 工具未实现 plan()
      │    → 使用原始输入执行既有通用事实提取
      ├─ evaluateToolCallGate(facts) → decide()
      │    ├─ auto-allow
      │    ├─ require-confirm → 既有 ConfirmationChannel
      │    └─ deny
      └─ allow 后调用 tool.execute(executionInput, context)

run_shell.plan(command)
  → RunShellRequestValidator
  → ShellProfileRegistry + EnvironmentResolver
  → ShellCommandAnalyzer(profile.dialect)
  → PreparedShellExecution（仅含执行事实）
      ├─ spawnSpec / cwd / env fingerprint / timeout
      ├─ command graph / connectors / cwd transitions
      ├─ operations / explicit paths / unresolved facts
      └─ analysis completeness
  → ShellConfirmationAdapter → ContentFacts / FactSignal

run_shell.execute(PreparedShellExecution)
  → HostTerminalService
      ├─ ProcessSupervisor
      ├─ OutputPipeline
      └─ TerminalEventStore
  → TerminalResult / OutputArtifact
```

通用机制中的 `plan()` 是可选能力，`execute()` 是必选能力。没有计划方法的现有工具继续沿用当前的“原始输入提取事实后执行”路径，因此不要求一次性改造所有工具；需要解析真实目标的工具可以提供完整计划，输入已接近最终操作的工具可以提供很薄的计划。`plan()` 由调用编排层调用，策略引擎只接收事实并返回决策，不能由策略引擎反向调用工具。

通用注册表必须显式区分 direct/planned 两类工具。当前 `Map<string, ToolExecutor>` 会擦除工具私有泛型，因此不能直接把 `ToolRegistration<I, O, P>` 联合塞进现有 registry，也不能让 coordinator 用类型断言把任意 plan 交给任意 executor。建议通过注册工厂在工具边界内完成泛型擦除：

```ts
interface DirectToolSpec<I, O> {
  name: string
  parseInput(raw: unknown): I
  execute(input: I, context: ToolExecutionContext): Promise<O>
}

interface PlannedToolSpec<I, P, O> {
  name: string
  parseInput(raw: unknown): I
  plan(input: I, context: ToolPlanningContext): Promise<PlanResult<P>>
  canonicalizePlan(plan: P): Uint8Array
  validatePlan(plan: P, context: ToolValidationContext): Promise<PlanValidation>
  execute(plan: P, context: ToolExecutionContext): Promise<O>
}

interface InvocationHandle {
  readonly kind: 'direct' | 'planned'
  readonly prepared: PreparedInvocation
  validate(context: ToolValidationContext): Promise<PlanValidation>
  execute(context: ToolExecutionContext): Promise<unknown>
}

interface RegisteredTool {
  readonly kind: 'direct' | 'planned'
  readonly name: string
  // begin 只是框架适配入口；planned 工具在内部调用 spec.plan，direct 工具只校验并封存 input。
  begin(raw: unknown, context: InvocationContext): Promise<InvocationHandle>
}

declare function defineDirectTool<I, O>(spec: DirectToolSpec<I, O>): RegisteredTool
declare function definePlannedTool<I, P, O>(spec: PlannedToolSpec<I, P, O>): RegisteredTool
```

注册工厂返回的 planned registration 内部闭包同时持有 `P` 的 validator、canonicalizer 和 executor；`PreparedInvocation` 的执行句柄只能回到生成它的 registration，coordinator 和策略层均不接触或断言 `P`。这样现有异构 `Map<string, RegisteredTool>` 可以安全保存工具，同时保留每个工具内部的类型关联。

`ToolPlanningContext` 只能提供解析所需的稳定上下文，不提供执行能力；`plan()` 禁止创建子进程、写文件、发送网络请求或改变业务状态。若某个工具无法在无副作用条件下解析真实目标，应在计划中陈述未决事实，而不是偷偷执行探测。计划失败不得降级为 direct execution。

### 5.1 PreparedInvocation 合同与一次性状态机

`PreparedInvocation` 是框架持有的调用信封，不是策略模型的一部分；工具私有 plan 不进入 `Decision` 或 `ConfirmationChannel`：

```ts
interface PreparedInvocation {
  readonly invocationId: string
  readonly requestId: string
  readonly toolUseId: string
  readonly toolName: string
  readonly planDigest: string
  readonly factsDigest: string
  readonly displayDigest?: string
  readonly facts: DeepReadonly<ContentFacts>
  readonly display?: DeepReadonly<ToolPlanDisplay>
  // 不公开 executionPayload；由创建该信封的 registration 私有闭包消费。
}

type InvocationState =
  | 'planning'
  | 'planned'
  | 'decided'
  | 'awaiting-confirmation'
  | 'approved'
  | 'validating'
  | 'executing'
  | 'settled'
```

注册工厂在 plan 完成后对 plan、facts 和 display 做规范序列化并计算摘要，再深度冻结对外信封；`invocationId + requestId + toolUseId + toolName` 绑定调用归属。策略审计、确认请求审计、批准结果和执行开始事件记录同一组 identity 与摘要。状态转换由 coordinator 单点维护，任何篡改、跨工具/跨调用复用、批准前执行、重复执行或终态后执行都在产生副作用前失败。摘要用于应用内一致性校验和审计关联，不宣称能够冻结操作系统资源。

planned 工具的 `planDigest` 来自工具 canonicalizer 的私有 plan 规范字节；direct 工具没有领域 plan，其同名字段明确记录经 `parseInput` 后的规范输入摘要，不能伪装成可审查的领域执行计划。`InvocationHandle.validate/execute` 闭包在每次调用时重新核对 identity、状态以及私有载荷的 canonical digest，不能只依赖 coordinator 会正确调用的约定。

planned 工具的框架时序固定为：

```text
parseInput → plan → seal PreparedInvocation
  → evaluateToolCallGate(prepared facts)
  → deny | confirm | approve
  → validatePreparedInvocation
  → registration.execute(private plan)
  → settled
```

direct 工具继续为：

```text
parseInput → 既有 extractors(raw input) → evaluateToolCallGate
  → deny | confirm | approve → registration.execute(parsed input) → settled
```

planned 路径不得再次执行 `runExtractors(rawInput)`；direct 路径不得构造伪 plan。建议保留 `evaluateToolCallGate` 作为唯一 invocation 决策入口，但增加互斥入参 `{ kind: 'direct', rawInput } | { kind: 'planned', preparedFacts, identity }`。Gate 不调用 `plan()`、不保存私有 plan，只验证 identity/facts 摘要、构造既有 `ExecutionContext` 并调用 `decide()`。

### 5.2 关键设计原则

1. **通用可选计划生命周期**：工具可选实现 `plan()`、必须实现 `execute()`；Tool Gate 负责编排而不理解各工具领域语义，策略引擎不直接调用工具。
2. **准备一次、密封一次、复核后执行**：`run_shell.plan()` 在策略判断前生成私有 `PreparedShellExecution`，框架将其事实与调用身份密封为 `PreparedInvocation`；确认后先复核易变依赖，再由原 registration 执行同一私有计划，不从 `inputObj + shellConfig` 重建，也不把“同一对象”误当成操作系统资源不会变化。
3. **平台差异封装在 Adapter**：业务层不再散落 `process.platform`。
4. **保持单一执行入口**：不新增 `run_process`；所有通用 CLI 和 Shell 组合命令统一进入 `run_shell`，由同一套 Profile、Analyzer、事实计划、确认和执行基础设施处理。
5. **有界资源**：内存、输出文件、IPC 频率、运行时长和进程数都有硬上限。
6. **终态可证明**：不能证明进程树已清理时就暴露不确定状态。
7. **安全模块保持独立**：各工具拥有自己的计划语义；策略模块只消费事实并沿用现有 `ContentFacts → Decision → ConfirmationChannel` 合同。
8. **安全承诺准确**：静态分析只描述它能观察到的内容，不把 cwd 或路径扫描宣传为沙箱。

### 5.3 事实计划与安全判断的职责边界

`run_shell`、`ShellAdapter`、`CommandAnalyzer` 和模块私有的 `PreparedShellExecution` 只负责提供可验证的执行事实，不得输出 `low/high/critical`、`requiresConfirmation`、`trustEligible`、`verdict`、`denyType` 或 `skipConfirm`。即使识别出递归删除，也只陈述操作类型、参数、作用路径、控制流和解析确定性：

```ts
interface PreparedShellExecution {
  readonly shellProfile: DeepReadonly<ShellProfileSnapshot>
  readonly rawCommand: string
  readonly spawnSpec: DeepReadonly<{ executable: string; argv: readonly string[] }>
  readonly initialWorkDir: string
  readonly operationGraph: DeepReadonly<OperationGraph>
  readonly affectedResources: DeepReadonly<readonly AffectedResource[]>
  readonly analysisConfidence: 'complete' | 'partial' | 'unknown'
  readonly unresolvedFacts: DeepReadonly<readonly UnresolvedFact[]>
  readonly frozenEnv: DeepReadonly<Record<string, string>>
  readonly dependencies: DeepReadonly<PlanDependencySnapshot>
  readonly timeoutMs: number
}
```

例如 `cd subdir && rm -rf ../build` 的事实计划可以分别表达 `change-directory`、`connector=and`、第二步的 effective cwd、`recursive-delete`、`force=true` 和候选目标路径，但不能自行把它们标为高危。

与现有确认机制的边界通过 `ShellConfirmationAdapter` 收敛。它只把 Shell 专有事实投影为当前框架可消费的 `ContentFacts`：

- `toolName/actionClass/baseRiskLevel` 仍由 `BUILTIN_TOOL_METADATA` 提供；`run_shell` 不写风险等级。
- 简单/复合命令继续产出 `command-sequence`，但必须修复当前把所有后续分段误标为 `pipesInto` 的问题，并保留真实 `&&/||/|/;` 连接关系。
- 路径事实投影为既有 `path-target`；需要展示 cwd 传播、操作类型或解析不完整时，以最小的新增 Shell `FactSignal` 扩展承载。
- 现有 Shell validator 的强拒绝/弱确认语义以规则等价为目标：Analyzer 产出事实，`DEFAULT_POLICY_RULES` 消费事实；`decide()` 只增加位于 hard deny 与缓存之间的 `confirm-every-time` 阶段，其余求值顺序和确认通道不改。
- `CommandFact.signature` 由适配器加入稳定的 profile/dialect namespace，用现有 `shell-command exact` 缓存键隔离不同 Shell；不扩展通用 `CacheKey` 类型。
- Agent 提供的 description 和意图是非授权输入，不得被映射成风险或放行信号。

为避免本项目被安全框架重构阻塞，迁移采用等价适配：第一步允许在 Gate 的 planned 分支保留一层明确标注的 `LegacyShellPolicyAdapter`，承接现有 `ShellRule` 与旧 `trustedCommands`，但它只把旧配置编译为本次 `decide()` 使用的规则/缓存输入，不得修改计划或直接返回 skip-confirm。它的唯一位置是 facts 生成之后、`decide()` 之前；任何 allow 都必须晚于新的 locked deny，且不得继续使用现有 `autoEvaluator` 闭包形成第二条放行路径。待旧信任迁入 decision cache 后删除该适配器。

确认 UI 继续使用现有 `Decision` 和 `ConfirmRequest`，但展示内容必须来自 sealed invocation 的 `facts/display`，不能继续从原始 `inputObj` 和 `shellPrecheck` 分别拼装。当前 `toolChatLoop.ts` 对 `run_shell` 再次硬编码 `riskLevel='high'`，应统一读取 `gate.decision.riskLevel`；`trustEligible`、Shell warnings、扫描路径和命令摘要也统一改为读取 gate 产出的 facts/display。Agent 的 `description` 只作为非授权辅助文案，不进入事实、摘要或信任键。

### 5.4 Shell validator 迁移与缓存顺序

当前 `decide()` 的代码顺序是“危险信号/locked deny → 缓存 → capability → auto-evaluator → 普通 ask/allow”。仅把风险事实配置成普通 `ask` 并清空 `memoryTiers`，仍可能被已有缓存、declared capability、auto-evaluator 或普通 allow 提前放行。因此本方案对通用策略合同做一项明确的小扩展：新增 `PolicyAction='confirm-every-time'`，其求值位置固定在所有 hard deny 之后、所有自动放行来源之前：

```text
locked deny
→ confirm-every-time
→ cache
→ declared capability
→ auto-evaluator
→ ordinary ask/allow
```

`confirm-every-time` 直接返回 `require-confirm`，固定 `memoryTiers=[]`，不执行 `askUnless`；它是策略规则的裁决语义，不得由 Analyzer 或 `PreparedShellExecution` 输出。若同一调用同时命中 locked deny 和 `confirm-every-time`，必须 deny。该动作默认视为系统保护规则，不允许用户 override 为 ask/allow/auto-evaluator。

同时增加统一的调用级 `MemoryEligibility`，避免只禁止某一个 signal 产键、同一 facts 中其他 command/path signal 仍然命中缓存：

```ts
interface InvocationPolicyConstraints {
  readonly mandatoryConfirmationRuleId?: string
  readonly memory: MemoryEligibility
}

interface MemoryEligibility {
  readonly canRead: boolean
  readonly canOffer: boolean
  readonly canWrite: boolean
  readonly reason?: string
}

function deriveInvocationPolicyConstraints(
  facts: ContentFacts,
  context: ExecutionContext,
  rules: readonly PolicyRule[],
  deps: PolicyEngineDeps,
): InvocationPolicyConstraints
```

该约束由策略层根据 facts 与实际命中的 `confirm-every-time` 规则一次性推导，不在 Shell Adapter 中硬编码裁决。只要命中任一此类规则，三项资格必须整体为 false。`decide()` 在查询缓存前先检查 `mandatoryConfirmationRuleId` 并返回无记忆档位的确认；若继续普通流程，`deriveCacheKeys()` 必须显式接收 constraints，并在 `canRead=false` 时为整个 invocation 返回空数组，`buildMemoryTiers()` 在 `canOffer=false` 时返回空数组。缓存写入入口必须接收本次 `Decision`，只允许写入该 Decision 实际给出的 `memoryTiers` 成员；`canWrite=false`、空列表或伪造 key 一律拒绝并记录审计。不能继续只依赖调用方“保证有记忆档位时才写入”。

Legacy `ShellRule allow`、`trustedCommands`、declared capability、auto-evaluator 和普通 allow 都位于 `confirm-every-time` 之后，命中该动作时不再求值。Shell Analyzer 只产出下表中的事实信号，策略规则负责裁决：

| 当前来源 | 新事实信号（仅陈述事实） | 新规则 | 缓存相对顺序 | 记忆 |
|---|---|---|---|---|
| builtin permission `sudo/doas`、validator `privilege` | `shell-privilege-command` | `locked deny` | 缓存前 | 不允许 |
| builtin permission/validator `lark_cli` | `shell-specialized-tool-bypass` | `locked deny` | 缓存前 | 不允许 |
| `interactive_shell` | `shell-interactive-request` | `locked deny` | 缓存前 | 不允许 |
| `pipe_to_shell` | `shell-pipe-to-interpreter` | `locked deny` | 缓存前 | 不允许 |
| `background_exec` | `shell-background-request` | `locked deny` | 缓存前 | 不允许 |
| `dangerous_rm` 且目标为根目录/主目录等 fatal target | `shell-recursive-delete` + `shell-fatal-target` | `locked deny` | 缓存前 | 不允许 |
| `dangerous_rm` 的普通递归删除 | `shell-recursive-delete` | `confirm-every-time` | 不读缓存 | 不允许 |
| `disk_format` | `shell-disk-format-command` | `locked deny` | 缓存前 | 不允许 |
| `disk_wipe` | `shell-disk-wipe-command` | `locked deny` | 缓存前 | 不允许 |
| `dangerous_env` | `shell-loader-environment-mutation` | `locked deny` | 缓存前 | 不允许 |
| `dangerous_git` | `shell-destructive-git-operation` | `confirm-every-time` | 不读缓存 | 不允许 |
| `npm_publish` | `shell-package-publish` | `confirm-every-time` | 不读缓存 | 不允许 |
| `PATH_OUTSIDE_WORKDIR` / `CD_OUTSIDE_WORKDIR` / `SENSITIVE_PATH` / `SYMLINK_OUTSIDE` | 既有 `path-target` + 对应 zone/reason | 对当前 `requiresRiskAck` 等价事实使用 `confirm-every-time` | 不读缓存 | 不允许 |
| 解析失败或 `analysisConfidence=partial/unknown` | `shell-analysis-incomplete` + unresolved facts | `confirm-every-time` | 整个 invocation 不读缓存 | 不允许 |

用户 `ShellRule` 在迁移期按当前语义编译：deny 规则作为本次调用的 locked deny；ask 不产生放行；allow 只有在没有 locked deny 或 `confirm-every-time` 时才可进入既有 auto-allow/缓存路径。旧 `trustedCommands` 只能转换为 exact decision-cache 候选，不能越过这两个缓存前阶段。

这需要对共享事实做最小、明确的加法修改：`PolicyAction` 增加 `confirm-every-time`；`CommandFact` 增加 `connectorFromPrevious: null | 'and' | 'or' | 'pipe' | 'sequence'` 和 `effectiveCwd?: string`，废弃语义错误的 `pipesInto`；`FactSignal` 增加上述 Shell 事实及 `shell-analysis-incomplete`。同步更新 `signalTokenSet`、规则覆盖校验、确认摘要、规范序列化、缓存读写和策略顺序测试。`Decision`、`ConfirmationChannel` 与 `CacheKey` 联合类型不做结构性变化。

### 5.5 执行前重验证与 TOCTOU 边界

“执行同一计划”只解决应用内部的二次解释，不等于冻结操作系统状态。生命周期明确区分：

- **语义不可重规划**：确认后不得重选 profile、重建 argv、重新解释原始 input 或修改冻结环境。
- **外部依赖必须复核**：确认后、产生副作用前同步调用 registration 私有的 `validatePreparedInvocation()`；它只判断计划是否仍有效，不得修补或重规划。

`PreparedShellExecution.dependencies` 至少记录：resolved executable 的绝对路径和平台可获得的文件身份；cwd 的 realpath/文件身份；计划时已解析的符号链接目标；Shell profile/config revision；冻结环境 allowlist 的规范摘要；policy/config revision；远程授权 generation。执行使用 `frozenEnv`，不得重新调用 Environment Resolver。若 executable、cwd/symlink、profile/env 等工具依赖变化，返回 `PLAN_STALE` 并重新 plan、重新决策；若 policy revision 或远程授权 generation 变化，使用同一 sealed facts 重新进入策略/授权，若计划依赖也变化则一并重新 plan。不得静默更新计划或沿用旧批准。

Shell 内部的变量展开、命令替换、运行时创建的路径以及并发文件替换无法被静态计划完全绑定。Analyzer 必须将其标为 partial/unknown 和 unresolved facts；策略据此逐次确认且禁止信任缓存。文档不承诺路径分析能消除 Shell 内部 TOCTOU，真正的资源隔离仍需独立沙箱能力。

### 5.6 取消、超时与错误域

调用级 `AbortController` 必须在 input parsing/planning 前创建，并贯穿 planning、confirmation、validation 和 execution；不能继续等确认完成后才注册取消。阶段错误应保持可区分：`TOOL_INPUT_INVALID`、`PLAN_FAILED`、`PLAN_TIMEOUT`、`PLAN_CANCELLED`、`CONFIRM_TIMEOUT`、`CONFIRM_REJECTED`、`PLAN_STALE`、`EXEC_TIMEOUT`、`EXEC_CANCELLED`、`EXEC_FAILED`。plan 超时或取消后不进入决策，确认超时/拒绝后不进入 validation，validation 失败后不进入 execute；所有路径都进入唯一 `settled` 终态并释放计划引用。计划阶段即便无业务副作用，也必须有 CPU/文件扫描预算和取消检查。

### 5.7 是否继续使用 Bash

建议保留 Bash 兼容能力，但不再把它当作跨平台统一协议：

- macOS 继续提供系统 Bash profile，但默认改为非登录模式。
- Windows 迁移后只使用系统内置 Windows PowerShell 5.1，通过 `-EncodedCommand` 执行带统一 UTF-8 prelude 的命令，并以进程级 `-ExecutionPolicy Bypass` 保证常见 `.ps1` CLI shim 可运行。不保留 cmd profile，也不把需要额外安装的 `pwsh`、Git Bash或 WSL 纳入本阶段支持范围。
- npm、git、构建、测试以及管道、重定向、条件执行等通用命令均走 `run_shell`，并按当前平台 dialect 生成；已有文件、搜索和飞书专用工具仍保持各自边界。

本方案明确不新增 `run_process`。它不能替代 `run_shell`，也不能消除后者必须解决的方言、组合命令分析、确认一致性、输出和进程树问题；同时会新增一套 Agent 工具选择规则、可执行文件解析、Windows `.cmd/.bat` shim、安全事实投影、信任与测试路径。当前项目没有代码或运行数据证明这份额外复杂度能够抵消维护成本，因此不纳入本次设计。未来若出现独立、可量化的需求，应作为单独方案评审，不能成为本方案完成的依赖或验收条件。

## 6. 分阶段优化方案

### Phase 0：建立事实基线（1 个迭代）

- 冻结并文档化现有 Bash/cmd 行为作为迁移基线，同时定义目标 Bash/Windows PowerShell 行为矩阵：引号、复合命令、变量、重定向、多行、命令替换、路径越界和信任规则。
- 盘点内置 tools、Skills、system prompt、外部协议适配器、权限键和审计字段中所有 `bash`/`run_shell` 名称，建立迁移清单；区分需要删除的内部别名与必须保留的外部协议兼容映射。
- 统计 `run_shell` 因方言错配失败和重复重试的基线数据，保留 Bash→cmd 作为旧版本问题样本；目标回归集只覆盖 Bash↔Windows PowerShell 误用，以及 cmd 语法进入 Windows PowerShell 的迁移提示。
- 修正 `shell-command-tool-requirement.md` 与当前实现的冲突，尤其是 multiline/substitution/redirection。
- 为所有已知线上问题建立最小复现和错误分类。
- 将 Shell 完整测试加入 Windows 与 macOS CI；至少跑 Shell 专项测试，不只跑 SQLite 探针。Linux runner 可保留为快速单元测试环境，但不计入产品平台验收。
- 加入资源基准：100MB 输出、每秒万行输出、超时派生孙进程、用户取消与超时竞态。

**Gate：** Windows 与 macOS 两个平台的基线结果可重复；每个问题有 case id；不再依赖口头描述“Windows 有问题”。

### Phase 1：先修可靠性 P0（1～2 个迭代）

- 输出改为 ring buffer + 增量文件流；进度节流；日志去完整输出。
- 增加统一 finalize，处理落盘失败和事件竞态。
- macOS 独立进程组 + TERM/KILL；Windows 补终止确认。
- 对 TUI/交互命令在执行前明确拒绝或要求外部终端，不只在卡片展示提示。
- 为 stdout/stderr/输出文件设置明确的字节和保留上限。

**Gate：** 高输出不导致内存线性增长；Windows 与 macOS 取消后均无存活测试孙进程；每次请求恰好一个终态。

### Phase 2：类型化跨平台适配（2 个迭代）

- 引入 `ShellProfile` 与 `ShellAdapter`；移除 basename 推断和隐式 `-lc`。
- 实现并验证 macOS Bash 与 Windows PowerShell 两种 profile；移除 cmd profile、cmd 参数模板和 cmd 专用执行分支。
- Windows 固定使用系统内置 `powershell.exe`，由 Adapter 生成 UTF-16LE Base64 的 `-EncodedCommand` 载荷并注入统一 UTF-8 输出 prelude；本阶段不自动探测或回退到 `pwsh`/cmd/Git Bash/WSL。找不到 `powershell.exe` 时返回明确的环境诊断错误，不静默切换方言。
- 对已有 Windows 自定义 Shell 配置执行显式迁移：能验证为 Windows PowerShell 5.1 的配置归一化到内置 profile；其他 executable 标记为不受支持并要求用户重新确认设置，不能继续携带旧 `argsPrefix` 执行。
- Agent 工具面统一只暴露 `run_shell`，移除内置 `bash` 别名及相关提示；必须兼容的外部 `Bash` 协议名称仅在边界适配层规范化为 `run_shell`。
- 权限、信任、审计、指标和重试状态全部使用规范化 `run_shell` tool id，防止兼容别名形成第二套策略或绕过既有授权。
- 从 profile snapshot 动态生成 `run_shell` 工具描述和 system capability block，替换当前静态、泛化的 Shell 提示。
- 增加高置信 dialect mismatch 预检与结构化纠错错误；连续同类错配触发重试熔断。
- 编码在 profile/启动期确定并锁定。
- Environment Resolver 统一 GUI/终端工具链发现，取消依靠登录 profile 补 PATH。
- 设置页显示当前 dialect、真实 executable、命令模板、环境诊断结果。

**Gate：** profile contract tests 在 Windows 与 macOS 执行；Windows 运行路径、Analyzer 和 Agent 提示中不存在 cmd 方言分支，实际 executable 为 `powershell.exe`；每轮 Agent 工具集中只有一个 Shell 字符串执行入口且名称为 `run_shell`；外部 `Bash` 名称能在边界正确映射，但内部执行计划、权限键与审计 tool id 均为 `run_shell`；Agent 可见的 dialect 与实际执行 dialect 始终一致；诊断能定位 executable/PATH/encoding/cwd 问题。

### Phase 3：通用可选计划生命周期接入既有确认闭环（2 个迭代）

#### 3A：通用工具调用协议

- 以 `kind: direct | planned` 和 `defineDirectTool/definePlannedTool` 注册工厂替换无判别的 `ToolExecutor` registry；泛型只在 registration 私有闭包内擦除，coordinator 不接触 `unknown` plan。
- 扩展工具注册合同：`execute()` 必选，`plan()` 可选；未实现 `plan()` 的工具保持现有路径，避免强制迁移。
- coordinator 独占 `plan → seal → gate/decide → confirm → validate → execute` 编排；Gate 不调用 plan，`decide()` 不获得工具注册表。
- 引入绑定 `invocationId/requestId/toolUseId/toolName` 的 sealed `PreparedInvocation`，对 plan/facts/display 做深度不可变和规范摘要，并实现一次性状态机。
- 在 planning 前创建调用级 AbortSignal；区分 plan/confirm/validate/execute 的超时、取消和错误码。计划失败不得降级为未计划执行。
- 为无计划工具、薄计划工具、完整计划工具分别增加框架合同测试，验证兼容路径和调用顺序。

#### 3B：`run_shell` 首个完整实现

- 合并 segment/path/rm/trust 的多份 tokenizer，按 dialect 生成模块私有的 `PreparedShellExecution`。
- Analyzer 只输出操作、真实连接符、路径、控制流、cwd 变化、解析置信度和未决项；删除 `verdict/denyType/requiresRiskAck/skipConfirm` 等判断字段。
- 在 `run_shell.plan()` 中完成 ShellProfile、spawnSpec、cwd、冻结环境、依赖快照和 timeout 的构建；确认通过后先做 stale-plan 重验证，再由 `run_shell.execute()` 消费私有 plan，不再读取原始输入或重新拼装参数。
- 方言不匹配、配置无效、无法启动的 executable、工具不支持的 TUI/后台模式归为执行能力/输入错误，在策略确认之前返回；这些错误不产生风险等级。

#### 3C：最小确认适配

- 增加 `ShellConfirmationAdapter`，把 `PreparedShellExecution` 投影为现有 `ContentFacts`，继续调用当前 `decide()`。
- 复用并修正 `command-sequence`：保留真实连接符和逐步 cwd，复合命令仍设置 `persistable=false`。
- 按 5.4 的完整映射增加 Shell FactSignal 和规则：强拒绝进入缓存前 `locked deny`；弱风险、路径风险和 partial/unknown 进入紧随其后的 `confirm-every-time`。这是本方案对 `PolicyAction` 和 `decide()` 顺序的唯一必要扩展。
- 增加 `InvocationPolicyConstraints/MemoryEligibility`，让同一次规则匹配结果统一约束缓存读取、记忆档位展示和确认结果写入；不得分别维护三套不可记忆判断。
- 对 `CommandFact` 最小增加真实 connector/effective cwd，更新 token、摘要、规范序列化与缓存测试。
- 迁移期由 Gate planned 分支中的唯一 `LegacyShellPolicyAdapter` 把 `ShellRule`/旧信任编译为 `decide()` 输入；不得直接返回 skip-confirm，也不得与 autoEvaluator 并存形成第二条放行路径。
- profile/dialect 隔离通过 namespaced command signature 落入既有 `shell-command exact` 缓存，不修改通用 `CacheKey` 联合类型。
- 确认请求使用 `gate.decision.riskLevel`，删除 `toolChatLoop.ts` 对 `run_shell='high'` 的重复硬编码；风险仍由现有 `BUILTIN_TOOL_METADATA + decide()` 所有。

**Gate：** 无 `plan()` 的现有工具行为不变；planned 工具严格按一次性状态机运行，篡改、复用、跨工具计划和 stale plan 均在 spawn 前失败；强 validator 在预置 allow cache/旧 trusted command 时仍 deny；`confirm-every-time` 在 cache/capability/auto-evaluator/ordinary allow 之前稳定返回无记忆确认；确认 UI、策略审计和执行审计关联同一 identity/digest；`PreparedShellExecution` 不含风险或授权判断；`evaluateToolCallGate()` 仍是唯一 invocation 决策入口；除新增 `PolicyAction` 及其缓存前求值阶段外，`Decision`、`ConfirmationChannel` 和 `CacheKey` 无结构性重写。

## 7. 测试与验收建议

### 7.1 必须新增的自动化测试

| 类别 | 最低覆盖 |
|---|---|
| Adapter contract | macOS Bash、Windows PowerShell 5.1 的 command 模板、cwd、退出码、空格/Unicode 路径；Windows 不得回退 cmd/pwsh |
| 工具命名合同 | Agent 工具集中只出现 `run_shell`；不得同时出现 `bash`；外部 `Bash` 映射后与原生 `run_shell` 共用权限、审计和执行路径 |
| Agent 工具合同 | 每种 profile 的动态 description/capability block；提示 dialect 必须与 PreparedShellExecution 一致 |
| 方言错配 | Bash↔Windows PowerShell、旧 cmd→Windows PowerShell 的预检、纠错提示和连续重试熔断 |
| 编码 | Windows PowerShell UTF-8 prelude、`-EncodedCommand` UTF-16LE Base64、Unicode/跨 chunk 多字节字符、stdout/stderr 混合；GBK/OEM 仅作为旧 cmd 迁移回归样本 |
| 进程树 | 子 Shell 派生孙进程；取消、超时、宿主终止后的清理 |
| 输出压力 | 100MB 连续输出、无换行输出、高频小 chunk、stdout+stderr 同时洪泛 |
| 竞态 | abort/timeout/exit 同时发生；spawn error 后不得二次 finalize |
| 通用注册合同 | direct/planned 判别注册；异构 registry 无 plan 类型断言；planned executor 不能接收原始 input；plan 失败不得降级 direct |
| 计划完整性 | 篡改 plan/facts/display、跨工具/跨调用复用、批准前/重复 execute 全部在副作用前失败；各审计事件 identity/digest 一致 |
| 计划状态机 | plan/confirm/validate/execute 分阶段取消和超时；任一路径恰好进入一次 settled 并释放 plan |
| stale plan | 确认期间替换 executable、cwd/symlink，修改 env/profile/config/policy revision，撤销远程授权；按合同重新决策或返回 `PLAN_STALE`，不得沿用旧批准 |
| 落盘 | 目录不可写、磁盘满模拟、达到文件上限、保留期清理 |
| 分析一致性 | quote/escape/变量/管道/重定向/多行/括号/注释 corpus |
| 职责边界 | Analyzer/PreparedShellExecution 只产出事实且不含 verdict/risk/confirm/trust 字段；执行器不能注入或覆盖安全结论 |
| 现有策略兼容 | prepared facts 经适配后仍走 `evaluateToolCallGate → decide`；现有强拒绝、弱确认、默认 high、缓存顺序、桌面/IM 确认结果行为等价 |
| 强制逐次确认 | incomplete/弱风险分别叠加预置 exact/path cache、execute capability、autoEvaluator approve、Legacy ShellRule allow、trustedCommands、普通 allow/askUnless 时均为 `require-confirm` 且 `memoryTiers=[]` |
| 决策优先级 | 同时命中 locked deny 与 `confirm-every-time` 时必须 deny；未命中强制确认的既有工具继续按原 cache/capability/auto-evaluator 顺序处理 |
| 记忆闭环 | 同一 facts 同时含 incomplete 与可派生 command/path signal 时整体不可读、不可展示、不可写；确认响应携带伪造 memory key 时缓存写入层拒绝并审计 |
| 确认执行一致性 | 确认等待前后的 plan/facts/display digest 不变；执行冻结 argv/env；执行器不二次解析 `inputObj + shellConfig`；外部依赖执行前复核 |
| 路径 | Windows drive/UNC/`..`/symlink；POSIX symlink、大小写边界 |
| 信任与强拒绝 | 每个现有强 validator 在预置 allow cache 和旧 trusted command 时仍 deny；弱风险、路径风险、复合及 partial/unknown 不能被任何自动放行来源跳过，也不产生或消费缓存；profile/dialect 进入 namespaced exact 签名 |
| 环境 | GUI PATH 缺失、nvm/fnm/Volta、locale、敏感变量不泄漏 |

### 7.2 CI 调整

当前 `.github/workflows/ci.yml` 的完整 `npm test` 只在 Ubuntu job 执行，Windows/macOS matrix 名为 SQLite Electron probe，实际只运行 `npm run probe:sqlite`。建议新增产品目标平台的 `shell-contract` matrix：

- `windows-latest`
- `macos-15-intel`
- `macos-latest`（arm64）

Ubuntu job 可以继续承担通用单元测试，但不作为 `run_shell` 产品平台验收。快速 PR gate 可在 Windows/macOS 只跑 Shell 专项与 typecheck；nightly 再跑两平台压力、孙进程回收和打包态 smoke test。

### 7.3 可量化验收指标

- 100MB 输出任务的主进程额外常驻内存不随输出量线性增长。
- progress IPC 频率不超过配置上限，renderer 不因输出洪泛明显掉帧。
- 取消/超时后，在测试观察窗内无目标子孙进程存活。
- Windows 与 macOS 同类命令的 `status/exitCode/stdout/stderr` 结果合同一致；命令文本本身分别遵循 PowerShell 与 Bash 方言。
- Windows 目标测试和生产执行中 `cmd.exe`/`pwsh` 回退次数为 0；所有 Windows `run_shell` 结果报告 `dialect=windows-powershell` 与实际 `powershell.exe`。
- Agent 工具定义中 `bash` 内部别名出现次数为 0，单轮 Shell 字符串执行入口数量始终为 1；兼容入口产生的执行记录中规范化 tool id 为 `run_shell` 的比例为 100%。
- 终态重复率为 0，执行请求悬挂率为 0。
- 新写入的 Shell 命令信任均使用带 profile/dialect namespace 的现有 exact 签名；复杂命令记忆档位数量与信任命中率均为 0；旧签名未迁移时按 fail-safe 重新确认。
- Shell 输出日志不包含完整 stdout/stderr，只包含受控摘要。

## 8. 建议的优先级清单

| 优先级 | 项目 | 原因 |
|---|---|---|
| P0 | 输出有界化与进度节流 | 直接影响主进程稳定性 |
| P0 | macOS 真正的进程树回收与终态 deadline | 超时/取消后仍可能持续产生副作用 |
| P0 | Windows/macOS Shell CI | 没有目标平台验证就无法稳定优化跨平台问题 |
| P0 | 修正文档与安全承诺漂移 | 当前需求与代码对关键 hard-deny 行为相互矛盾 |
| P0 | ShellProfile 类型化并将 Windows 收敛到 PowerShell | 替换当前 cmd 默认路径，删除 Windows 双方言维护成本并阻止自定义配置重新引入未知方言 |
| P0 | Agent 工具面统一为唯一 `run_shell` 入口 | 消除“工具叫 Bash、实际方言不一致”的错误心智模型，并避免别名造成权限与审计分裂 |
| P0 | Agent 工具提示动态绑定真实 dialect | 直接减少 Bash 与 Windows PowerShell 语法混用和无效重试循环 |
| P1 | 通用 direct/planned 注册与一次性调用状态机 | 给可选 plan/必选 execute 提供类型安全、不可错用且可取消的框架合同 |
| P1 | `confirm-every-time` 与统一 MemoryEligibility | 保证不完整/弱风险事实不能被缓存、capability、auto-evaluator、普通 allow 或伪造记忆写入绕过 |
| P1 | 统一 Analyzer、sealed PreparedInvocation 与执行前重验证 | 消除应用内语义漂移，并在确认后识别已变化的外部依赖 |
| P1 | ShellConfirmationAdapter 等价接入现有 policy gate | 让事实与风险判断分工清晰，不重写 decide/确认通道/远程授权 |
| P1 | 固定编码策略与 Environment Resolver | 降低 Windows 乱码和 GUI PATH 问题 |
| P1 | 默认取消 login shell | 提升可复现性、降低 profile 副作用 |
| P1 | 结构化错误与结果合同 | 提升诊断、UI 和自动恢复能力 |
| P2 | Windows Job Object | 加强宿主异常退出时的进程回收 |

## 9. 本次验证记录

执行命令：

```bash
npx vitest run electron/tools/runShellExecutor.test.ts electron/shell/shellExecPlan.test.ts electron/shell/shellSecurity.test.ts electron/spawnUtil.test.ts electron/toolInputGuards.test.ts
```

结果：5 个测试文件通过，83 个用例通过，耗时约 4.5 秒。

该结果说明当前本机基础用例正常，但不能反证上述问题：已有执行测试大多是短命令和小输出；Windows 分支通过 `process.platform` 条件执行；Unix `killProcessTree` 测试只验证直接子进程，没有验证孙进程；CI 又没有在 Windows/macOS 运行完整测试。

## 10. 最终建议

不建议继续用零散条件分支修补 `run_shell`。最稳妥的顺序是：

1. 先把输出、IPC 和进程树生命周期做成有界、可收敛的基础设施；
2. 再把 Shell 配置升级为有 dialect 的类型化 profile，并补齐 Windows/macOS 两平台 CI；
3. 随后先建立通用 direct/planned 注册、sealed invocation、一次性状态机和 `plan → gate/decide → confirm → validate → execute` 编排，再由 `run_shell` 作为首个完整 planned 工具接入；
4. 最后按现有 validator 逐项迁移事实与规则，确保强拒绝位于缓存前；确认通过后先复核易变依赖，再执行同一份私有计划。

完成前两步即可显著降低当前“运行不稳、取消不干净、Windows/macOS 行为飘”的问题；完成通用生命周期与 Shell 接入后，才能让唯一的 `run_shell` 能力成为后续 Background Mission、Builtin SubAgent 等场景可复用的 HostTerminalService，而不是通过新增第二个进程工具绕开现有缺陷。
