# Locked policy floor 分类清单

> 状态：源码派生盘点，供 Phase 2/3 对账；不代表相关迁移任务已关闭。
> 范围：`src/shared/policy/defaultRules.ts` 中 `locked: true` 的内置规则。规则条件与完整解释以代码为准。

## 分类口径

`locked` 标记的是**不可由运行时策略覆盖放宽的产品策略**，不是系统实现约束的通用标签。下表列出的条目都属于产品策略，负责给某类调用作出 `deny`、逐次真人确认或 `ask` 裁决；它们留在统一 Policy Engine 与 decision trace 中。

系统实现约束（例如执行许可绑定、调用撤销后禁止派发、路径身份复核、审批递归保护）属于另一类责任，应由系统底线登记表记录并在策略裁决后独立校验。当前 Phase 3 的登记入口与字段仍以 `security-policy-three-stage-architecture-development-plan.md` 的 P3-01/P3-02 为准；本清单不把这些约束伪装成规则 ID，也不替代该登记表。

| Policy action | 产品策略类别 | Locked rule IDs |
|---|---|---|
| `deny` | 原始 Wiki 写入、远程路径边界、媒体目录边界、敏感/未知工作目录切换 | `wiki-raw-write-deny`, `remote-outside-write-deny`, `remote-write-scope-unknown-deny`, `remote-outside-read-deny`, `remote-wechat-media-outside-deny`, `remote-wechat-media-unknown-deny`, `write-target-unsupported-deny`, `feishu-media-boundary-deny`, `feishu-media-boundary-unknown-deny`, `remote-sensitive-workdir-switch-deny`, `remote-unknown-workdir-switch-deny` |
| `deny` | 远程脚本网络、IM 外发限制、浏览器/Shell 禁用、外发预算暂停 | `script-network-deny-remote`, `remote-deny-lark-write-outbound`, `remote-deny-wechat-outbound`, `remote-browser-disabled`, `remote-shell-disabled`, `remote-outbound-budget-pause-wechat`, `remote-outbound-budget-pause-lark`, `im-no-wechat-send` |
| `deny` | 自动化无真人应答时的脚本、路径、写入与 Shell 限制 | `automation-script-path-unknown-deny`, `automation-unverified-script-language-deny`, `automation-sensitive-path-deny`, `automation-system-dir-deny`, `automation-write-deny`, `automation-shell-deny`, `automation-unsupported-deny` |
| `deny` | 未授权 MCP 账户的数据范围 | `mcp-account-unauthorized-deny` |
| `confirm-every-time` | 脚本危险性、分析完整度与路径边界 | `shell-sensitive-path-confirm`, `shell-system-dir-confirm`, `script-sensitive-path-confirm`, `script-system-dir-confirm`, `script-path-unknown-confirm`, `script-path-unclassified-confirm`, `script-dynamic-execution-confirm`, `script-suspicious-path-unknown-confirm`, `script-unverified-language-confirm`, `path-sensitive-read-confirm`, `path-system-dir-ask`, `im-write-sensitive-path-confirm` |
| `ask` | 未认证脚本、IM 浏览器高危操作、消息接收对象/影响范围不确定、能力变更 | `script-uncertified-ask-remote`, `im-browser-act-danger-human`, `lark-message-group-human`, `lark-message-target-unknown-human`, `lark-high-impact-ask`, `lark-unknown-ask`, `toolkit-act-ask`, `automation-default-confirm` |

## Floor 行为

- `validatePolicyRulesFloor` 校验 locked 规则不能被移除、条件不能被掏空、动作不能放宽；管理员显式停用的 locked `deny` 规则是唯一缺席例外。locked `ask` 与 `confirm-every-time` 没有此例外。
- 规则的匹配条件、来源、责任人与 decision trace 由统一规则定义和评估链提供。新增或修改条目时，同步更新本清单，并运行 `src/shared/policy/lockedFloorClassification.test.ts`。
- 本清单刻意不列规则以外的执行时硬约束；它们应使用经 P3-01/P3-02 确立的系统底线登记契约，并由架构门禁验证覆盖率。
