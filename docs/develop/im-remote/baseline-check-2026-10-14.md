# im-remote baseline 核验记录（2026-10-14）

> 基线：`17236274`｜执行：Agent｜窗口：`git log 17236274..HEAD -- electron/feishu electron/wechat electron/remote`（开工点即基线，窗口为空）
> 本主题的判定分歧点：需求档自述「尚未实现统一 IM 策略域」，需按代码定论。

| 断言 | 文档出处 | 命令 | 实测 | 判定 | 处置 |
| --- | --- | --- | --- | --- | --- |
| A1 统一 IM 策略域（`imPolicy` / `imSecurityPolicy`）**未实现** | `in-flight/2026-10-11-im-security-review-improvement-requirement.md` | `rg -n 'imPolicy\|imSecurityPolicy' electron` | **0 命中** | 一致（真在途） | 保留在 `in-flight/`，标「依赖已就绪，主方案未实施」 |
| A2 IM 会话意图追踪已落地 | `archive/im-remote/2026-10-11-remote-im-intent-track-development-plan.md` | `git log --grep='intent tracking'` | `1d4c9bcd feat(remote): add intent tracking for IM conversations`（2026-10-12） | 一致（计划已收口） | 已归档 |
| A3 durable async IM approvals 已落地 | `archive/im-remote/remote-im-async-approval-security-requirement.md` | `git log --grep='durable async IM approvals'` | `71efa790`（2026-10-09）+ `09e74809`（补缺口） | 一致 | — |
| A4 Track 隔离与消息 ID 精度已收口 | 同上 | `git log --grep='Track isolation'` | `36edb110 fix(im): close Track isolation and message ID gaps`（2026-10-13） | 一致 | — |
| A5 微信确认消息 ID 精度已修 | — | `git log --grep='confirmation message id'` | `708270a9 fix(wechat): preserve confirmation message id precision`（2026-10-12） | 一致 | — |

## 无法核验项

- 真实 IM 链路（飞书/微信真实 Bot 收发、远程确认投递）：需真实外部系统凭据与真机，标 `待真机核验`。

## 现状文档断言核验（对 [`远程与IM-现状.md`](./远程与IM-现状.md)，2026-10-14 新写）

| 断言 | 出处 | 命令 | 实测 | 判定 |
| --- | --- | --- | --- | --- |
| B1 飞书 CLI 流 | 现状 §1 | `ls electron/feishu/feishuCliFlow.ts` | 命中（2 文件引用） | 一致 |
| B2 微信命令路由 | 现状 §2 | `ls electron/wechat/weChatCommandRouter.ts` | 命中（3 文件引用） | 一致 |
| B3 延迟审批族 | 现状 §3 | `ls electron/remote/deferredApproval*.ts` | 命中 6 件（`deferredApprovalRuntime` 被 4 文件引用） | 一致 |
| B4 出站受理 | 现状 §4 | `ls electron/outbound/outboundAcceptor.ts` | 命中（4 文件引用） | 一致 |
| B5 Track 契约与归因 | 现状 §5 | `ls src/shared/remoteTrack.ts electron/database/remoteTrack*.ts` | 命中（`remoteTrack` 被 61 文件引用） | 一致 |

## 完备性核验（本轮补充，2026-10-14）

**判定：初版现状文档严重不完备 → 已重写。**

| 节 | 初版列出的件数 | 实际 `ls` 件数 | 主要缺口 |
| --- | --- | --- | --- |
| §1 飞书 | 12 | **45** | `feishuRemoteAgent` / `feishuRemoteOutbound` / `feishuRemoteProgress` / `feishuReply`、`feishuSessionResolver` / `feishuWorkDirResolver`、`larkCli*`（`Runner`/`Security`/`ImpactPolicy`/`Errors`）、`npmCommandRunner`、`remoteCommandRouter` |
| §2 微信 | 10 | **30** | `weChatRemoteAgent` / `weChatRemoteOutbound` / `weChatReplyService` / `weChatSessionResolver` / `weChatConfig` |
| §3 远程核心 | 11 | **110+** | 9 个机制族：远程 Agent、入站守卫、会话切换守卫（`remoteSessionSwitch*`）、授权族（`remoteAuthorization*` / `remoteWriteGrant*`）、任务控制与工作流（`imTaskControl*` / `imWorkflow*`）、Track 与归因（`remoteTrack*` / `track*`）、唤醒（`wakeEvent*` / `deferredCompletionWake`）等 |
| §4 出站 | 1 | 2 | 漏 `outboundDrainer.ts` |

**处置**：已重写 §1–§3（改为按**机制族**归纳，共 26 个族）；教训固化于 [`../_consolidation/docs-consolidation-rules.md`](../_consolidation/docs-consolidation-rules.md) §3.4。

## 抽样复核建议（用户抽 3 条）

A1（关键分歧点）、A2、A3（交付前核验）＋ `ls electron/feishu/feishuRemoteAgent.ts`、`ls electron/remote/remoteAuthorization*`（完备性抽查）。
