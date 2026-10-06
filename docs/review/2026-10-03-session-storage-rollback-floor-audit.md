# Phase 5.5 rollback floor audit

## Local schema-v50 Windows x64 installer build probe (2026-10-05)

- 在干净代码快照 `773f5abeeeef34c27accaf7945fdc5423fbc0ba8` 上执行 `npm run pack:win`。为避免把仅含 `mac-arm64` 回滚产物的 TEST ONLY 兼容记录伪装成 Windows 兼容证据，构建期间使用 cleanup-disabled 输入（`allowContentCleanup=false`、compatibility record 为 `null`）；构建结束立即恢复原始输入，摘要分别与原值 `daeee9a89a186906b418b9d729ba0dd533e934e6cec1ed1c0620969463a8edd8`、`aa59a4e727b046cc35a69e282c20269ff9f4a7d02e99c3b1d1bb518e32dabda3` 一致，快照 `git status --short` 为空。
- `npm run pack:win` 退出码 0，生成 Windows x64 NSIS 安装包 `SpaceAssistant Setup 0.2.4.exe`，SHA-256 `bb5c02a6a86d57bdddd8ceda90f1a5209dcd93cfe9467d8b1a7c88e40a0c2a81`；`file` 识别为 Windows NSIS 安装程序，解包目录主程序为 PE32+ x86-64。afterPack 将 `allowContentCleanup=false` 与空兼容记录带入包资源，并成功校验 ripgrep/tree-sitter 资源。
- 构建身份记录 `sourceTreeClean=false`，因为打包时临时替换过 ignored release inputs；所以该产物是**仅供构建链探测的 TEST ONLY 包**，不可作为干净候选、R rollback floor、C 兼容证明或发布产物。当前环境不能原生安装运行 Windows 应用；本记录不证明 Windows 安装、启动、SQLite native binding、profile 读取或降级行为。正式发布与真实 profile 清理 No-go 不变。

## R v50 arm64 renderer IPC display/summary and fault isolation (2026-10-05)

- 使用真实 R v0.2.4 arm64 DMG（SHA-256 `063a78504562dc15f1a69900459ebc9ebc0be50d1d7f58039a7683b098405c7a`；build identity `773f5abeeeef34c27accaf7945fdc5423fbc0ba8`, `sourceTreeClean=true`；bundle 清理关闭、compatibility record 为 null）启动应用。应用通过 `--user-data-dir` 仅打开 `/tmp/session-storage-v50-renderer-ipc-20261005/userData` 的合成副本；通过 Chromium DevTools Protocol 在实际 renderer 上调用 preload 暴露的 `window.api`，没有调用模型。
- 在 schema-v50 `canonical/complete`、102 条 `canonical-backed-only`、legacy 正文总字节为 0 的会话上，renderer `chatGetMessagePage` 返回 100 条当前页且含第 102 条末消息；`chatGetDisplayMessagePage` 返回 50 条终态 assistant display，末项 ID/正文/lifecycle 为 `v50-message-102` / `synthetic rollback body 102` / `completed`；`chatGetApiContextBaseline` 与 `chatGetSearchCorpusPage` 各返回 102 条，global search 命中该末消息。
- 同一隔离副本中仅向一条 user 骨架加入合成图片附件、向一条 assistant 骨架加入合成 thinking 元数据（不写正文）。实际 renderer `chatGetContextHistorySummaryBaseline` 返回两项：图片 `imageTokens=400`、thinking `thinkingTokens=12`；message page 仍从 canonical History 返回正文。应用退出后 `integrity_check=ok`、FK 检查为空、session 仍 `canonical/complete`、102 条正文总字节仍为 0。该元数据编辑仅发生在 disposable fixture，不是生产清理/写入。
- 故障隔离使用另一 profile 副本 `/tmp/session-storage-v50-renderer-ipc-display-fault-20261005/userData`：canonical-only `retained` retry session 的 `invocation-context-committed` payload 被设为非法 JSON；数据库更新 trigger 清除了投影 cache。R arm64 实包启动时 database migration、canonical classification/recovery 和 renderer load 均 outcome `ok`；session-ledger 另有 fixture JSON 警告，不影响 History consumer 结论。renderer `chatGetDisplayMessagePage` 与 `chatGetMessagePage` 均拒绝为 `CANONICAL_SESSION_CONTENT_UNAVAILABLE`，没有返回空/局部正文；同库健康的 `canonical/complete` session display 仍返回预期正文。
- fault app 正常退出后 `integrity_check=ok`、FK 检查为空；受损 History payload 保留，故障 session 仍 `canonical/retained`、旧正文总字节为 0，健康 session 仍 `canonical/complete`。本项补齐 R arm64 实际 renderer→preload→IPC 的 display 成功/History 故障隔离及 metadata-only context summary；不覆盖 `prepare-turn` 从 renderer 发起的 route/reuse-user，也不等于完整 §8.8.5.B 矩阵、Windows 实机、正式 rollback floor 或真实数据清理放行。

## Local schema-v50 old-profile upgrade and retry/recovery readers (2026-10-05)

- 基于 schema-v19 `v0.2.2` 合成 profile 的只读基线副本，关闭源实例后复制 DB 与 profile 文件到 `/tmp/session-storage-v50-old-profile/userData`，由实际 R arm64 DMG 启动升级。迁移将 schema 19 提升至 50；两条原消息的 ID、session、role、status 与正文 UTF-8 字节完全保留，附件/turn/queue 状态未被写入或清理；legacy body 仍完整，write mode=`legacy`、cleanup=`retained`。退出后完整性 `ok`、FK 检查为空。
- 安装包 renderer→preload→IPC 的 `chatGetMessagePage`、`chatGetApiContextBaseline`、`chatGetSearchCorpusPage` 均与源 profile 数据逐字段对拍相等；`searchExecute('token-19')` 命中 user 与 assistant 两条消息，`sessionList` preview 为 `Legacy assistant reply survives upgrade`。首次脚本断言误将消息 sequence 期待为 0/1；实际 contract 为 1/2，修正断言后全部通过。无 schema/content 缺陷。
- 从既有合成 schema-v48 retry profile 复制隔离目录后由同一 arm64 R 包迁移到 v50。实际 `chatResolveRetryContext` 返回 canonical failed assistant 与其 user 正文、稳定 ID/sequence、附件 locator 与 `imagesDeliveredToApi=true`；`chatGetMessagePage` 返回 2 条，`chatGetDisplayMessagePage` 保留 failed display，`chatGetContextHistorySummaryBaseline` 返回 canonical user image token 统计，`chatGetTurnErrors` 对未记录错误返回空数组，符合 fixture 契约。没有发起 retry、continuation 或模型请求。
- 该 retry profile 是 synthetic canonical-only/cleanup-retained 样本，未覆盖 route/reuse-user 新请求。两个 profile 均为临时副本，未触碰用户真实 profile；证据仅补旧 profile→当前 R 与 retry/recovery 只读子项，不构成全消费者矩阵、正式 rollback floor、跨架构或生产清理授权。R DMG: `/tmp/SpaceAssistant-v50-R-arm64.dmg`，SHA-256 `063a78504562dc15f1a69900459ebc9ebc0be50d1d7f58039a7683b098405c7a`。

## Local schema-v50 R route/reuse-user and completed-fence check (2026-10-05)

- 使用同一 R v50 arm64 DMG，在隔离副本 `/tmp/session-storage-v50-route-success-vision/userData` 上启动 Electron。针对 schema-v50 的 canonical-only retry user 调用实际注册的 `chat:prepare-turn` main-process handler，模式为 `reuse-user`；输入行 `drill-retry-user-v298` 的 legacy `messages.content` 为空、`content_storage_state=canonical-backed-only`。返回 turn 保留该 ID、正文 `retry input from canonical`、附件 locator 与 `imagesDeliveredToApi=true`，且无 `TURN_USER_MESSAGE_MISSING`。合成 user Skill 以这段 canonical 正文中的触发词命中；持久化 execution config 包含 `canonical-route-probe` skill fragment，证明正文确实进入路由匹配。turn 状态停留在 `prepared`。为避免模型执行，使用本地合成模型、虚构 key sentinel 与 legacy 技能路由；通过 Electron inspector 直接调用已注册 prepare handler，没有调用 `chat:submit-outbound` 或 `chat:execute-turn`，不访问外部服务。
- 对另一隔离副本的已清列 v50 会话 (`canonical/complete`) 调用同一 `reuse-user` prepare handler，SQLite cleanup trigger 拒绝事务。退出后消息仍为 102 条、History 为 1 stream/2 events，目标用户行仍为空正文/canonical-backed-only，请求没有新 turn；`integrity_check=ok`、FK 为空。这个拒绝证明 R 不会在 complete 写围栏内接收该 turn。
- 成功的 prepared-turn 副本退出后状态保持 `retained`，输入旧正文仍空，turn=`prepared`，`integrity_check=ok`、FK 为空；副本 DB SHA-256 `82e22162348597d03d0c8d6c0eedd887640c1a4a983674316e5231e60ef49f1d`。此项覆盖当前 R main handler 的 route/reuse-user canonical 正文、附件/vision metadata 与 complete fence，但直接调用 main handler，不是 renderer→preload 信道完整性验收；仅 arm64 技术证据，不构成正式 floor 或全消费者矩阵。

## Local schema-v50 R canonical-only backup and restore reader (2026-10-05)

- 使用实际 R v50 arm64 DMG 与独立副本 `/tmp/session-storage-v50-backup-profile/userData`。将该副本 workDir 配置改到副本内 workspace 后，通过 renderer `sessionUpdate` 修改合成 session 标题，触发生产 debounce backup。包内 `SessionBackupManager` 生成 102 条消息的 `messages.json`。
- 从 renderer IPC 分页取得 102 条 `chatGetMessagePage` 消息并按 `sequence` 正序，与 backup JSON 的 stable ID、session、role、content、timestamp、status、schemaVersion、tool/思考/附件/vision 元数据逐字段比较，差异 0。backup 文件 SHA-256 `bfadb7a6718f96d398abb958e9f8c1d52e5a806bbbf6163235154d74e985a31f`。
- 当前源码中的生产 `SessionBackupManager.restoreSession` reader 读取该实际包生成的 backup，返回 102 条，和包内 renderer IPC 基线逐字段差异 0。当前 R 没有独立的 restore UI/IPC，因此这里只验生产文件格式及 reader round-trip，不声称包内调用了 restore 流程。退出后会话仍 `canonical/complete`，102 条骨架正文总字节 0、message_count=102、`integrity_check=ok`、FK 为空；所有文件仅在临时副本 workspace。

## Local schema-v50 R cold/warm projection cache and API read switch (2026-10-05)

- 以已完成清理的 schema-v50 synthetic session 建立独立副本，启动 R 前删除仅该 session 的 `canonical_session_projection_cache` transcript L1 行（1 行）；API eligibility 行原本为 0，cutover 为 `canonical/complete`。实际 R arm64 包冷读后，renderer 分页、API context baseline 和 search corpus 各返回 102 条，与此前同包 IPC 基线按消息字段完全相等；global search 命中 `v50-message-102`。R 重建 transcript cache 为 1 行。
- 完整退出并同一 profile 暖缓存重启 R，三种读取及 global search 命中与冷读结果完全相同，均 102 条。再关闭副本中的 `config.sessionStorageCanonicalApiRead` 并重新启动 R；page/API context/search corpus 仍分别返回 102 条且与冷读完全相同，不会因为旧副本为空而返回空消息。重启后配置保持 `false`、eligibility 仍 0、session 为 `canonical/complete`、消息旧正文总字节为 0，DB integrity `ok`、FK 为空。
- `electron/runtime/acceptedTurnContext.test.ts` 的“清理真实清空旧正文后关闭 API 读开关，accepted turn 仍从 canonical transcript 取正文”聚焦回归通过（1 passed）。当前实包部分只执行 renderer 只读 IPC；未调用模型，因此 accepted-turn 执行期 package 路径由该单测而非本实包证明。本机 OS 页缓存未被清除；此处 cold 指应用 transcript projection cache 冷态，不宣称冷 OS/设备缓存性能。

## Local schema-v50 R source-spill fault isolation (2026-10-05)

- R v50 arm64 包在健康 synthetic multi-spill profile 上读取 86,022 / 91,024 字符的 canonical-only user/failed-assistant 正文，SHA-256 分别为 `c309d69444769d01247f32b6e2d7eee380b85a3e327324e1cccf3a975d5c7539` 与 `bc27e7d549366c2d23a2091ee4ff3ba7cf9b8e2bff62d4903a40a01546a9fe04`。退出后复制完整 profile；副本已有 1 条 transcript L1 cache，随后仅将 user 对应的 `9365a946-c49a-49de-a84b-a052affb5e9f.spill` 移到隔离 quarantine，源 profile 文件保持不变。
- 同一实际 R 包启动 warm-cache 故障副本后，page、API context、search corpus、global search 均明确以 `CANONICAL_SESSION_CONTENT_UNAVAILABLE` 拒绝；没有返回 warm-cache 正文/空正文。profile 内另一健康会话的 page 正常返回 20 条。退出后故障副本的 cache 仍在（未覆盖缺失的 spill），两份 DB schema 均为 50，`integrity_check=ok`、FK 检查为空；消息 canonical-only 正文副本仍为空。
- 本项只注入 source spill 缺失，未覆盖 History 损坏、水位/owner 故障、allocator 变体或其它 OS/架构；不代表完整故障矩阵、正式 floor 或清理放行。

## Local schema-v50 R History payload fault isolation (2026-10-05)

- 从已由 R 包读取并缓存过的健康 v50 source profile 建独立副本。对 session `b1e0aa7e-1739-4229-9163-1d680eacf53b` 的 `drill-multispill-invocation-v304`，使用直接 SQL 将 `invocation-context-committed.payload_json` 改为 `{}`；生产 History event 更新 trigger 自动删除该 session transcript L1 cache。该破坏只存在于故障副本，source profile 仍完整。
- 重启实际 R v50 arm64 包后，故障 session 的 page、API context、search corpus、global search 均拒绝为 `CANONICAL_SESSION_CONTENT_UNAVAILABLE`；同 profile 的健康会话 page 仍返回 20 条。退出后 source/fault DB 均 `integrity_check=ok`、FK 检查为空；故障副本 L1 cache 未重建。DB 结构完整但 History 语义损坏，R 保留损坏证据，不返回空/部分正文。
- 与缺 spill 项合并仅覆盖两类 History/source 读取故障；尚未覆盖 event/stream owner 漂移、watermark/cursor/allocator 不变量变体及其它架构。

## Local schema-v50 R owner, watermark and allocator fault cases (2026-10-05)

