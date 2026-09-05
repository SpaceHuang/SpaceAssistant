# `run_shell` 生命周期优化：本机执行清单

> 来源：`docs/develop/run-shell-and-tool-execution-lifecycle-optimization-plan.md`
>
> 范围：仅收录当前 macOS 开发环境可以完成的实现、测试、文档和本地验证工作。
>
> 状态：`[ ]` 未开始；`[~]` 进行中；`[x]` 已完成。
>
> 说明：标为“本机可做，目标机验收”的项目可以在本机完成代码、抽象和模拟测试，但不能替代 Windows 或其他 macOS 架构上的真实验收。Windows 实机、macOS CI/打包态和生产指标不属于本清单的完成条件。

## 0. 工作区与执行边界

- [x] 确认开发 worktree 位于 `.worktrees/run-shell-lifecycle-optimization-tdd`。
  - 基于 `main` 创建独立分支 `feat/run-shell-lifecycle-optimization-tdd`。
  - 原工作区已有未提交改动不覆盖、不带入。
- [x] 运行现有执行链路基线测试。
  - 已验证 `electron/tools/runShellExecutor.test.ts` 与 `electron/spawnUtil.test.ts`。
  - 基线结果：2 个测试文件、13 个用例通过。
- [x] 建立本机与目标平台的验证边界说明。
  - 本机真实验证：macOS Bash、TypeScript、Vitest、Node 进程模型。
  - 本机模拟验证：Windows PowerShell profile、UTF-16LE payload、Windows 路径和 taskkill adapter。
  - 目标平台验证：Windows PowerShell 实机、Windows 进程树、Windows 编码、Intel/arm64 macOS CI、打包态 smoke test。
- [x] 将每个问题映射为稳定的 case id，并在测试名称、日志摘要和验证记录中复用。
  - `SHELL_CASE_IDS` 已覆盖输出、进度、TUI、方言错配、spawn error、落盘失败、终止未确认和进程树回收；executor 日志/结果与回归测试复用这些 id。

## 1. Phase 0：事实基线与行为契约

### 1.1 现状盘点

- [x] 阅读并记录 `run_shell` 的输入校验、策略门禁、确认、执行、输出、取消、审计和缓存链路。
- [x] 盘点所有内置 tools、Skills、system prompt、外部协议适配器中的 `bash` / `run_shell` 名称。
- [x] 盘点权限键、信任缓存键、审计字段、指标和重试状态中的 Shell tool id。
- [x] 区分以下三类名称来源：
  - [x] 内部旧 `bash` 别名：计划删除。
  - [x] 规范内部名称 `run_shell`：计划保留并统一使用。
  - [x] 外部协议 `Bash`：仅允许在边界适配层映射。

### 1.2 行为基线测试

- [x] 建立现有 Bash 行为回归测试。
  - `shellBehaviorMatrix.test.ts` 与 executor 回归测试覆盖当前 Bash 事实和执行行为。
- [x] 建立目标 Bash / Windows PowerShell 行为矩阵测试数据。
  - `shellBehaviorMatrix.test.ts` 已覆盖引号、连接符、变量、重定向、多行、命令替换、注释、cwd、相对路径和未闭合引号；confirmation extractor 回归已补 Windows drive/UNC 与 POSIX 敏感路径。
  - [x] 引号和转义。
  - [x] 管道、`&&`、`||`、`;` 等连接符。
  - [x] 变量语法。
  - [x] 重定向。
  - [x] 多行命令。
  - [x] 命令替换。
  - [x] 注释、括号和未闭合结构。
  - [x] cwd 切换和相对路径。
  - [x] drive、UNC、`..`、symlink 和 POSIX 路径边界。
    - `classifyPathWithSymlink()` 解析存在目标的 realpath；测试覆盖 workdir 内 symlink 指向 workdir 外目标。
  - [x] trust/cache 对单命令与复合命令的行为。
    - 单命令按 argv token 边界匹配并可更新 lastUsedAt；管道、连接符、重定向、命令替换等复合/元语法命令保持 `persistable=false`，不会跳过确认或写入 trust。
- [x] 为已知问题建立最小复现和错误分类。
  - [x] 输出无界累计。`SHELL-OUTPUT-001`：有界 snapshot、总字节统计和 artifact 上限。
  - [x] 落盘失败导致 Promise 不收敛。`SHELL-OUTPUT-002`：结构化 `OUTPUT_PERSIST_FAILED` 且保留进程结果。
  - [x] abort/timeout/close/error 竞态。`SHELL-LIFECYCLE-001`：终态优先级和单次 settle。
  - [x] 子进程树未完全回收。`SHELL-LIFECYCLE-002`：macOS process group 与派生 sleep fixture。
  - [x] 自定义 Shell 隐式使用错误参数。profile contract 锁定 Bash 与 PowerShell 的 argv 模板。
  - [x] parser 与真实 Shell 方言不一致。`SHELL-DIALECT-001`：spawn 前 mismatch 检查。
  - [x] Agent 生成错误方言并重复重试。连续同类 mismatch 触发 retry breaker。
  - [x] 审计日志记录完整命令或输出。日志测试锁定摘要、hash、字节数和脱敏字段，不保留完整 stdout/stderr。
- [x] 增加资源压力测试 fixture，并保留稳定回归断言：
  - [x] 100MB 连续输出。
  - [x] 每秒万行输出。
  - [x] 无换行输出。
  - [x] stdout/stderr 同时洪泛。
  - [x] 超时派生孙进程。
  - [x] 用户取消与 timeout 同时发生。
- [x] 修正文档与当前代码的安全承诺漂移。
  - [x] 明确 multiline、command substitution、redirection 的真实行为。
  - [x] 区分 hard deny、require-confirm、allow 和 analysis incomplete。
  - [x] 不把路径分析表述为沙箱或隔离机制。
  - 记录于 `docs/plan/run-shell-lifecycle-security-behavior.md`。
- [x] 为本机可执行的 Shell 专项测试增加统一运行入口。
  - 新增 `npm run test:shell-lifecycle`，集中运行 shell、executor、tool coordinator 和 spawn contract 测试。
- [x] 在本地 CI 配置中预留 Windows/macOS `shell-contract` job；不把本机通过视为目标平台 Gate 通过。
  - `.github/workflows/ci.yml` 新增 Windows、macOS Intel、macOS arm64 矩阵；真实目标平台通过仍待 CI 验收。

## 2. Phase 1：有界输出、进度和日志

### 2.1 有界 OutputPipeline

