# im-remote —— 远程与 IM

> 定位：飞书、微信、远程会话与意图 Track、远程安全、产物决策。
> 主要代码域：`electron/feishu/`、`electron/wechat/`、`electron/remote/`、`electron/outbound/`
> 核对基线：`main` `17236274`（2026-10-14）

## 现状与设计文档（留主题目录）

| 文档 | 类型 | 说明 |
| --- | --- | --- |
| [远程与IM-现状.md](./远程与IM-现状.md) | **现状文档** | 飞书链路（8 族）、微信链路（6 族）、远程核心（12 族，110+ 件）、出站受理、Track 归因 |
| [baseline-check-2026-10-14.md](./baseline-check-2026-10-14.md) | **核验记录** | 6 条断言复算；3 条判为「严重不完备」并已重写现状文档 §1–§3 |
| [im-architecture-refactor.md](./im-architecture-refactor.md) | 架构设计（v2.1） | IM 架构重构 |
| [feishu-integration-phase1-design.md](./feishu-integration-phase1-design.md) | 设计 | 飞书集成 Phase 1（MVP） |
| [feishu-integration-phase2-design.md](./feishu-integration-phase2-design.md) | 设计 | 飞书集成 Phase 2（增强） |
| [feishu-integration-phase3-design.md](./feishu-integration-phase3-design.md) | 设计 | 飞书集成 Phase 3（可选增强） |
| [wechat-integration-phase1-design.md](./wechat-integration-phase1-design.md) | 设计 | 微信 iLink Bot 集成 Phase 1/2 |
| [artifact-decision-remote-im-technical-design.md](./artifact-decision-remote-im-technical-design.md) | 设计（v1.2） | 产物决策远程入站接线 |
| [remote-im-intent-track-operations-runbook.md](./remote-im-intent-track-operations-runbook.md) | 运维手册 | Intent Track 灰度与运维 |

## 在途（in-flight）

- [2026-10-11-im-security-review-improvement-development-plan.md](./in-flight/2026-10-11-im-security-review-improvement-development-plan.md) —— 实施方案草案：本文的新类型/字段/模块名是建议设计，**当前仓库尚未实现**（核验：`rg -n 'imPolicy|imSecurityPolicy' electron/` 无匹配；但依赖能力已落地：`1d4c9bcd` intent tracking、`8f1a21fc` 远程确认渠道归属、`71efa790` durable async IM approvals、`36edb110` Track isolation）

> **2026-10-14 核验更正（原判 C 有误）**：`remote-im-async-interaction-design.md`（`8148f307` 分支合入）、`wechat-confirmation-prompt-delivery-failure-fix-plan-2026-10-10.md`（`CONFIRMATION_UNAVAILABLE` 见 `electron/remote/imRemoteAgent.test.ts`）经核验**已实现**，已移入 `../archive/im-remote/`。

## 归档（5 件）

见 [`../archive/im-remote/`](../archive/im-remote/)：`2026-10-11-remote-im-intent-track-development-plan.md`（方案已落地：`1d4c9bcd` 等）、`remote-private-chat-security-optimization-development-test-plan.md`、`remote-private-chat-security-optimization-release-notes.md`。

## 相关需求口径

见 [`../../requirement/im-remote/`](../../requirement/im-remote/)（飞书/微信集成、远程工作目录、进度同步、异步审批安全、产物决策）。

## 核验记录

- [baseline-check-2026-10-14.md](./baseline-check-2026-10-14.md) —— 基线 `17236274`；断言逐条带可复现命令，含「矛盾与时间线检查」「无法核验项」「抽样复核建议」。

## 取证命令

```text
git log --date=short --format='%ad %h %s' -- electron/feishu electron/wechat electron/remote electron/outbound
rg -n 'imPolicy|imSecurityPolicy|intentTrack' electron/
```
