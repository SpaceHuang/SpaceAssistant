# 依赖版本迭代计划（Node / Electron / 工具链）

制定日期：2026-08-31；修订日期：2026-09-03（v3）
状态：**修订后待实施**。本版吸收 `docs/review/dependency-upgrade-plan-2026-08-review-v2.md` 的三项阻断意见，并以当前仓库检索结果和 Electron/Node 官方文档复核。

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
