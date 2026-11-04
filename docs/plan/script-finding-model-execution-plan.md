# 脚本安全判定 finding 化执行计划

> 状态：待执行；本计划编制不代表代码任务已开工。
> 规格唯一来源：[脚本安全判定 finding 化技术方案](../develop/safety-approval/in-flight/script-finding-model-technical-design.md)；所有 `D-*`、`INV-*`、`AC-*` 与阶段边界均引用该方案，本计划不重写验收与安全不变量。
> 写作依据：[执行计划写作指南](../rules/execution-plan-writing-guide.md)。计划只登记任务、依赖与执行证据。

## 0. 交付边界【人必读】

**一句话：** 将脚本安全分析改为逐条可核验的发现，并把发现安全地送到确认卡片、审核材料、策略和审计，同时保持决策权留在策略层。

**只有三分钟的话：** 看本节、阶段边界、唯一依赖表和 AC 映射。方案中的 D-1、D-3、D-4、D-5 均已批准；D-2 属策略层，本计划不重新决策。

**本机可完成：** Python 分析与位置传递、确认载荷和渲染、审批材料组装与降级、策略/路径分类矩阵、审计投影、定向测试、类型检查、构建和回退代码审查。所有开发门禁均使用本机 fixtures 与仓库命令。

**外部验收：** 不同 OS 的正式打包行为、真实飞书/微信审批链路及真实用户脚本效果如执行时需要，单列记录，不作为源码阶段前置；方案 AC-1～AC-17 的本机可验证部分不得因此延期。没有外部环境证据时，只能报告源码与本机验证完成，不能宣称真实渠道/跨平台验收完成。

**工作区保护：** 当前工作区存在多处其他未提交及未跟踪文件。执行 F00 时必须重新记录 HEAD、工作区状态及本方案实际版本；不得清理、重置、暂存或提交无关改动。目标文件若混有无法归属的改动，先隔离差异或暂停该文件上的写入，不影响独立只读盘点。

**执行与估算：** 默认单执行者串行，1b 与 1c 虽可独立验收，也不默认并行，因为共享类型与确认载荷有重叠。粗估：1a 大（IR 全节点位置与失败兜底不确定性高）；1b 中；1c 大（充分性、材料预算和受控回读需用样本校准）；阶段 2 大（剩余九类覆盖和策略迁移）；阶段 3 中。F00 完成后按实际检测编号/测试基线更新估算；若范围或阶段预计超过原估算一倍，先重估任务切分，不改变方案规格。

**无需重新决定：** 入口定位、契约调用方清点、测试组织、故障注入、策略对拍及本机回退审查由执行者完成。方案附录 E 中 `script-dangerous-deny` 的底线条目问题属于独立小决策；不把它并入本轮，也不以它阻塞与之无关的源码任务。若实施发现该决策会改变本方案 AC 或既有 floor，暂停相关策略改动并先修订方案。

## 1. 编排与证据规则【人机共读】

### 1.1 阶段边界

沿用方案“阶段与迁移”表中的 1a、1b、1c、2、3。任务依赖唯一记录在 §2；本表只界定阶段范围。

| 阶段 | 输入与允许范围 | 独立产出与阶段出口 | 回退与兼容处理 |
|---|---|---|---|
| 1a 位置与发现 | F00 基线；IR、Python adapter、内容分析与提取器；保留旧结论与兼容字段 | 逐节点位置信息、首批三类发现及可选事实字段；阶段测试、golden 与解析次数证据通过 | 撤回本阶段提交；旧结论仍供既有规则消费。仅允许方案 INV-2/AC-12 明定的“内容分析失败/位置缺失”裁决例外改为锁定人工、定时任务拒绝；其余既有结论对应动作逐项不变 |
| 1b 确认卡片 | 1a 已完成；确认载荷及渲染组件 | 全量发现到达卡片；3/4/多条、展开、键盘可达行为通过 | 移除可选载荷字段与新增分区；1a 事实能力独立保留 |
| 1c 审核材料 | 1a 已完成；线索包、审核材料构造与渲染 | `scriptEvidence` 原文片段及结构证据、预算/充分性/确定性降级通过 | 撤回 `scriptEvidence` 组装与渲染；1a/1b 可独立保留 |
| 2 语义矫正 | 入口依赖 F12/F23 收口；先补齐其余九类发现、迁移记忆资格并准备旧模型兼容，再实现路径分类、替代映射与规则，最后原子切换/退役 | 12 类生产样本、记忆资格迁移、替代规则证据、旧模型退役清单、D-5 token、policy trace、矩阵及反向测试通过 | 替代规则准备阶段可单独回退；F36 切换与退役同批整体 revert |
| 3 清理与收口 | 阶段 2 完成；审计、旧字段清理、i18n 和全量回归 | AC-1～AC-17 映射完整；全量测试、类型/i18n、审计边界及源码回退审查证据齐备 | 各清理项可独立 revert；审计历史按方案保留，不做数据删除或迁移 |

