# `run_shell` TerminalResult 合同

`result.data` 由主进程生成，经 IPC 传递后由 `parseShellResultData()` 做运行时收窄。未知字段可以被忽略，错误类型不得进入 renderer 状态。

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `status` | `succeeded \| failed \| cancelled \| timed_out \| output_limited` | 统一终态 |
| `exitCode` | `number \| null` | 子进程退出码；未退出时为 `null` |
| `signal` | `string \| null` | 实际终止 signal 或平台终止器名称 |
| `terminationReason` | `string` | `user_cancel`、`timeout`、`output_limit` 或 `process_exit` |
| `treeKillVerified` | `boolean` | 是否在 deadline 内确认进程树终止 |
| `durationMs` | `number` | 执行耗时 |
| `stdoutBytes` / `stderrBytes` | `number` | 原始 stdout/stderr 总字节数 |
| `outputArtifactBytes` | `number` | 实际写入 artifact 的字节数 |
| `outputArtifactSha256` | `string` | artifact 内容 SHA-256 |
| `persistedOutputPath` | `string?` | 截断输出的 artifact 路径 |
| `outputPersistErrorCode` | `string?` | 落盘失败时为 `OUTPUT_PERSIST_FAILED` |
| `terminationErrorCode` | `string?` | 终止未确认时为 `TERMINATION_UNCONFIRMED` |
| `caseId` | `string?` | 稳定问题分类 ID |

完整 stdout/stderr 只通过有界 inline 字段返回；常规 Agent 日志不记录完整输出。
