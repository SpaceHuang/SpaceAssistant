# `codex/queued-task-bar-tdd` 评审

结论：**请求修改，暂不合并**。评审对象是该分支工作树中的未提交改动；当前分支提交指针与 `main` 相同（`4e3d44fd`）。

## 阻断问题

### B1 · 编辑响应可把已开始执行的消息重新变回排队态

位置：`src/renderer/services/messageMutationGateway.ts:103-115`、`electron/ipc/agentProtocolIpc.ts:886-889`。

`updateQueuedUserMessageContent` 在事务内完成校验和写入后，IPC handler 还要异步等待 `flushBackup`，才把当时的完整消息（`status: queued`）返回。这个等待期间，排队器可以 claim 同一条消息并将其改成 `sent`。若渲染端先收到 claim 投影或存储失效重载，再收到编辑 IPC 响应，`commitQueuedMessageEdit` 会无条件把返回的完整旧消息 patch 到 store，把 `sent` 覆盖回 `queued`。结果是已执行的用户气泡从列表消失、重新出现在横条，且可能长期停留到下一次重载，违反规格 §3.5 的单一展示与无缝转正。

建议：成功响应只更新正文等编辑字段，不回写 `status`；同时以当前 store 状态或单调版本校验迟到响应。补充受控 Promise 测试，按“编辑落库 → claim 投影 → 编辑响应”的顺序断言最终仍为 `sent`。

### B2 · 编辑只更新 Redux，未同步会话 live 快照

位置：`src/renderer/services/messageMutationGateway.ts:103-115`。相关现有路径：`src/renderer/services/chatRunnerService.ts:67-81, 109-115`。

编辑成功后仅 dispatch Redux patch；`liveBySession` 中的同一条排队消息仍保留编辑前正文。`initLiveSessionFromStore` 用旧 live 快照覆盖数据库/Redux 的新值，`resolveSessionMessagesForApi` 也把 live 快照作为最后一层覆盖。因而切换或重载会话后，编辑内容可能在渲染端回退；后续从该快照构造的请求也可能使用旧正文。数据库中的编辑虽然成功，运行时存在第二份相矛盾的消息事实。

建议：在编辑提交成功时同步更新 live 快照中的正文，或移除该消息在 live 快照中的旧副本；新增“编辑 → 会话重载/上下文合并”的回归测试。

### B3 · 空白草稿仍可通过 Enter 发起写请求

位置：`src/renderer/components/Chat/QueuedTaskBar.tsx:57-61`、`src/renderer/components/Chat/ChatView.tsx:732-745`。

保存按钮按 `!draft.trim()` 禁用，但 textarea 的 Enter 处理无同等校验，仍调用 `onSubmitEdit`；提交函数也只判断是否与旧正文相同。因此用户输入空格后按 Enter 会发送 IPC，收到 `empty_content`，并展示错误。规格 §3.7 明确要求“内容为空（或仅空白）：Enter 不提交”。

建议：在键盘入口及提交函数共用非空校验；增加空白草稿按 Enter 时 IPC 调用次数为零的测试。

## 验证

- `npx vitest run` 定向运行新增的 5 个测试文件：39 个用例通过。
- `npm run typecheck:renderer`：通过。
- `npm run i18n:check`：通过。
- `npm run typecheck:shared`：通过。

这些测试尚未覆盖上述竞态与 live 快照一致性。
