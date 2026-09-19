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


## PowerShell 段（P3-T0 建立）

（待 P3-T0 填写）
