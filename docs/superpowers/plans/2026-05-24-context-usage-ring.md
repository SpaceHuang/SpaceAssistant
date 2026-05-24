# 上下文使用量展示器 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在消息输入区域发送按钮左侧添加三层 SVG 环形图，展示当前会话的上下文 token 用量（已用输入/输出预留/剩余空间），hover 显示用量明细 Tooltip。

**Architecture:** 采用方案 A — Redux `chatSlice.lastUsage` 存储原始 API usage 数据，`ContextUsageRing` 组件从 Redux 读取并计算环形比例。三条数据路径（工具模式返回值、Plan 模式返回值、流式模式 `claude-chat-done` 事件）均 dispatch `setLastUsage`。

**Tech Stack:** React 18 + TypeScript + Redux Toolkit + Vitest + @testing-library/react + jsdom

---

### Task 1: 扩展 chatSlice — 新增 lastUsage 状态

**Files:**
- Modify: `src/renderer/store/chatSlice.ts`

- [ ] **Step 1: 新增类型、状态字段、reducer 和 action**

在 `chatSlice.ts` 中：

1. 在 `ChatState` 接口中新增 `lastUsage` 字段（放在 `confirmFocusToolUseId` 之后）。
2. 在 `initialState` 中初始化为 `null`。
3. 新增 `setLastUsage` reducer。
4. 在 `setSession` reducer 中添加 `state.lastUsage = null`。
5. 在 `resetChatUi` reducer 中添加 `state.lastUsage = null`。
6. 在导出列表中添加 `setLastUsage`。

```typescript
import { createSlice, type PayloadAction } from '@reduxjs/toolkit'
import type { Message } from '../../shared/domainTypes'

export type ChatStatus = 'idle' | 'sending' | 'streaming' | 'completed' | 'error'

export type RunningSessionMeta = {
  requestId: string
  status: 'streaming' | 'error'
  updatedAt: number
}

export type LastUsage = {
  input_tokens: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
} | null

interface ChatState {
  messages: Message[]
  currentSessionId: string | null
  chatStatus: ChatStatus
  error: string | null
  runningSessions: Record<string, RunningSessionMeta>
  confirmFocusToolUseId: string | null
  lastUsage: LastUsage
}

const initialState: ChatState = {
  messages: [],
  currentSessionId: null,
  chatStatus: 'idle',
  error: null,
  runningSessions: {},
  confirmFocusToolUseId: null,
  lastUsage: null
}

export const chatSlice = createSlice({
  name: 'chat',
  initialState,
  reducers: {
    setSession(state, action: PayloadAction<string | null>) {
      state.currentSessionId = action.payload
      state.confirmFocusToolUseId = null
      state.lastUsage = null
    },
    setConfirmFocusToolUseId(state, action: PayloadAction<string | null>) {
      state.confirmFocusToolUseId = action.payload
    },
    setLastUsage(state, action: PayloadAction<LastUsage>) {
      state.lastUsage = action.payload
    },
    // ... 其余现有 reducers 保持不变
    resetChatUi(state) {
      state.messages = []
      state.chatStatus = 'idle'
      state.error = null
      state.runningSessions = {}
      state.confirmFocusToolUseId = null
      state.lastUsage = null
    }
  }
})

export const {
  setSession,
  setMessages,
  addMessage,
  patchMessage,
  setChatStatus,
  setConfirmFocusToolUseId,
  setLastUsage,
  removeRunningSession,
  resetChatUi
} = chatSlice.actions
export default chatSlice.reducer
```

**注意**：只需展示改动部分，现有 reducer（`setMessages`、`addMessage`、`patchMessage`、`setChatStatus`、`removeRunningSession`）保持不变。使用 Edit 工具精确修改：
- 在 `confirmFocusToolUseId` 后添加 `lastUsage` 字段（interface 和 initialState）
- 添加 `setLastUsage` reducer
- 在 `setSession` 和 `resetChatUi` 中添加 `state.lastUsage = null`
- 导出列表中添加 `setLastUsage`

- [ ] **Step 2: TypeScript 编译检查**

```bash
npx tsc --noEmit --project tsconfig.json 2>&1 | head -30
```

