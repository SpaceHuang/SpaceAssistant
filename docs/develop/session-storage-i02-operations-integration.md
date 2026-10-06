# I-02 session/domain/database operations 集成记录（2026-10-05）

## 集成范围

对照 `origin/main` 的 session/domain/database operation 行为与存储分支持久化契约；只覆盖两侧重叠的行/类型/事务与事实字段，不扩展产品能力。

## 契约核对

- **Session**：保留 main 的 `fixedWorkDir`、`workDirProfileId`、thinking effort、ownership/visibility 与 metadata；保留存储分支的稳定 generation、message revision/cutover snapshot 与 canonical cache seed。
- **Turn/continuation**：保留 main 的 retry lineage、source context/continuation acceptance 和 `continuation_intents` 状态；turn、用户/assistant 骨架与 History 首事件的接受事务保持原子。
- **Message skeleton/body**：保留 status、tool/attachment/thinking/segments/skill hints 等消息骨架；正文读写继续服从 canonical-backed 状态和 write-stop/cleanup fence。
- **Usage facts**：保留 main 的 model catalog ID、provider model name、route identity；存储 reader/writer、usage upsert 和孤儿 turn 聚合不丢这些字段。
- **删除/回收**：session 删除先校验 active work 与 cleanup 状态，再维护 canonical spill GC，不破坏主线 session owner 字段。

## 验证

- `electron/database/operations.test.ts`、`usageStatsFacts.test.ts`、`usageStats/usageStatsRecorder.test.ts`、`database/thinkingEffort.test.ts`：4 files / 143 tests 通过。
- 新增 file-backed operation round-trip：创建带 `fixedWorkDir`/thinking/ownership/visibility 的 session，原子接受 continuation/retry turn；关闭重开后核对 session generation、配置、retry lineage、continuation source/target/state 与 SQLite integrity/FK。
- I-01 migration 兼容 suite 已另行覆盖旧 main v33 usage identity 与 v51 字段升级；I-02 不复制同义迁移测试。
- `npx tsc -p tsconfig.electron.json --noEmit` 通过；`npm run typecheck:shared` 通过；`git diff --check` 通过。

验证命令中曾误试不存在的 `tsconfig.shared.json`，TypeScript 返回 TS5058；随后改用仓库定义的 `npm run typecheck:shared` 并通过。这个命令拼写错误不影响实现或最终验证结果。

## 状态

I-02 完成；未发现需要扩大范围的 schema/operation finding。未进入 I-03 History 冲突，下一项按顺序为 I-03 canonical History 与 projection transition。
