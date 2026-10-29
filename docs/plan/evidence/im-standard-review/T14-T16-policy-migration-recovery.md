# T14–T16 策略迁移、回退与恢复证据

- 日期：2026-10-30（Asia/Shanghai）
- 基线：审批记录已在 `37668442 docs: record IM rollback format approval` 落档；代码阶段基线为 `4c14bd1c`。本阶段仍在隔离分支 `codex/im-standard-review-execution`。
- 规格：技术方案 §9、AC-07a/07b、AC-08；仅完成本机存储/启动边界，未启用生产 v3。
- 批准：`docs/plan/evidence/im-standard-review/AP-format-approval.md`。

## T14 旧快照回退与显式重新启用

- RED：首次运行 `npm exec vitest run electron/confirmation/imPolicyStore.test.ts`，4 项新契约用例失败、原有 10 项通过。失败分别显示缺少受控回退 API、普通写入丢失抑制字段、损坏字段被接受、revision/重新启用边界无法核验。
- GREEN：同文件通过 14 项。增加 `automaticMigrationSuppressedVersions` 结构校验；普通写入在事务内保留数据库当前值并忽略普通输入对字段的伪造/删除；受控回退原子切换旧版本、添加 v3 抑制 ID 和审计；显式重新启用需完整发布门禁，在同一事务切换 v3、移除 ID、递增 revision 并审计。通用写入拒绝直接写 v3。
- 失败注入：审计前异常回滚快照、revision、epoch、撤权和审计；损坏字段、非数组、重复 ID 和未知行为版本均 fail closed；revision 竞争返回 conflict。
- IPC 边界：普通 `policy:write` 改套餐时保留抑制状态，调用方不能通过 change payload 清除字段；未发布 IPC 白名单拒绝加载 v3。

## T15 启动迁移与新安装

- RED：先运行 `npm exec vitest run electron/confirmation/legacyImConfigBoundary.startup.test.ts`，自动迁移和新安装 v3 两项新用例失败（2 failed / 19 passed），显示现有启动路径没有受门禁的 v3 迁移/初始化。
- GREEN：仅在 `publishedV3Ready`、`fixedRuleSetVerified`、`restrictionMappingVerified` 三项均为 true 时，标准套餐可迁移；保留现有快照字段和限制，记录迁移来源与审计。custom/strict/loose 不迁移；包含 v3 抑制 ID 时跳过且不写迁移审计；缺失或损坏状态不会作为空数组处理。新安装仅在完整门禁下建立 v3 标准快照。
- 未发布约束：`electron/main.ts` 的生产启动调用不传 release gate；新安装默认保持旧行为。`electron/ipc/policyIpc.ts` 的生产版本白名单仍只有 `im-v1.6`/`im-standard-v2`；候选 v3 不能经生产 IPC 读取或用户配置写入激活。正式 release artifact / gate 绑定仍属于后续发布阶段。

## T16 回退与恢复演练

- 整合测试：`electron/confirmation/imPolicyMigrationRecovery.test.ts` 在本机数据库演练：v2 → 门禁迁移 v3 → 创建的旧 deferred todo 被失效 → 回退 v2 → 两次重启及同一启动迁移器再次运行 → 普通配置保存 → 显式重新启用 v3 → 再次回退 → 旧 revision 冲突 → 审计前失败注入 → 重启保持 v2 与抑制字段。集成用例首次运行为 GREEN；没有为制造 RED 而注入临时错误，相关失败 RED 已由 T14/T15 契约测试记录。
- 未访问真实用户数据库；“同系列升级”由相同启动入口重复演练，不是另一版本安装包升级测试。

## 阶段验证

- RED/GREEN 与最终合并定向命令：`npm exec vitest run electron/confirmation/imPolicyStore.test.ts electron/confirmation/settingsAudit.test.ts electron/confirmation/legacyImConfigBoundary.startup.test.ts electron/confirmation/policyRulesRuntime.test.ts electron/remote/deferredPolicyReevaluation.test.ts electron/remote/deferredResumeCoordinator.test.ts electron/confirmation/imPolicyMigrationRecovery.test.ts electron/ipc/policyIpc.test.ts`，退出码 0；8 files / 97 tests passed。
- `npm run typecheck:shared`：退出码 0。
- `npx tsc -p tsconfig.electron.json --noEmit --incremental false`：退出码 0。
- `npm run build:electron:incremental`：退出码 0；pi-ai runtime closure、session-storage cleanup/module-graph 检查及主进程编译通过。本阶段未重复运行增量构建。
- `npm run check:system-invariant-registry`：退出码 0；12 registrations、42 references，正反向 fixtures 通过；未新增系统 invariant。
- `git diff --check`：退出码 0。
- 兼容性限制：未用旧二进制做真实降级/字段保留验证，因此按已批准策略，不能据此允许降级；该限制不影响本机候选源码完成，也不代表旧版本兼容已验证。
