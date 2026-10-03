# main 代码评审（2026-10-03）

## 范围

评审 `main` 的已提交代码（`bf393ef1`），以 `origin/main..HEAD` 的 9 个提交为重点。工作区未提交修改未纳入结论。

## 阻断项

### Critical：Hosted handoff 在拒绝旧 transcript 前已调用模型提供方

- 位置：`electron/butler/butlerInvoker.test.ts:1020-1051`；相关执行链：`electron/butler/butlerInvoker.ts`、`electron/runtime/hostedTurnHandoff.ts`。
- 复现：`npx vitest run --project electron electron/butler/butlerInvoker.test.ts -t 'Automation Hosted handoff rejects stale legacy transcript when canonical session History exists'`。
- 实际结果：测试预期任务因 canonical History 与旧 transcript 冲突而失败，且 `mockCreateAnthropicClient` 不被调用。任务确实返回失败，但 mock 已被调用 1 次，参数为 `test-key` 和 `https://mock.local`。独立重跑仍失败。
- 影响：拒绝不安全 transcript 的检查未能阻止此前的提供方调用，可能造成不必要的请求或让错误上下文进入模型处理链。至少当前回归测试与 `main` 的行为不一致，完整测试质量门未通过。
- 建议：在 Hosted handoff 创建提供方客户端或开始模型请求前，完成 canonical History 的选择与一致性校验；保留此回归测试，并断言提供方流也未启动。

## 验证

- `npm run typecheck:renderer`、`npm run typecheck:shared`、`npm run typecheck:agent-sdk`：通过。
- `npm test`：已报告上述失败；之后持续无新输出约四分钟，手动中断（退出码 130），因此没有全套汇总。

结论：**阻断**。修复后重新运行聚焦用例与完整测试。
