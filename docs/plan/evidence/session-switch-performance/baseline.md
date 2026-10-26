# 会话切换性能基线核对（P0-01）

日期：2026-10-26  
当前候选：`cc80f3ed97bd29f6c562540392579bf2102dd2be`  
对照基线：`109a938404124235d632e4cdbd4f9e06eaa48728`  
计划来源：`会话切换性能优化执行计划.md` §3 P0-01  
方案来源：`会话切换性能优化方案.md`

## 环境与依赖

- macOS 26.5.2，Apple Silicon `arm64`；Node `v26.4.0`，Vitest `4.1.6`，Electron `44.1.1`。
- `package-lock.json` 存在，依赖已安装；`npm exec vitest -- --version` 成功。
- C1 中 SQLite 临时数据库与 Electron `node:sqlite` 相关夹具实际运行成功。无需连接或迁移真实用户数据库。
- 开始时 `git status --short` 为空；P0-01 期间仅添加本证据和更新本执行计划的进度标记。

## 读取契约与调用路径

### 重构前（`109a9384`）

`electron/ipc/agentProtocolIpc.ts` 的 `chat:get-message-page` handler 直接执行 `sessionQueries.readChatPage(payload)`。分页边界、排序与正文由既有 SQLite 查询负责；此入口不先等待派生正文投影。

### 当前候选

1. `src/renderer/components/Chat/ChatView.tsx` 的会话切换 effect 调用 `fetchMessagePage({ sessionId, limit: 20 })`。取得页后先回查失败原因，再 dispatch `setDisplayPage`；显示后异步读取上下文摘要基线。单独的 compaction marker、用量读取也由会话变化 effect 发起。
2. preload 将 `chatGetMessagePage` 转发到 `chat:get-message-page`；`electron/ipc/agentProtocolIpc.ts` 现在调用 `readChatPageAfterPreparation(sessionStorage, payload)`。
3. `electron/sessionStorage/public/readMessages.ts` 的分页包装先通过 `prepareForRead()` 取当前 `chatBodyV1` view 或等待 `ensureChatBodyV1()`，再调用 `readPreparedChatPage`，未能使用准备结果时回退 `queries.readChatPage`。
4. `tryPreparedChatBodyForRead()` 若缓存未命中且当前 transcript parity 证明有效，会异步请求构建并允许本次继续读取；没有证明时，分页包装等待整会话 view 准备。当前分页包装没有普通消息读取拥有的 `readChatMessagesBeforePreparation` 专用快捷入口。
5. 已准备分页会先查询消息页骨架和本页 canonical body IDs；若需要正文，则经过 cache reader/Worker 读取与验证，再复查源身份并重新查询页面后合并正文。
6. 后台投影构建通过 `createSqliteProjectionBuildTask` 注册在 lifecycle derived-index 维护中；`startWindowReadyMaintenance` 调用 `allowBackgroundWork()` 后可与前台切换并行运行。此事实不证明某一次点击一定等到了后台任务。

### 调用者和旁路

- 用户首屏入口：`ChatView` → `window.api.chatGetMessagePage` → preload → `chat:get-message-page` → `readChatPageAfterPreparation`。
- 主进程 `chat:get-display-message-page` 也走 `readChatPageAfterPreparation`。
- `queries.readChatPage`/`getChatMessagePage` 仍有直接调用能力，测试和内部查询可绕过 public preparation wrapper；生产读路径还包括 `chat:get-messages`、search、export、retry、API baseline、单条消息、IM/outbound/context consumers，各自有独立 wrapper 或查询入口。P3 接入时须逐一确认，不能据 IPC 覆盖宣称全局按页。
- 失败原因补查、摘要基线、compaction marker 与用量请求在对照基线已存在；本次代码差异中，会话首屏页大小由 60 调整到 20。它们不属于投影重构新增的主体成本。

## 隔离夹具构造方法

全部使用 Vitest 临时数据库和合成正文，不读取真实用户库，不写入真实 app userData。

