# AGENTS.md

本文件为 AI 编码 Agent 在本仓库中工作时提供指导。

**要求：与用户沟通必须使用中文。**

## 项目概述

SpaceAssistant 是基于 Electron + React + TypeScript 的跨平台桌面 AI 助手（Apache-2.0，版本见 `package.json`）：核心是 LLM 流式对话与工具调用循环（以 Anthropic 为主，`@anthropic-ai/sdk`），另有飞书 / 微信 IM 桥接、浏览器自动化、内嵌终端与 Wiki 面板；界面以中文（zh-CN）为主。

## 开发命令

```bash
npm run dev

# 仅启动渲染进程
npm run dev:renderer

# 仅启动主进程（先全量构建再启动 electron）
npm run dev:electron

# 构建渲染进程
npm run build:renderer

# 构建主进程（rimraf 后用 tsconfig.electron.json 全量编译到 dist-electron/）
# 两条均先跑 check:pi-ai-runtime-closure 与 session-storage 两项边界门禁
npm run build:electron
npm run build:electron:incremental   # 增量编译（不清理输出目录）

# 完整构建（托盘图标 + 渲染 + 主进程，打包前必须执行）
npm run build

npm run check:no-nul        # 检查 git 跟踪的源文件不含 NUL 字节（CI test job 在 npm ci 前运行）

# 运行测试
npm test
npm run test:watch

# 类型检查
npm run typecheck:renderer
npm run typecheck:shared    # 共享配置类型一致性检查

# i18n
npm run i18n:generate-types # 从 zh-CN 资源推导 TypeScript 类型
npm run i18n:check          # 校验 key 对齐与 JSON 合法性
npm run i18n:check:strict   # 额外检查硬编码文案

# 排障
npm run probe:sqlite        # 在完整 Electron 主进程运行时探测内嵌 node:sqlite 可用性（scripts/probe-node-sqlite.mjs）

# 打包分发（输出到 release/）
npm run pack:win
npm run pack:mac
npm run pack:linux
```

## 架构

### Electron 三进程模型

渲染进程（`src/renderer/`）只能经预加载脚本 `electron/preload.ts` 暴露的 `window.api` 访问主进程（`electron/`）——通道名在 preload 中定义，改 IPC 必须同步此处；`@` 别名指向 `src/`，编译与输出见「构建系统」。

### 核心数据流

1. 渲染进程调用 `window.api.*`（类型定义在 `src/shared/api.ts`）
2. 预加载脚本转发到 `ipcRenderer.invoke/on`
3. 主进程：`electron/ipc/` 按域注册 handler（组合器 `electron/appIpc.ts`）、`claudeStreamHandlers.ts`（流式）、`toolChatLoop.ts`（工具循环）。
4. 流式：主进程推 `chat:turn-display` / `chat:turn-usage`，渲染进程 `turnProjectionService.ts` 订阅。

### 数据库

主存储为 SQLite（Electron 内嵌 `node:sqlite`，无原生绑定；文件在 `{userData}/spaceassistant-data.db`）；事务一律走 `electron/database/transaction.ts` 的 `runInTransaction(conn, fn)`（嵌套 SAVEPOINT、仅同步回调），不得自行写 BEGIN/COMMIT；`sessions/` 下的明文备份只是辅助导出（`sessionBackupManager.ts`），真相以数据库为准。

### 共享类型与共享逻辑

领域类型的唯一真实来源是 `src/shared/domainTypes.ts`（主进程与渲染进程均从此导入，勿各端重复定义）；共享配置类型一致性由 `npm run typecheck:shared` 校验。

### API Key 安全

API Key 经 `secureApiKey.ts`（`safeStorage`）加密存储；文件访问必须走 `pathSecurity.ts` 的路径防护；日志经 `logSanitize.ts` 脱敏，不落消息正文、token、secret。

## 目录结构

- 代码三处落点：`electron/`（主进程）、`src/`（渲染进程 + 两端共享的 `src/shared/`）、`packages/`（npm workspaces，运行时契约核心 `agent-sdk`，受 `check:agent-sdk` 约束）。
- `electron/` 下还有本文别处未提的领域目录：`driver/`、`butler/`、`capabilities/`、`confirmation/`、`mcp/`、`storage/`——定位以 `ls electron/` 为准。
- 不入库（clone 后不存在）：`docs/analysis`、`docs/references`、`docs/review`、`docs/project`、`sessions/`、`logs/`、`llm-wiki/`、`res/mingcute-icons-main/`（图标源；已用图标在 `src/renderer/assets/`），完整见 `.gitignore`。

