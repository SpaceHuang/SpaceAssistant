# 工具 path 字段别名归一化 - TDD 开发计划

> 解决「回复未能完成。你可以重试生成，或基于已有上下文继续对话。」频繁出现的问题。
>
> 范围：修复项 1（执行器参数名归一化）+ 2（校验器识别别名并报清晰错误）+ 4（系统提示/工具描述强调字段名）。
>
> 方法：严格 TDD（Red -> Green -> Refactor），先写失败测试，再改实现，最后回归。
>
> 修订（v3）：吸收 `docs/review/tool-path-field-alias-normalization-tdd-plan-review.md`（v2）意见 A1–A5 —— sanitize 透传约束与回归断言（A1）、执行器行号范围起点修正（A2）、read_file case 的 offset/limit 保留说明（A3）、完全缺参仍可能 abort 的范围说明（A4）、list_directory 默认值用例（A5）。

## 1. 背景与根因（摘要）

`docs/develop` 之外的分析结论（详见 `.agent/logs/Agent-20260719.log`）：

- `deepseek-v4-pro` 调用 `read_file` 时，约 16%（75 次中 12 次）把 `path` 写成 `filePath`（5 次）或 `file_path`（7 次）。
- 执行器 `readFileExecutor` 只读 `input.path`（`electron/tools/builtinExecutors.ts:173`），别名入参被忽略 -> `rel = ''` -> 解析到 workDir -> 返回 `路径是目录而非文件: 。请使用 list_directory 查看目录内容，或指定具体文件路径`（`rel=''` 时冒号后为空，但消息**并非止于冒号**，其后还有 list_directory 引导语；排查日志时勿只 grep 冒号片段）。
- 该错误信息未提示「字段名错了」，模型继续用别名重试；`toolChatLoop.ts` 的 `makeToolErrorRepeatTracker` 在连续 3 次相同 `(toolName, error)` 后 `abortRepeatedToolError`（`:261`、`:824-825`），整条回复中止 -> 前端 `ChatView.tsx:1097` 置 `status:'failed'` -> `ChatBubble.tsx:406-408` 显示「回复未能完成」。
- 校验器 `assertSafeToolInput` 对 `read_file` 的 `path` 用 `optStringLen`（可选，`electron/toolInputGuards.ts:51`），错参被静默放行，未在入口拦截。

## 2. 目标

1. **执行器归一化**：`read_file`/`list_directory`/`edit_file`/`write_file`/`grep` 统一接受 `path`、`filePath`、`file_path` 三种字段名。
2. **校验器识别别名 + 清晰错误**：别名入参通过校验；当 path 类字段完全缺失时，抛出明确错误（点名正确字段名 `path`），不再静默放行成空路径。
3. **系统提示/工具描述强调字段名**：在工具 `description` 与系统提示中显式声明「路径字段名为 `path`」，降低第三方模型用错概率。

## 3. 现状代码定位

| 关注点 | 位置 |
|---|---|
| 校验器入口 | `electron/toolInputGuards.ts:48-99`（`assertSafeToolInput`） |
| **存量缺参文案函数** | `electron/toolInputGuards.ts:37-39`（`toolErrMissingPath`，返回 `工具参数无效：${toolName} 缺少必填参数 path`，已被 edit_file/write_file 执行器使用） |
| 校验器测试 | `electron/toolInputGuards.test.ts`（已存在，追加用例） |
| 输入归一化 chokepoint | `electron/toolUseInputMerge.ts:6`（`normalizeToolUseInputRecord`，仅浅拷贝 / JSON 字符串解析，**不按 toolName 处理字段**）；真正按 toolName 合并字段的是 `coalesceToolUseInputs`（`:35-55`），其 `ensureString` 当前仅认 `path`（`:49-53`） |
| 调用链 | `electron/toolChatLoop.ts:808`（inputObj）-> `:832`（guard）-> `:833-838`（catch 后 `augmentToolInputValidationError` + `sanitizeToolErrorString` 转 tool error）-> 执行器 |
| read_file 执行器 | `electron/tools/builtinExecutors.ts:169-280`（`:173` 读 path） |
| list_directory 执行器 | `electron/tools/builtinExecutors.ts:284-…`（`:288` 读 path，默认 `'.'`） |
| edit_file 执行器 | `electron/tools/builtinExecutors.ts:440-…`（`:444` 读 path；`:446` 缺参返回 `toolErrMissingPath('edit_file')`） |
| write_file 执行器 | `electron/tools/builtinExecutors.ts:542-…`（`:546` 读 path；`:548` 缺参返回 `toolErrMissingPath('write_file')`） |
| grep 执行器 | `electron/tools/builtinExecutors.ts:810-…`（`:816` 读 path，默认 `''` 即全工作目录） |
| 执行器缺参文案 import | `electron/tools/builtinExecutors.ts:402`（`import { toolErrMissingPath } from '../toolInputGuards'`） |
| 执行器测试范式 | `electron/tools/builtinExecutors.fileState.test.ts`（`makeCtx` + `tmpDir`，可逐字复用） |
| 工具 schema/描述 | `src/shared/builtinToolDefinitions.ts:44-…`（read_file 等的 `description` 与 `input_schema`） |
| **wechat 合法 filePath 字段** | `src/shared/builtinToolDefinitions.ts:241-242`（wechat_reply）、`:256-257`（wechat_send）——含义为「待发送文件/图片路径」，与文件工具的 path 别名**撞名**，见 §8 |
| 系统提示拼装 | `electron/llmSystemPrompt.ts:52-75`（`buildFinalSystemPrompt`，已含 locale 分支 hint 范式） |

