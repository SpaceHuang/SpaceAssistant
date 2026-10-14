# storage-session —— 会话与数据

> 定位：存储重构、持久化与维护、读热路径、消息事实链路、事件流、会话标题与列表。
> 主要代码域：`electron/sessionStorage/`、`electron/storage/`、`electron/storageProfile/`、`electron/database/`、`electron/sessionEvents.ts`、`electron/messageCodec.ts`
> 核对基线：`main` `17236274`（2026-10-14）

## 现状文档（留主题目录）

| 文档 | 类型 | 说明 |
| --- | --- | --- |
| [session-storage-refactor-technical-design.md](./session-storage-refactor-technical-design.md) | 技术方案（512 KB） | canonical 事件流为正文真相源，保留权威消息骨架与流程状态 |
| [session-storage-public-interface-design.md](./session-storage-public-interface-design.md) | 接口设计（v26） | 原 S0–S4 验收通过；评审 4 项 P1 修复及最终门禁通过 |

> 引用说明：上两篇互有引用，且大量引用已归档的阶段件（`a*`/`c*`/`i*`/`r*`），其相对链接已按搬迁后布局重算。

## 在途（in-flight）

- [message-fact-persistence-core-refactor-plan.md](./in-flight/message-fact-persistence-core-refactor-plan.md) —— v2 已吸收阻断性评审，待复审后实施
- [message-fact-pipeline-prompt-cache-optimization-plan.md](./in-flight/message-fact-pipeline-prompt-cache-optimization-plan.md) —— 待实施（本文仅交付开发设计）

## 归档（64 件，本主题最大）

见 [`../archive/storage-session/`](../archive/storage-session/)：

| 组 | 件数 | 说明 |
| --- | --- | --- |
| `session-storage-a00…a12` | 12 | 评审输入冻结与逐项评审（唯一归属、durable run、worker fencing、legacy queue、观察门禁、profile 估算、清理门禁、维护恢复、集成范围、当前状态差异、源评审门禁） |
| `session-storage-c00…cscope` | 9 | 候选包清单/烟测/兼容记录/包矩阵（含 `.json` 证据） |
| `session-storage-i00…i11` | 12 | 集成件：schema 迁移、运维、历史、IPC 生命周期、outbound、标题适配、SDK 未派发历史、butler 快照、composer 目录授权、续跑渲染、包构建配置 |
| `session-storage-r00…r03` | 4 | 干净树清单、macOS 包清单、v0.2.5 回滚包清单（`.json`） |
| 迁移/维护/基线 | 11 | `session-storage-refactor-migration-plan.md`、`m4-3-status`、`phase5-baseline`、profile 采样（2026-10-04/05）、cleanup-estimate、read-hot-path 性能件、reader 架构审计 |
| 消息事实链路 | 5 | `message-fact-production-pipeline-refactor-plan.md`（实施中已接入主路径）、本地验收报告、owner 审计 |
| 专题（session-ced59b41 / session-d961cc51） | 6 | 问题清单整改、验收证据、workdir 边界分层技术计划与实施矩阵 |
| 其他 | 5 | `spill-reference-index-and-backfill-plan.md`、`storage-settings-profile-latency-*`、评审件 |

## 相关需求口径

见 [`../../requirement/storage-session/`](../../requirement/storage-session/)（会话标题、列表徽标、消息事实链路需求）。

## 取证命令

```text
git log --date=short --format='%ad %h %s' -- electron/sessionStorage electron/storage electron/database
git log --date=short --format='%ad %h %s' -- docs/develop/session-storage-refactor-technical-design.md
```
