# Wiki 专属能力接口发布验收记录

> 状态：E-14 本机源码已关闭；E-15 和 E-16 尚缺外部证据。E-16 已完成 macOS 候选包静态校验、隔离副本首次启动/初始化，以及本机 fixture reconciler 集成测试；目标平台安装迁移和旧版二进制写入验收仍待完成。未经验收不得执行 E-17 或将 Wiki lifecycle 转为 `domain_enabled`。
> 执行计划：[wiki-domain-tools-execution-plan.md](./wiki-domain-tools-execution-plan.md)

## 验收信息

| 项目 | 记录 |
| --- | --- |
| 验收日期 | 2026-10-18 |
| 源码关闭提交 | `f5b27dbd`（实现）、`61e320a7`（策略分类）、`e66bbf17`（E-14 证据）、`2737d84f`（首次启动 lifecycle 显示修复） |
| 候选版本 | SpaceAssistant 0.2.7 |
| 当前结论 | 源码修复后的本机全量验收通过；外部渠道、安装包运行时迁移验收未完成；不启用 |

## E-14 本机源码验收

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 全量测试（最终复验） | 通过 | `npm test`：1108 个文件通过、1 个跳过；10477 项通过、111 项跳过 |
| 完整构建（修复后复验） | 通过 | `npm run build`；Vite 有既有动态导入与 chunk size 警告 |
| 类型、i18n 与 invariant 门禁（修复后复验） | 通过 | `npm run typecheck:renderer`、`npm run typecheck:shared`、`npx tsc -p tsconfig.electron.json --noEmit`、`npm run i18n:check`、`npm run check:system-invariant-registry` |

## 隔离启动发现的源码回归

在临时复制的 macOS 候选应用中，将 Bundle ID 改为 `com.spaceassistant.wikie16`，并把主进程 `app.getPath('userData')` 重定向到独立 `/tmp` 目录后，首次启动 Wiki 页错误显示“迁移控制状态需要恢复”，尽管 Wiki 根目录尚不存在。提交 `2737d84f` 修复展示查询：不存在根时不附带 lifecycle 状态；安全守卫 `read()` 仍 fail-closed；已有根缺少 lifecycle 控制文件仍返回 `recovery_required`。两项生命周期边界断言通过，完整复验见 E-14。

## E-15 真实渠道与确认展示

| 验收项 | 环境/版本 | 匿名化证据 | 结论 | 负责人/日期 |
| --- | --- | --- | --- | --- |
| 桌面 SCHEMA 修改确认、拒绝与取消 | 待提供隔离环境 | 待记录 | 待验收 | — |
| 桌面长正文恢复确认可读性 | 待提供隔离环境 | 待记录 | 待验收 | — |
| 飞书真实会话确认、拒绝与取消 | 待提供隔离测试账号 | 待记录 | 待验收 | — |
| 微信真实会话确认、拒绝与取消 | 待提供隔离测试账号 | 待记录 | 待验收 | — |
| automation 无人工确认时拒绝 Schema/恢复 | 待提供隔离 automation 会话 | 待记录 | 待验收 | — |

## E-16 候选安装包与文件变化协调

