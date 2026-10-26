# Source identity stream-scale probe

日期：2026-10-26  
工作树：`.worktrees/session-storage-boundary-refactor`  
方案依据：`会话切换性能优化方案.md` §1 F-6、§2  
命令：`RUN_SESSION_SWITCH_PERF=1 npm exec vitest run electron/sessionStorage/sessionSwitchPerformance.test.ts -- --silent=false`

## 环境

- macOS 26.5.2，Apple Silicon arm64；Node v26.4.0；Vitest 4.1.6；Electron SQLite 临时文件数据库。
- 每档为独立合成会话，仅创建 `agent_history_streams` 行；按 1k/10k/100k 数量变化。每次读取完整 source identity，共 30 次计时。
- 另以一条 stream 写入 1k/10k/100k event rows，测量最新 watermark 查询；同样每档 30 次。
- 所有夹具均为临时合成数据。Worker payload cold miss / corrupt rejection 是 Worker 层探针，不是未准备投影的完整生产冷读；不是完整 Electron 切换延迟，也不代表设备上的 UI/IPC 结果。

## 结果

| History stream 数 | 身份 JSON 大小 | p50 (ms) | p95 (ms) | max (ms) | 查询计划 |
| ---: | ---: | ---: | ---: | ---: | --- |
| 1,000 | 20,198 B | 0.330 | 0.432 | 0.491 | `SEARCH ... USING COVERING INDEX idx_agent_history_streams_session (session_id=?)` |
| 10,000 | 200,198 B | 3.077 | 4.959 | 8.094 | 同上 |
| 100,000 | 2,000,198 B | 32.811 | 36.723 | 40.793 | 同上 |

Vitest 最新矩阵轮次（2026-10-26 23:35）：1 file、29 passed；stream/event/ready、spill、正文总量、巨型正文、payload cold miss、corrupt rejection 与 source-drift fallback 各档均为 30 样本。生产损坏 blob 完整正文 fallback 另有 1 次端到端探针。计时在单机热 SQLite 文件缓存条件下完成，样本顺序固定从小到大；未作随机交错和冷缓存控制。

## 单 stream 事件数维度

保持单条 stream 不变，将同会话 History events 扩至 1k/10k/100k，每档 30 次。watermark 子查询结果始终一行，但 EXPLAIN 发现查询走 `idx_agent_history_events_session_commit_order` 后再做 `USE TEMP B-TREE FOR ORDER BY`，没有使用 `idx_agent_history_events_session_seq`：

| History event 数 | 身份 JSON 大小 | p50 (ms) | p95 (ms) | max (ms) | 查询计划 |
| ---: | ---: | ---: | ---: | ---: | --- |
| 1,000 | 268 B | 0.200 | 0.231 | 0.242 | session commit-order index + temp B-tree sort |
| 10,000 | 271 B | 1.989 | 2.184 | 2.211 | session commit-order index + temp B-tree sort |
| 100,000 | 274 B | 21.143 | 21.987 | 22.289 | session commit-order index + temp B-tree sort |

这显示最新事件查询虽然只返回一行，排序仍随事件规模增长。属于 P0 性能归因证据；是否调整索引或查询契约，应在后续实现任务中基于完整语义测试处理，不能在诊断阶段悄悄改变 watermark 行为。

此前重复测量方向一致，但尚未满足跨轮随机化与完整 matrix 控制。

## Worker 计时连通性探针

`projectionChatBodyCacheWorkerClient.test.ts` 的 300 KiB 合成 blob 读取单次记录：worker queue `0.115 ms`、source spill verification `0 ms`（该场景未配置 spill）、worker payload read/verify/select `3.189 ms`。该探针验证 Worker 内部的安全计时标量可回传并进入诊断回调；只有 1 次样本，且没有真实源 spill，不能作为阶段性能结论。

## Ready 页正文选择规模

使用 Worker LRU 中已完成完整校验的 prepared cache；先 warm 一次，然后每档读取最后 20 条、重复 30 次。合成消息正文固定为 1 字符，未含源 spill、巨型消息或并发维护。这里的 Worker `read` 是缓存命中后的完整选择循环，不包含首个 payload 磁盘读取/全量验证：

| 缓存消息数 | 缓存 JSON 大小 | 页大小 | 请求 p50/p95/max (ms) | Worker 选择 p50/p95/max (ms) | Worker transport p95 (ms) |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 60,676 B | 20 | 0.111 / 0.161 / 0.234 | 0.055 / 0.070 / 0.082 | 0.060 |
| 10,000 | 623,179 B | 20 | 0.402 / 0.450 / 0.455 | 0.356 / 0.371 / 0.394 | 0.046 |
| 100,000 | 6,428,182 B | 20 | 3.471 / 3.639 / 3.822 | 3.376 / 3.567 / 3.743 | 0.064 |

