# Remote Policy 统一规则映射（Phase 2）

Remote IM 使用共享 `Policy Engine`，`lane` (`wechat`/`feishu`) 和 versioned IM policy snapshot 是规则条件与配置来源。`remoteToolPolicy.ts` 保留 snapshot 结构/版本验证及 shell 语法工具；它不再单独决定最终工具 verdict。

| 既有 remote 分支/配置 | 统一落点 | 责任说明 |
|---|---|---|
| `remoteDenyOutbound` / `denyOutbound` | `remote-deny-wechat-outbound`、`remote-deny-lark-write-outbound` | locked policy deny；先于缓存与普通确认规则。 |
| `remoteAllowLocalWrite` / `denyWrite` 与远程文件目标 | `remote-outside-write-deny`、`remote-write-scope-unknown-deny` | path-zone facts 由 facts producer 提供，显式 locked policy rule 裁决。 |
| 远程 browser disabled | `remote-browser-disabled` | versioned snapshot 映射为规则配置，由 shared engine 执行。 |
| 远程 shell disabled | `remote-shell-disabled` | versioned snapshot 映射为规则配置，由 shared engine 执行。 |
| `remoteScriptRequiresConfirm` | `script-uncertified-ask-remote`、`script-clean-certified-remote` | 只有被完整分析认证为 clean 的脚本可消费免确认开关；未认证/unknown 规则优先保护。迁移未完成时 `migrationComplete=false` 保持确认。 |
| `remoteBrowserNavigateRequiresConfirm` | `browser-navigate-ask-remote` | 与 `navigateRequiresConfirm` 一起作为 rule config 条件；规则不匹配时跳过确认。 |
| `remoteBrowserActRequiresConfirm` | `browser-act-ask-remote` | gate 将 versioned snapshot 投影为规则配置；危险 act 的 locked human rule 仍先行。 |
| `larkCliWriteRequiresConfirm` | `lark-write-ask` | askUnless 配置由引擎解释；high-impact / unknown 的独立规则保持原语义。 |
| 旧 snapshot 缺失、版本不支持或结构无效 | `isRemoteSecurityMigrationComplete` → `migrationComplete=false` | 这是策略迁移状态输入，不是 verdict；对应规则以 fail-closed 默认配置执行。 |
| remote browser act skip helper | `shouldSkipRemoteBrowserActConfirm` 仅投影配置值 | 无独立决策；shared engine 中 `browser-act-ask-remote` 消费 `remoteActSkipConfirm`。 |
| `applyMigrationConservativeOverlay`、script/navigate/lark skip helpers | 旧兼容/测试契约 | 当前生产路径没有调用这些函数；等价开关消费已位于上述规则中，不应重新引入第二个最终裁决链。 |

验证依据：`src/shared/policy/defaultRules.ts`、`src/shared/policy/policyEngine.test.ts`、`electron/remote/remoteToolPolicy.test.ts`、`electron/toolChatLoop.phase2RemoteConfirm.test.ts`。Remote settings 的持久化/迁移及 UI 仍由原 snapshot 协议管理；本次没有改变远程产品动作矩阵。
