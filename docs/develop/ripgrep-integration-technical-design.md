# ripgrep（rg）内置集成技术方案

制定日期：2026-09-04；修订日期：2026-09-04（评审整改版）  
状态：本地必做项已完成；外部环境验收项待发布前执行且不阻塞本轮提交

## 0. 执行计划与环境边界

本计划采用 TDD 推进。每个本地任务先补充失败测试（RED），再实现代码（GREEN），最后运行聚焦测试、类型检查和构建门禁。GitHub Actions、Windows 原生运行和真实 macOS 发布验收属于后置验证，不作为本 worktree 完成本地实现或提交的前置条件。

### 0.1 当前环境可完成的任务

以下任务属于本 worktree 的交付范围，必须在本地完成并留下可复现的测试或静态验证证据：

- [x] 固定 ripgrep 版本、官方 release URL、归档 SHA-256、二进制 SHA-256 和三平台 manifest。
- [x] 实现下载、重定向白名单、响应体大小限制、归档路径穿越/链接/数量/大小校验、哈希校验和原子 staging。
- [x] 实现 Mach-O/PE 静态格式与 CPU 架构校验；准备并校验当前支持矩阵的 staging 文件。
- [x] 实现开发态/打包态绝对路径解析，禁止裸调用 `rg` 和 `PATH` 搜索。
- [x] 以随包 rg 为首选执行引擎；rg 缺失、权限或加载失败时保留 `grepFallbackJs` 可观测降级，返回可用结果并标记 `degraded`、记录原因。
- [x] 补齐 spawn `error`/`close` 一次性结算、ENOENT/EACCES/加载失败分类及部分输出边界的 TDD 覆盖。
- [x] 补齐诊断回调的实际调用测试，确认只记录 source、平台、架构、版本、错误类别和退出码等非敏感字段。
- [x] 同步 Agent 的 `grep` description、schema 与 executor，禁止部署信息和旧 fallback 语义残留。
- [x] 实现 `afterPack` 复制资源、复制后校验、许可证复制和签名前资源落位，并以 fixture 覆盖 x64/arm64 目标选择。
- [x] 实现 unpacked/package 目录验证器，覆盖资源存在、哈希、架构、许可证、asar 排除和同宿主 `--version` 门禁。
- [x] 完成 npm scripts、`pack`/平台 pack 脚本和 release workflow 的静态审计，确保每个受支持 target 在打包前显式准备、打包后显式验证。
- [x] 运行本地提交门禁：ripgrep 专项 Vitest、相关共享类型测试、Electron/renderer/shared 类型检查、`npm run build`、i18n 检查和 `git diff --check`；记录环境限制导致的非相关全量测试失败。

### 0.2 当前环境无法完成、但不阻塞本轮提交的任务

以下项目需要对应操作系统、发布凭据或云端基础设施。本轮只保留自动化配置和本地可测的 verifier，不等待这些条件满足：

- [外部环境] GitHub Actions 云端 CI 的真实执行、runner matrix、缓存和 release artifact 上传验证。
- [外部环境] Windows x64 原生运行验证，包括 Finder 等价的用户启动场景、NSIS 安装后路径、进程终止/取消、权限错误和 Defender/SmartScreen 影响。
- [外部环境] Intel macOS Finder/Dock 启动、Apple Silicon 原生启动及两种架构下的真实 `rg --version` 执行。
- [外部环境] macOS DMG 的真实签名封装、Developer ID、notarization、Gatekeeper 和安装后完整性验证。
- [外部环境] 干净 Windows/macOS 虚拟机或实体机上的 A1-A8、A10-A12 端到端验收；本地 fixture 和静态检查不能替代这些证据。

这些条目应在具备相应 runner、系统或签名凭据后作为发布前验收执行，并回填 A1-A12 证据；它们不是本 worktree 代码合并的阻塞项。

### 0.3 本地提交门禁与后置验收关系

本轮完成条件是：所有“当前环境可完成”条目完成；本地测试、类型检查、构建和 verifier 通过；外部环境条目明确标注为待后置验收。不得因为无法在当前 macOS 环境模拟 Windows 原生行为、Intel Finder 或 GitHub 云端 runner 而无限期阻塞实现提交。

## 1. 背景与结论

当前 `grep` 内置工具先执行 `spawn('rg', ...)`，仅通过应用进程的 `PATH` 查找 ripgrep；项目依赖、`electron-builder.files`、`extraResources`、`asarUnpack` 和 `afterPack` 均未携带或复制 rg。目标系统未安装 rg，或从 Finder/Dock 启动的 macOS 应用无法继承 Homebrew 路径时，会进入 `grepFallbackJs`。

这意味着现在的 JS fallback 实际上是干净系统上的常规执行路径。它与 ripgrep 在正则语义、`.gitignore`、隐藏文件、二进制判断、目录遍历和性能方面不完全等价，并且用户是否得到 rg 行为取决于机器环境，安装包不可复现。

本方案决定：

1. Windows x64、macOS x64、macOS arm64 安装包必须携带与目标架构一致的官方 ripgrep 二进制。
2. 正式包只通过绝对路径调用随包 rg，不读取用户 `PATH`，从而消除环境漂移和同名程序劫持。
3. bundled rg 集成后以随包 `rg` 为首选；二进制缺失、无执行权限、架构/加载失败均记录非敏感诊断并标记降级原因，同时保留受资源限制的 `grepFallbackJs` 让用户继续完成搜索。降级不得静默，发布验证仍必须将 bundled rg 缺失视为完整性错误。
4. 不把 rg 放入 `app.asar`。可执行文件放在 `process.resourcesPath/bin/`，由 `afterPack` 在每个目标产物中按平台和架构复制。
5. 固定 ripgrep 精确版本、官方来源、许可证，并为每个平台同时固定归档 SHA-256 与解压后二进制 SHA-256；禁止构建时解析“latest”或使用未经校验的第三方镜像。
6. 本次同步优化 Agent 可见的 `grep` description 和 input schema：只描述 Agent 此刻可依赖的能力、输入、输出与限制，移除跨平台、打包方式和系统依赖等部署信息；文案、schema 与 executor 必须同批合并，不能分期留下错误契约。