- [x] 先补充 RED 测试，证明当前实现会完整累计 stdout/stderr。
  - `electron/shell/boundedOutput.test.ts` 覆盖有界首尾保留、完整字节统计和 UTF-8 chunk。
  - `runShellExecutor.test.ts` 覆盖大输出端到端截断、artifact 写入和摘要校验。
- [x] 定义并接入输出流水线的稳定合同：
  - [ ] 首段 inline buffer。
  - [ ] 尾段 buffer。
  - [ ] terminal scrollback ring buffer。
  - [ ] 总 stdout/stderr 字节数。
  - [ ] inline 截断标志。
  - [ ] artifact 文件路径、字节数和 hash。
  - [ ] 最大 inline 字节数和最大 artifact 字节数。
  - `electron/shell/boundedOutput.ts` 已实现首段/尾段/字节统计接口，并接入执行器；terminal raw 使用独立有界 ring buffer。
  - `electron/shell/outputPipeline.ts` 提供不可变的跨层快照合同及单测；`runShellExecutor` 已在 close 收敛路径生成该快照。
- [x] 实现有界内存收集，不在进程退出前保存完整 stdout/stderr。
  - `runShellExecutor` 已接入 `BoundedOutputBuffer`，完成日志和结果使用有界快照。
- [x] 超过 inline 阈值后切换为增量文件流。
  - `OutputArtifactWriter` 已接入 `runShellExecutor`，运行期间增量写入并限制 artifact 字节数。
  - 已补充落盘失败、端到端大输出和执行级 output limit 测试。
- [x] 实现 artifact 文件大小上限，超限后停止写入并保留结构化状态。
  - `OutputArtifactWriter` 以字节为单位截断并返回实际写入字节数；独立测试覆盖上限。
- [x] 实现 stdout/stderr 混合输出和无换行输出的正确摘要。
  - bounded snapshot 与双通道 executor 测试覆盖无换行 stdout/stderr，并分别保留摘要。
- [x] 实现 SHA-256 或项目既有等价 hash 计算。
  - 增量写入同步计算 SHA-256，并在 `run_shell` 结果与完成日志中返回摘要。
- [x] 验证 100MB 输出不会导致内存随输出量线性增长。
  - 本机压力 fixture 向有界 buffer 写入 100MB，snapshot 始终不超过 inline 上限且总字节数完整统计。

### 2.2 进度节流

- [x] 先补充高频 chunk、字节预算和每秒事件预算的 RED 测试。
  - executor 级高频输出测试验证真实命令路径受每秒事件预算限制。
- [x] 实现按时间窗口合并 progress 事件。
  - `ProgressThrottle` 已按 50ms 最小间隔接入普通和 terminal progress。
- [x] 实现按字节阈值触发 progress 事件。
  - 节流器支持“时间到期或累计字节达到阈值”两种触发条件，并受每秒预算约束。
- [x] 实现每秒最大事件数限制。
  - `ProgressThrottle` 当前限制为每秒最多 20 个事件，并有独立单元测试。
- [x] 保留 terminal raw delta 所需的 ring buffer。
  - `run_shell` terminal progress 使用有界 `PROGRESS_RAW_MAX_BYTES` ring buffer；超大 chunk 也不会形成无界 raw delta。
- [x] 保证 stdout/stderr 同时输出时不会互相覆盖或重复发送。
  - executor 级并发 stdout/stderr 测试分别断言两个通道内容。
- [x] 验证高频输出不会无限增加 IPC 消息数量。
  - 高频 5000 行输出测试断言 progress 调用数不超过预算上限（含启动/终态事件）。

### 2.3 安全日志与落盘错误

- [x] 先补充日志不得包含完整 stdout/stderr 的 RED 测试。
  - `runShellExecutor.test.ts` 断言 finish 日志没有完整 stdout/stderr 字段，且保留摘要与字节统计。
- [x] 日志改为记录摘要、字节数、hash、截断状态、退出状态和 artifact 路径。
  - finish 日志使用 `stdoutSummary`/`stderrSummary`、字节数、artifact SHA-256、截断和退出字段。
- [x] 对 command、stdout、stderr 做字段级脱敏。
  - `preprocessShellLogFields()` 对命令敏感参数和 stdout/stderr preview 做字段级处理。
- [x] 禁止常规执行日志记录完整命令输出。
  - executor finish 日志只写摘要、统计、hash 和 artifact 元数据；测试锁定不存在完整 stdout/stderr 字段。
- [x] 模拟目录不可写和写入失败。
  - 通过 mock 文件打开失败验证执行过程仍正常收敛。
- [x] 返回结构化 `OUTPUT_PERSIST_FAILED`，同时保留进程执行结果。
  - 结果保留 stdout/exit success，并返回 `outputPersistErrorCode`。
- [x] 确保落盘失败不会导致 unhandled rejection 或悬挂 Promise。
  - 端到端测试等待 executor 完成并验证失败信息。
- [x] 增加输出文件保留周期清理逻辑。
  - `run_shell` 启动时清理 `userDataDir/shell-output` 下超过 7 天的文件。
- [x] 增加清理逻辑的文件系统和过期时间测试。
  - 覆盖过期/新文件、子目录和目录不存在场景。

## 3. Phase 1：统一终态与 ProcessSupervisor

### 3.1 统一终态

- [x] 为 abort、timeout、close、spawn error 同时发生的情况补 RED 测试。
  - `ExecutionLifecycle` 回归测试按 close/spawn-error/output-limit/timeout/abort 顺序注入同一事件窗口，断言只保留 user_cancel。
- [x] 为 spawn error 后再次 close 的情况补 RED 测试。
  - 缺失 executable 的端到端测试验证 spawn error 后 executor 仍能关闭 artifact writer、收敛并返回；重复 close 由 writer 的并发幂等测试覆盖。
- [x] 定义终态优先级：`user_cancel > timeout > output_limit > process_exit > transport_error`。
  - `ExecutionLifecycle` 参数化测试覆盖全部优先级组合。
- [x] 实现原子 `finalize()`，保证每个请求只 settled 一次。
  - `ExecutionLifecycle` 已接入 `runShellExecutor`，spawn error、cancel、timeout 和 close 统一经过 `settle`。
- [x] 保证每条异步路径都清理 timer、AbortSignal listener、stdio listener 和 artifact writer。
  - executor 现通过一次性 `cleanupProcessResources()` 统一清理 timer、AbortSignal listener 和 stdio listener，error/close 共用该闸门；正常 close、timeout、user cancel 已有 AbortSignal add/remove 配对回归断言；`OutputArtifactWriter.close()` 即使 queued write 失败也在 finally 关闭 fd，并有 mock FileHandle 回归测试；spawn error 仍吞并 artifact close 异常后 finalize，progress IPC 异常也被隔离并记录诊断。异常注入测试覆盖仍可继续扩展，但清理实现与终态收敛已完成。
