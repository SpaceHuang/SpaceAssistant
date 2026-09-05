# run_shell 迁移说明

## cmd → Windows PowerShell

- 新的 Windows 内置 profile 是 Windows PowerShell 5.1。
- 命令通过 UTF-16LE Base64 传递给 `-EncodedCommand`。
- 参数固定包含 `-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass`。
- 输出初始化为 UTF-8。
- 旧 cmd/OEM/GBK 行为只保留为迁移回归样本，不作为新 profile 的默认行为。
- Windows 实机仍需验证 executable、PATH、PATHEXT、npm shim、Unicode 路径和 taskkill 进程树。

## bash alias → run_shell

- 内部规范工具名固定为 `run_shell`。
- 外部协议的 `Bash` 只能在边界适配层映射到 `run_shell`。
- 权限、确认、审计、指标和重试应使用规范名；外部原始名称只能保留为诊断 metadata。
- 删除旧 alias 前需完成 builtin registry、system block 和所有协议适配器迁移，并保留兼容读取的 fail-safe 路径。

## 计划与确认迁移

- 新链路使用 `plan → seal → gate/decide → confirm → validate → execute`。
- execute 只消费 `PreparedShellExecution`，不得重新读取原始 input 或 shell config。
- profile、facts、display、environment、config revision 或 policy revision 变化时返回 `PLAN_STALE`，重新 planning 后再确认。
