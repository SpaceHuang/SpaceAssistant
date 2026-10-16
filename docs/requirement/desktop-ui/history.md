# desktop-ui 需求口径变更历史

> 记录本主题**需求口径**的演进（正序）。实现侧见 [`../../develop/desktop-ui/history.md`](../../develop/desktop-ui/history.md)。

## 时间线

| 日期 | 需求（版本） | 口径变化 | 对应实现 |
| --- | --- | --- | --- |
| 2026-05-16 | `file-content-viewer-requirement`（v1.1） | 文件查看器基础 | — |
| 2026-05-18 | `referenced-files-requirement`（v1.0） | 引用文件展示 | — |
| 2026-05-24 | `context-usage-ring-requirement`（v1.0） | 上下文占用环 | 后被 v2 取代 |
| 2026-05-24 | `context-usage-estimated-occupancy-requirement`（v1.1） | 估算占用 | — |
| 2026-05-26 | `composer-hint-responsive-requirement`（v1.0） | composer 提示自适应 | — |
| 2026-05-30 | `settings-ui-refinement-requirement`（v1.0） | 设置页细化 | — |
| 2026-06-01 | `detail-panel-file-list-requirement`（v1.2） | 详情面板文件列表 | — |
| 2026-06-03 | `multi-workdir-requirement`（v1.0）、`content-viewer-url-support-requirement`（v1.0） | 多工作目录、查看器 URL 支持 | — |
| 2026-05-30 | `remove-plan-mode-requirement`（v1.1） | **移除 Plan 模式**（现行口径） | 后续需求文档据此废弃 |
| 2026-05-31 | `remove-plan-mode-requirement` 生效后 | Plan 模式 4 篇需求全部废弃（D 类） | — |
| 2026-06-07 | `context-usage-ring-v2-improvements`（v2.0） | 占用环 v2（取代 v1.0） | — |
| 2026-06-08 | `markitdown-document-import-requirement`（v1.2） | 文档导入 | — |
| 2026-06-10 | `global-search-find-requirement`（v1.1） | 全局搜索 | — |
| 2026-06-15 | `file-content-viewer-auto-reload-requirement`（v1.2） | 查看器自动重载 | — |
| 2026-06-19 | `file-viewer-markdown-table-requirement`（v1.1） | Markdown 表格渲染 | — |
| 2026-07-18 | `file-tree-auto-refresh-requirement`（v1.1） | 文件树自动刷新 | — |
| 2026-09-30 | `composer-model-thinking-entry-requirement`（已定稿） | composer 模型/思考入口 | 实施完成并留验收证据 |
| 2026-10-03 | `composer-plus-menu-requirement`（v1.0） | composer 加号菜单 | `810d38e2` |
| 2026-10-16 | `product_requirement.md` | 平台支持范围收敛为 Windows/macOS；撤销 Linux 用户支持承诺 | 移除 AppImage 打包配置与入口 |
| 2026-10-03 | `scheduled-task-output-directory-model-requirements` | 定时任务输出目录/模型（**在途**） | 未见实现 |
| — | `system-tray.md` | 托盘（**在途**，自述待实现） | — |

## 已废弃（D 类）

Plan 模式 4 篇 + `file-write-directory-layout-requirement`（被工作产物管理取代），见 [`../archive/INDEX.md`](../archive/INDEX.md)。

## 取证命令

```text
git log --date=short --format='%ad %h %s' -- src/renderer/components src/renderer/store
```
