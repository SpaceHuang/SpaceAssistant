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

在 detached worktree `/Users/space/Documents/Develop/SpaceAssistant/.worktrees/script-finding-model-revert-1b` 对阶段实现提交 `90a04eeebd963bd1fcbc5635abc91fdde3c74092` 执行 `git revert --no-edit`，隔离回退提交为 `089b87cb0f75ca6ea47bfb787f0b0d99de13f26a`。回退后运行：

```text
npm exec -- vitest run src/renderer/components/Chat/ScriptConfirmCard.test.tsx electron/shell/scriptIr/pythonAdapter.test.ts electron/shell/scriptContentSecurity.test.ts electron/shell/scriptGolden.test.ts src/shared/policy/lockedFloorClassification.test.ts
```

结果：5 files / 205 tests passed。旧请求缺失 findings 字段时确认卡原有渲染测试通过；1a 的 IR、发现与 locked-floor 行为仍可用。临时 worktree 已验证干净并移除。