- **event owner drift：**独立 profile 中直接把 canonical context event `session_id` 改为 `foreign-session-v50`。R 包的 page、API context、search corpus、global search 均以 `CANONICAL_SESSION_CONTENT_UNAVAILABLE` 拒绝；同库健康会话返回 20 条。退出后 event owner 不匹配仍保留，schema 50、integrity `ok`、FK 为空。
- **stream owner drift：**另一个独立 profile 中把 multi-spill invocation 的 `agent_history_streams.session_id` 改为 `foreign-session-v50`。同一组四个消费者 fail-closed，健康会话仍返回 20 条；DB integrity/FK 通过。
- **watermark anchor：**隔离 profile 的 transcript cache 锚点改为不存在的 event ID。R 包从 History 读回 86,022 / 91,024 字符两条正文，SHA-256 与健康基线完全相同，并将 cache anchor 修复为真实 terminal event `drill-multispill-invocation-v304:history:2`；退出后 integrity `ok`、FK 为空。
- **全局 allocator invalid marker：**副本中将 `agent_history_cursor_integrity.invalid` 置为 1 后，R 包对两个 canonical-backed session 的 page 都 fail-closed；marker 保持 1、未被应用静默清除。该完整性标记是全局的，所以故障影响该副本内所有 canonical-backed 会话；DB integrity `ok`、FK 为空。
- 以上当前 v50 arm64 包证据补 event/stream owner、单 cache-anchor 自修复与 invalid-marker 读取；尚未覆盖配对/未配对 cursor、cursor UPDATE/DELETE、全局 gap/cursor 漂移与 schema-v45→v46 marker 重建的当前包矩阵，也未覆盖 x64/Windows 或正式发行包。

## Local schema-v50 R allocator cursor UPDATE/DELETE fault cases (2026-10-05)

- 从健康 schema-v50 synthetic profile 分别制作 UPDATE 与 DELETE 故障副本。直接改写 `agent_history_commit_cursor.allocated_at` 或删除 cursor 行；生产触发器均将全局 `agent_history_cursor_integrity.invalid` 持久置为 1，并清空 transcript L1 cache。
- 实际 R v50 arm64 包启动两个独立副本后，message page、API context、search corpus、global search 均以 `CANONICAL_SESSION_CONTENT_UNAVAILABLE` 拒绝；退出后两个副本 marker 仍为 1、cache 行数为 0，`PRAGMA integrity_check=ok` 且 `foreign_key_check` 无记录。
- 本项只证明 cursor UPDATE/DELETE 触发的全局 fail-closed 行为。配对/未配对 cursor、全局 gap/漂移、v45→v46 marker 重建和其它架构仍未完成；不构成正式 rollback floor、完整消费者矩阵或生产清理授权。R DMG SHA-256：`063a78504562dc15f1a69900459ebc9ebc0be50d1d7f58039a7683b098405c7a`。

## Local schema-v50 R global commit-order gap and unpaired cursor (2026-10-05)

- **全局 commit-order 漂移：**从健康 synthetic profile 制作故障副本，允许直接 SQL 更新的隔离步骤中仅移除该副本的 History event 更新写围栏，再将 `aa2fdfde-22f0-4bbe-92a3-4c8a74925f0d` 的一条 event `commit_order` 从 1 改为 101。副本 `agent_history_cursor_integrity.invalid` 仍为 0，cache trigger 失效了受影响 session 的 L1；SQLite integrity 为 `ok`，FK 检查为空。实际 R v50 arm64 包的该 session page、API context、search corpus 均拒绝为 `CANONICAL_SESSION_CONTENT_UNAVAILABLE`；同库健康 session `b1e0aa7e-1739-4229-9163-1d680eacf53b` page 仍返回 2 条。global search 因全局 corpus 含损坏 session 而 fail-closed。退出后结构完整、invalid marker 仍为 0。这个用例验证 event/cursor 顺序损坏隔离，不等同于 allocator UPDATE/DELETE marker 测试。
- **未配对 cursor：**另一副本按生产 INSERT trigger 新增 cursor id 9，不配套写 event。启动前 pending allocation 为 1、invalid marker 为 0、cache 有 4 行，integrity 为 `ok` 且 FK 为空。R 包的 page、API context、search corpus、global search 均拒绝为 `CANONICAL_SESSION_CONTENT_UNAVAILABLE`；退出后 pending allocation 仍为 1、invalid marker 仍为 0、cache 未被错误重建，integrity/FK 仍通过。
- 配对的健康 cursor/event 对在同一 synthetic source profile 中保持 1…8 连续对应，R 已在此前 healthy multi-spill consumer 对拍中成功读出正文。当前 v50 arm64 证据覆盖有效配对读取、未配对 allocation 与非连续 commit-order 故障；v45→v46 marker 重建的安装包升级、其它架构及正式 release floor 仍未完成。R DMG SHA-256：`063a78504562dc15f1a69900459ebc9ebc0be50d1d7f58039a7683b098405c7a`。

## Local schema-v45 allocator marker reconstruction in R v50 package (2026-10-05)

- 从仓库 schema-v46 迁移基线构造隔离 v45 profile：保留 v45 已有的 `commit_order`、`session_seq` 与 allocator cursor 结构，移除仅由 v45→v46 增加的 marker/pending 表及触发器，再写入 v45 版本号。fixture 中同一 History 有 commit order `1,3` 和 cursor `1,2`，因此同时含 interior gap 与未配对尾 cursor。R DMG SHA-256 为 `063a78504562dc15f1a69900459ebc9ebc0be50d1d7f58039a7683b098405c7a`。
- 使用实际 R v50 arm64 包启动该副本后，迁移完成至 schema 50；重建结果为 `agent_history_cursor_integrity.invalid=1`、pending cursor `2`。message page、API context、search corpus、global search 均拒绝为 `CANONICAL_SESSION_CONTENT_UNAVAILABLE`。旧消息正文仍为空、状态仍为 `canonical-backed-only`，cutover 仍 `canonical/retained`；应用退出后 SQLite integrity `ok`、FK 检查为空，标记和 pending 待办保留。
- 这是安装包在真实 v45 表结构边界上执行迁移链的隔离合成演练，不涉及用户 profile。它与 v45→v46 migration TDD 互补；不构成正式 R 发布、多架构验证或生产清理授权。

## Local v346 arm64 schema-v45 allocator reconstruction recheck (2026-10-05)

- 从仓库的 schema-v46 migration baseline 创建全新空 profile，再按 v45 边界移除 v46 专属 marker/pending 表及触发器、将版本号设为 45。插入 History commit_order `1,3` 与 allocator cursor `1,2`，使该 fixture 同时含 interior gap 与未配对 cursor。启动前 schema=45、无 v46 marker/pending 表，DB integrity `ok`、FK 检查为空。
- 使用 v346 arm64 app（snapshot commit `ffd0d87a660136240b2e3079bb757e366bf51b8c`）启动并等待 renderer IPC ready。启动后 schema=50，迁移重建 `agent_history_cursor_integrity.invalid=1` 与 pending cursor `2`；原 event commit_order 与 allocator cursor 均保留，DB integrity `ok`、FK 检查为空。
- 此 fixture 不含 session/message，所以本次只证实真实 packaged-app migration 与 marker reconstruction，不包含损坏 session IPC reader 行为；相关读取 fail-closed 由同候选其它 allocator 故障副本验证。该项不是 Windows 包、正式 R 发布或生产 profile 演练。

## Host-specific execution scope correction (2026-10-05)

- 根据执行设备为 macOS，继续本地步骤只使用 macOS 包和本机能运行的安装包。遵照项目负责人指示，本机不尝试 Windows 打包、安装或运行测试；这些移交 Windows host/Windows CI，当前标为目标平台待办，不阻断本机 TDD/macOS 功能验收。每个受支持平台在该平台正式启用清理前仍须完成自己的安装验收。
- 本阶段不连接真实模型服务/远程发送；自动化 fake-provider 测试与包内 synthetic route 可验证存储输入和本地拒绝边界。真实模型成功生成/流式体验不属于 §8.8.5.B storage rollback gate。正式 main/tag 发布、产物托管、真实 profile 与生产清理依赖相应外部流程，均不作为继续本机开发的阻断项。

## Local schema-v50 R macOS x64 canonical-only reader smoke (2026-10-05)

- 从 clean snapshot `773f5abeeeef34c27accaf7945fdc5423fbc0ba8`、app version `0.2.4` 构建 x64 DMG。测试输入未提供 mac-x64 rollback artifact，因此 `afterPack` 正确拒绝了 `allowContentCleanup=true` 的 TEST ONLY 兼容记录；保存并恢复原 release-input 后，以 deployment `allowContentCleanup=false` 重建。最终包为 ad-hoc signed、清理开关关闭，不是清理授权或正式发布产物。DMG `/tmp/SpaceAssistant-v50-R-x64.dmg`，SHA-256 `7d0250faeb515a63d776824f5e12d1e28943e1322b59d5d062b41b220f5aac1a`；`hdiutil verify` 通过，主程序为 thin `x86_64` Mach-O。
- 在 Apple Silicon 上经 Rosetta 启动该 x64 包，使用隔离副本 `/tmp/session-storage-v50-x64-consumer/userData`。renderer→preload→IPC 分页读回 102 条 canonical-only 消息，与合成 profile 的稳定 ID/顺序一致；API context 与 search corpus 各 102 条；global search 对 `synthetic rollback body 102` 命中 `v50-message-102`。未调用模型/turn 执行。
- 退出后 profile schema 50、会话仍 `canonical/complete`，102 条骨架 legacy 正文共 0 字节，`integrity_check=ok`、FK 检查为空。该项证明当前 schema-v50 x64 reader 的本地 smoke；不证明 x64 rollback artifact 已被兼容记录固定，也不构成 C 在 x64 启用清理的资格。

## Local schema-v50 R macOS x64 spill and History fault isolation (2026-10-05)

- 使用上节同一 cleanup-disabled x64 DMG，在两个互不共享的故障副本分别验证缺失 source spill 与损坏 History payload。实际 renderer→preload→IPC 对每个损坏 session 的 message page、API context、search corpus、global search 均返回 `CANONICAL_SESSION_CONTENT_UNAVAILABLE`；同库健康 session page 仍返回 20 条。
- 缺 spill 副本保持原 warm transcript cache（1 行），未让缓存绕过源文件缺失；History payload 故障副本的受影响 cache 保持失效且未重建。两个副本退出后均 schema 50、旧正文 0 字节、`integrity_check=ok`、FK 检查为空。
- 这补充当前 schema-v50 x64 的两类 canonical 故障隔离。x64 包通过 Rosetta 运行，且 cleanup-disabled；不替代 Windows 原生安装/运行、正式 x64 rollback artifact 或 release-floor 审计。DMG SHA-256 同上：`7d0250faeb515a63d776824f5e12d1e28943e1322b59d5d062b41b220f5aac1a`。

## Current scope reconciliation (2026-10-04)

The migration plan is authoritative for feature-task acceptance. Its M2-6 acceptance requires selecting the canonical-compatible reader, defining the schema/History/spill contract, and validating canonical-only reads and the write fence with current code and isolated file-backed SQLite. It explicitly assigns installed-package switching, release R, retained artifacts, and production cleanup authorization to §8.8.5. The migration-plan ledger records M2-6 as feature acceptance complete; the current worktree is schema v48.

Earlier entries below that say “M2-6 remains open” were written while the scope still combined feature acceptance with rollback-package rehearsal. Treat their listed package fault cases and migrations as package audit evidence and follow-up history, not as unmet M2-6 feature requirements. Any remaining installed-package combinations, exact R/C installation sequence, publication, retained artifacts, and compatibility record are release-floor work. This reconciliation does not change the **No-go** for real-data write-stop/content cleanup: no published schema-v48 rollback floor has passed the required C/R drill, and no production cleanup is authorized. Developer ID signing remains distribution policy, not a feature gate.

## Decision

**No-go for stopping legacy body writes or clearing `messages.content`.** The currently published `v0.2.2` tag is not a compatible rollback target. Local R/C candidates have been built and technically exercised, but no compatible rollback release has been formally published and retained; physical cleanup must remain locked until the release floor is verified and the audit is accepted.

This is a compatibility audit package, not approval to perform cleanup.

## Evidence

- Published tag `v0.2.2` declares database schema version 19 (`electron/database/schema.ts`). The current worktree declares schema version 48 and includes additive session-content state, eligibility, spill-GC, History invalidation, transcript-cache checksum, persisted write-stopped cleanup-state, completed-cleanup-ledger immutability, canonical-only body immutability, global History allocator integrity, and legacy-reader ownership migrations.
- `v0.2.2` has no `electron/runtime/sessionTranscriptProjection.ts` or `electron/runtime/sessionContentWriteAuthority.ts`. Its user-facing message reads in `electron/database/operations.ts` select `messages.content` directly, including `getMessages`, `getTurnContext`, sequence paging, and route-window reads.
- Current `electron/database/migrations.ts` rejects a database whose schema version is newer than the binary supports. A v0.2.2 rollback against the current schema-48 profile therefore fails before opening the application. If that version guard were bypassed, the old readers would still return empty bodies for rows already cleared by Phase 5.5.
- Current Phase 5.4 retains legacy bodies and dual writes. That keeps the present database content readable by a compatible older build only while those copies remain intact; it does not make v0.2.2 a rollback target after a future clear.

## Minimum compatible rollback release

Before any legacy body is cleared, publish and preserve a rollback build that:

1. Opens the exact schema version written by the cleanup release without downgrading or rewriting the database schema.
2. Understands `content_storage_state='canonical-backed-only'` and reads each such body through the canonical History projection with spill checksum validation and fail-closed behavior.
3. Covers every production body consumer needed after rollback, including transcript/chat, API context, turn routing and `reuse-user`, search, export/backup, retry, and recovery.
4. Does not repopulate cleared legacy bodies from stale mirrors, and preserves all control metadata, queue/turn state, attachment references, and preview invariants.
5. Has a kill switch or documented recovery path that returns to the preserved legacy copies before cleanup begins; after cleanup, rollback is limited to the compatible release floor.

## Required release-floor verification

Use a disposable copy of a file-backed database at the exact cleanup-release schema (current worktree schema v48; recheck when selecting the release candidate) with representative canonical-backed-only rows, multi-spill bodies, cache hit/miss states, queued messages, active/terminal turns, and backup/restore artifacts. Include paired and unpaired global History allocator cursors to verify v46 cursor-integrity migrations alongside current-schema and transcript reads. Verify that the proposed floor build opens it, reads canonical bodies after process restart, rejects missing/corrupt History or spill without returning empty content, and leaves the source profile untouched. Record the exact release identifier, schema version, fixture, and result. The release must be published and retained before the first cleanup batch; a worktree, unmerged branch, or local build is not a release floor.

## Gate status

| Gate | Status |
| --- | --- |
| Current published rollback target compatibility | **Failed** (`v0.2.2`, schema 19; canonical-only reader absent) |
| Compatible rollback build | **v0.2.4 local R and v0.2.6 local C candidates built; schema-v48 arm64 technical drills recorded; no formal R release or Accepted floor audit** |
| Cleanup authorization | **Locked** |

This gate is separate from the search-budget review and from the completed source-truth spill GC lifecycle. Neither of those changes makes the current published binary compatible with cleared `messages.content`.

## Local R candidate package preflight (2026-10-04)

This is local artifact evidence for the candidate commit below. It does not change the No-go decision or establish a published rollback floor.

