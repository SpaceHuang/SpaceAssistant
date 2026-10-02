# 会话存储重构技术方案：canonical 事件流为真相源，SQLite 降级为索引与投影缓存

| 字段 | 内容 |
| --- | --- |
| 文档状态 | **v4 · 评审修改中**（v1/v2/v3 已评审；B1 回请裁定确认，B6 + F-1…F-4 已处置，**B7 水位线模型错位已修复**，见 §12） |
| 版本 | v1（初稿）→ v2（B1–B5 处置）→ v3（B6 + F-1…F-4 修正）→ **v4（B7 折叠序修复）** |
| 评审记录 | [v1](../review/2026-10-02-session-storage-refactor-technical-design-review.md) · [v2](../review/2026-10-02-session-storage-refactor-technical-design-review-v2.md) · [v3](../review/2026-10-02-session-storage-refactor-technical-design-review-v3.md) |
| 当前门控 | **Phase 0/1 放行；Phase 2/3 维持 P-1…P-5 门控**（F-3 并入 P-4、F-4 并入 P-3、B6 并入 P-5、**B7 折叠序并入 P-2 第一节**） |
| 适用范围 | `electron/database/*`、`electron/sessionEvents.ts`、`electron/runtime/*`、`electron/toolChatLoop.ts`、`packages/agent-sdk/src/history.ts`、`electron/storage/*`、`main.ts` 启动链 |
| 触发问题 | 主库膨胀至 402 MB；启动恢复持续数分钟；窗口迟迟不出 |
| 上游约束 | 不推翻[会话记录事件流持久化重设计方案](./session-record-eventflow-persistence-redesign-plan.md)（已落地）与[消息列表渲染进程性能优化技术方案](./chat-message-list-renderer-performance-optimization-design.md)（已落地） |

## 修订记录

| 版本 | 变更 |
| --- | --- |
| v1 | 初稿：主张把 `events.jsonl` 收敛为唯一真相源，`messages` 降级为可丢弃投影 |
| v2 | **修正真相源定位**：`events.jsonl` 是审计台账而非消息载体（B1 成立），真相源改为 DB 内的 canonical history；并入 B2–B5 处置 |
| v3 | ① **B1 回请裁定为"确认"**——v1 的强判断撤回，"无需扩展事件模型"成立（评审补齐 `toolChatLoop.ts` 写入链实锤，见 §12）；② 处置 **B6**（spill 可丢弃性与保留期的规范级矛盾）；③ 修正 **F-1**（P-1 判据 SQL 用错事件）；④ 修正 **F-2**（台账 `text_delta` 结论错误）；⑤ **F-3** 并入 P-4、**F-4** 并入 P-3 |
| **v4（本版）** | **处置 B7（水位线模型错位）**：v1–v3 的 `seq` 水位线 / `restoreFloor` / one-below anchor / 撕裂尾截断全部默认"每会话一条物理追加日志"，而真相源 `agent_history_events` 是 **per-invocation 分流**（`PRIMARY KEY(invocation_id, sequence)`，流上连 `created_at` 都没有）。本版新增 **§5.12 会话级折叠序**，据此重定义投影水位线（§5.2）、L1 取后缀的形态（§5.3）、并逐行标注 §5.7 崩溃恢复机制的**适用对象**（DB canonical 无撕裂尾）；折叠序并入 **P-2 第一节** |

> **v2 → v3 的定性变化**：v2 的两处"核心事实"证据有误——附录 A 的 P-1 判据用了身份指纹事件（`session-input-committed`）而非上下文提交事件（`invocation-context-committed`），§1.2 又声称台账"未见 `text_delta`"。两处均已更正；**结论方向不变**（台账不作真相源、无需扩展事件模型），但证据链必须在进入 P-1 go/no-go 前是干净的。

---

## 0. TL;DR（v4）

1. **真相源 = canonical history（`agent_history_events`，在 DB/userData 内）**。消息级事件与写入链：
   - `invocation-context-committed`：`payload.messages`（完整 canonical 上下文数组）+ 可选 `requiredUserMessage`（**hosted 主聊天路径每轮提交**，`electron/toolChatLoop.ts:1063-1078`）；
   - `model-response-committed`：`payload.message`（assistant 正文，`packages/agent-sdk/src/turn.ts:1029-1037`）；
   - `tool-call-started/finished/not-dispatched`、`approval-*`、`invocation-completed/failed/interrupted`。
2. **`events.jsonl` 是审计台账**，**不是**消息真相源：它是增量流（含 `text_delta`/`reasoning_delta` 等 chunk，`electron/runtime/agentSdkDesktopObserver.ts:458-465`）、工具入参 JSON 在持久化前被剥离（`partialJson: ''`）、且受 `retention.sessionEvent.maxSessions` 约束（默认 100，超出 `fs.rm`）。
3. **`messages` 表与 `session_transcript_entries` 收敛为投影缓存**（`(session_id, key, ver, seq, val)`），可丢弃、可重建、fail-soft。
4. **膨胀大头在 DB**（`agent_history_events.payload_json` 与 `messages` 正文）。处置是**大文本 spill 到 userData** + **投影缓存化**（B5 要求先做职责迁移）。
5. **spill 分两类，不可混同**（B6）：**真相源 spill**（承载 canonical 正文，不可丢弃、**无保留期**）；**可降级 spill**（仅展示性内容，可有保留期，且必须排除在"逐字节一致"验收之外）。
6. **水位线必须是会话级**（B7）：真相源是 per-invocation 分流表，不存在会话级全序键；折叠序由 **`commit_order`（全局单调）+ `session_seq`（会话内连续）** 双序提供（§5.12），禁止把 per-invocation 的 `sequence` 当会话水位。
7. 渲染契约、IPC 契约、`turns` 状态机语义**均不变**。

**分期**：Phase 0（可观测）与 Phase 1（写侧止血）可立即开工；Phase 2/3 待 P-1…P-5 全部满足（§8.2）。

---

## 1. 现状取证

### 1.1 实测数据（本机）

| 项 | 值 |
| --- | --- |
| 主库 | `%APPDATA%/spaceassistant/spaceassistant-data.db`，**402,722,816 字节（约 384 MB）** |
| WAL | 约 1 MB；`-shm` 32 KB |
| workDir 台账 | `sessions/` 下 8 个会话目录 |
| 单会话台账 | `sessions/f659b1db-…-20261002/events.jsonl` = **8,854,510 字节 / 19,526 事件** |
| 台账索引 | `events.index.json` = 89 字节（seq/eventCount/bytes/lastAt） |
| 导出备份 | 同目录 `messages.json`（`SessionBackupManager` 流式导出，防抖约 3s） |
| userData 遗留 | `bak-spaceassistant-data.json` = 63,922,295 字节（旧 JSON 备份，未清理） |

### 1.2 两条事件流的真实分工