## 4. 设计方案

### 4.1 新增共享 helper（修复项 1+2 的共同基础）

新文件 `electron/toolPathField.ts`，导出：

```ts
/** 已知的「路径字段名」别名，按优先级排序。 */
export const PATH_FIELD_ALIASES = ['path', 'filePath', 'file_path'] as const

/**
 * 从工具入参中提取路径字段值。
 * 按 path -> filePath -> file_path 顺序取第一个「非空字符串」。
 * 全部缺失或为空串/空白时返回 undefined（供调用方区分「缺参」与「显式空」）。
 *
 * 适用范围：仅用于 read_file / edit_file / write_file / list_directory / grep
 * 这 5 个文件类工具的 path 提取。wechat_reply / wechat_send 的 filePath / imagePath
 * 是「待发送文件/图片路径」的合法语义字段，与本函数的「path 别名」语义不同，不可混用。
 */
export function extractPathField(input: Record<string, unknown>): string | undefined
```

**语义约定**（在测试中固化）：

- `path` 存在 -> 返回 `path`（即使 `filePath` 同时存在，`path` 优先）。
- 仅 `filePath` 存在 -> 返回 `filePath`。
- 仅 `file_path` 存在 -> 返回 `file_path`。
- 值非字符串（如 number）-> 跳过该别名，继续看下一个；全无效 -> `undefined`。
- 空串或纯空白 -> 视为缺失（返回 `undefined`），避免重演「空路径 = workDir」的 bug。
- **不**做 trim 返回，原样返回字符串（trim 仅用于判空）。

> 选址理由：放在 `electron/` 根，校验器（`electron/toolInputGuards.ts`）`import './toolPathField'`、执行器（`electron/tools/`）`import '../toolPathField'` 均可直接复用，单点定义、单点测试。

### 4.2 修复项 1：执行器归一化

把 5 处 `const rel = typeof input.path === 'string' ? input.path : <默认>` 改为：

| 执行器 | 改造 |
|---|---|
| `read_file` | `const rel = extractPathField(input)`；`rel === undefined` 时返回 `{ success:false, error: toolErrMissingPath('read_file') }`（防御性，正常流程被 guard 拦截） |
| `edit_file` | 同上，`undefined` 返回 `toolErrMissingPath('edit_file')`（即现存 `:446` 调用，函数增强后文案自动带 hint，调用点无需改名） |
| `write_file` | 同上，`undefined` 返回 `toolErrMissingPath('write_file')`（即现存 `:548` 调用） |
| `list_directory` | `const rel = extractPathField(input) ?? '.'`（保留默认列工作目录根的语义） |
| `grep` | `const relPath = extractPathField(input) ?? ''`（保留「空 = 全工作目录」语义） |

> `toolErrMissingPath` 见 §4.3（**就地增强现有函数，不新增并列函数**）。
>
> **行为变更（空串 / 纯空白路径）**：`extractPathField` 将空串与纯空白均视为缺失。故：
> - `list_directory({ path: '' })` / `list_directory({ path: '   ' })`：由「以空串/空白为目录 -> 行为不确定或报错」变为「`?? '.'` -> 列工作目录根」；
> - `grep({ path: '   ' })`：由「以空白为路径 -> 报错目录不存在」变为「`?? ''` -> 全工作目录搜索」。
>
> 该变更是「纯空白 ≈ 未提供」的合理化，但属行为变更，需在 PR 点明（见 §7 排查项）。

### 4.3 修复项 2：校验器识别别名 + 清晰错误

在 `electron/toolInputGuards.ts`：

**就地增强存量函数 `toolErrMissingPath`**（`:37-39`），在尾部追加字段名 hint，使其同时服务 guard 与执行器：

```ts
/** 与 assertSafeToolInput / 执行器前置校验保持一致；缺 path 时点名正确字段名以引导模型纠错。 */
export function toolErrMissingPath(toolName: string): string {
  return `工具参数无效：${toolName} 缺少必填参数 path（注意字段名为 path，请勿使用 filePath 或 file_path）`
}
```

