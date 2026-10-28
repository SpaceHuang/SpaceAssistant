# P4-03 macOS 安装包验收记录

## 打包 Long Task/LoAF observer 的隔离窗口复核（2026-10-28）

arm64 PKG identity clone 在隔离合成 profile 中完成 8 次普通/大历史交替窗口点击，目标内容均可见；关联到这组操作的 9 条 main/renderer trace 全部成功，renderer `next-paint` p95 为 12.7 ms。observer 在启动阶段记录 90/309 ms Long Task 与 91.6/312.3 ms LoAF；这四条发生于重复点击区间之前，不能归因到会话切换。切换区间没有 ≥50 ms 长任务记录。

该 profile 的每次 ledger gate 均为 `blocked / ledger_missing`，所以样本不代表健康大历史；CUA click+AX 耗时含自动化读取等待，不作为真实用户延迟。该证据仅确认诊断 observer 已随包运行并将脱敏事件写入日志。AC-7、P4-02 和 P4-03 均保持未完成；数据、包身份与限制见 [external-performance.md](external-performance.md) 和 [package-long-task-observer-switch-sample-identity-clone-2026-10-28.json](package-long-task-observer-switch-sample-identity-clone-2026-10-28.json)。

### 唯一 identity clone 的真实历史与 DevTools 录制补测（2026-10-28）

使用最新 arm64 包的唯一 identity clone 和真实库隔离副本，窗口中交替点击 150 条与 28 条会话 10 次。main handler、renderer page request、next-paint 的 p95 分别为 12.87、19.8、19.4 ms；10 次均走 `cachePath=cold`，同区间 Long Task observer 为 0。日志同时有 5 次 `ready` 和 5 次 `ledger_missing`，且不记录 session ID，无法验证各规模组都是健康来源，因此不将这些数字视为健康大历史的验收数据。

另外 8 次交替切换的 DevTools Performance Insights 报告 INP 64 ms；轨迹中 319.8 ms `RunTask` 包含 `CpuProfiler::StartProfiling`，其余长任务未与切换阶段建立可靠关联。短录制不能用来认定会话切换触发了这些长任务或确定其源码来源。隔离信息、阶段统计、临时 trace 删除与限制见 [package-real-history-switch-profile-identity-clone-2026-10-28.json](package-real-history-switch-profile-identity-clone-2026-10-28.json) 和 [external-performance.md](external-performance.md)。测试应用已退出；不发送 IM 消息。P4-02/03 与 AC-7 继续未完成。

随后仅在该隔离 profile 内删除 1000 条会话的投影缓存并保留 canonical source，触发包内 cold rebuild。两段 slice 为 140.59/1,503.57 ms，状态最终 `valid`；设置页 AX 于 CUA 调用后 777 ms 返回，早于最终 slice 完成。observer 同期报告 320 ms Long Task、324.7 ms LoAF（blocking 270.2 ms）。该 PKG 尚无脚本归因字段，所以当前无法确认长任务是否由投影重建导致；该时间重叠也不是因果证明。合成夹具 ledger gate 为 `ledger_missing`，本项不是健康历史验收，也不关闭 AC-5/AC-7。

随后为诊断长任务制作的 arm64 PKG 在隔离 synthetic profile 再次 cold rebuild：projection slices 为 196.02/742.56 ms；renderer 报告 304 ms Long Task 与 507.1 ms LoAF（blocking 255.4 ms）。LoAF observer 的来源摘要为 `unavailable`，DevTools 只读查询确认 7 条 buffered 条目 `scripts.length` 都为 0，当前 Electron/Chromium 没有提供脚本来源，仍需 CPU profile 才能归因。该轮首屏请求而非用户主动切换，且 ledger gate 仍失败，不能作为 AC-7 健康历史验收。

## 解锁后隔离 PKG 窗口补测（2026-10-28）

设备解锁后，最新候选 build ID `eb0aac8b-6f5b-496c-ba11-f45f194f9584` 的 identity clone 已成功显示窗口。应用使用隔离 userData `/Users/space/Library/Application Support/sap4test202610`；克隆数据库的当前工作目录 profile 已改指向 `/tmp/spaceassistant-p4-ui-isolated-workdir`。飞书和微信均关闭。用两条合成占位会话交替点击 30 次（64 条与 8 条各 15 次），所有目标正文末尾均正确显示；点击后设置页可以打开。内部追踪的大/普通样本 renderer `next-paint` p95 分别为 14.9/11.7 ms；其他分段与完整统计见 [external-performance.md](external-performance.md) 和 [package-ui-switch-isolated-identity-2026-10-28.json](package-ui-switch-isolated-identity-2026-10-28.json)。

CUA 点击到完整 AX 树读取的 p50/p95/max 为 501/553/614 ms，设置页同测 761 ms；它们含自动化读取等待，不作为真实点击延迟。该轮无 Long Task/LoAF observer、未启用维护竞争、未测缓存矩阵，也无同库基线。故只记录热缓存合成会话窗口可交互与正文显示检查，不将其视为 AC-7 或安装包验收完成。

## projection rebuild 期间的设置页前台竞争（2026-10-28）

用 build ID `eb0aac8b-6f5b-496c-ba11-f45f194f9584` 的隔离 identity clone，在独立 userData `/Users/space/Library/Application Support/spaceassistant-p4-maintenance-20261028` 上运行。1000 条 canonical-backed-only 合成会话冷读成功，projection worker 将状态从 absent 推进到 rebuilding，再于 643 ms 后发布为 valid。设置页点击开始于 rebuilding 状态采样前 38 ms；设置页完整 AX 树于发布前约 130 ms 已返回，证明 UI 在该后台重建期间仍能完成一次前台导航。工作目录为 `/tmp/spaceassistant-p4-maintenance-ui-workdir`，IM 集成关闭；运行前备份 profile，正文来源未变，仅清除该合成会话 projection cache/state。包内 main JS 哈希、状态时间线和 trace 见 [package-maintenance-ui-settings-overlap-identity-clone-2026-10-28.json](package-maintenance-ui-settings-overlap-identity-clone-2026-10-28.json) 与 [external-performance.md](external-performance.md)。

该 CUA 点击到完整 AX 树耗时 551 ms，包含自动化等待；样本仅一次，没有 Long Task/LoAF 观测，也没有同库基线，不能作为 AC-7 性能门槛或整体验收结论。

日期：2026-10-28
状态：**验收核销已完成；性能验收未通过（AC-7 未验收），不构成发布批准。**

## 核销结论（2026-10-28）

本记录汇总当前 macOS 范围内的安装包和隔离副本证据。P4-02 的单轮配对尝试已按停止条件结束，结论为“未验收”；AC-7 未通过。不同健康状态、代理口径或合成夹具的样本不拼接为配对结果。现有证据有切换期间超 50 ms Long Task/LoAF，但没有可归因调用栈。旧全量测试失败数字仅作历史记录，不能代表修订后的当前全量状态。该记录不代表性能通过、发布批准或生产启用。

随后按 RED 复现并修正 `ChatView.queuedBar` 对新增 `selectionToPageRequestMs` trace 元数据的过窄参数断言；`npm exec vitest run src/renderer/components/Chat/ChatView.queuedBar.test.tsx src/renderer/services/sessionSwitchTrace.test.ts` 通过（31 项）。另将 7 个迁移测试中固定写死的 schema 116 期望改为 `DB_SCHEMA_VERSION`；与上述渲染测试合并运行的 9 个文件共 117 项通过。canonical-only 正文编辑相关的两个测试文件仍有契约问题：将测试暂时改为当前“清空旧镜像”的预期后，重开再认证返回 `ineligible`，不能证明 API 读路径仍能取到新正文；相关测试断言已恢复，未把该问题归为单纯过期测试。没有重跑全量套件，最终失败数待确认。

