# SC-01B 兼容性评审包（仅用于隔离候选验证）

状态：**Accepted（仅限固定候选的 disposable-profile C-on 包级技术演练）**。独立核对及补充 x64 三态实包读取记录见本文件决定部分与 [x64 补充 smoke manifest](./session-storage-c01b-x64-state-smoke-manifest-2026-10-06.json)。该决定不授权正式发布、真实 profile 操作或真实正文清理。

## 评审范围

判断固定的 R-02 回滚候选是否能读取候选 C-on 所依赖的数据格式及 `write-stopped`、`pending`、`complete` 状态，并决定是否允许将该记录用于后续 **disposable-profile 的 C-on 包级演练**。

拟议决定仅作用于下列精确候选身份。它不代表 R 已公开发布或构成生产 rollback floor；不批准 C-on 正式发布/部署；不授权读取或写入真实用户 profile；不批准任何数据集的停写或清理。若后续 SC-SCOPE-PKG 改变 C source identity，必须依计划更新并重审兼容记录。

## 精确候选身份

| 项目 | R-02 回滚读取候选 | SC-00 清理版本候选基线 |
| --- | --- | --- |
| 版本 | `0.2.4`（本地候选版本号，不表示正式发行） | `0.2.4`（本地候选版本号，不表示正式发行） |
| source commit | `837a9c713d6f9c463749e63956f19db35de2cdf3` | `3bd50b224c5abf95821525e57985fad0c11051c0` |
| source tree | `03d9c8a4e0c7621241df1d10428f021e64463067` | `9c766b629ffafe8cf29a51c46ef1faecfea07b4f` |
| schema / History / spill / projection cache | `52 / 1 / 1 / 1` | `52 / 1 / 1 / 1` |
| macOS arm64 artifact SHA-256 | `0fdc0bf2152cf677b9abb8d966d11f4838b677cee16bc84d2c2831f53652ef46` | `f680d1d309322d33edfdfccc2124a4b205e96960638e537b906613406a403e35` |
| macOS x64 artifact SHA-256 | `8bfb24cf056a6dd1d41e4d28e250978812d93d1d40dc37cf1632cc0bf11cdfbc` | `dbfce0ee838dcee42b32a8b1c96518413a0cda0bdff47e4386486239d2f64bb1` |
| 清理配置 | `allowContentCleanup=false`，compatibility record 为空 | `allowContentCleanup=false`，compatibility record 为空 |
| 正式发布状态 | 尚未发布；本地候选，source commit 使用本地 snapshot identity | 未发布；本地候选，source commit 使用本地 candidate identity |

具体安装包位置、build ID、asar/resource 摘要见 [R-02 manifest](./session-storage-r02-macos-package-manifest-2026-10-06.json) 和 [SC-00 manifest](./session-storage-c00-macos-package-manifest-2026-10-06.json)。

## 已有兼容证据

- R-02 macOS arm64 与 x64 候选已完成包级 canonical-only reader、schema upgrade、backup/restore、History/spill 故障隔离、reopen 等矩阵；包 hash 和范围见 R-02 manifest。
- SC-00 的 arm64/x64 C-off 候选由 clean source tree 经正常 afterPack 构建；两个包均打入 `allowContentCleanup=false` 和 null compatibility record；DMG 校验通过。
- SC-01A 在独立 file-backed 合成 profile 生成三种代表状态。R-02 arm64 候选和 SC-00 C-off arm64 候选经实际 renderer→preload→IPC 各读取三种状态的 canonical 正文，六次均与 oracle 相同。write-stopped、pending、complete 的旧正文写入均被拒绝；状态、游标与正文未因 C-off 启动而变化；三个 DB 均 `integrity_check=ok`、`foreign_key_check` 为空。证据与 profile hash 见 [SC-01A manifest](./session-storage-c01a-candidate-smoke-manifest-2026-10-06.json)。
- 评审发现 SC-01A 原矩阵没有 R-02 x64 三种状态的直接读取证据，故补测实际 R-02 x64 包（在 Rosetta 下运行）对三份独立 profile 的 renderer→preload→IPC 读取。write-stopped、pending、complete 各返回两条消息，ID/正文均与该 profile 的 `invocation-context-committed` History oracle 完全一致；cleanup state/write mode/cursor/count/scan 标志、消息骨架及 legacy 正文未变；每库 `integrity_check=ok`、外键违规 0。源 fixture 的三份 DB hash 前后与 SC-01A manifest 完全一致。细节、包 hash 与启动后隔离副本摘要见 [x64 补充 smoke manifest](./session-storage-c01b-x64-state-smoke-manifest-2026-10-06.json)。

