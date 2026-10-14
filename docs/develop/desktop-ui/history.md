# desktop-ui 迭代历史

> 本文是流水账：按时间**正序**记录本主题**已发生**的变更。证据源：`git log`（命令见文末）；冲突时以 `git log` 为准。

## 时间线

| 日期 | 提交 | 变更 | 出处 | 影响与结果 |
| --- | --- | --- | --- | --- |
| 2026-07-22 | — | 聊天消息列表渲染性能：第一/二批默认实施范围落地（含复测门禁与结果） | `chat-message-list-renderer-performance-optimization-design.md`（已归档，v1.6） | 列表重渲染显著下降；复测门禁留存 |
| 2026-09-17 | — | 流式生成抖动修复 J-01～J-04 实施并通过自动化验收（270 文件 / 1647 用例全绿） | `chat-message-list-streaming-jitter-fix-plan.md`（已归档） | 流式抖动消除 |
| 2026-09-30 | — | composer 模型/思考入口开发完成并留验收证据 | `composer-model-thinking-entry-development-plan.md`、`-acceptance-evidence.md`（已归档） | 入口可用，证据归档 |
| 2026-10-03 | `810d38e2` | composer 加号菜单及其需求落地 | `composer-plus-menu-development-plan.md`（已归档） | 菜单项可用 |
| 2026-10-11 | `ba142372` | 远程确认不再出现在桌面端 | — | 确认归属渠道正确 |
| 2026-10-11 | `9c34f7a4` | Wiki 迁移失败上浮 + 迁移 UI 对齐设计系统 | — | 失败可见 |
| 2026-10-13 | `86d613cf` | 列表停止按钮提示按 accepted 分支说真话（Phase 3） | `chat-turn-cancel-tool-conduction-fix-plan.md`（已归档） | 提示与实际取消语义一致 |
| 2026-10-13 | `6fe55d43` | 清理 7 个零引用死文件及孤儿 i18n key | `main-dead-code-cleanup-audit-and-plan-2026-10-14.md` | 渲染层死代码收敛 |

## 存疑

- `渲染进程卡顿优化方案.md`（已归档，v3.25）与 `streaming-ui-performance-analysis.md`（在途，v1.0「分析完成，待实施」）在「流式卡顿」话题上存在重叠：前者已落地多阶段，后者是较晚的独立分析。冲突消解按代码为准，待复核后二选一。

## 取证命令

```text
git log --date=short --format='%ad %h %s' -- src/renderer/components src/renderer/services src/renderer/store
```
