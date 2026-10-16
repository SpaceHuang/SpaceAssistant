# Phase 5 源码交付验收记录

日期：2026-10-16。范围：P5-01～P5-07 源码闭环；正式发行包/生产数据/真实 IM、MCP 服务不包含在本次交付声明中。

## 静态扫描与清理

- 详见 [`security-policy-final-decision-scan.md`](./security-policy-final-decision-scan.md)：记录扫描目录、关键词命令、目标反例、白名单归属及静态审查限制。
- Inventory C-01～C-19 均有状态和证据。移除 `classifyImOutbound`、无来源的 declared capability 快通道，以及已无调用的 remote script/navigate/lark skip helper；保留纯事实 classifier、IM dispatch object final-check、browser act 配置投影和已登记执行不变量。
- 危险脚本硬编码判断迁为 `script-dangerous-deny` 显式规则；测试证明移除该规则后不会留下隐形 deny。递归与 approval recheck audit 记录 `SYS-RECURSION-001` / `SYS-APPROVAL-001`。

## 定向边界集

- `npm exec -- vitest run src/shared/confirmation/outboundClassification.test.ts src/shared/policy/policyEngine.test.ts src/shared/policy/defaultRules.contract.test.ts src/shared/policy/imOutboundPolicy.test.ts src/shared/security/systemInvariantRegistry.test.ts electron/confirmation/toolCallGate.test.ts electron/confirmation/recursionGuard.test.ts electron/confirmation/toolDecisionMatrix.test.ts electron/remote/remoteToolPolicy.test.ts electron/tools/wechatOutboundRegisteredTools.test.ts electron/tools/weChatToolExecutor.test.ts`
- 结果：11 个文件、356 项通过。
- `npm run check:system-invariant-registry`：通过，5 registrations / 9 test references；valid/invalid fixtures 通过。
- `npm run typecheck:shared`、`npm run typecheck:renderer`、`npm run build:electron:incremental`、`git diff --check`：通过。

## Phase 最终全量测试

- `npm test`：退出码 1；Vitest 汇总 12 个文件失败、1,064 个通过、1 个跳过；180 项失败、9,954 项通过、111 项跳过、6 个未捕获错误；耗时 739.56 秒。
- 失败主要来自 Hosted/API Key 无法读取（`LLM_KEY_ACCESS_DENIED`）、SQLite handoff/checkpoint 重启预期和多项 `PROVIDER_ROUTE_IDENTITY_COLLISION` 未捕获 rejection。P4 记录中的 Hosted/provider/SQLite/approval-agent 失败模式仍存在。最终全量失败不能声明全仓通过；P5 定向决策、facts、registry、final-check 和 audit 集合通过。
- 全量输出在此次交互式 PTY 中完成，没有保存原始日志文件；上列为 Vitest 最终汇总和可见失败例证。此前 P4 日志及分类见 `security-policy-phase4-test-record.md`。

## 完整构建与门禁

- 初次沙箱内 `npm run build` 在 i18n type generation 创建本地 IPC socket 时因 `listen EPERM` 退出；允许受控提升后同命令完整通过。
- 完整构建完成 tray icons、i18n type generation、Vite renderer build、Electron checks 与 `tsc -p tsconfig.electron.json`。
- Vite 输出既有 `INEFFECTIVE_DYNAMIC_IMPORT` 与大 chunk warning；构建退出成功。
- Registry、shared/renderer 类型与增量 Electron 构建门禁均已通过。

## 外部验收边界

- P5-04 正式包版本回归：外部待验；本次按用户选择只交付源码闭环，没有正式安装包和对应生产数据。
- P5-05 真实 IM/MCP 渠道：外部待验；mock/unit/integration 测试不宣称真实服务副作用通过。
- P5-08 发布验收：不在本次源码交付声明内。若后续发布承诺要求包/真实通道证据，再按 P5-04/P5-05 补验。
