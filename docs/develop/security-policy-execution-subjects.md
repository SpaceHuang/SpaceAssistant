# 执行批准对象绑定规格（P4-02）

## 通用 schema

`ExecutionSubjectEnvelope` 使用 `execution-subject-v1`，明文 envelope 仅含 `toolName`、`invocationId`、`toolUseId` 与 `sha256:` digest。规范化后按 UTF-8 JSON 字节计算 SHA-256；对象键排序，数组顺序保留，拒绝 NaN/Infinity、undefined、函数、symbol、bigint 与非 plain object。只存 envelope/digest，不存 subject 的原文副本；subject 内容可能含正文、命令、路径、收件人和参数。

每个适配器负责构造最小但完备的 subject，不得遗漏会改变实际副作用的字段。增删字段必须提升 schema version，并配字段变更回归用例。

## 各工具 envelope

| 工具域 | subject 摘要字段 | 字段变化时 | 不写入审计/receipt 的内容 |
|---|---|---|---|
| read / list / grep | canonical args digest、目标路径 fact、zone/kind、device/inode/mode/size/mtime、读取 scope、directory grant identity | 拒绝；重新 gate 与审批 | 原文、pattern、绝对路径；只在内存 permit 保存必要执行材料 |
| write / edit | canonical args digest（含写入正文的 digest 输入）、decision rule、目标 path zone/kind、parent/target identity、Wiki mount identity | 拒绝；重新准备并审批 | 写入正文、原始路径；仅保留 digest 和执行时所需的内存路径事实 |
| shell | canonical command+cwd+platform/interpreter/precheck facts、capability identity | 拒绝；重跑 facts 与审批 | 命令原文不可进持久 receipt/audit |
| browser | action+normalized URL/origin+tab/session identity+action args digest | 拒绝；重新核验并审批 | URL 私有 query、页面正文、凭据 |
| MCP | server identity+tool name+schema revision+canonical args digest+capability | 拒绝；重新核验并审批 | secret 参数值、认证材料、server token |
| IM | channel+account/identity epoch+recipient+session+payload digest+attachment digest/version+destination | 拒绝；重建 facts 并重新审批 | 消息正文、收件人明文、附件内容、session token |

现行 read/write permits 已绑定 request/toolUse、规范化输入 digest 和目标 facts；SDK permit 绑定调用身份、输入 snapshot、plan/facts digest、authorization version 与 phase。P4-03～06 逐适配器接线，共享 schema 不取代当前各自的原子 identity/执行机制检查。

## Failure 与执行顺序

先重算策略依赖并确认决策仍有效，再核对所需 receipt，再检查授权代次/撤销，再核对 subject digest，最后复核当前目标 identity/平台机制；仅所有检查成功后进入 executor/dispatch。任何失败必须保证 executor/dispatch 调用数为 0。执行检查返回授权存在、对象是否匹配、freshness 与机制状态，不产生 risk verdict。
