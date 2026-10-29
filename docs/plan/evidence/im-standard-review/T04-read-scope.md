# T04 目录外读取候选进展

- 基线提交：`04d6dcab`；本任务未提交。
- 初始命令：`npm exec vitest run electron/confirmation/toolCallGate.test.ts electron/confirmation/readExecutionPermit.test.ts electron/confirmation/readPermitExecutor.test.ts electron/confirmation/readExecutionBoundary.test.ts`；退出码 0，4 files / 208 tests passed。
- RED：新增范围 token 测试首次运行失败，gate facts 未包含读取范围；这是目标事实缺失，符合 RED。
- GREEN：`FactSignal` 新增 `read-target-scope`（single-target / direct-entries / subtree）；`toolCallGate` 根据实际探测目标类型与工具产生该事实；policy engine 将其映射为可匹配 token。重跑 `npm exec vitest run electron/confirmation/toolCallGate.test.ts -t='stable read scope token'` 退出码 0，175 tests passed（含该用例）。`npm exec vitest run src/shared/policy/policyEngine.test.ts` 退出码 0，124 tests passed。
- 未通过的候选集成试验：仅在测试输入中替换 `remote-outside-read-deny` 并添加 agent review 规则后，gate 返回 `rules-violated`。原因是 `validatePolicyRulesFloor` 将该规则视为 locked deny，默认 floor 不允许其调宽。该测试已移除，未留下失败用例；此结果构成明确实现缺口，不是环境问题。
- 结论：T04 仍进行中。必须加入基于显式行为版本的 floor 和隔离候选规则装配，并证明 v3 仍不可由生产 runtime 加载；不能通过删除 gate floor 校验或绕过 locked 规则解决。permit/executor 定向基线已有 208 项通过，但尚未证明 Agent 审核通过后 permit 只绑定单目标。
- 当前改动文件：`src/shared/confirmation/types.ts`、`src/shared/policy/policyEngine.ts`、`electron/confirmation/toolCallGate.ts`、`electron/confirmation/toolCallGate.test.ts`、执行计划与本证据。

## T04 GREEN 与执行绑定

- 实现：事实增加读取范围与目标种类 token；v3 隔离 resolver 仅为普通文件单目标读取/grep 和目录直列举生成 Agent review 规则；版本化 floor 将目录外递归 grep 保留为 locked deny，并保持敏感/系统路径真人确认 floor。
- Agent permit：gate 为 Agent review 产出单目标 mapping；Agent 批准后 `finalizeAgentReadReview` 校验 answerer/outcome、路径字面材料、目标类型、identity 与 mapping，绑定 request/tool、决策 ID 和 policy dependency fingerprint；结构 handoff 写入对应 Hosted tool call context。执行器对输入 digest、路径身份与执行文件重新核验。
- 安全测试：两 lane 候选 gate 测试覆盖 read_file、list_directory、目录 grep 和系统目录；read confirmation flow 覆盖替换调用输入失败；permit executor sentinel 实际读取获批字节并对另一目标输入返回 `input-digest-mismatch`；Agent handoff 只写入被批准的 invocation/tool context。
- 生产隔离：`policyRulesRuntime` 回归测试向数据库注入 v3 snapshot，确认 runtime 不输出候选 rule，仍保留 `remote-outside-read-deny`。正式加载器白名单未加入 v3；gate 的 v3 支持只消费由受信任内部调用提供的显式候选快照。
- 验收命令：`npm exec vitest run electron/confirmation/toolCallGate.test.ts electron/confirmation/readExecutionPermit.test.ts electron/confirmation/readPermitExecutor.test.ts electron/confirmation/readExecutionBoundary.test.ts electron/confirmation/readConfirmationFlow.test.ts electron/confirmation/agentSdkSafetyPolicy.test.ts electron/confirmation/policyRulesRuntime.test.ts src/shared/policy/policyEngine.test.ts`；退出码 0，8 files / 409 tests passed。`npm run typecheck:shared` 通过。增量 Electron build 边界门禁全部通过；另有 `tsc -p tsconfig.electron.json --noEmit --incremental false` 无诊断输出（命令会话在结果返回后终止）。
- TDD 记录：范围 token 用例先 RED（事实缺失），随后 GREEN；locked floor 候选试验先 RED（rules-violated），随后通过显式版本化 floor 和隔离 resolver；Agent handoff 输入漂移用例先 RED，随后增加原始目标匹配并通过。
- 任务状态：T04 完成；无生产 v3 激活、无用户数据写入。
- 补充边界 RED：目录外 wildcard 输入先被标为 unknown，但隔离 v3 首次落入默认 `auto-allow`。新增按目标种类分开的版本化 locked deny（missing/symlink/special/unknown），resolver 与 floor 同步登记；回归断言覆盖 unknown 与 special，随后候选 gate 测试通过。最终 T04 8-file/409-test 命令在上述类型声明修正前通过行为测试，随后 `npm run typecheck:shared` 通过，类型错误已消除。

