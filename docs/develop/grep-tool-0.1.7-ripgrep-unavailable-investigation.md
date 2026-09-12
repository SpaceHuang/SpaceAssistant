# 0.1.7 grep 降级：内置 ripgrep 不可用调查

> 调查日期：2026-09-11
> 关联记录：`docs/analyze/grep-tool-1mib-file-limit-diagnosis.md`
> 结论等级：运行时分支为确定事实；实际 `spawn` errno 因历史观测缺失无法唯一还原；开发态 staging 缺失为高置信推断。

## 1. 结论

0.1.7 记录里的 `degraded: true` 不是系统 PATH 没有 `rg` 所致。该版本已使用内置二进制，且 0.1.7 arm64 产物经实物核验完整可用。

当时实际走了 JavaScript fallback，意味着在 `grepWithRg()` 启动内置二进制时收到了子进程 `error` 事件。当前实现把除 `EACCES` 以外的所有错误都归类为 `missing`，并未持久化 errno、运行时资源存在性或启动前路径状态。因此，历史事件记录只能证明“内置 rg 当时未能启动”，**不能据此唯一证明**是文件不存在、资源路径错误、文件描述符耗尽或其他系统错误。

综合证据，最可能原因是：**开发态应用从一个 git worktree 启动，而该 worktree 未执行 `npm run prepare:rg`。** `resources/ripgrep/*` 被 `.gitignore` 排除，不会随 `git worktree add` 带入；开发态解析器仍无条件指向该 worktree 的 staging 路径，随后 `spawn()` 返回 `ENOENT`，最终静默切到 1 MiB 上限的 JS fallback。

这解释了该会话的 45 次 grep 调用全部带 `degraded: true`：这是会话期间稳定的运行时资源状态，而非偶发的单次检索故障。

## 2. 已核实的证据

### 2.1 0.1.7 确实已内置 rg

提交顺序：

1. `d788071 feat(tools): bundle ripgrep with observable fallback`：2026-09-04 23:50；
2. `3b596ed chore(release): bump version to 0.1.7`：2026-09-04 23:59。

打包逻辑由 `scripts/after-pack.cjs` 在 macOS 将目标架构文件复制到：

```text
SpaceAssistant.app/Contents/Resources/bin/rg
```

对本地 `release/SpaceAssistant-0.1.7-arm64.dmg` 挂载后实测：

- 文件存在，模式为可执行；
- 类型为 `Mach-O 64-bit executable arm64`；
- SHA-256 为 `0e0cb83f…e3e7102f8`，与 manifest 一致；
- 直接运行返回 `ripgrep 14.1.1`。

当前安装的 `/Applications/SpaceAssistant.app` 同为 0.1.7，拥有相同二进制、相同哈希，`rg --version` 可运行，且 `codesign --deep --strict` 验证通过。故“0.1.7 发行包漏复制/签名破坏 rg”可排除。

### 2.2 会话确定使用了 fallback

目标事件流 `sessions/95bb3ac4-…/events.jsonl` 中共 45 个 `grep` 结果，45 个均为：

```json
{ "success": true, "data": { "output": "…", "degraded": true } }
```

其中既有正常小文件命中，也有对大 `events.jsonl` 的假阴性。因此 `degraded` 是整个会话的固定执行分支，而非“无匹配”的附加语义。

### 2.3 代码对 arm64 不会直接判定“不支持”

`electron/tools/ripgrepBinary.ts` 的支持矩阵包含 `darwin-arm64`。在打包态，解析结果必为：

```ts
path.resolve(process.resourcesPath, 'bin', 'rg')
```

所以，对 arm64 的 0.1.7 来说，`degraded: true` 不可能来自 `resolveRipgrepBinary()` 的 `unsupported` 分支；必须来自 `grepWithRg()` 中二进制启动失败后的 fallback 分支。

### 2.4 实际错误被错误分类，无法事后取证

当前代码为：

```ts
proc.on('error', (err) => {
  const errorCode = (err as NodeJS.ErrnoException).code
  finish({ kind: 'unavailable', reason: errorCode === 'EACCES' ? 'permission' : 'missing' })
})
```

这会把 `ENOENT` 之外的 `EMFILE`、`ENFILE`、`EIO`、`ETXTBSY` 等全部写成 `missing`。随后 executor 只记录非敏感的 `reason=missing`；会话事件流本身不包含这项诊断，而保存该诊断的当日 agent log 不可得。历史记录因此没有可用 errno 证据。

## 3. 高置信根因：开发态 worktree 的忽略 staging

`resources/ripgrep/*` 被显式忽略：

```gitignore
resources/ripgrep/*
!resources/ripgrep/.gitkeep
```

开发态解析器则将二进制固定解析到当前编译模块所属仓库根：