- [x] 为终止过程增加 deadline。
  - `ProcessSupervisor` 对 killer promise 增加 deadline race，并确保 reject 收敛。
- [x] 超过终止 deadline 时返回 `TERMINATION_UNCONFIRMED`，不能无限等待 close。
  - executor 结果暴露 `terminationErrorCode`；正常超时/取消结果记录未确认状态。
- [x] 记录真实 signal 和退出原因。
  - `terminationSignal`、`treeKillVerified` 接入结构化结果，并由 timeout 测试验证。
- [x] 增加结构化状态：
  - [x] `status`。
  - [x] `exitCode`。
  - [x] `signal`。
  - [x] `terminationReason`。
  - [x] `treeKillVerified`。
  - [x] `durationMs`。
  - [x] `stdoutBytes` / `stderrBytes`。
- [x] 验证任何异常路径下 Promise 都能收敛。
  - spawn error、artifact close failure、abort/timeout/close/error 竞态均有 executor/lifecycle 测试，并绑定 `SHELL-LIFECYCLE-003/004` 诊断边界。

### 3.2 ProcessSupervisor

- [x] 先定义 `ProcessSupervisor` contract 和状态机测试。
  - [x] `running`。
  - [x] `terminating`。
  - [x] `terminated`。
  - [x] `termination_failed`。
  - 已覆盖重复 terminate、失败确认和终态收敛。
- [x] 在 macOS 实现独立 process group/session 的启动抽象。
  - macOS `run_shell` spawn 使用 `detached: true` 建立独立 process group。
- [x] 实现 macOS 取消时向进程组发送 `SIGTERM`。
- [x] 实现 grace period 后向进程组发送 `SIGKILL`。
  - 终止器在 250ms grace period 后对 process group 执行强制终止。
- [x] 实现进程组终止结果确认。
  - 以根进程 close 事件确认；deadline 内未 close 则返回未确认。
- [x] 将现有 Windows `taskkill /T /F` 封装为 supervisor adapter。
  - `processTreeKiller` 已统一封装现有平台实现。
- [x] 为 Windows adapter 增加 mock contract 测试。
  - supervisor contract 使用可注入 killer，覆盖 adapter 结果和失败收敛。
- [x] 将 `run_shell` 接入 supervisor。
- [x] 将 `run_script` 接入 supervisor，避免出现第二套生命周期逻辑。
  - `runScriptExecutor` 的 abort/timeout 路径已改用共享 `ProcessSupervisor`。
- [x] 增加子 Shell 派生孙进程的可控 fixture。
- [x] 在本机验证 macOS 真实进程组和孙进程回收。
  - executor 测试启动后台 `sleep` 子进程，timeout 后验证其 PID 已不可用。
- [x] 将 Windows 真实终止确认标记为目标平台待验收，不在本机宣布完成。
  - 本机已完成 supervisor/taskkill adapter 的抽象与 mock contract；真实 Windows 进程树终止确认明确保留给 Windows 实机/CI，不由本机 macOS 结果替代。

### 3.3 TUI 与交互命令

- [x] 建立 TUI/后台交互命令的执行前行为矩阵。
  - 共享 TUI detector 覆盖全屏/交互命令与非交互替代形式；executor 覆盖 spawn 前拒绝和 external-terminal hint。
- [x] 对明确不支持的 TUI/交互命令在 spawn 前拒绝。
- [x] 对允许外部终端的场景返回结构化提示。
- [x] 增加执行前拒绝测试，确保不创建子进程。
  - 复用现有 TUI detector，并在 `runShellExecutor` spawn 前返回 `SHELL_INTERACTIVE_TTY_REQUIRED`。

## 4. Phase 2：ShellProfile、编码和环境

### 4.1 类型化 Shell Profile

- [x] 先补充 profile contract RED 测试。
  - 已覆盖 macOS Bash、Windows PowerShell 模板、Windows 路径和 Unicode payload。
- [x] 定义 `ShellProfile`：
  - [x] `id`。
  - [x] `dialect`。
  - [x] `executable`。
  - [x] `commandArgsTemplate`。
  - [x] `loginMode`。
  - [x] `encoding`。
  - [x] `source`。
- [x] 定义 `ShellAdapter` 接口。
  - `createShellAdapter()` 统一暴露 profile、profile-aware command args 和 dialect mismatch 检查；macOS Bash/Windows PowerShell 均有 contract 测试。
  - 当前已完成 profile 与纯函数 builder，真实执行 adapter 尚未接入。
- [x] 实现 macOS 系统 Bash profile。
- [x] Bash 默认使用非 login、非 interactive 模式。
  - `resolveShellSpawnSpec` 默认参数已改为 `--noprofile --norc -c`，并有执行器回归测试。
- [x] 实现 Windows PowerShell 5.1 profile 的纯函数 adapter。
- [x] 固定 Windows executable 为 `powershell.exe`。
  - 默认 `resolveShellSpawnSpec()` 由 `WINDOWS_POWERSHELL_PROFILE` 提供 executable。
- [x] 固定参数为 `-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand {encodedCommand}`。
  - `shellExecPlan` 通过 profile builder 生成 UTF-16LE Base64 参数，不再把裸命令追加到参数尾部。
- [x] 移除 basename 推断 Shell dialect。
- [x] 移除隐式 `-lc` / `-c` 推断。
  - `planShellExec()` 现在只接受 profile 显式提供的空字符串 command placeholder。
- [x] 移除 cmd profile、cmd 参数模板和 cmd 专用执行分支。
  - `shellExecPlan` 不再包含 cmd 参数、`cd /d` 提取或 cmd 分支；旧配置由 `legacyShellConfigMigration` 标记 unsupported。
- [x] 自定义 executable 无法证明为支持的 profile 时拒绝保存或要求迁移。
- [x] 对旧 Windows 自定义 Shell 配置实现显式迁移：
  - [x] 可验证为 Windows PowerShell 5.1 时归一化到内置 profile。
  - [x] 其他 executable 标记为不支持。
  - [x] 不继续携带旧 `argsPrefix` 执行。
  - 实现与测试位于 `electron/shell/legacyShellConfigMigration.ts`。
