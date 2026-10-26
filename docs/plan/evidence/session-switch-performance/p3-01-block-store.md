# P3-01 正文块存储与验证读取器

日期：2026-10-27  
阶段：P3-01，源码存储层；未接生产读取入口或 SQLite 发布表。

## RED / GREEN

- RED：在 `pagedChatBodyStore.ts` 只有未实现接口时运行 `npm exec vitest run electron/sessionStorage/infrastructure/sqlite/pagedChatBodyStore.test.ts --reporter=dot`；3 项行为测试失败，均进入 `PAGED_CHAT_BODY_NOT_IMPLEMENTED`。首次因模块尚不存在而加载失败的探测不计作 RED。
- GREEN：同一文件实现后，4 项通过。再与现有 blob store 和 test-only reducer 原型一起运行，结果为 3 files / 35 tests passed：

```text
npm exec vitest run electron/sessionStorage/infrastructure/sqlite/pagedChatBodyStore.test.ts electron/sessionStorage/infrastructure/sqlite/sessionProjectionBlobStore.test.ts electron/sessionStorage/pageBodyReadPrototype.test.ts --reporter=dot
3 files passed; 35 passed; 0 failed; 4.56s
```

## 覆盖

- 按 `beforeSequence` 读取 20 条与按 message ID 读取；1000 条合成消息下，目标读取分别最多访问 12 / 8 个目录或正文 blob，测试未读取整份 ID 清单。
- 写入前拒绝重复 message ID、重复 sequence 和不匹配的 source identity；manifest 绑定 session generation、spec version、source revision、message revision、source identity、History watermark、消息范围、计数和两棵索引根。
- 正文块以 UTF-8 JSON 字节计量，最多 64 条或 256 KiB；单条超限正文独立成块。测试检查普通块不越 256 KiB，300 KiB 单条块仅含一条消息。
- 错摘要、目录损坏、正文块截断/缺失、越界 ID locator、非法页大小与 manifest fence 不匹配均 fail closed。
- 所有产物使用 `withWorkerStaging` 的 blob fence 和逐文件 promote；调用者发布 SQLite 引用后释放 fence。失败产生的已 promote blob 不可通过未发布 manifest 读取，由后续 GC/recovery 阶段处理。

## 格式与限制

生产存储层当前使用正文块上限 64 条/256 KiB、内部目录 fanout 8、message ID 叶节点最多 512 项。相较早期原型的 8 条块，64 条减少小消息场景的物理 blob 数；现有测试证据不是跨硬件基准，不能作为 AC-7 性能通过结论。最终值由 P3 性能专项继续核对。

当前产物 manifest 是写入者内存返回值，未写入 SQLite、未纳入 GC 引用根，也未接 build owner / 分代发布。并发发布、进程崩溃、孤块回收和旧库回填在 P3-02 及后续任务完成前仍未通过。
