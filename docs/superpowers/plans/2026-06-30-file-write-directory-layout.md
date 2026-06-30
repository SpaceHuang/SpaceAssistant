# 文件写入目录规范 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增可选的"目录规范"设置：开启后按"扩展名→子目录"映射把 Agent 新建文件重定向到约定子目录，并在每会话首次写入前确认写入目录。

**Architecture:** 三条主线——①配置 `WorkspaceLayoutConfig`（`AppConfig.workspaceLayout`）；②会话级确认流（独立 IPC + 注册表挂起，照 `toolConfirmRegistry` 模式），状态存 `Session.metadata.writeDirChoice`；③重定向 Hook（`toolChatLoop` 在 `exec.execute` 前调纯函数 `applyWorkspaceLayoutRedirect`，改写 `input.path` 并在 `tool_result` 注明，系统提示强化）。防穿越铁律：LLM 的 `input.path` 只取 `basename`+`extname`，目录部分丢弃，落点 100% 由用户配置决定。

**Tech Stack:** Electron（主进程 Node.js / CommonJS）、React 18 + Ant Design 5 + Redux Toolkit、Vitest（node 与 jsdom 双环境）、`src/shared/domainTypes.ts` 为类型唯一来源。

**关联规格：** [`docs/requirement/file-write-directory-layout-requirement.md`](../../requirement/file-write-directory-layout-requirement.md)

---

## 文件结构

### 新增文件

| 文件 | 责任 | 依赖 |
|------|------|------|
| `electron/workspaceLayout/redirect.ts` | 纯函数：给定 input/workDir/writeDirChoice/映射，计算规范路径与改写结果 | `pathSecurity` |
| `electron/workspaceLayout/redirect.test.ts` | 重定向单测（防穿越、扩展名匹配、作用域、拒绝） | — |
| `electron/workspaceLayout/writeDirCandidates.ts` | 三源合并去重、字母分配、上限截断 | `pathSecurity` |
| `electron/workspaceLayout/writeDirCandidates.test.ts` | 候选目录单测 | — |
| `electron/workspaceLayout/writeDirConfirmRegistry.ts` | 确认流 Promise 挂起 + IPC resolve + 超时（照 `toolConfirmRegistry` 模式） | — |
| `electron/workspaceLayout/writeDirConfirmRegistry.test.ts` | 注册表单测 | — |
| `electron/workspaceLayout/sessionWriteDir.ts` | 读写 `Session.metadata.writeDirChoice` + workDir 切换清空 | DB |
| `electron/toolChatLoop.workspaceLayout.test.ts` | 集成测试 | — |
| `src/renderer/components/Config/WorkspaceLayoutTab.tsx` | 设置 Tab：开关 + 映射表 | Ant Design |
| `src/renderer/components/Config/WorkspaceLayoutTab.test.tsx` | Tab 测试 | — |
| `src/renderer/components/Chat/WriteDirConfirmPanel.tsx` | A-Z 单选 + 自定义输入面板 | Ant Design |
| `src/renderer/components/Chat/WriteDirConfirmPanel.test.tsx` | 面板测试 | — |

### 修改文件

| 文件 | 改动 |
|------|------|
| `src/shared/domainTypes.ts` | 新增 `WorkspaceLayoutConfig` 等类型与 merge；`AppConfig` 增 `workspaceLayout` |
| `electron/toolChatLoop.ts` | 在 `exec.execute` 前接入重定向；衔接 conflict/claim 用 newPath；注入 tool_result；强化系统提示 |
| `electron/llmSystemPrompt.ts` | `buildFinalSystemPrompt` 增 `workspaceLayoutHint` 参数 |
| `electron/preload.ts` | 新增 `fileWriteDirOnConfirmRequest` / `fileWriteDirConfirmResponse` |
| `electron/appIpc.ts` | 新增 `file-write-dir:confirm-response` handler |
| `src/shared/api.ts` | 新增确认请求/响应类型 |
| `src/renderer/components/Config/configModalSnapshot.ts` | snapshot 纳入 `workspaceLayout` |
| `src/renderer/store/configSlice.ts` | `ToolsSettingsSubTab` 加 `'workspaceLayout'` |
| `src/renderer/components/Config/toolsSettingsNav.ts` | 新增 nav 项 |
| `src/renderer/components/Config/ConfigModal.tsx` | 渲染 WorkspaceLayoutTab |
| `src/renderer/i18n/resources/zh-CN/` | 新增 key |

---

## 阶段划分

- **Phase 1（Task 1-3）：** 配置类型 + 重定向核心（纯函数，可独立测，workDir 兜底即有可用重定向）
- **Phase 2（Task 4-6）：** 候选目录 + 确认注册表
- **Phase 3（Task 7-8）：** toolChatLoop 接入重定向（含 workDir 兜底路径，先不接确认流）
- **Phase 4（Task 9-11）：** 确认流 IPC + 面板 + toolChatLoop 接入确认流
- **Phase 5（Task 12-13）：** 系统提示强化 + workDir 切换清空
- **Phase 6（Task 14-16）：** 设置 Tab + i18n + 快照
- **Phase 7（Task 17）：** 只读 chip
- **Phase 8（Task 18）：** 集成测试 + 安全回归

---

## Task 1: 配置类型与合并函数

**Files:**
- Modify: `src/shared/domainTypes.ts`（在 `WikiConfig` 区块之后、`FilePaneSectionUiState` 之前插入）

- [ ] **Step 1: 编写失败测试**

创建 `src/shared/domainTypes.workspaceLayout.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import {
  DEFAULT_WORKSPACE_LAYOUT_CONFIG,
  mergeWorkspaceLayoutConfig
} from './domainTypes'

describe('WorkspaceLayoutConfig', () => {
  it('returns defaults for null/undefined', () => {
    expect(mergeWorkspaceLayoutConfig(null)).toEqual(DEFAULT_WORKSPACE_LAYOUT_CONFIG)
    expect(mergeWorkspaceLayoutConfig(undefined)).toEqual(DEFAULT_WORKSPACE_LAYOUT_CONFIG)
  })

  it('merges partial and deep-copies extensionSubdirMap', () => {
    const merged = mergeWorkspaceLayoutConfig({ enabled: true })
    expect(merged.enabled).toBe(true)
    expect(merged.writeDirConfirmEnabled).toBe(true)
    expect(merged.extensionSubdirMap).not.toBe(DEFAULT_WORKSPACE_LAYOUT_CONFIG.extensionSubdirMap)
    expect(merged.extensionSubdirMap[0]).toEqual({ extension: 'py', subdir: 'Script' })
  })

  it('uses provided extensionSubdirMap entries', () => {
    const merged = mergeWorkspaceLayoutConfig({
      extensionSubdirMap: [{ extension: 'rs', subdir: 'src' }]
    })
    expect(merged.extensionSubdirMap).toEqual([{ extension: 'rs', subdir: 'src' }])
  })

  it('defaults to empty array when extensionSubdirMap is null', () => {
    const merged = mergeWorkspaceLayoutConfig({ extensionSubdirMap: null })
    expect(merged.extensionSubdirMap).toEqual([])
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/shared/domainTypes.workspaceLayout.test.ts`
Expected: FAIL（`DEFAULT_WORKSPACE_LAYOUT_CONFIG` 未定义）

- [ ] **Step 3: 实现类型与合并函数**

在 `src/shared/domainTypes.ts` 中（`mergeWikiConfig` 之后）插入：

```ts
export interface ExtensionSubdirMapEntry {
  /** 不含点，小写，如 "py"、"md" */
  extension: string
  /** 单层名，如 "Script"、"Docs"；不含路径分隔符 */
  subdir: string
}

export interface WorkspaceLayoutConfig {
  /** 总开关，默认 false */
  enabled: boolean
  /** 首次写入前确认写入目录（仅 enabled 为 true 时生效），默认 true */
  writeDirConfirmEnabled: boolean
  /** 扩展名 → 子目录映射 */
  extensionSubdirMap: ExtensionSubdirMapEntry[]
}

export const DEFAULT_WORKSPACE_LAYOUT_CONFIG: WorkspaceLayoutConfig = {
  enabled: false,
  writeDirConfirmEnabled: true,
  extensionSubdirMap: [
    { extension: 'py', subdir: 'Script' },
    { extension: 'js', subdir: 'Script' },
    { extension: 'ts', subdir: 'Script' },
    { extension: 'tsx', subdir: 'Script' },
    { extension: 'jsx', subdir: 'Script' },
    { extension: 'sh', subdir: 'Script' },
    { extension: 'md', subdir: 'Docs' },
    { extension: 'json', subdir: 'Config' }
  ]
}

export function mergeWorkspaceLayoutConfig(
  partial?: Partial<WorkspaceLayoutConfig> | null
): WorkspaceLayoutConfig {
  if (!partial || typeof partial !== 'object') {
    return {
      ...DEFAULT_WORKSPACE_LAYOUT_CONFIG,
      extensionSubdirMap: [...DEFAULT_WORKSPACE_LAYOUT_CONFIG.extensionSubdirMap]
    }
  }
  return {
    ...DEFAULT_WORKSPACE_LAYOUT_CONFIG,
    ...partial,
    extensionSubdirMap: Array.isArray(partial.extensionSubdirMap)
      ? partial.extensionSubdirMap.map((e) => ({ ...e }))
      : partial.extensionSubdirMap === null
        ? []
        : [...DEFAULT_WORKSPACE_LAYOUT_CONFIG.extensionSubdirMap]
  }
}
```

- [ ] **Step 4: 在 `AppConfig` 接口加入字段**

在 `src/shared/domainTypes.ts` 的 `AppConfig` 接口中（`shell: ShellConfig` 之后）加：

```ts
  shell: ShellConfig
  workspaceLayout: WorkspaceLayoutConfig
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run src/shared/domainTypes.workspaceLayout.test.ts`
Expected: PASS

- [ ] **Step 6: 修复 AppConfig 构造点**

