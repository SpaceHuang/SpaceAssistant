# P2-01 正文来源与身份更新覆盖

日期：2026-10-27  
基线：P1-R 阶段提交 `21829ba8`  方案：`会话切换性能优化方案.md`  
范围：`sqliteAgentHistory.ts`、canonical History reducer、`chatBodyV1`、History chunk reader、source identity、SQLite 写入/失效、spill 与 transcript 恢复。

## 结论

当前投影正文 `chatBodyV1` 由 canonical History 的消息快照与按消息 ID 读取的同快照 `messages` facts 共同决定。完整正确性还依赖 session sequence/commit order、invocation 内 event sequence 与 terminal 状态、tool-use/result 配对、消息 sequence/role/timestamp/queue scope、cutover authority 和 body 内容。`ProjectionSpec.chatBodyV1` 实际只输出 `id/role/content/timestamp`；thinking、image、tool-use 是重建输入，但不会作为正文文本输出。

当前完整 transcript 路径仍读取并折叠该 session 的全部 canonical event payload；source identity 本身也把全部 History stream ID 拉入并序列化。按页 chunk reader 的 History 行读取是 keyset/budgeted，但每次 permit 的 source identity 仍随 stream 数增长；大型 context staging 还会先统计整个快照事件中所有 message JSON 字节，再分段读每条 message/fact。冷首屏必须重复或重新验证上述映射时，成本不会只由当前页大小决定。

## 事件类型 → 定位 → reducer 依赖 → spill → 样本

| History 类型 | 对正文消息的定位方式 | 完整 reducer 依赖 | spill 现状 | 代表性测试 |
|---|---|---|---|---|
| `invocation-context-committed` | `payload.messages[*].id`；另有 `requiredUserMessage.id` | replace 当前 invocation transcript；消息顺序、role、timestamp、全部正文内容及必要 user message 对照 | >64 KiB 的 string、text/thinking block、image data 可写 source spill；大事件由 segmented staging 处理 | `sqliteAgentHistory.test.ts`：canonical snapshot、large spill、missing spill；`projectionHistoryChunkReader.test.ts`：facts 与大型 context |
| `transcript-compacted` | 同上 | replace transcript；清除此前 pending tool 状态并根据压缩后 assistant/tool messages 重建 pending calls；不可只取最后 N 条事件 | 与 context snapshot 相同；压缩恢复会修复 canonical event 到 session ledger 的投影 | `sqliteAgentHistory.test.ts`：compaction mirror/identity invalidation/recovery；`canonicalHistory` 压缩归约测试 |
| `replay-message-committed` | `payload.message.id`；允许无 ID 的匿名恢复消息，但 session transcript 有意略过匿名 replay | flush 尚未完成的 tool results 后追加 user message；验证角色、内容块及调用边界 | 当前 spill 预处理未覆盖 replay message；正文保持 inline，不能假设所有消息来源已有 spill | `sqliteAgentHistory.test.ts`：valid/invalid replay、anonymous output-recovery replay；`canonicalHistory` replay reducer |
| `model-response-committed` | `payload.message.id`；多条同 ID response chunk 需跨读取 chunk 合并 | flush tool results；追加 assistant body；toolCalls 进入 pending tool-use 状态；跨 page continuation 还要保存 chunked assistant ID/offset | >64 KiB 的 string、text/thinking block spill；image block 不做文本输出，且当前不由该 event 分支 spill | `projectionChatBodyReducer.test.ts`：coalesce、跨 reader chunk 文本连续、serialized checkpoint、tool result 中断与恢复 |
| `tool-call-started` | 不直接定位消息；以 `toolCallId` 绑定之前 assistant 的 toolUse | pending proposal、执行/approval 状态；必须与 model response 的 toolCalls 对应 | 通常小型结构数据 | `projectionCanonicalHistoryReducer.test.ts`、`sqliteAgentHistory.test.ts` proposal/result transition 与恢复样本 |
| `tool-call-finished` / `tool-call-not-dispatched` / `approval-deferred` | 不产生独立 chat message ID；按 `toolCallId` 匹配 pending proposal，结果作为匿名 user tool_result 挂到该 assistant toolUse | toolCall 顺序、结果/错误、结束与拒绝状态；跨 chunk 未闭合状态必须持久化 | `tool-call-finished.result.data` 可 source spill；tool_result 为匿名执行内容，不应作为独立 chat 正文行 | canonical reducer 的 buffered result、flush、未知结果测试；chat body reducer 的 anonymous result continuity |
| `invocation-completed` / `invocation-interrupted` / `invocation-failed` / `invocation-parked` | 不定位正文消息；关闭 invocation fold 并决定是否允许 unresolved calls | terminal kind/status、最后 turn 与最后事件身份；没有 terminal 时不能开始下一 invocation | completed `outputText` 可 source spill；terminal 仍需参与顺序与 fence | `sqliteAgentHistory.test.ts` terminal/restart recovery；canonical reducer invocation boundary 测试 |
| `session-input-committed`、`model-request-started`、`provider-retry-scheduled`、`model-attempt-discarded`、`tool-call-deferred`、`unknown-effect-*`、`approval-waiting/resolved/updated` | 不直接产生 `chatBodyV1` 消息 | 必须保留 History transition 与 invocation 顺序；部分事件参与 request/approval/recovery 状态，不能为正文读取删掉后再假定 tool state 无关 | 按各 payload 写入口处理；不能视作可安全丢弃的未知事件 | SDK History transition 测试、`sqliteAgentHistory.test.ts` malformed/unknown kind 与 recovery 样本 |

