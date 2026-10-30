# storage-session 迭代历史

> 本文是流水账：按时间**正序**记录本主题**已发生**的变更，只写有证据支撑的事实。
> 证据源：`git log`（命令见文末）+ 计划/需求档的实施记录章节；冲突时以 `git log` 为准。
> 维护：每次涉及本主题的迭代收尾时追加条目。

## 时间线

| 日期 | 提交 | 变更 | 出处 | 影响与结果 |
| --- | --- | --- | --- | --- |
| 2026-09-30 | `1f6e7940` | 消息事实落库归还 Core：桌面/远程统一走同一生产链路 | `message-fact-production-pipeline-refactor-plan.md`（已归档） | 渲染进程不再自持 `ToolCallRecord`；生产 owner 清理待复审 |
| 2026-10-04 | `c69b5873` | 会话内容切换与清理落地（content cutover + cleanup） | `session-storage-refactor-migration-plan.md`（已归档） | canonical 事件流成为正文真相源 |
| 2026-10-08 | `413674a1` | 新增公共端口并迁移消费者（session-storage public ports） | `session-storage-public-interface-design.md`（现状） | 消费者改走公共端口；接口 v26 |
| 2026-10-08 | `430b2dab` | 处置评审阻断项 | 同上 | 评审 4 项 P1 修复 |
| 2026-10-08 | `9b2c9ecc` | spill 引用建索引并排定回填 | `spill-reference-index-and-backfill-plan.md`（已归档） | 引用可查，回填可重跑 |
| 2026-10-08 | `9806ced6` | 接受「中断续跑」形态的历史 | `failed-turn-continuation-experience-plan.md`（已归档） | 续跑不再被判为非法历史 |
| 2026-10-08 | `47ea5cac` | 分离 turn 身份与 history 身份 | 同上 | 续跑身份不再混用 |
| 2026-10-08 | `8e3c5d12` | 重试查询返回源 turn | 同上 | 续跑依据明确 |
| 2026-10-11 | `21ffca26` | 阻止 win32 目录 fsync EPERM 污染维护水位 | — | 维护任务不再因权限错失水位 |
| 2026-10-13 | `36edb110` | 关闭 Track 隔离与消息 ID 缺口（跨主题：IM） | `2026-10-11-remote-im-intent-track-development-plan.md`（已归档） | 消息 ID 精度与隔离边界收口 |
| 2026-09-09 | — | `refactor(message-fact): persist turn lifecycle in core` | `message-fact-persistence-core-refactor-plan.md`（已归档） | 原判「在途」，核验更正为已实现；需求侧同名文档同批归档 |
| 2026-09-11 | `da010dcb` | 新增 prompt cache breakpoints | `message-fact-pipeline-prompt-cache-optimization-plan.md`（已归档） | 同上 |
| 2026-10-30 | 文档基线 `58d28d76` | 新增全链路性能改进评审草稿 | [会话存储全链路性能改进方案](./in-flight/会话存储全链路性能改进方案.md) | 源码核实追加全前缀校验、控制信息读取正文等成本；只交方案，保留待批取舍与Windows外验，不宣称已修复或已实施 |
| 2026-10-30 | 评审基线 `e9c6aa6f` | 补齐性能方案三处遗漏 | [会话存储全链路性能改进方案](./in-flight/会话存储全链路性能改进方案.md) | 增补F-17～19、U27／28和AC-11～13；核正markers独立effect及live先于summary的顺序，先展示待保存内容另立D-4待批；无代码修改 |
| 2026-10-30 | 前版 `1e59ecfb` | 性能方案回到归属模型重审 | [会话存储全链路性能改进方案](./in-flight/会话存储全链路性能改进方案.md) | 撤下叠加机制与旧实施阶段，补保留／合并／退出清单、恢复反例及模型验收；保留事实证据，格式／迁移详设未完成，不授权代码实施 |
| 2026-10-30 | 源码基线 `a5dd7bb0` | 比较SQLite与JSONL权威路线 | [会话权威存储路线对比](./in-flight/会话权威存储路线对比.md) | 核实终态同事务与退役proof；用相同命令、崩溃及替代清单比较两路线，保留待验证项，无代码改动 |
| 2026-10-30 | 前版 `0cfcbca7` | 补充路线综合评价与本项目使用证据 | [会话权威存储路线对比](./in-flight/会话权威存储路线对比.md) | 从暂倾向改为明确推荐SQLite；补执行历史／查询／状态事务负载、维护与性能约束，未改代码或批准实施 |
| 2026-10-30 | 前版 `bee81fc7` | 主性能方案收敛SQLite详细路线 | [会话存储全链路性能改进方案](./in-flight/会话存储全链路性能改进方案.md) | 补F-20～23消费者、两列同事务状态提案及明确回退DDL、四阶段与12项验收；当前四项边界门禁通过，隔离schema增删实验通过；无代码改动，新格式及回执未批准 |

| 2026-10-31 | 前版 `33d9fae0` | 检查点从事实主线独立 | [主性能方案](./in-flight/会话存储全链路性能改进方案.md)、[检查点机制](./in-flight/会话上下文检查点机制.md) | 统一当前信息存储／检查点／压缩概念；撤回64轮终态全文绑定，主案要求无检查点恢复；独立次级模块只加速恢复，格式和策略仍待详设，无代码改动 |

## 存疑（文档与记录不一致）

- `message-fact-production-pipeline-refactor-requirement.md`（在途）记「待实施」，而其开发方案（已归档）记「实施中：Core、桌面主路径及微信/飞书远程适配已完成阶段性接入」。暂按代码为准，待复核。

## 取证命令

```text
git log --date=short --format='%ad %h %s' -- electron/sessionStorage electron/storage electron/database
git log --diff-filter=R --summary --find-renames -- docs/develop/session-storage-  # 核对搬迁痕迹
```
