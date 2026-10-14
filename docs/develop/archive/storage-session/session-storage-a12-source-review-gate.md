# A-12 源码审阅阶段放行评估（2026-10-05）

## 决定

**放行进入 B 集成（I-00…I-12），限定为默认关闭清理的功能集成。** 本结论不授权发布、启用或运行 C-on，也不代表任何真实用户数据可读写。

## M3/M4 当前切片结论

| 审阅切片 | 结论 | 依据/限制 |
| --- | --- | --- |
| A-01 inventory/census | 通过 | F-A01-01 已精确限制为三个批准的 ownership/visibility 组合；其它组合 fail closed。 |
| A-02 durable run/inventory | 通过 | 固定输入摘要、续跑/幂等、竞争和重开证据见 A-02 报告；无未处置 finding。 |
| A-03 worker/cohort fence | 通过 | F-A03-01 已把 cohort 复核、canonical 认证读取、cache 对拍与 eligibility 写入置于 writer fence 事务；scope 变化回滚。 |
| A-04 legacy-required queue/audit | 通过 | 报告/队列/候选和 census 一致性核对完成，无新增 finding。 |
| A-05 observation gate | 本机实现通过；正式观察未放行 | build UUID/target 隔离和样本/路径门禁已实现。R-06 的 owner 门槛、R-07 正式产物观察仍属发布证据，不阻断代码集成。 |
| A-06 profile/estimate | 通过（仅合成数据） | spill 扫描异常不再折为零；本轮及 A-06 未读取真实 profile。 |
| A-07 cleanup gate/worker | C-off 与隔离实现可集成；C-on 禁止 | F-A07-01 未解决：全 profile 枚举没有 owner 批准的精确 session/profile/期限 scope。release 开关默认关闭；SC-SCOPE/SC-SCOPE-PKG 前不得进行 C-on 生产部署/执行。 |
| A-08 maintenance/archive | 通过（隔离实现） | F-A08-01/02 已修复并复审；归档内容完整性在 VACUUM 前核验，queued 工作阻止维护。 |
| A-09 cross-cutting/scope | 通过 | 已逐路径核对存储主线与 `origin/main` 能力重叠；集成时复用目录授权/continuation UI，不重做。 |

## P1/P2 finding 汇总

| ID | 严重度 | 状态 | 对 I-00…I-12 的影响 |
| --- | --- | --- | --- |
| F-A01-01 | P1 | 已修复并复审 | 无阻断。 |
| F-A03-01 | P1 | 已修复并复审 | 无阻断。 |
| F-A05-01 | P2 | 已修复并复审 | 正式观察按 R-06/R-07 执行，不阻断集成。 |
| F-A05-02 | P1 | 实现已修复；owner 样本阈值待 R-06 | 正式观察保持 no-go，不阻断集成。 |
| F-A06-01 | P2 | 已修复并复审 | 无阻断。 |
| F-A07-01 | P1 | 未修复，明确延期为 no-go | 阻断 C-on 真实部署/执行；计划 SC-SCOPE 明确不阻断 A/B 与 C-off。I-12 对应验收只能在清理默认关闭的树上执行。 |
| F-A08-01 | P1 | 已修复并复审 | 无阻断。 |
| F-A08-02 | P2 | 已修复并复审 | 无阻断。 |

无未处置 correctness/security P1 影响默认关闭的 A/B 集成数据路径。F-A07-01 影响的是明确未获准的 C-on 路径，必须保持生产 no-go；不得把它写成已修复。

## 放行条件与后续顺序

- 允许开始 I-00 只读集成预演；不得覆盖/删除现有工作区改动。
- I-01…I-11 按技术方案列出的依赖和受影响源码切片顺序推进；每次整合行为冲突先补红测再修复。
- I-12 最终集成树验收时，打包清理配置保持默认关闭；cleanup boundary 检查必须通过。I-12 只验收功能集成，不得声称 C-on 已放行。
- SC-SCOPE/SC-SCOPE-PKG 是 C-on 真实清理前置；具体发布/数据集授权另按 C 类流程处理。
- 后置 M3-6/A-13 仍依赖 I-12；R 可在不启用补迁/清理的条件下单独评估，不因本结论自动发布。

## 证据与边界

- A-01…A-09 切片报告及 [A-10 finding register](./session-storage-refactor-m4-3-status.md#A-10-源码-finding-register2026-10-05)。
- A-10 定向验证：14 files/97 tests；补充 build identity 配置回归 4 tests；cleanup boundary、Electron typecheck、diff check 通过。
- 未执行 I-00…I-12、未合并 `origin/main`、未读取真实 profile、未构建/部署 C-on、未触碰真实会话。
