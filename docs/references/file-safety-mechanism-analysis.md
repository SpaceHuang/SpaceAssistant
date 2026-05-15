# 文件修改安全机制分析报告

> 本报告分析 Claude Code 项目在执行文件修改时，如何防止大模型幻觉导致文件损坏，以及如何确保文件可恢复能力。

---

## 一、概述

Claude Code 实现了多层次的文件修改安全机制，主要包括：

1. **前置条件验证** - 必须先读取文件才能修改
2. **并发修改检测** - 防止外部修改与内部修改冲突
3. **文件历史备份** - 修改前创建快照
4. **原子性写入** - 安全的文件写入机制
5. **版本回滚能力** - 支持恢复到之前的版本
6. **会话恢复** - 跨会话的文件历史恢复

---

## 二、前置条件验证机制

### 2.1 必须先读取才能写入

**核心设计**：Edit 和 Write 工具都强制要求文件在被修改之前必须已经被读取。

```typescript
// src/tools/FileEditTool/FileEditTool.ts:275-282
const readTimestamp = toolUseContext.readFileState.get(fullFilePath)
if (!readTimestamp || readTimestamp.isPartialView) {
  return {
    result: false,
    behavior: 'ask',
    message: 'File has not been read yet. Read it first before editing it.',
    errorCode: 6,
  }
}
```

**FileStateCache 机制**：

```typescript
// src/utils/fileStateCache.ts
export type FileState = {
  content: string
  timestamp: number
  offset: number | undefined
  limit: number | undefined
  isPartialView?: boolean  // 部分读取标记
}
```

- 使用 LRU 缓存存储已读取文件的状态
- 包含文件内容、时间戳、读取范围等信息
- 最大 100 个条目，25MB 大小限制

**工具提示词约束**：

```typescript
// src/tools/FileEditTool/prompt.ts
function getPreReadInstruction(): string {
  return `\n- You must use your \`Read\` tool at least once in the 
  conversation before editing. This tool will error if you attempt an 
  edit without reading the file. `
}

// src/tools/FileWriteTool/prompt.ts
function getPreReadInstruction(): string {
  return `\n- If this is an existing file, you MUST use the Read tool first 
  to read the file's contents. This tool will fail if you did not read it first.`
}
```

### 2.2 相同内容检测

```typescript
// src/tools/FileEditTool/FileEditTool.ts:189-196
if (old_string === new_string) {
  return {
    result: false,
    behavior: 'ask',
    message: 'No changes to make: old_string and new_string are exactly the same.',
    errorCode: 1,
  }
}
```

---

## 三、并发修改检测机制

### 3.1 时间戳验证

**核心逻辑**：在写入前检查文件的修改时间戳，如果文件在读取后被外部修改，则拒绝写入。

```typescript
// src/tools/FileEditTool/FileEditTool.ts:451-467
if (fileExists) {
  const lastWriteTime = getFileModificationTime(absoluteFilePath)
  const lastRead = readFileState.get(absoluteFilePath)
  if (!lastRead || lastWriteTime > lastRead.timestamp) {
    // Windows 回退：比较内容
    const isFullRead = lastRead?.offset === undefined && lastRead?.limit === undefined
    const contentUnchanged = isFullRead && originalFileContents === lastRead.content
    if (!contentUnchanged) {
      throw new Error(FILE_UNEXPECTEDLY_MODIFIED_ERROR)
    }
  }
}
```

**错误信息**：

```typescript
// src/tools/FileEditTool/constants.ts
export const FILE_UNEXPECTEDLY_MODIFIED_ERROR =
  'File has been unexpectedly modified. Read it again before attempting to write it.'
```

### 3.2 内容比较回退

Windows 系统的文件时间戳可能因云同步、杀毒软件等因素而变化，即使文件内容未实际修改。因此系统会进一步比较文件内容：

```typescript
// src/utils/fileHistory.ts - compareStatsAndContent 函数逻辑
// 1. 比较权限和文件大小
if (originalStats.mode !== backupStats.mode ||
    originalStats.size !== backupStats.size) {
  return true  // 认为已修改
}

// 2. 如果原文件修改时间早于备份时间，认为未修改
if (originalStats.mtimeMs < backupStats.mtimeMs) {
  return false  // 未修改
}

