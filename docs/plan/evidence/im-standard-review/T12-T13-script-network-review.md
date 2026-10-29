# T12–T13 联网脚本审核与执行绑定证据

- 基线：Phase D 提交 `4c00b1bf`；变更位于 `codex/im-standard-review-execution` 隔离 worktree，`im-standard-v3` 仍未进入生产加载白名单。
- 规格：技术方案 D-05、INV-06、AC-06/08；此证据只覆盖本机隔离 gate、审核事实和执行器准备检查。真实外部网络请求与微信/飞书端到端仍需后续验收。

## T12 静态网络事实与候选审核

- RED：`npm exec vitest run electron/confirmation/extractors/extractors.test.ts` 在新用例“仅将无副作用、单一静态 HTTPS GET/HEAD 目标标为 IM 网络审核候选”上失败（1 failed / 45 passed）；提取器此前没有 network candidate fact。
- GREEN：IR 仅接受两条语句：无别名 `import requests`，随后唯一的 `requests.get/head` 静态字符串 URL 调用；必须提供 1–30 秒常量 timeout、`allow_redirects=False`、HTTPS 主机名、根路径且无凭据/端口/query/fragment。其余语句、动态目标、重定向默认值、IP/localhost/本地域名均不产候选事实。
- 决策边界：facts extractor 只输出 `im-script-network-review-candidate` 与 host/method/URL 事实，不产 allow/deny。隔离 v3 标准档加入稳定规则 `im-script-network-review`；旧网络 locked deny 与未认证 ask 只排除完整候选 token，candidate 规则还要求完整环境及 settings 摘要，并排除 `dangerous` / `extraction-failed`。v1.6 仍拒绝；动态/不完整/危险脚本未获放宽。
- TDD/定向结果：`npm exec vitest run electron/confirmation/toolCallGate.test.ts electron/shell/scriptContentSecurity.test.ts electron/shell/scriptContentSecurity.residual.test.ts electron/confirmation/extractors/extractors.test.ts` 退出码 0，4 files / 280 tests passed。覆盖两 lane Agent 路由、v1.6 拒绝、静态 URL/method、动态目标、超时/重定向参数、附加语句拒绝。

## T13 执行材料与变更失效

- RED：对当前静态联网候选回归暂时移除 prepared environment digest 对拍后运行 `npx vitest run electron/tools/builtinExecutors.runScript.test.ts -t 'script child environment changed after preparation rejects before dispatch and executor'`；测试错误地执行成功（1 failed / 14 skipped），证明执行器边界未拒绝准备后环境变化。恢复实现后同命令通过（1 passed / 14 skipped）。
- GREEN：仅对静态网络候选，gate facts 输出脚本环境和 settings SHA-256 摘要；initial gate 将获批摘要写入本次 runtime context。注册工具在确认后的 validate 阶段比较同一 prepared settings、环境摘要与 gate 摘要，缺失或漂移在 dispatch 前拒绝。实际执行使用 prepared 的过滤环境副本，不在 final-check 后重读 `process.env`。微信/飞书远程候选子进程剥除 proxy 环境变量；Agent facts 含网络目标、方法及解释器设置名。其他 run_script 继续使用原来的 gate/executor 行为。
- 变更失效：候选的工具输入摘要绑定代码/参数；settings 摘要含 workDir、userDataDir、超时、Python 与解释器配置；环境摘要绑定过滤后的子进程环境。门控后环境/settings 改变、gate/plan 摘要不一致、缺摘要均在执行器调用前失败。执行计划在初始 gate 前准备，摘要经 initial gate 回填后再对拍；授权刷新保留候选标记和这两个安全字段。
- TDD/定向结果：`npm exec vitest run electron/tools/scriptRunner.test.ts electron/tools/builtinExecutors.runScript.test.ts electron/confirmation/agentSdkSafetyPolicy.test.ts electron/processOutputEncoding.test.ts` 退出码 0，4 files / 73 tests passed。覆盖解释器配置漂移、gate 与 plan 摘要匹配/不匹配、环境变更不调用执行器、远程 proxy 剥除、环境值不进入 prepared facts。
- Hosted 回归：首轮全量曾出现 20 个既有脚本集成失败，原因是把新的 gate/settings 绑定扩大到所有 IM 脚本。按任务范围收窄为仅对 `im-script-network-review-candidate` 应用新增摘要校验与 proxy 剥除后，`npx vitest run electron/claudeStreamHandlers.hostedIntegration.test.ts electron/remote/imRemoteAgent.test.ts electron/wechat/weChatRemoteAgent.test.ts` 退出码 0，3 files / 353 tests passed；原有 JS/TS Hosted 运行、撤权、取消、授权变化边界恢复通过。

## Phase E 收尾

- `npm run typecheck:shared`：退出码 0。
- `npx tsc -p tsconfig.electron.json --noEmit --incremental false`：退出码 0。
- `npm run build:electron:incremental`：退出码 0；pi-ai runtime closure、session-storage cleanup/module graph 边界通过。
- `npm run check:system-invariant-registry`：退出码 0；12 registrations、42 references，正反向 fixtures 通过；本阶段未新增 system invariant。
- `git diff --check`：退出码 0。
- `npm test`：最终退出码 0；1228 files passed、1 skipped；11878 tests passed、140 skipped；duration 1569.56s。此前失败的全量轮次已按上述 Hosted 回归修复后重跑。
- 未执行真实外部网络请求；按计划仅声明 AC-06/08 本机部分完成，不代表完整真实环境验收或发布资格。
