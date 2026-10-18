# Wiki 专属能力接口发布验收记录

> 状态：待 E-15 / E-16 外部证据；当前仅记录 E-14 本机关闭与 macOS 候选包静态检查。未经验收不得执行 E-17 或将 Wiki lifecycle 转为 `domain_enabled`。
> 执行计划：[wiki-domain-tools-execution-plan.md](./wiki-domain-tools-execution-plan.md)

## 验收信息

| 项目 | 记录 |
| --- | --- |
| 验收日期 | 2026-10-18 |
| 源码关闭提交 | `f5b27dbd`（实现）、`61e320a7`（策略分类）、`e66bbf17`（E-14 证据） |
| 候选版本 | SpaceAssistant 0.2.7 |
| 当前结论 | 本机测试与构建通过；外部渠道、安装包运行时迁移验收未完成；不启用 |

## E-14 本机源码验收

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 全量测试 | 通过 | `npm test`：1108 个文件通过、1 个跳过；10474 项通过、111 项跳过 |
| 完整构建 | 通过 | `npm run build`；Vite 有既有动态导入与 chunk size 警告 |
| 类型、i18n 与 invariant 门禁 | 通过 | `npm run typecheck:renderer`、`npm run typecheck:shared`、`npx tsc -p tsconfig.electron.json --noEmit`、`npm run i18n:check`、`npm run check:system-invariant-registry` |

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
| macOS x64 候选 DMG 生成与镜像校验 | macOS 26.5.2 arm64 主机；0.2.7 | `release/SpaceAssistant-0.2.7.dmg`；`hdiutil verify` 通过；DMG 内 Mach-O 为 x86_64；SHA-256 `0dfbd0c917d7d5c6c0880920785cb095dc72d476ba84ed93dbede14f8373fda0` | 包与架构静态检查通过；安装/迁移运行时未验收 | Codex / 2026-10-18 |
| macOS arm64 候选 DMG 生成与镜像校验 | macOS 26.5.2 arm64 主机；0.2.7 | `release/SpaceAssistant-0.2.7-arm64.dmg`；`hdiutil verify` 通过；Mach-O 为 arm64；SHA-256 `36e9f55e3d950512f4b8e171da0dff6120524facb7474e142351a71608aed108` | 包与架构静态检查通过；安装/迁移运行时未验收 | Codex / 2026-10-18 |
| 应用签名与分发资格 | macOS 26.5.2 | electron-builder 未找到 Developer ID Application identity；应用 ad-hoc 签名并通过本地 `codesign --verify --deep --strict` | 仅本机候选检查；未签名公证、未作发布资格结论 | Codex / 2026-10-18 |
| 隔离 userData 安装启动 | macOS 26.5.2 arm64；0.2.7 | 临时 `HOME` 未改变 Electron `app.getPath('userData')`。候选进程读取了现有 `SpaceAssistant-dev` 会话并启动 spill 索引回填/协调；启动后共享目录有 22 个文件的修改时间落在五分钟窗口内。无操作前快照，无法归因或核实实际差异 | 隔离失败；候选进程已停止；未执行 Wiki 迁移，也未尝试回滚共享资料 | Codex / 2026-10-18 |
| 旧版/外部编辑器修改 fixture 后新版协调页面、SCHEMA、raw、index/log | 待提供隔离旧版/候选包环境 | 待记录 | 待验收 | — |
| 目标平台 userData 权限与 `safeAtomicWrite` 兼容性 | 待验收目标平台 | 待记录 | 待验收 | — |

## E-17 启用门禁

E-17 未执行。只有 E-15 与 E-16 每项都有通过结论、版本、隔离环境、证据和负责人记录后，才可检查目标 Wiki 根的 bootstrap seal / lifecycle / migration manifest，并按计划执行启用。当前状态继续保持 `domain_ready`；无有效证据时不得启用旁路规则。
