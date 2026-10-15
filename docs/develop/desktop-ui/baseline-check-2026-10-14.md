# desktop-ui baseline 核验记录（2026-10-14）

> 基线：`17236274`｜执行：Agent｜窗口：`git log 17236274..HEAD -- src/renderer electron/workDir*` = **0 条**
> 被核验对象：[`桌面交互与工作区-现状.md`](./桌面交互与工作区-现状.md)（2026-10-14 新写）

| 断言 | 出处 | 命令 | 实测 | 判定 |
| --- | --- | --- | --- | --- |
| A1 渲染层组件面板齐备 | 现状 §1 | `ls src/renderer/components` | 命中 12 个目录（Chat / SessionList / FileTree / DetailPanel / Search / Config / Browser / UsageStats / WikiPane / FloatingNotification / TitleBar / shared / ui） | 一致 |
| A2 轮次投影服务存在 | 现状 §2 | `ls src/renderer/services/turnProjectionService.ts` | 命中（3 文件引用，含 `App.tsx`） | 一致 |
| A3 会话运行服务存在 | 现状 §2 | `ls src/renderer/services/chatRunnerService.ts` | 命中（13 文件引用，含 `ChatView.tsx`） | 一致 |
| A4 搜索语料/适配器族 | 现状 §2 | `ls src/renderer/services/chatSearch*.ts` | 命中（`chatSearchCorpus` 3 文件引用） | 一致 |
| A5 工作目录管理与绑定 | 现状 §3 | `ls electron/workDirManager.ts electron/workDirBinding.ts electron/workDirSnapshot.ts` | 命中（`workDirManager` 被 67 文件引用） | 一致 |
| A6 会话目录授权 | 现状 §3 | `ls electron/sessionDirectoryGrants.ts` | 命中 | 一致 |
| A7 性能优化两批已落地 | 现状 §4 | `ls docs/develop/archive/desktop-ui/chat-message-list-*` | 命中（含复测门禁与结果 json） | 一致 |

## 矛盾与时间线检查

- **双入口检查（已消解，2026-10-14）**：`archive/desktop-ui/渲染进程卡顿优化方案.md`（v3.25）与 `archive/desktop-ui/streaming-ui-performance-analysis.md`（v1.0）曾被记为「同话题两条线索待拍板」。经读原文复核：前者管**工具调用高频事件**链路（`bounded display meta → renderer coalescing → on-demand tool detail`），后者管**流式 token 渲染**链路（`ChatView` / `chatRunnerService` / `ChatBubble` / `ChatMarkdown` / `ShikiCodeBlock`）—— **问题域不同，不构成双入口**。用户已拍板按「两条独立主线」组织现状文档（见 [`桌面交互与工作区-现状.md`](./桌面交互与工作区-现状.md) §4.1 / §4.2）。
- **history 抽样**（3 条，均可命中）：`810d38e2`（composer 加号菜单）、`86d613cf`（列表停止按钮提示 Phase 3）、`6fe55d43`（死文件与孤儿 i18n key 清理）。

## 无法核验项

- 渲染性能的**实测帧率/耗时**需真机与性能基线（原复测门禁在归档件里，未重跑），标 `待真机核验`。

## 抽样复核建议（用户抽 3 条）

A1、A5、A7。

## 完备性复算（`ls` 全量，2026-10-14）

> 与上表同属一份记录的两个维度：上表核验「断言的点是否存在」，本节核验「现状文档是否**列全**」。

| 维度 | 全量实测 | 补充判定 |
| --- | --- | --- |
| §1 组件面板 | `ls src/renderer/components` = **13 项** | 与现状文档**完全一致** |
| §2 渲染服务 | **实际 60+ 件** —— 初版只列 8 族，漏：轮次展示与失败态（`turnDisplay*` / `turnFailure*` / `runRequestIndex`）、工具详情与暴露面（`toolCallDetails*` / `toolExposureService` / `mcpToolCatalog` / `terminalToolCallDisplay`）、搜索语料扩展（`domSearch*` / `fileMarkdownSearchAdapter` / `fileSourceSearchAdapter` / `markdownSearchProjection`）、文件与工作区同步（`fileContentSyncBus` / `fileTreeSyncBus` / `filePaneNavigation` / `workDirSessionSync` / `invalidationService`）、待确认与远程（`pendingConfirm*` / `remoteSessionSwitchService` / `wechatPollFeedback`）等 7 族 | **漂移（严重不完备）** → 现状文档已补写 |
| §2 状态切片 | `src/renderer/store/` = `chatSlice` / `chatLaunchSlice` / `sessionSlice` / `configSlice` / `browserDetectSlice`（+ `index.ts`） | 初版**未列** → 已补 |
| §3 工作目录 | `workDirManager` / `workDirBinding` / `workDirSnapshot` / `sessionDirectoryGrants` | 一致 |
