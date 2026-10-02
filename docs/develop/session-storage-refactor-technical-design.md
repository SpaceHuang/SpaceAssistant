# 会话存储重构技术方案：canonical 事件流为正文真相源，保留权威消息骨架与流程状态

| 字段 | 内容 |
| --- | --- |
| 文档状态 | **v31 · Phase 0…4 已完成；Phase 5 暂停；评审回归 B1/B2 已有针对性 TDD**（旧历史逐 session eligibility + legacy fallback） |
| 版本 | v1（初稿）→ v2（B1–B5 处置）→ v3（B6 + F-1…F-4 修正）→ v4（B7 折叠序修复）→ v5（B8 恢复义务拆分 + B9 水位身份校验）→ v6（TDD 证据、B7 主方案选择、Phase 1 与 P-1/P-2/P-4 实施状态）→ v7（canonical message ID 写入、只读身份覆盖画像）→ v8（repair 失败矩阵、分类与全量恢复差分等价）→ v9（最终全量测试与类型检查）→ v10（P-5 可执行判据及 spill 分类 TDD）→ v11（P-2 快照替换语义与 P-3 session 级幂等边界）→ v12（全量测试复验及 gate 状态审计）→ v13（普通台账 retention 后 canonical fold 等价测试）→ v17（cache ver 门控与 v34 失效迁移）→ v18（v35 turn receipt 子协议）→ v19（v36 transcript_committed 执行 fence）→ v20（terminal History + transcript commit 原子封口）→ v21（P-4 有序 projection-retention、跨重启重试）→ v22（P-5 spill 文件协议、canonical locator、严格/降级读与清理）→ v23（P-1 有界 rollout 判定及 Chat IPC canonical L1/L2 展示读取）→ v24（Phase 2 cache checkpoint、legacy 字段保真及性能门禁）→ v25（v37 eligibility fence、message 写入失效、warm page 性能对照及 Phase 2 收口）→ v26（tool result source spill）→ v27（assistant/provider context spill）→ v28（terminal output + P-3 transcript snapshot spill、完整 20 轮体积协议测试）→ v29（Phase 3 整体验收、Phase 4 空间回收入口和 UI、全量复验）→ v30（safe DB escape path、定期 WAL checkpoint、旧 JSON 备份确认归档与归档唯一性）→ **v31（评审回归 B1/B2：终态 pending 队列重试及 L1 行数/cursor/水位连续校验）** |
| 评审记录 | [v1](../review/2026-10-02-session-storage-refactor-technical-design-review.md) · [v2](../review/2026-10-02-session-storage-refactor-technical-design-review-v2.md) · [v3](../review/2026-10-02-session-storage-refactor-technical-design-review-v3.md) · [v4](../review/2026-10-02-session-storage-refactor-technical-design-review-v4.md) · [v5](../review/2026-10-02-session-storage-refactor-technical-design-review-v5.md) |
| 当前门控 | **Phase 0/1/2/3/4 完成；Phase 5 暂停；P-1 旧历史全量切换 no-go，但逐 session eligibility + legacy fallback 已定为放行边界；本轮针对评审回归补充 B1/B2 TDD**（继续保留逐 session fallback） |
| 适用范围 | `electron/database/*`、`electron/sessionEvents.ts`、`electron/runtime/*`、`electron/toolChatLoop.ts`、`packages/agent-sdk/src/history.ts`、`electron/storage/*`、`main.ts` 启动链 |
| 触发问题 | 主库膨胀至 402 MB；启动恢复持续数分钟；窗口迟迟不出 |
| 上游约束 | 不推翻[会话记录事件流持久化重设计方案](./session-record-eventflow-persistence-redesign-plan.md)（已落地）与[消息列表渲染进程性能优化技术方案](./chat-message-list-renderer-performance-optimization-design.md)（已落地） |

## 修订记录

| 版本 | 变更 |
| --- | --- |
| v1 | 初稿：主张把 `events.jsonl` 收敛为唯一真相源，`messages` 降级为可丢弃投影 |
| v2 | **修正真相源定位**：`events.jsonl` 是审计台账而非消息载体（B1 成立），真相源改为 DB 内的 canonical history；并入 B2–B5 处置 |
| v3 | ① **B1 回请裁定为"确认"**——v1 的强判断撤回，"无需扩展事件模型"成立（评审补齐 `toolChatLoop.ts` 写入链实锤，见 §12）；② 处置 **B6**（spill 可丢弃性与保留期的规范级矛盾）；③ 修正 **F-1**（P-1 判据 SQL 用错事件）；④ 修正 **F-2**（台账 `text_delta` 结论错误）；⑤ **F-3** 并入 P-4、**F-4** 并入 P-3 |
| v5 | 处置 **B8**：把未终态 invocation 收口与已终态 canonical 投影补偿拆开，终态投影义务未完成时仍可重试；处置 **B9**：L1 核验水位事件自身的不可复用身份，移除 one-below 空尾作为缩短证明的说法，并补足空会话、边界删除及 session ID 重建判据；处置 **B10**：Phase 1 性能门禁要求持久化待办队列与历史流初次分类，启动复杂度按非终态流 + 未完成待办衡量 |
| **v6（本版）** | 以 TDD 记录 Phase 1 写侧止血、待办重试、初始分类、逐 schema version 迁移事务、启动复杂度与 retention 改动；补齐 P-1 只读覆盖报告并明确全量切换 no-go；补入 P-2 字段折叠语义草案；依据 §5.12 选择双序主方案，P-2/P-4 及 Phase 1 仍未通过门禁 |
| **v7（本版）** | 以 TDD 修复 canonical context 与模型响应丢失稳定 message ID 的缺口；画像工具增加 session/message ID + role/body 精确身份覆盖统计；历史样本仍无身份覆盖，因此 Phase 2 维持门控 |
| **v8（本版）** | 补齐 Phase 1 多类投影修复的分类模式/全量模式差分测试及 repair callback 失败后跨重启重试矩阵；记录冷启动实测；确认 P-1…P-5 未全部放行，Phase 2/3 不启动 |
| **v9（本版）** | 完成 Phase 1 全量 TDD 收尾；全量测试 846 文件通过、1 跳过（7,687 项通过、106 跳过），shared/renderer/agent-sdk 类型检查、Electron 增量构建、i18n 检查和最终恢复聚焦测试通过；Phase 2/3 仍受 P-1…P-5 门控 |
| **v10（本版）** | P-5 增加 spill 分类器与拒绝不安全降级的 TDD；厘清真相源 spill 必须有 canonical 完整载荷提交，可降级 spill 必须能从 canonical 精确重建；既有中段截断工具结果不能作为真相源 spill 验收。该判据完成不代表 spill I/O 或 Phase 3 已实现 |
| **v11（本版）** | 用测试固定 canonical context/compaction 快照在单 stream 内是替换而非追加；P-2 明确其并非完整 UI 会话；P-3 修正“invocation version 可替代 session transcript version”的错误前提，拆分会话级序号、turn 幂等回执与执行准入状态 |
| **v12（本版）** | 全量复验 846 文件通过、1 跳过（7,692 项通过、106 跳过）；确认只读 P-1 覆盖仍 0/335 identity/body candidates、Phase 0 旧备份不存在；明确 P-2/P-3/P-5 已有部分设计与 TDD 证据但实现 gate 未通过 |
| **v13（本版）** | 新增 retention 与 SQLite canonical History 的集成用例：删除无 compaction 依赖的旧台账后，折叠结果保持逐字段相同；聚焦 21 项通过，全量 846 文件通过、1 跳过（7,693 项通过、106 跳过）。P-4 的普通 ledger 删除证据补齐，投影缓存同提交边界仍未实现/验收 |
| **v14** | 以 red/green TDD 增加 schema v32 双序写入/回填；补齐 user/assistant 稳定 ID 往返、Hosted assistant response turn-ID 绑定、跨 invocation 稳定 ID 快照折叠与 legacy 对拍。 |
| **v15** | schema v33 为 session generation 回填并用于新会话；真实 DB session fold 与 generation/anchor cache CRUD。 |
| **v16** | 增加 SQLite L1 seed + `session_seq` 后缀读取与 stable-ID snapshot fold，完整折叠 invocation context/compaction 后的 response、replay 与工具结果事件；支持 `-1/-1 + NULL` 空会话水位与首次写入，核验双序连续及 session cursor，失配时转 L2 全量 fold，对拍 legacy 后刷新缓存。聚焦 TDD 覆盖有效后缀、response-only 后缀、锚点/尾事件删除 fail-closed、空会话及同 ID generation 重建、thinking/segments/tool UI/status/sequence/image delivery/skill hints 等非 canonical 字段降级。尚未接入实际会话打开调用点，完整字段矩阵与附件/部分失败样本未完。 |
| **v18** | P-3 以 red/green TDD 增加 schema v35 turn commit receipt：payload SHA-256、session base/next version、outcome 和 canonical event range；新提交及历史 entry 重试写 receipt，v34→v35 迁移幂等。receipt 故障回滚与 stale session CAS 用例通过；canonical append 原子边界未完成。 |
| **v19** | P-3 新增 schema v36 `transcript_committed` claim/queue 状态；transcript entry、receipt、session checkpoint 与执行状态迁移在同一 SQLite 事务提交，handoff final release 与启动恢复继续处理投影收尾。v35→v36 保留既有 claim/queue 行。 |
| **v20（本版）** | P-3 经 red/green TDD 完成 terminal commit protocol：Agent SDK 在 terminal append 时传入仅限调用期的 `SessionTranscriptCommitIntent`；SQLite adapter 在同一事务追加 canonical terminal event 并写 `session_transcript_entries`、receipt、checkpoint、`transcript_committed` claim/queue fence。receipt event range 锚定本 turn 已追加的 canonical History 前缀；facts 仍按流式事件批次先行持久化。participant 故障时 terminal-only fallback 保留错误事实，session 保持 commit_uncertain 并由 startup reconcile，不伪造成功 checkpoint。普通完成、provider failure、receipt/checkpoint/queue 写入故障回滚、跨重启重试、真实 IPC commit_uncertain 均有测试。 |
| **v21（本版）** | 校准 P-3 测试证据为 9 个聚焦文件/399 项及真实 Hosted IPC 120 项；P-4 启动入口先查 compaction 依赖，再持久化 SQLite projection cache 后删除文件台账；真实 canonical fold/cache + retention 集成用例、投影失败保留台账、projection commit 后 DB close/reopen 再重试与 compaction replay 均通过。Retention/fold 聚焦 118 项、Electron typecheck、`git diff --check` 通过；P-4 门禁通过 |
| **v22（本版）** | P-5 spill store 实现 file fsync + 目录 fsync + bytes/SHA-256 校验，再提交真实 SQLite canonical locator；DB 回滚保留待全引用扫描回收的 orphan，提交确认丢失时全引用扫描保留已引用对象；硬失败读、可降级占位、配置保留期 + 审计清理、source-of-truth 永不清理及 canonical fold 等价均有集成测试。spill/retention 19 项、Electron/shared typecheck、`git diff --check` 通过。P-5 协议门禁通过；Phase 3 运行时调用接线仍在计划门控范围内 |
| **v23（本版）** | P-1 按 0/335 旧身份覆盖结论放行新写入/逐 session eligible rollout，老历史继续 legacy；Chat IPC 的全量消息读取和分页展示接入 canonical projection，L1 只读 cache + History 后缀和不含正文的 legacy UI skeleton，冷/失配路径才读取 legacy 全文做精确对拍并回退。pending 非 canonical 消息、缺失身份、不可映射 role 均有 legacy fallback 用例；Phase 2 其余强制点、完整字段矩阵和性能门禁仍待完成。Phase 2 focused 4 项、Electron typecheck 与 diff 检查通过 |
| **v24（本版）** | Phase 2 create-session 初始化空投影 cache 并复用持久化 generation；turn end best-effort 刷新水位；说明当前同步 SQLite cache 写入不需要 write-behind drain。增加 legacy UI/control 字段 round-trip 矩阵用例，明确非空元数据保留且空集合按 codec 规范化为缺省；1200 条消息 warm L1 最新页 30 次采样通过 p95 < 50ms 门禁。分页改为整 session L2 对拍成功后才 merge canonical，缺少更老消息时保留原 legacy page。Phase 2 focused 11 项、数据库操作 + Hosted IPC 联合回归 190 项、Electron/shared/renderer/agent-sdk typecheck 与 diff 检查通过 |
| **v25（本版）** | schema v37 增加 session projection eligibility fence；只有全会话 L2 精确对拍可授予，messages INSERT/UPDATE/DELETE trigger 原子撤销；create-session 空 transcript 同 generation seed eligibility。Warm cursor page 只读页内 skeleton + canonical L1，任何消息行变化均先撤销 fence，L2 重新验证后恢复。p95 对照：1200 条消息、legacy 60 行页 vs eligible warm canonical 页，30 次 nearest-rank p95 限制为 legacy p95 ×2 + 5ms；API context 原 `getTurnContext` 流程/状态过滤路径保持权威 legacy 且同库 p95 <50ms。逐 session eligible/legacy 混合回退与 mutation invalidation 有 TDD。Phase 2 聚焦与迁移/操作/Hosted IPC 联合 247 项、Electron/shared/renderer/agent-sdk 类型检查、Electron 增量构建、diff check 通过；Phase 2 完成，按序进入 Phase 3 |
| **v26（本版）** | Phase 3 第 1 项：`SqliteAgentHistory.appendBatch` 对 >64 KiB UTF-8 `tool-call-finished.payload.result.data` 先写 userData `spill/` source-truth 文件，再将带版本标记的 descriptor 写进 canonical payload；对应 `sessionLedger.result.data` 同引用去重，bounded `replayContent` 保持原样。History `read/readSync` 严格校验 byte length + SHA-256 并透明 hydrate；缺失/篡改抛 `SPILL_CONTENT_UNAVAILABLE`；durable spill 准备失败时完整正文 inline 提交。正常 invocation 与启动恢复 History 已注入同一 userData spill root。spill + sqlite history 123 项、Electron 增量构建和 agent-sdk typecheck 通过。后续仍需覆盖真实 tool-call event integration、assistant response/provider context、crash/reopen 全矩阵、20 轮 DB 体积和全量验收；Phase 3 未完成 |
| **v27（本版）** | source-truth spill 按计划顺序扩展到 `model-response-committed.message.content`、`invocation-context-committed` / `transcript-compacted` canonical messages 的大文本与 image base64；所有正常 SQLite History adapter 从 DB 主文件目录推导同一 `spill/`，内存 DB 保持关闭。增加 20 轮大型 assistant response 主库增长 ≤ canonical 正文 10% 和真实 DB close/reopen + spill orphan reconciliation 测试。spill + History、session projection、registered tool 和 Hosted integration 5 文件 284 项通过；扩展后 spillStore 18 项、Electron 增量构建、renderer/shared/agent-sdk typecheck、diff check 通过。仍待完整 recovery/provider integration、retention/recovery 验收与 Phase 4 |
| **v28（本版）** | `invocation-completed.outputText` 与 P-3 `session_transcript_entries.messages_json` 大快照也改用 source-truth locator；turn receipt SHA-256 仍基于原始完整消息，terminal event、transcript locator、receipt、checkpoint 和执行 fence 保持同一 SQLite 事务，`readSessionTranscript` 校验后 hydrate。20 轮体积用例现模拟每轮 History response + terminal + 累积 transcript snapshot。修复 mock SQLite connection 的自动 root 探测兼容；spill/History/sessionTranscript/projection/tool/Hosted 6 文件 309 项通过，Electron build、renderer/shared/agent-sdk typecheck 与 diff check 通过。全套曾发现 112 项因 mock connection 缺少 `prepare` 而失败，该共同原因已修复，完整套件复验待完成 |
| **v31（本轮评审回归）** | B1 回归用例验证终态 canonical repair 首次失败保持 pending，后续恢复成功后才完成；B2 回归用例删除水位事件并保留 cursor，必须拒绝 L1，另覆盖同 ID generation 重建与空水位首事件 L1 增量。L1 同时核对 canonical 行数、session cursor、缓存水位及连续后缀，保留落后水位的有效增量读取。全量 854 文件通过、1 跳过（7,783 项通过、106 跳过）；shared/renderer/agent-sdk typecheck、Electron 增量构建、i18n 与 diff check 通过 |

