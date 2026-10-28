# P3-05 跨入口与并发故障边界

日期：2026-10-27

前置：P3-04 `8ee49f8b`
范围：跨入口语义回归、分页读期间的来源变化、一次性前台 Worker 调度上限与 Worker 退出屏障；未修改 IPC 或公开消息 API。

## RED / GREEN

- RED：增加缓存分页 Worker 与冷来源分页 Worker 同时请求时的探针。原实现分别直接启动一次性 Worker，两个 Worker 可并发启动；未满足前台读任务共享的有限调度约束。
- GREEN：新增 `withProjectionForegroundWorkerBudget`，对缓存大块选择和冷来源正文读取共用一个 Worker slot；前一任务的 Worker promise（包含实际 `exit`）结束后才启动下一项。等待队列最多 16 项，满载明确返回 `PROJECTION_FOREGROUND_WORKER_QUEUE_FULL`；取消排队项只移除该 waiter，不影响相邻任务。缓存搜索/Worker 路径另有 32 个 pending request 上限。
- 数据页交付仍依赖两阶段 source identity 与页骨架校验。新增来源正文物化期间删除会话、关闭数据库用例，验证旧页正文不泄漏；来源页变化时仍拒绝旧窗口。A→B→A 集成用例验证 locator 读取始终按 session scope 隔离。

## 跨入口和故障覆盖

- `readChatMessages.test.ts`、`sessionStorage.test.ts` 覆盖分页、单条、普通消息、搜索、导出、API baseline、retry 与上下文 scope 的既有读取语义；本阶段没有改变这些公开入口的参数或返回类型。
- `projectionBuildSupervisor.test.ts` 覆盖重复请求合并、公平调度、deadline retry、停止/恢复及随机请求序列的 worker 数不变量；`ensureView.test.ts` 覆盖单个 caller 取消不取消共享准备；`projectionWorkerExitBarrier.test.ts` 覆盖 reducer/final/cache Worker 必须实际退出后才视为完成。
- `projectionSourceDependencyReader.test.ts`、`fullAuditSourceSpillProbe.test.ts` 与 `projectionSourceIdentity.test.ts` 分别覆盖来源 locator/event 缺失或漂移、canonical spill 缺失/损坏、derived blob 缺失时 History 回退及关闭重开连接后的 source 校验。来源损坏不会被转为空成功页。
- `sessionBodySourceBackfill.test.ts` 增加 locator 冷页 A→B→A、物化期间 append/page drift、删除会话及关闭数据库四个边界；损坏、覆盖不全、取消等回填边界也在该文件已有测试。
- `projectionForegroundWorkerBudget.test.ts` 覆盖共享 slot、队列容量上限和取消单个排队 waiter。此限制用于避免会话切换期间多个一次性前台 Worker 同时争抢 CPU/内存；超载显式失败，不在队列无限积压。

## 验证

```text
npx vitest run electron/sessionStorage/infrastructure/sqlite/sessionBodySourceBackfill.test.ts electron/sessionStorage/infrastructure/sqlite/projectionForegroundWorkerBudget.test.ts
2 files passed; 10 tests passed; 0 failed
```

```text
npx vitest run electron/sessionStorage/infrastructure/sqlite/sessionBodySourceBackfill.test.ts electron/sessionStorage/infrastructure/sqlite/projectionForegroundWorkerBudget.test.ts electron/sessionStorage/application/readChatMessages.test.ts electron/sessionStorage/infrastructure/sqlite/projectionSourceDependencyReader.test.ts electron/sessionStorage/infrastructure/sqlite/projectionSourceIdentity.test.ts electron/sessionStorage/application/projectionBuildSupervisor.test.ts electron/sessionStorage/application/ensureView.test.ts electron/sessionStorage/application/projectionWorkerCancellation.test.ts electron/sessionStorage/infrastructure/sqlite/projectionWorkerExitBarrier.test.ts electron/sessionStorage/infrastructure/sqlite/projectionChatBodyCacheWorkerClient.test.ts electron/sessionStorage/infrastructure/sqlite/projectionHistoryChunkWorkerClient.test.ts electron/sessionStorage/infrastructure/sqlite/projectionHistoryReducerWorkerClient.test.ts electron/sessionStorage/infrastructure/sqlite/projectionFinalViewWorkerClient.test.ts electron/sessionStorage/contextAdapter.test.ts electron/sessionStorage/routingQueries.test.ts electron/sessionStorage/preparedReadCancellation.test.ts electron/sessionStorage/sessionStorage.test.ts electron/sessionStorage/projectionPageSourceFallback.test.ts electron/sessionStorage/fullAuditSourceSpillProbe.test.ts electron/sessionStorage/application/projectionBuildCoordinator.test.ts electron/sessionStorage/infrastructure/sqlite/pagedChatBodyStore.test.ts electron/sessionStorage/infrastructure/sqlite/projectionPagedBodyWriter.test.ts
22 files passed; 199 tests passed; 0 failed
```

```text
npm run build:electron:incremental
exit 0：pi-ai runtime closure、session-storage cleanup/module graph（31 个 illegal-edge probes）、agent provider build 与 Electron TypeScript 编译通过。

git diff --check
通过。
```

## 范围与限制

- 本阶段验证的是源码级 deterministic tests 与增量编译，不代表已安装 PKG 上的真实交互、全量回归或 P3-06 的规模/峰值内存验收。
- 队列饱和采用稳定错误返回；调用方原有 authority/error handling 继续处理该失败。该错误的产品层重试体验和压力下端到端延迟将在 P3-06 评估。

## 外部 projection blob 截断回归补充（2026-10-28）

补充 `sessionProjectionBlobStore.test.ts` 用例：将已发布 projection blob 文件截短至原长度一半，确认 `withVerifiedReadStream` 以 `PROJECTION_BLOB_CORRUPT` 拒绝，并且在校验长度失败时消费端收到的字节数为 0。与 `projectionBuildCoordinator.test.ts` 联合定向运行：2 个文件、50 项通过。此为源码层故障边界证据，不替代 P4 安装包验收。
