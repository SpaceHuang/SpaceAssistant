# P4-02 macOS 真实库副本性能核验（进行中）

## 当前候选包真实历史界面切换与阶段 trace（2026-10-28）

使用 build ID `21b8262e-43d1-4830-a050-61cc437df56a` 的 arm64 PKG payload，在真实 profile 的 APFS COW 副本中直接启动应用，未安装 PKG。副本 `quick_check` 前后均为 `ok`，飞书/微信已禁用。启动前选定的大历史目标为 64 条消息、2590 个 History event、source `complete`、ledger `ready`；普通目标为 8 条消息、343 个 History event、source `complete`、ledger `ready`。整个 profile 仍有 34 个 backfilling source 和 4 个 blocked ledger，因此只把两个目标视为本轮健康样本，不外推到全库。

CUA 交替选择两目标各 30 次，每次在新的 AX 快照中核对目标内容标记，60/60 次显示正确。按候选 build ID 和 `(rendererProcessId, requestOrdinal)` 汇总到 30 条大历史及 29 条普通历史完整 trace；有一条普通目标选择没有完整 trace，故未纳入分位数。大/普通目标的 main handler p50/p95/max 为 4.01/4.91/10.52 ms 与 5.58/6.32/10.46 ms；renderer page request 为 15.6/17.83/18.7 ms 与 14.4/17.34/18.3 ms；next-paint 为 3.7/7.78/8.4 ms 与 3.3/5.92/7.2 ms。请求发起到 main handler 的 wall-clock 差值 p95 为 2.55/1.6 ms，仅作粗略 IPC 派发间隔。

同一 renderer 进程在整个采样窗口记录 3 条 Long Task、13 条 Long Animation Frame，最大持续 350.9 ms、最大 blocking duration 249.9 ms；浏览器未提供脚本归因，不能归属给某次切换或投影任务。阶段 trace 不等于点击到正文可见耗时。此轮没有同库基线，也没有完整的缓存/维护矩阵，且 profile 全局状态退化；因此不据此宣称已消除卡顿或关闭 AC-7/P4-02。应用已退出，副本进程为零。完整身份、计时口径与限制：[package-current-candidate-real-history-switch-2026-10-28.json](package-current-candidate-real-history-switch-2026-10-28.json)。

### CPU profile 与 AX 读屏开销对照（2026-10-28）

为区分产品切换工作和自动化读屏干扰，在同一 arm64 候选包、同一隔离 profile 上做两段 CDP CPU profile。第一段 12 次 CUA 操作后每次都读取完整 AX 树：其中 11 次实际切换 trace 成功，另外 1 次点击当时已选中的会话；采样窗记录 1 条 129 ms Long Task 和 6 条 Long Animation Frame，最长 139.1 ms。第二段改为 12 次实际切换，中间不读取 AX 树，只在最后做一次目标内容确认；12 条 main trace 全部成功（大/普通各 6），切换时间窗没有 Long Task/LoAF 记录。第二段 main handler p95 为 4.21/6.35 ms，renderer page request p95 为 16.96/19.3 ms，next-paint p95 为 6.5/7.25 ms。

两段 CPU profile 时长分别约 49.61/26.20 秒，V8 idle 样本占 95.5%/90.97%；非 idle 采样时间约 2.25/2.36 秒，未出现单一明确热点。第一段在长任务附近的 V8 样本也不足以指出具体 JavaScript 函数。结果强烈提示逐次完整 AX 树读取会污染自动化长帧观测，但两段非随机、样本短，不能据此证明所有长帧均由 AX 导致，也不能排除用户正常操作时的卡顿。应用已关闭，目标会话在副本中仍为 source `complete`、ledger `ready`，数据库 `quick_check=ok`。本项只校正诊断方法并补充健康目标短测，不关闭 AC-7/P4-02。完整计时、包身份与限制：[package-cpu-profile-ax-overhead-control-2026-10-28.json](package-cpu-profile-ax-overhead-control-2026-10-28.json)。

## Long Task/LoAF observer 的隔离包窗口采样（2026-10-28）

为 AC-7 增加 renderer Long Task/LoAF 观测后，按 TDD 先运行 observer 定向测试，stub 下 3 项按预期失败；实现后将 `rendererLongTaskObserver.test.ts` 与 `agentLogProjection.test.ts` 合并运行，18 项通过。随后 `npm run typecheck:renderer`、`npm run build:electron:incremental` 和 `npm run build` 均通过，构建包含 Electron closure、session-storage 边界及 module graph 检查。

用 arm64 PKG build ID `ce47bcda-7b3e-492f-89de-60b03ad1492f` 的 identity clone，在独立 userData `/Users/space/Library/Application Support/sap4longtask10` 启动窗口；PKG SHA-256 为 `09b01353f63075bd6645010dbf8ee520700f7751a000348554807ff5f3dc506e`，运行 clone app.asar SHA-256 为 `d3576a3d2d36acd17b2b5bc7f617ffcf8aa308c001f552b140a76a8e34fbead5`。工作目录为 `/tmp/spaceassistant-longtask-workdir`，飞书与微信均关闭，profile 只含合成占位会话。先单独点击普通会话，再交替点击 64 条、1000 条、8 条合成会话共 8 次；AX 树每次都呈现目标会话内容。按 `(rendererProcessId, requestOrdinal)` 关联的 9 条 trace（含前置普通会话点击）全部 `outcome=ok / cachePath=ready`。main handler p50/p95/max 为 6.53/13.02/13.02 ms，renderer page request 为 7.5/14.1/14.1 ms，next-paint 为 8.0/12.7/12.7 ms。

observer 在重复切换前的启动阶段记录两条 Long Task（90、309 ms）和两条 LoAF（91.6、312.3 ms；blocking duration 分别 41.3、259.6 ms）；重复切换窗口内没有 ≥50 ms Long Task/LoAF 记录。这些启动事件不归因到本轮重复点击。每次切换还出现 `session-ledger-gate` `blocked / ledger_missing` 和 `session.history.repair.failed`，因此 1000 条合成目标不是健康 ledger 的大历史夹具；不能把该样本用于 AC-7 性能通过结论。CUA click+AX 观测耗时为 442–813 ms，包含自动化等待，不作为用户点击延迟。机器记录：[package-long-task-observer-switch-sample-identity-clone-2026-10-28.json](package-long-task-observer-switch-sample-identity-clone-2026-10-28.json)。此补充证明 observer 已进入打包 renderer 并能写入脱敏日志，但不关闭 AC-7、P4-02 或 P4-03。

在同一隔离 profile 备份后，仅使 1000 条目标会话的 projection state/cache 失效并保留 canonical source，再启动相同 PKG。第二次 cold rebuild 记录两段 slice：140.59 ms 与 1,503.57 ms，最终状态 `valid`。初始窗口显示历史仍加载时点击设置，CUA 的 click+AX 调用在 777 ms 后已返回设置页；此时最终 slice 仍在进行，之后 DB 状态才核到 `valid`。重建日志时间范围内 observer 记录 320 ms Long Task、324.7 ms LoAF（blocking duration 270.2 ms），另有 86 ms Long Task、87.6/108.2 ms LoAF。这里确有 renderer 长任务与重建时间重叠，但该包的 observer 未采集脚本归因，不能断定 projection worker 引发了长任务；CUA 时间也含辅助功能读取等待，不能当作纯点击延迟。合成 profile 的 ledger gate 仍为 `ledger_missing`。该结果证明一次前台设置导航在冷建完成前可见，同时发现同窗约 320 ms renderer 阻塞需进一步归因；它不关闭 AC-5 竞争矩阵或 AC-7。此轮机器记录续写在 [package-long-task-observer-switch-sample-identity-clone-2026-10-28.json](package-long-task-observer-switch-sample-identity-clone-2026-10-28.json)。

### LoAF 脚本归因可用性探针（2026-10-28）

为定位上面重复出现的长任务，按 TDD 为 LoAF 记录加了来源 allowlist 与无内容状态字段；19 项 observer/日志投影定向测试、renderer 类型检查及增量 Electron 构建通过。新 arm64 PKG build ID `94e4242e-24d6-4374-b8f4-405c5f8d71f5`，PKG SHA-256 `6594ee801e4eddc23ace759164feb2c32ae5af0b5b35403bf3382820353188b8`；仅在同一隔离 synthetic profile 重跑投影 cold rebuild。两段 worker slice 为 196.02/742.56 ms；本轮仅 n=1，renderer page request 377 ms、next-paint 192.9 ms。这是一项启动首屏请求，不是用户主动切换。observer 记录 304 ms Long Task 与 507.1 ms LoAF（blocking 255.4 ms），但所有 LoAF 均为 `scriptAttributionStatus=unavailable / scriptCandidateCount=0`。

随后在 DevTools Console 用只读查询读取 buffered LoAF 条目，只汇总 `duration` 与 `scripts.length`，7 条记录的 `scripts.length` 全为 0。由此确认该 Electron/Chromium 样本没有提供可用脚本归因，无法从 Long Animation Frame API 定位任务来源；需要带可用源码映射的 CPU profile 继续定位。长任务与 projection rebuild 时间重叠不构成因果证明。profile 的 ledger gate 仍是 `ledger_missing`，所以该合成样本不代表健康大历史，也不关闭 AC-7。结构化结果：[package-long-task-attribution-probe-identity-clone-2026-10-28.json](package-long-task-attribution-probe-identity-clone-2026-10-28.json)。

### 唯一 identity clone 的真实历史切换与 DevTools 短录制（2026-10-28）

用户确认 Mac 已解锁后，基于最新 arm64 PKG payload 创建唯一应用 identity clone `/tmp/SpaceAssistant-P4-RealHistory-20261028.app`，userData 为 `/Users/space/Library/Application Support/sap4realhist10`；数据库从冻结真实库副本 `/tmp/spaceassistant-p4-validation/copies/candidate-v7` 作 APFS clone。启动前源库与克隆库 `quick_check` 均为 `ok`，副本含 661 个会话、821 条消息，最大会话 150 条；飞书与微信关闭。未读取或写出会话标题/正文到证据文件。

通过 CUA 在窗口中交替点击 150 条与 28 条会话 10 次。10 条 main trace、renderer page request 与 next-paint 均成功关联，且 `cachePath=cold`：main handler p50/p95/max 为 6.41/12.87/12.87 ms，renderer page request 为 9.25/19.8/19.8 ms，next-paint 为 11.95/19.4/19.4 ms。切换区间内 observer 未记录 ≥50 ms Long Task。恢复日志在同一区间出现 5 次 `ready`、5 次 `blocked / ledger_missing`，但日志没有 session ID；因此不能确认哪一规模组对应失败状态，也不能把这轮当成健康大历史或 AC-7 性能通过。

随后对 8 次大小会话交替切换进行 DevTools Performance 短录制，Insights 报告 INP 64 ms。导出的临时 trace 有 75,085 个事件；其中出现 319.8、197.5、153.7、88.3 ms 的 `RunTask`。319.8 ms 事件包含 `CpuProfiler::StartProfiling`，属于启动 profiler 的录制开销；其余任务没有与点击阶段建立可靠的时间关联。保存时未包含 resource content，但 Performance 录制开启了截图采集，因此临时 trace 可能含窗口截图；分析后已删除，未保留截图。不能据此给 session switch 的 CPU 来源定责。真实历史隔离结果与限制：[package-real-history-switch-profile-identity-clone-2026-10-28.json](package-real-history-switch-profile-identity-clone-2026-10-28.json)。测试实例已退出，未发送 IM 消息。AC-7、P4-02 与 P4-03 保持进行中。

## 解锁后隔离 PKG 窗口补测（2026-10-28）

用户确认设备已解锁后，CUA 成功连接唯一应用 identity clone `/tmp/SpaceAssistant-P4-UI-20261028.app`。该 clone 的包内代码来自 build ID `eb0aac8b-6f5b-496c-ba11-f45f194f9584`，PKG SHA-256 `abd5b8fd1e1555d92a719f85ca99f8eeb7235c0cf283ee0b37fb44146fcc98cf`，app.asar SHA-256 `c5f6801ea483b11ec01b94ff1ee3c87c34ab609434b8a319f3589c8d4a078cc6`。helper 实际 `--user-data-dir` 为 `/Users/space/Library/Application Support/sap4test202610`；启动前仅修改该克隆 DB，将当前工作目录 profile 指向 `/tmp/spaceassistant-p4-ui-isolated-workdir`。飞书与微信集成均关闭。原始项目目录没有作为此轮工作目录。

使用克隆 profile 内两条合成占位会话交替点击 30 次（64 条大样本与 8 条普通样本各 15 次），30/30 次 AX 树均显示目标会话末尾的预期消息。追踪日志按 renderer trace 计算：大样本 page request p50/p95/max 为 5.1/7.8/7.8 ms，`selection-to-page-request` 为 7.5/8.2/8.2 ms，`next-paint` 为 6.7/14.9/14.9 ms；普通样本对应为 4.8/5.7/5.7 ms、7.6/10.9/10.9 ms、4.6/11.7/11.7 ms。点击后设置页成功打开。

CUA 点击至完整 AX 树返回的 30 次耗时为 p50/p95/max 501/553/614 ms；该数包含自动化等待与整棵可访问性树序列化，不作为真实用户可见延迟。设置页同一测法为 761 ms，也不作为交互时延门槛。该轮未启用 Long Task/LoAF observer，未测冷缓存、损坏缓存或维护竞争；样本为合成占位内容，不是私有真实历史。未运行同库基线包。详细机器可读数据：[package-ui-switch-isolated-identity-2026-10-28.json](package-ui-switch-isolated-identity-2026-10-28.json)。因此该窗口样本只补充隔离 PKG 热缓存下的切换显示正确性及内部 renderer 阶段计时，不关闭 AC-7、P4-02 或 P4-03。

## 投影重建期间打开设置页（2026-10-28）

在应用 identity clone `spaceassistant-p4-maintenance-20261028` 上复测。其 `main.js` SHA-256 与候选 PKG 相同（`fa3e0c95f51bf9774a59f08ec4e59395f5e4b1f179152336083dd2e4edf4bafe`）；app.asar 因包内应用名隔离而不同。helper 的 userData 为 `/Users/space/Library/Application Support/spaceassistant-p4-maintenance-20261028`，该副本仅含 1000 条 canonical-backed 占位消息以及此前两条 synthetic fixture；工作目录已指向 `/tmp/spaceassistant-p4-maintenance-ui-workdir`，飞书/微信关闭。运行前备份该 userData 到 `/tmp/spaceassistant-p4-maintenance-profile-before-ui-20261028`，之后只删除合成 1000 条会话的 projection cache/state，canonical source 未改。

复测先切到普通合成会话，再冷读 1000 条会话。main page read 为 `cachePath=cold`、33.78 ms；renderer trace 为 `next-paint=4.7 ms`，AX 树确认末尾预期消息已显示。随后在 2026-10-27T21:35:52.647Z 点击设置页。DB 高频只读轮询于 21:35:52.685Z 观察到 projection `rebuilding`，设置页完整 AX 状态于 21:35:53.198Z 已可见；projection 到 21:35:53.328Z 才变为 `valid`。因此此轮直接观测到设置页在重建期间已可交互，且在投影完成前约 130 ms 已呈现。两段 worker slice 为 257.15/384.77 ms，最终状态 `valid / attempts=0`，source 状态 `complete`。这关闭了“projection rebuild 与设置页前台竞争至少有一项有效包内样本”的证据缺口，但只是一次合成样本；CUA 设置点击到完整 AX 树 551 ms 包含自动化等待，不能当作用户可见延迟。没有 Long Task/LoAF observer、30 次矩阵或同库基线，本项不关闭 AC-7/P4-02/P4-03。原始数据：[package-maintenance-ui-settings-overlap-identity-clone-2026-10-28.json](package-maintenance-ui-settings-overlap-identity-clone-2026-10-28.json)。

日期：2026-10-27。状态：**未完成；当前结果不足以关闭 AC-7**。

## 运行边界与可复现身份

- 设备：Mac mini `Mac14,3`，Apple M2，16 GiB；macOS 26.5.2（25F84），arm64。
- 候选代码：`830047e4`（P3-07）；当前文档提交为 `e30b664c`。候选包由 P4-01 构建，SHA-256：`35ab16d26de7f64da4bc1c190eb4e806376cd3e2beee134528e0f2753d722d27`；版本 0.2.9。候选包从 `.pkg` 解出后运行，未安装到系统。
- 候选 app.asar SHA-256：`f90b572fac2b6b48855be4a337c14ec6132d6c0e65bed87e6613ed5927f47f09`。
- 基线为 `/Applications/SpaceAssistant.app` 的隔离副本，app.asar SHA-256：`f3f37a2b6ea517270cedf0f3e4993ed57a06caafc9c7dd25be74e2d3f41b9f8e`；运行日志 `artifactBuildId=62333b3d-6c26-4359-ab27-10af25d0a5f4`，应用版本同为 0.2.9。未能从该二进制确认对应 Git 提交，后续报告不把它冒称为确定的代码基线。
- 两份副本均来自备份 `spaceassistant-data-before-ledger-rebuild-e78e8347-20261020.db`（SHA-256 `7c11d494879cbbf64b3761e9092d5a7dafb4135253a794cd5ed3826ee5f0d399`）；原始数据库没有被打开或修改。两份运行副本各约 2.6 GiB，均有 661 个会话、780 条 history stream、18,175 个 history event。应用启动后候选迁移至 schema 116、基线仍为 schema 115，因此运行后的库文件不是逐字节相同；它们来自同一冻结备份。
- 本机证据命令：
  - `sw_vers; sysctl -n hw.model; sysctl -n hw.memsize; uname -a`
  - `shasum -a 256 release/SpaceAssistant-0.2.9-arm64.pkg /tmp/SpaceAssistant-Baseline-Validation.app/Contents/Resources/app.asar /tmp/spaceassistant-p4-validation/pkg-unpacked/com.spaceassistant.app.pkg/Payload/SpaceAssistant.app/Contents/Resources/app.asar`
  - Python 标准库 `sqlite3` 只读打开副本，查询 `schema_meta`、`sessions`、`agent_history_streams`、`agent_history_events`、`session_message_body_locator`；分别得到 schema 115/116、661/780/18,175，候选 250 条 locator。原始命令形态：`sqlite3.connect('file:<副本路径>?mode=ro', uri=True)`，不执行写事务。

