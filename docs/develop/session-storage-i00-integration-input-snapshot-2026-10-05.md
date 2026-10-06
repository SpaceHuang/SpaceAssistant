# I-00 集成输入刷新（2026-10-05）

## 快照身份

| 项目 | 值 |
| --- | --- |
| Worktree | `/Users/space/Documents/Develop/SpaceAssistant/.worktrees/session-storage-refactor-tdd` |
| Branch | `codex/session-storage-refactor-tdd` |
| Branch HEAD | `2961af96b1b02e297e2478b6297e592d9d9a40fb` |
| `origin/main` | `5440f7764b92d2512593c7bf139c21958b7f26a0` |
| Merge base | `e13d292eae30d0a2abd367ee83f9e6cdc7055648` |
| Ahead / behind | 28 / 21 commits |
| 当前 schema | 本工作区 v51（工作区未提交迁移）；branch HEAD v46；`origin/main` v33 |
| 工作区路径数 | 136（tracked modified 68 + untracked 68；不计本快照文件自身） |
| 未跟踪路径 | 68（本快照文件自身不计；其余为 tracked modifications 68） |
| HEAD-only merge-tree | 16 个内容冲突；输出树仅作只读预演，不包含未提交工作区改动 |

命令：`git status --porcelain=v1 --untracked-files=all`、`git rev-parse HEAD origin/main`、`git merge-base HEAD origin/main`、`git merge-tree --write-tree HEAD origin/main`。本记录生成期间未执行 merge/rebase/cherry-pick/reset/checkout，不改写任何既有路径。

## 冲突路径和 I-01…I-11 对应处理

| 冲突路径 | 所属集成切片 | 处理原则 |
| --- | --- | --- |
| `docs/develop/session-storage-refactor-technical-design.md` | I-00/I-11 | 保留 main 及存储分支的有效契约与历史证据；当前执行状态以本分支前置清单为入口，逐段合并，不整文件选边。 |
| `electron/database/schema.ts` | I-01 | 合并 main v31–v33 持久化语义与存储 v34+ schema；工作区 v47–v51 的变更也须逐项纳入，不能只用 HEAD-only merge-tree。 |
| `electron/database/migrations.ts` | I-01 | 保留 main v31–v33 与存储后续迁移的可执行链；验证 v30、v31、v32、v33、v46、工作区 v51 fixture 升级/reopen。 |
| `electron/database/migrations.agentHistory.test.ts` | I-01 | 保留双方 migration/history 回归，新增或调整 fixture 不删既有断言。 |
| `electron/database/migrations.v11.test.ts` | I-01 | 保留上游与当前迁移兼容测试。 |
| `electron/database/operations.ts` | I-02 | 同时满足 main 的会话/continuation/usage 字段语义与存储骨架/body/generation/cleanup/spill-GC 不变量。 |
| `electron/database/thinkingEffort.test.ts` | I-02 | 合并双方 schema/codec 期望，保留已有产品行为测试。 |
| `electron/database/usageStatsFacts.test.ts` | I-02 | 保留 main usage identity/事实字段与存储 recorder 兼容用例。 |
| `electron/appIpc.sessionUpdate.test.ts` | I-04 | 合并 renderer metadata 防伪与 storage 生命周期/清理围栏断言。 |
| `electron/ipc/sessionIpc.ts` | I-04 | 复用 main 授权/metadata/context handlers；保留 canonical read 与 session delete/spill-GC 顺序。 |
| `electron/outbound/outboundAcceptor.ts` | I-05 | 保留 main outbound retry/continuation queue 与 storage stable request ID、事务接受、retry lineage。 |
| `electron/runtime/canonicalHistory.ts` | I-03 | 保留 main snapshot replacement/dispatch recovery 与 storage stable IDs、跨 invocation fold、匿名 replay 过滤、tool/approval lifecycle/watermark fence。 |
| `electron/sessionTitleSuggest.ts` | I-06 | 沿用 main 标题 quota/触发/调度语义，只适配 canonical-aware reader。 |
| `package.json`、`package-lock.json` | I-11 | 先整合 package 源清单，再由锁文件工具生成/核验；禁止手工保留过期 lock 片段。 |
| `src/renderer/i18n/types.ts` | I-11 | 以完成后的源文案目录重新生成并比较，不手工拼生成类型。 |

与上述路径同一个存储行为切片的 untracked/modified 测试和实现按 A-00 冻结清单的唯一归属映射审查；不能因不在 HEAD-only 冲突输出中就丢弃。A-00 原冻结为 122 条；其后新增的 A-01…A-12 审阅材料、M3/M4 实现和测试、profile/estimate 产物、cleanup 发布资源等均为工作区输入，需先确认唯一归属，再决定保留/合并/转列，不能覆盖或删除。

## 路径处置类别

1. **主线已有能力（复用）**：目录授权撤销、continuation renderer、Butler task snapshot、SDK 未派发工具修复及标题产品策略。A-09 已确认相关未跟踪目录授权/context-compaction 文件与 `origin/main` 字节相同；集成时保留 main 语义并处理交叉点，不重复开发或扩大范围。
2. **存储重构实现/测试（保留并整合）**：schema/History/投影/迁移/cleanup/spill-GC/backup/measurement 与相应回归。按 I-01…I-10 所属切片逐项整合；所有存储主线输入都不能由“HEAD-only merge-tree 不显示”为由跳过。
3. **计划、审阅和测量证据（保留并归档）**：A-00…A-12 报告、profile/estimate JSON/Markdown、回滚 floor audit、状态页和本快照。链接保持有效，历史记录保留上下文；不纳入产品代码、不把真实 profile 证据当作当前授权。
4. **构建/验证资源（按 I-11 审查）**：release boundary 脚本、默认关闭的 bundle metadata、profile helper 和 package scripts。与 main 的构建命令逐项合并；不让资源或脚本启用 C-on。
5. **独立/无关上游改动（不重做）**：A-09 映射为 main 原有且不改变存储契约的能力，集成时采用上游实现；本工作区中的既有 path 只有在差异审阅证明完全重复时才可转列，当前 I-00 不删除、不覆盖。

## 冲突规模与风险

HEAD-only merge-tree 的 16 项冲突路径如上。关键风险集中在：

- migration 编号与升级链：main v33 和 branch v46/工作区 v51 的字段/表语义必须合并，保证受支持起点升级不跳步、不丢字段。
- History/operations/IPC/outbound：同一调用链承载两侧不同新增行为，需以目标字段合同、所有权及事务边界为判据。
- 锁文件/i18n：只能在源 manifest/源字符串稳定后重生成并验收。
- 工作区不是干净树：HEAD-only 预演不覆盖 135 项未提交输入，不能将预演树当作完整解决方案或直接套用。

## I-00 结论

- 刷新完成，当前可进入 I-01（schema/migration 集成）。
- 此报告不批准任何路径删除或覆盖，也不执行合并。
- I-01 之前先重新确认 `origin/main` 未移动；若 remote HEAD 变化，按影响更新本快照和冲突预演。
- 每项冲突解决前先读取 base/ours/theirs 和相关测试；行为缺陷先写失败回归，再修改实现。验证范围限本机可执行 host；Windows 包及外部平台验收不是 I-00/I-12 的本机阻断项。
- 清理配置仍必须默认关闭；真实 profile、真实停写/清列与 C-on 操作不在授权范围。