- Candidate commit: `9f9faa1d4cec0848f1ee7f507e1f67e80add0b21` (`fix(test): build local provider package before test suite`). The commit is present on `codex/session-storage-refactor-tdd`, not merged or tagged.
- Clean detached checkout: `/tmp/session-storage-refactor-r-candidate2`; `npm ci` completed. Initial clean-checkout `npm test` exposed that the local provider package `dist/index.js` was missing. Added `pretest` to build that workspace package. A second fresh checkout from the candidate commit then passed focused storage tests (349/349) and the full suite (858 files passed, 1 skipped; 8,110 passed, 106 skipped).
- Clean-checkout checks passed: renderer/shared/agent-sdk typecheck, normal and strict i18n checks, `git diff --check`, and `npm run build`.
- `npm run pack:mac` produced local x64 and arm64 DMGs. Packaging logs show both app bundles passed the repository afterPack resource checks (ripgrep and seven tree-sitter assets) and ad-hoc signing verification. The arm64 bundle also passed `scripts/verify-macos-app-signature.mjs`; the sequential pack script removes the x64 app bundle after its DMG is built. Both disk images passed `hdiutil verify`.
- Local DMG SHA-256: x64 `fe3672d354bf64ff83990766630a3080f08952b5498ce18eb008c9e61b7d4a56`; arm64 `3e00cb5bd56df88197c8d69cf9145a033f48de08421f994ff6eef146a1301d64`.
- The machine has no Developer ID Application identity; these are ad-hoc signed local artifacts, not distribution-signed releases. No release/tag/publication was performed. The required disposable-profile upgrade and actual R→C→R installed-package drill is still outstanding; C is not yet a separate release artifact. Cleanup remains locked.

## Integrated R candidate preflight (2026-10-04, integration commit `76555a46`)

This addendum supersedes the earlier branch-only package preflight for current schema numbering. It remains local development evidence and does not change the No-go decision.

- The isolated integration branch is `codex/session-storage-refactor-integration`; implementation commit `76555a46ebb8f58a2f3d591d9e0cf5d0b02b6ccc` is based on main `78909882`. Main and the original feature branch were not modified. Main's migrations v31–v33 are retained; the refactor migrations continue through schema v49 (cleanup state v48; History cursor integrity v49).
- A detached clean checkout of `76555a46` completed `npm ci`, the full suite (866 files passed/1 skipped; 8,223 passed/106 skipped), shared/renderer/agent-sdk typechecks, normal and strict i18n checks, and `npm run build`. `pretest` built `agent-provider-pi-ai` from the clean checkout.
- `npm run pack:mac` built the x64 app bundle and passed ripgrep/tree-sitter resource checks. The initial afterPack signing attempt failed while disk space was low; after space was freed, the app bundle was ad-hoc signed and `codesign --verify --deep --strict` passed. Electron Builder could not create the DMG: `hdiutil resize` failed with `ENOSPC` (requested temporary image size about 861 MB). No arm64 DMG was produced.
- The machine reports zero valid Developer ID Application identities. The ad-hoc signed `.app` is not a distribution-signed installer. `npm cache clean --force` was attempted to free space but stopped on an EACCES error for a root-owned cache entry; it removed some cache data before stopping.
- No installation, disposable-profile upgrade, R→C→R drill, release, or tag was performed. Current installed rollback floor remains unavailable; cleanup stays locked.

## Local profile migration smoke (2026-10-04, schema 33 → 49)

This is an isolated app-bundle smoke test. The DMG was made directly with `hdiutil` from the ad-hoc signed x64 `.app` because the repository electron-builder DMG step could not allocate its temporary image. It is not the prescribed or distribution-ready R installer.

- The local test image `SpaceAssistant-0.2.2-local-test.dmg` passed `hdiutil verify`; SHA-256: `b1d42c2b3f943759ff21adad05158ada0391b6a5b3ea8cc5c7bccd0c5a10fdd7`.
- Built a disposable file-backed profile with main's schema-v33 database code and one user message (`legacy-body-survives-r-migration`). Started the app from the mounted image twice with `--user-data-dir=/tmp/sa-r-legacy-profile-76555`, never using the installed app's profile.
- After startup and again after restart, schema version was 49; the session/message IDs, sequence 0, status, and legacy body remained intact. The v48 `content_storage_state` column was present. No stop-write or cleanup API was invoked.
- The Mac was locked during the run, so no window-level check was possible. Database evidence proves startup migration and retained-body integrity only; it does not prove a polished install flow, graceful UI shutdown, canonical-only rollback reads, or C→R compatibility.
- The repository `npm run pack:mac`/electron-builder DMG flow remains failed for disk space; no Developer ID exists. No C artifact, release, or tag exists. Gate remains No-go; cleanup remains locked.


## Local v46 clean-checkout candidate package smoke (2026-10-04)

This is stronger local candidate evidence on the TDD branch, but it does not establish a supported rollback floor.

- Fixed source: commit `9f9faa1d4cec0848f1ee7f507e1f67e80add0b21`. Created a new detached clean checkout at `.worktrees/session-storage-r-clean-9f9faa1d`; `npm ci` completed (1,086 packages added; npm audit reported 32 vulnerabilities: 1 low, 10 moderate, 20 high, 1 critical).
- Clean-checkout validation passed: full `npm test -- --reporter=dot` (858 files passed/1 skipped; 8,110 passed/106 skipped), renderer/shared/agent-sdk typechecks, normal and strict i18n (1,154 hardcoded Chinese occurrences, all in tests; 0 in source), and `npm run build`.
- `npm run pack:mac` produced `release/SpaceAssistant-0.2.2.dmg` (198 MiB, SHA-256 `acf3419b9a2300008df476ebc60e7d4286e257ccf57ad7732e2e8a9a0e0f3ea2`) and `release/SpaceAssistant-0.2.2-arm64.dmg` (191 MiB, SHA-256 `d1f301f40dbb979039c35c5bbeac8501ee839723687a757ba50d4e0d0bd6ec88`). Both passed `hdiutil verify`; both app bundles passed ripgrep/tree-sitter resource checks and local ad-hoc signing verification. The machine has no valid Developer ID Application identity. The package metadata still says `0.2.2`, colliding with the already published incompatible `v0.2.2` (schema 19); these files must not be represented as R or distributed.
- Built a disposable file-backed schema-v46 profile with one completed canonical History message, passed the explicit cleanup protocol to `complete`, then closed/reopened. The DB had `content=''`, `content_storage_state='canonical-backed-only'`, `cleanup_state='complete'`, `write_mode='canonical'`, `api_read_mode='legacy'`, `integrity_check=ok`, and no FK violations. Fixture path: `/var/folders/ty/_cyp42ys5m19qj_4_qhvst4m0000gn/T/sa-m2-6-candidate-F5O3p7`; session `e2f15c7a-4e04-4175-b51f-fbec5159da8b`.
- Mounted and launched the arm64 DMG read-only against this disposable profile. Startup migration, History classification/recovery, and session-ledger reconcile all logged `ok`. Actual renderer→preload→IPC calls to `chatGetApiContextBaseline`, `chatGetMessagePage`, `chatGetSearchCorpusPage`, and global `searchExecute` returned or hit `canonical body survives restart`. Deleted only the disposable profile's transcript projection L1 row after clean app exit, relaunched the package, and all four reads still returned the same body through History reconstruction.
- Launched the x64 DMG through Rosetta against a second disposable copy. Startup stages logged `ok`; the same four actual packaged IPC consumers returned/hit the canonical body. After exit, both healthy profiles retained an empty legacy body and complete cleanup ledger; integrity checks were `ok`, FK checks empty.
- Fault injection used a separate copy at `/tmp/sa-m2-6-v46-corrupt-history`: after dropping the write-stop delete guard solely in that disposable copy, removed the invocation context event while leaving its terminal event. The mounted arm64 package started and its page, API-context baseline, and search-corpus IPCs each rejected with `CANONICAL_SESSION_CONTENT_UNAVAILABLE`; they did not return empty content. After exit, DB integrity remained `ok`, FK check empty, legacy body stayed empty, cleanup stayed complete/canonical, and no transcript cache was rebuilt.
- Limits: no failed-assistant retry IPC, full model dispatch (write-fenced complete session must not resume), export/JSON restore package round-trip, multi-spill package fixture, damaged-spill package fixture, paired/unpaired allocator corruption matrix, or actual C→R→C installed release drill was run here. Candidate package version collision and absent C/final R artifact prevent release-floor sign-off; production cleanup stays locked.


## Local v0.2.3 versioned candidate package smoke (2026-10-04)

This follow-up resolves the local package version collision recorded in the prior v46 smoke. It remains an unpublished, ad-hoc signed candidate and does not authorize cleanup.

- Fixed source: `09b0e624aeeda0d96fc934f1867374692656f2e6` (`chore(release): set rollback candidate version 0.2.3`). `package.json` and `package-lock.json` both report `0.2.3`; no tag was created. Clean detached checkout: `.worktrees/session-storage-r-clean-0.2.3`.
- `npm ci` completed (1,086 packages added; npm audit reports 32 vulnerabilities: 1 low, 10 moderate, 20 high, 1 critical). Full `npm test -- --reporter=dot`: 858 files passed/1 skipped; 8,110 passed/106 skipped. Renderer/shared/agent-sdk typechecks, normal/strict i18n (1,154 hardcoded Chinese occurrences all in tests, 0 in source), `npm run build`, and `npm run pack:mac` passed.
- Packaged outputs: x64 `release/SpaceAssistant-0.2.3.dmg`, 198 MiB, SHA-256 `0536caee71337976b0aa674ad3279c36570ffbdc309d0fa70769e8dcc26b765c`; arm64 `release/SpaceAssistant-0.2.3-arm64.dmg`, 191 MiB, SHA-256 `746311d4f0daf5b99071b2cbabe34b1ccb887d3e3db249ffa3ba225787ee90b8`. Both passed `hdiutil verify`, afterPack resource checks and local ad-hoc signing verification. This host has no valid Developer ID Application identity, so they are not distribution-signed releases.
- Reused only disposable schema-v46 profile copies. Arm64 startup migration, History classification/recovery, and session-ledger reconciliation logged `ok`; x64 under Rosetta logged the same. On both architecture packages, actual renderer→preload→IPC `chatGetApiContextBaseline`, `chatGetMessagePage`, `chatGetSearchCorpusPage`, and global `searchExecute` returned/hit `canonical body survives restart`.
- On the arm64 profile, after clean app exit deleted the transcript L1 cache row, relaunched v0.2.3, and confirmed all four consumers still returned the canonical body through History reconstruction. A separate corrupted-history profile with its invocation context event removed returned `CANONICAL_SESSION_CONTENT_UNAVAILABLE` from the installed page, API-context, and search-corpus IPCs. Neither path silently returned an empty body.
- Final checks on healthy arm64/x64 and damaged-history profiles: `PRAGMA integrity_check=ok`, foreign-key check empty, `messages.content=''`, `content_storage_state='canonical-backed-only'`, `cleanup_state='complete'`, `write_mode='canonical'`, `api_read_mode='legacy'`; the damaged profile did not recreate a transcript cache.
- The earlier retry fixture's `createPersistedTurn(state='terminal')` was misclassified as active by the cleanup gate, whose terminal allowlist is `completed/failed/cancelled/interrupted`. Corrected the disposable fixture to use `state='failed'` and an `invocation-failed` History terminal, then completed cleanup without bypassing any guards.
- On that protocol-complete profile, the mounted v0.2.3 arm64 renderer's actual `chatResolveRetryContext` IPC returned `failedAssistant.content='failed answer canonical'` and `currentUser.content='retry input canonical'` from History while both SQLite message bodies were empty. No model request was dispatched. After app exit, integrity was `ok`, FK check empty, both storage states remained `canonical-backed-only`, cleanup remained `complete`, and the write/API modes remained `canonical`/`legacy`. Fixture path: `/var/folders/ty/_cyp42ys5m19qj_4_qhvst4m0000gn/T/sa-m2-6-retry-UGkXCp`; session `3a2fcc98-1040-4fae-98de-2ccfd6e2daf0`.
- Through the mounted v0.2.3 arm64 package, called `sessionUpdate` on the same complete retry fixture and waited past the production debounce. It wrote `/var/folders/ty/_cyp42ys5m19qj_4_qhvst4m0000gn/T/sa-m2-6-retry-UGkXCp/workspace/sessions/3a2fcc98-1040-4fae-98de-2ccfd6e2daf0-20261004/messages.json` (458 bytes; SHA-256 `f06fa0f1bfe31f00140f932811a1264865df59551faffe61a80586928a376868`). The JSON held both canonical-only bodies although SQLite stored them empty. `SessionBackupManager.restoreSession` source roundtrip then restored the same session/message IDs, roles, bodies, and statuses. The app has no renderer restore IPC, so this does not substitute for a full-profile restore drill.
- Still outstanding: multi-spill and damaged-spill package cases, full allocator/owner/watermark corruption matrix, old-profile upgrade, actual C-installed cleanup states, R→C→R/re-upgrade drill, Developer ID signature, main integration, formal tag/release and retained downloadable artifacts. Thus v0.2.3 is only the proposed rollback floor until release process completes; production stop-write/cleanup remains locked.


## Local multi-spill cold-cache and corruption verification (2026-10-04)

- Disposable file-backed schema-v46 profile: `/var/folders/ty/_cyp42ys5m19qj_4_qhvst4m0000gn/T/sa-m2-6-spill-v023-iG6N9Z`; one canonical-only session with three 84,029-byte messages, three source-of-truth spill files, `cleanup_state=complete`, `write_mode=canonical`, all three SQLite legacy bodies empty. Each descriptor was validated against byte length and SHA-256.
- After database reopen, `readSessionTranscriptProjection` returned `canonical:L1` and all three full bodies matched the expected prefix and 200-byte tail. In a copied profile with only the transcript cache row deleted, it returned `canonical:L2`; all three full bodies again matched.
- Corruption copy: `/tmp/sa-m2-6-spill-v023-corrupt-1791107698`; changing one byte caused `validateCanonicalSessionSourceTruthSpills` to fail with `SPILL_CONTENT_UNAVAILABLE` and transcript projection to fail closed with `CANONICAL_SESSION_CONTENT_UNAVAILABLE`; it did not return empty/partial transcript. This is source/runtime file-SQLite evidence, not a packaged renderer IPC failure drill.
- The arm64 v0.2.3 candidate window is running in the separate `spaceassistant-dev` profile. UI showed model `deepseek-flash` and a user-started `HI` request still generating during this audit; no model request was initiated by this verification.
- Remaining M2-6 items are the packaged IPC spill-damage drill, allocator/owner/watermark corruption matrix, old-profile upgrade and actual C→R→C installer exercise. Candidate remains unpublished and ad-hoc signed; production stop-write and cleanup remain locked.


## Candidate live terminal display handoff issue (2026-10-04)