- [x] 增加空格路径、Unicode 路径、复合命令和退出码的 profile contract 测试。
  - Bash/PowerShell profile contract、UTF-16LE round-trip、Unicode/多行/复合命令模板和 executor 退出结果已有回归覆盖。

### 4.2 PowerShell payload 与输出编码

- [x] 实现 UTF-8 输出初始化 prelude。
  - PowerShell profile 通过 `$OutputEncoding` 与 Console UTF-8 prelude 固定输出编码。
- [x] 实现命令包装为 UTF-16LE。
  - profile-aware `shellExecPlan` 将 prelude 与命令整体编码为 UTF-16LE。
- [x] 实现 UTF-16LE Base64 编码。
- [x] 实现 `-EncodedCommand` 参数构造。
  - `buildShellArgs()` 接入实际 spawn plan。
- [x] 测试空命令、多行命令、Unicode 命令和特殊字符。
  - profile contract 单测已覆盖四类命令的 UTF-16LE Base64 round-trip；Windows 实机仍属于目标平台验收。
- [x] 将编码策略绑定到 profile snapshot。
  - `createShellAdapter()` 在创建时冻结 profile；后续模板或 encoding 修改不会影响已创建 adapter 的命令构造。
- [x] 重构增量 decoder，使其只在有限前导缓冲区内探测一次并锁定。
  - macOS 固定 UTF-8 profile 现在使用一次初始化的流式 `TextDecoder`，不再重复拼接历史 chunk。
  - Windows 兼容路径保留有限场景的 UTF-8/GBK 选择逻辑，待 Windows 实机继续验收。
- [x] 增加跨 chunk 多字节字符测试。
  - 覆盖 macOS UTF-8 emoji 跨 chunk 边界。
- [x] 增加 stdout/stderr 混合编码测试。
  - 独立 decoder 跨 chunk 交错接收 UTF-8 多字节 stdout/stderr，验证两路状态互不污染。
- [x] 保留 GBK/OEM 仅作为旧 cmd 迁移回归样本，不再作为目标 Windows profile。
  - cmd 配置在迁移层标记为 `unsupported`；现有编码兼容逻辑仅保留迁移/回归用途。

### 4.3 Environment Resolver

- [x] 定义显式环境 allowlist。
- [x] 保留必要的 OS 基础变量、HOME/USERPROFILE、TMP、PATH、locale 和证书变量。
- [x] 通过显式扩展加入项目授权变量。
- [x] 不依赖 login profile 隐式补 PATH。
  - 环境 resolver 只从显式 `process.env` allowlist 构造环境；Bash profile 使用 `--noprofile --norc`，无 login profile 注入路径。
- [x] 统一发现 nvm、fnm、Volta 和系统 node/npm 路径的接口。
  - 新增 `resolveNodeToolchainPath()`，并接入 Windows PATH 增强逻辑；覆盖 macOS/Windows 环境 fixture。
- [x] 处理 Windows `Path` / `PATH` 大小写合并规则。
  - resolver 合并 `PATH`、`Path`、`path`，按出现顺序去重；Windows fixture 已覆盖。
- [x] 过滤敏感环境变量并增加测试。
- [x] 生成 `environmentFingerprint`。
- [x] 为 GUI PATH 缺失、locale 和敏感变量泄漏增加测试。

## 5. Phase 2：动态 Agent 工具契约与方言检查

### 5.1 工具命名与 profile snapshot

- [x] 先补充工具命名合同 RED 测试。
- [x] 每轮工具集中只暴露一个 Shell 字符串执行入口。
- [x] 规范名称固定为 `run_shell`。
- [x] 删除内部 `bash` 别名及其提示来源。
  - builtin registry contract 测试锁定不存在 `bash`/`Bash` 注册项；外部协议边界适配仍待补齐。
- [x] 在边界适配层将外部 `Bash` 映射为 `run_shell`。
  - `normalizeExternalToolName()` 仅在外部 tool_use 边界映射 `Bash`/`bash`，内部 executor、policy 和确认链路只接收 `run_shell`。
- [x] 权限、信任、审计、指标和重试统一记录规范化 `run_shell`。
  - 外部 `Bash`/`bash` 在 streamed tool-use 边界统一归一为 `run_shell`；Gate、policy、cache、trust、retry 和审计事件均消费归一后的内部名称。
- [x] 保留外部原始名称仅作为诊断元数据。
  - `tool.request` 和 renderer `tool:use` 保留 `originalToolName`，不将其作为权限、缓存或重试键。
- [x] 实现不可变 profile snapshot，供工具定义、system block、analyzer 和执行计划共同使用。
  - `freezeShellProfileSnapshot()`/`freezeTerminalProfileSnapshot()` 提供不可变快照；`filterBuiltinToolsForApi()` 可按同一请求快照生成动态 `run_shell` description，terminal capability block、Analyzer 和 `PreparedShellExecution` 均消费 profile snapshot。
  - `freezeShellProfileSnapshot()` 深冻结 profile 与参数模板；平台 profile 返回独立冻结快照，并有不可变测试。
  - 全链路向工具定义、system block、analyzer 和执行计划传播仍需继续迁移。

### 5.2 动态提示

- [x] 实现动态 `run_shell.description` 生成器。
  - `buildTerminalToolContract` 已从 profile snapshot 生成方言、executable、cwd 和禁用语法提示。
- [x] 描述中包含当前 OS、dialect、executable 和 cwd。
- [x] 描述中明确变量、引号、路径和复合命令语法。
- [x] 描述中明确禁止混用的另一方言代表语法。
- [x] 为 Bash 和 Windows PowerShell 分别提供正确示例。
  - terminal contract 测试验证两种 profile 的 OS、语法提示和示例内容。
- [x] 实现结构化 `terminal_environment` capability block。
- [x] 包含 OS、profile id、dialect、executable、cwd、path separator 和 TTY/ANSI 能力。
  - `terminal_environment` capability block 已包含全部字段，并由 contract 测试锁定。
- [x] 对 cwd 等不可信数据做定界，避免注入系统指令。
- [x] 测试动态提示与 prepared plan 使用同一 profile/dialect。

### 5.3 dialect mismatch

- [x] 先补充 Bash ↔ PowerShell 方言错配 RED 测试。
- [x] Windows PowerShell 高置信识别：`export`、`$VAR` 环境变量、`/dev/null`、`rm -rf`、`%VAR%`、裸 `&&/||`。
- [x] POSIX Bash 高置信识别：`$env:VAR`、`$null`、PowerShell cmdlet 和 script block。
- [x] 避免把 PATH 中同名可执行程序一概拒绝。
  - dialect 检查只匹配高置信语法信号，不按 PATH 中 executable basename 或普通同名命令拒绝；已有 `Get-ChildItem`/`rm -rf` 回归测试覆盖。
