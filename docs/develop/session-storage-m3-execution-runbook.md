# M3 durable projection migration 执行规程

状态：M3-EXEC 操作草案，适用于 M3-6G 已验收后的受控 cohort 准备。本文不构成任何真实 profile 或数据集的写入授权。

## 责任分工

| 角色 | 责任 |
| --- | --- |
| 数据 owner | 确认目标 profile、授权范围、inventory 摘要及保留旧路径的 disposition；批准开始、暂停后恢复或终止。 |
| 迁移 operator | 核对发布身份和 profile，创建/启动 run，观察进度，保存 run/item 报告；发现停止条件时执行暂停并通知 owner。 |
| 发布/部署负责人 | 提供目标 profile 实际安装版本的 commit、artifact/build identity、SHA-256 和正常升级证据；该版本须由组织批准部署并包含已验收的 M3-6，不要求一定公开发布。 |
| 恢复负责人 | 决定暂停/继续/终止及兼容版本回滚；核对 run 是否可重开，确认 legacy reader 和正文仍可用。 |

姓名/账号、联系方式、值班覆盖时间须在具体 cohort 授权记录中填写；本草案不虚构负责人身份。

## 执行前置条件

开始任何真实 profile 工作前，operator 必须归档并逐项核对：

1. M3-6G 已通过的代码与 tree snapshot；目标部署产物必须包含该实现且经对应平台验收，记录 app version、commit、artifact SHA-256、build identity 和平台/架构。正式公开发布不是本地开发/隔离验收门槛；真实 profile 操作须使用其维护流程批准并正常安装/升级的版本。
2. 目标 profile 已通过应用正常安装/升级运行该版本；记录 profile/database 稳定身份和升级确认。不得从开发进程打开或操作真实 profile。
3. 数据 owner 的书面授权明确绑定目标 profile、授权的产品 scope/cohort、用途、开始/到期时间、暂停/恢复/终止联系人。授权不等于正文清理授权。
4. 由正式 main-process application entry 创建 inventory/run。复核固定 `inventorySha256`、database/migration/internal-hidden counts、scope 分类及全部 item disposition；owner 确认摘要后才允许启动执行。
5. 当前实现的 census 会覆盖该 profile 的全部已知产品 scope（`user/primary`、`remote/primary`、`automation/section`），并排除 `internal/hidden`、拒绝 unknown scope；它不是任意 session 子集过滤器。若授权只覆盖部分 session，必须先具备并验收精确 cohort 限定能力，不能用 `knownSessionIds` 冒充白名单。
6. 确认没有另一 active run；审核端点设备、备份和恢复负责人。禁止同时手工修改 scope、canonical History 或 projection cache。

## 启动与观察

1. 只调用已发布版本的 main-process migration application entry。先创建 run 并将其 `runId`、`inventorySha256`、计数、时间和 owner 批准引用写入记录；在 owner 复核前不得启动 worker。
2. owner 核对确认后，以同一 `runId` 显式 start。默认每次最多一个 batch、每批默认 20 个 item；后台 scheduler 每 tick 一个 batch、默认间隔 5 秒。不能通过关闭兼容 reader 或正文写入来“帮助”迁移。
3. 保存每次 run/item 报告：status、cursor、inventory hash、success/failure/skipped 数、session ID、原因、attempt 和时间。受保护日志不得包含正文内容。
4. active turn/queue 对应 item 会标记 `deferred_active` 并使 run 可重试；等待该会话空闲后再继续。scope/generation drift 进入 `needs_attention`，不得手工改回状态后继续同一 cohort；需 owner 复核新状态并重新 census/授权。
5. transient item failure 进入 retry；修复原因且 owner 同意后复用同一 run 重试。审计必须将每项归类为 migrated、retain-legacy、deleted 或明确待处置；不得只凭 migrated 总数认定完成。

## 暂停、恢复与终止

- **暂停**：owner/operator 发现服务影响、scope 变化、异常增长或报告不一致时，先停止 scheduler，再持久 pause run。已领取的当前有界 item 可完成；不得启动下一批。暂停保留 run 与已完成 item 证据。
- **恢复**：确认停止原因解除、profile/artifact identity 未变、active turn 已结束或可继续延后、inventory 与批准摘要一致后，使用原 run ID 恢复。若 inventory 或 scope 身份发生变化，停止旧 run，重新 census 并取得新授权。
- **进程异常退出**：不重建 inventory 覆盖原 run。正常重新打开数据库后复用 active run；未完成 lease 到期后可重新领取。对账 run/item 记录和 inventory hash 后继续。
- **终止**：只有 owner 决定不再恢复时才调用 durable cancel。cancel 是终态，不可 resume；需要再次迁移须创建新 inventory、run 和授权。

## 停止条件与回滚

出现以下任一项，operator 立即停止后续 batch、持久 pause 并通知 owner：run/item hash 不匹配、profile/build identity 不符、scope/generation drift、`needs_attention`、同一 session 重复失败、全局摘要对账失败、unexpected legacy disposition、用户会话响应受到可归因影响，或授权到期/撤销。

projection migration 只写 canonical transcript projection cache、eligibility 与 migration audit/run/item 状态；不删除 `messages.content`、不停写 session、不改变正文 owner，也不清理 spill。回滚先停止并 pause worker，再依据 §8.8.5 已验收的兼容 R 产物和对应 profile 升级证据决定回退版本；不得通过关闭 canonical reader、清除 cursor 或重置 run 来回滚。若尚无与该 schema/History 格式兼容的已验收 R 产物，则保持暂停、保留数据库与旧 reader，交恢复负责人处理；不尝试降级数据库 schema。

## 完成与归档

run 完成后，operator 运行只读 consistency audit 并对账：inventory 总数、item 总数、迁移成功摘要、legacy queue、internal History 摘要及未分类数。所有 eligible item 必须 migrated，或有 owner 批准且旧 reader 仍支持的 retain-legacy 决议；差异、unknown scope 和未处置 retry 均阻止 cohort 完成。归档授权、发布/profile identity、run/item 报告、audit、integrity/FK 结果、失败处置与 owner 签署记录。该流程仍不授权任何正文清理。

## 本机与生产边界

本机只用隔离 file-backed SQLite fixture 演练此规程。真实 profile census、补迁及正常版本观察属于部署后数据任务；必须等目标 profile 正常运行包含 M3-6 的受认可版本、数据 owner 明确授权和 M3-7 门禁满足后执行。R-03 正式公开发布不是 M3-EXEC 源码/隔离验收的依赖；M3-EXEC 操作规程完成不代表 M3-PROD 已获准或已运行。