阶段 1b 与 1c 可在 1a 之后按 §2 独立验收，但默认串行执行。阶段 2 的准备任务可在 F04 后开始；F36 正式切换任务必须等待 F12、F23 收口以及 F34/F35 替代映射/规则验证完成。方案阶段 1a 的“策略行为不变”按阶段表所列唯一失败裁决例外解释；AC-9 仅在 F36 关闭。每个实现阶段关闭均执行阶段定向验证、全量 `npm test`、阶段证据记录和阶段提交；阶段中开发迭代仍只跑定向测试。阶段提交仅纳入该阶段范围文件；提交前检查暂存清单与证据中的文件清单一致，不夹带用户现有改动。

### 1.2 基线与 RED/GREEN

F00 先核对依赖、测试可启动性与基线。若方案文档当前未跟踪，记录其文件摘要/版本和实际 HEAD；方案自述的历史代码基线不自动等同于执行时 HEAD。基线故障分为环境问题与既有失败，记录命令、用例、HEAD 和影响范围，不把既有失败当作新 RED。

缺失行为先记录真实预期 RED（用例名、命令、缺失行为）；已有行为记录基线 GREEN，不人为制造失败。每阶段合并执行受影响测试；阶段 3 执行仓库规定的最终验收。所有证据写入 `docs/plan/evidence/script-finding-model/`，每个任务记录实际 HEAD、变更文件、用例、命令、退出码及 AC 覆盖范围；不得记录脚本正文、凭证或敏感载荷。

## 2. 唯一依赖表【机｜人工可跳过】

“前置任务完成”指其产物与验证证据齐备。外部验收不进入依赖列。

| 任务 | 阶段 | 前置任务 | 额外前置证据 |
|---|---|---|---|
| F00 基线与入口盘点 | 1a | 无 | 无 |
| F01 位置贯通与 IR 适配 | 1a | F00 | 无 |
| F02 发现模型与内容分析生产 | 1a | F01 | 无 |
| F03 提取器与失败兜底事实 | 1a | F02 | 无 |
| F04 1a 阶段收口 | 1a | F03 | 无 |
| F10 确认载荷传递 | 1b | F04 | 无 |
| F11 确认卡片展示 | 1b | F10 | 无 |
| F12 1b 阶段收口 | 1b | F11 | 无 |
| F20 审核证据契约 | 1c | F04 | 无 |
| F21 线索包与审批材料接线 | 1c | F20 | 无 |
| F22 充分性、预算与确定性降级 | 1c | F21 | 无 |
| F23 1c 阶段收口 | 1c | F22 | 无 |
| F30 补齐九类发现生产 | 2 | F04、F12、F23 | 无 |
| F31 迁移记忆资格消费者 | 2 | F30 | 无 |
| F32 准备旧模型切换清单与兼容适配 | 2 | F30、F31 | 无 |
| F33 路径事实多值分类 | 2 | F32 | 无 |
| F34 类别映射与 token 派生 | 2 | F33 | 无 |
| F35 按映射改写规则与 policy trace | 2 | F34 | 无 |
| F36 原子切换并退役旧结论模型 | 2 | F12、F23、F35 | 无 |
| F37 真实链路矩阵与反向测试 | 2 | F36 | 无 |
| F38 关闭阶段 2 | 2 | F37 | 无 |
| F40 审计结构投影与摘要 | 3 | F38 | 无 |
| F41 旧回传字段、展示派生与文案收口 | 3 | F38 | 无 |
| F42 最终回归与源码关闭 | 3 | F40、F41 | 无 |

不另绘 DAG；表是唯一依赖真源。F32 只盘点与建立兼容适配，不宣称旧模型退役；待 F34/F35 的替代映射和规则有独立证据后，由 F36 原子切换并退役旧生产/消费。F30 的前置包含 F12 与 F23，使整个阶段 2 的依赖闭包不能绕过确认卡片和审批材料收口；F36 另显式汇合这两个消费面门禁。接入测试不承担未登记实现。方案与同域计划存在文件冲突时按方案既定次序执行：本方案先行；这只是冲突管理，不依赖另一个计划的功能产物或外部提交。若执行时同域代码已先落地，先基于实际 HEAD 重新盘点重叠差异并调整冲突解法，不等待未发生的外部计划。

## 3. 任务清单【机｜人工可跳过】

所有状态初始为未开始。目标范围是允许改动文件；新增测试放在同目录既有测试约定位置。完成项须附任务证据路径。阶段 F04、F12、F23、F38 均执行本阶段定向测试、全量 `npm test`、对应类型/构建门禁、阶段证据记录与阶段提交；阶段内迭代只运行定向测试。增量主进程构建每阶段最多一次。

