# I-05 outbound retry/continuation 集成记录（2026-10-05）

## 集成合同

- 保留 main outbound retry/continuation source-selection、queue wakeup、retry lineage、stable request ID 和 request payload identity 语义。
- 保留 storage 持久 continuation intent 与 Turn/History/队列写入的事务接受边界；重放相同请求返回已接受 turn/queued 结果，不重复创建用户消息或 turn。
- busy→queue、queue claim/reopen 后继续运行仍使用原 request ID、source context 与附件；失败 checkpoint 和 commit-uncertain 不能伪装成成功。
- session/turn/message 正文读取走 canonical-aware reader；`outboundAcceptor` 与 `turnCoordinatorStorage` 不直接使用 legacy `getMessages/getMessage` 获取正文。消息骨架仍由数据库提供。
- canonical History/投影缺失或损坏时 fail closed；不会返回空/陈旧正文作为 retry/accepted assistant 内容。

## 验证

- `outboundAcceptor.test.ts`、`turnCoordinatorStorage.test.ts`、`turnCoordinator.test.ts`、`hostedTurnHandoff.test.ts`：4 files / 181 tests 通过。
- `toolChatLoop.invocation.test.ts`、`claudeStreamHandlers.hostedIntegration.test.ts`：2 files / 147 tests 通过。
- 合计 6 files / 328 tests。覆盖 accepted canonical-only 重试、ambiguous source 明确选择、旧失败不串接新用户任务、busy→queue、stable request ID/attachment 经 claim 到 Turn config、SQLite reopen retry、History commit uncertainty、tool dispatch recovery。
- `npx tsc -p tsconfig.electron.json --noEmit`、`npm run typecheck:shared`、`npm run typecheck:agent-sdk`、`git diff --check` 通过。
- 本轮只用 fake/provider 和隔离 SQLite；未调用真实模型服务。

## 状态

I-05 完成，未发现未处置 outbound/continuation finding。下一项按顺序为 I-06 标题存储适配，只沿用 main 标题策略。