// 3. 最终使用内容比较
const [originalContent, backupContent] = await Promise.all([
  readFile(originalFile, 'utf-8'),
  readFile(backupPath, 'utf-8'),
])
return originalContent !== backupContent
```

---

## 四、文件历史备份机制

### 4.1 备份时机

文件在每次修改前都会自动创建备份：

```typescript
// src/tools/FileEditTool/FileEditTool.ts:254-257
if (fileHistoryEnabled()) {
  // Backup captures pre-edit content — safe to call before the staleness
  await fileHistoryTrackEdit(updateFileHistoryState, absoluteFilePath, parentMessage.uuid)
}
```

### 4.2 备份存储结构

```typescript
// src/utils/fileHistory.ts
export type FileHistoryBackup = {
  backupFileName: string | null  // null 表示文件在该版本不存在
  version: number
  backupTime: Date
}

export type FileHistorySnapshot = {
  messageId: UUID  // 关联的消息 ID
  trackedFileBackups: Record<string, FileHistoryBackup>
  timestamp: Date
}

export type FileHistoryState = {
  snapshots: FileHistorySnapshot[]  // 最多保留 100 个快照
  trackedFiles: Set<string>
  snapshotSequence: number
}
```

### 4.3 备份文件命名

```typescript
// src/utils/fileHistory.ts
function getBackupFileName(filePath: string, version: number): string {
  const fileNameHash = createHash('sha256')
    .update(filePath)
    .digest('hex')
    .slice(0, 16)
  return `${fileNameHash}@v${version}`
}
```

备份文件存储在：`~/.claude/file-history/{sessionId}/{hash}@v{version}`

### 4.4 备份创建流程

```typescript
// src/utils/fileHistory.ts - createBackup 函数
async function createBackup(filePath: string | null, version: number) {
  // 1. 如果文件不存在 (ENOENT)，返回 null backup
  let srcStats: Stats
  try {
    srcStats = await stat(filePath)
  } catch (e: unknown) {
    if (isENOENT(e)) {
      return { backupFileName: null, version, backupTime: new Date() }
    }
    throw e
  }

  // 2. 使用 copyFile 复制文件内容（避免将整个文件读入 JS 堆）
  try {
    await copyFile(filePath, backupPath)
  } catch (e: unknown) {
    if (!isENOENT(e)) throw e
    await mkdir(dirname(backupPath), { recursive: true })
    await copyFile(filePath, backupPath)
  }

  // 3. 保留原始文件权限
  await chmod(backupPath, srcStats.mode)
}
```

### 4.5 智能备份策略

```typescript
// src/utils/fileHistory.ts - fileHistoryTrackEdit 函数
// 1. 检查是否已跟踪该文件，避免重复备份
if (mostRecent.trackedFileBackups[trackingPath]) {
  return  // 已跟踪，跳过
}

// 2. 检查文件是否真的改变了
if (latestBackup && !(await checkOriginFileChanged(filePath, backupFileName, fileStats))) {
  // 文件未修改，复用现有备份
  trackedFileBackups[trackingPath] = latestBackup
  return
}
```

---

## 五、原子性写入机制

### 5.1 临时文件写入

```typescript
// src/utils/file.ts - writeFileSyncAndFlush_DEPRECATED 函数
const tempPath = `${targetPath}.tmp.${process.pid}.${Date.now()}`

// 1. 写入临时文件并 flush
fsWriteFileSync(tempPath, content, { encoding, flush: true, mode })

// 2. 恢复原始权限
if (targetExists && targetMode !== undefined) {
  chmodSync(tempPath, targetMode)
}

