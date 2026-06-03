# 多工作目录配置与切换技术方案

> 版本：v1.0  
> 创建日期：2026年6月3日  
> 状态：技术方案

---

## 1. 概述

本文档为「多工作目录配置与切换」功能提供技术实现方案，依据需求规格 `multi-workdir-requirement.md` 和评审意见 `multi-workdir-requirement-review.md` 编写。

### 1.1 设计目标

| ID | 目标 | 说明 |
|----|------|------|
| T1 | 工作目录列表管理 | 支持添加、编辑、移除、设置默认目录 |
| T2 | 快速切换 | 右侧栏下拉选择器即时切换 |
| T3 | 数据隔离 | 会话、Wiki、Skill 按目录隔离 |
| T4 | 日志动态切换 | 切换时日志路径同步更新 |
| T5 | 并发安全 | 防止快速连续切换导致状态不一致 |

### 1.2 设计原则

- **最小改动**：复用现有 `WorkDirProfile` 结构，不改动核心数据模型
- **增量实现**：新增 `WorkDirManager` 模块，逐步接管工作目录逻辑
- **向后兼容**：单一工作目录时行为与原有一致
- **防呆设计**：至少保留一个工作目录，阻止空列表保存

---

## 2. 架构设计

### 2.1 模块划分

```
electron/
├── workDirManager.ts      # [NEW] 工作目录核心管理
├── appIpc.ts              # [EDIT] 新增 workdir:* IPC 通道
├── preload.ts             # [EDIT] 暴露 workdir API
├── database.ts            # [EDIT] Session 增加 workDirProfileId
├── agentLogger/           # [EDIT] 支持动态工作目录
│   └── agentLogger.ts
└── main.ts                # [EDIT] 初始化 WorkDirManager

src/renderer/
├── components/Config/
│   └── WorkDirList.tsx    # [NEW] 设置页工作目录列表
├── components/DetailPanel/
│   └── WorkDirSelector.tsx # [NEW] 右侧栏下拉选择器
├── store/
│   ├── configSlice.ts     # [EDIT] 增加 workDirProfiles 状态
│   └── sessionSlice.ts    # [EDIT] 支持按目录过滤会话
└── api.ts                 # [EDIT] WorkDirProfile 类型导出
```

### 2.2 核心数据流

```
用户操作（设置页/右侧栏）
        │
        ▼
IPC 调用（workdir:switch|add|remove|update）
        │
        ▼
┌─────────────────────────────────────┐
│        WorkDirManager (主进程)       │
│  - 校验逻辑（路径、权限、重复）         │
│  - 切换锁定（防止并发）               │
│  - 数据迁移（必要时）                 │
│  - 日志 flush                        │
└─────────────────────────────────────┘
        │
        ▼
更新数据库 + 内存状态
        │
        ▼
┌─────────────────────────────────────┐
│        渲染进程 (Redux)              │
│  - configSlice 更新 activeWorkDir   │
│  - sessionSlice 刷新会话列表         │
│  - 文件树、Wiki 等组件响应变化        │
└─────────────────────────────────────┘
```

### 2.3 现有架构复用

| 现有组件 | 复用方式 |
|----------|----------|
| `WorkDirProfile` 类型 | 直接复用 `feishuTypes.ts` 定义 |
| `AppConfig.workDirProfiles` | 直接使用已有字段 |
| `getWorkDir()` 函数 | 改造为从 `activeWorkDirProfileId` 动态获取 |
| `pathSecurity.ts` | 复用路径校验逻辑 |
| Phase 3 飞书集成 | 复用别名匹配和敏感标记逻辑 |

---

## 3. 核心模块：WorkDirManager

### 3.1 职责

`WorkDirManager` 是工作目录业务逻辑的单一入口，负责：

1. **配置管理**：维护 `workDirProfiles` 列表和 `activeWorkDirProfileId`
2. **校验逻辑**：路径有效性、权限、重复检查
3. **切换控制**：切换锁、flush 日志、更新状态
4. **向后兼容**：从单一 `workDir` 字段迁移

### 3.2 接口设计

