# 消息列表性能优化 — 第二批复测门禁记录

| 字段 | 内容 |
| --- | --- |
| 日期 | 2026-07-22 |
| 分支 | `feat/chat-message-list-renderer-perf` |
| 工作区 | `.worktrees/chat-message-list-perf` |
| 机器 | Apple M2 / 16 GB / macOS / arm64 / Node v26.4.0 |

## 第二批已落地范围

- **B5/B6**：`apiContextService` + `ApiContextRequest`；queued/retry 经 mutation gateway；发送路径不再使用 `skipUserMessage`
- **B7**：`DisplayOrder` / `mergeDisplayEntries` / `ackDisplayMessagePersisted`；展示路径弃用 `mergeDbAndLive`（改名 timestamp 语义）
- **B8**：`chatGetMessagePage` 最新 60 条 + prepend；`contextHistorySummaryService`；`ContextUsageRing` 标量 props
- **B9**：结构化 `SearchFragment` / markdown 投影 / `chatStructuredSearchAdapter`（去掉 MutationObserver 全表重扫）
- **B10**：锁定 `react-virtuoso@4.12.8`；`ChatMessageViewport` 窗口化 + sequence 跳转补页

## 本机实测（相对 Batch1 全量挂载）

原始数据：[chat-message-list-batch2-remeasure-results.json](./chat-message-list-batch2-remeasure-results.json)

复现：

```bash
npx vitest run src/renderer/components/Chat/ChatMessageList.perf.batch2.measure.test.tsx
```

方法：与 Batch1 相同（`vitest + jsdom + React.Profiler`）。本测对比「全量 500 挂载」与「仅最新页 60」的数据面成本；生产路径另有 Virtuoso 可视行窗口化，DOM 只会更低。

### 结果摘要

| 场景 | 挂载耗时 | 挂载 commit max | 流式 commit p95 | DOM 节点 |
| --- | ---: | ---: | ---: | ---: |
| 全量 500（对照） | 256.8 ms | **200.6 ms** | 1.40 ms | 4680 |
| 最新页 60 | **26.0 ms** | **19.1 ms** | 0.28 ms | **580** |
| 60 / 500 | **0.10×** | **0.10×** | — | **0.12×** |

门禁断言（自动化）：

- `latest-page-60.mountMs < full-500.mountMs` ✅
- `latest-page-60.domNodes < full-500.domNodes` ✅
- `latest-page-60.mountCommits.max < full-500.mountCommits.max` ✅
- 最新页挂载 commit 无 `>50ms` 长任务 ✅（19.1 ms）

### 结论

**第二批数据面目标达成**：UI 初始只挂载最新页后，挂载耗时与 DOM 规模相对 Batch1「全量 500」基线下降。API context 与展示分页分离后，打开最新页/向上翻页不会改变 baseline `m0..m499` 语义（由 `apiContextService` 单测覆盖）。

## 验证命令

```bash
npx vitest run src/renderer/services/apiContextService.test.ts
npx vitest run src/renderer/services/apiContextQueueAndRetry.test.ts
npx vitest run src/renderer/services/displayMessageMerge.test.ts
npx vitest run src/renderer/services/contextHistorySummaryService.test.ts
npx vitest run electron/database/operations.test.ts
npx vitest run src/shared/chatSearchFragments.test.ts
npx vitest run src/renderer/services/markdownSearchProjection.test.ts
npx vitest run src/renderer/components/Chat/ChatView.scrollToLatest.test.tsx
npx vitest run src/renderer/components/Chat/ChatMessageList.perf.batch2.measure.test.tsx
npm run typecheck:renderer
npm run typecheck:shared
```
