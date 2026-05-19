# 引用的文件 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在右侧详情面板下半区域添加「引用的文件」板块，自动汇总当前会话中 AI 通过 read_file/write_file/edit_file 操作过的文件，支持一次性脚本过滤、拖动调整高度和点击打开文件。

**Architecture:** 数据从 Redux Store 的 `chat.messages` 中提取，通过自定义 Hook `useReferencedFiles` 派生计算，传递给 `ReferencedFilesPanel` 组件渲染。DetailPanel 从二选一布局改为上下分栏布局（selectedFile 非空时 FileOverlay 覆盖全栏，否则上半区占位 + 下半区引用列表）。中间用 ResizeHandle 支持拖动调整高度。

**Tech Stack:** React 18, TypeScript, Ant Design 5, Redux Toolkit, Vitest

---

## File Structure

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/renderer/components/DetailPanel/disposableScriptFilter.ts` | 新建 | 一次性脚本过滤逻辑与正则 |
| `src/renderer/components/DetailPanel/disposableScriptFilter.test.ts` | 新建 | 过滤逻辑测试 |
| `src/renderer/components/DetailPanel/useReferencedFiles.ts` | 新建 | 从 Redux 消息中提取引用文件的 Hook |
| `src/renderer/components/DetailPanel/useReferencedFiles.test.ts` | 新建 | Hook 测试 |
| `src/renderer/components/DetailPanel/ResizeHandle.tsx` | 新建 | 可拖动分隔条组件 |
| `src/renderer/components/DetailPanel/ReferencedFileItem.tsx` | 新建 | 单个文件条目组件 |
| `src/renderer/components/DetailPanel/ReferencedFilesPanel.tsx` | 新建 | 引用文件列表面板组件 |
| `src/renderer/components/DetailPanel/DetailPanelContext.tsx` | 修改 | 新增 `referencedFilesHeight` 状态 |
| `src/renderer/components/DetailPanel/index.tsx` | 修改 | 切换为上下分栏布局 |
| `src/renderer/components/DetailPanel/detailPanel.css` | 修改 | 新增分栏布局和引用列表样式 |

---

### Task 1: 一次性脚本过滤逻辑

**Files:**
- Create: `src/renderer/components/DetailPanel/disposableScriptFilter.ts`
- Create: `src/renderer/components/DetailPanel/disposableScriptFilter.test.ts`

- [ ] **Step 1: 编写过滤逻辑的测试**

```typescript
// src/renderer/components/DetailPanel/disposableScriptFilter.test.ts
import { describe, it, expect } from 'vitest'
import { isDisposableScript } from './disposableScriptFilter'

