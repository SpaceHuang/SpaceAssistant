# grep 工具大文件降级检索优化方案

> 文档日期：2026-09-11
> 依据：`docs/analyze/grep-tool-1mib-file-limit-diagnosis.md`
> 文档性质：现状复核与开发方案；本次不包含代码实现。

## 1. 复核结论

报告中描述的“超过 1 MiB 的单文件在降级路径被静默跳过，最后返回 `No matches found`”在当前代码中**仍然存在**。

证据位于 `electron/tools/builtinExecutors.ts`：

```ts
const GREP_FILE_MAX = 1024 * 1024
// ...
if (buf.length > GREP_FILE_MAX) return
```

`grepFallbackJs()` 对显式单文件和递归遍历均会执行该分支；因此一个实际含匹配、大小为 1,048,577 字节的文本文件会被跳过。若没有其他文件命中，函数会返回 `No matches found`，调用方只能看到 `{ output, degraded: true }`，不能区分“真无匹配”和“因文件过大未搜索”。诊断报告关于假阴性的核心判断成立。

但报告的触发条件需按当前实现修正：

1. 当前 `grepExecutor` 不依赖系统 PATH 中的 `rg`。它通过 `resolveRipgrepBinary()` 优先定位开发态 `resources/ripgrep/<platform>-<arch>/rg` 或打包态 `resources/bin/rg`。
2. 仓库已有 macOS/Windows 的开发态二进制，并且打包流程会复制并校验二进制。因此 `command -v rg` 失败并不等价于应用的 grep 主路径失败。
3. 只有目标平台不受支持、内置二进制缺失/不可执行，或其启动时报错时，才会进入 `grepFallbackJs()`；届时 1 MiB 假阴性风险才被触发。

结论：问题从“默认 grep 存在 1 MiB 上限”收敛为“**无 ripgrep 时的 fallback 不能静默漏报大文件**”。主路径已经是正确的优先优化方向，不能退回为依赖宿主 PATH 的实现。

## 2. 目标与非目标

### 2.1 目标

1. 降级搜索不得把“被策略跳过”伪装成 `No matches found`。
2. 显式指定的大文件必须得到确定、可操作的结果：已完成搜索，或明确说明未完成及原因。
3. 目录递归时必须汇总被跳过文件和原因，保留成功命中，并让 Agent 能判断结果不完备。
4. 保持 ripgrep 为唯一的正常执行引擎；fallback 仅是可观测、语义受限的应急路径。
5. 限制内存、输出和取消语义，避免为修复漏报而一次性读取任意大文件。

### 2.2 非目标

- 不通过安装系统 `rg` 或修改 PATH 修复问题；应用应使用受校验的内置二进制。
- 不承诺 JavaScript fallback 与 ripgrep 的全部正则、glob、ignore 和二进制判定语义完全一致。
- 不取消资源上限，也不让大文件的完整匹配结果绕过现有 `head_limit`、输出大小和超时保护。

## 3. 推荐设计

### 3.1 结果契约：显式表示不完整搜索

为 fallback 建立内部结构化结果，而非只返回字符串：

```ts
type GrepFallbackResult = {
  output: string
  partial: boolean
  scannedFiles: number
  skipped: Array<{
    path: string
    reason: 'file_too_large' | 'unreadable' | 'binary' | 'unsupported_pattern'
    bytes?: number
  }>
}
```

对外兼容现有 `data.output`，并新增稳定的可选元数据：

```ts
data: {
  output: string
  degraded: true
  partial: boolean
  skippedFiles: number
  skipReasons: Record<string, number>
}
```

输出末尾增加机器和人都易理解的摘要。例如：

```text
[降级搜索不完整：跳过 1 个文件（file_too_large: 1）；结果不能用于证明不存在匹配]
```

显式单文件因超限跳过时，不能返回 `No matches found`；应直接返回上述不完整结果。目录搜索即便找到了其他匹配，也必须附该摘要。详情列表限制为前 20 个相对路径和文件大小，避免输出放大；完整计数由元数据提供。

### 3.2 大文件处理策略：流式搜索优先，受限跳过保底

