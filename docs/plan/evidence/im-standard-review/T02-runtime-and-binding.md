# T02 版本加载与回执依赖证据

- 基线：`b293294e`（T00/T01 阶段提交；代码基线 `30ebf315035375e02f8067e4482ec25e85be4014`）。
- 环境：Node `v26.4.0` / npm `11.17.0`；`npm ci` 成功，锁文件未变。首次运行 Electron 测试遇到二进制目录半安装；按包提示执行 `node node_modules/electron/install.js` 后可加载。assembler 首次测试因 workspace `@spaceassistant/agent-provider-pi-ai` 尚未构建；执行 `npm run build:agent-provider-pi-ai` 成功后恢复。以上均为环境准备，非 RED。
- 验收命令：`npm exec vitest run electron/confirmation/policyRulesRuntime.test.ts electron/confirmation/agentSdkSafetyPolicy.test.ts src/shared/policy/policyBehaviorVersion.test.ts electron/confirmation/imPolicyStore.test.ts electron/confirmation/toolCallGate.test.ts electron/runtime/invocationAssembler.test.ts`
- 退出码：0；6 files passed，342 tests passed。
- 覆盖证据：旧版 v1.6 快照行为、v2 版本化候选装配、未知版本和 malformed/missing snapshot fail closed、规则覆盖与旧 disabled 迁移边界、存储 revision 与原子快照、审批策略依赖变化使授权版本改变；policy fingerprint 忽略不匹配规则而新匹配 deny 会改变决策依赖；assembler 在 hosted recheck 时拒绝目标材料变化。
- 生产候选隔离：runtime 与 assembler 持续仅接受 `im-v1.6`、`im-standard-v2`；`im-standard-v3` 未加入 resolver 或支持版本白名单，也未改新安装初始化。未发布构建不会加载候选。
- T02 RED：无。现有边界满足本任务判据；未发现目标行为缺口。
- 改动：仅计划证据；本任务未修改策略加载或执行代码。

## T03 迁移 dry-run 与故障证据

- 命令：`npm exec vitest run electron/confirmation/imPolicyStore.test.ts electron/confirmation/legacyImMigrationMatrix.test.ts`
- 退出码：0；2 files passed，13 tests passed。
- 新增测试 `legacy IM migration matrix > dry-runs unready release, incomplete legacy fields, and unresolvable channel conflicts without writing a database`：纯函数测试门禁模型在 releaseReady=false 时不调用映射；门禁假设满足时，未知版本和渠道版本冲突失败关闭；缺少 optional `standard` 数据按规划器现有兼容默认值映射。它不调用生产 startup migrator，也不写数据库。
- 故障窗口复用现有 `imPolicyStore.test.ts` 测试库：旧快照坏数据拒绝、缺快照重开拒绝、revision 冲突保留 winner、审计/迁移写入失败回滚、迁移成功后重复调用幂等；`legacyImMigrationMatrix.test.ts` 验证微信/飞书 v1.6 standard 迁移重启后保持 ask 规则。
- RED：无。dry-run 和现有故障边界均通过；无 T15 生产迁移器依赖、生产数据库访问或迁移完成标记。