### 阶段 1a：位置与发现

- [x] **F00 核对基线与调用入口**（本机）
  - 范围：只读方案、`package.json`、`electron/shell/scriptContentSecurity.ts`、`electron/shell/scriptIr/`、`electron/confirmation/extractors/scriptAnalysisExtractor.ts`、`electron/confirmation/toolCallGate.ts`、`src/shared/confirmation/types.ts`；记录实际 HEAD、`git status --short` 与方案摘要。
  - 产物/判据：真实生产调用链、测试落点与受影响文件表；确认解析调用次数、脚本发现所有消费方及路径事实入口；指出现有未提交差异的归属，不覆盖他人改动。
  - 验证：`git rev-parse HEAD`、`git status --short`；`rg -n 'parsePythonModule|analyzeScriptContent|extractScriptSignals|extractScriptPathFacts' electron src`；`npm exec vitest run electron/shell/scriptIr/pythonAdapter.test.ts electron/shell/scriptContentSecurity.test.ts electron/shell/scriptContentSecurity.b.test.ts electron/shell/scriptContentSecurity.residual.test.ts electron/shell/scriptGolden.test.ts electron/confirmation/extractors/extractors.test.ts electron/confirmation/extractors/scriptParseCount.test.ts electron/confirmation/extractors/scriptPathFacts.test.ts electron/confirmation/toolCallGate.test.ts`（9 files / 561 tests passed）。关联 AC-1～9/12/17 的基线，不关闭 AC。证据：`docs/plan/evidence/script-finding-model/F00.md`。

- [x] **F01 在 IR 转换中保留节点位置**（本机）
  - 范围：`electron/shell/scriptIr/types.ts`、`electron/shell/scriptIr/pythonAdapter.ts`、对应 adapter 测试与必要快照。
  - 产物/判据：语法树到 IR 的每条可消费节点都保留 1-based 源位置；结构性穿透节点不丢位置，未知/无法映射位置以明确失败表达，不产生无位置发现；受影响 adapter 既有建模行为无退化。
  - 验证：`npm exec vitest run electron/shell/scriptIr/pythonAdapter.test.ts electron/shell/scriptGolden.test.ts electron/confirmation/extractors/scriptParseCount.test.ts`（3 files / 170 tests passed）；`npm exec tsc -- --noEmit -p tsconfig.electron.json`；`git diff --check`。关联 AC-1、AC-7。证据：`docs/plan/evidence/script-finding-model/F01.md`。

- [x] **F02 产出首批三类逐条发现并保留兼容旧结论**（本机）
  - 范围：`electron/shell/scriptContentSecurity.ts`、`electron/confirmation/extractors/scriptAnalysisExtractor.ts`、`src/shared/confirmation/types.ts` 与相关测试。
  - 产物/判据：按方案《发现结构》对 `file-write`、`destructive-fs`、`process-creation` 首批类别逐处产出发现；重复 pattern/range 命中仍逐条保留；键名不表达动作/建议；全量发现与总数进入可选字段，事实字段本身不承载动作。为兼容现有策略，旧 verdict/signal 及旧动作逻辑暂保留；此任务不声称 AC-9 完成。golden 每条发现均有位置和片段。
  - 验证：`npm exec vitest run electron/shell/scriptContentSecurity.test.ts electron/shell/scriptContentSecurity.b.test.ts electron/shell/scriptContentSecurity.residual.test.ts electron/shell/scriptGolden.test.ts electron/confirmation/extractors/extractors.test.ts electron/confirmation/extractors/scriptParseCount.test.ts electron/confirmation/toolCallGate.test.ts`（7 files / 405 tests passed）；另 `npm run typecheck:shared`、`npm exec tsc -- --noEmit -p tsconfig.electron.json` 与 `git diff --check` 均通过。关联 AC-1～4、7、8；AC-9 留待 F36。证据：`docs/plan/evidence/script-finding-model/F02.md`。

- [x] **F03 将位置缺失收敛为提取失败事实**（本机）
  - 范围：`electron/confirmation/extractors/scriptAnalysisExtractor.ts`、`electron/confirmation/toolCallGate.ts`、方案所指失败分类/锁定规则落点及对应集成测试（实现前从 `defaultRules.ts` 与 policy engine 实际位置定位）。
  - 产物/判据：位置缺失或二次扫描异常时整次内容分析 coverage failed，脚本类发现和 token 作废；专用锁定条目经真实装配与引擎落回答者为人；拒绝优先，路径 complete/unknown、网络命中、相对路径写入、语言未认证、用户动作覆盖、旧 allow 缓存组合均不越过人工确认；定时任务拒绝，批准前 executor 未调用。
  - 验证：`npm exec -- vitest run electron/confirmation/scriptAnalysisFailureGate.test.ts electron/confirmation/toolCallGate.test.ts electron/confirmation/extractors/extractors.test.ts electron/confirmation/extractors/scriptPathFacts.test.ts src/shared/policy/policyEngine.test.ts src/shared/policy/defaultRules.contract.test.ts`（6 files / 478 tests passed）；另 `npm run typecheck:shared`、`npm exec tsc -- --noEmit -p tsconfig.electron.json`、`npm run check:system-invariant-registry`、`git diff --check` 均通过。关联 AC-6、12。证据：`docs/plan/evidence/script-finding-model/F03.md`。