将当前 `fs.readFile()` 全量读取替换为 `stat` 后的分级策略：

| 文件类型/大小 | fallback 行为 |
|---|---|
| 非二进制、≤ 1 MiB | 保持现有内存内扫描 |
| 非二进制、> 1 MiB，且请求是非 multiline | 以固定块大小流式按行扫描；保留跨块残行；命中数和输出遵守 `head_limit` |
| 非二进制、> 1 MiB，且请求开启 multiline | 不全量加载；标记 `file_too_large_multiline`（或统一为 `file_too_large` 并在摘要说明 multiline 不支持） |
| 二进制、不可读、目录遍历失败 | 跳过并记录稳定原因 |

建议实现一个只供 fallback 使用的 `scanTextFileStreaming()`：

- 使用 `fs.createReadStream()` 和 `StringDecoder`，防止 UTF-8 字符被分块截断；
- 以 `\n` 组装完整行，逐行复用当前非 multiline 正则规则；
- 每处理一个块和每输出一条匹配均检查 `AbortSignal` 与 `head_limit`；
- 对单行超过展示上限的情况沿用 `clampLine()`，但仅保留展示文本；
- 设置单行缓冲硬上限（建议 1 MiB）。超过时记录 `line_too_large` 并令结果 `partial=true`，不把无界行保留在内存中。

这样常见的 JSONL、日志和源代码大文件在没有 rg 的紧急场景下仍可检索；真正无法可靠处理的模式会被明确报告，而不是无声漏掉。

### 3.3 fallback 可观测性与主路径保障

保留现有 `grep-ripgrep`、`grep-ripgrep-fallback` 诊断，但补充不含路径和 pattern 原文的聚合字段：

- `status=streaming_fallback` 或 `status=limited_fallback`；
- `scannedFiles`、`skippedFiles`、按原因聚合的数量；
- `partial=true/false`。

为二进制解析失败、权限错误和不支持的平台保持原有降级流程。不要将二进制“存在”误判为“可运行”：打包验证继续执行 SHA-256、架构和 `rg --version` 校验；开发态启动失败仍应安全回退，并把 fallback 不完整性回传给调用方。

## 4. 分阶段实施计划

### 阶段 A：锁定回归与契约

涉及文件：

- `electron/tools/builtinExecutors.test.ts`（新增；或按现有测试拆分为 `grepFallback.test.ts`）；
- `electron/tools/ripgrepExecutorProcess.test.ts`；
- `electron/tools/builtinExecutors.ts`。

先编写失败测试：

1. 生成 1,048,576 与 1,048,577 字节的 UTF-8 文件，后者包含唯一 `Needle`。
2. 强制调用 fallback，验证大文件结果不再是裸 `No matches found`；若实施流式搜索，必须命中 `Needle`。
3. 针对目录搜索，验证“一个正常命中文件 + 一个无法搜索的大文件”会返回命中、`partial=true` 与跳过摘要。
4. 验证没有任何匹配且没有跳过时仍精确返回 `No matches found`。
5. 验证二进制/权限错误/目录读取错误均可观测，且不泄漏绝对路径。
6. 验证 `grepWithRg()` 可用时不会调用 fallback，且 > 1 MiB 文件正常交给 rg。

完成判据：测试明确区分真阴性、部分结果和完全搜索结果，且测试不依赖宿主机 PATH 是否安装 `rg`。

### 阶段 B：重构 fallback 返回值与跳过统计

涉及文件：

- `electron/tools/builtinExecutors.ts`；
- 新增或扩展 fallback 专用测试。

实现事项：

1. 将 `grepFallbackJs()` 改为返回 `GrepFallbackResult`，由 executor 统一组装 `data` 和用户输出摘要。
2. 以 `fs.stat()` 先获知大小；所有跳过路径进入同一个 `recordSkip()`，禁止直接 `return` 丢弃原因。
3. 限制详情路径数量、按相对路径输出，并对无法计算大小的场景省略 `bytes`。
4. 当 `absSearch` 不存在时返回明确的工具错误（例如“搜索路径不存在”），不要把它与“无匹配”合并；该项可作为独立兼容性评估，若调用契约暂不允许改变，则至少令 fallback 元数据标记 `path_missing`。