> **v2 → v3 的定性变化**：v2 的两处"核心事实"证据有误——附录 A 的 P-1 判据用了身份指纹事件（`session-input-committed`）而非上下文提交事件（`invocation-context-committed`），§1.2 又声称台账"未见 `text_delta`"。两处均已更正；**结论方向不变**（台账不作真相源、无需扩展事件模型），但证据链必须在进入 P-1 go/no-go 前是干净的。

---

## 0. TL;DR（v6）

1. **真相源 = canonical history（`agent_history_events`，在 DB/userData 内）**。消息级事件与写入链：
   - `invocation-context-committed`：`payload.messages`（完整 canonical 上下文数组）+ 可选 `requiredUserMessage`（**hosted 主聊天路径每轮提交**，`electron/toolChatLoop.ts:1063-1078`）；
   - `model-response-committed`：`payload.message`（assistant 正文，`packages/agent-sdk/src/turn.ts:1029-1037`）；
   - `tool-call-started/finished/not-dispatched`、`approval-*`、`invocation-completed/failed/interrupted`。
2. **`events.jsonl` 是审计台账**，**不是**消息真相源：它是增量流（含 `text_delta`/`reasoning_delta` 等 chunk，`electron/runtime/agentSdkDesktopObserver.ts:458-465`）、工具入参 JSON 在持久化前被剥离（`partialJson: ''`）、且受 `retention.sessionEvent.maxSessions` 约束（默认 100，超出 `fs.rm`）。
3. **消息正文与消息骨架分开治理**：canonical 可精确重建的正文/工具派生内容进入逐记录投影缓存；`messages` 中的 message ID、流程状态、投递状态及其它无 canonical 对应项仍是权威骨架，整行/整表不可丢弃。`session_transcript_entries` 只有在 P-3 迁移后才可退出协议权威。
4. **膨胀大头在 DB**（`agent_history_events.payload_json` 与 `messages` 正文）。处置是**大文本 spill 到 userData** + **投影缓存化**（B5 要求先做职责迁移）。
5. **spill 分两类，不可混同**（B6）：**真相源 spill**（承载 canonical 正文，不可丢弃、**无保留期**）；**可降级 spill**（仅展示性内容，可有保留期，且必须排除在"逐字节一致"验收之外）。
6. **水位线必须是会话级**（B7）：真相源是 per-invocation 分流表，不存在会话级全序键；折叠序由 **`commit_order`（全局单调）+ `session_seq`（会话内连续）** 双序提供（§5.12），禁止把 per-invocation 的 `sequence` 当会话水位。
7. 渲染契约、IPC 契约、`turns` 状态机语义**均不变**。

**分期**：Phase 0/1 已完成；P-1…P-5 前置门禁全部通过；Phase 2 已完成，Phase 3 正按 §8 顺序实施。

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
→ openDatabase(dbPath)                     // CREATE_TABLES_SQL + runMigrations(逐 schema version 独立事务)
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
2. **迁移按 schema version 独立提交**（每步 DDL/data backfill 与 `schema_meta` 更新处于同一事务），外部采样可看到最后已提交版本；若某步失败，该步整体回滚，先前步骤保留并从失败版本重试。历史单事务实现下，外部采样只能看到上一个已提交版本；"停在 V28"既可能是卡在迁移事务内，也可能是上一轮被强杀后回滚重跑，**不能**证明"卡在恢复阶段"。

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
| `messages` | 混合载体：正文重复存储；message identity/status/投递状态仍是权威 | 正文与 canonical 重复且无截断；整行还被 FK/sequence/状态机深度依赖，不可整表丢弃 |
| `session_transcript_entries` | 每 turn 全量重写 + 承担版本/幂等/准入职责 | O(n²) 体积，职责与 canonical `version` 重叠 |
| `events.jsonl` | 审计台账（增量流，可清理） | **不应**作为消息真相源 |

assistant 正文经 `updateMessageContent` 进 `messages`，同一份内容又经 `model-response-committed` 进 canonical history；恢复路径信任 canonical，渲染路径信任 `messages`，于是必须双向兜底（`repair*` + `ensure*Event`）。目标是消除正文双写；message ID、流程状态和图片投递确认等没有 canonical 对应事实的字段继续保留在权威骨架。

### 2.4 写放大与索引负担

`appendMessage` 的 `COUNT(*)`（会话越长越慢）；`idx_messages_content` 把正文再抄一份进 B-tree（前置通配符用不上）；库越胖 → B-tree 越深、overflow page 链越多 → 读写双边退化。

### 2.5 启动恢复全量重放

`runtime/sqliteAgentHistory.ts:322-326`：每次启动 `SELECT ... FROM agent_history_streams`（全表），对**每个** invocation `await this.read(id)`（读全部事件 + `JSON.parse`）再 `rebuildInvocationStates`，**不区分是否需要恢复**。消除这项瓶颈要求启动只读取非终态流与持久化修复队列中未完成的义务；因此 Phase 1 必须同时实现修复义务登记、历史数据初次分类和失败重试，不能仅用非终态过滤替代全量恢复。

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
| 消息正文投影缓存 | DB（per-record） | canonical 可重建的正文、thinking 与工具结果字段 + 水位线 | 派生 | **是** | 是 |
| 消息骨架 / 投递状态 | DB（`messages` 保留列） | ID、status、images-delivered、不能映射的 UI/控制状态 | 权威 | 否 | 否 |
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
| `messages` | **不整表缓存化**：`id`/`session_id`/流程 `status`/投递 `images_delivered_to_api`/路由排序字段及无法映射的 UI 状态保留为权威骨架；仅已证明可由 canonical 精确重建的正文/派生列按逐字段计划缓存化 | 主线；P-2 决定字段资格 |
| `session_transcript_entries` | 退役整份 `messages_json` 快照前，先把会话级 version/CAS、同 turn 快照级幂等、执行准入拆成独立职责；invocation 级 `agent_history_streams.version` 不能单独替代会话版本。候选替代包括 session cursor + turn commit receipt + canonical 消息事实；在 P-3 用例证明前保留旧表 | **B5/F-4；P-3 未通过** |
| `session_transcript_checkpoints` | 暂保留会话级 checkpoint/status；version 仅在其替代协议具备 session scope 和回退证明后迁移。`commit_uncertain` 处置需保留人工 reconcile 审计能力 | **B5；P-3 未通过** |