## 文档规范

**整理 `docs/` 下的文档前，先读 [`docs/rules/docs-guide.md`](docs/rules/docs-guide.md)** —— 它是 `docs/` 文档库的长期统一规范（主题结构、归属判定 A/B/C/D、`history.md` 规范、模板集、执行流程、质量门禁、反模式清单）。

要点速览：

- `docs/develop/`、`docs/requirement/` 按 **9 个主题**组织：每主题 = `README.md`（索引）+ 现状文档（requirement 侧为 `需求基线.md`）+ `history.md`（流水账）+ `in-flight/`（草稿箱）；已完成迭代 `git mv` 进 `archive/<主题>/`，**内容零改动**。
- **文档里那行「状态：」不能当判定依据** —— 必须跑代码核验（提交检索 / 路径检索 / 符号检索三步，指南 §3.0）。
- 只动文档、**不改代码**；搬迁与改写**分开提交**。
- 边界目录（`docs/review/`、`docs/plan/`、`docs/analyze/`、`docs/superpowers/` 等）只引用不搬迁；判定原则先看「产品文档 or 过程产物」。
- **本环境会话可能丢帧**：判定「文件是否已写 / 改动是否生效」一律以 `read_file` / `ls` / `git log` 为准，**不凭会话记忆**；每次写入后复读确认（指南 §0）。

## 构建系统

- **渲染进程**：Vite + `@vitejs/plugin-react`，`@` 别名映射到 `src/`；dev 端口 9240
- **主进程**：`tsc -p tsconfig.electron.json`（CommonJS 输出，无打包器）
- **打包**：electron-builder（配置在 `package.json` 的 `build` 字段），输出到 `release/`；Windows 为 NSIS（中文/英文安装语言），macOS 为 DMG，Linux 为 AppImage；`afterPack` 钩子为 `scripts/after-pack.cjs`；托盘图标与图标资源经 `extraResources` 拷贝
- **测试**：Vitest，配置在 `vitest.config.mts`

## 测试

使用 Vitest（`vitest.config.mts`），采用 **projects 多项目配置**（当前三项目：electron / renderer / renderer-perf）：

- `electron` 项目：`electron/**/*.test.ts`，`node` 环境，`pool: 'forks' + maxWorkers: 1 + fileParallelism: false`（Windows 上 threads 池易出现 worker 启动超时，主进程测试必须保持 forks 单 worker）
- `renderer` 项目：`src/**/*.test.{ts,tsx}`，`jsdom` 环境，`pool: 'threads' + maxWorkers: 4`（纯 jsdom 测试可安全并行）

测试文件就近放置，setup 文件为 `src/test/setup.ts`。

**测试执行策略（严格遵守）**：

1. **开发过程中只跑定向测试**，禁止每改一步就跑全量：
   - 已知受影响文件时：`npm exec vitest run <文件1> <文件2>`
   - 改动后不确定影响面时：`npm run test:related -- <改动文件>`（基于依赖图自动关联测试）
   - 只改主进程：`npm run test:electron`；只改渲染进程：`npm run test:renderer`
2. **全量 `npm test` 仅在以下时点运行**：多阶段计划的每个 Phase 收尾验证、提交前的最终验收。不要把它当作增量开发的循环验证手段。
3. 中间构建验证优先用 `npm run build:electron:incremental` + `npm run typecheck:renderer`，全量 `npm run build` 只在最终验收时运行。

**不变量优先（队列 / 票据 / 配额类模块）**：此类模块（如 `electron/butler/butlerAdmission.ts`）除逐场景用例外，必须另有一条**随机操作序列 + 状态不变量断言**测试——确定性伪随机种子（如 mulberry32）生成 acquire/release 序列，每步后断言跨函数不变量（如「探针排队 ⇔ oracle 持票数已满」「已发票据数 ∈ [0, maxConcurrent]」）。逐场景用例对「跨函数成对性 / 计数守恒」类缺陷天然易漏（2026-10 评审 P1 教训：排队唤醒漏补计数，场景测试全绿但一次排队后上限永久失效）；不变量测试需与实现同步红绿验证（回退修复应转红），示范见 `electron/butler/butlerAdmission.test.ts` 末组用例。

## Agent 执行纪律（会话成本控制）