Worker process reused across the 30 reads (`workerThreadCount=1`). The first 1k request created it; startup was 14.998 ms. The 10k and 100k cases used the already running process.

同一轮另记录进程 RSS 与 event-loop delay：

| 缓存消息数 | RSS 前→后 | event-loop delay p95/max (ms) |
| ---: | ---: | ---: |
| 1,000 | 573,997,056 → 574,095,360 B | 1.156 / 1.164 |
| 10,000 | 577,896,448 → 578,256,896 B | 1.268 / 1.294 |
| 100,000 | 641,040,384 → 641,040,384 B | 1.667 / 1.888 |

RSS 是 Vitest 进程绝对读数的前后差，不是干净进程测得的峰值；event-loop delay 只覆盖 30 次 warm-cache 请求及其后 10 ms 采样等待。两项都不能替代 Electron main/renderer 的端到端阻塞与峰值 RSS 测量。

即使 payload 已在 Worker 内存 LRU，当前选择仍随所有缓存消息数线性变慢；固定 20 条输出没有形成 O(20) 的访问。100k 条、6.4 MB 的合成 warm path Worker p95 约 4.18 ms。该数据直接支持方案 F-7 / AC-4 的分页定位方向，不能单独外推到产品大会议时延。

## Spill 数量、正文总量与巨型正文

spill 夹具固定正文 cache 约 309 KiB、请求 20 条小正文，分别验证 0/1/10/100 个源 spill，每档 30 次；计时来自 Worker 的源 spill 校验阶段：

| 源 spill 数 | spill 总字节 | Worker spill 校验 p50/p95/max (ms) | 请求 p95 (ms) |
| ---: | ---: | ---: | ---: |
| 0 | 0 | 0 / 0 / 0 | 0.154 |
| 1 | 104 B | 0.028 / 0.249 / 0.252 | 0.451 |
| 10 | 1,040 B | 0.200 / 0.259 / 0.353 | 0.480 |
| 100 | 10,490 B | 1.648 / 2.115 / 2.922 | 3.126 |

正文总量维度固定 20 条页正文，并测量完整返回这些正文；RSS/event-loop 为 Vitest 进程粗测：

| 页正文总量 | cache JSON | 请求 p50/p95/max (ms) | Worker p95 (ms) | RSS 前→后 (B) | event-loop p95/max (ms) |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 20 KiB | 21,998 B | 0.085 / 0.152 / 0.179 | 0.014 | 640,434,176 → 640,450,560 | 2.094 / 2.094 |
| 640 KiB | 656,879 B | 0.136 / 0.187 / 1.174 | 0.014 | 642,547,712 → 642,580,480 | 1.197 / 1.720 |
| 5 MiB | 5,244,400 B | 1.761 / 4.026 / 4.276 | 0.040 | 689,111,040 → 826,654,720 | 2.038 / 3.731 |

5 MiB 页的 Worker transport p50/p95/max 为 `1.640/3.937/4.142 ms`，明显高于 Worker 内部选页 p95 `0.040 ms`；主进程往返和 structured-clone 传输是这条基准的主要成本。本轮 Vitest RSS 在 30 次请求后上升约 131 MiB；该粗测混有 GC/测试运行时噪声，不能据此判定稳定峰值，需独立进程测量。

单条 1 MiB 巨型正文请求 p50/p95/max 为 `0.251/0.323/2.968 ms`；8 MiB 为 `3.583/7.119/17.561 ms`。每项 30 次，包含向调用方传回正文；巨型正文不承诺固定耗时。max 有明显抖动，不能只用 p95 掩盖。

640 KiB payload cold miss（每次唯一 payload、同一常驻 Worker）p50/p95/max：请求 `1.477/2.329/5.447 ms`，Worker 内部 `1.285/2.095/5.208 ms`，transport `0.131/0.206/0.229 ms`。同一 payload 重复命中 p50/p95/max：请求 `0.130/1.311/1.689 ms`，Worker 内部 `0.007/0.012/0.013 ms`，transport `0.090/1.261/1.637 ms`。

损坏 blob 拒绝 30/30 次，Worker 返回长度/摘要不匹配；拒绝 p50/p95/max 为 `0.478/0.574/0.588 ms`。这是 Worker reject latency，不含生产 query 后续缓存失效及权威回退。