预期：无新增类型错误（`src/renderer/store/chatSlice.ts` 相关）。

- [ ] **Step 3: Commit**

```bash
git add src/renderer/store/chatSlice.ts
git commit -m "feat: chatSlice 新增 lastUsage 状态和 setLastUsage action"
```

---

### Task 2: 更新 chatSlice 单元测试

**Files:**
- Modify: `src/renderer/store/chatSlice.test.ts`

- [ ] **Step 1: 在现有 describe 中添加 4 个测试用例**

在 `describe('chatSlice', () => {` 块末尾（`removeRunningSession` 测试之后）追加：

```typescript
  it('setLastUsage stores usage data', () => {
    const base = chatReducer(undefined, setSession('s1'))
    const next = chatReducer(base, setLastUsage({ input_tokens: 5000, output_tokens: 3000 }))
    expect(next.lastUsage).toEqual({ input_tokens: 5000, output_tokens: 3000 })
  })

  it('setLastUsage(null) clears usage', () => {
    const base = chatReducer(undefined, setSession('s1'))
    const withData = chatReducer(base, setLastUsage({ input_tokens: 5000 }))
    const cleared = chatReducer(withData, setLastUsage(null))
    expect(cleared.lastUsage).toBeNull()
  })

  it('setSession resets lastUsage', () => {
    const base = chatReducer(undefined, setSession('s1'))
    const withData = chatReducer(base, setLastUsage({ input_tokens: 5000 }))
    const switched = chatReducer(withData, setSession('s2'))
    expect(switched.lastUsage).toBeNull()
  })

  it('resetChatUi resets lastUsage', () => {
    let state = chatReducer(undefined, setSession('s1'))
    state = chatReducer(state, setLastUsage({ input_tokens: 5000 }))
    state = chatReducer(state, resetChatUi())
    expect(state.lastUsage).toBeNull()
  })
```

同时更新顶部 import，将 `setLastUsage, resetChatUi` 加入解构导入：

```typescript
import chatReducer, { addMessage, setChatStatus, setSession, removeRunningSession, setLastUsage, resetChatUi } from './chatSlice'
```

- [ ] **Step 2: 运行测试验证通过**

```bash
npx vitest run src/renderer/store/chatSlice.test.ts
```

预期：7 个测试全部 PASS（原有 3 个 + 新增 4 个）。

- [ ] **Step 3: Commit**

```bash
git add src/renderer/store/chatSlice.test.ts
git commit -m "test: 新增 lastUsage 相关 reducer 单元测试"
```

---

### Task 3: 扩展 claude-chat-done 事件携带 usage

**Files:**
- Modify: `electron/claudeStreamHandlers.ts`
- Modify: `src/shared/api.ts`
- Modify: `src/renderer/services/chatStreamService.ts`

- [ ] **Step 1: 修改主进程 — runSendStream 中 claude-chat-done 事件追加 usage**

在 `electron/claudeStreamHandlers.ts` 的 `runSendStream` 函数中，找到：

```typescript
sender.send('claude-chat-done', { requestId })
```

（约第 405 行），改为：

```typescript
sender.send('claude-chat-done', { requestId, usage: usage ?? null })
```

此处的 `usage` 变量已在函数上方通过 `normalizeAnthropicMessageUsage(res)` 赋值（约第 395 行），无需额外改动。

- [ ] **Step 2: 修改类型 — api.ts 中 claudeChatOnDone 回调类型**

在 `src/shared/api.ts` 找到第 109 行：

```typescript
claudeChatOnDone: (cb: (data: { requestId: string }) => void) => () => void
```

改为：

```typescript
claudeChatOnDone: (cb: (data: { requestId: string; usage?: unknown }) => void) => () => void
```

- [ ] **Step 3: 更新 ChatView 中 onDone 回调取 usage**

在 `src/renderer/components/Chat/ChatView.tsx` 的 `sendInternal` 中，找到流式模式的 `onDone` 回调（约第 537 行）：

```typescript
onDone: async () => {
```

改为：

```typescript
onDone: async (data) => {
```

