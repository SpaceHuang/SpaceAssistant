# storage-session 需求口径变更历史

> 记录本主题**需求口径**的演进（正序）。实现侧见 [`../../develop/storage-session/history.md`](../../develop/storage-session/history.md)。

## 时间线

| 日期 | 需求（版本） | 口径变化 | 对应实现 |
| --- | --- | --- | --- |
| 2026-06-06 | `session-manual-title-requirement`（v1.1） | 手动标题 | `electron/sessionStorage/` 标题适配 |
| 2026-09-04 | `session-list-pending-confirm-badge-requirement`（v1.0） | 会话列表展示待确认计数 | — |
| 2026-09-05 | `message-fact-production-pipeline-refactor-requirement`（v0.1，待实施） | 消息事实归 Core、统一生产链路 | `1f6e7940`（2026-09-30）；文档口径滞后于实现 |
| 2026-09-23 | `session-d961cc51-workdir-boundary-and-sandbox-policy-layering-requirement`（v0.7） | workdir 边界与沙箱策略分层 | 阶段 A~D 已实施（Windows/Linux CI 待跑） |
| 2026-09-24 | `session-ced59b41-issue-inventory-requirement`（v0.1） | 专题问题清单 | 已整改（含验收证据与人工证据） |
| 2026-09-04 前 | `session-auto-title-requirement` | 会话自动标题 | — |

## 取证命令

```text
git log --date=short --format='%ad %h %s' -- electron/sessionStorage electron/storage
```