**C. 新增**

| 表 | 用途 |
| --- | --- |
| `session_projection_cache` | per-record 投影缓存：`session_id`、`key`、`ver`、`session_seq`、`commit_order`、`event_count`、`val`、`updated_at`；PK `(session_id, key)`（B7 双水位） |
| `session_storage_index` | 列表零 I/O：`session_id`、`revision`、`size_bytes`、`event_count`、`format_version` |
| `canonical_projection_repairs` | 持久化逐项修复义务：session/invocation、repair kind、目标范围、状态、尝试次数、最近错误、更新时间、幂等键；启动按未完成项定向处理 |
| `canonical_projection_repair_migration` | 升级前历史流初次分类游标与状态；支持分批迁移、中断续跑，迁移完成后不进入常规启动扫描 |
| `spill_index` | `locator`、`session_id`、`tool_use_id`、`bytes`、`sha256`、`created_at`、**`class`（source-of-truth / degradable）**（B6） |
| `agent_history_commit_cursor` | 全局单调序分配器：`id INTEGER PRIMARY KEY AUTOINCREMENT`、`allocated_at`（B7） |
| `session_event_cursor` | 会话内连续序分配器：`session_id` PK、`next_seq`（B7） |

**D. 废弃**

| 项 | 处置 |
| --- | --- |
| `idx_messages_content` | 删除（前置通配符 LIKE 无法利用）；搜索保留现有 LIKE/转义/排序/权限语义，接受查询范围内全扫；只有经等价测试后才能另行引入 FTS5 |
| `session_transcript_entries.messages_json` 正文 | 退役（职责先迁移） |
| 双向 `repair*` ↔ `ensure*Event` | 收敛为单向（§5.1） |
| `bak-spaceassistant-data.json`（63 MB） | 一次性清理（Phase 0） |

---

## 5. 关键机制设计

### 5.1 真相源与写路径收敛

- **真相源**：`agent_history_events`（canonical history）。不变量沿用 D1/D7：**仅追加、永不重写**、修复是读方职责；其中"只截断撕裂物理尾"**仅适用于文件侧**（台账 / spill），DB canonical 无此概念（§5.7）。
- **写路径收敛目标**：assistant 正文**一次写入 canonical**，`messages` 的正文/派生列按 P-2 逐字段投影；message identity、流程 status、图片投递确认等权威骨架仍由原有写入路径维护。`updateMessageContent` 只在被批准迁入的正文列上降级为"投影更新"。
- **单向兜底**：canonical 缺失时从台账重建是**补偿**（并留痕），台账缺失不得反过来影响 canonical 语义。禁止继续双向互修。
- **写者所有权**：同进程多入口（桌面/飞书/微信/butler）须保证同一 session 只有一个活跃写句柄（复用 sink registry 思路 + `session_execution_claims.generation` 栅栏）；不引入跨进程文件租约。
- **持久性语义按介质区分**（B7）：DB canonical 依赖**事务提交**（提交即持久，WAL + `synchronous=NORMAL`）；"`append` 尽力而为、`flush` 为持久性屏障"的语义**只属于文件侧**（台账 sink、两类 spill），不得移植到 canonical。

### 5.2 投影缓存（`session_projection_cache`）——B7 修正后

```sql
CREATE TABLE IF NOT EXISTS session_projection_cache (
  session_id   TEXT NOT NULL,
  key          TEXT NOT NULL,   -- 'messages' | 'title' | 'context-summary'
  ver          INTEGER NOT NULL,-- 单元 stateVersion
  session_seq       INTEGER NOT NULL,-- 会话内连续水位线（-1 = 空）：L1 取后缀的依据
  commit_order      INTEGER NOT NULL,-- 全局单调水位线（-1 = 空）：跨 stream 合并排序的依据
  watermark_event_id TEXT,            -- 水位事件身份；空水位为 NULL
  watermark_invocation_id TEXT,       -- 水位事件所属 invocation；空水位为 NULL
  session_generation TEXT NOT NULL,   -- 防止同 session_id 删除重建后复用旧缓存
  event_count       INTEGER NOT NULL,-- 附加一致性检查，不替代水位事件身份核验
  val          TEXT NOT NULL,   -- 纯 JSON
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (session_id, key)
);
```

规则：**per-record**、**fail-soft**（写失败只 warn，下次自愈）、**`ver` 门控**（失配即丢弃，绝不前向应用）、**水位信息必须完整**（`session_seq` + `commit_order` + 水位事件身份 + `session_generation`；空水位使用 `session_seq = -1` 且身份为 NULL），任何身份缺失或核验失败均升级 L2；缓存水位、canonical 行数和 `session_event_cursor.next_seq` 必须相等；**`val` 为 detached 副本**。

> **B7**：v1–v3 的 `seq` 直接借用了 per-invocation 的 `sequence`，而真相源是 per-invocation 分流表、不存在会话级全序键，该字段在实现上无法定义。水位线的来源与语义见 **§5.12**。

### 5.3 读阶梯（三档）——B7 修正后

| 档 | 触发 | 动作 | I/O |
| --- | --- | --- | --- |
| L0 | 会话列表、标题 | 只读 `session_storage_index` + `ver` 匹配的缓存行 | 无 |
| L1 | 打开会话、resume | 取 `ver` 匹配且水位可用的行作 seed；取 `session_seq > 缓存水位` 的**会话内后缀**，跨 stream 按 `commit_order` **合并排序**后折叠 | O(增量) |
| L2 | 缓存缺失 / `ver` 失配 / 水位不可用 / 事件计数或 cursor 不一致 / 后缀不连续 | 从 `session_seq = 0` 折叠该会话全量 canonical | O(全量) |

**水位身份与完整性校验（取代 one-below anchor）**：每条缓存行除 `session_seq`、`commit_order` 外，必须保存水位事件的 `event_id` 与 `invocation_id`；`session_seq = -1` 表示空水位，身份为空。L1 应用缓存 seed 前，必须按 `(session_id, session_seq)` 读取水位事件并精确核对 `event_id`、`invocation_id`、`commit_order`、`generation`；同时核对 canonical 会话事件总数与 `session_event_cursor.next_seq` 相等，非空水位必须等于当前完整事件数，空水位必须对应零事件。L1 后缀还必须从水位 + 1 连续到当前 cursor。任一事件缺失、身份不符、generation/计数/cursor 不符或读取失败，缓存不可用，必须升级 L2。仅检查 `session_seq = 水位 - 1` 是否存在、或检查其后缀为空，**不能**证明缓存水位仍有效，禁止据此接受缓存。

会话级 `generation` 在会话创建时分配，删除后重建同一 `session_id` 必须产生新 generation；缓存及水位事件均绑定该 generation。空会话只在缓存标记为空水位且当前会话 generation 匹配、canonical 事件数为零时命中；若水位为 `-1` 但当前会话已有事件，升级 L2。若实现选择不保留 generation，则删除会话必须在同一事务中失效其缓存、cursor 与索引，且重建同一 ID 前确保旧缓存不可见；此原子性须由测试证明。

**逐 session eligibility fence（schema v37）**：只有对当前 `messages` 全量行做 L2 identity/role/body/timestamp/order 精确比较成功后，才写 `canonical_session_projection_eligibility(session_id, session_generation)`。对 `messages` 任意 INSERT/UPDATE/DELETE 的 SQLite trigger 与行变更同事务删除该标记；generation 必须与当前 session 行一致。无标记时不得仅凭有 cache seed 就用 canonical 替换展示正文，必须重新做 L2；有标记的 cursor page 可只查当前 legacy page skeleton 并从已验证 cache 合并 canonical 正文。发生新消息、编辑、删除或 queued/status 变更时标记先失效，刷新/读取 L2 再建立；该协议避免每次 warm paging 全会话扫描 skeleton，也避免页外 legacy-only 消息被部分 canonical 合并。

**备选方案（不引入 `session_seq`）**：只以 `commit_order` 定位水位事件并核验 `event_id`、`invocation_id` 与 generation；`event_count` 可额外用于发现不一致，但计数相同也不能替代水位事件身份核验。

### 5.4 为什么本方案不需要"扩展事件模型"（B1 裁定后）

| B1 前置 | 状态 |
| --- | --- |
| 扩展事件模型 | **不需要**——canonical 已有消息级事件；写入链经 `electron/toolChatLoop.ts:1063-1078` → `InvocationHistoryWriter` → `agent_history_events`（v1 评审漏追该链，v2 回请后已由其补齐实锤） |
| 改造写入路径 | **仍需要**：assistant 正文须"一次写 canonical、投影到 messages"；`updateMessageContent` 与 `appendMessage` 降级为投影更新 |
| 定义折叠语义 | **仍需要**：`thinking`/`content_segments`/`attachments`/`status`/`images_delivered_to_api` 与 canonical 事件的映射需逐字段定义（P-2） |
| 历史覆盖度验证 | **仍需要**：`historyOwnsBase` 短路意味着**同一 stream 内 `invocation-context-committed` 只写一次**，且被 `transcript-compacted` 的 stream 不再补写 → 覆盖度判据必须按此设计（P-1） |

### 5.5 checkpoint 时机与节流

强制点：**会话创建**写入空投影 cache seed、**`turn/end`** best-effort 校验/推进 cache 水位。当前 runtime 对投影 cache 采用同步 SQLite 写入，没有 write-behind 队列，故不存在 64 事件/2 秒缓冲和 close/shutdown 排空义务；会话处置（live→cold）前也无待排空的投影缓存。cache seed/刷新失败必须 fail-soft，不影响 session 创建或 turn 结果；需要异步批写时必须重新引入节流和关闭排空协议，并为 disposition/close 强制点增加故障测试。

**fail-soft 边界**：下列**不得**套用缓存式 fail-soft——工具确认提交（`confirmation_*`）、投递意图（`driver_deliveries`）、续跑 checkpoint（`agent_continuations`）、执行准入（`session_execution_*`）、`commit_uncertain` 状态机、**真相源 spill 的写入**。仅投影缓存、标题、列表提示、用量归因、可降级 spill 可 fail-soft。

### 5.6 大负载外溢（spill）——B3/B4/B6 处置

