# `codex/failed-turn-continuation-experience-tdd` 重审（第三轮）

结论：**请求修改，仍有 1 项必须修复的问题**。第二轮的“运行中 Turn 拒绝继续输入”已修复：非终态最新 History 与活动 Turn 匹配时会走普通排队路径，并有包含非终态 History、附件及排水的测试。

## 必须修复

1. **检查点续跑成功后向用户直接显示内部协议值。** `electron/outbound/outboundAcceptor.ts:345,463` 把 `CONTINUATION_ACCEPTED:<continuationId>` 作为 `hint-only` 返回；`src/renderer/components/Chat/ChatView.tsx:565-590` 对该结果调用 `showSkillHint`，其无持久消息分支在 `:496-501` 用 `message.info(hint)` 原样展示。用户输入“继续”后会看到内部状态码和 UUID，而不是可理解的“正在继续上次执行”反馈；该操作也没有在消息列表留下方案要求的可见记录。请为 continuation 提供明确的返回类型或状态字段，由 Renderer 用本地化文案展示，并按产品契约持久化可见操作记录，避免把内部 ID 作为用户文案。补从 `submitOutbound` 返回到界面呈现的测试。

## 验证

- `npx vitest run electron/outbound/outboundAcceptor.test.ts`：32 项通过。
- `npm run typecheck:renderer`、`npm run typecheck:shared`：通过。
- 上轮全量测试通过；本轮尚未重复运行全量测试。