搜索所有构造 `AppConfig` 对象字面量的位置（含默认配置、DB 迁移、测试夹具），补 `workspaceLayout: mergeWorkspaceLayoutConfig(...)` 或 `workspaceLayout: { ...DEFAULT_WORKSPACE_LAYOUT_CONFIG }`。

Run: `npx tsc -p tsconfig.electron.json --noEmit`
Expected: 无 `workspaceLayout` 缺失错误。若报错，按报错位置逐一补字段。

- [ ] **Step 7: 提交**

```bash
git add src/shared/domainTypes.ts src/shared/domainTypes.workspaceLayout.test.ts
git commit -m "feat(workspaceLayout): add WorkspaceLayoutConfig type and merge"
```

---

## Task 2: 重定向核心 — 防穿越与扩展名匹配

**Files:**
- Create: `electron/workspaceLayout/redirect.ts`
- Test: `electron/workspaceLayout/redirect.test.ts`

- [ ] **Step 1: 编写失败测试（防穿越 + 扩展名匹配 + 作用域）**

创建 `electron/workspaceLayout/redirect.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import path from 'path'
import fs from 'fs/promises'
import os from 'os'
import { applyWorkspaceLayoutRedirect } from './redirect'
import type { WorkspaceLayoutConfig } from '../../src/shared/domainTypes'

const ENABLED: WorkspaceLayoutConfig = {
  enabled: true,
  writeDirConfirmEnabled: true,
  extensionSubdirMap: [{ extension: 'py', subdir: 'Script' }, { extension: 'md', subdir: 'Docs' }]
}

async function withTempWorkDir<T>(fn: (workDir: string) => Promise<T>): Promise<T> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wsl-'))
  try {
    return await fn(tmp)
  } finally {
    await fs.rm(tmp, { recursive: true, force: true })
  }
}

describe('applyWorkspaceLayoutRedirect', () => {
  it('bypasses when disabled', async () => {
    await withTempWorkDir(async (workDir) => {
      const out = await applyWorkspaceLayoutRedirect({
        toolName: 'write_file',
        input: { path: 'foo.py', content: '' },
        workDir,
        sessionId: 's1',
        workspaceLayout: { ...ENABLED, enabled: false },
        writeDirChoice: { dir: workDir }
      })
      expect(out.redirected).toBe(false)
      expect(out.newPath).toBeUndefined()
    })
  })

  it('skips edit_file', async () => {
    await withTempWorkDir(async (workDir) => {
      const out = await applyWorkspaceLayoutRedirect({
        toolName: 'edit_file',
        input: { path: 'foo.py', old_string: 'a', new_string: 'b' },
        workDir,
        sessionId: 's1',
        workspaceLayout: ENABLED,
        writeDirChoice: { dir: workDir }
      })
      expect(out.redirected).toBe(false)
    })
  })

  it('redirects new py file into Script subdir', async () => {
    await withTempWorkDir(async (workDir) => {
      const out = await applyWorkspaceLayoutRedirect({
        toolName: 'write_file',
        input: { path: 'foo.py', content: '' },
        workDir,
        sessionId: 's1',
        workspaceLayout: ENABLED,
        writeDirChoice: { dir: workDir }
      })
      expect(out.redirected).toBe(true)
      expect(out.newPath).toBe(path.join('Script', 'foo.py').replace(/\\/g, '/'))
    })
  })

  it('discards traversal and keeps only basename', async () => {
    await withTempWorkDir(async (workDir) => {
      const out = await applyWorkspaceLayoutRedirect({
        toolName: 'write_file',
        input: { path: '..\\..\\evil.py', content: '' },
        workDir,
        sessionId: 's1',
        workspaceLayout: ENABLED,
        writeDirChoice: { dir: workDir }
      })
      expect(out.redirected).toBe(true)
      expect(out.newPath).toBe(path.join('Script', 'evil.py').replace(/\\/g, '/'))
    })
  })

  it('rejects absolute path input by treating as basename only (no escape)', async () => {
    await withTempWorkDir(async (workDir) => {
      const out = await applyWorkspaceLayoutRedirect({
        toolName: 'write_file',
        input: { path: '/etc/passwd.py', content: '' },
        workDir,
        sessionId: 's1',
        workspaceLayout: ENABLED,
        writeDirChoice: { dir: workDir }
      })
      expect(out.redirected).toBe(true)
      expect(out.newPath).toBe(path.join('Script', 'passwd.py').replace(/\\/g, '/'))
    })
  })

  it('unmapped extension falls to root of writeDir', async () => {
    await withTempWorkDir(async (workDir) => {
      const out = await applyWorkspaceLayoutRedirect({
        toolName: 'write_file',
        input: { path: 'deep/notes.log', content: '' },
        workDir,
        sessionId: 's1',
        workspaceLayout: ENABLED,
        writeDirChoice: { dir: workDir }
      })
      expect(out.redirected).toBe(true)
      expect(out.newPath).toBe('notes.log')
    })
  })

  it('is case-insensitive on extension', async () => {
    await withTempWorkDir(async (workDir) => {
      const out = await applyWorkspaceLayoutRedirect({
        toolName: 'write_file',
        input: { path: 'FOO.PY', content: '' },
        workDir,
        sessionId: 's1',
        workspaceLayout: ENABLED,
        writeDirChoice: { dir: workDir }
      })
      expect(out.newPath).toBe(path.join('Script', 'FOO.PY').replace(/\\/g, '/'))
    })
  })

  it('uses last extension (a.py.bak -> bak)', async () => {
    await withTempWorkDir(async (workDir) => {
      const out = await applyWorkspaceLayoutRedirect({
        toolName: 'write_file',
        input: { path: 'a.py.bak', content: '' },
        workDir,
        sessionId: 's1',
        workspaceLayout: ENABLED,
        writeDirChoice: { dir: workDir }
      })
      expect(out.newPath).toBe('a.py.bak')
    })
  })

  it('does not redirect when target file already exists', async () => {
    await withTempWorkDir(async (workDir) => {
      await fs.mkdir(path.join(workDir, 'sub'), { recursive: true })
      await fs.writeFile(path.join(workDir, 'sub', 'exists.py'), 'x')
      const out = await applyWorkspaceLayoutRedirect({
        toolName: 'write_file',
        input: { path: 'sub/exists.py', content: 'y' },
        workDir,
        sessionId: 's1',
        workspaceLayout: ENABLED,
        writeDirChoice: { dir: workDir }
      })
      expect(out.redirected).toBe(false)
    })
  })

  it('rejects basename equal to .. or containing separators', async () => {
    await withTempWorkDir(async (workDir) => {
      const out = await applyWorkspaceLayoutRedirect({
        toolName: 'write_file',
        input: { path: '..', content: '' },
        workDir,
        sessionId: 's1',
        workspaceLayout: ENABLED,
        writeDirChoice: { dir: workDir }
      })
      expect(out.reject).toBe(true)
      expect(out.rejectReason).toBeTruthy()
    })
  })

  it('does not attach reason when already compliant', async () => {
    await withTempWorkDir(async (workDir) => {
      const out = await applyWorkspaceLayoutRedirect({
        toolName: 'write_file',
        input: { path: 'Script/foo.py', content: '' },
        workDir,
        sessionId: 's1',
        workspaceLayout: ENABLED,
        writeDirChoice: { dir: workDir }
      })
      expect(out.redirected).toBe(false)
      expect(out.reason).toBeUndefined()
    })
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run electron/workspaceLayout/redirect.test.ts`
Expected: FAIL（`applyWorkspaceLayoutRedirect` 未定义）

- [ ] **Step 3: 实现 redirect.ts**

创建 `electron/workspaceLayout/redirect.ts`：

```ts
import path from 'path'
import fs from 'fs/promises'
import { resolveSafePath, resolveSafePathReal, normalizeRelPathInput } from '../pathSecurity'
import type { WorkspaceLayoutConfig } from '../../src/shared/domainTypes'

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i

export interface RedirectOutcome {
  redirected: boolean
  newPath?: string
  originalPath?: string
  reason?: string
  reject?: boolean
  rejectReason?: string
}

export interface RedirectArgs {
  toolName: string
  input: Record<string, unknown>
  workDir: string
  sessionId: string
  workspaceLayout: WorkspaceLayoutConfig
  writeDirChoice: { dir: string } | null
}

function sanitizeBasename(basename: string): string | null {
  const b = basename.trim()
  if (!b || b === '.' || b === '..') return null
  if (b.includes('/') || b.includes('\\')) return null
  if (b.includes('\0')) return null
  if (WINDOWS_RESERVED.test(b)) return null
  return b
}

function extOf(filePath: string): string {
  const ext = path.extname(filePath).slice(1).toLowerCase()
  return ext
}

function lookupSubdir(map: WorkspaceLayoutConfig['extensionSubdirMap'], ext: string): string {
  if (!ext) return ''
  for (const e of map) {
    if (e.extension && e.extension.toLowerCase() === ext) return e.subdir
  }
  return ''
}

/**
 * 计算规范重定向结果。不修改 input（由调用方写回 input.path）。
 * 调用前须保证 writeDirChoice 非空（writeDirConfirmEnabled=false 时由调用方填 workDir）。
 */
export async function applyWorkspaceLayoutRedirect(args: RedirectArgs): Promise<RedirectOutcome> {
  const { toolName, input, workDir, workspaceLayout, writeDirChoice } = args
  if (!workspaceLayout.enabled) return { redirected: false }
  if (toolName !== 'write_file') return { redirected: false }
  if (!writeDirChoice) return { redirected: false }

  const rawPath = typeof input.path === 'string' ? input.path : ''
  if (!rawPath.trim()) return { redirected: false }

  // 仅新建文件重定向：目标已存在则跳过
  let existingAbs: string
  try {
    existingAbs = await resolveSafePathReal(workDir, rawPath)
  } catch {
    // LLM 给的路径解析失败（穿越），仍尝试按 basename 重定向，不直接放行
    existingAbs = ''
  }
  if (existingAbs) {
    try {
      const st = await fs.stat(existingAbs)
      if (st.isFile()) return { redirected: false }
    } catch {
      // 不存在，继续重定向
    }
  }

  const basename = path.basename(rawPath)
  const safe = sanitizeBasename(basename)
  if (!safe) {
    return { redirected: false, reject: true, rejectReason: `文件名「${basename}」不合法，无法按目录规范写入` }
  }

  const ext = extOf(rawPath)
  const subdir = lookupSubdir(workspaceLayout.extensionSubdirMap, ext)

  // 规范路径完全由代码决定：writeDirChoice.dir + subdir + safe basename
  const canonicalAbs = resolveSafePath(writeDirChoice.dir, subdir ? path.join(subdir, safe) : safe)
  const relToWorkDir = path.relative(path.resolve(workDir), canonicalAbs)
  const normalizedNew = normalizeRelPathInput(relToWorkDir)

  if (normalizedNew === normalizeRelPathInput(rawPath)) {
    return { redirected: false }
  }

  return {
    redirected: true,
    newPath: normalizedNew,
    originalPath: rawPath,
    reason: `已按目录规范重定向: ${rawPath} → ${normalizedNew}`
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run electron/workspaceLayout/redirect.test.ts`
Expected: PASS（全部 11 条）

