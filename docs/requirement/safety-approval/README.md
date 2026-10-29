# safety-approval（需求侧）—— 确认与授权、安全策略、脚本与路径安全

> 定位：安全、确认与审批的需求口径入口。实现侧现状与契约见 [`../../develop/safety-approval/`](../../develop/safety-approval/)（含 2026-10-29 归位的 8 篇安全策略三阶段契约）。
> 核对基线：`main` `17236274`（2026-10-14）；2026-10-29 补入口时**未重跑**断言核验（重跑流程见 `docs/rules/docs-guide.md` §6.5）

## 需求基线与现行需求

- [需求基线.md](./需求基线.md) —— 当前生效口径。
- [tool-confirmation-top-level-design-v2.md](./tool-confirmation-top-level-design-v2.md) —— 工具确认与授权顶层设计 v2（A 类）：覆盖桌面聊天、微信、飞书、自动任务/定时任务所有链路；定时任务权限派生与整批确认见 §5.6。
- [security-policy-single-entry-requirement.md](./security-policy-single-entry-requirement.md) —— 安全策略单一入口（A 类，口径仍在生效）。
- [custom-policy-full-control-requirement.md](./custom-policy-full-control-requirement.md) —— 自定义套餐全动作控制（A 类需求；开发/执行方案见 [`../../develop/safety-approval/in-flight/`](../../develop/safety-approval/in-flight/)）。

## 在途（in-flight）

**需求侧当前无在途项**；在途方案（工具审核缓存、自定义套餐、拒绝可诊断性、定时任务多目录与预检）登记在开发侧 in-flight。

## 归档

- 需求原件 → [`../archive/safety-approval/`](../archive/safety-approval/)（3 件：确认卡片信任、shell 安全增强、审批并发与可观测性）。
- 开发侧过程件（安全策略三阶段 Phase 0–5）见 [`../../develop/archive/safety-approval/`](../../develop/archive/safety-approval/)。

## 取证命令

```text
git log --date=short --format='%ad %h %s' -- electron/confirmation electron/capabilities electron/writeSafety
rg -n 'safetyPolicy|askRule|autoApprove|systemInvariantRegistry' electron/confirmation electron/capabilities src/shared
```