## 2. 目标与非目标

### 2.1 目标

- Windows x64 安装后存在并可执行 `resources/bin/rg.exe`。
- macOS x64 与 arm64 的 `.app` 分别存在正确架构、可执行并纳入应用签名的 `Contents/Resources/bin/rg`。
- 开发、测试、打包和正式运行使用同一个路径解析模块，路径选择可单测。
- CI 对“二进制存在、哈希正确、架构正确、可运行、确实被 grep 工具调用”形成闭环。
- 下载和升级过程可审计、可复现，不执行上游安装脚本。
- Agent 收到的工具 description 简洁、可操作，并与唯一的 rg 执行引擎契约一致。

### 2.2 非目标

- 本期不增加 Linux 发布支持。可在 manifest 结构中预留 Linux，但未进入产品支持面前不得宣称已集成。
- 不引入第二套正则解析器、Rust-regex 兼容层或“rg/JavaScript 共同语法子集”；本次直接收敛为单一 rg 引擎。
- 不允许用户配置任意 rg 路径；这会扩大可执行文件信任边界。
- 不让 `run_shell`、终端或其他业务命令自动使用随包 rg；本期只服务受控的内置 `grep` 工具。

## 3. 已确认的现状

| 环节 | 当前行为 | 问题 |
| --- | --- | --- |
| 运行时 | `electron/tools/builtinExecutors.ts` 调用 `spawn('rg', args)` | 依赖 `PATH`，无法证明执行的是产品审核过的二进制 |
| fallback | spawn `error` 或退出码不是 0/1 时返回 `null`，随后执行 `grepFallbackJs` | 二进制缺失与用户正则/参数错误混在一起，可能静默改变正则引擎；本次须移除此生产分支 |
| npm 依赖 | 没有 ripgrep 二进制依赖 | npm 安装不能提供 rg |
| 打包资源 | `files`/`extraResources` 只有业务产物、SQLite、托盘和图标 | 安装包没有 rg/rg.exe |
| Windows afterPack | 只修补 exe 图标 | 没有复制或验证 rg.exe |
| macOS afterPack | 只对 `.app` 做 ad-hoc 签名和验证 | 没有复制 rg；若未来复制发生在签名后会破坏签名完整性 |
| 自动测试 | 覆盖“rg 失败 → JS fallback”和部分 rg 行为 | 没有验证正式包携带二进制，也没有验证目标架构 |

## 4. 方案选型

### 4.1 候选方案

| 方案 | 优点 | 缺点 | 决策 |
| --- | --- | --- | --- |
| 继续依赖系统 `PATH` | 无包体增加 | 干净系统不可用、GUI PATH 不稳定、存在同名程序劫持 | 拒绝 |
| 使用携带二进制的 npm 包 | 接入代码可能较少 | 包的维护、平台覆盖、install script、二次下载和供应链边界取决于第三方包 | 不作为首选 |
| 将解压后的二进制直接提交 Git | 离线打包简单 | 仓库膨胀，二进制 review/升级体验差；多架构长期累积 | 暂不采用 |
| 固定官方 release 压缩包，按 manifest 下载并校验 | 来源清楚、版本和哈希可审计、仓库不存大二进制 | 首次准备需要网络，需维护下载/缓存脚本 | 采用 |

采用方案与仓库现有 native binding manifest 思路一致，但 rg 准备脚本必须更严格：只下载官方固定 URL、先校验压缩包 SHA-256、在临时目录解压、校验内部唯一目标文件，再原子替换本地缓存；不执行归档中的脚本。

### 4.2 支持矩阵

首期支持矩阵与当前发布配置保持一致：

| Electron 平台 | Electron 架构 | 上游目标归档 | 产物文件 |
| --- | --- | --- | --- |
| `win32` | `x64` | Windows GNU/MSVC 目标中经验证可在支持系统运行的一种，实施时固定 | `rg.exe` |
| `darwin` | `x64` | Apple Darwin x86_64 | `rg` |
| `darwin` | `arm64` | Apple Darwin aarch64/arm64 | `rg` |

实施者必须以选定 ripgrep 版本的官方 release 资产实际名称填写 manifest，不能根据本表猜测文件名。Windows 目标格式选择后要锁死，升级不得在 GNU/MSVC 目标间无记录切换。

## 5. 文件布局与职责

建议新增：

```text
scripts/
  ripgrep-manifest.json          # 版本、官方 URL、归档/二进制 SHA-256、归档内路径、许可证信息
  prepare-ripgrep.mjs            # 下载/校验/解压到本地 staging
  verify-ripgrep-package.mjs     # 验证已打包 app 目录或安装前 unpacked 目录
resources/
  ripgrep/                       # gitignore 的本地 staging，不提交二进制
    darwin-x64/rg
    darwin-arm64/rg
    win32-x64/rg.exe
electron/tools/
  ripgrepBinary.ts               # 受信路径解析、能力探测和错误分类
```

`resources/ripgrep` 应加入 `.gitignore`，但目录说明文件可提交。CI 和本地打包必须先运行 `prepare-ripgrep.mjs`，不能因为缓存已存在就跳过哈希验证。

