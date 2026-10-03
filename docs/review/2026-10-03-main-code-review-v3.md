# main 代码复评 v3（2026-10-03）

## 范围

检查 `main` 的 `3feb0758`，以及工作区中尚未提交的八个续接受理、任务目录和任务表单修复文件。原有的文档草稿不纳入结论。复核上一轮三项阻断，并检查相邻的入队通知、任务执行和最新 canonical History 折叠代码。

## 复核结论

1. **忙时续接输入丢失：主体已修复。** `startTurn` 的 `SESSION_TURN_BUSY` 现在进入 `queueContinuation`，新增测试验证了稳定 `requestId`、附件和来源上下文落库。
2. **不可访问的任务目录被接受：已修复。** 校验改为 `R_OK | X_OK`，新增权限拒绝测试；本机聚焦测试通过。Windows 权限语义由该用例跳过，未在本机验证。
3. **不支持 Thinking 的默认模型无法直接建任务：已修复。** 主进程默认值和表单初始化都把有效强度设为 `off`，两层测试通过。

## 剩余阻断

### Required：忙时降级入队后缺少排水通知

- 位置：`electron/outbound/outboundAcceptor.ts:637-642`；对照同文件 `582-590` 和 `electron/ipc/agentProtocolIpc.ts:882-906`。
- 当前修复在 `SESSION_TURN_BUSY` 后直接返回 `queueContinuation(...)`。该函数在事务中调用 `enqueueDecision(..., false)`，故不会通知 `notifyEnqueued`；正常续接入队分支则在事务后显式通知。
- 可触发的时序：开始 Turn 时撞到已有 Turn → 旧 Turn 随即终结，排水器在新消息落库前看见空队列 → 新消息落库后没有补排水通知，也没有后续终态事件。输入已排队但可能永久不执行。此前的修复目标正是覆盖这类快照与入队之间的竞态。
- 建议：`queueContinuation` 完成事务提交后统一发 `notifyEnqueued(sessionId)`，不要仅在 `decision.action === 'enqueue'` 分支通知；新增“终态发生在队列落库前”的回归测试，并断言忙时降级调用通知端口。

## 验证

- 聚焦测试：`outboundAcceptor`、`taskConfigValidation`、`butlerIpc`、`ButlerTaskSettings`，4 文件 61 项通过。
- Renderer、Shared、Agent SDK 类型检查及 i18n 检查通过；`npm run build` 通过。
- 全量 `npm test`：852 个文件通过、1 个文件跳过；7773 项通过、106 项跳过，退出码 0。
- `foldClaudeSessionSnapshots` 是新增但目前无调用方、无直接测试；当前运行路径未使用它，本轮不判阻断。后续接入前应补跨 invocation 顺序、截断与冲突用例。

**结论：请求修改。** 上轮三项问题的主要路径已修复，但忙时降级的队列唤醒闭环仍不完整。