| 维度 | `events.jsonl`（磁盘，workDir） | `agent_history_events`（DB，userData） |
| --- | --- | --- |
| 定义位置 | `electron/sessionEvents.ts:10` `SessionEventType` | `packages/agent-sdk/src/history.ts:8` `HistoryEvent['kind']` |
| 事件全集 | `turn_start` `turn_end` `step_start` `step_end` `assistant_chunk` `tool_call` `tool_result` `request_header` `request_context` `request_usage` `request_retry` `compaction_start` `compaction_summary` `compaction_end` `session_end_seed` | `session-input-committed` `invocation-context-committed` `transcript-compacted` `model-request-started` `provider-retry-scheduled` `model-attempt-discarded` `model-response-committed` `replay-message-committed` `tool-call-started` `tool-call-finished` `tool-call-not-dispatched` `approval-waiting` `approval-resolved` `approval-updated` `invocation-parked` `invocation-interrupted` `invocation-completed` `invocation-failed` |
| 用户消息 | **无独立消息事件**（`session-input-committed` 不在本流） | `session-input-committed` 仅**身份指纹**（`sessionId`/`messageId`/`inputFingerprint`，见 `MIGRATION_V21` 判据）；**正文**在 `invocation-context-committed.payload.messages` |
| assistant 正文 | **有，但是增量 chunk**：`electron/runtime/agentSdkDesktopObserver.ts:458-465` 将 `text-delta` push 为 `{ type: 'text_delta', index, text }`（**v2 称"未见 text_delta"是错的，已更正**） | **有，且是完整消息**：`model-response-committed.payload.message`（`packages/agent-sdk/src/turn.ts:1029-1037`） |
| 工具入参 | 审计事件（`tool_call`）保留入参；`tool_call_delta` 的 `partialJson` 在持久化前被剥离为空串（observer 注释：stripped raw JSON before persistence） | `tool-call-started/finished` 携带工具生命周期 |
| 可重放性 | **增量流**，需按 `index` 拼接 chunk 才能还原正文；无消息级幂等键 | **消息级**，带 `event_id` 唯一 / `idempotency_key` 唯一 / `agent_history_streams.version` CAS |
| 保留策略 | `retention.sessionEvent.maxSessions` 默认 100，超出 `fs.rm` 整目录 | 无（随会话行永久保留） |
| 定位 | **审计台账**（可清理） | **消息级真相源**（不可清理） |

结论：台账不作真相源的理由是**语义层级与生命周期**（增量流 + 可被 retention 删除 + 部分字段落盘前剥离），**不是**"台账里没有正文"——后者是 v2 的错误表述。

### 1.3 其他代码事实

| 事实 | 证据 |
| --- | --- |
| 消息内容在 DB 有三处 | `messages`（正文 + `tool_calls[].result` + `thinking` + `content_segments` + `attachments`）、`agent_history_events.payload_json`、`session_transcript_entries.messages_json` |
| canonical 上下文写入链 | `electron/toolChatLoop.ts:1063-1078`：`appendCanonicalHistory([{ kind: 'invocation-context-committed', payload: { messages, requiredUserMessage? } }])`，**前置条件是 `historyOwnsBase` 为假**（历史中已有 `invocation-context-committed` 或 `transcript-compacted` 时短路，不重复写） |
| 每 turn 一份整会话快照 | `hostedTurnHandoff.ts:326/439` 每 turn 调 `commitSessionTranscript`；`sessionTranscript.ts:34` 整份 `JSON.stringify`，`UNIQUE(session_id, version)` |
| transcript 承担协议职责（B5） | `sessionTranscript.ts:21-24` 幂等比对**逐字节比较 `messages_json`**；`base_version`/`version` 做 CAS；`commit_uncertain` 联动 `session_execution_claims` / `session_execution_queue` |
| 运行时依赖台账（F-3） | `claudeStreamHandlers.ts:376/408/413` 运行时读 `readCompactionMarkers` / `readCompactionReplay` / `readSessionEvents` |
| 双向修复 | `main.ts` 的 `repair*`（canonical 缺 → 从台账补）与 `sessionEvents.ts` 的 `ensure*Event`（向台账写）互为兜底 |
| 落库无截断 | `turnCoordinatorStorage.ts:57` → `appendMessage`（`operations.ts:936`）；出站侧才有压缩（`claudeStreamHandlers.ts:181`，`MAX_TOOL_RESULT_CONTENT_CHARS = 10_000 × 3.5 = 35_000`），而 `READ_FILE_MAX_CHARS = 2 MiB` |
| 无用索引 | `CREATE INDEX idx_messages_content ON messages(content)`（`schema.ts:69`），唯一消费点是 `searchMessages` 的 `content LIKE '%q%'`（`operations.ts:1605`） |
| 写放大 | `appendMessage`（`operations.ts:982`）每插一条执行 `SELECT COUNT(*) FROM messages WHERE session_id = ?` |
| 无空间回收 | 全库无 `VACUUM`/`auto_vacuum`/`incremental_vacuum`/`PRAGMA optimize` |
| 会话删除唯一入口 | `ipc/sessionIpc.ts:149`；`deleteSession`（`operations.ts:340`）显式枚举清理，但不回收磁盘空间 |
| 台账 retention 覆盖面 | 仅对 `workDirState` 调用（多 profile 未覆盖）；`sessionEventRetention.ts:40` 仅 `fs.rm` 目录 + `logAgentEvent`，不联动 DB |

### 1.4 启动时序（`main.ts` `app.whenReady`）

```text
cleanupMcpArtifactsOnStartup
→ openDatabase(dbPath)                     // CREATE_TABLES_SQL + runMigrations(V1→V30，单事务)
→ recoverInterruptedInvocations(...)       // 全量遍历 agent_history_streams，逐个 read() + rebuild
→ cleanupPersistedOrphansOnStartup(listPersistedTurns)
→ cleanupLegacyWorkspaceLayoutOnStartup
→ cleanupStreamingResiduesOnStartup
→ reconcileSessionEventFilesDetailed(workDir) + retention + pruneAgentLogs
→ 各类迁移/清理 + IPC 注册 + initTray + butlerScheduler.start()
→ mainIpcReady = true
→ createMainWindow()                       // 窗口是最后一步
```

1. **窗口创建在整条恢复链末尾**，上游任何一步慢都表现为"托盘在、日志在写、窗口不出"。
2. **迁移是单事务**（`runMigrations` 包住 V1→V30，`schema_meta` 更新也在同一事务内），外部采样只能看到上一个已提交版本；"停在 V28"既可能是卡在迁移事务内，也可能是上一轮被强杀后回滚重跑，**不能**证明"卡在恢复阶段"。该写法需修（§5.11）。

---

## 2. 问题归因

### 2.1 三个体积放大器

| # | 位置 | 机制 | 量级 | 定性 |
| --- | --- | --- | --- | --- |
| A | `session_transcript_entries.messages_json` | 每 turn 一份整会话快照 | O(n²) | 真放大器，但**承担协议职责**，须先迁移（B5） |
| B | `agent_history_events.payload_json` | 每事件一行、payload 全文（含 `message` 正文与 `requestSnapshot`） | O(事件数 × payload) | 真放大器，且是**真相源**：只能外置大文本，不能删 |
| C | `messages.content`/`tool_calls`/`thinking` | 落库无截断 | O(会话总文本) | 真放大器；随投影化收敛 |

### 2.2 只增不减

- 无 `VACUUM`/`auto_vacuum`：`deleteSession` 后空间留在 freelist，不归还文件系统。
- 主库无按时间/体积的保留策略（只有 usage 统计、agent 日志、台账 JSONL 有）。
- userData 残留 63 MB 的 `bak-spaceassistant-data.json`，无人清理。

### 2.3 根因：同一份消息被两条独立流水各写一遍

| 数据 | 真实角色 | 问题 |
| --- | --- | --- |
| `agent_history_events` | **消息级真相源**（含正文、含幂等/版本） | 体积无界（payload 全文），且**从未被用于生成 `messages`** |
| `messages` | 展示/路由载体，**实际扮演权威**（`updateMessageContent` 是写入路径） | 与真相源内容重复；无截断；被 FK/sequence/状态机深度依赖 |
| `session_transcript_entries` | 每 turn 全量重写 + 承担版本/幂等/准入职责 | O(n²) 体积，职责与 canonical `version` 重叠 |
| `events.jsonl` | 审计台账（增量流，可清理） | **不应**作为消息真相源 |

