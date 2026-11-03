# 测试覆盖率基线（2026-11）

> 测量日期：2026-11-02。基线提交：`b2541787022c6c0ed5812cb820580304a7868364`（包含 W2 测试工厂与临时路径改造）。
> 用途：记录三套默认测试项目的首次覆盖率测量；当前只测量、不作为通过门槛。覆盖率门禁范围与阈值由负责人依据本基线另行决定（R-01）。

## 测量口径

- 命令：`npm run test:coverage`，等价于 `vitest run --coverage --project electron --project agent-sdk --project renderer`。
- Provider：Vitest V8；报告格式：终端文本、`coverage/coverage-final.json`、`coverage/index.html`。
- 纳入范围：`electron/**/*.ts`、`src/**/*.ts(x)`、三个 agent-sdk/provider workspace 的 `src/**/*.ts`。测试、声明文件、测试 fixture 与 `testSupport` 排除；实现代码没有覆盖率豁免。
- 本次运行：1253 个测试文件通过、1 个跳过；12124 个测试通过、140 个跳过。总耗时约 18 分 22 秒。

## 覆盖率结果

百分比按各组覆盖项 / 总项计算；行数采用 Istanbul 的可执行行口径。

| 顶层目录 | 文件数 | Statements | Branches | Functions | Lines |
|---|---:|---:|---:|---:|---:|
| `electron/` | 775 | 54757 / 67969（80.56%） | 47703 / 63077（75.62%） | 9300 / 11313（82.20%） | 47772 / 56248（84.93%） |
| `src/` | 448 | 14748 / 19195（76.83%） | 12585 / 17186（73.22%） | 3159 / 4279（73.82%） | 12764 / 16099（79.28%） |
| `packages/` | 27 | 3729 / 4163（89.57%） | 3810 / 4452（85.57%） | 574 / 617（93.03%） | 3094 / 3308（93.53%） |
| **合计** | **1250** | **73234 / 91327（80.18%）** | **64098 / 84715（75.66%）** | **13033 / 16209（80.40%）** | **63630 / 75655（84.10%）** |

packages 明细：`agent-sdk` 25 个文件；`agent-provider-testing` 与 `agent-provider-pi-ai` 各 1 个文件。workspace 级数据可用下方复核脚本按第二层目录分组得到。

## 复核

从仓库根目录执行下列命令可重新生成 JSON/HTML 报告：

```bash
npm run test:coverage
```

以下 Node 脚本从生成的 JSON 报告按顶层目录汇总，输出每项的 covered / total / percentage：

```bash
node <<'NODE'
const { createCoverageMap } = require('istanbul-lib-coverage')
const report = require('./coverage/coverage-final.json')
const groups = new Map()
for (const [file, data] of Object.entries(report)) {
  const relative = file.replace(`${process.cwd()}/`, '')
  const top = relative.split('/')[0]
  if (!groups.has(top)) groups.set(top, createCoverageMap({}))
  groups.get(top).addFileCoverage(data)
}
for (const [directory, coverage] of groups) {
  const summary = coverage.getCoverageSummary()
  console.log(directory, JSON.stringify({
    files: coverage.files().length,
    statements: summary.statements,
    branches: summary.branches,
    functions: summary.functions,
    lines: summary.lines
  }))
}
NODE
```

若报告数据变化，应更新本表和测量日期/提交；不要手动挑选较高的局部数字替代整目录口径。
