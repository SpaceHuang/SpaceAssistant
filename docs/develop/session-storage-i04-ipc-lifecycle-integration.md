# I-04 IPC 安全与 session 生命周期集成记录（2026-10-05）

## 集成边界

- 目录选择/授权撤销模块来自 `origin/main`，A-09 已用字节摘要核实相同；当前分支复用这些文件，不重写第二套 UI/API/授权实现。
- session IPC 同时保留 main 的 trusted sender 检查、renderer metadata 去伪、目录授权查询/创建/撤销与 storage 的 canonical lifecycle、删除事务、spill root fence 和 GC 唤醒。
- session 删除时先在 spill-root fence 内提交 DB 删除；失败不触发 GC 唤醒。成功提交后再唤醒 source-truth spill GC。数据库删除本身的事务回滚继续由 operations/GC ledger 测试证明。
- I-12 必须保持清理发布 gate 默认关闭；I-04 不放行 C-on 或真实 profile 操作。

## 测试隔离修正

`electron/appIpc.sessionUpdate.test.ts` 的 GC 唤醒顺序测试之前令 `getUserDataPath()` 返回 `/tmp`，真实 spill-root fence 会访问共享 `/tmp/spill`。将测试路径改回 `/fake/userdata` 并 mock `createSpillStore.withSpillRootFence`，只测试 IPC 调用顺序；其它 spill 数据库函数保留真实实现。这样测试不触碰既有临时目录。

## 验收映射

- 未授权 sender 在读取 session 前被拒绝：`appIpc.sessionUpdate.test.ts`。
- session:create/update 不能通过 renderer metadata 伪造或覆盖授权记录：同上。
- directory grant path 规范化、敏感路径拒绝、撤销、目录替换/identity drift 后变 invalid：`sessionDirectoryGrants.test.ts`、`src/shared/sessionDirectoryGrant.test.ts`。
- session 删除事务内 spill-GC todo 注册失败时回滚 session 删除：`operations.test.ts`、`spillStore.test.ts`。
- DB delete 失败不唤醒 GC，成功后唤醒一次：IPC test。
- 维护 IPC 注册仍走受控 production boundary；C-on 授权未完成，默认关闭。

## 验证

- 5 个定向测试文件 160 项通过。
- `npx tsc -p tsconfig.electron.json --noEmit`、`npm run typecheck:shared`、`git diff --check` 通过。
- A-09 核验的 `electron/sessionDirectoryGrants.ts` 与 `src/shared/sessionDirectoryGrant.ts` 仍为 `origin/main` 完全相同内容；未将其重写。
- 未访问用户 profile、`/tmp/spill` 内容或真实会话；所有 DB 行为测试使用 memory/临时 SQLite。

## 后续集成复核（I-09）

I-04 的 session IPC/grant metadata 生命周期结论有效；但“复用目录授权模块”不代表 composer 和工具执行链已完成。当时 composer plus-menu、directory-grant preload/API bridge，以及 invocation→tool gate→read permit→executor 的 active grant 复核仍缺失。该漏项在 I-09 复核中发现并按 `origin/main` 提交 `810d38e2` 补齐，详见[I-09 集成记录](./session-storage-i09-composer-directory-grant-integration.md)。

## 状态

I-04 自身 IPC/session lifecycle 切片完成；composer directory-grant 的完整 renderer→tool 链由后续 I-09 完成。