assistant 正文经 `updateMessageContent` 进 `messages`，同一份内容又经 `model-response-committed` 进 canonical history；恢复路径信任 canonical，渲染路径信任 `messages`，于是必须双向兜底（`repair*` + `ensure*Event`）。**膨胀与启动慢都是这条双写的下游症状。**

### 2.4 写放大与索引负担

`appendMessage` 的 `COUNT(*)`（会话越长越慢）；`idx_messages_content` 把正文再抄一份进 B-tree（前置通配符用不上）；库越胖 → B-tree 越深、overflow page 链越多 → 读写双边退化。

### 2.5 启动恢复全量重放

`runtime/sqliteAgentHistory.ts:322-326`：每次启动 `SELECT ... FROM agent_history_streams`（全表），对**每个** invocation `await this.read(id)`（读全部事件 + `JSON.parse`）再 `rebuildInvocationStates`，**不区分是否需要恢复**。这一条**与是否投影化无关，可独立先行**（Phase 1）。

---

## 3. 参照实现可复用的决策

沿用 `F:\Develop\deepseek-harness` 的机制（只取机制，不取框架）：D1 仅追加日志即真相源、D2 投影 = 纯折叠、D3 投影缓存可丢弃、D4 读阶梯三档、D5 不存指针只存水位线、D6 大文本外溢、D7 崩溃不修日志、D8 列表零 I/O。

**本仓库的映射修正**：D1/D2 的"真相源"指向 `agent_history_events`，**不是** `events.jsonl`：

- D1 的适用对象是 canonical history 的"仅追加 + 永不重写（DB 事务原子，**无尾部撕裂**；撕裂尾语义归文件侧，见 §5.7）"；
- D2 的折叠输入是 canonical 事件（`model-response-committed.payload.message` → assistant 消息投影）；
- 台账 `events.jsonl` 在参照实现里**没有对应物**（本仓库特有的审计层），其保留策略独立，但**运行时确实依赖它做 compaction 重放**（F-3，见 §8.2 P-4）。

---

## 4. 目标架构

### 4.1 分层职责（B6 修正后）

| 层 | 介质 | 存什么 | 权威性 | 可丢弃 | 可保留期删除 |
| --- | --- | --- | --- | --- | --- |
| canonical 事件流 | DB（`agent_history_events`，userData） | 全部消息级事件 + 幂等键 + 版本 | **唯一真相源** | 否 | 否 |
| **真相源 spill** | 文件（**userData**/spill/） | canonical 事件里被外置的**正文级**载荷 | **真相源的存储后端** | **否** | **否（无保留期）** |
| **可降级 spill** | 文件（**userData**/spill-degraded/） | 仅用于展示/排障的**冗余**副本（如超长工具结果的可读副本） | 派生 | 是 | 可（按保留期） |
| 会话索引 | DB | `sessions` 元数据 + `revision` + 投影提示 | 权威（元数据） | 否 | 否 |
| 投影缓存 | DB（per-record） | 读模型 + 水位线 | 派生 | **是** | 是 |
| 流程状态 | DB | `turns` 状态机、确认、投递、续跑、准入 | 权威 | 否 | 否 |
| 审计台账 | 文件（workDir `sessions/`） | turn/tool/request/chunk 审计 | 审计（非真相源） | **是** | 是（受 P-4 约束） |
| 导出备份 | 文件（workDir） | `messages.json` | 派生 | 是 | 是 |

**B6 的处置**：v2 把 spill 同时描述为"不可丢弃"与"按保留期管理"，规范自相矛盾。v3 按**内容性质**切成两类，并给出判断规则：

- 若该文本是**恢复/续跑/API 上下文所必需**的正文（即 canonical 事件的语义组成部分）→ **真相源 spill**：不可丢弃、**无保留期**，删除即等于删真相源；
- 若该文本只是**可读副本 / 排障副本 / 冗长展示**（丢失后仍可由 canonical 折叠出等价读模型）→ **可降级 spill**：受保留期约束，且**必须排除在"逐字节一致"验收之外**（§9.5 相应限定为"真相源集合内逐字节一致"）。

### 4.2 文件布局

```text
%APPDATA%/spaceassistant/
  spaceassistant-data.db          # canonical 事件流 + 索引 + 投影缓存 + 流程状态
  spill/                          # 真相源 spill（无保留期）
    <sessionId>/<callId>-<label>.txt
  spill-degraded/                 # 可降级 spill（有保留期）
    <sessionId>/<callId>-<label>.txt
<workDir>/sessions/<id>-<date>/   # 审计台账（受 P-4 约束）+ 用户可见导出
  session.json
  events.jsonl
  events.index.json
  messages.json                   # 可重建导出
```

**B3 的处置**：canonical 事件流与两类 spill 均落在 **userData**，不随 workDir 被 `git clean`、拔盘、删除 profile 而丢失；workDir 台账因而不承担真相源职责。

### 4.3 DB 表清单

**A. 原样保留（流程状态与控制面）**

`schema_meta`、`configs`、`scope_versions`、`sessions`（元数据部分）、`turns`、`queue_input_requests`、`session_execution_claims`、`session_execution_queue`、`accepted_turn_contexts`、`agent_continuations`、`confirmation_submissions`、`confirmation_commit_audits`、`decision_cache`、`policy_rules`、`automation_tasks`、`automation_task_runs`、`driver_deliveries`、`driver_delivery_events`、`usage_step_facts`、`usage_turn_facts`、`session_usages`、`search_history`。

**B. 保留但改造**

| 表 | 改造 | 依据 |
| --- | --- | --- |
| `agent_history_events` | 保留结构列（`invocation_id`/`sequence`/`event_id`/`idempotency_key`/`turn_id`/`kind`）+ **新增 `session_id` / `commit_order` / `session_seq`（B7 折叠序，§5.12）** + `payload_json` 的正文级字段外置为**真相源 spill locator** | 真相源不删，只外置；会话级水位需显式全序 |
| `agent_history_streams` | 保留（`version` CAS、`session_id` 归属）——**升格**为消息投影的版本权威 | B5 |
| `messages` | 骨架列保留（`id`/`session_id`/`role`/`status`/`sequence`/`timestamp`/`schema_version`/`images_delivered_to_api`）+ 工具调用元数据；正文列改为**投影缓存** | 主线 |
| `session_transcript_entries` | **职责合并**：版本/幂等/准入职责迁到 `agent_history_streams.version` + `idempotency_key`；仅保留必要的 checkpoint 状态机，正文不落 DB | **B5** |
| `session_transcript_checkpoints` | 保留（`commit_uncertain` 状态机）；`version` 语义与 canonical 版本对齐后收敛 | B5 |

**C. 新增**

| 表 | 用途 |
| --- | --- |
| `session_projection_cache` | per-record 投影缓存：`session_id`、`key`、`ver`、`session_seq`、`commit_order`、`event_count`、`val`、`updated_at`；PK `(session_id, key)`（B7 双水位） |
| `session_storage_index` | 列表零 I/O：`session_id`、`revision`、`size_bytes`、`event_count`、`format_version` |
| `spill_index` | `locator`、`session_id`、`tool_use_id`、`bytes`、`sha256`、`created_at`、**`class`（source-of-truth / degradable）**（B6） |
| `agent_history_commit_cursor` | 全局单调序分配器：`id INTEGER PRIMARY KEY AUTOINCREMENT`、`allocated_at`（B7） |
| `session_event_cursor` | 会话内连续序分配器：`session_id` PK、`next_seq`（B7） |

**D. 废弃**

| 项 | 处置 |
| --- | --- |
| `idx_messages_content` | 删除（唯一消费点无效）；搜索改 FTS5 或走 spill 文件扫描 |
| `session_transcript_entries.messages_json` 正文 | 退役（职责先迁移） |
| 双向 `repair*` ↔ `ensure*Event` | 收敛为单向（§5.1） |
| `bak-spaceassistant-data.json`（63 MB） | 一次性清理（Phase 0） |

