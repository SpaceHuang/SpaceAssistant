# run_shell 生命周期架构说明

## 边界

`run_shell` 的生命周期分为四个边界：

1. 输入与事实分析：根据当前 `ShellProfile` 提取操作、连接符、路径、cwd 变化和分析完整性；不产生授权 verdict。
2. 计划封存：生成不可变的 `PreparedShellExecution`，绑定 profile、spawnSpec、cwd、timeout、环境快照、facts、config/policy revision 和 plan digest。
3. 门禁与确认：`plan → seal → gate/decide → confirm → validate`。Gate 只接收 sealed `PreparedInvocation`，不接触私有 execution payload。
4. 执行与收敛：`ProcessSupervisor` 管理进程树终止；`OutputPipeline` 管理有界 inline、terminal raw、artifact 和 hash；最终结果只允许一次 settle。

## 关键对象

### ShellProfile

`ShellProfile` 描述 id、dialect、executable、参数模板、loginMode、encoding 和 source。工具合同、编码策略和执行计划使用冻结 snapshot，避免确认后参数模板被修改。

### PreparedShellExecution

`PreparedShellExecution` 是 shell execute 的私有输入。它深拷贝并冻结 profile、spawnSpec、环境和 facts，并生成 environment fingerprint 与 plan digest。execute 阶段不应重新读取原始 input 或 shell config。

`validatePreparedShellExecution()` 比较 profile、spawnSpec、cwd、timeout、environment、config revision 和 policy revision；不一致时由 `assertPreparedShellExecutionCurrent()` 抛出 `PLAN_STALE`。

### PreparedInvocation

`PreparedInvocation` 带模块私有 brand，不能由普通对象字面量伪造。它绑定 invocation/request/toolUse identity 及 plan/facts/display digest。identity 不匹配、重复执行、未确认执行都会被拒绝。

### ProcessSupervisor

状态为 `running → terminating → terminated | termination_failed`。重复 terminate 复用同一 Promise；killer reject 和 deadline 都必须收敛，deadline timer 在终态清理。

### OutputPipeline

stdout/stderr 使用有界首尾 buffer；terminal raw 使用独立 ring buffer；超出 inline 后增量写 artifact，并记录字节数和 SHA-256。常规日志不记录完整 stdout/stderr。

## 验证边界

本机已验证 macOS Bash、Node 进程组、stdout/stderr UTF-8、Vitest、TypeScript 和模拟的 PowerShell payload。Windows PowerShell 实机、Windows taskkill 进程树、Intel/arm64 macOS CI、打包态和生产 IPC 指标仍必须由目标平台验收。