- On the running arm64 v0.2.3 candidate, the disposable `spaceassistant-dev` profile received a user-started `HI` request. Persisted state shows one terminal turn with outcome `completed`, the linked assistant message has status `completed` and 340 characters, and History contains `model-response-committed` plus `invocation-completed`. The composer was enabled, while the same live window continued to show the assistant bubble as generating/placeholder for over a minute.
- Gracefully restarted only the candidate app after confirming zero active execution-queue rows. It reopened the same `spaceassistant-dev` profile and rendered the persisted assistant response. The installed `/Applications/SpaceAssistant.app` process/profile was not stopped or modified.
- Result: no persisted transcript loss; a live renderer terminal-display handoff/reconciliation failure is present in the candidate and remains unexplained. This is a user-visible release-floor blocker: candidate smoke must not be described as passing live terminal UI presentation until the event path is diagnosed and regression-verified. No request was sent by the audit; the `HI` call was already present in the candidate profile before the audit read it.


## Renderer recovery guard for orphaned streaming rows (2026-10-04)

- Added a ChatView TDD regression for the observed split state: local assistant row remains `streaming` with partial text after the session stops running, while `chatGetMessagePage` returns the same message ID in `completed` state with the final body. The test failed before the guard (kept the partial streaming row) and passed after.
- ChatView/turn-display related tests: 7 files, 69 tests passed. `npm run typecheck:renderer` and `npm run build:renderer` passed.
- The guard performs a best-effort page read only when a streaming assistant remains after the current session ceases running; it patches only the same message ID and ignores late completion after unmount/session change.
- Started the current TDD worktree dev process against the configured `spaceassistant-dev` profile. Startup database migrations, History classification/recovery, and session ledger reconciliation reported `ok`; no model request was sent. The actual v0.2.3 package remains the pre-fix artifact, so a newly versioned clean-checkout installer still needs live UI verification before M2-6 can close.

## Local v0.2.4 clean-checkout candidate build (2026-10-04)

- Fixed commit: `a17ac8e17e0bb50fe29da079b278c0bcec53adc2` (`chore(release): set rollback candidate version 0.2.4`), package and lockfile version `0.2.4`; detached checkout `.worktrees/session-storage-r-clean-0.2.4` was clean before build.
- `npm ci` succeeded. Full `npm test -- --reporter=dot`: 858 files passed/1 skipped; 8,111 passed/106 skipped. Renderer/shared/agent-sdk typechecks, normal/strict i18n and `npm run build` passed. Strict i18n found 1,155 hardcoded Chinese occurrences, all in tests and zero in source.
- `npm run pack:mac` produced x64 `release/SpaceAssistant-0.2.4.dmg` (198 MiB, SHA-256 `d5a00cdc200cee055406cb9496a4396e08bc57ed6de0af9770fa3d8849efe0fb`) and arm64 `release/SpaceAssistant-0.2.4-arm64.dmg` (191 MiB, SHA-256 `700e398ff9dcac74f7ec9439d4fab29288ca955f2fe9e8b52ae20ae64605e817`). Both passed `hdiutil verify`. Mounted each DMG read-only; app bundle version was 0.2.4, executable architecture matched x64/arm64, and `codesign --verify --deep --strict` passed. Signatures are local ad-hoc only. Developer ID signing is a release policy and is not a functional development gate.
- This verifies clean-checkout build artifacts only. The packaged live terminal assistant UI regression was fixed by TDD in commit `4dbdd1da`, but no v0.2.4 package live UI acceptance, full consumer/fault-injection matrix, old-profile upgrade, C→R→C installer rehearsal, tag/release or retained formal release artifacts have been completed. Developer ID signing and formal release are separate release-policy work. M2-6 remains open; production stop-write and physical cleanup remain locked.

## v0.2.4 arm64 isolated-profile UI smoke (2026-10-04)

- Copied the existing `spaceassistant-dev` profile to `/Users/space/Library/Application Support/SpaceAssistant-v024-smoke`; the source profile remained open under the TDD dev process and was not modified by the candidate.
- Started the v0.2.4 arm64 app from `.worktrees/session-storage-r-clean-0.2.4/release/mac-arm64/SpaceAssistant.app` with `--user-data-dir` pointing at the copy. The existing `HI` session loaded the completed assistant response (same message ID, 340 characters) and the composer was idle. No new user message or model request was sent. The candidate process was quit before inspecting the copied DB.
- Copied profile checks: SQLite `integrity_check=ok`, `foreign_key_check` empty, user row `sent`, assistant row `completed` with 340 characters, linked turn `terminal/completed`. This demonstrates candidate-package startup and restored rendering of the previously stuck conversation after restart. It does not exercise the original in-process terminal handoff race; the deterministic renderer regression remains covered by the ChatView TDD test. The copied profile used the legacy-body path, so this is not canonical-only spill IPC coverage.

## v0.2.4 arm64 canonical-only IPC and History fault smoke (2026-10-04)

- Reused only the prior schema-v46 disposable candidate fixture `sa-m2-6-candidate-F5O3p7`; copied it to `/tmp/sa-v024-canonical-smoke` and then to the isolated app profile `/Users/space/Library/Application Support/SpaceAssistant-v024-canonical-smoke`. Before launch, `messages.content` was empty with `canonical-backed-only`, cutover was `write_mode=canonical`, `cleanup_state=complete`, DB integrity was `ok`, and FK check was empty. Original fixture was not modified.
- Started the actual v0.2.4 arm64 app with `--user-data-dir` and a loopback-only DevTools port. Through the packaged renderer's `window.api` preload surface, actual IPC returned the canonical body `canonical body survives restart` from API-context baseline, message page, and search corpus; global `searchExecute` matched the message. No model request was sent.
- Quit the app, made a second independent profile copy, and injected a History context fault there by dropping the cleanup delete guard and deleting only the context event. The resulting DB retained `integrity_check=ok`, empty FK check, empty legacy message body, canonical-backed-only state, and `cleanup_state=complete`.
- Started the same v0.2.4 arm64 package on the damaged copy. API-context baseline, message-page, search-corpus, and global-search IPCs all rejected with `CANONICAL_SESSION_CONTENT_UNAVAILABLE`; none returned empty/partial content as success. After app exit the damaged profile still had one terminal History event, empty legacy content, and canonical write mode/complete cleanup state.
- This closes a packaged canonical-only healthy read smoke and one History-missing fail-closed case on arm64. It does not cover spill-byte corruption through package IPC, x64 canonical-only, allocator/owner/watermark corruption matrix, old-profile upgrade, or C→R→C technical installation rehearsal. M2-6 remains open; Developer ID and formal publication remain separate release-policy work.

## v0.2.4 x64 canonical-only and multi-spill package IPC (2026-10-04)

- Mounted the actual x64 DMG read-only and ran under Rosetta against a fresh copy of schema-v46 canonical-only fixture `sa-m2-6-candidate-F5O3p7`. Startup took about 70 seconds under Rosetta before the page became available; this was delayed startup, not a test failure. Actual renderer→preload→IPC API-context baseline, message page, search corpus and global search returned/matched `canonical body survives restart`. The copied DB stayed `integrity_check=ok`, FK check empty, legacy body empty, canonical-backed-only, and cleanup complete.
- On the arm64 package, copied the three-message file-backed multi-spill fixture `sa-m2-6-spill-v023-iG6N9Z` into an isolated profile. The DB had three canonical-backed-only rows, each legacy body empty; the profile had three 84,029-byte source-truth spill files, and the L1 transcript cache was absent so package reads reconstructed through History/spill L2. Actual API-context, message-page and search-corpus IPCs each returned all three exact bodies with 84,029 characters; global search for `canonical multi spill body 0` matched `spill-user-0`. No model request was sent. After exit, DB integrity was `ok`, FK check empty, all three legacy bodies stayed empty and cleanup stayed complete.
- Copied that healthy package profile again and changed one byte of the first spill file. On the same arm64 package, API-context, message-page, search-corpus and global-search IPCs all failed with `CANONICAL_SESSION_CONTENT_UNAVAILABLE`. Post-exit DB integrity remained `ok`, FK check empty, all three legacy bodies remained empty, all rows stayed canonical-backed-only, and cleanup remained complete.
- These checks extend M2-6 package evidence across both architectures for canonical-only reads, arm64 multi-spill L2 reconstruction, and arm64 spill-byte corruption fail-closed. Remaining: x64 damaged-History/spill matrix, allocator/owner/watermark corruption cases through required scope, old-profile upgrade, and C→R→C technical installation rehearsal. M2-6 remains open; release signing/publication is not a functional gate.

## v0.2.4 x64 canonical-only package IPC (2026-10-04)

- Mounted `release/SpaceAssistant-0.2.4.dmg` read-only and ran its x64 app under Rosetta against a fresh copy of the schema-v46 canonical-only fixture. First startup took about 70 seconds before DevTools/page readiness; no test timeout or app error was observed after it became ready.
- Actual packaged renderer→preload→IPC calls to API-context baseline, message page, search corpus, and global search returned/matched `canonical body survives restart`, matching arm64 results.
- After app exit, the copied profile remained `integrity_check=ok`, FK check empty, legacy body empty, `canonical-backed-only`, `write_mode=canonical`, `cleanup_state=complete`. The original fixture and other profiles were untouched.

## v0.2.4 allocator pending-cursor package fault smoke (2026-10-04)

- Copied the healthy schema-v46 canonical-only fixture to `/Users/space/Library/Application Support/SpaceAssistant-v024-allocator-pending`. Inserted one row into `agent_history_commit_cursor` through its production trigger, which registered the cursor in `agent_history_pending_commit_cursor` without a corresponding event. Before app launch, the integrity marker remained `invalid=0`; this represents a pending/unpaired allocation rather than direct table corruption.
- On the v0.2.4 arm64 package, the actual API-context, message-page, search-corpus and global-search IPCs each failed with `CANONICAL_SESSION_CONTENT_UNAVAILABLE`. They did not return the warm L1 body or a successful empty result.
- After app exit the pending cursor remained visible, integrity check was `ok`, FK check empty, and the canonical-only message body remained empty. This package-level case validates unpaired allocator handling. Direct allocator UPDATE/DELETE integrity-marker corruption and broader owner/watermark variants remain outstanding.

## v0.2.4 allocator integrity-marker package fault smoke (2026-10-04)

- Created another isolated copy of the schema-v46 canonical-only fixture and set `agent_history_cursor_integrity.invalid=1` in that copy. Initial SQLite integrity check was `ok`; FK check was empty; the message body stayed empty and `canonical-backed-only`.
- On the v0.2.4 arm64 package, API-context baseline, message page, search corpus and global search all failed through actual IPC with `CANONICAL_SESSION_CONTENT_UNAVAILABLE`.
- After app exit, DB integrity remained `ok`, FK check empty, invalid marker remained set, and no legacy body was written back. This validates the persisted allocator invalid-marker read gate. Owner/watermark mutation cases and the remaining R→C technical installation sequence remain open.

## v0.2.4 History session-owner drift package fault smoke (2026-10-04)

- Created a separate canonical-only profile copy and, only there, dropped the write-stop UPDATE guard and changed the context event's `session_id` to `foreign-session`, leaving stream ownership and canonical message identity unchanged. SQLite integrity remained `ok`; FK check was empty because the event owner is not a foreign key.
- On the v0.2.4 arm64 package, actual API-context, message-page, search-corpus and global-search IPCs all rejected with `CANONICAL_SESSION_CONTENT_UNAVAILABLE`.
- After app exit the mismatched event remained, the canonical-only message body was still empty, and no successful partial projection was returned. This covers one event-owner drift case; stream-owner/cursor watermark mutation variants remain to be exercised through the candidate package.

## v0.2.4 allocator cursor UPDATE/DELETE package fault cases (2026-10-04)

- Two separate copies of the schema-v46 canonical-only fixture were used. In one, `UPDATE agent_history_commit_cursor SET allocated_at=allocated_at+1 WHERE id=1` invoked the production invalidation trigger; in the other, `DELETE FROM agent_history_commit_cursor WHERE id=1` invoked the delete invalidation trigger. Both left `agent_history_cursor_integrity.invalid=1` before package startup, while SQLite integrity check was `ok`, FK check was empty, and canonical message content remained empty.
- On the actual v0.2.4 arm64 package, API-context, message-page, search-corpus and global-search IPCs all returned `CANONICAL_SESSION_CONTENT_UNAVAILABLE` in both cases.
- After package exit, both profiles still had the invalid marker and empty canonical-only message body. Together with the prior pending-allocation and direct invalid-marker cases, this covers the allocator marker gates for pending, explicit invalidation, cursor UPDATE, and cursor DELETE. Stream owner and cursor-watermark package mutations remain to be tested.

## v0.2.4 stream-owner and transcript-watermark package cases (2026-10-04)

- Stream-owner case: on a disposable canonical-only copy, dropped the stream-owner write-stop guard and changed `agent_history_streams.session_id` to `foreign-session`. SQLite integrity was `ok`, FK check empty. The v0.2.4 arm64 package's API-context, message-page, search-corpus and global-search IPCs all failed with `CANONICAL_SESSION_CONTENT_UNAVAILABLE`; the canonical-only body remained empty.
- Watermark-anchor case: on a separate copy, changed the transcript cache's `watermark_event_id` to `missing-watermark-anchor`, keeping cached message value, session sequence and commit order unchanged. SQLite integrity was `ok`, FK check empty. After v0.2.4 arm64 startup, the four read consumers returned the canonical body; inspection showed the cache watermark anchor had been restored to the real terminal event ID. Thus the bad cache anchor was not accepted as authoritative and the package rebuilt/repaired the projection from History. The message body remained empty/canonical-backed-only.
- This covers stream owner drift rejection and cache-anchor repair at package level. Remaining M2-6 work includes x64 damage cases, additional watermark cursor/global gap variants, old-profile upgrade, and the C→R→C technical installer sequence.

## v0.2.4 x64 History-context corruption package fault (2026-10-04)

- Mounted the x64 DMG and used a fresh copy of the schema-v46 canonical-only fixture. In the copy only, dropped the content-cleanup delete guard and deleted the context event while preserving the terminal event. Initial SQLite integrity was `ok`; FK check was empty. Rosetta first startup took about 40 seconds until the renderer page was ready.
- Actual x64 packaged renderer→preload→IPC calls to API-context baseline, message page, search corpus and global search all rejected with `CANONICAL_SESSION_CONTENT_UNAVAILABLE`.
- After app exit, SQLite integrity remained `ok`, FK check empty, one terminal event remained, legacy message body remained empty/canonical-backed-only, and cleanup remained complete. This closes the x64 History-context fault case; x64 spill-byte corruption and remaining cursor/watermark cases remain open.

## v0.2.4 x64 multi-spill corruption package fault (2026-10-04)

- Mounted the x64 DMG and copied the schema-v46 three-message multi-spill fixture to a fresh profile. One byte in the first 84,029-byte spill was changed only in this copy. Before launch the DB reported `integrity_check=ok`, empty FK check, three canonical-backed-only rows, and zero legacy body bytes.
- On the x64 package under Rosetta, actual API-context, message-page, search-corpus and global-search IPC calls each failed with `CANONICAL_SESSION_CONTENT_UNAVAILABLE`. An initial combined CDP batch timed out while the process was starting; retrying the same calls individually after `sessionList` was responsive returned the expected fail-closed errors.
- Post-run DB integrity remained `ok`, FK check empty, all three legacy bodies stayed empty, and cutover remained canonical/complete.
- Shutdown note: after using the app menu to quit, the candidate executable briefly reappeared without the isolated-profile arguments and its helpers showed the default lowercase `spaceassistant` userData path. I terminated those processes by exact PIDs and force-detached the read-only DMG. No writes to that default profile were observed or verified; this transient relaunch is recorded for follow-up rather than counted as a clean shutdown pass.