> **为何不新增并列函数**：仓库已存在 `toolErrMissingPath` 且被 edit_file/write_file 执行器（`:446` / `:548`）使用。若新增 `toolErrMissingPathWithHint` 并存，实现者极易只把 read_file/guard 切到新函数，edit_file/write_file 执行器仍用旧函数 —— 同一类「缺 path」错误，read_file 报带 hint、edit_file/write_file 报无 hint，对模型纠错引导不一致，且因 §5.3 原本缺 edit_file/write_file 缺参测试而**无法被捕获**。就地增强可让 guard 与 5 个执行器共用同一文案，执行器现存调用（`:446` / `:548`）与 `:402` import 均无需改动即自动生效。

- 改 `assertSafeToolInput` 各 case：

| case | 现状 | 改后 |
|---|---|---|
| `read_file` | `optStringLen(input.path,…)`（可选，静默放行） | `const p = extractPathField(input); if (p === undefined) throw new Error(toolErrMissingPath('read_file')); assertStringLen(p,'path',PATH_OR_GLOB_MAX)`（**改为必填**，对齐 schema `required:['path']`；`offset`/`limit` 的 `optPositiveInt` 校验分支保留不变，仅替换 path 校验） |
| `list_directory` | `optStringLen(input.path,…)` | `const p = extractPathField(input); if (p !== undefined) assertStringLen(p,'path',PATH_OR_GLOB_MAX)`（保持可选） |
| `grep` | `optStringLen(input.path,…)` | 同 `list_directory`（path 可选，仅校验长度） |
| `edit_file` | `reqStringLen(input.path,'path',…)`（只认 path） | `const p = extractPathField(input); if (p === undefined) throw new Error(toolErrMissingPath('edit_file')); assertStringLen(p,'path',…)` |
| `write_file` | `reqStringLen(input.path,'path',…)` | 同 `edit_file` |

**行为变更说明（需在 PR 中点明）**：

1. `read_file` 的 path 由「可选」改为「必填」。这与 schema `required:['path']` 一致；原本可选会导致空路径静默变成「路径是目录而非文件」。需确认无内部调用方在无 path 下调用 `read_file`（见 §7 排查项）。
2. **guard 与执行器共用 `toolErrMissingPath`，两层文案一致且均经 `sanitizeToolErrorString` 透传至模型**：
   - guard 层（`toolChatLoop.ts:832-836`）：`assertSafeToolInput` 抛出的 `Error.message` 经 `augmentToolInputValidationError`（`:214`，仅 `max_tokens` 场景改写，其余原样返回）后，再经 `sanitizeToolErrorString(msg, toolName)`（`:836`）成为 tool error；
   - 执行器层（`toolChatLoop.ts:1930-1934`）：read_file/edit_file/write_file 缺参是**正常返回** `success:false`（非抛异常），故 `execThrew=false`，`userErr = sanitizeToolErrorString(rawError, toolName)`（`:1932`），`execResult.error` 被覆写为 `userErr`；
   - 即两层都经过 `sanitizeToolErrorString`，**并非**「执行器返回的 `result.error` 直接成为 tool error」（旧表述不精确，已订正）。两层路径下「缺 path」文案完全一致，模型纠错引导统一。
3. **hint 文案须保持 sanitize-safe（隐性约束，须固化为测试）**：`sanitizeToolErrorString` -> `toToolUserError`（`toolUserErrors.ts:74-96`）保留原文的条件是「`mapGenericToolError` 不命中」+「`!containsInternalDetails(raw)`」+「`raw.length <= 240`（或 `<= 400` 且 `isIntentionalUserHint` 即含中文）」，否则回落 `defaultForTool(toolName)`（如 read_file 的「读取文件失败，请检查路径后重试」）导致 hint 丢失。增强后文案 `工具参数无效：${toolName} 缺少必填参数 path（注意字段名为 path，请勿使用 filePath 或 file_path）` 当前满足全部保留条件（无 `enoent/eisdir/eacces` 等关键字、无盘符 `[A-Za-z]:\\`/`node_modules`/`dist-electron` 等 `PATH_LIKE` 子串、长度约 55、含中文）-> **原样保留**。维护约束：**hint 文案须保持简短（<240 字符）、含中文、不得包含路径示例或绝对路径**（如 `C:\Users\foo`、`src/node_modules/x` 会触发 `containsInternalDetails` 被吞噬）；该不变量由 §5.5 回归断言守护。

### 4.4 修复项 4：系统提示 + 工具描述强调字段名

**4.4a 工具描述**（`src/shared/builtinToolDefinitions.ts`）：在 `read_file`/`edit_file`/`write_file`/`list_directory`/`grep` 的 `description` 末尾追加一句：

> 路径字段名为 path（小写），请勿使用 filePath 或 file_path。

（工具 `description` 面向 LLM 而非 UI，沿用现有中文单语描述风格，**不纳入 i18n 资源**——i18n 规范针对 UI 文案；如有 i18n 需求另议。）