并在回调体开头（`flushStreamPersist` 之前）添加：

```typescript
if (data?.usage) {
  dispatch(setLastUsage(data.usage as LastUsage))
}
```

需要在文件顶部 import 中添加 `setLastUsage`：

```typescript
import { addMessage, setChatStatus, setConfirmFocusToolUseId, setLastUsage, setMessages } from '../../store/chatSlice'
```

以及类型导入：

```typescript
import type { LastUsage } from '../../store/chatSlice'
```

- [ ] **Step 4: 验证 chatStreamService 无需改动**

`src/renderer/services/chatStreamService.ts` 中的 `onDone` 回调只是透传事件数据，`claudeChatOnDone` 监听器直接将事件数据传给回调，类型更新后自动携带 `usage` 字段。**无需改动此文件**。

- [ ] **Step 5: TypeScript 编译检查**

```bash
npx tsc --noEmit --project tsconfig.json 2>&1 | head -30
npx tsc --noEmit --project tsconfig.electron.json 2>&1 | head -30
```

预期：无新增类型错误。

- [ ] **Step 6: Commit**

```bash
git add electron/claudeStreamHandlers.ts src/shared/api.ts src/renderer/components/Chat/ChatView.tsx
git commit -m "feat: 流式模式 claude-chat-done 事件携带 usage 数据"
```

---

### Task 4: 工具模式和 Plan 模式 dispatch usage，以及会话切换重置

**Files:**
- Modify: `src/renderer/components/Chat/ChatView.tsx`

- [ ] **Step 1: 工具模式成功后 dispatch usage**

在 `sendInternal` 的工具模式成功分支中（约第 470 行，`dispatch(setChatStatus({ status: 'completed' ...` 之前），添加：

```typescript
if (res.usage) {
  dispatch(setLastUsage(res.usage as LastUsage))
}
```

完整上下文（在 `extractAssistantTextFromApiContent` 调用和 `flushStreamPersist` 之后）：

```typescript
          const textOut = extractAssistantTextFromApiContent(res.content as unknown[]) || contentState.content
          if (textOut !== contentState.content) {
            contentState = { ...contentState, content: textOut }
          }
          flushStreamPersist(runSessionId, assistantId)
          if (res.usage) {
            dispatch(setLastUsage(res.usage as LastUsage))
          }
          const assistantRow = findAssistantRow()
          // ... 后续不变
```

- [ ] **Step 2: Plan 模式成功后 dispatch usage**

在 `runPlanWorkerWithoutNewUser` 的成功分支中（约第 677 行，`extractAssistantTextFromApiContent` 之后），添加：

```typescript
    const textOut = extractAssistantTextFromApiContent(res.content as unknown[])
    if (res.usage) {
      dispatch(setLastUsage(res.usage as LastUsage))
    }
    routePatchMessage(runSessionId, assistantId, { content: textOut, status: 'completed' })
```

- [ ] **Step 3: 确认会话切换时 lastUsage 自动重置**

`setSession` 已在 `App.tsx:79`、`PendingConfirmBanner`、`PendingPlanBanner`、`FileOverlay` 等多处 dispatch。Task 1 已在 `setSession` reducer 中添加 `state.lastUsage = null`，因此切换会话时自动重置，**无需额外改动**。

- [ ] **Step 4: TypeScript 编译检查**

```bash
npx tsc --noEmit --project tsconfig.json 2>&1 | head -30
```

预期：无新增类型错误。

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/Chat/ChatView.tsx
git commit -m "feat: 工具模式和 Plan 模式完成后 dispatch usage 到 Redux"
```

---

### Task 5: 创建 ContextUsageRing 组件

**Files:**
- Create: `src/renderer/components/Chat/ContextUsageRing.tsx`

- [ ] **Step 1: 编写组件**

```typescript
import { useMemo } from 'react'
import { Tooltip } from 'antd'
import { useTypedSelector } from '../../hooks'
import type { LastUsage } from '../../store/chatSlice'

const RING_SIZE = 28
const CENTER = RING_SIZE / 2
const RADII = [11, 8, 5] // 外、中、内三层半径
const STROKE_WIDTHS = [3, 2.5, 2]

