# 验收证据

日期：2026-09-24

## 自动化门禁

- `npm test`：708 个测试文件通过、1 个跳过；5215 个测试通过、104 个跳过。
- 聚焦 TDD 集：run shell plan/executor/host degrade、TUI 判定与投影、renderer 展示、turn coordinator/storage 共 274 个测试通过。
- `npx tsc -p tsconfig.electron.json --noEmit`：通过。
- `npm run typecheck:shared`：通过。
- `npm run typecheck:renderer`：通过。
- `git diff --check`：通过。

## 计划门禁对应

- G1/G2：`shellInteractiveTui.test.ts`、`runShellPlan.test.ts`、`runShellExecutor.test.ts`、`processResultProjection.test.ts` 覆盖 match/clear/undetectable、六种原因、诊断与 telemetry 丢弃。
- G4：`ToolCallCard.test.tsx` 与 `ShellConfirmCard.test.tsx` 覆盖结果驱动展示、确认前不显示 TUI 提示和历史错误入口。
- G5：`runShellPlan.test.ts` 与 `runShellExecutor.test.ts` 覆盖输出模式冻结、重验证、PLAN_STALE、raw/plain progress 及终端模式。
- G6：`turnCoordinator.test.ts`、`turnCoordinatorStorage.test.ts`、`operations.test.ts` 覆盖 cancelled checkpoint、恢复补偿、截断读取和迟到 source 保护。
- G3 的真实会话证据见 `session-ced59b41-g3-manual-evidence.md`。