// 3. 原子性重命名（POSIX 系统保证原子性）
fs.renameSync(tempPath, targetPath)
```

### 5.2 回退机制

如果原子写入失败，回退到普通写入：

```typescript
// src/utils/file.ts
try {
  fs.renameSync(tempPath, targetPath)
} catch (atomicError) {
  // 清理临时文件
  try {
    fs.unlinkSync(tempPath)
  } catch {}

  // 回退到非原子写入
  logForDebugging(`Falling back to non-atomic write for ${targetPath}`)
  fsWriteFileSync(targetPath, content, { encoding, flush: true })
}
```

### 5.3 符号链接处理

```typescript
// src/utils/file.ts
// 检测并保留符号链接
try {
  const linkTarget = fs.readlinkSync(filePath)
  targetPath = isAbsolute(linkTarget) 
    ? linkTarget 
    : resolve(dirname(filePath), linkTarget)
} catch {
  // ENOENT 或 EINVAL - 不是符号链接
}
```

---

## 六、版本回滚机制

### 6.1 快照回滚

```typescript
// src/utils/fileHistory.ts - fileHistoryRewind 函数
export async function fileHistoryRewind(
  updateFileHistoryState,
  messageId: UUID,
): Promise<void> {
  const targetSnapshot = captured.snapshots.findLast(
    snapshot => snapshot.messageId === messageId,
  )
  
  // 应用快照到文件系统
  const filesChanged = await applySnapshot(captured, targetSnapshot)
}
```

### 6.2 恢复单个文件

```typescript
// src/utils/fileHistory.ts - restoreBackup 函数
async function restoreBackup(filePath: string, backupFileName: string): Promise<void> {
  const backupPath = resolveBackupPath(backupFileName)
  
  // 1. 确保备份文件存在
  let backupStats: Stats
  try {
    backupStats = await stat(backupPath)
  } catch (e: unknown) {
    if (isENOENT(e)) {
      logError(new Error(`Backup file not found: ${backupPath}`))
      return
    }
    throw e
  }

  // 2. 恢复文件
  try {
    await copyFile(backupPath, filePath)
  } catch (e: unknown) {
    if (!isENOENT(e)) throw e
    await mkdir(dirname(filePath), { recursive: true })
    await copyFile(backupPath, filePath)
  }

  // 3. 恢复原始权限
  await chmod(filePath, backupStats.mode)
}
```

### 6.3 变化检测

```typescript
// src/utils/fileHistory.ts - fileHistoryHasAnyChanges 函数
// 轻量级检查：回滚到某个消息是否会改变任何文件
export async function fileHistoryHasAnyChanges(
  state: FileHistoryState,
  messageId: UUID,
): Promise<boolean> {
  for (const trackingPath of state.trackedFiles) {
    if (await checkOriginFileChanged(filePath, backupFileName)) {
      return true  // 至少有一个文件会改变
    }
  }
  return false
}
```

---

## 七、会话恢复机制

### 7.1 文件历史快照持久化

```typescript
// src/utils/sessionStorage.ts
export async function recordFileHistorySnapshot(
  messageId: UUID,
  snapshot: FileHistorySnapshot,
  isSnapshotUpdate: boolean,
) {
  await getProject().insertFileHistorySnapshot(messageId, snapshot, isSnapshotUpdate)
}
```

### 7.2 跨会话恢复

```typescript
// src/utils/fileHistory.ts - copyFileHistoryForResume 函数
export async function copyFileHistoryForResume(log: LogOption): Promise<void> {
  // 1. 创建新的备份目录
  const newBackupDir = join(getClaudeConfigHomeDir(), 'file-history', sessionId)
  await mkdir(newBackupDir, { recursive: true })

  // 2. 从旧会话复制备份文件到新会话
  await Promise.all(
    fileHistorySnapshots.map(async snapshot => {
      const results = await Promise.all(
        backupEntries.map(async ({ backupFileName }) => {
          // 优先使用硬链接，失败则复制
          try {
            await link(oldBackupPath, newBackupPath)
          } catch {
            await copyFile(oldBackupPath, newBackupPath)
          }
        })
      )
    })
  )
}
```

### 7.3 状态恢复

```typescript
// src/utils/sessionRestore.ts - restoreSessionStateFromLog 函数
export function restoreSessionStateFromLog(result: ResumeResult, setAppState): void {
  if (result.fileHistorySnapshots && result.fileHistorySnapshots.length > 0) {
    fileHistoryRestoreStateFromLog(result.fileHistorySnapshots, newState => {
      setAppState(prev => ({ ...prev, fileHistory: newState }))
    })
  }
}
```

---

## 八、错误处理与用户提示

### 8.1 错误码对照表

| errorCode | 说明 | 用户提示 |
|-----------|------|---------|
| 0 | Secrets 检测失败 | 禁止写入包含密钥的内容 |
| 1 | old_string 与 new_string 相同 | 无修改内容 |
| 2 | Deny 规则匹配 | 文件在禁止目录 |
| 4 | 文件不存在 | 必须先读取文件 |
| 6 | 文件未读取 | 必须先读取文件 |
| 7 | 文件已被修改 | 重新读取后再写入 |
| 8 | old_string 未找到 | 提供更多上下文 |
| 9 | 多匹配且未设置 replace_all | 使用 replace_all 或提供更多上下文 |
| 10 | 文件过大 (>1GiB) | 文件超出大小限制 |

### 8.2 API 错误后的恢复提示

```typescript
// src/services/api/errors.ts
const rewindInstruction = getIsNonInteractiveSession()
  ? ''
  : ' Then, use /rewind to recover the conversation.'
