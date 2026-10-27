# P4-02 macOS 真实库副本性能核验（进行中）

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

AC-6 包内仍未验证：投影块截断、发布边界故障及源编辑/追加/压缩/删除后的场景；源码层对应测试继续作为其余边界证据。

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