完成判据：任何 `partial=true` 的响应都包含可见摘要，任何纯 `No matches found` 的响应都可被解释为“已完成且无匹配”。

### 阶段 C：实现流式大文件扫描

涉及文件：

- 新增 `electron/tools/grepFallbackStreaming.ts`；
- `electron/tools/builtinExecutors.ts`；
- 新增 `electron/tools/grepFallbackStreaming.test.ts`。

实现事项：

1. 将逐行匹配、计数和 content 格式化提取为可由内存扫描和流扫描共享的 accumulator，避免两条路径的输出语义漂移。
2. 对 > 1 MiB 的非 multiline 文本启用流扫描；对非 ASCII、CRLF、跨块 UTF-8 字符、跨块残行和超长行建立单测。
3. 保持 `files_with_matches`、`count`、`content` 三种模式的 `head_limit` 行为；达到限制后及时销毁流。
4. `multiline=true` 的大文件显式降级并标记部分结果；后续如确有需求，再设计有界窗口的跨块多行匹配，而不是隐式全量读取。

完成判据：测试能证明扫描大文件时未调用 `fs.readFile()` 全量加载，并覆盖取消、输出限制和异常流关闭。

### 阶段 D：发布保障与文档

涉及文件：

- `src/shared/builtinToolDefinitions.ts`；
- 相关中英文 i18n 文案；
- `docs/analyze/grep-tool-1mib-file-limit-diagnosis.md`（追加当前实现的勘误/状态）；
- 打包验证相关测试和脚本（仅在现有覆盖不足时）。

实现事项：

1. 工具描述补充：正常情况下由内置 ripgrep 搜索；降级搜索会明确标识结果不完整。
2. 将 `degraded` 定义为“未使用 ripgrep”，将 `partial` 定义为“未完整覆盖目标”；二者不得互相替代。
3. 记录开发态和打包态 rg 的可用性验证结果，确保 Linux/不受支持架构的 fallback 行为在发行说明中可预期。

完成判据：用户、Agent 和诊断日志对降级状态具有一致解释；报告中关于 PATH 的过时判断已被修订，不会误导后续排障。

## 5. 验证矩阵

| 场景 | 期望结果 |
|---|---|
| rg 可用，1 MiB+1 文本有命中 | 正常命中；`degraded` 不存在/为 false；`partial=false` |
| fallback，1 MiB+1 JSONL 有命中，非 multiline | 流式命中；`degraded=true`；`partial=false` |
| fallback，大文件无匹配，非 multiline | 完整搜索后 `No matches found`；`partial=false` |
| fallback，大文件且 multiline | 不返回裸真阴性；`partial=true`，说明未搜索原因 |
| fallback，目录中有正常命中与跳过文件 | 返回命中并带跳过摘要；`partial=true` |
| fallback，显式路径不存在 | 明确路径错误或稳定 `path_missing` 状态，不能等同无匹配 |
| fallback，取消/超时 | 保持现有取消/超时语义，流和句柄被关闭 |
| 打包应用 | 内置 rg 存在、可执行、架构与 digest 均通过既有校验 |

建议执行顺序：先运行新增的 fallback/流式单元测试，再运行 `npm test`、`npm run typecheck:shared` 与 `npm run typecheck:renderer`。涉及打包资源时，额外运行 `npm run prepare:rg` 和对应平台的 `npm run verify:rg:package -- <package-dir>`。

## 6. 风险与回滚

- 流式扫描的正则语义不能覆盖跨行模式，因此第一版必须明确限制 `multiline=true`，不能产生近似但被误认为完整的结果。
- 文件遍历遇到权限、链接或并发删除时只记录稳定原因；路径详情仍必须受工作目录边界与输出上限控制。
- 若流式实现出现性能或兼容性问题，可保留阶段 B 的“显式跳过 + partial”作为安全回滚状态。该回滚会降低能力，但不会重新引入假阴性。
- 不应移除 1 MiB 保护后继续调用 `fs.readFile()`；这会把正确性问题转化为可被大文件放大的内存风险。