| 场景 | 可复用夹具与构造入口 | 已覆盖证据 |
|---|---|---|
| 旧正文权威 / legacy | `createTempDatabase`、`createSession`、`appendMessage`，不写 canonical History；参照 `electron/sessionStorage/sessionStorage.test.ts` 的基础分页/消息查询用例 | C1 中 `sessionStorage.test.ts` |
| 混合正文与 context/ledger | 临时 workDir + `SqliteAgentHistory` 写 canonical 事件，同时保留普通消息/ledger sidecar；参照 `sessionStorage.test.ts` 中 `mixed ContextMeter facts` 和 ledger 用例 | C1 中 `sessionStorage.test.ts` |
| canonical-only 正文 | `appendMessage` 后经 `SqliteAgentHistory.appendBatch` 写 context/terminal 事件，再将消息置为 `content=''`, `content_storage_state='canonical-backed-only'`，验证 History 恢复正文 | `sessionTranscriptProjection.test.ts`、`sqliteProjectionBuildTask.test.ts` |
| 旧/缺失 ledger | 临时 workDir 不创建 JSONL sidecar，或对 sidecar/ledger projection 注入缺失/损坏；使用历史中 canonical facts 重建/对照 | `sessionStorage.test.ts` 中 History without JSONL 与 ledger repair 用例 |

性能专项将复用这些隔离数据库构造器，固定页大小 20，并分别改变 History event 数、stream 数、正文总字节、单条巨型正文与 spill 数量。此项只记录夹具落点；计数与基准属于 P0-02。

## 基线测试结果

命令均在当前候选 `cc80f3ed` 执行，退出码 0。

| 组 | 命令 | 结果 | 分类 |
|---|---|---|---|
| C0 | `git rev-parse HEAD`、`git status --short`、`npm exec vitest -- --version`，并运行 SQLite 测试夹具 | HEAD 为候选提交；开工时工作树干净；Vitest 4.1.6；C1 SQLite 夹具启动并运行 | 通过；环境就绪 |
| C1 | `npm exec vitest run electron/sessionStorage/sqliteProjectionBuildTask.test.ts electron/sessionStorage/application/projectionChatBodyCacheReader.test.ts electron/runtime/sessionTranscriptProjection.test.ts electron/sessionStorage/sessionStorage.test.ts` | 4 files；189 passed，6 skipped；Vitest elapsed 92.15s | 通过；6 项为测试显式 skip，不是失败或环境问题 |
| C2 | `npm exec vitest run src/renderer/components/Chat/ChatView.failureReasonRestore.test.tsx src/renderer/services/turnFailureHydration.test.ts src/renderer/store/chatSlice.test.ts src/renderer/services/displayPageLoader.test.ts src/renderer/components/Chat/ChatMessageList.failureReason.test.tsx` | 5 files；37 passed；Vitest elapsed 2.37s | 通过；渲染时序基线无既有失败 |

这些是当前候选的基线，不是 109a9384 的旧版本实测；旧版本的关键读取调用已由 `git show 109a9384:electron/ipc/agentProtocolIpc.ts` 核对。毫秒结果不作为 AC-7 性能结论。

## 已有运行日志线索（非点击归因）

只读检查仓库旁的 `/Users/space/Documents/Develop/SpaceAssistant/.agent/logs/Agent-20261026.log`：记录了 229 条 `session.projection.build.slice`，其中 118 条超过 1 秒、72 条超过 5 秒，最大约 33.77 秒；同一文件中有 20 条 `session.transcript.read` 以 `projection-rejected` 走 legacy，3 条以 `snapshot-invalid` 走 legacy，其中 3 条读取超过 1 秒（约 1.53、1.55、5.12 秒）。

这些事件没有记录会话关联 ID 和触发来源；不能证明它们是由用户切换直接触发，也不能把分片耗时等同主线程阻塞。本数据仅佐证运行时确有长时间投影构建/失效读取，P0-02 需补匿名 trace 与分段归因。

## P0-01 结论

- C0 通过；C1/C2 当前候选测试结果分类完成。
- 旧版分页 handler、当前准备包装、直接 query 能力和相关调用者已定位；合成历史数据构造方法可复用。
- 下一任务按依赖表进入 P0-02：先加脱敏、跨 renderer/main 的关联诊断和规模基准；不以本文件的日志线索替代点击级归因。
