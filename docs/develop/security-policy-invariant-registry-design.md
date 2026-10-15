# System Invariant Registry 设计（P3-01 / P3-02）

## 唯一源码入口

唯一注册表为 `src/shared/security/systemInvariantRegistry.ts` 导出的 `SYSTEM_INVARIANT_REGISTRY`。它是源码审查和架构门禁的元数据输入，不被 Policy Engine、gate、executor 或用户设置读取，不具有运行时优先级，也不产生 allow/confirm/deny。locked 产品规则继续由 `DEFAULT_POLICY_RULES` 与 Policy Engine 管理。

## 注册项契约

每项提供唯一 ID、owner、stage、category、理由、不可配置依据（decision-floor 必填）、effect、范围、审计事件、测试文件引用和 overrideability。`validateSystemInvariantRegistry` 校验 ID 格式/唯一性、必填字段、枚举、测试引用与 decision-floor 的不可配置说明；校验失败阻断架构测试，不参与请求处理。

## 变更流程

新增系统不变量时：先说明它为何不是普通 policy rule；选择负责阶段与类别；注册实际实现范围、稳定 audit event 与边界测试；通过 registry 测试和策略出口架构测试；若实现删除，同一变更清理登记项和测试引用。registry ID 只做追踪，不会为代码分支自动豁免 P2-09/P3-05 检查。

## 当前状态

schema 与校验器已完成，注册表首版暂为空。P3-03 将依 P0 盘点和 P2 locked-rule 分类逐项登记经确认的 admission、identity、integrity、capability、lifecycle invariants；不得将策略型规则搬进来充数。

证据：`src/shared/security/systemInvariantRegistry.test.ts`、`src/shared/security/executionAuthorizationCheck.test.ts`。