**4.4b 系统提示**（`electron/llmSystemPrompt.ts`）：新增 locale 化 hint 并在 `buildFinalSystemPrompt` 注入（与 `buildImageAttachmentsSystemHint` 同范式）：

```ts
export function buildToolConventionHint(locale: AppLocale): string {
  if (locale === 'en-US') {
    return [
      '## Tool call conventions',
      'For file tools (read_file / edit_file / write_file / list_directory / grep), the path argument is named `path`. Do not use `filePath` or `file_path`.'
    ].join('\n')
  }
  return [
    '## 工具调用约定',
    '文件类工具（read_file / edit_file / write_file / list_directory / grep）的路径参数字段名为 `path`，请勿使用 `filePath` 或 `file_path`。'
  ].join('\n')
}
```

在 `buildFinalSystemPrompt` 中于 `appendUiLocaleSystemHint`（`:74`）之前**无条件**追加该 hint，且与前一段以 `\n\n` 空行分隔（与现有 artifact / workspace / image hint 的 `${withMemory}\n\n${hint}` 拼接范式一致）。提示已穷举 5 个文件类工具、不含 wechat，不会与 wechat 的合法 `filePath` 字段冲突。

> 文案统一：错误消息（§4.3）、工具描述（§4.4a）、系统提示（§4.4b）三处的禁用措辞统一为「filePath 或 file_path」（系统提示中字段名带反引号，纯文本错误消息不带），避免实现者各自措辞。

## 5. TDD - Red 阶段：先写失败测试

> 原则：每个测试先跑红（实现未改时失败），再改实现转绿。下面给出可直接粘贴的用例。

### 5.1 `electron/toolPathField.test.ts`（新文件，node 环境）

```ts
import { describe, expect, it } from 'vitest'
import { PATH_FIELD_ALIASES, extractPathField } from './toolPathField'

describe('extractPathField', () => {
  it('returns path when present', () => {
    expect(extractPathField({ path: 'src/a.ts' })).toBe('src/a.ts')
  })

  it('falls back to filePath', () => {
    expect(extractPathField({ filePath: 'src/a.ts' })).toBe('src/a.ts')
  })

  it('falls back to file_path', () => {
    expect(extractPathField({ file_path: 'src/a.ts' })).toBe('src/a.ts')
  })

  it('prefers path over aliases when multiple present', () => {
    expect(extractPathField({ path: 'p', filePath: 'fp', file_path: 'fp2' })).toBe('p')
  })

  it('prefers filePath over file_path', () => {
    expect(extractPathField({ filePath: 'fp', file_path: 'fp2' })).toBe('fp')
  })

  it('returns undefined when none present', () => {
    expect(extractPathField({})).toBeUndefined()
  })

  it('skips non-string values and continues to next alias', () => {
    expect(extractPathField({ path: 123, filePath: 'src/a.ts' })).toBe('src/a.ts')
  })

  it('treats empty string as missing', () => {
    expect(extractPathField({ path: '' })).toBeUndefined()
  })

  it('treats whitespace-only string as missing', () => {
    expect(extractPathField({ path: '   ' })).toBeUndefined()
  })

  it('exposes alias order for documentation', () => {
    expect([...PATH_FIELD_ALIASES]).toEqual(['path', 'filePath', 'file_path'])
  })
})
```

### 5.2 `electron/toolInputGuards.test.ts`（已存在，追加用例）

```ts
describe('assertSafeToolInput - path field aliases', () => {
  it('accepts read_file with filePath', () => {
    expect(() => assertSafeToolInput('read_file', { filePath: 'src/a.ts' })).not.toThrow()
  })

  it('accepts read_file with file_path', () => {
    expect(() => assertSafeToolInput('read_file', { file_path: 'src/a.ts' })).not.toThrow()
  })

  it('rejects read_file with no path-like field and hints the correct name', () => {
    expect(() => assertSafeToolInput('read_file', { offset: 1, limit: 10 })).toThrow(
      /缺少必填参数 path.*请勿使用 filePath 或 file_path/
    )
  })

  it('rejects read_file alias too long', () => {
    expect(() => assertSafeToolInput('read_file', { filePath: 'x'.repeat(8193) })).toThrow(/过长/)
  })

  it('accepts list_directory with filePath', () => {
    expect(() => assertSafeToolInput('list_directory', { filePath: 'src' })).not.toThrow()
  })

  it('accepts list_directory with no path (still optional)', () => {
    expect(() => assertSafeToolInput('list_directory', {})).not.toThrow()
  })

  it('accepts grep with file_path', () => {
    expect(() => assertSafeToolInput('grep', { pattern: 'x', file_path: 'src' })).not.toThrow()
  })

  it('accepts edit_file with filePath', () => {
    expect(() =>
      assertSafeToolInput('edit_file', { filePath: 'a.txt', old_string: 'a', new_string: 'b' })
    ).not.toThrow()
  })

  it('accepts write_file with file_path', () => {
    expect(() =>
      assertSafeToolInput('write_file', { file_path: 'a.txt', content: 'hi' })
    ).not.toThrow()
  })

  it('rejects edit_file with no path-like field and hints the correct name', () => {
    expect(() =>
      assertSafeToolInput('edit_file', { old_string: 'a', new_string: 'b' })
    ).toThrow(/缺少必填参数 path.*请勿使用 filePath 或 file_path/)
  })

  it('rejects write_file with no path-like field and hints the correct name', () => {
    expect(() => assertSafeToolInput('write_file', { content: 'hi' })).toThrow(
      /缺少必填参数 path.*请勿使用 filePath 或 file_path/
    )
  })
})
```

