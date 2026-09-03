# 依赖版本迭代计划（Node / Electron / 工具链）

制定日期：2026-08-31（v2，依据 `docs/review/dependency-upgrade-plan-2026-08-review-v1.md` 评审结论修订）

## 0. v2 修订摘要

对照评审报告，v1 有 3 个阻断性问题，本版全部修正：

1. **执行顺序反转**：评审实测 **Electron 35.7.5 完整主进程（内嵌 Node 22.16.0）已可直接使用 `node:sqlite`，无需任何 flag**——v1 中「Electron 37+ 起可用」的断言过保守且错误。因此把 node:sqlite 替换提到最前（Phase C → 现在的 Phase 1），在现有 Electron 35 上完成；之后的 Electron 升级变成**纯 JS 升级**，彻底绕开本机无 Visual Studio Build Tools、better-sqlite3 跨 ABI 无预编译绑定的死结（评审阻断 1）。
2. **清理清单补全**：v1 遗漏了 CI/release workflow、运维脚本、`prepack*` 钩子、`node-abi`/`node-gyp` 依赖、`CLAUDE.md` 等 8 处 better-sqlite3 硬引用，卸载依赖会直接打红发布流水线（评审阻断 2）。已全部补入 Phase 1 清理清单（§3）。
3. **可行性证据固化**：评审已替本计划在真实 Electron 主进程中验证 `node:sqlite` 可用（v1 只测了系统 Node，证据链不成立，评审阻断 3）。该验证固化为 Phase 1 的显式门禁项（新增 `probe:node-sqlite` 脚本）。

其余采纳的评审意见：`engines` 写 `>=22.13`（Vite 7 下限为 22.12，但 22.12 上 `node:sqlite` 仍需 flag，取 22.13 更严谨）、`migrations.ts` 存在 better-sqlite3 类型引用需一并改、`pragma()` → `exec()` 映射已核实安全（`sqliteStore.ts:86-88,97` 四处返回值均被丢弃）、命名参数裸键绑定与 null 原型对象行为已实测与 better-sqlite3 一致、`afterPack` 钩子与 better-sqlite3 无关（清理清单已明确标注勿动）、CI/release 探针的 `ELECTRON_RUN_AS_NODE: '1'` 变量需随探针替换一并删除。

## 1. 现状盘点

| 项目 | 当前版本 | 目标版本 | 说明 |
| --- | --- | --- | --- |
| 本机 Node（开发环境） | v24.19.0 | 保持 v24 LTS | 已是最新 LTS 线，无需变动 |
| Electron | ^35.7.5 | ^44.1.0 | 35 早已 EOL；44 为当前最新稳定大版本（Chromium 152 / Node 24.19） |
| electron-builder | ^25.1.8 | ^26.x | 新版要求 Node ≥ 22，本机已满足 |
| TypeScript | ^5.7.2 | ^5.9.x | 跟随 Electron 44 类型 |
| Vite | ^6.0.3 | ^7.x | 仅渲染进程构建，可独立升级；注意 Vite 7 要求 Node ≥ 20.19/22.12 |
| `@vitejs/plugin-react` | ^4.3.4 | 最新 major | Vite 7 下需要支持 Vite 7 peer 的新 major |
| vitest | ^4.1.0 | 保持 / 跟随 Vite 主版本 | 已较新 |
| React / antd | 18.3 / 5.22 | 本次不动 | 与 Electron 升级解耦，避免一次改太多 |
| better-sqlite3 | ^12.11.1 | **移除（Phase 1）** | 用内置 `node:sqlite` 替代 |
| `node-abi` / `node-gyp` | dependencies / devDependencies | **移除（Phase 1）** | 随 better-sqlite3 一起退场（`node-abi` 放在 dependencies 本就不妥） |
| `package.json` engines | 未声明 | 补充 `"node": ">=22.13"` | 对齐 Vite 7 / electron-builder 26 的最低要求（Vite 7 下限 22.12；取 22.13 是因 22.12 上 `node:sqlite` 仍需 `--experimental-sqlite` flag，22.13 起免 flag，与本计划 Phase 1 的测试环境语义一致。实际开发机均为 Node 24，影响仅为理论层面） |

支持窗口参考：Electron 官方只维护最近 3 个稳定大版本（当前 42 / 43 / 44），35 已无任何安全更新。

## 2. Phase 1（原 Phase C，提前执行）：node:sqlite 替换 better-sqlite3

### 可行性依据（评审实测，已固化）

```
$ electron.exe probe-node-sqlite-electron.cjs   # 完整 Electron 主进程（非 ELECTRON_RUN_AS_NODE）
[probe] electron 35.7.5 node 22.16.0 node:sqlite OK [{"a":42}]
```

即现有 Electron 35 即可用 `node:sqlite`（内嵌 Node ≥ 22.16，无需 flag）。其余已实测结论：