## T06 Shell 审核与执行计划绑定

- RED：新增两 lane 隔离 v3 的 `git status` / `git log` 候选用例首次未产生候选事实；原因是只存在全量远程 Shell locked deny，尚无具体候选事实与版本化例外。新增 helper 用例也发现 Git 解析原先会把配置覆盖 helper 的命令误判为 mutating，而非 unknown。
- GREEN：新增观察事实 `im-shell-review-candidate`，仅单条、完整解析、无 unresolved/connector/redirect 的 `git status` / `git log`（允许有限格式参数）产生候选。v3 resolver 与对应 floor 同时排除这两个候选信号对 `remote-shell-disabled` 的命中，并添加 `im-shell-review` Agent 规则。其他子命令、`-c` 配置 helper、复合命令和旧行为版本仍命中 locked deny；生产加载白名单没有变化。
- 风险标签：`git status` / `git log` 的 `command-effect` 维持 `unknown`，因为仓库配置可触发 fsmonitor、pager 或其他外部 helper，Shell 静态文本无法证明这些副作用不存在。外部 `-c` 配置 helper 由测试证明不进入候选。系统不提供进程沙箱，Agent 审核是风险判断，不是系统级隔离。
- 执行绑定：已存在的 `PreparedShellExecution` 对命令 plan digest、cwd、environment fingerprint、policy/config revision、spawnSpec 和依赖/路径快照做冻结与 stale 校验。本阶段补充 cwd/environment/policy 变化 stale 断言、command 变化 plan digest 断言，并在 planned registration 的 executor spy 中证明 policy revision 漂移时拒绝且不 spawn。Shell 前置预检既有 deny 短路及审计用例保持在同一 gate suite。
- RED/GREEN 期间发现共享 floor 必须与 v3 resolver 同步 shell exclude 条件；不同步时 gate 会以 `rules-violated` fail closed，修正 floor 后 T04/T05 候选用例恢复。
- 验收命令：`npm exec vitest run electron/confirmation/toolCallGate.test.ts electron/confirmation/agentSdkSafetyPolicy.test.ts electron/shell/preparedShellExecution.test.ts electron/tools/runShellRegisteredTool.test.ts`；4 files / 254 tests passed，退出码 0。`npm run typecheck:shared` 通过（本阶段本轮之前确认；类型/事实改动后将于 B 阶段收尾合并复核）。
- 任务状态：T06 完成；行为版本仅隔离测试可加载，未启用生产迁移或版本发布。

## T07 拒绝优先与 Phase B 收尾