> 既有用例（如 `rejects edit_file missing path`）需同步断言新文案仍含 `缺少必填参数 path`（已兼容，无需改）。正则统一匹配「filePath 或 file_path」（与 §4.3 文案一致），勿用斜杠 `/`。

### 5.3 `electron/tools/builtinExecutors.pathAlias.test.ts`（新文件，node 环境，照搬 `fileState.test.ts` 的 `makeCtx`/`tmpDir` 范式）

```ts
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileStateCache } from '../fileStateCache'
import { DEFAULT_TOOLS_CONFIG } from '../../src/shared/domainTypes'
import type { ToolExecutionContext } from './types'
import {
  editFileExecutor,
  grepExecutor,
  listDirectoryExecutor,
  readFileExecutor,
  writeFileExecutor
} from './builtinExecutors'

function makeCtx(workDir: string, cache: FileStateCache): ToolExecutionContext {
  return {
    workDir,
    userDataDir: path.join(workDir, '.userdata'),
    requestId: 'req-test',
    toolUseId: 'tool-test',
    sessionId: 'session-test',
    sendProgress: vi.fn(),
    signal: AbortSignal.timeout(30_000),
    fileStateCache: cache,
    toolsConfig: { ...DEFAULT_TOOLS_CONFIG, fileCheckpointingEnabled: false }
  }
}

describe('path field alias normalization', () => {
  let tmpDir: string
  let cache: FileStateCache

  beforeEach(async () => {
    tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sa-path-alias-')))
    cache = new FileStateCache()
  })
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('read_file accepts filePath', async () => {
    const rel = 'a.txt'
    await fs.writeFile(path.join(tmpDir, rel), 'hello', 'utf8')
    const res = await readFileExecutor.execute({ filePath: rel }, makeCtx(tmpDir, cache))
    expect(res.success).toBe(true)
    expect(String(res.data?.content)).toBe('hello')
  })

  it('read_file accepts file_path', async () => {
    const rel = 'a.txt'
    await fs.writeFile(path.join(tmpDir, rel), 'world', 'utf8')
    const res = await readFileExecutor.execute({ file_path: rel }, makeCtx(tmpDir, cache))
    expect(res.success).toBe(true)
    expect(String(res.data?.content)).toBe('world')
  })

  it('read_file with no path-like field returns clear missing-path error (not “路径是目录而非文件: ”)', async () => {
    const res = await readFileExecutor.execute({}, makeCtx(tmpDir, cache))
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/缺少必填参数 path/)
    expect(res.error).toMatch(/请勿使用 filePath 或 file_path/)
    expect(res.error).not.toMatch(/路径是目录而非文件/)
  })

  it('edit_file accepts filePath', async () => {
    const rel = 'a.txt'
    await fs.writeFile(path.join(tmpDir, rel), 'alpha beta', 'utf8')
    const res = await editFileExecutor.execute(
      { filePath: rel, old_string: 'alpha', new_string: 'ALPHA' },
      makeCtx(tmpDir, cache)
    )
    expect(res.success).toBe(true)
    expect(await fs.readFile(path.join(tmpDir, rel), 'utf8')).toBe('ALPHA beta')
  })

  it('edit_file with no path-like field returns hinted missing-path error', async () => {
    const res = await editFileExecutor.execute(
      { old_string: 'a', new_string: 'b' },
      makeCtx(tmpDir, cache)
    )
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/缺少必填参数 path/)
    expect(res.error).toMatch(/请勿使用 filePath 或 file_path/)
  })

  it('write_file accepts file_path', async () => {
    const rel = 'out.txt'
    const res = await writeFileExecutor.execute(
      { file_path: rel, content: 'hi' },
      makeCtx(tmpDir, cache)
    )
    expect(res.success).toBe(true)
    expect(await fs.readFile(path.join(tmpDir, rel), 'utf8')).toBe('hi')
  })

  it('write_file with no path-like field returns hinted missing-path error', async () => {
    const res = await writeFileExecutor.execute({ content: 'hi' }, makeCtx(tmpDir, cache))
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/缺少必填参数 path.*请勿使用 filePath 或 file_path/)
  })

  it('list_directory accepts filePath', async () => {
    await fs.writeFile(path.join(tmpDir, 'a.txt'), 'x', 'utf8')
    const res = await listDirectoryExecutor.execute({ filePath: '.' }, makeCtx(tmpDir, cache))
    expect(res.success).toBe(true)
  })

  it('list_directory with no path-like field defaults to workDir root', async () => {
    await fs.writeFile(path.join(tmpDir, 'a.txt'), 'x', 'utf8')
    const res = await listDirectoryExecutor.execute({}, makeCtx(tmpDir, cache))
    expect(res.success).toBe(true)
    // 默认 '.' -> 列工作目录根，应能看到刚写入的 a.txt（data 形如 { entries: [{ name, ... }] }）
    expect(String(res.data)).toMatch(/a\.txt/)
  })

  it('grep accepts file_path', async () => {
    await fs.writeFile(path.join(tmpDir, 'a.txt'), 'needle here', 'utf8')
    const res = await grepExecutor.execute(
      { pattern: 'needle', file_path: '.' },
      makeCtx(tmpDir, cache)
    )
    expect(res.success).toBe(true)
  })

  // -- 回归：原 path 字段仍可用 --
  it('read_file still works with canonical path', async () => {
    const rel = 'a.txt'
    await fs.writeFile(path.join(tmpDir, rel), 'ok', 'utf8')
    const res = await readFileExecutor.execute({ path: rel }, makeCtx(tmpDir, cache))
    expect(res.success).toBe(true)
  })
})
```