| 项 | 真相源 spill | 可降级 spill |
| --- | --- | --- |
| 内容性质 | canonical 事件的语义组成部分（正文级） | 可读/排障副本，**冗余**于 canonical |
| 位置 | `userData/spill/` | `userData/spill-degraded/` |
| **可丢弃** | **否** | 是 |
| **保留期** | **无**（B6：删除即等于删真相源） | 有（配置驱动） |
| 写侧失败 | spill 写入/验证失败时保持完整正文内联并继续 canonical DB 事务；canonical DB 事务本身失败仍然使提交失败，不能把仅落盘但未被 locator 引用的数据报告为成功 | 展示副本写入失败不影响 canonical turn |
| 读侧失效 | **硬失败**（`SPILL_CONTENT_UNAVAILABLE`）：禁止静默降级为空内容 | 降级占位（"[内容已归档]"），不报错、不阻塞 |
| 与续跑的关系 | 续跑依赖它 → 必须纳入**不可 fail-soft 集合**；保留期内禁止删除，删除前校验无活跃续跑引用 | 续跑**不得**引用 |
| 逐字节一致验收 | **纳入** | **排除**（B6 要求显式排除） |
| 共同规则 | 触发阈值 `SPILL_INLINE_MAX_BYTES`（建议 64 KiB，与 `MAX_TOOL_RESULT_CONTENT_CHARS` 分离）；索引记录 `{head, tail, bytes, sha256, locator}`（**首尾保留**）；私有目录下 `open(path,'wx',0o600)` 独占新文件；正文完整写入并 fsync/核对 bytes 与 SHA-256 后，canonical DB 事务再提交不透明 locator。DB 提交失败时不可报告成功；未被引用的文件仅可经全库引用扫描识别为 orphan 后回收，不参与有期限 retention。该 file→DB 协议必须覆盖进程在每个边界崩溃 | 展示副本写入完成后注册 `class=degradable`；提交失败时可直接丢弃副本 |

**P-5 可执行分类判据（禁止按大小或路径推断）**：

| 判定事实 | 分类/处置 |
| --- | --- |
| 数据用于恢复 invocation、续跑或构造 provider context | 必须分类为真相源；完整正文先 durable 写入 spill，canonical DB 事务再提交其 locator、byte length 和 checksum；跨文件与 DB 以可恢复协议绑定，不宣称跨介质原子事务；读取失败硬失败并返回 `SPILL_CONTENT_UNAVAILABLE`；任何保留策略不得删除 |
| 数据不参与恢复/续跑/API 上下文，且仅用于展示或排障 | 只有当删除该对象后，能从 canonical history 精确重建相同逻辑内容时才可分类为可降级；读取失败返回明确占位，不阻塞 turn；可按留痕保留策略删除 |
| 数据不参与恢复，但没有 canonical 精确重建路径 | 不允许分类为可降级；暂留内联/现有持久存储，直到补上 canonical 重建路径或定义新的不可降级真相源 |
| 数据参与恢复，但 spill 正文尚未完整 durable 写入或 canonical locator 尚未提交 | 不得报告真相源 spill 成功；spill 写入/校验失败则正文留在 DB canonical inline；DB locator 提交失败则 turn commit 失败并保留文件为待 orphan 扫描对象，不能把未引用 spill 当作已提交事实 |
| 工具结果包含 `TRUNCATED_TOOL_RESULT_MARKER_PREFIX` 或旧 oversized placeholder | 属于有损摘要，不能证明正文等价，也不能作为真相源 spill 的回退；保留现有截断语义，不得按可降级类别清理 |

`src/shared/spillSemantics.ts` 将安全核心收敛为纯函数：真相源须 `requiredForRecovery && payloadComplete && canonicalLocatorCommitted && !retentionAllowed`；可降级须 `!requiredForRecovery && canonicalEquivalent`，并依 `retentionAllowed` 执行留痕删除策略。`src/shared/oversizedToolResult.ts` 的 `isCompleteToolResultSpillPayload` 识别现有截断 marker 与旧 oversized placeholder，并供既有工具结果压缩路径使用；Vitest 用真实中段截断输出验证其不能作为完整真相源载荷。Electron `spillStore` 现实现私有 durable 文件、file→SQLite locator 协议、严格/降级读、全引用 orphan 扫描及可降级 retention；Phase 3 仍负责把协议接入实际 provider context、工具结果和恢复调用点。

### 5.7 崩溃恢复：不修日志，修复在读方（B7：逐行标注适用对象）

**关键前提**：canonical history 位于 **DB 内**，写入是**事务原子**的（整批提交或整批回滚），因此"物理追加日志"的撕裂尾概念**整体不适用于它**。下表逐行标注每个机制的适用对象。

| 情形 / 机制 | 适用对象 | 处置 |
| --- | --- | --- |
| 撕裂物理尾 / 部分写入 | **仅文件**：审计台账 `events.jsonl`、两类 spill、导出备份。**不适用 DB canonical**（无部分提交） | 文件侧由写路径在第一次新写入前截断或丢弃不完整帧；读方永不返回撕裂内容 |
| 中途崩溃的轮次（有 start 无 end） | canonical（**事件级语义中断**，与物理撕裂无关） | **不截断**；resume 计算 closers 作为普通批次追加，不执行任何副作用 |
| 只读观察方（列表/搜索） | 全部（canonical + 台账） | **仅内存配平，不回写** |
| 未终态 invocation 收口 | canonical | 按需扫描缺少终态事件的流，只计算并追加 closers；不得据此判定终态流的投影修复已完成 |
| 终态 canonical 投影补偿 | canonical → 台账/usage/tool 等派生投影 | **Phase 1 必须有可靠、持久化的逐项修复待办表**（session/invocation、repair kind、目标事件/范围、状态、尝试次数、最近错误、更新时间、幂等键）。canonical 提交与待办登记必须在同一 DB 事务；每项修复成功后才标完成，失败保留 pending 待后续启动重试。启动工作集由非终态流与 pending 待办的并集构成；终态流只有在其待办全部完成后才不再读取，已完成待办不重放 |
| 升级前历史流分类 | 已有 canonical streams | Phase 1 启用按需恢复前执行一次可中断、可续跑的初始分类：按批检查既有流并为仍缺投影义务的终态流登记待办；分类游标持久化，完成前维持旧恢复路径，不宣称性能门禁通过。后续启动仅处理分类游标剩余批次、非终态流及未完成待办，不重复全表读取 |
| `append` 尽力而为 / `flush` 为持久性屏障 | **仅文件**（台账 sink、spill）。**不适用 DB canonical** | DB 侧事务提交即持久（WAL + 现有 `synchronous=NORMAL`）；`flush` 语义退化为 WAL checkpoint。见 §5.1 |

> 台账侧的撕裂尾修复沿用[已落地方案](./session-record-eventflow-persistence-redesign-plan.md)（fail-stop、丢失量诊断）；本方案不改其语义。

### 5.8 保留期与空间回收（B6 修正后）

| 层 | 策略 |
| --- | --- |
| canonical 事件流 | 永久 |
| **真相源 spill** | **永久**（无保留期；只随其所属会话删除而删除） |
| 可降级 spill | 按配置保留期清理（留痕） |
| 投影缓存 | 可无条件丢弃；提供"清空缓存"入口（下次读为 L2） |
| 审计台账（workDir） | 保留 `maxSessions` 语义；启动对**所有 profile roots**分别执行上限；删除前查询 canonical `transcript-compacted` 依赖并检查候选台账内 compaction 事件，命中或检查失败均保留目录并记录名单。依赖保护优先于数量上限，因此受保护目录可能令实际数量超过 `maxSessions`；投影化必须与 retention 联动同提交边界（P-4/B2）；归档优先于删除 |
| **B2 顺序约束** | retention 改造不得先于投影准备上线，且须与 Phase 2 投影读路径在同一发布变更中交付；运行时每个候选须先完成 SQLite projection 持久化，再删除文件台账。投影失败则保留台账；两者之间崩溃仅留下冗余台账，可安全重试 |
| 空间回收 | `PRAGMA optimize` + 定期 `wal_checkpoint(TRUNCATE)`；`auto_vacuum=INCREMENTAL`（需一次全量 `VACUUM` 生效）+ 按需 `incremental_vacuum(N)`；VACUUM 需窗口可见后、无活跃 turn、WAL 已 checkpoint |
| 显式入口 | 设置页"存储占用"面板（按分类显示 + 清缓存 + 归档 + 压缩带进度），**分类须区分两类 spill** |
| 逃生通道 | `--safe-db-maintenance`：跳过全量恢复 → 归档/清缓存/VACUUM → 正常启动 |

### 5.9 失效与代际

`session_storage_index.revision`（size + mtime 派生或提交时递增）作为派生读取缓存的变更令牌，**写所有权变动不改变 revision**；渲染侧沿用 `scope_versions` + `scope:invalidated` 广播，不改。

### 5.10 台账文件格式演进（可选）

现为原始 JSONL。进阶：分帧 + checksum + 压缩帧（gzip/brotli，Node 内置 `zlib`）。**不作为前置依赖**；且因 F-3（运行时 compaction 重放依赖台账），格式变更需与 P-4 一并评估。

### 5.11 迁移事务拆分

`runMigrations` 按 schema version 分步执行：每一步的 DDL/data backfill 与 `schema_meta` 更新在同一个事务提交。失败时只回滚当前版本步骤，外部可观察到最后一个已提交版本，并可从失败版本重试。初始核心表创建仍作为 V1 单步事务。

### 5.12 会话级折叠序（B7 修复）

**问题**：水位线与 L1 取后缀需要明确会话级序；one-below anchor 还被错误地当作缓存边界存在性证明。真相源 `agent_history_events` 是 **per-invocation 分流表**，不满足每会话一条物理追加日志的前提。逐键核验：

| 候选键 | 可否作会话级全序 | 原因 |
| --- | --- | --- |
| `PRIMARY KEY(invocation_id, sequence)` | **否** | 仅在单个 invocation 内有序；换 stream 后 `sequence` 从 1 重新开始 |
| `agent_history_streams` 各行 | **否** | 列仅 `invocation_id`/`version`/`schema_version`/`session_id`——**没有任何时间或序信息** |
| `agent_history_events.created_at` | **否** | 毫秒级，同批写入必碰撞；且无单调保证 |
| 隐式 `rowid` | **否** | 表非 `INTEGER PRIMARY KEY`，VACUUM / 删除后可能重排与复用 |
| `turns.created_at` + 会话内 turn 串行 | **仅近似** | 时钟碰撞；且一个 turn 可能对应多次 provider 请求（多个 invocation） |

**主方案：双序**

1. **`commit_order`（全局单调）**——表 `agent_history_commit_cursor(id INTEGER PRIMARY KEY AUTOINCREMENT, allocated_at INTEGER NOT NULL)`；`appendBatch` 在**同一事务内**逐事件分配连续号，写入 `agent_history_events.commit_order`，并以冗余列 `session_id` 建索引 `(session_id, commit_order)`。schema v32 已实施；重复幂等重试不分配序，批次失败时分配器随事务回滚。
   - 作用：跨 stream 的**确定性全序**（多 stream 折叠顺序、恢复重放顺序）。
   - 注意：SQLite 无法给既有表添加 `AUTOINCREMENT` 列，故采用"分配器表 + 普通列"，**不依赖 rowid**。