本评审没有证明精确 R-02 schema-v52 候选对健康 source-truth spill 的完整正文读取成功；R-02 已有 spill 缺失 fail-closed 和较早同格式 R 候选的健康 multi-spill 读取证据，但不能代替当前精确包上的成功读取。本次仍可放行仅用于发现/验证该兼容性的隔离候选演练；因此 SC-01C 必须在 arm64 与 x64 实际 C-on/R 包矩阵中覆盖 spill-backed canonical 正文成功读取，以及缺失/篡改 spill 的 fail-closed。SC-01C 还须实际经 gate-enabled packaged C worker 产生三种状态，R 对 pending/complete 回滚读取并确认不继续清理，记录 reopen 与完整性。SC-SCOPE-PKG 最终授权差异和 SC-02 独立证据审阅仍按后续步骤验收。本决定不声称正式发布或生产授权。

## 评审决定

结论：**accepted**。评审者/角色：**Codex，依用户明确授权执行兼容性评审**。日期：2026-10-06。

理由：

1. R-02 精确包 identity 与 R-02 manifest 一致；本机重新计算 R arm64/x64 和 SC-00 C-off arm64/x64 四个归档 DMG 的 SHA-256，均与 manifest 相等。两个 R 包绑定 schema 52、History/spill/projection-cache 格式 1/1/1。
2. R-02 arm64 的三态 renderer IPC 证据与新增 x64（Rosetta）三态 smoke 均从实际 packaged renderer 的 `window.api.chatGetMessagePage` 经 preload/IPC 读取。readback 与 canonical History oracle 逐条相等；三个状态均未推进清理状态、游标或旧正文，完整性和 FK 检查通过。
3. 代码核对确认 canonical-backed-only 且 `write_mode=canonical` 的 transcript reader 从 canonical History 重建/读取正文，并验证 canonical source spill；不能把已清空的 `messages.content` 当作回滚来源。数据库写围栏阻止 `write-stopped`、`pending`、`complete` 状态下重新写 legacy 正文。
4. `evaluateSessionStorageCleanupReleaseGate` 要求记录精确匹配当前 C version/commit/schema/History/spill、R 支持 schema 上限与格式及三个 cleanup states，并按目标架构核对 R artifact SHA。afterPack 另核对干净固定 C source commit、Accepted 决议、记录 digest 和每目标 R artifact。缺失/不匹配均 fail closed。

**批准的唯一用途**：为 SC-01C 构建并验证固定候选身份 `C 0.2.4 / commit 3bd50b224c5abf95821525e57985fad0c11051c0` 对应的 macOS arm64/x64 gate-enabled C-on disposable-profile 技术包。记录摘要为 `d8c11fc170dfac4b5c43b2ed58f49f1873f802427d5db67848dc8aaf4aed3803`，记录副本见 [accepted compatibility record](./session-storage-c01b-compatibility-record-2026-10-06.json)。`rollback.artifacts` 中的 `file:///Users/space/...` 是本机归档 R 候选定位符，afterPack/runtime 只核对非空定位符与 SHA，不代表公开下载地址或正式 release。

**明确排除**：对外发布、production rollback floor、真实 profile census/补迁、真实会话停写/清列、C-on 部署授权。SC-01C 的 source spill 成功路径及损坏故障矩阵仍未完成，必须在该步骤实测；compatibility record 改变 C/R identity 或格式时必须更新/重签。SC-SCOPE-PKG 后若 C source identity 改变，须重新固定身份并按影响重审/重签。SC-02 完成前不得部署真实清理。
