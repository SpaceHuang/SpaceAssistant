# 会话存储重构技术方案：canonical 事件流为正文真相源，保留权威消息骨架与流程状态

| 字段 | 内容 |
| --- | --- |
| 文档状态 | **v258 · Phase 5.0–5.4 已完成；5.5 读点与清理协议的实现/隔离演练已完成。固定候选 `9f9faa1d` 的 detached clean checkout 已通过全量测试、构建、类型与 i18n 检查，并生成 x64/arm64 本地 DMG；两个包在隔离 schema-v46 canonical-only profile 上完成启动与实际 IPC 读取，含 cold-L1 重建和损坏 History fail-closed。版本化候选 `0.2.3` 已通过部分 IPC smoke，但现场发现终态 assistant live UI handoff 故障，修复已在 TDD 分支红绿验证。固定候选 `a17ac8e1`（0.2.4）的 detached clean checkout 通过全量测试、类型、i18n 与 build，生成并校验 x64/arm64 本地 DMG，包内 app 通过 ad-hoc codesign 验证；该包已用隔离 profile 验证启动后显示 previously-stuck completed 回复且 composer idle；未复现 in-process terminal race，该复制 profile 为 legacy-body，故另以 schema-v46 canonical-only fixture 通过包内真实 IPC 读取四消费者，并在隔离副本移除 History context 后验证四消费者均返回 `CANONICAL_SESSION_CONTENT_UNAVAILABLE`；spill 字节损坏与 allocator 故障矩阵仍未覆盖，且未发布，不能作为已支持 R；完整消费者/故障矩阵及 R→C→R 发布产物演练尚未完成。生产设备分布测量改为发布后观测项，不再阻断项目内开发；本机自动性能门槛继续作为开发验收。真实数据停写/清列仍须先具备并验证已发布兼容回滚版本。 真实文件 SQLite `chat:prepare-turn` 已在 canonical-only + reopen + L1 miss 后验证 reuse-user 正文、完整历史路由窗口、附件/vision 与 prepared turn；缺失 History 正文会在路由前 fail closed，route await 期间的真实消息 mutation 会因 revision CAS 终止配置。Hosted process-restart accepted-input 已覆盖 canonical-only/reopen；另验证 Hosted failure terminal 在 canonical-only 旧行下提交失败 checkpoint 并保留旧列为空。shutdown backup flush 的暂时失败重试、永久失败上限和 canonical-only restore 也已覆盖。terminal assistant 展示 IPC 已覆盖 canonical-only/reopen，以及非法 JSON/缺失 History 消息身份时 fail-closed；L1/L2 校验实际事件行数与 cursor、每条 invocation 的 stream version/schema/sequence 连续性，尾事件删除、尾 sequence gap、全局 commit cursor 超前/内部空洞、未知事件 kind、非法/非规范 JSON、缺失 toolCallId 的工具终结事件、孤立 start/finish、重复 start、重复 proposal ID、终态 payload 篡改和缓存后终态追加均会拒绝 stale transcript。v42 迁移使 History UPDATE/DELETE 与 stream 归属变更时失效 transcript cache；L1 尾部通过轻量全流聚合检查序号范围、版本及 schema 一致性，仅折叠尾 payload；工具/approval 状态尾事件验证完整 invocation，防止水位前 proposal 状态被 seed 遮蔽。L1 和 L2 均复用 SDK batch validator 检查身份、kind 与规范 JSON，并执行 canonical-only 的 pending tool identity 转移校验；L1 尾部还以全 invocation 聚合检查 turn_id 唯一，避免缓存水位后的非 transcript 事件绕过 L2 的 turn 归属校验；认证 fold 同时核验全局 commit cursor 与所有 History 行连续一致。 v46 新增轻量 allocator 完整性账本：migration 先按现存 cursor/event 重建 pending 与连续性状态；allocator 分配再登记 pending cursor，匹配的 History event INSERT 在同一事务清除；暖 L1 读取只查账本标记，不扫描全局事件。未配对分配使 L1 转入 L2 并由全局连续性校验 fail closed；allocator UPDATE/DELETE 永久标记损坏并撤销投影/API 资格；未配对 INSERT 由所有 canonical 读取的完整性校验拒绝。正常配对追加保留旧水位 cache 供 L1 折叠尾事件。遇到 terminal 时先验证完整 invocation History，以免水位前未完成 tool call/approval 被隐藏。v43 对 cache value 校验 SHA-256，伪造的格式正确正文会丢弃并由 History L2 重建；无 checksum 的旧 cache 在升级时清除，空会话 seed 也记录 checksum。canonical-only transcript 无论 L1 命中还是 L2 重建，在 source spill 丢失或篡改时都 fail closed；新增跨 DB reopen 用例证明持久 cache 不会遮蔽 source 故障。84 KB 单 spill 的 L1 p95 为 0.45–0.68 ms；20 轮 40 条、每条 83.6 KB 的 multi-spill transcript，v175 后 focused multi-spill L1/search p95 15.43/15.21 ms；完整 suite 负载复测为 16.27/15.50 ms，均低于 20 ms 数据库搜索线（仍不是生产设备分布）；720 条、3 会话、60 命中的 cold-L1 global search p95 8.84 ms（完整 suite 负载；focused 8.92 ms），均低于 20 ms 搜索自动门禁。终态与流式 assistant History 镜像遇到 `canonical-backed-only` 均只保留旧列空值，不再复活正文；红测覆盖两处写入。队列删除、移序与 queued 正文编辑的 preview 故障回滚均保全消息/sequence、receipt、preview 与 eligibility fence；移序成功路径也已验证最后一条 canonical-only assistant 正文继续维护 preview。v181 新增真实启动顺序回归：持久 turn snapshot 恢复遇到 canonical-only History owner 损坏时，仅跳过不可投影的快照并继续 durable coordinator recovery。v182 用红测证明快照恢复回调即使抛出相同错误标记也必须向上传播；将容错 catch 收窄到正文投影读取，避免把 turn 恢复本身的异常误判为可跳过。v183 验证坏 History session 不阻断后续健康 session 的恢复；v184 补齐缓存水位前存在未完成 tool proposal、尾部追加 terminal 的 canonical-only 读取拒绝矩阵；v187 验证 `invocation-interrupted` 可保留未决 approval 并终止 invocation，L1 跨水位读取保留 transcript，SDK recovery 仍重建为 interrupted；v188 将同一读取与恢复矩阵扩展到水位前未决 tool proposal，清列后 L1 tail 仍可读取且旧列保持空值；v193 将跨水位未决 tool proposal/dispatch 的 interrupted 终态状态扩展到 interrupted 与 cancelled 两种 payload，L1/L2 cache-hit/cache-miss 结果一致；v194 将相同状态矩阵扩展到未决 approval，并验证两种 payload 均保持 L1/L2 一致；v195 明确 SDK recovery 在 cancelled terminal 仍留有 approval/tool 时保留 `interrupted` 状态，避免把未决工作误认为已收敛；v196 覆盖 approval-waiting 位于 L1 watermark 前、resolution 与 completed terminal 位于 tail 的成功路径，并以缓存删除后的 L2 fold 对拍；v197 覆盖同一边界下 approvalId 错配的 resolution，L1 与 L2 均 fail closed；v198 将跨 watermark 的合法 resolution 扩展为 approved/denied/timeout/unavailable/cancelled 五种 outcome，均在 L1 与 L2 一致结算；v199 验证 approvalId 错配及 approved/outcome 矛盾两类 resolution corruption 在 L1/L2 均拒绝；v200 将 denied 终态加入 unresolved approval、tool proposal 与 started dispatch 的跨水位拒绝矩阵；v201 扩展畸形 approval metadata、outcome/bool 冲突和 settledAt 类型错误，并验证 L1 与 cache-miss L2 都 fail closed；v202 覆盖水位前两个并发 approval pending、tail 只结算一个并以 interrupted 结束，另一个未决状态在 L1/L2 中保留；v203 扩展到水位后的成功 tool result 与另一未决 tool 并存，验证 L1/L2 transcript 一致、tool skeleton 状态保留且 canonical-only 正文仍为空。最新实现级完整 suite（v203 生产代码）`npm test -- --reporter=dot`：858 个测试文件通过、1 个跳过，8,048 项通过、106 项跳过；renderer/shared/agent-sdk typecheck、Electron build、i18n/strict i18n 与 `git diff --check` 均通过；strict i18n 仍为 1,154 条测试文件硬编码中文、source 为 0。v203 全量负载性能样本：1200-row search p95 7.66 ms、multi-spill L1/search 13.25/15.08 ms、720-row multi-session cold-L1 8.83 ms。v204 focused 复验四文件 313 项通过（含新成功 `tool-call-finished` 跨水位用例）；v205 红测发现并修复已 dispatch tool 的 `tool-call-finished.success` 与嵌套 `result.success` 矛盾仍能通过 transcript History 校验的问题。现在完整 invocation transition validator 拒绝缺失/非布尔 terminal success，以及嵌套 success 类型错误或与 terminal 不匹配；缺少嵌套 success 的任意输出形态保持合法。v205 focused projection 用例先红后绿；四文件 314 项通过；Electron build 与 diff check 通过。v206 红测发现 approval-resolved 的拒绝/超时/不可用/取消结论虽为 `approved=false`，后续仍可伪造 `tool-call-started`；完整 invocation transition validator 现在要求关联 tool approval 已明确批准，四种非批准 outcome 的 L1/L2、cache-hit/cache-miss 均 fail closed；批准后正常 dispatch/finish 仍由 SDK turn 回归覆盖。v206 聚焦五文件 440 项通过，四 outcome 专项 4 项通过；完整 suite 858 文件通过/1 跳过（8,051 项通过/106 项跳过，281.53 秒），Electron build 与 diff check 通过。全量负载 search p95：1200 rows=7.76 ms、multi-spill L1/search=12.42/12.96 ms、720-row/3-session/60-match cold-L1=8.60 ms；变更仅在 Electron History validator 与测试，renderer/shared/agent-sdk typecheck、i18n 检查最近未重跑（实现级 typecheck 由 Electron build 覆盖）。v167–v168 已覆盖 event/stream session owner 漂移的 cache 即时失效与 L2 拒绝；v169 新增 terminal/context 顺序对调 fail-closed；v170 验收 accepted-turn consumer 遇到 canonical-only History owner 漂移时 fail-closed，不回退为空旧正文；v171 确认 History event owner 更新撤销 API eligibility，保留的 5.4 legacy 正文仍安全回退；v172 修复 readSync 未核验 event owner 导致 coordinator recovery 错认跨 session completed terminal 的缺陷，九文件联合回归 487 项通过；v173 补 Hosted 最近 invocation 的 event owner fail-closed；v174 验证 reopen 后 session cursor 前后漂移均拒绝 stale cache；v175 修复 multi-spill global search p95 偶发越过 20 ms 自动线；v176 修复 owner 损坏枚举抛错导致 coordinator startup recovery 中断的问题，完整 npm suite 858 文件通过/1 跳过（8,012 项通过/106 跳过），Electron build 与 diff check 通过。v178 另核对 §5.8.1：B5 source-truth spill 删除回收已在 v108 实现持久待办、跨进程 root fence、全量严格引用扫描、可续跑孤儿分类、启动/定期维护及错误后重试；这只闭合 source spill 生命周期，不代表 `messages.content` 清理门禁通过。搜索预算已于 2026-10-03 接受 canonical 数据库路径 p95 ≤20 ms，整体响应上限仍为 50 ms（见 [搜索预算评审包](../review/2026-10-03-session-storage-global-search-budget-review.md)）。生产分布性能评审及旧正文回滚/清理 gate 仍未完成，不据此解锁停写/清列。v239 将启动 orphan cleanup 改为只读 `getMessageSkeleton`，不加载消息正文；v240 通过 schema v46 trigger 在 cutover fence 缺失时继续禁止 canonical-backed-only 正文/storage state 改写。v240 聚焦 4 文件 145 项通过；完整 `npm test -- --reporter=dot` 为 858 文件通过/1 跳过、8,107 项通过/106 项跳过；renderer/shared/agent-sdk typecheck、Electron incremental build、i18n 与 strict i18n、`git diff --check` 通过。strict i18n 的 1,154 条中文均在测试文件、源码 0。 v241 的 allocator pending marker 在暖 L1 路径 O(1) 检查，未配对分配转 L2 并 fail closed；配对追加维持 L1 尾部折叠。v241 全量 npm test：858 文件通过/1 跳过，8,108 tests 通过/106 跳过；聚焦 4 文件 191/191 通过；renderer/shared/agent-sdk typecheck、Electron incremental build、i18n/strict i18n 与 diff check 通过。生产分布验证、兼容回滚版本和其他清理门禁仍未完成，停写/清列继续锁定。** |
| 评审记录 | [v1](../review/2026-10-02-session-storage-refactor-technical-design-review.md) · [v2](../review/2026-10-02-session-storage-refactor-technical-design-review-v2.md) · [v3](../review/2026-10-02-session-storage-refactor-technical-design-review-v3.md) · [v4](../review/2026-10-02-session-storage-refactor-technical-design-review-v4.md) · [v5](../review/2026-10-02-session-storage-refactor-technical-design-review-v5.md) · [Phase 5 v31](../review/2026-10-02-session-storage-refactor-phase5-design-review.md) · [Phase 5 v32](../review/2026-10-02-session-storage-refactor-phase5-design-review-v32.md) · [Phase 5 v33 独立复评](../review/2026-10-02-session-storage-refactor-phase5-design-review-v33.md) · [source spill 删除补充评审](../review/2026-10-02-session-storage-refactor-source-spill-delete-review.md) · [Phase 5.0 基线清单](./session-storage-refactor-phase5-baseline.md) |
| 当前门控 | **Phase 0/1/2/3/4 既有实现完成；Phase 5.0–5.4 已通过。5.5 正文读点已接入并有 canonical-only/reopen 回归：transcript/chat、单条/批量/分页、accepted input、重试/turn 恢复、turn 路由与 reuse-user、搜索、retention projection、session capability、自动备份、远程/管家上下文、标题建议、preview 和 raw 读点分类。source-truth spill GC 生命周期已按 v108 完成；这不替代 `messages.content` 清理。此前列出的 History 故障组合已由 v241–v244 覆盖；生产设备分布测量改为发布后观测项，不阻断项目内开发；真实数据清列仍要求兼容回滚发布地板；v224 修复清理批次复用 transcript L1 cache 时未重新校验 source spill 的问题；v225 又修复 L1 清理路径未核验全局 commit cursor 的问题；v226 补齐持久 watermark 账本锚点被改写的拒绝矩阵；v227 修复清理进度游标伪造可跳过未清消息的问题，并验证 cleared prefix；v228 修复 pending 后 source manifest 被篡改时仍可能继续清理的问题，每批均在 canonical History 校验通过后重新计算基线摘要，漂移则以 `fence-changed` 停止；v229 增加 SQLite trigger 固定 pending/complete 清理账本的 generation、revision、canonical watermark 与 source manifest 基线，同时保留游标/计数/错误字段的合法推进；v230 闭合 pending 会话删除：统一 deleteSession 在同一事务撤销清理状态/账本后沿既有整会话删除路径清除 History 和骨架，外键级联删除 cutover/progress，失败则完整回滚；v231 验证已经清空正文的 spill 会话被删除后，source-truth GC 待办与文件跨 DB reopen 持久保留，供回收 worker 后续安全处理；v232 将同一真实文件 SQLite 场景推进到重开后 worker 完成回收，确认待办状态与文件删除一致；v233 将共享 locator 加入该清列/删除/重开链，证明只要另一个 session 仍引用 source spill，GC 就保留待办和文件，最后一个引用删除后才回收；v234 注入终验写入 proof 后的 complete-state CAS 失败，验证 proof 与状态转移在单事务回滚，随后可安全重试成功；v235 验证 complete 会话被用户删除后，清理账本随整会话事务移除，source spill 进入持久 GC 待办，跨重开后才由 worker 回收；v236 补上终验对持久 cursor、已清数量与实际行状态的一致性检查，篡改后不再错误标记 complete；v237 用 schema v45 trigger 固定 complete 清理账本 UPDATE；v238 同时拒绝孤立 progress DELETE，并在整 session 删除时先移除 fence/账本。每批现检查 cursor/已清前缀一致性、全局 cursor 连续性及本 session 全部 source-of-truth spill；write-stopped、pending、有界清理、失败记账、跨 session 隔离与重开验证已在隔离测试库实现和演练，但未接入生产调用；回滚现状见[审计件](../review/2026-10-03-session-storage-rollback-floor-audit.md)。未通过门禁前保留 legacy 双写和正文。** |
| 适用范围 | `electron/database/*`、`electron/sessionEvents.ts`、`electron/runtime/*`、`electron/toolChatLoop.ts`、`packages/agent-sdk/src/history.ts`、`electron/storage/*`、`main.ts` 启动链 |
| 触发问题 | 主库膨胀至 402 MB；启动恢复持续数分钟；窗口迟迟不出 |
| 上游约束 | 不推翻[会话记录事件流持久化重设计方案](./session-record-eventflow-persistence-redesign-plan.md)（已落地）与[消息列表渲染进程性能优化技术方案](./chat-message-list-renderer-performance-optimization-design.md)（已落地） |

## 修订记录

