# T01 旧版本合同证据

- 基线提交：`30ebf315035375e02f8067e4482ec25e85be4014`
- 依赖：`npm ci` 成功；Node `v26.4.0`、npm `11.17.0`、锁文件 SHA-256 `872fb2c13fd3e55d24f41f8a83c506fffe4f3a4ffee1c520374d4929a0990d05`；锁文件无变更。
- 命令：`npm exec vitest run src/shared/policy/defaultRules.contract.test.ts src/shared/policy/imPolicyBehaviorResolvers.test.ts src/shared/policy/policyPackages.scope.test.ts`
- 退出码：0；3 files passed，20 tests passed。
- 已核实：`im-v1.6` resolver 对输入规则 `structuredClone`，不会套用当前候选动作；`im-standard-v2` 才应用显式 `imEffectiveActionFor` 映射。未知版本抛错。resolver map 不含 `im-standard-v3`。
- 运行时：`policyRulesRuntime.ts` 与 `invocationAssembler.ts` 的支持版本白名单仅含 `im-v1.6`、`im-standard-v2`；现有调用按版本限定使用 resolver。默认 floor 来源为 `DEFAULT_POLICY_RULES` 的 locked 规则。
- 测试已固定 v2 的动作向量、v1.6 对自定义 `allow` 动作的精确保留、未知版本 fail closed，以及 strict/custom 保留 floor。规则全集合同与 lane/package scope 合同通过。
- RED：无。当前行为已覆盖 T01 合同，不人为制造失败。
- 候选生命周期：本任务未新增 v3 代码；生产 resolver/runtime 无 v3 注册，满足候选不可生产加载的当前状态。