随后针对 AC-6 源编辑路径补充 TDD 回归：RED 显示 canonical-only 编辑后重开再认证以 `api-context-not-matched` 拒绝；修复 shadow 比较，使它仅在 canonical 写权有效、cleanup 为 retained 且 SQLite 正文为空时把 History 正文视为该消息的权威值。消息身份、角色、时间戳及 canonical route 成员仍参与校验；canonical-only 状态不满足这些条件时继续拒绝。canonical edit / cleanup / IM attribution / storage 回归合并 3 个文件共 152 项通过；`npm run build:electron:incremental` 及 31 个 session-storage 边界探针通过。源码修复当时尚未进入候选包；后续完整构建和 PKG 哈希核验见下文。没有重跑全量测试；此修复补齐源码 AC-6 子项，不改变 AC-7 未通过的验收结论。

## 已完成的本机准备与可采信证据

### 本机关联回归与 AC-6 修复包（2026-10-28）

修正 canonical-only 编辑后重开认证失败后，`npm run test:related -- $(git diff --name-only -- '*.ts' '*.tsx')` 覆盖 485 个测试文件：6,086 项通过、137 项跳过、10 项失败。失败集中于 `ChatView.scrollToLatest` 的 mock 从被页面加载清空的 Redux 状态读取消息、hosted integration 仍期望 canonical-only 行保留旧 SQLite 正文镜像，以及 projection supervisor 的 due-retry 用例在并行负载下超时。将页面 mock 改为独立夹具、按 canonical-only 契约更新镜像断言后，三个受影响测试文件定向复跑 155 项通过；due-retry 在该定向运行中也通过。未重跑 485 文件集或全量套件。

随后 `npm run build` 通过，包含 31 个 session-storage 边界探针；当前 arm64 PKG 已重打，build ID `034a7925-2e8a-4b35-9f42-76d3af1fe041`，PKG SHA-256 `30f8b64f47dd947ddadd090a381322fc9f508566bb8ec4dab85525c7d5d5f856`，app.asar SHA-256 `7733ce26f41948b681338b450cded5adeb04f7d4c9c04dc44fba3fe7b4dfe259`。PKG 内 `sessionStorageShadow.js` 与本次 `dist-electron` 编译文件 SHA-256 均为 `bd27fd7ddee30344932fb4a658deb893aa47d22b4d8abc2d308560fa157fb6d8`；app bundle 严格签名结构校验通过。工作树有未提交改动，PKG 未安装、未启动，故这只证明修复进入候选包，不构成包内行为或 AC-6 UI/IPC 验收。AC-7 仍未通过。

- 所有运行验收均使用隔离数据库副本；未把用户原始数据库交给验收应用。
- 最新候选 build identity：`3817abb0-b0b3-4bd6-9b34-964550c2d40f`，版本 `0.2.9`，源码提交 `6570771d54ba667b00c4436e83c6c6c1c903715b`，构建时工作树干净。
- 最新 arm64 PKG SHA-256 为 `d21aa292afefcced83f2d49fbe78487a15ece142cebe80fe9138b4f24338ecc1`，PKG 内 `app.asar` SHA-256 为 `dbe16e0c955b0b143e34cc7283fff0db1f88c4d2e2256903ea2ea163be7e67c1`。`codesign --verify --deep --strict` 通过；无 Developer ID 身份，属于 ad-hoc 隔离候选，不是已签名公证的发布包。
- 前一候选包内分页代码在隔离真实库 APFS clone 上执行 `readChatPageAfterPreparation`：大/普通会话 cold-projection source-page 各 30 次，p95 为 3.71/4.96 ms。该共享主进程实现与当前 v7 相同；测量使用 Electron 44.1.1 / Node 24.19.0，不包含点击到首帧、React 渲染、跨进程等待或维护竞争。
- 前一候选包内 `readCanonicalCompactionReplay` 在同一真实库副本上，大/普通会话各 10 次 p50 为 13.65/8.19 ms。此前包 `410a14dd` 的 15 次 ledger 检查均为 proof reuse，没有重复 baseline；该包仍记录一次 845 ms event-loop delay，来源未确定。
- P4-02 的完整证据和限制见 [external-performance.md](external-performance.md)。视口回归修复的定向测试、类型检查、完整构建和新候选 PKG 校验均通过。
- 较早的点击测量使用隔离目录 `/tmp/spaceassistant-p4-validation/copies/candidate-v6`；该状态已由下方最新候选 v7 的复测更新。
- 前一候选启动后日志确认 build ID `c3d37a41-8a08-46e0-b327-52800a4d494d`。两次启动都自动请求初始会话页（各自 `requestOrdinal=1`），观测值分别为：main 9.94/3.86 ms、renderer page request 40.8/66.2 ms、render commit 21.9/6.4 ms、next paint 14.7/11 ms。启动期另观测到 ledger proof reuse 135 ms 与 41 ms，recovery completed 6 ms 与 5 ms。辅助功能看到进程可见但没有窗口，故两条 trace 都只是启动初始页，**不是会话切换样本**，不纳入 AC-7 的点击到首帧统计。日志位置：`/tmp/spaceassistant-p4-validation/copies/candidate-v6/workspaces/2/.agent/logs/Agent-20261027.log`。
- 较早启动期辅助功能不可见窗口的限制已由后续真实界面点击样本取代，历史启动 trace 保留作启动数据，不纳入切换统计。
- IM 验收经用户澄清后标为**不适用**：本项目没有专用私聊或群聊 sandbox 会话。此前授权仅限 sandbox 测试消息；不向任何真实会话发送测试消息，也不再把提供 sandbox 账号/会话作为继续条件。

## 尚未完成的安装包验收

用户已确认设备解锁。本轮通过 arm64 PKG payload 的唯一 identity clone，完成 8/64 条 synthetic 热缓存空闲样本，以及 64 条目标会话在另一会话投影重建期间的 34 个有效窗口重叠样本。identity clone 修改了包名并 ad-hoc 重签，不等同于原样安装包身份。完整矩阵、健康真实历史、同源同规模基线和其余包内故障场景仍待完成，因此本报告不把部分窗口样本写成完整界面验收。

真实历史补测（2026-10-28）：当前 arm64 PKG payload identity clone 在真实历史 profile 的 APFS COW 副本上交替切换 8 条与 64 条消息会话 8 次，8/8 main/renderer trace 成功，main handler p95 11.6 ms、renderer page request p95 19.2 ms、next-paint p95 7.1 ms；全部走 cold 路径，逐次目标正文标记未核对。副本与来源 profile 的 messages、History、body locator、source-event 行数及摘要匹配，数据库 `quick_check=ok`。应用使用明确指定的隔离 userData，未触碰默认库。此候选包单边样本没有同库基线，不能关闭 AC-7。证据：[package-real-history-ui-switch-eight-identity-clone-2026-10-28.json](package-real-history-ui-switch-eight-identity-clone-2026-10-28.json)。

