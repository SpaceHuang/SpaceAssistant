# `codex/queued-task-bar-tdd` 复审（v2）

结论：**请求修改，暂不合并**。上一轮 B1–B3 均已修复并有相应回归测试；本轮发现新的阻断问题。

## 阻断问题

### B1 · 旧会话的迟到编辑结果会清空新会话草稿

位置：`src/renderer/components/Chat/ChatView.tsx:682-688, 732-746`。

复现时序：在会话 A 保存一条排队消息，令编辑 IPC 挂起；切到有排队消息的会话 B 并开始编辑、输入尚未保存的草稿；随后让 A 的 IPC 返回。`handleSubmitQueuedEdit` 的异步续体使用 A 的闭包，但无条件调用 `setEditingMessageId(null)`、`setEditDraft('')`，会把 B 的编辑器关闭并丢失草稿。失败分支中的 `message_not_queued` 也会清空 B 的草稿并显示与 B 无关的提示。`editSubmitting` 同样跨会话共用，在 A 的请求结束前会禁用 B 的保存。

这违反规格 §3.7 的会话切换编辑态边界，并造成用户未保存内容丢失。建议将提交状态与发起时的 `{ sessionId, messageId, displayGeneration }` 绑定；响应回来时仅在当前编辑目标仍匹配时修改编辑态。为上述时序增加受控 Promise 的组件测试，同时覆盖成功与失败响应。

## 已核实的修复

- 编辑响应现在只 patch `content`，不会把已 claim 的 `sent` 状态覆盖成 `queued`。
- 编辑成功会同步 `liveBySession` 的正文。
- 空白草稿通过 Enter 不再提交，提交函数也有非空保护。

## 验证

- 定向测试：7 个文件、53 个用例通过。
- `npm run typecheck:renderer`：通过。
- `npm run typecheck:shared`：通过。
- 全量 `npm test`：运行约 90 秒仍无用例输出，已中止（退出码 130）；未获得全量测试结论。
