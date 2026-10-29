# storage-session（需求侧）—— 会话存储、消息事实、标题与列表

> 定位：会话与数据的需求口径入口。实现侧见 [`../../develop/storage-session/`](../../develop/storage-session/)。
> 核对基线：`main` `17236274`（2026-10-14）；2026-10-29 补入口时**未重跑**断言核验（重跑流程见 `docs/rules/docs-guide.md` §6.5）

## 需求基线与现行需求

- [需求基线.md](./需求基线.md) —— 当前生效口径（会话自动/手动标题、列表待确认徽标、消息事实生产链路、workdir 边界与沙箱策略分层、`session-ced59b41` 专题）。
- 本目录无独立留存的 A 类需求原件：全部口径已并入需求基线，原件在归档。

## 在途（in-flight）

**当前无在途项**；在途方案（持久化与历史管理边界重构、启动历史会话恢复耗时）登记在开发侧 [`../../develop/storage-session/in-flight/`](../../develop/storage-session/in-flight/)。

## 归档

- 需求原件 → [`../archive/storage-session/`](../archive/storage-session/)（6 件：会话标题、列表徽标、消息事实链路、workdir 边界分层、`session-ced59b41` 问题清单）。
- 旧路径 → 新路径：见 [`../archive/INDEX.md`](../archive/INDEX.md)。

## 取证命令

```text
git log --date=short --format='%ad %h %s' -- electron/sessionStorage electron/storage electron/database
rg -n 'messageFact|canonicalFact|sessionTitle' electron/sessionStorage electron/storage
```
