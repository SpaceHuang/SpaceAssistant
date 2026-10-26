# CI 可靠性改进技术方案

> 状态：草稿（方案已核实；D-01 已决定采用 B，实施未开始）  
> 核对基线：`main` `28dd3223`（2026-10-17）  
> 范围：GitHub Actions CI 的结果可信度、合并门禁、跨平台测试和 Electron 初始化并发。  
> 本文是方案，不代表工作流或 GitHub 仓库设置已修改。

## 第 0 层：决策层【人必读】

**一句话**：近期 CI 失败暴露了测试契约漂移、平台假设和 Electron 首次初始化竞态；测试侧已有修复且最新工作流通过，但当前仓库未启用分支保护，失败检查不会阻止代码进入 `main`。

**只有 3 分钟的话**：看本节、[推荐门禁拓扑](#2-推荐门禁拓扑人机共读)和[阶段与验收](#7-阶段与验收人机共读)。

### 已确认的决策

#### D-01：要求通过 Pull Request 并由 CI 绿灯后才能进入 `main`

现在开发者可直接推送到 `main`。这让修复可以立即进入主线，但即使 CI 失败也不会自动阻止后续提交成为主线状态。

- **决定：采用选项 B**。后续改动推送到功能分支并通过 Pull Request 进入 `main`；稳定 CI 必需检查全部通过后才允许合并。失败时合并被阻止。
- **可逆性**：仓库规则可调整或撤销；已直接进入主线的提交无法由规则自动回滚。
- **依据强度**：已验证仓库级 `main` 未启用分支保护/适用规则；近 7 天存在多次失败提交，最近一次失败后才有绿色运行。未核实账号级继承策略。
- **评审要求**：本次决定确认 PR + CI 必需检查，不包含审批人数、管理员绕过、紧急例外等额外政策；这些不擅自加入。
- **实施状态**：GitHub 仓库目前仍未启用分支保护或适用规则。先部署并验证稳定聚合检查，再配置规则要求 PR 和该检查通过；完成前不能声称门禁已生效。

下钻：当前证据见 [F-01](#附录事实与复核命令机人工可跳过)；推荐门禁见 [INV-01](#3-可靠性不变量机人工可跳过) 与 [AC-01](#7-阶段与验收人机共读)。

### 不需要负责人决定

- `ci-required` 采用稳定聚合检查名，聚合所有受支持平台和测试契约检查；具体依赖关系由实现按本方案配置。
- 保留当前串行 Electron 预热，并把失败证据写清楚。
- 测试 fixture 使用平台无关的临时目录；路径安全拒绝行为由显式负例测试覆盖。
- 不先拆分全量 Vitest 为更多并行 job；先把失败定位和结果可见性做好，之后依据耗时数据决定是否拆分。

## 1. 概要层【人机共读】

### 1.1 目标

让每个 PR 的 CI 对“目标平台是否通过既定测试契约”给出稳定、可追溯且可作为合并门禁的单一结论；降低跨平台假设和 Electron 初始化竞态导致的假失败，并让真实回归能快速定位到测试层和失败类别。

### 1.2 近期问题及结论

近 7 天的失败不是单一故障：大量 Vitest 失败集中在 Hosted/IM 测试与策略、凭据 fixture 预期不一致，另有 Agent SDK 包边界误用、一个 Electron 并发首次解压问题，以及 macOS 上假定 `/tmp` 路径安全的测试。失败既包括真正的契约/预期漂移，也有环境与平台耦合；不能把所有失败归为 CI 不稳定或超时。

目前有两件重要变化：

1. 最新确认的 CI run `39040241886`（提交 `28dd3223`）已通过全部 job，说明当前基线恢复绿色。
2. 工作流已经在 shell lifecycle 矩阵中、Vitest worker 启动前串行执行 `require('electron')`。这是对首次解压竞争的现有防护，应作为不变量保留，而不是待新增机制。

因此本方案重点是把临时修复提升成可持续的检查契约：稳定必需门禁、跨平台 fixture 纪律、边界检查前置、失败证据完整和检查变更审计。

### 1.3 范围与非目标

**范围**：`.github/workflows/ci.yml` 的检查拓扑；GitHub 仓库分支规则建议；Vitest fixture 与 Electron shell lifecycle 约束；测试失败摘要和保留证据；CI 失败趋势复盘机制。

**非目标**：本方案不直接修业务测试、不更改生产代码、不在本次文档变更中修改工作流或 GitHub 设置；不扩大支持平台矩阵；不为失败自动重试并把失败改判为成功；不以增加 runner 并行度代替定位根因。

### 1.4 主要取舍

- **选择**稳定聚合门禁。避免矩阵扩展或 job 重命名时必须同步改保护规则，也避免只要求某一个平台而漏掉其他支持平台。
- **选择**保留平台职责清晰的矩阵：Windows golden contract、Windows/macOS x64/macOS arm64 的 Electron SQLite probe 与 shell lifecycle。完整 Vitest 仍在一个 job 中执行，先避免重复安装和构建成本；只有耗时或诊断证据支持时再拆分。
- **选择**把跨平台路径安全测试拆为“拒绝策略本身”与“允许路径的正常功能”两类。前者验证策略；后者使用系统临时目录或 `mkdtemp`，不绑定 `/tmp`、盘符或用户目录布局。
- **排除**失败后自动重跑并将最终成功当作门禁通过：它会隐藏概率性故障，也无法区分 flaky 与代码回归。若未来引入重试，只能保留首次失败结论并单独报告重试结果。

## 2. 推荐门禁拓扑【人机共读】

### 2.1 检查集合

引入稳定的 required aggregator（建议 job/check 名 `CI / required`），在所有被要求的 job 完成后运行，并且无论依赖成功、失败、取消或跳过都执行判定。它检查以下结果必须全部为 `success`：

| 检查职责 | 当前 job | 目标平台/范围 |
|---|---|---|
| 全仓质量、类型检查、边界检查与 Vitest 全量测试 | `test` | macOS runner；覆盖 electron、agent-sdk、renderer Vitest projects |
| Shell/Python golden contract | `golden-windows` | Windows |
| Electron `node:sqlite` 运行探针 | `sqlite-electron-probe` matrix | Windows x64、macOS x64、macOS arm64 |
| Shell lifecycle contract | `shell-contract` matrix | Windows x64、macOS x64、macOS arm64 |

聚合判定必须逐一检查命名依赖的结论，不得仅凭“聚合 job 自身无错误”成功；被跳过、被取消、未创建或 job 名改变均视为失败/配置错误。聚合 job 的检查名一旦用于分支规则，就是外部契约，修改前须同步检查配置和仓库保护规则。

### 2.2 触发与分支规则

- 保持 `pull_request` 到 `main` 与 `push` 到 `main` 两种触发：前者是合并前门禁，后者保留合并后的主线验证与回归可见性。
- 按已批准的 D-01，配置仓库规则要求 PR，并将 `CI / required` 设为 required status check；在聚合 job 部署且检查名可见、验证通过前，不启用指向尚不存在检查的规则。
- 检查所有 PR 路径，避免使用不完整的 `paths` 过滤导致必需检查因 workflow 未启动而处于 pending 或被绕过。
- Release 工作流继续执行打包前验证与目标平台构建；它是发布验证，不替代 PR 合并门禁。

#### 2.3 本地门禁与远端门禁边界

本地门禁用于在推送前更早发现可复现的问题，远端门禁负责验证 GitHub runner 上的目标平台并执行合并规则，两者职责不同。建议在后续实施阶段增加可手动运行的 `npm run check:pre-push`，并由本地 Git `pre-push` hook 调用；hook 只编排现有脚本，不另造一套规则。

本地快速层可包含 `npm run check:no-nul`、`npm run check:treesitter-wasm`、`npm run check:agent-sdk`、相关 typecheck 和 `npm run test:related -- <改动文件>`；完整验收再运行 `npm test`，主进程/渲染进程专项分别可用 `npm run test:electron` / `npm run test:renderer`。hook 应支持明确的本地跳过选项，以免紧急情况下锁死开发，但跳过不会改变 GitHub 必需检查，也不能绕开 PR 规则。

本地通过不代表 Windows/macOS 矩阵通过，也不能作为 `CI / required` 的成功信号；本地 hook 是开发反馈，不是仓库保护边界。远端 PR 上仍须等待所有 required job 完成。

### 2.4 job 组织与执行次序

保留当前 job 分工及非快速失败矩阵。`test` 的 cheap guard（NUL、tree-sitter hash）继续放在 `npm ci` 前；SDK 边界、共享类型、系统不变量、模型基线等静态门禁保持在全量 `npm test` 前，快速失败优先暴露契约问题。无依赖的跨平台 job 可并行执行；Electron 首次初始化在每个 runner 本机内串行完成。

暂不把 Vitest 三个 project 拆成独立 Actions job：`npm test` 当前通过一条脚本统一运行三类项目，拆分会重复依赖准备并改变预构建步骤语义。若后续全量 job 接近超时或失败定位统计表明拆分收益明显，再单独论证构建产物、缓存隔离、报告合并和资源用量。

## 3. 可靠性不变量【机｜人工可跳过】

### INV-01 必需检查闭包

若一个 PR 可合并，则 `CI / required` 必须存在且成功，且其检查集合中每个必需 job 均成功。任何 skipped、cancelled、缺失、unknown 或结论非 success 都使聚合检查失败。矩阵需证明每个目标平台实例都被包含。

### INV-02 受支持平台覆盖

每次 `CI / required` 至少覆盖当前 `.github/workflows/ci.yml` 明确列出的 Windows x64、macOS x64、macOS arm64 contract/probe 实例，以及全量测试 job。新增/移除支持平台时，同一变更须更新矩阵、聚合依赖和分支规则核验记录。

### INV-03 Electron 初始化单写者

每个 runner 上，任何启动 Electron 测试 worker 的动作之前，必须由一个串行步骤解析并初始化 Electron binary；不得由多个 Vitest worker 并发触发首次下载/解压。预热失败即停止该 job，并输出可诊断安装路径与错误摘要，不允许继续到 worker 阶段。

### INV-04 Fixture 不依赖宿主路径细节

可通过正常路径的测试使用运行时生成的、平台无关的临时目录/文件；策略拒绝路径的测试必须显式断言拒绝结果。不得把 `/tmp`、`C:\...` 等假设作为可读写测试前提。

### INV-05 包边界独立检查

Agent SDK package 边界 checker 覆盖生产文件及测试文件的 import 图；共享层不得通过测试文件反向依赖 SDK 包。跨层集成测试放在允许该依赖的 owner/test layer，边界违规先于全量测试反馈。

### INV-06 失败不能被自动重试洗绿

一次 CI 尝试的失败不能因后续重跑变绿而丢失或被 required aggregator 误判为成功。人工 rerun 创建新的可见尝试；原始失败记录和最终采用的结论均保留。

### INV-07 主结论可追溯

CI 结论可映射到提交 SHA、workflow run、job、平台标签、失败步骤及测试报告。日志摘要不得包含 token、API key、用户消息正文或环境敏感值。

## 4. 机制规格【机｜人工可跳过】

### 4.1 稳定 required aggregator

新增一个 `if: always()` 的聚合 job，通过 `needs` 依赖全部必需 job，并显式读取 GitHub job result。聚合 job 不运行项目测试，不重新解释测试输出，只负责汇总：

- 全部目标成功：退出成功，并输出平台检查清单。
- 任一失败/取消/跳过：失败，输出 job 名、matrix label、结论和对应 Actions 链接。
- 必需依赖未被创建或配置与清单不一致：失败，并说明工作流配置检查失败。

实现时验证 GitHub Actions 对 matrix `needs` 的实际 result 语义；若无法可靠辨别各 matrix child，先用显式平台 job 或独立汇总产物提供可核对输入，不能假定一个 aggregate matrix job 成功即代表所有平台成功。分支保护仅要求稳定聚合 check，避免绑定易变化的矩阵显示名称。

### 4.2 Electron 串行预热

当前 `shell-contract` 已在 `npm ci` 后、`npm run test:shell-lifecycle` 前执行 `node -e "require('electron')"`。保留此顺序和注释，并进一步明确验收：

1. step 名称说明这是 Electron binary 的串行初始化屏障；
2. 明确检查解析出的可执行文件存在且可启动/报告版本（根据 `electron` 包当前解析接口选稳定做法）；
3. Vitest lifecycle tests 仅在该屏障通过后运行；
4. 不在测试 setup、worker hook 或共享缓存初始化中再次触发安装/解压；
5. 每个 OS runner 独立初始化，不跨 OS 共享 Electron 解压目录；缓存若启用，键必须包含 OS、架构、Electron 版本与 lockfile 相关性。

现有做法已使最近一次 Windows、macOS x64/arm64 shell contract 通过；新增可执行断言是进一步把隐含顺序变成可检测契约。

### 4.3 测试契约与 fixture

- 对 `Hosted`、IM 和 policy fixtures：fixture 创建者与生产策略/API 必须使用同一公开构造入口或显式固定数据；若策略期望变动，同步更新断言并说明语义，不批量放宽断言来消除失败。
- 对 `LLM_KEY_ACCESS_DENIED`：在测试 fixture 层注入满足该用例策略的测试凭据/授权事实；不要读取开发者机器凭据，不要通过降低全局安全策略让测试变绿。
- 对 SDK import：集成测试放在 `packages/agent-sdk` 或允许依赖该包的测试域；`src/shared` 测试不导入 SDK。checker 的测试文件覆盖范围保持开启。
- 对路径：正常流程从 `mkdtemp`/系统临时目录建 fixture 并在 `finally` 清理；拒绝用例直接构造敏感路径并断言稳定的拒绝结果/错误类别。Windows、macOS runner 都至少有相应路径 contract 用例。
- 保持测试隔离：测试使用显式临时用户数据目录、端口和配置；不复用真实用户 data、缓存或真实 IM/API 服务。

### 4.4 失败证据与可观测性

每个失败 job 需直接显示：提交 SHA、runner OS/架构、Node 版本、失败步骤、Vitest failed test 名称与摘要。Vitest job 结束时生成机器可读测试报告（JUnit 或 Vitest JSON；报告内容只包含测试名、状态、耗时和安全的错误摘要），即使测试失败也上传并设置有限保留期。聚合 job 汇总矩阵失败标签和 run URL。原始 Actions 日志仍为详细证据源。

每月或每次连续两次主干 CI 失败时，以相同分类复盘：代码/契约回归、测试 fixture 漂移、平台差异、工具链/runner、并发/资源、外部依赖。记录失败次数、从首次失败到定位/修复的时间、重复根因；不以“重跑绿”作为关闭根因的证据。

### 4.5 版本和环境稳定性

当前 CI 固定 Node 22、使用 lockfile 与 `npm ci`。继续保持 Node 大版本明确、依赖由 lockfile 安装；GitHub runner 标签（`*-latest`）会滚动，应将它视为环境变量并记录 runner image 与架构。发生仅某平台失败时，先比较 runner image、Node/Electron 版本和失败用例，不通过无证据的临时 pin 隐藏兼容问题。若需要固定 runner 镜像，应在单独评估维护成本和安全更新后决定。

## 5. 状态与所有权【机｜人工可跳过】

| 状态/事实 | 唯一 writer | 读取者 | 生命周期/恢复 |
|---|---|---|---|
| 单个 job 的 success/failure/cancelled/skipped | GitHub Actions runner | required aggregator、PR 状态 | Actions 为权威；rerun 产生新尝试，不覆盖历史日志 |
| required check 是否成功 | 聚合 job | GitHub 分支规则 | 每次 workflow run 生成；任何必需依赖非 success 即失败 |
| GitHub 是否允许合并 | 仓库分支规则配置 | GitHub PR 控制面 | D-01 已批准要求 PR + 必需检查；待聚合 job 发布并验证后配置，配置缺失时不声称有合并保护 |
| Electron binary 初始化状态 | 当前 runner 的预热步骤 | 后续 Vitest shell 测试 | job 临时态；失败终止 job，runner 生命周期结束后销毁 |
| 测试 fixture 文件 | 对应测试用例 | 同一测试用例 | 测试开始创建、结束清理；异常时仍执行清理 |
| 测试结果报告 | 当前 test job | 开发者、CI 复盘 | 失败/成功均上传，按明确期限过期 |

## 6. 故障与恢复场景【机｜人工可跳过】

| 场景 | 检测方式 | 必须结果 | 恢复方式 |
|---|---|---|---|
| 一个平台 job 失败 | job conclusion 非 success | `CI / required` 失败；显示平台与链接 | 修复根因后新提交/新 run；禁止聚合忽略失败 |
| matrix child 被跳过/取消 | job result 或平台清单不完整 | 聚合失败 | 修复 workflow 条件/取消原因后重跑完整 run |
| Electron 下载或解压失败 | 串行预热失败 | shell job 在 Vitest 前终止，日志指出安装阶段 | 在干净 runner 重跑；若复现，按 Electron 版本/平台/缓存目录调查 |
| 全量测试 fixture 拒绝安全路径 | 显式 path deny 测试或正常 fixture 报错 | 明确区分策略拒绝回归与 fixture 使用错误 | 正常 fixture 改为安全临时目录；拒绝策略用例保持拒绝断言 |
| 包边界检查误报测试导入 | `check:agent-sdk` 输出 import 路径 | required test 失败，具体报告违规文件 | 将测试移动至正确 owner 层，或调整生产架构后更新边界规则；不跳过 tests |
| 报告上传失败但测试通过 | artifact step 失败策略 | 是否影响 required 由报告定位级别确定；本方案要求报告可用于失败诊断，报告上传失败应使 test job 失败并给明确错误 | 检查 artifact 配置/服务状态后重新运行 |
| 直接 push 到 main（规则尚未生效或被绕过） | 仓库规则未配置/存在绕过 | 过渡阶段仍不能阻止直接推送 | 完成聚合检查验证后启用 PR 规则；核验管理员绕过策略并按批准的规则治理 |

## 7. 阶段与验收【人机共读】

阶段顺序是：先稳定唯一合并结论，再硬化 runner/test 契约，最后依据数据优化诊断与时长。阶段为设计边界，不是执行进度清单。

| 阶段 | 交付 | 验收 |
|---|---|---|
| P1 稳定合并结论 | `CI / required` 聚合 job；明确所有检查与平台；按已批准的 D-01 配置仓库规则 | **AC-01**：构造任意一个必需 job 失败、取消或跳过的 run，聚合均失败且指出 job/平台；所有依赖成功时聚合通过。**AC-02**：在测试 PR 中证明 CI 失败会阻止合并、全部成功才可合并；直接推送 `main` 被拒绝；规则设置与预期一致。 |
| P2 固化平台契约 | Electron 预热屏障有清晰检查；fixture 使用平台安全临时目录；SDK 边界和安全拒绝用例明确 | **AC-03**：shell lifecycle 的每个矩阵 runner 在 Vitest worker 启动前证明 Electron binary 已初始化；模拟预热失败时测试命令未启动。**AC-04**：Windows 与 macOS 正常路径用例均不依赖固定根路径；敏感路径拒绝测试仍明确断言拒绝。**AC-05**：共享层测试的 SDK 越界导入能被 checker 检出，合法 SDK owner 层集成测试通过。 |
| P3 改善失败定位 | 失败摘要、测试报告 artifact、复盘分类 | **AC-06**：故意失败的测试仍上传测试报告，并能从报告识别测试名/平台/耗时；不含凭据或消息正文。**AC-07**：失败矩阵汇总含直接 run 链接；重跑不能抹掉首次失败结论。**AC-08**：连续失败复盘能统计失败类别及定位/修复耗时，不以单次绿重跑结案。 |

### 迁移、回滚与兼容

- 先部署 workflow 聚合 job，在分支保护正式要求它之前验证检查名稳定、PR 和 push 两类事件均产生结论。
- 若聚合逻辑错误造成所有 PR 都阻塞，回滚 workflow 到上一版或临时移除该 required check，并记录期间缺失门禁；不要留下一个永远 pending 的 required 名称。
- 分支规则启用/调整按 D-01 获批的范围执行，记录旧设置、新设置与恢复步骤。禁止因 CI 暂时红灯而无记录地取消整个保护。
- 报告 artifact 失败若影响 job 结果，须保证错误可读并可回滚该上传步骤，不得让测试本身的失败被吞掉。
- 矩阵新增平台时先同步聚合依赖与规则验收，再将其定义为必需平台，避免检查清单和保护规则不一致。

## 8. 已排除方案与风险【机｜人工可跳过】

| 方案 | 结论 | 原因 |
|---|---|---|
| 直接将所有矩阵 job 名设为 branch protection required | 排除 | 矩阵展开名称和显示名容易随平台/命名变化；更容易漏掉新增实例或因无效名称让 PR 无法完成。稳定聚合 job 更适合作为外部检查契约。 |
| 对所有失败自动重试一次并采用最终成功 | 排除 | 会把不稳定问题从门禁信号中隐藏，降低首错定位概率；重跑可由开发者发起并保留原始失败。 |
| 仅扩大 timeout 或增加并发 worker | 排除 | 近期主要证据是断言、fixture、边界及初始化竞争，不是单一超时；扩大资源无法修复契约错误，还可能放大首次解压并发。 |
| 把所有 Vitest project 拆成独立 runner job | 暂缓 | 当前测试脚本共享安装/构建前置；拆分成本和时长收益未经测量。先保留一个全量 job，收集报告和耗时数据。 |
| 固定全部 GitHub runner 到不可滚动镜像 | 暂缓 | 会增加维护与安全更新责任；目前没有足够证据证明滚动 runner 是主要根因。记录镜像并按具体平台失败再决定。 |

主要风险是聚合 job 的 matrix 依赖语义实现错误、required check 名变更、报告中泄露敏感内容，以及 仓库规则实施前团队误以为已经有合并保护。分别由 AC-01/02、命名契约审查、报告字段限制和仓库设置核验记录控制。

## 附录：事实与复核命令【机｜人工可跳过】

### F-01 当前仓库规则状态

核验时间：2026-10-17。仓库级 `main` protection API 返回 `Branch not protected (404)`；仓库 rulesets 和适用于 `main` 的规则列表为空。账号级继承规则未核实，不能据此声称整个 GitHub 账号不存在规则。

复核：

```text
gh api repos/SpaceHuang/SpaceAssistant/branches/main/protection
gh api repos/SpaceHuang/SpaceAssistant/rulesets
gh api repos/SpaceHuang/SpaceAssistant/rules/branches/main
```

### F-02 当前工作流事实

基线 `28dd3223` 的 `.github/workflows/ci.yml` 有 `test`、Windows golden、3 平台 SQLite probe、3 平台 shell contract；push 到 main 与 PR 到 main 均触发。shell contract 已在 `npm ci` 后、生命周期 Vitest 前串行 `require('electron')`。Node 固定为 22，依赖使用 `npm ci`。当前没有稳定聚合 job。

复核：

```text
sed -n '1,240p' .github/workflows/ci.yml
rg -n '"test"|test:shell-lifecycle|check:agent-sdk' package.json
```

### F-03 近 7 天失败分类

区间按 2026-10-10 至 2026-10-17 查询 GitHub Actions CI run。列出的 run 是有代表性的证据，不声称它们覆盖所有失败的唯一根因。

| 失败类别 | 观察 | 代表运行 |
|---|---|---|
| 测试契约/fixture 与共享策略预期漂移 | Linux 全量测试大量失败，Hosted/IM 相关用例反复出现 `LLM_KEY_ACCESS_DENIED`、策略规则快照/行为不符，后续运行收敛到少量 provider identity 与 IM policy 断言；表示一组测试与契约对齐问题，不能归为单一原因 | [38824491028](https://github.com/SpaceHuang/SpaceAssistant/actions/runs/38824491028)、[38901710766](https://github.com/SpaceHuang/SpaceAssistant/actions/runs/38901710766)、[38917907313](https://github.com/SpaceHuang/SpaceAssistant/actions/runs/38917907313) |
| 包边界规则与测试位置不符 | `src/shared` 的测试导入 Agent SDK，触发 `check:agent-sdk`；边界 checker 覆盖测试导入是预期保护 | [38762083586](https://github.com/SpaceHuang/SpaceAssistant/actions/runs/38762083586) |
| Electron 首次解压并发 | macOS x64 shell lifecycle 中首次初始化与 worker 并发，日志出现 Electron Framework 文件已存在/安装失败；之后 workflow 已加入串行预热 | [38749101726](https://github.com/SpaceHuang/SpaceAssistant/actions/runs/38749101726) |
| 测试路径与平台策略耦合 | macOS 测试把 `/tmp/wd/a.txt` 用作预期可读路径，自动化安全策略按敏感路径拒绝；后续改用路径无关工具测试 | [39035066857](https://github.com/SpaceHuang/SpaceAssistant/actions/runs/39035066857) |
| 当前基线 | 提交 `28dd3223` 的最新已核验 CI run 全部成功 | [39040241886](https://github.com/SpaceHuang/SpaceAssistant/actions/runs/39040241886) |

复核近期开跑：

```text
gh run list --repo SpaceHuang/SpaceAssistant --workflow CI --limit 25 --json databaseId,headSha,createdAt,status,conclusion,url
```

### F-04 当前脚本与测试分区

`npm test` 执行 Vitest electron、agent-sdk、renderer 三个 project；`test:shell-lifecycle` 指定 shell 及工具协调相关测试。具体列表以基线 `package.json` 为准。

复核：

```text
rg -n '"test"|"test:electron"|"test:renderer"|"test:shell-lifecycle"|"check:agent-sdk"' package.json
```

## 9. 追溯关系【机｜人工可跳过】

| 项 | 关联项 |
|---|---|
| D-01 | INV-01、AC-01、AC-02、§2.2、§7 迁移/回滚 |
| INV-01 / INV-02 | AC-01、AC-02；§2.1 的必需检查集合 |
| INV-03 | AC-03；§4.2 Electron 初始化屏障 |
| INV-04 / INV-05 | AC-04 / AC-05；§4.3 测试契约 |
| INV-06 / INV-07 | AC-06 / AC-07；§4.4 失败证据 |
| F-01 | D-01；§2.2 分支规则 |
| F-02 | §2、§4；确认方案以现有 CI 为起点 |
| F-03 | §1.2、§4.3、§8；问题分类与排除方案 |

---

### 编写边界

本文仅整理并核实 CI 可靠性改进方案。后续实施应另行形成执行计划/变更。D-01 已批准采用 PR + 必需 CI 检查；实施仍需先部署并验证稳定聚合检查，再配置 GitHub 仓库规则。
