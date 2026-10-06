# SC-SCOPE-PKG 候选用途兼容性评审

状态：**Accepted（仅限最终 C-on 候选上的 synthetic disposable-profile scope 差异验收）**。本 addendum 扩展 SC-01B 已接受的 R/C 数据兼容关系，绑定 SC-SCOPE-PKG 的独立测试用途；不覆盖正式发布、生产 rollback floor 或真实数据操作。

## 评审对象

- C 候选：`0.2.4 / 3bd50b224c5abf95821525e57985fad0c11051c0 / tree 9c766b629ffafe8cf29a51c46ef1faecfea07b4f`。
- R 候选：`0.2.4 / 837a9c713d6f9c463749e63956f19db35de2cdf3`，arm64 DMG SHA-256 `0fdc0bf2152cf677b9abb8d966d11f4838b677cee16bc84d2c2831f53652ef46`，x64 DMG SHA-256 `8bfb24cf056a6dd1d41e4d28e250978812d93d1d40dc37cf1632cc0bf11cdfbc`。
- 原 SC-01B Accepted record 已证明 R canonical-only reader 支持 schema 52、History/spill format 1 和 write-stopped/pending/complete；SC-01C 在同一 C identity 上补齐 clean C-on arm64/x64 包及状态、健康 spill 和读取故障矩阵。
- scoped authorization implementation 和 tests 共 6 个文件逐字节等同于固定 C commit；main process cleanup boundary 注册段与固定 commit 相同。因此本次不引入源码差异或重新开发已有能力；最终 C-on 会因本评审用途摘要变化而重新 afterPack、重固定 artifact/resource hashes。
- 用途扩展后的 Accepted compatibility record 为 [SC-SCOPE-PKG record](./session-storage-cscope-package-compatibility-record-2026-10-06.json)，摘要 `80792d0762c1c6b9889d49f298520eaf41e66607e075dff0e35d3fb4e43e21a5`；该摘要必须写入 deployment input 并由 afterPack/runtime 两侧重新验证。

## 决定及边界

结论：**Accepted**。评审者/角色：Codex，在用户明确授权下执行。评审时间：2026-10-06 10:18（Asia/Shanghai）。

批准的唯一用途：基于新 Accepted record 与新 digest，构建并验证上述固定 C source identity 的 macOS arm64/x64 final C-on synthetic disposable-profile 候选。可覆盖获批 A、未获批 B、新增合格 C、错误 profile identity、授权过期/撤销、进程重启、pending 暂停/重新授权续跑，以及 packaged worker 与打包源码所含直接 production boundary 的隔离差异测试。

硬边界：所有 profile、session、审批引用和 spill 均为 synthetic；没有真实 profile census、真实 session 停写/清正文、对外发布、部署或正式 rollback floor。record 的 Accepted 仅供技术验收；不论 gate-enabled 候选上的隔离矩阵结果如何，都不授权真实数据清理。C-on 正式部署仍须 SC-02 独立终审、SC-03 dataset owner 对具体真实 cohort 的授权及 RC-02 正式部署流程。

## 评审依据

1. SC-01C 两架构 worker 与 R readback/故障矩阵已绑定精确 C/R package hashes，完整结果见 [SC-01C package matrix manifest](./session-storage-c01c-package-matrix-2026-10-06.json)。
2. 固定 C candidate 已包含完整 SC-SCOPE source/TDD 实现；SC-SCOPE-PKG 只需验证最终打包身份上的边界，不需复制实现或改变产品入口。
3. R artifacts 已重新校验 hash 且支持当前 schema/format/states；新 compatibility record digest 会强制新 afterPack 将用途边界和 R artifact pins 一并固定入 final C-on bundle。

最终 record 路径、摘要与 artifact/resource hashes 记于技术方案 SC-SCOPE-PKG manifest。若 C source identity、数据格式、gate/授权逻辑或执行路径改变，本决定自动失效，须重审并重建最终 C-on。若仅测试记录变化，按差异更新证据；不得外推正式发布或真实清理权限。
