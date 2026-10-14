# safety-approval 需求口径变更历史

> 记录本主题**需求口径**的演进（正序）。实现侧见 [`../../develop/safety-approval/history.md`](../../develop/safety-approval/history.md)。

## 时间线

| 日期 | 需求（版本） | 口径变化 | 对应实现 |
| --- | --- | --- | --- |
| 2026-06-06 | `confirmation-card-trust-requirement`（v1.5） | 确认卡片信任度与可读性 | — |
| 2026-06-06 | `shell-security-enhancement-requirement`（v2.0） | shell 命令分析与危险模式识别 | 脚本安全 parser 升级（`P0–P3` 完成） |
| 2026-09-17 | `security-policy-single-entry-requirement` | 安全策略单一入口；原设置页入口删除并保留迁移提示 | 口径仍在生效 |
| 2026-09-21 | `security-approval-concurrency-limits-and-observability-requirement`（v0.1，草案） | 并发、配额与可观测性问题清单（未实施） | 未见实现 |
| —（四轮评审修订） | `tool-confirmation-top-level-design-v2` | 覆盖桌面/微信/飞书/自动任务所有链路的确认与授权机制，可进入 P0 | 框架部分已落地（`tool-confirmation-framework-implementation-plan.md` 已归档） |

## 取证命令

```text
git log --date=short --format='%ad %h %s' -- electron/confirmation electron/capabilities
```
