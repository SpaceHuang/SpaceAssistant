# im-remote —— 远程与 IM

> 定位：飞书、微信、远程会话与意图 Track、远程安全、产物决策。
> 主要代码域：`electron/feishu/`、`electron/wechat/`、`electron/remote/`、`electron/outbound/`
> 核对基线：`main` `17236274`（2026-10-14）

## 现状与设计文档（留主题目录）

| 文档 | 类型 | 说明 |
| --- | --- | --- |
| [im-architecture-refactor.md](./im-architecture-refactor.md) | 架构设计（v2.1） | IM 架构重构 |
| [feishu-integration-phase1-design.md](./feishu-integration-phase1-design.md) | 设计 | 飞书集成 Phase 1（MVP） |
| [feishu-integration-phase2-design.md](./feishu-integration-phase2-design.md) | 设计 | 飞书集成 Phase 2（增强） |
| [feishu-integration-phase3-design.md](./feishu-integration-phase3-design.md) | 设计 | 飞书集成 Phase 3（可选增强） |
| [wechat-integration-phase1-design.md](./wechat-integration-phase1-design.md) | 设计 | 微信 iLink Bot 集成 Phase 1/2 |
| [artifact-decision-remote-im-technical-design.md](./artifact-decision-remote-im-technical-design.md) | 设计（v1.2） | 产物决策远程入站接线 |
| [remote-im-intent-track-operations-runbook.md](./remote-im-intent-track-operations-runbook.md) | 运维手册 | Intent Track 灰度与运维 |

## 在途（in-flight）

- [2026-10-11-im-security-review-improvement-development-plan.md](./in-flight/2026-10-11-im-security-review-improvement-development-plan.md) —— 实施方案草案：本文的新类型/字段/模块名是建议设计，**当前仓库尚未实现**（核验：`rg -n 'imPolicy|imSecurityPolicy' electron/` 无匹配；但依赖能力已落地：`1d4c9bcd` intent tracking、`8f1a21fc` 远程确认渠道归属、`71efa790` durable async IM approvals、`36edb110` Track isolation）
- [remote-im-async-interaction-design.md](./in-flight/remote-im-async-interaction-design.md) —— v0.2 讨论稿
- [wechat-confirmation-prompt-delivery-failure-fix-plan-2026-10-10.md](./in-flight/wechat-confirmation-prompt-delivery-failure-fix-plan-2026-10-10.md) —— 待实施

## 归档（3 件）

见 [`../archive/im-remote/`](../archive/im-remote/)：`2026-10-11-remote-im-intent-track-development-plan.md`（方案已落地：`1d4c9bcd` 等）、`remote-private-chat-security-optimization-development-test-plan.md`、`remote-private-chat-security-optimization-release-notes.md`。

## 相关需求口径

见 [`../../requirement/im-remote/`](../../requirement/im-remote/)（飞书/微信集成、远程工作目录、进度同步、异步审批安全、产物决策）。

## 取证命令

```text
git log --date=short --format='%ad %h %s' -- electron/feishu electron/wechat electron/remote electron/outbound
rg -n 'imPolicy|imSecurityPolicy|intentTrack' electron/
```