- [x] **F04 关闭 1a 阶段**（本机）
  - 范围：F01～F03 变更与相关测试；只记录阶段证据。
  - 产物/判据：F01～F03 证据齐全；golden 位置、重复命中、单次解析、失败组合均可复现；除方案明确的分析失败锁定裁决外，其余既有输入的 ruleId/动作/回答者对拍不变；失败样本单列证明新规则落人、定时任务拒绝；旧字段与旧动作消费者保持兼容。关联 AC-1～4、6～8、12 的 1a 部分；AC-9 不在本阶段关闭。
  - 验证：合并运行 F01～F03 定向测试（12 files / 708 tests passed）；`npm run build:electron:incremental`、`npm run typecheck:shared`、`npm test`（1,257 files passed / 1 skipped；12,184 tests passed / 140 skipped）。记录阶段提交 SHA、精确文件清单、依赖闭包及回退顺序；在隔离 worktree/临时 checkout 对阶段提交执行 revert，运行受影响 smoke 定向测试后丢弃隔离环境。证据：`docs/plan/evidence/script-finding-model/phase-1a.md`。源码回退实体为本阶段提交；旧策略和字段消费者保持兼容。

### 阶段 1b：确认卡片展示

- [x] **F10 将全量发现放入确认请求载荷**（本机）
  - 范围：`src/shared/confirmation/types.ts`、`electron/confirmation/toolCallGate.ts`、`electron/preload.ts`（仅若该载荷实际经过预加载定义）、确认请求生产/消费处与对应测试；先由 F00 事实清单确定具体调用方。
  - 产物/判据：新增字段可选可缺省，不改现有字段语义；载荷携带全量发现及总数，不在主进程预先按 UI 上限裁剪；旧请求缺字段路径兼容。
  - 验证：`npm exec -- vitest run src/shared/assistantFactAggregator.test.ts electron/runtime/invocationAssembler.test.ts`（2 files / 121 tests passed）；`npm run typecheck:shared`、`git diff --check` 通过。关联 AC-8、10。证据：`docs/plan/evidence/script-finding-model/F10.md`。

- [x] **F11 展示逐条发现并支持展开**（本机）
  - 范围：`src/renderer/components/Chat/` 中 F00 定位的确认卡片组件及测试、相关 i18n 资源。
  - 产物/判据：默认显示前三条；第四条起显示“另有 N 条”并可展开全部；总数不超过三时无展开控件；展开状态按单卡片隔离；键盘可达；字段缺省时保持旧界面；事实载荷不被展示逻辑修改。
  - 验证：`npm exec -- vitest run src/renderer/components/Chat/ScriptConfirmCard.test.tsx`（1 file / 11 tests passed，含 0/1/3/4/8 条、展开、卡片状态隔离和键盘焦点）；`npm run typecheck:renderer`、`npm run i18n:check` 均通过。关联 AC-10。证据：`docs/plan/evidence/script-finding-model/F11.md`。

- [x] **F12 关闭 1b 阶段**（本机）
  - 范围：F10/F11 与阶段证据。
  - 产物/判据：本阶段测试及类型/i18n 门禁通过；与 1a 分开回退时旧载荷仍可渲染；不影响分析侧全量事实。关联 AC-8、10。
  - 验证：F10/F11 合并定向测试（3 files / 132 tests passed）；`npm run typecheck:renderer`、`npm run typecheck:shared`、`npm run i18n:check` 通过；`npm test`（1,257 files passed / 1 skipped；12,192 tests passed / 140 skipped）。记录阶段提交 SHA、精确文件清单、依赖闭包和回退顺序；在隔离 checkout revert 阶段提交并运行确认卡片 smoke 定向测试。证据：`docs/plan/evidence/script-finding-model/phase-1b.md`。回退时同时移除载荷生产与渲染消费，保留可选字段缺省兼容。

### 阶段 1c：审批材料