| 版本 | 变更 |
| --- | --- |
| v254 | 修正 retry 临时 fixture 的状态误用：清理 fence 将 `state=terminal` 视为活动状态；改用正式的 `state=failed` 和 `invocation-failed` History terminal 后，隔离 failed turn 可经协议进入 cleanup complete。`0.2.3-arm64` 实际 `chatResolveRetryContext` IPC 在两条 legacy 正文为空时返回 canonical failed assistant 和对应 user 正文，未发送模型请求。终态行完整性/FK 通过；此补上候选包 retry IPC 单项，不代表其余消费者或发布演练完成。 |
| v258 | 固定回滚候选提交 `a17ac8e17e0bb50fe29da079b278c0bcec53adc2`（v0.2.4）在 detached clean checkout 完成 `npm ci`；全量 suite 858 文件通过/1 跳过，8,111 tests 通过/106 跳过；renderer/shared/agent-sdk typecheck、normal/strict i18n 与完整 build 通过。strict i18n 报告的 1,155 条中文均来自测试文件，源码 0。`npm run pack:mac` 生成 x64/arm64 DMG，SHA-256 分别为 `d5a00cdc200cee055406cb9496a4396e08bc57ed6de0af9770fa3d8849efe0fb` 与 `700e398ff9dcac74f7ec9439d4fab29288ca955f2fe9e8b52ae20ae64605e817`；两者 `hdiutil verify` 通过，实际挂载 app 的版本、架构及 deep strict ad-hoc codesign 验证通过。仅本地 ad-hoc 签名、未发布；发布签名策略与功能开发正交。arm64 包使用 `SpaceAssistant-v024-smoke` 隔离 profile 启动，显示原先 live 卡住的 completed `HI` 回复（同一 message ID、340 字符），composer idle；无新模型请求。退出后 SQLite integrity ok、FK check 空、turn/message 仍为 terminal/completed。该 profile 为 legacy-body 且进程重启后检查，不能证明 in-process race 修复或 canonical-only IPC 故障矩阵；同一 v0.2.4 arm64 实包随后用隔离 schema-v46 canonical-only fixture 通过 API context、message page、search corpus 三项读取及 global search；另在独立副本删除 History context event，四项 IPC 全部 fail closed 为 `CANONICAL_SESSION_CONTENT_UNAVAILABLE`，未返回空/部分成功。故障后 integrity ok、FK check 空、legacy body 仍空、cleanup complete。spill 字节损坏、allocator/owner/watermark 矩阵、x64 canonical-only、旧 profile 升级及 C→R→C 技术安装演练仍待完成，M2-6 继续进行中，禁止停写/清列。
| v253 | 固定 `0.2.3` 候选提交 `09b0e624aeeda0d96fc934f1867374692656f2e6`，唯一化之前与已发布 v0.2.2 撞号的包版本；新建该 SHA clean checkout 后重跑 `npm ci`、全量测试（858 文件通过/1 跳过，8,110 项通过/106 项跳过）、类型、i18n、build 和 x64/arm64 DMG。版本化 arm64 实包通过 canonical-only/reopen、IPC 四消费者、cold-L1 重建和损坏 History fail-closed；x64 实包通过 startup 与同四消费者。两产物 `hdiutil verify` 通过，仅 ad-hoc 签名且未正式发布（发布策略不构成功能门禁）；M2-6 继续进行中。 |
| v252 | 固定 SHA `9f9faa1d` clean checkout 的 npm ci、全量 suite（858 文件通过/1 跳过，8,110 项通过/106 跳过）、renderer/shared/agent-sdk typecheck、normal/strict i18n 与 build 通过；pack:mac 生成并校验 x64/arm64 DMG。两架构实际启动 schema-v46 canonical-only profile，API baseline/page/search corpus/global search 读出正文；arm64 cold-L1 重启从 History 重建；损坏 History context 副本的 page/API context/search corpus 实际 IPC fail closed，cleanup/integrity/FK 保持。包版本字段仍与不兼容的已发布 v0.2.2 撞号、无 Developer ID，故仅为本地候选预检；不放行生产清理。 |
| v249 | 复核 R 候选本地预检：6 个聚焦文件 372 项通过；完整 suite 858 文件通过/1 跳过、8,109 项通过/106 项跳过；renderer/shared/agent-sdk typecheck、完整 build、i18n 与 strict i18n 通过，源码硬编码中文 0；清理 API 无真实 profile 生产调用。因 worktree 未提交且非 clean checkout，不记为 R 候选正式验收或发布证据。另修正迁移计划 M2-6…M2-9 与 §8.8.5 R 安装包回滚路线的冲突。 |
| v248 | 在 §8.8.5.C.1 接入正式发布迁移清单，区分上线前演练、首次启动 schema 迁移、上线后补迁与独立清理/回收；纳入迁移计划并注明早期桥接/退役任务的适用边界。仅文档调整，生产清理门禁不变。 |
| v247 | 补充 §8.8.5 兼容回滚版本制作计划：R/C 两次发布、完整代码/格式契约、安装包降级与再升级演练、发布证据及清列放行；明确清理完成态的写围栏和后续恢复写入边界。仅文档补充，回滚版本仍待制作/发布，真实数据停写/清列门禁不变。 |
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
| **v32（Phase 5 设计）** | 按 [Phase 5 预评审](../review/2026-10-02-session-storage-refactor-phase5-design-review.md) B1–B3 定义 `messages` 逐列所有权、外键/计数/顺序不变量、独立 API context 读契约、分阶段影子对拍/逐会话切换/回滚与故障验收。此版仅修改设计，不宣称 Phase 5 实现或测试通过 |
| **v33（Phase 5 重审 B4）** | 按 [v32 重审](../review/2026-10-02-session-storage-refactor-phase5-design-review-v32.md) 补充 turn 准备技能路由及 `reuse-user` 的严格 canonical-backed 读契约：原筛选/排序/非空/LIMIT 语义、影子对拍、清列后回归和失败即阻断。5.5 仍以该门禁通过为前提；本版未实施代码 |
| **v34（source-truth spill 删除回收）** | 按 [补充评审](../review/2026-10-02-session-storage-refactor-source-spill-delete-review.md) B5 为 §5.8 补两阶段会话删除、持久待办、全引用扫描与并发写入 fence、跨重启重试及故障验收。本版仅设计，未声称回收代码或测试完成 |
| **v35（Phase 5.0 基线与 oracle TDD）** | 新增 `messages` 15 列/外键与正文消费者基线清单；为路由窗口、boundary/exclude、turn 锚点、正文原字节、vision 附件及 `reuse-user` 到 skill route 的实际入参补 oracle。数据库操作、prepare-turn IPC、accepted context 聚焦回归 113 项通过。消费者清单与全量旧路径基线仍在核查，本版不放行 5.1 |
| **v36（Phase 5.1 additive schema）** | v37→v38 原子迁移新增 API 独立 eligibility/fence、会话级读写/回收状态、每消息 `content_storage_state`；现有消息默认 `legacy` 且正文原样保留；消息和 generation 直接 SQL 变更同时提升骨架 revision、把 canonical 读模式置为 `revalidation-required` 并撤销展示/API eligibility。迁移升级、触发器失效（含事务回滚）、generation、幂等重跑、中断回滚/重试、真实空正文与 FK 级联 5 文件 63 项通过；全量 855 文件通过、1 跳过（7,792 项通过、106 跳过），renderer/shared/agent-sdk typecheck、Electron build、i18n 均通过。5.1 门禁通过 |
| **v37（Phase 5.2 双写与影子双读）** | 5.0/5.1 门禁通过后开始；旧 API context、route/reuse-user 仍为用户路径，新增 canonical candidate 旁路逐字段对拍与仅含 session/字段/hash 的诊断结果。保留完整 legacy 正文，不授予 cutover 资格 |
| **v38（Phase 5.2 只读 shadow 修正）** | shadow 使用不授予资格的 canonical-only L2 fold，独立于 legacy 正文产生候选，因此能实际报告正文差异；缓存仅读、不顺手刷新；无 canonical transcript 的旧会话保持 unavailable。聚焦 shadow/History/projection/IPC/context 183 项通过。**5.2 未通过**：消息正文与 canonical History 尚未按原提交协议原子双写，pending/streaming/legacy 混合状态、spill 故障矩阵及性能门禁也未验收 |
| **v39（Phase 5.2 terminal mirror）** | terminal `SessionTranscriptCommitIntent` 可携 assistant message ID、完成正文与终态；SQLite History adapter 在既有 terminal History/transcript receipt/checkpoint/execution fence 事务中同步更新同 session assistant 骨架。镜像目标缺失或 transcript receipt 失败均回滚 History/transcript/fence/消息镜像。SDK/History/hosted handoff 聚焦 306 项通过；全量 856 文件通过、1 跳过（7,798 项通过、106 项跳过），Electron build、renderer/shared/agent-sdk typecheck、i18n 与 diff check 通过。**5.2 仍未通过**：streaming/pending/legacy 混合认证、source spill/cache 故障矩阵和性能门禁未完成 |
| **v40（Phase 5.2 participant 故障围栏）** | red 测试发现 transcript/message mirror 提交失败后，SDK 的 terminal-only fallback 会仅凭 terminal event 已存在就当作成功；现在有 transcript participant 时不以 terminal event 单独确认成功。Hosted handoff 对已存在 completed terminal 但 participant 未完成的情况写 `commit_uncertain`、保留 claim 并要求 reconcile；受影响 desktop/remote/butler/approval/SDK 回归 468 项通过。最终全量 856 文件通过、1 跳过（7,799 项通过、106 项跳过），Electron build、renderer/shared/agent-sdk typecheck、i18n 与 diff check 通过。**5.2 仍未通过**：streaming/pending/legacy 混合认证、source spill/cache 故障矩阵和性能门禁未完成 |
| **v41（Phase 5.2 mixed-state 与故障/性能测量）** | canonical+legacy sent、queued、streaming、非 terminal turn 下 failed assistant 混合会话中，API/route shadow 对缺失 canonical 身份 fail closed；用户侧 `getTurnContext` 与 route 输出前后逐项一致，资格表为空、所有 storage state 保持 legacy。真实文件数据库注入 source spill 缺失/篡改及 projection cache 表故障，shadow 均不可用且 legacy 结果不变。性能样本：Node 26.4.0、测试机当前环境、内存 SQLite、同会话 1,200 消息、5 轮预热后 30 组配对；nearest-rank p95 legacy 4.02 ms、shadow candidate 5.59 ms，低于 `legacy ×2 + 5 ms` 且低于 50 ms。新增 shadow 聚焦 7 项及数据库/IPC/History 联合 248 项通过。**5.2 仍未通过**：canonical 新写消息与普通 append/streaming checkpoint 尚未形成完整双写；待补 spill 准备失败、cache 清空重建/跨重启和封口身份矩阵 |
| **v42（Phase 5.2 稳定 ID response 原子镜像）** | `SqliteAgentHistory.appendBatch` 对带稳定 assistant ID 的 `model-response-committed`，从字符串正文或 canonical text/thinking/image blocks 投影文本，在同一 SQLite 事务内镜像到匹配的 streaming `messages` 行；该行仍保持 streaming，thinking 仍由原 skeleton 字段承载，未触碰 queued/已封口行。镜像 UPDATE 故障会回滚 canonical History event，History 测试 115 项通过。该步骤只覆盖已提交的 assistant response，不代表每次普通 checkpoint 都已 canonical 双写；**5.2 仍未通过**，完整会话/API/路由对拍、mixed-state、spill/cache、性能和生命周期原子性门禁仍需逐项满足 |
| **v43（Phase 5.2 required-user base context 原子镜像）** | `invocation-context-committed` 若带稳定 ID 的 `requiredUserMessage`，在同一 History batch 事务内将可映射的 user 文本镜像到同 session 已发送用户行；图片 block 保留在 canonical，而骨架附件字段不变。目标不存在、不是 sent user 或 UPDATE 故障均回滚 canonical event。含 History/toolChatLoop/hosted handoff 联合 183 项通过，Electron 增量构建与 diff check 通过。queued append 仍保持 legacy；streaming checkpoint 仍是 legacy 中间态，响应提交和 terminal 提交分别有 History 同事务镜像。**5.2 仍未通过**，全部字段映射及其余双写/影子对拍/故障/性能门禁待完成 |
| **v44（Phase 5.2 queued/streaming legacy 围栏）** | 实际 queued enqueue 集成断言确认新 queued row 保留完整正文且 `content_storage_state=legacy`；streaming `checkpointTurnAtomically` 的真实更新用例确认正文仍完整、状态不变、storage state 保持 legacy，并由消息 mutation trigger 同事务撤销 projection/API eligibility、将 API read mode 降至 `revalidation-required`。数据库聚焦两项通过；同轮 shadow 性能复测 nearest-rank p95 legacy 4.40 ms、candidate 7.25 ms（30 组配对，低于双倍 + 5 ms 与 50 ms 限制）。证明普通中间态更新不会沿用旧 canonical 资格；**5.2 仍未通过**，完整 fold/字段矩阵、canonical 与响应/终态投影映射、spill/cache 失败和性能门禁仍待完成 |
| **v45（Phase 5.2 source spill 准备失败保全）** | 注入 `commitSourceTruth` 准备失败且 assistant canonical 正文大于 64 KiB，History 仍将完整正文 inline 写入 canonical event，并在同一事务镜像到 streaming legacy 行；正文无占位/截断，storage state 仍为 legacy。operations/History/shadow 聚焦 188 项通过，Electron 增量构建与 diff check 通过；本轮 30 组配对性能 p95 legacy 3.72 ms、candidate 5.78 ms，低于双倍 + 5 ms 与 50 ms 门槛。**5.2 仍未通过**，cache clear/rebuild 与 reopen、canonical 封口身份和其余双写/字段门禁仍待验收 |
| **v46（Phase 5.2 stable message ID 与 turn 归属核验）** | 新增跨 turn 冲突红测，发现 terminal assistant 镜像此前只校验 session/role，可能覆写同 session 的另一 turn 行；现在 terminal mirror 必须匹配 `turns.assistant_message_id` 和 terminal `turnId`，否则整个 History/transcript/checkpoint/fence/消息事务回滚。`model-response-committed` 对已存在的 streaming skeleton 同样核对所属 turn，并要求镜像恰好命中一行；无 skeleton 的纯 canonical fold 不触发 legacy 镜像。对应跨 turn response/terminal、合法成功、失败回滚与历史无 skeleton 的回归共 248 项通过，Electron 增量构建与 diff check 通过。**5.2 仍未通过**，还需真实 Hosted 生命周期、封口 outcome 矩阵、缓存/重启与完整字段/路由/API 门禁 |
| **v47（Phase 5.2 terminal outcome/status 矩阵）** | 红测发现 completed History 可与 failed message status 一同提交；现在限制 completed↔completed、failed↔failed/timed_out、interrupted↔cancelled/interrupted，并校验 message mirror 状态必须对应 transcript outcome（timed_out/interrupted 投影为 failed）。不一致时终态 History、receipt、transcript checkpoint、execution fence 与消息均回滚。合法 failed/timed_out/cancelled/interrupted 四种配对及 mismatch 回滚覆盖；History/Hosted handoff/toolChatLoop/DB 聚焦 253 项通过，Electron 增量构建和 diff check 通过。仍待 SDK 实际错误/取消路径与 adapter outcome 矩阵联合验收；**5.2 未通过** |
| **v48（Phase 5.2 SDK/Hosted 终态映射与失败正文镜像）** | 实际 `runAgentTurn` provider failure 暴露 failure transcript 中 assistant canonical block 数组不会生成 `messageMirror.content`；现在从 text/thinking/image blocks 只提取文本，thinking 不写入 `messages.content`。SDK 实际 failed、timed_out Hosted、cancelled、critical response projection interrupted 测试确认生成对应 transcript outcome/message status；SQLite History 真实 failed turn 测试确认 History terminal、完整 canonical transcript、正文镜像、receipt/checkpoint 与 `transcript_committed` execution claim 同事务一致。SDK/SQLite History/Hosted handoff/toolChatLoop/database 5 文件 376 项通过，agent-sdk typecheck、Electron 增量构建与 diff check 通过。**5.2 仍未通过**：其它完整字段、全量 fold/shadow 逐字段零差异、性能及剩余 spill/cache/reopen 故障矩阵尚待验收 |
| **v49（Phase 5.2 source-truth spill 跨重启 shadow 故障围栏）** | 扩展真实文件 SQLite 测试：canonical 正文大于 64 KiB 并写入 source-truth spill，DB close/reopen 后 API shadow 仍逐字段匹配；篡改 spill 字节时，即使持久 cache 命中也 fail closed；恢复原字节、清除 cache 后 L2 重折叠及 L1 seed 重建仍匹配，再次篡改时 L1 同样 fail closed。shadow/SQLite History/Hosted handoff/database 4 文件 237 项通过；30 组配对 p95 legacy 3.83 ms、candidate 5.77 ms，满足 `legacy ×2 + 5 ms` 与 50 ms 门槛。**5.2 仍未通过**：完整 canonical 新写入协议、字段/API/route 零差异矩阵及全部提交故障原子性门禁尚待逐项完成；不进入 5.3 |
| **v50（Phase 5.2 required-user/context 一致性）** | 红测发现 `invocation-context-committed.payload.messages` 与 `requiredUserMessage` 可使用同一 ID 却提交不同正文；文本冲突、unsupported block 导致投影不确定、同文本但图片数据不同及 context 内重复 ID 均曾放行。现在 SQLite History adapter 要求 required user ID 在 context 中恰好对应一条 user 消息、完整 canonical content 结构稳定序列化后一致，且双方都可安全投影；正文镜像仍只写 text，图片与附件元数据保持既有所有权。拒绝时 canonical event 与消息镜像同事务回滚。History/Hosted handoff/toolChatLoop/database 4 文件 258 项通过，Electron 增量构建及 diff check 通过。**5.2 仍未通过**：完整 canonical 写入协议、全字段 API/route 零差异及全部提交故障门禁未齐，不进入 5.3 |
| **v51（Phase 5.2 required-user 投影资格与原子双写闭合）** | 红测发现 user required-message 同时包含 text 与 unsupported thinking block 时，共用 assistant projector 可判定文本一致，但 user mirror 的 text/image projector 不写入消息正文，导致 History 成功而旧正文保持陈旧。现以 user 专用 projector（仅 string 或 text/image block）同时校验 context/required message 并生成镜像正文；无法映射即同事务拒绝，避免“canonical 已提交、legacy mirror 未写”的半双写状态。生产 `toCanonicalModelMessages` 对 user 仅支持 text/image，故拒绝与实际边界一致。History/Hosted handoff/toolChatLoop/database 4 文件 259 项通过，Electron 增量构建与 diff check 通过。**5.2 仍未通过**：完整 canonical 写入协议、全字段 API/route 零差异及全部提交故障门禁未齐，不进入 5.3 |
| **v52（Phase 5.2 required-user 大正文 spill 准备失败保全）** | 注入 source-truth spill 准备失败，验证 >64 KiB `invocation-context-committed` user 正文完整保留 inline；`payload.messages` 与 `requiredUserMessage` 均未截断/替换为 locator，sent user legacy mirror 同事务写入同一正文且 `content_storage_state=legacy`。History/Hosted handoff/toolChatLoop/database 4 文件 260 项通过；agent-sdk typecheck、Electron 增量构建、diff check 通过。**5.2 仍未通过**：其余完整双写、逐字段 API/route 对拍和提交故障矩阵继续按序推进，不进入 5.3 |
| **v53（Phase 5.2 spill 后镜像失败回滚与 orphan 回收）** | 使用真实文件 SQLite/source spill：>64 KiB user context spill 已成功落盘后，注入 legacy required-user mirror SQL trigger 失败。History event、session cursor 与消息更新全部回滚；随后扫描 `agent_history_events` + `session_transcript_entries` 全部 canonical 引用，确认该 spill 无引用并只回收该 orphan。History/spillStore/Hosted handoff/toolChatLoop/database 5 文件 285 项通过；agent-sdk typecheck、Electron 增量构建、diff check 通过。**5.2 仍未通过**：assistant/terminal 及其他 participant 的完整 spill/事务故障矩阵、API/route 全字段对拍和完整双写路径仍待验收，不进入 5.3 |
| **v54（Phase 5.2 非法 required-user 身份 fail-closed）** | 红测发现显式提供但 role 错误/结构非法的 `requiredUserMessage` 会被静默跳过镜像并照常提交 canonical context。现在仅在字段完全缺失时允许无 required-user 镜像；字段存在则必须通过结构、role、唯一 ID 和完整 content 投影一致性验证，否则 History event/cursor/message 全事务回滚。required-user 聚焦 8 项，History/spillStore/Hosted handoff/toolChatLoop/database 5 文件 286 项通过；agent-sdk typecheck、Electron 增量构建、diff check 通过。**5.2 仍未通过**：其余 participant 故障矩阵及完整 API/route 双读门禁继续待验收，不进入 5.3 |
| **v55（Phase 5.2 assistant response/terminal spill 与 mirror 故障原子矩阵）** | 真实文件 SQLite/source spill 验证两条组合故障：assistant response spill 成功后 streaming mirror SQL 失败，History event/cursor/message 回滚且 orphan 被全引用扫描回收；terminal output 与 transcript snapshot 两份 spill 成功后 message mirror 失败，terminal event、transcript entry、receipt、execution claim/queue、cursor 和消息均回滚，两份 orphan 均被回收。History/spillStore/Hosted handoff/toolChatLoop/database 5 文件 288 项通过；agent-sdk typecheck、Electron 增量构建与 diff check 通过。**5.2 仍未通过**：完整 canonical 双写覆盖、API/route 逐字段零差异和剩余混合态/生命周期门禁仍未齐，不进入 5.3 |
| **v56（Phase 5.2 shadow/History 复验与 Hosted dispatch 阻塞复查）** | 复跑 `electron/runtime/sessionStorageShadow.test.ts` 与 `electron/runtime/sqliteAgentHistory.test.ts`：2 文件 145 项通过；包含 source spill 缺失/篡改、cache 清空 + DB reopen 重建 L1，30 组配对 p95 legacy 3.68 ms、candidate 5.63 ms。Approval Hosted mock 在 required-user 完整相等校验处失败；具体为 request message 带 stable ID，而 `requiredUserMessage.message` 漏掉同一 ID。 |
| **v57（Phase 5.2 全量 CI 复验与 Hosted fixture 身份修复）** | 测试夹具为 request 与 required-user message 补齐同一 stable ID，保留 SDK 的严格完整消息相等检查。Approval Agent 43/43 通过；`npm test` 全量 856 文件通过、1 跳过（7,831 项通过、106 跳过）；renderer/shared/agent-sdk typecheck、Electron build、i18n、diff check 全通过。5.2 仍未通过：还须按 §8.8.3/§8.8.4 完成逐 session 全部读点/新写入覆盖对拍及故障门禁审计，不进入 5.3 |
| **v58（Phase 5.2 accepted-user canonical 指纹影子对拍）** | 红测确认 canonical accepted-user 正文漂移时 shadow 只报告 `content` 差异，无法显式证明接受时的 `queueInputFingerprint` 仍一致。现 `loadAcceptedTurnMessages` 先执行原 legacy accepted-user 身份/指纹校验，再把 message ID 与已接受指纹交给只读 shadow；shadow 对 canonical 候选独立重算指纹并报告 `matched/mismatched/unavailable`，不影响旧路径。日志仅白名单保留枚举状态，不记录正文或指纹。accepted context、shadow 与日志投影 3 文件 17 项通过；最新 shadow p95 30 组配对为 legacy 3.97 ms、candidate 6.03 ms，满足 `legacy ×2 + 5 ms` 和 50 ms 限制；Electron build、renderer/shared/agent-sdk typecheck、i18n 与 diff check 通过。5.2 仍未通过：这里只补 accepted-input 一项证据；完整读点/新写入覆盖、故障矩阵与零差异门禁仍须审计，不进入 5.3 |
| **v59（Phase 5.2 accepted-input 指纹状态安全日志）** | TDD 发现 shadow report 已计算 accepted-input 指纹比较状态，日志 schema 也允许该枚举字段，但 `emitReport` 未传入持久诊断。现日志携带 `matched/mismatched/unavailable` 状态，不输出原指纹或正文。日志缺失用例先红后绿；accepted context/shadow/log projection 3 文件 17 项通过，性能配对 30 组 p95 legacy 3.70 ms、candidate 5.66 ms；Electron build、renderer/shared/agent-sdk typecheck 与 `git diff --check` 通过。5.2 仍未通过：其它双写覆盖及退出门禁不因诊断字段补齐而放行 |
| **v60（Phase 5.2 canonical 缺失时 accepted-input unavailable 诊断）** | 红测发现 canonical 全会话身份/正文不可用时，shadow 返回 `unavailable`，但遗漏 accepted-input 比较状态；现此路径明确记录 `unavailable`，不会将“无法计算”误报为匹配或差异。相关测试先红后绿；3 文件 17 项、30 组配对 p95 legacy 3.81 ms、candidate 5.85 ms，Electron build、renderer/shared/agent-sdk typecheck、i18n 与 diff check 通过。该诊断修正不改变 5.2 尚未通过及禁止进入 5.3 的状态 |
| **v61（Phase 5.2 完整技能路由入参 shadow 接线验收）** | 发现 route shadow 单测此前使用缩减对象，IPC reuse-user 集成只注入 shadow 异常而未证明 shadow 收到实际 `skillManager.route` 入参。现在 shadow 候选覆盖 session state、metadata、model/base URL、API-key callback、abort signal 与 recent messages；IPC 断言 shadow 输入对象与实际 route 调用对象为同一对象。4 个相关文件 58 项通过，30 组配对 p95 legacy 3.74 ms、candidate 5.65 ms。该接线证据通过不替代 5.2 其它零差异、原子双写与故障门槛 |
| **v62（Phase 5.2 reuse-user 路由 spill/cache/reopen 对拍）** | 将真实文件 SQLite 大正文 source spill 生命周期测试扩展至 turn-routing/reuse-user：关闭并重开数据库后、篡改 spill、清缓存触发 L2 重折叠、重建 L1 后均与 legacy 路由窗口逐项对拍；spill 篡改及重建缓存后的篡改均 fail closed。与 API 同生命周期矩阵共享 fixture。4 文件 58 项通过，30 组配对 p95 legacy 3.87 ms、candidate 5.67 ms；本项只闭合 reuse-user 路由的重启/缓存样本，不代表 5.2 退出门槛全部满足 |
| **v63（Phase 5.2 assistant response 无损镜像输入 fail closed）** | 红测发现 `model-response-committed` 缺少 message 时 adapter 静默跳过；有 message 正文但正文块不能精确映射 `messages.content` 时也会提交 canonical event 而不镜像。现缺失 payload/message/assistant role 拒绝提交；显式正文无法投影时抛 `HistoryBatchError`，History event 与 legacy 行在同一事务回滚，tool-call-only 的合法 undefined 正文仍可通过。聚焦 SQLite History 139 项通过；全量 npm test 856 文件通过、1 跳过（7,836 通过、106 跳过），Electron build、renderer/shared/agent-sdk typecheck、i18n 与 diff check 通过。性能同轮 p95 legacy 4.01 ms、candidate 5.81 ms；5.2 仍未通过，待剩余新写路径与故障矩阵零差异审计 |
| **v64（Phase 5.2 终态 mirror 约束复验）** | 复核 terminal commit 的 assistant ID/turn 归属及 event/outcome/status 校验，并运行错误注入矩阵。尝试新增“规范 transcript assistant 文本投影必须等于 terminal mirror.content”的数据库断言时，真实 Hosted/Butler 集成证明该不变量不成立：completed mirror 是整个回合累积 `result.text`，可跨多次 response；失败 transcript 可来自 failure snapshot，未必存在本次 response event。过严断言导致全量 60 项失败，已撤回该断言及其测试，没有保留不兼容行为。最终 SQLite History 139 项通过；全量 npm test 856 文件通过、1 跳过（7,836 通过、106 跳过）；Electron build、renderer/shared/agent-sdk typecheck、i18n、diff check 通过，shadow 配对 p95 legacy 3.87 ms、candidate 5.78 ms。5.2 仍未通过；终态原子性以 turn identity/status 与单事务提交为现有门槛，不将尚无可靠生成边界的 content 再推导规则作为完成条件 |
| **v65（Phase 5.2 turn-owned assistant response mirror fail closed）** | 红测发现：`model-response-committed` 带 stable assistant ID 时，adapter 只查询 `status='streaming'` 的消息；若该 turn 的骨架已变成 completed/queued 等状态，查询表现为“没有镜像目标”，却静默提交 canonical event。现对具有持久化 turn owner 的显式 assistant ID，必须存在同 session/role assistant 且状态为 streaming 的目标，否则抛 `HistoryBatchError` 并回滚整个 append；turn 的 assistant ID 仍须匹配。没有持久化 `turns` owner 的 canonical-only fold/replay 用例保持允许，不要求构造 legacy UI 骨架。TDD 先红后绿；SQLite History 140 项通过；全量 npm test 856 文件通过、1 跳过（7,837 通过、106 跳过）；Electron build、renderer/shared/agent-sdk typecheck、i18n 与 diff check 通过。5.2 仍未通过：完整写路径/字段对拍和剩余故障矩阵继续按下一项审计 |
| **v66（Phase 5.2 malformed canonical invocation context fail closed）** | 红测证明 session-bound History 对 null/缺失/非数组 `messages`、非对象消息、未知 role、不支持的内容块和无 proposal 的 tool result 都会成功提交。现写入事务校验 canonical message 结构及 user/assistant/system 内容、tool-call 字段和 tool result 引用；合法 assistant-only pending proposal 仍可提交。真实大正文 source spill 用例改为合法消息输入后验证重启/恢复遇缺失 source spill fail closed。SQLite History 148 项通过；全量复验结果在 v67 独立记录。 |
| **v67（Phase 5.2 全量复验）** | 修正 spill locator 测试 fixture，使 invocation-context 携带合法 `messages: []` canonical snapshot 并继续覆盖提交成功、事务失败、ack 丢失、orphan 回收及 retention；spillStore 24 项、SQLite History 148 项通过。最终 `npm test -- --reporter=dot`：856 个文件通过、1 个跳过（7,845 项通过、106 项跳过）；30 组 shadow 配对 p95 legacy 3.89 ms、candidate 5.83 ms。`npm run build:electron`、renderer/shared/agent-sdk typecheck、`npm run i18n:check` 和 `git diff --check` 全部通过。此结果补强当前实现回归证据，但 5.2 的完整字段/API/路由零差异、资格围栏与剩余故障矩阵仍未全部审计，禁止进入 5.3 |
| **v68（Phase 5.2 queued enqueue eligibility 撤销）** | 新增真实 `enqueueQueuedUserMessage` 数据库断言：先为已有 session 置 canonical/dual-write 并写入 projection 与 API-context 两类资格，再执行 queued enqueue。新行保留完整正文且 `status='queued'`、`content_storage_state='legacy'`；insert trigger 同事务删除两类 eligibility，并将 `api_read_mode` 降为 `revalidation-required`，未授予 queued 中间态资格。operations 聚焦 63 项通过。与既有 streaming checkpoint 撤销资格测试合并后补足两类真实中间态证据；其余 5.2 零差异和原子故障门禁仍未过，禁止进入 5.3 |
| **v69（Phase 5.2 transcript-compacted snapshot fail closed）** | 红测发现 session-bound `SqliteAgentHistory` 会接受 `transcript-compacted` 中未知内容 block 并提交，但 fold 将该事件作为完整 transcript 替换快照，后续重建才会失败。现 `invocation-context-committed` 与 `transcript-compacted` 共用写侧 message 结构/tool-call 引用校验；不支持快照 fail closed，合法 pending tool proposal 语义仍保留。SQLite History 149 项、canonicalHistory 与 sessionTranscriptProjection 33 项通过；全量 `npm test -- --reporter=dot` 为 856 个文件通过、1 个跳过（7,847 项通过、106 项跳过）；30 组配对 shadow p95 legacy 3.96 ms、candidate 5.69 ms；Electron build、renderer/shared/agent-sdk typecheck、i18n 与 `git diff --check` 均通过。5.2 其它门禁未全部通过，禁止进入 5.3 |
| **v70（Phase 5.2 replay-message fail closed 与全量复验）** | 红测发现 session-bound History 会接受带未知 block 的 `replay-message-committed` 并提交，而 fold 只允许 user replay 且后续才判定内容无效。现 append 事务只接受结构完整的 user replay，并拒绝 assistant replay/未知内容 block。SQLite History、canonicalHistory、sessionTranscriptProjection 联合 183 项通过；全量 `npm test -- --reporter=dot`：856 个文件通过、1 个跳过（7,848 项通过、106 项跳过）；30 组 shadow 配对 p95 legacy 3.97 ms、candidate 5.64 ms；Electron build、renderer/shared/agent-sdk typecheck、i18n 与 `git diff --check` 全通过。5.2 的完整字段/API/路由零差异与剩余故障门禁未完成，禁止进入 5.3 |
| **v71（Phase 5.2 显式 assistant ID 身份绑定与 Remote 合法无 ID response）** | 对 response 先按真实 Hosted/Remote 样本审查后确认：没有 `message.id` 的 canonical model response（包括持久化 turn 中的无 skeleton response）属于合法路径，先前尝试强制 ID 导致 18 项全量失败，已撤回。最终只对显式 ID 做 turn/session/skeleton 绑定；tool-call-only 即使正文为空也不能跳过绑定，turn-owned 有 ID 时目标必须为 streaming。无 ID response 保持 canonical-only 写入。SQLite History + Hosted SDK/IPC + Remote 联合 437 项通过；全量 `npm test -- --reporter=dot`：856 文件通过、1 跳过（7,850 项通过、106 项跳过）；30 组 shadow p95 legacy 3.97 ms、candidate 5.69 ms；Electron build、renderer/shared/agent-sdk typecheck、i18n 与 diff check 全通过。5.2 其余零差异门槛尚未通过 |
| **v72（Phase 5.2 canonical stable ID 非空校验）** | 红测发现通用 canonical message 校验将 `id: ''` 当作合法字符串，session-bound replay 因而可以提交不可稳定引用的消息。现 `validateCanonicalInvocationMessages` 对 ID 要求非空白；覆盖 invocation context、compaction snapshot、replay message 与 assistant response 的共用校验入口。SQLite History 定向身份/结构 12 项通过，完整 SQLite History + canonicalHistory 179 项通过。shadow 并行运行时性能样本偶发略过门槛（legacy 3.84 ms、candidate 12.70 ms，门槛 12.67 ms）；独立重复基准通过（3.93 ms / 5.61 ms），全量测试中的 30 组样本也通过（3.82 ms / 5.63 ms）。最终 `npm test -- --reporter=dot`：856 文件通过、1 个跳过（7,851 项通过、106 项跳过）；Electron build、renderer/shared/agent-sdk typecheck、i18n 与 `git diff --check` 全通过。5.2 零差异退出门槛仍未通过 |
| **v73（Phase 5.2 shadow 差异比较覆盖实际字段全集）** | 红测证明 API `Message[]` 新增 `activity` 等字段若不在手写白名单内，数组实际不相等时差异报告仍可能返回空字段并标记 matched；路由输入也有相同白名单遗漏风险。现差异比较按对象双方 enumerable key 并集逐字段比较，并逐消息比较数组字段，不依赖人工维护字段清单；新增未知/未来字段回归。`sessionStorageShadow.test.ts` 9 项通过，30 组配对 shadow p95 legacy 3.95 ms、candidate 5.94 ms。全量 `npm test -- --reporter=dot`：856 文件通过、1 个跳过（7,852 项通过、106 项跳过）；Electron build、renderer/shared/agent-sdk typecheck、i18n 与 `git diff --check` 全通过。5.2 零差异退出门槛仍未通过 |
| **v74（Phase 5.2 stable-ID provider base context 正文双写及 terminal guard）** | 红测发现 `invocation-context-committed.payload.messages` 对既有 stable-ID user/assistant 骨架只镜像 `requiredUserMessage`，普通 provider context 内的稳定身份正文仍可能与 `messages.content` 分叉。现对同 session/同 role 的 user `sent` 与 assistant terminal 状态行原子镜像可精确 text 投影；queued/streaming 或 turn owner 未终态时保留原正文与状态并跳过 mirror；身份冲突/不支持投影 fail closed。镜像 UPDATE 注入故障证明多条旧正文和 History event 同事务回滚。Hosted standalone 无 `messages` 表与 canonical-only 无骨架维持可用。最终 `npm test -- --reporter=dot`：856 文件通过、1 个跳过（7,856 项通过、106 项跳过）；30 组 shadow p95 legacy 3.97 ms、candidate 5.78 ms；Electron build、renderer/shared/agent-sdk typecheck、i18n 与 `git diff --check` 全通过。5.2 其它写路径/完整字段零差异及完整故障矩阵仍未全部审计 |
| **v75（Phase 5.2 continuation/retry context 镜像与 checkpoint 一致性）** | 红测发现 `createOrGetAgentContinuation` 的新建与显式 retry 分支直接调用 SQLite History writer，绕过普通 `SqliteAgentHistory` 的 legacy 正文镜像；同时 checkpoint 只确认 required-user ID 出现在折叠 transcript，未证明消息内容相同。现两条 continuation 写路径都在其外层事务内镜像 stable-ID context 正文；required-user 与 transcript 的 canonical 身份/完整内容不一致时拒绝续跑；retry 镜像 SQL 故障测试证明 retry 身份、History 与正文一起回滚。continuation/SQLite History/toolChatLoop 联合 200 项通过；shared typecheck、Electron 增量构建及 diff check 通过。5.2 其他写路径、全字段零差异与完整故障矩阵仍未完成，不进入 5.3 |
| **v76（Phase 5.2 context mirror 重复 stable-ID fail closed 与性能门禁澄清）** | 红测发现 context 中重复 stable message ID 会对同一骨架顺序覆盖正文，或以不同 role 冲突；现 mirror 在更新前拒绝重复 ID，并对 session/role 冲突统一 fail closed。缺少 ID 且无可映射骨架的 canonical-only 消息仍可提交。continuation/SQLite History/toolChatLoop/shadow 联合 210 项通过；30 组观测 p95 legacy 3.97 ms、shadow 5.68 ms，低于既有影子流程限值。审计确认该 candidate 包含 shadow 读取/校验流程，不能证明未来 canonical API selector+按 ID 读取的 p95，故不作为 API cutover 性能门禁通过证据；该真实候选配对基准仍待实现。Electron 增量构建和 diff check 通过。5.2 其他逐字段零差异及完整新写路径/故障矩阵未完成，不进入 5.3 |
| **v77（Phase 5.2 同快照 canonical API candidate 与真实读取性能对拍）** | 新增未来 API 读取候选：与 `getTurnContext` 共用同一骨架选择器，按需查询不含 `messages.content` 的骨架列；在同一 SQLite 事务快照内折叠/校验 canonical 全会话 transcript，再只按已选 stable ID 解析正文，legacy codec 负责 status/attachments/tool/skill 等其它字段。新增 required-user 边界/排除错误、turn anchor/终态筛选、元数据保留、accepted-input fingerprint 与 1200 消息配对性能回归。10 次预热 + 30 组，nearest-rank p95 legacy 3.65 ms、candidate 5.73 ms，低于 `legacy ×2 + 5 ms` 及 50 ms。Shadow 同轮 p95 3.89/5.79 ms，仅作旁路观察。`npm test -- --reporter=dot`：856 文件通过、1 个跳过（7,862 项通过、106 项跳过）；Electron build、renderer/shared/agent-sdk typecheck、i18n 与 `git diff --check` 通过。候选尚未接入用户路径；5.2 仍需完整零差异样本、新写入及故障矩阵和资格围栏验收，不进入 5.3 |
| **v78（Phase 5.2 mirror 中途失效回滚与 inline spill API 对拍）** | 新增 History batch 组合故障：canonical context 已插入、legacy 正文已镜像且 UPDATE trigger 已撤销 API eligibility 后，后续 History event 写失败；验证事务回滚恢复原 legacy 正文、原 message revision 与 API eligibility，canonical event 不残留。另注入 source spill 准备失败，确认大 required-user 正文 inline 写入 canonical History 后，same-snapshot API candidate 与 `getTurnContext` 的完整 `Message[]` 相等且附件元数据保留。History + shadow 聚焦联合 171 项通过；候选读取 p95 legacy 3.91 ms、candidate 5.68 ms（30 组），shadow p95 3.89/6.22 ms。`git diff --check` 通过。5.2 完整字段/所有合格样本零差异、未覆盖写路径与剩余故障矩阵仍未完成；不进入 5.3 |
| **v79（Phase 5.2 attachment mutation 直接 SQL 资格失效验收）** | 在 v38 migration mutation 测试中新增直接 SQL 更新 `messages.attachments`：验证 skeleton revision 推进，API context 与展示 projection eligibility 同时删除，`api_read_mode` 降为 `revalidation-required`。fence 聚焦测试通过。此项补足附件改动对资格撤销的显式证据；完整 5.2 双写/逐字段零差异与故障矩阵仍未完成，不进入 5.3 |
| **v80（Phase 5.2 legacy 正文编辑与 canonical/fingerprint 差异验收）** | 对已写入 canonical context 的 user 消息执行实际 `updateMessageContent` 编辑；legacy API 继续返回新正文，shadow 对 canonical 旧正文报告 `content` 与 `accepted-input-fingerprint` 双差异，且 API eligibility 为空。聚焦回归通过。该用例证明普通编辑不会静默接受陈旧 canonical 正文；5.2 总体零差异/全部新写路径与故障矩阵仍未通过，不进入 5.3 |
| **v81（Phase 5.2 sequence gap selector 对拍）** | 在 canonical API candidate 骨架筛选用例中插入后删除中间消息，形成合法 sequence 空洞；same-snapshot candidate 与 legacy `getTurnContext` 的完整消息顺序和字段继续相等，既有 boundary、required-user、turn anchor、terminal/open turn 及 exclude 断言同时通过。定向测试通过；5.2 总体 gate 仍未通过，不进入 5.3 |
| **v82（Phase 5.2 startup cleanup 直接 SQL fence 验收）** | 为 `cleanupStreamingResiduesOnStartup` 增加 cutover fence 集成用例：无 turn owner 的 streaming assistant 被 startup direct SQL 收敛为 failed 并降级 tool call 后，legacy 正文保留，API context 与展示 projection eligibility 均撤销，`api_read_mode` 变为 `revalidation-required`。`streamingCleanup.test.ts` 4 项通过。此处仅证明恢复写路径不会沿用旧资格；5.2 总体 gate 仍未通过，不进入 5.3 |
| **v83（Phase 5.2 recoverPersistedTurn 资格撤销验收）** | 对已授予两类 eligibility 的 queued turn 执行真实 `recoverPersistedTurn`：assistant legacy partial body 保留，消息状态变为 failed，turn 与 queue receipt 收敛为 recovered；API context 与展示 projection eligibility 删除，读模式进入 `revalidation-required`。定向 operations 用例通过。恢复路径的其它 canonical/History 故障组合与 5.2 总体零差异门禁仍待完成，不进入 5.3 |

| **v91（Phase 5.2 shadow 差分比较数组/symbol 边界红测修复与全量复验）** | 新增数组元素无 enumerable 字段差异用例，先红后修复：深比较发现不等但字段集合为空时不得误报 matched；补齐稀疏/undefined index 与仅 symbol 差异 sentinel。`sessionStorageShadow.test.ts` 17 项、shadow/accepted-turn/prepare-turn IPC 联合 63 项通过；全量 `npm test -- --reporter=dot` 856 文件通过、1 跳过（7,875 项通过、106 项跳过，257.57 秒）。5.2 完整新写路径/故障矩阵及 eligibility/cutover 验收仍未完成，不进入 5.3 |

| **v92（Phase 5.2 required-user 重复 stable ID 原子拒绝审计与全量复验）** | 为 `requiredUserMessage.id` 同时重复出现在 `payload.messages` 的情形补事务回滚断言；验证现有 cardinality 校验在写入前拒绝（History event 不落库、legacy 正文不变），未发现需修改生产实现的缺口。`sqliteAgentHistory.test.ts` 162 项通过；全量 `npm test -- --reporter=dot`：856 文件通过、1 跳过（7,876 项通过、106 项跳过，258.43 秒）。5.2 全部写路径审计、完整 eligibility 零差异认证/退出门槛仍未完成，不进入 5.3 |