2. **`session_seq`（会话内连续）**——表 `session_event_cursor(session_id TEXT PRIMARY KEY, next_seq INTEGER NOT NULL)`；同一事务内原子推进游标，写入事件行 `session_seq`。无已知 session owner 的历史事件保留 `NULL`，不得伪造其会话顺序。
   - 作用：会话内**连续**序号，用于定位增量后缀；它本身不证明缓存水位事件仍存在。
   - 争用：同会话写入本已由 FIFO 准入串行（`session_execution_queue`），无额外竞争。

缓存水位身份：缓存行保存水位事件的 `event_id`、`invocation_id`、`commit_order` 及会话 `generation`。L1 必须查询 `session_id + session_seq` 对应事件，并逐项比对身份；缺行或不匹配即 L2。`event_count` 可作为额外一致性检查，但计数相同也不能替代身份核验（删一条再插一条会保持计数）。空水位以 `session_seq = -1`、空身份表示，并核验当前 generation 的 canonical 事件数为零。

删除重建策略必须二选一并落实到事务边界：① generation 随 session 身份变化，缓存、水位与索引绑定 generation；② 删除时同一 DB 事务失效缓存、cursor、索引，重建前保证旧缓存不可见。不得仅凭 `session_id` 相同复用旧投影。

**备选方案**（若不新增 `session_seq`）：使用 `commit_order` 定位并核验水位事件身份；可用 `event_count` 作附加校验，但不得把 one-below 空尾或单纯计数当成水位事件存在证明。

**历史回填**：既有行按 `(created_at, invocation_id, sequence)` 排序一次性回填两个序号。该顺序为**近似值**（受毫秒碰撞影响），因此：

- 回填后**所有既有投影缓存行必须作废**（水位不可用 → 触发一次 L2 全量折叠）；
- P-1 报告须显式声明回填序的近似性与影响面。

**对其它章节的影响**：§5.2（水位字段成对）、§5.3（L1 与 anchor）、§5.7（适用对象）、§4.3（新增表与列）。**本节的折叠序定义是 P-2 语义表的第一节。**

**迁移成本**：schema v32 新增 2 张游标表及事件表 3 列（`commit_order`/`session_seq`/`session_id`），并回填既有事件序号；新增唯一序号索引。迁移按 `(created_at, invocation_id, sequence)` 确定性排序，时间碰撞时仍只是近似历史顺序，升级后既有投影水位全部作废。v32 迁移、新写入分配、generation、水位身份、L1/L2 和 v37 session eligibility fence 均已有迁移/运行时测试。

### 5.13 P-2 逐字段折叠语义草案

以下顺序定义是本表第一项，也是逐 stream 合并的唯一顺序来源。只有标为“可重建”的字段才能纳入投影等价测试；“缺失”字段会使对应 session 保留 legacy 读路径，除非先扩展 canonical 事实并证明其兼容性。

| 顺序 / `messages` 字段 | canonical 来源与折叠规则 | 等价性 / 缺口 | Phase 2 处置 |
| --- | --- | --- | --- |
| **会话级顺序（先定义）** | 按 §5.12 的 `(session_seq, commit_order)` 验证并排序；相同 `session_seq` 或缺失/重复序号视为损坏。只把能产生/更新可见消息的 canonical 事实送入消息折叠器，控制事件不生成空消息 | 会话内确定；历史回填序仅近似 | 新数据可进入对拍；历史回填缓存全部失效 |
| `id` | UI 源消息的稳定 `id` 随 context canonical message 保留；每条 `model-response-committed.payload.message.id` 绑定本 turn 的 `assistantMessageId`；replay message 保留有来源的 ID | 新写入有明确 UI 身份；历史无 ID、拆分为多个 API block 的 user message、synthetic tool result 不得猜测身份 | 只有唯一 ID 与 legacy row 相符且内容/顺序对拍的行可参与 cutover |
| `role` / `content` | `invocation-context-committed.payload.messages` 是当次 provider context 快照，不保证覆盖整个 UI 会话；`transcript-compacted` 在同一 stream 内以新快照替换先前快照。之后依序折叠 `model-response-committed.payload.message`、`replay-message-committed.payload.message` 与已配对的 `tool-call-finished` / `tool-call-not-dispatched` 工具结果 | 文本与结构化 block 可重建；测试证明同 stream 的 context/compaction 是替换语义。跨 invocation 快照可能重叠、截短且缺稳定身份，不能直接串接或按 role/body 去重 | 可重建字段纳入逐字节对拍；跨 stream 无法唯一关联的会话保留 legacy |
| `thinking` | 仅从 canonical assistant `content` 中的 thinking block 折叠；不把审计台账 chunk 当正文来源 | 纯内容可重建；`isVisible`、segments 的起止时间和 metadata 不在统一 canonical 契约中 | 缺时间线时保留 legacy 值；不得伪造时序。round-trip 用例验证非空 legacy thinking 元数据由 skeleton 保留 |
| `tool_calls[].result` / `toolUse` | `model-response-committed` 给出工具 proposal；后续工具生命周期事件按 tool call ID 配对完成结果与错误 | proposal/result 可按 ID 重建；旧 `toolUse` 与 `ToolCallRecord` 的 UI/确认字段不完全同构；DB codec 对空 `toolCalls` 规范为缺省，非空工具字段从 skeleton 保留 | 仅映射字段通过对拍的消息 eligible；保留确认、风险、执行等业务状态所有权；空数组规范化为缺省。`toolUse` 是可选历史 UI 字段，非空时从 skeleton round-trip，不参与 canonical 正文淘汰 |
| `content_segments` / `activity` | 需有 canonical 可见内容变更及其顺序事实，再折叠为 TimelineSegment / activity | 当前 History 事件不提供与所有 segment 一一对应的时间区间；无法保证旧时间线逐字节一致；DB codec 空 `contentSegments` 规范化为缺省 | 缺失时该会话不 eligible；不得以一段整体正文替代原分段；空数组规范为缺省 |
| `attachments` / 图片 | canonical image block 可保留 API 正文；投影元数据需从同一消息的不可变 attachment reference 恢复 | 图片 base64 可由真相源内容重建，但 `stagingKey`、原文件名及投递后的 staged-file 状态并非 canonical message block；DB codec 空数组规范化为缺省 | attachment 引用未纳入 canonical 前，该会话走 legacy；空数组规范为缺省 |
| `status` | invocation terminal 不能推出每条 message 的 `queued`/`sending`/`streaming`/`failed` 状态 | **不可映射**：这是消息/turn 流程状态，不是正文事实 | 保留在权威消息骨架，不放入可丢弃正文缓存；不得由消息折叠推断 |
| `sequence` / `timestamp` | `sequence` 从有序 canonical 消息事实中重新分配；优先用消息自带 timestamp，否则记录 event `created_at` | 跨 invocation 顺序可确定；若 canonical message 未保存原 UI timestamp，则仅有 event 时间近似 | 精确 timestamp 缺失时不声称逐字节等价 |
| `images_delivered_to_api` | 需要图片成功投递确认事实 | **不可映射**：History 当前无对应事件 | 保留在权威消息骨架/交付状态；若未来要从 canonical 删除此字段，先新增具备幂等键的 delivery fact |
| `activity` | 需有 canonical 可见内容变更及顺序事实，再重建 `AssistantActivityItem` timeline | 当前 History 不保存所有 bounded turn activity 项及其 UI 顺序 | 保留在 skeleton；当前 schema 不含该列，DB round-trip 不支持。Phase 2 不迁移 activity，使用 activity 的会话需要整体 legacy fallback |
| `skill_hints` | renderer/turn 输出维护展示提示 | History 不承诺恢复 skill hint 展示状态；DB codec 空 skill hints 规范化为缺省 | 非空从 skeleton 保留，空数组规范为缺省；不得从 canonical 正文推断 |
| `sessionId` | 所有 canonical rows/cache 均按 session id 过滤，cache 还校验 generation | session 归属是行/事件 owner 而不是 message body | 仅在同一 session 读取合并；session id 或 generation 不匹配即拒绝 cache 并走 legacy |
| `schemaVersion` | 当前 `Message.schemaVersion` 由 `appendMessage` 使用 app schema 版本设置 | History 不保存逐消息 legacy schema 版本 | 保留于 skeleton；不参与正文缓存，L2 不将它当作 canonical 对拍字段 |

**P-2 eligible 判据**：被迁入正文缓存的字段必须在 identity、内容和顺序上通过 legacy `messages` 与 canonical fold 的逐字节对拍；不可映射的骨架/控制字段继续由原有权威存储提供，不因正文缓存切换而删除。单纯正文 hash 相等、role/content 相等或每个 session 都有 context/response 事件均不足以证明消息身份。DB codec 规范化契约为：非空值逐字段 round-trip，空数组/无值映射为缺省；`imagesDeliveredToApi=false`、message status、非空 thinking 与工具/附件元数据必须保留。`activity` 是 messages 表外列，使用它的 session 不得走 canonical projection。v32 双序写入/迁移已有 TDD；v33 generation、DB fold 与水位缓存 API 已有聚焦 TDD；Phase 2 字段回归覆盖主要字段的精确保留及空值规范化。

**跨 invocation fold 约束**：每条 invocation stream 的 context 是 provider 请求上下文，不是 session snapshot。即使两条 stream 按 `(session_seq, commit_order)` 排序，也不能把两份 context 都当消息增量；必须以 stable message ID 和显式 snapshot/replacement 边界对齐。缺 ID 或快照间无法证明连续关系时，整个 session 保留 legacy 路径；不得以正文相同猜测重复、也不得把已被后续 context 截去的消息误删出显示历史。

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

本节中的“旧会话按需迁移”特指：P-1…P-5 全部满足、Phase 2 双读上线后，canonical 覆盖充分的旧会话在首次打开/resume/API context 时全量折叠生成新投影缓存；未访问且 eligible 的会话由后台分批补迁；不 eligible 的会话继续使用 legacy 读路径，直到有经过验收的替代方案。迁移任务的中断恢复、回滚与完成判据分别由 §7 原则、§8 阶段门控和 §9 验收标准约束。

### 7.1 P-3：transcript 协议职责迁移边界（门禁已通过；快照删除仍门控）

代码证据显示 `agent_history_streams.version` 按 `invocation_id` 做 CAS，而 `session_transcript_checkpoints.version` 按 `session_id` 跨 turn 递增；两者作用域不同。不能把前者直接写入迁移映射，也不能把 `session_seq` 当成完整替代：序号只提供排序，不提供同 turn payload 相等/冲突语义。

候选目标需拆为三个契约：

| 契约 | 所需语义 | 候选承载 | 禁止的替代 |
| --- | --- | --- | --- |
| 会话 transcript 版本与顺序 | session scoped 单调版本/CAS，以及 append 的有序提交位置 | P-2 的 session cursor / session sequence；与 canonical append 在同一 SQLite transaction | invocation scoped `streams.version` 或毫秒时间戳 |
| 同一 turn 快照级幂等 | 相同 `(session_id, turn_id)`、outcome、消息 JSON 字节必须返回原结果；任一不同则 `idempotency-conflict`；receipt 不存正文 | 小型 `session_turn_commit_receipts`，记录 payload SHA-256、base/next version、event range、outcome；精确冲突判定还需持有规范 JSON 字节或强哈希契约 | 只依靠各 canonical event 的 `idempotency_key`；两边原子粒度不同 |
| 准入与执行所有权 | FIFO queue、owner、generation fencing、commit_uncertain / operator reconcile | `session_execution_claims`、`session_execution_queue` 与 accepted-turn 状态继续留在控制面，当前数据库事务内维护 | 把准入状态塞进消息事件并从 projection 推断 |