- [x] **F20 定义审核证据契约**（本机）
  - 范围：`src/shared/confirmation/types.ts` 与新增/扩展共享类型测试。
  - 产物/判据：审核证据类型包含方案契约要求的来源、位置、原文片段/结构化证据、coverage、totalCount、truncated、sufficiency/status；字段可选性、缺省行为和审核材料预算语义与方案一致。该类型不依赖审计投影格式；不在此任务实现审计投影器。
  - 验证：`npm exec tsc -- --noEmit --target ES2022 --module ESNext --moduleResolution bundler --skipLibCheck src/shared/confirmation/scriptApprovalEvidence.test.ts`、`npm exec -- vitest run src/shared/confirmation/scriptApprovalEvidence.test.ts`（1 file / 1 test passed）、`npm run typecheck:shared` 均通过。类型测试覆盖旧线索包缺省、完整证据和 partial/undetermined 形状。关联 AC-16 契约部分。证据：`docs/plan/evidence/script-finding-model/F20.md`。

- [x] **F21 把脚本证据送达审批材料**（本机）
  - 范围：`electron/confirmation/agentChannel.ts`、`electron/confirmation/approvalAgent.ts`、相关 clue extras/审批测试及 `src/shared/confirmation/types.ts`。
  - 产物/判据：线索包含 `scriptEvidence`，审核材料实际呈现原文片段与结构化证据（非仅 kind 或审计骨架）；骨架相同而 host/path/argv 不同的样本在最终材料中可区分；材料摘要与执行对象绑定；超预算保留总数及截断标记，必要的受控回读仅读取本次调用脚本。
  - 验证：`npm exec -- vitest run electron/confirmation/agentChannel.test.ts electron/confirmation/approvalAgent.test.ts src/shared/confirmation/scriptApprovalEvidence.test.ts`（3 files / 86 tests passed）；最终材料断言比较不同 host/path/argv 内容。`npm run typecheck:shared` 通过。关联 AC-16。证据：`docs/plan/evidence/script-finding-model/F21.md`。

- [x] **F22 对不充分或截断材料确定性转人工**（本机）
  - 范围：`electron/confirmation/agentChannel.ts`、`electron/confirmation/approvalAgent.ts` 与相关审批链路测试。
  - 产物/判据：不可核验来源标记 insufficient；材料不足、超预算或必要内容缺失时整体 undetermined，审批链路确定性要求人工，不交由模型自行裁量；正常充足材料仍保留可区分证据。
  - 验证：`npm exec -- vitest run electron/confirmation/agentChannel.test.ts electron/confirmation/agentChannel.clueExtras.test.ts electron/confirmation/approvalAgent.test.ts electron/confirmation/agentSdkConfirmationPort.test.ts src/shared/confirmation/scriptApprovalEvidence.test.ts`（5 files / 119 tests passed）；覆盖充分材料、超预算、片段过长、partial coverage、缺绑定/缺发现，并断言不足材料不调用 Agent、返回 `agent-undetermined`；既有桌面人工 fallback 集成测试通过。`npm run typecheck:shared` 通过。关联 AC-16。证据：`docs/plan/evidence/script-finding-model/F22.md`。

- [x] **F23 关闭 1c 阶段**（本机）
  - 范围：F20～F22 与阶段证据。
  - 产物/判据：共享契约、最终材料内容和降级行为可独立验证；1c 回退不会破坏 1a/1b。关联 AC-16。
  - 验证：F20～F22 合并回归（5 files / 119 tests passed）；`npm run typecheck:shared`、`npm run typecheck:renderer`、`npm run build:electron:incremental` 均通过；`npm test`（1258 files passed / 1 skipped；12198 tests passed / 140 skipped）。隔离 detached worktree revert `ecd3fb9a` 后 agentChannel/approvalAgent smoke（2 files / 80 tests passed）。证据：`docs/plan/evidence/script-finding-model/phase-1c.md`。阶段回退包括该阶段引入的共享字段与所有该阶段消费者，不能只撤类型或只撤主进程接线。

### 阶段 2：语义矫正

- [x] **F30 补齐其余九类发现生产**（本机）
  - 范围：`electron/shell/scriptContentSecurity.ts`、`electron/confirmation/extractors/scriptAnalysisExtractor.ts`、`electron/shell/scriptIr/` 中实际需要的节点模型、`src/shared/confirmation/types.ts` 与对应单测/golden。覆盖 `dynamic-execution`、`dynamic-import`、`native-code-load`、`network-api`、`cwd-change`、`reflection`、`alias-resolution`、`decode-then-exec`、`dynamic-dispatch`。
  - 产物/判据：方案 12 类每类均有生产样本及逐条发现证据；类别证据字段严格按方案契约；无法分类的构造产生方案规定的 partial/failed 覆盖信息，不静默当干净；旧 verdict/signal 与既有动作逻辑暂留作兼容，不在本任务切换决策。需先按方案类别表逐项确认三类首批与九类剩余的边界，避免类别重复或遗漏。
  - 验证：`npm exec -- vitest run electron/shell/scriptContentSecurity.test.ts electron/shell/scriptGolden.test.ts electron/shell/scriptParserService.test.ts electron/shell/scriptIr/pythonAdapter.test.ts electron/confirmation/scriptAnalysisFailureGate.test.ts`（5 files / 230 tests passed）；新增 12 类类别样本、动态边界与 parse-failed 覆盖断言，golden 检查所有产物 range/snippet 且旧 verdict/patterns/signal 基线通过。关联 AC-1～3、6～8。证据：`docs/plan/evidence/script-finding-model/F30.md`。