## v0.2.4 x64 healthy multi-spill package IPC (2026-10-04)

- Mounted the actual x64 DMG under Rosetta and opened a fresh copy of the schema-v46 canonical-only multi-spill fixture. The transcript L1 cache was absent; the profile had three 84,029-byte source-truth spills and three canonical-backed-only message rows with empty legacy bodies.
- Actual packaged renderer→preload→IPC API-context baseline, message page, and search corpus each returned all three exact 84,029-character bodies with expected message IDs and prefixes. Global search for `canonical multi spill body 0` matched `spill-user-0`.
- Profile checks after read: SQLite integrity `ok`, FK check empty, three message bodies still empty, all three rows canonical-backed-only, and cleanup complete. This pairs with the x64 spill corruption rejection case and arm64 healthy/corrupt multi-spill cases.
- Rosetta startup took roughly 35 seconds before DevTools readiness. The app did not exit cleanly through the menu/TERM during this smoke, so the exact candidate process and helpers were terminated and the read-only DMG forcibly detached. No default-profile relaunch occurred in this run.

## v0.2.4 arm64 legacy schema-19 profile upgrade (2026-10-04)

- Constructed a disposable profile using the exact v0.2.2 schema-19 base DDL and the v0.2.2 migration-chain tables/columns through v19. The fixture contained one session and two legacy-body messages with stable IDs and unique `token-19` search text. A copy of the pre-upgrade database was retained at `/tmp/session-storage-v19-profile/baseline-complete.db`; initial SQLite integrity check was `ok`, schema version `19`.
- The first fixture attempt omitted the v4–v17 tables while claiming schema 19. The real v0.2.4 package correctly migrated schema metadata but startup then failed when orphan cleanup queried the missing `turns` table. This was an invalid fixture, not a valid schema-19 profile; it was retained separately at `/Users/space/Library/Application Support/SpaceAssistant-v024-legacy-upgrade` and excluded from the pass result.
- Rebuilt the fixture in the isolated profile `/Users/space/Library/Application Support/SpaceAssistant-v024-legacy-upgrade-v2`, including the migration-chain tables and columns (`turns`, queue receipts, automation and usage tables, and session ownership/thinking fields). Started the actual v0.2.4 arm64 packaged executable with that profile. Startup reported database migration, canonical History classification/recovery, and session-ledger reconciliation `ok`; the database advanced from schema 19 to 46, `integrity_check=ok`, and both original message rows/content values remained unchanged with `content_storage_state=legacy`.
- Through the packaged renderer's preload IPC, `sessionList`, `chatGetMessagePage`, `chatGetApiContextBaseline`, and `chatGetSearchCorpusPage` returned the expected session and both exact message bodies; `searchExecute('token-19')` matched both messages. No model request was sent. This validates upgrade/read compatibility for this schema-19 legacy-body profile on arm64; it does not replace an actual old-version app-generated profile or exercise all historical profile variants.

## v0.2.4 arm64 global History cursor gap package faults (2026-10-04)

- Started from a copy of the healthy schema-v46 canonical-only profile (`e2f15c7a-4e04-4175-b51f-fbec5159da8b`; two History events, `commit_order` 1–2, allocator IDs 1–2). Used two independent profile copies; source profile was not modified.
- Interior gap copy: deleted allocator ID 1 through the v46 production trigger. Before launch the allocator integrity marker was `invalid=1`, pending cursor set empty, SQLite integrity `ok`. On the actual v0.2.4 arm64 package, API-context baseline, message page, search corpus and global search all rejected with `CANONICAL_SESSION_CONTENT_UNAVAILABLE`. Afterward the invalid marker persisted, message content remained empty/canonical-backed-only, and SQLite integrity remained `ok`.
- Trailing pending allocation copy: inserted allocator ID 3 through the production trigger without an event. Before launch the integrity marker was `invalid=0`, pending cursor was `[3]`, SQLite integrity `ok`. The same four packaged IPC consumers all rejected with `CANONICAL_SESSION_CONTENT_UNAVAILABLE`; afterward cursor 3 remained pending, message content remained empty/canonical-backed-only, and SQLite integrity remained `ok`.
- This closes the package-level global allocator interior-gap and unpaired-tail cases on arm64. It does not cover every possible session cursor/watermark mutation permutation or x64 variants; the remaining M2-6 technical installation rehearsal and candidate relaunch follow-up remain separately tracked.

## M2-6 global cursor migration regression and suite verification (2026-10-04)

- Added TDD coverage for the actual v45→v46 initial migration with pre-existing allocator corruption: an interior `commit_order` gap while allocator IDs reach the same maximum, and an unpaired trailing allocator cursor. Both cases assert the durable invalid marker and reconstructed pending set. The focused migration file passed 14/14 after the fixture was corrected to start at schema 45; no production-code change was required because v46 migration already handles both shapes.
- Full `npm test -- --reporter=dot`: 858 files passed / 1 skipped; 8,113 tests passed / 106 skipped. `npm run typecheck:renderer`, `npm run typecheck:shared`, `npm run typecheck:agent-sdk`, `npm run i18n:check:strict`, `npm run build:electron`, and `git diff --check` passed. Strict i18n reported 1,155 Chinese occurrences, all in tests and none in source.
- With schema-19 legacy profile upgrade, allocator migration regressions, and arm64 package-level global cursor interior-gap/pending faults recorded, remaining M2-6 work is session-local cursor/watermark mutation variants, candidate exit/relaunch follow-up, and the separately defined technical installation sequence. Developer ID signing and formal publication remain release-policy items, not functional-development gates.

## v0.2.4 arm64 session event cursor drift and exit follow-up (2026-10-04)

- Copied the healthy canonical-only schema-v46 fixture into independent `SpaceAssistant-v024-session-cursor-ahead` and `SpaceAssistant-v024-session-cursor-behind` profiles. The fixture has two session History events. Changed only `session_event_cursor.next_seq` to 3 (ahead) and 1 (behind); each DB retained `integrity_check=ok`.
- On the actual v0.2.4 arm64 package, API-context baseline, message page, search corpus and global search all rejected in both profiles with `CANONICAL_SESSION_CONTENT_UNAVAILABLE`. After reads/reopen, the cursors remained 3 and 1 respectively, SQLite integrity remained `ok`, and canonical-only message content stayed empty.
- Candidate exit follow-up used a fresh isolated profile and directly launched the packaged arm64 executable with `--user-data-dir` and DevTools. Startup migration/History recovery/session-ledger reconciliation logged `ok`. macOS denied AppleScript menu automation because the shell lacks Accessibility permission, so the menu Quit path could not be exercised; sent standard TERM to the exact candidate PID instead. Main PID and its helpers exited, and no candidate reappeared during a 10-second observation. The default lowercase `/Users/space/Library/Application Support/spaceassistant/spaceassistant-data.db` mtime remained at 13:06, earlier than this run; no default-profile write was observed. This closes the direct-launch TERM relaunch check only, not the menu Quit interaction.

## v0.2.4 arm64 wrong-but-existing watermark anchor recovery (2026-10-04)

- Copied the healthy schema-v46 canonical-only profile to a new disposable profile. Changed only the transcript cache's `watermark_event_id` from the terminal event to the same invocation's earlier context event; the original History remained intact, cache coordinates stayed at sequence/order 2 with event count 2, and SQLite integrity was `ok`.
- On the actual v0.2.4 arm64 package, API-context baseline, message page, search corpus and global search all returned the original canonical body. Startup/read validation repaired the cache anchor back to the real terminal event at sequence/order 2. The legacy message body remained empty with `canonical-backed-only`; SQLite integrity stayed `ok`.
- This validates recovery from a wrong but existing anchor identity rather than treating it as cache authority. It does not substitute for the still-unverified macOS menu Quit path or the technical C/R installation rehearsal.

## Current worktree schema contract follow-up (2026-10-04)

- The current TDD worktree declares `DB_SCHEMA_VERSION = 48` in `electron/database/schema.ts`; the v0.2.3/v0.2.4 package evidence above was built from earlier fixed commits and exercised schema v46. Those package runs remain valid historical evidence for those commits, but they do not prove that an R artifact can read the current schema-48 C data contract.
- The technical design's §8.8.5 R/C contract was corrected to schema 48. Any rollback-floor candidate must be rebuilt from a fixed, reviewed commit containing the schema-48 migration chain and the current History/spill/cache contract, then repeat the clean-checkout package and installed-profile drills against its paired C build.
- Decision remains **No-go**: no current schema-48 R has been fixed, released, and tested against C; no production cleanup is authorized. Developer ID signing remains a distribution-policy item and is not a feature-development gate.

## Current worktree schema contract follow-up (2026-10-05)

- 后续 M1-7 TDD 修正确认分类完成后的启动恢复 SQL 仍会枚举全部 History stream 并检查 terminal event。当前 worktree 已将 schema 提升至 v50，新增 `canonical_history_recovery_work`、独立有界且可续跑的 backfill cursor，以及 stream/event 写入触发器；分类完成后恢复只查询持久化非终态工作集和 pending repairs。
- 该变更只更新当前源码契约；本审计记录中的已打包 R/C 与安装演练仍是各自提交上的历史证据，不证明当前 schema-v50 rollback floor。§8.8.5 的 R/C 契约要求同步至 v50。尚无正式发布并通过完整兼容审计的 schema-v50 R；未迁移真实 profile，也未授权生产清理；No-go 仍有效。后续 arm64 本地技术候选见下节。

## Local schema-v50 R arm64 technical drill (2026-10-05)

- 从当前 worktree 复制 75 个已跟踪/未跟踪项目文件至隔离 clean snapshot，临时固定 commit `773f5abeeeef34c27accaf7945fdc5423fbc0ba8`；没有修改或提交项目分支。`npm run build` 通过；按项目流程准备已校验 ripgrep 后，arm64 R 候选 `release/SpaceAssistant-0.2.4-arm64.dmg` 构建成功，SHA-256 `063a78504562dc15f1a69900459ebc9ebc0be50d1d7f58039a7683b098405c7a`，`hdiutil verify` 与 app bundle `codesign --verify --deep --strict` 通过。bundle identity 显示该 snapshot SHA 且 `sourceTreeClean=true`；部署 `allowContentCleanup=false`，compatibility record 为 `null`。签名为 ad-hoc，未发布。
- 用 schema-v50 合成清理 profile（无用户数据）生成一条 `canonical/complete` 且 `messages.content=''` 的会话；从新 userData 副本实际启动包。DB/migrations、History classification、History recovery、renderer load 各阶段均 outcome `ok`。只读复核：schema 仍为 50；session 仍 `write_mode=canonical/cleanup_state=complete`；正文仍空、`canonical-backed-only`；目标 History 仍只有原 `invocation-context-committed`，R 未追加中断事件；SQLite `integrity_check=ok`，`foreign_key_check` 无行。恢复器不再为已封口 session 尝试写入。
- 首次包 smoke 在旧代码下确实触发 `canonical History writes are stopped for session content cleanup`，并将 recovery 阶段误报 degraded。该状态来自一条没有终态事件但被允许进入 cleanup 的隔离 History stream。新增 `sqliteAgentHistory.test.ts` 回归先红后绿；恢复工作集与 pending repair 选择现在排除 `write-stopped/pending/complete` session。`sqliteAgentHistory.test.ts` + `sessionStorageCutover.test.ts` 共 229 项、Electron incremental build 通过；修复后的包启动 recovery outcome 为 `ok` 且没有该错误。
- 合成 profile 的 session-ledger sidecar 使用估算器 fixture 内容，启动另有 `sessionEvents` malformed-JSON/degraded 日志；它与 canonical History recovery 无关，但本演练不据此声称 session-ledger 故障矩阵通过。仅验证 arm64、本地 v50 clean snapshot 与一个 complete 状态；没有覆盖 write-stopped/pending、C→R/R→C、全消费者安装包矩阵、正式 Accepted 审计或发布产物留存。**此演练不改变 No-go，不构成已发布 rollback floor，也不授权任何真实 profile 清理。**

## M2-6 feature/release scope reconciliation (2026-10-04)

- The current migration plan defines M2-6 as a code and isolated file-backed SQLite acceptance task and records it complete. The package-level healthy/corruption cases documented above provide additional release-audit evidence; they do not expand M2-6's feature acceptance criteria.
- Remaining package combinations and R/C installation/publication evidence stay under §8.8.5. The current schema-v48 source has not yet been paired with a published rollback floor, so this reconciliation does not authorize production write-stop or content cleanup.

## R/C technical packaging continuation (2026-10-04)

- 从当前 worktree 建立了独立 clean snapshot `/tmp/session-storage-r-c-drill-20261004`，固定提交 `c7776daeae7a922baf08f8f6f858880ea39d3945`，随后执行 `npm ci`。该提交包含当前 schema-v48 canonical reader 和默认关闭的 cleanup 配置；包资源身份为 `sourceTreeClean=true`，commit SHA 与该提交一致。
- `npm test -- --reporter=dot`：870 个测试文件通过、1 个跳过（8,182 项通过、106 项跳过）；renderer/shared/agent-sdk typecheck、normal/strict i18n、diff check 与完整 build 通过。strict i18n 中 1,155 项硬编码中文均位于测试文件，源码为 0。
- 生成本地 R 候选 `v0.2.4`：x64 DMG SHA-256 `7447a7ded7cfd62e90b657147f5b326b3930e5044d0b97918c420549e998d74d`；arm64 DMG SHA-256 `8d16c6772d312d0b6d92082da5c67abfb6e06180cb55d5cfa92edd7d06492ba4`。两包 `hdiutil verify` 通过；afterPack 资源与 ad-hoc codesign 验证通过。无 Developer ID，未发布、未安装，也未连接用户 profile；两包部署清理均关闭且兼容记录为空。
- 准备构造 C 时发现原方案的源码资源无法引用 C 自身 commit SHA：record 被纳入 commit 会自引用，commit 后再写会导致工作树 dirty 并被 afterPack 拒绝。现已用 TDD 修复打包路径：受控发布流程在固定源码 commit 后，向 gitignored `release-input/` 放置两份 JSON；afterPack 校验版本/HEAD、Accepted 结构、完整摘要和当前架构 R artifact，再复制到 bundle。无输入仍写默认关闭；错误输入使打包失败。另以临时 Git 仓库实测该 ignored input 不会污染 `sourceTreeClean`。afterPack/门禁/worker 聚焦 8 文件 31 项通过，Electron incremental build、静态边界检查与 diff check 通过。TDD 另发现并修复 afterPack 使用 `darwin-*`、runtime gate 查找 `mac-*` 的平台键错配。
- 本节新增的 R/C arm64 演练记录在下一节：afterPack 新注入路径已通过 clean snapshot 实际打包，且完成一条 synthetic schema-v48 R→C→R pending 回滚路径。UI/IPC、x64 启动、旧 schema 升级、complete/write-stopped 状态、正式 R 发布和正式 review 仍未完成。已有 DMG 都是本地 ad-hoc 候选，不是正式 rollback floor；真实用户数据 No-go 不变。

