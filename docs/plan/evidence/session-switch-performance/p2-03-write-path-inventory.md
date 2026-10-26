# P2-03 来源定位维护入口清点

日期：2026-10-27  
基线：worktree 当前分支，提交 `3db8de9a`（本轮方案修订前）。

## 写入入口

运行时代码新增 canonical History event 的共享底层事务入口为 `appendSqliteAgentHistoryBatchInTransaction`（`electron/database/agentHistoryStorage.ts`）：它负责创建/绑定 stream、写 event rows、更新 stream version、session event cursor、commit order 与 spill 引用。已核对的上层写入包括：

- `SqliteAgentHistory.appendBatch` → 共享底层事务入口；会在同一事务中处理 canonical message mirror、转录提交及 projection invalidation。
- 接纳用户输入 `appendSessionInputHistoryInTransaction`（`electron/database/operations.ts`）→ 共享底层入口；事件只含 accepted message ID 与 fingerprint，不带正文，不能单独充当正文来源。
- continuation checkpoint resume/retry（`electron/runtime/agentContinuation.ts`）→ 共享底层入口，然后镜像恢复上下文。
- hosted / remote / session commit adapters 调用 `HistoryPort.appendBatch`，最后进入 `SqliteAgentHistory.appendBatch`。

因此，候选来源映射可在底层追加事务中统一维护；只在上层 `SqliteAgentHistory` 接入会漏掉 accepted input 与 continuation 写入。

## 直接修改与删除

- 生产代码检索未发现其他直接 `INSERT` History event 的路径；`scripts/bench-spill-reference-index.mjs` 等命中为基准脚本，不属于运行时。
- `deleteSession`（`electron/database/operations.ts`）在事务中直接删除 session 所有 canonical events/streams，并清理 spill 引用；需确保候选 locator/revision 同事务清理或由外键级联，并由 History delete/stream delete triggers 推进来源修订号。
- SQLite schema 已有 event insert/update/delete 与 stream owner/delete 触发器，可作为 revision fence 的覆盖基点；它们现有职责是撤销 projection eligibility/cache，不提供单调 source revision。
- migrations 中有历史 owner/ordering 回填；迁移完成后 locator backfill 仍要在 session generation 与 History watermark fence 下执行，不能把 migration 的单次 SQL 更新误当成 locator 已就绪。

## 候选实现边界

1. 将 locator 写入放在 `appendSqliteAgentHistoryBatchInTransaction` 的 event append 内，需在事件 schema/转移校验成功后、外层事务提交前完成；幂等重复事件路径不能重复累加依赖。
2. `invocation-context-committed` / `transcript-compacted` 的消息数组会为已出现 ID 建立或替换正文基点；后续 `model-response-committed` 对 assistant 同 ID 增加 response dependency。匿名 tool result 不产生 UI message locator，但 tool lifecycle event 是否必须作为对应 invocation 的 reducer dependency，仍需通过差分原型定案。
3. 大型 payload 的 locator 只能保存 History 坐标与依赖类型，正文仍由 source event/spill 提供；写入端要先用现有 spill descriptor 校验/解析，不能将 source spill locator 当作独立正文副本。
4. 对任意 event UPDATE/DELETE、stream owner/schema 变化及 session 删除，数据库约束/触发器必须使旧目录不可读；只有中心追加函数不能保护直接 SQL 修复与删除路径。
5. 当前 `session_message_content_cutover.message_revision` 覆盖 message identity/body 变更；History event cursor 覆盖追加但不覆盖 UPDATE/DELETE 或 stream 元数据变化。因此候选常量级 fence 还需新的、由 SQLite triggers 单调推进的 session source revision，或等价的已证明方案。

## 可复现检索

```text
rg -n "appendSqliteAgentHistoryBatchInTransaction|INSERT INTO agent_history_events|UPDATE agent_history_events|DELETE FROM agent_history_events|INSERT INTO agent_history_streams|UPDATE agent_history_streams|DELETE FROM agent_history_streams" electron --glob '!**/*.test.ts' --glob '!**/migrations.ts'
```

清点结果显示有一个集中 append 事务可供原子维护，但完整支持需要新增数据库状态和触发器，且要特别覆盖压缩快照、重复写、直接删除与恢复修复。清点本身不批准该 schema，也不代表 locator 逻辑已实现或验证。
