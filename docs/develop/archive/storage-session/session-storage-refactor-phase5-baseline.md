# Phase 5.0 基线与消费者清单

状态：5.0 门禁完成；本文冻结 v37 旧路径行为及 5.1 消费者范围，不表示 canonical-backed cutover 已实施。

## `messages` 列与所有权基线

v37 基线中的 `messages` 共 15 列；v38 在旧列上增添 `content_storage_state`，原有字段与正文保持不变：`id`、`session_id`、`role`、`content`、`tool_use`、`tool_calls`、`thinking`、`content_segments`、`skill_hints`、`attachments`、`images_delivered_to_api`、`status`、`schema_version`、`timestamp`、`sequence`。DDL 位于 `electron/database/schema.ts`。

外键/控制面约束：`session_id` → `sessions(id) ON DELETE CASCADE`；`turns.assistant_message_id` 指向消息并级联删除；`turns.user_message_id` 与 `queue_input_requests.queued_message_id` 在目标消息删除时置空。turn、queue、accepted context 等以消息 ID 关联，故本阶段保留消息行及其身份。

## 消费者旧路径与可复查基线

| 消费者 | 旧路径/权威语义 | 基线证据 |
| --- | --- | --- |
| API context | `getApiContextBaseline` 以 sequence 取最新 500 条升序；`getTurnContext` 处理 boundary、required user、exclude、assistant terminal 和 turn 锚点排序；accepted turn 再校验 History 指纹和附件 | `electron/database/operations.test.ts` 的 `getApiContextBaseline`、`getTurnContext`；`electron/claudeStreamHandlers.context.test.ts`、`electron/butler/butlerInvoker.test.ts`、`electron/remote/imRemoteAgent.test.ts` 的 accepted input 指纹拒绝用例 |
| turn 技能路由 | `getRecentTurnRoutingMessages` 先按资格、boundary/exclude、非空正文筛选，再取尾部 limit 并恢复升序；保留正文原字节。vision 由同资格骨架的 attachments 判定 | `electron/database/operations.test.ts` 的 `turn routing context queries`；含 50,051 条历史、窗口空白 oracle、turn 锚点/boundary/exclude/vision 基线 |
| `reuse-user` | `prepareTurnInternal` 通过 `getMessage(id).content` 取得复用正文，沿用消息 ID、附件、准入与请求指纹 | `electron/appIpc.file.test.ts` 的 reuse-user route oracle；`electron/turnCoordinatorStorage.test.ts` |
| 展示/分页 | Chat 消息页按 `sequence` 读取消息骨架及正文；展示 canonical cutover 由 Phase 2 fence 控制 | `electron/database/operations.test.ts` 的 `getChatMessagePage`；`electron/runtime/sessionTranscriptProjection.test.ts` |
| 搜索 | `getSearchCorpusPage` 按 sequence 分页，排除 queued 消息且游标持续前进；正文消费者还包括 `searchMessages` 的 `content LIKE` | `electron/database/operations.test.ts` 的 `getSearchCorpusPage`；生产入口 `electron/database/operations.ts` |
| preview | append/最后一条编辑时从消息正文维护 session preview；非最后一条编辑不改 preview | `electron/database/operations.test.ts` 的 preview 更新用例 |
| 计数 | append 同事务递增 `sessions.message_count`；计数等于消息骨架行数，清正文不得改计数 | `electron/database/operations.test.ts` 的 `appendMessage stored count` |
| Session capability read | `getMessagesPageWithSequence` 返回 session 历史正文（单条按上限截断） | `electron/capabilities/handlers/session.test.ts`；实现 `electron/capabilities/handlers/session.ts` |
| 远程/管家输入、标题建议 | `getMessages` 提供历史给 IM agent、butler 和标题建议；须视作实际正文消费者 | `electron/remote/imRemoteAgent.test.ts`、`electron/butler/butlerInvoker.test.ts`、`electron/sessionTitleSuggest.test.ts` |
| 恢复/retention/projection repair | `getMessages` 用于 session event retention、旧 UI projection 对拍/修复；不得在旧正文被移除后静默变空 | `electron/storage/sessionEventRetention.test.ts`、`electron/runtime/sessionTranscriptProjection.test.ts` |
| 备份/迁移/配置画像 | JSON snapshot、legacy JSON migration、profile 身份覆盖画像会枚举 `messages.content`；分别属于完整备份、迁移校验及只读诊断消费者 | `electron/database/migrations.v3.test.ts`、`electron/database/sessionStorageProfile.test.ts`；`jsonSnapshot.ts`/`migrateFromJson.ts` 的序列化与样本核验目前无独立单元测试 |
| 其他按 ID 恢复 | turn coordinator、queued receipt、hosted handoff、startup cleanup 经 `getMessage(id)` 读取正文/状态/附件 | `electron/turnCoordinatorStorage.test.ts`、`electron/runtime/hostedTurnHandoff.test.ts`、`electron/shell/startupOrphanCleanup.test.ts` |

## 5.0 oracle 验收记录

- 已有 turn API context 测试覆盖 timestamp 逆序下 sequence 权威、required user 补入、required user/exclude 冲突、失败 assistant 排除及终态规则。
- 路由新增 oracle 检查 50 条窗口边界：窗口尾部两条空白正文时，较早 50 条非空消息仍应入选；并显式断言“先 limit 再过滤”的故意错误结果与期望不相等。另覆盖 turn user 锚点顺序、含 boundary 的包含式边界、exclude 和 vision 附件标记。
- 路由基线固定正文逐字节（保留前后空格）、turn 用户锚点排序、boundary/exclude 及附件 vision 标记。
- 5.0 已完成：消费者表覆盖展示、搜索、preview、计数、API context、turn 路由/reuse-user、能力读取、远程/管家/标题、恢复/retention/projection、备份/迁移/画像及按 ID 恢复。5.5 是否切换由各消费者的清列兼容性门禁决定；目前这些路径仍保留 legacy 正文。数据库操作、prepare-turn IPC、accepted context 聚焦联合回归 113 项通过，完整旧正文快照仍作为后续影子对拍的基线。
