# tool-dispatch-slot-abort-tdd 评审（2026-10-03）

结论：**请求修改，2 项阻断问题**。评审范围为此 worktree 相对 `HEAD` 的 8 个已修改文件。定向测试 `npm exec -- vitest run --project electron packages/agent-sdk/test/turn.test.ts electron/runtime/agentSdkDesktopObserver.test.ts electron/confirmation/agentSdkConfirmationPort.test.ts` 通过（3 个文件，158 个测试）；以下问题未被现有测试覆盖。

## 阻断问题

1. **[P1] 未派发槽位的诊断永远漏报** — `packages/agent-sdk/src/turn.ts:1421-1425`。`mapWithConcurrency` 用 `new Array(items.length)` 创建稀疏数组，致命停止后未领取的槽位仍是 hole。`flatMap` 跳过 hole，不会调用回调，因此 `pendingToolCallIds` 在真正存在未派发槽位时仍为空，`onDispatchStoppedWithPending` 不触发。这正是新增诊断要观测的故障路径。应按 `toolCalls` 的索引遍历并查询 `settledTools[index]`，或先用 `Array.from` 将 hole 显式化；补充从真实 fatal 停派路径出发的 observer 测试，不能只直接调用 observer 钩子。

2. **[P1] 用户拒绝缓存跨模型轮次生效，超出“同批”范围** — `electron/confirmation/agentSdkConfirmationPort.ts:59-71,118-121`。确认 port 在 `invocationAssembler.ts:1228` 创建一次并传给同一次 `runAgentTurn`，该 Turn 可运行多个模型轮次（`invocationAssembler.ts:1079`）。缓存键只有工具名和路径；首轮用户拒绝后，模型收到拒绝结果并调整写入内容，再次请求同一路径时仍会被自动拒绝，用户没有机会审阅新的调用。应把缓存限定在模型调用批次（例如将 `modelTurn` 或批次 ID 纳入确认上下文和键，并在批次结束清理），再增加跨轮相同目标但不同内容须重新确认的回归测试。

## 验证边界

上述测试均通过，但现有诊断测试只直接调用 observer，确认测试只在单轮内重复调用 port；两者均未覆盖对应的集成时序。未运行完整测试套件或桌面真机交互。
