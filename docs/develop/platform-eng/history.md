# platform-eng 迭代历史

> 本文是流水账：按时间**正序**记录本主题**已发生**的变更。证据源：`git log`（命令见文末）。

## 时间线

| 日期 | 提交 | 变更 | 出处 | 影响与结果 |
| --- | --- | --- | --- | --- |
| 2026-07-24 | — | 旧工作区布局清理完成（自述 Done） | `legacy-workspace-layout-cleanup-plan.md`（已归档） | 旧路径下线 |
| 2026-08-31 | — | 依赖升级计划（Node / Electron / 工具链）v3 | `dependency-upgrade-plan-2026-08.md`（已归档） | — |
| 2026-10-01 | — | 云 main 恢复（7 篇整组：审计、计划、源清单、提交台账）与本地/云端 main 分叉接入 | `2026-10-01-cloud-main-*`、`2026-10-01-main-divergence-*`（已归档） | 分叉收敛，恢复过程留档 |
| 2026-10-13 | `d6c57138` | 整合本地 main：fence/inventory 适配 + 死文件清理 | — | 本地与远端主线对齐 |
| 2026-10-13 | `6fe55d43` | 清理 7 个零引用死文件及孤儿 i18n key | `main-dead-code-cleanup-audit-and-plan-2026-10-14.md`（本地分析，未入库） | 死代码与孤儿 key 收敛 |
| 2026-10-14 | `879c7d04` | 版本升至 0.2.7 | `release-guide.md`（现状） | 发版流程按指南执行 |
| 2026-10-16 | — | 撤销 Linux 桌面端支持承诺与 AppImage 打包入口；Ubuntu 保留为通用 CI 测试 runner | `package.json`、`release-guide.md` | 支持与发布范围收敛为 Windows/macOS |

## 存疑

- `tech_design.md`（现状）是早期技术设计总纲，与现役架构文档（`docs/develop/architect/`）存在口径重叠；**以 architect/ 与代码为准**，待专项复核后决定是否归档。

## 取证命令

```text
git log --date=short --format='%ad %h %s' -- scripts package.json .github
git log --date=short --format='%ad %h %s' --grep='release' -20
```