```typescript
// electron/workDirManager.ts

export interface WorkDirManager {
  // 列表操作
  listProfiles(): WorkDirProfile[]
  addProfile(profile: Omit<WorkDirProfile, 'id'>): { success: boolean; error?: string }
  updateProfile(profileId: string, updates: Partial<WorkDirProfile>): { success: boolean; error?: string }
  removeProfile(profileId: string): { success: boolean; error?: string }

  // 切换操作
  switchProfile(profileId: string): { success: boolean; error?: string; sessions: Session[] }
  getActiveProfile(): WorkDirProfile | undefined
  getActiveWorkDir(): string

  // 校验
  validateProfile(profile: Omit<WorkDirProfile, 'id'>): { valid: boolean; error?: string }
  checkDirectoryWritable(dirPath: string): { ok: boolean; error?: string }

  // 迁移
  migrateFromLegacy(): void
  ensureDefaultProfile(workDir: string): void
}

export function createWorkDirManager(ctx: {
  db: AppDatabase
  getWorkDir: () => string
  setWorkDir: (dir: string) => void
}): WorkDirManager
```

### 3.3 关键实现细节

#### 3.3.1 切换锁机制

```typescript
// 切换锁防止并发
let switchLock = false

async function executeSwitch(profileId: string) {
  if (switchLock) {
    return { success: false, error: '切换进行中，请稍候' }
  }
  switchLock = true
  try {
    // 1. flush 日志
    await flushAgentLogger()
    // 2. 更新数据库
    setConfigValue(db, 'config.activeWorkDirProfileId', profileId)
    // 3. 更新内存工作目录
    const profile = profiles.find(p => p.id === profileId)
    if (profile) {
      setWorkDir(profile.path)
    }
    return { success: true, sessions: getSessionsForProfile(profileId) }
  } finally {
    switchLock = false
  }
}
```

#### 3.3.2 校验规则

```typescript
function validateProfileInput(input: { name: string; path: string; aliases?: string[] }) {
  // 1. 名称非空
  if (!input.name.trim()) {
    return { valid: false, error: '名称不能为空' }
  }
  // 2. 路径非空
  if (!input.path.trim()) {
    return { valid: false, error: '路径不能为空' }
  }
  // 3. 路径可写
  const writeCheck = checkDirectoryWritable(input.path)
  if (!writeCheck.ok) {
    return { valid: false, error: `目录不可写入：${writeCheck.error}` }
  }
  // 4. 名称唯一
  if (profiles.some(p => p.name === input.name)) {
    return { valid: false, error: '工作目录名称不能重复' }
  }
  // 5. 路径唯一
  if (profiles.some(p => p.path === input.path)) {
    return { valid: false, error: '工作目录路径不能重复' }
  }
  return { valid: true }
}
```

#### 3.3.3 默认目录逻辑

```typescript
function addProfile(input: Omit<WorkDirProfile, 'id'>) {
  // 列表为空时，第一个自动设为默认
  if (profiles.length === 0) {
    input.isDefault = true
  }
  // 生成唯一 ID
  const id = generateId()
  profiles.push({ ...input, id })
  // 如果是默认，取消其他默认
  if (input.isDefault) {
    profiles.forEach(p => { if (p.id !== id) p.isDefault = false })
  }
  persist()
}

function removeProfile(profileId: string) {
  const profile = profiles.find(p => p.id === profileId)
  if (!profile) return { success: false, error: '目录不存在' }

  // 阻止删除最后一个
  if (profiles.length === 1) {
    return { success: false, error: '请至少保留一个工作目录' }
  }

  // 如果删除默认，自动将第一个设为默认
  const wasDefault = profile.isDefault
  profiles = profiles.filter(p => p.id !== profileId)
  if (wasDefault && profiles.length > 0) {
    profiles[0].isDefault = true
  }
  persist()
  return { success: true }
}
```

---

## 4. IPC 通道设计

### 4.1 新增通道

