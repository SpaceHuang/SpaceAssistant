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

### P1-T5 比对结果（切换后填写）

- 比对基线 commit：`9c2df39bd1a93c8e5164cb5ade0d56cd45c3ec02`（与 P1-T0 一致）✓
- 比对时间：（待 P1-T5 填写）
- 判定变化条目与处置结论：（待 P1-T5 填写，逐条登记，无「未评审」条目）

### P1-T6 实测统计（切换后填写）

- 原必失败集语法解析失败 A-fail 数：（待填，应为 0）
- IrCoverageError 引起的 A-fail 条目与补全计划：（待填）
- 现状可解析集 A-fail（含 IrCoverageError）数：（待填，硬门禁 = 0）

## Bash 段（P2-T0 建立）

（待 P2-T0 填写）

## PowerShell 段（P3-T0 建立）

（待 P3-T0 填写）
