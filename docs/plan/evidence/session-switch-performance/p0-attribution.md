# P0 性能归因与基线

日期：2026-10-27  
工作树：`.worktrees/session-storage-boundary-refactor`，候选基线 `cc80f3ed` 及当前未提交 P0 观测改动  
方案：`会话切换性能优化方案.md` §2、AC-1、AC-7  
计划：`会话切换性能优化执行计划.md` P0-02/P0-03

## 验收口径与环境

AC-7 的冻结工程候选口径仍以方案为准：ready 首屏 p95 ≤300ms、通常正文冷首屏 p95 ≤1s、主线程同步长任务 ≤50ms。此文只记录基线，不修改阈值，也不把本机合成结果当成安装包验收。

- 测试机：macOS 26.5.2、Apple Silicon arm64；测试宿主 Node 26.4.0；Electron 44.1.1（Node 24.19.0）；Vitest 4.1.6。
- SQLite 使用临时文件数据库，正文与 History 均为合成数据；会话切换运行使用独立 `/tmp/spaceassistant-session-switch-isolated-userdata`，不访问或修改安装包的用户库。
- 性能矩阵：`RUN_SESSION_SWITCH_PERF=1 npm exec vitest run electron/sessionStorage/sessionSwitchPerformance.test.ts -- --silent=false`，退出码 0；1 file、31 tests passed；总用时 271.43s（测试 270.52s）。每档标注 30 样本；生产冷读、损坏 fallback、异步 source mutation 各 30 样本。
- 定向 trace/脱敏回归：4 files、24 passed；Electron `tsc --noEmit` 与 `npm run typecheck:renderer` 通过。
- C1：4 files、189 passed、6 skipped（测试显式 skip）。
- C6：`npm run build:electron:incremental` 退出码 0；pi-ai runtime closure、session-storage cleanup boundary、session-storage module graph 三项门禁通过（31 个非法边探针均被拒绝），Electron 与 agent-provider 编译通过。
- Ready 100,000-message/20-entry Worker 读的 event-loop delay p95/max 约 1.76/1.82ms（Vitest monitorEventLoopDelay，30 次请求窗口）；这是 worker read 场景，不是 full cold build 或真实 renderer long-task 结论。

## 规模成本

| 路径/规模 | 样本 | p50 | p95 | max | 观察 |
|---|---:|---:|---:|---:|---|
| source identity：1,000 streams | 30 | 0.342ms | 0.493ms | 0.564ms | covering index；输出 20,198B JSON |
| source identity：10,000 streams | 30 | 3.226ms | 5.036ms | 8.640ms | covering index；输出 200,198B JSON |
| source identity：100,000 streams | 30 | 36.402ms | 44.507ms | 46.624ms | covering index；仍需拉取并序列化 2,000,198B identity |
| latest watermark：100,000 events | 30 | 约 23ms | 约 24ms | 约 24ms | commit-order index 后执行临时 B-tree 排序 |
| ready cache：100,000 messages，取 20 条 | 30 | 约 4.1ms | 约 4.3ms | 约 4.4ms | Worker 选择本身随全缓存消息量线性增加 |
| 合成冷页：300KiB canonical-only 正文 | 30 | 2,834.716ms | 2,889.645ms | 3,278.273ms | 30/30 `cold`，正文完整、无 fallback；`projection-prepare` p95 2,887.75ms |
| prepared blob 损坏后生产回退：300KiB 正文 | 30 | 2.316ms | 2.578ms | 2.824ms | 30/30 判 invalidated 并从 History 读回完整正文 |
| 读取期间追加 source，最终复核失败后回退 | 30 | 1.185ms | 1.590ms | 3.121ms | 30/30 检出变更并返回包含新消息的权威页 |

冷页构建分解（300KiB、30 次）中，source snapshot p95 1.907ms、source worker p95 16.957ms、reducer worker p95 16.289ms、final-view materialization p95 599.649ms；两片构建的总 `projection-prepare` p95 为 2.888s。可见 worker 正文读、按页选择与最终 source check 均为毫秒级，冷首屏等待主要集中在准备投影。分片计时没有解释准备阶段全部时间；该差值仍需在后续阶段继续归因，不能简单归到单一 CPU 函数。