| **v93（Phase 5.2 canonical API candidate 状态语义纠正与全量复验）** | 红测确认 API candidate 读取只组装 canonical `Message[]`，并不和 legacy 比较；此前返回 `matched/differenceCount=0` 容易被误认成一致性认证。现改为 `available/unavailable` 并移除差异数，只有 shadow comparator 返回 `matched/mismatched`。candidate 覆盖与性能测试、shadow/accepted-turn/prepare-turn IPC 联合 63 项通过；全量 `npm test -- --reporter=dot`：856 文件通过、1 跳过（7,876 项通过、106 项跳过，258.92 秒）；全量内 p95 shadow 3.99/5.83 ms、API candidate 3.90/5.87 ms。5.2 的完整写路径与 eligibility 认证门槛仍未完成，不进入 5.3 |
| **v94（Phase 5.2 compaction snapshot 的 UI/Provider 分离回归）** | 新增真实 SQLite 用例：`transcript-compacted` 的 provider snapshot 可改变 canonical API candidate，但不改 `messages.content` UI 正文；shadow 将内容差异报告为 `mismatched`，不会授予 API eligibility，`api_read_mode` 保持 legacy。针对性用例通过；shadow/accepted-turn/prepare-turn IPC 联合 64 项通过。该边界纳入新写路径审计；5.2 完整矩阵与 eligibility 认证仍未完成，不进入 5.3 |
| **v95（Phase 5.2 compaction 跨重启与同批写入矩阵）** | 真实 SQLite 回归覆盖 context 后 close/reopen 再 compaction，以及 compaction 与独立 stable-ID assistant response 同批追加；UI user 正文不被 snapshot 改写，独立 assistant response 仍原子镜像。shadow 持续报告内容差异且不授予 eligibility。针对性及 History/shadow/accepted-turn/prepare-turn IPC 联合 228 项通过；5.2 完整字段/新写路径故障矩阵与资格认证仍未完成，不进入 5.3 |
| **v96（canonical History 水位变化撤销 API eligibility）** | 红测复现纯 compaction event 不触发 message mutation trigger、旧 API eligibility 留存。v98 将该行为下沉到共用低层 History append 原语；非重复 session History append 在同事务撤销 API eligibility，并把 canonical read mode 降为 `revalidation-required`；写入或后续 mirror 失败会整体回滚。History/shadow/accepted-turn/prepare-turn IPC 联合 229 项通过；Hosted handoff compatibility 联合后 5 文件 270 项通过；完整故障矩阵与 5.2 eligibility 认证门仍未完成，不进入 5.3；全量 `npm test -- --reporter=dot` 复验 856 文件通过、1 跳过（7,880 项通过、106 项跳过，259.22 秒）；`typecheck:shared`、`typecheck:agent-sdk`、`build:electron:incremental` 通过 |
| **v97（幂等 History 重放保留同水位资格）** | 新增 SQLite 回归：同一已提交事件按相同 expectedVersion 幂等重放时结果为 duplicate，不改变 canonical watermark，因此不撤销该水位对应 API eligibility；新增非重复 canonical append 的资格撤销与事务回滚用例继续通过。5 文件联合 271 项通过。全量测试结果记录于 v96（完成于新增本回归之前），本轮增量聚焦集合通过；5.2 完整字段/写路径故障矩阵与资格认证仍未完成，不进入 5.3 |
| **v98（低层 History append 共用资格水位围栏）** | 审计发现 `operations.ts` 与 continuation 会直接调用低层 History 事务原语，前者虽由消息 trigger 覆盖，后者可能不改骨架而绕过资格撤销。现将 API eligibility 失效移入共用 append 原语，所有真实 session watermark 增长路径同事务清除 eligibility 并把 canonical 读降为 `revalidation-required`；幂等重复仍不失效，旧未迁移 fixture 跳过 v38 fence。低层直接调用回归、History、continuation、operations、Hosted handoff、shadow、accepted-turn 与 prepare-turn IPC 7 文件联合 355 项及全量 856 文件、7,882 项测试通过；shared/agent-sdk typecheck、Electron incremental build 通过。5.2 剩余零差异完整审计未完成，不进入 5.3 |
| **v99（Phase 5.2 shadow 认证与 5.3 持久 eligibility/cutover 边界澄清）** | 对照实现确认 5.2 shadow `matched` 只形成逐 session 进入 5.3 认证的候选证据，不写 API eligibility、不切换用户读路径；5.3 才在同一 SQLite 快照重验 L2、generation、骨架 revision 与 canonical 水位，并原子持久化资格及开启新读。修正 §8.8.2 与 §8.8.2.1 的表述，避免将 shadow 对拍误解为已授予 cutover 资格。未改变阶段状态：5.2 的完整新写路径/故障矩阵和退出门禁仍未完成，不进入 5.3 |
| **v100（accepted-turn API shadow 同快照封装）** | 红测证实实际被消费的 legacy context 与 accepted-input History/指纹此前在 shadow 事务外读取，不能证明与 canonical 候选处于同一 SQLite 快照。现将 legacy selector、History receipt/指纹校验和 shadow 读包在同一只读事务；既有 accepted-turn 与 shadow 回归联合 25 项通过，`build:electron:incremental` 通过，`git diff --check` 通过。5.2 其它完整写路径/故障矩阵及退出门禁仍未完成，不进入 5.3 |
| **v101（queued reorder eligibility 围栏回归）** | 补齐 §8.8.3 明确要求的 queue 移序写路径验证：同序 no-op 保留 projection/API eligibility 与 revision；实际移序通过 `messages UPDATE` trigger 原子撤销两类资格、推进 revision、将 API 读模式降为 `revalidation-required`，并保留 queued 正文及状态。`operations.test.ts` 定向用例通过；5.2 其它完整写路径/故障矩阵和退出门禁仍未完成，不进入 5.3 |
| **v102（逐请求 shadow 匹配与逐会话资格范围区分）** | 增加回归：API context 通过 boundary/exclude 只选择有 canonical identity 的当前 user 时，shadow 可以对该请求报告 matched，但同会话仍有未映射 legacy user；测试确认不写 API eligibility 且读模式仍为 legacy。明确 v38 eligibility 按 session 保存，5.3 必须覆盖该 session 所有可能进入 API/route/reuse-user 的 eligible skeleton，不能用单次缩窄 context 对拍授予全 session 资格。新增 `sessionStorageShadow.test.ts` 定向用例通过；5.2 完整退出矩阵仍未完成，不进入 5.3 |
| **v103（watermark-only compaction 后 API L1 失效）** | 新增端到端回归：先认证/热建 API shadow transcript L1，再追加不修改 `messages` 骨架的 `transcript-compacted`；断言 `message_revision` 不变、旧 cache watermark miss、shadow 从新 L2 读到 compacted body 并报告 mismatch，低层 append 原语撤销 API eligibility/降为 `revalidation-required`，legacy UI 正文保持原值。定向用例通过；5.2 其余完整写路径/退出门禁仍未完成，不进入 5.3 |
| **v104（DB reopen 后 stale API L1 与 eligibility 重验）** | 增加真实文件 SQLite 生命周期回归：持久化 canonical L1 与 API eligibility 后关闭/重开，确认旧水位 L1 可命中；再追加仅改变 History transcript/watermark 的 compaction，验证旧 cache miss、新 shadow 走 L2 并报告 mismatch、API eligibility 被撤销且 legacy UI 正文不变。定向与完整 `sessionStorageShadow.test.ts` 通过；5.2 完整退出门禁仍未完成，不进入 5.3 |
| **v105（异步技能路由期间 revision CAS 拒绝 IPC 回归）** | 新增 `chat:prepare-turn` IPC 回归：技能路由挂起期间模拟 session revision/generation CAS 拒绝，确认旧配置不冻结、turn 经 runtime `source-failed`/`failConfiguringTurn` 收敛，且不启动 execute；`electron/appIpc.file.test.ts` 42 项通过。该项加强 5.2 准备阶段时序证据；其余完整字段/新写路径/故障矩阵与退出门禁未完成，不进入 5.3 |
| **v106（required-user legacy/canonical 错误码同输入对拍）** | 补齐 5.2 退出指标里的 API 错误语义证据：同一 required-user excluded/invalid 输入分别执行 legacy `getTurnContext` 与 canonical selector，核验两侧错误码逐项相等。shadow、History、continuation、operations、Hosted handoff、accepted-turn 与 prepare-turn IPC 7 文件 361 项通过（其中 API candidate p95 legacy 3.66 ms、candidate 5.74 ms；shadow p95 3.75/5.77 ms）。该项不代表其它完整新写路径、故障矩阵和总体退出门禁已通过，仍不进入 5.3 |
| **v107（B5 删除事务持久化 spill GC 待办起步）** | 按未完成的前置生命周期门禁回补：schema v39 新增无 session 外键的 source-truth spill GC queue；`deleteSession` 在同一事务严格解析待删 session 的 History/transcript locator、去重登记 pending 项后删除引用。真实文件 SQLite 用例确认事件与 transcript 引用删除后待办保留且文件尚未提前删除；畸形 History JSON 用例确认删除事务整体回滚。spill/migration 2 文件 27 项、迁移与 operations 联合 8 文件 155 项通过，diff check 通过。跨进程写入 fence、完整全库引用核验、文件 unlink+directory fsync worker、错误/重启重试与启动/空闲接线仍待实现；B5 门禁未通过 |
| **v112（5.4 收口：旧写入口 fail-closed、全量回归通过；5.5 仍锁定）** | 对所有直接经过 `updateMessageContent` 的旧正文写入统一加 canonical write-mode 拒绝，metadata-only 更新不受影响；History 内部 canonical 镜像仍走同 append 事务。red/green 覆盖 coordinator 通用旧写入口不再能覆盖 canonical 正文。5.4 联合 294 项通过；全量 `npm test` 858 文件通过/1 跳过、7926 项通过/106 跳过；shared/renderer/agent-sdk 类型检查、Electron 增量 build、i18n、`git diff --check` 全绿。5.4 标记完成，完整 `messages.content` 副本保留；5.5 所有读点、回滚地板、停写和分批清理门禁尚未满足，仍锁定 |
| **v113（5.5 正文读点审计与 canonical-backed-only transcript/chat 解析起步）** | 对照生产调用列出 8 类正文消费者，确认 reuse-user、SQL 搜索、sequence 导出/capability、getMessage、恢复/重试、preview 和其它 getMessages 仍有旧列依赖，5.5 禁止停写/清列。新增 canonical write mode transcript resolver：dual-write row 必须与 canonical 正文完全一致，only row 按 stable ID/role/timestamp/status 严格映射；缺失 canonical-only 正文抛 `CANONICAL_SESSION_CONTENT_UNAVAILABLE`。清空 content 的 transcript/chat 红绿用例和缺失 canonical fail-closed 用例通过；projection 测试 16 项通过。** |
| **v114（5.5 canonical-aware 单条/sequence 分页 reader 与调用者接线）** | 新增 `getProjectedMessage` 与 `getProjectedMessagesPageWithSequence`，双写/only rows 均走 canonical transcript resolver，legacy queued/streaming rows 保留 SQLite 正文，canonical-backed 状态下缺 canonical 时 fail closed。`reuse-user`、session read capability、main 的 session backup export reader 与 startup recovery message dependency 已接线；IPC 测试更新为断言 canonical-aware reader。projection/capability/IPC 联合 69 项通过；shared/renderer/agent-sdk typecheck、Electron 增量 build、i18n、`git diff --check` 全通过。搜索、其它 raw getMessage/getMessages、恢复/重试和 preview 仍未迁移；不允许停写/清列 |
| **v115（5.5 accepted input/恢复/重试与搜索 canonical-backed reader）** | `getProjectedTurnContext` 以旧 SQLite 查询保留 boundary/required-user/exclude/order 后按稳定 ID 批量解析 canonical 正文；`loadAcceptedTurnMessages` 在校验持久 accepted-input 指纹前先取认证正文。重试已由 `resolveProjectedRetryContext` 解析 user/failed assistant；Hosted restart-input、coordinator replay/recovery 与启动恢复注入使用 canonical-aware 单条 reader。新增 sequence 搜索语料 reader，global `search:execute` 同时匹配旧正文候选与 canonical-backed 候选，再对权威正文执行 SQLite `LIKE ... ESCAPE`，保持 profile/ownership、timestamp 排序和 limit 语义；canonical-backed 状态与 write mode 不一致或 transcript 无法认证时 fail closed。清空旧正文后 accepted input、retry、聊天搜索语料和全局搜索红绿用例通过；联合 217 项、Electron typecheck、`git diff --check` 通过。尚余其他 raw `getMessage/getMessages`、preview、剩余批量消费者及跨重启/kill-switch 全面验收；不允许停写/清列 |
| **v116（5.5 批量消息消费者与自动备份页接线）** | 新增 `getProjectedMessages`，在保留 `getMessages` 的 ascending sequence、limit、offset 和消息字段骨架的同时，一次认证 transcript 并恢复所选 canonical-backed 正文；接入无持久 turn 的远程/管家上下文及 session title suggestion。`ipcShared.backupPageReader` 改用 canonical-aware sequence page，保持 backup cursor；增加自动备份 reader IPC helper 断言。214 项投影/远程/管家/标题测试通过，Electron typecheck 与 diff check 通过。仍有 outbound pressure、retention/cleanup、preview、message patch response 及其它内部 raw 读点；5.5 清列与停写门禁继续锁定 |
| **v117（5.5 canonical-only L2 cache miss、retention 与其余读点收口）** | canonical write mode 且存在 backed row 时，cache miss 不再拿已清空 legacy 正文作 L2 对拍输入；改从 History shadow fold 重建完整 transcript，再按消息骨架 stable ID/role/timestamp/status 严格合并并重建 disposable L1。cache 删除后的 canonical-only L2 用例触发此路径。Retention projection preparer 改用 canonical-aware batch reader；消息 patch IPC 返回改用 projected 单条 reader；outbound queue 计数和 context-pressure 仅需 status/thinking/attachments，改读不含正文的 skeleton。4 文件 84 项通过，Electron typecheck、diff check 通过。preview、其余 raw 读点分类、全量跨重启/kill-switch 验收仍未完成；禁止停写/清列 |
| **v118（5.5 清列后 turn route 窗口选择与正文解析）** | `getRecentTurnRoutingMessages` 原先在 SQL 中 `TRIM(content) != ''`，会把 canonical-backed-only 空正文行提前滤掉。新增保留 turn/sequence/boundary/exclude/排序/limit 规则的 `getRecentTurnRoutingMessageSkeletons`，只让非空 legacy 或显式 canonical-backed 行进入候选；`getProjectedRecentTurnRoutingMessages` 再批量解析正文并接入 `prepare-turn`。清空正文用例确认仍选中原路由消息并恢复 canonical 正文；projection/IPC/operations/accepted/retention 联合 145 项、Electron typecheck、diff check 通过。真实 canonical-only IPC 路由、附件/fingerprint 与 await 后 revision fence 的清列验收仍待补齐；不允许停写/清列 |
| **v119（5.5 route 空文过滤后限量与完整顺序）** | 按设计要求将用户侧 legacy `getRecentTurnRoutingMessages` 保持原有 `TRIM` 行为，新增 `iterateRecentTurnRoutingMessageCandidates` 只负责一致 SQLite 快照下的 role/status/turn/boundary/exclude/order 骨架选择；canonical-aware route reader 按倒序候选解析正文、跳过 canonical 空正文，再在第 N 个非空消息后停止并反转输出，保持原升序 50 条尾窗。加入“最新 canonical assistant 正文为空时回退选取前一条有效 user”的清列测试。route/shadow/cutover/IPC 联合 169 项通过；30 组 p95 legacy 5.27 ms、canonical candidate 12.60 ms，符合 `legacy ×2 + 5 ms = 15.54 ms` 门禁；Electron typecheck/diff check 通过。真实清列 IPC 故障矩阵、附件指纹、跨重启 fence 与 preview 仍待完成，禁止停写/清列 |
| **v120（5.5 canonical 正文镜像同步最后消息 preview）** | 新增最后消息 canonical 编辑 preview 红测，确认旧实现只更新 `messages.content`、未更新 `sessions.preview`；`mirrorCanonicalContextMessages` 现在在同一 History append 事务中核对 sequence 尾部，仅在编辑目标仍为最后消息时用完整镜像正文更新 preview。canonical-only queued 删除用例与该编辑用例分别覆盖正文真源更新/删除后的 preview。sessionStorageCutover/sqliteAgentHistory/operations 联合 253 项通过，Electron typecheck 与 `git diff --check` 通过。preview 主体 blocker 已解除；真实清列 turn-preparation IPC、剩余 raw 读点与跨重启/kill-switch 故障矩阵仍待完成，不得停写/清列 |
| **v121（5.5 reuse-user 空旧正文的 IPC reader 接线与 SQLite projection 对拍）** | 将 `chat:prepare-turn` reuse-user IPC fixture 的 raw `getMessage().content` 置空，canonical-aware `getProjectedMessage` 仍提供模型输入；断言技能路由收到认证正文、附件仍触发 vision 配置，已有 await 后 fence 检查保持生效。另由真实 SQLite canonical-backed-only projection 用例清空 `messages.content`、验证 route window 与单条消息恢复。两个定向用例通过。证据覆盖真实 SQLite reader 和 IPC 接线，但目前仍分成两项，缺同一真实 SQLite prepare-turn 端到端回归；missing canonical fail-closed 与 reopen/kill-switch 故障矩阵也待补，禁止停写/清列 |
| **v122（5.5 global search 混合结果、字面 LIKE、limit 与 reopen/L2 验收）** | 增加真实 SQLite 搜索用例：混合 legacy/canonical-only 命中按 timestamp 全局降序排列，limit 在 canonical 正文解析后生效；反斜线、`%`、`_` 均按字面匹配，近似字符串不会误命中。另以文件 SQLite 清空 canonical-only 正文、删除 transcript cache 后关闭并 reopen，验证 global search 从 History L2 恢复正文并重建 cache。projection/search 文件 19 项通过，`git diff --check` 通过。大 session 搜索成本和 5.5 读点/停写门禁仍待完成，禁止停写/清列 |
| **v123（5.5 global search 1200 消息 canonical-only 成本测量）** | 将 P2 1200 消息真实 SQLite 性能夹具扩展为全会话 canonical-backed-only 的无命中 global search，对 legacy `searchMessages` 和 `searchProjectedMessages` 各预热 10 次后采 30 组 nearest-rank p95。两次 30 组测量 p95 范围：legacy 0.23–0.34 ms、canonical 9.36–12.21 ms（约 36–41 倍）；两者结果均为空。搜索无专属性能阈值，故只记录证据并标为待性能预算评审，不判定通过；无实现变更。聚焦性能测试通过 |
| **v124（5.5 canonical-only sequence 分页、capability 与 reopen 验收）** | `getProjectedMessagesPageWithSequence` 的文件 SQLite 回归扩展到 3 条 canonical-only 正文：清空 `messages.content`、删除 transcript L1、关闭并重开数据库后，按 cursor 两页读取仍逐条恢复 canonical 正文和真实 sequence/nextSequence。`action.session.read` handler 增加清列+cache-miss 后三条消息分两页读取用例，实际验证 capability 限制后的 reader/cursor 合同。两个测试通过；shutdown flush 与自动备份最终 JSON 产物的 round-trip/失败重试仍待测，禁止停写/清列 |
| **v125（5.5 自动备份生成物 canonical-only round-trip）** | 把真实 `backupPageReader` 接入 `SessionBackupManager`，基于 SQLite session 清空三条 legacy 正文、删除 transcript cache，以 2 条 page size 生成真实 `messages.json`，再通过 `restoreSession` 核对全部 stable ID 与 canonical body。sequence reader/cache-miss、流式文件写入与 restore 形成端到端覆盖。相关聚焦测试通过；main shutdown flush 的专属失败/重试验收仍未覆盖，故此行读点尚未完全关闭，不执行停写/清列 |
| **v126（5.5 单条与批量 raw 消费者分类）** | 重新枚举所有生产 `getMessage/getMessages` 调用：turn coordinator、startup cleanup、Hosted handoff、reuse-user 与模型/展示消费者均使用 canonical-aware reader；projection、shadow、cutover 内部 legacy 读取用于对拍/回退；operations raw 调用限制在 queued receipt/队列读取和恢复阶段 failed/streaming 消息的工具状态元数据。确认 retry selector 仅由 projected wrapper 消费。未发现其它生产正文消费者绕过 resolver；queued/recovery 已有 operations 与 coordinator 回归。转向各类 turn outcome 故障矩阵；5.5 尚未通过，不停写/清列 |
| **v131（shutdown canonical backup flush 有界重试）** | 退出流程将 `flushAll` 改为逐 session 有界重试的 `flushAllWithRetry`；最多 3 次，失败 session 不阻止其它 session settled，耗尽后统一报告给 shutdown 日志。首轮暂时写盘失败后，真实 canonical-only SQLite `backupPageReader` + `SessionBackupManager` 重试成功并 restore 逐消息正文；永久失败矩阵确认两个 session 各自尝试三次、所有工作 settled 后才统一失败。manager 两文件 19 项通过。shutdown flush 不再是未验收项，仍不代表清列授权

| **v132（Hosted failure terminal canonical-only checkpoint）** | 扩展真实文件 SQLite canonical-only/reopen Hosted restart 用例：在成功恢复并提交 checkpoint 后，下一 turn 注入 provider failure 与 canonical History terminal；确认调用以 `HostedTurnFinalizedError(outcome=failed)` 收敛，transcript checkpoint 版本递增、保留 canonical 正文且原 `messages.content` 仍为空。Hosted handoff 41 项通过；`git diff --check` 通过。IPC terminal、其它终态和畸形 History 矩阵仍未闭合，不授权停写/清列 |

| **v133（canonical-only accepted-input 持久指纹漂移 fail-closed）** | accepted turn 已有 History canonical context、旧 `messages.content` 清空且 transcript L1 删除后，将持久 `session-input-committed` 的 fingerprint 篡改为另一个格式有效的 SHA-256。reader 仍从 History L2 恢复 user 正文，但在返回前抛出 `TURN_USER_INPUT_FINGERPRINT_MISMATCH`，shadow 未执行、旧列保持空。与 Hosted handoff 联合 50 项通过，Electron typecheck 与 `git diff --check` 通过。Hosted 其它终态、IPC terminal、畸形 History 与搜索专属预算仍未闭合；不停写/清列 |

| **v134（Hosted canonical-only 终态 outcome 矩阵）** | 将 Hosted 终态矩阵扩展到真实文件 SQLite canonical-only/reopen：completed 路径复用已有 restart 用例；failed 路径验证 checkpoint 更新；新增 cancelled、timed-out、interrupted 三种 outcome，当前 History context + terminal 由 `SqliteAgentHistory.appendBatch` 实际写入后经生产 reader 消费。三种用例逐一核对 `HostedTurnFinalizedError` outcome、session transcript 正文及 prior canonical-backed-only 正文列保持空白。与 accepted context 联合 53 项通过，Electron typecheck 与 `git diff --check` 通过。IPC 终态、畸形 History 与搜索专属预算仍未闭合；不停写/清列 |

| **v135（terminal display IPC canonical-only 与畸形 History fail-closed）** | 在真实文件 SQLite 的 canonical-only completed session 中删除 transcript L1、关闭并 reopen 后，通过 `chat:get-display-message-page` 验证 renderer 收到 assistant `TurnDisplay` 的 canonical 正文和 completed lifecycle；随后将 terminal `invocation-context-committed.payload_json` 分别损坏为非法 JSON、以及有效 JSON 但空 `messages` 列表；每次清 L1 后复调同一 IPC 都必须同步抛 `CANONICAL_SESSION_CONTENT_UNAVAILABLE`，且旧正文列仍为空。`appIpc.file.test.ts` 47 项通过，Electron typecheck 与 `git diff --check` 通过。其它畸形 History、部分/终态顺序、spill/cache/watermark 矩阵及搜索专属预算仍未闭合；不停写/清列 |