describe('isDisposableScript', () => {
  // 规则 1：临时目录
  it('过滤 tmp/ 目录下的文件', () => {
    expect(isDisposableScript('tmp/output.txt')).toBe(true)
    expect(isDisposableScript('tmp/sub/file.py')).toBe(true)
  })

  it('过滤 temp/ 目录下的文件', () => {
    expect(isDisposableScript('temp/cache.json')).toBe(true)
  })

  it('过滤 .tmp/ 目录下的文件', () => {
    expect(isDisposableScript('.tmp/data.txt')).toBe(true)
  })

  // 规则 2：临时前缀
  it('过滤 tmp_ 前缀文件', () => {
    expect(isDisposableScript('tmp_result.json')).toBe(true)
    expect(isDisposableScript('src/tmp_data.py')).toBe(true)
  })

  it('过滤 temp_ 前缀文件', () => {
    expect(isDisposableScript('temp_data.py')).toBe(true)
    expect(isDisposableScript('utils/temp_output.json')).toBe(true)
  })

  // 规则 3：Agent 一次性脚本命名
  it('过滤 script_ 前缀脚本', () => {
    expect(isDisposableScript('script_fix_imports.py')).toBe(true)
    expect(isDisposableScript('src/script_helper.sh')).toBe(true)
  })

  it('过滤 run_ 前缀脚本', () => {
    expect(isDisposableScript('run_migrate.py')).toBe(true)
  })

  it('过滤 fix_ 前缀脚本', () => {
    expect(isDisposableScript('fix_bug.py')).toBe(true)
  })

  it('过滤 patch_ 前缀脚本', () => {
    expect(isDisposableScript('patch_config.py')).toBe(true)
  })

  it('过滤 migrate_ 前缀脚本', () => {
    expect(isDisposableScript('migrate_db.py')).toBe(true)
  })

  it('过滤 convert_ 前缀脚本', () => {
    expect(isDisposableScript('convert_csv.py')).toBe(true)
  })

  it('过滤 process_ 前缀脚本', () => {
    expect(isDisposableScript('process_data.py')).toBe(true)
  })

  it('过滤 generate_ 前缀脚本', () => {
    expect(isDisposableScript('generate_report.py')).toBe(true)
  })

  it('过滤 setup_ 前缀脚本', () => {
    expect(isDisposableScript('setup_env.py')).toBe(true)
  })

  // 规则 4：根/一级目录下的简短 Python 脚本
  it('过滤根目录下的简短 .py 文件', () => {
    expect(isDisposableScript('helper.py')).toBe(true)
    expect(isDisposableScript('utils/process.py')).toBe(true)
  })

  it('不过滤项目入口文件（白名单）', () => {
    expect(isDisposableScript('app.py')).toBe(false)
    expect(isDisposableScript('main.py')).toBe(false)
    expect(isDisposableScript('server.py')).toBe(false)
    expect(isDisposableScript('manage.py')).toBe(false)
    expect(isDisposableScript('wsgi.py')).toBe(false)
    expect(isDisposableScript('asgi.py')).toBe(false)
    expect(isDisposableScript('conftest.py')).toBe(false)
    expect(isDisposableScript('setup.py')).toBe(false)
    expect(isDisposableScript('__init__.py')).toBe(false)
    expect(isDisposableScript('__main__.py')).toBe(false)
  })

  it('不过滤深层目录下的 .py 文件', () => {
    expect(isDisposableScript('src/app/models.py')).toBe(false)
    expect(isDisposableScript('a/b/c/file.py')).toBe(false)
  })

  it('不过滤项目正常文件', () => {
    expect(isDisposableScript('src/index.ts')).toBe(false)
    expect(isDisposableScript('package.json')).toBe(false)
    expect(isDisposableScript('README.md')).toBe(false)
    expect(isDisposableScript('components/App.tsx')).toBe(false)
  })

  it('不过滤一级子目录下的白名单文件', () => {
    expect(isDisposableScript('app/app.py')).toBe(false)
    expect(isDisposableScript('src/main.py')).toBe(false)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/renderer/components/DetailPanel/disposableScriptFilter.test.ts`
Expected: FAIL — `isDisposableScript` 不存在

- [ ] **Step 3: 实现过滤逻辑**

```typescript
// src/renderer/components/DetailPanel/disposableScriptFilter.ts
/** 判断文件路径是否为 Agent 生成的一次性脚本 */
const DISPOSABLE_SCRIPT_PATTERNS: RegExp[] = [
  // 规则 1：临时目录
  /^(tmp|temp|\.tmp)\//,
  // 规则 2：临时前缀
  /(?:^|\/)(tmp|temp)_[\w-]+\.\w+$/,
  // 规则 3：Agent 一次性脚本命名
  /(?:^|\/)(script|run|fix|patch|migrate|convert|process|generate|setup)_[\w-]+\.\w+$/,
  // 规则 4：根/一级目录下的简短 Python 脚本
  /^[^/]+\/?[\w-]{1,32}\.py$/,
]

const PROJECT_ENTRY_FILES = new Set([
  'app.py', 'main.py', 'server.py', 'manage.py',
  'wsgi.py', 'asgi.py', 'conftest.py', 'setup.py',
  '__init__.py', '__main__.py',
])

export function isDisposableScript(filePath: string): boolean {
  // 规则 4 的白名单排除：若文件名在项目入口白名单中，则跳过规则 4
  const fileName = filePath.includes('/')
    ? filePath.slice(filePath.lastIndexOf('/') + 1)
    : filePath

  for (let i = 0; i < DISPOSABLE_SCRIPT_PATTERNS.length; i++) {
    if (i === 3 && PROJECT_ENTRY_FILES.has(fileName)) continue
    if (DISPOSABLE_SCRIPT_PATTERNS[i].test(filePath)) return true
  }
  return false
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/renderer/components/DetailPanel/disposableScriptFilter.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/renderer/components/DetailPanel/disposableScriptFilter.ts src/renderer/components/DetailPanel/disposableScriptFilter.test.ts
git commit -m "feat: 添加一次性脚本过滤逻辑"
```

---

### Task 2: useReferencedFiles Hook

**Files:**
- Create: `src/renderer/components/DetailPanel/useReferencedFiles.ts`
- Create: `src/renderer/components/DetailPanel/useReferencedFiles.test.ts`

- [ ] **Step 1: 编写 Hook 的测试**

```typescript
// src/renderer/components/DetailPanel/useReferencedFiles.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { Message, ToolCallRecord } from '../../../shared/domainTypes'
import { useReferencedFiles } from './useReferencedFiles'

// 工具调用工厂
function makeToolCall(overrides: Partial<ToolCallRecord> & Pick<ToolCallRecord, 'id' | 'toolName'>): ToolCallRecord {
  return {
    input: {},
    status: 'completed',
    riskLevel: 'low',
    ...overrides,
  } as ToolCallRecord
}

function makeMessage(toolCalls: ToolCallRecord[]): Message {
  return {
    id: `msg-${Math.random()}`,
    sessionId: 'sess-1',
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
    toolCalls,
    status: 'completed',
    schemaVersion: 1,
  }
}

// 简单的 mock store 测试：直接调用纯函数版本来测逻辑
// useReferencedFiles 内部的核心逻辑是 extractReferencedFiles 纯函数
import { extractReferencedFiles } from './useReferencedFiles'

describe('extractReferencedFiles', () => {
  it('从消息中提取 read_file 操作的文件', () => {
    const messages: Message[] = [
      makeMessage([
        makeToolCall({ id: 'tc-1', toolName: 'read_file', input: { path: 'src/index.ts' }, completedAt: 1000 }),
      ]),
    ]
    const result = extractReferencedFiles(messages)
    expect(result).toHaveLength(1)
    expect(result[0].path).toBe('src/index.ts')
    expect(result[0].lastOperation).toBe('read')
    expect(result[0].referenceCount).toBe(1)
  })

  it('从消息中提取 write_file 操作的文件', () => {
    const messages: Message[] = [
      makeMessage([
        makeToolCall({ id: 'tc-1', toolName: 'write_file', input: { path: 'output.txt' }, completedAt: 2000 }),
      ]),
    ]
    const result = extractReferencedFiles(messages)
    expect(result).toHaveLength(1)
    expect(result[0].path).toBe('output.txt')
    expect(result[0].lastOperation).toBe('write')
  })

  it('edit_file 归类为 write 操作', () => {
    const messages: Message[] = [
      makeMessage([
        makeToolCall({ id: 'tc-1', toolName: 'edit_file', input: { path: 'config.json' }, completedAt: 3000 }),
      ]),
    ]
    const result = extractReferencedFiles(messages)
    expect(result[0].lastOperation).toBe('write')
  })

  it('同一文件多次操作时去重并更新', () => {
    const messages: Message[] = [
      makeMessage([
        makeToolCall({ id: 'tc-1', toolName: 'read_file', input: { path: 'app.ts' }, completedAt: 1000 }),
        makeToolCall({ id: 'tc-2', toolName: 'edit_file', input: { path: 'app.ts' }, completedAt: 2000 }),
      ]),
    ]
    const result = extractReferencedFiles(messages)
    expect(result).toHaveLength(1)
    expect(result[0].lastReferencedAt).toBe(2000)
    expect(result[0].lastOperation).toBe('write')
    expect(result[0].referenceCount).toBe(2)
  })

  it('按 lastReferencedAt 倒序排列', () => {
    const messages: Message[] = [
      makeMessage([
        makeToolCall({ id: 'tc-1', toolName: 'read_file', input: { path: 'a.ts' }, completedAt: 1000 }),
        makeToolCall({ id: 'tc-2', toolName: 'read_file', input: { path: 'b.ts' }, completedAt: 3000 }),
        makeToolCall({ id: 'tc-3', toolName: 'read_file', input: { path: 'c.ts' }, completedAt: 2000 }),
      ]),
    ]
    const result = extractReferencedFiles(messages)
    expect(result.map((f) => f.path)).toEqual(['b.ts', 'c.ts', 'a.ts'])
  })

  it('忽略非 completed 状态的工具调用', () => {
    const messages: Message[] = [
      makeMessage([
        makeToolCall({ id: 'tc-1', toolName: 'read_file', input: { path: 'a.ts' }, status: 'failed', completedAt: 1000 }),
        makeToolCall({ id: 'tc-2', toolName: 'write_file', input: { path: 'b.ts' }, status: 'rejected', completedAt: 2000 }),
      ]),
    ]
    const result = extractReferencedFiles(messages)
    expect(result).toHaveLength(0)
  })

  it('忽略 input.path 为空的工具调用', () => {
    const messages: Message[] = [
      makeMessage([
        makeToolCall({ id: 'tc-1', toolName: 'read_file', input: {}, completedAt: 1000 }),
        makeToolCall({ id: 'tc-2', toolName: 'read_file', input: { path: '' }, completedAt: 2000 }),
      ]),
    ]
    const result = extractReferencedFiles(messages)
    expect(result).toHaveLength(0)
  })

  it('忽略 list_directory / grep / run_script 工具', () => {
    const messages: Message[] = [
      makeMessage([
        makeToolCall({ id: 'tc-1', toolName: 'list_directory', input: { path: 'src' }, completedAt: 1000 }),
        makeToolCall({ id: 'tc-2', toolName: 'grep', input: { path: 'src' }, completedAt: 2000 }),
        makeToolCall({ id: 'tc-3', toolName: 'run_script', input: { code: 'print(1)' }, completedAt: 3000 }),
      ]),
    ]
    const result = extractReferencedFiles(messages)
    expect(result).toHaveLength(0)
  })

  it('过滤一次性脚本', () => {
    const messages: Message[] = [
      makeMessage([
        makeToolCall({ id: 'tc-1', toolName: 'write_file', input: { path: 'script_fix.py' }, completedAt: 1000 }),
        makeToolCall({ id: 'tc-2', toolName: 'read_file', input: { path: 'src/index.ts' }, completedAt: 2000 }),
      ]),
    ]
    const result = extractReferencedFiles(messages)
    expect(result).toHaveLength(1)
    expect(result[0].path).toBe('src/index.ts')
  })

  it('处理无 toolCalls 的消息', () => {
    const messages: Message[] = [
      {
        id: 'msg-1',
        sessionId: 'sess-1',
        role: 'user',
        content: 'hello',
        timestamp: Date.now(),
        status: 'completed',
        schemaVersion: 1,
      },
    ]
    const result = extractReferencedFiles(messages)
    expect(result).toHaveLength(0)
  })

  it('无消息时返回空数组', () => {
    const result = extractReferencedFiles([])
    expect(result).toHaveLength(0)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/renderer/components/DetailPanel/useReferencedFiles.test.ts`
Expected: FAIL — `extractReferencedFiles` 不存在

- [ ] **Step 3: 实现 useReferencedFiles Hook 和 extractReferencedFiles 纯函数**

```typescript
// src/renderer/components/DetailPanel/useReferencedFiles.ts
import { useMemo } from 'react'
import { useTypedSelector } from '../../hooks'
import { isDisposableScript } from './disposableScriptFilter'

export interface ReferencedFile {
  /** 文件相对路径（相对于工作目录），作为唯一标识 */
  path: string
  /** 最近一次操作时间（Unix 毫秒时间戳） */
  lastReferencedAt: number
  /** 操作类型标记：最近一次操作是读还是写 */
  lastOperation: 'read' | 'write'
  /** 该文件被引用的总次数 */
  referenceCount: number
}

const FILE_REFERENCE_TOOLS = new Set(['read_file', 'write_file', 'edit_file'])

function getOperationType(toolName: string): 'read' | 'write' {
  return toolName === 'read_file' ? 'read' : 'write'
}

/** 从消息列表中提取引用文件（纯函数，便于测试） */
export function extractReferencedFiles(messages: import('../../../shared/domainTypes').Message[]): ReferencedFile[] {
  const map = new Map<string, ReferencedFile>()

  for (const msg of messages) {
    if (!msg.toolCalls) continue
    for (const tc of msg.toolCalls) {
      if (tc.status !== 'completed') continue
      if (!FILE_REFERENCE_TOOLS.has(tc.toolName)) continue
      const path = typeof tc.input.path === 'string' ? tc.input.path : ''
      if (!path) continue
      if (isDisposableScript(path)) continue

      const existing = map.get(path)
      const completedAt = tc.completedAt ?? 0
      const operation = getOperationType(tc.toolName)

      if (existing) {
        existing.referenceCount++
        if (completedAt > existing.lastReferencedAt) {
          existing.lastReferencedAt = completedAt
          existing.lastOperation = operation
        }
      } else {
        map.set(path, {
          path,
          lastReferencedAt: completedAt,
          lastOperation: operation,
          referenceCount: 1,
        })
      }
    }
  }

  return Array.from(map.values()).sort((a, b) => b.lastReferencedAt - a.lastReferencedAt)
}

/** 从当前会话消息中派生引用文件列表 */
export function useReferencedFiles(sessionId: string | null): ReferencedFile[] {
  const messages = useTypedSelector((s) => s.chat.messages)

  return useMemo(() => {
    if (!sessionId) return []
    const sessionMessages = messages.filter((m) => m.sessionId === sessionId)
    return extractReferencedFiles(sessionMessages)
  }, [messages, sessionId])
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/renderer/components/DetailPanel/useReferencedFiles.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/renderer/components/DetailPanel/useReferencedFiles.ts src/renderer/components/DetailPanel/useReferencedFiles.test.ts
git commit -m "feat: 添加 useReferencedFiles Hook 和引用文件提取逻辑"
```

---

### Task 3: ResizeHandle 组件

**Files:**
- Create: `src/renderer/components/DetailPanel/ResizeHandle.tsx`

- [ ] **Step 1: 实现 ResizeHandle 组件**

```typescript
// src/renderer/components/DetailPanel/ResizeHandle.tsx
import { useCallback, useRef } from 'react'

interface ResizeHandleProps {
  onResize: (ratio: number) => void
  minRatio?: number
  maxRatio?: number
  onDoubleClick?: () => void
}

export function ResizeHandle({ onResize, minRatio = 0.15, maxRatio = 0.85, onDoubleClick }: ResizeHandleProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const dragState = useRef<{ startY: number; startRatio: number; containerHeight: number } | null>(null)

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const container = containerRef.current?.parentElement
      if (!container) return
      dragState.current = {
        startY: e.clientY,
        startRatio: 0.5, // 由调用方通过当前 ratio 传入会更准确，但 flex 布局下用 containerHeight 计算更直接
        containerHeight: container.clientHeight,
      }

      const handleMouseMove = (ev: MouseEvent) => {
        if (!dragState.current) return
        const delta = ev.clientY - dragState.current.startY
        const ratio = 1 - (dragState.current.containerHeight - delta) / dragState.current.containerHeight
        const clamped = Math.min(maxRatio, Math.max(minRatio, ratio))
        onResize(clamped)
      }

      const handleMouseUp = () => {
        dragState.current = null
        document.removeEventListener('mousemove', handleMouseMove)
        document.removeEventListener('mouseup', handleMouseUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }

      document.body.style.cursor = 'row-resize'
      document.body.style.userSelect = 'none'
      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
    },
    [onResize, minRatio, maxRatio]
  )

  return (
    <div
      ref={containerRef}
      className="detail-resize-handle"
      onMouseDown={handleMouseDown}
      onDoubleClick={onDoubleClick}
    />
  )
}
```

- [ ] **Step 2: 提交**

```bash
git add src/renderer/components/DetailPanel/ResizeHandle.tsx
git commit -m "feat: 添加 ResizeHandle 可拖动分隔条组件"
```

---

### Task 4: ReferencedFileItem 组件

**Files:**
- Create: `src/renderer/components/DetailPanel/ReferencedFileItem.tsx`

- [ ] **Step 1: 实现 ReferencedFileItem 组件**

```typescript
// src/renderer/components/DetailPanel/ReferencedFileItem.tsx
import { Tooltip } from 'antd'
import fileLineRaw from '../../assets/file_line.svg?raw'
import { patchSvg } from '../../utils/patchSvg'
import type { ReferencedFile } from './useReferencedFiles'

const fileSvg = patchSvg(fileLineRaw, 14)

interface ReferencedFileItemProps {
  file: ReferencedFile
  isActive: boolean
  onClick: () => void
}

export function ReferencedFileItem({ file, isActive, onClick }: ReferencedFileItemProps) {
  const fileName = file.path.includes('/')
    ? file.path.slice(file.path.lastIndexOf('/') + 1)
    : file.path

  return (
    <div
      className={`referenced-file-item${isActive ? ' referenced-file-item--active' : ''}`}
      onClick={onClick}
    >
      <span className="referenced-file-item-icon" dangerouslySetInnerHTML={{ __html: fileSvg }} />
      <div className="referenced-file-item-info">
        <Tooltip title={file.path} mouseEnterDelay={0.5}>
          <span className="referenced-file-item-name">{fileName}</span>
        </Tooltip>
        <Tooltip title={file.path} mouseEnterDelay={0.5}>
          <span className="referenced-file-item-path">{file.path}</span>
        </Tooltip>
      </div>
      <span className={`referenced-file-item-op referenced-file-item-op--${file.lastOperation}`}>
        <span className="referenced-file-item-dot" />
        {file.lastOperation === 'read' ? '读取' : '写入'}
      </span>
    </div>
  )
}
```

- [ ] **Step 2: 提交**

```bash
git add src/renderer/components/DetailPanel/ReferencedFileItem.tsx
git commit -m "feat: 添加 ReferencedFileItem 单个文件条目组件"
```

---

### Task 5: ReferencedFilesPanel 组件

**Files:**
- Create: `src/renderer/components/DetailPanel/ReferencedFilesPanel.tsx`

- [ ] **Step 1: 实现 ReferencedFilesPanel 组件**

```typescript
// src/renderer/components/DetailPanel/ReferencedFilesPanel.tsx
import { Typography } from 'antd'
import { useDetailPanel } from './DetailPanelContext'
import { useReferencedFiles } from './useReferencedFiles'
import { ReferencedFileItem } from './ReferencedFileItem'

interface ReferencedFilesPanelProps {
  sessionId: string | null
}

export function ReferencedFilesPanel({ sessionId }: ReferencedFilesPanelProps) {
  const files = useReferencedFiles(sessionId)
  const { selectedFile, openFile } = useDetailPanel()

  const handleFileClick = (path: string) => {
    if (path === selectedFile) return
    void openFile(path)
  }

  return (
    <div className="referenced-files-panel">
      <div className="referenced-files-header">
        <span className="referenced-files-title">引用的文件</span>
        {files.length > 0 && (
          <span className="referenced-files-count">{files.length}</span>
        )}
      </div>
      <div className="referenced-files-list">
        {files.length === 0 ? (
          <div className="referenced-files-empty">
            <Typography.Text type="secondary">暂无引用的文件</Typography.Text>
          </div>
        ) : (
          files.map((file) => (
            <ReferencedFileItem
              key={file.path}
              file={file}
              isActive={file.path === selectedFile}
              onClick={() => handleFileClick(file.path)}
            />
          ))
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: 提交**

```bash
git add src/renderer/components/DetailPanel/ReferencedFilesPanel.tsx
git commit -m "feat: 添加 ReferencedFilesPanel 引用文件列表面板组件"
```

---

### Task 6: DetailPanelContext 扩展高度比例状态

**Files:**
- Modify: `src/renderer/components/DetailPanel/DetailPanelContext.tsx`

- [ ] **Step 1: 在 DetailPanelContext 中新增 referencedFilesHeight 状态和 setReferencedFilesHeight action**

在 `DetailPanelState` 类型中新增：
```typescript
referencedFilesHeight: number  // 下半区高度占比（0~1），默认 0.5
```

在 `DetailPanelActions` 类型中新增：
```typescript
setReferencedFilesHeight: (ratio: number) => void
resetReferencedFilesHeight: () => void
```

在 `DetailPanelProvider` 中新增状态：
```typescript
const [referencedFilesHeight, setReferencedFilesHeightState] = useState(0.5)
const setReferencedFilesHeight = useCallback((ratio: number) => {
  setReferencedFilesHeightState(Math.min(0.85, Math.max(0.15, ratio)))
}, [])
const resetReferencedFilesHeight = useCallback(() => {
  setReferencedFilesHeightState(0.5)
}, [])
```

在 `useMemo` 的 value 和 deps 中加入 `referencedFilesHeight`、`setReferencedFilesHeight`、`resetReferencedFilesHeight`。

- [ ] **Step 2: 提交**

```bash
git add src/renderer/components/DetailPanel/DetailPanelContext.tsx
git commit -m "feat: DetailPanelContext 新增引用文件面板高度比例状态"
```

---

### Task 7: DetailPanel 布局改造 + CSS 样式

**Files:**
- Modify: `src/renderer/components/DetailPanel/index.tsx`
- Modify: `src/renderer/components/DetailPanel/detailPanel.css`

- [ ] **Step 1: 修改 DetailPanel/index.tsx 为上下分栏布局**

```typescript
// src/renderer/components/DetailPanel/index.tsx
import { Typography } from 'antd'
import { useDetailPanel } from './DetailPanelContext'
import { FileOverlay } from './FileOverlay'
import { ReferencedFilesPanel } from './ReferencedFilesPanel'
import { ResizeHandle } from './ResizeHandle'
import { useTypedSelector } from '../../hooks'
import './detailPanel.css'

export { DetailPanelProvider, useDetailPanel } from './DetailPanelContext'

export function DetailPanel() {
  const { selectedFile, referencedFilesHeight, setReferencedFilesHeight, resetReferencedFilesHeight } = useDetailPanel()
  const currentSessionId = useTypedSelector((s) => s.chat.currentSessionId)

  if (selectedFile) {
    return <FileOverlay />
  }

  return (
    <div className="detail-panel-split">
      <div
        className="detail-panel-top"
        style={{ flex: 1 - referencedFilesHeight }}
      >
        <div className="detail-panel-placeholder">
          <Typography.Text type="secondary">选择文件以预览内容</Typography.Text>
        </div>
      </div>
      <ResizeHandle
        onResize={setReferencedFilesHeight}
        onDoubleClick={resetReferencedFilesHeight}
      />
      <div
        className="detail-panel-bottom"
        style={{ flex: referencedFilesHeight }}
      >
        <ReferencedFilesPanel sessionId={currentSessionId} />
      </div>
    </div>
  )
}
```

- [ ] **Step 2: 在 detailPanel.css 中新增分栏布局和引用列表样式**

在现有 CSS 末尾追加：

```css
/* ===== 分栏布局 ===== */
.detail-panel-split {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.detail-panel-top {
  min-height: 80px;
  overflow: hidden;
}

.detail-panel-bottom {
  min-height: 80px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

/* ===== 可拖动分隔条 ===== */
.detail-resize-handle {
  flex-shrink: 0;
  height: 4px;
  background: var(--sa-border);
  cursor: row-resize;
  transition: background var(--sa-duration-fast);
}

.detail-resize-handle:hover {
  background: var(--sa-primary);
}

/* ===== 引用文件面板 ===== */
.referenced-files-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.referenced-files-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--sa-border);
  flex-shrink: 0;
}

.referenced-files-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--sa-text-secondary);
}

.referenced-files-count {
  font-size: 10px;
  line-height: 16px;
  padding: 0 4px;
  border-radius: 8px;
  background: var(--sa-bg-muted);
  color: var(--sa-text-tertiary);
}

.referenced-files-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.referenced-files-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px 12px;
}

/* ===== 文件条目 ===== */
.referenced-file-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  cursor: pointer;
  transition: background var(--sa-duration-fast);
}

.referenced-file-item:hover {
  background: var(--sa-bg-muted);
}

.referenced-file-item--active {
  background: var(--sa-primary-subtle);
}

.referenced-file-item-icon {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  color: var(--sa-text-secondary);
}

.referenced-file-item-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0;
  overflow: hidden;
}

.referenced-file-item-name {
  font-size: 12px;
  color: var(--sa-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.referenced-file-item-path {
  font-size: 10px;
  color: var(--sa-text-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.referenced-file-item-op {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 3px;
  font-size: 10px;
  color: var(--sa-text-tertiary);
}

.referenced-file-item-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}

.referenced-file-item-op--read .referenced-file-item-dot {
  background: #52c41a;
}

.referenced-file-item-op--write .referenced-file-item-dot {
  background: #fa8c16;
}
```

- [ ] **Step 3: 提交**

```bash
git add src/renderer/components/DetailPanel/index.tsx src/renderer/components/DetailPanel/detailPanel.css
git commit -m "feat: DetailPanel 改造为上下分栏布局并添加引用文件列表"
```

---

### Task 8: 端到端验证

**Files:** 无新文件

- [ ] **Step 1: 运行全部测试确认无回归**

Run: `npx vitest run`
Expected: 全部 PASS

- [ ] **Step 2: 启动开发服务器进行手动验证**

Run: `npm run dev:renderer`

验证清单：
1. 右侧栏显示上下分栏布局：上半区占位符 + 下半区「引用的文件」面板
2. 「引用的文件」面板显示「暂无引用的文件」
3. 分隔条可拖动，hover 高亮
4. 双击分隔条恢复 50%/50%
5. 在聊天中触发 AI 读写文件操作后，引用列表自动更新
6. 点击引用列表中的文件，FileOverlay 覆盖全栏
7. 关闭文件后恢复分栏布局
8. 当前打开的文件在列表中高亮

- [ ] **Step 3: 提交（如有修复）**

```bash
git add -u
git commit -m "fix: 引用文件面板端到端验证修复"
```

---

## Self-Review

### 1. Spec Coverage

| 需求 | 对应 Task |
|------|-----------|
| 3.1 数据采集（从 toolCalls 提取） | Task 2 |
| 3.1.2 去重规则 | Task 2 |
| 3.1.3 排序规则（倒序） | Task 2 |
| 3.1.4 操作类型定义 | Task 2 |
| 3.2 一次性脚本过滤 | Task 1 |
| 3.3 面板布局（上下分栏） | Task 7 |
| 3.3.2 默认高度 50%/50% | Task 6, 7 |
| 3.3.3 拖动调整高度 | Task 3, 7 |
| 3.4 文件查看器覆盖全栏 | Task 7 |
| 3.5 文件点击打开 | Task 5 |
| 3.6 条目样式 | Task 4, 7 |
| 6.2 双击恢复默认 | Task 3, 7 |

### 2. Placeholder Scan

无 TBD、TODO 或占位符。

### 3. Type Consistency

- `ReferencedFile` 接口在 Task 2 定义，Task 4/5 使用 — 一致
- `extractReferencedFiles` 在 Task 2 导出，Task 2 测试中导入 — 一致
- `isDisposableScript` 在 Task 1 导出，Task 2 中导入 — 一致
- `ResizeHandle` props `onResize(ratio: number)` 与 `setReferencedFilesHeight(ratio: number)` 一致
- `ReferencedFileItem` props `file: ReferencedFile` 与 `useReferencedFiles` 返回类型一致