| 通道 | 方向 | 参数 | 返回 |
|------|------|------|------|
| `workdir:list` | invoke | — | `WorkDirProfile[]` |
| `workdir:add` | invoke | `{ name, path, aliases?, isDefault? }` | `{ success: boolean; profile?: WorkDirProfile; error?: string }` |
| `workdir:update` | invoke | `{ profileId, updates }` | `{ success: boolean; error?: string }` |
| `workdir:remove` | invoke | `{ profileId }` | `{ success: boolean; error?: string }` |
| `workdir:switch` | invoke | `{ profileId }` | `{ success: boolean; sessions: Session[]; error?: string }` |
| `workdir:check-writable` | invoke | `{ path }` | `{ ok: boolean; error?: string }` |

### 4.2 Preload API 扩展

```typescript
// electron/preload.ts

// 新增 workdir API
const workdirApi = {
  list: () => ipcRenderer.invoke('workdir:list'),
  add: (profile: { name: string; path: string; aliases?: string[]; isDefault?: boolean }) =>
    ipcRenderer.invoke('workdir:add', profile),
  update: (profileId: string, updates: Partial<WorkDirProfile>) =>
    ipcRenderer.invoke('workdir:update', { profileId, updates }),
  remove: (profileId: string) => ipcRenderer.invoke('workdir:remove', { profileId }),
  switch: (profileId: string) => ipcRenderer.invoke('workdir:switch', { profileId }),
  checkWritable: (path: string) => ipcRenderer.invoke('workdir:check-writable', { path }),
}

// 挂载到 window.api
;(window as any).api = {
  ...existingApi,
  workdir: workdirApi
}
```

---

## 5. 数据模型扩展

### 5.1 Session 增加 workDirProfileId

```typescript
// src/shared/domainTypes.ts
interface Session {
  id: string
  name: string
  model?: string
  messages: Message[]
  createdAt: number
  updatedAt: number
  metadata?: Record<string, unknown>
  // 新增字段
  workDirProfileId: string   // 所属工作目录 ID
}
```

**数据迁移策略**：

- 现有会话 `workDirProfileId` 默认为空
- 空值时视为属于「当前激活目录」
- 首次启动时，如果 `workDirProfiles` 为空，从 `workDir` 迁移生成默认 profile

```typescript
// electron/workDirManager.ts
function migrateFromLegacy() {
  const profiles = getConfigValue(db, 'config.workDirProfiles')
  if (profiles && profiles.length > 0) return  // 已有 profiles，无需迁移

  const legacyWorkDir = getConfigValue(db, 'config.workDir')
  if (legacyWorkDir) {
    const defaultProfile: WorkDirProfile = {
      id: 'default',
      name: path.basename(legacyWorkDir) || '默认目录',
      path: legacyWorkDir,
      isDefault: true
    }
    setConfigValue(db, 'config.workDirProfiles', JSON.stringify([defaultProfile]))
    setConfigValue(db, 'config.activeWorkDirProfileId', 'default')
  }
}
```

### 5.2 会话过滤

```typescript
// electron/database.ts
export function listSessionsForProfile(db: AppDatabase, profileId: string): Session[] {
  const all = listSessions(db)
  return all.filter(s => s.workDirProfileId === profileId || (!s.workDirProfileId && isActiveProfile(profileId)))
}
```

---

## 6. 渲染进程侧改造

### 6.1 设置页工作目录列表组件

```
src/renderer/components/Config/WorkDirList.tsx
```

**职责**：
- 展示 `workDirProfiles` 列表
- 添加、编辑、删除目录
- 设置默认目录
- 表单校验和错误提示

**状态管理**：
- 复用 `configSlice` 中的 `workDirProfiles` 和 `activeWorkDirProfileId`
- 操作后调用 IPC 并刷新 Redux 状态

### 6.2 右侧栏下拉选择器

```
src/renderer/components/DetailPanel/WorkDirSelector.tsx
```

**职责**：
- 显示当前激活目录名称
- 下拉列表选择切换
- 流式响应中禁用切换

**行为**：

```typescript
// 切换工作目录
async function handleSwitch(profileId: string) {
  // 1. 检查是否有流式响应
  if (isStreamingRef.current) {
    message.warning('当前会话正在响应，请等待完成后再切换')
    return
  }
  // 2. 调用 IPC
  const result = await window.api.workdir.switch(profileId)
  if (result.success) {
    // 3. 更新 Redux
    dispatch(setActiveWorkDirProfileId(profileId))
    dispatch(setSessions(result.sessions))
  } else {
    message.error(result.error)
  }
}
```

