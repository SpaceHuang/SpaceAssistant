# I-01 schema/migration 集成记录（2026-10-05）

## 集成范围

把 `origin/main` v31–v33 产品数据库语义与存储分支 v31–v50 migration chain 组合，并覆盖当前工作区新增 v51 usage identity migration。此步骤仅修改/验收 schema 与迁移路径；未开始 I-02 operations/domain 集成。

## 处理结论

- 产品 main v30→31 continuation intents、turn retry identity，main v31→32 continuation context，main v32→33 automation/session/usage identity 与存储分支相同版本号的 History/canonical migrations 已同时保留。
- main v33 profile 进入存储 v34 前，会幂等补建 canonical repair queue、History cursor/order/session sequence 和 session generation prerequisites；保留 main 已存 continuation、automation、usage 和 fixed work dir 数据。
- branch v46…v50 schema 与当前 workspace v51 usage model identity migration 保留在同一递增迁移链；新增列不重写旧 usage facts。
- 迁移均在 SQLite transaction 内逐版本推进；当前版重复运行保持幂等。

## 验证

- main v30/v31/v32/v33 fixtures：保留主线 continuation/retry/automation/session/usage 字段与行，并验证 canonical History 排序、cursor/generation 补建。对应测试位于 `electron/database/migrations.mainSchemaCompatibility.test.ts`。
- 当前分支 v46…v50 与 v49 active-history-work fixtures 验证后续 canonical migration。对应测试位于 `electron/database/migrations.agentHistory.test.ts` 与 `migrations.sessionContentCutover.test.ts`。
- 新增 file-backed SQLite upgrade/reopen 回归：main v33→v51 后关库重开，逐项核对产品字段、usage identity、History 顺序及 `integrity_check`/foreign keys；branch v46→v51 后重开，确认旧 usage facts 保留、新 identity 列为 NULL 且完整性通过。
- focused migration suites：5 files / 47 tests 通过；扩展 file-backed compatibility suites：2 files / 28 tests 通过。
- `npx tsc -p tsconfig.electron.json --noEmit` 通过；`git diff --check` 通过。
- 已有失败驱动证据见技术设计历史 v365：main v33 fixture 先红于缺少 generation；main v30 fixture 先红于缺少 `retry_of_message_id`，之后补兼容并转绿。

## 限制与状态

fixture 使用隔离 SQLite，不读取真实数据库。main v30–v33 的迁移契约与 branch v46→v51 升级/reopen 已覆盖；对工作区 v51 当前 schema 的重复运行包含在 reopen 后 `runMigrations` 幂等断言中。未修改远端或执行 Git merge。I-01 完成，下一项按顺序为 I-02 session/domain/database operations。
