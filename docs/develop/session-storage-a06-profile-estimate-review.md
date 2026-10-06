# A-06 M4-4/5 profile 与 cleanup estimate 审阅

- 审阅输入：[`A-00 冻结清单`](./session-storage-a00-review-input-freeze.md)
- 范围：只读 SQLite profile、dbstat、session event directory、spill 分类及逻辑/物理空间估算。
- 方法：只读静态审阅；未运行测试、未访问真实 profile、未修改产品代码。此前合成 profile/estimate 验证证据见技术方案 v386（2 个文件 7/7；报告归档亦记录 DB 摘要不变）。

## 判据与证据映射

| 判据 | 实现位置 | 现有断言 | 结论 |
| --- | --- | --- | --- |
| SQLite 以只读连接打开，记录 runtime/schema/dbstat 与表页 | `sessionStorageProfile.ts:10-35,190-225`；estimate `sessionStorageCleanupEstimate.ts:107-127` | `sessionStorageProfile.test.ts:10-80` 覆盖 schema/runtime、dbstat 全对象、内容不输出及只读写入拒绝 | 通过。 |
| spill source-of-truth/degradable/orphan/GC 分类 | `sessionStorageProfile.ts:36-94`；estimate `sessionStorageCleanupEstimate.ts:128-155` | `sessionStorageProfile.test.ts:83-109`、`sessionStorageCleanupEstimate.test.ts:40-60` 覆盖三类与 pending GC | 发现 F-A06-01：profile 收集 spill 与 spill-degraded 失败时静默返回零，且 estimate completeness 没有反映这类扫描失败。 |
| session event retention 按 count 候选、计字节、保留 unindexed | `sessionStorageCleanupEstimate.ts:26-105,126-127` | `sessionStorageCleanupEstimate.test.ts:17-69` 覆盖 retained/beyond-count/unindexed 与字节估算 | 通过；symlink/不可读子项会使 sizingIncomplete，而候选始终 `deletionAuthorized=false`。 |
| duplicate body 精确身份匹配及逻辑/物理边界 | `sessionStorageProfile.ts:132-188`；estimate `sessionStorageCleanupEstimate.ts:160-220` | `sessionStorageCleanupEstimate.test.ts:71-95` 覆盖 exact identity 与 maximum shrink 受 messages dbstat 页约束 | 通过；明确逻辑正文字节不等于物理回收，数据库 shrink 上界受消息表页约束。 |
| snapshot、canonical 必留数据与危险操作不被估算器授权删除 | `sessionStorageCleanupEstimate.ts:175-220` | `sessionStorageCleanupEstimate.test.ts:54-68` 断言 snapshots/source-of-truth 保留、所有候选 deletionAuthorized=false、输入 DB 文件字节不变 | 通过。 |
| 内容/路径日志脱敏 | `sessionStorageProfile.ts:10,146-188` 输出聚合计数/字节与摘要，不返回正文；cleanup estimate 报告不输出绝对目录/file body | `sessionStorageProfile.test.ts:65-80` 验证 canonical body 不出现在 JSON 报告 | 通过。 |

## Finding

### F-A06-01 — [P2] spill 扫描失败被表示成零字节而不是不完整测量

- 位置：`sessionStorageProfile.ts:36-64` 的 `spillFiles` catch 返回 `files/totalBytes/sourceOfTruthBytes/degradableBytes/orphanBytes = 0`；`:87-93` 的 `spillDegraded` catch 同样返回零；`sessionStorageCleanupEstimate.ts:211-220` completeness 没有相应的 spill inventory availability/error flag。
- 风险：I/O 权限错误、目录读取故障或参考扫描异常时，profile 可把未知 spill 占用显示为 0。direct cleanup estimate 对坏 canonical descriptors 会在重复扫描处抛错，但普通 profile/maintenance measurement 路径仍可能误报总空间。
- 建议修复：区分“目录确认为空”和“扫描失败”；失败要抛出或返回明确不完整原因并阻止该份 estimate/profile 被标成完整。为 spill 与 spill-degraded 分别增加不可读目录/坏引用测试。
- 责任任务：A-10 闭环；未修复前相关 spill 体积报告不能作为完整测量结论。

## 结论

A-06 审阅切片完成；估算边界、只读和候选不授权语义基本符合计划，但存在 F-A06-01，相关测量完整性未通过。真实 profile 未读取。