### 消息 facts 与身份映射

History chunk reader 仅从 context/compaction 的 `messages`、`requiredUserMessage`，以及 replay/model-response 的 `message` 提取 stable IDs；随后在同一个 SQLite 稳定快照中按 400 个 ID 批次读取 `messages` header/body facts。facts 提供 role、timestamp、sequence、queue scope、content storage state、write mode 与 stored content/digest。`projectCanonicalChatBodyV1` 按消息 ID 对齐，跳过非 desktop queue，校验 role/timestamp/order/authority；缺 fact 或身份冲突失败关闭。此映射依赖的是全页事件 reducer 输出所触及的消息，并不等价于“只读取最新若干条 message 行”。

匿名 tool_result 不需要 message fact；匿名 replay 用户消息不能生成 `chatBodyV1`，`omitAnonymousReplayFromSessionTranscript` 会丢弃它。重复 ID、同 ID assistant chunks、压缩 replace 和跨页 tool-use 状态是按页实现必须继续覆盖的边界。

## Spill 与恢复路径

- `SqliteAgentHistory.appendBatch` 在写入事务前调用 `spillLargeCanonicalPayload`，阈值为 UTF-8 >64 KiB；History event 和 source spill descriptor 在 `agentHistoryStorage.ts` 事务里登记 spill reference owner。
- 已覆盖 source spill 字段：tool-call-finished `result.data`（同 payload 中对应的 sessionLedger result 复用 descriptor）；model-response message string/text/thinking；context/compaction messages 中 string/text/thinking/image data；invocation-completed `outputText`。
- Session transcript checkpoint 另有 `session_transcript_entries.messages_json` spill 与引用 owner，写入/claim/checkpoint/receipt 在同一事务中提交。它服务跨 turn 执行恢复，不是 `chatBodyV1` 的独立正文定位索引。
- chunk reader 严格收集 descriptor，只允许 `source-of-truth` spill，按 descriptor 校验并还原，再重新读 source identity；source 缺失/摘要或长度不匹配、payload 越预算时拒绝当前投影输入。大型快照使用分段临时产物，分段 reader 校验摘要、项目数、fragment index/count，流式 yield 单项。
- `validateCanonicalSessionSourceTruthSpills` 会查找并读取该 session 全部带 spill 标记的 History payload；完整 transcript 恢复/认证因此是全历史 spill 校验。spill GC/reference index 是文件生命周期机制，不提供消息 ID→事件的反向索引。
- 尚无 source spill 的 event 类型会把大内容 inline 存在 History JSON；P2 原型不得把“支持 spill”错误推广为全部事件均是 spill 格式。

