# 阶段 3 与源码关闭证据（F42）

- 验收 HEAD：`2b534a9cb18a48583f80a587165ae59e69534343`（F41 证据/计划提交）；实现提交为 F40 `88cfbaa6`、F41 `47ec63cf`。
- 范围：阶段 1a、1b、1c、2、3 的源码、测试和证据；F42 只更新本计划与本证据，不改技术方案验收定义。
- 源码关闭结论：AC-1～AC-17 均有本机源码测试或阶段证据映射；源码关闭门禁通过。计划前言列明的正式跨平台打包、真实飞书/微信审批链路及真实用户脚本效果没有在本次源码验收中执行，标记为**待外部验收**，不据此声称完整平台验收完成。

## AC 证据矩阵

| AC | 本机源码证据 | 覆盖摘要 |
|---|---|---|
| AC-1 | F01、F02 | source range、片段及 golden 逐条检查 |
| AC-2 | F02 | 同 pattern 多处命中保留为多条 finding |
| AC-3 | F02、F30、F34、F36 | finding 键名、12 类产出、策略派生与旧模型退役 |
| AC-4 | F36、F37 | desktop / WeChat / Feishu 策略 lane 等价矩阵及唯一纯未知写入例外；真实 IM 服务验收仍待外部 |
| AC-5 | F34、F35 | 移除类别策略规则的反向验证与替代规则契约 |
| AC-6 | F03、F30、F31 | 失败覆盖度、失败呈现与记忆资格边界 |
| AC-7 | F01、F02 | 单次 Python 语法树解析计数 |
| AC-8 | F02、F10、F41 | facts 保留完整发现与总数；UI 消费端折叠显示，不改变事实 |
| AC-9 | F36 | 移除事实侧 verdict 与按链路动作分支 |
| AC-10 | F11、F41 | 默认 3 条、展开/收起、跨卡片状态隔离与本地化 |
| AC-11 | F40 | 完整审计事件到 JSONL 的结构投影、摘要引用、总数与截断标记 |
| AC-12 | F03、F37 | 位置/扫描失败与网络、路径、未认证、用户覆盖、旧缓存等策略组合；执行器批准前不调用 |
| AC-13 | F31、F35、F37 | D-5 路径类别、lane、套餐、自动化与记忆组合 |
| AC-14 | F40 | 最终落盘投影骨架无字面量，嵌套/凭证形状/超长行/普通代码用例 |
| AC-15 | F40 | 同定位不同内容摘要变化、同内容复算稳定、摘要先于投影/截断 |
| AC-16 | F20、F21、F22 | 审批材料差异、来源充分性、预算截断及确定性降级/真人 fallback |
| AC-17 | F33、F34、F35、F37 | D-5 dynamicKinds 矩阵与排除式 token，真实 extractor→策略链集成断言 |

各证据文件保留具体用例名、命令、结果和回退边界；阶段 1a/1b/1c、阶段 2 的关闭证据分别见 `phase-1a.md`、`phase-1b.md`、`phase-1c.md`、`phase-2.md`。依赖顺序为 F00→1a→1b→1c→2→3；各阶段只依赖此前产出的实现/检查点，没有验收自环。

## 最终源码门禁

- `npm test`：1259 files passed / 1 skipped；12279 tests passed / 140 skipped；退出码 0。单一全量运行时长 1261.28s。
- `npm run typecheck:shared`：通过。
- `npm run typecheck:renderer`：通过。
- `npm run i18n:check`：通过；0 个 source 硬编码中文，1891 条测试文件中文符合仓库豁免。
- `npm run check:system-invariant-registry`：通过，12 registrations / 42 references；正反 fixture 均通过。
- `npm run build`：通过，包含 tray icons、renderer、electron、agent provider、session-storage 边界门禁与 build fingerprint。Vite 输出 dynamic-import 与 chunk-size 非致命警告，构建退出码 0。
- `git diff --check`：通过；验收 HEAD 工作树干净。

## 整阶段隔离回退审查

在临时 detached worktree `/Users/space/Documents/Develop/SpaceAssistant/.worktrees/script-finding-model-source-close-revert` 从验收 HEAD 逆序撤销 24 个源码阶段提交：F41 `47ec63cf`、F40 `88cfbaa6`、阶段 2 的 19 个提交（完整清单及排序见 `phase-2.md`）、F23 阶段实现 `ecd3fb9a`、F12 阶段实现 `90a04eee`、F04 阶段实现 `2c6d4a29`。两个旧阶段证据文件在 revert 时与实现提交发生 modify/delete 冲突；仅保留证据文档后继续，源码回退无未解决冲突。临时 worktree 在验证后移除。

- `git diff --exit-code 317d5789 HEAD -- electron src`：通过，回退后源码与 F00 兼容基线一致。
- 回退版本 `npm run typecheck:shared`：通过；`npm run build`：通过，证明类型与 renderer/electron 可构建。
- 回退源码中 `rawScriptAnalysis` 与旧 `script-analysis.signal/patterns` 兼容路径恢复；`scriptAudit`、`ScriptAuditRef` 和投影器实现不再存在，因而回退代码停止新增 finding 审计引用。
- 回退只在隔离 worktree 进行，没有清理或改写任何既有 JSONL 审计历史；F40 本身也没有数据库迁移或历史记录删除逻辑。

## 安全逻辑阶段、规则与不变量

- **facts**：`scriptAnalysisExtractor` / Python analyzer 产生 12 类结构化 finding、range、coverage、totalCount；位置或扫描失败产出失败覆盖度及提取失败事实。边界由 F03、F30、F37 覆盖。
- **policy**：`scriptClassDisposition` 与共享 Policy Engine 派生 finding/path token；稳定规则包括 `script-unresolved-write-review`、`script-non-write-path-confirm`、`script-analysis-incomplete-confirm` 与 `automation-script-path-unknown-deny`。策略决策和 trace 继续由 Policy Engine 管理，F34～F37 覆盖矩阵及反向行为。
- **final-check**：既有 `scriptApprovalBinding.sha256` 与审核材料 `contentDigest` 在 agentChannel 做一致性核验；缺失、不充分或不匹配时，在审批模型调用前确定性降级为 `agent-undetermined`/真人 fallback。F20～F22 覆盖该边界；本计划未另建 final-check 规则。
- **invariant**：没有新增不可配置系统 invariant；`npm run check:system-invariant-registry` 验证 12 registrations / 42 test references 及正反 fixture。