该 profile 后续复开诊断发现全局启动恢复为 `degraded`、142 项 History repair failure，且默认打开的 legacy 会话因缺少 `events.jsonl` 显示 `ENOENT`；这次未执行切换，明确排除出验收。故前述目标会话的局部 source/ledger 状态不能证明整份真实历史健康。进一步 AC-7 真实历史测量需使用健康隔离快照；诊断记录：[package-real-history-profile-reopen-diagnostic-identity-clone-2026-10-28.json](package-real-history-profile-reopen-diagnostic-identity-clone-2026-10-28.json)。

随后在应用备份目录找到 schema 102 的冻结源（SHA-256 `7c11d494879cbbf64b3761e9092d5a7dafb4135253a794cd5ed3826ee5f0d399`），分别建立基线与候选 COW 副本。旧基线 `109a9384` 在隔离库上迁至 schema 107、启动恢复 ready，目标 150/8 条会话均显示正文；基线 latency 本轮未重测。当前候选包在副本上完成 30 次大页和 31 次普通页切换；AX 快照分别观察到 30/30 与 30/31 次消息容器，1 次普通页首次快照未显示正文容器、复切成功。63 个 main trace 均成功、全为 cold；stage-sum ready proxy p95 为 48.0/49.4 ms。候选库整体 degraded 146 项，150 条大历史目标实际无 History events、source backfilling、ledger blocked；因此这是 legacy fallback 观测，不是健康 canonical 大历史或 AC-7 配对对照。没有重测 baseline p95、hot/damaged/maintenance 完整矩阵、精确逐次正文标记与可信点击状态；P4-02/P4-03/AC-7 继续未完成。身份、精确分位数及限制：[package-frozen-real-history-current-candidate-identity-clone-2026-10-28.json](package-frozen-real-history-current-candidate-identity-clone-2026-10-28.json)。

以下项目仍未完成：

1. 同一来源、同一数据库上的完整首次访问、热缓存、损坏缓存及维护对照矩阵仍未完成。已有 arm64 PKG payload identity clone 的 synthetic 部分格：cold 首页面 n=30、hot 切换 8/1000 条各 n=30、损坏 inline cache 切换 n=30；64 条目标会话另有 idle n=30 与另一会话投影重建期间的有效重叠 n=34。它们没有健康真实历史和同源基线包，不能替代 AC-7 矩阵。已采集的 105 次 cold 页切换也不能单独关闭验收；按方案 §2 对适用格继续记录失败率与 p50/p95/max。
2. 已完成同一冻结备份来源的基线/候选真实窗口点击代理比较，细节见下方“同源基线与最大历史窗口点击补充”。因两版最大会话规模不同，且指标截止双帧而非正文首屏 ready，该证据不能关闭 AC-7；仍需按方案口径测量内容 ready 与缓存/维护场景。
3. 切换期间长任务的调用级归因与完整维护矩阵仍缺。已有一项包内投影重建竞争格：64 条目标页面请求 34/34 与另一会话的重建窗口重叠且成功，无 Long Task/LoAF observer 记录；它没有覆盖 source locator backfill、其他维护类别或真实历史。另有 1000 条 canonical 会话重建记录：两段 slice 合计 538.9 ms；重建期间进程树 RSS 9 点 p50/p95/max 为 894.2/899.2/899.2 MiB，启动全过程 max 为 1039.4 MiB（RSS 相加重复计算共享页），但该短窗口未并发触发前台请求。随后增加了投影缓存损坏/恢复时 27.97 秒维护窗口与等长 idle 窗口的匹配进程树 RSS 子格，p95 差 1.56 MiB、max 差 1.97 MiB；该 synthetic cell 不替代真实历史和其他维护类型。此前无维护时 4 进程 30 秒样本及设置页数据见 [external-performance.md](external-performance.md)。
4. AC-5 取消等待者有源码回归覆盖：`projectionForegroundWorkerBudget.test.ts` 验证取消排队 waiter 不会停止相邻请求；`ensureView.test.ts` 验证取消一个调用者不会取消共享准备。本轮合并定向运行 2 个文件、7 项通过。公开 preload 页面 API 不接受取消信号，因此不制造包级伪造取消样本。包级数据库切换已通过生产 `window.api.storageCompact()` 核验：实际 Worker/VACUUM/close→换入→same-object reopen 后，同一 app 实例的页面与 API baseline 继续返回同一会话消息；冷重启后正文尾标记仍一致、`quick_check=ok`，源/候选 raw rows 哈希一致。该 synthetic clone 样本不是安装后 PKG，也不覆盖活动 Worker 关闭时序、全库健康或 AC-7；完整证据：[package-ac5-storage-compact-reopen-identity-clone-2026-10-28.json](package-ac5-storage-compact-reopen-identity-clone-2026-10-28.json)。本轮 TDD 发现生命周期 `quiesce()` 拒绝会向主进程冒泡、成功收尾仍遗留截止 timer、单个 `stop()` 同步抛错会阻断其余任务停机；增加 `failed` 停机结果，捕获收尾拒绝、继续通知其他任务、清理 timer，并使主进程失败时跳过 DB close。三项 RED 均由 `lifecycle.test.ts` 复现；最终 lifecycle/ports/worker-exit-barrier/supervisor 共 4 文件 36 项通过，`npx tsc -p tsconfig.electron.json --noEmit` 通过。最终补入 `stop()` 同步异常保护后，`npm run build` 通过（含 31 个边界探针），并已重建 arm64 app bundle。这是源码关闭异常路径证据；活动 backfill worker 的包级关闭与恢复另见本报告“活动 Worker 关闭场景”，两类证据不可互相替代。另有包内 API A→B→A 路由回归；当前 arm64 app bundle 的单次快速 UI A→大历史 B→A 最后 active 于 A，DOM 消息 ID 全属于 A。该 sample 有背景回填/备份警告，只证明路由隔离，不证明健康来源或性能。证据：[package-ac5-ui-aba-selection-isolation-2026-10-28.json](package-ac5-ui-aba-selection-isolation-2026-10-28.json)。projection-cache rebuild 与前台读取已有一项 synthetic 窗口竞争样本；source locator backfill 与前台页读取也有 API 重叠样本，二者覆盖面不同，均不替代 AC-7。AC-6 已覆盖 prepared 后 compaction、source append、canonical source edit IPC、source spill 与 projection payload/blob 损坏回退，以及删除 UI/IPC。删除现新增冷重启复核：独立隔离 clone 中通过产品确认删除后，目标 session、messages、projection state/cache、source state、blob references 均为 0；关闭并重启同一 app bundle 后目标仍不在列表，表中目标记录仍为 0，`quick_check=ok`。该 n=1 样本通过 CDP DOM click 驱动，不是物理鼠标输入；PKG 未安装，且不覆盖发布边界崩溃。证据：[package-ac6-delete-cold-reopen-identity-clone-2026-10-28.json](package-ac6-delete-cold-reopen-identity-clone-2026-10-28.json)。其他代表样本及口径详见 [external-performance.md](external-performance.md)。

新增冷启动索引竞态回归：源码测试先确认旧实现会在 History spill 派生索引 `running` 时拒绝所选页面；修复后从 arm64 PKG payload 启动、初始隔离 profile 标记为 `running`，UI 显示健康会话正文，随后索引完成且 `quick_check=ok`。UI 样本未证明页面请求先于后台索引完成，精确 pending 时序由定向源码测试覆盖。该样本未安装 PKG，仍不关闭 P4-02/P4-03/AC-7；详见 [external-performance.md](external-performance.md) 与 [package-startup-pending-spill-index-identity-clone-2026-10-28.json](package-startup-pending-spill-index-identity-clone-2026-10-28.json)。