---

## 5. 关键机制设计

### 5.1 真相源与写路径收敛

- **真相源**：`agent_history_events`（canonical history）。不变量沿用 D1/D7：**仅追加、永不重写**、修复是读方职责；其中"只截断撕裂物理尾"**仅适用于文件侧**（台账 / spill），DB canonical 无此概念（§5.7）。
- **写路径收敛目标**：assistant 正文**一次写入 canonical**，`messages` 变为其投影产物；`updateMessageContent` 降级为"投影更新"。
- **单向兜底**：canonical 缺失时从台账重建是**补偿**（并留痕），台账缺失不得反过来影响 canonical 语义。禁止继续双向互修。
- **写者所有权**：同进程多入口（桌面/飞书/微信/butler）须保证同一 session 只有一个活跃写句柄（复用 sink registry 思路 + `session_execution_claims.generation` 栅栏）；不引入跨进程文件租约。
- **持久性语义按介质区分**（B7）：DB canonical 依赖**事务提交**（提交即持久，WAL + `synchronous=NORMAL`）；"`append` 尽力而为、`flush` 为持久性屏障"的语义**只属于文件侧**（台账 sink、两类 spill），不得移植到 canonical。

### 5.2 投影缓存（`session_projection_cache`）——B7 修正后

```sql
CREATE TABLE IF NOT EXISTS session_projection_cache (
  session_id   TEXT NOT NULL,
  key          TEXT NOT NULL,   -- 'messages' | 'title' | 'context-summary'
  ver          INTEGER NOT NULL,-- 单元 stateVersion
  session_seq  INTEGER NOT NULL,-- 会话内连续水位线（-1 = 空）：L1 取后缀的依据
  commit_order INTEGER NOT NULL,-- 全局单调水位线（-1 = 空）：跨 stream 合并排序的依据
  event_count  INTEGER NOT NULL,-- 该水位处本会话已折叠事件数：缩短检测（备选方案用）
  val          TEXT NOT NULL,   -- 纯 JSON
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (session_id, key)
);
```

规则：**per-record**、**fail-soft**（写失败只 warn，下次自愈）、**`ver` 门控**（失配即丢弃，绝不前向应用）、**水位线必须成对记录**（`session_seq` + `commit_order` + `event_count`，任一缺失即视为水位不可用并升级 L2）、**`val` 为 detached 副本**。

> **B7**：v1–v3 的 `seq` 直接借用了 per-invocation 的 `sequence`，而真相源是 per-invocation 分流表、不存在会话级全序键，该字段在实现上无法定义。水位线的来源与语义见 **§5.12**。

### 5.3 读阶梯（三档）——B7 修正后

| 档 | 触发 | 动作 | I/O |
| --- | --- | --- | --- |
| L0 | 会话列表、标题 | 只读 `session_storage_index` + `ver` 匹配的缓存行 | 无 |
| L1 | 打开会话、resume | 取 `ver` 匹配且水位可用的行作 seed；取 `session_seq > 缓存水位` 的**会话内后缀**，跨 stream 按 `commit_order` **合并排序**后折叠 | O(增量) |
| L2 | 缓存缺失 / `ver` 失配 / 水位不可用 / 缩短检出 | 从 `session_seq = 0` 折叠该会话全量 canonical | O(全量) |

**one-below anchor（前提修正）**：该机制原本依赖"每会话一条物理追加日志、会话内序号连续"，因此**仅在会话级序号连续时成立**。双序方案下读取起点取 `session_seq = 水位 - 1`，"空尾读"即可证明会话日志已缩短到水位以下（崩溃修复截断 / 归档），从而拒绝陈旧行并升级 L2。

**备选方案（不引入 `session_seq`）**：只以 `commit_order` 为水位时号段稀疏（被其它会话占用），"空尾读"不再能证明缩短，须退化为**计数校验**——比对 `event_count` 与 `COUNT(*) WHERE session_id = ? AND commit_order <= 水位`，不等即升级 L2（检测能力由"结构性证明"降级为"计数比对"）。

### 5.4 为什么本方案不需要"扩展事件模型"（B1 裁定后）

| B1 前置 | 状态 |
| --- | --- |
| 扩展事件模型 | **不需要**——canonical 已有消息级事件；写入链经 `electron/toolChatLoop.ts:1063-1078` → `InvocationHistoryWriter` → `agent_history_events`（v1 评审漏追该链，v2 回请后已由其补齐实锤） |
| 改造写入路径 | **仍需要**：assistant 正文须"一次写 canonical、投影到 messages"；`updateMessageContent` 与 `appendMessage` 降级为投影更新 |
| 定义折叠语义 | **仍需要**：`thinking`/`content_segments`/`attachments`/`status`/`images_delivered_to_api` 与 canonical 事件的映射需逐字段定义（P-2） |
| 历史覆盖度验证 | **仍需要**：`historyOwnsBase` 短路意味着**同一 stream 内 `invocation-context-committed` 只写一次**，且被 `transcript-compacted` 的 stream 不再补写 → 覆盖度判据必须按此设计（P-1） |

### 5.5 checkpoint 时机与节流

强制点：**会话创建**、**`turn/end`**、**会话处置（live→cold）**；节流 write-behind：事件计数（默认 64）或时间窗（默认 2000 ms）任一触发；`close`/`shutdown` 同步排空。

**fail-soft 边界**：下列**不得**套用缓存式 fail-soft——工具确认提交（`confirmation_*`）、投递意图（`driver_deliveries`）、续跑 checkpoint（`agent_continuations`）、执行准入（`session_execution_*`）、`commit_uncertain` 状态机、**真相源 spill 的写入**。仅投影缓存、标题、列表提示、用量归因、可降级 spill 可 fail-soft。

### 5.6 大负载外溢（spill）——B3/B4/B6 处置

| 项 | 真相源 spill | 可降级 spill |
| --- | --- | --- |
| 内容性质 | canonical 事件的语义组成部分（正文级） | 可读/排障副本，**冗余**于 canonical |
| 位置 | `userData/spill/` | `userData/spill-degraded/` |
| **可丢弃** | **否** | 是 |
| **保留期** | **无**（B6：删除即等于删真相源） | 有（配置驱动） |
| 写侧失败 | 保持内联，**不**把成功调用变成 `isError`（best-effort） | 同左 |
| 读侧失效 | **硬失败**（`SPILL_CONTENT_UNAVAILABLE`）：禁止静默降级为空内容 | 降级占位（"[内容已归档]"），不报错、不阻塞 |
| 与续跑的关系 | 续跑依赖它 → 必须纳入**不可 fail-soft 集合**；保留期内禁止删除，删除前校验无活跃续跑引用 | 续跑**不得**引用 |
| 逐字节一致验收 | **纳入** | **排除**（B6 要求显式排除） |
| 共同规则 | 触发阈值 `SPILL_INLINE_MAX_BYTES`（建议 64 KiB，与 `MAX_TOOL_RESULT_CONTENT_CHARS` 分离）；事件内保留 `{head, tail, bytes, sha256, locator}`（**首尾保留**）；`open(path,'wx',0o600)` 私有目录；locator 视为**不透明**值，消费方不得解析 | 同左 |

**定稿要求**：两类 spill 的边界判定规则（"这段文本是否恢复/续跑所必需"）必须在 P-5 固化为可执行判据，禁止按大小或按路径猜。

### 5.7 崩溃恢复：不修日志，修复在读方（B7：逐行标注适用对象）

**关键前提**：canonical history 位于 **DB 内**，写入是**事务原子**的（整批提交或整批回滚），因此"物理追加日志"的撕裂尾概念**整体不适用于它**。下表逐行标注每个机制的适用对象。