---

## 7. 日志切换机制

### 7.1 动态工作目录支持

现有 `agentLogger` 已在初始化时接受 `getWorkDir` 函数，无需重新初始化：

```typescript
// electron/main.ts
// 初始化时传入函数，而非静态值
initAgentLogger({
  getWorkDir: () => workDirManager.getActiveWorkDir(),
  isPackaged: app.isPackaged,
  mainDirname: __dirname
})
```

### 7.2 切换时 flush

```typescript
// workdir:switch IPC 处理
async function handleSwitch(profileId: string) {
  // 1. 等待当前日志写入完成
  await flushAgentLogger()
  // 2. 执行切换
  const profile = profiles.find(p => p.id === profileId)
  setWorkDir(profile.path)
  // 3. 后续日志自动写入新目录
  logAgentEvent('info', 'workdir.switch.done', {
    fromProfileId: oldId,
    toProfileId: profileId
  })
}
```

---

## 8. 异常场景处理

### 8.1 工作目录被删除

```typescript
// 检测目录是否存在
function validateProfilePath(path: string): { valid: boolean; error?: string } {
  if (!existsSync(path)) {
    return { valid: false, error: '目录不存在' }
  }
  const stat = fs.statSync(path)
  if (!stat.isDirectory()) {
    return { valid: false, error: '路径不是有效目录' }
  }
  return { valid: true }
}

// 切换时检测目录失效
async function handleSwitch(profileId: string) {
  const profile = profiles.find(p => p.id === profileId)
  if (!existsSync(profile.path)) {
    return { success: false, error: `目录已失效：${profile.path}，请重新配置` }
  }
  // ...继续切换
}
```

### 8.2 路径安全校验

复用现有 `pathSecurity.ts` 校验用户输入的路径：

```typescript
import { resolveSafePath } from './pathSecurity'

function validatePath(workDir: string, inputPath: string): string | null {
  const resolved = resolveSafePath(workDir, inputPath)
  // 防止路径遍历
  if (!resolved.startsWith(workDir)) {
    return null  // 拒绝
  }
  return resolved
}
```

### 8.3 权限不足

```typescript
function checkDirectoryWritable(dirPath: string): { ok: boolean; error?: string } {
  try {
    const testFile = path.join(dirPath, `.write_test_${Date.now()}`)
    fs.writeFileSync(testFile, 'test')
    fs.unlinkSync(testFile)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}
```

---

## 9. 飞书远程兼容

与 Phase 3 设计对齐：

- 飞书指令通过别名匹配 profile
- `sensitive: true` 的 profile 禁止远程执行
- 切换操作写入审计日志

```typescript
// feishuWorkDirResolver.ts
function resolveWorkDirProfileByAlias(alias: string): WorkDirProfile | undefined {
  return profiles.find(p => p.aliases?.includes(alias))
}

function validateRemoteSwitch(profileId: string): { allowed: boolean; error?: string } {
  const profile = profiles.find(p => p.id === profileId)
  if (profile?.sensitive) {
    return { allowed: false, error: '敏感项目禁止远程操作' }
  }
  return { allowed: true }
}
```

---

## 10. 自动化测试方案

### 10.1 单元测试

#### 10.1.1 WorkDirManager 核心逻辑