- [x] **F31 将记忆资格迁移到发现集合与覆盖度**（本机）
  - 范围：`src/shared/policy/memoryEligibility.ts`、调用方/类型及其测试。
  - 产物/判据：资格从旧 `signal` 三档迁到方案规定的发现集合与 coverage；明确 clean、partial、failed 与各类别的资格结果；可选记忆档位不因字段缺省意外放宽，记忆写入仍遵守方案边界；保留旧字段时不得继续让新路径资格判定依赖旧 verdict。
  - 验证：`npm exec -- vitest run src/shared/policy/memoryEligibility.test.ts src/shared/policy/policyEngine.test.ts src/shared/policy/policyPackages.scope.test.ts electron/confirmation/agentSdkSafetyPolicy.test.ts electron/confirmation/toolCallGate.test.ts`（5 files / 406 tests passed）；覆盖 12 类发现、complete 空发现、partial/failed、缺字段、旧形状、缓存 lookup 与审批档位。`npm run typecheck:shared` 通过。关联 INV-5、AC-6、13。证据：`docs/plan/evidence/script-finding-model/F31.md`。

- [x] **F32 准备旧模型切换清单与兼容适配**（本机）
  - 范围：`electron/shell/scriptContentSecurity.ts`、`electron/confirmation/extractors/scriptAnalysisExtractor.ts`、受影响类型/消费者、内容分析 golden 与规则对拍测试。
  - 产物/判据：形成旧字段/动作逻辑生产与消费点清单，逐点标注 F36 将删除、迁移或保留；建立短期兼容适配，使新旧事实可并行供旧规则消费，但尚不关闭 AC-9、不删除旧 verdict/signal。认证结论仍按方案状态所有权保持其独立责任，不混入发现事实。所有适配只承载兼容，不提前实现 F34/F35 的策略映射。
  - 验证：旧字段/生产/消费者清单见 `docs/plan/evidence/script-finding-model/F32.md`；`npm exec -- vitest run electron/confirmation/extractors/extractors.test.ts electron/shell/scriptGolden.test.ts`（2 files / 142 tests passed），断言 findings 与旧 signal/patterns/network token 并行；golden 旧规则基线通过。未新增类别策略映射。关联 AC-3/4 的准备证据；AC-9 留待 F36。证据：`docs/plan/evidence/script-finding-model/F32.md`。

- [x] **F33 按 D-5 分类路径动态原因**（本机）
  - 范围：`electron/confirmation/extractors/scriptPathFacts.ts`、其测试与共享路径事实类型。
  - 产物/判据：新增 `dynamicKinds` 多值并保留 `unknownReason`；覆盖 open mode 读写、Path 读写、删除、搬运、代码执行、绑定链断裂、不可用及旧形状缺省保守归类；只有纯未知写入能构成获批域，读取/删除/搬运不被标成 write。
  - 验证：`npm exec vitest run electron/confirmation/extractors/scriptPathFacts.test.ts electron/confirmation/extractors/scriptParseCount.test.ts`；按 AC-17 分类矩阵逐格断言。关联 AC-17。证据：`F33.md`。

- [x] **F34 将类别映射与聚合 token 放在策略域**（本机）
  - 范围：`src/shared/policy/scriptClassDisposition.ts`（新建）、`src/shared/policy/policyEngine.ts`、策略 token 派生所在模块及测试。
  - 产物/判据：类别到动作的唯一映射位于共享策略域；派生每个 kind token、兼容聚合 token、仅纯写入时的 write-target-only token；旧字段/未知类别采用保守路径；事实生产器不依赖策略作决定。
  - 验证：映射单测、缺字段/未知类别保守测试、删除映射规则的反向测试；`npm run typecheck:shared`。关联 AC-3～5、9、17。证据：`F34.md`。

