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

为补计划指定的真实基线，已在临时 detached worktree 从 `109a938404124235d632e4cdbd4f9e06eaa48728` 完整构建并生成 arm64 PKG。基线 build ID `ebeaacf2-9a50-4773-8d98-b851e2b1c385`，`sourceTreeClean=true`；PKG SHA-256 `c4da0479b8a200f7170917f0df1e8729b1d73ef856f9d99c575cf5d681e3a098`，app.asar SHA-256 `bf70ebe8b402d7c3b2387f428a6e5f1dd4779362d580a3d3446c153eca107d0b`。打包目录与展开 PKG 的 app.asar 哈希相同，`codesign --verify --deep --strict` 通过。该基线包尝试在隔离 `baseline-v4` 副本启动时，因库 `schema_version=115` 高于二进制支持的 107 而拒绝打开。已检查的其余基线副本也为 schema 115，候选副本为 116；不能降级或篡改 schema 来强行运行。因此这次构建固定了基线二进制身份，但没有产生可采信的同库 UI 对照数据。

此前记录“设备仍锁定、无法点击”已被本次真实窗口测量取代；旧 AX/screenshot 计时仍只作为无效校准，不计入新样本。候选实例目前唯一运行，仍指向隔离副本；基线实例已因版本拒绝退出。IM 仍不适用：用户说明项目没有私聊或群聊测试会话，未发送任何消息。

P4-02 仍未完成。可靠的新证据覆盖了候选 cold-page 的真实 UI 切换与少量主线程长帧观察；尚缺基线兼容数据库、同口径基线、ready/corrupt cache、维护开关矩阵、长帧因果归因及维护竞争测量。不能据候选单边 p95 达成情况关闭 AC-7。