| 验收项 | 环境/版本 | 匿名化证据 | 结论 | 负责人/日期 |
| --- | --- | --- | --- | --- |
| macOS x64 候选 DMG 生成与镜像校验 | macOS 26.5.2 arm64 主机；0.2.7；提交 `2737d84f` 后重打包 | `release/SpaceAssistant-0.2.7.dmg`；`hdiutil verify` 通过；Mach-O 为 x86_64；SHA-256 `22f123b1864b6ee075a7ee6f75cce02446d9148463873bc3f6d79eb1edff541b` | 镜像、架构和本机 ad-hoc 签名静态检查通过；未在 x64 硬件安装 | Codex / 2026-10-18 |
| macOS arm64 候选 DMG 生成与镜像校验 | macOS 26.5.2 arm64 主机；0.2.7；提交 `2737d84f` 后重打包 | `release/SpaceAssistant-0.2.7-arm64.dmg`；`hdiutil verify` 通过；Mach-O 为 arm64；SHA-256 `a56c7c10032eaec8e17beca3448d055176eed8c60160c90e8667405a9bfaad4f` | 镜像、架构和本机 ad-hoc 签名静态检查通过 | Codex / 2026-10-18 |
| 应用签名与分发资格 | macOS 26.5.2 | electron-builder 未找到 Developer ID Application identity；应用 ad-hoc 签名并通过本地 `codesign --verify --deep --strict` | 仅本机候选检查；未签名公证、未作发布资格结论 | Codex / 2026-10-18 |
| 隔离 userData 安装启动（首次尝试） | macOS 26.5.2 arm64；0.2.7 | 临时 `HOME` 未改变 Electron `app.getPath('userData')`。候选进程读取了现有 `SpaceAssistant-dev` 会话并启动 spill 索引回填/协调；启动后共享目录有 22 个文件的修改时间落在五分钟窗口内。无操作前快照，无法归因或核实实际差异 | 隔离失败；候选进程已停止；未执行 Wiki 迁移，也未尝试回滚共享资料 | Codex / 2026-10-18 |
| 隔离候选副本首次启动及 Wiki 初始化 | macOS 26.5.2 arm64；0.2.7；`com.spaceassistant.wikie16` 临时副本 | 仅复制候选 app 后在副本内重写 Bundle ID、注入 `SPACEASSISTANT_E16_USER_DATA` 到 pre-ready `app.setPath`，再 ad-hoc 签名；运行窗口来自副本 app.asar。Wiki 首屏显示“Wiki 尚未初始化”；初始化生成 bootstrap seal/state 且 bootstrapId/root identity 匹配、生命周期为 `domain_ready`。Wiki 目录权限 `0755`、SCHEMA `0644`、state `0600` | 隔离启动/初始化和本机权限冒烟通过；测试对象是重定向 userData 的临时副本，不是原样候选 app 安装 | Codex / 2026-10-18 |
| 外部 Schema/page/raw 修改后的领域协调与 index/log 投影 | macOS 本机 Vitest fixture；提交后源码 | `electron/wiki/wikiDomainTools.test.ts` 新增已有 catalog/revision/history 基线；fixture 外部修改 SCHEMA、page 正文并新增 raw 文件，领域搜索触发协调：page revision 1→2，保留正文，写入 schema/page history 与 schema state，重建 index/log。`npm exec vitest run electron/wiki/wikiLifecycle.test.ts electron/wiki/wikiDomainTools.test.ts electron/wiki/wikiReconciliationService.test.ts`：3 文件、28 项通过；完整 suite 1108 文件通过/1 跳过，10477 项通过/111 跳过 | 本机集成 fixture 通过；没有通过候选 app 进程触发该领域工具，也没有旧版二进制实际写入证据 | Codex / 2026-10-18 |
| 旧版二进制/外部编辑器修改 fixture 后候选包重启与协调 | 待隔离旧版和候选包端到端 fixture | 临时副本可安全启动并观察初始化；外部文件保留已手工确认，但没有 provider-free 的 UI 领域工具入口，未向候选 app 配置模型凭据或发起网络请求 | 待验收 | — |
| 目标平台 userData 权限与 `safeAtomicWrite` 兼容性 | macOS 26.5.2 arm64 本机 fixture | 用实际候选副本初始化所得 Wiki 根与 lifecycle 文件权限如上；domain file store 写入由本机集成测试覆盖。其他 macOS 版本、x64 硬件及真实安装路径未验证 | 部分本机证据；目标平台验收待完成 | Codex / 2026-10-18 |

## E-17 启用门禁

E-17 未执行。只有 E-15 与 E-16 每项都有通过结论、版本、隔离环境、证据和负责人记录后，才可检查目标 Wiki 根的 bootstrap seal / lifecycle / migration manifest，并按计划执行启用。当前状态继续保持 `domain_ready`；无有效证据时不得启用旁路规则。