| 情形 / 机制 | 适用对象 | 处置 |
| --- | --- | --- |
| 撕裂物理尾 / 部分写入 | **仅文件**：审计台账 `events.jsonl`、两类 spill、导出备份。**不适用 DB canonical**（无部分提交） | 文件侧由写路径在第一次新写入前截断或丢弃不完整帧；读方永不返回撕裂内容 |
| 中途崩溃的轮次（有 start 无 end） | canonical（**事件级语义中断**，与物理撕裂无关） | **不截断**；resume 计算 closers 作为普通批次追加，不执行任何副作用 |
| 只读观察方（列表/搜索） | 全部（canonical + 台账） | **仅内存配平，不回写** |
| `recoverInterruptedInvocations` | canonical | **改为按需**：一条 SQL 找出"非终态"流，只对这些流做尾部读取与收口（**Phase 1 可先行**） |
| `append` 尽力而为 / `flush` 为持久性屏障 | **仅文件**（台账 sink、spill）。**不适用 DB canonical** | DB 侧事务提交即持久（WAL + 现有 `synchronous=NORMAL`）；`flush` 语义退化为 WAL checkpoint。见 §5.1 |

> 台账侧的撕裂尾修复沿用[已落地方案](./session-record-eventflow-persistence-redesign-plan.md)（fail-stop、丢失量诊断）；本方案不改其语义。

### 5.8 保留期与空间回收（B6 修正后）

| 层 | 策略 |
| --- | --- |
| canonical 事件流 | 永久 |
| **真相源 spill** | **永久**（无保留期；只随其所属会话删除而删除） |
| 可降级 spill | 按配置保留期清理（留痕） |
| 投影缓存 | 可无条件丢弃；提供"清空缓存"入口（下次读为 L2） |
| 审计台账（workDir） | 保留 `maxSessions` 语义，但：① **必须覆盖所有 profile 根目录**；② 删除**必须联动**校验"DB 依赖与该会话的 compaction 重放需求"（P-4，含 F-3）；③ 归档优先于删除 |
| **B2 顺序约束** | retention 改造**不得晚于**投影化：两者必须**同一提交边界**，否则窗口期内台账删除会删掉用户唯一可见的历史载体 |
| 空间回收 | `PRAGMA optimize` + 定期 `wal_checkpoint(TRUNCATE)`；`auto_vacuum=INCREMENTAL`（需一次全量 `VACUUM` 生效）+ 按需 `incremental_vacuum(N)`；VACUUM 需窗口可见后、无活跃 turn、WAL 已 checkpoint |
| 显式入口 | 设置页"存储占用"面板（按分类显示 + 清缓存 + 归档 + 压缩带进度），**分类须区分两类 spill** |
| 逃生通道 | `--safe-db-maintenance`：跳过全量恢复 → 归档/清缓存/VACUUM → 正常启动 |

### 5.9 失效与代际

`session_storage_index.revision`（size + mtime 派生或提交时递增）作为派生读取缓存的变更令牌，**写所有权变动不改变 revision**；渲染侧沿用 `scope_versions` + `scope:invalidated` 广播，不改。

### 5.10 台账文件格式演进（可选）

现为原始 JSONL。进阶：分帧 + checksum + 压缩帧（gzip/brotli，Node 内置 `zlib`）。**不作为前置依赖**；且因 F-3（运行时 compaction 重放依赖台账），格式变更需与 P-4 一并评估。

### 5.11 迁移事务拆分

`runMigrations` 把 V1→V30 放在单个事务里，导致外部只能看到上一个已提交版本（取证困难）、任一步慢表现为整段慢。**改为逐步事务 + 每步提交后写 `schema_meta`**。

### 5.12 会话级折叠序（B7 修复）

**问题**：水位线、L1 取后缀、one-below anchor 三者的共同前提是"每会话一条物理追加日志、会话内序号连续"。真相源 `agent_history_events` 是 **per-invocation 分流表**，不满足该前提。逐键核验：

| 候选键 | 可否作会话级全序 | 原因 |
| --- | --- | --- |
| `PRIMARY KEY(invocation_id, sequence)` | **否** | 仅在单个 invocation 内有序；换 stream 后 `sequence` 从 1 重新开始 |
| `agent_history_streams` 各行 | **否** | 列仅 `invocation_id`/`version`/`schema_version`/`session_id`——**没有任何时间或序信息** |
| `agent_history_events.created_at` | **否** | 毫秒级，同批写入必碰撞；且无单调保证 |
| 隐式 `rowid` | **否** | 表非 `INTEGER PRIMARY KEY`，VACUUM / 删除后可能重排与复用 |
| `turns.created_at` + 会话内 turn 串行 | **仅近似** | 时钟碰撞；且一个 turn 可能对应多次 provider 请求（多个 invocation） |

**主方案：双序**

1. **`commit_order`（全局单调）**——表 `agent_history_commit_cursor(id INTEGER PRIMARY KEY AUTOINCREMENT, allocated_at INTEGER NOT NULL)`；`appendBatch` 在**同一事务内**为本批分配连续号段，写入 `agent_history_events.commit_order`（普通 `INTEGER NOT NULL` 列），并以冗余列 `session_id` 建索引 `(session_id, commit_order)`。
   - 作用：跨 stream 的**确定性全序**（多 stream 折叠顺序、恢复重放顺序）。
   - 注意：SQLite 无法给既有表添加 `AUTOINCREMENT` 列，故采用"分配器表 + 普通列"，**不依赖 rowid**。
2. **`session_seq`（会话内连续）**——表 `session_event_cursor(session_id TEXT PRIMARY KEY, next_seq INTEGER NOT NULL)`；同一事务内 `INSERT … ON CONFLICT(session_id) DO UPDATE SET next_seq = next_seq + ?` 分配，写入事件行 `session_seq`。
   - 作用：会话内**连续**序号，使 one-below anchor 的"空尾读 → 证明缩短"重新成立。
   - 争用：同会话写入本已由 FIFO 准入串行（`session_execution_queue`），无额外竞争。

**备选方案**（若评审认为新增 cursor 表成本偏高）：只用 `commit_order` + **计数校验**（§5.2 的 `event_count`），放弃空尾证明；代价是每次 L1 多一次 `COUNT(*)`，缩短检测由结构性证明降级为计数比对。

**历史回填**：既有行按 `(created_at, invocation_id, sequence)` 排序一次性回填两个序号。该顺序为**近似值**（受毫秒碰撞影响），因此：

- 回填后**所有既有投影缓存行必须作废**（水位不可用 → 触发一次 L2 全量折叠）；
- P-1 报告须显式声明回填序的近似性与影响面。

**对其它章节的影响**：§5.2（水位字段成对）、§5.3（L1 与 anchor）、§5.7（适用对象）、§4.3（新增表与列）。**本节的折叠序定义是 P-2 语义表的第一节。**

**迁移成本**：新增 2 张表 + 事件表 3 列（`commit_order`/`session_seq`/`session_id`）+ 1 个索引；`DB_SCHEMA_VERSION` +1。属 Phase 2 前置，**不阻塞 Phase 0/1**。

---

## 6. 渲染进程影响评估

结论：**渲染契约不变，列表加载不会变慢**（前提是实现约束被遵守）。

事实基础：首屏/最新页 `fetchMessagePage({ sessionId, limit: 60 })`（`ChatView.tsx:250/352`）；向上翻页按 `beforeSequence` 游标 60 条（`displayPageLoader.ts`）；搜索语料 200 条（`chatSearchCorpus.ts:23`）；列表为 `react-virtuoso@4.12.8` 窗口化；`apiContextService` 独立且禁止读 `displayEntries`。