- [ ] **Step 5: 提交**

```bash
git add electron/workspaceLayout/redirect.ts electron/workspaceLayout/redirect.test.ts
git commit -m "feat(workspaceLayout): add redirect core with traversal protection"
```

---

## Task 3: writeDirChoice 默认兜底工具函数

**Files:**
- Create: `electron/workspaceLayout/redirect.ts`（追加导出）
- Test: `electron/workspaceLayout/redirect.test.ts`（追加用例）

为 `writeDirConfirmEnabled=false` 场景提供"用 workDir 作写入目录"的兜底，避免 toolChatLoop 内联判断。

- [ ] **Step 1: 追加失败测试**

在 `redirect.test.ts` 末尾追加：

```ts
import { resolveWriteDirBase } from './redirect'

describe('resolveWriteDirBase', () => {
  it('returns writeDirChoice.dir when present', () => {
    expect(resolveWriteDirBase({ dir: 'D:/proj' })).toBe('D:/proj')
  })

  it('falls back to workDir when writeDirChoice null and confirm disabled', () => {
    expect(resolveWriteDirBase(null, 'D:/work')).toBe('D:/work')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run electron/workspaceLayout/redirect.test.ts`
Expected: FAIL（`resolveWriteDirBase` 未导出）

- [ ] **Step 3: 实现**

在 `electron/workspaceLayout/redirect.ts` 追加：

```ts
/**
 * 决定本次重定向使用的写入目录。
 * - 已有 writeDirChoice：直接用；
 * - 无且未启用确认：兜底为 workDir（调用方在 confirmEnabled=false 时使用）。
 */
export function resolveWriteDirBase(
  writeDirChoice: { dir: string } | null,
  workDir?: string
): string | null {
  if (writeDirChoice?.dir) return writeDirChoice.dir
  return workDir ?? null
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run electron/workspaceLayout/redirect.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add electron/workspaceLayout/redirect.ts electron/workspaceLayout/redirect.test.ts
git commit -m "feat(workspaceLayout): add resolveWriteDirBase fallback helper"
```

---

## Task 4: 候选目录收集

**Files:**
- Create: `electron/workspaceLayout/writeDirCandidates.ts`
- Test: `electron/workspaceLayout/writeDirCandidates.test.ts`

- [ ] **Step 1: 编写失败测试**

创建 `electron/workspaceLayout/writeDirCandidates.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import path from 'path'
import fs from 'fs/promises'
import os from 'os'
import { collectWriteDirCandidates } from './writeDirCandidates'
import type { FileStateCache } from '../fileStateCache'

async function withTempWorkDir<T>(fn: (workDir: string) => Promise<T>): Promise<T> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cand-'))
  try {
    return await fn(tmp)
  } finally {
    await fs.rm(tmp, { recursive: true, force: true })
  }
}

describe('collectWriteDirCandidates', () => {
  it('includes workDir as fallback candidate', async () => {
    await withTempWorkDir(async (workDir) => {
      const cache = new FileStateCache()
      const result = await collectWriteDirCandidates({
        workDir,
        sessionId: 's1',
        fileStateCache: cache,
        userMessages: []
      })
      expect(result.some((c) => c.dir === workDir)).toBe(true)
    })
  })

  it('includes dirs of files in fileStateCache', async () => {
    await withTempWorkDir(async (workDir) => {
      await fs.mkdir(path.join(workDir, 'sub1'), { recursive: true })
      await fs.writeFile(path.join(workDir, 'sub1', 'a.py'), 'x')
      const cache = new FileStateCache()
      cache.set(path.join(workDir, 'sub1', 'a.py'), {
        path: path.join(workDir, 'sub1', 'a.py'),
        content: 'x',
        mtime: 0,
        readAt: 0,
        isPartial: false
      })
      const result = await collectWriteDirCandidates({
        workDir,
        sessionId: 's1',
        fileStateCache: cache,
        userMessages: []
      })
      expect(result.some((c) => c.dir === path.join(workDir, 'sub1'))).toBe(true)
    })
  })

  it('includes existing dirs mentioned in user messages', async () => {
    await withTempWorkDir(async (workDir) => {
      await fs.mkdir(path.join(workDir, 'docs'), { recursive: true })
      const result = await collectWriteDirCandidates({
        workDir,
        sessionId: 's1',
        fileStateCache: new FileStateCache(),
        userMessages: ['请把文件放到 docs 目录']
      })
      expect(result.some((c) => c.dir === path.join(workDir, 'docs'))).toBe(true)
    })
  })

  it('dedupes by normalized absolute path', async () => {
    await withTempWorkDir(async (workDir) => {
      const result = await collectWriteDirCandidates({
        workDir,
        sessionId: 's1',
        fileStateCache: new FileStateCache(),
        userMessages: []
      })
      const dirs = result.map((c) => c.dir)
      expect(new Set(dirs).size).toBe(dirs.length)
    })
  })

  it('assigns sequential letters A, B, ... up to 25', async () => {
    await withTempWorkDir(async (workDir) => {
      const result = await collectWriteDirCandidates({
        workDir,
        sessionId: 's1',
        fileStateCache: new FileStateCache(),
        userMessages: []
      })
      expect(result.length).toBeLessThanOrEqual(25)
      const letters = result.map((c) => c.key)
      expect(letters[0]).toBe('A')
    })
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run electron/workspaceLayout/writeDirCandidates.test.ts`
Expected: FAIL（`collectWriteDirCandidates` 未定义）

- [ ] **Step 3: 实现**

创建 `electron/workspaceLayout/writeDirCandidates.ts`：

```ts
import path from 'path'
import fs from 'fs/promises'
import { resolveSafePathReal } from '../pathSecurity'
import type { FileStateCache } from '../fileStateCache'

export interface WriteDirCandidate {
  key: string
  dir: string
  label: string
}

export interface CollectArgs {
  workDir: string
  sessionId: string
  fileStateCache: FileStateCache
  userMessages: string[]
}

const MAX_CANDIDATES = 25

/** 从用户消息文本中提取形似路径的片段 */
function extractPathLikeFragments(text: string): string[] {
  const out: string[] = []
  // 绝对路径（Windows 盘符 / POSIX）或相对路径片段
  const re = /(?:[A-Za-z]:[\\/][^\s'"<>|*?]+)|(?:\.?\.?[\\/][^\s'"<>|*?]+)|(?:[\w-]+(?:[\\/][\w.-]+)+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    out.push(m[0])
  }
  return out
}

export async function collectWriteDirCandidates(args: CollectArgs): Promise<WriteDirCandidate[]> {
  const { workDir, fileStateCache, userMessages } = args
  const seen = new Set<string>()
  const dirs: string[] = []

  const add = (absDir: string) => {
    const norm = path.resolve(absDir)
    if (seen.has(norm)) return
    seen.add(norm)
    dirs.push(norm)
  }

  // (1) 已读文件所在目录
  for (const absFile of (fileStateCache as unknown as { cache: Map<string, unknown> }).cache.keys()) {
    add(path.dirname(absFile))
  }

  // (2) 用户消息中出现的有效目录
  for (const msg of userMessages) {
    for (const frag of extractPathLikeFragments(msg)) {
      try {
        const resolved = await resolveSafePathReal(workDir, frag)
        const st = await fs.stat(resolved)
        if (st.isDirectory()) add(resolved)
      } catch {
        // 非有效目录，跳过
      }
    }
  }

  // (3) 当前 workDir 兜底
  add(path.resolve(workDir))

  const limited = dirs.slice(0, MAX_CANDIDATES)
  return limited.map((dir, i) => ({
    key: String.fromCharCode('A'.charCodeAt(0) + i),
    dir,
    label: path.relative(workDir, dir) || '.'
  }))
}
```

> 注：`(fileStateCache as unknown as { cache: Map<...> }).cache` 访问私有字段仅为读候选。若不想碰私有字段，在 `fileStateCache.ts` 增 `keys()` 公开方法（见 Step 4）。

- [ ] **Step 4: 给 FileStateCache 增公开 keys() 方法（避免碰私有字段）**

修改 `electron/fileStateCache.ts`，在 `set` 方法后加：

```ts
  /** 返回所有已缓存文件的绝对路径（用于目录候选收集） */
  keys(): string[] {
    return [...this.cache.keys()]
  }
```

并把 Task 4 Step 3 中候选收集改为：

```ts
  for (const absFile of fileStateCache.keys()) {
    add(path.dirname(absFile))
  }
```

- [ ] **Step 5: 运行确认通过**

Run: `npx vitest run electron/workspaceLayout/writeDirCandidates.test.ts`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add electron/workspaceLayout/writeDirCandidates.ts electron/workspaceLayout/writeDirCandidates.test.ts electron/fileStateCache.ts
git commit -m "feat(workspaceLayout): add write dir candidates collection"
```

---

## Task 5: 确认流注册表（照 toolConfirmRegistry 模式）

**Files:**
- Create: `electron/workspaceLayout/writeDirConfirmRegistry.ts`
- Test: `electron/workspaceLayout/writeDirConfirmRegistry.test.ts`

- [ ] **Step 1: 编写失败测试**

创建 `electron/workspaceLayout/writeDirConfirmRegistry.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import {
  waitForWriteDirConfirm,
  submitWriteDirConfirm,
  cancelAllWriteDirConfirmsForRequest
} from './writeDirConfirmRegistry'