## Local schema-v48 R→C→R arm64 technical drill (2026-10-04)

- 上述 R 源码快照提交 `c7776daeae7a922baf08f8f6f858880ea39d3945` 构建 v0.2.4 x64/arm64 DMG；包摘要见上一节。C 快照提交 `c28fb58816b69138d81d3d0be8b5ad228a422d72` 构建 v0.2.5 x64/arm64 DMG：x64 SHA-256 `34780b23ccfc4a1ec09db227d444a74c470f3e892273b45ce87e859c33e41ac4`，arm64 SHA-256 `85e3e923bc558308446eba53beddcad867e1a4eca0f06bc2cff9dbc664440b0b`；四份 R/C DMG 均 `hdiutil verify` 有效。C 使用带 `TEST ONLY` review reference 的临时 Accepted metadata，仅为验证打包与 worker 流程，不代表真实 review 决定。C app bundle 的候选 commit、版本、记录摘要和 R artifact 目标哈希均与资源匹配；从两架构 bundle 读取的 runtime gate 均返回 `authorized`。
- 仅使用合成 userData `/tmp/session-storage-r-c-profile/userData`。初始 schema 48 有 2 个会话、152 条双写消息；直接打开 R arm64 DMG 启动后两会话保持 `retained`，正文完整，`integrity_check=ok`、FK 检查为空。
- 将同一 profile 交给实际挂载并启动的 C v0.2.5 arm64 包。首轮延迟 worker 将 150 条消息会话推进为 `pending`，清除首批 100 条（正文变空且标为 `canonical-backed-only`），剩余 50 条仍是双写；另一 2 条消息会话保持 `retained`。清理进度记录 `cleaned_message_count=100`、`next_sequence=99`。DB integrity 为 `ok`，FK 检查为空。未等后续周期，也未对任何用户数据执行清理。
- C 完整退出后，将相同 profile 交给实际挂载并启动的 R v0.2.4 arm64 包。R bundle gate 为 `deployment-disabled`；启动时与启动后 60 秒 `pending/retained` 状态、100 条清理计数及 100/52 的两种正文存储状态均未变化。canonical History 只读 fold 对两个会话返回 `matched`，消息数分别为 150 和 2，首尾 stable ID 与清理前 oracle 一致；DB integrity 为 `ok`、FK 检查为空。此 fold 由当前源码 SQLite History reader 直接核对，因 macOS 锁屏无法做窗口级显示/renderer IPC 点击验收，不将其记作 UI/IPC 包验收。
- 这是 schema-v48、arm64、本地 ad-hoc DMG 的技术演练；x64 C/R 只完成打包、DMG 校验和资源门禁验证，未启动安装包。没有经过正式 tag/release，没有 Developer ID 签名，也没有正式 Accepted rollback-floor 审计；C metadata 的 Accepted 值是测试输入。故该演练证明了自引用修复及一条 arm64 pending 回滚路径，但**不改变生产 No-go**，也未完成旧 schema 升级、complete/write-stopped 状态的包内回滚、完整 consumer IPC/UI 和正式 R 发布证据。

## R/C 演练发现的 worker 重新认证缺口（2026-10-04）

- 演练中的小会话在 R 重启后仍为 `retained`。隔离复制数据库复现：当 History/cache 资格已撤销且 transcript cache 行缺失时，原 worker 直接调用 write-stop 返回 `false` 并累计 `ineligible`；对同一副本先运行完整 `certifyCanonicalSessionApiRead` 后可重建 cache，再通过 write-stop。这属于 worker 恢复路径遗漏，不是清理数据不匹配。
- 已在当前 worktree 以 TDD 修复：retained 候选先经每步 release-gated `certify` 执行完整 canonical API/route 对拍及 cache seed，认证不合格继续保留；认证成功才进入 write-stop。新增认证失败统计日志。两份聚焦测试共 9 项通过；先前 R/C 安装包演练未使用该修复快照，包级演练待后续计划需要时再做，不宣称其已验证此修复。
- 此修复仅影响 packaged cleanup worker 的推进资格，不改变默认关闭配置、正式 rollback-floor 条件或真实 profile No-go。

## v295 worker 修复的 arm64 包内回归（2026-10-04）

- 从当前修复代码建立 clean snapshot，固定提交 `f6e125acea233996ac2700ba50ab40dc734e08c0`，构建本地 v0.2.6 arm64 DMG，SHA-256 `8dae5d0925570b86fec4dffdc0ed346ecfc77d8f02e285daea5b6dae360e7b88`。`hdiutil verify` 有效；afterPack 资源身份匹配 commit，包内部署/兼容记录摘要 gate 可用。使用的兼容记录明确为 `TEST ONLY`，不代表评审接受或发布放行。
- 只使用隔离 profile `/tmp/session-storage-r-c-profile-v296/userData`。启动前的小会话 `678e28c4-c8ce-43ac-808d-a52495a3cf2f` 为 `canonical/retained/revalidation-required`，API eligibility 与 transcript cache 均不存在，消息仍保留 dual-write 正文；SQLite integrity 为 `ok`。
- 实际启动挂载的 C arm64 app 并等待延迟 worker 后，该小会话 cache 被重建并推进为 `complete`；原有 pending 大会话也推进为 `complete`。152 条消息全部为 `canonical-backed-only`，旧正文总字节为 0。当前代码的 `SqliteAgentHistory.readCanonicalSessionTranscriptForShadow` 对两个会话返回 matched，消息数 2/150，首尾 stable ID 与 fixture 一致；SQLite integrity 为 `ok`，foreign_key_check 为空。应用退出后 DMG 已卸载。
- 该单架构包内测试关闭了“认证撤销 + cache 缺失”导致 retained session 不推进的具体缺口；没有执行 renderer/IPC 点击、schema 升级、正式 R/C 发布切换或正式 Accepted 审计。产物是 ad-hoc 本地技术候选，不是兼容回滚地板；生产 No-go 不变，Developer ID 仍与功能完成正交。

## schema-v48 R/C 状态与旧 profile 安装回归（2026-10-05）

- **C→R→C（complete）：**在 v295 worker 修复后的合成 profile 上，C v0.2.6 清理两个 session 到 `complete` 后，启动当前 schema-v48 R v0.2.4 arm64 包。R 的 bundle identity 为 clean commit `c7776daeae7a922baf08f8f6f858880ea39d3945`，cleanup deployment 明确关闭。R 启动和退出后两个 session 仍为 canonical/complete，152 条正文仍 canonical-backed-only、旧正文 0；History fold 对 2/150 条均 matched，DB integrity `ok`、FK 检查空。再升级 C v0.2.6 后状态与正文标记不变，未重复清列或回填。
- **schema 19 → R → restart：**使用既有合成基线 `/tmp/session-storage-v19-profile/baseline-complete.db`（初始 schema 19，DB SHA-256 `3be28ce20cbdd90a2923fa06388e63b2f616ac6a2cccf6236c3a5a798f5501c1`）建立全新 profile，通过 R v0.2.4 arm64 包启动并重启。迁移到 schema 48，`legacy-session-19` 保持 `write_mode=legacy/cleanup_state=retained`；两条消息的 stable ID、session、role、status 和正文 hex 与迁移前逐行 diff 完全相同；DB integrity `ok`、FK 检查空。
- **schema 19 → C：**用另一份独立基线直接启动 C v0.2.6 arm64 包。迁移到 schema 48 后，60 秒 worker 未将无 canonical History 的会话误认为候选，状态仍 legacy/retained，消息身份及正文与 schema-19 基线完全匹配，DB integrity `ok`、FK 检查空。
- **write-stopped → R：**在隔离副本增加名为 `test_fail_cleanup_begin` 的专用 SQLite trigger，仅令 cleanup_state 转为 pending 的 begin 事务失败；运行 C v0.2.6 的实际认证/write-stop worker 后，得到 canonical/write-stopped、游标为 0、两条正文仍为 dual-write 的真实中间状态。C 完整退出后删除该测试专用 trigger，启动 R v0.2.4 并等待完整 worker 延迟窗口；R 将 API mode 降为 `revalidation-required`，但保留 write-stopped、0 游标和双写正文，不继续清理、不回到 retained。DB integrity `ok`、FK 检查空。
- 这些结果分别填补 schema-v48 R 的旧 profile 升级、C 直接升级、write-stopped 回滚及 complete 后 C 再升级证据。仍未完成：正式 tag/release 与可长期取回的 R/C 产物、正式 Accepted 审计、同一旧状态 fixture 的实际 renderer/IPC 全消费者矩阵、完整 R→C→R/再升级矩阵覆盖其它 OS/架构及旧 schema 变体。所有部署 gate 均只由 `TEST ONLY` 输入开启；生产清理 No-go 不变，Developer ID 签名仍非功能实现门槛。


## v298 packaged consumer continuation (2026-10-05)

- 使用实际 R v0.2.4 arm64 app，user-data 参数指向 `/tmp/session-storage-r-c-profile-v298/userData` 的合成 schema-v48 副本。既有两个会话保持 canonical/complete、152 条消息正文为空。新增失败 retry fixture 含一条 canonical-backed-only user 与 failed assistant；通过 renderer `window.api.chatResolveRetryContext` → preload → `chat:resolve-retry-context` 返回 canonical 正文、message ID/role/sequence 正确；该 handler 只解析上下文，没有提交 turn 或调用模型。新增 fixture 保持 write_mode=canonical/cleanup_state=retained，正文副本为空。
- 对既有 150 条 complete 会话调用 packaged `sessionUpdate` 仅改 synthetic session title，以触发生产 debounce backup。R 的 `SessionBackupManager` 写出 150 条 `messages.json`；与同一 packaged IPC `chatGetMessagePage` 返回消息按 ID 比较，ID/role/content/timestamp/status 全部相同。初次触发发现克隆 profile 的 `config.workDirProfiles` 仍指向 `/private/tmp/session-storage-r-c-profile/userData/workspace`；修正隔离副本内 `config.workDirProfiles`/`config.workDir` 指向 `/tmp/session-storage-r-c-profile-v298/userData/workspace` 后重启 R 并再次触发。最终 150 条备份产物写入 v298 副本 workspace，并与 renderer IPC 消息按 ID 对拍一致；未访问用户 workspace/profile。
- 附件与 `imagesDeliveredToApi` 字段保持属于消息骨架的规则已有隔离投影字段矩阵测试；本轮未在实际包内驱动 vision 请求或 restore UI。已有 `sessionBackupManager.test.ts` 的 canonical-only cleanup→reopen→backup→restore 测试覆盖恢复契约。完整安装包 UI/IPC 消费者矩阵仍是发布审计证据，不作为功能代码完成门禁。退出后 DMG 卸载；v298 DB `integrity_check=ok`，两个原 complete 会话及正文清理状态未变。

- **附件/vision 字段追加（同日）：**在该 retry user 的隔离 canonical-backed-only 骨架上保存合成 attachment locator（id/stagingKey/fileName/mimeType/byteLength）及 `imagesDeliveredToApi=true`，重启 R 包后 `chatGetMessagePage` 与 `chatResolveRetryContext` 返回字段完全一致，正文仍解析为 canonical 内容。未读取 locator 指向的文件，也未发起 vision/model 请求；DB integrity 仍 `ok`，complete 原会话未变化。

- **重启后失败历史恢复读（同日）：**重新启动 R v0.2.4 arm64 包后，通过 `chat:get-turn-errors`、`chat:get-turn-displays`、`chat:list-active-turns`、`chat:get-message-page` 只读读取 retry fixture。历史分页仍返回 canonical user/failed assistant 正文、附件和 `imagesDeliveredToApi`；active/short-lived terminal 集合为空，符合完成失败历史不属于活动集合的契约。没有执行 retry/continuation。SQLite 完整性 `ok`，正文旧副本仍为空。

- **canonical-only backup restore round-trip（同日）：**将 R v0.2.4 实际生成的隔离 `messages.json` 交给当前 R/C 共用的 `SessionBackupManager.restoreSession` reader，读回 150 条；与 packaged renderer IPC 基线按 ID 对拍，ID/role/content/timestamp/status 全部一致。该 reader 只解析备份，没有向应用导入或改写 DB；因此证明生产格式与恢复 reader 兼容，不宣称存在或验证了独立 restore UI。

- **preview consumer（同日）：**R 包 `sessionList` 返回的 complete/canonical-only session preview 与 `chatGetMessagePage` 返回窗口中最大 sequence=149 的 canonical body 前缀相同。首轮误用窗口首项后按真实分页顺序更正并重跑。


## v304 packaged multi-spill consumer and warm-cache corruption isolation (2026-10-05)

- 实际 R v0.2.4 arm64 DMG SHA-256 `8d16c6772d312d0b6d92082da5c67abfb6e06180cb55d5cfa92edd7d06492ba4`；从 DMG 内读取 bundle identity 为 clean source commit `c7776daeae7a922baf08f8f6f858880ea39d3945`，版本 `0.2.4`，deployment `allowContentCleanup=false`，compatibility record `null`。这些是本地 ad-hoc 技术候选，不是发布 floor。
- 隔离 schema-v48 profile 新增 canonical-only user 与 failed assistant，正文长度 86,022/91,024，各由 source-of-truth spill 承载；messages.content 均为空。通过包内 page、API-context、retry-context IPC 后，两条正文的 length/SHA-256 与写入前 oracle 精确相同；`search:execute` 命中失败 assistant。无模型请求。
- 此 profile 读出并建立 transcript L1 cache 后复制一份，删除其中一个 source spill，在 warm-cache 副本启动同一 R 包。`chat:get-message-page` IPC 返回 `CANONICAL_SESSION_CONTENT_UNAVAILABLE`，没有返回空正文、缓存正文或触发模型请求。该副本用于故障注入，源 profile 未改动。源与故障副本 `integrity_check=ok`，共 156 条骨架 legacy 正文均为空。
- 局限：本次只覆盖 arm64 R、本 schema 48、multi-spill 读路径与缺 spill/warm-cache 拒绝；不覆盖跨平台矩阵、正式发布 floor、Accepted 审计或生产 profile。


## Local schema-v50 R-to-C-to-R arm64 technical drill (2026-10-05)