| **v136（global search 20ms p95 自动门禁与预算建议）** | 在现有 1200 条 canonical-backed-only、10 次预热、30 组无命中配对采样上新增 canonical search p95 ≤20ms 断言，明确 50ms 为 IPC/renderer 整体响应红线。复测记录以 §8.8.4 当前值为准；历史两轮 canonical p95 9.36–12.21ms，20ms 预算覆盖最高观测值并留回归余量。预算仍须独立设计评审认可；其它畸形 History/部分流/终态顺序/spill/cache/watermark 故障门禁仍未闭合，绝不据此停写/清列 | |
| **v137（L1/L2 session event cursor 与实际 History 行数对拍）** | canonical transcript 的认证读取和 cache read-through 同时要求持久 `session_event_cursor.next_seq`、实际 session event 行数、连续 `session_seq` 与 watermark anchor 一致。真实文件 SQLite/reopen 测试删除已认证尾 terminal 后证明 canonical-only projection fail closed，旧正文列仍为空；transcript/History/Hosted/accepted-context/IPC 联合 286 项通过。当前 global search 同一性能测试测得 legacy 0.19ms / canonical 8.20ms。其它部分/畸形 History 与 spill/cache/watermark 矩阵仍待逐项验收 | |
| **v138（启动孤儿 shell 清理骨架读点实证）** | 启动清理针对 active turn 的 `run_shell` owner identity 读取 raw `messages` skeleton，不要求仍 streaming 的 assistant 正文 canonical 化。真实文件 SQLite canonical-only/reopen 集成测试确认 PID、process group、owner token 仍可完成清理，旧正文为空；六文件联合 288 项、Electron typecheck 与 `git diff --check` 通过 | |
| **v139（canonical-only transcript 真相源 spill 故障矩阵）** | 真实 SQLite 中将大正文写入 source-truth spill，清空 legacy 正文并清投影缓存后，分别删除和篡改 spill 文件；两种情况下 transcript projection 均抛 `CANONICAL_SESSION_CONTENT_UNAVAILABLE`，旧列仍为空。spill 严格读取及 canonical-only 消费者都已验证，不以降级占位替代真相源。`sessionTranscriptProjection.test.ts` 两项通过；其它 5.5 spill/cache/watermark 组合继续逐项补齐 | |
| **v140（canonical preview 失败时队列删除事务回滚）** | 故障注入使 canonical source History JSON 损坏；删除尾部 queued 行后 preview resolver 抛错，测试确认 SQLite rollback 同时保留 queued message、receipt 状态/引用、原 session preview 与 sequence 顺序。`operations.test.ts` 聚焦用例通过；7 个数据库/History/Hosted/accepted-context/IPC/shell-cleanup 文件联合 365 项、Electron typecheck 与 `git diff --check` 通过。搜索预算独立评审和其余 5.5 故障矩阵仍未完成 | |
| **v141（队列移序 preview 故障原子回滚）** | 注入 `sessions.preview` 更新失败，验证 queued message 两阶段 sequence 暂存/交换、queued receipt、计数、preview 与 canonical projection/API eligibility fence 全部维持事务前状态。7 个数据库/History/Hosted/accepted-context/IPC/shell-cleanup 文件联合 366 项、Electron typecheck 与 `git diff --check` 通过；搜索 p95 本轮复测 legacy 0.18ms / canonical 8.14ms。搜索预算独立评审及其它 5.5 故障矩阵仍待完成 | |
| **v142（queued 正文编辑 preview 故障原子回滚）** | 注入 `sessions.preview` 更新失败，验证 queued 正文、queue receipt/fingerprint、message revision、preview 与 canonical projection/API eligibility fence 全部维持事务前状态。聚焦用例通过；7 个数据库/History/Hosted/accepted-context/IPC/shell-cleanup 文件联合 367 项、Electron typecheck 与 `git diff --check` 通过；搜索 p95 本轮复测 legacy 0.19ms / canonical 8.31ms。搜索预算独立评审及其它 5.5 故障矩阵仍待完成 | |
| **v143（canonical-only 尾消息下队列移序 preview 正确性）** | 红测复现：queued 移序后重算 preview 直接读取尾行 legacy `content`，会把 canonical-backed-only completed assistant 的 preview 清空。移序现读取完整尾消息并经事务内 `contentForSessionPreview` 严格解析；成功路径回归与既有移序/删除/编辑 preview 故障回滚共同通过。`operations.test.ts` + `sessionTranscriptProjection.test.ts` 100 项通过，Electron typecheck 与 `git diff --check` 通过；1200 条搜索复测 p95 legacy 0.21ms / canonical 8.24ms。搜索预算独立评审及其它 5.5 故障矩阵仍待完成 | |
| **v144（L1 History terminal 顺序/内容校验与变更失效）** | 红测复现 canonical-only 缓存绕过：completed terminal payload 原位篡改而 event count/cursor/watermark 不变时，旧 L1 仍返回正文；另复现 terminal 后追加非正文 History 事实被 L1 当作无关 delta 忽略。v42 新迁移使 History event UPDATE/DELETE 与 stream 归属变化清除 transcript projection cache；L1/L2 每条 invocation fold 使用 `validateHistoryTransition`，且增量尾部检查缓存水位前同一 invocation 是否已终态。迁移与 canonical-only 两项红绿测试通过；projection/History/5 个迁移测试文件联合 214 项通过，Electron typecheck 和 `git diff --check` 通过；搜索复测 p95 legacy 0.17ms / canonical 8.21ms。其它 5.5 故障矩阵与搜索预算独立评审仍待完成 | |
| **v145（canonical transcript cache 正文 checksum 与 L2 重建）** | 红测复现：将 canonical-only transcript cache 的 JSON 改成结构有效且 stable ID/role/timestamp 仍匹配骨架的伪造正文，L1 曾直接返回伪造内容。v43 新增 `value_sha256`，读 cache 前验证正文 checksum；不匹配时丢弃 L1 并由 History L2 重建。迁移会清空无 checksum 的旧 cache，迁移重跑按列存在检查保持幂等；空 session 初始 cache 同样写 checksum。11 个数据库/History/migration/maintenance 文件联合 340 项通过，Electron typecheck、`git diff --check` 通过；1200 条 global search p95 legacy 0.17ms / canonical 8.25ms。其它 5.5 故障矩阵与搜索预算独立评审仍待完成 | |
| **v146（L1 transcript cache 不遮蔽 source-truth spill 故障）** | 新红测先建立有效 canonical L1 cache，再删除/篡改 History source spill，复现旧逻辑仍返回 cache 正文，违反 source-truth fail-closed 要求。L1 命中时现在扫描该 session 带 spill 标记的 History payload，严格解析 descriptor 并校验每个 source-of-truth spill 的字节长度与 SHA-256；缺失/篡改统一 fail closed。真实文件 SQLite 用例关闭并 reopen 后复测两种故障，旧 `messages.content` 仍为空；canonical cache tamper 的 reopen/L2 重建也覆盖。`sessionTranscriptProjection.test.ts` 全部 25 项通过，warm 1200 条配对 global search p95 legacy 0.25ms / canonical 10.05ms（≤20ms 自动门禁），Electron typecheck 通过。未完成的 History 故障组合、性能预算独立评审和其它读点门禁仍阻止停写/清列 | |
| **v147（大正文 source spill L1 读取成本门禁）** | 两种真实文件 SQLite source spill 故障用例均先建立 84,000-byte canonical-only body 的 L2 cache，再测量 30 次 L1 hit，并核对每次都返回完整正文；缺失/篡改验证发生在同一组读取后。初测 p95 分别为 0.87 ms、0.52 ms；后续完整复跑观测范围为 0.45–0.68 ms，均通过 `<50ms` 响应门禁。`sessionTranscriptProjection.test.ts` 全部 26 项通过。该单 spill p95 不替代多 spill/超大 transcript 与 global search 分布评审 | |
| **v148（cache 水位后的部分 tool call terminal 不变量）** | 新红测在 session L1 cache 水位之后直接 SQL 写入 `tool-call-started` + `invocation-completed`，分别构造跨水位遗留 pending tool call 和 pending approval 的损坏流；旧逻辑忽略了不改写 transcript 的 tail 事件，错误接受终态。L1 现在遇到 terminal suffix 时调用完整 invocation `readSync`，验证从流起点的序列、状态与 pending tool/approval 转移；该异常最终使 canonical-only projection fail closed。旧正文保持空白。聚焦红绿测试通过；projection/History/canonical fold/cutover 联合 233 项通过，Electron typecheck 与 `git diff --check` 通过。仍需覆盖更多部分/畸形流与其他 watermark/generation 组合 | |
| **v149（20 轮 multi-spill L1 与 global search 性能门禁）** | 真实文件 SQLite 建立 20 轮、40 条 canonical-backed-only transcript，每条正文 83,619 bytes，History 为每条正文写 source-of-truth spill；清空全部旧正文并删 L1 后先由 L2 重建，再测 30 组 L1 与 global search。p95：L1 14.08ms、search 12.78ms；L1 `<50ms`、search `≤20ms` 自动门禁通过，40 条正文均返回/搜索命中。聚焦测试通过；其余 5.5 故障矩阵、生产分布与搜索预算独立评审、清列回滚地板仍未完成 | |
| **v150（Phase 5.5 raw 正文读取调用面复核）** | 对生产 `getMessage/getMessages/getTurnContext/getRecentTurnRoutingMessages` 与 sequence/search 查询重新做静态调用面审计：prepare-turn 路由实际使用 projected reader；raw routing/API context 用于清列前认证与 shadow；receipt 限 queued legacy；startup/recovery raw records 限 streaming/failed 控制状态与 tool-call 元数据；retry selector 由 projected wrapper 消费。远程/管家/title/retention 已使用 projected readers，outbound admission 读 skeleton。未发现绕过 canonical resolver 的 canonical-backed-only 用户正文调用；更新 §8.8.4 读点表与总体 gate 摘要。其余 History 故障矩阵、搜索预算独立评审及清列回滚协议仍未完成 | |
| **v151（cache generation/watermark 身份元组 reopen 矩阵）** | 真实文件 SQLite canonical-only session 建立正确 transcript cache、清空 legacy 正文后，分别伪造 cache generation、watermark event ID、commit_order、session_seq、event_count，再关闭并 reopen。五种持久 cache drift 均拒绝 stale L1 并从 History L2 恢复 stable ID/body；旧 `messages.content` 保持空。projection/History/canonical fold/cutover 联合 238 项通过，projection 文件 33 项；Electron typecheck 与 `git diff --check` 通过。仍需补更多 History 状态转移、其他 cursor/session generation 交叉故障及清理门禁 | |
| **v152（L1 terminal kind/status 错配矩阵）** | 在有效 session L1 cache 水位后直接写入 terminal tail，分别覆盖 `invocation-completed/status=failed`、`invocation-failed/status=completed`、`invocation-interrupted/status=failed`。三种错误组合均通过完整 invocation `readSync` 被拒绝；canonical-only transcript fail closed，旧正文仍为空。projection terminal 3 项红绿测试通过；projection/History/canonical fold/cutover 联合 241 项通过 | |
| **v153（session event cursor 落后/缺失 fail-closed）** | 在真实文件 SQLite canonical-only session 建立有效 History/cache 后，DB close/reopen 再分别将 `session_event_cursor.next_seq` 改为落后值、删除 cursor 行。两种情况下即使缓存正文 checksum 与 watermark 自身有效，L1/L2 均拒绝 session event 行数与 cursor 不一致并抛 `CANONICAL_SESSION_CONTENT_UNAVAILABLE`；旧正文仍为空。与既有 tail delete（cursor 超前）、watermark drift（由有效 History L2 重建）用例共同覆盖 cursor 两向及缓存身份边界 | |
| **v154（L1 tail sequence 与 invocation stream 元数据完整性）** | 红测先复现水位后的 `sequence=3` 尾事件被 L1 接受；修复在增量 fold 前用全流标量聚合校验 `COUNT/MIN/MAX`、cache 水位前缀数量、stream version/schema_version 及尾事件连续序号，不读取历史 payload；因此坏尾无法绕过 L2。L2 另对完整 invocation rows 与 stream owner/version/schema/连续 sequence 逐行对拍。独立 canonical-only 测试覆盖尾 sequence gap、stream version drift 与 stream schema_version drift，全部 fail closed 且旧正文为空。`sessionTranscriptProjection.test.ts` 42 项通过；Electron typecheck 通过；1200 条 search p95 9.37ms，20 轮 40 条 × 83.6KB multi-spill L1 p95 15.41ms、search p95 16.72ms，均通过 `<50ms` / `≤20ms` 自动门禁；`git diff --check` 通过。其它畸形 History/cursor 组合、搜索预算独立评审与清列回滚地板仍未完成 | |
| **v155（全局 History commit cursor 连续性）** | 红测在一条有效 canonical-only History 后插入多余 commit cursor allocation，复现 L2 未核验全局 cursor；修复要求全库 History commit_order 与 `agent_history_commit_cursor` ID 集合在数量及 `1..N` 连续范围上一致，再允许 canonical fold。测试分别覆盖 cursor 超前与删除内部 allocation 造成的空洞，均 fail closed 且旧正文为空；session_seq 与 session ownership 直接漂移也 fail closed。projection 聚焦 cursor 用例 2 项通过，全文件最新性能样本 search p95 8.38ms、multi-spill L1/search 14.80/12.78ms；四文件联合 251 项通过，API cutover 配对 p95 3.95/6.41ms；Electron typecheck 与 `git diff --check` 通过。仍需继续覆盖余下可证实的畸形 History 状态及独立搜索预算评审；event_id 没有独立签名承诺，不声称能识别任意合法值替换 | |
| **v156（History event 结构与 kind fail-closed）** | 红测在有效 canonical-only cache 后追加未知 kind 尾事件，复现 L1 将其当无关 delta 忽略；并覆盖已知 kind 搭配非法 JSON、合法但非规范 JSON。L1 tail 与 L2 full fold 复用 `validateHistoryBatch` 检查事件 identity、白名单 kind、payload JSON 可往返性与规范性。4 项 malformed-history 红绿用例（含缺少 `toolCallId` 的 tool terminal）通过，旧 `messages.content` 仍为空。6 文件（projection、History、canonical fold、cutover、SDK history/turn）联合 402 项通过；搜索 p95 8.48ms，20 轮 multi-spill L1/search 14.18/14.53ms，均通过 `<50ms` / `≤20ms` 门禁。SDK 写入接口保持兼容，严格校验限定在 canonical transcript 认证读边界；畸形 History 的其余状态转移矩阵、搜索预算独立评审和清列回滚地板仍未完成 | |
| **v157（SDK tool terminal identity 与 canonical reader fence）** | 复核并保留 SDK 取消语义：`tool-call-started` 提交后、dispatch lease abort 期间仍可追加 `tool-call-not-dispatched`，而 interrupted terminal 可保留 unresolved work 供恢复；对该合法路径的定向测试现为绿色。canonical reader 单事件结构校验要求 `tool-call-started`/`finished`/`not-dispatched` 均带非空 `toolCallId`，与未知 kind、非法/非规范 JSON 共同 fail closed，避免把宽松 legacy-compatible writer 规则收紧后破坏旧记录/调用方。上述结论已由 6 文件联合 402 项覆盖，Electron 与 agent-sdk typecheck、`git diff --check` 均通过；停写/清列仍锁定 | |
| **v158（canonical tool pending identity 状态转移）** | 红测在 canonical-only cache 水位后写入孤立 `tool-call-finished`、重复 `tool-call-started` 或同一 model response 内重复 proposal ID，旧 L1/L2 接受其中重复 start；修复为带 tool/approval 状态事实的 L1 尾部验证完整 invocation，L1/L2 canonical fold 均跟踪 proposed/started/settled identity，拒绝无匹配 pending 的结果、重复 start 与重复 proposal。SDK writer 仍兼容旧记录与取消期间 start→not-dispatched 语义；状态约束只在 canonical reader 认证边界生效。完整交叉回归 6 文件 405 项通过；Electron/agent-sdk typecheck 与 diff check 通过。性能样本：1200 行 search p95 8.62ms，20 轮 multi-spill L1/search 12.29/12.66ms；API cutover 配对 p95 legacy 3.62ms/canonical 8.68ms，均在门禁内。其余状态矩阵、搜索独立评审与清列回滚地板仍未完成 | |
| **v159（tool dispatch start 必须对应 proposal）** | 红测在 canonical-only cache 水位后追加无 proposal 的 `tool-call-started`，L1 旧逻辑将其折叠为普通 pending 状态；canonical-only 转移校验现在要求 start 对应唯一 `model-response-committed` proposal，同时保留 proposal→start→cancelled not-dispatched 与 interrupted 未决恢复语义。孤立 start/finish、重复 start、重复 proposal 的 transition matrix 全部 fail closed。6 文件交叉回归 406 项通过，Electron/agent-sdk typecheck 与 `git diff --check` 通过。性能样本：1200 行 search p95 8.52ms；multi-spill L1/search 12.35/13.83ms；API cutover 配对 p95 legacy 3.68ms/canonical 8.87ms，均通过门禁。其它 History outcome/approval 矩阵、搜索预算独立评审及清列回滚地板仍未完成 | |
| **v160（approval lifecycle cache-tail 故障矩阵）** | 在 canonical-only session L1 水位后追加 orphan approval resolution、重复 approval waiting、approvalId 与 waiting 身份错配，均 fail closed；合法 wait→denied resolution→completed 尾部仍从 canonical L1 成功返回，legacy 正文保持空白。SDK 的全流 transition validator 由 L1 state-tail 的 `readSync` 与 L2 full fold 调用，cache seed 不会遮蔽水位前 approval 状态。六文件联合 410 项通过；Electron/agent-sdk typecheck 与 `git diff --check` 通过。p95：1200 行 search 8.39ms、20-round multi-spill L1/search 14.00/14.46ms、API cutover legacy/canonical 4.02/8.63ms，均在门禁内。仍待更广 approval/outcome 故障覆盖、搜索预算独立评审、回滚版本地板与可恢复清理协议 | |
| **v161（global search budget 独立评审包）** | 将 1,200-message no-match 配对采样、20-turn/40-message/83.6KB multi-spill matching workload、nearest-rank p95 算法、20ms DB-path ceiling 与 50ms overall ceiling 汇总为 [独立评审包](../review/2026-10-03-session-storage-global-search-budget-review.md)，并列出工作负载边界与需 reviewer 决定的问题。**决定仍 pending**；评审包不等于批准，不解锁 legacy write shutdown 或清列。工作树版本 `v0.2.2` 等已发布 tag 不包含本次 canonical-only cleanup reader floor；当前 branch 的实现未形成可回滚发布版本，因此版本地板仍须后续发布证据 | |
| **v130（prepare-turn 缺正文 fail-closed 与真实 revision fence）** | 扩展同一真实文件 SQLite `chat:prepare-turn` 用例：canonical History 快照丢失 reuse-user stable ID 并清 L1 后，reader 在技能路由前抛 `CANONICAL_SESSION_CONTENT_UNAVAILABLE`，不调用 route、不留下新 turn；恢复快照后让 route await 挂起并由真实 SQL 更新消息 metadata 推进 `message_revision`，重放同一 request 等待配置并收到 `TURN_CONTEXT_CHANGED_DURING_PREPARATION`，持久 turn 收敛为 failed。`appIpc.file.test.ts` 全套、Electron typecheck 与 diff check 通过。Hosted/IPC terminal outcome、畸形 History 全矩阵、shutdown flush 与搜索预算仍待处理，禁止停写/清列 |
| **v129（真实 SQLite prepare-turn canonical-only/reopen 路由）** | `chat:prepare-turn` 实际 IPC handler 在真实文件 SQLite 中读取 canonical-backed-only `reuse-user`，先删除 L1 并关闭/重开数据库；技能路由收到 stable-ID 对应的复用正文和三条历史路由窗口，旧 `messages.content` 仍为空，附件触发 vision execution config，turn 成功冻结为 prepared。既有 await 后 fence fixture 保留；`appIpc.file.test.ts` 46 项、Electron typecheck 与 diff check 通过。真实 SQLite 缺正文 fail-closed 与并发 await mutation 仍待补，禁止停写/清列 |
| **v128（Hosted restart canonical-only reader 与镜像保留）** | Hosted process-restart accepted-input 在真实文件 SQLite 清空 `messages.content`、切 canonical write mode、删除 L1 cache 并关闭/重开数据库后仍按指纹恢复；红测发现下一次 History context mirror 会把既有 canonical-backed-only 正文副本重新写回，现 context 与 required-user mirror 均保留该行的空 legacy 列。Hosted 定向回归及 History mirror/required-user 26 项通过；prepare-turn 真实 SQLite E2E 仍待补 |
| **v127（5.5 canonical-only turn recovery outcome 矩阵）** | 对真实 SQLite 中 History 已有完整 user/failed-assistant 正文、messages 两行均 canonical-backed-only 且 legacy 正文已清空的会话，参数化执行 `recoverPersistedTurn` 的 completed、failed、cancelled、timed-out、recovered、commit-uncertain 六类 outcome。断言 turn/message 状态与 tool-call skeleton 收敛，canonical History 正文逐字不变。定向 6 项、operations 全套 74 项、Electron typecheck 与 diff check 通过。Hosted handoff/IPC 终态、畸形 History、spill/cache/reopen 故障组合仍未闭环，禁止停写/清列 |
| **v110（v41 History 直接写入资格撤销、canonical read 性能闭环及 Phase 5.3 全量回归）** | 为 canonical History event INSERT/UPDATE/DELETE 与 stream session 归属 UPDATE/DELETE 增加 v41 SQLite 触发器，直接数据库修改也会在同一事务撤销 API eligibility 并把 canonical mode 降为 `revalidation-required`；稳定 canonical API read 去掉每次完整 legacy `getTurnContext` 重读，仅在认证/失效后全量对拍，保留每次 canonical watermark/cache/skeleton fence 和 accepted-input fingerprint 校验。迁移 7 项、cutover/accepted-turn/shadow/IPC 聚焦 87 项通过；1200-message 30 组预热配对 p95 legacy 4.23 ms、candidate 7.01 ms，限值 13.46 ms/50 ms。全量 `npm test -- --reporter=dot`：858 文件通过、1 跳过，7915 项通过、106 跳过；shared/renderer/agent-sdk 类型检查、Electron 增量构建、i18n 与 `git diff --check` 均通过。5.3 退出门禁闭环；只解锁下一顺序阶段 5.4 的设计/TDD，5.5 仍锁定 |
| **v109（Phase 5.2 退出门禁闭环；5.3 逐 session eligibility、API/route cutover、kill switch、cache 与 async watermark fence 起步）** | 复核当前 5.2 完整字段/路由双读双写、异常与队列中间态、spill/cache/reopen、性能和全量套件证据，关闭 5.2 并进入下一顺序步骤。新增 `sessionStorageCutover`：完整 API context 和全量路由候选仅在同一事务逐字段匹配后授予 session generation/message revision/canonical watermark fence；默认关闭的 config kill switch、逐会话读切换、cache 缺失后的 L2 重认证及 async route 水位复核；accepted-turn 和 prepare-turn IPC 实际读取已接线。红测覆盖未映射行、History 正文漂移、水位变更、消息触发器、cache 删除、开关回退和真实调用者接线；Electron build 与聚焦回归通过。5.3 全量跨重启/故障回归仍待完成，未解锁 5.4 |
| **v108（B5 durable 回收 worker、跨进程 fence 与可续跑孤儿扫描验收）** | schema v40 新增全目录扫描状态/游标；GC 持锁严格核验 History + transcript 全引用后按批将安全 orphan 登记为 durable 待办，再 unlink、fsync 目录并标记完成。History spill 文件准备与 canonical 事务持同一 root fence，delete IPC、degradable retention 与 safe DB maintenance 共用 proper-lockfile；活动 turn 阻止删除，writer 事务二次校验 session generation。首次/每周全扫可续跑、idle 每 5 分钟维护、启动执行与删除后唤醒已接线；存储画像/UI 显示 pending source spill bytes。测试覆盖真实文件 DB、共享引用、损坏全库引用、删除及 todo 回滚、目录游标分页/未知临时文件保留、跨进程竞争、generation 删除竞态、unlink/fsync/完成标记失败与 reopen 重试；spill/profile/History/operations/IPC 聚焦回归通过，Electron 增量构建、i18n 与 diff check 通过。**B5 实施门禁通过** |

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
| **真相源 spill** | **无时间保留期**；会话删除事务提交后，只在 §5.8.1 的完整引用核验与写入 fence 下回收不再被任何真相源引用的对象。v108 已接通 durable GC worker、启动/定期维护和删除后唤醒；source spill 生命周期 B5 实施门禁通过。此回收不处理 `messages.content` |
| 可降级 spill | 按配置保留期清理（留痕） |
| 投影缓存 | 可无条件丢弃；提供"清空缓存"入口（下次读为 L2） |
| 审计台账（workDir） | 保留 `maxSessions` 语义；启动对**所有 profile roots**分别执行上限；删除前查询 canonical `transcript-compacted` 依赖并检查候选台账内 compaction 事件，命中或检查失败均保留目录并记录名单。依赖保护优先于数量上限，因此受保护目录可能令实际数量超过 `maxSessions`；投影化必须与 retention 联动同提交边界（P-4/B2）；归档优先于删除 |
| **B2 顺序约束** | retention 改造不得先于投影准备上线，且须与 Phase 2 投影读路径在同一发布变更中交付；运行时每个候选须先完成 SQLite projection 持久化，再删除文件台账。投影失败则保留台账；两者之间崩溃仅留下冗余台账，可安全重试 |
| 空间回收 | `PRAGMA optimize` + 定期 `wal_checkpoint(TRUNCATE)`；`auto_vacuum=INCREMENTAL`（需一次全量 `VACUUM` 生效）+ 按需 `incremental_vacuum(N)`；VACUUM 需窗口可见后、无活跃 turn、WAL 已 checkpoint |
| 显式入口 | 设置页"存储占用"面板（按分类显示 + 清缓存 + 归档 + 压缩带进度），**分类须区分两类 spill** |
| 逃生通道 | `--safe-db-maintenance`：跳过全量恢复 → 归档/清缓存/VACUUM → 正常启动 |

#### 5.8.1 会话删除后的 source-truth spill 两阶段回收（补充评审 B5）

`deleteSession` 在 SQLite 事务中严格解析该 session 的 History 与 `session_transcript_entries` locator，并在同一事务登记持久 GC 待办后删除引用；`session:delete` 提交后唤醒 worker。启动和每五分钟维护会处理待办，worker 与大正文 spill 写入共用跨进程 `proper-lockfile` root fence，并在 fence 内严格扫描全库 History/transcript 引用。v108 已覆盖共享 locator 保留至最后引用删除、损坏引用扫描不删文件、删除事务回滚、孤儿扫描可续跑、并发写入与 session generation 删除竞态、unlink/fsync/完成标记失败后 reopen 重试。此协议适用于 source-truth 文件及 locator 提交失败留下的同目录孤儿；source-truth 不参与按天 retention。该 B5 生命周期实现门禁已通过；它和后续 `messages.content` 停写/清列是两个独立步骤，后者仍受 §8.8.3 门控。

**第一阶段：DB 原子删除与待办登记。** `deleteSession` 在同一事务中，从待删 session 的 `agent_history_events.payload_json` 与 `session_transcript_entries.messages_json` 提取 source-truth locator，登记持久化回收待办（`locator`、删除的 session/generation、状态 pending、尝试次数、最近错误、创建/更新时间；同 locator 去重）；然后按现有所有权规则删除 History、transcript、会话及控制数据。任一 JSON/descriptor 无法完整解析、所有权含糊或待办写入失败，整个事务回滚，不得先删 DB 引用。事务提交前绝不删文件；提交结果不确定也不能凭本次内存候选删文件，只能重新打开 DB 后按持久待办和完整引用扫描判定。删除重试对已提交 session 和待办幂等；待办不因 `sessions` 行级联消失。活动 turn/未封口写入必须先被现有准入 fence 阻断，并要求后续同 session 的 canonical/transcript locator 提交检查 session 存在且 generation 未被删除，避免提交后重新产生悬空引用。

**第二阶段：串行核验与文件删除。** IPC 删除在 DB 提交后可异步唤醒回收 worker；启动（DB 打开与迁移完成后）和空闲维护必须持续处理 pending，直到成功或留下可见失败。worker 在与所有 source-truth 文件准备、History append、transcript locator 提交共用的**按 spill root 排他 fence** 下执行；写侧从创建正式文件之前持有 fence，直到 locator 事务提交/明确回滚之后释放。多进程若可能同时打开同一 userData，fence 必须跨进程有效；不能仅用单进程 Promise mutex。`--safe-db-maintenance`、删除 IPC、启动清理也遵循该 fence。无法取得 fence 则保留待办，不做扫描/删除。

持锁后在一致 SQLite 快照内**完整扫描所有** `agent_history_events.payload_json` 与 `session_transcript_entries.messages_json`（包括其它 session），严格解析每个 source-truth descriptor；任何查询/解析失败、未识别的 locator 形态或扫描不完整都 fail closed，本轮零删除。`spill_index` 只能作加速/审计索引，不能替代两张真相源表。只处理待办中且不在完整引用集合内的安全、规则化 locator；若另一个 session 仍引用它，保留文件与待办并记录 shared-reference 原因，后续引用删除后再重试。文件只能在受管 `userData/spill/` 内按 basename 删除，拒绝路径穿越与符号链接；逐个 `unlink`（已不存在视为幂等成功），fsync 目录后才把该 locator 待办标为 completed。文件 I/O、目录 fsync 或完成标记失败则待办保持 pending；下次启动/维护重试。提交确认不确定时重新扫描引用，不以旧扫描结果删文件。

历史版本在本协议上线前产生的孤儿没有待办：上线后的首次启动/空闲维护可在同一排他 fence 与完整扫描下执行一次全目录孤儿分类，持久化安全候选待办后再按上述 worker 回收；扫描失败不落“已完成”游标，也不删任何文件。新文件若已 durable 写入但 locator 事务回滚，也由这条全目录发现路径回收。目录清单仅接受受管 locator 文件，未知文件/临时文件不清；对最近创建或无法证明已退出写入窗口的文件保留到下一次扫描。全目录游标需可重启，避免每次启动无条件读取全部 History；常规启动仅处理 pending，周期性受控全扫可发现遗漏孤儿。

**验收与可观测性（v108 已实现）。** 真实文件 DB 与 spill 测试覆盖 History/transcript locator 提取、删除事务与 todo 回滚、共享引用保留至最后引用删除、全库损坏 JSON 扫描 fail closed、可续跑目录孤儿分页、并发 spill 准备/提交与 session generation 删除 fence、unlink/fsync/完成标记失败及 reopen 重试；启动、定期维护和删除 IPC 唤醒已接线，存储画像区分 pending source spill 与可降级 spill。此处证明的是 source-truth spill 文件生命周期；不会清除也不改变 `messages.content`。**B5 source spill 回收实施门禁通过**；Phase 5.5 旧正文停写/清理仍须满足 §8.8.3 的独立评审、回滚版本地板及清列后不变量。

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
| Phase 4 回收与保留 | **既有范围与 B5 回收完成** | schema v39/v40 durable queue + 可续跑孤儿扫描；删除事务先登记 locator；History spill 写入至引用提交、删除 IPC、degradable retention 与 safe DB maintenance 共用跨进程 root fence；严格全引用扫描后再 unlink/fsync/标完成，失败留待办重试；启动/idle 接线和 pending 字节画像已就绪。聚焦故障矩阵与 build/i18n 通过 |
| Phase 5 已认证正文投影化 | **5.0–5.4 完成；5.5 读点、清理协议与隔离演练完成；真实数据清列待兼容发布地板** | v33 设计独立复评通过；5.3 逐 session API/route 认证和 5.4 canonical 写权威、legacy 完整双写均已通过。5.5 正文读点、跨重启与故障 fail-closed、write-stopped 状态机及按 session 可恢复清理协议均已完成，并在隔离文件 SQLite 演练；清理入口未接入真实数据调用。canonical global-search 数据库路径 p95 ≤20 ms 和端到端 50 ms 自动门槛已接受并作为开发回归。生产设备分布测量改为发布后观测，不阻断 Phase 5.5 实现；真实数据停写/清列仍因兼容回滚版本地板未发布验证而锁定 |

### 8.1.1 当前实现记录（worktree：`codex/session-storage-refactor-tdd`）

| 项 | 当前事实 | 状态 |
| --- | --- | --- |
| schema | v31 新增 `canonical_projection_repairs` 与分类游标；v32 双序；v33 generation；v34 cache ver；v35 turn receipts；v36 transcript commit fence；v37 projection eligibility + messages mutation invalidation triggers；v38 API eligibility + per-session cutover fence + explicit body storage state；v39 source-truth spill GC queue；v40 resumable spill scan cursor；v41 canonical History mutation API-eligibility triggers；v42 transcript cache invalidation triggers；v43 transcript cache `value_sha256`；v44 可持久化 `write-stopped` 清理状态与围栏；v45 complete 清理账本不可改写/独立删除；v46 canonical-backed-only 正文与 storage state 不可改写 | 已实现并有迁移用例 |
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
| 当前验证 | Phase 5.0 oracle；v37→v44 migrations；5.5 canonical-only readers、搜索/导出/prepare-turn/Hosted/recovery/preview/queue 接线与故障回归 | projection/History/Hosted/recovery 矩阵持续覆盖 source spill、event/stream owner、interrupted/cancelled 下未决 tool/approval 的 transcript 与 recovery 状态一致性，以及 approval lifecycle 跨 watermark 的 L1/L2 五种 outcome 正常结算，以及 identity/outcome/metadata/timestamp mismatch 的 L1/L2 拒绝，以及并发 approval 跨水位部分结算、completed/failed/denied 对未决状态的拒绝及 approval transition、JSON/kind/身份/序号/schema、generation/watermark/cursor 和 cache reopen。v172–v213 修复 recovery owner 检查、Hosted/coordinator 在损坏 History 下的 fail-closed 与隔离恢复、cursor 双向漂移及 multi-spill search 预算回归；v211 全量复验 approvalId invocation 唯一性；v212 将 invocation-parked 纳入 SDK transition validator 的不可续写关闭流；canonical-only cache-miss L2 红测证明此前 SQLite 读侧复用 validator 时漏过该约束，修复后 fail closed。v180 移除 recoverTurn 在异常围栏前不必要的正文投影读取；v181 修复 IPC 启动时先恢复持久快照、后执行 coordinator recovery 的顺序风险；v182 将可跳过异常捕获严格限定在 canonical 正文投影读取，turn snapshot restore callback 自身异常仍中断并上报 recovery；v183 的双 session 真实 SQLite 回归证明前序坏 History 只跳过该快照，后续健康 session 仍 restore 且两条 durable turn 均收敛；v184 在 canonical transcript L1/L2 读取矩阵加入缓存水位后的 `model-response-committed` 未完成 tool proposal + terminal 组合；v185 加入 proposal 已位于 L1 水位前、terminal 位于 cache tail 的真实清列读取用例，确认读取器回查完整 invocation 后 fail closed；v186 对 approval-waiting 做同样的跨 watermark/reopen 边界验证，尾部 completed terminal 被拒绝且 legacy 正文保持空值；v187–v189 覆盖 interrupted terminal 的合法未决 approval、tool proposal 与已 dispatch 工具状态，L1 transcript 不丢失，SDK 状态重建保持 interrupted；v190–v191 验证水位前 pending approval/tool proposal/started dispatch 遇到 completed 或 failed terminal 均 fail closed；v192 修复 L2 fold 对合法 interrupted dangling tool 的过度拒绝，只对以 interrupted 结束的 stream 保留未决 tool，并让 cache-miss L2 与 L1 tail 返回同一 transcript；v203 修复跨水位部分结算 tool 的 transcript fold：原始全量 History 仍先执行 batch、transition 和 tool identity 校验，随后正文 projection fold 移除 tool lifecycle event、assistant toolCalls 与 role=tool body；L1/L2 对拍只比较正文/稳定身份，tool execution state 继续由原始 History validator 和消息骨架读取；v204 增加成功 `tool-call-finished` 结果与另一个未决工具跨水位并存的 L1/L2 等价测试；v205 将 terminal success 与嵌套 result success 的一致性纳入完整 History tool transition 校验，矛盾状态在 canonical-only L1/L2 均 fail closed；v206 进一步要求带 approval 的 tool-call-started/finished 只能发生在同一 toolCallId 的 approval-resolved 明确批准之后，deny/timeout/unavailable/cancelled 后的伪造 dispatch 在 L1/L2 均 fail closed；v207 红测进一步复现先 `tool-call-started` 再 approval-waiting/denied 仍可通过的逆序流，canonical validator 现在要求 approval wait 只能关联尚未 dispatch 的 proposal。v208 红测发现仅有 proposal、缺少 `tool-call-started` 仍可写入成功 `tool-call-finished`；canonical transition validator 现要求成功/失败执行结果必须对应 started 状态。修复同时校正 v204 跨水位成功结果 fixture，按 SDK 真实顺序加入 start 事件。v209 红测复现富元数据 approval-waiting/resolved 缺少 toolCallId 时，随后 tool proposal 与 started 仍通过；canonical transition validator 现在记录未绑定 approval，若同一 invocation 出现 tool proposal 则 fail closed；approval 在 proposal 之后且缺工具身份时也直接拒绝。v210 红测发现不同 toolCallId 可重复使用同一 approvalId 并分别完成批准与 dispatch；validator 现要求 invocation 内 approvalId 唯一，且将无 toolCallId 的富审批身份也纳入唯一集合。v210 五文件聚焦 449 项通过；v211 对同一代码完成全量 suite：858 文件通过/1 跳过（8,063 项通过/106 项跳过，303.51 秒），Electron build、`git diff --check` 通过。v212 红测复现 invocation-parked 后追加 event：SDK writer 会拒绝，但 canonical-only cache-miss L2 曾接受。根因是 SDK transition 关闭流集合漏列 parked；加入后 SQLite reader 复用的全量 validator 同样拒绝，SDK writer 和 L2 都 fail closed。保留 parked recovery 为 interrupted 的既有语义，不扩大到其他终态或恢复筛选。SDK transition、L1/L2 projection、History 聚焦三文件 308 项通过；Electron build、`git diff --check` 通过；完整 suite 858 文件通过/1 跳过（8,064 项通过/106 项跳过，281.91 秒）。最终快照聚焦复跑 308 项通过；性能 p95：1200 条搜索 7.74ms、多 spill L1/search 13.18/12.76ms、720 条/3 会话/60 命中 cold-L1 8.45ms。v213 扩展 cached-terminal 后追加矩阵至 completed/failed/interrupted/cancelled/parked 五种状态；红测发现只有 parked 在 L1 水位前、late event 在 tail 时曾被忽略。L1 的 terminal-before-tail 查询现在包含 parked，并触发完整 invocation 状态校验；L1/L2 五状态矩阵通过，History 三文件聚焦 312 项通过；Electron build、diff check 通过；完整 suite 858 文件通过/1 跳过（8,068 项通过/106 项跳过，281.64 秒）。聚焦 p95：1200 条搜索 7.53ms、多 spill L1/search 13.34/12.72ms、720 条/3 会话/60 命中 cold-L1 8.22ms。搜索预算已接受；生产分布性能评审与 rollback floor 仍待通过。聚焦负载 p95：1200 条搜索 8.07ms、多 spill L1/search 13.43/13.91ms、720 条/3 会话/60 命中 cold-L1 8.33ms。renderer/shared/agent-sdk typecheck 与 i18n/strict i18n 本轮未重跑；搜索预算已接受；生产分布评审仍 pending |
| 尚未完成 | Phase 5.5 读点与清理门禁 | 搜索预算 p95 ≤20 ms 已接受（见评审包），三类本机自动性能回归均低于门槛。v241–v244 已补齐 allocator/History 关键故障组合；停写及按 session 可恢复清理协议已在隔离测试库完成红绿测试与重开演练，尚未接入真实数据调用。生产设备分布测量转为发布后观测，不阻断项目内开发。唯一保留的清列前硬门禁是：先构建并发布兼容当前 schema 的 rollback floor，并按独立审计在 disposable file-backed DB 验证 canonical-only/reopen、spill 故障 fail-closed 与 v46 allocator 完整性；未通过前不得对真实用户数据停写或清理 `messages.content` |

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

### 8.8 Phase 5：已认证正文投影化实施契约（v33 设计复评通过，按门禁实施）

本阶段的可交付目标是：对**逐会话认证通过**的消息，展示及 API context 从 canonical History 读取可重建正文，并在回滚窗口结束后停止 `messages` 正文双写。`messages` 表和每一条消息骨架始终存在；“纯投影”仅指获批迁移的正文列，不指整行、整表或所有 `Message` 字段可丢弃。未认证历史会话、无稳定身份消息及未封口的流式消息继续 legacy。Phase 5 不删除 `turns`、队列、accepted context 或 transcript 协议表，也不凭推断补造旧消息身份。

#### 8.8.1 `messages` 逐列所有权及引用

原有权威骨架为 15 列；v38 仅新增第 16 列 `content_storage_state` 作为正文保存状态显式标记。以下矩阵覆盖原有 15 列及该新增状态列。“认证”均要求同一 session generation、稳定 message ID、role、顺序、正文及完整 L2 fold 对拍；单独有 canonical 事件或展示页命中不构成认证。