## 当前可采信的候选包数据

从候选包日志按 `(rendererProcessId, requestOrdinal)` 关联 main 与 renderer 事件，取 ordinal 65–127，共 63 次完整切换；全部 `outcome=ok`，没有失败。命令：对隔离副本 `candidate-v4/workspaces/2/.agent/logs/Agent-20261027.log` 按 `session.switch.trace` 解析 JSONL，再按 ordinal 配对；复算代码：

```python
import json
from pathlib import Path

p = Path('/tmp/spaceassistant-p4-validation/copies/candidate-v4/workspaces/2/.agent/logs/Agent-20261027.log')
events = [json.loads(s) for s in p.read_text().splitlines() if '"event":"session.switch.trace"' in s]
main = {e['requestOrdinal']: e for e in events if e.get('instance') == 'main' and 65 <= e.get('requestOrdinal', 0) <= 127}
rows = []
for ordinal, m in main.items():
    rs = [e for e in events if e.get('instance') == 'renderer' and e.get('requestOrdinal') == ordinal and e.get('rendererProcessId') == m.get('rendererProcessId')]
    stages = [s for e in rs for s in e.get('stages', [])]
    request = next((s['durationMs'] for s in stages if s.get('name') == 'renderer-page-request'), None)
    paint = next((s['durationMs'] for s in stages if s.get('name') == 'next-paint'), None)
    if request is not None and paint is not None:
        rows.append((m['durationMs'], request, paint, m['cachePath'], m['outcome']))
for i, name in enumerate(('main', 'page-request', 'next-paint')):
    vals = sorted(r[i] for r in rows)
    q = lambda x: vals[int((len(vals) - 1) * x)]
    print(name, len(vals), q(.5), q(.95), vals[-1])
print('cache/outcomes', sorted(set(r[3] for r in rows)), sorted(set(r[4] for r in rows)))
```

| 分段 | 样本 | p50 | p95 | max |
| --- | ---: | ---: | ---: | ---: |
| main page-select + source-page-read + main IPC | 63 | 4.00 ms | 4.92 ms | 9.04 ms |
| renderer page request | 63 | 7.20 ms | 9.50 ms | 14.80 ms |
| renderer commit 到 next-paint | 63 | 14.60 ms | 20.70 ms | 21.50 ms |

这 63 次全部标记 `cachePath=cold`。大历史目标（64 条消息、2,590 个 History event）在候选库有 64 条 locator 且状态为 `complete`；同一目标在 schema 115 基线库没有 locator 表。候选数据库总计 250 条 locator，661 个回填状态中 277 个 `complete`、384 个 `backfilling`。因此候选数据只支持“已定位大历史的 cold page-read 分段表现”，不证明 ready-cache、损坏缓存、首次定位回填或维护开关分组通过。

## 基线与界面测量的限制

- 基线日志没有 `session.switch.trace`。可见 33 条 `session.transcript.read`，该事件自身耗时 11–321 ms；另有 `baseline_failed`、`ledger_missing` 修复记录。它与候选的 page request / next-paint 分段不是同一指标，不能拼成基线对比。
- 两端各做了 60 次交替选择“大历史 / 普通历史”，其中各 59 次观察到 AX 正文变化、1 次没有变化。AX 读取延迟：基线 p50 818.2 ms、p95 2,107.6 ms、max 2,393.4 ms；候选 p50 845.8 ms、p95 2,047.2 ms、max 2,295.5 ms。截图 API 的 6 次校准也交替出现约 0.8 秒与约 2 秒。该测法把 CUA 等待和大型可访问性树序列化计入计时，明显不是纯界面首帧；数值仅记录为测量工具校准，不用于 AC-7，也不据此判断两包快慢。
- 当前没有可复核的同口径基线点击到首帧数据、ready / corrupt-cache / maintenance on-off 的每组 30 次矩阵、主线程长任务、内存峰值与维护完成耗时。基线副本还处于旧 ledger repair degraded/fallback 状态；必须把这类状态单独报告，不能视作健康 ready 基线。

## 判定与下一步

在本次对照中发现：方案 §2 要求计时含“点击/选择”，但原候选 renderer trace 到 `ChatView` effect 开始分页才启动，遗漏 `setSession` 到分页 effect 的间隔。新增 `selection-to-page-request` trace stage：Redux middleware 在状态切换 action 前记单调时钟，`ChatView` 消费对应 marker 后将纯耗时并入同 ordinal renderer trace；会话 ID 只作 renderer 内存键，不写日志。RED 为 `sessionSwitchTrace.test.ts` 的 allowlist 用例，过滤新阶段时 1 项失败、3 项通过；GREEN 为相关 3 文件 26 项通过及 `npm run typecheck:renderer` 通过。旧 `.pkg` 和上表 63 个样本不含新阶段，不能冒称覆盖该缺口；需重新构建候选包并重跑对照。

上述 63 个样本属于较早候选包，只覆盖 page-read 子段。其后追踪到一个新的切换期工作：compaction marker 读取对已被标记为 `blocked` 的 ledger 仍请求 `retryBlocked: true`，每次会话切换都重跑 canonical baseline 扫描。先前隔离副本日志记录 62 次 `baseline_failed`，单次 300–551 ms，并伴随 event-loop delay 告警。这一现象会阻塞主进程。

已用 TDD 修复该读取路径：先增加“切换读取不得重试 blocked ledger”的回归测试，RED 时因缺少 `retryBlocked: false` 失败；再让只读 compaction replay 显式传 `retryBlocked: false`，写入路径保留默认重试。主进程 handler 将该选项传给 lifecycle。代码提交 `c2926903`。定向联合回归 7 个文件、128 项通过、25 项跳过；`npm run typecheck:renderer` 和 `npm run build:electron:incremental` 通过。

修复后的 arm64 PKG payload 已重建并在候选隔离副本上运行：`artifactBuildId=410a14dd-312b-4c9f-9b3b-e7500a6b6e5f`，PKG SHA-256 `1ec33ad664ede178a6a57a478894a663dc74876bb432a94af4431966cf9f740e`，app.asar SHA-256 `8496423a9af327a849398eb270b56a9f41ad59b75eb3f1ca861a26148a4ddff6`。日志里 ordinal 1–13 共 13 次完整读取均成功且为 `cold`，没有 baseline phase；13 次 ledger 检查均复用既有 proof，耗时 6–79 ms。ordinal 2–13 的选择到分页请求为 8.4–12.5 ms，提交后 `next-paint` 为 10.9–101.7 ms。该批样本是 6 对大小会话的短测，不构成 AC-7 样本矩阵；期间仍有一条 `eventloop.delay` 告警（p99 845 ms），故不能宣称 UI 已无卡顿。该告警与当时的操作无法建立因果关系，仍需调查。

后续按 `artifactBuildId` 重新过滤同一隔离日志，避免把跨版本累积日志混算：`410a14dd` 共记录 15 次 ledger recovery，全部是 `proof-reused`、没有 `baseline`；同一份文件中另有 126 次 baseline 来自旧 build ID `8d5d96b8` 与 `6763709d`，不属于修复包。修复包 15 次中最后一次会话切换 trace 在 2026-10-27 07:47:38.815Z，845 ms watchdog 告警在 07:47:47.732Z；其间记录的定时 transcript revalidation 是空队列（drained/revalidated/deferred/skipped 均为 0）。watchdog 事件没有任务关联字段，所以证据排除了“这次已知 blocked baseline 扫描”，但还不能确定残余 845 ms 的来源。此处不能把 page-read/next-paint 分段通过外推成主线程无卡顿。

另审查了切换时触发的 `chat:get-session-compaction-markers` 旁路：当 ledger 可写时它会读取并解析整个 `events.jsonl`，而不是只读压缩标记。对隔离副本中最大的该文件（1,196,023 bytes），直接调用最新 PKG app.asar 中的 `readCompactionReplay` 30 次，p50 5.01 ms、p95 5.97 ms、max 7.19 ms。该样本尚不足以代表更大的事件日志；测量值也不能解释 845 ms watchdog 告警，但此全文件解析路径仍应纳入更大文件与 UI 验收。

### PKG 主进程分页读路径补测（2026-10-27）

桌面仍锁定，不能做 UI/首帧采集；继续使用已授权真实库的隔离副本，补测最新候选包实际编译代码的源分页分支。使用 APFS clone 创建 `/tmp/spaceassistant-p4-validation/page-read-bench/spaceassistant-data.db`（与候选副本同为 2,780,368,896 bytes），原库不传给读写连接；只在 clone 上通过 `openSqliteDatabase` 打开。复用候选副本 `session-projections` 与 `spill` 数据。测试会话的大/普通消息源定位状态均为 `complete`，切换读路径 30 次全部报告 `cachePath=cold`，即没有可直接命中的 prepared body 视图，走源分页读取。

运行时为 PKG 自带 Electron binary 的 `ELECTRON_RUN_AS_NODE=1`，版本 Electron 44.1.1 / Node 24.19.0；加载从当前 PKG app.asar 解出的 `dist-electron`，调用共享实现 `readChatPageAfterPreparation(storage, { sessionId, limit: 20 })`，不是重新手写 SQL。大历史目标每页 20 条，p50 2.91 ms、p95 3.71 ms、max 6.25 ms；普通目标每页 8 条，p50 4.07 ms、p95 4.96 ms、max 6.04 ms。30 次连续读取共享同一进程，SQLite/文件系统页缓存会逐渐变热，因此它不是冷 OS 缓存测量；它也不含 IPC、React render、paint、用户点击等待或后台维护竞争。该结果表明这个隔离真实库中 cold-projection source-page 读路径本身低于 7 ms，不能据此关闭 AC-7 或推断其他路径的 event-loop delay。

复现步骤（在已解出 PKG app.asar 的机器上替换下列 `/tmp` 根路径）。先用 macOS `cp -c` 对数据库做 APFS clone，再把 spill 目录连入 clone；应用只打开 clone。`openSqliteDatabase` 在 clone 上初始化 SQLite 连接与 schema，不把原副本交给读写连接：

```bash
mkdir -p '<isolated-db-clone>'
cp -c '<isolated-original>/spaceassistant-data.db' '<isolated-db-clone>/spaceassistant-data.db'
ln -s '<isolated-original>/spill' '<isolated-db-clone>/spill'
ELECTRON_RUN_AS_NODE=1 <unpacked-app>/Contents/MacOS/SpaceAssistant - <<'NODE'
const root = '<extracted-app-asar>/dist-electron/electron'
const { openSqliteDatabase } = require(root + '/database/sqliteStore.js')
const { createSqliteSessionStorage } = require(root + '/sessionStorage/sqliteSessionStorage.js')
const { readChatPageAfterPreparation } = require(root + '/sessionStorage/public/readMessages.js')
const db = openSqliteDatabase('<isolated-db-clone>/spaceassistant-data.db')
const storage = createSqliteSessionStorage(db, {
  projectionBlobRoot: '<isolated-original>/session-projections',
  requestBodySourceBackfill: () => false
})
;(async () => {
  for (const [label, sessionId] of [
    ['large', '37c2d127-d30f-48d1-b601-7ccf131b328a'],
    ['small', 'c1a07aba-0603-4935-b334-71ac077d4194']
  ]) {
    const samples = []; const paths = {}; let entries = 0
    for (let i = 0; i < 30; i++) {
      let cachePath = 'unset'; const start = performance.now()
      const page = await readChatPageAfterPreparation(storage, { sessionId, limit: 20 }, {
        onCachePath: value => { cachePath = value }
      })
      samples.push(performance.now() - start); paths[cachePath] = (paths[cachePath] || 0) + 1
      if (!page) throw new Error(`${label}: page unavailable`)
      entries = page.entries.length
    }
    samples.sort((a, b) => a - b)
    console.log({ label, entries, paths, p50Ms: samples[14], p95Ms: samples[28], maxMs: samples[29] })
  }
  db.close()
})().catch(error => { console.error(error); try { db.close() } catch {} ; process.exitCode = 1 })
NODE
```

P4-02 **保持进行中**。代码修复已提交，但不按局部候选分段数据关闭 AC-7。下一步要继续调查候选包 residual event-loop delay，并实现基线与候选同口径端到端采集（同时固定可验证基线二进制身份）；覆盖方案 §2 的首次访问、热缓存、损坏缓存、维护开/关，每个适用矩阵格至少 30 次；补充长任务、内存与维护完成数据。若同口径测量证实目标未达，返回相应源码任务处理。

2026-10-28 补记：只读台账门禁的 TDD 回归已先 RED（旧 owner 的 blocked verdict 因 writer drain 卡住），再修复为 99 项定向回归通过；增量构建、完整构建均通过。由此构建的 arm64 PKG 为 `release/SpaceAssistant-0.2.9-arm64.pkg`（build ID `21b8262e-43d1-4830-a050-61cc437df56a`，PKG SHA-256 `e056d6100884d4868a3b5ffe9ca530d826772ac427e68764f2676fc7233d4f8e`）。本轮直接启动 PKG 同目录的 app bundle（PKG 未安装），使用真实 profile 的 APFS COW 隔离副本；窗口及 renderer 能启动，但样本仍有大量 `SESSION_LEDGER_REPAIR_PENDING` 与 source backfill coverage mismatch。一次 AX 操作未能证明已完成目标会话切换，stdout 也没有本次点击对应的配对 IPC / event-loop trace。因此本次不报告切换延迟、不声称快路径改善，也不关闭 AC-7。证据及局限：[package-post-ledger-fast-path-real-history-2026-10-28.json](package-post-ledger-fast-path-real-history-2026-10-28.json)。

### 第二项切换期主线程扫描：canonical compaction 回放（2026-10-27）

此前已停止的候选 v4 使用隔离库 `candidate-v6`。追踪发现 `sessionIpc.ts` 每次切换会读取 compaction replay；当 ledger 为 blocked 时，代码再回退到 `readCanonicalCompactionReplay`。旧实现用 `readValidatedSessionHistoryRows` 解析并验证该会话的所有 History payload，健康数据中也产生 O(History) 主线程工作。这段不在既有 `session.switch.trace` page-read 时长里，因此只看 UI 分段会漏掉它。

在隔离数据库只读测量旧编译实现：大历史目标 `37c2d127-d30f-48d1-b601-7ccf131b328a`（64 条消息、2,590 个 History event）10 次耗时 1.21–1.50 s；普通目标 `c1a07aba-0603-4935-b334-71ac077d4194`（8 条消息、343 个 History event）10 次耗时 0.86–0.87 s。只读取 raw payload 已分别耗时约 422 ms / 231 ms；主要成本来自验证整段 History。

按 TDD 修改并提交于 `d117424ece9555f565d29af2a187012aa67d947d`：先新增 `electron/runtime/sqliteAgentHistory.test.ts` 回归，构造一个合法 compaction invocation 与无关 invocation，损坏无关 History payload 后要求 replay 仍返回 marker，并断言不调用全局 cursor 检查；损坏相关 completion event 时则必须拒绝。原实现下 RED 由无关损坏 payload 触发，随后实现仅读取 compaction marker 所需的 owner/cursor 元数据，并只验证包含 `transcript-compacted` 的 invocation stream，GREEN 通过。联合定向回归命令 `npm exec vitest run -- electron/runtime/sqliteAgentHistory.test.ts electron/sessionStorage/sessionStorage.test.ts electron/sessionStorage/sessionSwitchPerformance.test.ts`：3 个文件通过，275 项通过、25 项跳过。

完整构建 `npm run build` 通过；边界检查均通过。随后从该提交的干净源码创建 arm64 PKG，未安装到系统，也未启动新窗口：

- build identity：`c3d37a41-8a08-46e0-b327-52800a4d494d`，版本 `0.2.9`，提交 `d117424ece9555f565d29af2a187012aa67d947d`，`sourceTreeClean=true`。
- PKG：`release/SpaceAssistant-0.2.9-arm64.pkg`，SHA-256 `868e130b26943bf1cd0902222551c4be455263e1c4c5312670870ef4255f456c`。
- app.asar：SHA-256 `d11b3528f82bfc2627773bd54ba6c1a6b262b9250d283492a5c9020335a9c529`；从 PKG 展开后的 app.asar 与 builder 输出哈希一致。
- `codesign --verify --deep --strict --verbose=2 release/mac-arm64/SpaceAssistant.app` 通过。无 Developer ID 身份，产物为 ad-hoc 签名，仅供隔离验收，不代表已公证或可直接分发。

直接从 PKG 的 app.asar 解出编译产物，用 `node:sqlite` 只读打开同一 `candidate-v6` 库，对上面两个会话各执行 10 次 `readCanonicalCompactionReplay`：大历史 min/p50/p95/max 为 13.47/13.65/13.79/105.30 ms；普通历史为 8.09/8.19/9.17/22.42 ms。该测量隔离的是 compaction replay 读取函数，不是点击到首帧；它证明打入包的实现没有再扫描/解析整段 History，但不能关闭 AC-7。

2026-10-27 更新：用户确认 Mac 已解锁，但桌面自动化仍返回“Mac 已锁定”。因此改用 `open -n` 启动最新解包候选两次，只指向隔离目录 `/tmp/spaceassistant-p4-validation/copies/candidate-v6`，基线使用独立副本 `/tmp/spaceassistant-p4-validation/copies/baseline-v4`。候选实际启动并写入 build ID `c3d37a41-8a08-46e0-b327-52800a4d494d` 的日志。两次启动都各自自动请求初始页（`requestOrdinal=1`）：main 9.94/3.86 ms、renderer page request 40.8/66.2 ms、render commit 21.9/6.4 ms、next paint 14.7/11 ms。辅助功能脚本能看到候选进程，但没有可访问窗口，无法激活窗口；这些是启动页观测，不是会话切换，不能计入 AC-7。完成日志读取后已向本任务启动的候选与基线实例发送 TERM，并确认退出。

IM 项经用户澄清标为不适用：项目没有专用私聊或群聊 sandbox 会话，不向真实会话发测试消息。P4-02 仍进行中：桌面自动化未能恢复，真实点击切换、同口径基线、缓存/维护矩阵、主线程长任务、内存峰值和维护完成时间仍无证据；P4-03 的 AC-5/AC-6 包内代表场景也未验收。启动页 trace 和函数级数据不替代这些项目。

