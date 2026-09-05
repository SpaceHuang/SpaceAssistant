# `run_shell` 安全行为说明

本文记录当前本机实现的真实行为，作为执行计划和代码审查的约束。路径分析、Shell 方言分析和输出限制都不是操作系统沙箱，也不替代权限隔离。

## 分析与授权分层

`analyzeShellFacts()` 只产生事实：操作、连接符、路径、cwd 变化、方言、解析完整度和未决项。它不产生 `risk`、`verdict`、`denyType`、`skipConfirm` 或 trust 结论。事实不完整时必须标记为 `analysisCompleteness=partial`，不能因为解析失败而默认为安全。

最终行为由策略和确认层决定：

- hard deny：例如提权命令或明确不支持的交互模式，在 spawn 前拒绝；
- require-confirm：未信任、partial/unknown、路径或弱风险命令逐次确认；
- allow：仅在策略明确允许且满足当前 trust/cache 约束时执行；
- diagnostic error：方言错配、配置无效、不可启动 executable 等能力错误，不创建子进程。

## Shell 语法边界

- 单一、无元语法命令才可能成为 persistable trust 条目，并按结构化 argv token 边界匹配。
- 管道、`&&`、`||`、`;`、重定向、命令替换、多行控制流等复合命令不进入持久化 trust，也不能仅凭旧 trust 自动跳过确认。
- 不完整分析的命令不被解释为 allow；需要继续走确认或返回结构化分析错误。
- Bash 与 Windows PowerShell 使用 profile 绑定的方言检查；错配在 spawn 前返回 `SHELL_DIALECT_MISMATCH`。

## 路径和输出边界

路径 classifier 用于风险提示和确认事实，不是沙箱。真实访问权限仍由操作系统、进程身份和应用自身策略决定；symlink、UNC、drive 和 `..` 只影响本次分析的路径事实。

stdout/stderr 采用有界内存摘要、增量 artifact 和 hash。日志只保留脱敏摘要、字节数、hash、截断状态、退出状态和 artifact 元数据，不把完整输出作为常规日志字段。

## 本机与目标平台边界

macOS Bash、Node 进程组、Vitest 和模拟的 PowerShell payload 可在本机验证。Windows PowerShell 实际编码、`taskkill /T /F` 终止确认、Windows 进程树和打包态行为仍须在 Windows CI 或实机验收。