## 身份与失效写路径

`readProjectionSourceIdentity` 捕获：session generation；cutover message_revision/write_mode/cleanup_state；按 session_seq 定位的最后 History event 水位；session_event_cursor；该 session 全部 stream invocation IDs。它**不包含每个 stream 的 version/schema_version**，且不读取单事件/消息 body hash。完整 transcript reader 另核验 stream.version、stream.schema_version 与 event sequence 连续性；projection chunk reader 本身主要核对 event/session 顺序与页 payload。需在 P2-02 原型对拍并在 P2-03 决定目录/manifest是否必须携带并验证 stream 元数据，不能把其已受 source identity 覆盖当作既成事实。

| 写路径 | 更新事实 / 失效信号 | 代码/测试落点 |
|---|---|---|
| `appendSqliteAgentHistoryBatchInTransaction` | 原子分配 session cursor、全局 commit_order、event session_seq，写 event 与 stream version；event INSERT trigger 使 session projection invalid 并清 cache | `database/agentHistoryStorage.ts`；`schema.ts` v108；History append/idempotency tests |
| event UPDATE/DELETE 与 stream owner UPDATE/DELETE | 使投影失效、清 cache；owner 变化后旧 session 的 stream 列表与 event join 不一致 | `database/schema.ts` v108；source identity/chunk reader tests |
| `messages` INSERT/UPDATE/DELETE、session generation 变化 | message_revision 递增并撤销 eligibility；UPDATE 对 `cleanup_state=pending` 下只清 canonical-backed-only 镜像正文有精确例外，因为权威 body 未变 | `database/schema.ts` cutover triggers；`migrations.sessionContentCutover.test.ts`、`operations.test.ts` |
| cutover write_mode/cleanup_state/message_revision 更新 | invalidates eligibility/projection state；canonical/dual-write/cleanup 状态属于 body authority | session content authority/maintenance 模块与 `migrations.sessionContentCutover.test.ts` |
| compaction / response recovery / output replay | 追加 `transcript-compacted` 或 `replay-message-committed`，经统一 History batch/cursor/fence 写路径触发相同失效；repair 修复 JSONL/session ledger sidecars | `sqliteAgentHistory.ts` recovery tests（compaction、output truncation、restart repair） |
| session transcript commit / uncertain reconciliation | 增加 versioned snapshot、receipt、checkpoint 和 spill owner；与 canonical terminal / execution lease 同事务耦合；仅凭 checkpoint 不能定位 chat page | `database/sessionTranscript.ts` 与 `sessionTranscript.test.ts` |

## 全历史查询与按页边界