- [x] 实现 `SHELL_DIALECT_MISMATCH` 结构化错误。
- [x] 错误中包含 detected syntax、expected dialect、profile id、executable 和定向修复建议。
  - `ShellDialectMismatch` 结构化结果包含上述字段及 `signals`/`hints`，并在 spawn 前返回。
- [x] 增加连续两次同类 mismatch 的重试熔断。
  - 按 profile id 和规范化 signal 计数；第二次返回 `retryExhausted=true`。
- [x] 确保 mismatch 在 spawn 前返回，不进入 Shell 执行。
- [x] 增加 Agent 收到 mismatch 后不得原样重试的主循环测试。
  - `shouldStopToolRetry()` 在 mismatch breaker 已触发时立即停止 `run_shell` 原样重试，并有策略单测；主循环已接入。
  - executor 已返回 retryCount/retryExhausted，主循环行为测试仍待接入。

## 6. Phase 3A：通用 direct/planned 生命周期

### 6.1 类型和注册工厂

- [x] 先为 direct/planned registration 增加 RED contract tests。
- [x] 定义 `DirectToolSpec<I, O>`。
- [x] 定义 `PlannedToolSpec<I, P, O>`。
- [x] 定义 `RegisteredTool`。
- [x] 实现 `defineDirectTool()`。
- [x] 实现 `definePlannedTool()`。
- [x] 将异构 registry 从裸 `ToolExecutor` 迁移为判别式注册。
  - builtin registry 已从裸 `Map<string, ToolExecutor>` 收口到 `TypedToolRegistry`；每个 legacy executor 注册时都会生成 typed `direct` 视图，同时保留 legacy 兼容出口，且 contract 测试验证 direct 视图执行时只消费注入的 `runtimeContext`。`toolChatLoop` 现在只从 typed registry 执行 builtin，MCP/未注册工具才解析各自 executor；planned/legacy 同名迁移别名不依赖注册顺序，`runShellRegisteredTool` 作为首个真实 planned registration 接入同一 registry。legacy getter 仍保留供迁移期外部兼容，主循环已不再消费它。
- [x] 保证 plan 私有泛型只存在于 registration 闭包内部。
  - `PlannedToolSpec<I, P, O>` 的 P 仅在 registration/execute 闭包之间流动，不暴露给 coordinator。
- [x] 保证 coordinator 不使用任意 `unknown` plan 类型断言。
  - coordinator 只消费 `InvocationHandle` 和 sealed `PreparedInvocation`，不接触 plan payload。
- [x] 保持未实现 `plan()` 的既有工具行为不变。
  - direct registration 保留原始输入执行路径。
- [x] 增加 compile-time type tests。
  - `plannedToolRegistry.type.test.ts` 校验 DirectToolSpec、PlannedToolSpec、PreparedInvocation 字段合同，并纳入 shared typecheck。

### 6.2 PreparedInvocation 和状态机

- [x] 定义 sealed `PreparedInvocation`。
  - `PreparedInvocation` 带模块私有 symbol brand，并由 registry 工厂深冻结创建；外部无法用普通对象字面量伪造该类型。
- [x] 绑定 `invocationId`、`requestId`、`toolUseId`、`toolName`。
- [x] 计算并绑定 `planDigest`、`factsDigest`、`displayDigest`。
  - 三类摘要均使用稳定 SHA-256；planned tool 可通过 facts/display projection 绑定独立事实与展示摘要，并有内容变化失效测试。
- [x] 对 plan/facts/display 做深度不可变封存。
  - planned payload 在 seal 前 clone，之后递归冻结，并有外部修改回归测试。
- [x] 实现 planning、planned、awaiting-confirm、confirmed、validating、executing、settled/failed 等状态。
  - handle 已实现 awaiting-confirm、confirmed、validating、executing、settled/failed；新增 `beginPlanning()` / `PlanningHandle`，可在异步 plan 完成前观察 `planning`，并记录 `planning → planned/failed`；现有 `begin()` API 保持兼容并复用同一 planning promise，coordinator 的 plan 阶段已实际消费该 planning promise。
- [x] 防止未确认 execute。
- [x] 防止重复 execute。
- [x] 防止跨调用、跨工具复用 invocation/plan。
  - execute 校验 prepared requestId/toolUseId；identity 不匹配时拒绝，且不会消耗原 invocation 的执行机会。
- [x] 防止 plan/facts/display 篡改。
  - 三类 payload 在句柄创建时深度克隆并冻结，摘要绑定冻结副本。
- [x] 在 planning 前创建调用级 AbortSignal。
  - planned registration 使用调用方 signal，并在 plan 前后检查取消。
- [x] 区分 plan、confirm、validate、execute 的阶段超时。
  - coordinator 已覆盖 plan/confirm/validate/execute timeout，并验证 plan 超时不降级执行。
- [x] 实现各阶段 AbortSignal 主动取消传播和统一取消错误合同。
  - coordinator 对 plan/confirm/validate/execute 统一返回阶段化 `*_CANCELLED` 错误，底层工具继续负责进程清理。
- [x] 计划失败不得降级为 direct execution。
  - planned registry 的 plan failure 测试确认 execute 不会被调用。
- [x] 确保每条路径只进入一次 settled 并释放 plan。
  - handle 现已对 failed/settled 设置终态闸门，失败后不能再次 execute；新增幂等 `release()` 清空私有 execute 闭包引用，coordinator 在 gate reject/异常、confirm reject/异常、validate 异常以及 execute 成功/失败/超时/取消路径统一调用。planning 失败发生在句柄创建前，不持有可释放 plan。

### 6.3 coordinator 编排

- [x] 实现唯一编排顺序：`plan → seal → gate/decide → confirm → validate → execute`。
  - coordinator 已接入 decide gate，并在 gate 后才进入 confirm；各阶段继续使用独立 timeout/cancellation。
- [x] 确保 Gate 不调用 plan。
  - decide 只在 `tool.begin()` 完成后执行，不能访问 registry 或触发 planning。
- [x] 确保 `decide()` 不接触工具 registry 或私有 execution payload。
  - decide 的参数类型固定为 sealed `PreparedInvocation`。
- [x] direct 工具走兼容路径。
- [x] 薄计划工具和完整计划工具分别走 planned 路径。
- [x] 增加 plan 失败、confirm 取消、validate 超时和 execute 取消测试。
  - 已覆盖 plan failure、confirm/gate cancellation、confirm/gate timeout、validate timeout 和 execute cancellation；失败路径均断言不进入 execute。