| 场景 | 评估 |
| --- | --- |
| 侧边栏列表 | 略快：L0 零 I/O |
| 打开会话首屏 60 条 | 取决于装配实现；非"每页读盘"（L1 缓存 seed + 尾重放） |
| 向上翻页 60 条 | 同上；命中内存 LRU 则零盘 |
| 流式更新 | 不变 |
| 搜索 | 命中 → 跳转 → 加载该页，与分页同构 |
| **API 上下文构建（前 500 条）** | **最大风险点**：必须读全量正文；须做活跃会话驻留 + 顺序读 + p95 门禁 |

实现约束：① 主进程装配一页时批量合并读取，禁止逐条 `open/read/close`，禁止渲染进程直读文件；② 内容按会话顺序追加，保证同页正文物理相邻；③ 主进程按"当前会话最近 N 页"做内存 LRU；④ `SPILL_INLINE_MAX_BYTES` 按实测校准。

---

## 7. 兼容与迁移

| 原则 | 做法 |
| --- | --- |
| 双读兼容 | 有 `ver` 匹配的投影缓存行 → L1/L0；否则 L2 全量折叠。旧肥行无需一次性迁移 |
| 只对新数据生效 | 新会话走新分工；老会话按需懒迁移（**取决于 P-1 覆盖度结论**） |
| 分批可中断 | 后台迁移按会话分批，每批事务提交，可中断续跑 |
| schema 迁移 | 新表 `CREATE TABLE IF NOT EXISTS`（幂等）；`DB_SCHEMA_VERSION` +1/+2；迁移步骤拆分（§5.11） |
| 回滚 | 保留旧读路径开关，可回退到 `session_transcript_entries` 作为消息来源 |
| 不静默丢数据 | 缓存丢弃、台账归档/删除、可降级 spill 清理必须留痕（区间 + 数量 + 类别） |

---

## 8. 分期实施与 TDD

### 8.1 分期状态

| 阶段 | 状态 | 说明 |
| --- | --- | --- |
| Phase 0 可观测 | **放行** | 不改行为 |
| Phase 1 写侧止血 | **放行** | 低风险、即时收益 |
| Phase 2 投影化 | **门控** | 待 P-1…P-5 全部满足，且与 retention 改造同一提交边界（B2） |
| Phase 3 spill + 恢复按需 | **部分放行** | 仅"恢复按需化"归入 Phase 1；两类 spill 定稿（B6）后另行推进 |
| Phase 4 回收与保留 | **部分前移** | retention 联动（B2/P-4）前移至 Phase 2 边界 |
| Phase 5 messages 纯投影化 | **暂停** | 高风险，需单独评审 |

### 8.2 Phase 2/3 的解除条件（**必须先满足**）

| 编号 | 前置 | 验收证据 |
| --- | --- | --- |
| P-1 | **canonical 覆盖度量化**（判据见附录 A，**已按 F-1 修正**）：按 `invocation-context-committed` + `model-response-committed` 统计覆盖，并单列"仅有 `session-input-committed` 指纹"与"经 `transcript-compacted` 压缩"两类 | 覆盖率报告（按会话数/消息数双口径）+ 判据说明 |
| P-2 | **逐字段折叠语义表**，**第一节必须是"折叠序 + 多 stream 折叠策略"**（B7）：会话级全序的来源（`commit_order` / `session_seq`）、跨 invocation 的合并规则、回填序的近似性与缓存作废策略；其后才是 `role`/`content`/`thinking`/`tool_calls[].result`/`content_segments`/`attachments`/`status`/`sequence`/`images_delivered_to_api` 与 canonical 事件的映射（含无法映射字段的处置） | 语义表（含折叠序一节）+ 等价性对拍用例通过 |
| P-3 | **transcript 职责迁移**（B5 + **F-4**）：版本/幂等/准入职责迁到 `agent_history_streams.version` + `idempotency_key`；**必须补"同一 turn 重复提交"的红绿场景**——快照级幂等（逐字节比 `messages_json`）与事件级幂等（`idempotency_key`）语义不等价，须证明迁移后"重复提交结果与一次性提交等价"且撤销修复时用例转红 | 迁移设计 + 红绿用例（含同 turn 重复提交、跨重启重放） |
| P-4 | **retention 联动可用**（B2 + **F-3**）：台账删除前校验 DB 依赖；覆盖全部 profile；**并把"运行时 compaction 重放依赖台账"纳入设计**（`claudeStreamHandlers.ts:376/408/413`），给出替代来源或保留例外 | 用例：删台账不影响 DB 可折叠数据；多 profile 全覆盖；compaction 重放在台账缺失时仍可用（或有明确例外清单） |
| P-5 | **两类 spill 语义定稿**（B4 + **B6**）：真相源/可降级 的分类判据、读侧失效语义（硬失败 vs 降级占位）、保留期只作用于可降级类、"逐字节一致"验收的适用范围 | 语义设计 + 判据 + 用例（含真相源 spill 不可被保留期删除的断言） |

**在 P-1…P-5 全部满足前，不进入 Phase 2/3。**

### 8.3 Phase 0：可观测（放行）

- 体积画像（只读 SQL，附录 A）：`dbstat` 按对象占用、三张大表按列称重、`freelist_count`、**两条事件流规模对比**（canonical vs 台账）。
- 启动分段打点：`openDatabase` / 迁移 / `recoverInterruptedInvocations` / 台账 reconcile / 各 cleanup 各自耗时。
- 一次性清理：userData 的 `bak-spaceassistant-data.json`（63 MB）走显式确认后删除或归档。
- 验收：一次冷启动产出分段耗时表 + 体积画像 + 覆盖率初查。

### 8.4 Phase 1：写侧止血（放行）

- 删除 `idx_messages_content`；`searchMessages` 改 FTS5 或降级全扫（行为不变）。
- `appendMessage` 去掉 `COUNT(*)`，改增量计数。
- 落库前对工具结果套用与出站一致的压缩（复用 `compactOversizedToolResultContent`）。
- **`recoverInterruptedInvocations` 改为按需**（只处理非终态流）——启动可用性收益最大且独立于投影化。
- 迁移事务拆分（§5.11）与启动分段打点合流。
- 测试：索引删除后搜索等价；`message_count` 与 `COUNT(*)` 一致；截断往返可还原标记；按需恢复结果与全量重放等价。

### 8.5 Phase 2（门控，待 P-1…P-5）

投影缓存 + 读阶梯 + `ver` + **会话级双水位（`session_seq` / `commit_order`）** + one-below anchor + 三强制点 + fail-soft 边界；**同提交边界内**完成 retention 联动（P-4）。

### 8.6 验证命令

```text
npm exec vitest run <focused tests>
npm run test:related -- <改动文件>
npm run build:electron:incremental
npm run typecheck:renderer
npm run i18n:check            # 涉及文案时
npm test                      # 每阶段收尾
git diff --check
```

---

## 9. 验收标准

