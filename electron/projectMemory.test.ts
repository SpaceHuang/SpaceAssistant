// electron/projectMemory.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'

describe('projectMemory', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  describe('loadProjectMemory', () => {
    it('returns null content when file does not exist', async () => {
      const { loadProjectMemory } = await import('./projectMemory')
      const state = await loadProjectMemory(tmpDir)
      expect(state.content).toBeNull()
      expect(state.fileName).toBe('SPACEASSISTANT.md')
    })

    it('loads file content when file exists', async () => {
      const content = '# Test Project\n\nThis is a test project.'
      await fs.writeFile(path.join(tmpDir, 'SPACEASSISTANT.md'), content, 'utf-8')
      const { loadProjectMemory } = await import('./projectMemory')
      const state = await loadProjectMemory(tmpDir)
      expect(state.content).toBe(content)
      expect(state.fileSize).toBe(Buffer.byteLength(content, 'utf-8'))
      expect(state.truncated).toBe(false)
      expect(state.loadedAt).toBeGreaterThan(0)
    })

    it('truncates file larger than 40KB', async () => {
      const { PROJECT_MEMORY_MAX_SIZE } = await import('../src/shared/domainTypes')
      const largeContent = 'x'.repeat(PROJECT_MEMORY_MAX_SIZE + 100)
      await fs.writeFile(path.join(tmpDir, 'SPACEASSISTANT.md'), largeContent, 'utf-8')
      const { loadProjectMemory } = await import('./projectMemory')
      const state = await loadProjectMemory(tmpDir)
      expect(state.truncated).toBe(true)
      expect(state.content!.length).toBeLessThanOrEqual(PROJECT_MEMORY_MAX_SIZE)
    })

    it('handles empty file', async () => {
      await fs.writeFile(path.join(tmpDir, 'SPACEASSISTANT.md'), '', 'utf-8')
      const { loadProjectMemory } = await import('./projectMemory')
      const state = await loadProjectMemory(tmpDir)
      expect(state.content).toBe('')
      expect(state.fileSize).toBe(0)
    })
  })

  describe('buildSystemPrompt', () => {
    it('returns systemPrompt unchanged when memory is null', async () => {
      const { buildSystemPrompt } = await import('./projectMemory')
      const result = buildSystemPrompt('base prompt', null, true)
      expect(result).toBe('base prompt')
    })

    it('returns systemPrompt unchanged when enabled is false', async () => {
      const { buildSystemPrompt } = await import('./projectMemory')
      const result = buildSystemPrompt('base prompt', '# Memory', false)
      expect(result).toBe('base prompt')
    })

    it('wraps memory in project_memory tags', async () => {
      const { buildSystemPrompt } = await import('./projectMemory')
      const result = buildSystemPrompt('base prompt', '# Memory Content', true)
      expect(result).toBe('base prompt\n\n<project_memory>\n# Memory Content\n</project_memory>')
    })

    it('handles undefined systemPrompt', async () => {
      const { buildSystemPrompt } = await import('./projectMemory')
      const result = buildSystemPrompt(undefined, '# Memory', true)
      expect(result).toBe('<project_memory>\n# Memory\n</project_memory>')
    })
  })
})