生产冷读、生产损坏 fallback 与 in-flight source change 三组端到端场景各 30 次均完成，未观察到请求失败、错误正文或 stale page；损坏 blob 组每次都按预期转入权威 fallback。Worker 对主动损坏 payload 的拒绝组 30/30 是预期拒绝，不计为用户读取失败。

## 编译版 Electron 运行样本

使用当前分支编译后的 Electron，renderer 由 Vite 提供；显式隔离用户数据目录中只放合成会话。一个 300KiB 正文冷读样本：main IPC 总计 388.75ms，projection prepare 335.12ms，body read 52.29ms；当时后台维护记录两片 149.35ms 与 180.89ms。这个单样本说明该次冷读等待了投影准备，但不作为 p95，也不证明维护任务必然由点击触发。

修复 renderer/main ordinal 关联后，两个不同合成会话交替切换 6 轮。ready 页面 main 读取约 1–3ms，首个 Worker 初始化样本约 33ms；renderer page request 约 5–35ms，store commit 约 0–0.2ms，React render commit 约 2–6ms，next-paint 约 2–11ms。UI 操作通过 CUA Accessibility Snapshot 观测，包含 snapshot 等待的 wall time 不作为切换延迟。

独立 `ps` 采样器在上述隔离开发应用切换期间每 50ms 采样一次，共 279 个样本：main RSS 377,776–382,304KiB，renderer RSS 398,880–445,776KiB。该值包含开发 Electron/Vite 基线，不是干净启动增量，也不是 PKG 或真实用户库峰值。候选 PKG 与真实库的 AC-7 对照尚未进行。

## 实际路径差异与归因边界

对照 `109a9384` 的 `chat:get-message-page` 直接调用 SQLite 分页；当前路径先查询/准备 `chatBodyV1`，通过 History source identity 判定投影有效，再取消息骨架与本页 canonical body ID，必要时经 cache Worker 验证正文和 spill，随后复核 source identity 与页骨架，失败时回退权威 History。切换页大小由 60 减至 20；失败原因查询在两版都存在，摘要基线仍在消息显示后读取，不能把它算作本轮新增串行等待。

当前证据足以确认两个随历史增长的同步/CPU 成本：全量 source identity 拉取/JSON 序列化，以及 latest watermark 临时排序；ready Worker 也遍历整体缓存。冷 canonical-only 首屏等待准备投影。渲染 trace 的热路径未见长 commit，但这些合成测量不能推翻用户在 PKG 大历史会话中的卡顿报告；缺少相同真实库、同设备、旧包/候选包的 A/B 对照和真实写入并发。

## 阶段自检

- **观测缺陷 → 修复：** 首版在 preload 用不可枚举 Symbol 附加返回对象元数据；Electron `contextBridge` 将返回对象复制到 renderer 后丢失该 Symbol，实际运行只产生 main trace。改为 renderer 端统一包装全部 `chatGetMessagePage` 调用，在收到复制后的对象时附加本地 ordinal；主进程用当前 main-frame PID 补齐并校验关联。IPC 参数与返回对象 enumerable shape 未改变。隔离 Electron 实测同 ordinal 的 main、renderer IPC、store、React commit 与 paint 日志成对出现；见 `trace-correlation.md`。
- **观测边界：** 一次历史状态曾因测试期间外部改写隔离 SQLite 而在启动时报告 `PROJECTION_BUILD_SUPERVISOR_FAILED`；重新编译并以该隔离状态运行时该错误仍出现。此数据库被测试代码直接改写过，不能当作产品缺陷或用户库证据；后续 P0/P1 生命周期矩阵需用全新隔离库复核 supervisor。真实用户数据库未被打开。
- **未验证：** 未在安装 PKG 与真实库副本做同设备基线/候选 A/B；未完成 IM 并发；未测发布包干净进程峰值与能耗。AC-7 保持未关闭，P4-02/03 负责外验。