协议按实际流式 History 写入边界修订为：canonical message facts 按事件/批次逐步追加并各自保持不可变；SDK 收到完整 turn 结果后，把 terminal History event 作为该 turn 的封口，与 transcript receipt/checkpoint/执行 fence 同一 SQLite 事务提交。事务内先查同 turn receipt（相同 payload 重试返回原版本；不同 payload 拒绝），再核验 checkpoint base version/CAS，然后追加 session-scoped terminal event、记录覆盖本 turn canonical History 的 `session_seq` event range、写 receipt/checkpoint，并把 claim/queue 转成 `transcript_committed`；投影收尾后才释放 fence。receipt event range 可证明封口涵盖的 canonical 前缀。若该事务失败，回滚 terminal 与 transcript 状态；SDK 仅追加 terminal 事实作为故障记录，handoff 必须进入 `commit_uncertain`，不得声称 checkpoint 成功。只有此成功/失败边界上的重复提交、并发不同 turn CAS、DB reopen、逐项故障回滚、启动恢复和撤销 participant 修复转红用例全部通过后，才允许移除 `messages_json`。若 canonical 不能逐字节重建 transcript 快照，则旧快照留作权威回退，不得先删后补。

当前实现状态（schema v36）：`session_turn_commit_receipts` 记录 payload SHA-256、session base/next version、outcome 与 terminal 封口覆盖的 canonical `session_seq` 范围；SDK 提供的 transcript intent 只在调用期传递，不写入 History payload。`SqliteAgentHistory.appendBatch` 在外层事务里追加 terminal event，再通过嵌套 savepoint 写 `session_transcript_entries`、receipt、checkpoint 及 claim/queue 的 `transcript_committed` 状态。同 turn 重试优先按 receipt 判定；v34→v35 receipt 迁移、v35→v36 执行状态迁移均有幂等/保留已有数据测试。9 个聚焦测试文件共 399 项、真实 Hosted IPC 故障路径 120 项、Electron typecheck、增量构建和 `git diff --check` 均通过。

P-3 协议门禁通过，但 `messages_json` 仍保留权威/恢复责任：先行追加的 canonical stream facts 可能在进程中断时只形成未封口前缀；terminal-only fallback 会产生缺 receipt 的不确定终态；两者都由现有恢复/人工 reconcile 路径处理。只有后续实现证明 canonical 可逐字节替代旧快照并完成撤销测试后，才可删除 `messages_json`。Phase 2/3 仍由 P-1/P-4/P-5 门控。

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
| Phase 0 可观测 | **完成** | 只读数据库画像、启动分段采样和覆盖率报告已记录；旧 JSON 迁移备份若存在，窗口可用后询问用户并仅在确认后归档 |
| Phase 1 写侧止血 | **完成（实现与本阶段验证）** | 持久化义务表、canonical sidecar 事件与待办同事务登记、升级前分类游标/分批续跑、分类未完成时旧路径与 pending 并行、分类完成后按非终态 + pending 工作集恢复均已实现；逐目标失败/重试矩阵、分类与全量恢复差分等价及隔离冷启动采样通过。Phase 1 不代表旧消息正文可切换为新投影 |
| Phase 2 投影化 | **完成** | 逐 session exact L2 比对 + generation fence + messages 变更触发器失效；Chat IPC full/page 投影；turn end/create cache 点；未 eligibility 的会话 legacy fallback；warm page 相对旧页 p95 门禁通过；API context 原状态/附件/流程语义保留并验证耗时 |
| Phase 3 spill + 恢复按需 | **完成** | source-truth locator 覆盖 tool/assistant/context/image/terminal/transcript；恢复与 provider context strict hydrate；缺失/篡改硬失败；DB reopen/orphan full scan、retention class 和 20 轮体积门禁通过 |
| Phase 4 回收与保留 | **完成** | 只读空间画像与 Settings 存储面板；清 projection cache；归档 DB 与两类 spill；WAL checkpoint、optimize、incremental auto-vacuum/vacuum/reclaim；活动 turn fail-closed；degradable retention 不触及 source-truth |
| Phase 5 messages 纯投影化 | **暂停** | 高风险，需单独评审 |

### 8.1.1 当前实现记录（worktree：`codex/session-storage-refactor-tdd`）

| 项 | 当前事实 | 状态 |
| --- | --- | --- |
| schema | v31 新增 `canonical_projection_repairs` 与分类游标；v32 双序；v33 generation；v34 cache ver；v35 turn receipts；v36 transcript commit fence；v37 projection eligibility + messages mutation invalidation triggers | 已实现并有迁移用例 |
| 正文索引 | v31 升级删除 `idx_messages_content`；搜索仍用原 LIKE 语义，避免破坏转义/排序/权限过滤 | 已实现；搜索与迁移用例通过 |
| 消息计数 | `appendMessage` 改为会话 `message_count` 增量，不再每条消息执行全会话 `COUNT(*)`；删除队列消息仍重算以修复计数 | 已实现；顺序追加与计数对拍通过 |
| 新写入 | 携带有效 `sessionLedger.location` 的 canonical event，在同一 DB 事务登记以 `target_key=event_id` 定位的 projection obligation；登记失败会回滚 canonical 批次。canonical context 保留源 message ID；model response 在 History append 边界绑定 turn assistant ID | 已实现并有事务回滚及 message ID 往返用例 |
| 历史分类 | 按 invocation ID 游标以有界批次检查已有事件，为携带有效 `sessionLedger.location` 的事件逐项登记待办，记录每批游标并可重启续跑；分类完成前恢复仍走旧全量 stream 路径，但始终处理已登记的 pending 待办 | 已实现并有批次/续跑用例 |
| 启动接线 | `main.ts` 每次启动推进一个分类批次；分类异常只记录告警并继续旧全量恢复 | 已实现；隔离 Electron 冷进程集成采样通过 |
| 恢复工作集 | 分类完成后读取非终态流与 pending obligation 的并集；待办按目标事件重放，ledger 隔离失败，失败或缺少修复器时保持 pending；成功后标记 completed。已完成终态流不再读取，已完成待办不重放 | 新增回归覆盖终态待办首次失败留 pending、后续恢复重试成功；既有逐投影目标失败矩阵与工作集复杂度测试继续覆盖 |
| 消息计数与索引 | 去掉正文 B-tree 索引；搜索保留原 LIKE、转义、排序与权限过滤语义并扫描匹配范围；消息计数改增量维护 | 已实现；行为测试通过 |
| 工具结果 | `messages.tool_calls[].result.data` 中超长字符串复用既有压缩格式，canonical history 保留完整结果 | 已实现并有序列化回读用例 |
| 迁移事务 | 每个 schema version 独立事务；当前步骤失败整体回滚，已提交版本保留并可从失败步骤续跑 | 已实现；v29→v30 成功、v30→v31 注入失败的持久化边界用例通过 |
| 启动复杂度 | 已完成终态且无 pending 义务的流数量增长时，不增加 `read()` 次数；非终态流和 pending 义务进入工作集 | 已实现并以 128 条已完成流 + 1 条待办断言 read 次数；另有隔离 Electron 冷进程大库分段采样 |
| message identity | canonical context 往返保留 UI ID；响应在 turn append 边界绑定 assistant ID；无身份的历史 cutover fail closed；provider wire 不包含内部 ID | 聚焦 TDD 用例通过；旧样本仍 0/335 identity/body 候选命中 |
| P2 projection cache | create-session seed cache + eligibility；L2 对当前全量 legacy 行精确认证后授予 generation-scoped fence；message 任一变化由 trigger 原子失效；warm page 仅取页内 skeleton，cache 不可用或资格撤销即 full legacy/L2 | 基础路径、pending legacy row、ID/role/body/order 失配、字段 round-trip、同库 mixed eligible/legacy session、页外 legacy-only 行 fallback、INSERT/UPDATE/DELETE 失效和更新后再认证均有 TDD |
| P2 性能门禁 | SQLite 临时文件库、1200 条 legacy + canonical 消息；warm L1 cursor page 对照旧 `getChatMessagePage`，各预热 10 次后测 30 组、每组连续 5 次读取的平均值并取 nearest-rank p95，限值 legacy p95 ×2 + 5ms；同样采样 legacy API `getTurnContext`，要求 <50 ms | 比较性 regression 通过；API context 读实现没有切换到展示 projection，仍由既有过滤路径给结果。该数据为同机回归，不替代生产数据分布/真实设备端到端 p95 |
| Retention | 对所有 profile roots 分别执行上限；canonical 或台账仍有 compaction 事件时 fail-closed 保留并记审计名单；projection 先落 SQLite 再删除台账 | 已实现；P-4 门禁通过，含跨 DB reopen 故障用例 |
| 当前验证 | `npm test`、shared/renderer/agent-sdk typecheck、Electron 增量构建、i18n 检查、B1/B2 聚焦测试 | v31 全量 854 文件通过、1 跳过；7,783 项通过、106 跳过；renderer/shared/agent-sdk typecheck、Electron 增量构建、i18n 检查与 diff check 通过 |
| 尚未完成 | Phase 5 `messages` 纯投影化 | 高风险，需单独评审；API context 仍保留原始权威过滤路径，不将显示页投影冒充 API 历史。P-1 旧数据只允许逐 session eligible，所有其它会话继续 legacy |

### 8.1.2 Phase 0 当前只读数据库画像（2026-10-02）

使用 `node --import tsx scripts/session-storage-profile.ts <db-path>` 对本机应用数据库只读采样；脚本采用 SQLite read-only 连接，只输出尺寸、计数和覆盖统计，不读取或输出消息正文。一次采样结果：

| 项 | 结果 |
| --- | ---: |
| 主库文件 | 247,304,192 B（约 235.8 MiB） |
| page size / page count / freelist | 4,096 B / 60,377 / 2 |
| auto_vacuum | 0（NONE） |
| `agent_history_events` | 3,895 rows；162,508,190 B payload JSON；dbstat 204,480,512 B |
| `messages` | 335 rows；17,531,898 B 主要正文列；dbstat 23,879,680 B |
| `session_transcript_entries` | 177 rows；10,400,882 B messages JSON；dbstat 13,713,408 B |
| `idx_messages_content` | dbstat 974,848 B |
| canonical streams | 182；含 context 181；含 response 176；两者皆有 176；fingerprint-only 1；compacted-without-context 0 |
| canonical sessions | 144 个有归属会话均有 context 和 response；fingerprint-only 0；compacted-without-context 0；无 session owner 的 stream 0 |
| `messages` 正文候选覆盖 | 335 行中 95 行 role + 规范化正文与 canonical body 完全相等：user 45/161、assistant 50/173、system 0/1；canonical stable identity 0 个，按 session/message ID + role/body 得到的候选命中为 0/335（不等于 cutover 资格证明） |