> 执行器导出名已核实：`readFileExecutor`/`listDirectoryExecutor`/`editFileExecutor`/`writeFileExecutor`/`grepExecutor`（均见 `builtinExecutors.ts`）。edit_file/write_file 缺参分支用例补齐了原计划缺口，确保 `toolErrMissingPath` 增强后两层文案一致可被测试捕获。

### 5.4 修复项 4 的测试

**5.4a 工具描述**（新建 `src/shared/builtinToolDefinitions.test.ts`，与现有 `builtinToolDefinitions.artifact.test.ts` 并列；走 vitest 默认 jsdom 环境，纯数据断言无 DOM 依赖）：

```ts
import { describe, expect, it } from 'vitest'
import { BUILTIN_TOOL_DEFINITIONS } from './builtinToolDefinitions'

describe('file-tool descriptions hint the path field name', () => {
  const fileTools = ['read_file', 'edit_file', 'write_file', 'list_directory', 'grep']
  for (const name of fileTools) {
    it(`${name} description mentions canonical field name and forbids aliases`, () => {
      const def = BUILTIN_TOOL_DEFINITIONS.find((d) => d.name === name)
      expect(def).toBeDefined()
      expect(def!.description).toMatch(/path/)
      // 明确「请勿使用」语义，而非仅出现别名（避免误写成「可使用 filePath」也能通过）
      expect(def!.description).toMatch(/请勿使用 filePath 或 file_path/)
    })
  }
})
```

> `BUILTIN_TOOL_DEFINITIONS`（`builtinToolDefinitions.ts:38` 导出）为目标数组；目标只是断言描述里包含字段名提示。

**5.4b 系统提示**（`electron/llmSystemPrompt.test.ts` 已存在，追加用例；走 node 环境）：

```ts
import { describe, expect, it } from 'vitest'
import { buildFinalSystemPrompt } from './llmSystemPrompt'

describe('buildFinalSystemPrompt - tool convention hint', () => {
  // 传入非空 system，确保 toolConventionHint 拼接时前面有 \n\n 空行分隔可被断言
  const baseArgs = { system: '你是一个助手。', memoryContent: null, memoryEnabled: false }

  it('zh-CN includes path field convention, separated by blank line', () => {
    const prompt = buildFinalSystemPrompt({ ...baseArgs, locale: 'zh-CN' })
    expect(prompt).toMatch(/工具调用约定/)
    expect(prompt).toMatch(/字段名为 `path`/)
    // hint 与前文以空行分隔（与 artifact/workspace/image hint 拼接范式一致）
    expect(prompt).toMatch(/\n\n## 工具调用约定/)
  })

  it('en-US includes path field convention, separated by blank line', () => {
    const prompt = buildFinalSystemPrompt({ ...baseArgs, locale: 'en-US' })
    expect(prompt).toMatch(/Tool call conventions/)
    expect(prompt).toMatch(/named `path`/)
    expect(prompt).toMatch(/\n\n## Tool call conventions/)
  })
})
```

> 空行分隔断言用于捕获「拼接时漏了 `\n\n`」或「位置写到其它 hint 之前导致格式错乱」等实现偏差。`system` 传非空值以确保 hint 非首段；若实现将 hint 置于 `appendUiLocaleSystemHint` 之后，locale 后缀与 hint 的相对顺序也会因 `\n\n` 缺失而暴露。

### 5.5 `electron/toolInputGuards.test.ts`（追加：sanitize 透传 hint 的回归断言）

