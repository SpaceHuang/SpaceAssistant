# P3-02 构建发布与恢复协议

日期：2026-10-27  
状态：已完成本机源码范围；旧会话来源回填和生产按页读取尚未接通。

## RED / GREEN

- RED：新增的 `projectionService.test.ts` 用例验证 cache 发布同时保存 paged blob references。初次运行时 cache 状态可发布，但引用表没有对应记录；实现 state-store 原子保存后转为 GREEN。
- RED：`projectionSourceIdentity.test.ts` 新增 source revision 断言，初次运行显示 source identity 未包含该字段；将 v116 source revision 纳入 identity 后转为 GREEN，并验证 History 写入递增 revision。
- GREEN：Worker 端 v4 块/目录构建、manifest 校验、coordinator lease 发布、空会话、旧 lease、unknown commit 和 GC 生命周期测试均通过。

## 发布与恢复不变量

- chatBodyV1 v4 使用独立 scope key；v3 的 legacy payload 仍由原路径生成。
- Worker 逐条遍历最终消息，按 64 条/256 KiB 形成正文块，在 Worker 写入不可变临时 blob；序号目录、ID 目录引用最终 locator，主进程验证 staging locator、长度和摘要后 promote。
- manifest 不超过 256 KiB 时随 cache inline 发布；更大 manifest（例如 source identity 中有很多 invocation stream）也由 Worker 写入并随同一 staging fence promote，使用 `body-manifest` 引用与 cache blob root 绑定，避免主线程二次写入时重入 blob fence。
- `service.publish()` 在同一 SQLite 事务中 CAS lease/state、发布 manifest cache row 并替换完整 blob-reference 集合。事务失败时 cache 与 references 一起回滚；失效 lease 不产生引用。
- Worker artifacts 的 blob fence 保持到发布协调完成。进程在事务提交前退出时，文件没有数据库根，可由 GC 回收；提交结果不明时，coordinator 读取持久 state 核实是否成功。
- GC 校验 paged block、sequence/ID directory、逐消息 source fragment 和 invocation source manifest 的 locator、字节数与摘要。存在缺失/坏引用时 fail closed；删除引用行后孤块进入有界回收。
- source revision 纳入 projection source identity，避免 canonical History 变化后继续发布旧版 body manifest。
- 空会话发布零 blob manifest，并通过分页 reader 返回空页；按 ID 请求仍报告缺失。

## 验证

```text
npm exec vitest run electron/database/migrations.sessionBodyLocator.test.ts electron/sessionStorage/application/projectionService.test.ts electron/sessionStorage/application/projectionBuildCoordinator.test.ts electron/sessionStorage/infrastructure/sqlite/projectionSourceIdentity.test.ts electron/sessionStorage/infrastructure/sqlite/projectionHistoryChunkReader.test.ts electron/sessionStorage/infrastructure/sqlite/sessionProjectionBlobStore.test.ts electron/sessionStorage/infrastructure/sqlite/pagedChatBodyStore.test.ts electron/sessionStorage/infrastructure/sqlite/projectionPagedBodyWriter.test.ts electron/sessionStorage/infrastructure/sqlite/projectionFinalViewWorkerClient.test.ts --reporter=dot
9 files passed; 78 tests passed; 0 failed
```

```text
npm run build:electron:incremental
通过：pi-ai runtime closure、session-storage cleanup/module graph 门禁（31 项 illegal-edge probes）、agent provider 构建及 electron TypeScript 编译。
```

## 尚未关闭的相邻任务

P3-02 只接通新版缓存产物的构建和发布。SQLite 逐消息来源定位记录的 Worker 回填、来源依赖归约及读取器按页查询仍由 P3-03、P3-04 验收；当前生产读路径尚未使用 v4，不能据此声明会话切换性能目标已达成。