```ts
path.resolve(developmentRoot, 'resources', 'ripgrep', `${platform}-${arch}`, 'rg')
```

因此新建 worktree 后，以下事实同时成立：

```text
worktree 有源码和 ripgrep 解析代码
worktree 没有被 git 追踪的 rg staging 文件
开发态仍向该不存在的绝对路径 spawn
spawn 触发 ENOENT（高概率）
grep 切换到 JS fallback，并返回 degraded:true
```

目标会话大量检索名为 `SpaceAssistant-session-record-eventflow-refactor` 的 worktree；结合全部调用稳定降级，这与“从该类隔离 worktree 进行开发态运行，但未准备本地 staging”的现象高度一致。

注意：会话记录没有存储应用进程的 `app.isPackaged`、`process.resourcesPath`、实际 binary path 或 errno，故不能把上述推断提升为已观测到的唯一事实。

## 4. 次要可能性与排除情况

| 情况 | 结论 |
|---|---|
| 系统 PATH 无 `rg` | 无关。0.1.7 应使用绝对内置路径，不查询 PATH。|
| macOS arm64 不受支持 | 排除。支持矩阵明确包含 `darwin-arm64`。|
| 0.1.7 DMG 未包含 rg | 排除。DMG 和已安装 0.1.7 均已实测存在、哈希正确、可执行。|
| 签名/隔离导致无法执行 | 当前安装包实测签名通过且 `rg --version` 成功；无法证明历史运行中未发生过该错误，但不支持作为主因。|
| 短暂的 `EMFILE`/系统资源错误 | 理论上可能；因错误分类丢失无法排除。但 45/45 的稳定降级更符合固定资源缺失，而非偶发资源耗尽。|

## 5. 修复与防回归方案

### A. 开发态启动前置检查（最高优先级）

在 `npm run dev:electron` 之前执行 host target 的资源准备和验证，或在主进程启动时进行一次明确的能力检查：

1. 根据 `process.platform-process.arch` 定位 staging；
2. `stat` 检查文件存在、为普通文件且 macOS 有执行位；
3. 校验 SHA-256 与 `scripts/ripgrep-manifest.json`；
4. 同宿主执行一次 `rg --version` 并检查版本；
5. 失败时显示明确的开发配置错误：`内置 ripgrep 未准备；请执行 npm run prepare:rg -- --target=<target>`。

不要让开发态自动静默降级。自动下载会引入网络、供应链和启动延迟问题；应复用既有、受校验的 `prepare:rg` 显式流程。

### B. 保存正确且不敏感的启动失败诊断

扩展 `RipgrepRunResult`，区分至少：

```ts
type RipgrepUnavailableReason =
  | 'not_found'
  | 'permission_denied'
  | 'exec_format'
  | 'resource_exhausted'
  | 'spawn_failed'
```

记录受限诊断字段：`source`、`platform`、`arch`、`appMode`、`exists`、`isFile`、`executable`、`errnoCode`、`errno` 分类。不得记录搜索 pattern、工作目录、命中文本或绝对二进制路径。

这样下次可直接区分：

- staging/包内资源不存在；
- 权限或签名/架构启动问题；
- 系统资源耗尽；
- 未知启动错误。

### C. 发布态采取严格失败而非换引擎

发行包中的内置 rg 不可用属于安装完整性故障。发布态应返回结构化错误和修复指引，而非改用语义不等价、且会静默跳过 1 MiB 文件的 JS fallback。若必须保留 fallback 以保证可用性，至少必须返回：

```text
degraded=true
partial=true
reason=<分类>
结果不完整，不能用于证明不存在匹配
```

### D. 大文件 fallback 仍需独立修复

即便解决内置 rg 不可用问题，JS fallback 在异常环境仍可能被调用。`docs/develop/grep-tool-large-file-fallback-optimization-plan.md` 中的流式搜索与 `partial/skippedFiles` 契约应继续实施，以消除假阴性。

## 6. 必要测试

1. 在空的临时开发 worktree（没有 `resources/ripgrep/<host>/rg`）启动前置检查，断言得到明确的准备指引，且 grep 不返回普通 `No matches found`。
2. 以注入的 `spawn` 模拟 `ENOENT`、`EACCES`、`EMFILE`、`ENOEXEC`，断言分类不同且诊断不泄露路径/pattern。
3. 打包态：`rg` 存在且 `--version` 成功时，验证绝不调用 fallback。
4. 打包态：模拟二进制启动失败，验证返回安装完整性错误（或至少 `partial=true`），绝不返回看似完整的无匹配。
5. 保留 1 MiB 与 1 MiB+1 的 fallback 回归测试，确保不可用分支不会再造成假阴性。
