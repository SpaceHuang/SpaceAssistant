# P3-06 规模成本与后台定位记录回填

日期：2026-10-27

前置：P3-05 `89e501ab`
环境：当前 worktree，Vitest + 临时 SQLite 数据库；以下均为合成数据。此报告不代表编译版 Electron、PKG 或真实用户数据库的端到端体验。

## RED / GREEN 与生产路径断言

- Source identity 原先逐次枚举并序列化该会话的全部 History stream。移除冗余列表后，身份改用已有 History/stream 变更触发器递增的 `source_revision` 作为来源围栏；身份格式升级到 v2，投影发布端同时接受 v1/v2，保留已有租约兼容性。
- RED：新增 v2 source identity 发布探针时，projection service 与 SQLite state store 的硬编码 v1 校验拒绝发布。GREEN：两处均接受 v1/v2，并保留 message revision / watermark 一致性验证。
- 最新 History 水位查询显式过滤 NULL `session_seq`，走 `idx_agent_history_events_session_seq` 部分索引，不再触发临时排序；NULL 序号事件不会被误选为有序水位。
- RED：source locator 生产冷页原先计入 `prior-authority`。GREEN：确认读取来自定位记录后，路径诊断标为 `cold`。
- 两会话 A→B→A 生产读取集成测试为每会话增加 100 个无关空 stream；每次冷页读取断言只读取 1 条 locator、1 条依赖记录和 1 条 History 正文事件，且 0 行扫描无关 stream。

## 规模矩阵

执行命令：

```text
RUN_SESSION_SWITCH_PERF=1 npm exec vitest run electron/sessionStorage/sessionSwitchPerformance.test.ts -- --silent=false
1 file passed; 32 tests passed; 0 failed; duration 257.60s
```

| 路径 / 规模 | P0 p95 | P3-06 p95 | P3-06 其他观察 |
|---|---:|---:|---|
| Source identity，100,000 streams | 44.507ms | 0.052ms | 203B；0 个 History stream 行被扫描；P0 identity 为 2,000,198B |
| 最新水位，100,000 events | 约 23.8ms | 0.068ms | 走 session sequence 索引；无临时排序；P0 使用 commit-order 索引并临时排序 |
| Ready legacy prepared cache，100,000 messages 取 20 条 | 约 4.3ms | 3.929ms | 旧 prepared JSON 选择仍随整个缓存消息数增加；生产 v4 页存储由独立定向测试验证有界目录读取 |
| 100 个 source spills 的校验 | — | 2.888ms | 30 次样本；每个 spill 大小约 105B |
| 20 条正文合计 5MiB | — | 8.855ms | p95 含 Worker IPC/structured-clone 传输，不是主线程同步耗时 |
| 单条 8MiB 正文 | — | 8.391ms | max 28.904ms；单条大正文不承诺固定延迟 |
| 300KiB canonical-only 冷来源页 | P0：2,889.645ms | 753.347ms | 30/30 `cold`；正文完整；投影准备调用为 0；一次性 TypeScript Worker 读入 p95 752.57ms |
| 生产损坏 blob 回退 | — | 2.571ms | 30/30 回退并保留正文完整性 |
| 已准备页跨请求 source drift | P0 最近记录：4.987ms | 0.290ms | 30/30 拒绝旧页并回退 |
| 正文读取中 source drift | — | 771.813ms | 30/30 最终围栏拒绝旧页并回退；成本包含一次性 Worker 执行 |

同轮流量中的 ready 100k cache 仍走旧 JSON 兼容路径，因此该单项测量为全量 cache 解析/选择，不应被解释成 v4 production 页目录的访问成本。新增的 locator 集成断言直接检查 v4 生产读取 SQL 返回行数。

## 后台维护耗时与 RSS

专项测试对一个旧格式合成会话写入 1,000 条 256B 正文消息，并在一个 canonical History context event 中提供完整来源；后台 `createSessionBodySourceBackfillTask` 完成后检查 1,000 条 locator。

```text
[session-switch-backfill-perf] {"messageCount":1000,"historyEvents":1,"durationMs":10456.242,
"rssBeforeBytes":728465408,"rssPeakBytes":773537792,"rssAfterBytes":765509632,
"rssSamples":954,"locatorCount":1000,"status":"complete"}
```

RSS 以 10ms 周期在 Vitest 进程内采样，包含测试 Worker、SQLite 和运行时开销；这是粗粒度进程峰值，不是独立 Electron main 进程稳定峰值，也不外推到用户会话规模。该探针验证维护在后台任务完成、前台可继续读取的架构下可重建索引，不验证真实设备空闲调度时长。

## 结论与限制

- 来源身份与水位查询不再随 stream/event 数线性读取；固定页的 source locator 读取有生产路径行数断言。
- 合成 canonical-only 冷读 p95 从 P0 约 2.89s 降至约 0.75s，低于方案的 1s 候选值；测量在 Vitest/TypeScript Worker，不是 PKG 真实历史库，因此 AC-7 外验仍未完成。
- 后台回填的合成样本约 10.46s / 1,000 条消息；实际总耗时随正文材料、磁盘和设备变化，需要 P4 在隔离环境按方案口径验收。
- P0 ready JSON 兼容缓存的 100k 消息选择仍约 3.93ms p95；这条旧格式访问仍是 O(总消息数)，不能当作 v4 页目录路径指标。
- 不据此声称 PKG 切换体验、长期运行 RSS、生产迁移或 AC-7 已通过。P4 真实库/安装包验证仍是源码阶段之后的外部验收。

## 验证

```text
RUN_SESSION_SWITCH_PERF=1 npm exec vitest run electron/sessionStorage/sessionSwitchPerformance.test.ts -- --silent=false
1 file passed; 32 tests passed; 0 failed

git diff --check
通过
```