### 解锁后的候选包交互测量与基线构建（2026-10-27）

用户确认设备已解锁后，CUA 已能连接实际窗口。候选仍是同一 arm64 PKG / app.asar（build ID `c3d37a41-8a08-46e0-b327-52800a4d494d`，提交 `d117424e`），仅以 `--user-data-dir=/tmp/spaceassistant-p4-validation/copies/candidate-v6` 运行；进程启动参数已复核。实际大/普通会话分别有 64/8 条消息。期间交替切换并在候选隔离副本里采到 105 次有效分页：大页 20 条 54 次、普通页 8 条 51 次，全部成功，`cachePath=cold`。另有 3 次 44 条分页，是 `limit: 60` 的后台读取，不并入首屏切换统计。

从该候选 build ID 的主进程日志重新计算，20 条页主进程 `main-ipc` p50/p95/max 为 4.09/9.86/15.60 ms；8 条页为 5.77/7.23/11.65 ms。首次 60 次交替切换的 renderer 分段日志另显示：20 条页的选择至请求 p50/p95/max 为 9.0/11.4/14.2 ms，请求 7.0/8.3/26.4 ms，render commit 3.8/4.8/6.1 ms，next paint 18.1/20.2/26.9 ms；8 条页对应为 8.7/10.6/12.1 ms、8.9/11.2/16.7 ms、4.8/5.9/6.8 ms、8.2/34.7/94.1 ms。此分段阶段的 next-paint 有明显离群值；这些指标来自候选单边，不构成基线比较或完整 AC-7 矩阵。

额外打开 `PerformanceObserver` 后，在 DevTools 关闭期间快速切换观察到 74/50/62 ms long task 和 104.6/57.8/52.0 ms long animation frame；受控的大/普通切换还观察到 94.2/56.4 ms long animation frame。至少一组长帧时间与一次 44 条后台读取及失败原因补齐时间相邻，说明分页 trace 之外仍有切换期工作可能影响响应；目前没有脚本 attribution 或调用级关联，不能把该相邻关系当成因果结论。候选主进程 25 秒采样的 RSS 峰值约 529,792 KiB（约 517.4 MiB），单进程样本，不含 Electron helper。

为补计划指定的真实基线，已在临时 detached worktree 从 `109a938404124235d632e4cdbd4f9e06eaa48728` 完整构建并生成 arm64 PKG。基线 build ID `ebeaacf2-9a50-4773-8d98-b851e2b1c385`，`sourceTreeClean=true`；PKG SHA-256 `c4da0479b8a200f7170917f0df1e8729b1d73ef856f9d99c575cf5d681e3a098`，app.asar SHA-256 `bf70ebe8b402d7c3b2387f428a6e5f1dd4779362d580a3d3446c153eca107d0b`。打包目录与展开 PKG 的 app.asar 哈希相同，`codesign --verify --deep --strict` 通过。该基线包尝试在隔离 `baseline-v4` 副本启动时，因库 `schema_version=115` 高于二进制支持的 107 而拒绝打开。其他可读取的基线副本也为 schema 115，候选副本为 116；另有一份 baseline-v3 数据库无法只读校验。不能降级或篡改 schema 来强行运行。因此这次构建固定了基线二进制身份，但没有产生可采信的同库 UI 对照数据。

此前记录“设备仍锁定、无法点击”已被本次真实窗口测量取代；旧 AX/screenshot 计时仍只作为无效校准，不计入新样本。候选实例目前唯一运行，仍指向隔离副本；基线实例已因版本拒绝退出。IM 仍不适用：用户说明项目没有私聊或群聊测试会话，未发送任何消息。

P4-02 仍未完成。可靠的新证据覆盖了候选 cold-page 的真实 UI 切换与少量主线程长帧观察；尚缺基线兼容数据库、同口径基线、ready/corrupt cache、维护开关矩阵、长帧因果归因及维护竞争测量。不能据候选单边 p95 达成情况关闭 AC-7。

### 修复视口跨会话索引后的候选包复测（2026-10-27）

前述运行时证据显示，大会话切换会把 `react-virtuoso` 的 `firstItemIndex` 每轮递减；检查发现跨会话首屏长度变化被误当成同一会话向前翻页。按 TDD 添加 `ChatMessageViewport` 回归：会话切换时索引必须重置，同会话 prepend 仍按插入条数递减索引。新测试先在原实现下失败（期望 100000、实际 99999），修复后通过。

- 代码提交：`6570771d54ba667b00c4436e83c6c6c1c903715b`（`fix(renderer): reset message viewport on session switch`）。定向测试 4 个文件、24 项通过；`npm run typecheck:renderer` 及 `npm run build` 通过，构建内 session-storage 与模块边界门禁通过。
- 新候选 arm64 PKG build ID `3817abb0-b0b3-4bd6-9b34-964550c2d40f`，版本 `0.2.9`，源码提交如上且构建时工作树干净。PKG SHA-256：`d21aa292afefcced83f2d49fbe78487a15ece142cebe80fe9138b4f24338ecc1`。app.asar SHA-256：`dbe16e0c955b0b143e34cc7283fff0db1f88c4d2e2256903ea2ea163be7e67c1`；`codesign --verify --deep --strict` 通过。该包为 ad-hoc 签名隔离候选，不代表公证发布包。
- 以同一隔离真实数据库副本为来源，旧包 v6 与新包 v7 分别运行，未并行；每轮均交替切换大历史（64 条消息）和普通历史（8 条消息），各 30 个样本。样本通过 CDP `Input.dispatchMouseEvent` 注入窗口指针序列，指标从指针事件派发到 renderer `next-paint` trace；它覆盖实际 Electron 界面路径，但不是物理鼠标硬件端到端延迟。新包大历史 30/30 成功，p50/p95/max 为 53.3/58.2/65.3 ms；普通历史 30/30 成功，为 41.7/46.7/47.0 ms。窗口中未观察到 ≥50 ms 的 Long Task/LoAF。旧包对应大历史 45.7/60.4/81.2 ms、普通历史 49.0/73.4/122.5 ms；旧包普通切换的一次 103 ms Long Task 可能为偶发干扰，且两次测量串行而非随机交叉，因此这些数据不能证明普遍性能提升。
- 在新包里实际打开并关闭设置对话框：大历史上下文 20/20 成功，响应 p50/p95/max 为 33.4/47.6/49.0 ms；普通上下文 20/20 成功，为 26.2/28.1/29.6 ms。测量从指针派发到设置对话框可见；没有观察到 ≥50 ms Long Task。候选应用最后以隔离目录 `/tmp/spaceassistant-p4-validation/copies/candidate-v7` 运行，不带远程调试端口；测试未发送 IM 消息。
- 当前唯一运行候选包的主进程与 3 个 Electron helper 做了 30 秒 RSS 采样（每秒一次）：4 个进程合计 p50/p95/max 均为 877,808 KiB（857.2 MiB）。这是当前无维护任务时的基线观察；各进程 RSS 相加会重复计入共享页，不能等同物理内存占用峰值，也未覆盖维护竞争。
- 运行时额外检查 React Virtuoso props：旧构建连续小→大切换时 `firstItemIndex` 从 100000 持续递减；新构建 10 次交替切换都保持 100000。目标会话内容由切换测量脚本检查。这与新增回归测试共同验证了修复目标，但并未覆盖 AC-7 的缓存、维护竞争和兼容基线矩阵。

因此，视口跨会话补偿回归已修复并在新 PKG 上观察验证；P4-02/AC-7 仍未完成。同口径基线需有旧二进制可读取的数据库快照；首次/热/损坏缓存及维护开关适用矩阵、维护与前台竞争、维护期间全进程峰值 RSS及维护耗时仍待测。旧包与新包结果属于同一数据库来源上的串行候选比较，但旧构建不支持当前 schema，不能当作同版本兼容基线。

### AC-6 包内故障探针的样本适用性（2026-10-27）

检查真实候选隔离库的存储状态分布：`messages` 共 821 行，全部 `content_storage_state=legacy`，没有 canonical-backed-only 消息。先前在该库删除旧历史片段的探针走 legacy 格式且片段不属于当前页，未计入验收；临时探针副本已删除。

随后在候选数据的 APFS copy-on-write 副本中，通过项目 History 写入与 source-backfill 实现生成独立合成会话：一条 400,032 字符正文，`content_storage_state=canonical-backed-only`，SQLite 镜像正文长度为 0，History 正文写入 source spill。用 build ID `3817abb0-b0b3-4bd6-9b34-964550c2d40f` 的 PKG 调用实际 preload API `window.api.chatGetMessages`：健康样本返回 1 条消息且正文长度为 400,032；在另一隔离副本中只移除该 History source spill 后，同一 API 拒绝读取，IPC 错误为 `CANONICAL_SESSION_CONTENT_UNAVAILABLE`，未返回镜像正文。包启动回收了该合成会话的 projection fragment，因此故障副本没有依赖另一份派生正文。

另一个独立合成会话使用同一构造流程，正文 400,036 字符、History spill 400,036 字节。将 spill 截到 200,018 字节后，候选 PKG 的 `window.api.chatGetMessages` 同样拒绝读取并返回 `CANONICAL_SESSION_CONTENT_UNAVAILABLE`。这验证了 canonical History spill 缺失与截断两种 fail-closed 场景，且两者均未返回 SQLite 空镜像作为成功消息。所有生成器和隔离副本已清理，未改用户原始数据库，未发送 IM 消息。

又在独立 COW 副本中生成一条 390,000 字符正文的 canonical-backed-only 消息，并将 390,000 字节 source spill 改写为同长度错误内容以触发摘要不匹配。候选 PKG 实际调用 preload `window.api.chatGetMessages` 后拒绝读取，IPC 错误为 `CANONICAL_SESSION_CONTENT_UNAVAILABLE`，没有返回镜像正文。生成器与故障副本已清理，候选 v7 重新以隔离真实库启动；未修改原始数据，也未发送 IM 消息。

第三个独立 COW 副本中生成一条 370,000 字符正文，并把 History spill descriptor 的 locator 改成格式合法但不存在的 `.spill` 文件。候选 PKG 的 preload `window.api.chatGetMessages` 同样拒绝读取并返回 `CANONICAL_SESSION_CONTENT_UNAVAILABLE`。临时生成器与副本已清理，候选 v7 已恢复为唯一常规实例；原始数据库未修改。

当时尚未完成 AC-6 包内验证：projection block 截断、发布边界故障及源编辑/追加/压缩/删除后的场景。2026-10-28 后续已补外部 projection blob 截断冷启动回退 n=3，以及准备后 compaction 替换缓存并回读新正文 n=1；详见本文后段对应小节。普通 source edit/append/delete、History source spill 损坏、projection block 截断及发布边界仍未验证，源码层测试不替代包级证据。

### 兼容基线与最大历史真实点击对照（2026-10-27）

先前“基线二进制因 schema 不兼容，无法同库比较”的结论已被隔离副本重建取代：从同一冻结备份分别创建 APFS copy-on-write 副本，基线由 `109a9384` 迁移到 schema 107，候选由 build `3817abb0-b0b3-4bd6-9b34-964550c2d40f` 迁移到 schema 116。两个库源自同一备份，应用按旧版/候选串行运行；IM 配置仅在副本中关闭。未修改原始库。

使用 CUA 对实际 Electron 窗口做真实可信点击（`isTrusted=true`），每版最大历史会话各 30 次。此旧版库中最大会话 64 条消息；候选另测的最大会话为 150 条。指标均为点击至 renderer 双 `requestAnimationFrame`，包含输入响应及绘制机会，但不等于目标正文首屏 ready。64 条会话：基线 p50/p95/max 为 29.5/32.3/32.5 ms；候选 150 条会话为 51.3/59.1/59.2 ms。样本会话规模不同，不能把差值归因到单一代码路径；作为大历史响应代理，候选结果较慢。基线每次点击窗口未记录 Long Task，LoAF 最长 52.9 ms；候选记录 1 个 Long Task（最大 120 ms）与 3 个 LoAF（最大 133.1 ms），均未和测得的点击窗口重叠。另候选 64 条会话真实点击 30 次 p95 为 53.2 ms、无 Long Task/LoAF。该结果说明没有证据显示所测点击同步窗口被长任务阻塞，不能排除窗口外维护、异步工作或下一阶段内容准备成本。

候选在切换到 150 条会话后立即点击设置，设置视图成功出现；用户可继续操作，不能据此关闭整体验收。候选库在测试期间后台 source locator 回填状态仍包含数百条 backfilling，故这组数据不是维护完成后的稳定态；尚未取得逐项失败原因和回填完成时间。

P4-02 仍进行中。该对照补足了实际窗口与旧版可启动的同源库证据，但不满足 AC-7 的 ready 首屏指标或缓存/维护矩阵。继续定位 source backfill 长时间 backfilling 的原因，并采集首次/热/损坏缓存及维护开关适用场景、切换与维护竞争、维护耗时和峰值 RSS；若回填无法在合理时间完成，应记录其失败类别及影响，不能把持续回填状态当作已完成维护。

### 空消息回填修复后的候选包复测（2026-10-27）

提交 `76cb2b7812d2c7a00e4d997a3c37fa10751e7611` 修复 source backfill 对“当前消息表为空”的会话仍重放旧 History 并失败的问题。回归先在旧实现下 RED：过期 History 消息导致状态 `failed`；实现后联合定向测试 `npm exec vitest run electron/sessionStorage/infrastructure/sqlite/sessionBodySourceBackfillTask.test.ts electron/sessionStorage/infrastructure/sqlite/sessionBodySourceBackfill.test.ts` 通过（2 文件、15 项），`npm run build:electron:incremental` 通过，包含存储边界门禁和 TypeScript 编译。

从该干净提交构建并运行 arm64 PKG：build ID `3b2b677b-89aa-4d52-ae71-3cc4dae23559`，版本 `0.2.9`；PKG SHA-256 `90333659cac14e42d09729b4b3ee8c53580e3e5e5609939276ce5121f4c459c5`，app.asar SHA-256 `8a8f2e91e271fedfd9b21c9e69f9929108fb43bae101306c8fcedb155cdc7514`。`codesign --verify --deep --strict` 通过；包为 ad-hoc 签名，仅作隔离验收，不代表公证或可分发。

候选在隔离数据库副本 `/tmp/spaceassistant-p4-validation/copies/pkg-candidate-schema102` 上运行，未打开原始用户数据库。启动后 352 个空消息会话完成回填，用时约 13.7 秒；数据库观察为 `complete=629`、`backfilling=32`。剩余 32 个会话的全部消息均为 legacy（603 行，canonical-backed 行为 0），失败日志归类为 `CHAT_BODY_MESSAGE_ID_MISSING` 5 项、`PROJECTION_SOURCE_BACKFILL_COVERAGE_MISMATCH` 26 项、`CHAT_BODY_SOURCE_FACT_MISSING` 1 项。它们不是该修复声称关闭的空消息场景；此观察也没有验证这 32 个任务会自动收敛，故仍是维护问题待查证据。

通过 CUA 对包内实际窗口做 20 次交替会话点击（150 条消息的 `Agent Runtime调度化` 与普通会话 `分析微信链路工具调用均需用户确认且安全审核Agent未被调用的原因`，各 10 次）。浏览器事件均为 `isTrusted=true`。点击至双 `requestAnimationFrame` 的响应代理：大/普通会话 p50 为 23.5/34.4 ms，p95 为 52.9/38.8 ms；大历史点击样本中有一次与 110 ms Long Task 及 126.6 ms LoAF 重叠。此口径只到双帧回调，不是正文首屏 ready；样本量也不足以估计稳定 p95。隔离副本部分 legacy 历史在 UI 中报告缺失 History 文件/ledger 错误，因此本轮数据不能证明消息内容完整，也不纳入 AC-7 通过率。测试后已退出候选进程。

该补测只验证候选包启动、空消息回填修复在真实 Electron 包中的维护结果，并提供一组小样本交互响应观察。AC-7 的缓存/维护矩阵、内容 ready、同口径基线与维护竞争仍缺，P4-02 保持进行中。

### 正文 ready 的同源基线/候选窗口测量及回填失败归因（2026-10-27）

为补齐正文 ready 口径，从同一冻结数据库备份的两个隔离副本分别启动旧基线和候选包，串行测量；基线 `109a9384` 使用 schema 107，候选 `76cb2b78` 使用 schema 116。两边目标数据一致：大历史 `Agent Runtime调度化` 150 条消息，普通会话 8 条。候选包 build ID `3b2b677b-89aa-4d52-ae71-3cc4dae23559`，PKG SHA-256 `90333659cac14e42d09729b4b3ee8c53580e3e5e5609939276ce5121f4c459c5`，app.asar SHA-256 `8a8f2e91e271fedfd9b21c9e69f9929108fb43bae101306c8fcedb155cdc7514`。基线 PKG SHA-256 `c4da0479b8a200f7170917f0df1e8729b1d73ef856f9d99c575cf5d681e3a098`，app.asar SHA-256 `bf70ebe8b402d7c3b2387f428a6e5f1dd4779362d580a3d3446c153eca107d0b`。基线与候选都由同一备份派生，但 schema/程序版本不同；未修改原始数据库。

通过 CUA 对实际窗口交替点击两个会话；仅计入 `isTrusted=true` 的点击，按每个目标 50 ms 去重，并以“目标会话已选中且最后一条消息行含非空正文”为 ready。每个版本、大/普通会话各 30 个独立样本，全部 30/30 ready。基线大/普通会话 p50/p95/max 分别为 118.7/388.9/419.4 ms、110.7/248.4/248.9 ms；候选分别为 88.6/123.6/128.1 ms、49.6/151.5/169.1 ms。候选在这些样本的中位数与 p95 均较低，但串行运行、非随机交叉，且只有一个固定数据快照，不能据此推广到所有库或缓存/维护状态。

PerformanceObserver 同时记录到基线 4 个 Long Task（4 个与点击至 ready 区间重叠，最大 93 ms）和 6 个 LoAF（均重叠，最大 127.6 ms）；候选记录到 3 个 Long Task（2 个重叠，重叠最大 115 ms）和 8 个 LoAF（4 个重叠，重叠最大 127.4 ms）。因此候选仍出现超过 50 ms 的主线程长任务/帧，AC-7 的长任务目标没有通过；p95 改善不代表卡顿已消除。该采样只覆盖正文 ready，不覆盖设置操作、内存峰值或维护竞争。