- [x] **F35 按类别映射重写规则并保留人工 floor**（本机）
  - 范围：`src/shared/policy/defaultRules.ts`、policy trace、lint/contract 测试及规则装配模块。
  - 产物/判据：逐条核对方案受影响规则并把三档条件换为类别条件；两条旧锁定规则排除纯写入 token；新 `script-unresolved-write-review` 只覆盖纯写入；桌面标准档走 auto-evaluator，strict/custom、远程询问，定时任务拒绝；其他分类保留人工 floor；稳定 rule ID/reason trace 完整。
  - 验证：default rules contract/lint 与 policy engine 测试；`npm run check:system-invariant-registry`、`npm run typecheck:shared`。关联 AC-4、5、9、13、17。证据：`F35.md`。

- [x] **F36 原子切换并退役旧结论模型**（本机）
  - 范围：`electron/shell/scriptContentSecurity.ts`、`electron/confirmation/extractors/scriptAnalysisExtractor.ts`、`src/shared/confirmation/types.ts`、策略信号派生/规则装配、`src/shared/policy/memoryEligibility.ts` 与旧模型兼容测试。
  - 产物/判据：仅在 F34/F35 替代映射、规则及 policy trace 已验证后，同一变更单元切换到 findings/categories 并移除旧 verdict/三档 signal 与旧动作消费者；切换完成后 12 类生产输入均有对应规则消费，认证结论继续由原独立所有者提供。旧→新三链路动作对拍通过，唯一差异按 AC-4 单列；旧字段 `rg` 清单中无未解释生产/消费点。该任务关闭 AC-9。
  - 验证：规则/信号适配和旧模型退役回归、三链路 golden 对拍；`rg -n 'verdict|signal\\.(signal|patterns)|networkVerdict' electron src/shared`；`npm run typecheck:shared`。关联 AC-3、4、9。证据：`F36.md`。

- [x] **F37 验证真实提取到引擎的组合矩阵**（本机）
  - 范围：`electron/confirmation/toolCallGate.ts`、提取器、策略装配/引擎集成测试及必要 butler 调用测试。
  - 产物/判据：只承担接通和断言，不新增业务逻辑；真实链路覆盖 AC-4、12、13、17 逐格矩阵；路径未知写入仅桌面 standard 在快通道未裁决时交审核 agent；读取/删除/搬运/绑定断裂/不可用、eval/进程/动态导入维持人工确认；strict/custom、微信/飞书、定时任务维持方案结果；批准不写长期记忆；拒绝优先，批准前 executor 不调用。
  - 验证：真实 extractor→rule assembly→engine 集成测试，并合并运行 F30～F36 覆盖的相关测试。关联 AC-4、12、13、17。证据：`F37.md`。

- [x] **F38 关闭阶段 2**（本机）
  - 范围：F30～F37 变更、快照与测试。
  - 产物/判据：12 类均有生产样本；旧字段生产/消费者清单关闭；记忆资格迁移证据齐备；全部矩阵和反向测试通过；回退单元与依赖闭包登记，提交仅含阶段文件。
  - 验证：合并运行阶段定向测试、`npm run typecheck:shared`、`npm run build:electron:incremental`、`npm run check:system-invariant-registry`、`npm test`。记录阶段提交 SHA、精确文件、回退顺序；在隔离 checkout revert 本阶段提交并运行 F36/F37 策略 smoke 测试。证据：`phase-2.md`。

### 阶段 3：清理与收口

- [ ] **F40 写入结构投影审计与内容摘要**（本机）
  - 范围：`electron/confirmation/securityAuditLog.ts`、`src/shared/confirmation/scriptSnippetProjection.ts`（新建，审计阶段唯一实现）、审计类型及 `electron/confirmation/securityAuditLog.test.ts`。
  - 产物/判据：定位键与 `snippetSha256` 分离；摘要基于原始片段、统一换行、不 trim/截断/投影，之后才截断与投影；落盘只含骨架、无字面量，包含方案要求的会话/轮次/总数/截断标记；既有脱敏作为第二道防线；不写整份脚本，不新增持久化迁移。
  - 验证：从完整审计事件经写入函数到最终 JSONL 的用例覆盖嵌套、凭证形态、长行、普通代码；同键不同内容摘要不同、同片段复算一致；确认测试凭证不在落盘文本。关联 AC-11、14、15。证据：`F40.md`。

- [ ] **F41 删除旧回传字段并完成展示/i18n 收口**（本机）
  - 范围：方案指定无人读取的原始回传字段消费者、`summary.sections` 生成路径、12 类类别与证据短语 i18n 资源及测试；不改与本功能无关的 UI。
  - 产物/判据：仅在确认无消费者后删除原始回传字段；summary.sections 由展示层按方案派生；类别与证据短语的 zh-CN/en-US key 对齐；展示上限仍只在消费方，事实侧无截断。
  - 验证：`rg` 检查字段读写点并记录；受影响定向测试；`npm run i18n:check`，必要时 `npm run i18n:check:strict`。关联 AC-8、10 及方案阶段 3 的 i18n 收口范围。证据：`F41.md`。