function formatNum(n: number): string {
  return n.toLocaleString('zh-CN')
}

function buildTooltipContent(
  usage: NonNullable<LastUsage>,
  currentModel: { name: string; maximumContext: number } | undefined
): string {
  const max = currentModel?.maximumContext
  const lines: string[] = []
  lines.push(`输入消耗　${formatNum(usage.input_tokens)}`)
  if (usage.output_tokens != null) {
    lines.push(`输出消耗　${formatNum(usage.output_tokens)}`)
  }
  if (usage.cache_read_input_tokens && usage.cache_read_input_tokens > 0) {
    lines.push(`缓存命中　${formatNum(usage.cache_read_input_tokens)}`)
  }
  if (usage.cache_creation_input_tokens && usage.cache_creation_input_tokens > 0) {
    lines.push(`缓存写入　${formatNum(usage.cache_creation_input_tokens)}`)
  }
  if (max != null) {
    const pct = ((usage.input_tokens / max) * 100).toFixed(1)
    lines.push(`─────────`)
    lines.push(`总计 ${formatNum(usage.input_tokens)} / ${formatNum(max)}（${pct}%）`)
  }
  return lines.join('\n')
}

export function ContextUsageRing() {
  const lastUsage = useTypedSelector((s) => s.chat.lastUsage)
  const config = useTypedSelector((s) => s.config.config)

  const currentModel = useMemo(() => {
    if (!config) return undefined
    return config.models.find((m) => m.name === config.model)
  }, [config])

  const maximumContext = currentModel?.maximumContext
  const maxTokens = config?.maxTokens

  const hasData = lastUsage != null && maximumContext != null && maximumContext > 0

  const tooltipTitle = useMemo(() => {
    if (!hasData || !lastUsage) return '暂无上下文用量数据'
    return (
      <pre style={{ margin: 0, fontFamily: 'inherit', whiteSpace: 'pre', lineHeight: 1.6 }}>
        {buildTooltipContent(lastUsage, currentModel)}
      </pre>
    )
  }, [hasData, lastUsage, currentModel])

  // 计算三层环的 stroke-dasharray 比例
  const layers = useMemo(() => {
    if (!hasData || !lastUsage || !maximumContext || !maxTokens) {
      // 无数据：仅浅灰底色环
      return [{ color: '#ddd', ratio: 1 }]
    }

    const total = maximumContext
    let inputRatio = lastUsage.input_tokens / total
    let reservedRatio = maxTokens / total

    // 边界保护：超出时按比例压缩
    if (inputRatio + reservedRatio > 1) {
      const scale = 1 / (inputRatio + reservedRatio)
      inputRatio *= scale
      reservedRatio *= scale
    }

    const freeRatio = Math.max(0, 1 - inputRatio - reservedRatio)

    return [
      { color: 'var(--sa-primary)', ratio: inputRatio },
      { color: '#666', ratio: reservedRatio },
      { color: '#ddd', ratio: freeRatio }
    ]
  }, [hasData, lastUsage, maximumContext, maxTokens])

  return (
    <Tooltip title={tooltipTitle} placement="top">
      <span style={{ display: 'inline-flex', alignItems: 'center', lineHeight: 0 }}>
        <svg width={RING_SIZE} height={RING_SIZE} viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}>
          {layers.map((layer, i) => {
            const r = RADII[i] ?? RADII[0]
            const sw = STROKE_WIDTHS[i] ?? STROKE_WIDTHS[0]
            const circumference = 2 * Math.PI * r
            const dashLen = circumference * layer.ratio
            const gapLen = circumference - dashLen
            return (
              <circle
                key={i}
                cx={CENTER}
                cy={CENTER}
                r={r}
                fill="none"
                stroke={layer.color}
                strokeWidth={sw}
                strokeDasharray={`${dashLen} ${gapLen}`}
                strokeLinecap="butt"
                transform={`rotate(-90 ${CENTER} ${CENTER})`}
              />
            )
          })}
        </svg>
      </span>
    </Tooltip>
  )
}
```

- [ ] **Step 2: TypeScript 编译检查**

```bash
npx tsc --noEmit --project tsconfig.json 2>&1 | head -30
```

预期：无新增类型错误。

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/Chat/ContextUsageRing.tsx
git commit -m "feat: 新增 ContextUsageRing 上下文用量环形组件"
```

