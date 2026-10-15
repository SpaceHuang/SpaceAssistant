# im-remote 迭代历史

> 本文是流水账：按时间**正序**记录本主题**已发生**的变更。证据源：`git log`（命令见文末）。

## 时间线

| 日期 | 提交 | 变更 | 出处 | 影响与结果 |
| --- | --- | --- | --- | --- |
| 2026-07-12 | — | 微信集成 v1.2、远程工作目录（守卫 v1.3 / 工具 v2.1）、远程上下文感知 v1.4 定稿 | requirement 侧（已归档） | 远程能力面成形 |
| 2026-10-09 | `71efa790` | 落地 durable async IM approvals | `remote-im-async-approval-security-requirement.md`（已归档） | 远程审批不因进程重启丢失 |
| 2026-10-10 | `09e74809` | 关闭异步审批恢复缺口 | 同上 | 恢复路径补齐 |
| 2026-10-10 | `b042897e` | 释放唤醒重试派发器 | — | 资源泄漏修复 |
| 2026-10-10 | `8148f307` | 远程 IM 异步交互分支合入（`codex/remote-im-async-interaction-tdd`） | `remote-im-async-interaction-design.md`（已归档） | 原判「在途（讨论稿）」，核验更正为已实现；`queueScope` / `turnCoordinator` 已在 `src/shared/` |
| 2026-10-14 | — | 核验更正：`wechat-confirmation-prompt-delivery-failure-fix-plan-2026-10-10.md` 已实现 | 同上（已归档） | 证据：`CONFIRMATION_UNAVAILABLE` 见 `electron/remote/imRemoteAgent.test.ts` |
| 2026-10-12 | `708270a9` | 微信保留确认消息 ID 精度 | — | ID 不再被截断 |
| 2026-10-12 | `1d4c9bcd` | 新增 IM 会话意图追踪（intent tracking） | `2026-10-11-remote-im-intent-track-development-plan.md`（已归档） | 意图归属与 Track 可查 |
| 2026-10-13 | `36edb110` | 关闭 Track 隔离与消息 ID 缺口 | 同上 | 隔离边界收口 |

## 存疑

- `in-flight/2026-10-11-im-security-review-improvement-development-plan.md` 与同主题需求档自述「统一 IM 策略域尚未实现」；但与 intent tracking / 审批渠道归属相关的能力已落地（见上表）。判定：**主方案真在途**，依赖已就绪 —— 复核条件为出现 `imPolicy` / `imSecurityPolicy` 符号。

## 取证命令

```text
git log --date=short --format='%ad %h %s' -- electron/feishu electron/wechat electron/remote electron/outbound
rg -n 'imPolicy|imSecurityPolicy|intentTrack' electron/
```