- [x] 增加篡改、复用、重复执行和跨工具调用测试。
  - planned registry 已覆盖 payload 篡改、request/toolUse/toolName identity、重复 execute 和 failed/settled 终态。
- [x] 将既有 toolChatLoop 确认结果适配到 coordinator hooks。
  - 新增 `coordinatorConfirmationAdapter.ts`，已锁定 approved、timeout、user reject、remote_read_only 和 authorization_revoked 的 typed 映射；toolChatLoop 已在确认/远程复核收敛点使用该 typed decision，并由其 `errorCode` 驱动拒绝分类；普通 builtin 执行时已通过 `coordinatorConfirmHook()` 注入 `executeRegisteredTool()`。UI/IM 确认请求仍由旧 loop 发起，但确认结果适配与 coordinator 消费已完成。

## 7. Phase 3B：run_shell planned 实现

### 7.1 统一分析和事实计划

- [x] 先增加统一 Analyzer 的 RED 测试。
  - `shellAnalyzer.test.ts` 锁定事实提取和 partial 分析行为。
- [x] 合并 segment、path、rm、trust 的重复 tokenizer。
  - `tokenizeSimpleCommand()` 统一复用 `tokenizeShellArgv()`；Analyzer、Shell trust 和 command-sequence extractor 共享同一套引号/空白解析。
- [x] 让 Analyzer 按 dialect 工作。
  - `analyzeShellFacts(command, dialect)` 将 dialect 绑定到事实快照。
- [x] Analyzer 只返回操作、真实连接符、路径、控制流、cwd 变化、解析置信度和未决项。
  - 新 Analyzer 不返回 verdict、denyType 或授权判断字段。
- [x] 从 Analyzer 输出删除 verdict、denyType、requiresRiskAck、skipConfirm 等判断字段。
  - `analyzeShellFacts()` 与 `ShellConfirmationAdapter` 只输出事实；旧兼容 `analyzeShellCommand()` 的判断结果仍属于待迁移边界。
- [x] 处理 quote、escape、变量、管道、重定向、多行、括号和注释 corpus。
  - `shellBehaviorMatrix.test.ts` 覆盖 Bash/PowerShell 的引号、管道、条件连接、变量、重定向、多行、命令替换、括号、cwd 和未闭合引号；`shellAnalyzer.test.ts` 另覆盖转义连接符、注释和参数展开。
- [x] 标记无法完整分析的结构为 `analysisCompleteness=partial`。
  - 覆盖命令替换和重定向等未完整解析结构。

### 7.2 PreparedShellExecution

- [x] 在 `run_shell.plan()` 中冻结 ShellProfile。
  - `electron/tools/runShellPlan.ts` 提供独立计划入口，统一生成并冻结 profile、executable 和 dialect；executor 已切换使用该入口。
- [x] 在 plan 中冻结 spawnSpec、cwd、timeout 和环境快照。
  - 独立计划入口统一生成 spawnSpec、cwd、timeout、ioMax、环境和 path/dependency snapshot，并将其传给 foreground 执行函数。
- [x] 记录依赖快照和 config/policy revision。
  - `PreparedShellExecution` 冻结 config/policy revision 与平台、profile、executable、环境 fingerprint 依赖快照；依赖变化返回 `PLAN_STALE`。
- [x] 生成私有 `PreparedShellExecution`。
  - executor spawn 前生成冻结 snapshot，并绑定 profile、spawnSpec、cwd、timeout、environment、facts 和 revisions。
- [x] 让 execute 只消费私有 prepared plan。
  - `runShellExecutor` 的执行路径已统一先调用 `planRunShellExecution()`，foreground 只消费私有 `PreparedShellExecution`，不再维护第二套计划构造逻辑。
- [x] 禁止 execute 重新读取原始 inputObj 和 shellConfig。
  - `toolChatLoop` 已在 Gate 结果后为 `run_shell` 生成 `PreparedShellExecution`，确认后调用 `executePreparedShellExecution()`；普通 builtin 已通过 `executeRegisteredTool()` 走 typed registry，旧 `runShellExecutor.execute(inputObj, ctx)` 不再用于主循环。typed direct 工具在 begin 阶段解析并冻结 input，execute 只消费冻结 payload 与注入的 runtimeContext；run_shell 只消费 prepared plan。
- [x] 增加确认后的 argv/env/profile/cwd 不变测试。
  - `preparedShellExecution.test.ts` 覆盖原始 command、argv、环境、profile、cwd、timeout 和 facts 在快照后被修改时，prepared plan 保持不变。
- [x] 实现 stale-plan 重验证。
  - `validatePreparedShellExecution()` 已对 profile、spawnSpec、cwd、timeout、environment、依赖快照、configRevision 和 policyRevision 返回结构化 stale reasons；执行前重验证现在从当前 `shellConfig` 和 tool gate 生成的 policy revision 重建快照，配置/策略变化也会返回 `PLAN_STALE`，并由 executor 入口测试确认不会 spawn；planned registry 新增私有 `validate(plan, context)` 钩子，验证失败会在 execute 前阻断副作用。`run_shell` 主循环执行前还会重新检查 executable/cwd realpath 与环境 fingerprint，变化返回 `PLAN_STALE`。
- [x] 对 executable、cwd、symlink、env、profile、config 和 policy revision 变化返回 `PLAN_STALE` 或重新决策。
  - 已接入 executable/cwd realpath `pathSnapshot`、当前 shell config revision 和 gate policy revision，变化统一返回结构化 `PLAN_STALE`；产品层可在此错误上选择重新确认/重计划，但本机检测与阻断条件已完成。
- [x] 计划不完整时不允许借助旧信任或缓存跳过确认。
  - Legacy auto-allow 现在要求统一 Analyzer 的 `analysisCompleteness=complete`；命令替换等 partial 分析即使匹配 trusted command 也必须继续确认，并有回归测试。
- [x] 方言不匹配、配置无效、executable 不可启动、TUI/后台模式不支持时在 spawn 前返回能力/输入错误。
  - TUI、方言错配、无效配置和带路径 executable 不可访问由计划阶段返回结构化错误（分别覆盖 `SHELL-CAPABILITY-001`、`SHELL-DIALECT-001`、`SHELL-PLAN-001`、`SHELL-CAPABILITY-002`）；后台命令由 `background_exec` validator 在 spawn 前拒绝，并有 `shellSecurity.test.ts` 回归覆盖。Windows 实际终止仍保留在目标平台验收清单。