- [ ] **F42 完成源码关闭与回退审查**（本机）
  - 范围：全方案变更与相应测试；只更新本计划证据，不改技术方案验收定义。
  - 产物/判据：AC-1～AC-17 各有可追溯用例/证据映射；1a/1b/1c/2/3 的实现与检查点无循环依赖；全量测试、类型检查、i18n 与必要构建通过；回退实体与方案阶段表一致，审计数据不通过删历史实现回退。将 AC 证据分为本机源码证据与方案要求的外部/平台证据；仅后者缺失时标注“待外部验收”，不声称完整 AC 关闭，也不阻塞源码关闭。涉及安全逻辑时记录 facts/policy/final-check/invariant 阶段、rule/invariant ID 与门禁结果。
  - 验证：`npm test`、`npm run typecheck:shared`、`npm run typecheck:renderer`（若有渲染变化）、`npm run i18n:check`、`npm run check:system-invariant-registry`、`npm run build`、`git diff --check`。在隔离 checkout 按阶段依赖逆序回退本计划各阶段提交，验证代码/类型可构建且旧兼容路径恢复；审计 JSONL 历史不删除，只确认回退版本停止新增 finding 字段。若当前主机无法执行其他平台打包或真实渠道检查，将其记入外部验收记录，不作为源码关闭门禁。证据：`phase-3-and-source-close.md`。

## 4. 阶段门禁与 AC 映射【机｜人工可跳过】

阶段门禁只引用此前已完成任务的证据；本节不新增方案 AC。

| 阶段关闭任务 | 允许关闭的证据来源 | 引用方案 AC |
|---|---|---|
| F04 | F01、F02、F03 | AC-1～4、6～8、12 的 1a 部分；AC-9 不在此关闭 |
| F12 | F10、F11 | AC-8、10 |
| F23 | F20、F21、F22 | AC-16 |
| F38 | F30～F37；其依赖闭包包含 F12/F23 | AC-3～5、6、9、12、13、17 |
| F42 | F40、F41 与此前全部阶段证据 | AC-1～17 |

| 方案 AC | 主要任务证据 | 说明 |
|---|---|---|
| AC-1 | F01、F02 | 每条发现位置与片段 |
| AC-2 | F02 | 同 pattern 多处命中逐条产出 |
| AC-3 | F02、F30、F34、F36 | 发现字段命名、12 类产出及旧模型退役 |
| AC-4 | F36、F37 | 三链路等价及唯一例外 |
| AC-5 | F34、F35 | 移除类别规则的反向验证 |
| AC-6 | F03、F30、F31 | 失败覆盖度、呈现语义及记忆资格 |
| AC-7 | F01、F02 | 单次语法树解析 |
| AC-8 | F02、F10、F41 | 全量事实，消费侧截断且保留总数 |
| AC-9 | F36 | 替代规则就绪后原子退役旧动作逻辑 |
| AC-10 | F11 | 确认卡默认三条与展开 |
| AC-11 | F40 | 审计骨架、摘要与引用字段 |
| AC-12 | F03、F37 | 失败事实×安全边界组合 |
| AC-13 | F31、F35、F37 | D-5 策略组合及记忆边界 |
| AC-14 | F40 | 投影安全与最终落盘文本 |
| AC-15 | F40 | 摘要输入和计算顺序 |
| AC-16 | F20～F22 | 审批材料可区分、充分性与降级 |
| AC-17 | F33～F35、F37 | 分类矩阵及排除式 token |

## 5. 交付前自检【机｜人工可跳过】

- 依赖只登记在 §2；阶段收口只引用此前任务证据，无自环、跨阶段环或验收自环。
- 源码开发全部能在本机执行；外部环境证据不进入开发前置。
- F30 与 F36 的依赖闭包均包含 F12/F23；F32 仅准备适配，F36 在 F34/F35 可验后才切换退役。
- 本计划只引用方案 AC/INV/D，不重写真源；方案若改动，先核对映射失效范围再更新计划。
- 每个任务具备范围、产物、完成判据、命令/证据和环境标记；无代码状态时统一未开始。
- 阶段 2 的事实和规则作为单一回退单位；阶段 3 审计为追加文件，回退只停写新字段，不删除历史。每阶段提交 SHA、依赖闭包、回退顺序及隔离 checkout 回退后的 smoke 结果须进入证据。
- 同域方案安排属于冲突定序，不构成跨计划功能依赖。
- 每个实现阶段关闭均运行定向测试、`npm test`、阶段所需类型/构建门禁、证据登记和阶段提交；阶段中途只跑定向测试。
- 审核材料只依赖审核证据契约；审计结构投影器由 F40 实现且只实现一次。
- 每阶段回退证据记录提交 SHA、依赖闭包、回退顺序及隔离 checkout 的回退后 smoke 验证。