隔离 Electron 冷进程启动测量通过 `node --import tsx scripts/session-storage-cold-start-profile.ts <db-path>` 执行：脚本从只读 SQLite 序列化一致快照到临时 userData，清除凭据与自动化配置，将 workspace roots 指向临时目录，启动当前构建的 Electron，采集四段日志后终止并删除副本。247,304,192 B 样本的一次结果：`database.open-and-migrations` 2 ms、`canonical-history.classification` 373 ms、`canonical-history.recovery` 2,318 ms、`session-ledger.reconcile` 10 ms。此为一次新进程、热文件系统缓存的观察，不是 p95；阶段用时合计 2,703 ms，不含 renderer 首屏时间。

该次样本与 2026-10-02 §1.1 旧记录的 402,722,816 B 不同，说明数据库状态已变化；§1.1 的旧值保留作历史事实，不作为当前性能基线。会话覆盖率只证明该会话存在 context/response 类事件；95 行正文候选中 identity match 仍为 0，正文匹配可能把重复内容混同，**不能证明旧记录可按消息身份替代**。v7 起新写入保留/绑定 message ID；这不会追溯补造历史身份，未通过身份等价证明的会话必须保留 legacy 读路径。P-1 全量切换仍 no-go。冷进程分段实测见本节。

### 8.2 Phase 2/3 的解除条件（**必须先满足**）

| 编号 | 前置 | 验收证据 |
| --- | --- | --- |
| P-1 | **canonical 覆盖度量化**（判据见附录 A，**已按 F-1 修正**）：按 `invocation-context-committed` + `model-response-committed` 统计覆盖，并单列"仅有 `session-input-committed` 指纹"与"经 `transcript-compacted` 压缩"两类；消息口径同时报告正文候选与 session/message ID + role/body 身份对拍 | 覆盖报告为 0/335 historical identity/body candidates；结论是旧数据不得全量切换。既有 cutover 对缺 canonical / 身份失配 fail-closed；新写入保留稳定 message ID，逐 session 与 legacy 精确对拍成功才 eligible，否则继续 legacy。**P-1 按有界 rollout 通过，不批准旧历史批量迁移** |
| P-2 | **逐字段折叠语义表**，**第一节必须是"折叠序 + 多 stream 折叠策略"**（B7）：会话级全序的来源（`commit_order` / `session_seq`）、跨 invocation 的合并规则、回填序的近似性与缓存作废策略；其后才是 `role`/`content`/`thinking`/`tool_calls[].result`/`content_segments`/`attachments`/`status`/`sequence`/`images_delivered_to_api` 与 canonical 事件的映射（含无法映射字段的处置） | v32 双序/回填、v33 generation、stable ID、跨 invocation fold、DB cache watermark 与 L1/L2 已有 TDD；Phase 2 的 Chat IPC full/page 接 canonical 正文，逐 session exact L2 成功写入 eligibility fence，generation/双水位/anchor 核验，任一 messages INSERT/UPDATE/DELETE trigger 使 fence 同事务失效；未资格会话、ID/role/body/order mismatch、pending/unknown history 均逐 session 回退。legacy 字段矩阵已覆盖主要字段非空保留及空集合规范化；1200 条消息 warm cursor page p95 相对 legacy page regression 门禁、API context p95 门禁通过。**P-2 与 Phase 2 gate 通过** |
| P-3 | **transcript 职责迁移**（B5 + **F-4**）：拆分会话级版本/CAS、同 turn 快照级幂等与执行准入；不能直接把 invocation scoped `agent_history_streams.version` 当作 session transcript version。迁移后重复提交与一次性提交等价，撤销修复时用例转红 | 跨 reopen 相同 payload 返回原版本、不同 payload conflict、session CAS、防双 turn 旧版本提交、terminal event+receipt+checkpoint+执行 fence 同事务提交、receipt/checkpoint/queue 故障整批回滚、provider failure 同事务封口、真实 IPC `commit_uncertain` 恢复路径均有聚焦测试；schema v35/v36 迁移保留/幂等测试通过。**P-3 门禁通过**；`messages_json` 暂留至 canonical 逐字节重建和撤销测试满足 §7.1 后再评估删除 |
| P-4 | **retention 联动可用**（B2 + **F-3**）：台账删除前校验 DB 依赖；覆盖全部 profile；**并把"运行时 compaction 重放依赖台账"纳入设计**（`claudeStreamHandlers.ts:376/408/413`），给出替代来源或保留例外 | 全部 profile roots；canonical 与 ledger-only compaction 目录保留及 replay；依赖检查失败不删；普通旧 ledger 删除后 SQLite canonical fold 不变；启动入口先检查 compaction 依赖，对可删除候选先持久化 SQLite projection cache 后再删除；投影失败保留台账；投影提交后关闭/重开 DB，再重试并从 L1 读取后删除。118 项 retention/fold 测试、Electron typecheck 与 `git diff --check` 通过。**P-4 门禁通过** |
| P-5 | **两类 spill 语义定稿**（B4 + **B6**）：真相源/可降级 分类事实、读侧失效语义（硬失败 vs 降级占位）、保留期只作用于可降级类、"逐字节一致"验收的适用范围 | `classifySpillPayload` 拒绝非法分类组合；spill store 私有文件写入、fsync/目录 fsync、byte length/SHA-256 校验后才提交 SQLite canonical locator；真实 SQLite 事务失败/提交确认丢失、全 canonical History + transcript reference 扫描、引用对象保留与 orphan 回收均通过；真相源缺失/篡改硬失败，可降级副本失败显示占位并按配置保留期审计清理；清理副本前后 canonical fold 逐字节相同。spill 与 retention 19 项聚焦测试及类型检查通过。**P-5 协议门禁通过**；Phase 3 仍需把该协议接入实际大负载调用点 |

**在 P-1…P-5 全部满足前，不进入 Phase 2/3。**

### 8.3 Phase 0：可观测（放行）

- 体积画像（只读 SQL，附录 A）：`dbstat` 按对象占用、三张大表按列称重、`freelist_count`、**两条事件流规模对比**（canonical vs 台账）。
- 启动分段打点：`openDatabase` / 迁移 / `recoverInterruptedInvocations` / 台账 reconcile / 各 cleanup 各自耗时。
- 一次性清理：userData 的 `bak-spaceassistant-data.json`（63 MB）走显式确认后删除或归档。
- 验收：一次冷启动产出分段耗时表 + 体积画像 + 覆盖率初查。

### 8.4 Phase 1：写侧止血（待修复队列实现后放行）

- 删除 `idx_messages_content`；`searchMessages` 保留 LIKE 查询及转义/排序/权限语义，接受相应查询范围内全扫。
- `appendMessage` 去掉 `COUNT(*)`，改增量计数。
- 落库前对 `messages.tool_calls[].result.data` 超长字符串套用与出站一致的压缩（复用 `compactOversizedToolResultContent`）；canonical history 仍存完整结果。
- 将启动恢复拆为两类独立义务：① 未终态 invocation 按需扫描并收口；② 已终态 canonical 的台账、model request、usage、tool call/result 等跨存储投影补偿。必须实现持久化逐项待办队列，且 canonical 写入与待办登记处于同一事务。启动只扫描非终态流和待办队列中的未完成项；修复失败保留待办，成功后按幂等键标记完成。
- 对升级前历史流执行一次分批初始分类，为缺失投影登记待办；使用持久化游标支持中断续跑。初始分类未完成时不得切换到按需恢复，也不得宣称 Phase 1 性能验收通过。分类完成后，常规启动不得再枚举所有已终态 streams。
- 迁移事务拆分（§5.11）与启动分段打点合流。
- 测试：索引删除后搜索等价；`message_count` 与 `COUNT(*)` 一致；工具结果压缩标记可往返；非终态收口与修复待办结果和全量重放等价；终态及非终态投影修复失败后重启可重试；升级前分类可中断续跑且不遗漏待修复义务。

### 8.5 Phase 2（已完成，P-1…P-5 门禁通过）

P-1…P-5 全部先决 gate 已通过。v37 eligibility fence 只在全 session exact L2 对拍成功后授予，message 任意插入/更新/删除由同事务 trigger 失效；eligible warm page 限定读取页内 skeleton + canonical cache，资格缺失/水位失配回到 L2/full legacy。字段矩阵与 per-session mixed rollout、有 mutation 后失效及重新认证用例通过。1200 条消息、预热 10 次后测 30 组（每组 5 次读取平均值），比较 warm projection cursor page 与旧 legacy page，nearest-rank p95 门槛为 legacy ×2 + 5 ms；API context 的原 `getTurnContext` 过滤/流程路径保持 legacy，测得 p95 <50 ms。历史 0/335 identity 候选保持 legacy，测试确认同库中 eligible 与 ineligible 会话独立处理。create-session/turn-end checkpoint、页面 IPC、retention P4 顺序与类型/构建回归通过。Phase 2 完成；按序进入 Phase 3。

### 8.6 Phase 3（已完成）

按计划顺序将 P-5 durable store 接入所有 canonical large-payload 写入位置：`tool-call-finished.payload.result.data`、`model-response-committed.message.content`、`invocation-completed.outputText`、`invocation-context-committed` / `transcript-compacted` canonical messages 的 text/thinking/image base64，以及 P-3 `session_transcript_entries.messages_json`。>64 KiB UTF-8 写到 DB 同目录 userData `spill/`；先 fsync 文件与目录并校验 byte length/SHA-256，再以 SQLite 事务写 locator；准备失败完整正文 inline，事务失败留下待全引用扫描处理的 orphan。`replayContent` 独立有界。History read/readSync、transcript read、recovery 和 provider context strict hydrate；source 缺失/篡改抛 `SPILL_CONTENT_UNAVAILABLE`，不得空结果或降级。turn receipt hash 基于原始快照，locator、receipt、checkpoint、execution fence 同事务提交。完整证据包含：真实 registered tool event + locator + bounded replay；close/reopen hydration 与 canonical+transcript full-reference orphan scan；DB rollback、提交 ack 丢失、准备/读取完整性故障；source 永不被 degradable retention 清理、可降级副本清理前后 canonical fold 等价；cold L2 与 warm L1 transcript exact fold；20 轮 response + terminal + 累积 transcript 主库增长 ≤ canonical 正文 10%。新增 recovery fail-closed 回归确认正文丢失时同步 History 读取及启动恢复都失败。全量套件 851 文件通过、1 跳过（7,773 项通过、106 项跳过）。

### 8.6.1 Phase 4（已完成）

按 §5.8 提供设置页“存储占用”：数据库文件、WAL/SHM、messages/canonical History/transcript table bytes、source/degradable/orphan spill 和总量；刷新、清 projection cache、归档并压缩操作可见，成功/错误/活动 turn 拒绝状态明确。profile 为只读查询。清缓存只删 `canonical_session_projection_cache` 与 eligibility fence，保留 canonical repair obligations、turn receipts 与执行协议数据。