### 5.1 manifest 契约

示意结构如下，具体版本、URL 和哈希在实施 PR 中从官方 release 固定并复核：

```json
{
  "version": "<exact-version>",
  "license": "MIT OR Unlicense",
  "source": "<official-release-page>",
  "targets": {
    "darwin-x64": {
      "url": "<official-asset-url>",
      "archiveSha256": "<64-lowercase-hex>",
      "binarySha256": "<64-lowercase-hex>",
      "archiveType": "tar.gz",
      "binaryPath": "<archive-relative-path>/rg"
    },
    "darwin-arm64": {
      "url": "<official-asset-url>",
      "archiveSha256": "<64-lowercase-hex>",
      "binarySha256": "<64-lowercase-hex>",
      "archiveType": "tar.gz",
      "binaryPath": "<archive-relative-path>/rg"
    },
    "win32-x64": {
      "url": "<official-asset-url>",
      "archiveSha256": "<64-lowercase-hex>",
      "binarySha256": "<64-lowercase-hex>",
      "archiveType": "zip",
      "binaryPath": "<archive-relative-path>/rg.exe"
    }
  }
}
```

manifest 校验至少包括：只允许 HTTPS、host 必须是批准的官方 GitHub release host、版本不能为 `latest`、`archiveSha256`/`binarySha256` 均为 64 位小写十六进制、归档内路径不能是绝对路径或包含 `..`。两个摘要承担不同职责，禁止混用：前者验证下载资产，后者验证解压后、staging、复制后及最终安装资源中的可执行文件。

## 6. 二进制准备流程

`scripts/prepare-ripgrep.mjs` 接受显式目标列表，例如 `--target darwin-x64`，也支持 `--all-supported`。流程如下：

1. 读取并严格校验 manifest；未知平台/架构立即失败。
2. 若 staging 已有文件，计算 SHA-256 并与 `binarySha256` 比较；不匹配时删除该单个 staging 文件并从已校验归档重建，不得仅以“文件存在”或 `--version` 输出判定成功。
3. 下载到系统临时目录，限制重定向次数和响应体大小；失败不得留下看似完整的目标文件。
4. 对压缩包计算 SHA-256，必须与 `archiveSha256` 完全一致。
5. 在新的临时目录解压。拒绝路径穿越、符号链接/硬链接和超出大小/文件数上限的异常归档。
6. 只提取 manifest 指定的 `rg`/`rg.exe` 与需要随包分发的许可证文本；立即计算可执行文件 SHA-256，并与 `binarySha256` 完全一致后才可继续。许可证必须每次从已通过 `archiveSha256` 的归档重建，或在 manifest 中另设摘要，不允许复用来源不明的旧 staging。
7. macOS 文件设置为 `0755`；Windows 保持普通文件属性。权限变更不改变文件内容，之后再次核对 `binarySha256`。同宿主架构的目标执行 `<binary> --version` 并核对版本；交叉架构目标做静态文件格式、CPU 架构和内嵌版本信息校验，不能把 Rosetta 是否安装变成准备阶段的隐式前提。
8. 将验证后的文件原子移动到 `resources/ripgrep/<target>/`。

为了避免依赖宿主系统的 `tar`、PowerShell 或 `unzip` 差异，优先使用项目锁定的 Node 解压库，并禁止其生命周期脚本；若选择系统工具，必须在 Windows 和 macOS CI 中分别验证，并使用参数数组调用而不是拼 shell 字符串。

### 6.1 npm scripts

建议增加：

```json
{
  "prepare:rg": "node scripts/prepare-ripgrep.mjs --host",
  "prepare:rg:all": "node scripts/prepare-ripgrep.mjs --all-supported",
  "verify:rg:package": "node scripts/verify-ripgrep-package.mjs"
}
```

不建议放入 `postinstall`：普通开发和只跑 renderer 测试不应被强制联网。应在 `pack`、`pack:win`、`pack:mac` 以及 release workflow 的打包前显式执行。macOS 一次构建 x64 与 arm64 两种 DMG，所以 `pack:mac` 必须准备两个 Darwin 目标，而不是只准备 runner 自身架构。

## 7. electron-builder 与 afterPack 集成

### 7.1 为什么由 afterPack 复制

`package.json` 的 macOS target 在同一次构建中产出 x64 和 arm64。由 `afterPack(context)` 使用 `context.electronPlatformName` 和 `context.arch` 选择源文件，目标明确，不依赖 file macro 是否在不同 electron-builder 版本中按预期展开。

`context.arch` 是 electron-builder/builder-util 的 `Arch` 枚举值，不是可直接拼接到 manifest key 的字符串。实现 `resolveRipgrepTarget(platform, arch)` 时必须显式将 `Arch.x64 → x64`、`Arch.arm64 → arm64` 映射，其他枚举立即失败。若脚本直接导入 `builder-util.Arch`，应将其作为与 electron-builder 兼容的显式 devDependency 锁定，不能依赖未声明的传递依赖；另一选择是在仓库内定义受测试的窄适配器，并由 afterPack 测试用真实枚举值覆盖。

统一流程：

```text
resolve target key
  → 校验 staging 文件存在、SHA-256 等于 binarySha256、目标架构正确
  → 复制到 appOutDir 的 resources/bin
  → 再次校验复制后文件的 binarySha256
  → 设置权限；同宿主架构执行 rg --version，交叉架构做静态校验
  → Windows 修补图标 / macOS 签名
  → 最终签名验证
```

目标路径：

- Windows：`<appOutDir>/resources/bin/rg.exe`
- macOS：`<appOutDir>/SpaceAssistant.app/Contents/Resources/bin/rg`