| 列 | Phase 5 所有权与处置 | 清空/重建边界 |
| --- | --- | --- |
| `id`、`session_id` | 权威骨架；canonical ID 只作一致性校验 | 永不清空；重建正文不能 INSERT/DELETE 骨架 |
| `role` | 骨架权威，用于 API 资格及控制流；与 canonical role 必须相等 | 不迁移；不匹配撤销资格 |
| `sequence` | 骨架权威，负责分页、boundary、排队消息移序及 turn 用户锚点 | 不从 `session_seq` 推导；保留空洞，不重编号 |
| `status` | 骨架权威；`queued`/`streaming`/`failed`/`sent` 等是逐消息状态 | 不从 invocation terminal 推断 |
| `images_delivered_to_api` | 投递状态权威 | 不从 image block 推断 |
| `attachments` | 用户文件名、源路径、暂存引用等骨架权威 | image block 不足以重建；保留原写读 |
| `skill_hints` | 展示/控制元数据权威 | 非空保留；空集合按 codec 既有语义处理 |
| `tool_use`、`tool_calls` | 当前 DB codec 与工具状态的权威副本；canonical 仅可覆盖已逐字段证明的子字段（如完整 result） | 整列暂不清空；工具状态、风险级别及脱敏格式须逐字段证明后另行变更 |
| `thinking`、`content_segments` | 当前展示/结构化内容副本，映射未完整定稿 | 暂保留；不得只因 `content` 对拍通过而清空 |
| `content` | **唯一首批物理去冗余候选**：已封口且逐会话认证通过时 canonical 完整正文为真相源；流式、排队、失败待修复与旧历史仍由 legacy 承载 | schema 允许空值/显式投影标记、API context 切换和回滚窗口门禁全通过后，才按 session 分批移除冗余副本 |
| `content_storage_state`（v38） | 显式区分 `legacy`、`canonical-backed-dual-write`、`canonical-backed-only`；不根据 `content=''` 推断来源 | v38 迁移将旧行初始化为 `legacy`；5.4/5.5 才允许在对应门禁后改变状态 |
| `schema_version` | 骨架/codec 版本权威 | 保留，避免旧行反序列化语义变化 |
| `timestamp` | 骨架权威；canonical 时间戳参与认证 | 不以事件提交时间替代 |

表内外键消费者必须保持：`turns.assistant_message_id` 使用 `ON DELETE CASCADE`，`turns.user_message_id` 与 `queue_input_requests.queued_message_id` 使用 `ON DELETE SET NULL`；因此禁止以 DELETE/INSERT 或整表重建模拟投影刷新，否则会删除 turn 或清掉队列引用。`accepted_turn_contexts`、执行队列及其它通过 turn/message ID 查询的控制面继续使用同一骨架 ID。投影清空操作只作用于 `canonical_session_projection_cache` 或新正文缓存，不触碰 `messages` 的行、`id`、`sequence`、状态和外键。删除会话仍由现有 `deleteSession` 统一清理，不能单独删除消息以回收正文空间。

`sessions.message_count` 与 `messages` 行数保持原语义：新增骨架时在同事务增量维护，合法删除排队消息时重算；清理正文缓存不改变计数、会话 preview、scope version 或队列状态。`preview` 现由 `appendMessage` / 删除路径从正文生成，Phase 5 必须在原子写入时用完整正文更新，或从 canonical 严格读取后更新；不能从已清空的 `messages.content` 推出空 preview。按 sequence 排序的搜索、分页和用户消息锚点仍基于骨架；若未来要迁移这些字段，需先设计新的幂等事实、同事务提交与恢复协议，再另行评审，不在本阶段隐含迁移。

#### 8.8.2 API context 独立读契约

`loadAcceptedTurnMessages` 现在经 `getTurnContext` 装配冻结的 accepted turn，随后用 `session-input-committed` 指纹验证必需用户消息（含附件）；新入口必须保留这一调用顺序与错误语义。候选实现应拆为**同一骨架选择器**和**正文解析器**：前者在同一 SQLite 快照中按照现有 `getTurnContext` 规则读取 `messages.sequence <= contextBoundarySequence`，补入边界外但属于该 session、role 为 user 的 `requiredUserMessageId`，先拒绝它出现在 `excludeMessageIds`，再应用 `isMessageEligibleForChatApi`（只接收 user/assistant，排除 queued/streaming）、排除集合、assistant 所关联 turn 至少一个 terminal 的规则；排序键仍是用户 turn 锚点/原 sequence、user 优先、message ID。必要消息不存在或过滤后不合格，继续抛原有 `TURN_REQUIRED_USER_INVALID` / `TURN_REQUIRED_USER_EXCLUDED`。不得用显示页的页内集合、canonical `session_seq` 或无限制 `readSessionTranscriptProjection` 直接代替此选择器。

正文解析器仅对**选择器得到的 ID**从同一 generation 的 canonical 全会话折叠/可信缓存中按 ID 取 `content`；严格核验 ID、role、timestamp、折叠连续性/水位与 spill SHA-256，不能把同文本不同 ID 的消息合并。`status`、`sequence`、附件、工具/技能/图片投递字段保持骨架 codec 结果，尤其附件不能从 image block 猜测。输出 `Message[]` 的顺序、字段（含 undefined 与空集合规范化）及 `queueInputFingerprint` 与旧路径逐字段、正文逐字节相同。任何缺失、篡改、generation 变化或不确定终态均 fail closed：仍有完整 legacy 副本时回退原 `getTurnContext`；副本已物理移除时禁止把空文或占位送给模型，报明确的 canonical 内容不可用/需 reconcile 错误并阻止 turn 开始。`readSessionTranscript` 的 ready 门禁、accepted-turn 冻结及指纹校验继续执行。

API context 使用**独立资格**（v38 `canonical_session_api_context_eligibility`，含 session/generation、已认证 canonical 水位、骨架 revision/消息变更序号、验证时间与协议版本）；Phase 2 的 `canonical_session_projection_eligibility` 只证明展示正文资格，不得直接放行 API。5.2 保持新旧 API 结果影子对拍，并记录仅含 session/字段名/哈希的差异；对拍相等只形成该 session 进入 5.3 认证的候选证据，不写入 API eligibility，也不切换读路径。shadow `matched` 只覆盖传入的 boundary/required-user/exclude 所选 API context；由于 eligibility 按 session 保存，5.3 必须在同一快照证明该 session 所有可能进入 API context 的 eligible skeleton 都有稳定 canonical identity/body 和所需顺序证据。只要仍有未映射的 eligible legacy 行，该 session 就保持 legacy；不能用一次被 boundary/exclude 缩窄的 context 匹配授予全 session 资格。5.3 才能在同一个 SQLite 快照中重新执行完整 L2 与 API 对拍，核验 generation、骨架 revision 和 canonical 水位，并原子持久化 eligibility 与启用该 session 的新读路径；这样避免对拍后并发消息编辑、移序或删除造成 TOCTOU。v38 触发器在 mutation 后撤销两类资格并把已切到 canonical 的读模式改为 `revalidation-required`，保留写/清理阶段，供后续按消息 storage state 决定安全回退或 fail closed。旧会话覆盖统计 0/335 identity/body candidates，默认不认证；所有不合格会话长期走 legacy。新入队消息、流式 checkpoint、编辑、附件改动、queue 移序和直接 SQL 写入必须撤销两类资格，待完整 L2 + API 对拍后才能重新认证。

#### 8.8.2.1 turn 准备路由与 `reuse-user` 正文读取（v32 重审 B4）

`agentProtocolIpc.prepareTurnInternal` 在模型请求前调用 `getRecentTurnRoutingMessages` 生成 `skillManager.route.recentMessages`，`reuse-user` 则以 `getMessage(...).content` 作为 `userInput`。这两条读点不经过 API context，必须作为 5.5 的独立正文消费者验收。路由入口与 API context 共用按 `(session_id, generation, message_id)` 严格解析正文的底层能力，但保留各自筛选与输出契约；不得借用展示页或 API context 的结果集合。

最近路由消息的骨架筛选保持现有 SQL 语义：同 session、`sequence <= contextBoundarySequence`、排除 `excludeMessageIds`、role 只取 user/assistant、status 排除 queued/streaming；有 turn 关联的 assistant 至少一个 turn 为 terminal。排序保持用户消息的最小 assistant `sequence` 锚点（无锚点用自身 sequence）、相同锚点下 user 优先、再按 ID；从完整合格且非空正文集合的尾部取 50（或调用方 limit）条，然后恢复升序传给 `skillManager.route`。现有 `TRIM(m.content) != ''` 必须移到严格正文解析之后、执行 limit 之前：不能先取 50 个骨架再丢空文，否则早一条本应入选的消息会丢失。可按排序键分页扫描，直到取得 limit 条非空消息或穷尽候选；在一致快照内保留原 `TRIM` 非空判定。返回值继续仅含 `{role, content}`，正文逐字节不做 trim。`hasVisionInTurnRoutingContext` 仍以骨架附件判断，不能因正文迁移改变 boundary/exclude/turn 资格。

`reuse-user` 在同一会话校验 `intent.userMessageId` 对应的 user 骨架、原有 turn 准备准入/指纹条件及附件；只把取 `userInput` 的 `content` 改为按 ID 严格解析。`create-user` 仍以本次 `intent.input.text` 为输入。复用消息无 canonical 身份、正文缺失、spill 校验失败、水位失配、generation 改变或在路由前被并发修改时：完整 legacy 副本尚在的会话按旧读路径回退；已清除副本的会话在调用 `skillManager.route` 前失败并阻止 turn 继续，不能以空字符串、缺项或旧缓存继续。一次 turn 准备应在一致快照内取得路由列表、复用输入、附件标记及资格水位；跨 `await` 的路由结果落入持久化配置前需再次核对 generation/骨架变更序号，失效时取消本次配置并走既有失败/重试路径，不把过期路由结果用于该 turn。

5.0 必须记录最近消息路由（含顺序与 50 条窗口边缘）、`reuse-user` 输入、附件/vision 标记的旧路径基线；5.2 对完整 `skillManager.route` 入参做影子对拍，逐字段和正文逐字节相等且差异数为 0，形成该消费者可进入 5.3 认证/切换的候选证据，但结果只覆盖本次 boundary/exclude/50 条窗口及 reuse-user 输入，不代表全 session 所有后续路由候选均可解析；不在 5.2 授予持久 cutover 资格或改变用户读路径。5.3 才将路由与 API context 的读开关共同纳入逐 session fence；由于资格按 session 保存，启用前必须确认所有可能被路由窗口或 reuse-user 选中的骨架正文均有 canonical 映射，否则该 session 继续 legacy；资格授予与读切换在同一快照核验 generation、revision 和水位后原子提交；5.5 的“全部读点”清单必须显式包含 `getRecentTurnRoutingMessages` 和 `reuse-user` 的 `getMessage(...).content`，两者及搜索/导出/preview/恢复均已切换后才允许清列。故障测试须在清除真实旧正文后再启动新一轮 turn：验证最近路由列表、复用用户输入及 vision 标记与基线一致；再注入缺失/篡改 canonical 正文、空文窗口边界、取消/并发编辑和跨重启，证明错误会阻断路由而不静默缺项。

#### 8.8.3 迁移、回滚与故障边界

| 顺序 | 实施及可中断边界 | 进入下一步的门禁 |
| --- | --- | --- |
| 5.0 测量与红测 | **完成**：冻结原 15 列/外键消费者清单并记录旧路径基线；路由窗口/正文/顺序/附件 vision、reuse-user route 入参及 accepted context 指纹 oracle 已覆盖 | oracle 可识别路由窗口缺项及 ID/sequence/附件/required-user 错误；数据库、prepare-turn IPC、accepted context 联合 113 项通过 |
| 5.1 additive schema | **完成**：v38 新增 API eligibility fence、逐 session `api_read_mode/write_mode/cleanup_state/message_revision`、逐消息 `content_storage_state`；generation 和消息 INSERT/UPDATE/DELETE 触发器同事务推进 revision、canonical 读降为 `revalidation-required`，并删除展示/API 资格。所有行仍保留完整 legacy 正文 | v37 升级与重跑幂等；注入 migration DDL 冲突后版本/列/表回滚并可重试；旧正文原样可读；真实空正文可与 storage state 区分；FK 检查/级联通过。全量 npm test、类型检查、build、i18n 通过，可进入 5.2 |
| 5.2 双写与影子双读 | **完成**：完整 API `Message[]` 和 `skillManager.route` 入参逐字段对拍、差异数为零；History 首次 context/assistant response/terminal 写入与 checkpoint/receipt 原子双写，故障、spill、cache、重启、混合状态及 turn 配置围栏均有红绿回归。保留 `messages.content` 与 legacy 用户读路径，不授予持久 eligibility | API、route/reuse-user、accepted-input fingerprint、附件/vision、队列和 FK/计数/preview 不变量通过；30 组配对 p95 在 `legacy ×2 + 5 ms` 与 50 ms 门禁内；全量套件及类型/build/i18n/diff 复验通过，可进入 5.3 |
| 5.3 逐会话读切换 | **完成**：全量 API context 与无边界完整路由候选同快照逐 session 对拍；原子授予 generation + message revision + canonical watermark eligibility 并 seed cache。默认关闭的 `config.sessionStorageCanonicalApiRead` 放行已认证 session 的 accepted API context 与 turn route/reuse-user；每次核验 generation/revision/watermark/cache，cache 缺失先撤销再 L2 重认证。v41 对 History event INSERT/UPDATE/DELETE、stream 归属更新/删除直接撤销资格；message trigger、History 水位变化、异步路由后 fence、跨 DB reopen 均有测试。读取不再每次重复扫描 legacy 正文；1200 条基准 p95 legacy 4.23 ms / canonical 7.01 ms，限值 13.46 ms / 50 ms | 同机同库 30 组预热配对 p95 满足 `legacy ×2 + 5 ms` 与 50 ms；关闭/不合格 session 继续 legacy；History/消息直接写入、cache/reopen、异步 mutation 均不误放行；全量 npm test（858 文件通过/1 跳过，7915 项通过/106 跳过）、类型/build/i18n/diff 复验通过，可进入 5.4 的写权威设计与 TDD |
| 5.4 切换正文写入权威 | **完成**：逐 session 门禁核验当前 read eligibility / generation / revision / watermark 与 L2 cache 一致，且所有 message 均 sealed 并与 canonical transcript 按 stable ID/role/body/timestamp 精确对应；同事务切换 `write_mode='canonical'` 与 `canonical-backed-dual-write`，完整保留 `messages.content`。History sealed context/required-user/assistant/terminal 镜像在 append 事务内原子双写；canonical-backed 编辑追加完整 canonical context + terminal，由 watermark fence 拒绝陈旧快照；通用 `updateMessageContent` 的正文变更在 canonical 模式 fail closed，metadata 更新仍可用。覆盖迁移/镜像/编辑故障回滚、drift 拒绝、kill switch、重入、reopen 和真实 IPC。联合 294 项、全量 858 文件/7926 测试、类型/build/i18n/diff 全通过。**只完成写权威切换；旧正文副本仍完整保留** | 5.4 门禁通过，可进入 5.5 的独立准备/评审；5.5 仍须证明 API、路由与 `reuse-user`、搜索、导出、preview、恢复/清理等全部读点兼容 canonical-backed，建立回滚版本地板、停写协议和按 session 可恢复清理证据；未满足前不得清理任何 `messages.content` |
| 5.5 停写副本并物理回收 | **实现/隔离验收完成**：全部正文读点采用 canonical-aware reader；持久化迁移状态 `retained → write-stopped → pending → complete`；write-stopped 检查活动引用与完整 canonical 对照，pending 按 session 有界清理，支持失败记账、断点续跑、reopen 终验。隔离测试库验证通过，尚未连接真实用户数据调用。生产设备分布测量作为发布后观测与复核项，不阻断项目内开发 | 本机自动性能回归 p95 ≤20 ms、整体响应上限 50 ms；隔离文件 SQLite 故障/恢复与 reopen 验收通过。**真实数据停写/清列前唯一外部硬门禁**：发布兼容当前 schema、理解 canonical-backed-only 且具备 fail-closed reader 的 rollback floor；使用 disposable file-backed DB 完成独立审计列出的 canonical-only/reopen、spill 故障、backup/restore 与 v46 allocator 配对/未配对验证并保留发布产物。上线后再按遥测复核慢设备/冷缓存/真实规模分布，作为运营优化和后续发布决策输入 |

#### 8.8.4 Phase 5.5 正文读取点审计（实现与隔离验收完成；真实数据停写/清列待发布门禁）

逐读点迁移前先把目前的真实调用面列全。状态“legacy 阻断”表示该消费者目前可直接看到 `messages.content`，不能对 `canonical-backed-only` 安全；“canonical projection”只表示正文取值已具备 canonical 路径，不自动证明其它骨架字段可丢弃。

| 消费者/入口 | 当前证据 | 5.5 状态与要求 |
| --- | --- | --- |
| 聊天展示/分页 | `agentProtocolIpc` 的 `chat:get-messages`/session transcript 调用 `getProjectedChatMessagePage`、`readSessionTranscriptProjection`；legacy 行骨架与 canonical stable ID/body 合并 | **已有 canonical projection**；canonical-only 清列/空 cache L2、source spill 缺失/篡改及文件 DB reopen fail-closed 已覆盖；最终清列协议仍待 gate |
| accepted API context | `acceptedTurnContext` 调用 `readCanonicalApiContextIfEligible`；未授权/不合格仍回退 `getTurnContext` | **已有逐 session canonical read**；canonical-backed-only 下缺失/篡改正文阻止模型请求，legacy read mode 保留旧读路径；accepted-input fingerprint 漂移与 owner 漂移均在真实 consumer 路径 fail-closed。剩余门禁是兼容发布回滚地板与清理协议，不是 API 正文读取覆盖 |
| 技能路由与 `reuse-user` | route 列表先用 `getRecentTurnRoutingMessageSkeletons` 保留原 50 条窗口/边界/exclude 选择，再由 `getProjectedRecentTurnRoutingMessages` 一次解析 canonical-backed 正文；`reuse-user` 通过 `getProjectedMessage` 解析后经 canonical route candidate 的同快照 fence | route/reuse-user **已有 canonical 路径**；真实文件 SQLite `chat:prepare-turn` 覆盖 canonical-only/reopen 的复用正文、完整历史窗口和附件/vision；正文缺失、并发 await mutation revision fence、L1 miss 下持久 accepted-input fingerprint 漂移均在返回正文/调用路由前 fail-closed。Hosted canonical-only/reopen 覆盖 completed/failed/cancelled/timed-out/interrupted；terminal display IPC 覆盖 canonical-only/reopen 与畸形 History。History 的部分流、spill、水位、generation/cursor、终态顺序和 invocation 状态转移矩阵均由后续 v144–v213 投影/cache L1/L2 回归覆盖；清列门禁仍待外部评审、回滚地板和可恢复清理协议 |
| 搜索 | 聊天内 corpus IPC 改用 `getProjectedSearchCorpusPage`；global `search:execute` 改用 `searchProjectedMessages`，SQL 先筛 profile/ownership 与 legacy LIKE/canonical-backed 候选；legacy 命中直接沿用 SQL 结果，canonical transcript 正文使用内存字面子串匹配，保留 SQLite LIKE 的 ASCII-only 大小写规则及 query 对 `%`、`_`、反斜杠的转义语义 | **功能与 reopen/L2 已有真实 SQLite 覆盖**：字面 LIKE 转义、混合结果排序/limit、缺 canonical fail-closed 均通过；1200 条 canonical-backed-only 会话、无命中查询的 full-suite p95 为 legacy 0.19 ms / canonical 8.02 ms；已接受预算 canonical p95 ≤20ms（完整扫描工作负载；v175 优化后 multi-spill 搜索 full-suite p95 为 15.50ms），保留整体 50ms 响应红线。多会话大命中集补充测试：720 条 canonical-only、3 会话、命中 60 条，每轮删除 L1 transcript cache 并经至少 3 次 L2 重建，30 次 p95 8.84ms（full-suite load）。20 轮 40 条、每条 83.6 KB spill 的 multi-spill search p95 首次发现 20.14ms 超门槛；v175 优化后 focused/full-suite p95 分别为 15.21/15.50ms，均通过 20ms 自动门禁。以上均为本机/暖 OS SQLite 文件缓存的数据库路径数据，不代表慢设备、冷 OS 缓存或 IPC/renderer 延迟。预算评审已于 2026-10-03 记录 Accepted（见 [评审包](../review/2026-10-03-session-storage-global-search-budget-review.md)）；生产设备分布测量转为发布后观测；清列前兼容回滚 floor 仍须发布并验证，真实数据停写/清列保持锁定 |
| 大会话读取与导出 | `getProjectedMessagesPageWithSequence` 包装 sequence 分页；文件 SQLite 测试验证 canonical-only、cache miss、reopen 后两页正文与 cursor 连续，`action.session.read` 真实 handler 验证 canonical-only 清列后的 sequence 跨页；自动 backup 的真实 `backupPageReader` 已接入 `SessionBackupManager`，生成 `messages.json` 后 restore 逐字段核验 canonical 正文。`main.ts` shutdown backup 同样读取 projected sequence page | **canonical-backed 分页、capability、自动备份产物及 shutdown 专属 flush 失败重试均有真实 SQLite/文件覆盖**；生产 raw 消费点已分类（见下两行）；停写状态协议及逐 session 可恢复清理已在隔离测试库完成红绿测试与重开演练；v224–v225 增加每批清理前的 source spill 完整性与全局 commit cursor 连续性核验。兼容发布地板和生产分布性能仍待完成，故门禁未过 |
| `getMessage` 单条读及其消费者 | `getProjectedMessage` 接入 reuse-user、Hosted restart-input、turn coordinator replay/recovery、agentProtocol/main startup recovery 与 canonical message patch 返回；`getProjectedMessages` 接入远程/管家无持久 turn 上下文、title suggestion、retention projection preparer。生产 raw `getMessage/getMessages` 调用已核对：operations 的 receipt/get-next-queue 只读 queued legacy 消息；`recoverPersistedTurn` 与 startup orphan shell cleanup 只取 failed/streaming/active 行的工具状态或 process owner 元数据；`finalizeResidueMessageKeepingOutcome` 仅接受 streaming 行。孤儿 shell cleanup 的文件 SQLite canonical-only/reopen 测试确认 owner identity 保存在权威骨架且正文不参与决策。raw `resolveRetryContext` 只由 canonical-aware wrapper 调用，projection/cutover/shadow 的 legacy 全读用于对拍及保留副本回退 | **用户正文读取均有 canonical-aware 路径；保留中的 raw control reads 被 queued/streaming/active 状态限定或只消费骨架元数据**；用例覆盖 queue receipt、recovery、retry 与孤儿进程 cleanup；canonical-only 空正文下六种 recovery outcome 均保持 History 正文并收敛骨架状态。Hosted restart accepted-input 已验证 canonical-only、L1 缓存删除及后续 History mirror 不复活旧正文；真实文件 SQLite/reopen 下 Hosted failure terminal checkpoint 也已验收；terminal watermark event 删除后 reopen fail-closed（L1 cache 已认证）与 terminal/context 顺序重排后 L2 fail-closed 均已覆盖（projection 回归）；event session 归属被直接 SQL 改写时 v42 trigger 会即时删除 transcript cache，L2 检出 event/stream owner 不符后 fail-closed；History stream 被重绑定时 v42 trigger 同样清除旧/新 owner cache，旧 owner 的 canonical-only L2 fail-closed；不以“无其它直接消费者”替代全量门禁 |
| 重试、恢复、accepted input | `resolveProjectedRetryContext` 先按 turn/sequence 选择骨架再解析 user/failed assistant；`getProjectedTurnContext` 保留 accepted context 的旧 boundary/required-user/exclude/order 选择并在持久指纹比较前解析正文；Hosted、coordinator 和 startup recovery 已使用单条 canonical-aware reader | **所列主流程已有 canonical 路径**；真实 SQLite/reopen 下 History 删除/顺序、cache terminal payload 篡改、terminal 后追加同 invocation 事件、generation/watermark/cursor 漂移与 L1/L2 invocation 状态不一致均有 fail-closed 回归（至 v244）；v241–v244 另覆盖暖 L1 的 unpaired allocator 失败关闭及 v45→v46 迁移重建损坏 marker。生产 `recoverPersistedTurn` 与 raw context 消费者已逐项分类；停写状态协议和逐 session 清理已在隔离测试库完成红绿与 reopen 演练。当前剩余门禁为真实生产分布性能证据与已发布兼容 rollback floor |
| 会话 preview 与队列移序/删除 | `appendMessage` 从输入更新 preview；canonical History 镜像在同一事务内仅当更新目标为最后 sequence 时按完整 canonical 正文更新 preview；queued 删除和移序用 canonical-aware resolver 重算。队列移序/编辑目标仍限 queued legacy 行，sequence 和状态来自骨架 | **正文 preview 写入/删除已兼容 canonical-backed**；History 最后消息编辑、canonical-only queued 删除成功路径及删除/移序/queued 编辑时 preview 解析或写入失败的事务回滚均通过；canonical-only 最后 assistant 行存在时 queued 移序也保留正确 preview；消息、receipt/fingerprint、preview、eligibility 和 sequence 保持一致。其余 5.5 实现/隔离测试已完成；真实生产分布与已发布兼容回滚地板仍未通过，故不启用停写/清列 |
| 其它 raw 单条/批量/路由候选读 | 生产调用复核：真实 prepare-turn 使用 `getProjectedRecentTurnRoutingMessages`；raw `getRecentTurnRoutingMessages`/`getTurnContext` 只用于清列前认证与 shadow 对拍。queue receipt 的 raw `getMessage` 只读取仍保留 legacy 正文的 queued 行；startup `listStreamingAssistantMessages`/`listRecoverableResidues` 限定 streaming，`recoverPersistedTurn` 对 failed/streaming assistant 读取 tool-call 状态，canonical success/outcome 从 History 解析；retry raw selector 仅由 projected wrapper 调用。远程/管家/title/retention 使用 `getProjectedMessages`，outbound admission 使用 skeleton | **生产调用面已分类；未发现用户正文读取绕过 canonical resolver**。控制恢复依赖的状态、工具调用、队列 receipt 仍在 message skeleton/legacy queued 行中；各 canonical-backed-only 正文消费者的对应故障回归已在上方列明。当前阻断为兼容回滚版本地板与生产分布性能验证；统一停写协议和逐 session 可恢复清理已在隔离测试库演练，生产尚未启用 |

生产正文读取调用面已完成分类：展示、API、技能 route/reuse-user、搜索、导出、重试/恢复、preview 均有 canonical-aware reader；保留的 raw 读取用于 legacy 资格认证、queued 正文回执或 streaming/failed 状态与控制元数据，不作为 canonical-backed-only 正文来源。canonical-only transcript/chat、单条/批量/sequence/search 分页、accepted input、重试、global/chat search 与 20 轮 multi-spill 均有清空正文测试；cache miss 的 History L2、retention projection、Hosted/coordinator/startup recovery、远程/管家上下文、title suggestion、outbound skeleton、自动备份及 preview 已接线。sequence reader、capability、backup restore、真实 prepare-turn、Hosted outcome、shutdown backup retry、preview 故障回滚及 Hosted/coordinator owner-corruption recovery 均有真实 SQLite/文件回归；raw 用户正文读点已逐项分类。v144–v244 补齐 History terminal order/status/transition、L1 tail/cache/L2 跨水位校验及全局 allocator 完整性。搜索预算已 Accepted（canonical DB path p95 ≤20 ms、端到端 ≤50 ms）；停写状态协议与逐 session 可恢复清理的实现/隔离演练已完成。项目内 5.5 读点和清理协议实现/隔离验收已完成。真实设备/数据分布测量是发布后观测与复核项，不作为继续开发或完成本阶段的前置条件。唯一尚未满足的真实数据停写/清列门禁是已发布兼容 rollback floor：发布产物需通过独立审计列出的 disposable file-backed DB 验证后，才能启用真实数据停写。

兼容 schema 方案在 5.1 的具体选择必须能表示 `content` 的“仍有 legacy 副本”和“由 canonical-backed”两态：当前列是 `TEXT NOT NULL`，因此不能直接写 NULL；用空字符串代替会混淆真实空消息。若采用新影子表/重建表，必须以外键安全迁移证明不触发 `turns` 级联删除或 `queued_message_id` 置空，并在单个 schema version 事务内完成；否则保持旧列和副本，5.5 不放行。禁止在 rollout 中删除旧列、旧读路径或投影失效触发器。

5.5 清理状态协议（v44 起）固定为 `retained → write-stopped → pending → complete`，状态只由显式事务推进，不以空正文推断阶段。进入 `write-stopped` 时必须在同一 SQLite 事务撤销 API/projection eligibility、把 API read mode 设为 `revalidation-required`，并 fence 当前 generation/revision/watermark；此状态阻止重新认证和启用 5.4 写权威，并由 SQLite trigger 拒绝新增消息及正文变更、直接 History event INSERT/UPDATE/DELETE 和 stream 归属/删除变更，History append 入口也拒绝新增事件，直到受控清理流程显式推进。`pending` 表示该 session 可恢复清理，不表示所有消息均可删；每批只清除逐行认证为 `canonical-backed-dual-write` 且 sealed 的 `content`，保留 message 行、ID、sequence、状态、附件和外键。批次游标与已清数量需与该事务原子提交；中断从最后已提交游标继续。任何状态或 watermark/revision 不匹配都停止当前 session 并保留余下正文；完成后先 reopen 再全量逐字段对拍，最后才置 `complete`。v44 状态机现在由事务 API 进入 write-stopped；直接 SQL 新增消息/改正文由 SQLite trigger 拒绝，History append 也拒绝事件写入；write-stopped 建立 generation/message revision/History watermark 进度账本，pending CAS 会复核无活动 turn、完整 transcript/cache 和逐消息 sealed 双写正文。SQLite 拒绝无匹配 ledger 的 pending 转移、无终验证据或仍有 legacy 正文/非 only storage state 的 complete 转移。红测覆盖 History 镜像、queued insert、直接 History 修改与直接状态跳转。有界 `clearNextSessionMessageContentBatch` 按 `(sequence,id)` 游标、逐批 canonical L1 水位/正文核验，并确认持久 cursor 与 canonical-backed-only 行恰好构成完整前缀；在单事务提交正文清空、storage state、cursor 与计数；失败在独立事务持久记录该 session 的 attempts/last_error，故障注入证明正文与 cursor 整批回滚且错误可见。重开后 `verifyAndCompleteSessionMessageContentCleanup` 对拍 canonical ID/role/body/timestamp、骨架/preview/count、turn/queue 引用与 FK 清单后才置 complete。API 尚无生产调用点；v219 在真实文件测试库验证两个 pending session 的故障隔离：一个 session 的批次事务失败不改变其正文、游标或另一个 session 的进度；健康 session 可先独立清理、reopen 并完成，故障 session 在持久错误记账后单独重试并终验。v222 另以真实文件 SQLite 覆盖清理批次后关闭 API read 开关并 reopen，accepted turn 仍通过 canonical projection 读取原文且指纹匹配，说明 kill switch 不会将已清理正文降级为空 legacy。清理仍未接入生产，生产数据未触碰。搜索预算 p95 ≤20 ms 已接受；生产分布、兼容回滚 floor 等其余门禁仍未过，因此没有 production caller/worker 自动调度。

回滚分两级：5.1–5.3 关闭读开关即可在下一次读取回到旧路径，资格 fence 作废，schema 保留 additive 部分；5.4 因继续双写完整 legacy 副本，可在窗口内关闭读开关回退。5.5 一旦物理清除副本，旧二进制/旧读路径不能再读取该 session；需先按 §8.8.5 制作并发布可验证的回滚版本地板、记录已回收 session 清单与 schema 版本，并证明目标回滚二进制能严格读 canonical-backed，才允许回收。若做不到，不执行 5.5。任何清理失败只重试当前 session，不改变其骨架、资格和其它 session。用户显式删除 pending/complete session 仍走统一 `deleteSession`：同一事务先删除 cutover 与 cleanup progress fence，再删除 canonical History 与 session；session FK 级联移除其余子行，故障时整笔事务回滚。不得将 pending→retained 作为一般可逆状态转移。

#### 8.8.5 兼容回滚版本的制作与发布流程（本地预检通过；候选固定与发布待实施）

