# platform-eng —— 工程支撑

> 定位：i18n、发版、依赖升级、测试基建、代码治理。
> 主要代码域：全仓（`scripts/`、`src/renderer/i18n/`、`package.json`、CI 配置）。
> 核对基线：`main` `17236274`（2026-10-14）

## 现状文档（留主题目录）

| 文档 | 类型 | 说明 |
| --- | --- | --- |
| [release-guide.md](./release-guide.md) | 指南 | 发版流程（版本号一致性、tag、打包） |
| [i18n-sync-guide.md](./i18n-sync-guide.md) | 指南 | i18n 资源同步：`npm run i18n:generate-types` / `i18n:check` |
| [tech_design.md](./tech_design.md) | 技术设计总纲 | 早期设计说明；与现役架构文档冲突处以 `architect/` 与代码为准 |

## 归档（10 件）

见 [`../archive/platform-eng/`](../archive/platform-eng/)：

| 组 | 说明 |
| --- | --- |
| 云 main 恢复（历史一次性项目，整组归档） | `2026-10-01-cloud-main-feature-recovery-plan.md`、`-audit.md`、`-source-inventory.tsv`、`2026-10-01-cloud-main-516-path-audit.tsv`、`2026-10-01-cloud-main-recovery-source-commit-ledger.tsv` |
| 本地/云端 main 分叉接入 | `2026-10-01-main-divergence-hosted-runtime-integration-plan.md`、`-execution-record.md` |
| 其他 | `automated-test-suite-cleanup-audit.md`、`dependency-upgrade-plan-2026-08.md`、`legacy-workspace-layout-cleanup-plan.md`（Done 2026-07-24） |

## 相关需求口径

见 [`../../requirement/platform-eng/`](../../requirement/platform-eng/)（i18n 架构、后台任务机制移除）。

## 取证命令

```text
git log --date=short --format='%ad %h %s' -- scripts package.json .github
npm run i18n:check
```