1. 冷启动窗口可见时间不随库体积线性增长；`recoverInterruptedInvocations` 耗时与非终态流数量成正比。
2. 体积：新会话连续 20 轮 grep 验证后，主库增长 ≤ 该会话 canonical 事件的 10%。
3. 读阶梯：L0 零文件读；L1 只读后缀；L2 仅缓存不可用时触发（以读取字节数断言）。
4. 渲染：首屏 60 / 翻页 60 / API 上下文（500）三项 p95 不劣于改造前（复用 batch1/batch2 门禁方法）。
5. 一致性：**在真相源集合内**（canonical 事件 + 真相源 spill + 流程状态），清空缓存后全量折叠结果与清空前逐字节一致；`ver` 失配必走 L2；**可降级 spill 不参与本项验收**（B6）。
6. 空间：归档 + `incremental_vacuum` 后主库文件可见下降。
7. fail-soft 边界：投影缓存写失败不影响 turn 成功；确认/投递/续跑/准入/真相源 spill 的严格性不下降。
8. **B2 专项**：台账被 retention 删除后，用户打开对应会话仍能完整渲染（证明真相源不在台账）。
9. **B3 专项**：删除 workDir / 切 profile / `git clean` 后，历史会话正文仍可读。
10. **B6 专项**：真相源 spill 在任何保留期清理后仍存在；可降级 spill 清理不影响读模型等价性。
11. **F-3 专项**：台账缺失时 compaction 重放路径行为明确（可用或有例外清单），且不静默降级。
12. **B7 专项**：新写入的 canonical 事件同时具备 `commit_order`（全局单调）与 `session_seq`（会话内连续）；水位任一字段缺失时必走 L2；会话内序号连续性可被 one-below anchor 的空尾读验证。
13. 全程测试通过、增量构建通过、`git diff --check` 无输出。

---

## 10. 风险与明确不做

### 风险

| 风险 | 缓解 |
| --- | --- |
| 投影折叠语义漂移（顺序/工具配对/thinking 候选/图片标记） | P-2 逐字段语义表 + 真实会话回放对拍（硬验收） |
| P-1 判据失真导致错误 go/no-go（F-1 教训） | 判据以"含正文的事件"为准；单列指纹-only 与压缩类别；报告给出统计口径 |
| 历史 canonical 覆盖不全，投影化后老会话退化为空 | P-1 先行；覆盖不足的老会话保留旧读路径（不做一刀切） |
| 缓存与真相源不一致被当作最新 | `ver` 门控 + **会话级双水位（`session_seq` / `commit_order`）** + one-below anchor，缺一不可 |
| API 上下文构建变慢 | 活跃会话驻留 + 顺序读 + p95 门禁（不达标不上线） |
| 台账被删导致用户可见历史消失 | P-4 retention 联动 + B2 同提交边界 + 归档优先 |
| compaction 重放因台账清理而失效（F-3） | 并入 P-4 设计；给出替代来源或例外清单 |
| 真相源 spill 被误当可降级清理（B6） | 两类分离 + `spill_index.class` + 验收 10 断言 |
| 迁移期两套读路径长期并存 | 设定收敛版本与开关清理计划 |

### 明确不做

1. **不引入插件框架 / 多后端抽象 / 全量 zod 契约套件**。
2. **不引入跨进程文件租约**。
3. **不把 fail-soft 扩散到正确性敏感路径**（确认、投递、续跑、准入、`commit_uncertain`、真相源 spill）。
4. **不让文件路径成为 API**（locator 不透明）。
5. **不把 `events.jsonl` 当消息真相源**（B1）。
6. **不把正文外置到 workDir**（B3）。
7. **不在同一提交里既删台账又不联动 DB**（B2）。
8. **不让真相源 spill 受保留期约束**（B6）。
9. **不做"按体积 LRU 自动删会话"**。
10. **不把 Zstd 作为前置依赖**。

---

## 11. 开放问题

1. `messages.attachments` 是否落 base64？若是，需纳入 spill（33% 膨胀）。
2. `accepted_turn_contexts.accepted_turn_json` 的 payload 是否含消息正文？含则纳入 spill。
3. `images_delivered_to_api` 与 `status` 在 canonical 事件里无对应字段，投影化后由谁持有？（P-2 的一部分）
4. `apiContextService` 的 500 条基线与投影缓存是否有复用点（避免重复折叠）。
5. `session_transcript_checkpoints.status` 与 `session_execution_claims` 的职责边界在 P-3 后如何简化。

> v2 的开放问题 4（台账的 compaction 重放依赖）已按 F-3 升级并入 **P-4**。

---

## 12. 评审阻断与修正处置

### 12.1 B1 回请裁定（v2 提出 → v3 确认）

| 项 | 内容 |
| --- | --- |
| v2 回请 | "不存在消息级事件流"的判断不成立；canonical history 已是消息级事件流 |
| **评审裁定** | **确认**：v1 强判断撤回；"无需扩展事件模型"成立。评审补齐实锤：`electron/toolChatLoop.ts:1063-1078` 每轮提交 `invocation-context-committed`（payload 含完整 canonical `messages` 数组与 `requiredUserMessage`）；v1 只追了 `events.jsonl` 与 `claudeStreamHandlers` 的 sink 写入，漏掉 `toolChatLoop → InvocationHistoryWriter → agent_history_events` 这条 canonical 写入链 |
| v3 补记 | `historyOwnsBase` 短路（同一 stream 内已有 `invocation-context-committed`/`transcript-compacted` 时不再补写）是本链的重要语义，已写入 §5.4 与 P-1 判据设计 |

### 12.2 阻断与修正清单

| 编号 | 评审结论 | 事实核验 | 处置 |
| --- | --- | --- | --- |
| **B1**（v1） | 核心前提不成立：`events.jsonl` 是审计台账而非消息流 | 成立（对台账）；**但"无消息级事件流"不成立** | 真相源改为 canonical history（§1.2/§2.3/§3/§4.1）；裁定为**确认**（§12.1） |
| **B2**（v1） | 分期顺序造成不可恢复丢数窗口 | 成立 | retention 前移，与 Phase 2 同提交边界（P-4 + §5.8）；新增验收 8 |
| **B3**（v1） | 真相源放在用户可选 workDir 下 | 成立 | canonical 与两类 spill 落 userData（§4.2）；新增验收 9 |
| **B4**（v1） | spill 只定义写侧回退，读侧失效与续跑严格性矛盾 | 成立 | 读侧语义按类别定义（§5.6），并入 P-5 |
| **B5**（v1） | transcript 承担协议职责，降级为纯缓存缺迁移设计 | 成立 | 职责合并而非降级（§4.3），并入 P-3 |
| **B6**（v2，新） | §4.1 称 spill"不可丢弃"与 §5.8 称"按保留期管理"规范级自相矛盾；按 §5.8 实施会计划性删掉真相源正文，违反验收 5 | **成立**（v2 两处表述直接冲突） | **接受**：spill 按内容性质切为**真相源 spill（无保留期）** 与**可降级 spill（有保留期）**（§4.1/§5.6/§5.8）；`spill_index` 增 `class` 列；验收 5 限定为"真相源集合内逐字节一致"，新增验收 10；判据固化并入 **P-5** |
| **F-1** | 附录 A 的 P-1 SQL 用 `session-input-committed` 判"含用户消息"，但该事件只是身份指纹（payload 仅 `sessionId`/`messageId`/`inputFingerprint`，V21 可证），hosted 主路径写的是 `invocation-context-committed`；按现行 SQL 正常会话会被误判为无覆盖，P-1 报告失真 | **成立**（已核实 `MIGRATION_V21` 判据字段与 `toolChatLoop.ts:1063-1078`） | **接受**：附录 A 判据改为 `invocation-context-committed`（正文级）+ `model-response-committed`，并单列"仅指纹"与"经 `transcript-compacted`"两类；P-1 要求报告统计口径 |
| **F-2** | §1.2 称台账"实测未见 `text_delta`"与代码不符：`electron/runtime/agentSdkDesktopObserver.ts:455-465` 明确把 `text-delta` push 为 `{type:'text_delta', text}` | **成立**（已核实 observer:458-465；v2 的"未见"来自被 `head_limit` 截断的采样结果，属采样偏差） | **接受并更正**：§1.2 改为"台账**含** `text_delta` 增量，但为增量流 + `tool_call_delta.partialJson` 落盘前剥离 + 受 retention 约束"；结论方向不变，但证据链更正 |
| **F-3** | compaction 重放运行时依赖台账，应从开放问题升级 | **成立**（`claudeStreamHandlers.ts:376/408/413`） | **接受**：从开放问题移出，并入 **P-4**；新增验收 11 |
| **F-4** | P-3 需补"同 turn 重复提交"红绿场景（快照级幂等与事件级幂等不等价） | **成立**（`sessionTranscript.ts:21-24` 逐字节比对 vs `idempotency_key` 唯一约束，语义不同） | **接受**：P-3 验收证据补"同 turn 重复提交 + 跨重启重放"红绿用例 |