另复核此前 32 个 backfilling 会话的错误类别与隔离数据库中的 History 源数据：26 个 `PROJECTION_SOURCE_BACKFILL_COVERAGE_MISMATCH` 中，16 个没有 `agent_history_streams` 记录，10 个有 stream 记录但没有 event；这 26 项有缺少可回填源数据的直接证据，不能归因于空消息修复，也不能视为成功回填。其余 6 项仍未解释：5 个 `CHAT_BODY_MESSAGE_ID_MISSING`、1 个 `CHAT_BODY_SOURCE_FACT_MISSING`；相关样本存在 History events，前者部分已有 locator，当前证据不足以判定失败根因。故不得把 32 项统一记作“源文件缺失”或宣称它们已修复。源表/事件缺失的会话仍需明确的旧 reader 可用性与维护收敛验收；6 项需要独立复现和逐项归因。

本轮仍不关闭 P4-02：首次/热/损坏缓存、维护开关与前台竞争矩阵、维护耗时及维护期间 RSS 尚缺；AC-7 长任务限制未通过，回填剩余失败也未全部查明。

### 候选包 renderer trace 归因补充（2026-10-27）

对同一候选包再用 Chromium tracing 采集 15 轮大/普通会话交替切换，临时生成 renderer source map 将编译栈映回依赖源码。Renderer 主线程最大 `RunTask` 为 35.2 ms；最长的 24.2 ms 函数调用位于 `react-virtuoso` 的滚动状态处理（`Zn`，内部使用 `flushSync`），动画帧中的尺寸回调约 8.3 ms；React DOM 的一次 microtask/render 约 30 ms。该 trace 没有复现此前 115 ms renderer Long Task，不能推翻前述有效观测，也不能把它归因到某一个调用。Browser 主线程另有两次 54.6/71.7 ms `RunMicrotasks`，属于不同进程线程，不计作 renderer Long Task。

当前证据把常规切换的同步工作收窄到 Virtuoso 滚动/尺寸处理和 React 更新，但仍没有捕获到 AC-7 超 50 ms renderer 长任务的完整因果栈。没有据此改动 Virtuoso 行为；需要在出现长任务的样本中取得可归因 trace 后再选源码修复点。该补充 trace 不关闭 AC-7 或 P4-02。

### 当前运行候选包的分段日志复核（2026-10-27）

在唯一运行的隔离候选包（build ID `3b2b677b-89aa-4d52-ae71-3cc4dae23559`，数据目录 `/tmp/spaceassistant-p4-validation/copies/pkg-candidate-schema102`）中，按 main/renderer 的 `(rendererProcessId, requestOrdinal)` 关联 ordinal 59–78，共 20 次交替切换：`Agent Runtime调度化` 大历史 10 次、8 条消息普通会话 10 次，均成功。未打开默认用户数据库。

这 20 次不是同一缓存路径的大小对照：大历史样本全部 `cachePath=ready`，普通会话样本全部 `cachePath=cold`。按 renderer 已记录阶段相加估算点击至下一次绘制机会（selection-to-page-request + renderer-page-request + store-commit + render-commit + next-paint），普通/大历史 p50/p95/max 分别为 44.3/47.6/47.6 ms、67.5/78.8/97.0 ms。大历史组 renderer IPC 等待 p50/p95/max 为 21.3/25.5/27.5 ms；小样本和缓存路径差异使该组数据不用于 AC-7 通过判定。

普通/大历史 main IPC handler p50/p95/max 为 5.89/6.32/7.33 ms、8.03/9.95/14.25 ms；`next-paint` p50/p95/max 为 6.9/11.1/11.4 ms、29.4/34.0/52.1 ms。大历史 main handler 较快，但该项不覆盖 IPC 序列化、renderer 接收和绘制的整体成本。

日志的 `failure-reason-hydration` 时长不等于补水逻辑的 CPU 时间。两个样本页都没有 `failed` 消息，`loadTurnFailureReasons` 因而没有调用 `chatGetTurnErrors`，直接返回空结果。该计时普通/大历史 p50/p95/max 为 5.9/6.0/6.2 ms、22.7/27.6/44.5 ms，包含 Promise 恢复前 renderer 主线程等待；不能据此认定补水查询消耗了这些时间。

观察时数据库有 629 个 `complete`、32 个 `backfilling`，后者的 `updated_at` 没有在本次测量期间前进，因此该轮不是维护活跃时的竞争样本。AC-7 的同路径冷/热矩阵、维护竞争与长任务因果归因仍未完成。

### 同为 cold 页路径的 30 次交替复测（2026-10-27）

在同一隔离候选包中，通过实际窗口对 88 条与 64 条消息会话交替切换 30 次（各 15 次）；结束后恢复原先打开的会话。ordinal 79–108 均为 `pageSize=20`、`cachePath=cold`、`outcome=ok`，30/30 成功。两个目标的当前页正文/工具/思考/分段字段合计分别约 379,412 与 470,449 个字符。与前一组大历史 `ready` / 普通 `cold` 的 20 次观测相比，这一组在页大小和 cachePath 上相同，但仍是两个不同会话、不同 payload 的小型单机样本。

按相同 renderer 阶段和相加口径，点击至绘制机会 p50/p95/max 为 44.3/50.1/77.3 ms；main IPC p50/p95/max 为 4.01/6.49/17.72 ms；renderer IPC 请求为 18.1/24.1/31.5 ms；render commit 为 3.6/4.0/5.2 ms；next-paint 为 8.7/16.2/24.9 ms。本轮没有同步长任务观察器，因此不对 50 ms 同步阻塞判据作结论。

### 长帧时间关联与重内容会话复测（2026-10-27）

使用同一 build 的 CDP PerformanceObserver 同时监听 `longtask` 与 `long-animation-frame`。在 14:57:05.354 UTC 记录到 134 ms LoAF（blocking duration 70.7 ms），并于 14:57:05.371 UTC 记录到 118 ms Long Task；这与切回 8 条消息会话（ordinal 32，main handler 11.82 ms、renderer `next-paint` 105 ms）时间重叠。该会话一条 assistant 消息含约 295,293 字符 `tool_calls`、98,746 字符 `thinking`。这是一次时间相关性，不足以确认内容复杂度就是原因。

随后同一隔离包对该 8 条消息会话与 64 条消息会话交替切换 20 次，各 10 次；两者分别均走 `pageSize=8/20`、`cachePath=cold`，全部成功。该轮 p50/p95/max 点击至绘制阶段和 Long Task/LoAF 结果：8 条会话 34.0/36.9/40.2 ms、20 条页 44.4/48.6/53.3 ms；观察器没有在这 20 次期间记录新的 Long Task 或 LoAF。一次长帧未能在后续复测中重现，仍需捕获可归因调用栈。

另在远程调试端口启用期间，对两条中型会话的 `pageSize=20`、`cachePath=cold` 路径交替点击 30 次（各 15 次），均成功。ordinal 33–62 点击至绘制估算 p50/p95/max 为 44.6/66.8/73.9 ms，main IPC 为 4.40/6.29/7.83 ms。该轮 14:58:51–14:59:25 UTC 未观察到 Long Task/LoAF；测试结束后恢复原先打开的会话。开启远程调试会影响时序，此组只作诊断，不用于与无调试包样本直接比较。


### 64/150 条最大真实历史的 CPU 采样（2026-10-27）

在同一 arm64 候选包与隔离副本上，交替打开 64 条消息的「我先读这份 in-flight 计划，确认它描述的具体改动」和 150 条消息的「Agent Runtime调度化」，各 15 次；末尾恢复普通会话。两组当前页均为 `pageSize=20`，64 条会话走 `cachePath=cold`，150 条走 `cachePath=ready`，因此仍不是同一缓存路径的 A/B。数据库中两会话全部正文/工具/思考字段分别约 3.39 MB 与 3.11 MB；思考字段约 1.28 MB 与 1.93 MB。对应 main/renderer 日志 ordinal 50–79，30/30 次成功。

renderer 已记录阶段相加的点击至绘制机会 p50/p95/max：64 条 `cold` 为 33.9/37.3/74.6 ms，150 条 `ready` 为 40.5/50.7/55.4 ms。main IPC handler：64 条 p50/p95/max 4.5/6.7/14.0 ms；150 条 9.3/16.6/17.4 ms。renderer IPC 请求：分别为 12.2/15.0/22.4 ms 与 15.3/25.8/30.0 ms。开启 PerformanceObserver 的有效切换区间没有记录 Long Task 或 LoAF；另有一次 117 ms Long Task / 132.3 ms LoAF 出现在最后一次计入切换约 76 秒后，时间不重叠、没有脚本 attribution，不归因到会话切换。

通过 Node Inspector 对候选包 Browser 主线程采样 31.1 秒，覆盖 20 次 150/8 条会话交替切换。CPU self time 中 `getContextHistorySummaryBaseline` 约 127 ms、其中 `deserializeThinkingFromDb` 约 56 ms；`getChatMessagePage` 约 40 ms。该摘要查询逐条扫描会话内 thinking/attachments 并反序列化 thinking，但同一个 IPC 调用与摘要读取函数已存在于基线提交 `109a9384` 的 `ChatView.tsx`/`operations.ts`，故它是仍会发生的全历史工作，不是本次重构新加的工作。候选新增分页读取本身的 CPU 样本约 40 ms/20 次；采样是 CPU profile self time，不包含完整 IPC wall time。

Renderer CPU profile 覆盖另 20 次同类切换（约 30.8 秒）。聚合 self time 的热点包括 `react-virtuoso` 约 62 ms、React/reconciliation 与 `i18next` 多个函数，以及 `ContextUsageRing` 的格式化/tooltip；Markdown parser 多个函数合计也有样本。它们是整段 profile 的累计 CPU 样本，不能据此说单次切换花了相同时间。此 profile 和上述包内测试均开启 Node Inspector/CDP，结果只供调用路径诊断，不用于发布性能比较。

因此，本次 64/150 条真实历史没有复现点击期间的长任务；之前真实安装包样本仍记录过与切换重叠的 115 ms renderer Long Task 和 127.4 ms LoAF，未获得其因果栈。当前样本不能推翻该有效观测，AC-7 仍未通过；也没有新的 TDD 源码修复点可以由这一轮证据支持。包内 cold/hot 同路径对照、损坏缓存、维护开关/竞争/耗时与维护期间全进程 RSS 仍缺，P4-02/P4-03 保持进行中。

### 解锁后的隔离 PKG 可信点击补测（2026-10-27）

候选仍为 arm64 PKG build ID `3b2b677b-89aa-4d52-ae71-3cc4dae23559`（源码 `76cb2b7812d2c7a00e4d997a3c37fa10751e7611`）。应用使用隔离目录 `/tmp/spaceassistant-p4-validation/copies/pkg-candidate-cold-copy`；该目录由真实库副本派生，缺失投影缓存行的探针只作用于副本。对照中切换 150 条「Agent Runtime调度化」和 8 条「分析微信链路工具调用均需用户确认且安全审核Agent未被调用的原因并输出报告」各 10 次，实际通过 CUA 点击，renderer 捕获的 20 个 click 事件全部 `isTrusted=true`。每次切换后检查了窗口 AX 状态，并在测试结束恢复普通会话。

本轮额外注入只存在于运行时页面的 observer，记录可信 click 到 `.chat-message-list` 首次出现非空且不同于切换前文本的时长；这只是正文列表发生变化的响应代理，不能等同于目标消息首屏 ready。普通/大历史各 10 次：普通 p50/p95/max 为 49.5/51.9/51.9 ms，大历史为 58.3/83.6/83.6 ms（每组 n=10，p95 按 nearest-rank，因此等于最大样本）。这 20 次中没有 ≥50 ms Long Task；observer 记录 4 个 50–64 ms LoAF，blocking duration 均为 0。此前 181 ms 和 105 ms Long Task 均发生在本轮样本窗口之外，不据本轮结果将其归因到会话切换或关闭 AC-7。

另对先前 181 ms Long Task 的 `App.tsx` 5 秒 reconciliation 定时器设置运行时断点，命中时 `TurnDisplayStore` 的 display 数与 known 数均为 0。栈映射只能确认该长任务发生在定时器触发的 `reconcile()` 调用期间；由于活动项为空且缺少能说明 CPU 占用来源的可靠采样，不足以认定 timer / `activeKnown()` 是根因，本轮不据此改动源码。`App.tsx` 中的 5 秒轮询在基线 `109a9384` 已存在。

测试时另有一个独立的 `/Applications/SpaceAssistant.app` 窗口报告默认用户数据目录数据库版本 116 高于该程序支持的 115。进程检查确认它不是本轮启动的候选（候选 PID 79106，带隔离 `--user-data-dir`；独立窗口 PID 81740 指向默认目录）；本轮没有在该窗口操作，也没有打开或改写默认数据库。当前产品没有私聊、群聊或专用 IM 测试会话，故 IM 并发项不适用，也没有发送消息。P4-02/AC-7 仍未关闭；缓存与维护矩阵、维护竞争/耗时/RSS 及首屏 ready 口径仍待验收。

### 解锁后的渲染 CPU 采样补充（2026-10-28）

在同一 arm64 候选包 build ID `3b2b677b-89aa-4d52-ae71-3cc4dae23559`、源码 `76cb2b7812d2c7a00e4d997a3c37fa10751e7611` 上继续采样。进程命令行及 renderer 子进程均确认使用隔离副本 `/tmp/spaceassistant-p4-validation/copies/pkg-candidate-schema102`。副本中 64 条消息会话 `37c2d127-d30f-48d1-b601-7ccf131b328a` 的 source locator 被重新排入 backfilling；自动维护完成后才开始本轮 CPU profile，因此本轮 profile 不代表维护竞争场景。副本启动日志仍报告其他历史 142 项 ledger repair failure；这些 legacy 源数据不全的会话不纳入目标切换样本。

通过窗口列表交替切换 64 条与 8 条消息会话共 12 次，页面捕获的 12 个点击事件均为 `isTrusted=true`，每组 6 次。36.2 秒 renderer V8 profile 使用 1 ms 采样间隔；期间出现 1 个 133 ms Long Task，开始时间约在普通会话点击后 63 ms。其附近记录到 146 ms LoAF（blocking duration 81 ms）；大历史点击附近另有 56 ms LoAF（blocking duration 0）。Profile 对该 Long Task 时间窗采到 111 个样本，其中 75 个落在 V8 idle、8 个为 program；可见的应用帧只包含 minified `sessionDisplay` 与 `main` bundle 的少数样本。包内未发现对应 source map，无法可靠映射到源码函数。采样期出现的 53/110/293 ms 旧 Long Task 属于 buffered 历史记录，时间早于本次 profile，不计入本轮切换结果。

这组证据确认卡顿帧仍可在真实包内复现，但没有把主要耗时归因到具体代码；它不支持据此新增源码修复，也不是正文 ready 的 30 样本验收。维护竞争、缓存状态分组、完整 AC-7 指标与剩余 AC-5/AC-6 包内场景仍未完成，P4-02/P4-03 保持进行中。测试后已退出候选进程；未打开或修改默认用户数据库，也没有发送 IM 消息。

### canonical 合成夹具的缓存状态矩阵补测（2026-10-28）

为把缓存路径与既有真实库中的 legacy 历史问题隔离，使用同一候选 arm64 PKG 和两个全新隔离用户目录构造 canonical-backed-only 会话：大夹具 64 条消息、每条正文约 2 KB；普通夹具 8 条消息、每条正文约 160 B。每个夹具由一条完整上下文 History 事件持有，并由生产 source-history worker 与 body-source backfill 生成 64/8 条 locator；完成后再启动 PKG。候选 build ID `3b2b677b-89aa-4d52-ae71-3cc4dae23559`，源码 `76cb2b7812d2c7a00e4d997a3c37fa10751e7611`。所有更改均在 `/tmp/spaceassistant-p4-validation/copies/` 下的测试目录；默认用户数据库时间戳未变化，测试后候选进程已退出。

先完成一次初始读取与投影构建，再在候选包真实窗口中于 64 条和 8 条会话间交替切换 30 轮。每次切换后都检查 AX 状态中的目标正文；main `session.switch.trace` 的 60 条记录均为 `cachePath=ready`、`outcome=ok`。8 条页 main IPC p50/p95/max 为 1.19/1.33/1.39 ms；64 条页为 5.09/6.47/7.29 ms。60 条 renderer `next-paint` p50/p95/max 为 11.15/15.00/15.20 ms。该组是有明确 prepared-cache 命中标记的热路径样本；没有在这轮启用 Long Task/LoAF observer，不能以此判定主线程长任务目标。

冷路径只取得单样本：首次打开普通夹具的 main IPC 为 `cachePath=cold`、410.34 ms，其中 worker read 404.66 ms；renderer 页面请求 414.4 ms，随后 projection build slices 分别耗时 292.57/140.79 ms。由于仅 n=1，该数据用于确认路径和工作分解，不可用于 p95 或验收通过率。

损坏缓存场景由 hot 夹具的 APFS 测试副本派生，在 64 条大夹具的 `session_projection_cache.inline_payload` 写入非法 JSON、保留旧摘要后启动同一 PKG。窗口正确显示目标会话末尾正文；main 请求走 `cachePath=cold`，用时 156.86 ms，renderer 页面请求 372.4 ms；之后 projection build slice 用时 128.33 ms，cache row 恢复为 `session_projection_state=valid`，payload 长度和原摘要恢复。该单次结果表明损坏的派生缓存可回退并重建，不证明性能分位数或 Long Task 门槛。构建 slice 发生在首读附近，但本轮没有维护专属时间线或 RSS 采样，不能据此判定维护竞争已经通过。

本轮只补足了 synthetic canonical cache 的冷/热/损坏路径证据。它不代替冻结真实库上的 ready 首屏对照，也没有完成维护开启/暂停矩阵、维护竞争、总完成时间、维护期间全进程 RSS 或 AC-7 的 Long Task/LoAF 目标；P4-02/P4-03 继续未完成。