### AC-6 canonical 正文编辑准备后回归（2026-10-28）

新增包级样本先确认旧逻辑会令已准备缓存后的 300 KiB canonical-backed-dual-write 正文编辑陷入 `CHAT_BODY_AUTHORITY_MISMATCH`。修复后，在同一 History 写事务内将发生变化的消息转换为 canonical-only；PKG app.asar 中 writer 与调用 harness 使用的编译模块 SHA-256 完全一致。隔离 profile 冷启动后 source `complete`、chatBody projection `valid`、`quick_check=ok`，AX 树显示新正文和既有 assistant 回复。样本是 synthetic identity clone、未安装 PKG，且通过 hash-matched harness 而非打包 renderer IPC 发起编辑；只补充准备后 source edit 的 package payload/rebuild/read 场景，不关闭 UI/IPC edit、delete、History spill、发布边界、P4-02/P4-03 或 AC-7。包身份、哈希和数据库状态：[package-ac6-canonical-source-edit-after-prepared-cache-identity-clone-2026-10-28.json](package-ac6-canonical-source-edit-after-prepared-cache-identity-clone-2026-10-28.json)。

另完成准备后删除的隔离库清理核验：针对目标 synthetic session 的 UI 不可逆确认已取消，随后在隔离 DB 上通过与 app.asar 匹配的编译生产 `deleteSession` 命令执行删除。目标 session、messages、projection state/cache 与 source state 均为 0，`quick_check=ok`；冷启动 UI 中出现的近似同名项经 ID 核对属于另一 fixture。此样本未测试 UI/IPC 删除，只补充生产命令的隔离库删除清理；不能关闭 AC-6 删除 UI 路径或 P4-02/P4-03/AC-7。证据：[package-ac6-session-delete-after-prepared-cache-identity-clone-2026-10-28.json](package-ac6-session-delete-after-prepared-cache-identity-clone-2026-10-28.json)。

### AC-6 删除冷重启防复活补验（2026-10-28）

以 `sap4ac6appendvalid28` 的 prepared append 合成库创建独立 `/tmp` userData 副本；初始目标 projection 为 `valid`、source 为 `complete`、数据库 `quick_check=ok`。使用 PKG 构建产出的 arm64 app bundle，在产品会话列表打开目标删除确认框并确认。成功提示出现，会话行消失；关闭应用后核对目标 session、messages、projection state/cache、source state、blob references 均为 0。随后冷重启同一隔离 app bundle，目标仍不在会话列表，数据库 `quick_check=ok` 且目标各表仍为 0。运行期间经 `lsof` 核实 app 只打开此 `/tmp` 副本；源 profile 未交给应用写入。

交互由 CDP 对产品 DOM 控件调用 `.click()` 触发，不是物理鼠标点击；PKG 未安装，样本 n=1，不覆盖发布边界崩溃或 AC-7。逐项结果：[package-ac6-delete-cold-reopen-identity-clone-2026-10-28.json](package-ac6-delete-cold-reopen-identity-clone-2026-10-28.json)。
5. IM 并发项不适用：用户确认没有专用私聊或群聊 sandbox。当前不向真实 IM 会话发送测试消息。

6. 原始 app identity 的解包 bundle 曾尝试通过命令行 `--user-data-dir` 指向隔离 profile；helper 参数虽显示隔离路径，但这不能单独证明 Electron 主进程业务 DB 使用该路径。运行前后默认数据库主文件时间与 WAL 状态变化，缺少前置快照，无法归因；只读检查为 schema 117、`quick_check(10)=ok`。该次探针不计验收，未回滚数据库。之后只允许使用应用 identity 和数据库目录都核实唯一的隔离副本；详见 [external-performance.md](external-performance.md) 的“原始 app identity 的 userData 隔离尝试”。

## 继续验收步骤

1. P4-02 不再续跑。重开前必须提交可验证的健康同源样本可用性证据，并证明新一轮能改变 AC-7 结论；否则保留“未验收”。
2. 对 P4-03 只补本计划明确指定且会改变源码/用户体验结论的单个缺口；一次只登记一个场景、一个包身份、一条停止条件。当前新增的 canonical source edit 包内 IPC 样本见下方，不能据此宣称 AC-6 或 AC-7 全部通过。
3. IM 并发经用户确认不适用，不向任何真实会话发送测试消息。没有被明确登记的其他故障组合不作为本计划持续外验任务。
4. 本机源码任务和定向回归完成后，报告本机结论；AC-7 仍单独标为未通过/未验收，不阻塞本机源码交付。

## 结论

P4-03 **核销任务完成**：当前 macOS 范围内已记录适用外验结果，并复核 AC-5/AC-6 包级代表场景及其边界；IM 并发不适用。性能验收结论仍为**未通过/未验收**：P4-02 按预设停止条件终止，未取得有效基线/候选配对，AC-7 不通过。已覆盖的代表场景不替代未满足的 AC-7 指标，也不把未安装的 app bundle 证据描述为安装后 PKG 验收。各结果的包身份、隔离方式与限制见本报告及 [external-performance.md](external-performance.md)。本机最终验证：`npm test` 为 11668 项通过、140 项跳过、0 失败；`npm run build` 通过，包含 31 个 session-storage 边界探针。核销完成不构成性能通过、PKG 安装或发布批准，也不代表生产启用。

## 解锁后补充（2026-10-27）

- 在候选包窗口实际观察到 94–104.6 ms 的 long animation frame 与 50–74 ms long task。它们足以说明仍存在可感知卡顿风险，但缺少脚本 attribution 和调用级关联；当前没有证据证明 20 条首屏页读取本身是长帧来源。候选单进程 RSS 采样峰值约 517.4 MiB。
- 已从计划基线 `109a9384` 构建 arm64 PKG；构建与签名校验成功。但该二进制支持的最高数据库版本为 107，其他可读取的同数据副本均为 schema 115/116，启动被安全拒绝；另有一份 baseline-v3 副本无法只读校验。因此同库基线 UI 对照仍不可执行，也没有尝试降低 schema 或修改用户数据。
- 截至该段旧测量记录，唯一运行实例是候选 PKG，进程命令行带有 `--user-data-dir=/tmp/spaceassistant-p4-validation/copies/candidate-v6`；基线实例已退出。该状态已由下方 v7 复测更新，期间没有并行启动基线/候选窗口。
- IM 项继续标记为不适用：项目没有专用私聊或群聊测试会话，未向任何真实会话发送消息。

更新后的结论仍是 **P4-03 未完成**。真实候选窗口测量已开始，但基线版本拒绝兼容、AC-7 全矩阵及 AC-5/AC-6 包内代表场景尚未完成；因此不能写“验收完成”或“允许发布”。

## 视口修复后的候选包复验（2026-10-27）