```typescript
// electron/workDirManager.test.ts

describe('WorkDirManager', () => {
  let manager: WorkDirManager
  let mockDb: AppDatabase

  beforeEach(() => {
    mockDb = createMockDb()
    manager = createWorkDirManager({
      db: mockDb,
      getWorkDir: () => '/default',
      setWorkDir: () => {}
    })
  })

  describe('addProfile', () => {
    it('第一个添加的目录自动设为默认', () => {
      manager.addProfile({ name: 'Project A', path: '/path/a' })
      const profiles = manager.listProfiles()
      expect(profiles[0].isDefault).toBe(true)
    })

    it('第二个添加的目录不自动设为默认', () => {
      manager.addProfile({ name: 'Project A', path: '/path/a' })
      manager.addProfile({ name: 'Project B', path: '/path/b' })
      const profiles = manager.listProfiles()
      expect(profiles.filter(p => p.isDefault).length).toBe(1)
    })

    it('拒绝重复名称', () => {
      manager.addProfile({ name: 'Project A', path: '/path/a' })
      const result = manager.addProfile({ name: 'Project A', path: '/path/b' })
      expect(result.success).toBe(false)
      expect(result.error).toContain('名称不能重复')
    })

    it('拒绝重复路径', () => {
      manager.addProfile({ name: 'Project A', path: '/path/a' })
      const result = manager.addProfile({ name: 'Project B', path: '/path/a' })
      expect(result.success).toBe(false)
      expect(result.error).toContain('路径不能重复')
    })

    it('拒绝不可写入的目录', () => {
      const result = manager.addProfile({ name: 'Project', path: '/system/protected' })
      expect(result.success).toBe(false)
      expect(result.error).toContain('不可写入')
    })
  })

  describe('removeProfile', () => {
    it('阻止删除最后一个目录', () => {
      manager.addProfile({ name: 'Project', path: '/path' })
      const result = manager.removeProfile(manager.listProfiles()[0].id)
      expect(result.success).toBe(false)
      expect(result.error).toContain('至少保留一个')
    })

    it('删除默认目录后自动转移默认', () => {
      manager.addProfile({ name: 'A', path: '/a', isDefault: true })
      manager.addProfile({ name: 'B', path: '/b' })
      const bId = manager.listProfiles().find(p => p.name === 'B')!.id
      manager.removeProfile(manager.listProfiles().find(p => p.name === 'A')!.id)
      expect(manager.listProfiles().find(p => p.id === bId)?.isDefault).toBe(true)
    })
  })

  describe('switchProfile', () => {
    it('切换后返回新目录的会话', () => {
      // setup profiles and sessions
    })

    it('并发切换时返回错误', async () => {
      // 启动两个切换，第二个应被拒绝
    })
  })
})
```

#### 10.1.2 路径校验

```typescript
// electron/pathSecurity.test.ts

describe('WorkDir path validation', () => {
  it('拒绝路径遍历尝试', () => {
    const result = validatePath('/project', '../../../etc/passwd')
    expect(result).toBeNull()
  })

  it('拒绝系统敏感目录', () => {
    expect(validatePath('/project', 'C:\\Windows\\System32')).toBeNull()
    expect(validatePath('/project', '/root')).toBeNull()
  })
})
```

### 10.2 集成测试

#### 10.2.1 IPC 通道测试

```typescript
// electron/appIpc.workdir.test.ts

describe('workdir IPC handlers', () => {
  let ctx: AppIpcContext
  beforeEach(() => {
    ctx = createTestContext()
    registerAppIpcHandlers(ipcMain, ctx)
  })

  describe('workdir:add', () => {
    it('成功添加目录', async () => {
      const result = await invoke('workdir:add', {
        name: 'Test',
        path: '/test'
      })
      expect(result.success).toBe(true)
      expect(result.profile?.name).toBe('Test')
    })
  })

  describe('workdir:switch', () => {
    it('切换时刷新会话列表', async () => {
      // 创建两个 profile 和一些会话
      const profile1 = (await invoke('workdir:add', { name: 'P1', path: '/p1' })).profile
      const profile2 = (await invoke('workdir:add', { name: 'P2', path: '/p2' })).profile

      // 在 profile1 创建会话
      await invoke('session:create', { name: 'S1', metadata: { workDirProfileId: profile1.id } })

      // 切换到 profile2
      const result = await invoke('workdir:switch', { profileId: profile2.id })

      // profile2 的会话列表应为空
      expect(result.sessions).toHaveLength(0)
    })

    it('流式响应中切换返回错误', async () => {
      // 启动流式响应
      // 尝试切换
      const result = await invoke('workdir:switch', { profileId: profile2.id })
      expect(result.success).toBe(false)
      expect(result.error).toContain('正在响应')
    })
  })
})
```

#### 10.2.2 向后兼容测试