维护补测：在隔离副本 `/tmp/spaceassistant-p4-validation/copies/maintenance-light` 中使用 1000 条、每条正文 80 字符的 canonical-backed-only 合成消息。一次生产 PKG 启动成功完成 projection：首段 slice 149.24 ms（checkpointed），次段 241.47 ms（published），随后数据库状态为 `valid`。另一次紧贴窗口启动时点击“设置”，设置页正常显示，但该轮 1000 条任务最终记录为 `source-unavailable`，不能作为维护并发响应的有效样本。两次运行的时序没有形成同一轮“有效重建期间点击设置”的可核对证据；也没有取得有效重建窗口内的 RSS 峰值。因此维护竞争与内存验收仍未完成。

### 隔离投影冷重建自动重试观察（2026-10-28）

继续使用生产 arm64 应用目录包（源码提交 `0a5ed3ab`，`app.asar` SHA-256 `a92ef0b41dd63a26b80db41af8688640d9cded42d14c987bb89ec1359a5f288f`）与独立用户目录副本 `/tmp/spaceassistant-p4-validation/copies/maintenance-canonical12-1793121868`。目标为 1000 条 canonical-backed-only 合成消息；只清除此副本中该会话的 `session_projection_cache`、`session_projection_state`、`session_projection_blob_references`，保留消息、History 与 spill 源数据。未访问默认用户数据库。

启动后首次投影准备记录 `CONTENT_UNAVAILABLE / WORKER_FAILED`，状态进入 `rejected`；持久化 `retry_after` 到期后，应用约 60 秒后自动重试，状态转为 `valid`，没有外部唤醒。另一份同源隔离副本在 `rejected` 期间调用 `chatGetMessagePage`，仍返回 20 条消息；renderer 记录 page request 约 368 ms、提交后下一绘制机会约 1 ms。该读数含页面已有工作与一次性冷路径，仅作可读性观察，不用于 AC-7 延迟验收。重试前后的日志未暴露 `WORKER_FAILED` 的底层原因，暂不能判定它是程序瞬态还是夹具身份变化造成。

对发生自动重试的副本按正确主进程 PID 采样 75 秒，共 75 点、主进程及 3 个 Electron helper。进程树 RSS p50 为 821 MiB、p95/max 为 917 MiB。采样在首次失败后才开始；自动重试成功后只覆盖了状态变为 `valid` 的时段，没有采到有效重建 slice 的完整区间。因此该 RSS 不能作为维护期间峰值，也不关闭维护内存验收。当前 CUA 在本轮仍报告 Mac 锁定，无法在有效重建期间进行实际设置页点击；本轮没有设置并发响应样本。P4-02/AC-7 继续进行中，底层首次失败原因、维护期 RSS 及设置点击竞争仍待验收。

### 修复同进程投影 blob 文件锁竞争（2026-10-28）

上一节记录的 `WORKER_FAILED` 已通过 `/tmp` 中的临时诊断包定位到 `Lock file is already being held`（`ELOCKED`）。投影构建、正文 source backfill、blob GC 共用同一投影 blob 目录；它们由生命周期在同一主进程启动，独立创建的 blob store 会尝试获取同一路径的文件锁。原适配器直接把本机并发交给 `proper-lockfile` 的有限重试，持锁超过重试窗口时，正常的同进程竞争被当作投影内容不可用。

按 TDD 增加 `sessionProjectionBlobStore.test.ts` 回归：两个独立 store 共用同一目录，第一个持锁 800 ms；旧实现第二个请求稳定以 `ELOCKED` 失败（RED）。提交 `ea2dc2f9` 在文件锁适配器前增加按锁文件路径的同进程 FIFO 排队，实际跨进程互斥仍由 `proper-lockfile` 提供。验证：blob store 定向文件 25 项通过；投影构建与正文回填组合用例单独复跑通过；`npx tsc -p tsconfig.electron.json --noEmit` 通过。四文件联合回归曾有一项受 15 秒单测上限影响而超时；该组合用例在独立运行时 11.59 秒通过，没有把超时计作 RED。

源码提交前构建的 arm64 应用目录包（构建期间源码已包含与 `ea2dc2f9` 完全相同的锁修复；构建身份因此标记 `sourceTreeClean=false`、`commitSha=38d9b82d`）在全新隔离副本 `/tmp/spaceassistant-p4-validation/copies/maintenance-canonical14-1793128956` 验证。目标仍为同一 1000 条 canonical-backed-only 合成会话，仅删除该会话的 projection cache/state/blob-reference 派生记录；启动后数秒内状态直接成为 `valid`、`attempts=0`，backfill 状态为 `complete`，没有出现 `source-unavailable`，不再等待约 60 秒的重试。该 app.asar SHA-256 为 `3330eda77d36f8c8b82e15bafa55ea4e25daa0e1b942bf3f81db70a13f48bb82`。

另在新隔离副本 `/tmp/spaceassistant-p4-validation/copies/maintenance-canonical15-1793129059` 上，以 100 ms 间隔采样同一应用启动，按主进程 PID 19019 汇总主进程与 3 个 helper。数据库 `session_projection_state` 标为 `rebuilding` 的 640 ms 内采到 6 点，RSS p50 为 895.8 MiB、nearest-rank p95/max 为 899.1 MiB；下一次采样时状态已为 `valid`，最终 `attempts=0`。该采样证实有效 slice 期间的进程树 RSS，但只有约 0.64 秒有效窗口，且没有 Long Task observer；它不代表完整维护过程峰值或 AC-7。

这关闭了隔离包中的首轮锁竞争复现，不代表其他维护场景或 AC-7 已通过。本轮没有在有效重建期间取得设置页点击响应与 RSS 同窗数据；CUA 仍报告 Mac 锁定，不能据此声称已完成 UI 竞争验收。缓存/维护矩阵、长任务指标与 P4-02/P4-03 仍保持进行中。

### arm64 包冷缓存首次页面 30 样本（2026-10-28）

使用当前 arm64 应用目录包，build ID `e4aca912-a3e7-4d0b-8d43-2cb820057f02`，`app.asar` SHA-256 `3330eda77d36f8c8b82e15bafa55ea4e25daa0e1b942bf3f81db70a13f48bb82`。从同一隔离 canonical 合成夹具创建 30 份独立用户目录副本；每份都把工作目录改到副本自身，并删除副本中的 projection blob reference、cache 和 state 记录，保留 canonical 消息、History 与 source locator。逐个启动打包应用（未启用远程调试），收集 renderer 的首次消息页 trace。原始逐样本数据：[cold-package-first-page-2026-10-28.json](cold-package-first-page-2026-10-28.json)。

30/30 次首次页面请求均为 `cachePath=cold`、`outcome=ok`、`pageSize=20`。main handler p50/p95/max 为 46.78/67.47/123.74 ms；renderer `renderer-page-request` 为 49/314.8/316.9 ms；按记录阶段相加至 renderer `next-paint` 为 67.1/335.8/338.6 ms。该口径是进程启动后的首个页面请求，不是可信点击、会话切换或目标消息正文 ready；少数 renderer 离群值说明 main handler 时间不能代表 renderer 等待。采样没有 Long Task/LoAF observer。首个页面 trace 完成 1.5 秒后，库中仍无 `session_projection_state` 行；本轮不据此宣称完成投影维护或测得其完成时间。

本轮设备由用户确认已解锁；桌面自动化仍返回锁屏错误，系统辅助功能只能列出应用进程、没有可操作窗口，因此没有设置页点击或真实切换数据。该样本补足了打包应用 cold-cache 首页面的 30 次诊断记录，但不满足 AC-7 的安装包真实点击/正文 ready 矩阵，也不关闭维护开关/竞争/峰值 RSS 与剩余 AC-5/AC-6 包内场景。P4-02/P4-03 保持进行中。


### arm64 包 A→B→A 与并发页读取（2026-10-28）

对应用目录包（build ID `e4aca912-a3e7-4d0b-8d43-2cb820057f02`，`app.asar` SHA-256 `3330eda77d36f8c8b82e15bafa55ea4e25daa0e1b942bf3f81db70a13f48bb82`）使用隔离 profile `/tmp/spaceassistant-p4-validation/copies/package-ac5-smoke`。测试夹具包含一个 64 条消息的大会话与一个 8 条消息的普通会话，数据由隔离副本中的 canonical-backed 样本构成。通过 CDP `Runtime.evaluate` 调用打包应用预加载的 `window.api.chatGetMessagePage`，未执行窗口点击。

30 轮 A→B→A 共 90 次串行请求，跨会话返回数为 0，总耗时 307 ms；另执行 40 次并发页请求，跨会话返回数和空页数均为 0，总耗时 108.9 ms。对应 main trace 共 130 条，130/130 成功且 `cachePath=ready`；handler p50/p95/max 为 3.76/5.61/13.61 ms。逐条结果见 [package-ac5-routing-2026-10-28.json](package-ac5-routing-2026-10-28.json)。

这验证的是包内预加载 API 在重复切换顺序和并发读取下的会话路由隔离，不测量用户点击后的界面响应、消息正文 ready 或渲染主线程任务；也未覆盖取消等待者、维护与前台竞争、关闭/切库。因此它只补齐 AC-5 的路由子场景，P4-03 仍未完成。


### arm64 包 1000 条会话重建期间 RSS 采样（2026-10-28）

在新建隔离副本 `/tmp/spaceassistant-p4-validation/copies/maintenance-rss-20261028` 中使用 arm64 应用目录包 build ID `e4aca912-a3e7-4d0b-8d43-2cb820057f02`（`app.asar` SHA-256 `3330eda77d36f8c8b82e15bafa55ea4e25daa0e1b942bf3f81db70a13f48bb82`），夹具为 1000 条 canonical-backed-only 消息。只删除该会话的 projection blob references、cache 与 state 行；canonical 消息、History、source locator 保留。运行后投影状态为 `valid`、`attempts=0`，body source 为 `complete`。

主进程日志记录两段 slice：57.81 ms `checkpointed` 与 481.11 ms `published`，合计 538.92 ms；两条完成时间相隔 482 ms。以 25 ms 间隔采集应用主进程及 3 个 Electron helper 的 RSS，重建状态期间得到 9 点：合计 RSS p50/p95/max 为 894.2/899.2/899.2 MiB；启动全过程 42 点最大合计 RSS 为 1039.4 MiB。RSS 按进程相加，会重复计算共享页，不能解释成物理内存占用。逐项汇总：[package-maintenance-rss-2026-10-28.json](package-maintenance-rss-2026-10-28.json)。

这补充了短时重建 slice 中的进程树 RSS 与完成状态，不是维护期间的设置点击或并发前台页请求，没有 Long Task/LoAF observer；因此不关闭 AC-5 的维护竞争或 AC-7。另一个同 profile startup page trace 为 cold，main handler 65.6 ms、renderer page request 316.2 ms、next-paint 1.2 ms，但日志没有 sessionId，该 trace 不归因到 1000 条目标会话，也不是可信切换数据。

### 用户确认解锁后的候选窗口重试（2026-10-28）

用户明确表示 Mac 已解锁。CUA 能读取应用清单，但桌面状态返回“Mac 已锁定”，没有可操作窗口。先从隔离真实库副本 `/tmp/spaceassistant-p4-validation/copies/pkg-candidate-schema102` 创建 APFS clone，确认副本中的飞书与微信均禁用；直接执行 app bundle 并设置临时 `HOME` 后没有候选进程或窗口，日志为空。

随后尝试通过 LaunchServices `open -na` 启动同一 app。进程命令行显示它实际使用默认目录 `/Users/space/Library/Application Support/spaceassistant`，临时 `HOME` 未生效。该进程存活约 13 秒后由本次验收终止。只读复核看到该数据库 schema 为 117、WAL 为 4,144,752 字节；此前记录的 schema 116 来自另一 userData 路径，不能作为此目录的启动前基线。schema v117 定义为新增两个可空的 locator 失败版本列。终止后只读计数为 35 条 source backfill `backfilling`、934 条 `complete`，没有终止标记。缺少本次启动前该目录的数据库快照，无法判断这些任务计数是否由本次启动改变；不据此宣称其余数据未变，也不擅自回滚。

后续直接以前台命令启动并设置同一临时 `HOME`，Electron 辅进程仍报告 `--user-data-dir=/Users/space/Library/Application Support/spaceassistant`。应用日志显示 `database.open-and-migrations` 与 renderer/window `ready-to-show` 完成，但启动恢复为 `degraded`，记录 2,302 项 `SESSION_LEDGER_REPAIR_PENDING`；这不是隔离样本，未做页面读取或会话操作。进程已终止。默认数据库主文件最后修改时间为 04:32:56，WAL 为 4,144,752 字节；只读 `PRAGMA quick_check(10)` 耗时 4.7 秒并返回 `ok`，schema 仍为 117，source-state 计数为 35 `backfilling` / 934 `complete`。无启动前快照，不能归因上述回填或 ledger 状态变化。本次之后不再启动该候选包。

CUA 仍未提供窗口，因此没有新的交互、性能或维护竞争样本。之后不再以原始应用 identity 启动该候选包；如继续做包级 API 检查，只使用另建唯一 identity 的隔离副本。P4-02/P4-03 与 AC-7 保持未完成；维护期间前台竞争及可信窗口内容 ready 仍需在可操作窗口中采集。

### 使用唯一应用名隔离的包内路由复测（2026-10-28）