- 系统 Node 24.19.0：`node:sqlite` OK，FTS5 虚拟表可建（本项目搜索未用 FTS5，已全文检索确认）；
- 命名参数：现有 SQL 用 `@id` 前缀、绑定时传裸键（如 `operations.ts:239`），实测 Node 24 下**裸键与前缀键均可绑定**，可直接平移；
- `.all()` / `.get()` 返回 null 原型对象：与 better-sqlite3 行为一致，无需改调用方；
- `sqliteStore.ts:86-88,97` 四处 `pragma()` 返回值均被丢弃（含 `wal_checkpoint`），`exec('PRAGMA ...')` 映射安全；未来若需读 PRAGMA 返回值，用 `db.prepare('PRAGMA ...').all()`。

### 收益

- 删除 better-sqlite3 及整条原生绑定安装链：Windows 新机器 `npm install` 不再需要 VS Build Tools，不再可能卡 node-gyp；
- 消除「Electron ABI 与 Node ABI 不一致导致绑定加载失败」整类故障；
- 修复本机现状：无 VS 机器上 `npm test` 中依赖 better-sqlite3 Node 绑定的测试目前必然失败，替换后本地全量测试才可能真正全绿；
- 安装包体积减小，打包链路简化。

### 迁移方案

API 对照（两者都是同步 API，语义高度接近）：

| better-sqlite3 | node:sqlite |
| --- | --- |
| `new Database(path)` | `new DatabaseSync(path)` |
| `db.pragma('journal_mode = WAL')` | `db.exec('PRAGMA journal_mode = WAL')` |
| `stmt.run(...params)` → `{changes, lastInsertRowid}` | `stmt.run(...)` → 同形（`lastInsertRowid` 为 `number \| bigint`，涉自增 id 处统一 `Number()`） |
| `stmt.get(...)` / `stmt.all(...)` | 同名，行为一致（含 null 原型对象） |
| `db.transaction(fn)` | **没有**，需在 `sqliteStore.ts` 内用 `BEGIN` / `COMMIT` / `ROLLBACK` 封装等价 helper，保持上层签名不变 |

改动面：`electron/database/sqliteStore.ts`（连接与语句执行层）+ `electron/database/migrations.ts:1`（`import type Database from 'better-sqlite3'` 类型引用）+ 少量调用点。

注意：Node 22.16 的 `node:sqlite` 仍带 `ExperimentalWarning`，属正常；后续 Electron 44（Node 24）下该警告消失。

### 步骤

1. 新增 `scripts/probe-node-sqlite.mjs`（仿照现有 `scripts/probe-better-sqlite3.mjs`），在**完整 Electron 主进程**下验证 `node:sqlite` 可用，注册为 `npm run probe:node-sqlite`；
2. 用 `node:sqlite` 重写 `sqliteStore.ts` 连接/执行层，封装 `transaction(fn)` helper；改 `migrations.ts` 类型引用；`lastInsertRowid` 统一 `Number()`；
3. 跑 `npm run test:electron`，再全量 `npm test`；
4. **清理清单（评审补全版，逐项核对）**：
   - `npm uninstall better-sqlite3 @types/better-sqlite3 node-abi`；移除 devDependencies 中的 `node-gyp`；
   - `package.json` scripts：删除 `rebuild:native`、`probe:sqlite`、`postinstall` 中的绑定安装、`prepack` / `prepack:win` / `prepack:mac` 三个钩子；
   - `package.json` build 字段：删除 `asarUnpack` 中的 `"**/better-sqlite3/**"` 与 `files` 中的 `"node_modules/better-sqlite3/**"`（卸载后是死 glob，一并清掉）。**注意：`afterPack` 钩子 `scripts/after-pack.cjs` 与 better-sqlite3 无关**（它做的是 Windows exe 图标修补 resedit 和 macOS arm64 ad-hoc 签名），**不要动**，误删会破坏打包图标和 macOS 启动；
   - 删除脚本：`scripts/install-sqlite-bindings.mjs`、`scripts/probe-better-sqlite3.mjs`、`scripts/native-bindings-manifest.json`、`scripts/rebuild` 相关脚本；
   - 迁移或删除调试工具：`scripts/read-wechat-config.mjs`（改用 `node:sqlite`）、`scripts/probe-wechat-start.cjs` / `scripts/probe-wechat-state.cjs`（改用 `node:sqlite`）；
   - `scripts/dry-run-mac-pack.mjs:158-164`：删除 better-sqlite3 electron 绑定存在性校验段；
   - `.github/workflows/ci.yml:20,50,52`：删除 `npm run rebuild:native` ×2 与 `npm run probe:sqlite`，替换为 `npm run probe:node-sqlite`；**同时删除探针步骤上的 `ELECTRON_RUN_AS_NODE: '1'` 环境变量**（ci.yml:54 附近）——新探针要求在完整 Electron 主进程下运行，带此变量测的是 Node 模式而非真实运行时；
   - `.github/workflows/release.yml:44,77,93`：同上处理（含 "Probe better-sqlite3 under Electron" 步骤），**同样删除其 `ELECTRON_RUN_AS_NODE: '1'` 环境变量**（release.yml:95 附近）；
   - 文档：更新 `AGENTS.md` 与 `CLAUDE.md` 的数据库/构建段落；
