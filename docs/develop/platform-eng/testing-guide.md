# 测试基建指南（platform-eng）

> **定位**：本仓库的**测试配置与基建** —— Vitest projects 配置、测试文件位置、不变量测试要求。
> **关系**：**执行纪律**（开发中只跑定向测试、全量测试的时点、构建验证节奏）见 `AGENTS.md`「测试」与「Agent 执行纪律」，本篇不重复。
> **核对基线**：`main` `17236274`（2026-10-14）。

## 1. Vitest 多项目配置（`vitest.config.mts`）

当前三项目：**electron / renderer / renderer-perf**。

| 项目 | 匹配范围 | 环境 | 池与并发 | 约束原因 |
|---|---|---|---|---|
| `electron` | `electron/**/*.test.ts` | `node` | `pool: 'forks'` + `maxWorkers: 1` + `fileParallelism: false` | Windows 上 threads 池易出现 worker 启动超时；主进程测试必须保持 forks 单 worker |
| `renderer` | `src/**/*.test.{ts,tsx}` | `jsdom` | `pool: 'threads'` + `maxWorkers: 4` | 纯 jsdom 测试可安全并行 |

测试文件**就近放置**；setup 文件为 `src/test/setup.ts`。

## 2. 不变量优先（队列 / 票据 / 配额类模块）

此类模块（示例：`electron/butler/butlerAdmission.ts`）除逐场景用例外，**必须**另有一条"随机操作序列 + 状态不变量断言"测试：

- 用**确定性伪随机种子**（如 mulberry32）生成 acquire / release 序列；
- 每步之后断言**跨函数不变量**（如「探针排队 ⇔ oracle 持票数已满」「已发票据数 ∈ [0, maxConcurrent]」）。

原因（2026-10 评审 P1 教训）：逐场景用例对"跨函数成对性 / 计数守恒"类缺陷天然易漏——排队唤醒漏补计数时，场景测试全绿但一次排队后上限永久失效。不变量测试需与实现**同步红绿验证**（回退修复应转红）；示范见 `electron/butler/butlerAdmission.test.ts` 末组用例。

## 3. 常用命令

不在这里重复：见 `AGENTS.md`「开发命令」与「测试」两节（`npm test` / `npm run test:related -- <文件>` / `test:electron` / `test:renderer` / `test:renderer-perf`）。
