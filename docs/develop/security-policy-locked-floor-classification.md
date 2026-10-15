# Locked Rule 与 Policy Floor 分类（Phase 2）

`locked` 表示规则配置不能放宽或删除，不代表所有 locked 条目都是同一种系统机制。当前 `validatePolicyRulesFloor` 对每条 locked rule 保留 `when` 与 `match`，阻止动作变宽；只有受信任 disabled ID 可停用 locked deny。最终命中仍进入 Policy Engine 的分层决策。

## Policy 产品规则

这些条目表达产品允许的安全结果，应该出现在有效规则与决策 trace 中：

- 远程范围和目标限制：`remote-outside-write-deny`、`remote-write-scope-unknown-deny`、`remote-outside-read-deny`、`remote-wechat-media-outside-deny`、`remote-wechat-media-unknown-deny`、`remote-sensitive-workdir-switch-deny`、`remote-unknown-workdir-switch-deny`。
- 远程工具/额度策略：`script-network-deny-remote`、`remote-deny-lark-write-outbound`、`remote-deny-wechat-outbound`、`remote-browser-disabled`、`remote-shell-disabled`、`remote-outbound-budget-pause-wechat`、`remote-outbound-budget-pause-lark`。
- 目标及环境限制：`wiki-raw-write-deny`、`write-target-unsupported-deny`、`feishu-media-boundary-deny`、`feishu-media-boundary-unknown-deny`、`mcp-account-unauthorized-deny`。
- 无人值守与敏感操作确认：`automation-script-path-unknown-deny`、`automation-unverified-script-language-deny`、`automation-sensitive-path-deny`、`automation-system-dir-deny`、`automation-write-deny`、`automation-shell-deny`、`automation-unsupported-deny`、`automation-default-confirm`、`shell-sensitive-path-confirm`、`shell-system-dir-confirm`、`script-sensitive-path-confirm`、`script-system-dir-confirm`、`script-path-unknown-confirm`、`script-path-unclassified-confirm`、`script-dynamic-execution-confirm`、`script-suspicious-path-unknown-confirm`、`script-unverified-language-confirm`、`path-sensitive-read-confirm`、`path-system-dir-ask`、`script-uncertified-ask-remote`、`im-write-sensitive-path-confirm`、`im-no-wechat-send`、`im-browser-act-danger-human`、`lark-message-group-human`、`lark-message-target-unknown-human`、`lark-high-impact-ask`、`lark-unknown-ask`、`toolkit-act-ask`。
- 三阶段策略矩阵中的显式真人底线：`write-outside-strict-human`、`outbound-sensitive-standard-human`、`outbound-sensitive-strict-human`、`outbound-incomplete-strict-human`。

## 不属于 Policy rule 的执行机制

- 路径探测失败、读取/写入 permit 建立失败、请求身份错配、执行前对象 identity 变化属于事实可用性或执行完整性；它们使用稳定机制错误/拒绝 ID，不能当作业务风险信号，也不能回写原 PolicyDecision。
- `validatePolicyRulesFloor` 本身是规则配置契约检查。`rules-violated` 表示有效配置违反不可放宽约束，必须保留 violations 与有效规则版本；它不是用户工具输入的风险 verdict。
- `shell-precheck-deny` 仅作为预决策输入/能力 validator 失败。shell 命令效果、路径范围和覆盖度先形成事实；预检批准属于 `shell-precheck-auto-allow` 规则下的子证据。预检不再在决策完成后重写最终 verdict。
- `recursion-guard`、`recheck-requires-confirm` 是确认生命周期/执行不变量，保留独立稳定 ID，并与原决策关联；不得借 `locked` 标签伪装成普通用户可调规则。

## 维护约束

- 新增 locked rule 时必须在本表登记类别、责任真源、允许的管理员停用方式和最终 trace 归因。
- 若只需要最终执行对象的原子性、撤权或调用身份完整性，应登记到 system invariant registry，不应新增产品策略规则。
- `humanRequired` 是决策层真人审批底线，即使某档把普通 ask 路由给 Agent，也不能被改写；它的触发 rule ID 与约束原因需要一并记录。
