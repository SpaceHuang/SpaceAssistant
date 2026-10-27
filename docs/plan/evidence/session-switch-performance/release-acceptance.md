# P4-03 macOS 安装包验收记录

日期：2026-10-27  
状态：**部分完成；当前不具备发布验收结论。**

## 已完成的本机准备与可采信证据

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

## 尚未执行的安装包验收

用户已确认设备解锁；候选单边真实切换已有样本。本轮桌面自动化仍报告锁屏错误，系统辅助功能能枚举应用进程但没有可操作的应用窗口，故未取得新一轮真实窗口交互。完整矩阵、可运行的基线二进制和包内故障场景仍待完成，因此本报告不把单边数据写成完整界面验收。

以下项目仍未完成：

1. 最新包在当前 macOS arm64 设备上的首次访问、热缓存、损坏缓存和维护开/关矩阵；已采集的 105 次 cold 页切换不能代替这些矩阵，按方案 §2 对每个适用格采集至少 30 次、失败率、p50/p95/max。
2. 已完成同一冻结备份来源的基线/候选真实窗口点击代理比较，细节见下方“同源基线与最大历史窗口点击补充”。因两版最大会话规模不同，且指标截止双帧而非正文首屏 ready，该证据不能关闭 AC-7；仍需按方案口径测量内容 ready 与缓存/维护场景。
3. 切换期间长任务的调用级归因、完整维护峰值 RSS 及后台维护对前台的竞争数据仍缺。新增 arm64 包 1000 条 canonical 会话重建记录：两段 slice 合计 538.9 ms；重建期间进程树 RSS 9 点 p50/p95/max 为 894.2/899.2/899.2 MiB，启动全过程 max 为 1039.4 MiB（RSS 相加重复计算共享页）。该短窗口未并发触发前台请求、未采集 Long Task/LoAF，不能关闭维护竞争或 AC-7。此前无维护时 4 进程 30 秒样本及设置页数据见 [external-performance.md](external-performance.md)。
4. 安装包 AC-5 的取消等待者、后台维护与前台竞争、关闭/切库场景，以及 AC-6 的源编辑/追加/压缩/删除、投影块截断、发布边界故障。包内预加载 API 的 A→B→A 30 轮、并发 40 次页读取及会话路由隔离已有样本；这不是窗口点击证据。canonical source spill 缺失、截断、同长度摘要篡改、合法格式但不存在的 locator 时 fail-closed 均已用合成 canonical-backed 包内样本验证，详见 [external-performance.md](external-performance.md)。源码测试通过不能替代剩余安装包场景证据。
5. IM 并发项不适用：用户确认没有专用私聊或群聊 sandbox。当前不向真实 IM 会话发送测试消息。

## 继续验收步骤

1. 候选窗口保持唯一运行且指向隔离副本。基线二进制因 schema 不兼容已退出；先确认是否有计划基线可读的 schema 107 数据快照，再串行启动基线和候选，避免并行窗口与数据目录混淆。
2. 依照方案 §2 固定同一机器、库来源、页大小与系统缓存条件，完成首次访问、热缓存、损坏缓存、维护开/关适用矩阵；记录每格至少 30 个有效样本、失败率、p50/p95/max、主线程长任务、候选 RSS 与维护完成时间。若测量目标未达，返回源码任务修复后重建包并复测。
3. 安装包中复核 AC-5：A→B→A、重复读取、取消等待者、后台维护与前台竞争、关闭/切库；复核 AC-6：选页后源编辑/追加/压缩/删除、spill 损坏、块截断、发布边界故障。只接受完整有效页或既定错误，不把空页当成功。
4. IM 项保持不适用，不发送真实会话测试消息。
5. 更新本报告结论与证据链接。只有 AC-7 适用外验与 AC-5/AC-6 包内代表场景都有结果后，才能把 P4-03 标为完成；本报告不触发自动发布或替代生产 owner 门禁。

## 结论

P4-03 **未完成**。最新候选包已经在隔离真实库上完成大/普通会话窗口切换与设置响应采样，并观察确认视口索引修复生效；首次/热/损坏缓存和维护开关矩阵、正文首屏 ready 指标、维护竞争与维护期间内存峰值，以及 AC-5 的取消/维护/关闭切库和 AC-6 除 canonical spill 缺失/截断/摘要/定位损坏外的包内故障场景仍缺。无维护时的全进程 RSS 基线已采样。IM 并发因产品没有私聊、群聊或专用测试会话而不适用。当前结论不表示 AC-7 全面通过，也不构成发布许可。

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

桌面工具超时时的副作用核对：`cua.getApp("SpaceAssistant")` 在约 121 秒后超时，但仍启动了 `/Applications/SpaceAssistant.app` 并打开默认用户目录。该进程已退出；只读核对默认库仍为 schema 116、没有 v117 标记列，数据库主文件修改时间仍为 `2026-10-27 22:24:11`，WAL 为 0 字节。该进程不属于隔离 PKG 验收样本，没有证据显示它提交过 SQLite 写事务；之后不再用 `getApp` 自动启动默认实例。

## 用户确认解锁后的隔离候选启动重试（2026-10-28）

用户确认 Mac 已解锁后，CUA 应用清单可读，但桌面状态仍返回“Mac 已锁定”，没有可操作窗口。本次从 `pkg-candidate-schema102` 制作独立 APFS clone，并确认副本中的飞书与微信配置均为 disabled。直接执行 app bundle、设置临时 `HOME` 的首次尝试没有保持运行。

随后经 LaunchServices `open -na` 重试时，候选进程忽略该临时 HOME，命令行实际指向默认用户目录 `/Users/space/Library/Application Support/spaceassistant`。已终止本次启动的主进程与 helper。只读检查确认该数据库 schema 为 117（此前该目录没有本轮基线快照；先前记录的 schema 116 指另一目录）。WAL 文件为 4,144,752 字节；当前 source backfill 有 35 条 `backfilling`、934 条 `complete`，没有 terminal marker。迁移 v117 新增两个可空字段；启动前计数未知，因此不能据此断言其他数据未变。没有执行回滚或清理。CUA 未显示窗口，没有采到点击、正文 ready、Long Task 或维护竞争数据。

结论不变：P4-02/P4-03 未完成。IM 并发仍不适用；待补证据是候选可操作窗口中的 AC-7 内容 ready 与维护竞争，以及 AC-5/AC-6 仍适用的包内场景。后续不得用 LaunchServices 的临时 HOME 假设隔离；只有在能从命令行确认实际 userData 路径确为隔离目录后才能启动候选包。