**采用两次发布：先发布兼容版本 R，再发布清理版本 C。** R 从本次重构通过验收的代码基线制作，包含当前 schema、canonical-only 读写保护与故障恢复能力，但不启用真实数据停写/清列；C 在 R 之后接入受控清理入口。R 是 C 的最低允许回滚版本（rollback floor），不是从 `v0.2.2` 仅修改 schema 常量得到的旧版。本文中的 R/C 是发布角色，实际版本号由发布时确定；本节是实施计划，不代表已有兼容安装包或清理授权。

**本地预检记录（2026-10-04）**：当前 worktree 的 R 相关聚焦回归 6 文件/372 项通过；完整 `npm test -- --reporter=dot` 为 858 文件通过、1 跳过，8,109 项通过、106 项跳过；`npm run build`、renderer/shared/agent-sdk typecheck、i18n 与 strict i18n 均通过，`git diff --check` 通过。strict i18n 检出的 1,154 处硬编码中文均在测试文件，源码为 0。源码引用核对确认四个清理事务 API 未从真实 profile 的启动、IPC、定时任务或 worker 调用。由于当前 worktree 尚有未提交改动，本记录仅是开发预检：不替代 §8.8.5.A 的审阅/固定提交，也不替代 §8.8.5.B 要求的 clean checkout、`npm ci`、安装包构建与降级演练。

##### A. 固定代码与数据兼容边界

1. 整理并提交当前 worktree 的重构代码、测试及必要依赖，按仓库流程评审并合入 main，固定候选 commit SHA；不能直接把未提交工作区打包当作 R。推荐以完整已验收基线制作 R，避免向 schema 19 的旧代码逐项回移时遗漏 reader、trigger 或 SDK validator。
2. R 必须携带 `electron/database/schema.ts`、`migrations.ts` 的完整迁移链（当前到 v46）、History storage/SDK validator、`sessionTranscriptProjection`、正文写权威与 cutover fence、source spill 读写/GC、所有 §8.8.4 正文消费者及启动恢复接线。依赖按调用闭包保留，不能只复制 projection 文件。旧 profile 升级到 R 后仍保留 legacy 正文及双写，不启动清理。
3. R/C 固定相同的数据兼容契约：DB schema、History event kind/payload 与 stream version、spill locator/codec/checksum、cache codec 和 cleanup ledger 状态。即使 schema 数字相同，C 新增 R 不理解的事件或 spill 编码也视为不兼容。C 若需要 schema >46 或新增持久格式，必须先更新并重新发布/验证 R，再开放清理；不得绕过 newer-schema 拒绝检查。
4. R 保留 `markSessionMessageContentWriteStopped`、`beginSessionMessageContentCleanup`、`clearNextSessionMessageContentBatch`、`verifyAndCompleteSessionMessageContentCleanup` 的协议支持及测试，但不从启动、IPC、定时任务或 worker 对真实 profile 调用它们。发布检查记录调用点；仅靠默认关闭且容易误开的配置不能替代入口审计。R 打开 C 遗留的 write-stopped/pending/complete 时保留账本和写围栏，不自动继续清列、不把状态改回 retained，也不回填已清正文。
5. 分别定义“可读恢复”和“恢复写入”：R 必须能展示、搜索、导出已清会话并保持恢复/准入安全；当前 complete 状态仍禁止正文/History 写入，不能承诺这些会话立即继续对话。需要继续工作时使用正常新会话；若 C 的产品目标要求在已清会话中继续写入，必须先另行设计并在 R/C 共同实现受控解除围栏协议、同事务不变量和 reopen 测试，再放行 C。不得用移除 trigger 或手工 SQL 重置状态代替该协议。

##### B. 构建候选包并完成两种验收

先在干净 checkout 安装依赖并完成以下检查，记录命令、commit SHA、环境与结果；失败按具体用例修复后重新制作候选包：

```sh
npm ci
npx vitest run electron/database/migrations.sessionContentCutover.test.ts electron/runtime/sessionStorageCutover.test.ts electron/runtime/sessionTranscriptProjection.test.ts electron/runtime/sqliteAgentHistory.test.ts
npm test
npm run typecheck:renderer
npm run typecheck:shared
npm run typecheck:agent-sdk
npm run i18n:check
npm run i18n:check:strict
npm run build
git diff --check
```

安装包按平台执行 `npm run pack:mac` / `npm run pack:win`，并通过仓库既有签名及打包资源检查。当前 `.github/workflows/release.yml` 对 `v*` tag 触发发布且要求 tag commit 位于 main；因此 R 要经过 main 合入与正式 tag 发布，不能仅保留分支或本地 `dist-electron`。单元测试验证协议，**安装后的 R 二进制**验证真正的回滚能力，两者均必需。

| 演练 | 制作输入与操作 | 必须通过的结果 |
| --- | --- | --- |
| 旧 profile → R | 在停止原应用后制作独立 profile 副本，包含 DB 及必要 sidecar、source spill 和配置；用 R 安装包启动并升级 | schema 迁移到目标版本，legacy 正文/消息身份、附件、turn/queue 不丢失；不发生真实停写或清列；退出后重新启动结果相同 |
| R → C → R | 在隔离 profile 用 R 建立基线；由 C 的实际清理实现生成 write-stopped、部分 pending、complete 及 legacy 混合状态；完整退出 C 后替换为 R 安装包，使用同一隔离 profile 启动 | R 打开 C 写出的精确 schema 与格式；各状态均可识别，已清正文从 History 严格解析；不重写 schema、不回填旧正文、不推进清理；账本、骨架、preview/count、FK 与 turn/queue 不变量保持 |
| 全正文消费者 | 在上一条清列后的 profile，实际调用展示/分页、API context、路由/reuse-user、搜索、导出/backup/restore、重试和恢复入口；覆盖 inline/multi-spill、真实空正文、附件/vision、终态/未决工作 | 有效读请求与清列前 oracle 逐字段/顺序、正文逐字节一致；处于写围栏的调用明确拒绝且无副作用，不能以绕过围栏的测试宣称可继续对话 |
| 冷启动与开关 | 清空可丢弃投影缓存后重启 R；另保留暖缓存重启；关闭 API read 开关后再重启 | L1/L2 结果一致；canonical-only 不因开关关闭而回退为空 legacy；source spill 完整性不能被 cache hit 遮蔽 |
| 故障隔离 | 每种故障使用独立副本：缺失/篡改 History 或 source spill、owner/水位漂移、v46 allocator 正常配对与未配对/损坏 marker；覆盖 v45→v46 升级重建 | 健康数据可读；损坏会话 fail closed，不发送模型请求、不静默返回空正文、不破坏健康会话恢复；R 保留损坏证据而不擅自修复真相源 |
| 再升级 | 完整退出 R 后在同一隔离 profile 重新安装 C | schema、清理进度与已清前缀保持；C 重新验证 fence 后才可受控续跑 pending，不重复清列或跳过未清消息 |

数据库副本必须一致：应用完全退出后复制完整 profile，或使用一致性备份并配套 source spill 快照；不能运行中只复制主 `.db` 而漏掉 WAL 中的已提交数据。演练不得连接原 profile、真实模型/远程发送或生产清理调度。备份 JSON 的 round-trip 验收与完整 profile 降级演练分别记录，JSON 导出不能充当流程状态及 source spill 的完整灾备。

##### C. 发布证据与 C 的放行条件

发布负责人在[回滚审计件](../review/2026-10-03-session-storage-rollback-floor-audit.md)追加验证记录，并归档以下材料；表中的标识必须替换为实际值，不能仅填“测试通过”：

| 证据 | 必填内容 |
| --- | --- |
| R 身份与产物 | release/tag、commit SHA、应用版本、目标 OS/架构、下载位置、安装包 SHA-256、签名/安装验证结果；可长期下载的安装包和配套恢复说明 |
| 数据契约 | 精确 schema（当前 46）、History/spill/cache 格式与 cleanup 状态支持范围、适用 C 的 commit/tag；记录 complete 的写入限制 |
| 演练记录 | 隔离 fixture 的来源/构造脚本或步骤、匿名化情况、DB 与 spill manifest 摘要、清列前 oracle、清列后的 session 状态/清单、测试输出与 R 安装包重启结果 |
| 放行结论 | 验证人、日期、通过/失败项、对应产物摘要；原审计 No-go 仅在证据齐全后更新，不能因本节补充而改为通过 |

顺序固定为：**R 验收 → R 正式发布且产物可取回 → 用发布产物复验 C→R → 审计放行 → C 发布并启用受控清理**。C 的生产入口应核对经审核的 R/C 兼容记录及部署允许清理配置，缺少证据或版本/摘要不匹配时保持停写/清列关闭；这是待实现的发布门禁，不是当前已存在的自动校验。保留安装包本身，不能只保留易失的 CI artifact 或源码 tag。新增 OS/架构须补该目标的安装包演练后才在该目标启用清理。

##### C.1 正式版本上线：执行会话存储迁移计划

将[会话存储重构迁移计划](./session-storage-refactor-migration-plan.md)纳入正式版本发布清单，作为真实用户 profile 的迁移执行与证据台账。**准备和演练在上线前完成；schema migration 在用户首次启动升级版本时执行；投影懒迁移与后台补迁在上线后推进；停写/清列及物理回收单独放行。** 开发期实现完成不等于用户数据已迁移，发布记录按任务 ID 关联已有实现证据，再记录本次生产执行范围及结果。

| 发布时点 | 对应迁移任务 | 执行与放行要求 |
| --- | --- | --- |
| R 正式上线前 | M0 基线；M1/M2 实现及升级、回滚演练；§5 发布记录 | 固定支持升级的 schema 范围、匿名化 fixture、完整 profile 备份/恢复证据及 legacy 例外；按 §8.8.5 完成 R 安装包验收，填逐项台账。未支持的桥接/批迁明确记为待办或发布范围外，不整体标完成 |
| R/C 用户升级首次启动 | M1 schema、修复待办及初次分类；§4 升级/中断矩阵 | 运行完整幂等 schema migration；历史分类按持久游标推进，恢复模式遵守完成条件。失败保留已提交步骤并可重启续跑；不把历史全量折叠、正文清理或 vacuum 放入一次阻塞启动 |
| R 上线后的正常读取与观察 | M2 懒迁移/双读；M3 eligible 会话补迁；M4-2 观察 | 按 eligibility 为访问会话构建投影；后台补迁仅在实现与验收齐备后开启，保证可暂停和不阻塞活跃 turn；legacy_required 保持可读。归档真实版本的差异、恢复及性能观测，生产设备分布测量仍是发布后观测项 |
| C 启用真实停写/清列前 | §8.8.5.C 回滚 floor 门禁；M4-4/M4-5 体积基线与归因准备 | R 已发布并用正式产物复验通过；发布审计放行后，C 只对逐 session 认证通过且无活动引用的正文副本执行清理。M3 全量完成、所有 legacy reader 退役均不是单个合格 session 清列的替代条件 |
| C 清理后的独立维护窗口 | M4-7…M4-9 空间回收、收益复测与安全验证 | 在无活跃 turn 的受控窗口做 checkpoint/空间回收，记录实际 DB/WAL/spill 字节与启动分段耗时；旧 transcript、流程表及旧读路径退役另行设计，不能随正文清理一并删除 |

迁移计划中的早期 canonical→legacy 桥接任务仅适用于清列前且 reader/schema 兼容的独立方案；清列后以兼容 R 回滚为准，不重建已清 legacy 正文。发布负责人将迁移计划 §5 的任务台账、升级范围/异常清单及观测结果与本节 R/C 发布证据一起归档。首次正式上线不承诺所有旧会话已经迁完，也不因发布成功自动启用清理。

##### D. 实际回滚操作与后续维护

C 出现问题时先关闭生产清理调度并让在途事务结束，完整退出进程，制作当时 DB + source spill + 配置的一致性灾备副本，记录清理 session/进度；随后安装已验证的 R，保留同一 profile 与 schema，按 B 的关键读点复核后恢复使用。pending 保持暂停；已清 session 继续 canonical-aware 读取并遵守写围栏。回滚不能退到低于 R 的版本，不能恢复旧 schema、删除 History 或以旧备份覆盖近期数据；只有 canonical 真相源损坏时才进入单独的灾备恢复决策，备份恢复不是无损版本回滚。

R 的发布并不要求每台设备先安装 R：设备可以直接升级到 C，但 C 必须具备相同完整迁移链，并对“旧 profile 直接升级到 C，再安装 R”补演练。之后任何 schema/History/spill 格式变化均重新核定回滚地板；旧 R 不再兼容时先发布新的 R，保留历史产物供匹配版本恢复。清理入口接入、发布门禁及已清会话恢复写入（如需要）各自保留待办与验收记录，不能被“已有 canonical-only 单元测试”一项替代。

#### 8.8.6 TDD 与退出指标

每步先做最小 red/green 聚焦测试，再跑数据库/Hosted IPC/恢复联合回归；最后执行 `npm test`、renderer/shared/agent-sdk typecheck、Electron 构建、i18n 检查与 `git diff --check`。必须覆盖：同/异 ID 及同文本冲突、sequence 空洞/移序、required user 越界及排除、user 锚点排序、assistant 多 turn 终态、queued/streaming/failed/重试、消息编辑与附件改动、无 canonical 身份的旧会话、source spill 缺失/篡改、cache 清空重建、generation 重建、资格授予时并发写、迁移中断和 DB reopen、5.4 每个提交点故障注入，以及 5.5 清列后的技能路由/reuse-user 和外键/计数/preview/搜索/队列不变量。特别将 Phase 2 的 `messages` INSERT/UPDATE/DELETE 触发器失效用例在新 schema 下重跑，并加入绕过应用层的直接 SQL 写入。

退出必须同时满足：影子 API context 在所有合格样本中 `Message[]` 全字段/顺序相等；turn 路由的 `recentMessages` 顺序和 `{role, content}`、复用 `userInput`、附件/vision 与旧路径相等；三者的正文逐字节、错误码及指纹结果相等，**差异数为 0**；不合格会话全部使用 legacy；清空并重建投影后结果不变；故障和跨重启不误放行；`PRAGMA foreign_key_check` 无新违规且 turn/queue 引用、`sessions.message_count`/preview 与基线一致。性能以同机同库至少 30 组预热后配对采样，API context p95 不高于 legacy p95 ×2 + 5 ms，且不能突破 Phase 2 的 50 ms 回归门禁；展示 warm page 继续满足 Phase 2 门禁。记录样本规模、通过/跳过数与设备条件。独立设计评审通过只准开始 5.0；任一门禁失败即停在上一可回滚步骤，不能用通过率替代逐 session 完整认证。

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

| **v162（canonical-only 终态镜像不得复活旧正文）** | 红测证明终态 assistant mirror 会将 `canonical-backed-only` 行已清空的 `messages.content` 重写为 canonical 正文，并错误降级为 `canonical-backed-dual-write`。终态 SQL 现保留该行正文与 storage state，只推进 status；普通双写终态路径保持原行为。聚焦测试 2 项通过；六文件联测 276 项通过；完整 `npm test -- --reporter=dot` 为 858 文件通过、1 跳过（7,999 项通过、106 项跳过）；renderer/shared/agent-sdk 类型检查、Electron build、i18n 与 strict i18n、`git diff --check` 均通过。此修复防止清理后的副本被终态提交复活，但不构成停写或清列授权；独立搜索预算评审仍 pending，回滚发布地板与完整可恢复清理协议仍未闭合 |

| **v163（canonical-only 流式 assistant 镜像不得复活旧正文）** | 红测证明 `model-response-committed` 的 streaming assistant mirror 会重新写入 `canonical-backed-only` 行的 `messages.content`，虽 storage state 不变仍复活旧副本。现 SQL 对该状态保留既有空正文，History event 与消息状态流程照常提交；普通 streaming legacy mirror 不变。六文件交叉回归 277 项通过，Electron incremental build 与 `git diff --check` 通过。完整 npm test/type/build/i18n 复验是在 v163 修改之前刚完成；此处追加定向联合回归。停写/清列仍受搜索预算评审、回滚版本地板及可恢复清理协议门控 |

| **v164（L1 invocation turn identity 跨水位校验）** | 红测构造已缓存 canonical transcript 后追加 session/stream sequence 正确但 `turn_id` 偏离前缀的单条 `approval-updated` 非 transcript 事件。旧 L1 因该 kind 不影响 transcript 而跳过，错误接受；L2 会从完整 History 拒绝同一 invocation 的 turn identity 不一致。现在 `isCanonicalSessionInvocationTailValid` 聚合检查全 stream `COUNT(DISTINCT turn_id)=1`，不读取历史 payload 即保持 L1/L2 一致。七文件联合回归 303 项通过；Electron incremental build、agent-sdk typecheck 与 `git diff --check` 通过。停写/清列仍锁定，其他 History 故障矩阵及外部评审/回滚/清理门禁尚未闭合 |

| **v165（v163–v164 当前代码全量回归）** | v163 canonical-only 流式 assistant 镜像保护与 v164 L1 invocation turn identity 校验后，完整 `npm test -- --reporter=dot` 通过：858 文件通过、1 个跳过；8,001 项通过、106 项跳过。renderer/shared/agent-sdk 类型检查、完整 Electron build、i18n 与 strict i18n、`git diff --check` 均通过；strict i18n 提示的 1,154 条中文均位于测试文件，命令成功退出。搜索预算独立评审仍 pending；该回归不改变 5.5 停写/清列门控 |

| **v166（global search 多会话大命中集冷 L1 测量补充）** | 新增 720 条 canonical-backed-only 消息、3 个真实文件 SQLite 会话、全局命中 60 条的基准；每轮采样先删除所有 transcript L1 cache，再由 History L2 重建至少三个会话 transcript。聚焦 30 样本 p95 为 8.60 ms，完整 `sessionTranscriptProjection.test.ts` 60/60 通过（复测该项 8.08 ms）；`git diff --check` 通过。该测试冷的是 transcript L1，不清 OS/SQLite 文件缓存，也不代表慢设备或 IPC/renderer 端到端测量。数据及边界已补入独立预算评审包；评审决定仍 pending，停写/清列不解锁 |

| **v167（History event session 归属变更 cache 失效与 L2 拒绝）** | 文件 SQLite 故障注入在 canonical-only transcript L1 命中后，直接把 History event 的 `session_id` 改为另一个会话。断言 v42 UPDATE trigger 即时删除 transcript cache，后续 L2 因 event/stream owner 不一致抛 `CANONICAL_SESSION_CONTENT_UNAVAILABLE`，旧 `messages.content` 仍为空。完整 `sessionTranscriptProjection.test.ts` 61/61 通过；搜索基准复测 p95 8.18 ms；未发现需修改生产代码的缺陷。此矩阵只覆盖 event owner 更新，其他 History 状态及清理 gate 仍未闭合 |

| **v168（History stream session 重绑定 cache 失效与 L2 拒绝）** | 文件 SQLite 故障注入在 canonical-only transcript L1 命中后，直接把 `agent_history_streams.session_id` 改绑到另一个会话（event 自身 owner 未改）。v42 stream-owner UPDATE trigger 即时删除旧 session transcript cache；旧 session L2 随后抛 `CANONICAL_SESSION_CONTENT_UNAVAILABLE`，旧消息正文仍为空。新增聚焦用例通过；与 v167 event-owner 更新矩阵互补，其他 History 状态与清理 gate 仍未闭合 |

| **v169（terminal History 顺序错乱 fail-closed）** | canonical-only transcript L1 命中后通过直接 SQL 将 terminal event 与 context event 的 invocation sequence 对调（使用临时 sequence 避免主键冲突），关闭数据库并重新打开后读取。断言 UPDATE 触发器即时清除 transcript cache，L2 因 History 序号/终态顺序不一致抛 `CANONICAL_SESSION_CONTENT_UNAVAILABLE`，旧正文仍为空。新增聚焦用例通过；terminal 删除、payload 篡改、terminal 后追加已有独立覆盖。History/projection/cutover/shadow/agent-sdk 七文件联合回归 440/440 通过；projection 完整文件 63/63 通过。其余畸形 History/cursor 与清理 gate 仍未闭合 |

| **v170（accepted-turn owner 漂移 fail-closed）** | 在 `loadAcceptedTurnMessages` 真实消费路径中建立 accepted-input + canonical transcript，清空 user message legacy 正文并切到 canonical-backed-only，再直接改写 context event 的 session owner。验证 consumer 抛 `CANONICAL_SESSION_CONTENT_UNAVAILABLE` 而非吞掉投影错误后回退为空正文，数据库行仍保持空值与 canonical-backed-only 状态。该文件 10/10 通过，History/projection/cutover/shadow/accepted-turn/agent-sdk 八文件联合回归 450/450 通过；History owner/canonical-only projection 已有 v167/v168/v169 联合覆盖。仍需按矩阵验证其它 accepted/recovery failure 及全部 Phase 5.5 gates |

