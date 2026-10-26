# storage-session —— 会话与数据

> 定位：存储重构、持久化与维护、读热路径、消息事实链路、事件流、会话标题与列表。
> 主要代码域：`electron/sessionStorage/`、`electron/storage/`、`electron/storageProfile/`、`electron/database/`、`electron/sessionEvents.ts`、`electron/messageCodec.ts`
> 核对基线：`main` `17236274`（2026-10-14）

## 现状文档（留主题目录）

| 文档 | 类型 | 说明 |
| --- | --- | --- |
| [会话与数据-现状.md](./会话与数据-现状.md) | **现状文档** | 存储内核分层、事件流与编解码、持久化与维护、数据库层 |
| [baseline-check-2026-10-14.md](./baseline-check-2026-10-14.md) | **核验记录** | 16 条断言复算；5 条判为「不完备/缺项/计数」并已补齐现状文档 |
| [session-storage-refactor-technical-design.md](./session-storage-refactor-technical-design.md) | 技术方案（512 KB） | canonical 事件流为正文真相源，保留权威消息骨架与流程状态 |
| [session-storage-public-interface-design.md](./session-storage-public-interface-design.md) | 接口设计（v26） | 原 S0–S4 验收通过；评审 4 项 P1 修复及最终门禁通过 |

> 引用说明：上两篇互有引用，且大量引用已归档的阶段件（`a*`/`c*`/`i*`/`r*`），其相对链接已按搬迁后布局重算。

## 在途（in-flight）

**（2026-10-14 核验时为空）** —— 当时全部移入 `../archive/storage-session/`（共 66 件）；后续新增在途方案列于下方。

- [启动时历史会话恢复耗时优化方案](./in-flight/启动历史会话恢复耗时优化方案.md) —— [执行计划](./in-flight/启动历史会话恢复耗时优化执行计划.md) P0–P8 记载源码阶段已完成；header 的“执行中”仅剩外验未收口。用户库迁移状态、真机启动/旧 ledger 首访性能的剩余证据只在该执行计划记录。后续结构重构吸收其已实现机制，不重复派发旧源码任务，归属见[新方案 §5.2.1](./in-flight/持久化与历史管理边界重构方案.md#521-与旧启动优化方案执行计划的归属)。
- [持久化与历史管理边界重构方案](./in-flight/持久化与历史管理边界重构方案.md) —— D-1–D-4 均已批准 A；[执行计划](./in-flight/持久化与历史管理边界重构执行计划.md) P0–P5 源码出口已标完成，但 2026-10-24 审计纠偏认定 AC-1/4/6/9 未通过、生产 owner 切换关闭，外部验收（R 包/真实库/真机/IM/性能）未做。D-2 继续绑定方案 §7.2.1 的兼容回退包 R。附[基线核验记录与隔离复现](./in-flight/持久化与历史管理边界核验记录-2026-10-21.md)。
- [会话台账拒绝服务清理-最小执行计划](./in-flight/会话台账拒绝服务清理-最小执行计划.md) —— 前置假设：上述重构的**源码出口**已关闭（开工前用计划 §1.2 的五条探针在本 worktree 内确认落点）。目标：拆掉"两份记录互相证明"的校验层，使台账异常时以数据库事实继续，而非拒绝服务。D-1 = B、D-2 = B、D-3 = A、D-3b = 有损重放 均已批准/确认（2026-10-22；物删仍受 R 包与 AC-S8 约束）。判据 AC-S1~S9（含 AC-S5a/S5b/S5c）；落点实测 8 处门禁 / 6 文件（含恢复宿主），压缩事实仍只在文件、无现成重建命令。**第六轮新增 P4-T3 + AC-S9**：待办载荷是执行材料，先改 drain/projector/ack 为按身份从权威生成，再停写与删列；实测积压 tool-result 385 / request-projection 360 / final-context 343 / usage 343 / terminal 28 / retry 16。

> **2026-10-14 核验更正（原判 C 有误）**：`message-fact-persistence-core-refactor-plan.md`、`message-fact-pipeline-prompt-cache-optimization-plan.md` —— 证据：2026-09-09 `refactor(message-fact): persist turn lifecycle in core`；`da010dcb feat(context): add prompt cache breakpoints`。

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
| 存储占用页修复（**merge main 补入**） | 1 | `2026-10-13-storage-settings-refresh-storm-and-compact-busy-fix-plan.md`（v3 已实施 + 评审阻断项 B1–B3 已修复；P5-T10 与 V5–V7 为真机验收项） |

## 相关需求口径

见 [`../../requirement/storage-session/`](../../requirement/storage-session/)（会话标题、列表徽标、消息事实链路需求）。

## 核验记录

- [baseline-check-2026-10-14.md](./baseline-check-2026-10-14.md) —— 基线 `17236274`；断言逐条带可复现命令，含「矛盾与时间线检查」「无法核验项」「抽样复核建议」。

## 取证命令

```text
git log --date=short --format='%ad %h %s' -- electron/sessionStorage electron/storage electron/database
git log --date=short --format='%ad %h %s' -- docs/develop/session-storage-refactor-technical-design.md
```
