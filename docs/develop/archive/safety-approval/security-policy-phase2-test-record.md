# Phase 2 测试记录

日期：2026-10-15。工作目录：`.worktrees/security-policy-three-stage`。实现采用先加回归再改规则/适配层；相关测试通过后按阶段门槛执行全量测试。

## 定向验证

- policy / SDK / remote 合并集合：6 个 Electron 文件、386 项通过；4 个 Renderer 文件、99 项通过。
- 新增 locked-floor 分类回归：locked 默认规则全集均在分类文档中出现。
- 主进程与渲染进程 `tsc --noEmit`、`npm run typecheck:shared`、`npm run i18n:check`：通过。
- 新增 P2-10 host recheck 与 SDK recheck 回归：验证 broad authorization snapshot 改变后重新调用 gate，且参数、调用身份、facts、对象和新决策依赖仍需相同；依赖变更不沿用原批准。
- `git diff --check`：通过。

## 全量测试（阶段门槛）

执行 `npm test`，退出码 1；Vitest duration 759.59s：14 个文件失败、1060 通过、1 skipped；160 个测试失败、9975 通过、111 skipped。随后修正 `invocationAssembler.test.ts` 中一条仍期待旧的审批后拒绝行为的断言，相关定向测试通过；全量统计未包含该修正后的重跑结果。

与 Phase 1 基线（15 个文件 / 159 个失败）对照，发现本阶段显式规则漏填 `denyClass`，已补齐并由 `defaultRules.lint.test.ts` 通过。剩余失败集中在 Hosted/API key 测试凭据、checkpoint/SQLite/revocation 集成时序、环境注入 prompt、性能比例断言及既有 IM recheck 用例；其中 WeChat Hosted “自动审批阈值变化”和“审批期间新建目标”在原始主工作树也可复现。执行检查阶段继续追踪授权竞态相关失败。全量测试退出码为 1，不声明全量通过。

## 阶段结论

本阶段新增/修改的核心策略、facts 边界、locked 分类、单一决策来源、SDK recheck 相关定向集合通过；全量 suite 保留基线失败并新增明确记录。P2 源码关闭不代表已完成真实 IM/MCP 或正式包验收。
