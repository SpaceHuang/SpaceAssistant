# platform-eng —— 工程支撑

> 定位：i18n、发版、依赖升级、测试基建、代码治理。
> 主要代码域：全仓（`scripts/`、`src/renderer/i18n/`、`package.json`、CI 配置）。
> 核对基线：`main` `17236274`（2026-10-14）

## 现状文档（留主题目录）

| 文档 | 类型 | 说明 |
| --- | --- | --- |
| [release-guide.md](./release-guide.md) | 指南 | 发版流程（版本号一致性、tag、打包） |
| [i18n-sync-guide.md](./i18n-sync-guide.md) | 指南 | i18n 资源同步：`npm run i18n:generate-types` / `i18n:check` |
| [testing-guide.md](./testing-guide.md) | 指南 | 测试基建：Vitest projects 配置、测试文件位置、不变量测试要求 |
| [tech_design.md](./tech_design.md) | 技术设计总纲 | 早期设计说明；与现役架构文档冲突处以 `architect/` 与代码为准 |

## 归档（10 件）

见 [`../archive/platform-eng/`](../archive/platform-eng/)：

| 组 | 说明 |
| --- | --- |
| 云 main 恢复（历史一次性项目，整组归档） | `2026-10-01-cloud-main-feature-recovery-plan.md`、`-audit.md`、`-source-inventory.tsv`、`2026-10-01-cloud-main-516-path-audit.tsv`、`2026-10-01-cloud-main-recovery-source-commit-ledger.tsv` |
| 本地/云端 main 分叉接入 | `2026-10-01-main-divergence-hosted-runtime-integration-plan.md`、`-execution-record.md` |
| 其他 | `automated-test-suite-cleanup-audit.md`、`dependency-upgrade-plan-2026-08.md`、`legacy-workspace-layout-cleanup-plan.md`（Done 2026-07-24） |
| 死代码清理（**merge main 补入**，3 件） | `main-dead-code-cleanup-audit-and-plan-2026-10-14.md`（审计+方案）、`main-dead-code-cleanup-execution-log.md`（执行记录）、`main-dead-code-unused-diagnostic-baseline-2026-10-15.md`（未用诊断基线） |

## 关联过程产物（`docs/superpowers/`，按 §2.5 不搬迁）

- `docs/superpowers/plans/2026-06-03-i18n-phase4.md` + `docs/superpowers/specs/2026-06-03-i18n-phase4-design.md` —— i18n 第四期收尾与验证。该目录由 **Claude Code + superpowers 插件**产出（工具的**过程产物**：开发计划拆解与执行记录），故不入主题体系；口径见 [`../../requirement/platform-eng/需求基线.md`](../../requirement/platform-eng/需求基线.md)

## 相关需求口径

见 [`../../requirement/platform-eng/`](../../requirement/platform-eng/)（i18n 架构、后台任务机制移除）。

## 核验记录

- [baseline-check-2026-10-14.md](./baseline-check-2026-10-14.md) —— 基线 `17236274`；断言逐条带可复现命令，含「矛盾与时间线检查」「无法核验项」「抽样复核建议」。

## 取证命令

```text
git log --date=short --format='%ad %h %s' -- scripts package.json .github
npm run i18n:check
```