---

### Task 6: 将 ContextUsageRing 嵌入 MessageInput

**Files:**
- Modify: `src/renderer/components/Chat/MessageInput.tsx`

- [ ] **Step 1: 在 composer-footer 的发送按钮左侧插入组件**

在 `MessageInput.tsx` 顶部添加 import：

```typescript
import { ContextUsageRing } from './ContextUsageRing'
```

在 composer-footer 中，在左侧内容区和发送按钮之间插入 `<ContextUsageRing />`：

```tsx
        <div className="composer-footer">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flexWrap: 'wrap' }}>
            <Select ... />
            {modelLabel ? <span className="composer-model-chip">{modelLabel}</span> : null}
            <span className="composer-hint">{...}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <ContextUsageRing />
            <button
              type="button"
              className={`composer-send${running ? ' composer-send--stop' : ''}`}
              onClick={handlePrimaryAction}
              ...
            >
              ...
            </button>
          </div>
        </div>
```

注意：需要将发送按钮和 ContextUsageRing 用一个 `display: flex; gap: 8px` 的容器包裹，以保持 8px 间距。

- [ ] **Step 2: TypeScript 编译检查**

```bash
npx tsc --noEmit --project tsconfig.json 2>&1 | head -30
```

预期：无新增类型错误。

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/Chat/MessageInput.tsx
git commit -m "feat: MessageInput 嵌入 ContextUsageRing 组件"
```

---

### Task 7: 编写 ContextUsageRing 组件测试

**Files:**
- Create: `src/renderer/components/Chat/ContextUsageRing.test.tsx`

- [ ] **Step 1: 编写测试文件**

```typescript
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import chatReducer, { setLastUsage, setSession } from '../../store/chatSlice'
import configReducer, { setConfig } from '../../store/configSlice'
import { ContextUsageRing } from './ContextUsageRing'
import type { AppConfig } from '../../../shared/domainTypes'

function createStore(lastUsage = null as Parameters<typeof setLastUsage>[0], configOverrides: Partial<AppConfig> = {}) {
  const config: AppConfig = {
    apiKeyPresent: true,
    baseUrl: '',
    model: 'claude-sonnet-4-6',
    defaultModel: 'claude-sonnet-4-6',
    models: [
      { id: '1', name: 'claude-sonnet-4-6', maximumContext: 200000, maxTokens: 64000, isDefault: false, isFast: false, enabled: true }
    ],
    temperature: 0,
    maxTokens: 4096,
    thinkingEnabled: false,
    workDir: '',
    defaultChatMode: 'normal',
    maxParallelChatSessions: 3,
    tools: { enabled: false, confirmMode: 'direct' },
    skills: { enabled: false },
    ...configOverrides
  }
  const store = configureStore({
    reducer: { chat: chatReducer, config: configReducer }
  })
  store.dispatch(setConfig(config))
  if (lastUsage !== null) {
    store.dispatch(setLastUsage(lastUsage))
  }
  return store
}

function renderRing(lastUsage?: Parameters<typeof setLastUsage>[0], configOverrides?: Partial<AppConfig>) {
  const store = createStore(lastUsage, configOverrides)
  return render(
    <Provider store={store}>
      <ContextUsageRing />
    </Provider>
  )
}