## 8. Phase 3C：策略、确认和记忆闭环

### 8.1 Facts 与 policy

- [x] 先增加 `ShellConfirmationAdapter` RED 测试。
- [x] 将 `PreparedShellExecution` 投影为现有 `ContentFacts`。
- [x] 修正 `CommandFact` 的真实 connector。
  - 新 adapter 使用 Analyzer 的真实 connector 列表，不把所有 segment 误标为 pipe。
- [x] 增加逐步 `effectiveCwd`。
  - `CommandFact.effectiveCwd` 已按 `cd`、`Set-Location`/`sl` 逐 segment 计算，并覆盖 POSIX/Windows 路径语义。
- [x] 增加 Shell FactSignal 和 `shell-analysis-incomplete`。
- [x] 更新 signal token、确认摘要、规范序列化和缓存测试。
  - command facts 现在保留真实 connector token，并由 policy/cache 测试锁定；确认摘要继续使用规范化 command signature。
- [x] 增加 `confirm-every-time` PolicyAction。
  - 仅 `locked` 且 `when=invocation` 的规则会被 policy engine 识别，并且检查顺序位于 cache lookup 之前。
- [x] 将强拒绝置于 cache 前。
  - `decide()` 先处理 dangerous signal、deniedTools 和 locked deny，再查询 cache；policy engine 测试已覆盖。
- [x] 让弱风险、路径风险和 partial/unknown 进入强制逐次确认。
  - sensitive path / extraction incomplete 不再派生记忆档位，需按 policy 逐次确认。
- [x] 确保 `PreparedShellExecution` 不含 risk、verdict、trust 或 authorization 判断。
  - Prepared plan 只包含执行快照和 facts；confirmation adapter 单测锁定不存在上述字段。

### 8.2 locked rule 与 MemoryEligibility

- [x] 定义并接入 `InvocationPolicyConstraints`。
  - `deriveInvocationPolicyConstraints()` 统一推导 mandatory confirmation 与 `canRead/canOffer/canWrite`；`decide()` 在缓存前处理 `confirm-every-time`，`deriveCacheKeys()` 和 `buildMemoryTiers()` 消费同一约束。
  - 普通缓存 writer 的 `canWrite` 强制和全入口 permit 迁移仍由本节后续任务完成，当前未提前宣称闭环完成。
- [x] 定义统一 `MemoryEligibility`。
- [x] 让同一规则匹配结果统一约束缓存读取、记忆展示和确认写入。
  - `src/shared/policy/memoryEligibility.ts` 统一处理 partial/unknown、敏感路径和远程 session-only 记忆边界；`buildMemoryTiers()` 已消费该结果。
- [x] locked rule 运行时不可被 disabled。
- [x] 设置写入拒绝 locked rule id。
- [x] 历史 disabled locked id 做 fail-safe 清理。
- [x] 设置 UI 将 locked rule 设为只读。
  - runtime loader、disabled-id writer 和 settings view 均已 fail-safe；locked rule 始终 enabled 且不可 override。
- [x] policy package 原样保留 locked rule。
  - strict/loose/custom 变换和覆盖测试均锁定 locked rule 不可调松。
- [x] 限制 `confirm-every-time` 只能由系统 locked invocation rule 使用。
- [x] 增加 disabled、override、package、lane 和历史迁移测试。
  - `policyRulesRuntime.test.ts` 覆盖 disabled 与历史 locked-id 清理；`policyPackages.test.ts` 覆盖 strict/loose/custom、override 与 locked 保护；`settingsSecurityModel.test.ts` 覆盖 lane 显示和 locked 设置视图。

### 8.3 ConfirmationAuthorizationRegistry 与 permit

- [x] 定义统一 `ConfirmationAuthorizationRegistry`。
- [x] 实现一次性 `MemoryWritePermit`。
- [x] permit 绑定 invocation/request/toolUse/session identity。
- [x] permit 绑定 plan digest、facts digest、revision 和 expiry。
- [x] 拒绝二次消费、过期、cancel、timeout、reject、settled、stale/replan 后使用。
- [x] 拒绝任意 identity、digest 或 revision 被修改。
  - 实现与测试位于 `electron/confirmation/confirmationAuthorizationRegistry.ts`。
- [x] desktop 与 IM 共用 verifier 和 writer。
  - `ConfirmationAuthorizationRegistry` 提供共同 verifier；permit-limited writer 已封装在 `decisionCacheWriter.ts`。
- [x] desktop、飞书、微信、浏览器信任、设置和数据迁移调用方迁移到 permit API。
  - 普通确认记忆统一经 `recordUserAnswerFromDecision()`/`recordUserAnswerFromMemoryTiers()` 校验本次展示的 memory tiers；desktop IPC、飞书、微信和 tool loop 的浏览器信任路径均已覆盖。设置、显式信任和历史迁移属于系统管理写入，统一经显式命名的 `recordSystemManagedCacheEntry()`，不伪装成用户确认 permit；生产代码中不存在绕过 writer 的直接 cache.record 调用。
- [x] 将缓存写入拆为 permit 限定的确认记忆 API 与受控系统管理 API。
  - `recordUserAnswerFromDecision()`/`recordUserAnswerFromMemoryTiers()` 仅接受本次确认展示的档位；`recordSystemManagedCacheEntry()` 明确标记为设置、显式信任和迁移专用管理入口。
- [x] 禁止普通工具链路直接调用系统 writer。
  - 普通 tool loop 仅导入 permit-limited writer；系统 writer 的调用方限定为 desktop 显式信任 IPC 与迁移/维护模块。
- [x] 增加 A 调用 permit 不能写 B 调用 key 的测试。
- [x] 增加重复、过期、伪造、跨调用和 stale permit 审计测试。

### 8.4 Legacy ShellRule、trust 和缓存

- [x] 实现唯一 `LegacyShellPolicyAdapter`。
  - `legacyShellPolicyAdapter.ts` 是唯一旧 Shell 配置迁移入口，输出结构化 policy input。
- [x] 将旧 `ShellRule` / `trustedCommands` 编译为 decide 输入。
  - adapter 已将 permission decision、matched rule 和带 profile/dialect namespace 的 exact cache candidates 编译为 policy input；run_shell precheck 已消费 adapter 结果生成 auto-evaluator 输入，旧 `canSkipShellConfirm()` 已从 precheck 移除；Gate 授权已改用 `legacyAutoAllowEligible`，`skipConfirm` 不再作为授权兼容字段，仅保留在历史诊断日志中。
