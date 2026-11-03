# 测试基建指南（platform-eng）

> **定位**：本仓库的**测试配置与基建** —— Vitest projects 配置、测试文件位置、不变量测试要求。
> **关系**：**执行纪律**（开发中只跑定向测试、全量测试的时点、构建验证节奏）见 `AGENTS.md`「测试」与「Agent 执行纪律」，本篇不重复。
> **核对基线**：2026-11-02，配置以 `vitest.config.mts`、`package.json` 和 `.github/workflows/ci.yml` 为准。

## 1. Vitest 多项目配置（`vitest.config.mts`）

当前四项目：**electron / agent-sdk / renderer / renderer-perf**。

| 项目 | 匹配范围 | 环境 | 池与并发 | 约束原因 |
|---|---|---|---|---|
| `electron` | `electron/**/*.test.ts` | `node` | macOS：`threads` + 4 workers + 文件并行；其他平台：`forks` + 1 worker | Windows 上 threads 池易出现 worker 启动超时；Electron 主进程 setup 按配置加载 |
| `agent-sdk` | `packages/agent-sdk/**/*.test.ts`、`packages/agent-provider-{testing,pi-ai}/**/*.test.ts` | `node` | macOS：`threads` + 4 workers；其他平台：`forks` + 1 worker | SDK 与 provider 包测试和 Electron 装配隔离 |
| `renderer` | `src/**/*.test.{ts,tsx}`，排除 `src/**/*.perf.*.test.tsx` | `jsdom` | `threads` + 4 workers | 常规渲染回归 |
| `renderer-perf` | `src/**/*.perf.*.test.tsx` | `jsdom` | `threads` + 1 worker | 性能采集独立运行，不进入默认回归集 |

测试文件**就近放置**；setup 文件为 `src/test/setup.ts`。

## 2. 不变量优先（队列 / 票据 / 配额类模块）

此类模块（示例：`electron/butler/butlerAdmission.ts`）除逐场景用例外，**必须**另有一条"随机操作序列 + 状态不变量断言"测试：

- 用**确定性伪随机种子**（如 mulberry32）生成 acquire / release 序列；
- 每步之后断言**跨函数不变量**（如「探针排队 ⇔ oracle 持票数已满」「已发票据数 ∈ [0, maxConcurrent]」）。

原因（2026-10 评审 P1 教训）：逐场景用例对"跨函数成对性 / 计数守恒"类缺陷天然易漏——排队唤醒漏补计数时，场景测试全绿但一次排队后上限永久失效。不变量测试需与实现**同步红绿验证**（回退修复应转红）；示范见 `electron/butler/butlerAdmission.test.ts` 末组用例。

## 3. 常用命令

不在这里重复：见 `AGENTS.md`「开发命令」与「测试」两节（`npm test` / `npm run test:related -- <文件>` / `test:electron` / `test:renderer` / `test:renderer-perf`）。

## 4. 测试通道

| 通道 | 运行方式 | CI 位置与职责 |
|---|---|---|
| 默认回归 | `npm test`（electron + agent-sdk + renderer） | CI / Full tests，PR 必需测试；不包含 renderer-perf |
| renderer-perf | `npm run perf:chat-list` | 独立性能基准通道；不属于默认回归 |
| storage-perf | `npm run test:storage-perf` | CI / Storage performance（macOS）观察性 job；执行前显式构建 agent provider，不启动 Electron；不属于 `ci-required`，R-03 决策后再评估 required |
| probe | 按 `probe:*` npm script 启动真实运行时探针 | CI 按探针专属矩阵执行；`probe:sqlite` 覆盖 Windows x64、macOS x64、macOS arm64，`probe:chat-business-ipc` 覆盖 macOS 与 Windows；Electron 启动前遵循 CI 可靠性方案 INV-03 串行预热屏障 |
| bench | 按 `bench:*` npm script 执行 | 本地手动基准，不属于 CI 必需回归 |

渲染快照只用于纯渲染输出。快照 diff 必须在 PR 中人工审查；CI 快照失败即失败，不自动更新。临时目录使用 `mkdtemp` 建立目录，单文件用原子唯一命名 helper；不得以时间戳和随机数拼接临时路径（细节见 CI 可靠性方案 INV-04）。覆盖率豁免须逐条注明原因和 TODO；新增实现豁免在 R-01 决策前须经评审。

测试替身优先放在 LLM、网络和时钟边界；Electron API 与存储优先使用真实实现或内存替身。测试使用 `vi.mock('electron')` 时，在用例旁说明 mock 原因；已有 mock 不要求随本指南批量迁移。