```typescript
describe('向后兼容', () => {
  it('仅有 workDir 时自动生成默认 profile', () => {
    const db = createDbWithLegacyConfig({ workDir: '/legacy' })
    const manager = createWorkDirManager({ db, ... })
    manager.migrateFromLegacy()

    const profiles = manager.listProfiles()
    expect(profiles).toHaveLength(1)
    expect(profiles[0].path).toBe('/legacy')
    expect(profiles[0].isDefault).toBe(true)
  })
})
```

### 10.3 组件测试（Vitest + React Testing Library）

#### 10.3.1 WorkDirList 组件

```typescript
// src/renderer/components/Config/WorkDirList.test.tsx

describe('WorkDirList', () => {
  it('显示工作目录列表', () => {
    render(<WorkDirList profiles={profiles} />)
    expect(screen.getByText('Project A')).toBeInTheDocument()
    expect(screen.getByText('Project B')).toBeInTheDocument()
  })

  it('第一个目录显示默认标记', () => {
    render(<WorkDirList profiles={profiles} />)
    const defaultRadio = screen.getByRole('radio', { name: 'Project A' })
    expect(defaultRadio).toBeChecked()
  })

  it('点击添加按钮打开 Popover', async () => {
    render(<WorkDirList profiles={profiles} />)
    fireEvent.click(screen.getByRole('button', { name: /添加/ }))
    expect(screen.getByPlaceholderText('名称')).toBeInTheDocument()
  })

  it('空列表时显示提示', () => {
    render(<WorkDirList profiles={[]} />)
    expect(screen.getByText('请添加工作目录')).toBeInTheDocument()
  })

  it('尝试删除最后一个目录时阻止', async () => {
    render(<WorkDirList profiles={[singleProfile]} />)
    fireEvent.click(screen.getByRole('button', { name: /移除/ }))
    expect(screen.getByText('请至少保留一个')).toBeInTheDocument()
  })
})
```

#### 10.3.2 WorkDirSelector 组件

```typescript
// src/renderer/components/DetailPanel/WorkDirSelector.test.tsx

describe('WorkDirSelector', () => {
  it('显示当前目录名称', () => {
    render(<WorkDirSelector profiles={profiles} activeId="p1" />)
    expect(screen.getByText('Project A')).toBeInTheDocument()
  })

  it('下拉显示所有目录', () => {
    render(<WorkDirSelector profiles={profiles} activeId="p1" />)
    fireEvent.click(screen.getByRole('combobox'))
    expect(screen.getByText('Project B')).toBeInTheDocument()
  })

  it('切换目录调用 workdir:switch', async () => {
    const switchSpy = vi.spyOn(window.api.workdir, 'switch')
    render(<WorkDirSelector profiles={profiles} activeId="p1" />)
    fireEvent.click(screen.getByRole('combobox'))
    fireEvent.click(screen.getByText('Project B'))
    expect(switchSpy).toHaveBeenCalledWith('p2')
  })

  it('流式响应中禁用切换', () => {
    render(<WorkDirSelector profiles={profiles} activeId="p1" isStreaming={true} />)
    expect(screen.getByRole('combobox')).toBeDisabled()
  })
})
```

### 10.4 E2E 测试（Playwright）