以下规则对所有任务生效，用于控制长任务的上下文、token 与返工：

- **开工先对齐验收边界**：多阶段 / 自动化续跑任务，先列出「当前环境可单测验证」vs「需真机 / 外部系统 / 真实 IM 才能验收」的项，并让用户决定交付形态；不要把「无法验收」拖到收尾才暴露。
- **上下文与阶段**：按可独立交付的阶段推进，每阶段收尾必须提交。会话上下文接近约 40 万 token 时主动总结并交接 / 开新线程，不要把单条会话扛到临近上限（越晚成本越高）。
- **读取从简**：优先 `rg` + 行号 / `Get-Content -TotalCount` 等局部读取；方案文档读一次后只 grep 相关小节，不整文件 `-Raw` 反复回填。
- **验证合并跑**：相关测试一次跑（`npm exec vitest run <a> <b>` 或 `npm run test:related -- <改动文件>`），不要单文件逐个跑；`typecheck` / `i18n:check` 只在涉及类型、文案时跑；`build:electron:incremental` 每阶段至多一次。
- **改动前先确认契约**：动接口 / 组件前先确认既有签名与调用方，避免先写实现再配测试、再返工（反向 TDD）。
- **带状态 / 外部耦合逻辑**（browser / lark / 远程 / grant 等）：设计专门的边界回归测试，不能只靠 happy-path 单测。
- **状态汇报从简**：进度用 `update_plan` 清单 / 一句话表达，不跨回合重复粘贴同一份长状态。

## 排障：飞书 / 微信 CLI 文件日志

二者的全链路调试日志均为 JSON Lines（`FeishuCli-{YYYYmmdd}.log` / `WeChatCli-{YYYYmmdd}.log`）：开发模式在 `{项目根}/logs/`，打包模式在 `{workDir}/.agent/logs/`（同目录另有 Agent 日志）；与设置页「操作记录」读的 `{userData}/logs/feishu-audit.log` / `wechat-audit.log` 是两份日志，互不替代。

## IPC 通道参考

通道名定义在 `electron/preload.ts`，处理器分布在 `electron/ipc/`（组合器 `electron/appIpc.ts`）：
- `session:list|create|get|update|delete` - 会话 CRUD
- `chat:get-messages` - 消息读取；`message:append-non-turn` / `message:patch-non-turn` - 消息增改（非 turn 路径直写）
- `chat:submit-outbound` - 发起一轮对话（提交出站意图，立即返回；由 outbound 受理后 start-turn 或降级排队，展示与用量经 `chat:turn-display` / `chat:turn-usage` 事件推送）
- `config:get|set|test-connection` - 配置管理
- `file:list-directory|read-file` - 文件浏览（路径相对于 workDir）
- `search:execute|get-history` - 跨会话和文件搜索

## UI 规范

- 左侧边栏使用 VS Code 风格的活动栏（图标条）切换会话、文件、搜索面板
- SVG 图标来自 `src/renderer/assets/`，使用 `?raw` 导入；运行时将 `fill` 替换为 `currentColor`
- 如需新图标，可从 `res/mingcute-icons-main/svg/` 目录按分类查找（如 `arrow/`、`file/`、`device/`、`editor/` 等），复制 SVG 文件到 `src/renderer/assets/` 后使用
- 全局使用 Ant Design 组件；自定义样式在 `src/renderer/styles.css`；图标库另有 `lucide-react`
- 三栏布局：左侧边栏（328px）| 中间聊天区 | 右侧边栏（240px，预留位）

## i18n 国际化开发规范

- 所有新增 UI 文案**必须**通过 `t()` 函数使用，禁止硬编码中文或英文
- 翻译 key 命名遵循 `模块.组件.语义` 层级（camelCase，最多 4 层）
- `zh-CN` 是翻译 key 的真实来源；TypeScript 类型从 `src/renderer/i18n/resources/zh-CN/` 自动推导
- 新增 key 后运行 `npm run i18n:generate-types` 更新类型（`dev` 与 `build:renderer` 前会自动执行）
- 提交前运行 `npm run i18n:check` 确保 key 对齐、JSON 合法
- 复用性高的文案放 `common` 命名空间；模块专属文案放对应命名空间
- 错误消息使用 `errors` 命名空间 + `src/shared/errorCodes.ts` 错误码模式
- 翻译资源文件在 `src/renderer/i18n/resources/{locale}/` 下按命名空间分文件
