# 产物决策远程 IM AC-IM-01～AC-IM-22 映射表

> 依据：`docs/requirement/artifact-decision-remote-im-requirement.md` v1.2  
> 计划：`docs/plan/artifact-decision-remote-im-tdd-plan.md`  
> 更新：2026-07-20（Phase 5–7 飞书/微信 router + 桌面 IPC 完成后更新）  
> 状态约定：`RED` = 计划中但尚未实现或未通过；`GREEN` = 自动化测试已通过；`partial` = 部分层已覆盖；`manual` = 需人工验收。

| AC | 描述摘要 | 实际测试文件 / 用例 | 状态 |
| --- | --- | --- | --- |
| AC-IM-01 | 远程+产物管理开启时 output-location 向 IM 发含编号与 decisionId 的文本 | `toolChatLoop` serialize+sendDecisionText；adapter 绑定私聊目标 | GREEN |
| AC-IM-02 | 单候选编号回复 → 对应 choice 且 resolved | IM bridge 单候选；飞书/微信 router `artifact_decision_resolved` | GREEN |
| AC-IM-03 | ownership 回复后进入 output-location，无死循环 | resume 多轮 + `remoteDecisionOwner`；router 入站 resolved | GREEN |
| AC-IM-04 | overwrite 改名/改目录/覆盖/取消与桌面语义一致 | codec + IM bridge choice；router 入站 | GREEN |
| AC-IM-05 | 非法编号只回用法提示，pending 仍在 | IM bridge usage_hint | GREEN |
| AC-IM-06 | 工具 Y/N 优先序；`Y` 不当成产物编号 | Confirm 先于决策；IM bridge Y/N = not_decision | GREEN |
| AC-IM-07 | 桌面先 resolved 后 IM 得 stale | `desktopImDecisionRace` desktop-first | GREEN |
| AC-IM-08 | IM 先 resolved 后桌面得 stale | `desktopImDecisionRace` IM-first；store stale UI | GREEN |
| AC-IM-09 | 非绑定用户/群聊无法提交 | 飞书/微信 non-owner 不 claim | GREEN |
| AC-IM-10 | 关闭产物管理不出现 IM 决策链路 | `toolChatLoop` 仅 artifactManagedSession | GREEN |
| AC-IM-11 | cancel 后提交为 stale | bridge cancel + chatCancelRegistry + outbound_failed | GREEN |
| AC-IM-12 | 飞书与微信出站/入站结果一致 | 共享 serializer/bridge + 对称 router 接线 | GREEN |
| AC-IM-13 | 工具确认、普通指令、桌面决策卡回归 | router 回归 + 桌面无 owner IPC | GREEN |
| AC-IM-14 | 并发隔离：正确 decisionId 只消费对应 Owner | bridge 隔离 + IM bridge UUID 精确选择 | GREEN |
| AC-IM-15 | ≥2 候选无前缀回复 → ambiguous | IM bridge ambiguous | GREEN |
| AC-IM-16 | 跨渠道拒绝 | bridge + 微信 cross-channel 用例 | GREEN |
| AC-IM-17 | IM/桌面抢答恰好一方 resolved 一方 stale | bridge 双提交 + race 集成 | GREEN |
| AC-IM-18 | 无 waiter 时提交返回 stale | bridge + IPC stale | GREEN |
| AC-IM-19 | 出站失败取消 waiter 且不走 Agent 工具 | toolLoop outbound_failed | GREEN |
| AC-IM-20 | 前缀编解码与 UUID 污染拒绝 | codec UUID 抽取/污染拒绝 | GREEN |
| AC-IM-21 | 未知 id / 缺编号提示且不进 Agent | IM bridge + 飞书/微信 unknown UUID 消费 | GREEN |
| AC-IM-22 | 出站可复制示例含真实 decisionId | serializer + toolChatLoop | GREEN |
