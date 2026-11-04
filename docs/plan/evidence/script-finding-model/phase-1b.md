# 阶段 1b：确认卡片 — 关闭证据

## 结果

- 阶段实现提交 SHA：`90a04eeebd963bd1fcbc5635abc91fdde3c74092`
- 阶段依赖：F00 `317d5789`、1a 实现 `2c6d4a29`、1a 回退证据 `f76a4479`
- 阶段任务：F10、F11、F12
- 任务证据：[`F10.md`](F10.md)、[`F11.md`](F11.md)、[`F12.md`](F12.md)
- 全量结果：1,257 test files passed / 1 skipped；12,192 tests passed / 140 skipped。

## 阶段提交文件清单

由 `git show --format= --name-only 90a04eeebd963bd1fcbc5635abc91fdde3c74092` 复核的精确文件清单：

```text
docs/plan/evidence/script-finding-model/F10.md
docs/plan/evidence/script-finding-model/F11.md
docs/plan/evidence/script-finding-model/F12.md
docs/plan/evidence/script-finding-model/phase-1b.md
docs/plan/script-finding-model-execution-plan.md
electron/runtime/invocationAssembler.test.ts
electron/runtime/invocationAssembler.ts
src/renderer/components/Chat/ScriptConfirmCard.test.tsx
src/renderer/components/Chat/ScriptConfirmCard.tsx
src/renderer/i18n/resources/en-US/chat.json
src/renderer/i18n/resources/zh-CN/chat.json
src/renderer/i18n/types.ts
src/renderer/theme/layout.css
src/shared/assistantFactAggregator.test.ts
src/shared/assistantFactAggregator.ts
src/shared/domainTypes.ts
```

## 回退顺序

1. 回退本阶段提交，撤销 findings 从确认事实事件到 renderer 工具记录的投影，以及确认卡列表与 i18n 展示。
2. 保留 1a 所有分析与安全策略功能；验证旧确认请求字段缺省时仍可渲染。
3. 若回退 1a，再单独回退 1a 实现提交及其分类目录登记；不得用 1b 回退替代 1a 回退。

## 隔离回退 smoke

在 detached worktree revert 本阶段实现提交，运行 `ScriptConfirmCard.test.tsx` 与脚本分析相关 smoke，并补记结果及临时 worktree 清理状态。
