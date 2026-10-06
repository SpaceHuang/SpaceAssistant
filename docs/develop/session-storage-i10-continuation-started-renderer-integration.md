# I-10 continuation-started renderer 集成记录（2026-10-05）

## 结论

I-10 完成。按计划复用 `origin/main` 提交 `f41edf9b` 中 `continuation-started` 的 renderer 状态显示与持久 sequence ack；没有引入第二套 command/message 类型，也没有把该提交中未列入 I-10 的失败续跑策略和后端改动带入。

## 集成内容

- 在 `ChatView` 的 local-command 分支识别 `continuation-started`，使用稳定 `messageId` 构造共享 status system message，按该 ID 路由到显示列表并 ack 主进程给定 sequence；不把 continuation ID 暴露给 renderer，不把它伪装为 Skill hint。
- `SkillHintBubble` 将已有 `category/status` 字段交给 `SkillHintRow`；普通 Skill 行维持原显示，status 行通过 i18n 显示“状态 / 正在继续上次执行”。
- 保留现有 `messageCodec` 对 `category/status` 的数据库解码实现，增加 round-trip 测试，证明页面重新读取时状态字段仍在。
- `createContinuationStartedSystemMessage`、`SkillHintRecord` 类型、`LocalCommandPayload` 联合成员和 storage display-entry ack reducer 已存在，直接复用。
- 仅选取 `f41edf9b` 的状态 renderer hunk；该提交里的 source-selection UI、失败 retry 策略和其他后端改动不属于 I-10。

## 验收

- `electron/messageCodec.test.ts`、`ChatView.autoCreateSession.test.tsx`、`ChatBubble.test.tsx`：3 个文件、42 项通过。
- ChatView 回归断言 command 返回后状态消息按固定 ID 入列表、`displayEntries` 从 optimistic 提升到 persisted sequence 17、发送文本已清空、chat 状态保持 idle；模拟历史页随后返回同一 ID，列表仍只有一条。
- Bubble 测试断言从持久 status 字段显示本地化状态徽标与消息文案；codec 测试断言 DB 序列化/解码 round-trip 不丢 `category/status`。
- `npm run typecheck:renderer`、`npm run typecheck:shared`、`npm run typecheck:agent-sdk`、`npx tsc -p tsconfig.electron.json --noEmit`、`npm run i18n:check`、`git diff --check` 通过。
- 未运行真实模型调用、真实用户 profile 或外部平台测试。