> 守护 §4.3 行为变更说明 3 的隐性约束：确保 `toolErrMissingPath` 文案经 `sanitizeToolErrorString` 后**仍带 hint 到达模型**，而非被 `defaultForTool` 吞噬。§5.2/§5.3 断言的是 guard 抛错 / 执行器返回的 `result.error`（**sanitize 之前**），无法捕获「sanitize 之后 hint 丢失」；本节直接对 sanitize 输出断言，把不变量固化。若未来有人给 hint 加路径示例（触发 `containsInternalDetails`）或拉长到 >240/400 字符，本用例即转红。

在 `toolInputGuards.test.ts` 顶部补一行 import，并追加 describe 块：

```ts
import { sanitizeToolErrorString } from './tools/toolUserErrors'
import { toolErrMissingPath } from './toolInputGuards' // 与既有 assertSafeToolInput import 合并

describe('toolErrMissingPath hint survives sanitizeToolErrorString', () => {
  const fileTools = ['read_file', 'edit_file', 'write_file'] as const
  for (const toolName of fileTools) {
    it(`${toolName} missing-path hint reaches model after sanitize`, () => {
      const sanitized = sanitizeToolErrorString(toolErrMissingPath(toolName), toolName)
      // 不得回落到 defaultForTool（如 read_file 的「读取文件失败，请检查路径后重试」）
      expect(sanitized).toMatch(/缺少必填参数 path/)
      expect(sanitized).toMatch(/请勿使用 filePath 或 file_path/)
    })
  }
})
```

> 选 read_file/edit_file/write_file 三者：它们是「缺 path 会报 hint」的工具（list_directory/grep 的 path 可选，缺时不报错、无 hint 文案可验）。`sanitizeToolErrorString` 导出于 `electron/tools/toolUserErrors.ts:98`。

## 6. TDD - Green 阶段：实现顺序

> 每步做完立即跑对应测试转绿，再做下一步。

1. **新建 `electron/toolPathField.ts`**：实现 `extractPathField` + `PATH_FIELD_ALIASES`（§4.1）。
   - 跑 `toolPathField.test.ts` -> 绿。
2. **改 `electron/toolInputGuards.ts`**：**就地增强 `toolErrMissingPath`**（尾部追加 hint，**不新增并列函数**），按 §4.3 表改 5 个 case。
   - 跑 `toolInputGuards.test.ts`（含 §5.2 新用例 + §5.5 sanitize 透传断言）-> 绿。
   - 注意：此步后 edit_file/write_file 执行器 `:446` / `:548` 现存调用自动获得带 hint 文案，无需改 import 或调用名。
   - 注意：read_file case **仅替换 path 校验**为 `extractPathField` + 必填断言，`offset`/`limit`（`optPositiveInt`，`:52-53`）分支保持原样，勿误删。
3. **改 `electron/tools/builtinExecutors.ts`**：5 个执行器按 §4.2 把读 path 改为 `extractPathField`；edit_file/write_file 缺参分支保持 `toolErrMissingPath(...)` 调用不变（函数已增强）。
   - 跑 `builtinExecutors.pathAlias.test.ts`（含新增 edit_file/write_file 缺参用例）与既有 `builtinExecutors.fileState.test.ts`/`builtinExecutors.wiki.test.ts`/`builtinExecutors.autoApprove.test.ts` -> 全绿。
4. **改 `src/shared/builtinToolDefinitions.ts`**：5 个工具描述追加字段名提示（§4.4a）。
   - 跑描述测试 -> 绿。
5. **改 `electron/llmSystemPrompt.ts`**：加 `buildToolConventionHint` 并在 `buildFinalSystemPrompt` 于 `appendUiLocaleSystemHint` 之前注入（§4.4b，`\n\n` 分隔）。
   - 跑 `llmSystemPrompt.test.ts` -> 绿。

## 7. 验收与回归

- **单测**：`npm test`，重点文件：
  - `electron/toolPathField.test.ts`（新建）
  - `electron/toolInputGuards.test.ts`（追加）
  - `electron/tools/builtinExecutors.pathAlias.test.ts`（新建）
  - `electron/tools/builtinExecutors.fileState.test.ts`（回归）
  - `src/shared/builtinToolDefinitions.test.ts`（新建）
  - `electron/llmSystemPrompt.test.ts`（追加）
- **类型**：`npm run build:electron` 与 `npm run build:renderer` 通过。
- **i18n 校验**：本计划未动 i18n 资源（工具 description 面向 LLM 不纳入 i18n，系统提示文案在代码内），`npm run i18n:check` 跳过。
- **行为变更排查**：
  - **read_file 改必填**（§4.3）：`grep -rn "readFileExecutor.execute\|execute.*read_file" electron/ src/` 确认无内部调用方在无 path 下调用；检查 `builtinExecutors.*.test.ts`、`readFileRange.test.ts` 是否有 `{}` 入参的 read_file 调用，按需补 path。
  - **空串 / 纯空白路径行为变更**（§4.2）：`grep -rn "path: ''\|path: '   '" electron/ src/` 确认无内部夹具依赖「空串 = workDir」或「空白路径报错」的旧语义；list_directory/grep 的默认值 `.` / `''` 行为已由 `??` 保留。