- 回归：`policyEngine.test.ts` 增加敏感路径真人询问、显式用户 deny、候选询问同时匹配时 deny 胜出的矩阵；`toolCallGate.test.ts` 覆盖敏感出站审核叠加 `remoteDenyOutbound`、敏感文件真人底线叠加显式 deny。两种 gate deny 均不生成执行许可。
- RED：首次敏感文件测试将临时目录放在 workdir 内，事实自然为 `workdir-normal`；调整测试输入以通过 `customSensitivePrefixes` 明确构造敏感事实，避免把夹具错误当产品缺陷。随后测试通过，无需策略行为改动。
- 全量测试首次验收：`npm test` 有 1227 files passed、1 skipped，但一个锁定规则盘点测试仍从已迁移的旧路径读取文档而 ENOENT。检查基线提交 `30ebf315` 的文档清单确认文档现位于 `docs/develop/safety-approval/security-policy-locked-floor-classification.md`；更新测试路径并单测通过。
- T07 定向验收：`npm exec vitest run src/shared/policy/policyEngine.test.ts electron/confirmation/policyIntegration.test.ts electron/confirmation/automationLane.test.ts electron/confirmation/toolCallGate.test.ts`；4 files / 331 tests passed。
- Phase B 收尾：`npm run typecheck:shared` 通过；`npm run build:electron:incremental` 通过，含 pi-ai closure 与 session-storage 边界门禁；`npm run check:system-invariant-registry` 通过（12 registrations、42 references）；`git diff --check` 通过。第二次 `npm test` 退出码 0：1228 files passed、1 skipped；11853 tests passed、140 skipped。
- Phase B（T04–T07）完成。未启用生产 v3、未改真实用户数据库；本地迁移只使用测试库。系统 invariant registry 无新增 invariant；审查行为继续由共享策略及版本化 floor 管理。

## T05 基线

- 命令：`npm exec vitest run electron/confirmation/toolCallGate.test.ts electron/confirmation/writeExecutionPermit.test.ts electron/confirmation/writePermitExecutor.test.ts electron/tools/writePermitReapproval.integration.test.ts`
- 退出码：0；4 files / 186 tests passed。

## T05 目录外写候选与身份绑定

- RED：v3 隔离 gate 用例对 WeChat/Feishu 普通 outside `write_file` / `edit_file` 初始返回 `remote-outside-write-deny`，候选审核缺失。新增 host facts 范围用例时确认 gate 只给 workdir 内目标产 `write-target-new/existing`，阻止 outside 候选规则匹配。
- GREEN：在显式 v3 resolver/floor 中将 `remote-outside-write-deny` 限为 outside + unsupported 目标，另加普通 outside 新建/编辑的 Agent review 规则。gate 对已探测 ordinary missing/file 目标产出 new/existing 观察事实；v1.6/v2 仍由原 remote locked deny 拦截。v3 生产 loader 未开放。
- 边界：两 lane 目录外普通新建与编辑到 Agent；missing parent 以 `write-parent-directory-missing` deny；目录目标和 hardlink 均产生 unsupported 并 deny；若平台允许创建 symlink，则 symlink 同样被观察为 unsupported 并 deny。`remote-write-scope-unknown-deny` 与 `write-target-unsupported-deny` 的底线规则仍在 v3 floor 中。
- Permit：Agent 确认后结构 handoff 生成 `approval: confirmed` permit，绑定 request/tool、完整输入 digest、目标 WritePathFact（含 parent/target identity）、decision rule 和 lane；用例验证内容变更返回 `write-input-digest-mismatch`。既有 `writePermitReapproval.integration.test.ts` 覆盖执行重核与许可重新审批。
- 基线：`npm exec vitest run electron/confirmation/toolCallGate.test.ts electron/confirmation/writeExecutionPermit.test.ts electron/confirmation/writePermitExecutor.test.ts electron/tools/writePermitReapproval.integration.test.ts`，4 files / 186 tests 通过。
- 最终命令：在上述四文件外加入 `electron/confirmation/agentSdkSafetyPolicy.test.ts`；5 files / 234 tests passed，退出码 0。`npm run typecheck:shared` 通过。
- T05 完成，无 dispatch 绕过、无生产 v3 激活或真实用户数据改动。
