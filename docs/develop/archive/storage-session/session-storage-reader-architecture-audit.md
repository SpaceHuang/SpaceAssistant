# 会话正文读取链路架构复核（2026-10-05）

## 范围与结论

本次沿 `electron/preload.ts` 暴露的会话、消息、搜索与恢复读取 API，追踪 renderer 调用、IPC handler、数据库/History reader 和现有测试。检查聚焦 `messages.content` 是否仍有不必要读取，以及 canonical-only 会话的 IPC 正文入口是否已接 canonical reader。

**发现一处不必要的正文读放大并已修复：** `chat:get-context-history-summary-baseline` 使用的 `getContextHistorySummaryBaseline` 原先 `SELECT * FROM messages`，然后只用角色、附件、thinking 与 sequence 计算图片/思考 token。现在查询只取 `id, role, thinking, attachments, sequence`，不再把历史正文读入进程。新增的回归先因旧 `SELECT *` 失败，再在修复后通过；输出仍保留原摘要语义。

除此之外，本次所查 renderer 可见正文 API 均落到 canonical-aware reader；摘要、会话 preview、turn display 等接口按元数据/持久 preview/活动 turn 投影工作，不是从 `messages.content` 获取 canonical-only 正文的旁路。此结论只针对下表所列源码链路，不把源码调用图等同于已完成的安装包矩阵。

## Renderer → preload → IPC → reader 对照

| Renderer 消费者 | `window.api` / preload channel | 主进程读取路径 | 当前证据及边界 |
| --- | --- | --- | --- |
| 聊天首次/历史分页 | `chatGetMessagePage` → `chat:get-message-page` | `getProjectedChatMessagePage`：缓存认证后按 stable ID 合并；否则做整会话 L2 fold | `ChatView` 调用；`appIpc.file.test.ts` 覆盖 canonical-only + reopen 的 message/display page；projection suite 覆盖缺 History/spill 与 cache 情况 |
| 活动 turn 结束后的显示恢复 | `chatGetDisplayMessagePage` → `chat:get-display-message-page` | 共用 `getProjectedChatMessagePage`，再由骨架组装 terminal display | canonical-only + reopen 成功及畸形 History 拒绝见 `appIpc.file.test.ts`；安装包故障矩阵尚未覆盖此 channel |
| API context 基线 | `chatGetApiContextBaseline` → `chat:get-api-context-baseline` | `getProjectedApiContextBaseline` | renderer service 和 app IPC 有接线/对照测试；实际发模型请求另由 accepted-turn 路径认证，不以 UI baseline 代替执行期 fence |
| 上下文图片/思考 token 摘要 | `chatGetContextHistorySummaryBaseline` → `chat:get-context-history-summary-baseline` | `getContextHistorySummaryBaseline` 只解析附件和 thinking 元数据；本次改为列投影，不读 `content` | operations suite 现有 late-row 行为测试 + 新 SQL 列集回归；返回不含 message body |
| 聊天内搜索语料 | `chatGetSearchCorpusPage` → `chat:get-search-corpus-page` | `getProjectedSearchCorpusPage` | renderer `chatSearchCorpus` 调用；projection suite 覆盖分页、canonical-only、reopen 与缺正文失败；安装包已测过该 channel 的健康读取和故障拒绝 |
| 全局会话搜索 | `searchExecute` → `search:execute` | `searchProjectedMessages` | `SearchPane` 调用；handler 与 projection 分别有测试；R 包 renderer IPC healthy/fault smoke 覆盖 global search |
| Renderer 通用消息列表/切换会话 | `chatGetMessages` → `chat:get-messages` | `readSessionTranscriptProjection` | `chatRunnerService`、`remoteSessionSwitchService` 调用；projection reader 按 session 在 legacy/canonical 路径解析；旧 profile/R 包有 renderer IPC 读回证据 |
| 重试上下文 | `chatResolveRetryContext` → `chat:resolve-retry-context` | `resolveProjectedRetryContext` | actual R v50 arm64 package 返回 canonical-only failed assistant/user 与附件 metadata；没有调用模型 |
| 从 checkpoint 继续 | `chatContinueFromCheckpoint` → `chat:continue-from-checkpoint` | continuation coordinator/storage 通过 `getProjectedMessage` 读取源 turn 消息 | continuation 编排有 IPC 测试；尚未在 R 包 canonical-only profile 上沿 renderer/preload 完整发起；本项会写入 turn，不属于只读 fault matrix |
| 消息 sequence / turn 元数据 | `chatGetMessageSequence`、`chatGetTurnErrors`、`chatGetTurnDisplays` 等各自专用 channel | 读取序号、错误台账、活动 turn/display snapshot 或 tool metadata；不是从旧正文列恢复正文 | renderer 调用与对应 handler/状态测试；活动 turn 结果在内存 turn projection，不表示持久 History reader 路径 |
| Session list preview | `sessionList` → `session:list` | 从 session 行返回已经持久化的 `preview`； canonical message mirror 在写入边界维护 preview | R 包 session preview 与消息正文 smoke 已对照。列表读取本身不逐条读 message body |
| 自动 backup / restore | backup manager 的 sequence page reader；restore 目前是生产 reader，无 renderer restore IPC/UI | `backupPageReader` → `getProjectedMessagesPageWithSequence`；restore 解析文件格式并校验消息 | R 包实际生成 JSON 与 message-page 全字段对拍；生产 restore reader round-trip 相等。没有独立 restore IPC，因此不声称安装包 UI restore 已覆盖 |

## 现有代码测试结果

- 新增 `getContextHistorySummaryBaseline` SQL 读列回归。红测先因返回 `SELECT * FROM messages` 失败，修复后 `npx vitest run electron/database/operations.test.ts`：**79 项通过**。
- `npm run build:electron:incremental` 通过，包含 SQLite cleanup boundary 静态门禁及 `tsc -p tsconfig.electron.json`；`git diff --check` 通过。
- 期间误用了不存在的 `typecheck:electron` 脚本，npm 报 `Missing script`；随后改用仓库定义的 Electron incremental build，实际 Electron TypeScript 检查通过。

## 尚未完成的证据

1. 本地源码链路复核不替代 §8.8.5.B 的安装包消费者矩阵。当前 R 包对 canonical-only 正常读取、global search、retry、backup/restore reader 及若干故障已有分项证据；`prepare-turn` route/reuse-user 的包内演练直接调用注册 handler，尚非 renderer→preload 完整链路。
2. `chat:get-display-message-page` 与 `chat:get-context-history-summary-baseline` 有文件 SQLite handler/reader 测试，但没有同一安装包、同一完整 canonical/complete profile 上的 renderer IPC 成功/故障组合证据。图片/思考摘要现在确认只依赖 SQLite metadata；故障时历史正文完整性由 message page/API/search 正文 reader 决定。
3. Windows x64 安装包仅完成 cleanup-disabled TEST ONLY 交叉构建；缺 Windows 主机上的安装、启动、SQLite native binding、canonical-only 读取和回滚演练。
4. 发布版 R 的 commit/tag、可取回安装产物、C→R 正式产物复验、rollback audit Accepted 与真实 profile 正常升级后只读 audit 仍按 §8.8.5/C.1 处理；本次源码审计不放行这些发布/数据门禁。

## 关联改动

- `electron/database/operations.ts`：上下文摘要改为按需取列并直接计算附件/思考 token。
- `electron/database/operations.test.ts`：确保查询不再读取 `content`，且图片摘要输出保持预期。
- 技术方案 v339 与迁移计划发布台账同步记录本次源码复核范围和残余的实包/发布证据。