macOS 必须先复制和 `chmod 0755`，再执行当前 `codesign --deep`。不能在签名后修改、替换或 chmod rg。若未来切换 Developer ID 签名/公证，仍需保持“资源落位在签名前”，并验证 rg 被签名封装覆盖；公证后的安装包不得再次修改。

Windows 当前不做代码签名。未来开启签名时，rg.exe 属于随包第三方可执行文件：须确认签名策略是否要求单独签名；至少要保证最终 resources 中的文件 SHA-256 等于 manifest 的 `binarySha256`。安装器自身的发布摘要另行记录，不能与 rg 的二进制摘要混为一谈。

### 7.2 打包失败原则

受支持 target 缺少 staging、`binarySha256`/版本不符或架构错误时，`afterPack` 必须抛错中止打包；同宿主架构目标无法执行也必须中止。交叉架构目标不得因宿主未安装 Rosetta 而直接执行失败，应以静态 Mach-O/PE 架构校验为门禁，并由对应原生架构 runner 或发布前真机验收补齐执行证据。不能生成依赖用户侧容错的安装包。

## 8. 运行时解析与执行契约

### 8.1 路径解析

在 `electron/tools/ripgrepBinary.ts` 集中实现：

```ts
type RipgrepBinarySource = 'bundled' | 'development' | 'unavailable'

interface ResolvedRipgrepBinary {
  path: string | null
  source: RipgrepBinarySource
  platform: NodeJS.Platform
  arch: string
}
```

解析规则：

1. `app.isPackaged === true`：只返回 `path.join(process.resourcesPath, 'bin', platform === 'win32' ? 'rg.exe' : 'rg')`。
2. 开发环境：返回仓库 `resources/ripgrep/<platform>-<arch>/` 的对应文件；若开发者未准备，返回带 `npm run prepare:rg` 修复提示的 `unavailable` 错误，不搜索 `PATH`，也不进入另一搜索引擎。
3. 正式包禁止再次尝试裸命令 `rg` 或搜索 `PATH`。这既保证行为可复现，也避免工作目录或用户 PATH 中的恶意同名程序被执行。

仓库根目录不能根据 `process.cwd()` 推导，因为开发启动目录可能变化；应相对于编译后模块位置使用经测试的稳定路径，或由主进程启动时注入明确的 app path。

### 8.2 执行与错误分类

将 `grepWithRg` 改为接收已解析的绝对二进制路径。返回值不再只用 `string | null` 表达全部状态，建议使用判别联合：

```ts
type RipgrepRunResult =
  | { kind: 'success'; output: string }
  | { kind: 'no_match'; output: 'No matches found' }
  | { kind: 'unavailable'; reason: 'missing' | 'permission' | 'load_failed' }
  | { kind: 'invalid_request'; message: string }
  | { kind: 'timeout'; partialOutput: string }
  | { kind: 'cancelled'; partialOutput: string }
  | { kind: 'failed'; exitCode: number | null; message: string }
```

行为规则：

- exit code `0`：成功；`1`：无匹配。
- spawn `ENOENT`、`EACCES`，或系统明确报告二进制无法加载：记为 `unavailable`，返回明确的安装完整性/开发准备错误并记录诊断，不执行搜索 fallback。
- rg 参数/正则错误通常表现为非 0/1 退出码：保留受长度限制的 stderr，转换为明确工具错误返回，不使用其他正则引擎重试。
- 超时和用户取消保持现有部分输出行为，不启动第二次搜索。
- 未知崩溃默认返回稳定错误并记录诊断，不做引擎切换。
- `error` 与 `close` 事件需要一次性完成保护，避免多事件导致重复结算；终止时按现有跨平台进程树策略复核 Windows 子进程退出。

### 8.3 可观测性

首次调用或诊断页可记录非敏感字段：

- `source=bundled|development|unavailable`
- `platform`、`arch`、预期 rg 版本
- 错误类别和退出码
- 是否为 bundled 二进制不可用或完整性异常

不得记录完整搜索 pattern、工作目录、命中文本或用户文件名。正式包出现 `source != bundled` 应视为发布/安装异常，而不是正常信息。

### 8.4 Agent 工具契约审查与修订

`grep` 是面向 Agent 的受控搜索 API，不需要把 rg 的全部 CLI 参数原样暴露；稳定、低歧义的领域参数比让 Agent 拼命令行更合适。但当前工具说明和实现存在以下偏差，集成 bundled rg 时应一并修订：

本节不是后续优化建议，而是本次 rg 集成的必做范围。原因是 bundled rg 会把原来不稳定的实现选择固化为产品主路径，如果仍向 Agent 提供旧 description，就会同时固化“实现已经改变、契约说明仍不准确”的问题。

#### 8.4.1 Agent 可见信息的取舍原则

Agent description 只回答四类问题：

1. 什么时候使用这个工具；
2. 可以搜索什么范围、默认忽略什么；
3. pattern、过滤、输出和限制参数怎样工作；
4. 返回结果有哪些重要限制或非确定性。

以下内容不进入 Agent 可见 description，保留在本技术方案、发布文档或诊断信息中：

- “跨平台”；
- “内置实现”；
- 是否依赖系统 `grep`、`findstr` 或 `rg`；
- bundled 二进制路径、版本、SHA、签名和安装完整性诊断细节；
- Windows/macOS 的打包与架构选择方式。

这些信息不会改变 Agent 此刻如何正确调用工具，只会占用提示词并可能让 Agent 把部署实现误当成输入契约。可以保留一句短的工具选择指引，例如“搜索文件内容时使用本工具，无需调用 shell”，因为它直接帮助 Agent 在多个工具间做选择。

