# 消息列表性能优化 — 第一批复测门禁记录

| 字段 | 内容 |
| --- | --- |
| 日期 | 2026-07-22 |
| 分支 | `feat/chat-message-list-renderer-perf` |
| 工作区 | `.worktrees/chat-message-list-perf` |
| 机器 | Apple M2 / 16 GB / macOS 26.5.2 / arm64 / Node v26.4.0 |

## 自动化门禁（已落地）

设计 §5 要求 CI 只断言确定性的行为，不把耗时写入普通 Vitest：

- 流式 patch 最后一条时，历史完成气泡 render 次数不变（`ChatMessageList.memo.test.tsx`）
- `workDir` / `shellConfig` 变更会触发受影响气泡更新
- retry / cancelQueued 经稳定 `actions` 透传 message id
- Shiki LRU：1000 个不同代码块后 `entries <= MAX_HIGHLIGHT_CACHE_ENTRIES`；超大代码不入缓存
- ActivityBatch 折叠时不挂载子项；ToolCallCard 折叠时不 `JSON.stringify` 大 input
- `throttle.cancel` 可取消 pending trailing；会话切换/卸载清理 rAF 与 throttle

验证命令：

```bash
npx vitest run src/renderer/components/Chat/ChatMessageList.memo.test.tsx
npx vitest run src/renderer/utils/shikiHighlighter.test.ts
npx vitest run src/renderer/utils/throttle.test.ts
npx vitest run src/renderer/components/Chat/ActivityBatch.test.tsx
npx vitest run src/renderer/components/Chat/ToolCallCard.test.tsx
npx vitest run src/renderer/components/Chat/ChatView.scrollToLatest.test.tsx
npm run typecheck:renderer
```

## 本机实测（2026-07-22）

原始数据：[chat-message-list-batch1-remeasure-results.json](./chat-message-list-batch1-remeasure-results.json)

复现命令：

```bash
npx vitest run src/renderer/components/Chat/ChatMessageList.perf.measure.test.tsx
```

方法说明：`vitest + jsdom + React.Profiler.actualDuration`。Long Task 以单次 commit `>50ms` 近似；Markdown 在测量中 mock 为纯文本节点（真实 KaTeX/Shiki 只会更重）。该环境足以做 §6.1 门禁判断，不等于 Chrome Performance 面板的绝对 FPS。

### 结果摘要

| 场景 | 挂载耗时 | 挂载 commit | 流式 commit p95（100 次 patch） | DOM 节点 | 近似 heap Δ |
| --- | ---: | ---: | ---: | ---: | ---: |
| 20 条混合 | 15.2 ms | 11.0 ms | 0.23 ms | 201 | ~4 MB |
| 500 条混合 | 264.2 ms | **222.9 ms** | 1.77 ms | **4682** | ~74 MB |
| 500 / 20 | **17.3×** | — | 7.8× | **23.3×** | — |

### §6.1 触发判定

| 条件 | 结果 |
| --- | --- |
| 500 条打开存在可复现 `>50ms` 长任务 | **命中**（挂载 commit 223 ms） |
| 首次可交互相对 20 条 `>2×` | **命中**（挂载 17.3×） |
| 流式 commit p95 `>8ms` | 未命中（1.77 ms；第一批隔离生效） |
| DOM 随消息数近似线性 | **旁证命中**（23×） |

### 结论

**进入第二批。**

第一批已把流式热路径压到安全区（500 条下流式 commit p95 ≪ 8 ms，且无常态流式长任务），但打开/挂载整表仍是长任务，DOM 与消息数近似线性 —— 符合设计对 P-02 窗口化的触发条件。

第二批实施顺序（设计 §9）：

1. 先落地独立 `apiContextService` + payload 等价测试（不改 UI 加载）。
2. 再做 sequence 展示分页与上下文摘要。
3. 最后接入 Virtuoso + 结构化搜索跳转。