5. 老用户数据兼容验证：用现有 `userData` 下的 `spaceassistant-data.db`（含 WAL）启动，确认读取无缝（文件格式相同）；
6. 打包验证：`npm run pack:win` 实装跑核心路径。

### Phase 1 门禁

`probe:node-sqlite`（Electron 完整主进程）OK + `npm test` 全量绿 + 老数据文件读取验证 + `ci.yml` 全绿 + `release.yml` 一次 dry-run（`--publish never`）通过 + `pack:win` 实装验证。

### 回退

若实测发现 `node:sqlite` 在某条 SQL 上有封装层吸收不掉的行为差异，回退到 better-sqlite3，但此时必须先在 `native-bindings-manifest.json` 登记新 ABI 预编译包（v1 断言「v12 对 Electron 44 仍有 prebuild」无验证依据，评审已指出），否则后续 Electron 升级卡死。

## 3. Phase 2（原 Phase A）：Electron 35 → 40

此时已无原生模块，是纯 JS 升级，「本机无 VS」从阻断项变为无关项。

重点 breaking changes（35 之后）：

- **Electron 36**：移除部分废弃 API；macOS 最低系统版本提升（本项目 Windows 优先，影响小）。
- **Electron 37**：Node 升级到 22；`session.cookies` 部分行为收紧。
- **Electron 38**：Chromium 140；`webContents` 打印 API 调整。
- **Electron 39/40**：Node 22 LTS 后续 minor；`desktopCapturer` 旧回调签名等移除。

行动项：

1. 升级前全文检索 `grep -rn "shell.openItem\|remote\b\|new-window\|scrollBounce" electron/`，确认未命中已移除 API（`remote` 模块本项目未用，走 IPC，已确认）；
2. `npm install -D electron@^40`；同步升级 `electron-builder` 到最新、`@types/node` 到 ^22（以 Electron 40 内嵌 Node 为准）；
3. 在 `package.json` 增加 `"engines": { "node": ">=22.13" }`；
4. 验证：`npm run build:electron` + `npm run typecheck:renderer` + `npm run test:electron`；手动冒烟 `npm run dev`（聊天流式 / 工具调用循环 / SQLite 读写 / 托盘 / 飞书微信桥接 / 内嵌终端）；
5. `npm run pack:win` 实装验证（重点：node:sqlite 在新 ABI 下的表现——它是内置模块，无绑定问题，但仍过一遍数据库路径）。

## 4. Phase 3（原 Phase B）：Electron 40 → 44 + 工具链随行升级

- **Electron 41–44**：Node 升到 24（与开发机一致，`@types/node` 升到 ^24）；Chromium 146→152 的 Web 平台变更对渲染进程（React/antd）基本透明，主要关注 `session` 权限处理器收紧；Node 24 下 `node:sqlite` 不再是 experimental，警告消失。
- 行动项与 Phase 2 相同：升级 → 检索废弃 API → 构建 + 测试 → dev 冒烟 → pack:win 实装。
- 额外验证项：新版 Chromium 渲染性能回归——对照 `docs/develop/chat-message-list-renderer-performance-audit.md` 的基线数据做一次对比。
- 工具链同批做：
  - TypeScript ^5.7 → ^5.9：`tsc -p tsconfig.electron.json --noEmit` 与 `npm run typecheck:renderer` 全绿为准；
  - Vite ^6 → ^7 + `@vitejs/plugin-react` 升到支持 Vite 7 peer 的新 major：`npm run build:renderer` 通过即可；
  - vitest 如有 peer 约束再同步升级，保持 `pool: 'forks'`（electron 项目）配置不变。

## 5. 执行顺序与验收门禁

```
Phase 1  node:sqlite 替换（在现有 Electron 35 上）  门禁：probe node:sqlite(Electron 完整主进程) + npm test 全量
         + 老数据文件读取验证 + ci.yml 全绿 + release.yml dry-run + pack:win 实装
Phase 2  Electron 35 → 40（已无原生模块）          门禁：build + typecheck + test + dev 冒烟 + pack:win 实装
Phase 3  Electron 40 → 44 + 工具链                 门禁：同上 + 渲染性能基线对比
```

每个 Phase 单独一个分支 / 提交单元，门禁全绿再进下一个。预计工作量：Phase 1 约一天（含脚本与 CI 清理），Phase 2/3 各半天到一天（大头在冒烟验证）。

## 6. 参考资料

- [Electron Releases（版本与内嵌 Node/Chromium 对照）](https://releases.electronjs.org/releases/stable)
- [Electron 版本支持策略](https://electronjs.org/docs/latest/tutorial/electron-timelines)
- [electron 生态迁移到 Node 22 公告](https://electronjs.org/blog/ecosystem-node-22)
- [Node 内置 sqlite 模块介绍](https://blog.logrocket.com/using-built-in-sqlite-module-node-js/)
- 评审报告：`docs/review/dependency-upgrade-plan-2026-08-review-v1.md`