“ripgrep 默认正则语法”应保留：它描述的是 `pattern` 的输入语言，而不是部署方式，直接决定 lookaround、反向引用和 multiline 等表达式能否使用。

| 项目 | 当前说明/实现 | 与 rg 或 fallback 的偏差 | 修订要求 |
| --- | --- | --- | --- |
| 总体说明 | “跨平台，内置实现，不依赖系统 grep/findstr/rg” | 这些部署信息不帮助 Agent 决定此刻如何调用；实际执行方式也正在改变 | 删除全部部署措辞，只说明工作目录范围、正则语法、输出选择、结果限制和“无需调用 shell” |
| `pattern` | “正则表达式搜索模式” | 没说明是 ripgrep 默认 Rust regex 语法；当前 JS fallback 又使用另一种语法 | 明确为“ripgrep 默认正则语法”；暂不暴露 PCRE2，并删除生产 JS fallback，保证只有一个正则契约 |
| `path` | 支持相对和绝对路径，默认整个工作目录 | 绝对路径仍必须位于工作目录；当前说明只在总描述间接表达 | 在字段上明确“绝对路径也不得超出工作目录”；输出统一为工作目录相对路径 |
| `glob` | 单个 string | rg 的 `-g/--glob` 可重复，但当前 API 只暴露一条；brace alternation 可表达常见多类型过滤 | 本次保持单 string，不扩展字段；说明使用 `.gitignore` 风格、支持 `!` 排除和 `{ts,tsx}` alternatives |
| `output_mode=files_with_matches` | 返回匹配文件列表 | 映射 `-l` 正确 | 保留；明确只返回文件路径 |
| `output_mode=content` | 返回匹配内容“含行号” | 实际 `show_line_number=false` 时不含行号 | 改成“返回匹配行/块；默认含行号，可由 show_line_number 关闭” |
| `output_mode=count` | “每文件匹配行数” | rg `--count` 通常是匹配行数，但与可跨行的 pattern 组合时会按匹配次数统计 | 对外固定为“匹配行数”，因此 `multiline=true` 只允许 `content`，服务端拒绝与 count/files 模式组合；count 调用增加 `--with-filename`，单文件也稳定返回 `path:count` |
| `ignore_case` | 默认 false | 映射 `-i` 正确 | 保留 |
| `show_line_number` | 仅 content，默认 true | 映射 `-n` 基本正确，但进程环境中的 rg 配置可能改变行为 | bundled 调用增加 `--no-config`，避免 `RIPGREP_CONFIG_PATH` 注入；false 时显式传 `--no-line-number`；在非 content 模式显式提供该字段时报参数错误 |
| `context` | number，仅 content | rg `-C` 要求非负整数；当前 schema/guard 未限制整数和范围，负数被忽略、小数会交给 rg 报错 | 固定为 integer 0～1000；在非 content 模式显式提供时报参数错误 |
| `multiline` | “多行模式” | content 模式实际同时传 `-U` 和 `--multiline-dotall`，意味着允许跨行且 `.` 匹配换行；其他模式当前静默忽略 | 最终决策为仅支持 `output_mode=content`；schema description 明示，服务端对其他组合报参数错误，不静默忽略 |
| `head_limit` | “最大返回条数，等同 shell head” | 当前是事后截 rg 原始输出行，但小数也被允许，字节上限与 0 的关系未说明 | 最终定义为最多返回 N 个非空输出物理行：files 模式为文件路径行，count 为 `path:count` 行，content 为匹配行、上下文行和 `--` 分隔行；0 只取消行数限制，仍受 400 KiB 返回上限约束。schema 改为整数 0～1000000 |
| 长行 | 内部固定 `--max-columns 500` | rg 默认完全省略超长匹配行，Agent 不知道这一限制 | 最终固定增加 `--max-columns-preview`：显示前 500 bytes 和 rg 自带省略标记；工具字段说明明确“超长行只返回预览” |
| ignore/隐藏文件 | 工具说明未提 | rg 默认遵守 ignore 文件并跳过隐藏/二进制文件，另有固定构建目录排除 | 明确唯一 rg 引擎的正常语义，无需再为另一引擎保留模糊表述 |
| 搜索顺序 | 未说明 | rg 并行遍历默认不保证路径顺序，`head_limit` 下命中集合可能不稳定 | 不承诺排序；若确需确定性，再新增显式排序能力并评估 `--sort path` 的性能代价 |

#### 8.4.2 本次落地文案

本次应将 `src/shared/builtinToolDefinitions.ts` 中 Agent 可见 description 修改为：

> 在当前工作目录范围内递归搜索文件内容。`pattern` 使用 ripgrep 默认正则语法。使用 `output_mode` 选择返回匹配文件、匹配内容或每文件匹配行数，使用 `head_limit` 限制结果数量。搜索文件内容时使用本工具，无需调用 shell。

默认 ignore 行为不应只放在总 description 中笼统承诺，而应在 `path`/`glob` 字段说明中与唯一 rg 实现一起精确定义。移除生产 JS fallback 后，可以稳定承诺 `.gitignore`/`.ignore`、隐藏文件和二进制文件行为；固定排除的构建目录也应写入字段说明或保持为不影响 Agent 决策的实现策略。

字段说明同步修改：

