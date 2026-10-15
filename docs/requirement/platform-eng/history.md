# platform-eng 需求口径变更历史

> 记录本主题**需求口径**的演进（正序）。实现侧见 [`../../develop/platform-eng/history.md`](../../develop/platform-eng/history.md)。

## 时间线

| 日期 | 需求 | 口径变化 | 对应实现 |
| --- | --- | --- | --- |
| — | `i18n-architecture-requirement` | 多语言架构：`zh-CN` 为 key 真实来源，类型自动推导 | `npm run i18n:generate-types` / `i18n:check` |
| 2026-05-31 | `remove-background-task-mechanism` | 移除后台任务机制（自述已完成） | 后台任务目录与机制下线 |

## 取证命令

```text
npm run i18n:check
git log --date=short --format='%ad %h %s' -- scripts src/renderer/i18n
```