| **v171（History event owner 更新撤销 API eligibility）** | 在已认证 canonical API read fence 的 session 上，直接把 event `session_id` 改绑到其它 session。SQLite v41 trigger 将 `api_read_mode` 改为 `revalidation-required` 并删除持久 eligibility；重复读取无法重新认证错绑 History，5.4 保留的完整 legacy 正文仍可安全回退。`sessionStorageCutover.test.ts` 20/20 通过。此项覆盖 History event owner 更新；canonical-only consumer fail-closed 已由 v167/v170 覆盖。History/projection/cutover/shadow/accepted-turn/agent-sdk 八文件联合回归 451/451 通过；其它读点与故障 gate 仍未闭合 |
| **v172（readSync History event owner 核验与 recovery 防串 session）** | 红测在 executing turn 的 completed History terminal 上直接把 event `session_id` 改绑到另一会话，复现 coordinator recovery 仍将跨 session `outputText` 当作成功并覆盖当前 assistant。`readSync` 现读取每条 event 的 `session_id` 并要求与 stream owner 一致；不一致抛 `HistoryCorruptionError`，recovery 拒绝 canonical success 并以本 turn 的 partial body 收敛为 failed/recovered。同步修正三处直接 SQL 插入的旧恢复夹具，为 event 填充当前 schema 的 owner。History/projection/cutover/shadow/accepted-turn/turn coordinator/agent-sdk 九文件联合 487/487 通过；`npm run build:electron` 通过。根 `tsconfig.json` 的裸 `tsc` 会纳入大量既有 test setup 类型错误，非有效 Electron gate；使用项目 `tsconfig.electron.json` 构建验证。搜索预算与其它 Phase 5.5 gates 仍未闭合 |
| **v173（Hosted 最近 invocation 读取检测 event owner 错绑）** | Hosted restart canonical-only fixture 直接把 prior completed invocation 的 terminal event `session_id` 改绑到 foreign session，并清空该 event 的 session cursor 字段，确认错误数据从原 session 的事件列表消失。红测驱动 `listInvocationIdsForSession` 在枚举前校验 session-owned stream 的每条 event 归属；任何缺失/错绑 owner 抛 `HistoryCorruptionError`，Hosted 不调用模型并 fail closed。新增 Hosted 定向用例通过；`hostedTurnHandoff.test.ts` + `sqliteAgentHistory.test.ts` 214/214 通过。其它 History 状态矩阵与 Phase 5.5 gates 仍未闭合 |
| **v174（文件库 reopen 后 session cursor 双向漂移拒绝陈旧 cache）** | 对同一真实文件 SQLite 会话先写 canonical context 并生成 transcript L1 cache，close/reopen 后分别注入 session cursor 超前（event_count + 1）和落后（-1）故障。两种情况下 L1 均不得命中，L2 完整校验返回 unavailable，不能把缓存 transcript 当作当前会话状态；`sqliteAgentHistory.test.ts` 全文件 171/171 通过，`git diff --check` 通过。该用例补 cursor drift/reopen 矩阵，不替代 generation 与 watermark 故障组合及其它 Phase 5.5 gate |
| **v175（canonical global search multi-spill p95 回归修复）** | 完整相关回归首次采样发现 20 轮 × 40 条、每条 83.6 KB source spill 的 canonical 搜索 p95 为 20.14 ms，略高于现有 20 ms 自动门禁。定位到已由 SQLite 过滤过的 legacy 正文还会重复执行 LIKE，canonical 正文则逐条跨 SQLite 绑定大字符串；现在 legacy 候选跳过重复 LIKE，canonical 候选用保持 SQLite LIKE ASCII-only case fold 与已转义字面 query 语义的内存匹配。新增 ASCII 大小写、非 ASCII `Ä/ä`、`%`、`_`、反斜杠对照。聚焦搜索及完整 20 ms multi-spill 测试通过；projection/History/Hosted 联合回归 279 项通过；multi-spill L1/search 最新 p95 15.43/15.21 ms，`npm run build:electron` 与 `git diff --check` 通过。生产负载评审和独立预算决策仍 pending |
| **v176（History owner corruption 不得中断 coordinator startup recovery）** | 完整 npm suite 首次发现 v173 的 `listInvocationIdsForSession` owner 一致性错误会直接从 `recoverTurn` 枚举阶段抛出，阻断整个 coordinator recovery。将枚举纳入既有 `HistoryCorruptionError` 处理范围，损坏 History 不再授权 completed 成功，并收敛该 unfinished turn 的 partial assistant 为 failed/recovered；其余 turn 恢复继续。recovery owner-mismatch 与 Hosted detached-event owner 两条定向用例通过；完整 `npm test -- --reporter=dot`：858 文件通过、1 跳过（8,012 通过、106 跳过）；全量负载下 1200-row search p95 8.02 ms、multi-spill L1/search 16.27/15.50 ms、720-row multi-session cold-L1 8.84 ms；`npm run build:electron` 与 `git diff --check` 通过。独立搜索预算及生产分布评审、回滚版本地板与 5.5 停写/清理 gate 仍未完成 |
| **v177（Phase 5.5 读点状态与搜索语义文档对齐）** | 对照 v176 代码和 full-suite 证据复核 §8.8.4：preview、raw 读点分类、terminal display、recovery owner 错绑及 canonical-only cache/spill reopen 用例已完成，删除过期“待逐项审计”状态；v175 canonical 搜索已从逐条 SQLite 大正文 LIKE 改为内存字面匹配，文档改为准确描述 SQLite LIKE 兼容语义。评审包和技术方案同步更新为 full-suite p95：1200-row 8.02ms、multi-spill search 15.50ms/L1 16.27ms、720-row multi-session 8.84ms。停写/清列仍受搜索独立评审、回滚发布地板与可恢复清理协议门控 |
| **v178（source-truth spill GC 状态与实现对齐）** | 审核 §5.8.1 与 v108/v112 实现及用例：持久删除待办、跨进程 root fence、全量严格引用扫描、可续跑 orphan 分类、启动/周期维护和删除 IPC 唤醒，以及共享 locator、损坏引用、generation 删除竞态、unlink/fsync/完成标记失败和 reopen 重试均已落地。将“尚未接通/B5 未通过”修正为 source spill GC 实施门禁通过，并明确这不等于 `messages.content` 停写/清理放行；旧正文仍需独立性能评审和 rollback floor。此轮仅文档状态对齐，`git diff --check` 通过 |
| **v179（Phase 5.5 rollback floor 兼容性审计包）** | 对照已发布 `v0.2.2` 与当前 schema/readers，确认其 schema 19 低于当前 43、缺少 canonical transcript projection reader，且旧正文消费者直接读 `messages.content`；当前迁移器也会拒绝新 schema。新增独立审计件，列出兼容回滚发布的最低能力、验证场景和当前 no-go 状态。只整理证据，不发布构建、不授权停写或清理 |
| **v180（canonical-only History projection 损坏不得中断 turn recovery）** | 红测在 `createTurnCoordinatorStorage.recoverTurn` 中复现：先调用 `getProjectedMessage` 后再进入 `HistoryCorruptionError` 围栏，canonical-only 会话遇到 event owner 错绑时抛 `CANONICAL_SESSION_CONTENT_UNAVAILABLE`，阻断当前及后续启动恢复。移除仅用于 truthy 判断的正文投影读取；是否可认 completed 继续由持久 turn 身份与 canonical History terminal 决定，异常时现有 `recoverPersistedTurn` 只收敛当前 turn 状态、保留空 legacy 正文。新增真实 SQLite owner-drift + canonical-only 回归，先红后绿；相关 5 文件 224 项通过。完整 npm suite 858 文件通过/1 跳过（8,013 项通过/106 跳过），Electron build、renderer/shared/agent-sdk typecheck、i18n/strict i18n 与 diff check 通过；full-suite p95：1200-row search 7.73 ms、multi-spill L1/search 13.28/13.30 ms、720-row multi-session cold-L1 8.49 ms。**不改变搜索独立评审、生产分布评审、rollback floor 与旧正文清理门禁** |
| **v181（真实启动顺序下隔离损坏快照并继续恢复）** | 红测在生产式 startup 顺序中复现：`agentProtocolIpc` 先对活跃持久 turn 调 `getProjectedMessage` 恢复内存快照，owner 损坏的 canonical-only History 抛错，使 `turnCoordinator.recover()` 尚未运行就退出。新增 `restorePersistedTurnSnapshotsForStartup`：只捕获 `CANONICAL_SESSION_CONTENT_UNAVAILABLE`、跳过该不可投影快照并继续后续 durable recovery，其余异常照常传播；IPC 接入 helper。真实 SQLite owner-drift + canonical-only startup 回归先红后绿，并断言 durable turn 收敛且 legacy 正文仍空。聚焦 3 文件 96 项通过；全量 858 文件通过/1 跳过（8,014 项通过/106 跳过），Electron build、renderer/shared/agent-sdk typecheck 通过。完整 suite 性能样本：1200-row search 7.61 ms、multi-spill L1/search 14.64/15.95 ms、720-row multi-session cold-L1 8.23 ms。搜索预算独立评审、生产分布评审、rollback floor 与旧正文停写/清理 gate 保持 pending |
| **v182（启动快照恢复异常边界收窄）** | 新增红测：若快照恢复回调本身抛出 `CANONICAL_SESSION_CONTENT_UNAVAILABLE`，必须向上报告，不能被当作正文不可投影而跳过；原实现红测失败，随后把 catch 收窄到 `getProjectedMessage` 调用，回调在 try/catch 外执行。聚焦启动/turn coordinator/file IPC 3 文件 97 项通过；完整 suite 858 文件通过/1 跳过（8,015 项通过/106 跳过），Electron build、renderer/shared/agent-sdk typecheck、i18n/strict i18n 与 diff check 通过。strict i18n 共 1,154 条 hardcoded Chinese，全部位于 tests、source 为 0。full-suite p95：1200-row search 8.04 ms、multi-spill L1/search 16.86/13.64 ms、720-row multi-session cold-L1 9.32 ms。搜索预算独立评审、生产分布评审、rollback floor 与旧正文停写/清理 gate 保持 pending |
| **v183（坏 History session 不阻断后续健康 session 快照恢复）** | 扩展真实 SQLite startup recovery 用例：按 `created_at` 固定顺序，先遇到 owner 损坏且 canonical-only 的 executing turn，再遇到独立健康 session 的 executing turn；断言前者不调用内存 restore、后者仍被 restore，随后两条 durable turn 都收敛为 recovered。先将跳过逻辑故意改成退出当前状态列表，红测失败并显示健康 assistant 未恢复；恢复 `continue` 后聚焦 3 文件 97 项及全量 suite 858 文件/1 跳过（8,015 项/106 跳过）通过。生产代码无新改动；v182 build/typecheck/i18n 证据继续适用，`git diff --check` 复核通过。评审与 rollback floor、旧正文停写/清理 gate 仍 pending |
| **v184（terminal 下未完成 tool proposal 的读取侧故障矩阵）** | 在 canonical-only 投影测试的 watermark-tail 矩阵中加入 `model-response-committed` 声明 tool proposal 后直接追加 terminal 的状态；现有 reader 按预期拒绝并保持空 legacy 正文，证明读取侧重放不会把未完成 proposal 隐藏在缓存水位前。此前只有 durable append 写入层覆盖该状态。投影文件 64 项通过；全量 suite 858 文件通过/1 跳过（8,016 项通过/106 跳过）。full-suite p95：1200-row search 7.78 ms、multi-spill L1/search 12.83/13.35 ms；聚焦冷 L1 多 session 搜索 8.12 ms。此项仅补验证证据，不改变 5.5 清列 gate；独立评审、生产分布、rollback floor 与停写/清理仍 pending |
| **v185（terminal 拒绝水位前未完成 tool proposal）** | 扩展 canonical-only 文件/SQLite L1 tail 矩阵：`model-response-committed` tool proposal 先写入并成为已认证缓存水位，随后直接追加 terminal，清空 legacy 正文后读取必须 fail closed。缓存 seed 不含控制态，因此该用例验证 reader 会回查完整 invocation，而不是只验证尾批次。聚焦 projection 文件 65 项通过；全量 suite 858 文件通过/1 跳过（8,017 项通过/106 跳过）。full-suite p95：multi-spill L1/search 12.22/12.71 ms、720-row multi-session cold-L1 9.06 ms；该步骤仅补故障证据，不改变生产逻辑或清列授权，搜索预算/生产分布独立评审及 rollback floor 仍 pending |
| **v186（terminal 拒绝水位前未完成 approval）** | 增加 canonical-only 文件/SQLite 回归：`approval-waiting` 先于已认证 transcript L1 watermark，之后尾部追加 `invocation-completed`；读取必须 fail closed 且 legacy 正文保持空。此项把 approval 生命周期的 pending-state 与 tool proposal 一样纳入跨 watermark 读取侧检查。聚焦 projection 文件 66 项通过；全量 suite 858 文件通过/1 跳过（8,018 项通过/106 跳过）。full-suite p95：multi-spill L1/search 12.85/13.02 ms、720-row multi-session cold-L1 8.29 ms。搜索预算独立评审、生产分布评审、rollback floor 与停写/清理 gate 仍 pending |
| **v188（interrupted 保留水位前未决 tool proposal 的跨 watermark 读取）** | 在已认证 L1 watermark 之前写入未完成 `model-response-committed` tool proposal，清空 legacy 正文后于 cache tail 追加 `invocation-interrupted`；L1 读取仍返回 canonical transcript，旧列保持空，SDK recovery 状态仍为 interrupted。SDK 状态矩阵另覆盖 pending approval、proposal、dispatch-start。定向 History/projection 文件回归 96/96 通过；当轮全量 suite 858 文件通过、1 跳过（8,023 项通过、106 跳过）。生产设备评审、搜索预算、rollback floor 与停写/清理 gate 仍 pending |
| **v189（interrupted 保留水位前已 dispatch 未完成 tool 的 transcript）** | 将 proposal 先写入并跨过 L1 watermark，再写入对应 `tool-call-started` dispatch 事件并更新 watermark，cache tail 追加 `invocation-interrupted`。canonical-only L1 仍返回 transcript，旧正文保持空；proposal-only 与 started-dispatch 两个 SQLite 用例通过，相关 History/projection 测试 99/99 通过 |
| **v190（pending approval/tool proposal 遇到 failed terminal 时读取侧拒绝）** | 将水位前未决 approval 与 tool proposal 的 cache-tail terminal 矩阵扩展为 `invocation-completed`/`invocation-failed`：两类均由 canonical-only reader fail closed，legacy 正文仍为空。History/projection 两文件 99/99 通过；当轮 full suite 858 文件通过、1 跳过（8,026 项通过、106 项跳过） |
| **v191（started dispatch 遇到 completed/failed terminal 的跨水位拒绝）** | 将水位前工具状态扩展为 proposal 与 `tool-call-started` 两阶段，并分别追加 completed/failed terminal；四种组合均由 canonical-only reader fail closed，旧正文保持空。History/projection 两文件 101/101 通过；全量 suite 858 文件通过、1 跳过（8,028 项通过、106 项跳过） |
| **v192（interrupted dangling tool 的 L1/L2 读取语义一致）** | L1 tail 已接受终止于 `invocation-interrupted` 的未决 proposal/dispatch，但 cache-miss L2 被 `rebuildClaudeMessagesFromHistory` 的全局 dangling-tool 检查错误拒绝。新增红测后添加显式 `allowPendingToolCalls` 折叠选项，只对末事件为 interrupted 的 invocation 传入；completed/failed 仍按默认规则 fail closed。cache 删除后 L2 与 L1 transcript 相同、canonical-only legacy 正文仍为空。canonicalHistory/projection/sqliteAgentHistory/SDK History 四文件 292/292 通过，agent-sdk typecheck 与 Electron build 通过；全量 suite 858 文件通过、1 跳过（8,028 项通过、106 项跳过）。full-suite p95：1200-row search 7.82 ms、multi-spill L1/search 16.57/14.83 ms、720-row multi-session cold-L1 8.64 ms。独立搜索预算、生产设备评审、rollback floor 与停写/清理 gate 仍 pending |
| **v193（interrupted/cancelled 未决 tool 终态矩阵）** | 将 v192 的 cache-hit/cache-miss 回归扩展为 `invocation-interrupted` 的 `status=interrupted` 与 `status=cancelled` 两种合法 payload，分别覆盖水位前未决 proposal 与已 dispatch 未完成 tool。`sessionTranscriptProjection.test.ts` 全文件 75/75 通过；生产代码无变化，v192 全量 suite 与 Electron build/typecheck 结果仍适用于实现。外部搜索预算评审仍 pending，rollback floor 仍 no-go；不解锁停写/清列 |
| **v194（interrupted/cancelled 未决 approval 终态矩阵）** | 将跨水位未决 approval 用例参数化为 `invocation-interrupted` 的 `status=interrupted` 与 `status=cancelled`，验证 L1 tail 与删除缓存后的 L2 fold 均接受合法终态，并保留 canonical-only 正文空值。`sessionTranscriptProjection.test.ts` 全文件 76/76 通过；只扩展测试，v192 完整实现验证仍适用。外部搜索预算评审仍 pending，rollback floor 仍 no-go；不解锁停写/清列 |
| **v195（cancelled terminal 带未决工作时的 SDK recovery 状态）** | 将 SDK History recovery 矩阵扩展为 interrupted/cancelled terminal × pending approval/tool proposal/started dispatch 六种组合，确认即使终态 payload 为 cancelled，只要仍有未决 work，rebuild state 就保持 `interrupted`，且 lastEventId 指向未决工作；无未决工作时 cancelled 仍按原测试映射为 `cancelled`。SDK History 与 projection 两文件 107 项通过，agent-sdk typecheck 与 diff check 通过；本轮只加测试，无生产代码改动
| **v196（approval lifecycle 跨 L1 watermark 正常结算）** | 将有效 lifecycle 改为 watermark 前写入 approval-waiting，cache tail 写入 matching approval-resolved 与 invocation-completed；确认 L1 尾部从完整 invocation 读取 pending approval 状态并正常结算，删除 transcript cache 后 L2 fold 得到同一 transcript，canonical-only legacy 正文保持空。projection 与 SDK History 两文件联合 107 项通过，diff check 通过；仅扩展测试
| **v197（approval identity mismatch 跨 L1 watermark fail-closed）** | 在 cache watermark 前写入带完整身份元数据的 approval-waiting，随后直接 SQL 追加 approvalId 不匹配的 resolution 与 completed terminal；canonical-only L1 读取拒绝且不回退空 legacy 正文，删除 cache 后 L2 同样返回 unavailable。projection/sqliteAgentHistory/SDK History 三文件 279 项通过，diff check 通过；仅扩展故障测试
| **v198（跨 watermark approval resolution outcome 矩阵）** | 将 watermark 前 pending approval 的尾部 resolution 参数化为 approved、denied、timeout、unavailable、cancelled 五种合法 outcome，并校验 approved 布尔值与 outcome 配对；随后 completed terminal 在 L1 可读，删 cache 后 L2 transcript 相同且 legacy 正文仍为空。projection/sqliteAgentHistory/SDK History 三文件 283 项通过，diff check 通过
| **v199（跨 watermark approval resolution corruption 拒绝）** | 在同一 L1 watermark 前 pending approval 场景中参数化身份错配与 `approved=false/outcome=approved` 矛盾两种尾部 corruption；两者均使 canonical-only L1 fail closed，删除 cache 后 L2 仍 unavailable，legacy 正文保持空。projection/sqliteAgentHistory/SDK History 三文件 284 项通过，diff check 通过
| **v200（denied terminal 对未决 approval/tool 的跨水位拒绝）** | 将 pending approval 与 pending tool proposal/started dispatch 的 terminal tail 矩阵加入 `invocation-failed/status=denied`；三类状态均由 canonical-only L1 fail closed，旧正文为空。projection/sqliteAgentHistory/SDK History 三文件 287 项通过，diff check 通过；只扩展已有故障矩阵
| **v201（malformed approval 状态转移 L1/L2 拒绝矩阵）** | 为孤立/重复 approval transition 测试补齐非法 waiting metadata、approved/outcome 冲突和 settledAt 类型错误；每种畸形尾部均在保留 cache 的 L1 读取与删除 cache 后的 L2 fold 中 fail closed，旧正文保持空。projection/sqliteAgentHistory/SDK History 三文件 290 项通过，agent-sdk typecheck 与 diff check 通过
| **v202（并发 approval 跨水位部分结算）** | 水位前写入两个独立 approval-waiting，cache tail 只 resolution 其中一个并追加合法 interrupted terminal；验证未决的第二个 approval 不会被错误清除，L1 与 cache-miss L2 transcript 均 matched，canonical-only legacy 正文保持空。projection/sqliteAgentHistory/SDK History 三文件 291 项通过，agent-sdk typecheck 与 diff check 通过 |
| **v203（跨水位部分 tool result 的 L1/L2 transcript projection）** | 红测用真实 SQLite/清列尾部复现：多个 tool proposal 中，一个在 cache watermark 后产生 not-dispatched result，另一个保留未决并以 interrupted 收尾；旧 fold 把 tool result 视为无稳定 UI ID 的独立消息，cache-tail replay 又因 seed 缺少水位前 proposal 身份而失败。现完整原始 History 先做 batch/transition/tool identity 校验，再将投影限定为稳定正文消息；legacy 对拍不要求 transcript 重建工具执行态，工具状态仍由原始 History 校验和消息 skeleton 保持。projection 用例先红后绿；canonicalHistory/projection/sqliteAgentHistory/SDK History 四文件 312 项通过；`npm test -- --reporter=dot` 全量 858 文件通过、1 跳过（8,048 项通过、106 跳过）；renderer/shared/agent-sdk typecheck、Electron build、i18n/strict i18n 与 `git diff --check` 通过。全量负载下 global search p95 1200 rows=7.66 ms、20-round multi-spill L1/search=13.25/15.08 ms、720-row/3-session/60-match cold-L1=8.83 ms。搜索预算独立评审与 rollback floor 仍 pending |
| **v204（跨水位成功 tool result 与未决 tool 并存）** | 将 v203 的 not-dispatched result 场景扩展到成功 `tool-call-finished`：cache watermark 前有两个 proposal，tail 成功结算其一，另一个保持 calling 并以 interrupted 收尾；L1 与清 cache 后的 L2 transcript 相等，骨架保留 completed/calling 状态，canonical-only legacy 正文为空。先运行新增 focused 用例（1 项通过），再跑 canonicalHistory/projection/sqliteAgentHistory/SDK History 四文件 313 项通过；仅扩展测试，v203 的全量实现验证仍适用。搜索预算独立评审与 rollback floor 仍 pending |
| **v205（tool terminal/result success 一致性 fail-closed）** | 新增 canonical-only 跨 L1 watermark 故障测试：已 dispatch 工具的 `tool-call-finished.success=true`，其嵌套 `result.success=false`，旁边另有仍未决的工具并以 interrupted terminal 收尾。旧 History transition validator 只核验 proposal/result 身份，正文投影过滤了结果事件后仍将 L1/L2 判为 matched；新增校验复用既有 completed-tool 重建契约，要求 terminal success 为 boolean，若 result 含 success 则也必须为 boolean 且相等。新增红测先失败后通过，L1 与 cache-miss L2 都拒绝，旧正文维持空。canonicalHistory/projection/sqliteAgentHistory/SDK History 四文件 314 项通过；Electron build、全量 `npm test -- --reporter=dot`（858 文件通过、1 跳过；8,050 项通过、106 项跳过）与 diff check 通过。全量负载 p95：search 1200 rows=7.84 ms、multi-spill L1/search=14.60/12.96 ms、720-row/3-session cold-L1=8.28 ms。搜索预算独立评审与 rollback floor 仍 pending |
| **v206（approval 非批准结论后禁止 tool dispatch）** | 红测复现 approval-waiting → approval-resolved(`approved=false`) → tool-call-started 可通过 transcript History 校验；validator 现在将 approvalId/approved 与同一 toolCallId 关联，只有 approved=true 才接受 started/finished。deny、timeout、unavailable、cancelled 四种 producer outcome 均在 canonical-only L1 与 cache-miss L2 拒绝伪造 dispatch，旧正文保持为空；SDK 正常批准并 dispatch 的 turn 路径已有回归。四 outcome 专项 4 项、五文件聚焦 440 项通过；全量 858 文件通过/1 跳过，8,051 项通过/106 项跳过（281.53 秒）；Electron build、`git diff --check` 通过。全量负载 p95：1200 行搜索 7.76ms、多 spill L1/search 12.42/12.96ms、720 行/3 会话/60 命中 cold-L1 8.60ms。搜索独立评审与 rollback floor 仍 pending |
| **v207（approval wait 必须先于 tool dispatch）** | 红测复现逆序流：同一 tool proposal 先 `tool-call-started`，再 approval-waiting → denied resolution → tool-call-not-dispatched，原 validator 仍接受。canonical tool transition validator 现要求 approval-waiting 对应 pending 状态必须是 `proposed`，拒绝 dispatch 之后才补写审批流程的记录。红测先失败后通过；dispatch-before-denied 与 dispatch-after 四种非批准 outcome 专项 5 项、五文件聚焦 441 项、全量 8,055 项通过（858 文件通过/1 跳过，281.98 秒）；Electron build、`git diff --check` 通过。全量负载 p95：1200 行搜索 7.69ms、多 spill L1/search 13.37/14.89ms、720 行/3 会话/60 命中 cold-L1 8.44ms。搜索独立评审和 rollback floor 仍 pending |
| **v208（tool result 必须有 dispatch start）** | 红测复现仅有 model response proposal、没有 `tool-call-started` 却直接追加成功 `tool-call-finished` 时，canonical L1/L2 仍接受结果。validator 现在要求 `tool-call-finished` 的 pending 状态必须为 started；`tool-call-not-dispatched` 仍允许 proposed 或 started 状态收敛。红测先失败后通过；并修正 v204 成功结果跨水位 fixture，补齐真实 SDK 的 proposal → started → finished 顺序。五文件聚焦 446 项通过；全量 suite 8,060 项通过、106 项跳过（858 文件通过/1 跳过，281.25 秒）；Electron build、`git diff --check` 通过。全量负载 p95：1200 行搜索 7.75ms、多 spill L1/search 12.76/13.30ms、720 行/3 会话/60 命中 cold-L1 8.34ms。搜索独立评审和 rollback floor 仍 pending |
| **v209（approval/tool 关联身份缺失时 fail closed）** | 红测复现富元数据 approval-waiting 与 denied resolution 缺少 toolCallId、却紧接 tool proposal/start 时，通用 History validator 按 approvalId 结算，canonical tool validator 未建立关联，L1/L2 仍接受。新增关联规则：富审批 metadata 缺 toolCallId 且 invocation 有 pending tool proposal 时拒绝；若审批先出现，则保留 unbound approval 标记，在后续 model response 声明 tool proposal 时拒绝。两种顺序均有 canonical-only L1 watermark/cache-miss L2 回归，红测先失败后通过；五文件聚焦 448 项通过，全量 8,062 项通过/106 项跳过（858 文件通过/1 跳过，281.53 秒）；Electron build、`git diff --check` 通过。全量负载 p95：1200 行搜索 7.86ms、多 spill L1/search 13.39/13.23ms、720 行/3 会话/60 命中 cold-L1 8.25ms。搜索独立评审与 rollback floor 仍 pending |
| **v210（approvalId 在 invocation 内唯一）** | 红测复现两个不同 toolCallId 共用同一 approvalId，分别写入 approval-waiting/resolved 并成功 dispatch/finish 时 canonical L1 与 cache-miss L2 仍接受。validator 新增 invocation 级 `seenApprovalIds`，已绑定与无 toolCallId 的富审批 identity 均只能首次出现；重复身份 fail closed。红测先失败后通过；五文件聚焦 449 项通过；全量 8,063 项通过、106 项跳过（858 文件通过/1 跳过，303.51 秒）；Electron build、`git diff --check` 通过。聚焦性能 p95：1200 行搜索 8.07ms、多 spill L1/search 13.43/13.91ms、720 行/3 会话/60 命中 cold-L1 8.33ms。搜索独立评审和 rollback floor 仍 pending |
| **v214（Phase 5.5 write-stopped 状态 schema 与认证拒绝围栏）** | v213 后的计划步骤先建模可持久化停写状态，不触发生产停写或正文清理。v43→v44 additive migration 扩展 `cleanup_state`，保留并校验旧 session 状态；重建 session/message/History/cache 资格触发器。红测先因旧 CHECK 约束拒绝 `write-stopped`，随后修复；认证、API reader 与 5.4 写权威入口均拒绝该状态，正文仍完整。v44 中断/重试迁移、历史状态保留及触发器回归已覆盖；聚焦 cutover/migration 两文件 29 项通过。搜索预算、生产分布与 rollback floor 仍未过独立门禁。|
| **v238（complete 清理账本拒绝独立删除）** | v237 已拒绝 complete cleanup progress 的 UPDATE；新增真实 SQLite 红测发现单独 DELETE 仍可移除 proof。v45 增加 DELETE trigger；新增 `prepare_session_content_cleanup_for_session_delete` 在删除父 session 时先撤销 cutover fence 和 progress，故单独删账本 fail closed，而完整 session DELETE、统一 `deleteSession` 故障回滚与 spill GC 仍可用。覆盖 v43→45、明确 v44→45、重复迁移、v44 rebuild 重试及 complete 用户删除；cutover、operations、migration 与 GC 五文件 159 项通过。完整 `npm test -- --reporter=dot` 为 858 文件通过/1 跳过、8,105 项通过/106 项跳过（286.68 秒）；renderer/shared/agent-sdk typecheck、Electron build、i18n/strict i18n 与 `git diff --check` 通过。strict i18n 为 0 source、1,154 test-file occurrences。|
| **v239（启动孤儿清理只读消息骨架）** | Phase 5.5 正文读取面复核发现，启动 orphan cleanup 只消费 `toolCalls` 中的 shell PID/owner token，却注入 `getMessage` 读取整条正文。新增 `getMessageSkeleton`，SQL 将正文投影为空串；恢复依赖改用 skeleton，并更新 canonical-only 重启测试。`startupOrphanCleanup.test.ts` 与 `operations.test.ts` 聚焦回归 80/80 通过。搜索预算已记录 Accepted：canonical 搜索 DB path p95 ≤20 ms、整体响应 ≤50 ms；这关闭预算待评审项，不替代生产分布验收、兼容回滚发布地板及其他清理门禁。未执行生产停写或清列。|
| **v240（cutover fence 丢失后 canonical-only 正文仍不可改写）** | 红测复现直接删除 `session_message_content_cutover` 后，旧 `updateMessageContent` 因查不到 `write_mode` 而放行并改写 canonical-backed-only 正文。schema v46 在主 DDL 与 v45→v46 migration 增加 trigger，禁止 canonical-only 消息的正文或 storage state 转换；缺少 cutover row 时仍 fail closed。测试同时断言正文保持空值并覆盖直接 SQL 改 storage state。runtime cutover 与迁移、operations、orphan cleanup 聚焦 4 文件 145/145 通过；完整 `npm test -- --reporter=dot` 为 858 文件通过/1 跳过、8,107 项通过/106 项跳过。renderer/shared/agent-sdk typecheck、Electron incremental build、i18n/strict i18n 与 `git diff --check` 均通过；strict i18n 为 0 source、1,154 test-file occurrences。未启用生产停写或清列。|
| **v241（暖 L1 全局 History allocator 完整性围栏）** | 红测在保留已暖 transcript L1 的前提下插入未配对 allocator allocation，确认旧实现仍返回 canonical transcript。schema v46 新增 cursor integrity 状态与 pending allocation 表，migration 会先从旧数据重建 pending/invalid 状态；allocator INSERT 记账、匹配 event INSERT 同事务结算；L1 只做 O(1) 标记读取，异常转 L2 并通过全局连续性检查拒绝。cursor UPDATE/DELETE 标记永久损坏并撤销投影/API 资格；正常配对追加保留旧水位 cache 供尾部折叠。v46 迁移仅在表组完整时安装；版本回退重放旧 migration 前移除 v46 triggers，避免历史 schema rebuild 撞上新 trigger。4 文件聚焦 191/191 通过；全量 suite 858 文件通过/1 跳过，8,108 项通过/106 项跳过（292.72 秒）；renderer/shared/agent-sdk typecheck、Electron incremental build、i18n/strict i18n 与 `git diff --check` 通过。搜索预算已 Accepted，但生产分布、兼容回滚 floor 与清理门禁仍待完成；未启用停写或清列。|
| **v242（rollback floor 审计与 schema 46 对齐）** | 按当前 worktree/schema 46 复核本机被忽略的 rollback-floor audit：确认 v0.2.2 tag 的 schema version 为 19，且没有 transcript projection/write authority reader；版本降级校验拒绝 schema 46 profile。审计包现明确 schema 46 与 v46 allocator integrity fixture 要求。决策维持 No-go：兼容 rollback build 尚未构建/发布，停写和清列仍锁定。仅同步审计事实，不冒充发布验证或生产分布验收。`git diff --check` 通过。|
| **v243（History terminal 删除/顺序读点状态复核）** | 按 §8.8.4 当前 consumer 表逐项复核，发现 raw History terminal 删除/顺序一项仍标为“待验收”，但已有真实文件 SQLite 证据：认证 terminal watermark event 被删除后关闭并 reopen，canonical-only display fail-closed 且旧正文为空；context/terminal sequence 重排后 L1 cache 失效、L2 拒绝。将读点审计状态改为已覆盖，并保留原测试作为证据。仅对齐审计结论；这不替代生产设备分布或已发布 rollback-floor 验证。`git diff --check` 通过。|
| **v244（v45→v46 升级重建 allocator corruption marker）** | 新增迁移红测：先在 v46 状态建立孤立 allocator cursor，再模拟 v45 数据库（移除 v46 triggers/marker 表并回退 schema metadata），要求升级后将 cursor 放入 pending ledger 且 `invalid=1`。暂时去掉 backfill SQL 时测试按预期红（marker 错为 0）；恢复实现后通过，证明 v46 不会把升级前已存在的 cursor 漂移当成健康。`migrations.sessionContentCutover.test.ts` 与完整 projection 文件联合 122/122 通过；v244 复用 v241 最近全量 suite/build/typecheck/i18n 证据，因为本步只补 migration 回归与审计文档。当前仍无兼容回滚发布或生产分布数据，清理保持 No-go。|
| **v251（clean checkout 全量测试的 package 前置构建）** | R 候选 clean checkout 的首次全量 `npm test` 在 83 个 Electron 文件启动失败：`@spaceassistant/agent-provider-pi-ai` 使用未生成的 `dist/index.js`，775 个文件通过。根因是该 workspace package 仅被 Electron build 脚本构建，fresh `npm ci` 后直接测试缺少前置构建。新增 `pretest` 生命周期调用 `npm run build:agent-provider-pi-ai`，让计划要求的 clean checkout `npm test` 自举生成依赖入口；需要删除生成目录后从同一提交重新验证 `npm test` 及全套 clean-checkout 验收。|
| **v250（v46 旧迁移失败重试与 R 候选复验）** | 新增完整现行 schema 回退到 v40 后注入 v41 版本更新失败的红测。保留已存在的 v46 History allocator triggers 会使 v44 表重建引用暂缺表而令重试失败；现迁移前临时移除已存在的 v46 trigger，早期迁移失败时从静态 schema SQL 恢复，下一次启动可安全重放。迁移定向 29 项通过。第一次全量 suite 有一个配对性能样本越线（shadow 34.11ms，门槛 16.82ms）；单测复跑 9.74ms，通过；第二次全量 suite 858 文件通过/1 跳过、8,110 项通过/106 项跳过，shadow p95 8.68ms、canonical API p95 8.29ms、1200 行搜索 p95 7.61ms、720 行冷 L1 搜索 p95 8.37ms。`npm run build`、renderer/shared/agent-sdk typecheck、i18n/strict i18n 与 `git diff --check` 通过。此为脏 worktree 预检，不代替 §8.8.5 固定提交后的 clean checkout/安装包回滚演练；不启用生产停写或清列。|
| **v255（candidate live terminal assistant 防丢 UI 回查）** | 新增 renderer 兜底：当当前会话不再处于 running、Redux 仍有 streaming assistant 时，按会话回查持久消息页，并将同 ID 的非 streaming 权威消息补入 display store；生命周期清理防止切会话后的迟到回查写错当前状态。先加 ChatView 红测验证“run 已结束、内存 partial/streaming、DB 返回 completed/final answer”旧代码失败，再实现后通过。ChatView/turn-display 七文件 69 项、`npm run typecheck:renderer`、`npm run build:renderer` 均通过。v0.2.3 旧安装包实测的 live UI 故障仍需新版本 clean-checkout 安装包验收；此代码级回归不等同于 rollback floor 发布/签核。|
| **v254（rollback 候选实时终态 UI 接管故障登记）** | 用户在已启动的 arm64 v0.2.3 候选窗口发送 `HI` 后，隔离 profile 中 turn/History 已记录 completed、`model-response-committed` 与完整 assistant 正文，输入框恢复可用，但原 renderer 气泡持续显示生成中/占位；仅重启候选进程后，历史正文才在 UI 显示。证明持久正文未丢失，但 live terminal display 未及时接管该消息；这是实际候选包的用户可见故障，加入 M2-6 阻断项，必须查明并修复/回归后才可声称候选读点验收通过。此次候选消息正文是应用欢迎语；endpoint/凭据等敏感路由信息未记录。|
| **v253（rollback floor 多 spill 冷缓存与损坏故障补验）** | 用 schema-v46 canonical-only 文件 SQLite disposable profile 建立 3 条 84 KB 正文、3 个 source-truth spill，并完成原 cleanup fence/manifest/verify 协议；DB reopen 后 canonical L1 命中逐字还原三条正文，删除 transcript L1 后从 History/spill L2 重建仍逐字还原；复制 profile 并篡改一个 spill 字节后，cache-hit transcript 读取拒绝并返回 `CANONICAL_SESSION_CONTENT_UNAVAILABLE`（底层 `SPILL_CONTENT_UNAVAILABLE`），旧 `messages.content` 仍为空。仅为当前源代码本机隔离证据；候选安装包 IPC 故障注入、allocator 矩阵、C→R→C 发布产物演练仍未完成，故不关闭 M2-6 或生产清列门禁。|
| **v245（Phase 5.5 当前门禁状态复核）** | 对照 5.5 主门禁、已接受的 global-search 预算评审、v241–v244 迁移/History 回归与隔离库清理演练，修正 §8.8.4 当前摘要中的陈旧状态：搜索预算、清理状态机/逐 session 清理演练及 terminal/allocator 故障矩阵已完成；当时仍将生产分布评审与已发布兼容 rollback floor 列为清理门禁。没有用本机性能或本地工作树冒充生产/发布证据。`git diff --check` 通过。|
| **v246（拆分开发完成与生产清列发布门禁）** | 根据项目规划复核，将慢设备/冷 OS 缓存/真实生产规模分布测量从 Phase 5.5 项目内前置硬门禁移至发布后观测与性能复核；本机已接受的 global-search p95 ≤20 ms、端到端 ≤50 ms 自动门槛继续作为开发验收。明确 5.5 读点、清理状态机及隔离文件 SQLite 演练可完成项目内实现；唯一保留的真实数据清列前置条件是兼容当前 schema 的 rollback floor 已发布，并按审计在 disposable file-backed DB 验证 canonical-only/reopen、spill 故障 fail-closed、备份恢复及 v46 allocator 完整性。更新阶段门控和状态摘要；生产 caller/worker 在该回滚能力验证之前仍保持关闭。
| **v237（complete 清理账本完成态不可改写）** | 红测确认 cleanup_state=`complete` 后，直接 SQL 仍可改写 verification SHA-256，破坏完成证明但状态保持 complete。schema v45 在主 DDL 和 v44→v45 additive migration 增加 UPDATE trigger，拒绝 complete progress ledger 的所有更新；整会话 DELETE 仍可按既有事务和 spill GC 路径完成。迁移回归覆盖 v43→45、明确 v44→45、重复迁移和 v44 rebuild 重试；cutover、operations、database migration 聚焦五文件 159 项通过。完整 `npm test -- --reporter=dot`（v45 实现、添加明确 v44→v45 用例之前）为 858 文件通过/1 跳过、8,104 项通过/106 项跳过（287.61 秒）；renderer/shared/agent-sdk typecheck、Electron build、i18n/strict i18n 与 `git diff --check` 通过。strict i18n 为 0 source、1,154 test-file occurrences。rollback-floor 审计同步当前 schema v45。|
| **v236（终验拒绝被篡改的清理游标与计数）** | 红测发现终验只检查全体正文已清空与 `scan_complete=1`，不复核持久 cursor/cleaned count；直接 SQL 将计数改为 0 后，终验仍会写 proof 并置 complete。终验现复用批次入口的 `cleanupProgressCursorIsConsistent`，账本与实际 cleared rows 不符时保持 pending 且不写 proof；恢复正确计数后可完成。真实文件 SQLite/reopen 红绿回归通过；cutover、operations、v44 migration、spill GC 四文件 141 项通过；完整 `npm test -- --reporter=dot` 为 858 文件通过/1 跳过、8,104 项通过/106 项跳过（287.02 秒）；renderer/shared/agent-sdk typecheck、Electron build、i18n/strict i18n 与 `git diff --check` 通过。strict i18n 为 0 source、1,154 test-file occurrences。|
| **v235（complete 会话删除后的 source spill GC 全生命周期）** | 新增真实文件 SQLite 回归：canonical source spill 会话完成有界清理，关闭/重开后终验为 complete；注入 session 删除失败，确认 complete 状态、verified proof、空 legacy 正文和源文件保留，且不产生 GC todo；成功重试后整会话与清理账本原子移除并登记 pending GC todo，DB 再次重开后 worker 才 unlink spill 并完成 todo。验证文件在 GC 前仍存在、完成后不存在且 `PRAGMA foreign_key_check` 为空。cutover、operations、spill GC 三文件 132 项通过；`git diff --check` 通过。该用例验证删除语义，不解锁生产停写/清列。|
| **v234（终验 proof 与 complete 状态 CAS 原子回滚）** | 真实文件 SQLite 用例将消息清理至 scan_complete，关闭并重开 DB 后注入 `pending→complete` trigger 故障。终验在同一事务写入 verified_at/verification_sha256 后 CAS 失败并抛出注入错误；断言 cleanup_state 仍为 pending 且两项 proof 回滚为空。移除故障后在同一重开 handle 重试，终验成功并同时持久化 proof 与 complete。runtime cutover、v44 migration、operations 三文件 138 项通过；完整 `npm test -- --reporter=dot` 为 858 文件通过/1 跳过、8,102 项通过/106 项跳过（287.74 秒），`git diff --check` 通过。|
| **v233（清列后删除会话与跨 session 共享 spill 回收边界）** | 将共享 History 引用加入 v232 文件 SQLite 场景：pending 会话清空正文并删除后，重开数据库执行 GC；因另一 session 仍引用同一 source locator，worker 返回 shared=1/completed=0，todo 保持 pending、文件保留。删除最后一个引用 session 后重跑，todo completed、源 spill 才 unlink。runtime cutover、operations、spillStore 三文件 165 项通过。|
| **v232（清列后删除会话的 spill GC 全生命周期）** | 扩展 v231 文件 SQLite 场景：pending 会话清除唯一 84 KB source-truth 消息正文后被删除，验证 durable GC todo 跨 DB reopen 保持 pending、源文件在 worker 运行前存在；随后重开 DB 执行 `runSourceTruthSpillGcMaintenance`，worker 将 todo 标为 completed（attempts=1、无错误）并 unlink 源文件。runtime cutover、operations、spillStore 三文件 165 项通过；完整 `npm test -- --reporter=dot` 为 858 文件通过/1 跳过、8,101 项通过/106 跳过（285.90 秒）。|
| **v231（已清正文 spill 的删除后 GC 待办重开持久性）** | 扩展整会话删除生命周期：文件 SQLite 写入 84 KB source-truth spill，进入 pending 并清空唯一消息的 `messages.content` 后，通过统一 deleteSession 删除 session。验证 message/cutover/progress 与 session 一起删除，source spill 被登记为 durable pending GC todo，而物理文件在回收 worker 完成前仍保留；关闭并重开数据库后 todo 仍绑定原 session/generation 且 spill 文件仍存在。runtime cutover、operations、spillStore 三文件 165 项通过；完整 `npm test -- --reporter=dot` 为 858 文件通过/1 跳过、8,101 项通过/106 跳过（286.24 秒）。|
| **v230（pending 清理期间的整会话删除与事务回滚）** | 红测发现 pending 状态会阻止 `deleteSession` 删除其 canonical History，且清理账本/正文状态应与用户的整会话删除保持原子。统一删除事务现先删除旧 cutover 行与 progress ledger，再按既有流程删除 History 与 session；session 外键级联删除消息骨架和其它子行。一般 cleanup state 状态机仍禁止回退。文件 SQLite 用例确认 pending session、messages、cutover、progress 全部消失且 FK check 为空；故障注入确认删除晚期失败后事务回滚，pending 状态、manifest 与双写正文完整保留。v44 migration 断言普通 SQL 不能 pending→retained，父 session 删除则 cascade 移除 ledger。runtime cutover/migration/operations 联合 137 项通过；完整 `npm test -- --reporter=dot` 为 858 文件通过/1 跳过、8,100 项通过/106 跳过（286.45 秒）；Electron build、renderer/shared/agent-sdk typecheck、i18n/strict i18n 与 `git diff --check` 通过。未启用生产清理。|
| **v229（SQLite 固定清理账本基线）** | 红测证明 pending/complete 阶段直接 SQL 可改写 progress 的 generation、message revision、canonical session/commit watermark、event/invocation identity 与 source manifest。schema 主 DDL 和 v44 迁移加入 BEFORE UPDATE trigger，pending/complete 禁止改变这些基线列；v44 重建 cutover 表前先删除旧 trigger，避免迁移引用已暂时不存在的表。游标、清理数、scan 状态、attempts、错误与终验证据仍可按协议更新。批次层对账本篡改的旧拒绝用例通过显式移除 trigger 注入，证明纵深校验仍在。清理/cutover、v44 migration、History migration 联合 73 项通过；完整 `npm test -- --reporter=dot` 为 858 文件通过/1 跳过、8,098 项通过/106 跳过（286.77 秒）；Electron build、renderer/shared/agent-sdk typecheck、i18n/strict i18n 与 `git diff --check` 通过。未启用生产清理。|
| **v228（每批校验 pending source manifest）** | 红测在 write-stopped → pending 后直接篡改 `source_manifest_sha256`；旧逻辑仍清除消息正文，导致无法在末尾通过 manifest 终验。修复为每批在 History cursor、全部 source spill、canonical transcript 与候选双写正文核验通过后，重新计算 pending 时的完整 source manifest SHA-256；不匹配返回 `fence-changed`，本批零清理、正文/游标不变并持久记错。保持 cursor/ spill 具体故障的 `history-unavailable` 分类。清理 cutover 与 v44 migration 聚焦 55 项通过；Electron build、renderer/shared/agent-sdk typecheck、i18n/strict i18n 与 `git diff --check` 通过。manifest 重算会按会话全量读取清理基线，实际清理仍受生产设备性能评审门禁约束。未接生产清理调用。|
| **v227（拒绝伪造或倒退的清理游标）** | 红测在 pending 两行会话中将 cursor 伪造为已越过第一条未清消息；旧实现会先清第二条并推进，留下无法从合法前缀续跑的 session。现在每批先用聚合校验检查 `cleaned_message_count` 与 canonical-only 行数相等、已清行全部位于 cursor 前且其前缀没有 dual-write 行、cursor 锚点本身为 canonical-only 空正文，并校验 `scan_complete` 与总行数一致。另覆盖已提交清理后的 cursor rewind 与虚增 cleaned count；均返回 `fence-changed`、正文/进度不变并记错。六文件联合 424 项通过；完整 `npm test -- --reporter=dot` 为 858 文件通过/1 跳过、8,096 项通过/106 跳过（286.28 秒）。renderer/shared/agent-sdk typecheck、Electron build、i18n/strict i18n 与 `git diff --check` 均通过；strict i18n 的 1,154 处中文均在测试文件、源码 0。全量负载 p95：1200 条 search 7.76 ms、multi-spill L1/search 12.93/12.47 ms、720 条/3 session/60 match cold-L1 8.28 ms，均低于 20 ms 自动门槛；本机数据不替代生产分布验证。|
| **v226（拒绝被改写的清理 watermark 账本锚点）** | 对 pending session 分别篡改持久进度账本中的 canonical session sequence、canonical commit order、watermark event ID 与 watermark invocation ID。四种情况均在清理批次复核时与实际 canonical History 水位对拍失败，返回 `history-unavailable`，不清正文、不推进 progress，且记录尝试与原因。write-stopped/pending History 故障矩阵现有 11 格，六文件联合 421 项通过；本版仅扩展测试，最终完整套件按方案终验时重跑。|
| **v225（pending 批次拒绝全局 History commit cursor 漂移）** | 扩大 write-stopped 后的逐批 History 状态矩阵，新增 session cursor 前进/回退/缺失与 global commit cursor 前进用例。红测发现清理路径复用 transcript L1 时未检查全局 allocator cursor，能在存在未持久化的全局 History allocation 时清除正文。将 SQLite History 的连续 commit cursor 校验公开为共享只读不变量，并在清理批次认证前调用；漂移现以 `history-unavailable` 拒绝，零清理且不前进游标/计数。七种状态漂移回归、六文件联合 417 项通过。修改后完整 `npm test -- --reporter=dot`：858 文件通过/1 跳过、8,089 项通过/106 跳过（287.13 秒）；renderer/shared/agent-sdk typecheck、Electron build、i18n/strict i18n 与 `git diff --check` 均通过。strict i18n 为 1,154 处测试硬编码中文、源码 0。全量负载 p95：1200 条 search 7.79 ms、multi-spill L1/search 13.89/13.46 ms、720 条/3 session/60 match cold-L1 8.30 ms，均低于数据库搜索 20 ms 门槛；这些仍是本机环境数据。|
| **v224（后续清理批次校验 canonical source spill 完整性）** | 红测在文件 SQLite 中先清理一条大正文，再删除或篡改其 canonical source spill；原实现因复用 transcript L1 cache 仍继续清理下一条正文。修复为每个有界清理批次在校验候选行前读取并校验该 session 的所有 source-of-truth spill；损坏统一返回 `history-unavailable`，批次零清理、游标/计数不动并记录错误。missing/tampered 两格先红后绿；另为“最后一批完成后、reopen 终验前 spill 损坏”补两格回归，验证完整 History 折叠与 manifest 对拍会拒绝 complete。清理、transcript、History、migration 与 API context 六文件联合 414 项通过；完整 `npm test -- --reporter=dot` 为 858 文件通过/1 跳过、8,086 项通过/106 跳过（289.87 秒）；renderer/shared/agent-sdk typecheck、Electron build、i18n/strict i18n 与 `git diff --check` 均通过（strict i18n 的 1,154 处硬编码中文全部在测试，源码 0）。未调用生产清理入口。|
| **v223（pending 清理批次逐批复核状态漂移）** | 新增四类“session 已 pending、下一批开始前状态发生漂移”的拒绝回归：消息附件变更导致 revision fence 变化、session generation 变化、History cursor 前进、出现活动 execution claim。每类均验证该批零清理、正文/双写状态保留、游标及计数不前进并持久记录错误。关联六文件 317 项测试与 Electron TypeScript 检查通过；同步当前门禁，明确隔离测试库协议已演练、生产分布验证和兼容回滚地板仍待完成。|
| **v222（正文清理后关闭 API kill switch 的跨重启 accepted-turn 回滚验证）** | 新增真实文件 SQLite 回归，依次经过 canonical 写权威、write-stopped、pending 和有界清理批次，清空 accepted user 正文后关闭 canonical API read 开关并 reopen；accepted-turn reader 仍从 canonical projection 返回原正文，持久 fingerprint 校验通过，SQLite `messages.content` 保持空值。证明此开关只关闭 API 快速读路径，不会令清理后的正文静默回退为空 legacy；未改生产读逻辑、未接清理生产调用。聚焦测试通过。|
| **v221（搜索预算 Accepted 后的清理门禁状态同步）** | 复核独立评审已接受 canonical global-search 数据库路径 p95 ≤20 ms，50 ms 整体响应上限不变；技术方案清除当前状态中的预算待评审字样，保留生产分布性能评审及兼容回滚 floor。回滚审计 schema 事实更新为 v44，并纳入持久 write-stopped 清理迁移。未执行生产停写或清列；文档核对后 `git diff --check` 通过。|
| **v220（搜索预算评审决定）** | 2026-10-03 用户在独立评审会话中接受 canonical global-search 数据库路径 p95 ≤20 ms，整体响应仍以 50 ms 为上限；决定及理由已写入搜索预算评审包。关闭预算待评审项，保留生产分布性能评审、兼容回滚 floor 和其它清理门禁；未执行生产停写或清列。历史版本的 pending 记录保留为当时状态。仅更新文档，未重跑性能测试。 |
| **v218（Phase 5.5 清理失败持久记账与 History 直接写围栏）** → **v219（Phase 5.5 跨 session 清理故障隔离与独立续跑）** | 5.5 batch API 的失败此前只回滚，未留下可观察记录。失败现在在独立事务递增 session ledger attempts 并写入截断 last_error，成功批清除 last_error；错误记账不改变已提交游标/计数/正文原子性，重试仍只对当前 session。另加 SQLite BEFORE trigger 阻止 write-stopped/pending/complete session 的 History event INSERT/UPDATE/DELETE 与 stream owner/删除改写，保护已清批次的 canonical 对照；cursor 直接漂移仍让 pending CAS fail closed。v219 文件 SQLite 回归证明两个 pending session 相互隔离：一个会话注入事务失败时，另一个仍可清理并独立 reopen 终验，失败会话保留正文与游标、持久记录错误，之后单独重试完成。全量 `npm test -- --reporter=dot`：858 文件通过/1 跳过、8,077 项通过/106 跳过（296.92 秒）；renderer/shared/agent-sdk typecheck、Electron typecheck/build、i18n check、`git diff --check` 全通过。全量首次暴露 v36 migration 稀疏 fixture 缺 History/message 字段；为其补上 v36 已应有的最小 schema 后，17 项迁移测试和第二次全量套件通过。搜索预算独立评审与兼容回滚 floor 仍 pending，生产调用仍锁定。|
| **v217（Phase 5.5 有界清理批次、断点续跑与 reopen 终验）** | 先红测复现 sequence=0 被初始 cursor 跳过，再实现 `(sequence,id)` 稳定 cursor；ledger 新增 after-id、scan-complete、源 manifest 与批次计数。batch API 每事务最多处理 1–1000 行，L1 watermark + 精确 ID/role/body/timestamp/state 验证通过后清空正文，storage state/cursor/count 原子更新；故障 trigger 注入证明失败批次全部回滚。真实文件 SQLite 关闭/重开后从已提交游标继续，必须在另一次 reopen 后对拍 canonical、消息骨架、preview/count、turn/queue 与 FK manifest 才能标记 complete；同 handle 或故障/漂移拒绝完成。四文件联合 284 项通过，Electron typecheck 和 `git diff --check` 通过。worker API 未接入生产调用，因独立搜索预算、生产分布、兼容回滚 floor 评审未通过而不清理真实 session |
| **v216（Phase 5.5 持久化清理 fence 与 pending CAS）** | 红测复现 write-stop 仅检查活动引用，没有复核全体消息 storage state/body 与 canonical transcript 精确对应；状态可在正文不完整时被标为 write-stopped。现事务入口核验完整 L2 transcript 与 checksum cache，逐行要求 sealed `canonical-backed-dual-write`、终态、role/body/timestamp 对拍及 ID 集合相等，再原子保存 generation、message revision、History watermark、progress cursor 并置 write-stopped。新增 `beginSessionMessageContentCleanup`：在同一事务重查活动引用和全量正文/水位，仅 CAS 到 pending；无匹配账本不能直接 SQL 推进 pending，complete 要求终验证据且所有消息均为空正文/`canonical-backed-only`，伪造终验摘要或仍有副本均不能完成。文件 SQLite close/reopen 后 ledger 保持，水位漂移使 pending CAS 拒绝且正文不变。红测先红后绿；四文件联合 283 项通过，Electron `tsconfig.electron.json` typecheck 与 `git diff --check` 通过。尚未实现批次清列/断点续跑/跨 reopen 终验，不接入生产调用，外部评审门禁维持锁定。|
| **v215（Phase 5.5 write-stopped 真正阻止正文写入）** | 红测发现仅有状态和认证拒绝仍允许 History 镜像及 direct SQL queued insert 继续写 `messages.content`。History append 现按 session cleanup state fail closed；SQLite trigger 拒绝 write-stopped/pending/complete 会话新增消息及正文变更，元数据更新仍可继续。迁移重建 fixture 清理新触发器，primary DDL 与 v44 trigger 名称统一。聚焦四文件 281 项通过，Electron `tsc --noEmit` 与 `git diff --check` 通过。只建立有效写围栏；未实现 pending 推进或正文清理，5.5 外部门禁仍锁定。|
| **v213（L1 parked terminal 跨水位追加拒绝）** | 将缓存终态后追加测试扩成 completed/failed/interrupted/cancelled/parked 五格；红测发现 parked 位于 L1 watermark 前、tail 追加普通 event 时，L1 terminal-before-tail 查询遗漏 parked 并返回旧投影。查询现将 parked 纳入关闭标记，并触发完整 invocation 状态校验；L1 与 cache-miss L2 五格均拒绝，保持旧正文空。聚焦 312 项通过，Electron build、`git diff --check` 通过；全量 8,068 项通过/106 项跳过（858 文件通过/1 跳过，281.64 秒）。搜索预算独立评审和 rollback floor 仍 pending |
| **v212（parked invocation 关闭流与 projection fail-closed）** | 红测复现 canonical-only session transcript 中 invocation-parked 后直接 SQL 追加 History event：SDK writer 已拒绝，但 cache-miss L2 曾接受。根因是 SDK `TERMINAL_INVOCATION_EVENTS` 漏列 parked；加入关闭集合后，全量 L2 fold 通过共享 transition validator 拒绝该数据。Parked recovery 继续映射为 interrupted；不更改 Hosted lookup 或 startup recovery 筛选。SDK writer/L2 红测先红后绿，History 聚焦三文件 308 项通过；Electron build、`git diff --check` 通过；全量 8,064 项通过/106 项跳过（858 文件通过/1 跳过，281.91 秒）。搜索预算评审和 rollback floor 仍 pending |
| **v211（approvalId 在 invocation 内唯一）** | 红测复现不同 toolCallId 重用同一 approvalId 并分别批准、dispatch 和完成时 canonical L1 与 cache-miss L2 仍接受；validator 增加 invocation 级唯一集合，覆盖有/无 toolCallId 的审批身份。先红后绿；五文件聚焦 449 项通过，全量 8,063 项通过、106 项跳过（858 文件通过/1 跳过，303.51 秒）；Electron build、`git diff --check` 通过。搜索预算独立评审与 rollback floor 仍 pending |
| 版本 | v1（初稿）→ v2（B1–B5 处置）→ v3（B6 + F-1…F-4 修正）→ v4（B7 折叠序修复）→ v5（B8 恢复义务拆分 + B9 水位身份校验）→ v6（TDD 证据、B7 主方案选择、Phase 1 与 P-1/P-2/P-4 实施状态）→ v7（canonical message ID 写入、只读身份覆盖画像）→ v8（repair 失败矩阵、分类与全量恢复差分等价）→ v9（最终全量测试与类型检查）→ v10（P-5 可执行判据及 spill 分类 TDD）→ v11（P-2 快照替换语义与 P-3 session 级幂等边界）→ v12（全量测试复验及 gate 状态审计）→ v13（普通台账 retention 后 canonical fold 等价测试）→ v17（cache ver 门控与 v34 失效迁移）→ v18（v35 turn receipt 子协议）→ v19（v36 transcript_committed 执行 fence）→ v20（terminal History + transcript commit 原子封口）→ v21（P-4 有序 projection-retention、跨重启重试）→ v22（P-5 spill 文件协议、canonical locator、严格/降级读与清理）→ v23（P-1 有界 rollout 判定及 Chat IPC canonical L1/L2 展示读取）→ v24（Phase 2 cache checkpoint、legacy 字段保真及性能门禁）→ v25（v37 eligibility fence、message 写入失效、warm page 性能对照及 Phase 2 收口）→ v26（tool result source spill）→ v27（assistant/provider context spill）→ v28（terminal output + P-3 transcript snapshot spill、完整 20 轮体积协议）→ v29（Phase 3 整体验收、Phase 4 空间回收入口和 UI、全量复验）→ v30（safe DB escape path、定期 WAL checkpoint、旧 JSON 备份确认归档与归档唯一性）→ v31（评审回归 B1/B2：终态 pending 队列重试及 L1 行数/cursor/水位连续校验）→ v32（Phase 5 逐列所有权、API context 与迁移/回滚门禁）→ v33（turn 准备路由与 reuse-user 清列门禁）→ v34（source-truth spill 两阶段删除回收）→ v35（Phase 5.0 基线 oracle）→ v36（Phase 5.1 additive schema）→ v37（Phase 5.2 shadow 起步）→ v38（canonical-only shadow 修正）→ v39（terminal assistant 原子镜像）→ v40（participant 故障不确定提交围栏）→ v41（mixed-state、spill/cache 故障及 shadow 性能实测）→ v42（稳定 ID assistant response 与 streaming legacy 正文同事务镜像）→ v43（stable-ID required-user 与 canonical base context 同事务镜像）→ v44（queued/streaming legacy 中间态资格失效验收）→ v45（source spill 准备失败 inline 保全）→ v46（stable message ID 与 turn 归属核验）→ v47（terminal outcome/status 一致性验收）→ v48（SDK/Hosted 终态映射与失败正文镜像）→ v49（source-truth spill 跨重启 shadow 故障围栏）→ v50（required-user 与 canonical context 身份/正文一致性）→ v51（required-user 投影资格与原子双写闭合）→ v52（required-user 大正文 spill 准备失败保全）→ v53（spill 后镜像失败回滚与 orphan 回收）→ v54（非法 required-user 身份 fail-closed）→ v55（assistant response/terminal spill 与 mirror 故障原子矩阵）→ v56（shadow/History 复验与 Hosted dispatch 阻塞复查）→ v57（全量 CI 复验与 Hosted fixture 身份修复）→ v58（accepted-user canonical 指纹安全诊断）→ v59（accepted-input 指纹状态安全日志）→ v60（canonical 缺失时 accepted-input unavailable 诊断）→ v61（完整技能路由入参 shadow 接线验收）→ v62（reuse-user 路由 spill/cache/reopen 对拍）→ v63（assistant response 无损镜像输入 fail closed）→ v64（终态 mirror 原子身份/status 复验与过严 content 相等断言的集成反证）→ v65（turn-owned assistant response mirror 缺失/状态错误 fail closed）→ v66（malformed canonical invocation-context/transcript-compacted/replay-message payload fail closed）→ v67（全量回归及 build/typecheck/i18n 复验）→ v68（queued enqueue 撤销既有 canonical 资格）→ v69（transcript-compacted snapshot 写入 fail closed）→ v70（replay-message 写入 fail closed 与全量复验）→ v71（显式 assistant ID 身份绑定及 Hosted/Remote 合法无 ID response 复验）→ v72（canonical stable ID 非空校验）→ v73（shadow 差异比较覆盖实际字段全集）→ v74（stable-ID provider base context 正文双写及 terminal guard）→ v75（continuation/retry context 镜像与 required-user checkpoint 一致性）→ v76（context mirror 重复 stable-ID fail closed 与 API 候选性能门禁澄清）→ v77（同快照 canonical API candidate 与真实读取性能对拍）→ v78（mirror 中途失效后回滚资格、inline spill 的 canonical API 对拍）→ v79（attachment mutation 直接 SQL 资格失效验收）→ v80（legacy 正文编辑与 canonical/fingerprint 差异验收）→ v81（sequence gap selector 对拍）→ v82（startup cleanup 直接 SQL 收敛后撤销两类资格）→ v83（recoverPersistedTurn 资格撤销验收）→ v84（无 UI 身份 output-recovery replay 保留于 History 但剔除 session transcript）→ v85（区分 invocation replay 与 session transcript 的匿名 replay 语义）→ v86（技能路由等待期间的 generation/message revision 配置围栏）→ v87（全量 npm test 复验及 5.2 gate 状态确认）→ v88（turn route shadow 同一 SQLite 快照及性能回归）→ v89（API/route shadow 同快照与全量复验）→ v90（完整 Message 元数据差分矩阵与全量复验）→ v91（shadow 差分比较数组/symbol 边界红测修复与全量复验）→ v92（required-user 重复 stable ID 原子拒绝审计与全量复验）→ v93（canonical API candidate 状态语义纠正与全量复验）→ v94（compaction snapshot UI/Provider 分离）→ v95（compaction 跨重启与同批矩阵）→ v96（canonical History 水位变化撤销 API eligibility）→ v97（幂等 History 重放保留同水位资格）→ v98（低层 History append 共用资格水位围栏）→ v99（Phase 5.2 shadow 认证与 5.3 持久 eligibility/cutover 边界澄清）→ v100（accepted-turn API shadow 同快照封装）→ v101（queued reorder eligibility 围栏回归）→ v102（逐请求 shadow 匹配与逐会话资格范围区分）→ v103（watermark-only compaction 后 API L1 失效）→ v104（DB reopen 后 stale API L1 与 eligibility 重验）→ v105（异步技能路由期间 revision CAS 拒绝 IPC 回归）→ v106（required-user legacy/canonical 错误码同输入对拍）→ v107（B5 删除事务持久化 spill GC 待办起步）→ **v108（B5 durable 回收 worker、跨进程 fence 与可续跑孤儿扫描验收）** → **v109（Phase 5.2 退出门禁闭环；5.3 逐 session eligibility、API/route cutover、kill switch、cache 与 async watermark fence 起步）** → **v110（5.3 全量回归及 v41 History 直接写入资格撤销/perf 闭环）** → **v111（5.4 写权威资格迁移、双写与编辑 watermark CAS 起步）** → **v112（5.4 收口、旧写入口 fail-closed、全量回归通过）** → **v113（5.5 canonical-backed-only transcript/chat resolver 起步）** → **v114（canonical 单条/分页 reader 与 reuse-user、capability、backup 导出接线）** → **v120（canonical 正文编辑原子同步最后消息 preview）** → **v121（reuse-user 空旧正文 IPC 接线与 SQLite projection 对拍）** → **v122（global search 混合结果、字面 LIKE、limit 与 reopen/L2 验收）** → **v123（canonical-only global search 1200 消息性能测量）** → **v124（canonical-only sequence 分页/capability/reopen）** → **v125（自动备份生成物 canonical-only round-trip）** → **v126（单条/批量 raw 消费者分类）** → **v127（canonical-only turn recovery 六类 outcome）** → **v128（Hosted restart canonical-only reader 与镜像保留）** → **v129（真实 SQLite prepare-turn canonical-only/reopen 路由）** → **v130（prepare-turn 缺正文 fail-closed 与真实 revision fence）** → **v131（shutdown canonical backup flush 有界重试）** → **v132（Hosted failure terminal canonical-only checkpoint）** → **v133（canonical-only accepted-input 持久指纹漂移 fail-closed）** → **v134（Hosted canonical-only 终态 outcome 矩阵）** → **v135（terminal display IPC canonical-only 与畸形 History fail-closed）** → **v136（global search 20ms p95 自动门禁与预算建议）** → **v137（L1/L2 transcript cursor 与事件行数对拍）** → **v138（启动孤儿 shell 骨架读点实证）** → **v139（canonical-only transcript source spill 缺失/篡改 fail-closed）** → **v140（队列删除 preview 故障回滚）** → **v141（队列移序 preview 故障回滚）** → **v142（queued 编辑 preview 故障回滚）** → **v143（canonical-only 尾消息下移序 preview 正确性）** → **v144（L1 terminal 顺序/内容校验与变更失效）** → **v145（canonical transcript cache 正文 checksum 与 L2 重建）** → **v146（L1 cache source-truth spill 完整性校验与跨重启 fail-closed）** → **v147（84 KB source spill L1 读取性能门禁）** → **v148（缓存水位后部分 tool call terminal 不变量）** → **v149（20 轮 multi-spill L1 与 global search 性能门禁）** → **v150（Phase 5.5 raw 正文读点调用面复核）** → **v151（cache generation/watermark 身份元组 reopen 矩阵）** → **v152（L1 terminal kind/status 错配矩阵）** → **v153（session event cursor 落后/缺失 fail-closed）** → **v154（L1 tail sequence 与 stream 元数据完整性）** → **v155（全局 commit cursor 连续性）** → **v156（History event 结构与 kind fail-closed）** → **v157（tool terminal identity reader fence）** → **v158（tool pending identity 转移）** → **v159（dispatch start proposal 关联）** → **v160（approval lifecycle cache-tail 矩阵）** → **v161（global search budget 独立评审包）** → **v162（canonical-only 终态镜像不得复活旧正文及全量复验）** → **v163（canonical-only 流式 assistant 镜像不得复活旧正文）** → **v164（L1 invocation turn identity 跨水位校验）** → **v165（v163–v164 当前代码全量回归）** → **v166（global search 多会话大命中集冷 L1 测量补充）** → **v167（History event session 归属变更 cache 失效与 L2 拒绝）** → **v168（History stream session 重绑定 cache 失效与 L2 拒绝）** → **v169（terminal History 顺序错乱 fail-closed）** → **v170（accepted-turn owner 漂移 fail-closed）** → **v171（History event owner 更新撤销 API eligibility）** → **v172（readSync History event owner 核验与 recovery 防串 session）** → **v173（Hosted 最近 invocation event owner fail-closed）** → **v174（session cursor 双向漂移重开矩阵）** → **v175（canonical global search multi-spill p95 回归修复）** → **v176（owner 损坏时 coordinator 恢复隔离与全量回归）** → **v177（Phase 5.5 读点状态与搜索语义文档对齐）** → **v178（source-truth spill GC 状态与实现对齐）** → **v179（Phase 5.5 rollback floor 兼容性审计包）** → **v180（canonical-only History projection 损坏隔离恢复）** → **v181（真实启动顺序下隔离损坏快照并继续恢复）** → **v182（启动快照恢复异常边界收窄）** → **v183（坏 History session 不阻断后续健康 session 快照恢复）** → **v184（terminal 下未完成 tool proposal 的读取侧故障矩阵）** → **v185（terminal 拒绝水位前未完成 tool proposal）** → **v186（terminal 拒绝水位前未完成 approval）** → **v187（interrupted 保留未决 approval 的跨 watermark 读取与恢复语义）** → **v188（interrupted 保留水位前未决 tool proposal 的跨 watermark 读取）** → **v189（interrupted 保留水位前已 dispatch 的未完成 tool）** → **v190（completed/failed 均拒绝结算未决 approval/tool）** → **v191（completed/failed 均拒绝结算已 dispatch 未完成 tool）** → **v192（interrupted dangling tool 的 L1/L2 读取语义一致）** → **v193（interrupted/cancelled 未决 tool 终态矩阵）** → **v194（interrupted/cancelled 未决 approval 终态矩阵）** → **v195（cancelled terminal 未决工作 recovery 状态）** → **v196（approval lifecycle 跨 L1 watermark 正常结算）** → **v197（approval identity mismatch 跨 watermark fail-closed）** → **v198（跨 watermark approval resolution outcome 矩阵）** → **v199（跨 watermark approval resolution corruption 拒绝）** → **v200（denied terminal 对未决状态的跨水位拒绝）** → **v201（malformed approval 状态转移 L1/L2 拒绝矩阵）** → **v202（并发 approval 跨水位部分结算）** → **v203（跨水位部分 tool result 的 L1/L2 transcript projection）** → **v204（跨水位成功 tool result 与未决 tool 并存）** → **v205（tool terminal/result success 一致性 fail-closed）** → **v206（approval 非批准结论后禁止 tool dispatch）** → **v207（approval wait 必须先于 tool dispatch）** → **v208（tool result 必须有 dispatch start）** → **v209（approval/tool 关联身份缺失时 fail closed）** → **v210（approvalId 在 invocation 内唯一）** → **v211（approvalId 唯一性全量复验）** → **v212（parked invocation 关闭流与 projection fail-closed）** → **v213（L1 parked terminal 跨水位追加拒绝）** → **v214（Phase 5.5 write-stopped 状态 schema 与认证拒绝围栏）** → **v215（Phase 5.5 write-stopped 真正阻止正文写入）** → **v216（Phase 5.5 持久化清理 fence 与 pending CAS）** → **v217（Phase 5.5 有界清理批次、断点续跑与 reopen 终验）** → **v218（Phase 5.5 清理失败持久记账与 History 直接写围栏）** → **v219（Phase 5.5 跨 session 清理故障隔离与独立续跑）** → **v220（搜索预算评审决定）** → **v221（Accepted 后清理门禁状态同步）** → **v222（正文清理后关闭 API kill switch 的跨重启 accepted-turn 回滚验证）** → **v223（pending 清理批次逐批复核状态漂移）** → **v224（后续清理批次校验 canonical source spill 完整性）** → **v225（pending 批次拒绝全局 History commit cursor 漂移）** → **v226（拒绝被改写的清理 watermark 账本锚点）** → **v227（拒绝伪造或倒退的清理游标）** → **v228（每批校验 pending source manifest）** → **v229（SQLite 固定清理账本基线）** → **v230（pending 清理期间的整会话删除与事务回滚）** → **v231（已清正文 spill 的删除后 GC 待办重开持久性）** → **v232（清列后删除会话的 spill GC 全生命周期）** → **v233（清列后删除会话与跨 session 共享 spill 回收边界）** → **v234（终验 proof 与 complete 状态 CAS 原子回滚）** → **v235（complete 会话删除后的 source spill GC 全生命周期）** → **v236（终验拒绝被篡改的清理游标与计数）** → **v237（complete 清理账本完成态不可改写）** → **v238（complete 清理账本拒绝独立删除）** → **v239（启动孤儿清理只读消息骨架与搜索预算决定同步）** → **v240（cutover fence 丢失后的 canonical-only 写保护）** → **v241（全局 allocator 变更撤销暖 L1 与 API 资格）** → **v242（rollback floor 审计与 schema 46 对齐）** → **v243（History terminal 删除/顺序读点状态复核）** → **v244（v45→v46 升级重建 allocator corruption marker）** → **v245（Phase 5.5 当前门禁状态复核）** |