| 读路径 | 工作量/扫描范围 | 对冷页设计的影响 |
|---|---|---|
| `readCanonicalSessionTranscript` / `...ForShadow` | 按 session 读取并 materialize 全部 event payload，按 invocation 分组，validate/fold 全部事件并与 legacy 全量正文对拍；未传已验证标记时还会核对全 DB commit cursor | 正文重建依赖完整 replace/append/tool 状态与历史差分；不能用固定 N 条 tail 代替 |
| `validateCanonicalSessionSourceTruthSpills` | 扫描该 session 所有 spill 标记 payload 并逐一同步读取 source 文件 | 是冷路径的全历史 IO；不能无条件在每页前重复 |
| `readProjectionSourceIdentity` | 除索引水位查询外，读取/排序/JSON 序列化该 session 全部 invocation ID | 无关 stream 数仍线性增加；P0-02/`source-identity-scale.md` 100k stream p95 约 44.5ms、约 2MB JSON |
| `readProjectionHistoryChunk` 普通页 | session_seq keyset + `maxRows/maxBytes`；每个事件 payload 受预算；只为页 reducer 输出 ID 取 facts | History payload 可按页读取，但先决 permit 身份仍含全 stream 清单 |
| oversized context 分段 | 全快照事件形状/JSON 字节合计；逐批复制 messages、读取对应 facts、恢复 spills、写 staging segments | 避免一次内存物化，不代表工作量是页大小；目录/identity若全量读取，会把成本搬到 manifest |
| `appendSqliteAgentHistoryBatchInTransaction` | 为 transition 校验读取该 invocation 全部既有 events 后再追加 | 写路径随单 invocation event 数增长；与 UI 点击冷页不同，但属于并发写/长 WAL 事务评审需单独考虑 |

## 旧数据与覆盖缺口

- 无 stable message ID 的早期 snapshot/replay 数据不能通过 message ID 定位 facts；anonymous tool result 是唯一有意忽略的匿名项。此类正文只能留在旧 reader 或在规范定义中明确不可作为 paged canonical source。
- `agent_history_streams.session_id` 或 `agent_history_events.session_id/session_seq/commit_order` 缺失的迁移前数据不会进入当前有序 session chunk join；完整 canonical reader也要求 session seq 从 1 连续并要求 cursor 与 event 数相等。缺 owner/order 的旧流不可由最后 N 条数据推断归属。
- `sourceIdentity` 未覆盖 stream version/schema_version 是已定位的门禁问题；P2-02 需要注入该字段变更和错版本样本，确认差分 oracle 会拒绝；若拒绝只发生在启动全量审计，分页冷路径仍须有可寻址的持久证明，否则 P2-03 规格不能声称全覆盖。
- 重复 message ID、同一 assistant 跨多个 response event、tool_use/tool_result 跨读取页、compaction replace、requiredUserMessage 引用、匿名 replay、image/tool_use block 往返、未知/旧 schema、source spill 缺失/损坏/变更均应成为 P2-02 的逐种类输入。未被这些样本覆盖的格式维持“旧 reader 兜底/不可投影”，不能静默忽略。

## C1 与审计夹具

C1 命令组按执行计划 §4 运行。`projectionSourceIdentity.test.ts` 额外验证 format/version、generation、message revision、History watermark/cursor、stream IDs 的身份字段和 mutation 响应。首次该夹具把“stream owner 改变后 event watermark 应消失”写成了错误假设：实际 watermark 查询独立按 `events.session_id` 取值，stream owner 由另一个字段列出，chunk reader 的 join 会报告 order invalid；修正为断言保留 watermark、stream 集合变化并使身份 JSON 改变。最终复跑结果见本节下方追加记录。

最终验证（worktree `/Users/space/Documents/Develop/SpaceAssistant/.worktrees/session-storage-boundary-refactor`）：

```text
npm exec -- vitest run electron/sessionStorage/infrastructure/sqlite/projectionSourceIdentity.test.ts electron/sessionStorage/sqliteProjectionBuildTask.test.ts electron/sessionStorage/application/projectionChatBodyCacheReader.test.ts electron/runtime/sessionTranscriptProjection.test.ts electron/sessionStorage/sessionStorage.test.ts --reporter=dot
5 files passed; 191 passed; 6 skipped; 0 failed; 94.82s

npm exec -- vitest run electron/sessionStorage/infrastructure/sqlite/projectionSourceIdentity.test.ts --reporter=dot
1 file passed; 1 passed; 0 failed; 0.73s
```

第一次 C1 同组运行包含错误的夹具断言，结果 4 files passed、190 passed、6 skipped、1 failed；单独修正断言后，完整同组复跑为上列全绿。跳过项属于 C1 既有 skip，未计作通过。此轮未改生产逻辑。