- `pattern`：使用 ripgrep 默认正则语法的搜索模式；默认不支持 lookaround 和反向引用。
- `path`：工作目录内要搜索的文件或目录；支持相对路径和工作目录内的绝对路径，默认搜索整个工作目录。
- `context`：仅适用于 `output_mode=content`，匹配前后各返回 N 行，取值为整数 0～1000；与其他输出模式组合时返回参数错误。
- `show_line_number`：仅适用于 `output_mode=content`，默认 true；与其他输出模式组合时返回参数错误。
- `multiline`：仅适用于 `output_mode=content`；允许匹配跨行，且 `.` 可匹配换行；默认 false。与其他输出模式组合时返回参数错误。
- `head_limit`：最多返回的非空输出行数，默认 100；content 的匹配行、上下文行和分隔行均计入，files/count 每个文件占一行；0 不限制行数，但仍受 400 KiB 总返回上限约束。
- `glob`：使用 `.gitignore` 风格 glob，支持 `!pattern` 排除；显式单文件 path 不受 glob/ignore 过滤。
- `count`：每个文件中包含匹配的行数，不是正则出现次数。
- `content`/长行：返回匹配内容，默认含行号；超过 500 bytes 的单行只返回前 500 bytes 预览并带省略标记。

Schema 同步增加 `additionalProperties: false`：`context` 固定为 integer 0～1000，`head_limit` 固定为 integer 0～1000000。executor 仍需保留服务端校验，不能只依赖模型遵守 JSON Schema。服务端明确拒绝非 content 模式显式携带 `multiline`、`context` 或 `show_line_number`，不能因模型供应商对条件 schema 支持不同而只依赖 `if/then`；字段未提供时使用默认值不构成非法组合。

#### 8.4.3 确定的 rg 参数与输出规则

安全解析仍使用绝对路径验证工作区边界，但传给 rg 前必须转换为相对于 `cwd=workDir` 的路径（根目录使用 `.`），使 Windows/macOS 及单文件/目录输出都稳定为工作目录相对路径。所有模式固定传 `--no-config --color never --max-columns 500 --max-columns-preview`，不读取 `RIPGREP_CONFIG_PATH`。此外：

| output mode | rg 参数 | `head_limit` 的一行 |
| --- | --- | --- |
| `files_with_matches` | `--files-with-matches` | 一个工作目录相对文件路径 |
| `count` | `--count --with-filename` | 一个 `path:匹配行数` 记录；强制文件名以统一单文件/目录输出 |
| `content` | `--line-number` 或 `--no-line-number`；按需加 `--context N`；`multiline=true` 时加 `--multiline --multiline-dotall` | rg stdout 的一个非空物理行；匹配行、上下文行、跨行匹配展开行和 `--` 分隔行都计入 |

`head_limit` 在 rg 正常结束后应用于非空 stdout 行，保留前 N 行；达到行数限制不改变 rg 的退出码含义。`head_limit=0` 不做行数截断，但所有模式始终受 400 KiB 最终返回上限约束。输出累积器必须按字节设置硬上限并继续安全 drain 子进程 stdout，不能反复 slice 字符串后继续无界累积，也不能切断 UTF-8 字符后返回乱码。发生字节截断时追加统一提示；行数截断时追加包含原始非空行数和限制值的统一提示。

#### 8.4.4 文案与实现一致性门禁

- 对 `BUILTIN_TOOL_DEFINITIONS` 增加契约测试，断言 description 不再包含“跨平台”“内置实现”“不依赖系统”等部署措辞。
- schema 测试断言 `pattern` 必填，`output_mode` 枚举稳定，`context`/`head_limit` 为带范围的 integer，且拒绝未知字段。
- executor 参数化测试覆盖 description 中承诺的每一项行为，尤其是 path 边界、三种输出模式、multiline 组合拒绝、glob、ignore、head limit、单文件 count 强制文件名和 500-byte 长行预览。
- description 不写内部路径、版本号或“当前使用 bundled rg”等可能随发布变化的实现信息。
- 以后改变 ignore、计数、正则引擎或输出截断行为时，必须在同一 PR 更新 description/schema 契约测试。

## 9. 安全、许可证与升级

### 9.1 供应链控制

- 仅接受官方固定 release 资产；实施 PR 同时记录 release 页面、资产 URL 和 SHA-256 的复核证据。
- 下载脚本不得读取未受信环境变量来替换 URL，也不得自动退回镜像。
- GitHub Actions 缓存只能加速下载，恢复后仍需重新做 SHA-256 和 `--version` 校验。
- 解压目录必须是新建临时目录，完成后清理；目标更新使用原子替换。
- runtime 不从网络更新 rg。rg 只能随 SpaceAssistant 新版本升级。

### 9.2 许可证

ripgrep 采用双许可证。发布包需包含上游许可证/版权文本，例如放在 `resources/licenses/ripgrep/`，并在应用第三方声明或仓库 NOTICE 中列出精确版本、项目主页和许可证。实施时须以所选版本归档中的实际 LICENSE 文件为准，不手写或截断许可文本。

### 9.3 升级流程

升级 rg 必须作为独立、可审计的依赖变更：更新全部目标 URL/SHA、重新跑三平台探针、检查 release notes 中的 CLI/正则/ignore 行为变化，并比较代表性 fixture 输出。不得只修改版本字符串。

## 10. 测试方案

### 10.1 单元测试

新增 `ripgrepBinary.test.ts`：

- packaged Windows x64 解析到 `resources/bin/rg.exe`。
- packaged macOS x64/arm64 解析到 `Resources/bin/rg`。
- development 按 `process.platform/process.arch` 选择 staging。
- 未支持架构返回稳定错误，不尝试 `PATH`。
- 路径始终为绝对路径，文件名不受输入影响。

扩展 grep executor 测试：