```typescript
// e2e/workdir-switch.spec.ts

describe('多工作目录切换', () => {
  beforeEach(() => {
    // 创建两个测试目录
    fs.mkdirSync('/tmp/test-projects/project-a')
    fs.mkdirSync('/tmp/test-projects/project-b')
  })

  it('设置页添加和切换目录', async ({ page }) => {
    await page.goto('/settings')

    // 1. 添加第一个目录
    await page.click('button:has-text("添加目录")')
    await page.fill('input[name="name"]', 'Project A')
    await page.fill('input[name="path"]', '/tmp/test-projects/project-a')
    await page.click('button:has-text("确认")')
    expect(await page.locator('.workdir-item:has-text("Project A")').count()).toBe(1)

    // 2. 添加第二个目录
    await page.click('button:has-text("添加目录")')
    await page.fill('input[name="name"]', 'Project B')
    await page.fill('input[name="path"]', '/tmp/test-projects/project-b')
    await page.click('button:has-text("确认")')

    // 3. 验证默认目录是 Project A
    expect(await page.locator('.workdir-item:has-text("Project A") .radio').isChecked())

    // 4. 设置 Project B 为默认
    await page.click('.workdir-item:has-text("Project B") .radio')
    expect(await page.locator('.workdir-item:has-text("Project B") .radio').isChecked())
  })

  it('右侧栏快速切换目录', async ({ page }) => {
    await page.goto('/')

    // 1. 在右侧栏下拉选择 Project B
    await page.click('.workdir-selector')
    await page.click('.workdir-selector option:has-text("Project B")')

    // 2. 验证会话列表已刷新
    await expect(page.locator('.session-list')).toBeEmpty()

    // 3. 验证文件树路径已切换
    await expect(page.locator('.file-tree')).toContainText('project-b')
  })

  it('阻止删除最后一个目录', async ({ page }) => {
    await page.goto('/settings')

    // 只有一个目录时，删除按钮应禁用或显示确认
    const removeBtn = page.locator('.workdir-item:first-child button:has-text("移除")')
    await removeBtn.click()
    await expect(page.locator('.error-message:has-text("至少保留一个")')).toBeVisible()
  })

  it('流式响应中切换提示等待', async ({ page }) => {
    await page.goto('/')

    // 启动流式响应
    await page.fill('.message-input', '讲个很长的故事')
    await page.click('button:has-text("发送")')

    // 尝试切换目录
    await page.click('.workdir-selector')
    await page.click('.workdir-selector option:has-text("Project B")')

    // 应显示警告
    await expect(page.locator('.warning:has-text("正在响应")')).toBeVisible()
  })
})
```

---

## 11. 测试覆盖矩阵

| 功能点 | 单元测试 | 集成测试 | E2E |
|--------|---------|---------|-----|
| 添加目录 | ✅ | ✅ | ✅ |
| 删除目录 | ✅ | ✅ | ✅ |
| 设置默认 | ✅ | ✅ | ✅ |
| 校验-名称重复 | ✅ | ✅ | ✅ |
| 校验-路径重复 | ✅ | ✅ | ✅ |
| 校验-权限不足 | ✅ | ✅ | ✅ |
| 校验-至少保留一个 | ✅ | ✅ | ✅ |
| 目录切换 | ✅ | ✅ | ✅ |
| 切换锁定 | ✅ | ✅ | ✅ |
| 会话过滤 | ✅ | ✅ | ✅ |
| 流式响应中切换 | — | ✅ | ✅ |
| 向后兼容迁移 | ✅ | ✅ | — |
| 飞书别名匹配 | ✅ | — | — |
| 敏感目录校验 | ✅ | — | — |

---

## 12. 实施任务

| 序号 | 任务 | 依赖 | 优先级 |
|------|------|------|--------|
| T1 | 创建 `workDirManager.ts` 核心模块 | — | P0 |
| T2 | 实现 `workdir:*` IPC 通道 | T1 | P0 |
| T3 | 扩展 `preload.ts` API | T2 | P0 |
| T4 | Session 增加 `workDirProfileId` 字段 | — | P1 |
| T5 | 向后兼容迁移逻辑 | T4 | P1 |
| T6 | 设置页 `WorkDirList` 组件 | T1, T2, T3 | P1 |
| T7 | 右侧栏 `WorkDirSelector` 组件 | T1, T2, T3 | P1 |
| T8 | 日志切换 flush 逻辑 | T1 | P2 |
| T9 | 编写自动化测试 | T1-T8 | P2 |

---

## 13. 附录

### 13.1 类型定义

```typescript
// WorkDirProfile 已定义在 feishuTypes.ts
export interface WorkDirProfile {
  id: string
  name: string
  path: string
  aliases?: string[]
  isDefault?: boolean
  sensitive?: boolean
}
```

### 13.2 数据库字段

| 键 | 类型 | 说明 |
|----|------|------|
| `config.workDir` | string | 兼容字段，指向当前激活目录 |
| `config.workDirProfiles` | WorkDirProfile[] | 目录列表 |
| `config.activeWorkDirProfileId` | string | 当前激活的目录 ID |
| `sessions[*].workDirProfileId` | string | 会话所属目录 |