- **端到端回归**（手工/日志验证）：用 `deepseek-v4-pro` 复现「read_file 传 `filePath`」场景，确认：
  1. 不再返回 `路径是目录而非文件: 。请使用 list_directory…`，而是正常读到文件；
  2. 不再触发 `同一工具错误已连续出现 3 次` 中止；
  3. 用户不再看到「回复未能完成」。
  - 复现后查 `.agent/logs/Agent-{YYYYmmdd}.log`：`tool.error` 中 `路径是目录而非文件: 。` 条目应消失，`llm.error` 中 `同一工具错误已连续出现` 条目应消失。
  - **范围限定（A4）**：上述「不再中止」针对的是**别名误用**场景（`filePath`/`file_path` 被归一化、缺参时拿到带 hint 的清晰错误，模型一次纠错即通过）。若模型**完全不用**任何 path 类字段，guard 抛出的缺参错误同样走 `noteFailure`（`toolChatLoop.ts:855-856`），连续 3 次相同 `(toolName, userMsg)` 仍会 `abortRepeatedToolError` -- 此属「模型完全缺参」的另一类问题，不在本修复范围（归修复项 3，见 §8）。验收时勿把该场景的偶发中止误判为本修复回归。

## 8. 风险与取舍

- **read_file 改必填**：与 schema 对齐，但属行为变更。已在 §7 列排查项；若发现强依赖「无 path = 读工作目录」的内部路径，回退为「可选但空时报清晰缺参错误」。
- **空串 / 纯空白路径行为变更**：`extractPathField` 将空串与纯空白视为缺失，使 list_directory/grep 在此类入参下走默认值而非报错。属合理化但需 PR 点明（§7 已列排查）。
- **wechat `filePath` 撞名**：`filePath` 既是文件工具的 path 别名，又是 wechat_reply/wechat_send 的合法「待发送文件路径」字段。当前无串扰（执行器按 toolName 分发，wechat 不走 `readFileExecutor`；guard 对 wechat 走 `default` 不校验 path）。但 `extractPathField` 是通用函数，**严禁**用于 wechat 工具入参（已在 §4.1 JSDoc 限定）；若后续按下方「集中式归一化备选」把别名归一化下沉到 merge 层，必须在 `coalesceToolUseInputs` 内按 toolName 白名单处理，避免污染 wechat 的 `filePath`。系统提示 §4.4b 已穷举 5 个文件类工具、排除 wechat，不会让模型困惑。
- **别名集合**：仅支持 `path`/`filePath`/`file_path`。如日志未来出现其它变体（如 `filepath`、`Path`），追加到 `PATH_FIELD_ALIASES` 即可，单点扩展。
- **hint 文案 sanitize 透传（A1）**：修复项 2 的 hint 能否到达模型，依赖 `sanitizeToolErrorString` 的保留行为（详见 §4.3 行为变更说明 3）。当前文案 sanitize-safe（原样保留），但属隐性约束：若后续维护者给 hint 加路径示例（触发 `containsInternalDetails`）或拉长到 >240/400 字符，hint 会被 `defaultForTool` 静默吞噬、且不被 §5.2/§5.3 捕获。已由 §5.5 回归断言固化为测试守护；改动 hint 文案时须同步确认该断言仍绿。
- **未做修复项 3**（放宽重复错误计数器）：本计划按用户要求只含 1+2+4。若 1+2 落地后仍偶发中止，再单独立项做 3（区分「输入型错误」与「执行型错误」、跨轮 `noteSuccess` 重置策略）。注意：guard 缺参错误亦走 `noteFailure`（`toolChatLoop.ts:855-856`），故修复项 1+2 消除的是「别名误用导致的中止」；模型**完全不用** path 类字段时仍可能因连续缺参 abort，该场景不在本修复范围（属修复项 3）。
- **系统提示长度**：`buildToolConventionHint` 仅两行，对 token 用量影响可忽略；无条件注入（不依赖 memory/image 等开关），保证始终生效。
- **集中式归一化备选**：亦可把别名归一化下沉到 `coalesceToolUseInputs`（`toolUseInputMerge.ts:35-55`）单点完成——在其 `ensureString` 前先做 `path ← filePath/file_path` 归一化（按 toolName 白名单，仅对 5 个文件类工具），使 guard/执行器都只认 `path`。注意改造点是 `coalesceToolUseInputs`（按 toolName 合并字段），**不是** `normalizeToolUseInputRecord`（后者仅浅拷贝/JSON 解析，不按 toolName 处理）。本计划选择「显式 helper + 双侧调用」是为了让单测可分别覆盖校验层与执行层，且不依赖上游是否一定走 merge 路径。两种方案二选一即可，勿叠加。