- R/C 两个 arm64 DMG 均由 clean snapshot `773f5abeeeef34c27accaf7945fdc5423fbc0ba8`（应用版本 0.2.4、schema v50）构建。R 部署配置关闭，SHA-256 `063a78504562dc15f1a69900459ebc9ebc0be50d1d7f58039a7683b098405c7a`；C 使用仅为本机演练的 `TEST ONLY` compatibility record，部署开关开启，SHA-256 `9cabd9dfb0f01771bb41ac115497286509f05a1c0697baf786d6e0c1877769d5`。C record digest 为 `d0d2333e97486956dda2bbce5dccfdc154f6e749ea9c97f2333dc6e65509ea54`，其中 R artifact 摘要与实际 R DMG 相符。两包均 `hdiutil verify` 有效；C app bundle 的 ad-hoc signature verify 通过。R/C 在本演练使用同一 source commit/version，仅 bundle 门禁配置不同；它们不是两个正式发布候选。
- 隔离 profile `/tmp/session-storage-v50-c2r-v3/userData` 从 schema-v50 开始，含一个 synthetic session、102 条 user/assistant 消息和一条正常 `invocation-context-committed` + `invocation-completed` History stream。启动前通过 API/route 认证并启用 canonical 写权威；所有 102 行为 `canonical-backed-dual-write`，DB integrity `ok`。
- 实际启动 C arm64 包并等待 60 秒初始延迟。生产 worker 将 session 推进至 `canonical/pending`：100 行改为 `canonical-backed-only` 且 `content` 字节归零，剩余 2 行仍 dual-write；progress `cleaned_message_count=100,next_sequence=99`。完整退出 C 后 DB integrity `ok`、FK 检查为空，History 仍只有原两条事件。
- 随后以同一 profile 启动 R arm64 包。通过实际 renderer→preload IPC 逐页读回 `chat:get-message-page`、`chat:get-api-context-baseline`、`chat:get-search-corpus-page`，102 条均按 ID/role/body/timestamp/sequence 与合成 oracle 精确相等，包含 100 条 canonical-only 正文；`search:execute` 命中目标消息，`sessionList` preview 等于最新消息正文。R 运行超过 60 秒后再检查：状态仍 `pending`，游标/清理计数/正文 storage state 均未变化，History event 仍为原两条；DB integrity `ok`、FK 检查为空。R 未续清、未回填旧正文，也未追加中断终态。
- 完整退出 R 后再次启动 C。其生产 worker 从原 progress 游标续跑到 `complete`：102 行均为 `canonical-backed-only`，旧正文总字节为 0，计数 102、游标 101；History event 数仍为 2，DB integrity `ok`、FK 检查为空。此结果验证同一 v50 profile 上 C→R pending 暂停及 R→C 恢复。
- 首个测试夹具草稿缺少 `invocation-completed`；R/C 的启动 recovery 正确将它识别为未终态并追加 interruption，因此该草稿被作废。正式演练 fixture 加入完成终态后重跑，未再触发恢复写入。该夹具问题不归因于应用缺陷。
- 产物留在 `/tmp/SpaceAssistant-v50-R-arm64.dmg` 和 `/tmp/SpaceAssistant-v50-C-arm64.dmg`；profile 与日志在 `/tmp/session-storage-v50-c2r-v3/`。局限：单架构、本地 ad-hoc、同 commit/version 的角色配置演练，compatibility record 为 TEST ONLY；本轮实包读路径覆盖 message page、API context、search corpus、global search 与 preview；尚未覆盖 route/reuse-user、backup/restore、retry/recovery、其它架构、正式版本/Accepted 审计、发布产物长期托管或真实 profile。故此演练推进了 §8.8.5 的本地 v50 pending 回滚技术项，但不构成正式 rollback floor，也不授权真实数据停写/清列。

## R v50 renderer preload reuse-user route and terminal status recovery (2026-10-05)

- 使用实际 cleanup-disabled R v0.2.4 arm64 app，profile 为 `/tmp/session-storage-v50-renderer-reuse-user-packaged-vision-20261005/userData` 的 disposable clone。renderer `window.api.chatGetMessagePage` 读回 canonical-only user 正文及 attachment/vision metadata；`window.api.chatSubmitOutbound` 以 `contextIntent.kind='reuse-user'` 和持久 sequence 提交后返回 `turn-started`。SQLite execution config 中出现由该正文触发的 synthetic Skill fragment，证明正文经 renderer→preload→IPC 到达本地 route。synthetic model 不受支持，调用在 provider 连接前失败；该 synthetic model 在 provider 连接前失败，没有外部模型请求。该 probe 只证明 canonical 正文通过 renderer→preload 到达本地 Skill 路由；当时未核验用户日常 provider 配置，也未验证真实模型请求、成功生成或流式输出。此项补齐此前仅直调 main handler 的 route/reuse-user 包内缺口。
- 同次包测后只读 SQLite 对拍发现两条 synthetic failed retry turn 都已 `state=terminal,outcome=failed`，其 assistant skeleton 却仍为 `status=streaming`；历史 display/page 因此可能在重启后呈现生成中。原因是 terminal turn 先持久化，assistant checkpoint 仍在 debounced 写入窗口；启动恢复只枚举未终止 turn，因而不会再收敛这些消息。此结果来自真实 R 包、隔离 profile；profile 完整退出后 `integrity_check=ok`，`foreign_key_check` 无行。
- 当前源码按 TDD 修复：`updatePersistedTurnState(..., 'terminal', outcome)` 在同一事务内更新 turn，并仅当关联 assistant 仍为 streaming 时同步其终态 status；正文、工具记录及已终止的 message status 不覆盖。status 镜像失败会回滚 turn 更新。红测先复现 streaming 与 terminal/failed 分叉；新增 9 项用例覆盖 completed/failed/cancelled/timed-out/recovered/commit-uncertain、已完成内容保护、事务故障回滚及真实文件 SQLite close/reopen；5 个套件（operations、streaming cleanup、turn coordinator/runtime/storage）共 204 项通过，`appIpc.file.test.ts` display/terminal 4 项通过。reopen 用例确认迟到 checkpoint 不能将 failed assistant 改回 streaming。测试不调用模型服务。
- 尚未将修复源码重建为 R 包，因此上述包内失败现象已确证、源码修复通过数据库/coordinator/IPC 测试，但修复后 renderer→preload 整链重跑及真实模型成功/流式行为尚未验证；包内 green 仍待后续候选验证。route probe 中 turn 的 terminal/status 分叉也未被事后修改或清理，留在 disposable profile 供复核；未触及用户 profile。此项是现有运行时终态可靠性修复，不改变 cleanup-disabled R/生产 No-go 或正式发布审计要求。

## Local schema-v50 post-fix renderer route failure recheck (2026-10-05)

- 在当前 worktree 源码上执行 `npm run build` 与 `npx electron-builder --mac --arm64 --dir`，使用临时 app `/Users/space/Documents/Develop/SpaceAssistant/.worktrees/session-storage-refactor-tdd/release/mac-arm64/SpaceAssistant.app`。bundle identity 为 version `0.2.4`、commit `2961af96b1b02e297e2478b6297e592d9d9a40fb`、`sourceTreeClean=false`；afterPack 显示清理部署关闭、compatibility record 为 `null`。该 ad-hoc app 仅作本地修复复验，不是干净候选或发布产物。
- 将此前 renderer route/reuse-user 合成 profile 复制到独立副本 `/tmp/session-storage-v50-terminal-fix-package-20261005/userData-retry`，通过包内真实 renderer `window.api.chatGetMessagePage` 读 canonical user，再调用 `window.api.chatSubmitOutbound` (`contextIntent.kind='reuse-user'`)。新 request `terminal-fix-reprobe-1791169361878` / turn `5db038ea-16b1-48cd-a924-7f1ff73d1f65` 返回 `turn-started`，随后从 active turns 消失；provider 以 `PROVIDER_ROUTE_UNSUPPORTED` 安全失败。
- 完整退出 app 后只读 SQLite 对拍：该 turn 为 `terminal/failed`，对应 assistant message `status=failed`、`content_storage_state=legacy`、legacy 正文长度 0；数据库 `integrity_check=ok`，`foreign_key_check` 为空。旧 profile 中已有的失败证据未用于判定本次结果；仅以新 turn ID 对拍。
- 本次使用 synthetic unsupported model，在 provider 连接前失败；没有验证实际服务请求、成功生成或流式输出。该缺失不影响本次终态持久化竞态复验。后续只读核对相关隔离副本发现其 service 为 synthetic（空 baseUrl、sentinel key），另有非空旧式加密凭据字段；该副本没有加载或核验用户日常 provider，故早先“无模型配置”的说法不成立；未读取/回显密钥值，也未连接外部模型或触碰真实 profile。若另需验证成功/stream 路径，先请用户协助准备专用测试 profile。

## Current-source arm64 app schema-v19 old-profile upgrade recheck (2026-10-05)

- 以只读基线 `/tmp/session-storage-v19-profile/baseline-complete.db`（SHA-256 `3be28ce20cbdd90a2923fa06388e63b2f616ac6a2cccf6236c3a5a798f5501c1`、schema 19）建立 disposable profile `/tmp/session-storage-v50-current-source-old-profile-20261005/userData`，仅复制该 DB；原始基线未被修改。使用当前源码构建的 arm64 app `/Users/space/Documents/Develop/SpaceAssistant/.worktrees/session-storage-refactor-tdd/release/mac-arm64/SpaceAssistant.app` 启动并完整退出，再启动一次。bundle identity 为 version `0.2.4`、commit `2961af96b1b02e297e2478b6297e592d9d9a40fb`、`sourceTreeClean=false`；cleanup deployment 关闭、compatibility record 为空。
- 两次启动后的 renderer preload IPC 均返回同一 session preview `Legacy assistant reply survives upgrade`；`chatGetMessagePage`、`chatGetApiContextBaseline`、`chatGetSearchCorpusPage` 返回相同两条消息，ID/sequence/role/status/content 逐字段一致；`searchExecute('token-19')` 命中两条消息。升级后的 schema 为 50，session 为 `write_mode=legacy/cleanup_state=retained/api_read_mode=legacy`，两条原消息正文及 `content_storage_state=legacy` 保持不变；`integrity_check=ok`、FK 检查为空。
- 此项补充的是当前修复源码 app 对 schema-v19 合成旧 profile 的迁移、renderer IPC 读取与跨重启稳定性；未连接模型服务、未执行模型请求或清理。包身份有脏工作树标记，不是干净 R 候选/正式 rollback floor，也不替代真实旧版本生成 profile 的证据。

## Local v346 clean-snapshot arm64 terminal-residue package recheck (2026-10-05)

- 从重构 worktree HEAD `2961af96b1b02e297e2478b6297e592d9d9a40fb`、其当前 diff 及非忽略未跟踪文件制作临时 clean snapshot；快照 commit 为 `ffd0d87a660136240b2e3079bb757e366bf51b8c`，`git status` clean。原 worktree 有未提交改动，因此该 SHA 是本地冻结验证身份，不是分支提交、审阅通过的 R 候选或发布 tag。
- snapshot 中 `npm ci`、计划 §8.8.5.B 四个聚焦文件（355 tests）、全量测试（872 files passed / 1 skipped；8,238 passed / 106 skipped）、renderer/shared/agent-sdk typecheck、普通与 strict i18n、`npm run build`、`git diff --check`、`npm run pack:mac` 均完成。DMG：x64 SHA-256 `54d9ad29be347888ca38537395b0bbf673917eaa2b1f6030c6f79096d6624e6c`，arm64 SHA-256 `f5cd8064714eba7c19b849bf63c944f44b5501aa3efe31ff124af7e327de920a`；两者 `hdiutil verify` 均有效。arm64 DMG 内 app identity 为上述 snapshot SHA 且 `sourceTreeClean=true`，`codesign --verify --deep --strict` 通过。
- 为避免把已被旧 app 修复过的 fixture 当作输入，从原 synthetic profile 建立新副本后，在副本中明确设置 turn=`terminal/outcome=failed`、关联 assistant skeleton=`streaming`，并将 workDir 指向副本 workspace。使用挂载 DMG 内实际 arm64 app，以 `--user-data-dir=<副本>` 和 `--disable-background-networking` 启动；无有效模型服务配置，测试仅等待启动恢复并经真实 renderer `chatGetMessagePage` IPC 读取，不提交 turn。结果为 assistant `status=failed`、active turn=0；关闭 app 后 SQLite 仍为 `terminal/failed` + `failed`，`integrity_check=ok`、`foreign_key_check` 无行。
- 这说明新快照包内的终态残留恢复修复已从先前 dirty-source app 复验推进到本地 clean-snapshot arm64 包，且该特定修复路径不依赖模型服务配置。它**不**验证模型 provider 连接、成功生成、流式输出、Windows 包、正式 R/C 发布、完整 §8.8.5.B 消费者/故障矩阵或真实数据清理授权。没有外部模型请求，也未触碰真实 profile。

## Local v346 clean-snapshot arm64 backup/restore consumer recheck (2026-10-05)

- 使用同一 v346 arm64 DMG/app（snapshot commit `ffd0d87a660136240b2e3079bb757e366bf51b8c`；DMG SHA-256 `f5cd8064714eba7c19b849bf63c944f44b5501aa3efe31ff124af7e327de920a`；包内 `app.asar` SHA-256 `0b6733ee9673a59a90a4381801413f7af90bb7435554230aa0ad62ce9dd9f433`）和独立 profile 副本 `/tmp/session-storage-v346-backup/userData`。目标 session 保持 `canonical/complete`，102 条 `canonical-backed-only`、旧正文合计 0、`message_count=102`。
- 真实 renderer `chatGetApiContextBaseline` 返回 102 条，顺序 sequence 0…101；经 renderer `sessionUpdate` 触发该包 backup manager 生成 `messages.json`。随后从同一候选 `app.asar` 解出 `dist-electron/electron/sessionBackupManager.js`，调用生产 `SessionBackupManager.restoreSession`。API baseline 的 Message 字段对比 backup 与 restore 均为 102 条/0 差异，message ID 顺序一致，序列顺序递增；DB `integrity_check=ok`、FK 检查为空。备份协议写入 `Message[]`，不序列化 page 外层的 `sequence`；因此单独验证数组顺序与 API page sequence，而不错误要求 JSON 中有该 IPC 元数据字段。
- 首轮脚本未将复制 profile 的 `config.workDir` 重定向到副本，导致一份 synthetic backup 写入另一处 `/tmp` 合成 workspace；检查后将本次副本 workDir 指向自己的 workspace 并重跑。该影响仅限 synthetic temp fixture，没有写真实 profile。restore reader 通过提取当前候选的生产模块在 Node 侧运行，因为 packaged Playwright main-process evaluate 不提供 `require`；restore 实现仍来自同一 app.asar。
- 本项继续证明同一候选的 canonical-only backup/restore 消费者行为，不触发模型 provider，不补足 route 成功生成/stream、Windows 安装运行、正式 R floor 或完整故障矩阵。

## Local v346 clean-snapshot arm64 renderer route/retry consumers (2026-10-05)

