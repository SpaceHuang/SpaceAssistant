# P0 决策记录：托盘常驻前提（butler-agent-shortest-path-plan）

- 日期：2026-09-16
- 关联：`docs/develop/butler-agent-shortest-path-plan.md` §P0、§6 第 0 条

## 拍板

**选 a：保持现状 + 用户提示。**

- `window-all-closed` 语义不动（未启用托盘 → 退出，`electron/main.ts` 的 `window-all-closed` 分支保持原样）；「关窗后回合继续」与定时任务的运行前提即**托盘常驻启用**。
- 不静默替用户开托盘，也不改变退出语义（b 方案会让「关窗想退出」的用户被留在托盘，需要额外的退出说明与教育成本，收益不匹配）。
- `before-quit` 的取消与 run `interrupted` 标记（P6）保持「退出显式且干净」。

## 落地面

1. **主进程 → 渲染层状态暴露**：新增 IPC `app:get-tray-enabled`（`electron/appIpc.ts` 注册、`electron/main.ts` 注入 `isTrayEnabled`、`electron/preload.ts` + `src/shared/api.ts` 暴露 `window.api.appGetTrayEnabled()`）。
2. **设置页提示（P6 接线）**：创建定时任务时若 `appGetTrayEnabled()` 为 false，设置页「定时任务」Tab 明确提示「需要启用托盘常驻，否则关窗即退出、后台任务会中断」——提示在 UI 层实现，随 P6 任务管理 Tab 一并落地。
3. **调度器侧校验（P6 接线）**：`taskScheduler` 启动前校验托盘开关，未启用则不启动 tick 并记录 `automation.scheduler.disabled-no-tray`。

## 验收边界

- 自动化：无独立单测（本阶段只做状态暴露与声明；选项 b 的「活跃回合 → 不退出」判定单测随拍板 a 一并免除）。调度器托盘校验单测随 P6 交付。
- 手工冒烟（需真机，均以托盘启用为前提）：托盘启用 → 关窗进程存活；未启用托盘时关窗 → 进程退出 → run 落 `interrupted`（P6 后补验）。
