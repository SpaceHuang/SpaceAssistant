# 依赖版本迭代计划（Node / Electron / 工具链）

制定日期：2026-08-31；修订日期：2026-09-03（v3）
状态：**已实施（Phase 1–3 完成，含遗留人工验收项）**。本版吸收 `docs/review/dependency-upgrade-plan-2026-08-review-v2.md` 的三项阻断意见，并以当前仓库检索结果和 Electron/Node 官方文档复核。Phase 1/2/3 实施记录分别见附录 A/B/C。

## 1. 目标、边界与版本原则

本次目标是先以 Electron 35 的内置 `node:sqlite` 消除 `better-sqlite3` 原生绑定，再分两步升级 Electron 与构建工具链。React、antd 和业务功能不在本计划内。每个阶段必须是独立提交；上一个阶段所有门禁通过后才能进入下一阶段。

| 项目 | 当前 | 目标 / 决策 |
| --- | --- | --- |
| Electron | `^35.7.5` | 分别升至锁定的 40.x、44.x；实施当天从 [Electron Releases](https://releases.electronjs.org/release?channel=stable) 记录实际稳定 patch 与 `package-lock.json` 精确版本，不在计划中宣称固定版本“最新” |
| Electron 40 运行时 | — | Node **24.11.1**、Chromium 144；类型基线为 `@types/node@^24`，不是 Node 22 |
| Electron 44 | — | 目标平台为 Windows x64、macOS x64/arm64；macOS 最低版本升为 **13**。Linux 桌面端、Windows ia32 与 Linux armv7l 均不在产品支持面 |
| 开发/CI Node | CI 22，本机 24 | `engines.node: >=22.13`；CI 保留 Node 22 用于最低开发环境，Electron 运行时兼容性必须由完整 Electron 探针验证 |
| better-sqlite3 / node-abi / node-gyp | 已安装 | Phase 1 全部移除 |
| TypeScript / Vite / React 插件 | 5.7 / 6 / 4 | 在 Phase 3 升至相容的当前稳定主版本；先由 lockfile 与 peer-dependency 校验确定组合，不预设不相容版本 |

Electron 40 已内嵌 Node 24.11.1；因此 `@types/node@^22` 只能用于 CI 最低 Node 22 的额外检查，不能被表述为 Electron 40 的类型基线。[Electron 40 发布说明](https://www.electronjs.org/blog/electron-40-0)

### 平台支持的前置决策

仓库当前的发布配置和发布指南只产出 Windows x64、macOS x64/arm64，未产出 Windows ia32 或 Linux armv7l。因此实施 Electron 44 前须在发布说明和支持文档中明确：**macOS 13+、Windows x64、macOS x64/arm64** 为本次发布支持面；若产品仍承诺 macOS 12，则 Electron 44 不可作为目标版本，计划暂停并另选版本。不得把这一兼容性破坏留到打包后才发现。

## 2. Phase 1：以 node:sqlite 替换 better-sqlite3

### 2.1 已确认的迁移范围

现有 Electron 35.7.5 完整主进程（Node 22.16.0）可加载 `node:sqlite`；但该验证必须由仓库脚本重复执行，不能仅依赖人工结论。`DatabaseSync` 没有 `transaction(fn)`，所有直接调用必须迁移，不能以“少量调用点”概括。

| 类别 | 必改文件 / 入口 | 改动要求 |
| --- | --- | --- |
| 连接与事务 | `electron/database/sqliteStore.ts` | `DatabaseSync`、PRAGMA 改用 `exec()`；删除原生 binding/asar 解析；提供唯一事务入口 |
| 直接事务调用 | `electron/database/migrations.ts:25`、`electron/database/operations.ts:259`、`electron/database/migrateFromJson.ts:176`、`electron/confirmation/mcpConfirmPolicyMigration.ts:73` | 全部改为统一事务入口；禁止保留 `conn.transaction(...)` |
| 类型引用 | `electron/database/migrations.ts:1`、`electron/confirmation/sqliteDecisionCache.ts:1`、`electron/confirmation/policyRuleStore.ts:1` | 改为从 `node:sqlite` 导入的共享连接类型；不得再引用 `better-sqlite3` |
| 调试/运维脚本 | `scripts/read-wechat-config.mjs`、`scripts/probe-wechat-start.cjs`、`scripts/probe-wechat-state.cjs` | 改用 `node:sqlite`，或在确认已无用途后删除 |
| 原生绑定链 | `scripts/install-sqlite-bindings.mjs`、`scripts/probe-better-sqlite3.mjs`、`scripts/native-bindings-manifest.json`、`scripts/dry-run-mac-pack.mjs` | 删除绑定安装、探针、manifest 与 macOS 绑定存在性检查 |
| 包与文档 | `package.json`、`package-lock.json`、`.github/workflows/ci.yml`、`.github/workflows/release.yml`、`AGENTS.md`、`CLAUDE.md` | 删除依赖、脚本、打包 glob、原生绑定说明；保留 `afterPack`，它与 SQLite 无关 |

### 2.2 事务契约（实施前不可省略）

在 `sqliteStore.ts` 定义并导出连接级 `runInTransaction(conn, fn)`；业务层若只有 `AppDatabase`，再由其薄封装取得连接后调用该函数。`migrations.ts`、JSON 导入和确认策略迁移都必须使用它，业务代码不得自行发出事务边界语句。

- 最外层调用使用 `BEGIN` / `COMMIT`；回调抛错时 `ROLLBACK` 后重新抛出原错误。
- 嵌套调用使用每连接单调递增、不可由外部输入的 `SAVEPOINT` 名；成功 `RELEASE SAVEPOINT`，失败 `ROLLBACK TO SAVEPOINT` 后 `RELEASE SAVEPOINT` 并重新抛错。用 `WeakMap<DatabaseSync, TransactionState>` 保存深度与序号，关闭连接后不保留状态。
- 保持同步回调契约；拒绝 `Promise`/thenable，避免在同步事务已经提交后继续写入。`lastInsertRowid` 进入既有 number 领域模型时显式 `Number()`，并为超出安全整数的值抛错或保留 bigint，不能静默精度丢失。
- `runMigrations` 接收连接并调用统一 helper；`migrateFromJson` 的整个导入、确认策略迁移的规则/套餐/版本标记写入必须各自在同一原子事务内完成。

### 2.3 实施步骤

1. 先新增 `scripts/probe-node-sqlite.mjs`，其在 `app.whenReady()` 后创建临时文件数据库，输出 `process.versions.electron`、`process.versions.node`，执行建表、写入、读取并校验结果；无论成功或失败都在 `finally` 调用 `app.quit()`，失败设置非零 `process.exitCode`。不得设置 `ELECTRON_RUN_AS_NODE`。
2. 先为事务 helper 写回归测试，再替换数据库实现与上表全部调用点。最低覆盖：提交、回调抛错后的完整回滚、嵌套成功、内层抛错被外层处理后的 savepoint 回滚、关闭后不可继续使用。
3. 增加/扩展 JSON 导入与 MCP 确认策略迁移测试：故意在中途制造约束错误或抛错，断言前序写入、套餐变更和迁移版本标记均未部分落盘；成功路径保持幂等。
4. 将 `@types/node` 升至含 `node:sqlite` 声明的最新 22.x；移除 `better-sqlite3`、`@types/better-sqlite3`、`node-abi`、`node-gyp`，以及 `rebuild:native`、`probe:sqlite`、绑定相关 `postinstall`/`prepack*`。删除 `asarUnpack` 和 `files` 中的 better-sqlite3 glob；**不要删除** `afterPack`。
5. 将 CI/release 的旧探针改为新探针，并从 `sqlite-electron-probe` 矩阵删除 `ubuntu-latest`。Windows x64、macOS x64、macOS arm64 都直接运行完整 Electron 主进程探针，且不得设置 `ELECTRON_RUN_AS_NODE`。普通单元测试、类型检查和 Electron 主进程编译仍可在 Ubuntu 上运行，但它们不构成 Linux 桌面应用兼容承诺，因此不引入 Xvfb。
6. 将真实 `userData/spaceassistant-data.db` 及其 `-wal`、`-shm` 文件复制到隔离临时目录，再对副本做启动、读写和关闭验证；不得直接操作开发者正在使用的数据文件。随后分别验证 Windows x64 安装包、macOS x64/arm64 安装包的首次启动与已有数据库读写。

### 2.4 Phase 1 自动门禁与清理门禁

| 门禁 | 通过标准 |
| --- | --- |
| 事务与迁移测试 | 聚焦新增/受影响 Vitest 测试全绿，随后 `npm test` 全绿 |
| 类型与构建 | `npm run typecheck:shared`、`npm run typecheck:renderer`、`npm run build:electron` 全绿 |
| 真实 Electron 探针 | Windows x64、macOS x64、macOS arm64 三个 CI runner 记录 Electron/Node 版本并完成一次文件数据库读写，成功与失败路径均稳定退出；Ubuntu 仅运行普通质量门禁 |
| 残留扫描 | `rg -n -S 'better-sqlite3|\.transaction\(' electron scripts package.json .github AGENTS.md CLAUDE.md` 无未批准结果；允许的 `transaction` 文本必须在计划实施时以文件/行和理由列入白名单 |
| 数据与产物 | 旧数据库副本验证通过；release dry-run（`--publish never`）通过；Windows x64、macOS x64/arm64 产物均完成启动和数据库读写人工验收 |

若 node:sqlite 存在无法在封装层消化的语义差异，回退必须恢复完整的原生绑定安装、CI 与打包配置，并先验证目标 Electron ABI 的可用预编译产物；不能只重新加入 npm 依赖。

## 3. Electron 兼容性影响矩阵

每次 Electron 阶段开始时，以 [官方 breaking changes](https://www.electronjs.org/docs/latest/breaking-changes/) 为唯一清单来源重跑下表检索。每行必须在 PR 中填写「命中位置与修复」或「检索命令、输出为空及不适用理由」；不能以单一四关键词检索代替。

| Electron | 官方变化类别 | 仓库核查与验收 |
| --- | --- | --- |
| 36 | `app.commandLine` 行为、`PrinterInfo`、`Session.clearStorageData`、session 扩展 API、GTK4 | 检索 `app.commandLine|clearStorageData|PrinterInfo|session\.(loadExtension|removeExtension|getAllExtensions)|isAeroGlassEnabled`；GTK4 仅记录为 Linux 桌面端不适用，其他命中在支持平台验证 |
| 37 | utility process 未处理拒绝/同步退出、WebUSB/WebSerial、`ProtocolResponse.session`、Linux workspace 可见性 | 检索 `utilityProcess|WebUSB|WebSerial|ProtocolResponse|IsVisibleOnAllWorkspaces`；工具子进程取消/退出在 Windows/macOS 验证，Linux workspace 行为记录为不适用 |
| 38 | `ELECTRON_OZONE_PLATFORM_HINT`、`ORIGINAL_XDG_CURRENT_DESKTOP`、macOS 11、`plugin-crashed`、webFrame 路由 API | 检索环境变量、`plugin-crashed|webFrame\.routingId|findFrameByRoutingId`；确认 macOS 11 已不在支持面 |
| 39 | `--host-rules`、`window.open` popup 可调整大小、macOS 音频捕获声明 | 检索 `host-rules|window\.open|setWindowOpenHandler|desktopCapturer|NSAudioCaptureUsageDescription`；外链/弹窗与屏幕/音频捕获实际路径冒烟 |
| 40 | renderer 直接 Electron `clipboard` 弃用、dSYM 改为 tar.xz | 检索 renderer/preload 的 `from 'electron'|require\('electron'\)|clipboard`；当前 renderer 应使用 `navigator.clipboard`，必要能力经 preload/contextBridge；检查调试符号消费链 |
| 41–43 | PDF WebContents、`Session.clearStorageData` 的 quotas、通知实现、dialog 默认目录、Linux dialog 参数 | 检索 `printToPDF|clearStorageData|Notification|showHiddenFiles|defaultPath`；PDF 导出、通知、文件选择器在 Windows/macOS 冒烟，Linux dialog 参数记录为不适用 |
| 44 | macOS 12、Windows ia32/Linux armv7l 下线；renderer clipboard 移除；`select-client-certificate` 的 `webContents` 可为空；`net.request` frame header；ANGLE 打包变化 | 发布支持面复核；检索 `clipboard|select-client-certificate|net\.request|libEGL|libGLESv2`；证书选择和网络请求命中时补充测试，产物中不得依赖独立 ANGLE 库 |

## 4. Phase 2：Electron 35 → 40

1. 完成 §3 中 Electron 36–40 每一行的适用性记录与必要修复，再升级 Electron 至选定 40.x，并把 `@types/node` 升至 `^24`；保持 CI Node 22 的 `npm ci`、测试和构建检查，用以验证 declared engine 下限。
2. 在锁定依赖后执行 `npm run build:electron`、`npm run typecheck:renderer`、`npm run typecheck:shared`、`npm test` 与 Windows x64、macOS x64/arm64 的完整 Electron 探针；Ubuntu 继续只跑普通质量门禁。
3. 在 Windows x64、macOS x64/arm64 手工冒烟：启动/升级旧库、聊天流式、工具调用循环、SQLite 读写、托盘、飞书/微信桥接、内嵌终端、PDF 导出与剪贴板；打包产物验证至少覆盖同一平台组合。

Phase 2 门禁为上述命令与人工矩阵均通过、`package-lock.json` 记录精确 Electron 版本、§3 的 36–40 行全部闭环。未闭环项必须阻断阶段合并。

## 5. Phase 3：Electron 40 → 44 与工具链升级

1. 先完成 §3 的 41–44 影响记录及平台支持决策；若 macOS 12 仍需支持，停止本阶段。
2. 升级 Electron 至选定 44.x，保持 `@types/node@^24`；完成构建、全量测试、三个受支持平台 runner 的探针和 Windows/macOS 三种产物验收。
3. 将 TypeScript、Vite、`@vitejs/plugin-react` 升至经 peer 依赖验证的相容稳定版本；Vitest 只有在 peer 约束要求时才随动。每次工具链变动后运行 `npm run build:renderer`、两项 typecheck、`npm test` 和 `npm run i18n:check`。
4. 以 `docs/develop/chat-message-list-renderer-performance-audit.md` 的约定口径采集相同 fixture 的渲染性能对比；若基线尚无实测数据，先补录基线，不能把“无回归”写成结论。

## 6. 交付顺序与证据归档

```
Phase 1  node:sqlite 替换、事务语义和 CI 探针
Phase 2  Electron 35 → 40（Node 24 类型基线）
Phase 3  Electron 40 → 44、平台下线确认与工具链升级
```

每阶段的 PR/发布记录必须附：精确依赖版本与 lockfile diff、§3 影响矩阵结论、自动命令输出、各平台探针结果、安装包手工验收记录，以及未自动化项的责任人与回归路径。参考资料： [Electron 版本发布页](https://releases.electronjs.org/release?channel=stable)、[Electron 40 发布说明](https://www.electronjs.org/blog/electron-40-0)、[Electron Breaking Changes](https://www.electronjs.org/docs/latest/breaking-changes/)、[Node SQLite API](https://nodejs.org/api/sqlite.html)。

## 附录 A：Phase 1 实施记录（2026-09-04）

实施分支 `chore/dependency-upgrade`（worktree `.worktrees/dep-upgrade`），基于 main。

### 版本与探针输出

- Electron **35.7.5**（内嵌 Node **22.16.0**），本机 Windows x64；`@types/node` 升至 `^22.20.1`（含 `node:sqlite` 声明）。
- `node:sqlite` 在 Electron 35 / Node 22.16 中为实验性 API，但**无需任何 flag**；启动时仅打印 `ExperimentalWarning: SQLite is an experimental feature`，主进程与探针均不做特殊处理。
- 探针 `scripts/probe-node-sqlite.mjs` 本机实跑（`npx electron scripts/probe-node-sqlite.mjs`，未设 `ELECTRON_RUN_AS_NODE`）：

```
[probe-node-sqlite] electron=35.7.5 node=22.16.0 arch=x64 platform=win32
[probe-node-sqlite] ok: file db write/read/checkpoint verified   (exit=0)
```

注：Windows Git Bash 的 MSYS pty 会吞掉 GUI 子进程 stdout，本机验证时输出需重定向到文件查看；CI runner（powershell/cmd）不受影响。

### 关键实现决策

- 事务 helper 落在 `electron/database/transaction.ts`（`runInTransaction(conn, fn)` + `lastInsertRowidToNumber`），由 `sqliteStore.ts` 再导出以保持「连接级事务入口由 sqliteStore 导出」的契约。未直接定义在 sqliteStore.ts 的原因：`sqliteStore → migrations → helper` 存在循环依赖，vite SSR/vitest 下循环边缘会拿到半初始化命名空间（实测 `runInTransaction is not a function`）。
- `node:sqlite` 与 better-sqlite3 的两处语义差异已在封装/迁移层消化：绑定值拒绝 `undefined`（`migrateFromJson` 可空列统一 `?? null`）；`run().changes`/`lastInsertRowid` 类型为 `number | bigint`（显式 `Number()`，`lastInsertRowidToNumber` 超安全整数抛错）。
- 既有测试遗留 `conn.transaction(fn)()` 的 `})()` 调用尾已在迁移中逐一清除（`mcpConfirmPolicyMigration.ts` 曾因此报错）。

### 门禁结果

- 聚焦测试：`sqliteStore.transaction.test.ts`（新增 11 例）、`migrations.v3/v4`、`mcpConfirmPolicyMigration`（含新增「事务中途写入失败」原子性用例）、`database.migrateAndSearch`（含新增「导入中途约束错误整体回滚」用例）、`legacyWorkspaceLayoutCleanup`、`operations`、`streamingCleanup` 等全绿；全量 `npm test` 全绿（详见提交说明）。
- `npm run typecheck:shared`、`npm run typecheck:renderer`、`npm run build:electron` 全绿。
- 残留扫描 `rg -n -S 'better-sqlite3|\.transaction\(' electron scripts package.json .github AGENTS.md CLAUDE.md`：无未批准命中。白名单（合理残留）：
  - `package-lock.json` 中 `node-abi`/`node-gyp`/`node-gyp-build` 为 electron-builder（app-builder-lib）的传递依赖，非本项目直接依赖，保留。
  - `.github/workflows/ci.yml` 注释中出现 `ELECTRON_RUN_AS_NODE` 字样，语义为「不得设置」，非实际设置。
  - `docs/` 下历史文档（含本计划、`b344321-current-code-refactor-plan.md`、`wechat-integration-requirement.md`）提及 better-sqlite3 为历史叙述，不在扫描路径内。
- AGENTS.md 为 gitignore 的本地文件（不在仓库内），其 better-sqlite3/原生绑定说明已在本地同步更新；CLAUDE.md 已随本提交更新。

### 需真机/人工验收项（本环境无法自动完成）

- macOS x64 / arm64 探针与安装包验收：由 CI `sqlite-electron-probe` 矩阵（windows-latest、macos-15-intel、macos-latest）执行探针；macOS DMG 首次启动与已有数据库读写需人工在真机验收。责任人：发布负责人；回归路径：CI 探针日志 + `npm run pack:mac` 产物人工冒烟。
- 旧数据库副本验证（真实 `userData/spaceassistant-data.db` 及其 `-wal`/`-shm` 复制到隔离目录做启动/读写/关闭）：需人工在装有旧版本数据的机器上执行。责任人：发布负责人；回归路径：升级安装包首次启动冒烟。
- Windows x64 安装包（NSIS）首次启动与已有数据库读写：同上，人工验收。

## 附录 B：Phase 2 实施记录（2026-09-04）

实施分支 `chore/dependency-upgrade`（worktree `.worktrees/dep-upgrade`），基于 Phase 1 提交 `b4d4daa`。

### 精确依赖版本

- `electron` **35.7.5 → 40.10.6**（devDependency，40 通道最新稳定 patch，来源 `npm view electron versions`；lockfile 记录精确版本）。
- `@types/node` **^22.20.1 → ^24.13.3**（Electron 40 内嵌 Node 24 的类型基线）。
- `engines`（package.json 未声明）与 CI/release workflow 的 Node **22 保持不变**（`.github/workflows/ci.yml`、`release.yml` 未改动）。
- 无 peer/类型冲突：`@types/node@^24` 升级后主进程全量编译（`tsc -p tsconfig.electron.json`）与两项 typecheck 均零错误，未出现需要降版或改代码的冲突。

### §3 影响矩阵 Electron 36–40 逐行结论（检索于升级前代码基线）

- **36**（`app.commandLine` 行为、`PrinterInfo`、`Session.clearStorageData`、session 扩展 API、GTK4）：检索 `app.commandLine|clearStorageData|PrinterInfo|session\.(loadExtension|removeExtension|getAllExtensions)|isAeroGlassEnabled`（范围 `electron/ src/ scripts/`），**输出为空**。应用不注册命令行开关、不打印、不清除站点存储、不加载浏览器扩展。GTK4 为 Linux-only，Linux 桌面端不在支持面，不适用。闭环，无需修复。
- **37**（utility process 未处理拒绝/同步退出、WebUSB/WebSerial、`ProtocolResponse.session`、Linux workspace 可见性）：检索 `utilityProcess|WebUSB|WebSerial|ProtocolResponse|IsVisibleOnAllWorkspaces`，**输出为空**。未使用 utilityProcess（工具循环在主次进程内）、未申请 WebUSB/WebSerial 权限、未自定义 protocol 响应。Linux workspace 可见性为 Linux-only，不适用。闭环，无需修复。
- **38**（`ELECTRON_OZONE_PLATFORM_HINT`、`ORIGINAL_XDG_CURRENT_DESKTOP`、macOS 11、`plugin-crashed`、webFrame 路由 API）：全仓检索上述环境变量与 `plugin-crashed|webFrame\.routingId|findFrameByRoutingId`，**代码输出为空**（仅本计划文档自身命中）。两个环境变量为 Linux-only，不适用；未使用 Pepper 插件与 webFrame 路由 API。macOS 11：产品发布面本就只声明 Windows x64、macOS x64/arm64，未承诺 macOS 11 最低版本，Electron 38 起最低 macOS 12 与发布面无冲突。闭环，无需修复。
- **39**（`--host-rules`、`window.open` popup 可调整大小、macOS 音频捕获声明）：检索 `host-rules|window\.open|setWindowOpenHandler|desktopCapturer|NSAudioCaptureUsageDescription`：
  - `host-rules`、`setWindowOpenHandler`、`desktopCapturer`、`NSAudioCaptureUsageDescription` 无命中（不做屏幕捕获、不做音频捕获、未注册弹窗处理器、未传 host-rules）。
  - **命中**：`src/renderer/services/openExternalUrl.ts:14` 及其测试使用 `window.open(url, '_blank', 'noopener,noreferrer')` 作为 `appOpenExternal` IPC 不可用时的回退。Electron 39 的变化是 popup 默认可调整大小；该路径意图是交给系统浏览器打开外链，弹窗是否可调整大小不影响功能，且正常路径走 `shell.openExternal`。**处理：记录为已知行为差异，不改代码**；外链打开归入人工冒烟矩阵。
- **40**（renderer 直接 Electron `clipboard` 弃用、dSYM 改 tar.xz）：检索 renderer/preload 的 `from 'electron'|require\('electron'\)|clipboard`：
  - renderer 无任何 `from 'electron'` / `require('electron')` 命中；所有剪贴板写入均走 `navigator.clipboard.writeText`（`selectionCopy.ts:21`、`FileTree.tsx:88,92`、`ShikiCodeBlock.tsx:18`、`xtermHelpers.ts:207`）或 copy 事件的 `clipboardData`，符合官方迁移方向。`electron/preload.ts` 无 clipboard 命中。
  - dSYM 改 tar.xz 仅影响调试符号消费链；本仓库发布流程（electron-builder NSIS/DMG，无 Sentry/符号服务器上传）不消费 dSYM，不适用。
  - 闭环，无需修复。

### 门禁结果（升级后，本机 Windows x64）

- `npm run build:electron`（rimraf + `tsc -p tsconfig.electron.json` 全量编译）：通过，零错误。
- `npm run typecheck:renderer`（`tsc -p tsconfig.renderer.json --noEmit`）：通过，零错误。
- `npm run typecheck:shared`：通过（`[typecheck:shared] ok`）。
- `npm test`（vitest run 双项目全量）：**447 个测试文件全部通过，2760 passed / 2 skipped（共 2762）**，耗时约 251s。
- 探针 `npx electron scripts/probe-node-sqlite.mjs`（未设 `ELECTRON_RUN_AS_NODE`，stdout 重定向到文件查看）：

```
[probe-node-sqlite] electron=40.10.6 node=24.15.0 arch=x64 platform=win32
[probe-node-sqlite] ok: file db write/read/checkpoint verified   (exit=0)
```

- 升级后无需修改任何主进程源码：无类型错误、无运行时 API 变化命中仓库代码。

### 需真机/人工验收项（本环境无法自动完成）

- **Windows x64 / macOS x64 / macOS arm64 人工冒烟矩阵**：启动与旧库升级、聊天流式、工具调用循环、SQLite 读写、托盘、飞书/微信桥接、内嵌终端、PDF 导出、剪贴板与外链打开（§3-39 命中路径）。责任人：发布负责人；回归路径：按 §4 第 3 条逐项人工冒烟，macOS 探针由 CI `sqlite-electron-probe` 矩阵（macos-15-intel、macos-latest）补跑。
- **安装包验收**：Windows NSIS 与 macOS x64/arm64 DMG 产物的首次启动与已有数据库读写。责任人：发布负责人；回归路径：`npm run pack:win` / `npm run pack:mac` 产物人工验收。


## 附录 C：Phase 3 实施记录（2026-09-03）

实施分支 `chore/dependency-upgrade`（worktree `.worktrees/dep-upgrade`），基于 Phase 2 提交 `af1abab`。

### 精确依赖版本

- `electron` **40.10.6 → 44.1.1**（44 通道最新稳定 patch，`npm view electron versions` 确认 44 系为 `44.0.0 / 44.1.0 / 44.1.1`，`latest` dist-tag 即 44.1.1；lockfile 记录精确版本）。Electron 44 运行时内嵌 Node 24.19.0（探针实测）。
- `@types/node` 保持 **^24**（lockfile 实际 24.13.3），未随动。
- `vite` **6.x → 8.2.2**、`@vitejs/plugin-react` **4.x → 6.1.1**（peer 约束 `@vitejs/plugin-react@6.1.1 → vite ^8.0.0`，组合成立）。
- `vitest` 保持 **^4** 主版本不随动（lockfile 内由 ^4.1.0 解析为 4.1.6）：`vitest@4` peer 为 `vite ^6.0.0 || ^7.0.0 || ^8.0.0-0`，覆盖 vite 8 稳定版，peer 约束不要求升主版本。
- `typescript` **5.7 → 5.9.3**（5.x 最新稳定）。曾尝试 `typescript@7.0.2`（npm latest）：TS 7 移除 `baseUrl` 与 `moduleResolution=node10`，主进程 tsconfig 迁移到 `NodeNext` 后全仓数百处相对 import 需补 `.js` 扩展名（`error TS2835`），属大规模侵入性改造，超出本阶段最小改动边界；按「不预设不相容版本、选可行方案」原则回退至 5.9.3，TS 7 迁移留作独立计划。

### §3 影响矩阵 Electron 41–44 逐行结论（清单来源：electronjs.org/docs/latest/breaking-changes 41.0–44.0 段）

- **41–43**（PDF WebContents、`Session.clearStorageData` quotas、macOS 通知迁移 UNNotification、dialog 默认 Downloads 目录、Linux `showHiddenFiles` 移除）——检索 `printToPDF|clearStorageData|showHiddenFiles|defaultPath|new Notification`（范围 `electron/ src/`）：
  - `clearStorageData`、`showHiddenFiles`、`new Notification` **无命中**：不清除站点存储、不传 showHiddenFiles、不使用系统 `Notification`（应用通知为自建浮动窗口 `floatingNotification*.ts`，macOS UNNotification 签名要求不适用）。
  - **命中**：`electron/appIpc.ts:1715` 使用 `webContents.printToPDF({ printBackground: true })` 导出 PDF。Electron 41 的变化是「PDF 资源不再创建独立 guest WebContents」，针对在窗口中直接加载 PDF 的场景；本仓库是自建的隐藏 BrowserWindow 加载 HTML 后调用 `printToPDF`，API 签名未变，不受该变化影响。记录为人工冒烟项（PDF 导出）。
  - **命中**：`electron/appIpc.ts:1697` `dialog.showSaveDialog` 显式传入 `defaultPath`（`absDefault`），不受「默认目录改为 Downloads」影响；`electron/appIpc.ts:1797` `dialog.showOpenDialog`（选择工作目录）未传 `defaultPath`，行为变化为初始目录固定为 Downloads 且系统不再记忆上次目录。评估为可接受的 UX 变化，**不改代码**，记录为人工冒烟项。Linux `showHiddenFiles` 移除为 Linux-only，不适用。
- **44**（macOS 12、Windows ia32/Linux armv7l 下线；renderer clipboard 移除；`select-client-certificate` 的 `webContents` 可为空；`net.request` frame header；ANGLE 静态链接）——检索 `clipboard|select-client-certificate|net\.request|libEGL|libGLESv2`（范围 `electron/ src/`）：
  - `select-client-certificate`、`net.request`、`libEGL`、`libGLESv2` **无命中**：不监听证书选择事件（无需补 nullable webContents 处理与测试）、不走 `net.request`（LLM/API 请求均走 Node https/fetch）、打包配置不引用独立 ANGLE 库（ANGLE 静态链接进二进制对本仓库无影响）。
  - renderer `clipboard` 复核（Phase 2 已确认）：renderer 无任何 `from 'electron'` / `require('electron')` 命中，全部走 `navigator.clipboard` 或 copy 事件 `clipboardData`；主进程亦无 `clipboard` 命中。Electron 44 移除 renderer clipboard 对本仓库无影响。
  - **平台支持决策已落地**：发布面明确为 **macOS 13+ / Windows x64 / macOS x64+arm64**。`package.json` `build.mac.minimumSystemVersion` 新增 `"13.0"`；`docs/develop/release-guide.md` 支持平台行更新为「Windows x64（NSIS）、macOS 13+（x64/arm64 DMG；Electron 44 起 macOS 12 不再受支持）」。Windows ia32 与 Linux armv7l 本就不在发布配置内（build 仅 win nsis x64、mac dmg x64+arm64、linux AppImage 为开发便利产物，非支持承诺）。

### 门禁结果（本机 Windows x64）

- Electron 44.1.1 升级后：`npm run build:electron` 全量编译通过（零错误）；`npm run typecheck:shared`、`npm run typecheck:renderer` 通过；`npm test` 全绿（**447 文件 / 2760 通过 / 2 跳过**，718s）。
- 真实 Electron 探针：`npx electron scripts/probe-node-sqlite.mjs` 输出 `electron=44.1.1 node=24.19.0 arch=x64 platform=win32`，`ok: file db write/read/checkpoint verified`（stderr 仅 libpng iCCP 警告，为托盘图标既有提示，与本次升级无关）。
- 工具链升级后（vite 8.2.2 + plugin-react 6.1.1 + TS 5.9.3 + vitest 4.1.6）：`npm run build:renderer` 通过（Vite 8 / rolldown 构建，仅 chunk 体积提示）；两项 typecheck 通过；`npm run i18n:check` 通过（硬编码中文计数为既有存量告警，非新增）。
- 工具链引入的一处真实修复：Vite 8 的 oxc transform 比 esbuild 严格，`electron/database.migrateAndSearch.test.ts:372` 存在重复 `import { getDbConnection }`（与 15 行重复声明），esbuild 容忍、oxc 报 PARSE_ERROR；删除文件尾部多余的重复 import（该行本就无效），修复后单测 7/7 通过。
- 最终 `npm test` 全绿（**447 文件 / 2760 通过 / 2 跳过**，233s）。期间 `src/shared/toolResultPairing.test.ts` 的「10000 条消息 < 50ms」耗时断言在高负载轮次出现 56–59ms 超时，空闲轮复跑与全量复跑均通过，确认为计时阈值 flaky（该代码路径本次未改动，vitest 仅 4.1.0→4.1.6 次要 bump），非升级回归。

### 渲染性能对比（§5 第 4 条口径）

按 `docs/develop/chat-message-list-renderer-performance-audit.md` §7 的约定口径，基线实测数据已存在（`chat-message-list-batch{1,2}-remeasure-results.json`，vitest+jsdom+React.Profiler，同一 fixture），升级后于机器空闲时以相同测试重采。对比（升级前 09-03 16:43 采集 → 升级后 09-03 17:41 采集，同机 win32 x64 / Node 24.19.0）：

| 批次 | 场景 | 消息数 | mount ms（前→后） | 流式 commit p95 ms（前→后） | DOM 节点（前→后） | heap MB（前→后） |
| --- | --- | --- | --- | --- | --- | --- |
| batch1 | small | 20 | 78.2 → 54.4 | 1.68 → 1.09 | 201 → 201 | 0.0 → 0.0 |
| batch1 | large | 500 | 766.2 → 689.2 | 5.85 → 4.65 | 4682 → 4682 | 52.4 → 51.3 |
| batch2 | 全量语料 | 500 | 858.4 → 896.5 | 9.29 → 5.02 | 4680 → 4680 | 59.8 → 60.3 |
| batch2 | 折叠 | 60 | 247.4 → 81.0 | 4.38 → 0.96 | 580 → 580 | 10.3 → 10.2 |

结论：DOM 节点数与堆占用完全一致（±1 MB），commit 耗时在 jsdom 近似口径下无上升迹象。注意该口径为 vitest+jsdom+React.Profiler 近似测量，对机器负载敏感（高负载轮次曾出现 2–3 倍漂移），不构成「无回归」的强结论；真实应用内的 FPS、Long Task、内存曲线仍为人工测量项。两个 remeasure-results.json 会被测试重写，未纳入提交。

### 需真机/人工验收项（本环境无法自动完成）

- **Windows x64 / macOS x64 / macOS arm64 人工冒烟矩阵**：在 Electron 44 下回归启动与旧库升级、聊天流式、工具调用循环、SQLite 读写、托盘、飞书/微信桥接、内嵌终端、**PDF 导出**（§3-41 printToPDF 命中）、**目录选择对话框初始目录**（§3-43 行为变化，确认 Downloads 初始目录可接受）、剪贴板与外链打开。macOS 探针由 CI `sqlite-electron-probe` 矩阵补跑。
- **macOS 13 下限验证**：mac 产物 `minimumSystemVersion: 13.0` 生效（LSMinimumSystemVersion 写入 Info.plist），并在 macOS 13 机器上验证启动。
- **安装包验收**：Windows NSIS 与 macOS x64/arm64 DMG 产物首次启动与已有数据库读写。
- **真实渲染性能**：按审计文档 §7 在约定最低配置机器上用 React Profiler / Performance 面板复核四组 fixture。
- **TypeScript 7 迁移**：`baseUrl`/`node10` 移除与 NodeNext import 扩展名改造为独立计划，不在本阶段。
