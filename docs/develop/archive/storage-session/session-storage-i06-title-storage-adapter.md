# I-06 标题存储适配记录（2026-10-05）

## 结论

I-06 完成。标题产品策略逐项恢复为 `origin/main` 合同：达到 3 条有可见文本的 user/assistant 消息才触发；纯 `tool_use`/`tool_result` 不计数；标题摘要只包含前 3 条可见消息；在线触发使用调用前的对话快照。老会话回填只替换读取来源为 canonical-aware projection，不再读取旧 `messages.content`。

## TDD 证据

1. 先将标题计数、截断与回填断言改为主线策略，当前 assistant-turn 实现红测：截断仍纳入第三个 assistant 回答，且可见消息计数 helper 缺失。
2. 恢复主线可见消息计数和 N 条截断规则；在线调度恢复为调用成功后传入调用前快照，保留主线的调度时机。
3. canonical-only 老会话回填隔离测试验证旧正文已清空、缓存已删除时仍从 projection 取正文，API key 失败会清理 attempted 标记并允许重试；恢复主线三条可见消息阈值后，摘要包含第二条 user 问题且不越过前三条。

## 验证

- 先行红测：2 个标题 suite 中 2 个预期失败，直接证明正文截断与计数合同不符。
- 最终定向回归：6 个文件、57 项通过（标题纯逻辑、canonical 回填、toolChatLoop invocation/safety/deferred/lane）。
- `npx tsc -p tsconfig.electron.json --noEmit` 通过。
- `git diff --check` 通过。
- 未调用真实模型服务；使用隔离 SQLite 与 fake/mock 服务。

## 范围

只恢复既有标题策略并把老会话读点接到 `getProjectedMessages()`。没有新增标题功能或改造授权/UI。I-07 仍是下一步；未做 I-07 或整体 Git merge。
