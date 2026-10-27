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

P4-02 **保持进行中**。代码修复已提交，但不按局部候选分段数据关闭 AC-7。下一步要继续调查候选包 residual event-loop delay，并实现基线与候选同口径端到端采集（同时固定可验证基线二进制身份）；覆盖方案 §2 的首次访问、热缓存、损坏缓存、维护开/关，每个适用矩阵格至少 30 次；补充长任务、内存与维护完成数据。若同口径测量证实目标未达，返回相应源码任务处理。