压缩先确认无活动 claim/queue turn 并 `flushSave` + `wal_checkpoint(TRUNCATE)`；创建随机唯一归档目录保存 DB、`spill/` 与 `spill-degraded/`，并验证 DB 文件尺寸后才运行 `PRAGMA optimize`、`auto_vacuum=INCREMENTAL`、一次 `VACUUM` 和 `incremental_vacuum`。分阶段事件经 preload IPC 提供 UI 进度。空闲时每 15 分钟执行 `PRAGMA optimize` 与 `wal_checkpoint(TRUNCATE)`，活动 turn 时跳过；退出时清除维护定时器。`--safe-db-maintenance` 使本次启动跳过 canonical 全量 classification/recovery，等窗口和 IPC 就绪后归档数据库及两类 spill、清 projection cache、再压缩；失败时保留窗口和数据，下一次普通启动运行恢复。存储维护用例确认归档 DB 可独立打开、两类 spill 都在归档内、压缩后 DB 文件可见缩小、`auto_vacuum=2`，且运行中的 turn 会 fail-closed 拒绝。启动 retention 只按配置清理 degradable spill，source-truth 不可进入清理候选。Phase 4 settings/profile/maintenance/IPC 及导航聚焦测试 21 项通过；v30 safe-mode/周期维护/旧 JSON 归档和压缩回归聚焦测试 9 项通过。UI detector、i18n 检查、renderer/shared/agent-sdk typecheck、Electron 增量构建通过；v30 全量 854 文件通过、1 跳过，7,779 项通过、106 项跳过。

### 8.7 验证命令

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

1. 分类完成后的冷启动恢复耗时与非终态流数量及未完成修复待办数量成正比，不随已完成终态流数量或其事件总量增长。复杂度对拍：固定非终态流和待办数，逐步增加已完成终态流及其事件数，验证恢复扫描的行数/解析事件数保持稳定；再增加非终态流或待办数，验证工作量相应增长。
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
12. **B7 专项**：新写入的 canonical 事件同时具备 `commit_order`（全局单调）与 `session_seq`（会话内连续）；水位任一字段缺失时必走 L2。
13. **B8 专项**：canonical 终态已提交但台账/usage/tool 等投影写入失败后，重启仍会修复；首次修复失败后再次重启会重试；只有修复义务全部完成的终态流才可跳过扫描。
14. **B9 专项**：删除恰好位于缓存水位的事件会触发 L2；空会话水位与首次事件可区分；删除后以同一 `session_id` 重建会话不会命中旧缓存；删水位事件后即使前一事件仍存在、后缀为空也不得接受旧 `val`。
15. **B10 专项**：固定非终态流与待办数、递增已完成终态流和事件数，常规冷启动恢复扫描/解析工作量不增长；升级前初始分类可续跑，分类失败时仍保留旧恢复路径。
16. 全程测试通过、增量构建通过、`git diff --check` 无输出。

---

## 10. 风险与明确不做

### 风险

| 风险 | 缓解 |
| --- | --- |
| 投影折叠语义漂移（顺序/工具配对/thinking 候选/图片标记） | P-2 逐字段语义表 + 真实会话回放对拍（硬验收） |
| P-1 判据失真导致错误 go/no-go（F-1 教训） | 判据以"含正文的事件"为准；单列指纹-only 与压缩类别；报告给出统计口径 |
| 历史 canonical 覆盖不全，投影化后老会话退化为空 | P-1 先行；覆盖不足的老会话保留旧读路径（不做一刀切） |
| 缓存水位事件已删除或会话 ID 被复用 | `ver` 门控 + **会话级双水位** + 水位事件 `event_id`/`commit_order`/generation 身份核验；one-below 空尾不作为存在性证明 |
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

## 11. 已确认约束与待决问题

以下代码检查已收敛原开放问题；其中标为“待 P-3/P-5”的设计决定仍属于阶段门控，不能视为已实现：

| 项目 | 当前证据 / 结论 | 后续处置 |
| --- | --- | --- |
| `messages.attachments` | 持久化为附件元数据；canonical image block 可携带 Base64 图片内容。附件引用、暂存路径与源文件名并不因此可重建 | P-5 区分正文真相源 spill 与可降级元数据；P-2 未纳入稳定 attachment reference 前保留 legacy 路径 |
| `accepted_turn_contexts.accepted_turn_json` | 当前保存 turn/request/session/lane/startToken/currentUserMessageId/transcriptVersion/config 等准入元数据，不保存消息正文 | 正文 spill 不因该字段扩张；随 P-3 评估准入状态所有权 |
| `images_delivered_to_api` 与 message `status` | canonical History 没有对应 delivery fact；逐消息流程状态也不能由 invocation terminal 推出 | 保留在权威消息骨架。若未来迁移 delivery 状态，先新增幂等 canonical fact；不得由正文折叠推断 |
| `apiContextService` 500 条基线 | 投影缓存可能减少重复折叠，但尚无双读实现和实测依据 | P-2 实施时测量；不得把潜在复用计入当前性能收益 |
| checkpoint / claim / queue 职责 | checkpoint 快照幂等与 History 事件幂等语义不同；现有跨 reopen 测试仅证明旧快照行为 | P-3 单独设计职责迁移、重复提交、回退与跨重启恢复；当前均保持权威 |

> 台账 compaction 重放依赖已按 F-3 并入 **P-4**；普通台账清理后的 DB 折叠等价仍是 P-4 未通过项。

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
| **方案已选** | 采用主方案：`commit_order` + `session_seq` 双序。它提供全局确定顺序与会话内连续后缀游标，满足 L1 取后缀及跨 invocation 合并的定义；成本为 2 张分配器表 + 事件表 3 列 + 1 索引。实施仍受 P-2 与 Phase 2 门控 |

### 12.4 v5 处置（B8 终态修复义务 + B9 水位身份）

| 编号 | 评审结论 | 处置 |
| --- | --- | --- |
| **B8** | 只扫描非终态流会漏掉终态 canonical 已提交、但台账/usage/tool 等跨存储投影尚未完成或上次修复失败的流；现有恢复逻辑在判断 invocation 状态前也会修复这些义务 | 将未终态收口与终态投影补偿拆开：未终态按需扫描、追加 closers；终态补偿必须独立跟踪每项待办并允许失败后重试。修复全部完成前不能从启动恢复中排除该流；若无可靠队列，仍须扫描并检查终态流。新增终态写入失败后重启修复及连续失败后再次重启重试用例（§5.7/§8.4/§9） |
| **B9** | `session_seq = 水位 - 1` 的 anchor 存在、且后缀为空，不能证明缓存水位事件本身仍存在；删除水位事件而保留前一事件时，陈旧投影会被接受 | 移除 one-below 空尾的存在性证明。缓存记录水位事件 `event_id`、`invocation_id`、`commit_order` 与会话 generation；L1 必须读取并核验水位事件身份，不存在或不匹配即 L2。定义空水位判据与同 session ID 删除重建策略，增加删除水位事件、空会话、session ID 重建用例（§5.3/§5.12/§9） |

### 12.5 v6 重审处置（B10 Phase 1 复杂度矛盾）

| 编号 | 评审结论 | 处置 |
| --- | --- | --- |
| **B10** | 允许在无可靠待办队列时每次启动检查全部终态流，与“恢复耗时只随非终态流增长”的性能验收矛盾；事件越多，旧式逐流读取/解析仍按全库规模增长 | 将持久化逐项修复待办、canonical 写入与待办同事务登记、升级前历史流初次分类/续跑列为 Phase 1 必需；分类完成前保留旧恢复路径。分类完成后，常规启动仅读取非终态流与未完成待办，不得枚举已完成终态流。性能验收改为固定非终态/待办数量并递增已完成终态流的对照测试（§5.7/§8.1/§8.4/§9）。实现增加 128 条已完成终态流 + 1 条非终态待办的 SQLite 复杂度用例；不替代真实冷启动耗时测量。 |

**当前状态（v17）**：Phase 1 已完成当前实现与验证门禁。`sqliteAgentHistory.test.ts` 覆盖 request header/context、provider retry、response usage/final context、tool proposal/result、compaction、terminal 的修复/失败/重试，并以分类恢复与旧式全量恢复对比恢复状态、canonical snapshot、投影回调及队列状态；独立复测证明七类 callback 故障留在 pending，下一轮恢复后 completed 且 attempts=2，compaction 有其独立的失败后重试用例。另有已完成终态流增长的固定工作集复杂度断言及隔离 Electron 冷进程分段采样（单次热缓存观察，非 p95）。P-5 spill 分类为纯函数/聚焦 TDD；P-2 新增双序、ID 往返/绑定、跨 invocation 折叠/对拍、真实 DB fold、v33 generation、watermark cache API、DB L1/L2 后缀/回退与 v34 cache ver 失效 TDD。本轮 P-2 相关四个测试文件 194 项通过，Electron 增量构建、shared/renderer 类型检查通过；v34 cache ver 门控后的全量回归 846 文件通过、1 跳过（7,711 项通过、106 项跳过）。只读画像仍有 0/335 历史 identity/body candidate。Phase 1 完成不构成 Phase 2 前置门禁豁免。

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

-- 恢复基线：统计未终态收口流与持久化队列中的未完成投影义务。
-- 常规启动不得靠枚举已完成终态流判断投影状态。
SELECT
  (SELECT COUNT(*) FROM agent_history_streams s
   WHERE NOT EXISTS (
    SELECT 1 FROM agent_history_events e
    WHERE e.invocation_id = s.invocation_id
      AND e.kind IN ('invocation-completed','invocation-failed','invocation-interrupted')
  )) AS nonterminal_streams_to_close,
  (SELECT COUNT(*) FROM canonical_projection_repairs WHERE status <> 'completed') AS pending_projection_repairs;

-- 一次性迁移基线可按状态分类；迁移完成后，此查询不进入每次启动路径：
-- SELECT status, repair_kind, COUNT(*) FROM canonical_projection_repairs GROUP BY status, repair_kind;
```

**注意**：本会话环境对落盘脚本与任意 SQL 执行有安全限制，上述 SQL 需由人工或有权限的会话执行；执行请在**只读**模式（`mode=ro`）下进行。

## 附录 B 术语

| 术语 | 含义 |
| --- | --- |
| canonical history | DB 内的消息级事件流（`agent_history_events`），本方案的真相源 |
| 审计台账 | workDir 下的 `events.jsonl`，turn/tool/request/chunk 级**增量流**，可清理 |
| 投影（projection） | 从 canonical 事件纯折叠出的读模型 |
| 水位线（`session_seq` / `commit_order`） | 会话级折叠水位：`session_seq` 会话内连续（定位 L1 后缀）；L1 另核验水位事件的 `event_id`、`commit_order` 与 generation；`commit_order` 全局单调（跨 stream 合并排序） |
| 读阶梯（L0/L1/L2） | 零 I/O → 缓存 seed + 尾重放 → 全量折叠 |
| `stateVersion`（`ver`） | 折叠语义/序列化结构的代际；失配即丢弃缓存 |
| 真相源 spill | 承载 canonical 正文的外置存储；**不可丢弃、无保留期** |
| 可降级 spill | 冗余可读副本；可丢弃、可按保留期删除；不参与逐字节一致验收 |
| fail-soft | 失败只留痕不阻塞（**仅限派生数据**） |