- 在同一 arm64 app 与隔离 canonical-only profile 上，经 renderer `chatGetMessagePage` 读取 user message `drill-retry-user-v298` 后调用 `chatSubmitOutbound`，`contextIntent.kind='reuse-user'`。请求 `v346-reuse-user-1791172231452` 返回 `turn-started`；renderer 读出的正文 `retry input from canonical`、sequence 0、附件 locator/文件名/MIME/byteLength 和 `imagesDeliveredToApi=true` 均在 IPC 入参中保持。turn 随后 terminal/failed，session event 记录 `PROVIDER_ROUTE_UNSUPPORTED`，原因是 `synthetic-route-model-v50` 不属于支持能力基线。profile 中 service 名为 `Synthetic local route only` 且 `baseUrl` 为空；服务密钥是测试 sentinel，另有非空旧式加密凭据字段（未读取或回显其值）。unsupported synthetic model 在 provider 前被拒绝，没有 provider 网络请求；该 profile 不代表用户日常配置。
- 同一包对 canonical-only retry 输入调用 `chatResolveRetryContext`，返回 canonical user 正文、failed assistant 正文、附件/vision metadata、sequence 与 exclude IDs；active turn=0、display changes=0、错误记录列表为空。route 后 SQLite `integrity_check=ok`、FK 检查为空。
- renderer 消费者复验同一 cleanup-complete profile：message page 100 条（窗口尾部到 sequence 101）、display 50 条、API baseline/search corpus 各 102 条；global search 命中尾消息，session preview 为尾消息正文。backup/restore 对拍见前一节。context-history summary 在此 synthetic fixture 为空，因此不把它记为有内容样本的消费者证据。
- 这些包测证明 renderer→preload→IPC 的 canonical route/reuse-user 前置路径及 retry/display/search/page 读点；route 在 provider 请求前拒绝，故不验证真实模型连接、成功生成或 stream。cleanup 实现仍关闭/不授权，profile 均为 synthetic disposable clone。

## Local v346 clean-snapshot arm64 cold/warm/API-switch consumers (2026-10-05)

- 以 canonical/complete 的 102-message synthetic profile 建立新的 disposable clone，初始 `messages.content` 总字节为 0。配置 API read 开关为 true 并删除该 session 的 transcript projection cache 后启动 v346 arm64 包；renderer page/API baseline/search corpus/display/global search/preview 均可读取 canonical 正文，page 100 条（保留当前窗口）、API/corpus 102 条、display 50 条，尾消息被搜索命中且 preview 一致。首次访问重建 cache。
- 完整退出后重启同一包，暖 cache 读取与冷读归一化后的 page/API/corpus/display/search/preview 完全一致。关闭 `config.sessionStorageCanonicalApiRead` 并再次重启，所有上述结果仍逐项相同；API/corpus 正文未变空。最终仍 102 行 canonical-backed-only、legacy body 0；`api_read_mode=revalidation-required`、`write_mode=canonical`、`cleanup_state=complete`；SQLite integrity `ok`、FK 检查为空。
- 此项是本地 arm64 候选及隔离 profile 的 L1/L2、重启、API kill-switch reader 证据；不代表冷 OS 缓存、其它架构、发布 rollback floor、provider 成功生成/stream 或生产清列授权。

## Local v346 clean-snapshot arm64 source-spill and History fault isolation (2026-10-05)

- 使用 v346 arm64 包、从 `/tmp/session-storage-v50-fault-source/userData` 派生的两个相互独立 synthetic 副本。损坏目标为 canonical/complete multi-spill session `b1e0aa7e-1739-4229-9163-1d680eacf53b`，同库健康对照 session 为 `61c4760b-281d-4ba2-b629-6fe4aee7a562`。
- 副本一删除 History 所引用的 source spill `9365a946-c49a-49de-a84b-a052affb5e9f.spill`，保留另一 spill 与持久 L1 cache。实际包启动后 message page、API context、search corpus、global search 四个 IPC 均返回 `CANONICAL_SESSION_CONTENT_UNAVAILABLE`；健康 session 的 page 仍返回两条消息。
- 副本二经 SQLite 把目标 invocation 的 `invocation-context-committed.payload_json` 改为 `{}`。更新 trigger 使目标 projection cache 变为 0。实际包的相同四个 IPC 均 fail closed，健康 session 仍可读两条消息。
- 两副本 canonical-backed-only 行 legacy 正文均为 0，`PRAGMA integrity_check=ok`、`foreign_key_check` 无违规；fault 未跨 session 污染。仅验证 arm64 本地候选上的这两种故障，不替代 owner/watermark/allocator 全矩阵、Windows 实包、正式发布或清理授权。没有 provider 请求。

## Local v346 clean-snapshot arm64 owner/watermark/allocator fault matrix (2026-10-05)

- 对 event owner 与 stream owner 分别建副本，通过真实 SQLite UPDATE 将 `drill-multispill-invocation-v304` 归属改到 `foreign-session-v50`。v346 包的 page/API/search-corpus/global-search 四个 IPC 均返回 `CANONICAL_SESSION_CONTENT_UNAVAILABLE`；健康 session 仍可读取。两库 integrity `ok`、FK 无违规。
- watermark 副本将 projection cache 的 `watermark_event_id` 改为不存在的 `missing-v50-watermark-anchor`。v346 包启动后从 L2 History 重建 canonical transcript，读取 user/assistant 86,022 与 91,024 UTF-8 bytes；SHA-256 分别为 `c309d69444769d01247f32b6e2d7eee380b85a3e327324e1cccf3a975d5c7539` 与 `bc27e7d549366c2d23a2091ee4ff3ba7cf9b8e2bff62d4903a40a01546a9fe04`。重开前 cache anchor 错误，重开读取后修复为 History event `drill-multispill-invocation-v304:history:2`，两正文消费者均无差异；DB integrity `ok`、FK 无违规。
- allocator cursor 的 `id=1` 另在两个副本分别直接 UPDATE `allocated_at`、DELETE。SQLite trigger 两者都持久置 `agent_history_cursor_integrity.invalid=1` 并清空 transcript cache；v346 包四个正文 IPC 均 fail closed。app 重启后 marker 仍为 1、cache=0；两库 integrity `ok`、FK 无违规。由于该标记是全局 allocator 完整性围栏，本用例只证明 canonical reader 拒绝，不把同属 canonical 的其它 session 误报为健康可读。
- 这些结果补足 v346 候选的 owner drift、watermark anchor、allocator cursor update/delete 子项；global commit-order gap、配对/未配对 cursor、v45→v46 包内迁移重建 marker 与 Windows 包仍待。均为隔离 synthetic profile，无 provider 请求。

## v50 same-profile consumer continuation and terminal-residue recovery (2026-10-05)

- 使用 clean-snapshot R v0.2.4 arm64 DMG（SHA-256 `063a78504562dc15f1a69900459ebc9ebc0be50d1d7f58039a7683b098405c7a`，schema v50）打开独立 profile 副本 `/tmp/session-storage-v50-full-consumers-20261005/userData`。profile 中目标 session 为 `canonical/complete`，102 条消息均 `canonical-backed-only` 且 legacy 正文长度为 0。经真实 renderer `window.api.sessionUpdate` 触发生产 debounce backup 后生成 `messages.json`；R renderer 的完整 API-context oracle 与备份逐字段/顺序比较 102 条、差异 0。将同一 R 包 `app.asar` 中的 `dist-electron/electron/sessionBackupManager.js` 解包后，由其生产 `restoreSession` 读取该文件，仍为 102 条、与 renderer oracle 差异 0。restore 是只读，不将消息导回数据库。
- 在同一 clean R 包的隔离 retry profile `/tmp/session-storage-v50-full-consumers-retry-20261005/userData` 上，实际 renderer preload IPC 的 `chatGetMessagePage` 与 `chatResolveRetryContext` 恢复 canonical user 与 failed-assistant 正文；user 的附件 locator/vision 标志和失败消息身份保留。`chatListActiveTurns`、`chatGetTurnDisplays` 均为空，`chatGetTurnErrors` 为空，符合该历史失败 turn 的运行期集合语义。与此同时发现第三条 assistant 骨架仍是 `streaming`，其关联 turn 已 `terminal/failed`；R 包重启前后均未收敛。该旧终态不一致与模型服务配置无关；该 probe 未发送模型请求，也未核验日常 profile 的模型配置，不能据此断言没有有效服务。
- 按 TDD 修复 startup residue recovery：当 streaming assistant 关联的 turn 已持久终止时，依据 `turns.outcome` 将消息收敛到 completed/cancelled/failed；失败/取消继续将未终结工具骨架标为 interrupted，completed 保留终结工具状态，不重写 turn outcome 或 History。测试先以“recover 返回 0、finalizer 未调用”红测复现；修复后 `turnCoordinator.test.ts`、`turnCoordinatorStorage.test.ts`、`operations.test.ts` 共 188 项通过，Electron incremental build 通过。另有 completed 工具骨架保真测试。
- 用当前源码重打的 arm64 app（`release/mac-arm64/SpaceAssistant.app`；version `0.2.4`，commit `2961af96b1b02e297e2478b6297e592d9d9a40fb`，`sourceTreeClean=false`；cleanup deployment `false`，compatibility `null`）在同一 retry 副本重启后，经 renderer IPC 确认该残留变为 `failed`，turn 仍为 `terminal/failed`，错误记录保留，History 仍 2 条；SQLite `integrity_check=ok`、FK 检查为空。当前本地包只证明源码修复的隔离运行行为；旧 clean R 未包含修复，必须在后续固定干净候选后重建并复验，不能作为 rollback floor。
- 该轮补充了 canonical-only backup/restore 和 retry reader 子项，并发现/修复旧终态恢复缺口；它**不等于完整全正文消费者/故障矩阵通过**。R/C 正式发布、Windows 实际安装、真实 profile 只读审计、其余同候选故障矩阵及生产清理仍未放行。原始 profile、用户模型配置和真实数据均未触碰。

## Local v346 clean-snapshot macOS x64 consumer/fault continuation (2026-10-05)

- 使用与 arm64 相同的 clean snapshot `ffd0d87a660136240b2e3079bb757e366bf51b8c` 构建出的 x64 DMG `/tmp/session-storage-refactor-clean-v345-20261005/release/SpaceAssistant-0.2.4.dmg`，SHA-256 `54d9ad29be347888ca38537395b0bbf673917eaa2b1f6030c6f79096d6624e6c`。包内主程序为 x86_64；在 Apple Silicon 上经 Rosetta 启动。DMG `hdiutil verify` 与 app `codesign --verify --deep --strict` 通过；build identity 的 `sourceTreeClean=true`、commit 为上述 SHA，app.asar SHA-256 `0b6733ee9673a59a90a4381801413f7af90bb7435554230aa0ad62ce9dd9f433`；清理部署关闭、compatibility record 为 null。
- canonical/complete synthetic profile 经 renderer→preload→IPC 得到 page 100、display 50、API context/search corpus 各 102 条；尾消息 global search 命中，session preview 与尾消息正文一致。该读取只用于本机隔离副本；profile 的 workDir 已改指向每个测试副本自身目录。
- 同一 x64 包触发生产 backup writer，产生 `messages.json`；从同一包 `app.asar` 提取的生产 `SessionBackupManager.restoreSession` 读取该备份。另由 x64 renderer IPC 生成完整 102 条 oracle；oracle、备份 JSON 与 restore reader 的 Message 字段差异均为 0，数组顺序对应 sequence 0…101。首轮 probe 的 restore 调用误在无 `require` 的 renderer evaluate 中执行；改为从包内 JS 模块独立调用后通过。
- 分别用独立副本验证 source spill 缺失、History payload 损坏、History event owner 漂移、stream owner 漂移：每项的 message page/API context/search corpus/global search 四个 IPC 均以 `CANONICAL_SESSION_CONTENT_UNAVAILABLE` fail closed；同库健康 session 仍可读取。watermark anchor 损坏后，两条正文分别恢复为 86,022/91,024 UTF-8 bytes，SHA-256 为 `c309d69444769d01247f32b6e2d7eee380b85a3e327324e1cccf3a975d5c7539` 与 `bc27e7d549366c2d23a2091ee4ff3ba7cf9b8e2bff62d4903a40a01546a9fe04`。
- allocator cursor UPDATE 与 DELETE 副本、直接置 `invalid=1` 的副本、global commit-order gap 副本、unpaired cursor 副本的四个正文 IPC 均 fail closed。直接置 marker 的首轮 probe 错用了不在该 profile 的 session ID，造成空页返回；改用副本内真实 session ID 后重跑，四个 IPC 均拒绝。退出后 UPDATE/DELETE 副本 marker 均为 1 且 cache=0；unpaired allocation 保留 pending=1、marker=0；各副本 `PRAGMA integrity_check=ok`、foreign-key violations=0。
- 从全新 v46 migration baseline 构造真正 schema-v45 fixture（History commit_order `1,3`、cursor `1,2`），由 x64 包首次启动迁移至 schema 50。结果为 `invalid=1`、pending cursor `2`，原 event/cursor 保留；integrity `ok`、FK 为空。先前误用的 profile 已经被 arm64 迁移过，不纳入本次结果；本次改用全新副本完成。
- 本轮只覆盖 macOS x64 可本机运行的 reader/fault 子集；不包括 Windows 包或 Windows 主机测试。retry/recovery、terminal 残留恢复与 cold/warm/API-switch 在该架构未单独复验；retry probe 的隔离副本使用空 baseUrl 的 synthetic service/sentinel，另有非空旧式加密凭据字段；x64 主线程采样显示停在 macOS Keychain `SecItemCopyMatching`，renderer preload 未就绪。SIGTERM 无效后仅终止该 `/tmp` 测试进程，并复查副本 DB integrity `ok`、FK 为空；这不是 retry 行为通过/失败证据，也没有模型网络请求。route 的成功生成/流式体验未在该架构单独复验；存储检查本身不需要 provider 请求。没有读取/回显密钥值、触碰真实 profile 或执行生产清理。

### x64 retry/recovery、终态残留与 cache/API 开关续验

- 为 retry reader 单独创建不含 provider 配置的 disposable clone，x64 包的 renderer IPC `chatGetMessagePage` 与 `chatResolveRetryContext` 返回 canonical user 和 failed-assistant 正文；附件 locator、vision 标志、sequence、exclude IDs 保留；active/display/error 列表符合失败 turn 语义。未调用模型服务。
- 在另一 disposable clone 将 turn 设为 `terminal/failed`、assistant 骨架设为 `streaming`，x64 包启动后通过 renderer IPC 观察到 assistant 收敛为 `failed`；turn 仍为 terminal/failed，active/display 为空，DB integrity `ok`、FK 检查为空。
- x64 包冷启动重建 L1、重启读取 warm cache、再关闭隔离副本的 `sessionStorageCanonicalApiRead` 开关重启。三次 page/API/corpus/display 计数均为 100/102/102/50，global search 与 preview 正确，cold/warm 规范化 JSON 字节一致；关闭 API read 后仍为 canonical API revalidation-required、write mode canonical、cleanup complete，目标 session 102 行 legacy content 字节为 0，DB integrity `ok`、FK 为空。
- 另一个保留 synthetic service 元数据的 route 探针在 Keychain `SecItemCopyMatching` 阻塞，preload 未 ready；未获得 route 结果，也未发 provider 请求。已结束仅属于 `/tmp` clone 的卡死进程并核验 clone DB integrity `ok`。不把该探针归类为配置缺失或功能失败，不再重试此 profile；如未来确需成功/流式模型测试，先暂停并由用户协助配置专用测试 profile。
- 以上项目均可在本机 macOS x64/Rosetta 执行；Windows 原生安装和运行继续移交 Windows 主机/CI。