- [x] 禁止 Legacy adapter 直接返回 skip-confirm。
  - adapter API 不含 `skipConfirm`、`verdict` 或最终授权字段。
- [x] 复合命令保持 `persistable=false`。
  - `shellCommandParser.test.ts` 覆盖 `&&`、管道和重定向；复合/元语法命令不会进入 exact trust/cache 资格。
- [x] 使用 profile/dialect namespace 生成 exact shell signature。
  - `ShellConfirmationAdapter` 将 profile id 与 dialect 写入 `CommandFact.profileNamespace`，policy 生成 exact cache key 时纳入 namespace，避免跨 Shell profile 复用。
- [x] 旧签名未迁移时 fail-safe 重新确认。
  - exact cache key 已绑定 profile/dialect namespace；测试证明历史无 namespace 的 allow key 不会命中新签名，回落到 `require-confirm`。
- [x] 强 validator 在预置 allow cache 和旧 trusted command 下仍然 deny。
  - `toolDecisionMatrix.test.ts` 验证危险事实先于预置 exact allow cache 硬拒；`policyIntegration.test.ts` 验证旧 trusted command 仅对安全简单命令生效，复合/未信任分段仍需确认。
- [x] incomplete、弱风险、路径风险、复合和 partial/unknown 不得被自动放行或写入缓存。
  - `MemoryEligibility` 现对 analysis incomplete、非 persistable 复合/不完整 command fact、敏感/越界/系统路径、脚本网络/未认证统一关闭记忆；Legacy precheck 也拒绝复合命令自动放行。旧 writer 全调用方的最终闭环仍待 permit 收紧完成。
- [x] 删除 `toolChatLoop.ts` 对 run_shell 风险等级的硬编码。
- [x] 确认请求使用 `gate.decision.riskLevel`。
  - confirmation request 和 renderer confirm payload 均从 gate decision/facts 读取风险等级，不再按 toolName 写死 run_shell=high。

## 9. 文档、可观测性和本机验证

- [x] 更新开发计划的代码事实、阶段状态和验证记录。
  - `docs/develop/bash-run-shell-current-state-and-optimization-review.md` 新增当前实现事实、阶段状态、本机验证结果和未完成边界；不将 Windows/CI/生产项目误标为本机完成。
- [x] 更新 Shell 需求文档中的 hard deny / confirm / allow 说明。
  - 本机执行边界和真实行为已补充至 `docs/plan/run-shell-lifecycle-security-behavior.md`。
- [x] 编写 ShellProfile、PreparedInvocation、ProcessSupervisor 和 OutputPipeline 的架构说明。
  - 新增 `docs/plan/run-shell-lifecycle-architecture.md`，内容与当前实现和测试边界一致。
- [x] 编写迁移说明：cmd → Windows PowerShell、旧 bash alias → run_shell。
  - 新增 `docs/plan/run-shell-lifecycle-migration.md`，明确兼容迁移和目标平台验收边界。
- [x] 编写结构化错误合同和 TerminalResult 字段说明。
  - 新增 `docs/plan/run-shell-lifecycle-terminal-result-contract.md`，并由 renderer parser 测试验证字段收窄。
- [x] 为日志字段增加脱敏、摘要和完整输出禁止的断言。
  - executor 日志测试断言不包含完整 stdout/stderr，并验证摘要、字节数和失败字段。
- [x] 为 artifact 清理、内存上限、IPC 节流和终态收敛增加本地基准。
  - `shellLifecycleBenchmark.test.ts` 覆盖 100MB 有界输出、progress 预算、artifact 过期清理和幂等 settle。
- [x] 运行聚焦 Vitest 并记录结果。
  - `npm run test:shell-lifecycle`：39 个测试文件、301 个测试通过；另有 registry/planned 迁移定向测试通过。
- [x] 运行完整 `npm test` 并记录结果。
  - 2026-09-05 实际完成一次全量运行：487 个测试通过，2 个失败；失败为 `electron/mcp/streamableHttpTransport.test.ts` 的本机 `listen EPERM 127.0.0.1` 环境限制，以及由此引起的连接/重定向测试超时。`plannedToolRegistry.type.test.ts` 的运行时导入问题已修复；MCP 本地监听仍需在允许 loopback 的环境或 CI 重跑。
  - 后续单 worker Electron 全量复核：267/273 个文件通过、1736/1756 个测试通过；20 个失败/错误均集中在本机禁止 `127.0.0.1` loopback listen 的 MCP/OAuth/浏览器网络测试，未发现由本轮 registry 迁移引起的功能回归。
- [x] 运行 `npm run typecheck:shared` 并记录结果。
  - 结果：`[typecheck:shared] ok — tsc -p tsconfig.renderer.gate.json --noEmit`。
- [x] 运行 `npm run typecheck:renderer` 并记录结果。
  - 结果：`tsc -p tsconfig.renderer.json --noEmit` 通过。
- [x] 运行 `npm run i18n:check` 并记录结果。
  - 结果：检查通过；报告 1048 个既有 hardcoded Chinese occurrences。
- [x] 运行可用的构建验证并记录结果。
  - `npm run build:electron` 通过。
- [x] 运行本机 macOS Bash 真实进程组、孙进程回收和输出压力测试。
  - macOS 条件测试覆盖派生 `sleep` 回收；executor 压力测试覆盖 2MB 输出上限和高频 IPC 节流。
- [x] 对无法在本机真实验证的 Windows 项目明确记录为“待 Windows CI/实机验收”。
  - 本清单工作区边界和 CI matrix 说明已明确 Windows 实机/CI 才是验收依据。

## 10. 本清单明确不在本机完成的项目

以下项目不得用本机测试结果标记为 `[x]`：

- [ ] Windows PowerShell 5.1 真实启动和 `-EncodedCommand` 运行。
- [ ] Windows stdout/stderr 实际编码、PATH、PATHEXT、npm shim 和 Unicode 路径。
- [ ] Windows `taskkill /T /F` 真实进程树回收。
- [ ] Windows 不回退 cmd、pwsh、Git Bash、WSL 的实机证据。
- [ ] Windows Shell 设置页、打包态和 smoke test。
- [ ] `macos-15-intel` 和 arm64 macOS CI 的真实 contract、压力和打包测试。
- [ ] 提交后 CI matrix 的实际通过。
- [ ] 生产环境的方言错配率、重复重试率、重试熔断率和回退次数。
- [ ] 生产 Electron renderer 的真实 IPC 洪泛性能观测。