### 12.3 v4 处置（B7 水位线模型错位）

| 项 | 内容 |
| --- | --- |
| 评审结论 | v1–v3 的 `seq` 水位线 / `restoreFloor` / one-below anchor / §5.7 撕裂尾截断全部建立在"每会话一条物理追加日志"的前提上；v3 的真相源是 per-invocation 分流表，**不存在会话级全序键**，因此投影水位无法定义、L1 取后缀无从取起、撕裂尾截断对 DB canonical 不适用 |
| 事实核验 | **成立**。`agent_history_streams` 列仅 `invocation_id`/`version`/`schema_version`/`session_id`（**无时间或序信息**）；`PRIMARY KEY(invocation_id, sequence)` 仅 invocation 内有序；`created_at` 毫秒碰撞；隐式 `rowid` 在 VACUUM/删除后可重排复用 |
| 处置 | ① 新增 **§5.12 会话级折叠序**：主方案**双序**（`commit_order` 全局单调 + `session_seq` 会话内连续，各自配分配器表），备选方案为 `commit_order` + 计数校验；② 据 §5.12 重定义投影水位（§5.2：三个水位字段成对记录）与 L1 形态（§5.3：会话内后缀 + 跨 stream 合并排序），并修正 one-below anchor 的**前提**；③ §5.7 **逐行标注适用对象**（DB canonical 无撕裂尾、无 `append`/`flush` 屏障语义）；④ §5.1 持久性语义按介质区分；⑤ 折叠序定为 **P-2 第一节**；⑥ 新增验收 12（B7 专项） |
| 附带发现 | 同一"模型错位"还波及 §5.1 的 `append`/`flush` 语义（文件日志概念被移植到 DB），已一并修正 |
| 未决 | 主方案与备选方案的取舍待评审裁定（差异：是否引入 `session_seq` 以保住空尾证明；成本：2 张分配器表 + 3 列 + 1 索引 + `DB_SCHEMA_VERSION` +1） |

**未决回请**：无。B1 回请已裁定确认；v3 四项修正已落实；**v4 的 B7 修复已落地正文**（§5.12 + §5.1/§5.2/§5.3/§5.7/§4.3/§8.2/§9 同步修订）。下一步触发物为 **P-1 报告、P-2 语义表（第一节＝折叠序）、P-3/P-5 设计稿**，以及本节"未决"项的裁定。

---

## 附录 A 诊断 SQL（只读）

```sql
-- 各对象实际占用（需 SQLite 编译 dbstat）
SELECT name, COUNT(*) AS pages, SUM(pgsize)/1048576.0 AS mb
FROM dbstat GROUP BY name ORDER BY 3 DESC LIMIT 30;

-- 三块大头按列称重
SELECT COUNT(*), SUM(length(messages_json))/1048576.0 AS mb FROM session_transcript_entries;
SELECT COUNT(*), SUM(length(payload_json))/1048576.0  AS mb FROM agent_history_events;
SELECT COUNT(*),
       SUM(length(content) + length(COALESCE(tool_calls,'')) + length(COALESCE(thinking,'')))/1048576.0 AS mb
FROM messages;

-- 可回收空闲页
PRAGMA page_size; PRAGMA page_count; PRAGMA freelist_count; PRAGMA auto_vacuum;

-- P-1 前置：canonical 覆盖度（判据已按 F-1 修正）
-- 判据说明：
--   * session-input-committed 只是身份指纹（payload: sessionId/messageId/inputFingerprint，无正文）
--     —— 不可用作"含用户消息"的判据，仅用于单列"仅指纹"类别；
--   * 正文级覆盖看 invocation-context-committed（payload.messages；toolChatLoop.ts:1063-1078）
--     与 model-response-committed（payload.message）；
--   * historyOwnsBase 短路：同一 stream 内 invocation-context-committed 只写一次；
--     已被 transcript-compacted 的 stream 不再补写 context 事件，故单列一类。
SELECT
  COUNT(*) AS streams,
  SUM(CASE WHEN has_ctx  THEN 1 ELSE 0 END) AS with_context_committed,
  SUM(CASE WHEN has_resp THEN 1 ELSE 0 END) AS with_response_committed,
  SUM(CASE WHEN has_ctx AND has_resp THEN 1 ELSE 0 END) AS fully_covered,
  SUM(CASE WHEN has_ctx = 0 AND has_compacted = 0 THEN 1 ELSE 0 END) AS no_context_no_compaction,
  SUM(CASE WHEN has_ctx = 0 AND has_compacted = 1 THEN 1 ELSE 0 END) AS compacted_without_context,
  SUM(CASE WHEN has_input = 1 AND has_ctx = 0 THEN 1 ELSE 0 END) AS fingerprint_only
FROM (
  SELECT s.invocation_id,
    MAX(CASE WHEN e.kind = 'invocation-context-committed' THEN 1 ELSE 0 END) AS has_ctx,
    MAX(CASE WHEN e.kind = 'model-response-committed'    THEN 1 ELSE 0 END) AS has_resp,
    MAX(CASE WHEN e.kind = 'session-input-committed'     THEN 1 ELSE 0 END) AS has_input,
    MAX(CASE WHEN e.kind = 'transcript-compacted'        THEN 1 ELSE 0 END) AS has_compacted
  FROM agent_history_streams s
  LEFT JOIN agent_history_events e ON e.invocation_id = s.invocation_id
  GROUP BY s.invocation_id
);

-- 非终态流数量（按需恢复的收益基线）
SELECT COUNT(*) FROM agent_history_streams s
WHERE NOT EXISTS (
  SELECT 1 FROM agent_history_events e
  WHERE e.invocation_id = s.invocation_id
    AND e.kind IN ('invocation-completed','invocation-failed','invocation-interrupted')
);
```

**注意**：本会话环境对落盘脚本与任意 SQL 执行有安全限制，上述 SQL 需由人工或有权限的会话执行；执行请在**只读**模式（`mode=ro`）下进行。

## 附录 B 术语

| 术语 | 含义 |
| --- | --- |
| canonical history | DB 内的消息级事件流（`agent_history_events`），本方案的真相源 |
| 审计台账 | workDir 下的 `events.jsonl`，turn/tool/request/chunk 级**增量流**，可清理 |
| 投影（projection） | 从 canonical 事件纯折叠出的读模型 |
| 水位线（`session_seq` / `commit_order`） | 会话级折叠水位：`session_seq` 会话内连续（L1 取后缀与 one-below anchor 的依据），`commit_order` 全局单调（跨 stream 合并排序） |
| 读阶梯（L0/L1/L2） | 零 I/O → 缓存 seed + 尾重放 → 全量折叠 |
| one-below anchor | 读取起点取"最低可用水位之下一格"，使日志缩短可被检测 |
| `stateVersion`（`ver`） | 折叠语义/序列化结构的代际；失配即丢弃缓存 |
| 真相源 spill | 承载 canonical 正文的外置存储；**不可丢弃、无保留期** |
| 可降级 spill | 冗余可读副本；可丢弃、可按保留期删除；不参与逐字节一致验收 |
| fail-soft | 失败只留痕不阻塞（**仅限派生数据**） |
