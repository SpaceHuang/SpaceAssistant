# `codex/failed-turn-continuation-experience-tdd` 代码评审

结论：**请求修改，存在阻断问题**。评审对象为该分支 worktree 中尚未提交的改动；基线为 `e13d292e`。

## 阻断问题

1. **Critical：带附件的“继续”会被误路由为无附件的检查点续跑。** `ChatView.tsx:628-631` 只把附件放进 `contextIntent`，没有设置顶层 `attachments`；`outboundAcceptor.ts:315,344,430-435` 只检查顶层字段。因此用户输入“继续”并附图时，`exact` 仍为真，若检查点可续跑就直接启动 continuation，附件既没有写入新的 user message，也没有送进模型。这违反方案的附件路由契约。应在受理端先规范化附件来源，并用规范化结果统一计算指纹、路由和持久化；补真实 Renderer 载荷的集成测试。

2. **Critical：受理意图与 continuation/Turn 的创建不在同一事务，崩溃后可能丢失输入或重复执行。** `outboundAcceptor.ts:433-435` 先调用 `startContinuation`（其中已创建并启动目标），之后才写 `continuation_intents`；普通路径在 `:372-378,574-584` 先标记 `accepted_turn`，再启动 Turn 并单独更新目标。任一写入间崩溃或提交结果不明时，会留下无目标的已接受记录，或已有目标但无意图记录。重发同一 request ID 不能稳定返回原目标，甚至可能再次路由。应将来源核验、占用/创建目标和意图映射置于同一数据库事务，并在启动执行器前提交；对不确定提交按 request ID 对账。

3. **Critical：排队续接时摘要丢失，返回的 request ID 也与落库 ID 不一致。** `outboundAcceptor.ts:539-545` 仅更新 intent 行并调用既有排队函数；`enqueueDecision` 在 `:287-306` 使用 `intent.requestId` 落库，却向 Renderer 返回新生成的 `requestId`。排水路径 `claimQueuedTurnAtomically` 从队列消息创建 Turn，不读取 intent 中的来源摘要，因此“继续”带附件或额外文本在忙碌会话排队后，执行时缺少失败过程上下文。应让排队收据和返回值使用同一稳定 ID，并在领取队列项时把来源摘要/身份写入 Turn 的 execution config；补排队、排水、重发测试。

4. **Critical：有更新的普通任务时仍可能续跑旧失败任务。** `outboundAcceptor.ts:345-365` 只扫描 canonical invocation History，遇到已完成 invocation 才停止；它没有检查来源失败之后已接受但尚未产生终态 History 的普通 Turn 或排队消息。此时输入“继续”仍可能选中旧失败来源并启动 continuation，与更新任务交错。应在同一会话受理序列中核对 Turn/队列的接受顺序，并拒绝过期来源或按新任务处理。

## 验证

- `npx vitest run electron/outbound/outboundAcceptor.test.ts`：28 项通过。
- `npm run typecheck:shared`：通过。
- `npm run typecheck:renderer`：通过。

现有测试主要直接构造顶层 `attachments` 或 mock `startTurn`，没有覆盖真实 Renderer 载荷、事务崩溃点和排队排水，因而未捕获上述问题。