- 最新候选已更新为 build ID `3817abb0-b0b3-4bd6-9b34-964550c2d40f`，版本 `0.2.9`，提交 `6570771d54ba667b00c4436e83c6c6c1c903715b`。arm64 PKG SHA-256 为 `d21aa292afefcced83f2d49fbe78487a15ece142cebe80fe9138b4f24338ecc1`，app.asar SHA-256 为 `dbe16e0c955b0b143e34cc7283fff0db1f88c4d2e2256903ea2ea163be7e67c1`；`codesign --verify --deep --strict` 通过。源码定向回归、renderer 类型检查和完整构建均通过，细节见 [external-performance.md](external-performance.md)。
- 隔离真实库上的窗口点击样本：大历史 30/30 成功，点击到 renderer next-paint p50/p95/max 53.3/58.2/65.3 ms；普通历史 30/30 成功，41.7/46.7/47.0 ms。设置对话框在大历史上下文 20/20 成功，响应 p50/p95/max 33.4/47.6/49.0 ms；普通上下文 20/20 成功，26.2/28.1/29.6 ms。测试经 CDP 指针事件派发，表示实际 Electron 窗口交互路径，不等同于物理鼠标硬件端到端延迟。
- 新构建 10 次交替切换均将 Virtuoso `firstItemIndex` 保持在 100000；旧构建曾连续递减。此回归由 TDD 测试和 PKG 运行观察支持。新构建 60 次会话切换中未观察到 ≥50 ms Long Task/LoAF。串行旧/新候选测量不具备随机交叉设计，且旧二进制无法打开同 schema 数据库，故不据此宣称 AC-7 全面通过。
- 最新唯一运行进程是候选 PKG，隔离目录 `/tmp/spaceassistant-p4-validation/copies/candidate-v7`，未启用远程调试端口。没有向任何 IM 会话发消息；用户确认产品没有私聊、群聊或专用 IM 测试会话，因此 IM 并发验收不适用。
- 真实库上的早期 AC-6 探针因样本是 legacy 消息而不计验收。随后已在独立合成 canonical-backed fixture 上验证包内 source spill 缺失、截断、同长度摘要篡改及 locator 指向不存在文件均返回 `CANONICAL_SESSION_CONTENT_UNAVAILABLE`，证据见 [external-performance.md](external-performance.md)。

结论维持 **P4-03 未完成**。同源基线点击代理比较已有记录，但双帧指标不能替代正文首屏 ready；热/损坏缓存与维护开关矩阵、维护期间前台竞争、适用于真实历史的完整维护收敛时长与进程峰值 RSS，以及安装包内 AC-5 剩余并发场景和 AC-6 剩余故障场景仍待验收。另有一次 1000 条 canonical-backed-only 合成会话的包内重建测量：两段 slice 合计 538.9 ms，短窗口 RSS 采样见 [external-performance.md](external-performance.md)，不替代上述矩阵。无维护时的全进程 RSS 基线已有 30 秒样本；source spill 缺失、截断、摘要篡改与 locator 失效的 fail-closed 已在包内验证。当前候选测量不构成整体验收或发布许可。

## 空消息回填修复包的补充运行记录（2026-10-27）

最新隔离候选为源码提交 `76cb2b7812d2c7a00e4d997a3c37fa10751e7611`，build ID `3b2b677b-89aa-4d52-ae71-3cc4dae23559`，PKG SHA-256 `90333659cac14e42d09729b4b3ee8c53580e3e5e5609939276ce5121f4c459c5`。该包在隔离真实库副本上完成 20 次大/普通会话交替点击，每组 10 次；点击至双帧 p50/p95 为 23.5/52.9 ms 与 34.4/38.8 ms。一次大历史点击与 110 ms Long Task、126.6 ms LoAF 重叠。指标不是正文首屏 ready，且副本有部分 legacy 历史错误，因此不纳入 AC-7 通过率。352 个空消息会话完成回填；32 个仅含 legacy 消息的会话仍为 backfilling，失败类别及限制见 [external-performance.md](external-performance.md)。候选测试后已退出。

本次仅为补充观测，不改变验收结论：P4-03 **未完成**。AC-7 的内容 ready 与缓存/维护矩阵、维护竞争，以及 AC-5/AC-6 的剩余安装包场景仍缺；IM 并发不适用，不向真实会话发送测试消息。

## 正文 ready 同源对照及剩余回填失败（2026-10-27）

基线 `109a9384` 与候选 `76cb2b78` 在同一冻结备份派生的独立副本上串行运行。大历史 150 条、普通会话 8 条；真实窗口点击到目标最后一条非空正文 ready，每版本每组 30/30 成功。基线大/普通 p50/p95 为 118.7/388.9 ms、110.7/248.4 ms；候选为 88.6/123.6 ms、49.6/151.5 ms。候选采样仍有与 ready 区间重叠的 115 ms Long Task 和 127.4 ms LoAF；AC-7 长任务目标未通过，不能仅凭 p95 改善认定卡顿已解决。完整测量口径、最大值、包哈希与限制见 [external-performance.md](external-performance.md)。

对 32 个 backfilling 的 legacy-only 会话，26 个 coverage mismatch 有源数据缺口证据（16 个无 History stream、10 个有 stream 但无 event）；另外 5 个 message ID 缺失及 1 个 source fact 缺失仍未查明根因。它们不计作完成回填。P4-02/P4-03 继续未完成；缓存与维护矩阵、维护竞争/耗时/RSS、其余 AC-5/AC-6 包内场景均未齐。无专用 IM sandbox，会话消息测试不适用。

对候选包额外采集的 15 轮 Chromium trace 将常规切换工作定位到 `react-virtuoso` 滚动/尺寸回调与 React 更新，但没有复现此前的 115 ms renderer Long Task，尚不能解释该长任务或关闭 AC-7。详见 [external-performance.md](external-performance.md)。

## arm64 包 cold-cache 首页面补测（2026-10-28）

当前 arm64 应用目录包 build ID `e4aca912-a3e7-4d0b-8d43-2cb820057f02`、`app.asar` SHA-256 `3330eda77d36f8c8b82e15bafa55ea4e25daa0e1b942bf3f81db70a13f48bb82`。在隔离 canonical 合成夹具上创建 30 份独立用户目录，删除各副本的投影派生记录后逐个启动候选包。首次消息页请求 30/30 成功且标记为 cold。main handler p50/p95/max 为 46.78/67.47/123.74 ms；renderer 页面请求为 49/314.8/316.9 ms；记录阶段相加到 next-paint 为 67.1/335.8/338.6 ms。原始逐样本数据见 [cold-package-first-page-2026-10-28.json](cold-package-first-page-2026-10-28.json)，数据含义与限制见 [external-performance.md](external-performance.md) 的同名小节。

这组数据测量的是应用进程启动后的首个消息页请求，不是可信点击、会话切换、正文 ready 或 Long Task/LoAF；因此它补充 cold-cache 包内诊断，不关闭 AC-7。测试中桌面自动化仍报告锁屏错误，系统辅助功能未给出可操作窗口，设置页与真实点击证据仍未新增。P4-02/P4-03 保持未完成。

## 同源基线与最大历史窗口点击补充（2026-10-27）

2026-10-28 又对同一冻结 schema 102 数据各自迁移的 baseline/candidate COW 副本，按相同 CUA 搜索、点选、轮询 AX 正文标记的方法各补 30 轮 large/ordinary 交替。baseline 与 candidate large 的 AX-ready proxy p95 为 1177.3/1175.1 ms；ordinary 为 1098.2/1334 ms，candidate ordinary max 3306.9 ms。baseline 60/60 首个 AX 查询命中，candidate large 30/30、ordinary 24/30 首查命中，最终 60/60 均命中。此 timer 包含约 1 秒的 CUA/AX transport，不等于可信点击到首屏渲染延迟；candidate large 目标仍是 150 条 legacy、0 History event、source backfilling、ledger blocked。该数据不能关闭 AC-7/P4-02，也不能单独证明 ordinary session 回归。逐样本：[package-frozen-real-history-paired-ax-proxy-2026-10-28.json](package-frozen-real-history-paired-ax-proxy-2026-10-28.json)；完整口径：[external-performance.md](external-performance.md)。

