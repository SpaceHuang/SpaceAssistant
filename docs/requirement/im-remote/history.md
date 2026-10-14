# im-remote 需求口径变更历史

> 记录本主题**需求口径**的演进（正序）。实现侧见 [`../../develop/im-remote/history.md`](../../develop/im-remote/history.md)。

## 时间线

| 日期 | 需求（版本） | 口径变化 | 对应实现 |
| --- | --- | --- | --- |
| 2026-05-25 | `feishu-integration-requirement`（v1.0） | 飞书集成口径 | Phase 1–3 设计 |
| 2026-05-27 | `feishu-cli-logging-requirement`（v1.0） | CLI 全链路日志 | `logs/FeishuCli-*.log` |
| 2026-07-12 | `wechat-integration-requirement`（v1.2） | 微信 iLink Bot 集成 | — |
| 2026-07-12 | `remote-workdir-switch-guard-requirement`（v1.3）、`remote-workdir-tools-requirement`（v2.1） | 远程工作目录切换守卫与工具 | — |
| 2026-07-12 | `remote-progress-activity-sync-requirement`（v1.7）、`remote-session-context-awareness-requirement`（v1.4） | 进度同步与上下文感知 | — |
| 2026-07-13 | `wechat-remote-outbound-confirm-removal-requirement`（v1.1） | 移除出站确认 | — |
| 2026-07-15 | `remote-private-chat-security-optimization-requirement`（v1.6） | 私聊安全优化 | — |
| 2026-07-18 | `artifact-decision-remote-im-requirement`（v1.2） | 产物决策入站接线 | — |
| 2026-10-08 | `remote-im-async-approval-security-requirement`（v1.1） | 异步审批安全（无需人守） | `71efa790`（2026-10-09 durable async IM approvals） |
| 2026-10-09 | `remote-im-model-and-thinking-settings-requirement`（v1.3） | 远程模型/思考档位 | — |
| 2026-10-11 | `2026-10-11-im-security-review-improvement-requirement`（草案，**在途**） | 统一 IM 策略域（少问人） | 未见实现；依赖已就绪（`1d4c9bcd` intent tracking 等） |
| 2026-10-11 | `remote-im-intent-track-requirement-draft`（初稿 v0.3，在途） | 意图归属与 Track 管理 | 开发方案已落地（`1d4c9bcd`、`36edb110`） |

## 取证命令

```text
git log --date=short --format='%ad %h %s' -- electron/feishu electron/wechat electron/remote
rg -n 'imPolicy|imSecurityPolicy' electron/
```
