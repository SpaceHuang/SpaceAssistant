# main 代码评审（2026-09-29）

## 范围与结论

- 基线：`origin/main..main`，评审提交为 `8cd0c331`，本地 `main` 超前 11 个提交。
- 结论：**阻断**。以下问题在当前 `main` 上复现，需修复后重新运行检查。

## 阻断问题

### 1. Electron 构建无法通过（Critical）

`npm run build:electron` 在依赖安装完成后以 TypeScript 错误退出，桌面主进程不能产出有效构建：

- `electron/claudeStreamHandlers.ts:12` 从 `toolChatLoop` 导入 `DESKTOP_TOOL_LOOP_MAX_ROUNDS`，但该模块没有导出它（TS2305）。调用点在第 477 行，需恢复单一的轮次上限定义及导出，或改从真实来源导入。
- `electron/toolChatLoop.ts:803,806` 使用 `createHash`，但没有导入（TS2304）。应从 `node:crypto` 导入；否则即使跳过类型检查，工具结果日志路径也会抛 `ReferenceError`。
- `electron/tools/builtinExecutors.ts:506` 在第 503 行已处理 `read-directory-cancelled` 并返回，后续再次比较同一值构成不可达分支（TS2367）。移除该分支并保留明确的目录读取失败映射。

上述 4 条编译错误属于同一构建阻断，修复后需重新执行 `npm run build:electron`。

### 2. SDK 入口与包边界护栏直接冲突（Required）

`packages/agent-sdk/src/index.ts:49` 用 `export *` 暴露 `src/shared/agent/invocation.ts`。该文件继续导入多项 `src/shared/**` 模块，而新增的 `scripts/check-agent-sdk-boundary.mjs:68-69` 明确规定 SDK 入口闭包不可达 `src/shared`。运行 `npm run check:agent-sdk` 稳定失败，列出 28 个宿主模块。应将公开契约迁入 SDK 包内，或调整入口及边界设计，使实现与所声明的检查规则一致；随后验证 `npm run check:agent-sdk` 通过。

## 验证记录

- `npm run typecheck:renderer`：通过。
- `npm run typecheck:shared`：通过。
- `npm run build:electron`：失败，错误如上。
- `npm run check:agent-sdk`：失败，错误如上。
- `npm test`：运行期间出现多项失败，包括 `claudeStreamHandlers.hostedIntegration.test.ts` 的 7 项、`registeredAgentTurnTools.test.ts` 的 1 项，以及 SQLite 相关测试的批量失败；因首次安装跳过了原生依赖 postinstall，结果不能可靠归因于代码，故中止全量测试。随后尝试正常安装依赖，但磁盘仅余约 118 MiB，`npm install` 因 `ENOSPC` 和依赖解析错误未完成。测试状态为**未完成**，不能据此判定额外代码阻断。

评审聚焦可复现的阻断问题；对大范围架构迁移未宣称穷尽审查。
