// electron/projectMemory.ts
import fs from 'fs/promises'
import { FSWatcher, watch } from 'fs'
import path from 'path'
import { resolveSafePath } from './pathSecurity'
import {
  PROJECT_MEMORY_FILE_NAME,
  PROJECT_MEMORY_MAX_SIZE,
  type ProjectMemoryState
} from '../src/shared/domainTypes'
import { logAgentEvent } from './agentLogger/agentLogger'

let cache: ProjectMemoryState = {
  content: null,
  fileName: PROJECT_MEMORY_FILE_NAME,
  fileSize: 0,
  truncated: false,
  loadedAt: null
}

let watcher: FSWatcher | null = null

export function getCachedMemoryState(): ProjectMemoryState {
  return { ...cache }
}

export function getCachedMemoryContent(): string | null {
  return cache.content
}

export async function loadProjectMemory(workDir: string): Promise<ProjectMemoryState> {
  const filePath = resolveSafePath(workDir, PROJECT_MEMORY_FILE_NAME)

  try {
    const stat = await fs.stat(filePath)
    if (!stat.isFile()) {
      cache = { content: null, fileName: PROJECT_MEMORY_FILE_NAME, fileSize: 0, truncated: false, loadedAt: null }
      return { ...cache }
    }

    const raw = await fs.readFile(filePath, 'utf-8')
    const fileSize = Buffer.byteLength(raw, 'utf-8')
    const truncated = fileSize > PROJECT_MEMORY_MAX_SIZE
    const content = truncated ? raw.slice(0, PROJECT_MEMORY_MAX_SIZE) : raw

    cache = {
      content,
      fileName: PROJECT_MEMORY_FILE_NAME,
      fileSize,
      truncated,
      loadedAt: Date.now()
    }

    logAgentEvent('info', 'projectMemory.loaded', {
      filePath,
      fileSize,
      truncated,
      contentLength: content.length
    })

    return { ...cache }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logAgentEvent('warn', 'projectMemory.loadError', {
        workDir,
        error: (err as Error).message
      })
    }

    cache = { content: null, fileName: PROJECT_MEMORY_FILE_NAME, fileSize: 0, truncated: false, loadedAt: null }
    return { ...cache }
  }
}

export function buildSystemPrompt(
  systemPrompt: string | undefined,
  memoryContent: string | null,
  enabled: boolean
): string | undefined {
  if (!memoryContent || !enabled) return systemPrompt

  const memoryBlock = `<project_memory>\n${memoryContent}\n</project_memory>`
  return systemPrompt ? `${systemPrompt}\n\n${memoryBlock}` : memoryBlock
}

export function startMemoryWatcher(workDir: string, onChange: (state: ProjectMemoryState) => void): void {
  stopMemoryWatcher()

  const filePath = resolveSafePath(workDir, PROJECT_MEMORY_FILE_NAME)

  let debounceTimer: ReturnType<typeof setTimeout> | null = null

  try {
    watcher = watch(filePath, (eventType) => {
      if (eventType !== 'change') return
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(async () => {
        try {
          const state = await loadProjectMemory(workDir)
          onChange(state)
        } catch {
          // 热重载失败静默处理
        }
      }, 500)
    })

    watcher.on('error', (err) => {
      logAgentEvent('warn', 'projectMemory.watcherError', {
        workDir,
        error: err.message
      })
    })
  } catch {
    // fs.watch 可能对不存在的文件失败
  }
}

export function stopMemoryWatcher(): void {
  if (watcher) {
    watcher.close()
    watcher = null
  }
}

export async function writeProjectMemory(workDir: string, content: string): Promise<void> {
  const filePath = resolveSafePath(workDir, PROJECT_MEMORY_FILE_NAME)

  if (Buffer.byteLength(content, 'utf-8') > PROJECT_MEMORY_MAX_SIZE) {
    throw new Error(`文件大小超过限制（最大 ${PROJECT_MEMORY_MAX_SIZE / 1024}KB）`)
  }

  await fs.writeFile(filePath, content, 'utf-8')
  await loadProjectMemory(workDir)
}

export async function generateProjectMemory(workDir: string): Promise<string> {
  const scanResult = await scanWorkDir(workDir)
  return buildGeneratePrompt(scanResult)
}

async function scanWorkDir(workDir: string): Promise<string> {
  const parts: string[] = []

  try {
    const pkgRaw = await fs.readFile(path.join(workDir, 'package.json'), 'utf-8')
    const pkg = JSON.parse(pkgRaw)
    parts.push('## package.json')
    parts.push(`- name: ${pkg.name || '(未设置)'}`)
    if (pkg.description) parts.push(`- description: ${pkg.description}`)
    if (pkg.dependencies) {
      const deps = Object.keys(pkg.dependencies).slice(0, 20).join(', ')
      parts.push(`- dependencies: ${deps}`)
    }
    if (pkg.devDependencies) {
      const devDeps = Object.keys(pkg.devDependencies).slice(0, 15).join(', ')
      parts.push(`- devDependencies: ${devDeps}`)
    }
    if (pkg.scripts) {
      const scripts = Object.entries(pkg.scripts as Record<string, string>)
        .slice(0, 10)
        .map(([k, v]) => `  - ${k}: ${v}`)
        .join('\n')
      parts.push(`- scripts:\n${scripts}`)
    }
  } catch { /* skip */ }

  const keyFiles = ['tsconfig.json', 'tsconfig.electron.json', 'vite.config.ts',
    'vitest.config.ts', '.gitignore', 'CLAUDE.md']
  for (const f of keyFiles) {
    try {
      await fs.access(path.join(workDir, f))
      parts.push(`- ${f}: 存在`)
    } catch { /* skip */ }
  }

  parts.push('\n## 目录树')
  parts.push(await buildDirTree(workDir, 3))

  return parts.join('\n')
}

async function buildDirTree(dir: string, maxDepth: number): Promise<string> {
  const lines: string[] = []
  let count = 0

  async function walk(currentDir: string, prefix: string, depth: number): Promise<void> {
    if (depth > maxDepth || count >= 200) return
    try {
      const entries = await fs.readdir(currentDir, { withFileTypes: true })
      const filtered = entries.filter(
        (e) => !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== 'dist' && e.name !== 'dist-electron'
      )
      for (let i = 0; i < filtered.length && count < 200; i++) {
        const e = filtered[i]
        const isLast = i === filtered.length - 1
        const marker = isLast ? '└── ' : '├── '
        const childMarker = isLast ? '    ' : '│   '
        lines.push(`${prefix}${marker}${e.name}${e.isDirectory() ? '/' : ''}`)
        count++
        if (e.isDirectory() && count < 200) {
          await walk(path.join(currentDir, e.name), prefix + childMarker, depth + 1)
        }
      }
      if (count >= 200) lines.push(`${prefix}...`)
    } catch { /* skip */ }
  }

  lines.push(path.basename(dir) + '/')
  await walk(dir, '', 1)
  return lines.join('\n')
}

function buildGeneratePrompt(scanResult: string): string {
  return `你是一个项目分析专家。请根据以下项目信息，生成一个 SPACEASSISTANT.md 记忆文件。

要求：
1. 使用中文编写
2. 输出不超过 30KB
3. 包含以下章节：
   - 项目概述（一句话描述项目用途与目标）
   - 技术栈（编程语言、框架、构建工具等）
   - 代码规范（命名约定、文件组织等）
   - 交流偏好（LLM 应使用的语言、回答风格等）
   - 特别说明（注意事项、约束等）
4. 如果你不确定某些信息，请标注「待确认」

项目信息：
${scanResult}`
}