为解决此前基线 schema 不兼容，重新从同一冻结数据库备份制作独立 APFS clone：旧基线 `109a9384` 在其 clone 上迁移至 schema 107，候选 build `3817abb0-b0b3-4bd6-9b34-964550c2d40f` 在另一 clone 上迁移至 schema 116；串行运行，未改原始库，IM 设置仅在副本关闭。

通过 CUA 在实际窗口各做 30 次可信点击。旧基线 64 条消息会话点击到双 `requestAnimationFrame` p50/p95/max 为 29.5/32.3/32.5 ms；候选 150 条最大会话为 51.3/59.1/59.2 ms。由于会话规模不同，该差异只能作为响应代理观察，不能归因于单个新增任务。基线点击窗口没有 Long Task，候选检测到一个最大 120 ms Long Task 和三个最大 133.1 ms LoAF，但它们没有落在记录的点击窗口。另一个候选 64 条会话样本 p95 为 53.2 ms，点击窗口内无 Long Task/LoAF。候选大历史切换后设置视图仍能打开，响应操作成功。

指标截止于双帧回调，并非消息正文首屏 ready；候选测试期间 source locator 后台回填仍在进行且未查明完成时间，因此不能用这些样本关闭 AC-7 或认定维护影响已排除。P4-03 继续未完成：仍需完成 AC-7 的首屏 ready/缓存/维护矩阵、维护竞争及维护耗时/RSS，并覆盖 AC-5/AC-6 剩余包内场景。IM 并发按用户澄清不适用，不向真实会话发消息。

## 渲染 CPU 采样补充（2026-10-28）

最新候选包 12 次可信切换（64 条/8 条会话各 6 次）中出现一次 133 ms Long Task 和 146 ms LoAF（blocking duration 81 ms），与普通会话点击时间接近；大历史点击附近另有 56 ms LoAF，blocking duration 为 0。1 ms V8 profile 的该任务窗口样本主要落在 idle/program，未得到可映射到源码的主因；包内无相应 source map。维护完成后才开始此 profile，所以它不覆盖维护竞争。详细事件和限制见 [external-performance.md](external-performance.md) 的“解锁后的渲染 CPU 采样补充”。开测时误通过应用名激活旧版窗口，出现数据库版本 116 高于支持版本 115 的提示并自动退出；未打开或写入默认数据库，之后通过候选 `.app` 完整路径重新接入。该观察不关闭 AC-7，也不足以支持新的源码修复。P4-03 仍未完成。

## 确定性 locator 回填失败不再跨启动重复扫描（2026-10-28）

源码提交 `e220942e` 将 `CHAT_BODY_MESSAGE_ID_MISSING` 与 `CHAT_BODY_SOURCE_FACT_MISSING` 记录为当前 source revision 与 reducer spec version 的确定性失败。任务查询跳过同一版本的失败项；History source revision 变化或 reducer spec 升级后恢复尝试。失败只在实际扫描的 source revision 仍是当前版本时记录，避免并发更新被误标。既有瞬时错误仍走进程内退避并保留后续重试。

新增 TDD 回归覆盖失败标记持久化、同版本重启不重扫、reducer 版本升级后重试、source 更新后成功回填，以及 v116 → v117 schema 迁移。定向命令 `npm exec vitest run electron/sessionStorage/infrastructure/sqlite/sessionBodySourceBackfillTask.test.ts electron/database/migrations.sessionBodyLocator.test.ts`：11 项通过；`npm run build:electron:incremental` 通过，包含 session-storage 与 cleanup 边界门禁。本次没有重跑全仓测试。

该修复目前只在源码工作树中，尚未打入 arm64 安装包，也没有新的包内隔离库或界面样本。本轮 CUA 在用户确认解锁后仍报告 Mac 锁屏，无法启动可操作窗口；P4-02/03 与 AC-7 维持未完成。

后续提交 `6b4ab574` 补上调度器拒绝回填请求的回退边界。RED 用例证明旧包装器忽略 `false` 后会等待到 `PROJECTION_SOURCE_BACKFILL_WAIT_TIMEOUT`；修复后该请求立即返回未准备状态，交由现有读取路径继续处理。三项定向回归共 20 项通过，增量构建和边界门禁通过。该 follow-up 同样未进入安装包。

再后续提交 `f262cf76` 将持久化失败白名单收窄为上述两个数据形状错误。新增 RED 用例证明无 History 的 `PROJECTION_SOURCE_BACKFILL_COVERAGE_MISMATCH` 可能在 source revision 不变时通过 spill 恢复而变得可回填，因此继续使用可重试退避、不落终止标记。相同三项定向回归仍为 20 项通过，增量构建和边界门禁通过；未运行全仓测试。

## arm64 PKG 中的 source backfill 重启行为（2026-10-28）

提交 `6a77e087` 在确定性回填失败基础上，增加了“当前有消息但 session 完全没有 History stream/event”这一可判定状态的停放规则。该条件不覆盖仍有 stream/event 证据的 coverage mismatch，后者继续保留退避和重试；新写入 History 会触发 source revision 变化并重新排队。

arm64 PKG build ID `eb0aac8b-6f5b-496c-ba11-f45f194f9584`，PKG SHA-256 `abd5b8fd1e1555d92a719f85ca99f8eeb7235c0cf283ee0b37fb44146fcc98cf`，app.asar SHA-256 `c5f6801ea483b11ec01b94ff1ee3c87c34ab609434b8a319f3589c8d4a078cc6`。由旧 v116 profile `/tmp/spaceassistant-p4-validation/copies/pkg-candidate-schema102` 创建 APFS 克隆 `/tmp/spaceassistant-p4-validation/copies/backfill-park-v117-20261028`，未触碰默认用户目录。运行前有 34 个 `backfilling`、631 个 `complete`，其中 16 个有消息但无 History stream/event。运行后数据库迁移到 v117，34 个待处理会话仍保持 `backfilling`：首轮 5 个 `CHAT_BODY_MESSAGE_ID_MISSING`、1 个 `CHAT_BODY_SOURCE_FACT_MISSING`、28 个 `PROJECTION_SOURCE_BACKFILL_COVERAGE_MISMATCH`；22 个 session 被标记为当前 source revision 的停放项（16 个无 History 来源 + 6 个数据形状错误），另 12 个 coverage mismatch 可重试。重启后只重新尝试那 12 个 coverage mismatch；两个确定性错误类别均为 0 次，22 个标记保持不变。测试还验证给无来源会话追加 History 后 revision 上升并成功完成 backfill。

原始计数与哈希：[backfill-pkg-v117-2026-10-28.json](backfill-pkg-v117-2026-10-28.json)。PKG payload 的 app.asar 与运行 bundle 完全同哈希；实际运行的是 electron-builder 生成的 app bundle，未执行安装。PKG 当前无 Installer 签名（本机没有 Developer ID Application identity）。这次是维护回填/重启证据，没有真实窗口点击、session-switch 延迟或 Long Task/LoAF 测量。本轮按用户确认已解锁后重试 CUA：`getApp("SpaceAssistant")` 约 121 秒超时，`getState()` 约 30 秒超时并重置 kernel，未获得可交互窗口。P4-02、P4-03 与 AC-7 不关闭。

后续测试提交 `6efddbf6` 增加停放会话的读取回归：真实 SQLite storage 中，已有 legacy 消息的会话即使 source 状态被标为当前 revision 停放，`readChatPageAfterPreparation` 仍在 1 秒内经现有 reader 返回原正文，且不请求回填。三项定向回归共 21 项通过；此测试改动不改变已构建 PKG 内的源码。

