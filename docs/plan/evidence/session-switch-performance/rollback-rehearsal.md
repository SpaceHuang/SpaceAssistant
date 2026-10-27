# P4-01 本机回退演练与候选包

日期：2026-10-27  
设备：macOS arm64  
候选代码：`830047e4`（P3-07）；构建工作树之后仅增加本证据与测试断言，没有改动运行时代码。

## 演练结论

本机源码回退场景和 arm64 PKG 候选构建通过。未安装候选包，也未打开/迁移当前用户数据库。根据 P2 版本兼容规则，v116 数据库不能交给旧二进制直接打开；真正回退必须恢复迁移前数据库副本或备份。该隔离恢复流程尚未对用户真实库演练，留给授权的 P4-02/03 环境。

## 回退路径证据

- 缓存 miss/准备失败时调用权威 reader：`readChatMessages.test.ts` 覆盖 selection-time cache miss、projection unavailable 两条路径；11 文件整组回退验证 188 项通过，覆盖缓存读取、损坏、定位记录回填和恢复。
- 新缓存损坏不会改写 canonical History：`projectionChatBodyCacheReader.test.ts` 覆盖缺失 blob 与 corrupt publication 的 CAS 失效；`pagedChatBodyStore.test.ts` 覆盖目录、body block、长度、索引和 manifest 校验；`sessionProjectionBlobStore.test.ts` 覆盖缺失引用 blob fail closed。
- v116 迁移保留原始 History：`migrations.sessionBodyLocator.test.ts` 在升级前写入 canonical event，运行 115→116 后断言同一 `event_id` 和正文仍在 `agent_history_events`，并验证新 locator 状态/触发器；该文件 2 项通过。
- 关闭屏障：`lifecycle.test.ts` 检查停止接收新任务并等待活动工作 quiescent；`projectionWorkerExitBarrier.test.ts` 对 reducer、final-view 和 chat-body-cache worker 检查收到结果后仍等待实际退出；`projectionBuildSupervisor.test.ts` 覆盖停机后释放租约与恢复 claim。合计 3 文件 32 项通过。
- 回退代码隔离演练：在临时 detached worktree checkout P1 兼容阶段 `887bfbc6`，运行旧读取器/缓存 reader 两个测试文件，21 项通过；删除临时 worktree，候选分支仍为 `codex/session-storage-boundary-refactor`、HEAD `011c330c`。没有改写当前分支历史或工作树。

## 候选 PKG

- 构建：`npm run prepare:rg -- --target=darwin-x64 --target=darwin-arm64`、`npm run build`、`npx electron-builder --mac pkg --arm64`。
- 完整 renderer/main 构建和三项边界门禁通过；Vite 仍报告已有的超 500KiB chunk 与 ineffective dynamic import 警告。
- 产物：`release/SpaceAssistant-0.2.9-arm64.pkg`，约 193 MiB。
- SHA-256：`35ab16d26de7f64da4bc1c190eb4e806376cd3e2beee134528e0f2753d722d27`。
- 没有可用的 Developer ID 证书；electron-builder 对应用执行 ad-hoc 签名并验证，但跳过 Developer ID 签名/公证。因此该文件是本机候选构建，不是可直接分发的签名安装包。

## 范围边界

- 已完成源码层旧路径回退、损坏缓存隔离、History 保留和 worker 关闭屏障验证，并产出本机 arm64 PKG。
- 未安装 PKG，未访问用户真实库，未测真实库 AC-7，未做真实 IM 并发；这些不由合成测试或包哈希替代。
- 若候选版本已经将数据库升级到 v116，恢复旧二进制前必须恢复 v115 备份/副本；不能仅替换应用包后复用已升级数据库。