```

---

## 九、配置与控制

### 9.1 文件历史开关

```typescript
// src/utils/fileHistory.ts
export function fileHistoryEnabled(): boolean {
  if (getIsNonInteractiveSession()) {
    return fileHistoryEnabledSdk()
  }
  return (
    getGlobalConfig().fileCheckpointingEnabled !== false &&
    !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING)
  )
}
```

**控制方式**：
- `fileCheckpointingEnabled` 全局配置（默认 true）
- `CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING` 环境变量

### 9.2 快照数量限制

```typescript
const MAX_SNAPSHOTS = 100
// 超过限制时，删除最早的快照
const updatedState = {
  ...state,
  snapshots: allSnapshots.length > MAX_SNAPSHOTS
    ? allSnapshots.slice(-MAX_SNAPSHOTS)
    : allSnapshots,
}
```

---

## 十、安全机制总结

### 10.1 预防机制

```
┌─────────────────────────────────────────────────────────────┐
│                    预防层机制                                 │
├─────────────────────────────────────────────────────────────┤
│  1. 前置读取要求                                             │
│     ├─ Edit/Write 必须先 Read                               │
│     ├─ readFileState 缓存验证                                │
│     └─ isPartialView 标记处理                               │
│                                                              │
│  2. 并发修改检测                                             │
│     ├─ 文件时间戳对比                                        │
│     ├─ Windows 内容比较回退                                  │
│     └─ FILE_UNEXPECTEDLY_MODIFIED_ERROR                      │
│                                                              │
│  3. 权限与路径检查                                           │
│     ├─ Deny/Allow 规则匹配                                   │
│     ├─ 危险路径保护（CON, PRN, AUX 等）                      │
│     └─ Secrets 检测                                          │
└─────────────────────────────────────────────────────────────┘
```

### 10.2 恢复机制

```
┌─────────────────────────────────────────────────────────────┐
│                    恢复层机制                                 │
├─────────────────────────────────────────────────────────────┤
│  1. 文件历史备份                                             │
│     ├─ 修改前自动创建备份                                      │
│     ├─ SHA256 哈希命名                                        │
│     └─ 版本号管理（最多 100 个快照）                           │
│                                                              │
│  2. 原子性写入                                               │
│     ├─ 临时文件 + rename                                      │
│     ├─ flush 保证                                            │
│     └─ 权限保留                                               │
│                                                              │
│  3. 版本回滚                                                 │
│     ├─ /rewind 命令                                          │
│     ├─ 按消息 ID 恢复                                        │
│     └─ 选择性文件恢复                                         │
│                                                              │
│  4. 会话恢复                                                 │
│     ├─ 快照持久化到会话存储                                   │
│     ├─ 跨会话备份复制                                         │
│     └─ 状态重建                                               │
└─────────────────────────────────────────────────────────────┘
```

---

## 十一、关键代码位置

| 功能 | 文件路径 |
|------|---------|
| 文件状态缓存 | [fileStateCache.ts](file:///e:/Develop/claude-code-main/src/utils/fileStateCache.ts) |
| 文件历史管理 | [fileHistory.ts](file:///e:/Develop/claude-code-main/src/utils/fileHistory.ts) |
| Edit 工具 | [FileEditTool.ts](file:///e:/Develop/claude-code-main/src/tools/FileEditTool/FileEditTool.ts) |
| Write 工具 | [FileWriteTool.ts](file:///e:/Develop/claude-code-main/src/tools/FileWriteTool/FileWriteTool.ts) |
| 原子性写入 | [file.ts](file:///e:/Develop/claude-code-main/src/utils/file.ts) |
| 会话恢复 | [sessionRestore.ts](file:///e:/Develop/claude-code-main/src/utils/sessionRestore.ts) |
| 会话存储 | [sessionStorage.ts](file:///e:/Develop/claude-code-main/src/utils/sessionStorage.ts) |

---

## 十二、结论

Claude Code 通过多层防御机制有效防止了大模型幻觉导致的文件损坏：

1. **前置条件验证**确保模型在修改前必须准确理解文件内容
2. **并发检测**防止外部修改被覆盖
3. **文件历史**提供了完整的修改记录
4. **原子写入**确保写入不会导致文件损坏
5. **回滚能力**让用户可以恢复到任意历史状态
6. **会话恢复**确保即使重启程序也能继续工作

这些机制共同构成了一个安全可靠的文件修改系统，即使模型产生幻觉或操作失误，用户也能轻松恢复文件。