describe('ContextUsageRing', () => {
  it('renders single gray ring when no usage data', () => {
    renderRing()
    const circles = document.querySelectorAll('circle')
    expect(circles).toHaveLength(1)
    // 浅灰底色环
    expect(circles[0]?.getAttribute('stroke')).toBe('#ddd')
  })

  it('renders three layers when usage data is available', () => {
    renderRing({ input_tokens: 10000, output_tokens: 5000 })
    const circles = document.querySelectorAll('circle')
    expect(circles).toHaveLength(3)
    // 检查颜色
    const colors = Array.from(circles).map((c) => c.getAttribute('stroke'))
    expect(colors).toContain('var(--sa-primary)')
    expect(colors).toContain('#666')
    expect(colors).toContain('#ddd')
  })

  it('clamps layers when input + reserved exceeds maximumContext', () => {
    // input_tokens (190000) + maxTokens (4096) ≈ 194096 < 200000，不超
    // 但如果我们让 input 超限... 实际 input_tokens 不应该超过 maximumContext
    // 测试 input_tokens + maxTokens > maximumContext 的情况
    renderRing(
      { input_tokens: 199000, output_tokens: 1000 },
      { maxTokens: 64000 } // override maxTokens
    )
    // 199000 + 64000 = 263000 > 200000，应该不外溢
    const circles = document.querySelectorAll('circle')
    expect(circles).toHaveLength(3)
    // 所有 layer 都应该有 strokeDasharray
    circles.forEach((c) => {
      const dash = c.getAttribute('stroke-dasharray')
      expect(dash).toBeTruthy()
    })
  })

  it('shows no-data tooltip on hover', async () => {
    renderRing()
    const svg = document.querySelector('svg')!
    fireEvent.mouseEnter(svg)
    // Ant Design Tooltip 异步渲染，等待出现
    const tooltip = await screen.findByText('暂无上下文用量数据')
    expect(tooltip).toBeDefined()
  })

  it('shows tooltip with token details on hover', async () => {
    renderRing({ input_tokens: 12345, output_tokens: 4567, cache_read_input_tokens: 2000 })
    const svg = document.querySelector('svg')!
    fireEvent.mouseEnter(svg)
    const tooltip = await screen.findByText(/输入消耗/)
    expect(tooltip).toBeDefined()
    expect(screen.getByText(/12,345/)).toBeDefined()
    expect(screen.getByText(/4,567/)).toBeDefined()
    expect(screen.getByText(/2,000/)).toBeDefined()
    expect(screen.queryByText(/缓存写入/)).toBeNull()
  })

  it('shows cache creation only when > 0', async () => {
    renderRing({ input_tokens: 100, cache_creation_input_tokens: 500 })
    const svg = document.querySelector('svg')!
    fireEvent.mouseEnter(svg)
    const tooltip = await screen.findByText(/缓存写入/)
    expect(tooltip).toBeDefined()
    expect(screen.getByText(/500/)).toBeDefined()
  })

  it('does not crash when model list is empty', () => {
    renderRing({ input_tokens: 100 }, { models: [] })
    const circles = document.querySelectorAll('circle')
    expect(circles).toHaveLength(1) // 仅底色环，不崩溃
    expect(circles[0]?.getAttribute('stroke')).toBe('#ddd')
  })

  it('resets to empty ring when lastUsage becomes null after session switch', () => {
    const store = createStore({ input_tokens: 5000 })
    const { rerender } = render(
      <Provider store={store}>
        <ContextUsageRing />
      </Provider>
    )
    expect(document.querySelectorAll('circle')).toHaveLength(3)

    // 模拟切换会话
    store.dispatch(setSession('new-session'))
    rerender(
      <Provider store={store}>
        <ContextUsageRing />
      </Provider>
    )
    const circles = document.querySelectorAll('circle')
    expect(circles).toHaveLength(1)
    expect(circles[0]?.getAttribute('stroke')).toBe('#ddd')
  })
})
```

- [ ] **Step 2: 运行测试**

```bash
npx vitest run src/renderer/components/Chat/ContextUsageRing.test.tsx
```

预期：8 个测试全部 PASS。

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/Chat/ContextUsageRing.test.tsx
git commit -m "test: 新增 ContextUsageRing 组件测试和集成测试"
```

---

### Task 8: 运行全部测试做最终验证

- [ ] **Step 1: 运行全部测试**

```bash
npx vitest run
```

预期：所有已有测试和新增测试全部 PASS。

- [ ] **Step 2: 运行 TypeScript 类型检查**

```bash
npx tsc --noEmit --project tsconfig.json && npx tsc --noEmit --project tsconfig.electron.json
```

预期：无类型错误。

- [ ] **Step 3: Commit（如有遗漏文件）**

```bash
git status
```