describe('writeDirConfirmRegistry', () => {
  it('resolves with chosen dir when submitted', async () => {
    const p = waitForWriteDirConfirm('r1', 's1')
    submitWriteDirConfirm('r1', 's1', { dir: 'D:/proj' })
    expect(await p).toEqual({ dir: 'D:/proj' })
  })

  it('resolves to null when cancelled', async () => {
    const p = waitForWriteDirConfirm('r2', 's2')
    submitWriteDirConfirm('r2', 's2', null)
    expect(await p).toBeNull()
  })

  it('cancels all pending for a request', async () => {
    const p = waitForWriteDirConfirm('r3', 's3')
    cancelAllWriteDirConfirmsForRequest('r3')
    expect(await p).toBeNull()
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run electron/workspaceLayout/writeDirConfirmRegistry.test.ts`
Expected: FAIL（模块未定义）

- [ ] **Step 3: 实现**

创建 `electron/workspaceLayout/writeDirConfirmRegistry.ts`：

```ts
export type WriteDirChoice = { dir: string; confirmedAt: number } | null

type Waiter = {
  resolve: (v: WriteDirChoice) => void
  timeoutId: ReturnType<typeof setTimeout>
}

const CONFIRM_MS = 5 * 60 * 1000
const pending = new Map<string, Waiter>()

export function writeDirConfirmKey(requestId: string, sessionId: string): string {
  return `${requestId}\0${sessionId}`
}

export function waitForWriteDirConfirm(requestId: string, sessionId: string): Promise<WriteDirChoice> {
  const key = writeDirConfirmKey(requestId, sessionId)
  return new Promise<WriteDirChoice>((resolve) => {
    const timeoutId = setTimeout(() => {
      pending.delete(key)
      resolve(null)
    }, CONFIRM_MS)
    pending.set(key, { resolve, timeoutId })
  })
}

export function submitWriteDirConfirm(
  requestId: string,
  sessionId: string,
  choice: { dir: string } | null
): void {
  const key = writeDirConfirmKey(requestId, sessionId)
  const w = pending.get(key)
  if (!w) return
  clearTimeout(w.timeoutId)
  pending.delete(key)
  const outcome: WriteDirChoice = choice ? { dir: choice.dir, confirmedAt: Date.now() } : null
  setImmediate(() => w.resolve(outcome))
}

export function cancelAllWriteDirConfirmsForRequest(requestId: string): void {
  const prefix = `${requestId}\0`
  for (const [key, w] of pending) {
    if (!key.startsWith(prefix)) continue
    clearTimeout(w.timeoutId)
    pending.delete(key)
    w.resolve(null)
  }
}

export function cancelAllPendingWriteDirConfirms(): void {
  for (const [, w] of pending) {
    clearTimeout(w.timeoutId)
    w.resolve(null)
  }
  pending.clear()
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run electron/workspaceLayout/writeDirConfirmRegistry.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add electron/workspaceLayout/writeDirConfirmRegistry.ts electron/workspaceLayout/writeDirConfirmRegistry.test.ts
git commit -m "feat(workspaceLayout): add write dir confirm registry"
```

---

## Task 6: 会话写入目录读写（sessionWriteDir）

**Files:**
- Create: `electron/workspaceLayout/sessionWriteDir.ts`
- Test: `electron/workspaceLayout/sessionWriteDir.test.ts`

- [ ] **Step 1: 编写失败测试**

创建 `electron/workspaceLayout/sessionWriteDir.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { getWriteDirChoice, setWriteDirChoice, clearWriteDirChoice } from './sessionWriteDir'

describe('sessionWriteDir', () => {
  it('returns null when metadata missing', () => {
    expect(getWriteDirChoice({})).toBeNull()
  })

  it('round-trips choice', () => {
    const meta: Record<string, unknown> = {}
    setWriteDirChoice(meta, { dir: 'D:/proj', confirmedAt: 123 })
    expect(getWriteDirChoice(meta)).toEqual({ dir: 'D:/proj', confirmedAt: 123 })
  })

  it('clears choice', () => {
    const meta: Record<string, unknown> = {}
    setWriteDirChoice(meta, { dir: 'D:/proj', confirmedAt: 123 })
    clearWriteDirChoice(meta)
    expect(getWriteDirChoice(meta)).toBeNull()
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run electron/workspaceLayout/sessionWriteDir.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

创建 `electron/workspaceLayout/sessionWriteDir.ts`：

```ts
import type { WriteDirChoice } from './writeDirConfirmRegistry'

const KEY = 'writeDirChoice'

export function getWriteDirChoice(metadata: Record<string, unknown>): WriteDirChoice {
  const v = metadata[KEY]
  if (v && typeof v === 'object' && 'dir' in v && typeof (v as { dir: unknown }).dir === 'string') {
    return v as WriteDirChoice
  }
  return null
}

export function setWriteDirChoice(metadata: Record<string, unknown>, choice: WriteDirChoice): void {
  if (choice) {
    metadata[KEY] = { ...choice }
  } else {
    delete metadata[KEY]
  }
}

export function clearWriteDirChoice(metadata: Record<string, unknown>): void {
  delete metadata[KEY]
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run electron/workspaceLayout/sessionWriteDir.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add electron/workspaceLayout/sessionWriteDir.ts electron/workspaceLayout/sessionWriteDir.test.ts
git commit -m "feat(workspaceLayout): add session writeDir choice read/write"
```

---

## Task 7: toolChatLoop 接入重定向（workDir 兜底，先不接确认流）

**Files:**
- Modify: `electron/toolChatLoop.ts`（约 `:1209`-`:1232` 区域）

本任务先实现"开关开 + writeDirConfirmEnabled=false"路径：用 workDir 作写入目录，重定向生效。确认流在 Task 9 接入。

- [ ] **Step 1: 编写失败集成测试**

创建 `electron/toolChatLoop.workspaceLayout.test.ts`，验证 `applyWorkspaceLayoutRedirect` 在循环中被调用并改写 `input.path`。由于 `runToolChatSessionInner` 依赖大量上下文，本测试以**直接调用 redirect 函数 + 模拟 inputObj 改写**的方式验证接入契约：

```ts
import { describe, it, expect } from 'vitest'
import path from 'path'
import fs from 'fs/promises'
import os from 'os'
import { applyWorkspaceLayoutRedirect } from './workspaceLayout/redirect'
import type { WorkspaceLayoutConfig } from '../src/shared/domainTypes'

const CFG: WorkspaceLayoutConfig = {
  enabled: true,
  writeDirConfirmEnabled: false,
  extensionSubdirMap: [{ extension: 'py', subdir: 'Script' }]
}

async function withTempWorkDir<T>(fn: (d: string) => Promise<T>): Promise<T> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'loop-'))
  try { return await fn(tmp) } finally { await fs.rm(tmp, { recursive: true, force: true }) }
}

describe('toolChatLoop workspaceLayout integration contract', () => {
  it('rewrites inputObj.path to redirected path before exec', async () => {
    await withTempWorkDir(async (workDir) => {
      const inputObj: Record<string, unknown> = { path: 'foo.py', content: 'x' }
      const out = await applyWorkspaceLayoutRedirect({
        toolName: 'write_file',
        input: inputObj,
        workDir,
        sessionId: 's1',
        workspaceLayout: CFG,
        writeDirChoice: { dir: workDir }
      })
      expect(out.redirected).toBe(true)
      expect(out.newPath).toBe(path.join('Script', 'foo.py').replace(/\\/g, '/'))
      // 模拟循环内改写
      if (out.redirected && out.newPath) inputObj.path = out.newPath
      expect(inputObj.path).toBe(path.join('Script', 'foo.py').replace(/\\/g, '/'))
    })
  })

  it('uses workDir base when confirm disabled and no choice', async () => {
    await withTempWorkDir(async (workDir) => {
      const inputObj: Record<string, unknown> = { path: 'bar.md', content: 'y' }
      const base = workDir
      const out = await applyWorkspaceLayoutRedirect({
        toolName: 'write_file',
        input: inputObj,
        workDir,
        sessionId: 's1',
        workspaceLayout: { ...CFG, extensionSubdirMap: [{ extension: 'md', subdir: 'Docs' }] },
        writeDirChoice: { dir: base }
      })
      expect(out.newPath).toBe(path.join('Docs', 'bar.md').replace(/\\/g, '/'))
    })
  })
})
```

- [ ] **Step 2: 运行确认通过（契约测试，函数已存在）**

Run: `npx vitest run electron/toolChatLoop.workspaceLayout.test.ts`
Expected: PASS（验证 redirect 函数契约；真实循环接入在 Step 3）

- [ ] **Step 3: 在 toolChatLoop 接入重定向**

在 `electron/toolChatLoop.ts` 顶部导入区（`checkWritePathConflict` 等导入附近）加：

```ts
import { applyWorkspaceLayoutRedirect, resolveWriteDirBase } from './workspaceLayout/redirect'
import { getWriteDirChoice } from './workspaceLayout/sessionWriteDir'
import type { WorkspaceLayoutConfig } from '../src/shared/domainTypes'
```

在 `runToolChatSessionInner` 的解构参数（约 `:344`-`:361`）后，获取 workspaceLayout 配置与 writeDirChoice。先在函数体靠前处（`const apiKey = await getApiKey()` 之前）加入：

```ts
  const workspaceLayoutCfg: WorkspaceLayoutConfig = appDb
    ? mergeWorkspaceLayoutConfig((appDb.getConfig?.() as { workspaceLayout?: WorkspaceLayoutConfig } | undefined)?.workspaceLayout)
    : { ...DEFAULT_WORKSPACE_LAYOUT_CONFIG }
```

> 若 `appDb.getConfig` 不存在，改用从 `args.options` 或已有 config 读取路径；以实际 `appDb` 接口为准（参考 toolChatLoop 内其它读取 config 的写法）。

然后在 `const relPath = typeof inputObj.path === 'string' ? inputObj.path : ''`（约 `:1209`）**之前**插入重定向块：

```ts
      // === 目录规范重定向（仅 write_file 新建文件）===
      if (
        workspaceLayoutCfg.enabled &&
        toolName === 'write_file' &&
        typeof inputObj.path === 'string' &&
        inputObj.path.trim()
      ) {
        const sessionMeta = appDb ? getSession(appDb, sessionId)?.metadata : undefined
        const meta = (sessionMeta ?? {}) as Record<string, unknown>
        const choice = getWriteDirChoice(meta)
        const base = resolveWriteDirBase(choice, workDir)
        if (base) {
          const redirectOutcome = await applyWorkspaceLayoutRedirect({
            toolName,
            input: inputObj,
            workDir,
            sessionId,
            workspaceLayout: workspaceLayoutCfg,
            writeDirChoice: { dir: base }
          })
          if (redirectOutcome.reject) {
            toolResults.push(buildToolErrorResult(toolUseId, redirectOutcome.rejectReason!))
            safeWebContentsSend(sender, 'tool:result', {
              requestId,
              toolUseId,
              result: { success: false, error: redirectOutcome.rejectReason }
            })
            if (toolErrorRepeat.noteFailure(toolName, redirectOutcome.rejectReason!)) {
              abortRepeatedToolError = `同一工具错误已连续出现 ${MAX_CONSECUTIVE_SAME_TOOL_ERROR} 次，已停止：${redirectOutcome.rejectReason}`
              break
            }
            continue
          }
          if (redirectOutcome.redirected && redirectOutcome.newPath) {
            inputObj.path = redirectOutcome.newPath
          }
        }
      }
      // === 目录规范重定向结束 ===
```

注意：`relPath`（`:1209`）在重定向**之后**取值，这样 `checkWritePathConflict`/`claimWritePath`（`:1211`/`:1230`）用的是改写后的 `newPath`。检查 `:1209` 的 `const relPath = typeof inputObj.path === 'string' ? inputObj.path : ''` 确实在重定向块之后——若顺序相反，把 `relPath` 取值移到重定向块之后。

- [ ] **Step 4: 运行已有测试确认无回归**

Run: `npx vitest run electron/toolChatLoop.workspaceLayout.test.ts electron/toolChatLoop.test.ts`
Expected: PASS

- [ ] **Step 5: 编译检查**

Run: `npx tsc -p tsconfig.electron.json --noEmit`
Expected: 无错误（`DEFAULT_WORKSPACE_LAYOUT_CONFIG`、`mergeWorkspaceLayoutConfig`、`getSession` 已导入；若缺，补 import）

- [ ] **Step 6: 提交**

```bash
git add electron/toolChatLoop.ts electron/toolChatLoop.workspaceLayout.test.ts
git commit -m "feat(workspaceLayout): integrate redirect into toolChatLoop (workDir fallback)"
```

---

## Task 8: tool_result 注入重定向提示

**Files:**
- Modify: `electron/toolChatLoop.ts`（exec.execute 之后、tool_result 构建处）

- [ ] **Step 1: 定位 tool_result 构建点**

在 `electron/toolChatLoop.ts` 中搜索 `exec.execute(inputObj`（约 `:1267`），其后 `execResult` 构建完成后会被推入 `toolResults` 并 `send('tool:result')`。找到该处。

- [ ] **Step 2: 捕获重定向结果用于注入**

把 Task 7 重定向块中的 `redirectOutcome` 提升到外层作用域（在 `if (workspaceLayoutCfg.enabled ...)` 块之前声明）：

```ts
      let workspaceRedirectNote: string | undefined
      if (
        workspaceLayoutCfg.enabled &&
        toolName === 'write_file' &&
        typeof inputObj.path === 'string' &&
        inputObj.path.trim()
      ) {
        // ...（同 Task 7）
        if (redirectOutcome.redirected && redirectOutcome.newPath) {
          inputObj.path = redirectOutcome.newPath
          workspaceRedirectNote = `[目录规范] 路径已从 ${redirectOutcome.originalPath} 重定向到 ${redirectOutcome.newPath}（依据扩展名→子目录映射）。`
        }
      }
```

- [ ] **Step 3: 在 execResult 成功时追加提示**

在 `execResult` 取得后、`toolResults.push` 之前（约 `:1327` `if (execResult.success)` 附近），加入：

```ts
      if (execResult.success && workspaceRedirectNote) {
        const data = execResult.data as Record<string, unknown> | undefined
        execResult = {
          ...execResult,
          data: data ? { ...data, _workspaceLayoutNote: workspaceRedirectNote } : { _workspaceLayoutNote: workspaceRedirectNote }
        }
      }
```

> 注：把提示挂到 `data._workspaceLayoutNote`，renderer 渲染 tool_result 时若有该字段则展示。若项目无此展示通道，改为在 `execResult.data.path` 同级的备注字段，或暂存到 `ToolCallRecord.metadata`（见 Task 8 Step 4 备选）。

- [ ] **Step 4: 备选——存入 ToolCallRecord.metadata**

若 `execResult.data` 不便扩展，则在构建 `ToolCallRecord` 处（搜索 `toolCalls.push` 或 `ToolCallRecord` 构造）把 `workspaceRedirectNote` 写入 `metadata.workspaceLayoutNote`。renderer 工具卡片渲染时读 `metadata.workspaceLayoutNote` 展示。采用哪种取决于 renderer 工具卡片现有数据通道——以实际为准，二选一即可。

- [ ] **Step 5: 运行测试**

Run: `npx vitest run electron/toolChatLoop.workspaceLayout.test.ts`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add electron/toolChatLoop.ts
git commit -m "feat(workspaceLayout): annotate redirected tool_result"
```

---

## Task 9: 确认流 IPC 通道

**Files:**
- Modify: `src/shared/api.ts`、`electron/preload.ts`、`electron/appIpc.ts`

- [ ] **Step 1: 在 src/shared/api.ts 增类型**

在 `src/shared/api.ts` 中（`ToolConfirmResponsePayload` 附近）加：

```ts
export interface WriteDirCandidatePayload {
  key: string
  dir: string
  label: string
}

export interface WriteDirConfirmRequest {
  requestId: string
  sessionId: string
  candidates: WriteDirCandidatePayload[]
  customOption: true
}

export interface WriteDirConfirmResponse {
  requestId: string
  sessionId: string
  choice:
    | { type: 'candidate'; key: string }
    | { type: 'custom'; dir: string }
    | null
}
```

- [ ] **Step 2: 在 preload.ts 暴露 API**

在 `electron/preload.ts` 的 `toolOnConfirmRequest`（约 `:150`-`:169`）之后加：

```ts
  fileWriteDirOnConfirmRequest: (cb) => {
    const fn = (
      _e: unknown,
      data: import('../src/shared/api').WriteDirConfirmRequest
    ) => cb(data)
    ipcRenderer.on('file-write-dir:confirm-request', fn)
    return () => ipcRenderer.removeListener('file-write-dir:confirm-request', fn)
  },
  fileWriteDirConfirmResponse: (
    payload: import('../src/shared/api').WriteDirConfirmResponse
  ) => ipcRenderer.invoke('file-write-dir:confirm-response', payload),
```

并在 preload 的 `api` 类型声明（`window.api` 的 TS 接口）补这两个方法签名。

- [ ] **Step 3: 在 appIpc.ts 注册 handler**

在 `electron/appIpc.ts` 的 `'tool:confirm-response'` handler（约 `:262`）之后加：

```ts
  ipcMain.handle(
    'file-write-dir:confirm-response',
    async (_e, payload: WriteDirConfirmResponse) => {
      let chosenDir: string | null = null
      if (payload.choice?.type === 'candidate') {
        const sess = payload.sessionId ? getSession(ctx.db, payload.sessionId) : undefined
        // candidate 的 dir 由主进程在发请求时已知，renderer 只回 key
        // 通过 pending 请求的候选快照解析 key -> dir
        chosenDir = resolveWriteDirCandidateDir(payload.requestId, payload.sessionId, payload.choice.key)
      } else if (payload.choice?.type === 'custom') {
        chosenDir = payload.choice.dir
      }
      if (chosenDir) {
        try {
          const safe = await resolveSafePathReal(getWorkDirForSession(ctx.db, payload.sessionId), chosenDir)
          chosenDir = safe
        } catch {
          submitWriteDirConfirm(payload.requestId, payload.sessionId, null)
          return { ok: false as const, error: '目录超出工作目录范围' }
        }
      }
      submitWriteDirConfirm(payload.requestId, payload.sessionId, chosenDir ? { dir: chosenDir } : null)
      return { ok: true as const }
    }
  )
```

> `resolveWriteDirCandidateDir` / `getWorkDirForSession` 为辅助函数，在 Task 10 实现。`getSession`、`submitWriteDirConfirm`、`resolveSafePathReal` 已 import 或补 import。

- [ ] **Step 4: 编译检查**

Run: `npx tsc -p tsconfig.electron.json --noEmit`
Expected: 无错误（辅助函数 Task 10 补齐前可暂留 TODO 标记，但 Task 10 必须完成）

- [ ] **Step 5: 提交（与 Task 10 合并提交，或先存 WIP）**

```bash
git add src/shared/api.ts electron/preload.ts electron/appIpc.ts
git commit -m "feat(workspaceLayout): add write-dir confirm IPC channels"
```

---

## Task 10: 确认流主进程触发与候选快照

**Files:**
- Create: `electron/workspaceLayout/confirmFlow.ts`
- Modify: `electron/appIpc.ts`（补 Task 9 的辅助函数）

- [ ] **Step 1: 实现候选快照存储与解析**

创建 `electron/workspaceLayout/confirmFlow.ts`：

```ts
import { collectWriteDirCandidates, type WriteDirCandidate } from './writeDirCandidates'
import type { WriteDirCandidatePayload } from '../../src/shared/api'

const snapshots = new Map<string, { candidates: WriteDirCandidate[] }>()

function snapKey(requestId: string, sessionId: string): string {
  return `${requestId}\0${sessionId}`
}

export async function buildAndSnapshotCandidates(args: {
  requestId: string
  sessionId: string
  workDir: string
  fileStateCache: import('../fileStateCache').FileStateCache
  userMessages: string[]
}): Promise<WriteDirCandidatePayload[]> {
  const candidates = await collectWriteDirCandidates({
    workDir: args.workDir,
    sessionId: args.sessionId,
    fileStateCache: args.fileStateCache,
    userMessages: args.userMessages
  })
  snapshots.set(snapKey(args.requestId, args.sessionId), { candidates })
  return candidates.map((c) => ({ key: c.key, dir: c.dir, label: c.label }))
}

export function resolveWriteDirCandidateDir(
  requestId: string,
  sessionId: string,
  key: string
): string | null {
  const snap = snapshots.get(snapKey(requestId, sessionId))
  if (!snap) return null
  const found = snap.candidates.find((c) => c.key === key)
  return found ? found.dir : null
}

export function clearWriteDirCandidateSnapshot(requestId: string, sessionId: string): void {
  snapshots.delete(snapKey(requestId, sessionId))
}
```

- [ ] **Step 2: 在 appIpc.ts 补 import 与 getWorkDirForSession**

在 `electron/appIpc.ts` 顶部补：

```ts
import { resolveWriteDirCandidateDir, clearWriteDirCandidateSnapshot } from './workspaceLayout/confirmFlow'
import { submitWriteDirConfirm } from './workspaceLayout/writeDirConfirmRegistry'
import { resolveSafePathReal } from './pathSecurity'
```

`getWorkDirForSession`：若项目已有 `resolveWorkDirForSession`（搜索确认，见 `electron/workDirManager.ts`），直接复用并 import；否则实现：

```ts
function getWorkDirForSession(db: AppDatabase, sessionId: string): string {
  // 复用现有 workDir 解析；若无则从 session/workDirProfile 解析
  return resolveWorkDirForSession(db, sessionId)
}
```

- [ ] **Step 3: 运行已有单测确认无回归**

Run: `npx vitest run electron/workspaceLayout/`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add electron/workspaceLayout/confirmFlow.ts electron/appIpc.ts
git commit -m "feat(workspaceLayout): candidate snapshot + confirm resolution"
```

---

## Task 11: toolChatLoop 接入确认流 + WriteDirConfirmPanel

**Files:**
- Modify: `electron/toolChatLoop.ts`
- Create: `src/renderer/components/Chat/WriteDirConfirmPanel.tsx`、`.test.tsx`
- Modify: 渲染进程订阅入口（ChatView 或 chatStreamService）

- [ ] **Step 1: 在 toolChatLoop 重定向块前插入确认触发**

修改 Task 7 的重定向块，在 `const choice = getWriteDirChoice(meta)` 之后、`resolveWriteDirBase` 之前插入确认：

```ts
        const meta = (sessionMeta ?? {}) as Record<string, unknown>
        let choice = getWriteDirChoice(meta)
        if (!choice && workspaceLayoutCfg.writeDirConfirmEnabled) {
          // 首次写入：触发确认流
          const userMsgs = initialMessages
            .filter((m) => m.role === 'user')
            .map((m) => m.content)
            .filter((c): c is string => typeof c === 'string')
          const candidates = await buildAndSnapshotCandidates({
            requestId,
            sessionId,
            workDir,
            fileStateCache: fileCache,
            userMessages: userMsgs
          })
          safeWebContentsSend(sender, 'file-write-dir:confirm-request', {
            requestId,
            sessionId,
            candidates,
            customOption: true as const
          })
          choice = await waitForWriteDirConfirm(requestId, sessionId)
          clearWriteDirCandidateSnapshot(requestId, sessionId)
          if (choice) {
            // 持久化到 session metadata
            setWriteDirChoice(meta, choice)
            if (appDb && sessionMeta) {
              await updateSessionMetadata(appDb, sessionId, meta)
            }
          } else {
            // 用户取消
            const cancelErr = '未选择写入目录，已取消写入'
            toolResults.push(buildToolErrorResult(toolUseId, cancelErr))
            safeWebContentsSend(sender, 'tool:result', {
              requestId,
              toolUseId,
              result: { success: false, error: cancelErr }
            })
            continue
          }
        }
        const base = resolveWriteDirBase(choice, workDir)
```

补 import：

```ts
import { waitForWriteDirConfirm } from './workspaceLayout/writeDirConfirmRegistry'
import { buildAndSnapshotCandidates, clearWriteDirCandidateSnapshot } from './workspaceLayout/confirmFlow'
import { setWriteDirChoice } from './workspaceLayout/sessionWriteDir'
```

`updateSessionMetadata`：若项目无现成函数，搜索 `getSession`/`updateSession` 在 `electron/database.ts` 的写法并复用；以实际为准。

- [ ] **Step 2: 在取消时清理 pending（请求结束/取消）**

搜索 toolChatLoop 中 `cancelAllToolConfirmsForRequest` 的调用处（请求终止清理），并排加入：

```ts
cancelAllWriteDirConfirmsForRequest(requestId)
```

- [ ] **Step 3: 编写 WriteDirConfirmPanel 测试**

创建 `src/renderer/components/Chat/WriteDirConfirmPanel.test.tsx`：

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { WriteDirConfirmPanel } from './WriteDirConfirmPanel'

const candidates = [
  { key: 'A', dir: 'D:/proj/sub1', label: 'sub1' },
  { key: 'B', dir: 'D:/proj', label: '.' }
]

describe('WriteDirConfirmPanel', () => {
  it('submits selected candidate', () => {
    const onRespond = vi.fn()
    render(
      <WriteDirConfirmPanel
        requestId="r1"
        sessionId="s1"
        candidates={candidates}
        onRespond={onRespond}
      />
    )
    fireEvent.click(screen.getByLabelText('sub1'))
    fireEvent.click(screen.getByRole('button', { name: /确认/ }))
    expect(onRespond).toHaveBeenCalledWith({ type: 'candidate', key: 'A' })
  })

  it('submits custom dir', () => {
    const onRespond = vi.fn()
    render(
      <WriteDirConfirmPanel
        requestId="r1"
        sessionId="s1"
        candidates={candidates}
        onRespond={onRespond}
      />
    )
    fireEvent.click(screen.getByLabelText(/自定义/))
    fireEvent.change(screen.getByPlaceholderText(/输入目录/), { target: { value: 'D:/proj/new' } })
    fireEvent.click(screen.getByRole('button', { name: /确认/ }))
    expect(onRespond).toHaveBeenCalledWith({ type: 'custom', dir: 'D:/proj/new' })
  })

  it('submits null on cancel', () => {
    const onRespond = vi.fn()
    render(
      <WriteDirConfirmPanel
        requestId="r1"
        sessionId="s1"
        candidates={candidates}
        onRespond={onRespond}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /取消/ }))
    expect(onRespond).toHaveBeenCalledWith(null)
  })
})
```

- [ ] **Step 4: 实现 WriteDirConfirmPanel**

创建 `src/renderer/components/Chat/WriteDirConfirmPanel.tsx`：

```tsx
import { useState } from 'react'
import { Modal, Radio, Input, Space, Typography } from 'antd'
import type { WriteDirCandidatePayload, WriteDirConfirmResponse } from '../../../shared/api'

interface Props {
  requestId: string
  sessionId: string
  candidates: WriteDirCandidatePayload[]
  onRespond: (choice: WriteDirConfirmResponse['choice']) => void
}

export function WriteDirConfirmPanel({ requestId, sessionId, candidates, onRespond }: Props) {
  const [selected, setSelected] = useState<string>(candidates[0]?.key ?? '')
  const [customMode, setCustomMode] = useState(false)
  const [customDir, setCustomDir] = useState('')

  const handleConfirm = () => {
    if (customMode) {
      onRespond({ type: 'custom', dir: customDir.trim() })
    } else {
      onRespond({ type: 'candidate', key: selected })
    }
  }

  return (
    <Modal
      open
      title="选择本次会话的写入目录"
      okText="确认"
      cancelText="取消"
      onOk={handleConfirm}
      onCancel={() => onRespond(null)}
    >
      <Space direction="vertical" style={{ width: '100%' }}>
        <Radio.Group
          value={customMode ? '__custom__' : selected}
          onChange={(e) => {
            const v = e.target.value
            if (v === '__custom__') setCustomMode(true)
            else { setCustomMode(false); setSelected(v) }
          }}
        >
          <Space direction="vertical">
            {candidates.map((c) => (
              <Radio key={c.key} value={c.key}>
                <Typography.Text strong>{c.key}.</Typography.Text> {c.label}{' '}
                <Typography.Text type="secondary">{c.dir}</Typography.Text>
              </Radio>
            ))}
            <Radio value="__custom__">自定义输入目录</Radio>
          </Space>
        </Radio.Group>
        {customMode && (
          <Input
            placeholder="输入目录（相对工作目录或绝对路径）"
            value={customDir}
            onChange={(e) => setCustomDir(e.target.value)}
          />
        )}
      </Space>
    </Modal>
  )
}
```

- [ ] **Step 5: 在渲染进程订阅 confirm-request**

在订阅 `toolOnConfirmRequest` 的同一文件（搜索 `toolOnConfirmRequest` 调用处，可能在 `ChatView.tsx` 或 `chatStreamService.ts`）附近，订阅 `fileWriteDirOnConfirmRequest`，弹出 `WriteDirConfirmPanel`，确认时调 `window.api.fileWriteDirConfirmResponse({ requestId, sessionId, choice })`。

- [ ] **Step 6: 运行测试**

Run: `npx vitest run src/renderer/components/Chat/WriteDirConfirmPanel.test.tsx`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add electron/toolChatLoop.ts src/renderer/components/Chat/WriteDirConfirmPanel.tsx src/renderer/components/Chat/WriteDirConfirmPanel.test.tsx
git commit -m "feat(workspaceLayout): wire confirm flow + panel"
```

---

## Task 12: 系统提示强化

**Files:**
- Modify: `electron/llmSystemPrompt.ts`、`electron/toolChatLoop.ts`

- [ ] **Step 1: buildFinalSystemPrompt 增参数**

在 `electron/llmSystemPrompt.ts:31` 的签名加 `workspaceLayoutHint?: string`：

```ts
export function buildFinalSystemPrompt(args: {
  system?: string
  memoryContent: string | null
  memoryEnabled: boolean
  locale: AppLocale
  hasImageAttachments?: boolean
  workspaceLayoutHint?: string
}): string | undefined {
  let withMemory = buildSystemPrompt(args.system, args.memoryContent, args.memoryEnabled)
  if (args.hasImageAttachments) {
    const hint = buildImageAttachmentsSystemHint(args.locale)
    withMemory = withMemory ? `${withMemory}\n\n${hint}` : hint
  }
  if (args.workspaceLayoutHint) {
    withMemory = withMemory ? `${withMemory}\n\n${args.workspaceLayoutHint}` : args.workspaceLayoutHint
  }
  return appendUiLocaleSystemHint(withMemory, args.locale)
}
```

- [ ] **Step 2: 在 toolChatLoop 构建提示处传入 hint**

在 `electron/toolChatLoop.ts:436` 调用处，构造 hint 字符串并传入。在 `while` 循环内、`buildFinalSystemPrompt` 调用前加：

```ts
    let workspaceLayoutHint: string | undefined
    if (workspaceLayoutCfg.enabled) {
      const sessionMeta = appDb ? getSession(appDb, sessionId)?.metadata : undefined
      const choice = getWriteDirChoice((sessionMeta ?? {}) as Record<string, unknown>)
      if (choice) {
        const lines = workspaceLayoutCfg.extensionSubdirMap
          .map((e) => `- *.${e.extension} → ${e.subdir}`)
          .join('\n')
        workspaceLayoutHint = `当前会话已启用目录规范。新建文件写入目录为：${choice.dir}。\n文件按扩展名归入子目录：\n${lines || '-（无映射，全部落根）'}\n未映射的扩展名直接写入 ${choice.dir} 根。\n请直接按规范路径写入，不要使用 .. 或绝对路径绕过；目录部分将由系统按规范重定向。`
      }
    }
```

并把 `:436` 调用改为传入：

```ts
    const systemPrompt = buildFinalSystemPrompt({
      system: systemWithTools,
      memoryContent,
      memoryEnabled: projectMemoryEnabled ?? true,
      locale,
      hasImageAttachments: hasImageAttachments ?? false,
      workspaceLayoutHint
    })
```

- [ ] **Step 3: 编译与测试**

Run: `npx tsc -p tsconfig.electron.json --noEmit && npx vitest run electron/toolChatLoop.workspaceLayout.test.ts`
Expected: 无错误，测试 PASS

- [ ] **Step 4: 提交**

```bash
git add electron/llmSystemPrompt.ts electron/toolChatLoop.ts
git commit -m "feat(workspaceLayout): inject layout hint into system prompt"
```

---

## Task 13: workDir 切换时清空 writeDirChoice

**Files:**
- Modify: `electron/workDirManager.ts` 或 workDir 切换入口

- [ ] **Step 1: 定位 workDir 切换点**

搜索 `electron/` 中处理工作目录切换/profile 激活的函数（`workDirManager.ts` 或 `appIpc.ts` 中 `activeWorkDirProfileId` 更新处）。

- [ ] **Step 2: 在切换后清空受影响会话的 writeDirChoice**

在切换处理函数末尾（profile 激活成功后）加：

```ts
import { clearWriteDirChoice } from './workspaceLayout/sessionWriteDir'
// 对当前会话（或所有会话）清空 writeDirChoice
// 以实际 session 更新入口为准，例如：
const sessions = listSessions(ctx.db)
for (const s of sessions) {
  const meta = (s.metadata ?? {}) as Record<string, unknown>
  if (getWriteDirChoice(meta)) {
    clearWriteDirChoice(meta)
    updateSessionMetadata(ctx.db, s.id, meta)
  }
}
```

> 范围决策：清空**所有会话**的 writeDirChoice（因为 workDir 变更后任何旧绝对路径都可能越界），符合规格 §11.3。`listSessions`/`updateSessionMetadata` 复用现有 DB 接口。

- [ ] **Step 3: 编写测试验证切换后清空**

在 `electron/workDirManager.test.ts` 或新建测试中加用例：构造一个带 writeDirChoice 的 session，调用切换函数，断言 `getWriteDirChoice(meta)` 为 null。

Run: `npx vitest run electron/workDirManager.test.ts`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add electron/workDirManager.ts electron/workDirManager.test.ts
git commit -m "feat(workspaceLayout): clear writeDirChoice on workDir switch"
```

---

## Task 14: 配置快照纳入 workspaceLayout

**Files:**
- Modify: `src/renderer/components/Config/configModalSnapshot.ts`、`ConfigModal.tsx`

- [ ] **Step 1: ConfigModalSnapshotInput 增字段**

在 `configModalSnapshot.ts` 的 `ConfigModalSnapshotInput` 加：

```ts
  workspaceLayout: WorkspaceLayoutConfig
```

并补 import：

```ts
import type { WorkspaceLayoutConfig } from '../../../shared/domainTypes'
```

- [ ] **Step 2: payload 纳入 workspaceLayout**

在 `buildConfigModalSnapshot` 的 `payload`（约 `:76`）加：

```ts
    workspaceLayout: {
      ...input.workspaceLayout,
      extensionSubdirMap: input.workspaceLayout.extensionSubdirMap.map((e) => ({ ...e }))
    },
```

- [ ] **Step 3: buildConfigModalSnapshotFromConfig 传入**

在 `buildConfigModalSnapshotFromConfig`（约 `:110`）调用处补 `workspaceLayout: mergeWorkspaceLayoutConfig(cfg.workspaceLayout)`，并补 import。

- [ ] **Step 4: ConfigModal.tsx 接入编辑态**

在 `ConfigModal.tsx` 中为 `workspaceLayout` 增本地 state（参照 `toolUi` 模式），并在 snapshot 比较时纳入。

- [ ] **Step 5: 编译检查**

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 6: 提交**

```bash
git add src/renderer/components/Config/configModalSnapshot.ts src/renderer/components/Config/ConfigModal.tsx
git commit -m "feat(workspaceLayout): include layout in config snapshot"
```

---

## Task 15: 设置 Tab — WorkspaceLayoutTab

**Files:**
- Modify: `src/renderer/store/configSlice.ts`、`src/renderer/components/Config/toolsSettingsNav.ts`
- Create: `src/renderer/components/Config/WorkspaceLayoutTab.tsx`、`.test.tsx`
- Modify: `src/renderer/components/Config/ConfigModal.tsx`

- [ ] **Step 1: ToolsSettingsSubTab 加类型**

在 `configSlice.ts:4` 改：

```ts
export type ToolsSettingsSubTab = 'switches' | 'file' | 'script' | 'shell' | 'browser' | 'workspaceLayout'
```

- [ ] **Step 2: toolsSettingsNav 加 nav 项**

在 `toolsSettingsNav.ts` 的 `TOOLS_SETTINGS_SUB_TABS` 加 `'workspaceLayout'`，`NAV_LABEL_KEYS` / `NAV_HINT_KEYS` 加：

```ts
  workspaceLayout: 'tools.nav.workspaceLayout.label'
```
（hint 同理）

- [ ] **Step 3: 编写 WorkspaceLayoutTab 测试**

创建 `src/renderer/components/Config/WorkspaceLayoutTab.test.tsx`：

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { WorkspaceLayoutTab } from './WorkspaceLayoutTab'

const baseConfig = {
  enabled: false,
  writeDirConfirmEnabled: true,
  extensionSubdirMap: [{ extension: 'py', subdir: 'Script' }]
}

describe('WorkspaceLayoutTab', () => {
  it('disables map table when enabled is false', () => {
    render(<WorkspaceLayoutTab value={baseConfig} onChange={() => {}} />)
    expect(screen.getByPlaceholderText(/扩展名/)).toBeDisabled()
  })

  it('enables map table when enabled is true', () => {
    render(<WorkspaceLayoutTab value={{ ...baseConfig, enabled: true }} onChange={() => {}} />)
    expect(screen.getByPlaceholderText(/扩展名/)).not.toBeDisabled()
  })

  it('adds a new mapping row', () => {
    const onChange = vi.fn()
    render(<WorkspaceLayoutTab value={{ ...baseConfig, enabled: true }} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: /新增映射/ }))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      extensionSubdirMap: expect.arrayContaining([expect.objectContaining({ extension: '', subdir: '' })])
    }))
  })

  it('rejects subdir with path separator', () => {
    const onChange = vi.fn()
    render(<WorkspaceLayoutTab value={{ ...baseConfig, enabled: true }} onChange={onChange} />)
    const inputs = screen.getAllByPlaceholderText(/子目录/)
    fireEvent.change(inputs[0], { target: { value: 'a/b' } })
    fireEvent.blur(inputs[0])
    expect(screen.getByText(/不能包含路径分隔符/)).toBeTruthy()
  })
})
```

- [ ] **Step 4: 实现 WorkspaceLayoutTab**

创建 `src/renderer/components/Config/WorkspaceLayoutTab.tsx`（使用 Ant Design `Switch`、`Table`、`Input`、`Button`；校验：扩展名仅字母数字、子目录不含 `/`、`\`、`..`）：

```tsx
import { Table, Switch, Input, Button, Space, Form, Typography } from 'antd'
import { PlusOutlined, DeleteOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import type { WorkspaceLayoutConfig, ExtensionSubdirMapEntry } from '../../../shared/domainTypes'

interface Props {
  value: WorkspaceLayoutConfig
  onChange: (v: WorkspaceLayoutConfig) => void
}

export function WorkspaceLayoutTab({ value, onChange }: Props) {
  const { t } = useTranslation()
  const disabled = !value.enabled

  const updateEntry = (idx: number, patch: Partial<ExtensionSubdirMapEntry>) => {
    const next = value.extensionSubdirMap.map((e, i) => (i === idx ? { ...e, ...patch } : e))
    onChange({ ...value, extensionSubdirMap: next })
  }
  const addRow = () => onChange({ ...value, extensionSubdirMap: [...value.extensionSubdirMap, { extension: '', subdir: '' }] })
  const removeRow = (idx: number) => onChange({ ...value, extensionSubdirMap: value.extensionSubdirMap.filter((_, i) => i !== idx) })

  const columns = [
    {
      title: t('settings.workspaceLayout.colExtension'),
      render: (_: unknown, _r: ExtensionSubdirMapEntry, idx: number) => (
        <Input
          placeholder={t('settings.workspaceLayout.extPlaceholder')}
          value={value.extensionSubdirMap[idx].extension}
          disabled={disabled}
          onChange={(e) => updateEntry(idx, { extension: e.target.value.replace(/^[.]/, '').toLowerCase() })}
        />
      )
    },
    {
      title: t('settings.workspaceLayout.colSubdir'),
      render: (_: unknown, r: ExtensionSubdirMapEntry, idx: number) => {
        const invalid = /[\\/]/.test(r.subdir) || r.subdir.includes('..')
        return (
          <Space direction="vertical" size={0}>
            <Input
              placeholder={t('settings.workspaceLayout.subdirPlaceholder')}
              value={r.subdir}
              disabled={disabled}
              onChange={(e) => updateEntry(idx, { subdir: e.target.value })}
            />
            {invalid && <Typography.Text type="danger">{t('settings.workspaceLayout.invalidSubdir')}</Typography.Text>}
          </Space>
        )
      }
    },
    {
      title: t('common.action'),
      render: (_: unknown, _r: ExtensionSubdirMapEntry, idx: number) => (
        <Button icon={<DeleteOutlined />} disabled={disabled} onClick={() => removeRow(idx)} />
      )
    }
  ]

  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Form layout="horizontal">
        <Form.Item label={t('settings.workspaceLayout.enabled')}>
          <Switch checked={value.enabled} onChange={(v) => onChange({ ...value, enabled: v })} />
        </Form.Item>
        <Form.Item label={t('settings.workspaceLayout.writeDirConfirmEnabled')}>
          <Switch checked={value.writeDirConfirmEnabled} disabled={disabled} onChange={(v) => onChange({ ...value, writeDirConfirmEnabled: v })} />
        </Form.Item>
      </Form>
      <Button icon={<PlusOutlined />} disabled={disabled} onClick={addRow}>{t('settings.workspaceLayout.addMapping')}</Button>
      <Table
        rowKey={(_, idx) => String(idx)}
        dataSource={value.extensionSubdirMap.map((e, i) => ({ ...e, _idx: i }))}
        columns={columns}
        pagination={false}
        size="small"
      />
      <Typography.Paragraph type="secondary">{t('settings.workspaceLayout.helpText')}</Typography.Paragraph>
    </Space>
  )
}
```

- [ ] **Step 5: ConfigModal 渲染 Tab**

在 `ConfigModal.tsx` 的 Tab 切换处（搜索 `toolsSettingsSubTab` 渲染分支），加：

```tsx
{toolsSubTab === 'workspaceLayout' && (
  <WorkspaceLayoutTab value={workspaceLayoutDraft} onChange={setWorkspaceLayoutDraft} />
)}
```

- [ ] **Step 6: 运行测试**

Run: `npx vitest run src/renderer/components/Config/WorkspaceLayoutTab.test.tsx`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add src/renderer/store/configSlice.ts src/renderer/components/Config/toolsSettingsNav.ts src/renderer/components/Config/WorkspaceLayoutTab.tsx src/renderer/components/Config/WorkspaceLayoutTab.test.tsx src/renderer/components/Config/ConfigModal.tsx
git commit -m "feat(workspaceLayout): add settings tab with editable map"
```

---

## Task 16: i18n 资源

**Files:**
- Modify: `src/renderer/i18n/resources/zh-CN/`（settings、common、chat 命名空间文件）

- [ ] **Step 1: 添加 zh-CN key**

在 zh-CN 的 settings 命名空间文件加 `workspaceLayout` 段（开关、列名、占位符、校验文案、帮助文本），common 加 action，chat 加 `writeDirConfirm` 段。具体 key 与 Task 15 代码引用一致：

```
settings.workspaceLayout.enabled
settings.workspaceLayout.writeDirConfirmEnabled
settings.workspaceLayout.colExtension
settings.workspaceLayout.colSubdir
settings.workspaceLayout.extPlaceholder
settings.workspaceLayout.subdirPlaceholder
settings.workspaceLayout.invalidSubdir  (= "子目录不能包含路径分隔符或 ..")
settings.workspaceLayout.addMapping
settings.workspaceLayout.helpText
tools.nav.workspaceLayout.label
tools.nav.workspaceLayout.hint
chat.writeDirConfirm.title
```

- [ ] **Step 2: 生成类型与校验**

Run: `npm run i18n:generate-types && npm run i18n:check`
Expected: 通过

- [ ] **Step 3: 提交**

```bash
git add src/renderer/i18n/
git commit -m "i18n(workspaceLayout): add zh-CN keys"
```

---

## Task 17: 只读 chip 显示当前写入目录

**Files:**
- Modify: 聊天区组件（ChatView 或顶部工具栏）

- [ ] **Step 1: 订阅 session metadata 中的 writeDirChoice**

在 ChatView 或会话状态订阅处，读取当前会话 `metadata.writeDirChoice`，渲染只读 chip：

```tsx
{writeDirChoice?.dir && (
  <Tag color="blue">写入目录：{writeDirChoice.dir}</Tag>
)}
```

- [ ] **Step 2: 验证显示**

手动或通过渲染进程测试确认：会话锁定后 chip 出现；切换 workDir 后 chip 消失（Task 13 已清空）。

- [ ] **Step 3: 提交**

```bash
git add src/renderer/components/Chat/
git commit -m "feat(workspaceLayout): read-only chip for active write dir"
```

---

## Task 18: 集成测试与安全回归

**Files:**
- Test: `electron/toolChatLoop.workspaceLayout.test.ts`（扩充）

- [ ] **Step 1: 扩充集成测试 — 端到端重定向 + 确认流 mock**

在 `electron/toolChatLoop.workspaceLayout.test.ts` 中加用例，mock `waitForWriteDirConfirm` 返回 `{ dir: workDir }`，验证：重定向发生 → `inputObj.path` 改写 → tool_result 含 `_workspaceLayoutNote`。使用 vitest `vi.mock` mock `./workspaceLayout/writeDirConfirmRegistry`。

- [ ] **Step 2: 安全专项测试**

加穿越路径全集用例：`..\..\x.py`、`/etc/x.py`、`a/../b.py`、UNC `\\host\share\x.py`、绝对盘符 `C:\Windows\x.py`，断言 `newPath` 始终落在 `workDir\Script\` 之下（用 `path.relative` 检查不含 `..`）。

```ts
  it('never escapes writeDir for traversal inputs', async () => {
    await withTempWorkDir(async (workDir) => {
      const inputs = ['..\\..\\x.py', '/etc/x.py', 'a/../b.py', 'C:\\Windows\\x.py']
      for (const p of inputs) {
        const out = await applyWorkspaceLayoutRedirect({
          toolName: 'write_file', input: { path: p, content: '' }, workDir, sessionId: 's1',
          workspaceLayout: CFG, writeDirChoice: { dir: workDir }
        })
        const resolved = path.resolve(workDir, out.newPath ?? '')
        const rel = path.relative(path.resolve(workDir), resolved)
        expect(rel.startsWith('..') || path.isAbsolute(rel)).toBe(false)
      }
    })
  })
```

- [ ] **Step 3: 运行全部相关测试**

Run: `npx vitest run electron/workspaceLayout/ electron/toolChatLoop.workspaceLayout.test.ts electron/toolChatLoop.test.ts src/renderer/components/Config/WorkspaceLayoutTab.test.tsx src/renderer/components/Chat/WriteDirConfirmPanel.test.tsx`
Expected: 全部 PASS

- [ ] **Step 4: 全量编译**

Run: `npm run build`
Expected: 成功

- [ ] **Step 5: 提交**

```bash
git add electron/toolChatLoop.workspaceLayout.test.ts
git commit -m "test(workspaceLayout): integration + traversal regression"
```

---

## Self-Review 备注

**Spec coverage 核对：**
- §6 数据模型 → Task 1 ✓
- §7 防穿越铁律 → Task 2（sanitizeBasename + 丢弃目录）✓
- §8 确认流（候选三源 + 自定义 + IPC + 面板 + 自然语言重选）→ Task 4/5/9/10/11 ✓（自然语言重选：靠系统提示 Task 12 引导 LLM 清空 choice 触发再确认；清空入口由 LLM 调用——若需显式 API，在 Task 11 补一个 IPC `file-write-dir:reset`，当前以"LLM 识别意图后下轮首次写入触发再确认"实现）
- §9 重定向 Hook（落点/拒绝/tool_result/系统提示/冲突检测衔接）→ Task 2/7/8/12 ✓
- §10 设置 UI（Tab/映射表/校验/chip）→ Task 14/15/16/17 ✓
- §11 workDir 切换清空 → Task 13 ✓
- §12 测试 → 各 Task 内 + Task 18 ✓

**类型一致性：** `RedirectOutcome`、`WriteDirChoice`、`WriteDirCandidate`、`applyWorkspaceLayoutRedirect` 签名在各 Task 间一致。`getWriteDirChoice`/`setWriteDirChoice`/`clearWriteDirChoice` 命名统一。

**已知需以实际接口为准处（plan 已标注）：** `appDb.getConfig`、`updateSessionMetadata`、`resolveWorkDirForSession`、`listSessions` 的确切签名——执行时先读对应文件确认，照现有模式调用。