- 断言 spawn 第一个参数是解析后的绝对路径，而不是 `rg`。
- exit 0、exit 1、非法正则/参数、ENOENT、EACCES、超时、取消、未知崩溃分别走正确分支。
- 所有失败分支均不调用 `grepFallbackJs` 或第二搜索引擎；缺失/权限/加载错误返回稳定的 unavailable 错误。
- rg stderr 返回工具错误时做长度限制和敏感路径处理。
- 删除原有“rg 失败 → JS fallback”分发测试，改为“rg 失败 → 明确错误且不执行搜索降级”；在删除 `grepFallbackJs` 本体的同一提交中删除其专属测试，避免仓库继续维护不可达的第二套搜索语义。

测试不能依赖开发机恰好安装的系统 rg。集成测试要么使用准备好的固定二进制，要么注入受控 fake executable。

### 10.2 准备脚本测试

- `archiveSha256` 与 `binarySha256` 均正确时成功，且 staging、afterPack 复制后文件、package verifier 计算结果一致。
- 归档哈希错误、解压后二进制哈希错误、staging 被篡改、404、超大响应、重定向异常均失败。
- zip/tar 路径穿越、绝对路径、symlink/hardlink、重复目标文件失败。
- `--version` 与 manifest 不一致失败。
- 中途失败不覆盖上一份已验证 staging。
- Windows zip 与 macOS tar.gz 两种格式均覆盖。

### 10.3 打包与产物测试

`verify-ripgrep-package.mjs` 接受明确产物目录，不默认猜第一个 `.app`。验证：

1. 目标文件存在且位于 asar 外。
2. macOS mode 包含执行位；Windows 文件名为 `rg.exe`。
3. 文件格式/架构正确：macOS 分别为 x86_64、arm64；Windows 为 PE x64。尽量用 Node 解析或跨平台库，不能让 Windows 检查依赖 Unix `file`。
4. 同宿主架构执行产物内二进制 `--version` 并精确匹配 manifest；交叉架构目标只做静态版本/架构检查，另由原生架构 runner补齐执行验证。
5. 对临时 fixture 执行一次真实搜索并检查输出。
6. macOS 在资源落位后通过 `codesign --verify --deep --strict`。

DMG/NSIS 最终安装验收还要在干净 VM/runner 中清空或缩小 `PATH`，从安装后的应用触发内置 grep，并通过测试诊断钩子确认 `source=bundled`，而不是仅从构建目录单独执行 rg。

## 11. CI/CD 调整

### 11.1 CI 质量门禁

普通 `verify` job 增加脚本单测与 manifest schema 校验，不必每次下载所有二进制。可增加按平台矩阵的 rg prepare/probe job，分别在 `windows-latest`、GitHub 当前提供的 Intel macOS label 和 Apple Silicon label 上运行；runner label 与架构在 workflow 中必须显式记录，不能假定 `macos-latest` 永远对应某一种 CPU。如果仓库套餐或 GitHub runner 资源不覆盖某架构，至少在打包 job 中对交叉目标做静态架构验证，并在正式发布前保留真机/VM 冒烟门禁。

### 11.2 release workflow

在 `.github/workflows/release.yml`：

1. Windows job 执行 `prepare-ripgrep.mjs --target win32-x64`。
2. macOS job执行 `prepare-ripgrep.mjs --target darwin-x64 --target darwin-arm64`。
3. 执行 electron-builder；`afterPack` 对每个产物复制相应目标。
4. 在上传前枚举所有 `.app`/unpacked Windows 产物并逐个运行 `verify-ripgrep-package.mjs`；不能再用 `find ... | head -n 1`，因为这会漏检 macOS 的另一架构。verifier 记录“产物路径、目标 key、binarySha256”三元组，发布阶段据此证明三个最终上传文件分别源自对应的已验证 unpacked 产物。
5. macOS 对两套 `.app` 都执行签名验证。
6. 任一架构缺失或错误立即失败，不发布部分正确的 release。

release 上传目前只保留 DMG/EXE，验证应发生在 electron-builder 清理 unpacked 目录之前，或显式从最终 DMG/安装包挂载/解包复核。实现时必须确认 electron-builder 生命周期和产物保留位置，不能只验证 staging 文件。

## 12. 实施阶段

### Phase 1：供应链与 staging

1. 选择并固定 ripgrep 精确版本及三个官方资产。
2. 增加 manifest、下载/校验/安全解压脚本及测试。
3. 增加 gitignore 和第三方许可证声明。
4. 在 Windows/macOS CI 上验证三种目标文件版本与架构。

门禁：归档/二进制错误哈希、staging 篡改和恶意归档测试通过；三个目标的 `binarySha256`、`--version`、文件格式和架构验证通过。

### Phase 2：运行时接入

1. 新增 `ripgrepBinary.ts`，将二进制解析与 grep 业务分离。
2. `grepWithRg` 改用绝对路径和结构化结果。
3. 移除 `grepExecutor` 生产链中的 `grepFallbackJs` 和相关分发逻辑；所有错误、取消和超时均结构化返回，不启动第二引擎。确认无其他生产引用后删除 `grepFallbackJs` 本体及其专属测试。
4. 按 §8.4 同步修改 Agent 可见 description、字段说明、JSON Schema 和服务端参数校验；删除部署信息，统一 multiline、count、head limit、glob、ignore、路径与长行契约。
5. 增加非敏感诊断事件。

门禁：聚焦测试、`npm test`、`npm run typecheck:shared` 和 `npm run build:electron` 全绿；测试证明正式模式不会调用 PATH 中的 rg，也不存在 JS 搜索降级；Agent 可见 description/schema 契约测试通过，文案承诺与唯一 rg 引擎的外部行为一致。

### Phase 3：打包与发布闭环

1. 修改 `after-pack.cjs`，按 `context.electronPlatformName/context.arch` 复制、验证，再执行平台后处理和签名。
2. 修改 pack scripts 和 release workflow，显式准备所需目标。
3. 增加产物 verifier，对 Windows x64、macOS x64/arm64 全覆盖。
4. 在无系统 rg 的干净 Windows/macOS 环境做应用级搜索冒烟。