## 热缓存、无维护任务时的包内对照（2026-10-28）

在 arm64 PKG payload identity clone 的隔离 profile 中，对 8 条与 64 条合成会话做 30 轮窗口切换。每轮均按完整消息尾标记核对目标正文；60/60 匹配。包内 trace 60/60 成功且缓存均为 ready：8 条样本 main handler / renderer page request / next-paint p95 为 1.29 / 3.60 / 16.30 ms；64 条为 6.58 / 7.50 / 14.40 ms。采样期间无投影构建 slice 或 Long Task/LoAF 事件，结束后数据库 `quick_check=ok`，source 状态 3/3 complete、projection 状态 3/3 valid。

本条件只是未人为触发维护任务的 idle 对照，没有通过生命周期控制接口关闭维护，也没有同库基线。60 次普通会话 ledger gate 均为 `ledger_missing`；不代表健康完整历史。identity clone 与 synthetic fixture 的详细限制及逐条数据见 [external-performance.md](external-performance.md) 和 [package-hot-cache-maintenance-idle-switch-identity-clone-2026-10-28.json](package-hot-cache-maintenance-idle-switch-identity-clone-2026-10-28.json)。本轮结束后隔离包已退出，默认实例未运行。

桌面工具超时时的副作用核对：`cua.getApp("SpaceAssistant")` 在约 121 秒后超时，但仍启动了 `/Applications/SpaceAssistant.app` 并打开默认用户目录。该进程已退出；只读核对默认库仍为 schema 116、没有 v117 标记列，数据库主文件修改时间仍为 `2026-10-27 22:24:11`，WAL 为 0 字节。该进程不属于隔离 PKG 验收样本，没有证据显示它提交过 SQLite 写事务；之后不再用 `getApp` 自动启动默认实例。

## 用户确认解锁后的隔离候选启动重试（2026-10-28）

用户确认 Mac 已解锁后，CUA 应用清单可读，但桌面状态仍返回“Mac 已锁定”，没有可操作窗口。本次从 `pkg-candidate-schema102` 制作独立 APFS clone，并确认副本中的飞书与微信配置均为 disabled。直接执行 app bundle、设置临时 `HOME` 的首次尝试没有保持运行。

随后经 LaunchServices `open -na` 重试时，候选进程忽略该临时 HOME，命令行实际指向默认用户目录 `/Users/space/Library/Application Support/spaceassistant`。已终止本次启动的主进程与 helper。只读检查确认该数据库 schema 为 117（此前该目录没有本轮基线快照；先前记录的 schema 116 指另一目录）。WAL 文件为 4,144,752 字节；当前 source backfill 有 35 条 `backfilling`、934 条 `complete`，没有 terminal marker。迁移 v117 新增两个可空字段；启动前计数未知，因此不能据此断言其他数据未变。没有执行回滚或清理。CUA 未显示窗口，没有采到点击、正文 ready、Long Task 或维护竞争数据。

之后直接启动 app bundle 并设置临时 HOME，Electron 辅进程仍使用同一默认目录。启动日志达到 renderer `ready-to-show`，但 recovery report 为 `degraded`、包含 2,302 项 `SESSION_LEDGER_REPAIR_PENDING`。未执行会话读取或点击，进程已终止。只读 `PRAGMA quick_check(10)` 返回 `ok`（4.7 秒）；schema 117、WAL 4,144,752 字节，source-state 为 35 `backfilling` / 934 `complete`。这些状态没有启动前快照可对照，不能归因给本次运行，也不能据此认定默认库其余数据未变化。停止后没有应用进程或数据库连接。

结论不变：P4-02/P4-03 未完成。IM 并发仍不适用；待补证据是候选可操作窗口中的 AC-7 内容 ready 与维护竞争，以及 AC-5/AC-6 仍适用的包内场景。后续不得用 LaunchServices 的临时 HOME 假设隔离；只有在能从命令行确认实际 userData 路径确为隔离目录后才能启动候选包。

## 唯一应用名副本的 preload API 路由复测（2026-10-28）

为避免使用 LaunchServices 临时 HOME，基于 v117 PKG app bundle 在 `/tmp` 制作 identity clone，只改变 `app.asar` 内 `package.json:name`，令 Electron 的默认 userData 落入独立目录。启动后 helper 参数显示唯一 profile `/Users/space/Library/Application Support/spaceassistant-perf-isolated-20261028`；默认数据库主文件与 WAL 时间戳保持 `04:32:56`。原 package `app.asar` 与临时 clone 不同哈希，但 `dist-electron/electron/main.js` 哈希相同；因此这不是原始 package identity 的发布验收。

隔离库上调用打包 preload API 进行 30 轮 A→B→A 共 90 次及 40 次并发读取，所有返回页都只含目标 session 的 message ID，错误数为 0。原始 JSON：[package-ac5-routing-isolated-identity-2026-10-28.json](package-ac5-routing-isolated-identity-2026-10-28.json)。CUA 仍报告 Mac 锁定，没有可信点击、正文 ready 或 Long Task/LoAF 数据；维护竞争也未覆盖。该结果只补充 AC-5 的路由子项，不关闭 AC-7、P4-02/P4-03。

2026-10-28 再次按用户确认的解锁状态检查：`cua.getState()` 返回 `apps: []`，并在 `errors` 中报告 “The Mac is locked”；`cua.getApp("SpaceAssistant")` 与绝对路径调用也返回相同错误。没有启动应用或访问默认数据库。本轮因此没有新的窗口交互或性能样本；这是桌面自动化连接状态与用户确认不一致，不能据此推断 Mac 实际仍锁定。


## 热缓存切换及即时内容核验（2026-10-28）

最新 arm64 PKG payload 的隔离 identity clone 完成 8/1000 条 canonical 合成会话各 30 次热缓存切换。60/60 main trace 均为 `cachePath=ready`、成功；next-paint p95 为 16.1/15.3 ms。切换窗口无 Long Task/LoAF 记录。普通 fixture 的 ledger gate 全部为 `ledger_missing`，所以仅采信为 cache-ready 性能数据。60 次采样中有一条 AX 首读显示旧会话尾部，随后另做 10 次逐次核验，10/10 首个 AX 读取即出现目标正文。identity clone 并非未修改签名的安装包；同库基线、健康 ordinary ledger 及维护开关矩阵仍缺。详情：[external-performance.md](external-performance.md) 和 [package-hot-cache-switch-identity-clone-2026-10-28.json](package-hot-cache-switch-identity-clone-2026-10-28.json)。P4-02/P4-03/AC-7 继续未完成。


### 隔离包损坏 projection cache 回退单样本（2026-10-28）

在 1000 条 canonical-backed-only 会话中，只将派生 inline payload 改为 1 字节非法 JSON。包内首次读取走 `cachePath=cold`，返回页面成功且 AX 显示 `assistant 999`；投影状态随后恢复 `valid`。这是 n=1 的启动首读样本，不作为延迟分位数。期间出现 290 ms Long Task 与 295.5 ms LoAF，但没有源码归因，不推断因果。该启动样本后续由 30 次损坏缓存界面切换矩阵补充；两组数据分开记录。详见 [package-damaged-cache-fallback-identity-clone-2026-10-28.json](package-damaged-cache-fallback-identity-clone-2026-10-28.json) 与 [package-damaged-cache-switch-matrix-identity-clone-2026-10-28.json](package-damaged-cache-switch-matrix-identity-clone-2026-10-28.json)。