静态检查和 Electron 官方文档确认，默认 `userData` 目录由 `appData` 与应用名组合；`app.getName()` 默认来自 app 内 `package.json` 的 `name`。因此从 v117 PKG 解出 app bundle 的临时副本，只把该副本 `app.asar` 中 `package.json:name` 改为 `spaceassistant-perf-isolated-20261028`，并将 profile COW 克隆到对应的唯一目录 `/Users/space/Library/Application Support/spaceassistant-perf-isolated-20261028`。没有改仓库源码或正式 PKG；临时副本的 `dist-electron/electron/main.js` SHA-256 与原 bundle 一致。Electron 的 `--user-data-dir` helper 参数确认指向该唯一目录。此前另验证过 macOS sandbox 对默认目录读写拒绝，但它使 Chromium 内部沙箱启动失败；成功的 API 复测在已核对的唯一 identity 路径下运行，未套外层 sandbox。默认库文件与 WAL 的时间戳保持 `2026-10-28 04:32:56`。路径计算依据：[Electron app 文档](https://www.electronjs.org/docs/latest/api/app)；原始结果：[package-ac5-routing-isolated-identity-2026-10-28.json](package-ac5-routing-isolated-identity-2026-10-28.json)。

候选代码通过 preload `window.api.chatGetMessagePage` 对同一隔离库的 88 条与 64 条会话执行 30 轮 A→B→A（90 次）和 40 次并发读取。按 SQLite canonical 消息 ID 验证，错会话页面 0、错误 0；renderer API 阶段耗时分别为 332.3 ms 与 78.6 ms。profile 当前有 34 条 `backfilling` 与 631 条 `complete` source 状态，因此这些结果只证明 API 的会话路由隔离；没有可信窗口点击、正文 ready、Long Task/LoAF 或维护竞争数据。它不等于原始签名/身份完全未改的 PKG 验收，也不关闭 AC-5 全项、AC-7 或 P4-02/P4-03。

### 原始 app identity 的 userData 隔离尝试（2026-10-28，未采信）

为验证原始 v117 PKG app bundle，曾直接启动解包目录中的 app，并传入 `--user-data-dir=/Users/space/Library/Application Support/spaceassistant-exact-pkg-synthetic3-20261028`。Electron helper 命令行确实带有该参数，隔离副本日志也指向该目录；但这不足以证明应用业务数据库连接使用了同一路径。运行前后默认库主文件时间由 04:32:56 变为 04:53:08，WAL 从此前记录的 4,144,752 字节变为 0；没有启动前快照，也无法排除同一时段的外部使用，故不把变化归因给本次运行，亦不宣称默认库未被触及。

发现后立即停止候选进程。只读复核默认库 schema 为 117，`PRAGMA quick_check(10)` 返回 `ok`；未执行写入、回滚或修复。该次 API 探针没有完成 canonical ID 对照，因此整次原始 identity 尝试不计作验收。后续只使用 `package.json:name` 与 helper userData 均核实唯一的 identity clone；helper 参数本身不能单独作为应用数据库隔离证明。结构化记录：[package-exact-identity-isolation-attempt-2026-10-28.json](package-exact-identity-isolation-attempt-2026-10-28.json)。


### 隔离 identity 包内 locator 回填期间的前台页面读取（2026-10-28）

从 v117 候选 app bundle 创建唯一 identity clone，只改 `package.json:name`；`dist-electron/electron/main.js` SHA-256 与候选相同，应用和数据库均落在 `/Users/space/Library/Application Support/spaceassistant-p4-maintenance-race-20261028`。夹具为 1000 条 canonical-backed-only 合成消息，飞书/微信关闭。删除该隔离会话的派生 locator/manifest/source-event 行并将 source 状态设为 `backfilling` 后启动候选；启动时默认界面先打开 8 条普通会话，随后对 1000 条目标会话发出一项 20 条页面请求。

请求开始时 locator 数为 0、状态为 `backfilling`。请求期间采样 312 次，观察到状态从 `backfilling` 到 `complete`、locator 从 0 到 1000。页面在 6,685.7 ms 后完整返回 20 条，所有 ID 均属于目标会话 canonical messages；错误数 0。source backfill 最终 `complete`，1000 条 locator 均发布。该结果补上 AC-5 的包内“source backfill 与一项前台页面读取重叠”子项；6.69 秒是该 API 等待耗时，不能当作 UI 主线程阻塞或设置点击延迟。它不是 projection-cache rebuild、正文首屏 ready、Long Task/LoAF、设置响应或维护峰值 RSS 测量。隔离 profile 的默认数据库仍维持本轮开始前所见 04:53:08，未启动原始 identity 包。完整机器记录：[package-ac5-backfill-concurrency-identity-clone-2026-10-28.json](package-ac5-backfill-concurrency-identity-clone-2026-10-28.json)。


同一 isolated identity clone 另做一次 20 路同时 cold-page 压力探针。日志统计到 17 次 main IPC 成功、3 次以 `PROJECTION_FOREGROUND_WORKER_QUEUE_FULL` 失败，错误约 7.25–7.58 ms。实现将等待队列限制为 16 个 pending job，另有 1 个 active worker；这组超额并发触发了既定上限。因 `Promise.all` 在首个拒绝时失败，本次未逐页验证其余成功结果的 canonical IDs，不把它计作功能通过或用户路径回归。原始汇总：[package-ac5-foreground-queue-saturation-2026-10-28.json](package-ac5-foreground-queue-saturation-2026-10-28.json)。


### 隔离 identity 包内 inline 投影缓存截断（2026-10-28）

从 v117 候选 app bundle 创建新的唯一 identity clone，仅改 `package.json:name`；主进程 bundle SHA-256 与候选一致。隔离库中 64 条 canonical-backed-only 会话原 projection 为 `valid`，将 `session_projection_cache.inline_payload` 从 137,073 字节截到 20 字节后，通过打包 preload API `window.api.chatGetMessagePage` 读取前 20 条。请求在 36.6 ms 返回，所有 ID 均匹配目标会话 canonical messages，错误数 0；复核时缓存被标记 `invalid` 且 inline payload 已清空。该包级探针验证损坏 inline 缓存不会泄漏旧/错正文；它不覆盖外部 projection blob 文件截断、发布边界故障、自动重建完成时间或 UI 内容 ready。原始记录：[package-ac6-inline-cache-truncation-identity-clone-2026-10-28.json](package-ac6-inline-cache-truncation-identity-clone-2026-10-28.json)。

### CUA 桌面状态复核（2026-10-28）

用户确认 Mac 已解锁后，桌面自动化仍无法连接：`cua.getState()` 返回 `apps: []`，并报告 “The Mac is locked”；按应用名及绝对路径调用 `cua.getApp` 得到相同错误。没有启动应用，也没有访问默认用户目录。该结果记录的是 CUA 状态，不代表用户所见的实际锁屏状态；窗口点击、内容 ready 与 Long Task/LoAF 验收仍无新样本。

### 候选包与当前运行时代码一致性核对（2026-10-28）

当前候选 PKG 记录为源码提交 `6a77e087`。核对 `6a77e087..HEAD` 的 `electron/`、`src/`、`packages/` 差异，唯一已提交文件是 `electron/sessionStorage/infrastructure/sqlite/sessionBodySourceBackfill.test.ts`；本轮未提交的改动也只有 `sessionProjectionBlobStore.test.ts`。因此候选包包含当前 HEAD 的全部运行时代码，不需要为本轮测试补充重新打包；该代码一致性核对不补足缺失的界面和维护竞争验收。


### arm64 PKG identity clone 的热缓存切换补测（2026-10-28）

从 arm64 PKG payload 建立唯一 identity clone（build ID `94e4242e-24d6-4374-b8f4-405c5f8d71f5`，PKG SHA-256 `6594ee801e4eddc23ace759164feb2c32ae5af0b5b35403bf3382820353188b8`），在隔离 userData `/Users/space/Library/Application Support/sap4readyhot28` 中对 8 条和 1000 条 canonical 合成会话交替操作。应用只使用已验证的热投影缓存；60 条 main、renderer page-request 与 next-paint trace 完整配对，60/60 `cachePath=ready` 且成功。

| 合成会话规模 | 样本 | Main handler p50/p95/max | Renderer page request p50/p95/max | Next-paint p50/p95/max |
| --- | ---: | ---: | ---: | ---: |
| 8 条 | 30 | 1.14 / 1.31 / 1.33 ms | 2.4 / 3.5 / 3.7 ms | 7.5 / 16.1 / 16.2 ms |
| 1000 条 | 30 | 9.83 / 11.63 / 12.41 ms | 10.8 / 12.8 / 13.3 ms | 7.0 / 15.3 / 15.3 ms |

热缓存采样窗口没有 Long Task/LoAF observer 记录，也没有 projection build slice。普通 8 条 fixture 每次 ledger gate 都是 `blocked / ledger_missing`，大历史 fixture 为 `ready`；因此本轮只说明 ready cache 路径延迟，不能证明普通会话处于健康完整投影状态。CUA 在一条大历史 trace 的首个 AX 读取中报告了上一会话尾标记；其对应应用 trace 成功，但当时没有逐次等待核验。随后另做 10 次逐次点击并等到首个 AX 读取，目标标记 10/10 首次可见、无相反会话标记。保留该首轮 AX 异常作为测量限制。CUA click-to-AX 用时包含自动化等待，不作为用户延迟。

identity clone 改过 `app.asar` 中的 package name 并 ad-hoc 重签；没有与同一数据副本上的基线包对照。本数据不关闭 P4-02、P4-03 或 AC-7。机器可读逐条 trace 与限制：[package-hot-cache-switch-identity-clone-2026-10-28.json](package-hot-cache-switch-identity-clone-2026-10-28.json)。本轮结束后隔离 clone 与默认应用均已退出。


### arm64 PKG identity clone 的损坏投影缓存回退单样本（2026-10-28）

在同一隔离 profile 中先确认 1000 条合成会话的 projection state 为 `valid`，再仅将 `session_projection_cache.inline_payload` 从 211,541 字节改成 1 字节非法 JSON；canonical/History 正文源未改。PKG 启动首读走 `cachePath=cold`，worker 从源读取 20 条页面并成功返回；main handler 66.41 ms、worker read 53 ms、renderer page request 356.3 ms、next-paint 0.8 ms。窗口显示到 `assistant 999`，projection 两段 slice 为 112.28/524.68 ms，数据库随后恢复为 `valid` 且 payload 长度回到 211,541 字节。

这是启动首读的 n=1 回退观察，不是切换延迟分位数。启动/首读期间 observer 同时记录 290 ms Long Task 与 295.5 ms LoAF，以及更早的 88 ms Long Task/90.8 ms LoAF；无脚本归因，时间重叠不能证明缓存回退触发了它们。逐条记录：[package-damaged-cache-fallback-identity-clone-2026-10-28.json](package-damaged-cache-fallback-identity-clone-2026-10-28.json)。后续已补充 30 次实际界面切换的损坏缓存样本，见下方矩阵；该启动样本仍不并入切换分位数，也不替代真实历史同库对照。


### arm64 PKG identity clone 的损坏缓存切换矩阵（2026-10-28）

在包保持运行、隔离 profile 指向 1000 条 synthetic canonical-backed-only 会话时，循环执行“确认 8 条普通会话 → 只把 1000 条会话的 `inline_payload` 改为 1 字节非法 JSON → 点击 1000 条会话 → 核对正文 → 等待 projection 回到 `valid`/211,541 字节，再开始下一轮”。canonical/History 源未改。共 30 次有效的大历史切换，30/30 main 与 renderer trace 均成功，30/30 `cachePath=cold`，首份 AX 状态 30/30 显示目标 `assistant 999` 尾部；每轮都观察到投影发布，才进行下一轮。

| 指标 | p50 | p95 | max |
| --- | ---: | ---: | ---: |
| Main handler | 32.43 ms | 38.23 ms | 38.40 ms |
| Renderer page request | 33.60 ms | 39.20 ms | 39.30 ms |
| Renderer next-paint | 8.90 ms | 12.40 ms | 15.00 ms |
| Checkpointed projection slice | 55.40 ms | 82.20 ms | 82.21 ms |
| Published projection slice | 119.43 ms | 122.95 ms | 123.38 ms |

从 main trace 时间戳到 `published` 事件的间隔 p50/p95/max 为 598/622/624 ms；这不是从修改缓存开始计算的完整维护耗时。30 次切换与发布区间没有 Long Task/LoAF observer 记录。普通 8 条会话的 gate 记录仍有 `ledger_missing`，所以这仅是受控合成数据中的损坏缓存回退结果，不代表完整健康 ledger。percentile 使用 nearest-rank。隔离包身份、每条 trace、每轮投影恢复与限制：[package-damaged-cache-switch-matrix-identity-clone-2026-10-28.json](package-damaged-cache-switch-matrix-identity-clone-2026-10-28.json)。

该 n=30 样本补齐损坏 inline cache 的一个包内矩阵格，但它仍是 identity clone 与 synthetic data，没有同库基线，也没有维护开/关矩阵；P4-02/P4-03/AC-7 继续未完成。前述启动首读的 n=1 样本保留为启动诊断，不并入本次切换统计。


### arm64 PKG 热缓存维护空闲对照（2026-10-28）

使用 build ID `94e4242e-24d6-4374-b8f4-405c5f8d71f5` 的 arm64 PKG payload identity clone，在隔离 userData `/Users/space/Library/Application Support/sap4readyhot28` 中，交替切换 8 条与 64 条 synthetic canonical-backed-only 会话 30 轮。每次切换后核对完整 assistant 尾标记；60/60 正确。包内 main 与 renderer 日志提供 60 组完整 trace，均成功且 `cachePath=ready`。

| 会话规模 | 样本 | Main handler p50/p95/max | Renderer page request p50/p95/max | Next-paint p50/p95/max |
| --- | ---: | ---: | ---: | ---: |
| 8 条 | 30 | 1.18 / 1.29 / 1.39 ms | 2.8 / 3.6 / 3.7 ms | 10.3 / 16.3 / 16.3 ms |
| 64 条 | 30 | 5.30 / 6.58 / 6.78 ms | 6.30 / 7.50 / 7.70 ms | 7.30 / 14.40 / 15.70 ms |

采样期间没有 `session.projection.build.slice` 或 Long Task/LoAF 事件；结束后 `quick_check=ok`，3 条 source 状态均为 `complete`，3 条 projection 状态均为 `valid`。这只是“没有人为触发维护任务”的 idle cell，并未通过生产接口暂停生命周期任务，也不等价于维护开/关矩阵。普通会话的 ledger gate 仍为 `ledger_missing`（60 次），故不是健康完整 ledger 验收。identity clone 经改名并 ad-hoc 重签，没有同库基线；AX 自动化耗时不计入交互指标。该样本不关闭 AC-7、P4-02 或 P4-03。逐条日志提取及限制：[package-hot-cache-maintenance-idle-switch-identity-clone-2026-10-28.json](package-hot-cache-maintenance-idle-switch-identity-clone-2026-10-28.json)。测试结束后隔离应用已退出，默认应用未运行。


### arm64 PKG 热缓存在投影重建期间的切换（2026-10-28）

在同一 arm64 PKG identity clone、userData、数据库和 64 条目标会话上，对照上面的 idle cell，额外让另一条 1000 条合成会话反复触发投影缓存重建。46 轮只把该维护会话的派生 `inline_payload` 暂时改成 1 字节非法 JSON；每轮最终均恢复为 211,541 字节、状态 `valid`。消息表、History 事件与正文来源事件表相对事前 SQLite 在线备份的行数及哈希完全一致，source 状态仍为 3/3 `complete`。

共记录 46 个投影重建窗口；应用日志有 43 次 cold fallback 和 43 次 ready 页面读取，其中 34 次 ready 页面读取与 checkpointed→published 构建窗口重叠，9 次没有重叠；另有 3 轮 UI 操作没有匹配到预期 cold/ready trace 对，未纳入有效样本。34 个有效重叠请求全部成功。采样窗口没有 Long Task/LoAF observer 事件；没有测量维护期间的进程树 RSS。

| 64 条目标会话条件 | 有效重叠样本 | Main handler p50/p95/max | Renderer page request p50/p95/max | Next-paint p50/p95/max |
| --- | ---: | ---: | ---: | ---: |
| 无人为触发维护（idle） | 30 | 5.30 / 6.58 / 6.78 ms | 6.30 / 7.50 / 7.70 ms | 7.30 / 14.40 / 15.70 ms |
| 另一会话投影重建中 | 34 | 4.82 / 6.57 / 6.66 ms | 5.80 / 7.80 / 7.80 ms | 6.40 / 15.20 / 15.40 ms |

两个 cell 来自同一数据库副本和同一目标夹具。该 synthetic identity-clone 样本没有显示热页面读取随投影重建明显变慢；它不证明真实历史、source locator backfill、其他维护任务或整体内存表现。AX 树在并发场景保留了先前虚拟滚动位置，因此本项只按 in-app trace 计算时延，不据此声明尾部正文已逐次核验。普通会话仍有 `ledger_missing`，且没有同库基线二进制，所以不关闭 AC-7/P4-02。逐条 trace、build slice 配对、源表哈希和限制：[package-maintenance-overlap-switch-identity-clone-2026-10-28.json](package-maintenance-overlap-switch-identity-clone-2026-10-28.json)。


### arm64 PKG 投影重建期间进程树 RSS 同窗对照（2026-10-28）

在同一个已运行的 arm64 PKG identity clone、数据库副本、64 条目标会话及四个 Electron 进程上，先做 24 轮 64↔1000 条会话往返切换的空闲对照，再重复相同 24 轮并对 1000 条维护会话的派生 `inline_payload` 做 8 次一字节损坏。每次都观察到缓存进入无效态并恢复为 `valid`、211,541 字节；从损坏到恢复的墙钟时间 p50/p95/max 为 2.91/5.77/5.77 秒。只改派生缓存，消息、History、正文来源事件及 source state 四张表的行数和 SHA-256 均与事前在线备份一致；结束后 `quick_check=ok`，3/3 source complete、projection valid。

RSS 以 macOS `ps` 对应用主进程及递归子进程求和，每约 120 ms 采样。两组各取相同 27.97 秒窗口；活动组覆盖 8 次损坏与恢复周期，空闲组是同样 UI 往返切换在没有人为损坏时的对应窗口。RSS 的 p50/p95/max 分别为维护组 975.42/979.47/979.92 MiB、空闲组 968.92/977.91/977.95 MiB；两组 p95 差 1.56 MiB，最大值差 1.97 MiB。此处是各进程 RSS 直接相加，可能重复计算共享页，不等同唯一物理内存。

这个受控 synthetic cell 未显示维护组 RSS 高于同窗空闲对照的明显增量，但不能外推为真实历史或其他维护工作的内存验收。应用窗口切换总时长约 38 秒，维护损坏/恢复区间为 27.97 秒；没有逐点击时间戳、CPU profile 或唯一物理内存采样，也没有覆盖 source locator backfill、冷启动或维护种类矩阵。普通 fixture 仍有 `ledger_missing`，故不关闭 AC-7/P4-02。完整采样点、恢复时间、进程 PID 和源表哈希：[package-maintenance-process-rss-matched-switch-identity-clone-2026-10-28.json](package-maintenance-process-rss-matched-switch-identity-clone-2026-10-28.json)。


### arm64 PKG 外部 projection blob 截断后的冷读回退（2026-10-28）

在隔离 identity clone 的副本库中，由 session-storage 生产 worker 建立一条 312,535 字节的 canonical-backed-only 合成消息；projection payload 为 313,274 字节，落在外部 blob，而非 SQLite inline cache。每轮只把派生 projection blob 截断到 156,637 字节，不修改 cache metadata、canonical message、History event 或 source 表。三次截断后均退出应用，再重新启动包并选择该会话；三次 main trace 均先记录 prepared `body-read` 校验失败，随后 source-page fallback 成功，页面返回 1 条消息。Main handler 用时为 58.79/57.89/58.97 ms；三次窗口截图都能看到正文唯一尾标记 `P4_EXTERNAL_PROJECTION_BLOB_TAIL_OK`。每次投影都重新发布至新 locator，文件恢复为 313,274 字节且 SHA-256 与原 payload digest 一致；最终 `quick_check=ok`、source/projection 均为 4/4 complete/valid。消息、History、正文来源事件及 source state 四表的行数与哈希在三次损坏/恢复前后保持一致。

同一进程在页面已加载后切出再切回时，会显示此前已加载的正文，但屏幕上对应的 blob 文件仍是截断状态；该热进程行为不作为磁盘完整性检测或恢复样本。三次 cold-process recovery 是 AC-6 外部 projection blob 截断的包级正向样本（n=3），仍不覆盖外部 History source spill 损坏、发布边界故障、其他源编辑/追加/删除、真实历史或基线包，也不能关闭 P4-02/P4-03/AC-7。完整 main/renderer trace、损坏 locator、源表哈希和边界：[package-ac6-external-projection-blob-truncation-identity-clone-2026-10-28.json](package-ac6-external-projection-blob-truncation-identity-clone-2026-10-28.json)。

### arm64 PKG 预热后追加 canonical source 的包内 API 读取（2026-10-28）

在独立 userData 的 arm64 PKG identity clone 中，先准备并读取 300,050 字节 synthetic canonical-backed-only 正文，再经生产 `prepareTurnAtomically`、`SqliteAgentHistory.appendBatch` 的 `session-input-committed` / `model-response-committed` / `invocation-completed` 事件以及 finalized update 追加一条 user 和一条 assistant 消息。保持包进程运行时，包内 `window.api.chatGetMessagePage({ sessionId, limit: 10 })` 返回三条消息，旧正文尾标记、新 user 内容及 assistant 回复均完整匹配。追加后 source 为 `complete`（revision 22），projection 为 `valid`（message revision 9，3 个正文 locator），数据库 `quick_check=ok`。一次后续 ready API 调用为 2.3 ms；这不是冷读、UI-ready 或 p95 指标。

包冷启动后，初始窗口尚未呈现目标内容；显式点选目标行后，AX 树与截图均显示 300 KiB 正文尾标记、新 user 消息和 assistant 回复，故本夹具的包内 UI 内容可见性计为通过。该 harness 经生产 History writer 写入 database/history records，但没有模拟 provider/renderer 实际生成的完整 turn-display 事件链；不据此声称完整生产回合验收或 UI-ready 延迟已通过。样本 n=1，仅补充“准备后 source append 的包内 API 回读及 synthetic UI 内容可见性”；不覆盖普通 edit/delete、History source spill 损坏、发布边界、真实历史或基线比较，也不关闭 AC-6/P4-02/P4-03。隔离身份、包哈希、fixture、API 结果及限制：[package-ac6-canonical-source-append-after-prepared-cache-identity-clone-2026-10-28.json](package-ac6-canonical-source-append-after-prepared-cache-identity-clone-2026-10-28.json)。

### arm64 PKG 准备后发生 transcript compaction 的源失效回退（2026-10-28）

在唯一 identity clone 的全新隔离 userData 中，先用生产 History writer 建立 canonical-backed-only 合成消息，完成 source backfill 并读到 `cachePath=ready` 的旧正文。保持 PKG 进程运行，由生产 `SqliteAgentHistory.appendBatch` 写入 `transcript-compacted` 快照，将同一 message ID 的正文从 `P4_AC6_BODY_BEFORE_COMPACTION` 替换为 `P4_AC6_BODY_AFTER_COMPACTION`。随后包内 preload 页面 API 返回新正文；main trace 走 `cachePath=cold`，source-page-read 及 final-source-check 均成功，总计 119.79 ms。界面切出再切回后也显示新正文，投影重建为 valid；最终 `quick_check=ok`、source `complete`、projection `valid`，History 水位指向新的 compaction event。

夹具初次启动时 source 状态仍为 pending，产生的一条错误读取不计样本；完成 source backfill 并确认旧正文可见后才开始计数。样本 n=1、ledger gate 为 `ledger_missing`，是合成 identity clone，不是健康真实历史或同源基线；仅覆盖 compaction 替换后的缓存失效和 canonical 回读，不覆盖普通 source edit、追加、删除、外部 History spill 损坏或发布边界。窗口与数据库终态、包身份、逐条 trace：[package-ac6-compaction-invalidates-prepared-cache-identity-clone-2026-10-28.json](package-ac6-compaction-invalidates-prepared-cache-identity-clone-2026-10-28.json)。

### arm64 PKG 准备后编辑 canonical 正文并重建投影（2026-10-28）

新增回归先复现旧行为：prepared chatBody cache 原为 `valid`，canonical-backed-dual-write 用户消息正文编辑后，source 重建因 immutable 旧 History snapshot 与当前双写镜像不同而报 `CHAT_BODY_AUTHORITY_MISMATCH`。源码修复在同一 History 写事务内将实际变更的消息转为 canonical-only，避免再用当前镜像校验该消息的旧正文版本；正文继续由 canonical History 提供。

更新后的 arm64 PKG SHA-256 为 `1d455c60ecdb329cf89c2b927073cd6a1df0a4f45a6c4f5ca1a7723f699e2f04`，build ID `6d5910fe-7b9c-4ccf-bc28-c49e02e212cb`，app.asar SHA-256 为 `47fce209bce1c43b7e472e38fc5662e053f770187d09f4ca2336d44e82f2bf97`。PKG payload app bundle 使用唯一 bundle ID、ad-hoc 重签，并以 `SPACEASSISTANT_DEV=1` 和明确的 `SPACEASSISTANT_DEV_USER_DATA_DIR` 指向隔离 profile；未安装 PKG。隔离库内的编译 writer 模块 SHA-256 与 PKG app.asar 中同路径文件相同，Node harness 通过该 writer 完成编辑。重启 PKG payload 后，session source 为 `complete`（revision 28），chatBody projection 为 `valid`（message revision 11），`quick_check=ok`；AX 树显示新正文 `P4_AC6_PACKAGED_CANONICAL_EDIT_REPAIR` 和原 assistant 回复。

该包级样本 n=1；正文编辑由 hash-matched writer harness 调用，没有经打包 renderer IPC 触发，运行环境也使用开发隔离标记；不覆盖 UI/IPC 编辑、删除、History source spill 损坏、发布边界、真实历史或同源基线，因此不关闭 AC-6/P4-02/P4-03/AC-7。测试、事件与运行身份：[package-ac6-canonical-source-edit-after-prepared-cache-identity-clone-2026-10-28.json](package-ac6-canonical-source-edit-after-prepared-cache-identity-clone-2026-10-28.json)。

### arm64 PKG 准备后删除会话的隔离库清理核验（2026-10-28）

在另一个隔离 userData clone 中，对已有 prepared projection 的 synthetic session `cd0a726e-ff59-4b2c-821c-d319bff2378e` 展示并取消了产品 UI 的不可逆删除确认；随后通过与 app.asar 内容匹配的编译 `database/operations.js` 调用生产 `deleteSession` 命令，仅删除该隔离库中的目标会话。删除后 session 行、messages、`session_projection_state`、`session_projection_cache`、`session_body_source_state` 均为 0，SQLite `quick_check=ok`。包 payload 重启后，AX 列表中同名近似项为另一条 synthetic fixture（ID `b5ea0a4c-8d8d-4f33-810c-94e112f68158`）；目标 ID 仍不存在于数据库，因此不把该独立 fixture 误报为已删除目标复活。

该样本 n=1；未确认 UI 删除对话框，删除不是通过打包 renderer IPC 执行，且使用开发隔离标记、未安装 PKG。它只验证 hash-matched 生产删除命令后的隔离库清理和冷启动状态，不证明产品 UI/IPC 删除路径，不覆盖 History source spill 损坏、发布边界、真实历史或同源基线，因此不关闭 AC-6/P4-02/P4-03/AC-7。证据：[package-ac6-session-delete-after-prepared-cache-identity-clone-2026-10-28.json](package-ac6-session-delete-after-prepared-cache-identity-clone-2026-10-28.json)。

### 冷启动派生 spill 索引重建期间的会话读取（2026-10-28）

TDD 回归先在派生索引状态为 `running`、选中 canonical History 正文含 source spill descriptor 的 fixture 上复现旧行为：`readProjectionPageSourceSpills` 抛出 `PROJECTION_SOURCE_SPILL_INDEX_UNAVAILABLE`。修复后，读取路径继续校验所选 History 事件及 source digest，并直接从 canonical payload 解析 spill；只有索引状态完整且 generation 相等时才要求索引与正文完全一致。重建中的索引可缺项，但已有索引项仍必须是正文中的合法 descriptor。reader 与 page fallback 定向测试 2 文件 6 项通过，主进程增量构建及 spill/session-storage 边界门禁通过。

随后从 arm64 PKG 展开内容启动唯一 bundle identity 的隔离副本，profile 起始时把 `agent_history_events` spill index 标记为 `running`。冷启动后选中的 “P4 valid ordinary 8 messages” 在 AX 树中显示完整 user/assistant 正文；隔离 DB 的索引最终为 `complete`、verified generation 39，`quick_check=ok`。该 UI 样本未捕获所选页读取与索引完成的精确先后，因此时序保证依赖上面的确定性源码回归。PKG SHA-256 为 `01a4b403981af90db2aaf26ffb5702f542b03873117521222970e65b851b55cf`，app.asar SHA-256 为 `b42c8911972f4ef0885b15aa85804cc0a6743e6922976264b1357ceb7918a7e0`，build ID `408f22f7-d4ea-4aa0-b09e-ea5ef05407d8`。PKG 由展开 payload 运行、未安装；样本 n=1，不关闭 P4-02/P4-03/AC-7。完整身份与限制：[package-startup-pending-spill-index-identity-clone-2026-10-28.json](package-startup-pending-spill-index-identity-clone-2026-10-28.json)。

### arm64 PKG UI 删除 prepared canonical-backed 会话（2026-10-28）

从已验证 `quick_check=ok` 的 append fixture profile 创建新的 APFS copy-on-write 副本。删除前目标会话有 3 条消息，projection cache 为 `valid` 且有 1 条缓存记录，body source 为 `complete`。在 arm64 候选包 identity clone 中打开目标会话，确认正文尾标记和新增 assistant 回复可见；随后通过会话行的删除按钮打开显示目标会话名称及不可恢复提示的确认框，并在隔离副本上确认。界面出现“已删除”提示、目标行消失并进入空会话状态。SQLite 查询确认目标 session、messages、projection state/cache、body source state 和 projection blob references 均为 0，`quick_check=ok`。检查使用 `PRAGMA query_only=ON`，未执行数据库写入。

该样本 n=1，使用开发隔离变量和唯一 ad-hoc 签名 identity clone，未安装 PKG；验证了打包 renderer UI/IPC 删除路径与即时数据库清理，但本次未冷重启验证目标不会复活，也未注入发布边界故障。它补齐此前仅使用生产删除命令 harness 的 UI 缺口，不覆盖真实历史或 AC-6 全矩阵，不关闭 P4-02/P4-03/AC-7。隔离路径、包哈希、初始状态和终态：[package-ac6-session-delete-ui-identity-clone-2026-10-28.json](package-ac6-session-delete-ui-identity-clone-2026-10-28.json)。

### arm64 PKG source module 对截断 History spill 的拒绝（2026-10-28）

在未损坏的隔离 profile 中，当前 arm64 PKG app.asar 的 `readChatPageAfterPreparation` 经 Electron `ELECTRON_RUN_AS_NODE` 读取 append fixture，返回 3 条消息，其中 300,046 字节正文及尾标记完整。将 profile 做 APFS clone 后，只把该消息 descriptor 指向的 spill 文件从 300,046 字节截为 150,023 字节；对同一 app.asar 导出的公开分页 reader 调用后，读取明确拒绝并返回 `CANONICAL_SESSION_CONTENT_UNAVAILABLE`，没有把部分正文或空 SQLite 镜像作为成功页。隔离数据库 quick_check 为 ok，source 状态仍为 complete，projection 标为 invalid。

该样本 n=1；使用本次 arm64 PKG 的 Electron binary 与 app.asar 编译模块及生产存储 API，但未经过包内 renderer IPC/UI，未安装 PKG。只覆盖单个 History source spill 截断，不覆盖删除、同长度摘要篡改、非法/不存在 locator、发布边界、真实历史或同源基线；因此仅补充当前 package payload 的 source-reader 模块证据，不关闭 AC-6 完整包内故障矩阵、P4-02/P4-03 或 AC-7。对照、包哈希与隔离状态：[package-ac6-source-spill-truncation-identity-clone-2026-10-28.json](package-ac6-source-spill-truncation-identity-clone-2026-10-28.json)。

同一故障已在修复版 arm64 PKG payload 的唯一 bundle identity clone 中复测。先选中健康的 8 条普通会话，再切换到 spill 截断的 300 KiB 目标会话；AX 树和截图确认旧会话正文已清空，中央区域显示本地化错误说明和“重试”按钮。点击重试后读取再次失败，错误页仍在，未恢复旧正文。该次候选包 build ID 为 `3c6f7485-021a-43e3-b12f-eb9b793acf17`；PKG SHA-256 为 `223aa70894ac69b0394c87c5c44e611e52663642aa38b6dc4688ca9b9d5d58b1`，app.asar SHA-256 为 `402e435bff1170161425b0822d7efcab8a908002ee9afce79d7f7ace54c22615`。PKG 未安装，helper 参数确认指向隔离 profile。修复前后的 TDD 定向测试共 23 项通过，renderer 类型检查、i18n 校验与 renderer build 通过；测试覆盖加载中清空旧页与成功后显示新会话。手工 UI 样本 n=1；未保存截图文件，加载瞬态由单测而非本次 UI 样本验证。完整身份、观察和限制：[package-ac6-switch-read-failure-renderer-fix-identity-clone-2026-10-28.json](package-ac6-switch-read-failure-renderer-fix-identity-clone-2026-10-28.json)。

### arm64 PKG 对真实历史会话的 8 次 UI 往返（2026-10-28）

使用当前 arm64 PKG 的唯一 bundle identity clone 与真实历史 profile 的 COW 数据库副本；helper 参数确认业务 userData 指向 `/Users/space/Library/Application Support/sap4perfhealthy28b`，来源 profile 未交给应用打开。两条目标会话分别有 64/8 条消息、2590/343 条 History event，source 均为 `complete`、ledger 均为 `ready`。原 profile 与运行副本中，这两条会话的 message、History event、body locator 和 source-event 行数与 SHA-256 均匹配；两份数据库 `quick_check` 均为 `ok`。应用退出后，没有残留的该 identity clone 进程。

通过原生 UI 搜索并选择会话行，交替切换大/普通会话 8 次；8/8 对应 main trace 与 renderer 请求 trace 成功，页大小按 8/20 条交替（首次小会话读 8 条）。本次构建 ID `6113fa88-2c21-41cf-b805-c0fb19115b2f`，PKG SHA-256 `6a5a07831f591017bbfe09325298abe427d3affb68275d87ae3a707902962928`，app.asar SHA-256 `5f09ef1980216bdad29e2d93ae1f992b74899aa1c9e87696cb7463edcf91a31a`。8 次均为 `cachePath=cold`；main handler p50/p95/max 为 5.84/11.60/11.60 ms，renderer page request 为 14.70/19.20/19.20 ms，next-paint 为 5.40/7.10/7.10 ms。切换时间窗内未记录 renderer Long Task；该窗口短于 event-loop watchdog 汇报周期，不能据此排除主进程长任务。

切换窗口内另有一条 ledger baseline-ready 记录耗时 1037 ms，但没有 session ID，无法归属到具体一次切换，也不计入页面读取延迟。8 次切换的每次目标正文尾标记未逐一核对；未做同库基线包对照、ready-cache 矩阵、维护竞争、维护开关或内存峰值测量。身份、逐项耗时、表行摘要及限制：[package-real-history-ui-switch-eight-identity-clone-2026-10-28.json](package-real-history-ui-switch-eight-identity-clone-2026-10-28.json)。此样本补充真实历史候选包的冷路径 UI trace，不关闭 P4-02、P4-03 或 AC-7。

后续复开该隔离 profile 时，应用启动报告 `degraded`、142 项 History repair failure；UI 默认选中的“第 1 件：压缩摘要”显示缺失 `sessions/.../events.jsonl` 的 `ENOENT`。本次未执行切换，进程已退出；该记录属于排除诊断。由此确认该 profile 整体不满足“健康真实历史”验收条件，即使前述两条目标会话在查询时分别显示 source `complete`、ledger `ready`。因此前述 8 次延迟仍只作局部候选路径观测，不得用作健康库 AC-7 样本，也不能声称其逐次展示了完整目标正文。诊断身份及限制：[package-real-history-profile-reopen-diagnostic-identity-clone-2026-10-28.json](package-real-history-profile-reopen-diagnostic-identity-clone-2026-10-28.json)。

### arm64 候选包健康 canonical 投影缓存的窗口热切换（2026-10-28）

为避免冻结真实库的缺失 History 文件污染正文核验，本次从既有 synthetic canonical profile 创建新的 APFS copy-on-write userData 克隆，并把 `config.workDir` 与 `config.workDirProfiles` 改到克隆内部；飞书和微信保持关闭。候选 app.asar SHA-256 为 `5f9f61648636b33dd5e8520eab94778cb062962cdea63b6be98b5da71c0eb2a5`，trace build ID 为 `21b8262e-43d1-4830-a050-61cc437df56a`。目标为 64 条大会话和 8 条普通会话；两者运行前后 source 均 `complete`、projection 均 `valid`、attempts 均为 0，SQLite `quick_check=ok`。隔离数据库 SHA-256 为 `b84b73ea690540cb9d91d04a0105e324f29ed4afc2665c6c80c7faf9154b867a`。

用 CUA 对会话列表执行 30 轮普通/大历史交替点击，每次都在 AX 树中核对目标正文尾标记。60/60 正文标记正确；应用日志 ordinal 5–64 与动作顺序一致，main trace 60/60 为 `cachePath=ready`、`outcome=ok`，renderer 180 条 trace 覆盖 60 个请求的六个阶段。普通 8 条页 main handler / renderer page request / next-paint p50、p95、max 分别为 1.32/1.62/1.64 ms、2.8/3.7/4.2 ms、5.7/6.9/7.3 ms；64 条目标的 20 条分页分别为 5.98/7.92/8.13 ms、7.6/10.4/10.4 ms、7.8/13.5/13.8 ms。按六个 renderer trace 阶段求和的 p95 为 17.2/31.8 ms。该 39 秒测量窗口内没有 `renderer.long-task` 或 projection build slice 记录。逐条数据、trace 与哈希：[package-ready-canonical-ui-switch-identity-clone-2026-10-28.json](package-ready-canonical-ui-switch-identity-clone-2026-10-28.json)。

这是候选 app bundle 的合成热缓存子格，未安装 PKG，也没有同库基线；两个会话的 ledger gate 都是 `blocked:ledger_missing`。因此它只证明已准备 canonical 投影缓存下窗口正文切换成功，不代表健康 ledger 的真实历史，也不能单独关闭 AC-7/P4-02/P4-03。CUA 点击到 AX 返回的墙钟时间包含自动化和 AX 传输，不作为用户可感知延迟；未在此轮诱发缓存损坏或维护竞争。

### 当前工作树 arm64 PKG 的 canonical ready 窗口热切换（2026-10-28）

在当前工作树 `58e3255c17ffba30244f4e9fef4b765b9627ebf4` 上运行完整 `npm run build`，再用 `npx electron-builder --mac pkg --arm64` 生成 arm64 PKG。完整构建及 31 个 session-storage 边界非法边探针通过。包 build ID `469f0d38-bc7a-4c9c-84d0-6254659cb123`、PKG SHA-256 `de8e96cec77757701d6adaf98991162fb8ffd275f0d7c7921402ce1b34fbb672`、app.asar SHA-256 `5f9f61648636b33dd5e8520eab94778cb062962cdea63b6be98b5da71c0eb2a5`。构建身份记录 `sourceTreeClean=false`；本次运行的是由该 PKG 构建步骤输出的 arm64 app bundle，未安装 PKG。

从既有 synthetic canonical profile 再创建隔离 COW userData，并把工作目录重定向到该克隆内部。对 8 条普通会话与 64 条大历史会话交替执行 30 轮 CUA 列表点击；60/60 次 AX 正文尾标记正确，app 内 main trace 60/60 `cachePath=ready` 且 `outcome=ok`，renderer trace 180 条、每次请求六个阶段完整。普通 8 条页 main handler / renderer page request / next-paint 的 p50/p95/max 为 1.43/1.73/1.74 ms、3.0/4.4/4.6 ms、5.8/11.4/11.7 ms；64 条目标的 20 条分页分别为 5.73/6.76/7.52 ms、7.3/8.1/9.0 ms、8.0/11.7/12.8 ms。六阶段 renderer 求和 p95 为 23.5/29.2 ms；采样窗口没有 renderer Long Task/LoAF 或 projection build slice。

目标 source 为 `complete`、projection 为 `valid` 且 attempts 为 0，克隆数据库 `quick_check=ok`；ledger gate 仍为 `blocked:ledger_missing`。因此此项只复核当前工作树构建包在 synthetic ready-cache 窗口下的正文切换，不是健康真实历史或基线对照；不关闭 AC-7/P4-02/P4-03。完整逐次 trace、PKG 与数据库身份：[package-current-branch-ready-canonical-ui-switch-identity-clone-2026-10-28.json](package-current-branch-ready-canonical-ui-switch-identity-clone-2026-10-28.json)。

### 当前分支 arm64 候选包真实历史冷路径切换（2026-10-28）

从既有已验证 profile 再建立 APFS COW userData 副本，运行当前工作树构建 PKG 所输出的 arm64 app bundle（未安装 PKG）。构建身份为 commit `58e3255c17ffba30244f4e9fef4b765b9627ebf4`、build ID `469f0d38-bc7a-4c9c-84d0-6254659cb123`；PKG/app.asar SHA-256 为 `de8e96cec77757701d6adaf98991162fb8ffd275f0d7c7921402ce1b34fbb672` / `5f9f61648636b33dd5e8520eab94778cb062962cdea63b6be98b5da71c0eb2a5`。运行时 lsof 确认只打开 COW 克隆数据库；飞书、微信关闭，未发送 IM 消息。运行后克隆 DB `quick_check=ok`，SHA-256 `034b5702f30aaf577fa6ac91b72e5fcf90456a6e7f0e2710b0acbb3083292665`；目标会话 source 保持 `complete`、ledger `ready`：大会话 64 条消息/2590 个 History 事件，普通会话 8 条/343 个事件。

CUA 在开始时解析目标行索引，随后交替点击 20 次（每组 10 次），中途不取 AX 树；结束时 AX 未出现内容不可用错误，但没有逐次比对每个目标的最后消息标记。main/renderer trace 20/20 匹配且成功，全部 `cachePath=cold`。大会话 main handler / renderer page request / next-paint 的 p50/p95/max 为 4.53/4.77/4.77 ms、16.7/18.9/18.9 ms、3.2/3.4/3.4 ms，六阶段 renderer 总和为 42.5/49.0/49.0 ms；普通会话对应为 6.32/6.48/6.48 ms、16.2/18.5/18.5 ms、3.7/4.0/4.0 ms、44.9/48.0/48.0 ms。renderer 请求发起到 main handler 进入的同机 epoch 间隔 p50/p95/max 为 1/1/2 ms，未见 IPC 派发排队。无 AX 中途读取的窗口仍有 3 条 50.1–54.7 ms Long Animation Frame，均报告 blocking duration 0、script attribution unavailable；因此不能宣称 AC-7 的 ≤50 ms 长任务目标通过。

对照的上一窗口每次切换后都读取完整 AX 树，观察到 7 条 renderer 长任务，其中 120/130.2 ms 两条与切换相邻，一条 blocking duration 为 67.3 ms。它说明 AX 采样可能增加观测干扰，但不足以证明干扰是根因。随后同一隔离实例 36 秒无交互空闲对照未记录 Long Task/LoAF；这提高了“长帧与切换或自动化观测相关”的可能性，但仍未区分两者。当前克隆整体启动状态为 `degraded`（142 项其他 History repair failure，并有其他会话 backfill coverage failure），虽然本次两个目标保持 complete/ready，也不能把该 profile 作为全局健康样本；无同库基线、热缓存、损坏缓存或维护开关矩阵，维护状态亦未能排除。10 个相关测试文件 97 项通过、25 项跳过；未运行全仓测试。此数据只补充当前分支真实历史冷路径，不能关闭 AC-7/P4-02/P4-03。逐条脱敏 trace、分组统计、身份与限制：[package-current-branch-real-history-cold-no-ax-2026-10-28.json](package-current-branch-real-history-cold-no-ax-2026-10-28.json)。

### 从冻结真实库重建同源隔离副本并复测当前候选包（2026-10-28）

在应用数据备份目录中找回原冻结数据库：`spaceassistant-data-before-ledger-rebuild-e78e8347-20261020.db`，SHA-256 `7c11d494879cbbf64b3761e9092d5a7dafb4135253a794cd5ed3826ee5f0d399`，schema 102，`quick_check=ok`。它与此前同源基线测量使用的备份名称、schema 和目标行数相符。源 spill index 的 144 个引用在配套 spill 目录中均有文件，引用字节合计 171,186,880。只读检查后分别建立 baseline/candidate APFS COW userData 副本；只在两个副本关闭飞书、微信自动启动，未向 IM 发送消息。

为确认基线可用，从干净提交 `109a938404124235d632e4cdbd4f9e06eaa48728` 重建 arm64 PKG。新包 build ID `35205b7a-46ab-45c7-ae77-890d43204ed4`，PKG/app.asar SHA-256 分别为 `3f4656132a531ce4f58f61f65338a3515b9494203dc9a84ec8c45d38d58b195c` / `a3e33001c36ee4934fa9239467b02ce7f1691e9799859abfb73511ffa5e9fb5f`。基线隔离库从 schema 102 正常迁至 107，启动恢复为 `ready`；150 条与 8 条目标会话均在原生 UI 中显示非错误消息正文。启动默认选中的另一条 legacy 会话仍显示缺失 `events.jsonl`，不计入目标会话观察。此轮只验证基线可启动和目标可读，没有重新采集基线性能。

随后用当前候选 arm64 PKG（build ID `6113fa88-2c21-41cf-b805-c0fb19115b2f`，PKG SHA-256 `6a5a07831f591017bbfe09325298abe427d3affb68275d87ae3a707902962928`，app.asar SHA-256 `5f09ef1980216bdad29e2d93ae1f992b74899aa1c9e87696cb7463edcf91a31a`）启动独立候选副本。用原生 CUA accessibility row selection 对 150 条“Agent Runtime调度化”与 8 条“分析微信链路工具调用均需用户确认且安全审核Agent未被调用的原因并输出报告”交替操作：大历史 30 次均在所取 AX 快照中出现消息容器；普通会话 31 次中 30 次出现，1 次首次快照没有消息容器，后续再次选择时显示正文。未观察到 `CANONICAL_SESSION_CONTENT_UNAVAILABLE`、`SESSION_LEDGER_BLOCKED` 或 `ENOENT`。该 AX 检查没有核对每次目标最后消息的唯一正文标记，也没有独立捕获 DOM `isTrusted`；因此将这 1 次保留为未就绪/未确认，不从尝试数中删除。

候选包在 2026-10-28 02:25:21.443Z–02:29:39.490Z 记录 63 条 main page-read trace，63/63 `ok`，页面大小 8/20 分别 31/32，全部 `cachePath=cold`。去掉前两条非交替启动/初选的 20 条页面读取后，30 条大历史切换 main handler p50/p95/max 为 7.53/11.59/14.54 ms，renderer page request 为 15.3/19.4/20.4 ms，next-paint 为 5.7/7.3/7.7 ms；stage-sum ready proxy p50/p95/max 为 40.4/48.0/55.3 ms。普通会话 31 次对应值为 5.53/6.89/8.2 ms、14.3/17.3/17.6 ms、6.1/7.9/10.4 ms、40.5/49.4/52.5 ms。ready proxy 是 `selection-to-page-request`、renderer request、failure hydration、store commit、render commit、next-paint 各阶段之和，不是独立逐次 last-message DOM marker 计时；长任务日志在此 trace window 为 0。

这份 profile 启动整体为 `degraded`、146 项 repair failure。候选库的大历史目标虽然有 150 条 SQLite 消息，但 History event 数为 0、body source 为 `backfilling`、ledger 为 `blocked`；普通目标 8 条消息、343 个 History event、source `complete`、ledger `ready`。故大历史结果只代表 legacy fallback，不能代表健康 canonical 大历史。该 run 没有配套重测 baseline latency，60 余次 AX 选择不等于逐次 trusted click 核验；首次快照失败及全局退化均保留。它补充当前包冷 legacy 路径及隔离副本可恢复性，不关闭 AC-7/P4-02/P4-03，也不覆盖 hot、damaged、维护开关/竞争、维护完成时间与 RSS。数据库/包身份和逐项限制：[package-frozen-real-history-current-candidate-identity-clone-2026-10-28.json](package-frozen-real-history-current-candidate-identity-clone-2026-10-28.json)。

### 冻结真实库 baseline/candidate 配对 AX 响应代理（2026-10-28）

随后用临时 CDP 观察器改进计时边界：在渲染进程收到原生 CUA 点击的 `pointerdown` 时起表，每个动画帧检查目标唯一正文标记已进入 `[data-message-id]` 节点且另一会话标记已消失；分别记录首次 DOM 命中帧与其后的双 `requestAnimationFrame`。每类 30 次，均 30/30 命中。大/普通会话 baseline 双 RAF p50/p95/max 为 190.0/205.9/206.3 ms、165.7/207.7/250.4 ms；candidate 为 217.8/232.5/244.5 ms、228.5/249.8/290.9 ms。Candidate p95 高 26.6/42.1 ms。双 RAF 只是渲染帧响应代理，不是物理像素呈现测量；本轮更精确边界的结果取代上文 AX 代理作为延迟观察，但 AX 原始证据仍保留。

版本与数据限制不变：两版由相同 schema 102 备份创建独立 COW 副本，基线 schema 107，候选 schema 117 且源树 dirty。真实大历史目标仍为 150 条消息、0 个 History event，候选 source `backfilling`、ledger `blocked:ledger_missing`，故该样本不代表健康 canonical 大历史；两个副本独立迁移、系统缓存条件不相同，不能作因果归因。尚未覆盖 hot/damaged/maintenance 矩阵、健康 canonical 大历史、Long Task/LoAF 同窗归因及维护 RSS，不能关闭 AC-7/P4-02/P4-03。逐样本、哈希、口径：[package-frozen-real-history-paired-pointer-dom-frame-2026-10-28.json](package-frozen-real-history-paired-pointer-dom-frame-2026-10-28.json)。

后续从同一 schema 102 冻结源各自新建 APFS COW 副本，基线包（commit `109a9384`，schema 107）与当前候选包（build ID `603e2716-34de-466a-8d99-57237ff5f69c`，schema 117）按相同方法各做 30 轮 ordinary↔large 交替切换。方法在筛选列表行后启动计时、点击首行，再轮询完整 AX 树直到出现目标正文标记且不含另一目标标记；计时止于首个命中 AX 快照。基线 large/ordinary 30/30 首快照命中，p50/p95/max 为 1101.4/1177.3/1182.3 ms 与 1073.2/1098.2/1098.6 ms；候选分别为 30/30 与 24/30 首快照命中，p50/p95/max 为 1101.9/1175.1/1184.2 ms 与 1265.8/1334/3306.9 ms。候选普通会话 6 次在第二次 AX 查询才看到正文，整体 30/30 最终命中。

这些耗时约 1 秒，主要包含 CUA 点击派发和完整 AX 树读取，不能解释为产品 click-to-paint 延迟。两版由相同备份独立迁移、呈现路径和页大小不同；真实大历史仍为 150 条 legacy 消息、0 个 History event，候选 source `backfilling`、ledger `blocked:ledger_missing`。因此这组数据只是自动化测量代理，普通会话较慢和一次 3.3 秒样本值得后续用 app 内 trace 复核，但不能据此归因或宣布 AC-7 通过/失败。未覆盖 hot/damaged/maintenance 矩阵、健康 canonical 大历史、Long Task/LoAF 同窗归因与维护 RSS。详细逐样本、身份和口径：[package-frozen-real-history-paired-ax-proxy-2026-10-28.json](package-frozen-real-history-paired-ax-proxy-2026-10-28.json)。

### arm64 PKG 对可用真实历史副本的健康度复核（2026-10-28）

用本轮 arm64 PKG payload（app.asar SHA-256 与已记录候选包一致）启动隔离身份副本，检查可用的 661 会话真实历史库。一个 88 条消息、source 状态为 `complete` 的会话能在 UI 中显示；但同一会话的 ledger projection 状态为 `blocked`，副本启动时另有 55 项待修复。因此该副本不满足健康真实历史样本条件。首次通过 LaunchServices 启动时没有取得本轮 build ID 的 trace；后续直接执行 app binary 后，窗口就绪约 617 ms、renderer 首绘约 240 ms。未据此计算该旧副本的延迟或成功率，也未把它并入 AC-7 矩阵。

PKG 未安装，第一份隔离实例已退出，原始来源副本未打开。又从更新的默认 profile 做 APFS COW 克隆：969 会话，35 条 source backfilling；ledger state 为 7 blocked、1 dirty、306 uninitialized、655 unknown。克隆前后 `quick_check=ok`。LaunchServices `open` 路径曾显示启动页约 41 秒；终止该隔离进程后，直接执行同一 app binary 可正常启动。因此没有证据证明包本身启动挂起，先前的“启动 41 秒卡住”不能作为结论。当前 build ID 的首个 page trace 是启动期首次读取 20 条消息：main handler 9.79 ms、其中 source page read 9.19 ms；renderer 等待 IPC 的计时为 14,241.8 ms，随后失败原因恢复 27.9 ms、提交到下一帧 23.3 ms。邻近 Long Task / Long Animation Frame 最大持续 316.8 ms、最大 blocking 263.2 ms。renderer 的 14.24 秒从调用开始计到 IPC Promise 返回，main handler 计时仅覆盖 handler 开始后的读取；现有 trace 没有标出延迟发生在哪个进程/阶段，且这是启动首读而非刻意触发的会话切换，不能将该值当作大历史切换延迟或归因给投影构建。该克隆 ledger 仍退化（启动报告 2302 项待修复，ledger gate `blocked` / `physical_proof_mismatch`），stderr 还出现重复 source-backfill 失败，因此不满足健康真实历史样本条件。两份真实历史副本仍不能提供健康大历史切换样本，本次不报告 AC-7 延迟分布/成功率。身份、包、数据库状态及限制：[package-real-history-profile-ledger-blocked-2026-10-28.json](package-real-history-profile-ledger-blocked-2026-10-28.json)。

为定位上述 renderer IPC 等待与 main handler 计时之间的空档，当前工作树按 TDD 为配对 trace 增加两个经过白名单过滤的 epoch 毫秒标记：renderer 在发起请求前记录 `requestInitiatedAtEpochMs`，main 在进入 IPC handler 时记录 `handlerEnteredAtEpochMs`；两侧沿用 renderer process ID / request ordinal 关联。它们使用同一机器 wall clock，只用于估算请求派发/排队间隔，不与进程内 monotonic duration 混算。新增用例先 RED（2 项），修复后 renderer trace、AgentLog 投影与 main trace 定向测试 35 项通过；`npm run build:electron:incremental`（含存储边界门禁）和 `npm run typecheck:renderer` 通过。该诊断改动尚未进入 arm64 PKG，也没有复测 14 秒现象；需在隔离 profile 的下一版候选包中验证时间戳差值，才能判断延迟发生在 handler 开始前还是处理之后。此次源码证据不关闭 AC-7/P4-02。

### P4-02 限时配对预检停止记录（2026-10-28）

按执行计划限定的单轮预检，从同一冻结 schema 102 数据库快照创建两份独立 COW 副本，并只复制大/普通目标的 History 文件到隔离工作目录。快照 SHA-256 为 `7c11d494879cbbf64b3761e9092d5a7dafb4135253a794cd5ed3826ee5f0d399`，两份来源副本哈希相同。旧版 `109a9384` 能启动并确认打开隔离副本，但启动 History recovery 报告 5 项修复失败，未给出对应会话身份。冻结文件中的全局 cursor integrity 标记为 invalid；后续 schema 102→103/104 迁移会根据游标事实重新计算该标记，已迁移的 baseline/candidate profile 均为 valid，因此原标记本身不是持续阻断。两个目标在冻结库中的投影台账均为 `unknown`，各有 `order-invalid` 拒绝记录，因此原始冻结快照仍不满足健康 canonical 样本前置条件。DB `agent_history_events` 与外部 `events.index.json` 统计不同事件存储，计数不可直接对比；初始停止记录曾将两者差异误判为源快照不匹配，已撤回。该初次预检未启动候选版、未采集性能样本，不计入 AC-7。临时副本已删除，冻结来源未写入。复现数据：[p4-02-bounded-pair-preflight-2026-10-28.json](p4-02-bounded-pair-preflight-2026-10-28.json)。

另行尝试用两份现成迁移副本建立同数据配对：目标消息行与 History 行的脱敏摘要完全匹配，旧版 profile 为 schema 107，候选 profile 为 schema 117。旧版二进制启动恢复为 `ready`，但切换时 `chat:get-session-compaction-markers` 返回 3 次 `SESSION_LEDGER_BLOCKED`；实际点击代理只有 3 个可信且正文 DOM 稳定样本，第 4 次未产生可信 pointer 事件，按停点终止。n=3 不计算 p95；候选版未启动，不作配对结论。隔离副本已删除。这说明现有旧版包无法在此迁移副本上完成可比样本；它不推翻“同一冻结库的目标账本状态为 unknown”，也不关闭 AC-7。证据：[p4-02-paired-sample-stop-2026-10-28.json](p4-02-paired-sample-stop-2026-10-28.json)。

对照源码后确认，旧包早于 `c2926903`：当前会话切换的 compaction marker hydration 会以 `retryBlocked:false` 复用旧 verdict，避免在每次切换重扫 History；旧包没有此只读分支，所以迁移副本 ledger 未就绪时三次 marker IPC 都以 `SESSION_LEDGER_BLOCKED` 结束。当前分支相关回归验证通过：History cursor migration/runtime 两文件 213 项、marker/ledger lifecycle 三文件 92 项；随后又针对“只读请求不等待挂起 writer drain”运行三文件组，87 项通过。该发现解释了旧包的异常调用路径，但没有足够点击样本量，也没有候选同轮数据，不能据此推算性能收益或关闭 AC-7。逐项验证：[p4-02-paired-sample-stop-2026-10-28.json](p4-02-paired-sample-stop-2026-10-28.json)。

### P4-02 单轮外验收尾（2026-10-28）

本轮按执行计划的限时流程进行，基线包前三次可信点击可完成并稳定显示目标正文；第 4 次输入在限时内未产生可信 pointer event，立即停止。未启动候选包，因此没有有效的基线/候选配对分位数，记录结论为“本轮未验收”，不核销 AC-7。原因、包与副本身份、已完成样本及清理状态见 [p4-02-paired-sample-stop-2026-10-28.json](p4-02-paired-sample-stop-2026-10-28.json)。

P4-02 本轮执行到此结束，不再追加同类代理、矩阵或重试。AC-7 仍未完成，故本记录不等于性能验收通过；任何后续重开须先解决可信输入失效这一明确阻塞，再判断是否仍有必要做配对测量。隔离 COW 副本已删除，源 profile 未修改，未运行候选包。