门禁：三个最终安装产物均证明使用 bundled rg；macOS 两架构签名验证通过；临时移除随包 rg 时返回明确安装完整性错误，且没有第二搜索引擎被调用。

## 13. 验收标准

| 编号 | 场景 | 期望 |
| --- | --- | --- |
| A1 | Windows x64 干净系统，无系统 rg | 内置 grep 成功，诊断源为 `bundled` |
| A2 | macOS Intel 从 Finder 启动，PATH 无 Homebrew | 内置 grep 成功，执行 x86_64 bundled rg |
| A3 | macOS Apple Silicon 从 Finder 启动 | 内置 grep 成功，执行 arm64 bundled rg |
| A4 | PATH 前置一个伪造 rg | 正式包仍只执行 `process.resourcesPath/bin` 下的 rg |
| A5 | bundled rg 被删除 | 记录 `unavailable/missing` 并返回明确安装完整性错误，不搜索、不崩溃 |
| A6 | bundled rg 无执行权限 | 记录 `unavailable/permission` 并返回明确错误；产物 verifier 必须阻止此包发布 |
| A7 | 用户输入 rg 不支持的正则/参数 | 返回明确工具错误，不切换 JS 正则引擎 |
| A8 | 搜索超时或用户取消 | 返回部分输出/取消状态，不启动第二次搜索 |
| A9 | macOS x64/arm64 两个 DMG | 两个产物各自包含正确架构 rg，且签名验证通过 |
| A10 | 供应链资产、解压后二进制或 staging 内容变化 | `archiveSha256` 或 `binarySha256` 不匹配，准备与发布立即失败 |
| A11 | Agent 查看 `grep` 工具定义 | 只看到使用时机、范围、语法、参数、输出和限制；不出现跨平台、系统依赖、打包路径等部署信息 |
| A12 | description/schema 与 executor 对照测试 | multiline、count、head limit、glob、ignore、路径和长行行为均有一致、可执行的单一 rg 契约 |

## 14. 风险与回滚

| 风险 | 影响 | 控制 |
| --- | --- | --- |
| 上游资产被替换或不可达 | 构建失败 | 固定 SHA；允许 CI 缓存但仍校验；不静默换源 |
| macOS 复制顺序错误 | 签名失效 | 强制复制/权限/执行验证在签名前完成，最后严格验签 |
| 架构拿错 | 用户侧 `bad CPU type`/加载失败 | afterPack 按 context 选择；静态架构验证；真机/runner 冒烟 |
| Windows 安全软件关注额外 exe | 安装/运行受阻 | 官方固定二进制、哈希和许可证；发布前 VM/Defender 冒烟；未来评估单独签名 |
| 包体增加 | 下载体积上升 | 每个安装包只携带自身架构，不把三份二进制全部塞入单包 |
| 移除 JS fallback 后 rg 不可用 | 搜索工具暂时不可用 | 发布门禁保证完整性；运行时返回明确错误和修复指引，不返回语义不可靠的结果 |
| 开发者未准备 rg | 本地无法运行 grep 工具 | 开发启动/集成测试显式提示运行 `npm run prepare:rg`，不暗用系统 PATH |

若上线后特定 bundled rg 版本引发阻断，优先以独立依赖升级 PR 更新 manifest 中的归档/二进制双摘要和三平台证据，不允许运行时远程热替换二进制。若必须整体回滚集成，应回滚运行时选择模块、afterPack 复制、下载脚本触发、包内二进制和许可证条目；不得只恢复 `spawn('rg')` 后继续依赖用户 PATH。重新启用 JS fallback 会重新引入已确认的正则契约冲突，不属于安全回滚路径，必须另立设计并重新评审。

## 15. 预计改动清单

| 文件 | 变更 |
| --- | --- |
| `scripts/ripgrep-manifest.json` | 新增固定供应链清单 |
| `scripts/prepare-ripgrep.mjs` | 新增下载、哈希、安全解压、版本验证 |
| `scripts/verify-ripgrep-package.mjs` | 新增打包产物验证 |
| `scripts/after-pack.cjs` | 按 target 复制 rg，验证后再图标处理/签名 |
| `electron/tools/ripgrepBinary.ts` | 新增绝对路径解析和状态类型 |
| `electron/tools/builtinExecutors.ts` | 改用 bundled 路径、结构化错误，删除生产 JS fallback 与最终无引用的实现 |
| `src/shared/builtinToolDefinitions.ts` | 同批优化 Agent 可见 description、字段说明和 JSON Schema，删除无效部署信息 |
| `electron/tools/*.test.ts` | 增加路径、退出状态、无引擎降级测试，删除 fallback 专属测试 |
| `src/shared/builtinToolDefinitions.test.ts` | 增加 Agent 可见文案和 schema 契约测试 |
| `package.json` / lockfile | 增加 scripts；如采用解压库则锁定依赖；调整 pack 前置步骤 |
| `.github/workflows/release.yml` | 三目标准备与所有产物验证 |
| `.gitignore` | 忽略本地 rg staging |
| 第三方声明文件 | 纳入 ripgrep 版本与原始许可证文本 |

实施完成后，`grep` 的正常生产链路应为：

```text
内置 grep 请求
  → 安全解析工作区路径
  → 解析 process.resourcesPath/bin/rg(.exe)
  → 执行随包且已校验的目标架构 ripgrep
  → 0/1 正常返回；请求错误明确失败
  → 二进制不可用时记录诊断并返回安装完整性错误，不切换引擎
```