### 损坏 inline cache 的隔离包切换矩阵（2026-10-28）

在 1000 条合成会话上做 30 次热投影缓存损坏后的实际界面切换。30/30 main trace 为 `cachePath=cold` 且成功，30/30 首个 AX 读取显示目标内容；main handler / renderer page request / next-paint p95 为 38.23 / 39.20 / 12.40 ms。每轮缓存均重新发布为 `valid`，切换与发布窗口无 Long Task/LoAF observer 记录。数据来自改名并 ad-hoc 重签的 PKG identity clone，且没有同库基线；它补齐损坏 cache 的 synthetic cell，不关闭 AC-7/P4-02。详见 [package-damaged-cache-switch-matrix-identity-clone-2026-10-28.json](package-damaged-cache-switch-matrix-identity-clone-2026-10-28.json)。


## 投影重建并发时的包内切换对照（2026-10-28）

在同一隔离数据库中用 1000 条合成会话触发投影重建，同时切换到 64 条 ready-cache 目标会话。46 次派生缓存损坏最终均恢复；43 次 ready 页面读取中，34 次与 worker build window 重叠且全部成功。有效样本 next-paint p95 为 15.2 ms，空闲对照为 14.4 ms；main handler p95 为 6.57/6.58 ms。消息表、History 事件表、正文来源事件表和 source 状态表与事前备份哈希相同。无 Long Task/LoAF observer 记录。

3 轮 UI 操作没有匹配到预期 trace 对，不计入 34 个有效样本；维护时 AX 树保留虚拟滚动位置，不能逐次从 AX 尾标记确认目标会话正文。该结果只适用于 synthetic identity clone 的投影重建负载；不覆盖真实历史、其他维护类型或基线包，P4-02/AC-7 继续未完成。后续同一 clone 的匹配 UI 往返样本做了进程树 RSS 对照：同窗维护/空闲 p95 为 979.47/977.91 MiB，8/8 派生缓存均从损坏恢复；RSS 直接累加各进程，可能重复计算共享页。详见 [external-performance.md](external-performance.md) 和 [package-maintenance-process-rss-matched-switch-identity-clone-2026-10-28.json](package-maintenance-process-rss-matched-switch-identity-clone-2026-10-28.json)。P4-02/AC-7 仍未完成。

## 真实历史 PKG UI 切换补充（2026-10-28）

补充冻结库 baseline/candidate 配对指针到 DOM/双 RAF 代理：同一 schema 102 冻结源派生独立 COW 副本，各 30 次大/普通会话交替选择，30/30 正文标记进入目标 DOM。双 RAF p95 baseline/candidate 大会话为 205.9/232.5 ms，普通会话为 207.7/249.8 ms。时钟由 renderer 收到点击 `pointerdown` 起，双 RAF 不等于物理像素呈现。candidate 源树 dirty，schema 与迁移独立；大会话 150 条消息但无 History event、source backfilling、ledger blocked，因此此数据不能解释健康 canonical 大历史或归因版本差异。完整逐样本见 [package-frozen-real-history-paired-pointer-dom-frame-2026-10-28.json](package-frozen-real-history-paired-pointer-dom-frame-2026-10-28.json)。它替代 AX 自动化代理作为延迟读数，但未覆盖 AC-7 全矩阵；AC-7、P4-02 继续未完成。

当前 arm64 PKG payload identity clone 在隔离真实历史副本上完成 8 次大/普通会话 UI 往返；目标 source 与 ledger 在运行前均为 `complete` / `ready`，8/8 main 与 renderer trace 成功。冷路径 main handler、renderer page request、next-paint p95 分别为 11.60、19.20、7.10 ms。此样本没有同库基线包、ready-cache 对照、维护矩阵或完整逐次正文标记核验；窗口内也没有 event-loop watchdog 样本。一次无 session ID 的 ledger baseline-ready 事件耗时 1037 ms，不能归因到某次切换。机器可读证据与表行摘要：[package-real-history-ui-switch-eight-identity-clone-2026-10-28.json](package-real-history-ui-switch-eight-identity-clone-2026-10-28.json)。本次补证不关闭 P4-02、P4-03 或 AC-7。


## 当前分支真实历史冷路径复测（2026-10-28）

当前工作树 arm64 候选 app bundle 在 COW 隔离 profile 中对 source `complete`、ledger `ready` 的 64 条与 8 条真实会话各完成 10 次冷路径切换，20/20 trace 成功。renderer 六阶段 p95 为 49.0/48.0 ms；renderer 发起至 main handler 进入的 epoch 间隔 p95 为 2 ms。无 AX 中途读取的采样窗仍出现 3 条 50.1–54.7 ms Long Animation Frame，脚本归因不可用；profile 启动整体为 degraded（142 项其他 History repair failure），故不满足 AC-7 长任务门槛，也不代表全库健康。该轮没有同库基线、hot/damaged/maintenance 矩阵，PKG 未安装，且没有逐次核对目标最后消息标记。旧记录中的 14.24 秒启动期 IPC 差值没有在本轮复现；本轮冷切换派发间隔为 0–2 ms，不能据此关闭原启动差值的诊断。逐次数据及限制见 [package-current-branch-real-history-cold-no-ax-2026-10-28.json](package-current-branch-real-history-cold-no-ax-2026-10-28.json)。P4-02/P4-03/AC-7 继续未完成。 随后同一隔离实例 36 秒无交互空闲对照未记录 Long Task/LoAF；10 个相关定向测试文件 97 项通过、25 项跳过。该空闲对照和测试结果已汇入机器可读证据。

## 活动 Worker 关闭场景（2026-10-28）

在 arm64 候选 app bundle 的隔离 userData 副本中，将 1000 条合成会话设为 `backfilling`，并用公开产品退出入口 `window.api.appQuit()` 在 backfill checkpoint 已建立且仍处于 `backfilling` 时退出。checkpoint 出现后 10ms 复核仍有效，约 137ms 后发出 app-quit IPC；app 进程以 0 退出，没有强制结束。退出后 `quick_check=ok`，1000 条 canonical 消息保留；未发布 locator / manifest / source event，backfill 状态与 run checkpoint 保留。冷重启同一隔离 userData 后，后台回填恢复到 `complete`，locator 1000 条、manifest 1 条、source events 2000 条，checkpoint 清空，`quick_check=ok`；再次通过产品退出 IPC 正常退出。此样本验证 arm64 app bundle 的一个活动 backfill worker 关闭与恢复路径，不是安装后的 PKG，也不证明 AC-7 通过。机器证据：[package-ac5-active-worker-close-attempt-2026-10-28.json](package-ac5-active-worker-close-attempt-2026-10-28.json)。早先首次采样过晚及快捷键退出失败的尝试在同一证据文件中列明，均未计入通过样本。样本采集时 P4-03 尚未核销；当前最终状态见下节。

## 最终收尾（2026-10-28）

P4-03 的证据核销任务完成：当前 macOS 范围内适用外验结果均有记录，AC-5/AC-6 包级代表场景及其限制已复核，IM 并发不适用。验收结果为**未通过/未验收**：P4-02 按停止条件结束，未取得有效基线/候选配对，AC-7 未通过。报告不把 app bundle 隔离运行描述为安装后 PKG 验收，也不构成发布批准。

本机最终验证：`npm test` 通过 11668 项、跳过 140 项、0 失败；`npm run build` 通过，session-storage 边界检查的 31 个探针通过。