## 源变化回退

用真实 SQLite storage host 和 10,000 条 History stream 构造已准备 view。每个样本先 append 一条消息，再通过前一版 view 调用生产 `readChatPageAfterPreparation`；每次都拒绝旧 prepared 页并在 fallback 中读回新消息（30/30）。p50/p95/max 为 `3.239/4.987/8.567 ms`。这是两次请求之间发生变化，不是异步读取中途变化；不包含后台维护并发。

## 生产分页的损坏 blob 回退探针

以真实 SQLite host 和 300 KiB canonical-only user message 构建外置正文 blob，主动改写 blob 内容后调用 `readChatPageAfterPreparation`。正式查询检测投影正文不匹配、使缓存失效，并从权威 History fallback 返回完整 307,200 字节正文；最新完整 C5 中回退路径计时 1 次为 `3.714 ms`，隔离复跑为 `4.435 ms`。这是端到端路径正确性探针，不是 30 样本性能矩阵，也不测量无缓存冷首次访问。

## 结论与限制

- 查询走 covering index，但 source identity 仍将该会话的全部 stream ID 拉入进程并 JSON 序列化。行数增加 100 倍时，p50 约增至 101 倍；索引没有消除输出与序列化的线性工作。
- 最新 event watermark 查询在 100k events 时 p95 约 22 ms，执行计划有临时排序；输出只有一行不代表扫描工作有界。这是当前实现需要处理的明确热点。
- 该测量只覆盖 identity 子步骤，不能等同完整 prepared page 的同等耗时或用户点击长任务；实际完整分页还包含缓存读取、源 spill 检查、正文读取、复查和渲染。
- 此处“结论与限制”反映 2026-10-26 的首次矩阵状态。后续补齐的 30 样本生产冷读/损坏 fallback、读取中 source mutation、隔离 Electron trace ordinal join 和外部 `ps` RSS 样本见下方 P0 最终矩阵增量；真实安装包与真实库仍未验收。

## P0 最终矩阵增量（2026-10-27）

命令：`RUN_SESSION_SWITCH_PERF=1 npm exec vitest run electron/sessionStorage/sessionSwitchPerformance.test.ts -- --silent=false`；退出码 0，1 file、31 passed，测试耗时 270.52s。此轮包含完整 30 样本矩阵、生产冷读、生产损坏 fallback 与读取中 source mutation。

- 100,000 streams source identity：p50/p95/max `36.402/44.507/46.624 ms`，2,000,198B JSON；仍是 covering index，但输出与序列化随 stream 数线性增长。
- 100,000 History events watermark 最新值查询：仍使用 commit-order index + temporary B-tree sort；最近一次独立复跑 p50/p95/max `23.386/23.799/24.399 ms`。
- ready cache 100,000 messages 取 20 条：最近一次独立复跑请求 p50/p95/max `4.087/4.241/4.267 ms`；Worker 选择仍随全缓存消息数增长。
- 300KiB canonical-only cold production read：30/30 `cachePath=cold`，完整正文正确，无 fallback；请求 p50/p95/max `2,834.716/2,889.645/3,278.273 ms`。`projection-prepare` p95 `2,887.75 ms`；正文 `body-read` p95 `3.49 ms`。
- 300KiB production corrupt blob fallback：30/30 invalidated 并从 History 返回完整正文；请求 p50/p95/max `2.316/2.578/2.824 ms`。
- source 在 Worker 正文读取后、最终复核前变化：30/30 拒绝 stale prepared 页并回退到包含新消息的权威页；请求 p50/p95/max `1.185/1.590/3.121 ms`。
- 同轮 production cold projection build 的 final-view materialization p95 `599.649 ms`；source snapshot、source worker、reducer worker p95 分别 `1.907/16.957/16.289 ms`。这些分段不能解释准备阶段约 2.9s 的全部时间；剩余成本留作后续归因，不推测归因于某个线程或单一操作。
- 编译版隔离 Electron 实际切换、main/renderer ordinal join 与 `ps` RSS 抽样见 [`p0-attribution.md`](p0-attribution.md) 与 [`trace-correlation.md`](trace-correlation.md)。样本来自开发版/Vite 与合成数据，不能代替 PKG/真实库。

此前记录的“损坏 blob 仅 1 次、冷生产读矩阵未做、读取中 source mutation 未做、运行时 ordinal join 未做”已经由本节及对应运行证据关闭；安装包真实库 A/B、真实 IM 并发及 AC-7 外验仍属于 P4。
